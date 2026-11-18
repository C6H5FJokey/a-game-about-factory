use crate::catalog::*;
use crate::world::World;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Stage {
    Gather,
    Craft,
    PlaceMiner,
    Mining,
    Collect,
    Handwork,
    Bench,
    Feed,
    Working,
    Belt,
    BeltFed,
    Expand,
    Power,
    Silica,
    Optics,
    Assemble,
    Launch,
    Tracking,
    Sunlight,
    Valley,
    Highland,
    Acceptance,
    Victory,
}

impl Stage {
    pub fn from_word(value: i32) -> Option<Self> {
        use Stage::*;
        [
            Gather, Craft, PlaceMiner, Mining, Collect, Handwork, Bench, Feed, Working, Belt,
            BeltFed, Expand, Power, Silica, Optics, Assemble, Launch, Tracking, Sunlight, Valley,
            Highland, Acceptance, Victory,
        ]
        .get(value as usize)
        .copied()
    }

    pub fn after_production(self, kind: u8) -> Self {
        use Stage::*;
        match (self, kind) {
            (Mining, SIMPLE_MINER) => Collect,
            (Working, BENCH) => Belt,
            (BeltFed, BENCH) => Expand,
            (Power, IRON_DRILL) => Silica,
            (Silica, SILICA_DRILL) => Optics,
            (Optics, GRINDER) => Assemble,
            (Assemble, ASSEMBLER) => Launch,
            _ => self,
        }
    }

    pub fn allows(self, kind: u8) -> bool {
        use Stage::*;
        self >= match kind {
            SIMPLE_MINER => PlaceMiner,
            BENCH => Bench,
            BELT => Belt,
            IRON_DRILL | DEPOT => Expand,
            FUEL_DRILL | GENERATOR => Power,
            SMELTER => Silica,
            SPLITTER => Assemble,
            SILICA_DRILL => Silica,
            GRINDER => Optics,
            ASSEMBLER => Assemble,
            STATION => Launch,
            CALIBRATOR | BATTERY => Tracking,
            SOLAR | KIT_PRESS | KILN => Sunlight,
            FREIGHT_YARD => Valley,
            _ => return false,
        }
    }
}

impl World {
    pub fn unlocked(&self, kind: u8) -> bool {
        self.stage.allows(kind)
            && match kind {
                IRON_DRILL => self.delivered > 0,
                FUEL_DRILL if self.stage == Stage::Power => self
                    .machines
                    .iter()
                    .any(|&i| self.cells[i].kind == GENERATOR),
                _ => true,
            }
    }

    pub fn known_item(&self, item: u8) -> bool {
        self.stage
            >= match item {
                IRON => Stage::Craft,
                SILICA => Stage::Silica,
                FUEL => Stage::Power,
                PLATE => Stage::Handwork,
                LENS => Stage::Assemble,
                MIRROR => Stage::Launch,
                CORE => Stage::Tracking,
                KIT => Stage::Sunlight,
                _ => return false,
            }
    }

    pub fn known_ore(&self, tile: usize) -> u8 {
        match terrain(tile) {
            IRON if tile == FIRST_ORE || self.stage >= Stage::Expand => IRON,
            FUEL if self.stage >= Stage::Power => FUEL,
            SILICA if self.stage >= Stage::Silica => SILICA,
            _ => 0,
        }
    }

    pub fn gather(&mut self, tile: usize) -> i32 {
        let item = self.known_ore(tile);
        if item == 0 {
            return -3;
        }
        self.stock[item as usize] += 1;
        if self.stage == Stage::Gather {
            self.stage = Stage::Craft;
        }
        if self.stage == Stage::Silica && item == SILICA {
            self.stage = Stage::Optics;
        }
        1
    }

    pub fn craft_miner(&mut self) -> i32 {
        if self.packed_miners != 0 || !(self.stage == Stage::Craft || self.stage >= Stage::Expand) {
            return -6;
        }
        if self.stock[IRON as usize] < MINER_COST {
            return -8;
        }
        self.stock[IRON as usize] -= MINER_COST;
        self.packed_miners = 1;
        if self.stage == Stage::Craft {
            self.stage = Stage::PlaceMiner;
        }
        1
    }

    pub fn handwork(&mut self) -> i32 {
        if self.stage < Stage::Handwork {
            return -6;
        }
        if self.stock[IRON as usize] == 0 {
            return -8;
        }
        self.stock[IRON as usize] -= 1;
        self.stock[PLATE as usize] += 1;
        if self.stage == Stage::Handwork {
            self.stage = Stage::Bench;
        }
        1
    }

    pub fn collect(&mut self, tile: usize) -> i32 {
        let cell = &mut self.cells[tile];
        let Some(r) = recipe(cell.kind) else {
            return -1;
        };
        let count = std::mem::take(&mut cell.inv[r.output as usize]);
        if count == 0 {
            return -9;
        }
        self.stock[r.output as usize] += u32::from(count);
        if self.stage == Stage::Collect && cell.kind == SIMPLE_MINER {
            self.stage = Stage::Handwork;
        }
        1
    }

    pub fn hand_feed(&mut self, tile: usize, item: u8) -> i32 {
        if STATIONS[1..].contains(&tile) {
            return -6;
        }
        if self.stage < Stage::Feed || item == 0 || item as usize >= ITEMS {
            return -6;
        }
        let mut count = 0;
        while self.stock[item as usize] > 0
            && self.cells[tile].kind != DEPOT
            && !is_belt(self.cells[tile].kind)
            && self.transfer_in(
                tile,
                crate::belts::Cargo {
                    item,
                    ..Default::default()
                },
                self.tick / BELT_TICKS,
            )
        {
            self.stock[item as usize] -= 1;
            count += 1;
            if self.stage == Stage::Feed && self.cells[tile].kind == BENCH {
                self.stage = Stage::Working;
                break;
            }
        }
        if count > 0 {
            1
        } else {
            -9
        }
    }
}
