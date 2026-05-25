import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ADVISOR_F3_CALIBRATION_READINESS,
  buildAdvisorFirstCallReplayReport,
  buildAdvisorFirstCallRequestPack,
  loadAdvisorDryRunFixtures,
  renderAdvisorFirstCallReplayReport,
} from '../../src/advisor/dry_run_calibration.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRST_CALL_IDS = Object.freeze([
  'recorded_live_smoke_observe',
]);
const F3_IDS = Object.freeze([
  'recorded_live_smoke_observe',
  'recorded_supply_chest_state_observe',
  'recorded_single_hostile_flee',
  'recorded_stacked_hostiles_reject_collect',
  'recorded_hostile_escalation_flee',
  'recorded_pvm_strength_prep',
  'recorded_fishing_deposit_fixture',
]);

test('advisor F3 request pack expands to the post-gate multi-tier calibration candidates', () => {
  const pack = buildAdvisorFirstCallRequestPack(undefined, {
    firstCallReadinessRequirements: DEFAULT_ADVISOR_F3_CALIBRATION_READINESS,
  });

  assert.equal(pack.ok, true);
  assert.equal(pack.firstCallReadiness.candidateFlag, 'f3Candidate');
  assert.equal(pack.requestCount, F3_IDS.length);
  assert.deepEqual(pack.requestIds, F3_IDS);
  assert.equal(pack.firstCallReadiness.calibrationTierCounts.smoke, 1);
  assert.equal(pack.firstCallReadiness.calibrationTierCounts.world_model, 1);
  assert.equal(pack.firstCallReadiness.calibrationTierCounts.survival, 1);
  assert.equal(pack.firstCallReadiness.calibrationTierCounts.safety_rejection, 1);
  assert.equal(pack.firstCallReadiness.calibrationTierCounts.combat_escalation, 1);
  assert.equal(pack.firstCallReadiness.calibrationTierCounts.combat_prep, 1);
  assert.equal(pack.firstCallReadiness.calibrationTierCounts.long_horizon_fixture, 1);
});

test('advisor first-call replay reports pending without model responses by default', () => {
  const report = buildAdvisorFirstCallReplayReport(undefined, {
    responseDir: 'data/does-not-exist-advisor-first-call-responses',
  });
  const text = renderAdvisorFirstCallReplayReport(report);

  assert.equal(report.ok, true);
  assert.equal(report.noApiCall, true);
  assert.equal(report.status, 'pending_model_responses');
  assert.equal(report.expectedCount, FIRST_CALL_IDS.length);
  assert.equal(report.presentCount, 0);
  assert.equal(report.missingCount, FIRST_CALL_IDS.length);
  assert.equal(report.failures.length, 0);
  assert.deepEqual(report.results.map((entry) => entry.id), FIRST_CALL_IDS);
  assert.deepEqual(report.results.map((entry) => entry.responseStatus), FIRST_CALL_IDS.map(() => 'missing'));
  assert.match(text, /# Advisor First-Call Replay/);
  assert.match(text, /status: pending_model_responses/);
  assert.match(text, /missing responses: 1/);
});

test('advisor first-call replay validates complete saved responses without API calls', () => {
  const responses = firstCallResponsesFromDryRunFixtures();
  const report = buildAdvisorFirstCallReplayReport(undefined, {
    responses,
    requireCompleteResponses: true,
    requireResponseMetrics: true,
  });

  assert.equal(report.ok, true);
  assert.equal(report.noApiCall, true);
  assert.equal(report.status, 'validated_model_responses');
  assert.equal(report.requireResponseMetrics, true);
  assert.equal(report.expectedCount, FIRST_CALL_IDS.length);
  assert.equal(report.presentCount, FIRST_CALL_IDS.length);
  assert.equal(report.missingCount, 0);
  assert.equal(report.responseMetricsReadyCount, FIRST_CALL_IDS.length);
  assert.equal(report.responseMetricsIncompleteCount, 0);
  assert.equal(report.requestFingerprintReadyCount, FIRST_CALL_IDS.length);
  assert.equal(report.requestFingerprintMissingCount, 0);
  assert.equal(report.requestFingerprintMismatchCount, 0);
  assert.equal(report.unexpectedOutcomes, 0);
  assert.equal(report.summary.activationStatusCounts.accepted, 1);
  assert.equal(report.summary.activationStatusCounts.rejected, undefined);
  assert.equal(report.summary.responseMetrics.count, FIRST_CALL_IDS.length);
  assert.deepEqual(report.results.map((entry) => entry.planSkills), [
    ['observe'],
  ]);
  assert.doesNotMatch(JSON.stringify(report), /rawResponse|DEEPSEEK_API_KEY|sk-test-secret/);
});

test('advisor first-call replay can require latency and token metrics for promotion', () => {
  const report = buildAdvisorFirstCallReplayReport(undefined, {
    responses: firstCallResponsesFromDryRunFixtures({ includeMetrics: false }),
    requireCompleteResponses: true,
    requireResponseMetrics: true,
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'blocked');
  assert.equal(report.presentCount, FIRST_CALL_IDS.length);
  assert.equal(report.missingCount, 0);
  assert.equal(report.unexpectedOutcomes, 0);
  assert.equal(report.responseMetricsReadyCount, 0);
  assert.equal(report.responseMetricsIncompleteCount, FIRST_CALL_IDS.length);
  assert.ok(report.responseMetricsIncomplete.every((entry) => entry.reason === 'missing responseMetrics'));
  assert.ok(report.failures.some((failure) => (
    failure.includes('recorded_live_smoke_observe response metrics incomplete: missing responseMetrics')
  )));
});

test('advisor first-call replay fails closed for missing or mismatched request fingerprints', () => {
  const missing = buildAdvisorFirstCallReplayReport(undefined, {
    responses: firstCallResponsesFromDryRunFixtures({ includeFingerprints: false }),
    requireCompleteResponses: true,
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.requestFingerprintReadyCount, 0);
  assert.equal(missing.requestFingerprintMissingCount, FIRST_CALL_IDS.length);
  assert.equal(missing.requestFingerprintMismatchCount, 0);
  assert.ok(missing.failures.some((failure) => failure.includes('recorded_live_smoke_observe request fingerprint missing')));

  const mismatchedResponses = firstCallResponsesFromDryRunFixtures();
  mismatchedResponses[0].requestFingerprint = '0'.repeat(64);
  const mismatched = buildAdvisorFirstCallReplayReport(undefined, {
    responses: mismatchedResponses,
    requireCompleteResponses: true,
  });

  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.requestFingerprintReadyCount, FIRST_CALL_IDS.length - 1);
  assert.equal(mismatched.requestFingerprintMissingCount, 0);
  assert.equal(mismatched.requestFingerprintMismatchCount, 1);
  assert.ok(mismatched.failures.some((failure) => failure.includes('recorded_live_smoke_observe request fingerprint mismatch')));
});

test('advisor first-call replay fails closed for bad, unknown, duplicate, or missing required responses', () => {
  const report = buildAdvisorFirstCallReplayReport(undefined, {
    responses: [
      { id: 'recorded_live_smoke_observe', rawResponse: 'not json' },
      { id: 'recorded_live_smoke_observe', response: { plan: [{ skill: 'observe', params: {} }] } },
      { id: 'unknown_candidate', response: { plan: [{ skill: 'observe', params: {} }] } },
    ],
    requireCompleteResponses: true,
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'blocked');
  assert.equal(report.presentCount, 1);
  assert.equal(report.missingCount, FIRST_CALL_IDS.length - 1);
  assert.equal(report.unknownCount, 1);
  assert.equal(report.duplicateCount, 1);
  assert.equal(report.unexpectedOutcomes, 1);
  assert.deepEqual(report.unknownIds, ['unknown_candidate']);
  assert.deepEqual(report.duplicateIds, ['recorded_live_smoke_observe']);
  assert.ok(report.failures.some((failure) => failure.includes('unknown response id unknown_candidate')));
  assert.ok(report.failures.some((failure) => failure.includes('duplicate response id recorded_live_smoke_observe')));
  assert.ok(report.failures.some((failure) => failure.includes('recorded_live_smoke_observe expectation failed')));
});

test('advisor first-call replay CLI writes no-secret reports without DeepSeek opt-in or API key', () => {
  const responseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-first-call-replay-'));
  const responseDoc = {
    schemaVersion: 1,
    responses: firstCallResponsesFromDryRunFixtures(),
  };
  fs.writeFileSync(path.join(responseDir, 'responses.json'), JSON.stringify(responseDoc, null, 2));

  const env = {
    ...process.env,
    MCBOT_ADVISOR_FIRST_CALL_RESPONSE_DIR: responseDir,
    MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES: '1',
    DEEPSEEK_API_KEY: 'sk-test-secret-value',
  };
  delete env.MCBOT_ALLOW_DEEPSEEK;

  const result = spawnSync(process.execPath, ['scripts/advisor-first-call-replay.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /advisor-first-call-replay: wrote/);

  const jsonPath = path.join(ROOT, 'reports', 'advisor-first-call-replay.json');
  const mdPath = path.join(ROOT, 'reports', 'advisor-first-call-replay.md');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const markdown = fs.readFileSync(mdPath, 'utf8');
  const serialized = JSON.stringify(json) + '\n' + markdown;

  assert.equal(json.noApiCall, true);
  assert.equal(json.ok, true);
  assert.equal(json.status, 'validated_model_responses');
  assert.equal(json.presentCount, FIRST_CALL_IDS.length);
  assert.match(markdown, /Advisor First-Call Replay/);
  assert.match(markdown, /validated_model_responses/);
  assert.doesNotMatch(serialized, /sk-test-secret-value/);
  assert.doesNotMatch(serialized, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(serialized, /rawResponse/);
});

function firstCallResponsesFromDryRunFixtures(opts = {}) {
  const { fixtures } = loadAdvisorDryRunFixtures();
  const requestPack = buildAdvisorFirstCallRequestPack(fixtures);
  const requestById = new Map(requestPack.requests.map((request) => [request.id, request]));
  return FIRST_CALL_IDS.map((id, index) => {
    const fixture = fixtures.find((entry) => entry.id === id);
    assert.ok(fixture, `missing fixture ${id}`);
    const request = requestById.get(id);
    assert.ok(request, `missing request ${id}`);
    const response = {
      id,
      rawResponse: fixture.rawResponse,
    };
    if (opts.includeFingerprints !== false) {
      response.requestFingerprint = request.requestFingerprint;
    }
    if (opts.includeMetrics !== false) {
      response.responseMetrics = {
        source: 'recorded-test',
        latencyMs: 100 + index,
        promptTokens: fixture.responseMetrics?.promptTokens ?? 100,
        completionTokens: fixture.responseMetrics?.completionTokens ?? 20,
      };
    }
    return response;
  });
}
