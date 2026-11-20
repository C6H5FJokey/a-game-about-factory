import assert from 'node:assert/strict';

export function observeGame() {
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

export function percentiles(samples) {
  assert.ok(samples.length, 'Missing measurement samples');
  const sorted = samples.toSorted((a, b) => a - b);
  const at = p => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return { p50: at(0.50), p95: at(0.95), p99: at(0.99) };
}

export function readTerminalWorkload(beginning, ending, dense) {
  const read = ({values:[transport, processors, running, grids, stock, delivered, upperSources, cargo, tick],supplied}) =>
    ({transport, processors, running, grids, stock, delivered, upperSources, cargo, tick, supplied});
  const start = read(beginning), end = read(ending);
  if (dense) {
    assert.ok(start.transport > 65_535 && start.processors >= 3500);
    assert.ok(start.cargo >= 37_000 && end.cargo >= 37_000);
  } else {
    assert.equal(start.transport, 46020);
    assert.equal(start.processors, 1755);
    assert.equal(start.grids, 195);
    assert.ok(start.cargo > 17000 && end.cargo > 17000);
  }
  assert.equal(start.running, start.processors);
  assert.equal(end.running, start.running);
  assert.ok(start.upperSources > 0 && end.upperSources > 0);
  const deliveries = end.delivered - start.delivered;
  assert.ok(deliveries > 0 && end.tick > start.tick,'The loaded factory must deliver while advancing.');
  const handoffsPerSecond = (end.supplied - start.supplied + start.stock - end.stock + deliveries)
    * 30 / (end.tick - start.tick);
  return {start, end, deliveries, handoffsPerSecond};
}
