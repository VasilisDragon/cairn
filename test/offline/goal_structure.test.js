import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CURRENT_GOAL_STRUCTURE,
  PHASE_SHIFT_EXECUTION_CHECKPOINTS,
  SOTA_TRACK_OUTCOME_TARGETS,
  evaluateCurrentGoalWorkPolicy,
  resolveCurrentGoalState,
} from '../../src/goal/current_goal.js';
import { evaluatePhaseShiftReadiness } from '../../src/goal/phase_shift_readiness.js';

function readyPhaseShiftReport() {
  return evaluatePhaseShiftReadiness({
    firstLiveCall: firstLiveCallReport(),
    firstLivePlan: firstLivePlanReport(),
    queueProposalBoundary: true,
    advisorDryRun: {
      ok: true,
      fixtureCount: 9,
      summary: {
        unexpectedOutcomes: 0,
        promptBudgetViolations: 0,
        coverageViolations: 0,
      },
    },
    liveEvidence: {
      hostileEscalation: { documentedBlocked: true, reason: 'J command documented for private server' },
      pvmEscalation: { documentedBlocked: true, reason: 'K command documented for private server' },
    },
    deterministicBaselinePassed: true,
    docs: {
      goalNamesPhaseShift: true,
      statusNamesPhaseShift: true,
    },
  });
}

function firstLiveCallReport() {
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
    },
    strictValidationPreview: {
      replayOk: true,
      metricsReplayOk: true,
    },
  };
}

function firstLivePlanReport() {
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
  };
}

test('current goal structure preserves the ordered phase-shift workstreams', () => {
  assert.equal(CURRENT_GOAL_STRUCTURE.id, 'deterministic_autonomy_v1');
  assert.deepEqual(
    CURRENT_GOAL_STRUCTURE.orderedPostGateWorkstreams.map((workstream) => workstream.id),
    [
      'deepseek_dry_run_calibration',
      'deepseek_gated_live_calibration',
      'benchmark_ladder',
      'long_horizon_missions',
      'combat_ladder',
      'viewer_operator_track',
      'publication_track',
    ],
  );
  assert.ok(CURRENT_GOAL_STRUCTURE.invariants.some((invariant) => invariant.includes('DeepSeek remains opt-in')));
  assert.equal(CURRENT_GOAL_STRUCTURE.phaseShiftMandate.sourceReport, 'reports/phase-shift-readiness.md');
  assert.ok(CURRENT_GOAL_STRUCTURE.phaseShiftMandate.whenReady.includes('SOTA track'));
  assert.ok(CURRENT_GOAL_STRUCTURE.phaseShiftMandate.prohibitedWhenReady.some(
    (entry) => entry.includes('broad deterministic substrate polishing'),
  ));
  assert.ok(CURRENT_GOAL_STRUCTURE.orderedPostGateWorkstreams.every(
    (workstream) => Array.isArray(workstream.achievementCriteria) && workstream.achievementCriteria.length >= 3,
  ));
  assert.ok(CURRENT_GOAL_STRUCTURE.phaseShiftMandate.achievementDefinition.includes('DeepSeek-guided'));
  assert.ok(CURRENT_GOAL_STRUCTURE.phaseShiftMandate.checkpointRule.includes('SOTA outcome target'));
  assert.deepEqual(
    CURRENT_GOAL_STRUCTURE.phaseShiftExecutionPlan.map((checkpoint) => checkpoint.id),
    PHASE_SHIFT_EXECUTION_CHECKPOINTS.map((checkpoint) => checkpoint.id),
  );
});

test('docs include authorized-use and scope framing', () => {
  const doc = fs.readFileSync(new URL('../../docs/authorized-use-and-scope.md', import.meta.url), 'utf8');

  assert.match(doc, /private servers/);
  assert.match(doc, /not a guarantee of undetectability/);
  assert.match(doc, /local-first/);
});

test('current goal structure encodes SOTA outcome targets beyond the workstream order', () => {
  assert.deepEqual(
    SOTA_TRACK_OUTCOME_TARGETS.map((target) => target.id),
    [
      'deepseek_orchestrated_private_server_autonomy',
      'repeatable_benchmark_ladder',
      'long_horizon_mission_reliability',
      'advanced_private_combat_ladder',
      'operator_viewer_and_handoff_track',
      'publication_ready_evidence',
    ],
  );
  assert.ok(SOTA_TRACK_OUTCOME_TARGETS.every(
    (target) => Array.isArray(target.evidenceRequired) && target.evidenceRequired.length >= 3,
  ));
  assert.ok(SOTA_TRACK_OUTCOME_TARGETS.find(
    (target) => target.id === 'advanced_private_combat_ladder',
  ).evidenceRequired.some((entry) => entry.includes('kill-aura')));
  assert.ok(SOTA_TRACK_OUTCOME_TARGETS.find(
    (target) => target.id === 'operator_viewer_and_handoff_track',
  ).evidenceRequired.some((entry) => entry.includes('viewer-first oversight')));
  assert.ok(SOTA_TRACK_OUTCOME_TARGETS.find(
    (target) => target.id === 'operator_viewer_and_handoff_track',
  ).evidenceRequired.every((entry) => !/proxy/i.test(entry)));
});

test('current goal structure encodes the phase-shift execution checkpoint plan', () => {
  assert.deepEqual(
    PHASE_SHIFT_EXECUTION_CHECKPOINTS.map((checkpoint) => checkpoint.id),
    [
      'phase_shift_gate_locked',
      'f3_five_response_calibration',
      'f4_sota_track_entry',
      'private_live_advisor_entry',
    ],
  );
  assert.ok(PHASE_SHIFT_EXECUTION_CHECKPOINTS.every(
    (checkpoint) => checkpoint.workstreamId
      && Array.isArray(checkpoint.outcomeTargetIds)
      && checkpoint.outcomeTargetIds.length >= 1
      && Array.isArray(checkpoint.entryEvidence)
      && checkpoint.entryEvidence.length >= 1
      && Array.isArray(checkpoint.exitEvidence)
      && checkpoint.exitEvidence.length >= 2,
  ));
  assert.ok(PHASE_SHIFT_EXECUTION_CHECKPOINTS.find(
    (checkpoint) => checkpoint.id === 'f3_five_response_calibration',
  ).entryEvidence.some((entry) => entry.includes('F1 single-response capture')));
  assert.ok(PHASE_SHIFT_EXECUTION_CHECKPOINTS.find(
    (checkpoint) => checkpoint.id === 'f4_sota_track_entry',
  ).entryEvidence.some((entry) => entry.includes('F3 five-response calibration')));
  assert.ok(PHASE_SHIFT_EXECUTION_CHECKPOINTS.find(
    (checkpoint) => checkpoint.id === 'private_live_advisor_entry',
  ).exitEvidence.some((entry) => entry.includes('reactive survival')));
});

test('ready phase-shift report resolves the current goal into SOTA-track work', () => {
  const state = resolveCurrentGoalState(readyPhaseShiftReport());

  assert.equal(state.activePhase, 'sota_track');
  assert.equal(state.phaseShiftReady, true);
  assert.equal(state.stopBroadPolishing, true);
  assert.equal(state.nextAction, 'regenerate_five_response_calibration_from_real_f1_f2_data');
  assert.equal(state.currentWorkstream.id, 'deepseek_dry_run_calibration');
  assert.ok(state.phaseShiftMandate.workstreamRule.includes('priority order'));
  assert.ok(state.currentWorkstreamExitCriteria.some((criterion) => criterion.includes('strict replay')));
  assert.ok(state.nextQueuedWorkstreams.some((workstream) => workstream.id === 'benchmark_ladder'));
  assert.ok(state.allowedWorkKinds.includes('direct benchmark blockers'));
  assert.ok(state.disallowedWorkKinds.some((kind) => kind.includes('broad deterministic substrate polishing')));
  assert.ok(state.invariants.some((invariant) => invariant.includes('planner-only')));
  assert.ok(state.sotaTrackOutcomeTargets.some(
    (target) => target.id === 'deepseek_orchestrated_private_server_autonomy',
  ));
  assert.ok(state.sotaTrackOutcomeTargets.some(
    (target) => target.id === 'publication_ready_evidence',
  ));
  assert.equal(state.currentPhaseShiftCheckpoint.id, 'f3_five_response_calibration');
  assert.equal(state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'phase_shift_gate_locked',
  ).status, 'complete');
  assert.equal(state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'f3_five_response_calibration',
  ).status, 'active');
  assert.equal(state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'private_live_advisor_entry',
  ).status, 'queued');
});

test('current goal advances to F4 entry when F3 five-response calibration evidence is green', () => {
  const state = resolveCurrentGoalState(readyPhaseShiftReport(), {
    firstCallResponseReplay: {
      ok: true,
      status: 'validated_model_responses',
      presentCount: 5,
      responseMetricsIncompleteCount: 0,
    },
    responseCaptureGuard: {
      ok: true,
    },
  });

  const f3Checkpoint = state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'f3_five_response_calibration',
  );
  const f4Checkpoint = state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'f4_sota_track_entry',
  );

  assert.equal(state.currentPhaseShiftCheckpoint.id, 'f4_sota_track_entry');
  assert.equal(state.nextAction, 'finish_f4_sota_track_entry_after_f3');
  assert.equal(f3Checkpoint.status, 'complete');
  assert.match(f3Checkpoint.completionReason, /F3 five-response calibration passed/);
  assert.match(f3Checkpoint.completionEvidence, /F3 five-response replay/);
  assert.equal(f4Checkpoint.status, 'active');
  assert.match(f4Checkpoint.completionReason, /F4 SOTA-track entry evidence is not complete/);
});

test('current goal next action uses F3 calibration blocker when F3 is active', () => {
  const state = resolveCurrentGoalState(readyPhaseShiftReport(), {
    firstCallResponseReplay: {
      ok: false,
      status: 'pending_model_responses',
      presentCount: 1,
      responseMetricsIncompleteCount: 1,
    },
    responseCaptureGuard: { ok: true },
  });

  const f3Checkpoint = state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'f3_five_response_calibration',
  );

  assert.equal(state.currentPhaseShiftCheckpoint.id, 'f3_five_response_calibration');
  assert.equal(state.nextAction, 'regenerate_five_response_calibration_from_real_f1_f2_data');
  assert.equal(f3Checkpoint.nextAction, 'regenerate_five_response_calibration_from_real_f1_f2_data');
});

test('phase-shift execution plan completes prior checkpoints when a later workstream becomes active', () => {
  const report = readyPhaseShiftReport();
  report.workstreams = report.workstreams.map((workstream) => ({
    ...workstream,
    status: workstream.id === 'deepseek_gated_live_calibration' ? 'active' : 'queued',
  }));
  report.transition = {
    ...report.transition,
    nextAction: 'deepseek_gated_live_calibration',
  };

  const state = resolveCurrentGoalState(report);

  assert.equal(state.currentWorkstream.id, 'deepseek_gated_live_calibration');
  assert.equal(state.currentPhaseShiftCheckpoint.id, 'private_live_advisor_entry');
  assert.equal(state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'f3_five_response_calibration',
  ).status, 'complete');
  assert.equal(state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'f4_sota_track_entry',
  ).status, 'complete');
  assert.equal(state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'private_live_advisor_entry',
  ).status, 'active');
});

test('private live advisor checkpoint requires accepted rejected stale unsafe and recovery evidence', () => {
  const report = readyPhaseShiftReport();
  report.workstreams = report.workstreams.map((workstream) => ({
    ...workstream,
    status: workstream.id === 'deepseek_gated_live_calibration' ? 'active' : 'queued',
  }));
  report.transition = {
    ...report.transition,
    nextAction: 'deepseek_gated_live_calibration',
  };

  const state = resolveCurrentGoalState(report, {
    advisorLiveCalibration: {
      ok: false,
      status: 'live_calibration_pending',
      summary: {
        liveProvenClasses: ['accepted'],
      },
      nextAction: 'run_private_live_advisor_calibration_case:activation_rejected_policy',
    },
  });
  const checkpoint = state.phaseShiftExecutionPlan.find(
    (entry) => entry.id === 'private_live_advisor_entry',
  );

  assert.equal(state.currentPhaseShiftCheckpoint.id, 'private_live_advisor_entry');
  assert.equal(checkpoint.status, 'active');
  assert.match(checkpoint.completionReason, /rejected, stale, unsafe, recovery/);
  assert.equal(checkpoint.nextAction, 'run_private_live_advisor_calibration_case:activation_rejected_policy');
});

test('private live advisor checkpoint completes when all calibration classes are live-proven', () => {
  const report = readyPhaseShiftReport();
  report.workstreams = report.workstreams.map((workstream) => ({
    ...workstream,
    status: workstream.id === 'benchmark_ladder'
      ? 'active'
      : workstream.id === 'deepseek_gated_live_calibration' || workstream.id === 'deepseek_dry_run_calibration'
        ? 'complete'
        : 'queued',
  }));
  report.transition = {
    ...report.transition,
    nextAction: 'benchmark_ladder',
  };

  const state = resolveCurrentGoalState(report, {
    advisorLiveCalibration: {
      ok: true,
      status: 'live_calibration_complete',
      summary: {
        liveProvenClasses: ['accepted', 'rejected', 'stale', 'unsafe', 'recovery'],
      },
      safety: {
        allLiveEvidenceNoBypass: true,
      },
      nextAction: 'advance_to_benchmark_ladder',
    },
  });
  const checkpoint = state.phaseShiftExecutionPlan.find(
    (entry) => entry.id === 'private_live_advisor_entry',
  );

  assert.equal(state.currentWorkstream.id, 'benchmark_ladder');
  assert.equal(state.currentPhaseShiftCheckpoint, null);
  assert.equal(state.nextAction, 'benchmark_ladder');
  assert.equal(checkpoint.status, 'complete');
  assert.match(checkpoint.completionEvidence, /accepted, rejected, stale, unsafe, and recovery/);
  assert.equal(checkpoint.nextAction, 'begin_benchmark_ladder');
});

test('blocked phase-shift report keeps the current goal in deterministic gate closure', () => {
  const report = evaluatePhaseShiftReadiness({
    queueProposalBoundary: true,
    advisorDryRun: null,
    deterministicBaselinePassed: false,
    docs: {
      goalNamesPhaseShift: true,
      statusNamesPhaseShift: false,
    },
  });
  const state = resolveCurrentGoalState(report);

  assert.equal(state.activePhase, 'deterministic_gate_closure');
  assert.equal(state.phaseShiftReady, false);
  assert.equal(state.stopBroadPolishing, false);
  assert.equal(state.currentWorkstream, null);
  assert.deepEqual(state.currentWorkstreamExitCriteria, []);
  assert.deepEqual(state.currentPhaseShiftCheckpoint, null);
  assert.equal(state.phaseShiftExecutionPlan.find(
    (checkpoint) => checkpoint.id === 'phase_shift_gate_locked',
  ).status, 'blocked');
  assert.deepEqual(state.nextQueuedWorkstreams, []);
  assert.match(state.nextAction, /^clear gate:/);
  assert.ok(state.blockers.some((blocker) => blocker.id === 'f1_first_live_call'));
});

test('current goal policy allows active workstream and post-gate blocker work', () => {
  const state = resolveCurrentGoalState(readyPhaseShiftReport());

  const activeWorkstream = evaluateCurrentGoalWorkPolicy(state, {
    workstreamId: 'deepseek_dry_run_calibration',
  });
  assert.equal(activeWorkstream.allowed, true);
  assert.equal(activeWorkstream.matchedRule, 'deepseek_dry_run_calibration');

  const activeWorkstreamByKind = evaluateCurrentGoalWorkPolicy(state, 'deepseek_dry_run_calibration');
  assert.equal(activeWorkstreamByKind.allowed, true);
  assert.equal(activeWorkstreamByKind.matchedRule, 'deepseek_dry_run_calibration');

  const safetyRegression = evaluateCurrentGoalWorkPolicy(state, 'safety regressions');
  assert.equal(safetyRegression.allowed, true);
  assert.equal(safetyRegression.matchedRule, 'safety regressions');
});

test('current goal policy blocks queued SOTA workstreams until the active workstream exits', () => {
  const state = resolveCurrentGoalState(readyPhaseShiftReport());
  const queuedBenchmark = evaluateCurrentGoalWorkPolicy(state, {
    workstreamId: 'benchmark_ladder',
  });

  assert.equal(queuedBenchmark.allowed, false);
  assert.equal(queuedBenchmark.matchedRule, 'benchmark_ladder');
  assert.match(queuedBenchmark.reason, /waits until the active workstream "deepseek_dry_run_calibration"/);
});

test('current goal policy rejects broad polishing after the phase shift is ready', () => {
  const state = resolveCurrentGoalState(readyPhaseShiftReport());
  const decision = evaluateCurrentGoalWorkPolicy(state, 'broad deterministic substrate polishing');

  assert.equal(decision.allowed, false);
  assert.equal(decision.stopBroadPolishing, true);
  assert.match(decision.reason, /broad deterministic substrate polishing is closed/);
});

test('current goal policy keeps DeepSeek work blocked before gate closure', () => {
  const report = evaluatePhaseShiftReadiness({
    queueProposalBoundary: true,
    advisorDryRun: null,
    deterministicBaselinePassed: false,
    docs: {
      goalNamesPhaseShift: true,
      statusNamesPhaseShift: false,
    },
  });
  const state = resolveCurrentGoalState(report);

  const readinessBlocker = evaluateCurrentGoalWorkPolicy(state, 'clear readiness blockers');
  assert.equal(readinessBlocker.allowed, true);

  const prematureDeepSeek = evaluateCurrentGoalWorkPolicy(state, {
    workstreamId: 'deepseek_dry_run_calibration',
  });
  assert.equal(prematureDeepSeek.allowed, false);
  assert.match(prematureDeepSeek.reason, /does not clear a named gate-closure blocker/);
});
