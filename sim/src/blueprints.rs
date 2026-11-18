use crate::catalog::*;
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
    config: u8,
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
        DEPOT => 8,
        SPLITTER => 1,
        kind if recipe(kind).is_some() || miner_grade(kind) >= 2 => 2,
        _ => 0,
    }
}

fn read_parts(words: &[i32], legacy: bool) -> Option<Vec<Part>> {
    if words.is_empty() || words.len() % PART_WORDS != 0 || words.len() / PART_WORDS > MAX_TILES {
        return None;
    }
    let mut seen = [false; N];
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
            || !(0..=i32::from(max_config(kind))).contains(&p[5])
            || (kind == 0 && p[4] == 0)
        {
            return None;
        }
        let tile = index(p[0] as usize, p[1] as usize);
        if std::mem::replace(&mut seen[tile], true) {
            return None;
        }
        width = width.max(p[0] + 1);
        height = height.max(p[1] + 1);
        parts.push(Part {
            x: p[0],
            y: p[1],
            kind,
            dir: p[3] as u8,
            wire: p[4] == 1,
            config: p[5] as u8,
        });
    }
    (width * height <= MAX_TILES as i32).then_some(parts)
}

impl Blueprint {
    fn standard() -> Self {
        let parts = [INDUSTRIAL_MINER, BELT, SMELTER, KIT_PRESS, BELT, DEPOT]
            .into_iter()
            .enumerate()
            .map(|(x, kind)| Part {
                x: x as i32,
                y: 0,
                kind,
                dir: 0,
                wire: true,
                config: 0,
            })
            .collect();
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
                part.config.into(),
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

    pub fn write_view(&self, out: &mut Vec<i32>) {
        out.extend([self.legacy_imported as i32, (self.entries.len() + 1) as i32]);
        for entry in std::iter::once(&Blueprint::standard()).chain(&self.entries) {
            out.extend([
                entry.parts.iter().map(|part| part.x + 1).max().unwrap_or(0),
                entry.parts.iter().map(|part| part.y + 1).max().unwrap_or(0),
                entry.pieces() as i32,
                KIT.into(),
                entry.kits() as i32,
            ]);
            entry.write(out);
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
        if a >= N || b >= N || !self.progression.contains(a) || !self.progression.contains(b) {
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
                let cell = self.cells[index(x, y)];
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
                    config: cell.cfg.min(max_config(kind)),
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
            standard = Blueprint::standard();
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
        for &part in &entry.parts {
            let (mut x, mut y) = (part.x, part.y);
            for _ in 0..turns {
                (x, y) = (-y, x);
            }
            x += (anchor % W) as i32;
            y += (anchor / W) as i32;
            if !(0..W as i32).contains(&x) || !(0..H as i32).contains(&y) {
                return -3;
            }
            let tile = index(x as usize, y as usize);
            if !self.progression.contains(tile) {
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
                if self.cells[tile].kind != 0 {
                    return -2;
                }
                if !self.unlocked(kind)
                    || kind == DEPOT && part.config != 0 && !self.known_item(part.config)
                {
                    return -6;
                }
                if !permitted(kind, tile) {
                    return -3;
                }
            }
            let dir = (part.dir + turns as u8) % 4;
            plan.push((tile, kind, dir, part.wire, part.config));
        }
        if self.stock[KIT as usize] < price {
            return -5;
        }
        self.stock[KIT as usize] -= price;
        self.materialize();
        for (tile, kind, dir, wire, cfg) in plan {
            let wire = self.cells[tile].wire || wire;
            if kind != 0 {
                self.install(
                    tile,
                    Cell {
                        kind,
                        dir,
                        cfg,
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
