import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  awaitGoalReached,
  createPathProgressWatchdog,
  createWaterProgressWatchdog,
  pathingFailureReason,
} from '../../src/skills/_pathing.js';

function makeBot({ x = 0, y = 64, z = 0, isInWater = true, oxygenLevel = 20 } = {}) {
  return {
    entity: {
      isInWater,
      position: { x, y, z },
    },
    oxygenLevel,
  };
}

function makeLogger() {
  const records = [];
  return {
    logger: {
      warn(evt, fields = {}) { records.push({ evt, ...fields }); },
    },
    records,
  };
}

test('water progress watchdog reports waterStall after no movement in water', () => {
  let t = 0;
  const bot = makeBot();
  const watchdog = createWaterProgressWatchdog(bot, { now: () => t, stallMs: 1000 });

  t = 999;
  assert.equal(watchdog.sample(), null);

  t = 1000;
  const result = watchdog.sample();
  assert.equal(result.kind, 'waterStall');
  assert.equal(result.stuckMs, 1000);
});

test('water progress watchdog resets when the bot moves in water', () => {
  let t = 0;
  const bot = makeBot();
  const watchdog = createWaterProgressWatchdog(bot, { now: () => t, stallMs: 1000 });

  t = 900;
  bot.entity.position = { x: 1, y: 64, z: 0 };
  assert.equal(watchdog.sample(), null);

  t = 1500;
  assert.equal(watchdog.sample(), null);

  t = 1900;
  const result = watchdog.sample();
  assert.equal(result.kind, 'waterStall');
  assert.equal(result.stuckMs, 1000);
});

test('water progress watchdog resets when leaving water', () => {
  let t = 0;
  const bot = makeBot();
  const watchdog = createWaterProgressWatchdog(bot, { now: () => t, stallMs: 1000 });

  t = 900;
  bot.entity.isInWater = false;
  assert.equal(watchdog.sample(), null);

  t = 1500;
  bot.entity.isInWater = true;
  assert.equal(watchdog.sample(), null);
});

test('water progress watchdog treats improving oxygen as recovery progress', () => {
  let t = 0;
  const bot = makeBot({ oxygenLevel: 8 });
  const watchdog = createWaterProgressWatchdog(bot, { now: () => t, stallMs: 1000 });

  t = 900;
  bot.oxygenLevel = 10;
  assert.equal(watchdog.sample(), null);

  t = 1500;
  assert.equal(watchdog.sample(), null);
});

test('path progress watchdog reports stuck after no dry-land movement', () => {
  let t = 0;
  const bot = makeBot({ isInWater: false });
  bot.pathfinderOwner = {
    currentOwner: () => 'skill',
    isIdle: () => false,
  };
  const watchdog = createPathProgressWatchdog(bot, { now: () => t, stallMs: 1000 });

  t = 999;
  assert.equal(watchdog.sample(), null);

  t = 1000;
  const result = watchdog.sample();
  assert.equal(result.kind, 'stuck');
  assert.equal(result.stuckMs, 1000);
  assert.deepEqual(result.position, { x: 0, y: 64, z: 0 });
  assert.equal(result.owner, 'skill');
  assert.equal(result.pathfinderIdle, false);
});

test('path progress watchdog isolates pathfinder context read failures', () => {
  let t = 0;
  const bot = makeBot({ isInWater: false });
  bot.pathfinderOwner = {
    currentOwner: () => {
      throw new Error('owner unavailable');
    },
    isIdle: () => {
      throw new Error('idle unavailable');
    },
  };
  const watchdog = createPathProgressWatchdog(bot, { now: () => t, stallMs: 1000 });

  t = 1000;
  const result = watchdog.sample();

  assert.equal(result.kind, 'stuck');
  assert.equal(result.owner, null);
  assert.equal(result.pathfinderIdle, null);
  assert.equal(result.ownerError, 'owner unavailable');
  assert.equal(result.pathfinderIdleError, 'idle unavailable');
});

test('path progress watchdog resets on movement and ignores water', () => {
  let t = 0;
  const bot = makeBot({ isInWater: false });
  const watchdog = createPathProgressWatchdog(bot, { now: () => t, stallMs: 1000 });

  t = 900;
  bot.entity.position = { x: 1, y: 64, z: 0 };
  assert.equal(watchdog.sample(), null);

  t = 1500;
  assert.equal(watchdog.sample(), null);

  t = 1900;
  bot.entity.isInWater = true;
  assert.equal(watchdog.sample(), null);

  t = 2800;
  bot.entity.isInWater = false;
  assert.equal(watchdog.sample(), null);
});

test('awaitGoalReached returns stuck and stops the owned path', async () => {
  const bot = new EventEmitter();
  let stopCalls = 0;
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
    pathfinderOwner: {
      stop(token) {
        assert.equal(token.id, 'skill-token');
        stopCalls += 1;
      },
      currentOwner: () => 'skill',
      isIdle: () => false,
    },
  });

  const result = await awaitGoalReached(bot, null, 1000, {
    ownerToken: { id: 'skill-token' },
    pathStallMs: 10,
    watchdogIntervalMs: 5,
  });

  assert.equal(result.kind, 'stuck');
  assert.equal(stopCalls, 1);
  assert.match(pathingFailureReason(result), /^stuck \(\d+ms at 0,64,0\)$/);
});

test('awaitGoalReached stops the owned path on timeout', async () => {
  const bot = new EventEmitter();
  const ownerToken = { id: 'skill-token' };
  let stopCalls = 0;
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
    pathfinderOwner: {
      stop(token) {
        assert.equal(token, ownerToken);
        stopCalls += 1;
      },
      currentOwner: () => 'skill',
      isIdle: () => false,
    },
  });

  const result = await awaitGoalReached(bot, null, 10, {
    ownerToken,
    enablePathWatchdog: false,
    watchdogIntervalMs: 5,
  });

  assert.equal(result.kind, 'timeout');
  assert.equal(stopCalls, 1);
});

test('awaitGoalReached preserves pathfinder noPath and timeout statuses', async () => {
  async function runPathStatus(status) {
    const bot = new EventEmitter();
    Object.assign(bot, {
      entity: {
        isInWater: false,
        position: { x: 0, y: 64, z: 0 },
      },
      oxygenLevel: 20,
    });
    const resultPromise = awaitGoalReached(bot, null, 1000, {
      enablePathWatchdog: false,
      watchdogIntervalMs: 5,
    });
    bot.emit('path_update', { status });
    return resultPromise;
  }

  assert.equal((await runPathStatus('noPath')).kind, 'noPath');
  const timeout = await runPathStatus('timeout');
  assert.equal(timeout.kind, 'timeout');
  assert.equal(pathingFailureReason(timeout), 'timeout');
});

test('awaitGoalReached stops the owned path on non-reactive abort', async () => {
  const bot = new EventEmitter();
  const ownerToken = { id: 'skill-token' };
  const controller = new AbortController();
  let stopCalls = 0;
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
    pathfinderOwner: {
      stop(token) {
        assert.equal(token, ownerToken);
        stopCalls += 1;
      },
    },
  });

  const resultPromise = awaitGoalReached(bot, controller.signal, 1000, {
    ownerToken,
    enablePathWatchdog: false,
    watchdogIntervalMs: 5,
  });
  controller.abort('skill timed out');
  const result = await resultPromise;

  assert.equal(result.kind, 'preempted');
  assert.equal(stopCalls, 1);
});

test('awaitGoalReached does not duplicate reactive-preempt path stops', async () => {
  const bot = new EventEmitter();
  const ownerToken = { id: 'skill-token' };
  const controller = new AbortController();
  let stopCalls = 0;
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
    pathfinderOwner: {
      stop() {
        stopCalls += 1;
      },
    },
  });

  const resultPromise = awaitGoalReached(bot, controller.signal, 1000, {
    ownerToken,
    enablePathWatchdog: false,
    watchdogIntervalMs: 5,
  });
  controller.abort('reactive-preempt');
  const result = await resultPromise;

  assert.equal(result.kind, 'preempted');
  assert.equal(stopCalls, 0);
});

test('awaitGoalReached fails closed when abort listener registration throws', async () => {
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
  });
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error('abort listener unavailable');
    },
    removeEventListener() {},
  };

  const result = await awaitGoalReached(bot, signal, 10, {
    enablePathWatchdog: false,
    watchdogIntervalMs: 5,
  });

  assert.equal(result.kind, 'signalError');
  assert.equal(result.err, 'abort listener unavailable');
});

test('awaitGoalReached logs abort listener cleanup failures', async () => {
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
  });
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      throw new Error('abort listener cleanup failed');
    },
  };
  const { logger, records } = makeLogger();

  const resultPromise = awaitGoalReached(bot, signal, 1000, {
    enablePathWatchdog: false,
    logger,
  });
  bot.emit('goal_reached');
  const result = await resultPromise;

  assert.equal(result.kind, 'reached');
  assert.deepEqual(records, [
    { evt: 'path.abort-listener-remove-error', err: 'abort listener cleanup failed' },
  ]);
});

test('awaitGoalReached fails closed when bot listener registration throws', async () => {
  class ListenerFailureBot extends EventEmitter {
    on(eventName, listener) {
      if (eventName === 'path_update') throw new Error('path listener unavailable');
      return super.on(eventName, listener);
    }
  }
  const bot = new ListenerFailureBot();
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
  });

  const result = await awaitGoalReached(bot, null, 1000, {
    enablePathWatchdog: false,
    watchdogIntervalMs: 5,
  });

  assert.equal(result.kind, 'eventError');
  assert.equal(result.err, 'path listener unavailable');
  assert.equal(pathingFailureReason(result), 'eventError (path listener unavailable)');
  assert.equal(bot.listenerCount('goal_reached'), 0);
});

test('awaitGoalReached logs bot listener cleanup failures', async () => {
  class RemoveFailureBot extends EventEmitter {
    removeListener(eventName, listener) {
      if (eventName === 'path_update') throw new Error('path listener cleanup failed');
      return super.removeListener(eventName, listener);
    }
  }
  const bot = new RemoveFailureBot();
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
  });
  const { logger, records } = makeLogger();

  const resultPromise = awaitGoalReached(bot, null, 1000, {
    enablePathWatchdog: false,
    logger,
  });
  bot.emit('goal_reached');
  const result = await resultPromise;

  assert.equal(result.kind, 'reached');
  assert.deepEqual(records, [
    { evt: 'path.listener-remove-error', event: 'path_update', err: 'path listener cleanup failed' },
  ]);
});

test('awaitGoalReached reports owner stop failures on path stalls', async () => {
  const bot = new EventEmitter();
  const ownerToken = { id: 'skill-token' };
  let stopCalls = 0;
  Object.assign(bot, {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    oxygenLevel: 20,
    pathfinderOwner: {
      stop(token) {
        assert.equal(token, ownerToken);
        stopCalls += 1;
        throw new Error('owner stop failed');
      },
      currentOwner: () => 'skill',
      isIdle: () => false,
    },
  });

  const result = await awaitGoalReached(bot, null, 1000, {
    ownerToken,
    pathStallMs: 10,
    watchdogIntervalMs: 5,
  });

  assert.equal(result.kind, 'stuck');
  assert.equal(stopCalls, 1);
  assert.equal(result.stopError, 'owner stop failed');
});
