use std::collections::VecDeque;

use crate::catalog::*;
use crate::footprints::Outlet;
use crate::world::Cell;

pub const RETIRED_SOURCE: u16 = N as u16 + 1;
pub const NODES: usize = N * 2;
pub const fn node(tile: usize, lane: usize) -> usize {
    tile * 2 + lane
}

#[derive(Clone, Copy, Default)]
pub struct Cargo {
    pub item: u8,
    pub source: u16,
    pub id: i32,
    pub offset: u16,
    pub from: u16,
    pub since: u32,
    pub ready: u32,
    pub blocked: bool,
}

pub struct Segment {
    pub nodes: Vec<usize>,
    pub queue: VecDeque<Cargo>,
    pub exits: [Option<u8>; 2],
    pub interval: u32,
    pub next_entry: u32,
    pub next_exit: u32,
    next_motion: u32,
}

impl Segment {
    pub fn can_enter(&self, tick: u32) -> bool {
        tick >= self.next_entry && self.queue.back().is_none_or(|last| last.offset > 0)
    }

    pub fn enter(&mut self, mut cargo: Cargo, from: usize, tick: u32) {
        cargo.offset = 0;
        cargo.from = from as u16;
        cargo.since = tick;
        cargo.ready = tick + self.interval;
        cargo.blocked = false;
        self.queue.push_back(cargo);
        self.next_entry = cargo.ready;
        self.next_motion = self.next_motion.min(cargo.ready);
    }

    pub fn outgoing(&self, tick: u32) -> Option<Cargo> {
        self.queue.front().copied().filter(|cargo| {
            usize::from(cargo.offset) + 1 == self.nodes.len()
                && cargo.ready <= tick
                && self.next_exit <= tick
        })
    }

    pub fn depart(&mut self, tick: u32) {
        self.queue.pop_front();
        self.next_exit = tick + self.interval;
        self.next_motion = self.next_motion.min(tick);
    }

    pub fn advance(&mut self, tick: u32) {
        if tick < self.next_motion {
            return;
        }
        self.next_motion = u32::MAX;
        let mut ahead = self.nodes.len();
        for cargo in &mut self.queue {
            let mut current = usize::from(cargo.offset);
            if current + 1 < ahead {
                if cargo.ready <= tick {
                    cargo.from = self.nodes[current] as u16;
                    cargo.since = tick;
                    cargo.ready = tick + self.interval;
                    current += 1;
                    cargo.offset = current as u16;
                    cargo.blocked = false;
                }
                self.next_motion = self.next_motion.min(cargo.ready);
            } else if current + 1 < self.nodes.len() {
                if cargo.ready <= tick {
                    cargo.blocked = true;
                } else {
                    self.next_motion = self.next_motion.min(cargo.ready);
                }
            }
            ahead = current;
        }
    }

    pub fn take(&mut self, location: usize, item: u8, id: i32, tick: u32) -> bool {
        let Some(index) = self.queue.iter().position(|cargo| {
            cargo.id == id
                && cargo.item == item
                && self.nodes[usize::from(cargo.offset)] == location
        }) else {
            return false;
        };
        self.queue.remove(index);
        self.next_motion = self.next_motion.min(tick);
        true
    }
}

pub fn target_node(cells: &[Cell], source: usize, flow: u8) -> Option<usize> {
    let target = neighbor(source, flow)?;
    let next = &cells[target];
    belt_input(next.kind, next.dir, flow).map(|lane| node(target, lane))
}

pub struct Belts {
    pub segments: Vec<Segment>,
    pub segment_at: Vec<Option<usize>>,
    pub downstream_first: Vec<usize>,
}

impl Belts {
    pub fn rebuild(
        cells: &[Cell],
        cargo: &[Cargo],
        previous: Option<&Self>,
        outlets: &[Outlet],
    ) -> Self {
        let mut segment_at = vec![None; NODES];
        let mut incoming = vec![0u8; NODES];
        let mut continues = vec![false; NODES];
        for (tile, cell) in cells.iter().enumerate() {
            let lanes = belt_lanes(cell.kind);
            for lane in 0..lanes {
                for flow in belt_outputs(cell.kind, cell.dir, lane)
                    .into_iter()
                    .flatten()
                {
                    if let Some(target) = target_node(cells, tile, flow) {
                        incoming[target] += 1;
                        if plain_belt(cell.kind) && cells[target / 2].kind == cell.kind {
                            continues[target] = true;
                        }
                    }
                }
            }
        }
        for outlet in outlets {
            if let Some(target) = target_node(cells, outlet.tile, outlet.flow) {
                incoming[target] += 1;
            }
        }

        let present = |location: usize| location % 2 < belt_lanes(cells[location / 2].kind);
        let all = || (0..NODES).filter(|&loc| present(loc));
        let starts = all().filter(|&loc| incoming[loc] != 1 || !continues[loc]);
        let mut segments = Vec::new();
        for start in starts.chain(all()) {
            if segment_at[start].is_some() {
                continue;
            }
            let id = segments.len();
            let kind = cells[start / 2].kind;
            let mut nodes = vec![start];
            segment_at[start] = Some(id);
            let mut end = start;
            while plain_belt(kind) {
                let Some(next) = target_node(cells, end / 2, cells[end / 2].dir) else {
                    break;
                };
                if cells[next / 2].kind != kind || incoming[next] != 1 || segment_at[next].is_some()
                {
                    break;
                }
                nodes.push(next);
                segment_at[next] = Some(id);
                end = next;
            }
            let queue = nodes
                .iter()
                .enumerate()
                .rev()
                .filter_map(|(offset, &loc)| {
                    let item = cargo[loc];
                    (item.item != 0).then_some(Cargo {
                        offset: offset as u16,
                        ..item
                    })
                })
                .collect();
            let old = previous.and_then(|p| p.entry(start).map(|id| &p.segments[id]));
            let tail = &cells[end / 2];
            segments.push(Segment {
                nodes,
                queue,
                exits: belt_outputs(tail.kind, tail.dir, end % 2),
                interval: belt_interval(kind),
                next_entry: old.map_or(0, |s| s.next_entry),
                next_exit: old.map_or(0, |s| s.next_exit),
                next_motion: 0,
            });
        }

        let mut visited = vec![false; segments.len()];
        let mut downstream_first = Vec::with_capacity(segments.len());
        let mut stack = Vec::new();
        for id in 0..segments.len() {
            stack.push((id, false));
            while let Some((id, finished)) = stack.pop() {
                if finished {
                    downstream_first.push(id);
                    continue;
                }
                if std::mem::replace(&mut visited[id], true) {
                    continue;
                }
                stack.push((id, true));
                let tail = segments[id].nodes.last().unwrap() / 2;
                for flow in segments[id].exits.into_iter().flatten() {
                    if let Some(target) =
                        target_node(cells, tail, flow).and_then(|loc| segment_at[loc])
                    {
                        if !visited[target] {
                            stack.push((target, false));
                        }
                    }
                }
            }
        }
        Self {
            segments,
            segment_at,
            downstream_first,
        }
    }

    pub fn entry(&self, location: usize) -> Option<usize> {
        self.segment_at[location].filter(|&id| self.segments[id].nodes[0] == location)
    }

    pub fn materialize(&self, cargo: &mut [Cargo]) {
        cargo.fill(Cargo::default());
        for segment in &self.segments {
            for &item in &segment.queue {
                cargo[segment.nodes[usize::from(item.offset)]] = item;
            }
        }
    }
}
