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

test('awaitCollectBlock clears stale active digging before fast-digging the next block', async () => {
  const stale = { name: 'stone', position: { x: 0, y: 64, z: 1 } };
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 1, y: 64, z: 0 },
  };
  const calls = [];
  const bot = {
    targetDigBlock: stale,
    entity: {
      isInWater: false,
      onGround: true,
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    blockAt() {
      calls.push(['blockAt']);
      return target;
    },
    canDigBlock() {
      calls.push(['canDigBlock']);
      return true;
    },
    stopDigging() {
      calls.push(['stopDigging', bot.targetDigBlock?.name ?? null]);
      bot.targetDigBlock = null;
    },
    async dig(block) {
      assert.equal(block, target);
      assert.equal(bot.targetDigBlock, null);
      calls.push(['dig']);
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run after clearing stale dig');
      },
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    fastDigActiveDigClearMs: 30,
    fastDigActiveDigPollMs: 1,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.deepEqual(calls, [
    ['blockAt'],
    ['canDigBlock'],
    ['stopDigging', 'stone'],
    ['blockAt'],
    ['dig'],
  ]);
});

test('awaitCollectBlock preempts while waiting for stale active digging to clear', async () => {
  const controller = new AbortController();
  const stale = { name: 'stone', position: { x: 0, y: 64, z: 1 } };
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 1, y: 64, z: 0 },
  };
  let stopDiggingCalls = 0;
  let digCalls = 0;
  const bot = {
    targetDigBlock: stale,
    entity: {
      isInWater: false,
      onGround: true,
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    blockAt: () => target,
    canDigBlock: () => true,
    stopDigging() {
      stopDiggingCalls += 1;
    },
    async dig() {
      digCalls += 1;
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run after active dig preempt');
      },
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, controller.signal, {
    fastDigActiveDigClearMs: 500,
    fastDigActiveDigPollMs: 10,
  });
  setTimeout(() => controller.abort('test-abort'), 20);

  const result = await resultPromise;

  assert.equal(result.kind, 'preempted');
  assert.equal(digCalls, 0);
  assert.ok(stopDiggingCalls >= 1);
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
    digTime() {
      calls.push(['digTime', bot.entity.onGround]);
      return 123;
    },
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
    fastDigGroundWaitMs: 180,
    fastDigStableGroundMs: 50,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.equal(result.expectedMs, 123);
  assert.deepEqual(calls, [['digTime', true], ['dig', true]]);
});

test('awaitCollectBlock waits for jump control to clear before fast-digging', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 1, y: 64, z: 0 },
  };
  const calls = [];
  const bot = {
    entity: {
      isInWater: false,
      onGround: true,
      velocity: { y: 0 },
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    controlState: { jump: true },
    heldItem: { name: 'netherite_pickaxe', type: 742 },
    blockAt: () => target,
    canDigBlock: () => true,
    digTime() {
      calls.push(['digTime', bot.controlState.jump]);
      return 123;
    },
    async dig() {
      calls.push(['dig', bot.controlState.jump]);
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run after jump control clears');
      },
    },
  };
  setTimeout(() => {
    bot.controlState.jump = false;
  }, 20);

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    fastDigGroundWaitMs: 180,
    fastDigStableGroundMs: 50,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.equal(result.expectedMs, 123);
  assert.deepEqual(calls, [['digTime', false], ['dig', false]]);
});

test('awaitCollectBlock accepts stable on-ground state with residual downward velocity', async () => {
  const target = {
    name: 'oak_log',
    type: 17,
    position: { x: 1, y: 64, z: 0 },
  };
  const calls = [];
  const bot = {
    entity: {
      isInWater: false,
      onGround: true,
      velocity: { y: -0.0784000015258789 },
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    heldItem: null,
    blockAt: () => target,
    canDigBlock: () => true,
    digTime() {
      calls.push(['digTime', bot.entity.onGround, bot.entity.velocity.y]);
      return 650;
    },
    async dig() {
      calls.push(['dig', bot.entity.onGround, bot.entity.velocity.y]);
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run for stable residual velocity');
      },
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    fastDigGroundWaitMs: 180,
    fastDigStableGroundMs: 50,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.equal(result.expectedMs, 650);
  assert.deepEqual(calls, [
    ['digTime', true, -0.0784000015258789],
    ['dig', true, -0.0784000015258789],
  ]);
});

test('awaitCollectBlock retries fast-dig when the bot becomes airborne mid-dig', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 1, y: 64, z: 0 },
  };
  const calls = [];
  let digCalls = 0;
  let stopDiggingCalls = 0;
  let rejectActiveDig = null;
  const bot = {
    entity: {
      isInWater: false,
      onGround: true,
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    blockAt: () => target,
    canDigBlock: () => true,
    digTime() {
      calls.push(['digTime', bot.entity.onGround]);
      return 123;
    },
    dig() {
      digCalls += 1;
      calls.push(['dig', digCalls, bot.entity.onGround]);
      if (digCalls === 1) {
        return new Promise((_resolve, reject) => {
          rejectActiveDig = reject;
          setTimeout(() => {
            bot.entity.onGround = false;
          }, 5);
        });
      }
      return Promise.resolve();
    },
    stopDigging() {
      stopDiggingCalls += 1;
      calls.push(['stopDigging', stopDiggingCalls]);
      bot.entity.onGround = true;
      if (rejectActiveDig) {
        const err = new Error('Digging aborted');
        rejectActiveDig(err);
        rejectActiveDig = null;
      }
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run for reachable fast-dig retry');
      },
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    airborneDigPollMs: 1,
    airborneDigGroundWaitMs: 50,
    airborneDigStableGroundMs: 0,
    airborneDigSettleMs: 10,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.equal(result.attempts, 2);
  assert.equal(result.expectedMs, 123);
  assert.equal(stopDiggingCalls, 1);
  assert.deepEqual(calls, [
    ['digTime', true],
    ['dig', 1, true],
    ['stopDigging', 1],
    ['digTime', true],
    ['dig', 2, true],
  ]);
});

test('awaitCollectBlock refuses fast-dig if the bot never becomes grounded', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 1, y: 64, z: 0 },
  };
  const bot = {
    entity: {
      isInWater: false,
      onGround: false,
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    heldItem: { name: 'netherite_pickaxe', type: 742 },
    blockAt: () => target,
    canDigBlock: () => true,
    digTime() {
      throw new Error('digTime should not run while airborne');
    },
    async dig() {
      throw new Error('dig should not run while airborne');
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run after ground wait timeout');
      },
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    fastDigGroundWaitMs: 30,
  });

  assert.equal(result.kind, 'groundWaitTimeout');
  assert.equal(result.onGround, false);
});

test('awaitCollectBlock refuses ordinary straight-down digs before hazard scanning', async () => {
  const { bot, target, calls } = makeStraightDownDigHarness({
    below: {
      '1,62,0': block('stone', 1, 62, 0),
    },
  });

  const result = await awaitCollectBlock(bot, target, new AbortController().signal);

  assert.equal(result.kind, 'unsafeStraightDownDig');
  assert.equal(result.code, 'unsafe_straight_down_dig');
  assert.match(result.reason, /straight-down dig refused/);
  assert.deepEqual(calls, []);
});

test('awaitCollectBlock refuses an opted-in straight-down dig over lava', async () => {
  const { bot, target, calls } = makeStraightDownDigHarness({
    below: {
      '1,62,0': block('lava', 1, 62, 0, { boundingBox: 'block' }),
    },
  });

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    allowStraightDownDig: true,
  });

  assert.equal(result.kind, 'unsafeStraightDownDig');
  assert.equal(result.code, 'unsafe_straight_down_dig');
  assert.match(result.reason, /lava below target/);
  assert.deepEqual(calls, []);
});

test('awaitCollectBlock refuses an opted-in straight-down dig over a large open drop', async () => {
  const { bot, target, calls } = makeStraightDownDigHarness({
    below: {
      '1,62,0': block('air', 1, 62, 0, { boundingBox: 'empty' }),
      '1,61,0': block('cave_air', 1, 61, 0, { boundingBox: 'empty' }),
      '1,60,0': block('air', 1, 60, 0, { boundingBox: 'empty' }),
      '1,59,0': block('air', 1, 59, 0, { boundingBox: 'empty' }),
    },
  });

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    allowStraightDownDig: true,
  });

  assert.equal(result.kind, 'unsafeStraightDownDig');
  assert.match(result.reason, /open drop deeper than 3 blocks/);
  assert.deepEqual(calls, []);
});

test('awaitCollectBlock allows an opted-in straight-down dig when solid ground is below', async () => {
  const { bot, target, calls } = makeStraightDownDigHarness({
    below: {
      '1,62,0': block('stone', 1, 62, 0),
    },
  });

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    allowStraightDownDig: true,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'fastDig');
  assert.deepEqual(calls, ['dig']);
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

test('awaitCollectBlock retries path-then-dig collect when the bot becomes airborne mid-dig', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 5, y: 64, z: 0 },
  };
  const calls = [];
  let digCalls = 0;
  let stopDiggingCalls = 0;
  let rejectActiveDig = null;
  const movements = { id: 'collect-movements' };
  const bot = {
    entity: {
      isInWater: false,
      onGround: true,
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
    pathfinder: {
      goto(goal) {
        calls.push(['goto', goal.x, goal.y, goal.z]);
        return Promise.resolve();
      },
    },
    collectBlock: {
      movements,
      collect() {
        throw new Error('collectBlock plugin should not run when defensive path-then-dig is available');
      },
    },
    dig() {
      digCalls += 1;
      calls.push(['dig', digCalls, bot.entity.onGround]);
      if (digCalls === 1) {
        return new Promise((resolve, reject) => {
          rejectActiveDig = reject;
          setTimeout(() => {
            bot.entity.onGround = false;
          }, 5);
        });
      }
      return Promise.resolve();
    },
    stopDigging() {
      stopDiggingCalls += 1;
      calls.push(['stopDigging', stopDiggingCalls]);
      bot.entity.onGround = true;
      if (rejectActiveDig) {
        const err = new Error('Digging aborted');
        rejectActiveDig(err);
        rejectActiveDig = null;
      }
    },
  };

  const result = await awaitCollectBlock(bot, target, new AbortController().signal, {
    airborneDigPollMs: 1,
    airborneDigGroundWaitMs: 50,
    airborneDigStableGroundMs: 0,
    airborneDigSettleMs: 10,
  });

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'collectBlockManual');
  assert.equal(result.attempts, 2);
  assert.equal(digCalls, 2);
  assert.equal(stopDiggingCalls, 1);
  assert.deepEqual(calls, [
    ['blockAt'],
    ['blockAt'],
    ['goto', 5, 64, 0],
    ['blockAt'],
    ['canDigBlock'],
    ['dig', 1, true],
    ['stopDigging', 1],
    ['dig', 2, true],
  ]);
});

test('awaitCollectBlock waits for grounded state before defensive dig setup', async () => {
  const target = {
    name: 'diamond_ore',
    type: 56,
    position: { x: 5, y: 64, z: 0 },
  };
  const calls = [];
  const movements = { id: 'collect-movements' };
  const bot = {
    entity: {
      isInWater: false,
      onGround: false,
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
    pathfinder: {
      goto(goal) {
        calls.push(['goto', goal.x, goal.y, goal.z]);
        return Promise.resolve();
      },
    },
    tool: {
      async equipForBlock() {
        calls.push(['equipForBlock', bot.entity.onGround]);
      },
    },
    collectBlock: {
      movements,
      collect() {
        throw new Error('collectBlock plugin should not run when defensive path-then-dig is available');
      },
    },
    async dig() {
      calls.push(['dig', bot.entity.onGround]);
    },
  };

  const resultPromise = awaitCollectBlock(bot, target, new AbortController().signal, {
    defensiveDigGroundWaitMs: 220,
    airborneDigGroundWaitMs: 220,
    airborneDigStableGroundMs: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(calls.some((call) => call[0] === 'equipForBlock'), false);
  assert.equal(calls.some((call) => call[0] === 'dig'), false);

  bot.entity.onGround = true;
  const result = await resultPromise;

  assert.equal(result.kind, 'completed');
  assert.equal(result.mode, 'collectBlockManual');
  assert.deepEqual(calls.slice(-2), [
    ['equipForBlock', true],
    ['dig', true],
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

function makeStraightDownDigHarness({ below = {} } = {}) {
  const target = block('stone', 1, 63, 0);
  const blocks = new Map([
    ['1,63,0', target],
    ...Object.entries(below),
  ]);
  const calls = [];
  const bot = {
    entity: {
      isInWater: false,
      onGround: true,
      position: { x: 1.2, y: 64, z: 0.4 },
    },
    heldItem: { name: 'stone_pickaxe', type: 603 },
    blockAt(position) {
      if (position.y < target.position.y) assert.equal(typeof position.floored, 'function');
      return blocks.get(`${position.x},${position.y},${position.z}`) || null;
    },
    canDigBlock: () => true,
    async dig() {
      calls.push('dig');
    },
    collectBlock: {
      collect() {
        throw new Error('collectBlock path should not run for reachable straight-down test blocks');
      },
    },
  };
  return { bot, target, calls };
}

function block(name, x, y, z, opts = {}) {
  return {
    name,
    type: opts.type ?? 1,
    boundingBox: opts.boundingBox ?? 'block',
    position: { x, y, z },
  };
}
