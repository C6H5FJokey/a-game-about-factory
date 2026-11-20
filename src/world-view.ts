import {
  SNAPSHOT_CELL_WORDS, SNAPSHOT_HEADER_WORDS, VIEW_BOUNDS_WORDS, VIEW_DYNAMIC_FIELDS,
  VIEW_LAYOUT_FIELDS, VIEW_LAYOUT_HEADER_WORDS, VIEW_SECTION_COUNT, ViewSection,
} from './generated-content';

const directory=SNAPSHOT_HEADER_WORDS+VIEW_BOUNDS_WORDS;
const viewCells=directory+VIEW_SECTION_COUNT+1;
const dynamicStride=VIEW_DYNAMIC_FIELDS.length, layoutStride=VIEW_LAYOUT_FIELDS.length;
const fieldOffsets=(fields:number[])=>{
  const offsets=new Int8Array(SNAPSHOT_CELL_WORDS).fill(-1);
  fields.forEach((field,index)=>{ offsets[field]=index; });
  return offsets;
};
const layoutOffsets=fieldOffsets(VIEW_LAYOUT_FIELDS), dynamicOffsets=fieldOffsets(VIEW_DYNAMIC_FIELDS);
const profile=import.meta.env.MODE==='terminal-profile';

export function startViewDecode() { return profile ? performance.now() : 0; }
export function finishViewDecode(section:string,started:number) {
  if (profile) window.dispatchEvent(new CustomEvent('terminal-profile-decode',{detail:[section,performance.now()-started]}));
}

export class SnapshotLayout {
  readonly footprints:Int32Array;
  constructor(readonly words:Int32Array, readonly width:number, readonly height:number) {
    const start=VIEW_LAYOUT_HEADER_WORDS+width*height*layoutStride;
    if (words.length<start || (words.length-start)%3!==0) throw new Error('Invalid snapshot layout');
    this.footprints=words.subarray(start);
  }
}

type Frame = {layout:SnapshotLayout; left:number; top:number; right:number; bottom:number; extras:Map<number,number>};
const frames=new WeakMap<Int32Array,Frame>();

export function attachView(data:Int32Array,layout:SnapshotLayout) {
  const left=data[SNAPSHOT_HEADER_WORDS], top=data[SNAPSHOT_HEADER_WORDS+1];
  const right=data[SNAPSHOT_HEADER_WORDS+2], bottom=data[SNAPSHOT_HEADER_WORDS+3];
  if (!(0<=left && left<=right && right<=layout.width && 0<=top && top<=bottom && bottom<=layout.height)) {
    throw new Error('Invalid snapshot viewport');
  }
  let previous=viewCells+(right-left)*(bottom-top)*dynamicStride;
  for (let i=0;i<=VIEW_SECTION_COUNT;i++) {
    const offset=data[directory+i];
    if (offset===undefined || offset<previous || offset>data.length || (i===0 && offset!==previous)) {
      throw new Error(`Invalid snapshot section ${i}`);
    }
    previous=offset;
  }
  if (previous!==data.length) throw new Error('Invalid snapshot length');
  const extras=new Map<number,number>();
  const start=data[directory+ViewSection.ExtraTiles], end=data[directory+ViewSection.Grids];
  if ((end-start)%(dynamicStride+1)!==0) throw new Error('Invalid watched tiles');
  for (let row=start;row<end;row+=dynamicStride+1) extras.set(data[row],row+1);
  frames.set(data,{layout,left,top,right,bottom,extras});
}

export function snapshotLayout(data:Int32Array) { return frames.get(data)?.layout; }

export function viewSection(data:Int32Array,section:ViewSection) {
  return frames.has(data) ? [data[directory+section],data[directory+section+1]] as const : undefined;
}

function tileRow(frame:Frame,tile:number) {
  const x=tile%frame.layout.width, y=Math.floor(tile/frame.layout.width);
  if (x>=frame.left && x<frame.right && y>=frame.top && y<frame.bottom) {
    return viewCells+((y-frame.top)*(frame.right-frame.left)+x-frame.left)*dynamicStride;
  }
  return frame.extras.get(tile);
}

export function viewHasTile(data:Int32Array,tile:number) {
  const frame=frames.get(data);
  return !frame || tileRow(frame,tile)!==undefined;
}

export function readViewCell(data:Int32Array,tile:number,field:number) {
  const frame=frames.get(data);
  if (!frame) return undefined;
  const column=layoutOffsets[field];
  if (column>=0) return frame.layout.words[VIEW_LAYOUT_HEADER_WORDS+tile*layoutStride+column] ?? 0;
  const row=tileRow(frame,tile);
  return row===undefined ? 0 : data[row+dynamicOffsets[field]] ?? 0;
}
