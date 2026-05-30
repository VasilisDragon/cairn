import { Vec3 } from 'vec3';

import buildSnapshot from '../state/snapshot.js';
import { countItems } from '../state/materials.js';
import { run as runDeposit } from './deposit.js';
import { run as runFishUntil } from './fish_until.js';

const FISHING_ROD = 'fishing_rod';
const FISHING_LOOT_ITEMS = Object.freeze(new Set([
  'cod',
  'salmon',
  'tropical_fish',
  'pufferfish',
  'lily_pad',
  'bowl',
  'leather',
  'leather_boots',
  'rotten_flesh',
  'stick',
  'string',
  'water_bottle',
  'bone',
  'ink_sac',
  'tripwire_hook',
  'bamboo',
  'bow',
  'enchanted_book',
  'name_tag',
  'nautilus_shell',
  'saddle',
]));
const FISH_PARAM_NAMES = Object.freeze([
  'catches',
  'durationMs',
  'maxAttempts',
  'attemptTimeoutMs',
  'bobberSpawnTimeoutMs',
  'pickupTimeoutMs',
  'waterSafetyPollMs',
]);

export async function run(bot, params = {}, ctx = {}) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');
  const target = normalizeDepositChest(params.depositChest);
  if (!target.ok) return failed(bot, ctx, target.reason);

  const state = ctx.callState || {};
  if (!state.phase) state.phase = 'fish';
  if (!state.caughtCounts) state.caughtCounts = {};

  if (state.phase === 'fish') {
    mergeCarriedFishingLootForNewInvocation(bot, state);
    const fishResult = await runFishUntil(bot, fishParams(params), {
      ...ctx,
      callState: state.fishUntil || (state.fishUntil = {}),
      currentSubtask: 'fish_and_deposit.fish_until',
    });
    if (fishResult?.preempted) return fishResult;
    if (!fishResult?.ok) {
      mergeCounts(state.caughtCounts, fishResult?.caughtCounts);
      if (totalCount(state.caughtCounts) === 0) return fishResult;
      state.fishResult = compactInnerResult(fishResult);
      state.partialFishFailure = fishResult.reason || 'fish_until stopped after partial catch';
      state.phase = 'deposit';
    } else {
      mergeCounts(state.caughtCounts, fishResult.caughtCounts);
      state.fishResult = compactInnerResult(fishResult);
      state.phase = 'deposit';
    }
  }

  const depositItems = depositRequests(state.caughtCounts, params);
  if (depositItems.length === 0) {
    return {
      ok: true,
      reason: `fish_and_deposit caught ${totalCount(state.caughtCounts)} item${totalCount(state.caughtCounts) === 1 ? '' : 's'}; nothing to deposit`,
      caughtCounts: sortCounts(state.caughtCounts),
      depositedCounts: {},
      fishResult: state.fishResult || null,
      state: buildSnapshot(bot, ctx),
    };
  }

  const depositState = state.deposit || (state.deposit = {
    lockedChestPos: new Vec3(target.position.x, target.position.y, target.position.z),
  });
  if (!depositState.lockedChestPos) {
    depositState.lockedChestPos = new Vec3(target.position.x, target.position.y, target.position.z);
  }

  const depositResult = await runDeposit(bot, {
    items: depositItems,
    maxDistance: params.depositMaxDistance ?? 32,
  }, {
    ...ctx,
    callState: depositState,
    currentSubtask: 'fish_and_deposit.deposit',
  });
  if (depositResult?.preempted) return depositResult;
  if (!depositResult?.ok) return depositResult;

  const missedStrictCatchGoal = state.partialFishFailure && Number.isFinite(params.catches);
  const depositedText = depositSummary(depositState.transferred);
  return {
    ok: !missedStrictCatchGoal,
    reason: missedStrictCatchGoal
      ? `fish_and_deposit deposited partial catch ${depositedText} but did not reach requested ${params.catches}: ${state.partialFishFailure}`
      : `fish_and_deposit caught ${totalCount(state.caughtCounts)} and deposited ${depositedText}`,
    caughtCounts: sortCounts(state.caughtCounts),
    depositedCounts: transferCounts(depositState.transferred),
    fishResult: state.fishResult || null,
    depositResult: compactInnerResult(depositResult),
    state: buildSnapshot(bot, ctx),
  };
}

function fishParams(params) {
  return Object.fromEntries(
    FISH_PARAM_NAMES
      .filter((name) => params[name] !== undefined)
      .map((name) => [name, params[name]]),
  );
}

function normalizeDepositChest(chest) {
  if (!chest || typeof chest !== 'object') {
    return { ok: false, reason: 'fish_and_deposit requires depositChest {x,y,z}' };
  }
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isFinite(chest[axis])) {
      return { ok: false, reason: `fish_and_deposit depositChest.${axis} must be finite` };
    }
  }
  return {
    ok: true,
    position: { x: chest.x, y: chest.y, z: chest.z },
  };
}

function depositRequests(caughtCounts, params) {
  const requests = Object.entries(sortCounts(caughtCounts))
    .map(([name, count]) => ({ name, count }));
  if (params.depositRod === true) requests.push({ name: FISHING_ROD, count: 1 });
  return requests;
}

function compactInnerResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ...(typeof result.ok === 'boolean' ? { ok: result.ok } : {}),
    ...(result.preempted === true ? { preempted: true } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(Number.isFinite(result.attempts) ? { attempts: result.attempts } : {}),
    ...(Number.isFinite(result.catches) ? { catches: result.catches } : {}),
  };
}

function mergeCounts(target, counts) {
  for (const [name, count] of Object.entries(counts || {})) {
    target[name] = (target[name] || 0) + count;
  }
  return target;
}

function mergeCarriedFishingLootForNewInvocation(bot, state) {
  if (state.carriedFishingLootCaptured === true) return;
  state.carriedFishingLootCaptured = true;
  if (totalCount(state.caughtCounts) > 0) return;
  const counts = currentFishingLootCounts(bot);
  if (totalCount(counts) === 0) return;
  state.carriedFishingLootCounts = counts;
  mergeCounts(state.caughtCounts, counts);
}

function currentFishingLootCounts(bot) {
  const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
  return countItems(
    items
      .filter((item) => item?.name && FISHING_LOOT_ITEMS.has(item.name))
      .map((item) => ({ name: item.name, count: item.count })),
  );
}

function transferCounts(transferred = []) {
  return countItems(transferred);
}

function sortCounts(counts) {
  return countItems(Object.entries(counts || {}).map(([name, count]) => ({ name, count })));
}

function totalCount(counts) {
  return Object.values(counts || {}).reduce((sum, count) => sum + count, 0);
}

function depositSummary(transferred = []) {
  const counts = transferCounts(transferred);
  const text = Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(', ');
  return text || 'nothing';
}

function failed(bot, ctx, reason) {
  return { ok: false, reason, state: buildSnapshot(bot, ctx) };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}
