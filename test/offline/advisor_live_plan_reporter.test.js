import test from 'node:test';
import assert from 'node:assert/strict';

import {
  armFinalOutcomeStopWatchdog,
  buildAdvisorLivePlanConfig,
  buildHostileCleanupPlan,
  buildHostileInductionPlan,
  buildQuietBaselineRestorePlan,
  buildStartupSetupPlans,
  classifyPlanActivationRejection,
  createAdvisorLivePlanReport,
  finalizeAdvisorLivePlanReport,
  isAdvisorLivePlanBotDisconnectRecord,
  markHostileCleanup,
  markHostileInduced,
  markFinalOutcomeStopWatchdog,
  maybeScheduleTerminalActivationRejectionStop,
  parseDifficultyFromAdminResult,
  parseAdvisorLivePlanArgs,
  updateAdvisorLivePlanReportFromRecord,
} from '../../scripts/advisor-live-plan.js';

const REGIME_A_ACCOUNT = Object.freeze({ regime: 'test' });
const REGIME_A_MINECRAFT = Object.freeze({ username: 'MCBot', auth: 'offline' });
const DEEPSEEK_READY = Object.freeze({ apiKey: 'configured' });

test('advisor live-plan args default to F2 gather goal and hostile induction timing', () => {
  const opts = parseAdvisorLivePlanArgs([]);

  assert.equal(opts.goal, 'gather 10 logs');
  assert.equal(opts.induceAfterMs, 45000);
  assert.deepEqual(opts.hostileOffset, { x: 4, y: 0, z: 0 });
  assert.equal(opts.hostileCleanupAfterFleeMs, 0);
  assert.equal(opts.hostileCleanupRadius, 24);
  assert.match(opts.reportPath, /reports[\\/]advisor-live-plan\.json$/);
});

test('advisor live-plan args support startup RCON setup fixture options', () => {
  const opts = parseAdvisorLivePlanArgs([
    '--report-path', 'reports/custom-composite.json',
    '--setup-quiet-baseline',
    '--setup-teleport', '201', '68', '476',
    '--setup-clear-all',
    '--setup-clear-item', 'minecraft:oak_log',
    '--setup-give', 'minecraft:stone_pickaxe', '1',
    '--setup-block', '203', '67', '474', 'minecraft:oak_log',
    '--setup-damage', '8',
    '--setup-damage-type', 'minecraft:out_of_world',
    '--setup-damage-delay-ms', '4000',
    '--cleanup-induced-hostile-after-flee-ms', '2000',
    '--hostile-cleanup-radius', '18',
  ]);

  assert.match(opts.reportPath, /reports[\\/]custom-composite\.json$/);
  assert.equal(opts.setupQuietBaseline, true);
  assert.deepEqual(opts.setupTeleport, { x: 201, y: 68, z: 476 });
  assert.equal(opts.setupClearAll, true);
  assert.deepEqual(opts.setupClearItems, ['minecraft:oak_log']);
  assert.deepEqual(opts.setupGives, [{ item: 'minecraft:stone_pickaxe', count: 1 }]);
  assert.deepEqual(opts.setupBlocks, [{ x: 203, y: 67, z: 474, block: 'minecraft:oak_log' }]);
  assert.equal(opts.setupDamage, 8);
  assert.equal(opts.setupDamageType, 'minecraft:out_of_world');
  assert.equal(opts.setupDamageDelayMs, 4000);
  assert.equal(opts.hostileCleanupAfterFleeMs, 2000);
  assert.equal(opts.hostileCleanupRadius, 18);
});

test('advisor live-plan help lists full inventory clear setup flag', () => {
  const result = buildAdvisorLivePlanConfig({
    argv: ['--help'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(result.help, true);
  assert.match(result.reason, /--setup-clear-all/);
  assert.match(result.reason, /--setup-block/);
});

test('advisor live-plan config refuses unsafe or incomplete live env with exact reasons', () => {
  const result = buildAdvisorLivePlanConfig({
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /MCBOT_LIVE_TESTS=1 required/);
  assert.match(result.reason, /MCBOT_ALLOW_DEEPSEEK=1 required/);
  assert.match(result.reason, /MCBOT_LIVE_ADMIN_OK=1 required/);
  assert.match(result.reason, /MCBOT_RCON_PASSWORD required/);
});

test('advisor live-plan config enforces Regime A account shape', () => {
  const result = buildAdvisorLivePlanConfig({
    env: {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_ALLOW_DEEPSEEK: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_LIVE_ADMIN_RAW_OK: '1',
      MCBOT_RCON_PASSWORD: 'secret',
    },
    account: { regime: 'unsafe' },
    minecraft: { username: 'Player', auth: 'microsoft' },
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /account\.regime must be "test"/);
  assert.match(result.reason, /minecraft\.username must be "MCBot"/);
  assert.match(result.reason, /minecraft\.auth must be "offline"/);
});

test('advisor live-plan config accepts private Regime A gates', () => {
  const result = buildAdvisorLivePlanConfig({
    argv: ['--goal', 'gather 10 logs', '--timeout-ms', '1000'],
    env: {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_ALLOW_DEEPSEEK: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_LIVE_ADMIN_RAW_OK: '1',
      MCBOT_RCON_PASSWORD: 'secret',
    },
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(result.ok, true);
  assert.equal(result.options.goal, 'gather 10 logs');
  assert.deepEqual(result.command.args.slice(0, 3), ['--v8-pool-size=1', '--max-old-space-size=4096', 'src/index.js']);
  assert.equal(result.account.username, 'MCBot');
  assert.equal(result.command.env.DEEPSEEK_MODEL, 'deepseek-v4-pro');
});

test('advisor live-plan wrapper locks child model to deepseek-v4-pro over env and keys config', () => {
  const result = buildAdvisorLivePlanConfig({
    argv: ['--goal', 'make a stone pickaxe', '--timeout-ms', '1000'],
    env: {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_ALLOW_DEEPSEEK: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_LIVE_ADMIN_RAW_OK: '1',
      MCBOT_RCON_PASSWORD: 'secret',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
    },
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: { apiKey: 'configured', model: 'deepseek-v4-flash' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.command.env.DEEPSEEK_MODEL, 'deepseek-v4-pro');
  assert.deepEqual(result.advisorModel, {
    required: 'deepseek-v4-pro',
    requested: 'deepseek-v4-flash',
    childEnv: 'deepseek-v4-pro',
    overridden: true,
  });

  const report = createAdvisorLivePlanReport(result, new Date('2026-05-24T00:00:00.000Z'));
  assert.deepEqual(report.diagnostics.advisorModel, result.advisorModel);
});

test('advisor live-plan config injects startup delay when setup is requested', () => {
  const result = buildAdvisorLivePlanConfig({
    argv: ['--setup-teleport', '201', '68', '476', '--setup-clear-item', 'minecraft:oak_log'],
    env: {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_ALLOW_DEEPSEEK: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_LIVE_ADMIN_RAW_OK: '1',
      MCBOT_RCON_PASSWORD: 'secret',
    },
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(result.ok, true);
  assert.equal(result.command.env.MCBOT_STARTUP_DELAY_MS, '5000');
});

test('advisor live-plan startup clears use vanilla minecraft namespace', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: [
      '--goal', 'noop',
      '--timeout-ms', '1000',
      '--setup-clear-item', 'minecraft:oak_log',
      '--dry-run',
    ],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(runConfig.ok, true);
  const plans = buildStartupSetupPlans(runConfig.options);
  assert.deepEqual(plans.map((plan) => plan.commands).flat(), [
    'minecraft:clear MCBot minecraft:oak_log',
  ]);
});

test('advisor live-plan startup can clear the full bot inventory', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: [
      '--goal', 'noop',
      '--timeout-ms', '1000',
      '--setup-clear-all',
      '--dry-run',
    ],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(runConfig.ok, true);
  const plans = buildStartupSetupPlans(runConfig.options);
  assert.deepEqual(plans.map((plan) => plan.commands).flat(), [
    'minecraft:clear MCBot',
  ]);
});

test('advisor live-plan startup can place controlled fixture blocks', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: [
      '--goal', 'noop',
      '--timeout-ms', '1000',
      '--setup-block', '203', '67', '474', 'minecraft:oak_log',
      '--setup-block', '203', '66', '474', 'minecraft:grass_block',
      '--dry-run',
    ],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(runConfig.ok, true);
  const plans = buildStartupSetupPlans(runConfig.options);
  assert.deepEqual(plans.map((plan) => plan.commands).flat(), [
    'minecraft:setblock 203 67 474 minecraft:oak_log replace',
    'minecraft:setblock 203 66 474 minecraft:grass_block replace',
  ]);
});

test('advisor live-plan startup can apply controlled post-setup damage', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: [
      '--goal', 'noop',
      '--timeout-ms', '1000',
      '--setup-give', 'minecraft:golden_apple', '1',
      '--setup-damage', '8',
      '--setup-damage-type', 'minecraft:out_of_world',
      '--setup-damage-delay-ms', '4000',
      '--dry-run',
    ],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(runConfig.ok, true);
  const plans = buildStartupSetupPlans(runConfig.options);
  assert.deepEqual(plans.map((plan) => plan.action), ['give', 'wait', 'raw']);
  assert.equal(plans[1].waitMs, 4000);
  assert.deepEqual(plans.map((plan) => plan.commands).flat(), [
    'give MCBot minecraft:golden_apple 1',
    'minecraft:damage MCBot 8 minecraft:out_of_world',
  ]);
});

test('advisor live-plan quiet baseline setup forces peaceful day cleanup before mission setup', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: [
      '--goal', 'noop',
      '--timeout-ms', '1000',
      '--setup-quiet-baseline',
      '--setup-teleport', '201', '67', '476',
      '--setup-clear-all',
      '--setup-clear-item', 'minecraft:oak_log',
      '--dry-run',
    ],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(runConfig.ok, true);
  const plans = buildStartupSetupPlans(runConfig.options);
  assert.deepEqual(plans.map((plan) => plan.commands).flat(), [
    'minecraft:difficulty peaceful',
    'minecraft:time set day',
    'minecraft:kill @e[type=!player]',
    'minecraft:forceload add 201 476',
    'minecraft:setblock 201 66 476 minecraft:grass_block replace',
    'minecraft:fill 201 67 476 201 68 476 minecraft:air replace',
    'minecraft:tp MCBot 201 67 476',
    'minecraft:forceload remove 201 476',
    'minecraft:clear MCBot',
    'minecraft:clear MCBot minecraft:oak_log',
    'minecraft:effect give MCBot minecraft:instant_health 1 10 true',
    'minecraft:effect give MCBot minecraft:saturation 1 10 true',
  ]);
});

test('advisor live-plan quiet baseline parses and restores original difficulty', () => {
  const originalDifficulty = parseDifficultyFromAdminResult({
    responses: [{ command: 'difficulty', response: 'The difficulty is Easy', type: 0 }],
  });
  const restore = buildQuietBaselineRestorePlan({ originalDifficulty });

  assert.equal(originalDifficulty, 'easy');
  assert.equal(restore.ok, true);
  assert.deepEqual(restore.commands, ['minecraft:difficulty easy']);
});

test('advisor live-plan report consumes runtime logs into phase-shift schema', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  assert.equal(runConfig.ok, true);
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  markHostileInduced(report, {
    ok: true,
    dryRun: true,
    action: 'mcbottest-spawn-zombie-fire-resistant',
    commandCount: 1,
    tag: 'f2_live_plan_hostile_1',
    spawn: { x: 104, y: 65, z: 100 },
  }, new Date('2026-05-24T00:01:00.000Z'));
  report.plugin.started = true;
  report.plugin.ended = true;
  report.plugin.finalSnapshot = { ok: true };
  report.plugin.telemetrySummary = { taggedHostileSpawnCount: 1 };
  report.mission.finalInventory = {
    captured: true,
    counts: { oak_log: 10 },
    logCounts: { oak_log: 10 },
    totalLogs: 10,
    meetsGoal: true,
    partialGoal: true,
  };

  for (const record of [
    { t: '2026-05-24T00:00:01.000Z', evt: 'snapshot', position: { x: 100, y: 65, z: 100, dimension: 'overworld' } },
    { t: '2026-05-24T00:00:02.000Z', evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { t: '2026-05-24T00:00:03.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:04.000Z', evt: 'llm.response', sessionCostUsd: 0.42, callCostUsd: 0.42, model: 'deepseek-v4-pro' },
    { t: '2026-05-24T00:00:05.000Z', evt: 'plan.accepted', steps: 2, plan: [{ skill: 'collect', params: { block: 'oak_log', count: 10 } }] },
    { t: '2026-05-24T00:00:06.000Z', evt: 'goal.plan-activation-ok' },
    { t: '2026-05-24T00:00:06.500Z', evt: 'resume.ready', dtMs: 17, fastPath: false, blockedMs: 7 },
    { t: '2026-05-24T00:00:07.000Z', evt: 'skill.invoke', skill: 'goto' },
    { t: '2026-05-24T00:00:08.000Z', evt: 'skill.result', skill: 'goto', ok: true, dtMs: 1000 },
    { t: '2026-05-24T00:00:09.000Z', evt: 'skill.invoke', skill: 'collect' },
    { t: '2026-05-24T00:00:29.000Z', evt: 'collect.inventory-wait', mode: 'fastDig', waitedMs: 151, maxMs: 150, delta: 1 },
    { t: '2026-05-24T00:00:30.000Z', evt: 'collect.target', sofar: 1, goal: 10 },
    { t: '2026-05-24T00:00:30.000Z', evt: 'skill.result', skill: 'collect', ok: true, dtMs: 21000 },
    { t: '2026-05-24T00:01:02.000Z', evt: 'state.transition', to: 'FLEEING', reason: 'hostile-flee', entity: 'zombie', dist: 4 },
    { t: '2026-05-24T00:01:10.000Z', evt: 'state.transition', to: 'NORMAL', reason: 'threat-cleared' },
    { t: '2026-05-24T00:01:20.000Z', evt: 'main.goal-done', reason: 'goal complete', replans: 0 },
  ]) {
    updateAdvisorLivePlanReportFromRecord(report, record);
  }

  finalizeAdvisorLivePlanReport(report, { endedAt: '2026-05-24T00:01:21.000Z' });

  assert.equal(report.ok, true);
  assert.equal(report.noApiCall, false);
  assert.equal(report.status, 'live_plan_completed');
  assert.equal(report.planner.callMade, true);
  assert.equal(report.planner.schemaValid, true);
  assert.equal(report.planner.acceptedSteps, 2);
  assert.equal(report.activation.accepted, true);
  assert.equal(report.executor.ranSkillCount, 2);
  assert.deepEqual(report.executor.skillsExecuted, ['goto', 'collect']);
  assert.equal(report.executor.failedSkillCount, 0);
  assert.equal(report.timing.queueHandoff[0].source, 'activation');
  assert.equal(report.timing.queueHandoff[0].dtMs, 1000);
  assert.equal(report.timing.queueHandoff[1].source, 'previous_skill_result');
  assert.equal(report.timing.queueHandoff[1].dtMs, 1000);
  assert.deepEqual(report.timing.pathfinderSettle[0], {
    at: '2026-05-24T00:00:06.500Z',
    dtMs: 17,
    blockedMs: 7,
    fastPath: false,
  });
  assert.deepEqual(report.timing.pickupWait[0], {
    at: '2026-05-24T00:00:29.000Z',
    phase: 'initial_inventory_delta',
    mode: 'fastDig',
    waitedMs: 151,
    maxMs: 150,
    delta: 1,
  });
  assert.equal(report.timing.skillRuntime.find((entry) => entry.skill === 'collect').dtMs, 21000);
  assert.equal(report.timing.summary.totalSkillRuntimeMs, 22000);
  assert.equal(report.timing.summary.totalPathfinderSettleMs, 17);
  assert.equal(report.timing.summary.totalPickupWaitMs, 151);
  assert.equal(Object.hasOwn(report.timing, '_state'), false);
  assert.equal(report.finalOutcome.reported, true);
  assert.equal(report.cost.usd, 0.42);
  assert.equal(report.costCeilingGuard.verified, true);
  assert.deepEqual(report.mission.woodTargets, ['oak_log']);
  assert.equal(report.mission.progress.maxLogsObserved, 1);
  assert.equal(report.hostileFlee.eligibleAt, '2026-05-24T00:00:06.000Z');
  assert.equal(report.hostileFlee.transitionObservedAt, '2026-05-24T00:01:02.000Z');
  assert.equal(report.hostileFlee.survived, true);
  assert.equal(report.hostileFlee.returnedNormal, true);
});

test('advisor live-plan hostile induction becomes eligible only after activation or executor work', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));

  updateAdvisorLivePlanReportFromRecord(report, { t: '2026-05-24T00:00:01.000Z', evt: 'llm.request' });
  updateAdvisorLivePlanReportFromRecord(report, { t: '2026-05-24T00:00:02.000Z', evt: 'plan.accepted', steps: 1 });
  assert.equal(report.hostileFlee.eligibleAt, null);

  updateAdvisorLivePlanReportFromRecord(report, { t: '2026-05-24T00:00:03.000Z', evt: 'goal.plan-activation-ok' });
  updateAdvisorLivePlanReportFromRecord(report, { t: '2026-05-24T00:00:04.000Z', evt: 'skill.invoke', skill: 'collect' });

  assert.equal(report.hostileFlee.eligibleAt, '2026-05-24T00:00:03.000Z');
});

test('advisor live-plan report persists LLM finish telemetry and max-token hits', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));

  updateAdvisorLivePlanReportFromRecord(report, { t: '2026-05-24T00:00:01.000Z', evt: 'llm.request' });
  updateAdvisorLivePlanReportFromRecord(report, {
    t: '2026-05-24T00:00:02.000Z',
    evt: 'llm.response',
    model: 'deepseek-v4-pro',
    promptTokens: 100,
    completionTokens: 4096,
    totalTokens: 4196,
    finishReason: 'length',
    chars: 0,
    maxTokens: 4096,
  });
  updateAdvisorLivePlanReportFromRecord(report, { t: '2026-05-24T00:00:03.000Z', evt: 'llm.request' });
  updateAdvisorLivePlanReportFromRecord(report, {
    t: '2026-05-24T00:00:04.000Z',
    evt: 'llm.response',
    model: 'deepseek-v4-pro',
    promptTokens: 80,
    completionTokens: 120,
    totalTokens: 200,
    finishReason: 'stop',
    chars: 512,
    maxTokens: 2048,
  });

  assert.deepEqual(report.advisorCalls[0], {
    index: 1,
    requestedAt: '2026-05-24T00:00:01.000Z',
    respondedAt: '2026-05-24T00:00:02.000Z',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    latencyMs: null,
    inputTokens: 100,
    outputTokens: 4096,
    totalTokens: 4196,
    usd: null,
    sessionCostUsd: null,
    costCeilingUsd: null,
    costCeilingStatus: null,
    schemaValidation: 'pending',
    finishReason: 'length',
    chars: 0,
    maxTokens: 4096,
    maxTokensHit: true,
  });
  assert.equal(report.advisorCalls[1].finishReason, 'stop');
  assert.equal(report.advisorCalls[1].chars, 512);
  assert.equal(report.advisorCalls[1].maxTokens, 2048);
  assert.equal(report.advisorCalls[1].maxTokensHit, false);
});

test('advisor live-plan item-chain goal can complete from final inventory without hostile induction', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run', '--goal', 'make a stone pickaxe'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  assert.equal(runConfig.ok, true);
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  report.plugin.started = true;
  report.plugin.ended = true;
  report.plugin.finalSnapshot = { ok: true };
  report.plugin.telemetrySummary = { taggedHostileSpawnCount: 0 };
  report.mission.finalInventory = {
    captured: true,
    counts: { stone_pickaxe: 1, wooden_pickaxe: 1 },
    logCounts: {},
    totalLogs: 0,
    meetsGoal: false,
    partialGoal: false,
  };

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 3, currentUsd: 0 } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01, model: 'deepseek-v4-pro' },
    { evt: 'plan.accepted', steps: 7, plan: [{ skill: 'craft', params: { item: 'stone_pickaxe', count: 1 } }] },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'skill.invoke', skill: 'craft' },
    { evt: 'skill.result', skill: 'craft', ok: true, reason: 'crafted 1 stone_pickaxe' },
    { evt: 'main.goal-done', reason: 'goal complete', replans: 0 },
  ]) {
    updateAdvisorLivePlanReportFromRecord(report, record);
  }

  finalizeAdvisorLivePlanReport(report);

  assert.equal(report.ok, true);
  assert.equal(report.status, 'live_plan_completed');
  assert.equal(report.outcome, 'success');
  assert.equal(report.hostileFlee.survived, false);
  assert.deepEqual(report.mission.itemGoal, {
    verb: 'make',
    item: 'stone_pickaxe',
    rawItem: 'stone pickaxe',
    count: 1,
    have: 1,
    met: true,
  });
});

test('advisor live-plan report rejects queue failure even if a later empty replan says done', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  markHostileInduced(report, { ok: true, action: 'mcbottest-spawn-zombie-fire-resistant', commandCount: 1 });
  report.plugin.started = true;
  report.plugin.ended = true;
  report.plugin.finalSnapshot = { ok: true };
  report.plugin.telemetrySummary = { taggedHostileSpawnCount: 1 };
  report.mission.finalInventory = {
    captured: true,
    counts: { oak_log: 10 },
    logCounts: { oak_log: 10 },
    totalLogs: 10,
    meetsGoal: true,
    partialGoal: true,
  };

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01 },
    { evt: 'plan.accepted', steps: 1 },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'skill.invoke', skill: 'collect' },
    { evt: 'state.transition', to: 'FLEEING', reason: 'hostile-flee', entity: 'zombie', dist: 4 },
    { evt: 'state.transition', to: 'NORMAL', reason: 'threat-cleared' },
    { evt: 'skill.result', skill: 'collect', ok: false, reason: 'skill threw: skill timed out' },
    { evt: 'queue.failure', skill: 'collect', reason: 'skill threw: skill timed out' },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.02 },
    { evt: 'plan.accepted', steps: 0 },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'main.goal-done', reason: 'goal complete', replans: 1 },
  ]) {
    updateAdvisorLivePlanReportFromRecord(report, record);
  }

  finalizeAdvisorLivePlanReport(report);

  assert.equal(report.ok, false);
  assert.equal(report.status, 'live_plan_failed');
  assert.equal(report.planner.acceptedSteps, 1);
  assert.equal(report.planner.lastAcceptedSteps, 0);
  assert.equal(report.executor.failedSkillCount, 2);
  assert.match(report.diagnostics.failures.join('\n'), /collect: skill threw: skill timed out/);
});

test('advisor live-plan generic goal can complete after recoverable replans', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run', '--goal', 'Fish three times then deposit caught items.'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  report.plugin.started = true;
  report.plugin.ended = true;
  report.plugin.finalSnapshot = { ok: true };
  report.plugin.telemetrySummary = { taggedHostileSpawnCount: 0 };

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01, completionTokens: 500, maxTokens: 1536, finishReason: 'stop' },
    { evt: 'plan.accepted', steps: 1, plan: [{ skill: 'fish_and_deposit', params: { catches: 3, depositChest: { x: 248, y: 68, z: 428 } } }] },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'skill.invoke', skill: 'fish_and_deposit' },
    { evt: 'skill.result', skill: 'fish_and_deposit', ok: false, reason: 'fish_until attempt 1 failed: timed out' },
    { evt: 'queue.failure', skill: 'fish_and_deposit', reason: 'fish_until attempt 1 failed: timed out' },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.02, completionTokens: 1536, maxTokens: 1536, finishReason: 'length' },
    { evt: 'plan.bad-json', reason: 'JSON parse: Unexpected end of JSON input' },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.03, completionTokens: 300, maxTokens: 1024, finishReason: 'stop' },
    { evt: 'plan.accepted', steps: 1, plan: [{ skill: 'fish_and_deposit', params: { catches: 3, depositChest: { x: 248, y: 68, z: 428 } } }] },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'skill.invoke', skill: 'fish_and_deposit' },
    { evt: 'skill.result', skill: 'fish_and_deposit', ok: true, reason: 'fish_and_deposit caught 3 and deposited 1 cod, 1 leather, 1 salmon' },
    { evt: 'main.goal-done', reason: 'goal complete', replans: 2 },
  ]) {
    updateAdvisorLivePlanReportFromRecord(report, record);
  }

  finalizeAdvisorLivePlanReport(report);

  assert.equal(report.ok, true);
  assert.equal(report.status, 'live_plan_completed');
  assert.equal(report.outcome, 'success');
  assert.equal(report.executor.failedSkillCount, 2);
  assert.equal(report.executor.lastSkillResult.ok, true);
  assert.match(report.diagnostics.failures.join('\n'), /fish_until attempt 1 failed/);
  assert.match(report.diagnostics.failures.join('\n'), /advisor response failed validation/);
});

test('advisor live-plan report terminals on bot disconnect and ignores post-disconnect replans', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run', '--goal', 'make an iron pickaxe'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  report.plugin.started = true;
  report.plugin.ended = true;
  report.plugin.finalSnapshot = { ok: true };
  report.plugin.telemetrySummary = { taggedHostileSpawnCount: 0 };
  report.mission.finalInventory = {
    captured: true,
    counts: { oak_log: 2 },
    logCounts: { oak_log: 2 },
    totalLogs: 2,
    meetsGoal: false,
    partialGoal: false,
  };

  const preDisconnectRecords = [
    { t: '2026-05-24T00:00:01.000Z', evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { t: '2026-05-24T00:00:02.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:03.000Z', evt: 'llm.response', model: 'deepseek-v4-pro', sessionCostUsd: 0.01 },
    { t: '2026-05-24T00:00:04.000Z', evt: 'plan.accepted', steps: 1, plan: [{ skill: 'mine_with_progression', params: { ores: ['iron_ore'], count: 3 } }] },
    { t: '2026-05-24T00:00:05.000Z', evt: 'goal.plan-activation-ok' },
    { t: '2026-05-24T00:00:06.000Z', evt: 'skill.invoke', skill: 'mine_with_progression' },
    { t: '2026-05-24T00:00:07.000Z', evt: 'skill.result', skill: 'mine_with_progression', ok: false, reason: 'shaft start failed' },
    { t: '2026-05-24T00:00:08.000Z', evt: 'queue.failure', skill: 'mine_with_progression', reason: 'shaft start failed' },
  ];
  for (const record of preDisconnectRecords) updateAdvisorLivePlanReportFromRecord(report, record);

  const disconnectRecord = {
    t: '2026-05-24T00:00:09.000Z',
    loop: 'bot',
    evt: 'end',
    reason: 'socketClosed',
  };
  assert.equal(isAdvisorLivePlanBotDisconnectRecord(disconnectRecord), true);

  const nowBeforeDisconnect = Date.now();
  updateAdvisorLivePlanReportFromRecord(report, disconnectRecord);
  const nowAfterDisconnect = Date.now();

  const postDisconnectRecords = [
    { t: '2026-05-24T00:00:10.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:11.000Z', evt: 'llm.response', model: 'deepseek-v4-pro', sessionCostUsd: 0.02 },
    { t: '2026-05-24T00:00:12.000Z', evt: 'plan.accepted', steps: 1, plan: [{ skill: 'goto', params: { x: 1, y: 2, z: 3 } }] },
    { t: '2026-05-24T00:00:13.000Z', evt: 'skill.invoke', skill: 'goto' },
    { t: '2026-05-24T00:00:14.000Z', evt: 'skill.result', skill: 'goto', ok: false, reason: 'stuck after disconnect' },
  ];
  for (const record of postDisconnectRecords) updateAdvisorLivePlanReportFromRecord(report, record);

  finalizeAdvisorLivePlanReport(report, {
    endedAt: '2026-05-24T00:00:10.500Z',
    childExit: { code: null, signal: 'SIGINT' },
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'bot_disconnected_during_run');
  assert.equal(report.outcome, 'partial');
  assert.equal(report.disconnectReason, 'socketClosed');
  assert.equal(Number.isFinite(report.disconnectedAtMs), true);
  assert.ok(report.disconnectedAtMs >= nowBeforeDisconnect);
  assert.ok(report.disconnectedAtMs <= nowAfterDisconnect);
  assert.equal(report.advisorCalls.length, 1);
  assert.equal(report.cost.usd, 0.01);
  assert.deepEqual(report.executor.skillsExecuted, ['mine_with_progression']);
  assert.equal(report.executor.failedSkillCount, 2);
  assert.match(report.diagnostics.failures.join('\n'), /shaft start failed/);
  assert.doesNotMatch(report.diagnostics.failures.join('\n'), /stuck after disconnect/);
  assert.equal(report.diagnostics.logEvents['llm.request'], 1);
  assert.equal(report.diagnostics.logEvents['skill.invoke'], 1);
  assert.equal(report.diagnostics.logEvents.end, 1);
  assert.deepEqual(report.mission.finalInventory.counts, { oak_log: 2 });
  assert.deepEqual(report.diagnostics.childExit, { code: null, signal: 'SIGINT' });
});

test('advisor live-plan stops promptly for terminal activation no-op rejection', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run', '--goal', 'make an iron pickaxe'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  const stops = [];
  const record = {
    t: '2026-05-24T00:00:09.000Z',
    evt: 'goal.plan-activation-rejected',
    reason: 'item-chain goal "make an iron pickaxe" requires a progress-capable skill for iron_pickaxe; rejected no-op plan',
    badIndex: 0,
    safetyReasons: [],
    staleReasons: [],
  };

  updateAdvisorLivePlanReportFromRecord(report, record);
  const stopped = maybeScheduleTerminalActivationRejectionStop(
    record,
    report,
    (reason) => stops.push(reason),
  );
  finalizeAdvisorLivePlanReport(report, { endedAt: '2026-05-24T00:00:10.000Z' });

  assert.equal(stopped, true);
  assert.deepEqual(stops, ['advisor-live-plan-terminal-activation-rejection']);
  assert.equal(report.activation.terminal, true);
  assert.equal(report.activation.rejectionClass, 'no_op_progress_plan');
  assert.equal(report.finalOutcome.reported, true);
  assert.equal(report.finalOutcome.ok, false);
  assert.match(report.finalOutcome.summary, /terminal plan activation rejection/);
  assert.equal(report.ok, false);
  assert.equal(report.status, 'live_plan_failed');
});

test('advisor live-plan does not terminal-stop transient activation rejections', () => {
  const stale = {
    evt: 'goal.plan-activation-rejected',
    reason: 'stale plan activation: position drift 8 > 2',
    staleReasons: ['position drift 8 > 2'],
  };
  const safety = {
    evt: 'goal.plan-activation-rejected',
    reason: 'unsafe snapshot permits only observe/flee/consume, rejected collect',
    safetyReasons: ['nearby hostile zombie at 3'],
  };

  assert.deepEqual(classifyPlanActivationRejection(stale), {
    terminal: false,
    kind: 'transient_stale',
    reason: stale.reason,
  });
  assert.equal(classifyPlanActivationRejection(safety).terminal, false);

  for (const record of [stale, safety]) {
    const runConfig = buildAdvisorLivePlanConfig({
      argv: ['--dry-run'],
      env: {},
      account: REGIME_A_ACCOUNT,
      minecraft: REGIME_A_MINECRAFT,
      deepseek: DEEPSEEK_READY,
    });
    const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
    const stops = [];
    updateAdvisorLivePlanReportFromRecord(report, record);

    assert.equal(maybeScheduleTerminalActivationRejectionStop(record, report, (reason) => stops.push(reason)), false);
    assert.deepEqual(stops, []);
    assert.equal(report.finalOutcome.reported, false);
  }
});

test('advisor live-plan report fails if hostile induction never produces flee', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  markHostileInduced(report, { ok: true, action: 'mcbottest-spawn-zombie-fire-resistant', commandCount: 1 });
  report.plugin.started = true;
  report.plugin.ended = true;
  report.plugin.finalSnapshot = { ok: true };
  report.plugin.telemetrySummary = { taggedHostileSpawnCount: 1 };
  report.mission.finalInventory = {
    captured: true,
    counts: { oak_log: 10 },
    logCounts: { oak_log: 10 },
    totalLogs: 10,
    meetsGoal: true,
    partialGoal: true,
  };
  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.1 },
    { evt: 'plan.accepted', steps: 1 },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'skill.invoke', skill: 'observe' },
    { evt: 'main.goal-done', reason: 'goal complete' },
  ]) {
    updateAdvisorLivePlanReportFromRecord(report, record);
  }

  finalizeAdvisorLivePlanReport(report);

  assert.equal(report.ok, false);
  assert.equal(report.status, 'live_plan_failed');
  assert.equal(report.hostileFlee.survived, false);
});

test('advisor live-plan hostile induction uses plugin-tagged fire-resistant zombie near latest bot position', () => {
  const plan = buildHostileInductionPlan({ x: 100.25, y: 64, z: -20.5 }, { x: 4, y: 0, z: -2 });

  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'mcbottest-spawn-zombie-fire-resistant');
  assert.equal(plan.tag, 'f2_live_plan_hostile_1');
  assert.deepEqual(plan.spawn, { x: 104.25, y: 64, z: -22.5 });
  assert.deepEqual(plan.commands, [
    'mcbottest spawn zombie 104.25 64 -22.5 --tag f2_live_plan_hostile_1 --effects fire_resistance:120:1 --no-burn',
  ]);
});

test('advisor live-plan hostile cleanup kills only zombies near the induced spawn', () => {
  const plan = buildHostileCleanupPlan({ x: 205.5, y: 68, z: 476.5 }, 24);

  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'kill-zombies-near');
  assert.deepEqual(plan.origin, { x: 205.5, y: 68, z: 476.5 });
  assert.equal(plan.radius, 24);
  assert.deepEqual(plan.commands, [
    'execute positioned 205.5 68 476.5 run minecraft:kill @e[type=minecraft:zombie,distance=..24]',
  ]);
});

test('advisor live-plan admin response summaries strip minecraft formatting codes', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));

  markHostileCleanup(report, {
    ok: true,
    action: 'kill-zombies-near',
    commandCount: 1,
    responses: [
      {
        command: 'execute positioned 1 2 3 run minecraft:kill @e[type=minecraft:zombie,distance=..4]',
        response: '\u00a76Killed\u00a7c Zombie',
        type: 0,
      },
    ],
  }, new Date('2026-05-24T00:00:02.000Z'));

  assert.equal(report.hostileFlee.cleanup.responses[0].response, 'Killed Zombie');
});

test('advisor live-plan final outcome watchdog records and stops child', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  const stopped = [];
  let wrote = false;

  const watchdog = armFinalOutcomeStopWatchdog({
    report,
    child: { id: 'child' },
    reason: 'advisor-live-plan-final-outcome',
    timeoutMs: 1234,
    writeReport: () => { wrote = true; },
    stopChildFn: (child, reason) => stopped.push({ child, reason }),
    setTimeoutFn: (fn) => {
      fn();
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
    now: () => new Date('2026-05-24T00:00:10.000Z'),
  });

  assert.equal(watchdog.fired, true);
  assert.equal(wrote, true);
  assert.deepEqual(stopped, [{ child: { id: 'child' }, reason: 'advisor-live-plan-final-outcome-watchdog' }]);
  assert.deepEqual(report.diagnostics.finalOutcomeStopWatchdog, {
    triggered: true,
    reason: 'advisor-live-plan-final-outcome',
    timeoutMs: 1234,
    at: '2026-05-24T00:00:10.000Z',
  });
  assert.match(report.diagnostics.failures.join('\n'), /final outcome stop watchdog fired after 1234ms/);
  assert.match(report.plugin.errors.join('\n'), /final outcome stop watchdog fired after 1234ms/);
});

test('advisor live-plan final outcome watchdog can be marked directly for report diagnostics', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));

  const diagnostic = markFinalOutcomeStopWatchdog(
    report,
    'advisor-live-plan-final-outcome',
    5000,
    new Date('2026-05-24T00:00:05.000Z'),
  );

  assert.equal(diagnostic.triggered, true);
  assert.equal(report.diagnostics.finalOutcomeStopWatchdog.timeoutMs, 5000);
  assert.match(report.diagnostics.failures.join('\n'), /advisor-live-plan-final-outcome/);
});
