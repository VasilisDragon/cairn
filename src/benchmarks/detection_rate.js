import crypto from 'node:crypto';
import path from 'node:path';

export const DETECTION_RATE_TARGET_ACCURACY = 0.55;
export const DETECTION_RATE_BENCHMARK_ID = 'c3_detection_rate';

const SOURCE_LABELS = new Set(['bot', 'human']);
const CLASSIFICATION_LABELS = new Set(['bot', 'human']);
const METADATA_REMOVED = Object.freeze([
  'source',
  'clip id',
  'raw path',
  'recordedAt',
  'operator',
  'server',
  'coordinates',
  'notes',
]);

export function buildDetectionRateBenchmarkReport({
  manifest = null,
  classifications = null,
  generatedAt = new Date().toISOString(),
  targetAccuracy = DETECTION_RATE_TARGET_ACCURACY,
  seed = 'mcbot-c3-detection-rate-v1',
} = {}) {
  if (!manifest) {
    return {
      ok: true,
      id: DETECTION_RATE_BENCHMARK_ID,
      status: 'pending_manifest',
      noApiCall: true,
      generatedAt,
      targetAccuracy,
      manifest: {
        clipCount: 0,
        botCount: 0,
        humanCount: 0,
        tasks: [],
        metadataStripped: true,
      },
      blindPacket: {
        itemCount: 0,
        truthHidden: true,
        metadataRemoved: [...METADATA_REMOVED],
      },
      scoring: {
        classifiedCount: 0,
        correctCount: 0,
        missingCount: 0,
        invalidCount: 0,
        accuracy: null,
        targetMet: false,
      },
      nextAction: 'Record or point the benchmark at a local bot/human clip manifest.',
    };
  }

  const packet = createBlindReviewPacket(manifest, { seed });
  const scoring = classifications
    ? scoreBlindClassifications(packet.answerKey, classifications, { targetAccuracy })
    : emptyScoring(packet.answerKey.length);
  const status = scoring.classifiedCount > 0 ? 'scored' : 'pending_classifications';

  return {
    ok: true,
    id: DETECTION_RATE_BENCHMARK_ID,
    status,
    noApiCall: true,
    generatedAt,
    targetAccuracy,
    manifest: summarizeManifest(packet.manifest),
    blindPacket: {
      itemCount: packet.items.length,
      truthHidden: true,
      metadataRemoved: [...METADATA_REMOVED],
      pathMode: 'blind-id-media-ref',
      items: packet.items,
    },
    scoring,
    nextAction: status === 'scored'
      ? 'Add more balanced bot/human clips and compare accuracy trend over time.'
      : 'Collect blind classifications for the generated packet, then rerun the benchmark.',
  };
}

export function normalizeDetectionManifest(input = {}) {
  const clips = Array.isArray(input?.clips) ? input.clips : [];
  if (clips.length === 0) throw new Error('detection-rate manifest requires at least one clip');
  const normalized = clips.map((clip, index) => normalizeClip(clip, index));
  const botCount = normalized.filter((clip) => clip.source === 'bot').length;
  const humanCount = normalized.filter((clip) => clip.source === 'human').length;
  if (botCount === 0 || humanCount === 0) {
    throw new Error('detection-rate manifest must include both bot and human clips');
  }
  return {
    version: Number(input.version || 1),
    clips: normalized,
  };
}

export function createBlindReviewPacket(manifestInput = {}, { seed = 'mcbot-c3-detection-rate-v1' } = {}) {
  const manifest = normalizeDetectionManifest(manifestInput);
  const ordered = manifest.clips
    .map((clip) => ({ clip, rank: stableHash(`${seed}:${clip.id}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank));
  const items = [];
  const answerKey = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const clip = ordered[i].clip;
    const blindId = `c3-${String(i + 1).padStart(4, '0')}`;
    const mediaRef = `${blindId}${mediaExtension(clip.path)}`;
    items.push({
      blindId,
      mediaRef,
      durationMs: clip.durationMs,
      task: clip.task,
      answerOptions: ['bot', 'human'],
    });
    answerKey.push({
      blindId,
      clipId: clip.id,
      source: clip.source,
      originalPathHash: stableHash(clip.path),
    });
  }
  return {
    benchmark: DETECTION_RATE_BENCHMARK_ID,
    manifest,
    items,
    answerKey,
    metadataRemoved: [...METADATA_REMOVED],
  };
}

export function scoreBlindClassifications(answerKey = [], classificationsInput = {}, {
  targetAccuracy = DETECTION_RATE_TARGET_ACCURACY,
} = {}) {
  const classifications = normalizeClassifications(classificationsInput);
  let correctCount = 0;
  let classifiedCount = 0;
  let missingCount = 0;
  let invalidCount = 0;
  const perItem = [];

  for (const key of answerKey || []) {
    const entry = classifications.get(key.blindId);
    if (!entry) {
      missingCount += 1;
      perItem.push({ blindId: key.blindId, status: 'missing' });
      continue;
    }
    if (!CLASSIFICATION_LABELS.has(entry.label)) {
      invalidCount += 1;
      perItem.push({ blindId: key.blindId, status: 'invalid_label' });
      continue;
    }
    classifiedCount += 1;
    const correct = entry.label === key.source;
    if (correct) correctCount += 1;
    perItem.push({ blindId: key.blindId, status: correct ? 'correct' : 'incorrect' });
  }

  const accuracy = classifiedCount > 0 ? correctCount / classifiedCount : null;
  return {
    classifiedCount,
    correctCount,
    missingCount,
    invalidCount,
    accuracy,
    targetAccuracy,
    targetMet: accuracy !== null && accuracy <= targetAccuracy,
    interpretation: accuracy === null
      ? 'pending blind classifications'
      : accuracy <= targetAccuracy
        ? 'classifier accuracy is at or below the C3 human-likeness target'
        : 'classifier accuracy is above target; behavior is still distinguishable',
    perItem,
  };
}

export function renderDetectionRateBenchmarkReport(report = {}) {
  const scoring = report.scoring || {};
  const manifest = report.manifest || {};
  const lines = [
    '# C3 Detection-Rate Benchmark',
    '',
    `- status: ${report.status || 'unknown'}`,
    `- no DeepSeek/API call made: ${report.noApiCall === true ? 'yes' : 'no'}`,
    `- target classifier accuracy: ${percent(report.targetAccuracy)}`,
    `- clip count: ${manifest.clipCount ?? 0} (${manifest.botCount ?? 0} bot, ${manifest.humanCount ?? 0} human)`,
    `- metadata stripped: ${manifest.metadataStripped === true ? 'yes' : 'no'}`,
    `- classified: ${scoring.classifiedCount ?? 0}`,
    `- accuracy: ${scoring.accuracy === null || scoring.accuracy === undefined ? 'pending' : percent(scoring.accuracy)}`,
    `- target met: ${scoring.targetMet === true ? 'yes' : 'no'}`,
    '',
    '## Blind Packet',
    '',
    '| Blind ID | Media Ref | Duration | Task |',
    '| --- | --- | ---: | --- |',
  ];
  for (const item of report.blindPacket?.items || []) {
    lines.push(`| ${escapeTable(item.blindId)} | ${escapeTable(item.mediaRef)} | ${Number(item.durationMs) || 0}ms | ${escapeTable(item.task || 'unknown')} |`);
  }
  if (!Array.isArray(report.blindPacket?.items) || report.blindPacket.items.length === 0) {
    lines.push('| pending | pending | 0ms | pending |');
  }
  lines.push(
    '',
    '## Interpretation',
    '',
    scoring.interpretation
      ? `- ${scoring.interpretation}`
      : '- Pending manifest and blind classifications.',
    `- next action: ${report.nextAction || 'continue collecting benchmark evidence'}`,
    '',
  );
  return `${lines.join('\n')}`;
}

function normalizeClip(clip, index) {
  const id = String(clip?.id || `clip-${index + 1}`).trim();
  const source = String(clip?.source || '').trim().toLowerCase();
  const clipPath = String(clip?.path || clip?.mediaPath || '').trim();
  if (!id) throw new Error(`detection-rate clip ${index + 1} is missing id`);
  if (!SOURCE_LABELS.has(source)) throw new Error(`detection-rate clip ${id} source must be bot or human`);
  if (!clipPath) throw new Error(`detection-rate clip ${id} is missing path`);
  return {
    id,
    source,
    path: clipPath,
    durationMs: positiveNumber(clip.durationMs, 0),
    task: String(clip.task || 'unknown').trim() || 'unknown',
  };
}

function normalizeClassifications(input = {}) {
  const entries = Array.isArray(input) ? input : Array.isArray(input.classifications) ? input.classifications : [];
  const out = new Map();
  for (const entry of entries) {
    const blindId = String(entry?.blindId || '').trim();
    if (!blindId) continue;
    out.set(blindId, {
      label: String(entry?.label || entry?.classification || '').trim().toLowerCase(),
    });
  }
  return out;
}

function summarizeManifest(manifest = {}) {
  const clips = Array.isArray(manifest.clips) ? manifest.clips : [];
  return {
    clipCount: clips.length,
    botCount: clips.filter((clip) => clip.source === 'bot').length,
    humanCount: clips.filter((clip) => clip.source === 'human').length,
    tasks: [...new Set(clips.map((clip) => clip.task))].sort(),
    metadataStripped: true,
  };
}

function emptyScoring(itemCount) {
  return {
    classifiedCount: 0,
    correctCount: 0,
    missingCount: itemCount,
    invalidCount: 0,
    accuracy: null,
    targetAccuracy: DETECTION_RATE_TARGET_ACCURACY,
    targetMet: false,
    interpretation: 'pending blind classifications',
    perItem: [],
  };
}

function mediaExtension(value) {
  const ext = path.extname(String(value || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  return '.clip';
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'pending';
  return `${Math.round(number * 1000) / 10}%`;
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}
