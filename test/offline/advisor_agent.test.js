import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AdvisorAgent } from '../../src/advisor/agent.js';

function makeBot() {
  return {
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: () => 0 },
      velocity: { y: 0 },
      onGround: true,
      isInWater: false,
    },
    entities: {},
    inventory: { items: () => [] },
    health: 20,
    food: 20,
    foodSaturation: 5,
    time: { timeOfDay: 6000 },
    game: { dimension: 'overworld' },
    pathfinderOwner: {
      currentOwner: () => null,
      isIdle: () => true,
    },
  };
}

function safeSnapshot(overrides = {}) {
  return {
    position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
    health: 20,
    food: 20,
    reactiveState: 'NORMAL',
    currentSkill: null,
    queueLength: 0,
    pathfinder: { owner: null, idle: true },
    hazardFlags: {
      inWater: false,
      oxygenLow: false,
      falling: false,
      usingHeldItem: false,
      autoEatEating: false,
    },
    nearbyHostiles: [],
    ...overrides,
  };
}

class FakeExecutor extends EventEmitter {
  constructor(runImpl = async () => {}) {
    super();
    this.queue = [];
    this.clears = 0;
    this.enqueued = [];
    this.replacements = [];
    this.runCalls = 0;
    this.runImpl = runImpl;
  }

  clear() {
    this.clears += 1;
    this.queue = [];
  }

  enqueue(plan) {
    this.enqueued.push(plan);
    this.queue = [...plan];
  }

  requestQueueReplacement(calls, meta = {}) {
    this.replacements.push({ calls, meta });
    this.queue = [...calls];
    return { ok: true, count: calls.length };
  }

  async runUntilDone() {
    this.runCalls += 1;
    await this.runImpl(this);
  }
}

test('advisor default snapshot construction preserves no-context behavior', async () => {
  const contexts = [];
  const call = { skill: 'observe', params: {} };
  const executor = new FakeExecutor();
  const agent = new AdvisorAgent(makeBot(), executor, {
    buildSnapshot: (_bot, ctx) => {
      contexts.push(ctx);
      return safeSnapshot();
    },
    plan: async () => ({ ok: true, plan: [call] }),
  });

  const { value: result } = await captureLogRecords(() => agent.pursue('observe'));

  assert.equal(result.ok, true);
  assert.deepEqual(contexts, [undefined, undefined]);
  assert.deepEqual(executor.enqueued, [[call]]);
});

test('advisor can opt into runtime snapshot context for future world-model summaries', async () => {
  const contexts = [];
  let plannedFromSnapshot = null;
  const snapshotContext = {
    worldModelSummary: {
      knownStorage: [{ name: 'chest', position: { x: 8, y: 64, z: 0 } }],
      visitedAreaCount: 1,
    },
  };
  const call = { skill: 'observe', params: {} };
  const executor = new FakeExecutor();
  const agent = new AdvisorAgent(makeBot(), executor, {
    snapshotContext,
    buildSnapshot: (_bot, ctx) => {
      contexts.push(ctx);
      return safeSnapshot({ worldModel: ctx.worldModelSummary });
    },
    plan: async (_goal, snapshot) => {
      plannedFromSnapshot = snapshot;
      return { ok: true, plan: [call] };
    },
  });

  const { value: result } = await captureLogRecords(() => agent.pursue('observe known storage'));

  assert.equal(result.ok, true);
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every((ctx) => ctx === snapshotContext));
  assert.deepEqual(plannedFromSnapshot.worldModel.knownStorage, [
    { name: 'chest', position: { x: 8, y: 64, z: 0 } },
  ]);
  assert.deepEqual(executor.enqueued, [[call]]);
});

test('advisor snapshot context provider runs at each planning boundary', async () => {
  const contexts = [];
  const call = { skill: 'observe', params: {} };
  const executor = new FakeExecutor();
  const agent = new AdvisorAgent(makeBot(), executor, {
    snapshotContextProvider: ({ executor: currentExecutor }) => ({
      provider: 'test',
      queueLength: currentExecutor.queue.length,
    }),
    buildSnapshot: (_bot, ctx) => {
      contexts.push(ctx);
      return safeSnapshot({ queueLength: ctx.queueLength });
    },
    plan: async () => ({ ok: true, plan: [call] }),
  });

  const { value: result } = await captureLogRecords(() => agent.pursue('observe'));

  assert.equal(result.ok, true);
  assert.deepEqual(contexts, [
    { provider: 'test', queueLength: 0 },
    { provider: 'test', queueLength: 0 },
  ]);
});

class QueueFailureListenerErrorExecutor extends FakeExecutor {
  on(eventName, listener) {
    if (eventName === 'queue:failure') {
      throw new Error('queue failure bus unavailable');
    }
    return super.on(eventName, listener);
  }
}

class QueueFailureCleanupErrorExecutor extends FakeExecutor {
  removeListener(eventName, listener) {
    if (eventName === 'queue:failure') {
      throw new Error('queue failure cleanup unavailable');
    }
    return super.removeListener(eventName, listener);
  }
}

async function captureLogRecords(fn) {
  const records = [];
  function recordChunk(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
  }
  const originalStdoutWrite = process.stdout.write;
  const originalWrite = process.stderr.write;
  process.stdout.write = function write(chunk, ...args) {
    recordChunk(chunk);
    return originalStdoutWrite.call(process.stdout, chunk, ...args);
  };
  process.stderr.write = function write(chunk, ...args) {
    recordChunk(chunk);
    return originalWrite.call(process.stderr, chunk, ...args);
  };
  try {
    return { value: await fn(), records };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalWrite;
  }
}

test('advisor turns initial planner exceptions into structured failures', async () => {
  const executor = new FakeExecutor();
  const agent = new AdvisorAgent(makeBot(), executor, {
    plan: async () => {
      throw new Error('planner transport failed');
    },
  });

  const { value: result, records } = await captureLogRecords(() => agent.pursue('gather logs'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'initial plan threw: planner transport failed');
  assert.equal(executor.clears, 0);
  assert.equal(executor.enqueued.length, 0);
  assert.equal(executor.runCalls, 0);
  assert.ok(records.some((record) => (
    record.loop === 'advisor'
    && record.evt === 'goal.plan-error'
    && record.err === 'planner transport failed'
  )));
});

test('advisor reports queue failure listener registration failures without running executor', async () => {
  const call = { skill: 'collect', params: { block: 'oak_log', count: 1 } };
  const executor = new QueueFailureListenerErrorExecutor();
  const agent = new AdvisorAgent(makeBot(), executor, {
    plan: async () => ({ ok: true, plan: [call] }),
  });

  const { value: result, records } = await captureLogRecords(() => agent.pursue('gather logs'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'queue failure listener unavailable: queue failure bus unavailable');
  assert.equal(executor.clears, 2);
  assert.equal(executor.queue.length, 0);
  assert.equal(executor.enqueued.length, 1);
  assert.equal(executor.runCalls, 0);
  assert.ok(records.some((record) => (
    record.loop === 'advisor'
    && record.evt === 'goal.queue-listener-error'
    && record.err === 'queue failure bus unavailable'
  )));
});

test('advisor rejects unsafe normal plans before enqueueing', async () => {
  const bot = makeBot();
  bot.health = 6;
  const executor = new FakeExecutor();
  const agent = new AdvisorAgent(bot, executor, {
    plan: async () => ({ ok: true, plan: [{ skill: 'collect', params: { block: 'oak_log', count: 1 } }] }),
  });

  const { value: result, records } = await captureLogRecords(() => agent.pursue('gather logs'));

  assert.equal(result.ok, false);
  assert.match(result.reason, /plan activation rejected: unsafe snapshot permits only observe\/flee\/logout\/consume/);
  assert.equal(result.activation.badIndex, 0);
  assert.deepEqual(result.activation.safetyReasons, ['low health 6']);
  assert.equal(executor.clears, 0);
  assert.equal(executor.enqueued.length, 0);
  assert.equal(executor.runCalls, 0);
  assert.ok(records.some((record) => (
    record.loop === 'advisor'
    && record.evt === 'goal.plan-activation-rejected'
    && /rejected collect/.test(record.reason)
  )));
});

test('advisor allows survival plans on unsafe snapshots before enqueueing', async () => {
  const bot = makeBot();
  bot.health = 6;
  const call = { skill: 'consume', params: { item: 'golden_apple' } };
  const executor = new FakeExecutor();
  const agent = new AdvisorAgent(bot, executor, {
    plan: async () => ({ ok: true, plan: [call] }),
  });

  const { value: result } = await captureLogRecords(() => agent.pursue('recover health'));

  assert.equal(result.ok, true);
  assert.equal(executor.clears, 1);
  assert.deepEqual(executor.enqueued, [[call]]);
  assert.equal(executor.runCalls, 1);
});

test('advisor rejects stale plans before enqueueing', async () => {
  const bot = makeBot();
  const call = { skill: 'collect', params: { block: 'oak_log', count: 1 } };
  const executor = new FakeExecutor();
  const agent = new AdvisorAgent(bot, executor, {
    plan: async () => {
      bot.entity.position.x = 5;
      return { ok: true, plan: [call] };
    },
  });

  const { value: result } = await captureLogRecords(() => agent.pursue('gather logs'));

  assert.equal(result.ok, false);
  assert.match(result.reason, /plan activation rejected: stale plan activation/);
  assert.deepEqual(result.activation.staleReasons, ['position drift 5 > 2']);
  assert.equal(executor.clears, 0);
  assert.equal(executor.enqueued.length, 0);
  assert.equal(executor.runCalls, 0);
});

test('advisor reports queue failure listener cleanup failures', async () => {
  const call = { skill: 'collect', params: { block: 'oak_log', count: 1 } };
  const executor = new QueueFailureCleanupErrorExecutor();
  const agent = new AdvisorAgent(makeBot(), executor, {
    plan: async () => ({ ok: true, plan: [call] }),
  });

  const { value: result, records } = await captureLogRecords(() => agent.pursue('gather logs'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'queue failure listener cleanup failed: queue failure cleanup unavailable');
  assert.equal(executor.clears, 1);
  assert.equal(executor.enqueued.length, 1);
  assert.equal(executor.runCalls, 1);
  assert.ok(records.some((record) => (
    record.loop === 'advisor'
    && record.evt === 'goal.queue-listener-remove-error'
    && record.err === 'queue failure cleanup unavailable'
  )));
});

test('advisor turns replan exceptions into structured failures after queue failure', async () => {
  const failingCall = { skill: 'collect', params: { block: 'oak_log', count: 1 } };
  const executor = new FakeExecutor(async (self) => {
    self.emit('queue:failure', {
      call: failingCall,
      result: { ok: false, reason: 'collect failed' },
    });
  });
  let replanFailure = null;

  const agent = new AdvisorAgent(makeBot(), executor, {
    plan: async () => ({ ok: true, plan: [failingCall] }),
    replan: async (_goal, _snapshot, failure, _remaining) => {
      replanFailure = failure;
      throw new Error('planner unavailable during replan');
    },
  });

  const { value: result, records } = await captureLogRecords(() => agent.pursue('gather logs'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'replan threw: planner unavailable during replan');
  assert.equal(agent.replans, 1);
  assert.equal(executor.clears, 1);
  assert.equal(executor.enqueued.length, 1);
  assert.equal(executor.runCalls, 1);
  assert.deepEqual(replanFailure, {
    skill: 'collect',
    params: { block: 'oak_log', count: 1 },
    reason: 'collect failed',
  });
  assert.ok(records.some((record) => (
    record.loop === 'advisor'
    && record.evt === 'goal.replan-error'
    && record.err === 'planner unavailable during replan'
    && record.attempt === 1
  )));
});

test('advisor requests logout after current skill when advisor budget is exhausted', async () => {
  const call = { skill: 'observe', params: {} };
  const exhaustedCost = {
    callCount: 1,
    sessionCostUsd: 2,
    maxUsd: 2,
    ratio: 1,
    status: 'hard_logout',
    preferLastValidatedPlan: true,
    refuseNewCalls: true,
    shouldLogoutAfterCurrentSkill: true,
  };
  const executor = new FakeExecutor(async (self) => {
    self.emit('skill:result', { call, result: { ok: true, reason: 'snapshot captured' } });
  });
  const agent = new AdvisorAgent(makeBot(), executor, {
    plan: async () => ({ ok: true, plan: [call] }),
    costSnapshotProvider: () => exhaustedCost,
  });

  const { value: result, records } = await captureLogRecords(() => agent.pursue('observe'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'advisor-budget-exhausted');
  assert.deepEqual(executor.replacements, [{
    calls: [{ skill: 'logout', params: { reason: 'advisor-budget-exhausted' } }],
    meta: { reason: 'advisor-budget-exhausted', phase: 'after-skill' },
  }]);
  assert.ok(records.some((record) => (
    record.loop === 'advisor'
    && record.evt === 'goal.advisor-budget-exhausted'
    && record.phase === 'after-skill'
    && record.logoutRequest?.ok === true
  )));
});
