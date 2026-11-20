import { Field, HEADER, H, Kind, STRIDE, W, cell, held, transportStart, xy, type Part } from './model';
import { ViewSection } from './generated-content';
import { finishViewDecode, startViewDecode, viewSection } from './world-view';

export type Material = { item:number; count:number };
export type SlotData = { item:number; role:'input'|'output'|'module'; count:number; stack:number; room:boolean; canPut:boolean; canTake:boolean };
type Device = { identity:number; grade:number; ore:number; demand:number; used:number; generated:number; charged:number; discharged:number; slots:SlotData[] };

const devices = new WeakMap<Int32Array, Map<number,number|Device>>();

function deviceIndex(data:Int32Array) {
  let index=devices.get(data);
  if (!index) {
    const started=startViewDecode();
    index=new Map();
    devices.set(data,index);
    const view=viewSection(data,ViewSection.Devices);
    const end=view?.[1] ?? data.length-1;
    const start=view?.[0] ?? data[end];
    if (start>=0 && start<=end && (view || start>=HEADER+W*H*STRIDE+4)) {
      for (let i=start;i<end;i+=10+5*data[i+9]) index.set(data[i],i);
    }
    finishViewDecode('device-index',started);
  }
  return index;
}

export function deviceAt(data:Int32Array,tile:number) {
  const index=deviceIndex(data);
  const record=index.get(tile);
  if (typeof record!=='number') return record;
  const [,identity,grade,ore,demand,used,generated,charged,discharged,count]=data.subarray(record,record+10);
  const slots:SlotData[]=[];
  for (let j=0,i=record+10;j<count;j++,i+=5) {
    const [item,role,count,stack,permissions]=data.subarray(i,i+5);
    slots.push({item,role:role===3?'module':role===1?'input':'output',count,stack,room:Boolean(permissions&4),canPut:Boolean(permissions&1),canTake:Boolean(permissions&2)});
  }
  const device={identity,grade,ore,demand,used,generated,charged,discharged,slots};
  index.set(tile,device);
  return device;
}

type Warehouse = {tile:number; stock:Map<number,number>};
const warehouseContents = new WeakMap<Int32Array,Warehouse[]>();

function warehouses(data:Int32Array) {
  let result=warehouseContents.get(data);
  if (!result) {
    const started=startViewDecode();
    result=[];
    const view=viewSection(data,ViewSection.Warehouses);
    if (view) {
      let warehouse:Warehouse | undefined;
      for (let row=view[0];row<view[1];row+=3) {
        const tile=data[row];
        if (warehouse?.tile!==tile) {
          warehouse={tile,stock:new Map()};
          result.push(warehouse);
        }
        warehouse.stock.set(data[row+1],data[row+2]);
      }
    } else {
      for (const tile of deviceIndex(data).keys()) {
        if (cell(data,tile,Field.Kind)!==Kind.Depot) continue;
        const stock=new Map(deviceAt(data,tile)?.slots.filter(slot=>slot.count>0).map(slot=>[slot.item,slot.count]));
        if (stock.size) result.push({tile,stock});
      }
    }
    warehouseContents.set(data,result);
    finishViewDecode('warehouse-stock',started);
  }
  return result;
}

export function constructionAvailable(data:Int32Array,item:number) {
  return warehouses(data).reduce((total,warehouse)=>total+(warehouse.stock.get(item) ?? 0),held(data,item));
}

export function constructionSources(data:Int32Array,materials:Material[],anchor:number) {
  const remaining=materials.map(({item,count})=>({item,count:Math.max(0,count-held(data,item))}));
  if (!remaining.some(({count})=>count>0)) return [];
  const [x,y]=xy(anchor);
  const distance=(tile:number)=>{
    const [tx,ty]=xy(tile);
    return Math.abs(tx-x)+Math.abs(ty-y);
  };
  return [...warehouses(data)].sort((a,b)=>distance(a.tile)-distance(b.tile)||a.tile-b.tile).flatMap(({tile,stock})=>{
    const used:Material[]=[];
    for (const row of remaining) {
      const amount=Math.min(row.count,stock.get(row.item) ?? 0);
      if (!amount) continue;
      row.count-=amount;
      used.push({item:row.item,count:amount});
    }
    return used.length?[{tile,used}]:[];
  });
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

export const TRANSPORT_RECORD_WORDS=8;
const projections=new WeakMap<Int32Array,{cargo:Map<number,number>;arrivals:Int32Array}>();
export type CargoTrack = { location:number; id:number; item:number; identity:number; from:number; since:number; until:number; blocked:boolean };

export function layoutRevision(data:Int32Array) { return data[transportStart(data)] ?? 0; }

function transportProjection(data:Int32Array) {
  const cached=projections.get(data);
  if (cached) return cached;
  const started=startViewDecode();
  const cargo=new Map<number,number>();
  const start=transportStart(data), end=viewSection(data,ViewSection.Transport)?.[1] ?? data[data.length-1]-1;
  // Visual arrivals follow the real cargo records with a negative source tag.
  let i=start>=0?start+1:end;
  for (;i<end && data[i]>=0;i+=TRANSPORT_RECORD_WORDS) cargo.set(data[i],i);
  const projection={cargo,arrivals:data.subarray(i,end)};
  projections.set(data,projection);
  finishViewDecode('cargo-index',started);
  return projection;
}

export function cargoIndex(data:Int32Array) { return transportProjection(data).cargo; }
export function beltArrivalData(data:Int32Array) { return transportProjection(data).arrivals; }

export function cargoAt(data:Int32Array,tile:number,lane:number):CargoTrack | undefined {
  const index=cargoIndex(data).get(tile*2+lane);
  if (index===undefined) return undefined;
  const [location,id,item,identity,from,since,until,blocked]=data.subarray(index,index+TRANSPORT_RECORD_WORDS);
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
