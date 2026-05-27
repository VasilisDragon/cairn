import pkgPathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import config from '../config.js';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { readBotInventoryItems } from '../state/materials.js';
import { blockModificationPolicy } from '../state/world_model.js';
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
const REACH_BLOCKS = 4.5;
const PATH_RANGE_BLOCKS = 3;
const PATH_TIMEOUT_MS = 60000;
const PLACEMENT_SEARCH_RADIUS = 2;
const PLACEMENT_SEARCH_VERTICAL_RADIUS = 1;
const FACE_UP = new Vec3(0, 1, 0);
const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE_TARGET_BLOCKS = new Set([
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
  'crimson_roots',
  'warped_roots',
  'nether_sprouts',
]);
const HAZARD_BLOCKS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'wither_rose',
]);

export async function run(bot, params, ctx) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');

  const blockName = normalizeName(params.block);
  if (!blockName) return { ok: false, reason: 'place requires block', state: buildSnapshot(bot, ctx) };

  const blockType = registryLookup(bot.registry?.blocksByName, blockName);
  if (!blockType) return { ok: false, reason: `unknown block "${blockName}"`, state: buildSnapshot(bot, ctx) };

  const inventory = readBotInventoryItems(bot);
  if (!inventory.ok) {
    return { ok: false, reason: `inventory unavailable during place: ${inventory.error}`, state: buildSnapshot(bot, ctx) };
  }
  const item = selectInventoryItem(inventory.items, blockName);
  if (!item) return { ok: false, reason: `no ${blockName} in inventory`, state: buildSnapshot(bot, ctx) };

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for place chunk readiness');
  if (chunks.preempted) return { preempted: true, reason: chunks.reason, state: buildSnapshot(bot, ctx) };
  if (chunks.error) return { ok: false, reason: `chunk data unavailable during place: ${errorMessage(chunks.error)}`, state: buildSnapshot(bot, ctx) };

  const worldModelResult = worldModelFromContext(ctx);
  if (worldModelResult.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during place: ${worldModelResult.error.message}`,
      state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
    };
  }
  const worldModel = worldModelResult.model;

  const targetResult = resolveTarget(bot, params);
  if (!targetResult.ok) return { ...targetResult, state: buildSnapshot(bot, ctx) };
  const requestedTarget = targetResult.target;

  let selectedTarget = selectPlacementTarget(bot, requestedTarget, { blockName, worldModel });
  if (!selectedTarget.ok) return { ...selectedTarget, state: buildSnapshot(bot, ctx) };
  let target = selectedTarget.target;
  let validation = selectedTarget.validation;
  if (selectedTarget.adjusted) {
    log.executor.info('place.target-adjusted', {
      block: blockName,
      requestedTarget: positionRecord(requestedTarget),
      actualTarget: positionRecord(target),
      search: selectedTarget.search,
    });
  }

  if (!withinReach(bot, target, REACH_BLOCKS)) {
    const walk = await walkWithinPlaceReach(bot, target, ctx, worldModel);
    if (walk.preempted || !walk.ok) return walk;
    validation = validatePlacementTarget(bot, target, { blockName, worldModel, requireReach: true });
    if (!validation.ok) return { ...validation, state: buildSnapshot(bot, ctx) };
    if (!withinReach(bot, target, REACH_BLOCKS)) {
      return {
        ok: false,
        reason: `target ${formatPos(target)} remains out of reach after pathing`,
        state: buildSnapshot(bot, ctx),
      };
    }
  }

  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted before place');
  try {
    await equipBlockItem(bot, item, { blockName, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during place equip');
    return { ok: false, reason: `place equip failed: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
  }

  try {
    await lookAtPlacement(bot, target, { blockName, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during place look');
    return { ok: false, reason: `place look failed: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
  }

  if (typeof bot.placeBlock !== 'function') {
    return { ok: false, reason: 'bot.placeBlock unavailable', state: buildSnapshot(bot, ctx) };
  }
  let primaryPlaceError = null;
  try {
    await placeBlock(bot, validation.referenceBlock, validation.faceVector, {
      blockName,
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during place');
    primaryPlaceError = err;
    const fallback = await activatePlacementFallback(bot, validation.referenceBlock, validation.faceVector, {
      blockName,
      signal: ctx.signal,
    });
    if (fallback.preempted) return preempted(bot, ctx, fallback.reason);
    if (!fallback.ok) {
      return {
        ok: false,
        reason: `place failed: ${errorMessage(primaryPlaceError)}; activate fallback failed: ${fallback.reason}`,
        state: buildSnapshot(bot, ctx),
      };
    }
  }

  const placed = await waitForPlacedBlock(bot, target, blockName, ctx.signal);
  if (placed.preempted) return preempted(bot, ctx, placed.reason);
  if (placed.error) return { ok: false, reason: `world query failed verifying placement: ${placed.error}`, state: buildSnapshot(bot, ctx) };
  if (placed.block?.name !== blockName) {
    return {
      ok: false,
      reason: `placement verification failed: expected ${blockName} at ${formatPos(target)}, found ${placed.block?.name || 'none'}`,
      state: buildSnapshot(bot, ctx),
    };
  }

  const reason = selectedTarget.adjusted
    ? `placed ${blockName} at ${formatPos(target)} (requested ${formatPos(requestedTarget)})`
    : `placed ${blockName} at ${formatPos(target)}`;

  return {
    ok: true,
    reason,
    state: {
      ...buildSnapshot(bot, ctx),
      placedAt: positionRecord(target),
      requestedPlaceAt: positionRecord(requestedTarget),
      placementAdjusted: selectedTarget.adjusted,
      placementSearch: selectedTarget.search || null,
      blockName,
    },
  };
}

function resolveTarget(bot, params) {
  const provided = ['x', 'y', 'z'].filter((axis) => params[axis] !== undefined);
  if (provided.length > 0 && provided.length < 3) {
    return { ok: false, reason: 'place requires x,y,z together or none' };
  }
  if (provided.length === 3) {
    return { ok: true, target: new Vec3(Math.floor(params.x), Math.floor(params.y), Math.floor(params.z)) };
  }

  const base = bot.entity?.position;
  if (!base) return { ok: false, reason: 'bot position unavailable during place' };
  const yaw = Number(bot.entity?.yaw ?? 0);
  const forward = dominantForward(yaw);
  return {
    ok: true,
    target: new Vec3(
      Math.floor(base.x) + forward.x,
      Math.floor(base.y),
      Math.floor(base.z) + forward.z,
    ),
  };
}

function dominantForward(yaw) {
  const dx = Math.round(-Math.sin(yaw));
  const dz = Math.round(-Math.cos(yaw));
  if (dx === 0 && dz === 0) return { x: 0, z: -1 };
  return { x: dx, z: dz };
}

function selectPlacementTarget(bot, requestedTarget, opts = {}) {
  const requestedValidation = validatePlacementTarget(bot, requestedTarget, opts);
  if (requestedValidation.ok) {
    return {
      ok: true,
      target: requestedTarget,
      validation: requestedValidation,
      adjusted: false,
      search: null,
    };
  }

  const search = findNearbyPlacementTarget(bot, requestedTarget, opts);
  if (search.ok) {
    return {
      ok: true,
      target: search.target,
      validation: search.validation,
      adjusted: !samePosition(requestedTarget, search.target),
      search: search.summary,
    };
  }

  return {
    ok: false,
    reason: search.reason,
    requestedTarget: positionRecord(requestedTarget),
    placementSearch: search.summary,
    initialReason: requestedValidation.reason,
  };
}

function findNearbyPlacementTarget(bot, origin, opts = {}) {
  const radius = opts.searchRadius ?? PLACEMENT_SEARCH_RADIUS;
  const verticalRadius = opts.verticalRadius ?? PLACEMENT_SEARCH_VERTICAL_RADIUS;
  const attempts = [];
  for (const offset of placementSearchOffsets(radius, verticalRadius)) {
    const candidate = origin.offset(offset.x, offset.y, offset.z);
    const validation = validatePlacementTarget(bot, candidate, opts);
    const attempt = {
      target: positionRecord(candidate),
      ok: validation.ok,
      code: validation.code || (validation.ok ? 'ok' : 'invalid'),
      reason: validation.reason || null,
    };
    attempts.push(attempt);
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
          initialReason: attempts[0]?.reason || null,
        },
      };
    }
  }

  const summary = summarizePlacementSearch(origin, radius, verticalRadius, attempts);
  return {
    ok: false,
    reason: summary.reason,
    summary,
  };
}

function placementSearchOffsets(radius, verticalRadius) {
  const horizontal = orderedOffsets(radius);
  const vertical = orderedOffsets(verticalRadius);
  const offsets = [];
  for (const dy of vertical) {
    for (const dx of horizontal) {
      for (const dz of horizontal) {
        offsets.push({ x: dx, y: dy, z: dz });
      }
    }
  }
  return offsets;
}

function orderedOffsets(radius) {
  const offsets = [0];
  for (let distance = 1; distance <= radius; distance++) {
    offsets.push(distance, -distance);
  }
  return offsets;
}

function summarizePlacementSearch(origin, radius, verticalRadius, attempts) {
  const counts = new Map();
  for (const attempt of attempts) {
    if (attempt.ok) continue;
    counts.set(attempt.code, (counts.get(attempt.code) || 0) + 1);
  }
  const reasonParts = [...counts.entries()]
    .map(([code, count]) => `${count} ${placementFailureLabel(code)}`);
  const reason = [
    `no valid placement target within radius=${radius} verticalRadius=${verticalRadius} of (${formatPos(origin)})`,
    `${attempts.length} candidates checked`,
    ...reasonParts,
  ].join('; ');
  return {
    radius,
    verticalRadius,
    origin: positionRecord(origin),
    checked: attempts.length,
    failureCounts: Object.fromEntries(counts.entries()),
    reason,
  };
}

function placementFailureLabel(code) {
  return {
    targetWorldQuery: 'had target query errors',
    targetHazard: 'were hazardous targets',
    targetBlocked: 'were blocked above',
    targetOccupiedByBot: 'were occupied by the bot',
    targetProtected: 'were protected targets',
    supportWorldQuery: 'had support query errors',
    supportMissing: 'lacked solid support',
    supportHazard: 'had hazardous support',
    supportProtected: 'had protected support',
    floorWorldQuery: 'had floor query errors',
    floorUnsafe: 'had unsafe floor below support',
    targetOutOfReach: 'were out of reach',
    invalid: 'were invalid',
  }[code] || `failed ${code}`;
}

function validatePlacementTarget(bot, target, opts = {}) {
  const targetBlock = queryBlock(bot, target);
  if (targetBlock.error) {
    return invalidPlacement('targetWorldQuery', `world query failed checking placement target: ${targetBlock.error}`);
  }
  if (isHazardBlock(targetBlock.block)) {
    return invalidPlacement('targetHazard', `unsafe placement target ${targetBlock.block.name} at ${formatPos(target)}`);
  }
  if (!isReplaceableTarget(targetBlock.block)) {
    return invalidPlacement('targetBlocked', `placement target ${formatPos(target)} is occupied by ${targetBlock.block?.name || 'unknown'}`);
  }
  if (isBotOccupiedTarget(bot, target)) {
    return invalidPlacement('targetOccupiedByBot', `placement target ${formatPos(target)} is occupied by the bot`);
  }

  const targetPolicy = placementPolicy(opts.worldModel, target);
  if (!targetPolicy.ok) {
    return invalidPlacement('targetProtected', `protected placement target: ${targetPolicy.reason}`, { policy: targetPolicy });
  }

  const supportPos = target.offset(0, -1, 0);
  const support = queryBlock(bot, supportPos);
  if (support.error) {
    return invalidPlacement('supportWorldQuery', `world query failed checking placement support: ${support.error}`);
  }
  if (isHazardBlock(support.block)) {
    return invalidPlacement('supportHazard', `unsafe placement support ${support.block.name} below ${formatPos(target)}`);
  }
  if (!isSolidSupport(support.block)) {
    return invalidPlacement('supportMissing', `no solid support below placement target ${formatPos(target)}`);
  }

  const supportPolicy = placementPolicy(opts.worldModel, supportPos);
  if (!supportPolicy.ok) {
    return invalidPlacement('supportProtected', `protected placement support: ${supportPolicy.reason}`, { policy: supportPolicy });
  }

  const belowSupport = queryBlock(bot, supportPos.offset(0, -1, 0));
  if (belowSupport.error) {
    return invalidPlacement('floorWorldQuery', `world query failed checking placement floor: ${belowSupport.error}`);
  }
  if (isHazardBlock(belowSupport.block) || isEmptyBlock(belowSupport.block)) {
    return invalidPlacement('floorUnsafe', `unsafe cliff-edge placement below ${formatPos(target)}`);
  }
  if (opts.requireReach === true && !withinReach(bot, target, opts.reachBlocks ?? REACH_BLOCKS)) {
    return invalidPlacement('targetOutOfReach', `placement target ${formatPos(target)} is out of reach`);
  }

  return {
    ok: true,
    referenceBlock: support.block,
    faceVector: FACE_UP,
  };
}

function invalidPlacement(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

async function walkWithinPlaceReach(bot, target, ctx, worldModel) {
  const acquired = acquirePathfinder(bot, 'place.walk', { skill: 'place', phase: 'walk' });
  if (!acquired.ok) {
    return { ok: false, reason: `pathfinder acquire failed during place walk: ${acquired.message}`, state: buildSnapshot(bot, ctx) };
  }
  const acq = acquired.acq;
  if (!acq) return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };
  try {
    const movementConfig = configurePathingMovements(bot, ctx, {
      phase: 'place',
      allowParkour: false,
      allowSprinting: true,
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
    const goal = new pfGoals.GoalNear(target.x, target.y, target.z, PATH_RANGE_BLOCKS);
    const installed = setPathfinderGoal(bot, acq.token, goal, { movements: movementConfig.movements }, { skill: 'place', phase: 'walk' });
    if (!installed.ok) {
      const reason = installed.denied
        ? 'pathfinder setGoal denied'
        : `pathfinder setGoal failed during place walk: ${installed.message}`;
      return { ok: false, reason, state: buildSnapshot(bot, ctx) };
    }
    const reached = await awaitGoalReached(bot, ctx.signal, PATH_TIMEOUT_MS, { ownerToken: acq.token });
    if (reached.kind === 'preempted') return { preempted: true, reason: 'reactive preempt walking to place', state: buildSnapshot(bot, ctx) };
    if (reached.kind !== 'reached') {
      return { ok: false, reason: `walk to placement target: ${pathingFailureReason(reached)}`, state: buildSnapshot(bot, ctx) };
    }
    return { ok: true };
  } finally {
    releasePathfinder(acq, { skill: 'place', phase: 'walk' });
  }
}

async function equipBlockItem(bot, item, opts = {}) {
  const timeoutMs = config.executor?.equipOperationTimeoutMs ?? 10000;
  try {
    return await runBoundedOperation(
      () => bot.humanizer?.equipItem
        ? bot.humanizer.equipItem(bot, item, 'hand', {
          reason: 'place.equip',
          signal: opts.signal,
        })
        : bot.equip(item, 'hand'),
      {
        timeoutMs,
        timeoutCode: 'PLACE_EQUIP_OPERATION_TIMEOUT',
        timeoutMessage: `place equip operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'PLACE_EQUIP_OPERATION_ABORTED',
        abortMessage: 'place equip operation aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'PLACE_EQUIP_OPERATION_TIMEOUT') {
      log.executor.warn('place.equip-operation-timeout', {
        block: opts.blockName,
        timeoutMs,
        err: err.message,
      });
    }
    throw err;
  }
}

async function placeBlock(bot, referenceBlock, faceVector, opts = {}) {
  const timeoutMs = config.executor?.placeBlockOperationTimeoutMs ?? 10000;
  try {
    return await runBoundedOperation(
      () => bot.humanizer?.placeBlock
        ? bot.humanizer.placeBlock(bot, referenceBlock, faceVector, {
          reason: 'place.block',
          signal: opts.signal,
        })
        : bot.placeBlock(referenceBlock, faceVector),
      {
        timeoutMs,
        timeoutCode: 'PLACE_BLOCK_OPERATION_TIMEOUT',
        timeoutMessage: `place block operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'PLACE_BLOCK_OPERATION_ABORTED',
        abortMessage: 'place block operation aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'PLACE_BLOCK_OPERATION_TIMEOUT') {
      log.executor.warn('place.operation-timeout', {
        block: opts.blockName,
        referenceBlock: blockRecord(referenceBlock),
        faceVector: positionRecord(faceVector),
        timeoutMs,
        err: err.message,
      });
    }
    throw err;
  }
}

async function activatePlacementFallback(bot, referenceBlock, faceVector, opts = {}) {
  if (typeof bot.activateBlock !== 'function') {
    return { ok: false, reason: 'bot.activateBlock unavailable' };
  }
  const timeoutMs = config.executor?.placeBlockOperationTimeoutMs ?? 10000;
  try {
    await runBoundedOperation(
      () => bot.humanizer?.activateBlock
        ? bot.humanizer.activateBlock(bot, referenceBlock, {
          reason: 'place.activate-fallback',
          signal: opts.signal,
          faceVector,
          cursorVector: new Vec3(0.5, 1, 0.5),
        })
        : bot.activateBlock(referenceBlock, faceVector, new Vec3(0.5, 1, 0.5)),
      {
        timeoutMs,
        timeoutCode: 'PLACE_ACTIVATE_OPERATION_TIMEOUT',
        timeoutMessage: `place activate fallback timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'PLACE_ACTIVATE_OPERATION_ABORTED',
        abortMessage: 'place activate fallback aborted',
      },
    );
    log.executor.warn('place.activate-fallback-used', {
      block: opts.blockName,
      referenceBlock: blockRecord(referenceBlock),
      faceVector: positionRecord(faceVector),
    });
    return { ok: true };
  } catch (err) {
    if (opts.signal?.aborted) return { preempted: true, reason: 'reactive preempt during place activate fallback' };
    return { ok: false, reason: errorMessage(err) };
  }
}

async function waitForPlacedBlock(bot, target, blockName, signal, timeoutMs = 3000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    if (signal?.aborted) return { preempted: true, reason: 'reactive preempt verifying placement' };
    last = queryBlock(bot, target);
    if (last.error || last.block?.name === blockName) return last;
    try {
      await sleep(100, signal);
    } catch {
      return { preempted: true, reason: 'reactive preempt verifying placement' };
    }
  }
  return last || queryBlock(bot, target);
}

async function lookAtPlacement(bot, target, opts = {}) {
  const timeoutMs = config.executor?.lookOperationTimeoutMs ?? 5000;
  const lookTarget = target.offset(0.5, 0, 0.5);
  if (typeof bot.humanizer?.lookAt !== 'function' && typeof bot.lookAt !== 'function') return null;
  try {
    return await runBoundedOperation(
      () => bot.humanizer?.lookAt
        ? bot.humanizer.lookAt(bot, lookTarget, {
          reason: 'place.look',
          signal: opts.signal,
        })
        : bot.lookAt(lookTarget, true),
      {
        timeoutMs,
        timeoutCode: 'PLACE_LOOK_OPERATION_TIMEOUT',
        timeoutMessage: `place look operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'PLACE_LOOK_OPERATION_ABORTED',
        abortMessage: 'place look operation aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'PLACE_LOOK_OPERATION_TIMEOUT') {
      log.executor.warn('place.look-operation-timeout', {
        block: opts.blockName,
        target: positionRecord(target),
        timeoutMs,
        err: err.message,
      });
    }
    throw err;
  }
}

function selectInventoryItem(items, name) {
  return (items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.name === name && Number(item.count ?? 1) > 0)
    .sort((a, b) => itemSlot(a.item) - itemSlot(b.item) || a.index - b.index)
    .at(0)?.item || null;
}

function registryLookup(registry, name) {
  if (!registry) return null;
  if (registry instanceof Map) return registry.get(name) || null;
  return registry[name] || null;
}

function placementPolicy(worldModel, position) {
  if (!worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(worldModel, position, { margin: 0 });
}

function isEmptyBlock(block) {
  return EMPTY_BLOCKS.has(block?.name);
}

function isReplaceableTarget(block) {
  if (!block) return false;
  if (REPLACEABLE_TARGET_BLOCKS.has(block.name)) return true;
  return block.boundingBox === 'empty' && !isHazardBlock(block) && block.name !== 'water';
}

function isSolidSupport(block) {
  return Boolean(block && !isEmptyBlock(block) && block.boundingBox === 'block');
}

function isHazardBlock(block) {
  return HAZARD_BLOCKS.has(block?.name);
}

function isBotOccupiedTarget(bot, target) {
  const position = bot.entity?.position;
  if (!position) return false;
  const feet = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
  const head = { ...feet, y: feet.y + 1 };
  return samePosition(target, feet) || samePosition(target, head);
}

function withinReach(bot, target, maxDistance) {
  const pos = bot.entity?.position;
  if (!pos) return false;
  return pos.distanceTo(target.offset(0.5, 0.5, 0.5)) <= maxDistance;
}

function queryBlock(bot, position) {
  try {
    return { block: bot.blockAt(position) || null };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function normalizeName(name) {
  return typeof name === 'string' ? name.replace(/^minecraft:/, '').trim() : '';
}

function itemSlot(item) {
  const slot = Number(item?.slot);
  return Number.isFinite(slot) ? slot : Number.MAX_SAFE_INTEGER;
}

function blockRecord(block) {
  if (!block) return null;
  return {
    name: block.name ?? null,
    position: positionRecord(block.position),
  };
}

function positionRecord(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function samePosition(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function formatPos(position) {
  return `${position.x},${position.y},${position.z}`;
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}

function errorMessage(err) {
  return err?.message || String(err);
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
