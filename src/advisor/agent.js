// Advisor agent: ties planner ↔ executor.
//   1. Build snapshot.
//   2. plan(goal, snapshot) -> ordered skill calls.
//   3. executor.runUntilDone()
//   4. On queue:failure -> replan(goal, fresh snapshot, lastFailure) -> repeat.
//   5. On queue:empty   -> goal complete.
//
// Caps the number of re-plan cycles to avoid infinite loops.

import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { getAdvisorCostSnapshot as getAdvisorCostSnapshotFn } from './deepseek.js';
import { plan as planFn, replan as replanFn } from './planner.js';
import { validatePlanActivation as validatePlanActivationFn } from './plan_guard.js';

export class AdvisorAgent {
  constructor(bot, executor, opts = {}) {
    this.bot = bot;
    this.executor = executor;
    this.maxReplans = opts.maxReplans ?? 6;
    this.plan = opts.plan || planFn;
    this.replan = opts.replan || replanFn;
    this.buildSnapshot = opts.buildSnapshot || buildSnapshot;
    this.snapshotContext = opts.snapshotContext || null;
    this.snapshotContextProvider = opts.snapshotContextProvider || null;
    this.validatePlanActivation = opts.validatePlanActivation || validatePlanActivationFn;
    this.activationGuardOptions = opts.activationGuardOptions || {};
    this.costSnapshotProvider = opts.costSnapshotProvider || getAdvisorCostSnapshotFn;
    this._budgetLogoutRequested = false;
    this.replans = 0;
  }

  async pursue(goal) {
    log.advisor.info('goal.start', { goal });
    let snapshot = this._buildSnapshot();
    let planResult;
    try {
      planResult = await this.plan(goal, snapshot);
    } catch (err) {
      const reason = errorMessage(err);
      log.advisor.error('goal.plan-error', { goal, err: reason });
      return { ok: false, reason: 'initial plan threw: ' + reason };
    }
    if (!planResult.ok) {
      log.advisor.error('goal.no-initial-plan', { goal, reason: planResult.reason });
      return { ok: false, reason: 'no initial plan: ' + planResult.reason };
    }

    while (true) {
      const activation = this._validateActivation(goal, planResult.plan, snapshot);
      if (!activation.ok) return activation.result;

      this.executor.clear();
      this.executor.enqueue(planResult.plan);

      let failureSeen = null;
      const onFailure = ({ call, result }) => {
        failureSeen = { skill: call.skill, params: call.params, reason: result.reason };
      };
      const listener = addQueueFailureListener(this.executor, onFailure, goal);
      if (!listener.ok) {
        this.executor.clear();
        return { ok: false, reason: 'queue failure listener unavailable: ' + listener.reason };
      }
      let listenerCleanupFailure = null;
      const skillResultListener = this._addBudgetSkillResultListener(goal);
      try {
        await this.executor.runUntilDone();
      } finally {
        if (skillResultListener) removeOptionalListener(this.executor, 'skill:result', skillResultListener, goal);
        listenerCleanupFailure = removeQueueFailureListener(this.executor, onFailure, goal);
      }
      const budgetStop = this._requestBudgetLogoutIfNeeded(goal, { phase: 'after-run' });
      if (budgetStop?.requested) {
        return { ok: false, reason: 'advisor-budget-exhausted', cost: budgetStop.cost };
      }
      if (this._budgetLogoutRequested) {
        return { ok: false, reason: 'advisor-budget-exhausted', cost: safeCostSnapshot(this.costSnapshotProvider) };
      }
      if (listenerCleanupFailure) {
        return { ok: false, reason: 'queue failure listener cleanup failed: ' + listenerCleanupFailure };
      }

      if (!failureSeen) {
        log.advisor.info('goal.complete', { goal, replans: this.replans });
        return { ok: true, reason: 'goal complete', replans: this.replans };
      }

      this.replans += 1;
      if (this.replans > this.maxReplans) {
        log.advisor.error('goal.gave-up', { goal, replans: this.replans });
        return { ok: false, reason: `gave up after ${this.replans} re-plans (last: ${failureSeen.reason})` };
      }
      log.advisor.warn('goal.replan', { goal, attempt: this.replans, failure: failureSeen });
      const budgetBeforeReplan = this._requestBudgetLogoutIfNeeded(goal, { phase: 'before-replan' });
      if (budgetBeforeReplan?.requested) {
        return { ok: false, reason: 'advisor-budget-exhausted', cost: budgetBeforeReplan.cost };
      }
      snapshot = this._buildSnapshot();
      const remaining = [...this.executor.queue];
      try {
        planResult = await this.replan(goal, snapshot, failureSeen, remaining);
      } catch (err) {
        const reason = errorMessage(err);
        log.advisor.error('goal.replan-error', { goal, err: reason, attempt: this.replans });
        return { ok: false, reason: 'replan threw: ' + reason };
      }
      if (!planResult.ok) {
        log.advisor.error('goal.replan-failed', { goal, reason: planResult.reason });
        return { ok: false, reason: 'no replan: ' + planResult.reason };
      }
    }
  }

  _validateActivation(goal, plan, proposedFromSnapshot) {
    const currentSnapshot = this._buildSnapshot();
    const activation = this.validatePlanActivation(plan, currentSnapshot, {
      ...this.activationGuardOptions,
      proposedFromSnapshot,
    });
    if (activation.ok) {
      log.advisor.info('goal.plan-activation-ok', {
        goal,
        safetyReasons: activation.safetyReasons || [],
        staleReasons: activation.staleReasons || [],
      });
      return { ok: true, activation };
    }

    log.advisor.warn('goal.plan-activation-rejected', {
      goal,
      reason: activation.reason,
      badIndex: activation.badIndex,
      safetyReasons: activation.safetyReasons || [],
      staleReasons: activation.staleReasons || [],
    });
    return {
      ok: false,
      result: {
        ok: false,
        reason: 'plan activation rejected: ' + activation.reason,
        activation,
      },
    };
  }

  _buildSnapshot() {
    const ctx = this.snapshotContextProvider
      ? this.snapshotContextProvider({ agent: this, bot: this.bot, executor: this.executor })
      : this.snapshotContext;
    return ctx ? this.buildSnapshot(this.bot, ctx) : this.buildSnapshot(this.bot);
  }

  _addBudgetSkillResultListener(goal) {
    if (!this.executor || typeof this.executor.on !== 'function') return null;
    const listener = () => this._requestBudgetLogoutIfNeeded(goal, { phase: 'after-skill' });
    try {
      this.executor.on('skill:result', listener);
      return listener;
    } catch (err) {
      log.advisor.warn('goal.budget-listener-error', { goal, err: errorMessage(err) });
      return null;
    }
  }

  _requestBudgetLogoutIfNeeded(goal, meta = {}) {
    let cost;
    try {
      cost = this.costSnapshotProvider?.();
    } catch (err) {
      log.advisor.warn('goal.budget-read-error', { goal, err: errorMessage(err), phase: meta.phase });
      return null;
    }
    if (!cost?.shouldLogoutAfterCurrentSkill || this._budgetLogoutRequested) return null;
    this._budgetLogoutRequested = true;
    const call = { skill: 'logout', params: { reason: 'advisor-budget-exhausted' } };
    let logoutRequest = null;
    if (typeof this.executor?.requestQueueReplacement === 'function') {
      try {
        logoutRequest = this.executor.requestQueueReplacement([call], {
          reason: 'advisor-budget-exhausted',
          phase: meta.phase,
        });
      } catch (err) {
        logoutRequest = { ok: false, reason: `queue replacement failed: ${errorMessage(err)}` };
      }
    } else if (typeof this.bot?.quit === 'function') {
      try {
        this.bot.quit('advisor-budget-exhausted');
        logoutRequest = { ok: true, mode: 'bot.quit' };
      } catch (err) {
        logoutRequest = { ok: false, reason: `bot.quit failed: ${errorMessage(err)}` };
      }
    } else {
      logoutRequest = { ok: false, reason: 'logout unavailable' };
    }
    log.advisor.error('goal.advisor-budget-exhausted', {
      goal,
      phase: meta.phase,
      cost,
      logoutRequest,
    });
    return { requested: true, cost, logoutRequest };
  }
}

export default AdvisorAgent;

function errorMessage(err) {
  return err?.message || String(err);
}

function safeCostSnapshot(provider) {
  try {
    return provider?.() || null;
  } catch {
    return null;
  }
}

function addQueueFailureListener(executor, onFailure, goal) {
  try {
    executor.on('queue:failure', onFailure);
    return { ok: true };
  } catch (err) {
    const reason = errorMessage(err);
    log.advisor.error('goal.queue-listener-error', { goal, err: reason });
    return { ok: false, reason };
  }
}

function removeQueueFailureListener(executor, onFailure, goal) {
  try {
    executor.removeListener('queue:failure', onFailure);
    return null;
  } catch (err) {
    const reason = errorMessage(err);
    log.advisor.warn('goal.queue-listener-remove-error', { goal, err: reason });
    return reason;
  }
}

function removeOptionalListener(executor, eventName, listener, goal) {
  try {
    executor.removeListener?.(eventName, listener);
  } catch (err) {
    log.advisor.warn('goal.listener-remove-error', { goal, eventName, err: errorMessage(err) });
  }
}
