import { Vec3 } from 'vec3';

import log from '../src/logger.js';
import { runMissionLoop } from '../src/runtime/mission_control.js';
import { requireMissionProfile } from '../src/runtime/mission_profile.js';
import { createReturnPlan, createRouteEstimate, observeRouteTravel } from '../src/runtime/mission_return.js';
import { compactTaskBudget, phaseTaskBudget } from '../src/runtime/task_budget.js';
import { chooseFishingPickupAction, compareFishingStandCandidates } from '../src/skills/fishing_pickup_policy.js';
import { run as gotoSkill } from '../src/skills/goto.js';
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
  positionForLog,
  runLiveScenario,
  waitForLiveChunks,
  withdrawLogged,
} from './live_helpers.js';

const ID = 'live_supply_chest_fishing_fixture';
const FISHING_ROD = 'fishing_rod';
const CATCH_TARGET = envPositiveInteger('MCBOT_LIVE_FISHING_CATCHES', 3);
const FISHING_WATER_POS = new Vec3(
  envNumber('MCBOT_LIVE_FISHING_WATER_X', 247),
  envNumber('MCBOT_LIVE_FISHING_WATER_Y', 63),
  envNumber('MCBOT_LIVE_FISHING_WATER_Z', 413),
);
const FISHING_NAV_RANGE = envNumber('MCBOT_LIVE_FISHING_NAV_RANGE', 4);
const FISHING_WATER_SCAN_RADIUS = envNumber('MCBOT_LIVE_FISHING_WATER_SCAN_RADIUS', 10);
const FISHING_STAND_SCAN_RADIUS = envNumber('MCBOT_LIVE_FISHING_STAND_SCAN_RADIUS', 4);
const FISHING_MIN_STAND_DISTANCE = envNumber('MCBOT_LIVE_FISHING_MIN_STAND_DISTANCE', 2);
const FISHING_HOSTILE_RADIUS = envNumber('MCBOT_LIVE_FISHING_HOSTILE_RADIUS', 24);
const FISH_ATTEMPT_TIMEOUT_MS = envNumber('MCBOT_LIVE_FISHING_ATTEMPT_TIMEOUT_MS', 45000);
const FISHING_BOBBER_SPAWN_TIMEOUT_MS = envNumber('MCBOT_LIVE_FISHING_BOBBER_SPAWN_TIMEOUT_MS', 4000);
const CATCH_PICKUP_TIMEOUT_MS = envNumber('MCBOT_LIVE_FISHING_PICKUP_TIMEOUT_MS', 8000);
const FISHING_WATER_SAFETY_POLL_MS = envNumber('MCBOT_LIVE_FISHING_WATER_SAFETY_POLL_MS', 250);
const FISHING_ITEM_FLIGHT_WAIT_MS = envNumber('MCBOT_LIVE_FISHING_ITEM_FLIGHT_WAIT_MS', 3000);
const FISHING_DRY_PICKUP_REACH = envNumber('MCBOT_LIVE_FISHING_DRY_PICKUP_REACH', 2.25);
const FISHING_DRY_INTERCEPT_REACH = envNumber(
  'MCBOT_LIVE_FISHING_DRY_INTERCEPT_REACH',
  Math.max(FISHING_DRY_PICKUP_REACH, 4.5),
);
const FISHING_MAX_DRY_PICKUP_ATTEMPTS = envPositiveInteger('MCBOT_LIVE_FISHING_MAX_DRY_PICKUP_ATTEMPTS', 3);
const FISHING_PREFERRED_STAND_DISTANCE = envNumber('MCBOT_LIVE_FISHING_PREFERRED_STAND_DISTANCE', 3.25);
const FISHING_LANDING_MOTION_MODE = process.env.MCBOT_LIVE_FISHING_LANDING_MOTION_MODE || 'auto';
const FISHING_LANDING_SCORE_COMFORT = envNumber('MCBOT_LIVE_FISHING_LANDING_SCORE_COMFORT', 16);
const FISHING_LANDING_SCORE_MINIMUM = envNumber('MCBOT_LIVE_FISHING_LANDING_SCORE_MINIMUM', 10);
const FISHING_REEL_INLAND_PULL_MS = envNumber('MCBOT_LIVE_FISHING_REEL_INLAND_PULL_MS', 450);
const FISHING_DRY_LANDING_NUDGE_MS = envNumber('MCBOT_LIVE_FISHING_DRY_LANDING_NUDGE_MS', 650);
const FISHING_STAND_RECOVERY_LIMIT = envPositiveInteger('MCBOT_LIVE_FISHING_STAND_RECOVERY_LIMIT', 4);
const FISHING_DURATION_ONLY = process.env.MCBOT_LIVE_FISHING_DURATION_ONLY === '1';
const FISHING_MIN_CATCHES = envPositiveInteger('MCBOT_LIVE_FISHING_MIN_CATCHES', FISHING_DURATION_ONLY ? 1 : CATCH_TARGET);
const FISHING_MAX_ITERATIONS = envPositiveInteger(
  'MCBOT_LIVE_FISHING_MAX_ITERATIONS',
  FISHING_DURATION_ONLY ? 1000 : Math.max(10, CATCH_TARGET * 4),
);
const FISHING_CAST_RETRY_LIMIT = envPositiveInteger(
  'MCBOT_LIVE_FISHING_CAST_RETRY_LIMIT',
  FISHING_DURATION_ONLY ? Math.max(10, CATCH_TARGET * 4) : CATCH_TARGET * 2,
);
const FISHING_WATER_PICKUP_FALLBACK = process.env.MCBOT_LIVE_FISHING_WATER_PICKUP_FALLBACK === '1';
const FISHING_ALLOW_WATER_PICKUP = FISHING_WATER_PICKUP_FALLBACK
  || process.env.MCBOT_LIVE_FISHING_ALLOW_WATER_PICKUP === '1';
const RUN_TIMEOUT_MS = envNumber('MCBOT_LIVE_FISHING_RUN_TIMEOUT_MS', 240000);
const DURATION_MS = envNumber('MCBOT_LIVE_FISHING_DURATION_MS', Math.max(1, RUN_TIMEOUT_MS - 30000));
const RETURN_RESERVE_MS = envNumber('MCBOT_LIVE_FISHING_RETURN_RESERVE_MS', 60000);
const DEPOSIT_INTERVAL_MS = envNumber(
  'MCBOT_LIVE_FISHING_DEPOSIT_INTERVAL_MS',
  Math.max(0, Math.floor((DURATION_MS - RETURN_RESERVE_MS) / 2)),
);
const RETURN_SAFETY_MULTIPLIER = envNumber('MCBOT_LIVE_FISHING_RETURN_SAFETY_MULTIPLIER', 1.5);
const RETURN_OVERHEAD_MS = envNumber('MCBOT_LIVE_FISHING_RETURN_OVERHEAD_MS', 10000);

const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const LIQUID_BLOCKS = new Set(['water', 'lava']);
const WATER_BODY_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const UNSAFE_STAND_BLOCKS = new Set([
  'cactus',
  'fire',
  'lava',
  'magma_block',
  'soul_fire',
  'sweet_berry_bush',
  'wither_rose',
]);

runLiveScenario(ID, async ({ bot, controller, finish }) => {
  await waitForLiveChunks(bot, ID);
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
    currentSubtask: `${ID}.fishing`,
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
  const initialInventory = inventoryCounts(bot);
  log.test.info(`${ID}.before`, {
    inventory: initialInventory,
    equipment: equipmentSummary(bot),
    catchTarget: CATCH_TARGET,
    waterFixture: positionForLog(FISHING_WATER_POS),
    durationMs: missionProfile.durationMs,
    returnReserveMs: missionProfile.returnReserveMs,
    depositIntervalMs: missionProfile.depositIntervalMs,
    returnSafetyMultiplier: RETURN_SAFETY_MULTIPLIER,
    returnOverheadMs: RETURN_OVERHEAD_MS,
    bobberSpawnTimeoutMs: FISHING_BOBBER_SPAWN_TIMEOUT_MS,
    waterSafetyPollMs: FISHING_WATER_SAFETY_POLL_MS,
    itemFlightWaitMs: FISHING_ITEM_FLIGHT_WAIT_MS,
    dryPickupReach: FISHING_DRY_PICKUP_REACH,
    dryInterceptReach: FISHING_DRY_INTERCEPT_REACH,
    maxDryPickupAttempts: FISHING_MAX_DRY_PICKUP_ATTEMPTS,
    preferredStandDistance: FISHING_PREFERRED_STAND_DISTANCE,
    landingMotionMode: FISHING_LANDING_MOTION_MODE,
    landingScoreComfort: FISHING_LANDING_SCORE_COMFORT,
    landingScoreMinimum: FISHING_LANDING_SCORE_MINIMUM,
    reelInlandPullMs: FISHING_REEL_INLAND_PULL_MS,
    dryLandingNudgeMs: FISHING_DRY_LANDING_NUDGE_MS,
    standRecoveryLimit: FISHING_STAND_RECOVERY_LIMIT,
    castRetryLimit: FISHING_CAST_RETRY_LIMIT,
    allowWaterPickup: FISHING_ALLOW_WATER_PICKUP,
    waterPickupFallback: FISHING_WATER_PICKUP_FALLBACK,
    durationOnly: FISHING_DURATION_ONLY,
    minCatches: FISHING_MIN_CATCHES,
    maxIterations: FISHING_MAX_ITERATIONS,
    taskBudget: missionProfile.summary,
    returnPlan: currentReturnPlan('gear-prep').summary,
  });

  const caughtTotals = {};
  const pendingDeposit = {};
  let catches = 0;
  let lastDepositAtMs = taskBudget.startedAtMs;
  let rodTouched = false;
  let standRecoveries = 0;
  let castRetries = 0;
  let returnedHome = false;

  try {
    rodTouched = await withdrawAndEquipRod(bot, ctx);
    const initialWaterStartedAtMs = Date.now();
    let water = await navigateToFishingWater(bot, ctx);
    routeEstimate = observeRouteTravel(routeEstimate, {
      label: 'chest-to-fishing-water',
      startedAtMs: initialWaterStartedAtMs,
      endedAtMs: Date.now(),
    });
    const missionItemEntityBaseline = new Set(itemEntityIds(bot));
    log.test.info(`${ID}.return.plan`, { phase: 'after-water-navigation', returnPlan: currentReturnPlan('fish').summary });

    const loopResult = await runMissionLoop({
      signal: controller.signal,
      maxIterations: FISHING_MAX_ITERATIONS,
      getState: () => ({
        taskBudget: phaseTaskBudget(taskBudget, 'fish'),
        returnPlan: currentReturnPlan('fish'),
        inventoryCounts: pendingDeposit,
        lastDepositAtMs,
        depositPolicy: {
          depositEveryMs: missionProfile.depositIntervalMs,
        },
      }),
      work: async () => {
        if (!FISHING_DURATION_ONLY && catches >= CATCH_TARGET) return { ok: true, done: true, reason: 'target catches reached' };
        const attempt = catches + 1;
        water = await ensureDryFishingStand(bot, ctx, water, { attempt, phase: 'before-cast' });
        await ensureRodHeldForCast(bot);
        const beforeAttempt = inventoryCounts(bot);
        const beforeItemEntityIds = itemEntityIds(bot);
        log.test.info(`${ID}.fish.start`, {
          attempt,
          target: FISHING_DURATION_ONLY ? null : CATCH_TARGET,
          durationOnly: FISHING_DURATION_ONLY,
          minCatches: FISHING_MIN_CATCHES,
          water: positionForLog(water.position),
          inventoryBefore: beforeAttempt,
          itemEntitiesBefore: beforeItemEntityIds.length,
        });
        await lookAtWater(bot, water);
        const landingPlan = fishingLandingPlan(water, attempt);
        log.test.info(`${ID}.fish.landing-plan`, {
          attempt,
          ...landingPlan,
        });
        try {
          await fishOnce(bot, attempt, ctx, water, landingPlan);
          await nudgeCatchLandingInland(bot, water, ctx, { attempt, landingPlan });
        } catch (err) {
          if (isTransientCastFailure(err) && castRetries < FISHING_CAST_RETRY_LIMIT) {
            castRetries += 1;
            log.test.warn(`${ID}.fish.cast-retry`, {
              attempt,
              retry: castRetries,
              limit: FISHING_CAST_RETRY_LIMIT,
              code: err.code,
              reason: err.message,
              position: positionForLog(bot.entity?.position),
              waterState: fishingWaterUnsafeState(bot),
            });
            water = await ensureDryFishingStand(bot, ctx, water, {
              attempt,
              phase: 'after-bobber-not-spawned',
              reason: err.message,
              retry: castRetries,
            });
            await sleep(500);
            return { ok: true, done: false, reason: `retrying after transient cast failure: ${err.code}` };
          }
          if (err?.code === 'FISHING_WATER_UNSAFE' && standRecoveries < FISHING_STAND_RECOVERY_LIMIT) {
            standRecoveries += 1;
            water = await ensureDryFishingStand(bot, ctx, water, {
              attempt,
              phase: 'after-water-unsafe',
              reason: err.message,
              recovery: standRecoveries,
            });
            return { ok: true, done: false, reason: 'recovered dry fishing stand after unsafe water state' };
          }
          throw err;
        }
        let catchResult;
        try {
          catchResult = await waitForCatchDeltaOrPickup(bot, beforeAttempt, CATCH_PICKUP_TIMEOUT_MS, ctx, beforeItemEntityIds, water);
        } catch (err) {
          if (err?.code === 'FISHING_WATER_UNSAFE' && standRecoveries < FISHING_STAND_RECOVERY_LIMIT) {
            standRecoveries += 1;
            water = await ensureDryFishingStand(bot, ctx, water, {
              attempt,
              phase: 'after-pickup-water-unsafe',
              reason: err.message,
              recovery: standRecoveries,
            });
            return { ok: true, done: false, reason: 'recovered dry fishing stand after unsafe pickup state' };
          }
          throw err;
        }
        catches += 1;
        addCounts(caughtTotals, catchResult.catchDelta);
        addCounts(pendingDeposit, catchResult.catchDelta);
        log.test.info(`${ID}.fish.catch`, {
          attempt,
          catchDelta: catchResult.catchDelta,
          caughtTotals,
          pendingDeposit,
          inventoryAfter: catchResult.inventoryAfter,
        });
        const targetReached = !FISHING_DURATION_ONLY && catches >= CATCH_TARGET;
        return {
          ok: true,
          done: targetReached,
          reason: targetReached ? 'target catches reached' : 'caught fishing output',
        };
      },
      deposit: async ({ decision, depositItems }) => {
        log.test.info(`${ID}.mission.budget`, decision);
        const returnStartedAtMs = Date.now();
        await depositPendingFishingItems(bot, ctx, depositItems);
        routeEstimate = observeRouteTravel(routeEstimate, {
          label: 'water-to-chest-deposit',
          startedAtMs: returnStartedAtMs,
          endedAtMs: Date.now(),
        });
        log.test.info(`${ID}.return.plan`, { phase: 'after-deposit', returnPlan: currentReturnPlan('fish').summary });
        clearCounts(pendingDeposit, depositItems);
        lastDepositAtMs = Date.now();
        const waterStartedAtMs = Date.now();
        water = await navigateToFishingWater(bot, ctx);
        routeEstimate = observeRouteTravel(routeEstimate, {
          label: 'chest-to-fishing-water',
          startedAtMs: waterStartedAtMs,
          endedAtMs: Date.now(),
        });
        log.test.info(`${ID}.return.plan`, { phase: 'after-resume-navigation', returnPlan: currentReturnPlan('fish').summary });
        return { ok: true, reason: 'deposited pending fishing output' };
      },
      returnHome: async ({ decision }) => {
        log.test.info(`${ID}.mission.budget`, decision);
        const returnStartedAtMs = Date.now();
        await returnAndDeposit(bot, ctx, pendingDeposit);
        routeEstimate = observeRouteTravel(routeEstimate, {
          label: 'water-to-chest-return',
          startedAtMs: returnStartedAtMs,
          endedAtMs: Date.now(),
        });
        log.test.info(`${ID}.return.plan`, { phase: 'after-return', returnPlan: currentReturnPlan('done').summary });
        clearCounts(pendingDeposit);
        lastDepositAtMs = Date.now();
        returnedHome = true;
        rodTouched = false;
        return { ok: true, reason: 'returned to authorized supply chest' };
      },
    });

    log.test.info(`${ID}.mission.result`, {
      loopResult,
      catches,
      caughtTotals,
      pendingDeposit,
      standRecoveries,
      castRetries,
      returnPlan: currentReturnPlan('done').summary,
      taskBudget: compactTaskBudget(phaseTaskBudget(taskBudget, 'done')),
    });
    if (loopResult.preempted) throw new Error(`fishing mission preempted: ${loopResult.reason}`);
    if (!loopResult.ok) throw new Error(`fishing mission failed: ${loopResult.reason}`);
    if (!FISHING_DURATION_ONLY && catches < CATCH_TARGET) {
      throw new Error(`fishing mission returned before target catches: ${catches}/${CATCH_TARGET}; reason=${loopResult.reason}`);
    }
    if (catches < FISHING_MIN_CATCHES) {
      throw new Error(`fishing mission returned before minimum catches: ${catches}/${FISHING_MIN_CATCHES}; reason=${loopResult.reason}`);
    }
    await collectOrFailUncollectedDrops(bot, ctx, missionItemEntityBaseline, water);

    if (!returnedHome) {
      const finalReturnStartedAtMs = Date.now();
      await returnAndDeposit(bot, ctx, pendingDeposit);
      routeEstimate = observeRouteTravel(routeEstimate, {
        label: 'water-to-chest-final-return',
        startedAtMs: finalReturnStartedAtMs,
        endedAtMs: Date.now(),
      });
      log.test.info(`${ID}.return.plan`, { phase: 'after-final-return', returnPlan: currentReturnPlan('done').summary });
      clearCounts(pendingDeposit);
      returnedHome = true;
      rodTouched = false;
    }
    finish(0, `${ID}.done`, {
      catches,
      targetCatches: FISHING_DURATION_ONLY ? null : CATCH_TARGET,
      durationOnly: FISHING_DURATION_ONLY,
      minCatches: FISHING_MIN_CATCHES,
      caughtTotals,
      loopResult,
      standRecoveries,
      castRetries,
      returnPlan: currentReturnPlan('done').summary,
      taskBudget: compactTaskBudget(phaseTaskBudget(taskBudget, 'done')),
      finalInventory: inventoryCounts(bot),
    });
  } catch (err) {
    await cleanupAfterFailure(bot, ctx, pendingDeposit, {
      rodTouched,
      reason: err?.message || String(err),
      initialInventory,
    });
    throw err;
  }
}, { runTimeoutMs: RUN_TIMEOUT_MS });

async function withdrawAndEquipRod(bot, ctx) {
  if ((inventoryCounts(bot)[FISHING_ROD] || 0) > 0 || isEquipped(bot, FISHING_ROD)) {
    log.test.info(`${ID}.rod.selected`, {
      source: isEquipped(bot, FISHING_ROD) ? 'equipment' : 'inventory',
      item: FISHING_ROD,
      available: inventoryCounts(bot)[FISHING_ROD] || 1,
    });
    await equipLogged(bot, FISHING_ROD, 'hand', ID);
    return true;
  }

  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    const rod = chooseAvailableItem(container, [FISHING_ROD], { minCount: 1 });
    if (!rod) throw new Error('authorized fixture chest does not contain a fishing_rod for the fishing fixture');
    log.test.info(`${ID}.rod.selected`, { source: 'authorized-chest', item: rod.name, available: rod.available });
    await withdrawLogged(bot, container, FISHING_ROD, 1, ID);
    await closeLoggedChest(container, ID);
    closed = true;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }

  await equipLogged(bot, FISHING_ROD, 'hand', ID);
  return true;
}

async function navigateToFishingWater(bot, ctx) {
  assertNoHostiles(bot, ID, { phase: 'before fishing water navigation', radius: FISHING_HOSTILE_RADIUS });
  const navCtx = {
    ...ctx,
    callState: {},
    currentSubtask: `${ID}.navigate-water`,
  };
  const nav = await gotoSkill(bot, {
    x: FISHING_WATER_POS.x,
    y: FISHING_WATER_POS.y,
    z: FISHING_WATER_POS.z,
    range: FISHING_NAV_RANGE,
  }, navCtx);
  log.test.info(`${ID}.water.navigate`, {
    ok: !!nav.ok,
    preempted: !!nav.preempted,
    reason: nav.reason,
    position: positionForLog(bot.entity?.position),
    target: positionForLog(FISHING_WATER_POS),
  });
  if (nav.preempted) throw new Error(`navigation to fishing water was preempted: ${nav.reason}`);
  if (!nav.ok) throw new Error(`navigation to fishing water failed: ${nav.reason}`);
  assertNoHostiles(bot, ID, { phase: 'before fishing water selection', radius: FISHING_HOSTILE_RADIUS });

  const water = findFishingWater(bot);
  log.test.info(`${ID}.water.selected`, {
    water: water ? positionForLog(water.position) : null,
    openWaterScore: water?.openWaterScore ?? null,
    botPosition: positionForLog(bot.entity?.position),
    fixture: positionForLog(FISHING_WATER_POS),
    scanRadius: FISHING_WATER_SCAN_RADIUS,
  });
  if (!water) {
    throw new Error(`no visible water block found within ${FISHING_WATER_SCAN_RADIUS} blocks of the bot near ${formatPos(FISHING_WATER_POS)}`);
  }

  water.activeStand = await navigateToFishingStand(bot, ctx, water);
  return water;
}

async function navigateToFishingStand(bot, ctx, water) {
  const candidates = Array.isArray(water?.standCandidates) && water.standCandidates.length > 0
    ? water.standCandidates
    : findFishingStandCandidates(bot, water);
  log.test.info(`${ID}.stand.selected`, {
    water: positionForLog(water.position),
    candidates: candidates.slice(0, 8).map((candidate) => ({
      position: positionForLog(candidate.position),
      below: candidate.below,
      horizontalDistance: candidate.horizontalDistance,
      verticalDistance: candidate.verticalDistance,
      dryLandingScore: candidate.dryLandingScore ?? null,
      catchLandingScore: candidate.catchLandingScore ?? null,
      itemDistance: candidate.itemDistance ?? null,
    })),
    scanRadius: FISHING_STAND_SCAN_RADIUS,
  });
  if (candidates.length === 0) {
    throw new Error(`no standable shore block found within ${FISHING_STAND_SCAN_RADIUS} blocks of water ${formatPos(water.position)}`);
  }

  const navCtx = {
    ...ctx,
    callState: {},
    currentSubtask: `${ID}.navigate-stand`,
  };
  let lastFailure = null;
  for (const candidate of candidates.slice(0, 8)) {
    const nav = await gotoSkill(bot, {
      x: candidate.position.x + 0.5,
      y: candidate.position.y,
      z: candidate.position.z + 0.5,
      range: 0.75,
    }, navCtx);
    log.test.info(`${ID}.stand.navigate`, {
      ok: !!nav.ok,
      preempted: !!nav.preempted,
      reason: nav.reason,
      stand: positionForLog(candidate.position),
      position: positionForLog(bot.entity?.position),
    });
    if (nav.preempted) throw new Error(`navigation to fishing stand was preempted: ${nav.reason}`);
    if (nav.ok) return candidate;
    lastFailure = nav.reason;
  }
  throw new Error(`navigation to fishing stand failed: ${lastFailure || 'no reachable stand candidate'}`);
}

async function ensureDryFishingStand(bot, ctx, water, details = {}) {
  const before = fishingWaterUnsafeState(bot);
  if (!before.unsafe) return water;

  log.test.warn(`${ID}.stand.recover.start`, {
    ...details,
    waterState: before,
    botPosition: positionForLog(bot.entity?.position),
    water: water ? positionForLog(water.position) : null,
  });
  triggerWaterRescue(bot);
  water.activeStand = await navigateToFishingStand(bot, ctx, water);
  const after = fishingWaterUnsafeState(bot);
  log.test.info(`${ID}.stand.recover.done`, {
    ...details,
    waterState: after,
    botPosition: positionForLog(bot.entity?.position),
    water: water ? positionForLog(water.position) : null,
  });
  if (after.unsafe) throw new Error(`unable to recover dry fishing stand: ${after.reason}`);
  return water;
}

function findFishingWater(bot) {
  const water = bot.registry?.blocksByName?.water;
  if (!water) throw new Error('registry does not expose water block id');
  const positions = bot.findBlocks({
    matching: water.id,
    maxDistance: FISHING_WATER_SCAN_RADIUS,
    count: 64,
  });
  return positions
    .map((position) => bot.blockAt(position))
    .filter((block) => block?.name === 'water')
    .map((block) => {
      const standCandidates = findFishingStandCandidates(bot, block);
      return Object.assign(block, {
        openWaterScore: openWaterScore(bot, block.position),
        standCandidates,
        bestStandDistance: standCandidates[0]?.horizontalDistance ?? Number.POSITIVE_INFINITY,
        bestCatchLandingScore: standCandidates[0]?.catchLandingScore ?? 0,
      });
    })
    .filter((block) => block.standCandidates.length > 0)
    .sort((a, b) => {
      const aShoreReachable = a.bestStandDistance <= 3 ? 1 : 0;
      const bShoreReachable = b.bestStandDistance <= 3 ? 1 : 0;
      if (aShoreReachable !== bShoreReachable) return bShoreReachable - aShoreReachable;
      if (a.bestCatchLandingScore !== b.bestCatchLandingScore) return b.bestCatchLandingScore - a.bestCatchLandingScore;
      if (aShoreReachable && a.bestStandDistance !== b.bestStandDistance) return a.bestStandDistance - b.bestStandDistance;
      if (a.openWaterScore !== b.openWaterScore) return b.openWaterScore - a.openWaterScore;
      return distance(a.position, FISHING_WATER_POS) - distance(b.position, FISHING_WATER_POS);
    })[0] || null;
}

function findFishingStandCandidates(bot, water) {
  const candidates = [];
  for (let dx = -FISHING_STAND_SCAN_RADIUS; dx <= FISHING_STAND_SCAN_RADIUS; dx++) {
    for (let dz = -FISHING_STAND_SCAN_RADIUS; dz <= FISHING_STAND_SCAN_RADIUS; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (let dy = -1; dy <= 3; dy++) {
        const position = water.position.offset(dx, dy, dz);
        const feet = bot.blockAt(position);
        const head = bot.blockAt(position.offset(0, 1, 0));
        const below = bot.blockAt(position.offset(0, -1, 0));
        if (!isPassable(feet) || !isPassable(head) || !isStandable(below)) continue;
        const horizontalDistance = Math.round(Math.hypot(dx, dz) * 100) / 100;
        const verticalDistance = Math.abs(position.y - (water.position.y + 1));
        if (horizontalDistance < FISHING_MIN_STAND_DISTANCE || horizontalDistance > FISHING_STAND_SCAN_RADIUS) continue;
        candidates.push({
          position,
          below: below.name,
          horizontalDistance,
          verticalDistance,
          dryLandingScore: dryLandingScore(bot, position, water.position),
          catchLandingScore: catchLandingScore(bot, position, water.position),
          distanceToBot: Math.round(distance(position.offset(0.5, 0, 0.5), bot.entity?.position || FISHING_WATER_POS) * 100) / 100,
        });
      }
    }
  }
  return candidates.sort((a, b) => compareFishingStandCandidates(a, b, {
    preferredDistance: FISHING_PREFERRED_STAND_DISTANCE,
  }));
}

async function fishOnce(bot, attempt, ctx = {}, water = null, landingPlan = null) {
  if (bot.heldItem?.name !== FISHING_ROD) {
    throw withCode(new Error('fishing_rod is not held before cast'), 'FISHING_ROD_NOT_HELD');
  }
  const client = bot._client;
  if (!client?.on || !client?.removeListener) throw new Error('bot client does not expose packet listeners for fishing fixture');
  const bobberType = fishingBobberType(bot);
  let monitor = null;
  let timeout = null;
  let spawnTimeout = null;
  let bobber = null;
  let particleSamples = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (monitor) clearInterval(monitor);
      if (timeout) clearTimeout(timeout);
      if (spawnTimeout) clearTimeout(spawnTimeout);
      client.removeListener('spawn_entity', onSpawnEntity);
      client.removeListener('world_particles', onWorldParticles);
      client.removeListener('entity_destroy', onEntityDestroy);
      ctx.signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (bobber) cancelFishing(bot);
      reject(err);
    };

    const onAbort = () => fail(withCode(new Error('fishing attempt aborted'), 'FISHING_ABORTED'));
    const onSpawnEntity = (packet) => {
      if (packet.type !== bobberType || bobber) return;
      bobber = bot.entities?.[packet.entityId] || {
        id: packet.entityId,
        position: packetPosition(packet),
      };
      if (spawnTimeout) {
        clearTimeout(spawnTimeout);
        spawnTimeout = null;
      }
      log.test.info(`${ID}.fish.bobber`, {
        attempt,
        bobberType,
        entityId: packet.entityId,
        position: positionForLog(bobber.position),
      });
    };

    const onWorldParticles = (packet) => {
      if (!bobber?.position) return;
      const sample = particleSummary(packet, bobber.position);
      if (sample.nearBobber && particleSamples < 24) {
        particleSamples += 1;
        log.test.info(`${ID}.fish.particle`, { attempt, ...sample });
      }
      if (!isLikelyBiteParticle(sample)) return;
      log.test.info(`${ID}.fish.bite`, { attempt, ...sample });
      try {
        startReelInlandPull(bot, water, { attempt, reason: 'bite', landingPlan });
        bot.activateItem();
        finish();
      } catch (err) {
        fail(new Error(`failed to reel fishing rod after bite: ${err?.message || String(err)}`));
      }
    };

    const onEntityDestroy = (packet) => {
      if (!bobber?.id || !packet.entityIds?.some((id) => id === bobber.id)) return;
      fail(withCode(new Error('fishing bobber disappeared before a bite was detected'), 'FISHING_BOBBER_DISAPPEARED'));
    };

    if (ctx.signal?.aborted) return onAbort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    client.on('spawn_entity', onSpawnEntity);
    client.on('world_particles', onWorldParticles);
    client.on('entity_destroy', onEntityDestroy);
    timeout = setTimeout(() => {
      fail(new Error(`fishing attempt ${attempt} timed out after ${FISH_ATTEMPT_TIMEOUT_MS}ms; bobber=${bobber ? formatPos(bobber.position) : 'not-spawned'} particleSamples=${particleSamples}`));
    }, FISH_ATTEMPT_TIMEOUT_MS);
    spawnTimeout = setTimeout(() => {
      if (bobber) return;
      fail(withCode(
        new Error(`fishing attempt ${attempt} did not spawn a bobber within ${FISHING_BOBBER_SPAWN_TIMEOUT_MS}ms`),
        'FISHING_BOBBER_NOT_SPAWNED',
      ));
    }, FISHING_BOBBER_SPAWN_TIMEOUT_MS);
    monitor = setInterval(() => {
      if (ctx.signal?.aborted) return onAbort();
      const waterState = fishingWaterUnsafeState(bot);
      if (waterState.unsafe) {
        triggerWaterRescue(bot);
        fail(withCode(new Error(`unsafe water state during fishing attempt ${attempt}: ${waterState.reason}`), 'FISHING_WATER_UNSAFE'));
        return;
      }
      const hostiles = nearbyHostiles(bot, FISHING_HOSTILE_RADIUS);
      if (hostiles.length === 0) return;
      fail(new Error(`live test unsafe during fishing attempt ${attempt}; nearby hostiles present: ${hostiles.map((h) => `${h.name}@${h.distance}`).join(', ')}`));
    }, FISHING_WATER_SAFETY_POLL_MS);

    try {
      bot.activateItem();
    } catch (err) {
      fail(new Error(`failed to cast fishing rod: ${err?.message || String(err)}`));
    }
  });
}

async function nudgeCatchLandingInland(bot, water, ctx, details = {}) {
  if (details.landingPlan?.postReelNudge !== true) return;
  if (FISHING_DRY_LANDING_NUDGE_MS <= 0 || !water || typeof bot.setControlState !== 'function') return;
  const before = fishingWaterUnsafeState(bot);
  if (before.unsafe) return;
  const landing = dryLandingNudgeTarget(bot, water);
  log.test.info(`${ID}.fish.dry-landing-nudge`, {
    ...details,
    durationMs: FISHING_DRY_LANDING_NUDGE_MS,
    water: positionForLog(water.position),
    start: positionForLog(bot.entity?.position),
    target: landing ? positionForLog(landing.position) : null,
    dryLandingScore: landing?.dryLandingScore ?? null,
  });
  if (!landing) return;

  try {
    bot.setControlState('back', true);
    await sleep(FISHING_DRY_LANDING_NUDGE_MS);
  } finally {
    try {
      bot.setControlState('back', false);
    } catch {}
  }
  const after = fishingWaterUnsafeState(bot);
  if (after.unsafe) {
    triggerWaterRescue(bot);
    throw withCode(new Error(`unsafe water state after dry landing nudge: ${after.reason}`), 'FISHING_WATER_UNSAFE');
  }
}

function startReelInlandPull(bot, water, details = {}) {
  if (details.landingPlan?.reelInlandPull !== true) return;
  if (FISHING_REEL_INLAND_PULL_MS <= 0 || !water || typeof bot.setControlState !== 'function') return;
  const before = fishingWaterUnsafeState(bot);
  if (before.unsafe || !dryLandingNudgeTarget(bot, water)) return;
  log.test.info(`${ID}.fish.reel-inland-pull`, {
    ...details,
    durationMs: FISHING_REEL_INLAND_PULL_MS,
    water: positionForLog(water.position),
    stand: water.activeStand ? positionForLog(water.activeStand.position) : null,
    position: positionForLog(bot.entity?.position),
  });
  try {
    bot.setControlState('back', true);
    const timer = setTimeout(() => {
      try {
        bot.setControlState('back', false);
      } catch {}
    }, FISHING_REEL_INLAND_PULL_MS);
    timer.unref?.();
  } catch {}
}

async function waitForCatchDeltaOrPickup(bot, before, timeoutMs, ctx, beforeItemEntityIds = [], water = null) {
  const started = Date.now();
  const beforeIds = new Set(beforeItemEntityIds);
  let pickupAttempted = false;
  let lastItems = [];
  while (Date.now() - started < timeoutMs) {
    const waterState = fishingWaterUnsafeState(bot);
    if (waterState.unsafe) {
      throw withCode(new Error(`unsafe water state while collecting fishing drop: ${waterState.reason}`), 'FISHING_WATER_UNSAFE');
    }
    const inventoryAfter = inventoryCounts(bot);
    const catchDelta = positiveCatchDelta(before, inventoryAfter);
    if (Object.keys(catchDelta).length > 0) return { inventoryAfter, catchDelta };
    const newItems = nearbyItemEntities(bot)
      .filter((entity) => !beforeIds.has(entity.id))
      .slice(0, 5);
    if (newItems.length > 0) {
      lastItems = newItems;
      log.test.info(`${ID}.fish.item-entity`, {
        items: newItems,
        pickupAttempted,
        inventoryAfter,
      });
      if (!pickupAttempted) {
        pickupAttempted = true;
        const pickupResult = await waitForCatchFlightThenPickup(bot, before, ctx, newItems[0], water, {
          deadlineMs: started + timeoutMs,
        });
        if (pickupResult) return pickupResult;
        const afterPickup = inventoryCounts(bot);
        const pickupDelta = positiveCatchDelta(before, afterPickup);
        if (Object.keys(pickupDelta).length > 0) return { inventoryAfter: afterPickup, catchDelta: pickupDelta };
      }
    }
    await sleep(100);
  }
  throw new Error(`fishing completed but no caught item entered inventory within ${timeoutMs}ms; nearbyItems=${JSON.stringify(lastItems)}`);
}

async function waitForCatchFlightThenPickup(bot, before, ctx, item, water, opts = {}) {
  const flightDeadline = Math.min(
    Date.now() + FISHING_ITEM_FLIGHT_WAIT_MS,
    opts.deadlineMs || Date.now() + FISHING_ITEM_FLIGHT_WAIT_MS,
  );
  let lastItem = item;
  let directDryPickupAttempted = false;
  let dryPickupAttempts = 0;
  const dryPickupTargets = new Set();
  while (Date.now() < flightDeadline) {
    const inventoryAfter = inventoryCounts(bot);
    const catchDelta = positiveCatchDelta(before, inventoryAfter);
    if (Object.keys(catchDelta).length > 0) return { inventoryAfter, catchDelta };

    const current = itemEntityById(bot, item.id);
    if (current) {
      lastItem = current;
      const waterTarget = isWaterPickupTarget(bot, current.position);
      const dryPickup = water ? nearestDryPickupCandidate(bot, water, current.position) : null;
      const dryPickupKey = dryPickup ? blockKey(dryPickup.position) : null;
      const pickupAction = chooseFishingPickupAction({
        waterTarget,
        directDryPickupAttempted,
        dryPickupDistance: dryPickup?.itemDistance,
        dryPickupReach: FISHING_DRY_PICKUP_REACH,
        dryInterceptReach: FISHING_DRY_INTERCEPT_REACH,
        dryPickupAttempts,
        maxDryPickupAttempts: FISHING_MAX_DRY_PICKUP_ATTEMPTS,
        waterPickupFallback: false,
      });
      log.test.info(`${ID}.fish.pickup-wait`, {
        item: current,
        waterTarget,
        dryPickup: dryPickup ? positionForLog(dryPickup.position) : null,
        dryPickupDistance: dryPickup?.itemDistance ?? null,
        pickupAction,
        dryPickupAttempts,
      });
      if ((pickupAction === 'dry-stand' || pickupAction === 'dry-intercept') && dryPickup && !dryPickupTargets.has(dryPickupKey)) {
        dryPickupAttempts += 1;
        dryPickupTargets.add(dryPickupKey);
        water.activeStand = await navigateToFishingStand(bot, ctx, { ...water, standCandidates: [dryPickup] });
      } else if (pickupAction === 'direct-dry' || (!waterTarget && !directDryPickupAttempted)) {
        directDryPickupAttempted = true;
        await tryPickupItemEntity(bot, ctx, current, water, { allowWater: false });
      }
    }
    await sleep(250);
  }

  const inventoryAfter = inventoryCounts(bot);
  const catchDelta = positiveCatchDelta(before, inventoryAfter);
  if (Object.keys(catchDelta).length > 0) return { inventoryAfter, catchDelta };

  const current = itemEntityById(bot, item.id) || lastItem;
  if (current) {
    const waterTarget = isWaterPickupTarget(bot, current.position);
    const dryPickup = water ? nearestDryPickupCandidate(bot, water, current.position) : null;
    const pickupAction = chooseFishingPickupAction({
      waterTarget,
      directDryPickupAttempted,
      dryPickupDistance: dryPickup?.itemDistance,
      dryPickupReach: FISHING_DRY_PICKUP_REACH,
      dryInterceptReach: FISHING_DRY_INTERCEPT_REACH,
      dryPickupAttempts,
      maxDryPickupAttempts: FISHING_MAX_DRY_PICKUP_ATTEMPTS,
      waterPickupFallback: FISHING_WATER_PICKUP_FALLBACK,
    });
    log.test.info(`${ID}.fish.pickup-final`, {
      item: current,
      waterTarget,
      dryPickup: dryPickup ? positionForLog(dryPickup.position) : null,
      dryPickupDistance: dryPickup?.itemDistance ?? null,
      pickupAction,
      waterPickupFallback: FISHING_WATER_PICKUP_FALLBACK,
    });
    if ((pickupAction === 'dry-stand' || pickupAction === 'dry-intercept') && dryPickup) {
      water.activeStand = await navigateToFishingStand(bot, ctx, { ...water, standCandidates: [dryPickup] });
    } else if (pickupAction === 'direct-dry' || pickupAction === 'water-fallback') {
      await tryPickupItemEntity(bot, ctx, current, water, { allowWater: pickupAction === 'water-fallback' });
    }
    const afterPickup = inventoryCounts(bot);
    const pickupDelta = positiveCatchDelta(before, afterPickup);
    if (Object.keys(pickupDelta).length > 0) return { inventoryAfter: afterPickup, catchDelta: pickupDelta };
  }
  return null;
}

async function collectOrFailUncollectedDrops(bot, ctx, baselineItemIds, water) {
  const deadline = Date.now() + CATCH_PICKUP_TIMEOUT_MS;
  let lastDrops = [];
  while (Date.now() < deadline) {
    const waterState = fishingWaterUnsafeState(bot);
    if (waterState.unsafe) {
      await ensureDryFishingStand(bot, ctx, water, { phase: 'uncollected-drop-sweep', reason: waterState.reason });
    }
    const drops = nearbyItemEntities(bot)
      .filter((entity) => !baselineItemIds.has(entity.id))
      .slice(0, 5);
    if (drops.length === 0) return;
    lastDrops = drops;
    log.test.warn(`${ID}.fish.uncollected-drops`, {
      drops,
      action: FISHING_WATER_PICKUP_FALLBACK
        ? 'attempting dry-safe pickup with explicit water fallback enabled'
        : 'attempting dry-safe pickup before final return',
    });
    await tryPickupItemEntity(bot, ctx, drops[0], water, { allowWater: FISHING_WATER_PICKUP_FALLBACK });
    await sleep(250);
  }
  throw new Error(`uncollected fishing item entities remained near fixture after catches: ${JSON.stringify(lastDrops)}`);
}

async function returnAndDeposit(bot, ctx, caughtTotals) {
  const depositItems = Object.entries(caughtTotals).filter(([, count]) => count > 0);
  await depositFishingItems(bot, ctx, depositItems, { requireRod: true, allowNoItems: true, depositRod: true });
}

async function depositPendingFishingItems(bot, ctx, caughtTotals) {
  const depositItems = Object.entries(caughtTotals).filter(([, count]) => count > 0);
  if (depositItems.length === 0) return;
  await depositFishingItems(bot, ctx, depositItems, { requireRod: false, depositRod: false });
}

async function depositFishingItems(bot, ctx, depositItems, opts = {}) {
  if (depositItems.length === 0 && opts.allowNoItems !== true && opts.depositRod === false) {
    throw new Error('no caught items recorded for deposit');
  }
  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    for (const [item, count] of depositItems) {
      await depositLogged(bot, container, item, count, ID);
    }
    if (opts.depositRod !== false) {
      const rodCount = inventoryCounts(bot)[FISHING_ROD] || 0;
      if (rodCount >= 1) {
        await depositLogged(bot, container, FISHING_ROD, 1, ID);
      } else if (opts.requireRod) {
        throw new Error('cannot return fishing_rod; no fishing_rod remains in inventory after fishing');
      } else {
        log.test.warn(`${ID}.cleanup.no-rod`, { inventory: inventoryCounts(bot), equipment: equipmentSummary(bot) });
      }
    }
    await closeLoggedChest(container, ID);
    closed = true;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }
}

async function lookAtWater(bot, water) {
  const pos = preferredCastTarget(water);
  await bot.lookAt(pos, true);
  log.test.info(`${ID}.look-at-water`, {
    water: positionForLog(water.position),
    lookAt: positionForLog(pos),
    stand: water.activeStand ? positionForLog(water.activeStand.position) : null,
    castBias: water.activeStand ? castBiasForStand(water.position, water.activeStand.position) : null,
  });
}

function fishingLandingPlan(water, attempt) {
  const stand = water?.activeStand || null;
  const catchLandingScore = Number.isFinite(stand?.catchLandingScore) ? stand.catchLandingScore : 0;
  const dryLandingScore = Number.isFinite(stand?.dryLandingScore) ? stand.dryLandingScore : 0;
  const mode = FISHING_LANDING_MOTION_MODE;
  const base = {
    mode,
    stand: stand ? positionForLog(stand.position) : null,
    catchLandingScore,
    dryLandingScore,
    comfortScore: FISHING_LANDING_SCORE_COMFORT,
    minimumScore: FISHING_LANDING_SCORE_MINIMUM,
    reelInlandPull: false,
    postReelNudge: false,
  };

  if (mode === 'off') return { ...base, reason: 'landing-motion-disabled' };
  if (mode === 'always') {
    return {
      ...base,
      reelInlandPull: true,
      postReelNudge: true,
      reason: 'landing-motion-forced',
    };
  }
  if (catchLandingScore >= FISHING_LANDING_SCORE_COMFORT) {
    return { ...base, reason: 'comfortable-dry-catch-runway' };
  }
  if (catchLandingScore >= FISHING_LANDING_SCORE_MINIMUM) {
    return {
      ...base,
      reelInlandPull: attempt % 2 === 0,
      postReelNudge: false,
      reason: attempt % 2 === 0 ? 'moderate-runway-short-reel-pull' : 'moderate-runway-hold-position',
    };
  }
  return {
    ...base,
    reelInlandPull: true,
    postReelNudge: attempt % 2 === 1,
    reason: attempt % 2 === 1 ? 'weak-runway-pull-and-nudge' : 'weak-runway-pull-only',
  };
}

function preferredCastTarget(water) {
  const bias = water.activeStand ? castBiasForStand(water.position, water.activeStand.position) : { x: 0, z: 0 };
  return water.position.offset(0.5 + bias.x, 1.05, 0.5 + bias.z);
}

function castBiasForStand(waterPosition, standPosition) {
  const dx = standPosition.x - waterPosition.x;
  const dz = standPosition.z - waterPosition.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length <= 0) return { x: 0, z: 0 };
  const bias = 0.32;
  return {
    x: Math.round((dx / length) * bias * 100) / 100,
    z: Math.round((dz / length) * bias * 100) / 100,
  };
}

async function ensureRodHeldForCast(bot) {
  if (bot.heldItem?.name === FISHING_ROD) return;
  if ((inventoryCounts(bot)[FISHING_ROD] || 0) < 1) {
    log.test.error(`${ID}.rod.missing-before-cast`, {
      heldItem: bot.heldItem?.name || null,
      inventory: inventoryCounts(bot),
      equipment: equipmentSummary(bot),
    });
    throw withCode(new Error('no fishing_rod available to re-equip before cast'), 'FISHING_ROD_NOT_AVAILABLE');
  }
  log.test.info(`${ID}.rod.re-equip`, {
    reason: 'before-cast',
    heldItem: bot.heldItem?.name || null,
    inventory: inventoryCounts(bot),
    equipment: equipmentSummary(bot),
  });
  await equipLogged(bot, FISHING_ROD, 'hand', ID);
}

function positiveCatchDelta(before, after) {
  const delta = diffCounts(before, after);
  delete delta[FISHING_ROD];
  for (const [item, count] of Object.entries(delta)) {
    if (count <= 0) delete delta[item];
  }
  return delta;
}

function addCounts(target, delta) {
  for (const [item, count] of Object.entries(delta)) {
    target[item] = (target[item] || 0) + count;
  }
}

function clearCounts(target, counts = target) {
  for (const item of Object.keys(counts)) delete target[item];
}

async function tryPickupItemEntity(bot, ctx, item, water = null, opts = {}) {
  const pickupCtx = {
    ...ctx,
    callState: {},
    currentSubtask: `${ID}.pickup-catch`,
  };
  if (isWaterPickupTarget(bot, item.position) && water) {
    if (!FISHING_ALLOW_WATER_PICKUP || opts.allowWater === false) {
      log.test.warn(`${ID}.fish.pickup-water-target`, {
        item,
        position: positionForLog(bot.entity?.position),
        action: 'return-to-dry-stand-before-rechecking-drop',
      });
      const dryPickup = nearestDryPickupCandidate(bot, water, item.position);
      water.activeStand = await navigateToFishingStand(bot, pickupCtx, dryPickup ? { ...water, standCandidates: [dryPickup] } : water);
      return;
    }

    log.test.warn(`${ID}.fish.pickup-water-entry`, {
      item,
      position: positionForLog(bot.entity?.position),
      action: 'controlled-water-pickup-then-dry-stand-recovery',
    });
    const nav = await gotoSkill(bot, {
      x: item.position.x,
      y: item.position.y,
      z: item.position.z,
      range: 1.2,
    }, pickupCtx);
    log.test.info(`${ID}.fish.pickup-water-navigate`, {
      ok: !!nav.ok,
      preempted: !!nav.preempted,
      reason: nav.reason,
      item,
      position: positionForLog(bot.entity?.position),
      waterState: fishingWaterUnsafeState(bot),
    });
    const waterState = fishingWaterUnsafeState(bot);
    if (waterState.unsafe) {
      await ensureDryFishingStand(bot, pickupCtx, water, {
        phase: 'after-water-pickup',
        item: item.id,
        reason: waterState.reason,
      });
    }
    return;
  }

  const nav = await gotoSkill(bot, {
    x: item.position.x,
    y: item.position.y,
    z: item.position.z,
    range: 1.2,
  }, pickupCtx);
  log.test.info(`${ID}.fish.pickup-navigate`, {
    ok: !!nav.ok,
    preempted: !!nav.preempted,
    reason: nav.reason,
    item,
    position: positionForLog(bot.entity?.position),
  });
}

function cancelFishing(bot) {
  try {
    bot.activateItem();
  } catch {}
}

function triggerWaterRescue(bot) {
  if (typeof bot.setControlState !== 'function') return;
  try {
    bot.setControlState('jump', true);
    const timer = setTimeout(() => {
      try {
        bot.setControlState('jump', false);
      } catch {}
    }, 1200);
    timer.unref?.();
  } catch {}
}

function fishingWaterUnsafeState(bot) {
  const pos = bot.entity?.position;
  const feet = readBlockName(bot, pos);
  const head = readBlockName(bot, offsetPosition(pos, 0, 1, 0));
  const eyes = readBlockName(bot, offsetPosition(pos, 0, 1.62, 0));
  const inWater = bot.entity?.isInWater === true || hasWaterName(feet) || hasWaterName(head) || hasWaterName(eyes);
  const submerged = hasWaterName(head) || hasWaterName(eyes);
  const oxygenLevel = typeof bot.oxygenLevel === 'number'
    ? bot.oxygenLevel
    : typeof bot.entity?.oxygenLevel === 'number'
      ? bot.entity.oxygenLevel
      : null;
  const readableDryAir = [feet, head, eyes].every((name) => EMPTY_BLOCKS.has(String(name || '')));
  const oxygenLow = oxygenLevel != null && oxygenLevel <= 12 && (bot.entity?.isInWater === true || !readableDryAir);
  const velocityY = bot.entity?.velocity?.y ?? 0;
  const sinking = inWater && velocityY < -0.05;
  if (!inWater && !submerged && !oxygenLow && !sinking) return { unsafe: false };
  const reasons = [];
  if (inWater) reasons.push('in-water');
  if (submerged) reasons.push('submerged');
  if (oxygenLow) reasons.push(`oxygen=${oxygenLevel}`);
  if (sinking) reasons.push(`sinking=${Math.round(velocityY * 100) / 100}`);
  return {
    unsafe: true,
    reason: reasons.join(', '),
    inWater,
    submerged,
    oxygenLevel,
    oxygenLow,
    sinking,
    feet,
    head,
    eyes,
  };
}

function isWaterPickupTarget(bot, position) {
  const target = blockPosition(position);
  const feet = readBlockName(bot, target);
  const below = readBlockName(bot, offsetPosition(target, 0, -1, 0));
  return hasWaterName(feet) || hasWaterName(below);
}

function hasWaterName(name) {
  return WATER_BODY_BLOCKS.has(String(name || ''));
}

function readBlockName(bot, position) {
  if (!position || typeof bot.blockAt !== 'function') return null;
  try {
    return bot.blockAt(blockPosition(position))?.name || null;
  } catch {
    return null;
  }
}

function blockPosition(position) {
  if (!position) return null;
  return new Vec3(Math.floor(position.x || 0), Math.floor(position.y || 0), Math.floor(position.z || 0));
}

function vecFromPlain(position) {
  if (!position) return new Vec3(0, 0, 0);
  if (typeof position.offset === 'function' && typeof position.distanceTo === 'function') return position;
  return new Vec3(position.x || 0, position.y || 0, position.z || 0);
}

function offsetPosition(position, x, y, z) {
  if (!position) return null;
  if (typeof position.offset === 'function') return position.offset(x, y, z);
  return new Vec3((position.x || 0) + x, (position.y || 0) + y, (position.z || 0) + z);
}

function withCode(err, code) {
  err.code = code;
  return err;
}

function isTransientCastFailure(err) {
  return err?.code === 'FISHING_BOBBER_NOT_SPAWNED' || err?.code === 'FISHING_BOBBER_DISAPPEARED';
}

async function cleanupAfterFailure(bot, ctx, caughtTotals, details) {
  const caughtEntries = cleanupCaughtEntries(bot, caughtTotals, details.initialInventory);
  const rodCount = inventoryCounts(bot)[FISHING_ROD] || 0;
  if (!details.rodTouched && caughtEntries.length === 0 && rodCount < 1) return;
  log.test.warn(`${ID}.cleanup.start`, {
    reason: details.reason,
    rodTouched: details.rodTouched,
    caughtTotals,
    inventory: inventoryCounts(bot),
    equipment: equipmentSummary(bot),
  });
  cancelFishing(bot);
  try {
    await depositFishingItems(bot, ctx, caughtEntries, { requireRod: false, allowNoItems: true });
    log.test.info(`${ID}.cleanup.done`, { inventory: inventoryCounts(bot), caughtTotals });
  } catch (cleanupErr) {
    log.test.error(`${ID}.cleanup.failed`, { reason: cleanupErr?.message || String(cleanupErr) });
  }
}

function availableCaughtEntries(bot, requestedCounts) {
  const available = inventoryCounts(bot);
  return Object.entries(requestedCounts)
    .map(([item, count]) => [item, Math.min(count, available[item] || 0)])
    .filter(([, count]) => count > 0);
}

function cleanupCaughtEntries(bot, requestedCounts, initialInventory = {}) {
  const merged = Object.fromEntries(availableCaughtEntries(bot, requestedCounts));
  const cleanupDelta = positiveCatchDelta(initialInventory || {}, inventoryCounts(bot));
  for (const [item, count] of Object.entries(cleanupDelta)) {
    if (count > 0) merged[item] = Math.max(merged[item] || 0, count);
  }
  return Object.entries(merged).filter(([, count]) => count > 0);
}

function isEquipped(bot, item) {
  return Object.values(equipmentSummary(bot)).some((equipped) => equipped?.name === item);
}

function isPassable(block) {
  return !block
    || EMPTY_BLOCKS.has(block.name)
    || (block.boundingBox === 'empty' && !LIQUID_BLOCKS.has(block.name) && !WATER_BODY_BLOCKS.has(block.name));
}

function isStandable(block) {
  return !!block && block.boundingBox === 'block' && !LIQUID_BLOCKS.has(block.name) && !UNSAFE_STAND_BLOCKS.has(block.name);
}

function itemEntityIds(bot) {
  return nearbyItemEntities(bot).map((entity) => entity.id);
}

function itemEntityById(bot, id) {
  return nearbyItemEntities(bot, 24).find((entity) => entity.id === id) || null;
}

function nearbyItemEntities(bot, radius = 16) {
  const origin = bot.entity?.position;
  if (!origin) return [];
  return Object.values(bot.entities || {})
    .filter((entity) => entity?.name === 'item' && entity.position)
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      position: positionForLog(entity.position),
      distance: Math.round(distance(origin, entity.position) * 100) / 100,
    }))
    .filter((entity) => entity.distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.id - b.id);
}

function nearestDryPickupCandidate(bot, water, itemPosition) {
  if (!water || !itemPosition) return null;
  const item = vecFromPlain(itemPosition);
  return findFishingStandCandidates(bot, water)
    .map((candidate) => ({
      ...candidate,
      itemDistance: Math.round(distance(candidate.position.offset(0.5, 0, 0.5), item) * 100) / 100,
    }))
    .sort((a, b) => a.itemDistance - b.itemDistance || a.horizontalDistance - b.horizontalDistance)[0] || null;
}

function dryLandingNudgeTarget(bot, water) {
  const current = bot.entity?.position;
  if (!current || !water?.position) return null;
  const currentBlock = blockPosition(current);
  const away = awayFromWaterStep(currentBlock, water.position);
  if (!away) return null;
  const target = currentBlock.offset(away.x, 0, away.z);
  const feet = bot.blockAt(target);
  const head = bot.blockAt(target.offset(0, 1, 0));
  const below = bot.blockAt(target.offset(0, -1, 0));
  if (!isPassable(feet) || !isPassable(head) || !isStandable(below)) return null;
  return {
    position: target,
    dryLandingScore: dryLandingScore(bot, target, water.position),
  };
}

function catchLandingScore(bot, standPosition, waterPosition) {
  if (!standPosition || !waterPosition) return 0;
  let score = dryLandingScore(bot, standPosition, waterPosition);
  const away = awayFromWaterStep(standPosition, waterPosition);
  if (!away) return score;

  for (let step = 1; step <= 4; step += 1) {
    const position = standPosition.offset(away.x * step, 0, away.z * step);
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const below = bot.blockAt(position.offset(0, -1, 0));
    if (isPassable(feet) && isPassable(head) && isStandable(below)) {
      score += 4;
    } else {
      score -= 3;
      break;
    }
  }

  const cross = { x: away.z, z: -away.x };
  for (const side of [-1, 1]) {
    const position = standPosition.offset(cross.x * side, 0, cross.z * side);
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const below = bot.blockAt(position.offset(0, -1, 0));
    if (isPassable(feet) && isPassable(head) && isStandable(below)) score += 2;
  }

  return score;
}

function dryLandingScore(bot, standPosition, waterPosition) {
  if (!standPosition || !waterPosition) return 0;
  let score = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const position = standPosition.offset(dx, 0, dz);
      const feet = bot.blockAt(position);
      const head = bot.blockAt(position.offset(0, 1, 0));
      const below = bot.blockAt(position.offset(0, -1, 0));
      if (isPassable(feet) && isPassable(head) && isStandable(below)) score += 1;
    }
  }

  const away = awayFromWaterStep(standPosition, waterPosition);
  if (!away) return score;
  for (let step = 1; step <= 2; step += 1) {
    const position = standPosition.offset(away.x * step, 0, away.z * step);
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const below = bot.blockAt(position.offset(0, -1, 0));
    if (isPassable(feet) && isPassable(head) && isStandable(below)) score += 3;
  }
  return score;
}

function awayFromWaterStep(position, waterPosition) {
  const dx = Math.sign(Math.round(position.x - waterPosition.x));
  const dz = Math.sign(Math.round(position.z - waterPosition.z));
  if (dx === 0 && dz === 0) return null;
  if (Math.abs(position.x - waterPosition.x) >= Math.abs(position.z - waterPosition.z)) {
    return { x: dx || 0, z: 0 };
  }
  return { x: 0, z: dz || 0 };
}

function blockKey(position) {
  const block = blockPosition(position);
  return `${block.x},${block.y},${block.z}`;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function openWaterScore(bot, position) {
  let score = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (bot.blockAt(position.offset(dx, 0, dz))?.name === 'water') score += 1;
    }
  }
  return score;
}

function fishingBobberType(bot) {
  if (bot.supportFeature?.('fishingBobberCorrectlyNamed')) {
    const id = bot.registry?.entitiesByName?.fishing_bobber?.id;
    if (id !== undefined) return id;
  }
  return 90;
}

function packetPosition(packet) {
  if (packet.position) return new Vec3(packet.position.x, packet.position.y, packet.position.z);
  return new Vec3(packet.x || 0, packet.y || 0, packet.z || 0);
}

function particleSummary(packet, bobberPosition) {
  const particleName = packet.particle?.type || packet.particle?.name || particleNameById(packet);
  const amount = packet.amount ?? packet.particles ?? 0;
  const x = packet.x || 0;
  const y = packet.y || 0;
  const z = packet.z || 0;
  const distanceToBobber = Math.round(bobberPosition.distanceTo(new Vec3(x, bobberPosition.y, z)) * 100) / 100;
  return {
    particle: particleName,
    amount,
    position: { x, y, z },
    distanceToBobber,
    nearBobber: distanceToBobber <= 1.75,
  };
}

function particleNameById(packet) {
  if (packet.particleId === undefined) return 'unknown';
  return String(packet.particleId);
}

function isLikelyBiteParticle(sample) {
  if (!sample.nearBobber) return false;
  const particle = String(sample.particle || '');
  if (particle.includes('splash')) return true;
  if (!particle.includes('fishing') && !particle.includes('bubble')) return false;
  if (sample.amount >= 6) return true;
  if (particle.includes('fishing') && sample.amount > 0 && sample.distanceToBobber <= 0.25) return true;
  return false;
}

function formatPos(position) {
  return `${position.x},${position.y},${position.z}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
