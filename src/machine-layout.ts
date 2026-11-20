import { content } from './generated-content';
import { Field, HEADER, H, Kind, STEP, STRIDE, W, at, cell, isTransport, transportStart, xy } from './model';
import { transportPorts } from './sim-data';
import { finishViewDecode, snapshotLayout, startViewDecode, type SnapshotLayout } from './world-view';

type Layout = {
  width:number; height:number; canInput:boolean; canOutput:boolean;
  ports:readonly {x:number;y:number;side:number;role:'input'|'output';labelKey:string|null}[]|null;
};
const hasLargeMachine=content.machines.some(row=>Number(row.width)>1 || Number(row.height)>1);

function layout(kind:number):Layout|undefined {
  if (kind===Kind.CopperDrill || kind>=Kind.IronDrill && kind<=Kind.FuelDrill) return content.machines[Kind.IndustrialMiner];
  if (kind===Kind.ReinforcedCopperDrill || kind>=Kind.ReinforcedIronDrill && kind<=Kind.ReinforcedFuelDrill) return content.machines[Kind.ReinforcedMiner];
  return content.machines[kind];
}

export function machineSize(kind:number,dir:number) {
  const {width,height}=layout(kind) ?? {width:1,height:1};
  return dir%2?[height,width]:[width,height];
}

export function* footprint(anchor:number,kind:number,dir:number) {
  const [width,height]=machineSize(kind,dir);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    yield at(anchor%W+x,Math.floor(anchor/W)+y);
  }
}

export function rotatePart(x:number,y:number,kind:number,dir:number,turns:number) {
  for (let i=0;i<turns;i++) {
    const [,height]=machineSize(kind,dir);
    [x,y]=[-y-height+1,x];
    dir=(dir+1)%4;
  }
  return [x,y,dir];
}

type SpatialIndex = Map<number,{anchor:number; masks:number}>;
const indexes=new WeakMap<Int32Array|SnapshotLayout,SpatialIndex>();
function spatialIndex(data:Int32Array) {
  const layout=snapshotLayout(data);
  const key=layout ?? data;
  let index=indexes.get(key);
  if (!index) {
    const started=startViewDecode();
    index=new Map();
    const end=transportStart(data)-14;
    const start=data[end];
    const rows=layout?.footprints ?? (start>=HEADER+W*H*STRIDE+4 && start<=end ? data.subarray(start,end) : []);
    for (let i=0;i<rows.length;i+=3) index.set(rows[i],{anchor:rows[i+1],masks:rows[i+2]});
    indexes.set(key,index);
    finishViewDecode('footprint-index',started);
  }
  return index;
}

export function machineAnchor(data:Int32Array,tile:number) {
  if (tile<0) return -1;
  if (cell(data,tile,Field.Kind)) return tile;
  if (!hasLargeMachine) return -1;
  return spatialIndex(data).get(tile)?.anchor ?? -1;
}

export function occupiedKind(data:Int32Array,tile:number) {
  const anchor=machineAnchor(data,tile);
  return anchor<0?0:cell(data,anchor,Field.Kind);
}

export function machineMasks(data:Int32Array,tile:number) {
  return spatialIndex(data).get(tile)?.masks ?? 0;
}

const beltLinks=new WeakMap<Int32Array|SnapshotLayout,Uint16Array>();

function connectedPort(data:Int32Array,tile:number,flow:number,input:boolean) {
  if (tile<0) return false;
  const kind=cell(data,tile,Field.Kind);
  if (!isTransport(kind)) return Boolean(machineMasks(data,tile)&(1<<(flow+(input?0:4))));
  const dir=cell(data,tile,Field.Direction);
  const first=transportPorts(kind,dir,0), second=transportPorts(kind,dir,1);
  return Boolean((input?first.incoming|second.incoming:first.outgoing|second.outgoing)&(1<<flow));
}

export function transportLinks(data:Int32Array,tile:number,kind:number,dir:number) {
  const key=snapshotLayout(data) ?? data;
  let cache=beltLinks.get(key);
  if (!cache) { cache=new Uint16Array(W*H); beltLinks.set(key,cache); }
  if (cache[tile]) return cache[tile]&255;
  const first=transportPorts(kind,dir,0), second=transportPorts(kind,dir,1);
  const allowedIn=first.incoming|second.incoming, allowedOut=first.outgoing|second.outgoing;
  const [x,y]=xy(tile);
  let links=0;
  for (let flow=0;flow<4;flow++) {
    const [dx,dy]=STEP[flow], flag=1<<flow;
    if ((allowedIn&flag) && connectedPort(data,at(x-dx,y-dy),flow,false)) links|=flag;
    if ((allowedOut&flag) && connectedPort(data,at(x+dx,y+dy),flow,true)) links|=flag<<4;
  }
  cache[tile]=256|links;
  return links;
}

export function* machinePortTiles(data:Int32Array) {
  for (const [tile,{anchor,masks}] of spatialIndex(data)) {
    if (masks) yield [tile,anchor,masks];
  }
}

export function* previewPorts(anchor:number,kind:number,dir:number,legacy=true) {
  if (kind===Kind.SimpleMiner && !legacy) return;
  const device=layout(kind);
  if (!device) return;
  const {width,height,ports}=device;
  if (!ports) {
    if (device.canInput) for (let side=0;side<4;side++) yield { tile:anchor,side,role:'input',labelKey:null };
    if (device.canOutput && kind!==Kind.Depot && kind!==Kind.Yard) {
      yield { tile:anchor,side:dir,role:'output',labelKey:null };
    }
    return;
  }
  for (const port of ports) {
    const {x,y}=port;
    const [dx,dy]=dir===1?[height-1-y,x]:dir===2?[width-1-x,height-1-y]:dir===3?[y,width-1-x]:[x,y];
    const tile=at(anchor%W+dx,Math.floor(anchor/W)+dy);
    if (tile>=0) yield {tile,side:(port.side+dir)%4,role:port.role,labelKey:port.labelKey};
  }
}
