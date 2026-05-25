// Bot factory. Creates a Mineflayer bot, attaches plugins, returns it.
// All actual game-state / loop wiring happens in the caller — this is just construction.

import mineflayer from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { loader as autoEat } from 'mineflayer-auto-eat';
import pkgPvp from 'mineflayer-pvp';
import pkgTool from 'mineflayer-tool';
import armorManager from 'mineflayer-armor-manager';

import config from './config.js';
import log from './logger.js';
import { buildMineflayerOptions, createUserElsewhereKickGuard } from './account_regime.js';
import { PathfinderOwner } from './control/pathfinder.js';
import { installChunkReadyGate } from './control/chunk_ready.js';
import { installDigTimeFallback } from './control/dig_time.js';
import { createDeathRecoveryTracker } from './runtime/death_recovery.js';
import { installHumanizer } from './behavior_shaping/humanizer.js';

const { plugin: pvp } = pkgPvp;
const { plugin: tool } = pkgTool;
const CORE_PLUGINS = [
  { name: 'pathfinder', plugin: pathfinder },
  { name: 'collectBlock', plugin: collectBlock },
  { name: 'autoEat', plugin: autoEat },
  { name: 'pvp', plugin: pvp },
  { name: 'tool', plugin: tool },
  { name: 'armorManager', plugin: armorManager },
];

export function createBot() {
  const mc = config.minecraft;
  const account = config.account;
  const mineflayerOptions = buildMineflayerOptions(mc, account);
  log.startup.info('createBot', {
    host: mineflayerOptions.host,
    port: mineflayerOptions.port,
    version: mineflayerOptions.version,
    username: mineflayerOptions.username,
    auth: mineflayerOptions.auth,
    accountRegime: account.regime,
  });

  const bot = mineflayer.createBot(mineflayerOptions);

  loadCorePlugins(bot);

  // Single chokepoint for all pathfinder writes. Must come after the
  // pathfinder plugin so bot.pathfinder exists.
  bot.pathfinderOwner = new PathfinderOwner(bot);

  // Newer registry data can omit tool-speed multipliers for "incorrect_for_*"
  // materials. Keep Mineflayer's behavior unless the fallback is strictly faster.
  installDigTimeFallback(bot, log.bot);

  // Optional behavior-shaping wrapper. Disabled by default and gated to private
  // regimes only: refuses to install unless account.regime === 'private', and
  // refuses outright on Microsoft-authenticated sessions. Fails closed.
  if (account.regime === 'private' && mineflayerOptions.auth !== 'microsoft') {
    installHumanizer(bot, config.humanization, log.bot);
  } else {
    log.bot.info('behavior_shaping disabled', {
      reason: account.regime !== 'private'
        ? `account.regime is "${account.regime}", requires "private"`
        : 'auth is "microsoft"; behavior shaping never installs on Mojang-authenticated sessions',
    });
  }

  // Skills that scan the world await this before their first findBlocks call.
  // The gate refreshes on spawn/respawn so dimension changes do not reuse a
  // stale already-resolved chunk promise.
  installChunkReadyGate(bot, { waitTimeoutMs: config.executor?.chunkReadyTimeoutMs });

  installBotLogging(bot);

  return bot;
}

export function installBotLogging(bot, logger = log.bot) {
  const deathRecovery = createDeathRecoveryTracker(bot);
  const accountKickGuard = installAccountSessionGuard(bot, config.account, logger);

  // Standard event wiring — every notable event goes through the logger.
  addBotListener(bot, 'login', () => logger.info('login', { username: bot.username }), logger);
  addBotListener(bot, 'spawn', () => logger.info('spawn', { position: bot.entity?.position }), logger);
  addBotListener(bot, 'entityHurt', (entity, source) => deathRecovery.observeEntityHurt(entity, source), logger);
  addBotListener(bot, 'death', () => {
    const record = deathRecovery.recordDeath();
    logger.error('death', {
      position: record.deathPosition,
      dimension: record.deathDimension,
      damageSource: record.damageSource,
      message: record.message,
      nearbyHazards: record.nearbyHazards,
      currentTask: record.currentTask,
      inventorySnapshot: record.inventorySnapshot,
      cause: record.cause,
      recovery: record.decision,
    });
  }, logger);
  addBotListener(bot, 'respawn', () => {
    const recovery = deathRecovery.recordRespawn();
    const dropRecoverySchedule = recovery?.decision?.action === 'recover_drops'
      ? scheduleDropRecovery(bot, deathRecovery, recovery)
      : null;
    logger.warn('respawn', recovery ? { recovery, ...(dropRecoverySchedule ? { dropRecoverySchedule } : {}) } : {});
  }, logger);
  addBotListener(bot, 'kicked', (reason) => {
    const kick = accountKickGuard?.noteKick?.(reason);
    if (kick?.matched) {
      logger.error('user-elsewhere-kick', {
        reason: kick.reason,
        cooldownMs: kick.cooldownMs,
        cooldownUntilMs: kick.cooldownUntilMs,
        accountRegime: kick.regime,
      });
    }
    logger.error('kicked', { reason, accountRegime: config.account?.regime });
  }, logger);
  addBotListener(bot, 'error', (err) => logger.error('error', { err: err?.message || String(err) }), logger);
  addBotListener(bot, 'end', (reason) => logger.warn('end', { reason }), logger);
  addBotListener(bot, 'messagestr', (msg, type) => {
    deathRecovery.observeMessage(msg);
    if (type === 'chat' || type === 'system') logger.debug('chat', { type, msg });
  }, logger);
}

export function installAccountSessionGuard(bot, account = config.account, logger = log.bot) {
  const guard = createUserElsewhereKickGuard(account);
  bot.accountSessionGuard = guard;
  bot.shouldReconnect = () => guard.reconnectStatus().reconnectAllowed;
  if (guard.regime === 'production') {
    logger?.info?.('account.regime.production', {
      userElsewhereKickCooldownMs: account.userElsewhereKickCooldownMs,
      auth: 'microsoft',
    });
  } else {
    logger?.info?.('account.regime.test', {
      username: config.minecraft?.username,
      auth: 'offline',
    });
  }
  return guard;
}

export function scheduleDropRecovery(bot, deathRecovery, recovery) {
  const executor = bot?.skillExecutor;
  if (!executor || typeof executor.requestQueuePrefix !== 'function') {
    return { ok: false, reason: 'skill executor queue prefix unavailable' };
  }
  if (!isPosition(recovery?.deathPosition)) {
    return { ok: false, reason: 'death position unavailable for drop recovery scheduling' };
  }

  const call = {
    skill: 'recover_drops',
    params: {
      x: recovery.deathPosition.x,
      y: recovery.deathPosition.y,
      z: recovery.deathPosition.z,
      ...(recovery.deathDimension ? { dimension: recovery.deathDimension } : {}),
    },
  };

  let queued;
  try {
    queued = executor.requestQueuePrefix([call], {
      reason: 'death-drop-recovery',
      deathPosition: recovery.deathPosition,
      deathDimension: recovery.deathDimension || null,
    });
  } catch (err) {
    return { ok: false, reason: `drop recovery queue prefix failed: ${errorMessage(err)}` };
  }
  if (!queued?.ok) {
    return { ok: false, reason: queued?.reason || 'drop recovery queue prefix rejected' };
  }

  const started = deathRecovery?.markRecoveryStarted?.() || null;
  const abortCurrent = typeof executor.requestCurrentSkillAbort === 'function'
    ? executor.requestCurrentSkillAbort('drop recovery scheduled after respawn')
    : { ok: false, reason: 'current skill abort unavailable' };
  return {
    ok: true,
    queued: queued.count,
    call,
    recovery: started,
    abortCurrent,
  };
}

export function loadCorePlugins(bot, plugins = CORE_PLUGINS, logger = log.startup) {
  for (const { name, plugin } of plugins) {
    try {
      bot.loadPlugin(plugin);
    } catch (err) {
      logger?.error?.('bot.plugin-load-error', { plugin: name, err: err?.message || String(err) });
      throw err;
    }
  }
}

function addBotListener(bot, eventName, listener, logger) {
  try {
    bot.on(eventName, listener);
    return true;
  } catch (err) {
    logger?.warn?.('bot.listener-error', {
      event: eventName,
      err: err?.message || String(err),
    });
    return false;
  }
}

function isPosition(position) {
  return position && ['x', 'y', 'z'].every((axis) => Number.isFinite(Number(position[axis])));
}

function errorMessage(err) {
  return err?.message || String(err);
}

export default createBot;
