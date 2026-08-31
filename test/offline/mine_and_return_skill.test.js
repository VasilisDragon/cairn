import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { run as runMineAndReturn } from '../../src/skills/mine_and_return.js';
import { posKey } from '../../src/skills/_pathing.js';
import { createWorldActionAuthorization } from '../../src/state/world_action_authorization.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');
const BLOCK_IDS = Object.freeze({
  coal_ore: TEST_REGISTRY.blocksByName.coal_ore.id,
  diamond_ore: TEST_REGISTRY.blocksByName.diamond_ore.id,
  chest: TEST_REGISTRY.blocksByName.chest.id,
});
const ITEM_IDS = Object.freeze({
  coal: TEST_REGISTRY.itemsByName.coal.id,
  diamond: TEST_REGISTRY.itemsByName.diamond.id,
});
const DROPS = Object.freeze({
  coal_ore: 'coal',
  diamond_ore: 'diamond',
});

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    clone() { return pos(x, y, z); },
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function ctx(overrides = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldIdentity: 'mine-and-return-test-world',
    worldActionAuthorization: createWorldActionAuthorization({
      worldIdentity: 'mine-and-return-test-world',
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: { x: 3, y: 64, z: 0 },
        dimension: 'overworld',
        worldIdentity: 'mine-and-return-test-world',
      }],
    }),
    ...overrides,
  };
}

function makeMovements() {
  return {
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
}

function makeHarness(blocksInput = [], opts = {}) {
  const bot = new EventEmitter();
  const blocks = new Map(blocksInput.map((entry) => [
    posKey(entry.position),
    { name: entry.name, position: entry.position },
  ]));
  blocks.set('3,64,0', { name: 'chest', position: pos(3, 64, 0) });
  const inventory = { ...(opts.inventory || {}) };
  const collected = [];
  const deposited = [];
  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0), isInWater: false },
    worldIdentity: 'mine-and-return-test-world',
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: {
      ...TEST_REGISTRY,
      blocksByName: {
        ...TEST_REGISTRY.blocksByName,
        ...Object.fromEntries(Object.entries(BLOCK_IDS).map(([name, id]) => [name, { id, name }])),
      },
      itemsByName: {
        ...TEST_REGISTRY.itemsByName,
        ...Object.fromEntries(Object.entries(ITEM_IDS).map(([name, id]) => [name, { id, name }])),
      },
    },
    inventory: {
      items: () => Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count, type: ITEM_IDS[name] || 999 })),
    },
    findBlocks({ matching }) {
      const ids = new Set(Array.isArray(matching) ? matching : [matching]);
      return [...blocks.values()]
        .filter((block) => ids.has(BLOCK_IDS[block.name]))
        .map((block) => block.position);
    },
    blockAt(position) {
      const block = blocks.get(posKey(position));
      return block
        ? { name: block.name, position: block.position }
        : { name: 'air', position };
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async (target) => {
        collected.push(target.name);
        blocks.delete(posKey(target.position));
        const drop = DROPS[target.name] || target.name;
        inventory[drop] = (inventory[drop] || 0) + 1;
      },
    },
    async openContainer() {
      return {
        deposit: async (type, _metadata, count) => {
          const itemName = Object.entries(ITEM_IDS).find(([, id]) => id === type)?.[0] || 'unknown';
          assert.ok((inventory[itemName] || 0) >= count);
          inventory[itemName] -= count;
          if (inventory[itemName] <= 0) delete inventory[itemName];
          deposited.push({ name: itemName, count });
        },
        containerItems: () => [],
        close() {
          bot.containerClosed = true;
        },
      };
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'mine-and-return-test' }, release() {} }),
      setGoal: () => {
        setImmediate(() => bot.emit('goal_reached'));
        return { ok: true };
      },
      stop() {},
      currentOwner: () => null,
      isIdle: () => true,
    },
  });
  return { bot, inventory, collected, deposited };
}

test('mine_and_return mines visible ores, returns to the chest, and deposits mined deltas', async () => {
  const harness = makeHarness([
    { name: 'coal_ore', position: pos(2, 64, 0) },
  ]);

  const result = await runMineAndReturn(harness.bot, {
    count: 1,
    maxAttempts: 2,
    ores: ['coal_ore'],
    returnChest: { x: 3, y: 64, z: 0 },
  }, ctx());

  assert.equal(result.ok, true);
  assert.deepEqual(result.minedCounts, { coal: 1 });
  assert.deepEqual(harness.collected, ['coal_ore']);
  assert.deepEqual(harness.deposited, [{ name: 'coal', count: 1 }]);
  assert.deepEqual(harness.inventory, {});
  assert.equal(harness.bot.containerClosed, true);
});

test('mine_and_return can resume directly into deposit without mining again', async () => {
  const harness = makeHarness([], { inventory: { diamond: 1 } });
  const callState = {
    phase: 'return',
    minedCounts: { diamond: 1 },
  };

  const result = await runMineAndReturn(harness.bot, {
    count: 1,
    ores: ['diamond_ore'],
    returnChest: { x: 3, y: 64, z: 0 },
  }, ctx({ callState }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.minedCounts, { diamond: 1 });
  assert.deepEqual(harness.collected, []);
  assert.deepEqual(harness.deposited, [{ name: 'diamond', count: 1 }]);
});

test('mine_and_return returns before reporting a visible-target mining failure', async () => {
  const harness = makeHarness([]);

  const result = await runMineAndReturn(harness.bot, {
    count: 1,
    maxAttempts: 1,
    ores: ['coal_ore'],
    returnChest: { x: 3, y: 64, z: 0 },
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /returned after mining failure/);
  assert.match(result.reason, /no-visible-targets/);
  assert.deepEqual(harness.deposited, []);
});

test('mine_and_return validates returnChest before mining', async () => {
  const harness = makeHarness([
    { name: 'coal_ore', position: pos(2, 64, 0) },
  ]);

  const result = await runMineAndReturn(harness.bot, {
    count: 1,
    ores: ['coal_ore'],
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mine_and_return requires returnChest {x,y,z}');
  assert.deepEqual(harness.collected, []);
});
