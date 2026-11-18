import './style.css';
import { bindMapInput, orthogonal } from './input';
import {
  DIRECTION, ERRORS, Field, H, HEADER, HZ, ITEM, Kind, MACHINE, Meta, Op, STANDARD,
  STATION, STATUS, STEP, STRIDE, Stage, W, at, cell, held, mw, time, unlocked, xy, CITY, CityField, cityValue, knownItems,
  type Command, type Mode, type Part, type PreviewCell, type Tool,
} from './model';
import { Renderer } from './renderer';
import { contents, firstMachine, inputs, outputItem, workshopLesson } from './campaign';
import { downloadSave, persistSave, resumeSave } from './storage';

function byId<T extends HTMLElement = HTMLElement>(id:string) { return document.getElementById(id) as T; }

const app=byId('app'), canvas=byId<HTMLCanvasElement>('world'), loading=byId('loading');
const panel=byId('panel'), panelBody=byId('panel-body'), palette=byId('palette'), draft=byId('draft');
const dialog=byId<HTMLDialogElement>('archive-dialog'), saveFile=byId<HTMLInputElement>('save-file');
const notice=byId('notice'), tools=byId('tools');
const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
let renderer:Renderer | undefined;
let data=new Int32Array(HEADER+W*H*STRIDE);
let ready=false, mode:Mode='view', tool:Tool | undefined, selected=-1, focus=-1;
let gainUntil=0, gainTile=-1, recenter=true;
const oreAction=byId<HTMLButtonElement>('ore-action'), gain=byId('ore-gain'), lesson=byId('lesson');
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
  if (!modeAvailable(next)) return;
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
  if (typeof next==='number' && !unlocked(data,next)) return;
  tool=next; anchors=anchor>=0?[anchor]:[]; direction=0; verticalFirst=false;
  mode=next==='wire' || next==='cut' ? 'power' : 'build';
  palette.hidden=true; canvas.dataset.tool='active';
  if (matchMedia('(max-width:720px) and (orientation:portrait)').matches) setPanel(false);
  updateDraft(); refresh();
}

function badPlacement(tile:number,kind:number) {
  if (tile<0) return true;
  if (kind && cell(data,tile,Field.Kind)) return true;
  if (kind===Kind.SimpleMiner) return cell(data,tile,Field.Ore)!==1;
  const site=CITY.findIndex((_,i)=>cityValue(data,i,CityField.Site)===tile);
  if (kind===Kind.Station || site>=0) return kind!==Kind.Station || site<0 || site>=visibleCities();
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
  return ({wire:'铺电缆',stamp:blueprintName,capture:'框选蓝图',remove:'拆除设备',cut:'拆除电缆','valley-line':'谷东班线','highland-line':'西岭班线'} as const)[tool ?? 'wire'];
}

function captureParts(a:number,b:number):Part[] {
  const [ax,ay]=xy(a),[bx,by]=xy(b);
  const x0=Math.min(ax,bx),y0=Math.min(ay,by),x1=Math.max(ax,bx),y1=Math.max(ay,by);
  if ((x1-x0+1)*(y1-y0+1)>250) return [];
  const parts:Part[]=[];
  for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
    const tile=at(x,y),kind=cell(data,tile,Field.Kind),wire=cell(data,tile,Field.Wire);
    if ((kind || wire) && ![Kind.Station,Kind.Yard,Kind.SimpleMiner].includes(kind)) parts.push([x-x0,y-y0,kind,cell(data,tile,Field.Direction),wire,cell(data,tile,Field.Config)]);
  }
  return parts;
}

function createDraft():Draft {
  const result:Draft={cells:[],cost:0,unit:'结构件',label:'',conflict:false};
  const last=anchors.at(-1) ?? -1;
  if (tool===undefined) return result;
  if (tool==='valley-line' || tool==='highland-line') {
    const city=tool==='valley-line'?1:2;
    const sites=[CityField.Sender,CityField.Receiver].map(f=>cityValue(data,city,f));
    result.cells=sites.map(tile=>({tile,kind:Kind.Yard,dir:0,conflict:Boolean(cell(data,tile,Field.Kind))}));
    result.conflict=result.cells.some(c=>c.conflict);
    result.cost=data[Meta.LineCost]; result.label='两端各建一座站场 · 每班 '+data[Meta.CrateSize]+' 件';
    result.command={op:Op.OpenLine,a:city}; return result;
  }
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
      result.conflict=wire?!cell(data,last,Field.Wire):!kind || [Kind.Station,Kind.Yard].includes(kind);
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
  const info=ghost.conflict?(tool===Kind.SimpleMiner?'放在铁矿上':'目标被占用、路线重叠或矿点不匹配'):cannotPay?ghost.unit+'不足':ghost.label;
  const cost=ghost.cost?` · ${ghost.cost} ${ghost.unit}`:'';
  const canConfirm=Boolean(ghost.command || ghost.capture?.length) && !ghost.conflict && !cannotPay && !pending;
  draft.hidden=false;
  const html=`<div class="draft-text"><strong>${activeToolText()}${cost}</strong> · ${info}</div>`+
    (path && anchors.length>1?button('换弯','turn-path')+button('退一步','back-path'):'')+
    ((typeof tool==='number' && tool!==Kind.SimpleMiner && !(tool===Kind.Belt && anchors.length>1)) || tool==='stamp'
      ? button(`转向${tool==='stamp'?'':` ${DIRECTION[direction]}`}`,'rotate-draft'):'')+
    button('取消','cancel-draft')+button(tool===Kind.SimpleMiner?'安放':tool==='capture'?'保存蓝图':'确认','confirm-draft',true,!canConfirm);
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
  if (data[Meta.Stage]<Stage.Expand) {
    const kind=cell(data,tile,Field.Kind);
    if (kind===Kind.SimpleMiner) collectAt(tile);
    else if (kind===Kind.Bench && data[Meta.Stage]===Stage.Feed) submit({op:Op.Feed,a:tile,b:1});
    else if (kind===Kind.Bench && contents(data,tile,4)) collectAt(tile);
    else if (cell(data,tile,Field.Ore)===1) {
      if (data[Meta.Packed]) choose(Kind.SimpleMiner,tile);
      else gatherAt(tile);
    }
    return;
  }
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
  submit(plan.command,()=>{
    focus=-1;
    clearDraft(); mode='view'; selected=-1;
    if (data[Meta.Stage]>=Stage.Expand) setPanel(true);
    refresh();
  });
}

function gatherAt(tile:number) {
  const ore=cell(data,tile,Field.Ore);
  submit({op:Op.Gather,a:tile},()=>{
    gain.textContent=ITEM[ore]+' +1'; gainTile=tile; gainUntil=performance.now()+750;
  });
}

function collectAt(tile:number) {
  const item=outputItem[cell(data,tile,Field.Kind)];
  const count=contents(data,tile,item);
  if (!count) return;
  submit({op:Op.Collect,a:tile},()=>{
    gain.textContent=ITEM[item]+' +'+count; gainTile=tile; gainUntil=performance.now()+900;
  });
}

function inspectors() {
  if (mode==='orbit') return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
  if (mode==='power') return powerPanel();
  if (mode==='build' && tool!==undefined) {
    const detail=typeof tool==='number'?MACHINE[tool].detail:ghost.label;
    return ['施工',''+activeToolText(),`<p class="lead">${detail}</p>`+actions(button('打开建筑目录','palette'))];
  }
  const kind=selected<0?0:cell(data,selected,Field.Kind);
  if (kind===Kind.Station) return data[Meta.Stage]>=Stage.Valley?regionalPanel():orbitPanel();
  if (kind===Kind.Yard) return yardPanel();
  if (kind) return devicePanel(kind);
  if (selected>=0 && cell(data,selected,Field.Ore)) return ['矿点',ITEM[cell(data,selected,Field.Ore)],actions(button('采集','gather-selected',true),button('任务进度','mission'))];
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
    bar(data[Meta.Blocks],blocks)+actions(button('安放套件装配机','new-press'),button('预览标准厂段','standard',true,data[Meta.Kits]<3),button('铺电缆','wire'))];
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
  const cargo=ITEM.slice(1).flatMap((name,i)=>contents(data,selected,i+1)?[[name,contents(data,selected,i+1)] as const]:[]);
  return ['跨谷班线 · '+CITY[city],sending?'曙港发货站':CITY[city]+'到货站',
    '<p class="lead">'+(sending?'将物料带接入本站，或把手中物料装箱。':'把当地输送带接到出料箭头上，通向地面站或加工设备。')+'</p>'+
    readings([['距下班发车',time(data[Meta.Headway]-data[Meta.Tick]%data[Meta.Headway])],['每班容量',data[Meta.CrateSize]+' 件'],['单程',time(data[Meta.Travel])],
      ['在途或卸货',v(CityField.InTransit)+' 件'],['当地已接收',v(CityField.Delivered)+' 件'],...cargo])+
    actions(sending?ITEM.map((name,id)=>id && held(data,id)>0?button('装入'+name,'feed-'+selected+'-'+id):'').join(''):button('预览末端短带','lastmile-'+city,true),
      sending?button('查看到货站','receiver-'+city):button('转动出料方向','rotate-device'),button('任务进度','mission'))];
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
  let start=0;
  for (const [n,name] of cities.entries()) {
    const v=(f:CityField)=>cityValue(data,n,f);
    const end=start+v(CityField.Duration);
    const interval=data[Meta.Stage]>=Stage.Acceptance?time(start)+'–'+time(end):time(v(CityField.Duration));
    rows.push([name+'窗口',interval+' · '+mw(v(CityField.Power))+' · 1 芯/秒'],
      [name+'校准芯',contents(data,v(CityField.Site),6)+' 枚'+(data[Meta.Stage]>=Stage.Acceptance?' / 准备 '+v(CityField.CoreReserve):'')]);
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
    (launch?readings([['发射台镜阵模块',data[Meta.Mirrors]+' / 3'],['发射燃料',data[Meta.Fuel]+' / 5']]):'')+
    actions(materialButtons(site,Kind.Station))+readings(rows)+
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
    actions(materialButtons(STATION,Kind.Station))+
    readings([['镜阵模块',`${data[Meta.Mirrors]} / 3`],['燃料',`${data[Meta.Fuel]} / 5`],['主网当前可给',mw(dispatch)]])+
    (inOrbit?readings([['校准芯',`${data[Meta.Cores]} / 16 枚`],['试照需求','24 秒 · 12 MW'],['运行耗料','1 枚 / 秒']]):'')+
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
    actions(button('铺电缆','wire',true),unlocked(data,Kind.Battery)?button('预览蓄电池','battery'):'',button('拆电缆','cut'))+
    (faults.length ? `<div class="fault-list">${faults.map(i=>`<button type="button" class="button" data-fault="${i}">${MACHINE[cell(data,i,Field.Kind)].name}<small>${coordinates(i)} · 缺电</small></button>`).join('')}</div>`:'')+
    actions(unlocked(data,Kind.Station)?button('地面站','station'):'',button('任务进度','mission'))];
}

function materialButtons(tile:number,kind:Kind) {
  const item=outputItem[kind];
  let html=item && contents(data,tile,item)?button(`取走${ITEM[item]} ×${contents(data,tile,item)}`,`take-${tile}`):'';
  const accepts=kind===Kind.Station?(tile!==STATION?[]:data[Meta.Orbit]?[6,7,3]:[7,3]):inputs[kind]??[];
  for (const id of accepts) if (held(data,id)>0) html+=button(`装入${ITEM[id]}（持有 ${held(data,id)}）`,`feed-${tile}-${id}`);
  if (kind===Kind.SimpleMiner) html+=button('手采铁矿','gather-selected')+button('手制结构件','handwork',false,!held(data,1));
  return html;
}

function lessonButtons(choices:[string,string,boolean?][]) {
  return choices.length?actions(...choices.map(([name,id,disabled],i)=>button(name,id,i===0,disabled))):'';
}

function modeAvailable(next:Mode) {
  return data[Meta.Stage]>=({view:Stage.Expand,build:Stage.Expand,power:Stage.Power,orbit:Stage.Launch})[next];
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
  if (data[Meta.Stage]>=Stage.Power && ![Kind.SimpleMiner,Kind.Bench,Kind.Belt,Kind.Splitter,Kind.Depot].includes(kind)) inventory.push(['供电区',group?`#${group}`:'未连接']);
  const hasPriority=[Kind.IronDrill,Kind.SilicaDrill,Kind.FuelDrill,Kind.Smelter,Kind.Grinder,Kind.Calibrator,Kind.Assembler,Kind.KitPress,Kind.Kiln].includes(kind);
  if (hasPriority) inventory.push(['供电顺序',['普通','优先','最高'][cfg]]);
  return [`设备检查 · ${coordinates(selected)}`,device.name,`<p class="lead">${device.detail}</p>`+
    signal(kind===Kind.Belt && status===0?'等候货物':STATUS[status],status>=2&&status<=4)+readings(inventory)+
    actions(materialButtons(selected,kind),button('旋转设备','rotate-device'),
      hasPriority?button('切换优先级','configure'):'',
      kind===Kind.Splitter?button('切换分流','configure'):'',
      kind===Kind.Depot?button('切换收发','configure'):'',
      kind!==Kind.Generator && kind!==Kind.Battery && kind!==Kind.Solar ? button('沿货流定位','trace-cargo'):'',
      data[Meta.Stage]>=Stage.Power?(group?button('查看电网','power-map'):button('接线','wire')):'',
      button('拆除','remove'))+
    actions(button('任务进度','mission'))];
}

function renderPalette() {
  const buildables=[Kind.SimpleMiner,Kind.Bench,Kind.Belt,Kind.Splitter,Kind.IronDrill,Kind.SilicaDrill,Kind.FuelDrill,Kind.Smelter,Kind.Grinder,
    Kind.Calibrator,Kind.Assembler,Kind.Generator,Kind.Battery,Kind.Solar,Kind.Depot,Kind.KitPress,Kind.Kiln].filter(kind=>unlocked(data,kind));
  const custom=customBlueprint ? `<button class="tool" type="button" data-action="custom"><span class="symbol">▣</span>自定义厂段</button>`:'';
  const entries=buildables.map(kind=>{
    const {name,cost,icon}=MACHINE[kind];
    return `<button class="tool" type="button" data-tool="${kind}"><span class="symbol" aria-hidden="true">${icon}</span>${name}<span class="price">${kind===Kind.SimpleMiner?(data[Meta.Packed]?'已制好':data[Meta.MinerCost]+' 铁矿'):cost}</span></button>`;
  }).join('');
  const extra=(name:string,action:string)=>`<button class="tool" type="button" data-action="${action}">${name}</button>`;
  tools.innerHTML=entries+(data[Meta.Stage]>=Stage.Power?extra('电缆','wire'):'')+
    (data[Meta.FirstLight]?extra('框选蓝图','capture')+extra('标准厂段','standard')+custom:'')+
    extra('拆除','remove');

}

function refresh(force=true) {
  if (!ready) return;
  const stage=data[Meta.Stage], opening=stage<Stage.Expand;
  app.dataset.opening=String(opening);
  byId('iron-balance').hidden=stage===Stage.Gather;
  byId('plate-balance').hidden=stage<Stage.Bench;
  byId('kit-balance').hidden=stage<Stage.Sunlight;
  byId('iron-count').textContent=String(held(data,1));
  byId('plate-count').textContent=String(data[Meta.Plates]); byId('kit-count').textContent=String(data[Meta.Kits]);
  byId('clock').textContent=time(data[Meta.Tick]); byId('map-layer').textContent=modes[mode];
  for (const nav of document.querySelectorAll<HTMLButtonElement>('.mode')) {
    nav.hidden=!modeAvailable(nav.dataset.mode as Mode);
    nav.setAttribute('aria-pressed',String(nav.dataset.mode===mode));
  }
  if (force || (!panelPointer && performance.now()-lastPanelRender>220)) {
    lesson.hidden=!opening || stage===Stage.Gather || tool!==undefined;
    if (!lesson.hidden) {
      const [title,detail,...choices]=workshopLesson(data);
      const html=`<strong>${title}</strong><p>${detail}</p>`+lessonButtons(choices);
      if (lesson.innerHTML!==html) lesson.innerHTML=html;
    } else if (!opening && lesson.childElementCount) lesson.replaceChildren();
    const [tag,title,html]=inspectors();
    byId('panel-tag').textContent=tag; byId('panel-title').textContent=title;
    if (panelBody.innerHTML!==html) panelBody.innerHTML=html;
    lastPanelRender=performance.now();
    if (!palette.hidden && force) renderPalette();
    updateDraft();
  }
}

function station(city=0) {
  if (!unlocked(data,Kind.Station)) return;
  const tile=cityValue(data,city,CityField.Site);
  if (cell(data,tile,Field.Kind)!==Kind.Station) { previewAt(Kind.Station,tile); return; }
  clearDraft(); mode='orbit'; selected=tile; focus=tile; palette.hidden=true; traced=[];
  renderer?.camera.focus(tile); setPanel(true); refresh();
}

function powerMap() {
  if (!modeAvailable('power')) return;
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
  cam.focus(data[Meta.FirstOre]); cam.zoom=data[Meta.Stage]<Stage.Expand?Math.min(64,cam.width/6):28;
}

function setSpeed(value:number) {
  speed=value; worker.postMessage({type:'speed',speed});
  const element=document.querySelector<HTMLButtonElement>('[data-action="speed"]')!;
  element.textContent=speed?`${speed}×`:'暂停';
  document.querySelector<HTMLButtonElement>('[data-action="pause"]')!.textContent=speed?'暂停模拟':'继续模拟';
}

function onAction(action:string) {
  const cam=renderer?.camera;
  const ore=data[Meta.FirstOre];
  const region=/^(line|site|sender|receiver|lastmile|cable|window)-(\d)(?:-(\d))?$/.exec(action);
  if (region) {
    const [,verb,id,program]=region, city=Number(id);
    if (city>=visibleCities()) return;
    const v=(f:CityField)=>cityValue(data,city,f);
    if (verb==='line') {
      const [sx,sy]=xy(v(CityField.Sender)),[ex,ey]=xy(v(CityField.Receiver));
      if (cam) {cam.x=(sx+ex+1)/2; cam.y=(sy+ey+1)/2; cam.zoom=Math.max(7,Math.min(32,cam.width/(5+Math.abs(sx-ex)),cam.height/(7+Math.abs(sy-ey))));}
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
  if (action.startsWith('take-')) { collectAt(Number(action.slice(5))); return; }
  if (/^feed-\d+-\d+$/.test(action)) {
    const [,tile,item]=action.split('-'); submit({op:Op.Feed,a:Number(tile),b:Number(item)}); return;
  }
  switch (action) {
    case 'home': home(); return;
    case 'ore-action': tap(ore); return;
    case 'gather-selected': gatherAt(selected); return;
    case 'craft-miner': submit({op:Op.CraftMiner},()=>choose(Kind.SimpleMiner)); return;
    case 'site-miner': choose(Kind.SimpleMiner); return;
    case 'handwork': submit({op:Op.Handwork}); return;
    case 'site-bench': choose(Kind.Bench,ore+2); return;
    case 'feed-bench': submit({op:Op.Feed,a:firstMachine(data,Kind.Bench),b:1}); return;
    case 'collect-bench': collectAt(firstMachine(data,Kind.Bench)); return;
    case 'first-belt': choose(Kind.Belt,ore+1); return;
    case 'new-depot': {
      const bench=firstMachine(data,Kind.Bench), [x,y]=xy(bench), [dx,dy]=STEP[cell(data,bench,Field.Direction)];
      previewAt(Kind.Depot,at(x+dx-dy,y+dy+dx)); return;
    }
    case 'second-belt': choose(Kind.Belt,firstMachine(data,Kind.Bench)); return;
    case 'new-drill': previewAt(Kind.IronDrill,nearest(ore,i=>!cell(data,i,Field.Kind) && cell(data,i,Field.Ore)===1)); return;
    case 'new-generator': previewAt(Kind.Generator,nearest(ore,i=>cell(data,i,Field.Ore)===3)+1); return;
    case 'gather-fuel': case 'gather-silica': {
      const tile=nearest(ore,i=>cell(data,i,Field.Ore)===(action==='gather-fuel'?3:2));
      if (tile>=0) { cam?.focus(tile); gatherAt(tile); } return;
    }
    case 'fuel-generator': submit({op:Op.Feed,a:firstMachine(data,Kind.Generator),b:3}); return;
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
    case 'speed': setSpeed(speed===0?1:speed===1?2:speed===2?4:1); return;
    case 'pause': setSpeed(speed?0:1); return;
    case 'station': station(); return;
    case 'mission': clearDraft(); mode='view'; selected=-1; focus=-1; traced=[]; palette.hidden=true; setPanel(true); refresh(); return;
    case 'power-map': powerMap(); return;
    case 'trace-cargo': traceCargo(); return;
    case 'battery': previewOnGrid(Kind.Battery); return;
    case 'solar': {
      const tile=firstMachine(data,Kind.Solar);
      if (tile<0) previewOnGrid(Kind.Solar);
      else {mode='view'; selected=tile; cam?.focus(tile); refresh();}
      return;
    }
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
      const choices=kind===Kind.Depot?knownItems(data):kind===Kind.Splitter?[0,1]:[0,1,2];
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
      clearDraft(); selected=-1; focus=-1; traced=[]; mode='view'; palette.hidden=true; recenter=true;
      worker.postMessage({type:'reset'}); worker.postMessage({type:'save'}); dialog.close(); return;
    }
  }
}

document.addEventListener('click',event=>{
  const el=(event.target as Element).closest<HTMLButtonElement>('button');
  if (!el || el.disabled || !ready) return;
  if (el.dataset.mode) selectMode(el.dataset.mode as Mode);
  else if (el.dataset.action) onAction(el.dataset.action);
  else if (el.dataset.tool) {
    const kind=Number(el.dataset.tool);
    if (kind===Kind.SimpleMiner && !data[Meta.Packed]) onAction('craft-miner');
    else choose(kind);
  }
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

function reportSaveError(reason:string) {
  byId('save-status').textContent=reason;
  say(reason,true);
}

saveFile.addEventListener('change',async()=>{
  const file=saveFile.files?.[0]; saveFile.value='';
  if (!file) return;
  if (file.size>200_000) { reportSaveError('导入失败，文件超过当前存档大小上限。'); return; }
  try {
    const buffer=await file.arrayBuffer(); worker.postMessage({type:'restore',buffer},[buffer]);
  } catch { reportSaveError('读取存档失败。'); }
});

worker.onmessage=event=>{
  const message=event.data;
  if (message.type==='error') { fail(message.message); return; }
  if (message.type==='command-result') {
    const done=pending; pending=undefined;
    if (message.status<0) say(ERRORS[message.status] ?? '操作失败',true);
    else {
      done?.(); refresh(); window.clearTimeout(commitTimeout);
      commitTimeout=window.setTimeout(()=>worker.postMessage({type:'save'}),450);
    }
    return;
  }
  if (message.type==='snapshot') {
    const wasLit=data[Meta.FirstLight], wasComplete=data[Meta.Complete], oldStage=data[Meta.Stage], previous=data.buffer;
    data=new Int32Array(message.buffer); lastSnapshot=performance.now();
    if (ready && previous instanceof ArrayBuffer) worker.postMessage({type:'recycle',buffer:previous},[previous]);
    if (!ready) {
      ready=true; loading.hidden=true; app.setAttribute('aria-busy','false');
      if (matchMedia('(max-width:720px) and (orientation:portrait)').matches) setPanel(true);
      refresh();
    } else {
      if (oldStage<Stage.Expand && data[Meta.Stage]>=Stage.Expand) { mode='view'; selected=-1; setPanel(true); }
      refresh(message.immediate || oldStage!==data[Meta.Stage]);
    }
    if (recenter) { home(); recenter=false; }
    if (!wasLit && data[Meta.FirstLight] && data[Meta.Sun]) {
      say('曙港第一次看见日出');
      if (mode==='orbit' && renderer) { renderer.camera.x=38; renderer.camera.y=11.6; }
    }
    if (!wasComplete && data[Meta.Complete]) say('四条厂段已交付 · 谷东请求开通班线');
    if (oldStage!==Stage.Victory && data[Meta.Stage]===Stage.Victory) {
      say('三城连续迎来第三轮日出'); mode='view'; selected=-1; setPanel(true);
      if (renderer) { const cam=renderer.camera; cam.x=28; cam.y=18; cam.zoom=Math.max(6,Math.min(cam.width/54,cam.height/38)); }
      refresh();
    }
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
    clearDraft(); mode='view'; focus=-1; selected=-1; traced=[]; palette.hidden=true; recenter=true;
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

function draw(now:number) {
  if (renderer) {
    if (ready) {
      const tile=data[Meta.FirstOre], [x,y]=xy(tile), cam=renderer.camera;
      const [sx,sy]=cam.toScreen(x+.5,y+.5);
      const stage=data[Meta.Stage], stock=contents(data,tile,1);
      oreAction.hidden=stage>=Stage.Expand || tool!==undefined || sx<30 || sx>cam.width-30 || sy<0 || sy>cam.height-70;
      if (!oreAction.hidden) {
        const name=stage<=Stage.Craft?'采集':stage===Stage.PlaceMiner?'选择此矿点':`出料格 ${stock} / ${data[Meta.MinerCapacity]}${stock?' · 取走':''}`;
        if (oreAction.textContent!==name) oreAction.textContent=name;
        oreAction.disabled=stage>=Stage.Mining && !stock;
        oreAction.style.transform=`translate(${sx}px,${sy+cam.zoom*.63}px) translateX(-50%)`;
      }
      gain.hidden=now>=gainUntil;
      if (!gain.hidden) {
        const [gx,gy]=xy(gainTile), [px,py]=cam.toScreen(gx+.5,gy);
        gain.style.transform=`translate(${px}px,${py-18+(gainUntil-now)/65}px) translateX(-50%)`;
      }
      renderer.render({data,mode,preview:ghost.cells,selected,focus,trace:traced,now,snapshotAt:lastSnapshot,speed,
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
