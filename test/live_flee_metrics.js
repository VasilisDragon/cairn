export function createFleeFixtureMetrics(initialState = null) {
  return {
    previousState: initialState,
    sawFleeing: initialState === 'FLEEING',
    sawNormalAfterFlee: false,
    normalAfterFleeNearestDistance: null,
    maxTrackedHostileDistance: null,
    stateChanges: 0,
    waterEscapeEntries: initialState === 'WATER_ESCAPE' ? 1 : 0,
    pathfinderActiveFleeSamples: 0,
    fleeSamples: 0,
  };
}

export function observeFleeFixtureSample(metrics, sample) {
  const countStateChanges = sample?.countStateChanges !== false;
  const state = sample?.state || null;
  if (countStateChanges && state && metrics.previousState && state !== metrics.previousState) {
    metrics.stateChanges += 1;
    if (state === 'WATER_ESCAPE') metrics.waterEscapeEntries += 1;
  }
  if (countStateChanges && state && !metrics.previousState) {
    if (state === 'WATER_ESCAPE') metrics.waterEscapeEntries += 1;
  }
  metrics.previousState = state || metrics.previousState;

  if (state === 'FLEEING') {
    metrics.sawFleeing = true;
    metrics.fleeSamples += 1;
    if (sample?.pathfinderIdle === false) metrics.pathfinderActiveFleeSamples += 1;
  }
  if (typeof sample?.nearestDistance === 'number') {
    metrics.maxTrackedHostileDistance = Math.max(metrics.maxTrackedHostileDistance ?? 0, sample.nearestDistance);
  }
  if (metrics.sawFleeing && state === 'NORMAL') {
    metrics.sawNormalAfterFlee = true;
    if (sample && Object.hasOwn(sample, 'nearestDistance')) {
      metrics.normalAfterFleeNearestDistance = typeof sample.nearestDistance === 'number'
        ? sample.nearestDistance
        : null;
    }
  }
  return metrics;
}

export function observeFleeFixtureTransition(metrics, transition) {
  if (!transition?.to) return metrics;
  metrics.stateChanges += 1;
  metrics.previousState = transition.to;
  if (transition.to === 'WATER_ESCAPE') metrics.waterEscapeEntries += 1;
  if (transition.to === 'FLEEING') metrics.sawFleeing = true;
  if (metrics.sawFleeing && transition.to === 'NORMAL') metrics.sawNormalAfterFlee = true;
  return metrics;
}

export function observeFleeFixtureTransitions(metrics, transitions = []) {
  for (const transition of transitions) observeFleeFixtureTransition(metrics, transition);
  return metrics;
}

export function evaluateFleeFixtureMetrics(metrics, opts = {}) {
  const maxStateChanges = opts.maxStateChanges ?? 8;
  const maxWaterEscapeEntries = opts.maxWaterEscapeEntries ?? 2;
  const minNormalAfterFleeDistance = opts.minNormalAfterFleeDistance ?? null;

  if (!metrics.sawFleeing) {
    return { ok: false, reason: 'expected FLEEING during monitor window' };
  }
  if (!metrics.sawNormalAfterFlee) {
    return { ok: false, reason: 'expected NORMAL after FLEEING during monitor window' };
  }
  if (metrics.pathfinderActiveFleeSamples <= 0) {
    return { ok: false, reason: 'expected at least one FLEEING sample with pathfinderIdle=false' };
  }
  if (
    typeof minNormalAfterFleeDistance === 'number'
    && typeof metrics.normalAfterFleeNearestDistance === 'number'
    && metrics.normalAfterFleeNearestDistance < minNormalAfterFleeDistance
  ) {
    return {
      ok: false,
      reason: `NORMAL after FLEEING was still inside de-aggro radius: ${metrics.normalAfterFleeNearestDistance} < ${minNormalAfterFleeDistance}`,
    };
  }
  if (metrics.waterEscapeEntries > maxWaterEscapeEntries) {
    return {
      ok: false,
      reason: `water escape churn ${metrics.waterEscapeEntries} > ${maxWaterEscapeEntries}`,
    };
  }
  if (metrics.stateChanges > maxStateChanges) {
    return {
      ok: false,
      reason: `state churn ${metrics.stateChanges} > ${maxStateChanges}`,
    };
  }
  return { ok: true };
}
