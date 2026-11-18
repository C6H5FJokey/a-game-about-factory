pub const W: usize = 56;
pub const H: usize = 34;
pub const N: usize = W * H;
pub const HZ: u32 = 20;
pub const BELT_TICKS: u32 = 5;
pub const ITEMS: usize = 9;
pub const BELT: u8 = 1;
pub const IRON_DRILL: u8 = 2;
pub const SILICA_DRILL: u8 = 3;
pub const FUEL_DRILL: u8 = 4;
pub const SMELTER: u8 = 5;
pub const GRINDER: u8 = 6;
pub const CALIBRATOR: u8 = 7;
pub const ASSEMBLER: u8 = 8;
pub const GENERATOR: u8 = 9;
pub const BATTERY: u8 = 10;
pub const SOLAR: u8 = 11;
pub const DEPOT: u8 = 12;
pub const STATION: u8 = 13;
pub const KIT_PRESS: u8 = 14;
pub const SPLITTER: u8 = 15;
pub const KILN: u8 = 16;
pub const SIMPLE_MINER: u8 = 17;
pub const BENCH: u8 = 18;
pub const FREIGHT_YARD: u8 = 19;
pub const MINER_COST: u32 = 5;
pub const MINER_TICKS: u16 = 3 * HZ as u16;
pub const MINER_CAPACITY: u16 = 8;
pub const FIRST_ORE: usize = index(19, 16);

pub const IRON: u8 = 1;
pub const SILICA: u8 = 2;
pub const FUEL: u8 = 3;
pub const PLATE: u8 = 4;
pub const LENS: u8 = 5;
pub const CORE: u8 = 6;
pub const MIRROR: u8 = 7;
pub const KIT: u8 = 8;

pub const STATION_POS: usize = index(33, 15);
pub const STATIONS: [usize; 3] = [STATION_POS, index(48, 29), index(9, 29)];
pub const SENDERS: [usize; 2] = [index(34, 18), index(35, 18)];
pub const RECEIVERS: [usize; 2] = [index(44, 29), index(5, 29)];
pub const LAUNCH_TICKS: u32 = HZ * 8;
pub const COUNTDOWN: u32 = HZ * 5;
pub const WINDOW: u32 = HZ * 24;
pub const BATTERY_CAPACITY: u32 = 24_000;
pub const BATTERY_POWER: u16 = 40;
pub const DELIVERY_WINDOW: u32 = 20 * HZ;
pub const REQUIRED_BLOCKS: usize = 4;
pub const REQUIRED_KITS: u32 = 12;

pub const fn index(x: usize, y: usize) -> usize {
    y * W + x
}

pub fn neighbor(i: usize, dir: u8) -> Option<usize> {
    match dir {
        0 if i % W + 1 < W => Some(i + 1),
        1 if i + W < N => Some(i + W),
        2 if i % W > 0 => Some(i - 1),
        3 if i >= W => Some(i - W),
        _ => None,
    }
}

pub fn is_belt(kind: u8) -> bool {
    matches!(kind, BELT | SPLITTER)
}

pub fn cost(kind: u8) -> Option<u32> {
    Some(match kind {
        BENCH => 2,
        STATION => 8,
        BELT => 1,
        IRON_DRILL | SILICA_DRILL | FUEL_DRILL | DEPOT => 4,
        SMELTER | GRINDER | CALIBRATOR | SPLITTER | KIT_PRESS => 5,
        BATTERY | SOLAR => 6,
        GENERATOR | ASSEMBLER | KILN => 8,
        _ => return None,
    })
}

pub struct Recipe {
    pub input: [(u8, u16); 2],
    pub output: u8,
    pub amount: u16,
    pub ticks: u16,
    pub power: u16,
}

pub fn recipe(kind: u8) -> Option<Recipe> {
    let (input, output, amount, ticks, power) = match kind {
        SIMPLE_MINER => ([(0, 0), (0, 0)], IRON, 1, MINER_TICKS, 0),
        BENCH => ([(IRON, 1), (0, 0)], PLATE, 1, 30, 0),
        IRON_DRILL => ([(0, 0), (0, 0)], IRON, 1, 12, 10),
        SILICA_DRILL => ([(0, 0), (0, 0)], SILICA, 1, 10, 10),
        FUEL_DRILL => ([(0, 0), (0, 0)], FUEL, 1, 8, 10),
        SMELTER => ([(IRON, 1), (0, 0)], PLATE, 1, 14, 13),
        GRINDER => ([(SILICA, 2), (0, 0)], LENS, 1, 23, 14),
        CALIBRATOR => ([(SILICA, 1), (0, 0)], CORE, 1, 14, 12),
        ASSEMBLER => ([(PLATE, 2), (LENS, 1)], MIRROR, 1, 46, 19),
        KIT_PRESS => ([(PLATE, 2), (0, 0)], KIT, 1, 22, 12),
        KILN => ([(SILICA, 4), (0, 0)], LENS, 3, 26, 45),
        _ => return None,
    };
    Some(Recipe {
        input,
        output,
        amount,
        ticks,
        power,
    })
}

pub fn terrain(pos: usize) -> u8 {
    let x = pos % W;
    let y = pos / W;
    if matches!(
        (x, y),
        (19, 16)
            | (22, 19)
            | (5, 13)
            | (19, 28)
            | (28, 28)
            | (38, 26)
            | (47, 21)
            | (27, 5)
            | (41, 30)
            | (4, 28)
            | (31, 30)
            | (41, 18)
    ) {
        return IRON;
    }
    if matches!((x, y), (20, 20) | (5, 20) | (4, 22) | (12, 30) | (46, 28)) {
        return SILICA;
    }
    if matches!((x, y), (23, 16) | (5, 7) | (8, 5) | (12, 5) | (39, 19)) {
        return FUEL;
    }
    0
}

pub fn permitted(kind: u8, pos: usize) -> bool {
    if kind == STATION || STATIONS.contains(&pos) {
        return STATIONS.contains(&pos) && kind == STATION;
    }
    if kind == FREIGHT_YARD {
        return SENDERS.contains(&pos) || RECEIVERS.contains(&pos);
    }
    if kind == SIMPLE_MINER {
        return terrain(pos) == IRON;
    }
    !matches!(kind, IRON_DRILL..=FUEL_DRILL) || terrain(pos) == kind - 1
}
