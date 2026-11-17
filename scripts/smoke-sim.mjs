import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const artifact = await readFile(new URL('../public/sim.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(artifact);
const sim = instance.exports;
const width = 56;
const tile = (x,y) => y * width + x;

function command(op, a = 0, b = 0, c = 0, words = []) {
  const pointer = sim.input_ptr();
  new Int32Array(sim.memory.buffer, pointer, words.length).set(words);
  return sim.command(op, a, b, c, words.length);
}

function advance(ticks) {
  while (ticks > 0) {
    const interval = Math.min(ticks, 200);
    sim.step(interval);
    ticks -= interval;
  }
}

function snapshot() {
  const length = sim.snapshot();
  return Array.from(new Int32Array(sim.memory.buffer, sim.output_ptr(), length));
}

function save() {
  const length = sim.save();
  return new Int32Array(sim.memory.buffer, sim.output_ptr(), length).slice();
}

function restore(saved) {
  const pointer = sim.input_ptr();
  new Int32Array(sim.memory.buffer, pointer, saved.length).set(saved);
  return sim.restore(saved.length);
}

function cable(x,y,endX,endY) {
  const words = [];
  while (x !== endX) { words.push(tile(x,y),0); x += Math.sign(endX-x); }
  while (y !== endY) { words.push(tile(x,y),0); y += Math.sign(endY-y); }
  words.push(tile(x,y),0);
  assert.equal(command(2,1,0,0,words),1);
}

advance(100);
assert.equal(snapshot()[19],0,'A broken belt cannot deliver plates.');
assert.equal(command(2,0,0,0,[tile(8,13),0]),1);
advance(1800);
assert.ok(snapshot()[19]>0,'Repairing the belt restores delivery.');
assert.equal(command(5),1);
advance(200);
assert.equal(snapshot()[4],1,'The mirror is in orbit.');
assert.equal(command(6),1);
advance(110);
assert.equal(snapshot()[15],1,'The underpowered window reports a power failure.');
assert.equal(snapshot()[4],1,'A failed window preserves the launched mirror.');

assert.equal(command(1,tile(33,16),10),1);
advance(1600);
assert.equal(command(6),1);
advance(630);
assert.equal(snapshot()[7],1,'Charging a battery makes the next window viable.');
assert.equal(snapshot()[17],1,'First light activates the solar window.');
advance(500);

const parts = [[0,2],[1,1],[2,5],[3,14],[4,1],[5,12]].flatMap(([x,kind]) => [x,0,kind,0,1,0]);
for (const [x,y] of [[28,28],[38,26],[47,21]]) assert.equal(command(7,tile(x,y),0,0,parts),1);
cable(24,28,28,28);
cable(33,24,38,26);
cable(43,26,47,21);
advance(300);
assert.equal(snapshot()[8],4);
assert.equal(snapshot()[21],1,'Four producing blocks finish the first campaign.');

const saved = save();
const invalid = saved.slice();
invalid[0]++;
assert.equal(restore(invalid),-1);
assert.deepEqual(save(),saved,'An invalid save leaves the current world intact.');
sim.reset();
assert.equal(restore(saved),1);
assert.deepEqual(save(),saved,'The save restores inventory, in-flight goods and orbit progress.');
console.log('模拟通过：断点修复、发射、试照失败与复演、四厂段扩建、存档往返');
