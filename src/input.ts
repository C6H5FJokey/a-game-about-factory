import { at, xy } from './model';
import type { Camera } from './renderer';

type Point = {x:number; y:number};
const ROTATE_HOLD_MS=350;

export function bindMapInput(canvas:HTMLCanvasElement,camera:Camera, actions:{
  tap(tile:number):void; canDragRoute():boolean;
  startRoute(tile:number):boolean; route(from:number,to:number):void; finishRoute(keep:boolean):void;
  inspect(tile:number):void;
  canRotateDraft():boolean; rotateDraft(tile:number,step:number):void;
  canRotateAt(tile:number):boolean; rotateAt(tile:number,heading:number):void;
  startHarvest(tile:number,pointer:number):void; stopHarvest():void;
}) {
  const pointers = new Map<number,Point>();
  let start:Point | undefined;
  let moved=false, multitouch=false, startTile=-1, startTime=0, lastDrawn=-1;
  let routeAllowed=false, rotateAllowed=false, leftHeld=false, rotationDelta=0;
  let gesture:'pan'|'route'|'rotate'|'wheel'='pan';
  const local=(event:PointerEvent | WheelEvent)=>{
    const bounds=canvas.getBoundingClientRect();
    return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};
  };
  const tileAt=(point:Point)=>camera.tileAt(point.x,point.y);
  const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
  const drawTo=(point:Point)=>{
    const tile=tileAt(point);
    if (tile<0 || lastDrawn===tile) return;
    actions.route(lastDrawn,tile); lastDrawn=tile;
  };

  canvas.addEventListener('pointerdown',event=>{
    if (event.button!==0 && event.button!==1) return;
    if (event.button===1) event.preventDefault();
    actions.inspect(-1);
    const point=local(event);
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,point);
    if (pointers.size===1) {
      start=point; moved=false; multitouch=false;
      leftHeld=event.pointerType==='mouse' && event.button===0;
      gesture='pan'; rotationDelta=0; startTile=tileAt(point); startTime=event.timeStamp;
      routeAllowed=event.button===0 && startTile>=0 && actions.canDragRoute();
      rotateAllowed=event.button===0 && startTile>=0 && actions.canRotateAt(startTile);
      if (event.button===0 && !routeAllowed && startTile>=0) actions.startHarvest(startTile,event.pointerId);
    } else {
      if (gesture==='route') actions.finishRoute(false);
      multitouch=true; gesture='pan'; actions.stopHarvest();
    }
  });

  canvas.addEventListener('pointermove',event=>{
    const past=pointers.get(event.pointerId);
    const point=local(event);
    if (!past) {
      if (!pointers.size && event.pointerType==='mouse') actions.inspect(tileAt(point));
      return;
    }
    if (pointers.size===2) {
      const other=Array.from(pointers.entries()).find(([id])=>id!==event.pointerId)?.[1];
      if (other) {
        camera.pan((point.x-past.x)/2,(point.y-past.y)/2);
        camera.scale((point.x+other.x)/2,(point.y+other.y)/2,distance(point,other)/Math.max(2,distance(past,other)));
      }
    } else if (pointers.size===1 && gesture!=='wheel') {
      if (!moved && !multitouch && start && distance(point,start)>6) {
        moved=true;
        if (rotateAllowed && event.timeStamp-startTime>=ROTATE_HOLD_MS) gesture='rotate';
        else if (routeAllowed && actions.startRoute(startTile)) { gesture='route'; lastDrawn=startTile; }
      }
      if (moved || multitouch) {
        actions.stopHarvest();
        if (gesture==='route') drawTo(point);
        else if (gesture==='rotate' && start) {
          const dx=point.x-start.x, dy=point.y-start.y;
          if (Math.hypot(dx,dy)>6) actions.rotateAt(startTile,Math.abs(dx)>=Math.abs(dy)?dx>0?0:2:dy>0?1:3);
        } else camera.pan(point.x-past.x,point.y-past.y);
      }
    }
    pointers.set(event.pointerId,point);
  });

  function end(event:PointerEvent,allowTap:boolean) {
    if (!pointers.has(event.pointerId)) return;
    actions.stopHarvest();
    pointers.delete(event.pointerId);
    if (pointers.size) return;
    leftHeld=false;
    if (gesture==='route') {
      if (allowTap) drawTo(local(event));
      actions.finishRoute(allowTap);
    }
    if (allowTap && !moved && !multitouch && gesture==='pan' && event.button===0 &&
        !(rotateAllowed && event.timeStamp-startTime>=ROTATE_HOLD_MS)) {
      const tile=tileAt(local(event));
      if (tile>=0) actions.tap(tile);
    }
  }
  window.addEventListener('pointerup',event=>{
    if (pointers.has(event.pointerId)) end(event,document.elementFromPoint(event.clientX,event.clientY)===canvas);
  });
  window.addEventListener('pointercancel',event=>end(event,false));
  window.addEventListener('blur',()=>{
    if (gesture==='route') actions.finishRoute(false);
    actions.stopHarvest(); pointers.clear(); leftHeld=false; gesture='pan';
  });
  canvas.addEventListener('pointerleave',()=>actions.inspect(-1));
  canvas.addEventListener('auxclick',event=>{ if (event.button===1) event.preventDefault(); });
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    actions.inspect(-1);
    if (leftHeld && !multitouch && actions.canRotateDraft()) {
      if (gesture==='route') actions.finishRoute(false);
      gesture='wheel';
      const delta=event.deltaY*(event.deltaMode===1?18:event.deltaMode===2?48:1);
      if (rotationDelta*delta<0) rotationDelta=0;
      rotationDelta+=delta;
      if (Math.abs(rotationDelta)>=40) {
        actions.rotateDraft(startTile,Math.sign(rotationDelta));
        rotationDelta=0;
      }
      return;
    }
    const {x,y}=local(event);
    camera.scale(x,y,Math.exp(-event.deltaY*(event.deltaMode===1?.028:.0015)));
  },{passive:false});
}

export function orthogonal(anchors:number[],verticalFirst:boolean) {
  if (!anchors.length) return [];
  const route=[anchors[0]];
  let [x,y]=xy(anchors[0]);
  for (const anchor of anchors.slice(1)) {
    const [targetX,targetY]=xy(anchor);
    const dx=Math.sign(targetX-x),dy=Math.sign(targetY-y);
    for (const axis of verticalFirst ? ['y','x'] : ['x','y']) {
      if (axis==='x') while (x!==targetX) { x+=dx; route.push(at(x,y)); }
      else while (y!==targetY) { y+=dy; route.push(at(x,y)); }
    }
  }
  return route;
}
