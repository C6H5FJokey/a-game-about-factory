import { content } from './generated-content';
import { Field, HEADER, H, Kind, STRIDE, W, at, cell, transportStart } from './model';

type Layout = {
  width:number; height:number; canInput:boolean; canOutput:boolean;
  ports:readonly {x:number;y:number;side:number;role:'input'|'output';labelKey:string|null}[]|null;
};
const hasLargeMachine=content.machines.some(row=>Number(row.width)>1 || Number(row.height)>1);

function layout(kind:number):Layout|undefined {
  if (kind>=Kind.IronDrill && kind<=Kind.FuelDrill) return content.machines[Kind.IndustrialMiner];
  if (kind>=Kind.ReinforcedIronDrill && kind<=Kind.ReinforcedFuelDrill) return content.machines[Kind.ReinforcedMiner];
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

const indexes=new WeakMap<Int32Array,Map<number,number>>();
function spatialIndex(data:Int32Array) {
  let index=indexes.get(data);
  if (!index) {
    index=new Map();
    const end=transportStart(data)-14;
    const start=data[end];
    if (start>=HEADER+W*H*STRIDE+4 && start<=end) {
      for (let i=start;i<end;i+=3) index.set(data[i],i);
    }
    indexes.set(data,index);
  }
  return index;
}

export function machineAnchor(data:Int32Array,tile:number) {
  if (tile<0) return -1;
  if (cell(data,tile,Field.Kind)) return tile;
  if (!hasLargeMachine) return -1;
  const row=spatialIndex(data).get(tile);
  return row===undefined?-1:data[row+1];
}

export function occupiedKind(data:Int32Array,tile:number) {
  const anchor=machineAnchor(data,tile);
  return anchor<0?0:cell(data,anchor,Field.Kind);
}

export function machineMasks(data:Int32Array,tile:number) {
  const row=spatialIndex(data).get(tile);
  return row===undefined?0:data[row+2];
}

export function* machinePortTiles(data:Int32Array) {
  for (const [tile,row] of spatialIndex(data)) {
    const masks=data[row+2];
    if (masks) yield [tile,data[row+1],masks];
  }
}

export function* previewPorts(anchor:number,kind:number,dir:number) {
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
