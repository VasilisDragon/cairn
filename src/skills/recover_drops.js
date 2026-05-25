import { Vec3 } from 'vec3';
import buildSnapshot from '../state/snapshot.js';
import { readBotInventoryCounts } from '../state/materials.js';
import { run as runGoto } from './goto.js';

const DEFAULT_RANGE = 0.4;
const DEFAULT_WAIT_MS = 6000;
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_VISIBLE_ITEM_INITIAL_WAIT_MS = 500;
const DEFAULT_VISIBLE_ITEM_INITIAL_SETTLE_MS = 250;
const DEFAULT_ITEM_SWEEP_RADIUS = 12;
const DEFAULT_ITEM_SWEEP_TARGETS = 24;
const DEFAULT_ITEM_SWEEP_RANGE = 0.6;
const DEFAULT_ITEM_SWEEP_WAIT_MS = 1200;
const DEFAULT_ITEM_SWEEP_SETTLE_MS = 300;
const DEFAULT_LOCAL_SWEEP_MS = 3500;
const DEFAULT_LOCAL_SWEEP_INTERVAL_MS = 75;
const DEFAULT_LOCAL_SWEEP_CLOSE_DISTANCE = 0.85;
const DEFAULT_LOCAL_SWEEP_STALE_TARGET_MS = 650;
const DEFAULT_LOCAL_SWEEP_DISTANCE_EPSILON = 0.15;
const PICKUP_POLL_MS = 250;

export async function run(bot, params = {}, ctx = {}) {
  const dimension = params.dimension || null;
  const currentDimension = bot?.game?.dimension || null;
  if (dimension && !currentDimension) {
    return {
      ok: false,
      reason: `drop recovery dimension ${dimension} cannot be verified because current dimension is unavailable`,
      state: buildSnapshot(bot, ctx),
    };
  }
  if (dimension && currentDimension && dimension !== currentDimension) {
    return {
      ok: false,
      reason: `drop recovery dimension ${dimension} differs from current dimension ${currentDimension}`,
      state: buildSnapshot(bot, ctx),
    };
  }

  const before = readBotInventoryCounts(bot);
  if (!before.ok) {
    return {
      ok: false,
      reason: `inventory unavailable before drop recovery: ${before.error}`,
      state: buildSnapshot(bot, ctx),
    };
  }

  const travel = await runGoto(bot, {
    x: params.x,
    y: params.y,
    z: params.z,
    range: normalizeNonNegative(params.range, DEFAULT_RANGE),
  }, { ...ctx, currentSubtask: 'recover_drops.travel' });
  if (travel.preempted) {
    return abandonAfterPreempt('travel', travel.state || buildSnapshot(bot, ctx));
  }
  if (!travel.ok) {
    return {
      ok: false,
      reason: `drop recovery travel failed: ${travel.reason}`,
      state: travel.state || buildSnapshot(bot, ctx),
    };
  }

  const waitMs = normalizeNonNegative(params.waitMs, DEFAULT_WAIT_MS);
  const settleMs = normalizeNonNegative(params.settleMs, DEFAULT_SETTLE_MS);
  const origin = positionFromParams(params);
  const visibleAtArrival = nearbyItemEntities(bot, origin, DEFAULT_ITEM_SWEEP_RADIUS).length > 0;
  let pickup = await waitForPickupDelta(
    bot,
    before.inventory,
    visibleAtArrival ? Math.min(waitMs, DEFAULT_VISIBLE_ITEM_INITIAL_WAIT_MS) : waitMs,
    visibleAtArrival ? Math.min(settleMs, DEFAULT_VISIBLE_ITEM_INITIAL_SETTLE_MS) : settleMs,
    ctx.signal,
  );
  if (!pickup.preempted && !pickup.error) {
    const sweep = await sweepVisibleItemEntities(bot, params, before.inventory, ctx, {
      radius: DEFAULT_ITEM_SWEEP_RADIUS,
      targets: DEFAULT_ITEM_SWEEP_TARGETS,
      range: DEFAULT_ITEM_SWEEP_RANGE,
      waitMs: Math.min(Math.max(waitMs, 500), DEFAULT_ITEM_SWEEP_WAIT_MS),
      settleMs: Math.min(settleMs, DEFAULT_ITEM_SWEEP_SETTLE_MS),
    });
    if (sweep.preempted || sweep.error || sweep.ok || !pickup.ok || (sweep.nearbyItems?.length || 0) > 0) {
      pickup = sweep;
    } else {
      pickup.itemSweep = sweep.itemSweep;
      pickup.nearbyItems = sweep.nearbyItems;
      pickup.inventory = sweep.inventory || pickup.inventory;
      pickup.delta = positiveDelta(before.inventory, pickup.inventory);
    }
  }
  if (pickup.preempted) {
    return abandonAfterPreempt('pickup wait', buildSnapshot(bot, ctx));
  }
  if (!pickup.ok && pickup.error) {
    return {
      ok: false,
      reason: `inventory unavailable during drop recovery: ${pickup.error}`,
      state: buildSnapshot(bot, ctx),
    };
  }
  if (!pickup.ok) {
    if (Object.keys(pickup.delta || {}).length > 0) {
      return {
        ok: false,
        reason: 'partial drop recovery left visible dropped items nearby',
        recoveredItems: pickup.delta,
        inventoryBefore: before.inventory,
        inventoryAfter: pickup.inventory,
        nearbyItems: pickup.nearbyItems || [],
        itemSweep: pickup.itemSweep || null,
        state: buildSnapshot(bot, ctx),
      };
    }
    return {
      ok: false,
      reason: 'no dropped items picked up at recovery location',
      recoveredItems: {},
      inventoryBefore: before.inventory,
      inventoryAfter: pickup.inventory,
      nearbyItems: pickup.nearbyItems || [],
      itemSweep: pickup.itemSweep || null,
      state: buildSnapshot(bot, ctx),
    };
  }

  return {
    ok: true,
    reason: 'recovered dropped items',
    recoveredItems: pickup.delta,
    inventoryBefore: before.inventory,
    inventoryAfter: pickup.inventory,
    nearbyItems: pickup.nearbyItems || [],
    itemSweep: pickup.itemSweep || null,
    state: buildSnapshot(bot, ctx),
  };
}

async function sweepVisibleItemEntities(bot, params, before, ctx, opts) {
  const origin = positionFromParams(params);
  if (!origin) return currentPickupFailure(bot, { itemSweep: { reason: 'missing recovery origin' } });
  const visited = [];
  const navFailures = [];
  let baseline = currentInventory(bot);
  let inventory = baseline;

  const local = await localSweepVisibleItemEntities(bot, origin, before, ctx, {
    radius: opts.radius,
    maxMs: DEFAULT_LOCAL_SWEEP_MS,
    intervalMs: DEFAULT_LOCAL_SWEEP_INTERVAL_MS,
    closeDistance: DEFAULT_LOCAL_SWEEP_CLOSE_DISTANCE,
  });
  if (local.preempted) {
    return {
      ...abandonAfterPreempt('local item sweep', buildSnapshot(bot, ctx)),
      itemSweep: { local, visited, navFailures },
    };
  }
  if (local.error) return { ...local, itemSweep: { local, visited, navFailures } };
  if (local.inventory) {
    baseline = local.inventory;
    inventory = local.inventory;
  }
  if (local.ok) {
    return {
      ok: Object.keys(local.delta || {}).length > 0,
      delta: local.delta || {},
      inventory,
      nearbyItems: local.nearbyItems || [],
      itemSweep: {
        local,
        visited,
        navFailures,
        remainingItems: local.nearbyItems?.length || 0,
      },
    };
  }

  for (let i = 0; i < opts.targets; i += 1) {
    const candidates = nearbyItemEntities(bot, origin, opts.radius)
      .filter((entity) => !visited.includes(entity.id));
    if (candidates.length === 0) break;

    const target = candidates[0];
    visited.push(target.id);
    const nav = await runGoto(bot, {
      x: target.position.x,
      y: target.position.y,
      z: target.position.z,
      range: opts.range,
    }, { ...ctx, currentSubtask: 'recover_drops.item-sweep' });
    if (nav.preempted) {
      return {
        ...abandonAfterPreempt('item sweep', buildSnapshot(bot, ctx)),
        itemSweep: { visited, navFailures },
      };
    }
    if (!nav.ok) {
      navFailures.push({ id: target.id, reason: nav.reason, position: target.position });
      continue;
    }

    const gonePickup = pickupIfTargetGone(bot, target, baseline);
    const pickup = gonePickup || await waitForPickupDelta(bot, baseline, opts.waitMs, opts.settleMs, ctx.signal);
    if (pickup.preempted) {
      return {
        ...abandonAfterPreempt('item sweep pickup wait', buildSnapshot(bot, ctx)),
        itemSweep: { visited, navFailures },
      };
    }
    if (pickup.error) return { ...pickup, itemSweep: { visited, navFailures } };
    if (pickup.ok) {
      baseline = pickup.inventory;
      inventory = pickup.inventory;
    } else {
      inventory = pickup.inventory || currentInventory(bot);
    }
  }

  const nearbyItems = nearbyItemEntities(bot, origin, opts.radius);
  const delta = positiveDelta(before, inventory);
  return {
    ok: Object.keys(delta).length > 0 && nearbyItems.length === 0,
    delta,
    inventory,
    nearbyItems,
    itemSweep: { local, visited, navFailures, remainingItems: nearbyItems.length },
  };
}

async function localSweepVisibleItemEntities(bot, origin, before, ctx, opts) {
  if (!hasPickupControls(bot)) {
    return {
      ok: false,
      attempted: false,
      reason: 'no movement controls available for local sweep',
      delta: positiveDelta(before, currentInventory(bot)),
      inventory: currentInventory(bot),
      nearbyItems: nearbyItemEntities(bot, origin, opts.radius),
      visited: [],
      elapsedMs: 0,
    };
  }

  const startedAtMs = Date.now();
  const visitedSet = new Set();
  const ignoredSet = new Set();
  let seen = 0;
  let lastEntityId = null;
  let lastDistance = null;
  let inventory = currentInventory(bot);
  let activeTargetId = null;
  let activeTargetSince = 0;
  let activeTargetBestDistance = null;
  let lastDeltaKey = countsKey(positiveDelta(before, inventory));

  try {
    while (Date.now() - startedAtMs < opts.maxMs) {
      if (ctx.signal?.aborted) return { preempted: true, attempted: true };

      const candidates = nearbyItemEntities(bot, origin, opts.radius)
        .filter((entity) => !ignoredSet.has(entity.id));
      if (candidates.length === 0) {
        inventory = currentInventory(bot);
        const nearbyItems = nearbyItemEntities(bot, origin, opts.radius);
        return {
          ok: nearbyItems.length === 0,
          attempted: true,
          reason: nearbyItems.length === 0
            ? 'no visible dropped item entities remain after local sweep'
            : 'local sweep skipped stuck visible item entities',
          delta: positiveDelta(before, inventory),
          inventory,
          nearbyItems,
          visited: [...visitedSet],
          ignored: [...ignoredSet],
          seen,
          elapsedMs: Date.now() - startedAtMs,
          lastEntityId,
          lastDistance,
        };
      }

      const target = candidates[0];
      seen += 1;
      lastEntityId = target.id ?? null;
      visitedSet.add(target.id);
      lastDistance = bot.entity?.position ? distance(bot.entity.position, target.position) : null;
      if (target.id !== activeTargetId) {
        activeTargetId = target.id;
        activeTargetSince = Date.now();
        activeTargetBestDistance = Number.isFinite(lastDistance) ? lastDistance : null;
      } else if (
        Number.isFinite(lastDistance) &&
        (!Number.isFinite(activeTargetBestDistance) || lastDistance < activeTargetBestDistance - DEFAULT_LOCAL_SWEEP_DISTANCE_EPSILON)
      ) {
        activeTargetBestDistance = lastDistance;
        activeTargetSince = Date.now();
      } else if (Date.now() - activeTargetSince > DEFAULT_LOCAL_SWEEP_STALE_TARGET_MS) {
        ignoredSet.add(target.id);
        activeTargetId = null;
        activeTargetSince = 0;
        activeTargetBestDistance = null;
        continue;
      }

      if (Number.isFinite(lastDistance) && lastDistance <= opts.closeDistance) {
        setPickupControl(bot, 'forward', false);
        setPickupControl(bot, 'sprint', false);
        setPickupControl(bot, 'jump', false);
      } else {
        await lookAtPickupTarget(bot, target.position, ctx.signal);
        setPickupControl(bot, 'sprint', Number.isFinite(lastDistance) && lastDistance > 3);
        setPickupControl(bot, 'forward', true);
        setPickupControl(bot, 'jump', shouldJumpTowardDrop(bot, target));
      }

      await sleep(opts.intervalMs, ctx.signal);
      const current = readBotInventoryCounts(bot);
      if (!current.ok) return { ok: false, attempted: true, error: current.error };
      inventory = current.inventory;
      const deltaKey = countsKey(positiveDelta(before, inventory));
      if (deltaKey !== lastDeltaKey) {
        lastDeltaKey = deltaKey;
        activeTargetSince = Date.now();
      }
    }
  } finally {
    setPickupControl(bot, 'forward', false);
    setPickupControl(bot, 'sprint', false);
    setPickupControl(bot, 'jump', false);
  }

  const nearbyItems = nearbyItemEntities(bot, origin, opts.radius);
  return {
    ok: false,
    attempted: true,
    reason: 'visible dropped item entities remain after local sweep',
    delta: positiveDelta(before, inventory),
    inventory,
    nearbyItems,
    visited: [...visitedSet],
    ignored: [...ignoredSet],
    seen,
    elapsedMs: Date.now() - startedAtMs,
    lastEntityId,
    lastDistance,
  };
}

async function waitForPickupDelta(bot, before, waitMs, settleMs, signal) {
  const deadline = Date.now() + waitMs;
  let best = null;
  let lastDeltaChangeAt = 0;
  while (true) {
    if (signal?.aborted) return { preempted: true };

    const now = Date.now();
    const current = readBotInventoryCounts(bot);
    if (!current.ok) return { ok: false, error: current.error };

    const delta = positiveDelta(before, current.inventory);
    if (Object.keys(delta).length > 0) {
      if (!best || !sameCounts(best.delta, delta)) {
        best = { delta, inventory: current.inventory };
        lastDeltaChangeAt = now;
      } else {
        best = { delta, inventory: current.inventory };
      }
      if (now - lastDeltaChangeAt >= settleMs) {
        return { ok: true, delta: best.delta, inventory: best.inventory };
      }
    }

    if (now >= deadline) {
      if (best) return { ok: true, delta: best.delta, inventory: best.inventory };
      return { ok: false, delta: {}, inventory: current.inventory };
    }

    const remaining = Math.max(0, deadline - Date.now());
    const settleRemaining = best ? Math.max(0, settleMs - (Date.now() - lastDeltaChangeAt)) : PICKUP_POLL_MS;
    await sleep(Math.min(PICKUP_POLL_MS, remaining, settleRemaining));
  }
}

function positiveDelta(before = {}, after = {}) {
  const out = {};
  for (const [name, count] of Object.entries(after || {})) {
    const gained = Number(count || 0) - Number(before[name] || 0);
    if (gained > 0) out[name] = gained;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function sameCounts(a = {}, b = {}) {
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(([name, count]) => Number(b[name] || 0) === Number(count || 0));
}

function pickupIfTargetGone(bot, target, baseline) {
  if (target?.id != null && bot?.entities?.[target.id]) return null;
  const current = readBotInventoryCounts(bot);
  if (!current.ok) return { ok: false, error: current.error };
  const delta = positiveDelta(baseline, current.inventory);
  if (Object.keys(delta).length === 0) return null;
  return { ok: true, delta, inventory: current.inventory, targetGone: true };
}

function countsKey(counts = {}) {
  return JSON.stringify(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function nearbyItemEntities(bot, origin, radius) {
  if (!origin) return [];
  return Object.values(bot?.entities || {})
    .filter((entity) => entity?.name === 'item' && entity.position)
    .map((entity) => ({
      id: entity.id,
      position: positionForLog(entity.position),
      distance: distance(origin, entity.position),
    }))
    .filter((entity) => entity.distance <= radius)
    .sort((a, b) => a.distance - b.distance || Number(a.id || 0) - Number(b.id || 0));
}

function positionFromParams(params = {}) {
  const x = Number(params.x);
  const y = Number(params.y);
  const z = Number(params.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function positionForLog(position) {
  if (!position) return null;
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function distance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

async function lookAtPickupTarget(bot, position, signal) {
  if (!position) return;
  const target = new Vec3(Number(position.x), Number(position.y) + 0.25, Number(position.z));
  if (typeof bot.humanizer?.lookAt === 'function') {
    await bot.humanizer.lookAt(bot, target, {
      reason: 'recover_drops.local-sweep.look',
      critical: true,
      signal,
      force: true,
    });
    return;
  }
  await bot.lookAt?.(target, true);
}

function hasPickupControls(bot) {
  return typeof bot?.humanizer?.setControlState === 'function' || typeof bot?.setControlState === 'function';
}

function setPickupControl(bot, control, value) {
  if (typeof bot?.humanizer?.setControlState === 'function') {
    return bot.humanizer.setControlState(bot, control, value, {
      reason: `recover_drops.local-sweep.${control}`,
      critical: true,
    });
  }
  return bot?.setControlState?.(control, value);
}

function shouldJumpTowardDrop(bot, entity) {
  const botY = Number(bot.entity?.position?.y);
  const entityY = Number(entity?.position?.y);
  return Number.isFinite(botY) && Number.isFinite(entityY) && entityY - botY > 0.6;
}

function currentInventory(bot) {
  const current = readBotInventoryCounts(bot);
  return current.ok ? current.inventory : {};
}

function currentPickupFailure(bot, extra = {}) {
  return {
    ok: false,
    delta: {},
    inventory: currentInventory(bot),
    nearbyItems: [],
    ...extra,
  };
}

function abandonAfterPreempt(phase, state) {
  return {
    ok: false,
    reason: `drop recovery abandoned after reactive preempt during ${phase}`,
    state,
  };
}

function normalizeNonNegative(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
