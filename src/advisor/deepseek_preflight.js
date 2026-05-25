import { deepseekConfigStatus } from './deepseek_config.js';
import { deepseekAdvisorRunGate } from './deepseek_run_gate.js';

export function deepseekEnvConfig(env = process.env) {
  return {
    apiKey: env.DEEPSEEK_API_KEY || null,
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  };
}

export function deepseekPreflight(env = process.env, opts = {}) {
  const entrypoint = opts.entrypoint || 'main';
  const requiresLiveTests = opts.requiresLiveTests === true;
  const gate = deepseekAdvisorRunGate(env, { entrypoint, requiresLiveTests });
  const config = deepseekConfigStatus(deepseekEnvConfig(env));
  const reasons = [...gate.reasons, ...config.reasons];

  return {
    ok: gate.ok && config.ok,
    entrypoint,
    noApiCall: true,
    configSource: 'environment/defaults only',
    gate,
    config,
    reasons,
  };
}

export function formatDeepseekPreflight(status) {
  const lines = [
    `DeepSeek preflight for "${status.entrypoint || 'main'}": ${status.ok ? 'READY' : 'NOT READY'}`,
    `- no API call made: ${status.noApiCall === true ? 'yes' : 'unknown'}`,
    `- config source: ${status.configSource || 'unknown'}`,
    `- opt-in gate: ${status.gate?.ok ? 'allowed' : 'blocked'}`,
    `- API key: ${status.config?.apiKeyConfigured ? 'configured' : 'missing'}`,
    `- base URL: ${status.config?.baseUrl || 'missing/invalid'}`,
    `- model: ${status.config?.model || 'missing'}`,
  ];
  const reasons = Array.isArray(status.reasons) ? status.reasons : [];
  if (reasons.length > 0) lines.push(`- reasons: ${reasons.join('; ')}`);
  return lines.join('\n');
}

export default {
  deepseekEnvConfig,
  deepseekPreflight,
  formatDeepseekPreflight,
};
