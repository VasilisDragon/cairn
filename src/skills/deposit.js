// deposit — put items into a chest. Per decision (C) the chest is a LOCKED
// target: chosen on first invocation and reused across all preempt/resume
// cycles. Real failure (chest gone / unreachable) escalates to the advisor.
//
// callState shape:
//   {
//     lockedChestPos: Vec3 | null,           // captured on first call
//     remainingItems: [{name, count?}, ...], // mutated as we transfer
//     transferred:    [{name, count}],
//   }

import pkgPathfinder from 'mineflayer-pathfinder';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { readBotInventoryItems } from '../state/materials.js';
import { blockModificationPolicy, observeStorageContents } from '../state/world_model.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import {
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
  worldModelFromContext,
} from './_pathing.js';
import { closeContainer, depositContainer, openContainer } from './_containers.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';

const { goals: pfGoals } = pkgPathfinder;

const CHEST_NAMES = new Set(['chest', 'trapped_chest']);

export async function run(bot, params, ctx) {
  const wanted = params.items || [];
  const maxDistance = params.maxDistance ?? 32;
  if (!Array.isArray(wanted) || wanted.length === 0) {
    return { ok: false, reason: 'deposit.items must be a non-empty array', state: buildSnapshot(bot, ctx) };
  }
  const unknownItem = firstUnknownDepositItem(bot, wanted);
  if (unknownItem) {
    return { ok: false, reason: `unknown item "${unknownItem}"`, state: buildSnapshot(bot, ctx) };
  }

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for deposit chunk readiness');
  if (chunks.preempted) return { preempted: true, reason: chunks.reason, state: buildSnapshot(bot, ctx) };
  if (chunks.error) return { ok: false, reason: `chunk data unavailable during deposit: ${errorMessage(chunks.error)}`, state: buildSnapshot(bot, ctx) };

  const worldModelResult = worldModelFromContext(ctx);
  if (worldModelResult.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during deposit: ${worldModelResult.error.message}`,
      state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
    };
  }
  const worldModel = worldModelResult.model;

  const s = ctx.callState;
  if (!s.remainingItems) s.remainingItems = wanted.map((w) => ({ ...w }));
  if (!s.transferred) s.transferred = [];
  if (s.lockedChestPos === undefined) s.lockedChestPos = null;

  // Lock the chest on first invocation.
  if (!s.lockedChestPos) {
    const chestSearch = findNearestChest(bot, maxDistance, { worldModel, signal: ctx.signal });
    if (chestSearch.preempted) {
      return { preempted: true, reason: chestSearch.reason, state: buildSnapshot(bot, ctx) };
    }
    if (chestSearch.error) {
      return {
        ok: false,
        reason: `world query failed during deposit chest scan: ${errorMessage(chestSearch.error)}`,
        state: buildSnapshot(bot, ctx),
      };
    }
    const chestBlock = chestSearch.block;
    if (!chestBlock) {
      const protectedReason = chestSearch.protected > 0 ? ` (protected ${chestSearch.protected})` : '';
      return { ok: false, reason: `no chest within ${maxDistance} blocks${protectedReason}`, state: buildSnapshot(bot, ctx) };
    }
    s.lockedChestPos = chestBlock.position.clone();
  }

  if (ctx.signal?.aborted) {
    return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };
  }

  const lockedPolicy = depositTargetPolicy(s.lockedChestPos, { worldModel });
  if (!lockedPolicy.ok) {
    return {
      ok: false,
      reason: `locked chest is inside do-not-touch region ${lockedPolicy.region?.id || 'unknown'}`,
      state: buildSnapshot(bot, ctx),
    };
  }

  const acquired = acquirePathfinder(bot, 'deposit', { skill: 'deposit' });
  if (!acquired.ok) {
    return { ok: false, reason: `pathfinder acquire failed during deposit: ${acquired.message}`, state: buildSnapshot(bot, ctx) };
  }
  const acq = acquired.acq;
  if (!acq) return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };

  let chest;
  const closeChest = async () => {
    if (!chest) return;
    const openChest = chest;
    chest = null;
    await closeContainer(openChest, { skill: 'deposit', position: positionForLog(s.lockedChestPos) });
  };
  try {
    // Walk to the chest.
    const goal = new pfGoals.GoalNear(s.lockedChestPos.x, s.lockedChestPos.y, s.lockedChestPos.z, 2);
    const movementConfig = configurePathingMovements(bot, ctx, {
      phase: 'deposit',
      allowParkour: false,
      worldModel,
    });
    if (!movementConfig.ok) {
      const stateCtx = movementConfig.worldModelError ? { ...ctx, worldModelStore: null } : ctx;
      return {
        ok: false,
        reason: `${movementConfig.reason}: ${errorMessage(movementConfig.error)}`,
        state: buildSnapshot(bot, stateCtx),
      };
    }
    const installed = setPathfinderGoal(bot, acq.token, goal, { movements: movementConfig.movements }, { skill: 'deposit' });
    if (!installed.ok) {
      const reason = installed.denied
        ? 'pathfinder setGoal denied'
        : `pathfinder setGoal failed during deposit: ${installed.message}`;
      return { ok: false, reason, state: buildSnapshot(bot, ctx) };
    }
    const r = await awaitGoalReached(bot, ctx.signal, 60000, { ownerToken: acq.token });
    if (r.kind === 'preempted') return { preempted: true, reason: 'reactive preempt during deposit walk', state: buildSnapshot(bot, ctx) };
    if (r.kind !== 'reached') {
      return { ok: false, reason: `walk to chest: ${pathingFailureReason(r)}`, state: buildSnapshot(bot, ctx) };
    }

    // Confirm the chest is still there. If not, the target is gone — real failure.
    let chestBlock;
    try {
      chestBlock = bot.blockAt(s.lockedChestPos);
    } catch (err) {
      if (ctx.signal?.aborted) {
        return { preempted: true, reason: 'reactive preempt checking deposit chest', state: buildSnapshot(bot, ctx) };
      }
      return {
        ok: false,
        reason: `world query failed checking deposit chest: ${errorMessage(err)}`,
        state: buildSnapshot(bot, ctx),
      };
    }
    if (!chestBlock || !CHEST_NAMES.has(chestBlock.name)) {
      return { ok: false, reason: 'chest no longer present at locked position', state: buildSnapshot(bot, ctx) };
    }

    try {
      chest = await openContainer(bot, chestBlock, {
        skill: 'deposit',
        position: positionForLog(s.lockedChestPos),
      }, { signal: ctx.signal });
    } catch (err) {
      if (ctx.signal?.aborted) {
        return { preempted: true, reason: 'reactive preempt opening deposit chest', state: buildSnapshot(bot, ctx) };
      }
      return { ok: false, reason: `openContainer failed: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
    }

    // Deposit each remaining item, observing the abort signal between transfers.
    for (let i = 0; i < s.remainingItems.length; i++) {
      const want = s.remainingItems[i];
      if (!want || want._done) continue;
      if (ctx.signal?.aborted) break;

      const inventory = readBotInventoryItems(bot);
      if (!inventory.ok) {
        await closeChest();
        return { ok: false, reason: `inventory unavailable during deposit transfer: ${inventory.error}`, state: buildSnapshot(bot, ctx) };
      }
      const items = inventory.items.filter((it) => it.name === want.name);
      let remaining = want.count ?? items.reduce((sum, it) => sum + it.count, 0);
      for (const it of items) {
        if (remaining <= 0) break;
        if (ctx.signal?.aborted) break;
        const n = Math.min(it.count, remaining);
        try {
          await depositContainer(chest, it.type, null, n, {
            skill: 'deposit',
            item: want.name,
            count: n,
            position: positionForLog(s.lockedChestPos),
          }, { signal: ctx.signal });
          s.transferred.push({ name: want.name, count: n });
          remaining -= n;
          if (want.count !== undefined) want.count = remaining;
        } catch (err) {
          await closeChest();
          if (ctx.signal?.aborted) {
            return { preempted: true, reason: 'reactive preempt during deposit transfer', state: buildSnapshot(bot, ctx) };
          }
          return { ok: false, reason: `chest.deposit failed for ${want.name}: ${err.message}`, state: buildSnapshot(bot, ctx) };
        }
      }

      if (remaining > 0 && want.count !== undefined && !ctx.signal?.aborted) {
        await closeChest();
        return { ok: false, reason: `not enough ${want.name} (short by ${remaining})`, state: buildSnapshot(bot, ctx) };
      }
      if (!ctx.signal?.aborted) want._done = true;
    }

    recordStorageMemory(ctx, worldModel, chestBlock, chest);
    await closeChest();

    if (ctx.signal?.aborted) {
      return { preempted: true, reason: 'reactive preempt during deposit transfer', state: buildSnapshot(bot, ctx) };
    }

    const summary = s.transferred.map((t) => `${t.count} ${t.name}`).join(', ') || 'nothing';
    return { ok: true, reason: `deposited ${summary}`, state: buildSnapshot(bot, ctx) };
  } finally {
    await closeChest();
    releasePathfinder(acq, { skill: 'deposit' });
  }
}

function recordStorageMemory(ctx, worldModel, chestBlock, chest) {
  if (!worldModel) return;
  try {
    const sighting = observeStorageContents(worldModel, chestBlock, chest);
    if (sighting && ctx.worldModelStore?.save) ctx.worldModelStore.save(worldModel);
  } catch (err) {
    log.executor.warn('deposit.storage-memory-failed', { err: err?.message || String(err) });
  }
}

function findNearestChest(bot, maxDistance, opts = {}) {
  const mcData = bot.registry;
  const ids = [];
  for (const n of CHEST_NAMES) {
    const b = mcData?.blocksByName?.[n];
    if (b) ids.push(b.id);
  }
  if (ids.length === 0) return { block: null, protected: 0 };
  let positions;
  try {
    positions = bot.findBlocks({ matching: ids, maxDistance, count: 32 });
  } catch (err) {
    return depositChestScanFailure(opts, err);
  }
  let protectedCount = 0;
  for (const position of positions) {
    let block;
    try {
      block = bot.blockAt(position);
    } catch (err) {
      return depositChestScanFailure(opts, err);
    }
    if (!block || !CHEST_NAMES.has(block.name)) continue;
    const policy = depositTargetPolicy(block.position, opts);
    if (!policy.ok) {
      protectedCount += 1;
      continue;
    }
    return { block, protected: protectedCount };
  }
  return { block: null, protected: protectedCount };
}

function depositTargetPolicy(position, opts = {}) {
  if (!opts.worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(opts.worldModel, position, { margin: opts.doNotTouchMargin ?? 0 });
}

function depositChestScanFailure(opts, err) {
  if (opts.signal?.aborted) return { preempted: true, reason: 'reactive preempt during deposit chest scan' };
  return { error: err };
}

function firstUnknownDepositItem(bot, wanted) {
  const itemsByName = bot?.registry?.itemsByName;
  if (!hasLoadedItemRegistry(itemsByName)) return null;
  for (const item of wanted) {
    if (!item?.name || !hasRegistryItem(itemsByName, item.name)) return item?.name || 'unknown';
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

function positionForLog(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function errorMessage(err) {
  return err?.message || String(err);
}
