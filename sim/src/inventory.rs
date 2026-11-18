use crate::campaign::Stage;
use crate::catalog::*;
use crate::progression::accepts_module;
use crate::regions::YARD_CAPACITY;
use crate::world::World;

pub const STOCK_TILE: i32 = -1;
const WRITTEN_SLOT_WORDS: usize = 5;

impl World {
    pub fn input_capacity(&self, tile: usize, item: u8) -> Option<u16> {
        if item == SPEED_MODULE {
            return None;
        }
        let cell = self.cells[tile];
        Some(match (cell.kind, item) {
            (STATION, CORE) => 16,
            (STATION, MIRROR) => 6,
            (STATION, FUEL) => 12,
            (GENERATOR, FUEL) => 8,
            (FREIGHT_YARD, _) if SENDERS.contains(&tile) => yard_item_capacity(&cell.inv, item),
            _ if recipe(cell.kind)
                .is_some_and(|r| r.input.iter().any(|&(id, n)| id == item && n > 0)) =>
            {
                INPUT_CAPACITY[cell.kind as usize]
            }
            _ => return None,
        })
    }

    fn manual_input(&self, tile: usize, item: u8) -> bool {
        !STATIONS[1..].contains(&tile) && self.known_item(item)
    }

    fn manual_input_take(&self, tile: usize, item: u8) -> bool {
        self.cells[tile].kind != FREIGHT_YARD && self.manual_input(tile, item)
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
            let Some(cap) = self.input_capacity(tile, item) else {
                return -13;
            };
            if !self.manual_input(tile, item) {
                return -12;
            }
            let room = cap.saturating_sub(cell.inv[slot]);
            if room == 0 {
                return -14;
            }
            let first_feed = self.stage == Stage::Feed && cell.kind == BENCH;
            let moved = requested.min(room.into()).min(self.stock[slot]);
            if moved == 0 {
                return -9;
            }
            self.stock[slot] -= moved;
            self.cells[tile].inv[slot] += moved as u16;
            if first_feed {
                self.stage = Stage::Working;
            }
            moved as i32
        } else {
            if role == 1 {
                if self.input_capacity(tile, item).is_none() {
                    return -13;
                }
                if !self.manual_input_take(tile, item) {
                    return -12;
                }
            } else {
                let Some(r) = recipe(cell.kind) else {
                    return -12;
                };
                if item != r.output {
                    return -13;
                }
            }
            let available = u32::from(cell.inv[slot]);
            let room = self.stock_room(item);
            if available > 0 && room == 0 {
                return -24;
            }
            let moved = requested.min(available).min(room);
            if moved == 0 {
                return -9;
            }
            self.cells[tile].inv[slot] -= moved as u16;
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
    pub fn write_slots(&self, tile: usize, out: &mut Vec<i32>) {
        let cell = self.cells[tile];
        let recipe = recipe(cell.kind);
        let header = out.len();
        out.push(0);
        for item in 1..MATERIAL_ITEMS as u8 {
            let count = cell.inv[item as usize];
            if count == 0
                && matches!(cell.kind, STATION | DEPOT | FREIGHT_YARD)
                && !self.known_item(item)
                && cell.cfg != item
            {
                continue;
            }
            if let Some(cap) = self.input_capacity(tile, item) {
                out.extend([
                    item as i32,
                    1,
                    count.into(),
                    cap.into(),
                    self.manual_input(tile, item) as i32
                        | ((self.manual_input_take(tile, item) as i32) << 1),
                ]);
            } else if cell.kind == DEPOT && cell.cfg == 0 {
                out.extend([item as i32, 1, 0, -1, 0]);
            }
            if cell.kind == FREIGHT_YARD && RECEIVERS.contains(&tile) {
                let cap = yard_item_capacity(&cell.inv, item);
                out.extend([item as i32, 2, count.into(), cap.into(), 0]);
            } else if cell.kind == DEPOT && cell.cfg == item {
                out.extend([item as i32, 2, self.stock[item as usize] as i32, -1, 0]);
            } else if recipe.as_ref().is_some_and(|r| r.output == item) {
                out.extend([
                    item as i32,
                    2,
                    count.into(),
                    output_capacity(cell.kind).into(),
                    2,
                ]);
            }
        }
        if accepts_module(cell.kind) {
            out.extend([
                SPEED_MODULE.into(),
                3,
                cell.inv[SPEED_MODULE as usize].into(),
                1,
                3,
            ]);
        }
        out[header] = ((out.len() - header - 1) / WRITTEN_SLOT_WORDS) as i32;
    }
}

fn yard_item_capacity(inv: &[u16; ITEMS], item: u8) -> u16 {
    YARD_CAPACITY.saturating_sub(inv.iter().sum::<u16>() - inv[item as usize])
}
