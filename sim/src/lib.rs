mod belts;
mod campaign;
mod catalog;
mod regions;
mod world;

use std::cell::RefCell;

use belts::{Cargo, RETIRED_SOURCE};
use campaign::Stage;
use catalog::*;
use regions::*;
use world::{Cell, Orbit, World};

const HEADER: usize = 54 + 3 * 14 + 2;
const SAVE_HEADER: usize = 32 + 2 * ROUTE_WORDS;
const SAVE_CELL_WORDS: usize = 19;
const SAVE_WORDS: usize = SAVE_HEADER + N * SAVE_CELL_WORDS;
const SAVE_VERSION: i32 = 4;
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
            6 if (0..=2).contains(&b) => world.regional_window(tile, b as u8),
            7 if tile < N => world.blueprint(tile, words),
            8 if tile < N => world.rotate(tile),
            9 if tile < N => world.gather(tile),
            10 => world.craft_miner(),
            11 if tile < N => world.collect(tile),
            12 => world.handwork(),
            13 if tile < N && (1..ITEMS as i32).contains(&b) => world.hand_feed(tile, b as u8),
            14 => world.open_line(tile),
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
            world.active_blocks() as i32,
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
            (DELIVERY_WINDOW / HZ) as i32,
            REQUIRED_BLOCKS as i32,
            REQUIRED_KITS as i32,
            world.stage as i32,
            world.packed_miners as i32,
            MINER_COST as i32,
            MINER_TICKS as i32,
            MINER_CAPACITY as i32,
            (1..=FREIGHT_YARD)
                .filter(|&kind| world.unlocked(kind))
                .fold(0, |mask, kind| mask | (1 << kind)),
            FIRST_ORE as i32,
        ]);
        output.extend(world.stock[1..].iter().map(|&v| v as i32));
        output.extend([
            o.modules as i32,
            o.target as i32,
            o.program as i32,
            o.rounds as i32,
            o.lit as i32,
            o.fault_city as i32,
            HEADWAY as i32,
            TRAVEL as i32,
            CRATE_SIZE as i32,
            LINE_COST as i32,
        ]);
        for (n, &tile) in STATIONS.iter().enumerate() {
            let s = world.cells[tile];
            let g = world.grids[s.group as usize];
            let (cores, energy) = reserve(n);
            let (sender, receiver, r) = if n > 0 {
                (
                    SENDERS[n - 1] as i32,
                    RECEIVERS[n - 1] as i32,
                    world.routes[n - 1],
                )
            } else {
                (-1, -1, Route::default())
            };
            output.extend([
                tile as i32,
                sender,
                receiver,
                WINDOW_LENGTH[n] as i32,
                TRACKING_POWER[n] as i32,
                cores as i32,
                energy as i32,
                g.stored as i32,
                if r.arrival == 0 {
                    -1
                } else {
                    r.arrival.saturating_sub(world.tick) as i32
                },
                r.crate_stock.iter().sum::<u16>() as i32,
                r.delivered as i32,
                g.generation as i32,
                g.demand as i32,
                WINDOW_GAP[n] as i32,
            ]);
        }
        output.extend([
            world.beam_x100(),
            if world.stage == Stage::Victory {
                (20 * HZ).saturating_sub(o.sun_until.saturating_sub(world.tick)) as i32
            } else {
                -1
            },
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
                world.known_ore(i) as i32,
                cargo.item as i32,
                status as i32,
                c.group as i32,
                c.cfg as i32,
                c.progress as i32,
                c.energy as i32,
            ]);
            output.extend(c.inv[1..].iter().map(|&n| n as i32));
            output.push(c.delivering_kits(world.tick) as i32);
        }
        for g in &world.grids {
            output.extend([
                g.generation as i32,
                g.demand as i32,
                g.discharge as i32,
                g.stored as i32,
            ]);
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
            world.stage as i32,
            world.packed_miners as i32,
            o.modules as i32,
            o.target as i32,
            o.program as i32,
            o.rounds as i32,
            o.lit as i32,
            o.fault_city as i32,
            o.sun_city as i32,
        ]);
        for r in world.routes {
            output.extend([r.arrival as i32, r.delivered as i32]);
            output.extend(r.crate_stock.map(i32::from));
        }
        for (i, c) in world.cells.iter().enumerate() {
            output.extend([
                c.kind as i32,
                c.dir as i32,
                c.wire as i32,
                c.cfg as i32,
                c.progress as i32,
                c.energy as i32,
                c.last_kit_delivery as i32,
                c.split_turn as i32,
                world.cargo[i].item as i32,
                world.cargo[i].ready as i32,
            ]);
            output.extend(c.inv[1..].iter().map(|&n| n as i32));
            output.push(world.cargo[i].source as i32);
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
        if !(0..4).contains(&dir) || !(0..=BENCH as i32).contains(&kind) {
            return -1;
        }
        let kind = kind as u8;
        if !self.unlocked(kind) {
            return -6;
        }
        let price = if kind == SIMPLE_MINER {
            if self.packed_miners == 0 {
                return -6;
            }
            0
        } else if let Some(cost) = cost(kind) {
            cost
        } else {
            return -1;
        };
        if self.cells[tile].kind != 0 {
            return -2;
        }
        if !permitted(kind, tile)
            || (kind == STATION
                && !STATIONS
                    .iter()
                    .position(|&t| t == tile)
                    .is_some_and(|n| self.city_known(n)))
            || (kind == SIMPLE_MINER && self.known_ore(tile) != IRON)
        {
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
        if kind == SIMPLE_MINER {
            self.packed_miners -= 1;
        }
        self.stage = match (self.stage, kind) {
            (Stage::PlaceMiner, SIMPLE_MINER) => Stage::Mining,
            (Stage::Bench, BENCH) => Stage::Feed,
            (Stage::Expand, IRON_DRILL) => Stage::Power,
            (stage, _) => stage,
        };
        self.cells[tile] = Cell {
            kind,
            dir: dir as u8,
            cfg: if kind == STATION { 2 } else { 0 },
            wire: self.cells[tile].wire,
            ..Cell::default()
        };
        self.rebuild(false);
        1
    }

    fn route(&mut self, wire: bool, words: &[i32]) -> i32 {
        if self.stage < if wire { Stage::Power } else { Stage::Belt } {
            return -6;
        }
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
            if !wire && (!permitted(BELT, tile) || c.kind != 0 && c.kind != BELT) {
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
        if self.stage < Stage::Belt {
            return -6;
        }
        if wire {
            if !self.cells[tile].wire {
                return -1;
            }
            self.cells[tile].wire = false;
            self.update_grids();
            return 1;
        }
        let c = self.cells[tile];
        if matches!(c.kind, STATION | FREIGHT_YARD | 0) {
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
        if c.kind == SIMPLE_MINER {
            self.packed_miners += 1;
        }
        if matches!(c.kind, KIT_PRESS | SMELTER | BENCH) {
            for cargo in &mut self.cargo {
                if cargo.source == tile as u16 + 1 {
                    cargo.source = RETIRED_SOURCE;
                }
            }
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
        if self.stage < Stage::Expand {
            return -6;
        }
        if self.cells[tile].kind == DEPOT && value != 0 && !self.known_item(value as u8) {
            return -6;
        }
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
        if self.stage < Stage::Belt {
            return -6;
        }
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
                || !(0..=BENCH as i32).contains(&part[2])
                || !(0..4).contains(&part[3])
                || !(0..=1).contains(&part[4])
            {
                return -1;
            }
            seen[tile] = true;
            let kind = part[2] as u8;
            if kind != 0
                && (kind == STATION
                    || !self.stage.allows(kind)
                    || cost(kind).is_none()
                    || self.cells[tile].kind != 0)
            {
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
            || !(0..=3).contains(&data[18])
            || !(0..=WINDOW as i32).contains(&data[19])
            || !sane(data[20])
            || !sane(data[21])
            || !flag(data[22])
            || matches!(data[15], 1 | 2) && data[16] == 0
        {
            return None;
        }
        let mut w = Self::empty();
        w.stage = Stage::from_word(data[23])?;
        w.packed_miners = u16::try_from(data[24]).ok()?;
        if !(0..=3).contains(&data[25])
            || !(0..=2).contains(&data[26])
            || !(0..=2).contains(&data[27])
            || !(0..=3).contains(&data[28])
            || !(0..=7).contains(&data[29])
            || !(0..=2).contains(&data[30])
            || data[15] == 2 && data[16] as u32 > WINDOW_LENGTH[data[26] as usize]
        {
            return None;
        }
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
            sun_city: u8::try_from(data[31]).ok()?,
            next_window: data[21] as u32,
            complete: data[22] == 1,
            modules: data[25] as u8,
            target: data[26] as u8,
            program: data[27] as u8,
            rounds: data[28] as u8,
            lit: data[29] as u8,
            fault_city: data[30] as u8,
        };
        for (r, words) in w
            .routes
            .iter_mut()
            .zip(data[32..SAVE_HEADER].chunks_exact(ROUTE_WORDS))
        {
            r.arrival = u32::try_from(words[0]).ok()?;
            r.delivered = u32::try_from(words[1]).ok()?;
            for (slot, &count) in r.crate_stock.iter_mut().zip(&words[2..]) {
                *slot = u16::try_from(count).ok()?;
                if *slot > CRATE_SIZE {
                    return None;
                }
            }
        }
        for (i, s) in data[SAVE_HEADER..]
            .chunks_exact(SAVE_CELL_WORDS)
            .enumerate()
        {
            if !(0..=FREIGHT_YARD as i32).contains(&s[0])
                || !(0..4).contains(&s[1])
                || !flag(s[2])
                || !flag(s[7])
                || !(0..=59).contains(&s[4])
                || !(0..=BATTERY_CAPACITY as i32).contains(&s[5])
                || !(0..=data[1]).contains(&s[6])
                || !(0..ITEMS as i32).contains(&s[8])
                || !sane(s[9])
                || s[10..18]
                    .iter()
                    .any(|x| !(0..=if s[0] == FREIGHT_YARD as i32 { 32 } else { 24 }).contains(x))
                || !(0..=i32::from(RETIRED_SOURCE)).contains(&s[18])
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
                || (kind != 0 && (!w.stage.allows(kind) || !permitted(kind, i)))
                || (s[8] != 0 && !is_belt(kind))
                || (s[6] != 0 && kind != KIT_PRESS)
                || (s[18] != 0 && !matches!(s[8] as u8, KIT | PLATE))
            {
                return None;
            }
            let mut inv = [0; ITEMS];
            for (slot, &value) in inv[1..].iter_mut().zip(&s[10..18]) {
                *slot = value as u16;
            }
            w.cells[i] = Cell {
                kind,
                dir: s[1] as u8,
                wire: s[2] == 1,
                cfg: s[3] as u8,
                progress: s[4] as u16,
                energy: s[5] as u32,
                last_kit_delivery: s[6] as u32,
                split_turn: s[7] == 1,
                inv,
                ..Cell::default()
            };
            w.cargo[i] = Cargo {
                item: s[8] as u8,
                ready: s[9] as u32,
                source: s[18] as u16,
            };
        }
        for cargo in &w.cargo {
            if cargo.source != 0 && cargo.source != RETIRED_SOURCE {
                let producer = w.cells[usize::from(cargo.source) - 1].kind;
                if !matches!(
                    (cargo.item, producer),
                    (KIT, KIT_PRESS) | (PLATE, SMELTER | BENCH)
                ) {
                    return None;
                }
            }
        }
        w.rebuild(true);
        Some(w)
    }
}
