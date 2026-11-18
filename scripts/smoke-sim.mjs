import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const artifact = await readFile(new URL('../public/sim.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(artifact);
const sim = instance.exports;
const width = 56;
const tile = (x,y) => y * width + x;
const header = 98;
const fieldAt = (position,field) => snapshot()[header + 19 * position + field];

function command(op, a = 0, b = 0, c = 0, words = []) {
  const pointer = sim.reserve_input(words.length);
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

function device(position) {
  const frame=snapshot();
  for (let i=frame.at(-1);i<frame.length-1;) {
    const [site,id,grade,ore,demand,used,generation,charge,discharge,count]=frame.slice(i,i+10);
    i+=10;
    if (site===position) {
      const slots=Array.from({length:count},(_,n)=>frame.slice(i+n*5,i+(n+1)*5));
      return {id,grade,ore,demand,used,generation,charge,discharge,slots};
    }
    i+=count*5;
  }
  throw new Error(`Missing device ${position}`);
}

function directory() {
  const length=sim.directory();
  const words=Array.from(new Int32Array(sim.memory.buffer,sim.output_ptr(),length));
  const rows=new Map();
  for (let i=0;i<words.length;) {
    const row=words.slice(i,i+21+2*words[i+12]);
    rows.set(row[0],row);
    i+=row.length;
  }
  return rows;
}

function blueprints() {
  const length=sim.blueprints();
  const words=Array.from(new Int32Array(sim.memory.buffer,sim.output_ptr(),length));
  const dec=new TextDecoder();
  const entries=new Map();
  for (let i=2;i<words.length;) {
    const [width,height,devices,item,cost,id,version,nameLength,partCount]=words.slice(i,i+9);
    i+=9;
    const name=dec.decode(Uint8Array.from(words.slice(i,i+nameLength)));
    i+=nameLength;
    entries.set(id,{width,height,devices,item,cost,id,version,name,layout:words.slice(i,i+partCount*6)});
    i+=partCount*6;
  }
  assert.equal(entries.size,words[1]);
  return entries;
}

const named=(name)=>Array.from(new TextEncoder().encode(name));
const take=(position,item,count,id=device(position).id)=>command(15,position,-1,item,[count,id,0]);
const feedByHand=(position,item,count)=>command(15,-1,position,item,[count,0,device(position).id]);
const deploy=(position,id=0,version=1,turns=0)=>command(7,position,id,version,[turns]);

function save() {
  const length = sim.save();
  return new Int32Array(sim.memory.buffer, sim.output_ptr(), length).slice();
}

const reviewSaves = process.argv.includes('--capture-visual-review') ? new Map() : undefined;
function captureReview(name) {
  if (reviewSaves) reviewSaves.set(name, new Uint8Array(save().buffer));
}

function restore(saved) {
  const pointer = sim.reserve_input(saved.length);
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
const catalog=directory();
assert.deepEqual(catalog.get(20).slice(1,4),[11,2,14],'Industrial level exposes actual unlock stage and supported ores.');
assert.deepEqual(catalog.get(20).slice(12,15),[1,4,4]);
assert.deepEqual(catalog.get(17).slice(12,15),[1,1,5]);
assert.equal(catalog.get(9)[5],108);
assert.equal(snapshot()[36],0);
assert.equal(snapshot().slice(header,header+width*34*19).filter((_,i)=>i%19===0).some(Boolean),false);
for(let i=0;i<5;i++) act(9,19,16);
const gathered=save();
assert.equal(command(10),1);
const packed=save();
sim.reset(); assert.equal(restore(packed),1);
place(19,16,17);
assert.equal(snapshot()[36],0,'A legacy packed miner can still be placed.');
assert.equal(restore(gathered),1);
assert.equal(command(1,tile(19,17),17),-3);
assert.equal(snapshot()[36],5,'Invalid placement spends nothing.');
place(19,16,17);
assert.equal(snapshot()[36],0,'The directory placement spends materials directly from a fresh campaign.');
advance(120);
assert.equal(fieldAt(ore,10),2);
assert.equal(snapshot()[36],0);
captureReview('miner');
assert.deepEqual(device(ore).slots,[[1,2,2,8,2]]);
assert.equal(take(ore,2,1),-13,'An output slot checks its item.');
assert.equal(take(ore,1,1),1);
assert.equal(fieldAt(ore,10),1,'An exact withdrawal leaves the remaining stack.');
assert.equal(take(ore,1,9),1,'Taking more than available reports the actual count.');
assert.equal(take(ore,1,1),-9);
assert.equal(snapshot()[36],2);
assert.equal(command(12),1); assert.equal(command(12),1);
place(21,16,18);
advance(60); act(11,19,16);
const firstFeed=save();
for (let i=0;i<12;i++) act(9,19,16);
assert.deepEqual(device(bench).slots,[[1,1,0,10,3],[4,2,0,5,2],[9,3,0,1,3]]);
assert.equal(feedByHand(bench,1,6),6,'The first feed uses the normal transfer quantity.');
assert.equal(stage(),8);
assert.equal(feedByHand(bench,1,6),4,'Filling the input clamps to remaining capacity.');
assert.equal(feedByHand(bench,1,1),-14);
assert.deepEqual(device(bench).slots[0],[1,1,10,10,3]);
assert.equal(snapshot()[36],3,'The held stack plus the machine inventory is conserved.');
const takeInput=(position,item,count,id=device(position).id)=>command(15,position,-1,item,[count,id,0,1]);
const beforeTaking=save();
assert.equal(takeInput(bench,2,2),-13);
assert.deepEqual(save(),beforeTaking,'An incompatible input withdrawal leaves both inventories unchanged.');
advance(1);
assert.equal(device(bench).slots[0][2],9,'The running cycle reserves one item as soon as it starts.');
assert.equal(takeInput(bench,1,2),2);
assert.equal(device(bench).slots[0][2],7);
assert.equal(takeInput(bench,1,20),7);
assert.equal(snapshot()[36],12);
const noInput=save();
assert.equal(takeInput(bench,1,1),-9,'The reserved item cannot be withdrawn.');
assert.deepEqual(save(),noInput);
advance(29);
assert.equal(device(bench).slots[1][2],1,'Withdrawing unconsumed input does not interrupt a cycle.');
assert.equal(restore(firstFeed),1);
assert.equal(feedByHand(bench,1,1),1);
advance(30);
const firstPlate=save();
act(11,21,16);
while (snapshot()[1]<5) { act(9,19,16); assert.equal(command(12),1); }
place(23,16,12);
assert.equal(command(2,0,0,0,[tile(22,16),0]),1);
act(9,19,16); assert.equal(feedByHand(bench,1,1),1);
until(()=>stage()===11,'Shipping a press output by belt directly unlocks expansion.');
assert.equal(snapshot()[19],1);
assert.equal(restore(firstPlate),1);
act(11,21,16);
assert.equal(command(2,0,0,0,[tile(20,16),0]),1);
until(()=>stage()===11,'An automatically supplied plate opens expansion.');
until(()=>fieldAt(bench,13)>=4,'Collect plates to build the depot.');
act(11,21,16); place(22,16,12);
for (let n=0;n<120 && fieldAt(bench,13)===0;n++) advance(1);
assert.equal(fieldAt(bench,13),1,'The press buffers an output before the next belt pulse.');
const selectedPress=device(bench).id;
advance(5);
assert.equal(take(bench,4,1,selectedPress),-9,'Manual withdrawal cannot duplicate cargo taken by automation.');
advance(11000);
assert.ok(snapshot()[19]>=150);
const beforeDrill=save();
for (let i=0;i<5;i++) act(9,19,28);
const beforeDirectMiner=snapshot()[36];
const minerCost=snapshot()[31];
assert.equal(command(1,tile(21,19),17),-3,'An invalid direct miner placement spends no ore.');
assert.equal(snapshot()[36],beforeDirectMiner);
place(19,28,17);
assert.equal(snapshot()[36],beforeDirectMiner-minerCost,'A direct miner placement charges once.');
assert.equal(restore(beforeDrill),1);
assert.equal(command(1,tile(20,20),20),-19,'Undiscovered ore cannot be drilled.');
assert.equal(command(1,tile(21,19),20),-3,'An empty tile cannot be drilled.');
assert.equal(command(1,ore,20),-2,'An occupied ore deposit keeps its machine.');
assert.deepEqual(save(),beforeDrill,'Rejected construction does not spend materials.');
const platesBefore=snapshot()[1];
place(22,19,20); assert.equal(stage(),12);
assert.equal(snapshot()[1],platesBefore-4);
assert.deepEqual([device(tile(22,19)).grade,device(tile(22,19)).ore],[2,1]);
assert.equal(command(1,tile(23,16),20),-19,'Fuel mining also waits for a generator.');
place(24,16,9); place(23,16,20);
for(let i=0;i<8;i++) act(9,23,16);
act(13,24,16,3); cable(24,16,22,19);
until(()=>stage()===13,'Powered drill starts industrial production.');
assert.equal(device(tile(24,16)).generation,108);
assert.deepEqual(device(tile(22,19)).slots[0].slice(0,2),[1,2]);
until(()=>fieldAt(tile(23,16),12)>0,'An industrial miner on a fuel deposit produces fuel.');
assert.deepEqual([device(tile(23,16)).grade,device(tile(23,16)).ore],[2,3]);
act(9,20,20); place(20,20,20); place(21,20,6);
cable(22,19,20,20); cable(20,20,22,20);
until(()=>stage()===15,'Grinding a lens unlocks mirror assembly.');
assert.deepEqual([device(tile(20,20)).grade,device(tile(20,20)).ore],[2,2]);
assert.deepEqual(device(tile(20,20)).slots[0].slice(0,2),[2,2]);
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
assert.equal(command(6),1); advance(101); assert.equal(snapshot()[15],1);
assert.equal(device(tile(33,15)).demand,120);
assert.equal(device(tile(33,15)).used,0);
captureReview('first-light');
place(33,16,10); cable(33,15,33,16);
until(()=>device(tile(33,16)).charge>0,'A battery reports the power actually charging it.');
advance(1800); assert.equal(command(6),1); advance(101);
assert.equal(device(tile(33,15)).used,120);
assert.ok(device(tile(33,16)).discharge>0);
advance(499);
assert.equal(snapshot()[7],1,'Charged storage and continuous supply complete first light.');
place(19,28,2); place(21,28,5); place(22,28,14); place(24,28,12);
assert.equal(command(2,0,0,0,[tile(20,28),0,tile(23,28),0]),1);
cable(19,28,24,28); cable(23,20,23,28);
until(()=>snapshot()[2]>=12,'A player-built line delivers new expansion kits.');
const a=command(16,tile(19,28),tile(24,28),0,named('厂段 A'));
const b=command(16,tile(24,16),tile(24,16),0,named('厂段 B'));
assert.ok(a>0 && b>a);
const library=blueprints();
assert.deepEqual(library.get(a).layout.slice(0,3),[0,0,20]);
assert.deepEqual([library.get(a).width,library.get(a).height,library.get(a).devices,library.get(a).cost],[6,1,6,3]);
assert.equal(library.get(b).name,'厂段 B');
const librarySave=save();
sim.reset(); assert.equal(restore(librarySave),1);
assert.deepEqual(blueprints(),library);
assert.equal(command(17,a,0,0,named('扩建 A')),1);
assert.equal(blueprints().get(a).name,'扩建 A');
assert.equal(blueprints().get(b).name,'厂段 B');
const beforeBlueprint=save();
assert.equal(deploy(tile(28,28),a,2),-16);
assert.equal(deploy(tile(19,28),a),-2);
assert.equal(deploy(tile(55,33),a),-3);
assert.deepEqual(save(),beforeBlueprint,'An invalid blueprint does not change inventory or tiles.');
assert.equal(deploy(tile(28,28),a),1);
assert.equal(deploy(tile(26,5),b,1,1),1);
assert.equal(fieldAt(tile(26,5),1),1);
assert.equal(command(18,b),1);
assert.equal(deploy(tile(26,6),b),-16);
assert.equal(blueprints().has(b),false);
assert.equal(blueprints().has(a),true);
assert.equal(restore(beforeBlueprint),1);

const oldLayout=[0,0,2,0,1,0];
assert.equal(command(19,0,0,0,[0,0,2,7,1,0]),-17);
const imported=command(19,0,0,0,oldLayout);
assert.ok(imported>b);
assert.equal(blueprints().get(imported).layout[2],20);
const migratedLibrary=save();
assert.equal(restore(migratedLibrary),1);
assert.equal(command(19,0,0,0,oldLayout),1);
assert.deepEqual(save(),migratedLibrary,'A successful migration is idempotent after reloading.');
assert.equal(deploy(tile(12,30),imported),1,'A migrated layout resolves the new deposit.');
assert.deepEqual([device(tile(12,30)).grade,device(tile(12,30)).ore],[2,2]);
assert.equal(restore(beforeBlueprint),1);

// The version-four payload stores separate drill kinds and has no library tail.
const v4=beforeBlueprint.slice(0,54+width*34*19);
v4[0]=4;
const legacyInputs=new Map([[5,[[1,1]]],[6,[[2,2]]],[7,[[2,1]]],[8,[[4,2],[5,1]]],
  [14,[[4,2]]],[16,[[2,4]]],[18,[[1,1]]]]);
for (let i=0;i<width*34;i++) {
  const row=54+i*19;
  if (v4[row]===20) v4[row]=fieldAt(i,0);
  if (v4[row+4]>0) for (const [item,amount] of legacyInputs.get(v4[row]) ?? []) v4[row+9+item]+=amount;
}
const drills=[tile(22,19),tile(20,20),tile(23,16)];
const oldDrills=drills.map(i=>snapshot().slice(header+i*19,header+(i+1)*19));
assert.equal(restore(v4),1);
for (const [n,i] of drills.entries()) {
  const migrated=snapshot().slice(header+i*19,header+(i+1)*19);
  assert.deepEqual(migrated.slice(0,4),oldDrills[n].slice(0,4));
  assert.deepEqual(migrated.slice(7,18),oldDrills[n].slice(7,18));
}
assert.equal(restore(beforeBlueprint),1);
assert.equal(deploy(tile(28,28),a),1);
for (const [x,y] of [[38,26],[47,21]]) assert.equal(deploy(tile(x,y)),1);
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
const removedId=device(fourthPress).id;
assert.equal(command(3,fourthPress),1);
assert.equal(command(1,fourthPress,14,1),1);
assert.notEqual(device(fourthPress).id,removedId);
assert.equal(take(fourthPress,8,1,removedId),-15,'A stale selection cannot take from a replacement device.');
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
  if (city===1) {
    const citySave=save(), sender=tile(originX,18), receiver=tile(receiverX,29);
    for (let n=0;n<35;n++) act(9,20,20);
    const heldBefore=snapshot()[37];
    assert.equal(feedByHand(sender,2,35),32);
    assert.equal(feedByHand(sender,2,1),-14);
    assert.equal(feedByHand(sender,1,1),-14,'Freight inputs share their capacity.');
    assert.equal(snapshot()[37],heldBefore-32);
    assert.deepEqual(device(sender).slots.find(slot=>slot[0]===2),[2,1,32,32,1]);
    assert.equal(feedByHand(tile(x,29),6,1),-12);
    assert.equal(feedByHand(receiver,2,1),-13);
    assert.equal(take(receiver,2,1),-12);
    assert.equal(restore(citySave),1);
  }
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
captureReview('three-cities');
assert.equal(command(6,0,2),1); advance(1000);
const regionalSave=save(), progress=snapshot().slice(44,50);
sim.reset(); assert.equal(restore(regionalSave),1);
assert.deepEqual(save(),regionalSave,'Restoring an active campaign preserves routes, cargo and window timers.');
assert.deepEqual(snapshot().slice(44,50),progress);
advance(4000);
assert.equal(stage(),22,'Three complete cycles finish with reserves in all three stations.');
assert.equal(snapshot()[47],3); assert.equal(snapshot()[48],7);
console.log('主线通过：空手采矿、第一台机器、自动送料、首照、四厂段、跨谷实物交付、相邻窗口与连续三轮三城验收。');

const basicFixture=save();
basicFixture.fill(0,4,13);
basicFixture[5]=100;
basicFixture[6]=100;
basicFixture[8]=300;
basicFixture[12]=50;
assert.equal(restore(basicFixture),1);

function previewTransports(words) {
  new Int32Array(sim.memory.buffer,sim.reserve_input(words.length),words.length).set(words);
  const length=sim.preview_transports(words.length);
  return Array.from(new Int32Array(sim.memory.buffer,sim.output_ptr(),length));
}
function cargoTracks() {
  const frame=snapshot(), end=frame.at(-1)-1, cargo=new Map();
  for (let i=frame[end]+1;i<end;i+=8) cargo.set(frame[i],frame.slice(i+1,i+8));
  return cargo;
}
assert.deepEqual(catalog.get(1).slice(15,19),[1,1,5,1]);
assert.deepEqual(catalog.get(22).slice(15,19),[2,1,2,1]);
assert.deepEqual(catalog.get(24).slice(15),[0,2,5,1,1,1,2,2]);
const cross=tile(18,18), fast=tile(19,18);
place(17,18,12); act(4,17,18,2);
place(18,17,12,1); act(4,18,17,8);
const work=[cross,24,0,fast,22,0];
const quote=previewTransports(work);
assert.deepEqual(quote.slice(3),[4,8]);
assert.equal(quote[0],1);
assert.equal(command(20,quote[2]-1,0,0,work),-23);
assert.equal(command(20,quote[2],0,0,work),1);
advance(40);
const twoLanes=cargoTracks();
const [oreId,oreItem,deviceId]=twoLanes.get(cross*2);
assert.equal(oreItem,2);
assert.equal(twoLanes.get(cross*2+1)[1],8);
const fullCross=save();
assert.equal(restore(fullCross),1);
assert.deepEqual(save(),fullCross);
assert.equal(previewTransports([cross,15,0])[0],-21);
assert.equal(command(21,cross,0,2,[oreId,deviceId]),1);
const afterPickup=save();
assert.equal(command(21,cross,0,2,[oreId,deviceId]),-22);
assert.deepEqual(save(),afterPickup);
assert.equal(cargoTracks().get(cross*2+1)[0],twoLanes.get(cross*2+1)[0]);
advance(10);
assert.notEqual(cargoTracks().get(cross*2)[0],oreId);
const newPlan=command(16,cross,fast,0,named('高速交叉段'));
const layout=blueprints().get(newPlan);
assert.deepEqual([layout.layout[2],layout.layout[8]],[24,22]);
assert.equal(deploy(tile(18,23),newPlan,layout.version),1);
assert.equal(fieldAt(tile(18,23),0),24);
assert.equal(fieldAt(tile(19,23),0),22);
console.log('物流通过：预览报错与费用、覆建身份、并行货物投影、取货防重、双通道存档和高速蓝图部署。');

const progressStart=saved=>{
  const offset=54+width*34*19;
  return offset+4+saved[offset+2]*8+saved[offset+3]*3;
};
const limits=()=>{
  const frame=snapshot();
  const offset=frame[frame.at(-1)-1]-13;
  return frame.slice(offset,offset+11);
};
assert.deepEqual(limits().slice(0,10),[0,16,0,2,9,48,2,2,54,33]);
assert.equal(sim.max_speed(),2);
assert.equal(command(1,tile(0,10),12),-3);
assert.equal(command(1,tile(16,22),26),-6);
assert.equal(command(1,tile(27,5),30),-19);
const beforeHub=save();
place(16,22,25);
assert.equal(limits()[0],0,'Building the delivery hub does not complete a stage.');
const hubSave=save();
const full=hubSave.slice();
full.fill(0,4,13);
full[5]=1500;
full[6]=99;
assert.equal(restore(full),1);
assert.equal(limits()[10],16);
assert.equal(command(9,ore),-24,'A new stack cannot be opened when all slots are used.');
assert.equal(command(9,tile(20,20)),1,'The existing partial stack can still be filled.');
assert.equal(command(9,tile(20,20)),-24,'An individual stack cannot exceed its cap.');
assert.equal(restore(hubSave),1);

const nextStage=save();
const start=progressStart(nextStage);
nextStage[start]=1;
nextStage[start+2]=1;
assert.equal(restore(nextStage),1);
assert.deepEqual(limits().slice(0,10),[1,24,0,4,6,64,0,0,56,34]);
assert.equal(sim.max_speed(),4);
beforeHub[progressStart(beforeHub)]=1;
assert.equal(restore(beforeHub),1);
place(0,10,12);
const recent=save();
const legacySource=recent.subarray(0,recent.length-recent.at(-1));
const v7=legacySource.slice();
v7[0]=7;
assert.equal(restore(v7),1);
assert.deepEqual(save(),recent);
const legacyOffset=progressStart(legacySource);
const v6=new Int32Array(legacySource.length-4);
v6.set(legacySource.subarray(0,legacyOffset));
v6.set(legacySource.subarray(legacyOffset+4),legacyOffset);
v6[0]=6;
assert.equal(restore(v6),1);
assert.equal(fieldAt(tile(0,10),0),12);
assert.deepEqual(limits().slice(0,10),[0,16,0,2,9,48,0,0,56,34]);
assert.equal(restore(nextStage),1);
place(16,23,26);
place(27,5,30);
assert.deepEqual([device(tile(27,5)).grade,device(tile(27,5)).ore],[3,1]);
const moduleStation=tile(17,23);
place(17,23,18);
assert.equal(feedByHand(moduleStation,1,1),1);
assert.equal(command(15,-1,moduleStation,9,[1,0,device(moduleStation).id,3]),1);
assert.deepEqual(device(moduleStation).slots[2],[9,3,1,1,3]);
const equipped=save();
assert.equal(restore(equipped),1);
assert.deepEqual(save(),equipped);
advance(19);
assert.equal(device(moduleStation).slots[1][2],0);
advance(1);
assert.equal(device(moduleStation).slots[1][2],1,'The module shortens the 30-tick cycle to 20 ticks.');
assert.equal(command(15,moduleStation,-1,9,[1,device(moduleStation).id,0,3]),1);
assert.deepEqual(device(moduleStation).slots[2],[9,3,0,1,3]);
console.log('发展系统通过：满仓限制、阶段交付站、地图与倍速边界、高阶设备、V6 迁移及速度模块。');

if (reviewSaves) {
  const directory = new URL('../docs/visual-review.local/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await Promise.all([...reviewSaves].map(([name, data]) =>
    writeFile(new URL(name + '.dawn', directory), data)));
}
