// Skill executor — strictly sequential, one skill at a time.
//
// Contract changes from Phase 2 (decisions 1-4):
//
//   1. Each invocation gets a fresh AbortController. Its signal is passed to
//      the skill via ctx.signal AND registered with bot.pathfinderOwner so a
//      reactive preempt can abort it.
//
//   2. Skills return one of three outcomes:
//        { ok: true,  reason, state }   — terminal success: shift queue, continue
//        { ok: false, reason, state }   — terminal failure: emit queue:failure, break
//        { preempted: true, reason, state } — NOT a failure: do NOT shift,
//          loop back to the resume wait, re-invoke the SAME call object.
//
//   3. The call object is peeked (queue[0]), not shifted, until a terminal
//      outcome. Skills mutate ctx.callState (an object on the call) to remember
//      progress, current target, and per-target interruption counters across
//      resume cycles.
//
//   4. The resume gate waits for THREE conditions before invoking the next
//      skill:
//        a. paused === false (interrupts.released fired)
//        b. Date.now() - interrupts.lastReleasedAt >= config.reactive.resumeDebounceMs
//        c. bot.pathfinderOwner.isIdle()
//      This is the quiescence debounce — reactive must have settled.
//      Once reactive is quiet, a bounded watchdog turns a stale non-idle
//      pathfinder into a queue failure instead of an indefinite executor hang.

import { EventEmitter } from 'node:events';
import config from '../config.js';
import log from '../logger.js';
import { SKILL_REGISTRY, validateSkillCall } from '../skills/index.js';
import interrupts from '../reactive/interrupts.js';

export class SkillExecutor extends EventEmitter {
  constructor(bot, opts = {}) {
    super();
    this.bot = bot;
    this.bot.skillExecutor = this;
    this.context = opts.context || bot.runtimeContext || {};
    this.contextProvider = opts.contextProvider || null;
    this.interruptBus = opts.interruptBus || interrupts;
    this.logger = opts.logger || log.executor;
    this.queue = [];
    this.running = false;
    this.paused = false;
    this.currentCall = null;
    this.currentSubtask = null;
    this.currentSignal = null;
    this._lastTerminalCall = null;
    this.pendingQueuePrefixes = [];
    this.pendingQueueReplacement = null;
    this.disposed = false;
    this._recentEvents = [];
    this._recentEventSeq = 0;
    this._recentEventStoreLimit = Math.max(12, (config.advisor?.snapshotRecentEventsCap ?? 12) * 4);
    this._onInterruptPreempted = (reason) => this._onPreempted(reason);
    this._onInterruptReleased = (reason) => this._onReleased(reason);
    this._interruptListeners = [];
    this.interruptListenersReady = true;

    this._addInterruptListener('preempted', this._onInterruptPreempted);
    this._addInterruptListener('released', this._onInterruptReleased);
  }

  enqueue(calls) {
    const list = Array.isArray(calls) ? calls : [calls];
    for (const c of list) {
      const v = validateSkillCall(c);
      if (!v.ok) {
        log.executor.error('enqueue.invalid', { reason: v.reason, call: skillCallForLog(c) });
        throw new Error(`Invalid skill call: ${v.reason}`);
      }
      // Cross the admission boundary with a private copy and a fresh state slot.
      // The queued copy itself remains stable across reactive preemption/resume.
      this.queue.push(cloneSkillCall(c));
    }
    log.executor.info('enqueue', { count: list.length, queueLen: this.queue.length });
    this._recordEvent('queue.enqueue', { count: list.length, queueLength: this.queue.length });
  }

  requestQueueReplacement(calls, meta = {}) {
    const list = Array.isArray(calls) ? calls : [calls];
    const replacement = [];
    for (const c of list) {
      const v = validateSkillCall(c);
      if (!v.ok) {
        log.executor.error('queue.replacement.invalid', { reason: v.reason, call: skillCallForLog(c) });
        return { ok: false, reason: `Invalid skill call: ${v.reason}` };
      }
      replacement.push(cloneSkillCall(c));
    }
    this.pendingQueueReplacement = { calls: replacement, meta };
    log.executor.info('queue.replacement.requested', {
      count: replacement.length,
      running: this.running,
      currentSubtask: this.currentSubtask,
      reason: meta.reason,
    });
    this._recordEvent('queue.replacement.requested', {
      count: replacement.length,
      running: this.running,
      reason: meta.reason,
    });
    return { ok: true, count: replacement.length };
  }

  requestQueuePrefix(calls, meta = {}) {
    const list = Array.isArray(calls) ? calls : [calls];
    const prefix = [];
    for (const c of list) {
      const v = validateSkillCall(c);
      if (!v.ok) {
        log.executor.error('queue.prefix.invalid', { reason: v.reason, call: skillCallForLog(c) });
        return { ok: false, reason: `Invalid skill call: ${v.reason}` };
      }
      prefix.push(cloneSkillCall(c));
    }
    this.pendingQueuePrefixes.push({ calls: prefix, meta });
    log.executor.info('queue.prefix.requested', {
      count: prefix.length,
      running: this.running,
      currentSubtask: this.currentSubtask,
      reason: meta.reason,
    });
    this._recordEvent('queue.prefix.requested', {
      count: prefix.length,
      running: this.running,
      reason: meta.reason,
    });
    return { ok: true, count: prefix.length };
  }

  requestCurrentSkillAbort(reason = 'external abort requested') {
    const controller = this.currentSignal;
    if (!controller?.signal || controller.signal.aborted) {
      return { ok: false, reason: 'no active skill signal to abort' };
    }
    controller.abort(reason);
    log.executor.warn('skill.abort-requested', {
      reason,
      currentSubtask: this.currentSubtask,
    });
    this._recordEvent('skill.abort-requested', {
      skill: this.currentCall?.skill,
      reason,
    });
    return { ok: true, reason };
  }

  clear() {
    log.executor.info('clear', { dropped: this.queue.length });
    this._recordEvent('queue.clear', { dropped: this.queue.length });
    this.queue.length = 0;
    this.pendingQueuePrefixes.length = 0;
    this.pendingQueueReplacement = null;
  }

  recentEvents(limit = config.advisor?.snapshotRecentEventsCap ?? 12) {
    const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 12;
    return this._recentEvents.slice(-n).map((event) => ({ ...event }));
  }

  _recordEvent(event, fields = {}) {
    const compact = compactExecutorEvent({
      seq: ++this._recentEventSeq,
      event,
      ...fields,
    });
    this._recentEvents.push(compact);
    if (this._recentEvents.length > this._recentEventStoreLimit) {
      this._recentEvents.splice(0, this._recentEvents.length - this._recentEventStoreLimit);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { eventName, listener } of this._interruptListeners.splice(0)) {
      try {
        this.interruptBus.off(eventName, listener);
      } catch (err) {
        this.logger.warn('interrupt.listener-remove-error', {
          event: eventName,
          err: errorMessage(err),
        });
      }
    }
  }

  _addInterruptListener(eventName, listener) {
    try {
      this.interruptBus.on(eventName, listener);
      this._interruptListeners.push({ eventName, listener });
    } catch (err) {
      this.interruptListenersReady = false;
      this.logger.error('interrupt.listener-add-error', {
        event: eventName,
        err: errorMessage(err),
      });
    }
  }

  _onPreempted(reason) {
    if (this.paused) return;
    this.paused = true;
    log.executor.warn('preempted', { reason, subtask: this.currentSubtask });
    this._recordEvent('reactive.preempted', {
      skill: this.currentCall?.skill,
      reason,
    });
  }

  _onReleased(reason) {
    if (!this.paused) return;
    this.paused = false;
    log.executor.info('released', { from: reason });
    this._recordEvent('reactive.released', {
      reason,
    });
  }

  /**
   * Block until reactive has been quiet for at least resumeDebounceMs AND the
   * pathfinder is idle. Polls at 50ms granularity.
   */
  async _waitForResume() {
    const debounceMs = config.reactive?.resumeDebounceMs ?? 1000;
    const timeoutMs = config.executor?.resumeGateTimeoutMs ?? 30000;
    let idleRead = readPathfinderIdle(this.bot);
    if (!idleRead.ok) return resumeGateIdleFailure(this.bot, idleRead, debounceMs, timeoutMs, this.paused, this.interruptBus.lastReleasedAt);
    if (!this.paused && Date.now() - this.interruptBus.lastReleasedAt >= debounceMs && idleRead.idle) {
      return { ok: true }; // fast path
    }
    log.executor.info('resume.wait', { debounceMs, paused: this.paused });
    let blockedSince = null;
    while (true) {
      const now = Date.now();
      const reactiveQuiet = !this.paused && now - this.interruptBus.lastReleasedAt >= debounceMs;
      idleRead = readPathfinderIdle(this.bot);
      if (!idleRead.ok) return resumeGateIdleFailure(this.bot, idleRead, debounceMs, timeoutMs, this.paused, this.interruptBus.lastReleasedAt);
      const pathfinderIdle = idleRead.idle;
      if (reactiveQuiet && pathfinderIdle) {
        log.executor.info('resume.ready');
        return { ok: true };
      }
      if (reactiveQuiet && !pathfinderIdle) {
        if (blockedSince === null) blockedSince = now;
        const blockedMs = now - blockedSince;
        if (timeoutMs > 0 && blockedMs >= timeoutMs) {
          const ownerRead = readPathfinderOwner(this.bot);
          const details = {
            debounceMs,
            timeoutMs,
            blockedMs,
            paused: this.paused,
            owner: ownerRead.ok ? ownerRead.owner : null,
            ownerError: ownerRead.ok ? undefined : ownerRead.err,
            lastReleasedAgeMs: now - this.interruptBus.lastReleasedAt,
          };
          log.executor.warn('resume.timeout', details);
          return {
            ok: false,
            reason: `resume gate timed out waiting for pathfinder idle after ${blockedMs}ms`,
            details,
          };
        }
      } else {
        blockedSince = null;
      }
      await sleep(50);
    }
  }

  async runUntilDone() {
    if (this.running) return;
    this.running = true;
    let failed = false;
    try {
      while (this.queue.length > 0 || this.pendingQueueReplacement || this.pendingQueuePrefixes.length > 0) {
        this._applyPendingQueueReplacement();
        this._applyPendingQueuePrefixes();
        if (this.queue.length === 0) continue;
        if (!this.interruptListenersReady) {
          const call = this.queue[0];
          const result = { ok: false, reason: 'executor interrupt listeners unavailable' };
          failed = true;
          this.currentCall = null;
          this.currentSubtask = null;
          this.pendingQueueReplacement = null;
          log.executor.warn('queue.failure', { skill: call.skill, reason: result.reason });
          this._recordEvent('queue.failure', { skill: call.skill, reason: result.reason });
          this.emit('queue:failure', { call, result });
          break;
        }
        const resume = await this._waitForResume();
        if (!resume.ok) {
          const call = this.queue[0];
          const result = { ok: false, reason: resume.reason, state: resume.details };
          failed = true;
          this.currentCall = null;
          this.currentSubtask = null;
          this.pendingQueueReplacement = null;
          log.executor.warn('queue.failure', { skill: call.skill, reason: result.reason });
          this._recordEvent('queue.failure', { skill: call.skill, reason: result.reason });
          this.emit('queue:failure', { call, result });
          break;
        }

        // Peek, don't shift. We only shift on a terminal outcome so preempts
        // can resume the SAME call object (with its accumulated callState).
        const call = this.queue[0];
        if (!call._state) call._state = {};

        const controller = new AbortController();
        const interAction = await this._runInterActionVariation(call, controller.signal);
        if (!interAction.ok) {
          const result = { ok: false, reason: interAction.reason };
          failed = true;
          this.currentCall = null;
          this.currentSubtask = null;
          this.pendingQueueReplacement = null;
          log.executor.warn('queue.failure', { skill: call.skill, reason: result.reason });
          this._recordEvent('queue.failure', { skill: call.skill, reason: result.reason });
          this.emit('queue:failure', { call, result });
          break;
        }
        if (this.paused || interAction.skippedForReactive === true) {
          this.currentCall = null;
          this.currentSubtask = null;
          continue;
        }

        this.currentSignal = controller;
        this.bot.pathfinderOwner?.bindSkillSignal(controller);

        this.currentCall = call;
        this.currentSubtask = `${call.skill}(${shortParams(call.params)})`;
        const fn = SKILL_REGISTRY[call.skill];

        const resumeMarker = Object.keys(call._state).length > 0 ? ' (resume)' : '';
        const executorState = updateExecutorCallState(call, Date.now());
        log.executor.info('skill.invoke', {
          skill: call.skill,
          params: call.params,
          queueLeft: this.queue.length - 1,
          resume: !!resumeMarker,
          attempt: executorState.attempts,
        });
        this._recordEvent('skill.start', {
          skill: call.skill,
          queueLeft: this.queue.length - 1,
          resume: !!resumeMarker,
          attempt: executorState.attempts,
        });
        this.emit('skill:start', call);

        let result;
        const t0 = Date.now();
        try {
          const extraContext = this.contextProvider
            ? this.contextProvider({ executor: this, call, queue: this.queue })
            : this.context;
          result = await withTimeout(
            fn(this.bot, call.params || {}, {
              ...extraContext,
              currentSubtask: this.currentSubtask,
              remainingQueue: this.queue.slice(1),
              signal: controller.signal,
              callState: call._state,
            }),
            config.executor.skillTimeoutMs,
            'skill timed out',
            () => abortSkillController(controller, 'skill timed out'),
            (late) => logLateSkillTimeout(call, late),
          );
        } catch (err) {
          result = { ok: false, reason: `skill threw: ${err.message}` };
        } finally {
          this.bot.pathfinderOwner?.unbindSkillSignal();
          this.currentSignal = null;
        }
        const dt = Date.now() - t0;

        // Preempted: NOT a failure. Loop back to wait for resume, then re-invoke
        // the SAME call (still in queue[0], still carrying _state).
        if (result && result.preempted) {
          log.executor.info('skill.preempted', {
            skill: call.skill,
            reason: result.reason,
            dtMs: dt,
          });
          this._recordEvent('skill.preempted', {
            skill: call.skill,
            reason: result.reason,
            dtMs: dt,
          });
          this.emit('skill:preempted', { call, result });
          this.currentCall = null;
          this.currentSubtask = null;
          continue;
        }

        // Terminal outcome: shift queue.
        this.queue.shift();
        log.executor.info('skill.result', {
          skill: call.skill,
          ok: !!result?.ok,
          reason: result?.reason,
          dtMs: dt,
        });
        this._recordEvent('skill.result', {
          skill: call.skill,
          ok: !!result?.ok,
          reason: result?.reason,
          dtMs: dt,
        });
        this.emit('skill:result', { call, result });
        this.currentCall = null;
        this.currentSubtask = null;
        this._lastTerminalCall = call;

        if (!result || !result.ok) {
          failed = true;
          this.pendingQueuePrefixes.length = 0;
          this.pendingQueueReplacement = null;
          log.executor.warn('queue.failure', { skill: call.skill, reason: result?.reason });
          this._recordEvent('queue.failure', { skill: call.skill, reason: result?.reason });
          this.emit('queue:failure', { call, result });
          break;
        }
      }
      if (!failed && this.queue.length === 0) {
        this.currentCall = null;
        this.currentSubtask = null;
        log.executor.info('queue.empty');
        this._recordEvent('queue.empty');
        this.emit('queue:empty');
      }
    } finally {
      this.running = false;
    }
  }

  _applyPendingQueueReplacement() {
    if (!this.pendingQueueReplacement || this.currentCall) return;
    const pending = this.pendingQueueReplacement;
    this.pendingQueueReplacement = null;
    this.queue = pending.calls.map(cloneSkillCall);
    for (const c of this.queue) if (!c._state) c._state = {};
    log.executor.info('queue.replacement.applied', {
      count: this.queue.length,
      reason: pending.meta?.reason,
    });
    this._recordEvent('queue.replacement.applied', {
      count: this.queue.length,
      reason: pending.meta?.reason,
    });
  }

  _applyPendingQueuePrefixes() {
    if (this.currentCall || this.pendingQueuePrefixes.length === 0) return;
    const pending = this.pendingQueuePrefixes.splice(0);
    const calls = pending.flatMap((entry) => entry.calls.map(cloneSkillCall));
    if (calls.length === 0) return;
    this.queue = [...calls, ...this.queue];
    for (const c of this.queue) if (!c._state) c._state = {};
    log.executor.info('queue.prefix.applied', {
      count: calls.length,
      reasons: pending.map((entry) => entry.meta?.reason).filter(Boolean),
    });
    this._recordEvent('queue.prefix.applied', {
      count: calls.length,
      reason: pending.map((entry) => entry.meta?.reason).filter(Boolean).join('; '),
    });
  }

  async _runInterActionVariation(call, signal) {
    const humanizer = this.bot?.humanizer;
    if (!this._lastTerminalCall || typeof humanizer?.betweenActions !== 'function') {
      return { ok: true, skipped: true };
    }
    if (this.paused) return { ok: true, skippedForReactive: true };
    try {
      const result = await humanizer.betweenActions(this.bot, {
        reason: 'executor.between-skills',
        previousSkill: this._lastTerminalCall.skill,
        nextSkill: call.skill,
        signal,
      });
      if (result?.plan) {
        this._recordEvent('humanize.inter-action', {
          skill: call.skill,
          reason: `${this._lastTerminalCall.skill}->${call.skill}`,
          dtMs: result.plan.delayMs,
        });
      }
      if (result?.skipped && /reactive priority/.test(String(result.reason || ''))) {
        return { ok: true, skippedForReactive: true };
      }
      return { ok: true, result };
    } catch (err) {
      return { ok: false, reason: `humanization inter-action failed: ${errorMessage(err)}` };
    }
  }
}

function compactExecutorEvent(event) {
  const out = {};
  if (Number.isFinite(event.seq)) out.seq = event.seq;
  if (event.event) out.event = String(event.event);
  if (event.skill) out.skill = String(event.skill);
  if (typeof event.reason === 'string' && event.reason) out.reason = shortEventText(event.reason);
  if (typeof event.ok === 'boolean') out.ok = event.ok;
  if (typeof event.preempted === 'boolean') out.preempted = event.preempted;
  if (typeof event.resume === 'boolean') out.resume = event.resume;
  if (typeof event.running === 'boolean') out.running = event.running;
  for (const key of ['attempt', 'count', 'dropped', 'queueLength', 'queueLeft', 'dtMs']) {
    if (Number.isFinite(event[key])) out[key] = Math.max(0, Math.round(event[key]));
  }
  return out;
}

function shortEventText(value) {
  const text = String(value);
  return text.length > 160 ? text.slice(0, 157) + '...' : text;
}

function updateExecutorCallState(call, nowMs) {
  if (!call._state || typeof call._state !== 'object') call._state = {};
  if (!call._state._executor || typeof call._state._executor !== 'object') {
    call._state._executor = {
      startedAtMs: nowMs,
      attempts: 0,
    };
  }
  const state = call._state._executor;
  if (!Number.isFinite(state.startedAtMs)) state.startedAtMs = nowMs;
  state.attempts = Number.isFinite(state.attempts) ? state.attempts + 1 : 1;
  state.lastInvokeAtMs = nowMs;
  return state;
}

function cloneSkillCall(call) {
  return {
    skill: call.skill,
    params: call.params === undefined ? {} : JSON.parse(JSON.stringify(call.params)),
    _state: {},
  };
}

function skillCallForLog(call) {
  if (!call || typeof call !== 'object') return call;
  return {
    skill: call.skill,
    params: shortParams(call.params, { logError: false }),
  };
}

function shortParams(p, opts = {}) {
  if (!p) return '';
  try {
    const s = JSON.stringify(p);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  } catch (err) {
    if (opts.logError !== false) {
      log.executor.warn('params.stringify-error', { err: errorMessage(err) });
    }
    return '[unserializable params]';
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function readPathfinderIdle(bot) {
  try {
    return { ok: true, idle: bot.pathfinderOwner ? bot.pathfinderOwner.isIdle() : true };
  } catch (err) {
    return { ok: false, err: errorMessage(err) };
  }
}

function readPathfinderOwner(bot) {
  try {
    return { ok: true, owner: bot.pathfinderOwner?.currentOwner?.() ?? null };
  } catch (err) {
    return { ok: false, err: errorMessage(err) };
  }
}

function resumeGateIdleFailure(bot, idleRead, debounceMs, timeoutMs, paused, lastReleasedAt) {
  const ownerRead = readPathfinderOwner(bot);
  const details = {
    debounceMs,
    timeoutMs,
    paused,
    owner: ownerRead.ok ? ownerRead.owner : null,
    ownerError: ownerRead.ok ? undefined : ownerRead.err,
    lastReleasedAgeMs: Date.now() - lastReleasedAt,
    err: idleRead.err,
  };
  log.executor.warn('resume.idle-read-error', details);
  return {
    ok: false,
    reason: `resume gate failed reading pathfinder idle: ${idleRead.err}`,
    details,
  };
}

function withTimeout(promise, ms, msg, onTimeout = null, onLate = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const t = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      settled = true;
      if (onTimeout) {
        try {
          onTimeout();
        } catch (err) {
          log.executor.warn('skill.timeout-abort-error', { err: errorMessage(err) });
        }
      }
      reject(new Error(msg));
    }, ms);
    promise.then(
      (v) => {
        if (timedOut) {
          notifyLateTimeout(onLate, { kind: 'result', value: v });
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (timedOut) {
          notifyLateTimeout(onLate, { kind: 'error', error: e });
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function notifyLateTimeout(onLate, late) {
  if (!onLate) return;
  try {
    onLate(late);
  } catch (err) {
    log.executor.warn('skill.timeout-late-log-error', { err: errorMessage(err) });
  }
}

function logLateSkillTimeout(call, late) {
  if (late.kind === 'error') {
    log.executor.warn('skill.timeout-late-error', {
      skill: call.skill,
      err: errorMessage(late.error),
    });
    return;
  }

  const value = late.value;
  const fields = { skill: call.skill };
  if (value && typeof value === 'object') {
    fields.ok = !!value.ok;
    if ('preempted' in value) fields.preempted = !!value.preempted;
    if (typeof value.reason === 'string') fields.reason = value.reason;
  }
  log.executor.warn('skill.timeout-late-result', fields);
}

function abortSkillController(controller, reason) {
  if (!controller?.signal || controller.signal.aborted) return;
  controller.abort(reason);
}

function errorMessage(err) {
  return err?.message || String(err);
}

export default SkillExecutor;
