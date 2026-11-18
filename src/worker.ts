import type { Command } from './model';

type Kernel = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  input_ptr():number; output_ptr():number; snapshot():number;
  reset():void; step(ticks:number):void;
  command(op:number,a:number,b:number,c:number,len:number):number;
  save():number; restore(len:number):number;
};
type Message = { type:'init'; url:string; save?:unknown } | { type:'command'; data:Command } |
  { type:'speed'; speed:number } | { type:'recycle'; buffer:ArrayBuffer } |
  { type:'restore'; buffer:ArrayBuffer } | { type:'reset' } | { type:'save' };

const worker = self as unknown as {
  onmessage: ((event:MessageEvent<Message>)=>void) | null;
  postMessage(message:unknown, transfer?:Transferable[]):void;
};
let kernel: Kernel | undefined;
let speed = 1;
let previous = 0;
let budget = 0;
const buffers:ArrayBuffer[] = [];

function input(words:Int32Array | number[]) {
  if (!kernel || words.length > 48_000) return false;
  const pointer = kernel.input_ptr();
  new Int32Array(kernel.memory.buffer,pointer,words.length).set(words);
  return true;
}

function copyOutput(length:number, reusable = false) {
  const recycled = reusable ? buffers.pop() : undefined;
  const buffer = recycled?.byteLength === length * 4 ? recycled : new ArrayBuffer(length * 4);
  if (kernel) new Int32Array(buffer).set(new Int32Array(kernel.memory.buffer,kernel.output_ptr(),length));
  return buffer;
}

function snapshot(immediate=false) {
  if (!kernel) return;
  const buffer = copyOutput(kernel.snapshot(),true);
  worker.postMessage({type:'snapshot',buffer,immediate},[buffer]);
}

function restoreSave(buffer:unknown) {
  if (!kernel || !(buffer instanceof ArrayBuffer) || buffer.byteLength%4!==0) return false;
  const words=new Int32Array(buffer);
  return input(words) && kernel.restore(words.length)>0;
}

async function boot(url:string, save?:unknown) {
  try {
    const file = await fetch(url);
    if (!file.ok) throw new Error(`模拟文件加载失败 (${file.status})`);
    const result = await WebAssembly.instantiate(await file.arrayBuffer());
    kernel = result.instance.exports as Kernel;
    if (save!==undefined && !restoreSave(save)) {
      worker.postMessage({type:'invalid-save',startup:true});
    }
    snapshot();
    previous = performance.now();
    setInterval(() => {
      const now = performance.now();
      budget += Math.min(now - previous,150) * speed;
      previous = now;
      const ticks = Math.floor(budget / 50);
      if (!kernel || ticks === 0) return;
      budget -= ticks * 50;
      kernel.step(ticks);
      snapshot();
    }, 50);
  } catch (error) { worker.postMessage({type:'error',message:String(error)}); }
}

worker.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') { void boot(message.url,message.save); return; }
  if (message.type === 'speed') { speed = message.speed; budget = 0; return; }
  if (!kernel) return;
  switch (message.type) {
    case 'recycle': if (buffers.length < 3) buffers.push(message.buffer); return;
    case 'command': {
      const { op,a=0,b=0,c=0,words=[] } = message.data;
      const status = input(words) ? kernel.command(op,a,b,c,words.length) : -1;
      snapshot();
      worker.postMessage({type:'command-result',status});
      return;
    }
    case 'save': {
      const buffer = copyOutput(kernel.save());
      worker.postMessage({type:'save',buffer},[buffer]);
      return;
    }
    case 'restore': {
      const ok = restoreSave(message.buffer);
      worker.postMessage({type:ok ? 'restored' : 'invalid-save'});
      if (ok) snapshot(true);
      return;
    }
    case 'reset': kernel.reset(); snapshot(true); return;
  }
};
