import { planMaterialFulfillment } from './materials.js';
import { blockModificationPolicy } from './world_model.js';

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const DEFAULT_HAZARD_BLOCKS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'wither_rose',
]);

const NEIGHBOR_OFFSETS = Object.freeze([
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
]);

export function normalizeSchematicBlocks(schematic) {
  const rawBlocks = Array.isArray(schematic) ? schematic : schematic?.blocks;
  return (rawBlocks || [])
    .map((entry, index) => normalizeSchematicBlock(entry, index))
    .filter(Boolean);
}

export function buildMaterialBill(blocks) {
  const out = {};
  for (const block of normalizeSchematicBlocks(blocks)) {
    out[block.name] = (out[block.name] || 0) + 1;
  }
  return sortCounts(out);
}

export function buildPlacementPlan(blocks, anchor = { x: 0, y: 0, z: 0 }) {
  const origin = toVec(anchor) || { x: 0, y: 0, z: 0 };
  return normalizeSchematicBlocks(blocks)
    .sort(compareSchematicBlocks)
    .map((block, placementIndex) => ({
      placementIndex,
      name: block.name,
      offset: block.offset,
      position: addVec(origin, block.offset),
    }));
}

export function detectPlacementIssues(placements, opts = {}) {
  const replaceable = new Set(opts.replaceableBlocks || AIR_BLOCKS);
  const hazards = new Set(opts.hazardBlocks || DEFAULT_HAZARD_BLOCKS);
  const worldBlockAt = worldBlockLookup(opts.worldBlocks);
  const plannedKeys = new Set();
  const blocked = [];
  const unsafe = [];
  const protectedPositions = [];

  for (const placement of placements || []) {
    const existing = normalizeBlockName(worldBlockAt(placement.position)) || 'air';
    const targetKey = positionKey(placement.position);
    if (!replaceable.has(existing) && existing !== placement.name) {
      blocked.push({
        placementIndex: placement.placementIndex,
        name: placement.name,
        position: placement.position,
        existing,
        reason: `target occupied by ${existing}`,
      });
    }

    const policy = opts.worldModel
      ? blockModificationPolicy(opts.worldModel, placement.position, { margin: opts.doNotTouchMargin ?? 0 })
      : { ok: true };
    if (!policy.ok) {
      protectedPositions.push({
        placementIndex: placement.placementIndex,
        name: placement.name,
        position: placement.position,
        reason: policy.reason,
        region: policy.region,
      });
    }

    const hazard = findAdjacentHazard(placement.position, worldBlockAt, hazards);
    if (hazard) {
      unsafe.push({
        placementIndex: placement.placementIndex,
        name: placement.name,
        position: placement.position,
        reason: `near hazard ${hazard.name}`,
        hazard,
      });
    }

    if (opts.requireSupport === true && !hasPlacementSupport(placement.position, worldBlockAt, plannedKeys, replaceable)) {
      unsafe.push({
        placementIndex: placement.placementIndex,
        name: placement.name,
        position: placement.position,
        reason: 'no adjacent support block in world or earlier placement',
      });
    }

    plannedKeys.add(targetKey);
  }

  return {
    ok: blocked.length === 0 && unsafe.length === 0 && protectedPositions.length === 0,
    blocked,
    unsafe,
    protected: protectedPositions,
  };
}

export function dryRunBuildPlan(opts = {}) {
  const schematic = opts.schematic || opts.blocks || [];
  const blocks = normalizeSchematicBlocks(schematic);
  const billOfMaterials = buildMaterialBill(blocks);
  const materialPlan = planMaterialFulfillment({
    requirements: billOfMaterials,
    inventory: opts.inventory || {},
    storages: opts.storages || [],
    from: opts.from || opts.anchor || null,
  });
  const placements = buildPlacementPlan(blocks, opts.anchor || { x: 0, y: 0, z: 0 });
  const placementIssues = detectPlacementIssues(placements, {
    worldBlocks: opts.worldBlocks,
    worldModel: opts.worldModel,
    doNotTouchMargin: opts.doNotTouchMargin,
    replaceableBlocks: opts.replaceableBlocks,
    hazardBlocks: opts.hazardBlocks,
    requireSupport: opts.requireSupport,
  });

  return {
    ok: materialPlan.ok && placementIssues.ok,
    blockCount: placements.length,
    billOfMaterials,
    materialPlan,
    missingMaterials: materialPlan.stillMissing,
    placements,
    placementIssues,
  };
}

function normalizeSchematicBlock(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  const name = normalizeBlockName(entry.name || entry.block || entry.blockState || entry.block_state);
  if (!name || AIR_BLOCKS.has(name)) return null;
  const offset = normalizeOffset(entry);
  if (!offset) return null;
  return { name, offset, sourceIndex: index };
}

function normalizeOffset(entry) {
  if (entry.offset) return toVec(entry.offset);
  if (entry.position) return toVec(entry.position);
  if ([entry.x, entry.y, entry.z].every((n) => Number.isFinite(Number(n)))) {
    return vec(entry);
  }
  return null;
}

function normalizeBlockName(value) {
  if (!value) return null;
  if (typeof value === 'object') return normalizeBlockName(value.name || value.blockState || value.block_state);
  const raw = String(value);
  const noState = raw.split('[')[0];
  const noNamespace = noState.includes(':') ? noState.split(':').at(-1) : noState;
  return noNamespace || null;
}

function compareSchematicBlocks(a, b) {
  return (
    a.offset.y - b.offset.y ||
    a.offset.x - b.offset.x ||
    a.offset.z - b.offset.z ||
    a.name.localeCompare(b.name) ||
    a.sourceIndex - b.sourceIndex
  );
}

function worldBlockLookup(worldBlocks) {
  if (typeof worldBlocks === 'function') return (position) => normalizeBlockName(worldBlocks(position)) || 'air';
  if (worldBlocks instanceof Map) return (position) => normalizeBlockName(worldBlocks.get(positionKey(position))) || 'air';
  if (Array.isArray(worldBlocks)) {
    const map = new Map();
    for (const block of worldBlocks) {
      const position = block?.position || block;
      const name = block?.name || block?.block || block?.blockState;
      if (!position || !name) continue;
      map.set(positionKey(position), normalizeBlockName(name));
    }
    return (position) => map.get(positionKey(position)) || 'air';
  }
  if (worldBlocks && typeof worldBlocks === 'object') {
    return (position) => normalizeBlockName(worldBlocks[positionKey(position)]) || 'air';
  }
  return () => 'air';
}

function findAdjacentHazard(position, worldBlockAt, hazards) {
  for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
    const probe = addVec(position, { x: dx, y: dy, z: dz });
    const name = worldBlockAt(probe);
    if (hazards.has(name)) return { name, position: probe };
  }
  return null;
}

function hasPlacementSupport(position, worldBlockAt, plannedKeys, replaceable) {
  for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
    const probe = addVec(position, { x: dx, y: dy, z: dz });
    if (plannedKeys.has(positionKey(probe))) return true;
    const existing = worldBlockAt(probe);
    if (!replaceable.has(existing)) return true;
  }
  return false;
}

function addVec(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vec(p) {
  return {
    x: Math.floor(Number(p.x)),
    y: Math.floor(Number(p.y)),
    z: Math.floor(Number(p.z)),
  };
}

function toVec(p) {
  if (!p || ![p.x, p.y, p.z].every((n) => Number.isFinite(Number(n)))) return null;
  return vec(p);
}

function positionKey(position) {
  const p = toVec(position) || { x: 0, y: 0, z: 0 };
  return `${p.x},${p.y},${p.z}`;
}

function sortCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}
