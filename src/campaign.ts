import { Field, H, Kind, Meta, Stage, STATION, W, cell, held, legacyRecipes } from './model';
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
  manualMaterials:Stage.Handwork,
  connectPower:Stage.Bench,
  chooseRecipe:Stage.Feed,
  automaticFeed:Stage.Belt,
  belt:Stage.Belt,
  power:Stage.Power,
  orbit:Stage.Launch,
} as const;

type Guide = keyof typeof handbook;

export function visibleGuide(data:Int32Array,id:Guide) {
  const modern=id==='manualMaterials' || id==='connectPower' || id==='chooseRecipe' || id==='automaticFeed';
  return data[Meta.Stage]>=handbook[id] && (legacyRecipes(data)?!modern:id!=='handwork');
}

export function guideText(id:Guide) {
  return {title:t(`guide.${id}.title`),steps:t(`guide.${id}.steps`).split('\n')};
}

export function campaignTask(data:Int32Array) {
  const task=(id:string,guides:Guide[],progress?:string)=>({
    title:t(`tutorial.${id}.title`),detail:t(`tutorial.${id}.goal`),guides,progress,
  });
  const stock=(item:number,required:number)=>`${held(data,item)} / ${required}`;
  const cost=(kind:Kind)=>design(kind)?.materials[0]?.count ?? 0;
  if (!legacyRecipes(data)) {
    switch (data[Meta.Stage]) {
      case Stage.Handwork: return task('manualMaterials',['manualMaterials'],stock(15,2));
      case Stage.Bench: return task('connectPower',['connectPower','build','manualMaterials']);
      case Stage.Feed: case Stage.Working: return task('chooseRecipe',['chooseRecipe','connectPower','slots']);
      case Stage.Belt: case Stage.BeltFed: return task('automaticFeed',['automaticFeed','belt'],
        t(data[Meta.Stage]===Stage.BeltFed?'ui.beltIntakeReceived':'ui.beltIntakePending'));
      case Stage.Expand: return task('drill',['build']);
      case Stage.Power: return task('poweredMiner',['connectPower','power']);
      case Stage.Optics: return task('opticalChain',['chooseRecipe','slots']);
      case Stage.Assemble: return task('mirrorChain',['chooseRecipe','slots']);
      case Stage.Tracking: return task('calibrationChain',['chooseRecipe','orbit','power']);
    }
  }
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
