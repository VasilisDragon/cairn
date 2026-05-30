import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { run as runFishAndDeposit } from '../../src/skills/fish_and_deposit.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

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

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  const items = overrides.items || [
    { name: 'fishing_rod', type: TEST_REGISTRY.itemsByName.fishing_rod.id, count: 1, slot: 5 },
  ];
  Object.assign(bot, {
    _client: new EventEmitter(),
    chunksReady: Promise.resolve(),
    entity: {
      position: pos(0, 64, 0),
      isInWater: false,
      equipment: [],
    },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: TEST_REGISTRY,
    inventory: {
      items: () => items,
    },
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'fish-and-deposit-test' }, release() {} }),
      setGoal: () => {
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
      currentOwner: () => null,
      isIdle: () => true,
    },
    blockAt: () => ({ name: 'chest', position: pos(3, 64, 0) }),
    async openContainer() {
      return {
        deposit: async (type, _metadata, count) => {
          const index = items.findIndex((item) => item.type === type && item.count > 0);
          assert.notEqual(index, -1);
          const item = items[index];
          assert.ok(item.count >= count);
          item.count -= count;
          if (item.count <= 0) items.splice(index, 1);
          bot.deposited = bot.deposited || [];
          bot.deposited.push({ name: item.name, type, count });
        },
        containerItems: () => [],
        close() {
          bot.containerClosed = true;
        },
      };
    },
    async equip(item, destination) {
      this.equipped = { item, destination };
      this.heldItem = item;
    },
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
      if (this.activateCalls === 1) {
        setTimeout(() => {
          this._client.emit('spawn_entity', {
            type: 90,
            entityId: 77,
            x: 0,
            y: 64,
            z: 2,
          });
          this._client.emit('world_particles', {
            particle: { name: 'fishing' },
            amount: 8,
            x: 0,
            y: 64,
            z: 2,
          });
        }, 5);
      } else if (this.activateCalls === 2) {
        items.push({ name: 'cod', type: TEST_REGISTRY.itemsByName.cod.id, count: 1, slot: 10 });
      }
    },
    ...overrides,
  });
  return bot;
}

function ctx(overrides = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    ...overrides,
  };
}

function countDeposited(items = []) {
  const counts = {};
  for (const item of items) {
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

test('fish_and_deposit fishes at the current stand and deposits caught deltas plus rod', async () => {
  const bot = makeBot();

  const result = await runFishAndDeposit(bot, {
    catches: 1,
    maxAttempts: 1,
    attemptTimeoutMs: 1000,
    pickupTimeoutMs: 500,
    depositChest: { x: 3, y: 64, z: 0 },
    depositRod: true,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'fish_and_deposit caught 1 and deposited 1 cod, 1 fishing_rod');
  assert.deepEqual(result.caughtCounts, { cod: 1 });
  assert.deepEqual(result.depositedCounts, { cod: 1, fishing_rod: 1 });
  assert.deepEqual(bot.deposited.map((item) => item.name), ['cod', 'fishing_rod']);
  assert.equal(bot.equipped.destination, 'hand');
  assert.equal(bot.activateCalls, 2);
  assert.equal(bot.containerClosed, true);
  assert.deepEqual(bot.inventory.items(), []);
});

test('fish_and_deposit deposits carried-over fishing loot after a replan', async () => {
  const bot = makeBot({
    items: [
      { name: 'fishing_rod', type: TEST_REGISTRY.itemsByName.fishing_rod.id, count: 1, slot: 5 },
      { name: 'cod', type: TEST_REGISTRY.itemsByName.cod.id, count: 1, slot: 10 },
      { name: 'pufferfish', type: TEST_REGISTRY.itemsByName.pufferfish.id, count: 1, slot: 11 },
    ],
  });

  const result = await runFishAndDeposit(bot, {
    catches: 1,
    maxAttempts: 1,
    attemptTimeoutMs: 1000,
    pickupTimeoutMs: 500,
    depositChest: { x: 3, y: 64, z: 0 },
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'fish_and_deposit caught 3 and deposited 2 cod, 1 pufferfish');
  assert.deepEqual(result.caughtCounts, { cod: 2, pufferfish: 1 });
  assert.deepEqual(result.depositedCounts, { cod: 2, pufferfish: 1 });
  assert.deepEqual(countDeposited(bot.deposited), { cod: 2, pufferfish: 1 });
  assert.deepEqual(bot.inventory.items().map((item) => item.name), ['fishing_rod']);
});

test('fish_and_deposit deposits partial catches when a later catch attempt times out', async () => {
  const items = [
    { name: 'fishing_rod', type: TEST_REGISTRY.itemsByName.fishing_rod.id, count: 1, slot: 5 },
  ];
  const bot = makeBot({
    items,
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
      if (this.activateCalls === 1) {
        setTimeout(() => {
          this._client.emit('spawn_entity', {
            type: 90,
            entityId: 77,
            x: 0,
            y: 64,
            z: 2,
          });
          this._client.emit('world_particles', {
            particle: { name: 'fishing' },
            amount: 8,
            x: 0,
            y: 64,
            z: 2,
          });
        }, 5);
      } else if (this.activateCalls === 2) {
        items.push({ name: 'cod', type: TEST_REGISTRY.itemsByName.cod.id, count: 1, slot: 10 });
      } else if (this.activateCalls === 3) {
        setTimeout(() => {
          this._client.emit('spawn_entity', {
            type: 90,
            entityId: 78,
            x: 0,
            y: 64,
            z: 2,
          });
        }, 5);
      }
    },
  });

  const result = await runFishAndDeposit(bot, {
    catches: 2,
    maxAttempts: 2,
    attemptTimeoutMs: 25,
    pickupTimeoutMs: 500,
    depositChest: { x: 3, y: 64, z: 0 },
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(
    result.reason,
    /^fish_and_deposit deposited partial catch 1 cod but did not reach requested 2: fish_until attempt 2 failed: fishing attempt timed out after 25ms/,
  );
  assert.equal(result.fishResult.ok, false);
  assert.equal(result.fishResult.catches, 1);
  assert.deepEqual(result.caughtCounts, { cod: 1 });
  assert.deepEqual(result.depositedCounts, { cod: 1 });
  assert.deepEqual(bot.inventory.items().map((item) => item.name), ['fishing_rod']);
});

test('fish_and_deposit can resume directly into deposit without fishing again', async () => {
  const bot = makeBot({
    items: [{ name: 'cod', type: TEST_REGISTRY.itemsByName.cod.id, count: 1, slot: 10 }],
  });
  const callState = {
    phase: 'deposit',
    caughtCounts: { cod: 1 },
  };

  const result = await runFishAndDeposit(bot, {
    catches: 1,
    depositChest: { x: 3, y: 64, z: 0 },
  }, ctx({ callState }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.caughtCounts, { cod: 1 });
  assert.deepEqual(result.depositedCounts, { cod: 1 });
  assert.equal(bot.activateCalls || 0, 0);
  assert.deepEqual(bot.deposited.map((item) => item.name), ['cod']);
});

test('fish_and_deposit validates depositChest before casting', async () => {
  const bot = makeBot();

  const result = await runFishAndDeposit(bot, { catches: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fish_and_deposit requires depositChest {x,y,z}');
  assert.equal(bot.activateCalls || 0, 0);
});
