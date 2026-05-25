#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR } from '../src/advisor/dry_run_calibration.js';
import {
  evaluateAdvisorResponseCaptureGuard,
  renderAdvisorResponseCaptureGuard,
} from '../src/advisor/response_capture_guard.js';

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, 'reports');
const JSON_REPORT = path.join(REPORT_DIR, 'advisor-response-capture-guard.json');
const MD_REPORT = path.join(REPORT_DIR, 'advisor-response-capture-guard.md');

const responseDir = process.env.MCBOT_ADVISOR_FIRST_CALL_RESPONSE_DIR || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
const report = evaluateAdvisorResponseCaptureGuard({
  root: ROOT,
  responseDir,
});

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_REPORT, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(MD_REPORT, renderAdvisorResponseCaptureGuard(report));
process.stdout.write(`advisor-response-capture-guard: wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}\n`);
process.exit(report.ok ? 0 : 1);
