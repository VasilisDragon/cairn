import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initialPlanMessages,
  plan,
  replanMessages,
  setLlmCall,
  validatePlannerResponse,
} from '../../src/advisor/planner.js';

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

test('advisor response validator classifies valid, malformed, bad-shape, and invalid-skill output', () => {
  const raw = JSON.stringify({ plan: [{ skill: 'observe', params: {} }] });

  assert.deepEqual(validatePlannerResponse(raw), {
    ok: true,
    plan: [{ skill: 'observe', params: {} }],
    raw,
  });
  const badJson = validatePlannerResponse('{');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.stage, 'json');
  assert.match(badJson.reason, /^JSON parse:/);
  assert.deepEqual(validatePlannerResponse(JSON.stringify({ steps: [] })), {
    ok: false,
    stage: 'shape',
    reason: 'missing "plan" array',
  });
  assert.deepEqual(validatePlannerResponse(JSON.stringify({
    plan: [{ skill: 'recover_drops', params: { x: 0, y: 64, z: 0 } }],
  })), {
    ok: false,
    stage: 'schema',
    reason: 'recover_drops: not advisor-callable (scheduled only by deterministic death recovery after a recoverable respawn)',
    badIndex: 0,
  });
  const injectedState = validatePlannerResponse(JSON.stringify({
    plan: [{
      skill: 'mine_with_progression',
      params: { ores: ['iron_ore'], count: 1 },
      _state: {
        prepCalls: [{ skill: 'place_workstation', params: { workstation: 'furnace', action: 'place' } }],
      },
    }],
  }));
  assert.equal(injectedState.ok, false);
  assert.equal(injectedState.stage, 'schema');
  assert.equal(injectedState.badIndex, 0);
  assert.match(injectedState.reason, /unknown field "_state"/);
});

test('planner message helpers build DeepSeek-ready context without invoking the llm', () => {
  const initial = initialPlanMessages('collect logs', snapshot());
  const replan = replanMessages(
    'collect logs',
    snapshot({ queueLength: 1 }),
    { skill: 'collect', params: { block: 'oak_log', count: 1 }, reason: 'no targets' },
    [{ skill: 'deposit', params: { items: [{ name: 'oak_log' }] } }],
  );

  assert.equal(initial.length, 2);
  assert.equal(initial[0].role, 'system');
  assert.match(initial[0].content, /^AVAILABLE SKILLS:/m);
  assert.doesNotMatch(initial[0].content, /^- recover_drops:/m);
  assert.doesNotMatch(initial[0].content, /^- logout:/m);
  assert.match(initial[0].content, /^- smelt:/m);
  assert.match(initial[0].content, /^- mine_with_progression:/m);
  const initialUser = JSON.parse(initial[1].content);
  assert.equal(initialUser.goal, 'collect logs');
  assert.equal(initialUser.activation.normalWorkAllowed, true);

  const replanUser = JSON.parse(replan[1].content);
  assert.equal(replanUser.lastFailure.reason, 'no targets');
  assert.deepEqual(replanUser.remainingQueueDropped, [
    { skill: 'deposit', params: { items: [{ name: 'oak_log' }] } },
  ]);
});

test('advisor planner repairs runtime-only skill calls without exposing them in the prompt', async () => {
  const calls = [];
  const responses = [
    JSON.stringify({ plan: [{ skill: 'recover_drops', params: { x: 0, y: 64, z: 0 } }] }),
    JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
  ];
  setLlmCall(async (messages) => {
    calls.push(messages);
    return responses.shift();
  });

  try {
    const result = await plan('check state', {
      health: 20,
      food: 20,
      reactiveState: 'NORMAL',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.plan, [{ skill: 'observe', params: {} }]);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0][0].content, /^- recover_drops:/m);
    assert.match(calls[0][0].content, /^- build_from_schematic:/m);
    assert.match(calls[1][1].content, /recover_drops: not advisor-callable/);
  } finally {
    setLlmCall(null);
  }
});

test('advisor planner sends sanitized context envelopes and repairs malformed JSON', async () => {
  const calls = [];
  const current = snapshot({
    weird: Infinity,
    nested: { fn: () => 'not-json' },
  });
  current.self = current;
  const responses = [
    'not json',
    JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
  ];
  setLlmCall(async (messages) => {
    calls.push(messages);
    return responses.shift();
  });

  try {
    const result = await plan('inspect state', current);

    assert.equal(result.ok, true);
    assert.deepEqual(result.plan, [{ skill: 'observe', params: {} }]);
    assert.equal(calls.length, 2);

    const firstUser = JSON.parse(calls[0][1].content);
    assert.equal(firstUser.currentState.weird, null);
    assert.deepEqual(firstUser.currentState.nested, {});
    assert.equal(firstUser.currentState.self, null);
    assert.equal(firstUser.contextStatus.ok, false);
    assert.equal(firstUser.activation.normalWorkAllowed, true);
    assert.doesNotThrow(() => JSON.stringify(firstUser));

    const repairUser = JSON.parse(calls[1][1].content);
    assert.equal(repairUser.previousResponse, 'not json');
    assert.match(repairUser.error, /^JSON parse:/);
  } finally {
    setLlmCall(null);
  }
});
