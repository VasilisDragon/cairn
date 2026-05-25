#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  buildDetectionRateBenchmarkReport,
  createBlindReviewPacket,
  renderDetectionRateBenchmarkReport,
} from '../src/benchmarks/detection_rate.js';

const ROOT = process.cwd();
const DEFAULT_REPORT_DIR = path.join(ROOT, 'reports');
const DEFAULT_MANIFEST = path.join(ROOT, 'data', 'detection-rate', 'manifest.json');
const DEFAULT_CLASSIFICATIONS = path.join(ROOT, 'data', 'detection-rate', 'classifications.json');

const args = parseArgs(process.argv.slice(2));
const reportDir = path.resolve(args.reportDir || process.env.MCBOT_DETECTION_RATE_REPORT_DIR || DEFAULT_REPORT_DIR);
const reportPath = path.resolve(args.report || path.join(reportDir, 'detection-rate-benchmark.json'));
const markdownPath = path.resolve(args.markdown || path.join(reportDir, 'detection-rate-benchmark.md'));
const packetPath = path.resolve(args.packet || path.join(reportDir, 'detection-rate-blind-packet.json'));
const manifestPath = path.resolve(args.manifest || process.env.MCBOT_DETECTION_RATE_MANIFEST || DEFAULT_MANIFEST);
const classificationsPath = path.resolve(
  args.classifications || process.env.MCBOT_DETECTION_RATE_CLASSIFICATIONS || DEFAULT_CLASSIFICATIONS,
);

let report;
try {
  const manifest = readOptionalJson(manifestPath);
  const classifications = readOptionalJson(classificationsPath);
  report = buildDetectionRateBenchmarkReport({
    manifest,
    classifications,
    targetAccuracy: args.targetAccuracy,
    seed: args.seed || 'mcbot-c3-detection-rate-v1',
  });

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.mkdirSync(path.dirname(packetPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderDetectionRateBenchmarkReport(report));
  if (manifest) {
    const packet = createBlindReviewPacket(manifest, { seed: args.seed || 'mcbot-c3-detection-rate-v1' });
    fs.writeFileSync(packetPath, `${JSON.stringify({
      benchmark: packet.benchmark,
      truthHidden: true,
      metadataRemoved: packet.metadataRemoved,
      items: packet.items,
    }, null, 2)}\n`);
  } else {
    fs.writeFileSync(packetPath, `${JSON.stringify({
      benchmark: 'c3_detection_rate',
      truthHidden: true,
      metadataRemoved: report.blindPacket.metadataRemoved,
      items: [],
    }, null, 2)}\n`);
  }
} catch (err) {
  report = {
    ok: false,
    id: 'c3_detection_rate',
    status: 'invalid',
    noApiCall: true,
    error: err?.message || String(err),
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderDetectionRateBenchmarkReport(report));
}

process.stdout.write(`detection-rate-benchmark: wrote ${path.relative(ROOT, reportPath)} and ${path.relative(ROOT, markdownPath)}\n`);
process.exit(report.ok ? 0 : 1);

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--classifications') out.classifications = argv[++i];
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--markdown') out.markdown = argv[++i];
    else if (arg === '--packet') out.packet = argv[++i];
    else if (arg === '--report-dir') out.reportDir = argv[++i];
    else if (arg === '--seed') out.seed = argv[++i];
    else if (arg === '--target-accuracy') out.targetAccuracy = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'usage: node scripts/detection-rate-benchmark.js [--manifest data/detection-rate/manifest.json]',
        '',
        'Writes reports/detection-rate-benchmark.{json,md} and a truth-free blind packet.',
        'The default run is non-live and reports pending_manifest when no local clip manifest exists.',
        '',
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}
