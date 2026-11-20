import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { loadContent } from './content.mjs';

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, watch: null } });
try {
  const { Op, SNAPSHOT_HEADER_WORDS, SNAPSHOT_CELL_WORDS, WORLD_WIDTH, WORLD_HEIGHT } =
    await server.ssrLoadModule('/src/generated-content.ts');
  const { SnapshotLayout, attachView } = await server.ssrLoadModule('/src/world-view.ts');
  const { ConstructionSupply } = await server.ssrLoadModule('/src/construction-supply.ts');
  const { progression, selectedRecipe } = await server.ssrLoadModule('/src/model.ts');
  const { beltArrivalData, cargoAt, constructionAvailable, deviceAt, readBlueprints, readDirectory } =
    await server.ssrLoadModule('/src/sim-data.ts');
  const { protocol } = loadContent();
  assert.deepEqual([SNAPSHOT_HEADER_WORDS, SNAPSHOT_CELL_WORDS, WORLD_WIDTH, WORLD_HEIGHT], [98, 19, 56, 34]);
  for (const [name, code] of Object.entries(protocol.commands)) assert.equal(Op[name], code);
  assert.deepEqual([Op.Place, Op.Transfer, Op.BuildTransport, Op.TakeCargo, Op.RemoveCables, Op.SubmitDevelopment],
    [1, 15, 20, 21, 28, 29]);

  const header = Array(98).fill(0);
  const layout = new SnapshotLayout(Int32Array.of(9, 13, 12, 0, 1, 0, 1, 0, 0, 15), 1, 1);
  const grid = [8, 3, 2, 90];
  const progressionWords = [1, 24, 1, 4, 6, 64, 0, 0, 1, 1, 2, 3, 1];
  const recipeHeader = [0, 0, ...Array(10).fill(0)];
  // Literal offsets and fields capture the bytes consumed by the frontend.
  const frame = Int32Array.of(...header, 0, 0, 0, 0,
    112, 112, 116, 120, 135, 148, 165, 190, 193, 194,
    ...grid, 0, 1, 28, 2, ...recipeHeader, 0, 23233, 60, ...progressionWords,
    9, 0, 21, 2, 70, 3, 17, 42, 1, -4, 20, 2, 0, 2, 10, 20, 0,
    0, 70, 1, 2, 3, 4, 5, 6, 7, 1, 2, 1, 32, 100, 7,
    1, 71, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 2, 32, 1);
  attachView(frame,layout);
  assert.equal(progression(frame).slots,24);
  assert.deepEqual(selectedRecipe(frame,0),{key:23233,ticks:60});
  assert.deepEqual(cargoAt(frame,0,0),{location:0,id:21,item:2,identity:70,from:3,since:17,until:42,blocked:true});
  assert.deepEqual([...beltArrivalData(frame)],[-4,20,2,0,2,10,20,0]);
  assert.deepEqual(deviceAt(frame,0),{
    identity:70,grade:1,ore:2,demand:3,used:4,generated:5,charged:6,discharged:7,
    slots:[{item:2,role:'input',count:32,stack:100,room:true,canPut:true,canTake:true}],
  });
  assert.deepEqual(deviceAt(frame,1).slots,[]);
  assert.equal(constructionAvailable(frame,2),32);
  const requests=[];
  const preview=new ConstructionSupply(request=>requests.push(request));
  const materials=[{item:2,count:32}];
  assert.deepEqual(preview.preview(frame,1,materials),[]);
  const shifted=frame.slice();
  attachView(shifted,layout);
  shifted[37]=1;
  shifted[177]--;
  shifted[192]--;
  assert.equal(constructionAvailable(shifted,2),32);
  assert.deepEqual(preview.preview(shifted,1,materials),[]);
  assert.equal(requests.length,2,'A changed withdrawal plan invalidates the preview even when total stock is stable');
  assert.equal(preview.receive(requests[0].request,Int32Array.of(1,0,2,32).buffer),false);
  assert.equal(preview.receive(requests[1].request,Int32Array.of(1,0,2,31).buffer),true);
  assert.deepEqual(preview.preview(shifted,1,materials),[{tile:0,used:[{item:2,count:31}]}]);

  const empty = Int32Array.of(...header, 0, 0, 0, 0,
    112, 112, 116, 116, 128, 141, 142, 142, 142, 142,
    ...grid, ...recipeHeader, ...progressionWords, 9);
  attachView(empty,layout);
  assert.equal(deviceAt(empty,0),undefined);
  assert.equal(cargoAt(empty,0,0),undefined);
  assert.equal(constructionAvailable(empty,2),0);
  assert.deepEqual(readBlueprints(Int32Array.of(0,0).buffer),[]);

  const brokenSection=frame.slice();
  brokenSection[104]=111;
  assert.throws(()=>attachView(brokenSection,layout), /snapshot section Ground/);
  const brokenGround=frame.slice();
  brokenGround[105]=121;
  assert.throws(()=>attachView(brokenGround,layout), /Ground row boundary/);
  const brokenSlots=frame.slice();
  brokenSlots[174]=99;
  attachView(brokenSlots,layout);
  assert.throws(()=>deviceAt(brokenSlots,0), /Devices\.Slots/);
  assert.throws(()=>readBlueprints(Int32Array.of(0,1,1,1,1,1,1,1,1,-1,1).buffer), /Blueprints\.Name/);
  assert.throws(()=>readDirectory(Int32Array.of(1,2).buffer), /Directory/);
  console.log('Fixed protocol frames verified: commands, layout, cargo, inventory, empty lists and named section errors.');
} finally {
  await server.close();
}
