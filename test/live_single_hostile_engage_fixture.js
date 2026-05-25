import config from '../src/config.js';
import log from '../src/logger.js';
import { ReactiveController, scanWaterHazard } from '../src/reactive/reactive.js';
import buildSnapshot from '../src/state/snapshot.js';
import { buildLiveAdminPlan, runLiveAdminPlan } from '../scripts/live-admin-commands.js';
import { evaluateDryHostileFixtureBaseline } from './live_hostile_fixture_status.js';
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
  waitForLiveChunks,
  withdrawLogged,
} from './live_helpers.js';

const ID = 'live_single_hostile_engage_fixture';
const FIXTURE_ENV = 'MCBOT_LIVE_PVM_ENGAGE_FIXTURE_OK';
const FIXTURE_RADIUS = 24;
const TRACKING_RADIUS = 32;
const WAIT_MS = boundedEnvNumber('MCBOT_LIVE_PVM_ENGAGE_WAIT_MS', 0, 120000);
const WAIT_POLL_MS = Math.max(100, boundedEnvNumber('MCBOT_LIVE_PVM_ENGAGE_WAIT_POLL_MS', 1000, 10000));
const MONITOR_MS = boundedEnvNumber('MCBOT_LIVE_PVM_ENGAGE_MONITOR_MS', 45000, 120000);
const DRY_BASELINE_WAIT_MS = 15000;
const DRY_BASELINE_STABLE_MS = 1000;
const STABLE_CLEAR_MS = 2000;
const MIN_ENGAGE_ARMOR_SCORE = 16;
const ALLOWED_FIXTURE_HOSTILES = new Set(['zombie', 'spider']);
const POST_GEAR_ADMIN_ACTIONS = new Set(['summon-zombie', 'summon-zombie-fire-resistant', 'summon-spider']);
const POST_GEAR_SPAWN_MODES = new Set(['near-bot', 'fixed']);

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
    throw new Error(`refusing ${ID} without ${FIXTURE_ENV}=1; this scenario intentionally enables private/local PvM engagement`);
  }

  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.gear-prep`,
  };

  await waitForLiveChunks(bot, ID);
  assertSafeBeforeGear(bot);
  await prepareEngageGear(bot, ctx);
  installEngageConfig();
  const reactive = new ReactiveController(bot);
  await waitForDryEngageBaseline(bot, reactive);
  if (process.env.MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN === '1') {
    await runPostGearAdminSetup(bot);
  }
  const fixture = await waitForSingleAllowedHostile(bot);
  log.test.info(`${ID}.fixture-ready`, {
    radius: FIXTURE_RADIUS,
    trackingRadius: TRACKING_RADIUS,
    monitorMs: MONITOR_MS,
    waitedMs: fixture.waitedMs,
    hostile: fixture.fixtureHostiles[0],
    botPosition: positionForLog(bot.entity?.position),
  });

  const started = Date.now();
  const metrics = {
    sawEngaging: false,
    sawNormalAfterEngage: false,
    hostileClearSince: 0,
    minHealth: bot.health ?? null,
    stateChanges: 0,
  };
  let transitionCursor = reactive.transitionHistory?.length ?? 0;

  const observe = () => {
    const transitions = Array.isArray(reactive.transitionHistory)
      ? reactive.transitionHistory.slice(transitionCursor)
      : [];
    transitionCursor += transitions.length;
    for (const transition of transitions) {
      metrics.stateChanges += 1;
      if (transition.to === 'ENGAGING') metrics.sawEngaging = true;
      if (metrics.sawEngaging && transition.to === 'NORMAL') metrics.sawNormalAfterEngage = true;
    }
    if (typeof bot.health === 'number') {
      metrics.minHealth = metrics.minHealth == null ? bot.health : Math.min(metrics.minHealth, bot.health);
    }
    const hostiles = nearbyHostiles(bot, TRACKING_RADIUS);
    if (hostiles.length === 0 && metrics.sawEngaging) {
      if (metrics.hostileClearSince === 0) metrics.hostileClearSince = Date.now();
    } else {
      metrics.hostileClearSince = 0;
    }
    return hostiles;
  };

  const interval = setInterval(() => {
    const hostiles = observe();
    log.test.info(`${ID}.tracking`, {
      state: reactive.state,
      nearest: hostiles[0] || null,
      hostiles,
      health: bot.health,
      food: bot.food,
      equipment: equipmentSummary(bot),
      combatPolicy: combatSnapshot(bot).combatPolicy,
      ...metrics,
    });
  }, 1000);

  setTimeout(() => {
    clearInterval(interval);
    const hostiles = observe();
    const stableClearMs = metrics.hostileClearSince > 0 ? Date.now() - metrics.hostileClearSince : 0;
    if (bot.health <= config.reactive.criticalHealthLogoutThreshold) {
      finish(2, `${ID}.failure`, { reason: `health reached critical threshold: ${bot.health}`, ...metrics });
      return;
    }
    if (!metrics.sawEngaging) {
      finish(2, `${ID}.failure`, { reason: 'expected ENGAGING during monitor window', hostiles, ...metrics });
      return;
    }
    if (!metrics.sawNormalAfterEngage) {
      finish(2, `${ID}.failure`, { reason: 'expected NORMAL after ENGAGING during monitor window', hostiles, ...metrics });
      return;
    }
    if (stableClearMs < STABLE_CLEAR_MS) {
      finish(2, `${ID}.failure`, {
        reason: `expected hostile clear for ${STABLE_CLEAR_MS}ms; observed ${stableClearMs}ms`,
        hostiles,
        stableClearMs,
        ...metrics,
      });
      return;
    }
    finish(0, `${ID}.done`, {
      durationMs: Date.now() - started,
      stableClearMs,
      finalState: reactive.state,
      finalHealth: bot.health,
      finalFood: bot.food,
      finalEquipment: equipmentSummary(bot),
      finalInventory: inventoryCounts(bot),
      ...metrics,
    });
  }, MONITOR_MS);
});

function assertSafeBeforeGear(bot) {
  const status = engageBaselineStatus(bot, 'NOT_STARTED', { allowedStates: ['NORMAL', 'NOT_STARTED'] });
  log.test.info(`${ID}.gear-staging-check`, {
    waitMs: 0,
    stableMs: 0,
    ...status,
  });
  if (status.stop || !status.safe) {
    const err = new Error(`unsafe PvM gear prep staging: ${status.reason}`);
    err.fields = { staging: status };
    throw err;
  }
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
  const after = {
    inventory: inventoryCounts(bot),
    equipment: equipmentSummary(bot),
    combatPolicy: combatSnapshot(bot).combatPolicy,
  };
  log.test.info(`${ID}.gear.after`, after);
}

async function waitForDryEngageBaseline(bot, reactive) {
  const deadline = Date.now() + DRY_BASELINE_WAIT_MS;
  let stableSince = 0;
  let lastLogAt = 0;
  let lastStatus = null;
  while (Date.now() <= deadline) {
    const now = Date.now();
    const status = engageBaselineStatus(bot, reactive.state);
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
      const err = new Error(`unsafe PvM engage staging: ${status.reason}`);
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
  const err = new Error(`unsafe PvM engage staging: bot did not hold stable dry ground for ${DRY_BASELINE_STABLE_MS}ms within ${DRY_BASELINE_WAIT_MS}ms (${reason})`);
  err.fields = { staging: lastStatus };
  throw err;
}

function engageBaselineStatus(bot, state, opts = {}) {
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

async function runPostGearAdminSetup(bot) {
  const action = process.env.MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN_ACTION || 'summon-zombie-fire-resistant';
  if (!POST_GEAR_ADMIN_ACTIONS.has(action)) {
    throw new Error(`post-gear PvM admin action must be summon-zombie, summon-zombie-fire-resistant, or summon-spider; got "${action}"`);
  }
  const spawn = pvmEngageSpawnArgs(bot);
  const plan = buildLiveAdminPlan([action, ...spawn.args]);
  if (!plan.ok) throw new Error(`post-gear PvM admin plan invalid: ${plan.reason}`);

  log.test.info(`${ID}.admin.spawn.start`, {
    action,
    spawnMode: spawn.mode,
    spawn: spawnPositionForLog(spawn.args),
    botPosition: positionForLog(bot.entity?.position),
  });

  let result;
  try {
    result = await runLiveAdminPlan(plan);
  } catch (err) {
    throw new Error(`post-gear PvM admin setup failed: ${err?.message || String(err)}`);
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

function pvmEngageSpawnArgs(bot) {
  const mode = process.env.MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_MODE || 'near-bot';
  if (!POST_GEAR_SPAWN_MODES.has(mode)) {
    throw new Error(`post-gear PvM spawn mode must be near-bot or fixed; got "${mode}"`);
  }
  if (mode === 'near-bot') return nearBotPvmEngageSpawnArgs(bot);
  return fixedPvmEngageSpawnArgs();
}

function nearBotPvmEngageSpawnArgs(bot) {
  const position = bot.entity?.position;
  if (!position) throw new Error('cannot spawn PvM hostile near bot before bot position is available');
  const dx = boundedSignedEnvNumber('MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DX', 4, 12);
  const dy = boundedSignedEnvNumber('MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DY', 0, 4);
  const dz = boundedSignedEnvNumber('MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DZ', 0, 12);
  return {
    mode: 'near-bot',
    args: [
      formatCoordinate(position.x + dx),
      formatCoordinate(Math.floor(position.y) + dy),
      formatCoordinate(position.z + dz),
    ],
  };
}

function fixedPvmEngageSpawnArgs() {
  return {
    mode: 'fixed',
    args: [
      String(process.env.MCBOT_LIVE_PVM_ENGAGE_SPAWN_X || '248'),
      String(process.env.MCBOT_LIVE_PVM_ENGAGE_SPAWN_Y || '68'),
      String(process.env.MCBOT_LIVE_PVM_ENGAGE_SPAWN_Z || '428'),
    ],
  };
}

async function waitForSingleAllowedHostile(bot) {
  const deadline = Date.now() + WAIT_MS;
  let attempt = 0;
  if (WAIT_MS > 0) {
    log.test.info(`${ID}.fixture-wait.start`, {
      waitMs: WAIT_MS,
      pollMs: WAIT_POLL_MS,
      radius: FIXTURE_RADIUS,
      allowedHostiles: [...ALLOWED_FIXTURE_HOSTILES],
      botPosition: positionForLog(bot.entity?.position),
    });
  }

  while (true) {
    attempt += 1;
    const waitedMs = Math.max(0, Date.now() - (deadline - WAIT_MS));
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
      const suffix = WAIT_MS > 0 ? ` after waiting ${WAIT_MS}ms` : '';
      throw new Error(`expected exactly one zombie/spider within ${FIXTURE_RADIUS} blocks${suffix}; found 0`);
    }
    await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

function installEngageConfig() {
  config.reactive.engageOverFlee = true;
  config.reactive.minArmorScoreToEngage = MIN_ENGAGE_ARMOR_SCORE;
  config.reactive.requireShieldToEngage = false;
  config.reactive.shieldBlockingEnabled = false;
  config.reactive.rangedCombatPrepEnabled = false;
  config.reactive.rangedCombatFireEnabled = false;
  log.test.info(`${ID}.combat-config`, {
    engageOverFlee: config.reactive.engageOverFlee,
    minArmorScoreToEngage: config.reactive.minArmorScoreToEngage,
    requireShieldToEngage: config.reactive.requireShieldToEngage,
    shieldBlockingEnabled: config.reactive.shieldBlockingEnabled,
    rangedCombatPrepEnabled: config.reactive.rangedCombatPrepEnabled,
    rangedCombatFireEnabled: config.reactive.rangedCombatFireEnabled,
  });
}

function combatSnapshot(bot) {
  return buildSnapshot(bot, {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: MIN_ENGAGE_ARMOR_SCORE,
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

function boundedSignedEnvNumber(name, fallback, maxAbs) {
  const value = envNumber(name, fallback);
  return Math.max(-maxAbs, Math.min(maxAbs, value));
}

function formatCoordinate(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function spawnPositionForLog(args) {
  const [x, y, z] = args.map((value) => Number(value));
  return { x, y, z };
}

function positionForLog(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
