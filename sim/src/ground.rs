use std::collections::{BTreeMap, HashSet};

use crate::catalog::*;
use crate::world::World;

const MAX_COUNT: u32 = i32::MAX as u32;
type Materials = [u32; ITEMS];
type MaterialRows = Box<[(u8, u32)]>;

enum Payment {
    Materials(MaterialRows),
    PackedMiner,
    Bundle(i32),
}

struct Bundle {
    materials: MaterialRows,
    remaining: usize,
}

#[derive(Clone, Copy)]
struct Pile {
    id: i32,
    count: u32,
}

pub struct Ground {
    next_id: i32,
    piles: BTreeMap<(usize, u8), Pile>,
    payments: BTreeMap<usize, Payment>,
    bundles: BTreeMap<i32, Bundle>,
}

pub fn cable_payment_site(tile: usize) -> usize {
    N + tile
}

fn read_materials(data: &[i32], len: i32, max: i32) -> Option<(MaterialRows, &[i32])> {
    if !(1..ITEMS as i32).contains(&len) {
        return None;
    }
    let (rows, tail) = data.split_at_checked(len as usize * 2)?;
    let mut seen = [false; ITEMS];
    let mut materials = Vec::with_capacity(len as usize);
    for &[item, count] in rows.as_chunks::<2>().0 {
        if !(1..ITEMS as i32).contains(&item)
            || !(1..=max).contains(&count)
            || std::mem::replace(&mut seen[item as usize], true)
        {
            return None;
        }
        materials.push((item as u8, count as u32));
    }
    Some((materials.into_boxed_slice(), tail))
}

impl Default for Ground {
    fn default() -> Self {
        Self {
            next_id: 1,
            piles: BTreeMap::new(),
            payments: BTreeMap::new(),
            bundles: BTreeMap::new(),
        }
    }
}

impl Ground {
    pub fn record_device(&mut self, tile: usize, materials: &[(u8, u32)], packed: bool) {
        let payment = if packed {
            Payment::PackedMiner
        } else {
            Payment::Materials(materials.into())
        };
        self.payments.insert(tile, payment);
    }

    pub fn record_bundle(
        &mut self,
        id: i32,
        materials: &[(u8, u32)],
        sites: impl IntoIterator<Item = usize>,
    ) {
        let mut remaining = 0;
        for site in sites {
            self.payments.insert(site, Payment::Bundle(id));
            remaining += 1;
        }
        if remaining > 0 {
            self.bundles.insert(
                id,
                Bundle {
                    materials: materials.into(),
                    remaining,
                },
            );
        }
    }

    fn can_add(&self, tile: usize, item: u8, count: u32) -> bool {
        let current = self.piles.get(&(tile, item)).map_or(0, |pile| pile.count);
        count <= MAX_COUNT - current
    }

    fn add(&mut self, tile: usize, item: u8, count: u32) {
        self.piles
            .entry((tile, item))
            .and_modify(|pile| pile.count += count)
            .or_insert_with(|| {
                let id = self.next_id;
                self.next_id += 1;
                Pile { id, count }
            });
    }

    pub fn write_view(&self, out: &mut Vec<i32>) {
        let start = out.len();
        self.append_view(out, |_| true);
        out.push(start as i32);
    }

    pub fn append_view(&self, out: &mut Vec<i32>, include: impl Fn(usize) -> bool) {
        for (&(tile, item), pile) in &self.piles {
            if include(tile) {
                wire::Ground {
                    tile: tile as i32,
                    item: item.into(),
                    id: pile.id,
                    count: pile.count as i32,
                }
                .append(out);
            }
        }
    }

    pub fn write_save(&self, out: &mut Vec<i32>) {
        out.extend([
            self.next_id,
            self.piles.len() as i32,
            self.payments.len() as i32,
            self.bundles.len() as i32,
        ]);
        for (&(tile, item), pile) in &self.piles {
            out.extend([tile as i32, item.into(), pile.id, pile.count as i32]);
        }
        for (&tile, payment) in &self.payments {
            out.push(tile as i32);
            match payment {
                Payment::Materials(rows) => {
                    out.extend([0, rows.len() as i32]);
                    for &(item, count) in rows {
                        out.extend([item.into(), count as i32]);
                    }
                }
                Payment::PackedMiner => out.extend([1, 0]),
                Payment::Bundle(id) => out.extend([2, *id]),
            }
        }
        for (&id, bundle) in &self.bundles {
            out.extend([id, bundle.materials.len() as i32, bundle.remaining as i32]);
            for &(item, count) in &bundle.materials {
                out.extend([item.into(), count as i32]);
            }
        }
    }
}

impl World {
    // Construction passes the inventory after payment. All refunds are validated
    // before either the layout or any inventory changes.
    pub fn settle_removals(
        &mut self,
        mut stock: Materials,
        removals: impl IntoIterator<Item = (usize, Materials)>,
    ) -> Result<(), i32> {
        let mut tiles = Vec::new();
        let mut drops = Vec::new();
        let mut groups = BTreeMap::new();
        let mut packed = self.packed_miners;
        let mut new_piles = 0i32;
        for (site, mut returned) in removals {
            tiles.push(site);
            let tile = site % N;
            match self.ground.payments.get(&site) {
                Some(Payment::Materials(cost)) => {
                    for &(item, count) in cost.iter() {
                        returned[item as usize] += count;
                    }
                }
                Some(Payment::Bundle(id)) => {
                    let bundle = &self.ground.bundles[id];
                    let remaining = groups.entry(*id).or_insert(bundle.remaining);
                    *remaining -= 1;
                    if *remaining == 0 {
                        for &(item, count) in &bundle.materials {
                            returned[item as usize] += count;
                        }
                    }
                }
                Some(Payment::PackedMiner) => packed = packed.checked_add(1).ok_or(-24)?,
                None if site < N && self.cells[tile].kind == SIMPLE_MINER => {
                    packed = packed.checked_add(1).ok_or(-24)?
                }
                None => {}
            }
            for (item, total) in returned
                .into_iter()
                .enumerate()
                .skip(1)
                .filter(|&(_, n)| n > 0)
            {
                let item = item as u8;
                let accepted = total.min(self.stock_room_for(&stock, item));
                stock[item as usize] += accepted;
                let excess = total - accepted;
                if excess == 0 {
                    continue;
                }
                if !self.ground.can_add(tile, item, excess) {
                    return Err(-29);
                }
                new_piles += i32::from(!self.ground.piles.contains_key(&(tile, item)));
                drops.push((tile, item, excess));
            }
        }
        self.ground.next_id.checked_add(new_piles).ok_or(-29)?;
        self.stock = stock;
        self.packed_miners = packed;
        for tile in tiles {
            self.ground.payments.remove(&tile);
        }
        for (id, remaining) in groups {
            if remaining == 0 {
                self.ground.bundles.remove(&id);
            } else {
                self.ground.bundles.get_mut(&id).unwrap().remaining = remaining;
            }
        }
        for (tile, item, count) in drops {
            self.ground.add(tile, item, count);
        }
        Ok(())
    }

    pub fn drop_held(&mut self, tile: usize, item: i32, count: i32) -> i32 {
        if tile >= N || !self.map_contains(tile) {
            return -3;
        }
        if !(1..ITEMS as i32).contains(&item) || count <= 0 {
            return -1;
        }
        let (item, amount) = (item as u8, count as u32);
        if self.stock[item as usize] < amount {
            return -9;
        }
        if !self.ground.can_add(tile, item, amount)
            || self.ground.next_id == i32::MAX && !self.ground.piles.contains_key(&(tile, item))
        {
            return -29;
        }
        self.stock[item as usize] -= amount;
        self.ground.add(tile, item, amount);
        count
    }

    pub fn pick_ground(&mut self, tile: usize, item: i32, identity: i32) -> i32 {
        if tile >= N || !self.map_contains(tile) {
            return -3;
        }
        if !(1..ITEMS as i32).contains(&item) {
            return -1;
        }
        let key = (tile, item as u8);
        let Some(pile) = self
            .ground
            .piles
            .get(&key)
            .copied()
            .filter(|p| p.id == identity)
        else {
            return -28;
        };
        let picked = pile.count.min(self.stock_room(item as u8));
        if picked == 0 {
            return -24;
        }
        self.stock[item as usize] += picked;
        if picked == pile.count {
            self.ground.piles.remove(&key);
        } else {
            self.ground.piles.get_mut(&key).unwrap().count -= picked;
        }
        picked as i32
    }

    pub fn read_ground_save<'a>(
        &mut self,
        data: &'a [i32],
        grouped_materials: bool,
    ) -> Option<&'a [i32]> {
        let [next_id, piles, payments, bundles, rest @ ..] = data else {
            return None;
        };
        let mut rest = rest;
        let (piles, payments, bundles) = (
            usize::try_from(*piles).ok()?,
            usize::try_from(*payments).ok()?,
            usize::try_from(*bundles).ok()?,
        );
        if *next_id < 1 || piles > N * (ITEMS - 1) || payments > 2 * N || bundles > payments {
            return None;
        }
        let mut ids = HashSet::with_capacity(piles);
        let mut membership = BTreeMap::new();
        self.ground.next_id = *next_id;
        for _ in 0..piles {
            let [tile, item, id, count, tail @ ..] = rest else {
                return None;
            };
            let tile = usize::try_from(*tile).ok()?;
            if tile >= N
                || !self.map_contains(tile)
                || !(1..ITEMS as i32).contains(item)
                || !(1..*next_id).contains(id)
                || *count <= 0
                || !ids.insert(*id)
            {
                return None;
            }
            if self
                .ground
                .piles
                .insert(
                    (tile, *item as u8),
                    Pile {
                        id: *id,
                        count: *count as u32,
                    },
                )
                .is_some()
            {
                return None;
            }
            rest = tail;
        }
        for _ in 0..payments {
            let [tile, kind, value, tail @ ..] = rest else {
                return None;
            };
            let site = usize::try_from(*tile).ok()?;
            if site >= 2 * N {
                return None;
            }
            let cell = &self.cells[site % N];
            if (site < N && cell.kind == 0) || (site >= N && (!cell.wire || *kind != 2)) {
                return None;
            }
            rest = tail;
            let payment = match kind {
                0 => {
                    let (materials, tail) = read_materials(rest, *value, u16::MAX.into())?;
                    rest = tail;
                    Payment::Materials(materials)
                }
                1 if *value == 0 && cell.kind == SIMPLE_MINER => Payment::PackedMiner,
                2 if (1..self.next_device_id).contains(value) => {
                    *membership.entry(*value).or_insert(0usize) += 1;
                    Payment::Bundle(*value)
                }
                _ => return None,
            };
            if self.ground.payments.insert(site, payment).is_some() {
                return None;
            }
        }
        for _ in 0..bundles {
            let [id, value, count, tail @ ..] = rest else {
                return None;
            };
            let remaining = membership.remove(id)?;
            if remaining as i32 != *count {
                return None;
            }
            rest = tail;
            let materials = if grouped_materials {
                let (materials, tail) =
                    read_materials(rest, *value, i32::from(u16::MAX).saturating_mul(N as i32))?;
                rest = tail;
                materials
            } else {
                if !(1..=N as i32).contains(value) {
                    return None;
                }
                Box::new([(KIT, *value as u32)])
            };
            self.ground.bundles.insert(
                *id,
                Bundle {
                    materials,
                    remaining,
                },
            );
        }
        membership.is_empty().then_some(rest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::campaign::Stage;

    #[test]
    fn a_failed_cable_refund_leaves_the_route_and_all_receipts_intact() {
        let mut world = World::new();
        world.stage = Stage::Power;
        let first = index(18, 19);
        world.stock[COPPER_WIRE as usize] = 10;
        assert_eq!(
            world.route(true, &[first as i32, 0, (first + 1) as i32, 0]),
            1
        );
        assert_eq!(world.route(true, &[(first + 2) as i32, 0]), 1);
        world.stock = [0; ITEMS];
        world.stock[IRON as usize] = 1600;
        world.ground.add(first + 2, COPPER_WIRE, MAX_COUNT);
        let path = [first as i32, (first + 1) as i32, (first + 2) as i32];
        assert_eq!(world.remove_cables(&path), -29);
        assert!(world.cells[first..first + 3].iter().all(|cell| cell.wire));
        assert_eq!(world.ground.piles.len(), 1);
        assert_eq!(world.stock[COPPER_WIRE as usize], 0);
        world.ground.piles.remove(&(first + 2, COPPER_WIRE));
        assert_eq!(world.remove_cables(&path), 1);
        assert_eq!(world.ground.piles[&(first + 1, COPPER_WIRE)].count, 4);
        assert_eq!(world.ground.piles[&(first + 2, COPPER_WIRE)].count, 2);
    }

    #[test]
    fn dismantling_fills_partial_stack_and_keeps_overflow() {
        let mut world = World::new();
        world.stock[IRON as usize] = 10;
        assert_eq!(world.place(FIRST_ORE, SIMPLE_MINER.into(), 0), 1);
        for _ in 0..3 * HZ {
            world.step();
        }
        world.stock[IRON as usize] = 98;
        world.stock[PLATE as usize] = 1500;
        assert_eq!(world.remove(FIRST_ORE, false), 1);
        assert_eq!(world.stock[IRON as usize], 100);
        assert_eq!(world.cells[FIRST_ORE].kind, 0);
        assert_eq!(world.packed_miners, 0);
        let key = (FIRST_ORE, IRON);
        let id = world.ground.piles[&key].id;
        assert_eq!(world.ground.piles[&key].count, 9);
        assert_eq!(world.pick_ground(FIRST_ORE, IRON.into(), id), -24);
        assert_eq!(world.drop_held(0, IRON.into(), 2), -3);
        assert_eq!(world.drop_held(FIRST_ORE + 1, IRON.into(), 2), 2);
        assert_eq!(world.pick_ground(FIRST_ORE, IRON.into(), id), 2);
        assert_eq!(world.ground.piles[&key].count, 7);
        assert_eq!(world.drop_held(FIRST_ORE, IRON.into(), 1), 1);
        assert_eq!(world.ground.piles[&key].id, id);
        assert_eq!(world.ground.piles[&key].count, 8);
        assert_eq!(world.drop_held(FIRST_ORE, PLATE.into(), 100), 100);
        assert_eq!(world.pick_ground(FIRST_ORE, IRON.into(), id), 8);
        assert_eq!(world.drop_held(FIRST_ORE, IRON.into(), 1), 1);
        let next = world.ground.piles[&key].id;
        assert_ne!(next, id);
        assert_eq!(world.pick_ground(FIRST_ORE, IRON.into(), id), -28);
        assert_eq!(world.pick_ground(FIRST_ORE, IRON.into(), next), 1);
        assert_eq!(world.stock[IRON as usize], 107);
        assert_eq!(world.ground.piles[&(FIRST_ORE + 1, IRON)].count, 2);
    }

    #[test]
    fn saved_bundle_refunds_once_after_last_device_is_replaced() {
        let mut world = World::new();
        world.stage = Stage::Sunlight;
        world.orbit.first_light = true;
        world.stock[KIT as usize] = 2;
        world.stock[PLATE as usize] = 5;
        let first = index(12, 10);
        assert_eq!(world.place(first, BELT.into(), 0), 1);
        assert_eq!(world.place(first + 1, BELT.into(), 0), 1);
        world.cells[first].wire = true;
        let id = world.capture_blueprint(first, first + 1, &[i32::from(b'A')]);
        let built = index(15, 10);
        assert_eq!(world.deploy_blueprint(built, id, 1, 0), 1);
        assert_eq!(world.remove(built, false), 1);
        assert_eq!(world.stock[KIT as usize], 0);
        let mut saved = Vec::new();
        world.ground.write_save(&mut saved);
        world.ground = Ground::default();
        assert_eq!(world.read_ground_save(&saved, true), Some(&[][..]));
        assert_eq!(
            world.build_transports(
                world.layout_revision,
                &[(built + 1) as i32, FAST_BELT.into(), 0]
            ),
            1
        );
        assert_eq!(world.stock[KIT as usize], 0);
        assert_eq!(world.remove(built, true), 1);
        assert_eq!(world.stock[KIT as usize], 2);
        assert_eq!(world.stock[PLATE as usize], 1);
        assert_eq!(world.remove(built + 1, false), 1);
        assert_eq!(world.stock[KIT as usize], 2);
        assert_eq!(world.stock[PLATE as usize], 3);
    }

    #[test]
    fn refunds_the_recorded_price_and_returns_a_packed_miner_once() {
        let mut world = World::new();
        world.stock[IRON as usize] = 10;
        assert_eq!(world.place(FIRST_ORE, SIMPLE_MINER.into(), 0), 1);
        world.legacy_recipes = true;
        assert_eq!(world.build_materials(SIMPLE_MINER), &[(IRON, 5)]);
        assert_eq!(world.remove(FIRST_ORE, false), 1);
        assert_eq!(world.stock[IRON as usize], 10);
        assert_eq!(world.packed_miners, 0);
        world.packed_miners = 1;
        assert_eq!(world.place(FIRST_ORE, SIMPLE_MINER.into(), 0), 1);
        assert_eq!(world.remove(FIRST_ORE, false), 1);
        assert_eq!(world.packed_miners, 1);
        assert_eq!(world.stock[IRON as usize], 10);
    }
}
