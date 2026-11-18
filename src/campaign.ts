import { Field, H, Kind, Meta, Stage, STATION, W, cell, held } from './model';

export function firstMachine(data:Int32Array, kind:Kind) {
  for (let i=0;i<W*H;i++) if (cell(data,i,Field.Kind)===kind) return i;
  return -1;
}
export function contents(data:Int32Array,tile:number,item:number) {
  return tile<0?0:cell(data,tile,Field.Inventory+item-1);
}
type Action = [label:string, action:string, disabled?:boolean];
export type Lesson = [title:string,detail:string, ...actions:Action[]];

export function workshopLesson(data:Int32Array):Lesson {
  const iron=held(data,1), plates=data[Meta.Plates], cost=data[Meta.MinerCost];
  const bench=firstMachine(data,Kind.Bench), output=contents(data,bench,4);
  const press:Action=['手制结构件','handwork',iron===0];
  switch (data[Meta.Stage]) {
    case Stage.Gather: return ['',''];
    case Stage.Craft: return ['简易采矿机','放在铁矿上，会自己采矿。',
      [iron<cost?`铁矿 ${iron} / ${cost}`:`制作 · ${cost} 铁矿`,'craft-miner',iron<cost]];
    case Stage.PlaceMiner: return ['安放采矿机','点刚才采集的矿点，选好位置后安放。',['选择矿点','site-miner']];
    case Stage.Mining: return ['简易采矿机','机头正在采矿。'];
    case Stage.Collect: return ['矿石落进了出料格','点机器旁的「取走」，把积存的铁矿带上。'];
    case Stage.Handwork: return ['做一块结构件','把手里的铁矿压成结构件，用它搭一台压制台。',press];
    case Stage.Bench: return ['搭一台压制台','用两块结构件做台架，让它替你压矿。',...(plates<2?[press]:[]),
      [`安放压制台 · ${Math.min(2,plates)} / 2`,'site-bench',plates<2]];
    case Stage.Feed: return ['把矿送进压制台','从机旁取矿，送进压制台的进料口。',['放入铁矿','feed-bench',iron===0]];
    case Stage.Working: return ['压制台正在工作','留意台面上的第一块结构件。'];
    case Stage.Belt: case Stage.BeltFed: return ['让矿自己到达压制台',
      '把采矿机的出口接到压制台。箭头指向收料的一端。',
      ...(output?[[`取走结构件 ×${output}`,'collect-bench'] as Action]:[]),
      ['铺输送带','first-belt'],...(plates===0?[press]:[])];
    case Stage.Expand:
      if (!data[Meta.Delivered]) {
        const depot=firstMachine(data,Kind.Depot);
        return ['把结构件送进建造仓',depot<0?'在压制台的出料方向安放建造仓。每块入仓的结构件都能直接拿来施工。':plates===0?'再从压制台取一块结构件，用它铺下一段输送带。':'从压制台出料口铺到建造仓，让第一块结构件自己到仓。',
          ...(output?[[`取走结构件 ×${output}`,'collect-bench'] as Action]:[]),
          depot<0?['安放建造仓 · 4 结构件','new-depot',plates<4]:['铺输送带','second-belt',plates===0]];
      }
      return ['让第二个矿点开工','接下来的生产需要更多铁矿。试着安放一台更快的铁矿钻机。',
      ['选址建铁矿钻机','new-drill'],...(output?[[`取走结构件 ×${output}`,'collect-bench'] as Action]:[])];
    case Stage.Power: {
      const generator=firstMachine(data,Kind.Generator);
      if (generator<0) return ['钻机在等电','附近有燃料。建一台火电机组，为钻机供电。',['安放火电机组','new-generator']];
      if (!contents(data,generator,3) && !cell(data,generator,Field.Progress)) return ['点燃机组','在燃料矿采集燃料，装进机组。燃料钻机也能持续供料。',
        held(data,3)?['装入燃料','fuel-generator']:['采集燃料','gather-fuel']];
      return ['让钻机转起来','用电缆连起机组和铁矿钻机，等钻机采出铁矿。',['连接电缆','connect-drill']];
    }
    case Stage.Silica: return ['寻找制镜原料','附近露出一片硅矿。去取一份看看。',['采集硅矿','gather-silica']];
    case Stage.Optics: {
      const grinder=firstMachine(data,Kind.Grinder);
      if (grinder<0) return ['磨出第一块镜片','在电缆上安放研磨机，用两份硅矿磨一块镜片。',['安放研磨机','new-grinder']];
      if (held(data,2)+contents(data,grinder,2)<2 && firstMachine(data,Kind.SilicaDrill)<0)
        return ['给研磨机备料','一块镜片需要两份硅矿。',['采集硅矿','gather-silica']];
      return ['磨出第一块镜片','把硅矿送进研磨机，镜片会落在出料口。',['查看研磨机','new-grinder']];
    }
    case Stage.Assemble: return ['组装试验镜','把两块结构件和一块镜片送进接电的组装机。',
      [firstMachine(data,Kind.Assembler)<0?'安放镜阵组装机':'查看镜阵组装机','new-assembler'],
      ...(contents(data,firstMachine(data,Kind.Grinder),5)>0?[['取走镜片','take-'+firstMachine(data,Kind.Grinder)] as Action]:[])];
    case Stage.Launch: return ['把试验镜送入轨道','在曙港地面站备好三个模块与五份燃料，并接通电源。',
      [cell(data,STATION,Field.Kind)===Kind.Station?'查看地面站':'安放地面站','station']];
    case Stage.Tracking: return ['给曙港一次试照','地面站跟踪需要 12 MW，每秒消耗一枚校准芯。备好供给，再开始试照。',
      ['试照控制台','station'],['安放校准芯机','new-calibrator']];
    default: return ['',''];
  }
}

export const outputItem:Record<number,number>={
  [Kind.SimpleMiner]:1,[Kind.IronDrill]:1,[Kind.SilicaDrill]:2,[Kind.FuelDrill]:3,
  [Kind.Bench]:4,[Kind.Smelter]:4,[Kind.Grinder]:5,[Kind.Kiln]:5,
  [Kind.Calibrator]:6,[Kind.Assembler]:7,[Kind.KitPress]:8,
};
export const inputs:Record<number,number[]>={
  [Kind.Bench]:[1],[Kind.Smelter]:[1],[Kind.Grinder]:[2],[Kind.Kiln]:[2],
  [Kind.Assembler]:[4,5],[Kind.KitPress]:[4],[Kind.Generator]:[3],[Kind.Calibrator]:[2],
};
