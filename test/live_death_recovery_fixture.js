import ReactiveController from '../src/reactive/reactive.js';
import { SkillExecutor } from '../src/executor/queue.js';
import { createRuntimeContext } from '../src/runtime/context.js';
import log from '../src/logger.js';
import { buildLiveAdminPlan, runLiveAdminPlan } from '../scripts/live-admin-commands.js';
import {
  assertNoHostiles,
  chooseAvailableItem,
  closeLoggedChest,
  depositLogged,
  envNumber,
  envPositiveInteger,
  inventoryCounts,
  openAuthorizedSupplyChest,
  positionForLog,
  runLiveScenario,
  waitForLiveChunks,
  withTimeout,
  withdrawLogged,
} from './live_helpers.js';

const ID = 'live_death_recovery_fixture';
const FIXTURE_ENV = 'MCBOT_LIVE_DEATH_RECOVERY_FIXTURE_OK';
const TEST_ITEM_COUNT = envPositiveInteger('MCBOT_LIVE_DEATH_RECOVERY_ITEM_COUNT', 1);
const MANUAL_DEATH_TIMEOUT_MS = envNumber('MCBOT_LIVE_DEATH_RECOVERY_DEATH_TIMEOUT_MS', 90000);
const RESPAWN_TIMEOUT_MS = envNumber('MCBOT_LIVE_DEATH_RECOVERY_RESPAWN_TIMEOUT_MS', 30000);
const RECOVERY_TIMEOUT_MS = envNumber('MCBOT_LIVE_DEATH_RECOVERY_TIMEOUT_MS', 120000);
const ADMIN_DEATH_AMOUNT = envPositiveInteger('MCBOT_LIVE_DEATH_RECOVERY_ADMIN_DAMAGE', 100);
const ADMIN_EXTRA_ITEM = process.env.MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_ITEM || '';
const ADMIN_EXTRA_COUNT = envPositiveInteger('MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_COUNT', 1);
const TEST_ITEM_CANDIDATES = [
  process.env.MCBOT_LIVE_DEATH_RECOVERY_ITEM,
  'dirt',
  'cobblestone',
  'oak_planks',
  'stone',
].filter(Boolean);

runLiveScenario(ID, async ({ bot, controller, finish }) => {
  await waitForLiveChunks(bot, ID);
  if (process.env[FIXTURE_ENV] !== '1') {
    throw new Error(
      `refusing ${ID} without ${FIXTURE_ENV}=1; this fixture intentionally waits for one manual recoverable death`,
    );
  }
  assertNoHostiles(bot, ID, { phase: 'before arming death-recovery fixture' });

  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.arm`,
  };
  const beforeInventory = inventoryCounts(bot);
  let testItem = null;
  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    if (ADMIN_EXTRA_ITEM) {
      const extraName = normalizeInventoryItemName(ADMIN_EXTRA_ITEM);
      const staleExtraCount = inventoryCounts(bot)[extraName] || 0;
      if (staleExtraCount > 0) {
        await depositLogged(bot, container, extraName, staleExtraCount, ID);
      }
    }
    testItem = chooseAvailableItem(container, TEST_ITEM_CANDIDATES, { minCount: TEST_ITEM_COUNT });
    if (!testItem) {
      throw new Error(`no death-recovery test item found in fixture chest; looked for ${TEST_ITEM_CANDIDATES.join(', ')}`);
    }
    await withdrawLogged(bot, container, testItem.name, TEST_ITEM_COUNT, ID);
    await closeLoggedChest(container, ID);
    closed = true;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }
  const expectedRecovered = { [testItem.name]: TEST_ITEM_COUNT };
  if (ADMIN_EXTRA_ITEM) {
    if (process.env.MCBOT_LIVE_DEATH_RECOVERY_ADMIN !== '1') {
      throw new Error('MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_ITEM requires MCBOT_LIVE_DEATH_RECOVERY_ADMIN=1');
    }
    const givePlan = buildLiveAdminPlan(['give', bot.username, ADMIN_EXTRA_ITEM, String(ADMIN_EXTRA_COUNT)]);
    if (!givePlan.ok) throw new Error(givePlan.reason || 'invalid death-recovery extra give plan');
    log.test.info(`${ID}.admin-extra-give.start`, {
      action: givePlan.action,
      item: ADMIN_EXTRA_ITEM,
      count: ADMIN_EXTRA_COUNT,
    });
    const result = await runLiveAdminPlan(givePlan);
    log.test.info(`${ID}.admin-extra-give.result`, {
      action: result.action,
      dryRun: result.dryRun,
      commandCount: result.commandCount ?? result.commands?.length ?? null,
      responses: result.responses || [],
    });
    expectedRecovered[normalizeInventoryItemName(ADMIN_EXTRA_ITEM)] =
      (expectedRecovered[normalizeInventoryItemName(ADMIN_EXTRA_ITEM)] || 0) + ADMIN_EXTRA_COUNT;
  }

  new ReactiveController(bot);
  const executor = new SkillExecutor(bot, { context: createRuntimeContext() });
  let failure = null;
  let recoveryResult = null;
  let observedDeaths = 0;
  bot.on('death', () => {
    observedDeaths += 1;
    if (observedDeaths > 1) {
      finish(4, `${ID}.failure`, {
        reason: 'bot died again during death recovery fixture; abandoning live proof',
        observedDeaths,
      });
    }
  });
  executor.on('skill:start', (call) => log.test.info(`${ID}.skill.start`, { skill: call.skill, params: call.params }));
  executor.on('skill:preempted', ({ call, result }) => {
    log.test.warn(`${ID}.skill.preempted`, { skill: call.skill, reason: result.reason });
  });
  executor.on('skill:result', ({ call, result }) => {
    log.test.info(`${ID}.skill.result`, {
      skill: call.skill,
      ok: !!result.ok,
      reason: result.reason,
      recoveredItems: result.recoveredItems || {},
      nearbyItems: result.nearbyItems || [],
      itemSweep: result.itemSweep || null,
    });
    if (call.skill === 'recover_drops') recoveryResult = result;
  });
  executor.on('queue:failure', ({ call, result }) => {
    failure = { skill: call.skill, reason: result?.reason || 'unknown failure' };
  });

  log.test.info(`${ID}.armed`, {
    testItem: { name: testItem.name, count: TEST_ITEM_COUNT },
    beforeInventory,
    afterInventory: inventoryCounts(bot),
    expectedRecovered,
    position: positionForLog(bot.entity?.position),
    expectedManualDeath:
      'cause exactly one non-player, non-lava, non-fire, non-void death near this position; fall damage is preferred',
  });

  if (process.env.MCBOT_LIVE_DEATH_RECOVERY_ADMIN === '1') {
    const adminPlan = buildLiveAdminPlan(['death-recovery-fall', bot.username, String(ADMIN_DEATH_AMOUNT)]);
    if (!adminPlan.ok) throw new Error(adminPlan.reason || 'invalid death-recovery admin plan');
    log.test.info(`${ID}.admin-death.start`, {
      action: adminPlan.action,
      commands: adminPlan.commands,
    });
    const result = await runLiveAdminPlan(adminPlan);
    log.test.info(`${ID}.admin-death.result`, {
      action: result.action,
      dryRun: result.dryRun,
      commandCount: result.commandCount ?? result.commands?.length ?? null,
      responses: result.responses || [],
    });
    if (result.dryRun) {
      throw new Error(`${ID} cannot use MCBOT_LIVE_ADMIN_DRY_RUN=1 with MCBOT_LIVE_DEATH_RECOVERY_ADMIN=1; an actual death event is required`);
    }
    const responses = Array.isArray(result.responses) ? result.responses : [];
    const damageResponse = responses.length > 0 ? String(responses[responses.length - 1].response || '') : '';
    if (/No entity was found|No player was found/i.test(damageResponse)) {
      throw new Error(`death-recovery admin damage did not find ${bot.username}: ${damageResponse}`);
    }
  }

  await withTimeout(waitForEvent(bot, 'death'), MANUAL_DEATH_TIMEOUT_MS, `no manual death observed after ${MANUAL_DEATH_TIMEOUT_MS}ms`);
  log.test.info(`${ID}.death.wait.done`, { observedDeaths, position: positionForLog(bot.entity?.position) });
  await withTimeout(waitForEvent(bot, 'respawn'), RESPAWN_TIMEOUT_MS, `no respawn observed after ${RESPAWN_TIMEOUT_MS}ms`);
  log.test.info(`${ID}.respawn-observed`, {
    position: positionForLog(bot.entity?.position),
    pendingQueuePrefixes: executor.pendingQueuePrefixes?.length ?? null,
    queueLength: executor.queue?.length ?? null,
  });
  await waitForLiveChunks(bot, `${ID}.respawn`);

  const pendingPrefixes = executor.pendingQueuePrefixes?.length ?? 0;
  log.test.info(`${ID}.recovery.queued`, {
    pendingQueuePrefixes: pendingPrefixes,
    queueLength: executor.queue?.length ?? null,
  });
  if (pendingPrefixes < 1) {
    throw new Error('respawn did not queue a drop-recovery prefix; check bot respawn/death recovery logs');
  }

  try {
    await withTimeout(executor.runUntilDone(), RECOVERY_TIMEOUT_MS, `drop recovery executor timed out after ${RECOVERY_TIMEOUT_MS}ms`);
  } finally {
    executor.dispose();
  }
  if (failure) throw new Error(`drop recovery queue failed in ${failure.skill}: ${failure.reason}`);
  if (!recoveryResult?.ok) throw new Error('recover_drops did not report a successful recovery result');
  for (const [item, count] of Object.entries(expectedRecovered)) {
    if ((recoveryResult.recoveredItems?.[item] || 0) < count) {
      throw new Error(`recover_drops did not recover proof item ${item}:${count}`);
    }
  }

  const cleanupCtx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.cleanup`,
  };
  container = null;
  closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, cleanupCtx, ID));
    await depositLogged(bot, container, testItem.name, TEST_ITEM_COUNT, ID);
    if (ADMIN_EXTRA_ITEM) {
      const extraName = normalizeInventoryItemName(ADMIN_EXTRA_ITEM);
      const extraCount = inventoryCounts(bot)[extraName] || 0;
      if (extraCount > 0) {
        await depositLogged(bot, container, extraName, extraCount, ID);
      }
    }
    await closeLoggedChest(container, ID);
    closed = true;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }

  finish(0, `${ID}.done`, {
    recoveredItems: recoveryResult.recoveredItems,
    finalInventory: inventoryCounts(bot),
  });
}, {
  allowDeath: true,
  runTimeoutMs: MANUAL_DEATH_TIMEOUT_MS + RESPAWN_TIMEOUT_MS + RECOVERY_TIMEOUT_MS + 60000,
});

function waitForEvent(emitter, eventName) {
  return new Promise((resolve) => {
    emitter.once(eventName, (...args) => resolve(args));
  });
}

function normalizeInventoryItemName(item) {
  return String(item || '').replace(/^minecraft:/, '');
}
