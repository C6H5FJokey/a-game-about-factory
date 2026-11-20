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
const [browser, ...fixturePaths] = args.filter(value => value !== '--swiftshader');
if (!browser || fixturePaths.length === 0 || typeof WebSocket !== 'function') {
  console.error('Usage: node --experimental-websocket scripts/profile-browser.mjs [--swiftshader] <Chromium executable> <save.dawn> [<save.dawn>...]');
  process.exit(1);
}

const dist = resolve('dist');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
};
const viewport = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false };
const { saveIdentity } = loadContent().frontend;
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

  for (const path of fixturePaths) {
    fixture = await readFile(path);
    await cdp('Page.navigate', { url: origin + '/profile-setup' });
    await waitFor(() => js("document.title === 'Profile setup'"), 'profile setup page');
    await js(`(${installSave.toString()})(${JSON.stringify('campaign:' + saveIdentity)})`);
    await cdp('Page.navigate', { url: origin + '/' });
    await waitFor(() => js(`window.profileStats?.tick >= ${fixture.readInt32LE(4)} &&
      document.querySelector('#app')?.getAttribute('aria-busy') === 'false'`), 'ready game with loaded fixture');
    const graphics = await js(`(() => {
      const gl = document.querySelector('#world').getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    })()`);
    await delay(4000);
    await js('profileStats.start()');
    await delay(10000);
    const samples = await js('profileStats.finish()');
    assert.ok(samples.frames.length > 1 && samples.frames.some(([, , drawn]) => drawn > 0)
      && samples.snapshots.length > 1 && samples.endTick > samples.startTick,
      'The game must render and advance during sampling.');
    console.log(JSON.stringify({
      fixture: path,
      fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
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
      },
      drawnInstances: percentiles(samples.frames.map(([, , instances]) => instances)),
      snapshotBytes: percentiles(samples.snapshots.map(([, bytes]) => bytes)),
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
  const sorted = samples.toSorted((a, b) => a - b);
  const at = p => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return { p50: at(0.50), p95: at(0.95), p99: at(0.99) };
}

function observeGame() {
  let startedAt, startTick, instances = 0;
  const stats = window.profileStats = {
    tick: -1,
    start() {
      startedAt = performance.now();
      startTick = stats.tick;
      stats.samples = { frames: [], snapshots: [] };
    },
    finish() {
      const values = stats.samples;
      stats.samples = undefined;
      return { ...values, elapsed: performance.now() - startedAt, startTick, endTick: stats.tick };
    },
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (event.data.type !== 'snapshot') return;
        stats.tick = new Int32Array(event.data.buffer, 0, 1)[0];
        stats.samples?.snapshots.push([performance.now(), event.data.buffer.byteLength]);
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
