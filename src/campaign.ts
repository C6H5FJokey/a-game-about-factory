import { Field, H, Kind, Meta, Stage, STATION, W, cell, held } from './model';
import { design } from './sim-data';
import { t } from './i18n';

export function firstMachine(data:Int32Array,kind:Kind) {
  for (let i=0;i<W*H;i++) if (cell(data,i,Field.Kind)===kind) return i;
  return -1;
}

export function contents(data:Int32Array,tile:number,item:number) {
  return tile<0?0:cell(data,tile,Field.Inventory+item-1);
}

export const handbook = {
  map:Stage.Gather,
  gather:Stage.Gather,
  build:Stage.Craft,
  miner:Stage.Mining,
  slots:Stage.Collect,
  handwork:Stage.Handwork,
  belt:Stage.Belt,
  power:Stage.Power,
  orbit:Stage.Launch,
} as const;

type Guide = keyof typeof handbook;

export function guideText(id:Guide) {
  return {title:t(`guide.${id}.title`),steps:t(`guide.${id}.steps`).split('\n')};
}

export function campaignTask(data:Int32Array) {
  const task=(id:string,guides:Guide[],progress?:string)=>({
    title:t(`tutorial.${id}.title`),detail:t(`tutorial.${id}.goal`),guides,progress,
  });
  const stock=(item:number,required:number)=>`${held(data,item)} / ${required}`;
  const cost=(kind:Kind)=>design(kind)?.materials[0]?.count ?? 0;
  switch (data[Meta.Stage]) {
    case Stage.Gather: return task('gather',['gather','map'],stock(1,1));
    case Stage.Craft: case Stage.PlaceMiner:
      return task('miner',['build','gather'],data[Meta.Packed]?t('tutorial.miner.ready'):stock(1,cost(Kind.SimpleMiner)));
    case Stage.Mining: return task('mining',['miner']);
    case Stage.Collect: return task('collect',['slots'],t('tutorial.collect.stored',{
      count:contents(data,firstMachine(data,Kind.SimpleMiner),1),
    }));
    case Stage.Handwork: return task('handwork',['handwork'],stock(4,1));
    case Stage.Bench: return task('bench',['build','handwork'],stock(4,cost(Kind.Bench)));
    case Stage.Feed: return task('feed',['slots']);
    case Stage.Working: return task('working',['slots']);
    // TODO(first-miner): the formal automatic-feed task needs a receiving machine's actual intake and recipe production.
    case Stage.Belt: case Stage.BeltFed: return task('depot',['belt','slots'],`${data[Meta.Delivered]} / 1`);
    case Stage.Expand: return data[Meta.Delivered]?task('drill',['build']):task('depot',['belt','slots'],`${data[Meta.Delivered]} / 1`);
    case Stage.Power: return task('power',['power','gather','slots']);
    case Stage.Silica: return task('silica',['gather']);
    case Stage.Optics: return task('optics',['build','power','slots']);
    case Stage.Assemble: return task('assemble',['build','power','slots']);
    case Stage.Launch:
      return task('launch',['orbit','power','slots'],cell(data,STATION,Field.Kind)===Kind.Station?
        `${contents(data,STATION,7)} / 3 · ${contents(data,STATION,3)} / 5`:undefined);
    default: return task('tracking',['orbit','power']);
  }
}
