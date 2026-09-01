export const DEFAULT_ADVISOR_COST_USD_MAX = 2.00;
export const DEFAULT_PROMPT_COST_USD_PER_MILLION_TOKENS = 2.00;
export const DEFAULT_COMPLETION_COST_USD_PER_MILLION_TOKENS = 8.00;

const SOFT_WARN_RATIO = 0.5;
const REFUSE_NEW_CALLS_RATIO = 0.9;
const HARD_LOGOUT_RATIO = 1;

export function normalizeAdvisorCostOptions(source = {}) {
  const maxUsd = positiveFinite(source.costUsdMax ?? source.maxUsd) ?? DEFAULT_ADVISOR_COST_USD_MAX;
  return {
    maxUsd,
    promptUsdPerMillionTokens: positiveFinite(source.promptUsdPerMillionTokens)
      ?? DEFAULT_PROMPT_COST_USD_PER_MILLION_TOKENS,
    completionUsdPerMillionTokens: positiveFinite(source.completionUsdPerMillionTokens)
      ?? DEFAULT_COMPLETION_COST_USD_PER_MILLION_TOKENS,
  };
}

export function estimateAdvisorCallCostUsd(responseMetrics = {}, opts = {}) {
  return classifyAdvisorUsage(responseMetrics, opts).callCostUsd;
}

export function classifyAdvisorUsage(responseMetrics = {}, opts = {}) {
  const rates = normalizeAdvisorCostOptions(opts);
  const promptTokens = nonNegativeFinite(responseMetrics.promptTokens);
  const completionTokens = nonNegativeFinite(responseMetrics.completionTokens);
  const totalTokens = nonNegativeFinite(responseMetrics.totalTokens);
  const higherRate = Math.max(
    rates.promptUsdPerMillionTokens,
    rates.completionUsdPerMillionTokens,
  );

  if (promptTokens !== null && completionTokens !== null) {
    const splitTotal = promptTokens + completionTokens;
    const exactCost = ((promptTokens || 0) * rates.promptUsdPerMillionTokens
      + (completionTokens || 0) * rates.completionUsdPerMillionTokens) / 1_000_000;
    if (totalTokens !== null && totalTokens !== splitTotal) {
      return {
        usageStatus: 'partial',
        callCostUsd: roundUsd(Math.max(splitTotal, totalTokens) * higherRate / 1_000_000),
      };
    }
    return {
      usageStatus: 'exact',
      callCostUsd: roundUsd(exactCost),
    };
  }

  const hasUsablePartialReceipt = promptTokens !== null
    || completionTokens !== null
    || totalTokens !== null;
  const knownPartialTokens = Math.max(promptTokens ?? 0, completionTokens ?? 0, totalTokens ?? 0);
  if (hasUsablePartialReceipt) {
    // Fail partial or aggregate accounting toward the larger observed count
    // and the more expensive token rate.
    return {
      usageStatus: 'partial',
      callCostUsd: roundUsd(knownPartialTokens * higherRate / 1_000_000),
    };
  }

  // A dispatched call with no complete or aggregate usage receipt may have
  // consumed the entire remaining provider budget. Fail closed at the ceiling.
  return {
    usageStatus: 'unknown',
    callCostUsd: rates.maxUsd,
  };
}

export function createAdvisorCostGuard(options = {}) {
  const normalized = normalizeAdvisorCostOptions(options);
  let callCount = 0;
  let sessionCostUsd = 0;
  let hardCeilingReached = false;

  function snapshot() {
    const ratio = normalized.maxUsd > 0 ? sessionCostUsd / normalized.maxUsd : 1;
    return {
      callCount,
      sessionCostUsd: roundUsd(sessionCostUsd),
      maxUsd: normalized.maxUsd,
      ratio: roundRatio(ratio),
      status: statusForRatio(ratio, hardCeilingReached),
      preferLastValidatedPlan: ratio >= SOFT_WARN_RATIO,
      refuseNewCalls: ratio >= REFUSE_NEW_CALLS_RATIO || hardCeilingReached,
      shouldLogoutAfterCurrentSkill: ratio >= HARD_LOGOUT_RATIO || hardCeilingReached,
    };
  }

  return {
    options: normalized,
    beforeCall() {
      const current = snapshot();
      if (current.refuseNewCalls) {
        return {
          ok: false,
          reason: current.shouldLogoutAfterCurrentSkill
            ? 'advisor cost ceiling exhausted; refusing new advisor calls'
            : 'advisor cost ceiling at 90%; refusing new advisor calls',
          ...current,
        };
      }
      return { ok: true, ...current };
    },
    recordCall(responseMetrics = {}) {
      const usage = classifyAdvisorUsage(responseMetrics, normalized);
      const { callCostUsd, usageStatus } = usage;
      callCount += 1;
      sessionCostUsd = roundUsd(sessionCostUsd + callCostUsd);
      if (usageStatus === 'unknown' || sessionCostUsd >= normalized.maxUsd) hardCeilingReached = true;
      return {
        ok: true,
        callCostUsd,
        usageStatus,
        ...snapshot(),
      };
    },
    snapshot,
    reset() {
      callCount = 0;
      sessionCostUsd = 0;
      hardCeilingReached = false;
    },
  };
}

function statusForRatio(ratio, hardCeilingReached = false) {
  if (hardCeilingReached || ratio >= HARD_LOGOUT_RATIO) return 'hard_logout';
  if (ratio >= REFUSE_NEW_CALLS_RATIO) return 'refuse_new_calls';
  if (ratio >= SOFT_WARN_RATIO) return 'prefer_last_validated_plan';
  return 'normal';
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function roundRatio(value) {
  return Math.round(Number(value || 0) * 10_000) / 10_000;
}

export default {
  DEFAULT_ADVISOR_COST_USD_MAX,
  DEFAULT_PROMPT_COST_USD_PER_MILLION_TOKENS,
  DEFAULT_COMPLETION_COST_USD_PER_MILLION_TOKENS,
  normalizeAdvisorCostOptions,
  estimateAdvisorCallCostUsd,
  classifyAdvisorUsage,
  createAdvisorCostGuard,
};
