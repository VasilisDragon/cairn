import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIdleHumanizationLoop,
  installIdleHumanization,
} from '../../src/runtime/idle_humanization.js';

function logger() {
  const records = [];
  return {
    records,
    debug: (evt, fields = {}) => records.push({ level: 'debug', evt, ...fields }),
    info: (evt, fields = {}) => records.push({ level: 'info', evt, ...fields }),
    warn: (evt, fields = {}) => records.push({ level: 'warn', evt, ...fields }),
  };
}

test('idle humanization loop stays disabled unless humanization is enabled', () => {
  const bot = { humanizer: { enabled: false, options: { idleMicroBehaviorEnabled: true } } };
  const loop = installIdleHumanization(bot, { logger: logger() });

  assert.equal(loop.installed, false);
  assert.equal(loop.start(), false);
  assert.equal(bot.humanizationIdleLoop, undefined);
});

test('idle humanization loop schedules and runs only when the bot is idle', async () => {
  const log = logger();
  const timers = [];
  const cleared = [];
  let performed = 0;
  const bot = {
    usingHeldItem: false,
    autoEat: { isEating: false },
    pathfinderOwner: { isIdle: () => true },
    skillExecutor: { running: false, queue: [], currentCall: null },
    humanizer: {
      enabled: true,
      options: {
        idleMicroBehaviorEnabled: true,
        idleMinMs: 10,
        idleMaxMs: 10,
        mood: 'efficient',
      },
      nextIdleDelayMs: () => 10,
      performIdleMicroBehavior: async () => {
        performed += 1;
      },
    },
  };

  const loop = createIdleHumanizationLoop(bot, {
    logger: log,
    setTimeoutFn: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => cleared.push(timer),
  });

  assert.equal(loop.installed, true);
  assert.equal(loop.start(), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10);

  await timers[0].fn();

  assert.equal(performed, 1);
  assert.equal(timers.length, 2);
  assert.equal(log.records.some((record) => record.evt === 'humanize.idle-loop-start'), true);
  assert.equal(loop.stop('test stop'), true);
  assert.equal(cleared.length, 1);
});

test('idle humanization loop skips while executor or pathfinder is active', async () => {
  let performed = 0;
  const bot = {
    pathfinderOwner: { isIdle: () => false },
    skillExecutor: { running: true, queue: [{ skill: 'collect' }], currentCall: { skill: 'collect' } },
    humanizer: {
      enabled: true,
      options: {
        idleMicroBehaviorEnabled: true,
        idleMinMs: 10,
        idleMaxMs: 10,
        mood: 'efficient',
      },
      nextIdleDelayMs: () => 10,
      performIdleMicroBehavior: async () => {
        performed += 1;
      },
    },
  };
  const loop = createIdleHumanizationLoop(bot, {
    logger: logger(),
    setTimeoutFn: () => ({ unref() {} }),
  });

  const result = await loop.tick();

  assert.equal(result, false);
  assert.equal(performed, 0);
  loop.stop('test stop');
});
