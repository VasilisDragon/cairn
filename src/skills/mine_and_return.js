import { Vec3 } from 'vec3';

import buildSnapshot from '../state/snapshot.js';
import { countItems } from '../state/materials.js';
import { run as runDeposit } from './deposit.js';
import { run as runGoto } from './goto.js';
import { run as runMineUntil } from './mine_until.js';

const MINE_PARAM_NAMES = Object.freeze([
  'ores',
  'count',
  'maxAttempts',
  'maxDistance',
]);

const DEFAULT_RETURN_RESERVE_MS = 60000;

export async function run(bot, params = {}, ctx = {}) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');
  const target = normalizeReturnChest(params.returnChest);
  if (!target.ok) return failed(bot, ctx, target.reason);

  const state = ctx.callState || {};
  if (!state.phase) state.phase = 'mine';
  if (!state.minedCounts) state.minedCounts = {};

  if (state.phase === 'mine') {
    const mineResult = await runMineUntil(bot, mineParams(params), {
      ...ctx,
      callState: state.mineUntil || (state.mineUntil = {}),
      currentSubtask: 'mine_and_return.mine_until',
    });
    if (mineResult?.preempted) return mineResult;
    if (mineResult?.ok) {
      mergeCounts(state.minedCounts, mineResult.minedCounts);
      state.mineResult = compactMineResult(mineResult);
      state.phase = 'return';
    } else {
      state.mineFailure = compactMineResult(mineResult);
      mergeCounts(state.minedCounts, mineResult?.minedCounts);
      state.phase = 'return';
    }
  }

  if (state.phase === 'return') {
    const minedItems = depositRequests(state.minedCounts, params);
    const returnResult = minedItems.length > 0
      ? await returnAndDeposit(bot, params, ctx, state, target.position, minedItems)
      : await returnWithoutDeposit(bot, params, ctx, state, target.position);

    if (returnResult?.preempted) return returnResult;
    if (!returnResult?.ok) return returnResult;
    state.returnResult = compactInnerResult(returnResult);
    state.phase = 'done';
  }

  const summary = {
    minedCounts: sortCounts(state.minedCounts),
    mineResult: state.mineResult || null,
    returnResult: state.returnResult || null,
  };
  if (state.mineFailure) {
    return {
      ok: false,
      reason: `mine_and_return returned after mining failure: ${state.mineFailure.reason || 'unknown'}`,
      ...summary,
      mineFailure: state.mineFailure,
      state: buildSnapshot(bot, ctx),
    };
  }
  return {
    ok: true,
    reason: `mine_and_return returned with ${totalCount(state.minedCounts)} mined item${totalCount(state.minedCounts) === 1 ? '' : 's'}`,
    ...summary,
    state: buildSnapshot(bot, ctx),
  };
}

function mineParams(params) {
  const out = Object.fromEntries(
    MINE_PARAM_NAMES
      .filter((name) => params[name] !== undefined)
      .map((name) => [name, params[name]]),
  );
  if (params.durationMs !== undefined && out.count === undefined) {
    const reserve = returnReserveMs(params);
    out.durationMs = Math.max(1, params.durationMs - reserve);
  }
  return out;
}

async function returnAndDeposit(bot, params, ctx, state, position, items) {
  const depositState = state.deposit || (state.deposit = {
    lockedChestPos: new Vec3(position.x, position.y, position.z),
  });
  if (!depositState.lockedChestPos) {
    depositState.lockedChestPos = new Vec3(position.x, position.y, position.z);
  }
  return runDeposit(bot, {
    items,
    maxDistance: params.depositMaxDistance ?? params.returnMaxDistance ?? 64,
  }, {
    ...ctx,
    callState: depositState,
    currentSubtask: 'mine_and_return.deposit',
  });
}

async function returnWithoutDeposit(bot, params, ctx, state, position) {
  return runGoto(bot, {
    x: position.x,
    y: position.y,
    z: position.z,
    range: params.returnRange ?? 2,
  }, {
    ...ctx,
    callState: state.goto || (state.goto = {}),
    currentSubtask: 'mine_and_return.return',
  });
}

function normalizeReturnChest(chest) {
  if (!chest || typeof chest !== 'object') {
    return { ok: false, reason: 'mine_and_return requires returnChest {x,y,z}' };
  }
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isFinite(chest[axis])) {
      return { ok: false, reason: `mine_and_return returnChest.${axis} must be finite` };
    }
  }
  return {
    ok: true,
    position: { x: chest.x, y: chest.y, z: chest.z },
  };
}

function depositRequests(minedCounts, params) {
  if (params.depositMinedItems === false) return [];
  return Object.entries(sortCounts(minedCounts))
    .map(([name, count]) => ({ name, count }));
}

function returnReserveMs(params) {
  if (Number.isFinite(params.returnReserveMs)) return Math.max(0, params.returnReserveMs);
  return DEFAULT_RETURN_RESERVE_MS;
}

function compactMineResult(result) {
  const base = compactInnerResult(result);
  if (!result || typeof result !== 'object') return base;
  return {
    ...base,
    ...(Number.isFinite(result.minedTargetCount) ? { minedTargetCount: result.minedTargetCount } : {}),
    ...(result.minedCounts ? { minedCounts: sortCounts(result.minedCounts) } : {}),
    ...(result.minedBlocks ? { minedBlocks: sortCounts(result.minedBlocks) } : {}),
  };
}

function compactInnerResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ...(typeof result.ok === 'boolean' ? { ok: result.ok } : {}),
    ...(result.preempted === true ? { preempted: true } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(Number.isFinite(result.attempts) ? { attempts: result.attempts } : {}),
  };
}

function mergeCounts(target, counts) {
  for (const [name, count] of Object.entries(counts || {})) {
    target[name] = (target[name] || 0) + count;
  }
  return target;
}

function sortCounts(counts) {
  return countItems(Object.entries(counts || {}).map(([name, count]) => ({ name, count })));
}

function totalCount(counts) {
  return Object.values(counts || {}).reduce((sum, count) => sum + count, 0);
}

function failed(bot, ctx, reason) {
  return { ok: false, reason, state: buildSnapshot(bot, ctx) };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}
