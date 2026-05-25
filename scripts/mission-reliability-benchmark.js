#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  buildMissionReliabilityBenchmarkReport,
  renderMissionReliabilityBenchmarkReport,
} from '../src/benchmarks/mission_reliability.js';

const ROOT = process.cwd();
const DEFAULT_REPORT_DIR = path.join(ROOT, 'reports');

const args = parseArgs(process.argv.slice(2));
const reportDir = path.resolve(args.reportDir || process.env.MCBOT_MISSION_BENCHMARK_REPORT_DIR || DEFAULT_REPORT_DIR);
const reportPath = path.resolve(args.report || path.join(reportDir, 'mission-reliability-benchmark.json'));
const markdownPath = path.resolve(args.markdown || path.join(reportDir, 'mission-reliability-benchmark.md'));

let report;
try {
  report = await buildMissionReliabilityBenchmarkReport();
} catch (err) {
  report = {
    ok: false,
    id: 'long_horizon_mission_reliability',
    status: 'invalid',
    noApiCall: true,
    generatedAt: new Date().toISOString(),
    error: err?.message || String(err),
    cases: [],
  };
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(markdownPath, renderMissionReliabilityBenchmarkReport(report));

process.stdout.write(`mission-reliability-benchmark: wrote ${path.relative(ROOT, reportPath)} and ${path.relative(ROOT, markdownPath)}\n`);
process.exit(report.ok ? 0 : 1);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-dir') out.reportDir = argv[++i];
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--markdown') out.markdown = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'usage: node scripts/mission-reliability-benchmark.js [--report-dir reports]',
        '',
        'Writes reports/mission-reliability-benchmark.{json,md}.',
        'The benchmark is offline-only and makes no DeepSeek/API calls.',
        '',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}
