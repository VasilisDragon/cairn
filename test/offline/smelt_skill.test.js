import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { run as runSmelt } from '../../src/skills/smelt.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';
import { addDisposableWorldFixtureBotState, disposableWorldActionFixture } from './helpers/world_action_fixture.js';

const registry = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    clone() { return pos(x, y, z); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function ctx(extra = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldActionAuthorization: disposableWorldActionFixture(),
    ...extra,
  };
}

function makeFurnace(slots = {}) {
  const furnace = new EventEmitter();
  furnace.slots = {
    input: slots.input || null,
    fuel: slots.fuel || null,
    output: slots.output || null,
  };
  furnace.inputItem = () => furnace.slots.input;
  furnace.fuelItem = () => furnace.slots.fuel;
  furnace.outputItem = () => furnace.slots.output;
  furnace.closeCalls = 0;
  furnace.close = () => {
    furnace.closeCalls += 1;
  };
  return furnace;
}

function inventoryItems(counts) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count], index) => ({
      name,
      count,
      type: registry.itemsByName[name].id,
      slot: index,
    }));
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
    registry,
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'smelt-test' }, release() {} }),
      setGoal: () => {
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
    },
    ...overrides,
  });
  return addDisposableWorldFixtureBotState(bot);
}

test('smelt loads input and fuel, waits for expected output, and closes furnace', async () => {
  const furnacePos = pos(5, 64, 0);
  const furnace = makeFurnace();
  const inventory = { raw_iron: 3, coal: 1, iron_ingot: 0 };
  const operations = [];
  let selectedGoal = null;
  const bot = makeBot({
    inventory: {
      items: () => inventoryItems(inventory),
    },
    findBlocks: () => [furnacePos],
    blockAt: (p) => ({ name: 'furnace', position: p }),
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'smelt-success-test' }, release() {} }),
      setGoal: (_token, goal) => {
        selectedGoal = goal;
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
    },
    openFurnace: async () => {
      furnace.putInput = async (type, _metadata, count) => {
        operations.push(`input:${count}`);
        assert.equal(type, registry.itemsByName.raw_iron.id);
        inventory.raw_iron -= count;
        furnace.slots.input = { name: 'raw_iron', count };
      };
      furnace.putFuel = async (type, _metadata, count) => {
        operations.push(`fuel:${count}`);
        assert.equal(type, registry.itemsByName.coal.id);
        inventory.coal -= count;
        furnace.slots.fuel = { name: 'coal', count };
        setImmediate(() => {
          furnace.slots.output = { name: 'iron_ingot', count: 3 };
          furnace.emit('update');
        });
      };
      furnace.takeOutput = async () => {
        operations.push('takeOutput');
        const item = furnace.slots.output;
        furnace.slots.output = null;
        inventory.iron_ingot += item.count;
        return item;
      };
      return furnace;
    },
  });

  const result = await runSmelt(bot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 3,
    waitTimeoutMs: 1000,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'smelted 3 iron_ingot');
  assert.deepEqual(operations, ['input:3', 'fuel:1', 'takeOutput']);
  assert.equal(inventory.raw_iron, 0);
  assert.equal(inventory.coal, 0);
  assert.equal(inventory.iron_ingot, 3);
  assert.equal(furnace.closeCalls, 1);
  assert.equal(selectedGoal.x, furnacePos.x);
});

test('smelt reports missing input before opening a furnace', async () => {
  let opened = false;
  const bot = makeBot({
    inventory: {
      items: () => inventoryItems({ raw_iron: 2, coal: 1 }),
    },
    openFurnace: async () => {
      opened = true;
      return makeFurnace();
    },
  });

  const result = await runSmelt(bot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 3,
    furnace: pos(1, 64, 1),
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing smelt input raw_iron: need 3, have 2');
  assert.equal(opened, false);
});

test('smelt rechecks policy inside the final furnace-open boundary', async () => {
  const furnacePos = pos(5, 64, 0);
  const safe = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  const blocked = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  blocked.doNotTouchRegions.push({
    id: 'furnace-sink-protected',
    bbox: { min: [5, 64, 0], max: [5, 64, 0] },
    reason: 'test sink mutation',
    confidence: 1,
  });
  let loads = 0;
  let openCalls = 0;
  const store = {
    load() {
      loads += 1;
      return loads >= 4 ? blocked : safe;
    },
  };
  const bot = makeBot({
    inventory: { items: () => inventoryItems({ raw_iron: 1, coal: 1 }) },
    blockAt: () => ({ name: 'furnace', position: furnacePos }),
    openFurnace: async () => {
      openCalls += 1;
      throw new Error('physical open must not run');
    },
  });

  const result = await runSmelt(bot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 1,
    furnace: furnacePos,
  }, ctx({
    callState: {
      lockedFurnacePos: furnacePos,
      walked: true,
      inputLoaded: 0,
      fuelLoaded: 0,
      fuelName: null,
      fuelNeeded: 0,
      outputTaken: 0,
    },
    worldModelStore: store,
  }));

  assert.equal(result.ok, false);
  assert.match(result.reason, /openFurnace failed: furnace access denied immediately before open: inside do-not-touch region furnace-sink-protected/);
  assert.equal(openCalls, 0);
  assert.ok(loads >= 4);
});

test('smelt accepts a plain object furnace position from place results', async () => {
  const furnace = makeFurnace({ input: { name: 'cobblestone', count: 1 } });
  const bot = makeBot({
    inventory: {
      items: () => inventoryItems({ raw_iron: 3, coal: 1 }),
    },
    blockAt: (p) => {
      if (typeof p?.floored !== 'function') {
        throw new Error('pos.floored is not a function');
      }
      return { name: 'furnace', position: p };
    },
    openFurnace: async () => furnace,
  });

  const result = await runSmelt(bot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 3,
    furnace: { x: 2, y: 64, z: 0 },
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'furnace input occupied by cobblestone');
});

test('smelt resumes after output-wait preempt without reloading input or fuel', async () => {
  const furnace = makeFurnace();
  const inventory = { raw_iron: 3, coal: 1, iron_ingot: 0 };
  const callState = {};
  const firstController = new AbortController();
  const operations = [];
  const bot = makeBot({
    inventory: {
      items: () => inventoryItems(inventory),
    },
    blockAt: (p) => ({ name: 'furnace', position: p }),
    openFurnace: async () => {
      furnace.putInput = async (_type, _metadata, count) => {
        operations.push(`input:${count}`);
        inventory.raw_iron -= count;
        furnace.slots.input = { name: 'raw_iron', count };
      };
      furnace.putFuel = async (_type, _metadata, count) => {
        operations.push(`fuel:${count}`);
        inventory.coal -= count;
        furnace.slots.fuel = { name: 'coal', count };
        setImmediate(() => firstController.abort('unit-preempt'));
      };
      furnace.takeOutput = async () => {
        operations.push('takeOutput');
        const item = furnace.slots.output;
        furnace.slots.output = null;
        inventory.iron_ingot += item.count;
        return item;
      };
      return furnace;
    },
  });

  const first = await runSmelt(bot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 3,
    furnace: pos(2, 64, 0),
    waitTimeoutMs: 1000,
  }, ctx({ signal: firstController.signal, callState }));

  assert.equal(first.preempted, true);
  assert.equal(first.reason, 'reactive preempt waiting for furnace output');
  assert.equal(callState.inputLoaded, 3);
  assert.equal(callState.fuelLoaded, 1);
  assert.deepEqual(operations, ['input:3', 'fuel:1']);

  setImmediate(() => {
    furnace.slots.output = { name: 'iron_ingot', count: 3 };
    furnace.emit('update');
  });
  const second = await runSmelt(bot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 3,
    furnace: pos(2, 64, 0),
    waitTimeoutMs: 1000,
  }, ctx({ callState }));

  assert.equal(second.ok, true);
  assert.equal(second.reason, 'smelted 3 iron_ingot');
  assert.deepEqual(operations, ['input:3', 'fuel:1', 'takeOutput']);
  assert.deepEqual(inventory, { raw_iron: 0, coal: 0, iron_ingot: 3 });
});

test('smelt refuses occupied furnace slots instead of mixing materials', async () => {
  const furnace = makeFurnace({ input: { name: 'cobblestone', count: 1 } });
  const bot = makeBot({
    inventory: {
      items: () => inventoryItems({ raw_iron: 3, coal: 1 }),
    },
    blockAt: (p) => ({ name: 'furnace', position: p }),
    openFurnace: async () => furnace,
  });

  const result = await runSmelt(bot, {
    input: 'raw_iron',
    output: 'iron_ingot',
    count: 3,
    furnace: pos(2, 64, 0),
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'furnace input occupied by cobblestone');
});
