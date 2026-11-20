import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';

const [seedPath, ...wasmPaths] = process.argv.slice(2);
const terminal = seedPath === '--terminal';
if (!seedPath || wasmPaths.length === 0) {
  console.error('Usage: node scripts/profile-sim.mjs <save.dawn|--terminal> <wasm> [<wasm>...]');
  process.exit(1);
}
const seed = terminal ? undefined : await readFile(seedPath);
if (seed) assert.equal(seed.byteLength % 4, 0, 'Expected a binary .dawn save.');
const warmupSteps = terminal ? 1800 : 120;
const measuredSteps = 300;
const repeats = 7;
const protocol = JSON.parse(await readFile(new URL('../data/protocol.json', import.meta.url), 'utf8'));
const { headerWords: gridHeader, cellWords: gridStride } = protocol.snapshot;

function percentiles(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = p => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(5));
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Offsets follow the current snapshot contract in model.ts and sim-data.ts.
function readWorkload(frame, mapTiles) {
  const gridEnd = gridHeader + mapTiles * gridStride;
  const transportEnd = frame.at(-1) - 1;
  const transportStart = frame[transportEnd];
  assert.ok(transportStart >= gridEnd && transportStart < transportEnd, 'Unsupported snapshot layout.');
  const cargo = new Map();
  let blocked = 0;
  for (let i = transportStart + 1; i < transportEnd && frame[i] >= 0; i += 8) {
    cargo.set(frame[i + 1], frame[i]);
    blocked += Number(Boolean(frame[i + 7]));
  }
  let occupiedTiles = 0, devices = 0, runningDevices = 0;
  for (let i = gridHeader; i < gridEnd; i += gridStride) occupiedTiles += Number(frame[i] > 0);
  for (let i = frame.at(-1); i < frame.length - 1; i += 10 + 5 * frame[i + 9]) {
    devices++;
    runningDevices += Number(frame[gridHeader + frame[i] * gridStride + 5] === 1);
  }
  return { tick: frame[0], occupiedTiles, devices, runningDevices, cargo, blocked };
}

function frame(sim, length) {
  return new Int32Array(sim.memory.buffer, sim.output_ptr(), length);
}

function terminalStats(sim) {
  const outputWords = sim.terminal_profile_stats();
  const [beltTiles, processors, runningProcessors, powerGrids, sourceStock, receivedProducts, upperSources] =
    frame(sim, outputWords);
  return { beltTiles, processors, runningProcessors, powerGrids, sourceStock, receivedProducts, upperSources };
}

async function profile(path) {
  const bytes = await readFile(path);
  const startup = [];
  const phaseSamples = { step: [], snapshot: [], copy: [], total: [] };
  const workloads = [];
  const terminalWorkloads = [];
  const rebuilds = [];
  const feedSamples = [];
  let minSnapshotBytes = Infinity, maxSnapshotBytes = 0, peakWasmBytes = 0;
  let hz, width, height;
  for (let run = 0; run < repeats; run++) {
    const initializing = performance.now();
    const { instance } = await WebAssembly.instantiate(bytes);
    const sim = instance.exports;
    hz = sim.tick_rate();
    width = sim.world_width?.() ?? protocol.world.width;
    height = sim.world_height?.() ?? protocol.world.height;
    if (terminal) {
      assert.equal(typeof sim.prepare_terminal_profile, 'function', 'Build Wasm with the terminal-profile feature.');
      sim.prepare_terminal_profile();
    } else {
      const length = seed.byteLength / 4;
      const pointer = sim.reserve_input(length);
      new Uint8Array(sim.memory.buffer, pointer, seed.byteLength).set(seed);
      assert.equal(sim.restore(length), 1, 'Fixture could not be restored: ' + path);
    }
    let buffer = new Int32Array(frame(sim, sim.snapshot()));
    startup.push(performance.now() - initializing);
    for (let tick = 0; tick < warmupSteps; tick++) {
      if (terminal) sim.feed_terminal_profile();
      sim.step(1);
      if (terminal && tick < warmupSteps - 120) continue;
      const length = sim.snapshot();
      if (buffer.length !== length) buffer = new Int32Array(length);
      buffer.set(frame(sim, length));
    }
    const start = readWorkload(buffer, width * height);
    const initialPlant = terminal ? terminalStats(sim) : undefined;
    let injected = 0;
    for (let tick = 0; tick < measuredSteps; tick++) {
      if (terminal) {
        const feedStarted = performance.now();
        injected += sim.feed_terminal_profile();
        feedSamples.push(performance.now() - feedStarted);
      }
      const before = performance.now();
      sim.step(1);
      const stepped = performance.now();
      const length = sim.snapshot();
      const projected = performance.now();
      if (buffer.length !== length) buffer = new Int32Array(length);
      buffer.set(frame(sim, length));
      const copied = performance.now();
      phaseSamples.step.push(stepped - before);
      phaseSamples.snapshot.push(projected - stepped);
      phaseSamples.copy.push(copied - projected);
      phaseSamples.total.push(copied - before);
      minSnapshotBytes = Math.min(minSnapshotBytes, buffer.byteLength);
      maxSnapshotBytes = Math.max(maxSnapshotBytes, buffer.byteLength);
    }
    const end = readWorkload(buffer, width * height);
    assert.equal(end.tick - start.tick, measuredSteps);
    let movedCargo = 0;
    for (const [id, location] of start.cargo) {
      movedCargo += Number(end.cargo.has(id) && end.cargo.get(id) !== location);
    }
    const counters = ({ cargo, ...state }) => ({ ...state, cargo: cargo.size });
    workloads.push({ start: counters(start), end: counters(end), movedCargo });
    if (initialPlant) {
      const finalPlant = terminalStats(sim);
      const passed = finalPlant.receivedProducts - initialPlant.receivedProducts;
      assert.equal(initialPlant.runningProcessors, initialPlant.processors, 'Warmup must leave all processors running.');
      assert.equal(finalPlant.runningProcessors, initialPlant.processors, 'Processors must stay running.');
      assert.ok(passed > initialPlant.processors, 'Factory must sustain deliveries during the scored window.');
      assert.ok(initialPlant.upperSources > 0 && finalPlant.upperSources > 0, 'Fixture must use sources beyond 16-bit addresses.');
      terminalWorkloads.push({
        start: initialPlant, end: finalPlant, deliveredToWarehouses: passed,
        crossStagePerSecond: (injected - finalPlant.sourceStock + initialPlant.sourceStock + passed) * hz / measuredSteps,
      });
      const startRebuild = performance.now();
      sim.rebuild_terminal_profile();
      rebuilds.push(performance.now() - startRebuild);
    }
    peakWasmBytes = Math.max(peakWasmBytes, sim.memory.buffer.byteLength);
  }
  assert.ok(workloads.every(run => JSON.stringify(run) === JSON.stringify(workloads[0])),
    'The same fixture produced different workloads between repeats.');
  assert.ok(terminalWorkloads.every(run => JSON.stringify(run) === JSON.stringify(terminalWorkloads[0])),
    'The terminal factory changed load between repeats.');
  return {
    wasm: path, wasmSha256: sha256(bytes), wasmBytes: bytes.byteLength, hz, width, height, warmupSteps, measuredSteps, repeats,
    workload: workloads[0], minSnapshotBytes, maxSnapshotBytes, peakWasmBytes,
    terminalWorkload: terminalWorkloads[0],
    milliseconds: {
      startup: percentiles(startup),
      ...Object.fromEntries(Object.entries(phaseSamples).map(([key, values]) => [key, percentiles(values)])),
      ...(terminal ? {
        externalFeed: percentiles(feedSamples),
        topologyRebuild: { p50: percentiles(rebuilds).p50, max: Number(Math.max(...rebuilds).toFixed(5)) },
      } : {}),
    },
  };
}

const results = [];
for (const path of wasmPaths) results.push(await profile(path));
console.log(JSON.stringify({
  fixture: seedPath, fixtureSha256: seed ? sha256(seed) : undefined,
  environment: { node: process.version, os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
  results,
}, null, 2));
