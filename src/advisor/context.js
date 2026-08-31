import { advisorSkillContract } from '../skills/schema.js';
import { activationSkillPolicy, snapshotPlanKey } from './plan_guard.js';
import { advisorFeedbackContract } from './feedback_log.js';

export const ADVISOR_CONTEXT_SCHEMA_VERSION = 1;

const OMIT = Symbol('advisor-context-omit');

const DEFAULT_SANITIZE_LIMITS = Object.freeze({
  maxDepth: 10,
  maxArrayLength: 80,
  maxObjectKeys: 80,
  maxStringLength: 2000,
  maxWarnings: 20,
});

export function advisorInterfaceManifest() {
  const contract = advisorSkillContract();
  return {
    version: ADVISOR_CONTEXT_SCHEMA_VERSION,
    plannerContractVersion: contract.version,
    stateInput: {
      source: 'buildSnapshot(bot, ctx)',
      jsonSafe: true,
      compactWorldModel: 'worldModel summary only when explicitly supplied by runtime context',
      compactCombatOverview: 'combatOverview threatLevel/advisorPriority/replanTriggers/recommendedTarget/lastRangedFire are compact state, not raw entity control',
      compactMiningProgression: 'miningProgression is optional deterministic tool-upgrade context when runtime supplies ore targets; it is advisory evidence, not permission to bypass skill validation',
      missionPreflightPattern: 'future task-specific preflights should summarize prerequisites, tools, consumables, workstations, route/time constraints, hazards, recovery assumptions, and known lessons',
      excludes: [
        'raw Mineflayer bot object',
        'raw pathfinder controls',
        'server admin/RCON controls',
        'arbitrary code execution',
      ],
    },
    feedbackBoundary: advisorFeedbackContract(),
    queueBoundary: {
      plannerOutput: 'proposal only',
      activation: 'validateAdvisorPlan and validatePlanActivation run against a fresh current snapshot before enqueue',
      stagingHelper: 'stageAdvisorQueueReplacement validates activation before calling executor.requestQueueReplacement',
      mutation: 'executor queue is mutated only after activation succeeds at a skill boundary',
      runtimeOnlySkillNames: contract.runtimeOnlySkillNames,
    },
    safetyBoundary: {
      survivalPriority: 'reactive survival outranks advisor plans',
      unsafeSnapshotRestriction: 'unsafe snapshots allow only observe/flee/consume at advisor activation; logout is runtime-only',
      activationAllowedSkillNames: 'activation.allowedSkillNames is the current skill subset permitted by the deterministic activation gate',
      combatOverviewGate: 'high/critical or retreat/survival combatOverview with real threats blocks normal advisor work at activation',
      noSafetyCriticalAdvisorAuthority: true,
    },
  };
}

export function buildAdvisorContextEnvelope(goal, snapshot, extra = {}, opts = {}) {
  const limits = { ...DEFAULT_SANITIZE_LIMITS, ...(opts.sanitizeLimits || {}) };
  const state = sanitizeAdvisorValue(snapshot, { limits, path: 'currentState' });
  const extraState = sanitizeAdvisorValue(extra, { limits, path: 'extra' });
  const goalState = sanitizeAdvisorValue(goal, { limits, path: 'goal' });
  const currentState = state.value && typeof state.value === 'object' ? state.value : {};
  const activationPolicy = activationSkillPolicy(currentState);
  const warnings = [
    ...state.warnings,
    ...extraState.warnings,
    ...goalState.warnings,
  ];

  const context = {
    goal: goalState.value,
    advisorContract: advisorSkillContract(),
    activation: {
      snapshotKey: snapshotPlanKey(currentState),
      safetyReasons: activationPolicy.safetyReasons,
      normalWorkAllowed: activationPolicy.normalWorkAllowed,
      allowedSkillNames: activationPolicy.allowedSkillNames,
      blockedSkillNames: activationPolicy.blockedSkillNames,
    },
    currentState,
    ...(extraState.value && typeof extraState.value === 'object' && !Array.isArray(extraState.value)
      ? extraState.value
      : {}),
  };

  if (warnings.length > 0) {
    context.contextStatus = {
      ok: false,
      reason: 'advisor context sanitized before prompt construction',
      warningCount: warnings.length,
      warnings: warnings.slice(0, limits.maxWarnings),
    };
  }

  return {
    context,
    diagnostics: {
      schemaVersion: ADVISOR_CONTEXT_SCHEMA_VERSION,
      sanitized: warnings.length > 0,
      warnings,
    },
  };
}

export function sanitizeAdvisorValue(value, opts = {}) {
  const limits = { ...DEFAULT_SANITIZE_LIMITS, ...(opts.limits || opts.sanitizeLimits || {}) };
  const warnings = [];
  const sanitized = sanitize(value, opts.path || '$', 0, new WeakSet(), warnings, limits);
  return {
    value: sanitized === OMIT ? null : sanitized,
    warnings,
  };
}

function sanitize(value, path, depth, seen, warnings, limits) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return sanitizeString(value, path, warnings, limits);
  if (type === 'boolean') return value;
  if (type === 'number') {
    if (Number.isFinite(value)) return value;
    warnings.push(`${path}: non-finite number replaced with null`);
    return null;
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    warnings.push(`${path}: unsupported ${type} omitted`);
    return OMIT;
  }
  if (type !== 'object') {
    warnings.push(`${path}: unsupported ${type} omitted`);
    return OMIT;
  }
  if (seen.has(value)) {
    warnings.push(`${path}: circular reference replaced with null`);
    return null;
  }
  if (depth >= limits.maxDepth) {
    warnings.push(`${path}: max depth ${limits.maxDepth} reached`);
    return null;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) return sanitizeArray(value, path, depth, seen, warnings, limits);
    return sanitizeObject(value, path, depth, seen, warnings, limits);
  } finally {
    seen.delete(value);
  }
}

function sanitizeArray(value, path, depth, seen, warnings, limits) {
  const out = [];
  const limit = Math.max(0, Math.floor(limits.maxArrayLength));
  if (value.length > limit) {
    warnings.push(`${path}: array truncated ${value.length} -> ${limit}`);
  }
  for (let i = 0; i < Math.min(value.length, limit); i++) {
    const item = sanitize(value[i], `${path}[${i}]`, depth + 1, seen, warnings, limits);
    out.push(item === OMIT ? null : item);
  }
  return out;
}

function sanitizeObject(value, path, depth, seen, warnings, limits) {
  const out = {};
  const entries = Object.entries(value);
  const limit = Math.max(0, Math.floor(limits.maxObjectKeys));
  if (entries.length > limit) {
    warnings.push(`${path}: object keys truncated ${entries.length} -> ${limit}`);
  }
  for (const [key, itemValue] of entries.slice(0, limit)) {
    const item = sanitize(itemValue, `${path}.${key}`, depth + 1, seen, warnings, limits);
    if (item !== OMIT) out[key] = item;
  }
  return out;
}

function sanitizeString(value, path, warnings, limits) {
  const max = Math.max(0, Math.floor(limits.maxStringLength));
  if (value.length <= max) return value;
  warnings.push(`${path}: string truncated ${value.length} -> ${max}`);
  return value.slice(0, max);
}
