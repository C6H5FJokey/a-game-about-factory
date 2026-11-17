import './style.css';
import { bindMapInput, orthogonal } from './input';
import {
  DIRECTION, ERRORS, Field, FIRST_GAP, H, HEADER, HZ, ITEM, Kind, MACHINE, Meta, Op, STANDARD,
  STATION, STATUS, STEP, STRIDE, W, at, cell, mw, time, xy,
  type Command, type Mode, type Part, type PreviewCell, type Tool,
} from './model';
import { Renderer } from './renderer';
import { downloadSave, persistSave, resumeSave } from './storage';

function byId<T extends HTMLElement = HTMLElement>(id:string) { return document.getElementById(id) as T; }

const app=byId('app'), canvas=byId<HTMLCanvasElement>('world'), loading=byId('loading');
const panel=byId('panel'), panelBody=byId('panel-body'), palette=byId('palette'), draft=byId('draft');
const dialog=byId<HTMLDialogElement>('archive-dialog'), saveFile=byId<HTMLInputElement>('save-file');
const notice=byId('notice'), tools=byId('tools');
const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
let renderer:Renderer | undefined;
let data=new Int32Array(HEADER+W*H*STRIDE);
let ready=false, mode:Mode='view', tool:Tool | undefined, selected=-1, focus=FIRST_GAP;
let traced:number[]=[];
let anchors:number[]=[], direction=0, verticalFirst=false, lastSnapshot=0, lastPanelRender=0;
let blueprint:Part[]=STANDARD, blueprintName='标准厂段', customBlueprint:Part[] | undefined;
let speed=1, exportPending=false, manualSave=false, noticeTimeout=0, commitTimeout=0;
let pending:(()=>void) | undefined, panelPointer=false;

type Draft = { cells:PreviewCell[]; command?:Command; cost:number; unit:string; label:string; conflict:boolean; capture?:Part[] };
let ghost:Draft={cells:[],cost:0,unit:'',label:'',conflict:false};

const modes:Record<Mode,string>={view:'货流视图',build:'施工视图',power:'电网视图',orbit:'轨道投光'};
const button=(name:string,action:string,primary=false,disabled=false)=>
  `<button type="button" class="button${primary?' primary':''}" data-action="${action}"${disabled?' disabled':''}>${name}</button>`;
const readings=(rows:(readonly [string,string|number])[])=>
  `<dl class="readings">${rows.map(([name,value])=>`<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
const signal=(message:string,fault=false)=>`<p class="signal${fault?' fault':''}">${message}</p>`;
const actions=(...buttons:string[])=>`<div class="actions">${buttons.join('')}</div>`;
const bar=(n:number,max:number)=>`<div class="bar" role="progressbar" aria-label="进度" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${Math.min(n,max)}"><span style="width:${Math.min(100,n/max*100)}%"></span></div>`;
const coordinates=(tile:number)=>{const [x,y]=xy(tile);return `${x}, ${y}`;};

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
  const toggle=byId('panel-toggle');
  toggle.textContent=open?'收起':'展开'; toggle.setAttribute('aria-expanded',String(open));
}

function selectMode(next:Mode) {
  const repeated=mode===next;
  mode=next;
  traced=[];
  if (next==='build') {
    palette.hidden=repeated ? !palette.hidden : false;
    setPanel(true);
  } else {
    palette.hidden=true;
    if (tool!==undefined) clearDraft();
    if (next==='orbit' || next==='power') setPanel(true);
    if (next==='view') selected=-1;
  }
  refresh();
}

function clearDraft() {
  tool=undefined; anchors=[];
  ghost={cells:[],cost:0,unit:'',label:'',conflict:false};
  canvas.removeAttribute('data-tool');
  draft.hidden=true;
}

function choose(next:Tool,anchor=-1) {
  tool=next; anchors=anchor>=0?[anchor]:[]; direction=0; verticalFirst=false;
  mode=next==='wire' || next==='cut' ? 'power' : 'build';
  palette.hidden=true; canvas.dataset.tool='active';
  if (matchMedia('(max-width:720px) and (orientation:portrait)').matches) setPanel(false);
  updateDraft(); refresh();
}

function badPlacement(tile:number,kind:number) {
  if (tile<0) return true;
  if (kind && cell(data,tile,Field.Kind)) return true;
  return kind>=Kind.IronDrill && kind<=Kind.FuelDrill && cell(data,tile,Field.Ore)!==kind-1;
}

function selectStamp() {
  blueprint=STANDARD; blueprintName='标准厂段';
  const preferred=[at(28,28),at(38,26),at(47,21),at(27,5),at(4,28),at(41,18)];
  let target=preferred.find(tile=>STANDARD.every(part=>!badPlacement(tile+part[0],part[2]))) ?? -1;
  if (target>=0) renderer?.camera.focus(target+2);
  choose('stamp',target);
}

function activeToolText() {
  if (typeof tool==='number') return MACHINE[tool].name;
  return ({wire:'铺电缆',stamp:blueprintName,capture:'框选蓝图',remove:'拆除设备',cut:'拆除电缆'} as const)[tool ?? 'wire'];
}

function captureParts(a:number,b:number):Part[] {
  const [ax,ay]=xy(a),[bx,by]=xy(b);
  const x0=Math.min(ax,bx),y0=Math.min(ay,by),x1=Math.max(ax,bx),y1=Math.max(ay,by);
  if ((x1-x0+1)*(y1-y0+1)>250) return [];
  const parts:Part[]=[];
  for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
    const tile=at(x,y),kind=cell(data,tile,Field.Kind),wire=cell(data,tile,Field.Wire);
    if ((kind || wire) && kind!==Kind.Station) parts.push([x-x0,y-y0,kind,cell(data,tile,Field.Direction),wire,cell(data,tile,Field.Config)]);
  }
  return parts;
}

function createDraft():Draft {
  const result:Draft={cells:[],cost:0,unit:'结构件',label:'',conflict:false};
  const last=anchors.at(-1) ?? -1;
  if (tool===undefined) return result;
  if (tool==='wire' || tool===Kind.Belt) {
    const wire=tool==='wire';
    result.label=anchors.length?'可继续点转折或确认':'点起点，再点终点';
    const tiles=orthogonal(anchors,verticalFirst);
    const duplicate=new Set(tiles).size!==tiles.length;
    const words:number[]=[];
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
      if (!wire && tiles.length>1 && (start||end) && kind!==Kind.Empty && kind!==Kind.Belt) continue;
      const conflict=duplicate || (!wire && kind!==Kind.Empty && kind!==Kind.Belt);
      result.cells.push({tile,dir,kind:wire?0:Kind.Belt,wire,conflict});
      result.conflict ||= conflict;
      if (wire ? !cell(data,tile,Field.Wire) : kind===Kind.Empty) result.cost++;
      words.push(tile,dir);
    }
    if (wire) result.cost=Math.ceil(result.cost/3);
    if (words.length) result.command={op:Op.Route,a:Number(wire),words};
    return result;
  }
  if (tool==='stamp') {
    result.unit='套件'; result.cost=Math.max(2,Math.ceil(blueprint.filter(part=>part[2]).length/2));
    result.label='以矿点为锚，布置后接上主网';
    if (last<0) return result;
    const [x,y]=xy(last), words:number[]=[];
    for (const part of blueprint) {
      let [dx,dy,kind,dir,wire,cfg]=part;
      for (let i=0;i<direction;i++) [dx,dy]=[-dy,dx];
      dir=(dir+direction)%4;
      const tile=at(x+dx,y+dy),conflict=badPlacement(tile,kind);
      result.cells.push({tile,kind,dir,wire:Boolean(wire),conflict}); result.conflict ||= conflict;
      words.push(dx,dy,kind,dir,wire,cfg);
    }
    result.command={op:Op.Blueprint,a:last,words};
    return result;
  }
  if (tool==='capture') {
    result.label=anchors.length===1?'点矩形的另一角':'点选两个对角格，记录建造布局';
    if (anchors.length===2) {
      result.capture=captureParts(anchors[0],anchors[1]);
      const [ax,ay]=xy(anchors[0]),[bx,by]=xy(anchors[1]);
      result.cells=[anchors[0],anchors[1],at(ax,by),at(bx,ay)].map(tile=>({tile,kind:0,dir:0}));
      if (!result.capture.length) { result.conflict=true; result.label='范围内无可复制设备，或区域超过 250 格'; }
      else result.label=`已选择 ${result.capture.length} 个布局格`;
    } else if (last>=0) result.cells=[{tile:last,kind:0,dir:0}];
    return result;
  }
  if (tool==='remove' || tool==='cut') {
    result.label='点选要拆除的格子';
    if (last>=0) {
      const wire=tool==='cut',kind=cell(data,last,Field.Kind);
      result.conflict=wire?!cell(data,last,Field.Wire):!kind || kind===Kind.Station || last===at(20,13);
      result.cells=[{tile:last,kind:0,dir:0,wire,conflict:true}];
      result.command={op:Op.Remove,a:last,b:Number(wire)};
      result.label=`拆除 ${wire?'电缆':MACHINE[kind].name} · ${coordinates(last)}`;
    }
    return result;
  }
  result.label='点格子调整放置位置';
  result.cost=MACHINE[tool].cost;
  if (last>=0) {
    result.conflict=badPlacement(last,tool);
    result.cells=[{tile:last,kind:tool,dir:direction,conflict:result.conflict}];
    result.command={op:Op.Place,a:last,b:tool,c:direction};
  }
  return result;
}

function updateDraft() {
  if (tool===undefined) return;
  ghost=createDraft();
  const path=tool===Kind.Belt || tool==='wire';
  const cannotPay=ghost.cost>data[tool==='stamp'?Meta.Kits:Meta.Plates];
  const info=ghost.conflict?'目标被占用、路线重叠或矿点不匹配':cannotPay?'建造库存不足':ghost.label;
  const cost=ghost.cost?` · ${ghost.cost} ${ghost.unit}`:'';
  const canConfirm=Boolean(ghost.command || ghost.capture?.length) && !ghost.conflict && !cannotPay && !pending;
  draft.hidden=false;
  const html=`<div class="draft-text"><strong>${activeToolText()}${cost}</strong> · ${info}</div>`+
    (path && anchors.length>1?button('换弯','turn-path')+button('退一步','back-path'):'')+
    ((typeof tool==='number' && !(tool===Kind.Belt && anchors.length>1)) || tool==='stamp'
      ? button(`转向${tool==='stamp'?'':` ${DIRECTION[direction]}`}`,'rotate-draft'):'')+
    button('取消','cancel-draft')+button(tool==='capture'?'保存蓝图':'确认','confirm-draft',true,!canConfirm);
  if (draft.innerHTML!==html) draft.innerHTML=html;
}

function tap(tile:number) {
  if (!ready) return;
  if (tool!==undefined) {
    if (tool===Kind.Belt || tool==='wire') {
      if (anchors.at(-1)!==tile) anchors.push(tile);
    } else if (tool==='capture') {
      if (anchors.length===2) anchors=[];
      anchors.push(tile);
    } else anchors=[tile];
    updateDraft(); return;
  }
  if (!cell(data,FIRST_GAP,Field.Kind) && tile===FIRST_GAP) { repair(); return; }
  if (renderer && renderer.camera.zoom<13) renderer.camera.zoom=19;
  selected=tile; focus=-1; traced=[]; setPanel(true); refresh();
}

function submit(command:Command,done?:()=>void) {
  if (!ready || pending) return;
  pending=done ?? (()=>{});
  worker.postMessage({type:'command',data:command});
}

function confirmDraft() {
  if (tool===undefined || pending) return;
  const plan=createDraft();
  if (plan.conflict || plan.cost>data[tool==='stamp'?Meta.Kits:Meta.Plates]) return;
  if (tool==='capture' && plan.capture?.length) {
    customBlueprint=plan.capture;
    try { localStorage.setItem('daybreak-blueprint',JSON.stringify(customBlueprint)); } catch { /* Session copy remains available. */ }
    clearDraft(); refresh(); say('已保存厂段蓝图'); return;
  }
  if (!plan.command) return;
  const finishedTile=anchors.at(-1) ?? -1;
  const startingRepair=finishedTile===FIRST_GAP && tool===Kind.Belt && !cell(data,FIRST_GAP,Field.Kind);
  submit(plan.command,()=>{
    focus=-1;
    clearDraft();
    if (startingRepair) {
      selected=-1;
      mode='view';
      setPanel(true);
      onAction('home');
    } else if (finishedTile>=0) selected=finishedTile;
    say('施工完成'); refresh();
  });
}

function repair() {
  focus=FIRST_GAP; renderer?.camera.focus(FIRST_GAP);
  choose(Kind.Belt,FIRST_GAP);
}

function inspectors() {
  if (mode==='orbit') return orbitPanel();
  if (mode==='power') return powerPanel();
  if (mode==='build' && tool!==undefined) {
    const detail=typeof tool==='number'?MACHINE[tool].detail:ghost.label;
    return ['施工',''+activeToolText(),`<p class="lead">${detail}</p>`+actions(button('打开建筑目录','palette'))];
  }
  const kind=selected<0?0:cell(data,selected,Field.Kind);
  if (kind===Kind.Station) return orbitPanel();
  if (kind) return devicePanel(kind);
  return missionPanel();
}

function missionPanel() {
  const fixed=cell(data,FIRST_GAP,Field.Kind)!==0, delivered=data[Meta.Delivered]>0;
  const stages=[delivered,Boolean(data[Meta.Orbit]),Boolean(data[Meta.FirstLight]),Boolean(data[Meta.Complete])];
  const next=stages.indexOf(false);
  const subject=['矿站启动','镜阵升空','曙港试照','工厂扩建工厂'];
  const checklist=`<ol class="steps">${subject.map((text,i)=>`<li class="${stages[i]?'done':next===i?'current':''}">${text}</li>`).join('')}</ol>`;
  if (data[Meta.Complete]) return ['曙港 · 通讯','第一版已通关',
    `<p class="lead">曙港已经见到日出。四条生产厂段都开始制造扩建套件，你可以继续改造这座工厂。</p>`+checklist+actions(button('查看照明轮次','station',true))];
  if (!fixed) return ['任务通讯','修复矿站',
    `<p class="lead">永夜里的第一束光，要从这条断开的铁矿输送带开始。</p>`+
    signal('铁矿输送带缺一格',true)+actions(button('定位断点','repair',true))+checklist];
  if (!data[Meta.Orbit]) return ['任务通讯',delivered?'准备发射':'矿站恢复中',
    `<p class="lead">结构件、镜片和燃料正在汇入厂区。等地面站收到 3 个镜阵模块和 5 份燃料，就能发射试验镜。</p>`+
    readings([['地面站镜阵',`${data[Meta.Mirrors]} / 3`],['地面站燃料',`${data[Meta.Fuel]} / 5`]])+
    actions(button('查看地面站','station',true))+checklist];
  if (!data[Meta.FirstLight]) return ['任务通讯','让曙港见光',
    `<p class="lead">跟踪需要连续 12 MW。火电机组为 10.8 MW，可以在主网增加一台蓄电池，提前充电。</p>`+
    actions(button('预览蓄电池','battery',true),button('试照控制台','station'))+checklist];
  return ['任务通讯','扩建四条厂段',
    `<p class="lead">把标准厂段布置在空闲铁矿点，再用电缆接到现有主网。至少四台套件机实际出料后完成首版。</p>`+
    readings([['已运行厂段',`${data[Meta.Blocks]} / 4`],['建造库存',`${data[Meta.Kits]} 套件`]])+
    bar(data[Meta.Blocks],4)+actions(button('预览标准厂段','standard',true,data[Meta.Kits]<3),button('铺电缆','wire'))+checklist];
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
    readings([['镜阵模块',`${data[Meta.Mirrors]} / 3`],['燃料',`${data[Meta.Fuel]} / 5`],['校准芯',`${data[Meta.Cores]} / 16 枚`],
      ['主网当前可给',mw(dispatch)],['试照需求','24 秒 · 12 MW'],['运行耗料','1 枚 / 秒']])+
    (phase===2?bar(24*HZ-data[Meta.WindowTicks],24*HZ):'')+
    (inOrbit&&!data[Meta.FirstLight] ? `<p class="lead">为蓄电池留出充电时间。地面站的进料带须在整个窗口持续补给。</p>`:'')+
    actions(button('任务进度','mission'))];
}

function powerPanel() {
  const group=selected>=0?cell(data,selected,Field.Grid):data[Meta.StationGrid];
  const relevant=group===data[Meta.StationGrid];
  const faults:number[]=[];
  for (let i=0;i<W*H && faults.length<5;i++) {
    if (cell(data,i,Field.Status)===3 && (group===0 || cell(data,i,Field.Grid)===group)) faults.push(i);
  }
  const named=selected>=0?MACHINE[cell(data,selected,Field.Kind)].name:'';
  const details=relevant?readings([['当前发电',mw(data[Meta.Generation])],['请求负荷',mw(data[Meta.Demand])],
    ['电池可放电',mw(data[Meta.Discharge])],['已储能',`${Math.floor(data[Meta.Stored]/200)} MJ`]]):
    signal(group?`独立供电区 ${group}`:'所选格未接通电缆',!group);
  return ['电网诊断',relevant?'曙港主网':named || `供电区 ${group}`,details+
    actions(button('铺电缆','wire',true),button('预览蓄电池','battery'),button('拆电缆','cut'))+
    (faults.length ? `<div class="fault-list">${faults.map(i=>`<button type="button" class="button" data-fault="${i}">${MACHINE[cell(data,i,Field.Kind)].name}<small>${coordinates(i)} · 缺电</small></button>`).join('')}</div>`:'')+
    actions(button('试照控制台','station'),button('任务进度','mission'))];
}

function devicePanel(kind:number) {
  const device=MACHINE[kind], status=cell(data,selected,Field.Status), cfg=cell(data,selected,Field.Config);
  const inventory:(readonly [string,string|number])[]=[];
  for (let item=1;item<ITEM.length;item++) {
    const count=cell(data,selected,Field.Inventory+item-1);
    if (count) inventory.push([ITEM[item],count]);
  }
  const group=cell(data,selected,Field.Grid);
  const onBelt=cell(data,selected,Field.Cargo);
  if (onBelt) inventory.push(['在途货物',ITEM[onBelt]]);
  if (kind===Kind.Battery) inventory.push(['已储能',`${Math.floor(cell(data,selected,Field.Energy)/200)} / 120 MJ`]);
  if (kind===Kind.Depot) inventory.push(['收发设置',cfg?`输出${ITEM[cfg]}`:'收货']);
  if (kind===Kind.Splitter) inventory.push(['分流',cfg?'直行优先':'轮流分配']);
  inventory.push(['方向',DIRECTION[cell(data,selected,Field.Direction)]]);
  if (kind!==Kind.Belt && kind!==Kind.Splitter && kind!==Kind.Depot) inventory.push(['供电区',group?`#${group}`:'未连接']);
  const hasPriority=[Kind.IronDrill,Kind.SilicaDrill,Kind.FuelDrill,Kind.Smelter,Kind.Grinder,Kind.Calibrator,Kind.Assembler,Kind.KitPress,Kind.Kiln].includes(kind);
  if (hasPriority) inventory.push(['供电顺序',['普通','优先','最高'][cfg]]);
  return [`设备检查 · ${coordinates(selected)}`,device.name,`<p class="lead">${device.detail}</p>`+
    signal(kind===Kind.Belt && status===0?'等候货物':STATUS[status],status>=2&&status<=4)+readings(inventory)+
    actions(button('旋转设备','rotate-device'),
      hasPriority?button('切换优先级','configure'):'',
      kind===Kind.Splitter?button('切换分流','configure'):'',
      kind===Kind.Depot?button('切换收发','configure'):'',
      kind!==Kind.Generator && kind!==Kind.Battery && kind!==Kind.Solar ? button('沿货流定位','trace-cargo'):'',
      group?button('查看电网','power-map'):button('接线','wire'),
      selected!==at(20,13)?button('拆除','remove'):'')+
    actions(button('任务进度','mission'))];
}

function renderPalette() {
  const buildables=[Kind.Belt,Kind.Splitter,Kind.IronDrill,Kind.SilicaDrill,Kind.FuelDrill,Kind.Smelter,Kind.Grinder,
    Kind.Calibrator,Kind.Assembler,Kind.Generator,Kind.Battery,Kind.Solar,Kind.Depot,Kind.KitPress,Kind.Kiln];
  const custom=customBlueprint ? `<button class="tool" type="button" data-action="custom"><span class="symbol">▣</span>自定义厂段</button>`:'';
  const entries=buildables.map(kind=>{
    const {name,cost,icon}=MACHINE[kind];
    return `<button class="tool" type="button" data-tool="${kind}"${kind===Kind.Kiln&&!data[Meta.FirstLight]?' disabled':''}><span class="symbol" aria-hidden="true">${icon}</span>${name}<span class="price">${cost}</span></button>`;
  }).join('');
  tools.innerHTML=entries+`<button class="tool" type="button" data-action="wire"><span class="symbol">ϟ</span>电缆</button>`+
    `<button class="tool" type="button" data-action="capture"><span class="symbol">▣</span>框选蓝图</button>`+
    `<button class="tool" type="button" data-action="standard"><span class="symbol">▤</span>标准厂段</button>`+custom+
    `<button class="tool" type="button" data-action="remove"><span class="symbol">×</span>拆除</button>`;
}

function refresh(force=true) {
  if (!ready) return;
  byId('plate-count').textContent=String(data[Meta.Plates]); byId('kit-count').textContent=String(data[Meta.Kits]);
  byId('clock').textContent=time(data[Meta.Tick]); byId('map-layer').textContent=modes[mode];
  for (const nav of document.querySelectorAll<HTMLButtonElement>('.mode')) nav.setAttribute('aria-pressed',String(nav.dataset.mode===mode));
  if (force || (!panelPointer && performance.now()-lastPanelRender>220)) {
    const [tag,title,html]=inspectors();
    byId('panel-tag').textContent=tag; byId('panel-title').textContent=title;
    if (panelBody.innerHTML!==html) panelBody.innerHTML=html;
    lastPanelRender=performance.now();
    if (!palette.hidden && force) renderPalette();
    updateDraft();
  }
}

function station() {
  clearDraft(); mode='orbit'; selected=STATION; focus=STATION; palette.hidden=true; traced=[];
  renderer?.camera.focus(STATION); setPanel(true); refresh();
}

function powerMap() {
  clearDraft(); mode='power'; palette.hidden=true; traced=[]; setPanel(true); refresh();
}

function traceCargo() {
  if (selected<0) return;
  const chain:number[]=[selected];
  let current=selected;
  let loop=false;
  for (let i=0;i<W*H;i++) {
    const [x,y]=xy(current),[dx,dy]=STEP[cell(data,current,Field.Direction)];
    const next=at(x+dx,y+dy);
    if (next<0) break;
    if (chain.includes(next)) { loop=true; break; }
    current=next; chain.push(next);
    if (![Kind.Belt,Kind.Splitter].includes(cell(data,next,Field.Kind))) break;
  }
  traced=chain; focus=current;
  renderer?.camera.focus(current);
  const terminal=MACHINE[cell(data,current,Field.Kind)].name;
  say(loop?'该主路形成了回环':`主路终点 · ${terminal} · ${coordinates(current)}`);
}

function battery() {
  const positions=[at(33,16),at(33,17),at(33,18),at(15,12),at(15,11),at(15,8)];
  const tile=positions.find(i=>!cell(data,i,Field.Kind) && cell(data,i,Field.Wire)) ?? -1;
  if (tile>=0) renderer?.camera.focus(tile);
  choose(Kind.Battery,tile);
}

function setSpeed(value:number) {
  speed=value; worker.postMessage({type:'speed',speed});
  const element=document.querySelector<HTMLButtonElement>('[data-action="speed"]')!;
  element.textContent=speed?`${speed}×`:'暂停';
  document.querySelector<HTMLButtonElement>('[data-action="pause"]')!.textContent=speed?'暂停模拟':'继续模拟';
}

function onAction(action:string) {
  const cam=renderer?.camera;
  switch (action) {
    case 'home': if (cam) { cam.x=cam.width<580?13:19.7; cam.y=17.2; } return;
    case 'zoom-in': if (cam) cam.scale(cam.width/2,cam.height/2,1.25); return;
    case 'zoom-out': if (cam) cam.scale(cam.width/2,cam.height/2,.8); return;
    case 'toggle-panel': setPanel(panel.dataset.expanded!=='true'); return;
    case 'speed': setSpeed(speed===0?1:speed===1?2:speed===2?4:1); return;
    case 'pause': setSpeed(speed?0:1); return;
    case 'station': station(); return;
    case 'mission': clearDraft(); mode='view'; selected=-1; focus=-1; traced=[]; palette.hidden=true; setPanel(true); refresh(); return;
    case 'power-map': powerMap(); return;
    case 'trace-cargo': traceCargo(); return;
    case 'battery': battery(); return;
    case 'repair': repair(); return;
    case 'palette': mode='build'; palette.hidden=false; renderPalette(); refresh(); return;
    case 'close-palette': palette.hidden=true; return;
    case 'wire': choose('wire'); return;
    case 'cut': choose('cut'); return;
    case 'remove': choose('remove',selected); return;
    case 'capture': choose('capture'); return;
    case 'standard': selectStamp(); return;
    case 'custom': if (customBlueprint) { blueprint=customBlueprint; blueprintName='自定义厂段'; choose('stamp'); } return;
    case 'turn-path': verticalFirst=!verticalFirst; updateDraft(); return;
    case 'back-path': anchors.pop(); updateDraft(); return;
    case 'rotate-draft': direction=(direction+1)%4; updateDraft(); return;
    case 'confirm-draft': confirmDraft(); return;
    case 'cancel-draft': clearDraft(); refresh(); return;
    case 'rotate-device': if (selected>=0) submit({op:Op.Rotate,a:selected}); return;
    case 'configure': {
      if (selected<0) return;
      const kind=cell(data,selected,Field.Kind),cfg=cell(data,selected,Field.Config);
      submit({op:Op.Configure,a:selected,b:(cfg+1)%(kind===Kind.Depot?9:kind===Kind.Splitter?2:3)}); return;
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
      clearDraft(); selected=-1; focus=FIRST_GAP; traced=[]; mode='view'; palette.hidden=true;
      if (cam) { cam.x=cam.width<580?13:19.7; cam.y=17.2; }
      worker.postMessage({type:'reset'}); worker.postMessage({type:'save'}); dialog.close(); return;
    }
  }
}

document.addEventListener('click',event=>{
  const el=(event.target as Element).closest<HTMLButtonElement>('button');
  if (!el || el.disabled || !ready) return;
  if (el.dataset.mode) selectMode(el.dataset.mode as Mode);
  else if (el.dataset.action) onAction(el.dataset.action);
  else if (el.dataset.tool) choose(Number(el.dataset.tool));
  else if (el.dataset.fault) { selected=Number(el.dataset.fault); focus=selected; renderer?.camera.focus(selected); refresh(); }
});
panelBody.addEventListener('pointerdown',()=>{panelPointer=true;});
window.addEventListener('pointerup',()=>{panelPointer=false;});
window.addEventListener('pointercancel',()=>{panelPointer=false;});

window.addEventListener('keydown',event=>{
  if (!ready || dialog.open || event.ctrlKey || event.metaKey || (event.target as Element).matches('button,input,select')) return;
  if (event.key==='Escape') { clearDraft(); palette.hidden=true; refresh(); }
  if (event.key==='Enter' && tool!==undefined) { event.preventDefault(); confirmDraft(); }
  if (event.key.toLowerCase()==='r' && tool!==undefined) onAction('rotate-draft');
  const key=Number(event.key);
  if (key>=1 && key<=4) selectMode((['view','build','power','orbit'] as const)[key-1]);
  if (event.key===' ' || event.key==='p') { event.preventDefault(); setSpeed(speed?0:1); }
  const pan:Record<string,[number,number]>={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]};
  if (pan[event.key]) { event.preventDefault(); renderer?.camera.pan(...pan[event.key]); }
});

saveFile.addEventListener('change',async()=>{
  const file=saveFile.files?.[0]; saveFile.value='';
  if (!file) return;
  if (file.size>200_000) { say('存档格式无效',true); return; }
  try {
    const buffer=await file.arrayBuffer(); worker.postMessage({type:'restore',buffer},[buffer]);
  } catch { say('读取存档失败',true); }
});

worker.onmessage=event=>{
  const message=event.data;
  if (message.type==='error') { fail(message.message); return; }
  if (message.type==='command-result') {
    const done=pending; pending=undefined;
    if (message.status<0) say(ERRORS[message.status] ?? '操作失败',true);
    else {
      done?.(); window.clearTimeout(commitTimeout);
      commitTimeout=window.setTimeout(()=>worker.postMessage({type:'save'}),450);
    }
    return;
  }
  if (message.type==='snapshot') {
    const wasLit=data[Meta.FirstLight], wasComplete=data[Meta.Complete], previous=data.buffer;
    data=new Int32Array(message.buffer); lastSnapshot=performance.now();
    if (ready && previous instanceof ArrayBuffer) worker.postMessage({type:'recycle',buffer:previous},[previous]);
    if (!ready) {
      ready=true; loading.hidden=true; app.setAttribute('aria-busy','false');
      if (matchMedia('(max-width:720px) and (orientation:portrait)').matches) setPanel(true);
      if (cell(data,FIRST_GAP,Field.Kind)) focus=-1;
      refresh();
    } else refresh(false);
    if (!wasLit && data[Meta.FirstLight] && data[Meta.Sun]) {
      say('曙港第一次看见日出');
      if (mode==='orbit' && renderer) { renderer.camera.x=38; renderer.camera.y=11.6; }
    }
    if (!wasComplete && data[Meta.Complete]) say('首版通关 · 曙港已见光，四条厂段已出料');
    return;
  }
  if (message.type==='save') {
    if (exportPending) { exportPending=false; downloadSave(message.buffer); }
    const requested=manualSave; manualSave=false;
    void persistSave(message.buffer).then(()=>{
      byId('save-status').textContent='进度已保存到此浏览器。';
      if (requested) say('进度已保存');
    }).catch(()=>{
      byId('save-status').textContent='浏览器未能保存进度，可从这里导出存档。';
      if (requested) say('本地保存失败，可导出文件。',true);
    });
    return;
  }
  if (message.type==='restored') {
    clearDraft(); mode='view'; focus=-1; selected=-1; traced=[]; palette.hidden=true;
    worker.postMessage({type:'save'}); dialog.close(); say('已恢复存档'); return;
  }
  if (message.type==='invalid-save') say('存档无效，当前进度可以继续。',true);
};
worker.onerror=()=>fail('模拟没有启动。请刷新页面后重试。');

const mapLabels=[
  { name:'燃料矿', x:5.5, y:6.3 }, { name:'铁矿', x:5.5, y:12.3 }, { name:'硅矿', x:5.5, y:19.3 },
  { name:'建造仓', x:20.6, y:12.2 }, { name:'地面站', x:33.5, y:14.3 }, { name:'曙港城', x:44, y:5.2 },
  { name:'预留扩建矿点', x:28.7, y:27.2 },
].map(label=>{
  const element=document.createElement('span'); element.className='map-label'; element.textContent=label.name;
  byId('map-labels').append(element); return {...label,element};
});

function draw(now:number) {
  if (renderer) {
    if (ready) renderer.render({data,mode,preview:ghost.cells,selected,focus,trace:traced,now,snapshotAt:lastSnapshot,speed});
    for (const {name,x,y,element} of mapLabels) {
      const [sx,sy]=renderer.camera.toScreen(x,y);
      const visible=sx>24&&sy>(sx<157?88:41)&&sx<renderer.camera.width-26&&sy<renderer.camera.height-42;
      element.hidden=!visible;
      if (visible) element.style.transform=`translate(${Math.round(sx)}px,${Math.round(sy)}px) translate(-50%,-100%)`;
      element.dataset.bright=name==='曙港城'&&data[Meta.FirstLight]?'yes':'no';
    }
  }
  requestAnimationFrame(draw);
}

try {
  renderer=new Renderer(canvas);
  bindMapInput(canvas,renderer.camera,{
    tap,
    canDragRoute:()=>tool===Kind.Belt||tool==='wire',
    route:(from,to)=>{ anchors=from===to?[from]:[from,to]; updateDraft(); },
  });
  try {
    const raw=JSON.parse(localStorage.getItem('daybreak-blueprint') ?? 'null') as unknown;
    if (Array.isArray(raw) && raw.length>0 && raw.length<=250 && raw.every(part=>Array.isArray(part) && part.length===6 && part.every(Number.isInteger))) {
      customBlueprint=raw as Part[];
    }
  } catch { /* An invalid optional blueprint does not affect the campaign. */ }
  const url=new URL(`${import.meta.env.BASE_URL}sim.wasm`,document.baseURI).href;
  void resumeSave().catch(()=>undefined).then(save=>worker.postMessage({type:'init',url,save}));
  window.setInterval(()=>{ if (ready && !document.hidden) worker.postMessage({type:'save'}); },8000);
  document.addEventListener('visibilitychange',()=>{
    if (!ready) return;
    if (document.hidden) worker.postMessage({type:'save'});
    worker.postMessage({type:'speed',speed:document.hidden?0:speed});
  });
  requestAnimationFrame(draw);
} catch (error) { fail(error instanceof Error?error.message:'无法启动渲染器'); }
