import pkgPathfinder from 'mineflayer-pathfinder';
import log from '../logger.js';
import { blockModificationPolicy, observeStorageContents } from '../state/world_model.js';
import {
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
} from './_pathing.js';
import { closeContainer, openContainer, withdrawContainer } from './_containers.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';

const { goals: pfGoals } = pkgPathfinder;

export const STORAGE_BLOCK_NAMES = new Set(['chest', 'trapped_chest', 'barrel']);

export async function withdrawFromKnownStorage(bot, withdrawals, ctx = {}, opts = {}) {
  const pending = Array.isArray(withdrawals) ? withdrawals : [];
  const worldModel = opts.worldModel || ctx.worldModel || null;
  const withdrawn = [];

  for (const request of pending) {
    if (!request || request._done) continue;
    const group = pending.filter((other) => !other?._done && sameStorageRequest(request, other));
    const result = await withdrawStorageGroup(bot, group, ctx, { ...opts, worldModel });
    if (result.preempted || !result.ok) return { ...result, withdrawn };
    withdrawn.push(...result.withdrawn);
  }

  return { ok: true, withdrawn };
}

async function withdrawStorageGroup(bot, group, ctx, opts) {
  if (group.length === 0) return { ok: true, withdrawn: [] };
  const target = group[0];
  const position = target.position;
  const storageId = target.storageId || target.key || positionKey(position);
  const targetLog = {
    storageId,
    position: positionForLog(position),
    requests: summarizeRequests(group),
    requestCount: group.length,
  };
  log.executor.info('storage.withdraw.start', targetLog);
  if (!position) {
    const reason = `known storage ${storageId} has no position`;
    log.executor.warn('storage.withdraw.failed', { ...targetLog, phase: 'target', reason });
    return { ok: false, reason };
  }

  const policy = storageAccessPolicy(position, opts);
  if (!policy.ok) {
    log.executor.warn('storage.withdraw.protected', {
      ...targetLog,
      region: policy.region?.id || null,
      reason: policy.reason,
    });
    return {
      ok: false,
      reason: `known storage ${storageId} is inside do-not-touch region ${policy.region?.id || 'unknown'}`,
    };
  }
  const unknownItem = firstUnknownStorageItem(bot, group);
  if (unknownItem) {
    const reason = `unknown storage item "${unknownItem}"`;
    log.executor.warn('storage.withdraw.item-failed', { ...targetLog, phase: 'item-validation', item: unknownItem, reason });
    return { ok: false, reason };
  }

  if (ctx.signal?.aborted) {
    const reason = 'pre-aborted before storage withdrawal';
    log.executor.warn('storage.withdraw.preempted', { ...targetLog, phase: 'before-acquire', reason });
    return { preempted: true, reason };
  }

  const acquired = acquirePathfinder(bot, 'storage.withdraw', { skill: 'storage.withdraw', storageId });
  if (!acquired.ok) {
    const reason = `pathfinder acquire failed during storage withdrawal: ${acquired.message}`;
    log.executor.warn('storage.withdraw.failed', { ...targetLog, phase: 'acquire', reason });
    return { ok: false, reason };
  }
  const acq = acquired.acq;
  if (!acq) {
    const reason = 'reactive holds pathfinder';
    log.executor.warn('storage.withdraw.preempted', { ...targetLog, phase: 'acquire', reason });
    return { preempted: true, reason };
  }

  let container = null;
  let storageBlock = null;
  const withdrawn = [];
  try {
    const movementConfig = configurePathingMovements(bot, ctx, {
      phase: 'storage withdrawal',
      event: 'storage.withdraw.movements-error',
      allowParkour: false,
      worldModel: opts.worldModel,
    });
    if (!movementConfig.ok) {
      const reason = `${movementConfig.reason}: ${errorMessage(movementConfig.error)}`;
      log.executor.warn('storage.withdraw.failed', {
        ...targetLog,
        phase: movementConfig.worldModelError ? 'movement-policy' : 'movement-setup',
        reason,
      });
      return { ok: false, reason };
    }

    const goal = new pfGoals.GoalNear(position.x, position.y, position.z, opts.range ?? 2);
    log.executor.info('storage.withdraw.path-start', { ...targetLog, range: opts.range ?? 2 });
    const installed = setPathfinderGoal(bot, acq.token, goal, { movements: movementConfig.movements }, { skill: 'storage.withdraw', storageId });
    if (!installed.ok) {
      const reason = installed.denied
        ? 'pathfinder setGoal denied during storage withdrawal'
        : `pathfinder setGoal failed during storage withdrawal: ${installed.message}`;
      log.executor.warn('storage.withdraw.path-failed', { ...targetLog, reason });
      return { ok: false, reason };
    }
    const reached = await awaitGoalReached(bot, ctx.signal, opts.timeoutMs ?? 60000, {
      ownerToken: acq.token,
      waterStallMs: opts.waterStallMs,
      waterProgressMinDistSq: opts.waterProgressMinDistSq,
      pathStallMs: opts.pathStallMs,
      pathProgressMinDistSq: opts.pathProgressMinDistSq,
      watchdogIntervalMs: opts.watchdogIntervalMs,
      enablePathWatchdog: opts.enablePathWatchdog,
    });
    if (reached.kind === 'preempted') {
      const reason = 'reactive preempt during storage withdrawal walk';
      log.executor.warn('storage.withdraw.preempted', { ...targetLog, phase: 'walk', reason });
      return { preempted: true, reason };
    }
    if (reached.kind !== 'reached') {
      const reason = `walk to known storage ${storageId}: ${pathingFailureReason(reached)}`;
      log.executor.warn('storage.withdraw.path-failed', { ...targetLog, kind: reached.kind, reason });
      return { ok: false, reason };
    }
    log.executor.info('storage.withdraw.reached', targetLog);

    try {
      storageBlock = bot.blockAt(position);
    } catch (err) {
      if (ctx.signal?.aborted) {
        const reason = 'reactive preempt checking known storage';
        log.executor.warn('storage.withdraw.preempted', { ...targetLog, phase: 'block-check', reason });
        return { preempted: true, reason };
      }
      const reason = `world query failed checking known storage ${storageId}: ${errorMessage(err)}`;
      log.executor.warn('storage.withdraw.failed', {
        ...targetLog,
        phase: 'block-check',
        err: errorMessage(err),
        reason,
      });
      return { ok: false, reason };
    }
    if (!storageBlock || !STORAGE_BLOCK_NAMES.has(storageBlock.name)) {
      const reason = `known storage ${storageId} no longer present`;
      log.executor.warn('storage.withdraw.failed', {
        ...targetLog,
        phase: 'block-check',
        block: storageBlock?.name || null,
        reason,
      });
      return { ok: false, reason };
    }

    try {
      log.executor.info('storage.withdraw.open', { ...targetLog, block: storageBlock.name });
      container = await openContainer(bot, storageBlock, {
        skill: 'storage.withdraw',
        storageId,
        position: positionForLog(position),
      }, {
        timeoutMs: opts.containerOpenTimeoutMs,
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal?.aborted) {
        const reason = 'reactive preempt opening known storage';
        log.executor.warn('storage.withdraw.preempted', { ...targetLog, phase: 'open', reason });
        return { preempted: true, reason };
      }
      const reason = `openContainer failed for known storage ${storageId}: ${errorMessage(err)}`;
      log.executor.warn('storage.withdraw.open-failed', { ...targetLog, err: errorMessage(err), reason });
      return { ok: false, reason };
    }

    for (const request of group) {
      if (ctx.signal?.aborted) break;
      const item = itemTypeFor(bot, request.item);
      if (!item) {
        const reason = `unknown storage item "${request.item}"`;
        log.executor.warn('storage.withdraw.item-failed', { ...targetLog, item: request.item, reason });
        return { ok: false, reason };
      }
      const count = Number(request.count);
      if (!Number.isFinite(count) || count <= 0) {
        request._done = true;
        continue;
      }
      try {
        await withdrawContainer(container, item.id, null, count, {
          skill: 'storage.withdraw',
          storageId,
          item: request.item,
          count,
          position: positionForLog(position),
        }, {
          timeoutMs: opts.containerTransferTimeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        if (ctx.signal?.aborted) {
          const reason = 'reactive preempt during storage withdrawal transfer';
          log.executor.warn('storage.withdraw.preempted', { ...targetLog, phase: 'transfer', reason });
          return { preempted: true, reason };
        }
        const sighting = recordStorageMemory(ctx, opts.worldModel, storageBlock, container, storageId);
        if (sighting) log.executor.info('storage.withdraw.memory', { ...targetLog, contents: sighting.contents || {} });
        const reason = `storage.withdraw failed for ${request.item} from ${storageId}: ${err.message}`;
        log.executor.warn('storage.withdraw.item-failed', { ...targetLog, item: request.item, count, err: err.message, reason });
        return { ok: false, reason };
      }
      request._done = true;
      withdrawn.push({ storageId, item: request.item, count });
      log.executor.info('storage.withdraw.item', { ...targetLog, item: request.item, count });
    }

    const sighting = recordStorageMemory(ctx, opts.worldModel, storageBlock, container, storageId);
    if (sighting) log.executor.info('storage.withdraw.memory', { ...targetLog, contents: sighting.contents || {} });
    if (ctx.signal?.aborted) {
      const reason = 'reactive preempt during storage withdrawal transfer';
      log.executor.warn('storage.withdraw.preempted', { ...targetLog, phase: 'transfer', reason });
      return { preempted: true, reason };
    }
    log.executor.info('storage.withdraw.done', { ...targetLog, withdrawn: summarizeWithdrawn(withdrawn) });
    return { ok: true, withdrawn };
  } finally {
    if (container) await closeContainer(container, { skill: 'storage.withdraw', storageId, position: positionForLog(position) });
    releasePathfinder(acq, { skill: 'storage.withdraw', storageId });
  }
}

function storageAccessPolicy(position, opts = {}) {
  if (!opts.worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(opts.worldModel, position, { margin: opts.doNotTouchMargin ?? 0 });
}

function recordStorageMemory(ctx, worldModel, storageBlock, container, storageId = null) {
  if (!worldModel || !storageBlock) return null;
  try {
    const sighting = observeStorageContents(worldModel, storageBlock, container);
    if (sighting && ctx.worldModelStore?.save) ctx.worldModelStore.save(worldModel);
    return sighting;
  } catch (err) {
    log.executor.warn('storage.memory-update-failed', { storageId, err: err?.message || String(err) });
    return null;
  }
}

function itemTypeFor(bot, name) {
  const item = bot.registry?.itemsByName?.[name];
  if (!item || item.id == null) return null;
  return item;
}

function firstUnknownStorageItem(bot, group) {
  const itemsByName = bot?.registry?.itemsByName;
  if (!hasLoadedItemRegistry(itemsByName)) return null;
  for (const request of group) {
    if (!request?.item || !hasRegistryItem(itemsByName, request.item)) return request?.item || 'unknown';
  }
  return null;
}

function hasLoadedItemRegistry(itemsByName) {
  if (itemsByName instanceof Map) return itemsByName.size > 0;
  return Boolean(itemsByName && typeof itemsByName === 'object' && Object.keys(itemsByName).length > 0);
}

function hasRegistryItem(itemsByName, name) {
  if (itemsByName instanceof Map) return itemsByName.has(name);
  return Boolean(itemsByName && typeof itemsByName === 'object' && Object.hasOwn(itemsByName, name));
}

function sameStorageRequest(a, b) {
  if ((a.storageId || a.key) && (b.storageId || b.key)) return (a.storageId || a.key) === (b.storageId || b.key);
  return positionKey(a.position) === positionKey(b.position);
}

function positionKey(position) {
  if (!position) return 'unknown';
  return `${position.x},${position.y},${position.z}`;
}

function positionForLog(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function summarizeRequests(group) {
  const counts = {};
  for (const request of group || []) {
    if (!request?.item) continue;
    const count = Number(request.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    counts[request.item] = (counts[request.item] || 0) + count;
  }
  return sortCountRecord(counts);
}

function summarizeWithdrawn(withdrawn) {
  const counts = {};
  for (const item of withdrawn || []) {
    if (!item?.item) continue;
    counts[item.item] = (counts[item.item] || 0) + item.count;
  }
  return sortCountRecord(counts);
}

function sortCountRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function errorMessage(err) {
  return err?.message || String(err);
}
