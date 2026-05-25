import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { awaitBotChunksReady, awaitChunksReady, installChunkReadyGate } from '../../src/control/chunk_ready.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeBot() {
  const bot = new EventEmitter();
  const waits = [];
  bot.waitForChunksToLoad = () => {
    const gate = deferred();
    waits.push(gate);
    return gate.promise;
  };
  return { bot, waits };
}

class SpawnListenerFailureBot extends EventEmitter {
  constructor() {
    super();
    this.waitForChunksToLoad = () => Promise.resolve();
  }

  on(eventName, listener) {
    if (eventName === 'spawn') {
      throw new Error('spawn listener unavailable');
    }
    return super.on(eventName, listener);
  }
}

async function isSettled(promise) {
  let settled = false;
  promise.then(() => { settled = true; });
  await Promise.resolve();
  return settled;
}

const testLogger = {
  info() {},
  warn() {},
};

function makeLogger() {
  const records = [];
  return {
    logger: {
      info() {},
      warn(evt, fields = {}) { records.push({ evt, ...fields }); },
    },
    records,
  };
}

test('chunk-ready gate logs event listener registration failures', async () => {
  const bot = new SpawnListenerFailureBot();
  const { logger, records } = makeLogger();

  assert.doesNotThrow(() => installChunkReadyGate(bot, { logger }));

  assert.deepEqual(records, [
    { evt: 'chunksReady.listener-error', event: 'spawn', err: 'spawn listener unavailable' },
  ]);

  bot.emit('respawn');
  await bot.chunksReady;
});

test('chunk-ready gate logs chunksReady property installation failures', () => {
  const { bot } = makeBot();
  const existingReady = Promise.resolve();
  Object.defineProperty(bot, 'chunksReady', {
    configurable: false,
    enumerable: true,
    value: existingReady,
  });
  const { logger, records } = makeLogger();

  const gate = installChunkReadyGate(bot, { logger });

  assert.equal(gate.propertyInstalled(), false);
  assert.equal(gate.current() instanceof Promise, true);
  assert.equal(bot.chunksReady, existingReady);
  assert.deepEqual(records, [
    { evt: 'chunksReady.install-error', err: "Cannot redefine property: chunksReady" },
  ]);
});

test('chunk-ready gate waits for initial spawn chunk load', async () => {
  const { bot, waits } = makeBot();
  installChunkReadyGate(bot, { logger: testLogger });
  const preSpawnReady = bot.chunksReady;

  bot.emit('spawn');
  const spawnReady = bot.chunksReady;
  await Promise.resolve();

  assert.equal(waits.length, 1);
  assert.equal(await isSettled(preSpawnReady), false);
  assert.equal(await isSettled(spawnReady), false);

  waits[0].resolve();
  await preSpawnReady;
  await spawnReady;
});

test('chunk-ready gate resets after respawn', async () => {
  const { bot, waits } = makeBot();
  installChunkReadyGate(bot, { logger: testLogger });

  bot.emit('spawn');
  waits[0].resolve();
  await bot.chunksReady;

  bot.emit('respawn');
  const respawnReady = bot.chunksReady;
  await Promise.resolve();

  assert.equal(waits.length, 2);
  assert.equal(await isSettled(respawnReady), false);

  waits[1].resolve();
  await respawnReady;
});

test('chunk-ready gate resolves obsolete event promises only after latest refresh completes', async () => {
  const { bot, waits } = makeBot();
  installChunkReadyGate(bot, { logger: testLogger });

  bot.emit('spawn');
  waits[0].resolve();
  await bot.chunksReady;

  bot.emit('respawn');
  const respawnReady = bot.chunksReady;
  bot.emit('spawn');
  const latestReady = bot.chunksReady;
  await Promise.resolve();

  assert.equal(waits.length, 3);
  waits[1].resolve();
  await Promise.resolve();
  assert.equal(await isSettled(respawnReady), false);

  waits[2].resolve();
  await respawnReady;
  await latestReady;
});

test('chunk-ready gate times out hung spawn chunk loads', async () => {
  const bot = new EventEmitter();
  let waitCalls = 0;
  bot.waitForChunksToLoad = () => {
    waitCalls++;
    return new Promise(() => {});
  };
  const { logger, records } = makeLogger();
  installChunkReadyGate(bot, { logger, waitTimeoutMs: 20 });
  const preSpawnReady = bot.chunksReady;

  bot.emit('spawn');
  const spawnReady = bot.chunksReady;

  await preSpawnReady;
  await spawnReady;

  assert.equal(waitCalls, 1);
  assert.deepEqual(records, [
    {
      evt: 'chunksReady.wait-timeout',
      reason: 'spawn',
      generation: 1,
      timeoutMs: 20,
      err: 'waitForChunksToLoad timed out after 20ms',
    },
  ]);
});

test('awaitChunksReady fails closed when abort listener registration throws', async () => {
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error('abort listener unavailable');
    },
    removeEventListener() {},
  };

  const result = await awaitChunksReady(Promise.resolve(), signal, 'reactive preempt waiting for test chunks');

  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'abort listener unavailable');
});

test('awaitChunksReady reports malformed chunksReady thenables', async () => {
  const chunksReady = {
    get then() {
      throw new Error('chunksReady getter failed');
    },
  };

  const result = await awaitChunksReady(chunksReady, new AbortController().signal, 'reactive preempt waiting for test chunks');

  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'chunksReady getter failed');
});

test('awaitBotChunksReady reports chunksReady getter failures', async () => {
  const bot = {};
  Object.defineProperty(bot, 'chunksReady', {
    get() {
      throw new Error('chunksReady bus unavailable');
    },
  });

  const result = await awaitBotChunksReady(bot, new AbortController().signal, 'reactive preempt waiting for test chunks');

  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'chunksReady bus unavailable');
});

test('awaitChunksReady logs abort listener cleanup failures', async () => {
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      throw new Error('abort listener cleanup failed');
    },
  };
  const { logger, records } = makeLogger();

  const result = await awaitChunksReady(Promise.resolve(), signal, 'reactive preempt waiting for test chunks', { logger });

  assert.equal(result.ok, true);
  assert.deepEqual(records, [
    { evt: 'chunksReady.abort-listener-remove-error', err: 'abort listener cleanup failed' },
  ]);
});
