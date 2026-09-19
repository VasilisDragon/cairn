// Phase-A mission issuance only. These values mirror the existing normal
// descent executor's 20-step cap and base/per-step budget; no route is split.
export const PHASE_A_DESCENT_TARGET_Y = 16;
export const PHASE_A_DESCENT_MAX_DEPTH = 20;
export const PHASE_A_DESCENT_BASE_MS = 15000;
export const PHASE_A_DESCENT_STEP_MS = 12000;
export const PHASE_A_DESCENT_MAX_MS = 255000;
export const LEGACY_MISSION_ACTION_MAX_MS = 45000;

export function phaseAMissionGoal(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  // The planner considers both fields independently. A default mission label
  // must not hide a diamond/pickaxe-only goal supplied through the other field.
  const goals = [snapshot.missionGoal, snapshot.goal].map(value => String(value || '').trim());
  return snapshot.targetDiamondTier !== true && snapshot.targetDiamondGoal !== true
    && snapshot.targetIronPickaxeOnly !== true
    && !goals.some(goal => ['diamond', 'iron_pickaxe', 'iron_pickaxe_only'].includes(goal));
}

export function phaseADescentIntent(intent, snapshot = {}) {
  return phaseAMissionGoal(snapshot) && intent?.action === 'descend_staircase'
    && ['mission:DESCEND', 'mission:DESCEND_RECOVERY'].includes(intent.reason);
}

export function legacyMissionActionTtl(requestedMs) {
  return Number.isSafeInteger(requestedMs) && requestedMs > 0
    ? Math.min(requestedMs, LEGACY_MISSION_ACTION_MAX_MS)
    : 1;
}

function rejected(reason, detail = {}) {
  return Object.freeze({ accepted: false, reason, ...detail });
}

/** Freeze at command creation, not at a later resumption or repeated poll. */
export function freezePhaseADescentLifetime({ commandId, intent, snapshot, issuedAtMs, maxTtlMs } = {}) {
  if (typeof commandId !== 'string' || !commandId.startsWith('mission-')
      || commandId.length <= 'mission-'.length || commandId.trim() !== commandId) {
    return rejected('descent_lifetime_command_invalid');
  }
  if (!phaseADescentIntent(intent, snapshot)) return rejected('descent_lifetime_scope_invalid');
  if (intent.targetY !== PHASE_A_DESCENT_TARGET_Y) return rejected('descent_lifetime_target_invalid');
  const y = snapshot?.y;
  if (!Number.isFinite(y) || !Number.isSafeInteger(Math.floor(y))
      || Math.floor(y) - PHASE_A_DESCENT_TARGET_Y < -2147483648 || Math.floor(y) > 2147483647) {
    return rejected('descent_lifetime_position_invalid');
  }
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) return rejected('descent_lifetime_clock_invalid');
  const boundedDepth = Math.min(PHASE_A_DESCENT_MAX_DEPTH, Math.max(1, Math.floor(y) - PHASE_A_DESCENT_TARGET_Y));
  const lifetimeMs = PHASE_A_DESCENT_BASE_MS + boundedDepth * PHASE_A_DESCENT_STEP_MS;
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < lifetimeMs) {
    return rejected('descent_lifetime_cap_insufficient', { boundedDepth, requiredTtlMs: lifetimeMs });
  }
  const deadlineMs = issuedAtMs + lifetimeMs;
  if (!Number.isSafeInteger(deadlineMs)) return rejected('descent_lifetime_clock_invalid');
  return Object.freeze({
    accepted: true, commandId, boundedDepth, lifetimeMs, issuedAtMs, deadlineMs,
  });
}

/** Remaining TTL can shrink or stay equal; backwards clocks never grant time. */
export function phaseADescentRemaining(frozen, nowMs, lastObservedAtMs = frozen?.issuedAtMs) {
  if (!frozen?.accepted) return rejected('descent_lifetime_missing');
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(lastObservedAtMs)
      || lastObservedAtMs < frozen.issuedAtMs || nowMs < lastObservedAtMs) {
    return rejected('descent_lifetime_clock_invalid');
  }
  if (nowMs >= frozen.deadlineMs) return rejected('descent_lifetime_expired');
  return Object.freeze({ accepted: true, ttlMs: frozen.deadlineMs - nowMs });
}
