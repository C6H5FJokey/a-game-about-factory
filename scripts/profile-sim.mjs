import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';

const [seedPath, ...wasmPaths] = process.argv.slice(2);
if (!seedPath || wasmPaths.length === 0) {
  console.error('Usage: node scripts/profile-sim.mjs <save.dawn> <wasm> [<wasm>...]');
  process.exit(1);
}
const seed = await readFile(seedPath);
const ticks = 12_000;
const repeats = 7;
const samples = await Promise.all(wasmPaths.map(async path => ({
  path, bytes: await readFile(path), startup: [], p95: [], memory: 0,
})));
function percentile(samples, fraction) {
  samples.sort((a, b) => a-b);
  return samples[Math.ceil(samples.length*fraction)-1];
}
for (let run=0; run<repeats; run++) {
  for (const sample of samples) {
    const start = performance.now();
    const { instance } = await WebAssembly.instantiate(sample.bytes);
    const sim = instance.exports;
    const pointer = sim.reserve_input(seed.byteLength/4);
    new Uint8Array(sim.memory.buffer, pointer, seed.byteLength).set(seed);
    if (sim.restore(seed.byteLength/4) !== 1) throw new Error('Fixture could not be restored: '+sample.path);
    sim.snapshot();
    sample.startup.push(performance.now()-start);
    sim.step(400);
    const timings = [];
    for (let tick=0; tick<ticks; tick++) {
      const before = performance.now();
      sim.step(1);
      timings.push(performance.now()-before);
    }
    sim.snapshot();
    sample.memory = Math.max(sample.memory,sim.memory.buffer.byteLength);
    sample.p95.push(percentile(timings,.95));
  }
}

console.log(process.version, cpus()[0]?.model, `${repeats} runs of ${ticks} ticks`);
console.table(samples.map(sample => ({
  wasm: sample.path,
  bytes: sample.bytes.length,
  'startup median ms': percentile(sample.startup,.5).toFixed(3),
  'step p95 median ms': percentile(sample.p95,.5).toFixed(5),
  'peak Wasm bytes': sample.memory,
})));
