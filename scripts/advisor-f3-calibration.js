#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR,
  DEFAULT_ADVISOR_F3_CALIBRATION_READINESS,
  DEFAULT_ADVISOR_F3_RESPONSE_DIR,
  buildAdvisorFirstCallReplayReport,
  renderAdvisorFirstCallReplayReport,
} from '../src/advisor/dry_run_calibration.js';
import {
  ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV,
  ADVISOR_FIRST_CALL_CAPTURE_OK_ENV,
  ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE_ENV,
  buildAdvisorFirstCallCaptureRunPlan,
  renderAdvisorFirstCallCaptureRun,
  runAdvisorFirstCallCapture,
  sanitizeAdvisorFirstCallCaptureRunPublicReport,
} from '../src/advisor/first_call_capture_run.js';
import {
  DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS,
  evaluateAdvisorResponseCaptureGuard,
  renderAdvisorResponseCaptureGuard,
} from '../src/advisor/response_capture_guard.js';

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, 'reports');
const F3_JSON_REPORT = path.join(REPORT_DIR, 'advisor-f3-calibration.json');
const F3_MD_REPORT = path.join(REPORT_DIR, 'advisor-f3-calibration.md');
const F3_REPLAY_JSON_REPORT = path.join(REPORT_DIR, 'advisor-f3-replay.json');
const F3_REPLAY_MD_REPORT = path.join(REPORT_DIR, 'advisor-f3-replay.md');
const F3_GUARD_JSON_REPORT = path.join(REPORT_DIR, 'advisor-f3-response-capture-guard.json');
const F3_GUARD_MD_REPORT = path.join(REPORT_DIR, 'advisor-f3-response-capture-guard.md');

const fixtureDir = process.env.MCBOT_ADVISOR_DRY_RUN_FIXTURE_DIR || DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR;
const responseDir = process.env.MCBOT_ADVISOR_F3_RESPONSE_DIR || DEFAULT_ADVISOR_F3_RESPONSE_DIR;
const request = {
  maxTokens: numberFromEnv('MCBOT_ADVISOR_F3_MAX_TOKENS', 4096),
};
const execute = envFlag('MCBOT_ADVISOR_F3_CAPTURE_EXECUTE') || envFlag(ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV);
const captureConfirmed = envFlag('MCBOT_ADVISOR_F3_CAPTURE_OK') || envFlag(ADVISOR_FIRST_CALL_CAPTURE_OK_ENV);
const overwrite = envFlag('MCBOT_ADVISOR_F3_CAPTURE_OVERWRITE') || envFlag(ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE_ENV);
const runEnv = {
  ...process.env,
  ...(execute ? { [ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV]: '1' } : {}),
  ...(captureConfirmed ? { [ADVISOR_FIRST_CALL_CAPTURE_OK_ENV]: '1' } : {}),
  ...(overwrite ? { [ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE_ENV]: '1' } : {}),
};

const sharedOpts = {
  fixtureDir,
  responseDir,
  root: ROOT,
  execute,
  captureConfirmed,
  overwrite,
  request,
  firstCallReadinessRequirements: DEFAULT_ADVISOR_F3_CALIBRATION_READINESS,
};

let captureReport = buildAdvisorFirstCallCaptureRunPlan(runEnv, sharedOpts);
if (captureReport.readyToExecute === true) {
  const { completeWithMetrics } = await import('../src/advisor/deepseek.js');
  captureReport = await runAdvisorFirstCallCapture({
    ...sharedOpts,
    env: runEnv,
    execute: true,
    complete: completeWithMetrics,
  });
}

const publicCaptureReport = decorateF3CaptureReport(
  sanitizeAdvisorFirstCallCaptureRunPublicReport(captureReport),
);
const requireComplete = envFlag('MCBOT_ADVISOR_F3_REQUIRE_RESPONSES')
  || captureReport.noApiCall === false
  || (captureReport.responseOutput?.nonEmptyResponseCount || 0) >= DEFAULT_ADVISOR_F3_CALIBRATION_READINESS.minCandidates;
const replay = buildAdvisorFirstCallReplayReport(undefined, {
  fixtureDir,
  responseDir,
  request,
  firstCallReadinessRequirements: DEFAULT_ADVISOR_F3_CALIBRATION_READINESS,
  requireCompleteResponses: requireComplete,
  requireResponseMetrics: requireComplete,
});

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(F3_JSON_REPORT, JSON.stringify(publicCaptureReport, null, 2) + '\n');
fs.writeFileSync(F3_MD_REPORT, renderAdvisorFirstCallCaptureRun({
  ...publicCaptureReport,
  title: 'Advisor F3 Calibration',
}));
fs.writeFileSync(F3_REPLAY_JSON_REPORT, JSON.stringify(replay, null, 2) + '\n');
fs.writeFileSync(F3_REPLAY_MD_REPORT, renderAdvisorFirstCallReplayReport({
  ...replay,
  title: 'Advisor F3 Replay',
}));

const guard = evaluateAdvisorResponseCaptureGuard({
  root: ROOT,
  responseDir,
  reportChecks: f3ReportChecks(),
});
fs.writeFileSync(F3_GUARD_JSON_REPORT, JSON.stringify(guard, null, 2) + '\n');
fs.writeFileSync(F3_GUARD_MD_REPORT, renderAdvisorResponseCaptureGuard(guard));

process.stdout.write(`advisor-f3-calibration: wrote ${path.relative(ROOT, F3_JSON_REPORT)} and ${path.relative(ROOT, F3_MD_REPORT)}\n`);
process.stdout.write(`advisor-f3-calibration: wrote ${path.relative(ROOT, F3_REPLAY_JSON_REPORT)} and ${path.relative(ROOT, F3_REPLAY_MD_REPORT)}\n`);
process.stdout.write(`advisor-f3-calibration: wrote ${path.relative(ROOT, F3_GUARD_JSON_REPORT)} and ${path.relative(ROOT, F3_GUARD_MD_REPORT)}\n`);
if (captureReport.capture?.wroteResponseFile) {
  process.stdout.write(`advisor-f3-calibration: wrote private response file ${captureReport.capture.responseFile}\n`);
}

const ok = captureReport.noApiCall === false
  ? captureReport.ok === true
    && replay.ok === true
    && replay.presentCount >= DEFAULT_ADVISOR_F3_CALIBRATION_READINESS.minCandidates
    && replay.responseMetricsIncompleteCount === 0
    && guard.ok === true
  : captureReport.ok === true && guard.ok === true && (!requireComplete || replay.ok === true);
process.exit(ok ? 0 : 1);

function envFlag(name) {
  return process.env[name] === '1';
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function decorateF3CaptureReport(report) {
  return {
    ...report,
    profile: 'f3_five_response_calibration',
    responseDir,
    minResponseCount: DEFAULT_ADVISOR_F3_CALIBRATION_READINESS.minCandidates,
    calibrationTiersRequired: DEFAULT_ADVISOR_F3_CALIBRATION_READINESS.requiredCalibrationTiers,
    commands: {
      dryRunPlan: 'npm run advisor:f3',
      executeCapture: '$env:MCBOT_ADVISOR_F3_CAPTURE_EXECUTE=\'1\'; $env:MCBOT_ADVISOR_F3_CAPTURE_OK=\'1\'; $env:MCBOT_ALLOW_DEEPSEEK=\'1\'; npm run advisor:f3',
      executeOverwrite: '$env:MCBOT_ADVISOR_F3_CAPTURE_EXECUTE=\'1\'; $env:MCBOT_ADVISOR_F3_CAPTURE_OK=\'1\'; $env:MCBOT_ADVISOR_F3_CAPTURE_OVERWRITE=\'1\'; $env:MCBOT_ALLOW_DEEPSEEK=\'1\'; npm run advisor:f3',
      strictReplay: '$env:MCBOT_ADVISOR_F3_REQUIRE_RESPONSES=\'1\'; npm run advisor:f3',
      finalGuard: 'npm run advisor:f3',
    },
  };
}

function f3ReportChecks() {
  return [
    ...DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS,
    { path: 'reports/advisor-f3-calibration.json' },
    { path: 'reports/advisor-f3-replay.json' },
    { path: 'reports/advisor-f3-calibration.md', format: 'text' },
    { path: 'reports/advisor-f3-replay.md', format: 'text' },
  ];
}
