export type SlotRole = 'held' | 'input' | 'output' | 'module' | 'cargo' | 'display';
export type Slot = { role:SlotRole; item:number; tile:number; identity:number; count:number; canPut:boolean; canTake:boolean; lane:number; cargoId:number };
export type Selection = Pick<Slot,'item'|'tile'|'identity'|'lane'|'cargoId'> & {role:SlotRole; quantity?:number};
export type ContainerTarget = Pick<Slot,'tile'|'identity'> & {role:'container'};

export function readContainer(element:Element | null):ContainerTarget | undefined {
  const container=element?.closest<HTMLElement>('[data-container]');
  if (!container) return undefined;
  return {role:'container',tile:Number(container.dataset.tile),identity:Number(container.dataset.identity)};
}

export function readSlot(button:HTMLButtonElement):Slot {
  const {slot,item,tile,identity,count,put,take,lane,cargoId}=button.dataset;
  return {role:slot as SlotRole,item:Number(item),tile:Number(tile),identity:Number(identity ?? 0),
    count:Number(count),canPut:put==='true',canTake:take==='true',lane:Number(lane ?? 0),cargoId:Number(cargoId ?? 0)};
}

export function sameSlot(source:Selection | undefined,slot:Slot) {
  return !!source && source.role===slot.role && source.tile===slot.tile &&
    source.item===slot.item && source.identity===slot.identity && source.lane===slot.lane && source.cargoId===slot.cargoId;
}

export function canSelectSlot(slot:Slot) { return slot.count>0 && (slot.role==='held' || slot.canTake); }

export function bindInventoryDrag(root:HTMLElement,ghost:HTMLElement,actions:{
  selected():Selection | undefined;
  select(source:Selection | undefined):void;
  drop(source:Selection,target:Slot | ContainerTarget):boolean;
  art(item:number):string;
}) {
  type Gesture = {
    id:number; origin:Slot; source:Selection; x:number; y:number; base:number;
    phase:'press'|'drag'|'size';
  };
  let gesture:Gesture | undefined;
  let timeout=0, suppressClick=false;
  const slotAt=(element:EventTarget | null)=>
    element instanceof Element?element.closest<HTMLButtonElement>('button[data-slot]'):null;
  const clamp=(count:number,limit:number)=>Math.min(limit,Math.max(1,count));
  const setCount=(g:Gesture,quantity:number)=>{
    g.source.quantity=clamp(quantity,g.origin.count);
    ghost.querySelector('b')!.textContent=String(g.source.quantity);
  };
  const moveGhost=(x:number,y:number)=>{
    ghost.dataset.side=y<78?'below':'above';
    ghost.dataset.edge=x>window.innerWidth-80?'right':'middle';
    ghost.style.transform=`translate(${Math.max(45,Math.min(window.innerWidth-45,x))}px,${y}px)`;
  };
  const activate=(g:Gesture,phase:'drag'|'size')=>{
    g.phase=phase;
    root.setPointerCapture(g.id);
    ghost.dataset.phase=phase;
    ghost.innerHTML=`<div class="drag-stack">${actions.art(g.source.item)}<b></b></div>`+
      (phase==='size'?'<span>← 数量 →</span>':'');
    moveGhost(g.x,g.y);
    setCount(g,g.base);
    ghost.hidden=false;
    actions.select({...g.source});
  };
  const finish=(event:PointerEvent | undefined,commit:boolean)=>{
    const g=gesture;
    if (!g || event && g.id!==event.pointerId) return;
    window.clearTimeout(timeout);
    gesture=undefined;
    ghost.hidden=true;
    if (g.phase==='press') return;
    suppressClick=!!event && commit;
    if (commit && g.phase==='size') {
      actions.select(g.source);
      return;
    }
    if (event && commit) {
      const element=document.elementFromPoint(event.clientX,event.clientY);
      const container=readContainer(element);
      const button=container?null:slotAt(element);
      const target=container ?? (button?readSlot(button):undefined);
      if (target && actions.drop(g.source,target)) return;
    }
    actions.select(undefined);
  };
  root.addEventListener('pointerdown',event=>{
    if (gesture) {
      if (gesture.id!==event.pointerId) finish(undefined,false);
      return;
    }
    suppressClick=false;
    const button=slotAt(event.target);
    if (!button || event.button!==0 || !event.isPrimary) return;
    const origin=readSlot(button);
    const {count}=origin;
    if (!canSelectSlot(origin)) return;
    const existing=actions.selected();
    const quantity=sameSlot(existing,origin)?existing?.quantity:undefined;
    const g:Gesture={id:event.pointerId,origin,source:origin,x:event.clientX,y:event.clientY,
      base:clamp(quantity ?? count,count),phase:'press'};
    gesture=g;
    timeout=window.setTimeout(()=>{
      if (gesture!==g || g.phase!=='press') return;
      g.base=clamp(quantity ?? Math.ceil(count/2),count);
      activate(g,'size');
    },400);
  });
  root.addEventListener('contextmenu',event=>{
    if (gesture && slotAt(event.target)) event.preventDefault();
  });
  window.addEventListener('pointermove',event=>{
    const g=gesture;
    if (!g || event.pointerId!==g.id) return;
    if (event.pointerType==='mouse' && !(event.buttons&1)) { finish(event,false); return; }
    const dx=event.clientX-g.x, dy=event.clientY-g.y;
    if (g.phase==='press' && Math.hypot(dx,dy)>=7) {
      window.clearTimeout(timeout);
      activate(g,'drag');
    }
    if (g.phase==='size') {
      if (Math.abs(dy)<32) setCount(g,g.base+Math.trunc(dx/10));
      else { g.phase='drag'; ghost.dataset.phase='drag'; }
    }
    if (g.phase==='drag') moveGhost(event.clientX,event.clientY);
  });
  window.addEventListener('pointerup',event=>finish(event,true),true);
  window.addEventListener('pointercancel',event=>finish(event,false));
  window.addEventListener('blur',()=>finish(undefined,false));
  document.addEventListener('visibilitychange',()=>{ if (document.hidden) finish(undefined,false); });
  root.addEventListener('click',event=>{
    if (!suppressClick || !event.detail) return;
    suppressClick=false;
    event.stopPropagation();
    event.preventDefault();
  },true);
  root.addEventListener('wheel',event=>{
    const step=-Math.sign(event.deltaY);
    if (!step) return;
    if (gesture?.phase==='drag') {
      event.preventDefault();
      event.stopPropagation();
      setCount(gesture,(gesture.source.quantity ?? gesture.base)+step);
      return;
    }
    const button=slotAt(event.target), source=actions.selected();
    if (!button || !source) return;
    const origin=readSlot(button);
    if (!origin.count || !sameSlot(source,origin)) return;
    event.preventDefault();
    event.stopPropagation();
    actions.select({...source,quantity:clamp((source.quantity ?? origin.count)+step,origin.count)});
  },{passive:false,capture:true});
}
