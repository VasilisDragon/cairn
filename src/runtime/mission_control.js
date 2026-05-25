import { evaluateTaskBudget } from './task_budget.js';
import { applyReturnPlanToTaskBudget, compactReturnPlan } from './mission_return.js';

export async function runMissionLoop(options = {}) {
  const {
    getState,
    work,
    deposit,
    returnHome,
    stop,
    now = Date.now,
    maxIterations = 1000,
    signal,
  } = options;
  if (typeof getState !== 'function') throw new Error('runMissionLoop requires getState');
  if (typeof work !== 'function') throw new Error('runMissionLoop requires work');
  const events = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (signal?.aborted) return missionPreempted('mission aborted before checkpoint', events);
    const state = await getState({ iteration, events });
    const decision = evaluateMissionCheckpoint(state, now());
    events.push(compactMissionEvent({ iteration, action: decision.action, reason: decision.reason, checkpoint: decision.checkpoint }));

    if (decision.action === 'stop') {
      if (typeof stop === 'function') {
        const result = await stop({ iteration, decision, events });
        if (result?.preempted) return missionPreempted(result.reason || 'mission stop preempted', events, result);
        if (result?.ok === false) return missionFailed(result.reason || decision.reason, events, result, decision);
      }
      return { ok: false, reason: decision.reason, decision, events };
    }

    if (decision.action === 'return') {
      if (typeof returnHome !== 'function') return missionFailed('mission return requested but no returnHome handler is configured', events, null, decision);
      const result = await returnHome({ iteration, decision, events });
      events.push(compactMissionEvent({ iteration, action: 'returnHome', result }));
      if (result?.preempted) return missionPreempted(result.reason || decision.reason, events, result);
      if (result?.ok === false) return missionFailed(result.reason || decision.reason, events, result, decision);
      return { ok: true, reason: decision.reason, decision, result, events };
    }

    if (decision.action === 'deposit') {
      if (typeof deposit !== 'function') return missionFailed('mission deposit requested but no deposit handler is configured', events, null, decision);
      const result = await deposit({ iteration, decision, depositItems: decision.depositItems || {}, events });
      events.push(compactMissionEvent({ iteration, action: 'deposit', result, depositItems: decision.depositItems }));
      if (result?.preempted) return missionPreempted(result.reason || decision.reason, events, result);
      if (result?.ok === false) return missionFailed(result.reason || decision.reason, events, result, decision);
      continue;
    }

    const result = await work({ iteration, decision, events });
    events.push(compactMissionEvent({ iteration, action: 'work', result }));
    if (result?.preempted) return missionPreempted(result.reason || 'mission work preempted', events, result);
    if (result?.ok === false) return missionFailed(result.reason || 'mission work failed', events, result, decision);
    if (result?.done) return { ok: true, reason: result.reason || 'mission complete', decision, result, events };
  }

  return { ok: false, reason: `mission iteration limit reached after ${maxIterations} checkpoints`, events };
}

export function evaluateMissionCheckpoint(input = {}, nowMs = Date.now()) {
  const checkpoint = compactCheckpoint(input, nowMs);
  if (input.returnPlan?.ok === false) {
    return {
      action: 'stop',
      reason: `unsafe-return-plan: ${input.returnPlan.reason}`,
      taskBudget: null,
      checkpoint,
    };
  }
  const taskBudget = input.returnPlan
    ? applyReturnPlanToTaskBudget(input.taskBudget, input.returnPlan)
    : input.taskBudget;
  const budgetDecision = input.budgetDecision || evaluateTaskBudget(taskBudget, nowMs);
  if (budgetDecision.action === 'stop') {
    return {
      action: 'stop',
      reason: budgetDecision.reason,
      taskBudget: budgetDecision.taskBudget,
      checkpoint,
    };
  }
  if (budgetDecision.action === 'return') {
    return {
      action: 'return',
      reason: budgetDecision.reason,
      taskBudget: budgetDecision.taskBudget,
      checkpoint,
    };
  }

  const trackedTotal = checkpoint.trackedTotal;
  const minTrackedItemCount = positiveNumberOrNull(input.depositPolicy?.minTrackedItemCount);
  if (minTrackedItemCount !== null && trackedTotal >= minTrackedItemCount) {
    return {
      action: 'deposit',
      reason: 'tracked-item-count-reached',
      taskBudget: budgetDecision.taskBudget,
      checkpoint,
      depositItems: checkpoint.trackedCounts,
    };
  }

  const maxUsedSlots = positiveNumberOrNull(input.depositPolicy?.maxUsedSlots);
  if (maxUsedSlots !== null && Number.isFinite(input.usedSlots) && input.usedSlots >= maxUsedSlots && trackedTotal > 0) {
    return {
      action: 'deposit',
      reason: 'inventory-pressure',
      taskBudget: budgetDecision.taskBudget,
      checkpoint,
      depositItems: checkpoint.trackedCounts,
    };
  }

  const depositEveryMs = positiveNumberOrNull(input.depositPolicy?.depositEveryMs);
  const lastDepositAtMs = numberOrNull(input.lastDepositAtMs ?? input.startedAtMs);
  if (
    depositEveryMs !== null
    && lastDepositAtMs !== null
    && trackedTotal > 0
    && nowMs - lastDepositAtMs >= depositEveryMs
  ) {
    return {
      action: 'deposit',
      reason: 'deposit-interval-reached',
      taskBudget: budgetDecision.taskBudget,
      checkpoint,
      depositItems: checkpoint.trackedCounts,
    };
  }

  return {
    action: 'continue',
    reason: 'within-mission-bounds',
    taskBudget: budgetDecision.taskBudget,
    checkpoint,
  };
}

function missionPreempted(reason, events, result = null) {
  return { preempted: true, reason, ...(result ? { result } : {}), events };
}

function missionFailed(reason, events, result = null, decision = null) {
  return {
    ok: false,
    reason,
    ...(decision ? { decision } : {}),
    ...(result ? { result } : {}),
    events,
  };
}

function compactMissionEvent(event) {
  const out = {
    iteration: event.iteration,
    action: event.action,
  };
  if (event.reason) out.reason = String(event.reason);
  if (event.depositItems && Object.keys(event.depositItems).length > 0) out.depositItems = event.depositItems;
  if (event.checkpoint) {
    out.checkpoint = {
      trackedTotal: event.checkpoint.trackedTotal,
      ...(event.checkpoint.returnPlan ? { returnPlan: event.checkpoint.returnPlan } : {}),
      ...(Number.isFinite(event.checkpoint.usedSlots) ? { usedSlots: event.checkpoint.usedSlots } : {}),
      ...(Number.isFinite(event.checkpoint.lastDepositAgeMs) ? { lastDepositAgeMs: event.checkpoint.lastDepositAgeMs } : {}),
    };
  }
  if (event.result) {
    out.result = {
      ...(typeof event.result.ok === 'boolean' ? { ok: event.result.ok } : {}),
      ...(event.result.preempted === true ? { preempted: true } : {}),
      ...(event.result.done === true ? { done: true } : {}),
      ...(event.result.reason ? { reason: String(event.result.reason) } : {}),
    };
  }
  return out;
}

function compactCheckpoint(input, nowMs) {
  const trackedCounts = pickTrackedCounts(input.inventoryCounts, input.trackedItems);
  const trackedTotal = Object.values(trackedCounts).reduce((sum, count) => sum + count, 0);
  const lastDepositAtMs = numberOrNull(input.lastDepositAtMs ?? input.startedAtMs);
  const returnPlan = input.returnPlan ? compactReturnPlan(input.returnPlan, nowMs) : null;
  return {
    nowMs,
    trackedCounts,
    trackedTotal,
    ...(returnPlan ? { returnPlan } : {}),
    ...(Number.isFinite(input.usedSlots) ? { usedSlots: Math.max(0, Math.round(input.usedSlots)) } : {}),
    ...(lastDepositAtMs !== null ? {
      lastDepositAgeMs: Math.max(0, Math.round(nowMs - lastDepositAtMs)),
    } : {}),
  };
}

function pickTrackedCounts(counts, trackedItems) {
  if (!counts || typeof counts !== 'object') return {};
  const tracked = Array.isArray(trackedItems) && trackedItems.length > 0
    ? new Set(trackedItems.map((item) => String(item)))
    : null;
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([name, count]) => (!tracked || tracked.has(name)) && Number.isFinite(count) && count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => [name, Math.round(count)]),
  );
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function positiveNumberOrNull(value) {
  const number = numberOrNull(value);
  return number !== null && number > 0 ? number : null;
}
