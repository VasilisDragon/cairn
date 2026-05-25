import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PVM_ESCALATION_WAVES,
  evaluatePvmEscalationMetrics,
  pvmEscalationExpectedSpawnCount,
  pvmEscalationSpawnArgs,
} from '../live_pvm_escalation_plan.js';

test('PvM escalation plan defines engage-then-overwhelm zombie pressure', () => {
  assert.deepEqual(PVM_ESCALATION_WAVES.map((wave) => [wave.label, wave.count]), [
    ['single-engage', 1],
    ['three-overwhelm', 3],
  ]);
  assert.equal(pvmEscalationExpectedSpawnCount(), 4);
});

test('PvM escalation spawn args are near the live bot with deterministic rounding', () => {
  assert.deepEqual(pvmEscalationSpawnArgs(
    { x: 10.12345, y: 64.9, z: -2.56789 },
    PVM_ESCALATION_WAVES[0],
  ), ['1', '14.123', '64', '-2.568']);
  assert.deepEqual(pvmEscalationSpawnArgs(
    { x: 10.12345, y: 64.9, z: -2.56789 },
    PVM_ESCALATION_WAVES[1],
  ), ['3', '11.123', '64', '-2.568']);
});

test('PvM escalation evaluator requires engage before escalation and flee after it', () => {
  const clean = {
    wavesSpawned: 2,
    spawnedHostiles: 4,
    sawEngagingBeforeEscalation: true,
    sawFleeingAfterEscalation: true,
    sawTooManyHostilesPolicy: true,
    sawNormalAfterFlee: true,
    finalEscapeObserved: true,
    pathfinderActiveFleeSamples: 9,
    minHealth: 18,
    waterEscapeEntries: 0,
    stateChanges: 5,
    normalAfterFleeNearestDistance: 44,
  };

  assert.deepEqual(evaluatePvmEscalationMetrics(clean, { minNormalAfterFleeDistance: 42 }), { ok: true });
  assert.deepEqual(evaluatePvmEscalationMetrics({ ...clean, sawEngagingBeforeEscalation: false }), {
    ok: false,
    reason: 'expected ENGAGING before PvM escalation wave',
  });
  assert.deepEqual(evaluatePvmEscalationMetrics({ ...clean, sawFleeingAfterEscalation: false }), {
    ok: false,
    reason: 'expected FLEEING after PvM escalation wave',
  });
  assert.deepEqual(evaluatePvmEscalationMetrics({ ...clean, sawTooManyHostilesPolicy: false }), {
    ok: false,
    reason: 'expected combat policy to report too-many-hostiles after escalation',
  });
  assert.deepEqual(evaluatePvmEscalationMetrics({ ...clean, normalAfterFleeNearestDistance: 30 }, { minNormalAfterFleeDistance: 42 }), {
    ok: false,
    reason: 'NORMAL after FLEEING was still inside de-aggro radius: 30 < 42',
  });
});
