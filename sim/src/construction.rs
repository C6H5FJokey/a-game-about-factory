use crate::belts::{node, Cargo};
use crate::catalog::*;
use crate::world::{Cell, World};
use crate::{Runtime, RUNTIME};

struct Replacement {
    tile: usize,
    kind: u8,
    dir: u8,
    cargo: [Cargo; 2],
}

struct Plan {
    replacements: Vec<Replacement>,
    cost: [u32; ITEMS],
    anchor: usize,
}

struct Payment {
    backpack: [u32; ITEMS],
    withdrawals: Vec<(usize, u8, u32)>,
}

impl Payment {
    fn withdraw(self, world: &mut World) {
        for (tile, item, amount) in self.withdrawals {
            let warehouse = &mut world.cells[tile];
            warehouse.set_material(
                item,
                warehouse.inv[item as usize] - amount,
                world.progression.stack_limit(item),
            );
        }
    }
}

fn has_output(kind: u8, dir: u8, flow: u8) -> bool {
    (0..belt_lanes(kind)).any(|lane| belt_outputs(kind, dir, lane).contains(&Some(flow)))
}

impl World {
    // Use the backpack first, then nearby warehouses with tile order as a tie-break.
    fn construction_payment(&self, anchor: usize, mut cost: [u32; ITEMS]) -> Option<Payment> {
        let mut payment = Payment {
            backpack: self.stock,
            withdrawals: Vec::new(),
        };
        for (amount, held) in cost.iter_mut().zip(&mut payment.backpack) {
            let taken = (*amount).min(*held);
            *amount -= taken;
            *held -= taken;
        }
        if cost.iter().all(|&amount| amount == 0) {
            return Some(payment);
        }
        let mut warehouses = self
            .machines
            .iter()
            .copied()
            .filter(|&tile| {
                let cell = &self.cells[tile];
                cell.kind == DEPOT && cell.used_storage_slots > 0
            })
            .collect::<Vec<_>>();
        warehouses.sort_unstable_by_key(|&tile| {
            (
                (tile % W).abs_diff(anchor % W) + (tile / W).abs_diff(anchor / W),
                tile,
            )
        });
        for tile in warehouses {
            for (item, amount) in cost.iter_mut().enumerate().skip(1) {
                let taken = (*amount).min(self.cells[tile].inv[item]);
                if taken > 0 {
                    *amount -= taken;
                    payment.withdrawals.push((tile, item as u8, taken));
                }
            }
            if cost.iter().all(|&amount| amount == 0) {
                return Some(payment);
            }
        }
        None
    }

    pub fn spend_construction(&mut self, anchor: usize, materials: &[(u8, u32)]) -> bool {
        let mut cost = [0; ITEMS];
        for &(item, amount) in materials {
            cost[item as usize] += amount;
        }
        let Some(payment) = self.construction_payment(anchor, cost) else {
            return false;
        };
        self.stock = payment.backpack;
        payment.withdraw(self);
        true
    }

    fn transport_plan(&mut self, words: &[i32]) -> Result<Plan, (i32, i32)> {
        if words.is_empty() || words.len() % 3 != 0 || words.len() / 3 > N {
            return Err((-1, -1));
        }
        self.materialize();
        let mut entries = vec![None; N];
        let mut replacements = Vec::new();
        let mut cost = [0; ITEMS];
        for &[tile, kind, dir] in words.as_chunks::<3>().0 {
            if !(0..N as i32).contains(&tile)
                || !(0..4).contains(&dir)
                || !(0..=MAX_KIND as i32).contains(&kind)
                || !is_belt(kind as u8)
            {
                return Err((-1, tile));
            }
            let (tile, kind, dir) = (tile as usize, kind as u8, dir as u8);
            if entries[tile].replace((kind, dir)).is_some() {
                return Err((-1, tile as i32));
            }
            let old = &self.cells[tile];
            if !self.unlocked(kind) {
                return Err((-6, tile as i32));
            }
            if !self.map_contains(tile) || !permitted(kind, tile, self.progression.regional_map) {
                return Err((-3, tile as i32));
            }
            if self.footprints.owner(tile).is_some() && !is_belt(old.kind) {
                return Err((-2, tile as i32));
            }
            if (kind, dir) == (old.kind, old.dir) {
                continue;
            }
            let mut cargo = [Cargo::default(); 2];
            for lane in 0..belt_lanes(old.kind) {
                let old_cargo = self.cargo[node(tile, lane)];
                if old_cargo.item == 0 {
                    continue;
                }
                let old_flow = (old.dir + lane as u8) % 4;
                let Some(target) = (0..belt_lanes(kind))
                    .find(|&lane| belt_outputs(kind, dir, lane).contains(&Some(old_flow)))
                else {
                    return Err((-20, tile as i32));
                };
                if cargo[target].item != 0 {
                    return Err((-21, tile as i32));
                }
                let location = node(tile, target) as u16;
                cargo[target] = Cargo {
                    from: location,
                    since: self.tick,
                    ready: belt_deadline(
                        self.tick,
                        belt_interval(kind),
                        if self.legacy_recipes {
                            0
                        } else {
                            BELT_RATE[kind as usize]
                        },
                    ),
                    blocked: false,
                    ..old_cargo
                };
            }
            if old.kind != kind {
                for &(item, count) in self.build_materials(kind) {
                    cost[item as usize] += count;
                }
            }
            replacements.push(Replacement {
                tile,
                kind,
                dir,
                cargo,
            });
        }

        for replacement in &replacements {
            let tile = replacement.tile;
            let old = &self.cells[tile];
            if !is_belt(old.kind) || old.kind == replacement.kind {
                continue;
            }
            // Preserve live links to the surrounding network on an upgrade.
            // Connections between cells in the same plan are evaluated together.
            for flow in 0..4 {
                let inbound = neighbor(tile, (flow + 2) % 4).is_some_and(|other| {
                    let inlet = &self.cells[other];
                    let (new_kind, new_dir) = entries[other].unwrap_or((inlet.kind, inlet.dir));
                    has_output(inlet.kind, inlet.dir, flow) && has_output(new_kind, new_dir, flow)
                        || self.footprints.owner(other).is_some_and(|anchor| {
                            self.material_masks(other, anchor).1 & (1 << flow) != 0
                        })
                });
                if inbound
                    && belt_input(old.kind, old.dir, flow).is_some()
                    && belt_input(replacement.kind, replacement.dir, flow).is_none()
                {
                    return Err((-20, tile as i32));
                }
                let mut was_output = has_output(old.kind, old.dir, flow);
                was_output &= neighbor(tile, flow).is_some_and(|other| {
                    let outlet = &self.cells[other];
                    let (new_kind, new_dir) = entries[other].unwrap_or((outlet.kind, outlet.dir));
                    if is_belt(outlet.kind) {
                        return belt_input(outlet.kind, outlet.dir, flow).is_some()
                            && belt_input(new_kind, new_dir, flow).is_some();
                    }
                    self.footprints.owner(other).is_some_and(|anchor| {
                        self.material_masks(other, anchor).0 & (1 << flow) != 0
                    })
                });
                if was_output && !has_output(replacement.kind, replacement.dir, flow) {
                    return Err((-20, tile as i32));
                }
            }
        }
        Ok(Plan {
            replacements,
            cost,
            anchor: words[0] as usize,
        })
    }

    pub fn build_transports(&mut self, revision: i32, words: &[i32]) -> i32 {
        if self.layout_revision != revision {
            return -23;
        }
        let plan = match self.transport_plan(words) {
            Ok(plan) => plan,
            Err((error, _)) => return error,
        };
        let Some(payment) = self.construction_payment(plan.anchor, plan.cost) else {
            return -4;
        };
        if plan.replacements.is_empty() {
            return 1;
        }
        let removals = plan
            .replacements
            .iter()
            .filter(|part| {
                let current = self.cells[part.tile].kind;
                current != 0 && current != part.kind
            })
            .map(|part| (part.tile, [0; ITEMS]))
            .collect::<Vec<_>>();
        if let Err(error) = self.settle_removals(payment.backpack, removals) {
            return error;
        }
        payment.withdraw(self);
        for part in plan.replacements {
            let old = &self.cells[part.tile];
            let same_kind = old.kind == part.kind;
            self.install(
                part.tile,
                Cell {
                    kind: part.kind,
                    dir: part.dir,
                    wire: old.wire,
                    cfg: if same_kind { old.cfg } else { 0 },
                    split_turn: same_kind && old.split_turn,
                    ..Cell::default()
                },
            );
            if !same_kind {
                self.ground
                    .record_device(part.tile, self.build_materials(part.kind), false);
            }
            for (lane, cargo) in part.cargo.into_iter().enumerate() {
                self.cargo[node(part.tile, lane)] = cargo;
            }
        }
        self.rebuild();
        1
    }
}

#[no_mangle]
pub extern "C" fn preview_transports(len: usize) -> usize {
    RUNTIME.with(|runtime| {
        let mut runtime = runtime.borrow_mut();
        let Runtime {
            world,
            input,
            output,
        } = &mut *runtime;
        output.clear();
        let result = input
            .get(..len)
            .ok_or((-1, -1))
            .and_then(|words| world.transport_plan(words));
        match result {
            Ok(plan) => {
                output.extend([
                    if world.construction_payment(plan.anchor, plan.cost).is_some() {
                        1
                    } else {
                        -4
                    },
                    -1,
                    world.layout_revision,
                ]);
                for (item, count) in plan.cost.into_iter().enumerate() {
                    if count > 0 {
                        output.extend([item as i32, count as i32]);
                    }
                }
            }
            Err((error, tile)) => output.extend([error, tile, world.layout_revision]),
        }
        output.len()
    })
}
