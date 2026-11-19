use crate::catalog::*;
use crate::world::World;

#[derive(Clone, Copy, Default)]
pub struct Progression {
    pub tier: u8,
    pub legacy_full_bounds: bool,
}

pub struct Limits {
    pub slots: u32,
    pub speed: u32,
    pub min_zoom: u32,
    pub max_zoom: u32,
}

const LIMITS: [Limits; 2] = [
    Limits {
        slots: 16,
        speed: 2,
        min_zoom: 9,
        max_zoom: 48,
    },
    Limits {
        slots: 24,
        speed: 4,
        min_zoom: 6,
        max_zoom: 64,
    },
];

impl Progression {
    pub fn limits(&self) -> &'static Limits {
        &LIMITS[self.tier as usize]
    }

    fn stack_limits(&self) -> &'static [u32; ITEMS] {
        &STACK_LIMITS[self.tier as usize]
    }

    pub fn bounds(&self) -> [usize; 4] {
        if self.tier > 0 || self.legacy_full_bounds {
            [0, 0, W, H]
        } else {
            [2, 2, W - 2, H - 1]
        }
    }

    pub fn contains(&self, tile: usize) -> bool {
        let [left, top, right, bottom] = self.bounds();
        (left..right).contains(&(tile % W)) && (top..bottom).contains(&(tile / W))
    }
}

pub fn accepts_module(kind: u8) -> bool {
    PROCESSING[kind as usize]
}

pub fn cycle_ticks(base: u32, installed: u16) -> u32 {
    if installed == 0 {
        base
    } else {
        (base * 2).div_ceil(3)
    }
}

fn used_slots(stock: &[u32; ITEMS], stacks: &[u32; ITEMS]) -> u32 {
    stock[1..]
        .iter()
        .zip(&stacks[1..])
        .filter(|&(&count, _)| count != 0)
        .map(|(&count, &stack)| count.div_ceil(stack))
        .fold(0, u32::saturating_add)
}

impl World {
    pub fn stock_room(&self, item: u8) -> u32 {
        self.stock_room_for(&self.stock, item)
    }

    pub fn stock_room_for(&self, stock: &[u32; ITEMS], item: u8) -> u32 {
        let limits = self.progression.limits();
        let stacks = self.progression.stack_limits();
        let stack = stacks[item as usize];
        let actual = stock[item as usize];
        let tail = (stack - actual % stack) % stack;
        let used = used_slots(stock, stacks);
        if used > limits.slots {
            return 0;
        }
        tail + (limits.slots - used) * stack
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
        let [left, top, right, bottom] = self.progression.bounds();
        out.extend([
            self.progression.tier.into(),
            limits.slots as i32,
            0,
            limits.speed as i32,
            limits.min_zoom as i32,
            limits.max_zoom as i32,
            left as i32,
            top as i32,
            right as i32,
            bottom as i32,
            used_slots(&self.stock, self.progression.stack_limits()).min(i32::MAX as u32) as i32,
            self.stock[SPEED_MODULE as usize] as i32,
            self.machines
                .iter()
                .any(|&tile| self.cells[tile].inv[SPEED_MODULE as usize] != 0) as i32,
        ]);
    }

    pub fn write_progression_save(&self, out: &mut Vec<i32>) {
        let installed = self
            .machines
            .iter()
            .copied()
            .filter(|&tile| self.cells[tile].inv[SPEED_MODULE as usize] != 0);
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
        if !(0..LIMITS.len() as i32).contains(tier)
            || !matches!(legacy, 0 | 1)
            || !(0..1_000_000_000).contains(modules)
            || !(0..=N as i32).contains(count)
        {
            return None;
        }
        self.progression = Progression {
            tier: *tier as u8,
            legacy_full_bounds: *legacy == 1,
        };
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
