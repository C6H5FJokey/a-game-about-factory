import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const SIM_HZ = 30;
const CONTENT_HZ = 20;
const SAVE_VERSION = 14;
const registryPath = resolve(root, 'data/registry.json');
const protocolPath = resolve(root, 'data/protocol.json');
const identifier = /^[a-z][a-z0-9-]{0,47}$/;
const defaultLanguage = 'zh-CN';
const fields = ['items', 'machines', 'recipes', 'locales'];
const keyPattern = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/;
const problems = (at, message) => { throw new Error(`${at}: ${message}`); };
const check = (condition, at, message) => { if (!condition) problems(at, message); };
const object = (value, at) => {
  check(value && typeof value === 'object' && !Array.isArray(value), at, 'expected an object');
  return value;
};
const list = (value, at) => {
  check(Array.isArray(value), at, 'expected an array');
  return value;
};
const integer = (value, min, max, at) => {
  check(Number.isInteger(value) && value >= min && value <= max, at, `expected an integer from ${min} to ${max}`);
  return value;
};
const known = (key, map, at) => {
  check(map.has(key), at, `unknown ID "${key}"`);
  return map.get(key);
};
function allowedFields(row, allowed, at) {
  for (const field of Object.keys(row)) check(allowed.includes(field), `${at}.${field}`, 'unknown field');
}
const idMap = (rows, at) => {
  const map = new Map();
  for (const [i, row] of list(rows, at).entries()) {
    object(row, `${at}[${i}]`);
    check(typeof row.id === 'string' && identifier.test(row.id), `${at}[${i}].id`, 'invalid stable ID');
    check(!map.has(row.id), `${at}[${i}].id`, `duplicate ID "${row.id}"`);
    map.set(row.id, row);
  }
  return map;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function parameters(message, at) {
  const names = [...message.matchAll(/{{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}}/g)].map(match => match[1]);
  check(!/[{}]/.test(message.replace(/{{\s*[a-zA-Z][a-zA-Z0-9]*\s*}}/g, '')), at, 'invalid interpolation');
  return [...new Set(names)].sort().join(',');
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest();
}

export function loadContent(configPath = process.env.DAYBREAK_CONTENT_CONFIG || 'data/content.config.json') {
  const dependencies = new Set();
  const absoluteConfig = resolve(root, configPath);
  const location = path => relative(root, path) || path;
  function read(path) {
    dependencies.add(path);
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      problems(location(path), error.message);
    }
  }
  const registry = read(registryPath);
  const protocol = object(read(protocolPath), 'data/protocol.json');
  for (const name of ['world', 'terminalWorld']) {
    const path = 'protocol.' + name;
    const geometry = object(protocol[name], path);
    integer(geometry.width, 1, 65_534, path + '.width');
    integer(geometry.height, 1, 65_534, path + '.height');
    check(geometry.width * geometry.height < 65_535, path, 'map tiles must fit the tile index and its sentinel');
  }
  const snapshot = object(protocol.snapshot, 'protocol.snapshot');
  integer(snapshot.headerWords, 1, 2_147_483_647, 'protocol.snapshot.headerWords');
  integer(snapshot.cellWords, 1, 2_147_483_647, 'protocol.snapshot.cellWords');
  const view = object(protocol.view, 'protocol.view');
  const viewFields = [...view.layoutFields, ...view.dynamicFields];
  check(viewFields.length === snapshot.cellWords && new Set(viewFields).size === snapshot.cellWords
    && viewFields.every(field => Number.isInteger(field) && field >= 0 && field < snapshot.cellWords),
    'protocol.view', 'layout and dynamic fields must partition the full cell record');
  check(new Set(view.sections).size === view.sections.length && view.sections.every(name => /^[A-Z][A-Za-z]+$/.test(name)),
    'protocol.view.sections', 'expected unique section names');
  const opcodes = Object.entries(object(protocol.commands, 'protocol.commands'));
  const codes = new Set();
  check(opcodes.length > 0, 'protocol.commands', 'at least one command is required');
  for (const [name, code] of opcodes) {
    check(/^[A-Z][A-Za-z0-9]*$/.test(name), 'protocol.commands', 'invalid command name ' + name);
    integer(code, 1, 2_147_483_647, 'protocol.commands.' + name);
    check(!codes.has(code), 'protocol.commands.' + name, 'duplicate command code ' + code);
    codes.add(code);
  }
  const itemRegistry = idMap(registry.items, 'data/registry.json.items');
  const machineRegistry = idMap(registry.machines, 'data/registry.json.machines');
  const itemCodes = [...itemRegistry.values()].sort((a, b) => a.code - b.code);
  const machineCodes = [...machineRegistry.values()].sort((a, b) => a.code - b.code);
  check(itemCodes.length === 19 && itemCodes.every((item, i) => item.code === i + 1),
    'data/registry.json.items', 'expected the 19 numeric IDs used by the current save format');
  check(machineCodes.length === 35 && machineCodes.every((machine, i) => machine.code === i),
    'data/registry.json.machines', 'expected the 35 numeric IDs used by the current save format');
  const config = object(read(absoluteConfig), location(absoluteConfig));
  const dataset = config.dataset;
  check(typeof dataset === 'string' && identifier.test(dataset), `${location(absoluteConfig)}.dataset`, 'invalid dataset ID');
  const sets = object(config.datasets, `${location(absoluteConfig)}.datasets`);
  const selected = Object.hasOwn(sets, dataset) ? sets[dataset] : undefined;
  const profileAt = `${location(absoluteConfig)}.datasets.${dataset}`;
  const profile = object(selected, profileAt);
  const version = integer(profile.version, 1, 2_147_483_647, `${profileAt}.version`);
  const defaults = object(profile.files, `${profileAt}.files`);
  const overrides = config.files === undefined ? {} : object(config.files, `${location(absoluteConfig)}.files`);
  const files = { ...defaults, ...overrides };
  const sources = {};
  function pathFor(value, at) {
    check(typeof value === 'string' && value.trim() && !/[\r\n]/.test(value), at, 'expected a file path');
    return resolve(dirname(absoluteConfig), value);
  }
  for (const category of Object.keys(files)) check(fields.includes(category), profileAt, `unknown file category "${category}"`);
  for (const category of fields.slice(0, 3)) sources[category] = pathFor(files[category], `${profileAt}.files.${category}`);

  const locales = {};
  const localeFiles = { ...object(defaults.locales, `${profileAt}.files.locales`),
    ...(overrides.locales === undefined ? {} : object(overrides.locales, `${location(absoluteConfig)}.files.locales`)) };
  check(Object.hasOwn(localeFiles, defaultLanguage), profileAt, `missing default locale "${defaultLanguage}"`);
  for (const [locale, file] of Object.entries(localeFiles)) {
    let language;
    try { [language] = Intl.getCanonicalLocales(locale); } catch { /* Validated below. */ }
    check(language === locale, profileAt, `invalid or non-canonical locale "${locale}"`);
    const path = pathFor(file, `${profileAt}.files.locales.${locale}`);
    locales[locale] = {};
    for (const [key, message] of Object.entries(object(read(path), location(path)))) {
      const at = `${location(path)}.${key}`;
      check(keyPattern.test(key) && !key.split('.').some(part => part === '__proto__' || part === 'constructor' || part === 'prototype'), at, 'invalid translation key');
      check(typeof message === 'string' && message.trim(), at, 'expected nonempty text');
      parameters(message, at);
      locales[locale][key] = message;
    }
  }
  const fallback = locales[defaultLanguage];
  const required = [
    'ui.language', 'ui.saveStatus', 'ui.archive', 'ui.archiveTitle', 'ui.archiveCompatibility', 'ui.close',
    'ui.stock', 'ui.full', 'ui.individualStacks', 'ui.unavailable', 'ui.selectTool', 'ui.held', 'ui.input',
    'ui.output', 'ui.module', 'ui.cargo', 'ui.display', 'ui.invalidSave', 'ui.invalidAutoSave',
    'ui.sameContentRequired', 'tasks.make-miner.title',
    ...Array.from({ length:25 }, (_, i) => `errors.${i+1}`),
  ];
  for (const key of required) {
    check(Object.hasOwn(fallback, key) && parameters(fallback[key], key) === '', `${defaultLanguage}.${key}`, 'expected a default translation without parameters');
  }
  const uiParameters = {
    'ui.backpack': 'slots,used', 'ui.stackCapacity': 'limit', 'ui.slotLabel': 'count,item,role',
    'ui.capacity': 'capacity,count', 'ui.received': 'count,item', 'ui.inserted': 'count,item', 'ui.installed': 'count,item',
    'tasks.make-miner.progress_one': 'count,required', 'tasks.make-miner.progress_other': 'count,required',
  };
  for (const [key, expected] of Object.entries(uiParameters)) {
    check(Object.hasOwn(fallback, key) && parameters(fallback[key], key) === expected, `${defaultLanguage}.${key}`, `expected interpolation parameters ${expected}`);
  }
  for (const [locale, translations] of Object.entries(locales)) {
    if (locale === defaultLanguage) continue;
    for (const [key, message] of Object.entries(translations)) {
      check(Object.hasOwn(fallback, key), `${locale}.${key}`, 'translation has no default key');
      check(parameters(message, key) === parameters(fallback[key], key), `${locale}.${key}`, 'interpolation parameters differ from the default language');
    }
  }
  function text(row, prefix, at) {
    const nameKey = row.nameKey ?? `${prefix}.${row.id}.name`;
    const descriptionKey = row.descriptionKey ?? `${prefix}.${row.id}.description`;
    for (const key of [nameKey, descriptionKey]) {
      check(typeof key === 'string' && Object.hasOwn(fallback, key), at, `missing default translation "${key}"`);
      check(parameters(fallback[key], at) === '', at, `catalog translation "${key}" cannot have parameters`);
    }
    return { nameKey, descriptionKey };
  }
  function fixedIds(category, registryRows) {
    const at = location(sources[category]);
    const rows = idMap(read(sources[category]), at);
    for (const id of rows.keys()) known(id, registryRows, at);
    return [...registryRows.values()].sort((a, b) => a.code - b.code).map(entry => ({
      entry, row: known(entry.id, rows, at), at: `${at}.${entry.id}`,
    }));
  }
  function material(row, at, max) {
    object(row, at);
    const { item, amount } = row;
    const id = known(item, itemRegistry, `${at}.item`).code;
    return { item: id, amount: integer(amount, 1, max, `${at}.amount`) };
  }
  function materials(rows, at, max, maxLength) {
    list(rows, at);
    check(rows.length <= maxLength, at, `at most ${maxLength} distinct items are supported`);
    const parsed = rows.map((row, index) => material(row, `${at}[${index}]`, max));
    check(new Set(parsed.map(row => row.item)).size === parsed.length, at, 'duplicate material');
    return parsed;
  }
  const items = [null, ...fixedIds('items', itemRegistry).map(({ entry, row, at }) => {
    allowedFields(row, ['id','icon','nameKey','descriptionKey','stackLimit','tierOneStackLimit'], at);
    const stackLimit = integer(row.stackLimit === undefined ? 100 : row.stackLimit, 1, 1_000_000, `${at}.stackLimit`);
    const tierOneStackLimit = integer(row.tierOneStackLimit === undefined ? stackLimit : row.tierOneStackLimit, stackLimit, 1_000_000, `${at}.tierOneStackLimit`);
    return { id: row.id, icon: known(row.icon, itemRegistry, `${at}.icon`).code, stackLimit, tierOneStackLimit, ...text(row, 'items', at) };
  })];
  const machines = fixedIds('machines', machineRegistry).map(({ entry, row, at }) => {
    allowedFields(row, ['id','icon','nameKey','descriptionKey','materials','power','generation',
      'batteryCapacity','batteryPower','span','beltInterval','beltRate','inputCapacity','outputCapacity',
      'inputSlots','outputSlots','storageSlots','crateSlots','size','ports',
      'nextMaterials','nextPower','nextSpan'], at);
    for (const legacyField of ['inputCapacity','outputCapacity']) {
      if (Object.hasOwn(row,legacyField)) integer(row[legacyField],0,24,`${at}.${legacyField}`);
    }
    const [width, height] = list(row.size === undefined ? [1,1] : row.size, `${at}.size`);
    if (row.size !== undefined) check(row.size.length === 2, `${at}.size`, 'expected [width, height]');
    integer(width, 1, 8, `${at}.size[0]`);
    integer(height, 1, 8, `${at}.size[1]`);
    const fixed = ['empty','transport','cable','freight-yard'].includes(entry.behavior);
    const drillVariant = [2,3,4,27,28,29,33,34].includes(entry.code);
    const canInput = ['depot','generator','station','freight-yard'].includes(entry.id) || entry.behavior === 'processing';
    const canOutput = ['depot','freight-yard','industrial-miner','reinforced-miner'].includes(entry.id)
      || ['processing','mining'].includes(entry.behavior);
    check(!drillVariant || (row.size === undefined && row.ports === undefined), at,
      'set drill geometry on industrial-miner or reinforced-miner');
    check(!fixed || (width === 1 && height === 1 && row.ports === undefined), at, 'this infrastructure type uses its existing single-cell layout');
    check((width === 1 && height === 1) || row.ports !== undefined, `${at}.ports`, 'declare ports for a multi-cell machine; use [] for no material ports');
    const edges = new Set();
    const ports = row.ports === undefined ? null : list(row.ports, `${at}.ports`).map((port, i) => {
      const field = `${at}.ports[${i}]`;
      object(port, field);
      allowedFields(port, ['role','x','y','side','labelKey'], field);
      integer(port.x, 0, width-1, `${field}.x`);
      integer(port.y, 0, height-1, `${field}.y`);
      check(port.role === 'input' || port.role === 'output', `${field}.role`, 'expected input or output');
      check(port.role === 'input' ? canInput : canOutput, `${field}.role`,
        'this machine has no material slot for that role');
      const side = ['east','south','west','north'].indexOf(port.side);
      check([port.x === width-1, port.y === height-1, port.x === 0, port.y === 0][side],
        `${field}.side`, 'port must face out of the footprint');
      const edge = `${port.role}:${port.x}:${port.y}:${side}`;
      check(!edges.has(edge), field, 'duplicate port');
      edges.add(edge);
      if (port.labelKey !== undefined) {
        check(typeof port.labelKey === 'string' && Object.hasOwn(fallback, port.labelKey),
          `${field}.labelKey`, 'missing default translation');
        check(parameters(fallback[port.labelKey], field) === '', `${field}.labelKey`, 'port label cannot have parameters');
      }
      return {x:port.x, y:port.y, side, role:port.role, labelKey:port.labelKey ?? null};
    });
    ports?.sort((a,b) => a.y-b.y || a.x-b.x || a.side-b.side || a.role.localeCompare(b.role));
    const spec = {
      id: row.id, icon: known(row.icon, machineRegistry, `${at}.icon`).code,
      width, height, ports, canInput, canOutput, processing: entry.behavior === 'processing', ...text(row, 'machines', at),
      materials: materials(row.materials, `${at}.materials`, 65535, itemRegistry.size),
      nextMaterials: materials(row.nextMaterials ?? row.materials, `${at}.nextMaterials`, 65535, itemRegistry.size),
      power: integer(row.power === undefined ? 0 : row.power, 0, 65535, `${at}.power`),
      nextPower: integer(row.nextPower ?? row.power ?? 0, 0, 65535, `${at}.nextPower`),
      generation: integer(row.generation === undefined ? 0 : row.generation, 0, 65535, `${at}.generation`),
      batteryCapacity: integer(row.batteryCapacity === undefined ? 0 : row.batteryCapacity, 0, 10_000_000, `${at}.batteryCapacity`),
      batteryPower: integer(row.batteryPower === undefined ? 0 : row.batteryPower, 0, 65535, `${at}.batteryPower`),
      span: integer(row.span === undefined ? 1 : row.span, 1, 1904, `${at}.span`),
      nextSpan: integer(row.nextSpan ?? row.span ?? 1, 1, 1904, `${at}.nextSpan`),
      beltInterval: entry.behavior === 'transport' ? integer(row.beltInterval, 1, 200, `${at}.beltInterval`) : 0,
      beltRate: entry.behavior === 'transport' ? integer(row.beltRate ?? 60, 1, 1800, `${at}.beltRate`) : 0,
      inputSlots: integer(row.inputSlots ?? Number(canInput && !['depot','freight-yard'].includes(entry.id)), 0, 64, `${at}.inputSlots`),
      outputSlots: integer(row.outputSlots ?? Number(canOutput && !['depot','freight-yard'].includes(entry.id)), 0, 64, `${at}.outputSlots`),
      storageSlots: integer(row.storageSlots ?? ({depot:8,'freight-yard':4}[entry.id] ?? 0), 0, 64, `${at}.storageSlots`),
      crateSlots: integer(row.crateSlots ?? (entry.id === 'freight-yard' ? 2 : 0), 0, 64, `${at}.crateSlots`),
    };
    if (entry.code !== 0) check(spec.materials.length > 0, `${at}.materials`, 'a construction cost is required');
    if (entry.code !== 0) check(spec.nextMaterials.length > 0, `${at}.nextMaterials`, 'a construction cost is required');
    const tutorialItem = { 'simple-miner': 1, 'freight-yard': 4 }[row.id];
    if (tutorialItem) check(spec.materials.length === 1 && spec.materials[0].item === tutorialItem, `${at}.materials`, 'this legacy building requires its original cost item');
    if (entry.id === 'depot' || entry.id === 'freight-yard') check(spec.storageSlots > 0, at, 'storage needs at least one slot');
    if (entry.id === 'freight-yard') check(spec.crateSlots > 0, at, 'a freight crate needs at least one slot');
    return spec;
  });
  const rawRecipes = idMap(read(sources.recipes), location(sources.recipes));
  const mineralIds = new Set(itemCodes.filter(item => item.mineral).map(item => item.code));
  const recipes = [...rawRecipes.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')).map(row => {
    const at = `${location(sources.recipes)}.${row.id}`;
    allowedFields(row, ['id','category','inputs','output','machines','byproducts','baseTicks','unlockStage','nameKey','descriptionKey','handcraft','modern'], at);
    const inputs = materials(row.inputs, `${at}.inputs`, 24, 3).sort((a, b) => a.item - b.item);
    check(['mining', 'mineral', 'part'].includes(row.category), `${at}.category`, 'unknown recipe category');
    check(row.category === 'mining' ? inputs.length === 0 : inputs.length > 0, at, 'input count does not match recipe category');
    check(inputs.some(input => mineralIds.has(input.item)) === (row.category === 'mineral'),
      `${at}.inputs`, 'input materials do not match the recipe category');
    const compatible = list(row.machines, `${at}.machines`).map(id => {
      const target = known(id, machineRegistry, `${at}.machines`);
      const allowed = row.category === 'mining' ? target.behavior === 'mining' :
        (target.id === 'kiln' && row.modern ? 'mineral-double' : target.processingClass) ===
          `${row.category}-${['','single','double','triple'][inputs.length]}`;
      check(allowed, `${at}.machines`, `"${id}" cannot execute ${row.category} recipes with ${inputs.length} inputs`);
      return target.code;
    }).sort((a, b) => a - b);
    check(compatible.length > 0 && new Set(compatible).size === compatible.length, `${at}.machines`, 'expected distinct compatible machines');
    const output = material(row.output, `${at}.output`, 24);
    check(!inputs.some(input => input.item === output.item), `${at}.output`, 'output must differ from inputs');
    const handcraft = row.handcraft === undefined ? null : object(row.handcraft, `${at}.handcraft`);
    if (handcraft) allowedFields(handcraft, ['ticks','unlockStage','inputs'], `${at}.handcraft`);
    const handInputs = handcraft ? materials(handcraft.inputs ?? row.inputs, `${at}.handcraft.inputs`, 24, 3) : [];
    check(!handcraft || (handInputs.length > 0 && !handInputs.some(input => input.item === output.item)),
      `${at}.handcraft.inputs`, 'handcraft requires materials distinct from the output');
    return { id: row.id, key: digest(row.id).readUInt32LE() & 0x1fffffff,
      category: row.category, inputs, output, machines: compatible, modern: row.modern === true,
      handcraft: handcraft ? {
        ticks: integer(handcraft.ticks, 1, 65535, `${at}.handcraft.ticks`),
        unlockStage: integer(handcraft.unlockStage, 0, 22, `${at}.handcraft.unlockStage`),
        inputs: handInputs,
      } : null,
      byproducts: materials(row.byproducts ?? [], `${at}.byproducts`, 24, itemRegistry.size),
      baseTicks: integer(row.baseTicks, 1, 65535, `${at}.baseTicks`),
      unlockStage: integer(row.unlockStage, 0, 22, `${at}.unlockStage`), ...text(row, 'recipes', at) };
  });
  check(recipes.every(recipe => recipe.key > 0) && new Set(recipes.map(recipe => recipe.key)).size === recipes.length,
    location(sources.recipes), 'recipe IDs must hash to distinct nonzero keys');
  const fits = (row, slots) => Math.ceil(row.amount / items[row.item].stackLimit) <= slots;
  const fitsRecipe = (recipe, machine) => fits(recipe.output, machine.outputSlots) &&
    recipe.inputs.every(row => fits(row, machine.inputSlots));
  for (const recipe of recipes) for (const code of recipe.machines) {
    check(fitsRecipe(recipe, machines[code]),
      recipe.id, 'recipe quantities exceed machine buffer capacity');
  }
  for (const [id, amount] of [['mirror',3],['fuel',5],['core',6]]) {
    check(fits({item:itemRegistry.get(id).code,amount},machines[13].inputSlots),
      'station.inputSlots', `must fit the campaign reserve for ${id}`);
  }
  check(machines[9].inputSlots>0,'generator.inputSlots','the generator needs a fuel slot');
  const recipeMap = new Map(recipes.map(row => [row.id, row]));
  const activeRecipes = machineCodes.map(entry => {
    if (!entry.legacyRecipe) return null;
    const at = `${location(sources.recipes)}.${entry.legacyRecipe}`;
    const recipe = known(entry.legacyRecipe, recipeMap, at);
    const legacyInputs = materials(entry.legacyInputs, 'data/registry.json.legacyInputs', 24, 2).sort((a, b) => a.item - b.item);
    const machine = machines[entry.code];
    check(recipe.inputs.length === legacyInputs.length && recipe.inputs.every((row, i) => row.item === legacyInputs[i].item), at, 'the campaign recipe must retain its original input items');
    check(recipe.output.item === itemRegistry.get(entry.output).code && recipe.byproducts.length === 0, at, 'the campaign recipe must retain its original output item');
    check(fitsRecipe(recipe, machine) && legacyInputs.every(row=>fits(row,machine.inputSlots)), at, 'recipe quantities exceed machine buffer capacity');
    return { ...recipe, legacyInputs, power: machine.power };
  });
  check([...mineralIds].every(item=>fits({item,amount:activeRecipes[17].output.amount},machines[17].outputSlots)),
    'simple-miner.outputSlots','the miner must fit one batch of any raw mineral');
  const compatibleRecipes = machines.map((_, code) => recipes.flatMap((recipe, i) => recipe.machines.includes(code) ? [i] : []));
  const mechanics = activeRecipes.map(recipe => recipe?.inputs ?? null);
  const layouts = machines.flatMap(({id,width,height,ports}) => ports === null ? [] :
    [{id,width,height,ports:ports.map(({x,y,side,role})=>[x,y,side,role])}]);
  const legacyLayouts = layouts.filter(({id})=>machineRegistry.get(id).code<31);
  const marker = digest({ dataset, version, itemCodes, machineCodes, mechanics, ...(layouts.length ? { layouts } : {}),
    selectable:recipes.filter(recipe=>recipe.modern).map(({id,inputs,output,machines})=>({id,inputs,output,machines})) });
  const legacyMarker = digest({ dataset, version, itemCodes:itemCodes.slice(0,9), machineCodes:machineCodes.slice(0,31),
    mechanics:mechanics.slice(0,31), ...(legacyLayouts.length ? { layouts:legacyLayouts } : {}) });
  const runtimeRecipes = recipes.map(recipe => ({
    ...recipe, baseTicks: Math.ceil(recipe.baseTicks * SIM_HZ / CONTENT_HZ),
  }));
  const signature = digest({ dataset, version, items, machines, recipes: runtimeRecipes, locales, SIM_HZ, CONTENT_HZ, protocol }).readUInt32LE();
  const tagFor = hash => {
    const tag = [version, ...Buffer.from(dataset), ...[0, 4, 8, 12].map(at => hash.readInt32LE(at))];
    return [...tag,tag.length+1];
  };
  const saveIdentity = marker.toString('hex').slice(0, 32);
  const legacySaveIdentity = legacyMarker.toString('hex').slice(0, 32);
  return { frontend: { dataset, version, signature, saveIdentity, legacySaveIdentity, hz: SIM_HZ, contentHz: CONTENT_HZ,
    items, machines, recipes: runtimeRecipes, compatibleRecipes, locales },
    dependencies: [...dependencies], protocol, activeRecipes, tag:tagFor(marker), legacyTag:tagFor(legacyMarker) };
}

function pairs(rows, size) {
  const values = rows.map(({ item, amount }) => `(${item}, ${amount})`);
  while (values.length < size) values.push('(0, 0)');
  return `[${values.join(', ')}]`;
}

export function emitRust(content) {
  const { machines, items, recipes, signature } = content.frontend;
  const { world, terminalWorld, snapshot, view, commands } = content.protocol;
  const stackRow = key => `[0, ${items.slice(1).map(item => item[key]).join(', ')}]`;
  const list = key => `[${machines.map(row => row[key]).join(', ')}]`;
  return `// Generated by scripts/content.mjs.
pub const HZ: u32 = ${SIM_HZ};
pub const CONTENT_HZ: u32 = ${CONTENT_HZ};
pub const SAVE_VERSION: i32 = ${SAVE_VERSION};
pub const BUILD_SIGNATURE: u32 = ${signature};
#[cfg(not(feature = "terminal-profile"))]
pub const WORLD_WIDTH: usize = ${world.width};
#[cfg(not(feature = "terminal-profile"))]
pub const WORLD_HEIGHT: usize = ${world.height};
#[cfg(feature = "terminal-profile")]
pub const TERMINAL_WIDTH: usize = ${terminalWorld.width};
#[cfg(feature = "terminal-profile")]
pub const TERMINAL_HEIGHT: usize = ${terminalWorld.height};
pub const SNAPSHOT_HEADER_WORDS: usize = ${snapshot.headerWords};
pub const SNAPSHOT_CELL_WORDS: usize = ${snapshot.cellWords};
pub mod view {
    pub const BOUNDS_WORDS: usize = ${view.boundsWords};
    pub const WATCHED_TILES: usize = ${view.watchedTiles};
    pub const LAYOUT_HEADER_WORDS: usize = ${view.layoutHeaderWords};
    pub const LAYOUT_FIELDS: [usize; ${view.layoutFields.length}] = [${view.layoutFields.join(', ')}];
    pub const DYNAMIC_FIELDS: [usize; ${view.dynamicFields.length}] = [${view.dynamicFields.join(', ')}];
    pub const SECTION_COUNT: usize = ${view.sections.length};
${view.sections.map((name, index) => `    pub const ${name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}: usize = ${index};`).join('\n')}
}
pub mod op {
${Object.entries(commands).map(([name, code]) =>
  `    pub const ${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}: i32 = ${code};`).join('\n')}
}
pub const SAVE_DATA_TAG: &[i32] = &[${content.tag.join(', ')}];
pub const LEGACY_SAVE_DATA_TAG: &[i32] = &[${content.legacyTag.join(', ')}];
pub const STACK_LIMITS: [[u32; ITEMS]; 2] = [${stackRow('stackLimit')}, ${stackRow('tierOneStackLimit')}];
pub const BUILD_MATERIALS: [&[(u8, u32)]; MAX_KIND as usize + 1] = [
${machines.map(row => `    &${pairs(row.materials, 0)},`).join('\n')}
];
pub const NEXT_BUILD_MATERIALS: [&[(u8, u32)]; MAX_KIND as usize + 1] = [
${machines.map(row => `    &${pairs(row.nextMaterials, 0)},`).join('\n')}
];
pub const RECIPE_DATA: [Option<Recipe>; MAX_KIND as usize + 1] = [
${content.activeRecipes.map(recipe => recipe ? `    Some(Recipe { input: ${pairs(recipe.inputs, 3)}, output: ${recipe.output.item}, amount: ${recipe.output.amount}, ticks: simulation_ticks(${recipe.baseTicks}), power: ${recipe.power} }),` : '    None,').join('\n')}
];
pub const LEGACY_RECIPE_INPUTS: [[(u8, u16); 3]; MAX_KIND as usize + 1] = [
${content.activeRecipes.map(recipe => `    ${pairs(recipe?.legacyInputs ?? [], 3)},`).join('\n')}
];
pub const MACHINE_POWER: [u16; MAX_KIND as usize + 1] = ${list('nextPower')};
pub const PROCESSING: [bool; MAX_KIND as usize + 1] = [${machines.map(row => row.processing).join(', ')}];
pub const RECIPES: &[RecipeSpec] = &[
${recipes.map(recipe => `    RecipeSpec { key: ${recipe.key}, modern: ${recipe.modern}, recipe: Recipe { input: ${pairs(recipe.inputs, 3)}, output: ${recipe.output.item}, amount: ${recipe.output.amount}, ticks: ${recipe.baseTicks}, power: 0 }, machines: &[${recipe.machines.join(', ')}], unlock: ${recipe.unlockStage}, handcraft: ${recipe.handcraft ?
  `Some(HandRecipe { input: ${pairs(recipe.handcraft.inputs, 3)}, ticks: ${recipe.handcraft.ticks}, unlock: ${recipe.handcraft.unlockStage} })` : 'None'} },`).join('\n')}
];
pub const INPUT_SLOTS: [u32; MAX_KIND as usize + 1] = ${list('inputSlots')};
pub const OUTPUT_SLOTS: [u32; MAX_KIND as usize + 1] = ${list('outputSlots')};
pub const STORAGE_SLOTS: [u32; MAX_KIND as usize + 1] = ${list('storageSlots')};
pub const CRATE_SLOTS: u32 = ${machines[19].crateSlots};
pub const BELT_INTERVAL: [u32; MAX_KIND as usize + 1] = ${list('beltInterval')};
pub const BELT_RATE: [u32; MAX_KIND as usize + 1] = ${list('beltRate')};
pub const FOOTPRINT_SIZES: [(u8, u8); MAX_KIND as usize + 1] = [
${machines.map(row => `    (${row.width}, ${row.height}),`).join('\n')}
];
pub const MATERIAL_PORTS: [Option<&[Port]>; MAX_KIND as usize + 1] = [
${machines.map(row => row.ports === null ? '    None,' : `    Some(&[${row.ports.map(port =>
  `Port { x: ${port.x}, y: ${port.y}, side: ${port.side}, output: ${port.role === 'output'} }`).join(', ')}]),`).join('\n')}
];
pub const CABLE_SPAN: u32 = ${machines[21].span};
pub const NEXT_CABLE_SPAN: u32 = ${machines[21].nextSpan};
pub const GENERATOR_POWER: u16 = ${machines[9].generation};
pub const SOLAR_POWER: u16 = ${machines[11].generation};
pub const LAUNCH_POWER: u16 = ${machines[13].power};
pub const LINE_COST: u32 = ${machines[19].materials[0].amount};
pub const BATTERY_CAPACITY: u32 = simulation_ticks(${machines[10].batteryCapacity});
pub const BATTERY_POWER: u16 = ${machines[10].batteryPower};
pub const MINER_TICKS: u32 = simulation_ticks(${content.activeRecipes[17].baseTicks});
`;
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  let previous;
  try { previous = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== data) writeFileSync(path, data);
}

async function verifyWasm(content, target) {
  const { instance } = await WebAssembly.instantiate(readFileSync(target));
  const sim = instance.exports;
  check((sim.content_signature() >>> 0) === content.frontend.signature, target, 'Wasm was generated for a different dataset');
  check(sim.tick_rate() === content.frontend.hz, target, 'Wasm uses a different simulation clock');
  const { world, snapshot, view: scoped } = content.protocol;
  check(sim.world_width() === world.width && sim.world_height() === world.height,
    target, 'Wasm uses a different map size');
  sim.step(1);
  const words = sim.snapshot();
  const view = new Int32Array(sim.memory.buffer, sim.output_ptr(), words);
  check(view[0] === 1 && view[words - 1] >= snapshot.headerWords + world.width * world.height * snapshot.cellWords,
    target, 'Wasm returned an incompatible snapshot');
  const layoutWords = sim.snapshot_layout(0, 0, 0);
  const layout = new Int32Array(sim.memory.buffer, sim.output_ptr(), layoutWords);
  const layoutCells = scoped.layoutHeaderWords + world.width * world.height * scoped.layoutFields.length;
  check(layoutWords >= layoutCells && (layoutWords - layoutCells) % 3 === 0
    && sim.snapshot_layout(layout[0], layout[1], 1) === 0, target, 'Wasm returned an incompatible or redundant layout');
  const frameWords = sim.snapshot_view(0, 0, 2, 2, -1, -1, -1, -1);
  const frame = new Int32Array(sim.memory.buffer, sim.output_ptr(), frameWords);
  const directory = snapshot.headerWords + scoped.boundsWords;
  const end = directory + scoped.sections.length;
  check(frame[0] === 1 && frame[directory] === end + 1 + 4 * scoped.dynamicFields.length
    && frame[end] === frameWords, target, 'Wasm returned an incompatible viewport snapshot');
  const length = sim.save();
  const saved = new Int32Array(sim.memory.buffer, sim.output_ptr(), length).slice();
  check(saved[0] === SAVE_VERSION && saved.length > content.tag.length
    && content.tag.every((word, i) => word === saved[length-content.tag.length+i]), target, 'generated save tag does not match the dataset');
  const pointer = sim.reserve_input(length);
  new Int32Array(sim.memory.buffer, pointer, length).set(saved);
  check(sim.restore(length) === 1, target, 'generated save did not round-trip');
  console.log(`Static Wasm verified for ${content.frontend.dataset} v${content.frontend.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const content = loadContent();
    const [mode, target] = process.argv.slice(2);
    if (mode === '--rust' && target) {
      write(resolve(target), emitRust(content));
      for (const dependency of content.dependencies) console.log(`cargo:rerun-if-changed=${dependency}`);
    } else if (mode === '--frontend') {
      const { world, terminalWorld, snapshot, view, commands } = content.protocol;
      write(resolve(root, 'src/generated-content.ts'), `// Generated by scripts/content.mjs.
export const SIM_HZ = ${SIM_HZ};
export const WORLD_WIDTH = ${world.width}, WORLD_HEIGHT = ${world.height};
export const TERMINAL_WIDTH = ${terminalWorld.width}, TERMINAL_HEIGHT = ${terminalWorld.height};
export const SNAPSHOT_HEADER_WORDS = ${snapshot.headerWords}, SNAPSHOT_CELL_WORDS = ${snapshot.cellWords};
export const VIEW_BOUNDS_WORDS = ${view.boundsWords}, VIEW_WATCHED_TILES = ${view.watchedTiles}, VIEW_LAYOUT_HEADER_WORDS = ${view.layoutHeaderWords};
export const VIEW_LAYOUT_FIELDS = ${JSON.stringify(view.layoutFields)}, VIEW_DYNAMIC_FIELDS = ${JSON.stringify(view.dynamicFields)};
export const VIEW_SECTION_COUNT = ${view.sections.length};
export const enum ViewSection {
${view.sections.map(name => `  ${name},`).join('\n')}
}
export const enum Op {
${Object.entries(commands).map(([name, code]) => `  ${name} = ${code},`).join('\n')}
}
export const content = ${JSON.stringify(canonical(content.frontend))} as const;
`);
    } else if (mode === '--verify-wasm' && target) {
      await verifyWasm(content, resolve(target));
    } else {
      problems('content.mjs', 'expected --frontend, --rust <path> or --verify-wasm <path>');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
