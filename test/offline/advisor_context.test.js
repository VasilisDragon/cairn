import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advisorInterfaceManifest,
  buildAdvisorContextEnvelope,
  sanitizeAdvisorValue,
} from '../../src/advisor/context.js';

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

test('advisor interface manifest documents proposal-only queue boundary', () => {
  const manifest = advisorInterfaceManifest();

  assert.equal(manifest.version, 1);
  assert.equal(manifest.stateInput.jsonSafe, true);
  assert.match(manifest.stateInput.compactCombatOverview, /combatOverview/);
  assert.match(manifest.stateInput.compactMiningProgression, /miningProgression/);
  assert.match(manifest.stateInput.missionPreflightPattern, /prerequisites/);
  assert.match(manifest.feedbackBoundary.destination, /advisor-feedback/);
  assert.equal(manifest.feedbackBoundary.reviewRequired, true);
  assert.match(manifest.feedbackBoundary.executionAuthority, /^none/);
  assert.equal(manifest.queueBoundary.plannerOutput, 'proposal only');
  assert.match(manifest.queueBoundary.activation, /fresh current snapshot/);
  assert.match(manifest.queueBoundary.stagingHelper, /stageAdvisorQueueReplacement/);
  assert.match(manifest.queueBoundary.mutation, /only after activation succeeds/);
  assert.deepEqual(manifest.queueBoundary.runtimeOnlySkillNames, ['smelt', 'mine_with_progression', 'recover_drops']);
  assert.equal(manifest.safetyBoundary.noSafetyCriticalAdvisorAuthority, true);
  assert.match(manifest.safetyBoundary.combatOverviewGate, /blocks normal advisor work/);
  assert.ok(manifest.stateInput.excludes.includes('raw Mineflayer bot object'));
  assert.ok(manifest.stateInput.excludes.includes('server admin/RCON controls'));
});

test('advisor context envelope preserves current prompt shape for clean snapshots', () => {
  const current = snapshot({
    worldModel: {
      knownStorage: [{ name: 'chest', position: { x: 1, y: 64, z: 1 } }],
      visitedAreaCount: 1,
    },
  });

  const { context, diagnostics } = buildAdvisorContextEnvelope('collect logs', current, {
    request: 'Produce the initial plan.',
  });

  assert.equal(diagnostics.schemaVersion, 1);
  assert.equal(diagnostics.sanitized, false);
  assert.deepEqual(diagnostics.warnings, []);
  assert.equal(context.goal, 'collect logs');
  assert.deepEqual(context.currentState, current);
  assert.equal(context.activation.normalWorkAllowed, true);
  assert.deepEqual(context.activation.safetyReasons, []);
  assert.deepEqual(context.activation.allowedSkillNames, context.advisorContract.plannerSkillNames);
  assert.deepEqual(context.activation.blockedSkillNames, []);
  assert.equal(context.activation.snapshotKey.position.dimension, 'overworld');
  assert.equal(context.request, 'Produce the initial plan.');
  assert.equal('contextStatus' in context, false);
});

test('advisor context envelope carries combat overview activation safety', () => {
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

  const { context, diagnostics } = buildAdvisorContextEnvelope('continue mining', current, {
    request: 'Produce the initial plan.',
  });

  assert.equal(diagnostics.sanitized, false);
  assert.equal(context.activation.normalWorkAllowed, false);
  assert.deepEqual(context.activation.safetyReasons, [
    'combat overview critical/retreat: too-many-hostiles',
  ]);
  assert.deepEqual(context.activation.allowedSkillNames, ['observe', 'flee', 'logout', 'consume']);
  assert.ok(context.activation.blockedSkillNames.includes('collect'));
  assert.ok(context.activation.blockedSkillNames.includes('goto'));
  assert.ok(!context.activation.blockedSkillNames.includes('recover_drops'));
  assert.ok(!context.activation.blockedSkillNames.includes('smelt'));
  assert.equal(
    context.activation.snapshotKey.combatOverview,
    'critical|retreat|4|4|zombie@2|flee|too-many-hostiles|closePressure,groupPressure',
  );
});

test('advisor context envelope sanitizes non-json snapshot hazards before prompt construction', () => {
  const current = snapshot({
    inventory: [
      { name: 'oak_log', count: 1 },
      { name: 'bad_item', fn: () => 'nope' },
    ],
    badNumber: Infinity,
  });
  current.self = current;

  const { context, diagnostics } = buildAdvisorContextEnvelope('collect logs', current, {
    request: 'x'.repeat(12),
    huge: [1, 2, 3, 4],
  }, {
    sanitizeLimits: {
      maxArrayLength: 2,
      maxStringLength: 10,
    },
  });

  assert.equal(diagnostics.sanitized, true);
  assert.ok(diagnostics.warnings.some((warning) => warning.includes('currentState.inventory[1].fn: unsupported function omitted')));
  assert.ok(diagnostics.warnings.some((warning) => warning.includes('currentState.badNumber: non-finite number replaced with null')));
  assert.ok(diagnostics.warnings.some((warning) => warning.includes('currentState.self: circular reference replaced with null')));
  assert.ok(diagnostics.warnings.some((warning) => warning.includes('extra.request: string truncated 12 -> 10')));
  assert.ok(diagnostics.warnings.some((warning) => warning.includes('extra.huge: array truncated 4 -> 2')));
  assert.deepEqual(context.currentState.inventory, [
    { name: 'oak_log', count: 1 },
    { name: 'bad_item' },
  ]);
  assert.equal(context.currentState.badNumber, null);
  assert.equal(context.currentState.self, null);
  assert.equal(context.request, 'xxxxxxxxxx');
  assert.deepEqual(context.huge, [1, 2]);
  assert.equal(context.contextStatus.ok, false);
  assert.equal(context.contextStatus.warningCount, diagnostics.warnings.length);
  assert.doesNotThrow(() => JSON.stringify(context));
});

test('sanitizeAdvisorValue bounds arrays, object keys, strings, depth, and unsupported values', () => {
  const value = {
    a: 'abcdef',
    b: [1, 2, 3],
    c: { keep: true, drop: undefined, fn: () => {} },
    d: { e: { f: { g: 1 } } },
    e: 1n,
  };

  const result = sanitizeAdvisorValue(value, {
    limits: {
      maxStringLength: 3,
      maxArrayLength: 2,
      maxObjectKeys: 4,
      maxDepth: 2,
    },
  });

  assert.deepEqual(result.value, {
    a: 'abc',
    b: [1, 2],
    c: { keep: true },
    d: { e: null },
  });
  assert.deepEqual(result.warnings, [
    '$: object keys truncated 5 -> 4',
    '$.a: string truncated 6 -> 3',
    '$.b: array truncated 3 -> 2',
    '$.c.drop: unsupported undefined omitted',
    '$.c.fn: unsupported function omitted',
    '$.d.e: max depth 2 reached',
  ]);
});
