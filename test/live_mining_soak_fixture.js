import ReactiveController from '../src/reactive/reactive.js';
import log from '../src/logger.js';
import { runMissionLoop } from '../src/runtime/mission_control.js';
import { requireMissionProfile } from '../src/runtime/mission_profile.js';
import { createReturnPlan, createRouteEstimate, observeRouteTravel } from '../src/runtime/mission_return.js';
import { evaluateTaskBudget, phaseTaskBudget } from '../src/runtime/task_budget.js';
import { run as runCollect } from '../src/skills/collect.js';
import {
  assertNoHostiles,
  chooseAvailableItem,
  closeLoggedChest,
  depositLogged,
  diffCounts,
  envNumber,
  envPositiveInteger,
  equipLogged,
  equipmentSummary,
  inventoryCounts,
  nearbyHostiles,
  openAuthorizedSupplyChest,
  runLiveScenario,
  waitForLiveChunks,
  withdrawLogged,
} from './live_helpers.js';

const ID = 'live_mining_soak_fixture';
const MINING_FIXTURE_ENV = 'MCBOT_LIVE_MINING_FIXTURE_OK';
const DURATION_MS = envNumber('MCBOT_LIVE_MINING_DURATION_MS', 600000);
const RETURN_RESERVE_MS = envNumber('MCBOT_LIVE_MINING_RETURN_RESERVE_MS', 90000);
const MAX_DISTANCE = envNumber('MCBOT_LIVE_MINING_MAX_DISTANCE', 64);
const HOSTILE_RADIUS = envNumber('MCBOT_LIVE_MINING_HOSTILE_RADIUS', 24);
const STEAK_COUNT = envPositiveInteger('MCBOT_LIVE_MINING_STEAK_COUNT', 16);
const REQUIRE_RETURN_RESERVE = process.env.MCBOT_LIVE_MINING_REQUIRE_RETURN_RESERVE === '1';
const MIN_WORK_MS = envNumber('MCBOT_LIVE_MINING_MIN_WORK_MS', 0);
const RUN_TIMEOUT_MS = envNumber('MCBOT_LIVE_MINING_RUN_TIMEOUT_MS', DURATION_MS + 240000);
const DEPOSIT_INTERVAL_MS = envNumber(
  'MCBOT_LIVE_MINING_DEPOSIT_INTERVAL_MS',
  Math.max(0, Math.floor((DURATION_MS - RETURN_RESERVE_MS) / 2)),
);
const RETURN_SAFETY_MULTIPLIER = envNumber('MCBOT_LIVE_MINING_RETURN_SAFETY_MULTIPLIER', 1.5);
const RETURN_OVERHEAD_MS = envNumber('MCBOT_LIVE_MINING_RETURN_OVERHEAD_MS', 10000);

const ARMOR = Object.freeze([
  Object.freeze({ item: 'netherite_helmet', destination: 'head', equipmentSlot: 'head' }),
  Object.freeze({ item: 'netherite_chestplate', destination: 'torso', equipmentSlot: 'torso' }),
  Object.freeze({ item: 'netherite_leggings', destination: 'legs', equipmentSlot: 'legs' }),
  Object.freeze({ item: 'netherite_boots', destination: 'feet', equipmentSlot: 'feet' }),
]);

const NETHERITE_TOOLS = Object.freeze([
  'netherite_pickaxe',
  'netherite_axe',
  'netherite_shovel',
  'netherite_hoe',
  'netherite_sword',
]);

const ORE_TARGETS = Object.freeze([
  Object.freeze({ block: 'diamond_ore', progressItems: Object.freeze(['diamond', 'diamond_ore']) }),
  Object.freeze({ block: 'deepslate_diamond_ore', progressItems: Object.freeze(['diamond', 'deepslate_diamond_ore']) }),
  Object.freeze({ block: 'iron_ore', progressItems: Object.freeze(['raw_iron', 'iron_ore']) }),
  Object.freeze({ block: 'deepslate_iron_ore', progressItems: Object.freeze(['raw_iron', 'deepslate_iron_ore']) }),
  Object.freeze({ block: 'coal_ore', progressItems: Object.freeze(['coal', 'coal_ore']) }),
  Object.freeze({ block: 'deepslate_coal_ore', progressItems: Object.freeze(['coal', 'deepslate_coal_ore']) }),
]);

const MINED_ITEMS = Object.freeze([
  'coal',
  'coal_ore',
  'deepslate_coal_ore',
  'raw_iron',
  'iron_ore',
  'deepslate_iron_ore',
  'diamond',
  'diamond_ore',
  'deepslate_diamond_ore',
]);

runLiveScenario(ID, async ({ bot, controller, finish }) => {
  if (process.env[MINING_FIXTURE_ENV] !== '1') {
    throw new Error(
      `refusing ${ID} without ${MINING_FIXTURE_ENV}=1; this scenario withdraws combat/mining gear and may mine visible coal/iron/diamond ore in the local test world`,
    );
  }

  const missionProfile = requireMissionProfile({
    label: ID,
    phase: 'gear-prep',
    durationMs: DURATION_MS,
    returnReserveMs: RETURN_RESERVE_MS,
    depositIntervalMs: DEPOSIT_INTERVAL_MS,
  });
  const taskBudget = missionProfile.taskBudget;
  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.mining`,
    taskBudget,
  };
  let routeEstimate = createRouteEstimate({
    fallbackTravelMs: missionProfile.returnReserveMs,
    safetyMultiplier: RETURN_SAFETY_MULTIPLIER,
    overheadMs: RETURN_OVERHEAD_MS,
  });
  const currentReturnPlan = (phase) => createReturnPlan({
    taskBudget: phaseTaskBudget(taskBudget, phase),
    routeEstimate,
    minReserveMs: missionProfile.returnReserveMs,
  });

  await waitForLiveChunks(bot, ID);
  log.test.info(`${ID}.fixture-ok`, {
    env: MINING_FIXTURE_ENV,
    durationMs: missionProfile.durationMs,
    returnReserveMs: missionProfile.returnReserveMs,
    maxDistance: MAX_DISTANCE,
    depositIntervalMs: missionProfile.depositIntervalMs,
    taskBudget: missionProfile.summary,
    returnSafetyMultiplier: RETURN_SAFETY_MULTIPLIER,
    returnOverheadMs: RETURN_OVERHEAD_MS,
    returnPlan: currentReturnPlan('gear-prep').summary,
    requireReturnReserve: REQUIRE_RETURN_RESERVE,
    minWorkMs: MIN_WORK_MS,
    targets: ORE_TARGETS.map((target) => target.block),
  });
  assertNoHostiles(bot, ID, { phase: 'before mining gear prep', radius: HOSTILE_RADIUS });
  await prepareMiningGear(bot, ctx);
  new ReactiveController(bot);

  const minedResults = [];
  const minedDelta = {};
  const depositedTargets = {};
  let lastDepositAtMs = taskBudget.startedAtMs;

  const loopResult = await runMissionLoop({
    signal: controller.signal,
    getState: () => ({
      taskBudget: phaseTaskBudget(taskBudget, 'mine'),
      returnPlan: currentReturnPlan('mine'),
      inventoryCounts: inventoryCounts(bot),
      trackedItems: MINED_ITEMS,
      lastDepositAtMs,
      depositPolicy: {
        depositEveryMs: missionProfile.depositIntervalMs,
      },
    }),
    work: async () => {
      const hostiles = nearbyHostiles(bot, HOSTILE_RADIUS);
      if (hostiles.length > 0) {
        log.test.warn(`${ID}.mining.stop-hostiles`, { hostiles });
        return { ok: false, reason: `hostiles detected during mining: ${hostiles.map((h) => `${h.name}@${h.distance}`).join(', ')}` };
      }
      const beforeCollect = inventoryCounts(bot);
      const result = await collectOneVisibleOre(bot, controller.signal, taskBudget);
      minedResults.push(result);
      log.test.info(`${ID}.mining.result`, result);
      if (result.ok) addCounts(minedDelta, pickPositiveDelta(diffCounts(beforeCollect, inventoryCounts(bot)), MINED_ITEMS));
      return result;
    },
    deposit: async ({ decision }) => {
      log.test.info(`${ID}.mining.budget`, decision);
      const depositTargets = pickPositiveCounts(inventoryCounts(bot), MINED_ITEMS);
      const returnStartedAtMs = Date.now();
      await returnAndDepositMinedItems(bot, ctx, depositTargets);
      routeEstimate = observeRouteTravel(routeEstimate, {
        label: 'mine-to-chest-deposit',
        startedAtMs: returnStartedAtMs,
        endedAtMs: Date.now(),
      });
      log.test.info(`${ID}.return.plan`, { phase: 'after-deposit', returnPlan: currentReturnPlan('mine').summary });
      addCounts(depositedTargets, depositTargets);
      lastDepositAtMs = Date.now();
      return { ok: true, reason: 'deposited mined items' };
    },
    returnHome: async ({ decision }) => {
      log.test.info(`${ID}.mining.budget`, decision);
      const depositTargets = pickPositiveCounts(inventoryCounts(bot), MINED_ITEMS);
      const returnStartedAtMs = Date.now();
      await returnAndDepositMinedItems(bot, ctx, depositTargets);
      routeEstimate = observeRouteTravel(routeEstimate, {
        label: 'mine-to-chest-return',
        startedAtMs: returnStartedAtMs,
        endedAtMs: Date.now(),
      });
      log.test.info(`${ID}.return.plan`, { phase: 'after-return', returnPlan: currentReturnPlan('done').summary });
      addCounts(depositedTargets, depositTargets);
      lastDepositAtMs = Date.now();
      return { ok: true, reason: 'returned to authorized supply chest' };
    },
  });

  if (loopResult.preempted) throw new Error(`mining mission preempted: ${loopResult.reason}`);
  if (!loopResult.ok && !['no-visible-targets', 'return-reserve-reached'].includes(loopResult.reason)) {
    throw new Error(`mining mission failed: ${loopResult.reason}`);
  }
  const strictReturnReserveFailure = REQUIRE_RETURN_RESERVE && loopResult.reason !== 'return-reserve-reached';
  const remainingDepositTargets = pickPositiveCounts(inventoryCounts(bot), MINED_ITEMS);
  if (Object.keys(remainingDepositTargets).length > 0 || strictReturnReserveFailure) {
    const returnStartedAtMs = Date.now();
    await returnAndDepositMinedItems(bot, ctx, remainingDepositTargets);
    routeEstimate = observeRouteTravel(routeEstimate, {
      label: 'mine-to-chest-final-cleanup',
      startedAtMs: returnStartedAtMs,
      endedAtMs: Date.now(),
    });
    log.test.info(`${ID}.return.plan`, { phase: 'after-final-cleanup', returnPlan: currentReturnPlan('done').summary });
    addCounts(depositedTargets, remainingDepositTargets);
  }
  if (strictReturnReserveFailure) {
    throw new Error(`strict mining soak ended before return reserve: ${loopResult.reason}`);
  }
  if (Object.keys(minedDelta).length === 0) {
    throw new Error(`mining fixture returned safely but mined no target items; minedResults=${JSON.stringify(minedResults)}`);
  }
  const finalBudget = evaluateTaskBudget(phaseTaskBudget(taskBudget, 'done'));
  if (MIN_WORK_MS > 0 && (finalBudget.taskBudget?.elapsedMs ?? 0) < MIN_WORK_MS) {
    throw new Error(`mining fixture ended before minimum work window: ${finalBudget.taskBudget?.elapsedMs ?? 0}/${MIN_WORK_MS}ms`);
  }
  finish(0, `${ID}.done`, {
    durationMs: finalBudget.taskBudget?.elapsedMs ?? null,
    hardDeadlineMs: taskBudget.durationMs,
    requireReturnReserve: REQUIRE_RETURN_RESERVE,
    minWorkMs: MIN_WORK_MS,
    returnedBeforeDeadline: finalBudget.taskBudget?.overdue === false,
    taskBudget: finalBudget.taskBudget,
    returnPlan: currentReturnPlan('done').summary,
    loopResult,
    minedDelta,
    depositTargets: depositedTargets,
    minedResults,
    finalInventory: inventoryCounts(bot),
  });
}, { runTimeoutMs: RUN_TIMEOUT_MS });

async function prepareMiningGear(bot, ctx) {
  const beforeInventory = inventoryCounts(bot);
  const beforeEquipment = equipmentSummary(bot);
  log.test.info(`${ID}.gear.before`, { inventory: beforeInventory, equipment: beforeEquipment });

  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    await withdrawSteak(bot, container);
    for (const armor of ARMOR) await withdrawIfNeeded(bot, container, armor.item, { required: true });
    for (const tool of NETHERITE_TOOLS) await withdrawIfNeeded(bot, container, tool, { required: tool === 'netherite_pickaxe' });
    await closeLoggedChest(container, ID);
    closed = true;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }

  for (const armor of ARMOR) {
    const equipment = equipmentSummary(bot);
    if (equipment[armor.equipmentSlot]?.name === armor.item) {
      log.test.info(`${ID}.gear.already-equipped`, { item: armor.item, destination: armor.destination });
      continue;
    }
    await equipLogged(bot, armor.item, armor.destination, ID);
  }
  await equipLogged(bot, 'netherite_pickaxe', 'hand', ID);
  log.test.info(`${ID}.gear.after`, {
    inventory: inventoryCounts(bot),
    equipment: equipmentSummary(bot),
  });
}

async function withdrawSteak(bot, container) {
  const steak = chooseAvailableItem(container, ['cooked_beef'], { minCount: 1 });
  if (!steak) {
    if ((inventoryCounts(bot).cooked_beef || 0) > 0) {
      log.test.warn(`${ID}.gear.steak.inventory-only`, { count: inventoryCounts(bot).cooked_beef });
      return;
    }
    throw new Error('no cooked_beef found in authorized chest or inventory for mining fixture');
  }
  const count = Math.min(STEAK_COUNT, steak.available);
  log.test.info(`${ID}.gear.steak.selected`, { item: steak.name, count, available: steak.available });
  await withdrawLogged(bot, container, steak.name, count, ID);
}

async function withdrawIfNeeded(bot, container, item, opts = {}) {
  if ((inventoryCounts(bot)[item] || 0) > 0 || isEquipped(bot, item)) {
    log.test.info(`${ID}.gear.available`, { item, source: isEquipped(bot, item) ? 'equipment' : 'inventory' });
    return;
  }
  const available = chooseAvailableItem(container, [item], { minCount: 1 });
  if (!available) {
    const level = opts.required ? 'error' : 'warn';
    log.test[level](`${ID}.gear.missing`, { item, required: !!opts.required });
    if (opts.required) throw new Error(`required mining item ${item} not found in authorized chest, inventory, or equipment`);
    return;
  }
  log.test.info(`${ID}.gear.selected`, { source: 'authorized-chest', item, available: available.available });
  await withdrawLogged(bot, container, item, 1, ID);
}

async function collectOneVisibleOre(bot, signal, taskBudget) {
  for (const target of ORE_TARGETS) {
    const callState = {};
    const result = await runCollect(bot, {
      block: target.block,
      count: 1,
      maxDistance: MAX_DISTANCE,
      progressItems: target.progressItems,
      finishTree: false,
    }, {
      signal,
      callState,
      remainingQueue: [],
      currentSubtask: `${ID}.collect-${target.block}`,
      taskBudget: phaseTaskBudget(taskBudget, `collect-${target.block}`),
    });
    if (result.preempted) {
      return { block: target.block, preempted: true, reason: result.reason };
    }
    if (result.ok) {
      return { block: target.block, ok: true, reason: result.reason };
    }
    if (!String(result.reason || '').startsWith(`no more ${target.block}`)) {
      return { block: target.block, ok: false, reason: result.reason };
    }
  }
  return { ok: false, reason: 'no-visible-targets' };
}

async function returnAndDepositMinedItems(bot, ctx, minedDelta) {
  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, {
      ...ctx,
      callState: {},
      currentSubtask: `${ID}.return-deposit`,
      taskBudget: phaseTaskBudget(ctx.taskBudget, 'return-deposit'),
    }, ID));
    if (Object.keys(minedDelta).length === 0) {
      log.test.warn(`${ID}.deposit.skip`, { reason: 'no mined target item delta', minedDelta });
    }
    for (const [item, count] of Object.entries(minedDelta)) {
      await depositLogged(bot, container, item, count, ID);
    }
    await closeLoggedChest(container, ID);
    closed = true;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }
}

function pickPositiveDelta(delta, allowedItems) {
  return pickPositiveCounts(delta, allowedItems);
}

function pickPositiveCounts(counts, allowedItems) {
  const allowed = new Set(allowedItems);
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([item, count]) => allowed.has(item) && count > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function addCounts(target, source) {
  for (const [item, count] of Object.entries(source || {})) {
    target[item] = (target[item] || 0) + count;
  }
  return target;
}

function isEquipped(bot, item) {
  const equipment = equipmentSummary(bot);
  return Object.values(equipment).some((equipped) => equipped?.name === item);
}
