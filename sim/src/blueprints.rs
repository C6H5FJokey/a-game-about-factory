use crate::catalog::*;
use crate::footprints::{covered, size};
use crate::world::{Cell, World};

const MAX_TILES: usize = 250;
const MAX_BLUEPRINTS: usize = 512;
const MAX_NAME_BYTES: usize = 192;
const PART_WORDS: usize = 6;
const STANDARD_ID: i32 = 0;
const LAYOUT_VERSION: i32 = 1;

#[derive(Clone, Copy)]
struct Part {
    x: i32,
    y: i32,
    kind: u8,
    dir: u8,
    wire: bool,
    config: i32,
}

impl Part {
    fn turned(mut self, turns: i32) -> Self {
        for _ in 0..turns {
            let (_, height) = size(self.kind, self.dir);
            (self.x, self.y) = (-self.y - (height as i32 - 1), self.x);
            self.dir = (self.dir + 1) % 4;
        }
        self
    }

    fn extent(self) -> (i32, i32) {
        let (width, height) = size(self.kind, self.dir);
        (self.x + width as i32, self.y + height as i32)
    }
}

pub struct Blueprint {
    id: i32,
    version: i32,
    name: String,
    parts: Vec<Part>,
}

pub struct Library {
    entries: Vec<Blueprint>,
    next_id: i32,
    legacy_imported: bool,
}

impl Default for Library {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            next_id: 1,
            legacy_imported: false,
        }
    }
}

fn name(words: &[i32]) -> Option<String> {
    if words.is_empty() || words.len() > MAX_NAME_BYTES {
        return None;
    }
    let bytes = words
        .iter()
        .map(|&word| u8::try_from(word))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let text = std::str::from_utf8(&bytes).ok()?.trim();
    if text.is_empty() || text.chars().any(char::is_control) {
        return None;
    }
    Some(text.to_owned())
}

fn copyable(kind: u8) -> bool {
    kind == 0
        || (!matches!(kind, STATION | SIMPLE_MINER | FREIGHT_YARD | CABLE)
            && !materials(kind).is_empty())
}

fn max_config(kind: u8) -> u8 {
    match kind {
        DEPOT => (ITEMS - 1) as u8,
        SPLITTER => 1,
        kind if PROCESSING[kind as usize] || recipe(kind).is_some() || miner_grade(kind) >= 2 => 2,
        _ => 0,
    }
}

fn read_parts(words: &[i32], legacy: bool) -> Option<Vec<Part>> {
    if words.is_empty() || words.len() % PART_WORDS != 0 || words.len() / PART_WORDS > MAX_TILES {
        return None;
    }
    let mut seen = [false; N];
    let mut occupied = [false; N];
    let mut parts = Vec::with_capacity(words.len() / PART_WORDS);
    let (mut width, mut height) = (0, 0);
    for p in words.chunks_exact(PART_WORDS) {
        let kind = u8::try_from(p[2]).ok()?;
        let kind = if legacy { layout_kind(kind) } else { kind };
        if !(0..W as i32).contains(&p[0])
            || !(0..H as i32).contains(&p[1])
            || !copyable(kind)
            || layout_kind(kind) != kind
            || !(0..4).contains(&p[3])
            || !(0..=1).contains(&p[4])
            || p[5] < 0
            || if PROCESSING[kind as usize] && p[5] > 3 {
                !recipe_index(p[5] >> 2).is_some_and(|index| {
                    RECIPES[index].modern && RECIPES[index].machines.contains(&kind)
                }) || p[5] & 3 == 3
            } else {
                p[5] > i32::from(max_config(kind))
            }
            || (kind == 0 && p[4] == 0)
        {
            return None;
        }
        let tile = index(p[0] as usize, p[1] as usize);
        if std::mem::replace(&mut seen[tile], true) {
            return None;
        }
        let dir = p[3] as u8;
        if kind != 0 {
            for tile in covered(tile, kind, dir)? {
                if std::mem::replace(&mut occupied[tile], true) {
                    return None;
                }
            }
        }
        let part = Part {
            x: p[0],
            y: p[1],
            kind,
            dir,
            wire: p[4] == 1,
            config: p[5],
        };
        let (right, bottom) = part.extent();
        width = width.max(right);
        height = height.max(bottom);
        parts.push(part);
    }
    (width * height <= MAX_TILES as i32).then_some(parts)
}

impl Blueprint {
    fn standard(legacy: bool) -> Self {
        if !legacy {
            let key = RECIPES
                .iter()
                .find(|spec| {
                    spec.modern && spec.recipe.output == KIT && spec.machines.contains(&SPLICER)
                })
                .map_or(0, |spec| spec.key);
            return Self {
                id: STANDARD_ID,
                version: LAYOUT_VERSION,
                name: "标准厂段".to_owned(),
                parts: vec![
                    Part {
                        x: 0,
                        y: 0,
                        kind: SPLICER,
                        dir: 0,
                        wire: true,
                        config: key << 2,
                    },
                    Part {
                        x: 2,
                        y: 0,
                        kind: BELT,
                        dir: 0,
                        wire: false,
                        config: 0,
                    },
                    Part {
                        x: 3,
                        y: 0,
                        kind: DEPOT,
                        dir: 0,
                        wire: false,
                        config: 0,
                    },
                ],
            };
        }
        let mut parts = Vec::new();
        let mut x = 0;
        for kind in [INDUSTRIAL_MINER, BELT, SMELTER, KIT_PRESS, BELT, DEPOT] {
            let (width, _) = size(kind, 0);
            for offset in 0..width {
                parts.push(Part {
                    x: x + offset as i32,
                    y: 0,
                    kind: if offset == 0 { kind } else { 0 },
                    dir: 0,
                    wire: true,
                    config: 0,
                });
            }
            x += width as i32;
        }
        Self {
            id: STANDARD_ID,
            version: LAYOUT_VERSION,
            name: "标准厂段".to_owned(),
            parts,
        }
    }

    fn pieces(&self) -> usize {
        self.parts.iter().filter(|part| part.kind != 0).count()
    }
    fn kits(&self) -> u32 {
        (self.pieces() as u32).div_ceil(2).max(2)
    }

    fn write(&self, out: &mut Vec<i32>) {
        out.extend([
            self.id,
            self.version,
            self.name.len() as i32,
            self.parts.len() as i32,
        ]);
        out.extend(self.name.bytes().map(i32::from));
        for part in &self.parts {
            out.extend([
                part.x,
                part.y,
                part.kind.into(),
                part.dir.into(),
                part.wire as i32,
                part.config,
            ]);
        }
    }
}

impl Library {
    fn append(&mut self, name: String, parts: Vec<Part>) -> i32 {
        if self.entries.len() >= MAX_BLUEPRINTS || self.next_id == i32::MAX {
            return -18;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.entries.push(Blueprint {
            id,
            version: LAYOUT_VERSION,
            name,
            parts,
        });
        id
    }

    pub fn rename(&mut self, id: i32, words: &[i32]) -> i32 {
        let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) else {
            return -16;
        };
        let Some(name) = name(words) else {
            return -17;
        };
        entry.name = name;
        1
    }

    pub fn delete(&mut self, id: i32) -> i32 {
        let Some(index) = self.entries.iter().position(|entry| entry.id == id) else {
            return -16;
        };
        self.entries.remove(index);
        1
    }

    pub fn import_legacy(&mut self, words: &[i32]) -> i32 {
        if self.legacy_imported {
            return 1;
        }
        let Some(parts) = read_parts(words, true) else {
            return -17;
        };
        let id = self.append("旧版厂段".to_owned(), parts);
        if id > 0 {
            self.legacy_imported = true;
        }
        id
    }

    pub fn write_view(&self, out: &mut Vec<i32>, legacy: bool) {
        wire::Library {
            legacy_imported: self.legacy_imported.into(),
            entries: (self.entries.len() + 1) as i32,
        }
        .append(out);
        for entry in std::iter::once(&Blueprint::standard(legacy)).chain(&self.entries) {
            wire::BlueprintInfo {
                width: entry
                    .parts
                    .iter()
                    .map(|part| part.extent().0)
                    .max()
                    .unwrap_or(0),
                height: entry
                    .parts
                    .iter()
                    .map(|part| part.extent().1)
                    .max()
                    .unwrap_or(0),
                devices: entry.pieces() as i32,
                item: KIT.into(),
                count: entry.kits() as i32,
            }
            .append(out);
            wire::Blueprint {
                id: entry.id,
                version: entry.version,
                name_bytes: entry.name.len() as i32,
                parts: entry.parts.len() as i32,
            }
            .append(out);
            out.extend(entry.name.bytes().map(i32::from));
            for part in &entry.parts {
                wire::Part {
                    x: part.x,
                    y: part.y,
                    kind: part.kind.into(),
                    direction: part.dir.into(),
                    wire: part.wire.into(),
                    config: part.config,
                }
                .append(out);
            }
        }
    }

    pub fn write_save(&self, out: &mut Vec<i32>) {
        out.extend([
            self.next_id,
            self.legacy_imported as i32,
            self.entries.len() as i32,
        ]);
        for entry in &self.entries {
            entry.write(out);
        }
    }

    pub fn read_save(mut data: &[i32]) -> Option<Self> {
        let [next_id, imported, count, rest @ ..] = data else {
            return None;
        };
        let (next_id, count) = (*next_id, usize::try_from(*count).ok()?);
        if next_id < 1 || !matches!(imported, 0 | 1) || count > MAX_BLUEPRINTS {
            return None;
        }
        data = rest;
        let mut entries = Vec::with_capacity(count);
        let mut last_id = 0;
        for _ in 0..count {
            let [id, version, name_words, part_count, rest @ ..] = data else {
                return None;
            };
            if *id <= last_id || *id >= next_id || *version != LAYOUT_VERSION {
                return None;
            }
            let name_words = usize::try_from(*name_words).ok()?;
            let part_count = usize::try_from(*part_count).ok()?;
            if name_words > MAX_NAME_BYTES || part_count > MAX_TILES {
                return None;
            }
            let name = name(rest.get(..name_words)?)?;
            let end = name_words + PART_WORDS * part_count;
            let parts = read_parts(rest.get(name_words..end)?, false)?;
            entries.push(Blueprint {
                id: *id,
                version: *version,
                name,
                parts,
            });
            last_id = *id;
            data = &rest[end..];
        }
        data.is_empty().then_some(Self {
            entries,
            next_id,
            legacy_imported: *imported == 1,
        })
    }
}

impl World {
    pub fn capture_blueprint(&mut self, a: usize, b: usize, words: &[i32]) -> i32 {
        if !self.orbit.first_light {
            return -6;
        }
        if a >= N || b >= N || !self.map_contains(a) || !self.map_contains(b) {
            return -1;
        }
        let Some(name) = name(words) else {
            return -17;
        };
        let (x0, x1) = ((a % W).min(b % W), (a % W).max(b % W));
        let (y0, y1) = ((a / W).min(b / W), (a / W).max(b / W));
        if (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES {
            return -17;
        }
        let mut parts = Vec::new();
        for y in y0..=y1 {
            for x in x0..=x1 {
                let tile = index(x, y);
                if let Some(anchor) = self.footprints.owner(tile) {
                    let device = self.cells[anchor];
                    let (width, height) = size(device.kind, device.dir);
                    if copyable(device.kind)
                        && (anchor % W < x0
                            || anchor / W < y0
                            || anchor % W + width - 1 > x1
                            || anchor / W + height - 1 > y1)
                    {
                        return -17;
                    }
                }
                let cell = self.cells[tile];
                let kind = if copyable(cell.kind) {
                    layout_kind(cell.kind)
                } else {
                    0
                };
                if kind == 0 && !cell.wire {
                    continue;
                }
                parts.push(Part {
                    x: (x - x0) as i32,
                    y: (y - y0) as i32,
                    kind,
                    dir: cell.dir,
                    wire: cell.wire,
                    config: i32::from(cell.cfg.min(max_config(kind)))
                        | if cell.selected_recipe == 0 {
                            0
                        } else {
                            RECIPES[cell.selected_recipe as usize - 1].key << 2
                        },
                });
            }
        }
        if parts.is_empty() {
            return -17;
        }
        self.blueprints.append(name, parts)
    }

    pub fn deploy_blueprint(&mut self, anchor: usize, id: i32, version: i32, turns: i32) -> i32 {
        if !self.orbit.first_light {
            return -6;
        }
        if anchor >= N || !(0..4).contains(&turns) {
            return -1;
        }
        let standard;
        let entry = if id == STANDARD_ID {
            standard = Blueprint::standard(self.legacy_recipes);
            &standard
        } else {
            let Some(entry) = self.blueprints.entries.iter().find(|entry| entry.id == id) else {
                return -16;
            };
            entry
        };
        if version != entry.version {
            return -16;
        }
        let price = entry.kits();
        let mut plan = Vec::with_capacity(entry.parts.len());
        let mut occupied = [false; N];
        for part in entry.parts.iter().map(|part| part.turned(turns)) {
            let x = part.x + (anchor % W) as i32;
            let y = part.y + (anchor / W) as i32;
            if !(0..W as i32).contains(&x) || !(0..H as i32).contains(&y) {
                return -3;
            }
            let tile = index(x as usize, y as usize);
            if !self.map_contains(tile) {
                return -3;
            }
            let kind = if matches!(part.kind, INDUSTRIAL_MINER | REINFORCED_MINER) {
                match self.drill_at(tile, part.kind) {
                    Ok(kind) => kind,
                    Err(error) => return error,
                }
            } else {
                part.kind
            };
            if kind != 0 {
                if !self.unlocked(kind) {
                    return -6;
                }
                if let Err(error) = self.validate_footprint(tile, kind, part.dir, None) {
                    return error;
                }
                for covered_tile in covered(tile, kind, part.dir).unwrap() {
                    if std::mem::replace(&mut occupied[covered_tile], true) {
                        return -2;
                    }
                }
            }
            let (config, chosen) = if PROCESSING[kind as usize] && part.config > 3 {
                let Some(index) = recipe_index(part.config >> 2) else {
                    return -16;
                };
                let spec = &RECIPES[index];
                if self.legacy_recipes
                    || !spec.machines.contains(&kind)
                    || (self.stage as u8) < spec.unlock
                {
                    return -6;
                }
                (part.config as u8 & 3, (index + 1) as u16)
            } else {
                (part.config as u8, 0)
            };
            plan.push((tile, kind, part.dir, part.wire, config, chosen));
        }
        let members = plan
            .iter()
            .flat_map(|&(tile, kind, _, wire, ..)| {
                [
                    (kind != 0).then_some(tile),
                    (wire && !self.cells[tile].wire)
                        .then_some(crate::ground::cable_payment_site(tile)),
                ]
                .into_iter()
                .flatten()
            })
            .collect::<Vec<_>>();
        if members.is_empty() {
            return -2;
        }
        let cost = [(KIT, price)];
        if !self.spend_construction(anchor, &cost) {
            return -5;
        }
        self.materialize();
        self.ground
            .record_bundle(self.next_device_id, &cost, members);
        self.next_device_id += 1;
        for (tile, kind, dir, wire, cfg, selected_recipe) in plan {
            let wire = self.cells[tile].wire || wire;
            if kind != 0 {
                self.install(
                    tile,
                    Cell {
                        kind,
                        dir,
                        cfg,
                        selected_recipe,
                        wire,
                        ..Cell::default()
                    },
                );
            } else {
                self.cells[tile].wire = wire;
            }
        }
        self.rebuild();
        1
    }
}
