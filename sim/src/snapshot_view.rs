use crate::belts::node;
use crate::campaign::Stage;
use crate::catalog::*;
use crate::world::World;
use crate::{write_snapshot_grids, write_snapshot_header, Runtime, HEADER, RUNTIME};

const DIRECTORY: usize = HEADER + view::BOUNDS_WORDS;
const VIEW_CELLS: usize = DIRECTORY + view::SECTION_COUNT + 1;

struct Scope {
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    extra: Vec<usize>,
}

impl Scope {
    fn new(world: &World, bounds: [i32; 4], watched: [i32; view::WATCHED_TILES]) -> Self {
        let [left, top, right, bottom] = bounds;
        let left = left.clamp(0, W as i32) as usize;
        let top = top.clamp(0, H as i32) as usize;
        let mut scope = Self {
            left,
            top,
            right: right.clamp(left as i32, W as i32) as usize,
            bottom: bottom.clamp(top as i32, H as i32) as usize,
            extra: Vec::new(),
        };
        scope.extra = watched
            .into_iter()
            .filter_map(|tile| usize::try_from(tile).ok())
            .chain(STATIONS)
            .chain(SENDERS)
            .chain(RECEIVERS)
            .chain(world.machines.iter().copied().filter(|&tile| {
                matches!(world.cells[tile].kind, KIT_PRESS | SPLICER)
                    || (world.stage <= Stage::Collect && world.cells[tile].kind == SIMPLE_MINER)
            }))
            .filter(|&tile| tile < N && !scope.in_rectangle(tile))
            .collect();
        scope.extra.sort_unstable();
        scope.extra.dedup();
        scope
    }

    fn in_rectangle(&self, tile: usize) -> bool {
        (self.left..self.right).contains(&(tile % W))
            && (self.top..self.bottom).contains(&(tile / W))
    }

    fn includes(&self, tile: usize) -> bool {
        self.in_rectangle(tile) || self.extra.binary_search(&tile).is_ok()
    }

    fn tiles(&self) -> impl Iterator<Item = usize> + '_ {
        (self.top..self.bottom).flat_map(|y| y * W + self.left..y * W + self.right)
    }
}

#[no_mangle]
pub extern "C" fn snapshot_layout(revision: i32, stage: i32, cached: i32) -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, output, .. } = &mut *runtime;
        if cached != 0 && revision == world.view_revision && stage == world.stage as i32 {
            return 0;
        }
        output.clear();
        output.extend([world.view_revision, world.stage as i32]);
        debug_assert_eq!(output.len(), view::LAYOUT_HEADER_WORDS);
        for (tile, cell) in world.cells.iter().enumerate() {
            let row: [i32; view::LAYOUT_FIELDS.len()] = [
                cell.kind.into(),
                cell.dir.into(),
                cell.wire.into(),
                world.known_ore(tile).into(),
                cell.group as i32,
            ];
            output.extend(row);
        }
        world.write_machine_footprints(output);
        output.pop();
        output.len()
    })
}

fn append_dynamic_cell(world: &World, tile: usize, out: &mut Vec<i32>) {
    let cell = &world.cells[tile];
    let first = world.cargo[node(tile, 0)];
    let cargo = if first.item != 0 {
        first
    } else {
        world.cargo[node(tile, 1)]
    };
    let status = if cargo.item != 0 && is_belt(cell.kind) {
        if cargo.blocked {
            4
        } else {
            1
        }
    } else {
        cell.status
    };
    let start = out.len();
    out.extend([
        cargo.item.into(),
        status.into(),
        cell.cfg.into(),
        cell.progress as i32,
        cell.energy as i32,
    ]);
    out.extend(cell.inv[1..LEGACY_MATERIAL_ITEMS].iter().map(|&n| n as i32));
    out.push(cell.delivering_kits(world.tick).into());
    debug_assert_eq!(out.len() - start, view::DYNAMIC_FIELDS.len());
}

fn section(out: &mut [i32], id: usize) {
    out[DIRECTORY + id] = out.len() as i32;
}

#[no_mangle]
pub extern "C" fn snapshot_view(
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    selected: i32,
    info: i32,
    ground: i32,
    source: i32,
) -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, output, .. } = &mut *runtime;
        let scope = Scope::new(
            world,
            [left, top, right, bottom],
            [selected, info, ground, source],
        );
        world.materialize();
        output.clear();
        write_snapshot_header(world, output);
        output.extend([
            scope.left as i32,
            scope.top as i32,
            scope.right as i32,
            scope.bottom as i32,
        ]);
        output.resize(VIEW_CELLS, 0);
        for tile in scope.tiles() {
            append_dynamic_cell(world, tile, output);
        }
        section(output, view::EXTRA_TILES);
        for &tile in &scope.extra {
            output.push(tile as i32);
            append_dynamic_cell(world, tile, output);
        }
        section(output, view::GRIDS);
        write_snapshot_grids(world, output);
        section(output, view::GROUND);
        world
            .ground
            .append_view(output, |tile| scope.includes(tile));
        section(output, view::RECIPES);
        world.append_recipe_view(output, |tile| scope.includes(tile));
        section(output, view::PROGRESSION);
        world.write_progression(output);
        section(output, view::TRANSPORT);
        output.push(world.layout_revision);
        for tile in scope.tiles().chain(scope.extra.iter().copied()) {
            world.append_cargo_view(output, node(tile, 0));
            world.append_cargo_view(output, node(tile, 1));
        }
        world.append_arrival_view(output, |tile| scope.includes(tile));
        section(output, view::DEVICES);
        world.append_device_data(output, |tile| scope.includes(tile));
        section(output, view::WAREHOUSES);
        for &tile in &world.machines {
            let cell = &world.cells[tile];
            if cell.kind == DEPOT && cell.used_storage_slots > 0 {
                for (item, &count) in cell
                    .inv
                    .iter()
                    .enumerate()
                    .skip(1)
                    .filter(|(_, count)| **count > 0)
                {
                    wire::Warehouse {
                        tile: tile as i32,
                        item: item as i32,
                        count: count as i32,
                    }
                    .append(output);
                }
            }
        }
        section(output, view::FAULTS);
        output.extend(
            world
                .machines
                .iter()
                .copied()
                .filter(|&tile| world.cells[tile].status == 3)
                .map(|tile| tile as i32),
        );
        section(output, view::SECTION_COUNT);
        output.len()
    })
}
