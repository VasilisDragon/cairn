const DEFAULT_ROUTE_SAFETY_MULTIPLIER = 1.5;
const MAX_ROUTE_OBSERVATIONS = 8;

export function createRouteEstimate(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const observations = normalizeObservations(source.observations);
  const directObservedMs = maxNumber([
    nonNegativeNumberOrNull(source.observedTravelMs),
    nonNegativeNumberOrNull(source.outboundTravelMs),
    nonNegativeNumberOrNull(source.returnTravelMs),
    nonNegativeNumberOrNull(source.lastTravelMs),
  ]);
  const observedTravelMs = maxNumber([
    directObservedMs,
    ...observations.map((observation) => observation.travelMs),
  ]);
  const fallbackTravelMs = nonNegativeNumberOrNull(
    source.fallbackTravelMs
      ?? source.minTravelMs
      ?? source.returnReserveMs,
  ) ?? 0;
  const safetyMultiplier = positiveNumberOrNull(source.safetyMultiplier) ?? DEFAULT_ROUTE_SAFETY_MULTIPLIER;
  const overheadMs = nonNegativeNumberOrNull(source.overheadMs ?? source.returnOverheadMs) ?? 0;
  const observedReserveMs = observedTravelMs !== null
    ? Math.ceil(observedTravelMs * safetyMultiplier + overheadMs)
    : null;
  const estimatedTravelMs = Math.max(Math.round(fallbackTravelMs), observedReserveMs ?? 0);
  return {
    fallbackTravelMs: Math.round(fallbackTravelMs),
    ...(observedTravelMs !== null ? { observedTravelMs: Math.round(observedTravelMs) } : {}),
    safetyMultiplier,
    overheadMs: Math.round(overheadMs),
    estimatedTravelMs,
    observations,
  };
}

export function observeRouteTravel(estimate = {}, observation = {}) {
  const source = estimate && typeof estimate === 'object' ? estimate : {};
  const observations = Array.isArray(source.observations) ? source.observations : [];
  return createRouteEstimate({
    ...source,
    observations: [...observations, observation],
  });
}

export function createReturnPlan(input = {}, nowMs = Date.now()) {
  const source = input && typeof input === 'object' ? input : {};
  const taskBudget = source.taskBudget && typeof source.taskBudget === 'object'
    ? source.taskBudget
    : source;
  const startedAtMs = numberOrNull(source.startedAtMs ?? taskBudget.startedAtMs ?? taskBudget.startTimeMs);
  const deadlineAtMs = numberOrNull(source.deadlineAtMs ?? taskBudget.deadlineAtMs);
  const minReserveMs = nonNegativeNumberOrNull(
    source.minReserveMs
      ?? source.returnReserveMs
      ?? taskBudget.returnReserveMs,
  ) ?? 0;
  const maxReserveMs = nonNegativeNumberOrNull(source.maxReserveMs);
  const routeEstimate = createRouteEstimate(routeEstimateInput(source, minReserveMs));
  const reason = unsafeReturnPlanReason({
    startedAtMs,
    deadlineAtMs,
    minReserveMs,
    maxReserveMs,
  });
  if (reason) {
    return {
      ok: false,
      reason,
      ...(startedAtMs !== null ? { startedAtMs: Math.round(startedAtMs) } : {}),
      ...(deadlineAtMs !== null ? { deadlineAtMs: Math.round(deadlineAtMs) } : {}),
      minReserveMs: Math.round(minReserveMs),
      ...(maxReserveMs !== null ? { maxReserveMs: Math.round(maxReserveMs) } : {}),
      routeEstimate,
    };
  }

  let reserveMs = Math.max(Math.round(minReserveMs), routeEstimate.estimatedTravelMs);
  if (maxReserveMs !== null) reserveMs = Math.min(reserveMs, Math.round(maxReserveMs));
  const returnByMs = Math.round(deadlineAtMs - reserveMs);
  if (returnByMs <= startedAtMs) {
    return {
      ok: false,
      reason: 'returnByMs must be after startedAtMs',
      startedAtMs: Math.round(startedAtMs),
      deadlineAtMs: Math.round(deadlineAtMs),
      minReserveMs: Math.round(minReserveMs),
      ...(maxReserveMs !== null ? { maxReserveMs: Math.round(maxReserveMs) } : {}),
      reserveMs,
      returnByMs,
      routeEstimate,
    };
  }

  const expectedArriveByMs = Math.round(returnByMs + routeEstimate.estimatedTravelMs);
  const deadlineRemainingMs = Math.round(deadlineAtMs - nowMs);
  const returnByRemainingMs = Math.round(returnByMs - nowMs);
  const plan = {
    ok: true,
    ...(taskBudget.label ? { label: String(taskBudget.label) } : {}),
    ...(taskBudget.phase ? { phase: String(taskBudget.phase) } : {}),
    startedAtMs: Math.round(startedAtMs),
    deadlineAtMs: Math.round(deadlineAtMs),
    minReserveMs: Math.round(minReserveMs),
    ...(maxReserveMs !== null ? { maxReserveMs: Math.round(maxReserveMs) } : {}),
    reserveMs,
    returnByMs,
    expectedArriveByMs,
    expectedArrivalSlackMs: Math.round(deadlineAtMs - expectedArriveByMs),
    deadlineRemainingMs,
    overdue: deadlineRemainingMs <= 0,
    returnByRemainingMs,
    returnDue: returnByRemainingMs <= 0,
    routeEstimate,
  };
  plan.summary = compactReturnPlan(plan, nowMs);
  return plan;
}

export function evaluateReturnPlan(input = {}, nowMs = Date.now()) {
  const plan = input?.ok === true || input?.ok === false ? input : createReturnPlan(input, nowMs);
  if (!plan.ok) {
    return {
      action: 'stop',
      reason: `unsafe-return-plan: ${plan.reason}`,
      returnPlan: compactReturnPlan(plan, nowMs),
    };
  }
  if (plan.overdue === true || nowMs >= plan.deadlineAtMs) {
    return {
      action: 'stop',
      reason: 'deadline-overdue',
      returnPlan: compactReturnPlan(plan, nowMs),
    };
  }
  if (plan.returnDue === true || nowMs >= plan.returnByMs) {
    return {
      action: 'return',
      reason: 'return-plan-due',
      returnPlan: compactReturnPlan(plan, nowMs),
    };
  }
  return {
    action: 'continue',
    reason: 'within-return-plan',
    returnPlan: compactReturnPlan(plan, nowMs),
  };
}

export function applyReturnPlanToTaskBudget(taskBudget, returnPlan) {
  if (!taskBudget || typeof taskBudget !== 'object') return taskBudget;
  if (!returnPlan?.ok) return taskBudget;
  return {
    ...taskBudget,
    returnReserveMs: returnPlan.reserveMs,
    returnByMs: returnPlan.returnByMs,
  };
}

export function compactReturnPlan(plan, nowMs = Date.now()) {
  if (!plan || typeof plan !== 'object') return null;
  if (plan.ok === false) {
    return {
      ok: false,
      ...(plan.reason ? { reason: String(plan.reason) } : {}),
      ...(Number.isFinite(plan.minReserveMs) ? { minReserveMs: Math.round(plan.minReserveMs) } : {}),
      ...(Number.isFinite(plan.reserveMs) ? { reserveMs: Math.round(plan.reserveMs) } : {}),
      routeEstimate: compactRouteEstimate(plan.routeEstimate),
    };
  }
  const deadlineAtMs = numberOrNull(plan.deadlineAtMs);
  const returnByMs = numberOrNull(plan.returnByMs);
  const deadlineRemainingMs = deadlineAtMs !== null ? Math.round(deadlineAtMs - nowMs) : null;
  const returnByRemainingMs = returnByMs !== null ? Math.round(returnByMs - nowMs) : null;
  return {
    ok: true,
    ...(plan.label ? { label: String(plan.label) } : {}),
    ...(plan.phase ? { phase: String(plan.phase) } : {}),
    ...(Number.isFinite(plan.reserveMs) ? { reserveMs: Math.round(plan.reserveMs) } : {}),
    ...(Number.isFinite(plan.expectedArrivalSlackMs) ? { expectedArrivalSlackMs: Math.round(plan.expectedArrivalSlackMs) } : {}),
    ...(deadlineRemainingMs !== null ? {
      deadlineRemainingMs,
      overdue: deadlineRemainingMs <= 0,
    } : {}),
    ...(returnByRemainingMs !== null ? {
      returnByRemainingMs,
      returnDue: returnByRemainingMs <= 0,
    } : {}),
    routeEstimate: compactRouteEstimate(plan.routeEstimate),
  };
}

function routeEstimateInput(source, minReserveMs) {
  const routeSource = source.routeEstimate && typeof source.routeEstimate === 'object'
    ? { ...source.routeEstimate }
    : { ...source };
  if (!Number.isFinite(routeSource.fallbackTravelMs)) routeSource.fallbackTravelMs = minReserveMs;
  if (source.safetyMultiplier !== undefined) routeSource.safetyMultiplier = source.safetyMultiplier;
  if (source.overheadMs !== undefined) routeSource.overheadMs = source.overheadMs;
  return routeSource;
}

function unsafeReturnPlanReason({ startedAtMs, deadlineAtMs, minReserveMs, maxReserveMs }) {
  if (!Number.isFinite(startedAtMs)) return 'startedAtMs must be finite';
  if (!Number.isFinite(deadlineAtMs)) return 'deadlineAtMs must be finite';
  if (!Number.isFinite(minReserveMs) || minReserveMs < 0) return 'minReserveMs must be >= 0';
  if (maxReserveMs !== null && maxReserveMs < minReserveMs) return 'maxReserveMs must be >= minReserveMs';
  return null;
}

function compactRouteEstimate(estimate) {
  if (!estimate || typeof estimate !== 'object') return null;
  return {
    fallbackTravelMs: Math.round(nonNegativeNumberOrNull(estimate.fallbackTravelMs) ?? 0),
    ...(Number.isFinite(estimate.observedTravelMs) ? { observedTravelMs: Math.round(estimate.observedTravelMs) } : {}),
    safetyMultiplier: positiveNumberOrNull(estimate.safetyMultiplier) ?? DEFAULT_ROUTE_SAFETY_MULTIPLIER,
    overheadMs: Math.round(nonNegativeNumberOrNull(estimate.overheadMs) ?? 0),
    estimatedTravelMs: Math.round(nonNegativeNumberOrNull(estimate.estimatedTravelMs) ?? 0),
    observations: Array.isArray(estimate.observations) ? estimate.observations.length : 0,
  };
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) return [];
  return observations
    .map(normalizeObservation)
    .filter(Boolean)
    .slice(-MAX_ROUTE_OBSERVATIONS);
}

function normalizeObservation(observation) {
  if (!observation || typeof observation !== 'object') return null;
  const startedAtMs = numberOrNull(observation.startedAtMs ?? observation.startTimeMs);
  const endedAtMs = numberOrNull(observation.endedAtMs ?? observation.endTimeMs);
  const travelMs = nonNegativeNumberOrNull(
    observation.travelMs
      ?? observation.durationMs
      ?? (startedAtMs !== null && endedAtMs !== null ? endedAtMs - startedAtMs : null),
  );
  if (travelMs === null) return null;
  return {
    ...(observation.label ? { label: String(observation.label) } : {}),
    travelMs: Math.round(travelMs),
    ...(startedAtMs !== null ? { startedAtMs: Math.round(startedAtMs) } : {}),
    ...(endedAtMs !== null ? { endedAtMs: Math.round(endedAtMs) } : {}),
  };
}

function maxNumber(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function nonNegativeNumberOrNull(value) {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveNumberOrNull(value) {
  const number = numberOrNull(value);
  return number !== null && number > 0 ? number : null;
}
