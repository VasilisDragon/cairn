import config from '../src/config.js';
import log from '../src/logger.js';
import { ReactiveController, scanWaterHazard } from '../src/reactive/reactive.js';
import buildSnapshot from '../src/state/snapshot.js';
import { buildLiveAdminPlan, runLiveAdminPlan } from '../scripts/live-admin-commands.js';
import { evaluateDryHostileFixtureBaseline } from './live_hostile_fixture_status.js';
import {
  createFleeFixtureMetrics,
  observeFleeFixtureSample,
  observeFleeFixtureTransitions,
} from './live_flee_metrics.js';
import {
  PVM_ESCALATION_WAVES,
  evaluatePvmEscalationMetrics,
  pvmEscalationExpectedSpawnCount,
  pvmEscalationSpawnArgs,
} from './live_pvm_escalation_plan.js';
import {
  chooseAvailableItem,
  closeLoggedChest,
  envNumber,
  equipLogged,
  equipmentSummary,
  inventoryCounts,
  nearbyHostiles,
  openAuthorizedSupplyChest,
  runLiveScenario,
  SUPPLY_CHEST_POS,
  waitForLiveChunks,
  withdrawLogged,
} from './live_helpers.js';

const ID = 'live_pvm_escalation_decision_fixture';
const FIXTURE_ENV = 'MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK';
const DEAGGRO_RADIUS = config.reactive.hostileExitRadius ?? 42;
const FIXTURE_RADIUS = 24;
const TRACKING_RADIUS = Math.max(64, Math.ceil(DEAGGRO_RADIUS) + 16);
const DRY_BASELINE_WAIT_MS = 15000;
const DRY_BASELINE_STABLE_MS = 1000;
const METRIC_SAMPLE_MS = 100;
const TRACKING_LOG_MS = 1000;
const ENGAGE_TIMEOUT_MS = boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_ENGAGE_TIMEOUT_MS', 30000, 90000);
const FLEE_TIMEOUT_MS = boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_FLEE_TIMEOUT_MS', 20000, 60000);
const FINAL_ESCAPE_TIMEOUT_MS = boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_FINAL_ESCAPE_TIMEOUT_MS', 60000, 120000);
const POST_ENGAGE_SETTLE_MS = boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_POST_ENGAGE_SETTLE_MS', 250, 5000);
const CLEAR_SETTLE_MS = boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_CLEAR_SETTLE_MS', 750, 5000);
const CLEAR_ATTEMPTS = boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_CLEAR_ATTEMPTS', 8, 20);
const GEAR_STAGING_POS = Object.freeze({
  x: envNumber('MCBOT_LIVE_PVM_ESCALATION_GEAR_STAGING_X', SUPPLY_CHEST_POS.x - 0.5),
  y: envNumber('MCBOT_LIVE_PVM_ESCALATION_GEAR_STAGING_Y', SUPPLY_CHEST_POS.y),
  z: envNumber('MCBOT_LIVE_PVM_ESCALATION_GEAR_STAGING_Z', SUPPLY_CHEST_POS.z + 0.5),
});
const MAX_STATE_CHANGES = Math.max(4, boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_MAX_STATE_CHANGES', 24, 100));
const MAX_WATER_ESCAPE_ENTRIES = boundedEnvNumber('MCBOT_LIVE_PVM_ESCALATION_MAX_WATER_ESCAPE_ENTRIES', 3, 20);
const EXPECTED_SPAWNED_HOSTILES = pvmEscalationExpectedSpawnCount();
const MIN_ENGAGE_ARMOR_SCORE = 16;

const ARMOR = Object.freeze([
  Object.freeze({ item: 'netherite_helmet', destination: 'head', equipmentSlot: 'head' }),
  Object.freeze({ item: 'netherite_chestplate', destination: 'torso', equipmentSlot: 'torso' }),
  Object.freeze({ item: 'netherite_leggings', destination: 'legs', equipmentSlot: 'legs' }),
  Object.freeze({ item: 'netherite_boots', destination: 'feet', equipmentSlot: 'feet' }),
]);

const WEAPON_CANDIDATES = Object.freeze([
  'netherite_sword',
  'diamond_sword',
  'netherite_axe',
  'diamond_axe',
  'iron_sword',
]);

runLiveScenario(ID, async ({ bot, controller, finish }) => {
  if (process.env[FIXTURE_ENV] !== '1') {
    throw new Error(`refusing ${ID} without ${FIXTURE_ENV}=1; this scenario intentionally escalates a private/local PvM fight`);
  }
  if (process.env.MCBOT_LIVE_ADMIN_OK !== '1') {
    throw new Error(`refusing ${ID} without MCBOT_LIVE_ADMIN_OK=1; PvM escalation requires explicit private-server RCON permission`);
  }

  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.gear-prep`,
  };

  let cleanup = null;
  let mobSpawning = null;

  try {
    await waitForLiveChunks(bot, ID);
    mobSpawning = await disableAmbientMobSpawning();
    await runAdmin('initial-clear', ['clear-non-players']);
    await sleep(500);
    await assertSafeBeforeGear(bot);
    await prepareEngageGear(bot, ctx);
    installEscalationConfig();
  } catch (err) {
    cleanup = await cleanupHostiles(mobSpawning);
    finish(2, `${ID}.failure`, {
      reason: err?.message || String(err),
      ...(err?.fields || {}),
      cleanup,
    });
    return;
  }

  const reactive = new ReactiveController(bot);

  const metrics = createPvmEscalationMetrics(reactive.state);
  let transitionCursor = reactive.transitionHistory?.length ?? 0;
  let sampleInterval = null;
  let logInterval = null;
  let scenarioError = null;
  let finalHostiles = [];
  const started = Date.now();

  const observe = () => {
    const transitions = Array.isArray(reactive.transitionHistory)
      ? reactive.transitionHistory.slice(transitionCursor)
      : [];
    transitionCursor += transitions.length;
    for (const transition of transitions) {
      if (transition.to === 'ENGAGING' && !metrics.escalationStarted) metrics.sawEngagingBeforeEscalation = true;
      if (transition.to === 'FLEEING' && metrics.escalationStarted) metrics.sawFleeingAfterEscalation = true;
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

    const combatPolicy = combatSnapshot(bot).combatPolicy;
    if (metrics.escalationStarted && combatPolicy?.reason === 'too-many-hostiles') {
      metrics.sawTooManyHostilesPolicy = true;
    }
    if (typeof bot.health === 'number') {
      metrics.minHealth = metrics.minHealth == null ? bot.health : Math.min(metrics.minHealth, bot.health);
    }
    metrics.maxHostileCount = Math.max(metrics.maxHostileCount, hostiles.length);
    metrics.lastNearestDistance = hostiles[0]?.distance ?? null;
    metrics.lastState = reactive.state;
    metrics.lastCombatPolicy = combatPolicy;
    return { hostiles, pathfinderIdle, combatPolicy };
  };

  try {
    await clearNonPlayersUntilQuiet(bot, reactive, 'pre-wave-clear');
    await waitForDryEscalationBaseline(bot, reactive);
    sampleInterval = setInterval(observe, METRIC_SAMPLE_MS);
    logInterval = setInterval(() => {
      const { hostiles, pathfinderIdle, combatPolicy } = observe();
      log.test.info(`${ID}.tracking`, trackingFields(bot, reactive, metrics, hostiles, pathfinderIdle, combatPolicy));
    }, TRACKING_LOG_MS);

    await spawnWave(bot, metrics, PVM_ESCALATION_WAVES[0], 1);
    await waitForInitialEngage(bot, reactive, metrics, observe);
    if (POST_ENGAGE_SETTLE_MS > 0) await sleep(POST_ENGAGE_SETTLE_MS);
    metrics.escalationStarted = true;
    await spawnWave(bot, metrics, PVM_ESCALATION_WAVES[1], 2);
    await waitForEscalationFlee(bot, reactive, metrics, observe);
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
      ...compactMetrics(metrics),
      ...cleanupFields,
    });
    return;
  }
  if (!cleanup?.ok) {
    finish(2, `${ID}.failure`, {
      reason: cleanup?.reason || 'PvM escalation cleanup failed',
      ...compactMetrics(metrics),
      ...cleanupFields,
    });
    return;
  }

  const evaluation = evaluatePvmEscalationMetrics(metrics, {
    expectedWaves: PVM_ESCALATION_WAVES.length,
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
      ...compactMetrics(metrics),
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
    finalEquipment: equipmentSummary(bot),
    finalInventory: inventoryCounts(bot),
    finalHostiles,
    ...compactMetrics(metrics),
    ...cleanupFields,
  });
}, {
  runTimeoutMs: DRY_BASELINE_WAIT_MS + ENGAGE_TIMEOUT_MS + FLEE_TIMEOUT_MS + FINAL_ESCAPE_TIMEOUT_MS + 45000,
});

async function assertSafeBeforeGear(bot) {
  for (let attempt = 1; attempt <= CLEAR_ATTEMPTS; attempt += 1) {
    const status = dryEscalationStatus(bot, 'NOT_STARTED', { allowedStates: ['NORMAL', 'NOT_STARTED'] });
    log.test.info(`${ID}.gear-staging-check`, {
      waitMs: 0,
      stableMs: 0,
      attempt,
      attempts: CLEAR_ATTEMPTS,
      ...status,
    });
    if (status.safe) return;
    if (status.hostiles?.length > 0) {
      await runAdmin(attempt === 1 ? 'gear-staging-clear' : `gear-staging-clear-retry-${attempt}`, ['clear-non-players']);
      await sleep(CLEAR_SETTLE_MS);
      continue;
    }
    if (status.stop) {
      const err = new Error(`unsafe PvM escalation gear prep staging: ${status.reason}`);
      err.fields = { staging: status };
      throw err;
    }
    await runAdmin('gear-staging-relocate', [
      'teleport-player',
      bot.username || 'MCBot',
      String(GEAR_STAGING_POS.x),
      String(GEAR_STAGING_POS.y),
      String(GEAR_STAGING_POS.z),
    ]);
    await sleep(1000);
    const relocated = dryEscalationStatus(bot, 'NOT_STARTED', { allowedStates: ['NORMAL', 'NOT_STARTED'] });
    log.test.info(`${ID}.gear-staging-check`, {
      waitMs: 0,
      stableMs: 0,
      relocated: true,
      relocationTarget: GEAR_STAGING_POS,
      ...relocated,
    });
    if (relocated.safe) return;
    const err = new Error(`unsafe PvM escalation gear prep staging after relocation: ${relocated.reason}`);
    err.fields = { staging: relocated };
    throw err;
  }
  const status = dryEscalationStatus(bot, 'NOT_STARTED', { allowedStates: ['NORMAL', 'NOT_STARTED'] });
  const err = new Error(`unsafe PvM escalation gear prep staging after ${CLEAR_ATTEMPTS} clear attempts: ${status.reason}`);
  err.fields = { staging: status };
  throw err;
}

async function prepareEngageGear(bot, ctx) {
  log.test.info(`${ID}.gear.before`, {
    inventory: inventoryCounts(bot),
    equipment: equipmentSummary(bot),
    armor: ARMOR.map((entry) => entry.item),
    weaponCandidates: WEAPON_CANDIDATES,
  });

  let weapon = chooseInventoryCandidate(bot, WEAPON_CANDIDATES);
  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    await withdrawSteakIfAvailable(bot, container);
    for (const armor of ARMOR) await withdrawIfNeeded(bot, container, armor.item, { required: true });
    if (!weapon) {
      const available = chooseAvailableItem(container, WEAPON_CANDIDATES, { minCount: 1 });
      if (!available) {
        throw new Error(`no PvM weapon candidate found in authorized chest or inventory; looked for ${WEAPON_CANDIDATES.join(', ')}`);
      }
      weapon = available.name;
      log.test.info(`${ID}.gear.weapon.selected`, { source: 'authorized-chest', item: weapon, available: available.available });
      await withdrawLogged(bot, container, weapon, 1, ID);
    } else {
      log.test.info(`${ID}.gear.weapon.selected`, { source: 'inventory', item: weapon });
    }
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
  await equipLogged(bot, weapon, 'hand', ID);
  log.test.info(`${ID}.gear.after`, {
    inventory: inventoryCounts(bot),
    equipment: equipmentSummary(bot),
    combatPolicy: combatSnapshot(bot).combatPolicy,
  });
}

async function waitForDryEscalationBaseline(bot, reactive) {
  const deadline = Date.now() + DRY_BASELINE_WAIT_MS;
  let stableSince = 0;
  let lastLogAt = 0;
  let lastStatus = null;
  while (Date.now() <= deadline) {
    const now = Date.now();
    const status = dryEscalationStatus(bot, reactive.state);
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
      const err = new Error(`unsafe PvM escalation staging: ${status.reason}`);
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
  const err = new Error(`unsafe PvM escalation staging: bot did not hold stable dry ground for ${DRY_BASELINE_STABLE_MS}ms within ${DRY_BASELINE_WAIT_MS}ms (${reason})`);
  err.fields = { staging: lastStatus };
  throw err;
}

async function clearNonPlayersUntilQuiet(bot, reactive, label) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= CLEAR_ATTEMPTS; attempt += 1) {
    const adminLabel = attempt === 1 ? label : `${label}-retry-${attempt}`;
    const result = await runAdmin(adminLabel, ['clear-non-players']);
    await sleep(CLEAR_SETTLE_MS);
    lastStatus = dryEscalationStatus(bot, reactive.state);
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
  const err = new Error(`failed to clear PvM escalation staging after ${CLEAR_ATTEMPTS} attempts: ${reason}`);
  err.fields = { staging: lastStatus };
  throw err;
}

function dryEscalationStatus(bot, state, opts = {}) {
  const water = scanWaterHazard(bot, { holdInWater: bot.entity?.isInWater === true || state === 'WATER_ESCAPE' });
  const onGround = bot.entity?.onGround ?? null;
  const health = bot.health ?? null;
  const hostiles = nearbyHostiles(bot, FIXTURE_RADIUS);
  const baseline = evaluateDryHostileFixtureBaseline({
    water,
    onGround,
    health,
    state,
    hostiles,
    allowedStates: opts.allowedStates,
  });
  return {
    ...baseline,
    state,
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

function installEscalationConfig() {
  config.reactive.engageOverFlee = true;
  config.reactive.minArmorScoreToEngage = MIN_ENGAGE_ARMOR_SCORE;
  config.reactive.maxMeleeEngageThreatCount = 1;
  config.reactive.requireShieldToEngage = false;
  config.reactive.shieldBlockingEnabled = false;
  config.reactive.rangedCombatPrepEnabled = false;
  config.reactive.rangedCombatFireEnabled = false;
  log.test.info(`${ID}.combat-config`, {
    engageOverFlee: config.reactive.engageOverFlee,
    minArmorScoreToEngage: config.reactive.minArmorScoreToEngage,
    maxMeleeEngageThreatCount: config.reactive.maxMeleeEngageThreatCount,
    requireShieldToEngage: config.reactive.requireShieldToEngage,
    shieldBlockingEnabled: config.reactive.shieldBlockingEnabled,
    rangedCombatPrepEnabled: config.reactive.rangedCombatPrepEnabled,
    rangedCombatFireEnabled: config.reactive.rangedCombatFireEnabled,
  });
}

async function waitForInitialEngage(bot, reactive, metrics, observe) {
  const deadline = Date.now() + ENGAGE_TIMEOUT_MS;
  let lastLogAt = 0;
  while (Date.now() <= deadline) {
    const { hostiles, pathfinderIdle, combatPolicy } = observe();
    const now = Date.now();
    if (now - lastLogAt >= 1000) {
      log.test.info(`${ID}.initial-engage-check`, {
        nearest: hostiles[0] || null,
        state: reactive.state,
        health: bot.health,
        food: bot.food,
        pathfinderIdle,
        combatPolicy,
        ...compactMetrics(metrics),
      });
      lastLogAt = now;
    }
    if (bot.health <= config.reactive.criticalHealthLogoutThreshold) {
      throw new Error(`health reached critical threshold before escalation: ${bot.health}`);
    }
    if (metrics.sawEngagingBeforeEscalation) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for initial ENGAGING before escalation; state=${reactive.state}, nearest=${metrics.lastNearestDistance}`);
}

async function waitForEscalationFlee(bot, reactive, metrics, observe) {
  const deadline = Date.now() + FLEE_TIMEOUT_MS;
  let lastLogAt = 0;
  while (Date.now() <= deadline) {
    const { hostiles, pathfinderIdle, combatPolicy } = observe();
    const now = Date.now();
    if (now - lastLogAt >= 1000) {
      log.test.info(`${ID}.escalation-flee-check`, {
        nearest: hostiles[0] || null,
        hostileCount: hostiles.length,
        state: reactive.state,
        health: bot.health,
        food: bot.food,
        pathfinderIdle,
        combatPolicy,
        ...compactMetrics(metrics),
      });
      lastLogAt = now;
    }
    if (bot.health <= config.reactive.criticalHealthLogoutThreshold) {
      throw new Error(`health reached critical threshold after escalation: ${bot.health}`);
    }
    if (metrics.sawFleeingAfterEscalation && metrics.sawTooManyHostilesPolicy) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for FLEEING/too-many-hostiles after escalation; state=${reactive.state}, nearest=${metrics.lastNearestDistance}`);
}

async function waitForFinalEscape(bot, reactive, metrics, observe) {
  const deadline = Date.now() + FINAL_ESCAPE_TIMEOUT_MS;
  let lastLogAt = 0;
  while (Date.now() <= deadline) {
    const { hostiles, pathfinderIdle, combatPolicy } = observe();
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
        combatPolicy,
        ...compactMetrics(metrics),
      });
      lastLogAt = now;
    }
    if (bot.health <= config.reactive.criticalHealthLogoutThreshold) {
      throw new Error(`health reached critical threshold during final escape: ${bot.health}`);
    }
    if (reactive.state === 'NORMAL' && (!nearest || nearest.distance >= DEAGGRO_RADIUS)) {
      metrics.finalEscapeObserved = true;
      metrics.sawNormalAfterFlee = true;
      metrics.normalAfterFleeNearestDistance = nearest?.distance ?? null;
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for PvM escalation final escape; state=${reactive.state}, nearest=${metrics.lastNearestDistance}`);
}

async function spawnWave(bot, metrics, wave, ordinal) {
  const args = pvmEscalationSpawnArgs(bot.entity?.position, wave);
  const pluginBacked = process.env.MCBOT_PLUGIN_BACKED === '1';
  const plan = buildLiveAdminPlan(pluginBacked
    ? ['mcbottest-spawn-zombie-wave-fire-resistant', pluginTagPrefix(wave, ordinal), ...args]
    : ['summon-zombie-wave-fire-resistant', ...args]);
  if (!plan.ok) throw new Error(`PvM escalation wave plan invalid: ${plan.reason}`);

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

async function runAdmin(label, argv) {
  const plan = buildLiveAdminPlan(argv);
  if (!plan.ok) throw new Error(`${label} admin plan invalid: ${plan.reason}`);
  log.test.info(`${ID}.admin.${label}.start`, { action: plan.action });
  const result = await runLiveAdminPlan(plan);
  log.test.info(`${ID}.admin.${label}`, adminResultFields(result));
  return result;
}

async function cleanupHostiles(mobSpawning) {
  let cleanupResult = null;
  let cleanupError = null;
  let restore = null;
  let restoreError = null;

  try {
    cleanupResult = await runAdmin('cleanup', ['clear-non-players']);
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
  const query = await runAdmin('mob-spawning-query', ['query-do-mob-spawning']);
  const parsed = parseDoMobSpawning(query);
  const previous = parsed ?? true;
  const set = await runAdmin('mob-spawning-disable', ['set-do-mob-spawning', 'false']);
  const verify = await runAdmin('mob-spawning-verify-disabled', ['query-do-mob-spawning']);
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
  const restore = await runAdmin('mob-spawning-restore', ['set-do-mob-spawning', String(state.previous)]);
  const verify = await runAdmin('mob-spawning-verify-restore', ['query-do-mob-spawning']);
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

async function withdrawSteakIfAvailable(bot, container) {
  if ((inventoryCounts(bot).cooked_beef || 0) > 0) {
    log.test.info(`${ID}.gear.food.available`, { source: 'inventory', item: 'cooked_beef', count: inventoryCounts(bot).cooked_beef });
    return;
  }
  const steak = chooseAvailableItem(container, ['cooked_beef'], { minCount: 1 });
  if (!steak) {
    log.test.warn(`${ID}.gear.food.missing`, { item: 'cooked_beef', required: false });
    return;
  }
  const count = Math.min(8, steak.available);
  log.test.info(`${ID}.gear.food.selected`, { source: 'authorized-chest', item: steak.name, count, available: steak.available });
  await withdrawLogged(bot, container, steak.name, count, ID);
}

async function withdrawIfNeeded(bot, container, item, opts = {}) {
  if ((inventoryCounts(bot)[item] || 0) > 0 || isEquipped(bot, item)) {
    log.test.info(`${ID}.gear.available`, { item, source: isEquipped(bot, item) ? 'equipment' : 'inventory' });
    return;
  }
  const available = chooseAvailableItem(container, [item], { minCount: 1 });
  if (!available) {
    log.test[opts.required ? 'error' : 'warn'](`${ID}.gear.missing`, { item, required: !!opts.required });
    if (opts.required) throw new Error(`required PvM item ${item} not found in authorized chest, inventory, or equipment`);
    return;
  }
  log.test.info(`${ID}.gear.selected`, { source: 'authorized-chest', item, available: available.available });
  await withdrawLogged(bot, container, item, 1, ID);
}

function createPvmEscalationMetrics(initialState) {
  return {
    ...createFleeFixtureMetrics(initialState),
    wavesSpawned: 0,
    spawnedHostiles: 0,
    maxHostileCount: 0,
    minHealth: null,
    escalationStarted: false,
    sawEngagingBeforeEscalation: initialState === 'ENGAGING',
    sawFleeingAfterEscalation: false,
    sawTooManyHostilesPolicy: false,
    finalEscapeObserved: false,
    lastNearestDistance: null,
    lastState: initialState,
    lastCombatPolicy: null,
  };
}

function compactMetrics(metrics) {
  return {
    wavesSpawned: metrics.wavesSpawned,
    spawnedHostiles: metrics.spawnedHostiles,
    maxHostileCount: metrics.maxHostileCount,
    minHealth: metrics.minHealth,
    escalationStarted: metrics.escalationStarted,
    sawEngagingBeforeEscalation: metrics.sawEngagingBeforeEscalation,
    sawFleeingAfterEscalation: metrics.sawFleeingAfterEscalation,
    sawTooManyHostilesPolicy: metrics.sawTooManyHostilesPolicy,
    sawFleeing: metrics.sawFleeing,
    sawNormalAfterFlee: metrics.sawNormalAfterFlee,
    finalEscapeObserved: metrics.finalEscapeObserved,
    stateChanges: metrics.stateChanges,
    waterEscapeEntries: metrics.waterEscapeEntries,
    fleeSamples: metrics.fleeSamples,
    pathfinderActiveFleeSamples: metrics.pathfinderActiveFleeSamples,
    lastNearestDistance: metrics.lastNearestDistance,
    lastCombatPolicy: metrics.lastCombatPolicy,
  };
}

function trackingFields(bot, reactive, metrics, hostiles, pathfinderIdle, combatPolicy) {
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
    equipment: equipmentSummary(bot),
    combatPolicy,
    ...compactMetrics(metrics),
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

function combatSnapshot(bot) {
  return buildSnapshot(bot, {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: MIN_ENGAGE_ARMOR_SCORE,
      maxMeleeEngageThreatCount: 1,
      requireShieldToEngage: false,
      shieldBlockingEnabled: false,
    },
  });
}

function chooseInventoryCandidate(bot, candidates) {
  const counts = inventoryCounts(bot);
  for (const name of candidates) {
    if ((counts[name] || 0) > 0) return name;
  }
  return null;
}

function isEquipped(bot, item) {
  return Object.values(equipmentSummary(bot)).some((equipped) => equipped?.name === item);
}

function boundedEnvNumber(name, fallback, max) {
  return Math.max(0, Math.min(max, envNumber(name, fallback)));
}

function spawnPositionForLog(args) {
  const [x, y, z] = args.map((value) => Number(value));
  return { x, y, z };
}

function pluginTagPrefix(wave, ordinal) {
  return `k_${ordinal}_${String(wave.label || 'wave').replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
}

function positionForLog(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
