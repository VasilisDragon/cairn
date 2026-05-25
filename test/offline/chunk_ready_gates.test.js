import test from 'node:test';
import assert from 'node:assert/strict';

import { run as runCollect } from '../../src/skills/collect.js';
import { run as runCraft } from '../../src/skills/craft.js';
import { run as runDeposit } from '../../src/skills/deposit.js';
import { run as runGoto } from '../../src/skills/goto.js';
import { run as runBuildFromSchematic } from '../../src/skills/build_from_schematic.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeBaseBot(chunksReady) {
  return {
    chunksReady,
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    registry: {
      blocksByName: {
        oak_log: { id: 1 },
        chest: { id: 2 },
        trapped_chest: { id: 3 },
        crafting_table: { id: 4 },
      },
      itemsByName: {
        oak_log: { id: 1 },
        oak_planks: { id: 5 },
      },
    },
  };
}

async function assertWaitsForChunks({ makeBot, runSkill, operationName }) {
  const gate = deferred();
  const bot = makeBot(gate.promise);
  let operationCalls = 0;
  bot[operationName] = (..._args) => {
    operationCalls++;
    return operationName === 'findBlocks' ? [] : null;
  };

  const ctx = { signal: new AbortController().signal, callState: {} };
  const running = runSkill(bot, ctx);
  await Promise.resolve();

  assert.equal(operationCalls, 0, `${operationName} ran before chunksReady resolved`);

  gate.resolve();
  const result = await running;

  assert.equal(operationCalls, 1, `${operationName} should run after chunksReady resolves`);
  assert.equal(result.ok, false);
}

async function assertAbortableChunkWait({ makeBot, runSkill, operationName }) {
  const gate = deferred();
  const bot = makeBot(gate.promise);
  let operationCalls = 0;
  bot[operationName] = (..._args) => {
    operationCalls++;
    return operationName === 'findBlocks' ? [] : null;
  };
  const controller = new AbortController();
  const ctx = { signal: controller.signal, callState: {} };
  const running = runSkill(bot, ctx);
  await Promise.resolve();

  controller.abort('reactive-preempt');
  const result = await running;

  assert.equal(operationCalls, 0, `${operationName} ran after abort while chunksReady was pending`);
  assert.equal(result.preempted, true);
  assert.match(result.reason, /chunk/i);
}

async function assertFailsBeforeChunks({ runSkill, expectedReason }) {
  const gate = deferred();
  const bot = makeBaseBot(gate.promise);
  let findBlocksCalls = 0;
  let recipesForCalls = 0;
  bot.findBlocks = () => {
    findBlocksCalls++;
    return [];
  };
  bot.recipesFor = () => {
    recipesForCalls++;
    return [];
  };

  const pending = Symbol('pending');
  const running = runSkill(bot, { signal: new AbortController().signal, callState: {} });
  const result = await Promise.race([
    running,
    new Promise((resolve) => setImmediate(() => resolve(pending))),
  ]);
  if (result === pending) {
    gate.resolve();
    await running;
    assert.fail('skill waited for chunksReady before validating registry target');
  }

  assert.equal(findBlocksCalls, 0);
  assert.equal(recipesForCalls, 0);
  assert.equal(result.ok, false);
  assert.match(result.reason, expectedReason);
}

test('collect unknown block fails before pending chunksReady', async () => {
  await assertFailsBeforeChunks({
    expectedReason: /unknown block "not_a_block"/,
    runSkill: (bot, ctx) => runCollect(bot, { block: 'not_a_block', count: 1, maxDistance: 16 }, ctx),
  });
});

test('goto unknown block fails before pending chunksReady', async () => {
  await assertFailsBeforeChunks({
    expectedReason: /unknown block "not_a_block"/,
    runSkill: (bot, ctx) => runGoto(bot, { block: 'not_a_block', maxDistance: 16 }, ctx),
  });
});

test('craft unknown item fails before pending chunksReady', async () => {
  await assertFailsBeforeChunks({
    expectedReason: /unknown item "not_an_item"/,
    runSkill: (bot, ctx) => runCraft(bot, { item: 'not_an_item', count: 1 }, ctx),
  });
});

test('deposit unknown item fails before pending chunksReady', async () => {
  await assertFailsBeforeChunks({
    expectedReason: /unknown item "not_an_item"/,
    runSkill: (bot, ctx) => runDeposit(bot, { items: [{ name: 'not_an_item', count: 1 }], maxDistance: 16 }, ctx),
  });
});

test('collect waits for chunksReady before findBlocks', async () => {
  await assertWaitsForChunks({
    operationName: 'findBlocks',
    makeBot: (chunksReady) => makeBaseBot(chunksReady),
    runSkill: (bot, ctx) => runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, ctx),
  });
});

test('collect chunk wait is abortable before findBlocks', async () => {
  await assertAbortableChunkWait({
    operationName: 'findBlocks',
    makeBot: (chunksReady) => makeBaseBot(chunksReady),
    runSkill: (bot, ctx) => runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, ctx),
  });
});

test('goto block waits for chunksReady before findBlocks', async () => {
  await assertWaitsForChunks({
    operationName: 'findBlocks',
    makeBot: (chunksReady) => makeBaseBot(chunksReady),
    runSkill: (bot, ctx) => runGoto(bot, { block: 'oak_log', maxDistance: 16 }, ctx),
  });
});

test('goto block chunk wait is abortable before findBlocks', async () => {
  await assertAbortableChunkWait({
    operationName: 'findBlocks',
    makeBot: (chunksReady) => makeBaseBot(chunksReady),
    runSkill: (bot, ctx) => runGoto(bot, { block: 'oak_log', maxDistance: 16 }, ctx),
  });
});

test('deposit waits for chunksReady before chest scan', async () => {
  await assertWaitsForChunks({
    operationName: 'findBlocks',
    makeBot: (chunksReady) => makeBaseBot(chunksReady),
    runSkill: (bot, ctx) => runDeposit(bot, { items: [{ name: 'oak_log' }], maxDistance: 16 }, ctx),
  });
});

test('deposit chunk wait is abortable before chest scan', async () => {
  await assertAbortableChunkWait({
    operationName: 'findBlocks',
    makeBot: (chunksReady) => makeBaseBot(chunksReady),
    runSkill: (bot, ctx) => runDeposit(bot, { items: [{ name: 'oak_log' }], maxDistance: 16 }, ctx),
  });
});

test('craft waits for chunksReady before recipe lookup', async () => {
  const gate = deferred();
  const bot = makeBaseBot(gate.promise);
  let recipesForCalls = 0;
  let findBlockCalls = 0;
  bot.recipesFor = () => {
    recipesForCalls++;
    return [];
  };
  bot.findBlock = () => {
    findBlockCalls++;
    return null;
  };

  const ctx = { signal: new AbortController().signal, callState: {} };
  const running = runCraft(bot, { item: 'oak_planks', count: 1 }, ctx);
  await Promise.resolve();

  assert.equal(recipesForCalls, 0);
  assert.equal(findBlockCalls, 0);

  gate.resolve();
  const result = await running;

  assert.equal(recipesForCalls, 1);
  assert.equal(findBlockCalls, 1);
  assert.equal(result.ok, false);
});

test('craft chunk wait is abortable before recipe lookup', async () => {
  const gate = deferred();
  const bot = makeBaseBot(gate.promise);
  let recipesForCalls = 0;
  let findBlockCalls = 0;
  bot.recipesFor = () => {
    recipesForCalls++;
    return [];
  };
  bot.findBlock = () => {
    findBlockCalls++;
    return null;
  };
  const controller = new AbortController();
  const ctx = { signal: controller.signal, callState: {} };
  const running = runCraft(bot, { item: 'oak_planks', count: 1 }, ctx);
  await Promise.resolve();

  controller.abort('reactive-preempt');
  const result = await running;

  assert.equal(recipesForCalls, 0);
  assert.equal(findBlockCalls, 0);
  assert.equal(result.preempted, true);
  assert.match(result.reason, /chunk/i);
});

test('build_from_schematic chunk wait is abortable before dry-run world reads', async () => {
  const gate = deferred();
  const bot = makeBaseBot(gate.promise);
  let blockAtCalls = 0;
  bot.blockAt = () => {
    blockAtCalls++;
    return { name: 'air' };
  };
  const controller = new AbortController();
  const ctx = { signal: controller.signal, callState: {} };
  const running = runBuildFromSchematic(bot, {
    dryRun: true,
    anchor: { x: 0, y: 64, z: 0 },
    blocks: [{ offset: { x: 0, y: 0, z: 0 }, block: 'oak_planks' }],
    inventory: { oak_planks: 1 },
  }, ctx);
  await Promise.resolve();

  controller.abort('reactive-preempt');
  const result = await running;

  assert.equal(blockAtCalls, 0);
  assert.equal(result.preempted, true);
  assert.match(result.reason, /chunk/i);
});

test('world-querying skills report chunksReady getter failures before world queries', async () => {
  const cases = [
    {
      name: 'collect',
      operationName: 'findBlocks',
      runSkill: (bot, ctx) => runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, ctx),
      expectedReason: /chunk data unavailable during collect: chunksReady bus unavailable/,
    },
    {
      name: 'goto',
      operationName: 'findBlocks',
      runSkill: (bot, ctx) => runGoto(bot, { block: 'oak_log', maxDistance: 16 }, ctx),
      expectedReason: /chunk data unavailable during goto: chunksReady bus unavailable/,
    },
    {
      name: 'deposit',
      operationName: 'findBlocks',
      runSkill: (bot, ctx) => runDeposit(bot, { items: [{ name: 'oak_log' }], maxDistance: 16 }, ctx),
      expectedReason: /chunk data unavailable during deposit: chunksReady bus unavailable/,
    },
    {
      name: 'craft',
      operationName: 'recipesFor',
      runSkill: (bot, ctx) => runCraft(bot, { item: 'oak_planks', count: 1 }, ctx),
      expectedReason: /chunk data unavailable during craft: chunksReady bus unavailable/,
    },
    {
      name: 'build',
      operationName: 'blockAt',
      runSkill: (bot, ctx) => runBuildFromSchematic(bot, {
        dryRun: true,
        anchor: { x: 0, y: 64, z: 0 },
        blocks: [{ offset: { x: 0, y: 0, z: 0 }, block: 'oak_planks' }],
        inventory: { oak_planks: 1 },
      }, ctx),
      expectedReason: /chunk data unavailable during build dry-run: chunksReady bus unavailable/,
    },
  ];

  for (const testCase of cases) {
    const bot = makeBaseBot(Promise.resolve());
    Object.defineProperty(bot, 'chunksReady', {
      configurable: true,
      get() {
        throw new Error('chunksReady bus unavailable');
      },
    });
    let operationCalls = 0;
    bot[testCase.operationName] = () => {
      operationCalls += 1;
      throw new Error(`${testCase.name} should not query world after chunk getter failure`);
    };

    const result = await testCase.runSkill(bot, { signal: new AbortController().signal, callState: {} });

    assert.equal(result.ok, false, testCase.name);
    assert.match(result.reason, testCase.expectedReason, testCase.name);
    assert.equal(operationCalls, 0, testCase.name);
  }
});
