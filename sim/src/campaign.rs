use crate::catalog::*;
use crate::inventory::STOCK_TILE;
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
        Self::required_for(kind).is_some_and(|required| self >= required)
    }

    pub fn after_selected_production(self, kind: u8, item: u8, belt_batch: bool) -> Self {
        use Stage::*;
        match (self, kind, item) {
            (Mining, SIMPLE_MINER, _) => Collect,
            (Feed | Working, BENCH, PLATE) => Belt,
            (BeltFed, BENCH, PLATE) if belt_batch => Expand,
            (Power, IRON_DRILL | COPPER_DRILL, _) => Silica,
            (Silica, SILICA_DRILL, SILICA) => Optics,
            (Optics, BENCH, LENS) => Assemble,
            (Assemble, SPLICER, MIRROR) => Launch,
            _ => self,
        }
    }

    pub fn required_for(kind: u8) -> Option<Self> {
        use Stage::*;
        Some(match kind {
            SIMPLE_MINER => Gather,
            BENCH => Bench,
            BELT | DEPOT => Belt,
            IRON_DRILL | INDUSTRIAL_MINER => Expand,
            FUEL_DRILL | GENERATOR | CABLE => Power,
            SMELTER => Silica,
            SPLITTER | MERGER | CROSSING => Assemble,
            FAST_BELT => Sunlight,
            SPLICER => Assemble,
            COPPER_DRILL | REINFORCED_COPPER_DRILL => Expand,
            ULTRA_BELT => Acceptance,
            SILICA_DRILL => Silica,
            GRINDER => Optics,
            ASSEMBLER => Assemble,
            STATION => Launch,
            CALIBRATOR | BATTERY => Tracking,
            SOLAR | KIT_PRESS | KILN => Sunlight,
            FREIGHT_YARD => Valley,
            DEVELOPMENT_HUB | EXPRESS_BELT | REINFORCED_IRON_DRILL..=REINFORCED_MINER => Expand,
            _ => return None,
        })
    }
}

impl World {
    pub fn unlocked(&self, kind: u8) -> bool {
        if matches!(kind, INDUSTRIAL_MINER | REINFORCED_MINER) {
            return [IRON, SILICA, FUEL, COPPER]
                .into_iter()
                .any(|ore| self.unlocked(drill_kind(kind, ore).unwrap()));
        }
        if matches!(
            kind,
            EXPRESS_BELT | REINFORCED_IRON_DRILL
                ..=REINFORCED_FUEL_DRILL | REINFORCED_COPPER_DRILL | ULTRA_BELT
        ) && (self.progression.tier == 0 || !DEVELOPMENT_STAGE.unlocks.contains(&kind))
        {
            return false;
        }
        if !self.legacy_recipes {
            return self.stage
                >= match kind {
                    GENERATOR | CABLE | SMELTER => Stage::Bench,
                    COPPER_DRILL | IRON_DRILL => Stage::Expand,
                    FUEL_DRILL => Stage::Power,
                    KILN | ASSEMBLER => Stage::Silica,
                    GRINDER | CALIBRATOR | KIT_PRESS => return false,
                    _ => match Stage::required_for(kind) {
                        Some(stage) => stage,
                        None => return false,
                    },
                };
        }
        if kind >= SPLICER {
            return false;
        }
        if kind == CABLE {
            return self.stage >= Stage::Power;
        }
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

    pub fn known_ore(&self, tile: usize) -> u8 {
        if self.progression.regional_map {
            return if self.map_contains(tile) {
                terrain(tile, true)
            } else {
                0
            };
        }
        match terrain(tile, false) {
            IRON if tile == FIRST_ORE || self.stage >= Stage::Expand => IRON,
            FUEL if self.stage >= Stage::Power => FUEL,
            FUEL if !self.legacy_recipes && self.stage >= Stage::Bench => FUEL,
            COPPER if !self.legacy_recipes && self.stage >= Stage::Handwork => COPPER,
            SILICA if self.stage >= Stage::Silica => SILICA,
            _ => 0,
        }
    }

    pub fn gather(&mut self, tile: usize) -> i32 {
        let item = self.known_ore(tile);
        if item == 0 || !self.map_contains(tile) {
            return -3;
        }
        if self.stock_room(item) == 0 {
            return -24;
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
        if !self.spend(materials(SIMPLE_MINER), 1) {
            return -8;
        }
        self.packed_miners = 1;
        if self.stage == Stage::Craft {
            self.stage = Stage::PlaceMiner;
        }
        1
    }

    pub fn handwork(&mut self) -> i32 {
        if self.stock[IRON as usize] == 0 {
            return -8;
        }
        let mut next = self.stock;
        next[IRON as usize] -= 1;
        next[PLATE as usize] += 1;
        if !self.fits_stock(&next) {
            return -24;
        }
        self.stock = next;
        if self.stage == Stage::Handwork {
            self.stage = Stage::Bench;
        }
        1
    }

    pub fn collect(&mut self, tile: usize) -> i32 {
        let cell = self.cells[tile];
        let Some(r) = self.recipe_at(tile) else {
            return -1;
        };
        legacy_result(self.transfer(
            tile as i32,
            STOCK_TILE,
            r.output as i32,
            &[i32::MAX, cell.identity, 0],
        ))
    }

    pub fn hand_feed(&mut self, tile: usize, item: u8) -> i32 {
        legacy_result(self.transfer(
            STOCK_TILE,
            tile as i32,
            item as i32,
            &[i32::MAX, 0, self.cells[tile].identity],
        ))
    }
}

fn legacy_result(moved: i32) -> i32 {
    match moved {
        n if n > 0 => 1,
        -12 => -6,
        -13 | -14 => -9,
        error => error,
    }
}
