import { H, HZ, Op, W, terminalReview, type Command } from './model';

type Kernel = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  reserve_input(length:number):number; output_ptr():number; snapshot():number;
  snapshot_layout(revision:number,stage:number,cached:number):number;
  snapshot_view(...scope:ViewScope):number;
  directory():number; blueprints():number;
  preview_transports(len:number):number;
  reset():void; step(ticks:number):void; max_speed():number;
  content_signature():number; tick_rate():number;
  world_width():number; world_height():number;
  command(op:number,a:number,b:number,c:number,len:number):number;
  save():number; restore(len:number):number;
  prepare_terminal_profile?():void;
  feed_terminal_profile?():number;
  terminal_profile_stats?():number;
  prepare_terminal_exercise?():void;
  terminal_exercise_state?():number;
};
type ViewScope = [number,number,number,number,number,number,number,number];
type Message = { type:'init'; url:string; signature:number; save?:unknown; legacy?:number[]; fullSnapshot?:boolean } | { type:'command'; data:Command } |
  { type:'cancel-handcraft'; token:number } |
  { type:'speed'; speed:number } | { type:'recycle'; buffer:ArrayBuffer } |
  { type:'restore'; buffer:ArrayBuffer } | { type:'reset' } | { type:'save' } |
  { type:'transport-preview'; request:number; words:number[] } |
  { type:'profile-stats' } | { type:'profile-exercise' } | { type:'profile-advance'; ticks:number }
  | { type:'profile-line' } | { type:'view'; scope:ViewScope };

const worker = self as unknown as {
  onmessage: ((event:MessageEvent<Message>)=>void) | null;
  postMessage(message:unknown, transfer?:Transferable[]):void;
};
let kernel: Kernel | undefined;
let speed = 1;
let previous = 0;
let budget = 0;
let supplied = 0;
let fullSnapshot = false;
let scope:ViewScope=[0,0,0,0,-1,-1,-1,-1];
let layoutKey:Int32Array | undefined;
const buffers:ArrayBuffer[] = [];
const TICK_MS = 1000 / HZ;
const blueprintMutations = new Set<Op>([Op.CaptureBlueprint, Op.RenameBlueprint, Op.DeleteBlueprint, Op.MigrateBlueprint]);

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

function publishDirectory() {
  if (!kernel) return;
  const buffer=copyOutput(kernel.directory());
  worker.postMessage({type:'directory',buffer},[buffer]);
}

function copyOutput(length:number, reusable = false) {
  const recycled = reusable ? buffers.pop() : undefined;
  const buffer = recycled?.byteLength === length * 4 ? recycled : new ArrayBuffer(length * 4);
  if (kernel) new Int32Array(buffer).set(new Int32Array(kernel.memory.buffer,kernel.output_ptr(),length));
  return buffer;
}

function snapshot(immediate=false, steps?:number[]) {
  if (!kernel) return;
  const start=terminalReview ? performance.now() : 0;
  let layoutWrite=0, layoutCopy=0, viewStarted=start;
  if (!fullSnapshot) {
    const words=kernel.snapshot_layout(layoutKey?.[0] ?? 0,layoutKey?.[1] ?? 0,Number(Boolean(layoutKey)));
    if (words) {
      const wroteLayout=terminalReview ? performance.now() : 0;
      const buffer=copyOutput(words);
      layoutKey=new Int32Array(buffer,0,2).slice();
      if (terminalReview) {
        layoutWrite=wroteLayout-start;
        layoutCopy=performance.now()-wroteLayout;
      }
      worker.postMessage({type:'snapshot-layout',buffer},[buffer]);
      if (terminalReview) viewStarted=performance.now();
    }
  }
  const length=fullSnapshot ? kernel.snapshot() : kernel.snapshot_view(...scope);
  const written=terminalReview ? performance.now() : 0;
  const buffer=copyOutput(length,true);
  const profile=terminalReview ? {steps,writeMs:layoutWrite+written-viewStarted,copyMs:layoutCopy+performance.now()-written,
    sentAt:performance.timeOrigin+performance.now()} : undefined;
  worker.postMessage({type:'snapshot',buffer,immediate,scoped:!fullSnapshot,profile},[buffer]);
}

function restoreSave(buffer:unknown) {
  if (!kernel || !(buffer instanceof ArrayBuffer) || buffer.byteLength%4!==0) return -1;
  const words=new Int32Array(buffer);
  return input(words) ? kernel.restore(words.length) : -1;
}

function advanceProfile(sim:Kernel,ticks:number,measure=true) {
  const times:number[]=[];
  for (let i=0;i<ticks;i++) {
    supplied+=sim.feed_terminal_profile!();
    const start=measure ? performance.now() : 0;
    sim.step(1);
    if (measure) times.push(performance.now()-start);
  }
  return times;
}

async function boot(url:string, signature:number, save?:unknown, legacy?:number[], full=false) {
  try {
    const file = await fetch(url);
    if (!file.ok) throw new Error(`模拟文件加载失败 (${file.status})`);
    const result = await WebAssembly.instantiate(await file.arrayBuffer());
    const loaded = result.instance.exports as Kernel;
    if (typeof loaded.content_signature !== 'function' || (loaded.content_signature() >>> 0) !== signature
      || typeof loaded.tick_rate !== 'function' || loaded.tick_rate() !== HZ
      || loaded.world_width?.() !== W || loaded.world_height?.() !== H) {
      worker.postMessage({type:'error',key:'ui.sameContentRequired'});
      return;
    }
    kernel = loaded;
    fullSnapshot=terminalReview && full;
    if (terminalReview) {
      if (!kernel.prepare_terminal_profile || !kernel.feed_terminal_profile) throw new Error('Missing terminal profile build');
      kernel.prepare_terminal_profile();
      advanceProfile(kernel,1800,false);
    } else if (save!==undefined) {
      const status=restoreSave(save);
      if (status<0) worker.postMessage({type:'invalid-save',startup:true,status});
    }
    if (legacy && input(legacy) && kernel.command(Op.MigrateBlueprint,0,0,0,legacy.length)>0) {
      worker.postMessage({type:'legacy-imported'});
    }
    publishDirectory();
    publishBlueprints();
    snapshot();
    previous = performance.now();
    setInterval(() => {
      const now = performance.now();
      // Accumulate elapsed time scaled by the tick rate, with no fractional tick divisor.
      budget += Math.min(now - previous,150) * HZ * speed;
      previous = now;
      const ticks = Math.floor(budget / 1000);
      if (!kernel || ticks === 0) return;
      budget -= ticks * 1000;
      if (terminalReview && kernel.feed_terminal_profile) {
        snapshot(false,advanceProfile(kernel,ticks));
      } else {
        kernel.step(ticks);
        snapshot();
      }
    }, TICK_MS);
  } catch (error) { worker.postMessage({type:'error',message:String(error)}); }
}

worker.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') { void boot(message.url,message.signature,message.save,message.legacy,message.fullSnapshot); return; }
  if (!kernel) return;
  switch (message.type) {
    case 'view':
      scope=message.scope;
      if (speed===0 && !fullSnapshot) snapshot(true);
      return;
    case 'profile-stats': {
      if (terminalReview && kernel.terminal_profile_stats) {
        const length=kernel.terminal_profile_stats();
        const values=Array.from(new Int32Array(kernel.memory.buffer,kernel.output_ptr(),length));
        worker.postMessage({type:'profile-stats',values,supplied});
      }
      return;
    }
    case 'profile-exercise':
      if (terminalReview && speed===0 && kernel.prepare_terminal_exercise) {
        kernel.prepare_terminal_exercise();
        snapshot(true);
        worker.postMessage({type:'profile-exercise'});
      }
      return;
    case 'profile-advance':
      if (terminalReview && speed===0 && Number.isInteger(message.ticks) && message.ticks>=0 && message.ticks<=1000) {
        snapshot(true,advanceProfile(kernel,message.ticks,false));
        worker.postMessage({type:'profile-advance'});
      }
      return;
    case 'profile-line':
      if (terminalReview && kernel.terminal_exercise_state) {
        const length=kernel.terminal_exercise_state();
        const values=Array.from(new Int32Array(kernel.memory.buffer,kernel.output_ptr(),length));
        worker.postMessage({type:'profile-line',values});
      }
      return;
    case 'cancel-handcraft': kernel.command(Op.CancelHandcraft,message.token,0,0,0); return;
    case 'speed': {
      const requested = message.speed;
      if ([0,1,2,4].includes(requested)) speed = Math.min(requested,kernel.max_speed());
      previous=performance.now();
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
      const accepted=input(words);
      const started=terminalReview ? performance.now() : 0;
      const status = accepted ? kernel.command(op,a,b,c,words.length) : -1;
      const commandMs=terminalReview ? performance.now()-started : undefined;
      if (status>0 && blueprintMutations.has(op)) publishBlueprints();
      snapshot();
      worker.postMessage({type:'command-result',status,commandMs});
      return;
    }
    case 'save': {
      const buffer = copyOutput(kernel.save());
      worker.postMessage({type:'save',buffer},[buffer]);
      return;
    }
    case 'restore': {
      const status = restoreSave(message.buffer);
      worker.postMessage({type:status>0 ? 'restored' : 'invalid-save',status});
      if (status>0) {
        layoutKey=undefined;
        speed=Math.min(speed,kernel.max_speed()); publishDirectory(); publishBlueprints(); snapshot(true);
      }
      return;
    }
    case 'reset':
      kernel.reset();
      layoutKey=undefined;
      speed=Math.min(speed,kernel.max_speed()); publishDirectory(); publishBlueprints(); snapshot(true);
      return;
  }
};
