#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR,
  renderAdvisorDryRunCalibration,
  runAdvisorDryRunCalibration,
} from '../src/advisor/dry_run_calibration.js';

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(process.env.MCBOT_BASELINE_REPORT_ROOT || path.join(ROOT, 'reports'));
const JSON_REPORT = path.join(REPORT_DIR, 'advisor-dry-run.json');
const MD_REPORT = path.join(REPORT_DIR, 'advisor-dry-run.md');

const fixtureDir = process.env.MCBOT_ADVISOR_DRY_RUN_FIXTURE_DIR || DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR;
const report = runAdvisorDryRunCalibration(undefined, { fixtureDir });
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_REPORT, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(MD_REPORT, renderAdvisorDryRunCalibration(report));
process.stdout.write(`advisor-dry-run: wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}\n`);
