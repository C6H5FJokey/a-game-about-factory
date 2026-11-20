use crate::belts::{node, Cargo};
use crate::campaign::Stage;
use crate::catalog::*;
use crate::footprints::Outlet;
use crate::world::World;

pub(crate) const BELT_ARRIVAL_TICKS: u32 = 12;

pub(crate) struct BeltArrival {
    pub from: i32,
    pub target: u32,
    pub flow: u8,
    pub item: u8,
    pub id: i32,
    pub tick: u32,
    pub crossing: bool,
}

#[derive(Clone, Copy)]
enum Source {
    Belt(usize),
    Machine(Outlet),
}

impl World {
    fn can_receive(&self, tile: usize, flow: u8, item: u8) -> bool {
        let Some(anchor) = self.footprints.owner(tile) else {
            return false;
        };
        let cell = &self.cells[anchor];
        if is_belt(cell.kind) {
            return belt_input(cell.kind, cell.dir, flow)
                .and_then(|lane| self.belt.entry(node(tile, lane)))
                .is_some_and(|id| self.belt.segments[id].can_enter(self.tick));
        }
        if self.material_masks(tile, anchor).0 & (1 << flow) == 0 {
            return false;
        }
        self.input_room(anchor, item).is_some_and(|room| room > 0)
    }

    fn receive(&mut self, tile: usize, flow: u8, mut cargo: Cargo, from: usize) {
        let anchor = self.footprints.owner(tile).unwrap();
        let kind = self.cells[anchor].kind;
        if is_belt(kind) {
            let lane = belt_input(kind, self.cells[tile].dir, flow).unwrap();
            let id = self.belt.entry(node(tile, lane)).unwrap();
            if cargo.id == 0 {
                cargo.id = self.next_cargo_id;
                self.next_cargo_id += 1;
            }
            self.belt.segments[id].enter(cargo, from, self.tick);
        } else if kind == DEPOT {
            let warehouse = &mut self.cells[anchor];
            warehouse.set_material(
                cargo.item,
                warehouse.inv[cargo.item as usize] + 1,
                self.progression.stack_limit(cargo.item),
            );
            if cargo.item == PLATE && cargo.source != 0 {
                self.delivered = self.delivered.saturating_add(1);
                if self.legacy_recipes && matches!(self.stage, Stage::Belt | Stage::BeltFed) {
                    self.stage = Stage::Expand;
                }
            }
            if cargo.item == KIT && cargo.source != 0 {
                self.kit_total = self.kit_total.saturating_add(1);
                if let Some(press) = self.cells.get_mut(cargo.source as usize - 1) {
                    press.last_kit_delivery = self.tick;
                }
            }
        } else {
            let receiver = &mut self.cells[anchor];
            receiver.set_material(
                cargo.item,
                receiver.inv[cargo.item as usize] + 1,
                self.progression.stack_limit(cargo.item),
            );
            if !self.legacy_recipes
                && matches!(self.stage, Stage::Belt | Stage::BeltFed)
                && kind == BENCH
                && cargo.item == IRON_INGOT
                && cargo.id != 0
            {
                self.cells[anchor].belt_iron += 1;
                self.stage = Stage::BeltFed;
            } else if self.legacy_recipes
                && self.stage == Stage::Belt
                && kind == BENCH
                && cargo.item == IRON
            {
                self.stage = Stage::BeltFed;
            }
        }
    }

    fn belt_destination(&self, id: usize, item: u8) -> Option<(usize, u8)> {
        let segment = &self.belt.segments[id];
        let tile = segment.nodes.last().unwrap() / 2;
        let cell = &self.cells[tile];
        let mut exits = segment.exits;
        if cell.kind == SPLITTER && cell.cfg == 0 && cell.split_turn {
            exits.swap(0, 1);
        }
        exits.into_iter().flatten().find_map(|flow| {
            let target = neighbor(tile, flow)?;
            self.can_receive(target, flow, item)
                .then_some((target, flow))
        })
    }

    fn machine_output(&self, tile: usize) -> Option<Cargo> {
        let cell = &self.cells[tile];
        let (item, source) = if cell.kind == FREIGHT_YARD && RECEIVERS.contains(&tile) {
            (cell.inv.iter().position(|&count| count > 0)? as u8, 0)
        } else if cell.kind == DEPOT && cell.cfg != 0 && cell.inv[cell.cfg as usize] > 0 {
            (cell.cfg, 0)
        } else if let Some(r) = self.recipe_at(tile) {
            if self.stage < Stage::Belt
                || cell.inv[r.output as usize] == 0
                || (cell.kind == SIMPLE_MINER && !self.legacy_recipes)
            {
                return None;
            }
            (
                r.output,
                if matches!(r.output, KIT | PLATE) {
                    tile as u32 + 1
                } else {
                    0
                },
            )
        } else {
            return None;
        };
        Some(Cargo {
            item,
            source,
            ..Cargo::default()
        })
    }

    fn send(&mut self, source: Source, next: usize, flow: u8, cargo: Cargo) {
        let from = match source {
            Source::Belt(id) => *self.belt.segments[id].nodes.last().unwrap(),
            Source::Machine(outlet) => node(outlet.tile, 0),
        };
        match source {
            Source::Belt(id) => {
                self.belt.segments[id].depart(self.tick);
                if !is_belt(self.cells[next].kind) {
                    self.belt_arrivals.push_back(BeltArrival {
                        from: from as i32,
                        target: next as u32,
                        flow,
                        item: cargo.item,
                        id: cargo.id,
                        tick: self.tick,
                        crossing: self.cells[from / 2].kind == CROSSING,
                    });
                }
                let cell = &mut self.cells[from / 2];
                if cell.kind == SPLITTER {
                    cell.split_turn = !cell.split_turn;
                }
            }
            Source::Machine(outlet) => {
                let tile = outlet.anchor;
                let cell = &mut self.cells[tile];
                cell.set_material(
                    cargo.item,
                    cell.inv[cargo.item as usize] - 1,
                    self.progression.stack_limit(cargo.item),
                );
                if let Some(line) = RECEIVERS.iter().position(|&pos| tile == pos) {
                    self.routes[line].delivered = self.routes[line].delivered.saturating_add(1);
                }
            }
        }
        self.receive(next, flow, cargo, from);
    }

    fn ready_source(&self, tile: usize, flow: u8) -> Option<(Source, Cargo)> {
        let from = neighbor(tile, (flow + 2) % 4)?;
        let kind = self.cells[from].kind;
        if is_belt(kind) {
            return (0..belt_lanes(kind)).find_map(|lane| {
                let location = node(from, lane);
                let id = self.belt.segment_at[location]?;
                let segment = &self.belt.segments[id];
                if segment.nodes.last() != Some(&location) {
                    return None;
                }
                let cargo = segment.outgoing(self.tick)?;
                (self.belt_destination(id, cargo.item) == Some((tile, flow)))
                    .then_some((Source::Belt(id), cargo))
            });
        }
        let anchor = self.footprints.owner(from)?;
        if self.material_masks(from, anchor).1 & (1 << flow) == 0 {
            return None;
        }
        let cargo = self.machine_output(anchor)?;
        Some((
            Source::Machine(Outlet {
                anchor,
                tile: from,
                flow,
            }),
            cargo,
        ))
    }

    fn machine_send_due(&self, target: u8) -> bool {
        (is_belt(target) && (!self.legacy_recipes || belt_interval(target) < BELT_TICKS))
            || belt_pulse(self.tick)
    }

    fn send_straight_first(&mut self, tile: usize, entering_flow: u8) -> bool {
        let cell = &self.cells[tile];
        let straight = cell.dir;
        if !plain_belt(cell.kind) || entering_flow == straight {
            return false;
        }
        let Some((source, cargo)) = self.ready_source(tile, straight) else {
            return false;
        };
        if matches!(source, Source::Machine(_)) && !self.machine_send_due(cell.kind) {
            return false;
        }
        self.send(source, tile, straight, cargo);
        true
    }

    fn pull_merge(&mut self, id: usize) {
        if !self.belt.segments[id].can_enter(self.tick) {
            return;
        }
        let tile = self.belt.segments[id].nodes[0] / 2;
        let dir = self.cells[tile].dir;
        let first = self.cells[tile].cfg;
        for offset in 0..4 {
            let flow = (first + offset) % 4;
            if belt_input(MERGER, dir, flow).is_none() {
                continue;
            }
            if let Some((source, cargo)) = self.ready_source(tile, flow) {
                self.send(source, tile, flow, cargo);
                self.cells[tile].cfg = (flow + 1) % 4;
                return;
            }
        }
    }

    pub fn move_cargo(&mut self) {
        while self
            .belt_arrivals
            .front()
            .is_some_and(|arrival| self.tick.saturating_sub(arrival.tick) >= BELT_ARRIVAL_TICKS)
        {
            self.belt_arrivals.pop_front();
        }
        for order in 0..self.belt.downstream_first.len() {
            let id = self.belt.downstream_first[order];
            let tile = self.belt.segments[id].nodes[0] / 2;
            if let Some(cargo) = self.belt.segments[id].outgoing(self.tick) {
                loop {
                    match self.belt_destination(id, cargo.item) {
                        Some((target, flow)) if self.cells[target].kind != MERGER => {
                            if self.send_straight_first(target, flow) {
                                // The straight item has taken this slot. A splitter can try its other exit.
                                continue;
                            }
                            self.send(Source::Belt(id), target, flow, cargo);
                        }
                        _ => self.belt.segments[id].queue.front_mut().unwrap().blocked = true,
                    }
                    break;
                }
            }
            self.belt.segments[id].advance(self.tick);
            if self.cells[tile].kind == MERGER {
                self.pull_merge(id);
            }
        }
        for order in 0..self.footprints.outlets.len() {
            let outlet = self.footprints.outlets[order];
            let Some(next) = neighbor(outlet.tile, outlet.flow) else {
                continue;
            };
            let Some(destination) = self.footprints.owner(next) else {
                continue;
            };
            let target = self.cells[destination].kind;
            if target == MERGER {
                continue;
            }
            // A fast entrance may receive on its own cadence. Ordinary direct
            // device transfers and the tutorial retain the original beat.
            if !self.machine_send_due(target) {
                continue;
            }
            if let Some(cargo) = self.machine_output(outlet.anchor) {
                if self.can_receive(next, outlet.flow, cargo.item)
                    && !self.send_straight_first(next, outlet.flow)
                {
                    self.send(Source::Machine(outlet), next, outlet.flow, cargo);
                }
            }
        }
    }

    pub fn take_cargo(&mut self, tile: usize, lane: usize, item: i32, words: &[i32]) -> i32 {
        let &[id, revision] = words else {
            return -1;
        };
        if tile >= N
            || lane >= belt_lanes(self.cells[tile].kind)
            || !(1..MATERIAL_ITEMS as i32).contains(&item)
        {
            return -22;
        }
        if revision != self.cells[tile].identity || id <= 0 {
            return -22;
        }
        let location = node(tile, lane);
        let Some(segment) = self.belt.segment_at[location] else {
            return -22;
        };
        if self.stock_room(item as u8) == 0 {
            return -24;
        }
        if !self.belt.segments[segment].take(location, item as u8, id, self.tick) {
            return -22;
        }
        self.stock[item as usize] += 1;
        1
    }
}
