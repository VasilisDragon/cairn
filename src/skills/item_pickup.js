import { Vec3 } from 'vec3';

const DEFAULT_MAX_MS = 1200;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_CLOSE_DISTANCE = 1.05;
const DEFAULT_SETTLE_MS = 0;

export async function nudgeTowardItemEntity(bot, target, ctx = {}, opts = {}) {
  const startedAtMs = Date.now();
  const maxMs = positiveNumber(opts.maxMs, DEFAULT_MAX_MS);
  const intervalMs = positiveNumber(opts.intervalMs, DEFAULT_INTERVAL_MS);
  const closeDistance = positiveNumber(opts.closeDistance, DEFAULT_CLOSE_DISTANCE);
  const settleMs = nonNegativeNumber(opts.settleMs, DEFAULT_SETTLE_MS);
  const reason = opts.reason || 'item-pickup.nudge';
  const useSneak = opts.useSneak === true;
  const getTarget = typeof target === 'function' ? target : () => target;
  const isComplete = typeof opts.isComplete === 'function' ? opts.isComplete : () => false;
  const unsafeState = typeof opts.unsafeState === 'function' ? opts.unsafeState : () => ({ unsafe: false });
  const seen = new Set();
  let lastEntityId = null;
  let lastDistance = null;

  try {
    while (Date.now() - startedAtMs < maxMs) {
      if (ctx.signal?.aborted) {
        return result(false, 'aborted during item pickup nudge', startedAtMs, seen, lastEntityId, lastDistance, { preempted: true });
      }
      if (isComplete()) {
        return result(true, 'pickup complete', startedAtMs, seen, lastEntityId, lastDistance, { complete: true });
      }
      const unsafe = unsafeState();
      if (unsafe?.unsafe === true) {
        return result(false, unsafe.reason || 'unsafe state during item pickup nudge', startedAtMs, seen, lastEntityId, lastDistance, { unsafe: true });
      }

      const entity = getTarget();
      if (!entity?.position) {
        return result(true, 'target item entity gone', startedAtMs, seen, lastEntityId, lastDistance, { targetGone: true });
      }

      lastEntityId = entity.id ?? null;
      if (lastEntityId !== null) seen.add(lastEntityId);
      lastDistance = bot.entity?.position ? distance(bot.entity.position, entity.position) : null;
      if (Number.isFinite(lastDistance) && lastDistance <= closeDistance) {
        setPickupControl(bot, 'forward', false, reason);
        setPickupControl(bot, 'sprint', false, reason);
        setPickupControl(bot, 'jump', false, reason);
      } else {
        await lookAtPickupTarget(bot, entity.position, ctx.signal, reason);
        if (useSneak) setPickupControl(bot, 'sneak', true, reason);
        setPickupControl(bot, 'sprint', false, reason);
        setPickupControl(bot, 'forward', true, reason);
        setPickupControl(bot, 'jump', shouldJumpTowardDrop(bot, entity), reason);
      }

      await sleep(intervalMs, ctx.signal);
    }

    if (isComplete()) {
      return result(true, 'pickup complete', startedAtMs, seen, lastEntityId, lastDistance, { complete: true });
    }
    const settled = await waitForCompletionSettle(isComplete, settleMs, intervalMs, ctx.signal);
    if (settled.preempted) {
      return result(false, 'aborted during item pickup settle', startedAtMs, seen, lastEntityId, lastDistance, { preempted: true });
    }
    if (settled.complete) {
      return result(true, 'pickup complete after settle', startedAtMs, seen, lastEntityId, lastDistance, { complete: true, settled: true });
    }
    return result(false, 'item entity still nearby after pickup nudge', startedAtMs, seen, lastEntityId, lastDistance);
  } finally {
    setPickupControl(bot, 'forward', false, reason);
    setPickupControl(bot, 'sprint', false, reason);
    setPickupControl(bot, 'jump', false, reason);
    if (useSneak) setPickupControl(bot, 'sneak', false, reason);
  }
}

export function itemEntityById(bot, id) {
  if (id == null) return null;
  const entity = bot?.entities?.[id];
  return isDroppedItemEntity(entity) ? entity : null;
}

export function isDroppedItemEntity(entity) {
  return entity?.name === 'item' || entity?.displayName === 'Item';
}

function result(ok, reason, startedAtMs, seen, lastEntityId, lastDistance, extra = {}) {
  return {
    ok,
    reason,
    elapsedMs: Date.now() - startedAtMs,
    seen: seen.size,
    visited: [...seen],
    lastEntityId,
    lastDistance,
    ...extra,
  };
}

async function lookAtPickupTarget(bot, position, signal, reason) {
  if (!position) return;
  const target = new Vec3(Number(position.x), Number(position.y) + 0.25, Number(position.z));
  if (typeof bot?.humanizer?.lookAt === 'function') {
    await bot.humanizer.lookAt(bot, target, {
      reason: `${reason}.look`,
      critical: true,
      signal,
      force: true,
    });
    return;
  }
  await bot?.lookAt?.(target, true);
}

function setPickupControl(bot, control, value, reason) {
  if (typeof bot?.humanizer?.setControlState === 'function') {
    return bot.humanizer.setControlState(bot, control, value, {
      reason: `${reason}.${control}`,
      critical: true,
    });
  }
  return bot?.setControlState?.(control, value);
}

function shouldJumpTowardDrop(bot, entity) {
  const botY = Number(bot?.entity?.position?.y);
  const entityY = Number(entity?.position?.y);
  return Number.isFinite(botY) && Number.isFinite(entityY) && entityY - botY > 0.6;
}

function distance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

async function waitForCompletionSettle(isComplete, settleMs, intervalMs, signal) {
  if (!(settleMs > 0)) return { complete: false };
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < settleMs) {
    if (signal?.aborted) return { preempted: true };
    if (isComplete()) return { complete: true };
    await sleep(Math.min(intervalMs, Math.max(1, settleMs - (Date.now() - startedAtMs))), signal);
  }
  if (signal?.aborted) return { preempted: true };
  return { complete: isComplete() === true };
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let abortHandler = null;
    const finish = () => {
      if (abortHandler) signal.removeEventListener?.('abort', abortHandler);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (typeof signal?.addEventListener === 'function') {
      abortHandler = () => {
        clearTimeout(timer);
        finish();
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}
