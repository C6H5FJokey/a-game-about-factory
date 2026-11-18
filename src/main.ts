import './style.css';
import { bindMapInput, orthogonal } from './input';
import { bindHarvestHold } from './harvest-hold';
import { bindInventoryDrag, canSelectSlot, readSlot, sameSlot, type Selection, type Slot, type SlotRole } from './inventory-drag';
import {
  DIRECTION, ERRORS, Field, H, HEADER, HZ, ITEM, Kind, MACHINE, Meta, Op,
  STATION, STATUS, STEP, STRIDE, Stage, W, SPEED_MODULE, at, cell, drillTool, held, inBounds, isTransport, plainBelt, progression, mw, time, unlocked, xy, CITY, CityField, cityValue, knownItems,
  type Command, type Mode, type PreviewCell, type Tool,
} from './model';
import { Renderer } from './renderer';
import { contents, firstMachine, workshopLesson } from './campaign';
import { clearLegacyBlueprint, downloadSave, legacyBlueprint, persistSave, resumeSave, reviewScene } from './storage';
import { actionIcon, itemIcon, machineIcon } from './icons';
import { devicePower, designPower } from './power-readout';
import { cargoAt, design, deviceAt, drillVariant, layoutRevision, preparedMaterials, readBlueprints, readDirectory, transportPorts, type Blueprint, type CargoTrack, type Material, type SlotData } from './sim-data';

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
let gainUntil=0, gainTile=-1, recenter=true;
const oreAction=byId<HTMLButtonElement>('ore-action'), gain=byId('ore-gain'), lesson=byId('lesson');
let traced:[number,number][]=[];
let anchors:number[]=[], direction=0, verticalFirst=false, lastSnapshot=0, lastPanelRender=0;
let pausedPhase=0;
let blueprints:Blueprint[]=[];
let stamping:Pick<Blueprint,'id'|'version'> | undefined;
let blueprintEdit:{ action:'capture'|'rename'|'delete'; id?:number } | undefined;
let legacyCleanup=false;
let buildTab:'catalog'|'blueprints'='catalog';
let speed=1, exportPending=false, manualSave=false, noticeTimeout=0, commitTimeout=0;
let pending:((result:number)=>void) | undefined, panelPointer=false;
let previewSequence=0;
let transportPreview:{key:string;request:number;cargoKey:string;result?:Int32Array} | undefined;

type Draft = { cells:PreviewCell[]; command?:Command; materials:Material[]; label:string; conflict:boolean; capture?:boolean };
let ghost:Draft={cells:[],materials:[],label:'',conflict:false};

let selectedItem:Selection | undefined;
let infoKey='', infoPinned=false, infoTile=-1;
let balanceItems='';

const slotKey=(role:SlotRole,item:number,tile:number,lane=0)=>`slot-${role}-${item}-${tile}-${lane}`;
const slotArt=(item:number,count:number)=>itemIcon(item)+`<span class="item-count">${count}</span>`;
const slotLabel=(role:SlotRole,item:number,count:number)=>`${({held:'持有',input:'进料',output:'出料',module:'模块槽',cargo:'带上货物',display:'库存'})[role]} · ${ITEM[item]} · ${count}`;
const deviceIdentity=(tile:number)=>deviceAt(data,tile)?.identity ?? 0;
const slotSelected=(role:SlotRole,item:number,tile:number,track?:CargoTrack)=>selectedItem?.role===role && selectedItem.item===item && selectedItem.tile===tile && selectedItem.identity===(track?.identity ?? deviceIdentity(tile)) && selectedItem.cargoId===(track?.id ?? 0);
const amountBadge=(role:SlotRole,item:number,tile:number,track?:CargoTrack)=>(slotSelected(role,item,tile,track)?selectedItem?.quantity:undefined);
const slotData=(role:SlotRole,item:number,count:number,tile:number,lane=0)=>`data-slot="${role}" data-item="${item}" data-tile="${tile}" data-count="${count}" data-quick="${slotKey(role,item,tile,lane)}" aria-label="${slotLabel(role,item,count)}"`;
const itemSlot=(role:SlotRole,item:number,count:number,tile=-1,context='',slot?:SlotData,track?:CargoTrack)=>`
  <button type="button" class="item-slot" ${slotData(role,item,count,tile,(track?.location ?? 0)%2)}
    ${slot?`data-identity="${deviceIdentity(tile)}" data-capacity="${slot.capacity}" data-put="${slot.canPut}" data-take="${slot.canTake}"`:''}
    ${track?`data-identity="${track.identity}" data-lane="${track.location%2}" data-cargo-id="${track.id}" data-take="true"`:''}
    ${role==='held'||slot?.canTake||track?`aria-pressed="${slotSelected(role,item,tile,track)}" data-selected-count="${amountBadge(role,item,tile,track) ?? ''}"`:''}
    ${context?`data-context="${context}"`:''}>${slotArt(item,count)}</button>`;
const slotRow=(title:string,slots:string)=>slots?`<div class="slot-row"><span class="slot-label">${title}</span><div class="slots">${slots}</div></div>`:'';

const button=(name:string,action:string,primary=false,disabled=false)=>
  `<button type="button" class="button${primary?' primary':''}" data-action="${action}"${disabled?' disabled':''}>${name}</button>`;
const iconButton=(name:string,action:string,icon:Parameters<typeof actionIcon>[0])=>
  `<button type="button" class="button icon-button icon-button--${icon}" data-action="${action}" aria-label="${name}" title="${name}">${actionIcon(icon)}</button>`;
const harvestMeter='<span class="harvest-meter" aria-hidden="true"><span class="harvest-fill"></span></span>';
const harvestButton=(name:string,tile:number)=>
  tile<0?'':`<button type="button" class="button harvest-button" data-gather="${tile}">长按${name}${harvestMeter}</button>`;
const readings=(rows:(readonly [string,string|number])[])=>
  `<dl class="readings">${rows.map(([name,value])=>`<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
const signal=(message:string,fault=false)=>`<p class="signal${fault?' fault':''}">${message}</p>`;
const actions=(...buttons:string[])=>`<div class="actions">${buttons.join('')}</div>`;
const bar=(n:number,max:number)=>`<div class="bar" role="progressbar" aria-label="进度" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${Math.min(n,max)}"><span style="width:${Math.min(100,n/max*100)}%"></span></div>`;
const coordinates=(tile:number)=>{const [x,y]=xy(tile);return `${x}, ${y}`;};

const harvest=bindHarvestHold(app,{
  available:tile=>ready && speed>0 && tool===undefined && tile>=0 && !!cell(data,tile,Field.Ore) &&
    !dialog.open && !blueprintDialog.open && !transferDialog.open,
  gather:gatherAt,
  mapButton:tile=>!oreAction.hidden && Number(oreAction.dataset.gather)===tile?oreAction:undefined,
});
bindInventoryDrag(app,byId('item-drag'),{
  selected:()=>selectedItem,
  select:source=>{ selectedItem=source; closeInfo(); refresh(); },
  drop:transferSlot,
  art:itemIcon,
});
const textHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
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

function selectMode(next:Mode) {
  if (!modeAvailable(next)) return;
  clearDraft();
  mode=next;
  inspectingTile=false;
  traced=[];
  setPanel(true);
  refresh();
  panelBody.scrollTop=0;
}

function clearDraft() {
  tool=undefined; anchors=[];
  transportPreview=undefined;
  ghost={cells:[],materials:[],label:'',conflict:false};
  canvas.removeAttribute('data-tool');
  draft.hidden=true;
}

function choose(next:Tool,anchor=-1) {
  if (typeof next==='number' && !unlocked(data,next)) return;
  tool=next; anchors=anchor>=0?[anchor]:[]; direction=0; verticalFirst=false;
  inspectingTile=false;
  mode=next==='wire' || next==='cut' ? 'power' : 'build';
  closeInfo(); canvas.dataset.tool='active';
  setPanel(false);
  updateDraft(); refresh();
}

function badPlacement(tile:number,kind:number) {
  if (tile<0) return true;
  const [x,y]=xy(tile);
  if (!inBounds(limits,x,y) || kind && !unlocked(data,kind)) return true;
  if (kind && cell(data,tile,Field.Kind)) return true;
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
    transportPreview={key,request:++previewSequence,cargoKey};
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
  if (typeof tool==='number') return MACHINE[tool].name;
  return ({wire:'铺电缆',stamp:activeBlueprint()?.name ?? '蓝图',capture:'框选蓝图',remove:'拆除设备',cut:'拆除电缆','valley-line':'谷东班线','highland-line':'西岭班线'} as const)[tool ?? 'wire'];
}

function createDraft():Draft {
  const result:Draft={cells:[],materials:[],label:'',conflict:false};
  const last=anchors.at(-1) ?? -1;
  if (tool===undefined) return result;
  if (tool==='valley-line' || tool==='highland-line') {
    const city=tool==='valley-line'?1:2;
    const sites=[CityField.Sender,CityField.Receiver].map(f=>cityValue(data,city,f));
    result.cells=sites.map(tile=>({tile,kind:Kind.Yard,dir:0,conflict:Boolean(cell(data,tile,Field.Kind))}));
    result.conflict=result.cells.some(c=>c.conflict);
    result.materials=buildMaterials(Kind.Yard); result.label='两端各建一座站场 · 每班 '+data[Meta.CrateSize]+' 件';
    result.command={op:Op.OpenLine,a:city}; return result;
  }
  if (tool==='wire' || plainBelt(tool)) {
    const wire=tool==='wire';
    const tier=Number(tool);
    result.label=anchors.length?'可继续点转折或确认':'点起点，再点终点';
    const tiles=orthogonal(anchors,verticalFirst);
    const duplicate=new Set(tiles).size!==tiles.length;
    const words:number[]=[];
    let newTiles=0;
    for (const [i,tile] of tiles.entries()) {
      const kind=cell(data,tile,Field.Kind), start=i===0, end=i===tiles.length-1;
      const next=tiles[i+1], prev=tiles[i-1];
      let dir=direction;
      const from=next===undefined ? prev : tile, to=next??tile;
      if (from!==undefined && from!==to) {
        const [x,y]=xy(from),[nx,ny]=xy(to);
        const found=STEP.findIndex(([dx,dy])=>dx===nx-x && dy===ny-y);
        if (found>=0) dir=found;
      }
      if (!wire && tiles.length>1 && (start||end) && kind!==Kind.Empty && !plainBelt(kind)) continue;
      const conflict=duplicate;
      result.cells.push({tile,dir,kind:wire?0:tier,wire,conflict});
      result.conflict ||= conflict;
      if (wire ? !cell(data,tile,Field.Wire) : kind===Kind.Empty) newTiles++;
      words.push(tile,dir);
    }
    if (!wire) return transportDraft(result);
    const entry=design(Kind.Cable);
    if (entry && newTiles) result.materials=entry.materials.map(({item,count})=>({item,count:count*Math.ceil(newTiles/entry.span)}));
    if (words.length) result.command={op:Op.Route,a:Number(wire),words};
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
    for (const part of entry.parts) {
      let [dx,dy,kind,dir,wire]=part;
      for (let i=0;i<direction;i++) [dx,dy]=[-dy,dx];
      dir=(dir+direction)%4;
      const tile=at(x+dx,y+dy),conflict=badPlacement(tile,kind);
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
      const wire=tool==='cut',kind=cell(data,last,Field.Kind);
      result.conflict=wire?!cell(data,last,Field.Wire):!kind || [Kind.Station,Kind.Yard].includes(kind);
      result.cells=[{tile:last,kind:0,dir:0,wire,conflict:true}];
      result.command={op:Op.Remove,a:last,b:Number(wire)};
      result.label=`拆除 ${wire?'电缆':MACHINE[kind].name} · ${coordinates(last)}`;
    }
    return result;
  }
  result.label='点格子调整放置位置';
  if (typeof tool==='number' && isTransport(tool)) {
    if (last>=0) result.cells=[{tile:last,kind:tool,dir:direction}];
    return transportDraft(result);
  }
  result.materials=buildMaterials(tool);
  if (last>=0) {
    result.conflict=badPlacement(last,tool);
    const variant=drillTool(tool)?drillVariant(data,last,tool):undefined;
    if (drillTool(tool)) {
      const reason=cell(data,last,Field.Kind)?'目标格已占用':variant && result.conflict?'矿种尚未开放':'';
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
  const path=plainBelt(tool) || tool==='wire';
  const cannotPay=!affordable(ghost.materials);
  const info=ghost.conflict && !(typeof tool==='number' && drillTool(tool)) && tool!=='capture' && tool!=='stamp' && !(typeof tool==='number' && isTransport(tool))
    ? '目标被占用、路线重叠或矿点不匹配' : ghost.label;
  const cost=ghost.materials.map(({item,count})=>` <span class="inline-cost${held(data,item)<count?' missing':''}" aria-label="${ITEM[item]} ${held(data,item)} / ${count}">${itemIcon(item)}${held(data,item)} / ${count}</span>`).join('');
  const canConfirm=Boolean(ghost.command || ghost.capture) && !ghost.conflict && !cannotPay && !pending;
  draft.hidden=false;
  const html=`<div class="draft-text"><strong>${textHtml(activeToolText())}${cost}</strong> · ${info}${cannotPay?' · 材料不足':''}</div>`+
    (path && anchors.length>1?button('换弯','turn-path')+button('退一步','back-path'):'')+
    (canRotateDraft()?iconButton('旋转','rotate-draft','rotate'):'')+
    button('取消','cancel-draft')+button(tool===Kind.SimpleMiner?'安放':tool==='capture'?'保存蓝图':'确认','confirm-draft',true,!canConfirm);
  if (draft.innerHTML!==html) draft.innerHTML=html;
}

function canRotateDraft() {
  return tool==='stamp' || (typeof tool==='number' && (!plainBelt(tool) || anchors.length<2));
}

function rotateDraft(tile=-1,step=1) {
  if (!canRotateDraft()) return;
  if (!anchors.length && tile>=0) anchors=[tile];
  direction=(direction+step+4)%4;
  updateDraft();
}

function tap(tile:number) {
  if (!ready) return;
  if (tool!==undefined) {
    if (typeof tool==='number' && isTransport(tool) && !anchors.length && isTransport(cell(data,tile,Field.Kind))) {
      direction=cell(data,tile,Field.Direction);
    }
    if (plainBelt(tool) || tool==='wire') {
      if (anchors.at(-1)!==tile) anchors.push(tile);
    } else if (tool==='capture') {
      if (anchors.length===2) anchors=[];
      anchors.push(tile);
    } else anchors=[tile];
    updateDraft(); return;
  }
  if (data[Meta.Stage]<Stage.Expand) {
    const kind=cell(data,tile,Field.Kind);
    if (kind) inspectMap(tile,true);
    else if (cell(data,tile,Field.Ore)===1 && data[Meta.Packed]) choose(Kind.SimpleMiner,tile);
    return;
  }
  if (renderer && renderer.camera.zoom<13) {
    const cam=renderer.camera;
    cam.aim(cam.x,cam.y,19);
  }
  selected=tile;
  inspectingTile=!!cell(data,tile,Field.Kind) || (mode!=='build' && !!cell(data,tile,Field.Ore));
  focus=-1; traced=[]; setPanel(true); refresh();
  inspectMap(tile,true);
}

function submit(command:Command,done?:(result:number)=>void) {
  if (!ready || pending) return false;
  pending=done ?? (()=>{});
  worker.postMessage({type:'command',data:command});
  return true;
}

function confirmDraft() {
  if (tool===undefined || pending) return;
  const plan=createDraft();
  if (plan.conflict || !affordable(plan.materials)) return;
  if (tool==='capture' && plan.capture) { editBlueprint('capture'); return; }
  if (!plan.command) return;
  const isStamp=tool==='stamp';
  submit(plan.command,()=>{
    focus=-1;
    clearDraft(); mode=isStamp?'build':'view'; inspectingTile=false;
    if (data[Meta.Stage]>=Stage.Expand) setPanel(true);
    refresh();
  });
}

function gatherAt(tile:number) {
  const ore=cell(data,tile,Field.Ore);
  return submit({op:Op.Gather,a:tile},()=>{
    gain.textContent=ITEM[ore]+' +1'; gainTile=tile; gainUntil=performance.now()+750;
  });
}

function inspectors() {
  if (mode==='view' || (inspectingTile && tool===undefined)) {
    const kind=selected<0?0:cell(data,selected,Field.Kind);
    if (kind===Kind.Station) return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
    if (kind===Kind.Yard) return yardPanel();
    if (kind) return devicePanel(kind);
    if (selected>=0 && cell(data,selected,Field.Ore)) return ['矿点',ITEM[cell(data,selected,Field.Ore)],actions(harvestButton('采集',selected),button('任务进度','mission'))];
  }
  if (mode==='orbit') return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
  if (mode==='power') return powerPanel();
  if (mode==='build') return buildPanel();
  if (mode==='view') return ['操作','选择设备','<p class="lead">点地图上的设备、矿点或输送带。</p>'];
  return missionPanel();
}

function missionPanel() {
  if (data[Meta.Stage]>=Stage.Valley) return regionalMission();
  if (data[Meta.Stage]<Stage.Sunlight) {
    const [title,detail,...choices]=workshopLesson(data);
    return ['当前任务',title,`<p class="lead">${detail}</p>`+lessonButtons(choices)];
  }
  if (!data[Meta.KitTotal] && firstMachine(data,Kind.KitPress)<0) {
    const solar=firstMachine(data,Kind.Solar);
    if (solar<0) return ['曙港 · 首照','接住曙港的阳光','<p class="lead">太阳能阵列接上电缆，光带经过时便能为工厂供电。</p>'+
      actions(button('预览太阳能阵列','solar',true),button('生产第一套扩建设备','new-press'))];
    return ['曙港 · 扩建','做出第一套扩建设备','<p class="lead">把两块结构件送进套件装配机，再把它的产物接到建造仓。这个厂段能为下一段供应设备。</p>'+
      actions(button('安放套件装配机','new-press',true),button('查看太阳能阵列','solar'))];
  }
  const blocks=data[Meta.RequiredBlocks], kits=data[Meta.RequiredKits], seconds=data[Meta.DeliverySeconds];
  const deliveries:[string,string][]=[];
  for (let tile=0;tile<W*H;tile++) {
    if (cell(data,tile,Field.Kind)!==Kind.KitPress) continue;
    const status=!cell(data,tile,Field.Grid)?'未接线':cell(data,tile,Field.DeliveringKits)?'已交付':'等待交付';
    deliveries.push([`套件机 · ${coordinates(tile)}`,status]);
  }
  return ['任务通讯','扩建四条厂段',
    `<p class="lead">将厂段布置在铁矿点并接电。最近 ${seconds} 秒内需有 ${blocks} 台套件机各交付新套件，全厂累计到仓 ${kits} 套，便可向谷外供货。</p>`+
    readings([['近期交付厂段',`${data[Meta.Blocks]} / ${blocks}`],['新制套件累计到仓',`${data[Meta.KitTotal]} / ${kits}`],...deliveries])+
    bar(data[Meta.Blocks],blocks)+actions(button('安放套件装配机','new-press'),button('预览标准厂段','standard',true,data[Meta.Kits]<3),iconButton('铺电缆','wire','cable'))];
}

function visibleCities() {
  return data[Meta.Stage]>=Stage.Highland?3:data[Meta.Stage]>=Stage.Valley?2:1;
}
function regionalMission():string[] {
  const stage=data[Meta.Stage];
  const city=stage===Stage.Valley?1:2;
  const v=(f:CityField)=>cityValue(data,city,f);
  const name=CITY[city], site=v(CityField.Site);
  const task=(title:string,detail:string,...choices:string[])=>['当前任务',title,'<p class="lead">'+detail+'</p>'+actions(...choices)];
  if (stage===Stage.Victory) return task('三座城迎来了日出','连续三轮照明已完成，各站备好了下一轮的校准芯与储能。你可以继续扩建工厂。',button('查看三城','station',true));
  if (stage===Stage.Acceptance) return task('让三城连续运转','按曙港、谷东、西岭的顺序运行三轮。末轮收束时，每座站都要留足下一轮的准备量。',
    button('查看验收与各站准备线','station',true));
  if (cell(data,v(CityField.Sender),Field.Kind)!==Kind.Yard)
    return task('给'+name+'开通班线','本地厂段已经能交货。建一对站场，把第一箱物料送过山谷。',button('开通'+name+'班线 · '+data[Meta.LineCost]+' 结构件','line-'+city,true,data[Meta.Plates]<data[Meta.LineCost]));
  if (cell(data,site,Field.Kind)!==Kind.Station) return task('在'+name+'接货','到货站已经就位。在当地安放地面站，准备接收校准芯。',button('安放'+name+'地面站','site-'+city,true));
  if (!v(CityField.Delivered)) return task('让第一箱货抵达'+name,'在曙港发货站装入校准芯。到货后，由当地的短带把货送出站场。',button('查看发货站','sender-'+city,true),button('预览末端短带','lastmile-'+city),button('查看到货站','receiver-'+city));
  if (!cell(data,site,Field.Grid)) return task('给'+name+'地面站供电','将地面站接上现有电网，或在当地建立供电区。',button('从地面站铺电缆','cable-'+city,true));
  if (data[Meta.Modules]<=city) return task('把镜阵延伸到'+name,'在曙港备好三个镜阵模块和五份燃料，为这座城增发一组镜阵。',button('前往曙港发射台','site-0',true));
  return task(city===1?'点亮谷东':'连续点亮谷东与西岭',city===1?'校准芯到站后，跟踪第一场跨谷照明窗口。':'谷东窗口结束三秒后，西岭接班。提前为两站备好物料和电力。',
    button('查看窗口与准备情况','site-'+city,true));
}

function yardPanel():string[] {
  const city=CITY.findIndex((_,n)=>n>0 && [CityField.Sender,CityField.Receiver].some(field=>cityValue(data,n,field)===selected));
  const v=(field:CityField)=>cityValue(data,city,field);
  const sending=selected===v(CityField.Sender);
  return ['跨谷班线 · '+CITY[city],sending?'曙港发货站':CITY[city]+'到货站',
    '<p class="lead">'+(sending?'将物料带接入本站，或把手中物料装箱。':'把当地输送带接到出料箭头上，通向地面站或加工设备。')+'</p>'+
    readings([['距下班发车',time(data[Meta.Headway]-data[Meta.Tick]%data[Meta.Headway])],['每班容量',data[Meta.CrateSize]+' 件'],['单程',time(data[Meta.Travel])],
      ['在途或卸货',v(CityField.InTransit)+' 件'],['当地已接收',v(CityField.Delivered)+' 件']])+
    machineSlots(selected,Kind.Yard)+
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
    if (data[Meta.Stage]>=Stage.Acceptance) rows.push([name+'所在电网储能', (v(CityField.Stored)/200).toFixed(1)+' / '+(v(CityField.EnergyReserve)/200).toFixed(1)+' MJ']);
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
    machineSlots(site,Kind.Station)+reserves+readings([...rows,...devicePower(data,site,Kind.Station)])+
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
    machineSlots(STATION,Kind.Station)+readings(devicePower(data,STATION,Kind.Station))+
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
  if (unlocked(data,Kind.Battery)) rows.push(['电池可放电',mw(data[index+2])],['已储能',Math.floor(data[index+3]/200)+' MJ']);
  const details=group?readings(rows):signal('所选格未接通电缆',true);
  return ['电网诊断',group?'供电区 '+group:'接线检查',details+
    actions(iconButton('铺电缆','wire','cable'),unlocked(data,Kind.Battery)?button('预览蓄电池','battery'):'',button('拆电缆','cut'))+
    (faults.length ? `<div class="fault-list">${faults.map(i=>`<button type="button" class="button" data-fault="${i}">${MACHINE[cell(data,i,Field.Kind)].name}<small>${coordinates(i)} · 缺电</small></button>`).join('')}</div>`:'')+
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
        `<button type="button" class="button" data-action="take-cargo" data-tile="${tile}" data-lane="${lane}" data-item="${cargo.item}" data-cargo-id="${cargo.id}" data-identity="${cargo.identity}" aria-label="从${name}取走${ITEM[cargo.item]}">取走</button>`):''));
  }
  return rows.join('');
}

function transportRating(kind:number) {
  const entry=design(kind);
  return entry?.interval?`${HZ/entry.interval} 件/秒/通道 · ${entry.lanes} 条通道`:'';
}

function lessonButtons(choices:[string,string,boolean?][]) {
  const slots:string[]=[], buttons:string[]=[];
  for (const [name,id,disabled] of choices) {
    if (id==='feed-bench' || id==='fuel-generator') {
      const tile=firstMachine(data,id==='feed-bench'?Kind.Bench:Kind.Generator);
      const item=id==='feed-bench'?1:3;
      const slot=deviceAt(data,tile)?.slots.find(slot=>slot.role==='input' && slot.item===item);
      if (slot) slots.push(slotRow('进料',machineSlot(tile,slot)));
    } else if (id==='collect-bench' || id.startsWith('take-')) {
      const tile=id==='collect-bench'?firstMachine(data,Kind.Bench):Number(id.slice(5));
      const slot=deviceAt(data,tile)?.slots.find(slot=>slot.role==='output' && slot.canTake);
      if (slot) slots.push(slotRow('出料',machineSlot(tile,slot)));
    } else if (id==='gather-fuel' || id==='gather-silica') {
      buttons.push(harvestButton(name,nearest(data[Meta.FirstOre],tile=>cell(data,tile,Field.Ore)===(id==='gather-fuel'?3:2))));
    } else buttons.push(button(name,id,buttons.length===0,disabled));
  }
  return slots.join('')+(buttons.length?actions(...buttons):'');
}

function modeAvailable(next:Mode) {
  return data[Meta.Stage]>=({task:Stage.Expand,view:Stage.Expand,build:Stage.Expand,power:Stage.Power,orbit:Stage.Launch})[next];
}

function deviceName(kind:number) {
  const grade=design(kind)?.grade;
  return MACHINE[grade===3?Kind.ReinforcedMiner:grade===2?Kind.IndustrialMiner:kind].name;
}

function machineCycle(tile:number,kind:number) {
  const entry=design(kind);
  if (!entry?.ticks) return '';
  const hasModule=deviceAt(data,tile)?.slots.some(slot=>slot.role==='module' && slot.count>0);
  const ticks=hasModule?Math.ceil(2*entry.ticks/3):entry.ticks;
  const progress=Math.min(100,Math.round(100*cell(data,tile,Field.Progress)/ticks));
  const label=entry.grade?'采集进度':'生产进度';
  return `<div class="cycle-readout"><div><span>${label}</span><b>${progress}%</b></div>`+
    `<div class="cycle-meter" role="progressbar" aria-label="${label}" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></div>`;
}

function devicePanel(kind:number) {
  if (kind===Kind.DevelopmentHub) return [`设备检查 · ${coordinates(selected)}`,'阶段交付站',
    readings([['已完成阶段',limits.tier],['背包占用',`${limits.used} / ${limits.slots} 格`],['每格堆叠',limits.stack],['时间倍速上限',`${limits.speed}×`],
      ['缩放范围',`${limits.minZoom}–${limits.maxZoom} 像素/格`],['开放地图',`${limits.right-limits.left} × ${limits.bottom-limits.top} 格`]])+
    signal(limits.tier===0?'下一阶段 · 扩大背包与地图范围，开放重载带和强化采矿机。':'当前阶段已开放全部上限。')+
    actions(iconButton('拆除设备','remove','hammer'))];
  const device=MACHINE[kind], status=cell(data,selected,Field.Status), cfg=cell(data,selected,Field.Config);
  const inventory:(readonly [string,string|number])[]=[];
  const actual=deviceAt(data,selected);
  const group=cell(data,selected,Field.Grid);
  const transport=isTransport(kind);
  if (transport) inventory.push(['额定吞吐',transportRating(kind)]);
  if (kind===Kind.Depot) inventory.push(['收发设置',cfg?`输出${ITEM[cfg]}`:'收货']);
  if (kind===Kind.Splitter) inventory.push(['分流',cfg?'直行优先':'轮流分配']);
  inventory.push(['方向',DIRECTION[cell(data,selected,Field.Direction)]]);
  if (actual?.grade) {
    const rating=design(kind);
    inventory.push(['矿种',ITEM[actual.ore]]);
    if (rating?.ticks) inventory.push(['采矿速率',`${(rating.amount*HZ/rating.ticks).toFixed(2)} 件/秒`]);
  }
  if (data[Meta.Stage]>=Stage.Power && !transport && ![Kind.SimpleMiner,Kind.Bench,Kind.Depot].includes(kind)) inventory.push(['供电区',group?`#${group}`:'未连接']);
  const hasPriority=(actual?.grade ?? 0)>=2 || [Kind.Smelter,Kind.Grinder,Kind.Calibrator,Kind.Assembler,Kind.KitPress,Kind.Kiln].includes(kind);
  if (hasPriority) inventory.push(['供电顺序',['普通','优先','最高'][cfg]]);
  return [`设备检查 · ${coordinates(selected)}`,deviceName(kind),`<div class="device-summary">${machineIcon(kind)}<p class="lead">${device.detail}</p></div>`+
    (transport?'':signal(STATUS[status],status>=2&&status<=4))+machineCycle(selected,kind)+readings([...inventory,...devicePower(data,selected,kind)])+
    (transport?transportReadout(selected,kind,true):machineSlots(selected,kind))+
    actions(kind===Kind.SimpleMiner?harvestButton('手采铁矿',selected)+button('手制结构件','handwork',false,!held(data,1)):'',iconButton('旋转设备','rotate-device','rotate'),
      hasPriority?button('切换优先级','configure'):'',
      kind===Kind.Splitter?button('切换分流','configure'):'',
      kind===Kind.Depot?button('切换收发','configure'):'',
      kind!==Kind.Generator && kind!==Kind.Battery && kind!==Kind.Solar ? button('沿货流定位','trace-cargo'):'',
      data[Meta.Stage]>=Stage.Power&&!transport?(group?button('查看电网','power-map'):iconButton('接线','wire','cable')):'',
      iconButton('拆除设备','remove','hammer'))+
    actions(button('任务进度','mission'))];
}

function canBuild(kind:number) {
  return Boolean(design(kind)) && unlocked(data,kind) && affordable(buildMaterials(kind));
}

function materialLines(requirements:Material[]) {
  return requirements.map(({item,count})=>`<p class="requirement${held(data,item)<count?' missing':''}">${itemIcon(item)}<span>${ITEM[item]} <b>${held(data,item)} / ${count}</b></span></p>`).join('');
}

function buildCatalog() {
  const groups: [string, Kind[]][]=[
    ['开采',[Kind.SimpleMiner,Kind.IndustrialMiner,Kind.ReinforcedMiner]],
    ['加工',[Kind.Bench,Kind.Smelter,Kind.Grinder,Kind.Calibrator,Kind.Assembler,Kind.KitPress,Kind.Kiln]],
    ['物流',[Kind.Belt,Kind.FastBelt,Kind.ExpressBelt,Kind.Splitter,Kind.Merger,Kind.Crossing,Kind.Depot]],
    ['电力',[Kind.Generator,Kind.Battery,Kind.Solar]],
    ['轨道',[Kind.Station]],
    ['发展',[Kind.DevelopmentHub]],
  ];
  const entry=(kind:Kind)=>{
    const {name}=MACHINE[kind], available=canBuild(kind);
    return `<button class="tool machine-tool" type="button" data-tool="${kind}" data-quick="tool-${kind}" data-unavailable="${!available}"
      aria-label="${name}${available?'':' · 材料不足'}">${machineIcon(kind)}<span>${name}</span></button>`;
  };
  const sections=groups.map(([name,kinds])=>{
    const cable=name==='电力' && unlocked(data,Kind.Cable)
      ? `<button class="tool machine-tool" type="button" data-tool="wire" data-quick="tool-wire" data-unavailable="${!canBuild(Kind.Cable)}" aria-label="电缆">${actionIcon('cable')}<span>电缆</span></button>`
      : '';
    const entries=kinds.filter(kind=>unlocked(data,kind)).map(entry).join('')+cable;
    return entries?`<section class="tool-group"><h3>${name}</h3><div class="tool-grid">${entries}</div></section>`:'';
  }).join('');
  return sections;
}

function buildPanel() {
  const tabs=([['catalog','建筑'],['blueprints','蓝图']] as const).map(([id,label])=>
    `<button type="button" class="panel-tab" data-build-tab="${id}" aria-pressed="${buildTab===id}">${label}</button>`).join('');
  if (buildTab==='catalog') return ['建造','建筑目录',buildCatalog(),iconButton('拆除设备','remove-tool','hammer'),tabs];
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
  if (!ready || (!pin && infoPinned) || (!pin && tile===infoTile)) return;
  if (tile<0 || tool!==undefined || (!cell(data,tile,Field.Kind) &&
      (data[Meta.Stage]<Stage.Expand || !cell(data,tile,Field.Ore)))) {
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
    `<span>${itemIcon(item)}${ITEM[item]} <b>${count}</b></span>`).join('')}</div>`;
}

function syncInfo() {
  if (infoTile>=0 && renderer) {
    const kind=cell(data,infoTile,Field.Kind), ore=cell(data,infoTile,Field.Ore);
    if (!kind && !ore) { closeInfo(); return; }
    const html=`<strong>${kind?deviceName(kind):ITEM[ore]+'矿点'}</strong>`+
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
      materialLines(buildMaterials(Kind.Cable))+(infoPinned?button('选用','wire',true):'');
  } else if (anchor.dataset.tool) {
    const kind=Number(anchor.dataset.tool);
    const {name,detail}=MACHINE[kind], requirements=buildMaterials(kind);
    const enough=canBuild(kind);
    const rating=isTransport(kind)?transportRating(kind):drillTool(kind)?'采矿速率与耗电随落点矿种显示。':designPower(kind);
    html=`<strong>${name}</strong><p>${detail}</p><p>${rating}</p>`+
      (requirements.length?materialLines(requirements):'<p>已制作，可直接安放。</p>')+
      (infoPinned && enough?button('选用','choose-tool-'+kind,true):'');
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
    html=`<strong>${ITEM[item]} <span class="quick-count">×${count}</span></strong>`+
      (anchor.dataset.context?`<p>${anchor.dataset.context}</p>`:'')+
      (cap>=0?`<p>槽位容量 ${count} / ${cap}</p>`:'')+
      (role==='held'?`<p>占用 ${Math.ceil(count/limits.stack)} 格 · 每格最多 ${limits.stack} 件</p>`:'')+
      (help[role]?`<p>${help[role]}</p>`:'')+
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
    say(`${role==='module'?'已安装':role==='input'?'已送入':'已收取'} ${ITEM[item]} ×${quantity}`);
  });
}

function takeCargo(tile:number,lane:number,item:number,cargoId:number,identity:number) {
  return submit({op:Op.TakeCargo,a:tile,b:lane,c:item,words:[cargoId,identity]},()=>{
    selectedItem=undefined;
    say(`已收取 ${ITEM[item]} ×1`);
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
  if (rendered.get(element)===html || harvest.protects(element,html)) return;
  rendered.set(element,html);
  const active=document.activeElement as HTMLElement | null;
  const key=active && element.contains(active)?active.dataset.quick:undefined;
  element.innerHTML=html;
  if (key) element.querySelector<HTMLButtonElement>(`[data-quick="${key}"]`)?.focus({preventScroll:true});
}

function renderBalances(stage:number) {
  const items=stage===Stage.Gather?[]:knownItems(data).filter(item=>item>0);
  const key=items.join(',');
  if (key!==balanceItems) {
    fill(balances,items.length?items.map(item=>itemSlot('held',item,held(data,item))).join('')+
      '<span class="capacity" id="backpack-capacity"></span>':'');
    balanceItems=key;
  }
  const capacity=byId('backpack-capacity');
  if (capacity) {
    const label=`背包 ${limits.used}/${limits.slots} 格`;
    if (capacity.textContent!==label) capacity.textContent=label;
    capacity.title=`每格最多 ${limits.stack} 件，同种物品自动堆叠`;
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
  const stage=data[Meta.Stage], opening=stage<Stage.Expand;
  app.dataset.opening=String(opening);
  renderBalances(stage);
  byId('clock').textContent=time(data[Meta.Tick]);
  const activePage=inspectingTile && tool===undefined?'view':mode;
  for (const nav of document.querySelectorAll<HTMLButtonElement>('.mode')) {
    nav.hidden=!modeAvailable(nav.dataset.mode as Mode);
    nav.setAttribute('aria-pressed',String(nav.dataset.mode===activePage));
  }
  if (force || (!panelPointer && performance.now()-lastPanelRender>220)) {
    lesson.hidden=!opening || stage===Stage.Gather || tool!==undefined;
    if (!lesson.hidden) {
      const [title,detail,...choices]=workshopLesson(data);
      const html=`<strong>${title}</strong><p>${detail}</p>`+lessonButtons(choices);
      fill(lesson,html);
    } else if (!opening && lesson.childElementCount) fill(lesson,'');
    const [tag,title,html,tools='',tabs='']=inspectors();
    byId('panel-tag').textContent=tag; byId('panel-title').textContent=title;
    fill(byId('panel-tools'),tools);
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
    const kind=cell(data,current,Field.Kind), dir=cell(data,current,Field.Direction);
    const key=current*2+lane;
    if (seen.has(key)) { loop=true; break; }
    seen.add(key);
    const flow=(dir+(kind===Kind.Crossing?lane:0))%4;
    chain.push([current,flow]);
    const [x,y]=xy(current),[dx,dy]=STEP[flow];
    const next=at(x+dx,y+dy);
    if (next<0) break;
    const nextKind=cell(data,next,Field.Kind);
    if (isTransport(nextKind)) {
      const nextDirection=cell(data,next,Field.Direction);
      const lanes=design(nextKind)?.lanes ?? 0;
      let inlet=0;
      while (inlet<lanes && !(transportPorts(nextKind,nextDirection,inlet).incoming&(1<<flow))) inlet++;
      if (inlet===lanes) break;
      lane=inlet;
    }
    current=next;
    if (!isTransport(nextKind)) break;
  }
  traced=chain; focus=current;
  renderer?.camera.focus(current);
  const terminal=MACHINE[cell(data,current,Field.Kind)].name;
  say(loop?'该主路形成了回环':`主路终点 · ${terminal} · ${coordinates(current)}`);
}

function previewOnGrid(kind:Kind) {
  const origin=selected>=0 && cell(data,selected,Field.Grid)?selected:STATION;
  const group=cell(data,origin,Field.Grid);
  const tile=nearest(origin,i=>!cell(data,i,Field.Kind) && group>0 && cell(data,i,Field.Grid)===group);
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
  cam.aim(x+.5,y+.5,data[Meta.Stage]<Stage.Expand?cam.width/6:28);
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
  if (action.startsWith('choose-tool-')) {
    const kind=Number(action.slice(12));
    if (!Number.isInteger(kind) || !MACHINE[kind] || !canBuild(kind)) return;
    if (kind===Kind.SimpleMiner && !data[Meta.Packed]) onAction('craft-miner');
    else choose(kind);
    return;
  }
  const cam=renderer?.camera;
  const ore=data[Meta.FirstOre];
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
    if (verb==='lastmile') {cam?.focus(v(CityField.Receiver)+2); choose(Kind.Belt,v(CityField.Receiver)); anchors.push(v(CityField.Site)); updateDraft();}
    if (verb==='cable') {cam?.focus(v(CityField.Site)); choose('wire',v(CityField.Site));}
    if (verb==='window') submit({op:Op.Trial,a:city,b:Number(program)},()=>say('照明窗口已排定'));
    return;
  }
  switch (action) {
    case 'home': home(); return;
    case 'ore-action': tap(ore); return;
    case 'craft-miner': submit({op:Op.CraftMiner},()=>choose(Kind.SimpleMiner)); return;
    case 'site-miner': choose(Kind.SimpleMiner); return;
    case 'handwork': submit({op:Op.Handwork}); return;
    case 'site-bench': choose(Kind.Bench,ore+2); return;
    case 'first-belt': choose(Kind.Belt,ore+1); return;
    case 'new-depot': {
      const bench=firstMachine(data,Kind.Bench), [x,y]=xy(bench), [dx,dy]=STEP[cell(data,bench,Field.Direction)];
      previewAt(Kind.Depot,at(x+dx-dy,y+dy+dx)); return;
    }
    case 'second-belt': choose(Kind.Belt,firstMachine(data,Kind.Bench)); return;
    case 'new-drill': previewAt(Kind.IndustrialMiner,nearest(ore,i=>!cell(data,i,Field.Kind) && cell(data,i,Field.Ore)===1)); return;
    case 'new-generator': previewAt(Kind.Generator,nearest(ore,i=>cell(data,i,Field.Ore)===3)+1); return;
    case 'connect-drill': {
      choose('wire',firstMachine(data,Kind.Generator)); anchors.push(firstMachine(data,Kind.IronDrill)); updateDraft(); return;
    }
    case 'new-grinder': case 'new-assembler': case 'new-calibrator': case 'new-press': {
      const kind={'new-grinder':Kind.Grinder,'new-assembler':Kind.Assembler,'new-calibrator':Kind.Calibrator,'new-press':Kind.KitPress}[action];
      const existing=firstMachine(data,kind);
      if (existing>=0) { cam?.focus(existing); selected=existing; mode='view'; setPanel(true); refresh(); }
      else previewAt(kind,nearest(ore,i=>!cell(data,i,Field.Kind) && !cell(data,i,Field.Ore) && cell(data,i,Field.Wire)>0));
      return;
    }
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
    case 'solar': {
      const tile=firstMachine(data,Kind.Solar);
      if (tile<0) previewOnGrid(Kind.Solar);
      else {mode='view'; selected=tile; cam?.focus(tile); refresh();}
      return;
    }
    case 'wire': choose('wire'); return;
    case 'cut': choose('cut'); return;
    case 'remove-tool': choose('remove'); return;
    case 'remove': choose('remove',selected); return;
    case 'capture': if (data[Meta.FirstLight]) { buildTab='blueprints'; choose('capture'); } return;
    case 'standard': selectStamp(); return;
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
    case 'back-path': anchors.pop(); updateDraft(); return;
    case 'rotate-draft': rotateDraft(); return;
    case 'confirm-draft': confirmDraft(); return;
    case 'cancel-draft': {
      const returnToLibrary=tool==='capture' || tool==='stamp';
      clearDraft();
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
    revealInfo(el,true);
    if (event.detail===0) quickInfo.querySelector('button')?.focus();
  }
  else if (el.dataset.mode) selectMode(el.dataset.mode as Mode);
  else if (el.dataset.buildTab==='catalog' || el.dataset.buildTab==='blueprints') {
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
  if (event.key==='Escape' && (infoKey || infoTile>=0 || selectedItem)) {
    closeInfo(); selectedItem=undefined; refresh(); return;
  }
  if (!ready || dialog.open || event.ctrlKey || event.metaKey || (event.target as Element).matches('button,input,select')) return;
  if (event.key==='Escape') { clearDraft(); refresh(); }
  if (event.key==='Enter' && tool!==undefined) { event.preventDefault(); confirmDraft(); }
  if (event.key.toLowerCase()==='r' && tool!==undefined) onAction('rotate-draft');
  const key=Number(event.key);
  if (key>=1 && key<=5) selectMode((['view','build','power','orbit','task'] as const)[key-1]);
  if (event.key===' ' || event.key==='p') { event.preventDefault(); setSpeed(speed?0:1); }
  const pan:Record<string,[number,number]>={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]};
  if (pan[event.key]) { event.preventDefault(); renderer?.camera.pan(...pan[event.key]); }
});

function reportSaveError(reason:string) {
  byId('save-status').textContent=reason;
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
  if (message.type==='error') { fail(message.message); return; }
  if (message.type==='directory') { readDirectory(message.buffer); return; }
  if (message.type==='blueprints') { blueprints=readBlueprints(message.buffer); refresh(); return; }
  if (message.type==='transport-preview') {
    if (transportPreview && transportPreview.request===message.request) {
      transportPreview.result=new Int32Array(message.result);
      updateDraft();
    }
    return;
  }
  if (message.type==='legacy-imported') { legacyCleanup=!reviewScene; return; }
  if (message.type==='command-result') {
    const done=pending; pending=undefined;
    if (message.status<0) {
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
      setPanel(window.matchMedia('(min-width: 901px) and (min-height: 521px)').matches);
      refresh();
      if (legacyCleanup) worker.postMessage({type:'save'});
    } else {
      if (oldStage<Stage.Expand && data[Meta.Stage]>=Stage.Expand) { mode='task'; selected=-1; setPanel(true); }
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
      byId('save-status').textContent='进度已保存到此浏览器。';
      if (requested) say('进度已保存');
    }).catch(()=>{
      byId('save-status').textContent='浏览器未能保存进度，可从这里导出存档。';
      if (requested) say('本地保存失败，可导出文件。',true);
    });
    return;
  }
  if (message.type==='restored') {
    clearDraft(); closeInfo(); selectedItem=undefined; mode='task'; focus=-1; selected=-1; traced=[]; recenter=true;
    buildTab='catalog';
    worker.postMessage({type:'save'}); dialog.close(); say('已恢复存档'); return;
  }
  if (message.type==='invalid-save') {
    const reason=message.startup?'本地存档损坏或版本不兼容，已开始新战役。':'导入失败，存档损坏或版本不兼容。当前战役可继续。';
    reportSaveError(reason);
  }
};
worker.onerror=()=>fail('模拟没有启动。请刷新页面后重试。');

const mapLabels=[
  { name:'燃料矿', x:23.5, y:15.5, stage:Stage.Power }, { name:'铁矿', x:22.5, y:18.5,stage:Stage.Expand },
  { name:'硅矿', x:20.5, y:19.5,stage:Stage.Silica }, { name:'曙港城', x:44, y:5.2,stage:Stage.Launch },
  { name:'谷东城', x:48, y:22.1,stage:Stage.Valley }, { name:'西岭城', x:8, y:22.1,stage:Stage.Highland },
].map(label=>{
  const element=document.createElement('span'); element.className='map-label'; element.textContent=label.name;
  byId('map-labels').append(element); return {...label,element};
});

function showOreAction(stage:number,tile:number,stock:number) {
  if (stage<Stage.Mining) {
    if (oreAction.dataset.slot) {
      for (const key of ['slot','item','tile','count','quick','identity','capacity','put','take','selectedCount']) delete oreAction.dataset[key];
      oreAction.classList.remove('item-slot');
      oreAction.removeAttribute('aria-pressed');
      oreAction.removeAttribute('aria-label');
    }
    if (stage===Stage.PlaceMiner) {
      delete oreAction.dataset.gather;
      oreAction.classList.remove('harvest-button');
      if (oreAction.textContent!=='选择此矿点') oreAction.textContent='选择此矿点';
    } else if (oreAction.dataset.gather!==String(tile)) {
      oreAction.dataset.gather=String(tile);
      oreAction.classList.add('harvest-button');
      oreAction.innerHTML='长按采集'+harvestMeter;
    }
    return;
  }
  delete oreAction.dataset.gather;
  oreAction.classList.remove('harvest-button');
  const device=deviceAt(data,tile), output=device?.slots.find(slot=>slot.role==='output' && slot.item===1);
  if (oreAction.dataset.count!==String(stock) || Number(oreAction.dataset.tile)!==tile || Number(oreAction.dataset.identity)!==device?.identity) {
    Object.assign(oreAction.dataset,{slot:'output',item:'1',tile:String(tile),count:String(stock),quick:slotKey('output',1,tile),
      identity:String(device?.identity ?? 0),capacity:String(output?.capacity ?? -1),put:'false',take:String(output?.canTake ?? false)});
    oreAction.classList.add('item-slot');
    oreAction.setAttribute('aria-label',slotLabel('output',1,stock));
    oreAction.innerHTML=slotArt(1,stock);
  }
  const pressed=String(slotSelected('output',1,tile));
  if (oreAction.getAttribute('aria-pressed')!==pressed) oreAction.setAttribute('aria-pressed',pressed);
  const amount=String(amountBadge('output',1,tile) ?? '');
  if (oreAction.dataset.selectedCount!==amount) oreAction.dataset.selectedCount=amount;
}

function draw(now:number) {
  harvest.tick(now);
  if (renderer) {
    if (ready) {
      const tile=data[Meta.FirstOre], [x,y]=xy(tile), cam=renderer.camera;
      const [sx,sy]=cam.toScreen(x+.5,y+.5);
      const stage=data[Meta.Stage], stock=contents(data,tile,1);
      oreAction.hidden=stage>=Stage.Expand || tool!==undefined || sx<30 || sx>cam.width-30 || sy<0 || sy>cam.height-70;
      if (!oreAction.hidden) {
        showOreAction(stage,tile,stock);
        oreAction.style.transform=`translate(${sx}px,${sy+cam.zoom*.63}px) translateX(-50%)`;
      }
      gain.hidden=now>=gainUntil;
      if (!gain.hidden) {
        const [gx,gy]=xy(gainTile), [px,py]=cam.toScreen(gx+.5,gy);
        gain.style.transform=`translate(${px}px,${py-18+(gainUntil-now)/65}px) translateX(-50%)`;
      }
      renderer.render({data,mode,preview:ghost.cells,selected,focus,trace:traced,now,tick:data[Meta.Tick]+animationPhase(now),
        chip:gainTile===tile && !gain.hidden && stage<=Stage.Craft?(gainUntil-now)/750:0});
    }
    for (const {name,x,y,stage,element} of mapLabels) {
      const [sx,sy]=renderer.camera.toScreen(x,y);
      const visible=ready && data[Meta.Stage]>=stage && sx>24&&sy>(sx<157?88:41)&&sx<renderer.camera.width-26&&sy<renderer.camera.height-42;
      element.hidden=!visible;
      if (visible) element.style.transform=`translate(${Math.round(sx)}px,${Math.round(sy)}px) translate(-50%,-100%)`;
      const city=CITY.findIndex(city=>name===city+'城');
      element.dataset.bright=city>=0 && (data[Meta.LitMask] & (1<<city))?'yes':'no';
    }
  }
  requestAnimationFrame(draw);
}

try {
  renderer=new Renderer(canvas);
  bindMapInput(canvas,renderer.camera,{
    tap,
    inspect:inspectMap,
    canRotateDraft,
    rotateDraft,
    startHarvest:(tile,pointer)=>{
      if (data[Meta.Stage]<=Stage.Craft && tile===data[Meta.FirstOre]) harvest.start(tile,undefined,pointer);
    },
    stopHarvest:harvest.stop,
    canDragRoute:()=>plainBelt(tool)||tool==='wire',
    route:(from,to)=>{ anchors=from===to?[from]:[from,to]; updateDraft(); },
  });
  const legacy=legacyBlueprint();
  const url=new URL(`${import.meta.env.BASE_URL}sim.wasm`,document.baseURI).href;
  void resumeSave().then(
    save=>worker.postMessage({type:'init',url,save,legacy}),
    error=>reviewScene
      ? fail(error instanceof Error ? error.message : '无法载入视觉评审场景。')
      : worker.postMessage({type:'init',url,legacy}),
  );
  window.setInterval(()=>{ if (ready && !document.hidden) worker.postMessage({type:'save'}); },8000);
  document.addEventListener('visibilitychange',()=>{
    if (!ready) return;
    if (document.hidden) worker.postMessage({type:'save'});
    worker.postMessage({type:'speed',speed:document.hidden?0:speed});
  });
  requestAnimationFrame(draw);
} catch (error) { fail(error instanceof Error?error.message:'无法启动渲染器'); }
