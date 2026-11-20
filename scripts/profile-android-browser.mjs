import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { observeGame, percentiles, readTerminalWorkload } from './observe-browser-profile.mjs';

const [browser] = process.argv.slice(2);
assert.match(browser ?? '',/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/,'Pass the installed Android browser package.');
const adb = (...args) => execFileSync('adb',args,{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
assert.equal(adb('get-state'),'device','Connect one Android device and authorize USB debugging.');

const root = resolve('docs/performance.local/dense-dist');
const wasmSha256 = createHash('sha256').update(await readFile(resolve(root,'sim.wasm'))).digest('hex');
const device = {
  model:adb('shell','getprop','ro.product.model'),
  android:adb('shell','getprop','ro.build.version.release'),
  soc:adb('shell','getprop','ro.soc.model'),
  browser,
  version:adb('shell','dumpsys','package',browser).match(/versionName=(\S+)/)?.[1],
};
const html = (await readFile(resolve(root,'index.html'),'utf8')).replace('<head>',
  '<head><script src="/profile-observer.js"></script>');
const observer = `(${observeGame.toString()})();(${samplePage.toString()})();`;
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm'};
const reports = [];
let complete, fail;
const finished = new Promise((ok,error)=>{ complete=ok; fail=error; });
const timeout = setTimeout(()=>fail(new Error('Timed out waiting for the Android browser test page.')),180000).unref();

const server = createServer(async (request,response) => {
  try {
    const url = new URL(request.url,'http://localhost');
    if (url.pathname==='/') {
      console.error('Android test page loaded, round '+url.searchParams.get('round'));
      response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}).end(html);
    } else if (url.pathname==='/profile-observer.js') {
      response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end(observer);
    } else if (url.pathname==='/profile-result' && request.method==='POST') {
      const chunks=[];
      let bytes=0;
      for await (const chunk of request) {
        bytes+=chunk.length;
        assert.ok(bytes<=2_000_000,'Android report is too large');
        chunks.push(chunk);
      }
      const report=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (report.error) throw new Error(report.error);
      assert.equal(report.round,reports.length+1);
      const result=summarize(report);
      reports.push(result);
      console.log(JSON.stringify(result));
      response.writeHead(204).end();
      if (reports.length===3) complete();
    } else {
      const asset=resolve(root,'.'+url.pathname);
      if (!asset.startsWith(root+sep)) return response.writeHead(403).end();
      const data=await readFile(asset);
      response.writeHead(200,{'Content-Type':mime[extname(asset)] ?? 'application/octet-stream'}).end(data);
    }
  } catch (error) {
    if (!response.headersSent) response.writeHead(404).end();
    if (request.url==='/profile-result') fail(error);
  }
});

let reverse;
try {
  await new Promise((ok,error)=>{
    server.once('error',error);
    server.listen(0,'127.0.0.1',ok);
  });
  const port=server.address().port;
  adb('reverse','--no-rebind','tcp:'+port,'tcp:'+port);
  reverse='tcp:'+port;
  const opened=adb('shell','am','start','-W','-a','android.intent.action.VIEW',
    '-d',`http://127.0.0.1:${port}/?round=1`,'-p',browser,'--ez','create_new_tab','true');
  assert.match(opened,/Status: ok/,opened);
  await finished;
} finally {
  clearTimeout(timeout);
  server.close();
  server.closeAllConnections();
  if (reverse) adb('reverse','--remove',reverse);
}

function summarize({round,samples,graphics,viewport,camera,userAgent,beginning,ending}) {
  const rendered=samples.frames.filter(([, , instances])=>instances>0);
  const timing=samples.snapshots.flatMap(([, , record])=>record?[record]:[]);
  assert.ok(rendered.length>1 && timing.length>1 && samples.endTick>samples.startTick,
    'The browser must draw and the factory must advance during sampling.');
  const seconds=samples.elapsed/1000;
  return {round,device,graphics,viewport,camera,userAgent,wasmSha256,seconds,
    workload:readTerminalWorkload(beginning,ending,true),
    renderedFrames:rendered.length,tickRate:(samples.endTick-samples.startTick)/seconds,
    renderedFrameInterval:percentiles(rendered.slice(1).map(([time],i)=>time-rendered[i][0])),
    drawnInstances:percentiles(rendered.map(([, , count])=>count)),
    workerStep:percentiles(timing.flatMap(value=>value.steps ?? [])),
    snapshotWrite:percentiles(timing.map(value=>value.writeMs)),
    snapshotBytes:percentiles(samples.snapshots.map(([, bytes])=>bytes)),
    publishedBytesPerSecond:samples.bytes/seconds};
}

async function samplePage() {
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const round=Number(new URLSearchParams(location.search).get('round'));
  const send=report=>fetch('/profile-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
  let wakeLock;
  try {
    if (navigator.wakeLock && !document.hidden) {
      try { wakeLock=await navigator.wakeLock.request('screen'); } catch {}
    }
    for (let i=0;i<300;i++) {
      if (window.profileStats?.tick>=1800 && document.querySelector('#app')?.getAttribute('aria-busy')==='false') break;
      if (i===299) throw new Error('Dense build did not finish loading in the Android browser.');
      await delay(100);
    }
    if (document.hidden) throw new Error('Keep the Android test tab in the foreground.');
    const gl=document.querySelector('#world').getContext('webgl2');
    if (!gl) throw new Error('This Android browser did not provide a WebGL2 context.');
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    const graphics=gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
    const viewport={width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio};
    const stats=window.profileStats;
    await delay(4000);
    const beginning=await stats.request({type:'profile-stats'},'profile-stats');
    stats.start();
    await delay(30000);
    const samples=stats.finish();
    const ending=await stats.request({type:'profile-stats'},'profile-stats');
    if (document.hidden || innerWidth!==viewport.width || innerHeight!==viewport.height) {
      throw new Error('Keep the Android test tab in the foreground and the viewport size fixed.');
    }
    const response=await send({round,samples,graphics,viewport,camera:[55,41,32],userAgent:navigator.userAgent,beginning,ending});
    if (!response.ok) throw new Error('Could not publish the Android measurement.');
    if (round<3) location.replace('/?round='+(round+1));
    else {
      stats.worker.terminate();
      window.requestAnimationFrame=()=>0;
      document.title='Daybreak Factory · Android profile complete';
    }
  } catch (error) {
    await send({round,error:String(error)});
  } finally {
    if (wakeLock && !wakeLock.released) await wakeLock.release();
  }
}
