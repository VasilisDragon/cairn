import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  CAPABILITY_STATUSES,
  CAPABILITY_STATUS_ORDER,
  buildCapabilityMatrix,
  renderCapabilityMatrix,
} from '../../src/goal/capability_matrix.js';

function byId(report) {
  return Object.fromEntries(report.capabilities.map((capability) => [capability.id, capability]));
}

function reportTextFor(capabilities) {
  return Object.values(capabilities).map((capability) => [
    capability.id,
    capability.claim,
    capability.nextCommand,
    ...(capability.limitations || []),
  ].join('\n')).join('\n');
}

test('capability matrix uses explicit evidence labels after F1/F2 live gates', () => {
  const report = buildCapabilityMatrix({ generatedAt: '2026-05-23T00:00:00.000Z' });
  const capabilities = byId(report);

  assert.equal(report.noApiCall, false);
  assert.deepEqual(report.statusVocabulary, CAPABILITY_STATUS_ORDER);
  assert.equal(report.summary.total, report.capabilities.length);
  assert.equal(
    Object.values(report.summary.byStatus).reduce((sum, count) => sum + count, 0),
    report.capabilities.length,
  );
  assert.ok(report.summary.byStatus[CAPABILITY_STATUSES.LIVE_PROVEN] >= 1);
  assert.ok(report.summary.byStatus[CAPABILITY_STATUSES.OFFLINE_COVERED] >= 1);
  assert.ok(report.summary.byStatus[CAPABILITY_STATUSES.SCAFFOLDED] >= 1);
  assert.ok(report.summary.byStatus[CAPABILITY_STATUSES.PENDING] >= 1);

  assert.equal(capabilities.live_fixture_suite_a_i.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.account_regime_control.status, CAPABILITY_STATUSES.OFFLINE_COVERED);
  assert.equal(capabilities.operator_logout_control.status, CAPABILITY_STATUSES.OFFLINE_COVERED);
  assert.match(capabilities.operator_logout_control.claim, /local process signals/);
  assert.doesNotMatch(capabilities.operator_logout_control.claim, /authorized !logout/);
  assert.equal(capabilities.deepseek_first_call_contract.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.advisor_cost_ceiling.status, CAPABILITY_STATUSES.OFFLINE_COVERED);
  assert.equal(capabilities.advisor_live_plan_reporter.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.advisor_live_calibration_ladder.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.hostile_escalation_jk.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.long_horizon_mission_primitives.status, CAPABILITY_STATUSES.OFFLINE_COVERED);
  assert.equal(capabilities.c3_detection_rate_benchmark.status, CAPABILITY_STATUSES.SCAFFOLDED);
  assert.equal(capabilities.repeatable_benchmark_ladder.status, CAPABILITY_STATUSES.OFFLINE_COVERED);
  assert.equal(capabilities.c4_carpet_pvp_heuristic_extraction.status, CAPABILITY_STATUSES.SCAFFOLDED);
  assert.equal(capabilities.advanced_authorized_pvp.status, CAPABILITY_STATUSES.PENDING);
  assert.equal(capabilities.viewer_operator_handoff.status, CAPABILITY_STATUSES.PENDING);

  assert.ok(report.capabilities.every((capability) => (
    CAPABILITY_STATUS_ORDER.includes(capability.status)
      && Array.isArray(capability.offlineEvidence)
      && Array.isArray(capability.liveEvidence)
      && Array.isArray(capability.limitations)
      && typeof capability.nextCommand === 'string'
  )));
});

test('capability matrix does not overclaim pending SOTA tracks as live-proven', () => {
  const capabilities = byId(buildCapabilityMatrix());

  for (const id of [
    'c3_detection_rate_benchmark',
    'c4_carpet_pvp_heuristic_extraction',
    'advanced_authorized_pvp',
    'viewer_operator_handoff',
  ]) {
    assert.notEqual(capabilities[id].status, CAPABILITY_STATUSES.LIVE_PROVEN);
  }

  assert.equal(capabilities.hostile_escalation_jk.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.deepseek_first_call_contract.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.advisor_live_plan_reporter.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.advisor_live_calibration_ladder.status, CAPABILITY_STATUSES.LIVE_PROVEN);
  assert.equal(capabilities.long_horizon_mission_primitives.status, CAPABILITY_STATUSES.OFFLINE_COVERED);
  assert.match(capabilities.advisor_live_calibration_ladder.limitations.join('\n'), /stale-plan rejection case is now live-proven/);
  assert.match(capabilities.advisor_live_calibration_ladder.limitations.join('\n'), /unsafe normal-work case is now live-proven/);
  assert.match(capabilities.advisor_live_calibration_ladder.limitations.join('\n'), /recovery case is now live-proven/);
  assert.match(capabilities.advisor_live_calibration_ladder.liveEvidence.join('\n'), /bounded recovery evidence/);
  assert.match(capabilities.hostile_escalation_jk.limitations.join('\n'), /not broad advanced combat or PvP/);
  assert.match(capabilities.advisor_live_plan_reporter.limitations.join('\n'), /not broad autonomous long-horizon planning/);
  assert.match(capabilities.long_horizon_mission_primitives.limitations.join('\n'), /does not prove multi-hour live Minecraft endurance/);
  assert.match(capabilities.c4_carpet_pvp_heuristic_extraction.limitations.join('\n'), /not an implementation of advanced PvP/);
  assert.match(capabilities.repeatable_benchmark_ladder.limitations.join('\n'), /excluded from formal benchmark evidence/);
  assert.match(capabilities.advanced_authorized_pvp.limitations.join('\n'), /No advanced PvP/);
  assert.match(capabilities.viewer_operator_handoff.limitations.join('\n'), /No prismarine-viewer integration/);
  assert.doesNotMatch(capabilities.viewer_operator_handoff.limitations.join('\n'), /local proxy/i);
  assert.doesNotMatch(
    reportTextFor(capabilities),
    /Proceed to F1|Proceed to F3|Record F4|Use F2 as seed evidence/i,
  );
});

test('capability matrix markdown renders labels and avoids private response markers', () => {
  const report = buildCapabilityMatrix({ generatedAt: '2026-05-23T00:00:00.000Z' });
  const text = JSON.stringify(report) + '\n' + renderCapabilityMatrix(report);

  assert.match(text, /# Deterministic Capability Matrix/);
  assert.match(text, /live-proven/);
  assert.match(text, /offline-covered/);
  assert.match(text, /scaffolded/);
  assert.match(text, /pending/);
  assert.match(text, /advanced_authorized_pvp/);
  assert.match(text, /c4_carpet_pvp_heuristic_extraction/);
  assert.match(text, /repeatable_benchmark_ladder/);
  assert.match(text, /advisor_live_plan_reporter/);
  assert.match(text, /advisor_live_calibration_ladder/);
  assert.match(text, /viewer_operator_handoff/);
  for (const marker of ['raw' + 'Response', 'DEEPSEEK' + '_API_KEY']) {
    assert.equal(text.includes(marker), false);
  }
});

test('capability matrix CLI writes JSON and markdown reports without touching default reports in tests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-capability-matrix-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/capability-matrix.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCBOT_CAPABILITY_MATRIX_REPORT_DIR: dir,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /capability-matrix: wrote/);

    const json = JSON.parse(fs.readFileSync(path.join(dir, 'capability-matrix.json'), 'utf8'));
    const markdown = fs.readFileSync(path.join(dir, 'capability-matrix.md'), 'utf8');
    assert.equal(json.noApiCall, false);
    assert.equal(json.summary.total, json.capabilities.length);
    assert.match(markdown, /No DeepSeek\/API call made: no/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
