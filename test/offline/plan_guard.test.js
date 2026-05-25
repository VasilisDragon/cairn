import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activationSkillPolicy,
  snapshotPlanKey,
  snapshotStalenessReasons,
  SURVIVAL_SKILL_NAMES,
  unsafeSnapshotReasons,
  validatePlanActivation,
} from '../../src/advisor/plan_guard.js';

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

test('plan activation guard accepts valid normal plans on safe snapshots', () => {
  const current = snapshot();
  const result = validatePlanActivation([
    { skill: 'collect', params: { block: 'oak_log', count: 2 } },
    { skill: 'deposit', params: { items: [{ name: 'oak_log' }] } },
  ], current, { proposedFromSnapshot: current });

  assert.equal(result.ok, true);
  assert.deepEqual(result.safetyReasons, []);
  assert.deepEqual(result.staleReasons, []);
  assert.equal(result.snapshotKey.reactiveState, 'NORMAL');
});

test('plan activation guard rejects normal tasks while reactive safety owns the snapshot', () => {
  const current = snapshot({
    reactiveState: 'HAZARD',
    pathfinder: { owner: 'reactive', idle: false },
    hazardFlags: {
      inWater: false,
      oxygenLow: false,
      falling: true,
      usingHeldItem: true,
      autoEatEating: true,
    },
  });

  const result = validatePlanActivation([
    { skill: 'collect', params: { block: 'oak_log', count: 1 } },
  ], current);

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 0);
  assert.match(result.reason, /unsafe snapshot permits only observe\/flee\/logout\/consume/);
  assert.deepEqual(result.safetyReasons, [
    'reactive state HAZARD',
    'pathfinder owned by reactive',
    'falling',
  ]);
});

test('plan activation guard allows survival skills during unsafe snapshots', () => {
  const current = snapshot({
    reactiveState: 'FLEEING',
    nearbyHostiles: [{ name: 'zombie', distance: 4 }],
  });

  const result = validatePlanActivation([
    { skill: 'observe', params: {} },
    { skill: 'flee', params: { from: 'nearest_hostile' } },
    { skill: 'logout', params: { reason: 'manual-safety' } },
    { skill: 'consume', params: { item: 'golden_apple' } },
  ], current);

  assert.equal(result.ok, true);
  assert.deepEqual(result.safetyReasons, [
    'reactive state FLEEING',
    'nearby hostile zombie at 4',
  ]);
});

test('activation skill policy exposes the exact unsafe skill subset', () => {
  const safe = activationSkillPolicy(snapshot());
  assert.equal(safe.normalWorkAllowed, true);
  assert.deepEqual(safe.safetyReasons, []);
  assert.ok(safe.allowedSkillNames.includes('collect'));
  assert.deepEqual(safe.blockedSkillNames, []);

  const unsafe = activationSkillPolicy(snapshot({
    reactiveState: 'FLEEING',
    nearbyHostiles: [{ name: 'zombie', distance: 6 }],
  }));
  assert.equal(unsafe.normalWorkAllowed, false);
  assert.deepEqual(unsafe.allowedSkillNames, SURVIVAL_SKILL_NAMES);
  assert.ok(unsafe.blockedSkillNames.includes('collect'));
  assert.ok(unsafe.blockedSkillNames.includes('goto'));
  assert.ok(!unsafe.blockedSkillNames.includes('recover_drops'));
  assert.deepEqual(unsafe.safetyReasons, [
    'reactive state FLEEING',
    'nearby hostile zombie at 6',
  ]);
});

test('plan activation guard allows explicit consume during low-health unsafe snapshots', () => {
  const current = snapshot({ health: 6 });

  const result = validatePlanActivation([
    { skill: 'consume', params: { item: 'potion', effect: 'instant_health', minLevel: 1, allowPotions: true } },
  ], current);

  assert.equal(result.ok, true);
  assert.deepEqual(result.safetyReasons, ['low health 6']);
});

test('plan activation guard rejects mixed normal work after survival consume while unsafe', () => {
  const current = snapshot({
    health: 6,
    nearbyHostiles: [{ name: 'skeleton', distance: 8 }],
  });

  const result = validatePlanActivation([
    { skill: 'consume', params: { item: 'golden_apple' } },
    { skill: 'collect', params: { block: 'oak_log', count: 1 } },
  ], current);

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 1);
  assert.match(result.reason, /rejected collect/);
  assert.deepEqual(result.safetyReasons, [
    'low health 6',
    'nearby hostile skeleton at 8',
  ]);
});

test('plan activation guard rejects normal work when combat overview reports critical pressure', () => {
  const current = snapshot({
    nearbyHostiles: [],
    combatOverview: {
      threatLevel: 'critical',
      advisorPriority: 'retreat',
      threatCount: 4,
      closeCount: 4,
      nearest: { name: 'zombie', distance: 2 },
      flags: {
        groupPressure: true,
        closePressure: true,
      },
      recommendedAction: 'flee',
      recommendedReason: 'too-many-hostiles',
    },
  });

  const result = validatePlanActivation([
    { skill: 'collect', params: { block: 'oak_log', count: 1 } },
  ], current);

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 0);
  assert.match(result.reason, /rejected collect/);
  assert.deepEqual(result.safetyReasons, [
    'combat overview critical/retreat: too-many-hostiles',
  ]);
});

test('plan activation guard rejects stale proposal snapshots before activation', () => {
  const proposedFromSnapshot = snapshot({
    currentSkill: { skill: 'collect', params: { block: 'oak_log', count: 2 } },
    queueLength: 2,
  });
  const current = snapshot({
    position: { x: 5, y: 64, z: 0, dimension: 'overworld' },
    health: 16,
    currentSkill: { skill: 'deposit', params: { items: [{ name: 'oak_log' }] } },
    queueLength: 1,
  });

  const result = validatePlanActivation([
    { skill: 'craft', params: { item: 'stick', count: 1 } },
  ], current, { proposedFromSnapshot });

  assert.equal(result.ok, false);
  assert.match(result.reason, /stale plan activation/);
  assert.deepEqual(result.staleReasons, [
    'current skill changed collect:{"block":"oak_log","count":2} -> deposit:{"items":[{"name":"oak_log"}]}',
    'queue length changed 2 -> 1',
    'position drift 5 > 2',
    'health dropped 20 -> 16',
  ]);
});

test('plan activation guard treats combat overview changes as stale proposal evidence', () => {
  const proposedFromSnapshot = snapshot({
    combatOverview: {
      threatLevel: 'clear',
      advisorPriority: 'normal',
      threatCount: 0,
      closeCount: 0,
      recommendedAction: 'none',
      recommendedReason: 'no-threat',
      flags: {},
    },
  });
  const current = snapshot({
    combatOverview: {
      threatLevel: 'critical',
      advisorPriority: 'retreat',
      threatCount: 4,
      closeCount: 4,
      nearest: { name: 'zombie', distance: 2 },
      flags: {
        groupPressure: true,
        closePressure: true,
      },
      recommendedAction: 'flee',
      recommendedReason: 'too-many-hostiles',
    },
  });

  assert.deepEqual(snapshotStalenessReasons(proposedFromSnapshot, current), [
    'combat overview changed clear|normal|0|0|none|none|no-threat| -> critical|retreat|4|4|zombie@2|flee|too-many-hostiles|closePressure,groupPressure',
  ]);
});

test('plan activation guard treats last ranged verification changes as stale combat evidence', () => {
  const proposedFromSnapshot = snapshot({
    combatOverview: {
      threatLevel: 'high',
      advisorPriority: 'combat',
      threatCount: 1,
      closeCount: 0,
      nearest: { name: 'creeper', distance: 10 },
      flags: {
        explosiveThreat: true,
      },
      recommendedAction: 'fire_ranged_weapon',
      recommendedReason: 'creeper-ranged-fire-safe',
    },
  });
  const current = snapshot({
    combatOverview: {
      threatLevel: 'high',
      advisorPriority: 'combat',
      threatCount: 1,
      closeCount: 0,
      nearest: { name: 'creeper', distance: 10 },
      flags: {
        explosiveThreat: true,
      },
      recommendedAction: 'fire_ranged_weapon',
      recommendedReason: 'creeper-ranged-fire-safe',
      lastRangedFire: {
        outcome: 'target-still-present',
        entity: 'creeper',
        currentDistance: 10,
        followUpShots: 2,
      },
    },
  });

  assert.deepEqual(snapshotStalenessReasons(proposedFromSnapshot, current), [
    'combat overview changed high|combat|1|0|creeper@10|fire_ranged_weapon|creeper-ranged-fire-safe|explosiveThreat -> high|combat|1|0|creeper@10|fire_ranged_weapon|creeper-ranged-fire-safe|explosiveThreat|ranged:target-still-present:creeper@10#2',
  ]);
});

test('plan activation guard treats combat recommended target changes as stale proposal evidence', () => {
  const proposedFromSnapshot = snapshot({
    combatOverview: {
      threatLevel: 'high',
      advisorPriority: 'combat',
      threatCount: 2,
      closeCount: 0,
      nearest: { name: 'zombie', distance: 5 },
      recommendedTarget: { name: 'creeper', distance: 10 },
      flags: {
        explosiveThreat: true,
      },
      recommendedAction: 'fire_ranged_weapon',
      recommendedReason: 'creeper-ranged-fire-safe',
    },
  });
  const current = snapshot({
    combatOverview: {
      threatLevel: 'high',
      advisorPriority: 'combat',
      threatCount: 2,
      closeCount: 0,
      nearest: { name: 'zombie', distance: 5 },
      recommendedTarget: { name: 'skeleton', distance: 9 },
      flags: {
        rangedThreat: true,
      },
      recommendedAction: 'fire_ranged_weapon',
      recommendedReason: 'ranged-fire-safe',
    },
  });

  assert.deepEqual(snapshotStalenessReasons(proposedFromSnapshot, current), [
    'combat overview changed high|combat|2|0|zombie@5|target:creeper@10|fire_ranged_weapon|creeper-ranged-fire-safe|explosiveThreat -> high|combat|2|0|zombie@5|target:skeleton@9|fire_ranged_weapon|ranged-fire-safe|rangedThreat',
  ]);
});

test('plan guard exposes compact stable snapshot keys and raw staleness reasons', () => {
  const before = snapshot({
    position: { x: 0.004, y: 64, z: 0, dimension: 'overworld' },
    nearbyHostiles: [{ name: 'zombie', distance: 3.4 }],
  });
  const current = snapshot({
    reactiveState: 'WATER_ESCAPE',
    hazardFlags: {
      inWater: true,
      oxygenLow: true,
      falling: false,
      usingHeldItem: false,
      autoEatEating: false,
    },
    nearbyHostiles: [],
  });

  assert.deepEqual(snapshotPlanKey(before).position, { x: 0, y: 64, z: 0, dimension: 'overworld' });
  assert.deepEqual(unsafeSnapshotReasons(current), ['reactive state WATER_ESCAPE', 'oxygen low']);
  assert.deepEqual(snapshotStalenessReasons(before, current), [
    'reactive state changed NORMAL -> WATER_ESCAPE',
    'oxygenLow changed false -> true',
    'nearby hostiles changed zombie@3 -> none',
  ]);
});

test('plan activation guard still enforces skill schema before safety checks', () => {
  const result = validatePlanActivation([
    { skill: 'collect', params: { count: 1 } },
  ], snapshot({ reactiveState: 'HAZARD' }));

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 0);
  assert.match(result.reason, /schema: collect: missing required param "block"/);
});

test('plan activation guard rejects runtime-only skills at the advisor boundary', () => {
  const result = validatePlanActivation([
    { skill: 'recover_drops', params: { x: 0, y: 64, z: 0 } },
  ], snapshot());

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 0);
  assert.match(result.reason, /schema: recover_drops: not advisor-callable/);
});
