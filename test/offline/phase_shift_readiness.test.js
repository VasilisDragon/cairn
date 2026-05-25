import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePhaseShiftReadiness,
  renderPhaseShiftReadiness,
} from '../../src/goal/phase_shift_readiness.js';

function dryRunReport() {
  return {
    ok: true,
    fixtureCount: 9,
    summary: {
      unexpectedOutcomes: 0,
      promptBudgetViolations: 0,
      coverageViolations: 0,
      categoryCounts: {
        valid_plan: 1,
        invalid_response: 2,
        mission_plan: 1,
        safety_gate: 2,
        combat_gate: 1,
        staleness_gate: 2,
      },
      calibrationTierCounts: {
        smoke: 1,
        world_model: 1,
        survival: 1,
        safety_rejection: 1,
        combat_prep: 1,
        long_horizon_fixture: 1,
      },
    },
    firstCallReadiness: {
      status: 'ready_for_gated_deepseek_dry_run',
    },
  };
}

function firstLiveCallReport(overrides = {}) {
  return {
    ok: true,
    noApiCall: false,
    status: 'captured_first_call_responses',
    requestCount: 1,
    capture: {
      status: 'captured_first_call_responses',
      wroteResponseFile: true,
      responseCount: 1,
      responseChars: [
        { id: 'recorded_live_smoke_observe', chars: 456, metricsReady: true },
      ],
      failures: [],
    },
    strictValidationPreview: {
      replayOk: true,
      metricsReplayOk: true,
    },
    ...overrides,
  };
}

function firstLiveCallReplayBackedReport(overrides = {}) {
  return {
    ok: true,
    noApiCall: true,
    status: 'capture_execution_not_requested',
    requestCount: 1,
    responseOutput: {
      exists: true,
      responseCount: 1,
      nonEmptyResponseCount: 1,
    },
    captureGuard: {
      ok: true,
    },
    responseReplay: {
      ok: true,
      noApiCall: true,
      status: 'validated_model_responses',
      expectedCount: 1,
      presentCount: 1,
      missingCount: 0,
      unknownCount: 0,
      duplicateCount: 0,
      unexpectedOutcomes: 0,
      promptBudgetViolations: 0,
      requestFingerprintReadyCount: 1,
      requestFingerprintMismatchCount: 0,
      responseMetricsReadyCount: 1,
      summary: {
        responseMetrics: {
          latencyMs: { count: 1, max: 4755 },
          tokenUsage: { count: 1, totalTokens: 2377 },
        },
      },
      results: [
        {
          expectationMet: true,
          requestFingerprintStatus: 'matched',
          responseMetrics: {
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            latencyMs: 4755,
            totalTokens: 2377,
          },
        },
      ],
    },
    ...overrides,
  };
}

function firstLivePlanReport(overrides = {}) {
  return {
    ok: true,
    noApiCall: false,
    status: 'live_plan_completed',
    accountRegime: 'test',
    account: {
      username: 'MCBot',
      auth: 'offline',
    },
    planner: {
      callMade: true,
      schemaValid: true,
      acceptedSteps: 2,
    },
    activation: {
      accepted: true,
    },
    executor: {
      ranSkillCount: 2,
      failedSkillCount: 0,
    },
    finalOutcome: {
      reported: true,
    },
    cost: {
      usd: 0.42,
    },
    costCeilingGuard: {
      verified: true,
    },
    hostileFlee: {
      survived: true,
    },
    diagnostics: {
      failures: [],
    },
    ...overrides,
  };
}

test('phase-shift readiness trips on F1 plus F2 evidence without requiring optional strict gates', () => {
  const report = evaluatePhaseShiftReadiness({
    firstLiveCall: firstLiveCallReport(),
    firstLivePlan: firstLivePlanReport(),
  });

  assert.equal(report.ready, true);
  assert.equal(report.currentPhase, 'sota_track');
  assert.equal(report.noDeepSeekApiCall, false);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.nextWorkstream.id, 'deepseek_dry_run_calibration');
  assert.ok(report.nextWorkstream.achievementCriteria.some((entry) => entry.includes('strict replay')));
  assert.equal(report.transition.status, 'phase_shift_ready');
  assert.equal(report.transition.nextAction, 'deepseek_dry_run_calibration');
  assert.ok(report.gates.some((entry) => entry.id === 'deepseek_default_off' && entry.satisfied));
  assert.ok(report.gates.some((entry) => (
    entry.id === 'f1_first_live_call'
      && entry.satisfied
      && entry.status === 'live-proven'
  )));
  assert.ok(report.gates.some((entry) => (
    entry.id === 'f2_first_live_plan'
      && entry.satisfied
      && entry.status === 'live-proven'
  )));
  assert.equal(report.strictReadiness.ready, false);
  assert.ok(report.strictReadiness.blockers.some((entry) => entry.id === 'advisor_queue_boundary'));
});

test('phase-shift optional strict readiness still reports audit gates when supplied', () => {
  const report = evaluatePhaseShiftReadiness({
    firstLiveCall: firstLiveCallReport(),
    firstLivePlan: firstLivePlanReport(),
    queueProposalBoundary: true,
    advisorDryRun: dryRunReport(),
    liveEvidence: {
      hostileEscalation: { liveProven: true, evidence: 'J live log passed' },
      pvmEscalation: { documentedBlocked: true, reason: 'MCBOT_RCON_PASSWORD absent in this process; exact K command documented' },
    },
    deterministicBaselinePassed: true,
    docs: {
      goalNamesPhaseShift: true,
      statusNamesPhaseShift: true,
    },
  });

  assert.equal(report.ready, true);
  assert.equal(report.strictReadiness.ready, true);
  const dryRunGate = report.strictReadiness.gates.find((entry) => entry.id === 'advisor_dry_run_benchmark');
  assert.match(dryRunGate.evidence, /coverageViolations=0/);
  assert.match(dryRunGate.evidence, /calibrationTiers=smoke,world_model,survival,safety_rejection,combat_prep,long_horizon_fixture/);
  assert.ok(report.nextWorkstream.achievementCriteria.some((entry) => entry.includes('calibration-tier coverage')));
});

test('phase-shift readiness accepts replay-backed F1 evidence after captured response is validated', () => {
  const report = evaluatePhaseShiftReadiness({
    firstLiveCall: firstLiveCallReplayBackedReport(),
    firstLivePlan: firstLivePlanReport(),
  });

  assert.equal(report.ready, true);
  assert.equal(report.noDeepSeekApiCall, false);
  const f1 = report.gates.find((entry) => entry.id === 'f1_first_live_call');
  assert.equal(f1.satisfied, true);
  assert.equal(f1.status, 'live-proven');
  assert.match(f1.evidence, /status=validated_model_responses/);
  assert.match(f1.evidence, /model=deepseek-v4-pro/);
  assert.match(f1.evidence, /totalTokens=2377/);
});

test('phase-shift readiness rejects false-green F2 reports with skill failures', () => {
  const report = evaluatePhaseShiftReadiness({
    firstLiveCall: firstLiveCallReplayBackedReport(),
    firstLivePlan: firstLivePlanReport({
      executor: {
        ranSkillCount: 1,
        failedSkillCount: 1,
      },
      diagnostics: {
        failures: ['skill failure: collect: skill threw: skill timed out'],
      },
    }),
  });

  assert.equal(report.ready, false);
  const f2 = report.gates.find((entry) => entry.id === 'f2_first_live_plan');
  assert.equal(f2.satisfied, false);
  assert.equal(f2.status, 'pending');
  assert.match(f2.evidence, /failedSkills=1/);
  assert.match(f2.evidence, /failures=1/);
});

test('phase-shift readiness reports F1 and F2 blockers while keeping workstreams queued', () => {
  const report = evaluatePhaseShiftReadiness({
    queueProposalBoundary: true,
    advisorDryRun: dryRunReport(),
    deterministicBaselinePassed: false,
    docs: {
      goalNamesPhaseShift: true,
      statusNamesPhaseShift: false,
    },
  });

  assert.equal(report.ready, false);
  assert.equal(report.currentPhase, 'deterministic_gate_closure');
  assert.ok(report.blockers.some((entry) => entry.id === 'f1_first_live_call'));
  assert.ok(report.blockers.some((entry) => entry.id === 'f2_first_live_plan'));
  assert.ok(report.gates.some((entry) => (
    entry.id === 'f1_first_live_call'
      && entry.satisfied === false
      && entry.status === 'pending'
  )));
  assert.ok(report.gates.some((entry) => (
    entry.id === 'f2_first_live_plan'
      && entry.satisfied === false
      && entry.status === 'pending'
  )));
  assert.ok(report.strictReadiness.blockers.some((entry) => entry.id === 'j_hostile_escalation'));
  assert.ok(report.strictReadiness.blockers.some((entry) => entry.id === 'k_pvm_escalation'));
  assert.ok(report.strictReadiness.blockers.some((entry) => entry.id === 'deterministic_baseline'));
  assert.ok(report.strictReadiness.blockers.some((entry) => entry.id === 'status_docs_current'));
  assert.equal(report.nextWorkstream, null);
  assert.equal(report.transition.status, 'deterministic_gate_closure');
  assert.match(report.transition.nextAction, /^clear gate:/);
  assert.ok(report.workstreams.some((entry) => entry.id === 'combat_ladder'));
});

test('phase-shift renderer summarizes gates and post-gate tracks', () => {
  const text = renderPhaseShiftReadiness(evaluatePhaseShiftReadiness({
    firstLiveCall: firstLiveCallReport(),
    firstLivePlan: firstLivePlanReport(),
    queueProposalBoundary: true,
    advisorDryRun: dryRunReport(),
    liveEvidence: {
      hostileEscalation: { documentedBlocked: true, reason: 'RCON env missing; exact J command documented' },
      pvmEscalation: { documentedBlocked: true, reason: 'RCON env missing; exact K command documented' },
    },
    deterministicBaselinePassed: true,
    docs: {
      goalNamesPhaseShift: true,
      statusNamesPhaseShift: true,
    },
  }));

  assert.match(text, /# Phase Shift Readiness/);
  assert.match(text, /ready for SOTA track: yes/);
  assert.match(text, /no DeepSeek API call made: no/);
  assert.match(text, /F1 first live frontier-model call/);
  assert.match(text, /F2 first live private-server plan/);
  assert.match(text, /DeepSeek off by default/);
  assert.match(text, /Optional Strict Readiness/);
  assert.match(text, /calibrationTiers=smoke,world_model,survival,safety_rejection,combat_prep,long_horizon_fixture/);
  assert.match(text, /deepseek_dry_run_calibration/);
  assert.match(text, /Transition Rule/);
  assert.match(text, /stop broad deterministic substrate polishing/);
  assert.match(text, /done when: first-call request pack/);
  assert.match(text, /done when: advisor prompt size, JSON validity, skill validity, activation acceptance, rejection behavior, and calibration-tier coverage/);
  assert.match(text, /publication_track/);
  assert.doesNotMatch(text, /sk-/);
});
