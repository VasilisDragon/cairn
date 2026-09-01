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
import { toVec3 } from '../state/positions.js';
import { blockModificationPolicy } from '../state/world_model.js';
import {
  authorizeBlockBreak,
  revokeWorldActionAnchor,
} from '../state/world_action_authorization.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import { recoverToSurface } from '../runtime/recover_to_surface.js';
import { applyHazardMovementPolicy, applyWorldModelMovementPolicy, awaitCollectBlock, pathingFailureReason, posKey, worldModelFromContext } from './_pathing.js';
import { acquirePathfinder, releasePathfinder } from './_ownership.js';
import { nudgeTowardItemEntity } from './item_pickup.js';

const { Movements, goals: pathfinderGoals = {} } = pkgPathfinder;
const { GoalGetToBlock } = pathfinderGoals;
const LOG_CLUSTER_MAX_BLOCKS = 96;
const LOG_CLUSTER_MAX_RADIUS = 12;
const SURFACE_REACHABILITY_PROBE_COUNT = 8;
const SURFACE_REACHABILITY_PROBE_TIMEOUT_MS = 500;
const SURFACE_REACHABILITY_VERTICAL_TOLERANCE = 2;
const SHAFT_MINING_SUGGESTION = 'shaft_mining';
const SURFACE_PASSABLE_BLOCKS = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'tall_grass',
  'short_grass',
  'grass',
  'fern',
  'large_fern',
  'vine',
  'snow',
]);
const DEFAULT_PICKUP_WAIT_MS = 1500;
const FAST_DIG_PICKUP_WAIT_MS = 150;
const FAST_DIG_POST_PICKUP_WAIT_MS = 900;
const FAST_DIG_DROP_SEARCH_RADIUS = 5;
const FAST_DIG_DROP_APPEAR_MS = 900;
const FAST_DIG_DROP_APPEAR_POLL_MS = 50;
const FAST_DIG_DROP_NUDGE_MS = 1200;
const FAST_DIG_DROP_NUDGE_INTERVAL_MS = 100;
const FAST_DIG_DROP_CLOSE_DISTANCE = 0.35;
const COLLECT_BLOCK_DROP_APPEAR_MS = 3000;
const COLLECT_BLOCK_DROP_NUDGE_MS = 3500;
const COLLECT_BLOCK_DROP_FALLBACK_TIMEOUT_MS = 5000;
const COLLECT_BLOCK_POST_PICKUP_WAIT_MS = 2500;
const TREE_CLEANUP_AFTER_GOAL_PICKUP_WAIT_MS = 500;
const TREE_CLUSTER_CLEANUP_MULTIPLIER = 1.5;
const LOG_COLLECTION_MOVEMENT_POLICY = Symbol('logCollectionMovementPolicy');
const LOG_COLLECTION_OBSTRUCTION_COST = 100;
const LOG_CLUSTER_NEIGHBORS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]);
const DROP_SOURCE_CACHE = new WeakMap();

export async function run(bot, params, ctx) {
  const requestedName = params.block;
  const goal = params.count;
  const maxDistance = params.maxDistance ?? 64;
  const mcData = bot.registry;
  const targetResolution = resolveCollectTarget(mcData, requestedName, params);
  if (!targetResolution.ok) {
    return { ok: false, reason: targetResolution.reason, state: buildSnapshot(bot, ctx) };
  }
  const blockName = targetResolution.sourceBlock.name;
  const blockType = targetResolution.sourceBlock;
  const progressItems = targetResolution.progressItems;
  const finishActiveLogCluster = params.finishTree !== false && isTreeLogBlock(blockName);
  const threshold = config.reactive?.maxInterruptionsPerTarget ?? 3;
  if (targetResolution.sourceBlock.name !== targetResolution.requested) {
    log.executor.info('collect.drop-source', {
      requested: targetResolution.requested,
      sourceBlock: targetResolution.sourceBlock.name,
      progressItems,
      candidates: targetResolution.candidates,
      reason: targetResolution.reason,
    });
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
  const protectedPositions = collectProtectedPositionsFromContext(ctx);

  const s = ctx.callState;
  if (s.collectedSoFar === undefined) s.collectedSoFar = 0;
  if (s.currentTarget === undefined) s.currentTarget = null;
  if (s.lastCollectedTarget === undefined) s.lastCollectedTarget = null;
  if (s.interruptsOnCurrent === undefined) s.interruptsOnCurrent = 0;
  if (s.activeLogCluster === undefined) s.activeLogCluster = null;
  if (!s.excluded) s.excluded = new Set();

  while (true) {
    if (maybeFinishSatisfiedLogCleanupForBudget(s, goal, ctx, params)) break;
    if (maybeFinishSatisfiedLogCleanupForCap(s, goal, finishActiveLogCluster, params)) break;
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
        protectedPositions,
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
          protectedPositions,
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
            s.currentTarget = toVec3(target.position);
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
      const selection = await chooseCollectCandidateForRun(bot, positions, {
        excluded: s.excluded,
        origin: bot.entity?.position,
        supportPosition: supportUnderPosition(bot.entity?.position),
        clusterOrigin: s.lastCollectedTarget,
        clusterRadius: params.clusterRadius ?? 2.5,
        protectedPositions,
        worldModel,
        requestedName,
        blockName,
        progressItems,
        maxDistance,
        previousTarget: s.lastCollectedTarget,
        preventSameColumnDescent: params.allowBuriedTargets !== true && !finishActiveLogCluster,
        maxTargetY: params.maxTargetY,
        reachabilityProbeCount: params.reachabilityProbeCount ?? SURFACE_REACHABILITY_PROBE_COUNT,
        reachabilityProbeTimeoutMs: params.reachabilityProbeTimeoutMs ?? SURFACE_REACHABILITY_PROBE_TIMEOUT_MS,
        surfaceVerticalTolerance: params.surfaceVerticalTolerance ?? SURFACE_REACHABILITY_VERTICAL_TOLERANCE,
        allowBuriedTargets: params.allowBuriedTargets === true,
      });
      if (selection.error) return worldQueryFailure(bot, ctx, 'collect target reachability scan', selection.error);
      if (selection.shaftMiningRequired) {
        return {
          ok: false,
          reason: selection.reason,
          diagnostic: selection.diagnostic,
          state: buildSnapshot(bot, ctx),
        };
      }
      let candidate = selection.candidate;
      if (!candidate) {
        const stats = collectCandidateStats(positions, {
          excluded: s.excluded,
          supportPosition: supportUnderPosition(bot.entity?.position),
          protectedPositions,
          worldModel,
          maxTargetY: params.maxTargetY,
        });
        const protectedReason = stats.protected > 0 ? `, protected ${stats.protected}` : '';
        const supportReason = stats.support > 0 ? `, supporting-bot ${stats.support}` : '';
        const verticalReason = stats.aboveMaxTargetY > 0 ? `, above maxTargetY ${stats.aboveMaxTargetY}` : '';
        const sourcePhrase = blockName === requestedName ? blockName : `${blockName} for ${requestedName}`;
        return {
          ok: false,
          reason: `no more ${sourcePhrase} within ${maxDistance} blocks (have ${s.collectedSoFar}/${goal}, excluded ${s.excluded.size}${protectedReason}${supportReason}${verticalReason})`,
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
          protectedPositions,
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
      s.currentTarget = toVec3(target.position);
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

      log.executor.info('collect.target', {
        pos: s.currentTarget,
        sofar: s.collectedSoFar,
        goal,
        requested: requestedName,
        sourceBlock: blockName,
        progressItems,
      });
      const movementPolicy = configureCollectMovements(bot, ctx, worldModel, {
        blockName,
        requestedName,
      });
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
        authorizeDig: (block) => finalCollectAuthorization(bot, ctx, block, {
          worldModel,
          protectedPositions,
        }),
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
        const recovery = await maybeRecoverToSurfaceAfterCollectFailure(bot, ctx, outcome, {
          trigger: 'collectBlock pathing error',
          pathing: reason,
        });
        if (recovery?.preempted) {
          return { preempted: true, reason: recovery.reason || 'reactive preempt during collect recovery', state: buildSnapshot(bot, ctx) };
        }
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

    if (outcome.kind === 'groundWaitTimeout') {
      const reason = pathingFailureReason(outcome);
      log.executor.warn('collect.ground-wait-timeout', {
        pos: s.currentTarget,
        pathing: reason,
        target: outcome.target,
      });
      return {
        ok: false,
        reason: `collect refused to dig while airborne: ${reason}`,
        state: buildSnapshot(bot, ctx),
      };
    }

    if (outcome.kind === 'unsafeStraightDownDig') {
      const reason = pathingFailureReason(outcome);
      log.executor.warn('collect.unsafe-straight-down', {
        pos: s.currentTarget,
        pathing: reason,
        safety: outcome.safety,
      });
      return {
        ok: false,
        reason,
        state: buildSnapshot(bot, ctx),
      };
    }

    if (outcome.kind === 'airborneDigRetryExhausted') {
      const reason = pathingFailureReason(outcome);
      log.executor.warn('collect.airborne-dig-retry-exhausted', {
        pos: s.currentTarget,
        pathing: reason,
        target: outcome.target,
      });
      return {
        ok: false,
        reason: `collect refused unstable airborne dig: ${reason}`,
        state: buildSnapshot(bot, ctx),
      };
    }

    if (outcome.kind === 'worldActionDenied') {
      return {
        ok: false,
        reason: `collect target denied: ${pathingFailureReason(outcome)}`,
        state: buildSnapshot(bot, ctx),
      };
    }

    if (outcome.kind === 'stuck') {
      const reason = pathingFailureReason(outcome);
      const recovery = await maybeRecoverToSurfaceAfterCollectFailure(bot, ctx, outcome, {
        trigger: 'stuck',
        pathing: reason,
      });
      if (recovery?.preempted) {
        return { preempted: true, reason: recovery.reason || 'reactive preempt during collect recovery', state: buildSnapshot(bot, ctx) };
      }
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
      const recovery = await maybeRecoverToSurfaceAfterCollectFailure(bot, ctx, outcome, {
        trigger: 'target-timeout',
        pathing: reason,
      });
      if (recovery?.preempted) {
        return { preempted: true, reason: recovery.reason || 'reactive preempt during collect recovery', state: buildSnapshot(bot, ctx) };
      }
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
    revokeWorldActionAnchor(bot, ctx, target.name, target.position);
    const immediateAfter = countProgressInventory(bot, progressItems);
    if (!immediateAfter.ok) {
      return {
        ok: false,
        reason: `inventory unavailable during collect progress check: ${immediateAfter.error}`,
        state: buildSnapshot(bot, ctx),
      };
    }
    let targetStillPresent = false;
    if (immediateAfter.count <= haveBefore) {
      try {
        targetStillPresent = bot.blockAt(s.currentTarget)?.name === blockName;
      } catch (err) {
        return worldQueryFailure(bot, ctx, 'collect post-break validation', err);
      }
    }
    if (immediateAfter.count <= haveBefore && targetStillPresent) {
      log.executor.warn('collect.no-break', {
        pos: s.currentTarget,
        block: blockName,
        mode: outcome.mode ?? null,
        reason: 'collectBlock completed but target block is still present',
      });
      s.excluded.add(posKey(s.currentTarget));
      if (s.activeLogCluster) s.activeLogCluster.keys.delete(posKey(s.currentTarget));
      s.currentTarget = null;
      s.interruptsOnCurrent = 0;
      if (maybeAbandonUnproductiveLogCluster(s, params, 'no-break')) continue;
      if (maybeFinishSatisfiedLogCleanup(s, goal, params, 'no-break')) break;
      continue;
    }

    // Pickup happens via item-drop entities and can lag the dig completion
    // briefly. Give it a moment, then measure delta against the pre-call count.
    const cleanupAfterGoalAtTargetStart = isSatisfiedLogCleanupTarget(s, goal);
    const basePickupWaitMs = outcome.mode === 'fastDig'
      ? positiveFiniteNumber(params.fastDigPickupWaitMs ?? config.executor?.fastDigPickupWaitMs ?? FAST_DIG_PICKUP_WAIT_MS)
      : positiveFiniteNumber(params.pickupWaitMs ?? config.executor?.collectPickupWaitMs ?? DEFAULT_PICKUP_WAIT_MS);
    const pickupWaitMs = applySatisfiedTreeCleanupPickupCap(basePickupWaitMs, cleanupAfterGoalAtTargetStart);
    const inventoryWaitStartedAt = Date.now();
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
    log.executor.info('collect.inventory-wait', {
      pos: s.currentTarget,
      mode: outcome.mode ?? null,
      waitedMs: Date.now() - inventoryWaitStartedAt,
      maxMs: pickupWaitMs ?? DEFAULT_PICKUP_WAIT_MS,
      delta,
    });
    if (delta <= 0) {
      if (cleanupAfterGoalAtTargetStart) {
        log.executor.info('collect.tree.cleanup-pickup-capped', {
          pos: s.currentTarget,
          mode: outcome.mode ?? null,
          maxMs: pickupWaitMs ?? TREE_CLEANUP_AFTER_GOAL_PICKUP_WAIT_MS,
          reason: 'goal already satisfied; skipping extended drop pickup for tree cleanup',
        });
      } else {
        const pickup = await collectNearbyDropAfterDig(bot, s.currentTarget, ctx, {
          mode: outcome.mode ?? 'collectBlock',
          progressItems,
          haveBefore,
        });
        log.executor.info(outcome.mode === 'fastDig' ? 'collect.fast-dig.pickup' : 'collect.drop-pickup', {
          pos: s.currentTarget,
          mode: outcome.mode ?? null,
          pickup,
        });
        if (pickup.preempted) {
          return { preempted: true, reason: pickup.reason || 'reactive preempt during collect drop pickup', state: buildSnapshot(bot, ctx) };
        }
        const basePostPickupWaitMs = outcome.mode === 'fastDig'
          ? positiveFiniteNumber(params.fastDigPostPickupWaitMs ?? config.executor?.fastDigPostPickupWaitMs ?? FAST_DIG_POST_PICKUP_WAIT_MS)
          : positiveFiniteNumber(params.postPickupWaitMs ?? config.executor?.collectPostPickupWaitMs ?? COLLECT_BLOCK_POST_PICKUP_WAIT_MS);
        const postPickupWaitStartedAt = Date.now();
        after = await waitForInventoryDelta(
          bot,
          progressItems,
          haveBefore,
          basePostPickupWaitMs ?? (outcome.mode === 'fastDig' ? FAST_DIG_POST_PICKUP_WAIT_MS : COLLECT_BLOCK_POST_PICKUP_WAIT_MS),
          ctx.signal,
        );
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
        log.executor.info('collect.post-pickup-wait', {
          pos: s.currentTarget,
          mode: outcome.mode ?? null,
          waitedMs: Date.now() - postPickupWaitStartedAt,
          maxMs: basePostPickupWaitMs ?? (outcome.mode === 'fastDig' ? FAST_DIG_POST_PICKUP_WAIT_MS : COLLECT_BLOCK_POST_PICKUP_WAIT_MS),
          delta,
        });
      }
    }
    if (delta > 0) {
      s.collectedSoFar += delta;
      s.lastCollectedTarget = toVec3(s.currentTarget);
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
    reason: `collected ${s.collectedSoFar} ${requestedName}`,
    state: buildSnapshot(bot, ctx),
  };
}

export function resolveCollectTarget(mcData, requestedName, params = {}) {
  const requested = String(requestedName || '').trim();
  if (!requested) return { ok: false, reason: 'collect target is required' };

  const sameNamedBlock = normalizeBlockType(mcData?.blocksByName?.[requested], requested);
  const item = mcData?.itemsByName?.[requested] || null;
  const dropSources = dropSourcesForItem(mcData, requested);

  if (sameNamedBlock && params.progressItems !== undefined) {
    return {
      ok: true,
      requested,
      sourceBlock: sameNamedBlock,
      progressItems: normalizeProgressItems(params.progressItems, requested),
      candidates: dropSources.candidates?.map?.((block) => block.name) || [],
      reason: 'same-named block with explicit progress items',
    };
  }

  if (dropSources.error) {
    if (sameNamedBlock) {
      return {
        ok: true,
        requested,
        sourceBlock: sameNamedBlock,
        progressItems: normalizeProgressItems(params.progressItems, requested),
        candidates: [],
        reason: 'drop-source metadata unavailable; using same-named block',
      };
    }
    return { ok: false, reason: `unknown block "${requested}"` };
  }

  let sourceBlock = null;
  let reason = 'same-named block';
  if (dropSources.candidates.length > 0) {
    sourceBlock = chooseDropSourceBlock(dropSources.candidates, requested);
    reason = sourceBlock.name === requested ? 'same-named drop source' : 'resolved item drop source';
  } else if (sameNamedBlock && !item) {
    sourceBlock = sameNamedBlock;
    reason = 'same-named block without item metadata';
  } else if (sameNamedBlock && !blockDropsItem(mcData, sameNamedBlock, requested)) {
    return { ok: false, reason: `no known block source drops "${requested}"` };
  } else if (sameNamedBlock) {
    sourceBlock = sameNamedBlock;
    reason = 'same-named block fallback';
  }

  if (!sourceBlock) {
    return sameNamedBlock
      ? { ok: false, reason: `no known block source drops "${requested}"` }
      : { ok: false, reason: `unknown block "${requested}"` };
  }

  return {
    ok: true,
    requested,
    sourceBlock,
    progressItems: normalizeProgressItems(params.progressItems, requested),
    candidates: dropSources.candidates.map((block) => block.name),
    reason,
  };
}

export function buildDropSourcesByItem(mcData) {
  const blocks = Array.isArray(mcData?.blocksArray)
    ? mcData.blocksArray
    : Object.values(mcData?.blocksByName || {});
  const itemsById = mcData?.items || {};
  const byItem = new Map();

  for (const block of blocks) {
    if (!block || !Array.isArray(block.drops)) continue;
    for (const dropId of block.drops) {
      const itemName = itemsById[dropId]?.name;
      if (!itemName) continue;
      const existing = byItem.get(itemName) || [];
      existing.push(block);
      byItem.set(itemName, existing);
    }
  }

  for (const [itemName, blocksForItem] of byItem.entries()) {
    byItem.set(itemName, [...blocksForItem].sort(compareDropSourceBlocks(itemName)));
  }
  return byItem;
}

export function chooseDropSourceBlock(candidates, requestedName) {
  return [...candidates].sort(compareDropSourceBlocks(requestedName))[0] || null;
}

function dropSourcesForItem(mcData, itemName) {
  if (!mcData || (!Array.isArray(mcData.blocksArray) && !mcData.blocksByName) || !mcData.items) {
    return { candidates: [], error: 'missing minecraft-data drops metadata' };
  }
  let byItem = DROP_SOURCE_CACHE.get(mcData);
  if (!byItem) {
    byItem = buildDropSourcesByItem(mcData);
    DROP_SOURCE_CACHE.set(mcData, byItem);
  }
  return { candidates: byItem.get(itemName) || [] };
}

function normalizeBlockType(block, fallbackName) {
  if (!block) return null;
  return block.name ? block : { ...block, name: fallbackName };
}

function blockDropsItem(mcData, block, itemName) {
  if (!block || !Array.isArray(block.drops)) return false;
  const itemsById = mcData?.items || {};
  return block.drops.some((dropId) => itemsById[dropId]?.name === itemName);
}

function compareDropSourceBlocks(itemName) {
  return (a, b) => (
    dropSourceScore(a, itemName) - dropSourceScore(b, itemName) ||
    String(a.name || '').localeCompare(String(b.name || '')) ||
    Number(a.id ?? 0) - Number(b.id ?? 0)
  );
}

function dropSourceScore(block, itemName) {
  const name = String(block?.name || '');
  let score = 0;
  if (block?.diggable === false) score += 100000;
  if (block?.boundingBox !== 'block') score += 10000;
  if (block?.transparent === true) score += 1000;
  if (name === itemName) score += 100;
  if (name.includes('deepslate_')) score += 50;
  if (name.endsWith('_ore')) score -= 25;
  score += Math.max(0, name.length - String(itemName || '').length);
  score += Number(block?.id ?? 0) / 1000;
  return score;
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

function maybeFinishSatisfiedLogCleanupForCap(s, goal, finishActiveLogCluster, params = {}) {
  if (!finishActiveLogCluster || !s.activeLogCluster || s.collectedSoFar < goal) return false;
  const configured = params.treeClusterCleanupMultiplier
    ?? config.executor?.collectTreeClusterCleanupMultiplier
    ?? TREE_CLUSTER_CLEANUP_MULTIPLIER;
  const multiplier = positiveFiniteNumber(configured);
  if (multiplier === null) return false;
  const cleanupCap = Math.ceil(goal * multiplier);
  if (s.collectedSoFar < cleanupCap) return false;
  log.executor.info('collect.tree.cleanup-cap', {
    block: s.activeLogCluster.block,
    anchor: s.activeLogCluster.anchor,
    remaining: s.activeLogCluster.keys?.size ?? 0,
    goal,
    collectedSoFar: s.collectedSoFar,
    cleanupCap,
    multiplier,
  });
  finishLogCluster(s, 'cleanup-cap-reached');
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

function isSatisfiedLogCleanupTarget(s, goal) {
  return Boolean(s?.activeLogCluster) && Number(s.collectedSoFar || 0) >= Number(goal || 0);
}

export function effectiveCollectPickupWaitMs(baseMs, state, goal) {
  return applySatisfiedTreeCleanupPickupCap(baseMs, isSatisfiedLogCleanupTarget(state, goal));
}

function applySatisfiedTreeCleanupPickupCap(baseMs, cleanupAfterGoalAtTargetStart) {
  if (!cleanupAfterGoalAtTargetStart) return baseMs;
  const capMs = positiveFiniteNumber(config.executor?.collectTreeCleanupPickupWaitMs ?? TREE_CLEANUP_AFTER_GOAL_PICKUP_WAIT_MS);
  if (capMs === null) return baseMs;
  if (baseMs === null) return capMs;
  return Math.min(baseMs, capMs);
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
  const candidates = orderedCollectCandidates(positions, opts);
  return candidates[0] || null;
}

async function chooseCollectCandidateForRun(bot, positions, opts = {}) {
  const candidates = orderedCollectCandidates(positions, opts);
  if (candidates.length === 0) return { candidate: null };
  if (!requiresSurfaceReachability(opts)) return { candidate: candidates[0] };

  const reachable = await chooseSurfaceReachableCandidate(bot, candidates, opts);
  if (reachable.error) return { error: reachable.error };
  if (reachable.candidate) return { candidate: reachable.candidate };

  const diagnostic = buildShaftMiningDiagnostic(candidates, opts);
  const reason = buildShaftMiningReason(diagnostic, opts);
  log.executor.warn('collect.surface-reachability-required', {
    requested: opts.requestedName,
    sourceBlock: opts.blockName,
    reason,
    diagnostic,
  });
  return {
    candidate: null,
    shaftMiningRequired: true,
    reason,
    diagnostic,
  };
}

function orderedCollectCandidates(positions, opts = {}) {
  const excluded = opts.excluded || new Set();
  const candidates = positions.filter((p) => (
    !excluded.has(posKey(p)) &&
    collectTargetWithinVerticalBounds(p, opts) &&
    !isUnsafeSameColumnDescent(p, opts) &&
    collectModificationPolicy(p, opts).ok
  ));
  if (candidates.length === 0) return [];

  const clusterOrigin = opts.clusterOrigin || null;
  const clusterRadius = opts.clusterRadius ?? 2.5;
  const origin = opts.origin || null;
  if (clusterOrigin) {
    const clustered = candidates.filter((p) => distance(p, clusterOrigin) <= clusterRadius);
    if (clustered.length > 0) {
      const clusteredKeys = new Set(clustered.map(posKey));
      const outsideCluster = candidates.filter((p) => !clusteredKeys.has(posKey(p)));
      return [
        ...sortByDistance(clustered, clusterOrigin, origin),
        ...sortByDistance(outsideCluster, origin, null),
      ];
    }
  }

  return sortByDistance(candidates, origin, null);
}

function requiresSurfaceReachability(opts = {}) {
  if (opts.allowBuriedTargets === true) return false;
  if (opts.reachabilityFilter === false) return false;
  const requested = opts.requestedName || opts.requested || null;
  const blockName = opts.blockName || null;
  const progressItems = Array.isArray(opts.progressItems) ? opts.progressItems : [];
  return blockName === 'stone' && (requested === 'cobblestone' || progressItems.includes('cobblestone'));
}

async function chooseSurfaceReachableCandidate(bot, candidates, opts = {}) {
  const surfaceCandidates = [];
  for (const candidate of candidates) {
    const exposure = inspectSurfaceExposure(bot, candidate, opts);
    if (exposure.error) return { error: exposure.error };
    if (exposure.surfaceExposed) surfaceCandidates.push({ position: candidate, exposure });
  }

  if (surfaceCandidates.length === 0) return { candidate: null, reason: 'no_surface_exposed_candidate' };
  const probeCount = Math.max(1, Number(opts.reachabilityProbeCount || SURFACE_REACHABILITY_PROBE_COUNT));
  const probeCandidates = surfaceCandidates.slice(0, probeCount);
  for (const entry of probeCandidates) {
    const probe = probeReachability(bot, entry.position, opts);
    if (probe.error) return { error: probe.error };
    if (probe.skipped || probe.reachable) {
      if (probe.skipped) {
        log.executor.debug('collect.reachability-probe-skipped', {
          pos: entry.position,
          reason: probe.reason,
        });
      } else {
        log.executor.debug('collect.reachability-probe-ok', {
          pos: entry.position,
          status: probe.status,
          pathLength: probe.pathLength ?? null,
        });
      }
      return { candidate: entry.position, exposure: entry.exposure, probe };
    }
    log.executor.debug('collect.reachability-probe-rejected', {
      pos: entry.position,
      status: probe.status,
      pathLength: probe.pathLength ?? null,
    });
  }

  return { candidate: null, reason: 'surface_candidates_not_pathable' };
}

function inspectSurfaceExposure(bot, position, opts = {}) {
  const originY = Math.floor(opts.origin?.y ?? bot.entity?.position?.y ?? position.y);
  const tolerance = Number(opts.surfaceVerticalTolerance ?? SURFACE_REACHABILITY_VERTICAL_TOLERANCE);
  const topY = position.y + 1;
  const verticalOk = Math.abs(topY - originY) <= tolerance;
  let above = null;
  let above2 = null;
  try {
    above = blockAtForExposure(bot, position.x, position.y + 1, position.z);
    above2 = blockAtForExposure(bot, position.x, position.y + 2, position.z);
  } catch (error) {
    return { error };
  }
  const abovePassable = isSurfacePassableBlock(above);
  const above2Passable = isSurfacePassableBlock(above2);
  return {
    surfaceExposed: verticalOk && abovePassable && above2Passable,
    verticalOk,
    topY,
    originY,
    above: above?.name ?? null,
    above2: above2?.name ?? null,
  };
}

function blockAtForExposure(bot, x, y, z) {
  if (typeof bot?.blockAt !== 'function') return null;
  return bot.blockAt(new Vec3(x, y, z));
}

function isSurfacePassableBlock(block) {
  if (!block) return true;
  const name = String(block.name || '');
  return block.boundingBox === 'empty' ||
    SURFACE_PASSABLE_BLOCKS.has(name) ||
    name.endsWith('_leaves');
}

function probeReachability(bot, position, opts = {}) {
  if (typeof bot?.pathfinder?.getPathTo !== 'function') {
    return { skipped: true, reason: 'pathfinder probe unavailable' };
  }
  if (typeof GoalGetToBlock !== 'function') {
    return { skipped: true, reason: 'GoalGetToBlock unavailable' };
  }
  let movements = opts.movements || bot.collectBlock?.movements || bot.pathfinder?.movements || null;
  if (!movements) {
    try {
      movements = new Movements(bot);
    } catch (error) {
      return { error };
    }
  }
  try {
    const goal = new GoalGetToBlock(position.x, position.y, position.z);
    const result = bot.pathfinder.getPathTo(movements, goal, opts.reachabilityProbeTimeoutMs ?? SURFACE_REACHABILITY_PROBE_TIMEOUT_MS);
    return {
      reachable: result?.status === 'success',
      status: result?.status ?? null,
      pathLength: Array.isArray(result?.path) ? result.path.length : null,
    };
  } catch (error) {
    return { error };
  }
}

function buildShaftMiningDiagnostic(candidates, opts = {}) {
  const ys = candidates.map((p) => p.y).filter((y) => Number.isFinite(y));
  const origin = opts.origin || {};
  return {
    candidatesFound: candidates.length,
    deepestStoneY: ys.length > 0 ? Math.min(...ys) : null,
    surfaceY: Number.isFinite(origin.y) ? Math.floor(origin.y) : null,
    searchRadius: opts.maxDistance ?? null,
    suggestion: SHAFT_MINING_SUGGESTION,
  };
}

function buildShaftMiningReason(diagnostic, opts = {}) {
  const origin = opts.origin || {};
  const x = Number.isFinite(origin.x) ? Math.floor(origin.x) : '?';
  const y = Number.isFinite(origin.y) ? Math.floor(origin.y) : '?';
  const z = Number.isFinite(origin.z) ? Math.floor(origin.z) : '?';
  const requested = opts.requestedName || opts.requested || 'target';
  const source = opts.blockName || 'source';
  const radius = diagnostic.searchRadius ?? '?';
  return `no surface-exposed ${requested} within ${radius} blocks of (${x},${y},${z}); ` +
    `${diagnostic.candidatesFound} ${source} candidates found but all buried below surface. ` +
    `Shaft mining capability required. suggestion: ${diagnostic.suggestion}`;
}

function collectCandidateStats(positions, opts = {}) {
  const excluded = opts.excluded || new Set();
  let protectedCount = 0;
  let supportCount = 0;
  let aboveMaxTargetY = 0;
  for (const p of positions) {
    if (excluded.has(posKey(p))) continue;
    if (!collectTargetWithinVerticalBounds(p, opts)) {
      aboveMaxTargetY++;
      continue;
    }
    const policy = collectModificationPolicy(p, opts);
    if (!policy.ok && policy.kind === 'support') supportCount++;
    else if (!policy.ok) protectedCount++;
  }
  return { protected: protectedCount, support: supportCount, aboveMaxTargetY };
}

function collectTargetWithinVerticalBounds(position, opts = {}) {
  const maxTargetY = Number(opts.maxTargetY);
  if (Number.isFinite(maxTargetY) && Number.isFinite(position?.y) && position.y > maxTargetY) return false;
  return true;
}

function collectModificationPolicy(position, opts = {}) {
  const supportPosition = opts.supportPosition || supportUnderPosition(opts.origin);
  if (sameBlock(position, supportPosition)) {
    return { ok: false, action: 'deny', kind: 'support', reason: 'target supports current bot position' };
  }
  const protectedPosition = matchingProtectedPosition(position, opts.protectedPositions);
  if (protectedPosition) {
    return {
      ok: false,
      action: 'deny',
      kind: 'protected',
      reason: 'target is protected by current task context',
      position: protectedPosition,
    };
  }
  if (!opts.worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(opts.worldModel, position, { margin: opts.doNotTouchMargin ?? 0 });
}

function finalCollectAuthorization(bot, ctx, block, opts = {}) {
  const position = block?.position;
  const collectPolicy = collectModificationPolicy(position, {
    supportPosition: supportUnderPosition(bot.entity?.position),
    protectedPositions: opts.protectedPositions,
    worldModel: null,
  });
  if (!collectPolicy.ok) return collectPolicy;
  return authorizeBlockBreak(bot, ctx, block, { worldModel: opts.worldModel });
}

function isUnsafeSameColumnDescent(position, opts = {}) {
  if (opts.preventSameColumnDescent !== true) return false;
  if (opts.allowBuriedTargets === true) return false;
  const previous = opts.previousTarget;
  if (!previous) return false;
  const p = blockPosition(position);
  const prev = blockPosition(previous);
  return p.x === prev.x && p.z === prev.z && p.y < prev.y;
}

function collectProtectedPositionsFromContext(ctx = {}) {
  const raw = ctx.collectProtectedPositions;
  if (!raw) return null;
  if (raw instanceof Set) return raw;
  if (!Array.isArray(raw)) return null;
  const keys = new Set();
  for (const position of raw) {
    if (!position) continue;
    const x = Math.floor(Number(position.x));
    const y = Math.floor(Number(position.y));
    const z = Math.floor(Number(position.z));
    if ([x, y, z].every(Number.isFinite)) keys.add(`${x},${y},${z}`);
  }
  return keys.size > 0 ? keys : null;
}

function matchingProtectedPosition(position, protectedPositions) {
  if (!protectedPositions) return null;
  const key = posKey(blockPosition(position));
  if (protectedPositions instanceof Set) return protectedPositions.has(key) ? position : null;
  if (!Array.isArray(protectedPositions)) return null;
  return protectedPositions.find((candidate) => sameBlock(position, candidate)) || null;
}

function configureCollectMovements(bot, ctx, worldModel, opts = {}) {
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
  applyLogCollectionMovementPolicy(movements, opts);
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

function applyLogCollectionMovementPolicy(movements, opts = {}) {
  if (!movements || !isTreeLogBlock(opts.blockName)) return;
  const exclusion = (block) => (isLeafBlockName(block?.name) ? LOG_COLLECTION_OBSTRUCTION_COST : 0);
  Object.defineProperty(exclusion, LOG_COLLECTION_MOVEMENT_POLICY, { value: true });
  replaceMovementPolicy(movements.exclusionAreasStep, exclusion, LOG_COLLECTION_MOVEMENT_POLICY);
  replaceMovementPolicy(movements.exclusionAreasBreak, exclusion, LOG_COLLECTION_MOVEMENT_POLICY);
}

function replaceMovementPolicy(areas, exclusion, marker) {
  if (!Array.isArray(areas)) return;
  for (let i = areas.length - 1; i >= 0; i--) {
    if (areas[i]?.[marker]) areas.splice(i, 1);
  }
  areas.push(exclusion);
}

function isLeafBlockName(name) {
  return String(name || '').endsWith('_leaves');
}

async function maybeRecoverToSurfaceAfterCollectFailure(bot, ctx, outcome, opts = {}) {
  const helper = ctx.recoverToSurface || recoverToSurface;
  if (typeof helper !== 'function') return null;
  const result = await helper(bot, ctx, {
    trigger: opts.trigger,
    pathing: opts.pathing,
    outcomeKind: outcome?.kind ?? null,
  });
  if (result?.preempted) return result;
  if (result?.ok && result.action === 'pillar_up') {
    log.executor.info('collect.recover-to-surface', {
      trigger: opts.trigger,
      pathing: opts.pathing,
      steps: result.steps,
      block: result.block,
      startY: result.startY,
      targetY: result.targetY,
      finalY: result.finalY,
    });
  } else if (result && result.ok === false) {
    log.executor.warn('collect.recover-to-surface-failed', {
      trigger: opts.trigger,
      pathing: opts.pathing,
      reason: result.reason,
      detection: result.detection,
    });
  }
  return result;
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

function inventoryExceededBaselinePredicate(bot, names, baseline) {
  if (!Array.isArray(names) || names.length === 0 || !Number.isFinite(Number(baseline))) return null;
  return () => {
    const current = countProgressInventory(bot, names);
    return current.ok === true && current.count > Number(baseline);
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

async function collectNearbyDropAfterDig(bot, targetPosition, ctx, opts = {}) {
  const isComplete = inventoryExceededBaselinePredicate(bot, opts.progressItems, opts.haveBefore);
  const isFastDig = opts.mode === 'fastDig';
  const appearMs = isFastDig ? FAST_DIG_DROP_APPEAR_MS : COLLECT_BLOCK_DROP_APPEAR_MS;
  const nudgeMs = isFastDig ? FAST_DIG_DROP_NUDGE_MS : COLLECT_BLOCK_DROP_NUDGE_MS;
  const fallbackTimeoutMs = isFastDig ? 2000 : COLLECT_BLOCK_DROP_FALLBACK_TIMEOUT_MS;
  const found = await waitForNearbyDroppedItemEntity(bot, targetPosition, ctx.signal, {
    radius: FAST_DIG_DROP_SEARCH_RADIUS,
    maxMs: appearMs,
    intervalMs: FAST_DIG_DROP_APPEAR_POLL_MS,
    isComplete,
  });
  if (found.preempted) return found;
  if (found.complete) return found;
  const entity = found.entity;
  if (!entity) return { ok: false, reason: 'no nearby dropped item entity', waitedMs: found.waitedMs };

  const local = await nudgeTowardItemEntity(bot, () => nearestDroppedItemEntity(bot, targetPosition, FAST_DIG_DROP_SEARCH_RADIUS), ctx, {
    maxMs: nudgeMs,
    intervalMs: FAST_DIG_DROP_NUDGE_INTERVAL_MS,
    closeDistance: FAST_DIG_DROP_CLOSE_DISTANCE,
    isComplete,
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
      targetTimeoutMs: fallbackTimeoutMs,
      pathStallMs: fallbackTimeoutMs,
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
      position: fallbackEntity.position ? toVec3(fallbackEntity.position) : null,
    };
  } finally {
    releasePathfinder(acq, { skill: 'collect', phase: 'pickup-drop' });
  }
}

async function waitForNearbyDroppedItemEntity(bot, targetPosition, signal, opts = {}) {
  const startedAtMs = Date.now();
  const maxMs = opts.maxMs ?? FAST_DIG_DROP_APPEAR_MS;
  const intervalMs = opts.intervalMs ?? FAST_DIG_DROP_APPEAR_POLL_MS;
  const radius = opts.radius ?? FAST_DIG_DROP_SEARCH_RADIUS;
  const isComplete = typeof opts.isComplete === 'function' ? opts.isComplete : null;
  let createdEntity = null;
  const onEntityCreate = (entity) => {
    if (!createdEntity && isNearbyDroppedItemEntity(entity, targetPosition, radius)) {
      createdEntity = entity;
    }
  };
  if (typeof bot?.on === 'function') bot.on('entityCreate', onEntityCreate);
  try {
    while (Date.now() - startedAtMs <= maxMs) {
      if (signal?.aborted) {
        return { preempted: true, reason: 'reactive preempt during dropped item lookup', waitedMs: Date.now() - startedAtMs };
      }
      if (isComplete?.()) {
        return {
          ok: true,
          complete: true,
          kind: 'inventoryDelta',
          reason: 'inventory delta observed before dropped item lookup completed',
          waitedMs: Date.now() - startedAtMs,
        };
      }
      const entity = nearestDroppedItemEntity(bot, targetPosition, radius) ||
        (isNearbyDroppedItemEntity(createdEntity, targetPosition, radius) ? createdEntity : null);
      if (entity) return { entity, waitedMs: Date.now() - startedAtMs };
      await sleep(intervalMs, signal);
    }
    return { entity: null, waitedMs: Date.now() - startedAtMs };
  } finally {
    if (typeof bot?.removeListener === 'function') bot.removeListener('entityCreate', onEntityCreate);
  }
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

function isNearbyDroppedItemEntity(entity, targetPosition, maxDistance) {
  if (!targetPosition || !entity?.position || !isDroppedItemEntity(entity)) return false;
  const center = new Vec3(targetPosition.x + 0.5, targetPosition.y + 0.5, targetPosition.z + 0.5);
  return distance(entity.position, center) <= maxDistance;
}

function isDroppedItemEntity(entity) {
  return entity?.name === 'item' ||
    entity?.displayName === 'Item';
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

function blockPosition(p) {
  return toVec3({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
}

function positionFromKey(key) {
  const [x, y, z] = String(key).split(',').map(Number);
  return toVec3({ x, y, z });
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
