#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  buildCapabilityMatrix,
  renderCapabilityMatrix,
} from '../src/goal/capability_matrix.js';

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(process.env.MCBOT_CAPABILITY_MATRIX_REPORT_DIR || path.join(ROOT, 'reports'));
const JSON_REPORT = path.join(REPORT_DIR, 'capability-matrix.json');
const MD_REPORT = path.join(REPORT_DIR, 'capability-matrix.md');

const report = buildCapabilityMatrix();

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_REPORT, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(MD_REPORT, renderCapabilityMatrix(report));

process.stdout.write(`capability-matrix: wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}\n`);
