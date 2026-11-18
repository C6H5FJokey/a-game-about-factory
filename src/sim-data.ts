import { Field, HEADER, H, Kind, STRIDE, W, cell, transportStart, type Part } from './model';

export type Material = { item:number; count:number };
export type SlotData = { item:number; role:'input'|'output'|'module'; count:number; capacity:number; canPut:boolean; canTake:boolean };
type Device = { identity:number; grade:number; ore:number; demand:number; used:number; generated:number; charged:number; discharged:number; slots:SlotData[] };

const devices = new WeakMap<Int32Array, Map<number,number|Device>>();

export function deviceAt(data:Int32Array,tile:number) {
  let index=devices.get(data);
  if (!index) {
    index=new Map();
    devices.set(data,index);
    const end=data.length-1;
    const start=data[end];
    if (start<HEADER+W*H*STRIDE+4 || start>end) return undefined;
    for (let i=start;i<end;i+=10+5*data[i+9]) index.set(data[i],i);
  }
  const record=index.get(tile);
  if (typeof record!=='number') return record;
  const [,identity,grade,ore,demand,used,generated,charged,discharged,count]=data.subarray(record,record+10);
  const slots:SlotData[]=[];
  for (let j=0,i=record+10;j<count;j++,i+=5) {
    const [item,role,count,capacity,manual]=data.subarray(i,i+5);
    slots.push({item,role:role===3?'module':role===1?'input':'output',count,capacity,canPut:Boolean(manual&1),canTake:Boolean(manual&2)});
  }
  const device={identity,grade,ore,demand,used,generated,charged,discharged,slots};
  index.set(tile,device);
  return device;
}

type DirectoryEntry = {
  kind:number; minimum:number; grade:number; ores:number; demand:number; generation:number;
  batteryPower:number; batteryCapacity:number; output:number; amount:number; ticks:number; span:number;
  materials:Material[];
  beltTier:number; lanes:number; interval:number; laneCapacity:number;
  ports:[number,number][];
};
const directory=new Map<number,DirectoryEntry>();

export function readDirectory(buffer:ArrayBuffer) {
  directory.clear();
  const data=new Int32Array(buffer);
  for (let i=0;i<data.length;) {
    const [kind,minimum,grade,ores,demand,generation,batteryPower,batteryCapacity,output,amount,ticks,span,count]=data.subarray(i,i+13);
    i+=13;
    const materials:Material[]=[];
    for (let j=0;j<count;j++,i+=2) materials.push({item:data[i],count:data[i+1]});
    const [beltTier,lanes,interval,laneCapacity,inA,outA,inB,outB]=data.subarray(i,i+8);
    i+=8;
    directory.set(kind,{kind,minimum,grade,ores,demand,generation,batteryPower,batteryCapacity,output,amount,ticks,span,materials,
      beltTier,lanes,interval,laneCapacity,ports:[[inA,outA],[inB,outB]]});
  }
}

export function design(kind:number) { return directory.get(kind); }

export function transportPorts(kind:number,dir:number,lane:number) {
  const [input,output]=design(kind)?.ports[lane] ?? [0,0];
  const rotate=(mask:number)=>((mask<<dir)|(mask>>(4-dir)))&15;
  return {incoming:rotate(input),outgoing:rotate(output)};
}

const recordWords=8;
const projections=new WeakMap<Int32Array,Map<number,number>>();
export type CargoTrack = { location:number; id:number; item:number; identity:number; from:number; since:number; until:number; blocked:boolean };

export function layoutRevision(data:Int32Array) { return data[transportStart(data)] ?? 0; }

export function cargoIndex(data:Int32Array) {
  let index=projections.get(data);
  if (!index) {
    index=new Map();
    const start=transportStart(data), end=data[data.length-1]-1;
    if (start>=0) for (let i=start+1;i<end;i+=recordWords) index.set(data[i],i);
    projections.set(data,index);
  }
  return index;
}

export function cargoAt(data:Int32Array,tile:number,lane:number):CargoTrack | undefined {
  const index=cargoIndex(data).get(tile*2+lane);
  if (index===undefined) return undefined;
  const [location,id,item,identity,from,since,until,blocked]=data.subarray(index,index+recordWords);
  return {location,id,item,identity,from,since,until,blocked:blocked===1};
}

export function drillVariant(data:Int32Array,tile:number,kind:number) {
  const ore=cell(data,tile,Field.Ore);
  const layout=design(kind);
  if (!layout || !(layout.ores & (1<<ore))) return undefined;
  for (const entry of directory.values()) if (entry.grade===layout.grade && entry.output===ore) return entry;
  return undefined;
}

export type Blueprint = { id:number; version:number; name:string; width:number; height:number; devices:number; material:Material; parts:Part[] };
const decoder=new TextDecoder();

export function readBlueprints(buffer:ArrayBuffer) {
  const data=new Int32Array(buffer);
  const rows:Blueprint[]=[];
  let i=2;
  for (let n=0;n<data[1];n++) {
    const [width,height,devices,item,count,id,version,bytes,partsCount]=data.subarray(i,i+9);
    i+=9;
    const name=decoder.decode(Uint8Array.from(data.subarray(i,i+bytes)));
    i+=bytes;
    const parts:Part[]=[];
    for (let j=0;j<partsCount;j++,i+=6) {
      parts.push([data[i],data[i+1],data[i+2],data[i+3],data[i+4],data[i+5]]);
    }
    rows.push({id,version,name,width,height,devices,parts,material:{item,count}});
  }
  return rows;
}

export function preparedMaterials(kind:number, packed:boolean) {
  return kind===Kind.SimpleMiner && packed ? [] : design(kind)?.materials ?? [];
}
