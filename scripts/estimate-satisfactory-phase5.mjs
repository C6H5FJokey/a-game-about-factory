import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [path, variant = 'aluminum', ...windows] = process.argv.slice(2);
const ingotRecipes = { aluminum: 'Recipe_FicsiteIngot_AL_C', iron: 'Recipe_FicsiteIngot_Iron_C' };
if (!path || !Object.hasOwn(ingotRecipes, variant)) {
  console.error('Usage: node scripts/estimate-satisfactory-phase5.mjs <data1.0.json> [aluminum|iron] [seconds...]');
  process.exit(1);
}
const durations = windows.length ? windows.map(Number) : [3730, 7200, 14400];
assert.ok(durations.every(seconds => Number.isFinite(seconds) && seconds > 0), 'Production windows must be positive seconds.');

const bytes = await readFile(path);
const { items, resources, recipes, buildings, miners } = JSON.parse(bytes);
const goals = new Map([
  ['Desc_SpaceElevatorPart_9_C', 1000],
  ['Desc_SpaceElevatorPart_10_C', 1000],
  ['Desc_SpaceElevatorPart_12_C', 256],
  ['Desc_SpaceElevatorPart_11_C', 200],
]);
const defaults = new Map([
  ['Desc_FicsiteIngot_C', ingotRecipes[variant]],
  ['Desc_Plastic_C', 'Recipe_Plastic_C'],
  ['Desc_Rubber_C', 'Recipe_Rubber_C'],
  ['Desc_AluminaSolution_C', 'Recipe_AluminaSolution_C'],
]);
const choices = new Map();
for (const recipe of Object.values(recipes)) {
  if (!recipe.inMachine || recipe.alternate || !recipe.products[0]) continue;
  const product = recipe.products[0].item;
  if (!choices.has(product)) choices.set(product, []);
  choices.get(product).push(recipe);
}

const add = (totals, id, amount) => totals.set(id, (totals.get(id) ?? 0) + amount);
const name = id => items[id].name;
const route = new Map();
const active = new Set();
const ordered = [];

function visit(item) {
  if (resources[item] || route.has(item)) return;
  assert.ok(!active.has(item), 'Unexpected recipe cycle for ' + item);
  active.add(item);
  const options = choices.get(item) ?? [];
  const recipe = defaults.has(item) ? options.find(row => row.className === defaults.get(item)) : options[0];
  assert.ok(recipe && (options.length === 1 || defaults.has(item)), 'Ambiguous upstream recipe for ' + item);
  for (const input of recipe.ingredients) visit(input.item);
  active.delete(item);
  route.set(item, recipe);
  ordered.push(item);
}
for (const item of goals.keys()) visit(item);
ordered.reverse();

function calculate(credits) {
  const demand = new Map(goals);
  const byproducts = new Map();
  const cycles = new Map();
  for (const item of ordered) {
    const recipe = route.get(item);
    const required = (demand.get(item) ?? 0) - (credits.get(item) ?? 0);
    const batches = Math.max(0, required) / recipe.products[0].amount;
    if (batches === 0) continue;
    cycles.set(recipe, batches);
    for (const { item, amount } of recipe.ingredients) add(demand, item, amount * batches);
    for (const { item, amount } of recipe.products.slice(1)) add(byproducts, item, amount * batches);
  }
  return { demand, cycles, byproducts };
}

const gross = calculate(new Map());
const recycled = new Map(['Desc_Water_C', 'Desc_Silica_C', 'Desc_DarkEnergy_C'].map(item => [
  item, Math.min(gross.byproducts.get(item) ?? 0, gross.demand.get(item) ?? 0),
]));
const { demand, cycles, byproducts } = calculate(recycled);
for (const [item, amount] of recycled) assert.ok(amount <= (byproducts.get(item) ?? 0) + 1e-6);

const residue = 'Desc_HeavyOilResidue_C';
const petroleumCoke = recipes.Recipe_PetroleumCoke_C;
assert.equal(petroleumCoke.ingredients.length, 1);
assert.equal(petroleumCoke.ingredients[0].item, residue);
const residueSupply = byproducts.get(residue);
assert.ok(residueSupply > 0, 'The selected oil recipes must supply Heavy Oil Residue.');
cycles.set(petroleumCoke, residueSupply / petroleumCoke.ingredients[0].amount);

const raw = new Map([...demand].filter(([item]) => resources[item]).map(([item, amount]) => [
  item, amount - (recycled.get(item) ?? 0),
]));
const produced = new Map(raw);
const transfers = new Map(goals);
const sinks = new Map();
for (const [recipe, batches] of cycles) {
  for (const { item, amount } of recipe.ingredients) add(transfers, item, amount * batches);
  for (const { item, amount } of recipe.products) add(produced, item, amount * batches);
}
for (const [item, amount] of produced) {
  const extra = amount - (transfers.get(item) ?? 0);
  assert.ok(extra >= -1e-6, 'Supply is below demand for ' + name(item));
  if (extra <= 1e-6) continue;
  assert.ok(!items[item].liquid, 'A fluid byproduct requires an outlet: ' + name(item));
  add(transfers, item, extra);
  sinks.set(item, extra);
}
for (const item of transfers.keys()) assert.ok(produced.has(item), 'Missing supply for ' + name(item));

const sortedRows = map => [...map].sort((a, b) => b[1] - a[1]);
const sum = values => [...values].reduce((total, count) => total + count, 0);
const units = value => Number(value.toFixed(2));
const roundMachines = value => Math.ceil(value - 1e-9);
const oreCapacity = miners.Desc_MinerMk3_C.itemsPerCycle * 60 / miners.Desc_MinerMk3_C.extractCycleTime;
const solids = sortedRows(new Map([...transfers].filter(([item]) => !items[item].liquid)));
const fluids = sortedRows(new Map([...transfers].filter(([item]) => items[item].liquid)));
const solidTransfers = sum(solids.map(([, amount]) => amount));
const fluidTransfers = sum(fluids.map(([, amount]) => amount));

function summarize(seconds) {
  const minutes = seconds / 60;
  const machines = new Map();
  const recipeRows = [];
  let fullLoadMachines = 0;
  for (const [recipe, batches] of cycles) {
    assert.equal(recipe.producedIn.length, 1, recipe.name);
    const building = buildings[recipe.producedIn[0]];
    assert.equal(building.metadata.manufacturingSpeed, 1, building.name);
    const fullLoad = batches * recipe.time / seconds;
    const count = roundMachines(fullLoad);
    fullLoadMachines += fullLoad;
    recipeRows.push({ recipe: recipe.name, building: building.name, count, fullLoad: units(fullLoad) });
    add(machines, building.name, count);
  }
  return {
    seconds,
    processingMachines: sum(machines.values()),
    fullLoadProcessingEquivalent: units(fullLoadMachines),
    normalMk3MinerEquivalents: sum([...raw].filter(([item]) => !items[item].liquid)
      .map(([, amount]) => roundMachines(amount / minutes / oreCapacity))),
    solidTransfersPerMinute: units(solidTransfers / minutes),
    fluidTransfersPerMinute: units(fluidTransfers / minutes),
    cargoByMeanTravelSeconds: Object.fromEntries([5, 15, 30, 60].map(dwell => [dwell, units(solidTransfers / seconds * dwell)])),
    machineTypes: Object.fromEntries(sortedRows(machines)),
    recipeRows: recipeRows.sort((a, b) => b.count - a.count),
    rawPerMinute: Object.fromEntries(sortedRows(raw).map(([item, amount]) => [name(item), units(amount / minutes)])),
    solidTransfersByItem: Object.fromEntries(solids.map(([item, amount]) => [name(item), units(amount / minutes)])),
  };
}

console.log(JSON.stringify({
  datasetSha256: createHash('sha256').update(bytes).digest('hex'), variant,
  recipeCount: cycles.size,
  finals: Object.fromEntries([...goals].map(([item, count]) => [name(item), {
    delivered: count, produced: units(produced.get(item)), minutesPerItemPerMachine: route.get(item).time / 60 / route.get(item).products[0].amount,
  }])),
  recycledVolume: Object.fromEntries([...recycled].map(([item, amount]) => [name(item), units(amount)])),
  sinks: Object.fromEntries([...sinks].map(([item, amount]) => [name(item), units(amount)])),
  windows: durations.map(summarize),
}, null, 2));
