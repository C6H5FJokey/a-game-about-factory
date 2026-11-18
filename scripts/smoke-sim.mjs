import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const artifact = await readFile(new URL('../public/sim.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(artifact);
const sim = instance.exports;
const width = 56;
const tile = (x,y) => y * width + x;
const header = 98;
const fieldAt = (position,field) => snapshot()[header + 19 * position + field];

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

const place=(x,y,kind,dir=0)=>assert.equal(command(1,tile(x,y),kind,dir),1,`place ${kind} at ${x},${y}`);
const act=(op,x,y,b=0)=>assert.equal(command(op,tile(x,y),b),1,`command ${op} at ${x},${y}`);
const stage=()=>snapshot()[29];
const ore=tile(19,16), bench=tile(21,16);
function until(test,label,limit=2400) {
  for (let n=0;n<limit && !test();n+=5) advance(5);
  assert.ok(test(),label);
}
advance(100);
assert.equal(stage(),0);
assert.equal(snapshot()[36],0);
assert.equal(snapshot().slice(header,header+width*34*19).filter((_,i)=>i%19===0).some(Boolean),false);
for(let i=0;i<5;i++) act(9,19,16);
assert.equal(command(10),1);
const packed=save();
sim.reset(); assert.equal(restore(packed),1);
place(19,16,17);
advance(120);
assert.equal(fieldAt(ore,10),2);
assert.equal(snapshot()[36],0);
act(11,19,16);
assert.equal(snapshot()[36],2);
assert.equal(command(12),1); assert.equal(command(12),1);
place(21,16,18);
advance(60); act(11,19,16); act(13,21,16,1);
advance(30); act(11,21,16);
assert.equal(command(2,0,0,0,[tile(20,16),0]),1);
until(()=>stage()===11,'An automatically supplied plate opens expansion.');
until(()=>fieldAt(bench,13)>=4,'Collect plates to build the depot.');
act(11,21,16); place(22,16,12);
advance(11000);
assert.ok(snapshot()[19]>=150);
place(22,19,2); assert.equal(stage(),12);
place(24,16,9); place(23,16,4);
for(let i=0;i<8;i++) act(9,23,16);
act(13,24,16,3); cable(24,16,22,19);
until(()=>stage()===13,'Powered drill starts industrial production.');
act(9,20,20); place(20,20,3); place(21,20,6);
cable(22,19,20,20); cable(20,20,22,20);
until(()=>stage()===15,'Grinding a lens unlocks mirror assembly.');
place(22,20,8); place(22,21,12,3); act(4,22,21,4);
until(()=>stage()===16,'Assembling a real mirror opens launch.');
place(33,15,13); cable(22,20,33,15);
until(()=>fieldAt(tile(22,20),16)>=3,'Build three mirror modules.');
act(11,22,20); act(13,33,15,7);
for(let i=0;i<5;i++) act(9,23,16);
act(13,33,15,3); assert.equal(command(5),1);
advance(200); assert.equal(stage(),17);
place(5,20,3); place(6,20,7,3); cable(5,20,20,20);
const feed=[tile(6,19),3,tile(6,18),3,tile(6,17),3,tile(6,16),3,tile(6,15),3,tile(6,14),0];
for(let x=7;x<33;x++) feed.push(tile(x,14),0);
feed.push(tile(33,14),1);
assert.equal(command(2,0,0,0,feed),1);
until(()=>snapshot()[13]===16,'Cores arrive at the station.');
assert.equal(command(6),1); advance(120); assert.equal(snapshot()[15],1);
place(33,16,10); cable(33,15,33,16);
advance(1800); assert.equal(command(6),1); advance(600);
assert.equal(snapshot()[7],1,'Charged storage and continuous supply complete first light.');
place(19,28,2); place(21,28,5); place(22,28,14); place(24,28,12);
assert.equal(command(2,0,0,0,[tile(20,28),0,tile(23,28),0]),1);
cable(19,28,24,28); cable(23,20,23,28);
until(()=>snapshot()[2]>=12,'A player-built line delivers new expansion kits.');
const parts = [[0,2],[1,1],[2,5],[3,14],[4,1],[5,12]].flatMap(([x,kind]) => [x,0,kind,0,1,0]);
for (const [x,y] of [[28,28],[38,26],[47,21]]) assert.equal(command(7,tile(x,y),0,0,parts),1);
cable(24,28,28,28);
cable(33,15,38,26);
cable(43,26,47,21);
const fourthDepot=tile(52,21), fourthPress=tile(50,21);
assert.equal(command(4,fourthDepot,8),1);
advance(300);
assert.equal(fieldAt(tile(51,21),4),8,'A fresh kit is waiting outside the blocked depot.');
assert.equal(snapshot()[8],3,'A fourth press with undelivered output is not counted.');
assert.deepEqual(snapshot().slice(26,29),[20,4,12],'The mission receives the simulation acceptance thresholds.');
assert.equal(fieldAt(fourthPress,18),0,'The inspector shows that this line has no recent delivery.');
assert.equal(snapshot()[21],0);
const blocked=save();
sim.reset();
assert.equal(restore(blocked),1);
assert.equal(snapshot()[8],3,'Recent deliveries survive restore before the next tick.');

// The kit on the belt belongs to the removed press, even if its old site is reused.
assert.equal(command(3,fourthPress),1);
assert.equal(command(1,fourthPress,14,1),1);
const rebuilt=save();
assert.equal(restore(rebuilt),1);
assert.equal(command(4,fourthDepot,0),1);
advance(15);
assert.equal(snapshot()[8],3);
assert.equal(snapshot()[21],0,'A replacement press cannot inherit an in-flight delivery.');

assert.equal(restore(blocked),1);
assert.equal(command(4,fourthDepot,0),1);
advance(15);
assert.equal(snapshot()[8],4);
assert.equal(fieldAt(fourthPress,18),1);
assert.ok(snapshot()[20]>=12);
assert.equal(snapshot()[21],1,'Four distinct delivering presses unlock regional freight.');

const saved = save();
const invalid = saved.slice();
invalid[0]++;
assert.equal(restore(invalid),-1);
assert.equal(restore(saved.subarray(0,saved.length-1)),-1);
assert.deepEqual(save(),saved,'An invalid save leaves the current world intact.');
sim.reset();
assert.equal(restore(saved),1);
assert.deepEqual(save(),saved,'The save restores inventory, in-flight goods and orbit progress.');
assert.equal(command(4,fourthDepot,8),1);
advance(400);
assert.ok(snapshot()[8]<4,'An idle delivery line ages out of the 20-second window.');
assert.equal(stage(),19);

// Expand reliable baseload and build a separate silica supply for the freight lines.
for (const [x,y] of [[5,7],[8,5]]) {
  place(x,y,4); place(x+1,y,9);
  cable(x,y,x+1,y); cable(x+1,y,24,16);
}
place(46,28,3); place(47,28,12); cable(46,28,47,21);
place(23,19,5); place(24,19,12); cable(22,19,24,19);
function deployMirror() {
  until(()=>fieldAt(tile(22,20),16)>=3,'Three more modules leave the assembly line.');
  act(11,22,20); act(13,33,15,7);
  for(let n=0;n<5;n++) act(9,23,16);
  act(13,33,15,3); assert.equal(command(5),1); advance(200);
}
function connectCity(city,x,receiverX) {
  until(()=>snapshot()[1]>=50,'Produce construction materials for the branch line.',6000);
  assert.equal(command(14,city),1);
  place(x,29,13); cable(x,29,33,15);
  const originX=33+city;
  // Valley receives raw silica and processes it locally. Highland receives finished cores.
  const localProcessing=city===1;
  const firstBelt=receiverX+(localProcessing?2:1);
  if (localProcessing) {
    place(receiverX+1,29,7); cable(receiverX+1,29,x,29);
    place(originX,17,12,1); act(4,originX,17,2);
  } else {
    place(originX,16,12,1); act(4,originX,16,2);
    place(originX,17,7,1); cable(originX,17,33,15);
  }
  const words=[];
  for(let n=firstBelt;n<x;n++) words.push(tile(n,29),0);
  assert.equal(command(2,0,0,0,words),1);
  until(()=>fieldAt(tile(x,29),15)===16,'A scheduled freight crate feeds the local belt and station.');
}
connectCity(1,48,44); deployMirror();
assert.equal(command(6,1,0),1); advance(360);
assert.equal(stage(),20,'A successful independent valley window reveals the third city.');
connectCity(2,9,5); deployMirror();
assert.equal(command(6,1,1),1); advance(700);
assert.equal(stage(),21,'Two adjacent windows unlock the three-city schedule.');
assert.equal(command(6,0,2),1); advance(1000);
const regionalSave=save(), progress=snapshot().slice(44,50);
sim.reset(); assert.equal(restore(regionalSave),1);
assert.deepEqual(save(),regionalSave,'Restoring an active campaign preserves routes, cargo and window timers.');
assert.deepEqual(snapshot().slice(44,50),progress);
advance(4000);
assert.equal(stage(),22,'Three complete cycles finish with reserves in all three stations.');
assert.equal(snapshot()[47],3); assert.equal(snapshot()[48],7);
console.log('主线通过：空手采矿、第一台机器、自动送料、首照、四厂段、跨谷实物交付、相邻窗口与连续三轮三城验收。');
