import fs from 'node:fs';
import path from 'node:path';

import {
  ADVISOR_FIRST_CALL_REQUEST_FINGERPRINT_ALGORITHM,
  DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR,
  DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR,
  buildAdvisorFirstCallReplayReport,
  buildAdvisorFirstCallRequestPack,
  buildAdvisorFirstCallResponseTemplate,
} from './dry_run_calibration.js';
import {
  advisorFirstCallCalibrationTiers,
  formatAdvisorFirstCallExpected,
  formatAdvisorFirstCallRequestList,
  shortAdvisorFirstCallFingerprint,
  summarizeAdvisorFirstCallRequest,
} from './first_call_request_summary.js';

export const DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES = Object.freeze({
  requestIndex: 'requests/index.json',
  responseTemplate: 'responses.template.json',
  readme: 'README.md',
});
const REQUEST_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const REQUIRED_RESPONSE_METRICS_TEMPLATE_FIELDS = Object.freeze([
  'provider',
  'model',
  'latencyMs',
  'promptTokens',
  'completionTokens',
  'totalTokens',
]);
const REQUIRED_RESPONSE_METRICS_CAPTURE_FIELDS = Object.freeze([
  'latencyMs',
  'totalTokens',
]);
const NUMERIC_RESPONSE_METRICS_TEMPLATE_FIELDS = new Set([
  'latencyMs',
  'promptTokens',
  'completionTokens',
  'totalTokens',
]);

export function buildAdvisorFirstCallCapturePack(fixtures = undefined, opts = {}) {
  const responseDir = opts.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
  const sharedOpts = {
    ...opts,
    responseDir,
  };
  const requestPack = buildAdvisorFirstCallRequestPack(fixtures, sharedOpts);
  const responseTemplate = buildAdvisorFirstCallResponseTemplate(fixtures, sharedOpts);
  const replay = buildAdvisorFirstCallReplayReport(fixtures, {
    ...sharedOpts,
    requireCompleteResponses: false,
  });
  const expectedResponseIds = (requestPack.requests || []).map((request) => request.id);
  const requestFiles = expectedResponseIds.map((id) => ({
    id,
    path: `requests/${safeFileName(id)}.json`,
  }));
  const fingerprintContract = buildFingerprintContract(requestPack, responseTemplate);
  const responseMetricsContract = buildAdvisorFirstCallResponseMetricsContract(responseTemplate);
  const failures = [];

  if (requestPack.ok !== true) failures.push(`first-call request pack is ${requestPack.status || 'not ready'}`);
  if (responseTemplate.ok !== true) failures.push(`first-call response template is ${responseTemplate.status || 'not ready'}`);
  if (replay.ok !== true) failures.push(`default first-call replay is ${replay.status || 'not safe'}`);
  if (responseTemplate.responseCount !== requestPack.requestCount) {
    failures.push(`response template count ${responseTemplate.responseCount || 0} does not match request count ${requestPack.requestCount || 0}`);
  }
  if (fingerprintContract.ready !== true) {
    failures.push(`request fingerprint contract is not ready: ${fingerprintContract.failures.join('; ')}`);
  }
  if (responseMetricsContract.ready !== true) {
    failures.push(`response metrics capture contract is not ready: ${responseMetricsContract.failures.join('; ')}`);
  }

  const ok = failures.length === 0;
  return {
    ok,
    noApiCall: true,
    status: ok ? 'capture_pack_ready' : 'blocked',
    generatedFrom: 'advisor first-call request pack and response template',
    responseDir,
    writePrivateFilesRequested: opts.writePrivateFiles === true,
    requestCount: requestPack.requestCount || 0,
    responseTemplateCount: responseTemplate.responseCount || 0,
    fingerprintContract,
    responseMetricsContract,
    expectedResponseIds,
    requestSummaries: (requestPack.requests || []).map(summarizeAdvisorFirstCallRequest),
    replayStatus: replay.status,
    missingResponseCount: replay.missingCount || 0,
    privateFiles: {
      requestIndex: DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.requestIndex,
      requestFiles,
      responseTemplate: DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.responseTemplate,
      readme: DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.readme,
    },
    commands: {
      firstCallPlan: 'npm run advisor:first-call',
      executeFirstCall: '$env:MCBOT_ADVISOR_FIRST_CALL_CAPTURE_EXECUTE=\'1\'; $env:MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OK=\'1\'; $env:MCBOT_ALLOW_DEEPSEEK=\'1\'; npm run advisor:first-call',
      replay: 'npm run advisor:replay',
      strictReplay: '$env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=\'1\'; npm run advisor:replay',
      strictMetricsReplay: '$env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=\'1\'; $env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSE_METRICS=\'1\'; npm run advisor:replay',
      captureGuard: 'npm run advisor:response-capture-guard',
    },
    nextAction: ok
      ? 'run_explicitly_gated_advisor_first_call'
      : 'fix_blocked_first_call_capture_pack',
    failures,
  };
}

export function writeAdvisorFirstCallCaptureFiles(fixtures = undefined, opts = {}) {
  const pack = buildAdvisorFirstCallCapturePack(fixtures, opts);
  if (opts.writePrivateFiles !== true) {
    return {
      ok: pack.ok,
      noApiCall: true,
      status: 'private_write_skipped',
      responseDir: pack.responseDir,
      wroteFiles: [],
      pack,
      failures: pack.failures,
    };
  }
  if (pack.ok !== true) {
    return {
      ok: false,
      noApiCall: true,
      status: 'blocked',
      responseDir: pack.responseDir,
      wroteFiles: [],
      pack,
      failures: pack.failures,
    };
  }

  const root = path.resolve(opts.root || process.cwd());
  const responseDir = opts.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
  const absoluteDir = path.resolve(root, responseDir);
  const requestPack = buildAdvisorFirstCallRequestPack(fixtures, opts);
  const responseTemplate = buildAdvisorFirstCallResponseTemplate(fixtures, {
    ...opts,
    responseDir,
  });
  const wroteFiles = [];

  fs.mkdirSync(path.join(absoluteDir, 'requests'), { recursive: true });
  wroteJson(path.join(absoluteDir, DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.requestIndex), {
    schemaVersion: 1,
    generatedFrom: 'advisor first-call request pack',
    noApiCall: true,
    requestCount: requestPack.requestCount,
    responseDir,
    requests: (requestPack.requests || []).map((request) => ({
      id: request.id,
      source: request.source,
      category: request.category,
      goal: request.goal,
      calibration: request.calibration,
      expected: request.expected,
      promptChars: request.promptChars,
      estimatedPromptTokens: request.estimatedPromptTokens,
      requestFingerprint: request.requestFingerprint,
      requestFingerprintAlgorithm: request.requestFingerprintAlgorithm,
      requestFile: `requests/${safeFileName(request.id)}.json`,
    })),
  });
  wroteFiles.push(DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.requestIndex);

  for (const request of requestPack.requests || []) {
    const relativePath = `requests/${safeFileName(request.id)}.json`;
    wroteJson(path.join(absoluteDir, relativePath), {
      schemaVersion: 1,
      id: request.id,
      generatedFrom: 'advisor first-call request pack',
      noApiCall: true,
      source: request.source,
      category: request.category,
      goal: request.goal,
      calibration: request.calibration,
      expected: request.expected,
      promptChars: request.promptChars,
      estimatedPromptTokens: request.estimatedPromptTokens,
      requestFingerprint: request.requestFingerprint,
      requestFingerprintAlgorithm: request.requestFingerprintAlgorithm,
      request: request.request,
    });
    wroteFiles.push(relativePath);
  }

  wroteJson(path.join(absoluteDir, DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.responseTemplate), responseTemplate.responseDocument);
  wroteFiles.push(DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.responseTemplate);

  fs.writeFileSync(
    path.join(absoluteDir, DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.readme),
    renderPrivateCaptureReadme(pack),
  );
  wroteFiles.push(DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.readme);

  return {
    ok: true,
    noApiCall: true,
    status: 'private_capture_files_written',
    responseDir,
    wroteFiles,
    pack,
    failures: [],
  };
}

export function renderAdvisorFirstCallCapturePack(pack, writeResult = null) {
  const lines = [
    '# Advisor First-Call Capture Pack',
    '',
    `- no API call made: ${pack.noApiCall === true ? 'yes' : 'unknown'}`,
    `- status: ${pack.status || 'unknown'}`,
    `- response dir: ${pack.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR}`,
    `- private write requested: ${pack.writePrivateFilesRequested ? 'yes' : 'no'}`,
    `- private write status: ${writeResult?.status || 'not requested'}`,
    `- request count: ${pack.requestCount || 0}`,
    `- request ids: ${formatAdvisorFirstCallRequestList((pack.requestSummaries || []).map((request) => request.id).filter(Boolean))}`,
    `- calibration tiers: ${formatAdvisorFirstCallRequestList(advisorFirstCallCalibrationTiers(pack.requestSummaries || []))}`,
    `- response template count: ${pack.responseTemplateCount || 0}`,
    `- fingerprint contract: ${pack.fingerprintContract?.ready ? 'ready' : 'blocked'}`,
    `- request fingerprints: ${pack.fingerprintContract?.requestFingerprintCount || 0}/${pack.requestCount || 0}`,
    `- response template fingerprints: ${pack.fingerprintContract?.responseTemplateFingerprintCount || 0}/${pack.responseTemplateCount || 0}`,
    `- fingerprint mismatches: ${pack.fingerprintContract?.mismatchCount || 0}`,
    `- response metrics contract: ${pack.responseMetricsContract?.ready ? 'ready' : 'blocked'}`,
    `- response metrics templates: ${pack.responseMetricsContract?.templateCount || 0}/${pack.responseTemplateCount || 0}`,
    `- response metrics required-field lists: ${pack.responseMetricsContract?.requiredCaptureFieldCount || 0}/${pack.responseTemplateCount || 0}`,
    `- response metrics missing fields: ${pack.responseMetricsContract?.missingFieldCount || 0}`,
    `- response metrics missing required fields: ${pack.responseMetricsContract?.missingRequiredCaptureFieldCount || 0}`,
    `- default replay status: ${pack.replayStatus || 'unknown'}`,
    `- missing responses: ${pack.missingResponseCount || 0}`,
    `- next action: ${pack.nextAction || 'unknown'}`,
    '',
    '## First-Call Requests',
    '',
    '| Request | Category | Calibration tier | Purpose | Expected | Prompt chars | Est. tokens | Fingerprint |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- |',
  ];

  for (const request of pack.requestSummaries || []) {
    lines.push(`| ${[
      request.id || '',
      escapeTable(request.category || ''),
      escapeTable(request.calibrationTier || ''),
      escapeTable(request.calibrationPurpose || ''),
      escapeTable(formatAdvisorFirstCallExpected(request.expected)),
      request.promptChars ?? 0,
      request.estimatedPromptTokens ?? 0,
      shortAdvisorFirstCallFingerprint(request.requestFingerprint),
    ].join(' | ')} |`);
  }

  lines.push(
    '',
    '## Private Files',
    '',
    '| File | Purpose |',
    '| --- | --- |',
    `| ${pack.privateFiles?.requestIndex || ''} | index of first-call request payload files |`,
  );

  for (const requestFile of pack.privateFiles?.requestFiles || []) {
    lines.push(`| ${requestFile.path} | request payload for ${escapeTable(requestFile.id)} |`);
  }
  lines.push(`| ${pack.privateFiles?.responseTemplate || ''} | empty raw-response template to populate after explicit capture |`);
  lines.push(`| ${pack.privateFiles?.readme || ''} | private operator instructions |`);

  lines.push('', '## Commands', '');
  for (const [name, command] of Object.entries(pack.commands || {})) {
    lines.push(`- ${name}: \`${command}\``);
  }

  lines.push('', '## Failures', '');
  if (!Array.isArray(pack.failures) || pack.failures.length === 0) {
    lines.push('- none');
  } else {
    for (const failure of pack.failures) lines.push(`- ${failure}`);
  }

  if (writeResult?.wroteFiles?.length > 0) {
    lines.push('', '## Written Files', '');
    for (const file of writeResult.wroteFiles) lines.push(`- ${file}`);
  }

  return `${lines.join('\n')}\n`;
}

export function buildAdvisorFirstCallResponseMetricsContract(responseTemplate) {
  const responseEntries = responseTemplate.responseDocument?.responses || [];
  const failures = [];
  const missingFields = [];
  const invalidFields = [];
  const missingRequiredCaptureFields = [];
  const invalidRequiredCaptureFields = [];
  let templateCount = 0;
  let requiredCaptureFieldCount = 0;

  for (const response of responseEntries) {
    const metrics = response._capture?.responseMetricsTemplate;
    const requiredCaptureFields = response._capture?.responseMetricsRequiredFields;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      missingFields.push({ id: response.id, field: 'responseMetricsTemplate' });
    } else {
      let responseReady = true;
      for (const field of REQUIRED_RESPONSE_METRICS_TEMPLATE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(metrics, field)) {
          missingFields.push({ id: response.id, field });
          responseReady = false;
          continue;
        }
        if (!validMetricsTemplateValue(field, metrics[field])) {
          invalidFields.push({ id: response.id, field });
          responseReady = false;
        }
      }
      if (responseReady) templateCount += 1;
    }

    if (!Array.isArray(requiredCaptureFields)) {
      missingRequiredCaptureFields.push({ id: response.id, field: 'responseMetricsRequiredFields' });
    } else {
      let requiredReady = true;
      for (const field of REQUIRED_RESPONSE_METRICS_CAPTURE_FIELDS) {
        if (!requiredCaptureFields.includes(field)) {
          missingRequiredCaptureFields.push({ id: response.id, field });
          requiredReady = false;
        }
      }
      for (const field of requiredCaptureFields) {
        if (typeof field !== 'string' || field.trim() === '') {
          invalidRequiredCaptureFields.push({ id: response.id, field: String(field) });
          requiredReady = false;
        }
      }
      if (requiredReady) requiredCaptureFieldCount += 1;
    }
  }

  if (responseEntries.length === 0) failures.push('response template has no responses');
  if (missingFields.length > 0) failures.push(`${missingFields.length} response metrics template field(s) missing`);
  if (invalidFields.length > 0) failures.push(`${invalidFields.length} response metrics template field(s) invalid`);
  if (missingRequiredCaptureFields.length > 0) failures.push(`${missingRequiredCaptureFields.length} response metrics required capture field(s) missing`);
  if (invalidRequiredCaptureFields.length > 0) failures.push(`${invalidRequiredCaptureFields.length} response metrics required capture field(s) invalid`);

  return {
    ready: failures.length === 0 && responseEntries.length > 0,
    requiredFields: [...REQUIRED_RESPONSE_METRICS_TEMPLATE_FIELDS],
    requiredCaptureFields: [...REQUIRED_RESPONSE_METRICS_CAPTURE_FIELDS],
    responseTemplateCount: responseEntries.length,
    templateCount,
    requiredCaptureFieldCount,
    missingFieldCount: missingFields.length,
    invalidFieldCount: invalidFields.length,
    missingRequiredCaptureFieldCount: missingRequiredCaptureFields.length,
    invalidRequiredCaptureFieldCount: invalidRequiredCaptureFields.length,
    missingFields,
    invalidFields,
    missingRequiredCaptureFields,
    invalidRequiredCaptureFields,
    failures,
  };
}

function validMetricsTemplateValue(field, value) {
  if (NUMERIC_RESPONSE_METRICS_TEMPLATE_FIELDS.has(field)) {
    return value === 'number' || (Number.isFinite(value) && value >= 0);
  }
  return typeof value === 'string' && value.trim().length > 0;
}

function buildFingerprintContract(requestPack, responseTemplate) {
  const requests = requestPack.requests || [];
  const responseEntries = responseTemplate.responseDocument?.responses || [];
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const responseById = new Map(responseEntries.map((response) => [response.id, response]));
  const failures = [];

  const invalidRequests = requests.filter((request) => (
    !REQUEST_FINGERPRINT_RE.test(request.requestFingerprint || '')
      || request.requestFingerprintAlgorithm !== ADVISOR_FIRST_CALL_REQUEST_FINGERPRINT_ALGORITHM
  ));
  const invalidResponses = responseEntries.filter((response) => (
    !REQUEST_FINGERPRINT_RE.test(response.requestFingerprint || '')
  ));
  const countMatches = responseEntries.length === requests.length;
  const mismatches = responseEntries.filter((response) => {
    const request = requestById.get(response.id);
    return request && response.requestFingerprint !== request.requestFingerprint;
  });
  const missingResponseFingerprints = requests.filter((request) => !responseById.has(request.id));

  if (!countMatches) failures.push(`response-template count ${responseEntries.length} does not match request count ${requests.length}`);
  if (invalidRequests.length > 0) failures.push(`${invalidRequests.length} request fingerprint(s) invalid`);
  if (invalidResponses.length > 0) failures.push(`${invalidResponses.length} response-template fingerprint(s) invalid`);
  if (mismatches.length > 0) failures.push(`${mismatches.length} response-template fingerprint mismatch(es)`);
  if (missingResponseFingerprints.length > 0) failures.push(`${missingResponseFingerprints.length} response-template id(s) missing`);

  return {
    ready: failures.length === 0
      && requests.length > 0
      && countMatches,
    algorithm: ADVISOR_FIRST_CALL_REQUEST_FINGERPRINT_ALGORITHM,
    requestFingerprintCount: requests.length - invalidRequests.length,
    responseTemplateFingerprintCount: responseEntries.length - invalidResponses.length,
    mismatchCount: mismatches.length,
    invalidRequestFingerprintCount: invalidRequests.length,
    invalidResponseTemplateFingerprintCount: invalidResponses.length,
    missingResponseTemplateFingerprintCount: missingResponseFingerprints.length,
    failures,
  };
}

function renderPrivateCaptureReadme(pack) {
  const lines = [
    '# Private Advisor First-Call Capture Pack',
    '',
    'This directory is intentionally ignored by git and is for private first-call capture artifacts.',
    'Do not commit raw model responses, API keys, or provider output files.',
    '',
    'Workflow:',
    '1. Submit each JSON body under requests/ only during an explicitly gated DeepSeek run.',
    '2. Paste each exact assistant message into responses.template.json as the matching rawResponse value.',
    '3. Ensure each populated response has a top-level responseMetrics object with at least latencyMs and totalTokens.',
    '4. Rename or copy the populated file to any .json file in this directory.',
    '5. Run strict replay, strict metrics replay, and the capture guard before trusting live advisor calibration.',
    '',
    'Commands:',
    `- strict replay: ${pack.commands.strictReplay}`,
    `- strict metrics replay: ${pack.commands.strictMetricsReplay}`,
    `- capture guard: ${pack.commands.captureGuard}`,
    '',
    'Expected response ids:',
    ...(pack.expectedResponseIds || []).map((id) => `- ${id}`),
    '',
  ];
  return lines.join('\n');
}

function wroteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function safeFileName(value) {
  return String(value || 'unnamed').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}

export default {
  DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES,
  buildAdvisorFirstCallResponseMetricsContract,
  buildAdvisorFirstCallCapturePack,
  writeAdvisorFirstCallCaptureFiles,
  renderAdvisorFirstCallCapturePack,
};
