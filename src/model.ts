export const W = 56, H = 34, HZ = 20, HEADER = 98, STRIDE = 19;
export const STATION = 15 * W + 33;
export const STEP = [[1,0],[0,1],[-1,0],[0,-1]] as const;
export const DIRECTION = ['东', '南', '西', '北'];

export const enum Kind {
  Empty, Belt, IronDrill, SilicaDrill, FuelDrill, Smelter, Grinder, Calibrator,
  Assembler, Generator, Battery, Solar, Depot, Station, KitPress, Splitter, Kiln, SimpleMiner, Bench, Yard, IndustrialMiner, Cable,
  FastBelt, Merger, Crossing, DevelopmentHub, ExpressBelt, ReinforcedIronDrill,
  ReinforcedSilicaDrill, ReinforcedFuelDrill, ReinforcedMiner,
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
  Transfer, CaptureBlueprint, RenameBlueprint, DeleteBlueprint, MigrateBlueprint, BuildTransport, TakeCargo }

export const SPEED_MODULE = 9;
export const ITEM = ['','铁矿','硅矿','燃料','结构件','镜片','校准芯','镜阵模块','扩建套件','速度模块'];
export const STATUS = ['待命','运转','缺少进料','供电不足','出料阻塞','等待窗口'];
export const MACHINE = [
  { name:'空地', detail:'' },
  { name:'基础输送带', detail:'朝箭头方向运送货物。' },
  { name:'铁矿钻机', detail:'在铁矿上开采铁矿。需供电。' },
  { name:'硅矿钻机', detail:'在硅矿上开采硅矿。需供电。' },
  { name:'燃料钻机', detail:'在燃料矿上开采燃料。需供电。' },
  { name:'冶炼炉', detail:'铁矿 → 结构件' },
  { name:'研磨机', detail:'2 硅矿 → 镜片' },
  { name:'校准芯机', detail:'硅矿 → 校准芯' },
  { name:'镜阵组装机', detail:'2 结构件 + 镜片 → 镜阵模块' },
  { name:'火电机组', detail:'燃烧燃料，为接通的电网发电。' },
  { name:'蓄电池', detail:'储存电网盈余，在用电高峰时放电。' },
  { name:'太阳能阵列', detail:'轨道反射光照到阵列时发电。' },
  { name:'建造仓', detail:'入库物料计入共享建造库存，也可指定一种出库物料。' },
  { name:'地面站', detail:'接收地面补给并跟踪轨道镜阵。' },
  { name:'套件装配机', detail:'2 结构件 → 扩建套件。首照之后运行。' },
  { name:'分流器', detail:'直行与右转分流。可切换到直行优先。' },
  { name:'批烧炉', detail:'4 硅矿 → 3 镜片。' },
  { name:'简易采矿机', detail:'放在铁矿上，会自己采矿。' },
  { name:'压制台', detail:'放入铁矿，自动压成结构件。' },
  { name:'班线站场', detail:'按班次装货，抵达后向本地线路卸货。' },
  { name:'工业采矿机', detail:'连接电网后开采落点的矿种。' },
  { name:'电缆', detail:'连接设备与电网。' },
  { name:'高速输送带', detail:'用更短的节拍运送货物。' },
  { name:'合流器', detail:'在可供货的入口间轮流取货，送入同一出口。' },
  { name:'交叉器', detail:'两条互相垂直的通道各自直行。' },
  { name:'阶段交付站', detail:'查看当前工厂上限和下一阶段。' },
  { name:'重载输送带', detail:'适用于高流量厂段，每个模拟步可交接一件货物。' },
  { name:'强化铁矿钻机', detail:'强化工业采矿机的铁矿型号。' },
  { name:'强化硅矿钻机', detail:'强化工业采矿机的硅矿型号。' },
  { name:'强化燃料钻机', detail:'强化工业采矿机的燃料矿型号。' },
  { name:'强化工业采矿机', detail:'按落点矿种开采，速度和额定耗电高于工业采矿机。' },
] as const;

export type Mode = 'task' | 'view' | 'build' | 'power' | 'orbit';
export type Tool = number | 'wire' | 'stamp' | 'capture' | 'remove' | 'cut' | 'valley-line' | 'highland-line';
export type Part = [dx:number, dy:number, kind:number, direction:number, wire:number, config:number];
export type PreviewCell = { tile:number; kind:number; dir:number; wire?:boolean; conflict?:boolean };
export type Command = { op:Op; a?:number; b?:number; c?:number; words?:number[] };

export function plainBelt(kind:Tool | undefined) { return kind===Kind.Belt || kind===Kind.FastBelt || kind===Kind.ExpressBelt; }
export function isTransport(kind:number) { return plainBelt(kind) || kind===Kind.Splitter || kind===Kind.Merger || kind===Kind.Crossing; }
export function drillTool(kind:number) { return kind===Kind.IndustrialMiner || kind===Kind.ReinforcedMiner; }

export type MapLimits = { minZoom:number; maxZoom:number; left:number; top:number; right:number; bottom:number };
export function transportStart(data:Int32Array) {
  const pointer=data[data.length-1]-1;
  return pointer>=HEADER+W*H*STRIDE ? data[pointer] : -1;
}
export function progression(data:Int32Array) {
  const i=transportStart(data)-13;
  return { tier:data[i], slots:data[i+1], stack:data[i+2], speed:data[i+3], minZoom:data[i+4], maxZoom:data[i+5],
    left:data[i+6], top:data[i+7], right:data[i+8], bottom:data[i+9], used:data[i+10], modules:data[i+11], installed:data[i+12] };
}
export function inBounds(bounds:MapLimits,x:number,y:number) {
  return x>=bounds.left && x<bounds.right && y>=bounds.top && y<bounds.bottom;
}

export function cell(data:Int32Array, tile:number, field:number) {
  return data[HEADER + tile * STRIDE + field] ?? 0;
}
export function unlocked(data:Int32Array,kind:Kind) { return Boolean(data[Meta.Unlocked] & (1<<kind)); }
export function knownItems(data:Int32Array) {
  const since=[Stage.Gather,Stage.Craft,Stage.Silica,Stage.Power,Stage.Handwork,Stage.Assemble,Stage.Tracking,Stage.Launch,Stage.Sunlight];
  const items=since.flatMap((stage,item)=>data[Meta.Stage]>=stage?[item]:[]);
  const {modules,installed}=progression(data);
  if (modules || installed) items.push(SPEED_MODULE);
  return items;
}
export function held(data:Int32Array,item:number) { return item===SPEED_MODULE?progression(data).modules:data[Meta.Stock+item-1]; }
export function xy(tile:number) { return [tile % W, Math.floor(tile / W)]; }
export function at(x:number,y:number) { return x >= 0 && x < W && y >= 0 && y < H ? y * W + x : -1; }
export function mw(raw:number) { return `${(raw / 10).toFixed(1)} MW`; }
export function time(ticks:number) {
  const seconds = Math.ceil(ticks / HZ);
  return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
}
export const ERRORS: Record<number,string> = {
  [-1]:'操作超出地图或参数无效。', [-2]:'路径或建筑与现有设备冲突。', [-3]:'此处地形不适合放置。',
  [-4]:'建造仓的结构件不足。', [-5]:'建造仓的扩建套件不足。', [-6]:'当前阶段还不能执行此操作。',
  [-7]:'地面站需要 3 个镜阵模块和 5 份燃料。',
  [-8]:'手里的铁矿还不够。', [-9]:'当前没有可以转移的物料。',
  [-10]:'先在曙港增发一组镜阵。', [-11]:'先建好地面站，让班线货物从到货站进入当地设备或输送带。',
  [-12]:'这个槽位只支持自动运输。', [-13]:'所选物料与槽位不符。', [-14]:'进料槽已满。',
  [-15]:'设备已经更换，请重新选择槽位。', [-16]:'蓝图已删除或布局版本已变化。',
  [-17]:'蓝图名称或布局无效。', [-18]:'蓝图库已满。', [-19]:'这处矿脉尚未开放工业开采。',
  [-20]:'覆建设备的端口与在途货物或现有线路方向不匹配。', [-21]:'目标通道容量不足，无法保留全部货物。',
  [-22]:'货物或通道已变化，请从更新后的槽位重新选择。', [-23]:'施工区布局已变化，请重新确认预览。',
  [-24]:'背包空间不足，物资留在原处。',
};
