import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadContent } from './content.mjs';

const args = process.argv.slice(2);
const softwareRenderer = args.includes('--swiftshader');
const exercise = args.includes('--exercise');
const terminal = args.includes('--terminal') || exercise;
const full = args.includes('--full');
const [browser, ...fixturePaths] = args.filter(value => !['--swiftshader', '--terminal', '--full', '--exercise'].includes(value));
if (!browser || (!terminal && fixturePaths.length === 0) || typeof WebSocket !== 'function') {
  console.error('Usage: node --experimental-websocket scripts/profile-browser.mjs [--swiftshader] [--terminal [--full] | --exercise] <Chromium executable> [<save.dawn>...]');
  process.exit(1);
}

const dist = resolve(terminal ? 'docs/performance.local/terminal-dist' : 'dist');
const wasmSha256 = createHash('sha256').update(await readFile(join(dist, 'sim.wasm'))).digest('hex');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
};
const viewport = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false };
const { frontend:{saveIdentity}, protocol } = loadContent();
const profilePrefix = 'daybreak-profile-';
const tempRoot = await realpath(tmpdir());
const profileDirectory = await mkdtemp(join(tempRoot, profilePrefix));
let fixture;
const site = createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname === '/profile-setup') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Profile setup</title>');
      return;
    }
    if (pathname === '/profile-fixture') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(fixture);
      return;
    }
    const asset = resolve(dist, pathname === '/' ? 'index.html' : '.' + pathname);
    if (!asset.startsWith(dist + sep)) {
      response.writeHead(403).end();
      return;
    }
    const bytes = await readFile(asset);
    response.writeHead(200, { 'Content-Type': mime[extname(asset)] ?? 'application/octet-stream' }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

let child, socket;
try {
  await new Promise((ok, fail) => {
    site.once('error', fail);
    site.listen(0, '127.0.0.1', ok);
  });
  const origin = 'http://127.0.0.1:' + site.address().port;
  child = spawn(browser, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--no-proxy-server', '--remote-debugging-port=0',
    ...(softwareRenderer ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : []),
    '--user-data-dir=' + profileDirectory, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  await waitFor(async () => {
    if (spawnError) throw spawnError;
    return readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8').catch(() => undefined);
  }, 'Chromium DevTools port');
  const [port] = (await readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
  const base = 'http://127.0.0.1:' + port;
  const browserInfo = await fetch(base + '/json/version').then(response => response.json());
  const tabs = await fetch(base + '/json/list').then(response => response.json());
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', fail, { once: true });
  });
  const cdp = client(socket);
  const js = async expression => {
    const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', viewport);
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: '(' + observeGame.toString() + ')()' });

  for (const path of exercise ? ['construction-and-recovery'] : terminal ? ['terminal-1', 'terminal-2', 'terminal-3'] : fixturePaths) {
    if (!terminal) {
      fixture = await readFile(path);
      await cdp('Page.navigate', { url: origin + '/profile-setup' });
      await waitFor(() => js("document.title === 'Profile setup'"), 'profile setup page');
      await js(`(${installSave.toString()})(${JSON.stringify('campaign:' + saveIdentity)})`);
    }
    await cdp('Page.navigate', { url: origin + (full ? '/?snapshot=full' : '/') });
    await waitFor(() => js(`window.profileStats?.tick >= ${terminal ? 1800 : fixture.readInt32LE(4)} &&
      document.querySelector('#app')?.getAttribute('aria-busy') === 'false'`), 'ready game with loaded fixture');
    const graphics = await js(`(() => {
      const gl = document.querySelector('#world').getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    })()`);
    if (exercise) {
      console.log(JSON.stringify({
        fixture:path, wasmSha256, browser:browserInfo.Browser, graphics, viewport,
        ...await exerciseTerminal(js,protocol,full),
      }, null, 2));
      continue;
    }
    await delay(4000);
    const beginning = terminal ? await js("profileStats.request({type:'profile-stats'},'profile-stats')") : null;
    await js('profileStats.start()');
    await delay(10000);
    const samples = await js('profileStats.finish()');
    const ending = terminal ? await js("profileStats.request({type:'profile-stats'},'profile-stats')") : null;
    assert.ok(samples.frames.length > 1 && samples.frames.some(([, , drawn]) => drawn > 0)
      && samples.snapshots.length > 1 && samples.endTick > samples.startTick,
      'The game must render and advance during sampling.');
    const workload = beginning && readTerminalWorkload(beginning, ending);
    const timings = samples.snapshots.flatMap(([, , record]) => record ? [record] : []);
    const p = field => percentiles(timings.map(value => value[field]));
    const decodes = groupDecodes(samples.decodes);
    console.log(JSON.stringify({
      fixture: path,
      fixtureSha256: !terminal ? createHash('sha256').update(fixture).digest('hex') : undefined,
      wasmSha256,
      workload,
      camera: terminal ? [55, 41, 32] : undefined,
      browser: browserInfo.Browser,
      graphics,
      viewport,
      frames: samples.frames.length,
      snapshots: samples.snapshots.length,
      tickRate: (samples.endTick - samples.startTick) / (samples.elapsed / 1000),
      milliseconds: {
        frameInterval: percentiles(samples.frames.slice(1).map(([time], i) => time - samples.frames[i][0])),
        frameCallbackCpu: percentiles(samples.frames.map(([, duration]) => duration)),
        snapshotInterval: percentiles(samples.snapshots.slice(1).map(([time], i) => time - samples.snapshots[i][0])),
        workerStep: terminal ? percentiles(timings.flatMap(value => value.steps ?? [])) : undefined,
        snapshotWrite: terminal ? p('writeMs') : undefined,
        wasmCopy: terminal ? p('copyMs') : undefined,
        messageArrival: terminal ? p('messageMs') : undefined,
        snapshotDecode: terminal ? percentiles(decodes.get('frame').map(([,elapsed])=>elapsed)) : undefined,
      },
      decodeSections: terminal ? Object.fromEntries([...decodes].map(([section,values]) =>
        [section,{samples:values.length,...percentiles(values.map(([,elapsed])=>elapsed))}])) : undefined,
      drawnInstances: percentiles(samples.frames.map(([, , instances]) => instances)),
      snapshotBytes: percentiles(samples.snapshots.map(([, bytes]) => bytes)),
      publishedBytesPerSecond: samples.bytes / (samples.elapsed / 1000),
    }, null, 2));
  }
} finally {
  socket?.close();
  child?.kill();
  site.close();
  site.closeAllConnections();
  const temp = await realpath(profileDirectory).catch(() => undefined);
  if (temp && dirname(temp) === tempRoot && basename(temp).startsWith(profilePrefix)) {
    await rm(temp, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  }
}

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + description);
}

function client(socket) {
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    const handler = pending.get(reply.id);
    if (handler) handler(reply);
  });
  return (method, params = {}) => new Promise((ok, fail) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      fail(new Error('DevTools request timed out: ' + method));
    }, 10000);
    pending.set(id, reply => {
      pending.delete(id);
      clearTimeout(timeout);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else ok(reply.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function percentiles(samples) {
  assert.ok(samples.length, 'Missing measurement samples');
  const sorted = samples.toSorted((a, b) => a - b);
  const at = p => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return { p50: at(0.50), p95: at(0.95), p99: at(0.99) };
}

function groupDecodes(samples) {
  const decodes = new Map();
  for (const record of samples) {
    const section = record[0];
    if (!decodes.has(section)) decodes.set(section,[]);
    decodes.get(section).push(record);
  }
  return decodes;
}

function readTerminalWorkload(beginning, ending) {
  const read = ({values:[transport, processors, running, grids, stock, delivered, upperSources, cargo, tick],supplied}) =>
    ({transport, processors, running, grids, stock, delivered, upperSources, cargo, tick, supplied});
  const start = read(beginning), end = read(ending);
  assert.equal(start.transport, 46020);
  assert.equal(start.processors, 1755);
  assert.equal(start.running, start.processors);
  assert.equal(end.running, start.running);
  assert.equal(start.grids, 195);
  assert.ok(start.cargo > 17000 && end.cargo > 17000);
  assert.ok(start.upperSources > 0 && end.upperSources > 0);
  const deliveries = end.delivered - start.delivered;
  assert.ok(deliveries > start.processors);
  const handoffsPerSecond = (end.supplied - start.supplied + start.stock - end.stock + deliveries)
    * 30 / (end.tick - start.tick);
  return {start, end, deliveries, handoffsPerSecond};
}

async function exerciseTerminal(js,{commands,terminalWorld},full) {
  const {width} = terminalWorld;
  const tile = (x,y) => y*width+x;
  const send = (message,type=message.type) => js(`profileStats.request(${JSON.stringify(message)},${JSON.stringify(type)})`);
  const post = message => js(`profileStats.worker.postMessage(${JSON.stringify(message)})`);
  const camera = (x,y,zoom=32) => js(`profileStats.camera(${x},${y},${zoom})`);
  const probe = (at,pick=false) => js(`profileStats.probe(${at},${pick})`);
  const advance = ticks => send({type:'profile-advance',ticks});
  const line = async () => {
    const { values:[tick,revision,processor,sink,sinkId,output,stored,room,cargo,blocked,status,grid,total,generation,supplied,...cargoIds] }
      = await send({type:'profile-line'});
    return {tick,revision,processor,sink,sinkId,output,stored,room,cargo,blocked,status,grid,total,generation,supplied,cargoIds};
  };
  const timedCommands = [];
  async function command(name,data) {
    await js('profileStats.start()');
    await delay(100);
    const started = performance.now();
    const result = await send({type:'command',data},'command-result');
    const roundTripMs = performance.now() - started;
    await delay(140);
    const samples = await js('profileStats.finish()');
    assert.ok(result.status>0, name + ' rejected: ' + result.status);
    assert.ok(samples.frames.length>2, 'Construction must run with the renderer active');
    const framePeakMs = Math.max(...samples.frames.slice(1).map(([t],i)=>t-samples.frames[i][0]));
    timedCommands.push({name,commandMs:result.commandMs,roundTripMs,framePeakMs});
    return result.status;
  }

  await post({type:'speed',speed:0});
  await send({type:'profile-exercise'});
  const initial = await line();
  assert.equal(initial.room,4);
  let plugged = initial;
  let filledAfterTicks;
  for (let i=0;i<15 && (plugged.room!==0 || plugged.status!==4);i++) {
    await advance(90);
    plugged = await line();
    if (plugged.room===0 && filledAfterTicks===undefined) filledAfterTicks = plugged.tick-initial.tick;
  }
  assert.equal(plugged.room,0,'Sink must actually become full');
  assert.equal(plugged.status,4,'Backpressure must reach the processor output');
  assert.ok(plugged.blocked>0 && plugged.cargo>initial.cargo,'The line must accumulate blocked cargo');
  assert.equal(plugged.total-initial.total,plugged.supplied-initial.supplied,'Conserve material while the queue fills');
  const removed = await command('warehouse-to-backpack',{op:commands.Transfer,a:plugged.sink,b:-1,c:plugged.output,
    words:[64,plugged.sinkId,0,1]});
  const released = await line();
  assert.equal(removed,64);
  assert.equal(released.stored,plugged.stored-64);
  assert.equal(released.total,plugged.total,'Conserve material while transferring to the backpack');
  let recovered = released;
  let resumedAfterTicks, arrivalAfterTicks;
  for (let i=0;i<24 && (resumedAfterTicks===undefined || arrivalAfterTicks===undefined || recovered.blocked!==0);i++) {
    await advance(15);
    recovered = await line();
    if (resumedAfterTicks===undefined && recovered.status===1) resumedAfterTicks = recovered.tick-released.tick;
    if (arrivalAfterTicks===undefined && recovered.stored>released.stored) arrivalAfterTicks = recovered.tick-released.tick;
  }
  assert.ok(resumedAfterTicks!==undefined && arrivalAfterTicks!==undefined,'The processor and deliveries must resume');
  assert.equal(recovered.blocked,0,'The tail of blocked cargo must clear');
  assert.equal(recovered.total-released.total,recovered.supplied-released.supplied,'Conserve material through recovery');
  await js("(async()=>{ profileStats.exerciseSave=(await profileStats.request({type:'save'},'save')).buffer; })()");

  const laid = Array.from({length:112},(_,i)=>tile(253,8+i));
  await camera(227,62,29);
  if (!full) await waitFor(async () => (await probe(laid[40])).visible,'construction camera subscription');
  const revisionBeforeLay = (await line()).revision;
  await command('lay-112-belts',{op:commands.BuildTransport,a:revisionBeforeLay,words:laid.flatMap(at=>[at,1,1])});
  const afterLay = await line();
  assert.notEqual(afterLay.revision,revisionBeforeLay);
  assert.ok((await js(`Promise.all(${JSON.stringify(laid)}.map(at=>profileStats.probe(at)))`)).every(cell=>cell.kind===1));

  const upgraded = Array.from({length:12},(_,i)=>tile(43+i,42));
  await camera(55,41);
  if (!full) await waitFor(async () => (await probe(upgraded[0])).visible,'overwrite camera subscription');
  const occupiedBefore = (await js(`[${upgraded.join(',')}].map(at=>profileStats.probe(at).cargo?.id ?? null)`)).filter(id=>id!==null);
  assert.ok(occupiedBefore.length>0,'Use a loaded route for the overwrite');
  await command('upgrade-12-belts',{op:commands.BuildTransport,a:afterLay.revision,words:upgraded.flatMap(at=>[at,26,0])});
  const afterUpgrade = await line();
  assert.notEqual(afterUpgrade.revision,afterLay.revision);
  assert.equal(afterUpgrade.total,afterLay.total);
  assert.deepEqual(afterUpgrade.cargoIds,afterLay.cargoIds);
  assert.ok((await js(`[${upgraded.join(',')}].map(at=>profileStats.probe(at).kind)`)).every(kind=>kind===26));

  const bridge = [38,39,40].map(x=>tile(x,49));
  await advance(1);
  const beforeCut = await line();
  assert.ok(beforeCut.grid>0 && beforeCut.generation>0,'Begin with a powered line');
  await command('remove-3-cables',{op:commands.RemoveCables,words:bridge});
  assert.ok((await js(`[${bridge.join(',')}].map(at=>profileStats.probe(at).wire)`)).every(wire=>wire===0));
  await advance(15);
  const withoutPower = await line();
  assert.equal(withoutPower.generation,0);
  assert.equal(withoutPower.status,3,'The removed cable must disconnect actual supply');
  await command('reconnect-3-cables',{op:commands.Route,a:1,words:bridge.flatMap(at=>[at,0])});
  assert.ok((await js(`[${bridge.join(',')}].map(at=>profileStats.probe(at).wire)`)).every(wire=>wire===1));
  await advance(45);
  const restoredPower = await line();
  assert.ok(restoredPower.generation>0 && restoredPower.status===1);
  assert.equal(restoredPower.total-beforeCut.total,restoredPower.supplied-beforeCut.supplied);

  if (!full) {
    const selected = await probe(restoredPower.processor,true);
    assert.equal(selected.selected,restoredPower.processor);
    const layoutBeforePan = await js('profileStats.layoutMessages');
    await camera(225,170);
    await waitFor(async () => !(await probe(upgraded[0])).visible,'old viewport excluded while paused');
    const outside = await probe(restoredPower.processor);
    assert.deepEqual(outside.device,selected.device,'Keep an inspected offscreen machine available');
    assert.deepEqual(outside.recipe,selected.recipe);
    assert.equal(outside.tick,selected.tick,'A paused pan must not advance the factory');
    await advance(90);
    const whileOutside = await line();
    assert.ok(whileOutside.stored>restoredPower.stored,'An offscreen line keeps producing and delivering');
    await camera(55,41);
    await waitFor(async () => (await probe(upgraded[0])).visible,'returning viewport receives live state');
    assert.equal((await probe(upgraded[0])).tick,whileOutside.tick);
    const returnedCargo = (await js(`[${upgraded.join(',')}].map(at=>profileStats.probe(at).cargo?.id ?? null)`)).filter(id=>id!==null);
    assert.ok(returnedCargo.length>0 && returnedCargo.every(id=>whileOutside.cargoIds.includes(id)),
      'Returning viewport shows the live cargo after offscreen production');
    assert.equal(await js('profileStats.layoutMessages'),layoutBeforePan,'Pan and step reuse the cached topology');
    await js("profileStats.request({type:'restore',buffer:profileStats.exerciseSave},'restored').then(()=>true)");
    await waitFor(async () => (await probe(laid[0])).kind===0 && (await probe(upgraded[0])).kind===1,
      'restored save replaces cached topology');
    assert.equal((await line()).tick,recovered.tick);
    assert.equal((await line()).total,recovered.total);
  }

  return {
    blockage:{initialCargo:initial.cargo,pluggedCargo:plugged.cargo,blocked:plugged.blocked,
      filledWithinTicks:filledAfterTicks,backpressureWithinTicks:plugged.tick-initial.tick,
      arrivalWithinTicks:arrivalAfterTicks,resumedWithinTicks:resumedAfterTicks,
      allCargoClearWithinTicks:recovered.tick-released.tick},
    commands:timedCommands,
    upgradedWithCargo:occupiedBefore.length,
    scopedRegression:!full,
  };
}

function observeGame() {
  let startedAt, startTick, instances = 0;
  const stats = window.profileStats = {
    tick: -1,
    layoutMessages: 0,
    camera(x,y,zoom) {
      window.dispatchEvent(new CustomEvent('terminal-profile-camera',{detail:{x,y,zoom}}));
    },
    probe(tile,pick=false) {
      let result;
      window.dispatchEvent(new CustomEvent('terminal-profile-probe',{detail:{tile,pick,reply:value=>{ result=value; }}}));
      return result;
    },
    start() {
      startedAt = performance.now();
      startTick = stats.tick;
      stats.samples = { frames: [], snapshots: [], decodes: [], bytes: 0 };
    },
    finish() {
      const values = stats.samples;
      stats.samples = undefined;
      return { ...values, elapsed: performance.now() - startedAt, startTick, endTick: stats.tick };
    },
    request(message, type) {
      return new Promise((resolve, reject) => {
        const worker = stats.worker;
        const listener = ({data}) => {
          const failedRestore = type==='restored' && data.type==='invalid-save';
          if (data.type !== type && data.type !== 'error' && !failedRestore) return;
          clearTimeout(timer);
          worker.removeEventListener('message', listener);
          if (failedRestore) reject(new Error('Restore rejected: ' + data.status));
          else if (data.type === 'error') reject(new Error(data.message ?? data.key));
          else resolve(data);
        };
        const timer = setTimeout(() => {
          worker.removeEventListener('message', listener);
          reject(new Error('Timed out waiting for worker ' + type));
        }, 8000);
        worker.addEventListener('message', listener);
        worker.postMessage(message, message.buffer ? [message.buffer] : []);
      });
    },
  };
  window.addEventListener('terminal-profile-decode', ({detail}) => stats.samples?.decodes.push(detail));
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      stats.worker = this;
      this.addEventListener('message', event => {
        const {type,buffer,profile} = event.data;
        if (type !== 'snapshot' && type !== 'snapshot-layout') return;
        if (stats.samples) stats.samples.bytes += buffer.byteLength;
        if (type !== 'snapshot') { stats.layoutMessages++; return; }
        stats.tick = new Int32Array(buffer, 0, 1)[0];
        if (stats.samples) {
          const now = performance.now();
          stats.samples.snapshots.push([now,buffer.byteLength,profile &&
            {...profile,messageMs: Math.max(0, performance.timeOrigin + now - profile.sentAt)}]);
        }
      });
    }
  };
  const nativeDraw = WebGL2RenderingContext.prototype.drawArraysInstanced;
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (mode, first, count, drawn) {
    instances += drawn;
    return nativeDraw.call(this, mode, first, count, drawn);
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => raf(time => {
    instances = 0;
    const start = performance.now();
    callback(time);
    stats.samples?.frames.push([time, performance.now() - start, instances]);
  });
}

async function installSave(key) {
  const seed = await fetch('/profile-fixture').then(response => response.arrayBuffer());
  const db = await new Promise((ok, fail) => {
    const request = indexedDB.open('daybreak-factory', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('campaign');
    request.onsuccess = () => ok(request.result);
    request.onerror = () => fail(request.error);
  });
  await new Promise((ok, fail) => {
    const transaction = db.transaction('campaign', 'readwrite');
    transaction.objectStore('campaign').put(seed, key);
    transaction.oncomplete = () => { db.close(); ok(); };
    transaction.onabort = transaction.onerror = () => { db.close(); fail(transaction.error); };
  });
}
