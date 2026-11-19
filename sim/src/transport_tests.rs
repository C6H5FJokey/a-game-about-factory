use crate::belts::{node, Cargo};
use crate::campaign::Stage;
use crate::catalog::*;
use crate::world::{Cell, World};

fn test_world() -> World {
    let mut world = World::empty();
    world.stage = Stage::Sunlight;
    world.orbit.first_light = true;
    world.stock[IRON as usize] = 500;
    world.stock[SILICA as usize] = 500;
    world.stock[PLATE as usize] = 100;
    world.stock[KIT as usize] = 10;
    world
}

fn place(world: &mut World, x: usize, y: usize, kind: u8, dir: u8, cfg: u8) -> usize {
    let tile = index(x, y);
    world.install(
        tile,
        Cell {
            kind,
            dir,
            cfg,
            ..Cell::default()
        },
    );
    tile
}

fn advance(world: &mut World, ticks: u32) {
    for _ in 0..ticks {
        world.tick += 1;
        world.move_cargo();
    }
    world.materialize();
}

fn load(world: &mut World, tile: usize, lane: usize, item: u8, source: u16) -> i32 {
    let id = world.next_cargo_id;
    world.next_cargo_id += 1;
    world.cargo[node(tile, lane)] = Cargo {
        id,
        item,
        source,
        from: node(tile, lane) as u16,
        ..Cargo::default()
    };
    id
}

fn rewrite(world: &mut World, tile: usize, kind: u8, dir: u8) -> i32 {
    world.build_transports(
        world.layout_revision,
        &[tile as i32, kind.into(), dir.into()],
    )
}

#[test]
fn merger_alternates_skips_empty_and_restarts_after_jam() {
    let mut world = test_world();
    place(&mut world, 7, 10, DEPOT, 0, IRON);
    place(&mut world, 8, 10, BELT, 0, 0);
    let source = place(&mut world, 9, 8, DEPOT, 1, SILICA);
    place(&mut world, 9, 9, BELT, 1, 0);
    let junction = place(&mut world, 9, 10, MERGER, 0, 0);
    let out = place(&mut world, 10, 10, BELT, 0, 0);
    let sink = place(&mut world, 11, 10, DEPOT, 0, 0);
    world.rebuild();
    let mut entries = Vec::new();
    let mut observed = 0;
    for _ in 0..simulation_ticks(70) {
        advance(&mut world, 1);
        let cargo = world.cargo[node(out, 0)];
        if cargo.id != 0 && cargo.id != observed {
            assert_eq!(cargo.from, node(junction, 0) as u16);
            observed = cargo.id;
            entries.push(cargo.item);
        }
    }
    assert!(entries.len() >= 10);
    assert!(entries.windows(2).all(|pair| pair[0] != pair[1]));
    world.cells[source].cfg = FUEL;
    advance(&mut world, simulation_ticks(25));
    assert_eq!(world.cargo[node(out, 0)].item, IRON);
    assert_eq!(world.cargo[node(junction, 0)].item, IRON);
    world.cells[source].cfg = SILICA;
    world.cells[sink].cfg = FUEL;
    advance(&mut world, simulation_ticks(25));
    let jammed = world.cargo[node(out, 0)];
    assert!(jammed.blocked);
    advance(&mut world, simulation_ticks(20));
    assert_eq!(world.cargo[node(out, 0)].id, jammed.id);
    world.cells[sink].cfg = 0;
    advance(&mut world, simulation_ticks(5));
    assert_ne!(world.cargo[node(out, 0)].id, jammed.id);
    advance(&mut world, simulation_ticks(10));
    assert!([out, junction]
        .into_iter()
        .any(|tile| world.cargo[node(tile, 0)].item == SILICA));
    for item in [IRON, SILICA] {
        let on_line = world.cargo.iter().filter(|c| c.item == item).count() as u32;
        assert_eq!(world.stock[item as usize] + on_line, 500);
    }
}

#[test]
fn crossing_blocks_one_direction_and_takes_only_the_selected_cargo() {
    let mut world = test_world();
    place(&mut world, 9, 10, DEPOT, 0, IRON);
    place(&mut world, 10, 9, DEPOT, 1, SILICA);
    let crossing = place(&mut world, 10, 10, CROSSING, 0, 0);
    let east = place(&mut world, 11, 10, DEPOT, 0, FUEL);
    place(&mut world, 10, 11, BELT, 1, 0);
    place(&mut world, 10, 12, DEPOT, 0, 0);
    world.rebuild();
    advance(&mut world, simulation_ticks(26));
    let [iron, silica] = [
        world.cargo[node(crossing, 0)],
        world.cargo[node(crossing, 1)],
    ];
    assert_eq!([iron.item, silica.item], [IRON, SILICA]);
    assert!(iron.blocked);
    assert!(!silica.blocked);
    assert_eq!(silica.from, node(index(10, 9), 0) as u16);
    let device = world.cells[crossing].identity;
    assert_eq!(
        world.take_cargo(crossing, 1, IRON.into(), &[iron.id, device]),
        -22
    );
    assert_eq!(
        world.take_cargo(crossing, 0, IRON.into(), &[iron.id, device]),
        1
    );
    assert_eq!(
        world.take_cargo(crossing, 0, IRON.into(), &[iron.id, device]),
        -22
    );
    advance(&mut world, simulation_ticks(4));
    let replacement = world.cargo[node(crossing, 0)];
    assert_eq!(replacement.item, IRON);
    assert_ne!(replacement.id, iron.id);
    assert_ne!(world.cargo[node(crossing, 1)].id, silica.id);
    assert_eq!(
        world.take_cargo(crossing, 1, SILICA.into(), &[silica.id, device]),
        -22
    );
    world.cells[east].cfg = 0;
    advance(&mut world, simulation_ticks(15));
    for item in [IRON, SILICA] {
        let on_line = world.cargo.iter().filter(|c| c.item == item).count() as u32;
        assert_eq!(world.stock[item as usize] + on_line, 500);
    }
}

#[test]
fn transport_rebuild_is_atomic_and_keeps_order_source_and_lane() {
    let mut world = test_world();
    let source = place(&mut world, 8, 8, BENCH, 0, 0);
    let upstream = place(&mut world, 9, 10, BELT, 0, 0);
    let downstream = place(&mut world, 10, 10, BELT, 0, 0);
    let sink = place(&mut world, 11, 10, DEPOT, 0, FUEL);
    let a = load(&mut world, upstream, 0, PLATE, source as u16 + 1);
    let b = load(&mut world, downstream, 0, PLATE, source as u16 + 1);
    world.rebuild();
    let revision = world.layout_revision;
    let old_device = world.cells[downstream].identity;
    let plan = [
        upstream as i32,
        FAST_BELT.into(),
        0,
        downstream as i32,
        FAST_BELT.into(),
        0,
    ];
    assert_eq!(world.build_transports(revision - 1, &plan), -23);
    world.stock[PLATE as usize] = 3;
    assert_eq!(world.build_transports(revision, &plan), -4);
    assert_eq!(world.stock[PLATE as usize], 3);
    assert_eq!(world.cells[downstream].identity, old_device);
    assert_eq!(world.cargo[node(upstream, 0)].id, a);
    assert_eq!(world.cargo[node(downstream, 0)].id, b);
    assert_eq!(rewrite(&mut world, downstream, CROSSING, 1), -20);
    world.stock[PLATE as usize] = 100;
    assert_eq!(world.build_transports(revision, &plan), 1);
    assert_eq!(world.stock[PLATE as usize], 96);
    assert_eq!(rewrite(&mut world, upstream, BELT, 0), 1);
    assert_eq!(rewrite(&mut world, downstream, CROSSING, 3), 1);
    assert_eq!(
        world.take_cargo(downstream, 1, PLATE.into(), &[b, old_device]),
        -22
    );
    let cargo = world.cargo[node(downstream, 1)];
    assert_eq!((cargo.id, cargo.source), (b, source as u16 + 1));
    assert_eq!(world.cargo[node(downstream, 0)].id, 0);
    advance(&mut world, simulation_ticks(15));
    assert!(world.cargo[node(downstream, 1)].blocked);
    world.cells[sink].cfg = 0;
    advance(&mut world, 1);
    assert_eq!(world.delivered, 1);
    assert_eq!(world.cargo[node(downstream, 1)].id, a);
    advance(&mut world, simulation_ticks(5));
    assert_eq!(world.delivered, 2);

    let full = place(&mut world, 20, 10, CROSSING, 0, 0);
    let a = load(&mut world, full, 0, IRON, 0);
    let b = load(&mut world, full, 1, SILICA, 0);
    world.rebuild();
    assert_eq!(rewrite(&mut world, full, SPLITTER, 0), -21);
    assert_eq!(world.cargo[node(full, 0)].id, a);
    assert_eq!(world.cargo[node(full, 1)].id, b);
    let side_source = place(&mut world, 20, 14, BELT, 1, 0);
    let side_fed = place(&mut world, 20, 15, BELT, 0, 0);
    world.rebuild();
    let plan = [
        side_source as i32,
        BELT.into(),
        1,
        side_fed as i32,
        CROSSING.into(),
        3,
    ];
    assert_eq!(world.build_transports(world.layout_revision, &plan), -20);
}

#[test]
fn mixed_segments_obey_the_slower_gate_and_crossing_round_trips() {
    let mut world = test_world();
    let mut ends = Vec::new();
    for (y, tiers) in [
        (10, [FAST_BELT; 4]),
        (14, [FAST_BELT, BELT, FAST_BELT, FAST_BELT]),
        (18, [BELT, FAST_BELT, FAST_BELT, FAST_BELT]),
        (20, [EXPRESS_BELT; 4]),
    ] {
        place(&mut world, 3, y, DEPOT, 0, IRON);
        for (offset, kind) in tiers.into_iter().enumerate() {
            place(&mut world, 4 + offset, y, kind, 0, 0);
        }
        place(&mut world, 8, y, DEPOT, 0, 0);
        ends.push(node(index(7, y), 0));
    }
    let crossing = place(&mut world, 16, 18, CROSSING, 0, 0);
    let a = load(&mut world, crossing, 0, IRON, 0);
    let b = load(&mut world, crossing, 1, SILICA, 0);
    world.rebuild();
    let mut last = [0; 4];
    let mut counts = [0; 4];
    for _ in 0..simulation_ticks(220) {
        advance(&mut world, 1);
        for (i, &end) in ends.iter().enumerate() {
            let id = world.cargo[end].id;
            if id != 0 && last[i] != id {
                counts[i] += 1;
                last[i] = id;
            }
        }
    }
    assert!((105..=110).contains(&counts[0]), "{counts:?}");
    assert!((40..=44).contains(&counts[1]), "{counts:?}");
    assert!((40..=44).contains(&counts[2]), "{counts:?}");
    assert!((215..=220).contains(&counts[3]), "{counts:?}");
    assert!(world.cargo[node(index(4, 14), 0)].blocked);
    let mut words = Vec::new();
    world.write_transport_save(&mut words);
    let mut restored = World::empty();
    restored.cells.clone_from(&world.cells);
    restored.tick = world.tick;
    restored.stock = world.stock;
    restored.machines.clone_from(&world.machines);
    assert_eq!(restored.read_transport_save(&words, false), Some(&[][..]));
    assert_eq!(restored.cargo[node(crossing, 0)].id, a);
    assert_eq!(restored.cargo[node(crossing, 1)].id, b);
    advance(&mut world, 25);
    advance(&mut restored, 25);
    let mut expected = Vec::new();
    let mut actual = Vec::new();
    world.write_transport_save(&mut expected);
    restored.write_transport_save(&mut actual);
    assert_eq!(actual, expected);
    assert_eq!(restored.stock, world.stock);
}

#[test]
fn splitter_projects_the_branch_that_was_really_available() {
    let mut world = test_world();
    place(&mut world, 8, 9, DEPOT, 1, IRON);
    let bend = place(&mut world, 8, 10, BELT, 0, 0);
    let split = place(&mut world, 9, 10, SPLITTER, 0, 1);
    place(&mut world, 10, 10, DEPOT, 0, FUEL);
    let branch = place(&mut world, 9, 11, FAST_BELT, 1, 0);
    world.rebuild();
    advance(&mut world, simulation_ticks(5));
    let item = world.cargo[node(bend, 0)];
    assert_eq!(item.from, node(index(8, 9), 0) as u16);
    advance(&mut world, simulation_ticks(5));
    let through_split = world.cargo[node(split, 0)];
    assert_eq!(through_split.id, item.id);
    assert_eq!(through_split.from, node(bend, 0) as u16);
    advance(&mut world, simulation_ticks(5));
    let selected_branch = world.cargo[node(branch, 0)];
    assert_eq!(selected_branch.id, item.id);
    assert_eq!(selected_branch.from, node(split, 0) as u16);
    assert_eq!(
        selected_branch.ready - selected_branch.since,
        simulation_ticks(2)
    );
    advance(&mut world, simulation_ticks(3));
    assert!(world.cargo[node(branch, 0)].blocked);
    assert_eq!(world.cargo[node(branch, 0)].id, item.id);
}

#[test]
fn a_full_backpack_blocks_automatic_deposit_until_space_is_available() {
    let mut world = test_world();
    world.stock = [0; ITEMS];
    world.stock[KIT as usize] = 1600;
    let belt = place(&mut world, 8, 10, BELT, 0, 0);
    place(&mut world, 9, 10, DEPOT, 0, 0);
    let cargo_id = load(&mut world, belt, 0, IRON, 0);
    let device = world.cells[belt].identity;
    world.rebuild();
    advance(&mut world, simulation_ticks(10));
    assert_eq!(world.stock[IRON as usize], 0);
    assert_eq!(world.cargo[node(belt, 0)].id, cargo_id);
    assert!(world.cargo[node(belt, 0)].blocked);
    assert_eq!(
        world.take_cargo(belt, 0, IRON.into(), &[cargo_id, device]),
        -24
    );
    world.stock[KIT as usize] -= 100;
    advance(&mut world, 1);
    assert_eq!(world.stock[IRON as usize], 1);
    assert_eq!(world.cargo[node(belt, 0)].id, 0);
}

#[test]
fn production_belt_tiers_meet_their_per_minute_rates() {
    let mut world = World::new();
    world.stage = Stage::Sunlight;
    world.stock[IRON as usize] = 800;
    let tiers = [BELT, FAST_BELT, EXPRESS_BELT, ULTRA_BELT];
    let lines = tiers.map(|kind| {
        let y = 8 + tiers.iter().position(|&tier| tier == kind).unwrap() * 3;
        place(&mut world, 8, y, DEPOT, 0, IRON);
        for x in 9..=12 {
            place(&mut world, x, y, kind, 0, 0);
        }
        place(&mut world, 13, y, DEPOT, 0, 0);
        node(index(12, y), 0)
    });
    world.rebuild();
    advance(&mut world, HZ * 10);
    let mut last = lines.map(|end| world.cargo[end].id);
    let mut counts = [0; 4];
    for _ in 0..HZ * 60 {
        advance(&mut world, 1);
        for (i, &end) in lines.iter().enumerate() {
            let id = world.cargo[end].id;
            if id != 0 && id != last[i] {
                counts[i] += 1;
                last[i] = id;
            }
        }
    }
    assert_eq!(counts, [60, 120, 270, 600]);
}
