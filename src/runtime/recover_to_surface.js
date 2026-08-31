import { Vec3 } from 'vec3';
import config from '../config.js';
import log from '../logger.js';
import { readBotInventoryItems } from '../state/materials.js';
import { authorizePlacement } from '../state/world_action_authorization.js';
import { runBoundedOperation } from '../skills/_operations.js';

const FACE_UP = new Vec3(0, 1, 0);
const AIR_LIKE_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const HAZARD_BLOCKS = new Set(['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'cactus']);
const UNSTABLE_SURFACE_FLOORS = new Set([
  'oak_leaves',
  'spruce_leaves',
  'birch_leaves',
  'jungle_leaves',
  'acacia_leaves',
  'dark_oak_leaves',
  'mangrove_leaves',
  'cherry_leaves',
  'pale_oak_leaves',
  'azalea_leaves',
  'flowering_azalea_leaves',
]);
const DEFAULT_PILLAR_BLOCKS = Object.freeze(['dirt', 'cobblestone', 'stone']);
const DEFAULT_PRE_PLACE_JUMP_MS = 280;
const CARDINAL_OFFSETS = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]);

export function detectSelfDugHole(bot, opts = {}) {
  const position = bot.entity?.position;
  if (!position) return { ok: false, reason: 'bot position unavailable' };

  const currentY = Math.floor(position.y);
  const x = Math.floor(position.x);
  const z = Math.floor(position.z);
  const maxScanUp = positiveInteger(opts.maxScanUp, 8);
  const maxScanDown = positiveInteger(opts.maxScanDown, 1);
  const minHoleDepth = positiveInteger(opts.minHoleDepth, 3);
  const samples = [];

  for (const [dx, dz] of CARDINAL_OFFSETS) {
    const sample = findStandableSurface(bot, x + dx, z + dz, currentY, { maxScanUp, maxScanDown });
    if (sample.error) {
      return { ok: false, reason: sample.error, samples };
    }
    if (sample.standY !== null) samples.push(sample);
  }

  if (samples.length === 0) {
    return {
      ok: true,
      inHole: false,
      reason: 'no nearby standable surface samples',
      currentY,
      samples,
    };
  }

  const targetY = Math.max(...samples.map((sample) => sample.standY));
  const depth = targetY - currentY;
  return {
    ok: true,
    inHole: depth > minHoleDepth,
    reason: depth > minHoleDepth ? 'bot is below nearby standable terrain' : 'bot is not deep enough to pillar recover',
    currentY,
    targetY,
    depth,
    minHoleDepth,
    samples,
  };
}

export async function recoverToSurface(bot, ctx = {}, opts = {}) {
  const signal = ctx.signal || opts.signal || null;
  const detection = detectSelfDugHole(bot, opts);
  if (!detection.ok) return { ok: false, reason: detection.reason, detection };
  if (!detection.inHole) return { ok: true, action: 'none', reason: detection.reason, detection };

  const inventory = readBotInventoryItems(bot);
  if (!inventory.ok) return { ok: false, reason: `inventory unavailable during surface recovery: ${inventory.error}`, detection };
  const item = selectPillarItem(inventory.items, opts);
  if (!item) {
    return {
      ok: false,
      reason: `no pillar block available; need one of ${pillarBlockNames(opts).join(', ')}`,
      detection,
    };
  }

  const maxSteps = positiveInteger(opts.maxSteps, Math.max(1, detection.depth + 1));
  const startedAt = Date.now();
  let steps = 0;
  log.executor.info('recover-to-surface.start', {
    trigger: opts.trigger || null,
    currentY: detection.currentY,
    targetY: detection.targetY,
    depth: detection.depth,
    block: item.name,
    maxSteps,
  });

  while (steps < maxSteps && Math.floor(bot.entity?.position?.y ?? -Infinity) < detection.targetY) {
    if (signal?.aborted) return { preempted: true, reason: 'reactive preempt during surface recovery', detection };
    const beforeY = bot.entity?.position?.y ?? null;
    const step = await pillarStep(bot, item, signal, ctx, opts);
    if (step.preempted) return { preempted: true, reason: step.reason, detection };
    if (!step.ok) {
      return {
        ok: false,
        reason: `surface recovery pillar step failed: ${step.reason}`,
        detection,
        steps,
        finalY: bot.entity?.position?.y ?? null,
      };
    }
    steps += 1;
    log.executor.info('recover-to-surface.step', {
      step: steps,
      block: item.name,
      beforeY,
      afterY: bot.entity?.position?.y ?? null,
      targetY: detection.targetY,
      reference: step.reference,
    });
    await sleepSignalAware(positiveInteger(opts.stepSettleMs, 180), signal);
  }

  const finalY = bot.entity?.position?.y ?? null;
  const recovered = Math.floor(finalY ?? -Infinity) >= detection.targetY;
  return {
    ok: recovered,
    action: 'pillar_up',
    reason: recovered ? 'recovered to nearby surface height' : 'pillar recovery stopped before reaching target height',
    steps,
    block: item.name,
    startY: detection.currentY,
    targetY: detection.targetY,
    finalY,
    elapsedMs: Date.now() - startedAt,
    detection,
  };
}

async function pillarStep(bot, item, signal, ctx = {}, opts = {}) {
  const grounded = await waitForPillarGround(bot, signal, opts);
  if (grounded.preempted) return { preempted: true, reason: grounded.reason };
  if (!grounded.ok) return { ok: false, reason: grounded.reason };

  const supportPosition = supportUnderPosition(bot.entity?.position);
  if (!supportPosition) return { ok: false, reason: 'bot position unavailable' };

  let referenceBlock = null;
  try {
    referenceBlock = typeof bot.blockAt === 'function' ? bot.blockAt(supportPosition) : null;
  } catch (err) {
    return { ok: false, reason: `support block query failed: ${errorMessage(err)}` };
  }
  if (!isSolidSupport(referenceBlock)) {
    return { ok: false, reason: `no solid support below bot at ${formatBlockPos(supportPosition)}` };
  }
  const placementTarget = {
    x: supportPosition.x,
    y: supportPosition.y + 1,
    z: supportPosition.z,
  };

  const equip = await equipPillarItem(bot, item, signal, opts);
  if (equip.preempted || !equip.ok) return equip;

  try {
    setControlState(bot, 'jump', true, { reason: 'recover_to_surface.jump', critical: true });
    await sleepSignalAware(positiveInteger(opts.prePlaceJumpMs, DEFAULT_PRE_PLACE_JUMP_MS), signal);
    if (signal?.aborted) return { preempted: true, reason: 'reactive preempt during surface recovery pillar step' };
    await runBoundedOperation(
      () => {
        const authorize = () => authorizePlacement(bot, ctx, placementTarget, {
          referencePosition: referenceBlock.position,
          referenceBlockName: referenceBlock.name,
        });
        const policy = authorize();
        if (!policy.ok) {
          const error = new Error(`surface recovery placement denied: ${policy.reason}`);
          error.code = 'WORLD_ACTION_DENIED';
          throw error;
        }
        return bot.humanizer?.placeBlock
          ? bot.humanizer.placeBlock(bot, referenceBlock, FACE_UP, {
            reason: 'recover_to_surface.pillar',
            signal,
            critical: true,
            authorize,
          })
          : bot.placeBlock(referenceBlock, FACE_UP);
      },
      {
        timeoutMs: positiveInteger(opts.placeTimeoutMs, config.executor?.placeBlockOperationTimeoutMs ?? 10000),
        timeoutCode: 'RECOVER_TO_SURFACE_PLACE_TIMEOUT',
        timeoutMessage: 'surface recovery pillar placement timed out',
        signal,
        abortCode: 'RECOVER_TO_SURFACE_PLACE_ABORTED',
        abortMessage: 'surface recovery pillar placement aborted',
      },
    );
    return { ok: true, reference: blockRecord(referenceBlock) };
  } catch (err) {
    if (signal?.aborted || err?.code === 'RECOVER_TO_SURFACE_PLACE_ABORTED') {
      return { preempted: true, reason: 'reactive preempt during surface recovery pillar placement' };
    }
    return { ok: false, reason: errorMessage(err) };
  } finally {
    setControlState(bot, 'jump', false, { reason: 'recover_to_surface.jump.clear', critical: true });
  }
}

async function equipPillarItem(bot, item, signal, opts = {}) {
  if (bot.heldItem?.name === item.name) return { ok: true, equipped: false };
  if (typeof bot.equip !== 'function') return { ok: true, equipped: false, reason: 'bot.equip unavailable' };
  try {
    await runBoundedOperation(
      () => bot.humanizer?.equipItem
        ? bot.humanizer.equipItem(bot, item, 'hand', {
          reason: 'recover_to_surface.equip',
          signal,
          critical: true,
        })
        : bot.equip(item, 'hand'),
      {
        timeoutMs: positiveInteger(opts.equipTimeoutMs, config.executor?.equipOperationTimeoutMs ?? 5000),
        timeoutCode: 'RECOVER_TO_SURFACE_EQUIP_TIMEOUT',
        timeoutMessage: 'surface recovery equip timed out',
        signal,
        abortCode: 'RECOVER_TO_SURFACE_EQUIP_ABORTED',
        abortMessage: 'surface recovery equip aborted',
      },
    );
    return { ok: true, equipped: true };
  } catch (err) {
    if (signal?.aborted || err?.code === 'RECOVER_TO_SURFACE_EQUIP_ABORTED') {
      return { preempted: true, reason: 'reactive preempt during surface recovery equip' };
    }
    return { ok: false, reason: `surface recovery equip failed: ${errorMessage(err)}` };
  }
}

function findStandableSurface(bot, x, z, currentY, opts) {
  const top = currentY + opts.maxScanUp;
  const bottom = currentY - opts.maxScanDown;
  for (let standY = top; standY >= bottom; standY--) {
    const floorPos = new Vec3(x, standY - 1, z);
    const feetPos = new Vec3(x, standY, z);
    const headPos = new Vec3(x, standY + 1, z);
    let floor = null;
    let feet = null;
    let head = null;
    try {
      floor = typeof bot.blockAt === 'function' ? bot.blockAt(floorPos) : null;
      feet = typeof bot.blockAt === 'function' ? bot.blockAt(feetPos) : null;
      head = typeof bot.blockAt === 'function' ? bot.blockAt(headPos) : null;
    } catch (err) {
      return { error: `surface query failed near ${x},${z}: ${errorMessage(err)}` };
    }
    if (isStableSurfaceFloor(floor) && isBreathable(feet) && isBreathable(head)) {
      return {
        x,
        z,
        standY,
        floor: blockRecord(floor),
        feet: blockRecord(feet),
        head: blockRecord(head),
      };
    }
  }
  return { x, z, standY: null };
}

async function waitForPillarGround(bot, signal, opts = {}) {
  if (typeof bot.entity?.onGround !== 'boolean') return { ok: true, skipped: true };
  const timeoutMs = positiveInteger(opts.groundSettleTimeoutMs, 1500);
  const pollMs = positiveInteger(opts.groundSettlePollMs, 50);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (signal?.aborted) return { preempted: true, reason: 'reactive preempt during surface recovery ground settle' };
    if (bot.entity?.onGround === true) return { ok: true, waitedMs: Date.now() - startedAt };
    await sleepSignalAware(pollMs, signal);
  }
  return {
    ok: false,
    reason: `bot did not settle on ground before pillar placement (${Date.now() - startedAt}ms)`,
  };
}

function selectPillarItem(items, opts = {}) {
  const priorities = pillarBlockNames(opts);
  const byName = new Map(priorities.map((name, index) => [name, index]));
  return (items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => byName.has(item?.name) && Number(item.count ?? 1) > 0)
    .sort((a, b) => (
      byName.get(a.item.name) - byName.get(b.item.name) ||
      itemSlot(a.item) - itemSlot(b.item) ||
      a.index - b.index
    ))
    .at(0)?.item || null;
}

function pillarBlockNames(opts = {}) {
  const names = Array.isArray(opts.pillarBlocks) ? opts.pillarBlocks : DEFAULT_PILLAR_BLOCKS;
  return names
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

function setControlState(bot, control, value, opts = {}) {
  if (typeof bot?.humanizer?.setControlState === 'function') {
    return bot.humanizer.setControlState(bot, control, value, opts);
  }
  if (typeof bot?.setControlState === 'function') return bot.setControlState(control, value);
  return undefined;
}

function supportUnderPosition(position) {
  if (!position) return null;
  return new Vec3(
    Math.floor(position.x),
    Math.floor(position.y - 0.01),
    Math.floor(position.z),
  );
}

function isSolidSupport(block) {
  return Boolean(block && block.boundingBox === 'block' && !HAZARD_BLOCKS.has(normalizeName(block.name)));
}

function isStableSurfaceFloor(block) {
  return isSolidSupport(block) && !UNSTABLE_SURFACE_FLOORS.has(normalizeName(block.name));
}

function isBreathable(block) {
  const name = normalizeName(block?.name);
  return AIR_LIKE_BLOCKS.has(name) || (block?.boundingBox === 'empty' && !HAZARD_BLOCKS.has(name) && name !== 'water');
}

function blockRecord(block) {
  if (!block) return null;
  return {
    name: block.name ?? null,
    position: block.position ? {
      x: Math.floor(block.position.x),
      y: Math.floor(block.position.y),
      z: Math.floor(block.position.z),
    } : null,
  };
}

function itemSlot(item) {
  const slot = Number(item?.slot);
  return Number.isFinite(slot) ? slot : Number.MAX_SAFE_INTEGER;
}

function formatBlockPos(position) {
  if (!position) return 'unknown';
  return `${position.x},${position.y},${position.z}`;
}

function normalizeName(name) {
  return typeof name === 'string' ? name.replace(/^minecraft:/, '') : '';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sleepSignalAware(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let abortHandler = null;
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      if (abortHandler) signal.removeEventListener?.('abort', abortHandler);
      resolve();
    }
    if (typeof signal?.addEventListener === 'function') {
      abortHandler = finish;
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

function errorMessage(err) {
  return err?.message || String(err);
}
