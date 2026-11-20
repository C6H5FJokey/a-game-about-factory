import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function observeSmoke(world) {
  const stats = window.profileStats;
  const uniforms = new WeakMap();
  const camera = {};
  const gl = WebGL2RenderingContext.prototype;
  const location = gl.getUniformLocation;
  gl.getUniformLocation = function (program,name) {
    const value=location.call(this,program,name);
    if (value) uniforms.set(value,name);
    return value;
  };
  for (const name of ['uniform2f','uniform1f']) {
    const write=gl[name];
    gl[name]=function (where,...values) {
      if (this.canvas.id==='world' && uniforms.has(where)) camera[uniforms.get(where)]=values;
      return write.call(this,where,...values);
    };
  }

  const smoke = stats.smoke = {
    results: [], imports: 0, errors: [], events: [], layout: undefined,
    point(x,y) {
      const map=document.querySelector('#world');
      if (!camera.camera || !camera.zoom || !camera.viewport) return;
      const [cx,cy]=camera.camera, [width,height]=camera.viewport, [zoom]=camera.zoom;
      const rect=map.getBoundingClientRect();
      const px=rect.left+width/2+(x+.5-cx)*zoom, py=rect.top+height/2+(y+.5-cy)*zoom;
      return document.elementFromPoint(px,py)===map ? {x:px,y:py} : undefined;
    },
    staticCell(x,y,field) {
      const column=world.fields.indexOf(field);
      return smoke.layout?.[world.layoutHeader+(y*world.width+x)*world.fields.length+column];
    },
    held(item) {
      return Array.from(document.querySelectorAll(`#balances [data-slot="held"][data-item="${item}"]`),
        element=>Number(element.dataset.count));
    },
  };
  for (const name of ['pointerdown','pointerup','pointercancel','click']) {
    window.addEventListener(name,event=>{
      const target=event.target.closest('[data-action],[data-tool],[data-slot],canvas') ?? event.target;
      smoke.events.push([name,event.pointerType,target.tagName,target.id,target.dataset?.action,target.dataset?.tool]);
      if (smoke.events.length>24) smoke.events.shift();
    },true);
  }
  window.addEventListener('error',({message})=>smoke.errors.push(message));
  const Worker = window.Worker;
  window.Worker=class extends Worker {
    constructor(...args) {
      super(...args);
      this.commands=[];
      this.addEventListener('message',({data})=>{
        if (data.type==='command-result') smoke.results.push({command:this.commands.shift(),status:data.status});
        if (data.type==='snapshot-layout') smoke.layout=new Int32Array(data.buffer);
        if (data.type==='restored') smoke.imports++;
        if (data.type==='error' || data.type==='invalid-save') smoke.errors.push(data.message ?? data.key ?? data.status);
      });
    }
    postMessage(message,transfer) {
      if (message.type==='command') this.commands.push(message.data);
      return super.postMessage(message,transfer);
    }
  };
}

export async function browserSmoke({ cdp, js, waitFor, origin, fixturePath, resetStorage, commands }) {
  await cdp('DOM.enable');
  await cdp('Page.setInterceptFileChooserDialog',{enabled:true});

  for (const touch of [false,true]) {
    const viewport=touch ? {width:430,height:932,deviceScaleFactor:2,mobile:true}
      : {width:1920,height:1080,deviceScaleFactor:1,mobile:false};
    await cdp('Emulation.setDeviceMetricsOverride',viewport);
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:touch,maxTouchPoints:touch?2:1});
    await resetStorage();
    await cdp('Page.navigate',{url:origin+'/'});
    await waitFor(()=>js("document.querySelector('#app')?.getAttribute('aria-busy')==='false'"),'opening');

    const pointer=async (phase,point)=>{
      if (touch) {
        const type={down:'touchStart',move:'touchMove',up:'touchEnd'}[phase];
        await cdp('Input.dispatchTouchEvent',{type,touchPoints:phase==='up'?[]:[point]});
      } else {
        const type={down:'mousePressed',move:'mouseMoved',up:'mouseReleased'}[phase];
        await cdp('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:phase==='up'?0:1,clickCount:1});
      }
    };
    const activate=async point=>{
      await pointer('down',point);
      await pointer('up',point);
      if (touch) await delay(80);
    };
    const button=async selector=>{
      const point=await untilValue(async()=>js(`(() => {
        for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
          if (el.disabled || el.closest('[inert]') || el.getClientRects().length===0) continue;
          el.scrollIntoView({block:'nearest',inline:'nearest'});
          const rect=el.getBoundingClientRect(), x=rect.left+rect.width/2, y=rect.top+rect.height/2;
          if (el.contains(document.elementFromPoint(x,y))) return {x,y};
        }
      })()`),selector);
      await activate(point);
    };
    async function untilValue(read,description) {
      let value;
      await waitFor(async()=>Boolean(value=await read()),description);
      return value;
    }
    const mapPoint=(x,y)=>untilValue(()=>js(`profileStats.smoke.point(${x},${y})`),`map point ${x},${y}`);
    const result=async op=>{
      try {
        return await untilValue(()=>js(`profileStats.smoke.results.findLast(row=>row.command?.op===${op})`),`command ${op}`);
      } catch (error) {
        const state=await js("({events:profileStats.smoke.events,results:profileStats.smoke.results,errors:profileStats.smoke.errors,draft:document.querySelector('#draft').textContent})");
        throw new Error(error.message+' '+JSON.stringify(state),{cause:error});
      }
    };
    const held=item=>js(`profileStats.smoke.held(${item})`);

    assert.deepEqual(await held(1),[]);
    const iron=await mapPoint(19,16);
    await pointer('down',iron);
    await delay(650);
    await pointer('up',iron);
    assert.equal((await result(commands.Gather)).status,1);
    await waitFor(async()=>JSON.stringify(await held(1))==='[1]','first ore in the backpack');

    await button('[data-action="archive"]');
    await button('[data-action="import"]');
    const {root}=await cdp('DOM.getDocument');
    const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:'#save-file'});
    assert.ok(nodeId);
    await cdp('DOM.setFileInputFiles',{files:[resolve(fixturePath)],nodeId});
    await waitFor(()=>js('profileStats.smoke.imports===1 && profileStats.smoke.staticCell(20,16,0)===12'),'imported warehouse and layout');
    await waitFor(async()=>JSON.stringify(await held(1))==='[100,17]','restored inventory stacks');

    await activate(await mapPoint(20,16));
    await waitFor(()=>js("!!document.querySelector('#panel [data-container-put]')"),'empty warehouse has a drop target');
    assert.equal(await js("document.querySelectorAll('#panel [data-slot]').length"),0);
    await button('#balances [data-slot="held"][data-item="1"][data-stack-index="1"]');
    await button('#panel [data-container-put]');
    const transfer=await result(commands.Transfer);
    assert.deepEqual([transfer.status,transfer.command.words[0]],[17,17]);
    await waitFor(()=>js("document.querySelector('#panel [data-slot][data-item=\"1\"]')?.dataset.count==='17'"),'deposited remainder stack');
    assert.deepEqual(await held(1),[100]);
    const stored='#panel [data-slot="input"][data-item="1"]';
    await button(stored);
    await button(stored);
    await waitFor(async()=>JSON.stringify(await held(1))==='[100,17]','double-click withdraws the stored stack');
    assert.equal((await result(commands.Transfer)).status,17);
    assert.equal(await js("!!document.querySelector('#panel [data-slot][data-item=\"1\"]')"),false);

    await button('[data-mode="build"]');
    await button('[data-tool="wire"]');
    await waitFor(()=>js("!!document.querySelector('[data-tool=\"wire\"][aria-pressed=\"true\"]')"),'cable tool selected');
    const route=async()=>{
      await delay(190);
      const points=await Promise.all([17,18,19,20].map(x=>mapPoint(x,15)));
      await pointer('down',points[0]);
      for (const point of points.slice(1)) {
        await delay(35);
        await pointer('move',point);
      }
      await delay(35);
      await pointer('up',points.at(-1));
      const confirm='[data-action="confirm-draft"]';
      await waitFor(()=>js(`document.querySelector(${JSON.stringify(confirm)})?.disabled===false
        && document.querySelector('#draft').textContent.includes('4 格')`),'ready four-cell construction plan');
      await js(`profileStats.smoke.confirm=document.querySelector(${JSON.stringify(confirm)}); true`);
      await delay(480);
      assert.equal(await js(`profileStats.smoke.confirm===document.querySelector(${JSON.stringify(confirm)})`),true,
        'A steady draft must keep its confirmation button across simulation updates');
      await button(confirm);
    };
    const wires=()=>js('[17,18,19,20].map(x=>profileStats.smoke.staticCell(x,15,2))');
    await route();
    const laid=await result(commands.Route);
    assert.deepEqual([laid.command.a,laid.command.words.length,laid.status],[1,8,1]);
    await waitFor(async ()=>(await wires()).every(value=>value===1),'four cable cells laid');
    await button('[data-action="cut"]');
    await waitFor(()=>js("!!document.querySelector('[data-action=\"cut\"][aria-pressed=\"true\"]')"),'cable removal tool selected');
    await route();
    const cut=await result(commands.RemoveCables);
    assert.deepEqual([cut.command.words.length,cut.status],[4,1]);
    await waitFor(async ()=>(await wires()).every(value=>value===0),'four cable cells removed');
    await waitFor(()=>js("document.querySelector('#draft').hidden"),'cable draft closed after confirmation');
    if (!(await js("document.querySelector('#reference-panel').dataset.expanded==='true'"))) {
      await button('[data-mode="task"]');
    }
    const delivery='#reference-body [data-development-stage="factory-expansion"]';
    await waitFor(()=>js(`document.querySelector(${JSON.stringify(delivery)})?.textContent.includes('117 / 8')`),
      'shared delivery requirements appear in the task');
    const submitDelivery=`${delivery} [data-action^="submit-development-"]`;
    await js(`document.querySelector(${JSON.stringify(submitDelivery)}).scrollIntoView({block:'center',behavior:'instant'})`);
    if (touch) await delay(250);
    await button(submitDelivery);
    assert.equal((await result(commands.SubmitDevelopment)).status,1);
    await waitFor(()=>js(`document.querySelector(${JSON.stringify(delivery)})===null`),'submitted objective clears from the task');
    assert.deepEqual(await held(1),[109],'the reward raises the stack limit and consumes exactly eight ore');
    assert.deepEqual(await js('profileStats.smoke.errors'),[]);
    console.log(JSON.stringify({scenario:'browser-operations',input:touch?'touch':'mouse',viewport,
      assertions:{openingOre:1,importedWarehouse:true,storedFromPartialStack:17,doubleClickWithdrawal:17,
        batchLaid:4,batchRemoved:4,developmentDelivery:true}}));
  }
}
