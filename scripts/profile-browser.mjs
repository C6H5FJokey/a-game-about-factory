import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadContent } from './content.mjs';
import { observeGame, percentiles, readTerminalWorkload } from './observe-browser-profile.mjs';
import { browserSmoke, observeSmoke } from './browser-smoke.mjs';

const args = process.argv.slice(2);
const softwareRenderer = args.includes('--swiftshader');
const exercise = args.includes('--exercise');
const dense = args.includes('--dense');
const android = args.includes('--android');
const smoke = args.includes('--smoke');
const terminal = args.includes('--terminal') || exercise || dense;
const full = args.includes('--full');
const [browser, ...fixturePaths] = args.filter(value => !['--swiftshader', '--terminal', '--dense', '--full', '--exercise', '--android', '--smoke'].includes(value));
if ((!android && !browser) || (!terminal && fixturePaths.length === 0) || (android && (!dense || browser || softwareRenderer || full || exercise))
  || (smoke && (terminal || fixturePaths.length!==1)) || typeof WebSocket !== 'function') {
  console.error('Usage: node --experimental-websocket scripts/profile-browser.mjs [--swiftshader] [--terminal [--full] | --dense | --exercise | --smoke] <Chromium executable> [<save.dawn>...]\n       node --experimental-websocket scripts/profile-browser.mjs --dense --android');
  process.exit(1);
}

const dist = resolve(dense ? 'docs/performance.local/dense-dist' : terminal ? 'docs/performance.local/terminal-dist' : 'dist');
const wasmSha256 = createHash('sha256').update(await readFile(join(dist, 'sim.wasm'))).digest('hex');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
};
const viewport = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false };
const { frontend:{saveIdentity}, protocol } = loadContent();
const profilePrefix = 'daybreak-profile-';
const tempRoot = await realpath(tmpdir());
const profileDirectory = android ? undefined : await mkdtemp(join(tempRoot, profilePrefix));
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

let child, socket, androidSession;
try {
  await new Promise((ok, fail) => {
    site.once('error', fail);
    site.listen(0, '127.0.0.1', ok);
  });
  const origin = 'http://127.0.0.1:' + site.address().port;
  let base, tab;
  if (android) {
    androidSession = await openAndroid(site.address().port);
    ({base, tab} = androidSession);
  } else {
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
    base = 'http://127.0.0.1:' + port;
    const tabs = await fetch(base + '/json/list').then(response => response.json());
    tab = tabs.find(value => value.type === 'page');
  }
  const browserInfo = await fetch(base + '/json/version').then(response => response.json());
  socket = new WebSocket(tab.webSocketDebuggerUrl);
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
  if (!android) await cdp('Emulation.setDeviceMetricsOverride', viewport);
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: '(' + observeGame.toString() + ')()' });

  const repeats = Array.from({length:3},(_,i)=>`${dense ? 'dense' : 'terminal'}-${i+1}`);
  if (smoke) {
    const world={width:protocol.world.width,fields:protocol.view.layoutFields,layoutHeader:protocol.view.layoutHeaderWords};
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`(${observeSmoke.toString()})(${JSON.stringify(world)})`});
    const resetStorage=async()=>{
      await cdp('Page.navigate',{url:origin+'/profile-setup'});
      await waitFor(()=>js("document.title==='Profile setup'"),'setup for a new game');
      await js(`(${installSave.toString()})(${JSON.stringify('campaign:'+saveIdentity)},true)`);
    };
    await browserSmoke({cdp,js,waitFor,origin,fixturePath:fixturePaths[0],resetStorage,commands:protocol.commands});
  }
  for (const path of smoke ? [] : exercise ? ['construction-and-recovery'] : terminal ? repeats : fixturePaths) {
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
    const measuredViewport = android
      ? await js('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:true})')
      : viewport;
    if (exercise) {
      console.log(JSON.stringify({
        fixture:path, wasmSha256, browser:browserInfo.Browser, graphics, viewport,
        ...await exerciseTerminal(js,dense ? protocol.denseWorld : protocol.terminalWorld,protocol.commands,full),
      }, null, 2));
      continue;
    }
    await delay(4000);
    const beginning = terminal ? await js("profileStats.request({type:'profile-stats'},'profile-stats')") : null;
    await js('profileStats.start()');
    await delay(dense ? 30000 : 10000);
    const samples = await js('profileStats.finish()');
    const ending = terminal ? await js("profileStats.request({type:'profile-stats'},'profile-stats')") : null;
    assert.ok(samples.frames.length > 1 && samples.frames.some(([, , drawn]) => drawn > 0)
      && samples.snapshots.length > 1 && samples.endTick > samples.startTick,
      'The game must render and advance during sampling.');
    const workload = beginning && readTerminalWorkload(beginning, ending, dense);
    const timings = samples.snapshots.flatMap(([, , record]) => record ? [record] : []);
    const rendered = samples.frames.filter(([, , instances])=>instances>0);
    const p = field => percentiles(timings.map(value => value[field]));
    const decodes = groupDecodes(samples.decodes);
    console.log(JSON.stringify({
      fixture: path,
      fixtureSha256: !terminal ? createHash('sha256').update(fixture).digest('hex') : undefined,
      wasmSha256,
      workload,
      camera: terminal ? [55, 41, 32] : undefined,
      browser: browserInfo.Browser,
      device: androidSession?.device,
      graphics,
      viewport: measuredViewport,
      frames: samples.frames.length,
      renderedFrames: rendered.length,
      snapshots: samples.snapshots.length,
      elapsedSeconds: samples.elapsed / 1000,
      tickRate: (samples.endTick - samples.startTick) / (samples.elapsed / 1000),
      milliseconds: {
        frameInterval: percentiles(samples.frames.slice(1).map(([time], i) => time - samples.frames[i][0])),
        renderedFrameInterval: percentiles(rendered.slice(1).map(([time], i) => time - rendered[i][0])),
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
  await androidSession?.close();
  site.close();
  site.closeAllConnections();
  const temp = profileDirectory && await realpath(profileDirectory).catch(() => undefined);
  if (temp && dirname(temp) === tempRoot && basename(temp).startsWith(profilePrefix)) {
    await rm(temp, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  }
}

async function openAndroid(sitePort) {
  const adb = (...args) => execFileSync('adb', args, { encoding:'utf8', windowsHide:true, timeout:5000 }).trim();
  try {
    assert.equal(adb('get-state'),'device');
  } catch {
    throw new Error('Connect one authorized Android device with USB debugging and open Chrome.');
  }
  let forward, reverse, base, tab;
  const close = async () => {
    if (tab) await fetch(base + '/json/close/' + encodeURIComponent(tab.id),{signal:AbortSignal.timeout(2000)}).catch(()=>{});
    if (forward) try { adb('forward','--remove','tcp:'+forward); } catch {}
    if (reverse) try { adb('reverse','--remove','tcp:'+sitePort); } catch {}
  };
  try {
    adb('reverse','--no-rebind','tcp:'+sitePort,'tcp:'+sitePort);
    reverse=true;
    forward=adb('forward','tcp:0','localabstract:chrome_devtools_remote');
    assert.match(forward,/^\d+$/);
    base='http://127.0.0.1:'+forward;
    const version = await fetch(base+'/json/version',{signal:AbortSignal.timeout(3000)});
    assert.ok(version.ok,'Open Chrome on the Android device before running the profile.');
    const response = await fetch(base+'/json/new?about:blank',{method:'PUT',signal:AbortSignal.timeout(3000)});
    assert.ok(response.ok,'Could not create a Chrome test tab.');
    tab=await response.json();
    const socketUrl=new URL(tab.webSocketDebuggerUrl);
    socketUrl.host='127.0.0.1:'+forward;
    tab.webSocketDebuggerUrl=socketUrl.href;
    const device={model:adb('shell','getprop','ro.product.model'),android:adb('shell','getprop','ro.build.version.release'),
      soc:adb('shell','getprop','ro.soc.model')};
    return {base,tab,device,close};
  } catch (error) {
    await close();
    throw error;
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

function groupDecodes(samples) {
  const decodes = new Map();
  for (const record of samples) {
    const section = record[0];
    if (!decodes.has(section)) decodes.set(section,[]);
    decodes.get(section).push(record);
  }
  return decodes;
}

async function exerciseTerminal(js,{width},commands,full) {
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

  const laid = Array.from({length:112},(_,i)=>tile(width-3,8+i));
  await camera(width-29,62,29);
  if (!full) await waitFor(async () => (await probe(laid[40])).visible,'construction camera subscription');
  const revisionBeforeLay = (await line()).revision;
  await command('lay-112-belts',{op:commands.BuildTransport,a:revisionBeforeLay,words:laid.flatMap(at=>[at,1,1])});
  const afterLay = await line();
  assert.notEqual(afterLay.revision,revisionBeforeLay);
  assert.deepEqual([afterLay.grid,afterLay.generation],[recovered.grid,recovered.generation],
    'Laying belts leaves the live power network intact while paused');
  assert.ok((await js(`Promise.all(${JSON.stringify(laid)}.map(at=>profileStats.probe(at)))`)).every(cell=>cell.kind===1));

  const upgraded = Array.from({length:12},(_,i)=>initial.sink-12+i);
  await camera(55,41);
  if (!full) await waitFor(async () => (await probe(upgraded[0])).visible,'overwrite camera subscription');
  const occupiedBefore = (await js(`[${upgraded.join(',')}].map(at=>profileStats.probe(at).cargo?.id ?? null)`)).filter(id=>id!==null);
  assert.ok(occupiedBefore.length>0,'Use a loaded route for the overwrite');
  await command('upgrade-12-belts',{op:commands.BuildTransport,a:afterLay.revision,words:upgraded.flatMap(at=>[at,26,0])});
  const afterUpgrade = await line();
  assert.notEqual(afterUpgrade.revision,afterLay.revision);
  assert.equal(afterUpgrade.total,afterLay.total);
  assert.deepEqual(afterUpgrade.cargoIds,afterLay.cargoIds);
  assert.deepEqual([afterUpgrade.grid,afterUpgrade.generation],[afterLay.grid,afterLay.generation],
    'Rebuilding a loaded belt leaves the live power network intact while paused');
  assert.ok((await js(`[${upgraded.join(',')}].map(at=>profileStats.probe(at).kind)`)).every(kind=>kind===26));

  const processorColumn=initial.processor%width;
  const bridge = [-1,0,1].map(dx=>tile(processorColumn+dx,49));
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
    await camera(width-31,170);
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

async function installSave(key,clear=false) {
  const seed = clear ? undefined : await fetch('/profile-fixture').then(response => response.arrayBuffer());
  const db = await new Promise((ok, fail) => {
    const request = indexedDB.open('daybreak-factory', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('campaign');
    request.onsuccess = () => ok(request.result);
    request.onerror = () => fail(request.error);
  });
  await new Promise((ok, fail) => {
    const transaction = db.transaction('campaign', 'readwrite');
    if (clear) transaction.objectStore('campaign').clear();
    else transaction.objectStore('campaign').put(seed, key);
    transaction.oncomplete = () => { db.close(); ok(); };
    transaction.onabort = transaction.onerror = () => { db.close(); fail(transaction.error); };
  });
}
