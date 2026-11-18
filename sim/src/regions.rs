use crate::campaign::Stage;
use crate::catalog::*;
use crate::world::{Cell, World};

pub const HEADWAY: u32 = 12 * HZ;
pub const TRAVEL: u32 = 4 * HZ;
pub const CRATE_SIZE: u16 = 16;
pub const YARD_CAPACITY: u16 = 32;
pub const LINE_COST: u32 = 8;
pub const WINDOW_LENGTH: [u32; 3] = [WINDOW, 12 * HZ, 12 * HZ];
pub const TRACKING_POWER: [u32; 3] = [120, 110, 135];
pub const WINDOW_GAP: [u32; 3] = [8 * HZ, 3 * HZ, 12 * HZ];
pub const SOLO: u8 = 0;
pub const ADJACENT: u8 = 1;
pub const CAMPAIGN: u8 = 2;
pub const ROUTE_WORDS: usize = 2 + ITEMS;

#[derive(Clone, Copy, Default)]
pub struct Route {
    pub arrival: u32,
    pub crate_stock: [u16; ITEMS],
    pub delivered: u32,
}

pub fn reserve(city: usize) -> (u16, u32) {
    // Supply the first quarter of the next window from local stores.
    let ticks = WINDOW_LENGTH[city] / 4;
    (
        (ticks / HZ) as u16,
        ticks * TRACKING_POWER[city].saturating_sub(108),
    )
}

impl World {
    pub fn beam_x100(&self) -> i32 {
        if self.tick >= self.orbit.sun_until {
            return -1;
        }
        let elapsed = 20 * HZ - (self.orbit.sun_until - self.tick).min(20 * HZ);
        let (start, end) = match self.orbit.sun_city {
            0 => (1400, 4550),
            1 => (3000, 4900),
            _ => (3000, 650),
        };
        start + (end - start) * elapsed as i32 / (20 * HZ) as i32
    }
    pub fn city_known(&self, city: usize) -> bool {
        city < 3 && self.stage >= [Stage::Launch, Stage::Valley, Stage::Highland][city]
    }

    pub fn open_line(&mut self, city: usize) -> i32 {
        if city == 0 || !self.city_known(city) {
            return -6;
        }
        let i = city - 1;
        if [SENDERS[i], RECEIVERS[i]]
            .iter()
            .any(|&tile| self.cells[tile].kind != 0)
        {
            return -2;
        }
        if self.stock[PLATE as usize] < LINE_COST {
            return -4;
        }
        self.materialize();
        self.stock[PLATE as usize] -= LINE_COST;
        for tile in [SENDERS[i], RECEIVERS[i]] {
            self.cells[tile] = Cell {
                kind: FREIGHT_YARD,
                wire: self.cells[tile].wire,
                ..Default::default()
            };
        }
        self.rebuild(false);
        1
    }

    pub fn run_freight(&mut self) {
        for i in 0..2 {
            if self.cells[SENDERS[i]].kind != FREIGHT_YARD {
                continue;
            }
            let route = &mut self.routes[i];
            if route.arrival == 0 && self.tick % HEADWAY == 0 {
                let sender = &mut self.cells[SENDERS[i]];
                let mut space = CRATE_SIZE;
                for (slot, stored) in route.crate_stock.iter_mut().zip(&mut sender.inv).skip(1) {
                    let count = space.min(*stored);
                    *slot = count;
                    *stored -= count;
                    space -= count;
                }
                if space < CRATE_SIZE {
                    route.arrival = self.tick + TRAVEL;
                }
            }
            if route.arrival != 0 && self.tick >= route.arrival && self.tick % BELT_TICKS == 0 {
                let receiver = &mut self.cells[RECEIVERS[i]];
                if receiver.inv.iter().sum::<u16>() < YARD_CAPACITY {
                    if let Some(item) = route.crate_stock.iter().position(|&count| count > 0) {
                        route.crate_stock[item] -= 1;
                        receiver.inv[item] += 1;
                    }
                    if route.crate_stock.iter().all(|&v| v == 0) {
                        route.arrival = 0;
                    }
                }
            }
        }
    }

    pub fn regional_window(&mut self, city: usize, program: u8) -> i32 {
        if !self.city_known(city)
            || program > CAMPAIGN
            || self.orbit.launch_left > 0
            || matches!(self.orbit.mode, 1 | 2)
        {
            return -6;
        }
        let last = if program == SOLO { city } else { 2 };
        if (program == ADJACENT && (city != 1 || self.stage < Stage::Highland))
            || (program == CAMPAIGN && (city != 0 || self.stage < Stage::Acceptance))
        {
            return -6;
        }
        if self.orbit.modules as usize <= last {
            return -10;
        }
        for n in city..=last {
            if self.cells[STATIONS[n]].kind != STATION
                || (n > 0 && self.routes[n - 1].delivered == 0)
            {
                return -11;
            }
        }
        let o = &mut self.orbit;
        o.program = program;
        o.target = city as u8;
        o.fault = 0;
        o.next_window = 0;
        if program == CAMPAIGN {
            o.rounds = 0
        }
        o.mode = 1;
        o.time_left = COUNTDOWN;
        1
    }

    pub fn finish_window(&mut self) {
        let city = self.orbit.target as usize;
        let o = &mut self.orbit;
        o.lit |= 1 << city;
        o.sun_city = city as u8;
        o.sun_until = self.tick + 20 * HZ;
        if city == 0 {
            o.first_light = true;
            self.stage = self.stage.max(Stage::Sunlight);
        } else if city == 1 {
            self.stage = self.stage.max(Stage::Highland);
        }
        if o.program == CAMPAIGN && city == 2 {
            o.rounds += 1;
            if o.rounds == 3 {
                let mut reserved = vec![0; self.grids.len()];
                for (n, &tile) in STATIONS.iter().enumerate() {
                    let site = self.cells[tile];
                    let (cores, energy) = reserve(n);
                    let group = site.group as usize;
                    reserved[group] += energy;
                    if site.inv[CORE as usize] < cores
                        || site.group == 0
                        || self.grids[group].stored < reserved[group]
                    {
                        o.fault = 3;
                        o.fault_city = n as u8;
                        o.fault_at = WINDOW_LENGTH[city];
                        o.mode = 4;
                        return;
                    }
                }
                self.stage = Stage::Victory;
                o.mode = 3;
                o.sun_until = self.tick + 20 * HZ;
                return;
            }
        }
        if o.program == CAMPAIGN || (o.program == ADJACENT && city == 1) {
            o.target = ((city + 1) % 3) as u8;
            o.mode = 1;
            o.time_left = WINDOW_GAP[city];
            return;
        }
        if o.program == ADJACENT {
            self.stage = self.stage.max(Stage::Acceptance);
        }
        o.mode = 3;
        if city == 0 && self.stage < Stage::Valley {
            o.next_window = self.tick + 45 * HZ;
        }
    }
}
