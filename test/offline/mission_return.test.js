import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReturnPlanToTaskBudget,
  compactReturnPlan,
  createReturnPlan,
  createRouteEstimate,
  evaluateReturnPlan,
  observeRouteTravel,
} from '../../src/runtime/mission_return.js';
import { createTaskBudget } from '../../src/runtime/task_budget.js';

test('createRouteEstimate keeps the fallback reserve until observations require more', () => {
  assert.deepEqual(createRouteEstimate({
    fallbackTravelMs: 60000,
    safetyMultiplier: 2,
    overheadMs: 5000,
  }), {
    fallbackTravelMs: 60000,
    safetyMultiplier: 2,
    overheadMs: 5000,
    estimatedTravelMs: 60000,
    observations: [],
  });

  assert.deepEqual(createRouteEstimate({
    fallbackTravelMs: 60000,
    observedTravelMs: 40000,
    safetyMultiplier: 2,
    overheadMs: 5000,
  }), {
    fallbackTravelMs: 60000,
    observedTravelMs: 40000,
    safetyMultiplier: 2,
    overheadMs: 5000,
    estimatedTravelMs: 85000,
    observations: [],
  });
});

test('observeRouteTravel records bounded travel samples for return estimates', () => {
  let estimate = createRouteEstimate({ fallbackTravelMs: 10000, safetyMultiplier: 1.5, overheadMs: 1000 });
  estimate = observeRouteTravel(estimate, { label: 'chest-to-water', startedAtMs: 1000, endedAtMs: 5000 });
  estimate = observeRouteTravel(estimate, { label: 'water-to-chest', travelMs: 8000 });

  assert.deepEqual(estimate, {
    fallbackTravelMs: 10000,
    observedTravelMs: 8000,
    safetyMultiplier: 1.5,
    overheadMs: 1000,
    estimatedTravelMs: 13000,
    observations: [
      { label: 'chest-to-water', travelMs: 4000, startedAtMs: 1000, endedAtMs: 5000 },
      { label: 'water-to-chest', travelMs: 8000 },
    ],
  });
});

test('createReturnPlan derives a latest return start from deadline and route estimate', () => {
  const taskBudget = createTaskBudget({ label: 'mining', durationMs: 120000, returnReserveMs: 30000 }, 1000);
  const routeEstimate = createRouteEstimate({
    fallbackTravelMs: 30000,
    observedTravelMs: 50000,
    safetyMultiplier: 1.5,
    overheadMs: 5000,
  });
  const plan = createReturnPlan({ taskBudget, routeEstimate }, 20000);

  assert.equal(plan.ok, true);
  assert.equal(plan.reserveMs, 80000);
  assert.equal(plan.returnByMs, 41000);
  assert.equal(plan.expectedArriveByMs, 121000);
  assert.equal(plan.expectedArrivalSlackMs, 0);
  assert.equal(plan.returnDue, false);
  assert.equal(plan.summary.returnByRemainingMs, 21000);
  assert.deepEqual(compactReturnPlan(plan, 41000), {
    ok: true,
    label: 'mining',
    reserveMs: 80000,
    expectedArrivalSlackMs: 0,
    deadlineRemainingMs: 80000,
    overdue: false,
    returnByRemainingMs: 0,
    returnDue: true,
    routeEstimate: {
      fallbackTravelMs: 30000,
      observedTravelMs: 50000,
      safetyMultiplier: 1.5,
      overheadMs: 5000,
      estimatedTravelMs: 80000,
      observations: 0,
    },
  });
});

test('createReturnPlan rejects unsafe deadline and reserve combinations', () => {
  assert.equal(createReturnPlan({
    taskBudget: { startedAtMs: 0, returnReserveMs: 1000 },
  }, 0).reason, 'deadlineAtMs must be finite');

  assert.equal(createReturnPlan({
    taskBudget: { startedAtMs: 0, deadlineAtMs: 10000, returnReserveMs: 5000 },
    maxReserveMs: 1000,
  }, 0).reason, 'maxReserveMs must be >= minReserveMs');

  assert.equal(createReturnPlan({
    taskBudget: { startedAtMs: 0, deadlineAtMs: 10000, returnReserveMs: 10000 },
  }, 0).reason, 'returnByMs must be after startedAtMs');
});

test('evaluateReturnPlan and applyReturnPlanToTaskBudget expose mission-loop decisions', () => {
  const taskBudget = createTaskBudget({ durationMs: 10000, returnReserveMs: 1000 }, 0);
  const plan = createReturnPlan({
    taskBudget,
    routeEstimate: {
      fallbackTravelMs: 1000,
      observedTravelMs: 4000,
      safetyMultiplier: 1.5,
      overheadMs: 500,
    },
  }, 4500);

  assert.equal(evaluateReturnPlan(plan, 4500).action, 'return');
  assert.deepEqual(applyReturnPlanToTaskBudget(taskBudget, plan), {
    startedAtMs: 0,
    durationMs: 10000,
    deadlineAtMs: 10000,
    returnReserveMs: 6500,
    returnByMs: 3500,
  });
});
