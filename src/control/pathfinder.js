// PathfinderOwner — the single chokepoint for all bot.pathfinder writes.
//
// Contract:
//   - Reactive always outranks skills. acquire('reactive') always succeeds and
//     preempts a skill holder (aborts the skill's signal + pathfinder.stop()).
//   - acquire('skill') returns null when reactive holds the token; the skill
//     returns { preempted: true, ... } and the executor resumes it after
//     reactive releases + quiescence debounce.
//   - setGoal / stop are token-gated. Stale tokens log a warning and no-op.
//   - The owner tracks pathfinder idle status (no active goal) via path events
//     so the executor's resume-quiescence wait has something to query.
//
// Token shape is opaque ({}). Identity comparison only — never compare fields.

import log from '../logger.js';
import interrupts from '../reactive/interrupts.js';

export class PathfinderOwner {
  constructor(bot) {
    this.bot = bot;
    this._owner = null;          // 'reactive' | 'skill' | null
    this._reason = null;
    this._token = null;
    this._skillController = null; // AbortController bound by executor each invocation

    // Pathfinder state tracking. _goalActive flips true on setGoal, false on
    // goal_reached / noPath / stop / path_stop.
    this._goalActive = false;
    this._idleSince = Date.now();
    this._stateRevision = 0;

    // Subscribe to pathfinder events. mineflayer-pathfinder emits these on the bot.
    this._bindBotEvent('goal_reached', () => this._markIdle('goal_reached'));
    this._bindBotEvent('path_update', (r) => {
      if (r && (r.status === 'noPath' || r.status === 'timeout')) this._markIdle(`path_${r.status}`);
    });
    this._bindBotEvent('path_stop', () => this._markIdle('path_stop'));
    this._bindBotEvent('goal_updated', (g) => log.reactive.trace('owner.goal_updated', { hasGoal: !!g }));
  }

  _bindBotEvent(eventName, listener) {
    try {
      this.bot.on(eventName, listener);
      return true;
    } catch (err) {
      log.reactive.warn('owner.listener-error', {
        event: eventName,
        err: err?.message || String(err),
      });
      return false;
    }
  }

  _markIdle(why) {
    if (!this._goalActive) return;
    this._goalActive = false;
    this._idleSince = Date.now();
    this._markStateChanged();
    log.reactive.trace('owner.idle', { why });
  }

  _markStateChanged() {
    this._stateRevision += 1;
  }

  /** Called by the executor at the start of each skill invocation. */
  bindSkillSignal(controller) {
    this._skillController = controller;
  }

  /** Called by the executor when the skill returns (so a stale controller doesn't get aborted later). */
  unbindSkillSignal() {
    this._skillController = null;
  }

  /**
   * Acquire the pathfinder token.
   *
   *   acquire('reactive', { reason }) — always succeeds. If a skill holds the
   *     token, its signal is aborted and pathfinder.stop() fires so the skill
   *     unwinds cleanly. Notifies interrupts.preempted.
   *
   *   acquire('skill', { reason }) — returns null if reactive holds the token.
   *     Otherwise grants the token and the bound skill signal.
   *
   * Returns null on denial, otherwise { token, signal, release }.
   */
  acquire(owner, { reason } = {}) {
    if (owner === 'reactive') {
      if (this._owner === 'reactive') {
        // Already ours — reuse the existing token rather than churning.
        return this._grantHandle();
      }
      if (this._owner === 'skill') {
        log.reactive.info('owner.preempt', { from: this._reason, to: reason });
        if (this._skillController && !this._skillController.signal.aborted) {
          try { this._skillController.abort('reactive-preempt'); } catch (err) { log.reactive.warn('owner.abort-error', { err: err.message }); }
        }
        this._stopPathfinder('preempt-stop');
        interrupts.notifyPreempt(reason);
      } else {
        // Going NORMAL -> reactive without a skill in flight (e.g., bot just spawned into hostiles).
        interrupts.notifyPreempt(reason);
      }
      this._owner = 'reactive';
      this._reason = reason || 'reactive';
      this._token = { kind: 'reactive' };
      this._markStateChanged();
      return this._grantHandle();
    }

    if (owner === 'skill') {
      if (this._owner === 'reactive') {
        log.executor.debug('owner.denied', { requester: 'skill', reason, blockedBy: this._reason });
        return null;
      }
      const ownerChanged = this._owner !== 'skill';
      // Skill takes (or refreshes) the token. Note: the executor runs skills
      // strictly sequentially, so we should never see two distinct skills here.
      this._owner = 'skill';
      this._reason = reason || 'skill';
      this._token = { kind: 'skill' };
      if (ownerChanged) this._markStateChanged();
      return this._grantHandle();
    }

    throw new Error(`PathfinderOwner.acquire: invalid owner "${owner}"`);
  }

  _grantHandle() {
    const myToken = this._token;
    return {
      token: myToken,
      signal: this._owner === 'skill' ? (this._skillController?.signal || null) : null,
      release: () => this._release(myToken),
    };
  }

  _release(token) {
    if (this._token !== token) {
      // Stale release — owner has already changed. No-op.
      return;
    }
    const wasOwner = this._owner;
    const wasReason = this._reason;
    this._owner = null;
    this._reason = null;
    this._token = null;
    this._markStateChanged();
    if (wasOwner === 'reactive') {
      log.reactive.info('owner.release', { from: wasReason });
      interrupts.notifyRelease(wasReason);
    }
  }

  /** Token-gated setGoal. Returns true on success, false if token is stale. */
  /**
   * Token-gated setGoal.
   *
   * @param {object} token - the handle returned by acquire()
   * @param {object} goal  - a mineflayer-pathfinder Goal instance
   * @param {object} opts
   * @param {object} [opts.movements] - optional Movements to install first
   * @param {boolean} [opts.dynamic]  - forwarded to bot.pathfinder.setGoal(goal, dynamic).
   *                                    When true, pathfinder will NOT emit goal_reached
   *                                    or null the goal even after the bot reaches a
   *                                    satisfying node — it keeps polling hasChanged()
   *                                    so the goal can re-target a moving entity.
   *                                    Use this for entity-relative goals like
   *                                    GoalInvert(GoalFollow(entity, range)).
   */
  setGoal(token, goal, { movements, dynamic } = {}) {
    if (this._token !== token) {
      log.reactive.warn('owner.setGoal.bad-token', {
        currentOwner: this._owner,
        currentReason: this._reason,
        callerKind: token?.kind,
      });
      return false;
    }
    try {
      const applyGoal = (plannedGoal = goal, plannedDynamic = dynamic) => {
        if (movements) this.bot.pathfinder.setMovements(movements);
        this.bot.pathfinder.setGoal(plannedGoal, plannedDynamic === true);
      };
      if (typeof this.bot.humanizer?.setPathfinderGoal === 'function') {
        this.bot.humanizer.setPathfinderGoal({
          bot: this.bot,
          goal,
          dynamic,
          movements,
          reason: this._reason || 'pathfinder.setGoal',
          applyGoal,
        });
      } else {
        applyGoal(goal, dynamic);
      }
      const wasGoalActive = this._goalActive;
      this._goalActive = true;
      this._idleSince = 0;
      if (!wasGoalActive) this._markStateChanged();
      return true;
    } catch (err) {
      log.reactive.error('owner.setGoal.error', { err: err.message });
      return false;
    }
  }

  /** Token-gated stop. Cleanly cancels the pathfinder goal. */
  stop(token) {
    if (this._token !== token) return false;
    return this._stopPathfinder('owner-stop');
  }

  _stopPathfinder(idleReason) {
    try {
      this.bot.pathfinder.stop();
    } catch (err) {
      log.reactive.warn('owner.stop-error', { err: err.message });
      return false;
    }
    this._markIdle(idleReason);
    return true;
  }

  /** True when no pathfinder goal is active. */
  isIdle() {
    return !this._goalActive;
  }

  /**
   * Resolves when isIdle() has been continuously true for debounceMs. Returns
   * false if timeoutMs elapses first.
   */
  async waitForIdle(debounceMs, timeoutMs = 30000) {
    const start = Date.now();
    while (true) {
      if (this.isIdle() && Date.now() - this._idleSince >= debounceMs) return true;
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  currentOwner() {
    return this._owner;
  }

  /** Monotonic owner/idle transition counter used to reject stale advisor plans. */
  stateRevision() {
    return this._stateRevision;
  }
}

export default PathfinderOwner;
