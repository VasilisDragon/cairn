import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AdvisorAgent } from '../../src/advisor/agent.js';
import { setLlmCall } from '../../src/advisor/planner.js';

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

  async runUntilDone() {
    this.runCalls += 1;
    await this.runImpl(this);
  }
}

async function withMockedLlm(responses, fn) {
  const calls = [];
  setLlmCall(async (messages) => {
    calls.push(messages);
    if (responses.length === 0) throw new Error('unexpected mocked LLM call');
    return responses.shift();
  });
  try {
    return await fn(calls);
  } finally {
    setLlmCall(null);
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
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = function write(chunk, ...args) {
    recordChunk(chunk);
    return originalStdoutWrite.call(process.stdout, chunk, ...args);
  };
  process.stderr.write = function write(chunk, ...args) {
    recordChunk(chunk);
    return originalStderrWrite.call(process.stderr, chunk, ...args);
  };
  try {
    return { value: await fn(), records };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

test('mocked advisor e2e repairs malformed initial response before executor activation', async () => {
  const acceptedPlan = [{ skill: 'observe', params: {} }];
  await withMockedLlm([
    'not json',
    JSON.stringify({ plan: acceptedPlan }),
  ], async (llmCalls) => {
    const executor = new FakeExecutor();
    const agent = new AdvisorAgent(makeBot(), executor, {
      buildSnapshot: () => safeSnapshot(),
    });

    const { value: result, records } = await captureLogRecords(() => (
      agent.pursue('inspect current state')
    ));

    assert.equal(result.ok, true);
    assert.equal(result.replans, 0);
    assert.equal(executor.clears, 1);
    assert.equal(executor.runCalls, 1);
    assert.deepEqual(executor.enqueued, [acceptedPlan]);

    assert.equal(llmCalls.length, 2);
    assert.equal(llmCalls[0][0].role, 'system');
    assert.equal(llmCalls[0][1].role, 'user');
    assert.doesNotMatch(llmCalls[0][0].content, /^- recover_drops:/m);

    const firstUser = JSON.parse(llmCalls[0][1].content);
    assert.equal(firstUser.goal, 'inspect current state');
    assert.equal(firstUser.request, 'Produce the initial plan.');
    assert.equal(firstUser.currentState.position.x, 0);
    assert.equal(firstUser.activation.normalWorkAllowed, true);

    const repairUser = JSON.parse(llmCalls[1][1].content);
    assert.equal(repairUser.previousResponse, 'not json');
    assert.match(repairUser.error, /^JSON parse:/);

    assert.ok(records.some((record) => (
      record.loop === 'advisor'
      && record.evt === 'plan.bad-json'
      && record.label === 'initial'
    )));
    assert.ok(records.some((record) => (
      record.loop === 'advisor'
      && record.evt === 'plan.accepted'
      && record.label === 'initial'
      && record.attempt === 1
    )));
    assert.ok(records.some((record) => (
      record.loop === 'advisor'
      && record.evt === 'goal.complete'
      && record.goal === 'inspect current state'
    )));
  });
});

test('mocked advisor e2e rejects stale accepted plans before enqueueing', async () => {
  const collectPlan = [{ skill: 'collect', params: { block: 'oak_log', count: 1 } }];
  await withMockedLlm([
    JSON.stringify({ plan: collectPlan }),
  ], async (llmCalls) => {
    const snapshots = [
      safeSnapshot(),
      safeSnapshot({ position: { x: 5, y: 64, z: 0, dimension: 'overworld' } }),
    ];
    const executor = new FakeExecutor();
    const agent = new AdvisorAgent(makeBot(), executor, {
      buildSnapshot: () => snapshots.shift() || safeSnapshot({
        position: { x: 5, y: 64, z: 0, dimension: 'overworld' },
      }),
    });

    const { value: result } = await captureLogRecords(() => (
      agent.pursue('collect one oak log')
    ));

    assert.equal(result.ok, false);
    assert.match(result.reason, /plan activation rejected: stale plan activation/);
    assert.deepEqual(result.activation.staleReasons, ['position drift 5 > 2']);
    assert.equal(executor.clears, 0);
    assert.equal(executor.enqueued.length, 0);
    assert.equal(executor.runCalls, 0);

    assert.equal(llmCalls.length, 1);
    const firstUser = JSON.parse(llmCalls[0][1].content);
    assert.deepEqual(firstUser.currentState.position, { x: 0, y: 64, z: 0, dimension: 'overworld' });
  });
});

test('mocked advisor e2e replans through the real planner after queue failure', async () => {
  const failingCall = { skill: 'collect', params: { block: 'oak_log', count: 1 } };
  const recoveryCall = { skill: 'observe', params: {} };
  await withMockedLlm([
    JSON.stringify({ plan: [failingCall] }),
    JSON.stringify({ plan: [recoveryCall] }),
  ], async (llmCalls) => {
    const executor = new FakeExecutor(async (self) => {
      if (self.runCalls === 1) {
        self.emit('queue:failure', {
          call: failingCall,
          result: { ok: false, reason: 'no reachable oak logs' },
        });
      }
    });
    const agent = new AdvisorAgent(makeBot(), executor, {
      buildSnapshot: () => safeSnapshot(),
      maxReplans: 1,
    });

    const { value: result, records } = await captureLogRecords(() => (
      agent.pursue('collect one oak log')
    ));

    assert.equal(result.ok, true);
    assert.equal(result.replans, 1);
    assert.equal(executor.clears, 2);
    assert.equal(executor.runCalls, 2);
    assert.deepEqual(executor.enqueued, [[failingCall], [recoveryCall]]);

    assert.equal(llmCalls.length, 2);
    const replanUser = JSON.parse(llmCalls[1][1].content);
    assert.deepEqual(replanUser.lastFailure, {
      skill: 'collect',
      params: { block: 'oak_log', count: 1 },
      reason: 'no reachable oak logs',
    });
    assert.deepEqual(replanUser.remainingQueueDropped, [failingCall]);
    assert.match(replanUser.request, /previous skill in the plan failed/i);

    assert.ok(records.some((record) => (
      record.loop === 'advisor'
      && record.evt === 'goal.replan'
      && record.attempt === 1
    )));
    assert.ok(records.some((record) => (
      record.loop === 'advisor'
      && record.evt === 'plan.accepted'
      && record.label === 'replan'
    )));
  });
});
