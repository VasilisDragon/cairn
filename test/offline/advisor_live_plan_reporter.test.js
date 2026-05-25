import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdvisorLivePlanConfig,
  buildHostileCleanupPlan,
  buildHostileInductionPlan,
  createAdvisorLivePlanReport,
  finalizeAdvisorLivePlanReport,
  markHostileCleanup,
  markHostileInduced,
  parseAdvisorLivePlanArgs,
  updateAdvisorLivePlanReportFromRecord,
} from '../../scripts/advisor-live-plan.js';

const REGIME_A_ACCOUNT = Object.freeze({ regime: 'test' });
const REGIME_A_MINECRAFT = Object.freeze({ username: 'MCBot', auth: 'offline' });
const DEEPSEEK_READY = Object.freeze({ apiKey: 'configured' });

test('advisor live-plan args default to F2 gather goal and hostile induction timing', () => {
  const opts = parseAdvisorLivePlanArgs([]);

  assert.equal(opts.goal, 'gather 10 oak logs');
  assert.equal(opts.induceAfterMs, 45000);
  assert.deepEqual(opts.hostileOffset, { x: 4, y: 0, z: 0 });
  assert.equal(opts.hostileCleanupAfterFleeMs, 0);
  assert.equal(opts.hostileCleanupRadius, 24);
  assert.match(opts.reportPath, /reports[\\/]advisor-live-plan\.json$/);
});

test('advisor live-plan args support startup RCON setup fixture options', () => {
  const opts = parseAdvisorLivePlanArgs([
    '--setup-teleport', '201', '68', '476',
    '--setup-clear-item', 'minecraft:oak_log',
    '--cleanup-induced-hostile-after-flee-ms', '2000',
    '--hostile-cleanup-radius', '18',
  ]);

  assert.deepEqual(opts.setupTeleport, { x: 201, y: 68, z: 476 });
  assert.deepEqual(opts.setupClearItems, ['minecraft:oak_log']);
  assert.equal(opts.hostileCleanupAfterFleeMs, 2000);
  assert.equal(opts.hostileCleanupRadius, 18);
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
      MCBOT_RCON_PASSWORD: 'secret',
    },
    account: { regime: 'production' },
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
    argv: ['--goal', 'gather 10 oak logs', '--timeout-ms', '1000'],
    env: {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_ALLOW_DEEPSEEK: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_RCON_PASSWORD: 'secret',
    },
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(result.ok, true);
  assert.equal(result.options.goal, 'gather 10 oak logs');
  assert.equal(result.command.args[0], 'src/index.js');
  assert.equal(result.account.username, 'MCBot');
});

test('advisor live-plan config injects startup delay when setup is requested', () => {
  const result = buildAdvisorLivePlanConfig({
    argv: ['--setup-teleport', '201', '68', '476', '--setup-clear-item', 'minecraft:oak_log'],
    env: {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_ALLOW_DEEPSEEK: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_RCON_PASSWORD: 'secret',
    },
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });

  assert.equal(result.ok, true);
  assert.equal(result.command.env.MCBOT_STARTUP_DELAY_MS, '5000');
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
    action: 'summon-zombie-fire-resistant',
    commandCount: 2,
    spawn: { x: 104, y: 65, z: 100 },
  }, new Date('2026-05-24T00:01:00.000Z'));

  for (const record of [
    { t: '2026-05-24T00:00:01.000Z', evt: 'snapshot', position: { x: 100, y: 65, z: 100, dimension: 'overworld' } },
    { t: '2026-05-24T00:00:02.000Z', evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { t: '2026-05-24T00:00:03.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:04.000Z', evt: 'llm.response', sessionCostUsd: 0.42, callCostUsd: 0.42, model: 'deepseek-v4-pro' },
    { t: '2026-05-24T00:00:05.000Z', evt: 'plan.accepted', steps: 2 },
    { t: '2026-05-24T00:00:06.000Z', evt: 'goal.plan-activation-ok' },
    { t: '2026-05-24T00:00:07.000Z', evt: 'skill.invoke', skill: 'goto' },
    { t: '2026-05-24T00:00:08.000Z', evt: 'skill.result', skill: 'collect' },
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
  assert.equal(report.finalOutcome.reported, true);
  assert.equal(report.cost.usd, 0.42);
  assert.equal(report.costCeilingGuard.verified, true);
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

test('advisor live-plan report rejects queue failure even if a later empty replan says done', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  markHostileInduced(report, { ok: true, action: 'summon-zombie-fire-resistant', commandCount: 2 });

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

test('advisor live-plan report fails if hostile induction never produces flee', () => {
  const runConfig = buildAdvisorLivePlanConfig({
    argv: ['--dry-run'],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  const report = createAdvisorLivePlanReport(runConfig, new Date('2026-05-24T00:00:00.000Z'));
  markHostileInduced(report, { ok: true, action: 'summon-zombie-fire-resistant', commandCount: 2 });
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

test('advisor live-plan hostile induction uses fire-resistant zombie near latest bot position', () => {
  const plan = buildHostileInductionPlan({ x: 100.25, y: 64, z: -20.5 }, { x: 4, y: 0, z: -2 });

  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'summon-zombie-fire-resistant');
  assert.deepEqual(plan.spawn, { x: 104.25, y: 64, z: -22.5 });
  assert.deepEqual(plan.commands, [
    'summon minecraft:zombie 104.25 64 -22.5',
    'effect give @e[type=minecraft:zombie,x=104.25,y=64,z=-22.5,distance=..5,sort=nearest,limit=1] minecraft:fire_resistance 120 1 true',
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
