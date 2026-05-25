import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  captureDirectoryState,
  restoreDirectoryState,
} from '../../scripts/report-preservation.js';

test('report preservation restores modified files and removes files created by tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-report-preserve-'));
  const reportsDir = path.join(root, 'reports');
  fs.mkdirSync(path.join(reportsDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'stable.json'), '{"ok":true}\n');
  fs.writeFileSync(path.join(reportsDir, 'nested', 'stable.md'), 'stable\n');

  const state = captureDirectoryState(reportsDir);
  fs.writeFileSync(path.join(reportsDir, 'stable.json'), '{"ok":false}\n');
  fs.writeFileSync(path.join(reportsDir, 'new.json'), '{"created":true}\n');
  fs.mkdirSync(path.join(reportsDir, 'created'), { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'created', 'temp.md'), 'temp\n');
  fs.unlinkSync(path.join(reportsDir, 'nested', 'stable.md'));

  restoreDirectoryState(state);

  assert.equal(fs.readFileSync(path.join(reportsDir, 'stable.json'), 'utf8'), '{"ok":true}\n');
  assert.equal(fs.readFileSync(path.join(reportsDir, 'nested', 'stable.md'), 'utf8'), 'stable\n');
  assert.equal(fs.existsSync(path.join(reportsDir, 'new.json')), false);
  assert.equal(fs.existsSync(path.join(reportsDir, 'created')), false);
});

test('report preservation removes a directory that did not exist before tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-report-preserve-missing-'));
  const reportsDir = path.join(root, 'reports');
  const state = captureDirectoryState(reportsDir);

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'test-output.md'), 'temporary\n');

  restoreDirectoryState(state);

  assert.equal(fs.existsSync(reportsDir), false);
});
