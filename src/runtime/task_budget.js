export function createTaskBudget(input = {}, nowMs = Date.now()) {
  const source = input && typeof input === 'object' ? input : {};
  const startedAtMs = numberOrNull(source.startedAtMs ?? source.startTimeMs) ?? nowMs;
  const durationMs = nonNegativeNumberOrNull(source.durationMs);
  const deadlineAtMs = numberOrNull(source.deadlineAtMs)
    ?? (durationMs !== null ? startedAtMs + durationMs : null);
  const returnReserveMs = nonNegativeNumberOrNull(source.returnReserveMs);
  const returnByMs = numberOrNull(source.returnByMs)
    ?? (deadlineAtMs !== null && returnReserveMs !== null ? deadlineAtMs - returnReserveMs : null);
  const attempts = numberOrNull(source.attempts);
  return {
    ...(source.label ? { label: String(source.label) } : {}),
    ...(source.phase ? { phase: String(source.phase) } : {}),
    startedAtMs,
    ...(durationMs !== null ? { durationMs: Math.round(durationMs) } : {}),
    ...(deadlineAtMs !== null ? { deadlineAtMs: Math.round(deadlineAtMs) } : {}),
    ...(returnReserveMs !== null ? { returnReserveMs: Math.round(returnReserveMs) } : {}),
    ...(returnByMs !== null ? { returnByMs: Math.round(returnByMs) } : {}),
    ...(attempts !== null ? { attempts: Math.max(0, Math.round(attempts)) } : {}),
  };
}

export function phaseTaskBudget(input, phase) {
  const budget = input && typeof input === 'object' ? input : {};
  return {
    ...budget,
    ...(phase ? { phase: String(phase) } : {}),
  };
}

export function compactTaskBudget(input, nowMs = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  const startedAtMs = numberOrNull(input.startedAtMs ?? input.startTimeMs);
  const durationMs = nonNegativeNumberOrNull(input.durationMs);
  const deadlineAtMs = numberOrNull(input.deadlineAtMs)
    ?? (startedAtMs !== null && durationMs !== null ? startedAtMs + durationMs : null);
  const returnReserveMs = nonNegativeNumberOrNull(input.returnReserveMs);
  const returnByMs = numberOrNull(input.returnByMs)
    ?? (deadlineAtMs !== null && returnReserveMs !== null ? deadlineAtMs - returnReserveMs : null);
  const attempts = numberOrNull(input.attempts);
  const elapsedMs = startedAtMs !== null ? Math.max(0, Math.round(nowMs - startedAtMs)) : null;
  const deadlineRemainingMs = deadlineAtMs !== null ? Math.round(deadlineAtMs - nowMs) : null;
  const returnByRemainingMs = returnByMs !== null ? Math.round(returnByMs - nowMs) : null;
  const budget = {
    ...(input.label ? { label: String(input.label) } : {}),
    ...(input.phase ? { phase: String(input.phase) } : {}),
    ...(attempts !== null ? { attempts: Math.max(0, Math.round(attempts)) } : {}),
    ...(elapsedMs !== null ? { elapsedMs } : {}),
    ...(durationMs !== null ? { durationMs: Math.round(durationMs) } : {}),
    ...(deadlineRemainingMs !== null ? {
      deadlineRemainingMs,
      overdue: deadlineRemainingMs <= 0,
    } : {}),
    ...(returnReserveMs !== null ? { returnReserveMs: Math.round(returnReserveMs) } : {}),
    ...(returnByRemainingMs !== null ? {
      returnByRemainingMs,
      returnDue: returnByRemainingMs <= 0,
    } : {}),
  };
  return Object.keys(budget).length > 0 ? budget : null;
}

export function evaluateTaskBudget(input, nowMs = Date.now()) {
  const budget = compactTaskBudget(input, nowMs);
  if (!budget) {
    return {
      action: 'stop',
      reason: 'missing-task-budget',
      taskBudget: null,
    };
  }
  if (!Number.isFinite(budget.deadlineRemainingMs) && !Number.isFinite(budget.returnByRemainingMs)) {
    return {
      action: 'stop',
      reason: 'missing-task-deadline',
      taskBudget: budget,
    };
  }
  if (budget.overdue === true) {
    return {
      action: 'stop',
      reason: 'deadline-overdue',
      taskBudget: budget,
    };
  }
  if (budget.returnDue === true) {
    return {
      action: 'return',
      reason: 'return-reserve-reached',
      taskBudget: budget,
    };
  }
  return {
    action: 'continue',
    reason: 'within-budget',
    taskBudget: budget,
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function nonNegativeNumberOrNull(value) {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}
