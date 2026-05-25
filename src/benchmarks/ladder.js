export const BENCHMARK_STATUSES = Object.freeze({
  LIVE_PROVEN: 'live-proven',
  OFFLINE_COVERED: 'offline-covered',
  SCAFFOLDED: 'scaffolded',
  PENDING: 'pending',
});

export const BENCHMARK_STATUS_ORDER = Object.freeze([
  BENCHMARK_STATUSES.LIVE_PROVEN,
  BENCHMARK_STATUSES.OFFLINE_COVERED,
  BENCHMARK_STATUSES.SCAFFOLDED,
  BENCHMARK_STATUSES.PENDING,
]);

export const BENCHMARK_MODES = Object.freeze(['offline', 'private-live', 'mixed']);

const REQUIRED_ENTRY_FIELDS = Object.freeze([
  'id',
  'track',
  'mode',
  'status',
  'setup',
  'command',
  'expectedResult',
  'evidenceArtifact',
  'evidenceSummary',
  'nextAction',
]);

export function buildBenchmarkLadderReport({
  sourceReports = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const entries = [
    f2GatherLogsWithHostileFlee(sourceReports),
    liveFixtureSuiteAI(sourceReports),
    hostileEscalationJ(sourceReports),
    pvmEscalationK(sourceReports),
    advisorLiveCalibration(sourceReports),
    detectionRateBenchmark(sourceReports),
    buildSchematicDryRun(sourceReports),
    longHorizonReturnByDeadline(sourceReports),
    advancedPrivateCombatLadder(sourceReports),
    viewerOperatorHandoff(sourceReports),
    publicationEvidenceMatrix(sourceReports),
  ].map(normalizeBenchmarkEntry);
  const workstreamExit = evaluateBenchmarkLadderWorkstreamExit(entries);

  return {
    ok: true,
    id: 'repeatable_benchmark_ladder',
    generatedAt,
    noApiCall: true,
    statusVocabulary: [...BENCHMARK_STATUS_ORDER],
    modes: [...BENCHMARK_MODES],
    summary: summarizeEntries(entries),
    evidencePolicy: {
      controlledEvidenceRequired: true,
      excludedFromFormalEvidence: [
        'Manual external zombie spawning while a scenario is running.',
        'Unscripted operator observation without a generated report artifact.',
        'Any live run missing the private-server opt-in gates documented on the entry.',
      ],
      note: 'Uncontrolled chaos runs can inform future fixtures, but only scripted reports count as ladder evidence.',
    },
    workstreamExit,
    entries,
    nextActions: entries
      .filter((entry) => entry.status !== BENCHMARK_STATUSES.LIVE_PROVEN)
      .map((entry) => ({
        id: entry.id,
        status: entry.status,
        nextAction: entry.nextAction,
      })),
  };
}

export function benchmarkLadderComplete(report = {}) {
  return report?.ok === true
    && report?.noApiCall === true
    && report?.workstreamExit?.complete === true;
}

export function evaluateBenchmarkLadderWorkstreamExit(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const requiredMetadata = list.length > 0 && list.every((entry) => REQUIRED_ENTRY_FIELDS.every(
    (field) => typeof entry[field] === 'string' && entry[field].trim().length > 0,
  ));
  const separatesStatuses = list.length > 0
    && list.some((entry) => entry.status === BENCHMARK_STATUSES.LIVE_PROVEN)
    && list.some((entry) => entry.status !== BENCHMARK_STATUSES.LIVE_PROVEN)
    && list.some((entry) => entry.mode === 'private-live')
    && list.some((entry) => entry.mode === 'offline');
  const targetedBlockers = list
    .filter((entry) => entry.status !== BENCHMARK_STATUSES.LIVE_PROVEN)
    .every((entry) => Array.isArray(entry.blockers)
      && entry.blockers.length > 0
      && entry.blockers.every((blocker) => typeof blocker === 'string'
        && blocker.trim().length > 0
        && !/broad deterministic substrate hardening|broad substrate polishing/i.test(blocker)));
  const criteria = [
    {
      id: 'declares_setup_command_expected_evidence_status',
      satisfied: requiredMetadata,
      evidence: requiredMetadata
        ? `${list.length} benchmark entries declare required metadata.`
        : 'One or more benchmark entries are missing required metadata.',
    },
    {
      id: 'separates_live_and_offline_status',
      satisfied: separatesStatuses,
      evidence: separatesStatuses
        ? 'Report contains both live-proven and non-live-proven entries plus private-live and offline modes.'
        : 'Report does not yet separate live/private and offline/non-live status strongly enough.',
    },
    {
      id: 'targeted_blockers_for_incomplete_entries',
      satisfied: targetedBlockers,
      evidence: targetedBlockers
        ? 'Every non-live-proven entry has a targeted blocker or next action.'
        : 'At least one incomplete entry is missing a targeted blocker.',
    },
  ];

  return {
    complete: criteria.every((criterion) => criterion.satisfied),
    criteria,
  };
}

export function renderBenchmarkLadderReport(report = {}) {
  const lines = [
    '# Repeatable Benchmark Ladder',
    '',
    `Generated: ${report.generatedAt || 'unknown'}`,
    `No DeepSeek/API call made by this reporter: ${report.noApiCall === true ? 'yes' : 'no'}`,
    '',
    '## Summary',
    '',
    '| Status | Count |',
    '| --- | ---: |',
  ];

  for (const status of report.statusVocabulary || BENCHMARK_STATUS_ORDER) {
    lines.push(`| ${status} | ${report.summary?.byStatus?.[status] || 0} |`);
  }
  lines.push(`| total | ${report.summary?.total || 0} |`);

  lines.push('', '## Evidence Policy', '');
  lines.push(`- controlled evidence required: ${report.evidencePolicy?.controlledEvidenceRequired === true ? 'yes' : 'no'}`);
  for (const exclusion of report.evidencePolicy?.excludedFromFormalEvidence || []) {
    lines.push(`- excluded: ${exclusion}`);
  }
  if (report.evidencePolicy?.note) lines.push(`- note: ${report.evidencePolicy.note}`);

  lines.push('', '## Workstream Exit', '');
  lines.push(`- complete: ${report.workstreamExit?.complete === true ? 'yes' : 'no'}`);
  for (const criterion of report.workstreamExit?.criteria || []) {
    lines.push(`- ${criterion.id}: ${criterion.satisfied === true ? 'pass' : 'pending'} - ${criterion.evidence}`);
  }

  lines.push('', '## Benchmarks', '');
  lines.push('| Benchmark | Track | Mode | Status | Setup | Command | Expected result | Evidence | Next action |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of report.entries || []) {
    lines.push([
      entry.id,
      entry.track,
      entry.mode,
      entry.status,
      entry.setup,
      entry.command,
      entry.expectedResult,
      `${entry.evidenceArtifact}: ${entry.evidenceSummary}`,
      entry.nextAction,
    ].map(escapeTable).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', '## Next Actions', '');
  if (!Array.isArray(report.nextActions) || report.nextActions.length === 0) {
    lines.push('- none; all ladder entries are live-proven');
  } else {
    for (const action of report.nextActions) {
      lines.push(`- ${action.id}: ${action.nextAction}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function f2GatherLogsWithHostileFlee(reports) {
  const report = reports.advisorLivePlan || {};
  const status = report.ok === true
    && report.status === 'live_plan_completed'
    && report.planner?.callMade === true
    && report.activation?.accepted === true
    && report.finalOutcome?.ok === true
    && report.hostileFlee?.survived === true
    ? BENCHMARK_STATUSES.LIVE_PROVEN
    : BENCHMARK_STATUSES.PENDING;

  return {
    id: 'f2_deepseek_gather_10_oak_with_hostile_flee',
    track: 'deepseek-planning',
    mode: 'private-live',
    status,
    setup: 'Private Regime A server, MCBot offline account, DeepSeek explicitly allowed, RCON hostile induction enabled, oak-log collection area reset as needed.',
    command: 'MCBOT_LIVE_TESTS=1 MCBOT_ALLOW_DEEPSEEK=1 MCBOT_LIVE_ADMIN_OK=1 npm run advisor:live-plan',
    expectedResult: 'One schema-valid DeepSeek plan is activation-accepted, collect runs, induced hostile flee survives, work resumes, and final outcome is reported.',
    evidenceArtifact: 'reports/advisor-live-plan.json',
    sourceReports: ['reports/advisor-live-plan.json'],
    evidenceSummary: status === BENCHMARK_STATUSES.LIVE_PROVEN
      ? `status=${report.status}; skills=${(report.executor?.skillsExecuted || []).join(',') || 'none'}; costUsd=${report.cost?.usd ?? 'unknown'}; hostileFleeSurvived=${report.hostileFlee?.survived === true}`
      : 'Missing or incomplete live-plan report.',
    nextAction: status === BENCHMARK_STATUSES.LIVE_PROVEN
      ? 'Use as completed F2 seed evidence for broader benchmarks.'
      : 'Run the gated private live-plan wrapper and refresh this report.',
  };
}

function liveFixtureSuiteAI(reports) {
  const capability = capabilityById(reports.capabilityMatrix, 'live_fixture_suite_a_i');
  const status = capabilityStatus(capability, BENCHMARK_STATUSES.PENDING);
  return {
    id: 'live_fixture_suite_a_i',
    track: 'private-live-fixtures',
    mode: 'private-live',
    status,
    setup: 'Authorized supply chest at 248 68 428, private server gates, explicit MCBOT_LIVE_SCENARIO selector, and no broad autonomous behavior.',
    command: 'MCBOT_LIVE_TESTS=1 MCBOT_LIVE_SCENARIO=<A-I scenario id> npm run test:live',
    expectedResult: 'Smoke, chest inspect/equip, collect/deposit, flee, fishing, mining soak, death recovery, and single-hostile engage fixtures complete under their individual success criteria.',
    evidenceArtifact: 'reports/capability-matrix.json',
    sourceReports: ['reports/capability-matrix.json', 'reports/deterministic-eval.md'],
    evidenceSummary: capability
      ? `${capability.status}; ${firstSentence(capability.claim)}`
      : 'Capability matrix entry is missing.',
    nextAction: status === BENCHMARK_STATUSES.LIVE_PROVEN
      ? 'Keep A-I as regression fixtures; rerun only when changing affected behavior.'
      : 'Rerun the missing selected A-I live fixtures and refresh capability reports.',
  };
}

function hostileEscalationJ(reports) {
  const scenario = reports.liveEvidence?.scenarios?.live_hostile_escalation_fixture;
  const status = scenario?.liveProven === true ? BENCHMARK_STATUSES.LIVE_PROVEN : BENCHMARK_STATUSES.PENDING;
  return {
    id: 'j_hostile_escalation_flee',
    track: 'pvm-combat',
    mode: 'private-live',
    status,
    setup: 'Private server RCON fixture with controlled fire-resistant zombie waves only; external manual spawns are not counted.',
    command: 'MCBOT_LIVE_TESTS=1 MCBOT_LIVE_ADMIN_OK=1 MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK=1 MCBOT_LIVE_SCENARIO=live_hostile_escalation_fixture npm run test:live',
    expectedResult: 'Bot enters FLEEING under stacked hostile pressure, avoids engaging, survives, and returns NORMAL beyond de-aggro distance.',
    evidenceArtifact: 'reports/live-evidence.json',
    sourceReports: ['reports/live-evidence.json'],
    evidenceSummary: scenario
      ? `${scenario.status}; spawned=${scenario.metrics?.spawnedHostiles ?? 'unknown'}; finalNearestDistance=${scenario.metrics?.finalNearestDistance ?? 'unknown'}`
      : 'J scenario evidence is missing.',
    nextAction: status === BENCHMARK_STATUSES.LIVE_PROVEN
      ? 'Use as the controlled flee baseline for later hostile escalation variants.'
      : 'Run the gated J fixture with RCON and record sanitized evidence.',
  };
}

function pvmEscalationK(reports) {
  const scenario = reports.liveEvidence?.scenarios?.live_pvm_escalation_decision_fixture;
  const status = scenario?.liveProven === true ? BENCHMARK_STATUSES.LIVE_PROVEN : BENCHMARK_STATUSES.PENDING;
  return {
    id: 'k_pvm_engage_then_flee',
    track: 'pvm-combat',
    mode: 'private-live',
    status,
    setup: 'Private server RCON fixture with netherite gear, one initial fire-resistant zombie, then controlled escalation.',
    command: 'MCBOT_LIVE_TESTS=1 MCBOT_LIVE_ADMIN_OK=1 MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK=1 MCBOT_LIVE_SCENARIO=live_pvm_escalation_decision_fixture npm run test:live',
    expectedResult: 'Bot engages the single hostile, then switches to FLEEING after too-many-hostiles pressure, survives, and returns NORMAL.',
    evidenceArtifact: 'reports/live-evidence.json',
    sourceReports: ['reports/live-evidence.json'],
    evidenceSummary: scenario
      ? `${scenario.status}; maxHostiles=${scenario.metrics?.maxHostileCount ?? 'unknown'}; finalHealth=${scenario.metrics?.finalHealth ?? 'unknown'}`
      : 'K scenario evidence is missing.',
    nextAction: status === BENCHMARK_STATUSES.LIVE_PROVEN
      ? 'Use as the first engage-vs-flee baseline before creeper/ranged/PvP ladders.'
      : 'Run the gated K fixture with RCON and record sanitized evidence.',
  };
}

function advisorLiveCalibration(reports) {
  const report = reports.advisorLiveCalibration || {};
  const required = ['accepted', 'rejected', 'stale', 'unsafe', 'recovery'];
  const liveProven = report.ok === true
    && report.status === 'live_calibration_complete'
    && report.safety?.allLiveEvidenceNoBypass === true
    && required.every((name) => (report.summary?.liveProvenClasses || []).includes(name));
  return {
    id: 'advisor_live_calibration_five_classes',
    track: 'deepseek-planning',
    mode: 'mixed',
    status: liveProven ? BENCHMARK_STATUSES.LIVE_PROVEN : BENCHMARK_STATUSES.PENDING,
    setup: 'Sanitized aggregate of private live advisor calibration cases; reporter itself is no-live and no-API.',
    command: 'npm run advisor:live-calibration',
    expectedResult: 'Accepted, rejected, stale, unsafe, and recovery proposal classes are all live-proven without bypassing deterministic activation or reactive survival.',
    evidenceArtifact: 'reports/advisor-live-calibration.json',
    sourceReports: ['reports/advisor-live-calibration.json', 'reports/advisor-live-calibration-evidence.json'],
    evidenceSummary: liveProven
      ? `liveProvenClasses=${(report.summary?.liveProvenClasses || []).join(',')}`
      : `pendingClasses=${(report.summary?.pendingClasses || required).join(',')}`,
    nextAction: liveProven
      ? 'Use as the planner-boundary baseline for benchmark ladder expansion.'
      : 'Run pending advisor live-calibration cases, then rerun the aggregate reporter.',
  };
}

function detectionRateBenchmark(reports) {
  const report = reports.detectionRateBenchmark || {};
  const scored = report.ok === true && report.status === 'scored';
  const exists = report.ok === true;
  return {
    id: 'c3_detection_rate_blind_packet',
    track: 'humanization',
    mode: 'offline',
    status: scored
      ? BENCHMARK_STATUSES.OFFLINE_COVERED
      : exists ? BENCHMARK_STATUSES.SCAFFOLDED : BENCHMARK_STATUSES.PENDING,
    setup: 'Local bot/human behavior clip manifest and optional blind classifications; truth labels and identifying metadata are stripped from the packet.',
    command: 'npm run benchmark:detection-rate',
    expectedResult: 'Reporter emits a public blind packet and scores classifier accuracy against the 55% distinguishability target when classifications exist.',
    evidenceArtifact: 'reports/detection-rate-benchmark.json',
    sourceReports: ['reports/detection-rate-benchmark.json', 'reports/detection-rate-blind-packet.json'],
    evidenceSummary: exists
      ? `status=${report.status}; clips=${report.manifest?.clipCount ?? 0}; classified=${report.scoring?.classifiedCount ?? 0}; accuracy=${report.scoring?.accuracy ?? 'pending'}`
      : 'Detection-rate benchmark report is missing.',
    nextAction: scored
      ? 'Grow the clip corpus and track trend over time.'
      : 'Record balanced bot/human clips and collect blind classifications.',
  };
}

function buildSchematicDryRun(reports) {
  const capability = capabilityById(reports.capabilityMatrix, 'build_schematic_dry_run');
  return {
    id: 'build_schematic_dry_run',
    track: 'building',
    mode: 'offline',
    status: capabilityStatus(capability, BENCHMARK_STATUSES.PENDING),
    setup: 'Dry-run schematic/build inputs only; no live world placement.',
    command: 'node --test test/offline/build_plan.test.js test/offline/build_from_schematic_skill.test.js',
    expectedResult: 'Material bill, block normalization, obstruction/hazard checks, and protected-region policy are validated without modifying the world.',
    evidenceArtifact: 'reports/capability-matrix.json',
    sourceReports: ['reports/capability-matrix.json'],
    evidenceSummary: capability ? `${capability.status}; ${firstSentence(capability.claim)}` : 'Build capability entry is missing.',
    nextAction: capability?.status === BENCHMARK_STATUSES.OFFLINE_COVERED
      ? 'Keep dry-run as offline baseline until live placement becomes an active workstream.'
      : 'Restore build dry-run tests and capability entry.',
  };
}

function longHorizonReturnByDeadline(reports) {
  const capability = capabilityById(reports.capabilityMatrix, 'long_horizon_mission_primitives');
  const benchmark = reports.missionReliabilityBenchmark || {};
  const benchmarkOk = benchmark.ok === true
    && benchmark.status === 'offline-covered'
    && benchmark.summary?.failCount === 0;
  const pluginSoaks = longHorizonPluginSoaks(reports);
  const status = pluginSoaks.ok
    ? BENCHMARK_STATUSES.LIVE_PROVEN
    : benchmarkOk
      ? BENCHMARK_STATUSES.OFFLINE_COVERED
      : capabilityStatus(capability, BENCHMARK_STATUSES.PENDING);
  return {
    id: 'long_horizon_return_by_deadline',
    track: 'missions',
    mode: 'mixed',
    status,
    setup: 'Mission-budget, deposit, and return-controller primitives with plugin-backed bounded private fishing/mining soaks.',
    command: pluginSoaks.ok
      ? 'npm run benchmark:ladder with plugin-live fishing/mining reports present'
      : 'npm run benchmark:missions',
    expectedResult: 'Scaled offline missions pass, then plugin-backed fishing and mining soaks return by reserve, deposit tracked outputs, and expose server-side pickup/block telemetry.',
    evidenceArtifact: pluginSoaks.ok
      ? `${pluginSoaks.fishing.artifact} + ${pluginSoaks.mining.artifact}`
      : benchmarkOk ? 'reports/mission-reliability-benchmark.json' : 'reports/capability-matrix.json',
    sourceReports: [
      'reports/mission-reliability-benchmark.json',
      'reports/capability-matrix.json',
      ...pluginSoaks.sourceReports,
    ],
    evidenceSummary: pluginSoaks.ok
      ? `live-proven bounded soaks; fishing=${pluginSoaks.fishing.summary}; mining=${pluginSoaks.mining.summary}`
      : benchmarkOk
        ? `offline-covered; cases=${benchmark.summary?.caseCount}; failures=${benchmark.summary?.failCount}; returnByDeadlineCases=${benchmark.summary?.returnByDeadlineCases}; missingLive=${pluginSoaks.missing.join(',') || 'none'}`
        : capability ? `${capability.status}; ${firstSentence(capability.claim)}` : 'Long-horizon capability entry is missing.',
    nextAction: pluginSoaks.ok
      ? 'Increase duration and terrain variation before claiming multi-hour unattended mission reliability.'
      : benchmarkOk
        ? `Run missing plugin-backed bounded soaks: ${pluginSoaks.missing.join(',') || 'none'}.`
        : 'Run npm run benchmark:missions, then promote to bounded private live soaks.',
  };
}

function longHorizonPluginSoaks(reports) {
  const fishingCandidates = [
    ['reports/plugin-live-fishing-dry-five-minute-soak.json', reports.pluginLiveFishingDryFiveMinuteSoak],
    ['reports/plugin-live-fishing-five-minute-soak.json', reports.pluginLiveFishingFiveMinuteSoak],
    ['reports/plugin-live-fishing-duration-soak.json', reports.pluginLiveFishingDurationSoak],
  ].map(([artifact, report]) => fishingSoakEvidence(report, artifact));
  const fishing = fishingCandidates.find((candidate) => candidate.ok)
    || fishingCandidates.find((candidate) => candidate.present)
    || fishingCandidates[0];
  const mining = miningSoakEvidence(
    reports.pluginLiveMiningStrictSoak,
    'reports/plugin-live-mining-strict-soak.json',
  );
  const missing = [];
  if (!fishing.ok) missing.push('plugin-backed fishing duration soak');
  if (!mining.ok) missing.push('plugin-backed strict mining soak');

  return {
    ok: fishing.ok && mining.ok,
    fishing,
    mining,
    missing,
    sourceReports: [
      fishing.artifact,
      mining.artifact,
    ].filter(Boolean),
  };
}

function fishingSoakEvidence(report, artifact) {
  if (!report) return missingPluginEvidence(artifact);
  const done = childLog(report, 'live_supply_chest_fishing_fixture.done');
  const before = childLog(report, 'live_supply_chest_fishing_fixture.before');
  const catches = finiteNumber(done?.catches);
  const minCatches = finiteNumber(done?.minCatches, 1);
  const durationMs = finiteNumber(done?.taskBudget?.elapsedMs, finiteNumber(done?.durationMs));
  const durationTarget = finiteNumber(done?.taskBudget?.durationMs, finiteNumber(done?.durationTarget));
  const itemPickupCount = finiteNumber(report.telemetrySummary?.itemPickupCount, 0);
  const failures = pluginBaseFailures(report, 'live_supply_chest_fishing_fixture');

  if (done?.durationOnly !== true) failures.push('missing durationOnly=true');
  if (!Number.isFinite(catches) || catches < minCatches) failures.push('catches below minCatches');
  if (!Number.isFinite(durationMs) || durationMs < 120000) failures.push('duration below bounded-soak floor');
  if (durationTarget < 180000) failures.push('duration target below bounded-soak floor');
  if (done?.loopResult?.reason !== 'return-reserve-reached') failures.push('did not return from reserve');
  if (done?.taskBudget?.overdue !== false) failures.push('task budget not non-overdue');
  if (itemPickupCount < minCatches) failures.push('insufficient server item pickup telemetry');
  if (artifact.includes('dry') && before?.waterPickupFallback !== false) {
    failures.push('dry fishing report did not disable water fallback');
  }

  return {
    ok: failures.length === 0,
    present: true,
    artifact,
    failures,
    summary: failures.length === 0
      ? `token=${report.token || 'unknown'}; catches=${catches}/${minCatches}; elapsedMs=${durationMs}; pickups=${itemPickupCount}; waterFallback=${before?.waterPickupFallback === true}`
      : `invalid ${artifact}: ${failures.join('; ')}`,
  };
}

function miningSoakEvidence(report, artifact) {
  if (!report) return missingPluginEvidence(artifact);
  const done = childLog(report, 'live_mining_soak_fixture.done');
  const durationMs = finiteNumber(done?.durationMs, finiteNumber(done?.taskBudget?.elapsedMs));
  const minWorkMs = finiteNumber(done?.minWorkMs, 0);
  const minedCount = sumCounts(done?.minedDelta);
  const depositCount = sumCounts(done?.depositTargets);
  const blockBreakCount = finiteNumber(report.telemetrySummary?.blockBreakCount, 0);
  const itemPickupCount = finiteNumber(report.telemetrySummary?.itemPickupCount, 0);
  const failures = pluginBaseFailures(report, 'live_mining_soak_fixture');

  if (done?.requireReturnReserve !== true) failures.push('strict return reserve was not required');
  if (done?.returnedBeforeDeadline !== true) failures.push('not returned before deadline');
  if (done?.loopResult?.reason !== 'return-reserve-reached') failures.push('did not return from reserve');
  if (done?.taskBudget?.overdue !== false) failures.push('task budget not non-overdue');
  if (!Number.isFinite(durationMs) || durationMs < minWorkMs) failures.push('duration below minWorkMs');
  if (minedCount < 1) failures.push('no mined item delta');
  if (depositCount < 1) failures.push('no deposit target delta');
  if (blockBreakCount < 1) failures.push('missing server block break telemetry');
  if (itemPickupCount < 1) failures.push('missing server item pickup telemetry');

  return {
    ok: failures.length === 0,
    present: true,
    artifact,
    failures,
    summary: failures.length === 0
      ? `token=${report.token || 'unknown'}; elapsedMs=${durationMs}; minWorkMs=${minWorkMs}; mined=${compactCounts(done?.minedDelta)}; deposited=${compactCounts(done?.depositTargets)}; blockBreaks=${blockBreakCount}; pickups=${itemPickupCount}`
      : `invalid ${artifact}: ${failures.join('; ')}`,
  };
}

function missingPluginEvidence(artifact) {
  return {
    ok: false,
    present: false,
    artifact,
    failures: ['missing report'],
    summary: `missing ${artifact}`,
  };
}

function pluginBaseFailures(report, scenario) {
  const failures = [];
  if (report.ok !== true) failures.push('report ok was not true');
  if (report.status !== 'plugin_live_scenario_passed') failures.push('report status was not plugin_live_scenario_passed');
  if (report.scenario !== scenario) failures.push(`scenario was not ${scenario}`);
  if (report.validation?.ok !== true) failures.push('runner validation was not ok');
  if (!report.token) failures.push('missing scenario token');
  if (!report.telemetryPath) failures.push('missing telemetry path');
  if (report.child?.exitCode !== 0) failures.push('child exit was not zero');
  return failures;
}

function childLog(report, eventName) {
  return report?.childLogSummary?.lastByEvent?.[eventName] || null;
}

function finiteNumber(value, fallback = Number.NaN) {
  return Number.isFinite(value) ? value : fallback;
}

function sumCounts(counts = {}) {
  return Object.values(counts || {}).reduce((sum, count) => (
    Number.isFinite(count) ? sum + count : sum
  ), 0);
}

function compactCounts(counts = {}) {
  const text = Object.entries(counts || {})
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(',');
  return text || 'none';
}

function advancedPrivateCombatLadder(reports) {
  const capability = capabilityById(reports.capabilityMatrix, 'advanced_authorized_pvp');
  return {
    id: 'advanced_private_combat_ladder',
    track: 'combat',
    mode: 'private-live',
    status: capabilityStatus(capability, BENCHMARK_STATUSES.PENDING),
    setup: 'Authorized private/local PvM then PvP fixture ladder using ordinary game actions and plausible timing only.',
    command: 'pending: add private PvM/PvP/crystal benchmark fixture commands after current PvM baselines',
    expectedResult: 'Future entries prove creeper-safe killing, ranged combat, shield/water/lava reactions, authorized PvP, and crystal tactics without cheat primitives.',
    evidenceArtifact: 'reports/capability-matrix.json',
    sourceReports: ['reports/capability-matrix.json'],
    evidenceSummary: capability ? `${capability.status}; ${firstSentence(capability.claim)}` : 'Advanced PvP capability entry is missing.',
    nextAction: 'Create original private combat fixtures from the C4 heuristic notes, starting with PvM variants before PvP.',
  };
}

function viewerOperatorHandoff(reports) {
  const capability = capabilityById(reports.capabilityMatrix, 'viewer_operator_handoff');
  return {
    id: 'viewer_operator_handoff',
    track: 'operator-ux',
    mode: 'mixed',
    status: capabilityStatus(capability, BENCHMARK_STATUSES.PENDING),
    setup: 'Read-only persistent viewer first; same-client handoff remains a later Fabric-bridge track.',
    command: 'pending: implement gated local viewer supervisor',
    expectedResult: 'Viewer remains available across bot reconnects and gives operator oversight without feeding rendered pixels into DeepSeek planning.',
    evidenceArtifact: 'reports/capability-matrix.json',
    sourceReports: ['reports/capability-matrix.json', 'docs/oversight-handoff.md'],
    evidenceSummary: capability ? `${capability.status}; ${firstSentence(capability.claim)}` : 'Viewer capability entry is missing.',
    nextAction: 'Implement the read-only viewer after the active benchmark ladder checkpoint.',
  };
}

function publicationEvidenceMatrix(reports) {
  const capability = capabilityById(reports.capabilityMatrix, 'publication_evidence_pack');
  const phaseShiftReady = reports.phaseShiftReadiness?.ready === true;
  return {
    id: 'publication_evidence_matrix',
    track: 'publication',
    mode: 'offline',
    status: capabilityStatus(capability, BENCHMARK_STATUSES.SCAFFOLDED),
    setup: 'Generated status, progress, deterministic eval, phase-shift, capability, and benchmark reports for external review.',
    command: 'npm run test:det && npm run benchmark:ladder && npm run capability:matrix',
    expectedResult: 'Reviewer-facing artifacts label claims as live-proven, offline-covered, scaffolded, or pending and avoid private secrets/provider response text.',
    evidenceArtifact: 'reports/benchmark-ladder.json',
    sourceReports: ['reports/benchmark-ladder.json', 'reports/capability-matrix.json', 'reports/phase-shift-readiness.json'],
    evidenceSummary: capability
      ? `${capability.status}; phaseShiftReady=${phaseShiftReady}`
      : `capability matrix missing; phaseShiftReady=${phaseShiftReady}`,
    nextAction: 'Refresh this ladder after every live, DeepSeek, viewer, combat, or long-horizon checkpoint.',
  };
}

function normalizeBenchmarkEntry(entry) {
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
      throw new Error(`benchmark entry ${entry.id || '<unknown>'} missing required string field ${field}`);
    }
  }
  if (!BENCHMARK_STATUS_ORDER.includes(entry.status)) {
    throw new Error(`benchmark entry ${entry.id} has invalid status ${entry.status}`);
  }
  if (!BENCHMARK_MODES.includes(entry.mode)) {
    throw new Error(`benchmark entry ${entry.id} has invalid mode ${entry.mode}`);
  }
  return {
    ...entry,
    sourceReports: Array.isArray(entry.sourceReports) ? [...entry.sourceReports] : [],
    blockers: entry.status === BENCHMARK_STATUSES.LIVE_PROVEN
      ? []
      : blockersFor(entry),
  };
}

function summarizeEntries(entries) {
  const byStatus = Object.fromEntries(BENCHMARK_STATUS_ORDER.map((status) => [status, 0]));
  const byMode = Object.fromEntries(BENCHMARK_MODES.map((mode) => [mode, 0]));
  const byTrack = {};
  for (const entry of entries) {
    byStatus[entry.status] += 1;
    byMode[entry.mode] += 1;
    byTrack[entry.track] = (byTrack[entry.track] || 0) + 1;
  }
  return {
    total: entries.length,
    byStatus,
    byMode,
    byTrack,
    liveProvenIds: entries
      .filter((entry) => entry.status === BENCHMARK_STATUSES.LIVE_PROVEN)
      .map((entry) => entry.id),
    nonLiveProvenIds: entries
      .filter((entry) => entry.status !== BENCHMARK_STATUSES.LIVE_PROVEN)
      .map((entry) => entry.id),
  };
}

function capabilityById(report, id) {
  return (report?.capabilities || []).find((capability) => capability.id === id) || null;
}

function capabilityStatus(capability, fallback) {
  if (!capability || !BENCHMARK_STATUS_ORDER.includes(capability.status)) return fallback;
  return capability.status;
}

function firstSentence(value) {
  const text = String(value || '').trim();
  if (!text) return 'no claim text';
  const match = text.match(/^[^.]+[.]/);
  return match ? match[0] : text;
}

function blockersFor(entry) {
  if (entry.status === BENCHMARK_STATUSES.PENDING) return [`Pending implementation or live evidence: ${entry.nextAction}`];
  if (entry.status === BENCHMARK_STATUSES.SCAFFOLDED) return [`Scaffold exists but benchmark evidence is incomplete: ${entry.nextAction}`];
  return [`Needs stronger evidence before live-proven: ${entry.nextAction}`];
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

export default {
  BENCHMARK_STATUSES,
  BENCHMARK_STATUS_ORDER,
  BENCHMARK_MODES,
  benchmarkLadderComplete,
  buildBenchmarkLadderReport,
  evaluateBenchmarkLadderWorkstreamExit,
  renderBenchmarkLadderReport,
};
