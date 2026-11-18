export const W = 56, H = 34, HZ = 20, HEADER = 98, STRIDE = 19;
export const STATION = 15 * W + 33;
export const STEP = [[1,0],[0,1],[-1,0],[0,-1]] as const;
export const DIRECTION = ['东', '南', '西', '北'];

export const enum Kind {
  Empty, Belt, IronDrill, SilicaDrill, FuelDrill, Smelter, Grinder, Calibrator,
  Assembler, Generator, Battery, Solar, Depot, Station, KitPress, Splitter, Kiln, SimpleMiner, Bench, Yard,
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
export const enum Op { Place = 1, Route, Remove, Configure, Launch, Trial, Blueprint, Rotate, Gather, CraftMiner, Collect, Handwork, Feed, OpenLine }

export const ITEM = ['','铁矿','硅矿','燃料','结构件','镜片','校准芯','镜阵模块','扩建套件'];
export const STATUS = ['待命','运转','缺少进料','供电不足','出料阻塞','等待窗口'];
export const MACHINE = [
  { name:'空地', cost:0, icon:'·', detail:'' },
  { name:'输送带', cost:1, icon:'⇥', detail:'朝箭头方向运送货物，速度 4 件/秒。' },
  { name:'铁矿钻机', cost:4, icon:'▧', detail:'在铁矿上开采铁矿。需供电。' },
  { name:'硅矿钻机', cost:4, icon:'▧', detail:'在硅矿上开采硅矿。需供电。' },
  { name:'燃料钻机', cost:4, icon:'▧', detail:'在燃料矿上开采燃料。需供电。' },
  { name:'冶炼炉', cost:5, icon:'▤', detail:'铁矿 → 结构件' },
  { name:'研磨机', cost:5, icon:'◇', detail:'2 硅矿 → 镜片' },
  { name:'校准芯机', cost:5, icon:'✚', detail:'硅矿 → 校准芯' },
  { name:'镜阵组装机', cost:8, icon:'⬡', detail:'2 结构件 + 镜片 → 镜阵模块' },
  { name:'火电机组', cost:8, icon:'ϟ', detail:'消耗燃料，最大输出 10.8 MW。' },
  { name:'蓄电池', cost:6, icon:'▥', detail:'储能 120 MJ，充放电功率上限 4 MW。' },
  { name:'太阳能阵列', cost:6, icon:'▦', detail:'反射光到达时输出 5.5 MW。' },
  { name:'建造仓', cost:4, icon:'▣', detail:'入库物料计入共享建造库存，也可指定一种出库物料。' },
  { name:'地面站', cost:8, icon:'◔', detail:'接收地面补给并跟踪轨道镜阵。' },
  { name:'套件装配机', cost:5, icon:'⬒', detail:'2 结构件 → 扩建套件。首照之后运行。' },
  { name:'分流器', cost:5, icon:'⑂', detail:'直行与右转分流。可切换到直行优先。' },
  { name:'批烧炉', cost:8, icon:'▨', detail:'4 硅矿 → 3 镜片。峰值用电 4.5 MW。' },
  { name:'简易采矿机', cost:0, icon:'▧', detail:'放在铁矿上，会自己采矿。' },
  { name:'压制台', cost:2, icon:'▤', detail:'放入铁矿，自动压成结构件。' },
  { name:'班线站场', cost:0, icon:'▥', detail:'按班次装货，抵达后向本地线路卸货。' },
] as const;

export type Mode = 'view' | 'build' | 'power' | 'orbit';
export type Tool = number | 'wire' | 'stamp' | 'capture' | 'remove' | 'cut' | 'valley-line' | 'highland-line';
export type Part = [dx:number, dy:number, kind:number, direction:number, wire:number, config:number];
export type PreviewCell = { tile:number; kind:number; dir:number; wire?:boolean; conflict?:boolean };
export type Command = { op:Op; a?:number; b?:number; c?:number; words?:number[] };

export const STANDARD: Part[] = [
  [0,0,Kind.IronDrill,0,1,0], [1,0,Kind.Belt,0,1,0], [2,0,Kind.Smelter,0,1,0],
  [3,0,Kind.KitPress,0,1,0], [4,0,Kind.Belt,0,1,0], [5,0,Kind.Depot,0,1,0],
];

export function cell(data:Int32Array, tile:number, field:number) {
  return data[HEADER + tile * STRIDE + field] ?? 0;
}
export function unlocked(data:Int32Array,kind:Kind) { return Boolean(data[Meta.Unlocked] & (1<<kind)); }
export function knownItems(data:Int32Array) {
  const since=[Stage.Gather,Stage.Craft,Stage.Silica,Stage.Power,Stage.Handwork,Stage.Assemble,Stage.Tracking,Stage.Launch,Stage.Sunlight];
  return since.flatMap((stage,item)=>data[Meta.Stage]>=stage?[item]:[]);
}
export function held(data:Int32Array,item:number) { return data[Meta.Stock+item-1]; }
export function xy(tile:number) { return [tile % W, Math.floor(tile / W)]; }
export function at(x:number,y:number) { return x >= 0 && x < W && y >= 0 && y < H ? y * W + x : -1; }
export function mw(raw:number) { return `${(raw / 10).toFixed(1)} MW`; }
export function time(ticks:number) {
  const seconds = Math.ceil(ticks / HZ);
  return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
}
export const ERRORS: Record<number,string> = {
  [-1]:'操作超出地图或参数无效。', [-2]:'路径或建筑与现有设备冲突。', [-3]:'钻机必须覆盖对应矿点。',
  [-4]:'建造仓的结构件不足。', [-5]:'建造仓的扩建套件不足。', [-6]:'当前阶段还不能执行此操作。',
  [-7]:'地面站需要 3 个镜阵模块和 5 份燃料。',
  [-8]:'手里的铁矿还不够。', [-9]:'当前没有可以转移的物料。',
  [-10]:'先在曙港增发一组镜阵。', [-11]:'先建好地面站，让班线货物从到货站进入当地设备或输送带。',
};
