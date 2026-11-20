import { Field, HEADER, H, Kind, STRIDE, W, cell, held, transportStart, type Part } from './model';
import {
  BlueprintInfoRecord as BlueprintInfo, BlueprintRecord, CargoRecord, DesignRecord as Design,
  DesignBeltRecord as DesignBelt, DeviceRecord, LibraryRecord, MaterialRecord, PartRecord, PortRecord,
  SlotRecord, ViewSection, WarehouseRecord,
} from './generated-content';
import { finishViewDecode, startViewDecode, viewSection } from './world-view';
import { advanceRecords } from './wire-read';

export type Material = { item:number; count:number };
export type SlotData = { item:number; role:'input'|'output'|'module'; count:number; stack:number; room:boolean; canPut:boolean; canTake:boolean };
type Device = { identity:number; grade:number; ore:number; demand:number; used:number; generated:number; charged:number; discharged:number; slots:SlotData[] };

const devices = new WeakMap<Int32Array, Map<number,number|Device>>();

function deviceIndex(data:Int32Array) {
  let index=devices.get(data);
  if (!index) {
    const started=startViewDecode();
    index=new Map();
    const view=viewSection(data,ViewSection.Devices);
    const end=view?.[1] ?? data.length-1;
    const start=view?.[0] ?? data[end];
    if (start>=0 && start<=end && (view || start>=HEADER+W*H*STRIDE+4)) {
      for (let row=start;row<end;) {
        const slots=advanceRecords('Devices',row,end,1,DeviceRecord.words);
        const next=advanceRecords('Devices.Slots',slots,end,data[row+DeviceRecord.slots],SlotRecord.words);
        index.set(data[row+DeviceRecord.tile],row);
        row=next;
      }
    }
    devices.set(data,index);
    finishViewDecode('device-index',started);
  }
  return index;
}

export function deviceAt(data:Int32Array,tile:number) {
  const index=deviceIndex(data);
  const record=index.get(tile);
  if (typeof record!=='number') return record;
  const count=data[record+DeviceRecord.slots];
  const slots:SlotData[]=[];
  for (let j=0,i=record+DeviceRecord.words;j<count;j++,i+=SlotRecord.words) {
    const role=data[i+SlotRecord.role], permissions=data[i+SlotRecord.permissions];
    slots.push({item:data[i+SlotRecord.item],role:role===3?'module':role===1?'input':'output',
      count:data[i+SlotRecord.count],stack:data[i+SlotRecord.stack],
      room:Boolean(permissions&4),canPut:Boolean(permissions&1),canTake:Boolean(permissions&2)});
  }
  const device={
    identity:data[record+DeviceRecord.identity],grade:data[record+DeviceRecord.grade],ore:data[record+DeviceRecord.ore],
    demand:data[record+DeviceRecord.demand],used:data[record+DeviceRecord.used],generated:data[record+DeviceRecord.generated],
    charged:data[record+DeviceRecord.charged],discharged:data[record+DeviceRecord.discharged],slots,
  };
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
      for (let row=view[0];row<view[1];row+=WarehouseRecord.words) {
        const tile=data[row+WarehouseRecord.tile];
        if (warehouse?.tile!==tile) {
          warehouse={tile,stock:new Map()};
          result.push(warehouse);
        }
        warehouse.stock.set(data[row+WarehouseRecord.item],data[row+WarehouseRecord.count]);
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

export function constructionInventoryKey(data:Int32Array,materials:readonly Material[]) {
  const shortages=materials.filter(({item,count})=>held(data,item)<count);
  if (!shortages.length) return '';
  const counts=materials.map(({item})=>held(data,item)).join(',');
  const sources=warehouses(data).flatMap(({tile,stock})=>{
    const relevant=shortages.map(({item})=>stock.get(item) ?? 0);
    return relevant.some(Boolean)?[`${tile}:${relevant.join(',')}`]:[];
  });
  return counts+'|'+sources.join('|');
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
  for (let row=0;row<data.length;) {
    const materialStart=advanceRecords('Directory',row,data.length,1,Design.words);
    const belt=advanceRecords('Directory.Materials',materialStart,data.length,data[row+Design.materials],MaterialRecord.words);
    const ports=advanceRecords('Directory.Belt',belt,data.length,1,DesignBelt.words);
    const next=advanceRecords('Directory.Ports',ports,data.length,2,PortRecord.words);
    const materials:Material[]=[];
    for (let i=materialStart;i<belt;i+=MaterialRecord.words) materials.push({item:data[i+MaterialRecord.item],count:data[i+MaterialRecord.count]});
    const kind=data[row+Design.kind];
    directory.set(kind,{
      kind,minimum:data[row+Design.minimum],grade:data[row+Design.grade],ores:data[row+Design.ores],
      demand:data[row+Design.demand],generation:data[row+Design.generation],
      batteryPower:data[row+Design.batteryPower],batteryCapacity:data[row+Design.batteryCapacity],
      output:data[row+Design.output],amount:data[row+Design.amount],ticks:data[row+Design.ticks],span:data[row+Design.span],
      materials,beltTier:data[belt+DesignBelt.tier],lanes:data[belt+DesignBelt.lanes],
      interval:data[belt+DesignBelt.interval],laneCapacity:data[belt+DesignBelt.laneCapacity],
      ports:[[data[ports+PortRecord.input],data[ports+PortRecord.output]],
        [data[ports+PortRecord.words+PortRecord.input],data[ports+PortRecord.words+PortRecord.output]]],
    });
    row=next;
  }
}

export function design(kind:number) { return directory.get(kind); }

export function transportPorts(kind:number,dir:number,lane:number) {
  const [input,output]=design(kind)?.ports[lane] ?? [0,0];
  const rotate=(mask:number)=>((mask<<dir)|(mask>>(4-dir)))&15;
  return {incoming:rotate(input),outgoing:rotate(output)};
}

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
  for (;i<end && data[i+CargoRecord.location]>=0;i+=CargoRecord.words) cargo.set(data[i+CargoRecord.location],i);
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
  return {location:data[index+CargoRecord.location],id:data[index+CargoRecord.id],item:data[index+CargoRecord.item],
    identity:data[index+CargoRecord.identity],from:data[index+CargoRecord.from],since:data[index+CargoRecord.since],
    until:data[index+CargoRecord.until],blocked:data[index+CargoRecord.blocked]===1};
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
  let i=advanceRecords('Blueprints',0,data.length,1,LibraryRecord.words);
  const entries=data[LibraryRecord.entries];
  advanceRecords('Blueprints.Entries',i,data.length,entries,BlueprintInfo.words+BlueprintRecord.words);
  for (let n=0;n<entries;n++) {
    const info=i;
    const header=advanceRecords('Blueprints.Info',info,data.length,1,BlueprintInfo.words);
    const nameStart=advanceRecords('Blueprints.Header',header,data.length,1,BlueprintRecord.words);
    const partsStart=advanceRecords('Blueprints.Name',nameStart,data.length,data[header+BlueprintRecord.nameBytes],1);
    const next=advanceRecords('Blueprints.Parts',partsStart,data.length,data[header+BlueprintRecord.parts],PartRecord.words);
    const name=decoder.decode(Uint8Array.from(data.subarray(nameStart,partsStart)));
    const parts:Part[]=[];
    for (let p=partsStart;p<next;p+=PartRecord.words) {
      parts.push([data[p+PartRecord.x],data[p+PartRecord.y],data[p+PartRecord.kind],
        data[p+PartRecord.direction],data[p+PartRecord.wire],data[p+PartRecord.config]]);
    }
    rows.push({id:data[header+BlueprintRecord.id],version:data[header+BlueprintRecord.version],name,
      width:data[info+BlueprintInfo.width],height:data[info+BlueprintInfo.height],devices:data[info+BlueprintInfo.devices],
      material:{item:data[info+BlueprintInfo.item],count:data[info+BlueprintInfo.count]},parts});
    i=next;
  }
  if (i!==data.length) throw new RangeError(`Invalid Blueprints tail at word ${i}`);
  return rows;
}

export function preparedMaterials(kind:number, packed:boolean) {
  return kind===Kind.SimpleMiner && packed ? [] : design(kind)?.materials ?? [];
}
