import { at, xy } from './model';
import type { Camera } from './renderer';

type Point = {x:number; y:number};

export function bindMapInput(canvas:HTMLCanvasElement,camera:Camera, actions:{
  tap(tile:number):void; route(from:number,to:number):void; canDragRoute():boolean;
}) {
  const pointers = new Map<number,Point>();
  let start:Point | undefined;
  let moved=false, multitouch=false, draw=false, startTile=-1;
  const local=(event:PointerEvent | WheelEvent)=>{
    const bounds=canvas.getBoundingClientRect();
    return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};
  };
  const tileAt=(point:Point)=>{
    const [x,y]=camera.toWorld(point.x,point.y);
    return at(Math.floor(x),Math.floor(y));
  };
  const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);

  canvas.addEventListener('pointerdown',event=>{
    if (event.button!==0 && event.button!==2) return;
    const point=local(event);
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,point);
    if (pointers.size===1) {
      start=point; moved=false; multitouch=false;
      draw=event.pointerType==='mouse' && event.button===0 && actions.canDragRoute();
      startTile=tileAt(point);
    } else { multitouch=true; draw=false; }
  });

  canvas.addEventListener('pointermove',event=>{
    const past=pointers.get(event.pointerId);
    if (!past) return;
    const point=local(event);
    if (pointers.size===2) {
      const other=Array.from(pointers.entries()).find(([id])=>id!==event.pointerId)?.[1];
      if (other) {
        camera.pan((point.x-past.x)/2,(point.y-past.y)/2);
        camera.scale((point.x+other.x)/2,(point.y+other.y)/2,distance(point,other)/Math.max(2,distance(past,other)));
      }
    } else if (pointers.size===1) {
      if (start && distance(point,start)>6) moved=true;
      if (moved || multitouch) {
        if (draw && startTile>=0) {
          const end=tileAt(point);
          if (end>=0) actions.route(startTile,end);
        } else camera.pan(point.x-past.x,point.y-past.y);
      }
    }
    pointers.set(event.pointerId,point);
  });

  function end(event:PointerEvent,allowTap:boolean) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size===0 && allowTap && !moved && !multitouch && event.button===0) {
      const tile=tileAt(local(event));
      if (tile>=0) actions.tap(tile);
    }
  }
  canvas.addEventListener('pointerup',event=>end(event,true));
  canvas.addEventListener('pointercancel',event=>end(event,false));
  canvas.addEventListener('lostpointercapture',event=>end(event,false));
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
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
