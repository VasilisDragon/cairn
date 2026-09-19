import assert from 'node:assert/strict';
import test from 'node:test';
import {
  freezePhaseADescentLifetime,
  legacyMissionActionTtl,
  phaseADescentIntent,
  phaseADescentRemaining,
  PHASE_A_DESCENT_MAX_MS,
} from './descent-lifetime.js';

function request(overrides = {}) {
  return {
    commandId: 'mission-lifetime-1',
    intent: { action: 'descend_staircase', reason: 'mission:DESCEND', targetY: 16 },
    snapshot: { y: 70 }, issuedAtMs: 1000, maxTtlMs: 255000,
    ...overrides,
  };
}

for (const [y, boundedDepth, lifetimeMs] of [[70,20,255000],[36,20,255000],[35.9,19,243000],[24.8,8,111000],[18,2,39000],[17,1,27000],[16,1,27000],[13,1,27000]]) {
  test(`descent lifetime matches existing bounded depth at y=${y}`, () => {
    const result = freezePhaseADescentLifetime(request({ snapshot: { y } }));
    assert.equal(result.accepted, true);
    assert.equal(result.boundedDepth, boundedDepth);
    assert.equal(result.lifetimeMs, lifetimeMs);
    assert.equal(result.deadlineMs, 1000 + lifetimeMs);
    assert.equal(Object.isFrozen(result), true);
  });
}

test('descent lifetime primary and recovery use the identical pre-issued calculation', () => {
  const primary = freezePhaseADescentLifetime(request());
  const recovery = freezePhaseADescentLifetime(request({ intent: { action: 'descend_staircase', reason: 'mission:DESCEND_RECOVERY', targetY: 16 } }));
  assert.deepEqual(recovery, primary);
  assert.equal(primary.lifetimeMs, PHASE_A_DESCENT_MAX_MS);
});

test('descent lifetime never changes input snapshots or command fields', () => {
  const input = request();
  const before = structuredClone(input);
  freezePhaseADescentLifetime(input);
  assert.deepEqual(input, before);
});

for (const y of [undefined, null, '70', NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 2147483648, -2147483648]) {
  test(`descent lifetime rejects invalid position ${String(y)}`, () => {
    assert.equal(freezePhaseADescentLifetime(request({ snapshot: { y } })).reason, 'descent_lifetime_position_invalid');
  });
}

test('descent lifetime requires exact supported target and command provenance', () => {
  for (const targetY of [15,17,16.5,NaN,undefined]) {
    assert.equal(freezePhaseADescentLifetime(request({ intent: { action: 'descend_staircase', reason: 'mission:DESCEND', targetY } })).reason, 'descent_lifetime_target_invalid');
  }
  for (const commandId of ['',null,'mission-','stub-1',' mission-1']) {
    assert.equal(freezePhaseADescentLifetime(request({ commandId })).reason, 'descent_lifetime_command_invalid');
  }
});

test('descent lifetime refuses to exceed an operator cap, including malformed caps', () => {
  for (const maxTtlMs of [45000,254999,0,NaN,Infinity,'255000',undefined]) {
    const result = freezePhaseADescentLifetime(request({ maxTtlMs }));
    assert.equal(result.reason, 'descent_lifetime_cap_insufficient');
    assert.equal(result.requiredTtlMs, 255000);
  }
  assert.equal(freezePhaseADescentLifetime(request({ maxTtlMs: 660000 })).lifetimeMs, 255000);
});

test('descent lifetime honors the exact effective deadline and rejects clock rollback', () => {
  const frozen = freezePhaseADescentLifetime(request());
  assert.deepEqual(phaseADescentRemaining(frozen, 1000), { accepted: true, ttlMs: 255000 });
  assert.deepEqual(phaseADescentRemaining(frozen, 255999, 2000), { accepted: true, ttlMs: 1 });
  assert.equal(phaseADescentRemaining(frozen, 256000).reason, 'descent_lifetime_expired');
  assert.equal(phaseADescentRemaining(frozen, 256001).reason, 'descent_lifetime_expired');
  assert.equal(phaseADescentRemaining(frozen, 1999, 2000).reason, 'descent_lifetime_clock_invalid');
  assert.equal(phaseADescentRemaining(frozen, NaN).reason, 'descent_lifetime_clock_invalid');
  assert.equal(phaseADescentRemaining(null, 1000).reason, 'descent_lifetime_missing');
  assert.equal(frozen.deadlineMs, 256000);
});

test('descent lifetime rejects timestamp overflow before constructing a deadline', () => {
  for (const issuedAtMs of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(freezePhaseADescentLifetime(request({ issuedAtMs })).reason, 'descent_lifetime_clock_invalid');
  }
});

test('descent lifetime does not recognize deep descent, generic commands or other mission goals', () => {
  for (const [action,reason] of [['descend_staircase','mission:DESCEND_DEEP'],['descend_staircase','stub:descend'],['r5_iron_chain','mission:DESCEND'],['mine_nearby_iron','mission:MINE_IRON_RECOVERY']]) {
    assert.equal(phaseADescentIntent({ action, reason }, {}), false);
  }
  for (const snapshot of [{missionGoal:'diamond'},{goal:'iron_pickaxe'},{targetIronPickaxeOnly:true},{targetDiamondTier:true}]) {
    assert.equal(phaseADescentIntent(request().intent, snapshot), false);
  }
});

test('descent lifetime excludes conflicting non-Phase-A goals in either independent goal field', () => {
  for (const otherGoal of ['diamond', 'iron_pickaxe', 'iron_pickaxe_only']) {
    for (const snapshot of [
      { missionGoal: 'phase_a', goal: otherGoal },
      { missionGoal: otherGoal, goal: 'phase_a' },
    ]) {
      assert.equal(phaseADescentIntent(request().intent, snapshot), false);
      assert.equal(freezePhaseADescentLifetime(request({ snapshot: { ...snapshot, y: 70 } })).reason,
        'descent_lifetime_scope_invalid');
    }
  }
});

test('non-descent mission lifetimes retain their original ceiling despite the larger transport cap', () => {
  for (const value of [1,4000,8000,15000,30000,45000]) assert.equal(legacyMissionActionTtl(value), value);
  assert.equal(legacyMissionActionTtl(255000), 45000);
});
