import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance } from 'i18next';
import { loadContent } from './content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseFiles = Object.fromEntries(['items', 'machines', 'recipes'].map(category =>
  [category, join(root, 'data', category + '.json')]));
const baseConfig = join(root, 'data', 'content.config.json');
const base = loadContent(baseConfig).frontend;
const work = await mkdtemp(join(tmpdir(), 'daybreak-content-'));
const created = new Set();
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function write(name, value) {
  const file = join(work, name);
  await writeFile(file, JSON.stringify(value));
  created.add(file);
  return file;
}

try {
  const items = await json(baseFiles.items);
  items.find(row => row.id === 'iron').stackLimit = 25;
  items.reverse();
  const recipeFile = await json(baseFiles.recipes);
  recipeFile.find(row => row.id === 'press-plate').baseTicks = 44;
  const machines = await json(baseFiles.machines);
  const benchLayout = machines.find(row => row.id === 'bench');
  benchLayout.size = [2, 3];
  benchLayout.ports = [
    { role:'input', x:0, y:1, side:'west', labelKey:'test.iron-inlet' },
    { role:'output', x:1, y:2, side:'east' },
  ];
  const alternateZh = await json(join(root, 'data/locales/zh-CN.json'));
  alternateZh['items.iron.description'] = '配重试验中的铁矿说明。';
  alternateZh['test.iron-inlet'] = '矿物入口';
  const profile = {
    version: 2, files: { ...baseFiles, locales: {
      'zh-CN': await write('zh-CN.json', alternateZh),
      en: join(root, 'data/locales/en.json'),
    } },
  };
  const config = {
    dataset: 'review', datasets: { review: profile },
    files: { items: await write('items.json', items), recipes: await write('recipes.json', recipeFile),
      machines: await write('machines.json', machines) },
  };
  const configPath = await write('config.json', config);
  const { frontend: variant, tag } = loadContent(configPath);
  assert.equal(base.items[1].stackLimit, 100);
  assert.equal(variant.items[1].id, 'iron', 'Reordering data files does not change the stock ABI');
  assert.equal(variant.items[1].stackLimit, 25);
  assert.equal(variant.items[2].stackLimit, 100);
  assert.notEqual(variant.saveIdentity, base.saveIdentity);
  assert.ok(variant.compatibleRecipes[5].some(i => variant.recipes[i].id === 'smelt-plate'));
  assert.ok(!variant.compatibleRecipes[8].some(i => variant.recipes[i].id === 'smelt-plate'));
  assert.equal(tag.at(-1), tag.length);
  const originalNumbers = loadContent(await write('previous-config.json', { ...config, files: { machines:config.files.machines } })).frontend;
  assert.equal(originalNumbers.saveIdentity, variant.saveIdentity, 'Timing and stack edits remain compatible');
  assert.notEqual(originalNumbers.signature, variant.signature, 'Mismatched build assets are distinguishable');
  const changedInputs = structuredClone(recipeFile);
  changedInputs.find(row => row.id === 'press-plate').inputs[0].amount = 2;
  const incompatible = loadContent(await write('inputs-config.json', {
    ...config, files: { ...config.files, recipes: await write('changed-inputs.json', changedInputs) },
  })).frontend;
  assert.notEqual(incompatible.saveIdentity, variant.saveIdentity, 'An in-flight reservation cannot be reinterpreted');
  const singleCell = loadContent(await write('single-cell-config.json', {
    ...config, files:{ ...config.files, machines:baseFiles.machines },
  })).frontend;
  assert.notEqual(singleCell.saveIdentity, variant.saveIdentity, 'Changed footprints require a compatible save');

  const language = createInstance();
  await language.init({
    lng: 'en', fallbackLng: 'zh-CN', keySeparator: false,
    resources: Object.fromEntries(Object.entries(variant.locales).map(([lang, translation]) => [lang, { translation }])),
  });
  assert.equal(language.t(variant.items[1].nameKey), 'Iron ore');
  assert.equal(language.t(variant.machines[24].descriptionKey), variant.locales['zh-CN'][variant.machines[24].descriptionKey]);
  assert.match(language.t('tasks.make-miner.progress', { count: 1, required: 5 }), /1 \/ 5 piece$/);
  assert.match(language.t('tasks.make-miner.progress', { count: 2, required: 5 }), /2 \/ 5 pieces$/);
  await language.changeLanguage('zh-CN');
  assert.equal(language.t(variant.items[1].descriptionKey), '配重试验中的铁矿说明。');

  for (const [label, change, diagnostic] of [
    ['stack', value => { value.at(-1).stackLimit = 0; }, /items\.json\.iron\.stackLimit/],
    ['duplicate', value => { value.push(value[0]); }, /duplicate ID/],
  ]) {
    const modified = structuredClone(items);
    change(modified);
    const badConfig = await write(label + '.json', {
      ...config, files: { ...config.files, items: await write(label + '-items.json', modified) },
    });
    assert.throws(() => loadContent(badConfig), diagnostic);
  }
  const wrongClass = structuredClone(recipeFile);
  wrongClass.find(row => row.id === 'smelt-plate').machines = ['assembler'];
  const wrongConfig = await write('class.json', {
    ...config, files: { ...config.files, recipes: await write('wrong-recipes.json', wrongClass) },
  });
  assert.throws(() => loadContent(wrongConfig), /smelt-plate\.machines.*cannot execute/);
  const brokenLocale = { ...alternateZh, 'ui.backpack': '{{wrong}}' };
  const brokenConfig = await write('locale.json', {
    ...config, files: { ...config.files, locales: { 'zh-CN': await write('wrong-locale.json', brokenLocale) } },
  });
  assert.throws(() => loadContent(brokenConfig), /ui\.backpack.*parameters/);
  const badPorts = structuredClone(machines);
  badPorts.find(row => row.id === 'bench').ports[0].side = 'east';
  const badGeometry = await write('bad-geometry.json', {
    ...config, files:{...config.files, machines:await write('bad-machine.json',badPorts)},
  });
  assert.throws(() => loadContent(badGeometry), /bench\.ports\[0\]\.side.*footprint/);

  const target = join(root, 'sim', 'target', 'content-test');
  async function kernel(configPath) {
    const result = spawnSync('cargo', [
      'build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'sim/Cargo.toml', '--target-dir', target,
    ], { cwd: root, env: { ...process.env, DAYBREAK_CONTENT_CONFIG: configPath }, stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0);
    const { instance } = await WebAssembly.instantiate(await readFile(join(target,'wasm32-unknown-unknown','release','daybreak_sim.wasm')));
    const sim = instance.exports;
    const output = exportName => {
      const count = sim[exportName]();
      return new Int32Array(sim.memory.buffer, sim.output_ptr(), count).slice();
    };
    const send = words => {
      const pointer = sim.reserve_input(words.length);
      new Int32Array(sim.memory.buffer, pointer, words.length).set(words);
    };
    return {
      signature: sim.content_signature() >>> 0,
      save: () => output('save'),
      snapshot: () => output('snapshot'),
      blueprints: () => output('blueprints'),
      restore(words) { send(words); return sim.restore(words.length); },
      command(op, a, b=0, c=0, words=[]) { send(words); return sim.command(op, a, b, c, words.length); },
      step: sim.step,
    };
  }
  const campaign = await kernel(baseConfig);
  const review = await kernel(configPath);
  assert.equal(campaign.signature, base.signature);
  assert.equal(review.signature, variant.signature);
  const original = campaign.save();
  assert.equal(original[0], 10);
  const beforeReject = review.save();
  assert.equal(review.restore(original), -25);
  assert.deepEqual(review.save(), beforeReject, 'A save from a different profile must leave the current game intact');
  const beforeExtension=54+56*34*19+4+4+2;
  const libraryStart=original.length-original.at(-1)-3;
  const v7 = Int32Array.from([...original.subarray(0,beforeExtension), ...original.subarray(libraryStart,libraryStart+3)]);
  v7[0] = 7;
  v7[23] = 18; // All tests start after the original opening unlocks.
  v7[5] = 375;
  v7[6] = 99;
  v7[8] = 30;
  assert.equal(review.restore(v7), 1);
  assert.equal(campaign.restore(v7), 1);
  const iron = 16*56+19, silica = 20*56+20;
  v7[8] = 0; // 15 iron stacks and one partially filled silica stack.
  assert.equal(review.restore(v7), 1);
  assert.equal(review.command(9, iron), -24);
  assert.equal(review.command(9, silica), 1);
  assert.equal(review.command(9, silica), -24);
  assert.equal(campaign.command(9, iron), 1);
  const bench = 16*56+21;
  v7[8] = 30;
  v7[5] = 2;
  assert.equal(review.restore(v7), 1);
  assert.equal(review.command(1, bench, 18), 1);
  const snap = review.snapshot();
  const deviceStart = snap.at(-1);
  assert.equal(snap[deviceStart], bench);
  assert.equal(review.command(15, -1, bench, 1, [1, 0, snap[deviceStart+1]]), 1);
  review.step(65);
  assert.equal(review.snapshot()[98+19*bench+13], 0);
  review.step(1);
  assert.equal(review.snapshot()[98+19*bench+13], 1, 'Configured recipe duration drives real production');
  const saved = review.save();
  assert.equal(review.restore(saved), 1);
  assert.deepEqual(review.save(), saved);

  const tile = (x,y) => y*56+x;
  const inlet = tile(21,17), outlet = tile(22,18), obstruction=tile(23,16);
  const occupied = (position) => {
    const frame=review.snapshot();
    const end=frame[frame.at(-1)-1]-14;
    for (let i=frame[end];i<end;i+=3) {
      if (frame[i]===position) return Array.from(frame.subarray(i+1,i+3));
    }
    return undefined;
  };
  assert.deepEqual(occupied(inlet),[bench,1]);
  assert.deepEqual(occupied(outlet),[bench,16]);
  assert.deepEqual(occupied(tile(22,16)),[bench,0]);
  assert.equal(review.command(2,1,0,0,[tile(22,17),0]),1);
  assert.ok(review.snapshot()[98+19*bench+6]>0,'A wire beneath the body powers the anchor');
  assert.equal(review.command(1,outlet,1),-2,'A belt cannot overwrite the body');
  assert.equal(review.command(1,tile(53,30),18),-3,'Every cell must fit the unlocked map');
  assert.equal(review.command(1,obstruction,12),1);
  const beforeRotate=review.save();
  assert.equal(review.command(8,outlet),-2,'Rotating via the body checks the entire new rectangle');
  assert.deepEqual(review.save(),beforeRotate);
  assert.equal(review.command(3,obstruction),1);
  assert.equal(review.command(8,outlet),1);
  assert.deepEqual(occupied(tile(22,16)),[bench,2],'The west inlet becomes a north inlet');
  assert.deepEqual(occupied(tile(21,17)),[bench,32],'The east outlet becomes a south outlet');
  for (let i=0;i<3;i++) assert.equal(review.command(8,bench),1);

  const falseFeed=tile(20,16);
  assert.equal(review.command(1,falseFeed,12),1);
  assert.equal(review.command(4,falseFeed,1),1);
  const ironBefore=review.snapshot()[36];
  review.step(10);
  assert.equal(review.snapshot()[36],ironBefore,'A side without an inlet cannot accept goods');
  assert.equal(review.command(1,tile(19,17),12),1);
  assert.equal(review.command(4,tile(19,17),1),1);
  assert.equal(review.command(1,tile(20,17),1),1);
  assert.equal(review.command(1,tile(23,18),23),1);
  assert.equal(review.command(1,tile(24,18),12),1);
  review.step(120);
  assert.equal(review.snapshot()[19],2,'Manual and automatically supplied plates both leave through the configured outlet');

  const withBlueprint=review.save();
  withBlueprint[17]=1;
  withBlueprint[12]=8;
  assert.equal(review.restore(withBlueprint),1);
  const name=[...Buffer.from('Large bench')];
  assert.equal(review.command(16,bench,inlet,0,name),-17,'Capture must cover the entire machine');
  const id=review.command(16,bench,outlet,0,name);
  assert.ok(id>0);
  assert.equal(review.command(7,tile(31,23),id,1,[1]),1);
  assert.deepEqual(occupied(tile(30,23)),[tile(29,23),2]);
  assert.equal(review.command(3,tile(31,24)),1,'Dismantling via a body cell removes the whole machine');
  assert.equal(occupied(tile(30,23)),undefined);
  const roundTrip=review.save();
  assert.equal(review.restore(roundTrip),1);
  assert.deepEqual(occupied(outlet),[bench,16]);
  assert.ok(review.snapshot()[98+19*bench+6]>0);
  console.log('数据回归通过：两套配置、存档隔离、逐物品堆叠、配方周期、语言回退、多格占地、旋转、端口交接及蓝图。');
} finally {
  for (const file of created) await unlink(file);
  await rmdir(work);
}
