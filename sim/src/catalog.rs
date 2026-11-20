#[cfg(feature = "terminal-profile")]
pub const W: usize = TERMINAL_WIDTH;
#[cfg(feature = "terminal-profile")]
pub const H: usize = TERMINAL_HEIGHT;
#[cfg(not(feature = "terminal-profile"))]
pub const W: usize = WORLD_WIDTH;
#[cfg(not(feature = "terminal-profile"))]
pub const H: usize = WORLD_HEIGHT;
pub const N: usize = W * H;
// Footprint owners and producer IDs reserve a sentinel above the last tile.
const _: () = assert!(N < u16::MAX as usize);
pub const BELT_TICKS: u32 = 5;
pub const LEGACY_MATERIAL_ITEMS: usize = 9;
pub const MATERIAL_ITEMS: usize = ITEMS;
pub const ITEMS: usize = 20;
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
pub const INDUSTRIAL_MINER: u8 = 20;
pub const CABLE: u8 = 21;
pub const FAST_BELT: u8 = 22;
pub const MERGER: u8 = 23;
pub const CROSSING: u8 = 24;
pub const DEVELOPMENT_HUB: u8 = 25;
pub const EXPRESS_BELT: u8 = 26;
pub const REINFORCED_IRON_DRILL: u8 = 27;
pub const REINFORCED_SILICA_DRILL: u8 = 28;
pub const REINFORCED_FUEL_DRILL: u8 = 29;
pub const REINFORCED_MINER: u8 = 30;
pub const SPLICER: u8 = 31;
pub const ULTRA_BELT: u8 = 32;
pub const COPPER_DRILL: u8 = 33;
pub const REINFORCED_COPPER_DRILL: u8 = 34;
pub const MAX_KIND: u8 = REINFORCED_COPPER_DRILL;
pub const FIRST_ORE: usize = index(19, 16);

pub const IRON: u8 = 1;
pub const SILICA: u8 = 2;
pub const FUEL: u8 = 3;
pub const PLATE: u8 = 4;
pub const LENS: u8 = 5;
pub const CORE: u8 = 6;
pub const MIRROR: u8 = 7;
pub const KIT: u8 = 8;
pub const SPEED_MODULE: u8 = 9;
pub const COPPER: u8 = 10;
pub const IRON_INGOT: u8 = 11;
pub const COPPER_WIRE: u8 = 15;

pub const STATION_POS: usize = index(33, 15);
pub const STATIONS: [usize; 3] = [STATION_POS, index(48, 29), index(9, 29)];
pub const SENDERS: [usize; 2] = [index(34, 18), index(35, 18)];
pub const RECEIVERS: [usize; 2] = [index(44, 29), index(5, 29)];
pub const LAUNCH_TICKS: u32 = HZ * 8;
pub const COUNTDOWN: u32 = HZ * 5;
pub const WINDOW: u32 = HZ * 24;
pub const MAX_BELT_INTERVAL: u32 = HZ * 60;
pub const DELIVERY_WINDOW: u32 = 20 * HZ;
pub const REQUIRED_BLOCKS: usize = 4;
pub const REQUIRED_KITS: u32 = 12;

pub const fn simulation_ticks(ticks: u32) -> u32 {
    ticks / CONTENT_HZ * HZ + (ticks % CONTENT_HZ * HZ).div_ceil(CONTENT_HZ)
}

fn content_tick(tick: u32) -> u32 {
    tick / HZ * CONTENT_HZ + tick % HZ * CONTENT_HZ / HZ
}

// Keep the exact real-time cadence of the existing belts. A five-beat belt
// alternates between seven and eight simulation steps on the 30 Hz clock.
pub fn belt_ready(tick: u32, interval: u32) -> u32 {
    simulation_ticks(content_tick(tick) + interval)
}

pub fn belt_pulse(tick: u32) -> bool {
    let beat = content_tick(tick);
    beat % BELT_TICKS == 0 && simulation_ticks(beat) == tick
}

pub fn legacy_cargo_ready(tick: u32) -> u32 {
    simulation_ticks((content_tick(tick) / BELT_TICKS + 1) * BELT_TICKS)
}

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
    plain_belt(kind) || matches!(kind, SPLITTER | MERGER | CROSSING)
}

pub fn plain_belt(kind: u8) -> bool {
    matches!(kind, BELT | FAST_BELT | EXPRESS_BELT | ULTRA_BELT)
}

pub fn belt_interval(kind: u8) -> u32 {
    BELT_INTERVAL[kind as usize]
}

pub fn belt_deadline(tick: u32, interval: u32, rate: u32) -> u32 {
    if rate == 0 {
        return belt_ready(tick, interval);
    }
    let steps_per_minute = u64::from(HZ * 60);
    let rate = u64::from(rate);
    ((u64::from(tick) * rate / steps_per_minute + 1) * steps_per_minute).div_ceil(rate) as u32
}

pub fn belt_lanes(kind: u8) -> usize {
    if kind == CROSSING {
        2
    } else if is_belt(kind) {
        1
    } else {
        0
    }
}

// Directions describe the flow of the item, including on entry.
pub fn belt_outputs(kind: u8, dir: u8, lane: usize) -> [Option<u8>; 2] {
    [
        Some((dir + lane as u8) % 4),
        (kind == SPLITTER).then_some((dir + 1) % 4),
    ]
}

pub fn belt_input(kind: u8, dir: u8, flow: u8) -> Option<usize> {
    if kind == CROSSING {
        return if flow == dir {
            Some(0)
        } else if flow == (dir + 1) % 4 {
            Some(1)
        } else {
            None
        };
    }
    (is_belt(kind) && flow != (dir + 2) % 4 && (kind != SPLITTER || flow != (dir + 3) % 4))
        .then_some(0)
}

pub fn materials(kind: u8) -> &'static [(u8, u32)] {
    BUILD_MATERIALS
        .get(kind as usize)
        .copied()
        .unwrap_or_default()
}

pub fn drill_kind(layout: u8, ore: u8) -> Option<u8> {
    if ore == COPPER {
        return match layout {
            INDUSTRIAL_MINER => Some(COPPER_DRILL),
            REINFORCED_MINER => Some(REINFORCED_COPPER_DRILL),
            _ => None,
        };
    }
    let first = match layout {
        INDUSTRIAL_MINER => IRON_DRILL,
        REINFORCED_MINER => REINFORCED_IRON_DRILL,
        _ => return None,
    };
    (IRON..=FUEL).contains(&ore).then(|| first + ore - IRON)
}

pub fn drill_ore(kind: u8) -> Option<u8> {
    match kind {
        IRON_DRILL..=FUEL_DRILL => Some(kind - IRON_DRILL + IRON),
        REINFORCED_IRON_DRILL => Some(IRON),
        REINFORCED_SILICA_DRILL => Some(SILICA),
        REINFORCED_FUEL_DRILL => Some(FUEL),
        COPPER_DRILL | REINFORCED_COPPER_DRILL => Some(COPPER),
        _ => None,
    }
}

pub fn miner_grade(kind: u8) -> u8 {
    match kind {
        SIMPLE_MINER => 1,
        IRON_DRILL..=FUEL_DRILL | INDUSTRIAL_MINER | COPPER_DRILL => 2,
        REINFORCED_IRON_DRILL..=REINFORCED_MINER | REINFORCED_COPPER_DRILL => 3,
        _ => 0,
    }
}

pub fn layout_kind(kind: u8) -> u8 {
    match miner_grade(kind) {
        2 => INDUSTRIAL_MINER,
        3 => REINFORCED_MINER,
        _ => kind,
    }
}

#[derive(Clone, Copy)]
pub struct Recipe {
    pub input: [(u8, u16); 3],
    pub output: u8,
    pub amount: u16,
    pub ticks: u32,
    pub power: u16,
}

pub struct HandRecipe {
    pub input: [(u8, u16); 3],
    pub ticks: u32,
    pub unlock: u8,
}

pub struct RecipeSpec {
    pub key: i32,
    pub modern: bool,
    pub recipe: Recipe,
    pub machines: &'static [u8],
    pub unlock: u8,
    pub handcraft: Option<HandRecipe>,
}

pub fn recipe_index(key: i32) -> Option<usize> {
    RECIPES.iter().position(|spec| spec.key == key)
}

pub struct Port {
    pub x: u8,
    pub y: u8,
    pub side: u8,
    pub output: bool,
}

pub fn recipe(kind: u8) -> Option<Recipe> {
    RECIPE_DATA.get(kind as usize).copied().flatten()
}

include!(concat!(env!("OUT_DIR"), "/content.rs"));

pub fn terrain(pos: usize, regional_map: bool) -> u8 {
    let x = pos % W;
    let y = pos / W;
    if regional_map {
        return match (x, y) {
            (19, 16)
            | (22, 19)
            | (11, 12)
            | (19, 28)
            | (28, 28)
            | (5, 13)
            | (38, 26)
            | (47, 21)
            | (27, 5)
            | (41, 30)
            | (4, 28)
            | (31, 30)
            | (41, 18) => IRON,
            (11, 16) | (26, 20) | (20, 24) | (34, 28) | (15, 28) | (35, 9) => COPPER,
            (30, 16) | (10, 6) | (22, 27) | (5, 7) | (8, 5) | (12, 5) | (39, 19) => FUEL,
            (33, 18) | (5, 20) | (4, 22) | (12, 30) | (46, 28) => SILICA,
            _ => 0,
        };
    }
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
    if matches!((x, y), (17, 17) | (23, 21) | (34, 28) | (15, 28) | (35, 9)) {
        return COPPER;
    }
    0
}

pub fn permitted(kind: u8, pos: usize, regional_map: bool) -> bool {
    if kind == STATION || STATIONS.contains(&pos) {
        return STATIONS.contains(&pos) && kind == STATION;
    }
    if kind == FREIGHT_YARD {
        return SENDERS.contains(&pos) || RECEIVERS.contains(&pos);
    }
    if kind == SIMPLE_MINER {
        return terrain(pos, regional_map) != 0;
    }
    drill_ore(kind).is_none_or(|ore| terrain(pos, regional_map) == ore)
}
