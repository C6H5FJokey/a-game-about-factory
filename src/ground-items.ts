import { itemIcon } from './icons';
import { ITEM } from './catalog-text';
import { t } from './i18n';
import { W, recipesStart, xy } from './model';
import type { Camera } from './renderer';
import { ViewSection } from './generated-content';
import { finishViewDecode, startViewDecode, viewSection } from './world-view';

export type GroundPile = { tile:number; item:number; id:number; count:number };

const cachedPiles=new WeakMap<Int32Array,Map<number,GroundPile[]>>();

export function groundPiles(data:Int32Array) {
  let grouped=cachedPiles.get(data);
  if (grouped) return grouped;
  const started=startViewDecode();
  grouped=new Map();
  cachedPiles.set(data,grouped);
  const view=viewSection(data,ViewSection.Ground);
  const end=view?.[1] ?? recipesStart(data)-1, start=view?.[0] ?? data[end];
  if (!Number.isInteger(start) || start<0 || start>end || (end-start)%4) return grouped;
  for (let i=start;i<end;i+=4) {
    const [tile,item,id,count]=data.subarray(i,i+4);
    const piles=grouped.get(tile) ?? [];
    piles.push({tile,item,id,count});
    grouped.set(tile,piles);
  }
  finishViewDecode('ground-piles',started);
  return grouped;
}

type MarkerData = { tiles:number[]; x:number; y:number; count:number; item:number; piles:number };
type Marker = { button:HTMLButtonElement; data:MarkerData; signature:string };

export function bindGroundMarkers(layer:HTMLElement, activate:(tiles:number[])=>void) {
  const markers=new Map<number,Marker>();
  function render(data:Int32Array, camera:Camera, interactive:boolean) {
    const cells=groundPiles(data);
    if (!cells.size && !markers.size) return;
    const visible=new Map<number,MarkerData>();
    const stride=Math.max(1,Math.ceil(36/camera.zoom));
    for (const [tile,piles] of cells) {
      const [x,y]=xy(tile);
      const [left,top]=camera.toScreen(x+.92,y+.18);
      if (left<-20 || top<-20 || left>camera.width+20 || top>camera.height+20) continue;
      const key=Math.floor(y/stride)*W+Math.floor(x/stride);
      let group=visible.get(key);
      if (!group) {
        group={tiles:[],x:left,y:top,count:0,item:piles[0].item,piles:0};
        visible.set(key,group);
      }
      group.tiles.push(tile);
      group.count+=piles.reduce((total,pile)=>total+pile.count,0);
      group.piles+=piles.length;
    }
    for (const [key,marker] of markers) {
      if (!visible.has(key)) { marker.button.remove(); markers.delete(key); }
    }
    for (const [key,next] of visible) {
      let marker=markers.get(key);
      if (!marker) {
        const button=document.createElement('button');
        button.type='button';
        button.className='ground-marker';
        marker={button,data:next,signature:''};
        const current=marker;
        button.onclick=()=>activate(current.data.tiles);
        markers.set(key,marker);
        layer.append(button);
      }
      marker.data=next;
      const {button}=marker;
      const multiple=next.piles>1;
      const label=multiple?t('ui.groundSummary',{count:next.piles}):t('ui.groundMarker',{item:ITEM[next.item],count:next.count});
      const signature=`${next.item},${next.count},${next.piles},${label}`;
      if (marker.signature!==signature) {
        marker.signature=signature;
        button.innerHTML=(multiple?'<span class="ground-stack" aria-hidden="true"></span>':itemIcon(next.item))+
          `<span aria-hidden="true">${multiple?'+'+next.piles:next.count>999?'999+':next.count}</span>`;
        button.title=label;
        button.setAttribute('aria-label',label);
      }
      const position=`translate(${Math.round(next.x)}px,${Math.round(next.y)}px) translate(-20%,-72%)`;
      if (button.style.transform!==position) button.style.transform=position;
      if (button.disabled===interactive) button.disabled=!interactive;
    }
  }
  return {render};
}
