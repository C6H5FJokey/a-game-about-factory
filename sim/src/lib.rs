mod belts;
mod catalog;
mod world;

use std::cell::RefCell;

use belts::Cargo;
use catalog::*;
use world::{Cell, Orbit, World};

const HEADER: usize = 26;
const CELL_WORDS: usize = 18;
const SAVE_HEADER: usize = 24;
const SAVE_WORDS: usize = SAVE_HEADER + N * CELL_WORDS;
const SAVE_VERSION: i32 = 1;
const BUFFER: usize = 48_000;

struct Runtime {
    world: World,
    input: Vec<i32>,
    output: Vec<i32>,
}

thread_local! {
    static RUNTIME: RefCell<Runtime> = RefCell::new(Runtime {
        world: World::new(), input: vec![0; BUFFER], output: Vec::with_capacity(BUFFER),
    });
}

#[no_mangle]
pub extern "C" fn reset() {
    RUNTIME.with(|r| r.borrow_mut().world = World::new());
}

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut i32 {
    RUNTIME.with(|r| r.borrow_mut().input.as_mut_ptr())
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const i32 {
    RUNTIME.with(|r| r.borrow().output.as_ptr())
}

#[no_mangle]
pub extern "C" fn step(ticks: u32) {
    RUNTIME.with(|r| {
        let world = &mut r.borrow_mut().world;
        for _ in 0..ticks.min(400) {
            world.step();
        }
    });
}

#[no_mangle]
pub extern "C" fn command(op: i32, a: i32, b: i32, c: i32, len: usize) -> i32 {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, input, .. } = &mut *runtime;
        let Some(words) = input.get(..len) else {
            return -1;
        };
        let tile = a as usize;
        match op {
            1 if tile < N => world.place(tile, b, c),
            2 => world.route(a == 1, words),
            3 if tile < N => world.remove(tile, b == 1),
            4 if tile < N => world.configure(tile, b),
            5 => world.launch(),
            6 => world.trial(),
            7 if tile < N => world.blueprint(tile, words),
            8 if tile < N => world.rotate(tile),
            _ => -1,
        }
    })
}

#[no_mangle]
pub extern "C" fn snapshot() -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, output, .. } = &mut *runtime;
        world.materialize();
        output.clear();
        let o = &world.orbit;
        let station = &world.cells[STATION_POS];
        let grid = world.grids[station.group as usize];
        output.extend([
            world.tick as i32,
            world.stock[PLATE as usize] as i32,
            world.stock[KIT as usize] as i32,
            o.launch_left as i32,
            o.orbiting as i32,
            o.mode as i32,
            o.time_left as i32,
            o.first_light as i32,
            world.active_blocks as i32,
            grid.generation as i32,
            grid.demand as i32,
            grid.stored as i32,
            station.inv[MIRROR as usize] as i32,
            station.inv[CORE as usize] as i32,
            station.inv[FUEL as usize] as i32,
            o.fault as i32,
            o.fault_at as i32,
            (o.sun_until > world.tick) as i32,
            world.belt.segments.len() as i32,
            world.delivered as i32,
            world.kit_total as i32,
            o.complete as i32,
            o.next_window.saturating_sub(world.tick) as i32,
            grid.discharge as i32,
            grid.used as i32,
            station.group as i32,
        ]);
        debug_assert_eq!(HEADER, output.len());
        let pulse = world.tick / BELT_TICKS;
        for (i, c) in world.cells.iter().enumerate() {
            let cargo = world.cargo[i];
            let status = if cargo.item > 0 && is_belt(c.kind) {
                if cargo.ready < pulse {
                    4
                } else {
                    1
                }
            } else {
                c.status
            };
            output.extend([
                c.kind as i32,
                c.dir as i32,
                c.wire as i32,
                terrain(i) as i32,
                cargo.item as i32,
                status as i32,
                c.group as i32,
                c.cfg as i32,
                c.progress as i32,
                c.energy as i32,
            ]);
            output.extend(c.inv[1..].iter().map(|&n| n as i32));
        }
        output.len()
    })
}

#[no_mangle]
pub extern "C" fn save() -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, output, .. } = &mut *runtime;
        world.materialize();
        output.clear();
        let o = &world.orbit;
        output.extend([
            SAVE_VERSION,
            world.tick as i32,
            world.delivered as i32,
            world.kit_total as i32,
        ]);
        output.extend(world.stock.map(|v| v as i32));
        output.extend([
            o.orbiting as i32,
            o.launch_left as i32,
            o.mode as i32,
            o.time_left as i32,
            o.first_light as i32,
            o.fault as i32,
            o.fault_at as i32,
            o.sun_until as i32,
            o.next_window as i32,
            o.complete as i32,
            0,
        ]);
        for (i, c) in world.cells.iter().enumerate() {
            output.extend([
                c.kind as i32,
                c.dir as i32,
                c.wire as i32,
                c.cfg as i32,
                c.progress as i32,
                c.energy as i32,
                c.last_make as i32,
                c.split_turn as i32,
                world.cargo[i].item as i32,
                world.cargo[i].ready as i32,
            ]);
            output.extend(c.inv[1..].iter().map(|&n| n as i32));
        }
        debug_assert_eq!(output.len(), SAVE_WORDS);
        output.len()
    })
}

#[no_mangle]
pub extern "C" fn restore(len: usize) -> i32 {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        if len != SAVE_WORDS {
            return -1;
        }
        match World::from_save(&runtime.input[..len]) {
            Some(world) => {
                runtime.world = world;
                1
            }
            None => -1,
        }
    })
}

impl World {
    fn place(&mut self, tile: usize, kind: i32, dir: i32) -> i32 {
        if !(0..4).contains(&dir) || !(0..=KILN as i32).contains(&kind) {
            return -1;
        }
        let kind = kind as u8;
        let Some(price) = cost(kind) else {
            return -1;
        };
        if self.cells[tile].kind != 0 {
            return -2;
        }
        if !permitted(kind, tile) {
            return -3;
        }
        if kind == KILN && !self.orbit.first_light {
            return -6;
        }
        if self.stock[PLATE as usize] < price {
            return -4;
        }
        self.materialize();
        self.stock[PLATE as usize] -= price;
        self.cells[tile] = Cell {
            kind,
            dir: dir as u8,
            wire: self.cells[tile].wire,
            ..Cell::default()
        };
        self.rebuild(false);
        1
    }

    fn route(&mut self, wire: bool, words: &[i32]) -> i32 {
        if words.is_empty() || words.len() % 2 != 0 || words.len() > 2 * N {
            return -1;
        }
        let mut seen = vec![false; N];
        let mut price = 0;
        for pair in words.chunks_exact(2) {
            let tile = pair[0] as usize;
            if tile >= N || seen[tile] || !(0..4).contains(&pair[1]) {
                return -1;
            }
            seen[tile] = true;
            let c = self.cells[tile];
            if !wire && c.kind != 0 && c.kind != BELT {
                return -2;
            }
            if wire && !c.wire || !wire && c.kind == 0 {
                price += 1;
            }
        }
        if wire {
            price = (price + 2) / 3;
        };
        if self.stock[PLATE as usize] < price {
            return -4;
        }
        self.stock[PLATE as usize] -= price;
        if wire {
            for pair in words.chunks_exact(2) {
                self.cells[pair[0] as usize].wire = true;
            }
            self.update_grids();
        } else {
            self.materialize();
            for pair in words.chunks_exact(2) {
                let c = &mut self.cells[pair[0] as usize];
                c.kind = BELT;
                c.dir = pair[1] as u8;
            }
            self.rebuild(false);
        }
        1
    }

    fn remove(&mut self, tile: usize, wire: bool) -> i32 {
        if wire {
            if !self.cells[tile].wire {
                return -1;
            }
            self.cells[tile].wire = false;
            self.update_grids();
            return 1;
        }
        let c = self.cells[tile];
        if tile == STATION_POS || tile == DEPOT_POS || c.kind == 0 {
            return -6;
        }
        self.materialize();
        let cargo = &mut self.cargo[tile];
        if cargo.item > 0 {
            self.stock[cargo.item as usize] += 1;
            *cargo = Cargo::default();
        }
        for (i, &count) in c.inv.iter().enumerate() {
            self.stock[i] += u32::from(count);
        }
        // Only return material present in the machine or on the belt. Build cost
        // might have been paid with equipment kits.
        self.cells[tile] = Cell {
            wire: c.wire,
            ..Cell::default()
        };
        self.rebuild(false);
        1
    }

    fn configure(&mut self, tile: usize, value: i32) -> i32 {
        let c = &mut self.cells[tile];
        let max = match c.kind {
            DEPOT => 8,
            SPLITTER => 1,
            kind if recipe(kind).is_some() || kind == STATION => 2,
            _ => return -1,
        };
        if !(0..=max).contains(&value) {
            return -1;
        }
        c.cfg = value as u8;
        1
    }

    fn rotate(&mut self, tile: usize) -> i32 {
        let c = self.cells[tile];
        if c.kind == 0 || c.kind == STATION {
            return -1;
        }
        self.materialize();
        self.cells[tile].dir = (c.dir + 1) % 4;
        self.rebuild(false);
        1
    }

    fn blueprint(&mut self, anchor: usize, words: &[i32]) -> i32 {
        if words.is_empty() || words.len() % 6 != 0 || words.len() > 6 * 250 {
            return -1;
        }
        let mut seen = vec![false; N];
        let mut placed = Vec::new();
        let mut pieces = 0;
        for part in words.chunks_exact(6) {
            let x = anchor as i32 % W as i32 + part[0];
            let y = anchor as i32 / W as i32 + part[1];
            if !(0..W as i32).contains(&x) || !(0..H as i32).contains(&y) {
                return -1;
            }
            let tile = index(x as usize, y as usize);
            if seen[tile]
                || !(0..=KILN as i32).contains(&part[2])
                || !(0..4).contains(&part[3])
                || !(0..=1).contains(&part[4])
            {
                return -1;
            }
            seen[tile] = true;
            let kind = part[2] as u8;
            if kind != 0 && (cost(kind).is_none() || self.cells[tile].kind != 0) {
                return -2;
            }
            if !permitted(kind, tile) {
                return -3;
            }
            let cfg = part[5].clamp(
                0,
                match kind {
                    DEPOT => 8,
                    SPLITTER => 1,
                    _ => 2,
                },
            ) as u8;
            if kind != 0 {
                pieces += 1;
            }
            placed.push((tile, kind, part[3] as u8, part[4] == 1, cfg));
        }
        let price = (pieces as u32).div_ceil(2).max(2);
        if !self.orbit.first_light {
            return -6;
        }
        if self.stock[KIT as usize] < price {
            return -5;
        }
        self.stock[KIT as usize] -= price;
        self.materialize();
        for (tile, kind, dir, wire, cfg) in placed {
            let cell = &mut self.cells[tile];
            if kind != 0 {
                *cell = Cell {
                    kind,
                    dir,
                    cfg,
                    wire: cell.wire,
                    ..Cell::default()
                };
            }
            cell.wire |= wire;
        }
        self.rebuild(false);
        1
    }

    fn from_save(data: &[i32]) -> Option<Self> {
        let sane = |x: i32| (0..1_000_000_000).contains(&x);
        let flag = |x| matches!(x, 0 | 1);
        if data[0] != SAVE_VERSION || data[1..13].iter().any(|&x| !sane(x)) {
            return None;
        }
        if !flag(data[13])
            || !(0..=LAUNCH_TICKS as i32).contains(&data[14])
            || !(0..=4).contains(&data[15])
            || !(0..=WINDOW as i32).contains(&data[16])
            || !flag(data[17])
            || !(0..=2).contains(&data[18])
            || !(0..=WINDOW as i32).contains(&data[19])
            || !sane(data[20])
            || !sane(data[21])
            || !flag(data[22])
            || matches!(data[15], 1 | 2) && data[16] == 0
        {
            return None;
        }
        let mut w = Self::empty();
        w.tick = data[1] as u32;
        w.delivered = data[2] as u32;
        w.kit_total = data[3] as u32;
        for (slot, &value) in w.stock.iter_mut().zip(&data[4..13]) {
            *slot = value as u32;
        }
        w.orbit = Orbit {
            orbiting: data[13] == 1,
            launch_left: data[14] as u32,
            mode: data[15] as u8,
            time_left: data[16] as u32,
            first_light: data[17] == 1,
            fault: data[18] as u8,
            fault_at: data[19] as u32,
            sun_until: data[20] as u32,
            next_window: data[21] as u32,
            complete: data[22] == 1,
        };
        for (i, s) in data[SAVE_HEADER..].chunks_exact(CELL_WORDS).enumerate() {
            if !(0..=KILN as i32).contains(&s[0])
                || !(0..4).contains(&s[1])
                || !flag(s[2])
                || !flag(s[7])
                || !(0..=59).contains(&s[4])
                || !(0..=BATTERY_CAPACITY as i32).contains(&s[5])
                || !(0..=data[1]).contains(&s[6])
                || !(0..ITEMS as i32).contains(&s[8])
                || !sane(s[9])
                || s[10..].iter().any(|x| !(0..=24).contains(x))
            {
                return None;
            }
            let kind = s[0] as u8;
            let max = match kind {
                DEPOT => 8,
                SPLITTER => 1,
                _ => 2,
            };
            if !(0..=max).contains(&s[3])
                || !permitted(kind, i)
                || (i == STATION_POS) != (kind == STATION)
                || (i == DEPOT_POS && kind != DEPOT)
                || (s[8] != 0 && !is_belt(kind))
            {
                return None;
            }
            let mut inv = [0; ITEMS];
            for (slot, &value) in inv[1..].iter_mut().zip(&s[10..]) {
                *slot = value as u16;
            }
            w.cells[i] = Cell {
                kind,
                dir: s[1] as u8,
                wire: s[2] == 1,
                cfg: s[3] as u8,
                progress: s[4] as u16,
                energy: s[5] as u32,
                last_make: s[6] as u32,
                split_turn: s[7] == 1,
                inv,
                ..Cell::default()
            };
            w.cargo[i] = Cargo {
                item: s[8] as u8,
                ready: s[9] as u32,
            };
        }
        w.rebuild(true);
        Some(w)
    }
}
