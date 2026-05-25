import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  buildDetectionRateBenchmarkReport,
  createBlindReviewPacket,
  scoreBlindClassifications,
} from '../../src/benchmarks/detection_rate.js';

const manifest = {
  clips: [
    {
      id: 'bot-run-100-64-100',
      source: 'bot',
      path: '/private-clips/server-addr-base-coords/bot-run-100-64-100.mp4',
      durationMs: 12000,
      task: 'gather_logs',
      recordedAt: '2026-05-24T00:00:00.000Z',
      operator: 'TestOperator',
      server: 'private-lan',
      coordinates: { x: 100, y: 64, z: 100 },
    },
    {
      id: 'human-run-secret-base',
      source: 'human',
      path: '/private-clips/human-secret-base-run.mp4',
      durationMs: 11000,
      task: 'gather_logs',
      notes: 'contains private base path',
    },
  ],
};

test('detection-rate blind packet hides truth labels and identifying metadata', () => {
  const packet = createBlindReviewPacket(manifest, { seed: 'unit-test' });

  assert.equal(packet.items.length, 2);
  assert.equal(packet.answerKey.length, 2);
  assert.equal(packet.items.every((item) => item.answerOptions.includes('bot') && item.answerOptions.includes('human')), true);
  assert.equal(JSON.stringify(packet.items).includes('TestOperator'), false);
  assert.equal(JSON.stringify(packet.items).includes('100-64-100'), false);
  assert.equal(JSON.stringify(packet.items).includes('secret-base'), false);
  assert.equal(JSON.stringify(packet.items).includes('source'), false);
  assert.equal(packet.answerKey.every((entry) => entry.source === 'bot' || entry.source === 'human'), true);
  assert.equal(packet.answerKey.every((entry) => /^[a-f0-9]{64}$/.test(entry.originalPathHash)), true);
});

test('detection-rate scoring reports accuracy against the C3 target', () => {
  const packet = createBlindReviewPacket(manifest, { seed: 'unit-test' });
  const classifications = {
    classifications: packet.answerKey.map((entry) => ({
      blindId: entry.blindId,
      label: entry.source === 'bot' ? 'human' : 'bot',
    })),
  };

  const scoring = scoreBlindClassifications(packet.answerKey, classifications, { targetAccuracy: 0.55 });

  assert.equal(scoring.classifiedCount, 2);
  assert.equal(scoring.correctCount, 0);
  assert.equal(scoring.accuracy, 0);
  assert.equal(scoring.targetMet, true);
});

test('detection-rate report supports pending and scored states without API calls', () => {
  const pending = buildDetectionRateBenchmarkReport();
  assert.equal(pending.ok, true);
  assert.equal(pending.status, 'pending_manifest');
  assert.equal(pending.noApiCall, true);

  const packet = createBlindReviewPacket(manifest, { seed: 'scored' });
  const scored = buildDetectionRateBenchmarkReport({
    manifest,
    classifications: {
      classifications: packet.answerKey.map((entry) => ({ blindId: entry.blindId, label: entry.source })),
    },
    seed: 'scored',
  });
  assert.equal(scored.status, 'scored');
  assert.equal(scored.scoring.accuracy, 1);
  assert.equal(scored.scoring.targetMet, false);
});

test('detection-rate CLI writes public report and blind packet without source labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-detection-rate-'));
  try {
    const manifestPath = path.join(dir, 'manifest.json');
    const classificationsPath = path.join(dir, 'classifications.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const packet = createBlindReviewPacket(manifest, { seed: 'cli' });
    fs.writeFileSync(classificationsPath, `${JSON.stringify({
      classifications: packet.answerKey.map((entry) => ({ blindId: entry.blindId, label: entry.source })),
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      'scripts/detection-rate-benchmark.js',
      '--manifest', manifestPath,
      '--classifications', classificationsPath,
      '--report-dir', dir,
      '--seed', 'cli',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /detection-rate-benchmark: wrote/);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'detection-rate-benchmark.json'), 'utf8'));
    const packetOutText = fs.readFileSync(path.join(dir, 'detection-rate-blind-packet.json'), 'utf8');
    const packetOut = JSON.parse(packetOutText);
    assert.equal(report.status, 'scored');
    assert.equal(report.noApiCall, true);
    assert.equal(packetOut.items.some((item) => Object.hasOwn(item, 'source')), false);
    assert.equal(packetOutText.includes('TestOperator'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
