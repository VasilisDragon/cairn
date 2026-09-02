import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createBaselineSynchronousNodeChildEnvironment } from '../../scripts/baseline-synchronous-node-child.js';

test('baseline parser children retain the network guard without recursively bootstrapping the resource lock', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-check-js-'));
  const scripts = path.join(workspace, 'scripts');
  const guardPath = path.join(scripts, 'baseline-network-guard.cjs');
  const bootstrapPath = path.join(scripts, 'resource-lock-bootstrap.js');
  const sourcePath = path.join(workspace, 'valid.js');
  const guardMarker = path.join(workspace, 'guard-loaded');
  const bootstrapMarker = path.join(workspace, 'bootstrap-loaded');
  try {
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(guardPath, "require('node:fs').writeFileSync(process.env.MCBOT_TEST_GUARD_MARKER, 'loaded');\n", 'utf8');
    fs.writeFileSync(bootstrapPath, [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.MCBOT_TEST_BOOTSTRAP_MARKER, 'loaded');",
      "throw new Error('parser child must not load the resource-lock bootstrap');",
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(sourcePath, 'export const valid = true;\n', 'utf8');

    const guardOption = `--require=${JSON.stringify(guardPath)}`;
    const bootstrapOption = `--import=${JSON.stringify(pathToFileURL(bootstrapPath).href)}`;
    const sourceEnvironment = {
      ...process.env,
      MCBOT_BASELINE: '1',
      MCBOT_TEST_GUARD_MARKER: guardMarker,
      MCBOT_TEST_BOOTSTRAP_MARKER: bootstrapMarker,
      NODE_OPTIONS: `${guardOption} ${bootstrapOption} --v8-pool-size=1`,
    };
    const childEnvironment = createBaselineSynchronousNodeChildEnvironment(sourceEnvironment, workspace);

    assert.equal(childEnvironment.NODE_OPTIONS, `${guardOption} --v8-pool-size=1`);
    const result = spawnSync(process.execPath, ['--check', sourcePath], {
      cwd: workspace,
      env: childEnvironment,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(guardMarker, 'utf8'), 'loaded');
    assert.equal(fs.existsSync(bootstrapMarker), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('baseline parser children reject missing or altered canonical Node options', () => {
  const workspace = path.join(os.tmpdir(), 'mcbot-check-js-canonical');
  for (const nodeOptions of [
    '',
    '--v8-pool-size=1',
    '--require="unexpected.cjs" --v8-pool-size=1',
  ]) {
    assert.throws(
      () => createBaselineSynchronousNodeChildEnvironment({ MCBOT_BASELINE: '1', NODE_OPTIONS: nodeOptions }, workspace),
      /canonical guarded Node options/,
    );
  }
});

test('non-baseline parser children preserve caller environment', () => {
  const source = { PATH: 'test-path', NODE_OPTIONS: '--trace-warnings' };
  const result = createBaselineSynchronousNodeChildEnvironment(source, 'ignored');
  assert.deepEqual(result, source);
  assert.notEqual(result, source);
});
