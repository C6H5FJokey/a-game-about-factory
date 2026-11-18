import { Op, type Command } from './model';

type Kernel = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  reserve_input(length:number):number; output_ptr():number; snapshot():number;
  directory():number; blueprints():number;
  preview_transports(len:number):number;
  reset():void; step(ticks:number):void; max_speed():number;
  command(op:number,a:number,b:number,c:number,len:number):number;
  save():number; restore(len:number):number;
};
type Message = { type:'init'; url:string; save?:unknown; legacy?:number[] } | { type:'command'; data:Command } |
  { type:'speed'; speed:number } | { type:'recycle'; buffer:ArrayBuffer } |
  { type:'restore'; buffer:ArrayBuffer } | { type:'reset' } | { type:'save' } |
  { type:'transport-preview'; request:number; words:number[] };

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
  if (!kernel) return false;
  const pointer = kernel.reserve_input(words.length);
  if (!pointer) return false;
  new Int32Array(kernel.memory.buffer,pointer,words.length).set(words);
  return true;
}

function publishBlueprints() {
  if (!kernel) return;
  const buffer=copyOutput(kernel.blueprints());
  worker.postMessage({type:'blueprints',buffer},[buffer]);
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

async function boot(url:string, save?:unknown, legacy?:number[]) {
  try {
    const file = await fetch(url);
    if (!file.ok) throw new Error(`模拟文件加载失败 (${file.status})`);
    const result = await WebAssembly.instantiate(await file.arrayBuffer());
    kernel = result.instance.exports as Kernel;
    if (save!==undefined && !restoreSave(save)) {
      worker.postMessage({type:'invalid-save',startup:true});
    }
    if (legacy && input(legacy) && kernel.command(Op.MigrateBlueprint,0,0,0,legacy.length)>0) {
      worker.postMessage({type:'legacy-imported'});
    }
    const catalog=copyOutput(kernel.directory());
    worker.postMessage({type:'directory',buffer:catalog},[catalog]);
    publishBlueprints();
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
  if (message.type === 'init') { void boot(message.url,message.save,message.legacy); return; }
  if (!kernel) return;
  switch (message.type) {
    case 'speed': {
      const requested = message.speed;
      if ([0,1,2,4].includes(requested)) speed = Math.min(requested,kernel.max_speed());
      budget=0;
      return;
    }
    case 'transport-preview': {
      if (!input(message.words)) return;
      const result=copyOutput(kernel.preview_transports(message.words.length));
      worker.postMessage({type:'transport-preview',request:message.request,result},[result]);
      return;
    }
    case 'recycle': if (buffers.length < 3) buffers.push(message.buffer); return;
    case 'command': {
      const { op,a=0,b=0,c=0,words=[] } = message.data;
      const status = input(words) ? kernel.command(op,a,b,c,words.length) : -1;
      if (status>0 && op>=Op.CaptureBlueprint && op<=Op.MigrateBlueprint) publishBlueprints();
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
      if (ok) { speed=Math.min(speed,kernel.max_speed()); publishBlueprints(); snapshot(true); }
      return;
    }
    case 'reset': kernel.reset(); speed=Math.min(speed,kernel.max_speed()); publishBlueprints(); snapshot(true); return;
  }
};
