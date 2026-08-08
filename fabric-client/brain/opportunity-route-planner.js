export const OPPORTUNITY_ROUTE_LIMITS = Object.freeze({
  maxOpportunities: 8,
  maxDetourEdges: 3,
  maxExpandedStates: 256,
  minimumBenefitFraction: 0.15,
  minimumBenefitSeconds: 45,
});

const EPSILON = 1e-9;
const ID_RE = /^[a-zA-Z0-9_.:-]{1,96}$/;
const RESOURCE_RE = /^[a-zA-Z0-9_.:/-]{1,128}$/;
const BASELINE_CHOICE_ID = 'continue_baseline';

/**
 * Pure, bounded optimizer for code-generated opportunity packages.
 *
 * Estimated gains are deliberately kept separate from the authoritative
 * ledger. They may reduce the modeled cost of resuming the deterministic
 * baseline, but can never satisfy an inventory postcondition.
 *
 * Input contract:
 *   ledger: { owned, reserved, deficit } exact item/count maps
 *   baseline: {
 *     choiceId, p75Seconds, reliability, failureUpperBound,
 *     components: [{ id, resource, p75Seconds,
 *                    mode: 'proportional'|'all_or_nothing' }]
 *   }
 *   opportunities: [{
 *     id, safe, ready, feasible, reliability, failureUpperBound,
 *     travelP75Seconds, executionP75Seconds, uncertaintyPenaltySeconds,
 *     conservativeEstimatedGain|estimatedGain, travelFrom?
 *   }]
 *   context: optional world/dimension/memoryRevision/ledgerRevision fence
 *
 * The returned `selected` is observational at this stage. Runtime integration
 * must not replace the deterministic physical intent with it.
 */
export class OpportunityRoutePlanner {
  constructor(config = {}) {
    this.limits = Object.freeze(normalizeLimits(config));
  }

  plan(input = {}) {
    return planOpportunityRoutes(input, this.limits);
  }
}

export function planOpportunityRoutes(input = {}, config = {}) {
  const limits = normalizeLimits(config);
  const ledger = normalizeLedger(input.ledger);
  const baseline = normalizeBaseline(input.baseline, ledger);
  const authoritativeGoalSatisfied = goalSatisfied(ledger.deficit);
  const baselinePlan = Object.freeze({
    choiceId: baseline.choiceId,
    kind: 'baseline',
    opportunityIds: Object.freeze([]),
    detourEdges: 0,
    scoreSeconds: baseline.p75Seconds,
    baselineRemainingTimeSeconds: baseline.p75Seconds,
    p75TravelExecutionSeconds: 0,
    failurePenaltySeconds: 0,
    uncertaintyPenaltySeconds: 0,
    failureUpperBound: baseline.failureUpperBound,
    reliability: baseline.reliability,
    estimatedGain: Object.freeze({}),
    estimatedResidualDeficit: Object.freeze({ ...ledger.deficit }),
    authoritativeDeficit: Object.freeze({ ...ledger.deficit }),
    authoritativeGoalSatisfied,
    estimatedDeficitClearedForRanking: authoritativeGoalSatisfied,
    requiresAuthoritativeVerification: !authoritativeGoalSatisfied,
    conservativeBenefitSeconds: 0,
    conservativeBenefitFraction: 0,
    thresholdEligible: false,
    costBreakdown: Object.freeze({
      p75TravelExecutionSeconds: 0,
      failurePenaltySeconds: 0,
      uncertaintyPenaltySeconds: 0,
      baselineRemainingTimeSeconds: baseline.p75Seconds,
      totalSeconds: baseline.p75Seconds,
    }),
  });

  const admitted = admitOpportunities(input.opportunities, baseline, ledger, limits, input.context);
  const root = createRootState(ledger, baseline);
  const candidates = [];
  let frontier = [root];
  let expandedStates = 1;

  for (let depth = 1; depth <= limits.maxDetourEdges && frontier.length > 0; depth += 1) {
    const nextByKey = new Map();
    for (const state of frontier) {
      for (let index = 0; index < admitted.opportunities.length; index += 1) {
        const bit = 1 << index;
        if ((state.mask & bit) !== 0) continue;
        const next = extendState(state, admitted.opportunities[index], index, baseline, ledger);
        const key = `${next.mask}:${next.lastIndex}`;
        const incumbent = nextByKey.get(key);
        if (!incumbent || compareDominatedState(next, incumbent) < 0) {
          nextByKey.set(key, next);
        }
      }
    }
    frontier = [...nextByKey.values()].sort(compareStatePath);
    if (expandedStates + frontier.length > limits.maxExpandedStates) {
      frontier = frontier
        .sort(compareStateForBound)
        .slice(0, limits.maxExpandedStates - expandedStates)
        .sort(compareStatePath);
    }
    expandedStates += frontier.length;
    for (const state of frontier) candidates.push(toCandidatePlan(state, baseline, ledger, limits));
  }

  candidates.sort(compareCandidatePlan);
  const eligible = candidates.filter((candidate) => candidate.thresholdEligible);
  const recommendation = eligible.length > 0 ? eligible[0] : baselinePlan;
  const reason = recommendation.kind === 'opportunity'
    ? 'opportunity_selected'
    : admitted.opportunities.length === 0
      ? 'no_feasible_opportunities'
      : 'benefit_threshold_not_met';

  const evaluated = Object.freeze(candidates);
  const rejectionReasons = {};
  for (const entry of admitted.rejections) {
    rejectionReasons[entry.reason] = (rejectionReasons[entry.reason] || 0) + 1;
  }
  const reasons = Object.freeze({
    decision: reason,
    rejected: Object.freeze(sortObject(rejectionReasons)),
  });
  return Object.freeze({
    recommendation,
    baseline: baselinePlan,
    candidates: evaluated,
    evaluated,
    selected: recommendation,
    rejectedOpportunities: Object.freeze(admitted.rejections),
    consideredOpportunityIds: Object.freeze(admitted.opportunities.map((entry) => entry.id)),
    shouldSwitch: recommendation.kind === 'opportunity',
    recommendationEligible: recommendation.kind === 'opportunity',
    reason,
    reasons,
    expandedStates,
    bounds: Object.freeze({
      ...limits,
      admittedOpportunities: admitted.opportunities.length,
      generatedCandidates: candidates.length,
    }),
  });
}

function normalizeLimits(config) {
  return {
    maxOpportunities: boundedInteger(
      config.maxOpportunities,
      OPPORTUNITY_ROUTE_LIMITS.maxOpportunities,
      1,
      OPPORTUNITY_ROUTE_LIMITS.maxOpportunities,
    ),
    maxDetourEdges: boundedInteger(
      config.maxDetourEdges,
      OPPORTUNITY_ROUTE_LIMITS.maxDetourEdges,
      1,
      OPPORTUNITY_ROUTE_LIMITS.maxDetourEdges,
    ),
    maxExpandedStates: boundedInteger(
      config.maxExpandedStates,
      OPPORTUNITY_ROUTE_LIMITS.maxExpandedStates,
      1,
      OPPORTUNITY_ROUTE_LIMITS.maxExpandedStates,
    ),
    minimumBenefitFraction: boundedNumberAtLeast(
      config.minimumBenefitFraction,
      OPPORTUNITY_ROUTE_LIMITS.minimumBenefitFraction,
      OPPORTUNITY_ROUTE_LIMITS.minimumBenefitFraction,
      1,
    ),
    minimumBenefitSeconds: boundedNumberAtLeast(
      config.minimumBenefitSeconds,
      OPPORTUNITY_ROUTE_LIMITS.minimumBenefitSeconds,
      OPPORTUNITY_ROUTE_LIMITS.minimumBenefitSeconds,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function normalizeLedger(raw) {
  const ledger = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    owned: normalizeLedgerResourceCounts(ledger.owned, 'ledger.owned'),
    reserved: normalizeLedgerResourceCounts(ledger.reserved, 'ledger.reserved'),
    deficit: normalizeLedgerResourceCounts(ledger.deficit, 'ledger.deficit'),
  };
}

function normalizeBaseline(raw, ledger) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('baseline must be an object');
  }
  const p75Seconds = requiredNonNegativeNumber(raw.p75Seconds, 'baseline.p75Seconds');
  const failureUpperBound = probability(raw.failureUpperBound, 0);
  const reliability = probability(raw.reliability, 1 - failureUpperBound);
  const choiceId = validId(raw.choiceId) ? raw.choiceId : BASELINE_CHOICE_ID;
  const components = [];
  const componentIds = new Set();
  let modeledP75Seconds = 0;
  for (const value of Array.isArray(raw.components) ? raw.components : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('baseline.components entries must be objects');
    }
    const id = String(value.id || '').trim();
    const resource = String(value.resource || '').trim();
    if (!validId(id) || componentIds.has(id)) throw new TypeError(`invalid baseline component id: ${id}`);
    if (!RESOURCE_RE.test(resource)) throw new TypeError(`invalid baseline component resource: ${resource}`);
    const componentP75 = requiredNonNegativeNumber(value.p75Seconds, `baseline.components.${id}.p75Seconds`);
    const mode = value.mode === 'all_or_nothing' ? value.mode : value.mode === 'proportional' ? value.mode : null;
    if (!mode) throw new TypeError(`invalid baseline component mode: ${value.mode}`);
    const initialDeficit = Object.hasOwn(value, 'initialDeficit')
      ? requiredNonNegativeNumber(value.initialDeficit, `baseline.components.${id}.initialDeficit`)
      : (ledger.deficit[resource] || 0);
    componentIds.add(id);
    if (initialDeficit > 0) modeledP75Seconds += componentP75;
    components.push(Object.freeze({ id, resource, p75Seconds: componentP75, mode, initialDeficit }));
  }
  if (modeledP75Seconds > p75Seconds + EPSILON) {
    throw new RangeError('baseline component time exceeds baseline.p75Seconds');
  }
  return Object.freeze({
    choiceId,
    p75Seconds,
    failureUpperBound,
    reliability,
    fixedP75Seconds: Math.max(0, p75Seconds - modeledP75Seconds),
    components: Object.freeze(components.sort((a, b) => a.id.localeCompare(b.id))),
  });
}

function admitOpportunities(rawValues, baseline, ledger, limits, context) {
  const values = Array.isArray(rawValues) ? rawValues : [];
  const byId = new Map();
  const rejections = [];
  for (const raw of values) {
    const id = String(raw?.id || '').trim();
    if (!validId(id)) {
      rejections.push(rejection(id || null, 'invalid_id'));
      continue;
    }
    const group = byId.get(id) || [];
    group.push(raw);
    byId.set(id, group);
  }

  const eligible = [];
  for (const id of [...byId.keys()].sort()) {
    const group = byId.get(id);
    if (group.length !== 1) {
      rejections.push(rejection(id, 'duplicate_id'));
      continue;
    }
    const normalized = normalizeOpportunity(group[0], baseline, context);
    if (!normalized.ok) {
      rejections.push(rejection(id, normalized.reason));
      continue;
    }
    eligible.push(normalized.value);
  }

  if (eligible.length > limits.maxOpportunities) {
    const root = createRootState(ledger, baseline);
    eligible.sort((left, right) => {
      const leftScore = totalStateScore(extendState(root, left, 0, baseline, ledger));
      const rightScore = totalStateScore(extendState(root, right, 0, baseline, ledger));
      return numericCompare(leftScore, rightScore) || left.id.localeCompare(right.id);
    });
    for (const omitted of eligible.slice(limits.maxOpportunities)) {
      rejections.push(rejection(omitted.id, 'opportunity_limit'));
    }
    eligible.length = limits.maxOpportunities;
  }

  eligible.sort((a, b) => a.id.localeCompare(b.id));
  rejections.sort(compareRejection);
  return { opportunities: eligible, rejections };
}

function normalizeOpportunity(raw, baseline, context) {
  const id = String(raw.id).trim();
  if (raw.valid === false || raw.status === 'invalidated') return { ok: false, reason: 'invalidated' };
  if (raw.expectedRevision != null && raw.observedRevision != null
      && raw.expectedRevision !== raw.observedRevision) {
    return { ok: false, reason: 'stale_revision' };
  }
  if (!matchesPlanningContext(raw, context)) return { ok: false, reason: 'stale_context' };
  const safe = raw.safe === true || raw.safety?.safe === true;
  if (!safe) return { ok: false, reason: classifiedReason('unsafe', raw.safety?.reason) };
  const ready = raw.ready === true || raw.readiness?.ready === true;
  if (!ready) return { ok: false, reason: classifiedReason('unready', raw.readiness?.reason) };
  const feasible = raw.feasible === true || raw.feasibility?.feasible === true;
  if (!feasible) return { ok: false, reason: classifiedReason('infeasible', raw.feasibility?.reason) };

  if (!validProbability(raw.reliability)) return { ok: false, reason: 'invalid_reliability' };
  const reliability = Number(raw.reliability);
  if (reliability + EPSILON < baseline.reliability) {
    return { ok: false, reason: 'reliability_below_baseline' };
  }
  if (!validOptionalNonNegativeNumber(raw.travelP75Seconds)
      || !validOptionalNonNegativeNumber(raw.executionP75Seconds)
      || !validOptionalNonNegativeNumber(raw.uncertaintyPenaltySeconds)) {
    return { ok: false, reason: 'invalid_cost' };
  }
  if (raw.failureUpperBound != null && !validProbability(raw.failureUpperBound)) {
    return { ok: false, reason: 'invalid_failure_upper_bound' };
  }
  const travelP75Seconds = optionalNonNegativeNumber(raw.travelP75Seconds, 0);
  const executionP75Seconds = optionalNonNegativeNumber(raw.executionP75Seconds, 0);
  const failureUpperBound = raw.failureUpperBound == null
    ? Math.max(0, 1 - reliability)
    : Number(raw.failureUpperBound);
  const uncertaintyPenaltySeconds = optionalNonNegativeNumber(raw.uncertaintyPenaltySeconds, 0);
  const estimatedGainInput = raw.conservativeEstimatedGain ?? raw.estimatedGain;
  if (!validResourceCounts(estimatedGainInput)) return { ok: false, reason: 'invalid_estimated_gain' };
  const estimatedGain = normalizeResourceCounts(estimatedGainInput);
  const travelFrom = {};
  if (raw.travelFrom && typeof raw.travelFrom === 'object' && !Array.isArray(raw.travelFrom)) {
    for (const key of Object.keys(raw.travelFrom).sort()) {
      if (!validId(key)) continue;
      const seconds = Number(raw.travelFrom[key]);
      if (Number.isFinite(seconds) && seconds >= 0) travelFrom[key] = seconds;
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      id,
      kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 64) : 'opportunity',
      reliability,
      travelP75Seconds,
      executionP75Seconds,
      failureUpperBound,
      uncertaintyPenaltySeconds,
      estimatedGain: Object.freeze(estimatedGain),
      travelFrom: Object.freeze(travelFrom),
    }),
  };
}

function createRootState(ledger, baseline) {
  return {
    mask: 0,
    lastIndex: -1,
    path: [],
    gain: {},
    residual: { ...ledger.deficit },
    baselineRemainingTimeSeconds: baseline.p75Seconds,
    p75TravelExecutionSeconds: 0,
    failurePenaltySeconds: 0,
    uncertaintyPenaltySeconds: 0,
    failureSurvival: 1,
    reliability: 1,
  };
}

function extendState(state, opportunity, index, baseline, ledger) {
  const prior = state.path.length > 0 ? state.path[state.path.length - 1] : null;
  const travel = prior && Object.hasOwn(opportunity.travelFrom, prior.id)
    ? opportunity.travelFrom[prior.id]
    : opportunity.travelP75Seconds;
  const gain = addResourceCounts(state.gain, opportunity.estimatedGain);
  const residual = estimatedResidual(ledger.deficit, gain);
  const baselineRemainingTimeSeconds = baselineTimeForResidual(baseline, residual);
  return {
    mask: state.mask | (1 << index),
    lastIndex: index,
    path: [...state.path, opportunity],
    gain,
    residual,
    baselineRemainingTimeSeconds,
    p75TravelExecutionSeconds: state.p75TravelExecutionSeconds + travel + opportunity.executionP75Seconds,
    failurePenaltySeconds: state.failurePenaltySeconds
      + opportunity.failureUpperBound * state.baselineRemainingTimeSeconds,
    uncertaintyPenaltySeconds: state.uncertaintyPenaltySeconds + opportunity.uncertaintyPenaltySeconds,
    failureSurvival: state.failureSurvival * (1 - opportunity.failureUpperBound),
    reliability: state.reliability * opportunity.reliability,
  };
}

function baselineTimeForResidual(baseline, residual) {
  let total = baseline.fixedP75Seconds;
  for (const component of baseline.components) {
    const remaining = Math.max(0, residual[component.resource] || 0);
    if (component.initialDeficit <= 0 || remaining <= 0) continue;
    total += component.mode === 'all_or_nothing'
      ? component.p75Seconds
      : component.p75Seconds * Math.min(1, remaining / component.initialDeficit);
  }
  return total;
}

function totalStateScore(state) {
  return state.p75TravelExecutionSeconds
    + state.failurePenaltySeconds
    + state.uncertaintyPenaltySeconds
    + state.baselineRemainingTimeSeconds;
}

function toCandidatePlan(state, baseline, ledger, limits) {
  const scoreSeconds = totalStateScore(state);
  const conservativeBenefitSeconds = baseline.p75Seconds - scoreSeconds;
  const conservativeBenefitFraction = baseline.p75Seconds > 0
    ? conservativeBenefitSeconds / baseline.p75Seconds
    : 0;
  const thresholdEligible = state.reliability + EPSILON >= baseline.reliability
    && conservativeBenefitSeconds + EPSILON >= limits.minimumBenefitSeconds
    && conservativeBenefitFraction + EPSILON >= limits.minimumBenefitFraction;
  const opportunityIds = state.path.map((entry) => entry.id);
  const authoritativeGoalSatisfied = goalSatisfied(ledger.deficit);
  const costBreakdown = Object.freeze({
    p75TravelExecutionSeconds: state.p75TravelExecutionSeconds,
    failurePenaltySeconds: state.failurePenaltySeconds,
    uncertaintyPenaltySeconds: state.uncertaintyPenaltySeconds,
    baselineRemainingTimeSeconds: state.baselineRemainingTimeSeconds,
    totalSeconds: scoreSeconds,
  });
  return Object.freeze({
    choiceId: `opportunity:${opportunityIds.join('+')}`,
    kind: 'opportunity',
    opportunityIds: Object.freeze(opportunityIds),
    detourEdges: opportunityIds.length,
    scoreSeconds,
    baselineRemainingTimeSeconds: state.baselineRemainingTimeSeconds,
    p75TravelExecutionSeconds: state.p75TravelExecutionSeconds,
    failurePenaltySeconds: state.failurePenaltySeconds,
    uncertaintyPenaltySeconds: state.uncertaintyPenaltySeconds,
    failureUpperBound: 1 - state.failureSurvival,
    reliability: state.reliability,
    estimatedGain: Object.freeze({ ...state.gain }),
    estimatedResidualDeficit: Object.freeze({ ...state.residual }),
    authoritativeDeficit: Object.freeze({ ...ledger.deficit }),
    authoritativeGoalSatisfied,
    estimatedDeficitClearedForRanking: goalSatisfied(state.residual),
    requiresAuthoritativeVerification: !authoritativeGoalSatisfied,
    conservativeBenefitSeconds,
    conservativeBenefitFraction,
    thresholdEligible,
    costBreakdown,
  });
}

function matchesPlanningContext(opportunity, rawContext) {
  const context = rawContext && typeof rawContext === 'object' && !Array.isArray(rawContext)
    ? rawContext
    : {};
  for (const key of ['worldId', 'dimension', 'memoryRevision', 'ledgerRevision']) {
    if (opportunity[key] != null && context[key] != null && opportunity[key] !== context[key]) return false;
  }
  return true;
}

function compareDominatedState(left, right) {
  return numericCompare(
    left.p75TravelExecutionSeconds + left.failurePenaltySeconds + left.uncertaintyPenaltySeconds,
    right.p75TravelExecutionSeconds + right.failurePenaltySeconds + right.uncertaintyPenaltySeconds,
  ) || pathKey(left).localeCompare(pathKey(right));
}

function compareStatePath(left, right) {
  return left.path.length - right.path.length || pathKey(left).localeCompare(pathKey(right));
}

function compareStateForBound(left, right) {
  return numericCompare(totalStateScore(left), totalStateScore(right)) || compareStatePath(left, right);
}

function compareCandidatePlan(left, right) {
  return numericCompare(left.scoreSeconds, right.scoreSeconds)
    || left.detourEdges - right.detourEdges
    || left.opportunityIds.join('\u0000').localeCompare(right.opportunityIds.join('\u0000'));
}

function compareRejection(left, right) {
  return String(left.id || '').localeCompare(String(right.id || '')) || left.reason.localeCompare(right.reason);
}

function pathKey(state) {
  return state.path.map((entry) => entry.id).join('\u0000');
}

function estimatedResidual(deficit, gain) {
  const result = {};
  for (const resource of Object.keys(deficit).sort()) {
    result[resource] = Math.max(0, deficit[resource] - (gain[resource] || 0));
  }
  return result;
}

function addResourceCounts(left, right) {
  const result = { ...left };
  for (const resource of Object.keys(right)) result[resource] = (result[resource] || 0) + right[resource];
  return sortObject(result);
}

function normalizeResourceCounts(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const resource of Object.keys(raw).sort()) {
    if (!RESOURCE_RE.test(resource)) continue;
    const value = Number(raw[resource]);
    if (Number.isFinite(value) && value >= 0) result[resource] = value;
  }
  return result;
}

function normalizeLedgerResourceCounts(raw, label) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${label} must be an object`);
  if (!validResourceCounts(raw)) throw new TypeError(`${label} contains an invalid resource count`);
  return normalizeResourceCounts(raw);
}

function validResourceCounts(raw) {
  if (raw == null) return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.entries(raw).every(([resource, value]) => (
    RESOURCE_RE.test(resource) && Number.isSafeInteger(value) && value >= 0
  ));
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function goalSatisfied(deficit) {
  return Object.values(deficit).every((value) => value <= EPSILON);
}

function rejection(id, reason) {
  return Object.freeze({ id, reason });
}

function classifiedReason(prefix, detail) {
  const normalized = typeof detail === 'string'
    ? detail.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 64)
    : '';
  return normalized ? `${prefix}:${normalized}` : prefix;
}

function validId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function probability(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : fallback;
}

function validProbability(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1;
}

function validOptionalNonNegativeNumber(value) {
  if (value == null) return true;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

function optionalNonNegativeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function requiredNonNegativeNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new TypeError(`${label} must be a finite non-negative number`);
  return numeric;
}

function boundedInteger(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= min ? Math.min(max, numeric) : fallback;
}

function boundedNumberAtLeast(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= min ? Math.min(max, numeric) : fallback;
}

function numericCompare(left, right) {
  if (Math.abs(left - right) <= EPSILON) return 0;
  return left < right ? -1 : 1;
}
