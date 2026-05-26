// Shared helpers for skills that drive bot.pathfinder via the owner.
// Every wait is signal-aware so reactive preempts unwind cleanly.

import pkgPathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import log from '../logger.js';
import { applyHazardMovementPolicy } from '../control/movement_safety.js';
import { blockModificationPolicy } from '../state/world_model.js';

const { Movements, goals: pathfinderGoals = {} } = pkgPathfinder;
const { GoalGetToBlock } = pathfinderGoals;

export { applyHazardMovementPolicy };

/**
 * Wait until bot emits 'goal_reached' for the currently-set goal.
 * Returns one of:
 *   { kind: 'reached' }
 *   { kind: 'preempted' }   — signal aborted
 *   { kind: 'noPath' }      — pathfinder gave up
 *   { kind: 'timeout' }     — exceeded timeoutMs
 *   { kind: 'waterStall' }  — no useful progress while in water
 *   { kind: 'stuck' }       — no useful progress while pathing on land
 *   { kind: 'signalError' } — abort listener wiring failed
 */
export function awaitGoalReached(bot, signal, timeoutMs = 60000, opts = {}) {
  return new Promise((resolve) => {
    const logger = opts.logger || log.executor;
    let done = false;
    let stopWaterWatchdog = null;
    let stopPathWatchdog = null;
    let timer = null;
    let abortListenerInstalled = false;
    let goalListenerInstalled = false;
    let pathListenerInstalled = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      if (stopWaterWatchdog) stopWaterWatchdog();
      if (stopPathWatchdog) stopPathWatchdog();
      if (goalListenerInstalled) removeBotListener(bot, 'goal_reached', onReach, logger, 'path.listener-remove-error');
      if (pathListenerInstalled) removeBotListener(bot, 'path_update', onPath, logger, 'path.listener-remove-error');
      if (abortListenerInstalled) {
        removeAbortListener(signal, onAbort, logger, 'path.abort-listener-remove-error');
      }
      if (timer) clearTimeout(timer);
      resolve(val);
    };
    const onReach = () => finish({ kind: 'reached' });
    const onPath = (r) => {
      if (r?.status === 'noPath') finish({ kind: 'noPath' });
      if (r?.status === 'timeout') finish({ kind: 'timeout' });
    };
    const onAbort = () => {
      const result = { kind: 'preempted' };
      const stopError = shouldStopPathOnAbort(signal, opts)
        ? stopOwnedPath(bot, opts.ownerToken, result.kind)
        : null;
      finish(withStopError(result, stopError));
    };

    if (signal?.aborted) {
      const result = { kind: 'preempted' };
      const stopError = shouldStopPathOnAbort(signal, opts)
        ? stopOwnedPath(bot, opts.ownerToken, result.kind)
        : null;
      resolve(withStopError(result, stopError));
      return;
    }
    const goalListenerError = addBotListener(bot, 'goal_reached', onReach);
    if (goalListenerError) {
      finish({ kind: 'eventError', err: goalListenerError });
      return;
    }
    goalListenerInstalled = true;
    const pathListenerError = addBotListener(bot, 'path_update', onPath);
    if (pathListenerError) {
      finish({ kind: 'eventError', err: pathListenerError });
      return;
    }
    pathListenerInstalled = true;
    try {
      signal?.addEventListener?.('abort', onAbort);
      abortListenerInstalled = typeof signal?.addEventListener === 'function';
    } catch (err) {
      finish({ kind: 'signalError', err: errorMessage(err) });
      return;
    }
    timer = setTimeout(() => {
      const result = { kind: 'timeout' };
      const stopError = stopOwnedPath(bot, opts.ownerToken, result.kind);
      finish(withStopError(result, stopError));
    }, timeoutMs);
    stopWaterWatchdog = startWaterProgressWatchdog(bot, (r) => {
      const stopError = stopOwnedPath(bot, opts.ownerToken, r.kind);
      finish(withStopError(r, stopError));
    }, opts);
    stopPathWatchdog = startPathProgressWatchdog(bot, (r) => {
      const stopError = stopOwnedPath(bot, opts.ownerToken, r.kind);
      finish(withStopError(r, stopError));
    }, opts);
  });
}

/**
 * Wait for a bot.collectBlock.collect() call to finish, observing the abort
 * signal. Returns:
 *   { kind: 'completed' }
 *   { kind: 'preempted' }   — signal aborted (or PathStopped, which the owner
 *                              raises by calling pathfinder.stop on preempt)
 *   { kind: 'error', err }  — any other error
 *
 * Cancellation strategy. The owner's preempt sequence is controller.abort() +
 * bot.pathfinder.stop(). That cleanly cancels the PATHING phase inside
 * collectBlock (PathStopped is swallowed by collectBlock's own try/catch).
 * It does NOT touch bot.dig(), which has its own waitTime timer and only
 * aborts when bot.stopDigging() is called. Without that, an in-flight dig
 * runs to completion (~3 s for an oak log bare-handed) before collectBlock's
 * loop reaches its next pathfinder.goto and notices the stopPathing flag.
 * That delay is what trapped the bot in our flee.
 *
 * On abort we therefore:
 *   1. Call bot.stopDigging() once immediately — cancels an active dig.
 *   2. Poll bot.stopDigging() every 50 ms for up to STOP_POLL_MAX_MS — closes
 *      the equipForBlock-then-dig corner where stopDigging is a no-op at
 *      abort time and the dig starts moments later. bot.stopDigging is a
 *      no-op while no dig is in progress, and re-installs as an active
 *      canceller on each new bot.dig() call, so polling naturally catches
 *      whichever dig starts within the window.
 *
 * Residual gap upper bound (oak_log scenario):
 *   - active dig at abort time: ~10 ms (immediate cancel)
 *   - abort during equipForBlock + then dig: equip latency (~100-300 ms) + 50 ms poll
 *   - abort during the 10-tick post-dig wait: ~500 ms wait, then next
 *     collectAll iteration's pathfinder.goto consumes stopPathing -> PathStopped
 * All sub-second. The polling cap is a safety net only.
 *
 * Documented residual: in the rare "collect an item entity" case inside
 * collectBlock, there's an await on `entityGone` for the dropped item. If
 * pickup somehow never happens, that wait can hang. Pre-existing, unrelated
 * to abort handling.
 */
const STOP_POLL_INTERVAL_MS = 50;
const STOP_POLL_MAX_MS = 2000;
const WATER_STALL_MS = 12000;
const WATER_PROGRESS_MIN_DIST_SQ = 0.25;
const WATER_WATCHDOG_INTERVAL_MS = 500;
const PATH_STALL_MS = 12000;
const PATH_PROGRESS_MIN_DIST_SQ = 0.25;
const FAST_DIG_PICKUP_RANGE = 2.25;
const FAST_DIG_GROUND_WAIT_MS = 700;
const FAST_DIG_GROUND_POLL_MS = 50;
const FAST_DIG_STABLE_GROUND_MS = 50;
const FAST_DIG_ACTIVE_DIG_CLEAR_MS = 700;
const FAST_DIG_ACTIVE_DIG_POLL_MS = 25;
const AIRBORNE_DIG_RETRIES = 2;
const AIRBORNE_DIG_POLL_MS = 25;
const AIRBORNE_DIG_SETTLE_MS = 500;
const STRAIGHT_DOWN_SCAN_DEPTH = 4;
const STRAIGHT_DOWN_MAX_SAFE_DROP = 3;
const AIR_LIKE_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const STRAIGHT_DOWN_HAZARD_BLOCKS = new Set([
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'magma_block',
]);
const WORLD_MODEL_MOVEMENT_POLICY = Symbol('worldModelMovementPolicy');

export function worldModelFromContext(ctx = {}) {
  if (ctx.worldModel) return { model: ctx.worldModel };
  if (!ctx.worldModelStore?.load) return { model: null };
  try {
    return { model: ctx.worldModelStore.load() };
  } catch (err) {
    return { error: err };
  }
}

export function applyWorldModelMovementPolicy(movements, ctx = {}, opts = {}) {
  const loaded = opts.worldModel ? { model: opts.worldModel } : worldModelFromContext(ctx);
  if (loaded.error) return { ok: false, error: loaded.error };
  const worldModel = loaded.model;
  if (!movements || !worldModel) return { ok: true, applied: false };

  const margin = opts.doNotTouchMargin ?? 0;
  const cost = opts.cost ?? 100;
  const exclusion = (block) => {
    if (!block?.position) return 0;
    const policy = blockModificationPolicy(worldModel, block.position, { margin });
    return policy.ok ? 0 : cost;
  };
  Object.defineProperty(exclusion, WORLD_MODEL_MOVEMENT_POLICY, { value: true });

  replaceMovementPolicy(movements.exclusionAreasStep, exclusion, WORLD_MODEL_MOVEMENT_POLICY);
  replaceMovementPolicy(movements.exclusionAreasBreak, exclusion, WORLD_MODEL_MOVEMENT_POLICY);
  replaceMovementPolicy(movements.exclusionAreasPlace, exclusion, WORLD_MODEL_MOVEMENT_POLICY);
  return { ok: true, applied: true };
}

export function configurePathingMovements(bot, ctx = {}, opts = {}) {
  const phase = opts.phase || 'pathing';
  const logger = opts.logger || log.executor;
  let movements = opts.movements || null;

  if (!movements) {
    try {
      movements = new Movements(bot);
    } catch (err) {
      logger?.warn?.(opts.event || `${phase}.movements-error`, { err: errorMessage(err) });
      return { ok: false, reason: `${phase} movement setup failed`, error: err };
    }
  }

  if (opts.allowParkour !== undefined) movements.allowParkour = opts.allowParkour;
  if (opts.allowSprinting !== undefined) movements.allowSprinting = opts.allowSprinting;

  applyHazardMovementPolicy(movements, bot, { logger });

  const policyOpts = {};
  if (Object.hasOwn(opts, 'worldModel')) policyOpts.worldModel = opts.worldModel;
  if (opts.doNotTouchMargin !== undefined) policyOpts.doNotTouchMargin = opts.doNotTouchMargin;
  if (opts.cost !== undefined) policyOpts.cost = opts.cost;
  const policy = applyWorldModelMovementPolicy(movements, ctx, policyOpts);
  if (!policy.ok) {
    return {
      ok: false,
      reason: `world-model movement policy unavailable during ${phase}`,
      error: policy.error,
      worldModelError: true,
    };
  }

  return { ok: true, movements };
}

function replaceMovementPolicy(areas, exclusion, marker) {
  if (!Array.isArray(areas)) return;
  for (let i = areas.length - 1; i >= 0; i--) {
    if (areas[i]?.[marker]) areas.splice(i, 1);
  }
  areas.push(exclusion);
}

export async function awaitCollectBlock(bot, target, signal, opts = {}) {
  if (signal?.aborted) {
    const result = { kind: 'preempted' };
    const stopError = shouldStopPathOnAbort(signal, opts)
      ? stopOwnedPath(bot, opts.ownerToken, result.kind)
      : null;
    return withStopError(result, stopError);
  }
  const logger = opts.logger || log.executor;
  let aborted = false;
  let abortStopError = null;
  let pollInterval = null;
  let pollTimeout = null;
  let stopWaterWatchdog = null;
  let stopPathWatchdog = null;
  let targetTimeout = null;
  let abortListenerInstalled = false;

  const onAbort = () => {
    aborted = true;
    abortStopError = shouldStopPathOnAbort(signal, opts)
      ? stopOwnedPath(bot, opts.ownerToken, 'preempted')
      : null;
    // Immediate cancel for the active-dig case.
    stopCollectDig(bot, 'abort');
    // Poll briefly to catch a dig that starts AFTER the abort fires (e.g.
    // mid-equipForBlock window). bot.stopDigging is noop when no dig is
    // active; the next bot.dig() installs a real canceller that our next
    // poll picks up.
    pollInterval = setInterval(() => {
      stopCollectDig(bot, 'abort-poll');
    }, STOP_POLL_INTERVAL_MS);
    pollTimeout = setTimeout(() => {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }, STOP_POLL_MAX_MS);
  };

  try {
    signal?.addEventListener?.('abort', onAbort, { once: true });
    abortListenerInstalled = typeof signal?.addEventListener === 'function';
  } catch (err) {
    return { kind: 'error', err };
  }
  try {
    const collectPromise = Promise.resolve()
      .then(async () => {
        const fastDig = await tryFastDigReachableBlock(bot, target, signal, opts);
        if (fastDig) {
          return fastDig;
        }
        const collectOptions = { ignoreNoPath: true };
        const applyCollect = () => collectBlockWithDefensiveDig(bot, target, collectOptions, signal, opts);
        if (typeof bot.humanizer?.collectBlock === 'function') {
          return bot.humanizer.collectBlock(bot, target, collectOptions, {
            reason: 'collectBlock.collect',
            signal,
            apply: applyCollect,
          });
        }
        return applyCollect();
      })
      .then((result) => (aborted ? collectAbortResult(abortStopError) : (result || { kind: 'completed' })))
      .catch((err) => (aborted || err?.name === 'PathStopped' ? collectAbortResult(abortStopError) : { kind: 'error', err }));
    const stallPromise = new Promise((resolve) => {
      stopWaterWatchdog = startWaterProgressWatchdog(bot, (r) => {
        const stopError = stopOwnedPath(bot, opts.ownerToken, r.kind);
        const digStopError = stopCollectDig(bot, r.kind);
        resolve(withDigStopError(withStopError(r, stopError), digStopError));
      });
      stopPathWatchdog = startPathProgressWatchdog(bot, (r) => {
        const stopError = stopOwnedPath(bot, opts.ownerToken, r.kind);
        const digStopError = stopCollectDig(bot, r.kind);
        resolve(withDigStopError(withStopError(r, stopError), digStopError));
      }, opts);
    });
    const racers = [collectPromise, stallPromise];
    if (Number.isFinite(opts.targetTimeoutMs) && opts.targetTimeoutMs > 0) {
      racers.push(new Promise((resolve) => {
        targetTimeout = setTimeout(() => {
          const result = { kind: 'targetTimeout', timeoutMs: opts.targetTimeoutMs };
          const stopError = stopOwnedPath(bot, opts.ownerToken, result.kind);
          const digStopError = stopCollectDig(bot, result.kind);
          resolve(withDigStopError(withStopError(result, stopError), digStopError));
        }, opts.targetTimeoutMs);
      }));
    }
    return await Promise.race(racers);
  } finally {
    if (stopWaterWatchdog) stopWaterWatchdog();
    if (stopPathWatchdog) stopPathWatchdog();
    if (targetTimeout) clearTimeout(targetTimeout);
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    if (abortListenerInstalled) {
      removeAbortListener(signal, onAbort, logger, 'collect.abort-listener-remove-error');
    }
  }
}

function collectAbortResult(stopError) {
  return withStopError({ kind: 'preempted' }, stopError);
}

function stopOwnedPath(bot, ownerToken, reason) {
  if (!ownerToken) return null;
  try {
    bot.pathfinderOwner?.stop?.(ownerToken);
    return null;
  } catch (err) {
    const message = err?.message || String(err);
    log.executor.warn('path.owner-stop-error', { reason, err: message });
    return message;
  }
}

function withStopError(result, stopError) {
  return stopError ? { ...result, stopError } : result;
}

function shouldStopPathOnAbort(signal, opts = {}) {
  if (opts.stopOnAbort === false) return false;
  return signal?.reason !== 'reactive-preempt';
}

function stopCollectDig(bot, reason) {
  if (typeof bot?.stopDigging !== 'function') return null;
  try {
    bot.stopDigging();
    return null;
  } catch (err) {
    const message = err?.message || String(err);
    log.executor.warn('collect.stop-digging-error', { reason, err: message });
    return message;
  }
}

function withDigStopError(result, digStopError) {
  return digStopError ? { ...result, digStopError } : result;
}

async function collectBlockWithDefensiveDig(bot, target, collectOptions, signal, opts = {}) {
  // humanizer: awaitCollectBlock routes this helper through collectBlock humanization when installed.
  if (opts.airborneAwareDig === false || !canUseDefensiveCollectPath(bot)) {
    return bot.collectBlock.collect(target, collectOptions);
  }

  const liveTarget = currentMatchingBlock(bot, target);
  if (!liveTarget) return bot.collectBlock.collect(target, collectOptions);

  const pathResult = await pathToCollectBlockTarget(bot, liveTarget, signal, opts);
  // humanizer fallback: harnesses without owner/goto support keep the collectBlock boundary.
  if (pathResult?.fallback) return bot.collectBlock.collect(target, collectOptions);
  if (pathResult && pathResult.kind !== 'reached') return pathResult;
  if (signal?.aborted) {
    const err = new Error('collect path-then-dig preempted');
    err.name = 'PathStopped';
    throw err;
  }

  const block = currentMatchingBlock(bot, liveTarget);
  if (!block) return { kind: 'completed', mode: 'collectBlockManual', vanished: true };
  // humanizer fallback: if manual guarded dig cannot own the break, defer to the collectBlock boundary.
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
    return bot.collectBlock.collect(target, collectOptions);
  }
  if (typeof bot.pathfinder?.movements?.safeToBreak === 'function' && !bot.pathfinder.movements.safeToBreak(block)) {
    return bot.collectBlock.collect(target, collectOptions);
  }

  const straightDownSafety = inspectStraightDownDigSafety(bot, block, opts);
  if (!straightDownSafety.ok) {
    log.executor.warn('collect.straight-down-refused', {
      block: block.name,
      pos: blockPositionRecord(block.position),
      code: straightDownSafety.code,
      reason: straightDownSafety.reason,
      scanned: straightDownSafety.scanned,
    });
    return {
      kind: 'unsafeStraightDownDig',
      code: 'unsafe_straight_down_dig',
      reason: straightDownSafety.reason,
      safety: straightDownSafety,
    };
  }

  if (typeof bot.tool?.equipForBlock === 'function') {
    await bot.tool.equipForBlock(block, {
      requireHarvest: true,
      getFromChest: false,
      maxTools: 2,
    });
  }

  log.executor.info('collect.defensive-dig', {
    block: block.name,
    pos: block.position,
    heldItem: bot.heldItem?.name ?? null,
    onGround: bot.entity?.onGround ?? null,
  });
  const startedAtMs = Date.now();
  const digResult = await airborneAwareDig(bot, block, signal, opts);
  if (digResult.kind !== 'completed') return digResult;
  const actualMs = Date.now() - startedAtMs;
  log.executor.info('collect.defensive-dig.done', {
    block: block.name,
    pos: block.position,
    heldItem: bot.heldItem?.name ?? null,
    expectedMs: digResult.expectedMs ?? null,
    actualMs,
    attempts: digResult.attempts,
  });
  return {
    kind: 'completed',
    mode: 'collectBlockManual',
    expectedMs: digResult.expectedMs ?? null,
    actualMs,
    attempts: digResult.attempts,
  };
}

function canUseDefensiveCollectPath(bot) {
  return typeof GoalGetToBlock === 'function' &&
    (
      hasOwnerPathingSurface(bot) ||
      typeof bot?.pathfinder?.goto === 'function'
    ) &&
    typeof bot?.dig === 'function';
}

async function pathToCollectBlockTarget(bot, target, signal, opts = {}) {
  const goal = new GoalGetToBlock(target.position.x, target.position.y, target.position.z);
  const movements = bot.collectBlock?.movements || null;
  if (hasOwnerPathingSurface(bot) && opts.ownerToken) {
    const set = bot.pathfinderOwner.setGoal(opts.ownerToken, goal, { movements });
    if (!set) {
      return {
        kind: 'error',
        err: new Error('pathfinder owner rejected collect defensive dig goal'),
      };
    }
    return awaitGoalReached(bot, signal, opts.collectPathTimeoutMs ?? 60000, opts);
  }
  if (typeof bot.pathfinder?.goto === 'function') {
    await bot.pathfinder.goto(goal);
    return { kind: 'reached' };
  }
  return { fallback: true };
}

function hasOwnerPathingSurface(bot) {
  return typeof bot?.pathfinderOwner?.setGoal === 'function' &&
    typeof bot?.pathfinderOwner?.currentOwner === 'function';
}

async function airborneAwareDig(bot, block, signal, opts = {}) {
  const maxRetries = positiveInteger(opts.airborneDigRetries, AIRBORNE_DIG_RETRIES);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const grounded = await waitForFastDigGround(bot, signal, opts.airborneDigGroundWaitMs ?? FAST_DIG_GROUND_WAIT_MS, {
      stableGroundMs: opts.airborneDigStableGroundMs ?? opts.fastDigStableGroundMs,
    });
    if (grounded.preempted) {
      const err = new Error('collect defensive dig preempted');
      err.name = 'PathStopped';
      throw err;
    }
    if (!grounded.ok) {
      log.executor.warn('collect.defensive-dig.ground-timeout', {
        block: block.name,
        pos: block.position,
        waitedMs: grounded.waitedMs,
        stableForMs: grounded.stableForMs ?? null,
        stableGroundMs: grounded.stableGroundMs ?? null,
        onGround: bot.entity?.onGround ?? null,
      });
      return {
        kind: 'groundWaitTimeout',
        reason: `bot did not become grounded before digging ${block.name}`,
        waitedMs: grounded.waitedMs,
        stableForMs: grounded.stableForMs ?? null,
        stableGroundMs: grounded.stableGroundMs ?? null,
        onGround: bot.entity?.onGround ?? null,
        position: clonePos(bot.entity?.position),
        target: blockSummary(block),
      };
    }

    const outcome = await runAirborneMonitoredDig(bot, block, signal, opts, attempt);
    if (outcome.kind === 'completed') return { ...outcome, attempts: attempt + 1 };
    if (outcome.kind === 'preempted') {
      const err = new Error('collect defensive dig preempted');
      err.name = 'PathStopped';
      throw err;
    }
    if (outcome.kind === 'error') throw outcome.err;
  }

  return {
    kind: 'airborneDigRetryExhausted',
    reason: `bot became airborne while digging ${block.name} after ${maxRetries + 1} attempts`,
    position: clonePos(bot.entity?.position),
    target: blockSummary(block),
    attempts: maxRetries + 1,
  };
}

async function runAirborneMonitoredDig(bot, block, signal, opts = {}, attempt = 0) {
  let done = false;
  let interval = null;
  let abortListenerInstalled = false;
  let abortListener = null;
  const pollMs = opts.airborneDigPollMs ?? AIRBORNE_DIG_POLL_MS;
  const expectedMs = typeof bot.digTime === 'function' ? bot.digTime(block) : null;
  // humanizer: this is the inner guarded action behind the collectBlock humanization wrapper.
  const digPromise = Promise.resolve()
    .then(() => bot.dig(block))
    .then(() => ({ kind: 'completed', expectedMs }))
    .catch((err) => ({ kind: 'error', err }));

  const monitorPromise = new Promise((resolve) => {
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    abortListener = () => finish({ kind: 'preempted' });
    try {
      signal?.addEventListener?.('abort', abortListener, { once: true });
      abortListenerInstalled = typeof signal?.addEventListener === 'function';
    } catch (err) {
      finish({ kind: 'error', err });
      return;
    }
    interval = setInterval(() => {
      if (signal?.aborted) {
        finish({ kind: 'preempted' });
      } else if (bot.entity?.onGround === false) {
        finish({ kind: 'airborne' });
      }
    }, pollMs);
  });

  const result = await Promise.race([digPromise, monitorPromise]);
  done = true;
  if (interval) clearInterval(interval);
  if (abortListenerInstalled) removeAbortListener(signal, abortListener, log.executor, 'collect.defensive-dig-abort-listener-remove-error');

  if (result.kind === 'airborne') {
    log.executor.warn('dig.airborne-detected', {
      block: block.name,
      pos: block.position,
      attempt,
      onGround: bot.entity?.onGround ?? null,
      botPosition: clonePos(bot.entity?.position),
    });
    stopCollectDig(bot, 'airborne-detected');
    await Promise.race([
      digPromise,
      sleepSignalAware(opts.airborneDigSettleMs ?? AIRBORNE_DIG_SETTLE_MS, signal),
    ]);
  }
  if (result.kind === 'preempted') stopCollectDig(bot, 'airborne-dig-preempted');
  return result;
}

async function tryFastDigReachableBlock(bot, target, signal, opts = {}) {
  if (opts.fastDig === false) return false;
  if (!target?.position || typeof bot?.dig !== 'function') return false;
  const liveBlock = currentMatchingBlock(bot, target);
  if (!liveBlock) return false;
  if (!isLikelyPickupReach(bot, liveBlock, opts.fastDigPickupRange ?? FAST_DIG_PICKUP_RANGE)) return false;
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(liveBlock)) return false;
  if (typeof bot.pathfinder?.movements?.safeToBreak === 'function' && !bot.pathfinder.movements.safeToBreak(liveBlock)) {
    return false;
  }
  const straightDownSafety = inspectStraightDownDigSafety(bot, liveBlock, opts);
  if (!straightDownSafety.ok) {
    log.executor.warn('collect.straight-down-refused', {
      block: liveBlock.name,
      pos: blockPositionRecord(liveBlock.position),
      code: straightDownSafety.code,
      reason: straightDownSafety.reason,
      scanned: straightDownSafety.scanned,
    });
    return {
      kind: 'unsafeStraightDownDig',
      code: 'unsafe_straight_down_dig',
      reason: straightDownSafety.reason,
      safety: straightDownSafety,
    };
  }

  const activeDigBeforeEquip = await clearActiveDigBeforeFastDig(bot, liveBlock, signal, opts, 'before-equip');
  if (activeDigBeforeEquip.preempted) {
    const err = new Error('collect fast dig preempted');
    err.name = 'PathStopped';
    throw err;
  }
  if (!activeDigBeforeEquip.ok) {
    log.executor.debug('collect.fast-dig.active-dig-skip', {
      block: liveBlock.name,
      pos: liveBlock.position,
      phase: activeDigBeforeEquip.phase,
      reason: activeDigBeforeEquip.reason,
      active: activeDigBeforeEquip.active,
      target: activeDigBeforeEquip.target,
      waitedMs: activeDigBeforeEquip.waitedMs ?? null,
      error: activeDigBeforeEquip.error ?? null,
    });
    return false;
  }

  if (typeof bot.tool?.equipForBlock === 'function') {
    try {
      await bot.tool.equipForBlock(liveBlock, {
        requireHarvest: true,
        getFromChest: false,
        maxTools: 2,
      });
    } catch (err) {
      log.executor.debug('collect.fast-dig.equip-skip', {
        block: liveBlock.name,
        pos: liveBlock.position,
        err: errorMessage(err),
      });
      return false;
    }
  }
  if (signal?.aborted) {
    const err = new Error('collect fast dig preempted');
    err.name = 'PathStopped';
    throw err;
  }
  if (bot.heldItem && typeof liveBlock.canHarvest === 'function' && !liveBlock.canHarvest(bot.heldItem.type)) {
    return false;
  }

  const grounded = await waitForFastDigGround(bot, signal, opts.fastDigGroundWaitMs ?? FAST_DIG_GROUND_WAIT_MS, {
    stableGroundMs: opts.fastDigStableGroundMs,
  });
  if (grounded.preempted) {
    const err = new Error('collect fast dig preempted');
    err.name = 'PathStopped';
    throw err;
  }
  if (!grounded.ok) {
    log.executor.warn('collect.fast-dig.ground-timeout', {
      block: liveBlock.name,
      pos: liveBlock.position,
      waitedMs: grounded.waitedMs,
      stableForMs: grounded.stableForMs ?? null,
      stableGroundMs: grounded.stableGroundMs ?? null,
      onGround: bot.entity?.onGround ?? null,
    });
    return {
      kind: 'groundWaitTimeout',
      reason: `bot did not become grounded before fast-digging ${liveBlock.name}`,
      waitedMs: grounded.waitedMs,
      stableForMs: grounded.stableForMs ?? null,
      stableGroundMs: grounded.stableGroundMs ?? null,
      onGround: bot.entity?.onGround ?? null,
      position: clonePos(bot.entity?.position),
      target: blockSummary(liveBlock),
    };
  }

  const settledBlock = currentMatchingBlock(bot, target);
  if (!settledBlock) return false;
  const activeDigBeforeDig = await clearActiveDigBeforeFastDig(bot, settledBlock, signal, opts, 'before-dig');
  if (activeDigBeforeDig.preempted) {
    const err = new Error('collect fast dig preempted');
    err.name = 'PathStopped';
    throw err;
  }
  if (!activeDigBeforeDig.ok) {
    log.executor.debug('collect.fast-dig.active-dig-skip', {
      block: settledBlock.name,
      pos: settledBlock.position,
      phase: activeDigBeforeDig.phase,
      reason: activeDigBeforeDig.reason,
      active: activeDigBeforeDig.active,
      target: activeDigBeforeDig.target,
      waitedMs: activeDigBeforeDig.waitedMs ?? null,
      error: activeDigBeforeDig.error ?? null,
    });
    return false;
  }
  const activeDigCleared = activeDigBeforeEquip.cleared === true || activeDigBeforeDig.cleared === true;
  if (activeDigCleared) {
    log.executor.info('collect.fast-dig.active-dig-cleared', {
      block: settledBlock.name,
      pos: settledBlock.position,
      beforeEquip: activeDigBeforeEquip.cleared === true,
      beforeDig: activeDigBeforeDig.cleared === true,
      waitedMs: (activeDigBeforeEquip.waitedMs || 0) + (activeDigBeforeDig.waitedMs || 0),
    });
  }
  log.executor.info('collect.fast-dig', {
    block: settledBlock.name,
    pos: settledBlock.position,
    heldItem: bot.heldItem?.name ?? null,
    onGround: bot.entity?.onGround ?? null,
    inWater: bot.entity?.isInWater ?? null,
    activeDigCleared,
  });
  const startedAtMs = Date.now();
  const digResult = await airborneAwareDig(bot, settledBlock, signal, opts);
  if (digResult.kind !== 'completed') return digResult;
  const actualMs = Date.now() - startedAtMs;
  log.executor.info('collect.fast-dig.done', {
    block: settledBlock.name,
    pos: settledBlock.position,
    heldItem: bot.heldItem?.name ?? null,
    expectedMs: digResult.expectedMs ?? null,
    actualMs,
    attempts: digResult.attempts,
  });
  return {
    kind: 'completed',
    mode: 'fastDig',
    expectedMs: digResult.expectedMs ?? null,
    actualMs,
    attempts: digResult.attempts,
  };
}

async function clearActiveDigBeforeFastDig(bot, target, signal, opts = {}, phase = 'before-dig') {
  const active = bot?.targetDigBlock;
  if (!active) return { ok: true, cleared: false, phase };
  const activeSummary = blockSummary(active);
  const targetSummary = blockSummary(target);
  if (typeof bot?.stopDigging !== 'function') {
    return {
      ok: false,
      reason: 'active-dig-without-stopDigging',
      phase,
      active: activeSummary,
      target: targetSummary,
    };
  }

  const startedAtMs = Date.now();
  try {
    bot.stopDigging();
  } catch (err) {
    return {
      ok: false,
      reason: 'stopDigging-failed',
      phase,
      active: activeSummary,
      target: targetSummary,
      error: errorMessage(err),
    };
  }

  const timeoutMs = opts.fastDigActiveDigClearMs ?? FAST_DIG_ACTIVE_DIG_CLEAR_MS;
  const pollMs = opts.fastDigActiveDigPollMs ?? FAST_DIG_ACTIVE_DIG_POLL_MS;
  while (Date.now() - startedAtMs <= timeoutMs) {
    if (signal?.aborted) {
      return {
        preempted: true,
        reason: 'preempted while clearing active dig',
        phase,
        active: activeSummary,
        target: targetSummary,
        waitedMs: Date.now() - startedAtMs,
      };
    }
    if (!bot.targetDigBlock) {
      return {
        ok: true,
        cleared: true,
        phase,
        active: activeSummary,
        target: targetSummary,
        waitedMs: Date.now() - startedAtMs,
      };
    }
    await sleepSignalAware(pollMs, signal);
  }

  return {
    ok: false,
    reason: 'active-dig-clear-timeout',
    phase,
    active: activeSummary,
    target: targetSummary,
    waitedMs: Date.now() - startedAtMs,
  };
}

function blockSummary(block) {
  if (!block) return null;
  return {
    name: block.name ?? null,
    pos: clonePos(block.position),
  };
}

async function waitForFastDigGround(bot, signal, timeoutMs, opts = {}) {
  const stableGroundMs = Math.max(0, Number.isFinite(Number(opts.stableGroundMs))
    ? Number(opts.stableGroundMs)
    : FAST_DIG_STABLE_GROUND_MS);
  const startedAtMs = Date.now();
  let stableSinceMs = null;
  while (Date.now() - startedAtMs < timeoutMs) {
    if (signal?.aborted) return { preempted: true, waitedMs: Date.now() - startedAtMs };
    if (isDigGroundStable(bot)) {
      if (stableSinceMs === null) stableSinceMs = Date.now();
      const stableForMs = Date.now() - stableSinceMs;
      if (stableForMs >= stableGroundMs) {
        return {
          ok: true,
          waitedMs: Date.now() - startedAtMs,
          stableForMs,
          stableGroundMs,
        };
      }
    } else {
      stableSinceMs = null;
    }
    await new Promise((resolve) => setTimeout(resolve, FAST_DIG_GROUND_POLL_MS));
  }
  const stableForMs = stableSinceMs === null ? 0 : Date.now() - stableSinceMs;
  return {
    ok: isDigGroundStable(bot) && stableForMs >= stableGroundMs,
    waitedMs: Date.now() - startedAtMs,
    stableForMs,
    stableGroundMs,
  };
}

function isDigGroundStable(bot) {
  if (bot.entity?.onGround !== true) return false;
  if (bot.entity?.isInWater === true) return false;
  if (bot.controlState?.jump === true) return false;
  return true;
}

export function inspectStraightDownDigSafety(bot, block, opts = {}) {
  const botPos = bot.entity?.position;
  const blockPos = blockPositionRecord(block?.position);
  if (!botPos || !blockPos) return { ok: true, checked: false, reason: 'missing bot or block position' };

  const support = supportUnderPosition(botPos);
  if (!sameBlockPosition(blockPos, support)) {
    return { ok: true, checked: false, reason: 'target is not directly below bot' };
  }

  if (opts.allowStraightDownDig !== true) {
    return {
      ok: false,
      code: 'straight_down_without_shaft_policy',
      reason: 'straight-down dig refused — use shaft mining policy for vertical excavation',
      position: blockPos,
      scanned: [],
    };
  }

  const scanDepth = positiveInteger(opts.straightDownScanDepth, STRAIGHT_DOWN_SCAN_DEPTH);
  const maxSafeDrop = positiveInteger(opts.straightDownMaxSafeDrop, STRAIGHT_DOWN_MAX_SAFE_DROP);
  const scanned = [];
  let openDepth = 0;

  for (let depth = 1; depth <= scanDepth; depth++) {
    const position = new Vec3(blockPos.x, blockPos.y - depth, blockPos.z);
    let below = null;
    try {
      below = typeof bot.blockAt === 'function' ? bot.blockAt(position) : null;
    } catch (err) {
      return {
        ok: false,
        code: 'world_query_failed',
        reason: `straight-down safety query failed at ${formatBlockPos(position)}: ${errorMessage(err)}`,
        position: blockPos,
        scanned,
      };
    }

    const name = normalizeBlockName(below?.name);
    scanned.push({ position, name: name || null });
    if (!below || name === 'void_air') {
      return {
        ok: false,
        code: 'void_below',
        reason: `unsafe straight-down dig: void or unknown block below target at ${formatBlockPos(position)}`,
        position: blockPos,
        scanned,
      };
    }
    if (STRAIGHT_DOWN_HAZARD_BLOCKS.has(name)) {
      return {
        ok: false,
        code: 'hazard_below',
        reason: `unsafe straight-down dig: ${name} below target at ${formatBlockPos(position)}`,
        position: blockPos,
        scanned,
      };
    }
    if (isOpenDropBlock(below)) {
      openDepth += 1;
      if (openDepth > maxSafeDrop) {
        return {
          ok: false,
          code: 'large_drop_below',
          reason: `unsafe straight-down dig: open drop deeper than ${maxSafeDrop} blocks below target`,
          position: blockPos,
          scanned,
        };
      }
      continue;
    }
    return { ok: true, checked: true, position: blockPos, scanned, openDepth };
  }

  return { ok: true, checked: true, position: blockPos, scanned, openDepth };
}

function currentMatchingBlock(bot, target) {
  try {
    const liveBlock = typeof bot.blockAt === 'function' ? bot.blockAt(target.position) : target;
    if (!liveBlock) return null;
    if (target.type !== undefined && liveBlock.type !== target.type) return null;
    if (target.name !== undefined && liveBlock.name !== target.name) return null;
    return liveBlock;
  } catch {
    return null;
  }
}

function isLikelyPickupReach(bot, block, maxRange) {
  const botPos = bot.entity?.position;
  const blockPos = block?.position;
  if (!botPos || !blockPos) return false;
  const center = {
    x: blockPos.x + 0.5,
    y: blockPos.y + 0.5,
    z: blockPos.z + 0.5,
  };
  return distanceSquared(botPos, center) <= maxRange * maxRange;
}

export function createWaterProgressWatchdog(bot, opts = {}) {
  const now = opts.now || Date.now;
  const stallMs = opts.stallMs ?? WATER_STALL_MS;
  const minDistSq = opts.minDistSq ?? WATER_PROGRESS_MIN_DIST_SQ;
  let lastProgressAt = now();
  let lastPos = clonePos(bot.entity?.position);
  let lastOxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null;

  return {
    sample() {
      const pos = bot.entity?.position;
      const inWater = bot.entity?.isInWater === true;
      const oxygenLevel = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null;
      const moved = pos && lastPos ? distanceSquared(pos, lastPos) >= minDistSq : false;
      const oxygenImproved = oxygenLevel != null && lastOxygen != null && oxygenLevel > lastOxygen;
      const madeProgress = !inWater || moved || oxygenImproved;

      if (madeProgress) {
        lastProgressAt = now();
        lastPos = clonePos(pos);
        lastOxygen = oxygenLevel;
        return null;
      }

      const stuckMs = now() - lastProgressAt;
      if (inWater && stuckMs >= stallMs) {
        return {
          kind: 'waterStall',
          stuckMs,
          oxygenLevel,
          position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
        };
      }
      return null;
    },
  };
}

export function createPathProgressWatchdog(bot, opts = {}) {
  const now = opts.now || Date.now;
  const stallMs = opts.stallMs ?? PATH_STALL_MS;
  const minDistSq = opts.minDistSq ?? PATH_PROGRESS_MIN_DIST_SQ;
  let lastProgressAt = now();
  let lastPos = clonePos(bot.entity?.position);

  return {
    sample() {
      const pos = bot.entity?.position;
      const inWater = bot.entity?.isInWater === true;
      if (!pos || inWater) {
        lastProgressAt = now();
        lastPos = clonePos(pos);
        return null;
      }

      const moved = lastPos ? distanceSquared(pos, lastPos) >= minDistSq : true;
      if (moved) {
        lastProgressAt = now();
        lastPos = clonePos(pos);
        return null;
      }

      const stuckMs = now() - lastProgressAt;
      if (stuckMs >= stallMs) {
        return {
          kind: 'stuck',
          stuckMs,
          position: { x: pos.x, y: pos.y, z: pos.z },
          ...readPathfinderContext(bot),
        };
      }
      return null;
    },
  };
}

export function pathingFailureReason(result) {
  if (!result) return 'unknown pathing failure';
  if (result.kind === 'waterStall') {
    return `waterStall (${result.stuckMs}ms, oxygen=${result.oxygenLevel ?? 'unknown'})`;
  }
  if (result.kind === 'stuck') {
    return `stuck (${result.stuckMs}ms at ${formatPos(result.position)})`;
  }
  if (result.kind === 'targetTimeout') {
    return `targetTimeout (${result.timeoutMs}ms)`;
  }
  if (result.kind === 'groundWaitTimeout') {
    return `groundWaitTimeout (${result.waitedMs}ms, onGround=${result.onGround ?? 'unknown'})`;
  }
  if (result.kind === 'unsafeStraightDownDig') {
    return result.reason || 'unsafe straight-down dig';
  }
  if (result.kind === 'airborneDigRetryExhausted') {
    return result.reason || `airborneDigRetryExhausted (${result.attempts ?? 'unknown'} attempts)`;
  }
  if (result.kind === 'signalError') {
    return `signalError (${result.err || 'unknown'})`;
  }
  if (result.kind === 'eventError') {
    return `eventError (${result.err || 'unknown'})`;
  }
  return result.kind;
}

function startWaterProgressWatchdog(bot, onStall, opts = {}) {
  const watchdog = createWaterProgressWatchdog(bot, {
    stallMs: opts.waterStallMs,
    minDistSq: opts.waterProgressMinDistSq,
  });
  const intervalMs = opts.watchdogIntervalMs ?? WATER_WATCHDOG_INTERVAL_MS;
  const timer = setInterval(() => {
    const result = watchdog.sample();
    if (result) onStall(result);
  }, intervalMs);
  return () => clearInterval(timer);
}

function startPathProgressWatchdog(bot, onStall, opts = {}) {
  if (opts.enablePathWatchdog === false) return null;
  const watchdog = createPathProgressWatchdog(bot, {
    stallMs: opts.pathStallMs,
    minDistSq: opts.pathProgressMinDistSq,
  });
  const intervalMs = opts.watchdogIntervalMs ?? WATER_WATCHDOG_INTERVAL_MS;
  const timer = setInterval(() => {
    const result = watchdog.sample();
    if (result) {
      log.executor.warn('path.stuck', result);
      onStall(result);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

function clonePos(p) {
  if (!p) return null;
  return { x: p.x, y: p.y, z: p.z };
}

function blockPositionRecord(p) {
  if (!p) return null;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function supportUnderPosition(position) {
  if (!position) return null;
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y - 0.01),
    z: Math.floor(position.z),
  };
}

function sameBlockPosition(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function posKey(p) {
  return `${p.x},${p.y},${p.z}`;
}

function formatPos(position) {
  if (!position) return 'unknown';
  return `${Math.round(position.x * 10) / 10},${Math.round(position.y * 10) / 10},${Math.round(position.z * 10) / 10}`;
}

function formatBlockPos(position) {
  if (!position) return 'unknown';
  return `${position.x},${position.y},${position.z}`;
}

function normalizeBlockName(name) {
  return typeof name === 'string' ? name.replace(/^minecraft:/, '') : '';
}

function isOpenDropBlock(block) {
  const name = normalizeBlockName(block?.name);
  if (name === 'water' || name === 'flowing_water') return false;
  return AIR_LIKE_BLOCKS.has(name) || block?.boundingBox === 'empty';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function errorMessage(err) {
  return err?.message || String(err);
}

function readPathfinderContext(bot) {
  const context = {
    owner: null,
    pathfinderIdle: null,
  };
  try {
    context.owner = bot.pathfinderOwner?.currentOwner?.() ?? null;
  } catch (err) {
    context.ownerError = errorMessage(err);
  }
  try {
    context.pathfinderIdle = bot.pathfinderOwner?.isIdle?.() ?? null;
  } catch (err) {
    context.pathfinderIdleError = errorMessage(err);
  }
  return context;
}

function addBotListener(bot, eventName, listener) {
  try {
    bot.on(eventName, listener);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

function removeBotListener(bot, eventName, listener, logger, evt) {
  try {
    bot.removeListener(eventName, listener);
  } catch (err) {
    logger?.warn?.(evt, { event: eventName, err: errorMessage(err) });
  }
}

function removeAbortListener(signal, listener, logger, evt) {
  try {
    signal?.removeEventListener?.('abort', listener);
  } catch (err) {
    logger?.warn?.(evt, { err: errorMessage(err) });
  }
}

function sleepSignalAware(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let abortHandler = null;
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      if (abortHandler) signal.removeEventListener?.('abort', abortHandler);
      resolve();
    }
    if (typeof signal?.addEventListener === 'function') {
      abortHandler = finish;
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}
