export function bindActionHold(root:HTMLElement,actions:{
  attribute:string;
  duration:number;
  available(target:number):boolean;
  complete(target:number):boolean;
  mapMeter?:HTMLElement;
}) {
  let hold:{target:number; started:number; button?:HTMLButtonElement; pointer?:number; key?:string} | undefined;
  let meter:HTMLElement | undefined;
  const stop=()=>{
    meter?.style.removeProperty('--harvest');
    meter=undefined;
    hold=undefined;
  };
  const start=(target:number,button?:HTMLButtonElement,pointer?:number,key?:string)=>{
    if (hold || button?.disabled || !actions.available(target)) return;
    hold={target,started:performance.now(),button,pointer,key};
  };
  const target=(event:Event)=>(event.target as Element | null)?.closest<HTMLButtonElement>(`button[${actions.attribute}]`);
  const value=(button:HTMLButtonElement)=>Number(button.getAttribute(actions.attribute));
  root.addEventListener('pointerdown',event=>{
    const button=target(event);
    if (hold && event.pointerId!==hold.pointer) { stop(); return; }
    if (!button || button.disabled || event.button!==0 || !event.isPrimary) return;
    button.setPointerCapture(event.pointerId);
    start(value(button),button,event.pointerId);
  });
  root.addEventListener('pointermove',event=>{
    if (!hold?.button || hold.pointer!==event.pointerId) return;
    const rect=hold.button.getBoundingClientRect();
    if (event.clientX<rect.left-8 || event.clientX>rect.right+8 ||
        event.clientY<rect.top-8 || event.clientY>rect.bottom+8) stop();
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture'] as const) {
    root.addEventListener(type,event=>{ if (hold?.pointer===event.pointerId) stop(); });
  }
  root.addEventListener('contextmenu',event=>{ if (hold && target(event)) event.preventDefault(); });
  root.addEventListener('keydown',event=>{
    const button=target(event);
    if (!button || (event.key!==' ' && event.key!=='Enter')) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) start(value(button),button,undefined,event.key);
  });
  window.addEventListener('keyup',event=>{ if (hold?.key===event.key) stop(); });
  root.addEventListener('focusout',event=>{ if (hold?.key && event.target===hold.button) stop(); });
  window.addEventListener('blur',stop);
  document.addEventListener('visibilitychange',()=>{ if (document.hidden) stop(); });
  const tick=(now:number)=>{
    if (!hold) return;
    if (!actions.available(hold.target) || hold.button && (!hold.button.isConnected || !hold.button.getClientRects().length || hold.button.closest('[inert]'))) {
      stop(); return;
    }
    const nextMeter=hold.button?hold.button.querySelector<HTMLElement>('.harvest-fill') ?? undefined:actions.mapMeter;
    if (meter!==nextMeter) meter?.style.removeProperty('--harvest');
    meter=nextMeter;
    const fraction=Math.min(1,(now-hold.started)/actions.duration);
    meter?.style.setProperty('--harvest',String(fraction));
    if (fraction===1 && actions.complete(hold.target)) hold.started=now;
  };
  const protects=(element:HTMLElement,html:string)=>!!hold?.button && element.contains(hold.button) &&
    actions.available(hold.target) && html.includes(`${actions.attribute}="${hold.target}"`);
  const mapTile=()=>hold && !hold.button?hold.target:undefined;
  return {start,stop,tick,protects,mapTile};
}
