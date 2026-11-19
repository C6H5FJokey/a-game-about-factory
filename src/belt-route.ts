import { CITY, CityField, Field, H, Kind, STEP, W, at, cell, cityValue, inBounds, isTransport, plainBelt,
  unlocked, xy, type MapLimits, type PreviewCell } from './model';
import { transportPorts } from './sim-data';
import { machineMasks, occupiedKind } from './machine-layout';

const NO_FLOW=4;
const perpendicular=(a:number,b:number)=>((a-b)&1)===1;
const crossingDirection=(a:number,b:number)=>(a+1)%4===b?a:b;
const side=(tile:number,flow:number)=>{
  const [dx,dy]=STEP[flow];
  return at(tile%W+dx,Math.floor(tile/W)+dy);
};
export function flowTo(from:number,to:number) {
  const [x,y]=xy(from), [nx,ny]=xy(to);
  return STEP.findIndex(([dx,dy])=>dx===nx-x && dy===ny-y);
}

export function findCablePath(bounds:MapLimits,path:number[],target:number,canUse:(tile:number)=>boolean) {
  const start=path.at(-1)!;
  const [tx,ty]=xy(target);
  if (!inBounds(bounds,tx,ty) || !canUse(target)) return undefined;
  const used=new Set(path);
  const from=new Int32Array(W*H).fill(-1);
  const costs=new Int32Array(from.length).fill(-1);
  const frontier=new MinHeap();
  const distance=(tile:number)=>Math.abs(tile%W-tx)+Math.abs(Math.floor(tile/W)-ty);
  costs[start]=0;
  frontier.push({state:start,priority:distance(start),cost:0});
  while (frontier.size) {
    const {state:tile,cost}=frontier.pop()!;
    if (cost!==costs[tile]) continue;
    if (tile===target) {
      const suffix:number[]=[];
      for (let next=tile;next!==start;next=from[next]) suffix.push(next);
      return suffix.reverse();
    }
    for (let flow=0;flow<4;flow++) {
      const next=side(tile,flow);
      if (next<0 || !inBounds(bounds,next%W,Math.floor(next/W)) || used.has(next) || !canUse(next)) continue;
      const nextCost=cost+1;
      if (costs[next]>=0 && costs[next]<=nextCost) continue;
      costs[next]=nextCost; from[next]=tile;
      frontier.push({state:next,priority:nextCost+distance(next),cost:nextCost});
    }
  }
  return undefined;
}

function ports(data:Int32Array,tile:number,kind:number,input:boolean) {
  const dir=cell(data,tile,Field.Direction);
  if (isTransport(kind)) {
    const a=transportPorts(kind,dir,0), b=transportPorts(kind,dir,1);
    return input?a.incoming|b.incoming:a.outgoing|b.outgoing;
  }
  const masks=machineMasks(data,tile);
  return input?masks&15:masks>>4;
}

export function beltTerminal(data:Int32Array,path:number[]) {
  const last=path.at(-1) ?? -1;
  const kind=occupiedKind(data,last);
  return path.length>1 && kind?last:-1;
}

// Each search state carries its incoming heading so an overpass only allows
// straight-through travel and an intake can reject a specific approach.
export function findBeltPath(data:Int32Array,bounds:MapLimits,path:number[],target:number,startFlow?:number) {
  const start=path.at(-1)!;
  if (start===target) return [];
  const crossing=unlocked(data,Kind.Crossing);
  const reserved=new Set(CITY.map((_,city)=>cityValue(data,city,CityField.Site)));
  const used=new Map<number,number>();
  for (let i=0;i<path.length-1;i++) {
    const tile=path[i], flow=flowTo(tile,path[i+1]);
    const incoming=i?flowTo(path[i-1],tile):flow;
    const kind=occupiedKind(data,tile);
    const eligible=incoming===flow && (!kind || plainBelt(kind));
    used.set(tile,!used.has(tile) && eligible?flow:NO_FLOW);
  }
  const crossedFlow=(tile:number)=>{
    const planned=used.get(tile);
    if (planned!==undefined) return planned;
    const kind=cell(data,tile,Field.Kind);
    return plainBelt(kind)?cell(data,tile,Field.Direction):undefined;
  };
  const targetKind=occupiedKind(data,target);
  const targetPorts=targetKind?ports(data,target,targetKind,true):15;
  if (!targetPorts || (!targetKind && reserved.has(target))) return undefined;
  const startKind=occupiedKind(data,start);
  const sourceMask=path.length===1 && startKind && !plainBelt(startKind)?ports(data,start,startKind,false):15;
  const incoming=path.length>1?flowTo(path[path.length-2],start):NO_FLOW;
  const initial=start*5+incoming;
  const from=new Int32Array(W*H*5).fill(-1);
  const cost=new Float64Array(from.length).fill(Infinity);
  const frontier=new MinHeap();
  const [tx,ty]=xy(target);
  const heuristic=(tile:number)=>Math.abs(tile%W-tx)+Math.abs(Math.floor(tile/W)-ty);
  cost[initial]=0;
  frontier.push({state:initial,priority:heuristic(start),cost:0});
  while (frontier.size) {
    const current=frontier.pop()!;
    const {state}=current;
    if (current.cost!==cost[state]) continue;
    const tile=Math.floor(state/5), entry=state%5;
    if (tile===target) {
      const suffix:number[]=[];
      for (let cursor=state;cursor!==initial;cursor=from[cursor]) suffix.push(Math.floor(cursor/5));
      return suffix.reverse();
    }
    const straight=state!==initial && crossedFlow(tile)!==undefined;
    for (let flow=0;flow<4;flow++) {
      if (straight && flow!==entry || entry!==NO_FLOW && (entry+2)%4===flow) continue;
      if (state===initial && (!(sourceMask&(1<<flow)) || startFlow!==undefined && flow!==startFlow)) continue;
      const next=side(tile,flow);
      if (next<0 || next===start || !inBounds(bounds,next%W,Math.floor(next/W))) continue;
      const kind=occupiedKind(data,next), previous=crossedFlow(next);
      if (next===target) {
        if (!(targetPorts&(1<<flow))) continue;
      } else if (previous!==undefined) {
        if (!crossing || previous===NO_FLOW || !perpendicular(previous,flow)) continue;
      } else if (kind || reserved.has(next)) continue;
      const nextCost=current.cost+1+(entry!==NO_FLOW && entry!==flow?.06:0)+(next!==target && previous!==undefined?.12:0);
      const nextState=next*5+flow;
      if (nextCost>=cost[nextState]) continue;
      cost[nextState]=nextCost;
      from[nextState]=state;
      frontier.push({state:nextState,priority:nextCost+heuristic(next),cost:nextCost});
    }
  }
  return undefined;
}

export function projectBeltPath(data:Int32Array,path:number[],tier:number,direction:number,forced:boolean) {
  const parts=new Map<number,{part:PreviewCell; flow:number; straight:boolean; crossed:boolean}>();
  const last=path.length-1;
  const terminal=beltTerminal(data,path);
  let conflict=false;
  for (let i=0;i<path.length;i++) {
    const tile=path[i], kind=occupiedKind(data,tile), oldFlow=cell(data,tile,Field.Direction);
    const entry=i?flowTo(path[i-1],tile):NO_FLOW;
    const flow=i<last?flowTo(tile,path[i+1]):forced || !i?direction:entry;
    if (i===last && terminal>=0 || i===0 && kind && !plainBelt(kind)) {
      const valid=i===0?i<last && (ports(data,tile,kind,false)&(1<<flow)):ports(data,tile,kind,true)&(1<<entry);
      if (!valid && (i>0 || last>0)) conflict=true;
      continue;
    }
    const prior=parts.get(tile);
    const straight=i<last && (!i || entry===flow);
    const builtCross=i>0 && i<last && plainBelt(kind) && perpendicular(oldFlow,entry);
    const needsCross=!!prior || builtCross;
    const base=prior?.flow ?? oldFlow;
    const validCross=unlocked(data,Kind.Crossing) && straight && perpendicular(base,flow) &&
      (!prior || prior.straight && !prior.crossed) &&
      (!builtCross || !prior || oldFlow===base || oldFlow===flow);
    const blocked=i>0 && i<last && !!kind && !builtCross;
    const invalid=flow<0 || entry<0 || entry!==NO_FLOW && (entry+2)%4===flow ||
      blocked || needsCross && !validCross || !!prior?.part.conflict;
    const part:PreviewCell={tile,kind:needsCross&&validCross?Kind.Crossing:tier,
      dir:needsCross&&validCross?crossingDirection(base,flow):Math.max(0,flow),conflict:invalid};
    parts.set(tile,{part,flow,straight,crossed:needsCross});
    conflict ||= invalid;
  }
  return {cells:Array.from(parts.values(),({part})=>part),terminal,conflict};
}

// Preserve the order of sampled drag segments, filling any gaps between samples.
export function dragTiles(from:number,to:number) {
  const [x,y]=xy(from), [tx,ty]=xy(to);
  const dx=tx-x, dy=ty-y, width=Math.abs(dx), height=Math.abs(dy);
  const tiles:number[]=[];
  let ix=0, iy=0;
  while (ix<width || iy<height) {
    if ((ix+.5)*height<=(iy+.5)*width && ix<width || iy>=height) ix++;
    else iy++;
    tiles.push(at(x+ix*Math.sign(dx),y+iy*Math.sign(dy)));
  }
  return tiles;
}

export function detourLockedCrossing(data:Int32Array,bounds:MapLimits,path:number[]) {
  if (unlocked(data,Kind.Crossing)) return undefined;
  const seen=new Set<number>();
  const last=path.length-1;
  for (let i=0;i<last;i++) {
    const tile=path[i];
    if (i>0 && (seen.has(tile) || plainBelt(cell(data,tile,Field.Kind)))) {
      const prefix=path.slice(0,i);
      const suffix=findBeltPath(data,bounds,prefix,path[last]);
      return suffix?[...prefix,...suffix]:undefined;
    }
    seen.add(tile);
  }
  return undefined;
}

type Node = {state:number; priority:number; cost:number};
class MinHeap {
  private items:Node[]=[];
  get size() { return this.items.length; }
  push(node:Node) {
    const heap=this.items;
    let i=heap.length;
    while (i>0) {
      const parent=(i-1)>>1;
      if (heap[parent].priority<=node.priority) break;
      heap[i]=heap[parent]; i=parent;
    }
    heap[i]=node;
  }
  pop() {
    const heap=this.items, first=heap[0], node=heap.pop()!;
    if (!heap.length) return first;
    let i=0;
    while (i*2+1<heap.length) {
      let child=i*2+1;
      if (child+1<heap.length && heap[child+1].priority<heap[child].priority) child++;
      if (heap[child].priority>=node.priority) break;
      heap[i]=heap[child]; i=child;
    }
    heap[i]=node;
    return first;
  }
}
