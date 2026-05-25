import { compactTaskBudget, createTaskBudget } from './task_budget.js';

export function createMissionProfile(input = {}, nowMs = Date.now()) {
  const source = input && typeof input === 'object' ? input : {};
  const taskBudget = createTaskBudget(source, nowMs);
  const depositIntervalMs = normalizeDepositInterval(source.depositIntervalMs, taskBudget);
  const reason = unsafeMissionProfileReason(taskBudget, depositIntervalMs);
  const profile = {
    ...(source.label ? { label: String(source.label) } : {}),
    ok: !reason,
    taskBudget,
    durationMs: taskBudget.durationMs,
    returnReserveMs: taskBudget.returnReserveMs,
    depositIntervalMs: depositIntervalMs ?? 0,
    summary: compactTaskBudget(taskBudget, nowMs),
  };
  if (reason) profile.reason = reason;
  return profile;
}

export function requireMissionProfile(input = {}, nowMs = Date.now()) {
  const profile = createMissionProfile(input, nowMs);
  if (!profile.ok) {
    const label = profile.label || input?.label || 'mission';
    throw new Error(`unsafe ${label} task budget: ${profile.reason}`);
  }
  return profile;
}

function unsafeMissionProfileReason(taskBudget, depositIntervalMs) {
  if (!Number.isFinite(taskBudget.durationMs) || taskBudget.durationMs <= 0) {
    return 'durationMs must be > 0';
  }
  if (!Number.isFinite(taskBudget.deadlineAtMs)) {
    return 'deadlineAtMs must be finite';
  }
  if (!Number.isFinite(taskBudget.returnReserveMs) || taskBudget.returnReserveMs < 0) {
    return 'returnReserveMs must be >= 0';
  }
  if (!Number.isFinite(taskBudget.returnByMs)) {
    return 'returnByMs must be finite';
  }
  if (taskBudget.returnByMs <= taskBudget.startedAtMs) {
    return 'returnByMs must be after startedAtMs';
  }
  if (!Number.isFinite(depositIntervalMs) || depositIntervalMs < 0) {
    return 'depositIntervalMs must be >= 0';
  }
  return null;
}

function normalizeDepositInterval(value, taskBudget) {
  if (value === undefined || value === null) {
    if (!Number.isFinite(taskBudget.durationMs) || !Number.isFinite(taskBudget.returnReserveMs)) return 0;
    return Math.max(0, Math.floor((taskBudget.durationMs - taskBudget.returnReserveMs) / 2));
  }
  return Number.isFinite(value) ? Math.round(value) : Number.NaN;
}
