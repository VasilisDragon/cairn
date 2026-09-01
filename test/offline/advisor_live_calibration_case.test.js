import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildActivationRejectedInductionPlan,
  buildAdvisorLiveCalibrationCaseConfig,
  buildCalibrationInductionPlan,
  buildRecoveryProposalInductionPlan,
  buildStalePlanInductionPlan,
  createAdvisorLiveCalibrationCaseReport,
  createCalibrationEvidenceCase,
  finalizeAdvisorLiveCalibrationCaseReport,
  markCalibrationStartupSetup,
  markCalibrationInduction,
  mergeCalibrationEvidenceCase,
  parseAdvisorLiveCalibrationCaseArgs,
  updateAdvisorLiveCalibrationCaseReportFromRecord,
} from '../../scripts/advisor-live-calibration-case.js';

const REGIME_A_ACCOUNT = Object.freeze({ regime: 'test' });
const REGIME_A_MINECRAFT = Object.freeze({ username: 'MCBot', auth: 'offline' });
const DEEPSEEK_READY = Object.freeze({ apiKey: 'configured' });

function dryRunConfig(argv = []) {
  const result = buildAdvisorLiveCalibrationCaseConfig({
    argv: ['--dry-run', ...argv],
    env: {},
    account: REGIME_A_ACCOUNT,
    minecraft: REGIME_A_MINECRAFT,
    deepseek: DEEPSEEK_READY,
  });
  assert.equal(result.ok, true, result.reason);
  return result;
}

test('advisor live calibration case args default to activation rejected policy', () => {
  const opts = parseAdvisorLiveCalibrationCaseArgs([]);

  assert.equal(opts.caseId, 'activation_rejected_policy');
  assert.equal(opts.goal, 'gather 10 oak logs');
  assert.equal(opts.injectAfterLlmRequestMs, 500);
  assert.equal(opts.positionWaitMs, 30000);
  assert.deepEqual(opts.hostileOffset, { x: 4, y: 0, z: 0 });
  assert.match(opts.reportPath, /reports[\\/]advisor-live-calibration-case\.json$/);
  assert.match(opts.evidencePath, /reports[\\/]advisor-live-calibration-evidence\.json$/);
});

test('advisor live calibration case args support timing and hostile offset overrides', () => {
  const opts = parseAdvisorLiveCalibrationCaseArgs([
    '--inject-after-llm-request-ms', '1500',
    '--position-wait-ms', '10000',
    '--setup-clear-item', 'minecraft:oak_log',
    '--hostile-dx', '2',
    '--hostile-dy', '1',
    '--hostile-dz', '-3',
    '--stale-dx', '9',
    '--stale-dy', '0',
    '--stale-dz', '1',
    '--recovery-damage', '120',
  ]);

  assert.equal(opts.injectAfterLlmRequestMs, 1500);
  assert.equal(opts.positionWaitMs, 10000);
  assert.deepEqual(opts.setupClearItems, ['minecraft:oak_log']);
  assert.deepEqual(opts.hostileOffset, { x: 2, y: 1, z: -3 });
  assert.deepEqual(opts.staleDriftOffset, { x: 9, y: 0, z: 1 });
  assert.equal(opts.recoveryDamage, 120);
});

test('advisor live calibration case config refuses incomplete live gates with exact reasons', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
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

test('advisor live calibration case config enforces private Regime A account shape', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
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

test('advisor live calibration case config accepts private live gates', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
    argv: ['--timeout-ms', '1000', '--startup-delay-ms', '250'],
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

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.options.caseId, 'activation_rejected_policy');
  assert.deepEqual(result.command.args.slice(0, 2), ['--v8-pool-size=1', 'src/index.js']);
  assert.equal(result.command.env.MCBOT_STARTUP_DELAY_MS, '250');
  assert.equal(result.account.username, 'MCBot');
});

test('advisor live calibration case config supports stale plan case', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
    argv: ['--case', 'stale_plan_rejected'],
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

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.options.caseId, 'stale_plan_rejected');
  assert.equal(result.caseDef.proposalClass, 'stale');
  assert.equal(result.caseDef.induction, 'teleport-drift');
});

test('advisor live calibration case config supports unsafe normal work case', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
    argv: ['--case', 'unsafe_normal_work_rejected'],
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

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.options.caseId, 'unsafe_normal_work_rejected');
  assert.equal(result.caseDef.proposalClass, 'unsafe');
  assert.equal(result.caseDef.induction, 'hostile-flee');
});

test('advisor live calibration case config supports bounded recovery case', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
    argv: ['--case', 'recovery_proposal_bounded'],
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

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.options.caseId, 'recovery_proposal_bounded');
  assert.equal(result.caseDef.proposalClass, 'recovery');
  assert.equal(result.caseDef.induction, 'death-recovery-fall');
  assert.equal(result.caseDef.trigger, 'skill.invoke');
});

test('advisor live calibration case config requires raw admin opt-in for startup clear setup', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
    argv: ['--setup-clear-item', 'minecraft:oak_log'],
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

  assert.equal(result.ok, false);
  assert.match(result.reason, /MCBOT_LIVE_ADMIN_RAW_OK=1 required/);
});

test('advisor live calibration case config injects startup delay for setup clear items', () => {
  const result = buildAdvisorLiveCalibrationCaseConfig({
    argv: ['--setup-clear-item', 'minecraft:oak_log'],
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

test('advisor live calibration case report turns activation rejection into sanitized evidence', () => {
  const report = createAdvisorLiveCalibrationCaseReport(
    dryRunConfig(),
    new Date('2026-05-24T00:00:00.000Z'),
  );
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'summon-zombie-fire-resistant',
    commandCount: 2,
    spawn: { x: 104, y: 65, z: 100 },
  }, new Date('2026-05-24T00:00:04.000Z'));

  for (const record of [
    { t: '2026-05-24T00:00:01.000Z', evt: 'snapshot', position: { x: 100, y: 65, z: 100 } },
    { t: '2026-05-24T00:00:02.000Z', evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { t: '2026-05-24T00:00:03.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:05.000Z', evt: 'llm.response', sessionCostUsd: 0.01, callCostUsd: 0.01, model: 'deepseek-v4-pro' },
    { t: '2026-05-24T00:00:06.000Z', evt: 'plan.accepted', steps: 1 },
    {
      t: '2026-05-24T00:00:07.000Z',
      evt: 'goal.plan-activation-rejected',
      reason: 'unsafe snapshot permits only survival skills',
      safetyReasons: ['nearby hostile zombie'],
    },
    { t: '2026-05-24T00:00:08.000Z', evt: 'main.goal-failed', reason: 'advisor plan activation rejected' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report, { endedAt: '2026-05-24T00:00:09.000Z' });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'live_calibration_case_completed');
  assert.equal(report.noApiCall, false);
  assert.equal(report.planner.callMade, true);
  assert.equal(report.planner.schemaValid, true);
  assert.equal(report.activation.accepted, false);
  assert.equal(report.executor.ranSkillCount, 0);
  assert.equal(report.evidenceCase.liveProven, true);
  assert.equal(report.evidenceCase.proposalClass, 'rejected');
  assert.equal(report.evidenceCase.activationBoundary, true);
  assert.equal(report.evidenceCase.noBypass, true);
  assert.match(report.evidenceCase.evidence, /nearby hostile zombie/);
});

test('advisor live calibration case report turns stale activation rejection into sanitized evidence', () => {
  const report = createAdvisorLiveCalibrationCaseReport(
    dryRunConfig(['--case', 'stale_plan_rejected']),
    new Date('2026-05-24T00:00:00.000Z'),
  );
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'teleport-player',
    commandCount: 1,
    destination: { x: 108, y: 65, z: 100 },
  }, new Date('2026-05-24T00:00:04.000Z'));

  for (const record of [
    { t: '2026-05-24T00:00:01.000Z', evt: 'snapshot', position: { x: 100, y: 65, z: 100 } },
    { t: '2026-05-24T00:00:02.000Z', evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { t: '2026-05-24T00:00:03.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:05.000Z', evt: 'llm.response', sessionCostUsd: 0.01, callCostUsd: 0.01, model: 'deepseek-v4-pro' },
    { t: '2026-05-24T00:00:06.000Z', evt: 'plan.accepted', steps: 1 },
    {
      t: '2026-05-24T00:00:07.000Z',
      evt: 'goal.plan-activation-rejected',
      reason: 'stale plan activation: position drift 8 > 2',
      staleReasons: ['position drift 8 > 2'],
    },
    { t: '2026-05-24T00:00:08.000Z', evt: 'main.goal-failed', reason: 'advisor plan activation rejected' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report, { endedAt: '2026-05-24T00:00:09.000Z' });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'live_calibration_case_completed');
  assert.equal(report.evidenceCase.liveProven, true);
  assert.equal(report.evidenceCase.proposalClass, 'stale');
  assert.match(report.evidenceCase.evidence, /position drift 8 > 2/);
  assert.deepEqual(report.evidenceCase.induction.destination, { x: 108, y: 65, z: 100 });
});

test('advisor live calibration case report turns unsafe normal-work rejection into sanitized evidence', () => {
  const report = createAdvisorLiveCalibrationCaseReport(
    dryRunConfig(['--case', 'unsafe_normal_work_rejected']),
    new Date('2026-05-24T00:00:00.000Z'),
  );
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'summon-zombie-fire-resistant',
    commandCount: 2,
    spawn: { x: 104, y: 65, z: 100 },
  }, new Date('2026-05-24T00:00:04.000Z'));

  for (const record of [
    { t: '2026-05-24T00:00:01.000Z', evt: 'snapshot', position: { x: 100, y: 65, z: 100 } },
    { t: '2026-05-24T00:00:02.000Z', evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { t: '2026-05-24T00:00:03.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:05.000Z', evt: 'llm.response', sessionCostUsd: 0.01, callCostUsd: 0.01, model: 'deepseek-v4-pro' },
    { t: '2026-05-24T00:00:06.000Z', evt: 'plan.accepted', steps: 1 },
    {
      t: '2026-05-24T00:00:07.000Z',
      evt: 'goal.plan-activation-rejected',
      reason: 'unsafe snapshot permits only observe/flee/consume, rejected collect: reactive state FLEEING',
      safetyReasons: ['reactive state FLEEING'],
    },
    { t: '2026-05-24T00:00:08.000Z', evt: 'main.goal-failed', reason: 'advisor plan activation rejected' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report, { endedAt: '2026-05-24T00:00:09.000Z' });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'live_calibration_case_completed');
  assert.equal(report.evidenceCase.liveProven, true);
  assert.equal(report.evidenceCase.proposalClass, 'unsafe');
  assert.match(report.evidenceCase.evidence, /reactive state FLEEING/);
  assert.deepEqual(report.evidenceCase.induction.spawn, { x: 104, y: 65, z: 100 });
});

test('advisor live calibration unsafe case fails without unsafe activation reason', () => {
  const report = createAdvisorLiveCalibrationCaseReport(dryRunConfig(['--case', 'unsafe_normal_work_rejected']));
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'summon-zombie-fire-resistant',
    commandCount: 2,
  });

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01 },
    { evt: 'plan.accepted', steps: 1 },
    { evt: 'goal.plan-activation-rejected', reason: 'policy rejected normal work' },
    { evt: 'main.goal-failed', reason: 'plan activation rejected' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report);

  assert.equal(report.ok, false);
  assert.equal(report.evidenceCase.liveProven, false);
});

test('advisor live calibration case report turns bounded recovery into sanitized evidence', () => {
  const report = createAdvisorLiveCalibrationCaseReport(
    dryRunConfig(['--case', 'recovery_proposal_bounded']),
    new Date('2026-05-24T00:00:00.000Z'),
  );
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'death-recovery-fall',
    commandCount: 3,
  }, new Date('2026-05-24T00:00:04.000Z'));

  for (const record of [
    { t: '2026-05-24T00:00:01.000Z', evt: 'snapshot', position: { x: 100, y: 65, z: 100 } },
    { t: '2026-05-24T00:00:02.000Z', evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true, ceilingUsd: 2, currentUsd: 0 } },
    { t: '2026-05-24T00:00:03.000Z', evt: 'llm.request' },
    { t: '2026-05-24T00:00:05.000Z', evt: 'llm.response', sessionCostUsd: 0.01, callCostUsd: 0.01, model: 'deepseek-v4-pro' },
    { t: '2026-05-24T00:00:06.000Z', evt: 'plan.accepted', steps: 1 },
    { t: '2026-05-24T00:00:07.000Z', evt: 'goal.plan-activation-ok' },
    { t: '2026-05-24T00:00:08.000Z', evt: 'skill.invoke', skill: 'collect' },
    {
      t: '2026-05-24T00:00:09.000Z',
      evt: 'death',
      position: { x: 100, y: 65, z: 100 },
      dimension: 'overworld',
      recovery: { action: 'recover_drops', reason: 'death drops are close enough for one recovery attempt' },
    },
    {
      t: '2026-05-24T00:00:10.000Z',
      evt: 'respawn',
      recovery: {
        deathPosition: { x: 100, y: 65, z: 100 },
        deathDimension: 'overworld',
        decision: { action: 'recover_drops', reason: 'death drops are close enough for one recovery attempt' },
      },
      dropRecoverySchedule: {
        ok: true,
        call: { skill: 'recover_drops', params: { x: 100, y: 65, z: 100, dimension: 'overworld' } },
        recovery: { status: 'recovering', attempts: 1 },
      },
    },
    { t: '2026-05-24T00:00:11.000Z', evt: 'skill.invoke', skill: 'recover_drops' },
    { t: '2026-05-24T00:00:12.000Z', evt: 'skill.result', skill: 'recover_drops', ok: true, reason: 'recovered dropped items' },
    { t: '2026-05-24T00:00:13.000Z', evt: 'main.goal-done', reason: 'goal complete' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report, { endedAt: '2026-05-24T00:00:14.000Z' });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'live_calibration_case_completed');
  assert.equal(report.evidenceCase.liveProven, true);
  assert.equal(report.evidenceCase.proposalClass, 'recovery');
  assert.equal(report.evidenceCase.activation.accepted, true);
  assert.deepEqual(report.evidenceCase.executor.skillsExecuted, ['collect', 'recover_drops']);
  assert.equal(report.evidenceCase.recovery.singleAttemptBounded, true);
  assert.equal(report.evidenceCase.recovery.recoverDropsInvokeCount, 1);
  assert.match(report.evidenceCase.evidence, /recoveryAttempts=1/);
});

test('advisor live calibration recovery case fails on repeated recovery attempts', () => {
  const report = createAdvisorLiveCalibrationCaseReport(dryRunConfig(['--case', 'recovery_proposal_bounded']));
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'death-recovery-fall',
    commandCount: 3,
  });

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01 },
    { evt: 'plan.accepted', steps: 1 },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'skill.invoke', skill: 'collect' },
    {
      evt: 'respawn',
      recovery: { decision: { action: 'recover_drops' } },
      dropRecoverySchedule: { ok: true, call: { skill: 'recover_drops' }, recovery: { attempts: 1 } },
    },
    { evt: 'skill.invoke', skill: 'recover_drops' },
    { evt: 'skill.invoke', skill: 'recover_drops' },
    { evt: 'main.goal-done', reason: 'goal complete' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report);

  assert.equal(report.ok, false);
  assert.equal(report.evidenceCase.liveProven, false);
  assert.equal(report.evidenceCase.recovery.singleAttemptBounded, false);
  assert.equal(report.evidenceCase.recovery.recoverDropsInvokeCount, 2);
});

test('advisor live calibration stale case fails without stale activation reason', () => {
  const report = createAdvisorLiveCalibrationCaseReport(dryRunConfig(['--case', 'stale_plan_rejected']));
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'teleport-player',
    commandCount: 1,
  });

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01 },
    { evt: 'plan.accepted', steps: 1 },
    { evt: 'goal.plan-activation-rejected', reason: 'unsafe snapshot permits only survival skills' },
    { evt: 'main.goal-failed', reason: 'plan activation rejected' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report);

  assert.equal(report.ok, false);
  assert.equal(report.evidenceCase.liveProven, false);
});

test('advisor live calibration case report requires requested startup setup to complete', () => {
  const runConfig = dryRunConfig(['--setup-clear-item', 'minecraft:oak_log']);
  const report = createAdvisorLiveCalibrationCaseReport(runConfig);
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'summon-zombie-fire-resistant',
    commandCount: 2,
  });

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01 },
    { evt: 'plan.accepted', steps: 1 },
    { evt: 'goal.plan-activation-rejected', reason: 'stale plan activation: reactive state changed NORMAL -> FLEEING' },
    { evt: 'main.goal-failed', reason: 'plan activation rejected' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report);
  assert.equal(report.ok, false);

  markCalibrationStartupSetup(report, [{
    ok: true,
    dryRun: true,
    action: 'raw',
    commands: ['minecraft:clear MCBot minecraft:oak_log'],
  }]);
  report.diagnostics.failures = [];
  finalizeAdvisorLiveCalibrationCaseReport(report);
  assert.equal(report.ok, true);
  assert.equal(report.setup.completed, true);
});

test('advisor live calibration case fails if a skill runs after the accepted plan', () => {
  const report = createAdvisorLiveCalibrationCaseReport(dryRunConfig());
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'summon-zombie-fire-resistant',
    commandCount: 2,
  });

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01 },
    { evt: 'plan.accepted', steps: 1 },
    { evt: 'goal.plan-activation-ok' },
    { evt: 'skill.invoke', skill: 'collect' },
    { evt: 'main.goal-done', reason: 'goal complete' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report);

  assert.equal(report.ok, false);
  assert.equal(report.evidenceCase.liveProven, false);
  assert.equal(report.evidenceCase.noBypass, false);
  assert.equal(report.evidenceCase.executor.ranSkillCount, 1);
});

test('advisor live calibration case fails if the accepted proposal has zero steps', () => {
  const report = createAdvisorLiveCalibrationCaseReport(dryRunConfig());
  markCalibrationInduction(report, {
    ok: true,
    dryRun: true,
    action: 'summon-zombie-fire-resistant',
    commandCount: 2,
  });

  for (const record of [
    { evt: 'llm.costCeilingGuard', costCeilingGuard: { verified: true } },
    { evt: 'llm.request' },
    { evt: 'llm.response', sessionCostUsd: 0.01 },
    { evt: 'plan.accepted', steps: 0 },
    { evt: 'goal.plan-activation-rejected', reason: 'stale plan activation: reactive state changed NORMAL -> FLEEING' },
    { evt: 'main.goal-failed', reason: 'plan activation rejected' },
  ]) {
    updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
  }

  finalizeAdvisorLiveCalibrationCaseReport(report);

  assert.equal(report.ok, false);
  assert.equal(report.evidenceCase.liveProven, false);
  assert.equal(report.evidenceCase.planner.acceptedSteps, 0);
  assert.match(report.evidenceCase.evidence, /acceptedSteps=0/);
});

test('advisor live calibration case induction uses fire-resistant zombie near latest position', () => {
  const plan = buildActivationRejectedInductionPlan({ x: 100.5, y: 64, z: -20 }, { x: 3, y: 1, z: -2 });

  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'summon-zombie-fire-resistant');
  assert.deepEqual(plan.spawn, { x: 103.5, y: 65, z: -22 });
  assert.deepEqual(plan.commands, [
    'summon minecraft:zombie 103.5 65 -22',
    'effect give @e[type=minecraft:zombie,x=103.5,y=65,z=-22,distance=..5,sort=nearest,limit=1] minecraft:fire_resistance 120 1 true',
  ]);
});

test('advisor live calibration stale induction teleports MCBot far enough to trip staleness', () => {
  const plan = buildStalePlanInductionPlan({ x: 100.5, y: 64, z: -20 }, { x: 8, y: 0, z: 1 });

  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'teleport-player');
  assert.deepEqual(plan.destination, { x: 108.5, y: 64, z: -19 });
  assert.deepEqual(plan.commands, ['minecraft:tp MCBot 108.5 64 -19']);
});

test('advisor live calibration recovery induction uses bounded fall-damage fixture', () => {
  const plan = buildRecoveryProposalInductionPlan(120);

  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'death-recovery-fall');
  assert.deepEqual(plan.commands, [
    'gamerule keep_inventory false',
    'gamerule fall_damage true',
    'minecraft:damage MCBot 120 minecraft:fall',
  ]);
});

test('advisor live calibration induction plan dispatches by case definition', () => {
  const hostileConfig = dryRunConfig();
  const staleConfig = dryRunConfig(['--case', 'stale_plan_rejected']);
  const unsafeConfig = dryRunConfig(['--case', 'unsafe_normal_work_rejected']);
  const recoveryConfig = dryRunConfig(['--case', 'recovery_proposal_bounded']);

  assert.equal(buildCalibrationInductionPlan(hostileConfig, { x: 1, y: 2, z: 3 }).action, 'summon-zombie-fire-resistant');
  assert.equal(buildCalibrationInductionPlan(staleConfig, { x: 1, y: 2, z: 3 }).action, 'teleport-player');
  assert.equal(buildCalibrationInductionPlan(unsafeConfig, { x: 1, y: 2, z: 3 }).action, 'summon-zombie-fire-resistant');
  assert.equal(buildCalibrationInductionPlan(recoveryConfig, { x: 1, y: 2, z: 3 }).action, 'death-recovery-fall');
});

test('advisor live calibration evidence merge preserves existing cases', () => {
  const existing = {
    updatedAt: '2026-05-23T00:00:00.000Z',
    cases: {
      stale_plan_rejected: { proposalClass: 'stale', liveProven: true },
    },
  };
  const evidence = createCalibrationEvidenceCase({
    ok: true,
    caseId: 'activation_rejected_policy',
    proposalClass: 'rejected',
    planner: { callMade: true, schemaValid: true },
    activation: { accepted: false, reason: 'unsafe', safetyReasons: [], staleReasons: [] },
    executor: { ranSkillCount: 0, skillsExecuted: [] },
    induction: { completed: true, action: 'summon-zombie-fire-resistant', spawn: { x: 1, y: 2, z: 3 } },
    cost: { usd: 0.01 },
  });

  const merged = mergeCalibrationEvidenceCase(
    existing,
    'activation_rejected_policy',
    evidence,
    '2026-05-24T00:00:00.000Z',
  );

  assert.equal(merged.updatedAt, '2026-05-24T00:00:00.000Z');
  assert.equal(merged.cases.stale_plan_rejected.proposalClass, 'stale');
  assert.equal(merged.cases.activation_rejected_policy.proposalClass, 'rejected');
  assert.equal(merged.cases.activation_rejected_policy.liveProven, true);
  assert.equal(merged.calibrationCaseLedger.schemaVersion, 2);
  assert.deepEqual(merged.calibrationCaseLedger.caseIds, ['activation_rejected_policy', 'stale_plan_rejected']);
  assert.deepEqual(merged.calibrationCaseLedger.classifiedCaseIds, ['activation_rejected_policy']);
  assert.deepEqual(merged.calibrationCaseLedger.unclassifiedCaseIds, ['stale_plan_rejected']);
  assert.equal(merged.calibrationCaseLedger.classificationCycleComplete, false);
  assert.match(merged.calibrationCaseLedger.casesDigestSha256, /^[a-f0-9]{64}$/);
  assert.match(merged.calibrationCaseLedger.ledgerDigestSha256, /^[a-f0-9]{64}$/);
});
