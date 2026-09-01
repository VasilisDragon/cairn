import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCostCeilingGuardReadyFields,
  buildChatCompletionRequest,
  completeWithMetrics,
  deepseekConfigStatus,
  getAdvisorCostSnapshot,
  resetAdvisorCostForTests,
  summarizeChatCompletionResult,
} from '../../src/advisor/deepseek.js';
import { createAdvisorCostGuard } from '../../src/advisor/cost_guard.js';

test('DeepSeek request builder keeps strict JSON response format by default', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '{"goal":"observe"}' },
  ];

  const request = buildChatCompletionRequest(messages, {
    model: 'deepseek-test-model',
    temperature: 0,
    maxTokens: 321,
  });

  assert.equal(request.model, 'deepseek-test-model');
  assert.equal(request.messages, messages);
  assert.equal(request.temperature, 0);
  assert.equal(request.max_tokens, 321);
  assert.deepEqual(request.response_format, { type: 'json_object' });
});

test('DeepSeek request builder can explicitly disable json_object format for diagnostics', () => {
  const request = buildChatCompletionRequest([{ role: 'user', content: 'hello' }], {
    model: 'diagnostic-model',
    responseFormatJson: false,
  });

  assert.equal(request.model, 'diagnostic-model');
  assert.equal(request.response_format, undefined);
  assert.equal(request.max_tokens, 1024);
});

test('DeepSeek config status reports readiness without exposing secrets', () => {
  const status = deepseekConfigStatus({
    apiKey: 'super-secret-token',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-test-model',
  });

  assert.deepEqual(status, {
    ok: true,
    apiKeyConfigured: true,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-test-model',
    reasons: [],
  });
  assert.doesNotMatch(JSON.stringify(status), /super-secret-token/);
});

test('DeepSeek config status fails closed on missing or invalid fields', () => {
  assert.deepEqual(deepseekConfigStatus({}), {
    ok: false,
    apiKeyConfigured: false,
    baseUrl: null,
    model: null,
    reasons: [
      'DEEPSEEK_API_KEY missing',
      'DEEPSEEK_BASE_URL missing',
      'DEEPSEEK_MODEL missing',
    ],
  });

  assert.deepEqual(deepseekConfigStatus({
    apiKey: 'key',
    baseUrl: 'ftp://api.deepseek.com',
    model: 'deepseek-test-model',
  }), {
    ok: false,
    apiKeyConfigured: true,
    baseUrl: 'ftp://api.deepseek.com',
    model: 'deepseek-test-model',
    reasons: ['DEEPSEEK_BASE_URL invalid'],
  });
});

test('DeepSeek chat completion result summary keeps content separate from metrics', () => {
  const result = summarizeChatCompletionResult({
    model: 'deepseek-test-model',
    choices: [{
      finish_reason: 'stop',
      message: { content: '{"plan":[{"skill":"observe","params":{}}]}' },
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  }, {
    source: 'first_gated_deepseek_call',
    latencyMs: 123.4,
  });

  assert.equal(result.content, '{"plan":[{"skill":"observe","params":{}}]}');
  assert.deepEqual(result.responseMetrics, {
    source: 'first_gated_deepseek_call',
    provider: 'deepseek',
    model: 'deepseek-test-model',
    latencyMs: 123,
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
  });
});

test('DeepSeek cost guard emits a session-start verification event shape', () => {
  assert.deepEqual(buildCostCeilingGuardReadyFields({
    callCount: 0,
    sessionCostUsd: 0,
    maxUsd: 2,
    status: 'normal',
  }), {
    costCeilingGuard: {
      verified: true,
      ceilingUsd: 2,
      currentUsd: 0,
    },
    callCount: 0,
    costCeilingStatus: 'normal',
  });
});

test('DeepSeek default cost guard logs verification when initialized', () => {
  resetAdvisorCostForTests();
  const { records, value } = captureStdoutRecords(() => getAdvisorCostSnapshot());

  assert.equal(value.callCount, 0);
  const ready = records.find((record) => record.evt === 'llm.costCeilingGuard');
  assert.ok(ready);
  assert.deepEqual(ready.costCeilingGuard, {
    verified: true,
    ceilingUsd: 2,
    currentUsd: 0,
  });
});

test('DeepSeek conservatively charges a dispatched provider error and blocks the next call', async () => {
  const guard = createAdvisorCostGuard({ costUsdMax: 2 });
  const privateSentinel = 'synthetic provider error detail';
  let dispatches = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          dispatches += 1;
          throw new Error(privateSentinel);
        },
      },
    },
  };

  const captured = await captureProcessWrites(async () => {
    try {
      await completeWithMetrics([{ role: 'user', content: '{}' }], { client, costGuard: guard });
      return null;
    } catch (error) {
      return error;
    }
  });
  assert.equal(captured.value?.message, 'provider_request_failed');
  assert.match(captured.stderr, /"err":"provider_request_failed"/);
  assert.equal(`${captured.stdout}\n${captured.stderr}\n${captured.value?.stack}`.includes(privateSentinel), false);
  assert.equal(dispatches, 1);
  assert.deepEqual(guard.snapshot(), {
    callCount: 1,
    sessionCostUsd: 2,
    maxUsd: 2,
    ratio: 1,
    status: 'hard_logout',
    preferLastValidatedPlan: true,
    refuseNewCalls: true,
    shouldLogoutAfterCurrentSkill: true,
  });

  await assert.rejects(
    completeWithMetrics([{ role: 'user', content: '{}' }], { client, costGuard: guard }),
    /cost ceiling exhausted/,
  );
  assert.equal(dispatches, 1);
});

test('DeepSeek logs only an allowlisted provider finish reason', async () => {
  const guard = createAdvisorCostGuard({ costUsdMax: 2 });
  const privateSentinel = 'sk-provider-finish-reason-sentinel';
  const client = {
    chat: {
      completions: {
        create: async () => ({
          model: 'deepseek-test-model',
          choices: [{
            finish_reason: privateSentinel,
            message: { content: '{}' },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      },
    },
  };

  const captured = await captureProcessWrites(() => completeWithMetrics(
    [{ role: 'user', content: '{}' }],
    { client, costGuard: guard, model: 'deepseek-test-model' },
  ));
  assert.equal(captured.value.content, '{}');
  assert.equal(`${captured.stdout}\n${captured.stderr}`.includes(privateSentinel), false);
  assert.match(captured.stdout, /"finishReason":"unknown"/);
});

function captureStdoutRecords(fn) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = function write(chunk, encoding, callback) {
    chunks.push(String(chunk));
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (typeof cb === 'function') cb();
    return true;
  };
  try {
    const value = fn();
    const records = chunks
      .join('')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { records, value };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function captureProcessWrites(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdout = [];
  const stderr = [];
  process.stdout.write = captureInto(stdout);
  process.stderr.write = captureInto(stderr);
  try {
    return {
      value: await fn(),
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function captureInto(chunks) {
  return function write(chunk, encoding, callback) {
    chunks.push(String(chunk));
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (typeof cb === 'function') cb();
    return true;
  };
}
