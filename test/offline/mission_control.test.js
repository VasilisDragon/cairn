import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateMissionCheckpoint, runMissionLoop } from '../../src/runtime/mission_control.js';
import { createReturnPlan, createRouteEstimate } from '../../src/runtime/mission_return.js';
import { createTaskBudget } from '../../src/runtime/task_budget.js';

test('mission checkpoint continues while budget and deposit policy are clear', () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 1000);
  assert.deepEqual(evaluateMissionCheckpoint({
    taskBudget,
    inventoryCounts: { cod: 1, dirt: 64 },
    trackedItems: ['cod'],
    lastDepositAtMs: 1000,
    depositPolicy: { depositEveryMs: 5000 },
  }, 3000), {
    action: 'continue',
    reason: 'within-mission-bounds',
    taskBudget: {
      elapsedMs: 2000,
      durationMs: 10000,
      deadlineRemainingMs: 8000,
      overdue: false,
      returnReserveMs: 2000,
      returnByRemainingMs: 6000,
      returnDue: false,
    },
    checkpoint: {
      nowMs: 3000,
      trackedCounts: { cod: 1 },
      trackedTotal: 1,
      lastDepositAgeMs: 2000,
    },
  });
});

test('mission checkpoint requests deposit on interval only when tracked output exists', () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 1000);
  assert.equal(evaluateMissionCheckpoint({
    taskBudget,
    inventoryCounts: { dirt: 64 },
    trackedItems: ['cod'],
    lastDepositAtMs: 1000,
    depositPolicy: { depositEveryMs: 5000 },
  }, 7000).action, 'continue');

  assert.deepEqual(evaluateMissionCheckpoint({
    taskBudget,
    inventoryCounts: { cod: 3, dirt: 64 },
    trackedItems: ['cod'],
    lastDepositAtMs: 1000,
    depositPolicy: { depositEveryMs: 5000 },
  }, 7000), {
    action: 'deposit',
    reason: 'deposit-interval-reached',
    taskBudget: {
      elapsedMs: 6000,
      durationMs: 10000,
      deadlineRemainingMs: 4000,
      overdue: false,
      returnReserveMs: 2000,
      returnByRemainingMs: 2000,
      returnDue: false,
    },
    checkpoint: {
      nowMs: 7000,
      trackedCounts: { cod: 3 },
      trackedTotal: 3,
      lastDepositAgeMs: 6000,
    },
    depositItems: { cod: 3 },
  });
});

test('mission checkpoint requests deposit for item-count and inventory pressure', () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 1000);
  assert.equal(evaluateMissionCheckpoint({
    taskBudget,
    inventoryCounts: { diamond: 5 },
    trackedItems: ['diamond'],
    depositPolicy: { minTrackedItemCount: 5 },
  }, 2000).reason, 'tracked-item-count-reached');

  const pressure = evaluateMissionCheckpoint({
    taskBudget,
    inventoryCounts: { cod: 1, pufferfish: 1 },
    trackedItems: ['cod', 'pufferfish'],
    usedSlots: 35,
    depositPolicy: { maxUsedSlots: 35 },
  }, 2000);
  assert.equal(pressure.action, 'deposit');
  assert.equal(pressure.reason, 'inventory-pressure');
  assert.deepEqual(pressure.depositItems, { cod: 1, pufferfish: 1 });
  assert.equal(pressure.checkpoint.usedSlots, 35);
});

test('mission checkpoint lets return reserve and stop decisions outrank deposit', () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 1000);
  const dueReturn = evaluateMissionCheckpoint({
    taskBudget,
    inventoryCounts: { cod: 64 },
    trackedItems: ['cod'],
    lastDepositAtMs: 1000,
    depositPolicy: { depositEveryMs: 1000, minTrackedItemCount: 1 },
  }, 9000);
  assert.equal(dueReturn.action, 'return');
  assert.equal(dueReturn.reason, 'return-reserve-reached');

  const overdue = evaluateMissionCheckpoint({
    taskBudget,
    inventoryCounts: { cod: 64 },
    trackedItems: ['cod'],
    depositPolicy: { minTrackedItemCount: 1 },
  }, 12000);
  assert.equal(overdue.action, 'stop');
  assert.equal(overdue.reason, 'deadline-overdue');
});

test('mission checkpoint applies dynamic return plans before deposit checks', () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 1000 }, 1000);
  const returnPlan = createReturnPlan({
    taskBudget,
    routeEstimate: createRouteEstimate({
      fallbackTravelMs: 1000,
      observedTravelMs: 3000,
      safetyMultiplier: 2,
      overheadMs: 500,
    }),
  }, 4000);

  const decision = evaluateMissionCheckpoint({
    taskBudget,
    returnPlan,
    inventoryCounts: { cod: 64 },
    trackedItems: ['cod'],
    depositPolicy: { minTrackedItemCount: 1 },
  }, 5000);

  assert.equal(decision.action, 'return');
  assert.equal(decision.reason, 'return-reserve-reached');
  assert.equal(decision.taskBudget.returnReserveMs, 6500);
  assert.equal(decision.taskBudget.returnByRemainingMs, -500);
  assert.equal(decision.checkpoint.returnPlan.reserveMs, 6500);
  assert.equal(decision.checkpoint.returnPlan.returnDue, true);
});

test('mission checkpoint fails safe without a bounded task budget', () => {
  assert.deepEqual(evaluateMissionCheckpoint({
    inventoryCounts: { cod: 64 },
    trackedItems: ['cod'],
    depositPolicy: { minTrackedItemCount: 1 },
  }, 1000), {
    action: 'stop',
    reason: 'missing-task-budget',
    taskBudget: null,
    checkpoint: {
      nowMs: 1000,
      trackedCounts: { cod: 64 },
      trackedTotal: 64,
    },
  });
});

test('runMissionLoop resumes work after a deposit checkpoint and returns on reserve', async () => {
  let nowMs = 1000;
  let caught = 0;
  let lastDepositAtMs = 1000;
  const deposits = [];
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 1000);

  const result = await runMissionLoop({
    now: () => nowMs,
    maxIterations: 10,
    getState: () => ({
      taskBudget,
      inventoryCounts: { cod: caught },
      trackedItems: ['cod'],
      lastDepositAtMs,
      depositPolicy: { minTrackedItemCount: 2 },
    }),
    work: async () => {
      caught += 1;
      nowMs += caught === 1 ? 1000 : 6000;
      return { ok: true, reason: `caught cod ${caught}` };
    },
    deposit: async ({ depositItems }) => {
      deposits.push({ ...depositItems });
      caught = 0;
      lastDepositAtMs = nowMs;
      return { ok: true, reason: 'deposited catches' };
    },
    returnHome: async () => ({ ok: true, reason: 'returned home' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'return-reserve-reached');
  assert.deepEqual(deposits, [{ cod: 2 }]);
  assert.deepEqual(result.events.map((event) => event.action), [
    'continue',
    'work',
    'continue',
    'work',
    'deposit',
    'deposit',
    'continue',
    'work',
    'return',
    'returnHome',
  ]);
});

test('runMissionLoop reports preempted work without turning it into a failure', async () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 0);
  const result = await runMissionLoop({
    now: () => 1000,
    getState: () => ({ taskBudget }),
    work: async () => ({ preempted: true, reason: 'reactive preempt during mission work' }),
  });

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during mission work');
});

test('runMissionLoop fails closed when deposit or return handlers are missing', async () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 0);
  const depositMissing = await runMissionLoop({
    now: () => 1000,
    getState: () => ({
      taskBudget,
      inventoryCounts: { cod: 2 },
      trackedItems: ['cod'],
      depositPolicy: { minTrackedItemCount: 2 },
    }),
    work: async () => ({ ok: true }),
  });
  assert.equal(depositMissing.ok, false);
  assert.equal(depositMissing.reason, 'mission deposit requested but no deposit handler is configured');

  const returnMissing = await runMissionLoop({
    now: () => 9000,
    getState: () => ({ taskBudget }),
    work: async () => ({ ok: true }),
  });
  assert.equal(returnMissing.ok, false);
  assert.equal(returnMissing.reason, 'mission return requested but no returnHome handler is configured');
});

test('runMissionLoop bounds infinite continue loops', async () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 2000 }, 0);
  const result = await runMissionLoop({
    now: () => 1000,
    maxIterations: 2,
    getState: () => ({ taskBudget }),
    work: async () => ({ ok: true, reason: 'still working' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mission iteration limit reached after 2 checkpoints');
  assert.equal(result.events.filter((event) => event.action === 'work').length, 2);
});
