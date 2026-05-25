import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  BENCHMARK_STATUSES,
  benchmarkLadderComplete,
  buildBenchmarkLadderReport,
  evaluateBenchmarkLadderWorkstreamExit,
  renderBenchmarkLadderReport,
} from '../../src/benchmarks/ladder.js';

function fakeSourceReports() {
  return {
    advisorLivePlan: {
      ok: true,
      status: 'live_plan_completed',
      planner: { callMade: true },
      activation: { accepted: true },
      executor: { skillsExecuted: ['collect'] },
      finalOutcome: { ok: true },
      hostileFlee: { survived: true },
      cost: { usd: 0.0068 },
    },
    liveEvidence: {
      scenarios: {
        live_hostile_escalation_fixture: {
          status: 'live-proven',
          liveProven: true,
          metrics: {
            spawnedHostiles: 8,
            finalNearestDistance: 45.85,
          },
        },
        live_pvm_escalation_decision_fixture: {
          status: 'live-proven',
          liveProven: true,
          metrics: {
            maxHostileCount: 4,
            finalHealth: 20,
          },
        },
      },
    },
    advisorLiveCalibration: {
      ok: true,
      status: 'live_calibration_complete',
      summary: {
        liveProvenClasses: ['accepted', 'rejected', 'stale', 'unsafe', 'recovery'],
        pendingClasses: [],
      },
      safety: {
        allLiveEvidenceNoBypass: true,
      },
    },
    missionReliabilityBenchmark: {
      ok: true,
      status: 'offline-covered',
      summary: {
        caseCount: 5,
        failCount: 0,
        returnByDeadlineCases: 2,
      },
    },
    detectionRateBenchmark: {
      ok: true,
      status: 'pending_manifest',
      manifest: { clipCount: 0 },
      scoring: { classifiedCount: 0, accuracy: null },
    },
    phaseShiftReadiness: {
      ready: true,
    },
    capabilityMatrix: {
      capabilities: [
        capability('live_fixture_suite_a_i', BENCHMARK_STATUSES.LIVE_PROVEN, 'A through I live fixtures are proven.'),
        capability('build_schematic_dry_run', BENCHMARK_STATUSES.OFFLINE_COVERED, 'Build dry-run planning is covered offline.'),
        capability('long_horizon_mission_primitives', BENCHMARK_STATUSES.SCAFFOLDED, 'Long-horizon mission primitives exist.'),
        capability('advanced_authorized_pvp', BENCHMARK_STATUSES.PENDING, 'Advanced PvP is an explicit target.'),
        capability('viewer_operator_handoff', BENCHMARK_STATUSES.PENDING, 'Viewer and handoff are documented only.'),
        capability('publication_evidence_pack', BENCHMARK_STATUSES.SCAFFOLDED, 'Publication evidence reports exist.'),
      ],
    },
  };
}

function capability(id, status, claim) {
  return {
    id,
    status,
    claim,
    offlineEvidence: [],
    liveEvidence: [],
    limitations: [],
    nextCommand: 'test',
  };
}

function byId(report) {
  return Object.fromEntries(report.entries.map((entry) => [entry.id, entry]));
}

test('benchmark ladder separates controlled live evidence from scaffolded and pending work', () => {
  const report = buildBenchmarkLadderReport({
    sourceReports: fakeSourceReports(),
    generatedAt: '2026-05-24T00:00:00.000Z',
  });
  const entries = byId(report);

  assert.equal(report.ok, true);
  assert.equal(report.noApiCall, true);
  assert.equal(report.summary.total, report.entries.length);
  assert.equal(entries.f2_deepseek_gather_10_oak_with_hostile_flee.status, BENCHMARK_STATUSES.LIVE_PROVEN);
  assert.equal(entries.j_hostile_escalation_flee.status, BENCHMARK_STATUSES.LIVE_PROVEN);
  assert.equal(entries.k_pvm_engage_then_flee.status, BENCHMARK_STATUSES.LIVE_PROVEN);
  assert.equal(entries.advisor_live_calibration_five_classes.status, BENCHMARK_STATUSES.LIVE_PROVEN);
  assert.equal(entries.c3_detection_rate_blind_packet.status, BENCHMARK_STATUSES.SCAFFOLDED);
  assert.equal(entries.long_horizon_return_by_deadline.status, BENCHMARK_STATUSES.OFFLINE_COVERED);
  assert.equal(entries.advanced_private_combat_ladder.status, BENCHMARK_STATUSES.PENDING);
  assert.equal(entries.viewer_operator_handoff.status, BENCHMARK_STATUSES.PENDING);
  assert.ok(report.summary.liveProvenIds.includes('j_hostile_escalation_flee'));
  assert.ok(report.summary.nonLiveProvenIds.includes('advanced_private_combat_ladder'));
  assert.equal(report.workstreamExit.complete, true);
  assert.equal(benchmarkLadderComplete(report), true);
});

test('benchmark ladder promotes bounded long-horizon plugin soaks to live-proven', () => {
  const sourceReports = {
    ...fakeSourceReports(),
    pluginLiveFishingDryFiveMinuteSoak: pluginFishingSoakReport(),
    pluginLiveMiningStrictSoak: pluginMiningStrictSoakReport(),
  };
  const report = buildBenchmarkLadderReport({
    sourceReports,
    generatedAt: '2026-05-24T00:00:00.000Z',
  });
  const entry = byId(report).long_horizon_return_by_deadline;

  assert.equal(entry.status, BENCHMARK_STATUSES.LIVE_PROVEN);
  assert.match(entry.evidenceArtifact, /plugin-live-fishing-dry-five-minute-soak/);
  assert.match(entry.evidenceArtifact, /plugin-live-mining-strict-soak/);
  assert.match(entry.evidenceSummary, /live-proven bounded soaks/);
  assert.match(entry.evidenceSummary, /waterFallback=false/);
  assert.deepEqual(entry.blockers, []);
});

test('benchmark ladder refuses weak plugin soak evidence', () => {
  const sourceReports = {
    ...fakeSourceReports(),
    pluginLiveFishingDryFiveMinuteSoak: {
      ...pluginFishingSoakReport(),
      childLogSummary: {
        lastByEvent: {
          'live_supply_chest_fishing_fixture.before': {
            allowWaterPickup: false,
            waterPickupFallback: false,
          },
          'live_supply_chest_fishing_fixture.done': {
            durationOnly: true,
            minCatches: 8,
            catches: 7,
            taskBudget: { elapsedMs: 259000, durationMs: 300000, overdue: false },
            loopResult: { reason: 'return-reserve-reached' },
          },
        },
      },
    },
    pluginLiveMiningStrictSoak: pluginMiningStrictSoakReport(),
  };
  const report = buildBenchmarkLadderReport({ sourceReports });
  const entry = byId(report).long_horizon_return_by_deadline;

  assert.equal(entry.status, BENCHMARK_STATUSES.OFFLINE_COVERED);
  assert.match(entry.evidenceSummary, /missingLive=plugin-backed fishing duration soak/);
  assert.ok(entry.blockers.some((blocker) => /Run missing plugin-backed bounded soaks/.test(blocker)));
});

test('benchmark ladder entries declare reproducible fixture metadata', () => {
  const report = buildBenchmarkLadderReport({ sourceReports: fakeSourceReports() });

  assert.ok(report.entries.length >= 8);
  for (const entry of report.entries) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.track, 'string');
    assert.equal(typeof entry.mode, 'string');
    assert.equal(typeof entry.status, 'string');
    assert.equal(typeof entry.setup, 'string');
    assert.equal(typeof entry.command, 'string');
    assert.equal(typeof entry.expectedResult, 'string');
    assert.equal(typeof entry.evidenceArtifact, 'string');
    assert.equal(typeof entry.evidenceSummary, 'string');
    assert.equal(typeof entry.nextAction, 'string');
    assert.ok(Array.isArray(entry.sourceReports));
    assert.ok(Array.isArray(entry.blockers));
  }
});

test('benchmark ladder exit criteria fail closed for missing blockers or weak status separation', () => {
  const report = buildBenchmarkLadderReport({ sourceReports: fakeSourceReports() });
  const noBlockers = report.entries.map((entry) => ({
    ...entry,
    blockers: entry.status === BENCHMARK_STATUSES.LIVE_PROVEN ? [] : [],
  }));
  const allLive = report.entries.map((entry) => ({
    ...entry,
    status: BENCHMARK_STATUSES.LIVE_PROVEN,
    blockers: [],
  }));

  assert.equal(evaluateBenchmarkLadderWorkstreamExit(noBlockers).complete, false);
  assert.equal(evaluateBenchmarkLadderWorkstreamExit(allLive).complete, false);
});

test('benchmark ladder policy excludes uncontrolled manual hostile spawning from formal evidence', () => {
  const report = buildBenchmarkLadderReport({ sourceReports: fakeSourceReports() });
  const policyText = JSON.stringify(report.evidencePolicy);

  assert.match(policyText, /Manual external zombie spawning/);
  assert.match(policyText, /Uncontrolled chaos runs can inform future fixtures/);
});

test('benchmark ladder markdown and CLI avoid secrets and private response markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-benchmark-ladder-'));
  try {
    writeJson(path.join(dir, 'advisor-live-plan.json'), fakeSourceReports().advisorLivePlan);
    writeJson(path.join(dir, 'live-evidence.json'), fakeSourceReports().liveEvidence);
    writeJson(path.join(dir, 'advisor-live-calibration.json'), fakeSourceReports().advisorLiveCalibration);
    writeJson(path.join(dir, 'mission-reliability-benchmark.json'), fakeSourceReports().missionReliabilityBenchmark);
    writeJson(path.join(dir, 'plugin-live-fishing-dry-five-minute-soak.json'), pluginFishingSoakReport());
    writeJson(path.join(dir, 'plugin-live-mining-strict-soak.json'), pluginMiningStrictSoakReport());
    writeJson(path.join(dir, 'detection-rate-benchmark.json'), fakeSourceReports().detectionRateBenchmark);
    writeJson(path.join(dir, 'capability-matrix.json'), fakeSourceReports().capabilityMatrix);
    writeJson(path.join(dir, 'phase-shift-readiness.json'), fakeSourceReports().phaseShiftReadiness);

    const result = spawnSync(process.execPath, [
      'scripts/benchmark-ladder.js',
      '--source-report-dir', dir,
      '--report-dir', dir,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /benchmark-ladder: wrote/);

    const jsonText = fs.readFileSync(path.join(dir, 'benchmark-ladder.json'), 'utf8');
    const markdown = fs.readFileSync(path.join(dir, 'benchmark-ladder.md'), 'utf8');
    const rendered = renderBenchmarkLadderReport(JSON.parse(jsonText));
    const combined = `${jsonText}\n${markdown}\n${rendered}`;
    assert.match(combined, /Repeatable Benchmark Ladder/);
    assert.match(combined, /f2_deepseek_gather_10_oak_with_hostile_flee/);
    assert.match(combined, /long_horizon_return_by_deadline/);
    assert.match(combined, /live-proven bounded soaks/);
    for (const marker of ['DEEPSEEK' + '_API_KEY', 'raw' + 'Response']) {
      assert.equal(combined.includes(marker), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pluginFishingSoakReport() {
  return {
    ok: true,
    status: 'plugin_live_scenario_passed',
    scenario: 'live_supply_chest_fishing_fixture',
    token: 'live_supply_chest_fishing_fixture-test',
    telemetryPath: 'D:\\Minecraft\\Server\\.\\mcbottest\\fish.jsonl',
    child: { exitCode: 0 },
    validation: { ok: true },
    telemetrySummary: {
      itemPickupCount: 13,
      eventCounts: {
        scenario_start: 1,
        item_pickup: 13,
        scenario_end: 1,
      },
    },
    childLogSummary: {
      lastByEvent: {
        'live_supply_chest_fishing_fixture.before': {
          allowWaterPickup: false,
          waterPickupFallback: false,
        },
        'live_supply_chest_fishing_fixture.done': {
          durationOnly: true,
          minCatches: 8,
          catches: 13,
          taskBudget: {
            elapsedMs: 259232,
            durationMs: 300000,
            overdue: false,
          },
          loopResult: {
            reason: 'return-reserve-reached',
          },
        },
      },
    },
  };
}

function pluginMiningStrictSoakReport() {
  return {
    ok: true,
    status: 'plugin_live_scenario_passed',
    scenario: 'live_mining_soak_fixture',
    token: 'live_mining_soak_fixture-test',
    telemetryPath: 'D:\\Minecraft\\Server\\.\\mcbottest\\mine.jsonl',
    child: { exitCode: 0 },
    validation: { ok: true },
    telemetrySummary: {
      blockBreakCount: 14,
      itemPickupCount: 14,
      eventCounts: {
        scenario_start: 1,
        block_break: 14,
        item_pickup: 14,
        scenario_end: 1,
      },
    },
    childLogSummary: {
      lastByEvent: {
        'live_mining_soak_fixture.done': {
          durationMs: 67411,
          requireReturnReserve: true,
          minWorkMs: 50000,
          returnedBeforeDeadline: true,
          taskBudget: {
            elapsedMs: 67411,
            durationMs: 90000,
            overdue: false,
          },
          loopResult: {
            reason: 'return-reserve-reached',
          },
          minedDelta: {
            diamond: 13,
            raw_iron: 1,
          },
          depositTargets: {
            diamond: 13,
            raw_iron: 1,
          },
        },
      },
    },
  };
}
