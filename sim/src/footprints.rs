use crate::catalog::*;
use crate::world::World;

#[derive(Clone, Copy, Default)]
struct Space {
    owner: u16,
    input: u8,
    output: u8,
}

pub struct Footprints {
    space: Vec<Space>,
    pub outlets: Vec<Outlet>,
}

#[derive(Clone, Copy)]
pub struct Outlet {
    pub anchor: usize,
    pub tile: usize,
    pub flow: u8,
}

pub fn size(kind: u8, dir: u8) -> (usize, usize) {
    let (width, height) = FOOTPRINT_SIZES[layout_kind(kind) as usize];
    if dir % 2 == 0 {
        (width.into(), height.into())
    } else {
        (height.into(), width.into())
    }
}

pub fn covered(anchor: usize, kind: u8, dir: u8) -> Option<impl Iterator<Item = usize>> {
    let (width, height) = size(kind, dir);
    if anchor % W + width > W || anchor / W + height > H {
        return None;
    }
    Some((0..height).flat_map(move |y| (0..width).map(move |x| anchor + y * W + x)))
}

fn rotate_port(kind: u8, dir: u8, port: &Port) -> (usize, u8) {
    let (w, h) = FOOTPRINT_SIZES[layout_kind(kind) as usize];
    let (x, y) = match dir {
        1 => (h - 1 - port.y, port.x),
        2 => (w - 1 - port.x, h - 1 - port.y),
        3 => (port.y, w - 1 - port.x),
        _ => (port.x, port.y),
    };
    (index(x.into(), y.into()), (port.side + dir) % 4)
}

impl Footprints {
    pub fn new() -> Self {
        Self {
            space: vec![Space::default(); N],
            outlets: Vec::new(),
        }
    }

    pub fn owner(&self, tile: usize) -> Option<usize> {
        usize::from(self.space[tile].owner).checked_sub(1)
    }

    pub fn masks(&self, tile: usize) -> (u8, u8) {
        let space = self.space[tile];
        (space.input, space.output)
    }
}

impl World {
    pub fn validate_footprint(
        &self,
        anchor: usize,
        kind: u8,
        dir: u8,
        ignore: Option<usize>,
    ) -> Result<(), i32> {
        let tiles = covered(anchor, kind, dir).ok_or(-3)?;
        if !permitted(kind, anchor, self.progression.regional_map) {
            return Err(-3);
        }
        for tile in tiles {
            if !self.map_contains(tile) || tile != anchor && STATIONS.contains(&tile) {
                return Err(-3);
            }
            if self
                .footprints
                .owner(tile)
                .is_some_and(|owner| Some(owner) != ignore)
            {
                return Err(-2);
            }
        }
        Ok(())
    }

    pub fn rebuild_footprints(&mut self) -> Option<()> {
        let bounds = self.progression.bounds(self.stage);
        let footprints = &mut self.footprints;
        footprints.space.fill(Space::default());
        footprints.outlets.clear();
        for (anchor, cell) in self.cells.iter().enumerate().filter(|(_, c)| c.kind != 0) {
            let kind = cell.kind;
            for tile in covered(anchor, kind, cell.dir)? {
                if footprints.space[tile].owner != 0
                    || !crate::progression::contains_tile(bounds, tile)
                    || tile != anchor && STATIONS.contains(&tile)
                {
                    return None;
                }
                footprints.space[tile].owner = (anchor + 1) as u16;
            }
            if is_belt(kind) {
                continue;
            }
            let r = crate::recipes::device_recipe(cell, self.legacy_recipes);
            let input = matches!(kind, DEPOT | GENERATOR | STATION | FREIGHT_YARD)
                || r.is_some_and(|r| r.input[0].1 != 0);
            let output = matches!(kind, DEPOT | FREIGHT_YARD)
                || (r.is_some() && (kind != SIMPLE_MINER || self.legacy_recipes));
            if let Some(ports) = MATERIAL_PORTS[layout_kind(kind) as usize] {
                for port in ports {
                    let (offset, side) = rotate_port(kind, cell.dir, port);
                    let tile = anchor + offset;
                    if port.output && output {
                        footprints.space[tile].output |= 1 << side;
                        footprints.outlets.push(Outlet {
                            anchor,
                            tile,
                            flow: side,
                        });
                    } else if !port.output && input {
                        footprints.space[tile].input |= 1 << ((side + 2) % 4);
                    }
                }
            } else {
                if input {
                    footprints.space[anchor].input = 15;
                }
                if output {
                    footprints.space[anchor].output = 1 << cell.dir;
                    footprints.outlets.push(Outlet {
                        anchor,
                        tile: anchor,
                        flow: cell.dir,
                    });
                }
            }
        }
        Some(())
    }

    pub fn material_masks(&self, tile: usize, anchor: usize) -> (u8, u8) {
        let (mut input, mut output) = self.footprints.masks(tile);
        let cell = &self.cells[anchor];
        match cell.kind {
            DEPOT if cell.cfg == 0 => output = 0,
            DEPOT => input = 0,
            FREIGHT_YARD if RECEIVERS.contains(&anchor) => input = 0,
            FREIGHT_YARD => output = 0,
            _ => (),
        }
        (input, output)
    }

    pub fn write_machine_footprints(&self, out: &mut Vec<i32>) {
        let start = out.len();
        for &anchor in &self.machines {
            let cell = &self.cells[anchor];
            for tile in covered(anchor, cell.kind, cell.dir).unwrap() {
                let (input, output) = self.material_masks(tile, anchor);
                out.extend([tile as i32, anchor as i32, i32::from(input | (output << 4))]);
            }
        }
        out.push(start as i32);
    }
}
