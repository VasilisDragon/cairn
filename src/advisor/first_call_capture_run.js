import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR,
  DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR,
  buildAdvisorFirstCallReplayReport,
  buildAdvisorFirstCallRequestPack,
} from './dry_run_calibration.js';
import {
  DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES,
  buildAdvisorFirstCallCapturePack,
  writeAdvisorFirstCallCaptureFiles,
} from './first_call_capture_pack.js';
import { buildAdvisorFirstCallResponseIntake } from './first_call_response_intake.js';
import { deepseekPreflight } from './deepseek_preflight.js';
import {
  DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS,
  evaluateAdvisorResponseCaptureGuard,
} from './response_capture_guard.js';
import {
  formatAdvisorFirstCallExpected,
  normalizeAdvisorFirstCallRequestSummaries,
  shortAdvisorFirstCallFingerprint,
} from './first_call_request_summary.js';

export const ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV = 'MCBOT_ADVISOR_FIRST_CALL_CAPTURE_EXECUTE';
export const ADVISOR_FIRST_CALL_CAPTURE_OK_ENV = 'MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OK';
export const ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE_ENV = 'MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE';
export const ADVISOR_FIRST_CALL_CAPTURE_ENTRYPOINT = 'advisor_first_call_capture';

export async function runAdvisorFirstCallCapture(opts = {}) {
  const env = opts.env || process.env;
  const plan = buildAdvisorFirstCallCaptureRunPlan(env, opts);
  if (plan.readyToExecute !== true) {
    return {
      ...plan,
      capture: {
        status: plan.executeRequested ? 'blocked' : 'not_requested',
        wroteResponseFile: false,
        responseFile: plan.responseFile,
        responseCount: 0,
        responseChars: [],
        failures: plan.failures,
      },
    };
  }
  if (typeof opts.complete !== 'function') {
    return {
      ...plan,
      ok: false,
      readyToExecute: false,
      status: 'blocked',
      failures: ['DeepSeek completion function is required for execute mode'],
      capture: {
        status: 'blocked',
        wroteResponseFile: false,
        responseFile: plan.responseFile,
        responseCount: 0,
        responseChars: [],
        failures: ['DeepSeek completion function is required for execute mode'],
      },
    };
  }

  const writeResult = writeAdvisorFirstCallCaptureFiles(undefined, {
    fixtureDir: plan.fixtureDir,
    responseDir: plan.responseDir,
    request: plan.requestDefaults,
    firstCallReadinessRequirements: plan.firstCallReadinessRequirements,
    responses: [],
    writePrivateFiles: true,
    root: opts.root || process.cwd(),
  });
  if (writeResult.ok !== true) {
    return {
      ...plan,
      ok: false,
      readyToExecute: false,
      status: 'blocked',
      failures: writeResult.failures || ['private capture file write failed'],
      capture: {
        status: 'private_capture_files_failed',
        wroteResponseFile: false,
        responseFile: plan.responseFile,
        responseCount: 0,
        responseChars: [],
        failures: writeResult.failures || ['private capture file write failed'],
      },
    };
  }

  const captured = [];
  const failures = [];
  for (const request of plan.requests) {
    const started = Date.now();
    try {
      const completion = await opts.complete(
        request.request.messages,
        completionOptionsForRequest(request),
        { id: request.id, request },
      );
      const latencyMs = Date.now() - started;
      const capturedCompletion = normalizeCapturedCompletion(completion, {
        latencyMs,
        model: request.request?.model || plan.requestDefaults?.model || null,
      });
      captured.push({
        id: request.id,
        requestFingerprint: request.requestFingerprint,
        rawResponse: capturedCompletion.rawResponse,
        responseMetrics: capturedCompletion.responseMetrics,
      });
    } catch (err) {
      failures.push(`${request.id} capture failed: ${sanitizeErrorMessage(err)}`);
      break;
    }
  }

  if (failures.length > 0) {
    return {
      ...plan,
      ok: false,
      readyToExecute: false,
      status: 'blocked',
      failures,
      capture: {
        status: 'capture_failed_before_private_response_write',
        wroteResponseFile: false,
        responseFile: plan.responseFile,
        responseCount: captured.length,
        responseChars: captured.map((entry) => ({ id: entry.id, chars: entry.rawResponse.length })),
        failures,
      },
    };
  }

  const responseDoc = {
    schemaVersion: 1,
    generatedFrom: 'advisor explicit first-call capture run',
    noApiCall: false,
    capturedAt: new Date().toISOString(),
    responses: captured,
  };
  fs.mkdirSync(path.dirname(plan.absoluteResponseFile), { recursive: true });
  fs.writeFileSync(plan.absoluteResponseFile, JSON.stringify(responseDoc, null, 2) + '\n');

  const responseSummary = captured.map((entry) => {
    const metricsReadiness = capturedResponseMetricsReadiness(entry.responseMetrics);
    return {
      id: entry.id,
      requestFingerprint: entry.requestFingerprint,
      chars: entry.rawResponse.length,
      hasContent: entry.rawResponse.trim().length > 0,
      hasMetrics: metricsReadiness.hasMetrics,
      metricsReady: metricsReadiness.ready,
      missingMetricFields: metricsReadiness.missingFields,
    };
  });
  const publicReport = {
    ...plan,
    ok: true,
    noApiCall: false,
    readyToExecute: false,
    status: 'captured_first_call_responses',
    nextAction: 'run_strict_first_call_response_intake_and_replay',
    failures: [],
    capture: {
      status: 'captured_first_call_responses',
      wroteResponseFile: true,
      responseFile: plan.responseFile,
      responseCount: captured.length,
      responseChars: responseSummary,
      failures: [],
    },
  };

  const strictIntake = buildAdvisorFirstCallResponseIntake(undefined, {
    fixtureDir: plan.fixtureDir,
    responseDir: plan.responseDir,
    request: plan.requestDefaults,
    firstCallReadinessRequirements: plan.firstCallReadinessRequirements,
    requireComplete: true,
  });
  const strictReplay = buildAdvisorFirstCallReplayReport(undefined, {
    fixtureDir: plan.fixtureDir,
    responseDir: plan.responseDir,
    request: plan.requestDefaults,
    firstCallReadinessRequirements: plan.firstCallReadinessRequirements,
    requireCompleteResponses: true,
  });
  const strictMetricsReplay = buildAdvisorFirstCallReplayReport(undefined, {
    fixtureDir: plan.fixtureDir,
    responseDir: plan.responseDir,
    request: plan.requestDefaults,
    firstCallReadinessRequirements: plan.firstCallReadinessRequirements,
    requireCompleteResponses: true,
    requireResponseMetrics: true,
  });

  return {
    ...publicReport,
    strictValidationPreview: {
      intakeStatus: strictIntake.status,
      intakeOk: strictIntake.ok,
      replayStatus: strictReplay.status,
      replayOk: strictReplay.ok,
      metricsReplayStatus: strictMetricsReplay.status,
      metricsReplayOk: strictMetricsReplay.ok,
      presentCount: strictReplay.presentCount,
      missingCount: strictReplay.missingCount,
      unexpectedOutcomes: strictReplay.unexpectedOutcomes,
      promptBudgetViolations: strictReplay.promptBudgetViolations,
      responseMetricsReadyCount: strictMetricsReplay.responseMetricsReadyCount,
      responseMetricsIncompleteCount: strictMetricsReplay.responseMetricsIncompleteCount,
      failures: [
        ...(strictIntake.failures || []),
        ...(strictReplay.failures || []),
        ...(strictMetricsReplay.failures || []),
      ],
    },
  };
}

export function buildAdvisorFirstCallCaptureRunPlan(env = process.env, opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const fixtureDir = opts.fixtureDir || env.MCBOT_ADVISOR_DRY_RUN_FIXTURE_DIR || DEFAULT_ADVISOR_DRY_RUN_FIXTURE_DIR;
  const responseDir = opts.responseDir || env.MCBOT_ADVISOR_FIRST_CALL_RESPONSE_DIR || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
  const executeRequested = opts.execute === true || env[ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV] === '1';
  const captureConfirmed = opts.captureConfirmed === true || env[ADVISOR_FIRST_CALL_CAPTURE_OK_ENV] === '1';
  const overwrite = opts.overwrite === true || env[ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE_ENV] === '1';
  const responseFileName = DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.responseTemplate;
  const absoluteResponseDir = path.resolve(root, responseDir);
  const absoluteResponseFile = path.join(absoluteResponseDir, responseFileName);
  const responseFile = normalizeDisplayPath(path.relative(root, absoluteResponseFile));
  const sharedCalibrationOpts = {
    fixtureDir,
    responseDir,
    request: opts.request,
    firstCallReadinessRequirements: opts.firstCallReadinessRequirements,
  };
  const requestPack = buildAdvisorFirstCallRequestPack(undefined, sharedCalibrationOpts);
  const capturePack = buildAdvisorFirstCallCapturePack(undefined, overwrite
    ? { ...sharedCalibrationOpts, responses: [] }
    : sharedCalibrationOpts);
  const responseIntake = buildAdvisorFirstCallResponseIntake(undefined, {
    fixtureDir,
    responseDir,
    firstCallReadinessRequirements: opts.firstCallReadinessRequirements,
    ...(overwrite ? { responses: [] } : {}),
    requireComplete: false,
  });
  const reportChecks = opts.reportChecks || DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS
    .filter((check) => check.path !== 'reports/advisor-first-call.json');
  const captureGuard = opts.captureGuard || evaluateAdvisorResponseCaptureGuard({ root, responseDir, reportChecks });
  const outputStatus = inspectResponseOutputFile(absoluteResponseFile);
  const responseInputSafety = summarizeCaptureInputSafety(responseIntake, responseFile);
  const preflight = executeRequested
    ? deepseekPreflight(env, { entrypoint: ADVISOR_FIRST_CALL_CAPTURE_ENTRYPOINT })
    : skippedPreflight();
  const criteria = [
    criterion(
      'capture_pack_ready',
      capturePack.ok === true,
      `capture pack status ${capturePack.status || 'unknown'}; requests=${capturePack.requestCount || 0}`,
      `capture pack blocked: ${(capturePack.failures || []).join('; ') || capturePack.status || 'unknown'}`,
    ),
    criterion(
      'response_intake_safe',
      responseInputSafety.ok === true,
      responseInputSafety.evidence,
      responseInputSafety.failures.join('; ') || `response intake blocked: ${responseIntake.status || 'unknown'}`,
    ),
    criterion(
      'private_capture_guard',
      captureGuard.ok === true,
      'private capture directory is ignored and public reports are raw-response-free',
      `private capture guard blocked: ${(captureGuard.failures || []).join('; ') || 'unknown'}`,
    ),
    criterion(
      'response_output_writable',
      outputStatus.ok === true && (overwrite || outputStatus.nonEmptyResponseCount === 0),
      outputStatus.exists
        ? `${responseFile} exists with ${outputStatus.nonEmptyResponseCount} non-empty response(s)`
        : `${responseFile} will be created`,
      outputStatus.failure || `${responseFile} already contains ${outputStatus.nonEmptyResponseCount} non-empty captured response(s); set ${ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE_ENV}=1 to replace it`,
    ),
    criterion(
      'execute_requested',
      executeRequested,
      `${ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV}=1 present`,
      `${ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV}=1 required to run first-call capture`,
      executeRequested ? 'failure' : 'pending',
    ),
    criterion(
      'capture_confirmed',
      captureConfirmed,
      `${ADVISOR_FIRST_CALL_CAPTURE_OK_ENV}=1 present`,
      `${ADVISOR_FIRST_CALL_CAPTURE_OK_ENV}=1 required to confirm this explicit DeepSeek capture run`,
      executeRequested ? 'failure' : 'pending',
    ),
    criterion(
      'deepseek_preflight_ready',
      preflight.ok === true,
      'DeepSeek environment preflight is ready',
      preflight.reasons?.join('; ') || 'DeepSeek preflight not checked until execute is requested',
      executeRequested ? 'failure' : 'pending',
    ),
  ];
  const failures = criteria
    .filter((entry) => entry.status === 'failed' && entry.severity === 'failure')
    .map((entry) => entry.reason);
  const readyToExecute = executeRequested
    && captureConfirmed
    && preflight.ok === true
    && capturePack.ok === true
    && responseInputSafety.ok === true
    && captureGuard.ok === true
    && outputStatus.ok === true
    && (overwrite || outputStatus.nonEmptyResponseCount === 0);

  const requests = (requestPack.requests || []).map((request) => ({
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
    request: request.request,
  }));
  const requestSummaries = normalizeAdvisorFirstCallRequestSummaries(requests);

  return {
    ok: executeRequested ? failures.length === 0 && readyToExecute : true,
    noApiCall: true,
    status: executeRequested
      ? readyToExecute ? 'ready_to_execute_first_call_capture' : 'blocked'
      : 'capture_execution_not_requested',
    generatedFrom: 'advisor first-call capture run gate',
    entrypoint: ADVISOR_FIRST_CALL_CAPTURE_ENTRYPOINT,
    fixtureDir,
    responseDir,
    responseFile,
    absoluteResponseFile,
    executeRequested,
    captureConfirmed,
    overwrite,
    readyToExecute,
    requestCount: requestPack.requestCount || 0,
    requestIds: (requestPack.requests || []).map((request) => request.id),
    requestSummaries,
    requestDefaults: requestPack.requestDefaults,
    firstCallReadinessRequirements: requestPack.firstCallReadinessRequirements,
    responseIntake: summarizeResponseIntake(responseIntake),
    responseInputSafety,
    captureGuard: summarizeCaptureGuard(captureGuard),
    responseOutput: outputStatus,
    preflight: summarizePreflight(preflight),
    criteria,
    failures,
    nextAction: readyToExecute
      ? 'execute_first_call_capture_now'
      : executeRequested
        ? 'fix_blocked_first_call_capture_run'
        : `set ${ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV}=1 and ${ADVISOR_FIRST_CALL_CAPTURE_OK_ENV}=1 only for an explicitly authorized capture`,
    commands: {
      dryRunPlan: 'npm run advisor:first-call',
      executeCapture: `$env:${ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV}='1'; $env:${ADVISOR_FIRST_CALL_CAPTURE_OK_ENV}='1'; $env:MCBOT_ALLOW_DEEPSEEK='1'; npm run advisor:first-call`,
      replay: 'npm run advisor:replay',
      strictReplay: '$env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=\'1\'; npm run advisor:replay',
      strictMetricsReplay: '$env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES=\'1\'; $env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSE_METRICS=\'1\'; npm run advisor:replay',
      finalGuard: 'npm run advisor:response-capture-guard',
    },
    requests,
  };
}

export function sanitizeAdvisorFirstCallCaptureRunPublicReport(report = {}) {
  const {
    absoluteResponseFile,
    requests,
    ...publicReport
  } = report || {};
  const requestSummaries = normalizeAdvisorFirstCallRequestSummaries(
    publicReport.requestSummaries || requests,
    publicReport.requestIds,
  );

  return {
    ...publicReport,
    requestSummaries,
    runtimeRequestPayloadOmitted: true,
    runtimeRequestPayloadPolicy: 'chat request messages are runtime-only and are not written to public capture-run reports',
  };
}

export function renderAdvisorFirstCallCaptureRun(report) {
  const requestSummaries = normalizeAdvisorFirstCallRequestSummaries(
    report.requestSummaries || report.requests,
    report.requestIds,
  );
  const lines = [
    `# ${report.title || 'Advisor First-Call Capture Run'}`,
    '',
    `- no API call made: ${report.noApiCall === true ? 'yes' : 'no'}`,
    `- status: ${report.status || 'unknown'}`,
    `- entrypoint: ${report.entrypoint || ADVISOR_FIRST_CALL_CAPTURE_ENTRYPOINT}`,
    `- response dir: ${report.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR}`,
    `- response file: ${report.responseFile || DEFAULT_ADVISOR_FIRST_CALL_CAPTURE_FILES.responseTemplate}`,
    `- execute requested: ${report.executeRequested ? 'yes' : 'no'}`,
    `- capture confirmed: ${report.captureConfirmed ? 'yes' : 'no'}`,
    `- overwrite enabled: ${report.overwrite ? 'yes' : 'no'}`,
    `- ready to execute: ${report.readyToExecute ? 'yes' : 'no'}`,
    `- request count: ${report.requestCount || 0}`,
    `- runtime request payload omitted: ${report.runtimeRequestPayloadOmitted ? 'yes' : 'runtime report only'}`,
    `- next action: ${report.nextAction || 'unknown'}`,
    '',
    '## First-Call Requests',
    '',
    '| Request | Category | Calibration tier | Purpose | Expected | Prompt chars | Est. tokens | Fingerprint |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- |',
  ];

  for (const request of requestSummaries) {
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
    '## Preflight',
    '',
    `- status: ${report.preflight?.status || 'unknown'}`,
    `- opt-in gate: ${report.preflight?.gateOk ? 'allowed' : 'blocked'}`,
    `- API key: ${report.preflight?.apiKeyConfigured ? 'configured' : 'missing'}`,
    `- model: ${report.preflight?.model || 'unknown'}`,
    '',
    '## Criteria',
    '',
    '| Criterion | Status | Severity | Detail |',
    '| --- | --- | --- | --- |',
  );

  for (const entry of report.criteria || []) {
    lines.push(`| ${[
      entry.id,
      entry.status,
      entry.severity,
      escapeTable(entry.status === 'passed' ? entry.evidence : entry.reason),
    ].join(' | ')} |`);
  }

  lines.push('', '## Capture', '');
  if (report.capture) {
    lines.push(`- status: ${report.capture.status || 'unknown'}`);
    lines.push(`- wrote response file: ${report.capture.wroteResponseFile ? 'yes' : 'no'}`);
    lines.push(`- response count: ${report.capture.responseCount || 0}`);
    for (const entry of report.capture.responseChars || []) {
      lines.push(`- ${entry.id}: ${entry.chars} chars; ${formatCapturedMetricsStatus(entry)}`);
    }
  } else {
    lines.push('- status: not run');
  }

  if (report.strictValidationPreview) {
    lines.push('', '## Strict Validation Preview', '');
    lines.push(`- intake: ${report.strictValidationPreview.intakeStatus}; ok=${report.strictValidationPreview.intakeOk ? 'yes' : 'no'}`);
    lines.push(`- replay: ${report.strictValidationPreview.replayStatus}; ok=${report.strictValidationPreview.replayOk ? 'yes' : 'no'}`);
    lines.push(`- metrics replay: ${report.strictValidationPreview.metricsReplayStatus}; ok=${report.strictValidationPreview.metricsReplayOk ? 'yes' : 'no'}`);
    lines.push(`- present: ${report.strictValidationPreview.presentCount || 0}`);
    lines.push(`- missing: ${report.strictValidationPreview.missingCount || 0}`);
    lines.push(`- unexpected: ${report.strictValidationPreview.unexpectedOutcomes || 0}`);
    lines.push(`- prompt budget violations: ${report.strictValidationPreview.promptBudgetViolations || 0}`);
    lines.push(`- response metrics ready: ${report.strictValidationPreview.responseMetricsReadyCount || 0}`);
    lines.push(`- response metrics incomplete: ${report.strictValidationPreview.responseMetricsIncompleteCount || 0}`);
  }

  lines.push('', '## Commands', '');
  for (const [name, command] of Object.entries(report.commands || {})) {
    lines.push(`- ${name}: \`${command}\``);
  }

  lines.push('', '## Failures', '');
  if (!Array.isArray(report.failures) || report.failures.length === 0) {
    lines.push('- none');
  } else {
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }

  return `${lines.join('\n')}\n`;
}

function completionOptionsForRequest(request) {
  return {
    model: request.request?.model,
    temperature: request.request?.temperature,
    maxTokens: request.request?.max_tokens,
    responseFormatJson: request.request?.response_format?.type === 'json_object',
  };
}

function normalizeCapturedCompletion(completion, fallback = {}) {
  if (completion && typeof completion === 'object' && !Array.isArray(completion)) {
    const providerMetrics = normalizeProviderResponseMetrics(completion);
    const responseMetrics = mergeCapturedResponseMetrics(completion.responseMetrics, providerMetrics);
    return {
      rawResponse: stringifyCapturedContent(extractCapturedResponseContent(completion)),
      responseMetrics: normalizeCapturedResponseMetrics(
        responseMetrics,
        {
          ...fallback,
          model: responseMetrics?.model || fallback.model,
        },
      ),
    };
  }
  return {
    rawResponse: String(completion || ''),
    responseMetrics: normalizeCapturedResponseMetrics(null, fallback),
  };
}

function extractCapturedResponseContent(completion) {
  if (completion.content !== undefined) return completion.content;
  if (completion.rawResponse !== undefined) return completion.rawResponse;
  if (Array.isArray(completion.choices) && completion.choices.length > 0) {
    const choice = completion.choices[0] || {};
    return choice.message?.content ?? choice.delta?.content ?? choice.text ?? '';
  }
  if (completion.output_text !== undefined) return completion.output_text;
  return '';
}

function stringifyCapturedContent(value) {
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).join('');
  }
  return String(value ?? '');
}

function normalizeProviderResponseMetrics(completion) {
  const usage = completion.usage && typeof completion.usage === 'object' ? completion.usage : {};
  const out = {};
  if (typeof completion.model === 'string' && completion.model.trim()) out.model = completion.model.trim();
  const pairs = [
    ['prompt_tokens', 'promptTokens'],
    ['completion_tokens', 'completionTokens'],
    ['total_tokens', 'totalTokens'],
  ];
  for (const [sourceField, targetField] of pairs) {
    const value = usage[sourceField] ?? usage[targetField];
    if (Number.isFinite(value) && value >= 0) out[targetField] = Math.round(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function mergeCapturedResponseMetrics(explicitMetrics, providerMetrics) {
  if (explicitMetrics && typeof explicitMetrics === 'object' && !Array.isArray(explicitMetrics)) {
    return {
      ...(providerMetrics || {}),
      ...explicitMetrics,
    };
  }
  return providerMetrics || null;
}

function normalizeCapturedResponseMetrics(metrics = null, fallback = {}) {
  const source = typeof metrics?.source === 'string' && metrics.source.trim()
    ? metrics.source.trim()
    : 'first_gated_deepseek_call';
  const provider = typeof metrics?.provider === 'string' && metrics.provider.trim()
    ? metrics.provider.trim()
    : 'deepseek';
  const model = typeof metrics?.model === 'string' && metrics.model.trim()
    ? metrics.model.trim()
    : fallback.model;
  const out = {
    source,
    provider,
    ...(model ? { model } : {}),
  };
  for (const field of ['latencyMs', 'promptTokens', 'completionTokens', 'totalTokens']) {
    const value = metrics?.[field] ?? (field === 'latencyMs' ? fallback.latencyMs : undefined);
    if (Number.isFinite(value) && value >= 0) out[field] = Math.round(value);
  }
  if (out.totalTokens === undefined && out.promptTokens !== undefined && out.completionTokens !== undefined) {
    out.totalTokens = out.promptTokens + out.completionTokens;
  }
  return out;
}

function capturedResponseMetricsReadiness(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) || Object.keys(metrics).length === 0) {
    return {
      hasMetrics: false,
      ready: false,
      missingFields: ['responseMetrics'],
    };
  }
  const missingFields = [];
  if (!Number.isFinite(metrics.latencyMs) || metrics.latencyMs < 0) missingFields.push('latencyMs');
  if (!Number.isFinite(metrics.totalTokens) || metrics.totalTokens <= 0) missingFields.push('totalTokens');
  return {
    hasMetrics: true,
    ready: missingFields.length === 0,
    missingFields,
  };
}

function formatCapturedMetricsStatus(entry) {
  if (entry.metricsReady === true) return 'metrics ready';
  const missing = Array.isArray(entry.missingMetricFields) && entry.missingMetricFields.length > 0
    ? entry.missingMetricFields.join(', ')
    : 'unknown';
  return `metrics missing ${missing}`;
}

function inspectResponseOutputFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      ok: true,
      exists: false,
      responseCount: 0,
      nonEmptyResponseCount: 0,
      emptyResponseCount: 0,
      failure: null,
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const responses = Array.isArray(parsed.responses) ? parsed.responses : [parsed];
    const counts = responses.reduce((summary, entry) => {
      const text = entry?.rawResponse === undefined ? '' : String(entry.rawResponse);
      return {
        responseCount: summary.responseCount + 1,
        nonEmptyResponseCount: summary.nonEmptyResponseCount + (text.trim() ? 1 : 0),
        emptyResponseCount: summary.emptyResponseCount + (text.trim() ? 0 : 1),
      };
    }, { responseCount: 0, nonEmptyResponseCount: 0, emptyResponseCount: 0 });
    return {
      ok: true,
      exists: true,
      ...counts,
      failure: null,
    };
  } catch (err) {
    return {
      ok: false,
      exists: true,
      responseCount: 0,
      nonEmptyResponseCount: 0,
      emptyResponseCount: 0,
      failure: `response output file could not be parsed: ${err.message}`,
    };
  }
}

function criterion(id, satisfied, evidence, reason, severity = 'failure') {
  return {
    id,
    status: satisfied ? 'passed' : severity === 'pending' ? 'pending' : 'failed',
    severity,
    evidence,
    reason: satisfied ? null : reason,
  };
}

function skippedPreflight() {
  return {
    ok: false,
    noApiCall: true,
    status: 'not_checked_until_execute_requested',
    entrypoint: ADVISOR_FIRST_CALL_CAPTURE_ENTRYPOINT,
    gate: { ok: false },
    config: { apiKeyConfigured: false, model: null },
    reasons: ['DeepSeek preflight is checked only when first-call capture execution is requested'],
  };
}

function summarizePreflight(preflight) {
  return {
    status: preflight.status || (preflight.ok ? 'ready' : 'blocked'),
    ok: preflight.ok === true,
    noApiCall: preflight.noApiCall === true,
    entrypoint: preflight.entrypoint,
    gateOk: preflight.gate?.ok === true,
    apiKeyConfigured: preflight.config?.apiKeyConfigured === true,
    baseUrl: preflight.config?.baseUrl || null,
    model: preflight.config?.model || null,
    reasons: preflight.reasons || [],
  };
}

function summarizeResponseIntake(report) {
  return {
    ok: report.ok,
    status: report.status,
    presentCount: report.presentCount,
    missingCount: report.missingCount,
    emptyCount: report.emptyCount,
    unknownCount: report.unknownCount,
    duplicateCount: report.duplicateCount,
    failures: report.failures || [],
  };
}

function summarizeCaptureInputSafety(report, outputResponseFile) {
  const outputPath = normalizeDisplayPath(outputResponseFile);
  const nonEmptyNonOutput = (report.results || [])
    .filter((result) => result.status === 'present')
    .filter((result) => normalizeDisplayPath(result.source || '').split('#')[0] !== outputPath);
  const blockingFailures = (report.failures || [])
    .filter((failure) => !/ response is empty$/.test(failure));
  const failures = [
    ...blockingFailures,
    ...nonEmptyNonOutput.map((result) => `${result.id} already has a non-empty response in ${result.source}`),
  ];
  const ok = failures.length === 0;
  return {
    ok,
    evidence: ok
      ? `response intake status ${report.status || 'unknown'}; present=${report.presentCount || 0}; empty=${report.emptyCount || 0}; non-output-present=0`
      : `response intake has ${failures.length} capture-blocking issue(s)`,
    presentCount: report.presentCount || 0,
    emptyCount: report.emptyCount || 0,
    nonOutputPresentCount: nonEmptyNonOutput.length,
    failures,
  };
}

function summarizeCaptureGuard(report) {
  return {
    ok: report.ok,
    status: report.status,
    responseDir: report.responseDir,
    ignoredByGit: report.captureVisibility?.ignoredByGit ?? null,
    trackedCaptureFileCount: report.captureVisibility?.trackedCaptureFileCount ?? 0,
    visibleUntrackedCaptureFileCount: report.captureVisibility?.visibleUntrackedCaptureFileCount ?? 0,
    failures: report.failures || [],
  };
}

function sanitizeErrorMessage(err) {
  return String(err?.message || err || 'unknown error')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-REDACTED');
}

function normalizeDisplayPath(value) {
  return String(value || '').replaceAll(path.sep, '/');
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}

export default {
  ADVISOR_FIRST_CALL_CAPTURE_EXECUTE_ENV,
  ADVISOR_FIRST_CALL_CAPTURE_OK_ENV,
  ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE_ENV,
  ADVISOR_FIRST_CALL_CAPTURE_ENTRYPOINT,
  buildAdvisorFirstCallCaptureRunPlan,
  runAdvisorFirstCallCapture,
  renderAdvisorFirstCallCaptureRun,
};
