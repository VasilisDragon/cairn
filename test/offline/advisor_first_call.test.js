import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAdvisorFirstCallCaptureRunPlan,
  renderAdvisorFirstCallCaptureRun,
  sanitizeAdvisorFirstCallCaptureRunPublicReport,
} from '../../src/advisor/first_call_capture_run.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('collapsed advisor first-call dry plan stays no-api and points to the unified scripts', () => {
  const report = sanitizeAdvisorFirstCallCaptureRunPublicReport(buildAdvisorFirstCallCaptureRunPlan({}, {
    root: ROOT,
    responseDir: 'data/does-not-exist-advisor-first-call-responses',
    captureGuard: {
      ok: true,
      captureVisibility: {
        ignoredByGit: true,
        trackedCaptureFileCount: 0,
        visibleUntrackedCaptureFileCount: 0,
      },
      failures: [],
    },
  }));
  const markdown = renderAdvisorFirstCallCaptureRun({ ...report, title: 'Advisor First Call' });

  assert.equal(report.ok, true);
  assert.equal(report.noApiCall, true);
  assert.equal(report.status, 'capture_execution_not_requested');
  assert.equal(report.executeRequested, false);
  assert.equal(report.readyToExecute, false);
  assert.equal(report.requestCount, 1);
  assert.deepEqual(report.requestIds, ['recorded_live_smoke_observe']);
  assert.equal(report.commands.dryRunPlan, 'npm run advisor:first-call');
  assert.equal(report.commands.replay, 'npm run advisor:replay');
  assert.equal(report.commands.finalGuard, 'npm run advisor:response-capture-guard');
  assert.equal(report.runtimeRequestPayloadOmitted, true);
  assert.match(markdown, /# Advisor First Call/);
  assert.doesNotMatch(JSON.stringify(report) + markdown, /rawResponse|DEEPSEEK_API_KEY|sk-test-secret/);
});

test('collapsed advisor first-call CLI writes public reports without DeepSeek opt-in', () => {
  const env = {
    ...process.env,
    DEEPSEEK_API_KEY: 'sk-test-secret-value',
  };
  delete env.MCBOT_ALLOW_DEEPSEEK;

  const result = spawnSync(process.execPath, ['scripts/advisor-first-call.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /advisor-first-call: wrote/);

  const jsonPath = path.join(ROOT, 'reports', 'advisor-first-call.json');
  const mdPath = path.join(ROOT, 'reports', 'advisor-first-call.md');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const markdown = fs.readFileSync(mdPath, 'utf8');
  const serialized = JSON.stringify(json) + '\n' + markdown;

  assert.equal(json.noApiCall, true);
  assert.equal(json.executeRequested, false);
  assert.equal(json.readyToExecute, false);
  assert.equal(json.requestCount, 1);
  assert.match(markdown, /Advisor First Call/);
  assert.doesNotMatch(serialized, /sk-test-secret-value|DEEPSEEK_API_KEY|rawResponse/);
});

test('advisor F3 calibration CLI writes a no-api multi-response plan by default', () => {
  const responseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-f3-responses-'));
  const env = {
    ...process.env,
    MCBOT_ADVISOR_F3_RESPONSE_DIR: responseDir,
    DEEPSEEK_API_KEY: 'sk-test-secret-value',
  };
  delete env.MCBOT_ALLOW_DEEPSEEK;

  const result = spawnSync(process.execPath, ['scripts/advisor-f3-calibration.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /advisor-f3-calibration: wrote/);

  const jsonPath = path.join(ROOT, 'reports', 'advisor-f3-calibration.json');
  const replayPath = path.join(ROOT, 'reports', 'advisor-f3-replay.json');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
  const serialized = JSON.stringify(json) + '\n' + JSON.stringify(replay);

  assert.equal(json.noApiCall, true);
  assert.equal(json.executeRequested, false);
  assert.equal(json.profile, 'f3_five_response_calibration');
  assert.ok(json.requestCount >= 5);
  assert.equal(replay.noApiCall, true);
  assert.equal(replay.status, 'pending_model_responses');
  assert.ok(replay.expectedCount >= 5);
  assert.doesNotMatch(serialized, /sk-test-secret-value|DEEPSEEK_API_KEY|rawResponse/);
});
