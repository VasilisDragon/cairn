import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR } from './dry_run_calibration.js';
export const DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS = Object.freeze([
  Object.freeze({ path: 'reports/advisor-dry-run.json' }),
  Object.freeze({ path: 'reports/advisor-first-call.json' }),
  Object.freeze({ path: 'reports/advisor-first-call-replay.json' }),
  Object.freeze({ path: 'reports/advisor-combat-calibration.json', optional: true }),
  Object.freeze({ path: 'reports/advisor-combat-proposal-expansion.json', optional: true }),
  Object.freeze({ path: 'reports/advisor-combat-autonomy-gate.json', optional: true }),
  Object.freeze({ path: 'reports/advisor-f3-calibration.json', optional: true }),
  Object.freeze({ path: 'reports/advisor-f3-replay.json', optional: true }),
  Object.freeze({ path: 'reports/advisor-f3-response-capture-guard.json', optional: true }),
  Object.freeze({ path: 'reports/capability-matrix.json', optional: true }),
  Object.freeze({ path: 'reports/phase-shift-readiness.json', optional: true }),
  Object.freeze({ path: 'reports/deterministic-eval.json', optional: true }),
  textReport('reports/advisor-dry-run.md'),
  textReport('reports/advisor-first-call.md'),
  textReport('reports/advisor-first-call-replay.md'),
  textReport('reports/advisor-combat-calibration.md', { optional: true }),
  textReport('reports/advisor-combat-proposal-expansion.md', { optional: true }),
  textReport('reports/advisor-combat-autonomy-gate.md', { optional: true }),
  textReport('reports/advisor-f3-calibration.md', { optional: true }),
  textReport('reports/advisor-f3-replay.md', { optional: true }),
  textReport('reports/advisor-f3-response-capture-guard.md', { optional: true }),
  textReport('reports/capability-matrix.md', { optional: true }),
  textReport('reports/phase-shift-readiness.md', { optional: true }),
  textReport('reports/deterministic-eval.md', { optional: true }),
]);

export const DEFAULT_ADVISOR_REPORT_FORBIDDEN_TEXT = Object.freeze([
  Object.freeze({
    id: 'possible_provider_secret_token',
    pattern: /\bsk-[A-Za-z0-9_-]{6,}\b/,
  }),
  Object.freeze({
    id: 'raw_first_call_request_messages',
    pattern: /"messages"\s*:/,
  }),
  Object.freeze({
    id: 'raw_first_call_prompt_payload',
    pattern: /\b(?:advisorContract|currentState|Produce the initial plan)\b/,
  }),
]);

export function evaluateAdvisorResponseCaptureGuard(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const responseDir = opts.responseDir || DEFAULT_ADVISOR_FIRST_CALL_RESPONSE_DIR;
  const gitRunner = opts.gitRunner || defaultGitRunner;
  const reportChecks = opts.reportChecks || DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS;
  const readFile = opts.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const exists = opts.exists || ((filePath) => fs.existsSync(filePath));
  const forbiddenText = opts.forbiddenText || DEFAULT_ADVISOR_REPORT_FORBIDDEN_TEXT;

  const captureVisibility = inspectCaptureDirGitVisibility({
    root,
    responseDir,
    gitRunner,
  });
  const reports = reportChecks.map((check) => inspectReport({
    root,
    check,
    readFile,
    exists,
    forbiddenText,
  }));
  const failures = [
    ...captureVisibility.failures,
    ...reports.flatMap((report) => report.failures),
  ];
  const ok = failures.length === 0;

  return {
    ok,
    noApiCall: true,
    status: ok ? 'private_capture_guard_passed' : 'blocked',
    responseDir,
    captureVisibility,
    reports,
    failures,
  };
}

export function renderAdvisorResponseCaptureGuard(report) {
  const lines = [
    '# Advisor Response Capture Guard',
    '',
    `- no API call made: ${report.noApiCall === true ? 'yes' : 'unknown'}`,
    `- status: ${report.status}`,
    `- response dir: ${report.responseDir}`,
    `- capture dir location: ${report.captureVisibility.location}`,
    `- ignored by git: ${report.captureVisibility.ignoredByGit ? 'yes' : 'no'}`,
    `- tracked capture file count: ${report.captureVisibility.trackedCaptureFileCount}`,
    `- visible untracked capture file count: ${report.captureVisibility.visibleUntrackedCaptureFileCount}`,
    '',
    '## Report Checks',
    '',
    '| Report | Kind | Status | Response fields | Non-empty | Provider payloads | Forbidden text |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
  ];

  for (const check of report.reports || []) {
    lines.push(`| ${escapeTable(check.path)} | ${check.format || 'json'} | ${check.status} | ${check.responseFieldCount} | ${check.nonEmptyResponseFieldCount} | ${check.providerPayloadCount || 0} | ${(check.forbiddenTextMatches || []).length} |`);
  }

  lines.push('', '## Failures', '');
  if (!Array.isArray(report.failures) || report.failures.length === 0) {
    lines.push('- none');
  } else {
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }

  return `${lines.join('\n')}\n`;
}

function inspectCaptureDirGitVisibility({
  root,
  responseDir,
  gitRunner,
}) {
  const normalized = normalizeRepoPath(root, responseDir);
  if (!normalized.insideRoot) {
    return {
      location: 'external_to_repo',
      responseDir: normalized.displayPath,
      ignoredByGit: null,
      trackedCaptureFileCount: 0,
      visibleUntrackedCaptureFileCount: 0,
      gitChecks: [],
      failures: [],
    };
  }

  const gitPath = normalized.repoPath;
  const probePath = `${gitPath.replace(/\/+$/, '')}/_guard_probe.json`;
  const ignoreCheck = runGit(gitRunner, ['check-ignore', '--quiet', '--', probePath], root);
  const trackedCheck = runGit(gitRunner, ['ls-files', '--', gitPath], root);
  const visibleUntrackedCheck = runGit(gitRunner, ['ls-files', '--others', '--exclude-standard', '--', gitPath], root);
  const trackedCount = splitGitLines(trackedCheck.stdout).length;
  const visibleUntrackedCount = splitGitLines(visibleUntrackedCheck.stdout).length;
  const failures = [];

  if (ignoreCheck.exitCode !== 0) {
    failures.push(`${responseDir} is not ignored by git; add it to .gitignore before capturing real model responses`);
  }
  if (trackedCheck.exitCode !== 0) {
    failures.push(`git ls-files failed for ${responseDir}`);
  } else if (trackedCount > 0) {
    failures.push(`${responseDir} has ${trackedCount} tracked capture file(s); remove them from the index before using real responses`);
  }
  if (visibleUntrackedCheck.exitCode !== 0) {
    failures.push(`git untracked visibility check failed for ${responseDir}`);
  } else if (visibleUntrackedCount > 0) {
    failures.push(`${responseDir} has ${visibleUntrackedCount} visible untracked capture file(s); ignored private captures should not appear in git status`);
  }

  return {
    location: 'inside_repo',
    responseDir: gitPath,
    ignoredByGit: ignoreCheck.exitCode === 0,
    trackedCaptureFileCount: trackedCount,
    visibleUntrackedCaptureFileCount: visibleUntrackedCount,
    gitChecks: [
      summarizeGitCheck('check-ignore', ignoreCheck),
      summarizeGitCheck('tracked', trackedCheck),
      summarizeGitCheck('visible-untracked', visibleUntrackedCheck),
    ],
    failures,
  };
}

function inspectReport({
  root,
  check,
  readFile,
  exists,
  forbiddenText = DEFAULT_ADVISOR_REPORT_FORBIDDEN_TEXT,
}) {
  const reportPath = check.path;
  const format = check.format || 'json';
  const absolutePath = path.resolve(root, reportPath);
  if (!exists(absolutePath)) {
    if (check.optional === true) {
      return {
        path: reportPath,
        format,
        status: 'missing_optional',
        responseFieldCount: 0,
        emptyResponseFieldCount: 0,
        nonEmptyResponseFieldCount: 0,
        providerPayloadCount: 0,
        forbiddenTextMatches: [],
        failures: [],
      };
    }
    return {
      path: reportPath,
      format,
      status: 'missing',
      responseFieldCount: 0,
      emptyResponseFieldCount: 0,
      nonEmptyResponseFieldCount: 0,
      providerPayloadCount: 0,
      failures: [`${reportPath} is missing; cannot prove generated reports avoid captured model responses`],
    };
  }

  let text = '';
  try {
    text = readFile(absolutePath);
    if (format === 'text') {
      const forbiddenMatches = collectForbiddenReportText(text, forbiddenText);
      const failures = forbiddenMatches.map((match) => `${reportPath} contains forbidden public report text pattern ${match.id}`);
      const providerPayloads = collectProviderPayloadsFromText(text);
      if (providerPayloads.length > 0) {
        failures.push(`${reportPath} contains ${providerPayloads.length} provider-shaped response payload(s)`);
      }

      return {
        path: reportPath,
        format,
        status: failures.length === 0 ? 'passed' : 'blocked',
        responseFieldCount: 0,
        emptyResponseFieldCount: 0,
        nonEmptyResponseFieldCount: 0,
        providerPayloadCount: providerPayloads.length,
        forbiddenTextMatches: forbiddenMatches,
        failures,
      };
    }

    const parsed = JSON.parse(text);
    const fields = collectResponseFields(parsed);
    const providerPayloads = collectProviderPayloads(parsed);
    const emptyCount = fields.filter((field) => field.kind === 'empty_string').length;
    const nonEmptyCount = fields.length - emptyCount;
    const forbiddenMatches = collectForbiddenReportText(text, forbiddenText);
    const failures = forbiddenMatches.map((match) => `${reportPath} contains forbidden public report text pattern ${match.id}`);

    if (providerPayloads.length > 0) {
      failures.push(`${reportPath} contains ${providerPayloads.length} provider-shaped response payload(s)`);
    }
    if (nonEmptyCount > 0) {
      failures.push(`${reportPath} contains ${nonEmptyCount} non-empty captured response field(s)`);
    }
    if (!check.allowEmptyResponseFields && fields.length > 0) {
      failures.push(`${reportPath} contains ${fields.length} captured response field(s); generated summary reports must omit raw model response fields`);
    }

    return {
      path: reportPath,
      format,
      status: failures.length === 0 ? 'passed' : 'blocked',
      responseFieldCount: fields.length,
      emptyResponseFieldCount: emptyCount,
      nonEmptyResponseFieldCount: nonEmptyCount,
      providerPayloadCount: providerPayloads.length,
      forbiddenTextMatches: forbiddenMatches,
      failures,
    };
  } catch {
    const providerPayloads = collectProviderPayloadsFromText(text);
    const forbiddenMatches = collectForbiddenReportText(text, forbiddenText);
    const failures = forbiddenMatches.map((match) => `${reportPath} contains forbidden public report text pattern ${match.id}`);
    if (providerPayloads.length > 0) {
      failures.push(`${reportPath} contains ${providerPayloads.length} provider-shaped response payload(s)`);
    }
    failures.push(`${reportPath} could not be read or parsed safely`);
    return {
      path: reportPath,
      format,
      status: 'parse_failed',
      responseFieldCount: 0,
      emptyResponseFieldCount: 0,
      nonEmptyResponseFieldCount: 0,
      providerPayloadCount: providerPayloads.length,
      forbiddenTextMatches: forbiddenMatches,
      failures,
    };
  }
}

function textReport(reportPath, opts = {}) {
  return Object.freeze({
    ...opts,
    path: reportPath,
    format: 'text',
  });
}

function collectForbiddenReportText(text, checks = []) {
  const out = [];
  for (const check of checks) {
    const pattern = check?.pattern;
    if (!(pattern instanceof RegExp)) continue;
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      out.push({ id: check.id || 'forbidden_text' });
    }
  }
  return out;
}

function collectResponseFields(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectResponseFields(entry, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'rawResponse') {
      out.push({
        kind: child === '' ? 'empty_string' : 'non_empty_or_non_string',
      });
      continue;
    }
    collectResponseFields(child, out);
  }
  return out;
}

function collectProviderPayloads(value, out = []) {
  if (typeof value === 'string') {
    collectProviderPayloadsFromText(value, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectProviderPayloads(entry, out);
    return out;
  }

  if (isProviderResponsePayload(value)) {
    out.push({ kind: 'provider_response_payload' });
    return out;
  }

  for (const child of Object.values(value)) {
    collectProviderPayloads(child, out);
  }
  return out;
}

function isProviderResponsePayload(value) {
  if (Array.isArray(value.choices) && value.choices.some(isProviderChoicePayload)) return true;
  if (typeof value.output_text === 'string' && value.output_text.trim()) return true;
  if (Array.isArray(value.output) && value.output.some(isResponsesApiOutputPayload)) return true;
  return hasProviderUsage(value.usage) && hasProviderEnvelopeContent(value);
}

function isProviderChoicePayload(choice) {
  if (!choice || typeof choice !== 'object') return false;
  if (typeof choice.text === 'string' && choice.text.trim()) return true;
  if (typeof choice.reasoning_content === 'string' && choice.reasoning_content.trim()) return true;
  if (typeof choice.message?.content === 'string' && choice.message.content.trim()) return true;
  if (typeof choice.message?.reasoning_content === 'string' && choice.message.reasoning_content.trim()) return true;
  if (typeof choice.delta?.content === 'string' && choice.delta.content.trim()) return true;
  if (typeof choice.delta?.reasoning_content === 'string' && choice.delta.reasoning_content.trim()) return true;
  return false;
}

function hasProviderUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  return ['prompt_tokens', 'completion_tokens', 'total_tokens']
    .some((field) => Number.isFinite(usage[field]));
}

function hasProviderEnvelopeContent(value) {
  if (Array.isArray(value.choices)) return true;
  if (typeof value.output_text === 'string' && value.output_text.trim()) return true;
  return isProviderChoicePayload(value)
    || isProviderChoicePayload(value.message)
    || isProviderChoicePayload(value.delta);
}

function isResponsesApiOutputPayload(output) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.content)) return false;
  return output.content.some((part) => (
    part && typeof part === 'object'
    && part.type === 'output_text'
    && typeof part.text === 'string'
    && part.text.trim()
  ));
}

function collectProviderPayloadsFromText(value, out = [], decodeDepth = 0) {
  const text = String(value || '');
  if (!text || decodeDepth > 4) return out;

  const candidates = [
    ...jsonObjectCandidates(text),
    ...jsonStringCandidates(text),
  ];
  let parsedProviderCount = 0;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const before = out.length;
      if (typeof parsed === 'string') {
        collectProviderPayloadsFromText(parsed, out, decodeDepth + 1);
      } else {
        collectProviderPayloads(parsed, out);
      }
      parsedProviderCount += out.length - before;
    } catch {
      // Truncated candidates are handled by the compound signature check below.
    }
  }

  if (parsedProviderCount === 0 && hasTruncatedProviderPayloadSignature(text)) {
    out.push({ kind: 'truncated_provider_response_payload' });
  }
  return out;
}

function jsonStringCandidates(text) {
  const candidates = new Set();
  for (let start = 0; start < text.length && candidates.size < 512; start++) {
    if (text[start] !== '"') continue;
    let escaped = false;
    for (let index = start + 1; index < text.length; index++) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        candidates.add(text.slice(start, index + 1));
        start = index;
        break;
      }
    }
  }
  return [...candidates];
}

function jsonObjectCandidates(text) {
  const candidates = new Set();
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (depth === 0) {
      if (char === '{' || char === '[') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.add(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return [...candidates];
}

function hasTruncatedProviderPayloadSignature(text) {
  return providerSignatureTextVariants(text).some(hasDirectProviderPayloadSignature);
}

function hasDirectProviderPayloadSignature(text) {
  const choices = /"choices"\s*:\s*\[/.test(text);
  const messageContent = /"(?:message|delta)"\s*:\s*\{[\s\S]{0,32768}?"(?:content|reasoning_content)"\s*:/.test(text);
  const choiceText = /"(?:text|content|reasoning_content)"\s*:\s*"[^"\r\n]/.test(text);
  if (choices && (messageContent || choiceText)) return true;

  const outputText = /"output_text"\s*:\s*"[^"\r\n]/.test(text);
  if (outputText) return true;
  const responsesOutputText = /"type"\s*:\s*"output_text"[\s\S]{0,32768}?"text"\s*:/.test(text);
  if (responsesOutputText) return true;

  const usage = /"usage"\s*:\s*\{/.test(text);
  const tokenCounts = /"(?:prompt_tokens|completion_tokens|total_tokens)"\s*:/.test(text);
  return usage && tokenCounts && (choices || outputText || messageContent);
}

function providerSignatureTextVariants(text) {
  const variants = [text];
  let current = text;
  for (let depth = 0; depth < 4; depth++) {
    const next = current.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    if (next === current) break;
    variants.push(next);
    current = next;
  }
  return variants;
}

function normalizeRepoPath(root, candidatePath) {
  const absolute = path.resolve(root, candidatePath);
  const relative = path.relative(root, absolute);
  const insideRoot = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return {
    insideRoot,
    displayPath: slash(candidatePath),
    repoPath: insideRoot ? slash(relative || '.') : slash(absolute),
  };
}

function runGit(gitRunner, args, cwd) {
  const result = gitRunner(args, { cwd }) || {};
  return {
    exitCode: typeof result.status === 'number' ? result.status : (result.exitCode ?? 1),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function defaultGitRunner(args, { cwd }) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
}

function summarizeGitCheck(name, result) {
  return {
    name,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
  };
}

function splitGitLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function slash(value) {
  return String(value || '').replaceAll('\\', '/');
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}

export default {
  DEFAULT_ADVISOR_RESPONSE_CAPTURE_REPORTS,
  DEFAULT_ADVISOR_REPORT_FORBIDDEN_TEXT,
  evaluateAdvisorResponseCaptureGuard,
  renderAdvisorResponseCaptureGuard,
};
