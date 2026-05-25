import { validatePlanActivation as defaultValidatePlanActivation } from './plan_guard.js';

export function stageAdvisorQueueReplacement(executor, plan, currentSnapshot, opts = {}) {
  if (!executor || typeof executor.requestQueueReplacement !== 'function') {
    return {
      ok: false,
      reason: 'executor queue replacement boundary unavailable',
    };
  }

  const validatePlanActivation = opts.validatePlanActivation || defaultValidatePlanActivation;
  const activation = validatePlanActivation(plan, currentSnapshot, {
    ...(opts.activationGuardOptions || {}),
    proposedFromSnapshot: opts.proposedFromSnapshot || opts.proposalSnapshot || opts.expectedSnapshot || null,
  });

  if (!activation.ok) {
    return {
      ok: false,
      reason: 'advisor queue proposal rejected: ' + activation.reason,
      activation,
    };
  }

  const replacement = executor.requestQueueReplacement(plan, {
    source: 'advisor',
    reason: opts.reason || 'advisor queue proposal',
    goal: opts.goal,
    activationSnapshotKey: activation.snapshotKey,
  });

  if (!replacement?.ok) {
    return {
      ok: false,
      reason: 'executor queue replacement failed: ' + (replacement?.reason || 'unknown failure'),
      activation,
      replacement,
    };
  }

  return {
    ok: true,
    reason: 'advisor queue proposal staged',
    count: replacement.count,
    activation,
    replacement,
  };
}

export default stageAdvisorQueueReplacement;
