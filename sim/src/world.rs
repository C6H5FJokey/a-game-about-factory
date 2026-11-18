use crate::belts::{Belts, Cargo};
use crate::campaign::Stage;
use crate::catalog::*;
use crate::regions::*;

#[derive(Clone, Copy, Default)]
pub struct Cell {
    pub kind: u8,
    pub dir: u8,
    pub wire: bool,
    pub cfg: u8,
    pub status: u8,
    pub group: u16,
    pub progress: u16,
    pub energy: u32,
    pub inv: [u16; ITEMS],
    pub last_kit_delivery: u32,
    pub split_turn: bool,
}

impl Cell {
    pub fn delivering_kits(&self, tick: u32) -> bool {
        self.kind == KIT_PRESS
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
    pub stage: Stage,
    pub packed_miners: u16,
    pub stock: [u32; ITEMS],
    pub delivered: u32,
    pub kit_total: u32,
    pub cells: Vec<Cell>,
    pub belt: Belts,
    pub cargo: Vec<Cargo>,
    pub grids: Vec<Grid>,
    pub machines: Vec<usize>,
    pub orbit: Orbit,
    pub routes: [Route; 2],
}

impl World {
    pub fn empty() -> Self {
        let cells = vec![Cell::default(); N];
        let cargo = vec![Cargo::default(); N];
        let belt = Belts::rebuild(&cells, &cargo, 0, false);
        Self {
            tick: 0,
            stage: Stage::Gather,
            packed_miners: 0,
            stock: [0; ITEMS],
            delivered: 0,
            kit_total: 0,
            cells,
            belt,
            cargo,
            grids: Vec::new(),
            machines: Vec::new(),
            orbit: Orbit::default(),
            routes: [Route::default(); 2],
        }
    }

    pub fn new() -> Self {
        let mut w = Self::empty();
        w.update_grids();
        w
    }

    pub fn rebuild(&mut self, preserve_ready: bool) {
        self.belt = Belts::rebuild(
            &self.cells,
            &self.cargo,
            self.tick / BELT_TICKS,
            preserve_ready,
        );
        self.update_grids();
    }

    pub fn update_grids(&mut self) {
        self.grids.clear();
        self.grids.push(Grid::default());
        self.machines.clear();
        for (i, cell) in self.cells.iter_mut().enumerate() {
            cell.group = 0;
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
    }

    pub fn materialize(&mut self) {
        self.belt
            .materialize(self.tick / BELT_TICKS, &mut self.cargo);
    }

    pub fn active_blocks(&self) -> usize {
        self.machines
            .iter()
            .filter(|&&i| self.cells[i].delivering_kits(self.tick))
            .count()
    }

    pub(crate) fn transfer_in(&mut self, i: usize, cargo: Cargo, pulse: u32) -> bool {
        let kind = self.cells[i].kind;
        if is_belt(kind) {
            return self.belt.entry[i]
                .is_some_and(|entry| self.belt.segments[entry].push(cargo, pulse));
        }
        let item = cargo.item as usize;
        if kind == DEPOT {
            if self.cells[i].cfg != 0 {
                return false;
            }
            self.stock[item] = self.stock[item].saturating_add(1);
            if item == PLATE as usize && cargo.source != 0 {
                self.delivered = self.delivered.saturating_add(1);
            }
            if item == KIT as usize && cargo.source != 0 {
                self.kit_total = self.kit_total.saturating_add(1);
                if let Some(press) = self.cells.get_mut(usize::from(cargo.source) - 1) {
                    press.last_kit_delivery = self.tick;
                }
            }
            return true;
        }
        if kind == FREIGHT_YARD && SENDERS.contains(&i) {
            if self.cells[i].inv.iter().sum::<u16>() >= YARD_CAPACITY {
                return false;
            }
            self.cells[i].inv[item] += 1;
            return true;
        }
        let cap = match kind {
            STATION if item == CORE as usize => 16,
            STATION if item == MIRROR as usize => 6,
            STATION if item == FUEL as usize => 12,
            GENERATOR if item == FUEL as usize => 8,
            _ if recipe(kind).is_some_and(|r| {
                r.input
                    .iter()
                    .any(|&(id, count)| id as usize == item && count > 0)
            }) =>
            {
                10
            }
            _ => 0,
        };
        if self.cells[i].inv[item] >= cap {
            return false;
        }
        self.cells[i].inv[item] += 1;
        true
    }

    fn move_cargo(&mut self) {
        let pulse = self.tick / BELT_TICKS;
        for order in 0..self.belt.downstream_first.len() {
            let id = self.belt.downstream_first[order];
            let segment = &self.belt.segments[id];
            let Some(cargo) = segment
                .queue
                .front()
                .copied()
                .filter(|cargo| cargo.ready <= pulse)
            else {
                continue;
            };
            let tail = *segment.tiles.last().unwrap();
            let mut outputs = segment.exits;
            if self.cells[tail].kind == SPLITTER
                && self.cells[tail].cfg == 0
                && self.cells[tail].split_turn
            {
                outputs.swap(0, 1);
            }
            if outputs.into_iter().flatten().any(|next| {
                if !self.transfer_in(next, cargo, pulse) {
                    return false;
                }
                if self.stage == Stage::Belt && self.cells[next].kind == BENCH && cargo.item == IRON
                {
                    self.stage = Stage::BeltFed;
                }
                true
            }) {
                self.belt.segments[id].queue.pop_front();
                self.cells[tail].split_turn = !self.cells[tail].split_turn;
            }
        }
        for order in 0..self.machines.len() {
            let i = self.machines[order];
            let c = self.cells[i];
            let Some(next) = neighbor(i, c.dir) else {
                continue;
            };
            if c.kind == FREIGHT_YARD {
                if let Some(line) = RECEIVERS.iter().position(|&tile| tile == i) {
                    if let Some(item) = c.inv.iter().position(|&count| count > 0) {
                        let cargo = Cargo {
                            item: item as u8,
                            ..Default::default()
                        };
                        if self.transfer_in(next, cargo, pulse) {
                            self.cells[i].inv[item] -= 1;
                            self.routes[line].delivered =
                                self.routes[line].delivered.saturating_add(1);
                        }
                    }
                }
            } else if c.kind == DEPOT && c.cfg > 0 {
                let item = c.cfg as usize;
                let cargo = Cargo {
                    item: c.cfg,
                    ..Cargo::default()
                };
                if self.stock[item] > 0
                    && self.cells[next].kind != DEPOT
                    && self.transfer_in(next, cargo, pulse)
                {
                    self.stock[item] -= 1;
                }
            } else if let Some(r) = recipe(c.kind) {
                let cargo = Cargo {
                    item: r.output,
                    source: if matches!(r.output, KIT | PLATE) {
                        i as u16 + 1
                    } else {
                        0
                    },
                    ..Cargo::default()
                };
                if self.stage >= Stage::Belt
                    && c.inv[r.output as usize] > 0
                    && self.transfer_in(next, cargo, pulse)
                {
                    self.cells[i].inv[r.output as usize] -= 1;
                    if self.stage == Stage::Belt
                        && c.kind == SIMPLE_MINER
                        && self.cells[next].kind == BENCH
                    {
                        self.stage = Stage::BeltFed;
                    }
                }
            }
        }
    }

    pub fn step(&mut self) {
        self.tick += 1;
        if self.stage >= Stage::Valley {
            self.run_freight();
        }
        if self.tick % BELT_TICKS == 0 {
            self.move_cargo();
        }
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
            match cell.kind {
                GENERATOR => {
                    if cell.progress == 0 && cell.group != 0 && cell.inv[FUEL as usize] > 0 {
                        cell.inv[FUEL as usize] -= 1;
                        cell.progress = 25;
                    }
                    if cell.progress > 0 && cell.group != 0 {
                        cell.progress -= 1;
                        grid.generation += 108;
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
                    grid.generation += 55;
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
                        TRACKING_POWER[city]
                    } else if self.orbit.launch_left > 0 && i == STATION_POS {
                        85
                    } else {
                        0
                    };
                    if need != 0 {
                        c.status = if take_power(grid, c.group, need) {
                            1
                        } else {
                            3
                        };
                    }
                    continue;
                }
                let Some(r) = recipe(c.kind) else {
                    continue;
                };
                if c.kind == KIT_PRESS && !self.orbit.first_light {
                    c.status = 5;
                    continue;
                }
                let cap = if c.kind == SIMPLE_MINER {
                    MINER_CAPACITY
                } else {
                    5
                };
                if c.inv[r.output as usize] + r.amount > cap {
                    c.status = 4;
                    continue;
                }
                if r.input
                    .iter()
                    .any(|&(id, count)| c.inv[id as usize] < count)
                {
                    c.status = 2;
                    continue;
                }
                if r.power > 0 && !take_power(grid, c.group, u32::from(r.power)) {
                    c.status = 3;
                    continue;
                }
                c.status = 1;
                c.progress += 1;
                if c.progress < r.ticks {
                    continue;
                }
                for (id, count) in r.input {
                    c.inv[id as usize] -= count;
                }
                c.inv[r.output as usize] += r.amount;
                c.progress = 0;
                self.stage = self.stage.after_production(c.kind);
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
                grid.discharged += delta;
            } else {
                let delta = (changes as u32)
                    .min(BATTERY_POWER as u32)
                    .min(BATTERY_CAPACITY - c.energy);
                c.energy += delta;
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
