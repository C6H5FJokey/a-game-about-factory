use crate::catalog::*;
use crate::world::{Cell, World};

pub fn device_recipe(cell: &Cell, legacy: bool) -> Option<Recipe> {
    if legacy || !PROCESSING[cell.kind as usize] {
        return recipe(cell.kind);
    }
    let mut selected = RECIPES
        .get(usize::from(cell.selected_recipe.checked_sub(1)?))?
        .recipe;
    selected.power = MACHINE_POWER[cell.kind as usize];
    Some(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::campaign::Stage;
    use crate::inventory::STOCK_TILE;

    #[test]
    fn balanced_production_and_selected_recipe_blueprint() {
        let mut world = World::new();
        world.stage = Stage::Sunlight;
        world.orbit.first_light = true;
        world.progression.tier = 1;
        world.stock[IRON as usize] = 60;
        world.stock[COPPER as usize] = 6;
        world.stock[SILICA as usize] = 14;
        world.stock[FUEL as usize] = 200;
        let generators = [index(2, 8), index(3, 8), index(4, 8)];
        for tile in generators {
            world.install(
                tile,
                Cell {
                    kind: GENERATOR,
                    wire: true,
                    ..Cell::default()
                },
            );
        }
        let targets = [
            (SMELTER, IRON_INGOT, 60),
            (SMELTER, 12, 6),
            (SMELTER, 13, 10),
            (BENCH, PLATE, 40),
            (BENCH, 14, 32),
            (BENCH, COPPER_WIRE, 12),
            (BENCH, 16, 10),
            (BENCH, LENS, 4),
            (ASSEMBLER, 17, 8),
            (ASSEMBLER, 18, 4),
            (ASSEMBLER, CORE, 2),
            (KILN, 19, 4),
            (SPLICER, MIRROR, 4),
            (SPLICER, KIT, 4),
        ];
        for x in 2..46 {
            world.cells[index(x, 7)].wire = true;
        }
        let mut lines = Vec::new();
        for (n, (kind, output, amount)) in targets.into_iter().enumerate() {
            let tile = index(2 + n * 3, 7);
            let spec = RECIPES
                .iter()
                .find(|spec| {
                    spec.modern && spec.recipe.output == output && spec.machines.contains(&kind)
                })
                .unwrap();
            assert_eq!(amount % u32::from(spec.recipe.amount), 0);
            let interval = HZ * 60 / (amount / u32::from(spec.recipe.amount));
            assert!(interval >= spec.recipe.ticks);
            world.install(
                tile,
                Cell {
                    kind,
                    wire: true,
                    ..Cell::default()
                },
            );
            if !matches!(output, CORE | MIRROR | KIT) {
                world.stock[output as usize] = amount;
            }
            lines.push((tile, spec.key, spec.recipe, amount, interval, 0));
        }
        world.rebuild();
        for &(tile, key, ..) in &lines {
            assert_eq!(
                world.select_recipe(tile, world.cells[tile].identity, key),
                1
            );
        }
        let initial = world.stock;
        for tick in 0..HZ * 60 {
            if tick % (HZ * 7) == 0 {
                for tile in generators {
                    assert!(
                        world.transfer(
                            STOCK_TILE,
                            tile as i32,
                            FUEL.into(),
                            &[8, 0, world.cells[tile].identity]
                        ) > 0
                    );
                }
            }
            for &(tile, _, recipe, _, interval, _) in &lines {
                if tick % interval != 0 {
                    continue;
                }
                assert_eq!(world.cells[tile].progress, 0);
                for (item, count) in recipe.input.into_iter().filter(|&(_, n)| n > 0) {
                    assert_eq!(
                        world.transfer(
                            STOCK_TILE,
                            tile as i32,
                            item.into(),
                            &[count.into(), 0, world.cells[tile].identity]
                        ),
                        i32::from(count),
                        "feed item {item}"
                    );
                }
            }
            world.step();
            for (tile, _, recipe, _, _, made) in &mut lines {
                let cell = world.cells[*tile];
                let count = cell.inv[recipe.output as usize];
                if count > 0 {
                    assert_eq!(
                        world.transfer(
                            *tile as i32,
                            STOCK_TILE,
                            recipe.output.into(),
                            &[count.into(), cell.identity, 0]
                        ),
                        i32::from(count)
                    );
                    *made += u32::from(count);
                }
            }
        }
        for (tile, _, recipe, amount, _, made) in &lines {
            assert_eq!(made, amount, "output {}", recipe.output);
            assert_eq!(world.cells[*tile].progress, 0);
        }
        for raw in [IRON, SILICA, COPPER] {
            assert_eq!(world.stock[raw as usize], 0);
        }
        for intermediate in [IRON_INGOT, 12, 13, 14, COPPER_WIRE, 16, LENS, 17, 18, 19] {
            assert_eq!(
                world.stock[intermediate as usize],
                initial[intermediate as usize]
            );
        }
        assert_eq!(world.stock[PLATE as usize] - initial[PLATE as usize], 16);
        let (site, _, _, _, _, _) = *lines.last().unwrap();
        let name = b"Kits".map(i32::from);
        let id = world.capture_blueprint(site, site + W + 1, &name);
        assert!(id > 0);
        let mut saved = Vec::new();
        world.blueprints.write_save(&mut saved);
        world.blueprints = crate::blueprints::Library::read_save(&saved).unwrap();
        let rebuilt = index(44, 12);
        assert_eq!(world.deploy_blueprint(rebuilt, id, 1, 0), 1);
        assert_eq!(world.recipe_at(rebuilt).unwrap().output, KIT);
        assert_ne!(world.cells[rebuilt].selected_recipe, 0);
    }
}

impl World {
    pub fn recipe_at(&self, tile: usize) -> Option<Recipe> {
        device_recipe(&self.cells[tile], self.legacy_recipes)
    }

    pub fn select_recipe(&mut self, tile: usize, identity: i32, key: i32) -> i32 {
        let Some(anchor) = self.footprints.owner(tile) else {
            return -15;
        };
        let cell = &self.cells[anchor];
        if identity <= 0 || identity != cell.identity {
            return -15;
        }
        if self.legacy_recipes || !PROCESSING[cell.kind as usize] {
            return -6;
        }
        let Some(index) = recipe_index(key) else {
            return -13;
        };
        let spec = &RECIPES[index];
        if !spec.modern || !spec.machines.contains(&cell.kind) || (self.stage as u8) < spec.unlock {
            return -6;
        }
        let selected = (index + 1) as u16;
        if cell.selected_recipe == selected {
            return 1;
        }
        if cell.progress != 0
            || cell
                .inv
                .iter()
                .enumerate()
                .any(|(item, amount)| item != SPEED_MODULE as usize && *amount != 0)
        {
            return -26;
        }
        self.materialize();
        self.cells[anchor].selected_recipe = selected;
        self.cells[anchor].identity = self.next_device_id;
        self.next_device_id += 1;
        self.rebuild();
        1
    }

    fn handcraft_stock(&self, spec: &RecipeSpec) -> Result<[u32; ITEMS], i32> {
        let Some(handcraft) = &spec.handcraft else {
            return Err(-6);
        };
        if self.legacy_recipes || (self.stage as u8) < handcraft.unlock {
            return Err(-6);
        }
        let mut next = self.stock;
        for (item, amount) in handcraft.input {
            let slot = &mut next[item as usize];
            *slot = slot.checked_sub(u32::from(amount)).ok_or(-8)?;
        }
        let output = &mut next[spec.recipe.output as usize];
        *output = output
            .checked_add(u32::from(spec.recipe.amount))
            .ok_or(-24)?;
        self.fits_stock(&next).then_some(next).ok_or(-24)
    }

    pub fn start_handcraft(&mut self, key: i32, token: i32) -> i32 {
        let Some(index) = recipe_index(key) else {
            return -13;
        };
        if token <= 0 {
            return -1;
        }
        if let Err(error) = self.handcraft_stock(&RECIPES[index]) {
            return error;
        }
        self.handcraft = Some((index, token, self.tick));
        1
    }

    pub fn cancel_handcraft(&mut self, token: i32) -> i32 {
        if self.handcraft.is_some_and(|(_, active, _)| active == token) {
            self.handcraft = None;
        }
        1
    }

    pub fn finish_handcraft(&mut self, token: i32) -> i32 {
        let Some((index, active, started)) = self.handcraft else {
            return -1;
        };
        if token != active {
            return -1;
        }
        let spec = &RECIPES[index];
        if self.tick - started < spec.handcraft.as_ref().unwrap().ticks {
            return -27;
        }
        match self.handcraft_stock(spec) {
            Ok(next) => {
                self.stock = next;
                if self.stage == crate::campaign::Stage::Handwork
                    && spec.recipe.output == COPPER_WIRE
                {
                    self.stage = crate::campaign::Stage::Bench;
                }
                self.handcraft = Some((index, token, self.tick));
                spec.recipe.amount.into()
            }
            Err(error) => {
                self.handcraft = None;
                error
            }
        }
    }

    pub fn build_materials(&self, kind: u8) -> &'static [(u8, u32)] {
        if self.legacy_recipes {
            materials(kind)
        } else {
            NEXT_BUILD_MATERIALS[kind as usize]
        }
    }

    pub fn cable_span(&self) -> u32 {
        if self.legacy_recipes {
            CABLE_SPAN
        } else {
            NEXT_CABLE_SPAN
        }
    }

    pub fn write_recipe_view(&self, out: &mut Vec<i32>) {
        let start = out.len();
        out.extend([
            self.legacy_recipes as i32,
            (32..=MAX_KIND)
                .filter(|&kind| self.unlocked(kind))
                .fold(0, |mask, kind| mask | (1 << (kind - 32))),
        ]);
        out.extend(self.stock[10..].iter().map(|&n| n as i32));
        for &tile in &self.machines {
            let cell = &self.cells[tile];
            if cell.selected_recipe > 0 {
                out.extend([
                    tile as i32,
                    RECIPES[cell.selected_recipe as usize - 1].key,
                    crate::progression::cycle_ticks(
                        self.recipe_at(tile).unwrap().ticks,
                        cell.inv[SPEED_MODULE as usize],
                    ) as i32,
                ]);
            }
        }
        out.push(start as i32);
    }

    pub fn write_recipe_save(&self, out: &mut Vec<i32>) {
        out.push(self.legacy_recipes as i32);
        out.extend(self.stock[10..].iter().map(|&n| n as i32));
        for route in &self.routes {
            out.extend(route.crate_stock[10..].iter().map(|&n| i32::from(n)));
        }
        for cell in self.cells.iter().filter(|cell| cell.kind != 0) {
            out.push(if cell.selected_recipe == 0 {
                0
            } else {
                RECIPES[cell.selected_recipe as usize - 1].key
            });
            out.extend(cell.inv[10..].iter().map(|&n| i32::from(n)));
            out.extend([i32::from(cell.belt_iron), cell.belt_batch as i32]);
        }
    }

    pub fn read_recipe_save<'a>(&mut self, data: &'a [i32]) -> Option<&'a [i32]> {
        let (&legacy, mut rest) = data.split_first()?;
        if !matches!(legacy, 0 | 1) {
            return None;
        }
        self.legacy_recipes = legacy == 1;
        let extra = ITEMS - 10;
        let (stock, tail) = rest.split_at_checked(extra)?;
        for (slot, &amount) in self.stock[10..].iter_mut().zip(stock) {
            *slot = u32::try_from(amount).ok()?;
        }
        rest = tail;
        for route in &mut self.routes {
            let (counts, tail) = rest.split_at_checked(extra)?;
            for (slot, &amount) in route.crate_stock[10..].iter_mut().zip(counts) {
                *slot = u16::try_from(amount)
                    .ok()
                    .filter(|&n| n <= crate::regions::CRATE_SIZE)?;
            }
            rest = tail;
        }
        for cell in self.cells.iter_mut().filter(|cell| cell.kind != 0) {
            let (&key, tail) = rest.split_first()?;
            if key != 0 {
                let index = recipe_index(key)?;
                let spec = &RECIPES[index];
                if legacy == 1
                    || !spec.modern
                    || !spec.machines.contains(&cell.kind)
                    || (self.stage as u8) < spec.unlock
                {
                    return None;
                }
                cell.selected_recipe = (index + 1) as u16;
            }
            let (counts, tail) = tail.split_at_checked(extra)?;
            for (slot, &amount) in cell.inv[10..].iter_mut().zip(counts) {
                *slot = u16::try_from(amount).ok().filter(|&n| n <= 32)?;
            }
            let [belt_iron, belt_batch, next @ ..] = tail else {
                return None;
            };
            cell.belt_iron = u16::try_from(*belt_iron)
                .ok()
                .filter(|&n| n <= cell.inv[IRON_INGOT as usize])?;
            cell.belt_batch = match belt_batch {
                0 => false,
                1 if cell.progress > 0 => true,
                _ => return None,
            };
            if legacy == 0 && PROCESSING[cell.kind as usize] {
                if let Some(recipe) = device_recipe(cell, false) {
                    if cell.inv.iter().enumerate().any(|(i, &amount)| {
                        amount != 0
                            && i != SPEED_MODULE as usize
                            && i != recipe.output as usize
                            && !recipe
                                .input
                                .iter()
                                .any(|&(item, n)| usize::from(item) == i && n > 0)
                    }) {
                        return None;
                    }
                } else if cell.progress != 0
                    || cell
                        .inv
                        .iter()
                        .enumerate()
                        .any(|(i, &n)| i != SPEED_MODULE as usize && n != 0)
                {
                    return None;
                }
            }
            rest = next;
        }
        Some(rest)
    }
}
