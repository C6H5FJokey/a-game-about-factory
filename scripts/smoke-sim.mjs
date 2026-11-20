import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadContent } from './content.mjs';

const content=loadContent();
const artifact = await readFile(new URL('../public/sim.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(artifact);
const sim = instance.exports;
const hz = sim.tick_rate();
assert.equal(hz, 30);
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

function saveWith20HzClock(current) {
  const saved = current.slice();
  const toOldClock = index => { saved[index] = Math.floor(saved[index] * 20 / hz); };
  for (const index of [1,14,16,19,20,21,32,43]) toOldClock(index);
  const transport = 54 + width*34*19;
  for (let row=54;row<transport;row+=19) {
    if (saved[row]===9) saved[row+4] = Math.floor(saved[row+4] * 20 / (2*hz));
    else toOldClock(row+4);
    for (const field of [5,6,9]) toOldClock(row+field);
  }
  const cargoEnd = transport + 4 + saved[transport+2]*8;
  for (let row=transport+4;row<cargoEnd;row+=8) {
    toOldClock(row+5);
    toOldClock(row+6);
  }
  for (let row=cargoEnd;row<cargoEnd+saved[transport+3]*3;row+=3) {
    toOldClock(row+1);
    toOldClock(row+2);
  }
  return saved;
}

function legacySave(current,version) {
  const data=version<9?saveWith20HzClock(current):current.slice();
  const transport=54+width*34*19;
  const progression=transport+4+data[transport+2]*8+data[transport+3]*3;
  const devices=progression+4+data[progression+3];
  const extension=devices+2+data[devices+1];
  const extra=content.frontend.items.length-10;
  let ground=extension+1+extra*3;
  const recipeWords=[...data.subarray(extension,ground)];
  for (let row=54;row<transport;row+=19) {
    if (!data[row]) continue;
    const legacyLimit=data[row]===19?32:24;
    for (let i=row+10;i<row+18;i++) data[i]=Math.min(data[i],legacyLimit);
    recipeWords.push(...data.subarray(ground,ground+extra+3));
    ground+=extra+3;
    if (data[row]===12) {
      data.fill(0,row+10,row+18);
      recipeWords.fill(0,recipeWords.length-extra-2,recipeWords.length-2);
      ground++;
    }
  }
  const [,piles,payments,bundles]=data.subarray(ground,ground+4);
  let library=ground+4+piles*4;
  const oldPayments=[];
  for (let n=0;n<payments;n++) {
    const next=library+3+(data[library+1]===0?data[library+2]*2:0);
    oldPayments.push(data.slice(library,next));
    library=next;
  }
  const oldBundles=new Map();
  for (let n=0;n<bundles;n++) {
    const [id,rows,count,item,amount]=data.subarray(library,library+5);
    if (rows===1 && item===8) oldBundles.set(id,[id,amount,count]);
    library+=3+rows*2;
  }
  const compatible=oldPayments.filter(row=>row[1]!==2 || oldBundles.has(row[2]));
  data[0]=version;
  data[4]=0;
  return Int32Array.from([
    ...data.subarray(0,version<7?progression:extension),
    ...(version<7?data.subarray(devices,extension):[]),
    ...(version>=10?recipeWords:[]),
    ...(version===11?[data[ground],piles,compatible.length,oldBundles.size,
      ...data.subarray(ground+4,ground+4+piles*4),...compatible.flatMap(row=>[...row]),...Array.from(oldBundles.values()).flat()]:[]),
    ...data.subarray(library,data.length-data.at(-1)),
    ...(version>=10?content.tag:version>=8?content.legacyTag:[]),
  ]);
}

const captureVisual = process.argv.includes('--capture-visual-review');
const capturePerformance = process.argv.includes('--capture-performance');
const reviewSaves = captureVisual || capturePerformance ? new Map() : undefined;
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
const warehouseStock=(position,item)=>device(position).slots.find(row=>row[0]===item)?.[2] ?? 0;
function constructionStock(item) {
  const frame=snapshot();
  let total=frame[35+item];
  for (let i=frame.at(-1);i<frame.length-1;) {
    const tile=frame[i], slots=frame[i+9];
    i+=10;
    if (frame[header+tile*19]===12) {
      for (let n=0;n<slots;n++) if (frame[i+5*n]===item) total+=frame[i+5*n+2];
    }
    i+=5*slots;
  }
  return total;
}
const takeFromWarehouse=(position,item,count)=>command(15,position,-1,item,[count,device(position).id,0,1]);
const fundWarehouse=(position,item,count)=>assert.equal(feedByHand(position,item,count),count);
const stage=()=>snapshot()[29];
const mapBounds=()=>{
  const frame=snapshot();
  const progression=frame[frame.at(-1)-1]-13;
  return frame.slice(progression+6,progression+10);
};
const ore=tile(19,16), bench=tile(21,16);
function until(test,label,limit=2400) {
  for (let n=0;n<limit && !test();n+=5) advance(5);
  assert.ok(test(),label);
}

function testProductionOpening() {
  const key = id => content.frontend.recipes.find(row=>row.id===id).key;
  const choose=(position,id)=>command(22,position,device(position).id,key(id));
  const available=(position,item,role)=>device(position).slots.find(row=>row[0]===item&&row[1]===role)?.[2] ?? 0;
  const heldNew=item=>{
    const frame=snapshot();
    const recipeEnd=frame[frame[frame.at(-1)-1]-14]-1;
    return frame[frame[recipeEnd]+2+item-10];
  };
  let token=0;
  const craft=(id,ticks,output=1)=>{
    assert.equal(command(23,key(id),++token),1);
    advance(ticks-1);
    assert.equal(command(25,token),-27);
    advance(1);
    assert.equal(command(25,token),output);
    assert.equal(command(24,token),1);
  };
  const tiers=directory();
  for(const [kind,rate] of [[1,60],[22,120],[26,270],[32,600]]) {
    const row=tiers.get(kind);
    assert.equal(row[15+2*row[12]],-rate);
  }
  assert.equal(tiers.get(17)[14],10);
  const copper=tile(11,16), coal=tile(30,16), silica=tile(33,18);
  const generator=tile(20,17), furnace=tile(20,16), table=tile(22,16);
  assert.deepEqual(mapBounds(),[13,10,26,23]);
  assert.equal(fieldAt(tile(22,19),3),1,'An iron deposit inside the first ring is visible at the start.');
  assert.equal(command(9,copper),-3);
  for(let n=0;n<10;n++) assert.equal(command(9,ore),1);
  assert.equal(command(1,ore,17),1);
  advance(3*hz);
  captureReview('miner');
  assert.equal(take(ore,1,1),1);
  assert.equal(stage(),5);
  assert.deepEqual(mapBounds(),[0,0,56,34]);
  assert.equal(fieldAt(copper,3),10);
  assert.equal(fieldAt(coal,3),3);
  assert.equal(fieldAt(silica,3),2);
  assert.equal(command(9,coal),1,'Coal can be explored before the power tutorial.');
  assert.equal(command(9,silica),1,'Silica can be explored before the optics tutorial.');
  assert.equal(stage(),5,'Exploring does not skip the current tutorial.');
  for(let n=0;n<31;n++) assert.equal(command(9,ore),1);
  for(let n=0;n<8;n++) assert.equal(command(9,copper),1);
  captureReview('handcraft');
  assert.equal(command(23,key('form-plate'),++token),-6,'A machine-only recipe cannot be made by hand.');
  assert.equal(command(23,key('smelt-iron-ingot'),++token),1);
  advance(7);
  assert.equal(command(24,token),1);
  advance(15);
  assert.equal(command(25,token),-1);
  assert.equal(snapshot()[36],32,'Cancelling a handcraft batch consumes no ore.');
  for(let n=0;n<16;n++) craft('smelt-iron-ingot',15);
  assert.equal(heldNew(11),16);
  for(let n=0;n<4;n++) craft('smelt-copper-ingot',30);
  for(let n=0;n<4;n++) craft('draw-copper-wire',120,2);
  assert.equal(heldNew(15),8);
  assert.equal(stage(),6,'Copper wire opens the first grid without electricity.');
  assert.deepEqual(mapBounds(),[0,0,56,34]);
  assert.equal(fieldAt(coal,3),3);
  assert.equal(fieldAt(silica,3),2);
  assert.equal(command(1,generator,9),1);
  assert.equal(command(1,furnace,5),1);
  assert.equal(feedByHand(furnace,1,1),-13,'An unconfigured machine has no material inlet.');
  assert.equal(choose(furnace,'form-plate'),-6);
  const stale=device(furnace).id;
  assert.equal(choose(furnace,'smelt-iron-ingot'),1);
  assert.equal(command(15,-1,furnace,1,[1,0,stale]),-15);
  const refill=()=>{
    for(let n=0;n<8;n++) assert.equal(command(9,coal),1);
    assert.ok(feedByHand(generator,3,8)>0);
  };
  refill();
  for(let n=0;n<12;n++) assert.equal(command(9,ore),1);
  assert.equal(feedByHand(furnace,1,10),10);
  advance(30);
  assert.equal(fieldAt(furnace,5),3,'Unpowered furnace waits.');
  assert.equal(choose(furnace,'smelt-copper-ingot'),-26,'Switching a backed-up machine preserves inventory.');
  cable(20,17,20,16);
  assert.equal(heldNew(15),4);
  advance(150);
  assert.equal(available(furnace,11,2),5);
  assert.equal(take(furnace,11,5),5);
  advance(90);
  assert.equal(take(furnace,11,3),3);
  assert.equal(command(1,table,18),1);
  if (reviewSaves) {
    const beforeWiring=save();
    assert.equal(choose(table,'form-plate'),1);
    for (let n=0;n<24;n++) assert.equal(command(9,ore),1);
    for (let n=0;n<12;n++) craft('smelt-iron-ingot',15);
    assert.equal(command(9,coal),1);
    captureReview('assembly');
    assert.equal(restore(beforeWiring),1);
  }
  cable(20,16,22,16);
  assert.equal(heldNew(15),0);
  assert.equal(choose(table,'form-plate'),1);
  refill();
  advance(60);
  assert.equal(take(furnace,11,2),2);
  assert.equal(feedByHand(table,11,2),2);
  advance(90);
  assert.equal(take(table,4,1),1);
  assert.equal(command(1,tile(21,16),1),1);
  assert.equal(stage(),9);
  const conserved=available(ore,1,2);
  assert.ok(conserved>0);
  assert.equal(command(1,tile(18,16),1),-4,'The single starting belt spent one plate.');
  for(let n=0;n<3;n++) assert.equal(command(9,ore),1);
  assert.equal(feedByHand(furnace,1,5),5);
  refill();
  until(()=>stage()===10,'A belt actually sends iron ingots to the assembly bench.');
  const flowing=save();
  assert.equal(restore(flowing),1);
  assert.deepEqual(save(),flowing);
  until(()=>stage()===11,'Only the batch using automatic intake advances the opening.');
  assert.ok(available(ore,1,2)>=conserved,'The simple miner retained its ore and can continue filling its output slot.');
  const beforeOptics=save();
  beforeOptics[23]=13;
  assert.equal(restore(beforeOptics),1);
  advance(1);
  assert.equal(stage(),14,'Silica gathered earlier already satisfies the silica objective.');
  console.log('P1 opening passed: timed handcraft, copper wiring, recipe choice, automatic intake and save restore.');
}

function testGroundItems() {
  const piles=()=>{
    const view=snapshot();
    const recipeEnd=view[view[view.at(-1)-1]-14]-1;
    const groundEnd=view[recipeEnd]-1;
    const result=[];
    for (let i=view[groundEnd];i<groundEnd;i+=4) result.push(view.slice(i,i+4));
    return result;
  };
  for(let n=0;n<10;n++) assert.equal(command(9,ore),1);
  assert.equal(command(1,ore,17),1);
  advance(3*hz);
  const beforeRemoval=save();
  const full=beforeRemoval.slice();
  full[5]=98;
  full[8]=1500;
  assert.equal(restore(full),1);
  assert.equal(command(3,ore),1);
  assert.equal(snapshot()[36],100);
  const [[tile,item,id,count]]=piles();
  assert.deepEqual([tile,item,count],[ore,1,9]);
  const withPile=save();
  assert.equal(restore(withPile),1);
  assert.deepEqual(save(),withPile);
  assert.equal(command(27,ore,1,id),-24);
  assert.equal(command(26,0,1,2),-3);
  assert.equal(command(26,ore+1,1,2),2);
  assert.equal(command(27,ore,1,id),2);
  assert.equal(piles()[0][3],7);
  assert.equal(command(26,ore,4,100),100);
  assert.equal(command(27,ore,1,id),7);
  assert.equal(command(27,ore,1,id),-28);
  assert.equal(command(26,ore,1,1),1);
  assert.equal(command(27,ore,1,id),-28);
  assert.equal(restore(legacySave(beforeRemoval,10)),1);
  assert.equal(command(3,ore),1);
  assert.equal(snapshot()[36],1,'An unrecorded legacy machine still returns its contents.');
  assert.equal(snapshot()[30],1,'An unrecorded legacy basic miner returns as a packed machine.');
  console.log('P2 passed: overflow, partial pickup, stale IDs, current save round-trip and V10 import.');
}

function testSimpleMinerDeposits(empty) {
  const copper=tile(11,16), adjacentBelt=tile(12,16), plain=tile(19,17);
  const deposits=[[ore,1],[tile(33,18),2],[tile(30,16),3],[copper,10]];
  const funded=empty.slice();
  funded[5]=60;
  funded[8]=2;
  assert.equal(restore(funded),1);
  assert.equal(command(1,copper,17),-3,'Copper is hidden at the start.');
  assert.deepEqual(save(),funded);

  funded[23]=9; // The full map is accessible, and conveyor construction has unlocked.
  assert.equal(restore(funded),1);
  assert.deepEqual(mapBounds(),[0,0,56,34]);
  const miner=directory().get(17);
  const [amount,ticks]=miner.slice(9,11);
  assert.equal(miner[3],deposits.reduce((mask,[,item])=>mask|(1<<item),0));
  assert.equal(command(1,plain,17),-3,'Bare ground cannot be mined.');
  for (const [position] of deposits) assert.equal(command(1,position,17),1);
  assert.equal(command(1,adjacentBelt,1),1);

  advance(Math.floor(ticks/2));
  const midCycle=save();
  assert.equal(restore(midCycle),1);
  assert.deepEqual(save(),midCycle);
  advance(ticks-Math.floor(ticks/2));
  for (const [position,item] of deposits) {
    const {grade,ore,slots}=device(position);
    assert.equal(grade,1);
    assert.equal(ore,item);
    assert.deepEqual(slots.map(slot=>slot.slice(0,3)),[[item,2,amount]]);
  }
  advance(ticks);
  assert.equal(fieldAt(adjacentBelt,4),0,'The simple miner does not feed a belt in a new campaign.');
  assert.equal(take(copper,1,1),-13);
  for (const [position,item] of deposits) assert.equal(take(position,item,1),1);
  console.log('Simple miner passed: all four deposits, manual collection and mid-cycle save restore.');
}

function testWarehouseStorage(empty) {
  const funded=empty.slice();
  funded[23]=11;
  funded[17]=1;
  funded[5]=810;
  funded[8]=16;
  funded[12]=2;
  assert.equal(restore(funded),1);
  const west=tile(17,21), middle=tile(18,21), east=tile(19,21);
  place(17,21,12); place(19,21,12);
  assert.equal(command(4,east,19),1,'Any registered material can be configured before it is obtainable.');
  assert.deepEqual(device(east).slots,[],'An empty warehouse has no row for its configured export or any other material.');
  assert.equal(feedByHand(east,1,1),1,'An empty warehouse can take a different material from its export setting.');
  assert.deepEqual(device(east).slots.map(row=>row.slice(0,3)),[[1,1,1]]);
  assert.equal(takeFromWarehouse(east,1,1),1);
  assert.equal(command(4,east,0),1);
  const later=save();
  later[23]=18;
  assert.equal(restore(later),1);
  assert.deepEqual(device(east).slots,[],'A later stage does not add empty inventory entries.');
  assert.deepEqual(device(west).slots,[]);
  assert.equal(feedByHand(west,1,805),800);
  assert.equal(feedByHand(west,4,1),-14,'Warehouse capacity is shared across items.');
  assert.equal(warehouseStock(east,1),0);
  assert.equal(takeFromWarehouse(west,1,5),5);
  assert.equal(feedByHand(west,4,1),-14,'A partially filled stack still occupies its slot.');
  fundWarehouse(west,1,5);
  assert.equal(takeFromWarehouse(west,1,105),105);
  fundWarehouse(west,4,4); fundWarehouse(east,4,4);
  fundWarehouse(east,8,2);
  const provided=save();
  assert.equal(restore(provided),1);
  assert.deepEqual(save(),provided);
  assert.deepEqual(device(west).slots.find(row=>row[0]===1),[1,1,695,100,7]);
  assert.equal(restore(legacySave(provided,11)),1);
  assert.equal(snapshot()[36],115,'V11 backpack remains in the backpack.');
  assert.equal(warehouseStock(west,1),0,'A legacy warehouse starts empty.');
  assert.equal(restore(provided),1);
  assert.equal(previewTransports([middle,1,0])[0],1);
  place(18,21,1);
  assert.equal(warehouseStock(west,4),3,'Nearest warehouses tie-break by tile.');
  assert.equal(warehouseStock(east,4),4);
  assert.equal(command(4,west,1),1);
  advance(8*hz);
  assert.ok(warehouseStock(east,1)>0);
  assert.equal(snapshot()[36],115,'Automatic transfers do not use backpack inventory.');
  const delivered=snapshot()[20];
  assert.equal(takeFromWarehouse(east,8,2),2);
  fundWarehouse(east,8,2);
  assert.equal(snapshot()[20],delivered,'Manual withdrawals and deposits do not count as deliveries.');
  const layout=command(16,middle,middle,0,named('Warehouse deployment'));
  assert.ok(layout>0);
  assert.equal(deploy(tile(23,21),layout),1);
  assert.equal(warehouseStock(east,8),2-blueprints().get(layout).cost);
  const deployed=save();
  assert.equal(restore(legacySave(deployed,11)),1);
  assert.equal(command(3,tile(23,21)),1);
  assert.equal(snapshot()[2],blueprints().get(layout).cost,'V11 bundle receipts still return their kits.');
  assert.equal(restore(deployed),1);
  const heldBefore=snapshot()[36], storedBefore=warehouseStock(west,1);
  assert.equal(command(3,west),1);
  assert.equal(snapshot()[36],heldBefore+storedBefore);
  console.log('Warehouse passed: capacity, migration, independent inventory, transfers, construction and return.');
}

function testCableBatches(empty) {
  const funded=legacySave(empty,9);
  funded[23]=13;
  funded[8]=10;
  assert.equal(restore(funded),1);
  const a=tile(17,21), b=a+1, c=a+2, d=a+3, e=a+4;
  const cut=(...tiles)=>command(28,0,0,0,tiles);
  place(17,21,1);
  cable(17,21,20,21);
  cable(19,21,21,21);
  assert.equal(snapshot()[39],6);
  const wired=save();
  for (const invalid of [[a,c],[a,b,b],[d,e,e+1]]) {
    assert.equal(cut(...invalid),-1);
    assert.deepEqual(save(),wired,'Invalid paths leave the entire transaction untouched.');
  }
  assert.equal(cut(b,c),1);
  assert.equal(snapshot()[39],6);
  const partial=save();
  assert.equal(restore(partial),1);
  assert.deepEqual(save(),partial);
  assert.equal(cut(d,e),1);
  assert.equal(snapshot()[39],7,'Shared existing wire preserves its original receipt.');
  assert.equal(cut(a),1);
  assert.equal(snapshot()[39],9,'The first batch pays back only when its last wire is removed.');
  assert.equal(fieldAt(a,0),1,'Cable removal leaves the equipment above it.');
  assert.equal(restore(legacySave(wired,11)),1);
  assert.equal(cut(a,b,c,d,e),1);
  assert.equal(snapshot()[39],6,'Unrecorded legacy cable does not create a refund.');
  assert.equal(restore(wired),1);
  const full=wired.slice();
  full[5]=1600;
  full[8]=0;
  assert.equal(restore(full),1);
  assert.equal(cut(a,b,c,d,e),1);
  assert.equal(snapshot()[39],0);
  const frame=snapshot(), recipeEnd=frame[frame[frame.at(-1)-1]-14]-1;
  const groundEnd=frame[recipeEnd]-1;
  const refunds=[];
  for (let i=frame[groundEnd];i<groundEnd;i+=4) refunds.push(frame.slice(i,i+4));
  assert.deepEqual(refunds.map(([tile,item,,count])=>[tile,item,count]),[[d,4,2],[e,4,1]]);
  console.log('Cable batches passed: validation, reuse, restart, legacy import and overflow refunds.');
}

const modernEmpty=save();
const previousMap=modernEmpty.slice();
previousMap[0]=13;
previousMap[4]=0;
previousMap[23]=5;
assert.equal(restore(previousMap),1);
assert.deepEqual(mapBounds(),[2,2,54,33]);
assert.equal(fieldAt(tile(17,17),3),10,'V13 saves keep the original copper deposit.');
assert.equal(fieldAt(tile(11,16),3),0);
const migratedMap=save();
assert.equal(restore(migratedMap),1);
assert.deepEqual(save(),migratedMap);
assert.equal(restore(modernEmpty),1);
testProductionOpening();
assert.equal(restore(modernEmpty),1);
testGroundItems();
testSimpleMinerDeposits(modernEmpty);
testWarehouseStorage(modernEmpty);
testCableBatches(modernEmpty);
assert.equal(restore(legacySave(modernEmpty,9)),1);
advance(100);
assert.equal(stage(),0);
const catalog=directory();
assert.deepEqual(catalog.get(20).slice(1,4),[11,2,14],'Industrial level exposes actual unlock stage and supported ores.');
assert.deepEqual(catalog.get(20).slice(12,15),[1,4,4]);
assert.deepEqual(catalog.get(17).slice(12,15),[1,1,5]);
assert.equal(catalog.get(9)[5],108);
assert.equal(catalog.get(10)[7]/(10*hz),120,'The battery still holds 120 MJ.');
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
advance(6*hz);
assert.equal(fieldAt(ore,10),2);
assert.equal(snapshot()[36],0);
assert.deepEqual(device(ore).slots,[[1,2,2,100,2]]);
assert.equal(take(ore,2,1),-13,'An output slot checks its item.');
assert.equal(take(ore,1,1),1);
assert.equal(fieldAt(ore,10),1,'An exact withdrawal leaves the remaining stack.');
assert.equal(take(ore,1,9),1,'Taking more than available reports the actual count.');
assert.equal(take(ore,1,1),-9);
assert.equal(snapshot()[36],2);
assert.equal(command(12),1); assert.equal(command(12),1);
place(21,16,18);
advance(3*hz); act(11,19,16);
const firstFeed=save();
for (let i=0;i<102;i++) act(9,19,16);
const ironBeforeFeed=snapshot()[36];
assert.deepEqual(device(bench).slots,[[1,1,0,100,7],[4,2,0,100,2],[9,3,0,100,7]]);
assert.equal(feedByHand(bench,1,96),96,'The first feed uses the normal transfer quantity.');
assert.equal(stage(),8);
assert.equal(feedByHand(bench,1,6),4,'Filling the input clamps to remaining capacity.');
assert.equal(feedByHand(bench,1,1),-14);
assert.deepEqual(device(bench).slots[0],[1,1,100,100,3]);
assert.equal(snapshot()[36],ironBeforeFeed-100,'The held stack plus the machine inventory is conserved.');
const takeInput=(position,item,count,id=device(position).id)=>command(15,position,-1,item,[count,id,0,1]);
const beforeTaking=save();
assert.equal(takeInput(bench,2,2),-13);
assert.deepEqual(save(),beforeTaking,'An incompatible input withdrawal leaves both inventories unchanged.');
advance(1);
assert.equal(device(bench).slots[0][2],99,'The running cycle reserves one item as soon as it starts.');
assert.equal(takeInput(bench,1,2),2);
assert.equal(device(bench).slots[0][2],97);
assert.equal(takeInput(bench,1,200),97);
assert.equal(snapshot()[36],ironBeforeFeed-1);
const noInput=save();
assert.equal(takeInput(bench,1,1),-9,'The reserved item cannot be withdrawn.');
assert.deepEqual(save(),noInput);
advance(1.5*hz-1);
assert.equal(device(bench).slots[1][2],1,'Withdrawing unconsumed input does not interrupt a cycle.');
assert.equal(restore(firstFeed),1);
assert.equal(feedByHand(bench,1,1),1);
advance(1.5*hz);
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
advance(8);
assert.equal(take(bench,4,1,selectedPress),-9,'Manual withdrawal cannot duplicate cargo taken by automation.');
advance(550*hz);
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
const platesBefore=constructionStock(4);
place(22,19,20); assert.equal(stage(),12);
assert.equal(constructionStock(4),platesBefore-4);
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
const plateWarehouse=tile(22,16), mirrorWarehouse=tile(22,21);
assert.equal(takeFromWarehouse(plateWarehouse,4,24),24);
fundWarehouse(mirrorWarehouse,4,24);
until(()=>stage()===16,'Assembling a real mirror opens launch.');
place(33,15,13); cable(22,20,33,15);
until(()=>fieldAt(tile(22,20),16)>=3,'Build three mirror modules.');
act(11,22,20); act(13,33,15,7);
for(let i=0;i<5;i++) act(9,23,16);
act(13,33,15,3); assert.equal(command(5),1);
advance(10*hz); assert.equal(stage(),17);
place(5,20,3); place(6,20,7,3); cable(5,20,20,20);
const feed=[tile(6,19),3,tile(6,18),3,tile(6,17),3,tile(6,16),3,tile(6,15),3,tile(6,14),0];
for(let x=7;x<33;x++) feed.push(tile(x,14),0);
feed.push(tile(33,14),1);
assert.equal(command(2,0,0,0,feed),1);
until(()=>snapshot()[13]>=16,'Cores arrive at the station.');
assert.equal(command(6),1); advance(5*hz+1); assert.equal(snapshot()[15],1);
assert.equal(device(tile(33,15)).demand,120);
assert.equal(device(tile(33,15)).used,0);
captureReview('first-light');
place(33,16,10); cable(33,15,33,16);
until(()=>device(tile(33,16)).charge>0,'A battery reports the power actually charging it.');
advance(90*hz); assert.equal(command(6),1); advance(5*hz+1);
assert.equal(device(tile(33,15)).used,120);
assert.ok(device(tile(33,16)).discharge>0);
advance(25*hz-1);
assert.equal(snapshot()[7],1,'Charged storage and continuous supply complete first light.');
place(19,28,2); place(21,28,5); place(22,28,14); place(24,28,12);
assert.equal(command(2,0,0,0,[tile(20,28),0,tile(23,28),0]),1);
cable(19,28,24,28); cable(23,20,23,28);
until(()=>snapshot()[20]>=12,'A player-built line delivers new expansion kits.');
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
const v4=saveWith20HzClock(beforeBlueprint).slice(0,54+width*34*19);
v4[0]=4;
const legacyInputs=new Map([[5,[[1,1]]],[6,[[2,2]]],[7,[[2,1]]],[8,[[4,2],[5,1]]],
  [14,[[4,2]]],[16,[[2,4]]],[18,[[1,1]]]]);
for (let i=0;i<width*34;i++) {
  const row=54+i*19;
  if (v4[row]===20) v4[row]=fieldAt(i,0);
  if (v4[row]===12) v4.fill(0,row+10,row+18);
  if (v4[row+4]>0) for (const [item,amount] of legacyInputs.get(v4[row]) ?? []) v4[row+9+item]+=amount;
  for (let j=row+10;j<row+18;j++) v4[j]=Math.min(v4[j],24);
}
const drills=[tile(22,19),tile(20,20),tile(23,16)];
const oldDrills=drills.map(i=>snapshot().slice(header+i*19,header+(i+1)*19));
assert.equal(restore(v4),1);
for (const [n,i] of drills.entries()) {
  const migrated=snapshot().slice(header+i*19,header+(i+1)*19);
  assert.deepEqual(migrated.slice(0,4),oldDrills[n].slice(0,4));
  assert.deepEqual(migrated.slice(7,18),oldDrills[n].slice(7,18).map((value,j)=>j>=3?Math.min(value,24):value));
}
assert.equal(restore(beforeBlueprint),1);
// Larger material stacks keep the production lines working concurrently for longer.
for (const [x,y] of [[5,7],[8,5]]) {
  place(x,y,4); place(x+1,y,9);
  cable(x,y,x+1,y); cable(x+1,y,24,16);
}
assert.equal(deploy(tile(28,28),a),1);
for (const [x,y] of [[38,26],[47,21]]) assert.equal(deploy(tile(x,y)),1);
cable(24,28,28,28);
cable(33,15,38,26);
cable(43,26,47,21);
const fourthDepot=tile(52,21), fourthPress=tile(50,21);
assert.equal(command(4,fourthDepot,8),1);
advance(15*hz);
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
advance(23);
assert.equal(snapshot()[8],3);
assert.equal(snapshot()[21],0,'A replacement press cannot inherit an in-flight delivery.');

assert.equal(restore(blocked),1);
assert.equal(command(4,fourthDepot,0),1);
advance(23);
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
advance(20*hz);
assert.ok(snapshot()[8]<4,'An idle delivery line ages out of the 20-second window.');
assert.equal(stage(),19);

// Build a separate silica supply for the freight lines.
place(46,28,3); place(47,28,12); cable(46,28,47,21);
place(23,19,5); place(24,19,12); cable(22,19,24,19);
function deployMirror() {
  assert.equal(takeFromWarehouse(plateWarehouse,4,12),12);
  fundWarehouse(mirrorWarehouse,4,12);
  until(()=>fieldAt(tile(22,20),16)>=3,'Three more modules leave the assembly line.');
  act(11,22,20); act(13,33,15,7);
  for(let n=0;n<5;n++) act(9,23,16);
  act(13,33,15,3); assert.equal(command(5),1); advance(10*hz);
}
function connectCity(city,x,receiverX) {
  until(()=>constructionStock(4)>=50,'Produce construction materials for the branch line.',6000);
  assert.equal(command(14,city),1);
  place(x,29,13); cable(x,29,33,15);
  const originX=33+city;
  if (city===1) {
    const citySave=save(), sender=tile(originX,18), receiver=tile(receiverX,29);
    assert.deepEqual(device(sender).slots,[]);
    assert.deepEqual(device(receiver).slots,[]);
    for (let n=0;n<401;n++) act(9,20,20);
    const heldBefore=snapshot()[37];
    assert.equal(feedByHand(sender,2,401),400);
    assert.equal(feedByHand(sender,2,1),-14);
    assert.equal(feedByHand(sender,1,1),-14,'Freight inputs share their capacity.');
    assert.equal(snapshot()[37],heldBefore-400);
    assert.deepEqual(device(sender).slots.find(slot=>slot[0]===2),[2,1,400,100,1]);
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
  const supply=tile(originX,localProcessing?17:16);
  for (let n=0;n<100;n++) act(9,20,20);
  fundWarehouse(supply,2,100);
  const words=[];
  for(let n=firstBelt;n<x;n++) words.push(tile(n,29),0);
  assert.equal(command(2,0,0,0,words),1);
  until(()=>fieldAt(tile(x,29),15)>=16,'A scheduled freight crate feeds the local belt and station.');
}
connectCity(1,48,44); deployMirror();
assert.equal(command(6,1,0),1); advance(18*hz);
assert.equal(stage(),20,'A successful independent valley window reveals the third city.');
connectCity(2,9,5); deployMirror();
assert.equal(command(6,1,1),1); advance(35*hz);
assert.equal(stage(),21,'Two adjacent windows unlock the three-city schedule.');
captureReview('three-cities');
assert.equal(command(6,0,2),1); advance(50*hz);
const regionalSave=save(), progress=snapshot().slice(44,50);
sim.reset(); assert.equal(restore(regionalSave),1);
assert.deepEqual(save(),regionalSave,'Restoring an active campaign preserves routes, cargo and window timers.');
assert.deepEqual(snapshot().slice(44,50),progress);
advance(200*hz);
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
  for (let i=frame[end]+1;i<end && frame[i]>=0;i+=8) cargo.set(frame[i],frame.slice(i+1,i+8));
  return cargo;
}
assert.deepEqual(catalog.get(1).slice(15,19),[1,1,5,1]);
assert.deepEqual(catalog.get(22).slice(15,19),[2,1,2,1]);
assert.deepEqual(catalog.get(24).slice(15),[0,2,5,1,1,1,2,2]);
const cross=tile(18,18), fast=tile(19,18);
place(17,18,12); act(4,17,18,2);
place(18,17,12,1); act(4,18,17,8);
fundWarehouse(tile(17,18),2,10);
fundWarehouse(tile(18,17),8,10);
const work=[cross,24,0,fast,22,0];
const quote=previewTransports(work);
assert.deepEqual(quote.slice(3),[4,8]);
assert.equal(quote[0],1);
assert.equal(command(20,quote[2]-1,0,0,work),-23);
assert.equal(command(20,quote[2],0,0,work),1);
advance(2*hz);
const twoLanes=cargoTracks();
const [oreId,oreItem,deviceId]=twoLanes.get(cross*2);
assert.equal(oreItem,2);
assert.equal(twoLanes.get(cross*2+1)[1],8);
const fullCross=save();
assert.equal(restore(fullCross),1);
assert.deepEqual(save(),fullCross);
const v8=legacySave(fullCross,8);
assert.equal(restore(v8),1);
assert.equal(snapshot()[0],Math.ceil(v8[1]*hz/20));
assert.deepEqual(legacySave(save(),8),v8,'V8 migration preserves the timeline, cargo identities and stored energy.');
assert.equal(restore(fullCross),1);
assert.equal(previewTransports([cross,15,0])[0],-21);
assert.equal(command(21,cross,0,2,[oreId,deviceId]),1);
const afterPickup=save();
assert.equal(command(21,cross,0,2,[oreId,deviceId]),-22);
assert.deepEqual(save(),afterPickup);
assert.equal(cargoTracks().get(cross*2+1)[0],twoLanes.get(cross*2+1)[0]);
advance(0.5*hz);
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
  return frame.slice(offset,offset+13);
};
assert.deepEqual(limits().slice(0,10),[0,16,0,2,9,64,2,2,54,33]);
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
const v7=legacySave(recent,7);
assert.equal(restore(v7),1);
assert.deepEqual(legacySave(save(),7),v7);
const v6=legacySave(recent,6);
assert.equal(restore(v6),1);
assert.equal(fieldAt(tile(0,10),0),12);
assert.deepEqual(limits().slice(0,10),[0,16,0,2,9,64,0,0,56,34]);
assert.equal(restore(nextStage),1);
place(16,23,26);
place(27,5,30);
assert.deepEqual([device(tile(27,5)).grade,device(tile(27,5)).ore],[3,1]);
const moduleStation=tile(17,23);
place(17,23,18);
assert.equal(feedByHand(moduleStation,1,1),1);
assert.equal(command(15,-1,moduleStation,9,[1,0,device(moduleStation).id,3]),1);
assert.deepEqual(device(moduleStation).slots[2],[9,3,1,150,3]);
assert.equal(limits()[12],1,'A module in a machine is installed.');
const equipped=save();
assert.equal(restore(equipped),1);
assert.deepEqual(save(),equipped);
advance(hz-1);
assert.equal(device(moduleStation).slots[1][2],0);
advance(1);
assert.equal(device(moduleStation).slots[1][2],1,'The module shortens the 1.5-second cycle to one second.');
assert.equal(command(15,moduleStation,-1,9,[1,device(moduleStation).id,0,3]),1);
assert.deepEqual(device(moduleStation).slots[2],[9,3,0,150,7]);
const moduleDepot=tile(17,24);
place(17,24,12);
assert.equal(feedByHand(moduleDepot,9,1),1);
assert.equal(warehouseStock(moduleDepot,9),1);
assert.equal(limits()[12],0,'A module stored in a warehouse is not installed.');
console.log('发展系统通过：满仓限制、阶段交付站、地图与倍速边界、高阶设备、V6 迁移及速度模块。');

async function writeFixtures(directory, saves) {
  await mkdir(directory, { recursive: true });
  await Promise.all([...saves].map(([name, data]) =>
    writeFile(new URL(name + '.dawn', directory), data)));
}

function denseBeltFixture() {
  // The two omitted row pairs contain reserved ground station tiles.
  const rows = [2, 4, 6, 8, 10, 12, 16, 18, 20, 22, 24, 26, 30, 32];
  const left = 4, right = 50;
  const cargoPerLoop = 40;
  const cargoCount = rows.length * cargoPerLoop;
  const funded = modernEmpty.slice();
  funded[23] = 11; // Expand stage permits warehouse exports on the full map.
  funded[5] = cargoCount;
  funded[8] = 2000;
  assert.equal(restore(funded), 1);

  const parts = [];
  for (const y of rows) {
    for (let x = left; x <= right; x++) {
      parts.push(tile(x, y), 1, x === right ? 1 : 0);
      parts.push(tile(x, y + 1), 1, x === left ? 3 : 2);
    }
  }
  const preview = previewTransports(parts);
  assert.equal(preview[0], 1);
  assert.equal(command(20, preview[2], 0, 0, parts), 1);
  for (const y of rows) {
    place(left - 1, y, 12);
    const warehouse = tile(left - 1, y);
    fundWarehouse(warehouse, 1, cargoPerLoop);
    act(4, left - 1, y, 1);
  }
  advance(100 * hz);
  const loaded = save();
  const positions = tracksById();
  assert.equal(positions.size, cargoCount, 'Every seeded item must be in transit.');
  advance(hz);
  const later = tracksById();
  assert.equal(later.size, positions.size);
  assert.ok([...positions].every(([id, position]) => later.get(id) !== position),
    'All cargo must circulate without continued supply.');
  return new Uint8Array(loaded.buffer);
}

function tracksById() {
  return new Map([...cargoTracks()].map(([location, [id]]) => [id, location]));
}

if (captureVisual) await writeFixtures(new URL('../docs/visual-review.local/', import.meta.url), reviewSaves);
if (capturePerformance) {
  const fixtures = new Map([
    ['opening', new Uint8Array(modernEmpty.buffer)],
    ['three-cities', reviewSaves.get('three-cities')],
    ['dense-belts', denseBeltFixture()],
  ]);
  await writeFixtures(new URL('../docs/performance.local/', import.meta.url), fixtures);
}
