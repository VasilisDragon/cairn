#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR } from '../src/advisor/dry_run_calibration.js';
import {
  DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS,
  evaluateAdvisorResponseCaptureGuard,
  renderAdvisorResponseCaptureGuard,
} from '../src/advisor/response_capture_guard.js';

const ROOT = process.cwd();
const args = parseArgs(process.argv.slice(2));
if ((args.reportRoot || args.fixtureRoot) && process.env.MCBOT_BASELINE !== '1') {
  throw new Error('external response-capture inputs are reserved for the baseline runner');
}
if (Boolean(args.reportRoot) !== Boolean(args.fixtureRoot)) {
  throw new Error('baseline response-capture guard requires both report and fixture roots');
}
const REPORT_DIR = args.reportRoot ? requireExternalDirectory(args.reportRoot) : path.join(ROOT, 'reports');
const JSON_REPORT = path.join(REPORT_DIR, 'advisor-response-capture-guard.json');
const MD_REPORT = path.join(REPORT_DIR, 'advisor-response-capture-guard.md');

const fixtureRoot = args.fixtureRoot ? requireExternalDirectory(args.fixtureRoot) : null;
if (fixtureRoot && (pathInside(fixtureRoot, REPORT_DIR) || pathInside(REPORT_DIR, fixtureRoot))) {
  throw new Error('baseline report and fixture roots must be separate');
}
const responseDir = fixtureRoot
  ? path.join(fixtureRoot, 'data', 'advisor-first-call-responses')
  : process.env.MCBOT_ADVISOR_FIRST_CALL_RESPONSE_DIR || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
const reportChecks = args.reportRoot
  ? [
    ...DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.map((check) => ({
      ...check,
      path: path.basename(check.path),
    })),
    { path: 'baseline-fixture-eval.json' },
    { path: 'baseline-fixture-eval.md', format: 'text' },
  ]
  : undefined;
const report = evaluateAdvisorResponseCaptureGuard({
  root: args.reportRoot ? REPORT_DIR : ROOT,
  responseDir,
  reportChecks,
});

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_REPORT, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(MD_REPORT, renderAdvisorResponseCaptureGuard(report));
process.stdout.write(`advisor-response-capture-guard: wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}\n`);
process.exit(report.ok ? 0 : 1);

function parseArgs(argv) {
  const out = { reportRoot: null, fixtureRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report-root') out.reportRoot = requireValue(argv, ++index);
    else if (arg === '--baseline-fixture-root') out.fixtureRoot = requireValue(argv, ++index);
    else throw new Error('unknown argument');
  }
  return out;
}

function requireValue(argv, index) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error('missing argument value');
  return path.resolve(value);
}

function requireExternalDirectory(directoryPath) {
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('baseline input root is not a regular directory');
  const realRoot = fs.realpathSync(directoryPath);
  const relative = path.relative(fs.realpathSync(ROOT), realRoot);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('baseline input root must be outside the checkout');
  }
  return realRoot;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
