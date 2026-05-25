import config from '../src/config.js';
import log from '../src/logger.js';
import { ReactiveController, scanWaterHazard } from '../src/reactive/reactive.js';
import { buildLiveAdminPlan, runLiveAdminPlan } from '../scripts/live-admin-commands.js';
import { evaluateDryHostileFixtureBaseline } from './live_hostile_fixture_status.js';
import {
  createFleeFixtureMetrics,
  observeFleeFixtureSample,
  observeFleeFixtureTransitions,
} from './live_flee_metrics.js';
import {
  HOSTILE_ESCALATION_WAVES,
  evaluateHostileEscalationMetrics,
  hostileEscalationExpectedSpawnCount,
  hostileEscalationSpawnArgs,
} from './live_hostile_escalation_plan.js';
import {
  envNumber,
  nearbyHostiles,
  positionForLog,
  runLiveScenario,
  waitForLiveChunks,
} from './live_helpers.js';

const ID = 'live_hostile_escalation_fixture';
const FIXTURE_ENV = 'MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK';
const DEAGGRO_RADIUS = config.reactive.hostileExitRadius ?? 42;
const FIXTURE_RADIUS = 24;
const TRACKING_RADIUS = Math.max(64, Math.ceil(DEAGGRO_RADIUS) + 16);
const DRY_BASELINE_WAIT_MS = 15000;
const DRY_BASELINE_STABLE_MS = 1000;
const METRIC_SAMPLE_MS = 100;
const TRACKING_LOG_MS = 1000;
const BETWEEN_WAVE_TIMEOUT_MS = boundedEnvNumber('MCBOT_LIVE_HOSTILE_ESCALATION_BETWEEN_WAVE_TIMEOUT_MS', 25000, 60000);
const FINAL_ESCAPE_TIMEOUT_MS = boundedEnvNumber('MCBOT_LIVE_HOSTILE_ESCALATION_FINAL_ESCAPE_TIMEOUT_MS', 60000, 120000);
const POST_WAVE_SETTLE_MS = boundedEnvNumber('MCBOT_LIVE_HOSTILE_ESCALATION_POST_WAVE_SETTLE_MS', 2500, 10000);
const CLEAR_SETTLE_MS = boundedEnvNumber('MCBOT_LIVE_HOSTILE_ESCALATION_CLEAR_SETTLE_MS', 750, 5000);
const CLEAR_ATTEMPTS = boundedEnvNumber('MCBOT_LIVE_HOSTILE_ESCALATION_CLEAR_ATTEMPTS', 8, 20);
const MAX_STATE_CHANGES = Math.max(4, boundedEnvNumber('MCBOT_LIVE_HOSTILE_ESCALATION_MAX_STATE_CHANGES', 18, 80));
const MAX_WATER_ESCAPE_ENTRIES = boundedEnvNumber('MCBOT_LIVE_HOSTILE_ESCALATION_MAX_WATER_ESCAPE_ENTRIES', 3, 20);
const EXPECTED_SPAWNED_HOSTILES = hostileEscalationExpectedSpawnCount();

runLiveScenario(ID, async ({ bot, finish }) => {
  if (process.env[FIXTURE_ENV] !== '1') {
    throw new Error(`refusing ${ID} without ${FIXTURE_ENV}=1; this scenario intentionally spawns stacked hostile waves on a private/local server`);
  }
  if (process.env.MCBOT_LIVE_ADMIN_OK !== '1') {
    throw new Error(`refusing ${ID} without MCBOT_LIVE_ADMIN_OK=1; hostile escalation requires explicit private-server RCON permission`);
  }

  await waitForLiveChunks(bot, ID);
  installEscalationConfig();
  const reactive = new ReactiveController(bot);
  const metrics = createEscalationMetrics(reactive.state);
  let transitionCursor = reactive.transitionHistory?.length ?? 0;
  let sampleInterval = null;
  let logInterval = null;
  let scenarioError = null;
  let finalHostiles = [];
  let cleanup = null;
  let mobSpawning = null;
  const started = Date.now();

  const observe = () => {
    const transitions = Array.isArray(reactive.transitionHistory)
      ? reactive.transitionHistory.slice(transitionCursor)
      : [];
    transitionCursor += transitions.length;
    for (const transition of transitions) {
      if (transition.to === 'ENGAGING') metrics.sawEngaging = true;
    }
    observeFleeFixtureTransitions(metrics, transitions);

    const hostiles = nearbyHostiles(bot, TRACKING_RADIUS);
    const pathfinderIdle = bot.pathfinderOwner?.isIdle?.() ?? null;
    observeFleeFixtureSample(metrics, {
      state: reactive.state,
      pathfinderIdle,
      countStateChanges: false,
      nearestDistance: hostiles[0]?.distance ?? null,
    });
    if (typeof bot.health === 'number') {
      metrics.minHealth = metrics.minHealth == null ? bot.health : Math.min(metrics.minHealth, bot.health);
    }
    metrics.maxHostileCount = Math.max(metrics.maxHostileCount, hostiles.length);
    metrics.lastNearestDistance = hostiles[0]?.distance ?? null;
    metrics.lastState = reactive.state;
    return { hostiles, pathfinderIdle };
  };

  try {
    mobSpawning = await disableAmbientMobSpawning();
    await clearNonPlayersUntilQuiet(bot, reactive, 'initial-clear');
    await waitForDryEscalationBaseline(bot, reactive);

    sampleInterval = setInterval(observe, METRIC_SAMPLE_MS);
    logInterval = setInterval(() => {
      const { hostiles, pathfinderIdle } = observe();
      log.test.info(`${ID}.tracking`, trackingFields(bot, reactive, metrics, hostiles, pathfinderIdle));
    }, TRACKING_LOG_MS);

    for (let index = 0; index < HOSTILE_ESCALATION_WAVES.length; index += 1) {
      const wave = HOSTILE_ESCALATION_WAVES[index];
      if (index > 0) {
        await waitForSeparationBeforeWave(bot, reactive, metrics, HOSTILE_ESCALATION_WAVES[index - 1], wave.label, observe);
      }
      await spawnWave(bot, metrics, wave, index + 1);
      observe();
      await sleep(POST_WAVE_SETTLE_MS);
    }

    await waitForFinalEscape(bot, reactive, metrics, observe);
    finalHostiles = observe().hostiles;
  } catch (err) {
    scenarioError = err;
  } finally {
    if (sampleInterval) clearInterval(sampleInterval);
    if (logInterval) clearInterval(logInterval);
    cleanup = await cleanupHostiles(mobSpawning);
  }

  const cleanupFields = { cleanup };
  if (scenarioError) {
    finish(2, `${ID}.failure`, {
      reason: scenarioError?.message || String(scenarioError),
      ...(scenarioError?.fields || {}),
      ...metrics,
      ...cleanupFields,
    });
    return;
  }
  if (!cleanup?.ok) {
    finish(2, `${ID}.failure`, {
      reason: cleanup?.reason || 'hostile escalation cleanup failed',
      ...metrics,
      ...cleanupFields,
    });
    return;
  }

  const evaluation = evaluateHostileEscalationMetrics(metrics, {
    expectedWaves: HOSTILE_ESCALATION_WAVES.length,
    expectedSpawnCount: EXPECTED_SPAWNED_HOSTILES,
    criticalHealth: config.reactive.criticalHealthLogoutThreshold,
    maxStateChanges: MAX_STATE_CHANGES,
    maxWaterEscapeEntries: MAX_WATER_ESCAPE_ENTRIES,
    minNormalAfterFleeDistance: DEAGGRO_RADIUS,
  });
  if (!evaluation.ok) {
    finish(2, `${ID}.failure`, {
      reason: evaluation.reason,
      deaggroRadius: DEAGGRO_RADIUS,
      trackingRadius: TRACKING_RADIUS,
      finalHostiles,
      ...metrics,
      ...cleanupFields,
    });
    return;
  }

  finish(0, `${ID}.done`, {
    durationMs: Date.now() - started,
    deaggroRadius: DEAGGRO_RADIUS,
    trackingRadius: TRACKING_RADIUS,
    finalState: reactive.state,
    finalHealth: bot.health,
    finalFood: bot.food,
    finalHostiles,
    ...metrics,
    ...cleanupFields,
  });
}, {
  runTimeoutMs: DRY_BASELINE_WAIT_MS + (BETWEEN_WAVE_TIMEOUT_MS * 2) + FINAL_ESCAPE_TIMEOUT_MS + 45000,
});

function installEscalationConfig() {
  config.reactive.engageOverFlee = false;
  config.reactive.maxMeleeEngageThreatCount = 1;
  config.reactive.rangedCombatPrepEnabled = false;
  config.reactive.rangedCombatFireEnabled = false;
  log.test.info(`${ID}.combat-config`, {
    engageOverFlee: config.reactive.engageOverFlee,
    maxMeleeEngageThreatCount: config.reactive.maxMeleeEngageThreatCount,
    rangedCombatPrepEnabled: config.reactive.rangedCombatPrepEnabled,
    rangedCombatFireEnabled: config.reactive.rangedCombatFireEnabled,
  });
}

function createEscalationMetrics(initialState) {
  return {
    ...createFleeFixtureMetrics(initialState),
    wavesSpawned: 0,
    spawnedHostiles: 0,
    maxHostileCount: 0,
    minHealth: null,
    sawEngaging: initialState === 'ENGAGING',
    finalEscapeObserved: false,
    lastNearestDistance: null,
    lastState: initialState,
  };
}

async function waitForDryEscalationBaseline(bot, reactive) {
  const deadline = Date.now() + DRY_BASELINE_WAIT_MS;
  let stableSince = 0;
  let lastLogAt = 0;
  let lastStatus = null;
  while (Date.now() <= deadline) {
    const now = Date.now();
    const status = dryEscalationBaselineStatus(bot, reactive);
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
      const err = new Error(`unsafe hostile escalation staging: ${status.reason}`);
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
  const err = new Error(`unsafe hostile escalation staging: bot did not hold stable dry ground for ${DRY_BASELINE_STABLE_MS}ms within ${DRY_BASELINE_WAIT_MS}ms (${reason})`);
  err.fields = { staging: lastStatus };
  throw err;
}

async function clearNonPlayersUntilQuiet(bot, reactive, label) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= CLEAR_ATTEMPTS; attempt += 1) {
    const adminLabel = attempt === 1 ? label : `${label}-retry-${attempt}`;
    const result = await runAdmin(ID, adminLabel, ['clear-non-players']);
    await sleep(CLEAR_SETTLE_MS);
    lastStatus = dryEscalationBaselineStatus(bot, reactive);
    log.test.info(`${ID}.admin.${label}.quiet-check`, {
      attempt,
      attempts: CLEAR_ATTEMPTS,
      settleMs: CLEAR_SETTLE_MS,
      action: result.action,
      commandCount: result.commandCount ?? result.commands?.length ?? null,
      ...lastStatus,
    });
    if (lastStatus.safe) return;
  }
  const reason = lastStatus?.reason || 'unknown staging status after clear';
  const err = new Error(`failed to clear hostile escalation staging after ${CLEAR_ATTEMPTS} attempts: ${reason}`);
  err.fields = { staging: lastStatus };
  throw err;
}

function dryEscalationBaselineStatus(bot, reactive) {
  const water = scanWaterHazard(bot, { holdInWater: bot.entity?.isInWater === true || reactive.state === 'WATER_ESCAPE' });
  const onGround = bot.entity?.onGround ?? null;
  const health = bot.health ?? null;
  const hostiles = nearbyHostiles(bot, FIXTURE_RADIUS);
  const baseline = evaluateDryHostileFixtureBaseline({
    water,
    onGround,
    health,
    state: reactive.state,
    hostiles,
  });
  return {
    ...baseline,
    state: reactive.state,
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

async function waitForSeparationBeforeWave(bot, reactive, metrics, previousWave, nextLabel, observe) {
  const minDistance = previousWave.minSeparationBeforeNext;
  if (!Number.isFinite(minDistance)) return;
  const deadline = Date.now() + BETWEEN_WAVE_TIMEOUT_MS;
  let lastLogAt = 0;
  while (Date.now() <= deadline) {
    const { hostiles, pathfinderIdle } = observe();
    const nearest = hostiles[0] || null;
    const now = Date.now();
    if (now - lastLogAt >= 1000) {
      log.test.info(`${ID}.wave.wait-separation`, {
        afterWave: previousWave.label,
        nextWave: nextLabel,
        minDistance,
        nearest,
        state: reactive.state,
        health: bot.health,
        food: bot.food,
        pathfinderIdle,
        ...compactMetrics(metrics),
      });
      lastLogAt = now;
    }
    if (bot.health <= config.reactive.criticalHealthLogoutThreshold) {
      throw new Error(`health reached critical threshold before ${nextLabel}: ${bot.health}`);
    }
    if (!nearest || nearest.distance >= minDistance) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${minDistance} block separation before ${nextLabel}; nearest=${metrics.lastNearestDistance}`);
}

async function waitForFinalEscape(bot, reactive, metrics, observe) {
  const deadline = Date.now() + FINAL_ESCAPE_TIMEOUT_MS;
  let lastLogAt = 0;
  while (Date.now() <= deadline) {
    const { hostiles, pathfinderIdle } = observe();
    const nearest = hostiles[0] || null;
    const now = Date.now();
    if (now - lastLogAt >= 1000) {
      log.test.info(`${ID}.final-escape-check`, {
        deaggroRadius: DEAGGRO_RADIUS,
        nearest,
        state: reactive.state,
        health: bot.health,
        food: bot.food,
        pathfinderIdle,
        ...compactMetrics(metrics),
      });
      lastLogAt = now;
    }
    if (bot.health <= config.reactive.criticalHealthLogoutThreshold) {
      throw new Error(`health reached critical threshold after final wave: ${bot.health}`);
    }
    if (reactive.state === 'NORMAL' && (!nearest || nearest.distance >= DEAGGRO_RADIUS)) {
      metrics.finalEscapeObserved = true;
      metrics.sawNormalAfterFlee = true;
      metrics.normalAfterFleeNearestDistance = nearest?.distance ?? null;
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for final wave escape; state=${reactive.state}, nearest=${metrics.lastNearestDistance}`);
}

async function spawnWave(bot, metrics, wave, ordinal) {
  const args = hostileEscalationSpawnArgs(bot.entity?.position, wave);
  const pluginBacked = process.env.MCBOT_PLUGIN_BACKED === '1';
  const plan = buildLiveAdminPlan(pluginBacked
    ? ['mcbottest-spawn-zombie-wave-fire-resistant', pluginTagPrefix(wave, ordinal), ...args]
    : ['summon-zombie-wave-fire-resistant', ...args]);
  if (!plan.ok) throw new Error(`hostile escalation wave plan invalid: ${plan.reason}`);

  log.test.info(`${ID}.admin.wave.start`, {
    ordinal,
    label: wave.label,
    count: wave.count,
    pluginBacked,
    spawn: spawnPositionForLog(args.slice(1)),
    botPosition: positionForLog(bot.entity?.position),
  });
  const result = await runLiveAdminPlan(plan);
  metrics.wavesSpawned += 1;
  metrics.spawnedHostiles += wave.count;
  log.test.info(`${ID}.admin.wave`, adminResultFields(result, { ordinal, label: wave.label, count: wave.count }));
}

async function runAdmin(id, label, argv) {
  const plan = buildLiveAdminPlan(argv);
  if (!plan.ok) throw new Error(`${label} admin plan invalid: ${plan.reason}`);
  log.test.info(`${id}.admin.${label}.start`, { action: plan.action });
  const result = await runLiveAdminPlan(plan);
  log.test.info(`${id}.admin.${label}`, adminResultFields(result));
  return result;
}

async function cleanupHostiles(mobSpawning) {
  let cleanupResult = null;
  let cleanupError = null;
  let restore = null;
  let restoreError = null;

  try {
    cleanupResult = await runAdmin(ID, 'cleanup', ['clear-non-players']);
  } catch (err) {
    cleanupError = err;
  }

  try {
    restore = await restoreAmbientMobSpawning(mobSpawning);
  } catch (err) {
    restoreError = err;
  }

  if (cleanupError || restoreError) {
    const reason = [cleanupError, restoreError].filter(Boolean).map((err) => err?.message || String(err)).join('; ');
    log.test.error(`${ID}.admin.cleanup.failed`, {
      reason,
      cleanupOk: !cleanupError,
      restoreOk: !restoreError,
      mobSpawning: restore,
    });
    return { ok: false, reason, mobSpawning: restore };
  }

  return {
    ok: true,
    action: cleanupResult.action,
    commandCount: cleanupResult.commandCount ?? cleanupResult.commands?.length ?? null,
    mobSpawning: restore,
  };
}

async function disableAmbientMobSpawning() {
  const query = await runAdmin(ID, 'mob-spawning-query', ['query-do-mob-spawning']);
  const parsed = parseDoMobSpawning(query);
  const previous = parsed ?? true;
  const set = await runAdmin(ID, 'mob-spawning-disable', ['set-do-mob-spawning', 'false']);
  const verify = await runAdmin(ID, 'mob-spawning-verify-disabled', ['query-do-mob-spawning']);
  const verified = parseDoMobSpawning(verify);
  if (verified !== false) {
    throw new Error(`failed to disable ambient mob spawning; query response: ${adminResponseText(verify) || 'unparseable'}`);
  }
  return {
    previous,
    assumedPrevious: parsed == null,
    disabled: true,
    query: adminCompact(query),
    set: adminCompact(set),
    verify: adminCompact(verify),
  };
}

async function restoreAmbientMobSpawning(state) {
  if (!state) return { ok: true, skipped: true, reason: 'mob spawning was not changed' };
  const restore = await runAdmin(ID, 'mob-spawning-restore', ['set-do-mob-spawning', String(state.previous)]);
  const verify = await runAdmin(ID, 'mob-spawning-verify-restore', ['query-do-mob-spawning']);
  const verified = parseDoMobSpawning(verify);
  if (verified !== state.previous) {
    throw new Error(`failed to restore ambient mob spawning to ${state.previous}; query response: ${adminResponseText(verify) || 'unparseable'}`);
  }
  return {
    ok: true,
    restoredTo: state.previous,
    assumedPrevious: state.assumedPrevious === true,
    result: adminCompact(restore),
    verify: adminCompact(verify),
  };
}

function parseDoMobSpawning(result) {
  const text = adminResponseText(result);
  const match = text.match(/\b(true|false)\b/i);
  return match ? match[1].toLowerCase() === 'true' : null;
}

function adminResponseText(result) {
  return (result?.responses || [])
    .map((entry) => entry.response)
    .filter(Boolean)
    .join(' ');
}

function adminCompact(result) {
  return {
    ok: result?.ok === true,
    action: result?.action,
    commandCount: result?.commandCount ?? result?.commands?.length ?? null,
  };
}

function trackingFields(bot, reactive, metrics, hostiles, pathfinderIdle) {
  return {
    state: reactive.state,
    nearest: hostiles[0] || null,
    hostileCount: hostiles.length,
    hostiles,
    trackingRadius: TRACKING_RADIUS,
    deaggroRadius: DEAGGRO_RADIUS,
    pathfinderIdle,
    sprinting: bot.controlState?.sprint ?? null,
    health: bot.health,
    food: bot.food,
    ...compactMetrics(metrics),
  };
}

function compactMetrics(metrics) {
  return {
    wavesSpawned: metrics.wavesSpawned,
    spawnedHostiles: metrics.spawnedHostiles,
    maxHostileCount: metrics.maxHostileCount,
    minHealth: metrics.minHealth,
    sawFleeing: metrics.sawFleeing,
    sawEngaging: metrics.sawEngaging,
    sawNormalAfterFlee: metrics.sawNormalAfterFlee,
    finalEscapeObserved: metrics.finalEscapeObserved,
    stateChanges: metrics.stateChanges,
    waterEscapeEntries: metrics.waterEscapeEntries,
    fleeSamples: metrics.fleeSamples,
    pathfinderActiveFleeSamples: metrics.pathfinderActiveFleeSamples,
    lastNearestDistance: metrics.lastNearestDistance,
  };
}

function adminResultFields(result, extra = {}) {
  return {
    ...extra,
    action: result.action,
    dryRun: result.dryRun === true,
    commandCount: result.commandCount ?? result.commands?.length ?? null,
    commands: result.commands,
    responses: result.responses?.map((entry) => ({
      command: entry.command,
      response: entry.response,
      type: entry.type,
    })) ?? null,
  };
}

function spawnPositionForLog(args) {
  const [x, y, z] = args.map((value) => Number(value));
  return { x, y, z };
}

function pluginTagPrefix(wave, ordinal) {
  return `j_${ordinal}_${String(wave.label || 'wave').replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
}

function boundedEnvNumber(name, fallback, max) {
  return Math.max(0, Math.min(max, envNumber(name, fallback)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
