import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCostCeilingGuardReadyFields,
  buildChatCompletionRequest,
  deepseekConfigStatus,
  getAdvisorCostSnapshot,
  resetAdvisorCostForTests,
  summarizeChatCompletionResult,
} from '../../src/advisor/deepseek.js';

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
