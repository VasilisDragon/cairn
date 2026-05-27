import test from 'node:test';
import assert from 'node:assert/strict';
import mcDataLoader from 'minecraft-data';

import {
  buildRecipeBook,
  canSatisfy,
  countItems,
  expandCraftingPlan,
  findNearestStorageWithItem,
  missingItems,
  planMiningFieldKit,
  planMiningToolProgression,
  planSmeltingFuel,
  planSmeltingJob,
  planToolForBlock,
  planMaterialFulfillment,
  readBotInventoryCounts,
  recipeRequirements,
  toolRequirementsForBlock,
} from '../../src/state/materials.js';

const registry = mcDataLoader('1.21.4');

function item(name, count) {
  return { name, count };
}

function pos(x, y, z) {
  return { x, y, z };
}

function recipe(id, resultName, resultCount, ingredients) {
  return {
    id,
    result: { id: registry.itemsByName[resultName].id, count: resultCount },
    ingredients: ingredients.map(([name, count]) => ({ id: registry.itemsByName[name].id, count })),
  };
}

test('item counting and shortfall helpers normalize deterministic count records', () => {
  const inventory = countItems([
    item('oak_log', 2),
    item('stick', 1),
    item('oak_log', 3),
    item('air', 0),
  ]);

  assert.deepEqual(inventory, { oak_log: 5, stick: 1 });
  assert.deepEqual(missingItems({ oak_log: 6, stick: 1 }, inventory), { oak_log: 1 });
  assert.deepEqual(canSatisfy({ oak_log: 5 }, inventory), {
    ok: true,
    required: { oak_log: 5 },
    available: { oak_log: 5, stick: 1 },
    missing: {},
  });
});

test('inventory reader reports unavailable bot inventory without throwing', () => {
  const result = readBotInventoryCounts({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    inventory: {},
    error: 'inventory cache unavailable',
  });
});

test('nearest storage lookup and fulfillment plan use deterministic distance order', () => {
  const storages = [
    { id: 'far', position: pos(10, 64, 0), items: [item('oak_log', 3)] },
    { id: 'near', position: pos(2, 64, 0), items: [item('oak_log', 2), item('stick', 4)] },
  ];

  const nearest = findNearestStorageWithItem(storages, 'oak_log', pos(0, 64, 0));
  const plan = planMaterialFulfillment({
    requirements: { oak_log: 6, stick: 2 },
    inventory: [item('oak_log', 1)],
    storages,
    from: pos(0, 64, 0),
  });

  assert.equal(nearest.storageId, 'near');
  assert.equal(nearest.count, 2);
  assert.equal(nearest.distance, 2);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.missingAfterInventory, { oak_log: 5, stick: 2 });
  assert.deepEqual(plan.withdrawals.map((w) => `${w.storageId}:${w.item}:${w.count}`), [
    'near:oak_log:2',
    'far:oak_log:3',
    'near:stick:2',
  ]);
});

test('recipe requirements parse recipe ingredients and delta costs', () => {
  const plankRecipe = recipe('oak_planks_from_log', 'oak_planks', 4, [['oak_log', 1]]);
  const deltaRecipe = {
    id: 'delta_stick',
    result: { id: registry.itemsByName.stick.id, count: 4 },
    delta: [
      { id: registry.itemsByName.oak_planks.id, count: -2 },
      { id: registry.itemsByName.stick.id, count: 4 },
    ],
  };

  assert.deepEqual(recipeRequirements(plankRecipe, registry), { oak_log: 1 });
  assert.deepEqual(recipeRequirements(deltaRecipe, registry), { oak_planks: 2 });
});

test('recipe requirements do not double-count prismarine shape and delta inputs', () => {
  const ids = {
    cobblestone: registry.itemsByName.cobblestone.id,
    oak_planks: registry.itemsByName.oak_planks.id,
    stick: registry.itemsByName.stick.id,
    stone_pickaxe: registry.itemsByName.stone_pickaxe.id,
  };
  const empty = { id: -1, count: 1 };
  const stonePickaxeRecipe = {
    result: { id: ids.stone_pickaxe, count: 1 },
    inShape: [
      [{ id: ids.cobblestone, count: 1 }, { id: ids.cobblestone, count: 1 }, { id: ids.cobblestone, count: 1 }],
      [empty, { id: ids.stick, count: 1 }, empty],
      [empty, { id: ids.stick, count: 1 }, empty],
    ],
    delta: [
      { id: ids.cobblestone, count: -3 },
      { id: ids.stick, count: -2 },
      { id: ids.stone_pickaxe, count: 1 },
    ],
  };
  const stickRecipe = {
    result: { id: ids.stick, count: 4 },
    inShape: [
      [{ id: ids.oak_planks, count: 1 }],
      [{ id: ids.oak_planks, count: 1 }],
    ],
    delta: [
      { id: ids.oak_planks, count: -2 },
      { id: ids.stick, count: 4 },
    ],
  };

  assert.deepEqual(recipeRequirements(stonePickaxeRecipe, registry), { cobblestone: 3, stick: 2 });
  assert.deepEqual(recipeRequirements(stickRecipe, registry), { oak_planks: 2 });
});

test('crafting dependency expansion reports missing raw materials', () => {
  const recipes = [
    recipe('oak_planks_from_log', 'oak_planks', 4, [['oak_log', 1]]),
    recipe('stick_from_planks', 'stick', 4, [['oak_planks', 2]]),
    recipe('wooden_pickaxe', 'wooden_pickaxe', 1, [['oak_planks', 3], ['stick', 2]]),
  ];
  const plan = expandCraftingPlan(
    { name: 'wooden_pickaxe', count: 1 },
    {
      inventory: { oak_log: 1 },
      recipeBook: buildRecipeBook(recipes, registry),
      registry,
    }
  );

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.missing, { oak_log: 1 });
  assert.deepEqual(plan.craftPlan.map((step) => `${step.item}:${step.times}`), [
    'oak_planks:1',
    'oak_planks:1',
    'stick:1',
    'wooden_pickaxe:1',
  ]);
});

test('crafting dependency expansion succeeds when inventory can satisfy recursive recipes', () => {
  const recipes = [
    recipe('oak_planks_from_log', 'oak_planks', 4, [['oak_log', 1]]),
    recipe('stick_from_planks', 'stick', 4, [['oak_planks', 2]]),
  ];
  const plan = expandCraftingPlan(
    { name: 'stick', count: 8 },
    {
      inventory: { oak_log: 1 },
      recipes,
      registry,
    }
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.missing, {});
  assert.deepEqual(plan.craftPlan.map((step) => `${step.item}:${step.times}`), [
    'oak_planks:1',
    'stick:2',
  ]);
  assert.deepEqual(plan.remaining, {});
});

test('tool requirement planning distinguishes harvest requirements from preferred tools', () => {
  const stone = toolRequirementsForBlock('stone', registry);
  const dirt = toolRequirementsForBlock('dirt', registry);
  const diamondOreWithStone = planToolForBlock('diamond_ore', { stone_pickaxe: 1 }, registry);
  const diamondOreWithIron = planToolForBlock('diamond_ore', { stone_pickaxe: 1, iron_pickaxe: 1 }, registry);

  assert.equal(stone.ok, true);
  assert.equal(stone.toolKind, 'pickaxe');
  assert.equal(stone.requiresTool, true);
  assert.ok(stone.harvestTools.includes('wooden_pickaxe'));
  assert.equal(dirt.ok, true);
  assert.equal(dirt.toolKind, 'shovel');
  assert.equal(dirt.requiresTool, false);
  assert.equal(diamondOreWithStone.ok, false);
  assert.equal(diamondOreWithStone.canHarvest, false);
  assert.ok(diamondOreWithStone.missingTools.includes('iron_pickaxe'));
  assert.equal(diamondOreWithIron.ok, true);
  assert.equal(diamondOreWithIron.selectedTool, 'iron_pickaxe');
});

test('smelting fuel planner chooses deterministic sufficient fuel with low overburn', () => {
  const plan = planSmeltingFuel({
    itemCount: 9,
    inventory: { coal: 1, oak_planks: 1, stick: 4 },
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.requiredTicks, 1800);
  assert.equal(plan.totalTicks, 1800);
  assert.equal(plan.excessTicks, 0);
  assert.deepEqual(plan.plan, [
    { item: 'coal', count: 1, burnTicks: 1600, totalTicks: 1600 },
    { item: 'stick', count: 2, burnTicks: 100, totalTicks: 200 },
  ]);
});

test('smelting job reports missing inputs and fuel separately', () => {
  const plan = planSmeltingJob({
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 3,
    inventory: { raw_iron: 2, stick: 2 },
  });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.missingInputs, { raw_iron: 1 });
  assert.equal(plan.fuelPlan.ok, false);
  assert.equal(plan.fuelPlan.requiredTicks, 600);
  assert.equal(plan.fuelPlan.totalTicks, 200);
  assert.equal(plan.fuelPlan.missingTicks, 400);
  assert.deepEqual(plan.fuelPlan.plan, [
    { item: 'stick', count: 2, burnTicks: 100, totalTicks: 200 },
  ]);
});

test('mining tool progression plans iron upgrade before blocked gold and diamond targets', () => {
  const plan = planMiningToolProgression({
    oreTargets: ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'],
    inventory: { stone_pickaxe: 1, cooked_beef: 32 },
    registry,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets.harvestable.map((target) => target.block), ['coal_ore', 'iron_ore']);
  assert.deepEqual(plan.targets.blocked.map((target) => target.block), ['gold_ore', 'diamond_ore']);
  assert.deepEqual(plan.requiredTools, ['iron_pickaxe']);
  assert.equal(plan.requiredToolPlans[0].item, 'iron_pickaxe');
  assert.deepEqual(plan.requiredToolPlans[0].requires, { iron_ingot: 3, stick: 2 });
  assert.deepEqual(plan.steps.map((step) => `${step.action}:${step.item || step.input || step.block}`), [
    'mine:raw_iron',
    'mine:coal',
    'carry_or_collect:wood_log',
    'carry_or_collect:wood_log',
    'craft:oak_planks',
    'craft:crafting_table',
    'place_workstation:crafting_table',
    'collect:cobblestone',
    'craft:furnace',
    'place_workstation:furnace',
    'smelt:raw_iron',
    'craft:stick',
    'craft:iron_pickaxe',
  ]);
  assert.deepEqual(plan.steps[0], {
    action: 'mine',
    block: 'iron_ore',
    item: 'raw_iron',
    count: 3,
    reason: 'iron_pickaxe requires 3 iron_ingot',
  });
  assert.deepEqual(plan.optionalToolPlans[0], {
    item: 'iron_sword',
    ok: false,
    optional: true,
    reason: 'skip optional iron_sword; missing materials',
    missing: { fuel_ticks: 400, raw_iron: 2 },
  });
  assert.equal(plan.fieldKit.required, true);
  assert.equal(plan.fieldKit.needsCraftingTable, true);
  assert.equal(plan.fieldKit.needsFurnace, true);
  assert.deepEqual(plan.fieldKit.recommendedCarry, { cobblestone: 8, wood_log: 2 });
  assert.deepEqual(plan.fieldKit.missingPortableSupplies, { cobblestone: 8, wood_log: 2 });
  assert.equal(plan.fieldKit.execution.selfContainedInFieldReady, false);
  assert.match(plan.fieldKit.reasoning.join(' '), /crafting-table access/);
});

test('mining tool progression expands from empty inventory through table, stone, furnace, and iron pickaxe', () => {
  const plan = planMiningToolProgression({
    oreTargets: ['diamond_ore'],
    inventory: {},
    registry,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.requiredTools, ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']);
  assert.deepEqual(plan.steps.map((step) => `${step.action}:${step.item || step.input || step.block || step.workstation}`), [
    'carry_or_collect:wood_log',
    'carry_or_collect:wood_log',
    'craft:oak_planks',
    'craft:crafting_table',
    'place_workstation:crafting_table',
    'craft:stick',
    'craft:wooden_pickaxe',
    'collect:cobblestone',
    'craft:stone_pickaxe',
    'mine:raw_iron',
    'mine:coal',
    'craft:furnace',
    'place_workstation:furnace',
    'smelt:raw_iron',
    'craft:stick',
    'craft:iron_pickaxe',
  ]);
  assert.equal(plan.steps.find((step) => step.action === 'collect' && step.item === 'cobblestone')?.count, 11);
  assert.deepEqual(plan.projectedInventory, {
    iron_pickaxe: 1,
    oak_planks: 5,
    stick: 2,
    stone_pickaxe: 1,
    wooden_pickaxe: 1,
  });
});

test('mining tool progression treats explicit required crafts as progression outputs', () => {
  const plan = planMiningToolProgression({
    oreTargets: ['iron_ore'],
    inventory: {},
    registry,
    requiredCrafts: ['iron_pickaxe'],
    optionalCrafts: [],
  });

  assert.equal(plan.requiredCraftPlans[0].item, 'iron_pickaxe');
  assert.deepEqual(plan.requiredTools, ['wooden_pickaxe', 'stone_pickaxe']);
  assert.deepEqual(plan.steps.map((step) => `${step.action}:${step.item || step.input || step.block || step.workstation}`), [
    'carry_or_collect:wood_log',
    'carry_or_collect:wood_log',
    'craft:oak_planks',
    'craft:crafting_table',
    'place_workstation:crafting_table',
    'craft:stick',
    'craft:wooden_pickaxe',
    'collect:cobblestone',
    'craft:stone_pickaxe',
    'mine:raw_iron',
    'mine:coal',
    'craft:furnace',
    'place_workstation:furnace',
    'smelt:raw_iron',
    'craft:stick',
    'craft:iron_pickaxe',
  ]);
  assert.equal(plan.steps.find((step) => step.action === 'collect' && step.item === 'cobblestone')?.count, 11);
  assert.equal(plan.projectedInventory.iron_pickaxe, 1);
});

test('mining tool progression adds optional iron sword when surplus raw iron and wood are ready', () => {
  const plan = planMiningToolProgression({
    oreTargets: ['diamond_ore'],
    inventory: { stone_pickaxe: 1, raw_iron: 5, coal: 1, oak_log: 1 },
    registry,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.requiredTools, ['iron_pickaxe']);
  assert.equal(plan.requiredToolPlans[0].resourceReady, true);
  assert.equal(plan.optionalToolPlans[0].item, 'iron_sword');
  assert.equal(plan.optionalToolPlans[0].resourceReady, true);
  assert.deepEqual(plan.steps.map((step) => `${step.action}:${step.item || step.input || step.output || step.block}`), [
    'carry_or_collect:wood_log',
    'craft:oak_planks',
    'craft:crafting_table',
    'place_workstation:crafting_table',
    'collect:cobblestone',
    'craft:furnace',
    'place_workstation:furnace',
    'smelt:raw_iron',
    'craft:stick',
    'craft:iron_pickaxe',
    'craft:iron_sword',
  ]);
  assert.deepEqual(plan.projectedInventory, {
    iron_pickaxe: 1,
    iron_sword: 1,
    oak_planks: 2,
    stick: 1,
    stone_pickaxe: 1,
  });
});

test('mining tool progression treats any wood planks as stick support', () => {
  const plan = planMiningToolProgression({
    oreTargets: ['diamond_ore'],
    inventory: { stone_pickaxe: 1, raw_iron: 3, coal: 1, spruce_planks: 2 },
    registry,
  });

  assert.equal(plan.requiredToolPlans[0].resourceReady, true);
  assert.equal(plan.steps.filter((step) => step.action === 'carry_or_collect').length, 1);
  assert.deepEqual(plan.projectedInventory, {
    iron_pickaxe: 1,
    stick: 2,
    stone_pickaxe: 1,
  });
});

test('mining tool progression does not count an uncraftable single plank as stick support', () => {
  const plan = planMiningToolProgression({
    oreTargets: ['diamond_ore'],
    inventory: { stone_pickaxe: 1, raw_iron: 3, coal: 1, spruce_planks: 1 },
    registry,
  });

  assert.equal(plan.requiredToolPlans[0].resourceReady, false);
  assert.deepEqual(plan.requiredToolPlans[0].missing, { wood_log: 1 });
  assert.deepEqual(plan.steps.map((step) => `${step.action}:${step.item || step.input || step.block}`), [
    'carry_or_collect:wood_log',
    'carry_or_collect:wood_log',
    'craft:oak_planks',
    'craft:crafting_table',
    'place_workstation:crafting_table',
    'collect:cobblestone',
    'craft:furnace',
    'place_workstation:furnace',
    'smelt:raw_iron',
    'craft:stick',
    'craft:iron_pickaxe',
  ]);
  assert.deepEqual(plan.projectedInventory, {
    iron_pickaxe: 1,
    oak_planks: 2,
    spruce_planks: 1,
    stick: 2,
    stone_pickaxe: 1,
  });
});

test('tool planning prefers stone over copper as the cheap iron-tier prerequisite', () => {
  const syntheticRegistry = {
    blocksByName: {
      iron_ore: {
        name: 'iron_ore',
        harvestTools: {
          1: true,
          2: true,
          3: true,
        },
      },
    },
    items: {
      1: { name: 'copper_pickaxe' },
      2: { name: 'stone_pickaxe' },
      3: { name: 'iron_pickaxe' },
    },
  };

  const plan = planToolForBlock('iron_ore', {}, syntheticRegistry);

  assert.deepEqual(plan.missingTools, ['stone_pickaxe', 'copper_pickaxe', 'iron_pickaxe']);
});

test('mining field kit preflight reports portable workstation supplies and blockers', () => {
  const fieldKit = planMiningFieldKit({
    inventory: { oak_log: 1, cobblestone: 4 },
    steps: [
      { action: 'smelt', input: 'raw_iron', output: 'iron_ingot', count: 3 },
      { action: 'craft', item: 'iron_pickaxe', count: 1, requires: { iron_ingot: 3, stick: 2 } },
    ],
  });

  assert.equal(fieldKit.required, true);
  assert.equal(fieldKit.needsCraftingTable, true);
  assert.equal(fieldKit.needsFurnace, true);
  assert.deepEqual(fieldKit.recommendedCarry, { cobblestone: 8, wood_log: 2 });
  assert.deepEqual(fieldKit.missingPortableSupplies, { cobblestone: 4, wood_log: 1 });
  assert.equal(fieldKit.execution.selfContainedInFieldReady, false);
  assert.deepEqual(fieldKit.execution.blockers, [
    'missing portable supply wood_log:1',
    'missing portable supply cobblestone:4',
  ]);
});
