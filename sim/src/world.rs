use crate::belts::{Belts, Cargo, NODES};
use crate::blueprints::Library;
use crate::campaign::Stage;
use crate::catalog::*;
use crate::footprints::{covered, Footprints};
use crate::ground::Ground;
use crate::progression::{cycle_ticks, Progression};
use crate::recipes::device_recipe;
use crate::regions::*;

pub const FUEL_STEPS_PER_TICK: u32 = 2;
const FUEL_BURN_STEPS: u32 = HZ * FUEL_STEPS_PER_TICK * 5 / 4;

#[derive(Clone, Copy, Default)]
pub struct Cell {
    pub kind: u8,
    pub identity: i32,
    pub dir: u8,
    pub wire: bool,
    pub cfg: u8,
    pub status: u8,
    pub group: u16,
    pub progress: u32,
    pub selected_recipe: u16,
    pub belt_iron: u16,
    pub belt_batch: bool,
    pub energy: u32,
    pub inv: [u16; ITEMS],
    pub last_kit_delivery: u32,
    pub split_turn: bool,
    pub power: DevicePower,
}

#[derive(Clone, Copy, Default)]
pub struct DevicePower {
    pub demand: u16,
    pub used: u16,
    pub generated: u16,
    pub charged: u16,
    pub discharged: u16,
}

impl Cell {
    pub fn delivering_kits(&self, tick: u32) -> bool {
        matches!(self.kind, KIT_PRESS | SPLICER)
            && self.group != 0
            && self.last_kit_delivery > 0
            && tick - self.last_kit_delivery < DELIVERY_WINDOW
    }
}

#[derive(Clone, Copy, Default)]
pub struct Grid {
    pub generation: u32,
    pub demand: u32,
    pub used: u32,
    pub discharge: u32,
    pub stored: u32,
    pub charged: u32,
    pub discharged: u32,
}

#[derive(Default)]
pub struct Orbit {
    pub modules: u8,
    pub target: u8,
    pub program: u8,
    pub rounds: u8,
    pub lit: u8,
    pub fault_city: u8,
    pub orbiting: bool,
    pub launch_left: u32,
    pub mode: u8,
    pub time_left: u32,
    pub first_light: bool,
    pub fault: u8,
    pub fault_at: u32,
    pub sun_until: u32,
    pub sun_city: u8,
    pub next_window: u32,
    pub complete: bool,
}

pub struct World {
    pub tick: u32,
    pub legacy_recipes: bool,
    pub handcraft: Option<(usize, i32, u32)>,
    pub ground: Ground,
    pub stage: Stage,
    pub progression: Progression,
    pub packed_miners: u16,
    pub stock: [u32; ITEMS],
    pub delivered: u32,
    pub kit_total: u32,
    pub cells: Vec<Cell>,
    pub footprints: Footprints,
    pub belt: Belts,
    pub cargo: Vec<Cargo>,
    pub grids: Vec<Grid>,
    pub machines: Vec<usize>,
    pub orbit: Orbit,
    pub routes: [Route; 2],
    pub next_device_id: i32,
    pub blueprints: Library,
    pub next_cargo_id: i32,
    pub layout_revision: i32,
}

impl World {
    pub fn empty() -> Self {
        let cells = vec![Cell::default(); N];
        let cargo = vec![Cargo::default(); NODES];
        let belt = Belts::rebuild(&cells, &cargo, None, &[], true);
        Self {
            tick: 0,
            legacy_recipes: true,
            handcraft: None,
            ground: Ground::default(),
            stage: Stage::Gather,
            progression: Progression::default(),
            packed_miners: 0,
            stock: [0; ITEMS],
            delivered: 0,
            kit_total: 0,
            cells,
            footprints: Footprints::new(),
            belt,
            cargo,
            grids: Vec::new(),
            machines: Vec::new(),
            orbit: Orbit::default(),
            routes: [Route::default(); 2],
            next_device_id: 1,
            blueprints: Library::default(),
            next_cargo_id: 1,
            layout_revision: 0,
        }
    }

    pub fn new() -> Self {
        let mut w = Self::empty();
        w.legacy_recipes = false;
        w.update_grids();
        w
    }

    pub fn install(&mut self, tile: usize, mut cell: Cell) {
        if cell.kind != 0 {
            cell.identity = self.next_device_id;
            self.next_device_id += 1;
        }
        self.cells[tile] = cell;
    }

    pub fn spend(&mut self, materials: &[(u8, u32)], copies: u32) -> bool {
        if materials
            .iter()
            .any(|&(item, count)| self.stock[item as usize] < count * copies)
        {
            return false;
        }
        for &(item, count) in materials {
            self.stock[item as usize] -= count * copies;
        }
        true
    }

    pub fn rebuild(&mut self) {
        self.rebuild_footprints()
            .expect("validated device footprints");
        self.belt = Belts::rebuild(
            &self.cells,
            &self.cargo,
            Some(&self.belt),
            &self.footprints.outlets,
            self.legacy_recipes,
        );
        self.layout_revision = self.layout_revision.wrapping_add(1);
        self.update_grids();
    }

    pub fn update_grids(&mut self) {
        self.grids.clear();
        self.grids.push(Grid::default());
        self.machines.clear();
        for (i, cell) in self.cells.iter_mut().enumerate() {
            cell.group = 0;
            cell.power = DevicePower::default();
            if cell.kind != 0 && !is_belt(cell.kind) {
                self.machines.push(i);
            }
        }
        let mut pending = Vec::new();
        for start in 0..N {
            if !self.cells[start].wire || self.cells[start].group != 0 {
                continue;
            }
            let group = self.grids.len() as u16;
            self.grids.push(Grid::default());
            self.cells[start].group = group;
            pending.push(start);
            while let Some(tile) = pending.pop() {
                for dir in 0..4 {
                    let Some(next) = neighbor(tile, dir) else {
                        continue;
                    };
                    if self.cells[next].wire && self.cells[next].group == 0 {
                        self.cells[next].group = group;
                        pending.push(next);
                    }
                }
            }
        }
        for &anchor in &self.machines {
            let c = self.cells[anchor];
            if c.group == 0 {
                self.cells[anchor].group = covered(anchor, c.kind, c.dir)
                    .unwrap()
                    .map(|tile| self.cells[tile].group)
                    .find(|&group| group != 0)
                    .unwrap_or(0);
            }
        }
    }

    pub fn materialize(&mut self) {
        self.belt.materialize(&mut self.cargo);
    }

    pub fn active_blocks(&self) -> usize {
        self.machines
            .iter()
            .filter(|&&i| self.cells[i].delivering_kits(self.tick))
            .count()
    }

    pub fn step(&mut self) {
        self.tick += 1;
        if self.stage >= Stage::Valley {
            self.run_freight();
        }
        self.move_cargo();
        if self.orbit.next_window > 0
            && self.tick >= self.orbit.next_window
            && self.orbit.launch_left == 0
        {
            self.orbit.next_window = 0;
            self.orbit.target = 0;
            self.orbit.program = SOLO;
            self.orbit.mode = 1;
            self.orbit.time_left = COUNTDOWN;
        }
        self.grids.fill(Grid::default());
        let beam = self.beam_x100();
        for &i in &self.machines {
            let cell = &mut self.cells[i];
            let grid = &mut self.grids[cell.group as usize];
            cell.status = 0;
            cell.power = DevicePower::default();
            match cell.kind {
                GENERATOR if cell.group != 0 => {
                    // Fuel is tracked in half steps so a unit still burns for 1.25 seconds.
                    if cell.progress < FUEL_STEPS_PER_TICK && cell.inv[FUEL as usize] > 0 {
                        cell.inv[FUEL as usize] -= 1;
                        cell.progress += FUEL_BURN_STEPS;
                    }
                    let burn = cell.progress.min(FUEL_STEPS_PER_TICK);
                    if burn > 0 {
                        cell.progress -= burn;
                        let generated = u32::from(GENERATOR_POWER) * burn / FUEL_STEPS_PER_TICK;
                        cell.power.generated = generated as u16;
                        grid.generation += generated;
                        cell.status = 1;
                    } else {
                        cell.status = if cell.group == 0 { 3 } else { 2 };
                    }
                }
                SOLAR
                    if beam >= 0
                        && ((i % W) as i32 * 100 + 50 - beam).abs() <= 450
                        && cell.group != 0 =>
                {
                    cell.power.generated = SOLAR_POWER;
                    grid.generation += u32::from(cell.power.generated);
                    cell.status = 1;
                }
                SOLAR => {
                    cell.status = if cell.group == 0 { 3 } else { 5 };
                }
                BATTERY if cell.group != 0 => {
                    grid.discharge += cell.energy.min(BATTERY_POWER as u32);
                }
                BATTERY => {
                    cell.status = 3;
                }
                _ => {}
            }
        }

        for priority in (0..=2).rev() {
            for &i in &self.machines {
                let c = &mut self.cells[i];
                if c.cfg != priority {
                    continue;
                }
                let grid = &mut self.grids[c.group as usize];
                if c.kind == STATION {
                    let city = self.orbit.target as usize;
                    let need = if self.orbit.mode == 2 && i == STATIONS[city] {
                        TRACKING_POWER[city] as u16
                    } else if self.orbit.launch_left > 0 && i == STATION_POS {
                        LAUNCH_POWER
                    } else {
                        0
                    };
                    if need != 0 {
                        c.power.demand = need;
                        c.status = if take_power(grid, c.group, need.into()) {
                            c.power.used = need;
                            1
                        } else {
                            3
                        };
                    }
                    continue;
                }
                let Some(r) = device_recipe(c, self.legacy_recipes) else {
                    if !self.legacy_recipes && PROCESSING[c.kind as usize] {
                        c.status = 6;
                    }
                    continue;
                };
                if c.kind == KIT_PRESS && !self.orbit.first_light {
                    c.status = 5;
                    continue;
                }
                let cap = output_capacity(c.kind);
                if c.inv[r.output as usize] + r.amount > cap {
                    c.status = 4;
                    continue;
                }
                if c.progress == 0
                    && r.input
                        .iter()
                        .any(|&(id, count)| c.inv[id as usize] < count)
                {
                    c.status = 2;
                    continue;
                }
                c.power.demand = r.power;
                if r.power > 0 && !take_power(grid, c.group, u32::from(r.power)) {
                    c.status = 3;
                    continue;
                }
                c.status = 1;
                c.power.used = r.power;
                if c.progress == 0 {
                    for (id, count) in r.input {
                        if id == IRON_INGOT && c.belt_iron > 0 {
                            let from_belt = count.saturating_sub(c.inv[id as usize] - c.belt_iron);
                            c.belt_iron -= from_belt;
                            c.belt_batch = from_belt > 0;
                        }
                        c.inv[id as usize] -= count;
                    }
                }
                c.progress += 1;
                if c.progress < cycle_ticks(r.ticks, c.inv[SPEED_MODULE as usize]) {
                    continue;
                }
                c.inv[r.output as usize] += r.amount;
                c.progress = 0;
                self.stage = if self.legacy_recipes {
                    self.stage.after_production(c.kind)
                } else {
                    self.stage
                        .after_selected_production(c.kind, r.output, c.belt_batch)
                };
                c.belt_batch = false;
            }
        }

        for &i in &self.machines {
            let c = &mut self.cells[i];
            if c.kind != BATTERY || c.group == 0 {
                continue;
            }
            let grid = &mut self.grids[c.group as usize];
            let changes =
                (grid.generation + grid.discharged) as i32 - (grid.used + grid.charged) as i32;
            if changes < 0 {
                let delta = (-changes as u32).min(BATTERY_POWER as u32).min(c.energy);
                c.energy -= delta;
                c.power.discharged = delta as u16;
                grid.discharged += delta;
            } else {
                let delta = (changes as u32)
                    .min(BATTERY_POWER as u32)
                    .min(BATTERY_CAPACITY - c.energy);
                c.energy += delta;
                c.power.charged = delta as u16;
                // Charge only from unspent generation, after all machine loads.
                grid.charged += delta;
            }
            grid.stored += c.energy;
            c.status = 1;
        }
        self.advance_orbit();
        if !self.orbit.complete
            && self.orbit.first_light
            && self.kit_total >= REQUIRED_KITS
            && self.active_blocks() >= REQUIRED_BLOCKS
        {
            self.orbit.complete = true;
            self.stage = Stage::Valley;
            self.orbit.next_window = 0;
        }
    }

    fn advance_orbit(&mut self) {
        if self.orbit.launch_left > 0 && self.cells[STATION_POS].status == 1 {
            self.orbit.launch_left -= 1;
            if self.orbit.launch_left == 0 {
                self.orbit.orbiting = true;
                self.orbit.modules += 1;
                self.stage = self.stage.max(Stage::Tracking);
            }
        }
        let city = self.orbit.target as usize;
        let station = &mut self.cells[STATIONS[city]];
        if self.orbit.mode == 1 {
            self.orbit.time_left -= 1;
            if self.orbit.time_left == 0 {
                self.orbit.mode = 2;
                self.orbit.time_left = WINDOW_LENGTH[city];
            }
        } else if self.orbit.mode == 2 {
            let elapsed = WINDOW_LENGTH[city] - self.orbit.time_left;
            let needs_core = elapsed % HZ == 0;
            if station.status != 1 || (needs_core && station.inv[CORE as usize] == 0) {
                self.orbit.fault = if station.status != 1 { 1 } else { 2 };
                self.orbit.fault_at = elapsed;
                self.orbit.fault_city = city as u8;
                self.orbit.mode = 4;
                return;
            }
            if needs_core {
                station.inv[CORE as usize] -= 1;
            }
            self.orbit.time_left -= 1;
            if self.orbit.time_left == 0 {
                self.finish_window();
            }
        }
    }

    pub fn launch(&mut self) -> i32 {
        let allowed = if self.stage >= Stage::Highland {
            3
        } else if self.stage >= Stage::Valley {
            2
        } else {
            1
        };
        if self.stage < Stage::Launch
            || self.orbit.modules >= allowed
            || self.orbit.launch_left > 0
            || matches!(self.orbit.mode, 1 | 2)
        {
            return -6;
        }
        let station = &mut self.cells[STATION_POS];
        if station.inv[MIRROR as usize] < 3 || station.inv[FUEL as usize] < 5 {
            return -7;
        }
        station.inv[MIRROR as usize] -= 3;
        station.inv[FUEL as usize] -= 5;
        self.orbit.launch_left = LAUNCH_TICKS;
        1
    }
}

fn take_power(grid: &mut Grid, group: u16, need: u32) -> bool {
    grid.demand += need;
    if group == 0 || grid.used + need > grid.generation + grid.discharge {
        return false;
    }
    grid.used += need;
    true
}
