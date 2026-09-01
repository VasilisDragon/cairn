import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countItems } from './materials.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_WORLD_MODEL_PATH = path.join(ROOT, 'data', 'world-model', 'world-model.json');
export const WORLD_MODEL_STORE_LIVE_SNAPSHOT = Symbol.for('mcbot.worldModelStoreLiveSnapshot.v1');

const RESOURCE_BLOCKS = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore',
  'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
]);

const HAZARD_BLOCKS = new Set([
  'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose',
]);

const STORAGE_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest']);
const WORKSTATION_BLOCKS = new Set([
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'smithing_table', 'cartography_table',
  'fletching_table', 'stonecutter', 'grindstone', 'loom', 'brewing_stand', 'cauldron', 'composter',
  'lectern',
]);
const VILLAGE_MARKERS = new Set(['bell', 'hay_block', 'lantern', 'white_bed', 'yellow_bed', 'red_bed']);

const PROCESSED_NAMES = new Set([
  ...STORAGE_BLOCKS,
  ...WORKSTATION_BLOCKS,
  ...VILLAGE_MARKERS,
  'torch', 'wall_torch', 'soul_torch',
  'glass', 'glass_pane', 'white_stained_glass', 'white_stained_glass_pane',
  'oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
  'oak_fence', 'birch_fence', 'spruce_fence', 'cobblestone_wall',
  'bricks', 'stone_bricks', 'cobblestone', 'mossy_cobblestone',
]);

const PROCESSED_SUFFIXES = [
  '_planks', '_stairs', '_slab', '_fence', '_fence_gate', '_door', '_trapdoor',
  '_bricks', '_brick_wall', '_glass', '_glass_pane',
];

export function createEmptyWorldModel(opts = {}) {
  const now = opts.now || new Date().toISOString();
  return {
    version: 1,
    updatedAt: now,
    markers: {
      home: opts.home ? vec(opts.home) : null,
      origin: opts.origin ? vec(opts.origin) : null,
    },
    visitedAreas: [],
    resourceSightings: [],
    hazardSightings: [],
    storageSightings: [],
    interestingRegions: [],
    doNotTouchRegions: [],
  };
}

export class WorldModelStore {
  #snapshotListeners = new Set();

  #snapshotRevision = 0;

  constructor(filePath = DEFAULT_WORLD_MODEL_PATH) {
    this.filePath = filePath;
    Object.defineProperty(this, WORLD_MODEL_STORE_LIVE_SNAPSHOT, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  load() {
    try {
      const model = fs.existsSync(this.filePath)
        ? JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
        : createEmptyWorldModel();
      this.#publishSnapshot({ model, source: 'load' });
      return model;
    } catch (error) {
      this.#publishSnapshot({ error, source: 'load' });
      throw error;
    }
  }

  save(model) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(model, null, 2) + '\n');
      this.#publishSnapshot({ model, source: 'save' });
    } catch (error) {
      this.#publishSnapshot({ error, source: 'save' });
      throw error;
    }
  }

  /**
   * Subscribe to same-process authoritative world-model reads and writes.
   * Runtime policy treats this store as the sole writer while connected; direct
   * external edits are not accepted as a live policy update until load() sees
   * them. The synchronous notification lets movement use an in-memory DNT
   * snapshot without rereading and reparsing this file for every pose packet.
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('world-model snapshot listener must be a function');
    }
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  #publishSnapshot({ model = null, error = null, source }) {
    this.#snapshotRevision = this.#snapshotRevision >= Number.MAX_SAFE_INTEGER
      ? 1
      : this.#snapshotRevision + 1;
    const update = Object.freeze({
      model,
      error,
      source,
      revision: this.#snapshotRevision,
    });
    for (const listener of this.#snapshotListeners) {
      try {
        listener(update);
      } catch {
        // Snapshot consumers are advisory observers of an already-completed
        // store operation and cannot change its success or persisted result.
      }
    }
  }

  ingestBlockSamples(samples, opts = {}) {
    const model = this.load();
    ingestBlockSamples(model, samples, opts);
    this.save(model);
    return model;
  }
}

export async function ingestVisibleWorld(bot, store = new WorldModelStore(), opts = {}) {
  const chunks = await awaitBotChunksReady(bot, opts.signal, 'reactive preempt waiting for visible-world chunk readiness');
  if (chunks.preempted) return { preempted: true, reason: chunks.reason };
  if (chunks.error) return { ok: false, reason: `chunk data unavailable during visible-world ingest: ${errorMessage(chunks.error)}` };
  try {
    const samples = collectVisibleBlockSamples(bot, opts);
    if (opts.signal?.aborted) return { preempted: true, reason: 'reactive preempt during visible-world ingest' };
    const source = opts.source || 'bot-visible';
    const model = store.ingestBlockSamples(samples, { ...opts, source });
    if (opts.signal?.aborted) return { preempted: true, reason: 'reactive preempt during visible-world ingest' };
    return model;
  } catch (err) {
    if (opts.signal?.aborted) return { preempted: true, reason: 'reactive preempt during visible-world ingest' };
    return { ok: false, reason: `visible-world ingest failed: ${errorMessage(err)}` };
  }
}

export function collectVisibleBlockSamples(bot, opts = {}) {
  const pos = bot.entity?.position;
  if (!pos) return [];

  const radius = opts.radius ?? 6;
  const yMin = opts.yMin ?? -4;
  const yMax = opts.yMax ?? 4;
  const step = opts.step ?? 1;
  const limit = opts.limit ?? 2000;
  const origin = {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
  };
  const samples = [];

  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dy = yMin; dy <= yMax; dy += step) {
      for (let dz = -radius; dz <= radius; dz += step) {
        if (samples.length >= limit) return samples;
        const probe = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
        const block = bot.blockAt?.(probe);
        if (!block || !block.name || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
        samples.push({
          name: block.name,
          position: block.position ? vec(block.position) : probe,
          biome: block.biome?.name || block.biome || null,
        });
      }
    }
  }

  return samples;
}

export function ingestBlockSamples(model, samples, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const normalized = samples.map(normalizeSample).filter(Boolean);
  if (normalized.length === 0) {
    model.updatedAt = now;
    return model;
  }

  const bbox = bboxFor(normalized);
  model.updatedAt = now;
  if (opts.home && !model.markers.home) model.markers.home = vec(opts.home);
  if (opts.origin && !model.markers.origin) model.markers.origin = vec(opts.origin);
  upsertVisitedArea(model, bbox, { now, source: opts.source || 'synthetic' });

  for (const sample of normalized) {
    addTypedSighting(model.resourceSightings, sample, RESOURCE_BLOCKS, 'resource', now);
    addTypedSighting(model.hazardSightings, sample, HAZARD_BLOCKS, 'hazard', now);
    addTypedSighting(model.storageSightings, sample, STORAGE_BLOCKS, 'storage', now);
  }

  const region = classifyBlockRegion(normalized, {
    id: `region_${String(model.interestingRegions.length + 1).padStart(3, '0')}`,
  });
  if (region.classification !== 'natural') {
    const savedRegion = upsertInterestingRegion(model, region, now);
    if (region.recommendedPolicy === 'avoid_breaking_and_log_for_human_review') {
      upsertDoNotTouchRegion(model, {
        id: savedRegion.id,
        bbox: savedRegion.bbox,
        reason: region.classification,
        confidence: region.confidence,
      }, now);
    }
  }

  return model;
}

export function classifyBlockRegion(samples, opts = {}) {
  const normalized = samples.map(normalizeSample).filter(Boolean);
  const total = normalized.length;
  const bbox = total > 0 ? bboxFor(normalized) : { min: [0, 0, 0], max: [0, 0, 0] };
  const counts = countBlocks(normalized);
  const processed = normalized.filter((sample) => isProcessedBlock(sample.name));
  const processedNames = new Set(processed.map((sample) => sample.name));
  const signals = [];

  if (processed.length >= 3) signals.push('crafted_blocks');
  const craftedDensity = total === 0 ? 0 : processed.length / total;
  if (craftedDensity >= 0.35) signals.push('crafted_block_density');
  if (hasNameMatching(processedNames, (name) => name.endsWith('_door'))) signals.push('door_present');
  if (hasNameMatching(processedNames, (name) => name.includes('glass'))) signals.push('glass_present');
  if (hasAny(processedNames, STORAGE_BLOCKS)) signals.push('storage_present');
  if (hasAny(processedNames, WORKSTATION_BLOCKS)) signals.push('workstation_present');
  if (hasAny(processedNames, VILLAGE_MARKERS)) signals.push('village_marker');
  if (hasNameMatching(processedNames, (name) => name.includes('torch') || name === 'lantern')) signals.push('lighting_present');
  if (detectRectangularFootprint(processed)) signals.push('rectangular_planes', 'right_angles');
  if (detectVerticalPlane(processed)) signals.push('vertical_plane');

  const dominantBlocks = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name]) => name);

  const confidence = confidenceFor({ craftedDensity, signals });
  let classification = 'natural';
  let recommendedPolicy = 'normal';

  if (signals.includes('village_marker') && signals.includes('crafted_blocks')) {
    classification = 'artificial_or_generated_structure';
  } else if (
    (signals.includes('storage_present') || signals.includes('workstation_present')) &&
    processed.length <= 3
  ) {
    classification = 'player_interesting';
  } else if (confidence >= 0.55) {
    classification = 'likely_player_made';
  }

  if (classification !== 'natural') {
    recommendedPolicy = 'avoid_breaking_and_log_for_human_review';
  }

  return {
    id: opts.id || 'region_001',
    bbox,
    classification,
    confidence,
    signals,
    dominantBlocks,
    recommendedPolicy,
  };
}

export function buildAdvisorWorldModelSummary(model, opts = {}) {
  const limit = opts.limit ?? 8;
  return {
    markers: model.markers,
    interestingRegions: model.interestingRegions.slice(-limit).map(compactRegion),
    doNotTouchRegions: model.doNotTouchRegions.slice(-limit),
    recentResources: model.resourceSightings.slice(-limit).map(compactSighting),
    recentHazards: model.hazardSightings.slice(-limit).map(compactSighting),
    knownStorage: model.storageSightings.slice(-limit).map(compactSighting),
    visitedAreaCount: model.visitedAreas.length,
    updatedAt: model.updatedAt,
  };
}

export function findDoNotTouchRegion(model, position, opts = {}) {
  const margin = opts.margin ?? 0;
  const p = vec(position);
  return (model?.doNotTouchRegions || []).find((region) => bboxContains(region.bbox, p, margin)) || null;
}

export function blockModificationPolicy(model, position, opts = {}) {
  const region = findDoNotTouchRegion(model, position, opts);
  if (!region) {
    return { ok: true, action: 'allow', reason: 'no do-not-touch region' };
  }
  return {
    ok: false,
    action: 'avoid',
    reason: `inside do-not-touch region ${region.id}`,
    region,
  };
}

export function findNearestKnownResource(model, from, opts = {}) {
  return findNearestSighting(model, model?.resourceSightings || [], from, opts);
}

export function findNearestKnownStorage(model, from, opts = {}) {
  return findNearestSighting(model, model?.storageSightings || [], from, opts);
}

export function filterAccessibleStorage(model, storages = null, opts = {}) {
  const candidates = storages || model?.storageSightings || [];
  if (!model) return { storages: candidates.slice(), protected: [] };
  const accessible = [];
  const protectedStorage = [];
  for (const storage of candidates) {
    if (!storage?.position) {
      accessible.push(storage);
      continue;
    }
    const policy = blockModificationPolicy(model, storage.position, { margin: opts.doNotTouchMargin ?? 0 });
    if (policy.ok) {
      accessible.push(storage);
    } else {
      protectedStorage.push({ storage, policy });
    }
  }
  return { storages: accessible, protected: protectedStorage };
}

export function observeStorageContents(model, storageBlock, container, opts = {}) {
  if (!model || !storageBlock?.position) return null;
  if (!Array.isArray(model.storageSightings)) model.storageSightings = [];
  const now = opts.now || new Date().toISOString();
  const position = vec(storageBlock.position);
  const name = storageBlock.name || opts.name || 'storage';
  const key = `${name}:${position.x},${position.y},${position.z}`;
  const contents = extractStorageContents(container);
  const existing = (model.storageSightings || []).find((sighting) => sighting.key === key);
  const sighting = {
    ...(existing || {}),
    key,
    kind: 'storage',
    name,
    position,
    seenAt: now,
    contents,
  };
  if (existing) {
    Object.assign(existing, sighting);
  } else {
    model.storageSightings.push(sighting);
  }
  model.updatedAt = now;
  return existing || sighting;
}

export function renderWorldModelReport(model) {
  const lines = [
    '# World Model Report',
    '',
    `Updated: ${model.updatedAt}`,
    `Visited areas: ${model.visitedAreas.length}`,
    `Interesting regions: ${model.interestingRegions.length}`,
    `Do-not-touch regions: ${model.doNotTouchRegions.length}`,
    `Resources seen: ${model.resourceSightings.length}`,
    `Hazards seen: ${model.hazardSightings.length}`,
    `Storage seen: ${model.storageSightings.length}`,
    '',
    '## Interesting Regions',
  ];

  if (model.interestingRegions.length === 0) {
    lines.push('- none');
  } else {
    for (const region of model.interestingRegions) {
      lines.push(`- ${region.id}: ${region.classification} confidence=${region.confidence} signals=${region.signals.join(',')}`);
    }
  }
  return lines.join('\n') + '\n';
}

function normalizeSample(sample) {
  if (!sample || !sample.name || !sample.position) return null;
  return {
    name: sample.name,
    position: vec(sample.position),
    biome: sample.biome || null,
  };
}

function isProcessedBlock(name) {
  if (PROCESSED_NAMES.has(name)) return true;
  return PROCESSED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function addTypedSighting(list, sample, names, kind, seenAt) {
  if (!names.has(sample.name)) return;
  const position = sample.position;
  const key = `${sample.name}:${position.x},${position.y},${position.z}`;
  if (list.some((sighting) => sighting.key === key)) return;
  list.push({
    key,
    kind,
    name: sample.name,
    position,
    seenAt,
  });
}

function upsertVisitedArea(model, bbox, opts = {}) {
  if (!Array.isArray(model.visitedAreas)) model.visitedAreas = [];
  const source = opts.source || 'synthetic';
  const existing = model.visitedAreas.find((area) => sameBBox(area.bbox, bbox) && area.source === source);
  if (!existing) {
    const area = {
      id: `visit_${model.visitedAreas.length + 1}`,
      bbox,
      seenAt: opts.now,
      lastSeenAt: opts.now,
      seenCount: 1,
      source,
    };
    model.visitedAreas.push(area);
    return area;
  }
  existing.lastSeenAt = opts.now;
  existing.seenCount = (existing.seenCount || 1) + 1;
  return existing;
}

function upsertInterestingRegion(model, region, now) {
  if (!Array.isArray(model.interestingRegions)) model.interestingRegions = [];
  const existing = model.interestingRegions.find((candidate) => (
    sameBBox(candidate.bbox, region.bbox) &&
    candidate.classification === region.classification
  ));
  if (!existing) {
    const saved = {
      ...region,
      seenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    };
    model.interestingRegions.push(saved);
    return saved;
  }
  existing.confidence = Math.max(existing.confidence ?? 0, region.confidence ?? 0);
  existing.signals = mergeSorted(existing.signals, region.signals);
  existing.dominantBlocks = mergeLimited(existing.dominantBlocks, region.dominantBlocks, 5);
  existing.recommendedPolicy = region.recommendedPolicy || existing.recommendedPolicy;
  existing.lastSeenAt = now;
  existing.seenCount = (existing.seenCount || 1) + 1;
  return existing;
}

function upsertDoNotTouchRegion(model, region, now) {
  if (!Array.isArray(model.doNotTouchRegions)) model.doNotTouchRegions = [];
  const existing = model.doNotTouchRegions.find((candidate) => candidate.id === region.id || sameBBox(candidate.bbox, region.bbox));
  if (!existing) {
    const saved = {
      ...region,
      seenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    };
    model.doNotTouchRegions.push(saved);
    return saved;
  }
  existing.id = region.id;
  existing.reason = region.reason || existing.reason;
  existing.confidence = Math.max(existing.confidence ?? 0, region.confidence ?? 0);
  existing.lastSeenAt = now;
  existing.seenCount = (existing.seenCount || 1) + 1;
  return existing;
}

function sameBBox(a, b) {
  return (
    Array.isArray(a?.min) &&
    Array.isArray(a?.max) &&
    Array.isArray(b?.min) &&
    Array.isArray(b?.max) &&
    a.min.length === b.min.length &&
    a.max.length === b.max.length &&
    a.min.every((value, index) => value === b.min[index]) &&
    a.max.every((value, index) => value === b.max[index])
  );
}

function mergeSorted(a = [], b = []) {
  return [...new Set([...(a || []), ...(b || [])])].sort();
}

function mergeLimited(a = [], b = [], limit = Infinity) {
  const merged = [];
  const seen = new Set();
  for (const value of [...(a || []), ...(b || [])]) {
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged.slice(0, limit);
}

function countBlocks(samples) {
  const counts = new Map();
  for (const sample of samples) counts.set(sample.name, (counts.get(sample.name) || 0) + 1);
  return counts;
}

function confidenceFor({ craftedDensity, signals }) {
  let confidence = craftedDensity * 0.6 + signals.length * 0.07;
  if (signals.includes('door_present')) confidence += 0.12;
  if (signals.includes('glass_present')) confidence += 0.08;
  if (signals.includes('rectangular_planes')) confidence += 0.12;
  if (signals.includes('storage_present') || signals.includes('workstation_present')) confidence += 0.15;
  if (signals.includes('village_marker')) confidence += 0.12;
  return Math.min(0.99, Math.round(confidence * 100) / 100);
}

function detectRectangularFootprint(samples) {
  const byY = new Map();
  for (const sample of samples) {
    const y = sample.position.y;
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push(sample.position);
  }

  for (const positions of byY.values()) {
    if (positions.length < 4) continue;
    const xs = positions.map((p) => p.x);
    const zs = positions.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    if (minX === maxX || minZ === maxZ) continue;
    const keys = new Set(positions.map((p) => `${p.x},${p.z}`));
    if (
      keys.has(`${minX},${minZ}`) &&
      keys.has(`${minX},${maxZ}`) &&
      keys.has(`${maxX},${minZ}`) &&
      keys.has(`${maxX},${maxZ}`)
    ) {
      return true;
    }
  }
  return false;
}

function detectVerticalPlane(samples) {
  const byX = new Map();
  const byZ = new Map();
  for (const sample of samples) {
    if (!byX.has(sample.position.x)) byX.set(sample.position.x, []);
    if (!byZ.has(sample.position.z)) byZ.set(sample.position.z, []);
    byX.get(sample.position.x).push(sample.position);
    byZ.get(sample.position.z).push(sample.position);
  }
  return [...byX.values(), ...byZ.values()].some((positions) => {
    const ys = new Set(positions.map((p) => p.y));
    const horizontal = new Set(positions.map((p) => `${p.x},${p.z}`));
    return ys.size >= 2 && horizontal.size >= 2 && positions.length >= 4;
  });
}

function hasAny(names, candidates) {
  for (const name of names) if (candidates.has(name)) return true;
  return false;
}

function hasNameMatching(names, predicate) {
  for (const name of names) if (predicate(name)) return true;
  return false;
}

function bboxFor(samples) {
  const xs = samples.map((sample) => sample.position.x);
  const ys = samples.map((sample) => sample.position.y);
  const zs = samples.map((sample) => sample.position.z);
  return {
    min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
    max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
  };
}

function compactRegion(region) {
  const compact = {
    id: region.id,
    bbox: region.bbox,
    classification: region.classification,
    confidence: region.confidence,
    signals: region.signals,
    dominantBlocks: region.dominantBlocks,
    recommendedPolicy: region.recommendedPolicy,
  };
  if (region.seenCount != null) compact.seenCount = region.seenCount;
  if (region.lastSeenAt) compact.lastSeenAt = region.lastSeenAt;
  return compact;
}

function compactSighting(sighting) {
  const compact = {
    name: sighting.name,
    position: sighting.position,
    seenAt: sighting.seenAt,
  };
  if (sighting.contents && Object.keys(sighting.contents).length > 0) compact.contents = sighting.contents;
  return compact;
}

function extractStorageContents(container) {
  if (!container) return {};
  if (Array.isArray(container)) return countItems(container);
  if (typeof container.containerItems === 'function') return countItems(container.containerItems());
  if (Array.isArray(container.containerItems)) return countItems(container.containerItems);
  if (typeof container.items === 'function') return countItems(container.items());
  if (Array.isArray(container.items)) return countItems(container.items);
  if (Array.isArray(container.slots)) return countItems(container.slots.filter(Boolean));
  return {};
}

function findNearestSighting(model, sightings, from, opts = {}) {
  if (!from) return null;
  const origin = vec(from);
  const maxDistance = opts.maxDistance ?? Infinity;
  const avoidDoNotTouch = opts.avoidDoNotTouch ?? true;
  const names = opts.names ? new Set(opts.names) : null;
  const name = opts.name || null;

  return sightings
    .filter((sighting) => {
      if (!sighting?.position) return false;
      if (name && sighting.name !== name) return false;
      if (names && !names.has(sighting.name)) return false;
      if (avoidDoNotTouch && findDoNotTouchRegion(model, sighting.position, opts)) return false;
      return distance(origin, sighting.position) <= maxDistance;
    })
    .map((sighting) => ({
      ...sighting,
      distance: Math.round(distance(origin, sighting.position) * 10) / 10,
    }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name) || (a.key || '').localeCompare(b.key || ''))[0] || null;
}

function bboxContains(bbox, position, margin = 0) {
  if (!bbox?.min || !bbox?.max) return false;
  return (
    position.x >= bbox.min[0] - margin &&
    position.y >= bbox.min[1] - margin &&
    position.z >= bbox.min[2] - margin &&
    position.x <= bbox.max[0] + margin &&
    position.y <= bbox.max[1] + margin &&
    position.z <= bbox.max[2] + margin
  );
}

function distance(a, b) {
  return Math.sqrt(
    (a.x - b.x) ** 2 +
    (a.y - b.y) ** 2 +
    (a.z - b.z) ** 2
  );
}

function vec(p) {
  return {
    x: Math.floor(p.x),
    y: Math.floor(p.y),
    z: Math.floor(p.z),
  };
}

function errorMessage(err) {
  return err?.message || String(err);
}
