import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_CALIBRATION_CASES,
  buildAdvisorLiveCalibrationReport,
  parseAdvisorLiveCalibrationArgs,
  renderAdvisorLiveCalibration,
} from '../../scripts/advisor-live-calibration.js';

function acceptedLivePlan() {
  return {
    ok: true,
    noApiCall: false,
    status: 'live_plan_completed',
    accountRegime: 'test',
    account: { username: 'MCBot', auth: 'offline' },
    planner: { callMade: true, schemaValid: true, acceptedSteps: 1 },
    activation: { accepted: true },
    executor: {
      ranSkillCount: 1,
      failedSkillCount: 0,
      skillsExecuted: ['collect'],
    },
    finalOutcome: { reported: true, ok: true },
    cost: { usd: 0.0068 },
    costCeilingGuard: { verified: true },
    hostileFlee: { survived: true },
    diagnostics: { failures: [] },
  };
}

function evidenceCase(proposalClass, extra = {}) {
  const base = {
    liveProven: true,
    proposalClass,
    evidence: `${proposalClass} evidence`,
    planner: { callMade: true, schemaValid: true, acceptedSteps: 1 },
    activationBoundary: true,
    skillBoundary: true,
    reactiveAuthority: true,
    noBypass: true,
    activation: { accepted: false, reason: `${proposalClass} rejected by activation` },
    executor: { ranSkillCount: 0, skillsExecuted: [] },
  };
  return {
    ...base,
    ...extra,
    activation: { ...base.activation, ...(extra.activation || {}) },
    executor: { ...base.executor, ...(extra.executor || {}) },
  };
}

test('advisor live calibration cases encode the required proposal classes', () => {
  assert.deepEqual(
    LIVE_CALIBRATION_CASES.map((entry) => entry.proposalClass),
    ['accepted', 'rejected', 'stale', 'unsafe', 'recovery'],
  );
});

test('advisor live calibration args keep default report paths and support overrides', () => {
  const opts = parseAdvisorLiveCalibrationArgs([
    '--live-plan',
    'reports/custom-live-plan.json',
    '--evidence',
    'reports/custom-evidence.json',
    '--json',
    'reports/custom.json',
    '--markdown',
    'reports/custom.md',
    '--dry-run',
  ]);

  assert.match(opts.livePlanPath, /reports[\\/]custom-live-plan\.json$/);
  assert.match(opts.evidencePath, /reports[\\/]custom-evidence\.json$/);
  assert.match(opts.jsonReportPath, /reports[\\/]custom\.json$/);
  assert.match(opts.markdownReportPath, /reports[\\/]custom\.md$/);
  assert.equal(opts.dryRun, true);
});

test('advisor live calibration recognizes accepted F2 evidence without overclaiming missing classes', () => {
  const report = buildAdvisorLiveCalibrationReport({
    livePlanReport: acceptedLivePlan(),
    generatedAt: '2026-05-24T00:00:00.000Z',
  });

  assert.equal(report.noApiCall, true);
  assert.equal(report.ok, false);
  assert.equal(report.status, 'live_calibration_pending');
  assert.deepEqual(report.summary.liveProvenClasses, ['accepted']);
  assert.deepEqual(report.summary.pendingClasses, ['rejected', 'stale', 'unsafe', 'recovery']);
  assert.equal(report.cases.find((entry) => entry.id === 'accepted_private_plan').status, 'live-proven');
  assert.match(report.nextAction, /activation_rejected_policy/);
});

test('advisor live calibration requires class-specific stale unsafe and recovery evidence', () => {
  const report = buildAdvisorLiveCalibrationReport({
    livePlanReport: acceptedLivePlan(),
    evidenceReport: {
      cases: {
        activation_rejected_policy: evidenceCase('rejected', {
          activation: { accepted: false, reason: 'proposal rejected by policy' },
        }),
        stale_plan_rejected: evidenceCase('stale', {
          activation: { accepted: false, reason: 'stale plan activation: position changed' },
        }),
        unsafe_normal_work_rejected: evidenceCase('unsafe', {
          activation: { accepted: false, reason: 'unsafe snapshot permits only survival skills' },
        }),
        recovery_proposal_bounded: evidenceCase('recovery', {
          activation: { accepted: true, reason: 'accepted recovery' },
          executor: { ranSkillCount: 1, skillsExecuted: ['recover_drops'] },
          recovery: { singleAttemptBounded: true },
        }),
      },
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'live_calibration_complete');
  assert.deepEqual(report.summary.pendingClasses, []);
  assert.equal(report.safety.allLiveEvidenceNoBypass, true);
  assert.equal(report.nextAction, 'advance_to_benchmark_ladder');
});

test('advisor live calibration fails closed for weak sanitized evidence', () => {
  const report = buildAdvisorLiveCalibrationReport({
    livePlanReport: acceptedLivePlan(),
    evidenceReport: {
      cases: {
        stale_plan_rejected: evidenceCase('stale', {
          evidence: 'generic rejection evidence',
          activation: { accepted: false, reason: 'generic rejection' },
        }),
        recovery_proposal_bounded: evidenceCase('recovery', {
          activation: { accepted: true },
          executor: { ranSkillCount: 1, skillsExecuted: ['goto'] },
          recovery: { singleAttemptBounded: false },
        }),
      },
    },
  });

  assert.equal(report.ok, false);
  assert.match(
    report.cases.find((entry) => entry.id === 'stale_plan_rejected').missing.join('\n'),
    /stale activation reason/,
  );
  assert.match(
    report.cases.find((entry) => entry.id === 'recovery_proposal_bounded').missing.join('\n'),
    /recover_drops skill evidence/,
  );
});

test('advisor live calibration requires rejected evidence to include a non-empty proposal', () => {
  const report = buildAdvisorLiveCalibrationReport({
    livePlanReport: acceptedLivePlan(),
    evidenceReport: {
      cases: {
        activation_rejected_policy: evidenceCase('rejected', {
          planner: { callMade: true, schemaValid: true, acceptedSteps: 0 },
          activation: { accepted: false, reason: 'unsafe snapshot permits only survival skills' },
        }),
      },
    },
  });

  assert.equal(report.ok, false);
  assert.match(
    report.cases.find((entry) => entry.id === 'activation_rejected_policy').missing.join('\n'),
    /planner\.acceptedSteps>=1/,
  );
});

test('advisor live calibration markdown avoids claiming pending cases are proven', () => {
  const report = buildAdvisorLiveCalibrationReport({
    livePlanReport: acceptedLivePlan(),
    generatedAt: '2026-05-24T00:00:00.000Z',
  });
  const markdown = renderAdvisorLiveCalibration(report);

  assert.match(markdown, /Status: live_calibration_pending/);
  assert.match(markdown, /accepted_private_plan/);
  assert.match(markdown, /unsafe_normal_work_rejected/);
  assert.doesNotMatch(markdown, /advance_to_benchmark_ladder/);
});
