import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deepseekEnvConfig,
  deepseekPreflight,
  formatDeepseekPreflight,
} from '../../src/advisor/deepseek_preflight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('DeepSeek env config uses safe defaults without reading config files', () => {
  assert.deepEqual(deepseekEnvConfig({}), {
    apiKey: null,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
  });
});

test('DeepSeek preflight fails closed without opt-in or API key', () => {
  const status = deepseekPreflight({}, { entrypoint: 'main' });

  assert.equal(status.ok, false);
  assert.equal(status.noApiCall, true);
  assert.equal(status.configSource, 'environment/defaults only');
  assert.equal(status.gate.ok, false);
  assert.equal(status.config.ok, false);
  assert.deepEqual(status.reasons, [
    'MCBOT_ALLOW_DEEPSEEK=1 required to allow DeepSeek advisor calls',
    'DEEPSEEK_API_KEY missing',
  ]);

  const text = formatDeepseekPreflight(status);
  assert.match(text, /NOT READY/);
  assert.match(text, /no API call made: yes/);
  assert.match(text, /API key: missing/);
});

test('DeepSeek preflight reports readiness without echoing secret values', () => {
  const env = {
    MCBOT_ALLOW_DEEPSEEK: '1',
    DEEPSEEK_API_KEY: 'sk-test-secret-value',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: 'deepseek-test-model',
  };
  const status = deepseekPreflight(env, { entrypoint: 'main' });

  assert.equal(status.ok, true);
  assert.equal(status.config.apiKeyConfigured, true);
  assert.deepEqual(status.reasons, []);

  const serialized = JSON.stringify(status) + '\n' + formatDeepseekPreflight(status);
  assert.doesNotMatch(serialized, /sk-test-secret-value/);
  assert.match(serialized, /deepseek-test-model/);
});

test('DeepSeek preflight live mode requires live-test opt-in too', () => {
  const status = deepseekPreflight({
    MCBOT_ALLOW_DEEPSEEK: '1',
    DEEPSEEK_API_KEY: 'sk-test-secret-value',
  }, { entrypoint: 'phase3_calibration', requiresLiveTests: true });

  assert.equal(status.ok, false);
  assert.deepEqual(status.reasons, [
    'MCBOT_LIVE_TESTS=1 required for private/local live advisor calibration',
  ]);
});

test('DeepSeek preflight CLI exits nonzero without defaults and does not echo secret values', () => {
  const env = { ...process.env };
  delete env.MCBOT_ALLOW_DEEPSEEK;
  delete env.MCBOT_LIVE_TESTS;
  delete env.DEEPSEEK_API_KEY;
  const result = spawnSync(process.execPath, ['scripts/deepseek-preflight.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /DeepSeek preflight for "main": NOT READY/);
  assert.match(result.stdout, /MCBOT_ALLOW_DEEPSEEK=1 required/);
  assert.match(result.stdout, /DEEPSEEK_API_KEY missing/);
});

test('DeepSeek preflight CLI exits zero when env-only readiness is satisfied', () => {
  const env = {
    ...process.env,
    MCBOT_ALLOW_DEEPSEEK: '1',
    DEEPSEEK_API_KEY: 'sk-cli-secret-value',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: 'deepseek-test-model',
  };
  const result = spawnSync(process.execPath, [
    'scripts/deepseek-preflight.js',
    '--entrypoint',
    'main',
  ], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /DeepSeek preflight for "main": READY/);
  assert.match(result.stdout, /API key: configured/);
  assert.match(result.stdout, /deepseek-test-model/);
  assert.doesNotMatch(result.stdout, /sk-cli-secret-value/);
});
