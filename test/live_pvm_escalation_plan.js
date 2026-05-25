export const PVM_ESCALATION_WAVES = Object.freeze([
  Object.freeze({
    label: 'single-engage',
    count: 1,
    offset: Object.freeze({ dx: 4, dy: 0, dz: 0 }),
  }),
  Object.freeze({
    label: 'three-overwhelm',
    count: 3,
    offset: Object.freeze({ dx: 1, dy: 0, dz: 0 }),
  }),
]);

export function pvmEscalationExpectedSpawnCount(waves = PVM_ESCALATION_WAVES) {
  return waves.reduce((sum, wave) => sum + wave.count, 0);
}

export function pvmEscalationSpawnArgs(botPosition, wave) {
  if (!botPosition) throw new Error('cannot spawn PvM escalation wave before bot position is available');
  const offset = wave?.offset || {};
  return [
    String(wave.count),
    formatCoordinate(botPosition.x + (offset.dx || 0)),
    formatCoordinate(Math.floor(botPosition.y) + (offset.dy || 0)),
    formatCoordinate(botPosition.z + (offset.dz || 0)),
  ];
}

export function evaluatePvmEscalationMetrics(metrics, opts = {}) {
  const expectedWaves = opts.expectedWaves ?? PVM_ESCALATION_WAVES.length;
  const expectedSpawnCount = opts.expectedSpawnCount ?? pvmEscalationExpectedSpawnCount();
  const criticalHealth = opts.criticalHealth ?? 4;
  const maxWaterEscapeEntries = opts.maxWaterEscapeEntries ?? 3;
  const maxStateChanges = opts.maxStateChanges ?? 24;
  const minNormalAfterFleeDistance = opts.minNormalAfterFleeDistance ?? null;

  if ((metrics?.wavesSpawned || 0) < expectedWaves) {
    return { ok: false, reason: `expected ${expectedWaves} PvM escalation waves; spawned ${metrics?.wavesSpawned || 0}` };
  }
  if ((metrics?.spawnedHostiles || 0) < expectedSpawnCount) {
    return { ok: false, reason: `expected ${expectedSpawnCount} spawned hostiles; spawned ${metrics?.spawnedHostiles || 0}` };
  }
  if (!metrics?.sawEngagingBeforeEscalation) {
    return { ok: false, reason: 'expected ENGAGING before PvM escalation wave' };
  }
  if (!metrics?.sawFleeingAfterEscalation) {
    return { ok: false, reason: 'expected FLEEING after PvM escalation wave' };
  }
  if (!metrics?.sawTooManyHostilesPolicy) {
    return { ok: false, reason: 'expected combat policy to report too-many-hostiles after escalation' };
  }
  if (!metrics?.sawNormalAfterFlee) {
    return { ok: false, reason: 'expected NORMAL after FLEEING during PvM escalation' };
  }
  if (opts.requireFinalEscape !== false && !metrics?.finalEscapeObserved) {
    return { ok: false, reason: 'expected final escape before PvM escalation completion' };
  }
  if ((metrics?.pathfinderActiveFleeSamples || 0) <= 0) {
    return { ok: false, reason: 'expected active pathfinder samples while FLEEING after escalation' };
  }
  if (typeof metrics?.minHealth === 'number' && metrics.minHealth <= criticalHealth) {
    return { ok: false, reason: `health reached critical threshold during PvM escalation: ${metrics.minHealth}` };
  }
  if ((metrics?.waterEscapeEntries || 0) > maxWaterEscapeEntries) {
    return { ok: false, reason: `water escape churn ${metrics.waterEscapeEntries} > ${maxWaterEscapeEntries}` };
  }
  if ((metrics?.stateChanges || 0) > maxStateChanges) {
    return { ok: false, reason: `state churn ${metrics.stateChanges} > ${maxStateChanges}` };
  }
  if (
    typeof minNormalAfterFleeDistance === 'number'
    && typeof metrics?.normalAfterFleeNearestDistance === 'number'
    && metrics.normalAfterFleeNearestDistance < minNormalAfterFleeDistance
  ) {
    return {
      ok: false,
      reason: `NORMAL after FLEEING was still inside de-aggro radius: ${metrics.normalAfterFleeNearestDistance} < ${minNormalAfterFleeDistance}`,
    };
  }
  return { ok: true };
}

function formatCoordinate(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
