// Shared helpers for skills that drive bot.pathfinder via the owner.
// Every wait is signal-aware so reactive preempts unwind cleanly.

import pkgPathfinder from 'mineflayer-pathfinder';
import log from '../logger.js';
import { applyHazardMovementPolicy } from '../control/movement_safety.js';
import { blockModificationPolicy } from '../state/world_model.js';

const { Movements } = pkgPathfinder;

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
        if (typeof bot.humanizer?.collectBlock === 'function') {
          return bot.humanizer.collectBlock(bot, target, collectOptions, {
            reason: 'collectBlock.collect',
            signal,
            apply: () => bot.collectBlock.collect(target, collectOptions),
          });
        }
        return bot.collectBlock.collect(target, collectOptions);
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

  const grounded = await waitForFastDigGround(bot, signal, opts.fastDigGroundWaitMs ?? FAST_DIG_GROUND_WAIT_MS);
  if (grounded.preempted) {
    const err = new Error('collect fast dig preempted');
    err.name = 'PathStopped';
    throw err;
  }
  if (!grounded.ok) {
    log.executor.debug('collect.fast-dig.ground-skip', {
      block: liveBlock.name,
      pos: liveBlock.position,
      waitedMs: grounded.waitedMs,
      onGround: bot.entity?.onGround ?? null,
    });
    return false;
  }

  const settledBlock = currentMatchingBlock(bot, target);
  if (!settledBlock) return false;
  const expectedMs = typeof bot.digTime === 'function' ? bot.digTime(settledBlock) : null;
  log.executor.info('collect.fast-dig', {
    block: settledBlock.name,
    pos: settledBlock.position,
    heldItem: bot.heldItem?.name ?? null,
    expectedMs,
    onGround: bot.entity?.onGround ?? null,
    inWater: bot.entity?.isInWater ?? null,
  });
  const startedAtMs = Date.now();
  if (typeof bot.humanizer?.digBlock === 'function') {
    await bot.humanizer.digBlock(bot, settledBlock, {
      reason: 'collect.fast-dig',
      signal,
    });
  } else {
    await bot.dig(settledBlock);
  }
  const actualMs = Date.now() - startedAtMs;
  log.executor.info('collect.fast-dig.done', {
    block: settledBlock.name,
    pos: settledBlock.position,
    heldItem: bot.heldItem?.name ?? null,
    expectedMs,
    actualMs,
  });
  return { kind: 'completed', mode: 'fastDig', expectedMs, actualMs };
}

async function waitForFastDigGround(bot, signal, timeoutMs) {
  if (bot.entity?.onGround !== false) return { ok: true, waitedMs: 0 };
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < timeoutMs) {
    if (signal?.aborted) return { preempted: true, waitedMs: Date.now() - startedAtMs };
    if (bot.entity?.onGround !== false) return { ok: true, waitedMs: Date.now() - startedAtMs };
    await new Promise((resolve) => setTimeout(resolve, FAST_DIG_GROUND_POLL_MS));
  }
  return { ok: bot.entity?.onGround !== false, waitedMs: Date.now() - startedAtMs };
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
