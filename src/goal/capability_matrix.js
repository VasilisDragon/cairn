export const CAPABILITY_STATUSES = Object.freeze({
  LIVE_PROVEN: 'live-proven',
  OFFLINE_COVERED: 'offline-covered',
  SCAFFOLDED: 'scaffolded',
  PENDING: 'pending',
});

export const CAPABILITY_STATUS_ORDER = Object.freeze([
  CAPABILITY_STATUSES.LIVE_PROVEN,
  CAPABILITY_STATUSES.OFFLINE_COVERED,
  CAPABILITY_STATUSES.SCAFFOLDED,
  CAPABILITY_STATUSES.PENDING,
]);

const CAPABILITY_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'deterministic_regression_baseline',
    category: 'baseline',
    claim: 'Default deterministic checks cover syntax, offline unit coverage, pathfinder ownership grep, advisor dry-run reports, and generated eval artifacts.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'npm run check',
      'npm run test:unit',
      'npm run test:grep',
      'npm run test:det',
      'reports/deterministic-eval.md',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Live behavior is still opt-in and must be proven per scenario.',
    ]),
    nextCommand: 'npm run test:all',
  }),
  Object.freeze({
    id: 'pathfinder_executor_substrate',
    category: 'movement',
    claim: 'Pathfinder ownership, skill preemption, queue resume, watchdogs, and structured failure paths are covered through deterministic tests.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'test/offline/pathfinder_owner.test.js',
      'test/offline/executor_queue.test.js',
      'test/offline/pathing_water_watchdog.test.js',
      'test/offline/skill_runtime_failure.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Cross-skill live path quality remains scenario-specific.',
    ]),
    nextCommand: 'npm run test:unit',
  }),
  Object.freeze({
    id: 'account_regime_control',
    category: 'account',
    claim: 'Account behavior is explicitly split between Regime A offline MCBot testing and Regime B user-account Microsoft auth.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/account_regime.js',
      'src/config.js',
      'src/bot.js',
      'scripts/live-scenarios.js',
      'scripts/live-suite.js',
      'test/offline/account_regime.test.js',
      'test/offline/bot_logging.test.js',
      'test/offline/live_scenarios.test.js',
      'test/offline/config_example.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Regime B is configured and guarded but not used for live runs before post-F4 viewer work.',
      'Same-client handoff still requires the later Fabric bridge workstream.',
    ]),
    nextCommand: 'node --test test/offline/account_regime.test.js test/offline/bot_logging.test.js test/offline/live_scenarios.test.js',
  }),
  Object.freeze({
    id: 'operator_logout_control',
    category: 'operator-control',
    claim: 'The operator can reclaim control through an authorized !logout chat command or CLI signal graceful shutdown.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/runtime/user_control.js',
      'src/runtime/shutdown.js',
      'src/index.js',
      'test/offline/user_control.test.js',
      'test/offline/runtime_shutdown.test.js',
      'test/offline/runtime_startup.test.js',
      'test/offline/config_example.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Authorized usernames must be configured explicitly before chat logout commands are accepted.',
      'Live chat-command logout has not been run on the private server in this checkpoint.',
    ]),
    nextCommand: 'node --test test/offline/user_control.test.js test/offline/runtime_shutdown.test.js test/offline/runtime_startup.test.js',
  }),
  Object.freeze({
    id: 'survival_reflexes',
    category: 'survival',
    claim: 'Reactive health, food, flee, water, fall, and hazard reflexes have deterministic guardrails and mocked regression coverage.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'test/offline/reactive_health.test.js',
      'test/offline/reactive_flee.test.js',
      'test/offline/reactive_water.test.js',
      'test/offline/reactive_hazard.test.js',
    ]),
    liveEvidence: Object.freeze([
      'Controlled single-hostile flee fixture E is live-proven in reports/deterministic-eval.md.',
      'One fall-damage recovery fixture H is live-proven in reports/deterministic-eval.md.',
    ]),
    limitations: Object.freeze([
      'Broader live water, lava/fire, shield timing, and low-health recovery remain unverified.',
    ]),
    nextCommand: 'npm run test:live with MCBOT_LIVE_TESTS=1 and a selected private scenario',
  }),
  Object.freeze({
    id: 'materials_crafting_smelting',
    category: 'materials',
    claim: 'Inventory counting, material planning, crafting dependency expansion, storage withdrawal, tool requirements, fuel planning, and runtime-only smelting are deterministic and tested offline.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'test/offline/materials.test.js',
      'test/offline/craft_storage_withdrawal.test.js',
      'test/offline/smelt_skill.test.js',
      'test/offline/mine_with_progression_skill.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Live furnace/chest scanning and full mining progression remain pending.',
    ]),
    nextCommand: 'node --test test/offline/materials.test.js test/offline/mine_with_progression_skill.test.js',
  }),
  Object.freeze({
    id: 'world_model_foundation',
    category: 'world-model',
    claim: 'Persistent world-model storage, synthetic structure detection, resource/storage/hazard summaries, and advisor-facing compact summaries are implemented and tested offline.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/state/world_model.js',
      'test/offline/world_model.test.js',
      'test/offline/world_model_ingest_adapter.test.js',
      'test/offline/snapshot_world_model.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Live Mineflayer ingest and real advisor use of the persisted model are not yet proven.',
    ]),
    nextCommand: 'node --test test/offline/world_model.test.js test/offline/snapshot_world_model.test.js',
  }),
  Object.freeze({
    id: 'advisor_structured_state_interface',
    category: 'advisor-interface',
    claim: 'DeepSeek-ready structured state includes compact snapshot context, world-model summaries, task budgets, combat overview, mining progression, and activation guard context.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/state/snapshot.js',
      'test/offline/snapshot_observe_context.test.js',
      'test/offline/advisor_context.test.js',
      'test/offline/advisor_runtime_options.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Only the F1/F2 gate calls have been captured; broad live advisor use of this interface is still in calibration.',
    ]),
    nextCommand: 'npm run advisor:dry-run',
  }),
  Object.freeze({
    id: 'deepseek_first_call_contract',
    category: 'advisor-interface',
    claim: 'The first real DeepSeek capture path has produced one gated provider response and validated it through strict replay and private response leak guards.',
    status: CAPABILITY_STATUSES.LIVE_PROVEN,
    offlineEvidence: Object.freeze([
      'reports/advisor-first-call.md',
      'reports/advisor-first-call-replay.md',
      'reports/advisor-response-capture-guard.md',
    ]),
    liveEvidence: Object.freeze([
      'F1: one real deepseek-v4-pro response captured with metrics and strict replay validation.',
    ]),
    limitations: Object.freeze([
      'This entry proves the first single-response gate only; F3 multi-response calibration is tracked separately and is also live-proven.',
      'Raw provider responses remain private and ignored.',
    ]),
    nextCommand: 'Use F1 as completed evidence in the benchmark ladder.',
  }),
  Object.freeze({
    id: 'deepseek_f3_calibration',
    category: 'advisor-interface',
    claim: 'The post-F2 calibration path can capture and replay a multi-tier set of real DeepSeek responses without exposing private model output.',
    status: CAPABILITY_STATUSES.LIVE_PROVEN,
    offlineEvidence: Object.freeze([
      'scripts/advisor-f3-calibration.js',
      'data/advisor-dry-run/recorded-core.json',
      'test/offline/advisor_first_call.test.js',
      'test/offline/advisor_first_call_replay.test.js',
      'reports/advisor-f3-calibration.md',
      'reports/advisor-f3-replay.md',
      'reports/advisor-f3-response-capture-guard.md',
    ]),
    liveEvidence: Object.freeze([
      'F3: seven real deepseek-v4-pro responses captured across smoke, world-model, survival, safety, combat escalation, combat prep, and long-horizon fixture tiers.',
      'reports/advisor-f3-replay.md validates all seven responses with metrics and zero unexpected outcomes.',
    ]),
    limitations: Object.freeze([
      'F3 validates planning response shape and activation behavior; it does not grant unrestricted live authority.',
      'Raw provider responses remain private and ignored.',
    ]),
    nextCommand: 'Use F3 as completed calibration evidence in the benchmark ladder.',
  }),
  Object.freeze({
    id: 'advisor_cost_ceiling',
    category: 'advisor-interface',
    claim: 'Advisor calls have a configurable per-session cost ceiling with structured per-call accounting and bounded fallback/logout behavior.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/advisor/cost_guard.js',
      'src/advisor/deepseek.js',
      'src/advisor/agent.js',
      'test/offline/advisor_cost_guard.test.js',
      'test/offline/advisor_agent.test.js',
      'test/offline/config_example.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Cost is estimated from provider usage metrics with configurable rates; real provider billing is first verified at F1.',
      'F1/F2 observed costs are live-proven, but broader long-running advisor cost behavior still needs calibration.',
    ]),
    nextCommand: 'node --test test/offline/advisor_cost_guard.test.js test/offline/advisor_agent.test.js test/offline/config_example.test.js',
  }),
  Object.freeze({
    id: 'advisor_live_plan_reporter',
    category: 'advisor-interface',
    claim: 'The F2 live advisor-plan wrapper ran a real DeepSeek Regime A gather-log task, induced one RCON hostile flee, parsed structured runtime logs, and emitted reports/advisor-live-plan.json in the phase-shift schema.',
    status: CAPABILITY_STATUSES.LIVE_PROVEN,
    offlineEvidence: Object.freeze([
      'scripts/advisor-live-plan.js',
      'test/offline/advisor_live_plan_reporter.test.js',
      'src/goal/phase_shift_readiness.js',
    ]),
    liveEvidence: Object.freeze([
      'reports/advisor-live-plan.json',
      'F2: one real DeepSeek plan gathered 10 oak logs, survived induced hostile flee, resumed, and completed cleanly.',
    ]),
    limitations: Object.freeze([
      'This proves one controlled gather-log plan, not broad autonomous long-horizon planning.',
      'The report depends on structured runtime events from src/index.js and on private RCON hostile induction succeeding mid-run.',
    ]),
    nextCommand: 'Use F2 as completed live-plan evidence in the benchmark ladder.',
  }),
  Object.freeze({
    id: 'advisor_live_calibration_ladder',
    category: 'advisor-interface',
    claim: 'The DeepSeek live-calibration workstream has private Regime A evidence for accepted, rejected, stale, unsafe, and recovery proposal classes without granting planner authority.',
    status: CAPABILITY_STATUSES.LIVE_PROVEN,
    offlineEvidence: Object.freeze([
      'scripts/advisor-live-calibration.js',
      'scripts/advisor-live-calibration-case.js',
      'test/offline/advisor_live_calibration.test.js',
      'test/offline/advisor_live_calibration_case.test.js',
      'reports/advisor-live-calibration.md',
      'src/goal/current_goal.js private_live_advisor_entry',
    ]),
    liveEvidence: Object.freeze([
      'accepted proposal evidence is recognized from reports/advisor-live-plan.json when F2 remains valid.',
      'activation-rejection evidence is recorded in reports/advisor-live-calibration-evidence.json.',
      'stale-plan rejection evidence is recorded in reports/advisor-live-calibration-evidence.json.',
      'unsafe normal-work rejection evidence is recorded in reports/advisor-live-calibration-evidence.json.',
      'bounded recovery evidence is recorded in reports/advisor-live-calibration-evidence.json.',
    ]),
    limitations: Object.freeze([
      'The aggregate reporter does not itself run live Minecraft, RCON, or DeepSeek; it only evaluates recorded sanitized evidence.',
      'The activation-rejection case is now live-proven on the private Regime A server with one non-empty DeepSeek proposal rejected before executor skills ran.',
      'The stale-plan rejection case is now live-proven on the private Regime A server with one non-empty DeepSeek proposal rejected as stale after RCON teleport-drift induction.',
      'The unsafe normal-work case is now live-proven on the private Regime A server with one non-empty DeepSeek normal-work proposal rejected while reactive survival owned authority.',
      'The recovery case is now live-proven on the private Regime A server with one accepted collect plan, induced fall death, one scheduled recover_drops attempt, recovered drops, and clean task completion.',
      'This proves calibration-boundary behavior, not broad long-horizon autonomy or advanced combat.',
    ]),
    nextCommand: 'advance_to_benchmark_ladder',
  }),
  Object.freeze({
    id: 'live_fixture_suite_a_i',
    category: 'live-private-fixtures',
    claim: 'Private live fixtures A through I have harness coverage, and the current eval report marks their controlled fixture results as live-proven.',
    status: CAPABILITY_STATUSES.LIVE_PROVEN,
    offlineEvidence: Object.freeze([
      'scripts/live-scenarios.js',
      'test/offline/live_scenarios.test.js',
    ]),
    liveEvidence: Object.freeze([
      'A live_server_smoke',
      'B live_supply_chest_inspect',
      'C live_supply_chest_equip',
      'D live_phase2_collect_deposit_fixture',
      'E live_single_hostile_flee_fixture',
      'F live_supply_chest_fishing_fixture',
      'G live_mining_soak_fixture',
      'H live_death_recovery_fixture',
      'I live_single_hostile_engage_fixture',
    ]),
    limitations: Object.freeze([
      'This is fixture proof, not a claim of broad general Minecraft competence.',
    ]),
    nextCommand: 'npm run test:live with MCBOT_LIVE_TESTS=1 and MCBOT_LIVE_SCENARIO=<A-I id>',
  }),
  Object.freeze({
    id: 'hostile_escalation_jk',
    category: 'live-private-fixtures',
    claim: 'RCON-assisted hostile escalation and PvM engage-to-flee fixtures are live-proven on the private Regime A server.',
    status: CAPABILITY_STATUSES.LIVE_PROVEN,
    offlineEvidence: Object.freeze([
      'test/offline/live_hostile_escalation_plan.test.js',
      'test/offline/live_pvm_escalation_plan.test.js',
      'scripts/live-admin.js',
      'scripts/live-admin-commands.js',
    ]),
    liveEvidence: Object.freeze([
      'reports/live-evidence.json',
      'J live_hostile_escalation_fixture: one-three-four fire-resistant zombie waves, FLEEING observed, no ENGAGING, final escape beyond de-aggro radius.',
      'K live_pvm_escalation_decision_fixture: single-zombie ENGAGING before escalation, too-many-hostiles FLEEING after escalation, final escape beyond de-aggro radius.',
    ]),
    limitations: Object.freeze([
      'This is controlled PvM fixture proof, not broad advanced combat or PvP proof.',
      'Raw live logs remain local/ignored; reports/live-evidence.json stores the sanitized public summary.',
    ]),
    nextCommand: 'Use J/K as completed PvM fixture evidence in the benchmark ladder.',
  }),
  Object.freeze({
    id: 'long_horizon_mission_primitives',
    category: 'missions',
    claim: 'Mission budget, return planning, mission profiles, reusable loop primitives, and the scaled offline mission reliability benchmark cover timed mining/fishing-style task control.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/runtime/task_budget.js',
      'src/runtime/mission_profile.js',
      'src/runtime/mission_return.js',
      'src/runtime/mission_control.js',
      'test/offline/mission_control.test.js',
      'src/benchmarks/mission_reliability.js',
      'scripts/mission-reliability-benchmark.js',
      'test/offline/mission_reliability_benchmark.test.js',
      'reports/mission-reliability-benchmark.md',
    ]),
    liveEvidence: Object.freeze([
      'Plugin-backed bounded fishing and mining return-by-deadline soaks are recorded in local plugin-live reports.',
      'reports/benchmark-ladder.md promotes the specific bounded long_horizon_return_by_deadline entry to live-proven when those reports are present and valid.',
    ]),
    limitations: Object.freeze([
      'The mission reliability benchmark is scaled and offline; it does not prove multi-hour live Minecraft endurance.',
      'The capability remains offline-covered at this broad category level because multi-hour live Minecraft endurance is not proven.',
    ]),
    nextCommand: 'npm run benchmark:missions',
  }),
  Object.freeze({
    id: 'pvm_combat_primitives',
    category: 'combat',
    claim: 'PvM flee/engage decisions, weapon selection, potion-aware risk estimates, shield/ranged guardrails, and combatOverview advisor summaries are represented deterministically.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'test/offline/combat_policy.test.js',
      'test/offline/reactive_flee.test.js',
      'test/offline/snapshot_observe_context.test.js',
    ]),
    liveEvidence: Object.freeze([
      'Single controlled zombie flee and single controlled fire-resistant zombie engage are live-proven in reports/deterministic-eval.md.',
      'J/K hostile escalation fixture summaries are live-proven in reports/live-evidence.json.',
    ]),
    limitations: Object.freeze([
      'Escalating PvM flee-vs-engage is live-proven under controlled zombie fixtures; creeper-safe killing, projectile hit guarantees, advanced multi-hostile fighting, and PvP are not live-proven.',
    ]),
    nextCommand: 'npm run test:live with the gated private hostile scenarios',
  }),
  Object.freeze({
    id: 'advanced_authorized_pvp',
    category: 'combat',
    claim: 'Authorized high-level PvP, including bow/melee/lava/water/block/crystal tactics, is an explicit project target with no-cheat constraints.',
    status: CAPABILITY_STATUSES.PENDING,
    offlineEvidence: Object.freeze([
      'docs/goal.det-autonomy-v1.md',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'No advanced PvP or crystal PvP implementation is claimed.',
      'No public-server, anti-cheat bypass, kill-aura, aimbot, packet spoofing, or impossible timing behavior is allowed.',
    ]),
    nextCommand: 'Add private/local PvM and PvP benchmark ladders after DeepSeek calibration clears.',
  }),
  Object.freeze({
    id: 'c1_humanization_boundary',
    category: 'humanization',
    claim: 'C1 humanization has an opt-in deterministic wrapper for curved aim planning, item/equip/consume/dig cadence, movement-control chokepoints, collect intent, idle micro-behaviors, active static path lane bias, reach checks, critical-survival exemptions, and first Mineflayer chokepoints.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/behavior_shaping/humanizer.js',
      'src/control/pathfinder.js',
      'src/reactive/reactive.js',
      'src/runtime/idle_humanization.js',
      'test/offline/humanization_invariants.test.js',
      'test/offline/humanization_action_boundary.test.js',
      'test/offline/humanization_idle.test.js',
      'test/offline/config_example.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'MCBOT_HUMANIZE is disabled by default and has not been live-proven.',
      'This C1 slice wires smoothstep aim curves with bounded micro-correction, no-goal idle micro-behaviors, static GoalNear path lane-bias entropy that preserves original completion semantics, reactive lookAt, water-bucket placement, water-bucket pickup activation, ranged look, fishing cast/reel/equip, fishing water-rescue controls, reactive water-escape controls, collectBlock collection-start intent, skill equip/consume, reactive combat equip, item-use cancellation, shield/ranged item use, PvM attack handoff, and an explicit dig wrapper; third-party collectBlock still owns low-level dig internals and broader active movement style remains incomplete.',
    ]),
    nextCommand: 'node --test test/offline/humanization_invariants.test.js test/offline/humanization_action_boundary.test.js',
  }),
  Object.freeze({
    id: 'c2_anti_cheat_invariants',
    category: 'humanization',
    claim: 'C2 anti-cheat invariants fail closed for impossible rotations, reach, click cadence, movement speed, jump physics, and forbidden cheat flags.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/behavior_shaping/humanizer.js',
      'test/offline/humanization_invariants.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'The invariant validators are offline-covered and movement-control chokepoints now exist for water rescue/escape, but they are not yet connected to every future movement-emitting humanized action.',
      'This is proof against impossible action records, not a claim that MCBOT_HUMANIZE is live-proven.',
    ]),
    nextCommand: 'node --test test/offline/humanization_invariants.test.js',
  }),
  Object.freeze({
    id: 'c3_detection_rate_benchmark',
    category: 'humanization',
    claim: 'C3 has a non-live benchmark harness for anonymizing bot/human behavior clips, generating blind review packets, and scoring classifier accuracy against the 55% target.',
    status: CAPABILITY_STATUSES.SCAFFOLDED,
    offlineEvidence: Object.freeze([
      'src/benchmarks/detection_rate.js',
      'scripts/detection-rate-benchmark.js',
      'test/offline/detection_rate_benchmark.test.js',
      'reports/detection-rate-benchmark.md',
      'reports/detection-rate-blind-packet.json',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'No real bot/human clip corpus or human classification run has been collected yet.',
      'The harness strips truth labels and raw local paths from public packets, but media capture and reviewer UX remain future work.',
    ]),
    nextCommand: 'npm run benchmark:detection-rate',
  }),
  Object.freeze({
    id: 'repeatable_benchmark_ladder',
    category: 'publication',
    claim: 'The active benchmark-ladder workstream has a no-live/no-API reporter that declares setup, command, expected result, evidence artifact, and live/offline status for each current SOTA-track benchmark.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'src/benchmarks/ladder.js',
      'scripts/benchmark-ladder.js',
      'test/offline/benchmark_ladder.test.js',
      'reports/benchmark-ladder.md',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'The ladder is an evidence index and reporter; it does not itself run live Minecraft, RCON, or DeepSeek.',
      'Pending/scaffolded entries still require separate live or offline proof before they can be claimed as completed.',
      'Uncontrolled manual hostile spawning is explicitly excluded from formal benchmark evidence.',
    ]),
    nextCommand: 'npm run benchmark:ladder',
  }),
  Object.freeze({
    id: 'c4_carpet_pvp_heuristic_extraction',
    category: 'combat',
    claim: 'C4 has a safe, prose-only extraction pass over the local Carpet-PvP reference jar for private-server fixture and telemetry ideas without copying source or adding a runtime dependency.',
    status: CAPABILITY_STATUSES.SCAFFOLDED,
    offlineEvidence: Object.freeze([
      'docs/combat-heuristics-extracted.md',
      'test/offline/combat_heuristics_extraction.test.js',
      '.gitignore vendor/decompiled/',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'This is an idea-extraction checkpoint, not an implementation of advanced PvP or crystal PvP.',
      'The review used manifest, license, file inventory, bundled scripts, and public signatures only; no Java source decompiler was available.',
      'No packet spoofing, reach extension, kill-aura, aimbot, impossible timing, or anti-cheat bypass behavior is allowed.',
    ]),
    nextCommand: 'Build original private-server PvM/PvP/crystal benchmark fixtures from the extracted ideas.',
  }),
  Object.freeze({
    id: 'build_schematic_dry_run',
    category: 'building',
    claim: 'Schematic/build dry-run planning supports normalized block input, material bills, obstruction/hazard checks, and protected-region policy without live placement.',
    status: CAPABILITY_STATUSES.OFFLINE_COVERED,
    offlineEvidence: Object.freeze([
      'test/offline/build_plan.test.js',
      'test/offline/build_from_schematic_skill.test.js',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'Live placement and litematic parsing remain deferred.',
    ]),
    nextCommand: 'node --test test/offline/build_plan.test.js test/offline/build_from_schematic_skill.test.js',
  }),
  Object.freeze({
    id: 'viewer_operator_handoff',
    category: 'operator-ux',
    claim: 'Human oversight viewer and same-client handoff have an architecture note and build order, but no implementation yet.',
    status: CAPABILITY_STATUSES.PENDING,
    offlineEvidence: Object.freeze([
      'docs/oversight-handoff.md',
      'src/goal/phase_shift_readiness.js viewer_operator_track',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'No prismarine-viewer integration, persistent viewer supervisor, Regime B Phase 1 production viewer run, or Fabric bridge exists yet.',
      'DeepSeek should continue to consume structured snapshots rather than rendered pixels.',
    ]),
    nextCommand: 'Implement a gated read-only local viewer after the active DeepSeek calibration checkpoint.',
  }),
  Object.freeze({
    id: 'publication_evidence_pack',
    category: 'publication',
    claim: 'Generated status/eval/readiness reports plus this matrix give external reviewers honest capability labels and reproducible commands.',
    status: CAPABILITY_STATUSES.SCAFFOLDED,
    offlineEvidence: Object.freeze([
      'docs/status.md',
      'docs/codex-progress.md',
      'reports/deterministic-eval.md',
      'reports/phase-shift-readiness.md',
      'reports/capability-matrix.md',
    ]),
    liveEvidence: Object.freeze([]),
    limitations: Object.freeze([
      'This matrix must be refreshed after future live, DeepSeek, viewer, combat, and long-horizon checkpoints.',
    ]),
    nextCommand: 'npm run capability:matrix',
  }),
]);

export function buildCapabilityMatrix(opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const capabilities = CAPABILITY_DEFINITIONS.map(normalizeCapability);
  const summary = summarizeCapabilities(capabilities);
  return {
    generatedAt,
    noApiCall: false,
    statusVocabulary: [...CAPABILITY_STATUS_ORDER],
    summary,
    capabilities,
    nextActions: nextActions(capabilities),
  };
}

export function renderCapabilityMatrix(report) {
  const lines = [
    '# Deterministic Capability Matrix',
    '',
    `Generated: ${report.generatedAt}`,
    `No DeepSeek/API call made: ${report.noApiCall === true ? 'yes' : 'no'}`,
    '',
    '## Summary',
    '',
    '| Status | Count |',
    '| --- | ---: |',
  ];

  for (const status of report.statusVocabulary || CAPABILITY_STATUS_ORDER) {
    lines.push(`| ${status} | ${report.summary?.byStatus?.[status] || 0} |`);
  }
  lines.push(`| total | ${report.summary?.total || 0} |`);

  lines.push('', '## Capabilities', '');
  lines.push('| Capability | Category | Status | Claim | Evidence | Limitations | Next command |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const capability of report.capabilities || []) {
    lines.push([
      capability.id,
      capability.category,
      capability.status,
      capability.claim,
      evidenceSummary(capability),
      capability.limitations.join('; ') || 'none',
      capability.nextCommand || 'none',
    ].map(escapeTable).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', '## Next Actions', '');
  for (const action of report.nextActions || []) {
    lines.push(`- ${action.id}: ${action.nextCommand}`);
  }

  return `${lines.join('\n')}\n`;
}

function normalizeCapability(definition) {
  if (!CAPABILITY_STATUS_ORDER.includes(definition.status)) {
    throw new Error(`invalid capability status for ${definition.id}: ${definition.status}`);
  }
  return {
    id: definition.id,
    category: definition.category,
    claim: definition.claim,
    status: definition.status,
    offlineEvidence: [...(definition.offlineEvidence || [])],
    liveEvidence: [...(definition.liveEvidence || [])],
    limitations: [...(definition.limitations || [])],
    nextCommand: definition.nextCommand || null,
  };
}

function summarizeCapabilities(capabilities) {
  const byStatus = Object.fromEntries(CAPABILITY_STATUS_ORDER.map((status) => [status, 0]));
  const byCategory = {};
  for (const capability of capabilities) {
    byStatus[capability.status] += 1;
    byCategory[capability.category] = (byCategory[capability.category] || 0) + 1;
  }
  return {
    total: capabilities.length,
    byStatus,
    byCategory,
  };
}

function nextActions(capabilities) {
  return capabilities
    .filter((capability) => capability.status !== CAPABILITY_STATUSES.LIVE_PROVEN)
    .map((capability) => ({
      id: capability.id,
      status: capability.status,
      nextCommand: capability.nextCommand,
    }));
}

function evidenceSummary(capability) {
  const parts = [];
  if (capability.offlineEvidence.length > 0) {
    parts.push(`offline: ${capability.offlineEvidence.join('; ')}`);
  }
  if (capability.liveEvidence.length > 0) {
    parts.push(`live: ${capability.liveEvidence.join('; ')}`);
  }
  return parts.join(' / ') || 'none';
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

export default {
  CAPABILITY_STATUSES,
  CAPABILITY_STATUS_ORDER,
  buildCapabilityMatrix,
  renderCapabilityMatrix,
};
