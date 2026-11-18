use crate::belts::{node, Cargo};
use crate::campaign::Stage;
use crate::catalog::*;
use crate::world::World;

#[derive(Clone, Copy)]
enum Source {
    Belt(usize),
    Machine(usize),
}

impl World {
    fn can_receive(&self, tile: usize, flow: u8, item: u8) -> bool {
        let cell = &self.cells[tile];
        if is_belt(cell.kind) {
            return belt_input(cell.kind, cell.dir, flow)
                .and_then(|lane| self.belt.entry(node(tile, lane)))
                .is_some_and(|id| self.belt.segments[id].can_enter(self.tick));
        }
        if cell.kind == DEPOT {
            return cell.cfg == 0 && self.stock_room(item) > 0;
        }
        self.input_capacity(tile, item)
            .is_some_and(|cap| cell.inv[item as usize] < cap)
    }

    fn receive(&mut self, tile: usize, flow: u8, mut cargo: Cargo, from: usize) {
        let kind = self.cells[tile].kind;
        if is_belt(kind) {
            let lane = belt_input(kind, self.cells[tile].dir, flow).unwrap();
            let id = self.belt.entry(node(tile, lane)).unwrap();
            if cargo.id == 0 {
                cargo.id = self.next_cargo_id;
                self.next_cargo_id += 1;
            }
            self.belt.segments[id].enter(cargo, from, self.tick);
        } else if kind == DEPOT {
            self.stock[cargo.item as usize] = self.stock[cargo.item as usize].saturating_add(1);
            if cargo.item == PLATE && cargo.source != 0 {
                self.delivered = self.delivered.saturating_add(1);
            }
            if cargo.item == KIT && cargo.source != 0 {
                self.kit_total = self.kit_total.saturating_add(1);
                if let Some(press) = self.cells.get_mut(usize::from(cargo.source) - 1) {
                    press.last_kit_delivery = self.tick;
                }
            }
        } else {
            self.cells[tile].inv[cargo.item as usize] += 1;
            if self.stage == Stage::Belt && kind == BENCH && cargo.item == IRON {
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
        } else if cell.kind == DEPOT && cell.cfg != 0 && self.stock[cell.cfg as usize] > 0 {
            (cell.cfg, 0)
        } else if let Some(r) = recipe(cell.kind) {
            if self.stage < Stage::Belt || cell.inv[r.output as usize] == 0 {
                return None;
            }
            (
                r.output,
                if matches!(r.output, KIT | PLATE) {
                    tile as u16 + 1
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
            Source::Machine(tile) => node(tile, 0),
        };
        match source {
            Source::Belt(id) => {
                self.belt.segments[id].depart(self.tick);
                let cell = &mut self.cells[from / 2];
                if cell.kind == SPLITTER {
                    cell.split_turn = !cell.split_turn;
                }
            }
            Source::Machine(tile) => {
                if self.cells[tile].kind == DEPOT {
                    self.stock[cargo.item as usize] -= 1;
                } else {
                    self.cells[tile].inv[cargo.item as usize] -= 1;
                }
                if let Some(line) = RECEIVERS.iter().position(|&pos| tile == pos) {
                    self.routes[line].delivered = self.routes[line].delivered.saturating_add(1);
                }
            }
        }
        self.receive(next, flow, cargo, from);
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
            let Some(from) = neighbor(tile, (flow + 2) % 4) else {
                continue;
            };
            let cell = &self.cells[from];
            let mut candidate = None;
            if is_belt(cell.kind) {
                for lane in 0..belt_lanes(cell.kind) {
                    let loc = node(from, lane);
                    let Some(id) = self.belt.segment_at[loc] else {
                        continue;
                    };
                    let segment = &self.belt.segments[id];
                    if segment.nodes.last() != Some(&loc) {
                        continue;
                    }
                    if let Some(cargo) = segment.outgoing(self.tick) {
                        if self.belt_destination(id, cargo.item) == Some((tile, flow)) {
                            candidate = Some((Source::Belt(id), cargo));
                            break;
                        }
                    }
                }
            } else if cell.dir == flow {
                candidate = self
                    .machine_output(from)
                    .map(|cargo| (Source::Machine(from), cargo));
            }
            if let Some((source, cargo)) = candidate {
                self.send(source, tile, flow, cargo);
                self.cells[tile].cfg = (flow + 1) % 4;
                return;
            }
        }
    }

    pub fn move_cargo(&mut self) {
        for order in 0..self.belt.downstream_first.len() {
            let id = self.belt.downstream_first[order];
            let tile = self.belt.segments[id].nodes[0] / 2;
            if let Some(cargo) = self.belt.segments[id].outgoing(self.tick) {
                match self.belt_destination(id, cargo.item) {
                    Some((target, flow)) if self.cells[target].kind != MERGER => {
                        self.send(Source::Belt(id), target, flow, cargo)
                    }
                    _ => self.belt.segments[id].queue.front_mut().unwrap().blocked = true,
                }
            }
            self.belt.segments[id].advance(self.tick);
            if self.cells[tile].kind == MERGER {
                self.pull_merge(id);
            }
        }
        for order in 0..self.machines.len() {
            let tile = self.machines[order];
            let cell = &self.cells[tile];
            let Some(next) = neighbor(tile, cell.dir) else {
                continue;
            };
            let target = self.cells[next].kind;
            if target == 0 || target == MERGER || (cell.kind == DEPOT && target == DEPOT) {
                continue;
            }
            // A fast entrance may receive on its own cadence. Ordinary direct
            // device transfers and the tutorial retain the original beat.
            if !matches!(target, FAST_BELT | EXPRESS_BELT) && self.tick % BELT_TICKS != 0 {
                continue;
            }
            if let Some(cargo) = self.machine_output(tile) {
                if self.can_receive(next, cell.dir, cargo.item) {
                    self.send(Source::Machine(tile), next, cell.dir, cargo);
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
