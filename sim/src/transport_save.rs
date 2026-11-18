use std::collections::HashSet;

use crate::belts::{node, Belts, Cargo, NODES, RETIRED_SOURCE};
use crate::catalog::*;
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
        for (location, cargo) in self.cargo.iter().enumerate() {
            if cargo.item == 0 {
                continue;
            }
            out.extend([
                location as i32,
                cargo.id,
                cargo.item.into(),
                self.cells[location / 2].identity,
                cargo.from.into(),
                cargo.since as i32,
                cargo.ready as i32,
                cargo.blocked as i32,
            ]);
        }
        out.push(start as i32);
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
                cargo.from.into(),
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

    pub fn read_transport_save<'a>(&mut self, data: &'a [i32]) -> Option<&'a [i32]> {
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
            if loc >= NODES
                || loc % 2 >= belt_lanes(self.cells[loc / 2].kind)
                || previous.is_some_and(|p| p >= loc)
                || id <= 0
                || id >= *next
                || !used_ids.insert(id)
                || !(1..MATERIAL_ITEMS as i32).contains(&item)
                || !(0..=RETIRED_SOURCE.into()).contains(&source)
                || !(0..NODES as i32).contains(&from)
                || !(0..=self.tick as i32).contains(&since)
                || !(since..=self.tick as i32 + MAX_BELT_INTERVAL as i32).contains(&ready)
                || !matches!(blocked, 0 | 1)
            {
                return None;
            }
            let cargo = Cargo {
                item: item as u8,
                source: source as u16,
                id,
                from: from as u16,
                since: since as u32,
                ready: ready as u32,
                blocked: blocked == 1,
                ..Cargo::default()
            };
            self.valid_source(cargo)?;
            self.cargo[loc] = cargo;
            previous = Some(loc);
        }
        self.rebuild_footprints()?;
        self.belt = Belts::rebuild(&self.cells, &self.cargo, None, &self.footprints.outlets);
        if self.belt.segments.len() != segments {
            return None;
        }
        for (segment, words) in self
            .belt
            .segments
            .iter_mut()
            .zip(gate_words.chunks_exact(3))
        {
            let max = self.tick as i32 + MAX_BELT_INTERVAL as i32;
            if segment.nodes[0] as i32 != words[0]
                || !(0..=max).contains(&words[1])
                || !(0..=max).contains(&words[2])
            {
                return None;
            }
            segment.next_entry = words[1] as u32;
            segment.next_exit = words[2] as u32;
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
            from: location as u16,
            since: self.tick,
            ready: (self.tick / BELT_TICKS + 1) * BELT_TICKS,
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
            (KIT, KIT_PRESS) | (PLATE, SMELTER | BENCH)
        )
        .then_some(())
    }
}
