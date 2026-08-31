#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR,
  DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR,
} from '../src/advisor/dry_run_calibration.js';
import {
  ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV,
  buildAdvisorFirstCallCaptureRunPlan,
  renderAdvisorFirstCallCaptureRun,
  runAdvisorFirstCallCapture,
  sanitizeAdvisorFirstCallCaptureRunPublicReport,
} from '../src/advisor/first_call_capture_run.js';

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(process.env.MCBOT_BASELINE_REPORT_ROOT || path.join(ROOT, 'reports'));
const JSON_REPORT = path.join(REPORT_DIR, 'advisor-first-call.json');
const MD_REPORT = path.join(REPORT_DIR, 'advisor-first-call.md');

const fixtureDir = process.env.MCBOT_ADVISOR_DRY_RUN_FIXTURE_DIR || DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR;
const responseDir = process.env.MCBOT_ADVISOR_FIRST_CALL_RESPONSE_DIR || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
const execute = process.env[ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV] === '1';

let report = buildAdvisorFirstCallCaptureRunPlan(process.env, {
  fixtureDir,
  responseDir,
  root: ROOT,
  execute,
  // The authoritative baseline leak scan runs after all reports are fresh.
  // Avoid consulting any checked-in report while preparing this no-API step.
  reportChecks: process.env.MCBOT_BASELINE_REPORT_ROOT ? [] : undefined,
});

if (report.readyToExecute === true) {
  const { completeWithMetrics } = await import('../src/advisor/deepseek.js');
  report = await runAdvisorFirstCallCapture({
    env: process.env,
    fixtureDir,
    responseDir,
    root: ROOT,
    execute: true,
    complete: completeWithMetrics,
  });
}

fs.mkdirSync(REPORT_DIR, { recursive: true });
const publicReport = sanitizeAdvisorFirstCallCaptureRunPublicReport(report);
fs.writeFileSync(JSON_REPORT, JSON.stringify(publicReport, null, 2) + '\n');
fs.writeFileSync(MD_REPORT, renderAdvisorFirstCallCaptureRun({
  ...publicReport,
  title: 'Advisor First Call',
}));

process.stdout.write(`advisor-first-call: wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}\n`);
if (report.capture?.wroteResponseFile) {
  process.stdout.write(`advisor-first-call: wrote private response file ${report.capture.responseFile}\n`);
}
process.exit(report.ok ? 0 : 1);
