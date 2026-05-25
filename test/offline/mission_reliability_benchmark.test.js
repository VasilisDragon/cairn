import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  buildMissionReliabilityBenchmarkReport,
  renderMissionReliabilityBenchmarkReport,
} from '../../src/benchmarks/mission_reliability.js';

function byId(report) {
  return Object.fromEntries(report.cases.map((entry) => [entry.id, entry]));
}

test('mission reliability benchmark proves scaled return, deposit, preempt, and fail-closed cases', async () => {
  const report = await buildMissionReliabilityBenchmarkReport({
    generatedAt: '2026-05-24T00:00:00.000Z',
  });
  const cases = byId(report);

  assert.equal(report.ok, true);
  assert.equal(report.status, 'offline-covered');
  assert.equal(report.noApiCall, true);
  assert.equal(report.summary.caseCount, 5);
  assert.equal(report.summary.failCount, 0);
  assert.equal(cases.scaled_fishing_deposit_return.status, 'pass');
  assert.equal(cases.scaled_fishing_deposit_return.metrics.returnedBeforeDeadline, true);
  assert.ok(cases.scaled_fishing_deposit_return.metrics.depositCount >= 2);
  assert.equal(cases.scaled_mining_inventory_pressure_return.status, 'pass');
  assert.equal(cases.scaled_mining_inventory_pressure_return.metrics.returnedBeforeDeadline, true);
  assert.ok(cases.scaled_mining_inventory_pressure_return.metrics.depositCount >= 1);
  assert.equal(cases.dynamic_slow_route_return_outranks_deposit.status, 'pass');
  assert.ok(
    cases.dynamic_slow_route_return_outranks_deposit.metrics.reserveMs
      > cases.dynamic_slow_route_return_outranks_deposit.metrics.originalReturnReserveMs,
  );
  assert.equal(cases.reactive_preempt_preserves_mission_state.metrics.preempted, true);
  assert.equal(cases.missing_return_handler_fails_closed.metrics.failedClosed, true);
});

test('mission reliability benchmark markdown names live limitations honestly', async () => {
  const report = await buildMissionReliabilityBenchmarkReport();
  const text = JSON.stringify(report) + '\n' + renderMissionReliabilityBenchmarkReport(report);

  assert.match(text, /Long-Horizon Mission Reliability Benchmark/);
  assert.match(text, /private live soaks still required: yes/);
  assert.match(text, /does not claim multi-hour live Minecraft endurance/);
  assert.match(text, /scaled_fishing_deposit_return/);
  assert.match(text, /scaled_mining_inventory_pressure_return/);
  for (const marker of ['DEEPSEEK' + '_API_KEY', 'raw' + 'Response']) {
    assert.equal(text.includes(marker), false);
  }
});

test('mission reliability benchmark CLI writes JSON and markdown reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-mission-benchmark-'));
  try {
    const result = spawnSync(process.execPath, [
      'scripts/mission-reliability-benchmark.js',
      '--report-dir', dir,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mission-reliability-benchmark: wrote/);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'mission-reliability-benchmark.json'), 'utf8'));
    const markdown = fs.readFileSync(path.join(dir, 'mission-reliability-benchmark.md'), 'utf8');
    assert.equal(report.ok, true);
    assert.equal(report.noApiCall, true);
    assert.match(markdown, /Overall: PASS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
