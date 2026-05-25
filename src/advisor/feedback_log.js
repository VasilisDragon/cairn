import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const DEFAULT_ADVISOR_FEEDBACK_LOG = path.join(ROOT, 'data', 'advisor-feedback', 'advisor-feedback.jsonl');

const TYPES = new Set(['deterministic_gap', 'postmortem_lesson', 'feature_request', 'strategy_lesson']);
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);

export function buildAdvisorFeedbackEntry(input = {}, opts = {}) {
  const type = TYPES.has(input.type) ? input.type : 'strategy_lesson';
  const summary = cleanText(input.summary, 240);
  if (!summary) return { ok: false, reason: 'advisor feedback summary is required' };
  const now = opts.now || new Date().toISOString();
  const entry = {
    version: 1,
    createdAt: now,
    type,
    severity: SEVERITIES.has(input.severity) ? input.severity : 'medium',
    source: cleanText(input.source || 'advisor', 80),
    summary,
    reviewRequired: true,
    executionAuthority: 'none',
  };

  copyText(entry, input, 'task', 240);
  copyText(entry, input, 'currentSkill', 120);
  copyText(entry, input, 'failureReason', 320);
  copyText(entry, input, 'suggestedDeterministicChange', 480);
  copyText(entry, input, 'recommendedFutureBehavior', 480);
  copyText(entry, input, 'reproductionHint', 480);
  copyNumber(entry, input, 'confidence', 0, 1);
  if (input.snapshotKey && typeof input.snapshotKey === 'object' && !Array.isArray(input.snapshotKey)) {
    entry.snapshotKey = sanitizeValue(input.snapshotKey, { maxDepth: 4, maxArrayLength: 16, maxObjectKeys: 24, maxStringLength: 240 });
  }
  if (input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)) {
    entry.evidence = sanitizeValue(input.evidence, { maxDepth: 5, maxArrayLength: 24, maxObjectKeys: 32, maxStringLength: 480 });
  }

  return { ok: true, entry };
}

export function appendAdvisorFeedback(input = {}, opts = {}) {
  const built = buildAdvisorFeedbackEntry(input, opts);
  if (!built.ok) return built;
  const filePath = opts.filePath || DEFAULT_ADVISOR_FEEDBACK_LOG;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(built.entry) + '\n');
  return {
    ok: true,
    filePath,
    entry: built.entry,
  };
}

export function advisorFeedbackContract() {
  return {
    destination: 'data/advisor-feedback/advisor-feedback.jsonl',
    writer: 'appendAdvisorFeedback',
    purpose: 'advisor-visible issues, deterministic gaps, postmortems, and feature suggestions for human review',
    executionAuthority: 'none; feedback entries do not change runtime behavior or bypass validators',
    reviewRequired: true,
    allowedTypes: [...TYPES],
    allowedSeverities: [...SEVERITIES],
  };
}

function copyText(out, input, key, maxLength) {
  const text = cleanText(input[key], maxLength);
  if (text) out[key] = text;
}

function copyNumber(out, input, key, min, max) {
  if (!Number.isFinite(input[key])) return;
  out[key] = Math.min(max, Math.max(min, Number(input[key])));
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  return redactSecrets(String(value).replace(/\s+/g, ' ').trim()).slice(0, maxLength);
}

function sanitizeValue(value, limits, depth = 0, seen = new WeakSet()) {
  if (value === null) return null;
  if (typeof value === 'string') return redactSecrets(value).slice(0, limits.maxStringLength);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  if (depth >= limits.maxDepth) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, limits.maxArrayLength)
        .map((item) => sanitizeValue(item, limits, depth + 1, seen));
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, limits.maxObjectKeys)
        .map(([key, item]) => [String(key).slice(0, 80), sanitizeValue(item, limits, depth + 1, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

function redactSecrets(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-REDACTED')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9_.-]+/gi, '$1REDACTED');
}
