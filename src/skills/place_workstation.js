import pkgPathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import config from '../config.js';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { readBotInventoryCounts, readBotInventoryItems } from '../state/materials.js';
import { blockModificationPolicy } from '../state/world_model.js';
import {
  authorizeBlockBreak,
  authorizePlacement,
  authorizeWorkstationAccess,
  revokeWorldActionAnchor,
} from '../state/world_action_authorization.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import {
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
  worldModelFromContext,
} from './_pathing.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';
import { runBoundedOperation } from './_operations.js';

const { goals: pfGoals } = pkgPathfinder;

const WORKSTATIONS = new Set(['crafting_table', 'furnace']);
const INTERACTIVE_SUPPORT_BLOCKS = new Set([...WORKSTATIONS]);
const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE_BLOCKS = new Set([
  ...EMPTY_BLOCKS,
  'short_grass',
  'tall_grass',
  'grass',
  'fern',
  'large_fern',
  'dead_bush',
  'snow',
  'vine',
  'glow_lichen',
]);
const HAZARD_BLOCKS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose']);
const PLACEMENT_SEARCH_RADIUS = 2;
const PLACEMENT_VERTICAL_RADIUS = 1;
const REACH_BLOCKS = 4.5;
const BREAK_WALK_RANGE = 2;
const BREAK_WALK_TIMEOUT_MS = 45000;
const PICKUP_TIMEOUT_MS = 3000;
const FACE_UP = new Vec3(0, 1, 0);

export async function run(bot, params, ctx) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');

  const workstation = normalizeName(params.workstation);
  if (!WORKSTATIONS.has(workstation)) {
    return failed(bot, ctx, `unknown workstation "${params.workstation}"`);
  }
  if (params.action === 'place') return placeWorkstation(bot, workstation, params, ctx);
  if (params.action === 'break_and_carry') return breakAndCarryWorkstation(bot, workstation, params, ctx);
  return failed(bot, ctx, `unknown workstation action "${params.action}"`);
}

async function placeWorkstation(bot, workstation, params, ctx) {
  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) return failed(bot, ctx, `inventory unavailable during place_workstation: ${inventory.error}`);
  if ((inventory.inventory[workstation] || 0) < 1) return failed(bot, ctx, 'no_workstation_in_inventory');

  const ready = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for place_workstation chunk readiness');
  if (ready.preempted) return preempted(bot, ctx, ready.reason);
  if (ready.error) return failed(bot, ctx, `chunk data unavailable during place_workstation: ${errorMessage(ready.error)}`);

  const worldModelResult = worldModelFromContext(ctx);
  if (worldModelResult.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during place_workstation: ${worldModelResult.error.message}`,
      state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
    };
  }

  const requested = resolvePlacementOrigin(bot, params);
  if (!requested.ok) return failed(bot, ctx, requested.reason);

  const selected = selectSafePlacement(bot, requested.target, {
    worldModel: worldModelResult.model,
    protectedPositions: protectedPositionsFromContext(ctx),
    searchRadius: params.searchRadius ?? PLACEMENT_SEARCH_RADIUS,
    verticalRadius: params.verticalRadius ?? PLACEMENT_VERTICAL_RADIUS,
  });
  if (!selected.ok) {
    return {
      ok: false,
      reason: `no_safe_placement_position: ${selected.reason}`,
      searchRadius: selected.summary?.radius ?? PLACEMENT_SEARCH_RADIUS,
      placementSearch: selected.summary || null,
      state: buildSnapshot(bot, ctx),
    };
  }

  const placed = await placeSelectedWorkstation(bot, workstation, selected, ctx);
  if (placed.preempted) return placed;
  if (!placed.ok) return failed(bot, ctx, `place_workstation place failed: ${placed.reason}`);

  const placedAt = selected.target;
  recordPlacedWorkstation(ctx, workstation, placedAt);
  log.executor.info('place_workstation.placed', {
    workstation,
    position: positionRecord(placedAt),
    requested: positionRecord(requested.target),
    placementSearch: selected.summary || null,
  });

  return {
    ok: true,
    reason: `placed ${workstation} at ${formatPos(placedAt)}`,
    state: {
      ...buildSnapshot(bot, ctx),
      workstation,
      action: 'place',
      placedAt: positionRecord(placedAt),
      requestedPlaceAt: positionRecord(requested.target),
      placementSearch: selected.summary || null,
    },
  };
}

async function placeSelectedWorkstation(bot, workstation, selected, ctx) {
  const inventory = readBotInventoryItems(bot);
  if (!inventory.ok) return { ok: false, reason: `inventory unavailable during place_workstation place: ${inventory.error}` };
  const item = inventory.items.find((entry) => normalizeName(entry.name) === workstation);
  if (!item) return { ok: false, reason: `no ${workstation} in inventory` };

  try {
    await equipWorkstationItem(bot, item, { workstation, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted || err?.code === 'PLACE_WORKSTATION_EQUIP_ABORTED') {
      return preempted(bot, ctx, 'reactive preempt during place_workstation equip');
    }
    return { ok: false, reason: `equip failed: ${errorMessage(err)}` };
  }

  try {
    await lookAtWorkstationTarget(bot, selected.target, { workstation, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted || err?.code === 'PLACE_WORKSTATION_LOOK_ABORTED') {
      return preempted(bot, ctx, 'reactive preempt during place_workstation look');
    }
    return { ok: false, reason: `look failed: ${errorMessage(err)}` };
  }

  try {
    await placeWorkstationBlock(bot, selected.validation.referenceBlock, selected.validation.faceVector, {
      workstation,
      signal: ctx.signal,
      authorize: () => authorizePlacement(bot, ctx, selected.target, {
        referencePosition: selected.validation.referenceBlock?.position,
        referenceBlockName: selected.validation.referenceBlock?.name,
      }),
    });
  } catch (err) {
    if (ctx.signal?.aborted || err?.code === 'PLACE_WORKSTATION_BLOCK_ABORTED') {
      return preempted(bot, ctx, 'reactive preempt during place_workstation block place');
    }
    return { ok: false, reason: `block place failed: ${errorMessage(err)}` };
  }

  const placed = await waitForPlacedBlock(bot, selected.target, workstation, ctx.signal);
  if (placed.preempted) return preempted(bot, ctx, placed.reason);
  if (placed.error) return { ok: false, reason: `world query failed verifying placement: ${placed.error}` };
  if (placed.block?.name !== workstation) {
    return { ok: false, reason: `placement verification failed: expected ${workstation} at ${formatPos(selected.target)}, found ${placed.block?.name || 'none'}` };
  }
  return { ok: true };
}

async function breakAndCarryWorkstation(bot, workstation, params, ctx) {
  const ready = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for place_workstation break chunk readiness');
  if (ready.preempted) return preempted(bot, ctx, ready.reason);
  if (ready.error) return failed(bot, ctx, `chunk data unavailable during place_workstation break: ${errorMessage(ready.error)}`);

  const worldModelResult = worldModelFromContext(ctx);
  if (worldModelResult.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during place_workstation break: ${worldModelResult.error.message}`,
      state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
    };
  }

  const position = resolveBreakPosition(workstation, params, ctx);
  if (!position) return failed(bot, ctx, 'placed_position_unknown');

  const policy = modificationPolicy(worldModelResult.model, position);
  if (!policy.ok) return failed(bot, ctx, `protected_workstation_position: ${policy.reason}`);
  const accessPolicy = authorizeWorkstationAccess(bot, ctx, position, {
    worldModel: worldModelResult.model,
    blockName: workstation,
  });
  if (!accessPolicy.ok) return failed(bot, ctx, `workstation access denied: ${accessPolicy.reason}`);
  if (isTaskProtected(position, protectedPositionsFromContext(ctx))) {
    return failed(bot, ctx, 'protected_workstation_position: target is protected by current task context');
  }

  let block = queryBlock(bot, position);
  if (block.error) return failed(bot, ctx, `world query failed checking workstation: ${block.error}`);
  if (!block.block || block.block.name !== workstation) {
    return failed(bot, ctx, `placed_position_unknown: expected ${workstation} at ${formatPos(position)}, found ${block.block?.name || 'none'}`);
  }

  if (!withinReach(bot, position, REACH_BLOCKS)) {
    const walked = await walkNear(bot, position, ctx, worldModelResult.model);
    if (walked.preempted || !walked.ok) return walked;
  }

  const before = readBotInventoryCounts(bot);
  if (!before.ok) return failed(bot, ctx, `inventory unavailable before workstation break: ${before.error}`);

  const cleared = await clearHand(bot, ctx, workstation);
  if (cleared.preempted || !cleared.ok) return cleared;

  block = queryBlock(bot, position);
  if (block.error) return failed(bot, ctx, `world query failed before workstation break: ${block.error}`);
  if (!block.block || block.block.name !== workstation) {
    return failed(bot, ctx, `placed_position_unknown: expected ${workstation} at ${formatPos(position)}, found ${block.block?.name || 'none'}`);
  }

  const finalPolicy = authorizeWorkstationAccess(bot, ctx, position, {
    worldModel: worldModelResult.model,
    blockName: workstation,
  });
  if (!finalPolicy.ok) return failed(bot, ctx, `workstation access denied: ${finalPolicy.reason}`);

  try {
    await runBoundedOperation(
      () => {
        assertWorldActionAuthorized(
          authorizeWorkstationAccess(bot, ctx, position, {
            worldModel: worldModelResult.model,
            blockName: workstation,
          }),
          'workstation break denied',
        );
        return bot.humanizer?.digBlock
          ? bot.humanizer.digBlock(bot, block.block, {
            reason: 'place_workstation.break',
            signal: ctx.signal,
            authorize: () => authorizeWorkstationAccess(bot, ctx, position, {
              worldModel: worldModelResult.model,
              blockName: workstation,
            }),
          })
          : bot.dig(block.block);
      },
      {
        timeoutMs: config.executor?.placeWorkstationBreakTimeoutMs ?? 15000,
        timeoutCode: 'PLACE_WORKSTATION_BREAK_TIMEOUT',
        timeoutMessage: `place_workstation break timed out for ${workstation}`,
        signal: ctx.signal,
        abortCode: 'PLACE_WORKSTATION_BREAK_ABORTED',
        abortMessage: 'place_workstation break aborted',
      },
    );
  } catch (err) {
    if (ctx.signal?.aborted || err?.code === 'PLACE_WORKSTATION_BREAK_ABORTED') {
      return preempted(bot, ctx, 'reactive preempt during workstation break');
    }
    return failed(bot, ctx, `workstation break failed: ${errorMessage(err)}`);
  }

  revokeWorldActionAnchor(bot, ctx, workstation, position);

  const pickedUp = await waitForInventoryIncrease(bot, workstation, before.inventory[workstation] || 0, ctx.signal, PICKUP_TIMEOUT_MS);
  if (pickedUp.preempted) return preempted(bot, ctx, pickedUp.reason);
  if (!pickedUp.ok) return failed(bot, ctx, 'pickup_failed');

  clearPlacedWorkstation(ctx, workstation, position);
  log.executor.info('place_workstation.recovered', {
    workstation,
    position: positionRecord(position),
    countBefore: before.inventory[workstation] || 0,
    countAfter: pickedUp.count,
  });

  return {
    ok: true,
    reason: `recovered ${workstation} from ${formatPos(position)}`,
    state: {
      ...buildSnapshot(bot, ctx),
      workstation,
      action: 'break_and_carry',
      recoveredAt: positionRecord(position),
      inventoryBefore: before.inventory[workstation] || 0,
      inventoryAfter: pickedUp.count,
    },
  };
}

function resolvePlacementOrigin(bot, params) {
  const provided = ['x', 'y', 'z'].filter((axis) => params[axis] !== undefined);
  if (provided.length > 0 && provided.length < 3) return { ok: false, reason: 'place_workstation requires x,y,z together or none' };
  if (provided.length === 3) {
    return { ok: true, target: new Vec3(Math.floor(params.x), Math.floor(params.y), Math.floor(params.z)) };
  }
  const base = bot.entity?.position;
  if (!base) return { ok: false, reason: 'bot position unavailable during place_workstation' };
  const forward = dominantForward(Number(bot.entity?.yaw ?? 0));
  return {
    ok: true,
    target: new Vec3(Math.floor(base.x) + forward.x, Math.floor(base.y), Math.floor(base.z) + forward.z),
  };
}

function selectSafePlacement(bot, origin, opts = {}) {
  const radius = opts.searchRadius ?? PLACEMENT_SEARCH_RADIUS;
  const verticalRadius = opts.verticalRadius ?? PLACEMENT_VERTICAL_RADIUS;
  const attempts = [];
  for (const offset of placementSearchOffsets(radius, verticalRadius)) {
    const candidate = origin.offset(offset.x, offset.y, offset.z);
    const validation = validateSafePlacement(bot, candidate, opts);
    attempts.push({
      target: positionRecord(candidate),
      ok: validation.ok,
      code: validation.code || (validation.ok ? 'ok' : 'invalid'),
      reason: validation.reason || null,
    });
    if (validation.ok) {
      return {
        ok: true,
        target: candidate,
        validation,
        summary: {
          radius,
          verticalRadius,
          origin: positionRecord(origin),
          checked: attempts.length,
          selected: positionRecord(candidate),
          elevatedSupport: validation.elevatedSupport === true,
        },
      };
    }
  }
  const failureCounts = {};
  for (const attempt of attempts) {
    if (attempt.ok) continue;
    failureCounts[attempt.code] = (failureCounts[attempt.code] || 0) + 1;
  }
  return {
    ok: false,
    reason: `no workstation placement within radius=${radius} verticalRadius=${verticalRadius} of ${formatPos(origin)}`,
    summary: {
      radius,
      verticalRadius,
      origin: positionRecord(origin),
      checked: attempts.length,
      failureCounts,
    },
  };
}

function validateSafePlacement(bot, target, opts = {}) {
  if (!withinReach(bot, target, REACH_BLOCKS)) return invalid('targetOutOfReach', `target ${formatPos(target)} is out of reach`);
  if (isBotOccupiedTarget(bot, target)) return invalid('targetOccupiedByBot', `target ${formatPos(target)} is occupied by bot`);
  if (isTaskProtected(target, opts.protectedPositions)) return invalid('targetProtected', 'target protected by current task context');

  const targetBlock = queryBlock(bot, target);
  if (targetBlock.error) return invalid('targetWorldQuery', `world query failed checking target: ${targetBlock.error}`);
  if (isHazardBlock(targetBlock.block)) return invalid('targetHazard', `hazard target ${targetBlock.block.name}`);
  if (!isReplaceable(targetBlock.block)) return invalid('targetBlocked', `target occupied by ${targetBlock.block?.name || 'unknown'}`);
  const targetPolicy = modificationPolicy(opts.worldModel, target);
  if (!targetPolicy.ok) return invalid('targetProtected', targetPolicy.reason);

  const head = target.offset(0, 1, 0);
  if (isTaskProtected(head, opts.protectedPositions)) return invalid('headProtected', 'headroom protected by current task context');
  const headBlock = queryBlock(bot, head);
  if (headBlock.error) return invalid('headWorldQuery', `world query failed checking headroom: ${headBlock.error}`);
  if (isHazardBlock(headBlock.block)) return invalid('headHazard', `hazard headroom ${headBlock.block.name}`);
  if (!isReplaceable(headBlock.block)) return invalid('headBlocked', `headroom occupied by ${headBlock.block?.name || 'unknown'}`);
  const headPolicy = modificationPolicy(opts.worldModel, head);
  if (!headPolicy.ok) return invalid('headProtected', headPolicy.reason);

  const supportPos = target.offset(0, -1, 0);
  if (isTaskProtected(supportPos, opts.protectedPositions)) return invalid('supportProtected', 'support protected by current task context');
  const support = queryBlock(bot, supportPos);
  if (support.error) return invalid('supportWorldQuery', `world query failed checking support: ${support.error}`);
  if (isHazardBlock(support.block)) return invalid('supportHazard', `hazard support ${support.block.name}`);
  if (!isSolidSupport(support.block)) return invalid('supportMissing', 'missing solid support');
  if (INTERACTIVE_SUPPORT_BLOCKS.has(support.block?.name)) {
    return invalid('supportInteractive', `interactive workstation support ${support.block.name} may consume placement activation`);
  }
  const supportPolicy = modificationPolicy(opts.worldModel, supportPos);
  if (!supportPolicy.ok) return invalid('supportProtected', supportPolicy.reason);

  const belowSupport = queryBlock(bot, supportPos.offset(0, -1, 0));
  if (belowSupport.error) return invalid('floorWorldQuery', `world query failed checking floor: ${belowSupport.error}`);
  if (isHazardBlock(belowSupport.block)) return invalid('floorUnsafe', 'hazard below placement support');

  return {
    ok: true,
    referenceBlock: support.block,
    faceVector: FACE_UP,
    elevatedSupport: isEmpty(belowSupport.block),
  };
}

function shouldWalkNearPlacementOrigin(summary = {}) {
  const checked = Number(summary.checked);
  const outOfReach = Number(summary.failureCounts?.targetOutOfReach || 0);
  return Number.isFinite(checked)
    && checked > 0
    && outOfReach > 0
    && outOfReach >= Math.max(1, Math.floor(checked * 0.5));
}

async function clearPlacementSpace(bot, targets, ctx, workstation) {
  for (const target of targets || []) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during place_workstation clear');
    const block = queryBlock(bot, target);
    if (block.error) return { ok: false, reason: `world query failed clearing placement space: ${block.error}` };
    if (isReplaceable(block.block)) continue;
    if (!canClearPlacementBlock(block.block, { allowClearing: true })) {
      return { ok: false, reason: `placement clear refused blocked ${block.block?.name || 'unknown'} at ${formatPos(target)}` };
    }
    log.executor.info('place_workstation.clear-space', {
      workstation,
      block: block.block.name,
      position: positionRecord(target),
    });
    const finalPolicy = authorizeBlockBreak(bot, ctx, block.block);
    if (!finalPolicy.ok) {
      return { ok: false, reason: `placement clear denied at ${formatPos(target)}: ${finalPolicy.reason}` };
    }
    try {
      await runBoundedOperation(
        () => {
          assertWorldActionAuthorized(
            authorizeBlockBreak(bot, ctx, block.block),
            `placement clear denied at ${formatPos(target)}`,
          );
          return bot.humanizer?.digBlock
            ? bot.humanizer.digBlock(bot, block.block, {
              reason: 'place_workstation.clear',
              signal: ctx.signal,
              authorize: () => authorizeBlockBreak(bot, ctx, block.block),
            })
            : bot.dig(block.block);
        },
        {
          timeoutMs: config.executor?.placeWorkstationClearTimeoutMs ?? 15000,
          timeoutCode: 'PLACE_WORKSTATION_CLEAR_TIMEOUT',
          timeoutMessage: `place_workstation clear timed out for ${block.block.name}`,
          signal: ctx.signal,
          abortCode: 'PLACE_WORKSTATION_CLEAR_ABORTED',
          abortMessage: 'place_workstation clear aborted',
        },
      );
      revokeWorldActionAnchor(bot, ctx, block.block.name, block.block.position || target);
    } catch (err) {
      if (ctx.signal?.aborted || err?.code === 'PLACE_WORKSTATION_CLEAR_ABORTED') {
        return preempted(bot, ctx, 'reactive preempt during place_workstation clear');
      }
      return { ok: false, reason: `placement clear failed: ${errorMessage(err)}` };
    }
  }
  return { ok: true };
}

async function equipWorkstationItem(bot, item, opts = {}) {
  if (typeof bot.equip !== 'function' && !bot.humanizer?.equipItem) {
    throw new Error('bot.equip unavailable');
  }
  return runBoundedOperation(
    () => bot.humanizer?.equipItem
      ? bot.humanizer.equipItem(bot, item, 'hand', {
        reason: 'place_workstation.equip',
        signal: opts.signal,
      })
      : bot.equip(item, 'hand'),
    {
      timeoutMs: config.executor?.equipOperationTimeoutMs ?? 10000,
      timeoutCode: 'PLACE_WORKSTATION_EQUIP_TIMEOUT',
      timeoutMessage: `place_workstation equip timed out for ${opts.workstation || item.name}`,
      signal: opts.signal,
      abortCode: 'PLACE_WORKSTATION_EQUIP_ABORTED',
      abortMessage: 'place_workstation equip aborted',
    },
  );
}

async function lookAtWorkstationTarget(bot, target, opts = {}) {
  if (typeof bot.humanizer?.lookAt !== 'function' && typeof bot.lookAt !== 'function') return;
  const lookTarget = target.offset(0.5, 0.5, 0.5);
  return runBoundedOperation(
    () => bot.humanizer?.lookAt
      ? bot.humanizer.lookAt(bot, lookTarget, {
        reason: 'place_workstation.lookAt',
        signal: opts.signal,
      })
      : bot.lookAt(lookTarget, true),
    {
      timeoutMs: config.executor?.placeWorkstationLookTimeoutMs ?? 5000,
      timeoutCode: 'PLACE_WORKSTATION_LOOK_TIMEOUT',
      timeoutMessage: `place_workstation look timed out for ${opts.workstation || 'workstation'}`,
      signal: opts.signal,
      abortCode: 'PLACE_WORKSTATION_LOOK_ABORTED',
      abortMessage: 'place_workstation look aborted',
    },
  );
}

async function placeWorkstationBlock(bot, referenceBlock, faceVector, opts = {}) {
  if (typeof bot.placeBlock !== 'function' && !bot.humanizer?.placeBlock) {
    throw new Error('bot.placeBlock unavailable');
  }
  return runBoundedOperation(
    () => {
      assertWorldActionAuthorized(
        typeof opts.authorize === 'function' ? opts.authorize() : { ok: true },
        'workstation placement denied',
      );
      return bot.humanizer?.placeBlock
        ? bot.humanizer.placeBlock(bot, referenceBlock, faceVector, {
          reason: 'place_workstation.block',
          signal: opts.signal,
          authorize: opts.authorize,
        })
        : bot.placeBlock(referenceBlock, faceVector);
    },
    {
      timeoutMs: config.executor?.placeBlockOperationTimeoutMs ?? 10000,
      timeoutCode: 'PLACE_WORKSTATION_BLOCK_TIMEOUT',
      timeoutMessage: `place_workstation block place timed out for ${opts.workstation || 'workstation'}`,
      signal: opts.signal,
      abortCode: 'PLACE_WORKSTATION_BLOCK_ABORTED',
      abortMessage: 'place_workstation block place aborted',
    },
  );
}

function assertWorldActionAuthorized(decision, prefix) {
  if (decision?.ok === true) return;
  const error = new Error(`${prefix}: ${decision.reason || 'world action denied'}`);
  error.code = 'WORLD_ACTION_DENIED';
  throw error;
}

async function waitForPlacedBlock(bot, target, blockName, signal, timeoutMs = 3000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    if (signal?.aborted) return { preempted: true, reason: 'reactive preempt verifying workstation placement' };
    last = queryBlock(bot, target);
    if (last.error || last.block?.name === blockName) return last;
    await sleep(100, signal);
  }
  return last || queryBlock(bot, target);
}

async function walkNear(bot, position, ctx, worldModel) {
  const acquired = acquirePathfinder(bot, 'place_workstation.walk', { skill: 'place_workstation', phase: 'break_walk' });
  if (!acquired.ok) return failed(bot, ctx, `pathfinder acquire failed during place_workstation walk: ${acquired.message}`);
  const acq = acquired.acq;
  if (!acq) return preempted(bot, ctx, 'reactive holds pathfinder');
  try {
    const movementConfig = configurePathingMovements(bot, ctx, {
      phase: 'place_workstation',
      allowParkour: false,
      allowSprinting: false,
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
    const goal = new pfGoals.GoalNear(position.x, position.y, position.z, BREAK_WALK_RANGE);
    const installed = setPathfinderGoal(bot, acq.token, goal, { movements: movementConfig.movements }, { skill: 'place_workstation', phase: 'break_walk' });
    if (!installed.ok) return failed(bot, ctx, `pathfinder setGoal failed during place_workstation walk: ${installed.message}`);
    const reached = await awaitGoalReached(bot, ctx.signal, BREAK_WALK_TIMEOUT_MS, { ownerToken: acq.token });
    if (reached.kind === 'reached') return { ok: true };
    if (reached.kind === 'preempted') return preempted(bot, ctx, 'reactive preempt during place_workstation walk');
    return failed(bot, ctx, `place_workstation walk failed: ${pathingFailureReason(reached)}`);
  } finally {
    releasePathfinder(acq, { skill: 'place_workstation', phase: 'break_walk' });
  }
}

async function clearHand(bot, ctx, workstation) {
  if (!bot.heldItem || bot.heldItem.name === 'air') return { ok: true };
  if (typeof bot.unequip !== 'function') return { ok: true };
  try {
    await runBoundedOperation(
      () => bot.unequip('hand'),
      {
        timeoutMs: config.executor?.equipOperationTimeoutMs ?? 10000,
        timeoutCode: 'PLACE_WORKSTATION_UNEQUIP_TIMEOUT',
        timeoutMessage: `place_workstation unequip timed out before breaking ${workstation}`,
        signal: ctx.signal,
        abortCode: 'PLACE_WORKSTATION_UNEQUIP_ABORTED',
        abortMessage: 'place_workstation unequip aborted',
      },
    );
    return { ok: true };
  } catch (err) {
    if (ctx.signal?.aborted || err?.code === 'PLACE_WORKSTATION_UNEQUIP_ABORTED') {
      return preempted(bot, ctx, 'reactive preempt during place_workstation unequip');
    }
    return failed(bot, ctx, `workstation unequip failed: ${errorMessage(err)}`);
  }
}

async function waitForInventoryIncrease(bot, name, beforeCount, signal, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (signal?.aborted) return { preempted: true, reason: 'reactive preempt waiting for workstation pickup' };
    const inventory = readBotInventoryCounts(bot);
    if (!inventory.ok) return { ok: false, reason: inventory.error };
    const count = inventory.inventory[name] || 0;
    if (count > beforeCount) return { ok: true, count };
    await sleep(100, signal);
  }
  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) return { ok: false, reason: inventory.error };
  return { ok: false, count: inventory.inventory[name] || 0 };
}

function recordPlacedWorkstation(ctx, workstation, position) {
  const store = placedWorkstationStore(ctx, true);
  store[workstation] = positionRecord(position);
}

function clearPlacedWorkstation(ctx, workstation, position) {
  const store = placedWorkstationStore(ctx, false);
  if (!store) return;
  const current = store[workstation];
  if (!current || sameBlock(current, position)) delete store[workstation];
}

function resolveBreakPosition(workstation, params, ctx) {
  const provided = ['x', 'y', 'z'].filter((axis) => params[axis] !== undefined);
  if (provided.length === 3) return new Vec3(Math.floor(params.x), Math.floor(params.y), Math.floor(params.z));
  if (provided.length > 0) return null;
  const stored = placedWorkstationStore(ctx, false)?.[workstation];
  return stored ? vec3FromPosition(stored) : null;
}

function placedWorkstationStore(ctx, create) {
  const runtime = ctx.runtimeContext && typeof ctx.runtimeContext === 'object'
    ? ctx.runtimeContext
    : ctx;
  if (!runtime) return null;
  if (!runtime.placedWorkstations && create) runtime.placedWorkstations = {};
  return runtime.placedWorkstations || null;
}

function protectedPositionsFromContext(ctx = {}) {
  const values = [
    ctx.collectProtectedPositions,
    ctx.protectedPositions,
    ctx.runtimeContext?.collectProtectedPositions,
    ctx.runtimeContext?.protectedPositions,
  ];
  const out = new Set();
  for (const value of values) {
    if (!value) continue;
    if (value instanceof Set) {
      for (const key of value) out.add(String(key));
    } else if (Array.isArray(value)) {
      for (const position of value) {
        if (position) out.add(posKey(position));
      }
    }
  }
  return out.size > 0 ? out : null;
}

function isTaskProtected(position, protectedPositions) {
  return Boolean(protectedPositions?.has?.(posKey(position)));
}

function modificationPolicy(worldModel, position) {
  if (!worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(worldModel, position, { margin: 0 });
}

function placementSearchOffsets(radius, verticalRadius) {
  const horizontal = orderedOffsets(radius);
  const vertical = orderedOffsets(verticalRadius);
  const offsets = [];
  for (const dy of vertical) {
    for (const dx of horizontal) {
      for (const dz of horizontal) offsets.push({ x: dx, y: dy, z: dz });
    }
  }
  return offsets;
}

function orderedOffsets(radius) {
  const offsets = [0];
  for (let distance = 1; distance <= radius; distance++) offsets.push(distance, -distance);
  return offsets;
}

function dominantForward(yaw) {
  const dx = Math.round(-Math.sin(yaw));
  const dz = Math.round(-Math.cos(yaw));
  return dx === 0 && dz === 0 ? { x: 0, z: -1 } : { x: dx, z: dz };
}

function queryBlock(bot, position) {
  try {
    return { block: bot.blockAt(position) || null };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function isReplaceable(block) {
  if (!block) return false;
  return REPLACEABLE_BLOCKS.has(block.name) || (block.boundingBox === 'empty' && !isHazardBlock(block) && block.name !== 'water');
}

function isSolidSupport(block) {
  return Boolean(block && !isEmpty(block) && block.boundingBox === 'block');
}

function isEmpty(block) {
  return EMPTY_BLOCKS.has(block?.name);
}

function isHazardBlock(block) {
  return HAZARD_BLOCKS.has(block?.name);
}

function isBotOccupiedTarget(bot, target) {
  const position = bot.entity?.position;
  if (!position) return false;
  const feet = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  const head = feet.offset(0, 1, 0);
  return sameBlock(target, feet) || sameBlock(target, head);
}

function withinReach(bot, target, maxDistance) {
  const pos = bot.entity?.position;
  if (!pos) return false;
  return pos.distanceTo(target.offset(0.5, 0.5, 0.5)) <= maxDistance;
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function failed(bot, ctx, reason) {
  return { ok: false, reason, state: buildSnapshot(bot, ctx) };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}

function normalizeName(name) {
  return typeof name === 'string' ? name.replace(/^minecraft:/, '').trim() : '';
}

function vec3FromPosition(position) {
  if (position?.clone) return position.clone();
  return new Vec3(Number(position.x), Number(position.y), Number(position.z));
}

function positionRecord(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function sameBlock(a, b) {
  return Boolean(a && b && Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z));
}

function posKey(position) {
  return `${Math.floor(Number(position.x))},${Math.floor(Number(position.y))},${Math.floor(Number(position.z))}`;
}

function formatPos(position) {
  return `${position.x},${position.y},${position.z}`;
}

function errorMessage(err) {
  return err?.message || String(err);
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
