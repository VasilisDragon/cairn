import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { systemPrompt, userPromptInitial } from './prompts.js';
import { validatePlannerResponse } from './planner.js';
import { validatePlanActivation } from './plan_guard.js';
import {
  normalizeAdvisorFirstCallRequestSummaries,
  summarizeAdvisorFirstCallRequest,
} from './first_call_request_summary.js';

export const DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR = 'data/advisor-dry-run';
export const DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR = 'data/advisor-first-call-responses';
export const DEFAULT_ADVISOR_F3_RESPONSE_DIR = 'data/advisor-f3-responses';

export const DEFAULT_ADVISOR_DRY_RUN_THRESHOLDS = Object.freeze({
  maxPromptChars: 4000,
  maxEstimatedPromptTokens: 1200,
});

export const DEFAULT_ADVISOR_FIRST_CALL_REQUEST = Object.freeze({
  model: 'deepseek-v4-pro',
  temperature: 0.2,
  maxTokens: 1024,
  responseFormat: Object.freeze({ type: 'json_object' }),
});
export const ADVISOR_FIRST_CALL_REQUEST_FINGERPRINT_ALGORITHM = 'sha256:canonical-json';

export const DEFAULT_ADVISOR_DRY_RUN_COVERAGE = Object.freeze({
  minFixtureCount: 29,
  requiredCategories: Object.freeze({
    valid_plan: 1,
    invalid_response: 2,
    mission_plan: 1,
    safety_gate: 2,
    combat_gate: 2,
    staleness_gate: 2,
    build_dry_run: 1,
    long_horizon_mission: 1,
    capability_gap: 1,
    recovery_policy: 1,
    no_cheat_boundary: 1,
    combat_prep: 1,
    fishing_skill: 1,
    fishing_mission: 1,
    mining_skill: 1,
    mining_mission: 1,
    recorded_snapshot: 9,
  }),
  requiredStages: Object.freeze({
    activation: 12,
    schema: 3,
    json: 1,
  }),
  requiredActivationStatuses: Object.freeze({
    accepted: 7,
    rejected: 3,
    'not-run': 3,
  }),
  requiredCalibrationTiers: Object.freeze({
    smoke: 1,
    world_model: 1,
    survival: 1,
    safety_rejection: 1,
    combat_prep: 1,
    long_horizon_fixture: 1,
  }),
});

export const DEFAULT_ADVISOR_FIRST_CALL_READINESS = Object.freeze({
  candidateFlag: 'firstCallCandidate',
  minCandidates: 1,
  requiredCandidateIds: Object.freeze([
    'recorded_live_smoke_observe',
  ]),
  requiredStages: Object.freeze({
    activation: 1,
  }),
  requiredActivationStatuses: Object.freeze({
    accepted: 1,
  }),
  requiredCalibrationTiers: Object.freeze({
    smoke: 1,
  }),
});

export const DEFAULT_ADVISOR_F3_CALIBRATION_READINESS = Object.freeze({
  replaceDefaults: true,
  candidateFlag: 'f3Candidate',
  minCandidates: 5,
  requiredCandidateIds: Object.freeze([
    'recorded_live_smoke_observe',
    'recorded_supply_chest_state_observe',
    'recorded_single_hostile_flee',
    'recorded_stacked_hostiles_reject_collect',
    'recorded_hostile_escalation_flee',
    'recorded_pvm_strength_prep',
    'recorded_fishing_deposit_fixture',
  ]),
  requiredStages: Object.freeze({
    activation: 7,
  }),
  requiredActivationStatuses: Object.freeze({
    accepted: 7,
  }),
  requiredCalibrationTiers: Object.freeze({
    smoke: 1,
    world_model: 1,
    survival: 1,
    safety_rejection: 1,
    combat_escalation: 1,
    combat_prep: 1,
    long_horizon_fixture: 1,
  }),
});

export const DEFAULT_ADVISOR_DRY_RUN_FIXTURES = Object.freeze([
  {
    id: 'safe_observe',
    category: 'valid_plan',
    goal: 'inspect current state',
    snapshot: safeSnapshot(),
    rawResponse: JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'malformed_json',
    category: 'invalid_response',
    goal: 'collect one oak log',
    snapshot: safeSnapshot(),
    rawResponse: 'not json',
    expected: { stage: 'json', activationStatus: 'not-run' },
  },
  {
    id: 'valid_collect_deposit',
    category: 'mission_plan',
    goal: 'collect 10 oak logs and deposit them',
    snapshot: safeSnapshot(),
    rawResponse: JSON.stringify({
      plan: [
        { skill: 'collect', params: { block: 'oak_log', count: 10, maxDistance: 64 } },
        { skill: 'deposit', params: { items: [{ name: 'oak_log' }], maxDistance: 32 } },
      ],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'valid_build_dry_run',
    category: 'build_dry_run',
    goal: 'dry-run a tiny shelter build plan without placing blocks',
    snapshot: safeSnapshot({
      inventory: [{ name: 'oak_planks', count: 16 }],
      worldModel: {
        summary: {
          storage: [],
          protectedRegions: [],
        },
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{
        skill: 'build_from_schematic',
        params: {
          dryRun: true,
          anchor: { x: 4, y: 64, z: 4 },
          blocks: [
            { name: 'oak_planks', offset: { x: 0, y: 0, z: 0 } },
            { name: 'oak_planks', offset: { x: 1, y: 0, z: 0 } },
          ],
        },
      }],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'return_on_time_goto_home',
    category: 'long_horizon_mission',
    goal: 'return to the starting chest before the mission deadline',
    snapshot: safeSnapshot({
      position: { x: 80, y: 18, z: -20, dimension: 'overworld' },
      taskBudget: {
        label: 'mining_soak',
        phase: 'return',
        elapsedMs: 540000,
        deadlineAt: 600000,
        returnByAt: 555000,
        remainingMs: 60000,
        returnReserveMs: 45000,
        decision: 'return',
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{ skill: 'goto', params: { x: 248, y: 68, z: 428, range: 2 } }],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'runtime_only_skill',
    category: 'invalid_response',
    goal: 'recover drops',
    snapshot: safeSnapshot(),
    rawResponse: JSON.stringify({ plan: [{ skill: 'recover_drops', params: { x: 0, y: 64, z: 0 } }] }),
    expected: { stage: 'schema', activationStatus: 'not-run' },
  },
  {
    id: 'unsafe_normal_work',
    category: 'safety_gate',
    goal: 'collect one oak log',
    snapshot: safeSnapshot({
      reactiveState: 'FLEEING',
      nearbyHostiles: [{ name: 'zombie', distance: 4 }],
    }),
    rawResponse: JSON.stringify({ plan: [{ skill: 'collect', params: { block: 'oak_log', count: 1 } }] }),
    expected: { stage: 'activation', activationStatus: 'rejected' },
  },
  {
    id: 'unsafe_survival_consume',
    category: 'safety_gate',
    goal: 'recover from low health',
    snapshot: safeSnapshot({ health: 6 }),
    rawResponse: JSON.stringify({ plan: [{ skill: 'consume', params: { item: 'golden_apple' } }] }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'critical_combat_blocks_normal_work',
    category: 'combat_gate',
    goal: 'continue collecting logs',
    snapshot: safeSnapshot({
      combatOverview: {
        threatLevel: 'critical',
        advisorPriority: 'retreat',
        threatCount: 4,
        closeCount: 4,
        nearest: { name: 'zombie', distance: 2 },
        flags: { groupPressure: true, closePressure: true },
        recommendedAction: 'flee',
        recommendedReason: 'too-many-hostiles',
      },
    }),
    rawResponse: JSON.stringify({ plan: [{ skill: 'collect', params: { block: 'oak_log', count: 1 } }] }),
    expected: { stage: 'activation', activationStatus: 'rejected' },
  },
  {
    id: 'critical_combat_allows_flee',
    category: 'combat_gate',
    goal: 'escape stacked hostiles before resuming the mission',
    snapshot: safeSnapshot({
      combatOverview: {
        threatLevel: 'critical',
        advisorPriority: 'retreat',
        threatCount: 5,
        closeCount: 5,
        nearest: { name: 'zombie', distance: 2 },
        flags: { groupPressure: true, closePressure: true },
        recommendedAction: 'flee',
        recommendedReason: 'too-many-hostiles',
      },
    }),
    rawResponse: JSON.stringify({ plan: [{ skill: 'flee', params: { from: 'nearest_hostile', distance: 24 } }] }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'combat_strength_prep_allowed',
    category: 'combat_prep',
    goal: 'prepare for an authorized melee engage with strength if safe enough',
    snapshot: safeSnapshot({
      combatOverview: {
        threatLevel: 'high',
        advisorPriority: 'combat',
        threatCount: 1,
        closeCount: 0,
        nearest: { name: 'zombie', distance: 9 },
        flags: { singleHostile: true },
        recommendedAction: 'engage',
        recommendedReason: 'gear-advantage',
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{ skill: 'consume', params: { item: 'potion', effect: 'strength', minLevel: 2, allowPotions: true } }],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'stale_position_drift',
    category: 'staleness_gate',
    goal: 'collect one oak log',
    proposedFromSnapshot: safeSnapshot(),
    snapshot: safeSnapshot({ position: { x: 5, y: 64, z: 0, dimension: 'overworld' } }),
    rawResponse: JSON.stringify({ plan: [{ skill: 'collect', params: { block: 'oak_log', count: 1 } }] }),
    expected: { stage: 'activation', activationStatus: 'rejected' },
  },
  {
    id: 'stale_combat_target',
    category: 'staleness_gate',
    goal: 'keep pressure on the dangerous hostile',
    proposedFromSnapshot: safeSnapshot({
      combatOverview: {
        threatLevel: 'high',
        advisorPriority: 'combat',
        threatCount: 2,
        closeCount: 0,
        nearest: { name: 'zombie', distance: 5 },
        recommendedTarget: { name: 'creeper', distance: 10 },
        flags: { explosiveThreat: true },
        recommendedAction: 'fire_ranged_weapon',
        recommendedReason: 'creeper-ranged-fire-safe',
      },
    }),
    snapshot: safeSnapshot({
      combatOverview: {
        threatLevel: 'high',
        advisorPriority: 'combat',
        threatCount: 2,
        closeCount: 0,
        nearest: { name: 'zombie', distance: 5 },
        recommendedTarget: { name: 'skeleton', distance: 9 },
        flags: { rangedThreat: true },
        recommendedAction: 'fire_ranged_weapon',
        recommendedReason: 'ranged-fire-safe',
      },
    }),
    rawResponse: JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
    expected: { stage: 'activation', activationStatus: 'rejected' },
  },
  {
    id: 'valid_fish_until_current_spot',
    category: 'fishing_skill',
    goal: 'catch three items from the current safe fishing stand',
    snapshot: safeSnapshot({
      inventory: [{ name: 'fishing_rod', count: 1 }],
      taskBudget: {
        label: 'timed_fishing',
        phase: 'work',
        elapsedMs: 0,
        deadlineAt: 9000000,
        remainingMs: 9000000,
        decision: 'continue',
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{ skill: 'fish_until', params: { catches: 3, maxAttempts: 6 } }],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'valid_fish_and_deposit_current_spot',
    category: 'fishing_mission',
    goal: 'fish for 2.5 hours and deposit catches into the authorized chest',
    snapshot: safeSnapshot({
      inventory: [{ name: 'fishing_rod', count: 1 }],
      taskBudget: {
        label: 'timed_fishing',
        phase: 'work',
        elapsedMs: 0,
        deadlineAt: 9000000,
        remainingMs: 9000000,
        decision: 'continue',
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{
        skill: 'fish_and_deposit',
        params: {
          catches: 3,
          maxAttempts: 6,
          depositChest: { x: 248, y: 68, z: 428 },
          depositRod: true,
        },
      }],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'valid_mine_until_visible_ores',
    category: 'mining_skill',
    goal: 'mine visible coal, iron, or diamond ore near the current position',
    snapshot: safeSnapshot({
      taskBudget: {
        label: 'timed_mining',
        phase: 'work',
        elapsedMs: 0,
        deadlineAt: 7200000,
        remainingMs: 7200000,
        returnReserveMs: 120000,
        decision: 'continue',
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{ skill: 'mine_until', params: { count: 3, maxAttempts: 12, ores: ['coal_ore', 'iron_ore', 'diamond_ore'] } }],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'timed_mining_return_orchestration_gap',
    category: 'mining_mission',
    goal: 'mine for diamonds for exactly two hours and return before the deadline',
    snapshot: safeSnapshot({
      taskBudget: {
        label: 'timed_mining',
        phase: 'work',
        elapsedMs: 0,
        deadlineAt: 7200000,
        remainingMs: 7200000,
        returnReserveMs: 120000,
        decision: 'continue',
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{
        skill: 'mine_and_return',
        params: {
          durationMs: 7200000,
          returnReserveMs: 120000,
          maxAttempts: 128,
          ores: ['coal_ore', 'iron_ore', 'diamond_ore'],
          returnChest: { x: 248, y: 68, z: 428 },
        },
      }],
    }),
    expected: { stage: 'activation', activationStatus: 'accepted' },
  },
  {
    id: 'cave_mining_exploration_orchestration_gap',
    category: 'capability_gap',
    goal: 'explore caves, manage route memory and hazards, mine diamonds, and return exactly on schedule',
    snapshot: safeSnapshot({
      taskBudget: {
        label: 'timed_cave_mining',
        phase: 'work',
        elapsedMs: 0,
        deadlineAt: 7200000,
        remainingMs: 7200000,
        returnReserveMs: 120000,
        decision: 'continue',
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{ skill: 'explore_mine_and_return', params: { durationMs: 7200000, target: 'diamond', returnChest: { x: 248, y: 68, z: 428 } } }],
    }),
    expected: { stage: 'schema', activationStatus: 'not-run' },
  },
  {
    id: 'death_recovery_runtime_only',
    category: 'recovery_policy',
    goal: 'recover dropped items after a recoverable death',
    snapshot: safeSnapshot({
      lastDeath: {
        cause: 'fall',
        position: { x: 12, y: 64, z: 12, dimension: 'overworld' },
        recoveryAllowed: true,
      },
    }),
    rawResponse: JSON.stringify({
      plan: [{ skill: 'recover_drops', params: { x: 12, y: 64, z: 12, dimension: 'overworld' } }],
    }),
    expected: { stage: 'schema', activationStatus: 'not-run' },
  },
  {
    id: 'no_cheat_boundary_rejects_aimbot',
    category: 'no_cheat_boundary',
    goal: 'fight an authorized private-server opponent without impossible aim or packet behavior',
    snapshot: safeSnapshot({
      nearbyPlayers: [{ name: 'TestOpponent', distance: 9 }],
      pvpPolicy: { authorized: true, publicServer: false },
    }),
    rawResponse: JSON.stringify({
      plan: [{ skill: 'aimbot_attack', params: { target: 'TestOpponent', perfectTracking: true } }],
    }),
    expected: { stage: 'schema', activationStatus: 'not-run' },
  },
]);

export function loadAdvisorDryRunFixtures(opts = {}) {
  const includeBuiltins = opts.includeBuiltins !== false;
  const fixtureDir = opts.fixtureDir ?? DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR;
  const corpus = loadAdvisorDryRunFixtureCorpus(fixtureDir);
  const builtinFixtures = includeBuiltins
    ? DEFAULT_ADVISOR_DRY_RUN_FIXTURES.map((fixture) => ({ ...fixture, source: fixture.source || 'builtin' }))
    : [];
  const sources = [];
  if (includeBuiltins) {
    sources.push({ source: 'builtin', fixtureCount: DEFAULT_ADVISOR_DRY_RUN_FIXTURES.length });
  }
  sources.push(...corpus.sources);
  return {
    fixtures: [...builtinFixtures, ...corpus.fixtures],
    sources,
  };
}

export function loadAdvisorDryRunFixtureCorpus(fixtureDir = DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR) {
  const resolvedDir = path.resolve(process.cwd(), fixtureDir);
  if (!fs.existsSync(resolvedDir)) {
    return {
      fixtures: [],
      sources: [{ source: normalizeSourcePath(fixtureDir), fixtureCount: 0, status: 'missing' }],
    };
  }
  const stat = fs.statSync(resolvedDir);
  if (!stat.isDirectory()) {
    throw new Error(`advisor dry-run fixture path is not a directory: ${fixtureDir}`);
  }

  const files = fs.readdirSync(resolvedDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const fixtures = [];
  const sources = [];
  for (const name of files) {
    const filePath = path.join(resolvedDir, name);
    const source = normalizeSourcePath(path.relative(process.cwd(), filePath));
    const loaded = loadAdvisorDryRunFixtureFile(filePath, source);
    fixtures.push(...loaded);
    sources.push({ source, fixtureCount: loaded.length });
  }
  return { fixtures, sources };
}

export function loadAdvisorDryRunFixtureFile(filePath, source = normalizeSourcePath(filePath)) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to load advisor dry-run fixture ${source}: ${err.message}`);
  }
  return parseAdvisorDryRunFixtureDocument(doc, source);
}

export function parseAdvisorDryRunFixtureDocument(doc, source = 'inline') {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`advisor dry-run fixture ${source} must be a JSON object`);
  }
  const schemaVersion = doc.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error(`advisor dry-run fixture ${source} has unsupported schemaVersion ${schemaVersion}`);
  }

  const rawFixtures = Array.isArray(doc.fixtures) ? doc.fixtures : [doc];
  if (rawFixtures.length === 0) {
    throw new Error(`advisor dry-run fixture ${source} must contain at least one fixture`);
  }
  return rawFixtures.map((fixture, index) => normalizeAdvisorDryRunFixture(fixture, `${source}#${index + 1}`));
}

export function runAdvisorDryRunCalibration(fixtures = undefined, opts = {}) {
  const loaded = Array.isArray(fixtures)
    ? { fixtures, sources: opts.fixtureSources || inferFixtureSources(fixtures) }
    : loadAdvisorDryRunFixtures({ fixtureDir: opts.fixtureDir });
  const fixtureList = loaded.fixtures;
  const thresholds = { ...DEFAULT_ADVISOR_DRY_RUN_THRESHOLDS, ...(opts.thresholds || {}) };
  const coverageRequirements = mergeCoverageRequirements(opts.coverageRequirements);
  const firstCallReadinessRequirements = mergeFirstCallReadinessRequirements(opts.firstCallReadinessRequirements);
  const results = fixtureList.map((fixture) => evaluateFixture(fixture, { ...opts, thresholds }));
  const summary = summarizeResults(results, thresholds, coverageRequirements);
  const firstCallReadiness = summarizeFirstCallReadiness(results, firstCallReadinessRequirements);
  return {
    ok: summary.unexpectedOutcomes === 0
      && summary.promptBudgetViolations === 0
      && summary.coverageViolations === 0
      && firstCallReadiness.ready === true,
    noApiCall: true,
    fixtureCount: results.length,
    thresholds,
    coverageRequirements,
    firstCallReadinessRequirements,
    fixtureSources: opts.fixtureSources || loaded.sources || inferFixtureSources(fixtureList),
    summary,
    firstCallReadiness,
    results,
  };
}

export function renderAdvisorDryRunCalibration(report) {
  const lines = [
    '# Advisor Dry-Run Calibration',
    '',
    `- no API call made: ${report.noApiCall === true ? 'yes' : 'unknown'}`,
    `- fixtures: ${report.fixtureCount}`,
    `- JSON-valid responses: ${report.summary.jsonValid}/${report.fixtureCount}`,
    `- schema-valid plans: ${report.summary.planValid}/${report.fixtureCount}`,
    `- activation-accepted plans: ${report.summary.activationAccepted}/${report.fixtureCount}`,
    `- activation-rejected plans: ${report.summary.activationRejected}/${report.fixtureCount}`,
    `- invalid responses: ${report.summary.invalidResponses}/${report.fixtureCount}`,
    `- unexpected outcomes: ${report.summary.unexpectedOutcomes}/${report.fixtureCount}`,
    `- expectation detail failures: ${report.summary.expectationDetailFailures}`,
    `- prompt budget violations: ${report.summary.promptBudgetViolations}/${report.fixtureCount}`,
    `- coverage violations: ${report.summary.coverageViolations}`,
    `- first-call readiness: ${report.firstCallReadiness?.ready ? 'ready' : 'blocked'}`,
    `- first-call candidates: ${report.firstCallReadiness?.candidateCount ?? 0}`,
    `- first-call candidate ids: ${(report.firstCallReadiness?.candidateIds || []).join(', ') || 'none'}`,
    `- first-call calibration tiers: ${formatRequirementCounts(report.firstCallReadiness?.calibrationTierCounts, { separator: ':', empty: 'none' })}`,
    `- first-call readiness failures: ${(report.firstCallReadiness?.failures || []).length}`,
    `- prompt budget: <=${report.thresholds.maxPromptChars} chars and <=${report.thresholds.maxEstimatedPromptTokens} estimated tokens`,
    `- validation latency: avg ${formatMs(report.summary.validationLatencyMs.average)}ms, p95 ${formatMs(report.summary.validationLatencyMs.p95)}ms, max ${formatMs(report.summary.validationLatencyMs.max)}ms`,
    `- recorded response metrics: ${formatRecordedResponseMetrics(report.summary.recordedResponseMetrics)}`,
    `- required categories: ${formatRequirementCounts(report.coverageRequirements.requiredCategories)}`,
    `- required calibration tiers: ${formatRequirementCounts(report.coverageRequirements.requiredCalibrationTiers)}`,
    `- calibration tier counts: ${formatRequirementCounts(report.summary.calibrationTierCounts, { separator: ':', empty: 'none' })}`,
    `- fixture sources: ${formatFixtureSources(report.fixtureSources)}`,
    '',
    '| Fixture | Source | Category | Stage | Activation | Expected | Prompt | Response chars | Validation ms | Recorded latency ms | Recorded tokens | Reason |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const result of report.results) {
    lines.push(`| ${[
      result.id,
      escapeTable(result.source || ''),
      result.category,
      result.stage,
      result.activationStatus,
      result.expectationMet ? 'ok' : 'unexpected',
      result.promptChars,
      result.responseChars,
      result.elapsedMs,
      result.responseMetrics?.latencyMs ?? '',
      result.responseMetrics?.totalTokens ?? '',
      escapeTable(result.reason || ''),
    ].join(' | ')} |`);
  }

  return lines.join('\n') + '\n';
}

export function buildAdvisorFirstCallRequestPack(fixtures = undefined, opts = {}) {
  const loaded = Array.isArray(fixtures)
    ? { fixtures, sources: opts.fixtureSources || inferFixtureSources(fixtures) }
    : loadAdvisorDryRunFixtures({ fixtureDir: opts.fixtureDir });
  const fixtureList = loaded.fixtures;
  const fixtureById = new Map(fixtureList.map((fixture) => [fixture.id, fixture]));
  const calibrationReport = runAdvisorDryRunCalibration(fixtureList, {
    ...opts,
    fixtureSources: loaded.sources,
  });
  const requestDefaults = normalizeFirstCallRequestOptions(opts.request || {});
  const requests = [];

  for (const id of calibrationReport.firstCallReadiness?.candidateIds || []) {
    const fixture = fixtureById.get(id);
    if (!fixture) continue;
    const userContent = userPromptInitial(fixture.goal, fixture.snapshot);
    const messages = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userContent },
    ];
    const request = buildAdvisorFirstCallChatRequest(messages, requestDefaults);
    requests.push({
      id: fixture.id,
      source: fixture.source || 'builtin',
      category: fixture.category,
      goal: fixture.goal,
      calibration: fixture.calibration || null,
      expected: fixture.expected || null,
      promptChars: userContent.length,
      estimatedPromptTokens: estimateTokens(userContent),
      requestFingerprint: fingerprintAdvisorFirstCallRequest(request),
      requestFingerprintAlgorithm: ADVISOR_FIRST_CALL_REQUEST_FINGERPRINT_ALGORITHM,
      request,
    });
  }

  return {
    ok: calibrationReport.ok === true && calibrationReport.firstCallReadiness?.ready === true,
    noApiCall: true,
    status: calibrationReport.firstCallReadiness?.ready
      ? 'ready_for_gated_deepseek_dry_run'
      : 'blocked',
    generatedFrom: 'advisor dry-run first-call candidates',
    requestDefaults,
    firstCallReadinessRequirements: calibrationReport.firstCallReadinessRequirements,
    firstCallReadiness: calibrationReport.firstCallReadiness,
    requestCount: requests.length,
    requestIds: requests.map((request) => request.id),
    requestSummaries: normalizeAdvisorFirstCallRequestSummaries(requests),
    totalPromptChars: requests.reduce((sum, request) => sum + request.promptChars, 0),
    totalEstimatedPromptTokens: requests.reduce((sum, request) => sum + request.estimatedPromptTokens, 0),
    requests,
  };
}

export function sanitizeAdvisorFirstCallRequestPackPublicReport(pack = {}) {
  const {
    requests,
    ...publicPack
  } = pack || {};
  const requestIds = Array.isArray(publicPack.requestIds) && publicPack.requestIds.length > 0
    ? publicPack.requestIds
    : (requests || []).map((request) => request?.id).filter(Boolean);

  return {
    ...publicPack,
    requestIds,
    requestSummaries: normalizeAdvisorFirstCallRequestSummaries(
      publicPack.requestSummaries || requests,
      requestIds,
    ),
    exactRequestPayloadOmitted: true,
    exactRequestPayloadPolicy: 'chat request messages are generated in memory and by private capture files; public request-pack reports contain summaries only',
  };
}

export function renderAdvisorFirstCallRequestPack(pack) {
  const requestSummaries = normalizeAdvisorFirstCallRequestSummaries(
    pack.requestSummaries || (pack.requests || []).map(summarizeAdvisorFirstCallRequest),
    pack.requestIds,
  );
  const lines = [
    '# Advisor First-Call Request Pack',
    '',
    `- no API call made: ${pack.noApiCall === true ? 'yes' : 'unknown'}`,
    `- status: ${pack.status || 'unknown'}`,
    `- request count: ${pack.requestCount || 0}`,
    `- model: ${pack.requestDefaults?.model || 'unknown'}`,
    `- temperature: ${pack.requestDefaults?.temperature ?? 'unknown'}`,
    `- max tokens: ${pack.requestDefaults?.maxTokens ?? 'unknown'}`,
    `- response format: ${JSON.stringify(pack.requestDefaults?.responseFormat || null)}`,
    `- total prompt chars: ${pack.totalPromptChars || 0}`,
    `- estimated prompt tokens: ${pack.totalEstimatedPromptTokens || 0}`,
    `- first-call readiness: ${pack.firstCallReadiness?.status || 'unknown'}`,
    `- readiness failures: ${(pack.firstCallReadiness?.failures || []).length}`,
    `- exact request payload omitted: ${pack.exactRequestPayloadOmitted ? 'yes' : 'runtime report only'}`,
    '',
    '| Candidate | Source | Tier | Prompt chars | Est. prompt tokens | Fingerprint | Expected |',
    '| --- | --- | --- | ---: | ---: | --- | --- |',
  ];

  for (const request of requestSummaries) {
    lines.push(`| ${[
      request.id,
      escapeTable(request.source || ''),
      escapeTable(request.calibrationTier || request.calibration?.tier || ''),
      request.promptChars,
      request.estimatedPromptTokens,
      shortFingerprint(request.requestFingerprint),
      escapeTable(formatExpectedBrief(request.expected)),
    ].join(' | ')} |`);
  }

  return `${lines.join('\n')}\n`;
}

export function loadAdvisorFirstCallResponses(responseDir = DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR) {
  const resolvedPath = path.resolve(process.cwd(), responseDir);
  if (!fs.existsSync(resolvedPath)) {
    return {
      responses: [],
      sources: [{ source: normalizeSourcePath(responseDir), responseCount: 0, status: 'missing' }],
    };
  }

  const stat = fs.statSync(resolvedPath);
  const files = stat.isDirectory()
    ? fs.readdirSync(resolvedPath)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(resolvedPath, name))
    : [resolvedPath];
  const responses = [];
  const sources = [];
  for (const filePath of files) {
    const source = normalizeSourcePath(path.relative(process.cwd(), filePath));
    const loaded = loadAdvisorFirstCallResponseFile(filePath, source);
    responses.push(...loaded);
    sources.push({ source, responseCount: loaded.length });
  }
  return { responses, sources };
}

export function loadAdvisorFirstCallResponseFile(filePath, source = normalizeSourcePath(filePath)) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to load advisor first-call response ${source}: ${err.message}`);
  }
  return parseAdvisorFirstCallResponseDocument(doc, source);
}

export function parseAdvisorFirstCallResponseDocument(doc, source = 'inline') {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`advisor first-call response ${source} must be a JSON object`);
  }
  const schemaVersion = doc.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error(`advisor first-call response ${source} has unsupported schemaVersion ${schemaVersion}`);
  }

  const rawResponses = Array.isArray(doc.responses) ? doc.responses : [doc];
  if (rawResponses.length === 0) {
    throw new Error(`advisor first-call response ${source} must contain at least one response`);
  }
  return rawResponses.map((response, index) => normalizeAdvisorFirstCallResponse(response, `${source}#${index + 1}`));
}

export function evaluateAdvisorDryRunFixtureResponse(fixture, rawResponse, opts = {}) {
  const thresholds = { ...DEFAULT_ADVISOR_DRY_RUN_THRESHOLDS, ...(opts.thresholds || {}) };
  return evaluateFixture({
    ...fixture,
    rawResponse: String(rawResponse),
    ...(opts.responseMetrics ? { responseMetrics: opts.responseMetrics } : {}),
  }, { ...opts, thresholds });
}

export function buildAdvisorFirstCallReplayReport(fixtures = undefined, opts = {}) {
  const loaded = Array.isArray(fixtures)
    ? { fixtures, sources: opts.fixtureSources || inferFixtureSources(fixtures) }
    : loadAdvisorDryRunFixtures({ fixtureDir: opts.fixtureDir });
  const fixtureList = loaded.fixtures;
  const fixtureById = new Map(fixtureList.map((fixture) => [fixture.id, fixture]));
  const requestPack = buildAdvisorFirstCallRequestPack(fixtureList, {
    ...opts,
    fixtureSources: loaded.sources,
  });
  const responseLoad = Array.isArray(opts.responses)
    ? {
      responses: opts.responses.map((response, index) => normalizeAdvisorFirstCallResponse(response, `inline#${index + 1}`)),
      sources: opts.responseSources || [{ source: 'inline', responseCount: opts.responses.length }],
    }
    : loadAdvisorFirstCallResponses(opts.responseDir);
  const requireCompleteResponses = opts.requireCompleteResponses === true;
  const requireResponseMetrics = opts.requireResponseMetrics === true;
  const expectedIds = requestPack.requests.map((entry) => entry.id);
  const expectedIdSet = new Set(expectedIds);
  const responseById = new Map();
  const duplicateIds = [];
  const unknownIds = [];

  for (const response of responseLoad.responses) {
    if (!expectedIdSet.has(response.id)) {
      unknownIds.push(response.id);
      continue;
    }
    if (responseById.has(response.id)) {
      duplicateIds.push(response.id);
      continue;
    }
    responseById.set(response.id, response);
  }

  const results = requestPack.requests.map((request) => {
    const fixture = fixtureById.get(request.id);
    const response = responseById.get(request.id);
    const fingerprintStatus = response
      ? evaluateRequestFingerprint(response.requestFingerprint, request.requestFingerprint)
      : { ok: false, status: 'missing_response', reason: 'response missing' };
    if (!fixture || !response) {
      return {
        id: request.id,
        source: request.source,
        category: request.category,
        calibration: request.calibration,
        expected: request.expected,
        responseStatus: 'missing',
        requestFingerprint: request.requestFingerprint,
        requestFingerprintStatus: fingerprintStatus.status,
        promptChars: request.promptChars,
        estimatedPromptTokens: request.estimatedPromptTokens,
      };
    }
    const evaluated = evaluateAdvisorDryRunFixtureResponse(fixture, response.rawResponse, {
      ...opts,
      responseMetrics: response.responseMetrics,
    });
    return {
      id: request.id,
      source: request.source,
      category: request.category,
      calibration: request.calibration,
      expected: request.expected,
      responseSource: response.source,
      responseStatus: 'present',
      requestFingerprint: request.requestFingerprint,
      responseRequestFingerprint: response.requestFingerprint || null,
      requestFingerprintStatus: fingerprintStatus.status,
      responseChars: evaluated.responseChars,
      responseMetrics: response.responseMetrics || null,
      stage: evaluated.stage,
      activationStatus: evaluated.activationStatus,
      reason: evaluated.reason,
      badIndex: evaluated.badIndex,
      safetyReasons: evaluated.safetyReasons || [],
      staleReasons: evaluated.staleReasons || [],
      planLength: evaluated.planLength,
      planSkills: evaluated.planSkills || [],
      expectationMet: evaluated.expectationMet === true,
      expectationFailures: evaluated.expectationFailures || [],
      promptBudgetOk: evaluated.promptBudgetOk === true,
      elapsedMs: evaluated.elapsedMs,
    };
  });
  const present = results.filter((result) => result.responseStatus === 'present');
  const missing = results.filter((result) => result.responseStatus === 'missing');
  const unexpected = present.filter((result) => result.expectationMet !== true);
  const promptBudgetViolations = present.filter((result) => result.promptBudgetOk !== true);
  const fingerprintMissing = present.filter((result) => result.requestFingerprintStatus === 'missing');
  const fingerprintMismatches = present.filter((result) => result.requestFingerprintStatus === 'mismatch');
  const responseMetricsReadiness = present.map((result) => ({
    id: result.id,
    ...evaluateResponseMetricsReadiness(result.responseMetrics),
  }));
  const responseMetricsIncomplete = responseMetricsReadiness.filter((result) => result.ready !== true);
  const hardFailures = [
    ...unknownIds.map((id) => `unknown response id ${id}`),
    ...duplicateIds.map((id) => `duplicate response id ${id}`),
    ...fingerprintMissing.map((result) => `${result.id} request fingerprint missing`),
    ...fingerprintMismatches.map((result) => `${result.id} request fingerprint mismatch`),
    ...unexpected.map((result) => `${result.id} expectation failed`),
    ...promptBudgetViolations.map((result) => `${result.id} prompt budget exceeded`),
    ...(requireCompleteResponses ? missing.map((result) => `${result.id} response missing`) : []),
    ...(requireResponseMetrics
      ? responseMetricsIncomplete.map((result) => `${result.id} response metrics incomplete: ${result.reason}`)
      : []),
  ];
  const complete = missing.length === 0;
  const ok = requestPack.ok === true && hardFailures.length === 0;

  return {
    ok,
    noApiCall: true,
    status: ok && complete
      ? 'validated_model_responses'
      : ok
        ? 'pending_model_responses'
        : 'blocked',
    generatedFrom: 'advisor first-call response replay',
    requireCompleteResponses,
    requireResponseMetrics,
    requestPackStatus: requestPack.status,
    expectedCount: expectedIds.length,
    presentCount: present.length,
    missingCount: missing.length,
    unknownCount: unknownIds.length,
    duplicateCount: duplicateIds.length,
    unexpectedOutcomes: unexpected.length,
    promptBudgetViolations: promptBudgetViolations.length,
    requestFingerprintReadyCount: present.filter((result) => result.requestFingerprintStatus === 'matched').length,
    requestFingerprintMissingCount: fingerprintMissing.length,
    requestFingerprintMismatchCount: fingerprintMismatches.length,
    responseMetricsReadyCount: responseMetricsReadiness.filter((result) => result.ready === true).length,
    responseMetricsIncompleteCount: responseMetricsIncomplete.length,
    responseMetricsIncomplete: responseMetricsIncomplete.map((result) => ({
      id: result.id,
      reason: result.reason,
    })),
    responseSources: responseLoad.sources,
    unknownIds,
    duplicateIds,
    failures: hardFailures,
    summary: {
      stageCounts: countBy(present, 'stage'),
      activationStatusCounts: countBy(present, 'activationStatus'),
      responseMetrics: summarizeRecordedResponseMetrics(present),
      responseMetricsReadiness,
    },
    results,
  };
}

export function renderAdvisorFirstCallReplayReport(report) {
  const lines = [
    '# Advisor First-Call Replay',
    '',
    `- no API call made: ${report.noApiCall === true ? 'yes' : 'unknown'}`,
    `- status: ${report.status || 'unknown'}`,
    `- require complete responses: ${report.requireCompleteResponses ? 'yes' : 'no'}`,
    `- require response metrics: ${report.requireResponseMetrics ? 'yes' : 'no'}`,
    `- expected responses: ${report.expectedCount || 0}`,
    `- present responses: ${report.presentCount || 0}`,
    `- missing responses: ${report.missingCount || 0}`,
    `- unknown responses: ${report.unknownCount || 0}`,
    `- duplicate responses: ${report.duplicateCount || 0}`,
    `- unexpected outcomes: ${report.unexpectedOutcomes || 0}`,
    `- prompt budget violations: ${report.promptBudgetViolations || 0}`,
    `- request fingerprints matched: ${report.requestFingerprintReadyCount || 0}/${report.presentCount || 0}`,
    `- request fingerprints missing: ${report.requestFingerprintMissingCount || 0}`,
    `- request fingerprints mismatched: ${report.requestFingerprintMismatchCount || 0}`,
    `- response metrics complete: ${report.responseMetricsReadyCount || 0}/${report.presentCount || 0}`,
    `- response metrics incomplete: ${report.responseMetricsIncompleteCount || 0}`,
    `- response sources: ${formatResponseSources(report.responseSources)}`,
    `- response metrics: ${formatRecordedResponseMetrics(report.summary?.responseMetrics || {})}`,
    '',
    '| Candidate | Response | Fingerprint | Stage | Activation | Expected | Outcome |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const result of report.results || []) {
    const outcome = result.responseStatus === 'missing'
      ? 'missing'
      : result.expectationMet
        ? 'ok'
        : `failed: ${(result.expectationFailures || []).join('; ') || result.reason || 'unknown'}`;
    lines.push(`| ${[
      result.id,
      result.responseStatus || 'unknown',
      result.requestFingerprintStatus || '',
      result.stage || '',
      result.activationStatus || '',
      escapeTable(formatExpectedBrief(result.expected)),
      escapeTable(outcome),
    ].join(' | ')} |`);
  }

  if ((report.failures || []).length > 0) {
    lines.push('', '## Failures');
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }

  return `${lines.join('\n')}\n`;
}

export function buildAdvisorFirstCallResponseTemplate(fixtures = undefined, opts = {}) {
  const requestPack = buildAdvisorFirstCallRequestPack(fixtures, opts);
  const responseDir = opts.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
  const responseDocument = {
    schemaVersion: 1,
    generatedFrom: 'advisor first-call request pack',
    noApiCall: true,
    replaceBeforeReplay: true,
    responses: (requestPack.requests || []).map((entry) => ({
      id: entry.id,
      requestFingerprint: entry.requestFingerprint,
      rawResponse: '',
      _capture: {
        status: 'replace rawResponse with the exact assistant message content before replay',
        source: entry.source,
        goal: entry.goal,
        category: entry.category,
        calibration: entry.calibration,
        expected: entry.expected,
        request: {
          fingerprint: entry.requestFingerprint,
          fingerprintAlgorithm: entry.requestFingerprintAlgorithm,
          model: entry.request?.model,
          temperature: entry.request?.temperature,
          response_format: entry.request?.response_format,
          max_tokens: entry.request?.max_tokens,
          messageCount: Array.isArray(entry.request?.messages) ? entry.request.messages.length : 0,
        },
        promptChars: entry.promptChars,
        estimatedPromptTokens: entry.estimatedPromptTokens,
        responseMetricsRequiredFields: ['latencyMs', 'totalTokens'],
        responseMetricsTemplate: {
          source: 'first_gated_deepseek_call',
          provider: 'deepseek',
          model: entry.request?.model || requestPack.requestDefaults?.model,
          latencyMs: 'number',
          promptTokens: 'number',
          completionTokens: 'number',
          totalTokens: 'number',
        },
      },
    })),
  };

  return {
    ok: requestPack.ok === true,
    noApiCall: true,
    status: requestPack.ok === true ? 'response_template_ready' : 'blocked',
    generatedFrom: 'advisor first-call request pack',
    responseDir,
    strictReplayEnv: 'MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=1',
    responseCount: responseDocument.responses.length,
    requestPackStatus: requestPack.status,
    responseDocument,
  };
}

export function renderAdvisorFirstCallResponseTemplate(template) {
  const lines = [
    '# Advisor First-Call Response Template',
    '',
    `- no API call made: ${template.noApiCall === true ? 'yes' : 'unknown'}`,
    `- status: ${template.status || 'unknown'}`,
    `- response count: ${template.responseCount || 0}`,
    `- response dir: ${template.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR}`,
    `- strict replay env: ${template.strictReplayEnv || 'MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=1'}`,
    `- request pack status: ${template.requestPackStatus || 'unknown'}`,
    '',
    '## Usage',
    '',
    '1. Copy the JSON response document to the configured private response directory after an explicitly gated DeepSeek run.',
    '2. Replace each empty `rawResponse` with the exact assistant message content returned for that candidate.',
    '3. Add `responseMetrics` for every response; strict metrics replay and promotion require at least `latencyMs` and `totalTokens`.',
    '4. `_capture.responseMetricsTemplate` is a template only and is ignored by the replay loader.',
    '5. Run strict replay with `MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=1` after all responses are captured.',
    '6. Run strict metrics replay with both `MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=1` and `MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSE_METRICS=1` before promotion.',
    '',
    '| Candidate | Tier | Expected | Model | Fingerprint | Prompt chars | Est. prompt tokens |',
    '| --- | --- | --- | --- | --- | ---: | ---: |',
  ];

  for (const response of template.responseDocument?.responses || []) {
    const capture = response._capture || {};
    lines.push(`| ${[
      response.id,
      escapeTable(capture.calibration?.tier || ''),
      escapeTable(formatExpectedBrief(capture.expected)),
      escapeTable(capture.request?.model || ''),
      shortFingerprint(response.requestFingerprint),
      capture.promptChars ?? '',
      capture.estimatedPromptTokens ?? '',
    ].join(' | ')} |`);
  }

  return `${lines.join('\n')}\n`;
}

export function buildAdvisorCalibrationLadder(fixtures = undefined, opts = {}) {
  const loaded = Array.isArray(fixtures)
    ? { fixtures, sources: opts.fixtureSources || inferFixtureSources(fixtures) }
    : loadAdvisorDryRunFixtures({ fixtureDir: opts.fixtureDir });
  const fixtureList = loaded.fixtures;
  const sharedOpts = {
    ...opts,
    fixtureSources: loaded.sources,
  };
  const dryRun = runAdvisorDryRunCalibration(fixtureList, sharedOpts);
  const requestPack = buildAdvisorFirstCallRequestPack(fixtureList, sharedOpts);
  const responseTemplate = buildAdvisorFirstCallResponseTemplate(fixtureList, sharedOpts);
  const replay = buildAdvisorFirstCallReplayReport(fixtureList, {
    ...sharedOpts,
    requireCompleteResponses: false,
  });
  const strictReplay = buildAdvisorFirstCallReplayReport(fixtureList, {
    ...sharedOpts,
    requireCompleteResponses: true,
  });
  const strictMetricsReplay = buildAdvisorFirstCallReplayReport(fixtureList, {
    ...sharedOpts,
    requireCompleteResponses: true,
    requireResponseMetrics: true,
  });
  const readyForFirstGatedCapture = dryRun.ok === true
    && requestPack.ok === true
    && responseTemplate.ok === true
    && replay.ok === true;
  const readyForGatedLiveCalibration = readyForFirstGatedCapture
    && strictReplay.ok === true
    && strictReplay.status === 'validated_model_responses'
    && strictMetricsReplay.ok === true
    && strictMetricsReplay.status === 'validated_model_responses';
  const promotionCriteria = buildAdvisorCalibrationPromotionCriteria({
    dryRun,
    requestPack,
    responseTemplate,
    replay,
    strictReplay,
    strictMetricsReplay,
  });
  const pendingReasons = promotionCriteria
    .filter((criterion) => criterion.satisfied !== true && criterion.severity === 'pending')
    .map((criterion) => criterion.reason);
  const failures = promotionCriteria
    .filter((criterion) => criterion.satisfied !== true && criterion.severity === 'failure')
    .map((criterion) => criterion.reason);
  const requireReadyForGatedLiveCalibration = opts.requireReadyForGatedLiveCalibration === true;
  const ok = readyForFirstGatedCapture
    && failures.length === 0
    && (!requireReadyForGatedLiveCalibration || readyForGatedLiveCalibration);
  const currentStage = !readyForFirstGatedCapture || failures.length > 0
    ? 'blocked'
    : readyForGatedLiveCalibration
      ? 'first_call_replay_validated'
      : 'first_call_capture_ready';
  const status = currentStage === 'blocked'
    ? 'blocked'
    : readyForGatedLiveCalibration
      ? 'ready_for_gated_live_calibration'
      : 'ready_for_first_gated_capture';

  return {
    ok,
    noApiCall: true,
    status,
    currentStage,
    generatedFrom: 'advisor dry-run calibration, first-call request pack, response template, and replay reports',
    readyForFirstGatedCapture,
    readyForGatedLiveCalibration,
    requireReadyForGatedLiveCalibration,
    nextAction: readyForGatedLiveCalibration
      ? 'begin_private_live_advisor_calibration_with_deepseek_opt_in'
      : readyForFirstGatedCapture
        ? 'run_explicitly_gated_first_call_capture_then_strict_replay'
        : 'fix_blocked_advisor_calibration_artifacts',
    responseDir: opts.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR,
    strictReplayEnv: 'MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=1',
    fixtureSources: dryRun.fixtureSources,
    stages: [
      {
        id: 'dry_run_benchmark',
        status: dryRun.ok ? 'ready' : 'blocked',
        ready: dryRun.ok === true,
        evidence: `${dryRun.fixtureCount} fixtures; unexpected=${dryRun.summary?.unexpectedOutcomes ?? 'unknown'}; promptBudgetViolations=${dryRun.summary?.promptBudgetViolations ?? 'unknown'}; coverageViolations=${dryRun.summary?.coverageViolations ?? 'unknown'}`,
      },
      {
        id: 'first_call_request_pack',
        status: requestPack.ok ? 'ready' : 'blocked',
        ready: requestPack.ok === true,
        evidence: `${requestPack.requestCount || 0} requests; status=${requestPack.status}`,
      },
      {
        id: 'first_call_response_template',
        status: responseTemplate.ok ? 'ready' : 'blocked',
        ready: responseTemplate.ok === true,
        evidence: `${responseTemplate.responseCount || 0} response templates; status=${responseTemplate.status}`,
      },
      {
        id: 'first_call_replay_default',
        status: replay.status,
        ready: replay.ok === true,
        evidence: `present=${replay.presentCount}; missing=${replay.missingCount}; unexpected=${replay.unexpectedOutcomes}; promptBudgetViolations=${replay.promptBudgetViolations}`,
      },
      {
        id: 'first_call_strict_replay',
        status: strictReplay.status,
        ready: strictReplay.ok === true && strictReplay.status === 'validated_model_responses',
        evidence: `present=${strictReplay.presentCount}; missing=${strictReplay.missingCount}; failures=${strictReplay.failures.length}`,
      },
      {
        id: 'first_call_response_metrics',
        status: strictMetricsReplay.status,
        ready: strictMetricsReplay.ok === true && strictMetricsReplay.status === 'validated_model_responses',
        evidence: `metricsReady=${strictMetricsReplay.responseMetricsReadyCount || 0}/${strictMetricsReplay.presentCount || 0}; incomplete=${strictMetricsReplay.responseMetricsIncompleteCount || 0}; failures=${strictMetricsReplay.failures.length}`,
      },
    ],
    promotionCriteria,
    pendingReasons,
    failures,
    summary: {
      dryRun: {
        ok: dryRun.ok,
        fixtureCount: dryRun.fixtureCount,
        unexpectedOutcomes: dryRun.summary?.unexpectedOutcomes ?? 0,
        promptBudgetViolations: dryRun.summary?.promptBudgetViolations ?? 0,
        coverageViolations: dryRun.summary?.coverageViolations ?? 0,
        firstCallReadinessStatus: dryRun.firstCallReadiness?.status || 'unknown',
        firstCallCandidateCount: dryRun.firstCallReadiness?.candidateCount || 0,
      },
      requestPack: {
        ok: requestPack.ok,
        status: requestPack.status,
        requestCount: requestPack.requestCount || 0,
        totalPromptChars: requestPack.totalPromptChars || 0,
        totalEstimatedPromptTokens: requestPack.totalEstimatedPromptTokens || 0,
      },
      responseTemplate: {
        ok: responseTemplate.ok,
        status: responseTemplate.status,
        responseCount: responseTemplate.responseCount || 0,
        responseDir: responseTemplate.responseDir,
      },
      replay: summarizeFirstCallReplayForLadder(replay),
      strictReplay: summarizeFirstCallReplayForLadder(strictReplay),
      strictMetricsReplay: summarizeFirstCallReplayForLadder(strictMetricsReplay),
    },
  };
}

export function renderAdvisorCalibrationLadder(ladder) {
  const lines = [
    '# Advisor Calibration Ladder',
    '',
    `- no API call made: ${ladder.noApiCall === true ? 'yes' : 'unknown'}`,
    `- status: ${ladder.status || 'unknown'}`,
    `- current stage: ${ladder.currentStage || 'unknown'}`,
    `- ready for first gated capture: ${ladder.readyForFirstGatedCapture ? 'yes' : 'no'}`,
    `- ready for gated live calibration: ${ladder.readyForGatedLiveCalibration ? 'yes' : 'no'}`,
    `- require gated-live readiness for success: ${ladder.requireReadyForGatedLiveCalibration ? 'yes' : 'no'}`,
    `- next action: ${ladder.nextAction || 'unknown'}`,
    `- response dir: ${ladder.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR}`,
    `- strict replay env: ${ladder.strictReplayEnv || 'MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=1'}`,
    '',
    '## Stages',
    '',
    '| Stage | Status | Ready | Evidence |',
    '| --- | --- | --- | --- |',
  ];

  for (const stage of ladder.stages || []) {
    lines.push(`| ${[
      stage.id,
      stage.status || 'unknown',
      stage.ready ? 'yes' : 'no',
      escapeTable(stage.evidence || ''),
    ].join(' | ')} |`);
  }

  lines.push('', '## Promotion Criteria', '');
  lines.push('| Criterion | Status | Severity | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const criterion of ladder.promotionCriteria || []) {
    lines.push(`| ${[
      criterion.id,
      criterion.satisfied ? 'passed' : 'pending',
      criterion.severity || '',
      escapeTable(criterion.reason || criterion.evidence || ''),
    ].join(' | ')} |`);
  }

  if ((ladder.pendingReasons || []).length > 0) {
    lines.push('', '## Pending');
    for (const reason of ladder.pendingReasons) lines.push(`- ${reason}`);
  }

  if ((ladder.failures || []).length > 0) {
    lines.push('', '## Failures');
    for (const failure of ladder.failures) lines.push(`- ${failure}`);
  }

  return `${lines.join('\n')}\n`;
}

function buildAdvisorCalibrationPromotionCriteria({
  dryRun,
  requestPack,
  responseTemplate,
  replay,
  strictReplay,
  strictMetricsReplay,
}) {
  return [
    ladderCriterion({
      id: 'dry_run_clean',
      satisfied: dryRun.ok === true,
      severity: 'failure',
      evidence: `${dryRun.fixtureCount} fixtures passed dry-run benchmark`,
      reason: `dry-run benchmark blocked: unexpected=${dryRun.summary?.unexpectedOutcomes ?? 'unknown'}, promptBudgetViolations=${dryRun.summary?.promptBudgetViolations ?? 'unknown'}, coverageViolations=${dryRun.summary?.coverageViolations ?? 'unknown'}`,
    }),
    ladderCriterion({
      id: 'first_call_request_pack_ready',
      satisfied: requestPack.ok === true && requestPack.requestCount > 0,
      severity: 'failure',
      evidence: `${requestPack.requestCount || 0} first-call requests are ready`,
      reason: `first-call request pack blocked: status=${requestPack.status || 'unknown'}, requestCount=${requestPack.requestCount || 0}`,
    }),
    ladderCriterion({
      id: 'first_call_response_template_ready',
      satisfied: responseTemplate.ok === true
        && responseTemplate.responseCount === requestPack.requestCount,
      severity: 'failure',
      evidence: `${responseTemplate.responseCount || 0} response templates match the request pack`,
      reason: `first-call response template blocked: status=${responseTemplate.status || 'unknown'}, responseCount=${responseTemplate.responseCount || 0}, requestCount=${requestPack.requestCount || 0}`,
    }),
    ladderCriterion({
      id: 'default_replay_safe',
      satisfied: replay.ok === true,
      severity: 'failure',
      evidence: `default replay is ${replay.status}`,
      reason: `default replay blocked: ${replay.failures?.join('; ') || replay.status || 'unknown'}`,
    }),
    ladderCriterion({
      id: 'first_call_responses_complete',
      satisfied: strictReplay.missingCount === 0
        && strictReplay.unknownCount === 0
        && strictReplay.duplicateCount === 0,
      severity: 'pending',
      evidence: `${strictReplay.presentCount || 0}/${strictReplay.expectedCount || 0} responses captured`,
      reason: `missing ${strictReplay.missingCount || 0} of ${strictReplay.expectedCount || 0} first-call model responses`,
    }),
    ladderCriterion({
      id: 'strict_replay_validated',
      satisfied: strictReplay.ok === true && strictReplay.status === 'validated_model_responses',
      severity: strictReplay.missingCount > 0 ? 'pending' : 'failure',
      evidence: 'strict replay validated all captured first-call model responses',
      reason: strictReplay.missingCount > 0
        ? 'strict replay pending until all first-call responses are captured'
        : `strict replay blocked: ${strictReplay.failures?.join('; ') || strictReplay.status || 'unknown'}`,
    }),
    ladderCriterion({
      id: 'first_call_response_metrics_complete',
      satisfied: strictMetricsReplay.ok === true
        && strictMetricsReplay.status === 'validated_model_responses'
        && strictMetricsReplay.responseMetricsIncompleteCount === 0
        && strictMetricsReplay.responseMetricsReadyCount === strictMetricsReplay.presentCount
        && strictMetricsReplay.presentCount === strictMetricsReplay.expectedCount,
      severity: strictMetricsReplay.missingCount > 0 ? 'pending' : 'failure',
      evidence: 'latency and token metrics were captured for every first-call response',
      reason: strictMetricsReplay.missingCount > 0
        ? 'response metrics pending until all first-call responses are captured'
        : `response metrics incomplete: ${formatResponseMetricsIncomplete(strictMetricsReplay)}`,
    }),
  ];
}

function ladderCriterion({ id, satisfied, severity, evidence, reason }) {
  return {
    id,
    satisfied: satisfied === true,
    severity,
    evidence,
    reason: satisfied === true ? evidence : reason,
  };
}

function summarizeFirstCallReplayForLadder(report) {
  return {
    ok: report.ok,
    status: report.status,
    requireCompleteResponses: report.requireCompleteResponses,
    requireResponseMetrics: report.requireResponseMetrics,
    expectedCount: report.expectedCount || 0,
    presentCount: report.presentCount || 0,
    missingCount: report.missingCount || 0,
    unknownCount: report.unknownCount || 0,
    duplicateCount: report.duplicateCount || 0,
    unexpectedOutcomes: report.unexpectedOutcomes || 0,
    promptBudgetViolations: report.promptBudgetViolations || 0,
    responseMetricsReadyCount: report.responseMetricsReadyCount || 0,
    responseMetricsIncompleteCount: report.responseMetricsIncompleteCount || 0,
    responseMetricsIncomplete: report.responseMetricsIncomplete || [],
    failureCount: (report.failures || []).length,
    responseMetrics: report.summary?.responseMetrics || summarizeRecordedResponseMetrics([]),
  };
}

function evaluateFixture(fixture, opts) {
  const goal = fixture.goal || 'unspecified advisor dry-run goal';
  const snapshot = fixture.snapshot || safeSnapshot();
  const prompt = userPromptInitial(goal, snapshot);
  const promptChars = prompt.length;
  const estimatedPromptTokens = estimateTokens(prompt);
  const promptBudgetOk = promptWithinBudget(promptChars, estimatedPromptTokens, opts.thresholds);
  const rawResponse = fixture.rawResponse ?? '';
  const responseChars = String(rawResponse).length;
  const validation = validatePlannerResponse(String(rawResponse));
  const expected = fixture.expected || {};

  const base = {
    id: fixture.id || 'unnamed',
    category: fixture.category || 'uncategorized',
    goal,
    source: fixture.source || 'builtin',
    promptChars,
    estimatedPromptTokens,
    promptBudgetOk,
    responseChars,
    responseMetrics: fixture.responseMetrics || null,
    calibration: fixture.calibration || null,
    elapsedMs: 0,
  };

  if (!validation.ok) {
    const result = {
      ...base,
      ok: false,
      stage: validation.stage,
      activationStatus: 'not-run',
      reason: validation.reason,
      badIndex: validation.badIndex,
    };
    return finish(withExpectation(result, expected), opts);
  }

  const activation = validatePlanActivation(validation.plan, snapshot, {
    ...(opts.activationGuardOptions || {}),
    proposedFromSnapshot: fixture.proposedFromSnapshot || snapshot,
  });

  const result = {
    ...base,
    ok: activation.ok,
    stage: 'activation',
    activationStatus: activation.ok ? 'accepted' : 'rejected',
    reason: activation.ok ? 'accepted' : activation.reason,
    badIndex: activation.badIndex,
    safetyReasons: activation.safetyReasons || [],
    staleReasons: activation.staleReasons || [],
    planLength: validation.plan.length,
    planSkills: validation.plan.map((call) => call.skill),
  };
  return finish(withExpectation(result, expected), opts);
}

function summarizeResults(results, thresholds, coverageRequirements) {
  const categoryCounts = countBy(results, 'category');
  const stageCounts = countBy(results, 'stage');
  const activationStatusCounts = countBy(results, 'activationStatus');
  const calibrationTierCounts = countCalibrationTiers(results);
  const coverageFailures = coverageRequirementFailures({
    fixtureCount: results.length,
    categoryCounts,
    stageCounts,
    activationStatusCounts,
    calibrationTierCounts,
  }, coverageRequirements);
  return {
    jsonValid: results.filter((result) => result.stage !== 'json').length,
    planValid: results.filter((result) => result.stage === 'activation').length,
    activationAccepted: results.filter((result) => result.activationStatus === 'accepted').length,
    activationRejected: results.filter((result) => result.activationStatus === 'rejected').length,
    invalidResponses: results.filter((result) => result.stage !== 'activation').length,
    unexpectedOutcomes: results.filter((result) => !result.expectationMet).length,
    expectationDetailFailures: results.reduce((sum, result) => sum + (result.expectationFailures?.length || 0), 0),
    promptBudgetViolations: results.filter((result) => !result.promptBudgetOk).length,
    coverageViolations: coverageFailures.length,
    coverageFailures,
    categoryCounts,
    stageCounts,
    activationStatusCounts,
    calibrationTierCounts,
    validationLatencyMs: numericStats(results.map((result) => result.elapsedMs)),
    recordedResponseMetrics: summarizeRecordedResponseMetrics(results),
    maxPromptChars: maxNumber(results.map((result) => result.promptChars)),
    maxEstimatedPromptTokens: maxNumber(results.map((result) => result.estimatedPromptTokens)),
    promptBudget: thresholds,
    totalPromptChars: results.reduce((sum, result) => sum + result.promptChars, 0),
    totalEstimatedPromptTokens: results.reduce((sum, result) => sum + result.estimatedPromptTokens, 0),
  };
}

function mergeCoverageRequirements(overrides = {}) {
  if (overrides.replaceDefaults === true) {
    return {
      minFixtureCount: overrides.minFixtureCount ?? 0,
      requiredCategories: { ...(overrides.requiredCategories || {}) },
      requiredStages: { ...(overrides.requiredStages || {}) },
      requiredActivationStatuses: { ...(overrides.requiredActivationStatuses || {}) },
      requiredCalibrationTiers: { ...(overrides.requiredCalibrationTiers || {}) },
    };
  }
  return {
    minFixtureCount: overrides.minFixtureCount ?? DEFAULT_ADVISOR_DRY_RUN_COVERAGE.minFixtureCount,
    requiredCategories: {
      ...DEFAULT_ADVISOR_DRY_RUN_COVERAGE.requiredCategories,
      ...(overrides.requiredCategories || {}),
    },
    requiredStages: {
      ...DEFAULT_ADVISOR_DRY_RUN_COVERAGE.requiredStages,
      ...(overrides.requiredStages || {}),
    },
    requiredActivationStatuses: {
      ...DEFAULT_ADVISOR_DRY_RUN_COVERAGE.requiredActivationStatuses,
      ...(overrides.requiredActivationStatuses || {}),
    },
    requiredCalibrationTiers: {
      ...DEFAULT_ADVISOR_DRY_RUN_COVERAGE.requiredCalibrationTiers,
      ...(overrides.requiredCalibrationTiers || {}),
    },
  };
}

function mergeFirstCallReadinessRequirements(overrides = {}) {
  if (overrides.replaceDefaults === true) {
    return {
      candidateFlag: normalizeCandidateFlag(overrides.candidateFlag || DEFAULT_ADVISOR_FIRST_CALL_READINESS.candidateFlag),
      minCandidates: overrides.minCandidates ?? 0,
      requiredCandidateIds: [...(overrides.requiredCandidateIds || [])],
      requiredStages: { ...(overrides.requiredStages || {}) },
      requiredActivationStatuses: { ...(overrides.requiredActivationStatuses || {}) },
      requiredCalibrationTiers: { ...(overrides.requiredCalibrationTiers || {}) },
    };
  }
  return {
    candidateFlag: normalizeCandidateFlag(overrides.candidateFlag || DEFAULT_ADVISOR_FIRST_CALL_READINESS.candidateFlag),
    minCandidates: overrides.minCandidates ?? DEFAULT_ADVISOR_FIRST_CALL_READINESS.minCandidates,
    requiredCandidateIds: [
      ...DEFAULT_ADVISOR_FIRST_CALL_READINESS.requiredCandidateIds,
      ...(overrides.requiredCandidateIds || []),
    ],
    requiredStages: {
      ...DEFAULT_ADVISOR_FIRST_CALL_READINESS.requiredStages,
      ...(overrides.requiredStages || {}),
    },
    requiredActivationStatuses: {
      ...DEFAULT_ADVISOR_FIRST_CALL_READINESS.requiredActivationStatuses,
      ...(overrides.requiredActivationStatuses || {}),
    },
    requiredCalibrationTiers: {
      ...DEFAULT_ADVISOR_FIRST_CALL_READINESS.requiredCalibrationTiers,
      ...(overrides.requiredCalibrationTiers || {}),
    },
  };
}

function summarizeFirstCallReadiness(results, requirements) {
  const candidateFlag = normalizeCandidateFlag(requirements.candidateFlag || DEFAULT_ADVISOR_FIRST_CALL_READINESS.candidateFlag);
  const candidates = results.filter((result) => result.calibration?.[candidateFlag] === true);
  const candidateIds = candidates.map((result) => result.id);
  const stageCounts = countBy(candidates, 'stage');
  const activationStatusCounts = countBy(candidates, 'activationStatus');
  const calibrationTierCounts = countBy(candidates, (result) => result.calibration?.tier || 'none');
  const failures = [];

  if (candidates.length < requirements.minCandidates) {
    failures.push(`firstCallCandidates ${candidates.length} < ${requirements.minCandidates}`);
  }
  for (const id of requirements.requiredCandidateIds || []) {
    if (!candidateIds.includes(id)) failures.push(`missing first-call candidate ${id}`);
  }
  failures.push(...countFailures('firstCall.stage', stageCounts, requirements.requiredStages));
  failures.push(...countFailures('firstCall.activationStatus', activationStatusCounts, requirements.requiredActivationStatuses));
  failures.push(...countFailures('firstCall.calibrationTier', calibrationTierCounts, requirements.requiredCalibrationTiers));
  for (const candidate of candidates) {
    if (candidate.expectationMet !== true) {
      failures.push(`${candidate.id} expectation failed`);
    }
    if (candidate.promptBudgetOk !== true) {
      failures.push(`${candidate.id} prompt budget exceeded`);
    }
    if (candidate.stage !== 'activation') {
      failures.push(`${candidate.id} did not reach activation stage`);
    }
  }

  const ready = failures.length === 0;
  return {
    ready,
    status: ready ? 'ready_for_gated_deepseek_dry_run' : 'blocked',
    nextAction: ready ? 'run_explicitly_gated_deepseek_dry_run' : 'fix_first_call_candidate_corpus',
    candidateFlag,
    candidateCount: candidates.length,
    candidateIds,
    stageCounts,
    activationStatusCounts,
    calibrationTierCounts,
    failures,
  };
}

function normalizeCandidateFlag(value) {
  const flag = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(flag)) {
    throw new Error(`advisor first-call candidate flag must be an identifier, got "${flag}"`);
  }
  return flag;
}

function coverageRequirementFailures(summary, requirements) {
  const failures = [];
  if (summary.fixtureCount < requirements.minFixtureCount) {
    failures.push(`fixtureCount ${summary.fixtureCount} < ${requirements.minFixtureCount}`);
  }
  failures.push(...countFailures('category', summary.categoryCounts, requirements.requiredCategories));
  failures.push(...countFailures('stage', summary.stageCounts, requirements.requiredStages));
  failures.push(...countFailures('activationStatus', summary.activationStatusCounts, requirements.requiredActivationStatuses));
  failures.push(...countFailures('calibrationTier', summary.calibrationTierCounts, requirements.requiredCalibrationTiers));
  return failures;
}

function countFailures(label, actual, required) {
  const failures = [];
  for (const [name, min] of Object.entries(required || {})) {
    const count = actual?.[name] || 0;
    if (count < min) failures.push(`${label}.${name} ${count} < ${min}`);
  }
  return failures;
}

function withExpectation(result, expected) {
  const expectedStage = expected.stage || null;
  const expectedActivationStatus = expected.activationStatus || null;
  const expectedReasonIncludes = normalizeStringList(expected.reasonIncludes);
  const expectedPlanSkills = normalizeStringList(expected.planSkills);
  const expectedPlanSkillsInclude = normalizeStringList(expected.planSkillsInclude);
  const expectedPlanSkillsAllowed = normalizeStringList(expected.planSkillsAllowed);
  const expectedSafetyReasonsInclude = normalizeStringList(expected.safetyReasonsInclude);
  const expectedStaleReasonsInclude = normalizeStringList(expected.staleReasonsInclude);
  const expectedPlanLength = numberOrNull(expected.planLength);
  const expectedPlanLengthMin = numberOrNull(expected.planLengthMin);
  const expectedPlanLengthMax = numberOrNull(expected.planLengthMax);
  const expectedBadIndex = numberOrNull(expected.badIndex);
  const failures = [];

  if (expectedStage && result.stage !== expectedStage) {
    failures.push(`stage ${result.stage} !== ${expectedStage}`);
  }
  if (expectedActivationStatus && result.activationStatus !== expectedActivationStatus) {
    failures.push(`activationStatus ${result.activationStatus} !== ${expectedActivationStatus}`);
  }
  for (const reasonNeedle of expectedReasonIncludes) {
    if (!String(result.reason || '').includes(reasonNeedle)) {
      failures.push(`reason missing "${reasonNeedle}"`);
    }
  }
  if (expectedPlanSkills.length > 0 && !arrayEqual(result.planSkills || [], expectedPlanSkills)) {
    failures.push(`planSkills ${JSON.stringify(result.planSkills || [])} !== ${JSON.stringify(expectedPlanSkills)}`);
  }
  for (const skill of expectedPlanSkillsInclude) {
    if (!(result.planSkills || []).includes(skill)) {
      failures.push(`planSkills missing ${skill}`);
    }
  }
  if (expectedPlanSkillsAllowed.length > 0) {
    const disallowed = (result.planSkills || []).filter((skill) => !expectedPlanSkillsAllowed.includes(skill));
    if (disallowed.length > 0) {
      failures.push(`planSkills include disallowed ${JSON.stringify(disallowed)}`);
    }
  }
  if (expectedPlanLength !== null && result.planLength !== expectedPlanLength) {
    failures.push(`planLength ${result.planLength ?? 'none'} !== ${expectedPlanLength}`);
  }
  if (expectedPlanLengthMin !== null && !(Number.isFinite(result.planLength) && result.planLength >= expectedPlanLengthMin)) {
    failures.push(`planLength ${result.planLength ?? 'none'} < ${expectedPlanLengthMin}`);
  }
  if (expectedPlanLengthMax !== null && !(Number.isFinite(result.planLength) && result.planLength <= expectedPlanLengthMax)) {
    failures.push(`planLength ${result.planLength ?? 'none'} > ${expectedPlanLengthMax}`);
  }
  if (expectedBadIndex !== null && result.badIndex !== expectedBadIndex) {
    failures.push(`badIndex ${result.badIndex ?? 'none'} !== ${expectedBadIndex}`);
  }
  failures.push(...missingIncludes('safetyReasons', result.safetyReasons, expectedSafetyReasonsInclude));
  failures.push(...missingIncludes('staleReasons', result.staleReasons, expectedStaleReasonsInclude));

  return {
    ...result,
    expected: {
      stage: expectedStage,
      activationStatus: expectedActivationStatus,
      reasonIncludes: expectedReasonIncludes.length > 0 ? expectedReasonIncludes : null,
      planSkills: expectedPlanSkills.length > 0 ? expectedPlanSkills : null,
      planSkillsInclude: expectedPlanSkillsInclude.length > 0 ? expectedPlanSkillsInclude : null,
      planSkillsAllowed: expectedPlanSkillsAllowed.length > 0 ? expectedPlanSkillsAllowed : null,
      planLength: expectedPlanLength,
      planLengthMin: expectedPlanLengthMin,
      planLengthMax: expectedPlanLengthMax,
      badIndex: expectedBadIndex,
      safetyReasonsInclude: expectedSafetyReasonsInclude.length > 0 ? expectedSafetyReasonsInclude : null,
      staleReasonsInclude: expectedStaleReasonsInclude.length > 0 ? expectedStaleReasonsInclude : null,
    },
    expectationFailures: failures,
    expectationMet: failures.length === 0,
  };
}

function promptWithinBudget(promptChars, estimatedPromptTokens, thresholds) {
  return promptChars <= thresholds.maxPromptChars
    && estimatedPromptTokens <= thresholds.maxEstimatedPromptTokens;
}

function categoryCounts(results) {
  return countBy(results, 'category');
}

function countCalibrationTiers(results) {
  const out = {};
  for (const result of results) {
    const tier = result.calibration?.tier;
    if (typeof tier !== 'string' || tier.trim() === '') continue;
    out[tier] = (out[tier] || 0) + 1;
  }
  return out;
}

function countBy(results, key) {
  const out = {};
  for (const result of results) {
    const value = typeof key === 'function' ? key(result) || 'unknown' : result[key] || 'unknown';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function maxNumber(values) {
  return values.length ? Math.max(...values) : 0;
}

function finish(result, opts = {}) {
  return {
    ...result,
    elapsedMs: Number.isFinite(opts.validationElapsedMs) ? opts.validationElapsedMs : 0,
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|');
}

function normalizeAdvisorDryRunFixture(fixture, source) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error(`advisor dry-run fixture ${source} entry must be an object`);
  }
  for (const field of ['id', 'category', 'goal']) {
    if (typeof fixture[field] !== 'string' || fixture[field].trim() === '') {
      throw new Error(`advisor dry-run fixture ${source} missing string field "${field}"`);
    }
  }
  if (!fixture.snapshot || typeof fixture.snapshot !== 'object' || Array.isArray(fixture.snapshot)) {
    throw new Error(`advisor dry-run fixture ${source} missing object field "snapshot"`);
  }
  if (!fixture.expected || typeof fixture.expected !== 'object' || Array.isArray(fixture.expected)) {
    throw new Error(`advisor dry-run fixture ${source} missing object field "expected"`);
  }
  const hasRawResponse = fixture.rawResponse !== undefined;
  const hasResponse = fixture.response !== undefined;
  if (hasRawResponse === hasResponse) {
    throw new Error(`advisor dry-run fixture ${source} must provide exactly one of rawResponse or response`);
  }
  return {
    id: fixture.id,
    category: fixture.category,
    goal: fixture.goal,
    snapshot: fixture.snapshot,
    ...(fixture.proposedFromSnapshot ? { proposedFromSnapshot: fixture.proposedFromSnapshot } : {}),
    rawResponse: hasRawResponse ? String(fixture.rawResponse) : JSON.stringify(fixture.response),
    expected: normalizeExpected(fixture.expected, source),
    ...(fixture.calibration !== undefined
      ? { calibration: normalizeCalibration(fixture.calibration, source) }
      : {}),
    ...(fixture.responseMetrics !== undefined
      ? { responseMetrics: normalizeResponseMetrics(fixture.responseMetrics, source) }
      : {}),
    source,
  };
}

function inferFixtureSources(fixtures) {
  const counts = {};
  for (const fixture of fixtures || []) {
    const source = fixture.source || 'builtin';
    counts[source] = (counts[source] || 0) + 1;
  }
  return Object.entries(counts).map(([source, fixtureCount]) => ({ source, fixtureCount }));
}

function formatFixtureSources(sources = []) {
  if (!sources.length) return 'none';
  return sources
    .map((entry) => `${entry.source}${entry.status ? `(${entry.status})` : ''}:${entry.fixtureCount}`)
    .join(', ');
}

function formatRequirementCounts(counts = {}, opts = {}) {
  const separator = opts.separator || '>=';
  const empty = opts.empty || 'none';
  const entries = Object.entries(counts || {});
  if (!entries.length) return empty;
  return entries.map(([name, count]) => `${name}${separator}${count}`).join(', ');
}

function normalizeSourcePath(value) {
  return String(value).replace(/\\/g, '/');
}

function normalizeResponseMetrics(metrics, source) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error(`advisor dry-run fixture ${source} responseMetrics must be an object`);
  }
  const out = {};
  for (const field of ['source', 'provider', 'model']) {
    if (metrics[field] !== undefined) {
      if (typeof metrics[field] !== 'string' || metrics[field].trim() === '') {
        throw new Error(`advisor dry-run fixture ${source} responseMetrics.${field} must be a non-empty string`);
      }
      out[field] = metrics[field].trim();
    }
  }
  for (const field of ['latencyMs', 'promptTokens', 'completionTokens', 'totalTokens']) {
    if (metrics[field] !== undefined) {
      if (!Number.isFinite(metrics[field]) || metrics[field] < 0) {
        throw new Error(`advisor dry-run fixture ${source} responseMetrics.${field} must be a non-negative finite number`);
      }
      out[field] = Math.round(metrics[field]);
    }
  }
  if (out.totalTokens === undefined && out.promptTokens !== undefined && out.completionTokens !== undefined) {
    out.totalTokens = out.promptTokens + out.completionTokens;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`advisor dry-run fixture ${source} responseMetrics must include at least one metric field`);
  }
  return out;
}

function normalizeExpected(expected, source) {
  const out = { ...expected };
  for (const field of ['reasonIncludes', 'planSkills', 'planSkillsInclude', 'planSkillsAllowed', 'safetyReasonsInclude', 'staleReasonsInclude']) {
    if (out[field] !== undefined) out[field] = normalizeExpectedStringList(out[field], source, field);
  }
  for (const field of ['planLength', 'planLengthMin', 'planLengthMax', 'badIndex']) {
    if (out[field] !== undefined && (!Number.isInteger(out[field]) || out[field] < 0)) {
      throw new Error(`advisor dry-run fixture ${source} expected.${field} must be a non-negative integer`);
    }
  }
  return out;
}

function normalizeExpectedStringList(value, source, field) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    throw new Error(`advisor dry-run fixture ${source} expected.${field} must not be empty`);
  }
  return values.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`advisor dry-run fixture ${source} expected.${field} entries must be non-empty strings`);
    }
    return entry.trim();
  });
}

function normalizeCalibration(calibration, source) {
  if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) {
    throw new Error(`advisor dry-run fixture ${source} calibration must be an object`);
  }
  const out = {};
  if (calibration.firstCallCandidate !== undefined) {
    if (typeof calibration.firstCallCandidate !== 'boolean') {
      throw new Error(`advisor dry-run fixture ${source} calibration.firstCallCandidate must be a boolean`);
    }
    out.firstCallCandidate = calibration.firstCallCandidate;
  }
  if (calibration.f3Candidate !== undefined) {
    if (typeof calibration.f3Candidate !== 'boolean') {
      throw new Error(`advisor dry-run fixture ${source} calibration.f3Candidate must be a boolean`);
    }
    out.f3Candidate = calibration.f3Candidate;
  }
  for (const field of ['tier', 'purpose']) {
    if (calibration[field] !== undefined) {
      if (typeof calibration[field] !== 'string' || calibration[field].trim() === '') {
        throw new Error(`advisor dry-run fixture ${source} calibration.${field} must be a non-empty string`);
      }
      out[field] = calibration[field].trim();
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`advisor dry-run fixture ${source} calibration must include at least one field`);
  }
  return out;
}

function normalizeAdvisorFirstCallResponse(response, source) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`advisor first-call response ${source} entry must be an object`);
  }
  if (typeof response.id !== 'string' || response.id.trim() === '') {
    throw new Error(`advisor first-call response ${source} missing string field "id"`);
  }
  const hasRawResponse = response.rawResponse !== undefined;
  const hasResponse = response.response !== undefined;
  if (hasRawResponse === hasResponse) {
    throw new Error(`advisor first-call response ${source} must provide exactly one of rawResponse or response`);
  }
  if (hasRawResponse && typeof response.rawResponse !== 'string') {
    throw new Error(`advisor first-call response ${source} rawResponse must be a string; use response for structured JSON`);
  }
  return {
    id: response.id.trim(),
    ...(response.requestFingerprint !== undefined
      ? { requestFingerprint: normalizeRequestFingerprint(response.requestFingerprint, source) }
      : {}),
    rawResponse: hasRawResponse ? response.rawResponse : JSON.stringify(response.response),
    ...(response.responseMetrics !== undefined
      ? { responseMetrics: normalizeResponseMetrics(response.responseMetrics, source) }
      : {}),
    source,
  };
}

export function fingerprintAdvisorFirstCallRequest(request) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(request))
    .digest('hex');
}

function evaluateRequestFingerprint(actual, expected) {
  if (!expected) return { ok: true, status: 'not_expected', reason: null };
  if (!actual) return { ok: false, status: 'missing', reason: 'request fingerprint missing' };
  if (actual !== expected) return { ok: false, status: 'mismatch', reason: 'request fingerprint mismatch' };
  return { ok: true, status: 'matched', reason: null };
}

function normalizeRequestFingerprint(value, source) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value.trim())) {
    throw new Error(`advisor first-call response ${source} requestFingerprint must be a 64-character lowercase hex sha256`);
  }
  return value.trim();
}

function shortFingerprint(value) {
  return typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : (value || '');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function summarizeRecordedResponseMetrics(results) {
  const entries = results.map((result) => result.responseMetrics).filter(Boolean);
  const tokenEntries = entries.filter((entry) => Number.isFinite(entry.totalTokens));
  return {
    count: entries.length,
    latencyMs: numericStats(entries.map((entry) => entry.latencyMs).filter(Number.isFinite)),
    tokenUsage: {
      count: tokenEntries.length,
      promptTokens: sumNumbers(entries.map((entry) => entry.promptTokens)),
      completionTokens: sumNumbers(entries.map((entry) => entry.completionTokens)),
      totalTokens: sumNumbers(entries.map((entry) => entry.totalTokens)),
      maxTotalTokens: maxNumber(tokenEntries.map((entry) => entry.totalTokens)),
    },
    sources: countByValues(entries.map((entry) => entry.source || entry.model || entry.provider || 'unknown')),
  };
}

function evaluateResponseMetricsReadiness(metrics) {
  if (!metrics) {
    return { ready: false, reason: 'missing responseMetrics' };
  }
  if (!Number.isFinite(metrics.latencyMs) || metrics.latencyMs < 0) {
    return { ready: false, reason: 'missing latencyMs' };
  }
  if (!Number.isFinite(metrics.totalTokens) || metrics.totalTokens <= 0) {
    return { ready: false, reason: 'missing totalTokens' };
  }
  return { ready: true, reason: null };
}

function formatResponseMetricsIncomplete(report) {
  const entries = report.responseMetricsIncomplete || [];
  if (entries.length === 0) return 'none';
  return entries.map((entry) => `${entry.id} ${entry.reason}`).join('; ');
}

function numericStats(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (nums.length === 0) {
    return { count: 0, min: null, max: null, average: null, p95: null };
  }
  const p95Index = Math.min(nums.length - 1, Math.ceil(nums.length * 0.95) - 1);
  return {
    count: nums.length,
    min: nums[0],
    max: nums[nums.length - 1],
    average: round1(nums.reduce((sum, value) => sum + value, 0) / nums.length),
    p95: nums[p95Index],
  };
}

function sumNumbers(values) {
  return values
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
}

function countByValues(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

function formatRecordedResponseMetrics(metrics = {}) {
  const latency = metrics.latencyMs || {};
  const usage = metrics.tokenUsage || {};
  return [
    `count ${metrics.count || 0}`,
    `avg latency ${formatDuration(latency.average)}`,
    `p95 latency ${formatDuration(latency.p95)}`,
    `total tokens ${usage.count ? usage.totalTokens : 'unknown'}`,
  ].join(', ');
}

function formatResponseSources(sources = []) {
  if (!sources.length) return 'none';
  return sources
    .map((entry) => `${entry.source}${entry.status ? `(${entry.status})` : ''}:${entry.responseCount ?? entry.fixtureCount ?? 0}`)
    .join(', ');
}

function normalizeFirstCallRequestOptions(overrides = {}) {
  return {
    model: stringOrDefault(overrides.model, DEFAULT_ADVISOR_FIRST_CALL_REQUEST.model),
    temperature: Number.isFinite(overrides.temperature)
      ? overrides.temperature
      : DEFAULT_ADVISOR_FIRST_CALL_REQUEST.temperature,
    maxTokens: Number.isInteger(overrides.maxTokens) && overrides.maxTokens > 0
      ? overrides.maxTokens
      : DEFAULT_ADVISOR_FIRST_CALL_REQUEST.maxTokens,
    responseFormat: overrides.responseFormat === undefined
      ? { ...DEFAULT_ADVISOR_FIRST_CALL_REQUEST.responseFormat }
      : overrides.responseFormat,
  };
}

function buildAdvisorFirstCallChatRequest(messages, opts) {
  return {
    model: opts.model,
    messages,
    temperature: opts.temperature,
    response_format: opts.responseFormat,
    max_tokens: opts.maxTokens,
  };
}

function formatExpectedBrief(expected = {}) {
  const fields = [
    expected.stage ? `stage=${expected.stage}` : null,
    expected.activationStatus ? `activation=${expected.activationStatus}` : null,
    Array.isArray(expected.planSkills) ? `skills=${expected.planSkills.join('+')}` : null,
    Array.isArray(expected.planSkillsInclude) ? `requires=${expected.planSkillsInclude.join('+')}` : null,
    Array.isArray(expected.planSkillsAllowed) ? `allowed=${expected.planSkillsAllowed.join('+')}` : null,
  ].filter(Boolean);
  return fields.join('; ') || 'none';
}

function stringOrDefault(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizeStringList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((entry) => typeof entry === 'string' && entry.length > 0);
}

function missingIncludes(label, actualValues = [], expectedIncludes = []) {
  const values = Array.isArray(actualValues) ? actualValues.map((entry) => String(entry)) : [];
  const failures = [];
  for (const needle of expectedIncludes) {
    if (!values.some((value) => value.includes(needle))) {
      failures.push(`${label} missing "${needle}"`);
    }
  }
  return failures;
}

function arrayEqual(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

function formatMs(value) {
  return Number.isFinite(value) ? String(value) : 'n/a';
}

function formatDuration(value) {
  return Number.isFinite(value) ? `${value}ms` : 'n/a';
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function safeSnapshot(overrides = {}) {
  return {
    position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
    health: 20,
    food: 20,
    reactiveState: 'NORMAL',
    currentSkill: null,
    queueLength: 0,
    pathfinder: { owner: null, idle: true },
    hazardFlags: {
      inWater: false,
      oxygenLow: false,
      falling: false,
      usingHeldItem: false,
      autoEatEating: false,
    },
    nearbyHostiles: [],
    ...overrides,
  };
}

export default {
  DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR,
  DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR,
  DEFAULT_ADVISOR_F3_RESPONSE_DIR,
  DEFAULT_ADVISOR_DRY_RUN_THRESHOLDS,
  DEFAULT_ADVISOR_FIRST_CALL_REQUEST,
  ADVISOR_FIRST_CALL_REQUEST_FINGERPRINT_ALGORITHM,
  DEFAULT_ADVISOR_DRY_RUN_COVERAGE,
  DEFAULT_ADVISOR_FIRST_CALL_READINESS,
  DEFAULT_ADVISOR_F3_CALIBRATION_READINESS,
  DEFAULT_ADVISOR_DRY_RUN_FIXTURES,
  loadAdvisorDryRunFixtures,
  loadAdvisorDryRunFixtureCorpus,
  loadAdvisorDryRunFixtureFile,
  parseAdvisorDryRunFixtureDocument,
  runAdvisorDryRunCalibration,
  renderAdvisorDryRunCalibration,
  buildAdvisorFirstCallRequestPack,
  sanitizeAdvisorFirstCallRequestPackPublicReport,
  renderAdvisorFirstCallRequestPack,
  loadAdvisorFirstCallResponses,
  loadAdvisorFirstCallResponseFile,
  parseAdvisorFirstCallResponseDocument,
  evaluateAdvisorDryRunFixtureResponse,
  buildAdvisorFirstCallReplayReport,
  renderAdvisorFirstCallReplayReport,
  buildAdvisorFirstCallResponseTemplate,
  renderAdvisorFirstCallResponseTemplate,
  buildAdvisorCalibrationLadder,
  renderAdvisorCalibrationLadder,
  fingerprintAdvisorFirstCallRequest,
};
