// collect — mine N of a block type. Per decision (1) this skill is FUNGIBLE:
// when reactive interrupts the same target ~3 times, the target is excluded
// and a new one is chosen. Reaching a new target resets the counter. Real
// failure (no targets left) escalates to the advisor.
//
// callState shape:
//   {
//     collectedSoFar:   number,                // toward params.count
//     currentTarget:    Vec3 | null,           // the block we're working on
//     lastCollectedTarget: Vec3 | null,         // cluster anchor for next pick
//     interruptsOnCurrent: number,             // preempts against currentTarget
//     excluded:         Set<string>,           // posKey() of targets past threshold
//   }

import pkgPathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import config from '../config.js';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { readBotInventoryCounts } from '../state/materials.js';
import { blockModificationPolicy } from '../state/world_model.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import { applyHazardMovementPolicy, applyWorldModelMovementPolicy, awaitCollectBlock, pathingFailureReason, posKey, worldModelFromContext } from './_pathing.js';
import { acquirePathfinder, releasePathfinder } from './_ownership.js';

const { Movements } = pkgPathfinder;
const LOG_CLUSTER_MAX_BLOCKS = 96;
const LOG_CLUSTER_MAX_RADIUS = 12;
const DEFAULT_PICKUP_WAIT_MS = 1500;
const FAST_DIG_PICKUP_WAIT_MS = 150;
const FAST_DIG_POST_PICKUP_WAIT_MS = 900;
const FAST_DIG_DROP_SEARCH_RADIUS = 5;
const FAST_DIG_DROP_APPEAR_MS = 900;
const FAST_DIG_DROP_APPEAR_POLL_MS = 50;
const FAST_DIG_DROP_NUDGE_MS = 1200;
const FAST_DIG_DROP_NUDGE_INTERVAL_MS = 100;
const FAST_DIG_DROP_CLOSE_DISTANCE = 0.35;
const LOG_CLUSTER_NEIGHBORS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]);

export async function run(bot, params, ctx) {
  const blockName = params.block;
  const goal = params.count;
  const maxDistance = params.maxDistance ?? 64;
  const progressItems = normalizeProgressItems(params.progressItems, blockName);
  const finishActiveLogCluster = params.finishTree !== false && isTreeLogBlock(blockName);
  const threshold = config.reactive?.maxInterruptionsPerTarget ?? 3;
  const mcData = bot.registry;
  const blockType = mcData?.blocksByName?.[blockName];
  if (!blockType) {
    return { ok: false, reason: `unknown block "${blockName}"`, state: buildSnapshot(bot, ctx) };
  }

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for collect chunk readiness');
  if (chunks.preempted) return { preempted: true, reason: chunks.reason, state: buildSnapshot(bot, ctx) };
  if (chunks.error) return { ok: false, reason: `chunk data unavailable during collect: ${errorMessage(chunks.error)}`, state: buildSnapshot(bot, ctx) };

  const worldModelResult = worldModelFromContext(ctx);
  if (worldModelResult.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during collect: ${worldModelResult.error.message}`,
      state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
    };
  }
  const worldModel = worldModelResult.model;

  const s = ctx.callState;
  if (s.collectedSoFar === undefined) s.collectedSoFar = 0;
  if (s.currentTarget === undefined) s.currentTarget = null;
  if (s.lastCollectedTarget === undefined) s.lastCollectedTarget = null;
  if (s.interruptsOnCurrent === undefined) s.interruptsOnCurrent = 0;
  if (s.activeLogCluster === undefined) s.activeLogCluster = null;
  if (!s.excluded) s.excluded = new Set();

  while (true) {
    if (maybeFinishSatisfiedLogCleanupForBudget(s, goal, ctx, params)) break;
    if (s.collectedSoFar >= goal && !(finishActiveLogCluster && s.activeLogCluster)) break;
    if (ctx.signal?.aborted) {
      return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };
    }

    // Pick or reuse a target.
    let target = null;
    if (s.currentTarget) {
      let b;
      try {
        b = bot.blockAt(s.currentTarget);
      } catch (err) {
        return worldQueryFailure(bot, ctx, 'collect target validation', err);
      }
      const policy = collectModificationPolicy(s.currentTarget, {
        supportPosition: supportUnderPosition(bot.entity?.position),
        worldModel,
      });
      if (b && b.name === blockName && !s.excluded.has(posKey(s.currentTarget)) && policy.ok) {
        target = b;
      } else {
        // Target dissolved (mined out by us last time or by environment). Reset.
        if (b && b.name === blockName && !policy.ok) {
          log.executor.warn('collect.protected-target', {
            pos: s.currentTarget,
            reason: policy.reason,
            region: policy.region?.id,
          });
        }
        if (s.activeLogCluster) s.activeLogCluster.keys.delete(posKey(s.currentTarget));
        s.currentTarget = null;
        s.interruptsOnCurrent = 0;
      }
    }
    if (!target) {
      if (finishActiveLogCluster && s.activeLogCluster) {
        const activeCandidate = chooseActiveLogClusterCandidate(bot, blockName, s, {
          excluded: s.excluded,
          origin: bot.entity?.position,
          supportPosition: supportUnderPosition(bot.entity?.position),
          worldModel,
        });
        if (activeCandidate.error) return worldQueryFailure(bot, ctx, 'collect active tree scan', activeCandidate.error);
        if (activeCandidate.candidate) {
          if (activeCandidate.deferredSupport) {
            log.executor.info('collect.tree.support-target', {
              pos: activeCandidate.candidate,
              reason: 'only remembered log remains under bot',
            });
          }
          try {
            target = bot.blockAt(activeCandidate.candidate);
          } catch (err) {
            return worldQueryFailure(bot, ctx, 'collect active tree scan', err);
          }
          if (target) {
            s.currentTarget = clonePosition(target.position);
            s.interruptsOnCurrent = 0;
          }
        } else {
          finishLogCluster(s, 'exhausted');
          if (s.collectedSoFar >= goal) break;
        }
      }
    }
    if (!target) {
      let positions;
      try {
        positions = bot.findBlocks({ matching: blockType.id, maxDistance, count: 32 });
      } catch (err) {
        return worldQueryFailure(bot, ctx, 'collect block scan', err);
      }
      let candidate = chooseCollectCandidate(positions, {
        excluded: s.excluded,
        origin: bot.entity?.position,
        supportPosition: supportUnderPosition(bot.entity?.position),
        clusterOrigin: s.lastCollectedTarget,
        clusterRadius: params.clusterRadius ?? 2.5,
        worldModel,
      });
      if (!candidate) {
        const stats = collectCandidateStats(positions, {
          excluded: s.excluded,
          supportPosition: supportUnderPosition(bot.entity?.position),
          worldModel,
        });
        const protectedReason = stats.protected > 0 ? `, protected ${stats.protected}` : '';
        const supportReason = stats.support > 0 ? `, supporting-bot ${stats.support}` : '';
        return {
          ok: false,
          reason: `no more ${blockName} within ${maxDistance} blocks (have ${s.collectedSoFar}/${goal}, excluded ${s.excluded.size}${protectedReason}${supportReason})`,
          state: buildSnapshot(bot, ctx),
        };
      }
      if (finishActiveLogCluster) {
        const cluster = discoverLogCluster(bot, blockName, candidate, {
          maxBlocks: params.treeClusterMaxBlocks ?? LOG_CLUSTER_MAX_BLOCKS,
          maxRadius: params.treeClusterMaxRadius ?? LOG_CLUSTER_MAX_RADIUS,
        });
        s.activeLogCluster = cluster;
        log.executor.info('collect.tree.start', {
          block: blockName,
          anchor: cluster.anchor,
          size: cluster.keys.size,
          truncated: cluster.truncated,
        });
        const activeCandidate = chooseActiveLogClusterCandidate(bot, blockName, s, {
          excluded: s.excluded,
          origin: bot.entity?.position,
          supportPosition: supportUnderPosition(bot.entity?.position),
          worldModel,
        });
        if (activeCandidate.error) return worldQueryFailure(bot, ctx, 'collect active tree scan', activeCandidate.error);
        if (activeCandidate.deferredSupport && activeCandidate.candidate) {
          log.executor.info('collect.tree.support-target', {
            pos: activeCandidate.candidate,
            reason: 'only remembered log remains under bot',
          });
        }
        candidate = activeCandidate.candidate || candidate;
      }
      try {
        target = bot.blockAt(candidate);
      } catch (err) {
        return worldQueryFailure(bot, ctx, 'collect block scan', err);
      }
      if (!target) {
        // Shouldn't happen but defensive.
        s.excluded.add(posKey(candidate));
        continue;
      }
      s.currentTarget = clonePosition(target.position);
      s.interruptsOnCurrent = 0;
    }

    // Acquire pathfinder token. If reactive holds it, return preempted; the
    // executor will resume us after quiescence.
    const acquired = acquirePathfinder(bot, 'collect', { skill: 'collect' });
    if (!acquired.ok) {
      return { ok: false, reason: `pathfinder acquire failed during collect: ${acquired.message}`, state: buildSnapshot(bot, ctx) };
    }
    const acq = acquired.acq;
    if (!acq) {
      return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };
    }

    let haveBefore = 0;
    let outcome;
    try {
      // Snapshot inventory count BEFORE the collect so we can measure the delta.
      const before = countProgressInventory(bot, progressItems);
      if (!before.ok) {
        return {
          ok: false,
          reason: `inventory unavailable during collect progress check: ${before.error}`,
          state: buildSnapshot(bot, ctx),
        };
      }
      haveBefore = before.count;

      log.executor.info('collect.target', { pos: s.currentTarget, sofar: s.collectedSoFar, goal, progressItems });
      const movementPolicy = configureCollectMovements(bot, ctx, worldModel);
      if (!movementPolicy.ok) {
        const stateCtx = movementPolicy.worldModelError ? { ...ctx, worldModelStore: null } : ctx;
        return {
          ok: false,
          reason: `${movementPolicy.reason}: ${errorMessage(movementPolicy.error)}`,
          state: buildSnapshot(bot, stateCtx),
        };
      }
      const cleanupTargetTimeoutMs = cleanupAfterGoalTargetTimeoutMs(s, goal, ctx, params);
      outcome = await awaitCollectBlock(bot, target, ctx.signal, {
        ownerToken: acq.token,
        ...(cleanupTargetTimeoutMs !== null
          ? { targetTimeoutMs: cleanupTargetTimeoutMs }
          : {}),
        ...(ctx.collectWatchdog || {}),
      });
    } finally {
      releasePathfinder(acq, { skill: 'collect' });
    }

    if (outcome.kind === 'preempted') {
      s.interruptsOnCurrent += 1;
      if (s.interruptsOnCurrent >= threshold) {
        log.executor.warn('collect.exclude-target', {
          pos: s.currentTarget,
          interrupts: s.interruptsOnCurrent,
          threshold,
        });
        s.excluded.add(posKey(s.currentTarget));
        s.currentTarget = null;
        s.interruptsOnCurrent = 0;
      }
      return { preempted: true, reason: 'reactive preempt during collect', state: buildSnapshot(bot, ctx) };
    }

    if (outcome.kind === 'error') {
      if (isTargetLevelCollectPathingError(outcome.err)) {
        const reason = errorMessage(outcome.err);
        log.executor.warn('collect.exclude-target', {
          pos: s.currentTarget,
          reason: 'collectBlock pathing error',
          pathing: reason,
        });
        s.excluded.add(posKey(s.currentTarget));
        if (s.activeLogCluster) s.activeLogCluster.keys.delete(posKey(s.currentTarget));
        s.currentTarget = null;
        s.interruptsOnCurrent = 0;
        if (maybeFinishSatisfiedLogCleanup(s, goal, params, reason)) break;
        continue;
      }
      return {
        ok: false,
        reason: `collectBlock error: ${outcome.err?.message || outcome.err}`,
        state: buildSnapshot(bot, ctx),
      };
    }

    if (outcome.kind === 'waterStall') {
      return {
        ok: false,
        reason: `water progress stalled during collect (${outcome.stuckMs}ms, oxygen=${outcome.oxygenLevel ?? 'unknown'})`,
        state: buildSnapshot(bot, ctx),
      };
    }

    if (outcome.kind === 'stuck') {
      const reason = pathingFailureReason(outcome);
      log.executor.warn('collect.exclude-target', {
        pos: s.currentTarget,
        reason: 'stuck',
        pathing: reason,
      });
      s.excluded.add(posKey(s.currentTarget));
      if (s.activeLogCluster) s.activeLogCluster.keys.delete(posKey(s.currentTarget));
      s.currentTarget = null;
      s.interruptsOnCurrent = 0;
      if (maybeFinishSatisfiedLogCleanup(s, goal, params, reason)) break;
      continue;
    }

    if (outcome.kind === 'targetTimeout') {
      const reason = pathingFailureReason(outcome);
      log.executor.warn('collect.exclude-target', {
        pos: s.currentTarget,
        reason: 'target-timeout',
        pathing: reason,
      });
      s.excluded.add(posKey(s.currentTarget));
      if (s.activeLogCluster) s.activeLogCluster.keys.delete(posKey(s.currentTarget));
      s.currentTarget = null;
      s.interruptsOnCurrent = 0;
      if (maybeFinishSatisfiedLogCleanup(s, goal, params, reason)) break;
      continue;
    }

    // outcome.kind === 'completed'
    // Pickup happens via item-drop entities and can lag the dig completion
    // briefly. Give it a moment, then measure delta against the pre-call count.
    const pickupWaitMs = outcome.mode === 'fastDig'
      ? positiveFiniteNumber(params.fastDigPickupWaitMs ?? config.executor?.fastDigPickupWaitMs ?? FAST_DIG_PICKUP_WAIT_MS)
      : positiveFiniteNumber(params.pickupWaitMs ?? config.executor?.collectPickupWaitMs ?? DEFAULT_PICKUP_WAIT_MS);
    let after = await waitForInventoryDelta(bot, progressItems, haveBefore, pickupWaitMs ?? DEFAULT_PICKUP_WAIT_MS, ctx.signal);
    if (after.preempted) {
      return { preempted: true, reason: 'reactive preempt during collect inventory wait', state: buildSnapshot(bot, ctx) };
    }
    if (!after.ok) {
      return {
        ok: false,
        reason: `inventory unavailable during collect progress check: ${after.error}`,
        state: buildSnapshot(bot, ctx),
      };
    }
    let haveNow = after.count;
    let delta = haveNow - haveBefore;
    if (delta <= 0) {
      const pickup = await collectNearbyDropAfterDig(bot, s.currentTarget, ctx);
      log.executor.info(outcome.mode === 'fastDig' ? 'collect.fast-dig.pickup' : 'collect.drop-pickup', {
        pos: s.currentTarget,
        mode: outcome.mode ?? null,
        pickup,
      });
      if (pickup.preempted) {
        return { preempted: true, reason: pickup.reason || 'reactive preempt during collect drop pickup', state: buildSnapshot(bot, ctx) };
      }
      const postPickupWaitMs = positiveFiniteNumber(
        params.fastDigPostPickupWaitMs ?? config.executor?.fastDigPostPickupWaitMs ?? FAST_DIG_POST_PICKUP_WAIT_MS,
      );
      after = await waitForInventoryDelta(bot, progressItems, haveBefore, postPickupWaitMs ?? FAST_DIG_POST_PICKUP_WAIT_MS, ctx.signal);
      if (after.preempted) {
        return { preempted: true, reason: 'reactive preempt during collect inventory wait', state: buildSnapshot(bot, ctx) };
      }
      if (!after.ok) {
        return {
          ok: false,
          reason: `inventory unavailable during collect progress check: ${after.error}`,
          state: buildSnapshot(bot, ctx),
        };
      }
      haveNow = after.count;
      delta = haveNow - haveBefore;
    }
    if (delta > 0) {
      s.collectedSoFar += delta;
      s.lastCollectedTarget = clonePosition(s.currentTarget);
      if (s.activeLogCluster) s.activeLogCluster.keys.delete(posKey(s.currentTarget));
      s.currentTarget = null;
      s.interruptsOnCurrent = 0;
    } else {
      if (ctx.signal?.aborted) {
        return { preempted: true, reason: 'reactive preempt during collect inventory wait', state: buildSnapshot(bot, ctx) };
      }
      // The block broke but we got no item (spawn protection, full inventory,
      // dropped item despawned, etc). Treat as no-progress: exclude this
      // target so we don't loop on it.
      log.executor.warn('collect.no-drop', { pos: s.currentTarget, progressItems });
      s.excluded.add(posKey(s.currentTarget));
      if (s.activeLogCluster) s.activeLogCluster.keys.delete(posKey(s.currentTarget));
      s.currentTarget = null;
      s.interruptsOnCurrent = 0;
    }

    if (ctx.signal?.aborted) {
      return { preempted: true, reason: 'reactive preempt during collect inventory wait', state: buildSnapshot(bot, ctx) };
    }
  }

  return {
    ok: true,
    reason: `collected ${s.collectedSoFar} ${blockName}`,
    state: buildSnapshot(bot, ctx),
  };
}

function isTreeLogBlock(blockName) {
  return /(?:^|_)(log|stem|hyphae)$/.test(String(blockName || ''));
}

function discoverLogCluster(bot, blockName, anchor, opts = {}) {
  const maxBlocks = opts.maxBlocks ?? LOG_CLUSTER_MAX_BLOCKS;
  const maxRadius = opts.maxRadius ?? LOG_CLUSTER_MAX_RADIUS;
  const start = blockPosition(anchor);
  const queue = [start];
  const queued = new Set([posKey(start)]);
  const keys = new Set();
  let truncated = false;

  while (queue.length > 0) {
    if (keys.size >= maxBlocks) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    const key = posKey(current);
    let block = null;
    try {
      block = bot.blockAt(current);
    } catch {
      continue;
    }
    if (!block || block.name !== blockName) continue;
    keys.add(key);

    for (const [dx, dy, dz] of LOG_CLUSTER_NEIGHBORS) {
      const next = new Vec3(current.x + dx, current.y + dy, current.z + dz);
      const nextKey = posKey(next);
      if (queued.has(nextKey) || distance(next, start) > maxRadius) continue;
      queued.add(nextKey);
      queue.push(next);
    }
  }

  if (keys.size === 0) keys.add(posKey(start));
  return { block: blockName, anchor: start, keys, truncated };
}

function chooseActiveLogClusterCandidate(bot, blockName, s, opts = {}) {
  const cluster = s.activeLogCluster;
  if (!cluster?.keys?.size) return { candidate: null };
  const candidates = [];
  const supportCandidates = [];

  for (const key of [...cluster.keys]) {
    if (opts.excluded?.has?.(key)) {
      cluster.keys.delete(key);
      continue;
    }
    const position = positionFromKey(key);
    let block = null;
    try {
      block = bot.blockAt(position);
    } catch (err) {
      return { error: err };
    }
    if (!block || block.name !== blockName) {
      cluster.keys.delete(key);
      continue;
    }
    const candidate = blockPosition(block.position || position);
    const policy = collectModificationPolicy(candidate, opts);
    if (!policy.ok) {
      if (policy.kind === 'support') supportCandidates.push(candidate);
      continue;
    }
    candidates.push(candidate);
  }

  if (candidates.length === 0 && supportCandidates.length > 0) {
    return {
      candidate: sortLogClusterCandidates(supportCandidates, opts.origin, s.lastCollectedTarget || cluster.anchor)[0],
      deferredSupport: true,
    };
  }
  if (candidates.length === 0) return { candidate: null };
  return {
    candidate: sortLogClusterCandidates(candidates, opts.origin, s.lastCollectedTarget || cluster.anchor)[0],
  };
}

function finishLogCluster(s, reason) {
  if (!s.activeLogCluster) return;
  log.executor.info('collect.tree.complete', {
    block: s.activeLogCluster.block,
    anchor: s.activeLogCluster.anchor,
    remaining: s.activeLogCluster.keys?.size ?? 0,
    reason,
  });
  s.activeLogCluster = null;
}

function maybeFinishSatisfiedLogCleanup(s, goal, params = {}, failureReason = 'target failure') {
  if (!s.activeLogCluster || s.collectedSoFar < goal) return false;
  s.activeLogCluster.cleanupFailures = Number(s.activeLogCluster.cleanupFailures || 0) + 1;
  const limit = params.treeCleanupFailureLimit ?? config.executor?.collectTreeCleanupFailureLimit ?? 2;
  if (s.activeLogCluster.cleanupFailures < limit) return false;
  log.executor.warn('collect.tree.cleanup-abandoned', {
    block: s.activeLogCluster.block,
    anchor: s.activeLogCluster.anchor,
    remaining: s.activeLogCluster.keys?.size ?? 0,
    failures: s.activeLogCluster.cleanupFailures,
    goal,
    collectedSoFar: s.collectedSoFar,
    reason: failureReason,
  });
  finishLogCluster(s, 'cleanup-blocked-after-goal');
  return true;
}

function maybeFinishSatisfiedLogCleanupForBudget(s, goal, ctx, params = {}) {
  if (!s.activeLogCluster || s.collectedSoFar < goal) return false;
  const budget = satisfiedLogCleanupBudget(ctx, params);
  if (!budget.ok || budget.remainingMs > budget.minRemainingMs) return false;
  log.executor.warn('collect.tree.cleanup-abandoned', {
    block: s.activeLogCluster.block,
    anchor: s.activeLogCluster.anchor,
    remaining: s.activeLogCluster.keys?.size ?? 0,
    goal,
    collectedSoFar: s.collectedSoFar,
    reason: 'cleanup-budget-exhausted',
    remainingMs: budget.remainingMs,
    minRemainingMs: budget.minRemainingMs,
    skillTimeoutMs: budget.skillTimeoutMs,
    elapsedMs: budget.elapsedMs,
  });
  finishLogCluster(s, 'cleanup-budget-exhausted');
  return true;
}

function cleanupAfterGoalTargetTimeoutMs(s, goal, ctx, params = {}) {
  if (!s.activeLogCluster || s.collectedSoFar < goal) return null;
  const configured = params.treeCleanupTargetTimeoutMs ?? config.executor?.collectTreeCleanupTargetTimeoutMs ?? 30000;
  const timeoutMs = positiveFiniteNumber(configured);
  if (timeoutMs === null) return null;
  const budget = satisfiedLogCleanupBudget(ctx, params);
  if (!budget.ok) return timeoutMs;
  const usableMs = Math.floor(budget.remainingMs - budget.minRemainingMs);
  if (usableMs <= 0) return 1;
  return Math.max(1, Math.min(timeoutMs, usableMs));
}

function satisfiedLogCleanupBudget(ctx, params = {}) {
  const executorState = ctx?.callState?._executor;
  const startedAtMs = positiveFiniteNumber(executorState?.startedAtMs);
  const skillTimeoutMs = positiveFiniteNumber(params.skillTimeoutMs ?? config.executor?.skillTimeoutMs);
  const minRemainingMs = positiveFiniteNumber(
    params.treeCleanupMinRemainingMs ?? config.executor?.collectTreeCleanupMinRemainingMs ?? 15000,
  );
  if (startedAtMs === null || skillTimeoutMs === null || minRemainingMs === null) return { ok: false };
  const elapsedMs = Date.now() - startedAtMs;
  if (!Number.isFinite(elapsedMs)) return { ok: false };
  return {
    ok: true,
    elapsedMs,
    remainingMs: skillTimeoutMs - elapsedMs,
    minRemainingMs,
    skillTimeoutMs,
  };
}

function positiveFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function chooseCollectCandidate(positions, opts = {}) {
  const excluded = opts.excluded || new Set();
  const candidates = positions.filter((p) => (
    !excluded.has(posKey(p)) &&
    collectModificationPolicy(p, opts).ok
  ));
  if (candidates.length === 0) return null;

  const clusterOrigin = opts.clusterOrigin || null;
  const clusterRadius = opts.clusterRadius ?? 2.5;
  const origin = opts.origin || null;
  if (clusterOrigin) {
    const clustered = candidates.filter((p) => distance(p, clusterOrigin) <= clusterRadius);
    if (clustered.length > 0) {
      return sortByDistance(clustered, clusterOrigin, origin)[0];
    }
  }

  return sortByDistance(candidates, origin, null)[0];
}

function collectCandidateStats(positions, opts = {}) {
  const excluded = opts.excluded || new Set();
  let protectedCount = 0;
  let supportCount = 0;
  for (const p of positions) {
    if (excluded.has(posKey(p))) continue;
    const policy = collectModificationPolicy(p, opts);
    if (!policy.ok && policy.kind === 'support') supportCount++;
    else if (!policy.ok) protectedCount++;
  }
  return { protected: protectedCount, support: supportCount };
}

function collectModificationPolicy(position, opts = {}) {
  const supportPosition = opts.supportPosition || supportUnderPosition(opts.origin);
  if (sameBlock(position, supportPosition)) {
    return { ok: false, action: 'deny', kind: 'support', reason: 'target supports current bot position' };
  }
  if (!opts.worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(opts.worldModel, position, { margin: opts.doNotTouchMargin ?? 0 });
}

function configureCollectMovements(bot, ctx, worldModel) {
  if (!bot.collectBlock) return { ok: true };
  let movements = bot.collectBlock.movements;
  if (!movements) {
    try {
      movements = new Movements(bot);
    } catch (err) {
      log.executor.warn('collect.movements-error', { err: errorMessage(err) });
      return { ok: false, reason: 'collect movement setup failed', error: err };
    }
  }
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  if (Array.isArray(movements.scafoldingBlocks)) movements.scafoldingBlocks = [];
  applyHazardMovementPolicy(movements, bot);
  if (worldModel) {
    const policy = applyWorldModelMovementPolicy(movements, ctx, { worldModel });
    if (!policy.ok) {
      return {
        ...policy,
        reason: 'world-model movement policy unavailable during collect',
        worldModelError: true,
      };
    }
  }
  bot.collectBlock.movements = movements;
  return { ok: true };
}

function normalizeProgressItems(value, fallback) {
  const raw = Array.isArray(value) ? value : [value || fallback];
  const names = raw
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  return names.length > 0 ? [...new Set(names)] : [fallback];
}

function countProgressInventory(bot, names) {
  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) return { ok: false, count: 0, error: inventory.error };
  return {
    ok: true,
    count: names.reduce((sum, name) => sum + (inventory.inventory[name] || 0), 0),
  };
}

async function waitForInventoryDelta(bot, names, baseline, maxMs, signal) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const current = countProgressInventory(bot, names);
    if (!current.ok) return signal?.aborted ? { preempted: true } : current;
    if (current.count > baseline) return current;
    if (signal?.aborted) return { preempted: true };
    await new Promise((r) => setTimeout(r, 50));
  }
  const current = countProgressInventory(bot, names);
  if (!current.ok) return signal?.aborted ? { preempted: true } : current;
  if (signal?.aborted && current.count <= baseline) return { preempted: true };
  return current;
}

async function collectNearbyDropAfterDig(bot, targetPosition, ctx) {
  const found = await waitForNearbyDroppedItemEntity(bot, targetPosition, ctx.signal, {
    radius: FAST_DIG_DROP_SEARCH_RADIUS,
    maxMs: FAST_DIG_DROP_APPEAR_MS,
    intervalMs: FAST_DIG_DROP_APPEAR_POLL_MS,
  });
  if (found.preempted) return found;
  const entity = found.entity;
  if (!entity) return { ok: false, reason: 'no nearby dropped item entity', waitedMs: found.waitedMs };

  const local = await nudgeTowardDroppedItem(bot, targetPosition, ctx.signal, {
    radius: FAST_DIG_DROP_SEARCH_RADIUS,
    maxMs: FAST_DIG_DROP_NUDGE_MS,
    intervalMs: FAST_DIG_DROP_NUDGE_INTERVAL_MS,
    closeDistance: FAST_DIG_DROP_CLOSE_DISTANCE,
  });
  if (local.preempted || local.ok) return local;
  const fallbackEntity = nearestDroppedItemEntity(bot, targetPosition, FAST_DIG_DROP_SEARCH_RADIUS) || entity;

  const acquired = acquirePathfinder(bot, 'collect-drop', { skill: 'collect', phase: 'pickup-drop' });
  if (!acquired.ok) return { ok: false, reason: `pathfinder acquire failed during collect drop pickup: ${acquired.message}` };
  const acq = acquired.acq;
  if (!acq) return { preempted: true, reason: 'reactive holds pathfinder during collect drop pickup' };

  try {
    const outcome = await awaitCollectBlock(bot, fallbackEntity, ctx.signal, {
      ownerToken: acq.token,
      fastDig: false,
      targetTimeoutMs: 2000,
      pathStallMs: 2000,
      watchdogIntervalMs: 100,
    });
    return {
      ok: outcome.kind === 'completed',
      kind: outcome.kind,
      reason: pathingFailureReason(outcome),
      local,
      appearWaitMs: found.waitedMs,
      entityId: fallbackEntity.id ?? null,
      entityName: fallbackEntity.name ?? null,
      position: fallbackEntity.position ? clonePosition(fallbackEntity.position) : null,
    };
  } finally {
    releasePathfinder(acq, { skill: 'collect', phase: 'pickup-drop' });
  }
}

async function nudgeTowardDroppedItem(bot, targetPosition, signal, opts = {}) {
  const startedAtMs = Date.now();
  const maxMs = opts.maxMs ?? FAST_DIG_DROP_NUDGE_MS;
  const intervalMs = opts.intervalMs ?? FAST_DIG_DROP_NUDGE_INTERVAL_MS;
  const closeDistance = opts.closeDistance ?? FAST_DIG_DROP_CLOSE_DISTANCE;
  let seen = 0;
  let lastEntityId = null;
  let lastDistance = null;
  try {
    while (Date.now() - startedAtMs < maxMs) {
      if (signal?.aborted) return { preempted: true, reason: 'reactive preempt during local drop pickup' };
      const entity = nearestDroppedItemEntity(bot, targetPosition, opts.radius ?? FAST_DIG_DROP_SEARCH_RADIUS);
      if (!entity) {
        return {
          ok: true,
          kind: 'localNudge',
          reason: 'item entity gone',
          seen,
          elapsedMs: Date.now() - startedAtMs,
          lastEntityId,
          lastDistance,
        };
      }

      seen += 1;
      lastEntityId = entity.id ?? null;
      lastDistance = bot.entity?.position ? distance(bot.entity.position, entity.position) : null;
      if (Number.isFinite(lastDistance) && lastDistance <= closeDistance) {
        setPickupControl(bot, 'forward', false);
        setPickupControl(bot, 'sprint', false);
        setPickupControl(bot, 'jump', false);
        await sleep(intervalMs, signal);
        continue;
      }

      await lookAtPickupTarget(bot, entity.position, signal);
      setPickupControl(bot, 'sprint', false);
      setPickupControl(bot, 'forward', true);
      setPickupControl(bot, 'jump', shouldJumpTowardDrop(bot, entity));
      await sleep(intervalMs, signal);
    }
  } finally {
    setPickupControl(bot, 'forward', false);
    setPickupControl(bot, 'sprint', false);
    setPickupControl(bot, 'jump', false);
  }

  return {
    ok: false,
    kind: 'localNudge',
    reason: 'item entity still nearby',
    seen,
    elapsedMs: Date.now() - startedAtMs,
    lastEntityId,
    lastDistance,
  };
}

async function waitForNearbyDroppedItemEntity(bot, targetPosition, signal, opts = {}) {
  const startedAtMs = Date.now();
  const maxMs = opts.maxMs ?? FAST_DIG_DROP_APPEAR_MS;
  const intervalMs = opts.intervalMs ?? FAST_DIG_DROP_APPEAR_POLL_MS;
  while (Date.now() - startedAtMs <= maxMs) {
    if (signal?.aborted) {
      return { preempted: true, reason: 'reactive preempt during dropped item lookup', waitedMs: Date.now() - startedAtMs };
    }
    const entity = nearestDroppedItemEntity(bot, targetPosition, opts.radius ?? FAST_DIG_DROP_SEARCH_RADIUS);
    if (entity) return { entity, waitedMs: Date.now() - startedAtMs };
    await sleep(intervalMs, signal);
  }
  return { entity: null, waitedMs: Date.now() - startedAtMs };
}

function nearestDroppedItemEntity(bot, targetPosition, maxDistance) {
  if (!targetPosition || !bot.entities) return null;
  const center = new Vec3(targetPosition.x + 0.5, targetPosition.y + 0.5, targetPosition.z + 0.5);
  const candidates = Object.values(bot.entities)
    .filter((entity) => isDroppedItemEntity(entity) && entity.position && distance(entity.position, center) <= maxDistance)
    .sort((a, b) => (
      distance(a.position, center) - distance(b.position, center) ||
      String(a.id ?? '').localeCompare(String(b.id ?? ''))
    ));
  return candidates[0] || null;
}

function isDroppedItemEntity(entity) {
  return entity?.name === 'item' ||
    entity?.displayName === 'Item';
}

async function lookAtPickupTarget(bot, position, signal) {
  if (!position) return;
  const target = new Vec3(Number(position.x), Number(position.y) + 0.25, Number(position.z));
  if (typeof bot.humanizer?.lookAt === 'function') {
    await bot.humanizer.lookAt(bot, target, {
      reason: 'collect.fast-dig.pickup-look',
      critical: true,
      signal,
      force: true,
    });
    return;
  }
  await bot.lookAt?.(target, true);
}

function setPickupControl(bot, control, value) {
  if (typeof bot.humanizer?.setControlState === 'function') {
    return bot.humanizer.setControlState(bot, control, value, {
      reason: `collect.fast-dig.pickup-${control}`,
      critical: true,
    });
  }
  return bot.setControlState?.(control, value);
}

function shouldJumpTowardDrop(bot, entity) {
  const botY = Number(bot.entity?.position?.y);
  const entityY = Number(entity?.position?.y);
  return Number.isFinite(botY) && Number.isFinite(entityY) && entityY - botY > 0.6;
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

function sortByDistance(positions, origin, secondaryOrigin) {
  return [...positions].sort((a, b) => (
    distanceOrZero(a, origin) - distanceOrZero(b, origin) ||
    distanceOrZero(a, secondaryOrigin) - distanceOrZero(b, secondaryOrigin) ||
    posKey(a).localeCompare(posKey(b))
  ));
}

function sortLogClusterCandidates(positions, origin, secondaryOrigin) {
  return [...positions].sort((a, b) => (
    a.y - b.y ||
    distanceOrZero(a, origin) - distanceOrZero(b, origin) ||
    distanceOrZero(a, secondaryOrigin) - distanceOrZero(b, secondaryOrigin) ||
    posKey(a).localeCompare(posKey(b))
  ));
}

function distanceOrZero(a, b) {
  return b ? distance(a, b) : 0;
}

function distance(a, b) {
  return Math.sqrt(
    (a.x - b.x) ** 2 +
    (a.y - b.y) ** 2 +
    (a.z - b.z) ** 2
  );
}

function clonePosition(p) {
  return p?.clone ? p.clone() : { x: p.x, y: p.y, z: p.z };
}

function blockPosition(p) {
  return new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
}

function positionFromKey(key) {
  const [x, y, z] = String(key).split(',').map(Number);
  return new Vec3(x, y, z);
}

function supportUnderPosition(position) {
  if (!position) return null;
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y - 0.01),
    z: Math.floor(position.z),
  };
}

function sameBlock(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function isTargetLevelCollectPathingError(err) {
  const message = errorMessage(err);
  return /took\s+too?\s+long\s+to\s+decide\s+path\s+to\s+goal/i.test(message) ||
    /digging aborted/i.test(message) ||
    /no path/i.test(message) ||
    /path to goal/i.test(message);
}

function worldQueryFailure(bot, ctx, phase, err) {
  if (ctx.signal?.aborted) {
    return { preempted: true, reason: `reactive preempt during ${phase}`, state: buildSnapshot(bot, ctx) };
  }
  return {
    ok: false,
    reason: `world query failed during ${phase}: ${errorMessage(err)}`,
    state: buildSnapshot(bot, ctx),
  };
}

function errorMessage(err) {
  return err?.message || String(err);
}
