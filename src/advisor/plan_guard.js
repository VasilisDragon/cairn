import { ADVISOR_SKILL_NAMES, validateAdvisorPlan } from '../skills/schema.js';

export const SURVIVAL_SKILL_NAMES = Object.freeze(['observe', 'flee', 'consume']);
const SURVIVAL_SKILLS = new Set(SURVIVAL_SKILL_NAMES);
const SURVIVAL_SKILL_LABEL = SURVIVAL_SKILL_NAMES.join('/');

const DEFAULTS = {
  maxPositionDrift: 2,
  minHealthDrop: 2,
  minFoodDrop: 2,
  lowHealthThreshold: 8,
  hostileSafetyRadius: 16,
};

export function validatePlanActivation(plan, currentSnapshot, opts = {}) {
  if (!currentSnapshot || typeof currentSnapshot !== 'object') {
    return { ok: false, reason: 'current snapshot required' };
  }

  const schema = validateAdvisorPlan(plan);
  if (!schema.ok) {
    return {
      ok: false,
      reason: `schema: ${schema.reason}`,
      badIndex: schema.badIndex,
    };
  }

  const safetyReasons = unsafeSnapshotReasons(currentSnapshot, opts);
  if (safetyReasons.length > 0) {
    const badIndex = plan.findIndex((call) => !SURVIVAL_SKILLS.has(call.skill));
    if (badIndex !== -1) {
      return {
        ok: false,
        reason: `unsafe snapshot permits only ${SURVIVAL_SKILL_LABEL}, rejected ${plan[badIndex].skill}: ${safetyReasons.join('; ')}`,
        badIndex,
        safetyReasons,
        staleReasons: [],
      };
    }
  }

  const proposedFromSnapshot = opts.proposedFromSnapshot || opts.proposalSnapshot || opts.expectedSnapshot || null;
  const staleReasons = proposedFromSnapshot
    ? snapshotStalenessReasons(proposedFromSnapshot, currentSnapshot, opts)
    : [];
  if (staleReasons.length > 0) {
    return {
      ok: false,
      reason: `stale plan activation: ${staleReasons.join('; ')}`,
      staleReasons,
      safetyReasons,
    };
  }

  return {
    ok: true,
    staleReasons,
    safetyReasons,
    snapshotKey: snapshotPlanKey(currentSnapshot),
  };
}

export function unsafeSnapshotReasons(snapshot, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const reasons = [];
  const reactiveState = normalizeReactiveState(snapshot?.reactiveState);
  if (reactiveState && reactiveState !== 'NORMAL') {
    reasons.push(`reactive state ${reactiveState}`);
  }

  if (snapshot?.pathfinder?.owner === 'reactive') {
    reasons.push('pathfinder owned by reactive');
  }

  const flags = snapshot?.hazardFlags || {};
  if (flags.falling === true) reasons.push('falling');
  if (flags.oxygenLow === true) reasons.push('oxygen low');

  const health = numberOrNull(snapshot?.health);
  if (health !== null && health > 0 && health <= options.lowHealthThreshold) {
    reasons.push(`low health ${health}`);
  }

  const hostile = nearestHostile(snapshot?.nearbyHostiles, options.hostileSafetyRadius);
  if (hostile) reasons.push(`nearby hostile ${hostile.name} at ${hostile.distance}`);

  const combat = combatOverviewSafetyReason(snapshot?.combatOverview);
  if (combat) reasons.push(combat);

  return reasons;
}

export function activationSkillPolicy(snapshot, opts = {}) {
  const safetyReasons = unsafeSnapshotReasons(snapshot, opts);
  const normalWorkAllowed = safetyReasons.length === 0;
  const allowedSkillNames = normalWorkAllowed
    ? [...ADVISOR_SKILL_NAMES]
    : [...SURVIVAL_SKILL_NAMES];
  const blockedSkillNames = normalWorkAllowed
    ? []
    : ADVISOR_SKILL_NAMES.filter((name) => !SURVIVAL_SKILLS.has(name));
  return {
    normalWorkAllowed,
    safetyReasons,
    allowedSkillNames,
    blockedSkillNames,
  };
}

export function snapshotStalenessReasons(proposedFromSnapshot, currentSnapshot, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const before = snapshotPlanKey(proposedFromSnapshot);
  const current = snapshotPlanKey(currentSnapshot);
  const reasons = [];

  if (before.reactiveState !== current.reactiveState) {
    reasons.push(`reactive state changed ${display(before.reactiveState)} -> ${display(current.reactiveState)}`);
  }
  if (before.pathfinderOwner !== current.pathfinderOwner) {
    reasons.push(`pathfinder owner changed ${display(before.pathfinderOwner)} -> ${display(current.pathfinderOwner)}`);
  }
  if (before.pathfinderIdle !== current.pathfinderIdle) {
    reasons.push(`pathfinder idle changed ${display(before.pathfinderIdle)} -> ${display(current.pathfinderIdle)}`);
  }
  if (before.pathfinderRevision !== current.pathfinderRevision) {
    reasons.push(`pathfinder state revision changed ${display(before.pathfinderRevision)} -> ${display(current.pathfinderRevision)}`);
  }
  if (before.currentSkill !== current.currentSkill) {
    reasons.push(`current skill changed ${display(before.currentSkill)} -> ${display(current.currentSkill)}`);
  }
  if (before.queueLength !== current.queueLength) {
    reasons.push(`queue length changed ${display(before.queueLength)} -> ${display(current.queueLength)}`);
  }
  if (before.hazards.falling !== current.hazards.falling) {
    reasons.push(`falling changed ${before.hazards.falling} -> ${current.hazards.falling}`);
  }
  if (before.hazards.oxygenLow !== current.hazards.oxygenLow) {
    reasons.push(`oxygenLow changed ${before.hazards.oxygenLow} -> ${current.hazards.oxygenLow}`);
  }
  if (before.nearbyHostiles !== current.nearbyHostiles) {
    reasons.push(`nearby hostiles changed ${display(before.nearbyHostiles)} -> ${display(current.nearbyHostiles)}`);
  }
  if (before.combatOverview !== current.combatOverview) {
    reasons.push(`combat overview changed ${display(before.combatOverview)} -> ${display(current.combatOverview)}`);
  }

  const drift = positionDistance(before.position, current.position);
  if (drift !== null && drift > options.maxPositionDrift) {
    reasons.push(`position drift ${round1(drift)} > ${options.maxPositionDrift}`);
  }

  if (before.health !== null && current.health !== null && before.health - current.health >= options.minHealthDrop) {
    reasons.push(`health dropped ${before.health} -> ${current.health}`);
  }
  if (before.food !== null && current.food !== null && before.food - current.food >= options.minFoodDrop) {
    reasons.push(`food dropped ${before.food} -> ${current.food}`);
  }

  return reasons;
}

export function snapshotPlanKey(snapshot = {}) {
  const flags = snapshot?.hazardFlags || {};
  return {
    reactiveState: normalizeReactiveState(snapshot?.reactiveState),
    currentSkill: skillCallKey(snapshot?.currentSkill),
    queueLength: numberOrNull(snapshot?.queueLength),
    pathfinderOwner: snapshot?.pathfinder?.owner ?? null,
    pathfinderIdle: snapshot?.pathfinder?.idle ?? null,
    pathfinderRevision: snapshot?.pathfinder?.revision ?? null,
    position: compactPosition(snapshot?.position),
    health: numberOrNull(snapshot?.health),
    food: numberOrNull(snapshot?.food),
    hazards: {
      inWater: flags.inWater === true,
      oxygenLow: flags.oxygenLow === true,
      falling: flags.falling === true,
      usingHeldItem: flags.usingHeldItem === true,
      autoEatEating: flags.autoEatEating === true,
    },
    nearbyHostiles: hostileKey(snapshot?.nearbyHostiles),
    combatOverview: combatOverviewKey(snapshot?.combatOverview),
  };
}

function normalizeReactiveState(state) {
  if (state === undefined || state === null || state === '') return null;
  return String(state).toUpperCase();
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactPosition(position) {
  if (!position || typeof position !== 'object') return null;
  const x = numberOrNull(position.x);
  const y = numberOrNull(position.y);
  const z = numberOrNull(position.z);
  if (x === null || y === null || z === null) return null;
  return {
    x: round2(x),
    y: round2(y),
    z: round2(z),
    dimension: position.dimension || null,
  };
}

function skillCallKey(call) {
  if (!call || typeof call !== 'object' || typeof call.skill !== 'string') return null;
  return `${call.skill}:${stableStringify(call.params || {})}`;
}

function hostileKey(hostiles) {
  if (!Array.isArray(hostiles) || hostiles.length === 0) return '';
  return hostiles
    .map((hostile) => ({
      name: hostile?.name ? String(hostile.name) : 'unknown',
      distance: numberOrNull(hostile?.distance),
    }))
    .sort((a, b) => (
      a.name.localeCompare(b.name) ||
      (a.distance ?? Infinity) - (b.distance ?? Infinity)
    ))
    .map((hostile) => `${hostile.name}@${hostile.distance === null ? '?' : Math.round(hostile.distance)}`)
    .join(',');
}

function nearestHostile(hostiles, maxDistance) {
  if (!Array.isArray(hostiles)) return null;
  let nearest = null;
  for (const hostile of hostiles) {
    const distance = numberOrNull(hostile?.distance);
    if (distance === null || distance > maxDistance) continue;
    if (!nearest || distance < nearest.distance) {
      nearest = { name: hostile?.name || 'unknown', distance };
    }
  }
  return nearest;
}

function combatOverviewSafetyReason(combat) {
  if (!combat || typeof combat !== 'object') return null;
  const level = stringOrNull(combat.threatLevel);
  const priority = stringOrNull(combat.advisorPriority);
  if (level === 'clear' || numberOrNull(combat.threatCount) === 0) return null;
  const unsafeLevel = level === 'critical' || level === 'high';
  const unsafePriority = priority === 'survival' || priority === 'retreat';
  if (!unsafeLevel && !unsafePriority) return null;
  const reason = stringOrNull(combat.recommendedReason) || stringOrNull(combat.reason) || 'unspecified';
  return `combat overview ${level || 'unknown'}/${priority || 'unknown'}: ${reason}`;
}

function combatOverviewKey(combat) {
  if (!combat || typeof combat !== 'object') return '';
  const nearestDistance = numberOrNull(combat.nearest?.distance);
  const nearest = combat.nearest && typeof combat.nearest === 'object'
    ? `${stringOrNull(combat.nearest.name) || 'unknown'}@${nearestDistance === null ? '?' : Math.round(nearestDistance)}`
    : 'none';
  const targetDistance = numberOrNull(combat.recommendedTarget?.distance);
  const target = combat.recommendedTarget && typeof combat.recommendedTarget === 'object'
    ? `target:${stringOrNull(combat.recommendedTarget.name) || 'unknown'}@${targetDistance === null ? '?' : Math.round(targetDistance)}`
    : '';
  const flags = combat.flags && typeof combat.flags === 'object'
    ? Object.keys(combat.flags).filter((key) => combat.flags[key] === true).sort().join(',')
    : '';
  const lastRanged = combat.lastRangedFire && typeof combat.lastRangedFire === 'object'
    ? lastRangedFireKey(combat.lastRangedFire)
    : '';
  const parts = [
    stringOrNull(combat.threatLevel) || 'unknown',
    stringOrNull(combat.advisorPriority) || 'unknown',
    numberOrUnknown(combat.threatCount),
    numberOrUnknown(combat.closeCount),
    nearest,
  ];
  if (target) parts.push(target);
  parts.push(
    stringOrNull(combat.recommendedAction) || 'none',
    stringOrNull(combat.recommendedReason) || stringOrNull(combat.reason) || 'none',
    flags,
  );
  if (lastRanged) parts.push(lastRanged);
  return parts.join('|');
}

function lastRangedFireKey(verification) {
  const outcome = stringOrNull(verification.outcome) || 'unknown';
  const entity = stringOrNull(verification.entity) || 'unknown';
  const currentDistance = numberOrNull(verification.currentDistance);
  const followUpShots = numberOrNull(verification.followUpShots);
  return `ranged:${outcome}:${entity}@${currentDistance === null ? '?' : Math.round(currentDistance)}#${followUpShots === null ? '?' : Math.round(followUpShots)}`;
}

function positionDistance(a, b) {
  if (!a || !b) return null;
  if (a.dimension !== b.dimension) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrUnknown(value) {
  const num = numberOrNull(value);
  return num === null ? '?' : String(num);
}

function display(value) {
  return value === null || value === undefined || value === '' ? 'none' : String(value);
}
