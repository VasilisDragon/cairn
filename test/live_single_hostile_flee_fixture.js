import { ReactiveController, scanWaterHazard } from '../src/reactive/reactive.js';
import config from '../src/config.js';
import log from '../src/logger.js';
import { evaluateDryHostileFixtureBaseline } from './live_hostile_fixture_status.js';
import {
  createFleeFixtureMetrics,
  evaluateFleeFixtureMetrics,
  observeFleeFixtureSample,
  observeFleeFixtureTransitions,
} from './live_flee_metrics.js';
import {
  envNumber,
  nearbyHostiles,
  positionForLog,
  runLiveScenario,
  waitForLiveChunks,
} from './live_helpers.js';
import { buildLiveAdminPlan, runLiveAdminPlan } from '../scripts/live-admin-commands.js';

const ID = 'live_single_hostile_flee_fixture';
const DEAGGRO_RADIUS = config.reactive.hostileExitRadius ?? 42;
const MONITOR_MS = boundedEnvNumber('MCBOT_LIVE_HOSTILE_MONITOR_MS', 45000, 120000);
const FIXTURE_RADIUS = 24;
const TRACKING_RADIUS = Math.max(48, Math.ceil(DEAGGRO_RADIUS) + 6);
const DRY_BASELINE_WAIT_MS = 15000;
const DRY_BASELINE_STABLE_MS = 1000;
const METRIC_SAMPLE_MS = 100;
const TRACKING_LOG_MS = 1000;
const HOSTILE_WAIT_MS = boundedEnvNumber('MCBOT_LIVE_HOSTILE_WAIT_MS', 0, 120000);
const HOSTILE_WAIT_POLL_MS = Math.max(100, boundedEnvNumber('MCBOT_LIVE_HOSTILE_WAIT_POLL_MS', 1000, 10000));
const MAX_STATE_CHANGES = Math.max(2, boundedEnvNumber('MCBOT_LIVE_HOSTILE_MAX_STATE_CHANGES', 8, 40));
const MAX_WATER_ESCAPE_ENTRIES = boundedEnvNumber('MCBOT_LIVE_HOSTILE_MAX_WATER_ESCAPE_ENTRIES', 2, 20);
const ALLOWED_FIXTURE_HOSTILES = new Set(['zombie', 'spider']);
const POST_STAGING_ADMIN_ACTIONS = new Set(['summon-zombie', 'summon-spider']);
const POST_STAGING_SPAWN_MODES = new Set(['near-bot', 'fixed']);

runLiveScenario(ID, async ({ bot, finish }) => {
  if (process.env.MCBOT_LIVE_HOSTILE_FIXTURE_OK !== '1') {
    throw new Error('single-hostile fixture is disabled; run only after A-D pass with MCBOT_LIVE_HOSTILE_FIXTURE_OK=1 and one zombie/spider in safe terrain');
  }

  await waitForLiveChunks(bot, ID);
  assertNoHostilesBeforeReactive(bot);
  const controller = new ReactiveController(bot);
  await waitForDryFixtureBaseline(bot, controller);
  if (process.env.MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN === '1') {
    await runPostStagingAdminSetup(bot);
  }
  const fixture = await waitForSingleAllowedHostile(bot);
  const fixtureHostileId = fixture.fixtureHostiles[0].id;
  log.test.info(`${ID}.fixture-ready`, {
    radius: FIXTURE_RADIUS,
    trackingRadius: TRACKING_RADIUS,
    deaggroRadius: DEAGGRO_RADIUS,
    monitorMs: MONITOR_MS,
    waitedMs: fixture.waitedMs,
    hostile: fixture.fixtureHostiles[0],
    botPosition: positionForLog(bot.entity?.position),
  });

  const metrics = createFleeFixtureMetrics(controller.state);
  let transitionCursor = controller.transitionHistory?.length ?? 0;
  const started = Date.now();
  const observe = (fixtureHostile = undefined) => {
    const transitions = Array.isArray(controller.transitionHistory)
      ? controller.transitionHistory.slice(transitionCursor)
      : [];
    transitionCursor += transitions.length;
    observeFleeFixtureTransitions(metrics, transitions);
    const pathfinderIdle = bot.pathfinderOwner?.isIdle?.() ?? null;
    observeFleeFixtureSample(metrics, {
      state: controller.state,
      pathfinderIdle,
      countStateChanges: false,
      ...(fixtureHostile !== undefined && { nearestDistance: fixtureHostile?.distance ?? null }),
    });
    return pathfinderIdle;
  };

  const sampleInterval = setInterval(observe, METRIC_SAMPLE_MS);
  const logInterval = setInterval(() => {
    const hostiles = nearbyHostiles(bot, TRACKING_RADIUS);
    const nearestHostile = hostiles[0] || null;
    const fixtureHostile = hostiles.find((entity) => entity.id === fixtureHostileId) || null;
    const otherHostiles = hostiles.filter((entity) => entity.id !== fixtureHostileId);
    const pathfinderIdle = observe(fixtureHostile);
    log.test.info(`${ID}.tracking`, {
      state: controller.state,
      fixtureHostile,
      nearestHostile,
      otherHostiles,
      trackingRadius: TRACKING_RADIUS,
      deaggroRadius: DEAGGRO_RADIUS,
      pathfinderIdle,
      sprinting: bot.controlState?.sprint ?? null,
      health: bot.health,
      food: bot.food,
      stateChanges: metrics.stateChanges,
      waterEscapeEntries: metrics.waterEscapeEntries,
      fleeSamples: metrics.fleeSamples,
      pathfinderActiveFleeSamples: metrics.pathfinderActiveFleeSamples,
    });
  }, TRACKING_LOG_MS);

  setTimeout(() => {
    clearInterval(sampleInterval);
    clearInterval(logInterval);
    const finalHostiles = nearbyHostiles(bot, TRACKING_RADIUS);
    const finalNearestHostile = finalHostiles[0] || null;
    const finalFixtureHostile = finalHostiles.find((entity) => entity.id === fixtureHostileId) || null;
    const finalOtherHostiles = finalHostiles.filter((entity) => entity.id !== fixtureHostileId);
    observe(finalFixtureHostile);
    if (bot.health <= 4) {
      finish(2, `${ID}.failure`, { reason: `health reached critical threshold: ${bot.health}` });
      return;
    }
    const evaluation = evaluateFleeFixtureMetrics(metrics, {
      maxStateChanges: MAX_STATE_CHANGES,
      maxWaterEscapeEntries: MAX_WATER_ESCAPE_ENTRIES,
      minNormalAfterFleeDistance: DEAGGRO_RADIUS,
    });
    if (!evaluation.ok) {
      finish(2, `${ID}.failure`, {
        reason: evaluation.reason,
        maxStateChanges: MAX_STATE_CHANGES,
        maxWaterEscapeEntries: MAX_WATER_ESCAPE_ENTRIES,
        deaggroRadius: DEAGGRO_RADIUS,
        trackingRadius: TRACKING_RADIUS,
        finalFixtureHostile,
        finalNearestHostile,
        finalOtherHostiles,
        ...metrics,
      });
      return;
    }
    finish(0, `${ID}.done`, {
      durationMs: Date.now() - started,
      health: bot.health,
      food: bot.food,
      maxStateChanges: MAX_STATE_CHANGES,
      maxWaterEscapeEntries: MAX_WATER_ESCAPE_ENTRIES,
      deaggroRadius: DEAGGRO_RADIUS,
      trackingRadius: TRACKING_RADIUS,
      finalFixtureHostile,
      finalNearestHostile,
      finalOtherHostiles,
      ...metrics,
    });
  }, MONITOR_MS);
});

function assertNoHostilesBeforeReactive(bot) {
  const hostiles = nearbyHostiles(bot, FIXTURE_RADIUS);
  if (hostiles.length === 0) return;
  const status = {
    ...evaluateDryHostileFixtureBaseline({
      water: null,
      onGround: bot.entity?.onGround ?? null,
      health: bot.health ?? null,
      state: 'NORMAL',
      hostiles,
    }),
    state: 'NOT_STARTED',
    position: positionForLog(bot.entity?.position),
    inWater: bot.entity?.isInWater === true,
    oxygenLevel: bot.oxygenLevel ?? null,
    onGround: bot.entity?.onGround ?? null,
    health: bot.health ?? null,
    food: bot.food ?? null,
    hostiles,
    water: null,
  };
  log.test.info(`${ID}.staging-check`, {
    waitMs: DRY_BASELINE_WAIT_MS,
    stableMs: 0,
    ...status,
  });
  const err = new Error(`unsafe hostile fixture staging: ${status.reason}`);
  err.fields = { staging: status };
  throw err;
}

async function waitForDryFixtureBaseline(bot, controller) {
  const deadline = Date.now() + DRY_BASELINE_WAIT_MS;
  let stableSince = 0;
  let lastLogAt = 0;
  let lastStatus = null;
  while (Date.now() <= deadline) {
    const now = Date.now();
    const status = dryFixtureBaselineStatus(bot, controller);
    lastStatus = status;
    if (now - lastLogAt >= 1000) {
      log.test.info(`${ID}.staging-check`, {
        waitMs: DRY_BASELINE_WAIT_MS,
        stableMs: stableSince > 0 ? now - stableSince : 0,
        ...status,
      });
      lastLogAt = now;
    }
    if (status.stop) {
      const err = new Error(`unsafe hostile fixture staging: ${status.reason}`);
      err.fields = { staging: status };
      throw err;
    }
    if (status.safe) {
      if (stableSince === 0) stableSince = now;
      if (now - stableSince >= DRY_BASELINE_STABLE_MS) {
        log.test.info(`${ID}.staging-ready`, {
          stableMs: now - stableSince,
          ...status,
        });
        return;
      }
    } else {
      stableSince = 0;
    }
    await sleep(250);
  }

  const reason = lastStatus?.reason || 'unknown staging status';
  const err = new Error(`unsafe hostile fixture staging: bot did not hold stable dry ground for ${DRY_BASELINE_STABLE_MS}ms within ${DRY_BASELINE_WAIT_MS}ms (${reason})`);
  err.fields = { staging: lastStatus };
  throw err;
}

function dryFixtureBaselineStatus(bot, controller) {
  const water = scanWaterHazard(bot, { holdInWater: bot.entity?.isInWater === true || controller.state === 'WATER_ESCAPE' });
  const onGround = bot.entity?.onGround ?? null;
  const health = bot.health ?? null;
  const hostiles = nearbyHostiles(bot, FIXTURE_RADIUS);
  const baseline = evaluateDryHostileFixtureBaseline({
    water,
    onGround,
    health,
    state: controller.state,
    hostiles,
  });
  return {
    ...baseline,
    state: controller.state,
    position: positionForLog(bot.entity?.position),
    inWater: bot.entity?.isInWater === true,
    oxygenLevel: bot.oxygenLevel ?? null,
    onGround,
    health,
    food: bot.food ?? null,
    hostiles,
    water: water ? {
      submerged: water.submerged,
      oxygenLow: water.oxygenLow,
      sinking: water.sinking,
      holdingInWater: water.holdingInWater === true,
    } : null,
  };
}

async function waitForSingleAllowedHostile(bot) {
  const deadline = Date.now() + HOSTILE_WAIT_MS;
  let attempt = 0;
  if (HOSTILE_WAIT_MS > 0) {
    log.test.info(`${ID}.fixture-wait.start`, {
      waitMs: HOSTILE_WAIT_MS,
      pollMs: HOSTILE_WAIT_POLL_MS,
      radius: FIXTURE_RADIUS,
      allowedHostiles: [...ALLOWED_FIXTURE_HOSTILES],
      botPosition: positionForLog(bot.entity?.position),
    });
  }

  while (true) {
    attempt += 1;
    const waitedMs = Math.max(0, Date.now() - (deadline - HOSTILE_WAIT_MS));
    const allHostiles = nearbyHostiles(bot, FIXTURE_RADIUS);
    const fixtureHostiles = allHostiles.filter((entity) => ALLOWED_FIXTURE_HOSTILES.has(entity.name));
    const otherHostiles = allHostiles.filter((entity) => !ALLOWED_FIXTURE_HOSTILES.has(entity.name));
    log.test.info(`${ID}.fixture-check`, {
      attempt,
      radius: FIXTURE_RADIUS,
      waitedMs,
      hostiles: fixtureHostiles,
      otherHostiles,
      allHostiles,
    });

    if (otherHostiles.length > 0) {
      const summary = otherHostiles.map((entity) => `${entity.name}@${entity.distance}`).join(', ');
      throw new Error(`expected no other hostiles within ${FIXTURE_RADIUS} blocks; found ${otherHostiles.length}: ${summary}`);
    }
    if (fixtureHostiles.length === 1) return { allHostiles, fixtureHostiles, otherHostiles, waitedMs };
    if (fixtureHostiles.length > 1) {
      const summary = fixtureHostiles.map((entity) => `${entity.name}@${entity.distance}`).join(', ');
      throw new Error(`expected exactly one zombie/spider within ${FIXTURE_RADIUS} blocks; found ${fixtureHostiles.length}: ${summary}`);
    }
    if (Date.now() >= deadline) {
      const suffix = HOSTILE_WAIT_MS > 0 ? ` after waiting ${HOSTILE_WAIT_MS}ms` : '';
      throw new Error(`expected exactly one zombie/spider within ${FIXTURE_RADIUS} blocks${suffix}; found 0`);
    }
    await sleep(Math.min(HOSTILE_WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

async function runPostStagingAdminSetup(bot) {
  const action = process.env.MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN_ACTION || 'summon-zombie';
  if (!POST_STAGING_ADMIN_ACTIONS.has(action)) {
    throw new Error(`post-staging hostile admin action must be summon-zombie or summon-spider; got "${action}"`);
  }
  const spawn = hostileSpawnArgs(bot);
  const args = spawn.args;
  const plan = buildLiveAdminPlan([action, ...args]);
  if (!plan.ok) throw new Error(`post-staging hostile admin plan invalid: ${plan.reason}`);

  log.test.info(`${ID}.admin.spawn.start`, {
    action,
    spawnMode: spawn.mode,
    spawn: hostileSpawnPositionForLog(args),
    botPosition: positionForLog(bot.entity?.position),
  });

  let result;
  try {
    result = await runLiveAdminPlan(plan);
  } catch (err) {
    throw new Error(`post-staging hostile admin setup failed: ${err?.message || String(err)}`);
  }

  log.test.info(`${ID}.admin.spawn`, {
    action: result.action,
    dryRun: result.dryRun === true,
    commandCount: result.commandCount ?? result.commands?.length ?? null,
    commands: result.commands,
    responses: result.responses?.map((entry) => ({
      command: entry.command,
      response: entry.response,
      type: entry.type,
    })) ?? null,
  });
}

function hostileSpawnArgs(bot) {
  const mode = process.env.MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_MODE || 'near-bot';
  if (!POST_STAGING_SPAWN_MODES.has(mode)) {
    throw new Error(`post-staging hostile spawn mode must be near-bot or fixed; got "${mode}"`);
  }
  if (mode === 'near-bot') return nearBotHostileSpawnArgs(bot);
  return fixedHostileSpawnArgs();
}

function nearBotHostileSpawnArgs(bot) {
  const position = bot.entity?.position;
  if (!position) throw new Error('cannot spawn hostile near bot before bot position is available');
  const dx = boundedSignedEnvNumber('MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DX', 4, 12);
  const dy = boundedSignedEnvNumber('MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DY', 0, 4);
  const dz = boundedSignedEnvNumber('MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DZ', 0, 12);
  return {
    mode: 'near-bot',
    args: [
      formatCoordinate(position.x + dx),
      formatCoordinate(Math.floor(position.y) + dy),
      formatCoordinate(position.z + dz),
    ],
  };
}

function fixedHostileSpawnArgs() {
  return {
    mode: 'fixed',
    args: [
      String(process.env.MCBOT_LIVE_HOSTILE_SPAWN_X || '248'),
      String(process.env.MCBOT_LIVE_HOSTILE_SPAWN_Y || '68'),
      String(process.env.MCBOT_LIVE_HOSTILE_SPAWN_Z || '428'),
    ],
  };
}

function hostileSpawnPositionForLog(args) {
  const [x, y, z] = args.map((value) => Number(value));
  return { x, y, z };
}

function boundedEnvNumber(name, fallback, max) {
  return Math.max(0, Math.min(max, envNumber(name, fallback)));
}

function boundedSignedEnvNumber(name, fallback, maxAbs) {
  const value = envNumber(name, fallback);
  return Math.max(-maxAbs, Math.min(maxAbs, value));
}

function formatCoordinate(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
