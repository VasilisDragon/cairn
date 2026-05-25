import {
  PHASE_SHIFT_TRANSITION,
  PHASE_SHIFT_WORKSTREAMS,
} from './phase_shift_readiness.js';

export const SOTA_TRACK_OUTCOME_TARGETS = Object.freeze([
  Object.freeze({
    id: 'deepseek_orchestrated_private_server_autonomy',
    objective: 'DeepSeek can plan long-running private-server tasks through validated deterministic skill proposals while survival and queue mutation stay deterministic.',
    evidenceRequired: Object.freeze([
      'recorded-snapshot dry-run calibration stays green before real calls',
      'explicitly gated live calibration logs accepted, rejected, stale, unsafe, and recovery proposals',
      'no DeepSeek plan bypasses activation, reactive survival, or skill-boundary queue staging',
    ]),
  }),
  Object.freeze({
    id: 'repeatable_benchmark_ladder',
    objective: 'The project has reproducible offline and private-live benchmarks that separate live-proven capability from scaffolded or pending capability.',
    evidenceRequired: Object.freeze([
      'benchmark artifacts name setup, command, expected result, evidence file, and result status',
      'failures create targeted blockers instead of reopening broad deterministic polishing',
      'capability matrix stays current enough for external review',
    ]),
  }),
  Object.freeze({
    id: 'long_horizon_mission_reliability',
    objective: 'Fishing, mining, gather/deposit, return-on-time, and recovery missions run as durable timed controllers instead of one-off scripts.',
    evidenceRequired: Object.freeze([
      'timed missions reserve return time before the deadline',
      'mission loops handle deposit, food/tool state, hazards, interruptions, and clean stop/resume decisions',
      'scaled offline tests and bounded private-server soaks cover multi-hour behavior before claims are made',
    ]),
  }),
  Object.freeze({
    id: 'advanced_private_combat_ladder',
    objective: 'PvM and authorized PvP advance through ordinary Minecraft actions, plausible timing, and explicit no-cheat constraints.',
    evidenceRequired: Object.freeze([
      'PvM engage/flee decisions pass escalating hostile fixtures before player combat work expands',
      'player combat remains private/local/authorized and gated by explicit config',
      'advanced tactics exclude kill-aura, aimbot, packet spoofing, impossible rotations, and public-server behavior',
    ]),
  }),
  Object.freeze({
    id: 'operator_viewer_and_handoff_track',
    objective: 'A human can supervise the bot through a persistent viewer and a documented handoff architecture without making rendered pixels the advisor state source.',
    evidenceRequired: Object.freeze([
      'viewer can remain open across disconnect/reconnect behavior',
      'handoff architecture documents viewer-first oversight, normal logout/relogin production control, and later Fabric input bridge',
      'DeepSeek continues to consume structured snapshots and world-model summaries',
    ]),
  }),
  Object.freeze({
    id: 'publication_ready_evidence',
    objective: 'The repo can support resume/publication claims with repeatable commands, logs, benchmark tables, demos, and honest capability labels.',
    evidenceRequired: Object.freeze([
      'demo scripts and reports reproduce the strongest claims',
      'each claim is labeled live-proven, offline-covered, scaffolded, or pending',
      'public-facing material emphasizes authorized private-server autonomy and avoids cheating claims',
    ]),
  }),
]);

export const PHASE_SHIFT_EXECUTION_CHECKPOINTS = Object.freeze([
  Object.freeze({
    id: 'phase_shift_gate_locked',
    priority: 1,
    workstreamId: 'deepseek_dry_run_calibration',
    outcomeTargetIds: Object.freeze([
      'deepseek_orchestrated_private_server_autonomy',
      'publication_ready_evidence',
    ]),
    objective: 'Keep the deterministic-to-SOTA transition represented by generated goal-state reports instead of informal conversation state.',
    entryEvidence: Object.freeze([
      'reports/phase-shift-readiness.md reports F1 and F2 evidence as live-proven',
      'reports/deterministic-eval.md reports stop broad polishing as yes after F1+F2',
    ]),
    exitEvidence: Object.freeze([
      'src/goal/current_goal.js exposes stopBroadPolishing and ordered post-gate workstreams',
      'test/offline/goal_structure.test.js rejects broad deterministic substrate polishing after the gate',
    ]),
  }),
  Object.freeze({
    id: 'f3_five_response_calibration',
    priority: 2,
    workstreamId: 'deepseek_dry_run_calibration',
    outcomeTargetIds: Object.freeze([
      'deepseek_orchestrated_private_server_autonomy',
      'publication_ready_evidence',
    ]),
    objective: 'Regenerate the full multi-tier five-response calibration pack from real F1/F2 response shape data.',
    entryEvidence: Object.freeze([
      'F1 single-response capture exists and validates',
      'F2 live private-server plan exists and validates',
      'reports/advisor-first-call-replay.md',
    ]),
    exitEvidence: Object.freeze([
      'five-response calibration pack is generated from real provider response shape',
      'strict replay validates the regenerated captured responses',
      'response-capture guard proves public reports contain no raw model responses or secrets',
    ]),
  }),
  Object.freeze({
    id: 'f4_sota_track_entry',
    priority: 3,
    workstreamId: 'deepseek_dry_run_calibration',
    outcomeTargetIds: Object.freeze([
      'deepseek_orchestrated_private_server_autonomy',
      'publication_ready_evidence',
    ]),
    objective: 'Promote out of calibration into the ordered C1-C9 SOTA workstreams after F3 evidence is green.',
    entryEvidence: Object.freeze([
      'F3 five-response calibration is green',
      'reports/capability-matrix.md labels live-proven/offline-covered/scaffolded/pending claims',
    ]),
    exitEvidence: Object.freeze([
      'docs/status.md records F4 and the C1-C9 entry point',
      'docs/codex-progress.md records F4 and the next active C-workstream',
    ]),
  }),
  Object.freeze({
    id: 'private_live_advisor_entry',
    priority: 4,
    workstreamId: 'deepseek_gated_live_calibration',
    outcomeTargetIds: Object.freeze([
      'deepseek_orchestrated_private_server_autonomy',
      'repeatable_benchmark_ladder',
      'long_horizon_mission_reliability',
      'advanced_private_combat_ladder',
    ]),
    objective: 'Move to private-server live DeepSeek calibration only after strict first-call promotion, keeping deterministic survival and activation authority.',
    entryEvidence: Object.freeze([
      'MCBOT_LIVE_TESTS=1',
      'MCBOT_ALLOW_DEEPSEEK=1',
      'private/local server gates pass',
    ]),
    exitEvidence: Object.freeze([
      'live logs show accepted, rejected, stale, unsafe, and recovery proposals',
      'reactive survival and skill-boundary queue staging remain authoritative',
      'capability claims are marked live-proven, offline-covered, scaffolded, or pending',
    ]),
  }),
]);

export const CURRENT_GOAL_STRUCTURE = Object.freeze({
  id: 'deterministic_autonomy_v1',
  title: 'MCBot deterministic autonomy v1 to SOTA-track transition',
  objective: 'Finish only deterministic work that directly supports the post-gate SOTA track, then move through DeepSeek calibration, benchmarks, long-horizon missions, combat, viewer/operator UX, and publication evidence.',
  phaseShiftMandate: Object.freeze({
    sourceReport: 'reports/phase-shift-readiness.md',
    whenReady: 'Move the active goal into the SOTA track and stop broad deterministic substrate polishing.',
    workstreamRule: 'Work active/queued SOTA-track streams in priority order unless a safety regression or direct benchmark blocker requires a smaller deterministic fix.',
    evidenceRule: 'Every capability claim must remain tied to generated reports, tests, live logs, or explicit pending/blocker status.',
    achievementDefinition: 'The phase shift is successful only when DeepSeek-guided private-server autonomy, benchmark evidence, long-horizon missions, advanced private combat, operator oversight, and publication-ready proof are all represented by generated evidence.',
    checkpointRule: 'Each post-gate checkpoint should name the active workstream, the SOTA outcome target it advances, and the generated evidence that changed.',
    prohibitedWhenReady: Object.freeze([
      'broad deterministic substrate polishing',
      'general offline hardening without a benchmark, safety, calibration, or publication evidence link',
      'queued SOTA-track work before the active workstream is done unless it is a direct blocker',
    ]),
  }),
  phases: Object.freeze([
    Object.freeze({
      id: 'deterministic_gate_closure',
      statusWhenActive: 'gate-closure',
      objective: 'Clear named readiness blockers and safety regressions before moving to the SOTA track.',
      allowedWorkKinds: Object.freeze([
        'clear readiness blockers',
        'fix safety regressions',
        'repair failing deterministic tests',
        'document exact live blockers',
      ]),
    }),
    Object.freeze({
      id: 'sota_track',
      statusWhenActive: 'post-gate',
      objective: PHASE_SHIFT_TRANSITION.nextGoalObjective,
      allowedWorkKinds: PHASE_SHIFT_TRANSITION.allowedPostGateDeterministicWork,
    }),
  ]),
  invariants: Object.freeze([
    'DeepSeek remains opt-in and API-free until an explicitly gated calibration run.',
    'DeepSeek is planner-only; deterministic validators own activation, survival, queue mutation, and skill execution.',
    'Do not resume broad substrate polishing after the phase-shift gate is green.',
    'Public-server behavior, anti-cheat bypasses, impossible rotations, kill-aura, and aimbot behavior stay out of scope.',
  ]),
  orderedPostGateWorkstreams: PHASE_SHIFT_WORKSTREAMS,
  sotaTrackOutcomeTargets: SOTA_TRACK_OUTCOME_TARGETS,
  phaseShiftExecutionPlan: PHASE_SHIFT_EXECUTION_CHECKPOINTS,
});

export function resolveCurrentGoalState(phaseShiftReport = {}, evidence = {}) {
  const ready = phaseShiftReport.ready === true
    && phaseShiftReport.transition?.status === PHASE_SHIFT_TRANSITION.readyStatus;
  const phase = selectPhase(ready ? 'sota_track' : 'deterministic_gate_closure');
  const transition = phaseShiftReport.transition || {};
  const workstreams = Array.isArray(phaseShiftReport.workstreams) && phaseShiftReport.workstreams.length > 0
    ? phaseShiftReport.workstreams
    : PHASE_SHIFT_WORKSTREAMS;
  const nextWorkstream = ready
    ? workstreams.find((workstream) => workstream.status === 'active') || workstreams[0]
    : null;
  const blockers = Array.isArray(phaseShiftReport.blockers) ? phaseShiftReport.blockers : [];

  const phaseShiftExecutionPlan = resolvePhaseShiftExecutionPlan({
    ready,
    currentWorkstreamId: nextWorkstream?.id || null,
    evidence,
  });
  const currentPhaseShiftCheckpoint = phaseShiftExecutionPlan.find((checkpoint) => checkpoint.status === 'active') || null;
  const nextAction = resolveGoalNextAction({
    ready,
    transition,
    nextWorkstream,
    blockers,
    currentPhaseShiftCheckpoint,
  });

  return {
    goalId: CURRENT_GOAL_STRUCTURE.id,
    title: CURRENT_GOAL_STRUCTURE.title,
    activePhase: phase.id,
    phaseStatus: phase.statusWhenActive,
    phaseObjective: phase.objective,
    phaseShiftReady: ready,
    stopBroadPolishing: ready,
    nextAction,
    currentWorkstream: nextWorkstream ? cloneWorkstream(nextWorkstream) : null,
    currentWorkstreamExitCriteria: ready && nextWorkstream
      ? [...(nextWorkstream.achievementCriteria || [])]
      : [],
    nextQueuedWorkstreams: ready
      ? workstreams
        .filter((workstream) => workstream.id !== nextWorkstream?.id)
        .map(cloneWorkstream)
      : [],
    phaseShiftMandate: { ...CURRENT_GOAL_STRUCTURE.phaseShiftMandate },
    allowedWorkKinds: [...phase.allowedWorkKinds],
    disallowedWorkKinds: ready
      ? [...CURRENT_GOAL_STRUCTURE.phaseShiftMandate.prohibitedWhenReady]
      : [],
    blockers: blockers.map((blocker) => ({ ...blocker })),
    invariants: [...CURRENT_GOAL_STRUCTURE.invariants],
    orderedPostGateWorkstreams: workstreams.map(cloneWorkstream),
    sotaTrackOutcomeTargets: CURRENT_GOAL_STRUCTURE.sotaTrackOutcomeTargets.map(cloneOutcomeTarget),
    phaseShiftExecutionPlan,
    currentPhaseShiftCheckpoint,
  };
}

export function evaluateCurrentGoalWorkPolicy(goalState = {}, proposedWork = {}) {
  const requested = normalizeProposedWork(proposedWork);
  const allowedKinds = Array.isArray(goalState.allowedWorkKinds) ? goalState.allowedWorkKinds : [];
  const disallowedKinds = Array.isArray(goalState.disallowedWorkKinds) ? goalState.disallowedWorkKinds : [];
  const currentWorkstreamId = goalState.currentWorkstream?.id || null;
  const normalizedKind = normalizeWorkKind(requested.kind);
  const normalizedWorkstream = normalizeWorkKind(requested.workstreamId);

  if (!normalizedKind && !normalizedWorkstream) {
    return workPolicyResult({
      goalState,
      proposedWork: requested,
      allowed: false,
      reason: 'No work kind or workstream id was provided.',
    });
  }

  if (goalState.stopBroadPolishing === true) {
    const broadPolishingMatch = disallowedKinds.find((kind) => normalizeWorkKind(kind) === normalizedKind);
    if (broadPolishingMatch) {
      return workPolicyResult({
        goalState,
        proposedWork: requested,
        allowed: false,
        matchedRule: broadPolishingMatch,
        reason: 'Phase shift is ready; broad deterministic substrate polishing is closed.',
      });
    }
  }

  const normalizedCurrentWorkstream = normalizeWorkKind(currentWorkstreamId);
  const activeWorkstreamMatch = currentWorkstreamId
    && (normalizedWorkstream === normalizedCurrentWorkstream || normalizedKind === normalizedCurrentWorkstream);
  if (goalState.phaseShiftReady === true && activeWorkstreamMatch) {
    return workPolicyResult({
      goalState,
      proposedWork: requested,
      allowed: true,
      matchedRule: currentWorkstreamId,
      reason: 'Proposed work targets the active SOTA-track workstream.',
    });
  }

  const queuedWorkstream = (goalState.nextQueuedWorkstreams || []).find((workstream) => {
    const normalizedQueued = normalizeWorkKind(workstream.id);
    return normalizedWorkstream === normalizedQueued || normalizedKind === normalizedQueued;
  });
  if (goalState.phaseShiftReady === true && queuedWorkstream) {
    return workPolicyResult({
      goalState,
      proposedWork: requested,
      allowed: false,
      matchedRule: queuedWorkstream.id,
      reason: `Queued SOTA-track workstream "${queuedWorkstream.id}" waits until the active workstream "${currentWorkstreamId}" satisfies its exit criteria.`,
    });
  }

  const allowedKindMatch = allowedKinds.find((kind) => normalizeWorkKind(kind) === normalizedKind);
  if (allowedKindMatch) {
    return workPolicyResult({
      goalState,
      proposedWork: requested,
      allowed: true,
      matchedRule: allowedKindMatch,
      reason: 'Proposed work matches an allowed current-goal work kind.',
    });
  }

  return workPolicyResult({
    goalState,
    proposedWork: requested,
    allowed: false,
    reason: goalState.phaseShiftReady === true
      ? 'Proposed work is outside the active SOTA-track stream and allowed post-gate deterministic work kinds.'
      : 'Proposed work does not clear a named gate-closure blocker or safety/test/documentation requirement.',
  });
}

function selectPhase(id) {
  return CURRENT_GOAL_STRUCTURE.phases.find((phase) => phase.id === id)
    || CURRENT_GOAL_STRUCTURE.phases[0];
}

function cloneWorkstream(workstream) {
  return {
    ...workstream,
    achievementCriteria: [...(workstream.achievementCriteria || [])],
  };
}

function cloneOutcomeTarget(target) {
  return {
    ...target,
    evidenceRequired: [...(target.evidenceRequired || [])],
  };
}

function resolveGoalNextAction({
  ready,
  transition = {},
  nextWorkstream = null,
  blockers = [],
  currentPhaseShiftCheckpoint = null,
}) {
  if (!ready) {
    return transition.nextAction || `clear gate: ${blockers[0]?.id || 'unknown'}`;
  }
  if (currentPhaseShiftCheckpoint?.nextAction) {
    return currentPhaseShiftCheckpoint.nextAction;
  }
  if (currentPhaseShiftCheckpoint?.id) {
    return currentPhaseShiftCheckpoint.id;
  }
  return transition.nextAction || nextWorkstream?.id || 'unknown';
}

function resolvePhaseShiftExecutionPlan({ ready, currentWorkstreamId, evidence = {} }) {
  const checkpointEvidence = evidence && typeof evidence === 'object' ? evidence : {};
  const currentWorkstreamCheckpoints = PHASE_SHIFT_EXECUTION_CHECKPOINTS
    .filter((checkpoint) => checkpoint.workstreamId === currentWorkstreamId);
  const completionById = new Map(PHASE_SHIFT_EXECUTION_CHECKPOINTS.map((checkpoint) => [
    checkpoint.id,
    evaluateCheckpointCompletion(checkpoint, { ready, evidence: checkpointEvidence }),
  ]));
  const firstIncompleteCheckpoint = currentWorkstreamCheckpoints
    .find((checkpoint) => completionById.get(checkpoint.id)?.complete !== true);
  const activeCheckpoint = ready
    ? firstIncompleteCheckpoint || currentWorkstreamCheckpoints[0] || null
    : null;
  const activeCheckpointId = activeCheckpoint?.id || null;
  const activeCheckpointPriority = activeCheckpoint?.priority || null;

  return PHASE_SHIFT_EXECUTION_CHECKPOINTS.map((checkpoint) => {
    const completion = completionById.get(checkpoint.id) || { complete: false, evidence: null, reason: 'no completion evidence' };
    let status = 'queued';
    if (!ready) {
      status = checkpoint.id === 'phase_shift_gate_locked' ? 'blocked' : 'queued';
    } else if (completion.complete === true || checkpoint.priority < activeCheckpointPriority) {
      status = 'complete';
    } else if (checkpoint.id === activeCheckpointId) {
      status = 'active';
    } else if (checkpoint.workstreamId === currentWorkstreamId) {
      status = 'queued_in_active_workstream';
    }

    return {
      ...checkpoint,
      status,
      outcomeTargetIds: [...(checkpoint.outcomeTargetIds || [])],
      entryEvidence: [...(checkpoint.entryEvidence || [])],
      exitEvidence: [...(checkpoint.exitEvidence || [])],
      completionEvidence: completion.evidence,
      completionReason: completion.reason,
      nextAction: completion.nextAction || null,
    };
  });
}

function evaluateCheckpointCompletion(checkpoint, { ready, evidence }) {
  if (checkpoint.id === 'phase_shift_gate_locked') {
    return {
      complete: ready === true,
      evidence: ready ? 'phase-shift readiness report is green' : null,
      reason: ready ? 'phase-shift gate is locked' : 'phase-shift readiness is not green',
      nextAction: ready ? null : 'clear_phase_shift_gate',
    };
  }
  if (checkpoint.id === 'f3_five_response_calibration') {
    return evaluateF3FiveResponseCalibration(evidence);
  }
  if (checkpoint.id === 'f4_sota_track_entry') {
    const f3 = evaluateF3FiveResponseCalibration(evidence);
    const progress = evidence.f4 || evidence.sotaTrackEntry || {};
    const complete = f3.complete === true
      && progress.status === 'f4_sota_track_started'
      && progress.statusDocsUpdated === true
      && progress.progressDocsUpdated === true;
    return {
      complete,
      evidence: complete ? 'F4 SOTA-track entry is documented and ready' : null,
      reason: complete ? 'F4 SOTA-track entry passed' : 'F4 SOTA-track entry evidence is not complete',
      nextAction: complete
        ? 'begin_c1_humanization_layer'
        : 'finish_f4_sota_track_entry_after_f3',
    };
  }
  if (checkpoint.id === 'private_live_advisor_entry') {
    return evaluatePrivateLiveAdvisorEntry(evidence);
  }
  return {
    complete: false,
    evidence: null,
    reason: 'checkpoint requires explicit future evidence',
    nextAction: null,
  };
}

function evaluatePrivateLiveAdvisorEntry(evidence = {}) {
  const calibration = evidence.advisorLiveCalibration || evidence.liveAdvisorCalibration || {};
  const required = ['accepted', 'rejected', 'stale', 'unsafe', 'recovery'];
  const liveProvenClasses = calibration.summary?.liveProvenClasses || [];
  const hasAllClasses = required.every((proposalClass) => liveProvenClasses.includes(proposalClass));
  const complete = calibration.ok === true
    && calibration.status === 'live_calibration_complete'
    && hasAllClasses === true
    && calibration.safety?.allLiveEvidenceNoBypass === true;
  const pending = required.filter((proposalClass) => !liveProvenClasses.includes(proposalClass));
  return {
    complete,
    evidence: complete
      ? 'advisor live calibration report proves accepted, rejected, stale, unsafe, and recovery proposal classes'
      : null,
    reason: complete
      ? 'private live advisor entry passed'
      : `private live advisor entry still missing proposal-class evidence: ${pending.join(', ') || 'unknown'}`,
    nextAction: complete
      ? 'begin_benchmark_ladder'
      : calibration.nextAction || 'run_private_live_advisor_calibration_cases',
  };
}

function evaluateF3FiveResponseCalibration(evidence = {}) {
  const replay = evidence.f3Replay || evidence.firstCallResponseReplay || {};
  const guard = evidence.f3ResponseCaptureGuard || evidence.responseCaptureGuard || {};
  const responseCount = Number(replay.presentCount ?? replay.responseCount ?? replay.expectedResponseCount ?? 0);
  const complete = replay.ok === true
    && replay.status === 'validated_model_responses'
    && responseCount >= 5
    && (replay.responseMetricsIncompleteCount || 0) === 0
    && guard.ok === true;
  return {
    complete,
    evidence: complete ? 'F3 five-response replay and response-capture guard are complete' : null,
    reason: complete ? 'F3 five-response calibration passed' : 'F3 five-response calibration evidence is not complete',
    nextAction: complete
      ? 'record_f4_sota_track_entry'
      : 'regenerate_five_response_calibration_from_real_f1_f2_data',
  };
}

function normalizeProposedWork(proposedWork) {
  if (typeof proposedWork === 'string') {
    return {
      kind: proposedWork,
      workstreamId: null,
    };
  }
  return {
    kind: proposedWork.kind || proposedWork.workKind || null,
    workstreamId: proposedWork.workstreamId || null,
  };
}

function normalizeWorkKind(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ');
}

function workPolicyResult({
  goalState,
  proposedWork,
  allowed,
  reason,
  matchedRule = null,
}) {
  return {
    allowed,
    reason,
    matchedRule,
    proposedWork,
    activePhase: goalState.activePhase || 'unknown',
    phaseShiftReady: goalState.phaseShiftReady === true,
    stopBroadPolishing: goalState.stopBroadPolishing === true,
    currentWorkstreamId: goalState.currentWorkstream?.id || null,
    allowedWorkKinds: [...(goalState.allowedWorkKinds || [])],
    disallowedWorkKinds: [...(goalState.disallowedWorkKinds || [])],
  };
}

export default {
  CURRENT_GOAL_STRUCTURE,
  PHASE_SHIFT_EXECUTION_CHECKPOINTS,
  SOTA_TRACK_OUTCOME_TARGETS,
  resolveCurrentGoalState,
  evaluateCurrentGoalWorkPolicy,
};
