use crate::belts::{Belts, Cargo};
use crate::catalog::*;

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
    pub last_make: u32,
    pub split_turn: bool,
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
    pub orbiting: bool,
    pub launch_left: u32,
    pub mode: u8,
    pub time_left: u32,
    pub first_light: bool,
    pub fault: u8,
    pub fault_at: u32,
    pub sun_until: u32,
    pub next_window: u32,
    pub complete: bool,
}

pub struct World {
    pub tick: u32,
    pub stock: [u32; ITEMS],
    pub delivered: u32,
    pub kit_total: u32,
    pub cells: Vec<Cell>,
    pub belt: Belts,
    pub cargo: Vec<Cargo>,
    pub grids: Vec<Grid>,
    pub machines: Vec<usize>,
    pub orbit: Orbit,
    pub active_blocks: u32,
}

impl World {
    pub fn empty() -> Self {
        let cells = vec![Cell::default(); N];
        let cargo = vec![Cargo::default(); N];
        let belt = Belts::rebuild(&cells, &cargo, 0, false);
        Self {
            tick: 0,
            stock: [0; ITEMS],
            delivered: 0,
            kit_total: 0,
            cells,
            belt,
            cargo,
            grids: Vec::new(),
            machines: Vec::new(),
            orbit: Orbit::default(),
            active_blocks: 0,
        }
    }

    pub fn new() -> Self {
        let mut w = Self::empty();
        w.stock[PLATE as usize] = 42;
        for (x, y, kind, dir) in [
            (5, 7, FUEL_DRILL, 0),
            (15, 7, GENERATOR, 0),
            (5, 13, IRON_DRILL, 0),
            (10, 13, SMELTER, 0),
            (20, 13, DEPOT, 0),
            (5, 20, SILICA_DRILL, 0),
            (13, 20, GRINDER, 0),
            (15, 24, CALIBRATOR, 0),
            (23, 15, ASSEMBLER, 0),
            (33, 15, STATION, 0),
            (22, 28, KIT_PRESS, 0),
            (24, 28, DEPOT, 0),
            (19, 28, IRON_DRILL, 0),
            (21, 28, SMELTER, 0),
            (33, 11, SOLAR, 0),
            (10, 7, SPLITTER, 0),
            (16, 13, SPLITTER, 0),
            (10, 20, SPLITTER, 0),
        ] {
            w.cells[index(x, y)] = Cell {
                kind,
                dir,
                ..Cell::default()
            };
        }
        w.cells[index(10, 7)].cfg = 1;
        w.cells[index(15, 7)].inv[FUEL as usize] = 6;
        w.cells[STATION_POS].cfg = 2;
        for (x1, x2, y) in [
            (6, 9, 7),
            (11, 14, 7),
            (6, 7, 13),
            (9, 9, 13),
            (11, 15, 13),
            (17, 19, 13),
            (17, 22, 15),
            (24, 32, 15),
            (6, 9, 20),
            (11, 12, 20),
            (14, 22, 20),
            (11, 14, 24),
            (16, 32, 24),
            (11, 32, 10),
        ] {
            for x in x1..=x2 {
                w.set_belt(x, y, 0);
            }
        }
        for (x, y, dir) in [
            (10, 8, 1),
            (10, 9, 1),
            (10, 10, 0),
            (33, 10, 1),
            (33, 12, 1),
            (33, 13, 1),
            (33, 14, 1),
            (16, 14, 1),
            (16, 15, 0),
            (10, 21, 1),
            (10, 22, 1),
            (10, 23, 1),
            (10, 24, 0),
            (23, 20, 3),
            (23, 19, 3),
            (23, 18, 3),
            (23, 17, 3),
            (23, 16, 3),
            (33, 24, 0),
            (34, 24, 3),
            (34, 15, 2),
            (20, 28, 0),
            (23, 28, 0),
            (22, 28, 0),
        ] {
            if w.cells[index(x, y)].kind == 0 {
                w.set_belt(x, y, dir);
            }
        }
        for y in 16..24 {
            w.set_belt(34, y, 3);
        }

        // The silicon and fuel branches go around the optics line and receiver.
        w.cells[index(33, 11)].kind = 0;
        w.set_belt(33, 11, 1);
        w.cells[index(35, 13)].kind = SOLAR;
        // Finished plates go from the smelter straight into its adjacent kit press.
        for (x1, x2, y) in [
            (5, 15, 7),
            (5, 23, 13),
            (5, 23, 20),
            (15, 34, 15),
            (10, 35, 24),
            (15, 24, 28),
            (33, 35, 13),
        ] {
            for x in x1..=x2 {
                w.cells[index(x, y)].wire = true;
            }
        }
        for y in 7..=28 {
            w.cells[index(15, y)].wire = true;
        }
        for y in 13..=24 {
            w.cells[index(33, y)].wire = true;
        }
        w.rebuild(false);
        w
    }

    fn set_belt(&mut self, x: usize, y: usize, dir: u8) {
        let cell = &mut self.cells[index(x, y)];
        cell.kind = BELT;
        cell.dir = dir;
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

    fn transfer_in(&mut self, i: usize, item: u8, pulse: u32) -> bool {
        let kind = self.cells[i].kind;
        if is_belt(kind) {
            return self.belt.entry[i]
                .is_some_and(|entry| self.belt.segments[entry].push(item, pulse));
        }
        let item = item as usize;
        if kind == DEPOT {
            if self.cells[i].cfg != 0 {
                return false;
            }
            self.stock[item] = self.stock[item].saturating_add(1);
            if item == PLATE as usize {
                self.delivered = self.delivered.saturating_add(1);
            }
            if item == KIT as usize {
                self.kit_total = self.kit_total.saturating_add(1);
            }
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
            if outputs
                .into_iter()
                .flatten()
                .any(|next| self.transfer_in(next, cargo.item, pulse))
            {
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
            if c.kind == DEPOT && c.cfg > 0 {
                let item = c.cfg as usize;
                if self.stock[item] > 0
                    && self.cells[next].kind != DEPOT
                    && self.transfer_in(next, c.cfg, pulse)
                {
                    self.stock[item] -= 1;
                }
            } else if let Some(r) = recipe(c.kind) {
                if c.inv[r.output as usize] > 0 && self.transfer_in(next, r.output, pulse) {
                    self.cells[i].inv[r.output as usize] -= 1;
                }
            }
        }
    }

    pub fn step(&mut self) {
        self.tick += 1;
        if self.tick % BELT_TICKS == 0 {
            self.move_cargo();
        }
        if self.orbit.next_window > 0 && self.tick >= self.orbit.next_window {
            self.orbit.next_window = 0;
            self.orbit.mode = 1;
            self.orbit.time_left = COUNTDOWN;
        }
        self.grids.fill(Grid::default());
        let sun = self.tick < self.orbit.sun_until;
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
                SOLAR if sun && cell.group != 0 => {
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
                    let need = if self.orbit.mode == 2 {
                        120
                    } else if self.orbit.launch_left > 0 {
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
                if c.inv[r.output as usize] + r.amount > 5 {
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
                if !take_power(grid, c.group, u32::from(r.power)) {
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
                c.last_make = self.tick;
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
        self.active_blocks = self
            .machines
            .iter()
            .filter(|&&i| {
                let c = self.cells[i];
                c.kind == KIT_PRESS
                    && c.group > 0
                    && c.last_make > 0
                    && self.tick.saturating_sub(c.last_make) < 20 * HZ
            })
            .count() as u32;
        if self.active_blocks >= 4 && self.orbit.first_light && self.kit_total >= 12 {
            self.orbit.complete = true;
        }
    }

    fn advance_orbit(&mut self) {
        let station = &mut self.cells[STATION_POS];
        if self.orbit.launch_left > 0 && station.status == 1 {
            self.orbit.launch_left -= 1;
            if self.orbit.launch_left == 0 {
                self.orbit.orbiting = true;
            }
        }
        if self.orbit.mode == 1 {
            self.orbit.time_left -= 1;
            if self.orbit.time_left == 0 {
                self.orbit.mode = 2;
                self.orbit.time_left = WINDOW;
            }
        } else if self.orbit.mode == 2 {
            let needs_core = (WINDOW - self.orbit.time_left) % HZ == 0;
            if station.status != 1 || (needs_core && station.inv[CORE as usize] == 0) {
                self.orbit.fault = if station.status != 1 { 1 } else { 2 };
                self.orbit.fault_at = WINDOW - self.orbit.time_left;
                self.orbit.mode = 4;
                return;
            }
            if needs_core {
                station.inv[CORE as usize] -= 1;
            }
            self.orbit.time_left -= 1;
            if self.orbit.time_left == 0 {
                self.orbit.mode = 3;
                self.orbit.first_light = true;
                self.orbit.sun_until = self.tick + HZ * 20;
                self.orbit.next_window = self.tick + HZ * 45;
            }
        }
    }

    pub fn launch(&mut self) -> i32 {
        if self.orbit.orbiting || self.orbit.launch_left > 0 {
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

    pub fn trial(&mut self) -> i32 {
        if !self.orbit.orbiting || matches!(self.orbit.mode, 1 | 2) {
            return -6;
        }
        self.orbit.fault = 0;
        self.orbit.next_window = 0;
        self.orbit.mode = 1;
        self.orbit.time_left = COUNTDOWN;
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
