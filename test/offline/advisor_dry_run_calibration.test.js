import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAdvisorDryRunFixtures,
  parseAdvisorDryRunFixtureDocument,
  renderAdvisorDryRunCalibration,
  runAdvisorDryRunCalibration,
} from '../../src/advisor/dry_run_calibration.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('advisor dry-run calibration summarizes mocked DeepSeek-style response outcomes', () => {
  const report = runAdvisorDryRunCalibration();

  assert.equal(report.ok, true);
  assert.equal(report.noApiCall, true);
  assert.equal(report.fixtureCount, 29);
  assert.deepEqual(report.thresholds, {
    maxPromptChars: 4000,
    maxEstimatedPromptTokens: 1200,
  });
  assert.equal(report.coverageRequirements.minFixtureCount, 29);
  assert.equal(report.coverageRequirements.requiredCategories.long_horizon_mission, 1);
  assert.equal(report.coverageRequirements.requiredCategories.no_cheat_boundary, 1);
  assert.equal(report.coverageRequirements.requiredCategories.fishing_skill, 1);
  assert.equal(report.coverageRequirements.requiredCategories.fishing_mission, 1);
  assert.equal(report.coverageRequirements.requiredCategories.mining_skill, 1);
  assert.equal(report.coverageRequirements.requiredCategories.mining_mission, 1);
  assert.equal(report.coverageRequirements.requiredCategories.recorded_snapshot, 9);
  assert.deepEqual(report.coverageRequirements.requiredCalibrationTiers, {
    smoke: 1,
    world_model: 1,
    survival: 1,
    safety_rejection: 1,
    combat_prep: 1,
    long_horizon_fixture: 1,
  });
  assert.equal(report.firstCallReadinessRequirements.minCandidates, 1);
  assert.deepEqual(report.firstCallReadinessRequirements.requiredCandidateIds, [
    'recorded_live_smoke_observe',
  ]);
  assert.deepEqual(report.firstCallReadinessRequirements.requiredCalibrationTiers, {
    smoke: 1,
  });
  assert.equal(report.summary.jsonValid, 28);
  assert.equal(report.summary.planValid, 24);
  assert.equal(report.summary.activationAccepted, 19);
  assert.equal(report.summary.activationRejected, 5);
  assert.equal(report.summary.invalidResponses, 5);
  assert.equal(report.summary.unexpectedOutcomes, 0);
  assert.equal(report.summary.expectationDetailFailures, 0);
  assert.equal(report.summary.promptBudgetViolations, 0);
  assert.equal(report.summary.coverageViolations, 0);
  assert.deepEqual(report.summary.coverageFailures, []);
  assert.deepEqual(report.summary.categoryCounts, {
    valid_plan: 1,
    invalid_response: 2,
    mission_plan: 1,
    safety_gate: 2,
    combat_gate: 2,
    staleness_gate: 2,
    build_dry_run: 1,
    long_horizon_mission: 1,
    combat_prep: 1,
    capability_gap: 1,
    recovery_policy: 1,
    no_cheat_boundary: 1,
    fishing_skill: 1,
    fishing_mission: 1,
    mining_skill: 1,
    mining_mission: 1,
    recorded_snapshot: 9,
  });
  assert.deepEqual(report.summary.activationStatusCounts, {
    accepted: 19,
    'not-run': 5,
    rejected: 5,
  });
  assert.deepEqual(report.summary.stageCounts, {
    activation: 24,
    json: 1,
    schema: 4,
  });
  assert.deepEqual(report.summary.calibrationTierCounts, {
    smoke: 1,
    world_model: 1,
    survival: 1,
    safety_rejection: 2,
    combat_escalation: 1,
    combat_prep: 1,
    long_horizon_fixture: 2,
  });
  assert.ok(report.summary.maxPromptChars > 0);
  assert.ok(report.summary.maxEstimatedPromptTokens > 0);
  assert.ok(report.summary.totalPromptChars > 0);
  assert.ok(report.summary.totalEstimatedPromptTokens > 0);
  assert.equal(report.summary.validationLatencyMs.count, 29);
  assert.equal(report.summary.validationLatencyMs.max, 0);
  assert.equal(report.results.every((result) => result.elapsedMs === 0), true);
  assert.equal(report.summary.recordedResponseMetrics.count, 9);
  assert.equal(report.summary.recordedResponseMetrics.latencyMs.count, 9);
  assert.equal(report.summary.recordedResponseMetrics.latencyMs.max, 0);
  assert.deepEqual(report.summary.recordedResponseMetrics.sources, {
    manual_expected_response: 9,
  });
  assert.equal(report.firstCallReadiness.ready, true);
  assert.equal(report.firstCallReadiness.status, 'ready_for_gated_deepseek_dry_run');
  assert.equal(report.firstCallReadiness.nextAction, 'run_explicitly_gated_deepseek_dry_run');
  assert.equal(report.firstCallReadiness.candidateCount, 1);
  assert.deepEqual(report.firstCallReadiness.candidateIds, [
    'recorded_live_smoke_observe',
  ]);
  assert.deepEqual(report.firstCallReadiness.stageCounts, { activation: 1 });
  assert.deepEqual(report.firstCallReadiness.activationStatusCounts, { accepted: 1 });
  assert.deepEqual(report.firstCallReadiness.calibrationTierCounts, {
    smoke: 1,
  });
  assert.deepEqual(report.firstCallReadiness.failures, []);
  assert.deepEqual(report.fixtureSources, [
    { source: 'builtin', fixtureCount: 20 },
    { source: 'data/advisor-dry-run/recorded-core.json', fixtureCount: 9 },
  ]);

  const byId = Object.fromEntries(report.results.map((result) => [result.id, result]));
  assert.equal(byId.safe_observe.category, 'valid_plan');
  assert.equal(byId.safe_observe.activationStatus, 'accepted');
  assert.equal(byId.safe_observe.expectationMet, true);
  assert.equal(byId.safe_observe.promptBudgetOk, true);
  assert.equal(byId.valid_collect_deposit.activationStatus, 'accepted');
  assert.equal(byId.valid_collect_deposit.planLength, 2);
  assert.deepEqual(byId.valid_collect_deposit.planSkills, ['collect', 'deposit']);
  assert.equal(byId.valid_build_dry_run.activationStatus, 'accepted');
  assert.equal(byId.return_on_time_goto_home.activationStatus, 'accepted');
  assert.equal(byId.valid_fish_until_current_spot.activationStatus, 'accepted');
  assert.equal(byId.valid_fish_and_deposit_current_spot.activationStatus, 'accepted');
  assert.equal(byId.valid_mine_until_visible_ores.activationStatus, 'accepted');
  assert.equal(byId.timed_mining_return_orchestration_gap.activationStatus, 'accepted');
  assert.equal(byId.recorded_live_smoke_observe.category, 'recorded_snapshot');
  assert.equal(byId.recorded_live_smoke_observe.activationStatus, 'accepted');
  assert.equal(byId.recorded_live_smoke_observe.calibration.firstCallCandidate, true);
  assert.equal(byId.recorded_live_smoke_observe.calibration.tier, 'smoke');
  assert.deepEqual(byId.recorded_live_smoke_observe.planSkills, ['observe']);
  assert.deepEqual(byId.recorded_live_smoke_observe.expected.planSkills, ['observe']);
  assert.deepEqual(byId.recorded_live_smoke_observe.responseMetrics, {
    source: 'manual_expected_response',
    latencyMs: 0,
  });
  assert.equal(byId.recorded_supply_chest_state_observe.activationStatus, 'accepted');
  assert.equal(byId.recorded_supply_chest_state_observe.calibration.tier, 'world_model');
  assert.equal(byId.recorded_single_hostile_flee.activationStatus, 'accepted');
  assert.equal(byId.recorded_single_hostile_flee.calibration.tier, 'survival');
  assert.deepEqual(byId.recorded_single_hostile_flee.planSkills, ['flee']);
  assert.deepEqual(byId.recorded_single_hostile_flee.expectationFailures, []);
  assert.deepEqual(byId.recorded_single_hostile_flee.safetyReasons, [
    'reactive state FLEEING',
    'pathfinder owned by reactive',
    'nearby hostile zombie at 2.11',
    'combat overview high/retreat: close-hostile-pressure',
  ]);
  assert.equal(byId.recorded_stacked_hostiles_reject_collect.activationStatus, 'accepted');
  assert.equal(byId.recorded_stacked_hostiles_reject_collect.calibration.tier, 'safety_rejection');
  assert.deepEqual(byId.recorded_stacked_hostiles_reject_collect.planSkills, ['observe']);
  assert.deepEqual(byId.recorded_stacked_hostiles_reject_collect.expected.planSkillsAllowed, ['flee', 'observe']);
  assert.deepEqual(byId.recorded_stacked_hostiles_reject_collect.expected.safetyReasonsInclude, [
    'reactive state FLEEING',
    'pathfinder owned by reactive',
    'nearby hostile zombie at 1.4',
    'combat overview critical/retreat: too-many-hostiles',
  ]);
  assert.deepEqual(byId.recorded_stacked_hostiles_reject_collect.expectationFailures, []);
  assert.equal(byId.recorded_stacked_hostiles_reject_collect.reason, 'accepted');
  assert.equal(byId.recorded_hostile_escalation_flee.activationStatus, 'accepted');
  assert.equal(byId.recorded_hostile_escalation_flee.calibration.tier, 'combat_escalation');
  assert.deepEqual(byId.recorded_hostile_escalation_flee.planSkills, ['flee', 'observe']);
  assert.deepEqual(byId.recorded_hostile_escalation_flee.expected.planSkillsInclude, ['flee']);
  assert.deepEqual(byId.recorded_hostile_escalation_flee.expected.planSkillsAllowed, ['flee', 'observe', 'consume']);
  assert.deepEqual(byId.recorded_hostile_escalation_flee.safetyReasons, [
    'reactive state FLEEING',
    'pathfinder owned by reactive',
    'nearby hostile zombie at 1.2',
    'combat overview critical/retreat: too-many-hostiles',
  ]);
  assert.deepEqual(byId.recorded_hostile_escalation_flee.expectationFailures, []);
  assert.equal(byId.recorded_pvm_strength_prep.activationStatus, 'accepted');
  assert.equal(byId.recorded_pvm_strength_prep.calibration.firstCallCandidate, undefined);
  assert.equal(byId.recorded_pvm_strength_prep.calibration.tier, 'combat_prep');
  assert.deepEqual(byId.recorded_pvm_strength_prep.planSkills, ['consume']);
  assert.deepEqual(byId.recorded_pvm_strength_prep.safetyReasons, [
    'nearby hostile zombie at 8.4',
    'combat overview high/combat: gear-advantage',
  ]);
  assert.deepEqual(byId.recorded_pvm_strength_prep.expectationFailures, []);
  assert.equal(byId.recorded_fishing_deposit_fixture.activationStatus, 'accepted');
  assert.equal(byId.recorded_fishing_deposit_fixture.calibration.firstCallCandidate, undefined);
  assert.equal(byId.recorded_fishing_deposit_fixture.calibration.tier, 'long_horizon_fixture');
  assert.deepEqual(byId.recorded_fishing_deposit_fixture.planSkills, ['fish_and_deposit']);
  assert.deepEqual(byId.recorded_fishing_deposit_fixture.expectationFailures, []);
  assert.equal(byId.recorded_fishing_post_deposit_resume_requip.activationStatus, 'accepted');
  assert.equal(byId.recorded_fishing_post_deposit_resume_requip.calibration.tier, 'long_horizon_fixture');
  assert.deepEqual(byId.recorded_fishing_post_deposit_resume_requip.planSkills, ['fish_and_deposit']);
  assert.deepEqual(byId.recorded_fishing_post_deposit_resume_requip.expectationFailures, []);
  assert.equal(byId.recorded_fishing_oxygen_low_reject_mission.activationStatus, 'rejected');
  assert.equal(byId.recorded_fishing_oxygen_low_reject_mission.calibration.tier, 'safety_rejection');
  assert.deepEqual(byId.recorded_fishing_oxygen_low_reject_mission.planSkills, ['fish_and_deposit']);
  assert.deepEqual(byId.recorded_fishing_oxygen_low_reject_mission.safetyReasons, ['oxygen low']);
  assert.deepEqual(byId.recorded_fishing_oxygen_low_reject_mission.expectationFailures, []);
  assert.match(byId.recorded_fishing_oxygen_low_reject_mission.reason, /rejected fish_and_deposit: oxygen low/);
  assert.equal(byId.malformed_json.stage, 'json');
  assert.equal(byId.runtime_only_skill.stage, 'schema');
  assert.equal(byId.unsafe_normal_work.activationStatus, 'rejected');
  assert.match(byId.unsafe_normal_work.reason, /unsafe snapshot permits only/);
  assert.equal(byId.unsafe_survival_consume.activationStatus, 'accepted');
  assert.deepEqual(byId.unsafe_survival_consume.safetyReasons, ['low health 6']);
  assert.equal(byId.critical_combat_blocks_normal_work.activationStatus, 'rejected');
  assert.match(byId.critical_combat_blocks_normal_work.reason, /combat overview critical\/retreat/);
  assert.equal(byId.critical_combat_allows_flee.activationStatus, 'accepted');
  assert.equal(byId.combat_strength_prep_allowed.activationStatus, 'accepted');
  assert.equal(byId.stale_position_drift.activationStatus, 'rejected');
  assert.deepEqual(byId.stale_position_drift.staleReasons, ['position drift 5 > 2']);
  assert.equal(byId.stale_combat_target.activationStatus, 'rejected');
  assert.match(byId.stale_combat_target.staleReasons[0], /target:creeper/);
  assert.equal(byId.cave_mining_exploration_orchestration_gap.stage, 'schema');
  assert.match(byId.cave_mining_exploration_orchestration_gap.reason, /unknown skill "explore_mine_and_return"/);
  assert.equal(byId.death_recovery_runtime_only.stage, 'schema');
  assert.match(byId.death_recovery_runtime_only.reason, /recover_drops: not advisor-callable/);
  assert.equal(byId.no_cheat_boundary_rejects_aimbot.stage, 'schema');
  assert.match(byId.no_cheat_boundary_rejects_aimbot.reason, /unknown skill "aimbot_attack"/);
});

test('advisor dry-run calibration renderer records metrics without raw API use', () => {
  const text = renderAdvisorDryRunCalibration(runAdvisorDryRunCalibration());

  assert.match(text, /# Advisor Dry-Run Calibration/);
  assert.match(text, /no API call made: yes/);
  assert.match(text, /fixtures: 29/);
  assert.match(text, /JSON-valid responses: 28\/29/);
  assert.match(text, /activation-accepted plans: 19\/29/);
  assert.match(text, /activation-rejected plans: 5\/29/);
  assert.match(text, /unexpected outcomes: 0\/29/);
  assert.match(text, /expectation detail failures: 0/);
  assert.match(text, /prompt budget violations: 0\/29/);
  assert.match(text, /coverage violations: 0/);
  assert.match(text, /first-call readiness: ready/);
  assert.match(text, /first-call candidates: 1/);
  assert.match(text, /first-call candidate ids: recorded_live_smoke_observe/);
  assert.match(text, /first-call calibration tiers: smoke:1/);
  assert.match(text, /first-call readiness failures: 0/);
  assert.match(text, /prompt budget: <=4000 chars and <=1200 estimated tokens/);
  assert.match(text, /validation latency: avg 0ms, p95 0ms, max 0ms/);
  assert.match(text, /recorded response metrics: count 9, avg latency 0ms, p95 latency 0ms, total tokens unknown/);
  assert.match(text, /fixture sources: builtin:20, data\/advisor-dry-run\/recorded-core\.json:9/);
  assert.match(text, /required categories: .*long_horizon_mission>=1/);
  assert.match(text, /required calibration tiers: smoke>=1, world_model>=1, survival>=1, safety_rejection>=1, combat_prep>=1, long_horizon_fixture>=1/);
  assert.match(text, /calibration tier counts: smoke:1, world_model:1, survival:1, safety_rejection:2, combat_escalation:1, combat_prep:1, long_horizon_fixture:2/);
  assert.match(text, /valid_collect_deposit/);
  assert.match(text, /critical_combat_blocks_normal_work/);
  assert.match(text, /valid_fish_until_current_spot/);
  assert.match(text, /valid_fish_and_deposit_current_spot/);
  assert.match(text, /valid_mine_until_visible_ores/);
  assert.match(text, /timed_mining_return_orchestration_gap/);
  assert.match(text, /cave_mining_exploration_orchestration_gap/);
  assert.match(text, /recorded_live_smoke_observe/);
  assert.match(text, /recorded_supply_chest_state_observe/);
  assert.match(text, /recorded_single_hostile_flee/);
  assert.match(text, /recorded_stacked_hostiles_reject_collect/);
  assert.match(text, /recorded_hostile_escalation_flee/);
  assert.match(text, /recorded_pvm_strength_prep/);
  assert.match(text, /recorded_fishing_deposit_fixture/);
  assert.match(text, /recorded_fishing_post_deposit_resume_requip/);
  assert.match(text, /recorded_fishing_oxygen_low_reject_mission/);
  assert.match(text, /no_cheat_boundary_rejects_aimbot/);
  assert.match(text, /stale_position_drift/);
});

test('advisor dry-run loader reads recorded fixture corpus documents', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-advisor-dry-run-'));
  const fixturePath = path.join(tmpDir, 'recorded.json');
  fs.writeFileSync(fixturePath, JSON.stringify({
    schemaVersion: 1,
    fixtures: [{
      id: 'recorded_low_health_consume',
      category: 'recorded_snapshot',
      goal: 'recover health from a recorded low-health state',
      snapshot: {
        position: { x: 12, y: 64, z: 9, dimension: 'overworld' },
        health: 5,
        food: 19,
        reactiveState: 'NORMAL',
        currentSkill: null,
        queueLength: 0,
        pathfinder: { owner: null, idle: true },
        hazardFlags: {},
        nearbyHostiles: [],
      },
      calibration: {
        firstCallCandidate: true,
        tier: 'survival',
        purpose: 'prove focused low-health consume candidate handling',
      },
      response: { plan: [{ skill: 'consume', params: { item: 'golden_apple' } }] },
      responseMetrics: {
        source: 'manual_expected_response',
        latencyMs: 5,
        promptTokens: 20,
        completionTokens: 7,
      },
      expected: {
        stage: 'activation',
        activationStatus: 'accepted',
        planSkills: ['consume'],
        planLength: 1,
        safetyReasonsInclude: ['low health 5'],
      },
    }],
  }, null, 2));

  const loaded = loadAdvisorDryRunFixtures({ fixtureDir: tmpDir, includeBuiltins: false });
  const report = runAdvisorDryRunCalibration(loaded.fixtures, {
    fixtureSources: loaded.sources,
    coverageRequirements: {
      replaceDefaults: true,
      minFixtureCount: 1,
      requiredCategories: { recorded_snapshot: 1 },
      requiredStages: { activation: 1 },
      requiredActivationStatuses: { accepted: 1 },
      requiredCalibrationTiers: { survival: 1 },
    },
    firstCallReadinessRequirements: {
      replaceDefaults: true,
      minCandidates: 1,
      requiredCandidateIds: ['recorded_low_health_consume'],
      requiredStages: { activation: 1 },
      requiredActivationStatuses: { accepted: 1 },
    },
  });

  assert.equal(loaded.fixtures.length, 1);
  assert.match(loaded.fixtures[0].source, /recorded\.json#1$/);
  assert.equal(loaded.fixtures[0].calibration.firstCallCandidate, true);
  assert.equal(report.ok, true);
  assert.equal(report.fixtureSources.length, 1);
  assert.equal(report.results[0].source, loaded.fixtures[0].source);
  assert.equal(report.results[0].activationStatus, 'accepted');
  assert.equal(report.firstCallReadiness.ready, true);
  assert.deepEqual(report.firstCallReadiness.candidateIds, ['recorded_low_health_consume']);
  assert.deepEqual(report.results[0].planSkills, ['consume']);
  assert.deepEqual(report.results[0].expectationFailures, []);
  assert.deepEqual(report.results[0].safetyReasons, ['low health 5']);
  assert.deepEqual(report.results[0].responseMetrics, {
    source: 'manual_expected_response',
    latencyMs: 5,
    promptTokens: 20,
    completionTokens: 7,
    totalTokens: 27,
  });
  assert.deepEqual(report.summary.calibrationTierCounts, { survival: 1 });
  assert.equal(report.summary.recordedResponseMetrics.tokenUsage.totalTokens, 27);
});

test('advisor dry-run loader rejects malformed recorded fixture documents', () => {
  assert.throws(
    () => parseAdvisorDryRunFixtureDocument({ schemaVersion: 99, fixtures: [] }, 'bad-version.json'),
    /unsupported schemaVersion 99/,
  );
  assert.throws(
    () => parseAdvisorDryRunFixtureDocument({
      schemaVersion: 1,
      fixtures: [{
        id: 'bad',
        category: 'recorded_snapshot',
        goal: 'inspect',
        snapshot: {},
        expected: { stage: 'activation' },
        response: { plan: [] },
        rawResponse: '{"plan":[]}',
      }],
    }, 'bad-response.json'),
    /exactly one of rawResponse or response/,
  );
  assert.throws(
    () => parseAdvisorDryRunFixtureDocument({
      schemaVersion: 1,
      fixtures: [{
        id: 'bad_metrics',
        category: 'recorded_snapshot',
        goal: 'inspect',
        snapshot: {},
        expected: { stage: 'activation' },
        response: { plan: [] },
        responseMetrics: { latencyMs: -1 },
      }],
    }, 'bad-metrics.json'),
    /responseMetrics\.latencyMs must be a non-negative finite number/,
  );
  assert.throws(
    () => parseAdvisorDryRunFixtureDocument({
      schemaVersion: 1,
      fixtures: [{
        id: 'bad_expected',
        category: 'recorded_snapshot',
        goal: 'inspect',
        snapshot: {},
        expected: { stage: 'activation', planSkills: ['observe', ''] },
        response: { plan: [{ skill: 'observe', params: {} }] },
      }],
    }, 'bad-expected.json'),
    /expected\.planSkills entries must be non-empty strings/,
  );
  assert.throws(
    () => parseAdvisorDryRunFixtureDocument({
      schemaVersion: 1,
      fixtures: [{
        id: 'bad_calibration',
        category: 'recorded_snapshot',
        goal: 'inspect',
        snapshot: {},
        calibration: { firstCallCandidate: 'yes' },
        expected: { stage: 'activation' },
        response: { plan: [{ skill: 'observe', params: {} }] },
      }],
    }, 'bad-calibration.json'),
    /calibration\.firstCallCandidate must be a boolean/,
  );
});

test('advisor dry-run calibration fails the benchmark on unexpected outcomes or prompt budget violations', () => {
  const unexpected = runAdvisorDryRunCalibration([
    {
      id: 'unexpected_safe_observe',
      goal: 'inspect',
      snapshot: {
        position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
        health: 20,
        food: 20,
        reactiveState: 'NORMAL',
        currentSkill: null,
        queueLength: 0,
        pathfinder: { owner: null, idle: true },
        hazardFlags: {},
        nearbyHostiles: [],
      },
      rawResponse: JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
      expected: { stage: 'json', activationStatus: 'not-run', planSkills: ['flee'] },
    },
  ]);

  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.summary.unexpectedOutcomes, 1);
  assert.ok(unexpected.summary.expectationDetailFailures >= 1);
  assert.ok(unexpected.summary.coverageViolations > 0);
  assert.equal(unexpected.results[0].expectationMet, false);
  assert.match(unexpected.results[0].expectationFailures.join('; '), /planSkills/);

  const overBudget = runAdvisorDryRunCalibration(undefined, {
    thresholds: { maxPromptChars: 10, maxEstimatedPromptTokens: 3 },
  });

  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.summary.promptBudgetViolations, 29);
  assert.equal(overBudget.results.every((result) => result.promptBudgetOk === false), true);
});

test('advisor dry-run calibration fails the benchmark when required suite coverage is missing', () => {
  const report = runAdvisorDryRunCalibration([
    {
      id: 'only_observe',
      category: 'valid_plan',
      goal: 'inspect',
      snapshot: {
        position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
        health: 20,
        food: 20,
        reactiveState: 'NORMAL',
        currentSkill: null,
        queueLength: 0,
        pathfinder: { owner: null, idle: true },
        hazardFlags: {},
        nearbyHostiles: [],
      },
      rawResponse: JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
      expected: { stage: 'activation', activationStatus: 'accepted' },
    },
  ]);

  assert.equal(report.ok, false);
  assert.equal(report.summary.unexpectedOutcomes, 0);
  assert.ok(report.summary.coverageViolations > 0);
  assert.match(report.summary.coverageFailures.join('; '), /fixtureCount 1 < 29/);
  assert.match(report.summary.coverageFailures.join('; '), /category.long_horizon_mission 0 < 1/);
  assert.match(report.summary.coverageFailures.join('; '), /calibrationTier.smoke 0 < 1/);
});

test('advisor dry-run calibration can relax coverage requirements for focused fixtures', () => {
  const report = runAdvisorDryRunCalibration([
    {
      id: 'focused_observe',
      category: 'valid_plan',
      goal: 'inspect',
      snapshot: {
        position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
        health: 20,
        food: 20,
        reactiveState: 'NORMAL',
        currentSkill: null,
        queueLength: 0,
        pathfinder: { owner: null, idle: true },
        hazardFlags: {},
        nearbyHostiles: [],
      },
      rawResponse: JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
      expected: { stage: 'activation', activationStatus: 'accepted' },
    },
  ], {
    coverageRequirements: {
      replaceDefaults: true,
      minFixtureCount: 1,
      requiredCategories: { valid_plan: 1 },
      requiredStages: { activation: 1 },
      requiredActivationStatuses: { accepted: 1 },
    },
    firstCallReadinessRequirements: {
      replaceDefaults: true,
      minCandidates: 0,
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.coverageViolations, 0);
});

test('advisor dry-run first-call readiness requires tagged candidate coverage', () => {
  const report = runAdvisorDryRunCalibration([
    {
      id: 'candidate_observe',
      category: 'recorded_snapshot',
      goal: 'inspect',
      snapshot: {
        position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
        health: 20,
        food: 20,
        reactiveState: 'NORMAL',
        currentSkill: null,
        queueLength: 0,
        pathfinder: { owner: null, idle: true },
        hazardFlags: {},
        nearbyHostiles: [],
      },
      calibration: { firstCallCandidate: true, tier: 'smoke' },
      rawResponse: JSON.stringify({ plan: [{ skill: 'observe', params: {} }] }),
      expected: { stage: 'activation', activationStatus: 'accepted' },
    },
  ], {
    coverageRequirements: {
      replaceDefaults: true,
      minFixtureCount: 1,
      requiredCategories: { recorded_snapshot: 1 },
      requiredStages: { activation: 1 },
      requiredActivationStatuses: { accepted: 1 },
    },
    firstCallReadinessRequirements: {
      replaceDefaults: true,
      minCandidates: 2,
      requiredCandidateIds: ['candidate_observe', 'missing_candidate'],
      requiredStages: { activation: 2 },
      requiredActivationStatuses: { accepted: 2 },
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.summary.coverageViolations, 0);
  assert.equal(report.firstCallReadiness.ready, false);
  assert.equal(report.firstCallReadiness.status, 'blocked');
  assert.match(report.firstCallReadiness.failures.join('; '), /firstCallCandidates 1 < 2/);
  assert.match(report.firstCallReadiness.failures.join('; '), /missing first-call candidate missing_candidate/);
  assert.match(report.firstCallReadiness.failures.join('; '), /firstCall\.stage\.activation 1 < 2/);
});

test('advisor dry-run CLI writes reports and exits without DeepSeek env vars', () => {
  const env = { ...process.env };
  delete env.MCBOT_ALLOW_DEEPSEEK;
  delete env.DEEPSEEK_API_KEY;

  const result = spawnSync(process.execPath, ['scripts/advisor-dry-run.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /advisor-dry-run: wrote reports\\advisor-dry-run\.json and reports\\advisor-dry-run\.md|advisor-dry-run: wrote reports\/advisor-dry-run\.json and reports\/advisor-dry-run\.md/);
  assert.equal(result.stderr, '');

  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'advisor-dry-run.json'), 'utf8'));
  const markdown = fs.readFileSync(path.join(ROOT, 'reports', 'advisor-dry-run.md'), 'utf8');
  assert.equal(json.noApiCall, true);
  assert.equal(json.ok, true);
  assert.equal(json.fixtureCount, 29);
  assert.equal(json.summary.activationAccepted, 19);
  assert.equal(json.summary.expectationDetailFailures, 0);
  assert.equal(json.summary.recordedResponseMetrics.count, 9);
  assert.equal(json.summary.recordedResponseMetrics.latencyMs.max, 0);
  assert.equal(json.summary.calibrationTierCounts.combat_escalation, 1);
  assert.equal(json.summary.calibrationTierCounts.combat_prep, 1);
  assert.equal(json.summary.calibrationTierCounts.long_horizon_fixture, 2);
  assert.equal(json.firstCallReadiness.ready, true);
  assert.equal(json.firstCallReadiness.candidateCount, 1);
  assert.deepEqual(json.firstCallReadiness.failures, []);
  assert.ok(json.summary.categoryCounts.recorded_snapshot >= 9);
  assert.ok(json.fixtureSources.some((entry) => entry.source === 'data/advisor-dry-run/recorded-core.json' && entry.fixtureCount === 9));
  assert.equal(json.summary.unexpectedOutcomes, 0);
  assert.equal(json.summary.coverageViolations, 0);
  assert.match(markdown, /fixture sources: builtin:20, data\/advisor-dry-run\/recorded-core\.json:9/);
  assert.match(markdown, /required calibration tiers: smoke>=1, world_model>=1, survival>=1, safety_rejection>=1, combat_prep>=1, long_horizon_fixture>=1/);
  assert.match(markdown, /first-call readiness: ready/);
  assert.match(markdown, /recorded response metrics: count 9, avg latency 0ms/);
  assert.match(markdown, /Advisor Dry-Run Calibration/);
});
