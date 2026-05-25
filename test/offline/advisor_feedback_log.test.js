import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  advisorFeedbackContract,
  appendAdvisorFeedback,
  buildAdvisorFeedbackEntry,
} from '../../src/advisor/feedback_log.js';

test('advisor feedback entries require a summary and never grant execution authority', () => {
  const missing = buildAdvisorFeedbackEntry({ type: 'deterministic_gap' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'advisor feedback summary is required');

  const built = buildAdvisorFeedbackEntry({
    type: 'deterministic_gap',
    severity: 'high',
    summary: 'Need a place_workstation skill before portable mining field kits can be live-proven.',
    suggestedDeterministicChange: 'Add bounded crafting_table/furnace placement with world-model do-not-touch checks.',
    confidence: 0.9,
    snapshotKey: { position: { x: 1, y: 64, z: 2 }, unsafe: Infinity },
  }, { now: '2026-05-23T12:00:00.000Z' });

  assert.equal(built.ok, true);
  assert.equal(built.entry.createdAt, '2026-05-23T12:00:00.000Z');
  assert.equal(built.entry.type, 'deterministic_gap');
  assert.equal(built.entry.severity, 'high');
  assert.equal(built.entry.reviewRequired, true);
  assert.equal(built.entry.executionAuthority, 'none');
  assert.equal(built.entry.snapshotKey.unsafe, null);
});

test('advisor feedback log appends sanitized jsonl for human review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-advisor-feedback-'));
  const filePath = path.join(dir, 'feedback.jsonl');

  const first = appendAdvisorFeedback({
    type: 'postmortem_lesson',
    severity: 'critical',
    summary: 'Bot died because it kept trying to climb a one-block-high water bank.',
    failureReason: 'private detail sk-testsecret should be redacted',
    recommendedFutureBehavior: 'Prefer a lower shoreline exit or swim farther before climbing.',
  }, { filePath, now: '2026-05-23T12:01:00.000Z' });
  const second = appendAdvisorFeedback({
    type: 'feature_request',
    summary: 'A portable workstation placement skill would avoid walking back to base for smelting.',
  }, { filePath, now: '2026-05-23T12:02:00.000Z' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'postmortem_lesson');
  assert.equal(rows[0].failureReason.includes('sk-testsecret'), false);
  assert.match(rows[0].failureReason, /sk-REDACTED/);
  assert.equal(rows[1].type, 'feature_request');
});

test('advisor feedback contract documents non-authoritative improvement suggestions', () => {
  const contract = advisorFeedbackContract();

  assert.match(contract.destination, /advisor-feedback/);
  assert.equal(contract.executionAuthority.startsWith('none'), true);
  assert.equal(contract.reviewRequired, true);
  assert.ok(contract.allowedTypes.includes('deterministic_gap'));
  assert.ok(contract.allowedTypes.includes('postmortem_lesson'));
});
