#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  buildBenchmarkLadderReport,
  renderBenchmarkLadderReport,
} from '../src/benchmarks/ladder.js';

const ROOT = process.cwd();
const DEFAULT_REPORT_DIR = path.join(ROOT, 'reports');

const args = parseArgs(process.argv.slice(2));
const sourceReportDir = path.resolve(args.sourceReportDir || process.env.MCBOT_BENCHMARK_LADDER_SOURCE_REPORT_DIR || DEFAULT_REPORT_DIR);
const reportDir = path.resolve(args.reportDir || process.env.MCBOT_BENCHMARK_LADDER_REPORT_DIR || DEFAULT_REPORT_DIR);
const reportPath = path.resolve(args.report || path.join(reportDir, 'benchmark-ladder.json'));
const markdownPath = path.resolve(args.markdown || path.join(reportDir, 'benchmark-ladder.md'));

let report;
try {
  report = buildBenchmarkLadderReport({
    sourceReports: {
      advisorLivePlan: readOptionalJson(path.join(sourceReportDir, 'advisor-live-plan.json')),
      liveEvidence: readOptionalJson(path.join(sourceReportDir, 'live-evidence.json')),
      advisorLiveCalibration: readOptionalJson(path.join(sourceReportDir, 'advisor-live-calibration.json')),
      missionReliabilityBenchmark: readOptionalJson(path.join(sourceReportDir, 'mission-reliability-benchmark.json')),
      pluginLiveFishingDryFiveMinuteSoak: readOptionalJson(path.join(sourceReportDir, 'plugin-live-fishing-dry-five-minute-soak.json')),
      pluginLiveFishingFiveMinuteSoak: readOptionalJson(path.join(sourceReportDir, 'plugin-live-fishing-five-minute-soak.json')),
      pluginLiveFishingDurationSoak: readOptionalJson(path.join(sourceReportDir, 'plugin-live-fishing-duration-soak.json')),
      pluginLiveMiningStrictSoak: readOptionalJson(path.join(sourceReportDir, 'plugin-live-mining-strict-soak.json')),
      detectionRateBenchmark: readOptionalJson(path.join(sourceReportDir, 'detection-rate-benchmark.json')),
      capabilityMatrix: readOptionalJson(path.join(sourceReportDir, 'capability-matrix.json')),
      phaseShiftReadiness: readOptionalJson(path.join(sourceReportDir, 'phase-shift-readiness.json')),
    },
  });
} catch (err) {
  report = {
    ok: false,
    id: 'repeatable_benchmark_ladder',
    generatedAt: new Date().toISOString(),
    noApiCall: true,
    error: err?.message || String(err),
    entries: [],
    nextActions: [],
  };
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(markdownPath, renderBenchmarkLadderReport(report));

process.stdout.write(`benchmark-ladder: wrote ${path.relative(ROOT, reportPath)} and ${path.relative(ROOT, markdownPath)}\n`);
process.exit(report.ok ? 0 : 1);

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source-report-dir') out.sourceReportDir = argv[++i];
    else if (arg === '--report-dir') out.reportDir = argv[++i];
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--markdown') out.markdown = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'usage: node scripts/benchmark-ladder.js [--source-report-dir reports] [--report-dir reports]',
        '',
        'Writes reports/benchmark-ladder.{json,md} from existing sanitized reports.',
        'The reporter is non-live and makes no DeepSeek/API calls.',
        '',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}
