import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import config from '../../src/config.js';
import { run as runCraft } from '../../src/skills/craft.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    clone() { return pos(x, y, z); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function makeRecipe() {
  return {
    id: 'oak_planks_from_log',
    result: { name: 'oak_planks', count: 4 },
    ingredients: [{ name: 'oak_log', count: 1 }],
  };
}

function makeStickRecipe() {
  return {
    id: 'stick_from_planks',
    result: { name: 'stick', count: 4 },
    ingredients: [{ name: 'oak_planks', count: 2 }],
  };
}

function ctx(worldModel, extra = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldModel,
    ...extra,
  };
}

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    registry: TEST_REGISTRY,
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'craft-storage-test' }, release() {} }),
      setGoal: () => {
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
    },
    ...overrides,
  });
  return bot;
}

function worldModelWithStorage(chestPos, contents) {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.storageSightings.push({
    key: `chest:${chestPos.x},${chestPos.y},${chestPos.z}`,
    kind: 'storage',
    name: 'chest',
    position: chestPos,
    seenAt: '2026-05-22T00:00:00.000Z',
    contents,
  });
  return model;
}

test('craft withdraws missing recipe ingredients from known storage before crafting', async () => {
  const recipe = makeRecipe();
  const chestPos = pos(3, 64, 0);
  const model = worldModelWithStorage(chestPos, { oak_log: 1 });
  let inventoryLogs = 0;
  let chestLogs = 1;
  let crafted = false;
  let savedModel = null;
  const bot = makeBot({
    inventory: {
      items: () => (inventoryLogs > 0 ? [{ name: 'oak_log', type: TEST_REGISTRY.itemsByName.oak_log.id, count: inventoryLogs }] : []),
    },
    recipesFor: () => (inventoryLogs >= 1 ? [recipe] : []),
    recipesAll: () => [recipe],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: async (type, _metadata, count) => {
        assert.equal(type, TEST_REGISTRY.itemsByName.oak_log.id);
        assert.equal(count, 1);
        chestLogs -= count;
        inventoryLogs += count;
      },
      containerItems: () => (chestLogs > 0 ? [{ name: 'oak_log', count: chestLogs }] : []),
      close() {},
    }),
    craft: async (resolvedRecipe, count) => {
      assert.equal(resolvedRecipe, recipe);
      assert.equal(count, 1);
      crafted = true;
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx(model, {
    worldModelStore: {
      save(next) { savedModel = next; },
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'crafted 1 oak_planks');
  assert.equal(crafted, true);
  assert.equal(inventoryLogs, 1);
  assert.equal(chestLogs, 0);
  assert.equal(savedModel, model);
  assert.deepEqual(model.storageSightings[0].contents, {});
});

test('craft withdraws only the storage shortfall when inventory is partially satisfied', async () => {
  const recipe = {
    id: 'oak_planks_from_two_logs',
    result: { name: 'oak_planks', count: 4 },
    ingredients: [{ name: 'oak_log', count: 2 }],
  };
  const chestPos = pos(3, 64, 0);
  const model = worldModelWithStorage(chestPos, { oak_log: 1 });
  let inventoryLogs = 1;
  let chestLogs = 1;
  let withdrawn = 0;
  let crafted = false;
  const bot = makeBot({
    inventory: {
      items: () => (inventoryLogs > 0 ? [{ name: 'oak_log', type: TEST_REGISTRY.itemsByName.oak_log.id, count: inventoryLogs }] : []),
    },
    recipesFor: () => (inventoryLogs >= 2 ? [recipe] : []),
    recipesAll: () => [recipe],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: async (type, _metadata, count) => {
        assert.equal(type, TEST_REGISTRY.itemsByName.oak_log.id);
        assert.equal(count, 1);
        withdrawn += count;
        chestLogs -= count;
        inventoryLogs += count;
      },
      containerItems: () => (chestLogs > 0 ? [{ name: 'oak_log', count: chestLogs }] : []),
      close() {},
    }),
    craft: async (resolvedRecipe, count) => {
      assert.equal(resolvedRecipe, recipe);
      assert.equal(count, 1);
      crafted = true;
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx(model));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'crafted 1 oak_planks');
  assert.equal(withdrawn, 1);
  assert.equal(inventoryLogs, 2);
  assert.equal(chestLogs, 0);
  assert.equal(crafted, true);
});

test('craft stages missing ingredients for the full requested craft count', async () => {
  const recipe = makeRecipe();
  const chestPos = pos(3, 64, 0);
  const model = worldModelWithStorage(chestPos, { oak_log: 1 });
  let inventoryLogs = 1;
  let chestLogs = 1;
  let craftedCount = 0;
  let withdrawn = 0;
  const bot = makeBot({
    inventory: {
      items: () => (inventoryLogs > 0 ? [{ name: 'oak_log', type: TEST_REGISTRY.itemsByName.oak_log.id, count: inventoryLogs }] : []),
    },
    recipesFor: () => (inventoryLogs >= 1 ? [recipe] : []),
    recipesAll: () => [recipe],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: async (type, _metadata, count) => {
        assert.equal(type, TEST_REGISTRY.itemsByName.oak_log.id);
        assert.equal(count, 1);
        withdrawn += count;
        chestLogs -= count;
        inventoryLogs += count;
      },
      containerItems: () => (chestLogs > 0 ? [{ name: 'oak_log', count: chestLogs }] : []),
      close() {},
    }),
    craft: async (resolvedRecipe, count) => {
      assert.equal(resolvedRecipe, recipe);
      if (inventoryLogs < count) throw new Error(`not enough logs for ${count} crafts`);
      inventoryLogs -= count;
      craftedCount = count;
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 2 }, ctx(model));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'crafted 2 oak_planks');
  assert.equal(withdrawn, 1);
  assert.equal(chestLogs, 0);
  assert.equal(inventoryLogs, 0);
  assert.equal(craftedCount, 2);
});

test('craft recursively crafts dependency ingredients from known storage', async () => {
  const plankRecipe = makeRecipe();
  const stickRecipe = makeStickRecipe();
  const chestPos = pos(3, 64, 0);
  const model = worldModelWithStorage(chestPos, { oak_log: 1 });
  const inventory = { oak_log: 0, oak_planks: 0, stick: 0 };
  const craftOrder = [];
  const bot = makeBot({
    inventory: {
      items: () => Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, type: TEST_REGISTRY.itemsByName[name].id, count })),
    },
    recipesFor: (itemId) => {
      if (itemId === TEST_REGISTRY.itemsByName.oak_planks.id && inventory.oak_log >= 1) return [plankRecipe];
      if (itemId === TEST_REGISTRY.itemsByName.stick.id && inventory.oak_planks >= 2) return [stickRecipe];
      return [];
    },
    recipesAll: (itemId) => {
      if (itemId === TEST_REGISTRY.itemsByName.oak_planks.id) return [plankRecipe];
      if (itemId === TEST_REGISTRY.itemsByName.stick.id) return [stickRecipe];
      return [];
    },
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: async (type, _metadata, count) => {
        assert.equal(type, TEST_REGISTRY.itemsByName.oak_log.id);
        inventory.oak_log += count;
      },
      containerItems: () => [],
      close() {},
    }),
    craft: async (recipe, count) => {
      craftOrder.push(`${recipe.id}:${count}`);
      if (recipe.id === 'oak_planks_from_log') {
        inventory.oak_log -= count;
        inventory.oak_planks += 4 * count;
      } else if (recipe.id === 'stick_from_planks') {
        inventory.oak_planks -= 2 * count;
        inventory.stick += 4 * count;
      }
    },
  });

  const result = await runCraft(bot, { item: 'stick', count: 1 }, ctx(model));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'crafted 1 stick');
  assert.deepEqual(craftOrder, [
    'oak_planks_from_log:1',
    'stick_from_planks:1',
  ]);
  assert.deepEqual(inventory, { oak_log: 0, oak_planks: 2, stick: 4 });
});

test('craft reports hung dependency craft operation timeouts', async (t) => {
  const originalTimeout = config.executor.craftOperationTimeoutMs;
  config.executor.craftOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.craftOperationTimeoutMs = originalTimeout;
  });

  const plankRecipe = makeRecipe();
  const stickRecipe = makeStickRecipe();
  const inventory = { oak_log: 1, oak_planks: 0, stick: 0 };
  const bot = makeBot({
    inventory: {
      items: () => Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, type: TEST_REGISTRY.itemsByName[name].id, count })),
    },
    recipesFor: (itemId) => {
      if (itemId === TEST_REGISTRY.itemsByName.oak_planks.id && inventory.oak_log >= 1) return [plankRecipe];
      if (itemId === TEST_REGISTRY.itemsByName.stick.id && inventory.oak_planks >= 2) return [stickRecipe];
      return [];
    },
    recipesAll: (itemId) => {
      if (itemId === TEST_REGISTRY.itemsByName.oak_planks.id) return [plankRecipe];
      if (itemId === TEST_REGISTRY.itemsByName.stick.id) return [stickRecipe];
      return [];
    },
    craft: (recipe) => {
      assert.equal(recipe, plankRecipe);
      return new Promise(() => {});
    },
  });

  const result = await runCraft(bot, { item: 'stick', count: 1 }, ctx(createEmptyWorldModel()));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'craft dependency oak_planks failed: craft operation timed out after 20ms');
});

test('craft skips protected known storage and withdraws from an allowed alternate', async () => {
  const recipe = makeRecipe();
  const protectedPos = pos(2, 64, 0);
  const allowedPos = pos(8, 64, 0);
  const model = worldModelWithStorage(protectedPos, { oak_log: 1 });
  model.storageSightings.push({
    key: `chest:${allowedPos.x},${allowedPos.y},${allowedPos.z}`,
    kind: 'storage',
    name: 'chest',
    position: allowedPos,
    seenAt: '2026-05-22T00:00:00.000Z',
    contents: { oak_log: 1 },
  });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min: [2, 63, 0], max: [2, 65, 0] },
    reason: 'likely_player_made',
    confidence: 0.9,
  });
  let inventoryLogs = 0;
  let selectedGoal = null;
  const bot = makeBot({
    inventory: {
      items: () => (inventoryLogs > 0 ? [{ name: 'oak_log', type: TEST_REGISTRY.itemsByName.oak_log.id, count: inventoryLogs }] : []),
    },
    recipesFor: () => (inventoryLogs >= 1 ? [recipe] : []),
    recipesAll: () => [recipe],
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'craft-storage-alternate-test' }, release() {} }),
      setGoal: (_token, goal) => {
        selectedGoal = goal;
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
    },
    blockAt: (p) => ({ name: 'chest', position: p }),
    openContainer: async (block) => {
      assert.deepEqual(block.position, allowedPos);
      return {
        withdraw: async () => { inventoryLogs += 1; },
        containerItems: () => [],
        close() {},
      };
    },
    craft: async () => {},
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx(model));

  assert.equal(result.ok, true);
  assert.equal(selectedGoal.x, allowedPos.x);
  assert.equal(selectedGoal.y, allowedPos.y);
  assert.equal(selectedGoal.z, allowedPos.z);
});

test('craft refuses to withdraw ingredients from protected known storage', async () => {
  const chestPos = pos(3, 64, 0);
  const model = worldModelWithStorage(chestPos, { oak_log: 1 });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min: [3, 63, 0], max: [3, 65, 0] },
    reason: 'likely_player_made',
    confidence: 0.9,
  });
  const bot = makeBot({
    recipesFor: () => [],
    recipesAll: () => [makeRecipe()],
    pathfinderOwner: {
      acquire: () => {
        throw new Error('should not path to protected storage');
      },
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx(model));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing ingredients for "oak_planks": 1 oak_log (protected storage skipped: 1)');
});

test('craft reports missing ingredients when known storage cannot satisfy recipe', async () => {
  let craftCalls = 0;
  const bot = makeBot({
    recipesFor: () => [],
    recipesAll: () => [makeRecipe()],
    craft: async () => {
      craftCalls += 1;
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx(createEmptyWorldModel()));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing ingredients for "oak_planks": 1 oak_log');
  assert.equal(craftCalls, 0);
});
