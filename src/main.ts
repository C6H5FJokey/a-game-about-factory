import './style.css';
import { bindMapInput, orthogonal } from './input';
import { beltTerminal, detourLockedCrossing, dragTiles, findBeltPath, projectBeltPath } from './belt-route';
import { bindActionHold } from './action-hold';
import { bindInventoryDrag, canSelectSlot, readSlot, sameSlot, type Selection, type Slot, type SlotRole } from './inventory-drag';
import {
  DIRECTION, Field, H, HEADER, HZ, Kind, Meta, Op, energyMj, legacyRecipes, selectedRecipe,
  STATION, STATUS, STEP, STRIDE, Stage, W, SPEED_MODULE, at, cell, drillTool, held, inBounds, isTransport, plainBelt, progression, stackLimit, mw, time, unlocked, xy, CITY, CityField, cityValue, knownItems,
  type Command, type Mode, type PreviewCell, type Tool,
} from './model';
import { Renderer } from './renderer';
import { campaignTask, contents, firstMachine, guideText, handbook, visibleGuide } from './campaign';
import { clearLegacyBlueprint, downloadSave, legacyBlueprint, persistSave, resumeSave, reviewScene } from './storage';
import { actionIcon, itemIcon, machineIcon } from './icons';
import { devicePower, designPower } from './power-readout';
import { cargoAt, design, deviceAt, drillVariant, layoutRevision, preparedMaterials, readBlueprints, readDirectory, transportPorts, type Blueprint, type CargoTrack, type Material, type SlotData } from './sim-data';
import { ERRORS, ITEM, MACHINE, itemDescription } from './catalog-text';
import { content } from './generated-content';
import { language, languages, onLanguageChange, setLanguage, t, textHtml } from './i18n';
import { footprint, machineAnchor, machineMasks, machineSize, occupiedKind, previewPorts, rotatePart } from './machine-layout';

function byId<T extends HTMLElement = HTMLElement>(id:string) { return document.getElementById(id) as T; }

const app=byId('app'), canvas=byId<HTMLCanvasElement>('world'), loading=byId('loading');
const panel=byId('panel'), panelBody=byId('panel-body'), draft=byId('draft');
const panelTabs=byId('panel-tabs');
const dialog=byId<HTMLDialogElement>('archive-dialog'), saveFile=byId<HTMLInputElement>('save-file');
const blueprintDialog=byId<HTMLDialogElement>('blueprint-dialog'), transferDialog=byId<HTMLDialogElement>('transfer-dialog');
const notice=byId('notice'), balances=byId('balances'), quickInfo=byId('quick-info');
const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
let renderer:Renderer | undefined;
let data=new Int32Array(HEADER+W*H*STRIDE);
let limits=progression(data);
let ready=false, mode:Mode='task', tool:Tool | undefined, selected=-1, focus=-1, inspectingTile=false;
let guideOpen=false, guideReturnScroll=0;
let manualWork=false, handcraftExpanded:number|undefined;
let gainUntil=0, gainTile=-1, recenter=true;
const gain=byId('ore-gain'), mapHarvest=byId('map-harvest');
const portraitDrawer=window.matchMedia('(max-width: 720px) and (orientation: portrait)');
let traced:[number,number][]=[];
let anchors:number[]=[], direction=0, verticalFirst=false, lastSnapshot=0, lastPanelRender=0;
let catalogTool=false, beltStarted=false, beltFacing=false, pathMessage='';
let dragOrigin:{anchors:number[]; started:boolean; facing:boolean; direction:number; message:string} | undefined;
let pausedPhase=0;
let blueprints:Blueprint[]=[];
let stamping:Pick<Blueprint,'id'|'version'> | undefined;
let blueprintEdit:{ action:'capture'|'rename'|'delete'; id?:number } | undefined;
let legacyCleanup=false;
let buildTab:'catalog'|'blueprints'='catalog';
let speed=1, exportPending=false, manualSave=false, noticeTimeout=0, commitTimeout=0;
let pending:((result:number)=>void) | undefined, panelPointer=false;
let pendingFailure:((status:number)=>void) | undefined;
let previewSequence=0;
let transportPreview:{key:string;request:number;cargoKey:string;result?:Int32Array} | undefined;
let confirmTransport=0;

type Draft = { cells:PreviewCell[]; command?:Command; materials:Material[]; label:string; conflict:boolean; capture?:boolean };
let ghost:Draft={cells:[],materials:[],label:'',conflict:false};

let selectedItem:Selection | undefined;
let infoKey='', infoPinned=false, infoTile=-1;
let balanceItems='';

const languageSelect=byId<HTMLSelectElement>('language-select');
languageSelect.replaceChildren(...languages.map(locale=>{
  const names=new Intl.DisplayNames([locale],{type:'language'});
  return new Option(names.of(locale) ?? locale,locale);
}));
languageSelect.closest('label')!.hidden=languages.length<2;
function applyTranslations() {
  document.documentElement.lang=language();
  languageSelect.value=language();
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    node.textContent=t(node.dataset.i18n!);
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    node.setAttribute('aria-label',t(node.dataset.i18nLabel!));
  }
  balanceItems='\0';
  refresh();
}
languageSelect.addEventListener('change',()=>{ void setLanguage(languageSelect.value); });
onLanguageChange(applyTranslations);

const slotKey=(role:SlotRole,item:number,tile:number,lane=0)=>`slot-${role}-${item}-${tile}-${lane}`;
const slotArt=(item:number,count:number)=>itemIcon(item)+`<span class="item-count">${count}</span>`;
const slotLabel=(role:SlotRole,item:number,count:number)=>t('ui.slotLabel',{role:t('ui.'+role),item:ITEM[item],count});
const deviceIdentity=(tile:number)=>deviceAt(data,tile)?.identity ?? 0;
const slotSelected=(role:SlotRole,item:number,tile:number,track?:CargoTrack)=>selectedItem?.role===role && selectedItem.item===item && selectedItem.tile===tile && selectedItem.identity===(track?.identity ?? deviceIdentity(tile)) && selectedItem.cargoId===(track?.id ?? 0);
const amountBadge=(role:SlotRole,item:number,tile:number,track?:CargoTrack)=>(slotSelected(role,item,tile,track)?selectedItem?.quantity:undefined);
const slotData=(role:SlotRole,item:number,count:number,tile:number,lane=0)=>`data-slot="${role}" data-item="${item}" data-tile="${tile}" data-count="${count}" data-quick="${slotKey(role,item,tile,lane)}" aria-label="${textHtml(slotLabel(role,item,count))}"`;
const itemSlot=(role:SlotRole,item:number,count:number,tile=-1,context='',slot?:SlotData,track?:CargoTrack)=>`
  <button type="button" class="item-slot" ${slotData(role,item,count,tile,(track?.location ?? 0)%2)}
    ${slot?`data-identity="${deviceIdentity(tile)}" data-capacity="${slot.capacity}" data-put="${slot.canPut}" data-take="${slot.canTake}"`:''}
    ${track?`data-identity="${track.identity}" data-lane="${track.location%2}" data-cargo-id="${track.id}" data-take="true"`:''}
    ${role==='held'||slot?.canTake||track?`aria-pressed="${slotSelected(role,item,tile,track)}" data-selected-count="${amountBadge(role,item,tile,track) ?? ''}"`:''}
    ${context?`data-context="${textHtml(context)}"`:''}>${slotArt(item,count)}</button>`;
const slotRow=(title:string,slots:string)=>slots?`<div class="slot-row"><span class="slot-label">${title}</span><div class="slots">${slots}</div></div>`:'';

const button=(name:string,action:string,primary=false,disabled=false)=>
  `<button type="button" class="button${primary?' primary':''}" data-action="${action}"${disabled?' disabled':''}>${textHtml(name)}</button>`;
const iconButton=(name:string,action:string,icon:Parameters<typeof actionIcon>[0])=>
  `<button type="button" class="button icon-button icon-button--${icon}" data-action="${action}" aria-label="${textHtml(name)}" title="${textHtml(name)}">${actionIcon(icon)}</button>`;
const harvestMeter='<span class="harvest-meter" aria-hidden="true"><span class="harvest-fill"></span></span>';
const holdButton=(label:string,attribute:string,target:number,disabled=false)=>
  `<button type="button" class="button harvest-button" ${attribute}="${target}"${disabled?' disabled':''}>${textHtml(label)}${harvestMeter}</button>`;
const harvestButton=(tile:number)=>
  tile<0?'':holdButton(t('ui.holdGather'),'data-gather',tile);
const readings=(rows:(readonly [string,string|number])[])=>
  `<dl class="readings">${rows.map(([name,value])=>`<div><dt>${textHtml(name)}</dt><dd>${textHtml(value)}</dd></div>`).join('')}</dl>`;
const signal=(message:string,fault=false)=>`<p class="signal${fault?' fault':''}">${message}</p>`;
const actions=(...buttons:string[])=>`<div class="actions">${buttons.join('')}</div>`;
const bar=(n:number,max:number)=>`<div class="bar" role="progressbar" aria-label="进度" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${Math.min(n,max)}"><span style="width:${Math.min(100,n/max*100)}%"></span></div>`;
const coordinates=(tile:number)=>{const [x,y]=xy(tile);return `${x}, ${y}`;};

const holdAvailable=()=>ready && speed>0 && !dialog.open && !blueprintDialog.open && !transferDialog.open;
const harvest=bindActionHold(app,{
  attribute:'data-gather', duration:450,
  available:tile=>holdAvailable() && tool===undefined && tile>=0 && !!cell(data,tile,Field.Ore),
  complete:gatherAt,
  mapMeter:mapHarvest.querySelector<HTMLElement>('.harvest-fill')!,
});

const manualRecipes=content.recipes.flatMap(row=>row.handcraft?[{
  key:row.key, inputs:row.handcraft.inputs, output:row.output, ticks:row.handcraft.ticks, unlock:row.handcraft.unlockStage,
}]:[]);
const legacyHandcraft={key:0,inputs:[{item:1,amount:1}],output:{item:4,amount:1},
  ticks:content.recipes.find(row=>row.id==='press-plate')!.baseTicks,unlock:0};
const handOptions=()=>legacyRecipes(data)?[legacyHandcraft]:manualRecipes.filter(row=>data[Meta.Stage]>=row.unlock);
const handRecipe=(key:number)=>handOptions().find(row=>row.key===key);
const hasHandcraftMaterial=(key:number)=>handRecipe(key)?.inputs.every(row=>held(data,row.item)>=row.amount) ?? false;
let handToken=0, handStarted=0;
const handcraft=bindActionHold(app,{
  attribute:'data-handcraft', duration:key=>(handRecipe(key)?.ticks ?? HZ)*1000/(HZ*speed),
  available:key=>holdAvailable() && mode==='view' && manualWork && handcraftExpanded===key && !guideOpen &&
    panel.dataset.expanded==='true' && hasHandcraftMaterial(key),
  begin:key=>key===0 || submit({op:Op.StartHandcraft,a:key,b:++handToken},
    ()=>{handStarted=data[Meta.Tick];},()=>{handcraft.stop();}),
  cancel:key=>{ if (key!==0) worker.postMessage({type:'cancel-handcraft',token:handToken}); },
  complete:key=>{
    const row=handRecipe(key);
    if (!row || key!==0 && data[Meta.Tick]-handStarted<row.ticks) return false;
    return submit(key===0?{op:Op.Handwork}:{op:Op.FinishHandcraft,a:handToken},count=>{
      handStarted=data[Meta.Tick];
      say(t('ui.handcraftResult',{item:ITEM[row.output.item],count}));
    },()=>{handcraft.stop();});
  },
});

bindInventoryDrag(app,byId('item-drag'),{
  selected:()=>selectedItem,
  select:source=>{ selectedItem=source; closeInfo(); refresh(); },
  drop:transferSlot,
  art:itemIcon,
});
const blueprintById=(id:number)=>blueprints.find(entry=>entry.id===id);
const activeBlueprint=()=>{
  const selection=stamping;
  return selection && blueprints.find(entry=>entry.id===selection.id && entry.version===selection.version);
};
const affordable=(materials:Material[])=>materials.every(({item,count})=>held(data,item)>=count);
const buildMaterials=(kind:number)=>preparedMaterials(kind,Boolean(data[Meta.Packed]));

function say(message:string,error=false) {
  window.clearTimeout(noticeTimeout);
  notice.textContent=message; notice.classList.toggle('error',error); notice.hidden=false;
  noticeTimeout=window.setTimeout(()=>{ notice.hidden=true; },3800);
}

function fail(message:string) {
  loading.hidden=false; loading.querySelector('p')!.textContent=message;
  app.setAttribute('aria-busy','false');
}

function setPanel(open:boolean) {
  panel.dataset.expanded=String(open);
  byId('panel-toggle').setAttribute('aria-expanded',String(open));
  byId('panel-surface').inert=!open;
  if (!open && infoKey && panel.querySelector(`[data-quick="${infoKey}"]`)) closeInfo();
}

function operationPage():Mode {
  return inspectingTile && tool===undefined?'view':mode;
}

function closeGuide() {
  guideOpen=false;
  refresh();
  panelBody.scrollTop=guideReturnScroll;
}

function selectMode(next:Mode,crafting=false) {
  if (!modeAvailable(next)) return;
  if (next==='guide') {
    if (guideOpen) { closeGuide(); return; }
    guideReturnScroll=panelBody.scrollTop;
    guideOpen=true;
    closeInfo();
    setPanel(true);
    refresh();
    panelBody.scrollTop=0;
    return;
  }
  if (guideOpen && next===operationPage() && !crafting) { closeGuide(); return; }
  guideOpen=false;
  clearDraft();
  mode=next;
  manualWork=crafting;
  inspectingTile=false;
  traced=[];
  setPanel(true);
  refresh();
  panelBody.scrollTop=0;
}

function clearDraft() {
  tool=undefined; anchors=[];
  catalogTool=false; beltStarted=false; beltFacing=false; pathMessage=''; dragOrigin=undefined;
  transportPreview=undefined; confirmTransport=0;
  ghost={cells:[],materials:[],label:'',conflict:false};
  canvas.removeAttribute('data-tool');
  delete draft.dataset.catalog;
  draft.hidden=true;
}

function choose(next:Tool,anchor=-1,fromCatalog=false) {
  if (tool!==undefined && pending) return;
  if (typeof next==='number' && !unlocked(data,next)) return;
  clearDraft();
  catalogTool=fromCatalog;
  if (fromCatalog) draft.dataset.catalog='true';
  tool=next; anchors=anchor>=0?[anchor]:[]; direction=0; verticalFirst=false;
  beltStarted=!fromCatalog && plainBelt(next) && anchor>=0;
  if (anchor>=0 && typeof tool==='number' && isTransport(tool) && isTransport(cell(data,anchor,Field.Kind))) {
    direction=cell(data,anchor,Field.Direction);
  }
  inspectingTile=false;
  mode=!fromCatalog && (next==='wire' || next==='cut') ? 'power' : 'build';
  closeInfo(); canvas.dataset.tool='active';
  if (!fromCatalog) setPanel(false);
  updateDraft(); refresh();
}

function badPlacement(tile:number,kind:number,dir=0) {
  if (tile<0) return true;
  if (kind && !unlocked(data,kind)) return true;
  for (const place of footprint(tile,kind,dir)) {
    const [x,y]=xy(place);
    if (place<0 || !inBounds(limits,x,y) || kind && occupiedKind(data,place)) return true;
    if (kind && place!==tile && CITY.some((_,i)=>cityValue(data,i,CityField.Site)===place)) return true;
  }
  if (kind===Kind.SimpleMiner) return cell(data,tile,Field.Ore)!==1;
  const site=CITY.findIndex((_,i)=>cityValue(data,i,CityField.Site)===tile);
  if (kind===Kind.Station || site>=0) return kind!==Kind.Station || site<0 || site>=visibleCities();
  if (drillTool(kind)) {
    const variant=drillVariant(data,tile,kind);
    return !variant || !unlocked(data,variant.kind);
  }
  return false;
}

function transportDraft(result:Draft) {
  const words=result.cells.flatMap(({tile,kind,dir})=>[tile,kind,dir]);
  if (!words.length) return result;
  const revision=layoutRevision(data);
  const key=`${revision}:${data[Meta.Unlocked]}:${words.join(',')}`;
  const changed=transportPreview?.key!==key;
  const cargoKey=result.cells.map(({tile})=>Number(!!cargoAt(data,tile,0))+2*Number(!!cargoAt(data,tile,1))).join('');
  if (changed || cargoKey!==transportPreview?.cargoKey) {
    const queued=!changed && confirmTransport===transportPreview?.request;
    transportPreview={key,request:++previewSequence,cargoKey};
    confirmTransport=queued?previewSequence:0;
    worker.postMessage({type:'transport-preview',request:previewSequence,words});
  }
  const check=transportPreview?.result;
  if (!check || check[2]!==revision) { result.label='正在检查端口与在途货物'; return result; }
  if (check[0]<0 && check[0]!==-4) {
    result.conflict=true; result.label=ERRORS[check[0]];
    for (const part of result.cells) part.conflict=check[1]<0 || check[1]===part.tile;
    return result;
  }
  for (let i=3;i<check.length;i+=2) result.materials.push({item:check[i],count:check[i+1]});
  result.command={op:Op.BuildTransport,a:revision,words};
  return result;
}

function selectStamp(id=0) {
  const entry=blueprintById(id);
  if (!entry || !data[Meta.FirstLight]) return;
  stamping={id:entry.id,version:entry.version}; buildTab='blueprints';
  const preferred=[at(28,28),at(38,26),at(47,21),at(27,5),at(4,28),at(41,18)];
  const target=id===0 ? preferred.find(tile=>entry.parts.every(([dx,dy,kind])=>!badPlacement(tile+dx+W*dy,kind))) ?? -1 : -1;
  if (target>=0) renderer?.camera.focus(target+2);
  choose('stamp',target);
}

function activeToolText() {
  if (typeof tool==='number') return machineText(tool).name;
  return ({wire:'铺电缆',stamp:activeBlueprint()?.name ?? '蓝图',capture:'框选蓝图',remove:'拆除设备',cut:'拆除电缆','valley-line':'谷东班线','highland-line':'西岭班线'} as const)[tool ?? 'wire'];
}

function createDraft():Draft {
  const result:Draft={cells:[],materials:[],label:'',conflict:false};
  const last=anchors.at(-1) ?? -1;
  if (tool===undefined) return result;
  if (tool==='valley-line' || tool==='highland-line') {
    const city=tool==='valley-line'?1:2;
    const sites=[CityField.Sender,CityField.Receiver].map(f=>cityValue(data,city,f));
    result.cells=sites.map(tile=>({tile,kind:Kind.Yard,dir:0,conflict:Boolean(occupiedKind(data,tile))}));
    result.conflict=result.cells.some(c=>c.conflict);
    result.materials=buildMaterials(Kind.Yard); result.label='两端各建一座站场 · 每班 '+data[Meta.CrateSize]+' 件';
    result.command={op:Op.OpenLine,a:city}; return result;
  }
  if (plainBelt(tool)) {
    const {cells,terminal,conflict}=projectBeltPath(data,anchors,Number(tool),direction,beltFacing);
    result.cells=cells; result.conflict=conflict;
    result.label=pathMessage || (conflict?'路径与端口或交叉条件不符':last<0?'点地图选起点':
      !beltStarted?'再点虚影选定起点':terminal>=0?'再点接入设备确认':'可继续选点，再点终点确认');
    if (!conflict) transportDraft(result);
    if (terminal>=0 || last>=0 && !cells.length) {
      result.cells.push({tile:last,kind:0,dir:0,conflict:result.conflict});
    }
    return result;
  }
  if (tool==='wire') {
    result.label=anchors.length?'可继续点转折或确认':'点起点，再点终点';
    const tiles=orthogonal(anchors,verticalFirst);
    const duplicate=new Set(tiles).size!==tiles.length;
    const words:number[]=[];
    let newTiles=0;
    for (const [i,tile] of tiles.entries()) {
      const next=tiles[i+1], prev=tiles[i-1];
      let dir=direction;
      const from=next===undefined ? prev : tile, to=next??tile;
      if (from!==undefined && from!==to) {
        const [x,y]=xy(from),[nx,ny]=xy(to);
        const found=STEP.findIndex(([dx,dy])=>dx===nx-x && dy===ny-y);
        if (found>=0) dir=found;
      }
      const conflict=duplicate;
      result.cells.push({tile,dir,kind:0,wire:true,conflict});
      result.conflict ||= conflict;
      if (!cell(data,tile,Field.Wire)) newTiles++;
      words.push(tile,dir);
    }
    const entry=design(Kind.Cable);
    if (entry && newTiles) result.materials=entry.materials.map(({item,count})=>({item,count:count*Math.ceil(newTiles/entry.span)}));
    if (words.length) result.command={op:Op.Route,a:1,words};
    return result;
  }
  if (tool==='stamp') {
    const entry=activeBlueprint();
    if (!entry) { result.conflict=true; result.label='蓝图已删除或布局版本已变化'; return result; }
    result.materials=[entry.material];
    result.label='选择部署锚点';
    if (last<0) return result;
    const [x,y]=xy(last);
    const ores=new Set<number>();
    const occupied=new Set<number>();
    for (const [dx,dy,kind,facing,wire] of entry.parts) {
      const [rx,ry,dir]=rotatePart(dx,dy,kind,facing,direction);
      const tile=at(x+rx,y+ry);
      let conflict=badPlacement(tile,kind,dir);
      if (kind && tile>=0) for (const place of footprint(tile,kind,dir)) {
        if (occupied.has(place)) conflict=true;
        occupied.add(place);
      }
      const variant=drillTool(kind) && tile>=0?drillVariant(data,tile,kind):undefined;
      if (variant) ores.add(variant.output);
      const previewKind=variant?.kind ?? kind;
      result.cells.push({tile,kind:previewKind,dir,wire:Boolean(wire),conflict}); result.conflict ||= conflict;
    }
    result.label=result.conflict?'部分格与设备、地形或矿种冲突':ores.size?`部署厂段 · 采出 ${[...ores].map(ore=>ITEM[ore]).join('、')}`:'确认部署位置';
    result.command={op:Op.Blueprint,a:last,b:entry.id,c:entry.version,words:[direction]};
    return result;
  }
  if (tool==='capture') {
    result.label=anchors.length===1?'点矩形的另一角':'点选两个对角格，记录建造布局';
    if (anchors.length===2) {
      const [ax,ay]=xy(anchors[0]),[bx,by]=xy(anchors[1]);
      const area=(Math.abs(ax-bx)+1)*(Math.abs(ay-by)+1);
      result.cells=[anchors[0],anchors[1],at(ax,by),at(bx,ay)].map(tile=>({tile,kind:0,dir:0}));
      result.capture=area<=250;
      result.conflict=!result.capture;
      result.label=result.capture?`已框选 ${area} 格`:'蓝图范围上限为 250 格';
    } else if (last>=0) result.cells=[{tile:last,kind:0,dir:0}];
    return result;
  }
  if (tool==='remove' || tool==='cut') {
    result.label='点选要拆除的格子';
    if (last>=0) {
      const wire=tool==='cut',anchor=wire?last:machineAnchor(data,last);
      const kind=anchor>=0?cell(data,anchor,Field.Kind):0;
      result.conflict=wire?!cell(data,last,Field.Wire):!kind || [Kind.Station,Kind.Yard].includes(kind);
      const tiles=wire || anchor<0?[last]:[...footprint(anchor,kind,cell(data,anchor,Field.Direction))];
      result.cells=tiles.map(tile=>({tile,kind:0,dir:0,wire,conflict:true}));
      result.command={op:Op.Remove,a:last,b:Number(wire)};
      result.label=`拆除 ${wire?'电缆':machineText(kind).name} · ${coordinates(last)}`;
    }
    return result;
  }
  result.label=last<0?'点地图选址':'再点虚影建造，长按拖动转向';
  if (typeof tool==='number' && isTransport(tool)) {
    if (last>=0) result.cells=[{tile:last,kind:tool,dir:direction}];
    return transportDraft(result);
  }
  result.materials=buildMaterials(tool);
  if (last>=0) {
    result.conflict=badPlacement(last,tool,direction);
    const variant=drillTool(tool)?drillVariant(data,last,tool):undefined;
    if (drillTool(tool)) {
      const reason=occupiedKind(data,last)?'目标格已占用':variant && result.conflict?'占地或矿种不符合要求':'';
      result.label=variant
        ? `${ITEM[variant.output]} · ${(variant.amount*HZ/variant.ticks).toFixed(2)} 件/秒 · ${mw(variant.demand)}${reason?' · '+reason:''}`
        : reason || '选择一处已开放的矿脉';
    }
    result.cells=[{tile:last,kind:variant?.kind ?? tool,dir:direction,conflict:result.conflict}];
    result.command={op:Op.Place,a:last,b:tool,c:direction};
  }
  return result;
}

function updateDraft() {
  if (tool===undefined) return;
  ghost=createDraft();
  const cannotPay=!affordable(ghost.materials);
  const info=ghost.conflict && !(typeof tool==='number' && drillTool(tool)) && tool!=='capture' && tool!=='stamp' && !(typeof tool==='number' && isTransport(tool))
    ? '目标被占用、路线重叠或矿点不匹配' : ghost.label;
  const cost=ghost.materials.map(({item,count})=>` <span class="inline-cost${held(data,item)<count?' missing':''}" aria-label="${textHtml(ITEM[item])} ${held(data,item)} / ${count}">${itemIcon(item)}${held(data,item)} / ${count}</span>`).join('');
  const canConfirm=Boolean(ghost.command || ghost.capture) && !ghost.conflict && !cannotPay && !pending;
  draft.hidden=false;
  const html=`<div class="draft-text"><strong>${textHtml(activeToolText())}${cost}</strong> · ${textHtml(info)}${cannotPay?' · '+textHtml(t('ui.unavailable')):''}</div>`+
    (tool==='wire' && anchors.length>1?button('换弯','turn-path'):'')+
    ((tool==='wire' || plainBelt(tool)) && anchors.length>1?button('退一步','back-path'):'')+
    (canRotateDraft()?iconButton('旋转','rotate-draft','rotate'):'')+
    button('取消','cancel-draft')+button(tool===Kind.SimpleMiner?'安放':tool==='capture'?'保存蓝图':'确认','confirm-draft',true,!canConfirm);
  if (draft.innerHTML!==html) draft.innerHTML=html;
}

function canRotateDraft() {
  return tool==='stamp' || typeof tool==='number';
}

function rotateAt(tile:number,heading:number) {
  if (!canRotateDraft() || pending) return;
  if (anchors.at(-1)===tile && direction===heading && (!plainBelt(tool) || beltFacing)) return;
  if (plainBelt(tool)) {
    const index=anchors.lastIndexOf(tile);
    if (index>=0) anchors=anchors.slice(0,index+1);
    else if (anchors.length || tile<0) return;
    else anchors=[tile];
    beltFacing=true; pathMessage='';
  } else if (!anchors.length && tile>=0) anchors=[tile];
  direction=heading; confirmTransport=0;
  updateDraft();
}

function rotateDraft(tile=-1,step=1) {
  const last=anchors.at(-1) ?? tile;
  const anchor=plainBelt(tool) && ghost.cells.some(part=>part.tile===tile && part.kind)?tile:last;
  const end=plainBelt(tool)?ghost.cells.find(part=>part.tile===anchor && part.kind):undefined;
  if (plainBelt(tool) && anchors.length>1 && !end) return;
  rotateAt(anchor,((end?.dir ?? direction)+step+4)%4);
}

function extendBelt(tile:number) {
  const prefix=beltTerminal(data,anchors)>=0?anchors.slice(0,-1):anchors;
  const suffix=findBeltPath(data,limits,prefix,tile,beltFacing?direction:undefined);
  if (!suffix) {
    pathMessage='到该格没有可铺设的路线';
    say(pathMessage,true);
    return false;
  }
  anchors=[...prefix,...suffix]; beltFacing=false;
  return true;
}

function tapBelt(tile:number) {
  const last=anchors.at(-1);
  pathMessage='';
  if (!beltStarted) {
    confirmTransport=0;
    if (tile===last) beltStarted=true;
    else {
      anchors=[tile]; beltFacing=false;
      direction=isTransport(cell(data,tile,Field.Kind))?cell(data,tile,Field.Direction):0;
    }
  } else if (tile===last) {
    confirmDraft(); return;
  } else {
    confirmTransport=0;
    const index=anchors.lastIndexOf(tile);
    if (index>=0) { anchors=anchors.slice(0,index+1); beltFacing=false; }
    else extendBelt(tile);
  }
  updateDraft();
}

function startPathDrag(tile:number) {
  if (pending || !plainBelt(tool) && tool!=='wire') return false;
  confirmTransport=0;
  dragOrigin={anchors,started:beltStarted,facing:beltFacing,direction,message:pathMessage};
  pathMessage='';
  if (tool==='wire' || !beltStarted || !anchors.length) {
    if (anchors.at(-1)!==tile) beltFacing=false;
    anchors=[tile];
  } else {
    const index=anchors.lastIndexOf(tile);
    if (index>=0) {
      if (index!==anchors.length-1) beltFacing=false;
      anchors=anchors.slice(0,index+1);
    } else if (!extendBelt(tile)) { dragOrigin=undefined; updateDraft(); return false; }
  }
  beltStarted=true;
  return true;
}

function drawPath(from:number,to:number) {
  if (!dragOrigin || pending) return;
  if (plainBelt(tool)) {
    for (const tile of dragTiles(from,to)) {
      if (anchors.at(-2)===tile) anchors.pop();
      else anchors.push(tile);
    }
    beltFacing=false;
  } else if (tool==='wire') {
    const start=anchors[0];
    anchors=start===to?[start]:[start,to];
  }
  updateDraft();
}

function finishPathDrag(keep:boolean) {
  const prior=dragOrigin;
  dragOrigin=undefined;
  if (!prior) return;
  if (keep) {
    const detour=plainBelt(tool)?detourLockedCrossing(data,limits,anchors):undefined;
    if (detour) { anchors=detour; updateDraft(); }
    return;
  }
  anchors=prior.anchors; beltStarted=prior.started; beltFacing=prior.facing;
  direction=prior.direction; pathMessage=prior.message;
  updateDraft();
}

function tap(tile:number) {
  if (!ready) return;
  if (tool!==undefined) {
    if (pending) return;
    if (plainBelt(tool)) { tapBelt(tile); return; }
    if (typeof tool==='number' && overlapsDraft(tile) || catalogTool && tool==='wire' && anchors.at(-1)===tile) {
      confirmDraft(); return;
    }
    confirmTransport=0;
    if (typeof tool==='number' && isTransport(tool) && !anchors.length && isTransport(cell(data,tile,Field.Kind))) {
      direction=cell(data,tile,Field.Direction);
    }
    if (tool==='wire') {
      if (anchors.at(-1)!==tile) anchors.push(tile);
    } else if (tool==='capture') {
      if (anchors.length===2) anchors=[];
      anchors.push(tile);
    } else anchors=[tile];
    updateDraft(); return;
  }
  const anchor=machineAnchor(data,tile);
  if (anchor>=0) tile=anchor;
  if (renderer && renderer.camera.zoom<13) {
    const cam=renderer.camera;
    cam.aim(cam.x,cam.y,19);
  }
  guideOpen=false;
  selected=tile;
  manualWork=false;
  inspectingTile=!!cell(data,tile,Field.Kind) || (mode!=='build' && !!cell(data,tile,Field.Ore));
  focus=-1; traced=[]; setPanel(true); refresh();
  inspectMap(tile,true);
}

function overlapsDraft(tile:number) {
  return ghost.cells.some(part=>part.kind && part.tile>=0 && [...footprint(part.tile,part.kind,part.dir)].includes(tile));
}

function submit(command:Command,done?:(result:number)=>void,failed?:(status:number)=>void) {
  if (!ready || pending) return false;
  pending=done ?? (()=>{});
  pendingFailure=failed;
  worker.postMessage({type:'command',data:command});
  return true;
}

function confirmDraft() {
  if (tool===undefined || pending) return;
  const plan=createDraft();
  if (plan.conflict || !affordable(plan.materials)) return;
  if (tool==='capture' && plan.capture) { editBlueprint('capture'); return; }
  if (!plan.command) {
    if (transportPreview && !transportPreview.result && plan.cells.some(part=>isTransport(part.kind))) {
      confirmTransport=transportPreview.request;
    }
    return;
  }
  const keepCatalog=catalogTool, isStamp=tool==='stamp';
  confirmTransport=0;
  if (submit(plan.command,()=>{
    focus=-1;
    clearDraft(); mode=isStamp||keepCatalog?'build':'view'; inspectingTile=false;
    if (!keepCatalog) setPanel(true);
    refresh();
  })) updateDraft();
}

function gatherAt(tile:number) {
  const ore=cell(data,tile,Field.Ore);
  return submit({op:Op.Gather,a:tile},()=>{
    gain.textContent=ITEM[ore]+' +1'; gainTile=tile; gainUntil=performance.now()+750;
  });
}

function handcraftPanel() {
  return handOptions().map(({key,inputs,output,ticks})=>{
  const missing=!hasHandcraftMaterial(key), expanded=handcraftExpanded===key;
  return `<section class="handcraft-recipe" data-missing="${missing}">
    <button type="button" class="recipe-heading" data-action="toggle-handcraft-${key}" aria-expanded="${expanded}" aria-controls="handcraft-details-${key}">
      ${itemIcon(output.item)}<span>${textHtml(ITEM[output.item])} ×${output.amount}</span><span class="recipe-disclosure" aria-hidden="true"></span>
    </button>
    <div class="recipe-details" id="handcraft-details-${key}"${expanded?'':' hidden'}>
      <span class="slot-label">${textHtml(t('ui.requiredMaterials'))} · ${ticks/HZ} s</span>
      ${inputs.map(({item,amount})=>`<div class="requirement${held(data,item)<amount?' missing':''}">${itemIcon(item)}<span>${textHtml(ITEM[item])} ×${amount}</span></div>`).join('')}
      ${holdButton(t('ui.holdCraft'),'data-handcraft',key,missing)}
    </div>
  </section>`;
  }).join('');
}

function inspectors() {
  if (guideOpen) return ['',t('ui.guide'),(Object.keys(handbook) as (keyof typeof handbook)[]).filter(
    id=>visibleGuide(data,id)).map(id=>guideEntry(id,true)).join(''),button(t('ui.guideReturn'),'close-guide')];
  if (mode==='view' && manualWork) {
    return [t('ui.operations'),t('ui.handcraft'),handcraftPanel()];
  }
  if (mode==='view' || (inspectingTile && tool===undefined)) {
    const kind=selected<0?0:cell(data,selected,Field.Kind);
    if (kind===Kind.Station) return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
    if (kind===Kind.Yard) return yardPanel();
    if (kind) return devicePanel(kind);
    if (selected>=0 && cell(data,selected,Field.Ore)) return [t('ui.oreDeposit'),ITEM[cell(data,selected,Field.Ore)],actions(harvestButton(selected))];
  }
  if (mode==='orbit') return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
  if (mode==='power') return powerPanel();
  if (mode==='build') return buildPanel();
  if (mode==='view') return ['操作','选择设备','<p class="lead">点地图上的设备、矿点或输送带。</p>'];
  return missionPanel();
}

function guideEntry(id:keyof typeof handbook,collapsible=false) {
  const {title,steps}=guideText(id);
  const list=`<ol>${steps.map(step=>`<li>${textHtml(step)}</li>`).join('')}</ol>`;
  return collapsible?`<details class="guide-entry" data-guide="${id}"><summary>${textHtml(title)}</summary>${list}</details>`:
    `<section class="guide-entry" data-guide="${id}"><h3>${textHtml(title)}</h3>${list}</section>`;
}

function missionPanel() {
  if (data[Meta.Stage]>=Stage.Valley) return regionalMission();
  if (data[Meta.Stage]<Stage.Sunlight) {
    const {title,detail,progress,guides}=campaignTask(data);
    return [t('ui.activeTask'),title,`<p class="lead">${textHtml(detail)}</p>`+
      (progress?readings([[t('ui.taskProgress'),progress]]):'')+guides.map(id=>guideEntry(id)).join('')];
  }
  const legacy=legacyRecipes(data);
  const kitMachine=legacy?Kind.KitPress:Kind.Splicer;
  if (!data[Meta.KitTotal] && firstMachine(data,kitMachine)<0) {
    const detail=legacy?'给套件装配机供应结构件，并把产物送进建造仓。':
      '在拼接站选择标准设备套件，送入框架、电枢和结构件。用短带把套件交给建造仓。';
    return ['曙港 · 扩建','做出第一套扩建设备',`<p class="lead">${detail}</p>`];
  }
  const blocks=data[Meta.RequiredBlocks], kits=data[Meta.RequiredKits], seconds=data[Meta.DeliverySeconds];
  const deliveries:[string,string][]=[];
  for (let tile=0;tile<W*H;tile++) {
    if (cell(data,tile,Field.Kind)!==kitMachine) continue;
    const status=!cell(data,tile,Field.Grid)?'未接线':cell(data,tile,Field.DeliveringKits)?'已交付':'等待交付';
    deliveries.push([`${deviceName(kitMachine)} · ${coordinates(tile)}`,status]);
  }
  return ['任务通讯','扩建四条厂段',
    `<p class="lead">在「建造 → 蓝图」部署厂段，接通原料和电网。最近 ${seconds} 秒内需有 ${blocks} 台设备各交付新套件，全厂累计到仓 ${kits} 套。</p>`+
    readings([['近期交付厂段',`${data[Meta.Blocks]} / ${blocks}`],['新制套件累计到仓',`${data[Meta.KitTotal]} / ${kits}`],...deliveries])+
    bar(data[Meta.Blocks],blocks)];
}

function visibleCities() {
  return data[Meta.Stage]>=Stage.Highland?3:data[Meta.Stage]>=Stage.Valley?2:1;
}
function regionalMission():string[] {
  const stage=data[Meta.Stage];
  const city=stage===Stage.Valley?1:2;
  const v=(f:CityField)=>cityValue(data,city,f);
  const name=CITY[city], site=v(CityField.Site);
  const task=(title:string,detail:string,progress?:string)=>['当前任务',title,
    '<p class="lead">'+detail+'</p>'+(progress?readings([['任务进度',progress]]):'')];
  if (stage===Stage.Victory) return task('三座城迎来了日出','连续三轮照明已完成，各站备好了下一轮的校准芯与储能。你可以继续扩建工厂。','3 / 3');
  if (stage===Stage.Acceptance) return task('让三城连续运转','在「轨道」安排曙港、谷东、西岭连续照明。末轮收束时，每座站都要留足下一轮的准备量。',`${data[Meta.Rounds]} / 3`);
  if (cell(data,v(CityField.Sender),Field.Kind)!==Kind.Yard)
    return task('给'+name+'开通班线','从「建造」开通跨谷班线，再把第一箱物料送过山谷。',`${held(data,4)} / ${data[Meta.LineCost]} 结构件`);
  if (cell(data,site,Field.Kind)!==Kind.Station) return task('在'+name+'接货','到货站已经就位。从「建造」安放当地地面站，准备接收校准芯。');
  if (!v(CityField.Delivered)) return task('让第一箱货抵达'+name,'在曙港发货站装入校准芯。到货后，由当地的短带把货送出站场。','0 / 1');
  if (!cell(data,site,Field.Grid)) return task('给'+name+'地面站供电','把当地地面站接上电网，或用本地发电机为它供电。');
  if (data[Meta.Modules]<=city) return task('把镜阵延伸到'+name,'在曙港备好三个镜阵模块和五份燃料，从「轨道」为这座城增发一组镜阵。',`${data[Meta.Modules]} / ${city+1}`);
  return task(city===1?'点亮谷东':'连续点亮谷东与西岭',city===1?'校准芯到站后，在「轨道」发起第一场跨谷照明。':'从「轨道」安排相邻窗口。谷东窗口结束三秒后，西岭接班。');
}

function yardPanel():string[] {
  const city=CITY.findIndex((_,n)=>n>0 && [CityField.Sender,CityField.Receiver].some(field=>cityValue(data,n,field)===selected));
  const v=(field:CityField)=>cityValue(data,city,field);
  const sending=selected===v(CityField.Sender);
  return ['跨谷班线 · '+CITY[city],sending?'曙港发货站':CITY[city]+'到货站',
    '<p class="lead">'+(sending?'将物料带接入本站，或把手中物料装箱。':'把当地输送带接到出料箭头上，通向地面站或加工设备。')+'</p>'+
    readings([['距下班发车',time(data[Meta.Headway]-data[Meta.Tick]%data[Meta.Headway])],['每班容量',data[Meta.CrateSize]+' 件'],['单程',time(data[Meta.Travel])],
      ['在途或卸货',v(CityField.InTransit)+' 件'],['当地已接收',v(CityField.Delivered)+' 件']])+
    readings(machineLayoutRows(selected,Kind.Yard))+machineSlots(selected,Kind.Yard)+
    actions(sending?'':button('预览末端短带','lastmile-'+city,true),
      sending?button('查看到货站','receiver-'+city):iconButton('旋转出料口','rotate-device','rotate'),button('任务进度','mission'))];
}

function regionalPanel():string[] {
  const cities=CITY.slice(0,visibleCities());
  const city=Math.max(0,cities.findIndex((_,n)=>cityValue(data,n,CityField.Site)===selected));
  const site=cityValue(data,city,CityField.Site), phase=data[Meta.Window], busy=phase===1 || phase===2;
  const fault=data[Meta.Fault], target=data[Meta.TargetCity];
  const active= data[Meta.Launch]?'发射中 · '+time(data[Meta.Launch]):
    busy?CITY[target]+(phase===1?'窗口倒计时 · ':'跟踪中 · ')+time(data[Meta.WindowTicks]):
    phase===4?CITY[data[Meta.FaultCity]]+' · '+['','供电中断','校准芯断供','下一轮准备量不足'][fault]+' · '+time(data[Meta.FaultAt]):'等待调度';
  const rows:(readonly [string,string|number])[]=[];
  let reserves='';
  let start=0;
  for (const [n,name] of cities.entries()) {
    const v=(f:CityField)=>cityValue(data,n,f);
    const end=start+v(CityField.Duration);
    const interval=data[Meta.Stage]>=Stage.Acceptance?time(start)+'–'+time(end):time(v(CityField.Duration));
    rows.push([name+'窗口',interval+' · '+mw(v(CityField.Power))+' · 1 芯/秒']);
    reserves+=slotRow(name+'校准芯',itemSlot('display',6,contents(data,v(CityField.Site),6),v(CityField.Site),
      data[Meta.Stage]>=Stage.Acceptance?`下一轮准备 ${v(CityField.CoreReserve)} 枚`:''));
    if (data[Meta.Stage]>=Stage.Acceptance) rows.push([name+'所在电网储能', energyMj(v(CityField.Stored)).toFixed(1)+' / '+energyMj(v(CityField.EnergyReserve)).toFixed(1)+' MJ']);
    start=end+v(CityField.Gap);
  }
  const launch=city===0 && data[Meta.Modules]<cities.length;
  const trialBlocked=busy || Boolean(data[Meta.Launch]);
  return ['轨道调度',CITY[city]+'地面站',signal(active,phase===4)+
    (data[Meta.Stage]>=Stage.Acceptance?signal('三城连续轮次 '+data[Meta.Rounds]+' / 3 · 从曙港照明起算，每 '+time(start)+' 一轮。同一电网承担的各站准备量相加。'):'')+
    actions(data[Meta.Stage]>=Stage.Acceptance?button('启动三轮验收','window-0-2',true,trialBlocked):'',
      data[Meta.Stage]===Stage.Highland?button('排定谷东与西岭相邻窗口','window-1-1',true,trialBlocked || data[Meta.Modules]<3):'',
      phase===4?button('复演'+CITY[data[Meta.FaultCity]]+'窗口','window-'+data[Meta.FaultCity]+'-0',true):'',
      button('单站试照 · '+CITY[city],'window-'+city+'-0',city>0,trialBlocked || data[Meta.Modules]<=city),
      launch?button('增发镜阵','launch',true,trialBlocked || data[Meta.Mirrors]<3 || data[Meta.Fuel]<5):'')+
    machineSlots(site,Kind.Station)+reserves+readings([...machineLayoutRows(site,Kind.Station),...rows,...devicePower(data,site,Kind.Station)])+
    actions(...cities.map((name,n)=>button(name+'地面站','site-'+n)),...(city>0?[button('发货站','sender-'+city),button('到货站','receiver-'+city)]:[]),button('查看电网','power-map'),button('任务进度','mission'))];
}

function orbitPanel() {
  const phase=data[Meta.Window], fault=data[Meta.Fault], inOrbit=Boolean(data[Meta.Orbit]);
  const dispatch=data[Meta.Generation]+data[Meta.Discharge];
  const launch=data[Meta.Launch], canLaunch=data[Meta.Mirrors]>=3 && data[Meta.Fuel]>=5;
  const label=launch?`发射进行中 · ${time(launch)}`:phase===1?`窗口倒计时 · ${time(data[Meta.WindowTicks])}`:
    phase===2?`照明跟踪中 · ${time(data[Meta.WindowTicks])}`:phase===4?`试照失败 · ${time(data[Meta.FaultAt])} ${fault===1?'供电中断':'校准芯断供'}`:
    data[Meta.FirstLight]?`曙港已见光${data[Meta.NextWindow]?` · 下次 ${time(data[Meta.NextWindow])}`:''}`:inOrbit?'试验镜已入轨':'等待试验镜发射';
  const nextButton=!inOrbit ? button(launch?'发射进行中':'发射试验镜','launch',true,!canLaunch||Boolean(launch)) :
    button(phase===4?'复演窗口':'开始试照','trial',true,phase===1||phase===2);
  return ['轨道控制台','曙港地面站',signal(label,phase===4)+
    actions(nextButton,button('查看电网','power-map'))+
    machineSlots(STATION,Kind.Station)+readings([...machineLayoutRows(STATION,Kind.Station),...devicePower(data,STATION,Kind.Station)])+
    readings([['主网当前可给',mw(dispatch)]])+
    (inOrbit?readings([['试照需求','24 秒 · 12 MW'],['运行耗料','1 枚 / 秒']]):'')+
    (phase===2?bar(24*HZ-data[Meta.WindowTicks],24*HZ):'')+
    (inOrbit&&!data[Meta.FirstLight] ? `<p class="lead">为蓄电池留出充电时间。地面站的进料带须在整个窗口持续补给。</p>`:'')+
    actions(button('任务进度','mission'))];
}

function powerPanel() {
  const origin=selected>=0?selected:unlocked(data,Kind.Station)?STATION:firstMachine(data,Kind.Generator);
  const group=origin>=0?cell(data,origin,Field.Grid):0;
  const faults:number[]=[];
  for (let i=0;i<W*H && faults.length<5;i++) {
    if (cell(data,i,Field.Status)===3 && (group===0 || cell(data,i,Field.Grid)===group)) faults.push(i);
  }
  const index=HEADER+W*H*STRIDE+group*4;
  const rows:[string,string][]=[['当前发电',mw(data[index])],['请求负荷',mw(data[index+1])]];
  if (unlocked(data,Kind.Battery)) rows.push(['电池可放电',mw(data[index+2])],['已储能',Math.floor(energyMj(data[index+3]))+' MJ']);
  const details=group?readings(rows):signal('所选格未接通电缆',true);
  return ['电网诊断',group?'供电区 '+group:'接线检查',details+
    actions(iconButton('铺电缆','wire','cable'),unlocked(data,Kind.Battery)?button('预览蓄电池','battery'):'',button('拆电缆','cut'))+
    (faults.length ? `<div class="fault-list">${faults.map(i=>`<button type="button" class="button" data-fault="${i}">${textHtml(MACHINE[cell(data,i,Field.Kind)].name)}<small>${coordinates(i)} · 缺电</small></button>`).join('')}</div>`:'')+
    actions(unlocked(data,Kind.Station)?button('地面站','station'):'',button('任务进度','mission'))];
}

function machineSlots(tile:number,kind:Kind) {
  if (tile<0 || cell(data,tile,Field.Kind)!==kind) return '';
  const slots=deviceAt(data,tile)?.slots ?? [];
  return slotRow(kind===Kind.Yard?'装箱':'进料',slots.filter(slot=>slot.role==='input').map(slot=>machineSlot(tile,slot)).join(''))+
    slotRow(kind===Kind.Yard?'到货':'出料',slots.filter(slot=>slot.role==='output').map(slot=>machineSlot(tile,slot)).join(''))+
    slotRow('速度模块',slots.filter(slot=>slot.role==='module').map(slot=>machineSlot(tile,slot)).join(''));
}

function machineSlot(tile:number,slot:SlotData) { return itemSlot(slot.role,slot.item,slot.count,tile,'',slot); }

function transportReadout(tile:number,kind:Kind,interactive=false) {
  const entry=design(kind);
  if (!entry?.lanes) return '';
  const dir=cell(data,tile,Field.Direction);
  const rows:string[]=[];
  for (let lane=0;lane<entry.lanes;lane++) {
    const {incoming,outgoing}=transportPorts(kind,dir,lane);
    const sides=(mask:number,offset=0)=>DIRECTION.filter((_,i)=>mask&(1<<((i+offset)%4))).join('、');
    const cargo=cargoAt(data,tile,lane);
    const name=entry.lanes===1?'通道':lane===0?'主通道':'交叉通道';
    const flow=`${sides(incoming,2)}入 · ${sides(outgoing)}出`;
    const status=cargo?.blocked?'堵塞':cargo?'在途':'空闲';
    rows.push(readings([[name,flow],[status,`${cargo?ITEM[cargo.item]+' ':''}${cargo?1:0} / ${entry.laneCapacity}`]])+
      (interactive && cargo?slotRow('带上货物',itemSlot('cargo',cargo.item,1,tile,`${name} · ${flow}`,undefined,cargo)+
        `<button type="button" class="button" data-action="take-cargo" data-tile="${tile}" data-lane="${lane}" data-item="${cargo.item}" data-cargo-id="${cargo.id}" data-identity="${cargo.identity}" aria-label="从${name}取走${textHtml(ITEM[cargo.item])}">取走</button>`):''));
  }
  return rows.join('');
}

function transportRating(kind:number) {
  const entry=design(kind);
  return entry?.interval?`${entry.interval<0?-entry.interval:content.contentHz/entry.interval*60} 件/分钟/通道 · ${entry.lanes} 条通道`:'';
}

function modeAvailable(next:Mode) {
  if (next==='power') return unlocked(data,Kind.Cable);
  return data[Meta.Stage]>=({task:Stage.Gather,view:Stage.Gather,build:Stage.Gather,guide:Stage.Gather,power:Stage.Power,orbit:Stage.Launch})[next];
}

function deviceName(kind:number) {
  const grade=design(kind)?.grade;
  return machineText(grade===3?Kind.ReinforcedMiner:grade===2?Kind.IndustrialMiner:kind).name;
}

function machineText(kind:number) {
  const current=MACHINE[kind];
  if (legacyRecipes(data)) return current;
  const id=content.machines[kind]?.id;
  if (kind===Kind.Bench) return {name:t('machines.bench.activeName'),detail:t('machines.bench.activeDescription')};
  if (kind===Kind.ExpressBelt) return {name:current.name,detail:t('machines.fast-belt.description')};
  if ([Kind.Smelter,Kind.Kiln,Kind.Assembler].includes(kind))
    return {name:current.name,detail:t(`machines.${id}.activeDescription`)};
  return current;
}

function machineCycle(tile:number,kind:number) {
  const entry=design(kind);
  const chosen=selectedRecipe(data,tile);
  if (!entry || !chosen && (!entry.ticks || !legacyRecipes(data) && !entry.grade)) return '';
  const hasModule=deviceAt(data,tile)?.slots.some(slot=>slot.role==='module' && slot.count>0);
  const ticks=chosen?.ticks ?? (hasModule?Math.ceil(2*entry.ticks/3):entry.ticks);
  const progress=Math.min(100,Math.round(100*cell(data,tile,Field.Progress)/ticks));
  const label=entry.grade?'采集进度':'生产进度';
  return `<div class="cycle-readout"><div><span>${label}</span><b>${progress}%</b></div>`+
    `<div class="cycle-meter" role="progressbar" aria-label="${label}" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></div>`;
}

function recipePicker(tile:number,kind:number) {
  if (legacyRecipes(data) || !content.machines[kind]?.processing) return '';
  const chosen=selectedRecipe(data,tile);
  const available=content.recipes.filter(row=>row.modern && row.machines.some(id=>id===kind) && row.unlockStage<=data[Meta.Stage]);
  return `<section class="handcraft-recipe recipe-picker"><div class="recipe-details">
    <span class="slot-label">${textHtml(t(chosen?'ui.productionRecipe':'ui.noRecipe'))}</span>
    ${available.map(row=>{
      const price=row.inputs.map(item=>`${ITEM[item.item]} ×${item.amount}`).join(' + ');
      const detail=`${price} → ${ITEM[row.output.item]} ×${row.output.amount} · ${(chosen?.key===row.key?chosen.ticks:row.baseTicks)/HZ} s`;
      const active=chosen?.key===row.key;
      return `<button type="button" class="button${active?' primary':''}" data-action="choose-recipe-${row.key}" aria-pressed="${active}">${textHtml(detail)}</button>`;
    }).join('')}
  </div></section>`;
}

function devicePanel(kind:number) {
  if (kind===Kind.DevelopmentHub) return [`设备检查 · ${coordinates(selected)}`,'阶段交付站',
    readings([...machineLayoutRows(selected,kind),['已完成阶段',limits.tier],['背包占用',t('ui.backpack',{used:limits.used,slots:limits.slots})],['堆叠上限',t('ui.individualStacks')],['时间倍速上限',`${limits.speed}×`],
      ['缩放范围',`${limits.minZoom}–${limits.maxZoom} 像素/格`],['开放地图',`${limits.right-limits.left} × ${limits.bottom-limits.top} 格`]])+
    signal(limits.tier===0?'下一阶段 · 扩大背包与地图范围，开放重载带和强化采矿机。':'当前阶段已开放全部上限。')+
    actions(iconButton('拆除设备','remove','hammer'))];
  const device=machineText(kind), status=cell(data,selected,Field.Status), cfg=cell(data,selected,Field.Config);
  const inventory:(readonly [string,string|number])[]=[];
  const actual=deviceAt(data,selected);
  const group=cell(data,selected,Field.Grid);
  const transport=isTransport(kind);
  if (transport) inventory.push(['额定吞吐',transportRating(kind)]);
  else inventory.push(...machineLayoutRows(selected,kind));
  if (kind===Kind.Depot) inventory.push(['收发设置',cfg?`输出${ITEM[cfg]}`:'收货']);
  if (kind===Kind.Splitter) inventory.push(['分流',cfg?'直行优先':'轮流分配']);
  inventory.push(['方向',DIRECTION[cell(data,selected,Field.Direction)]]);
  if (actual?.grade) {
    const rating=design(kind);
    inventory.push(['矿种',ITEM[actual.ore]]);
    if (rating?.ticks) inventory.push(['采矿速率',`${(rating.amount*HZ/rating.ticks).toFixed(2)} 件/秒`]);
  }
  if (unlocked(data,Kind.Cable) && (design(kind)?.demand || design(kind)?.generation || design(kind)?.batteryPower))
    inventory.push(['供电区',group?`#${group}`:'未连接']);
  const hasPriority=(actual?.grade ?? 0)>=2 || content.machines[kind]?.processing;
  if (hasPriority) inventory.push(['供电顺序',['普通','优先','最高'][cfg]]);
  return [`设备检查 · ${coordinates(selected)}`,deviceName(kind),`<div class="device-summary">${machineIcon(kind)}<p class="lead">${textHtml(device.detail)}</p></div>`+
    (transport?'':signal(STATUS[status],status>=2&&status<=4))+recipePicker(selected,kind)+machineCycle(selected,kind)+readings([...inventory,...devicePower(data,selected,kind)])+
    (transport?transportReadout(selected,kind,true):machineSlots(selected,kind))+
    actions(cell(data,selected,Field.Ore)?harvestButton(selected):'',iconButton('旋转设备','rotate-device','rotate'),
      hasPriority && data[Meta.Stage]>=Stage.Expand?button('切换优先级','configure'):'',
      kind===Kind.Splitter?button('切换分流','configure'):'',
      kind===Kind.Depot && data[Meta.Stage]>=Stage.Expand?button('切换收发','configure'):'',
      kind!==Kind.Generator && kind!==Kind.Battery && kind!==Kind.Solar ? button('沿货流定位','trace-cargo'):'',
      unlocked(data,Kind.Cable)&&!transport?(group?button('查看电网','power-map'):iconButton('接线','wire','cable')):'',
      iconButton('拆除设备','remove','hammer'))+
    actions(button('任务进度','mission'))];
}

function canBuild(kind:number) {
  return Boolean(design(kind)) && unlocked(data,kind) && affordable(buildMaterials(kind));
}

function machineLayoutRows(tile:number,kind:number) {
  const dir=cell(data,tile,Field.Direction), [width,height]=machineSize(kind,dir);
  const rows:[string,string][]=[['占地',`${width} × ${height} 格`]];
  if (cell(data,tile,Field.Kind)!==kind) return rows;
  const incoming:string[]=[], outgoing:string[]=[];
  const labels=new Map<number,string>();
  for (const port of previewPorts(tile,kind,dir,legacyRecipes(data))) {
    if (port.labelKey) labels.set(port.tile*8+port.side+(port.role==='output'?4:0),t(port.labelKey));
  }
  for (const place of footprint(tile,kind,dir)) {
    const masks=machineMasks(data,place);
    for (let side=0;side<4;side++) {
      const edge=`${coordinates(place)} ${DIRECTION[side]}侧`;
      if (masks & (1<<((side+2)%4))) incoming.push([labels.get(place*8+side),edge].filter(Boolean).join(' · '));
      if (masks & (16<<side)) outgoing.push([labels.get(place*8+side+4),edge].filter(Boolean).join(' · '));
    }
  }
  if (incoming.length) rows.push([t('ui.input'),incoming.join(' / ')]);
  if (outgoing.length) rows.push([t('ui.output'),outgoing.join(' / ')]);
  return rows;
}

function materialLines(requirements:Material[]) {
  return requirements.map(({item,count})=>`<p class="requirement${held(data,item)<count?' missing':''}">${itemIcon(item)}<span>${textHtml(ITEM[item])} <b>${held(data,item)} / ${count}</b></span></p>`).join('');
}

function buildCatalog() {
  const groups: [string, Kind[]][]=[
    ['开采',[Kind.SimpleMiner,Kind.IndustrialMiner,Kind.ReinforcedMiner]],
    ['加工',[Kind.Bench,Kind.Smelter,Kind.Grinder,Kind.Calibrator,Kind.Assembler,Kind.KitPress,Kind.Kiln,Kind.Splicer]],
    ['物流',[Kind.Belt,Kind.FastBelt,Kind.ExpressBelt,Kind.UltraBelt,Kind.Splitter,Kind.Merger,Kind.Crossing,Kind.Depot]],
    ['电力',[Kind.Generator,Kind.Battery,Kind.Solar]],
    ['轨道',[Kind.Station]],
    ['发展',[Kind.DevelopmentHub]],
  ];
  const entry=(kind:Kind)=>{
    const {name}=machineText(kind), available=canBuild(kind);
    return `<button class="tool machine-tool" type="button" data-tool="${kind}" data-quick="tool-${kind}" data-unavailable="${!available}" aria-pressed="${tool===kind}"
      aria-label="${textHtml(name)}${available?'':' · '+textHtml(t('ui.unavailable'))}">${machineIcon(kind)}<span>${textHtml(name)}</span></button>`;
  };
  const sections=groups.map(([name,kinds])=>{
    const cable=name==='电力' && unlocked(data,Kind.Cable)
      ? `<button class="tool machine-tool" type="button" data-tool="wire" data-quick="tool-wire" data-unavailable="${!canBuild(Kind.Cable)}" aria-pressed="${tool==='wire'}" aria-label="电缆">${actionIcon('cable')}<span>电缆</span></button>`
      : '';
    const entries=kinds.filter(kind=>unlocked(data,kind)).map(entry).join('')+cable;
    return entries?`<section class="tool-group"><h3>${name}</h3><div class="tool-grid">${entries}</div></section>`:'';
  }).join('');
  return sections;
}

function buildPanel() {
  const tabs=([['catalog','建筑'],['blueprints','蓝图']] as const).map(([id,label])=>
    `<button type="button" class="panel-tab" data-build-tab="${id}" aria-pressed="${buildTab===id}">${label}</button>`).join('');
  if (buildTab==='catalog') {
    const lines=CITY.slice(1,visibleCities()).flatMap((name,index)=>{
      const city=index+1;
      return cell(data,cityValue(data,city,CityField.Sender),Field.Kind)===Kind.Yard?[]:
        [button('开通'+name+'班线 · '+data[Meta.LineCost]+' 结构件','line-'+city,false,held(data,4)<data[Meta.LineCost])];
    });
    return ['建造','建筑目录',buildCatalog()+(lines.length?actions(...lines):''),iconButton('拆除设备','remove-tool','hammer'),tabs];
  }
  if (!data[Meta.FirstLight]) return ['建造','蓝图','<p class="lead">完成曙港首照后开放蓝图。</p>','',tabs];
  const card=(entry:Blueprint)=>`<div class="blueprint-entry"><strong>${textHtml(entry.name)}</strong>`+
    `<p class="lead">${entry.width} × ${entry.height} 格 · ${entry.devices} 台设备</p>`+
    materialLines([entry.material])+actions(button('预览',`preview-blueprint-${entry.id}`,true),
      entry.id?button('重命名',`rename-blueprint-${entry.id}`)+button('删除',`delete-blueprint-${entry.id}`):'')+'</div>';
  const preset=blueprints.filter(entry=>entry.id===0).map(card).join('');
  const saved=blueprints.filter(entry=>entry.id!==0).map(card).join('');
  const content=`<section class="tool-group"><h3>预设</h3>${preset}</section>`+
    `<section class="tool-group"><h3>已保存</h3>${saved || '<p class="lead">尚未保存自定义蓝图。</p>'}</section>`+
    actions(button('框选地图','capture',true));
  return ['建造','蓝图',content,'',tabs];
}

function closeInfo() {
  infoKey=''; infoPinned=false; infoTile=-1; quickInfo.hidden=true;
}

function inspectMap(tile:number,pin=false) {
  const anchor=machineAnchor(data,tile);
  if (anchor>=0) tile=anchor;
  if (!ready || (!pin && infoPinned) || (!pin && tile===infoTile)) return;
  if (tile<0 || tool!==undefined || (!cell(data,tile,Field.Kind) && !cell(data,tile,Field.Ore))) {
    if (infoTile>=0 || pin) closeInfo();
    return;
  }
  infoKey=''; infoTile=tile; infoPinned=pin; syncInfo();
}

function positionInfo(rect:DOMRect,preferLeft=false) {
  quickInfo.hidden=false;
  const width=quickInfo.offsetWidth, height=quickInfo.offsetHeight, gap=8;
  const left=preferLeft && rect.left>=width+2*gap?rect.left-width-gap:rect.left;
  const preferredTop=left<rect.left?rect.top:rect.bottom+gap;
  const top=preferredTop+height>window.innerHeight-gap?rect.top-height-gap:preferredTop;
  quickInfo.style.left=Math.max(gap,Math.min(left,window.innerWidth-width-gap))+'px';
  quickInfo.style.top=Math.max(gap,Math.min(top,window.innerHeight-height-gap))+'px';
}

function quickMachineStock(tile:number,kind:Kind) {
  if (isTransport(kind)) return transportReadout(tile,kind);
  const items=ITEM.slice(1,SPEED_MODULE).flatMap((_,index)=>{
    const item=index+1, count=contents(data,tile,item);
    return count>0?[[item,count]]:[];
  });
  if (!items.length) return '<p>内部无物资</p>';
  return `<div class="quick-stock">${items.map(([item,count])=>
    `<span>${itemIcon(item)}${textHtml(ITEM[item])} <b>${count}</b></span>`).join('')}</div>`;
}

function syncInfo() {
  if (infoTile>=0 && renderer) {
    const kind=cell(data,infoTile,Field.Kind), ore=cell(data,infoTile,Field.Ore);
    if (!kind && !ore) { closeInfo(); return; }
    const html=`<strong>${textHtml(kind?deviceName(kind):ITEM[ore]+'矿点')}</strong>`+
      (kind?(isTransport(kind)?'':`<p>${STATUS[cell(data,infoTile,Field.Status)]}</p>`)+machineCycle(infoTile,kind)+
        quickMachineStock(infoTile,kind)+readings(devicePower(data,infoTile,kind)):'');
    if (quickInfo.innerHTML!==html) quickInfo.innerHTML=html;
    const [x,y]=xy(infoTile), [sx,sy]=renderer.camera.toScreen(x+.5,y+.5);
    const rect=canvas.getBoundingClientRect();
    if (sx<0 || sx>rect.width || sy<0 || sy>rect.height) { closeInfo(); return; }
    quickInfo.classList.remove('interactive');
    quickInfo.setAttribute('role','tooltip');
    quickInfo.removeAttribute('aria-label');
    positionInfo(new DOMRect(rect.left+sx,rect.top+sy,0,8));
    return;
  }
  if (!infoKey) return;
  const anchor=document.querySelector<HTMLButtonElement>(`[data-quick="${infoKey}"]`);
  if (!anchor || !anchor.getClientRects().length || anchor.closest('[inert]')) { closeInfo(); return; }
  let html:string;
  if (anchor.dataset.tool==='wire') {
    const entry=design(Kind.Cable);
    html=`<strong>电缆</strong><p>连接设备与电网。每 ${entry?.span ?? 1} 格新电缆结算一组材料。</p>`+
      materialLines(buildMaterials(Kind.Cable));
  } else if (anchor.dataset.tool) {
    const kind=Number(anchor.dataset.tool);
    const {name,detail}=machineText(kind), requirements=buildMaterials(kind);
    const rating=isTransport(kind)?transportRating(kind):drillTool(kind)?'采矿速率与耗电随落点矿种显示。':designPower(kind);
    const [width,height]=machineSize(kind,0);
    html=`<strong>${textHtml(name)}</strong><p>${textHtml(detail)}</p><p>${rating}</p><p>占地 ${width} × ${height} 格</p>`+
      (requirements.length?materialLines(requirements):'<p>已制作，可直接安放。</p>');
  } else {
    const slot=readSlot(anchor);
    const {role,item,count,canPut,canTake}=slot, cap=Number(anchor.dataset.capacity ?? -1);
    const quantityHint='滚轮或长按后左右滑动可调数量。';
    const take=count?'点选后点持有栏的同种槽位，也可直接拖过去。':'槽位为空。';
    const help:Record<SlotRole,string>={
      held:count?`点选或拖到对应的进料槽。${quantityHint}`:'',
      input:(canPut?(cap>=0 && count>=cap?'进料槽已满。':`可从持有栏送入${ITEM[item]}。`):'由物流设备补给。')+
        (canTake?(count?`可取回尚未投入生产的物资。${take}${quantityHint}`:take):''),
      output:canTake?take+(count?quantityHint:''):'由物流设备取货。',
      module:`安装后，生产周期缩短至原来的约 2/3。${count?take:'可从背包安装一件速度模块。'}`,
      cargo:take,
      display:'',
    };
    const description=itemDescription(item);
    const stack=stackLimit(data,item);
    html=`<strong>${textHtml(ITEM[item])} <span class="quick-count">×${count}</span></strong>`+
      (description?`<p>${textHtml(description)}</p>`:'')+
      (anchor.dataset.context?`<p>${textHtml(anchor.dataset.context)}</p>`:'')+
      (cap>=0?`<p>${textHtml(t('ui.capacity',{count,capacity:cap}))}</p>`:'')+
      (role==='held'?`<p>${textHtml(t('ui.stackUsage',{used:Math.ceil(count/stack),limit:stack}))}</p>`:'')+
      (help[role]?`<p>${textHtml(help[role])}</p>`:'')+
      (infoPinned && count>1 && sameSlot(selectedItem,slot)?button(selectedItem?.quantity?`数量 ${selectedItem.quantity}`:'指定数量','transfer-amount'):'');
  }
  if (quickInfo.innerHTML!==html) quickInfo.innerHTML=html;
  const interactive=infoPinned && !!quickInfo.querySelector('button');
  quickInfo.classList.toggle('interactive',interactive);
  quickInfo.setAttribute('role',interactive?'dialog':'tooltip');
  if (interactive) quickInfo.setAttribute('aria-label',anchor.dataset.slot?'物资操作':'建筑材料');
  else quickInfo.removeAttribute('aria-label');
  positionInfo(anchor.getBoundingClientRect(),!!anchor.closest('.panel'));
}

function revealInfo(anchor:HTMLButtonElement,pin=false) {
  if (!anchor.dataset.quick || (!pin && infoPinned)) return;
  infoTile=-1; infoKey=anchor.dataset.quick; infoPinned=pin; syncInfo();
}

function transferSlot(source:Selection,target:Slot) {
  const {role,item,tile,identity,canPut}=target;
  const insert=source.role==='held' && (role==='input' || role==='module') && canPut;
  const extract=role==='held' && (source.role==='input' || source.role==='output' || source.role==='module' || source.role==='cargo');
  if (!insert && !extract) return false;
  if (source.item!==item) {
    say('所选物料与槽位不符。',true);
    return false;
  }
  if (source.role==='cargo') return takeCargo(source.tile,source.lane,item,source.cargoId,source.identity);
  return submit({op:Op.Transfer,a:source.tile,b:tile,c:item,
    words:[source.quantity ?? 2147483647,source.identity,identity,source.role==='module'||role==='module'?3:source.role==='input'?1:2]},quantity=>{
    selectedItem=undefined;
    say(t(role==='module'?'ui.installed':role==='input'?'ui.inserted':'ui.received',{item:ITEM[item],count:quantity}));
  });
}

function takeCargo(tile:number,lane:number,item:number,cargoId:number,identity:number) {
  return submit({op:Op.TakeCargo,a:tile,b:lane,c:item,words:[cargoId,identity]},()=>{
    selectedItem=undefined;
    say(t('ui.received',{item:ITEM[item],count:1}));
  });
}

function activateSlot(anchor:HTMLButtonElement) {
  const slot=readSlot(anchor), {role,item,canPut}=slot;
  const shouldTransfer=selectedItem && ((role==='held' && selectedItem.role!=='held' && selectedItem.item===item) ||
    ((role==='input' || role==='module') && canPut && selectedItem.role==='held' && selectedItem.item===item));
  if (shouldTransfer && selectedItem) transferSlot(selectedItem,slot);
  else if (canSelectSlot(slot)) {
    selectedItem=sameSlot(selectedItem,slot)?undefined:slot;
  }
  revealInfo(anchor,true);
  refresh();
}

const rendered=new WeakMap<HTMLElement,string>();
function fill(element:HTMLElement,html:string) {
  if (rendered.get(element)===html || harvest.protects(element,html) || handcraft.protects(element,html)) return;
  rendered.set(element,html);
  const active=document.activeElement as HTMLElement | null;
  const key=active && element.contains(active)?active.dataset.quick:undefined;
  const recipeFocused=active && element.contains(active) && active.closest('.handcraft-recipe');
  element.innerHTML=html;
  if (key) element.querySelector<HTMLButtonElement>(`[data-quick="${key}"]`)?.focus({preventScroll:true});
  else if (recipeFocused) element.querySelector<HTMLButtonElement>('[data-action^="toggle-handcraft-"]')?.focus({preventScroll:true});
}

function renderBalances() {
  const items=knownItems(data).filter(item=>item>0);
  const key=items.join(',');
  if (key!==balanceItems) {
    fill(balances,items.length?items.map(item=>itemSlot('held',item,held(data,item))).join('')+
      '<span class="capacity" id="backpack-capacity"></span>':'');
    balanceItems=key;
  }
  const capacity=byId('backpack-capacity');
  if (capacity) {
    const label=t('ui.backpack',{used:limits.used,slots:limits.slots});
    if (capacity.textContent!==label) capacity.textContent=label;
    capacity.title=t('ui.individualStacks');
    capacity.dataset.full=String(limits.used>=limits.slots);
  }
  for (const slot of balances.querySelectorAll<HTMLButtonElement>('[data-item]')) {
    const item=Number(slot.dataset.item), count=held(data,item);
    const pressed=String(slotSelected('held',item,-1));
    if (slot.getAttribute('aria-pressed')!==pressed) slot.setAttribute('aria-pressed',pressed);
    const amount=String(amountBadge('held',item,-1) ?? '');
    if (slot.dataset.selectedCount!==amount) slot.dataset.selectedCount=amount;
    if (slot.dataset.count===String(count)) continue;
    slot.dataset.count=String(count);
    slot.querySelector('.item-count')!.textContent=String(count);
    slot.setAttribute('aria-label',slotLabel('held',item,count));
  }
}

function refresh(force=true) {
  if (!ready) return;
  renderBalances();
  byId('clock').textContent=time(data[Meta.Tick]);
  const activePage=guideOpen?'guide':operationPage();
  for (const nav of document.querySelectorAll<HTMLButtonElement>('.mode')) {
    nav.hidden=!modeAvailable(nav.dataset.mode as Mode);
    nav.setAttribute('aria-pressed',String(nav.dataset.mode===activePage));
  }
  if (force || (!panelPointer && performance.now()-lastPanelRender>220)) {
    const [tag,title,html,tools='',tabs='']=inspectors();
    byId('panel-tag').textContent=tag; byId('panel-title').textContent=title;
    fill(byId('panel-tools'),tools+(activePage==='view'?button(t(manualWork?'ui.inspect':'ui.handcraft'),'manual-work'):''));
    panelTabs.hidden=!tabs;
    fill(panelTabs,tabs);
    fill(panelBody,html);
    lastPanelRender=performance.now();
    updateDraft();
    syncInfo();
  }
}

function station(city=0) {
  if (!unlocked(data,Kind.Station)) return;
  const tile=cityValue(data,city,CityField.Site);
  if (cell(data,tile,Field.Kind)!==Kind.Station) { previewAt(Kind.Station,tile); return; }
  clearDraft(); mode='orbit'; inspectingTile=false; selected=tile; focus=tile; traced=[];
  renderer?.camera.focus(tile); setPanel(true); refresh();
}

function powerMap() {
  if (!modeAvailable('power')) return;
  clearDraft(); mode='power'; inspectingTile=false; traced=[]; setPanel(true); refresh();
}

function traceCargo() {
  if (selected<0) return;
  const chain:[number,number][]=[];
  let current=selected;
  let lane=selectedItem?.role==='cargo' && selectedItem.tile===selected?selectedItem.lane:0;
  const seen=new Set<number>();
  let loop=false;
  for (let i=0;i<W*H;i++) {
    const kind=occupiedKind(data,current), dir=cell(data,current,Field.Direction);
    const outlet=!isTransport(kind) && kind>0?[...footprint(current,kind,dir)].find(tile=>machineMasks(data,tile)>>4):undefined;
    if (!isTransport(kind) && outlet===undefined) break;
    if (outlet!==undefined) current=outlet;
    const key=current*2+lane;
    if (seen.has(key)) { loop=true; break; }
    seen.add(key);
    const outputMask=machineMasks(data,current)>>4;
    const flow=outlet===undefined?(dir+(kind===Kind.Crossing?lane:0))%4:31-Math.clz32(outputMask & -outputMask);
    chain.push([current,flow]);
    const [x,y]=xy(current),[dx,dy]=STEP[flow];
    const next=at(x+dx,y+dy);
    if (next<0) break;
    const nextKind=occupiedKind(data,next);
    if (isTransport(nextKind)) {
      const nextDirection=cell(data,next,Field.Direction);
      const lanes=design(nextKind)?.lanes ?? 0;
      let inlet=0;
      while (inlet<lanes && !(transportPorts(nextKind,nextDirection,inlet).incoming&(1<<flow))) inlet++;
      if (inlet===lanes) break;
      lane=inlet;
    } else if (nextKind && !(machineMasks(data,next)&(1<<flow))) break;
    current=next;
    if (!isTransport(nextKind)) break;
  }
  traced=chain; focus=current;
  renderer?.camera.focus(current);
  const terminal=MACHINE[occupiedKind(data,current)].name;
  say(loop?'该主路形成了回环':`主路终点 · ${terminal} · ${coordinates(current)}`);
}

function previewOnGrid(kind:Kind) {
  const origin=selected>=0 && cell(data,selected,Field.Grid)?selected:STATION;
  const group=cell(data,origin,Field.Grid);
  const tile=nearest(origin,i=>!occupiedKind(data,i) && group>0 && cell(data,i,Field.Grid)===group);
  previewAt(kind,tile);
}

function nearest(origin:number, test:(tile:number)=>boolean) {
  const [x,y]=xy(origin);
  let best=-1, bestDistance=Infinity;
  for (let i=0;i<W*H;i++) if (test(i)) {
    const distance=Math.abs(i%W-x)+Math.abs(Math.floor(i/W)-y);
    if (distance<bestDistance) { best=i; bestDistance=distance; }
  }
  return best;
}
function previewAt(kind:Kind,tile:number) {
  if (tile>=0) renderer?.camera.focus(tile);
  choose(kind,tile);
}
function home() {
  const cam=renderer?.camera;
  if (!cam) return;
  const [x,y]=xy(data[Meta.FirstOre]);
  const zoom=data[Meta.Stage]<Stage.Expand?Math.min(cam.width/8,limits.maxZoom):28;
  const drawerOffset=portraitDrawer.matches && panel.dataset.expanded==='true'?panel.offsetHeight/2:0;
  cam.aim(x+.5,y+.5+drawerOffset/zoom,zoom);
}

function setSpeed(value:number) {
  value=Math.min(value,limits.speed || 2);
  if (!value && speed) pausedPhase=animationPhase(performance.now());
  if (value && !speed) lastSnapshot=performance.now()-pausedPhase*1000/(value*HZ);
  speed=value; worker.postMessage({type:'speed',speed});
  const element=document.querySelector<HTMLButtonElement>('[data-action="speed"]')!;
  element.textContent=speed?`${speed}×`:'暂停';
  document.querySelector<HTMLButtonElement>('[data-action="pause"]')!.textContent=speed?'暂停模拟':'继续模拟';
}

function animationPhase(now:number) {
  return speed ? Math.min(speed,Math.max(0,now-lastSnapshot)*speed*HZ/1000) : pausedPhase;
}

function editBlueprint(action:'capture'|'rename'|'delete',id?:number) {
  const entry=id===undefined?undefined:blueprintById(id);
  if (action!=='capture' && !entry?.id) return;
  blueprintEdit={action,id};
  byId('blueprint-error').hidden=true;
  const name=byId<HTMLInputElement>('blueprint-name');
  const removing=action==='delete';
  byId('blueprint-label').hidden=removing;
  name.disabled=removing; name.required=!removing;
  name.value=entry?.name ?? '厂段 '+blueprints.length;
  byId('blueprint-dialog-title').textContent=({capture:'保存蓝图',rename:'重命名蓝图',delete:'删除蓝图'})[action];
  byId('blueprint-submit').textContent=removing?'确认删除':'保存';
  const description=byId('blueprint-delete-text');
  description.hidden=!removing; description.textContent=removing?`删除「${entry?.name}」？`:'';
  blueprintDialog.showModal();
  if (!removing) name.select();
}

function blueprintError(message:string) {
  const error=byId('blueprint-error');
  error.textContent=message; error.hidden=false;
}

byId<HTMLFormElement>('blueprint-form').addEventListener('submit',event=>{
  event.preventDefault();
  if (!blueprintEdit) return;
  const {action,id}=blueprintEdit;
  const name=byId<HTMLInputElement>('blueprint-name').value.trim();
  const words=Array.from(new TextEncoder().encode(name));
  if (action!=='delete' && (!name || words.length>192)) { blueprintError('请输入有效的蓝图名称。'); return; }
  const command:Command=action==='capture'?{op:Op.CaptureBlueprint,a:anchors[0],b:anchors[1],words}:
    action==='rename'?{op:Op.RenameBlueprint,a:id,words}:{op:Op.DeleteBlueprint,a:id};
  submit(command,()=>{
    blueprintDialog.close();
    clearDraft(); mode='build'; buildTab='blueprints'; setPanel(true);
    say(({capture:'已保存蓝图',rename:'已重命名蓝图',delete:'已删除蓝图'})[action]);
  });
});

byId<HTMLFormElement>('transfer-form').addEventListener('submit',event=>{
  event.preventDefault();
  const quantity=byId<HTMLInputElement>('transfer-quantity').valueAsNumber;
  if (!Number.isInteger(quantity) || quantity<1) return;
  if (selectedItem) selectedItem.quantity=quantity;
  transferDialog.close(); refresh();
});

function onAction(action:string) {
  const libraryAction=/^(preview|rename|delete)-blueprint-(\d+)$/.exec(action);
  if (libraryAction) {
    const [,verb,value]=libraryAction, id=Number(value);
    if (verb==='preview') selectStamp(id);
    else editBlueprint(verb as 'rename'|'delete',id);
    return;
  }
  const cam=renderer?.camera;
  const region=/^(line|site|sender|receiver|lastmile|cable|window)-(\d)(?:-(\d))?$/.exec(action);
  if (region) {
    const [,verb,id,program]=region, city=Number(id);
    if (city>=visibleCities()) return;
    const v=(f:CityField)=>cityValue(data,city,f);
    if (verb==='line') {
      const [sx,sy]=xy(v(CityField.Sender)),[ex,ey]=xy(v(CityField.Receiver));
      if (cam) cam.aim((sx+ex+1)/2,(sy+ey+1)/2,Math.min(32,cam.width/(5+Math.abs(sx-ex)),cam.height/(7+Math.abs(sy-ey))));
      choose(city===1?'valley-line':'highland-line');
    }
    if (verb==='site') station(city);
    if (verb==='sender' || verb==='receiver') {
      clearDraft(); mode='view'; selected=v(verb==='sender'?CityField.Sender:CityField.Receiver); cam?.focus(selected); focus=selected; setPanel(true); refresh();
    }
    if (verb==='lastmile') {
      cam?.focus(v(CityField.Receiver)+2);
      choose(Kind.Belt,v(CityField.Receiver));
      if (tool===Kind.Belt && !pending) { beltStarted=true; extendBelt(v(CityField.Site)); updateDraft(); }
    }
    if (verb==='cable') {cam?.focus(v(CityField.Site)); choose('wire',v(CityField.Site));}
    if (verb==='window') submit({op:Op.Trial,a:city,b:Number(program)},()=>say('照明窗口已排定'));
    return;
  }
  if (action.startsWith('toggle-handcraft-')) {
    const key=Number(action.slice('toggle-handcraft-'.length));
    handcraftExpanded=handcraftExpanded===key?undefined:key;
    refresh();
    return;
  }
  if (action.startsWith('choose-recipe-')) {
    submit({op:Op.SelectRecipe,a:selected,b:deviceIdentity(selected),c:Number(action.slice('choose-recipe-'.length))});
    return;
  }
  switch (action) {
    case 'home': home(); return;
    case 'close-guide': closeGuide(); return;
    case 'manual-work': selectMode('view',!manualWork); return;
    case 'zoom-in': if (cam) cam.scale(cam.width/2,cam.height/2,1.25); return;
    case 'zoom-out': if (cam) cam.scale(cam.width/2,cam.height/2,.8); return;
    case 'toggle-panel': setPanel(panel.dataset.expanded!=='true'); return;
    case 'speed': setSpeed(speed===0 || speed>=limits.speed?1:speed*2); return;
    case 'pause': setSpeed(speed?0:1); return;
    case 'station': station(); return;
    case 'mission': selectMode('task'); return;
    case 'power-map': powerMap(); return;
    case 'trace-cargo': traceCargo(); return;
    case 'battery': previewOnGrid(Kind.Battery); return;
    case 'wire': choose('wire'); return;
    case 'cut': choose('cut'); return;
    case 'remove-tool': choose('remove'); return;
    case 'remove': choose('remove',selected); return;
    case 'capture': if (data[Meta.FirstLight]) { buildTab='blueprints'; choose('capture'); } return;
    case 'dismiss-blueprint': blueprintDialog.close(); return;
    case 'transfer-amount': {
      if (!selectedItem) return;
      const {role,item,tile,identity,quantity}=selectedItem;
      const device=deviceAt(data,tile);
      const available=role==='held'?held(data,item):device?.identity===identity?
        device.slots.find(slot=>slot.canTake && slot.role===role && slot.item===item)?.count ?? 0:0;
      if (!available) return;
      const input=byId<HTMLInputElement>('transfer-quantity');
      input.max=String(available); input.value=String(Math.min(quantity ?? available,available));
      transferDialog.showModal(); input.select(); return;
    }
    case 'dismiss-quantity': transferDialog.close(); return;
    case 'turn-path': verticalFirst=!verticalFirst; updateDraft(); return;
    case 'back-path': confirmTransport=0; anchors.pop(); beltFacing=false; pathMessage=''; updateDraft(); return;
    case 'rotate-draft': rotateDraft(); return;
    case 'confirm-draft': confirmDraft(); return;
    case 'cancel-draft': {
      if (tool!==undefined && pending) return;
      const returnToLibrary=tool==='capture' || tool==='stamp';
      clearDraft();
      closeInfo();
      if (returnToLibrary) { mode='build'; buildTab='blueprints'; setPanel(true); }
      refresh(); return;
    }
    case 'rotate-device': if (selected>=0) submit({op:Op.Rotate,a:selected}); return;
    case 'configure': {
      if (selected<0) return;
      const kind=cell(data,selected,Field.Kind),cfg=cell(data,selected,Field.Config);
      const choices=kind===Kind.Depot?knownItems(data).filter(item=>item<SPEED_MODULE):kind===Kind.Splitter?[0,1]:[0,1,2];
      submit({op:Op.Configure,a:selected,b:choices[(choices.indexOf(cfg)+1)%choices.length]}); return;
    }
    case 'launch': submit({op:Op.Launch},()=>say('试验镜发射已启动')); return;
    case 'trial': submit({op:Op.Trial},()=>say('试照窗口已排定')); return;
    case 'archive': byId('reset-warning').hidden=true; dialog.showModal(); return;
    case 'close-dialog': dialog.close(); return;
    case 'save': manualSave=true; worker.postMessage({type:'save'}); return;
    case 'export': exportPending=true; worker.postMessage({type:'save'}); return;
    case 'import': saveFile.click(); return;
    case 'reset-confirm': byId('reset-warning').hidden=false; return;
    case 'reset': {
      clearDraft(); closeInfo(); selectedItem=undefined; selected=-1; focus=-1; traced=[]; mode='task'; recenter=true;
      guideOpen=false;
      buildTab='catalog';
      worker.postMessage({type:'reset'}); worker.postMessage({type:'save'}); dialog.close(); return;
    }
  }
}

document.addEventListener('click',event=>{
  const target=event.target as Element;
  const el=target.closest<HTMLButtonElement>('button');
  if (target!==canvas && !el?.dataset.quick && !quickInfo.contains(target)) closeInfo();
  if (!el || el.disabled || !ready) return;
  if (el.dataset.slot) activateSlot(el);
  else if (el.dataset.tool) {
    const next=el.dataset.tool==='wire'?'wire':Number(el.dataset.tool);
    if (tool===next) { onAction('cancel-draft'); return; }
    if (el.dataset.unavailable!=='true') choose(next,selected,true);
    revealInfo(el,true);
  }
  else if (el.dataset.mode) selectMode(el.dataset.mode as Mode);
  else if (el.dataset.buildTab==='catalog' || el.dataset.buildTab==='blueprints') {
    if (el.dataset.buildTab!==buildTab && catalogTool && !pending) clearDraft();
    buildTab=el.dataset.buildTab; refresh();
    panelTabs.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({preventScroll:true});
    panelBody.scrollTop=0;
  }
  else if (el.dataset.action==='take-cargo') {
    const {tile,lane,item,cargoId,identity}=el.dataset;
    takeCargo(Number(tile),Number(lane),Number(item),Number(cargoId),Number(identity));
  }
  else if (el.dataset.action) onAction(el.dataset.action);
  else if (el.dataset.fault) { selected=Number(el.dataset.fault); inspectingTile=true; focus=selected; renderer?.camera.focus(selected); refresh(); }
});
app.addEventListener('contextmenu',event=>{
  if (tool===undefined || event.button!==2 || event instanceof PointerEvent && event.pointerType==='touch') return;
  event.preventDefault();
  onAction('cancel-draft');
});
document.addEventListener('pointerover',event=>{
  const anchor=(event.target as Element).closest<HTMLButtonElement>('[data-quick]');
  if (event.pointerType==='mouse' && anchor && !anchor.contains(event.relatedTarget as Node | null)) revealInfo(anchor);
});
document.addEventListener('pointerout',event=>{
  const anchor=(event.target as Element).closest<HTMLButtonElement>('[data-quick]');
  if (!infoPinned && anchor?.dataset.quick===infoKey && !anchor.contains(event.relatedTarget as Node | null)) closeInfo();
});
document.addEventListener('focusin',event=>{
  const anchor=(event.target as Element).closest<HTMLButtonElement>('[data-quick]');
  if (anchor?.matches(':focus-visible')) revealInfo(anchor);
});
document.addEventListener('focusout',event=>{
  if (!infoPinned && (event.target as HTMLElement).dataset.quick===infoKey) closeInfo();
});
window.addEventListener('scroll',syncInfo,true);
window.addEventListener('resize',syncInfo);
panelBody.addEventListener('pointerdown',()=>{panelPointer=true;});
window.addEventListener('pointerup',()=>{panelPointer=false;});
window.addEventListener('pointercancel',()=>{panelPointer=false;});
window.addEventListener('blur',()=>{panelPointer=false;});

window.addEventListener('keydown',event=>{
  if (blueprintDialog.open || transferDialog.open) return;
  if (event.key==='Escape' && guideOpen && !dialog.open) { closeGuide(); return; }
  if (event.key==='Escape' && (infoKey || infoTile>=0 || selectedItem)) {
    closeInfo(); selectedItem=undefined; refresh(); return;
  }
  if (!ready || dialog.open || event.ctrlKey || event.metaKey || (event.target as Element).matches('button,input,select')) return;
  if (event.key==='Escape') { clearDraft(); refresh(); }
  if (event.key==='Enter' && tool!==undefined) { event.preventDefault(); confirmDraft(); }
  if (event.key.toLowerCase()==='r' && tool!==undefined) onAction('rotate-draft');
  const key=Number(event.key);
  if (key>=1 && key<=6) selectMode((['view','build','power','orbit','task','guide'] as const)[key-1]);
  if (event.key===' ' || event.key==='p') { event.preventDefault(); setSpeed(speed?0:1); }
  const pan:Record<string,[number,number]>={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]};
  if (pan[event.key]) { event.preventDefault(); renderer?.camera.pan(...pan[event.key]); }
});

function reportSaveError(reason:string) {
  const status=byId('save-status');
  delete status.dataset.i18n;
  status.textContent=reason;
  say(reason,true);
}

saveFile.addEventListener('change',async()=>{
  const file=saveFile.files?.[0]; saveFile.value='';
  if (!file) return;
  if (file.size>4_000_000) { reportSaveError('导入失败，文件超过当前存档大小上限。'); return; }
  try {
    const buffer=await file.arrayBuffer(); worker.postMessage({type:'restore',buffer},[buffer]);
  } catch { reportSaveError('读取存档失败。'); }
});

worker.onmessage=event=>{
  const message=event.data;
  if (message.type==='error') { fail(message.key?t(message.key):message.message); return; }
  if (message.type==='directory') { readDirectory(message.buffer); return; }
  if (message.type==='blueprints') { blueprints=readBlueprints(message.buffer); refresh(); return; }
  if (message.type==='transport-preview') {
    if (transportPreview && transportPreview.request===message.request) {
      transportPreview.result=new Int32Array(message.result);
      const shouldConfirm=confirmTransport===message.request;
      if (shouldConfirm) confirmTransport=0;
      updateDraft();
      if (shouldConfirm && transportPreview.request===message.request) confirmDraft();
    }
    return;
  }
  if (message.type==='legacy-imported') { legacyCleanup=!reviewScene; return; }
  if (message.type==='command-result') {
    const done=pending; pending=undefined;
    const failed=pendingFailure; pendingFailure=undefined;
    if (message.status<0) {
      failed?.(message.status);
      if ([-20,-21,-23].includes(message.status)) transportPreview=undefined;
      if ([-15,-22].includes(message.status)) selectedItem=undefined;
      const error=ERRORS[message.status] ?? '操作失败';
      if (blueprintDialog.open) blueprintError(error);
      else say(error,true);
      refresh();
    }
    else {
      done?.(message.status); refresh(); window.clearTimeout(commitTimeout);
      commitTimeout=window.setTimeout(()=>worker.postMessage({type:'save'}),450);
    }
    return;
  }
  if (message.type==='snapshot') {
    const wasLit=data[Meta.FirstLight], wasComplete=data[Meta.Complete], oldStage=data[Meta.Stage], previous=data.buffer;
    const next=new Int32Array(message.buffer);
    if (speed || next[Meta.Tick]!==data[Meta.Tick]) {
      lastSnapshot=performance.now();
      if (!speed) pausedPhase=0;
    }
    data=next;
    const oldLimits=limits;
    limits=progression(data);
    const cam=renderer?.camera;
    if (cam && (oldLimits.tier!==limits.tier || oldLimits.left!==limits.left)) {
      cam.bounds=limits;
      cam.aim(cam.x,cam.y);
    }
    if (speed>limits.speed) setSpeed(limits.speed);
    if (ready && previous instanceof ArrayBuffer) worker.postMessage({type:'recycle',buffer:previous},[previous]);
    if (!ready) {
      ready=true; loading.hidden=true; app.setAttribute('aria-busy','false');
      setPanel(data[Meta.Stage]<Stage.Expand || window.matchMedia('(min-width: 901px) and (min-height: 521px)').matches);
      refresh();
      if (legacyCleanup) worker.postMessage({type:'save'});
    } else {
      refresh(message.immediate || oldStage!==data[Meta.Stage]);
    }
    if (recenter) { home(); recenter=false; }
    if (!wasLit && data[Meta.FirstLight] && data[Meta.Sun]) {
      say('曙港第一次看见日出');
      if (mode==='orbit' && cam) cam.aim(38,11.6);
    }
    if (!wasComplete && data[Meta.Complete]) say('四条厂段已交付 · 谷东请求开通班线');
    if (oldStage!==Stage.Victory && data[Meta.Stage]===Stage.Victory) {
      say('三城连续迎来第三轮日出'); mode='task'; selected=-1; setPanel(true);
      if (cam) cam.aim(28,18,Math.min(cam.width/54,cam.height/38));
      refresh();
    }
    return;
  }
  if (message.type==='save') {
    if (exportPending) { exportPending=false; downloadSave(message.buffer); }
    const requested=manualSave; manualSave=false;
    void persistSave(message.buffer).then(()=>{
      if (legacyCleanup) {
        try { clearLegacyBlueprint(); } catch { /* The saved migration marker prevents duplicates. */ }
        legacyCleanup=false;
      }
      const status=byId('save-status');
      delete status.dataset.i18n;
      status.textContent='进度已保存到此浏览器。';
      if (requested) say('进度已保存');
    }).catch(()=>{
      const status=byId('save-status');
      delete status.dataset.i18n;
      status.textContent='浏览器未能保存进度，可从这里导出存档。';
      if (requested) say('本地保存失败，可导出文件。',true);
    });
    return;
  }
  if (message.type==='restored') {
    clearDraft(); closeInfo(); selectedItem=undefined; mode='task'; focus=-1; selected=-1; traced=[]; recenter=true;
    guideOpen=false;
    buildTab='catalog';
    worker.postMessage({type:'save'}); dialog.close(); say('已恢复存档'); return;
  }
  if (message.type==='invalid-save') {
    const reason=message.status===-25?ERRORS[-25]:t(message.startup?'ui.invalidAutoSave':'ui.invalidSave');
    reportSaveError(reason);
  }
};
worker.onerror=()=>fail('模拟没有启动。请刷新页面后重试。');

const mapLabels=[
  { name:'铜矿', x:17.5, y:16.5, stage:Stage.Handwork, oreTile:at(17,17) },
  { name:'燃料矿', x:23.5, y:15.5, stage:Stage.Bench, oreTile:at(23,16) }, { name:'铁矿', x:22.5, y:18.5,stage:Stage.Expand },
  { name:'硅矿', x:20.5, y:19.5,stage:Stage.Silica }, { name:'曙港城', x:44, y:5.2,stage:Stage.Launch },
  { name:'谷东城', x:48, y:22.1,stage:Stage.Valley }, { name:'西岭城', x:8, y:22.1,stage:Stage.Highland },
].map(label=>{
  const element=document.createElement('span'); element.className='map-label'; element.textContent=label.name;
  byId('map-labels').append(element); return {...label,element};
});

function draw(now:number) {
  harvest.tick(now);
  handcraft.tick(now);
  if (renderer) {
    if (ready) {
      const cam=renderer.camera, tile=harvest.mapTile();
      mapHarvest.hidden=tile===undefined;
      if (tile!==undefined) {
        const [x,y]=xy(tile), [sx,sy]=cam.toScreen(x+.5,y+.5);
        mapHarvest.style.transform=`translate(${sx}px,${sy+cam.zoom*.63}px) translateX(-50%)`;
      }
      gain.hidden=now>=gainUntil;
      if (!gain.hidden) {
        const [gx,gy]=xy(gainTile), [px,py]=cam.toScreen(gx+.5,gy);
        gain.style.transform=`translate(${px}px,${py-18+(gainUntil-now)/65}px) translateX(-50%)`;
      }
      renderer.render({data,mode,preview:ghost.cells,selected,focus,trace:traced,now,tick:data[Meta.Tick]+animationPhase(now),
        chipTile:gainTile,chip:gain.hidden?0:(gainUntil-now)/750});
    }
    for (const {name,x,y,stage,element,oreTile} of mapLabels) {
      const [sx,sy]=renderer.camera.toScreen(x,y);
      const visible=ready && data[Meta.Stage]>=stage && (oreTile===undefined || !!cell(data,oreTile,Field.Ore))
        && sx>24&&sy>(sx<157?88:41)&&sx<renderer.camera.width-26&&sy<renderer.camera.height-42;
      element.hidden=!visible;
      if (visible) element.style.transform=`translate(${Math.round(sx)}px,${Math.round(sy)}px) translate(-50%,-100%)`;
      const city=CITY.findIndex(city=>name===city+'城');
      element.dataset.bright=city>=0 && (data[Meta.LitMask] & (1<<city))?'yes':'no';
    }
  }
  requestAnimationFrame(draw);
}

applyTranslations();

try {
  renderer=new Renderer(canvas);
  bindMapInput(canvas,renderer.camera,{
    tap,
    inspect:inspectMap,
    canRotateDraft,
    rotateDraft,
    canRotateAt:tile=>!pending && canRotateDraft() && overlapsDraft(tile),
    rotateAt,
    startHarvest:(tile,pointer)=>harvest.start(tile,undefined,pointer),
    stopHarvest:harvest.stop,
    canDragRoute:()=>!pending && (plainBelt(tool) || tool==='wire'),
    startRoute:startPathDrag,
    route:drawPath,
    finishRoute:finishPathDrag,
  });
  const legacy=legacyBlueprint();
  const url=new URL(`${import.meta.env.BASE_URL}sim.wasm`,document.baseURI).href;
  void resumeSave().then(
    save=>worker.postMessage({type:'init',url,signature:content.signature,save,legacy}),
    error=>reviewScene
      ? fail(error instanceof Error ? error.message : '无法载入视觉评审场景。')
      : worker.postMessage({type:'init',url,signature:content.signature,legacy}),
  );
  window.setInterval(()=>{ if (ready && !document.hidden) worker.postMessage({type:'save'}); },8000);
  document.addEventListener('visibilitychange',()=>{
    if (!ready) return;
    if (document.hidden) worker.postMessage({type:'save'});
    worker.postMessage({type:'speed',speed:document.hidden?0:speed});
  });
  requestAnimationFrame(draw);
} catch (error) { fail(error instanceof Error?error.message:'无法启动渲染器'); }
