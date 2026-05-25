import test from 'node:test';
import assert from 'node:assert/strict';

import { installMainSpawnHandler, installProcessHandler } from '../../src/runtime/startup.js';

function makeLogger() {
  const records = [];
  const logger = {};
  for (const level of ['error', 'fatal']) {
    logger[level] = (evt, fields = {}) => records.push({ level, evt, ...fields });
  }
  return { logger, records };
}

test('installMainSpawnHandler reports spawn listener registration failures', () => {
  const { logger, records } = makeLogger();
  const bot = {
    once(eventName) {
      throw new Error(`${eventName} listener unavailable`);
    },
  };

  const result = installMainSpawnHandler(bot, () => {}, logger);

  assert.deepEqual(result, { installed: false, handler: null });
  assert.deepEqual(records, [
    { level: 'error', evt: 'main.spawn-listener-error', err: 'spawn listener unavailable' },
  ]);
});

test('installMainSpawnHandler reports spawn handler failures', async () => {
  const { logger, records } = makeLogger();
  const bot = {
    listener: null,
    once(eventName, listener) {
      assert.equal(eventName, 'spawn');
      this.listener = listener;
    },
  };

  const result = installMainSpawnHandler(bot, async () => {
    throw new Error('startup failed');
  }, logger);

  assert.equal(result.installed, true);
  assert.equal(result.handler, bot.listener);

  await result.handler();

  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'fatal');
  assert.equal(records[0].evt, 'main.spawn-handler-error');
  assert.equal(records[0].err, 'startup failed');
  assert.match(records[0].stack, /startup failed/);
});

test('installProcessHandler installs process event handlers', () => {
  const calls = [];
  const target = {
    on(eventName, handler) {
      calls.push({ eventName, handler });
    },
  };

  const handler = () => {};
  const installed = installProcessHandler(target, 'SIGTERM', handler);

  assert.equal(installed, true);
  assert.deepEqual(calls, [{ eventName: 'SIGTERM', handler }]);
});

test('installProcessHandler reports process listener registration failures', () => {
  const { logger, records } = makeLogger();
  const target = {
    on(eventName) {
      throw new Error(`${eventName} unavailable`);
    },
  };

  const installed = installProcessHandler(target, 'SIGINT', () => {}, logger);

  assert.equal(installed, false);
  assert.deepEqual(records, [
    { level: 'error', evt: 'process.listener-error', event: 'SIGINT', err: 'SIGINT unavailable' },
  ]);
});
