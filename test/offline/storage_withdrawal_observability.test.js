import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import config from '../../src/config.js';
import { withdrawFromKnownStorage } from '../../src/skills/_storage.js';
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

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: pos(0, 64, 0), isInWater: false },
    registry: TEST_REGISTRY,
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'storage-observability-test' }, release() {} }),
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

function ctx(worldModel, extra = {}) {
  return {
    signal: new AbortController().signal,
    worldModel,
    ...extra,
  };
}

function withdrawal(storageId, item, count, position) {
  return [{ storageId, item, count, position }];
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

test('known-storage withdrawal emits structured observability events', async () => {
  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  let chestLogs = 2;
  let inventoryLogs = 0;
  let savedModel = null;
  const bot = makeBot({
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: async (type, _metadata, count) => {
        assert.equal(type, TEST_REGISTRY.itemsByName.oak_log.id);
        chestLogs -= count;
        inventoryLogs += count;
      },
      containerItems: () => (chestLogs > 0 ? [{ name: 'oak_log', count: chestLogs }] : []),
      close() {},
    }),
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    [{ storageId: 'storage_a', item: 'oak_log', count: 2, position: chestPos }],
    ctx(model, {
      worldModelStore: {
        save(next) { savedModel = next; },
      },
    }),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.ok, true);
  assert.equal(inventoryLogs, 2);
  assert.equal(chestLogs, 0);
  assert.equal(savedModel, model);

  const storageEvents = records.filter((record) => record.evt?.startsWith('storage.withdraw.'));
  assert.deepEqual(storageEvents.map((record) => record.evt), [
    'storage.withdraw.start',
    'storage.withdraw.path-start',
    'storage.withdraw.reached',
    'storage.withdraw.open',
    'storage.withdraw.item',
    'storage.withdraw.memory',
    'storage.withdraw.done',
  ]);

  const itemEvent = storageEvents.find((record) => record.evt === 'storage.withdraw.item');
  assert.equal(itemEvent.storageId, 'storage_a');
  assert.deepEqual(itemEvent.position, { x: 3, y: 64, z: 0 });
  assert.deepEqual(itemEvent.requests, { oak_log: 2 });
  assert.equal(itemEvent.item, 'oak_log');
  assert.equal(itemEvent.count, 2);

  const memoryEvent = storageEvents.find((record) => record.evt === 'storage.withdraw.memory');
  assert.deepEqual(memoryEvent.contents, {});

  const doneEvent = storageEvents.find((record) => record.evt === 'storage.withdraw.done');
  assert.deepEqual(doneEvent.withdrawn, { oak_log: 2 });
});

test('known-storage withdrawal rejects unknown item before walking to storage', async () => {
  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  let acquireCalls = 0;
  const bot = makeBot({
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'should-not-acquire' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path for unknown storage item');
      },
      stop() {},
    },
    blockAt: () => {
      throw new Error('should not read world for unknown storage item');
    },
    openContainer: async () => {
      throw new Error('should not open storage for unknown item');
    },
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    [{ storageId: 'storage_a', item: 'not_an_item', count: 1, position: chestPos }],
    ctx(model),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown storage item "not_an_item"');
  assert.equal(acquireCalls, 0);
  const storageEvents = records.filter((record) => record.evt?.startsWith('storage.withdraw.'));
  assert.deepEqual(storageEvents.map((record) => record.evt), [
    'storage.withdraw.start',
    'storage.withdraw.item-failed',
  ]);
  assert.equal(storageEvents[1].phase, 'item-validation');
  assert.equal(storageEvents[1].item, 'not_an_item');
});

test('known-storage withdrawal logs container close failures without masking success', async () => {
  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const bot = makeBot({
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: async () => {},
      containerItems: () => [],
      close() {
        throw new Error('close failed');
      },
    }),
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    withdrawal('storage_close_failure', 'oak_log', 1, chestPos),
    ctx(model),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.ok, true);
  assert.equal(records.some((record) => (
    record.evt === 'container.close-error' &&
    record.skill === 'storage.withdraw' &&
    record.storageId === 'storage_close_failure' &&
    record.err === 'close failed'
  )), true);
});

test('known-storage withdrawal reports preempt when open aborts', async () => {
  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const controller = new AbortController();
  const bot = makeBot({
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => {
      controller.abort('reactive-preempt');
      throw new Error('open interrupted');
    },
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    withdrawal('storage_open_abort', 'oak_log', 1, chestPos),
    ctx(model, { signal: controller.signal }),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt opening known storage');
  assert.deepEqual(result.withdrawn, []);
  assert.equal(
    records.some((record) => record.evt === 'storage.withdraw.preempted' && record.phase === 'open'),
    true,
  );
});

test('known-storage withdrawal reports hung openContainer timeouts', async (t) => {
  const originalTimeout = config.executor.containerOpenTimeoutMs;
  config.executor.containerOpenTimeoutMs = 20;
  t.after(() => {
    config.executor.containerOpenTimeoutMs = originalTimeout;
  });

  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const bot = makeBot({
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: () => new Promise(() => {}),
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    withdrawal('storage_open_timeout', 'oak_log', 1, chestPos),
    ctx(model),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    'openContainer failed for known storage storage_open_timeout: container open timed out after 20ms',
  );
  assert.deepEqual(result.withdrawn, []);
  assert.equal(
    records.some((record) => (
      record.evt === 'container.open-timeout'
      && record.skill === 'storage.withdraw'
      && record.storageId === 'storage_open_timeout'
      && record.timeoutMs === 20
    )),
    true,
  );
  assert.equal(
    records.some((record) => record.evt === 'storage.withdraw.open-failed' && record.phase === undefined),
    true,
  );
});

test('known-storage withdrawal reports preempt when hung openContainer is aborted', async (t) => {
  const originalTimeout = config.executor.containerOpenTimeoutMs;
  config.executor.containerOpenTimeoutMs = 1000;
  t.after(() => {
    config.executor.containerOpenTimeoutMs = originalTimeout;
  });

  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const controller = new AbortController();
  const bot = makeBot({
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: () => new Promise(() => {}),
  });

  const started = Date.now();
  const { value: result, records } = await captureStdoutRecords(() => {
    const resultPromise = withdrawFromKnownStorage(
      bot,
      withdrawal('storage_open_hung_abort', 'oak_log', 1, chestPos),
      ctx(model, { signal: controller.signal }),
      { worldModel: model, timeoutMs: 1000 },
    );
    setTimeout(() => controller.abort('reactive-preempt'), 10);
    return resultPromise;
  });

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt opening known storage');
  assert.deepEqual(result.withdrawn, []);
  assert.ok(Date.now() - started < 250);
  assert.equal(
    records.some((record) => record.evt === 'storage.withdraw.preempted' && record.phase === 'open'),
    true,
  );
});

test('known-storage withdrawal reports block-check world-query failures', async () => {
  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const bot = makeBot({
    blockAt: () => {
      throw new Error('block cache unavailable');
    },
    openContainer: async () => {
      throw new Error('should not open when block check fails');
    },
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    withdrawal('storage_block_fail', 'oak_log', 1, chestPos),
    ctx(model),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed checking known storage storage_block_fail: block cache unavailable');
  assert.deepEqual(result.withdrawn, []);
  assert.equal(
    records.some((record) => record.evt === 'storage.withdraw.failed' && record.phase === 'block-check'),
    true,
  );
});

test('known-storage withdrawal reports preempt when block check aborts before throwing', async () => {
  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const controller = new AbortController();
  const bot = makeBot({
    blockAt: () => {
      controller.abort('reactive-preempt');
      throw new Error('block check interrupted');
    },
    openContainer: async () => {
      throw new Error('should not open when block check preempts');
    },
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    withdrawal('storage_block_abort', 'oak_log', 1, chestPos),
    ctx(model, { signal: controller.signal }),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt checking known storage');
  assert.deepEqual(result.withdrawn, []);
  assert.equal(
    records.some((record) => record.evt === 'storage.withdraw.preempted' && record.phase === 'block-check'),
    true,
  );
});

test('known-storage withdrawal reports preempt when transfer aborts and closes once', async () => {
  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  const controller = new AbortController();
  let closeCalls = 0;
  const bot = makeBot({
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: async () => {
        controller.abort('reactive-preempt');
        throw new Error('withdraw interrupted');
      },
      containerItems: () => [{ name: 'oak_log', count: 1 }],
      close() {
        closeCalls += 1;
      },
    }),
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    withdrawal('storage_transfer_abort', 'oak_log', 1, chestPos),
    ctx(model, { signal: controller.signal }),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during storage withdrawal transfer');
  assert.deepEqual(result.withdrawn, []);
  assert.equal(closeCalls, 1);
  assert.equal(
    records.some((record) => record.evt === 'storage.withdraw.preempted' && record.phase === 'transfer'),
    true,
  );
});

test('known-storage withdrawal reports hung container withdraw timeouts', async (t) => {
  const originalTimeout = config.executor.containerTransferTimeoutMs;
  config.executor.containerTransferTimeoutMs = 20;
  t.after(() => {
    config.executor.containerTransferTimeoutMs = originalTimeout;
  });

  const chestPos = pos(3, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  let closeCalls = 0;
  const bot = makeBot({
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      withdraw: () => new Promise(() => {}),
      containerItems: () => [{ name: 'oak_log', count: 1 }],
      close() {
        closeCalls += 1;
      },
    }),
  });

  const { value: result, records } = await captureStdoutRecords(() => withdrawFromKnownStorage(
    bot,
    withdrawal('storage_transfer_timeout', 'oak_log', 1, chestPos),
    ctx(model),
    { worldModel: model, timeoutMs: 1000 },
  ));

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    'storage.withdraw failed for oak_log from storage_transfer_timeout: container withdraw timed out after 20ms',
  );
  assert.deepEqual(result.withdrawn, []);
  assert.equal(closeCalls, 1);
  assert.equal(
    records.some((record) => (
      record.evt === 'container.withdraw-timeout'
      && record.skill === 'storage.withdraw'
      && record.storageId === 'storage_transfer_timeout'
      && record.item === 'oak_log'
      && record.timeoutMs === 20
    )),
    true,
  );
  assert.equal(
    records.some((record) => (
      record.evt === 'storage.withdraw.item-failed'
      && record.item === 'oak_log'
      && record.err === 'container withdraw timed out after 20ms'
    )),
    true,
  );
});
