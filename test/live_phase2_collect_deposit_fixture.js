import ReactiveController from '../src/reactive/reactive.js';
import { SkillExecutor } from '../src/executor/queue.js';
import { createRuntimeContext } from '../src/runtime/context.js';
import log from '../src/logger.js';
import {
  assertNoHostiles,
  chooseAvailableItem,
  closeLoggedChest,
  depositLogged,
  envNumber,
  equipLogged,
  equipmentSummary,
  inventoryCounts,
  openAuthorizedSupplyChest,
  runLiveScenario,
  waitForLiveChunks,
  withTimeout,
  withdrawLogged,
} from './live_helpers.js';

const ID = 'live_phase2_collect_deposit_fixture';
const COLLECT_COUNT = 10;
const MAX_DISTANCE = envNumber('MCBOT_LIVE_COLLECT_MAX_DISTANCE', 64);
const COLLECT_FIXTURE_ENV = 'MCBOT_LIVE_COLLECT_FIXTURE_OK';
const AXE_CANDIDATES = [
  process.env.MCBOT_LIVE_COLLECT_AXE_ITEM,
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
].filter(Boolean);

runLiveScenario(ID, async ({ bot, controller, finish }) => {
  await waitForLiveChunks(bot, ID);
  if (process.env[COLLECT_FIXTURE_ENV] !== '1') {
    throw new Error(
      `refusing ${ID} without ${COLLECT_FIXTURE_ENV}=1; current collect step mines nearby oak_log blocks and needs an explicitly safe collection area`,
    );
  }
  log.test.info(`${ID}.collect.fixture-ok`, {
    env: COLLECT_FIXTURE_ENV,
    block: 'oak_log',
    count: COLLECT_COUNT,
    maxDistance: MAX_DISTANCE,
  });
  assertNoHostiles(bot, ID);
  await prepareCollectAxe(bot, controller);
  new ReactiveController(bot);

  const runtimeContext = bot.runtimeContext || createRuntimeContext();
  const executor = new SkillExecutor(bot, { context: runtimeContext });
  const beforeInventory = inventoryCounts(bot);
  let collectFailure = null;

  executor.on('skill:start', (call) => log.test.info(`${ID}.skill.start`, { skill: call.skill, params: call.params }));
  executor.on('skill:preempted', ({ call, result }) => {
    log.test.warn(`${ID}.skill.preempted`, { skill: call.skill, reason: result.reason });
  });
  executor.on('skill:result', ({ call, result }) => {
    log.test.info(`${ID}.skill.result`, { skill: call.skill, ok: !!result.ok, reason: result.reason });
  });
  executor.on('queue:failure', ({ call, result }) => {
    collectFailure = { skill: call.skill, reason: result?.reason || 'unknown failure' };
  });

  executor.enqueue([{ skill: 'collect', params: { block: 'oak_log', count: COLLECT_COUNT, maxDistance: MAX_DISTANCE } }]);
  try {
    await withTimeout(executor.runUntilDone(), 180000, 'collect phase timed out after 180000ms');
  } finally {
    executor.dispose();
  }
  if (collectFailure) throw new Error(`collect phase failed: ${collectFailure.reason}`);

  const afterCollectInventory = inventoryCounts(bot);
  const collectedLogs = (afterCollectInventory.oak_log || 0) - (beforeInventory.oak_log || 0);
  log.test.info(`${ID}.collect.delta`, {
    beforeInventory,
    afterCollectInventory,
    collectedLogs,
  });
  if (collectedLogs < COLLECT_COUNT) {
    throw new Error(`collect phase did not add ${COLLECT_COUNT} oak_log; delta was ${collectedLogs}`);
  }

  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.fixture-deposit`,
  };
  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    await depositLogged(bot, container, 'oak_log', collectedLogs, ID);
    await closeLoggedChest(container, ID);
    closed = true;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }

  finish(0, `${ID}.done`, {
    collectedLogs,
    finalInventory: inventoryCounts(bot),
  });
});

async function prepareCollectAxe(bot, controller) {
  const beforeInventory = inventoryCounts(bot);
  const beforeEquipment = equipmentSummary(bot);
  log.test.info(`${ID}.gear.before`, {
    inventory: beforeInventory,
    equipment: beforeEquipment,
    candidates: AXE_CANDIDATES,
  });

  let axeName = chooseInventoryCandidate(bot, AXE_CANDIDATES);
  if (axeName) {
    log.test.info(`${ID}.gear.selected`, { source: 'inventory', item: axeName });
    await equipLogged(bot, axeName, 'hand', ID);
    return;
  }

  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.gear-prep`,
  };
  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    const axe = chooseAvailableItem(container, AXE_CANDIDATES, { minCount: 1 });
    if (!axe) {
      throw new Error(`no axe candidate found in fixture chest or inventory; looked for ${AXE_CANDIDATES.join(', ')}`);
    }
    log.test.info(`${ID}.gear.selected`, { source: 'authorized-chest', item: axe.name });
    await withdrawLogged(bot, container, axe.name, 1, ID);
    await closeLoggedChest(container, ID);
    closed = true;
    axeName = axe.name;
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }

  await equipLogged(bot, axeName, 'hand', ID);
}

function chooseInventoryCandidate(bot, candidates) {
  const counts = inventoryCounts(bot);
  for (const name of candidates) {
    if ((counts[name] || 0) > 0) return name;
  }
  return null;
}
