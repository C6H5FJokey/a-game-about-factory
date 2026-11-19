import { content, SIM_HZ as HZ } from './generated-content';

export { HZ };
export const W = 56, H = 34, HEADER = 98, STRIDE = 19;
export const STATION = 15 * W + 33;
export const STEP = [[1,0],[0,1],[-1,0],[0,-1]] as const;
export const DIRECTION = ['东', '南', '西', '北'];

export const enum Kind {
  Empty, Belt, IronDrill, SilicaDrill, FuelDrill, Smelter, Grinder, Calibrator,
  Assembler, Generator, Battery, Solar, Depot, Station, KitPress, Splitter, Kiln, SimpleMiner, Bench, Yard, IndustrialMiner, Cable,
  FastBelt, Merger, Crossing, DevelopmentHub, ExpressBelt, ReinforcedIronDrill,
  ReinforcedSilicaDrill, ReinforcedFuelDrill, ReinforcedMiner,
  Splicer, UltraBelt, CopperDrill, ReinforcedCopperDrill,
}
export const enum Meta {
  Tick, Plates, Kits, Launch, Orbit, Window, WindowTicks, FirstLight, Blocks, Generation, Demand,
  Stored, Mirrors, Cores, Fuel, Fault, FaultAt, Sun, Segments, Delivered, KitTotal, Complete,
  NextWindow, Discharge, GridUsed, StationGrid, DeliverySeconds, RequiredBlocks, RequiredKits,
  Stage, Packed, MinerCost, MinerTicks, MinerCapacity, Unlocked, FirstOre, Stock,
  Modules=44, TargetCity, Program, Rounds, LitMask, FaultCity, Headway, Travel, CrateSize, LineCost, Cities,
  BeamX100=96, VictoryTicks,
}
export const CITY = ['曙港','谷东','西岭'];
export const enum CityField { Site, Sender, Receiver, Duration, Power, CoreReserve, EnergyReserve, Stored, Arrival, InTransit, Delivered, Generation, Demand, Gap }
export function cityValue(data:Int32Array, city:number, field:CityField) { return data[Meta.Cities+14*city+field]; }
export const enum Stage { Gather, Craft, PlaceMiner, Mining, Collect, Handwork, Bench, Feed, Working,
  Belt, BeltFed, Expand, Power, Silica, Optics, Assemble, Launch, Tracking, Sunlight, Valley, Highland, Acceptance, Victory }
export const enum Field { Kind, Direction, Wire, Ore, Cargo, Status, Grid, Config, Progress, Energy, Inventory, DeliveringKits = 18 }
export const enum Op { Place = 1, Route, Remove, Configure, Launch, Trial, Blueprint, Rotate, Gather, CraftMiner, Collect, Handwork, Feed, OpenLine,
  Transfer, CaptureBlueprint, RenameBlueprint, DeleteBlueprint, MigrateBlueprint, BuildTransport, TakeCargo,
  SelectRecipe, StartHandcraft, CancelHandcraft, FinishHandcraft, DropHeld, PickGround }

export const SPEED_MODULE = 9;
export const STATUS = ['待命','运转','缺少进料','供电不足','出料阻塞','等待窗口','未选配方'];

export type Mode = 'task' | 'view' | 'build' | 'power' | 'orbit' | 'guide';
export type Tool = number | 'wire' | 'stamp' | 'capture' | 'remove' | 'cut' | 'valley-line' | 'highland-line';
export type Part = [dx:number, dy:number, kind:number, direction:number, wire:number, config:number];
export type PreviewCell = { tile:number; kind:number; dir:number; wire?:boolean; conflict?:boolean };
export type Command = { op:Op; a?:number; b?:number; c?:number; words?:number[] };

export function plainBelt(kind:Tool | undefined) { return kind===Kind.Belt || kind===Kind.FastBelt || kind===Kind.ExpressBelt || kind===Kind.UltraBelt; }
export function isTransport(kind:number) { return plainBelt(kind) || kind===Kind.Splitter || kind===Kind.Merger || kind===Kind.Crossing; }
export function drillTool(kind:number) { return kind===Kind.IndustrialMiner || kind===Kind.ReinforcedMiner; }

export type MapLimits = { minZoom:number; maxZoom:number; left:number; top:number; right:number; bottom:number };
export function transportStart(data:Int32Array) {
  const pointer=data[data.length-1]-1;
  return pointer>=HEADER+W*H*STRIDE ? data[pointer] : -1;
}
export function progression(data:Int32Array) {
  const i=transportStart(data)-13;
  return { tier:data[i], slots:data[i+1], speed:data[i+3], minZoom:data[i+4], maxZoom:data[i+5],
    left:data[i+6], top:data[i+7], right:data[i+8], bottom:data[i+9], used:data[i+10], modules:data[i+11], installed:data[i+12] };
}
export function stackLimit(data:Int32Array,item:number) {
  const entry=content.items[item];
  return (progression(data).tier>0?entry?.tierOneStackLimit:entry?.stackLimit) ?? 100;
}
export function inBounds(bounds:MapLimits,x:number,y:number) {
  return x>=bounds.left && x<bounds.right && y>=bounds.top && y<bounds.bottom;
}

export function cell(data:Int32Array, tile:number, field:number) {
  return data[HEADER + tile * STRIDE + field] ?? 0;
}
function recipesEnd(data:Int32Array) { return data[transportStart(data)-14]-1; }
export function recipesStart(data:Int32Array) { return data[recipesEnd(data)]; }
export function legacyRecipes(data:Int32Array) { return data[recipesStart(data)]!==0; }
export function selectedRecipe(data:Int32Array,tile:number) {
  for (let i=recipesStart(data)+2+content.items.length-10;i<recipesEnd(data);i+=3) {
    if (data[i]===tile) return {key:data[i+1],ticks:data[i+2]};
  }
  return undefined;
}
export function unlocked(data:Int32Array,kind:Kind) {
  return Boolean(kind<32?data[Meta.Unlocked]&(1<<kind):data[recipesStart(data)+1]&(1<<(kind-32)));
}
export function knownItems(data:Int32Array) {
  const since=[Stage.Gather,Stage.Gather,Stage.Silica,Stage.Power,Stage.Gather,Stage.Assemble,Stage.Tracking,Stage.Launch,Stage.Sunlight];
  const items=since.flatMap((stage,item)=>data[Meta.Stage]>=stage || item>0 && held(data,item)>0?[item]:[]);
  if (!legacyRecipes(data)) for (let item=10;item<content.items.length;item++) {
    if (data[Meta.Stage]>=(item<16?Stage.Handwork:Stage.Silica) || held(data,item)>0) items.push(item);
  }
  const {modules,installed}=progression(data);
  if (modules || installed) items.push(SPEED_MODULE);
  return items;
}
export function held(data:Int32Array,item:number) {
  return item===SPEED_MODULE?progression(data).modules:(data[item>=10?recipesStart(data)+2+item-10:Meta.Stock+item-1] ?? 0);
}
export function xy(tile:number) { return [tile % W, Math.floor(tile / W)]; }
export function at(x:number,y:number) { return x >= 0 && x < W && y >= 0 && y < H ? y * W + x : -1; }
export function mw(raw:number) { return `${(raw / 10).toFixed(1)} MW`; }
export function energyMj(raw:number) { return raw / (10 * HZ); }
export function time(ticks:number) {
  const seconds = Math.ceil(ticks / HZ);
  return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
}
