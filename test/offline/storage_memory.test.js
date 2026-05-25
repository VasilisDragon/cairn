import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { run as runDeposit } from '../../src/skills/deposit.js';
import {
  buildAdvisorWorldModelSummary,
  createEmptyWorldModel,
  observeStorageContents,
} from '../../src/state/world_model.js';

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
      acquire: () => ({ token: { id: 'storage-memory-test' }, release() {} }),
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

function ctx(worldModel = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' }), extra = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldModel,
    ...extra,
  };
}

async function captureStdoutRecords(fn) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function write(chunk, ...args) {
    const text = String(chunk);
    if (text.trim().startsWith('{')) {
      writes.push(text);
      if (typeof args.at(-1) === 'function') args.at(-1)();
      return true;
    }
    return originalWrite.call(process.stdout, chunk, ...args);
  };

  let value;
  try {
    value = await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  const records = writes
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
  return { value, records };
}

test('observeStorageContents records and updates deterministic container contents', () => {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const block = { name: 'chest', position: pos(4, 64, 0) };

  const first = observeStorageContents(model, block, {
    containerItems: () => [
      { name: 'oak_log', count: 2 },
      { name: 'stick', count: 1 },
      { name: 'oak_log', count: 3 },
    ],
  }, { now: '2026-05-22T00:00:01.000Z' });
  const second = observeStorageContents(model, block, {
    containerItems: () => [{ name: 'stick', count: 4 }],
  }, { now: '2026-05-22T00:00:02.000Z' });
  const summary = buildAdvisorWorldModelSummary(model);

  assert.equal(first.key, 'chest:4,64,0');
  assert.equal(second.key, 'chest:4,64,0');
  assert.equal(model.storageSightings.length, 1);
  assert.deepEqual(model.storageSightings[0].contents, { stick: 4 });
  assert.deepEqual(summary.knownStorage[0].contents, { stick: 4 });
});

test('deposit records observed chest contents in world model and store', async () => {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  let savedModel = null;
  let deposited = 0;
  const chestPos = pos(5, 64, 0);
  const chest = {
    deposit: async (_type, _metadata, count) => {
      deposited += count;
    },
    containerItems: () => [{ name: 'oak_log', count: deposited }],
    close() {},
  };
  const callCtx = ctx(model, {
    worldModelStore: {
      save(next) { savedModel = next; },
    },
  });
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 3 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => chest,
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 3 }] }, callCtx);

  assert.equal(result.ok, true);
  assert.equal(savedModel, model);
  assert.equal(model.storageSightings.length, 1);
  assert.deepEqual(model.storageSightings[0].contents, { oak_log: 3 });
  assert.deepEqual(buildAdvisorWorldModelSummary(model).knownStorage[0].contents, { oak_log: 3 });
});

test('deposit logs container close failures without masking success', async () => {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const chestPos = pos(5, 64, 0);
  const chest = {
    deposit: async () => {},
    containerItems: () => [],
    close() {
      throw new Error('close failed');
    },
  };
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => chest,
  });

  const { value: result, records } = await captureStdoutRecords(() => runDeposit(
    bot,
    { items: [{ name: 'oak_log', count: 1 }] },
    ctx(model),
  ));

  assert.equal(result.ok, true);
  assert.equal(records.some((record) => (
    record.evt === 'container.close-error' &&
    record.skill === 'deposit' &&
    record.err === 'close failed'
  )), true);
});
