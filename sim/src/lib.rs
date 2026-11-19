mod belts;
mod blueprints;
mod campaign;
mod catalog;
mod construction;
mod footprints;
mod ground;
mod interface;
mod inventory;
mod progression;
mod recipes;
mod regions;
mod transport;
mod transport_save;
#[cfg(test)]
mod transport_tests;
mod world;

use std::cell::RefCell;

use belts::{node, RETIRED_SOURCE};
use campaign::Stage;
use catalog::*;
use regions::*;
use world::{Cell, Orbit, World, FUEL_STEPS_PER_TICK};

const HEADER: usize = 54 + 3 * 14 + 2;
const SAVE_HEADER: usize = 32 + 2 * LEGACY_ROUTE_WORDS;
const SAVE_CELL_WORDS: usize = 19;
const SAVE_WORDS: usize = SAVE_HEADER + N * SAVE_CELL_WORDS;
const TAGGED_SAVE_VERSION: i32 = 8;
const PRE_RECIPE_SAVE_VERSION: i32 = 9;
const RECIPE_SAVE_VERSION: i32 = 10;
const BUFFER: usize = 48_000;
const MAX_INPUT: usize = 1_000_000;

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
pub extern "C" fn reserve_input(len: usize) -> *mut i32 {
    if len > MAX_INPUT {
        return std::ptr::null_mut();
    }
    RUNTIME.with(|r| {
        let mut r = r.borrow_mut();
        if len > r.input.len() {
            r.input.resize(len, 0);
        }
        r.input.as_mut_ptr()
    })
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
pub extern "C" fn max_speed() -> u32 {
    RUNTIME.with(|r| r.borrow().world.progression.limits().speed)
}

#[no_mangle]
pub extern "C" fn tick_rate() -> u32 {
    HZ
}

#[no_mangle]
pub extern "C" fn content_signature() -> u32 {
    BUILD_SIGNATURE
}

#[no_mangle]
pub extern "C" fn command(op: i32, a: i32, b: i32, c: i32, len: usize) -> i32 {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, input, .. } = &mut *runtime;
        let Some(words) = input.get(..len) else {
            return -1;
        };
        let clicked = a as usize;
        let tile = if clicked < N && matches!(op, 4 | 8 | 11 | 13) {
            world.footprints.owner(clicked).unwrap_or(clicked)
        } else {
            clicked
        };
        match op {
            1 if tile < N => world.place(tile, b, c),
            2 => world.route(a == 1, words),
            3 if tile < N => world.remove(tile, b == 1),
            4 if tile < N => world.configure(tile, b),
            5 => world.launch(),
            6 if (0..=2).contains(&b) => world.regional_window(tile, b as u8),
            7 => match words {
                &[turns] => world.deploy_blueprint(tile, b, c, turns),
                _ => -1,
            },
            8 if tile < N => world.rotate(tile),
            9 if tile < N => world.gather(tile),
            10 => world.craft_miner(),
            11 if tile < N => world.collect(tile),
            12 if world.legacy_recipes => world.handwork(),
            13 if tile < N && (1..MATERIAL_ITEMS as i32).contains(&b) => {
                world.hand_feed(tile, b as u8)
            }
            14 => world.open_line(tile),
            15 => world.transfer(a, b, c, words),
            16 => world.capture_blueprint(tile, b as usize, words),
            17 => world.blueprints.rename(a, words),
            18 => world.blueprints.delete(a),
            19 => world.blueprints.import_legacy(words),
            20 => world.build_transports(a, words),
            21 => world.take_cargo(tile, b as usize, c, words),
            22 if tile < N => world.select_recipe(tile, b, c),
            23 => world.start_handcraft(a, b),
            24 => world.cancel_handcraft(a),
            25 => world.finish_handcraft(a),
            26 => world.drop_held(tile, b, c),
            27 => world.pick_ground(tile, b, c),
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
            world.build_materials(SIMPLE_MINER)[0].1 as i32,
            MINER_TICKS as i32,
            MINER_CAPACITY as i32,
            (1..=SPLICER)
                .filter(|&kind| world.unlocked(kind))
                .fold(0, |mask, kind| mask | (1 << kind)),
            FIRST_ORE as i32,
        ]);
        output.extend(
            world.stock[1..LEGACY_MATERIAL_ITEMS]
                .iter()
                .map(|&v| v as i32),
        );
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
        for (i, c) in world.cells.iter().enumerate() {
            let cargo = [world.cargo[node(i, 0)], world.cargo[node(i, 1)]]
                .into_iter()
                .find(|c| c.item > 0)
                .unwrap_or_default();
            let status = if cargo.item > 0 && is_belt(c.kind) {
                if cargo.blocked {
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
            output.extend(c.inv[1..LEGACY_MATERIAL_ITEMS].iter().map(|&n| n as i32));
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
        world.ground.write_view(output);
        world.write_recipe_view(output);
        world.write_machine_footprints(output);
        world.write_progression(output);
        world.write_transport_projection(output);
        world.write_device_data(output);
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
        output.extend(
            world.stock[..LEGACY_MATERIAL_ITEMS]
                .iter()
                .map(|&v| v as i32),
        );
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
            output.extend(
                r.crate_stock[..LEGACY_MATERIAL_ITEMS]
                    .iter()
                    .map(|&v| i32::from(v)),
            );
        }
        for (i, c) in world.cells.iter().enumerate() {
            output.extend([
                layout_kind(c.kind) as i32,
                c.dir as i32,
                c.wire as i32,
                c.cfg as i32,
                c.progress as i32,
                c.energy as i32,
                c.last_kit_delivery as i32,
                c.split_turn as i32,
                world.cargo[node(i, 0)].item as i32,
                world.cargo[node(i, 0)].ready as i32,
            ]);
            output.extend(c.inv[1..LEGACY_MATERIAL_ITEMS].iter().map(|&n| n as i32));
            output.push(world.cargo[node(i, 0)].source as i32);
        }
        debug_assert_eq!(output.len(), SAVE_WORDS);
        world.write_transport_save(output);
        world.write_progression_save(output);
        world.write_saved_devices(output);
        world.write_recipe_save(output);
        world.ground.write_save(output);
        world.blueprints.write_save(output);
        output.extend(SAVE_DATA_TAG);
        output.len()
    })
}

#[no_mangle]
pub extern "C" fn restore(len: usize) -> i32 {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Some(words) = runtime.input.get(..len) else {
            return -1;
        };
        let data = if matches!(
            words.first().copied(),
            Some(
                TAGGED_SAVE_VERSION | PRE_RECIPE_SAVE_VERSION | RECIPE_SAVE_VERSION | SAVE_VERSION
            )
        ) {
            let Some(end) = words
                .last()
                .and_then(|&size| usize::try_from(size).ok())
                .filter(|&size| (7..=54).contains(&size))
                .and_then(|size| words.len().checked_sub(size))
                .filter(|&end| end > SAVE_WORDS)
            else {
                return -1;
            };
            let tag = if words[0] < RECIPE_SAVE_VERSION {
                LEGACY_SAVE_DATA_TAG
            } else {
                SAVE_DATA_TAG
            };
            if words[end..] != *tag {
                return -25;
            }
            &words[..end]
        } else {
            words
        };
        match World::from_save(data) {
            Some(world) => {
                runtime.world = world;
                1
            }
            None => -1,
        }
    })
}

fn saved_ticks(value: i32, legacy_clock: bool) -> Option<u32> {
    let ticks = u32::try_from(value).ok()?;
    let ticks = if legacy_clock {
        simulation_ticks(ticks)
    } else {
        ticks
    };
    (ticks <= i32::MAX as u32).then_some(ticks)
}

impl World {
    fn drill_at(&self, tile: usize, layout: u8) -> Result<u8, i32> {
        let Some(kind) = drill_kind(layout, terrain(tile)) else {
            return Err(-3);
        };
        if self.known_ore(tile) == 0 || !self.unlocked(kind) {
            return Err(-19);
        }
        Ok(kind)
    }

    fn place(&mut self, tile: usize, kind: i32, dir: i32) -> i32 {
        if !(0..4).contains(&dir)
            || !(0..=MAX_KIND as i32).contains(&kind)
            || kind == i32::from(CABLE)
        {
            return -1;
        }
        let kind = kind as u8;
        if is_belt(kind) {
            return self.build_transports(self.layout_revision, &[tile as i32, kind.into(), dir]);
        }
        if self.footprints.owner(tile).is_some() {
            return -2;
        }
        let kind = if matches!(kind, INDUSTRIAL_MINER | REINFORCED_MINER) {
            match self.drill_at(tile, kind) {
                Ok(kind) => kind,
                Err(error) => return error,
            }
        } else {
            kind
        };
        if !self.unlocked(kind) {
            return -6;
        }
        let use_packed_miner = kind == SIMPLE_MINER && self.packed_miners > 0;
        let materials = if use_packed_miner {
            &[][..]
        } else {
            if kind == FREIGHT_YARD || self.build_materials(kind).is_empty() {
                return -1;
            }
            self.build_materials(kind)
        };
        if !self.progression.contains(tile)
            || !permitted(kind, tile)
            || (kind == STATION
                && !STATIONS
                    .iter()
                    .position(|&t| t == tile)
                    .is_some_and(|n| self.city_known(n)))
            || (kind == SIMPLE_MINER && self.known_ore(tile) == 0)
        {
            return -3;
        }
        if self.legacy_recipes && kind == KILN && !self.orbit.first_light {
            return -6;
        }
        if let Err(error) = self.validate_footprint(tile, kind, dir as u8, None) {
            return error;
        }
        if !self.spend(materials, 1) {
            return -4;
        }
        self.materialize();
        if use_packed_miner {
            self.packed_miners -= 1;
        }
        self.stage = match (self.stage, kind) {
            (Stage::Gather | Stage::Craft | Stage::PlaceMiner, SIMPLE_MINER) => Stage::Mining,
            (Stage::Bench, BENCH) => Stage::Feed,
            (Stage::Expand, IRON_DRILL | COPPER_DRILL) => Stage::Power,
            (stage, _) => stage,
        };
        self.install(
            tile,
            Cell {
                kind,
                dir: dir as u8,
                cfg: if kind == STATION { 2 } else { 0 },
                wire: self.cells[tile].wire,
                ..Cell::default()
            },
        );
        self.ground.record_device(tile, materials, use_packed_miner);
        self.rebuild();
        1
    }

    fn route(&mut self, wire: bool, words: &[i32]) -> i32 {
        if words.is_empty() || words.len() % 2 != 0 || words.len() > 2 * N {
            return -1;
        }
        if !wire {
            let plan: Vec<_> = words
                .chunks_exact(2)
                .flat_map(|p| [p[0], i32::from(BELT), p[1]])
                .collect();
            return self.build_transports(self.layout_revision, &plan);
        }
        if !self.unlocked(CABLE) {
            return -6;
        }
        let mut seen = vec![false; N];
        let mut new_tiles = 0u32;
        for p in words.chunks_exact(2) {
            let tile = p[0] as usize;
            if tile >= N || std::mem::replace(&mut seen[tile], true) || !(0..4).contains(&p[1]) {
                return -1;
            }
            if !self.progression.contains(tile) {
                return -3;
            }
            new_tiles += u32::from(!self.cells[tile].wire);
        }
        if !self.spend(
            self.build_materials(CABLE),
            new_tiles.div_ceil(self.cable_span()),
        ) {
            return -4;
        }
        for p in words.chunks_exact(2) {
            self.cells[p[0] as usize].wire = true;
        }
        self.update_grids();
        1
    }

    fn remove(&mut self, tile: usize, wire: bool) -> i32 {
        if wire {
            if !self.cells[tile].wire {
                return -1;
            }
            if let Err(status) =
                self.settle_removals(self.stock, [(ground::cable_payment_site(tile), [0; ITEMS])])
            {
                return status;
            }
            self.cells[tile].wire = false;
            self.update_grids();
            return 1;
        }
        let tile = self.footprints.owner(tile).unwrap_or(tile);
        let c = self.cells[tile];
        if matches!(c.kind, STATION | FREIGHT_YARD | 0) {
            return -6;
        }
        self.materialize();
        let mut returned = [0; ITEMS];
        for lane in 0..belt_lanes(c.kind) {
            let cargo = self.cargo[node(tile, lane)];
            if cargo.item > 0 {
                returned[cargo.item as usize] += 1;
            }
        }
        if c.progress > 0 {
            if let Some(recipe) = self.recipe_at(tile) {
                for (item, count) in recipe.input {
                    returned[item as usize] += u32::from(count);
                }
            }
        }
        for (i, &count) in c.inv.iter().enumerate() {
            returned[i] += u32::from(count);
        }
        if let Err(error) = self.settle_removals(self.stock, [(tile, returned)]) {
            return error;
        }
        for lane in 0..belt_lanes(c.kind) {
            self.cargo[node(tile, lane)] = belts::Cargo::default();
        }
        if matches!(c.kind, KIT_PRESS | SPLICER | SMELTER | BENCH) {
            for cargo in &mut self.cargo {
                if cargo.source == tile as u16 + 1 {
                    cargo.source = RETIRED_SOURCE;
                }
            }
        }
        self.cells[tile] = Cell {
            wire: c.wire,
            ..Cell::default()
        };
        self.rebuild();
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
            DEPOT => (ITEMS - 1) as i32,
            SPLITTER => 1,
            kind if PROCESSING[kind as usize] || recipe(kind).is_some() || kind == STATION => 2,
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
        if is_belt(c.kind) {
            return self.build_transports(
                self.layout_revision,
                &[tile as i32, c.kind.into(), ((c.dir + 1) % 4).into()],
            );
        }
        if let Err(error) = self.validate_footprint(tile, c.kind, (c.dir + 1) % 4, Some(tile)) {
            return error;
        }
        self.materialize();
        self.cells[tile].dir = (c.dir + 1) % 4;
        self.rebuild();
        1
    }

    fn from_save(data: &[i32]) -> Option<Self> {
        let version = *data.first()?;
        let max_kind = match version {
            4 if data.len() == SAVE_WORDS => FREIGHT_YARD,
            5 if data.len() > SAVE_WORDS => INDUSTRIAL_MINER,
            6 if data.len() > SAVE_WORDS => CROSSING,
            7..=PRE_RECIPE_SAVE_VERSION if data.len() > SAVE_WORDS => REINFORCED_MINER,
            RECIPE_SAVE_VERSION | SAVE_VERSION if data.len() > SAVE_WORDS => MAX_KIND,
            _ => return None,
        };
        let legacy_clock = version < PRE_RECIPE_SAVE_VERSION;
        let ticks = |value| saved_ticks(value, legacy_clock);
        let sane = |x: i32| (0..1_000_000_000).contains(&x);
        let flag = |x| matches!(x, 0 | 1);
        if data[2..13].iter().any(|&x| !sane(x)) {
            return None;
        }
        let tick = ticks(data[1])?;
        let launch_left = ticks(data[14])?;
        let time_left = ticks(data[16])?;
        let fault_at = ticks(data[19])?;
        let sun_until = ticks(data[20])?;
        let next_window = ticks(data[21])?;
        let clock_limit = simulation_ticks(1_000_000_000);
        if !flag(data[13])
            || tick >= clock_limit
            || launch_left > LAUNCH_TICKS
            || !(0..=4).contains(&data[15])
            || time_left > WINDOW
            || !flag(data[17])
            || !(0..=3).contains(&data[18])
            || fault_at > WINDOW
            || sun_until >= clock_limit
            || next_window >= clock_limit
            || !flag(data[22])
            || matches!(data[15], 1 | 2) && time_left == 0
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
            || data[15] == 2 && time_left > WINDOW_LENGTH[data[26] as usize]
        {
            return None;
        }
        w.tick = tick;
        w.delivered = data[2] as u32;
        w.kit_total = data[3] as u32;
        for (slot, &value) in w.stock.iter_mut().zip(&data[4..13]) {
            *slot = value as u32;
        }
        w.orbit = Orbit {
            orbiting: data[13] == 1,
            launch_left,
            mode: data[15] as u8,
            time_left,
            first_light: data[17] == 1,
            fault: data[18] as u8,
            fault_at,
            sun_until,
            sun_city: u8::try_from(data[31]).ok()?,
            next_window,
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
            .zip(data[32..SAVE_HEADER].chunks_exact(LEGACY_ROUTE_WORDS))
        {
            r.arrival = ticks(words[0])?;
            r.delivered = u32::try_from(words[1]).ok()?;
            for (slot, &count) in r.crate_stock.iter_mut().zip(&words[2..]) {
                *slot = u16::try_from(count).ok()?;
                if *slot > CRATE_SIZE {
                    return None;
                }
            }
        }
        for (i, s) in data[SAVE_HEADER..SAVE_WORDS]
            .chunks_exact(SAVE_CELL_WORDS)
            .enumerate()
        {
            let progress = ticks(s[4])?;
            let energy = ticks(s[5])?;
            let last_kit_delivery = ticks(s[6])?;
            if !(0..=i32::from(max_kind)).contains(&s[0])
                || !(0..4).contains(&s[1])
                || !flag(s[2])
                || !flag(s[7])
                || progress >= simulation_ticks(u16::MAX.into())
                || energy > simulation_ticks(10_000_000)
                || last_kit_delivery > tick
                || !(0..MATERIAL_ITEMS as i32).contains(&s[8])
                || ticks(s[9])? >= clock_limit
                || s[10..18]
                    .iter()
                    .any(|x| !(0..=if s[0] == FREIGHT_YARD as i32 { 32 } else { 24 }).contains(x))
                || !(0..=i32::from(RETIRED_SOURCE)).contains(&s[18])
            {
                return None;
            }
            let kind = s[0] as u8;
            let kind = if matches!(kind, INDUSTRIAL_MINER | REINFORCED_MINER) {
                drill_kind(kind, terrain(i))?
            } else {
                kind
            };
            let max = match kind {
                DEPOT => (ITEMS - 1) as i32,
                SPLITTER => 1,
                MERGER => 3,
                _ => 2,
            };
            if !(0..=max).contains(&s[3])
                || (kind != 0
                    && ((version < RECIPE_SAVE_VERSION && !w.stage.allows(kind))
                        || !permitted(kind, i)))
                || (s[8] != 0 && !is_belt(kind))
                || (s[6] != 0 && !matches!(kind, KIT_PRESS | SPLICER))
                || (s[18] != 0 && !matches!(s[8] as u8, KIT | PLATE))
            {
                return None;
            }
            let mut inv = [0; ITEMS];
            for (slot, &value) in inv[1..MATERIAL_ITEMS].iter_mut().zip(&s[10..18]) {
                *slot = value as u16;
            }
            if version < TAGGED_SAVE_VERSION && progress > 0 {
                if let Some(r) = recipe(kind) {
                    let legacy = LEGACY_RECIPE_INPUTS[kind as usize];
                    if r.input != legacy {
                        return None;
                    }
                    if data[0] < 6 {
                        for (item, count) in legacy {
                            inv[item as usize] = inv[item as usize].checked_sub(count)?;
                        }
                    }
                }
            }
            let progress = if legacy_clock && kind == GENERATOR {
                s[4] as u32 * (HZ * FUEL_STEPS_PER_TICK / CONTENT_HZ)
            } else {
                progress
            };
            w.install(
                i,
                Cell {
                    kind,
                    dir: s[1] as u8,
                    wire: s[2] == 1,
                    cfg: s[3] as u8,
                    progress,
                    energy: energy.min(BATTERY_CAPACITY),
                    last_kit_delivery,
                    split_turn: s[7] == 1,
                    inv,
                    ..Cell::default()
                },
            );
            if data[0] < 6 {
                w.add_legacy_cargo(i, s[8] as u8, s[18] as u16)?;
            }
        }
        if data[0] < 7 {
            w.progression.legacy_full_bounds = w
                .cells
                .iter()
                .enumerate()
                .any(|(tile, c)| (c.kind != 0 || c.wire) && !w.progression.contains(tile));
        }
        if data[0] >= 6 {
            let rest = &data[SAVE_WORDS..];
            let transport_size = w.transport_save_length(rest)?;
            let (transport, current) = rest.split_at(transport_size);
            let rest = if data[0] >= 7 {
                w.read_progression_save(current)?
            } else {
                current
            };
            if w.cells.iter().enumerate().any(|(tile, c)| {
                (c.kind != 0 || c.wire)
                    && (!w.progression.contains(tile)
                        || w.progression.tier == 0
                            && matches!(
                                c.kind,
                                EXPRESS_BELT | ULTRA_BELT | REINFORCED_IRON_DRILL
                                    ..=REINFORCED_FUEL_DRILL | REINFORCED_COPPER_DRILL
                            ))
            }) {
                return None;
            }
            let rest = w.read_saved_devices(rest, true)?;
            let rest = if version >= RECIPE_SAVE_VERSION {
                w.read_recipe_save(rest)?
            } else {
                rest
            };
            let rest = if version == SAVE_VERSION {
                w.read_ground_save(rest)?
            } else {
                rest
            };
            w.read_transport_save(transport, legacy_clock)?;
            w.blueprints = blueprints::Library::read_save(rest)?;
            w.update_grids();
        } else {
            for &cargo in &w.cargo {
                w.valid_source(cargo)?;
            }
            w.rebuild_footprints()?;
            w.rebuild();
            if data[0] == 5 {
                let rest = w.read_saved_devices(&data[SAVE_WORDS..], false)?;
                w.blueprints = blueprints::Library::read_save(rest)?;
            }
        }
        Some(w)
    }
}
