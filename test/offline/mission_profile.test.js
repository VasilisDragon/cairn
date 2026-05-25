import test from 'node:test';
import assert from 'node:assert/strict';

import { createMissionProfile, requireMissionProfile } from '../../src/runtime/mission_profile.js';

test('createMissionProfile creates a bounded task budget with deposit interval', () => {
  const profile = createMissionProfile({
    label: 'fishing',
    phase: 'gear-prep',
    durationMs: 120000,
    returnReserveMs: 30000,
    depositIntervalMs: 45000,
  }, 1000);

  assert.equal(profile.ok, true);
  assert.equal(profile.label, 'fishing');
  assert.equal(profile.durationMs, 120000);
  assert.equal(profile.returnReserveMs, 30000);
  assert.equal(profile.depositIntervalMs, 45000);
  assert.equal(profile.taskBudget.startedAtMs, 1000);
  assert.equal(profile.taskBudget.deadlineAtMs, 121000);
  assert.equal(profile.taskBudget.returnByMs, 91000);
  assert.deepEqual(profile.summary, {
    label: 'fishing',
    phase: 'gear-prep',
    elapsedMs: 0,
    durationMs: 120000,
    deadlineRemainingMs: 120000,
    overdue: false,
    returnReserveMs: 30000,
    returnByRemainingMs: 90000,
    returnDue: false,
  });
});

test('createMissionProfile derives a conservative default deposit interval', () => {
  const profile = createMissionProfile({
    durationMs: 600000,
    returnReserveMs: 90000,
  }, 0);

  assert.equal(profile.ok, true);
  assert.equal(profile.depositIntervalMs, 255000);
});

test('createMissionProfile rejects unsafe timing and deposit knobs', () => {
  assert.deepEqual(createMissionProfile({
    label: 'bad-duration',
    durationMs: 0,
    returnReserveMs: 1000,
  }, 0), {
    label: 'bad-duration',
    ok: false,
    taskBudget: {
      label: 'bad-duration',
      startedAtMs: 0,
      durationMs: 0,
      deadlineAtMs: 0,
      returnReserveMs: 1000,
      returnByMs: -1000,
    },
    durationMs: 0,
    returnReserveMs: 1000,
    depositIntervalMs: 0,
    summary: {
      label: 'bad-duration',
      elapsedMs: 0,
      durationMs: 0,
      deadlineRemainingMs: 0,
      overdue: true,
      returnReserveMs: 1000,
      returnByRemainingMs: -1000,
      returnDue: true,
    },
    reason: 'durationMs must be > 0',
  });

  assert.equal(createMissionProfile({
    durationMs: 10000,
    returnReserveMs: 10000,
  }, 0).reason, 'returnByMs must be after startedAtMs');

  assert.equal(createMissionProfile({
    durationMs: 10000,
    returnReserveMs: 1000,
    depositIntervalMs: -1,
  }, 0).reason, 'depositIntervalMs must be >= 0');
});

test('requireMissionProfile throws exact unsafe profile reason', () => {
  assert.throws(
    () => requireMissionProfile({ label: 'live_fixture', durationMs: 1000, returnReserveMs: 1000 }, 0),
    /unsafe live_fixture task budget: returnByMs must be after startedAtMs/,
  );
});
