import {
  DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR,
  buildAdvisorFirstCallRequestPack,
  loadAdvisorFirstCallResponses,
} from './dry_run_calibration.js';

export const ADVISOR_FIRST_CALL_RESPONSE_INTAKE_STRICT_ENV = 'MCBOT_ADVISOR_FIRST_CALL_INTAKE_REQUIRE_COMPLETE=1';

export function buildAdvisorFirstCallResponseIntake(fixtures = undefined, opts = {}) {
  const responseDir = opts.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
  const requestPack = buildAdvisorFirstCallRequestPack(fixtures, opts);
  const expectedIds = (requestPack.requests || []).map((request) => request.id);
  const expectedIdSet = new Set(expectedIds);
  const requestById = new Map((requestPack.requests || []).map((request) => [request.id, request]));
  const requireComplete = opts.requireComplete === true;
  const responseLoad = loadResponses(responseDir, opts);
  const responses = responseLoad.responses || [];
  const responseById = new Map();
  const duplicateIds = [];
  const unknownIds = [];

  for (const response of responses) {
    if (!expectedIdSet.has(response.id)) {
      unknownIds.push(response.id);
      continue;
    }
    if (responseById.has(response.id)) {
      duplicateIds.push(response.id);
      continue;
    }
    responseById.set(response.id, response);
  }

  const results = expectedIds.map((id) => {
    const response = responseById.get(id);
    const request = requestById.get(id);
    if (!response) {
      return {
        id,
        status: 'missing',
        source: null,
        responseChars: 0,
        hasContent: false,
        hasMetrics: false,
        requestFingerprintStatus: 'missing_response',
      };
    }
    const responseText = String(response.rawResponse || '');
    const requestFingerprintStatus = requestFingerprintMatch(response.requestFingerprint, request?.requestFingerprint);
    return {
      id,
      status: responseText.trim() ? 'present' : 'empty',
      source: response.source,
      responseChars: responseText.length,
      hasContent: responseText.trim().length > 0,
      hasMetrics: !!response.responseMetrics,
      hasRequestFingerprint: typeof response.requestFingerprint === 'string',
      requestFingerprintStatus,
      metricsFields: response.responseMetrics ? Object.keys(response.responseMetrics).sort() : [],
    };
  });
  const missing = results.filter((result) => result.status === 'missing');
  const empty = results.filter((result) => result.status === 'empty');
  const present = results.filter((result) => result.status === 'present');
  const fingerprintFailures = results
    .filter((result) => result.status === 'present' || result.status === 'empty')
    .filter((result) => result.requestFingerprintStatus !== 'matched');
  const hardFailures = [
    ...(responseLoad.error ? [`response load failed: ${responseLoad.error}`] : []),
    ...unknownIds.map((id) => `unknown response id ${id}`),
    ...duplicateIds.map((id) => `duplicate response id ${id}`),
    ...fingerprintFailures.map((result) => `${result.id} request fingerprint ${result.requestFingerprintStatus}`),
    ...empty.map((result) => `${result.id} response is empty`),
    ...(requireComplete ? missing.map((result) => `${result.id} response missing`) : []),
  ];
  const complete = missing.length === 0 && empty.length === 0;
  const readyForStrictReplay = requestPack.ok === true
    && complete
    && hardFailures.length === 0
    && unknownIds.length === 0
    && duplicateIds.length === 0;
  const ok = requestPack.ok === true
    && hardFailures.length === 0
    && (!requireComplete || readyForStrictReplay);
  const status = hardFailures.length > 0
    ? 'blocked'
    : readyForStrictReplay
      ? 'ready_for_strict_replay'
      : 'pending_model_responses';

  return {
    ok,
    noApiCall: true,
    status,
    generatedFrom: 'advisor first-call response intake preflight',
    responseDir,
    requireComplete,
    strictEnv: ADVISOR_FIRST_CALL_RESPONSE_INTAKE_STRICT_ENV,
    requestPackStatus: requestPack.status,
    expectedCount: expectedIds.length,
    responseDocumentCount: responses.length,
    presentCount: present.length,
    missingCount: missing.length,
    emptyCount: empty.length,
    unknownCount: unknownIds.length,
    duplicateCount: duplicateIds.length,
    requestFingerprintReadyCount: results.filter((result) => result.requestFingerprintStatus === 'matched').length,
    requestFingerprintFailureCount: fingerprintFailures.length,
    readyForStrictReplay,
    responseSources: responseLoad.sources,
    unknownIds,
    duplicateIds,
    failures: hardFailures,
    results,
    nextAction: readyForStrictReplay
      ? 'run_strict_first_call_replay'
      : 'capture_missing_first_call_model_responses',
  };
}

export function renderAdvisorFirstCallResponseIntake(report) {
  const lines = [
    '# Advisor First-Call Response Intake',
    '',
    `- no API call made: ${report.noApiCall === true ? 'yes' : 'unknown'}`,
    `- status: ${report.status || 'unknown'}`,
    `- response dir: ${report.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR}`,
    `- require complete responses: ${report.requireComplete ? 'yes' : 'no'}`,
    `- strict env: ${report.strictEnv || ADVISOR_FIRST_CALL_RESPONSE_INTAKE_STRICT_ENV}`,
    `- expected responses: ${report.expectedCount || 0}`,
    `- response documents: ${report.responseDocumentCount || 0}`,
    `- present responses: ${report.presentCount || 0}`,
    `- missing responses: ${report.missingCount || 0}`,
    `- empty responses: ${report.emptyCount || 0}`,
    `- unknown responses: ${report.unknownCount || 0}`,
    `- duplicate responses: ${report.duplicateCount || 0}`,
    `- request fingerprints matched: ${report.requestFingerprintReadyCount || 0}/${report.responseDocumentCount || 0}`,
    `- request fingerprint failures: ${report.requestFingerprintFailureCount || 0}`,
    `- ready for strict replay: ${report.readyForStrictReplay ? 'yes' : 'no'}`,
    `- next action: ${report.nextAction || 'unknown'}`,
    `- response sources: ${formatSources(report.responseSources)}`,
    '',
    '| Candidate | Status | Source | Response chars | Fingerprint | Metrics |',
    '| --- | --- | --- | ---: | --- | --- |',
  ];

  for (const result of report.results || []) {
    lines.push(`| ${[
      result.id,
      result.status || 'unknown',
      escapeTable(result.source || ''),
      result.responseChars ?? 0,
      result.requestFingerprintStatus || '',
      result.hasMetrics ? 'yes' : 'no',
    ].join(' | ')} |`);
  }

  lines.push('', '## Failures', '');
  if (!Array.isArray(report.failures) || report.failures.length === 0) {
    lines.push('- none');
  } else {
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }

  return `${lines.join('\n')}\n`;
}

function loadResponses(responseDir, opts) {
  if (Array.isArray(opts.responses)) {
    try {
      return loadInlineResponses(opts.responses, opts.responseSources);
    } catch (err) {
      return {
        responses: [],
        sources: [{ source: 'inline', responseCount: 0, status: 'load_failed' }],
        error: err.message,
      };
    }
  }
  try {
    return loadAdvisorFirstCallResponses(responseDir);
  } catch (err) {
    return {
      responses: [],
      sources: [{ source: responseDir, responseCount: 0, status: 'load_failed' }],
      error: err.message,
    };
  }
}

function loadInlineResponses(responses, sources) {
  const normalized = [];
  for (const [index, response] of responses.entries()) {
    const id = typeof response?.id === 'string' ? response.id.trim() : '';
    const source = `inline#${index + 1}`;
    const hasRawResponse = response?.rawResponse !== undefined;
    const hasResponse = response?.response !== undefined;
    if (hasRawResponse === hasResponse) {
      throw new Error(`advisor first-call response ${source} must provide exactly one of rawResponse or response`);
    }
    if (hasRawResponse && typeof response.rawResponse !== 'string') {
      throw new Error(`advisor first-call response ${source} rawResponse must be a string; use response for structured JSON`);
    }
    normalized.push({
      id,
      rawResponse: hasRawResponse
        ? response.rawResponse
        : JSON.stringify(response?.response),
      ...(response?.requestFingerprint ? { requestFingerprint: response.requestFingerprint } : {}),
      ...(response?.responseMetrics ? { responseMetrics: response.responseMetrics } : {}),
      source,
    });
  }
  return {
    responses: normalized,
    sources: sources || [{ source: 'inline', responseCount: responses.length }],
  };
}

function requestFingerprintMatch(actual, expected) {
  if (!expected) return 'not_expected';
  if (!actual) return 'missing';
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return 'invalid';
  return actual === expected ? 'matched' : 'mismatch';
}

function formatSources(sources = []) {
  if (!sources.length) return 'none';
  return sources
    .map((entry) => `${entry.source}${entry.status ? `(${entry.status})` : ''}:${entry.responseCount ?? 0}`)
    .join(', ');
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}

export default {
  ADVISOR_FIRST_CALL_RESPONSE_INTAKE_STRICT_ENV,
  buildAdvisorFirstCallResponseIntake,
  renderAdvisorFirstCallResponseIntake,
};
