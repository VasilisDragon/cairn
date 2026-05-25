import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFleeFixtureMetrics,
  evaluateFleeFixtureMetrics,
  observeFleeFixtureSample,
  observeFleeFixtureTransition,
} from '../live_flee_metrics.js';

test('live flee metrics accept a clean FLEEING to NORMAL sequence with active pathing', () => {
  const metrics = createFleeFixtureMetrics('NORMAL');
  observeFleeFixtureSample(metrics, { state: 'FLEEING', pathfinderIdle: false, nearestDistance: 18 });
  observeFleeFixtureSample(metrics, { state: 'FLEEING', pathfinderIdle: false, nearestDistance: 30 });
  observeFleeFixtureSample(metrics, { state: 'NORMAL', pathfinderIdle: true, nearestDistance: 44 });

  assert.deepEqual(evaluateFleeFixtureMetrics(metrics, { minNormalAfterFleeDistance: 42 }), { ok: true });
  assert.equal(metrics.sawFleeing, true);
  assert.equal(metrics.sawNormalAfterFlee, true);
  assert.equal(metrics.pathfinderActiveFleeSamples, 2);
  assert.equal(metrics.normalAfterFleeNearestDistance, 44);
  assert.equal(metrics.maxTrackedHostileDistance, 44);
});

test('live flee metrics reject missing active flee pathing', () => {
  const metrics = createFleeFixtureMetrics('NORMAL');
  observeFleeFixtureSample(metrics, { state: 'FLEEING', pathfinderIdle: true });
  observeFleeFixtureSample(metrics, { state: 'NORMAL', pathfinderIdle: true });

  assert.deepEqual(
    evaluateFleeFixtureMetrics(metrics),
    { ok: false, reason: 'expected at least one FLEEING sample with pathfinderIdle=false' },
  );
});

test('live flee metrics reject NORMAL while hostile is still inside de-aggro radius', () => {
  const metrics = createFleeFixtureMetrics('NORMAL');
  observeFleeFixtureSample(metrics, { state: 'FLEEING', pathfinderIdle: false, nearestDistance: 18 });
  observeFleeFixtureSample(metrics, { state: 'NORMAL', pathfinderIdle: true, nearestDistance: 34 });

  assert.deepEqual(
    evaluateFleeFixtureMetrics(metrics, { minNormalAfterFleeDistance: 42 }),
    { ok: false, reason: 'NORMAL after FLEEING was still inside de-aggro radius: 34 < 42' },
  );
});

test('live flee metrics accept NORMAL when the hostile is outside tracking radius', () => {
  const metrics = createFleeFixtureMetrics('NORMAL');
  observeFleeFixtureSample(metrics, { state: 'FLEEING', pathfinderIdle: false, nearestDistance: 18 });
  observeFleeFixtureSample(metrics, { state: 'NORMAL', pathfinderIdle: true, nearestDistance: null });

  assert.deepEqual(evaluateFleeFixtureMetrics(metrics, { minNormalAfterFleeDistance: 42 }), { ok: true });
  assert.equal(metrics.normalAfterFleeNearestDistance, null);
});

test('live flee metrics reject repeated water escape churn', () => {
  const metrics = createFleeFixtureMetrics('NORMAL');
  for (const state of [
    'FLEEING',
    'WATER_ESCAPE',
    'NORMAL',
    'FLEEING',
    'WATER_ESCAPE',
    'NORMAL',
    'FLEEING',
    'WATER_ESCAPE',
    'NORMAL',
  ]) {
    observeFleeFixtureSample(metrics, {
      state,
      pathfinderIdle: state === 'FLEEING' ? false : true,
    });
  }

  assert.deepEqual(
    evaluateFleeFixtureMetrics(metrics, { maxWaterEscapeEntries: 2 }),
    { ok: false, reason: 'water escape churn 3 > 2' },
  );
});

test('live flee metrics reject excessive state churn', () => {
  const metrics = createFleeFixtureMetrics('NORMAL');
  for (const state of ['FLEEING', 'NORMAL', 'FLEEING', 'NORMAL', 'FLEEING', 'NORMAL']) {
    observeFleeFixtureSample(metrics, {
      state,
      pathfinderIdle: state === 'FLEEING' ? false : true,
    });
  }

  assert.deepEqual(
    evaluateFleeFixtureMetrics(metrics, { maxStateChanges: 4 }),
    { ok: false, reason: 'state churn 6 > 4' },
  );
});

test('live flee metrics count controller transitions when samples miss short states', () => {
  const metrics = createFleeFixtureMetrics('NORMAL');

  observeFleeFixtureTransition(metrics, { from: 'NORMAL', to: 'FLEEING', reason: 'hostile-flee' });
  observeFleeFixtureSample(metrics, { state: 'NORMAL', pathfinderIdle: true, countStateChanges: false });

  assert.equal(metrics.sawFleeing, true);
  assert.equal(metrics.sawNormalAfterFlee, true);
  assert.equal(metrics.stateChanges, 1);
});
