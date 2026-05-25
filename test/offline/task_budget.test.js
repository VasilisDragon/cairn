import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactTaskBudget,
  createTaskBudget,
  evaluateTaskBudget,
  phaseTaskBudget,
} from '../../src/runtime/task_budget.js';

test('createTaskBudget derives deadline and return-by times deterministically', () => {
  const budget = createTaskBudget({
    label: 'mining_soak',
    phase: 'mine',
    durationMs: 10000,
    returnReserveMs: 2500,
  }, 1000);

  assert.deepEqual(budget, {
    label: 'mining_soak',
    phase: 'mine',
    startedAtMs: 1000,
    durationMs: 10000,
    deadlineAtMs: 11000,
    returnReserveMs: 2500,
    returnByMs: 8500,
  });
});

test('compactTaskBudget reports elapsed, deadline, and return reserve context', () => {
  const budget = createTaskBudget({
    label: 'fishing',
    phase: 'fish',
    durationMs: 10000,
    returnReserveMs: 2500,
    attempts: 2,
  }, 1000);

  assert.deepEqual(compactTaskBudget(budget, 4500), {
    label: 'fishing',
    phase: 'fish',
    attempts: 2,
    elapsedMs: 3500,
    durationMs: 10000,
    deadlineRemainingMs: 6500,
    overdue: false,
    returnReserveMs: 2500,
    returnByRemainingMs: 4000,
    returnDue: false,
  });
});

test('evaluateTaskBudget continues before return reserve, returns at reserve, and stops after deadline', () => {
  const budget = createTaskBudget({
    durationMs: 10000,
    returnReserveMs: 2500,
  }, 1000);

  assert.deepEqual(evaluateTaskBudget(budget, 4000), {
    action: 'continue',
    reason: 'within-budget',
    taskBudget: {
      elapsedMs: 3000,
      durationMs: 10000,
      deadlineRemainingMs: 7000,
      overdue: false,
      returnReserveMs: 2500,
      returnByRemainingMs: 4500,
      returnDue: false,
    },
  });

  assert.deepEqual(evaluateTaskBudget(budget, 8500), {
    action: 'return',
    reason: 'return-reserve-reached',
    taskBudget: {
      elapsedMs: 7500,
      durationMs: 10000,
      deadlineRemainingMs: 2500,
      overdue: false,
      returnReserveMs: 2500,
      returnByRemainingMs: 0,
      returnDue: true,
    },
  });

  assert.deepEqual(evaluateTaskBudget(budget, 11001), {
    action: 'stop',
    reason: 'deadline-overdue',
    taskBudget: {
      elapsedMs: 10001,
      durationMs: 10000,
      deadlineRemainingMs: -1,
      overdue: true,
      returnReserveMs: 2500,
      returnByRemainingMs: -2501,
      returnDue: true,
    },
  });
});

test('evaluateTaskBudget fails safe when mission deadline context is missing', () => {
  assert.deepEqual(evaluateTaskBudget(null, 1000), {
    action: 'stop',
    reason: 'missing-task-budget',
    taskBudget: null,
  });

  assert.deepEqual(evaluateTaskBudget({ label: 'unbounded', startedAtMs: 100 }, 1000), {
    action: 'stop',
    reason: 'missing-task-deadline',
    taskBudget: {
      label: 'unbounded',
      elapsedMs: 900,
    },
  });
});

test('phaseTaskBudget changes only the compact phase label', () => {
  const budget = createTaskBudget({ label: 'mine', phase: 'prepare', durationMs: 1000 }, 0);
  assert.equal(budget.phase, 'prepare');
  assert.equal(phaseTaskBudget(budget, 'return').phase, 'return');
  assert.equal(budget.phase, 'prepare');
  assert.equal(phaseTaskBudget(budget, '').phase, 'prepare');
});
