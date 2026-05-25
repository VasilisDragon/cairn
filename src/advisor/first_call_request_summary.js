export function summarizeAdvisorFirstCallRequest(request = {}) {
  return sanitizeRequestSummary({
    id: request.id,
    source: request.source,
    category: request.category,
    calibration: request.calibration,
    expected: request.expected,
    promptChars: request.promptChars,
    estimatedPromptTokens: request.estimatedPromptTokens,
    requestFingerprint: request.requestFingerprint,
  });
}

export function normalizeAdvisorFirstCallRequestSummaries(requestSummaries, requestIds = []) {
  const summaries = Array.isArray(requestSummaries) ? requestSummaries : [];
  const byId = new Map();
  for (const summary of summaries) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary) || !summary.id) continue;
    byId.set(summary.id, sanitizeRequestSummary(summary));
  }
  const ids = Array.isArray(requestIds) && requestIds.length > 0
    ? requestIds
    : summaries.map((summary) => summary?.id).filter(Boolean);
  return ids.map((id) => byId.get(id) || sanitizeRequestSummary({ id }));
}

export function advisorFirstCallCalibrationTiers(requestSummaries = []) {
  return [...new Set((requestSummaries || [])
    .map((request) => String(request?.calibrationTier || '').trim())
    .filter(Boolean))];
}

export function formatAdvisorFirstCallRequestList(values = []) {
  return Array.isArray(values) && values.length > 0 ? values.join(', ') : 'none';
}

export function formatAdvisorFirstCallExpected(expected = {}) {
  if (!expected) return '';
  const pieces = [];
  if (expected.activationStatus) pieces.push(expected.activationStatus);
  if (Array.isArray(expected.planSkills) && expected.planSkills.length > 0) {
    pieces.push(`skills=${expected.planSkills.join('+')}`);
  }
  if (expected.planLength) pieces.push(`len=${expected.planLength}`);
  return pieces.join('; ');
}

export function shortAdvisorFirstCallFingerprint(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 12)}...` : text;
}

function sanitizeRequestSummary(summary = {}) {
  return {
    id: String(summary.id || ''),
    source: summary.source || null,
    category: summary.category || null,
    calibrationTier: summary.calibrationTier || summary.calibration?.tier || null,
    calibrationPurpose: summary.calibrationPurpose || summary.calibration?.purpose || null,
    expected: sanitizeExpected(summary.expected),
    promptChars: Number(summary.promptChars) || 0,
    estimatedPromptTokens: Number(summary.estimatedPromptTokens) || 0,
    requestFingerprint: summary.requestFingerprint || null,
  };
}

function sanitizeExpected(expected = {}) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null;
  return {
    stage: expected.stage || null,
    activationStatus: expected.activationStatus || null,
    planSkills: Array.isArray(expected.planSkills) ? expected.planSkills.map(String) : [],
    planLength: Number(expected.planLength) || 0,
  };
}
