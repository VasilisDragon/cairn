#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runnableLiveScenarioIds } from './live-scenarios.js';
import {
  evaluatePhaseShiftReadiness,
  renderPhaseShiftReadiness,
} from '../src/goal/phase_shift_readiness.js';
import { resolveCurrentGoalState } from '../src/goal/current_goal.js';
import { benchmarkLadderComplete } from '../src/benchmarks/ladder.js';

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, 'reports');
const JSON_REPORT = path.join(REPORT_DIR, 'deterministic-eval.json');
const MD_REPORT = path.join(REPORT_DIR, 'deterministic-eval.md');
const PHASE_SHIFT_JSON_REPORT = path.join(REPORT_DIR, 'phase-shift-readiness.json');
const PHASE_SHIFT_MD_REPORT = path.join(REPORT_DIR, 'phase-shift-readiness.md');
const LIVE_EVIDENCE_REPORT = path.join(REPORT_DIR, 'live-evidence.json');

const commands = [
  {
    name: 'check',
    category: 'syntax',
    argv: [process.execPath, ['scripts/check-js.js']],
  },
  {
    name: 'test:unit',
    category: 'offline deterministic unit',
    argv: [process.execPath, ['scripts/run-offline-tests.js']],
  },
  {
    name: 'test:grep',
    category: 'architecture invariant',
    argv: [process.execPath, ['scripts/check-pathfinder-writes.js']],
  },
  {
    name: 'advisor:dry-run',
    category: 'advisor dry-run calibration',
    argv: [process.execPath, ['scripts/advisor-dry-run.js']],
  },
  {
    name: 'advisor:first-call',
    category: 'advisor first-call capture and validation',
    argv: [process.execPath, ['scripts/advisor-first-call.js']],
  },
  {
    name: 'advisor:f3',
    category: 'advisor F3 calibration',
    argv: [process.execPath, ['scripts/advisor-f3-calibration.js']],
  },
  {
    name: 'advisor:replay',
    category: 'advisor response replay',
    argv: [process.execPath, ['scripts/advisor-first-call-replay.js']],
  },
  {
    name: 'advisor:live-calibration',
    category: 'advisor live calibration evidence',
    argv: [process.execPath, ['scripts/advisor-live-calibration.js']],
  },
  {
    name: 'advisor:live-calibration-case:dry-run',
    category: 'advisor live calibration evidence',
    argv: [process.execPath, ['scripts/advisor-live-calibration-case.js', '--dry-run']],
  },
  {
    name: 'advisor:live-calibration-case:stale-dry-run',
    category: 'advisor live calibration evidence',
    argv: [process.execPath, ['scripts/advisor-live-calibration-case.js', '--case', 'stale_plan_rejected', '--dry-run']],
  },
  {
    name: 'advisor:live-calibration-case:unsafe-dry-run',
    category: 'advisor live calibration evidence',
    argv: [process.execPath, ['scripts/advisor-live-calibration-case.js', '--case', 'unsafe_normal_work_rejected', '--dry-run']],
  },
  {
    name: 'advisor:live-calibration-case:recovery-dry-run',
    category: 'advisor live calibration evidence',
    argv: [process.execPath, ['scripts/advisor-live-calibration-case.js', '--case', 'recovery_proposal_bounded', '--dry-run']],
  },
  {
    name: 'benchmark:detection-rate',
    category: 'sota benchmark evidence',
    argv: [process.execPath, ['scripts/detection-rate-benchmark.js']],
  },
  {
    name: 'benchmark:missions',
    category: 'long-horizon mission evidence',
    argv: [process.execPath, ['scripts/mission-reliability-benchmark.js']],
  },
  {
    name: 'capability:matrix',
    category: 'publication evidence',
    argv: [process.execPath, ['scripts/capability-matrix.js']],
  },
  {
    name: 'benchmark:ladder',
    category: 'sota benchmark evidence',
    argv: [process.execPath, ['scripts/benchmark-ladder.js']],
  },
  {
    name: 'advisor:response-capture-guard',
    category: 'advisor private response capture guard',
    argv: [process.execPath, ['scripts/advisor-response-capture-guard.js']],
  },
];

function runCommand(command) {
  const [cmd, args] = command.argv;
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const durationMs = Date.now() - started;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return {
    name: command.name,
    category: command.category,
    command: [cmd === process.execPath ? 'node' : cmd, ...args].join(' '),
    ok: result.status === 0,
    exitCode: result.status,
    durationMs,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function tail(text, max = 4000) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function parseStatusPath(line) {
  if (line.startsWith('?? ') || line.startsWith('!! ')) return line.slice(3).trim();
  if (line.length > 2 && line[2] === ' ') return line.slice(3).trim();
  if (line.length > 1 && line[1] === ' ') return line.slice(2).trim();
  return line.trim();
}

const commandResults = commands.map(runCommand);
const ok = commandResults.every((r) => r.ok);
const statusShort = git(['status', '--short']) || '';
const changedFiles = statusShort
  .split(/\r?\n/)
  .filter(Boolean)
  .map(parseStatusPath)
  .filter(Boolean);
const advisorDryRunReport = readJson(path.join(REPORT_DIR, 'advisor-dry-run.json'));
const firstCallReport = readJson(path.join(REPORT_DIR, 'advisor-first-call.json'));
const firstCallResponseReplayReport = readJson(path.join(REPORT_DIR, 'advisor-first-call-replay.json'));
const f3ReplayReport = readJson(path.join(REPORT_DIR, 'advisor-f3-replay.json'));
const responseCaptureGuardReport = readJson(path.join(REPORT_DIR, 'advisor-response-capture-guard.json'));
const f3ResponseCaptureGuardReport = readJson(path.join(REPORT_DIR, 'advisor-f3-response-capture-guard.json'));
const capabilityMatrixReport = readJson(path.join(REPORT_DIR, 'capability-matrix.json'));
const firstLivePlanReport = readJson(path.join(REPORT_DIR, 'advisor-live-plan.json'));
const advisorLiveCalibrationReport = readJson(path.join(REPORT_DIR, 'advisor-live-calibration.json'));
const liveEvidenceReport = readJson(LIVE_EVIDENCE_REPORT);
const benchmarkLadderReport = readJson(path.join(REPORT_DIR, 'benchmark-ladder.json'));
const missionReliabilityReport = readJson(path.join(REPORT_DIR, 'mission-reliability-benchmark.json'));
const basePhaseShift = evaluatePhaseShiftReadiness({
  firstLiveCall: {
    ...(firstCallReport || {}),
    responseReplay: firstCallResponseReplayReport,
  },
  firstLivePlan: firstLivePlanReport,
  queueProposalBoundary: true,
  queueProposalBoundaryEvidence: 'test/offline/advisor_queue_proposal.test.js and advisor context manifest cover activation-validated boundary staging.',
  advisorDryRun: advisorDryRunReport,
  liveEvidence: {
    hostileEscalation: liveEvidenceFor(liveEvidenceReport, 'live_hostile_escalation_fixture') || documentedLiveBlock(
      'live_hostile_escalation_fixture',
      ['MCBOT_LIVE_TESTS', 'MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK', 'MCBOT_LIVE_ADMIN_OK', 'MCBOT_RCON_PASSWORD'],
    ),
    pvmEscalation: liveEvidenceFor(liveEvidenceReport, 'live_pvm_escalation_decision_fixture') || documentedLiveBlock(
      'live_pvm_escalation_decision_fixture',
      ['MCBOT_LIVE_TESTS', 'MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK', 'MCBOT_LIVE_ADMIN_OK', 'MCBOT_RCON_PASSWORD'],
    ),
  },
  deterministicBaselinePassed: ok,
  deterministicBaselineEvidence: 'deterministic-eval check, unit, grep, and advisor dry-run commands passed in this run.',
  docs: phaseShiftDocsStatus(),
});
const f4Docs = f4DocsStatus();
const phaseShift = advancePhaseShiftWorkstreamIfReady(basePhaseShift, {
  f3Replay: f3ReplayReport,
  f3ResponseCaptureGuard: f3ResponseCaptureGuardReport,
  f4: f4Docs,
  advisorLiveCalibration: advisorLiveCalibrationReport,
  benchmarkLadder: benchmarkLadderReport,
  missionReliability: missionReliabilityReport,
});
const goalState = resolveCurrentGoalState(phaseShift, {
  firstCall: firstCallReport,
  firstCallResponseReplay: firstCallResponseReplayReport,
  f3Replay: f3ReplayReport,
  responseCaptureGuard: responseCaptureGuardReport,
  f3ResponseCaptureGuard: f3ResponseCaptureGuardReport,
  f4: f4Docs,
  advisorLiveCalibration: advisorLiveCalibrationReport,
});

const scenarioCoverage = [
  { category: 'pathfinder ownership', evidence: 'test/offline/pathfinder_owner.test.js plus test:grep', status: 'offline covered for preempt, denial, stale-token, setGoal, stop invariants, stop-failure fail-closed idle behavior, and startup event listener registration failure isolation' },
  { category: 'executor preempt/resume', evidence: 'test/offline/executor_queue.test.js, test/offline/interrupts.test.js', status: 'offline covered for preempt retry, repeated reactive preempts of the same queued call with stable active-call timing metadata, idle-before-resume gate, bounded stale-resume timeout after reactive release, resume-gate idle-read failure isolation, resume-gate timeout owner-read failure isolation, terminal failure event semantics, current-call cleanup, compact recent lifecycle events, boundary-only queue replacement proposals with stale-proposal discard on failure, boundary-only queue prefix insertion for recovery, prefix-before-preempt-retry insertion, active skill signal abort requests, interrupt-listener registration fail-closed behavior, interrupt-listener disposal failure telemetry, and interrupt listener emission failure isolation' },
  { category: 'runtime world-model context', evidence: 'test/offline/runtime_context.test.js, test/offline/executor_queue.test.js, test/offline/advisor_runtime_options.test.js', status: 'offline covered for default WorldModelStore construction, executor context precedence over injected fields, and advisor runtime-context option wiring without overriding explicit snapshot context/provider options' },
  { category: 'runtime task budget', evidence: 'src/runtime/task_budget.js, test/offline/task_budget.test.js, test/offline/snapshot_observe_context.test.js, test/live_mining_soak_fixture.js', status: 'offline covered for deterministic task budget creation, compact elapsed/deadline/return-reserve summaries, continue-vs-return-vs-stop mission decisions, fail-safe missing-deadline handling, phase labels without mutating the base budget, snapshot inclusion, and mining fixture usage of the shared budget primitive' },
  { category: 'runtime mission profile', evidence: 'src/runtime/mission_profile.js, test/offline/mission_profile.test.js, test/live_mining_soak_fixture.js, test/live_supply_chest_fishing_fixture.js', status: 'offline covered for reusable live-mission budget validation, deposit-interval normalization, exact unsafe-profile reasons, and mining plus fishing fixture usage of the shared profile primitive' },
  { category: 'runtime return planning', evidence: 'src/runtime/mission_return.js, test/offline/mission_return.test.js, test/offline/mission_control.test.js, test/live_mining_soak_fixture.js, test/live_supply_chest_fishing_fixture.js', status: 'offline covered for route-observation based return reserve estimates, latest-return-start plans, unsafe return-plan reasons, task-budget application, mission checkpoint precedence over deposits, compact telemetry, and mining plus fishing fixture dynamic return-plan logging' },
  { category: 'runtime mission control loop', evidence: 'src/runtime/mission_control.js, test/offline/mission_control.test.js, test/live_mining_soak_fixture.js, test/live_supply_chest_fishing_fixture.js', status: 'offline covered for shared long-running mission checkpoint decisions and loop execution, including budget stop/return precedence, periodic deposit, tracked-output deposit, inventory-pressure deposit, fail-safe missing-budget behavior, resume-after-deposit work, returnHome handling, preempted work propagation, missing handler failures, iteration-limit bounding, compact loop telemetry, and mining plus fishing fixture usage of the shared loop primitive' },
  { category: 'fishing cast recovery', evidence: 'src/skills/fish_until.js, src/skills/fish_and_deposit.js, src/skills/schema.js, test/offline/fish_until_skill.test.js, test/offline/fish_and_deposit_skill.test.js, test/live_supply_chest_fishing_fixture.js', status: 'offline covered for water/submersion/oxygen/sinking cancellation during active casts, bounded bobber-spawn watchdogs, transient lost-bobber retry, fishing-and-deposit propagation of bobberSpawnTimeoutMs and waterSafetyPollMs, live fixture logging/retry for missing or disappeared bobbers, and live fixture pre-cast rod re-equip after interim chest deposits; F is live-proven again after the re-equip fix, while the disappeared-bobber branch is offline-covered but not live-reproduced' },
  { category: 'runtime shutdown cleanup', evidence: 'test/offline/runtime_shutdown.test.js', status: 'offline covered for shutdown ordering, scheduled exit, dispose failure telemetry, quit failure telemetry, and continued cleanup after failures' },
  { category: 'user logout control', evidence: 'src/runtime/user_control.js, src/runtime/shutdown.js, src/index.js, test/offline/user_control.test.js, test/offline/runtime_shutdown.test.js, test/offline/runtime_startup.test.js, test/offline/config_example.test.js', status: 'offline covered for authorized-user !logout chat control, rejected unauthorized/no-authority logout requests, configurable logout command and authorized-user list, SIGINT/SIGTERM graceful shutdown through bot.quit, and idempotent duplicate signal handling' },
  { category: 'main runtime startup', evidence: 'test/offline/runtime_startup.test.js', status: 'offline covered for main spawn listener registration failure telemetry, spawn handler exception containment, and process event listener registration failure telemetry' },
  { category: 'bot startup wiring', evidence: 'test/offline/bot_logging.test.js', status: 'offline covered for required plugin load fail-fast telemetry, lifecycle logging listener registration failure isolation, death recovery classification logging with current-task and inventory snapshots, and recoverable-respawn scheduling of one recover_drops queue prefix plus active-skill abort request' },
  { category: 'configuration examples', evidence: 'test/offline/config_example.test.js', status: 'offline covered for documenting positive numeric executor timeout knobs in config.example.json, including operation, transfer, cleanup, consume, place-block, ranged-shot, chunk-ready, skill, and resume-gate timeouts plus reactive combat/survival opt-in flags, including ranged combat prep/fire/verification/follow-up limits and water-bucket pickup recovery' },
  { category: 'account regime selection', evidence: 'src/account_regime.js, src/config.js, src/bot.js, scripts/live-scenarios.js, scripts/live-suite.js, test/offline/account_regime.test.js, test/offline/bot_logging.test.js, test/offline/live_scenarios.test.js, test/offline/config_example.test.js', status: 'offline covered for Regime A default offline MCBot auth, explicit Regime B microsoft auth selection, optional Mineflayer token-cache directory, Regime-B-only user-elsewhere kick cooldown, production refusal of the default MCBot username, and Regime-A live-scenario gating before live imports' },
  { category: 'advisor live calibration ladder', evidence: 'scripts/advisor-live-calibration.js, scripts/advisor-live-calibration-case.js, test/offline/advisor_live_calibration.test.js, test/offline/advisor_live_calibration_case.test.js, reports/advisor-live-calibration.md, reports/advisor-live-calibration-case.json, reports/advisor-live-calibration-evidence.json', status: 'live-proven for the gated private Regime A DeepSeek calibration ladder across accepted, rejected, stale, unsafe, and recovery proposal classes, including activation-rejection, stale-plan teleport-drift, unsafe normal-work hostile-flee, and bounded recovery death-recovery-fall evidence; the reporter remains no-live/no-API and only evaluates sanitized recorded evidence' },
  { category: 'c3 detection-rate benchmark', evidence: 'src/benchmarks/detection_rate.js, scripts/detection-rate-benchmark.js, test/offline/detection_rate_benchmark.test.js, reports/detection-rate-benchmark.md, reports/detection-rate-blind-packet.json', status: 'scaffolded for non-live bot/human clip manifest anonymization, blind review packet generation, classification scoring against the 55% target, and public aggregate reporting without truth labels, raw local paths, server identifiers, or DeepSeek/API calls; pending real clip collection and human classifications' },
  { category: 'long-horizon mission reliability benchmark', evidence: 'src/benchmarks/mission_reliability.js, scripts/mission-reliability-benchmark.js, test/offline/mission_reliability_benchmark.test.js, reports/mission-reliability-benchmark.md', status: 'offline-covered for scaled timed fishing and mining mission loops that deposit tracked outputs, return before deadlines, adapt route reserve from slow observations, preserve reactive preempt state, and fail closed on missing return handlers; bounded private live soaks are still required before live reliability claims' },
  { category: 'repeatable benchmark ladder', evidence: 'src/benchmarks/ladder.js, scripts/benchmark-ladder.js, test/offline/benchmark_ladder.test.js, reports/benchmark-ladder.md', status: 'offline-covered no-live/no-API reporter for setup, command, expected result, evidence artifact, live/offline status, and targeted next action across F2, A-I, J/K, advisor calibration, C3, building, long-horizon, combat, viewer, and publication tracks; uncontrolled manual hostile spawns are excluded from formal evidence' },
  { category: 'c4 carpet-pvp heuristic extraction', evidence: 'docs/combat-heuristics-extracted.md, test/offline/combat_heuristics_extraction.test.js, .gitignore vendor/decompiled/', status: 'scaffolded for prose-only local Carpet-PvP reference review covering private-server fixture, fake-player/action-pack, telemetry, explosion/crystal observation, and benchmark-ladder ideas without copied source code, runtime dependencies, packet spoofing, reach extension, kill-aura, aimbot, impossible timing, or anti-cheat bypass behavior' },
  { category: 'chunk-ready world-query gates', evidence: 'test/offline/chunk_ready_gates.test.js, test/offline/chunk_ready_reset.test.js', status: 'offline covered for collect, goto(block), deposit, craft, build dry-run, collect/goto/craft/deposit registry-target failures before pending chunk waits, initial spawn waits, chunksReady property installation failure telemetry, bounded hung spawn chunk-load timeout, respawn resets, spawn/respawn listener registration failure telemetry, obsolete spawn/respawn event ordering, chunksReady getter failure isolation, malformed chunksReady thenable isolation, reactive aborts while chunk readiness is pending, abort listener fail-closed behavior, and abort listener cleanup failure visibility' },
  { category: 'collect abort cancellation', evidence: 'test/offline/collect_abort.test.js', status: 'offline covered for immediate stopDigging plus short poll after abort, dry-land collectBlock stall cancellation, synchronous collectBlock failure normalization, stopDigging failure visibility, and abort listener cleanup failure visibility' },
  { category: 'collect target selection', evidence: 'src/skills/collect.js, test/offline/collect_target_selection.test.js', status: 'offline covered for same-cluster preference, exclusion fallback, protected-region skip, support-under-self avoidance for ordinary targets, deferred support-log cleanup inside active tree clusters, deterministic ties, run integration, same-target resume after one reactive preempt, repeated-preempt target exclusion, active tree Vec3 world-query compatibility, target-level collect pathing/digging error exclusion, and scaffold-tower disabling for collection movement' },
  { category: 'goto block preempt recovery', evidence: 'test/offline/goto_preempt.test.js', status: 'offline covered for same-target resume after one reactive preempt, repeated-preempt target exclusion, alternate candidate recovery, and terminal scanned-target cleanup' },
  { category: 'pathing progress watchdogs', evidence: 'test/offline/pathing_water_watchdog.test.js, test/offline/collect_abort.test.js', status: 'offline covered for water stalls, collectBlock dry-land stalls, dry-land no-movement stuck detection, watchdog pathfinder-context read failure isolation, owner stop on stuck, owner-stop failure visibility, timeout stop cleanup, goal/collectBlock non-reactive signal-abort path stop cleanup, reactive-preempt duplicate-stop avoidance, pathfinder noPath/timeout status distinction, abort listener fail-closed behavior, bot event listener registration and cleanup failure isolation, abort listener cleanup failure visibility, and actionable pathing failure reasons' },
  { category: 'pathing movement safety policy', evidence: 'test/offline/pathing_world_model_policy.test.js, test/offline/reactive_flee.test.js', status: 'offline covered for physical hazard exclusions, unreadable-adjacent-block fail-closed behavior with telemetry, plus do-not-touch movement exclusions in goto, collectBlock, deposit, craft, storage withdrawal, advisor flee, and reactive flee pathing' },
  { category: 'pathing movement setup', evidence: 'test/offline/skill_runtime_failure.test.js, test/offline/reactive_startup.test.js', status: 'offline covered for fail-closed Movements construction failures in goto, collectBlock, deposit, craft, storage withdrawal, advisor flee, and reactive flee before pathfinder setGoal or collect attempts' },
  { category: 'reactive health and food', evidence: 'test/offline/reactive_health.test.js, test/offline/reactive_hazard.test.js, test/offline/reactive_startup.test.js, test/offline/reactive_flee.test.js, test/offline/consumable_policy.test.js, test/offline/consume_skill.test.js', status: 'offline covered for startup bot/auto-eat listener registration failure isolation, auto-eat option setup failure isolation, auto-eat suppression during unsafe states, low-health flee overriding engage, deterministic food/golden-apple/potion recommendation policy with opt-in potion and enchanted-golden-apple gates, bounded consume execution, optional reactive consume bridge during hostile pressure, risk-aware regeneration/golden-apple defensive combat prep with immediate-survival priority over offensive buffs, offensive potion buffs gated by engage posture while survival potions remain available in flee-only mode, no-engage while reactive consume is active, and idempotent critical-health logout with active item-use cancellation, emergency quit failure telemetry, and token-acquire failure isolation' },
  { category: 'executor timeout handling', evidence: 'test/offline/executor_timeout.test.js', status: 'offline covered for hung-skill terminal timeout failure, stable timeout reason, pathfinder signal unbinding, aborting the in-flight skill signal on timeout, and late post-timeout result/rejection telemetry without emitting success or queue-empty' },
  { category: 'container cleanup', evidence: 'test/offline/container_close.test.js, test/offline/storage_memory.test.js, test/offline/storage_withdrawal_observability.test.js, test/offline/skill_runtime_failure.test.js', status: 'offline covered for close failure logging, bounded close-timeout cleanup, bounded open-timeout handling, bounded deposit/withdraw transfer timeouts, abortable open/transfer preempt handling, deposit open/transfer timeout failures, and known-storage open/transfer timeout/preempt failures' },
  { category: 'structured logging shape', evidence: 'test/offline/logger_shape.test.js', status: 'offline covered for required base log fields' },
  { category: 'offline test report preservation', evidence: 'scripts/run-offline-tests.js, scripts/report-preservation.js, test/offline/report_preservation.test.js', status: 'offline covered for preserving tracked public report artifacts across unit tests that invoke report-writing CLIs with temporary response directories, with test files executed serially so shared public report assertions cannot race each other; deterministic eval remains the command that intentionally refreshes public evidence reports' },
  { category: 'observe snapshot interface', evidence: 'test/offline/snapshot_observe_context.test.js', status: 'offline covered for reactive state, current skill, queue length, compact recent execution events, compact task timing/deadline/return-budget context, optional miningProgression tool-upgrade context with field-kit/workstation reasoning, task-context failure isolation, pathfinder state, pathfinder-context read failure isolation, nearby hostiles, active effects, hazard flags, compact combat-risk-aware consumable-policy recommendations that avoid redundant active potion buffs, and inventory summary failure status' },
  { category: 'advisor planner boundary', evidence: 'test/offline/advisor_mock_e2e.test.js, test/offline/advisor_agent.test.js, test/offline/advisor_planner.test.js, test/offline/advisor_prompts.test.js, test/offline/advisor_context.test.js, test/offline/deepseek_request.test.js, test/offline/deepseek_run_gate.test.js, test/offline/deepseek_preflight.test.js, test/offline/advisor_feedback_log.test.js', status: 'offline covered for mocked end-to-end AdvisorAgent plus real planner repair/activation/replan flow without DeepSeek calls, explicit DeepSeek advisor run opt-in gating and entrypoint safe-stop for the legacy phase3 calibration plus main goal mode, env/default-only no-API DeepSeek preflight with no secret echo, initial planner exception isolation, queue-failure listener registration/cleanup failure isolation, pre-enqueue activation rejection for unsafe/stale plans, replan exception isolation after queue failure, structured advisor failure results, opt-in snapshot context forwarding for compact world-model summaries, default no-context behavior preservation, JSON-safe context envelopes with skill contract/activation key/safety reasons/allowedSkillNames/blockedSkillNames, prompt instructions to obey activation.allowedSkillNames and avoid activation.blockedSkillNames, bounded context sanitization diagnostics, pure planner message helpers, pure DeepSeek-style response classification, strict json_object request shaping, no-secret DeepSeek config readiness status, a proposal-only interface manifest documenting compact world-model, optional miningProgression/field-kit preflight reasoning, non-authoritative advisor feedback logging, and combatOverview recommendedTarget/lastRangedFire follow-up state plus the combatOverview activation gate, runtime-only skill repair/rejection without exposing recover_drops, smelt, or mine_with_progression in the prompt, and no executor activation when initial planning, activation, or failure-listener setup throws' },
  { category: 'advisor cost ceiling', evidence: 'src/advisor/cost_guard.js, src/advisor/deepseek.js, src/advisor/agent.js, test/offline/advisor_cost_guard.test.js, test/offline/advisor_agent.test.js, test/offline/config_example.test.js', status: 'offline covered for MCBOT_ADVISOR_COST_USD_MAX defaults, configurable token-rate accounting, per-call/session cost metrics, 50% prefer-last-plan state, 90% new-call refusal, 100% advisor-budget-exhausted logout scheduling after the current skill, and structured cost telemetry without DeepSeek calls' },
  { category: 'advisor live-plan reporter', evidence: 'scripts/advisor-live-plan.js, test/offline/advisor_live_plan_reporter.test.js, src/goal/phase_shift_readiness.js, reports/advisor-live-plan.json', status: 'offline covered for the F2 Regime A live wrapper, exact reports/advisor-live-plan.json phase-shift schema, structured runtime-log parsing, accepted-step and skill-failure false-green rejection, startup RCON setup response capture, costCeilingGuard verification capture, targeted induced-hostile cleanup after observed FLEEING, and RCON fire-resistant-zombie hostile induction planning; F2 is live-proven on the private Regime A server through a real DeepSeek plan that gathered 10 oak logs, survived an induced hostile flee, resumed, and completed cleanly' },
  { category: 'c1 humanization boundary', evidence: 'src/humanization/humanizer.js, src/runtime/idle_humanization.js, src/bot.js, src/control/pathfinder.js, src/reactive/reactive.js, src/skills/_pathing.js, src/skills/fish_until.js, src/skills/consume.js, src/skills/equip.js, test/offline/humanization_invariants.test.js, test/offline/pathfinder_owner.test.js, test/offline/humanization_action_boundary.test.js, test/offline/humanization_idle.test.js, test/offline/collect_abort.test.js, test/offline/fish_until_skill.test.js, test/offline/reactive_water.test.js, test/offline/consume_skill.test.js, test/offline/skill_result_shape.test.js, test/offline/reactive_flee.test.js, test/offline/config_example.test.js', status: 'offline covered for an opt-in MCBOT_HUMANIZE boundary with smoothstep curved aim plans, bounded micro-correction, 70ms click cadence checks, item/equip/consume/dig activation wrappers, movement-control chokepoints, no-goal idle micro-behaviors (look_at_sky, scenery_glance, hop_in_place, inventory_flip), static GoalNear path lane-bias entropy that preserves original completion semantics, collectBlock collection-start intent, source-level runtime action boundary guarding, attack/interact reach fail-closed validation, critical-survival exemption telemetry, reactive lookAt, water-bucket placement and pickup activation, ranged look, fishing cast/reel/equip plus water-rescue controls, reactive water-escape controls, skill equip/consume, reactive combat equip, consume/reactive item-use cancellation, shield/ranged item use, and PvM attack handoff; live behavior, third-party collectBlock low-level dig internals, and broader active movement style remain pending' },
  { category: 'c2 anti-cheat invariants', evidence: 'src/humanization/humanizer.js, test/offline/humanization_invariants.test.js, test/offline/reactive_water.test.js, test/offline/fish_until_skill.test.js', status: 'offline covered for fail-closed vanilla invariants on rotation rate, per-tick aim, attack/interact reach, click intervals, walk/sprint movement speed, jump initial velocity/gravity, forbidden cheat flags such as NoFall, impossible pitch, and movement-control chokepoint validation for water rescue/escape; these validators are not yet connected to every future movement-emitting humanized action' },
  { category: 'advisor F3 calibration', evidence: 'scripts/advisor-f3-calibration.js, data/advisor-dry-run/recorded-core.json, reports/advisor-f3-calibration.json, reports/advisor-f3-replay.json, reports/advisor-f3-response-capture-guard.json', status: f3ReplayReport?.ok === true && (f3ReplayReport.presentCount || 0) >= 5 ? `live-proven for ${f3ReplayReport.presentCount} real DeepSeek calibration responses with strict replay and private capture guard` : 'scaffolded for post-F2 multi-tier DeepSeek response capture; pending real captured responses until npm run advisor:f3 is executed with explicit capture env' },
  { category: 'advisor queue proposal staging', evidence: 'test/offline/advisor_queue_proposal.test.js, test/offline/advisor_context.test.js', status: 'offline covered for a future background-advisor queue replacement helper that validates plans against a fresh activation snapshot before calling executor.requestQueueReplacement, rejects unsafe/stale proposals before executor mutation, reports executor staging failures, and documents the helper in the proposal-only interface manifest' },
  { category: 'advisor feedback and postmortem sink', evidence: 'src/advisor/feedback_log.js, data/advisor-feedback/.gitignore, test/offline/advisor_feedback_log.test.js, test/offline/advisor_context.test.js', status: 'offline covered for non-authoritative deterministic-gap, feature-request, strategy-lesson, and postmortem-lesson entries, JSONL append persistence under ignored runtime data, secret redaction, bounded evidence/snapshot sanitization, human-review requirement, and manifest documentation that feedback has no execution authority' },
  { category: 'advisor dry-run calibration', evidence: 'src/advisor/dry_run_calibration.js, src/advisor/first_call_request_summary.js, src/advisor/first_call_capture_pack.js, src/advisor/first_call_capture_run.js, src/advisor/first_call_response_intake.js, src/advisor/response_capture_guard.js, data/advisor-dry-run/recorded-core.json, scripts/advisor-dry-run.js, scripts/advisor-first-call.js, scripts/advisor-first-call-replay.js, scripts/advisor-response-capture-guard.js, reports/advisor-dry-run.json, reports/advisor-first-call.json, reports/advisor-first-call-replay.json, reports/advisor-response-capture-guard.json, reports/capability-matrix.json, test/offline/advisor_dry_run_calibration.test.js, test/offline/advisor_first_call.test.js, test/offline/advisor_first_call_replay.test.js, test/offline/advisor_response_capture_guard.test.js', status: 'offline covered for recorded-snapshot advisor dry-run calibration, collapsed no-API advisor:first-call gate, private response intake/replay, public-report leak guard, and generated capability evidence without the deleted preflight/handoff/sequence/readiness/promotion ladder scripts' },
  { category: 'phase-shift readiness', evidence: 'src/goal/phase_shift_readiness.js, reports/phase-shift-readiness.json, reports/phase-shift-readiness.md, test/offline/phase_shift_readiness.test.js', status: 'offline covered for the F1+F2 deterministic-to-SOTA phase gate, DeepSeek default-off invariant, optional strict readiness evidence, advisor boundary evidence, dry-run benchmark evidence, live J/K proof-or-documented-block status, docs status, and post-gate workstreams' },
  { category: 'current goal structure', evidence: 'src/goal/current_goal.js, test/offline/goal_structure.test.js, reports/deterministic-eval.json, reports/deterministic-eval.md', status: 'offline covered for resolving the active goal phase from phase-shift evidence, enforcing the stop-broad-polishing flag, preserving the ordered SOTA-track workstreams, and carrying an evidence-backed phase-shift execution checkpoint plan' },
  { category: 'advisor plan activation guard', evidence: 'test/offline/plan_guard.test.js, test/offline/advisor_agent.test.js, test/offline/advisor_context.test.js', status: 'offline covered for schema-first rejection, runtime-only skill rejection, unsafe-snapshot normal-task rejection, observe/flee/logout/consume survival allowance plus explicit activation allowed/blocked skill lists, low-health consume activation, mixed survival-plus-normal unsafe rejection, compact snapshot keys including combatOverview threat signatures, recommended target signatures, and last ranged verification outcome signatures, combatOverview safety propagation into advisor context, proposal-vs-current staleness reasons, and AdvisorAgent pre-enqueue activation enforcement' },
  { category: 'observe world-model ingest', evidence: 'test/offline/observe_world_model_ingest.test.js', status: 'offline covered for bounded visible-world ingest into WorldModelStore, repeated-observation compaction, best-effort sampling/store failure isolation, abortable chunk waits, and sampling/store abort-as-preempt classification' },
  { category: 'skill schema validation', evidence: 'test/offline/skill_schema.test.js, test/offline/executor_queue.test.js', status: 'offline covered for rejecting circular/non-JSON skill params, unknown top-level params, wrong declared param types, invalid numeric ranges/counts, consume potion/effect gates, executor-valid but advisor-forbidden runtime-only recover_drops and smelt calls, recover_drops coordinate/wait controls, smelt input/output/furnace/wait controls, build_from_schematic calls without explicit dryRun:true, malformed deposit item entries, malformed coordinate objects, malformed inline schematic blocks/objects, and multiple oneOf target forms with plan bad-index reporting and safe invalid-call logging before enqueue' },
  { category: 'skill result shapes', evidence: 'test/offline/skill_result_shape.test.js', status: 'offline covered for fast success/failure paths across deterministic skill vocabulary, including equip deterministic lowest-slot selection, equip, consume, and smelt unknown-item fail-fast behavior, logout quit-hook failures, logout abort-as-preempt classification, and recover_drops dimension mismatch failure shape' },
  { category: 'skill runtime failures', evidence: 'test/offline/skill_runtime_failure.test.js, test/offline/consume_skill.test.js', status: 'offline covered for goto noPath exclusion, goto protected-target skip, pathfinder acquire failure normalization across goto/collect/deposit/craft/storage/flee, pathfinder setGoal failure normalization across goto/deposit/craft/storage/flee, goto movement setup fail-closed behavior, goto block world-query failure isolation and scan abort-as-preempt classification, collect no-drop, collectBlock synchronous failure normalization, collect pickup-wait abort-as-preempt classification, collect movement setup fail-closed behavior, collect target-validation and block-scan world-query failure isolation, collect block-scan abort-as-preempt classification, collect/deposit/craft/equip/build/consume inventory-read failures, skill pathfinder release failure visibility, deposit movement setup fail-closed behavior, deposit chest scan and locked-recheck world-query failure isolation, deposit chest scan abort-as-preempt classification, deposit open/transfer/short/target-gone failures, deposit hung-open abort-as-preempt classification, deposit transfer-preempt single-close behavior, deposit transfer abort-as-preempt classification, craft recipe lookup failure normalization, craft movement setup fail-closed behavior, craft table scan and locked-recheck world-query failure isolation, craft table scan abort-as-preempt classification, craft execution/walk/table-gone failures, craft execution timeout telemetry, craft execution abort-as-preempt classification, hung craft operation abort-as-preempt behavior, storage withdrawal movement setup fail-closed behavior, advisor-flee terminal pathing and movement setup failures, equip failure plus equip timeout/preempt telemetry, and consume timeout/preempt held-item deactivation' },
  { category: 'consumable execution', evidence: 'test/offline/consume_skill.test.js', status: 'offline covered for bounded deterministic consume skill execution, lowest-slot normal food selection, potion opt-in with effect/min-level selection, enchanted-golden-apple opt-in, unsupported-item refusal, active item-use refusal, inventory-read failure reporting, and held-item deactivation on timeout or reactive preempt' },
  { category: 'storage/workstation do-not-touch policy', evidence: 'test/offline/storage_workstation_policy.test.js', status: 'offline covered for deposit chest and craft table target skip, all-protected failure, and locked target revalidation' },
  { category: 'storage memory recording', evidence: 'test/offline/storage_memory.test.js', status: 'offline covered for normalizing observed chest contents, updating storage sightings, advisor summary contents, deposit persistence hook, and deposit container close failure visibility' },
  { category: 'craft storage withdrawal', evidence: 'test/offline/craft_storage_withdrawal.test.js, test/offline/storage_withdrawal_observability.test.js, test/offline/skill_runtime_failure.test.js', status: 'offline covered for recipesAll ingredient planning, known-storage withdrawal, unknown-item rejection before walking to storage, partial-inventory shortfall withdrawal, full requested craft-count staging, structured withdrawal observability, storage movement setup fail-closed behavior, storage block-check world-query failure isolation, storage open/block-check/transfer abort-as-preempt classification including hung-open aborts, storage container close failure visibility, recursive dependency crafting, dependency craft operation timeout/preempt failure, storage-memory update, protected-storage skip with alternate selection, protected-only missing report, and missing-ingredient failure' },
  { category: 'storage-backed craft scenario', evidence: 'test/offline/storage_backed_craft_scenario.test.js', status: 'offline executor-level scenario covered for observe-craft-observe queue execution with worldModelStore context, storage-walk preempt/resume retry, hostile-flee storage-walk preempt/resume, storage-walk water-stall failure, protected-storage skip, recursive dependency crafting, and storage-memory save' },
  { category: 'inventory and material planning', evidence: 'test/offline/materials.test.js, test/offline/mine_until_skill.test.js', status: 'offline covered for inventory counts, unavailable-inventory reporting, shortfalls, storage lookup/withdrawal planning, recipe requirements, recursive crafting expansion, block tool requirements, visible-ore tool gating in mine_until, deterministic mining tool-upgrade progression planning, mining field-kit/workstation carry preflight reasoning, optional iron-sword upgrade gating, and fuel/smelting planning' },
  { category: 'runtime-only smelting execution', evidence: 'src/skills/smelt.js, test/offline/smelt_skill.test.js, test/offline/skill_schema.test.js, test/offline/skill_result_shape.test.js', status: 'offline covered for inventory-backed furnace input/fuel loading, deterministic single-fuel selection, locked furnace target selection, occupied-slot refusal, bounded open/transfer/output waits, close cleanup, output-wait preempt/resume without reloading input/fuel, runtime-only schema gating, and advisor prompt exclusion' },
  { category: 'runtime-only mining progression mission', evidence: 'src/skills/mine_with_progression.js, test/offline/mine_with_progression_skill.test.js, test/offline/skill_schema.test.js, test/offline/skill_result_shape.test.js', status: 'offline covered for runtime-only collect/mine/smelt/craft/equip/final-mine composition, locked compiled mission calls in callState, same-step resume after preempt without rerunning completed prep, optional iron-sword readiness handling, final mine_and_return selection when returnChest is provided, self-contained field-kit blocking mode, runtime-only schema gating, and advisor prompt exclusion; live progression is pending' },
  { category: 'build dry-run planning', evidence: 'test/offline/build_plan.test.js, test/offline/build_from_schematic_skill.test.js', status: 'offline covered for schematic block normalization, constrained JSON and Sponge .schem file loading with malformed-block rejection, registry-backed unknown block-name rejection, BOM, placement ordering, missing materials, world-model storage withdrawal planning, protected-storage exclusion, obstructions, hazards, support checks, do-not-touch policy checks, world-read failure/preempt classification, and explicit dry-run skill boundary' },
  { category: 'death/drop recovery policy', evidence: 'src/runtime/death_recovery.js, src/skills/recover_drops.js, src/bot.js, test/offline/death_recovery.test.js, test/offline/bot_logging.test.js, test/offline/recover_drops.test.js', status: 'offline covered for player-caused death abandonment, lava/fire/void destructive-death abandonment, one close non-destructive recovery decision, far-drop abandonment, death-during-recovery abandonment, recent damage-source capture, current-task capture, inventory snapshot capture, bot death log recovery classification, explicit recover_drops skill boundary for one bounded travel-and-pickup attempt with tighter pickup radius, pickup-delta settling, visible item-entity sweep telemetry, and recoverable-respawn queue-prefix scheduling; live H proves one fall-damage recovery on the private server' },
  { category: 'live scenario harness', evidence: 'scripts/live-scenarios.js, scripts/live-suite.js, scripts/live-phase2.js, test/offline/live_scenarios.test.js, test/offline/live_flee_metrics.test.js, test/offline/live_hostile_escalation_plan.test.js, test/offline/live_pvm_escalation_plan.test.js, test/live_server_smoke.js, test/live_supply_chest_inspect.js, test/live_supply_chest_equip.js, test/live_phase2_collect_deposit_fixture.js, test/live_single_hostile_flee_fixture.js, test/live_flee_metrics.js, test/live_supply_chest_fishing_fixture.js, test/live_mining_soak_fixture.js, test/live_death_recovery_fixture.js, test/live_single_hostile_engage_fixture.js, test/live_hostile_escalation_fixture.js, test/live_pvm_escalation_decision_fixture.js, reports/live-evidence.json', status: 'offline covered for ordered A-K scenario manifest invariants, explicit live opt-in skip behavior, unknown-scenario rejection before Mineflayer import, live smoke snapshot, authorized chest inspect with far-unloaded target chunk recheck, controlled withdraw/equip including inventory-carried tool fallback, gated collect/deposit fixture, authorized chest non-placeable hand fallback, single-hostile pre-import required-env gating, strict hostile fixture preconditions, optional bounded hostile wait metadata, E clear-before-import plus post-staging RCON hostile summon metadata, E near-bot hostile spawn controls, fixture-entity tracking separate from unrelated hostiles, single-hostile state/water-churn metrics, fishing fixture, mining soak fixture, death/drop recovery fixture with optional post-arm admin fall-damage control, opt-in single-hostile PvM engage fixture gating with pre-gear and post-gear safe staging plus post-gear near-bot admin summon controls, gated RCON hostile escalation plan/scenario metadata for one-three-four fire-resistant zombie waves, and gated RCON PvM engage-to-flee escalation metadata for one zombie then three close zombies with too-many-hostiles policy checks; A-D/E/F/G/H/I are live-proven on the private server for their controlled fixtures, and J/K are now live-proven through sanitized private-log evidence' },
  { category: 'live admin fixture commands', evidence: 'scripts/live-admin.js, scripts/live-admin-commands.js, scripts/live-suite.js, test/offline/live_admin_commands.test.js, test/offline/live_scenarios.test.js', status: 'offline covered for explicit private-server admin command planning, clear/summon/single-hostile fixture setup including fire-resistant zombie variants, bounded fire-resistant zombie wave fixture setup, targeted kill-zombies-near cleanup, death-recovery fall-damage control, give-item command planning, dry-run behavior without secrets, RCON env gating, raw-command double gate, injected transport execution, CLI refusal before live/admin opt-in, and live-wrapper setup-only fixture dry runs for E/I/J-style hostile tests' },
  { category: 'reactive hostile flee/combat guardrail', evidence: 'test/offline/flee_goal.test.js, test/offline/reactive_flee.test.js, test/offline/reactive_startup.test.js, test/offline/combat_policy.test.js, test/offline/live_hostile_escalation_plan.test.js', status: 'offline covered for FleeGoal liveness, aggregate threat-field heuristic, enter/exit hysteresis, multi-hostile nearest selection, non-hostile filtering, locked-target anti-flip behavior, close-threat flee replanning, reactive movement setup failure isolation, hazard-safe movement exclusions, pathfinder goal-install failure telemetry, PVP stop failure telemetry, pathfinder-context read isolation, tracking shape, deterministic melee weapon selection before engage, armor-score engage gating, active Strength-aware melee offense/kill-window estimates, multi-hostile clear-time kill-window gates, active regeneration/absorption defensive survival buffers, live reactive active-effect propagation into engage/flee risk, optional shield-required engage gating with bounded off-hand shield equip, optional active off-hand shield blocking with release/busy-use guards, ranged/special hostile no-melee policy including bogged, mixed threat-set vetoes for creepers/players/ranged/special hostiles before group melee, mixed-threat ranged prep/fire binding to the unsafe creeper/ranged target instead of the nearest hostile, close-hostile pressure refusal before mixed-threat ranged actions, optional ranged weapon/ammo selection and bounded equip prep for creepers/ranged hostiles, optional line-of-sight/safe-distance gated one-shot ranged fire with bounded look/use/release plus pre-activation distance, line-of-sight, close-pressure rechecks, draw-window close-pressure cancellation, post-release ranged target verification, bounded unresolved ranged follow-up shot limits, bounded reactive weapon equip, player no-PvP default, creeper flee-over-melee policy, and a gated live hostile escalation fixture that expects flee rather than engage under one-three-four zombie pressure; live E near-bot zombie fixture is proven again for controlled single-hostile flee after close-repath telemetry fired under melee pressure' },
  { category: 'fall/tree/danger-block hazard', evidence: 'test/offline/reactive_hazard.test.js', status: 'offline covered for tree false-positive filtering, deep fall detection, direct and adjacent danger blocks including soul_fire, opt-in water-bucket placement for detected lava/fire/magma hazards with Nether refusal, one bounded water pickup recovery attempt after the placed hazard water clears, hazard world-read failure isolation, hazard stop, release-stop, token-acquire, and pathfinder-context read failure isolation, fall/eat immediate cancellation, same-tick auto-eat suppression, controller-level landing recovery, post-token auto-eat resume ordering, auto-eat resume failure retry, and active airborne fall hold until onGround; live pending' },
  { category: 'water/drowning', evidence: 'test/offline/reactive_water.test.js, test/offline/pathing_water_watchdog.test.js', status: 'offline covered for direct water/oxygen/sinking signals, stale low-oxygen ignored in readable dry air, active WATER_ESCAPE clearing on stable dry ground despite stale low oxygen, water world-read failure isolation, holding water escape until actually out of water once escape starts, threat-aware dry-land target choice, dry-land unreadable-candidate skipping, water-escape stop/control/lookAt and token-acquire failure isolation, pathfinder-context read isolation, and pathing water stalls; live pending' },
  { category: 'world model', evidence: 'test/offline/world_model.test.js', status: 'offline covered for synthetic natural terrain, house, generated-structure, storage/workstation, repeated-observation compaction, persistence, and compact summary' },
  { category: 'world model bot-visible ingest', evidence: 'test/offline/world_model_ingest_adapter.test.js', status: 'offline covered for chunksReady wait, abortable pending chunk waits, deterministic sampler limit, non-air filtering, persistence, sampling/store failure reporting, and sampling/store abort-as-preempt classification' },
  { category: 'snapshot world-model interface', evidence: 'test/offline/snapshot_world_model.test.js, test/offline/advisor_runtime_options.test.js', status: 'offline covered for opt-in advisor-facing summary, store loading, unavailable-store status, default snapshot preservation, and the helper used to pass runtime context into main/phase3 advisor snapshots' },
  { category: 'snapshot combat interface', evidence: 'test/offline/snapshot_observe_context.test.js, test/offline/combat_policy.test.js', status: 'offline covered for compact advisor-facing equipment summary, armor score, active Strength-aware melee offense, multi-hostile clear-time offense summaries, active regeneration/absorption-aware melee survival estimates, nearest hostile combat recommendation, separate mixed-threat ranged target summaries, mixed-threat unsafeThreat and closeThreatDistance refusal context, opt-in engage gates, weapon-equip recommendation, engage recommendation, shield-block recommendation, combatOverview threat-level/advisor-priority/replan-trigger/recommendedTarget summaries for clear, grouped, stacked close-hostile pressure, distant explosive pressure, close explosive critical pressure, and compact lastRangedFire verification outcome plus follow-up count summaries without enabling live combat by default' },
  { category: 'world-model policy helpers', evidence: 'test/offline/world_model_policy.test.js', status: 'offline covered for do-not-touch checks, modification denial, nearest resource lookup, storage filters, and accessible-storage filtering' },
  { category: 'human oversight viewer and handoff', evidence: 'docs/oversight-handoff.md', status: 'documented for read-only local viewer direction, persistent disconnected viewer behavior, client handoff architecture options, and explicit non-goals around public-server/anti-cheat-sensitive control' },
];

const remainingRisks = [
  'Live Minecraft behavior is verified only when explicitly run with MCBOT_LIVE_TESTS=1; the live wrapper now has ordered A-K scenarios for smoke, authorized chest inspect, controlled withdraw/equip, fixture collect/deposit, safe-gated single-hostile flee, fishing, mining soak, manual death/drop recovery, opt-in single-hostile PvM engage, RCON hostile escalation, and RCON PvM engage-to-flee escalation fixtures.',
  'Private-server admin fixture commands are available and have been executed through RCON for clear/summon/time setup on the private server; actual use remains gated by MCBOT_LIVE_TESTS=1, MCBOT_LIVE_ADMIN_OK=1, MCBOT_RCON_PASSWORD, and local/private server assumptions.',
  'Compact task timing/deadline/return-budget context, a shared mission profile validator, dynamic return-plan estimates, and a shared mission loop are now available to snapshots plus the mining and fishing live fixtures, including deterministic continue/deposit/return/stop decisions and resume-after-deposit execution; reusable multi-hour fishing/mining skills with durability checks, richer movement, live route-quality validation, and exact arrival behavior remain to be built and live validated.',
  'Bot startup plugin load fail-fast telemetry, lifecycle logging listener registration failure isolation, and death recovery classification logging with current-task and inventory snapshots are covered with mocked emitters/plugins; live H now verifies the Mineflayer death/respawn scheduling path for one fall-damage recovery, while broader live startup/death causes remain unverified.',
  'Main runtime startup and shutdown listener/cleanup failure visibility are covered with deterministic helpers, but live OS signal delivery, Mineflayer spawn behavior, and Mineflayer shutdown behavior remain unverified.',
  'Executor timeout knobs, including the bounded consume operation timeout, are now covered in config.example.json by an offline drift test, but broader configuration example completeness still depends on adding focused coverage when new top-level knobs are introduced.',
  'PathfinderOwner and SkillExecutor now have mocked coverage for ownership/preempt/resume, owner startup event listener registration failure isolation, owner stop-failure fail-closed idle behavior, repeated same-call preempts, stale resume-gate timeout, resume-gate idle-read failure isolation, resume-gate timeout owner-read failure isolation, terminal failure semantics, boundary-only queue replacement proposals with stale-proposal discard on failure, queue-prefix insertion for recovery, active skill abort requests, advisor plan activation guard hooks, executor interrupt listener registration/removal failure isolation, and interrupt listener emission failure isolation, but broader live/cross-skill multi-failure integration remains unverified.',
  'Executor skill timeouts now abort the in-flight skill signal and ignore/log late post-timeout results or rejections; shared wrappers abort chest open/transfer plus craft/equip/consume operations on ctx.signal, but any still-unwrapped Mineflayer/plugin operation can continue external side effects until its own await returns.',
  'Skill schema validation now rejects non-JSON, unknown top-level params, wrong declared types, invalid numeric ranges/counts, recover_drops coordinate/wait mistakes, runtime-only smelt and mine_with_progression malformed calls, build_from_schematic calls without explicit dryRun:true, malformed deposit items, malformed coordinate objects, malformed inline schematic blocks/objects, and multiple oneOf target forms; file-loaded schematic block shape is validated at load time and build dry-run rejects registry-unknown block names, but live placement remains deferred.',
  'Chunk-ready gates, including fail-fast collect/goto/craft/deposit registry-target validation before pending chunk waits, chunksReady property installation failure telemetry, bounded hung spawn chunk-load timeout, respawn reset, spawn/respawn listener registration failure telemetry, chunksReady getter failure isolation, malformed chunksReady thenable isolation, abortable pending-wait behavior, abort listener fail-closed behavior, abort listener cleanup failure visibility, collect abort handling, collectBlock dry-land stall cancellation, collect stopDigging failure visibility, pathing progress watchdogs, pathing watchdog pathfinder-context read failure isolation, pathing abort listener fail-closed behavior, pathing event listener registration and cleanup failure isolation, watchdog owner-stop failure visibility, and pathing timeout stop cleanup have mocked coverage, but live collect/goto/deposit/craft behavior remains unverified.',
  'Structured skill result coverage now includes core mocked runtime failures, goto block, collect block, deposit chest, and craft table world-query failure isolation, pathfinder acquire failure normalization across goto/collect/deposit/craft/storage/flee, pathfinder setGoal failure normalization across goto/deposit/craft/storage/flee, collectBlock synchronous failure normalization, pathing movement setup fail-closed behavior across goto/collect/deposit/craft/storage/flee plus reactive flee, skill inventory-read failure isolation, craft recipe lookup failure normalization, snapshot pathfinder-context read failure isolation, pathfinder release failure visibility, container open/transfer/close failure visibility and timeout bounding, craft/equip/consume operation timeout bounding, consume active-use refusal and held-item deactivation on timeout/preempt, collect pickup-wait abort-as-preempt classification, equip deterministic selection and registry unknown-item fail-fast behavior, deposit transfer-preempt close safety, deposit/craft/storage/logout/consume abort-as-preempt classification, advisor-flee terminal pathing failure, and logout quit-hook failures; live container/crafting/equip/consume behavior still needs verification.',
  'collect/goto same-target resume, repeated-preempt exclusion, collect same-cluster preference, support-under-self avoidance, do-not-touch target avoidance, and unreadable-adjacent-hazard telemetry have mocked coverage, but live reachability/path-quality behavior remains unverified.',
  'Reactive hostile flee/combat has mocked multi-hostile selection, locked-target anti-flip, aggregate threat-field heuristic coverage, close-threat flee replanning, movement setup failure isolation, pathfinder goal-install failure telemetry, PVP stop failure telemetry, pathfinder-context read isolation, deterministic melee weapon selection, active Strength-aware melee offense/kill-window estimates, multi-hostile clear-time kill-window gates, active regeneration/absorption-aware survival buffers, live reactive active-effect propagation into engage/flee risk, bounded reactive weapon equip, optional shield-required engage gating with bounded off-hand shield equip, optional active off-hand shield blocking with release/busy-use guards, optional ranged weapon/ammo prep and line-of-sight/safe-distance gated one-shot ranged fire for creepers/ranged hostiles with pre-activation distance/line-of-sight/close-pressure safety rechecks, draw-window close-pressure cancellation, post-release target outcome logging, bounded unresolved ranged follow-up limits, and compact lastRangedFire advisor-state propagation, mixed-threat ranged prep/fire targeting that binds the action to the unsafe creeper/ranged hostile instead of the nearest hostile, close-hostile pressure refusal before mixed-threat ranged actions, player no-PvP default, creeper flee-over-melee policy, single-hostile live fixture churn metrics, compact advisor-facing combat/equipment recommendations, combatOverview threat-level/advisor-priority/replan-trigger/recommendedTarget summaries for future DeepSeek planning including close explosive pressure and non-nearest ranged targets, live J proves flee-over-engage under stacked zombie pressure, and live K proves switching from single-zombie ENGAGING to too-many-hostiles FLEEING; repeated ranged reacquisition, projectile hit guarantees, creeper-safe killing, advanced multi-hostile fighting, and PvP remain pending.',
  'Reactive health/food behavior has mocked startup bot/auto-eat listener registration failure isolation, auto-eat option setup failure isolation, low-health flee, active item-use cancellation, optional reactive consume bridge behavior, risk-aware regeneration/golden-apple defensive combat prep with immediate-survival priority over offensive buffs, offensive potion buffs gated by engage posture while survival potions remain available in flee-only mode, idempotent critical logout, emergency quit failure telemetry, and token-acquire failure isolation coverage; live low-health recovery and server reconnect behavior remain unverified.',
  'Combat preparation is not yet reliable beyond early guardrails: armor-aware engage gates, active Strength-aware kill-window estimates, multi-hostile clear-time kill-window gates, active regeneration/absorption-aware survival estimates, immediate-survival defensive prep before Strength, Strength-first prep for non-urgent kill-window risk, offensive potion buff gating, optional shield-required engage gates, optional active shield blocking, deterministic consumable recommendations, bounded consume execution, optional reactive golden-apple/potion consumption during hostile pressure, opt-in water-bucket response plus one-attempt pickup recovery for detected lava/fire/magma hazards, opt-in ranged weapon prep plus one-shot ranged fire gates and pre-activation distance/line-of-sight/close-pressure safety rechecks, draw-window close-pressure cancellation, post-release ranged target verification, and bounded unresolved follow-up limits for creepers/ranged hostiles, plus bounded shield/weapon/ranged equip/fire are offline-covered, but live water placement/pickup, live shield timing, player-threat prebuff execution, critical-health consume-vs-logout tuning, ranged kiting/reacquisition, repeated creeper kill tactics, projectile hit guarantees, and live hostile combat remain unverified.',
  'Fall/eat freeze mitigation, including same-tick auto-eat suppression, auto-eat enabled-state hazard telemetry, airborne fall-hold until onGround, controller-level landing recovery, post-token auto-eat resume ordering, auto-eat resume failure retry, reactive hazard/water world-read failure isolation, stale low-oxygen dry-land water-clear coverage, reactive stop and release-stop failure isolation, token-acquire failure isolation, water-escape lookAt failure visibility, and pathfinder-context read isolation, has deterministic offline coverage, but live Minecraft reproduction remains pending.',
  'On-fire metadata handling remains deferred pending a reliable Mineflayer signal; only detected lava/fire/magma block hazards have an offline-covered opt-in water-bucket response and one-attempt pickup recovery after hazard clear.',
  'World-model foundation has mocked ingest, direct and observe-triggered store ingest, repeated-observation compaction, sampling/store failure reporting and abort-as-preempt classification, opt-in snapshot summary with unavailable-store status, AdvisorAgent snapshot-context forwarding, runtime-context advisor option wiring for main/phase3 construction, pure policy-helper coverage, initial collect/goto/deposit/craft/build skill consumers, and mocked route-level movement exclusions; live Mineflayer ingest, real DeepSeek advisor use of that context, and live pathfinder path-quality behavior remain unverified.',
  'Deposit and craft protected target selection is mocked only; live scanning with a persisted world model remains unverified.',
  'Inventory/material planning, tool requirement planning, visible-ore tool gating in mine_until, deterministic mining tool-upgrade progression planning, mining field-kit/workstation carry preflight reasoning, optional miningProgression snapshot context, fuel/smelting planning, runtime-only smelt execution, runtime-only mine_with_progression mission composition, deposit storage-content recording, deposit/storage unknown-item fail-fast behavior, build dry-run storage consumption, and craft storage withdrawal/recursive staging have mocked and executor-level scenario coverage plus partial-inventory shortfall withdrawal, full requested craft-count staging, smelt output-wait preempt/resume, progression same-step preempt/resume, structured withdrawal observability, storage block-check world-query failure isolation, storage open/block-check/transfer abort-as-preempt classification, container close failure visibility, storage-walk preempt/resume, hostile-flee storage-walk preempt/resume, and storage-walk water-stall failure scenarios; live entrypoints now inject a WorldModelStore, but live progression/furnace/chest scanning/withdrawal verification remains pending.',
  'The advisor plan activation guard now runs as a pre-enqueue AdvisorAgent boundary for mocked/offline planning and live private calibration, rejecting unsafe normal work and stale plans before executor activation, including explicit activation allowed/blocked skill lists, prompt instructions to obey those lists, compact combatOverview escalation/staleness signals, recommended target changes, and last ranged verification outcome changes; live DeepSeek proposal evidence now covers accepted, rejected, stale, unsafe, and recovery classes.',
  'The phase-shift gate is now part of the goal structure: after F1 first live call evidence and F2 first live private-server plan evidence, the next goal should move from substrate hardening to F3 calibration, DeepSeek live calibration, benchmark ladders, long-horizon missions, combat ladders, viewer/operator UX, and publication evidence while keeping DeepSeek planner-only.',
  'build_from_schematic schema requires explicit dryRun:true and supports inline dry-run plus constrained JSON and Sponge .schem files under schematics/ with block-shape validation, registry-backed block-name rejection, and world-read failure/preempt classification; .litematic parsing and live placement remain deferred.',
  'Death/drop recovery policy now classifies player, lava/fire/void, far, and repeated-attempt deaths deterministically, records current-task/inventory evidence, has an explicit runtime-only recover_drops skill for one bounded travel-and-pickup attempt with visible item-entity sweep, schedules that skill as a queue prefix after recoverable respawns, and is live-proven for one fall-damage recovery through the gated H fixture; destructive/player-caused abandon paths remain offline-covered only.',
  'Human oversight viewer and same-client handoff are documented only; no prismarine-viewer integration, persistent viewer supervisor, Regime B Phase 1 production viewer run, or Fabric bridge has been implemented.',
];

const report = {
  generatedAt: new Date().toISOString(),
  branch: git(['branch', '--show-current']),
  head: git(['rev-parse', '--short', 'HEAD']),
  ok,
  commands: commandResults,
  scenarioCoverage,
  changedFiles,
  remainingRisks,
  phaseShift,
  goalState,
  capabilityMatrix: capabilityMatrixSummary(capabilityMatrixReport),
  live: {
    suite: process.env.MCBOT_LIVE_TESTS === '1' ? 'enabled separately via npm run test:live' : 'skipped by default; set MCBOT_LIVE_TESTS=1 for private/local live run',
    scenarios: runnableLiveScenarioIds(),
    selector: 'set MCBOT_LIVE_SCENARIO=<id> when MCBOT_LIVE_TESTS=1',
  },
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_REPORT, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(MD_REPORT, renderMarkdown(report));
fs.writeFileSync(PHASE_SHIFT_JSON_REPORT, JSON.stringify(phaseShift, null, 2) + '\n');
fs.writeFileSync(PHASE_SHIFT_MD_REPORT, renderPhaseShiftReadiness(phaseShift));

process.stdout.write(`deterministic-eval: wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}\n`);
process.stdout.write(`deterministic-eval: wrote ${path.relative(ROOT, PHASE_SHIFT_JSON_REPORT)} and ${path.relative(ROOT, PHASE_SHIFT_MD_REPORT)}\n`);
process.exit(ok ? 0 : 1);

function renderMarkdown(report) {
  const lines = [
    '# Deterministic Eval',
    '',
    `Generated: ${report.generatedAt}`,
    `Branch: \`${report.branch}\``,
    `Head: \`${report.head}\``,
    `Overall: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    '## Commands',
    '',
    '| Name | Category | Result | Duration |',
    '|---|---|---:|---:|',
  ];
  for (const command of report.commands) {
    lines.push(`| \`${command.name}\` | ${command.category} | ${command.ok ? 'PASS' : 'FAIL'} | ${command.durationMs}ms |`);
  }

  lines.push('', '## Scenario Coverage', '');
  for (const scenario of report.scenarioCoverage) {
    lines.push(`- ${scenario.category}: ${scenario.status} (${scenario.evidence})`);
  }

  lines.push('', '## Changed Files', '');
  if (report.changedFiles.length === 0) {
    lines.push('- none');
  } else {
    for (const file of report.changedFiles) lines.push(`- ${file}`);
  }

  lines.push('', '## Remaining Risks', '');
  for (const risk of report.remainingRisks) lines.push(`- ${risk}`);

  lines.push('', '## Phase Shift', '');
  lines.push(`- current phase: ${report.phaseShift.currentPhase}`);
  lines.push(`- ready for SOTA track: ${report.phaseShift.ready ? 'yes' : 'no'}`);
  lines.push(`- no DeepSeek API call made: ${report.phaseShift.noDeepSeekApiCall ? 'yes' : 'unknown'}`);
  for (const gateResult of report.phaseShift.gates) {
    const status = gateResult.satisfied ? gateResult.status : 'pending';
    lines.push(`- ${gateResult.id}: ${status}`);
  }

  lines.push('', '## Current Goal State', '');
  lines.push(`- goal: ${report.goalState.goalId}`);
  lines.push(`- active phase: ${report.goalState.activePhase}`);
  lines.push(`- stop broad polishing: ${report.goalState.stopBroadPolishing ? 'yes' : 'no'}`);
  lines.push(`- next action: ${report.goalState.nextAction}`);
  if (report.goalState.currentWorkstream) {
    lines.push(`- current workstream: ${report.goalState.currentWorkstream.id}`);
  }
  if (report.goalState.phaseShiftMandate) {
    lines.push(`- phase shift mandate: ${report.goalState.phaseShiftMandate.whenReady}`);
    lines.push(`- workstream rule: ${report.goalState.phaseShiftMandate.workstreamRule}`);
    lines.push(`- achievement definition: ${report.goalState.phaseShiftMandate.achievementDefinition}`);
    lines.push(`- checkpoint rule: ${report.goalState.phaseShiftMandate.checkpointRule}`);
  }
  if (Array.isArray(report.goalState.currentWorkstreamExitCriteria)
    && report.goalState.currentWorkstreamExitCriteria.length > 0) {
    lines.push('- active workstream done when:');
    for (const criterion of report.goalState.currentWorkstreamExitCriteria) {
      lines.push(`  - ${criterion}`);
    }
  }
  if (report.goalState.currentPhaseShiftCheckpoint) {
    lines.push(`- active phase-shift checkpoint: ${report.goalState.currentPhaseShiftCheckpoint.id}`);
    lines.push(`- checkpoint objective: ${report.goalState.currentPhaseShiftCheckpoint.objective}`);
  }
  if (Array.isArray(report.goalState.phaseShiftExecutionPlan)
    && report.goalState.phaseShiftExecutionPlan.length > 0) {
    lines.push('- phase-shift execution plan:');
    for (const checkpoint of report.goalState.phaseShiftExecutionPlan) {
      const checkpointNextAction = checkpoint.nextAction ? `; next=${checkpoint.nextAction}` : '';
      lines.push(`  - ${checkpoint.priority}. ${checkpoint.id}: ${checkpoint.status} (${checkpoint.workstreamId}); ${checkpoint.completionReason || 'no completion evidence'}${checkpointNextAction}`);
    }
  }
  lines.push(`- allowed work: ${report.goalState.allowedWorkKinds.join(', ')}`);
  if (Array.isArray(report.goalState.disallowedWorkKinds)
    && report.goalState.disallowedWorkKinds.length > 0) {
    lines.push(`- disallowed work after phase shift: ${report.goalState.disallowedWorkKinds.join(', ')}`);
  }
  if (Array.isArray(report.goalState.sotaTrackOutcomeTargets)
    && report.goalState.sotaTrackOutcomeTargets.length > 0) {
    lines.push('- SOTA outcome targets:');
    for (const target of report.goalState.sotaTrackOutcomeTargets) {
      lines.push(`  - ${target.id}: ${target.objective}`);
    }
  }

  lines.push('', '## Capability Matrix', '');
  if (report.capabilityMatrix) {
    lines.push(`- artifact: ${report.capabilityMatrix.artifact}`);
    lines.push(`- no DeepSeek/API call made: ${report.capabilityMatrix.noApiCall ? 'yes' : 'unknown'}`);
    lines.push(`- total capabilities: ${report.capabilityMatrix.total}`);
    for (const [status, count] of Object.entries(report.capabilityMatrix.byStatus || {})) {
      lines.push(`- ${status}: ${count}`);
    }
  } else {
    lines.push('- missing: run npm run capability:matrix');
  }

  lines.push('', '## Live', '', `- suite: ${report.live.suite}`);
  lines.push(`- scenarios: ${report.live.scenarios.join(', ')}`);
  lines.push(`- selector: ${report.live.selector}`, '');
  return lines.join('\n');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function documentedLiveBlock(scenarioId, requiredEnv) {
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return {
      documentedBlocked: true,
      reason: `${scenarioId} not run in deterministic-eval; missing env in this process: ${missing.join(', ')}. Exact private-server command is documented in docs/status.md.`,
    };
  }
  return {
    documentedBlocked: false,
    reason: `${scenarioId} env appears present, but deterministic-eval does not run live RCON scenarios. Run npm run test:live with MCBOT_LIVE_SCENARIO=${scenarioId} and record the result.`,
  };
}

function phaseShiftDocsStatus() {
  return {
    goalNamesPhaseShift: fileIncludes(path.join(ROOT, 'docs', 'goal.det-autonomy-v1.md'), 'Phase Shift Gate'),
    statusNamesPhaseShift: fileIncludes(path.join(ROOT, 'docs', 'status.md'), 'phase-shift readiness'),
  };
}

function f4DocsStatus() {
  return {
    status: 'f4_sota_track_started',
    statusDocsUpdated: fileIncludes(path.join(ROOT, 'docs', 'status.md'), 'F4 SOTA-track entry marker'),
    progressDocsUpdated: fileIncludes(path.join(ROOT, 'docs', 'codex-progress.md'), 'F4 SOTA Entry'),
  };
}

function advancePhaseShiftWorkstreamIfReady(report, evidence = {}) {
  const f3Replay = evidence.f3Replay || {};
  const f3Guard = evidence.f3ResponseCaptureGuard || {};
  const f4 = evidence.f4 || {};
  const advisorLiveCalibration = evidence.advisorLiveCalibration || {};
  const f3Complete = f3Replay.ok === true
    && f3Replay.status === 'validated_model_responses'
    && Number(f3Replay.presentCount || 0) >= 5
    && Number(f3Replay.responseMetricsIncompleteCount || 0) === 0
    && f3Guard.ok === true;
  const f4Complete = f4.status === 'f4_sota_track_started'
    && f4.statusDocsUpdated === true
    && f4.progressDocsUpdated === true;
  if (!report || report.ready !== true || !f3Complete || !f4Complete) return report;

  const liveCalibrationComplete = advisorLiveCalibration.ok === true
    && advisorLiveCalibration.status === 'live_calibration_complete'
    && advisorLiveCalibration.safety?.allLiveEvidenceNoBypass === true
    && ['accepted', 'rejected', 'stale', 'unsafe', 'recovery'].every((proposalClass) => (
      advisorLiveCalibration.summary?.liveProvenClasses || []
    ).includes(proposalClass));
  const ladderComplete = benchmarkLadderComplete(evidence.benchmarkLadder);
  const activeId = liveCalibrationComplete
    ? ladderComplete ? 'long_horizon_missions' : 'benchmark_ladder'
    : 'deepseek_gated_live_calibration';
  const active = (report.workstreams || []).find((workstream) => workstream.id === activeId);
  const activePriority = active?.priority || 0;
  const workstreams = (report.workstreams || []).map((workstream) => ({
    ...workstream,
    status: workstream.id === activeId
      ? 'active'
      : workstream.priority < activePriority
        ? 'complete'
        : 'queued',
  }));
  return {
    ...report,
    workstreams,
    nextWorkstream: workstreams.find((workstream) => workstream.id === activeId) || report.nextWorkstream,
    transition: {
      ...(report.transition || {}),
      nextAction: activeId,
    },
  };
}

function liveEvidenceFor(report, scenarioId) {
  const scenario = report?.scenarios?.[scenarioId];
  if (!scenario || scenario.liveProven !== true) return null;
  return {
    liveProven: true,
    evidence: [
      scenario.evidence,
      scenario.logPath ? `log=${scenario.logPath}` : null,
      Number.isFinite(scenario.exitCode) ? `exit=${scenario.exitCode}` : null,
    ].filter(Boolean).join(' '),
  };
}

function fileIncludes(filePath, needle) {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function capabilityMatrixSummary(report) {
  if (!report || typeof report !== 'object') return null;
  return {
    artifact: 'reports/capability-matrix.md',
    noApiCall: report.noApiCall === true,
    total: report.summary?.total || 0,
    byStatus: report.summary?.byStatus || {},
  };
}
