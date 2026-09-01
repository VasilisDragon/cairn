// Thin wrapper around the OpenAI SDK pointed at the DeepSeek endpoint.
// One responsibility: take messages, return the assistant content string.

import OpenAI from 'openai';
import config from '../config.js';
import log from '../logger.js';
import { createAdvisorCostGuard } from './cost_guard.js';
import { deepseekConfigStatus as pureDeepseekConfigStatus } from './deepseek_config.js';

let client = null;
let defaultCostGuard = null;
let defaultCostGuardReadyLogged = false;

function getClient() {
  if (client) return client;
  const key = config.deepseek.apiKey;
  if (!key) throw new Error('DEEPSEEK_API_KEY missing (env var or keys.json)');
  client = new OpenAI({ apiKey: key, baseURL: config.deepseek.baseUrl });
  return client;
}

/**
 * Single chat completion. Strict JSON output is REQUIRED on the calling side —
 * we set response_format json_object and trust DeepSeek's structured-output mode.
 * Returns the raw string content of the assistant message.
 */
export async function complete(messages, opts = {}) {
  const result = await completeWithMetrics(messages, opts);
  return result.content;
}

/**
 * Single chat completion with redaction-safe metrics for calibration capture.
 * The content is still the exact assistant message; callers must keep it in a
 * private ignored capture file if it came from a real provider.
 */
export async function completeWithMetrics(messages, opts = {}) {
  const costGuard = opts.costGuard || getDefaultAdvisorCostGuard();
  const beforeCost = costGuard.beforeCall();
  if (!beforeCost.ok) {
    log.advisor.warn('llm.cost.refused', publicCostFields(beforeCost));
    throw new Error(beforeCost.reason);
  }

  const c = opts.client || getClient();
  const t0 = Date.now();
  const req = buildChatCompletionRequest(messages, opts);
  log.advisor.info('llm.request', { model: req.model, messages: messages.length, temp: req.temperature });
  let dispatched = false;
  let costAccounted = false;
  try {
    const requestOptions = {};
    if (opts.signal) requestOptions.signal = opts.signal;
    if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) requestOptions.timeout = opts.timeoutMs;
    dispatched = true;
    const resp = await c.chat.completions.create(req, requestOptions);
    const dt = Date.now() - t0;
    const result = summarizeChatCompletionResult(resp, {
      latencyMs: dt,
      model: req.model,
      source: opts.metricsSource || 'deepseek_chat_completion',
    });
    const cost = costGuard.recordCall(result.responseMetrics);
    costAccounted = true;
    result.responseMetrics = {
      ...result.responseMetrics,
      callCostUsd: cost.callCostUsd,
      sessionCostUsd: cost.sessionCostUsd,
      costCeilingUsd: cost.maxUsd,
      costCeilingRatio: cost.ratio,
      costCeilingStatus: cost.status,
      usageStatus: cost.usageStatus,
    };
    log.advisor.info('llm.response', {
      dtMs: dt,
      promptTokens: result.responseMetrics.promptTokens,
      completionTokens: result.responseMetrics.completionTokens,
      totalTokens: result.responseMetrics.totalTokens,
      callCostUsd: result.responseMetrics.callCostUsd,
      sessionCostUsd: result.responseMetrics.sessionCostUsd,
      costCeilingUsd: result.responseMetrics.costCeilingUsd,
      costCeilingStatus: result.responseMetrics.costCeilingStatus,
      usageStatus: result.responseMetrics.usageStatus,
      finishReason: publicFinishReason(resp.choices?.[0]?.finish_reason),
      chars: result.content.length,
    });
    logAdvisorCost(cost);
    return result;
  } catch (err) {
    const cost = dispatched && !costAccounted ? costGuard.recordCall({}) : null;
    log.advisor.error('llm.error', {
      dtMs: Date.now() - t0,
      err: 'provider_request_failed',
      ...(cost ? publicCostFields(cost) : {}),
    });
    if (cost) logAdvisorCost(cost);
    throw new Error('provider_request_failed');
  }
}

export function buildChatCompletionRequest(messages, opts = {}) {
  return {
    model: opts.model || config.deepseek.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    response_format: opts.responseFormatJson === false ? undefined : { type: 'json_object' },
    max_tokens: opts.maxTokens ?? 1024,
  };
}

export function deepseekConfigStatus(deepseek = config.deepseek) {
  return pureDeepseekConfigStatus(deepseek);
}

export function getAdvisorCostSnapshot() {
  return getDefaultAdvisorCostGuard().snapshot();
}

export function resetAdvisorCostForTests() {
  defaultCostGuard = null;
  defaultCostGuardReadyLogged = false;
}

export function summarizeChatCompletionResult(resp = {}, opts = {}) {
  const choice = Array.isArray(resp.choices) ? resp.choices[0] : null;
  const content = String(choice?.message?.content || '');
  const usage = resp.usage || {};
  const responseMetrics = {
    source: nonEmptyString(opts.source) || 'deepseek_chat_completion',
    provider: 'deepseek',
    model: nonEmptyString(opts.model) || nonEmptyString(resp.model) || 'unknown',
    ...(finiteNonNegative(opts.latencyMs) ? { latencyMs: Math.round(opts.latencyMs) } : {}),
    ...(finiteNonNegative(usage.prompt_tokens) ? { promptTokens: Math.round(usage.prompt_tokens) } : {}),
    ...(finiteNonNegative(usage.completion_tokens) ? { completionTokens: Math.round(usage.completion_tokens) } : {}),
    ...(finiteNonNegative(usage.total_tokens) ? { totalTokens: Math.round(usage.total_tokens) } : {}),
  };

  if (responseMetrics.totalTokens === undefined
    && responseMetrics.promptTokens !== undefined
    && responseMetrics.completionTokens !== undefined) {
    responseMetrics.totalTokens = responseMetrics.promptTokens + responseMetrics.completionTokens;
  }

  return {
    content,
    responseMetrics,
  };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function publicFinishReason(value) {
  return ['stop', 'length', 'content_filter', 'tool_calls', 'function_call']
    .includes(value) ? value : 'unknown';
}

function getDefaultAdvisorCostGuard() {
  if (!defaultCostGuard) {
    defaultCostGuard = createAdvisorCostGuard(config.advisor || {});
    defaultCostGuardReadyLogged = false;
  }
  if (!defaultCostGuardReadyLogged) {
    logCostCeilingGuardReady(defaultCostGuard.snapshot());
    defaultCostGuardReadyLogged = true;
  }
  return defaultCostGuard;
}

export function buildCostCeilingGuardReadyFields(snapshot = {}) {
  return {
    costCeilingGuard: {
      verified: true,
      ceilingUsd: snapshot.maxUsd,
      currentUsd: snapshot.sessionCostUsd ?? 0,
    },
    callCount: snapshot.callCount ?? 0,
    costCeilingStatus: snapshot.status || 'unknown',
  };
}

function logCostCeilingGuardReady(snapshot) {
  log.advisor.info('llm.costCeilingGuard', buildCostCeilingGuardReadyFields(snapshot));
}

function logAdvisorCost(cost) {
  const fields = publicCostFields(cost);
  if (cost.shouldLogoutAfterCurrentSkill) {
    log.advisor.error('llm.cost.hard-ceiling', fields);
  } else if (cost.refuseNewCalls) {
    log.advisor.warn('llm.cost.refuse-new-calls', fields);
  } else if (cost.preferLastValidatedPlan) {
    log.advisor.warn('llm.cost.prefer-last-plan', fields);
  } else {
    log.advisor.info('llm.cost', fields);
  }
}

function publicCostFields(cost) {
  return {
    callCount: cost.callCount,
    callCostUsd: cost.callCostUsd,
    sessionCostUsd: cost.sessionCostUsd,
    costCeilingUsd: cost.maxUsd,
    costCeilingRatio: cost.ratio,
    costCeilingStatus: cost.status,
    usageStatus: cost.usageStatus,
    preferLastValidatedPlan: cost.preferLastValidatedPlan,
    refuseNewCalls: cost.refuseNewCalls,
    shouldLogoutAfterCurrentSkill: cost.shouldLogoutAfterCurrentSkill,
    reason: cost.reason,
  };
}

export default {
  complete,
  completeWithMetrics,
  buildChatCompletionRequest,
  deepseekConfigStatus,
  getAdvisorCostSnapshot,
  resetAdvisorCostForTests,
  summarizeChatCompletionResult,
  buildCostCeilingGuardReadyFields,
};
