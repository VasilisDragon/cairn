#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  captureDirectoryState,
  restoreDirectoryState,
} from './report-preservation.js';

const ROOT = process.cwd();
const TEST_DIR = path.join(ROOT, 'test', 'offline');
const REPORT_DIR = path.join(ROOT, 'reports');

const files = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(TEST_DIR, name));

if (files.length === 0) {
  process.stderr.write('No offline unit tests found in test/offline\n');
  process.exit(1);
}

const reportState = captureDirectoryState(REPORT_DIR);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', file], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) failed = true;
}

try {
  restoreDirectoryState(reportState);
} catch (err) {
  process.stderr.write(`run-offline-tests: failed to restore reports directory after tests: ${err.message}\n`);
  process.exit(1);
}

process.exit(failed ? 1 : 0);
