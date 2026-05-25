import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deepseekAdvisorRunGate,
  formatDeepseekAdvisorRunGate,
} from '../../src/advisor/deepseek_run_gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('DeepSeek advisor run gate fails closed without explicit opt-in', () => {
  const status = deepseekAdvisorRunGate({}, { entrypoint: 'phase3_calibration' });

  assert.equal(status.ok, false);
  assert.equal(status.requiresDeepSeek, true);
  assert.equal(status.requiresLiveTests, false);
  assert.deepEqual(status.reasons, [
    'MCBOT_ALLOW_DEEPSEEK=1 required to allow DeepSeek advisor calls',
  ]);
  assert.match(
    formatDeepseekAdvisorRunGate(status),
    /refusing "phase3_calibration" because it can call DeepSeek/,
  );
});

test('DeepSeek advisor run gate can require private live-test opt-in too', () => {
  const missingLive = deepseekAdvisorRunGate(
    { MCBOT_ALLOW_DEEPSEEK: '1' },
    { entrypoint: 'phase3_calibration', requiresLiveTests: true },
  );

  assert.equal(missingLive.ok, false);
  assert.deepEqual(missingLive.reasons, [
    'MCBOT_LIVE_TESTS=1 required for private/local live advisor calibration',
  ]);

  const allowed = deepseekAdvisorRunGate(
    { MCBOT_ALLOW_DEEPSEEK: '1', MCBOT_LIVE_TESTS: '1' },
    { entrypoint: 'phase3_calibration', requiresLiveTests: true },
  );

  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.reasons, []);
  assert.equal(
    formatDeepseekAdvisorRunGate(allowed),
    'DeepSeek advisor entrypoint "phase3_calibration" explicitly enabled',
  );
});

test('DeepSeek advisor run gate status does not echo environment values', () => {
  const status = deepseekAdvisorRunGate(
    {
      MCBOT_ALLOW_DEEPSEEK: 'not-a-secret-but-do-not-echo',
      MCBOT_LIVE_TESTS: 'also-not-echoed',
    },
    { entrypoint: 'phase3_calibration', requiresLiveTests: true },
  );

  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /not-a-secret-but-do-not-echo/);
  assert.doesNotMatch(serialized, /also-not-echoed/);
});

test('phase3 calibration entrypoint safe-stops before live advisor imports by default', () => {
  const env = { ...process.env };
  delete env.MCBOT_ALLOW_DEEPSEEK;
  delete env.MCBOT_LIVE_TESTS;
  delete env.DEEPSEEK_API_KEY;
  const result = spawnSync(process.execPath, ['test/phase3_calibration.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /refusing "phase3_calibration" because it can call DeepSeek/);
  assert.match(result.stderr, /MCBOT_ALLOW_DEEPSEEK=1 required to allow DeepSeek advisor calls/);
  assert.match(result.stderr, /MCBOT_LIVE_TESTS=1 required for private\/local live advisor calibration/);
  assert.doesNotMatch(result.stderr, /DEEPSEEK_API_KEY/);
});

test('main goal entrypoint safe-stops before bot startup by default', () => {
  const env = { ...process.env };
  delete env.MCBOT_ALLOW_DEEPSEEK;
  delete env.MCBOT_LIVE_TESTS;
  delete env.DEEPSEEK_API_KEY;
  const result = spawnSync(process.execPath, ['src/index.js', 'gather 10 oak logs'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /refusing "main" because it can call DeepSeek/);
  assert.match(result.stderr, /MCBOT_ALLOW_DEEPSEEK=1 required to allow DeepSeek advisor calls/);
  assert.doesNotMatch(result.stderr, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(result.stderr, /main\.spawned/);
});
