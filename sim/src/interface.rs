use std::collections::HashSet;

use crate::campaign::Stage;
use crate::catalog::*;
use crate::world::World;
use crate::{Runtime, RUNTIME};

// The main grid has a fixed stride. Append records only for inspectable
// devices, and put their offset in the last word of the snapshot.
impl World {
    pub fn write_device_data(&self, out: &mut Vec<i32>) {
        let start = out.len();
        for &tile in &self.machines {
            let cell = self.cells[tile];
            let grade = miner_grade(cell.kind);
            let ore = if grade > 0 { terrain(tile) } else { 0 };
            let p = cell.power;
            out.extend([
                tile as i32,
                cell.identity,
                grade.into(),
                ore.into(),
                p.demand.into(),
                p.used.into(),
                p.generated.into(),
                p.charged.into(),
                p.discharged.into(),
            ]);
            self.write_slots(tile, out);
        }
        out.push(start as i32);
    }

    pub fn write_saved_devices(&self, out: &mut Vec<i32>) {
        let devices = self.cells.iter().filter(|cell| cell.kind != 0);
        out.extend([self.next_device_id, devices.clone().count() as i32]);
        for cell in devices {
            out.push(cell.identity);
        }
    }

    pub fn read_saved_devices<'a>(
        &mut self,
        data: &'a [i32],
        includes_belts: bool,
    ) -> Option<&'a [i32]> {
        let [next_id, count, rest @ ..] = data else {
            return None;
        };
        let count = usize::try_from(*count).ok()?;
        let devices = self
            .cells
            .iter_mut()
            .filter(|cell| cell.kind != 0 && (includes_belts || !is_belt(cell.kind)));
        if !(1..i32::MAX / 2).contains(next_id) || count > N {
            return None;
        }
        let ids = rest.get(..count)?;
        let mut seen = HashSet::with_capacity(count);
        for (i, cell) in devices.enumerate() {
            let id = *ids.get(i)?;
            if id <= 0 || id >= *next_id || !seen.insert(id) {
                return None;
            }
            cell.identity = id;
        }
        if seen.len() != count {
            return None;
        }
        self.next_device_id = *next_id;
        if !includes_belts {
            for cell in self.cells.iter_mut().filter(|cell| is_belt(cell.kind)) {
                cell.identity = self.next_device_id;
                self.next_device_id += 1;
            }
        }
        Some(&rest[count..])
    }
}

#[no_mangle]
pub extern "C" fn directory() -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let out = &mut runtime.output;
        out.clear();
        for kind in 1..=MAX_KIND {
            let materials = materials(kind);
            if materials.is_empty() {
                continue;
            }
            let minimum = Stage::required_for(kind).map_or(-1, |stage| stage as i32);
            let recipe = recipe(kind);
            let demand = if kind == STATION {
                LAUNCH_POWER
            } else {
                recipe.as_ref().map_or(0, |r| r.power)
            };
            let generation = match kind {
                GENERATOR => GENERATOR_POWER,
                SOLAR => SOLAR_POWER,
                _ => 0,
            };
            let batteries = kind == BATTERY;
            let ore_mask = match kind {
                INDUSTRIAL_MINER | REINFORCED_MINER => (1 << IRON) | (1 << SILICA) | (1 << FUEL),
                SIMPLE_MINER => 1 << IRON,
                _ => drill_ore(kind).map_or(0, |ore| 1 << ore),
            };
            out.extend([
                kind.into(),
                minimum,
                miner_grade(kind).into(),
                ore_mask,
                demand.into(),
                generation.into(),
                if batteries { BATTERY_POWER.into() } else { 0 },
                if batteries {
                    BATTERY_CAPACITY as i32
                } else {
                    0
                },
                recipe.as_ref().map_or(0, |r| r.output.into()),
                recipe.as_ref().map_or(0, |r| r.amount.into()),
                recipe.as_ref().map_or(0, |r| r.ticks.into()),
                if kind == CABLE { CABLE_SPAN as i32 } else { 1 },
                materials.len() as i32,
            ]);
            for &(item, count) in materials {
                out.extend([item.into(), count as i32]);
            }
            out.extend([
                match kind {
                    BELT => 1,
                    FAST_BELT => 2,
                    EXPRESS_BELT => 3,
                    _ => 0,
                },
                belt_lanes(kind) as i32,
                if is_belt(kind) {
                    belt_interval(kind) as i32
                } else {
                    0
                },
                is_belt(kind) as i32,
            ]);
            for lane in 0..2 {
                let inputs = (0..4)
                    .filter(|&flow| belt_input(kind, 0, flow) == Some(lane))
                    .fold(0, |mask, flow| mask | 1 << flow);
                let outputs = if lane < belt_lanes(kind) {
                    belt_outputs(kind, 0, lane)
                        .into_iter()
                        .flatten()
                        .fold(0, |mask, flow| mask | 1 << flow)
                } else {
                    0
                };
                out.extend([inputs, outputs]);
            }
        }
        out.len()
    })
}

#[no_mangle]
pub extern "C" fn blueprints() -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, output, .. } = &mut *runtime;
        output.clear();
        world.blueprints.write_view(output);
        output.len()
    })
}
