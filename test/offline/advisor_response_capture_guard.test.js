import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS,
  evaluateAdvisorResponseCaptureGuard,
  renderAdvisorResponseCaptureGuard,
} from '../../src/advisor/response_capture_guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('advisor response capture guard passes for ignored capture dir and clean reports', () => {
  const root = path.join('tmp', 'guard-root');
  const files = reportFiles(root, {
    'reports/template.json': { responses: [{ id: 'a', rawResponse: '' }] },
    'reports/replay.json': { ok: true, results: [{ id: 'a' }] },
  });

  const report = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [
      { path: 'reports/template.json', allowEmptyResponseFields: true },
      { path: 'reports/replay.json' },
    ],
    readFile: (filePath) => files.get(path.resolve(filePath)),
    exists: (filePath) => files.has(path.resolve(filePath)),
  });
  const markdown = renderAdvisorResponseCaptureGuard(report);

  assert.equal(report.ok, true);
  assert.equal(report.noApiCall, true);
  assert.equal(report.status, 'private_capture_guard_passed');
  assert.equal(report.captureVisibility.ignoredByGit, true);
  assert.equal(report.reports[0].responseFieldCount, 1);
  assert.equal(report.reports[0].nonEmptyResponseFieldCount, 0);
  assert.match(markdown, /private_capture_guard_passed/);
});

test('advisor response capture guard default report set tracks the collapsed first-call surface and public markdown reports', () => {
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/advisor-dry-run.json',
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/advisor-first-call.json',
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/advisor-first-call-replay.json',
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/advisor-f3-calibration.json' && entry.optional === true,
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/advisor-f3-replay.json' && entry.optional === true,
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/capability-matrix.json',
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/phase-shift-readiness.json',
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/advisor-first-call.md' && entry.format === 'text',
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/advisor-f3-calibration.md' && entry.format === 'text' && entry.optional === true,
  ));
  assert.ok(DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS.some(
    (entry) => entry.path === 'reports/phase-shift-readiness.md' && entry.format === 'text',
  ));
});

test('advisor response capture guard fails when capture dir is git-visible', () => {
  const root = path.join('tmp', 'guard-root');
  const files = reportFiles(root, {
    'reports/replay.json': { ok: true },
  });
  const report = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({
      ignored: false,
      tracked: 'data/advisor-first-call-responses/responses.json\n',
      untracked: 'data/advisor-first-call-responses/new.json\n',
    }),
    reportChecks: [{ path: 'reports/replay.json' }],
    readFile: (filePath) => files.get(path.resolve(filePath)),
    exists: (filePath) => files.has(path.resolve(filePath)),
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'blocked');
  assert.equal(report.captureVisibility.ignoredByGit, false);
  assert.equal(report.captureVisibility.trackedCaptureFileCount, 1);
  assert.equal(report.captureVisibility.visibleUntrackedCaptureFileCount, 1);
  assert.ok(report.failures.some((failure) => failure.includes('not ignored by git')));
  assert.ok(report.failures.some((failure) => failure.includes('tracked capture file')));
  assert.ok(report.failures.some((failure) => failure.includes('visible untracked capture file')));
});

test('advisor response capture guard rejects forbidden public report secret text without echoing it', () => {
  const root = path.join('tmp', 'guard-root');
  const files = reportFiles(root, {
    'reports/handoff.json': {
      ok: true,
      note: 'operator should configure external key sk-test-secret-value elsewhere',
    },
  });

  const report = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [{ path: 'reports/handoff.json' }],
    readFile: (filePath) => files.get(path.resolve(filePath)),
    exists: (filePath) => files.has(path.resolve(filePath)),
  });
  const serialized = JSON.stringify(report) + '\n' + renderAdvisorResponseCaptureGuard(report);

  assert.equal(report.ok, false);
  assert.equal(report.reports[0].forbiddenTextMatches.length, 1);
  assert.ok(report.failures.some((failure) => failure.includes('possible_provider_secret_token')));
  assert.doesNotMatch(serialized, /sk-test-secret-value/);
});

test('advisor response capture guard rejects raw first-call prompt payloads in generated reports without echoing them', () => {
  const root = path.join('tmp', 'guard-root');
  const files = reportFiles(root, {
    'reports/capture-run.json': {
      ok: true,
      requests: [{
        id: 'recorded_live_smoke_observe',
        request: {
          messages: [
            { role: 'system', content: 'You are the advisor for a Minecraft bot.' },
            { role: 'user', content: '{"advisorContract":{},"currentState":{},"request":"Produce the initial plan."}' },
          ],
        },
      }],
    },
  });

  const report = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [{ path: 'reports/capture-run.json' }],
    readFile: (filePath) => files.get(path.resolve(filePath)),
    exists: (filePath) => files.has(path.resolve(filePath)),
  });
  const serialized = JSON.stringify(report) + '\n' + renderAdvisorResponseCaptureGuard(report);

  assert.equal(report.ok, false);
  assert.equal(report.reports[0].forbiddenTextMatches.length, 2);
  assert.ok(report.failures.some((failure) => failure.includes('raw_first_call_request_messages')));
  assert.ok(report.failures.some((failure) => failure.includes('raw_first_call_prompt_payload')));
  assert.doesNotMatch(serialized, /advisorContract/);
  assert.doesNotMatch(serialized, /currentState/);
  assert.doesNotMatch(serialized, /Produce the initial plan/);
});

test('advisor response capture guard scans markdown reports without parsing them as JSON', () => {
  const root = path.join('tmp', 'guard-root');
  const files = reportFiles(root, {
    'reports/handoff.md': '# Handoff\n\nThis public report accidentally contains a raw request key: "messages": []\n',
  });

  const report = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [{ path: 'reports/handoff.md', format: 'text' }],
    readFile: (filePath) => files.get(path.resolve(filePath)),
    exists: (filePath) => files.has(path.resolve(filePath)),
  });
  const serialized = JSON.stringify(report) + '\n' + renderAdvisorResponseCaptureGuard(report);

  assert.equal(report.ok, false);
  assert.equal(report.reports[0].format, 'text');
  assert.equal(report.reports[0].status, 'blocked');
  assert.ok(report.failures.some((failure) => failure.includes('raw_first_call_request_messages')));
  assert.doesNotMatch(serialized, /"messages": \[\]/);
});

test('advisor response capture guard rejects captured model text in generated reports without echoing it', () => {
  const root = path.join('tmp', 'guard-root');
  const secretResponse = '{"plan":[{"skill":"observe","params":{}}],"secret":"sk-test-secret-value"}';
  const files = reportFiles(root, {
    'reports/replay.json': { rawResponse: secretResponse },
  });

  const report = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [{ path: 'reports/replay.json' }],
    readFile: (filePath) => files.get(path.resolve(filePath)),
    exists: (filePath) => files.has(path.resolve(filePath)),
  });
  const serialized = JSON.stringify(report) + '\n' + renderAdvisorResponseCaptureGuard(report);

  assert.equal(report.ok, false);
  assert.equal(report.reports[0].responseFieldCount, 1);
  assert.equal(report.reports[0].nonEmptyResponseFieldCount, 1);
  assert.ok(report.failures.some((failure) => failure.includes('non-empty captured response field')));
  assert.doesNotMatch(serialized, /sk-test-secret-value/);
  assert.doesNotMatch(serialized, /\\"plan\\"/);
});

test('advisor response capture guard rejects provider-shaped response payloads without echoing them', () => {
  const root = path.join('tmp', 'guard-root');
  const files = reportFiles(root, {
    'reports/capture-run.json': {
      ok: true,
      accidentalProviderResponse: {
        id: 'chatcmpl-private',
        model: 'deepseek-test-model',
        choices: [{
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"plan":[{"skill":"observe","params":{}}]}',
          },
        }],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
        },
      },
    },
  });

  const report = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [{ path: 'reports/capture-run.json' }],
    readFile: (filePath) => files.get(path.resolve(filePath)),
    exists: (filePath) => files.has(path.resolve(filePath)),
  });
  const serialized = JSON.stringify(report) + '\n' + renderAdvisorResponseCaptureGuard(report);

  assert.equal(report.ok, false);
  assert.equal(report.reports[0].providerPayloadCount, 1);
  assert.ok(report.failures.some((failure) => failure.includes('provider-shaped response payload')));
  assert.match(serialized, /Provider payloads/);
  assert.doesNotMatch(serialized, /chatcmpl-private/);
  assert.doesNotMatch(serialized, /\\"plan\\"/);
  assert.doesNotMatch(serialized, /deepseek-test-model/);
});

test('advisor response capture guard allows empty template placeholders but not populated ones', () => {
  const root = path.join('tmp', 'guard-root');
  const emptyTemplate = reportFiles(root, {
    'reports/template.json': { responses: [{ id: 'a', rawResponse: '' }] },
  });
  const clean = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [{ path: 'reports/template.json', allowEmptyResponseFields: true }],
    readFile: (filePath) => emptyTemplate.get(path.resolve(filePath)),
    exists: (filePath) => emptyTemplate.has(path.resolve(filePath)),
  });

  assert.equal(clean.ok, true);

  const populatedTemplate = reportFiles(root, {
    'reports/template.json': { responses: [{ id: 'a', rawResponse: '{"plan":[]}' }] },
  });
  const blocked = evaluateAdvisorResponseCaptureGuard({
    root,
    gitRunner: makeGitRunner({ ignored: true }),
    reportChecks: [{ path: 'reports/template.json', allowEmptyResponseFields: true }],
    readFile: (filePath) => populatedTemplate.get(path.resolve(filePath)),
    exists: (filePath) => populatedTemplate.has(path.resolve(filePath)),
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.reports[0].nonEmptyResponseFieldCount, 1);
});

test('advisor response capture guard CLI writes no-secret report without DeepSeek opt-in', () => {
  const env = {
    ...process.env,
    DEEPSEEK_API_KEY: 'sk-test-secret-value',
  };
  delete env.MCBOT_ALLOW_DEEPSEEK;

  const dryRun = spawnSync(process.execPath, ['scripts/advisor-dry-run.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(dryRun.status, 0);
  assert.equal(dryRun.stderr, '');

  const firstCall = spawnSync(process.execPath, ['scripts/advisor-first-call.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(firstCall.status, 0);
  assert.equal(firstCall.stderr, '');

  const replay = spawnSync(process.execPath, ['scripts/advisor-first-call-replay.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(replay.status, 0);
  assert.equal(replay.stderr, '');

  const capabilityMatrix = spawnSync(process.execPath, ['scripts/capability-matrix.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(capabilityMatrix.status, 0);
  assert.equal(capabilityMatrix.stderr, '');

  const result = spawnSync(process.execPath, ['scripts/advisor-response-capture-guard.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /advisor-response-capture-guard: wrote/);

  const jsonPath = path.join(ROOT, 'reports', 'advisor-response-capture-guard.json');
  const mdPath = path.join(ROOT, 'reports', 'advisor-response-capture-guard.md');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const markdown = fs.readFileSync(mdPath, 'utf8');
  const serialized = JSON.stringify(json) + '\n' + markdown;

  assert.equal(json.ok, true);
  assert.equal(json.noApiCall, true);
  assert.equal(json.captureVisibility.ignoredByGit, true);
  assert.ok(json.reports.some((entry) => entry.path === 'reports/advisor-dry-run.json' && entry.status === 'passed'));
  assert.ok(json.reports.some((entry) => entry.path === 'reports/advisor-first-call.json' && entry.status === 'passed'));
  assert.ok(json.reports.some((entry) => entry.path === 'reports/advisor-first-call.md' && entry.format === 'text' && entry.status === 'passed'));
  assert.ok(json.reports.some((entry) => entry.path === 'reports/advisor-first-call-replay.json' && entry.status === 'passed'));
  assert.ok(json.reports.some((entry) => entry.path === 'reports/capability-matrix.json' && entry.status === 'passed'));
  assert.ok(json.reports.some((entry) =>
    entry.path === 'reports/phase-shift-readiness.json'
    && (entry.status === 'passed' || entry.status === 'missing_optional')));
  assert.ok(json.reports.some((entry) =>
    entry.path === 'reports/phase-shift-readiness.md'
    && entry.format === 'text'
    && (entry.status === 'passed' || entry.status === 'missing_optional')));
  assert.match(markdown, /Advisor Response Capture Guard/);
  assert.doesNotMatch(serialized, /sk-test-secret-value/);
  assert.doesNotMatch(serialized, /DEEPSEEK_API_KEY/);
});

function reportFiles(root, files) {
  return new Map(Object.entries(files).map(([relativePath, value]) => [
    path.resolve(root, relativePath),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  ]));
}

function makeGitRunner({
  ignored,
  tracked = '',
  untracked = '',
}) {
  return (args) => {
    if (args[0] === 'check-ignore') return { status: ignored ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'ls-files' && args.includes('--others')) return { status: 0, stdout: untracked, stderr: '' };
    if (args[0] === 'ls-files') return { status: 0, stdout: tracked, stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected git args ${args.join(' ')}` };
  };
}
