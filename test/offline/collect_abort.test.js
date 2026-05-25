import test from 'node:test';
import assert from 'node:assert/strict';

import { awaitCollectBlock } from '../../src/skills/_pathing.js';

function makeLogger() {
  const records = [];
  return {
    logger: {
      warn(evt, fields = {}) { records.push({ evt, ...fields }); },
    },
    records,
  };
}

test('awaitCollectBlock routes collection start through humanizer when installed', async () => {
  const target = { name: 'oak_log', position: { x: 2, y: 64, z: 0 } };
  const calls = [];
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect(block, opts) {
        calls.push(['raw', block.name, opts.ignoreNoPath]);
        return Promise.resolve();
      },
    },
    humanizer: {
      collectBlock(targetBot, block, opts, humanizeOpts = {}) {
        calls.push(['humanized', humanizeOpts.reason, block.name, opts.ignoreNoPath]);
        return humanizeOpts.apply();
      },
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal);

  assert.equal(result.kind, 'completed');
  assert.deepEqual(calls, [
    ['humanized', 'collectBlock.collect', 'oak_log', true],
    ['raw', 'oak_log', true],
  ]);
});

test('awaitCollectBlock fast-digs a reachable safe block before collectBlock pathing', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 1, y: 64, z: 0 },
    canHarvest: (heldType) => heldType === 742,
  };
  const calls = [];
  const bot = {
    entity: {
      isInWater: false,
      onGround: true,
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    heldItem: { name: 'netherite_pickaxe', type: 742 },
    blockAt(pos) {
      assert.equal(pos, target.position);
      calls.push(['blockAt']);
      return target;
    },
    canDigBlock(block) {
      assert.equal(block, target);
      calls.push(['canDigBlock']);
      return true;
    },
    pathfinder: {
      movements: {
        safeToBreak(block) {
          assert.equal(block, target);
          calls.push(['safeToBreak']);
          return true;
        },
      },
    },
    tool: {
      async equipForBlock(block, opts) {
        assert.equal(block, target);
        calls.push(['equipForBlock', opts.getFromChest, opts.requireHarvest]);
      },
    },
    async dig(block) {
      assert.equal(block, target);
      calls.push(['dig']);
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run for reachable blocks');
      },
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal);

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.deepEqual(calls, [
    ['blockAt'],
    ['canDigBlock'],
    ['safeToBreak'],
    ['equipForBlock', false, true],
    ['blockAt'],
    ['dig'],
  ]);
});

test('awaitCollectBlock waits for the bot to land before fast-digging', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 1, y: 64, z: 0 },
  };
  const calls = [];
  const bot = {
    entity: {
      isInWater: false,
      onGround: false,
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    heldItem: { name: 'netherite_pickaxe', type: 742 },
    blockAt: () => target,
    canDigBlock: () => true,
    async dig() {
      calls.push(['dig', bot.entity.onGround]);
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run after landing');
      },
    },
  };
  setTimeout(() => {
    bot.entity.onGround = true;
  }, 10);

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    fastDigGroundWaitMs: 60,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.deepEqual(calls, [['dig', true]]);
});

test('awaitCollectBlock falls back to collectBlock when a target is outside pickup range', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 5, y: 64, z: 0 },
  };
  const calls = [];
  const bot = {
    entity: {
      isInWater: false,
      position: { x: 0, y: 64, z: 0 },
    },
    blockAt() {
      calls.push(['blockAt']);
      return target;
    },
    canDigBlock() {
      calls.push(['canDigBlock']);
      return true;
    },
    collectBlock: {
      collect(block, opts) {
        calls.push(['collectBlock', block.name, opts.ignoreNoPath]);
        return Promise.resolve();
      },
    },
    dig() {
      throw new Error('dig should not run outside pickup range');
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal);

  assert.deepEqual(result, { kind: 'completed' });
  assert.deepEqual(calls, [
    ['blockAt'],
    ['collectBlock', 'diamond_ore', true],
  ]);
});

test('awaitCollectBlock calls stopDigging immediately and polls after abort', async () => {
  const controller = new AbortController();
  const target = { name: 'oak_log' };
  let rejectCollect;
  let stopDiggingCalls = 0;
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: () => new Promise((resolve, reject) => {
        rejectCollect = reject;
      }),
    },
    stopDigging: () => {
      stopDiggingCalls++;
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, controller.signal);
  await Promise.resolve();
  await Promise.resolve();

  controller.abort('test-abort');
  assert.equal(stopDiggingCalls, 1);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(stopDiggingCalls >= 2, `expected polling stopDigging calls, got ${stopDiggingCalls}`);

  const err = new Error('stopped');
  err.name = 'PathStopped';
  rejectCollect(err);

  const result = await resultPromise;
  assert.deepEqual(result, { kind: 'preempted' });
});

test('awaitCollectBlock stops the owned path on non-reactive abort', async () => {
  const controller = new AbortController();
  const target = { name: 'oak_log' };
  const ownerToken = { id: 'collect-owner' };
  let rejectCollect;
  let ownerStopCalls = 0;
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: () => new Promise((_resolve, reject) => {
        rejectCollect = reject;
      }),
    },
    stopDigging() {},
    pathfinderOwner: {
      stop(token) {
        assert.equal(token, ownerToken);
        ownerStopCalls++;
      },
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, controller.signal, { ownerToken });
  await Promise.resolve();
  await Promise.resolve();

  controller.abort('skill timed out');
  const err = new Error('stopped');
  err.name = 'PathStopped';
  rejectCollect(err);

  const result = await resultPromise;
  assert.deepEqual(result, { kind: 'preempted' });
  assert.equal(ownerStopCalls, 1);
});

test('awaitCollectBlock does not duplicate reactive-preempt path stops', async () => {
  const controller = new AbortController();
  const target = { name: 'oak_log' };
  const ownerToken = { id: 'collect-owner' };
  let rejectCollect;
  let ownerStopCalls = 0;
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: () => new Promise((_resolve, reject) => {
        rejectCollect = reject;
      }),
    },
    stopDigging() {},
    pathfinderOwner: {
      stop() {
        ownerStopCalls++;
      },
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, controller.signal, { ownerToken });
  await Promise.resolve();
  await Promise.resolve();

  controller.abort('reactive-preempt');
  const err = new Error('stopped');
  err.name = 'PathStopped';
  rejectCollect(err);

  const result = await resultPromise;
  assert.deepEqual(result, { kind: 'preempted' });
  assert.equal(ownerStopCalls, 0);
});

test('awaitCollectBlock reports dry-land path stalls while collectBlock is hung', async () => {
  const controller = new AbortController();
  const target = { name: 'oak_log' };
  const ownerToken = { id: 'collect-owner' };
  let rejectCollect;
  let stopDiggingCalls = 0;
  let ownerStopCalls = 0;
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: () => new Promise((_resolve, reject) => {
        rejectCollect = reject;
      }),
    },
    stopDigging: () => {
      stopDiggingCalls++;
    },
    pathfinderOwner: {
      currentOwner: () => 'skill',
      isIdle: () => false,
      stop(token) {
        assert.equal(token, ownerToken);
        ownerStopCalls++;
      },
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, controller.signal, {
    ownerToken,
    pathStallMs: 20,
    watchdogIntervalMs: 5,
  });
  const cleanupTimeout = { kind: 'cleanupTimeout' };
  let cleanupTimer = null;
  const cleanupPromise = new Promise((resolve) => {
    cleanupTimer = setTimeout(() => {
      controller.abort('test-cleanup');
      const err = new Error('cleanup stop');
      err.name = 'PathStopped';
      rejectCollect(err);
      resolve(cleanupTimeout);
    }, 80);
  });
  const result = await Promise.race([
    resultPromise,
    cleanupPromise,
  ]);
  if (result === cleanupTimeout) await resultPromise;
  else clearTimeout(cleanupTimer);

  assert.equal(result.kind, 'stuck');
  assert.equal(ownerStopCalls, 1);
  assert.equal(stopDiggingCalls, 1);
});

test('awaitCollectBlock reports owner stop failures on dry-land path stalls', async () => {
  const controller = new AbortController();
  const target = { name: 'oak_log' };
  const ownerToken = { id: 'collect-owner' };
  let rejectCollect;
  let stopDiggingCalls = 0;
  let ownerStopCalls = 0;
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: () => new Promise((_resolve, reject) => {
        rejectCollect = reject;
      }),
    },
    stopDigging: () => {
      stopDiggingCalls++;
    },
    pathfinderOwner: {
      currentOwner: () => 'skill',
      isIdle: () => false,
      stop(token) {
        assert.equal(token, ownerToken);
        ownerStopCalls++;
        throw new Error('owner stop failed');
      },
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, controller.signal, {
    ownerToken,
    pathStallMs: 20,
    watchdogIntervalMs: 5,
  });
  const cleanupTimeout = { kind: 'cleanupTimeout' };
  let cleanupTimer = null;
  const cleanupPromise = new Promise((resolve) => {
    cleanupTimer = setTimeout(() => {
      controller.abort('test-cleanup');
      const err = new Error('cleanup stop');
      err.name = 'PathStopped';
      rejectCollect(err);
      resolve(cleanupTimeout);
    }, 80);
  });
  const result = await Promise.race([
    resultPromise,
    cleanupPromise,
  ]);
  if (result === cleanupTimeout) await resultPromise;
  else clearTimeout(cleanupTimer);

  assert.equal(result.kind, 'stuck');
  assert.equal(result.stopError, 'owner stop failed');
  assert.equal(ownerStopCalls, 1);
  assert.equal(stopDiggingCalls, 1);
});

test('awaitCollectBlock reports stopDigging failures on dry-land path stalls', async () => {
  const controller = new AbortController();
  const target = { name: 'oak_log' };
  const ownerToken = { id: 'collect-owner' };
  let rejectCollect;
  let stopDiggingCalls = 0;
  let ownerStopCalls = 0;
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: () => new Promise((_resolve, reject) => {
        rejectCollect = reject;
      }),
    },
    stopDigging: () => {
      stopDiggingCalls++;
      throw new Error('dig stop failed');
    },
    pathfinderOwner: {
      currentOwner: () => 'skill',
      isIdle: () => false,
      stop(token) {
        assert.equal(token, ownerToken);
        ownerStopCalls++;
      },
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, controller.signal, {
    ownerToken,
    pathStallMs: 20,
    watchdogIntervalMs: 5,
  });
  const cleanupTimeout = { kind: 'cleanupTimeout' };
  let cleanupTimer = null;
  const cleanupPromise = new Promise((resolve) => {
    cleanupTimer = setTimeout(() => {
      controller.abort('test-cleanup');
      const err = new Error('cleanup stop');
      err.name = 'PathStopped';
      rejectCollect(err);
      resolve(cleanupTimeout);
    }, 80);
  });
  const result = await Promise.race([
    resultPromise,
    cleanupPromise,
  ]);
  if (result === cleanupTimeout) await resultPromise;
  else clearTimeout(cleanupTimer);

  assert.equal(result.kind, 'stuck');
  assert.equal(result.digStopError, 'dig stop failed');
  assert.equal(ownerStopCalls, 1);
  assert.equal(stopDiggingCalls, 1);
});

test('awaitCollectBlock reports synchronous collectBlock failures', async () => {
  const controller = new AbortController();
  const target = { name: 'oak_log' };
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: () => {
        throw new Error('collect plugin unavailable');
      },
    },
    stopDigging() {},
  };

  const result = await awaitCollectBlock(bot, target, controller.signal);

  assert.equal(result.kind, 'error');
  assert.equal(result.err.message, 'collect plugin unavailable');
});

test('awaitCollectBlock reports abort listener registration failures before collecting', async () => {
  const target = { name: 'oak_log' };
  let collectCalls = 0;
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: async () => {
        collectCalls += 1;
      },
    },
    stopDigging() {},
  };
  const signal = {
    aborted: false,
    addEventListener() {
      throw new Error('abort listener unavailable');
    },
    removeEventListener() {},
  };

  const result = await awaitCollectBlock(bot, target, signal);

  assert.equal(result.kind, 'error');
  assert.equal(result.err.message, 'abort listener unavailable');
  assert.equal(collectCalls, 0);
});

test('awaitCollectBlock logs abort listener cleanup failures after collecting', async () => {
  const target = { name: 'oak_log' };
  const bot = {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    collectBlock: {
      collect: async () => {},
    },
    stopDigging() {},
  };
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      throw new Error('abort listener cleanup failed');
    },
  };
  const { logger, records } = makeLogger();

  const result = await awaitCollectBlock(bot, target, signal, { logger });

  assert.equal(result.kind, 'completed');
  assert.deepEqual(records, [
    { evt: 'collect.abort-listener-remove-error', err: 'abort listener cleanup failed' },
  ]);
});
