export const DEFAULT_DEEPSEEK_ALLOW_ENV = 'MCBOT_ALLOW_DEEPSEEK';
export const DEFAULT_LIVE_TESTS_ENV = 'MCBOT_LIVE_TESTS';

export function deepseekAdvisorRunGate(env = process.env, opts = {}) {
  const allowEnv = opts.allowEnv || DEFAULT_DEEPSEEK_ALLOW_ENV;
  const liveTestsEnv = opts.liveTestsEnv || DEFAULT_LIVE_TESTS_ENV;
  const requiresLiveTests = opts.requiresLiveTests === true;
  const entrypoint = opts.entrypoint || 'advisor';
  const reasons = [];

  if (env[allowEnv] !== '1') {
    reasons.push(`${allowEnv}=1 required to allow DeepSeek advisor calls`);
  }
  if (requiresLiveTests && env[liveTestsEnv] !== '1') {
    reasons.push(`${liveTestsEnv}=1 required for private/local live advisor calibration`);
  }

  return {
    ok: reasons.length === 0,
    entrypoint,
    requiresDeepSeek: true,
    requiresLiveTests,
    allowEnv,
    liveTestsEnv,
    reasons,
  };
}

export function formatDeepseekAdvisorRunGate(status) {
  if (status?.ok) {
    return `DeepSeek advisor entrypoint "${status.entrypoint || 'advisor'}" explicitly enabled`;
  }
  const entrypoint = status?.entrypoint || 'advisor';
  const reasons = Array.isArray(status?.reasons) && status.reasons.length > 0
    ? status.reasons.join('; ')
    : 'missing explicit DeepSeek advisor opt-in';
  return `refusing "${entrypoint}" because it can call DeepSeek: ${reasons}`;
}
