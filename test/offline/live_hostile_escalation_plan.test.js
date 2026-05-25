import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTILE_ESCALATION_WAVES,
  evaluateHostileEscalationMetrics,
  hostileEscalationExpectedSpawnCount,
  hostileEscalationSpawnArgs,
} from '../live_hostile_escalation_plan.js';

test('hostile escalation plan defines the requested one-three-four wave pressure', () => {
  assert.deepEqual(HOSTILE_ESCALATION_WAVES.map((wave) => [wave.label, wave.count]), [
    ['single-near', 1],
    ['three-close', 3],
    ['four-stack', 4],
  ]);
  assert.equal(hostileEscalationExpectedSpawnCount(), 8);
});

test('hostile escalation spawn args are near the live bot with deterministic rounding', () => {
  assert.deepEqual(hostileEscalationSpawnArgs(
    { x: 10.12345, y: 64.9, z: -2.56789 },
    HOSTILE_ESCALATION_WAVES[0],
  ), ['1', '14.123', '64', '-2.568']);
  assert.deepEqual(hostileEscalationSpawnArgs(
    { x: 10.12345, y: 64.9, z: -2.56789 },
    HOSTILE_ESCALATION_WAVES[2],
  ), ['4', '11.123', '64', '-2.568']);
});

test('hostile escalation evaluator requires flee, no engage, and final escape by default', () => {
  const clean = {
    wavesSpawned: 3,
    spawnedHostiles: 8,
    sawFleeing: true,
    sawEngaging: false,
    sawNormalAfterFlee: true,
    finalEscapeObserved: true,
    pathfinderActiveFleeSamples: 12,
    minHealth: 18,
    waterEscapeEntries: 0,
    stateChanges: 4,
    normalAfterFleeNearestDistance: 44,
  };

  assert.deepEqual(evaluateHostileEscalationMetrics(clean, { minNormalAfterFleeDistance: 42 }), { ok: true });
  assert.deepEqual(evaluateHostileEscalationMetrics({ ...clean, sawEngaging: true }), {
    ok: false,
    reason: 'expected flee policy to avoid ENGAGING during hostile escalation',
  });
  assert.deepEqual(evaluateHostileEscalationMetrics({ ...clean, finalEscapeObserved: false }), {
    ok: false,
    reason: 'expected final wave escape before hostile escalation completion',
  });
  assert.deepEqual(evaluateHostileEscalationMetrics({ ...clean, normalAfterFleeNearestDistance: 30 }, { minNormalAfterFleeDistance: 42 }), {
    ok: false,
    reason: 'NORMAL after FLEEING was still inside de-aggro radius: 30 < 42',
  });
});
