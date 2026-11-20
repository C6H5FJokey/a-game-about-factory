use crate::campaign::Stage;
use crate::catalog::*;
use crate::inventory::{item_room, used_slots};
use crate::world::World;

#[derive(Clone, Copy, Default)]
pub struct Progression {
    pub tier: u8,
    pub legacy_full_bounds: bool,
    pub regional_map: bool,
}

pub struct Limits {
    pub slots: u32,
    pub speed: u32,
    pub min_zoom: u32,
    pub max_zoom: u32,
}

pub struct DevelopmentStage {
    pub minimum_stage: u8,
    pub requirements: &'static [(u8, u32)],
    pub unlocks: &'static [u8],
}

impl Progression {
    pub fn limits(&self) -> &'static Limits {
        &DEVELOPMENT_LIMITS[self.tier as usize]
    }

    pub fn stack_limits(&self) -> &'static [u32; ITEMS] {
        &STACK_LIMITS[self.tier as usize]
    }

    pub fn stack_limit(&self, item: u8) -> u32 {
        self.stack_limits()[item as usize]
    }

    pub fn bounds(&self, stage: Stage) -> [usize; 4] {
        if self.regional_map {
            return if stage < Stage::Handwork {
                [13, 10, 26, 23]
            } else {
                [0, 0, W, H]
            };
        }
        if self.tier > 0 || self.legacy_full_bounds {
            [0, 0, W, H]
        } else {
            [2, 2, W - 2, H - 1]
        }
    }
}

pub fn accepts_module(kind: u8) -> bool {
    PROCESSING[kind as usize]
}

pub fn cycle_ticks(base: u32, installed: u32) -> u32 {
    if installed == 0 {
        base
    } else {
        (base * 2).div_ceil(3)
    }
}

pub fn contains_tile([left, top, right, bottom]: [usize; 4], tile: usize) -> bool {
    (left..right).contains(&(tile % W)) && (top..bottom).contains(&(tile / W))
}

impl World {
    pub fn submit_development(&mut self, tile: usize, tier: i32) -> i32 {
        if tier != 1
            || self.progression.tier != 0
            || (self.stage as u8) < DEVELOPMENT_STAGE.minimum_stage
            || self.cells[tile].kind != DEVELOPMENT_HUB
        {
            return -6;
        }
        if !self.spend(DEVELOPMENT_STAGE.requirements, 1) {
            return -4;
        }
        self.progression.tier = 1;
        let stacks = self.progression.stack_limits();
        for &tile in &self.machines {
            let cell = &mut self.cells[tile];
            if matches!(cell.kind, DEPOT | FREIGHT_YARD) {
                cell.used_storage_slots = used_slots(&cell.inv, stacks);
            }
        }
        self.view_revision = self.view_revision.wrapping_add(1);
        1
    }

    pub fn map_contains(&self, tile: usize) -> bool {
        contains_tile(self.progression.bounds(self.stage), tile)
    }

    pub fn stock_room(&self, item: u8) -> u32 {
        self.stock_room_for(&self.stock, item)
    }

    pub fn stock_room_for(&self, stock: &[u32; ITEMS], item: u8) -> u32 {
        let limits = self.progression.limits();
        let stacks = self.progression.stack_limits();
        item_room(
            stock[item as usize],
            stacks[item as usize],
            used_slots(stock, stacks),
            limits.slots,
        )
    }

    pub fn fits_stock(&self, next: &[u32; ITEMS]) -> bool {
        if next == &self.stock {
            return true;
        }
        let limits = self.progression.limits();
        let stacks = self.progression.stack_limits();
        let current = used_slots(&self.stock, stacks);
        let next_slots = used_slots(next, stacks);
        next_slots <= limits.slots || next_slots < current
    }

    pub fn write_progression(&self, out: &mut Vec<i32>) {
        let limits = self.progression.limits();
        let [left, top, right, bottom] = self.progression.bounds(self.stage);
        wire::Progression {
            tier: self.progression.tier.into(),
            slots: limits.slots as i32,
            regional: self.progression.regional_map as i32,
            speed: limits.speed as i32,
            min_zoom: limits.min_zoom as i32,
            max_zoom: limits.max_zoom as i32,
            left: left as i32,
            top: top as i32,
            right: right as i32,
            bottom: bottom as i32,
            used: used_slots(&self.stock, self.progression.stack_limits()).min(i32::MAX as u32)
                as i32,
            modules: self.stock[SPEED_MODULE as usize] as i32,
            installed: self.machines.iter().any(|&tile| {
                let cell = &self.cells[tile];
                accepts_module(cell.kind) && cell.inv[SPEED_MODULE as usize] != 0
            }) as i32,
        }
        .append(out);
    }

    pub fn write_progression_save(&self, out: &mut Vec<i32>) {
        let installed = self.machines.iter().copied().filter(|&tile| {
            accepts_module(self.cells[tile].kind)
                && self.cells[tile].inv[SPEED_MODULE as usize] != 0
        });
        out.extend([
            self.progression.tier.into(),
            self.progression.legacy_full_bounds as i32,
            self.stock[SPEED_MODULE as usize] as i32,
            installed.clone().count() as i32,
        ]);
        out.extend(installed.map(|tile| tile as i32));
    }

    pub fn read_progression_save<'a>(&mut self, words: &'a [i32]) -> Option<&'a [i32]> {
        let [tier, legacy, modules, count, rest @ ..] = words else {
            return None;
        };
        if !(0..DEVELOPMENT_LIMITS.len() as i32).contains(tier)
            || !matches!(legacy, 0 | 1)
            || !(0..1_000_000_000).contains(modules)
            || !(0..=N as i32).contains(count)
        {
            return None;
        }
        self.progression.tier = *tier as u8;
        self.progression.legacy_full_bounds = *legacy == 1;
        self.stock[SPEED_MODULE as usize] = *modules as u32;
        let mut previous = -1;
        for &tile in rest.get(..*count as usize)? {
            if tile <= previous
                || tile >= N as i32
                || !accepts_module(self.cells[tile as usize].kind)
            {
                return None;
            }
            self.cells[tile as usize].inv[SPEED_MODULE as usize] = 1;
            previous = tile;
        }
        Some(&rest[*count as usize..])
    }
}
