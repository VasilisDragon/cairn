import test from 'node:test';
import assert from 'node:assert/strict';

import { stageAdvisorQueueReplacement } from '../../src/advisor/queue_proposal.js';

function snapshot(overrides = {}) {
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

function makeExecutor(result = { ok: true, count: 1 }) {
  const calls = [];
  return {
    calls,
    requestQueueReplacement(plan, meta) {
      calls.push({ plan, meta });
      return result;
    },
  };
}

test('advisor queue proposal validates activation before staging replacement', () => {
  const plan = [{ skill: 'observe', params: {} }];
  const current = snapshot();
  const executor = makeExecutor({ ok: true, count: 1 });

  const result = stageAdvisorQueueReplacement(executor, plan, current, {
    goal: 'inspect',
    proposedFromSnapshot: current,
    reason: 'background advisor proposal',
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'advisor queue proposal staged');
  assert.equal(result.count, 1);
  assert.equal(result.activation.ok, true);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].plan, plan);
  assert.equal(executor.calls[0].meta.source, 'advisor');
  assert.equal(executor.calls[0].meta.reason, 'background advisor proposal');
  assert.equal(executor.calls[0].meta.goal, 'inspect');
  assert.equal(executor.calls[0].meta.activationSnapshotKey.reactiveState, 'NORMAL');
});

test('advisor queue proposal rejects unsafe normal work before touching executor', () => {
  const plan = [{ skill: 'collect', params: { block: 'oak_log', count: 1 } }];
  const current = snapshot({
    reactiveState: 'FLEEING',
    nearbyHostiles: [{ name: 'zombie', distance: 4 }],
  });
  const executor = makeExecutor();

  const result = stageAdvisorQueueReplacement(executor, plan, current);

  assert.equal(result.ok, false);
  assert.match(result.reason, /advisor queue proposal rejected: unsafe snapshot permits only/);
  assert.equal(result.activation.badIndex, 0);
  assert.deepEqual(result.activation.safetyReasons, [
    'reactive state FLEEING',
    'nearby hostile zombie at 4',
  ]);
  assert.equal(executor.calls.length, 0);
});

test('advisor queue proposal rejects stale plans before touching executor', () => {
  const plan = [{ skill: 'collect', params: { block: 'oak_log', count: 1 } }];
  const proposedFromSnapshot = snapshot();
  const current = snapshot({ position: { x: 5, y: 64, z: 0, dimension: 'overworld' } });
  const executor = makeExecutor();

  const result = stageAdvisorQueueReplacement(executor, plan, current, { proposedFromSnapshot });

  assert.equal(result.ok, false);
  assert.match(result.reason, /advisor queue proposal rejected: stale plan activation/);
  assert.deepEqual(result.activation.staleReasons, ['position drift 5 > 2']);
  assert.equal(executor.calls.length, 0);
});

test('advisor queue proposal reports executor staging failure after activation succeeds', () => {
  const plan = [{ skill: 'observe', params: {} }];
  const executor = makeExecutor({ ok: false, reason: 'replacement unavailable' });

  const result = stageAdvisorQueueReplacement(executor, plan, snapshot());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'executor queue replacement failed: replacement unavailable');
  assert.equal(result.activation.ok, true);
  assert.equal(executor.calls.length, 1);
});

test('advisor queue proposal fails closed when executor boundary is unavailable', () => {
  const result = stageAdvisorQueueReplacement({}, [{ skill: 'observe', params: {} }], snapshot());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'executor queue replacement boundary unavailable');
});
