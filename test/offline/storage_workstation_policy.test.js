import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { run as runCraft } from '../../src/skills/craft.js';
import { run as runDeposit } from '../../src/skills/deposit.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';
import { addDisposableWorldFixtureBotState, disposableWorldActionFixture } from './helpers/world_action_fixture.js';

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

function modelWithProtectedBox(min = [0, 63, 0], max = [2, 66, 2]) {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min, max },
    reason: 'likely_player_made',
    confidence: 0.91,
  });
  return model;
}

function ctx(worldModel = modelWithProtectedBox()) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldModel,
    worldActionAuthorization: disposableWorldActionFixture(),
  };
}

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  let selectedGoal = null;
  let acquireCalls = 0;

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
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'storage-policy-test' }, release() {} };
      },
      setGoal: (_token, goal) => {
        selectedGoal = goal;
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
    },
    ...overrides,
  });

  addDisposableWorldFixtureBotState(bot);

  Object.defineProperties(bot, {
    selectedGoal: { get() { return selectedGoal; } },
    acquireCalls: { get() { return acquireCalls; } },
  });
  return bot;
}

function flipToProtectedStore(target, protectAtLoad) {
  const safe = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  const blocked = modelWithProtectedBox(
    [target.x, target.y, target.z],
    [target.x, target.y, target.z],
  );
  let loads = 0;
  return {
    load() {
      loads += 1;
      return loads >= protectAtLoad ? blocked : safe;
    },
    save() {},
    get loads() { return loads; },
  };
}

function storeBackedCtx(store, callState) {
  return {
    signal: new AbortController().signal,
    callState,
    remainingQueue: [],
    currentSubtask: null,
    worldModelStore: store,
    worldActionAuthorization: disposableWorldActionFixture(),
  };
}

test('deposit skips protected chests when locking a target', async () => {
  const protectedChest = pos(0, 64, 0);
  const allowedChest = pos(8, 64, 0);
  const callCtx = ctx();
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [protectedChest, allowedChest],
    blockAt: (p) => ({ name: 'chest', position: p }),
    openContainer: async () => ({
      deposit: async () => {},
      close() {},
    }),
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, callCtx);

  assert.equal(result.ok, true);
  assert.equal(callCtx.callState.lockedChestPos.x, allowedChest.x);
  assert.equal(bot.selectedGoal.x, allowedChest.x);
});

test('deposit fails before pathing when only protected chests remain', async () => {
  const protectedChest = pos(0, 64, 0);
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [protectedChest],
    blockAt: (p) => ({ name: 'chest', position: p }),
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no chest within 32 blocks (protected 1)');
  assert.equal(bot.acquireCalls, 0);
});

test('deposit rejects a locked chest that becomes protected', async () => {
  const callCtx = ctx();
  callCtx.callState.lockedChestPos = pos(0, 64, 0);
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => {
      throw new Error('should not rescan while target is locked');
    },
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked chest access denied: inside do-not-touch region region_protected');
  assert.equal(bot.acquireCalls, 0);
});

test('craft skips protected crafting tables when locking a target', async () => {
  const protectedTable = pos(0, 64, 0);
  const allowedTable = pos(8, 64, 0);
  const recipe = { id: 'oak_planks_recipe' };
  const callCtx = ctx();
  const bot = makeBot({
    recipesFor: (_itemId, _metadata, _min, table) => (table ? [recipe] : []),
    findBlocks: () => [protectedTable, allowedTable],
    blockAt: (p) => ({ name: 'crafting_table', position: p }),
    craft: async () => {},
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, callCtx);

  assert.equal(result.ok, true);
  assert.equal(callCtx.callState.lockedTablePos.x, allowedTable.x);
  assert.equal(bot.selectedGoal.x, allowedTable.x);
});

test('craft fails before pathing when only protected crafting tables remain', async () => {
  const protectedTable = pos(0, 64, 0);
  const bot = makeBot({
    recipesFor: () => [],
    findBlocks: () => [protectedTable],
    blockAt: (p) => ({ name: 'crafting_table', position: p }),
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no recipe for "oak_planks" — need ingredients OR a crafting_table within 16 blocks (protected 1)');
  assert.equal(bot.acquireCalls, 0);
});

test('craft rejects a locked crafting table that becomes protected', async () => {
  const callCtx = ctx();
  callCtx.callState.lockedTablePos = pos(0, 64, 0);
  callCtx.callState.walked = false;
  const bot = makeBot({
    recipesFor: () => [],
    findBlocks: () => {
      throw new Error('should not rescan while target is locked');
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked crafting_table access denied: inside do-not-touch region region_protected');
  assert.equal(bot.acquireCalls, 0);
});

test('deposit rechecks policy inside the final open boundary', async () => {
  const chest = pos(3, 64, 0);
  const store = flipToProtectedStore(chest, 4);
  let openCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: TEST_REGISTRY.itemsByName.oak_log.id, count: 1 }] },
    blockAt: () => ({ name: 'chest', position: chest }),
    openContainer: async () => {
      openCalls += 1;
      throw new Error('physical open must not run');
    },
  });

  const result = await runDeposit(
    bot,
    { items: [{ name: 'oak_log', count: 1 }] },
    storeBackedCtx(store, { lockedChestPos: chest }),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /openContainer failed: container access denied immediately before open: inside do-not-touch region region_protected/);
  assert.equal(openCalls, 0);
  assert.ok(store.loads >= 4);
});

test('craft rechecks policy inside the final workstation-use boundary', async () => {
  const table = pos(3, 64, 0);
  const store = flipToProtectedStore(table, 4);
  let craftCalls = 0;
  const recipe = { id: 'table_recipe', ingredients: [] };
  const bot = makeBot({
    recipesFor: (_itemId, _metadata, _count, craftingTable) => (craftingTable ? [recipe] : []),
    recipesAll: () => [recipe],
    blockAt: () => ({ name: 'crafting_table', position: table }),
    craft: async () => {
      craftCalls += 1;
    },
  });

  const result = await runCraft(
    bot,
    { item: 'oak_planks', count: 1 },
    storeBackedCtx(store, { lockedTablePos: table, walked: true }),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /craft failed: crafting_table access denied immediately before craft: inside do-not-touch region region_protected/);
  assert.equal(craftCalls, 0);
  assert.ok(store.loads >= 4);
});

test('another-player join during deposit walk revokes natural chest trust before open', async () => {
  const chest = pos(3, 64, 0);
  let openCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: TEST_REGISTRY.itemsByName.oak_log.id, count: 1 }] },
    blockAt: () => ({ name: 'chest', position: chest }),
    openContainer: async () => {
      openCalls += 1;
      throw new Error('physical open must not run');
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => {
      bot.emit('playerJoined', { username: 'Alex' });
      bot.emit('goal_reached');
    });
    return true;
  };

  const callCtx = ctx(createEmptyWorldModel());
  callCtx.callState.lockedChestPos = chest;
  const result = await runDeposit(
    bot,
    { items: [{ name: 'oak_log', count: 1 }] },
    callCtx,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /unowned storage denied after disposable-world trust revocation/);
  assert.equal(openCalls, 0);
});
