export function deepseekConfigStatus(deepseek = {}) {
  const source = deepseek || {};
  const apiKeyConfigured = typeof source.apiKey === 'string' && source.apiKey.trim().length > 0;
  const baseUrl = normalizeNonEmptyString(source.baseUrl);
  const model = normalizeNonEmptyString(source.model);
  const reasons = [];

  if (!apiKeyConfigured) reasons.push('DEEPSEEK_API_KEY missing');
  if (!baseUrl) {
    reasons.push('DEEPSEEK_BASE_URL missing');
  } else if (!validHttpUrl(baseUrl)) {
    reasons.push('DEEPSEEK_BASE_URL invalid');
  }
  if (!model) reasons.push('DEEPSEEK_MODEL missing');

  return {
    ok: reasons.length === 0,
    apiKeyConfigured,
    baseUrl,
    model,
    reasons,
  };
}

export default deepseekConfigStatus;

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
