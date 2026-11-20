use std::collections::HashSet;

use crate::belts::{node, Belts, Cargo, NODES, RETIRED_SOURCE};
use crate::catalog::*;
use crate::saved_ticks;
use crate::transport::BELT_ARRIVAL_TICKS;
use crate::world::World;

impl World {
    pub fn transport_save_length(&self, data: &[i32]) -> Option<usize> {
        let &[_, _, count, segments] = data.get(..4)? else {
            return None;
        };
        let count = usize::try_from(count).ok()?;
        let segments = usize::try_from(segments).ok()?;
        if count > NODES || segments > NODES {
            return None;
        }
        let length = 4 + count * 8 + segments * 3;
        (length <= data.len()).then_some(length)
    }

    pub fn write_transport_projection(&self, out: &mut Vec<i32>) {
        let start = out.len();
        out.push(self.layout_revision);
        for location in 0..NODES {
            self.append_cargo_view(out, location);
        }
        self.append_arrival_view(out, |_| true);
        out.push(start as i32);
    }

    pub fn append_cargo_view(&self, out: &mut Vec<i32>, location: usize) {
        let cargo = self.cargo[location];
        if cargo.item != 0 {
            out.extend([
                location as i32,
                cargo.id,
                cargo.item.into(),
                self.cells[location / 2].identity,
                cargo.from,
                cargo.since as i32,
                cargo.ready as i32,
                cargo.blocked as i32,
            ]);
        }
    }

    pub fn append_arrival_view(&self, out: &mut Vec<i32>, include: impl Fn(usize) -> bool) {
        // Nonnegative locations are live belt cargo; negative locations tag
        // transient arrivals without changing projection or save offsets.
        for arrival in &self.belt_arrivals {
            if !include(arrival.from as usize / 2) && !include(usize::from(arrival.target)) {
                continue;
            }
            out.extend([
                -1 - arrival.from,
                arrival.id,
                arrival.item.into(),
                arrival.target.into(),
                arrival.flow.into(),
                arrival.tick as i32,
                arrival.tick.saturating_add(BELT_ARRIVAL_TICKS) as i32,
                arrival.crossing as i32,
            ]);
        }
    }

    pub fn write_transport_save(&self, out: &mut Vec<i32>) {
        let count = self.cargo.iter().filter(|c| c.item != 0).count();
        out.extend([
            self.next_cargo_id,
            self.layout_revision,
            count as i32,
            self.belt.segments.len() as i32,
        ]);
        for (loc, cargo) in self.cargo.iter().enumerate() {
            if cargo.item == 0 {
                continue;
            }
            out.extend([
                loc as i32,
                cargo.id,
                cargo.item.into(),
                cargo.source.into(),
                cargo.from,
                cargo.since as i32,
                cargo.ready as i32,
                cargo.blocked as i32,
            ]);
        }
        for segment in &self.belt.segments {
            out.extend([
                segment.nodes[0] as i32,
                segment.next_entry as i32,
                segment.next_exit as i32,
            ]);
        }
    }

    pub fn read_transport_save<'a>(
        &mut self,
        data: &'a [i32],
        legacy_clock: bool,
    ) -> Option<&'a [i32]> {
        let [next, revision, count, segments, rest @ ..] = data else {
            return None;
        };
        let count = usize::try_from(*count).ok()?;
        let segments = usize::try_from(*segments).ok()?;
        if *next < 1 || *revision < 0 || count > NODES || segments > NODES {
            return None;
        }
        let cargo_end = count * 8;
        let gate_end = cargo_end + segments * 3;
        let gate_words = rest.get(cargo_end..gate_end)?;
        let mut used_ids = HashSet::with_capacity(count);
        let mut previous = None;
        for record in rest[..cargo_end].chunks_exact(8) {
            let loc = usize::try_from(record[0]).ok()?;
            let [_, id, item, source, from, since, ready, blocked] =
                <[i32; 8]>::try_from(record).ok()?;
            let since = saved_ticks(since, legacy_clock)?;
            let ready = saved_ticks(ready, legacy_clock)?;
            if loc >= NODES
                || loc % 2 >= belt_lanes(self.cells[loc / 2].kind)
                || previous.is_some_and(|p| p >= loc)
                || id <= 0
                || id >= *next
                || !used_ids.insert(id)
                || !(1..MATERIAL_ITEMS as i32).contains(&item)
                || !(0..=RETIRED_SOURCE.into()).contains(&source)
                || !(0..NODES as i32).contains(&from)
                || since > self.tick
                || !(since..=self.tick + MAX_BELT_INTERVAL).contains(&ready)
                || !matches!(blocked, 0 | 1)
            {
                return None;
            }
            let cargo = Cargo {
                item: item as u8,
                source: source as u16,
                id,
                from,
                since,
                ready,
                blocked: blocked == 1,
                ..Cargo::default()
            };
            self.valid_source(cargo)?;
            self.cargo[loc] = cargo;
            previous = Some(loc);
        }
        self.rebuild_footprints()?;
        self.belt = Belts::rebuild(
            &self.cells,
            &self.cargo,
            None,
            &self.footprints.outlets,
            self.legacy_recipes,
        );
        if self.belt.segments.len() != segments {
            return None;
        }
        for (segment, words) in self
            .belt
            .segments
            .iter_mut()
            .zip(gate_words.chunks_exact(3))
        {
            let max = self.tick + MAX_BELT_INTERVAL;
            let entry = saved_ticks(words[1], legacy_clock)?;
            let exit = saved_ticks(words[2], legacy_clock)?;
            if segment.nodes[0] as i32 != words[0] || entry > max || exit > max {
                return None;
            }
            segment.next_entry = entry;
            segment.next_exit = exit;
        }
        self.next_cargo_id = *next;
        self.layout_revision = *revision;
        Some(&rest[gate_end..])
    }

    pub fn add_legacy_cargo(&mut self, tile: usize, item: u8, source: u16) -> Option<()> {
        if item == 0 {
            return Some(());
        }
        let location = node(tile, 0);
        let cargo = Cargo {
            item,
            source,
            id: self.next_cargo_id,
            from: location as i32,
            since: self.tick,
            ready: legacy_cargo_ready(self.tick),
            ..Cargo::default()
        };
        self.cargo[location] = cargo;
        self.next_cargo_id += 1;
        Some(())
    }

    pub fn valid_source(&self, cargo: Cargo) -> Option<()> {
        if cargo.source == 0 || cargo.source == RETIRED_SOURCE {
            return Some(());
        }
        let kind = self.cells[usize::from(cargo.source) - 1].kind;
        matches!(
            (cargo.item, kind),
            (KIT, KIT_PRESS | SPLICER) | (PLATE, SMELTER | BENCH)
        )
        .then_some(())
    }
}
