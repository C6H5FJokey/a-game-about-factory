use std::cell::RefCell;

use crate::belts::NODES;
use crate::campaign::Stage;
use crate::catalog::*;
use crate::world::{Cell, World};
use crate::{Runtime, RUNTIME};

const BLOCK_WIDTH: usize = 28;
const BLOCK_HEIGHT: usize = 10;
const MERGE_COLUMN: usize = 3;
const SPLIT_COLUMN: usize = 19;
const LAST_COLUMN: usize = BLOCK_WIDTH - 1;

struct Line {
    sources: [usize; 2],
    sinks: [usize; 2],
    processor: usize,
    input: u8,
    output: u8,
    period: u32,
    phase: u32,
    supplied: u32,
}

thread_local! {
    static LINES: RefCell<Vec<Line>> = const { RefCell::new(Vec::new()) };
}

const EXERCISE_PROCESSOR: usize = index(39, 42);

fn with_exercise_line<T>(use_line: impl FnOnce(&Line) -> T) -> T {
    LINES.with(|lines| {
        let lines = lines.borrow();
        let line = lines
            .iter()
            .find(|line| line.processor == EXERCISE_PROCESSOR)
            .expect("terminal exercise line");
        use_line(line)
    })
}

fn install(world: &mut World, tile: usize, kind: u8, dir: u8, cfg: u8) {
    world.install(
        tile,
        Cell {
            kind,
            dir,
            cfg,
            ..Cell::default()
        },
    );
}

fn processing_recipe(input: u8) -> u16 {
    let recipe = RECIPES
        .iter()
        .position(|spec| {
            spec.modern
                && spec.machines.contains(&SMELTER)
                && spec.recipe.input == [(input, 1), (0, 0), (0, 0)]
                && spec.recipe.amount == 1
        })
        .expect("default smelting recipe");
    (recipe + 1) as u16
}

fn add_block(world: &mut World, lines: &mut Vec<Line>, left: usize, top: usize) {
    let tile = |x, y| index(left + x, top + y);
    let branch = BLOCK_HEIGHT - 1;
    let processor_column = if top / BLOCK_HEIGHT % 2 == 0 { 11 } else { 16 };
    for y in 0..branch {
        let input = if y < 4 { COPPER } else { SILICA };
        let source = tile(0, y);
        let sink = tile(LAST_COLUMN, y);
        let processor = tile(processor_column, y);
        install(world, source, DEPOT, 0, input);
        install(world, sink, DEPOT, 0, 0);
        install(world, processor, SMELTER, 0, 0);
        world.cells[processor].wire = true;
        world.cells[processor].selected_recipe = processing_recipe(input);
        let recipe = world.recipe_at(processor).expect("profile recipe");
        let period = recipe.ticks;

        for x in 1..LAST_COLUMN {
            if x != processor_column {
                install(world, tile(x, y), BELT, 0, 0);
            }
        }

        let mut sources = [source; 2];
        let mut sinks = [sink; 2];
        if y == branch - 1 {
            sources[1] = tile(0, branch);
            sinks[1] = tile(LAST_COLUMN, branch);
            install(world, sources[1], DEPOT, 0, input);
            for x in 1..=MERGE_COLUMN {
                install(
                    world,
                    tile(x, branch),
                    BELT,
                    if x == MERGE_COLUMN { 3 } else { 0 },
                    0,
                );
            }
            install(world, tile(SPLIT_COLUMN, y), SPLITTER, 0, 0);
            for x in SPLIT_COLUMN..LAST_COLUMN {
                install(world, tile(x, branch), BELT, 0, 0);
            }
            install(world, sinks[1], DEPOT, 0, 0);
        }
        lines.push(Line {
            sources,
            sinks,
            processor,
            input,
            output: recipe.output,
            period,
            phase: lines.len() as u32 % period,
            supplied: 0,
        });
    }
    for x in [processor_column - 1, processor_column + 1] {
        let generator = tile(x, branch);
        install(world, generator, GENERATOR, 0, 0);
        world.cells[generator].inv[FUEL as usize] = 100;
    }
    for x in processor_column - 1..=processor_column + 1 {
        world.cells[tile(x, branch)].wire = true;
    }
}

#[no_mangle]
pub extern "C" fn prepare_terminal_profile() {
    let mut world = World::new();
    world.stage = Stage::Silica;
    let mut lines = Vec::new();
    for y in (0..=H - BLOCK_HEIGHT).step_by(BLOCK_HEIGHT) {
        for x in (0..=W - BLOCK_WIDTH).step_by(BLOCK_WIDTH) {
            if STATIONS.iter().any(|&station| {
                (x..x + BLOCK_WIDTH).contains(&(station % W))
                    && (y..y + BLOCK_HEIGHT).contains(&(station / W))
            }) {
                continue;
            }
            add_block(&mut world, &mut lines, x, y);
        }
    }
    world.rebuild();
    RUNTIME.with(|rt| rt.borrow_mut().world = world);
    LINES.with(|state| *state.borrow_mut() = lines);
}

// Fixture sources feed at the selected recipe rate. Production, power and all
// transfers are performed by the usual world step.
#[no_mangle]
pub extern "C" fn feed_terminal_profile() -> u32 {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let world = &mut runtime.world;
        LINES.with(|state| {
            let mut supplied = 0;
            for line in state.borrow_mut().iter_mut() {
                if world.tick % line.period != line.phase {
                    continue;
                }
                let side = (world.tick / line.period % 2) as usize;
                let cell = &mut world.cells[line.sources[side]];
                if cell.inv[line.input as usize] == 0 {
                    cell.set_material(line.input, 1, world.progression.stack_limit(line.input));
                    supplied += 1;
                    line.supplied += 1;
                }
            }
            supplied
        })
    })
}

#[no_mangle]
pub extern "C" fn rebuild_terminal_profile() {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        runtime.world.materialize();
        runtime.world.rebuild();
    });
}

#[no_mangle]
pub extern "C" fn terminal_profile_stats() -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, output, .. } = &mut *runtime;
        let mut upper_sources = 0;
        let mut cargo_count = 0;
        for segment in &world.belt.segments {
            cargo_count += segment.queue.len();
            for cargo in &segment.queue {
                let location = segment.nodes[cargo.offset as usize] / 2;
                let from = cargo.from as usize / 2;
                assert!((0..NODES as i32).contains(&cargo.from));
                assert_eq!(
                    (from % W).abs_diff(location % W) + (from / W).abs_diff(location / W),
                    1
                );
                upper_sources += i32::from(cargo.from > i32::from(u16::MAX));
            }
        }
        LINES.with(|state| {
            let lines = state.borrow();
            let mut sources = 0;
            let mut delivered = 0;
            let mut running = 0;
            for line in lines.iter() {
                running += i32::from(world.cells[line.processor].status == 1);
                sources += world.cells[line.sources[0]].inv[line.input as usize];
                delivered += world.cells[line.sinks[0]].inv[line.output as usize];
                if line.sources[0] != line.sources[1] {
                    sources += world.cells[line.sources[1]].inv[line.input as usize];
                    delivered += world.cells[line.sinks[1]].inv[line.output as usize];
                }
            }
            output.clear();
            output.extend([
                world.cells.iter().filter(|cell| is_belt(cell.kind)).count() as i32,
                lines.len() as i32,
                running,
                world.grids.len() as i32 - 1,
                sources as i32,
                delivered as i32,
                upper_sources,
                cargo_count as i32,
                world.tick as i32,
            ]);
            output.len()
        })
    })
}

// Fund construction and leave four spaces at the sink and five at the
// processor output, so backpressure reaches the processor during the run.
#[no_mangle]
pub extern "C" fn prepare_terminal_exercise() {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let world = &mut runtime.world;
        world.progression.tier = 1;
        let mut stock = world.stock;
        for (kind, copies) in [(BELT, 112), (EXPRESS_BELT, 12), (CABLE, 6)] {
            for &(item, amount) in world.build_materials(kind) {
                stock[item as usize] += copies * amount;
            }
        }
        assert!(world.fits_stock(&stock));
        world.stock = stock;
        with_exercise_line(|line| {
            let tile = line.sinks[0];
            let room = world.input_room(tile, line.output).expect("terminal sink");
            let count = world.cells[tile].inv[line.output as usize] + room - 4;
            world.cells[tile].set_material(
                line.output,
                count,
                world.progression.stack_limit(line.output),
            );
            let output_stack = world.progression.stack_limit(line.output);
            world.cells[line.processor].inv[line.output as usize] =
                u32::from(OUTPUT_SLOTS[SMELTER as usize]) * output_stack - 5;
        });
    });
}

#[no_mangle]
pub extern "C" fn terminal_exercise_state() -> usize {
    RUNTIME.with(|rt| {
        let mut runtime = rt.borrow_mut();
        let Runtime { world, output, .. } = &mut *runtime;
        with_exercise_line(|line| {
            let source = &world.cells[line.sources[0]];
            let sink_tile = line.sinks[0];
            let sink = &world.cells[sink_tile];
            let machine = &world.cells[line.processor];
            let mut cargo_count = 0;
            let mut blocked = 0;
            let mut ids = Vec::new();
            for segment in &world.belt.segments {
                for cargo in &segment.queue {
                    let tile = segment.nodes[cargo.offset as usize] / 2;
                    if (line.sources[0]..sink_tile).contains(&tile) {
                        cargo_count += 1;
                        blocked += i32::from(cargo.blocked);
                        ids.push(cargo.id);
                    }
                }
            }
            let sink_count = sink.inv[line.output as usize];
            let total = source.inv[line.input as usize]
                + machine.inv[line.input as usize]
                + machine.inv[line.output as usize]
                + u32::from(machine.progress > 0)
                + sink_count
                + world.stock[line.output as usize]
                + cargo_count;
            output.clear();
            output.extend([
                world.tick as i32,
                world.layout_revision,
                line.processor as i32,
                sink_tile as i32,
                sink.identity,
                line.output.into(),
                sink_count as i32,
                world.input_room(sink_tile, line.output).unwrap_or(0) as i32,
                cargo_count as i32,
                blocked,
                i32::from(machine.status),
                i32::from(machine.group),
                total as i32,
                world.grids[machine.group as usize].generation as i32,
                line.supplied as i32,
            ]);
            ids.sort_unstable();
            output.extend(ids);
            output.len()
        })
    })
}
