export const HOSTILE_ESCALATION_WAVES = Object.freeze([
  Object.freeze({
    label: 'single-near',
    count: 1,
    offset: Object.freeze({ dx: 4, dy: 0, dz: 0 }),
    minSeparationBeforeNext: 12,
  }),
  Object.freeze({
    label: 'three-close',
    count: 3,
    offset: Object.freeze({ dx: 1, dy: 0, dz: 0 }),
    minSeparationBeforeNext: 18,
  }),
  Object.freeze({
    label: 'four-stack',
    count: 4,
    offset: Object.freeze({ dx: 1, dy: 0, dz: 0 }),
    minSeparationBeforeNext: null,
  }),
]);

export function hostileEscalationSpawnArgs(botPosition, wave) {
  if (!botPosition) throw new Error('cannot spawn hostile escalation wave before bot position is available');
  const offset = wave?.offset || {};
  return [
    String(wave.count),
    formatCoordinate(botPosition.x + (offset.dx || 0)),
    formatCoordinate(Math.floor(botPosition.y) + (offset.dy || 0)),
    formatCoordinate(botPosition.z + (offset.dz || 0)),
  ];
}

export function hostileEscalationExpectedSpawnCount(waves = HOSTILE_ESCALATION_WAVES) {
  return waves.reduce((sum, wave) => sum + wave.count, 0);
}

export function evaluateHostileEscalationMetrics(metrics, opts = {}) {
  const expectedWaves = opts.expectedWaves ?? HOSTILE_ESCALATION_WAVES.length;
  const expectedSpawnCount = opts.expectedSpawnCount ?? hostileEscalationExpectedSpawnCount();
  const criticalHealth = opts.criticalHealth ?? 4;
  const maxWaterEscapeEntries = opts.maxWaterEscapeEntries ?? 3;
  const maxStateChanges = opts.maxStateChanges ?? 18;
  const minNormalAfterFleeDistance = opts.minNormalAfterFleeDistance ?? null;
  const allowEngage = opts.allowEngage === true;

  if ((metrics?.wavesSpawned || 0) < expectedWaves) {
    return { ok: false, reason: `expected ${expectedWaves} hostile waves; spawned ${metrics?.wavesSpawned || 0}` };
  }
  if ((metrics?.spawnedHostiles || 0) < expectedSpawnCount) {
    return { ok: false, reason: `expected ${expectedSpawnCount} spawned hostiles; spawned ${metrics?.spawnedHostiles || 0}` };
  }
  if (!metrics?.sawFleeing) {
    return { ok: false, reason: 'expected FLEEING during hostile escalation' };
  }
  if (!allowEngage && metrics?.sawEngaging) {
    return { ok: false, reason: 'expected flee policy to avoid ENGAGING during hostile escalation' };
  }
  if (!metrics?.sawNormalAfterFlee) {
    return { ok: false, reason: 'expected NORMAL after FLEEING during hostile escalation' };
  }
  if (opts.requireFinalEscape !== false && !metrics?.finalEscapeObserved) {
    return { ok: false, reason: 'expected final wave escape before hostile escalation completion' };
  }
  if ((metrics?.pathfinderActiveFleeSamples || 0) <= 0) {
    return { ok: false, reason: 'expected active pathfinder samples while FLEEING during hostile escalation' };
  }
  if (typeof metrics?.minHealth === 'number' && metrics.minHealth <= criticalHealth) {
    return { ok: false, reason: `health reached critical threshold during hostile escalation: ${metrics.minHealth}` };
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
