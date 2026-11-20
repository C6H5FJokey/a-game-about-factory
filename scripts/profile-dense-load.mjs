import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadContent } from './content.mjs';

const path = process.argv[2] ?? 'docs/performance.local/dense-dist/sim.wasm';
const bytes = await readFile(path);
const { instance:{exports:sim} } = await WebAssembly.instantiate(bytes);
const { width,height } = loadContent().protocol.denseWorld;
assert.deepEqual([sim.world_width(),sim.world_height()],[width,height]);
const hz=sim.tick_rate();
const sampleSteps=hz*30;
const view=length=>new Int32Array(sim.memory.buffer,sim.output_ptr(),length);
const stats=()=>{
  const [transport,processors,running,grids,sourceStock,delivered,wideCargoSources,inTransit,tick]=view(sim.terminal_profile_stats());
  return {transport,processors,running,grids,sourceStock,delivered,wideCargoSources,inTransit,tick};
};
const step=()=>{
  const admitted=sim.feed_terminal_profile();
  sim.step(1);
  return admitted;
};

sim.prepare_terminal_profile();
for (let tick=0;tick<1800;tick++) step();
const start=stats();
let previous=start;
let supplied=0, totalHandoffs=0, peakHandoffsPerStep=0, peakInTransit=0, minimumRunning=start.running;
for (let tick=0;tick<sampleSteps;tick++) {
  supplied=step();
  const current=stats();
  const handoffs=supplied+previous.sourceStock-current.sourceStock+current.delivered-previous.delivered;
  totalHandoffs+=handoffs;
  peakHandoffsPerStep=Math.max(peakHandoffsPerStep,handoffs);
  peakInTransit=Math.max(peakInTransit,current.inTransit);
  minimumRunning=Math.min(minimumRunning,current.running);
  previous=current;
}
const end=previous;
assert.equal(minimumRunning,start.processors);
assert.ok(start.processors>=3500 && peakInTransit>=37_000 && end.wideCargoSources>0);

const saved=view(sim.save()).slice();
const destination=sim.reserve_input(saved.length);
assert.ok(destination,'The dense save must fit the input buffer.');
new Int32Array(sim.memory.buffer,destination,saved.length).set(saved);
assert.equal(sim.restore(saved.length),1);
assert.deepEqual(view(sim.save()),saved,'A dense V14 save must restore byte for byte.');
console.log(JSON.stringify({
  world:[width,height],wasmSha256:createHash('sha256').update(bytes).digest('hex'),
  start,end,sampleSteps,minimumRunning,peakInTransit,peakHandoffsPerStep,
  handoffsPerSimulatedSecond:totalHandoffs*hz/sampleSteps,
  roundTripBytes:saved.byteLength,
}, null, 2));
