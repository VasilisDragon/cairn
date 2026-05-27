// smelt -- runtime-only furnace operation for deterministic progression
// missions. The first version is intentionally conservative: one input,
// one expected output, one fuel type, and a locked furnace target across
// preempt/resume cycles.

import pkgPathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import config from '../config.js';
import buildSnapshot from '../state/snapshot.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import { fuelTicksForItem, readBotInventoryCounts } from '../state/materials.js';
import { blockModificationPolicy } from '../state/world_model.js';
import {
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
  worldModelFromContext,
} from './_pathing.js';
import { closeContainer } from './_containers.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';
import { runBoundedOperation } from './_operations.js';

const { goals: pfGoals } = pkgPathfinder;

const FURNACE_BLOCK_NAMES = new Set(['furnace', 'blast_furnace', 'smoker']);
const DEFAULT_FURNACE_OUTPUT_TIMEOUT_MS = 90000;

export async function run(bot, params, ctx) {
  const inputName = params.input;
  const outputName = params.output;
  const count = params.count ?? 1;
  const maxDistance = params.maxDistance ?? 16;

  const inputItem = itemTypeFor(bot, inputName);
  if (!inputItem) return failed(bot, ctx, `unknown input item "${inputName}"`);
  const outputItem = itemTypeFor(bot, outputName);
  if (!outputItem) return failed(bot, ctx, `unknown output item "${outputName}"`);
  if (!Number.isInteger(count) || count < 1) return failed(bot, ctx, 'smelt count must be >= 1');

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for smelt chunk readiness');
  if (chunks.preempted) return preempted(bot, ctx, chunks.reason);
  if (chunks.error) return failed(bot, ctx, `chunk data unavailable during smelt: ${errorMessage(chunks.error)}`);

  const worldModelResult = worldModelFromContext(ctx);
  if (worldModelResult.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during smelt: ${worldModelResult.error.message}`,
      state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
    };
  }
  const worldModel = worldModelResult.model;
  const s = ctx.callState;
  if (s.lockedFurnacePos === undefined) s.lockedFurnacePos = null;
  if (s.walked === undefined) s.walked = false;
  if (s.inputLoaded === undefined) s.inputLoaded = 0;
  if (s.fuelLoaded === undefined) s.fuelLoaded = 0;
  if (s.fuelName === undefined) s.fuelName = null;
  if (s.fuelNeeded === undefined) s.fuelNeeded = 0;
  if (s.outputTaken === undefined) s.outputTaken = 0;

  if (!s.lockedFurnacePos) {
    if (params.furnace) {
      s.lockedFurnacePos = clonePosition(params.furnace);
    } else {
      const searched = findNearestFurnace(bot, maxDistance, { worldModel, signal: ctx.signal });
      if (searched?.preempted) return preempted(bot, ctx, searched.reason);
      if (searched?.error) return failed(bot, ctx, `world query failed during smelt furnace scan: ${errorMessage(searched.error)}`);
      const protectedReason = searched?.protected > 0 ? ` (protected ${searched.protected})` : '';
      if (!searched?.block) return failed(bot, ctx, `no furnace within ${maxDistance} blocks${protectedReason}`);
      s.lockedFurnacePos = clonePosition(searched.block.position);
    }
  }

  const policy = furnaceAccessPolicy(s.lockedFurnacePos, { worldModel });
  if (!policy.ok) {
    return failed(bot, ctx, `locked furnace is inside do-not-touch region ${policy.region?.id || 'unknown'}`);
  }

  const inputPreflightNeeded = Math.max(0, count - s.inputLoaded);
  if (inputPreflightNeeded > 0) {
    const available = inventoryCount(bot, inputName);
    if (!available.ok) return failed(bot, ctx, `inventory unavailable during smelt input check: ${available.error}`);
    if (available.count < inputPreflightNeeded) {
      return failed(bot, ctx, `missing smelt input ${inputName}: need ${inputPreflightNeeded}, have ${available.count}`);
    }
  }

  if (!s.fuelName) {
    const fuel = selectFuel(bot, params.fuel, count, ctx);
    if (fuel.preempted || !fuel.ok) return { ...fuel, state: buildSnapshot(bot, ctx) };
    s.fuelName = fuel.item;
    s.fuelNeeded = fuel.count;
  }

  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');

  const acquired = acquirePathfinder(bot, 'smelt', { skill: 'smelt' });
  if (!acquired.ok) return failed(bot, ctx, `pathfinder acquire failed during smelt: ${acquired.message}`);
  const acq = acquired.acq;
  if (!acq) return preempted(bot, ctx, 'reactive holds pathfinder');

  let furnace = null;
  const closeFurnace = async () => {
    if (!furnace) return;
    const opened = furnace;
    furnace = null;
    await closeContainer(opened, { skill: 'smelt', position: positionForLog(s.lockedFurnacePos) });
  };

  try {
    if (!s.walked) {
      const walked = await walkToFurnace(bot, ctx, acq.token, s.lockedFurnacePos, worldModel);
      if (walked.preempted || !walked.ok) return { ...walked, state: buildSnapshot(bot, ctx) };
      s.walked = true;
    }

    let furnaceBlock;
    try {
      furnaceBlock = bot.blockAt(s.lockedFurnacePos);
    } catch (err) {
      if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt checking furnace');
      return failed(bot, ctx, `world query failed checking furnace: ${errorMessage(err)}`);
    }
    if (!furnaceBlock || !FURNACE_BLOCK_NAMES.has(furnaceBlock.name)) {
      return failed(bot, ctx, 'locked furnace no longer present');
    }

    try {
      furnace = await openFurnace(bot, furnaceBlock, ctx);
    } catch (err) {
      if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt opening furnace');
      return failed(bot, ctx, `openFurnace failed: ${errorMessage(err)}`);
    }

    const slotCheck = inspectFurnaceSlots(furnace, { inputName, outputName, fuelName: s.fuelName });
    if (!slotCheck.ok) return failed(bot, ctx, slotCheck.reason);
    if (slotCheck.outputReady > 0) {
      const taken = await takeFurnaceOutput(furnace, ctx, outputName);
      if (taken.preempted || !taken.ok) return { ...taken, state: buildSnapshot(bot, ctx) };
      s.outputTaken += taken.count;
      if (s.outputTaken >= count) {
        await closeFurnace();
        return { ok: true, reason: `smelted ${s.outputTaken} ${outputName}`, state: buildSnapshot(bot, ctx) };
      }
    }

    const inputInFurnace = slotCheck.inputCount;
    const inputDeficit = Math.max(0, count - s.inputLoaded - inputInFurnace);
    if (inputDeficit > 0) {
      const available = inventoryCount(bot, inputName);
      if (!available.ok) return failed(bot, ctx, `inventory unavailable during smelt input check: ${available.error}`);
      if (available.count < inputDeficit) return failed(bot, ctx, `missing smelt input ${inputName}: need ${inputDeficit}, have ${available.count}`);
      const put = await putFurnaceInput(furnace, inputItem.id, inputDeficit, ctx, inputName);
      if (put.preempted || !put.ok) return { ...put, state: buildSnapshot(bot, ctx) };
      s.inputLoaded += inputDeficit;
    }

    const fuelInFurnace = slotCheck.fuelCount;
    const fuelDeficit = Math.max(0, s.fuelNeeded - s.fuelLoaded - fuelInFurnace);
    if (fuelDeficit > 0) {
      const fuelItem = itemTypeFor(bot, s.fuelName);
      if (!fuelItem) return failed(bot, ctx, `unknown fuel item "${s.fuelName}"`);
      const available = inventoryCount(bot, s.fuelName);
      if (!available.ok) return failed(bot, ctx, `inventory unavailable during smelt fuel check: ${available.error}`);
      if (available.count < fuelDeficit) return failed(bot, ctx, `missing smelt fuel ${s.fuelName}: need ${fuelDeficit}, have ${available.count}`);
      const put = await putFurnaceFuel(furnace, fuelItem.id, fuelDeficit, ctx, s.fuelName);
      if (put.preempted || !put.ok) return { ...put, state: buildSnapshot(bot, ctx) };
      s.fuelLoaded += fuelDeficit;
    }

    const ready = await waitForFurnaceOutput(furnace, outputName, count - s.outputTaken, ctx, {
      timeoutMs: params.waitTimeoutMs ?? config.executor?.furnaceOutputTimeoutMs ?? DEFAULT_FURNACE_OUTPUT_TIMEOUT_MS,
    });
    if (ready.preempted || !ready.ok) return { ...ready, state: buildSnapshot(bot, ctx) };
    const taken = await takeFurnaceOutput(furnace, ctx, outputName);
    if (taken.preempted || !taken.ok) return { ...taken, state: buildSnapshot(bot, ctx) };
    s.outputTaken += taken.count;

    await closeFurnace();
    return { ok: true, reason: `smelted ${s.outputTaken} ${outputName}`, state: buildSnapshot(bot, ctx) };
  } finally {
    await closeFurnace();
    releasePathfinder(acq, { skill: 'smelt' });
  }
}

async function walkToFurnace(bot, ctx, token, position, worldModel) {
  const movementConfig = configurePathingMovements(bot, ctx, {
    phase: 'smelt',
    allowParkour: false,
    worldModel,
  });
  if (!movementConfig.ok) {
    return {
      ok: false,
      reason: `${movementConfig.reason}: ${errorMessage(movementConfig.error)}`,
    };
  }
  const goal = new pfGoals.GoalNear(position.x, position.y, position.z, 2);
  const installed = setPathfinderGoal(bot, token, goal, { movements: movementConfig.movements }, { skill: 'smelt', phase: 'walk' });
  if (!installed.ok) {
    return {
      ok: false,
      reason: installed.denied ? 'pathfinder setGoal denied' : `pathfinder setGoal failed during smelt: ${installed.message}`,
    };
  }
  const reached = await awaitGoalReached(bot, ctx.signal, 60000, { ownerToken: token });
  if (reached.kind === 'preempted') return { preempted: true, reason: 'reactive preempt during smelt walk' };
  if (reached.kind !== 'reached') return { ok: false, reason: `walk to furnace: ${pathingFailureReason(reached)}` };
  return { ok: true };
}

function selectFuel(bot, requestedFuel, count, ctx) {
  if (requestedFuel) {
    const fuelItem = itemTypeFor(bot, requestedFuel);
    if (!fuelItem) return { ok: false, reason: `unknown fuel item "${requestedFuel}"` };
    const burnTicks = fuelTicksForItem(requestedFuel);
    if (burnTicks <= 0) return { ok: false, reason: `item "${requestedFuel}" is not supported smelting fuel` };
    const needed = Math.ceil((count * 200) / burnTicks);
    const available = inventoryCount(bot, requestedFuel);
    if (!available.ok) return { ok: false, reason: `inventory unavailable during smelt fuel planning: ${available.error}` };
    if (available.count < needed) return { ok: false, reason: `missing smelt fuel ${requestedFuel}: need ${needed}, have ${available.count}` };
    return { ok: true, item: requestedFuel, count: needed, burnTicks };
  }

  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) return { ok: false, reason: `inventory unavailable during smelt fuel planning: ${inventory.error}` };
  const requiredTicks = count * 200;
  const options = Object.entries(inventory.inventory)
    .map(([name, available]) => ({ name, available, burnTicks: fuelTicksForItem(name) }))
    .filter((fuel) => fuel.available > 0 && fuel.burnTicks > 0)
    .map((fuel) => ({
      ...fuel,
      count: Math.ceil(requiredTicks / fuel.burnTicks),
    }))
    .filter((fuel) => fuel.count <= fuel.available)
    .sort((a, b) => (
      (a.count * a.burnTicks - requiredTicks) - (b.count * b.burnTicks - requiredTicks) ||
      a.count - b.count ||
      a.name.localeCompare(b.name)
    ));
  const selected = options[0];
  if (!selected) return { ok: false, reason: `missing smelt fuel: need ${requiredTicks} burn ticks` };
  return { ok: true, item: selected.name, count: selected.count, burnTicks: selected.burnTicks };
}

function inspectFurnaceSlots(furnace, opts) {
  const input = safeSlot(furnace, 'inputItem');
  if (input && input.name !== opts.inputName) return { ok: false, reason: `furnace input occupied by ${input.name}` };
  const fuel = safeSlot(furnace, 'fuelItem');
  if (fuel && fuel.name !== opts.fuelName) return { ok: false, reason: `furnace fuel occupied by ${fuel.name}` };
  const output = safeSlot(furnace, 'outputItem');
  if (output && output.name !== opts.outputName) return { ok: false, reason: `furnace output occupied by ${output.name}` };
  return {
    ok: true,
    inputCount: input?.count || 0,
    fuelCount: fuel?.count || 0,
    outputReady: output?.count || 0,
  };
}

function safeSlot(furnace, method) {
  try {
    return typeof furnace?.[method] === 'function' ? furnace[method]() : null;
  } catch {
    return null;
  }
}

async function openFurnace(bot, block, ctx) {
  const timeoutMs = config.executor?.containerOpenTimeoutMs ?? 10000;
  return runBoundedOperation(
    () => bot.openFurnace(block),
    {
      timeoutMs,
      timeoutCode: 'FURNACE_OPEN_TIMEOUT',
      timeoutMessage: `furnace open timed out after ${timeoutMs}ms`,
      signal: ctx.signal,
      abortCode: 'FURNACE_OPEN_ABORTED',
      abortMessage: 'furnace open aborted',
    },
  );
}

async function putFurnaceInput(furnace, itemType, count, ctx, itemName) {
  return runFurnaceTransfer(
    () => furnace.putInput(itemType, null, count),
    ctx,
    'input',
    itemName,
    count,
  );
}

async function putFurnaceFuel(furnace, itemType, count, ctx, itemName) {
  return runFurnaceTransfer(
    () => furnace.putFuel(itemType, null, count),
    ctx,
    'fuel',
    itemName,
    count,
  );
}

async function takeFurnaceOutput(furnace, ctx, outputName) {
  try {
    const item = await runBoundedOperation(
      () => furnace.takeOutput(),
      {
        timeoutMs: config.executor?.containerTransferTimeoutMs ?? 10000,
        timeoutCode: 'FURNACE_OUTPUT_TIMEOUT',
        timeoutMessage: 'furnace output transfer timed out',
        signal: ctx.signal,
        abortCode: 'FURNACE_OUTPUT_ABORTED',
        abortMessage: 'furnace output transfer aborted',
      },
    );
    if (!item || item.name !== outputName) {
      return { ok: false, reason: `furnace output was ${item?.name || 'empty'}, expected ${outputName}` };
    }
    return { ok: true, count: item.count || 1 };
  } catch (err) {
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during furnace output transfer' };
    return { ok: false, reason: `furnace output transfer failed: ${errorMessage(err)}` };
  }
}

async function runFurnaceTransfer(fn, ctx, slot, itemName, count) {
  try {
    await runBoundedOperation(
      fn,
      {
        timeoutMs: config.executor?.containerTransferTimeoutMs ?? 10000,
        timeoutCode: `FURNACE_${slot.toUpperCase()}_TIMEOUT`,
        timeoutMessage: `furnace ${slot} transfer timed out`,
        signal: ctx.signal,
        abortCode: `FURNACE_${slot.toUpperCase()}_ABORTED`,
        abortMessage: `furnace ${slot} transfer aborted`,
      },
    );
    return { ok: true };
  } catch (err) {
    if (ctx.signal?.aborted) return { preempted: true, reason: `reactive preempt during furnace ${slot} transfer` };
    return { ok: false, reason: `furnace ${slot} transfer failed for ${itemName} x${count}: ${errorMessage(err)}` };
  }
}

function waitForFurnaceOutput(furnace, outputName, count, ctx, opts = {}) {
  const needed = Math.max(1, Math.ceil(Number(count) || 1));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FURNACE_OUTPUT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let interval = null;
    let abortListenerInstalled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      try { furnace?.removeListener?.('update', check); } catch {}
      try {
        if (abortListenerInstalled) ctx.signal.removeEventListener('abort', onAbort);
      } catch {}
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => finish({ preempted: true, reason: 'reactive preempt waiting for furnace output' });
    const check = () => {
      const output = safeSlot(furnace, 'outputItem');
      if (!output) return;
      if (output.name !== outputName) {
        finish({ ok: false, reason: `furnace output occupied by ${output.name}` });
        return;
      }
      if ((output.count || 1) >= needed) finish({ ok: true, count: output.count || 1 });
    };
    if (ctx.signal?.aborted) {
      finish({ preempted: true, reason: 'reactive preempt waiting for furnace output' });
      return;
    }
    try {
      ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
      abortListenerInstalled = typeof ctx.signal?.addEventListener === 'function';
    } catch (err) {
      finish({ ok: false, reason: `furnace output wait setup failed: ${errorMessage(err)}` });
      return;
    }
    try { furnace?.on?.('update', check); } catch {}
    interval = setInterval(check, 250);
    timer = setTimeout(() => finish({ ok: false, reason: `furnace output timed out after ${timeoutMs}ms` }), timeoutMs);
    check();
  });
}

function findNearestFurnace(bot, maxDistance, opts = {}) {
  const ids = [];
  for (const name of FURNACE_BLOCK_NAMES) {
    const block = bot.registry?.blocksByName?.[name];
    if (block) ids.push(block.id);
  }
  if (ids.length === 0) return { block: null, protected: 0 };
  let positions;
  try {
    positions = bot.findBlocks?.({ matching: ids, maxDistance, count: 32 }) || [];
  } catch (err) {
    return furnaceScanFailure(opts, err);
  }
  let protectedCount = 0;
  for (const position of positions) {
    let block;
    try {
      block = bot.blockAt(position);
    } catch (err) {
      return furnaceScanFailure(opts, err);
    }
    if (!block || !FURNACE_BLOCK_NAMES.has(block.name)) continue;
    const policy = furnaceAccessPolicy(block.position, opts);
    if (!policy.ok) {
      protectedCount += 1;
      continue;
    }
    return { block, protected: protectedCount };
  }
  return { block: null, protected: protectedCount };
}

function furnaceScanFailure(opts, err) {
  if (opts.signal?.aborted) return { preempted: true, reason: 'reactive preempt during smelt furnace scan' };
  return { error: err };
}

function furnaceAccessPolicy(position, opts = {}) {
  if (!opts.worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(opts.worldModel, position, { margin: opts.doNotTouchMargin ?? 0 });
}

function inventoryCount(bot, name) {
  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) return { ok: false, error: inventory.error, count: 0 };
  return { ok: true, count: inventory.inventory[name] || 0 };
}

function itemTypeFor(bot, name) {
  const item = bot.registry?.itemsByName?.[name];
  if (!item || item.id == null) return null;
  return item;
}

function failed(bot, ctx, reason) {
  return { ok: false, reason, state: buildSnapshot(bot, ctx) };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}

function clonePosition(position) {
  if (!position) return null;
  if (typeof position.clone === 'function') return position.clone();
  return new Vec3(position.x, position.y, position.z);
}

function positionForLog(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function errorMessage(err) {
  return err?.message || String(err);
}
