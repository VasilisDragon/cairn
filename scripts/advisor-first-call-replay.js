#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR,
  DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR,
  buildAdvisorFirstCallReplayReport,
  renderAdvisorFirstCallReplayReport,
} from '../src/advisor/dry_run_calibration.js';

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, 'reports');
const JSON_REPORT = path.join(REPORT_DIR, 'advisor-first-call-replay.json');
const MD_REPORT = path.join(REPORT_DIR, 'advisor-first-call-replay.md');

const fixtureDir = process.env.MCBOT_ADVISOR_DRY_RUN_FIXTURE_DIR || DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR;
const responseDir = process.env.MCBOT_ADVISOR_FIRST_CALL_RESPONSE_DIR || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
const requireCompleteResponses = process.env.MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES === '1';
const requireResponseMetrics = process.env.MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSE_METRICS === '1';
const report = buildAdvisorFirstCallReplayReport(undefined, {
  fixtureDir,
  responseDir,
  requireCompleteResponses,
  requireResponseMetrics,
});

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_REPORT, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(MD_REPORT, renderAdvisorFirstCallReplayReport(report));
process.stdout.write(`advisor-first-call-replay: wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}\n`);
process.exit(report.ok ? 0 : 1);
