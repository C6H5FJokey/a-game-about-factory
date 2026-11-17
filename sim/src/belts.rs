use std::collections::VecDeque;

use crate::catalog::*;
use crate::world::Cell;

#[derive(Clone, Copy, Default)]
pub struct Cargo {
    pub item: u8,
    pub ready: u32,
}

pub struct Segment {
    pub tiles: Vec<usize>,
    pub queue: VecDeque<Cargo>,
    pub exits: [Option<usize>; 2],
    pub last_insert: u32,
}

impl Segment {
    pub fn push(&mut self, item: u8, pulse: u32) -> bool {
        if self.queue.len() >= self.tiles.len() || self.last_insert == pulse {
            return false;
        }
        self.queue.push_back(Cargo {
            item,
            ready: pulse + self.tiles.len() as u32,
        });
        self.last_insert = pulse;
        true
    }
}

pub struct Belts {
    pub segments: Vec<Segment>,
    pub entry: Vec<Option<usize>>,
    pub downstream_first: Vec<usize>,
}

impl Belts {
    pub fn rebuild(cells: &[Cell], cargo: &[Cargo], pulse: u32, preserve_ready: bool) -> Self {
        let mut segment_at = vec![None; N];
        let mut entry = vec![None; N];
        let mut incoming = vec![0u8; N];
        let mut previous = vec![None; N];
        for (i, cell) in cells.iter().enumerate() {
            if !is_belt(cell.kind) && cell.kind != DEPOT && recipe(cell.kind).is_none() {
                continue;
            }
            let targets = exits(i, cell);
            for next in targets
                .into_iter()
                .flatten()
                .filter(|&next| is_belt(cells[next].kind))
            {
                incoming[next] += 1;
                if cell.kind == BELT {
                    previous[next] = Some(i);
                }
            }
        }
        let mut segments = Vec::new();
        let starts = (0..N).filter(|&i| {
            is_belt(cells[i].kind)
                && (cells[i].kind == SPLITTER || incoming[i] != 1 || previous[i].is_none())
        });
        for start in starts.chain(0..N) {
            if !is_belt(cells[start].kind) || segment_at[start].is_some() {
                continue;
            }
            let id = segments.len();
            entry[start] = Some(id);
            let mut tiles = vec![start];
            segment_at[start] = Some(id);
            let mut end = start;
            while cells[end].kind == BELT {
                let Some(next) = neighbor(end, cells[end].dir) else {
                    break;
                };
                if cells[next].kind != BELT || incoming[next] != 1 || segment_at[next].is_some() {
                    break;
                }
                tiles.push(next);
                segment_at[next] = Some(id);
                end = next;
            }
            let len = tiles.len();
            let queue = tiles
                .iter()
                .enumerate()
                .rev()
                .filter_map(|(offset, &tile)| {
                    let stored = cargo[tile];
                    (stored.item > 0).then(|| Cargo {
                        item: stored.item,
                        ready: if preserve_ready {
                            stored.ready
                        } else {
                            pulse + (len - offset) as u32
                        },
                    })
                })
                .collect();
            segments.push(Segment {
                tiles,
                queue,
                exits: exits(end, &cells[end]),
                last_insert: u32::MAX,
            });
        }

        // Reverse topological order when possible so a one-cell downstream belt
        // can release its item and accept a replacement on the same pulse.
        let mut visited = vec![false; segments.len()];
        let mut downstream_first = Vec::with_capacity(segments.len());
        for id in 0..segments.len() {
            let mut stack = vec![(id, false)];
            while let Some((id, finished)) = stack.pop() {
                if finished {
                    downstream_first.push(id);
                    continue;
                }
                if visited[id] {
                    continue;
                }
                visited[id] = true;
                stack.push((id, true));
                for target in segments[id]
                    .exits
                    .into_iter()
                    .flatten()
                    .filter_map(|tile| entry[tile])
                {
                    if !visited[target] {
                        stack.push((target, false));
                    }
                }
            }
        }
        Self {
            segments,
            entry,
            downstream_first,
        }
    }

    pub fn materialize(&self, pulse: u32, cargo: &mut [Cargo]) {
        cargo.fill(Cargo::default());
        for segment in &self.segments {
            let len = segment.tiles.len();
            let mut ahead = len;
            for (order, &item) in segment.queue.iter().enumerate() {
                let distance = item.ready.saturating_sub(pulse) as usize;
                let remaining = segment.queue.len() - order - 1;
                let offset = len.saturating_sub(distance).min(ahead - 1).max(remaining);
                cargo[segment.tiles[offset]] = item;
                ahead = offset;
            }
        }
    }
}

fn exits(tile: usize, cell: &Cell) -> [Option<usize>; 2] {
    [
        neighbor(tile, cell.dir),
        if cell.kind == SPLITTER {
            neighbor(tile, (cell.dir + 1) % 4)
        } else {
            None
        },
    ]
}
