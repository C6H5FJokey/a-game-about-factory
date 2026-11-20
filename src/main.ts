import './style.css';
import { bindMapInput } from './input';
import { beltTerminal, detourLockedCrossing, dragTiles, findBeltPath, findCablePath, flowTo, projectBeltPath } from './belt-route';
import { bindActionHold } from './action-hold';
import { bindInventoryDrag, canSelectSlot, readContainer, readSlot, sameSlot, type ContainerTarget, type Selection, type Slot, type SlotRole } from './inventory-drag';
import { bindGroundMarkers, groundPiles, type GroundPile } from './ground-items';
import {
  DIRECTION, Field, H, HEADER, HZ, Kind, Meta, Op, energyMj, legacyRecipes, selectedRecipe,
  STATION, STATUS, STEP, STRIDE, Stage, W, SPEED_MODULE, at, cell, drillTool, held, inBounds, isTransport, plainBelt, progression, stackLimit, mw, time, unlocked, xy, CITY, CityField, cityValue,
  terminalReview, type Command, type Mode, type PreviewCell, type Tool,
} from './model';
import { Renderer } from './renderer';
import { campaignTask, contents, firstMachine, guideText, handbook, visibleGuide } from './campaign';
import { clearLegacyBlueprint, downloadSave, legacyBlueprint, persistSave, resumeSave, reviewScene } from './storage';
import { actionIcon, itemIcon, machineIcon } from './icons';
import { devicePower, designPower } from './power-readout';
import { cargoAt, constructionAvailable, constructionSources, design, deviceAt, drillVariant, layoutRevision, preparedMaterials, readBlueprints, readDirectory, transportPorts, type Blueprint, type CargoTrack, type Material, type SlotData } from './sim-data';
import { ERRORS, ITEM, MACHINE, itemDescription } from './catalog-text';
import { content, ViewSection } from './generated-content';
import { SnapshotLayout, attachView, finishViewDecode, startViewDecode, viewHasTile, viewSection } from './world-view';
import { language, languages, onLanguageChange, setLanguage, t, textHtml } from './i18n';
import { footprint, machineAnchor, machineMasks, machineSize, occupiedKind, previewPorts, rotatePart } from './machine-layout';

function byId<T extends HTMLElement = HTMLElement>(id:string) { return document.getElementById(id) as T; }

const app=byId('app'), canvas=byId<HTMLCanvasElement>('world'), loading=byId('loading');
const panel=byId('panel'), panelBody=byId('panel-body'), draft=byId('draft');
const panelTabs=byId('panel-tabs');
const referencePanel=byId('reference-panel'), referenceBody=byId('reference-body');
const drawers={
  factory:{panel,surface:byId('panel-surface')},
  reference:{panel:referencePanel,surface:byId('reference-surface')},
};
type Drawer = keyof typeof drawers;
type ReferencePage = 'task' | 'guide';
type NavigationPage = Mode | ReferencePage;
const drawerOpen:Record<Drawer,boolean>={factory:false,reference:false};
const pageButtons=[...document.querySelectorAll<HTMLButtonElement>('.mode[data-mode]')];
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-nav-icon]')) {
  button.insertAdjacentHTML('afterbegin',actionIcon(button.dataset.navIcon as Parameters<typeof actionIcon>[0]));
}
let activeDrawer:Drawer='reference', referencePage:ReferencePage='task';
const dialog=byId<HTMLDialogElement>('archive-dialog'), saveFile=byId<HTMLInputElement>('save-file');
const blueprintDialog=byId<HTMLDialogElement>('blueprint-dialog'), transferDialog=byId<HTMLDialogElement>('transfer-dialog');
const dropDialog=byId<HTMLDialogElement>('drop-dialog');
const notice=byId('notice'), balances=byId('balances'), quickInfo=byId('quick-info');
const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
const fullSnapshot=terminalReview && new URLSearchParams(location.search).get('snapshot')==='full';
let snapshotLayout:SnapshotLayout | undefined;
let lastView:number[]=[];
let renderer:Renderer | undefined;
let data=new Int32Array(HEADER+W*H*STRIDE);
let limits=progression(data);
let ready=false, mode:Mode='view', tool:Tool | undefined, selected=-1, focus=-1, inspectingTile=false;
let manualWork=false, handcraftExpanded:number|undefined;
let gainUntil=0, gainTile=-1, recenter=true;
const gain=byId('ore-gain'), mapHarvest=byId('map-harvest');
const portraitDrawer=window.matchMedia('(max-width: 720px) and (orientation: portrait)');
const landscapeDock=window.matchMedia('(pointer: coarse) and (orientation: landscape), (max-height: 520px) and (orientation: landscape)');
let traced:[number,number][]=[];
let anchors:number[]=[], direction=0, lastSnapshot=0, lastPanelRender=0;
let catalogTool=false, pathStarted=false, beltFacing=false, pathMessage='';
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
const INVENTORY_DOUBLE_CLICK_MS=350;
type InventoryDevice=Pick<Slot,'tile'|'identity'>;
type InventoryClick={slot:Slot; device:InventoryDevice; at:number; singleTransfer?:()=>void};
let inventoryClick:InventoryClick | undefined;
type BackpackStack=Pick<Slot,'item'|'stackIndex'>;
let dropSource:BackpackStack|undefined, groundTile=-1;
let dropDraft:(BackpackStack & {count:number})|undefined;
const groundMarkers=bindGroundMarkers(byId('ground-markers'),openGroundMarker);
let infoKey='', infoPinned=false, infoTile=-1;
let balanceItems='\0';
const inventoryPages=new Map<string,number>();

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

const slotArt=(item:number,count:number)=>itemIcon(item)+`<span class="item-count">${count}</span>`;
const slotLabel=(role:SlotRole,item:number,count:number)=>t('ui.slotLabel',{role:t('ui.'+role),item:ITEM[item],count});
const deviceIdentity=(tile:number)=>deviceAt(data,tile)?.identity ?? 0;
const stackCount=(count:number,limit:number,index:number)=>Math.max(0,Math.min(limit,count-index*limit));
const backpackStackCount=({item,stackIndex}:BackpackStack)=>stackCount(held(data,item),stackLimit(data,item),stackIndex);
const amountBadge=(pressed:boolean,count:number)=>pressed && selectedItem?.quantity!==undefined
  ? String(Math.min(selectedItem.quantity,count)):'';
function itemSlot(role:SlotRole,item:number,count:number,
  {tile=-1,context='',slot,track,stackIndex=0}:{tile?:number; context?:string; slot?:SlotData; track?:CargoTrack; stackIndex?:number}={}) {
  const lane=(track?.location ?? 0)%2, cargoId=track?.id ?? 0;
  const identity=track?.identity ?? (slot?deviceIdentity(tile):0);
  const pressed=count>0 && sameSlot(selectedItem,{role,item,tile,identity,lane,cargoId,stackIndex});
  return `<button type="button" class="item-slot" data-slot="${role}" data-item="${item}" data-tile="${tile}"
    data-count="${count}" data-stack-index="${stackIndex}" data-identity="${identity}"
    data-quick="slot-${role}-${item}-${tile}-${track?lane:stackIndex}" aria-label="${textHtml(slotLabel(role,item,count))}"
    ${slot?`data-stack="${slot.stack}" data-room="${slot.room}" data-put="${slot.canPut}" data-take="${slot.canTake}"`:''}
    ${track?`data-lane="${lane}" data-cargo-id="${cargoId}" data-take="true"`:''}
    ${role==='held'||slot?.canTake||track?`aria-pressed="${pressed}" data-selected-count="${amountBadge(pressed,count)}"`:''}
    ${context?`data-context="${textHtml(context)}"`:''}>${slotArt(item,count)}</button>`;
}
const slotRow=(title:string,slots:string)=>slots?`<div class="slot-row"><span class="slot-label">${title}</span><div class="slots">${slots}</div></div>`:'';

const button=(name:string,action:string,primary=false,disabled=false)=>
  `<button type="button" class="button${primary?' primary':''}" data-action="${action}"${disabled?' disabled':''}>${textHtml(name)}</button>`;

function stackPage<T extends Material & {stack:number}>(key:string,items:T[],keepEmpty=false) {
  // Older saves can carry more stacks than the current container capacity.
  const pageSize=32;
  const rows=items.map(item=>({item,stacks:Math.max(keepEmpty?1:0,Math.ceil(item.count/item.stack))}));
  const pages=Math.ceil(rows.reduce((sum,row)=>sum+row.stacks,0)/pageSize);
  const page=Math.min(inventoryPages.get(key) ?? 0,Math.max(0,pages-1));
  let skip=page*pageSize;
  const entries:{item:T;index:number}[]=[];
  for (const {item,stacks} of rows) {
    const start=Math.min(skip,stacks);
    skip-=start;
    const end=Math.min(stacks,start+pageSize-entries.length);
    for (let index=start; index<end; index++) entries.push({item,index});
    if (entries.length===pageSize) break;
  }
  const pager=pages>1?`<div class="stack-pager">
    ${button(t('ui.previousPage'),`stack-page-${key}-${page-1}`,false,page===0)}
    <span>${page+1}/${pages}</span>
    ${button(t('ui.nextPage'),`stack-page-${key}-${page+1}`,false,page+1===pages)}
  </div>`:'';
  return {entries,pager};
}
const iconButton=(name:string,action:string,icon:Parameters<typeof actionIcon>[0],pressed?:boolean)=>
  `<button type="button" class="button icon-button icon-button--${icon}" data-action="${action}" aria-label="${textHtml(name)}" title="${textHtml(name)}"${pressed===undefined?'':` aria-pressed="${pressed}"`}>${actionIcon(icon)}</button>`;
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

const holdAvailable=()=>ready && speed>0 && !dialog.open && !blueprintDialog.open && !transferDialog.open && !dropDialog.open && !dropDraft;
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
  available:key=>holdAvailable() && mode==='view' && manualWork && handcraftExpanded===key &&
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
  select:source=>{ inventoryClick=undefined; selectedItem=source; closeInfo(); refresh(); },
  drop:(source,target)=>target.role==='container'?transferToContainer(source,target):transferSlot(source,target),
  art:itemIcon,
});
const blueprintById=(id:number)=>blueprints.find(entry=>entry.id===id);
const activeBlueprint=()=>{
  const selection=stamping;
  return selection && blueprints.find(entry=>entry.id===selection.id && entry.version===selection.version);
};
const affordable=(materials:Material[])=>materials.every(({item,count})=>constructionAvailable(data,item)>=count);
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

function syncDrawers() {
  if (portraitDrawer.matches && drawerOpen[activeDrawer]) {
    drawerOpen[activeDrawer==='reference'?'factory':'reference']=false;
  }
  for (const name of ['factory','reference'] as const) {
    const {panel,surface}=drawers[name];
    const visible=drawerOpen[name];
    panel.dataset.expanded=String(visible);
    if (!visible && surface.contains(document.activeElement)) {
      const targetDrawer=drawerOpen[activeDrawer]?activeDrawer:name;
      const page=targetDrawer==='reference'?referencePage:operationPage();
      pageButtons.find(button=>button.dataset.mode===page && button.getClientRects().length)
        ?.focus({preventScroll:true});
    }
    surface.inert=!visible;
  }
  if (panel.dataset.expanded!=='true') {
    inventoryClick=undefined;
    if (infoKey && panel.querySelector(`[data-quick="${infoKey}"]`)) closeInfo();
  }
}

function setDrawer(name:Drawer,open:boolean) {
  drawerOpen[name]=open;
  if (open) activeDrawer=name;
  syncDrawers();
}

function setPanel(open:boolean) { setDrawer('factory',open); }

function selectReference(next:ReferencePage) {
  const switched=referencePage!==next;
  referencePage=next;
  setDrawer('reference',true);
  refresh();
  if (switched) referenceBody.scrollTop=0;
}

function resetDrawers() {
  referencePage='task';
  setPanel(false);
  setDrawer('reference',!landscapeDock.matches);
  referenceBody.scrollTop=0;
}

function operationPage():Mode {
  return inspectingTile && tool===undefined?'view':mode;
}

function selectMode(next:NavigationPage,crafting?:boolean) {
  if (next==='task' || next==='guide') { selectReference(next); return; }
  if (!modeAvailable(next)) return;
  if (next===operationPage() && crafting===undefined) {
    setPanel(true); refresh(); return;
  }
  if (tool==='cut' && pending) return;
  inventoryClick=undefined;
  dropDraft=undefined;
  groundTile=-1;
  clearDraft();
  mode=next;
  manualWork=crafting ?? false;
  inspectingTile=false;
  traced=[];
  setPanel(true);
  refresh();
  panelBody.scrollTop=0;
}

function togglePage(page:NavigationPage) {
  const reference=page==='task' || page==='guide';
  const drawer=reference?'reference':'factory';
  if (drawerOpen[drawer] && page===(reference?referencePage:operationPage())) {
    setDrawer(drawer,false);
    refresh();
  } else {
    selectMode(page);
  }
}

function clearDraft() {
  tool=undefined; anchors=[];
  catalogTool=false; pathStarted=false; beltFacing=false; pathMessage=''; dragOrigin=undefined;
  transportPreview=undefined; confirmTransport=0;
  ghost={cells:[],materials:[],label:'',conflict:false};
  canvas.removeAttribute('data-tool');
  delete draft.dataset.catalog;
  draft.hidden=true;
}

function choose(next:Tool,anchor=-1,fromCatalog=false) {
  if (tool!==undefined && pending) return;
  if (typeof next==='number' && !unlocked(data,next)) return;
  dropDraft=undefined;
  groundTile=-1;
  clearDraft();
  catalogTool=fromCatalog;
  if (fromCatalog) draft.dataset.catalog='true';
  tool=next; anchors=anchor>=0?[anchor]:[]; direction=0;
  pathStarted=!fromCatalog && plainBelt(next) && anchor>=0;
  if (anchor>=0 && typeof tool==='number' && isTransport(tool) && isTransport(cell(data,anchor,Field.Kind))) {
    direction=cell(data,anchor,Field.Direction);
  }
  inspectingTile=false;
  mode='build';
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
  if (kind===Kind.SimpleMiner) return !cell(data,tile,Field.Ore);
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
  const offscreen=result.cells.some(({tile})=>!viewHasTile(data,tile));
  const cargoKey=result.cells.map(({tile})=>Number(!!cargoAt(data,tile,0))+2*Number(!!cargoAt(data,tile,1))).join('')
    +(offscreen?'/'+Math.floor(data[Meta.Tick]/7):'');
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

function cableTool(value:Tool | undefined):value is 'wire'|'cut' { return value==='wire' || value==='cut'; }

function cableDraft(result:Draft) {
  const removing=tool==='cut';
  result.cells=anchors.map((tile,index)=>{
    const dir=flowTo(tile,anchors[index+1] ?? tile);
    const [x,y]=xy(tile);
    const invalid=!inBounds(limits,x,y) || removing && !cell(data,tile,Field.Wire);
    result.conflict ||= invalid;
    return {tile,dir:Math.max(0,dir),kind:0,wire:true,conflict:removing || invalid};
  });
  result.label=pathMessage?t(pathMessage):result.conflict?t('ui.invalidCablePath'):!anchors.length?t('ui.chooseCableStart'):
    !pathStarted?t('ui.lockCableStart'):t('ui.cablePathLength',{count:anchors.length});
  if (removing) {
    if (pathStarted && !result.conflict && anchors.length) result.command={op:Op.RemoveCables,words:anchors};
    return result;
  }
  const entry=design(Kind.Cable);
  const newTiles=anchors.filter(tile=>!cell(data,tile,Field.Wire)).length;
  if (entry && newTiles) result.materials=entry.materials.map(({item,count})=>({item,count:count*Math.ceil(newTiles/entry.span)}));
  if (pathStarted && anchors.length) result.command={op:Op.Route,a:1,words:result.cells.flatMap(({tile,dir})=>[tile,dir])};
  return result;
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
    result.materials=buildMaterials(Kind.Yard); result.label=t('ui.freightBuild',{slots:data[Meta.CrateSlots]});
    result.command={op:Op.OpenLine,a:city}; return result;
  }
  if (plainBelt(tool)) {
    const {cells,terminal,conflict}=projectBeltPath(data,anchors,Number(tool),direction,beltFacing);
    result.cells=cells; result.conflict=conflict;
    result.label=pathMessage?t(pathMessage):(conflict?'路径与端口或交叉条件不符':last<0?'点地图选起点':
      !pathStarted?'再点虚影选定起点':terminal>=0?'再点接入设备确认':'可继续选点，再点终点确认');
    if (!conflict) transportDraft(result);
    if (terminal>=0 || last>=0 && !cells.length) {
      result.cells.push({tile:last,kind:0,dir:0,conflict:result.conflict});
    }
    return result;
  }
  if (cableTool(tool)) return cableDraft(result);
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
  if (tool==='remove') {
    result.label='点设备预览拆除';
    if (last>=0) {
      const anchor=machineAnchor(data,last);
      const kind=anchor>=0?cell(data,anchor,Field.Kind):0;
      result.conflict=!kind || kind===Kind.Station || kind===Kind.Yard;
      const tiles=anchor<0?[last]:[...footprint(anchor,kind,cell(data,anchor,Field.Direction))];
      result.cells=tiles.map(tile=>({tile,kind:0,dir:0,conflict:true}));
      if (!result.conflict) result.command={op:Op.Remove,a:anchor};
      result.label=result.conflict?'该格没有可拆除的设备':`${machineText(kind).name} · 再点预览确认拆除`;
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
    if (tool===Kind.SimpleMiner && !result.conflict) {
      const ore=cell(data,last,Field.Ore), entry=design(tool);
      if (entry) {
        const rate=(entry.amount*HZ/entry.ticks).toLocaleString(language(),{minimumFractionDigits:2,maximumFractionDigits:2});
        result.label=t('ui.simpleMiningPreview',{item:ITEM[ore],rate});
      }
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
  const info=ghost.conflict && typeof tool==='number' && !drillTool(tool) && !isTransport(tool)
    ? '目标被占用、路线重叠或矿点不匹配' : ghost.label;
  const cost=ghost.materials.map(({item,count})=>{
    const available=constructionAvailable(data,item);
    return ` <span class="inline-cost${available<count?' missing':''}" aria-label="${textHtml(ITEM[item])} ${available} / ${count}">${itemIcon(item)}${available} / ${count}</span>`;
  }).join('');
  const sourceTile=ghost.command?.op===Op.Blueprint?ghost.command.a:ghost.cells[0]?.tile;
  const sources=sourceTile===undefined || sourceTile<0?[]:constructionSources(data,ghost.materials,sourceTile);
  const supply=sources.map(({tile,used})=>t('ui.constructionWarehouse',{
    site:coordinates(tile), materials:used.map(({item,count})=>`${ITEM[item]} ×${count}`).join(' · '),
  })).join(' / ');
  const canConfirm=Boolean(ghost.command || ghost.capture) && !ghost.conflict && !cannotPay && !pending;
  draft.hidden=false;
  const html=`<div class="draft-text"><strong>${textHtml(activeToolText())}${cost}</strong> · ${textHtml(info)}${cannotPay?' · '+textHtml(t('ui.unavailable')):''}${supply?`<br>${textHtml(supply)}`:''}</div>`+
    ((cableTool(tool) || plainBelt(tool)) && anchors.length>1?button('退一步','back-path'):'')+
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
    pathMessage='ui.noBuildPath';
    say(t(pathMessage),true);
    return false;
  }
  anchors=[...prefix,...suffix]; beltFacing=false;
  return true;
}

function extendPath(tile:number) {
  if (!cableTool(tool)) return extendBelt(tile);
  const suffix=findCablePath(limits,anchors,tile,cellId=>tool==='wire' || !!cell(data,cellId,Field.Wire));
  if (!suffix) {
    pathMessage=tool==='cut'?'ui.noConnectedCablePath':'ui.noBuildPath';
    return false;
  }
  anchors=[...anchors,...suffix];
  return true;
}

function tapPath(tile:number) {
  const last=anchors.at(-1);
  pathMessage='';
  if (!pathStarted) {
    confirmTransport=0;
    if (tile===last) pathStarted=tool!=='cut' || !!cell(data,tile,Field.Wire);
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
    else extendPath(tile);
  }
  updateDraft();
}

function startPathDrag(tile:number) {
  if (pending || !plainBelt(tool) && !cableTool(tool) || tool==='cut' && !cell(data,tile,Field.Wire)) return false;
  confirmTransport=0;
  dragOrigin={anchors,started:pathStarted,facing:beltFacing,direction,message:pathMessage};
  pathMessage='';
  if (!pathStarted || !anchors.length) {
    if (anchors.at(-1)!==tile) beltFacing=false;
    anchors=[tile];
  } else {
    const index=anchors.lastIndexOf(tile);
    if (index>=0) {
      if (index!==anchors.length-1) beltFacing=false;
      anchors=anchors.slice(0,index+1);
    } else if (!extendPath(tile)) { dragOrigin=undefined; updateDraft(); return false; }
  }
  pathStarted=true;
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
  } else if (cableTool(tool)) {
    for (const tile of dragTiles(from,to)) {
      const index=anchors.lastIndexOf(tile);
      if (index>=0) anchors=anchors.slice(0,index+1);
      else anchors.push(tile);
    }
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
  anchors=prior.anchors; pathStarted=prior.started; beltFacing=prior.facing;
  direction=prior.direction; pathMessage=prior.message;
  updateDraft();
}

function tap(tile:number) {
  if (!ready) return;
  if (dropDraft) {
    const request=dropDraft;
    const [x,y]=xy(tile);
    if (!inBounds(limits,x,y)) { say(t('errors.3'),true); return; }
    if (request.count>backpackStackCount(request)) {
      dropDraft=undefined; say(t('errors.9'),true); refresh(); return;
    }
    submit({op:Op.DropHeld,a:tile,b:request.item,c:request.count},count=>{
      if (dropDraft===request) dropDraft=undefined;
      say(t('ui.dropped',{item:ITEM[request.item],count}));
    });
    return;
  }
  if (tool!==undefined) {
    if (pending) return;
    if (plainBelt(tool) || cableTool(tool)) { tapPath(tile); return; }
    if (typeof tool==='number' && overlapsDraft(tile) || tool==='remove' && ghost.cells.some(part=>part.tile===tile)) {
      confirmDraft(); return;
    }
    confirmTransport=0;
    if (typeof tool==='number' && isTransport(tool) && !anchors.length && isTransport(cell(data,tile,Field.Kind))) {
      direction=cell(data,tile,Field.Direction);
    }
    if (tool==='capture') {
      if (anchors.length===2) anchors=[];
      anchors.push(tile);
    } else anchors=[tile];
    updateDraft(); return;
  }
  groundTile=-1;
  const anchor=machineAnchor(data,tile);
  if (anchor>=0) tile=anchor;
  if (renderer && renderer.camera.zoom<13) {
    const cam=renderer.camera;
    cam.aim(cam.x,cam.y,19);
  }
  selected=tile;
  manualWork=false;
  inspectingTile=!!cell(data,tile,Field.Kind) || (mode!=='build' && !!cell(data,tile,Field.Ore));
  focus=-1; traced=[];
  if (inspectingTile) setPanel(true);
  refresh();
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
  const finish=()=>{
    focus=-1;
    clearDraft(); mode=isStamp||keepCatalog?'build':'view'; inspectingTile=false;
    if (!keepCatalog) setPanel(true);
    refresh();
  };
  if (plan.command && submit(plan.command,finish)) updateDraft();
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
  if (mode==='view' && manualWork) {
    return [t('ui.operations'),t('ui.handcraft'),handcraftPanel()];
  }
  if (mode==='view' && groundTile>=0) return groundPanel(groundTile);
  if (mode==='view' || (inspectingTile && tool===undefined)) {
    const kind=selected<0?0:cell(data,selected,Field.Kind);
    if (kind===Kind.Station) return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
    if (kind===Kind.Yard) return yardPanel();
    if (kind) return devicePanel(kind);
    if (selected>=0 && cell(data,selected,Field.Ore)) return [t('ui.oreDeposit'),ITEM[cell(data,selected,Field.Ore)],actions(harvestButton(selected))];
  }
  if (mode==='orbit') return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
  if (mode==='build') return buildPanel();
  return ['操作','选择设备','<p class="lead">点地图上的设备、矿点或输送带。</p>'];
}

function referenceContent() {
  if (referencePage==='task') return missionPanel();
  return ['',t('ui.guide'),(Object.keys(handbook) as (keyof typeof handbook)[]).filter(
    id=>visibleGuide(data,id)).map(id=>guideEntry(id,true)).join('')];
}

function pickGround(pile:GroundPile) {
  if (tool!==undefined || dropDraft) return;
  submit({op:Op.PickGround,a:pile.tile,b:pile.item,c:pile.id},count=>{
    const remaining=groundPiles(data).get(pile.tile)?.find(row=>row.id===pile.id)?.count ?? 0;
    say(t(remaining?'ui.groundPickedPartial':'ui.received',{item:ITEM[pile.item],count,remaining}));
  });
}

function openGroundMarker(tiles:number[]) {
  if (!ready || pending || tool!==undefined || dropDraft) return;
  if (tiles.length>1) {
    const camera=renderer?.camera;
    const [x,y]=xy(tiles[0]);
    camera?.aim(x+.5,y+.5,Math.min(limits.maxZoom,40));
    return;
  }
  const tile=tiles[0], piles=groundPiles(data).get(tile) ?? [];
  if (piles.length===1) pickGround(piles[0]);
  if (piles.length<2) return;
  groundTile=tile;
  mode='view'; inspectingTile=false; manualWork=false;
  closeInfo(); setPanel(true); refresh();
}

function groundPanel(tile:number) {
  const entries=(groundPiles(data).get(tile) ?? []).map(({item,id,count})=>
    `<div class="ground-picker-row"><span>${itemIcon(item)}${textHtml(ITEM[item])} ×${count}</span>`+
    button(t('ui.pickGround'),`pick-ground-${tile}-${item}-${id}`)+`</div>`);
  return [coordinates(tile),t('ui.groundItems'),entries.length?
    `<div class="ground-picker">${entries.join('')}</div>`:`<p class="lead">${textHtml(t('ui.groundEmpty'))}</p>`];
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
    const detail=t(legacy?'tutorial.warehouseKitsLegacy':'tutorial.warehouseKits');
    return ['曙港 · 扩建','做出第一套扩建设备',`<p class="lead">${textHtml(detail)}</p>`];
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
  if (data[Meta.Modules]<=city) return task('把镜阵延伸到'+name,textHtml(t('ui.regionalLaunchGoal')),`${data[Meta.Modules]} / ${city+1}`);
  return task(city===1?'点亮谷东':'连续点亮谷东与西岭',city===1?'校准芯到站后，在「轨道」发起第一场跨谷照明。':'从「轨道」安排相邻窗口。谷东窗口结束三秒后，西岭接班。');
}

function yardPanel():string[] {
  const city=CITY.findIndex((_,n)=>n>0 && [CityField.Sender,CityField.Receiver].some(field=>cityValue(data,n,field)===selected));
  const v=(field:CityField)=>cityValue(data,city,field);
  const sending=selected===v(CityField.Sender);
  return ['跨谷班线 · '+CITY[city],sending?'曙港发货站':CITY[city]+'到货站',
    '<p class="lead">'+(sending?'将物料带接入本站，或把手中物料装箱。':'把当地输送带接到出料箭头上，通向地面站或加工设备。')+'</p>'+
    readings([['距下班发车',time(data[Meta.Headway]-data[Meta.Tick]%data[Meta.Headway])],['单程',time(data[Meta.Travel])],
      [t('ui.freightInTransit'),t('ui.containerUsage',{used:v(CityField.InTransitSlots),slots:data[Meta.CrateSlots]})],['当地已接收',v(CityField.Delivered)+' 件']])+
    readings(machineLayoutRows(selected,Kind.Yard))+machineSlots(selected,Kind.Yard)+
    actions(sending?'':button('预览末端短带','lastmile-'+city,true),
      sending?button('查看到货站','receiver-'+city):iconButton('旋转出料口','rotate-device','rotate'))];
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
    reserves+=slotRow(name+'校准芯',itemSlot('display',6,contents(data,v(CityField.Site),6),{tile:v(CityField.Site),
      context:data[Meta.Stage]>=Stage.Acceptance?`下一轮准备 ${v(CityField.CoreReserve)} 枚`:''}));
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
    actions(...cities.map((name,n)=>button(name+'地面站','site-'+n)),...(city>0?[button('发货站','sender-'+city),button('到货站','receiver-'+city)]:[]),gridShortcut(site))];
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
    actions(nextButton,gridShortcut(STATION))+
    machineSlots(STATION,Kind.Station)+readings([...machineLayoutRows(STATION,Kind.Station),...devicePower(data,STATION,Kind.Station)])+
    readings([['主网当前可给',mw(dispatch)]])+
    (inOrbit?readings([['试照需求','24 秒 · 12 MW'],['运行耗料','1 枚 / 秒']]):'')+
    (phase===2?bar(24*HZ-data[Meta.WindowTicks],24*HZ):'')+
    (inOrbit&&!data[Meta.FirstLight] ? `<p class="lead">为蓄电池留出充电时间。地面站的进料带须在整个窗口持续补给。</p>`:'')];
}

function isGenerator(kind:number) { return kind===Kind.Generator || kind===Kind.Solar; }

function gridGenerator(origin:number) {
  const group=cell(data,origin,Field.Grid);
  return group?nearest(origin,i=>cell(data,i,Field.Grid)===group && isGenerator(cell(data,i,Field.Kind))):-1;
}

function gridShortcut(origin:number) {
  return gridGenerator(origin)>=0?button('查看电网','power-map'):'';
}

function gridDetails(group:number) {
  if (!group) return signal('未接入电网');
  const faults:number[]=[];
  const faultView=viewSection(data,ViewSection.Faults);
  for (let i=faultView?.[0] ?? 0;i<(faultView?.[1] ?? W*H) && faults.length<5;i++) {
    const tile=faultView?data[i]:i;
    if ((faultView || cell(data,tile,Field.Status)===3) && cell(data,tile,Field.Grid)===group) faults.push(tile);
  }
  const index=(viewSection(data,ViewSection.Grids)?.[0] ?? HEADER+W*H*STRIDE)+group*4;
  const rows:[string,string][]=[['电网总发电',mw(data[index])],['请求负荷',mw(data[index+1])],
    ['电池可放电',mw(data[index+2])],['电网储能',energyMj(data[index+3]).toFixed(1)+' MJ']];
  return `<section class="grid-details"><h3>供电区 #${group}</h3>`+readings(rows)+
    (faults.length ? `<div class="fault-list">${faults.map(i=>`<button type="button" class="button" data-fault="${i}">${textHtml(MACHINE[cell(data,i,Field.Kind)].name)}<small>${coordinates(i)} · 缺电</small></button>`).join('')}</div>`:'')+
    (unlocked(data,Kind.Battery)?actions(button('预览蓄电池','battery')):'')+'</section>';
}

function machineSlots(tile:number,kind:Kind) {
  if (tile<0 || cell(data,tile,Field.Kind)!==kind) return '';
  const slots=deviceAt(data,tile)?.slots ?? [];
  const {inputSlots,outputSlots,storageSlots}=content.machines[kind];
  const label=(title:string,items:SlotData[],capacity:number)=>{
    const used=items.reduce((sum,slot)=>sum+Math.ceil(slot.count/slot.stack),0);
    return textHtml(`${title} · ${t('ui.containerUsage',{used,slots:capacity})}`);
  };
  const stock=(role:string,items:SlotData[],keepEmpty:boolean)=>{
    const {entries,pager}=stackPage(`device-${tile}-${deviceIdentity(tile)}-${role}`,items,keepEmpty);
    return entries.map(({item:slot,index})=>itemSlot(slot.role,slot.item,stackCount(slot.count,slot.stack,index),
      {tile,slot,stackIndex:index})).join('')+pager;
  };
  if (kind===Kind.Depot || kind===Kind.Yard) {
    const warehouse=kind===Kind.Depot;
    const canPut=warehouse || CITY.some((_,city)=>city>0 && cityValue(data,city,CityField.Sender)===tile);
    const title=warehouse?t('ui.warehouseStock'):canPut?'装箱':'到货';
    return `<div class="slot-row"${canPut?` data-container data-tile="${tile}" data-identity="${deviceIdentity(tile)}"`:''}>
      <span class="slot-label">${label(title,slots,storageSlots)}</span>
      <div class="slots">${stock('storage',slots,false)}
        ${canPut?`<button type="button" class="container-put" data-container-put>${textHtml(t('ui.putInStorage'))}</button>`:''}
      </div></div>`;
  }
  const input=slots.filter(slot=>slot.role==='input'), output=slots.filter(slot=>slot.role==='output');
  return slotRow(label('进料',input,input.length*inputSlots),stock('input',input,true))+
    slotRow(label('出料',output,outputSlots),stock('output',output,true))+
    slotRow('速度模块',stock('module',slots.filter(slot=>slot.role==='module'),true));
}

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
      (interactive && cargo?slotRow('带上货物',itemSlot('cargo',cargo.item,1,{tile,context:`${name} · ${flow}`,track:cargo})+
        `<button type="button" class="button" data-action="take-cargo" data-tile="${tile}" data-lane="${lane}" data-item="${cargo.item}" data-cargo-id="${cargo.id}" data-identity="${cargo.identity}" aria-label="从${name}取走${textHtml(ITEM[cargo.item])}">取走</button>`):''));
  }
  return rows.join('');
}

function transportRating(kind:number) {
  const entry=design(kind);
  return entry?.interval?`${entry.interval<0?-entry.interval:content.contentHz/entry.interval*60} 件/分钟/通道 · ${entry.lanes} 条通道`:'';
}

function modeAvailable(next:NavigationPage) {
  return next!=='orbit' || data[Meta.Stage]>=Stage.Launch;
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
  if (kind===Kind.DevelopmentHub) {
    const camera=renderer?.camera;
    const digits={maximumFractionDigits:1};
    const min=(camera?.minZoom ?? limits.minZoom).toLocaleString(language(),digits);
    const max=(camera?.maxZoom ?? limits.maxZoom).toLocaleString(language(),digits);
    return [`设备检查 · ${coordinates(selected)}`,'阶段交付站',
      readings([...machineLayoutRows(selected,kind),['已完成阶段',limits.tier],['背包占用',t('ui.backpack',{used:limits.used,slots:limits.slots})],['堆叠上限',t('ui.individualStacks')],['时间倍速上限',`${limits.speed}×`],
        [t('ui.zoomRange'),t('ui.zoomRangeValue',{min,max})],['开放地图',`${limits.right-limits.left} × ${limits.bottom-limits.top} 格`]])+
      signal(textHtml(t(limits.tier===0?'ui.nextDevelopmentStage':'ui.allDevelopmentStages')))+
      actions(iconButton('拆除设备','remove','hammer'))];
  }
  const device=machineText(kind), status=cell(data,selected,Field.Status), cfg=cell(data,selected,Field.Config);
  const inventory:(readonly [string,string|number])[]=[];
  const actual=deviceAt(data,selected);
  const group=cell(data,selected,Field.Grid);
  const transport=isTransport(kind);
  if (transport) inventory.push(['额定吞吐',transportRating(kind)]);
  else inventory.push(...machineLayoutRows(selected,kind));
  if (kind===Kind.Depot) {
    inventory.push([t('ui.warehouseMode'),cfg?t('ui.warehouseExport',{item:ITEM[cfg]}):t('ui.warehouseReceive')]);
  }
  if (kind===Kind.Splitter) inventory.push(['分流',cfg?'直行优先':'轮流分配']);
  inventory.push(['方向',DIRECTION[cell(data,selected,Field.Direction)]]);
  if (actual?.grade) {
    const rating=design(kind);
    inventory.push(['矿种',ITEM[actual.ore]]);
    if (rating?.ticks) inventory.push(['采矿速率',`${(rating.amount*HZ/rating.ticks).toFixed(2)} 件/秒`]);
  }
  if (unlocked(data,Kind.Cable) && !isGenerator(kind) && (design(kind)?.demand || design(kind)?.batteryPower))
    inventory.push(['供电区',group?`#${group}`:'未连接']);
  const hasPriority=(actual?.grade ?? 0)>=2 || content.machines[kind]?.processing;
  if (hasPriority) inventory.push(['供电顺序',['普通','优先','最高'][cfg]]);
  return [`设备检查 · ${coordinates(selected)}`,deviceName(kind),`<div class="device-summary">${machineIcon(kind)}<p class="lead">${textHtml(device.detail)}</p></div>`+
    (transport?'':signal(STATUS[status],status>=2&&status<=4))+recipePicker(selected,kind)+machineCycle(selected,kind)+readings([...inventory,...devicePower(data,selected,kind)])+
    (transport?transportReadout(selected,kind,true):machineSlots(selected,kind))+
    (isGenerator(kind)?gridDetails(group):'')+
    actions(cell(data,selected,Field.Ore)?harvestButton(selected):'',iconButton('旋转设备','rotate-device','rotate'),
      hasPriority && data[Meta.Stage]>=Stage.Expand?button('切换优先级','configure'):'',
      kind===Kind.Splitter?button('切换分流','configure'):'',
      kind===Kind.Depot && data[Meta.Stage]>=Stage.Expand?button(t('ui.warehouseConfigure'),'configure'):'',
      kind!==Kind.Generator && kind!==Kind.Battery && kind!==Kind.Solar ? button('沿货流定位','trace-cargo'):'',
      unlocked(data,Kind.Cable)&&!transport&&!group?iconButton('接线','wire','cable'):'',
      iconButton('拆除设备','remove','hammer'))];
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
  return requirements.map(({item,count})=>{
    const available=constructionAvailable(data,item);
    return `<p class="requirement${available<count?' missing':''}">${itemIcon(item)}<span>${textHtml(ITEM[item])} <b>${available} / ${count}</b></span></p>`;
  }).join('');
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
        [button('开通'+name+'班线 · '+data[Meta.LineCost]+' 结构件','line-'+city,false,constructionAvailable(data,4)<data[Meta.LineCost])];
    });
    const removeTools=(unlocked(data,Kind.Cable)?iconButton('拆除电缆','cut','cut-cable',tool==='cut'):'')+
      iconButton('拆除设备','remove-tool','hammer',tool==='remove');
    return ['建造','建筑目录',buildCatalog()+(lines.length?actions(...lines):''),removeTools,tabs];
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
  const stock=new Map(deviceAt(data,tile)?.slots.filter(slot=>slot.count>0).map(slot=>[slot.item,slot.count]));
  if (!stock.size) return `<p>${textHtml(t('ui.emptyMachineStock'))}</p>`;
  return `<div class="quick-stock">${[...stock].map(([item,count])=>
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
    const {role,item,count,canPut,canTake}=slot;
    const quantityHint=t('ui.adjustSlotQuantity');
    const take=t(count?'ui.takeToBackpackHint':'ui.emptySlot');
    const help:Record<SlotRole,string>={
      held:count?[t('ui.putFromBackpackHint'),quantityHint].join(' '):'',
      input:[
        canPut?t(anchor.dataset.room==='false'?'ui.noSlotRoom':'ui.feedFromBackpack',{item:ITEM[item]}):t('ui.automaticFeed'),
        ...(canTake?(count?[take,quantityHint]:[take]):[]),
      ].join(' '),
      output:canTake?(count?[take,quantityHint].join(' '):take):t('ui.automaticPickup'),
      module:[t('ui.moduleEffect'),count?take:t('ui.installFromBackpack')].join(' '),
      cargo:take,
      display:'',
    };
    const description=itemDescription(item);
    const stack=Number(anchor.dataset.stack ?? stackLimit(data,item));
    html=`<strong>${textHtml(ITEM[item])} <span class="quick-count">×${count}</span></strong>`+
      (description?`<p>${textHtml(description)}</p>`:'')+
      (anchor.dataset.context?`<p>${textHtml(anchor.dataset.context)}</p>`:'')+
      ((role==='held' || role==='input' || role==='output')?`<p>${textHtml(t('ui.stackCapacity',{limit:stack}))}</p>`:'')+
      (help[role]?`<p>${textHtml(help[role])}</p>`:'')+
      (infoPinned && count>1 && sameSlot(selectedItem,slot)?button(selectedItem?.quantity?`数量 ${selectedItem.quantity}`:'指定数量','transfer-amount'):'')+
      (infoPinned && role==='held' && count>0?button(t('ui.dropTitle'),`drop-item-${item}-${slot.stackIndex}`):'');
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

type TransferTarget=Pick<Slot,'role'|'item'|'tile'|'identity'|'canPut'>;

function availableInSlot(source:Selection) {
  if (source.role==='held') return backpackStackCount(source);
  const device=deviceAt(data,source.tile);
  if (device?.identity!==source.identity) return 0;
  const slot=device.slots.find(slot=>slot.canTake && slot.role===source.role && slot.item===source.item);
  return slot?stackCount(slot.count,slot.stack,source.stackIndex):0;
}

function transferSlot(source:Selection,target:TransferTarget) {
  const {role,item,tile,identity,canPut}=target;
  const insert=source.role==='held' && (role==='input' || role==='module') && canPut;
  const extract=role==='held' && (source.role==='input' || source.role==='output' || source.role==='module' || source.role==='cargo');
  if (!insert && !extract) return false;
  if (source.item!==item) {
    say('所选物料与槽位不符。',true);
    return false;
  }
  if (source.role==='cargo') return takeCargo(source.tile,source.lane,item,source.cargoId,source.identity);
  const available=availableInSlot(source);
  if (!available) return false;
  return submit({op:Op.Transfer,a:source.tile,b:tile,c:item,
    words:[Math.min(source.quantity ?? available,available),source.identity,identity,source.role==='module'||role==='module'?3:source.role==='input'?1:2]},quantity=>{
    selectedItem=undefined;
    say(t(role==='module'?'ui.installed':role==='input'?'ui.inserted':'ui.received',{item:ITEM[item],count:quantity}));
  });
}

function transferToContainer(source:Selection,{tile,identity}:ContainerTarget) {
  return transferSlot(source,{role:tile===-1?'held':'input',item:source.item,tile,identity,canPut:true});
}

function takeCargo(tile:number,lane:number,item:number,cargoId:number,identity:number) {
  return submit({op:Op.TakeCargo,a:tile,b:lane,c:item,words:[cargoId,identity]},()=>{
    selectedItem=undefined;
    say(t('ui.received',{item:ITEM[item],count:1}));
  });
}

function openInventory() {
  if (panel.dataset.expanded!=='true') return undefined;
  const container=readContainer(panelBody.querySelector('[data-container]'));
  if (container) return container;
  const slot=panelBody.querySelector<HTMLButtonElement>('[data-slot="input"],[data-slot="output"],[data-slot="module"]');
  return slot?readSlot(slot):undefined;
}

function sameDevice(slot:InventoryDevice | undefined,device:InventoryDevice) {
  return slot?.tile===device.tile && slot.identity===device.identity;
}

function quickTransfer(slot:Slot) {
  if (!slot.count) return;
  if (slot.role==='held') {
    const container=readContainer(panelBody.querySelector('[data-container]'));
    if (container) {
      if (transferToContainer(slot,container)) closeInfo();
      return;
    }
    const target=panelBody.querySelector<HTMLButtonElement>(`button[data-item="${slot.item}"][data-put="true"]`);
    if (target && transferSlot(slot,readSlot(target))) closeInfo();
  } else if (slot.canTake && transferSlot(slot,{role:'held',item:slot.item,tile:-1,identity:0,canPut:false})) {
    closeInfo();
  }
}

function activateSlot(anchor:HTMLButtonElement,event:MouseEvent) {
  const slot=readSlot(anchor), {role,item,canPut}=slot;
  const device=event.detail>0 && role!=='cargo' && role!=='display'?openInventory():undefined;
  const previous=inventoryClick;
  inventoryClick=undefined;
  if (device && previous && sameDevice(device,previous.device) && sameSlot(previous.slot,slot) &&
      event.timeStamp-previous.at<=INVENTORY_DOUBLE_CLICK_MS) {
    quickTransfer(slot);
    return;
  }
  previous?.singleTransfer?.();
  const click:InventoryClick | undefined=device?{slot,device,at:event.timeStamp}:undefined;
  inventoryClick=click;
  const source=selectedItem;
  const shouldTransfer=source && ((role==='held' && source.role!=='held' && source.item===item) ||
    ((role==='input' || role==='module') && canPut && source.role==='held' && source.item===item));
  if (shouldTransfer && source) {
    if (click) {
      // A second click turns this into a full-stack transfer from the clicked slot.
      click.singleTransfer=()=>{
        if (selectedItem===source && sameDevice(openInventory(),click.device)) transferSlot(source,slot);
      };
      window.setTimeout(()=>{
        if (inventoryClick!==click) return;
        inventoryClick=undefined;
        click.singleTransfer?.();
      },INVENTORY_DOUBLE_CLICK_MS);
    } else transferSlot(source,slot);
  } else if (canSelectSlot(slot)) {
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
  const containerFocused=active && element.contains(active) && active.hasAttribute('data-container-put')?readContainer(active):undefined;
  element.innerHTML=html;
  if (key) element.querySelector<HTMLButtonElement>(`[data-quick="${key}"]`)?.focus({preventScroll:true});
  else if (recipeFocused) element.querySelector<HTMLButtonElement>('[data-action^="toggle-handcraft-"]')?.focus({preventScroll:true});
  else if (containerFocused) {
    const target=element.querySelector<HTMLButtonElement>('[data-container-put]');
    if (sameDevice(readContainer(target),containerFocused)) target?.focus({preventScroll:true});
  }
}

function renderBalances() {
  const items:(Material & {stack:number})[]=[];
  for (let item=1;item<content.items.length;item++) {
    const count=held(data,item);
    if (count>0) items.push({item,count,stack:stackLimit(data,item)});
  }
  const {entries,pager}=stackPage('held',items);
  const key=entries.map(({item,index})=>`${item.item}:${index}`).join(',')+pager;
  if (key!==balanceItems) {
    fill(balances,'<button type="button" class="capacity container-put" id="backpack-capacity" data-container-put></button>'+
      entries.map(({item,index})=>itemSlot('held',item.item,stackCount(item.count,item.stack,index),{stackIndex:index})).join('')+pager);
    balanceItems=key;
  }
  const capacity=byId('backpack-capacity');
  if (capacity) {
    const label=t('ui.backpack',{used:limits.used,slots:limits.slots});
    if (capacity.textContent!==label) {
      capacity.textContent=label;
      capacity.setAttribute('aria-label',`${t('ui.putInBackpack')} · ${label}`);
    }
    capacity.title=t('ui.individualStacks');
    capacity.dataset.full=String(limits.used>=limits.slots);
  }
  for (const [i,anchor] of balances.querySelectorAll<HTMLButtonElement>('[data-slot="held"]').entries()) {
    const {item,index}=entries[i];
    const count=stackCount(item.count,item.stack,index);
    const pressed=sameSlot(selectedItem,readSlot(anchor));
    if (anchor.getAttribute('aria-pressed')!==String(pressed)) anchor.setAttribute('aria-pressed',String(pressed));
    const amount=amountBadge(pressed,count);
    if (anchor.dataset.selectedCount!==amount) anchor.dataset.selectedCount=amount;
    if (anchor.dataset.count===String(count)) continue;
    anchor.dataset.count=String(count);
    anchor.querySelector('.item-count')!.textContent=String(count);
    anchor.setAttribute('aria-label',slotLabel('held',item.item,count));
  }
}

function refresh(force=true) {
  if (!ready) return;
  renderBalances();
  byId('ground-drop-hint').hidden=!dropDraft;
  if (dropDraft) {
    byId('ground-drop-context').textContent=t('ui.dropHint',{item:ITEM[dropDraft.item],count:dropDraft.count});
  }
  byId('clock').textContent=time(data[Meta.Tick]);
  const activePage=operationPage();
  for (const nav of pageButtons) {
    const page=nav.dataset.mode as NavigationPage;
    const active=page==='task' || page==='guide'
      ? drawerOpen.reference && page===referencePage
      : drawerOpen.factory && page===activePage;
    nav.hidden=!modeAvailable(page);
    nav.setAttribute('aria-pressed',String(active));
  }
  if (force || (!panelPointer && performance.now()-lastPanelRender>220)) {
    if (referencePanel.dataset.expanded==='true') {
      const [tag,title,html]=referenceContent();
      byId('reference-tag').textContent=tag; byId('reference-title').textContent=title;
      fill(referenceBody,html);
    }
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
  const site=selected>=0 && cell(data,selected,Field.Kind)===Kind.Station?selected:STATION;
  const tile=gridGenerator(site);
  if (tile<0) return;
  clearDraft(); mode='view'; manualWork=false; inspectingTile=false; selected=tile; focus=tile; traced=[];
  renderer?.camera.focus(tile); setPanel(true); refresh(); panelBody.scrollTop=0;
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
  const zoom=Math.max(cam.minZoom,data[Meta.Stage]<Stage.Expand?Math.min(cam.width/8,48):28);
  const openDrawer=panel.dataset.expanded==='true'?panel:referencePanel;
  const drawerOffset=portraitDrawer.matches && openDrawer.dataset.expanded==='true'?openDrawer.offsetHeight/2:0;
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

byId<HTMLFormElement>('drop-form').addEventListener('submit',event=>{
  event.preventDefault();
  const count=byId<HTMLInputElement>('drop-quantity').valueAsNumber;
  if (!dropSource || !Number.isInteger(count) || count<1 || count>backpackStackCount(dropSource)) return;
  clearDraft(); closeInfo(); harvest.stop(); handcraft.stop();
  selectedItem=undefined; groundTile=-1;
  dropDraft={...dropSource,count};
  dropDialog.close();
  setPanel(false);
  refresh();
});

function onAction(action:string) {
  const dropAction=/^drop-item-(\d+)-(\d+)$/.exec(action);
  if (dropAction) {
    const [,item,stackIndex]=dropAction.map(Number);
    dropSource={item,stackIndex};
    const count=backpackStackCount(dropSource);
    if (count<=0) return;
    byId('drop-material').textContent=ITEM[item];
    const input=byId<HTMLInputElement>('drop-quantity');
    input.max=String(count); input.value='1';
    dropDialog.showModal();
    input.select();
    return;
  }
  const stackPageAction=/^stack-page-(held|device-\d+-\d+-(?:storage|input|output|module))-(\d+)$/.exec(action);
  if (stackPageAction) {
    inventoryPages.set(stackPageAction[1],Number(stackPageAction[2]));
    refresh();
    return;
  }
  const pickup=/^pick-ground-(\d+)-(\d+)-(\d+)$/.exec(action);
  if (pickup) {
    const [,tile,item,id]=pickup.map(Number);
    const pile=groundPiles(data).get(tile)?.find(row=>row.item===item && row.id===id);
    if (pile) pickGround(pile);
    return;
  }
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
      if (tool===Kind.Belt && !pending) { pathStarted=true; extendBelt(v(CityField.Site)); updateDraft(); }
    }
    if (verb==='cable') {cam?.focus(v(CityField.Site)); buildTab='catalog'; choose('wire',v(CityField.Site),true);}
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
    case 'close-drop-dialog': dropDialog.close(); return;
    case 'cancel-drop': dropDraft=undefined; refresh(); return;
    case 'home': home(); return;
    case 'manual-work': selectMode('view',!manualWork); return;
    case 'zoom-in': if (cam) cam.scale(cam.width/2,cam.height/2,1.25); return;
    case 'zoom-out': if (cam) cam.scale(cam.width/2,cam.height/2,.8); return;
    case 'speed': setSpeed(speed===0 || speed>=limits.speed?1:speed*2); return;
    case 'pause': setSpeed(speed?0:1); return;
    case 'power-map': powerMap(); return;
    case 'trace-cargo': traceCargo(); return;
    case 'battery': previewOnGrid(Kind.Battery); return;
    case 'wire': buildTab='catalog'; choose('wire',selected,true); return;
    case 'cut': case 'remove-tool': case 'remove': {
      const next=action==='cut'?'cut':'remove';
      if (tool===next) { onAction('cancel-draft'); return; }
      buildTab='catalog'; choose(next,selected,true); return;
    }
    case 'capture': if (data[Meta.FirstLight]) { buildTab='blueprints'; choose('capture'); } return;
    case 'dismiss-blueprint': blueprintDialog.close(); return;
    case 'transfer-amount': {
      if (!selectedItem) return;
      const {quantity}=selectedItem;
      const available=availableInSlot(selectedItem);
      if (!available) return;
      const input=byId<HTMLInputElement>('transfer-quantity');
      input.max=String(available); input.value=String(Math.min(quantity ?? available,available));
      transferDialog.showModal(); input.select(); return;
    }
    case 'dismiss-quantity': transferDialog.close(); return;
    case 'back-path': if (!pending) { confirmTransport=0; anchors.pop(); beltFacing=false; pathMessage=''; updateDraft(); } return;
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
      const choices=kind===Kind.Depot?content.items.length:kind===Kind.Splitter?2:3;
      submit({op:Op.Configure,a:selected,b:(cfg+1)%choices}); return;
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
      inventoryPages.clear();
      clearDraft(); closeInfo(); selectedItem=undefined; dropDraft=undefined; groundTile=-1;
      selected=-1; focus=-1; traced=[]; mode='view'; inspectingTile=false; manualWork=false; recenter=true;
      resetDrawers();
      buildTab='catalog';
      worker.postMessage({type:'reset'}); worker.postMessage({type:'save'}); dialog.close(); return;
    }
  }
}

document.addEventListener('click',event=>{
  const target=event.target as Element;
  const el=target.closest<HTMLButtonElement>('button');
  if (!el?.dataset.slot) inventoryClick=undefined;
  if (target!==canvas && !el?.dataset.quick && !quickInfo.contains(target)) closeInfo();
  if (!el || el.disabled || !ready) return;
  if (el.dataset.slot) activateSlot(el,event);
  else if (el.hasAttribute('data-container-put')) {
    const container=readContainer(el);
    if (selectedItem && container) transferToContainer(selectedItem,container);
  }
  else if (el.dataset.tool) {
    const next=el.dataset.tool==='wire'?'wire':Number(el.dataset.tool);
    if (tool===next) { onAction('cancel-draft'); return; }
    if (el.dataset.unavailable!=='true') choose(next,selected,true);
    revealInfo(el,true);
  }
  else if (el.dataset.mode) togglePage(el.dataset.mode as NavigationPage);
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
portraitDrawer.addEventListener('change',()=>{ syncDrawers(); refresh(); });
panelBody.addEventListener('pointerdown',()=>{panelPointer=true;});
window.addEventListener('pointerup',()=>{panelPointer=false;});
window.addEventListener('pointercancel',()=>{panelPointer=false;});
window.addEventListener('blur',()=>{panelPointer=false;});

window.addEventListener('keydown',event=>{
  if (blueprintDialog.open || transferDialog.open || dropDialog.open) return;
  if (event.key==='Escape' && dropDraft) { dropDraft=undefined; refresh(); return; }
  if (event.key==='Escape' && referencePanel.dataset.expanded==='true' && !dialog.open &&
      (referencePanel.contains(event.target as Node) || activeDrawer==='reference' && !panel.contains(event.target as Node))) {
    setDrawer('reference',false); refresh(); return;
  }
  if (event.key==='Escape' && tool!==undefined && !dialog.open) { onAction('cancel-draft'); return; }
  if (event.key==='Escape' && (infoKey || infoTile>=0 || selectedItem)) {
    closeInfo(); selectedItem=undefined; refresh(); return;
  }
  if (!ready || dialog.open || event.ctrlKey || event.metaKey || (event.target as Element).matches('button,input,select')) return;
  if (event.key==='Escape') { clearDraft(); refresh(); }
  if (event.key==='Enter' && tool!==undefined) { event.preventDefault(); confirmDraft(); }
  if (event.key.toLowerCase()==='r' && tool!==undefined) onAction('rotate-draft');
  const shortcuts:Record<string,NavigationPage|undefined>={'1':'view','2':'build','4':'orbit','5':'task','6':'guide'};
  const next=shortcuts[event.key];
  if (next) selectMode(next);
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
  if (message.type==='snapshot-layout') {
    const started=startViewDecode();
    snapshotLayout=new SnapshotLayout(new Int32Array(message.buffer),W,H);
    finishViewDecode('layout',started);
    return;
  }
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
    const decodeStarted=startViewDecode();
    const wasLit=data[Meta.FirstLight], wasComplete=data[Meta.Complete], oldStage=data[Meta.Stage], previous=data.buffer;
    const next=new Int32Array(message.buffer);
    if (message.scoped) {
      if (!snapshotLayout) throw new Error('Snapshot received before its layout');
      attachView(next,snapshotLayout);
    }
    if (speed || next[Meta.Tick]!==data[Meta.Tick]) {
      lastSnapshot=performance.now();
      if (!speed) pausedPhase=0;
    }
    data=next;
    const oldLimits=limits;
    limits=progression(data);
    finishViewDecode('frame',decodeStarted);
    const cam=renderer?.camera;
    const boundsChanged=oldLimits.left!==limits.left || oldLimits.top!==limits.top ||
      oldLimits.right!==limits.right || oldLimits.bottom!==limits.bottom;
    if (cam && (!ready || boundsChanged || oldLimits.tier!==limits.tier || oldLimits.regional!==limits.regional)) {
      cam.bounds=limits;
      cam.aim(cam.x,cam.y);
    }
    if (!ready || recenter || boundsChanged || oldStage!==data[Meta.Stage]) refreshOreLabels();
    if (speed>limits.speed) setSpeed(limits.speed);
    if (ready && previous instanceof ArrayBuffer) worker.postMessage({type:'recycle',buffer:previous},[previous]);
    if (!ready) {
      ready=true; loading.hidden=true; app.setAttribute('aria-busy','false');
      if (reviewScene==='miner' || reviewScene==='assembly') {
        selected=firstMachine(data,reviewScene==='miner'?Kind.SimpleMiner:Kind.Bench);
        if (selected>=0) mode='view';
      } else if (reviewScene==='handcraft') {
        mode='view'; manualWork=true;
      }
      if (selected>=0 || manualWork) setPanel(true);
      else setDrawer('reference',!landscapeDock.matches && (data[Meta.Stage]<Stage.Expand || window.matchMedia('(min-width: 901px) and (min-height: 521px)').matches));
      refresh();
      if (legacyCleanup) worker.postMessage({type:'save'});
    } else {
      refresh(message.immediate || oldStage!==data[Meta.Stage]);
    }
    if (recenter) {
      if (terminalReview) cam?.aim(55,41,32);
      else home();
      recenter=false;
    }
    if (!wasLit && data[Meta.FirstLight] && data[Meta.Sun]) {
      say('曙港第一次看见日出');
      if (mode==='orbit' && cam) cam.aim(38,11.6);
    }
    if (!wasComplete && data[Meta.Complete]) say('四条厂段已交付 · 谷东请求开通班线');
    if (oldStage!==Stage.Victory && data[Meta.Stage]===Stage.Victory) {
      say('三城连续迎来第三轮日出'); selectReference('task');
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
    inventoryPages.clear();
    clearDraft(); closeInfo(); selectedItem=undefined; dropDraft=undefined; groundTile=-1;
    mode='view'; focus=-1; selected=-1; traced=[]; inspectingTile=false; manualWork=false; recenter=true;
    resetDrawers();
    buildTab='catalog';
    worker.postMessage({type:'save'}); dialog.close(); say('已恢复存档'); return;
  }
  if (message.type==='invalid-save') {
    const reason=message.status===-25?ERRORS[-25]:t(message.startup?'ui.invalidAutoSave':'ui.invalidSave');
    reportSaveError(reason);
  }
};
worker.onerror=()=>fail('模拟没有启动。请刷新页面后重试。');

function mapLabel() {
  const element=document.createElement('span');
  element.className='map-label';
  element.hidden=true;
  byId('map-labels').append(element);
  return element;
}

const cityLabels=[
  { x:44, y:5.2, stage:Stage.Launch }, { x:48, y:22.1, stage:Stage.Valley }, { x:8, y:22.1, stage:Stage.Highland },
].map((label,city)=>{
  const element=mapLabel();
  element.textContent=CITY[city]+'城';
  return {...label,city,element};
});
let oreLabels:{x:number;y:number;element:HTMLSpanElement}[]=[];

function refreshOreLabels() {
  for (const label of oreLabels) label.element.remove();
  oreLabels=[];
  const first=data[Meta.FirstOre], [startX,startY]=xy(first);
  const closest=new Map<number,{x:number;y:number;distance:number}>();
  for (let y=limits.top;y<limits.bottom;y++) for (let x=limits.left;x<limits.right;x++) {
    const tile=at(x,y), ore=cell(data,tile,Field.Ore);
    if (!ore || tile===first) continue;
    const distance=(x-startX)**2+(y-startY)**2;
    if (distance<(closest.get(ore)?.distance ?? Infinity)) closest.set(ore,{x:x+.5,y:y-.35,distance});
  }
  for (const [ore,{x,y}] of closest) {
    const element=mapLabel();
    const nameKey=ore===3?'ui.coalDeposit':content.items[ore]?.nameKey;
    if (nameKey) { element.dataset.i18n=nameKey; element.textContent=t(nameKey); }
    oreLabels.push({x,y,element});
  }
}

function positionMapLabel(cam:Renderer['camera'],element:HTMLSpanElement,x:number,y:number,visible:boolean) {
  const [sx,sy]=cam.toScreen(x,y);
  element.hidden=!visible || sx<=24 || sy<=(sx<157?88:41) || sx>=cam.width-26 || sy>=cam.height-42;
  if (!element.hidden) element.style.transform=`translate(${Math.round(sx)}px,${Math.round(sy)}px) translate(-50%,-100%)`;
}

const viewPadding=2+Math.max(...content.machines.flatMap(({width,height})=>[width,height]));
function requestView(cam:Renderer['camera']) {
  if (fullSnapshot) return;
  const [left,top]=cam.toWorld(0,0), [right,bottom]=cam.toWorld(cam.width,cam.height);
  const lower=(edge:number)=>Math.max(0,Math.floor((edge-viewPadding)/8)*8);
  const upper=(edge:number,limit:number)=>Math.min(limit,Math.ceil((edge+viewPadding)/8)*8);
  const scope=[lower(left),lower(top),upper(right,W),upper(bottom,H),selected,infoTile,groundTile,selectedItem?.tile ?? -1];
  if (scope.some((word,i)=>word!==lastView[i])) {
    lastView=scope;
    worker.postMessage({type:'view',scope});
  }
}

function draw(now:number) {
  harvest.tick(now);
  handcraft.tick(now);
  if (renderer) {
    if (ready) {
      const cam=renderer.camera, tile=harvest.mapTile();
      requestView(cam);
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
      renderer.render({data,mode,preview:ghost.cells,cableEditing:cableTool(tool),selected,focus,trace:traced,now,tick:data[Meta.Tick]+animationPhase(now),
        chipTile:gainTile,chip:gain.hidden?0:(gainUntil-now)/750});
      groundMarkers.render(data,cam,tool===undefined && !dropDraft);
    }
    const cam=renderer.camera;
    for (const {x,y,element} of oreLabels) positionMapLabel(cam,element,x,y,ready);
    for (const {x,y,stage,city,element} of cityLabels) {
      positionMapLabel(cam,element,x,y,ready && data[Meta.Stage]>=stage && inBounds(limits,x,y));
      element.dataset.bright=(data[Meta.LitMask] & (1<<city))?'yes':'no';
    }
  }
  requestAnimationFrame(draw);
}

applyTranslations();

try {
  renderer=new Renderer(canvas);
  if (terminalReview) window.addEventListener('terminal-profile-camera', event => {
    const {x,y,zoom}=(event as CustomEvent<{x:number;y:number;zoom:number}>).detail;
    renderer?.camera.aim(x,y,zoom);
  });
  if (terminalReview) window.addEventListener('terminal-profile-probe', event => {
    const {tile,pick,reply}=(event as CustomEvent<{
      tile:number; pick?:boolean;
      reply(value:unknown):void;
    }>).detail;
    if (pick) tap(tile);
    reply({tick:data[Meta.Tick],selected,visible:viewHasTile(data,tile),kind:cell(data,tile,Field.Kind),
      grid:cell(data,tile,Field.Grid),wire:cell(data,tile,Field.Wire),
      status:cell(data,tile,Field.Status),device:deviceAt(data,tile),recipe:selectedRecipe(data,tile),
      cargo:cargoAt(data,tile,0)});
  });
  bindMapInput(canvas,renderer.camera,{
    tap,
    inspect:inspectMap,
    canRotateDraft,
    rotateDraft,
    canRotateAt:tile=>!pending && canRotateDraft() && overlapsDraft(tile),
    rotateAt,
    startHarvest:(tile,pointer)=>harvest.start(tile,undefined,pointer),
    stopHarvest:harvest.stop,
    canDragRoute:()=>!pending && (plainBelt(tool) || cableTool(tool)),
    startRoute:startPathDrag,
    route:drawPath,
    finishRoute:finishPathDrag,
  });
  const legacy=legacyBlueprint();
  const url=new URL(`${import.meta.env.BASE_URL}sim.wasm`,document.baseURI).href;
  void resumeSave().then(
    save=>worker.postMessage({type:'init',url,signature:content.signature,save,legacy,fullSnapshot}),
    error=>reviewScene
      ? fail(error instanceof Error ? error.message : '无法载入视觉评审场景。')
      : worker.postMessage({type:'init',url,signature:content.signature,legacy,fullSnapshot}),
  );
  if (!terminalReview) window.setInterval(()=>{ if (ready && !document.hidden) worker.postMessage({type:'save'}); },8000);
  document.addEventListener('visibilitychange',()=>{
    if (!ready) return;
    if (document.hidden) worker.postMessage({type:'save'});
    worker.postMessage({type:'speed',speed:document.hidden?0:speed});
  });
  requestAnimationFrame(draw);
} catch (error) { fail(error instanceof Error?error.message:'无法启动渲染器'); }
