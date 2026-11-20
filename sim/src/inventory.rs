use crate::campaign::Stage;
use crate::catalog::*;
use crate::progression::accepts_module;
use crate::world::{Cell, World};

pub const STOCK_TILE: i32 = -1;

pub fn occupied_slots(count: u32, stack: u32) -> u32 {
    count.div_ceil(stack)
}

pub fn used_slots(stock: &[u32; ITEMS], stacks: &[u32; ITEMS]) -> u32 {
    stock[1..]
        .iter()
        .zip(&stacks[1..])
        .map(|(&count, &stack)| occupied_slots(count, stack))
        .fold(0, u32::saturating_add)
}

pub fn item_room(count: u32, stack: u32, used: u32, slots: u32) -> u32 {
    if used > slots {
        return 0;
    }
    let tail = (stack - count % stack) % stack;
    tail + (slots - used) * stack
}

pub fn dedicated_room(count: u32, stack: u32, slots: u32) -> u32 {
    item_room(count, stack, occupied_slots(count, stack), slots)
}

impl Cell {
    pub fn storage_room(&self, item: u8, stack: u32) -> u32 {
        item_room(
            self.inv[item as usize],
            stack,
            self.used_storage_slots,
            STORAGE_SLOTS[self.kind as usize],
        )
    }

    pub fn set_material(&mut self, item: u8, count: u32, stack: u32) {
        let stored = &mut self.inv[item as usize];
        if matches!(self.kind, DEPOT | FREIGHT_YARD) {
            self.used_storage_slots -= occupied_slots(*stored, stack);
            self.used_storage_slots += occupied_slots(count, stack);
        }
        *stored = count;
    }
}

impl World {
    pub fn input_room(&self, tile: usize, item: u8) -> Option<u32> {
        let cell = &self.cells[tile];
        let stack = self.progression.stack_limit(item);
        if cell.kind == DEPOT {
            return Some(cell.storage_room(item, stack));
        }
        if item == SPEED_MODULE {
            return None;
        }
        if cell.kind == FREIGHT_YARD && SENDERS.contains(&tile) {
            return Some(cell.storage_room(item, stack));
        }
        let allowed = matches!(
            (cell.kind, item),
            (STATION, CORE | MIRROR | FUEL) | (GENERATOR, FUEL)
        ) || self
            .recipe_at(tile)
            .is_some_and(|r| r.input.iter().any(|&(id, n)| id == item && n > 0));
        allowed.then(|| {
            dedicated_room(
                cell.inv[item as usize],
                stack,
                INPUT_SLOTS[cell.kind as usize],
            )
        })
    }

    fn manual_input(&self, tile: usize) -> bool {
        !STATIONS[1..].contains(&tile)
    }

    fn manual_input_take(&self, tile: usize) -> bool {
        self.cells[tile].kind != FREIGHT_YARD && self.manual_input(tile)
    }

    pub fn transfer(&mut self, source: i32, destination: i32, item: i32, words: &[i32]) -> i32 {
        let (quantity, source_id, destination_id, role) = match words {
            &[amount, source, destination] => (amount, source, destination, 2),
            &[amount, source, destination, role @ (1 | 2 | 3)] => {
                (amount, source, destination, role)
            }
            _ => return -1,
        };
        if quantity <= 0
            || !(1..ITEMS as i32).contains(&item)
            || (source == STOCK_TILE) == (destination == STOCK_TILE)
        {
            return -1;
        }
        let input = source == STOCK_TILE;
        let (tile, id, stock_id) = if input {
            (destination, destination_id, source_id)
        } else {
            (source, source_id, destination_id)
        };
        let tile = tile as usize;
        if stock_id != 0 || tile >= N {
            return -1;
        }
        let tile = self.footprints.owner(tile).unwrap_or(tile);
        let cell = self.cells[tile];
        if id <= 0 || id != cell.identity {
            return -15;
        }
        let item = item as u8;
        let slot = item as usize;
        let requested = quantity as u32;
        if cell.kind == DEPOT {
            if !input && role != 1 || role == 3 || !self.manual_input(tile) {
                return -13;
            }
            let stack = self.progression.stack_limit(item);
            let (available, room) = if input {
                (self.stock[slot], cell.storage_room(item, stack))
            } else {
                (cell.inv[slot], self.stock_room(item))
            };
            if available == 0 {
                return -9;
            }
            if room == 0 {
                return if input { -14 } else { -24 };
            }
            let moved = requested.min(available).min(room);
            let depot = &mut self.cells[tile];
            if input {
                self.stock[slot] -= moved;
                depot.set_material(item, cell.inv[slot] + moved, stack);
            } else {
                self.stock[slot] += moved;
                depot.set_material(item, cell.inv[slot] - moved, stack);
            }
            return moved as i32;
        }
        if role == 3 || item == SPEED_MODULE {
            if role != 3 || item != SPEED_MODULE || !accepts_module(cell.kind) {
                return -13;
            }
            if input {
                if cell.inv[slot] != 0 {
                    return -14;
                }
                if self.stock[slot] == 0 {
                    return -9;
                }
                self.stock[slot] -= 1;
                self.cells[tile].inv[slot] = 1;
            } else {
                if cell.inv[slot] == 0 {
                    return -9;
                }
                if self.stock_room(item) == 0 {
                    return -24;
                }
                self.cells[tile].inv[slot] = 0;
                self.stock[slot] += 1;
            }
            return 1;
        }
        if input {
            let Some(room) = self.input_room(tile, item) else {
                return -13;
            };
            if !self.manual_input(tile) {
                return -12;
            }
            if room == 0 {
                return -14;
            }
            let first_feed = self.stage == Stage::Feed && cell.kind == BENCH;
            let moved = requested.min(room).min(self.stock[slot]);
            if moved == 0 {
                return -9;
            }
            self.stock[slot] -= moved;
            self.cells[tile].set_material(
                item,
                cell.inv[slot] + moved,
                self.progression.stack_limit(item),
            );
            if first_feed {
                self.stage = Stage::Working;
            }
            moved as i32
        } else {
            if role == 1 {
                if self.input_room(tile, item).is_none() {
                    return -13;
                }
                if !self.manual_input_take(tile) {
                    return -12;
                }
            } else {
                let Some(r) = self.recipe_at(tile) else {
                    return -12;
                };
                if item != r.output {
                    return -13;
                }
            }
            let available = cell.inv[slot];
            let room = self.stock_room(item);
            if available > 0 && room == 0 {
                return -24;
            }
            let moved = requested.min(available).min(room);
            if moved == 0 {
                return -9;
            }
            self.cells[tile].inv[slot] -= moved;
            if item == IRON_INGOT {
                let cell = &mut self.cells[tile];
                cell.belt_iron = cell.belt_iron.min(cell.inv[slot]);
            }
            self.stock[slot] += moved;
            if role == 2 && self.stage == Stage::Collect && cell.kind == SIMPLE_MINER {
                self.stage = if self.stock[PLATE as usize] > 0 {
                    Stage::Bench
                } else {
                    Stage::Handwork
                };
            }
            moved as i32
        }
    }

    // Slot records share capacity calculations with the automatic transport.
    pub fn append_slots(&self, tile: usize, out: &mut Vec<i32>) -> i32 {
        let cell = self.cells[tile];
        let recipe = self.recipe_at(tile);
        let header = out.len();
        for item in 1..MATERIAL_ITEMS as u8 {
            if item == SPEED_MODULE && cell.kind != DEPOT {
                continue;
            }
            let count = cell.inv[item as usize];
            if count == 0 && matches!(cell.kind, DEPOT | FREIGHT_YARD) {
                continue;
            }
            let stack = self.progression.stack_limit(item) as i32;
            if let Some(room) = self.input_room(tile, item) {
                wire::Slot {
                    item: item.into(),
                    role: 1,
                    count: count as i32,
                    stack,
                    permissions: self.manual_input(tile) as i32
                        | ((self.manual_input_take(tile) as i32) << 1)
                        | ((i32::from(room > 0)) << 2),
                }
                .append(out);
            }
            if cell.kind == FREIGHT_YARD && RECEIVERS.contains(&tile) {
                wire::Slot {
                    item: item.into(),
                    role: 2,
                    count: count as i32,
                    stack,
                    permissions: 0,
                }
                .append(out);
            } else if recipe.as_ref().is_some_and(|r| r.output == item) {
                wire::Slot {
                    item: item.into(),
                    role: 2,
                    count: count as i32,
                    stack,
                    permissions: 2,
                }
                .append(out);
            }
        }
        if accepts_module(cell.kind) {
            wire::Slot {
                item: SPEED_MODULE.into(),
                role: 3,
                count: cell.inv[SPEED_MODULE as usize] as i32,
                stack: self.progression.stack_limit(SPEED_MODULE) as i32,
                permissions: 3 | (i32::from(cell.inv[SPEED_MODULE as usize] == 0) << 2),
            }
            .append(out);
        }
        ((out.len() - header) / wire::Slot::WORDS) as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn miner_pauses_until_its_output_stack_has_room() {
        let mut world = World::new();
        world.stock[IRON as usize] = 10;
        assert_eq!(world.place(FIRST_ORE, SIMPLE_MINER.into(), 0), 1);
        let stack = world.progression.stack_limit(IRON);
        world.cells[FIRST_ORE].inv[IRON as usize] = stack;
        for _ in 0..MINER_TICKS {
            world.step();
        }
        assert_eq!(world.cells[FIRST_ORE].status, 4);
        assert_eq!(world.cells[FIRST_ORE].progress, 0);
        let id = world.cells[FIRST_ORE].identity;
        assert_eq!(
            world.transfer(FIRST_ORE as i32, STOCK_TILE, IRON.into(), &[1, id, 0, 2]),
            1
        );
        for _ in 0..MINER_TICKS {
            world.step();
        }
        assert_eq!(world.cells[FIRST_ORE].inv[IRON as usize], stack);
        assert_eq!(world.stage as u8, Stage::Collect as u8);
    }
}
