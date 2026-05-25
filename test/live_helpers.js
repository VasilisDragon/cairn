import { Vec3 } from 'vec3';

import createBot from '../src/bot.js';
import log from '../src/logger.js';
import buildSnapshot from '../src/state/snapshot.js';
import { run as gotoSkill } from '../src/skills/goto.js';
import { closeContainer, depositContainer, withdrawContainer } from '../src/skills/_containers.js';

export const SUPPLY_CHEST_POS = new Vec3(
  envNumber('MCBOT_SUPPLY_CHEST_X', 248),
  envNumber('MCBOT_SUPPLY_CHEST_Y', 68),
  envNumber('MCBOT_SUPPLY_CHEST_Z', 428),
);

export const SUPPLY_CHEST_RANGE = envNumber('MCBOT_SUPPLY_CHEST_RANGE', 1);
export const SUPPLY_CHEST_OPEN_TIMEOUT_MS = envNumber('MCBOT_SUPPLY_CHEST_OPEN_TIMEOUT_MS', 10000);
export const SUPPLY_CHEST_SETTLE_MS = envNumber('MCBOT_SUPPLY_CHEST_SETTLE_MS', 1000);
export const SUPPLY_CHEST_DEFER_UNKNOWN_BLOCK_DISTANCE = envNumber('MCBOT_SUPPLY_CHEST_DEFER_UNKNOWN_BLOCK_DISTANCE', 8);
export const SPAWN_TIMEOUT_MS = envNumber('MCBOT_LIVE_SPAWN_TIMEOUT_MS', 30000);
export const RUN_TIMEOUT_MS = envNumber('MCBOT_LIVE_RUN_TIMEOUT_MS', 180000);

const CHEST_BLOCKS = new Set(['chest', 'trapped_chest']);
const OPEN_PACKET_EVENTS = Object.freeze([
  'open_window',
  'open_screen',
  'window_items',
  'close_window',
  'chat',
  'system_chat',
]);

export function runLiveScenario(id, onSpawn, opts = {}) {
  const bot = createBot();
  const controller = new AbortController();
  let finished = false;
  let observedDeaths = 0;

  const spawnWatchdog = setTimeout(() => {
    finish(1, `${id}.spawn-timeout`, { reason: `no spawn after ${opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS}ms` });
  }, opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS);
  const runWatchdog = setTimeout(() => {
    controller.abort(`${id} live test timeout`);
    finish(3, `${id}.timeout`, { reason: `scenario exceeded ${opts.runTimeoutMs ?? RUN_TIMEOUT_MS}ms` });
  }, opts.runTimeoutMs ?? RUN_TIMEOUT_MS);

  function finish(code, event, fields = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(spawnWatchdog);
    clearTimeout(runWatchdog);
    log.test[code === 0 ? 'info' : 'error'](event, fields);
    setTimeout(() => {
      try {
        bot.quit(event);
      } catch {}
      process.exit(code);
    }, 500);
  }

  bot.once('spawn', async () => {
    clearTimeout(spawnWatchdog);
    log.test.info(`${id}.spawned`, { position: positionForLog(bot.entity?.position) });
    try {
      await onSpawn({ bot, controller, finish });
    } catch (err) {
      finish(2, `${id}.failure`, {
        reason: err?.message || String(err),
        ...(err?.fields || {}),
      });
    }
  });

  bot.on('death', () => {
    observedDeaths += 1;
    const fields = { position: positionForLog(bot.entity?.position), observedDeaths };
    if (opts.allowDeath === true) {
      log.test.warn(`${id}.death-observed`, fields);
      return;
    }
    finish(4, `${id}.death`, fields);
  });
  bot.on('error', (err) => log.test.error(`${id}.error`, { err: err?.message || String(err) }));
  bot.on('kicked', (reason) => finish(5, `${id}.kicked`, { reason }));
}

export async function waitForLiveChunks(bot, id, timeoutMs = 30000) {
  await withTimeout(Promise.resolve(bot.chunksReady), timeoutMs, `chunksReady timed out after ${timeoutMs}ms`);
  log.test.info(`${id}.chunks-ready`, { position: positionForLog(bot.entity?.position) });
}

export function liveSnapshot(bot, ctx = {}) {
  const snapshot = buildSnapshot(bot, ctx);
  return {
    position: snapshot.position,
    health: snapshot.health,
    food: snapshot.food,
    saturation: snapshot.saturation,
    timeOfDay: snapshot.timeOfDay,
    inventory: snapshot.inventory,
    nearbyHostiles: snapshot.nearbyHostiles,
    reactiveState: snapshot.reactiveState,
    pathfinder: snapshot.pathfinder,
  };
}

export async function openAuthorizedSupplyChest(bot, ctx, id, opts = {}) {
  const position = opts.position || SUPPLY_CHEST_POS;
  const range = opts.range ?? SUPPLY_CHEST_RANGE;
  let blockCheck = chestBlockCheck(bot, position);
  const initialDistance = distanceTo(bot.entity?.position, position);
  log.test.info(`${id}.block-check`, {
    position: positionForLog(position),
    chest: blockCheck.chest,
    above: blockCheck.above,
    botPosition: positionForLog(bot.entity?.position),
    distance: initialDistance,
  });
  if (blockCheck.error) throw new Error(`authorized supply chest block check failed: ${blockCheck.error}`);
  if (!CHEST_BLOCKS.has(blockCheck.chest)) {
    if (shouldDeferSupplyChestBlockCheck(blockCheck, initialDistance, opts)) {
      log.test.info(`${id}.block-check.deferred`, {
        reason: 'target block unavailable before navigation; will recheck after moving near fixture',
        position: positionForLog(position),
        distance: initialDistance,
      });
    } else {
      throw new Error(`authorized supply chest not found at ${formatPos(position)}; found ${blockCheck.chest || 'nothing'}`);
    }
  } else if (isBlockedAboveChest(blockCheck.above)) {
    throw new Error(`authorized supply chest at ${formatPos(position)} is blocked above by ${blockCheck.above}`);
  }
  assertNoHostiles(bot, id, { phase: 'before authorized chest navigation', radius: opts.hostileRadius ?? 24 });

  const inRangeBeforeNavigation = Number.isFinite(initialDistance) && initialDistance <= range + 0.75;
  const nav = inRangeBeforeNavigation
    ? { ok: true, preempted: false, reason: 'already-in-range' }
    : await runWithHostileAbort(bot, id, 'during authorized chest navigation', ctx, async (monitoredCtx) => {
      const navCtx = { ...monitoredCtx, callState: {}, currentSubtask: `${id}.navigate` };
      return gotoSkill(bot, { x: position.x, y: position.y, z: position.z, range }, navCtx);
    }, opts.hostileRadius ?? 24);
  log.test.info(`${id}.navigate`, {
    ok: !!nav.ok,
    preempted: !!nav.preempted,
    reason: nav.reason,
    position: positionForLog(bot.entity?.position),
    distance: distanceTo(bot.entity?.position, position),
    skippedPathfinder: inRangeBeforeNavigation,
  });
  if (nav.preempted) throw new Error(`navigation to authorized supply chest was preempted: ${nav.reason}`);
  if (!nav.ok) throw new Error(`navigation to authorized supply chest failed: ${nav.reason}`);
  blockCheck = chestBlockCheck(bot, position);
  log.test.info(`${id}.block-check.after-navigate`, {
    position: positionForLog(position),
    chest: blockCheck.chest,
    above: blockCheck.above,
    botPosition: positionForLog(bot.entity?.position),
    distance: distanceTo(bot.entity?.position, position),
  });
  if (blockCheck.error) throw new Error(`authorized supply chest block check failed after navigation: ${blockCheck.error}`);
  if (!CHEST_BLOCKS.has(blockCheck.chest)) {
    throw new Error(`authorized supply chest not found at ${formatPos(position)} after navigation; found ${blockCheck.chest || 'nothing'}`);
  }
  if (isBlockedAboveChest(blockCheck.above)) {
    throw new Error(`authorized supply chest at ${formatPos(position)} is blocked above by ${blockCheck.above}`);
  }
  const settleMs = opts.settleMs ?? SUPPLY_CHEST_SETTLE_MS;
  if (settleMs > 0) {
    log.test.info(`${id}.chest.open.settle`, {
      settleMs,
      position: positionForLog(bot.entity?.position),
      currentWindow: windowForLog(bot.currentWindow),
    });
    await sleep(settleMs);
  }
  assertNoHostiles(bot, id, { phase: 'before authorized chest open', radius: opts.hostileRadius ?? 24 });
  await ensureSafeChestHand(bot, id);

  const block = bot.blockAt(position);
  log.test.info(`${id}.chest.open.start`, {
    position: positionForLog(position),
    block: block?.name || null,
    distance: distanceTo(bot.entity?.position, position),
    heldItem: itemForLog(bot.heldItem),
    quickBarSlot: bot.quickBarSlot ?? null,
    currentWindow: windowForLog(bot.currentWindow),
  });
  try {
    const container = await openChestContainerWithDiagnostics(bot, block, id, {
      position,
      timeoutMs: opts.openTimeoutMs ?? SUPPLY_CHEST_OPEN_TIMEOUT_MS,
    });
    log.test.info(`${id}.chest.open`, {
      windowId: container.id,
      windowType: container.type,
      itemSummary: countItems(container.containerItems()),
    });
    return { block, container, position };
  } catch (err) {
    const reason = err?.message || String(err);
    log.test.error(`${id}.chest.open.failed`, {
      reason,
      position: positionForLog(position),
      block: block?.name || null,
      distance: distanceTo(bot.entity?.position, position),
    });
    throw new Error(`authorized supply chest open failed: ${reason}`);
  }
}

async function ensureSafeChestHand(bot, id) {
  const beforeSlot = bot.quickBarSlot ?? null;
  const beforeItem = itemForLog(bot.heldItem);
  const safeSlot = chooseSafeChestQuickBarSlot(bot);
  log.test.info(`${id}.chest.open.hand-check`, {
    quickBarSlot: beforeSlot,
    heldItem: beforeItem,
    emptyQuickBarSlot: safeSlot.reason === 'empty' ? safeSlot.slot : null,
    safeQuickBarSlot: safeSlot.slot,
    safeQuickBarReason: safeSlot.reason,
  });
  if (safeSlot.slot !== null) {
    bot.setQuickBarSlot(safeSlot.slot);
    await sleep(100);
    log.test.info(`${id}.chest.open.hand`, {
      fromQuickBarSlot: beforeSlot,
      toQuickBarSlot: bot.quickBarSlot ?? safeSlot.slot,
      reason: safeSlot.reason,
      heldBefore: beforeItem,
      heldAfter: itemForLog(bot.heldItem),
    });
    return;
  }
  if (isPlaceableHeldItem(bot)) {
    throw new Error(`cannot safely open authorized supply chest while holding placeable item ${bot.heldItem.name}; no empty or non-placeable hotbar slot available`);
  }
  log.test.info(`${id}.chest.open.hand`, {
    fromQuickBarSlot: beforeSlot,
    toQuickBarSlot: beforeSlot,
    heldBefore: beforeItem,
    heldAfter: beforeItem,
  });
}

export function chooseSafeChestQuickBarSlot(bot) {
  const emptySlot = findEmptyQuickBarSlot(bot);
  if (emptySlot !== null) return { slot: emptySlot, reason: 'empty' };
  const nonPlaceableSlot = findNonPlaceableQuickBarSlot(bot);
  if (nonPlaceableSlot !== null) return { slot: nonPlaceableSlot, reason: 'non-placeable' };
  return { slot: null, reason: 'none' };
}

function findEmptyQuickBarSlot(bot) {
  const slots = bot.inventory?.slots || [];
  const start = bot.QUICK_BAR_START ?? bot.inventory?.hotbarStart ?? 36;
  for (let i = 0; i < 9; i++) {
    if (!slots[start + i]) return i;
  }
  return null;
}

function findNonPlaceableQuickBarSlot(bot) {
  const slots = bot.inventory?.slots || [];
  const start = bot.QUICK_BAR_START ?? bot.inventory?.hotbarStart ?? 36;
  for (let i = 0; i < 9; i++) {
    const item = slots[start + i];
    if (item?.name && !bot.registry?.blocksByName?.[item.name]) return i;
  }
  return null;
}

function isPlaceableHeldItem(bot) {
  const name = bot.heldItem?.name;
  return !!name && !!bot.registry?.blocksByName?.[name];
}

async function openChestContainerWithDiagnostics(bot, block, id, opts = {}) {
  const attempts = chestOpenAttemptPlan(bot.entity?.position, block?.position);
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const container = await openChestContainerAttempt(bot, block, id, attempt, opts);
      if (!isContainerWindow(container)) {
        throw new Error(`non-container window opened: ${JSON.stringify(windowForLog(container))}`);
      }
      return container;
    } catch (err) {
      lastError = err;
      log.test.warn(`${id}.chest.open.attempt.failed`, {
        attempt: attempt.name,
        reason: err?.message || String(err),
        currentWindow: windowForLog(bot.currentWindow),
      });
      if (err?.code === 'LIVE_HOSTILE_UNSAFE') throw err;
    }
  }
  throw lastError || new Error('container open failed without an attempt');
}

async function openChestContainerAttempt(bot, block, id, attempt, opts = {}) {
  if (bot.currentWindow) {
    log.test.info(`${id}.chest.open.already-open`, {
      attempt: attempt.name,
      window: windowForLog(bot.currentWindow),
    });
    return bot.currentWindow;
  }

  const timeoutMs = opts.timeoutMs ?? SUPPLY_CHEST_OPEN_TIMEOUT_MS;
  const diagnostics = installChestOpenDiagnostics(bot, id, attempt.name);
  const direction = vecFromPlain(attempt.direction);
  const cursorPos = vecFromPlain(attempt.cursorPos);

  log.test.info(`${id}.chest.open.attempt`, {
    attempt: attempt.name,
    direction: attempt.direction,
    cursorPos: attempt.cursorPos,
    timeoutMs,
  });

  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      let hostileTimer = null;

      const finish = (err, window = null) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (hostileTimer) clearInterval(hostileTimer);
        bot.removeListener('windowOpen', onWindowOpen);
        if (err) reject(err);
        else resolve(window);
      };

      const onWindowOpen = (window) => finish(null, window);
      bot.once('windowOpen', onWindowOpen);
      timer = setTimeout(() => {
        const err = new Error(`container open timed out after ${timeoutMs}ms`);
        err.code = 'CONTAINER_OPEN_TIMEOUT';
        finish(err);
      }, timeoutMs);
      hostileTimer = setInterval(() => {
        const hostiles = nearbyHostiles(bot, opts.hostileRadius ?? 24);
        if (hostiles.length === 0) return;
        log.test.warn(`${id}.hostile-check`, {
          phase: `during authorized chest open ${attempt.name}`,
          radius: opts.hostileRadius ?? 24,
          hostiles,
        });
        const err = new Error(`live test unsafe during authorized chest open ${attempt.name}; nearby hostiles present: ${formatHostiles(hostiles)}`);
        err.code = 'LIVE_HOSTILE_UNSAFE';
        finish(err);
      }, 250);

      Promise.resolve()
        .then(() => bot.activateBlock(block, direction, cursorPos))
        .catch((err) => finish(err));
    });
  } finally {
    diagnostics.cleanup();
  }
}

async function runWithHostileAbort(bot, id, phase, ctx, fn, radius) {
  const controller = new AbortController();
  let unsafeReason = null;
  let monitor = null;
  let parentAbortInstalled = false;
  const parentSignal = ctx?.signal;
  const onParentAbort = () => controller.abort(parentSignal?.reason || `${phase} aborted`);
  try {
    if (parentSignal?.aborted) {
      return fn({ ...ctx, signal: parentSignal });
    }
    parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
    parentAbortInstalled = typeof parentSignal?.addEventListener === 'function';
    monitor = setInterval(() => {
      const hostiles = nearbyHostiles(bot, radius);
      if (hostiles.length === 0 || unsafeReason) return;
      unsafeReason = `live test unsafe ${phase}; nearby hostiles present: ${formatHostiles(hostiles)}`;
      log.test.warn(`${id}.hostile-check`, { phase, radius, hostiles });
      controller.abort(unsafeReason);
    }, 250);
    const result = await fn({ ...ctx, signal: controller.signal });
    if (unsafeReason) throw new Error(unsafeReason);
    return result;
  } finally {
    if (monitor) clearInterval(monitor);
    if (parentAbortInstalled) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

function installChestOpenDiagnostics(bot, id, attemptName) {
  const onWindowOpen = (window) => {
    log.test.info(`${id}.chest.open.window-event`, {
      attempt: attemptName,
      window: windowForLog(window),
    });
  };
  const onWindowClose = (window) => {
    log.test.info(`${id}.chest.open.window-close-event`, {
      attempt: attemptName,
      window: windowForLog(window),
    });
  };
  const onMessage = (message, type) => {
    log.test.info(`${id}.chest.open.message`, {
      attempt: attemptName,
      type,
      message: String(message).slice(0, 240),
    });
  };
  const packetListeners = [];

  bot.on('windowOpen', onWindowOpen);
  bot.on('windowClose', onWindowClose);
  bot.on('messagestr', onMessage);
  for (const eventName of OPEN_PACKET_EVENTS) {
    const listener = (packet) => {
      log.test.info(`${id}.chest.open.packet`, {
        attempt: attemptName,
        packet: eventName,
        summary: packetForLog(eventName, packet),
      });
    };
    bot._client?.on?.(eventName, listener);
    packetListeners.push([eventName, listener]);
  }

  return {
    cleanup() {
      bot.removeListener('windowOpen', onWindowOpen);
      bot.removeListener('windowClose', onWindowClose);
      bot.removeListener('messagestr', onMessage);
      for (const [eventName, listener] of packetListeners) bot._client?.removeListener?.(eventName, listener);
    },
  };
}

export async function closeLoggedChest(container, id) {
  log.test.info(`${id}.chest.close.start`, { windowId: container?.id ?? null });
  const closed = await closeContainer(container, { skill: id });
  log.test.info(`${id}.chest.close`, { closed });
  return closed;
}

export async function withdrawLogged(bot, container, itemName, count, id) {
  const item = registryItem(bot, itemName);
  if (!item) throw new Error(`safe withdrawal item "${itemName}" is unknown to the registry`);
  const before = containerInventoryCounts(container);
  const chestBefore = countItems(container.containerItems());
  log.test.info(`${id}.withdraw.start`, {
    item: itemName,
    count,
    inventoryBefore: before,
    chestBefore,
  });
  await withdrawContainer(container, item.id, null, count, { skill: id, item: itemName, count });
  const after = containerInventoryCounts(container);
  const chestAfter = countItems(container.containerItems());
  log.test.info(`${id}.withdraw`, {
    item: itemName,
    count,
    inventoryAfter: after,
    inventoryDelta: diffCounts(before, after),
    chestAfter,
    chestDelta: diffCounts(chestBefore, chestAfter),
  });
  return { before, after };
}

export async function depositLogged(bot, container, itemName, count, id) {
  const item = registryItem(bot, itemName);
  if (!item) throw new Error(`deposit item "${itemName}" is unknown to the registry`);
  const inventoryBefore = containerInventoryCounts(container);
  const chestBefore = countItems(container.containerItems());
  log.test.info(`${id}.deposit.start`, { item: itemName, count, inventoryBefore, chestBefore });
  await depositContainer(container, item.id, null, count, { skill: id, item: itemName, count });
  const inventoryAfter = containerInventoryCounts(container);
  const chestAfter = countItems(container.containerItems());
  log.test.info(`${id}.deposit`, {
    item: itemName,
    count,
    inventoryAfter,
    inventoryDelta: diffCounts(inventoryBefore, inventoryAfter),
    chestAfter,
    chestDelta: diffCounts(chestBefore, chestAfter),
  });
  return { inventoryBefore, inventoryAfter, chestBefore, chestAfter };
}

export async function equipLogged(bot, itemName, destination, id) {
  const beforeInventory = inventoryCounts(bot);
  const beforeEquipment = equipmentSummary(bot);
  const item = selectInventoryItem(bot, itemName);
  if (!item) throw new Error(`cannot equip "${itemName}"; item is not in inventory`);
  log.test.info(`${id}.equip.start`, { item: itemName, destination, equipmentBefore: beforeEquipment });
  await bot.equip(item, destination);
  const afterInventory = inventoryCounts(bot);
  const afterEquipment = equipmentSummary(bot);
  log.test.info(`${id}.equip`, {
    item: itemName,
    destination,
    equipmentAfter: afterEquipment,
    equipmentBefore: beforeEquipment,
    inventoryAfter: afterInventory,
    inventoryBefore: beforeInventory,
    inventoryDelta: diffCounts(beforeInventory, afterInventory),
  });
}

export function chooseAvailableItem(container, candidates, opts = {}) {
  const contents = container.containerItems();
  for (const name of candidates.filter(Boolean)) {
    const total = contents
      .filter((item) => item?.name === name)
      .reduce((sum, item) => sum + item.count, 0);
    if (total >= (opts.minCount ?? 1)) return { name, available: total };
  }
  return null;
}

export function chestOpenAttemptPlan(botPosition, blockPosition) {
  const attempts = [];
  const side = nearestChestSide(botPosition, blockPosition);
  if (side) attempts.push(side);
  attempts.push(
    {
      name: 'top',
      direction: { x: 0, y: 1, z: 0 },
      cursorPos: { x: 0.5, y: 0.5, z: 0.5 },
    },
    { name: 'north-side', direction: { x: 0, y: 0, z: -1 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } },
    { name: 'south-side', direction: { x: 0, y: 0, z: 1 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } },
    { name: 'west-side', direction: { x: -1, y: 0, z: 0 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } },
    { name: 'east-side', direction: { x: 1, y: 0, z: 0 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } },
  );
  const seen = new Set();
  return attempts.filter((attempt) => {
    if (seen.has(attempt.name)) return false;
    seen.add(attempt.name);
    return true;
  });
}

export function shouldDeferSupplyChestBlockCheck(blockCheck, distance, opts = {}) {
  if (blockCheck?.error || blockCheck?.chest) return false;
  const threshold = opts.deferUnknownBlockDistance ?? SUPPLY_CHEST_DEFER_UNKNOWN_BLOCK_DISTANCE;
  return distance === null || !Number.isFinite(distance) || distance > threshold;
}

export function inventoryCounts(bot) {
  return countItems(bot.inventory?.items?.() || []);
}

export function containerInventoryCounts(container) {
  const start = container?.inventoryStart;
  const end = container?.inventoryEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return {};
  return countItems((container.slots || []).slice(start, end));
}

export function countItems(items) {
  const counts = {};
  for (const item of items || []) {
    if (!item?.name) continue;
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return sortRecord(counts);
}

export function diffCounts(before, after) {
  const delta = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const diff = (after?.[key] || 0) - (before?.[key] || 0);
    if (diff !== 0) delta[key] = diff;
  }
  return sortRecord(delta);
}

export function equipmentSummary(bot) {
  const equipment = bot.entity?.equipment || [];
  return {
    hand: itemForLog(bot.heldItem || equipment[0]),
    offHand: itemForLog(equipment[1]),
    feet: itemForLog(equipment[2]),
    legs: itemForLog(equipment[3]),
    torso: itemForLog(equipment[4]),
    head: itemForLog(equipment[5]),
  };
}

export function nearbyHostiles(bot, radius = 24) {
  const origin = bot.entity?.position;
  if (!origin) return [];
  return Object.values(bot.entities || {})
    .filter((entity) => entity && entity !== bot.entity && isHostileName(entity.name))
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      position: positionForLog(entity.position),
      distance: distanceTo(origin, entity.position),
    }))
    .filter((entity) => entity.distance !== null && entity.distance <= radius)
    .sort((a, b) => a.distance - b.distance || String(a.name).localeCompare(String(b.name)));
}

export function assertNoHostiles(bot, id, opts = {}) {
  const radius = opts.radius ?? 24;
  const hostiles = nearbyHostiles(bot, radius);
  log.test.info(`${id}.hostile-check`, {
    phase: opts.phase || 'baseline',
    radius,
    hostiles,
  });
  if (hostiles.length > 0) {
    throw new Error(`live test unsafe during ${opts.phase || 'baseline'}; nearby hostiles present: ${formatHostiles(hostiles)}`);
  }
}

export function positionForLog(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

export function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function envPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function withTimeout(promise, timeoutMs, message) {
  if (!(timeoutMs > 0)) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chestBlockCheck(bot, position) {
  try {
    return {
      chest: bot.blockAt(position)?.name || null,
      above: bot.blockAt(position.offset(0, 1, 0))?.name || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function isBlockedAboveChest(blockName) {
  return !!blockName && blockName !== 'air' && blockName !== 'cave_air' && blockName !== 'void_air';
}

function registryItem(bot, name) {
  return bot.registry?.itemsByName?.[name] || null;
}

function selectInventoryItem(bot, name) {
  return (bot.inventory?.items?.() || [])
    .filter((item) => item?.name === name)
    .sort((a, b) => Number(a.slot ?? 9999) - Number(b.slot ?? 9999))
    .at(0) || null;
}

function itemForLog(item) {
  if (!item) return null;
  return { name: item.name, count: item.count ?? 1 };
}

function windowForLog(window) {
  if (!window) return null;
  return {
    id: window.id ?? null,
    type: window.type ?? null,
    title: window.title ?? null,
    slotCount: Array.isArray(window.slots) ? window.slots.length : null,
  };
}

function packetForLog(eventName, packet = {}) {
  if (eventName === 'open_window' || eventName === 'open_screen') {
    return {
      windowId: packet.windowId ?? packet.containerId ?? null,
      inventoryType: packet.inventoryType ?? packet.windowType ?? null,
      slotCount: packet.slotCount ?? packet.slots ?? null,
      title: packet.windowTitle ? String(packet.windowTitle).slice(0, 120) : null,
    };
  }
  if (eventName === 'window_items') {
    return {
      windowId: packet.windowId ?? null,
      itemCount: Array.isArray(packet.items) ? packet.items.length : null,
      stateId: packet.stateId ?? null,
    };
  }
  if (eventName === 'set_slot') {
    return {
      windowId: packet.windowId ?? null,
      slot: packet.slot ?? null,
      stateId: packet.stateId ?? null,
      itemId: packet.item?.present === false ? null : packet.item?.itemId ?? null,
      itemCount: packet.item?.itemCount ?? null,
    };
  }
  if (eventName === 'chat' || eventName === 'system_chat') {
    return {
      message: String(packet.formattedMessage || packet.message || packet.content || '').slice(0, 240),
      position: packet.position ?? null,
    };
  }
  return Object.fromEntries(
    Object.entries(packet)
      .filter(([key]) => !['items', 'data'].includes(key))
      .slice(0, 8)
      .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value).slice(0, 120) : value]),
  );
}

function isContainerWindow(window) {
  return !!window && typeof window.containerItems === 'function';
}

function vecFromPlain(value) {
  return new Vec3(value.x, value.y, value.z);
}

function nearestChestSide(botPosition, blockPosition) {
  if (!botPosition || !blockPosition) return null;
  const dx = botPosition.x - (blockPosition.x + 0.5);
  const dz = botPosition.z - (blockPosition.z + 0.5);
  if (Math.abs(dx) > Math.abs(dz)) {
    return dx >= 0
      ? { name: 'east-side', direction: { x: 1, y: 0, z: 0 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } }
      : { name: 'west-side', direction: { x: -1, y: 0, z: 0 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } };
  }
  return dz >= 0
    ? { name: 'south-side', direction: { x: 0, y: 0, z: 1 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } }
    : { name: 'north-side', direction: { x: 0, y: 0, z: -1 }, cursorPos: { x: 0.5, y: 0.5, z: 0.5 } };
}

function distanceTo(a, b) {
  if (!a || !b) return null;
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 100) / 100;
}

function formatPos(position) {
  return `${position.x},${position.y},${position.z}`;
}

function formatHostiles(hostiles) {
  return hostiles.map((h) => `${h.name}@${h.distance}`).join(', ');
}

function isHostileName(name) {
  return new Set([
    'blaze',
    'creeper',
    'drowned',
    'enderman',
    'husk',
    'phantom',
    'pillager',
    'skeleton',
    'spider',
    'stray',
    'witch',
    'wither_skeleton',
    'zombie',
    'zombie_villager',
  ]).has(name);
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record || {}).sort(([a], [b]) => a.localeCompare(b)));
}
