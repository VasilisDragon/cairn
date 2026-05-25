// Build scaffold. Live placement is intentionally not implemented yet.
//
// Implemented:
//   - Explicit dryRun=true for inline schematic block lists, local JSON files,
//     or Sponge .schem files.
//   - BOM/material fulfillment.
//   - Deterministic placement order.
//   - Blocked/unsafe/protected placement checks.
//
// Remaining placement implementation when build correctness becomes in-scope:
//   1. Parse Litematic files. They are gzipped NBT with a different envelope
//      from Sponge .schem; output the same inline block shape accepted by the
//      dry-run path: { offset: {x,y,z}, blockState: string }.
//   2. For each block in placement order:
//        a. ensure the block's resource item is in inventory (else fail with
//           a "need N <block>" reason — advisor will plan a collect/craft).
//        b. goto the placement position with GoalPlaceBlock or GoalNear.
//        c. bot.placeBlock(referenceBlock, faceVector).
//   3. Return ok:true when the list is exhausted (no correctness check).
//
// All pathfinder writes must go through bot.pathfinderOwner when this is
// implemented — same chokepoint rule as every other skill.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nbt from 'prismarine-nbt';

import { dryRunBuildPlan, normalizeSchematicBlocks } from '../state/build_plan.js';
import { readBotInventoryCounts } from '../state/materials.js';
import buildSnapshot from '../state/snapshot.js';
import { filterAccessibleStorage } from '../state/world_model.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import { validateSchematicBlock } from './schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMATIC_DIR = path.join(ROOT, 'schematics');

export async function run(bot, params = {}, ctx = {}) {
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };
  if (params.dryRun !== true) {
    return {
      ok: false,
      reason: 'build_from_schematic placement is not implemented; pass dryRun:true with inline blocks for deterministic BOM/placement validation',
      state: buildSnapshot(bot, ctx),
    };
  }

  if (!isVec(params.anchor)) {
    return { ok: false, reason: 'build_from_schematic requires anchor {x,y,z}', state: buildSnapshot(bot, ctx) };
  }

  let fileSchematic = null;
  if (typeof params.schematic === 'string' && !Array.isArray(params.blocks)) {
    const loaded = await loadSchematicFile(params.schematic);
    if (!loaded.ok) {
      return { ok: false, reason: loaded.reason, state: buildSnapshot(bot, ctx) };
    }
    fileSchematic = loaded.schematic;
  }
  const schematic = schematicInput(params, fileSchematic);
  const shape = validateLoadedSchematicBlocks(schematic.blocks, fileSchematic ? `schematic "${params.schematic}"` : 'inline schematic');
  if (!shape.ok) {
    return { ok: false, reason: shape.reason, state: buildSnapshot(bot, ctx) };
  }
  const registryBlocks = validateRegistryBlocks(bot, schematic);
  if (!registryBlocks.ok) {
    return { ok: false, reason: registryBlocks.reason, state: buildSnapshot(bot, ctx) };
  }

  if (ctx.signal?.aborted) {
    return {
      preempted: true,
      reason: 'pre-aborted',
      state: buildSnapshot(bot, ctx),
    };
  }

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for build dry-run chunk readiness');
  if (chunks.preempted) return { preempted: true, reason: chunks.reason, state: buildSnapshot(bot, ctx) };
  if (chunks.error) return { ok: false, reason: `chunk data unavailable during build dry-run: ${errorMessage(chunks.error)}`, state: buildSnapshot(bot, ctx) };
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };

  const worldModel = params.worldModel || ctx.worldModel || null;
  const storageSource = params.storages ?? worldModel?.storageSightings ?? [];
  const storages = params.storages
    ? storageSource
    : filterAccessibleStorage(worldModel, storageSource, { doNotTouchMargin: params.doNotTouchMargin }).storages;
  const inventory = params.inventory == null ? readBotInventoryCounts(bot) : { ok: true, inventory: params.inventory };
  if (!inventory.ok) {
    return { ok: false, reason: `inventory unavailable during build dry-run: ${inventory.error}`, state: buildSnapshot(bot, ctx) };
  }
  let dryRun;
  try {
    dryRun = dryRunBuildPlan({
      schematic,
      anchor: params.anchor,
      inventory: inventory.inventory,
      storages,
      from: bot.entity?.position || params.anchor,
      worldBlocks: params.worldBlocks || ((position) => bot.blockAt?.(position)),
      worldModel,
      doNotTouchMargin: params.doNotTouchMargin,
      requireSupport: params.requireSupport === true,
    });
  } catch (err) {
    if (ctx.signal?.aborted) {
      return { preempted: true, reason: 'reactive preempt during build dry-run world reads', state: buildSnapshot(bot, ctx) };
    }
    return { ok: false, reason: `build dry-run failed during world reads: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
  }
  if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during build dry-run world reads', state: buildSnapshot(bot, ctx) };

  if (dryRun.blockCount === 0) {
    return {
      ok: false,
      reason: 'build dry-run requires at least one non-air block',
      dryRun,
      state: buildSnapshot(bot, ctx),
    };
  }

  return {
    ok: dryRun.ok,
    reason: dryRun.ok ? `build dry-run ok (${dryRun.blockCount} blocks)` : buildDryRunFailureReason(dryRun),
    dryRun,
    state: buildSnapshot(bot, ctx),
  };
}

function schematicInput(params, fileSchematic = null) {
  if (Array.isArray(params.blocks)) return { blocks: params.blocks };
  if (fileSchematic) return fileSchematic;
  if (typeof params.schematic === 'object' && params.schematic) return params.schematic;
  return { blocks: [] };
}

async function loadSchematicFile(ref) {
  if (!ref.trim()) return { ok: false, reason: 'build dry-run schematic path must be non-empty' };
  const normalized = ref.replaceAll('\\', '/');
  const relative = normalized.startsWith('schematics/') ? normalized.slice('schematics/'.length) : normalized;
  if (path.isAbsolute(ref) || relative.split('/').includes('..')) {
    return { ok: false, reason: 'build dry-run schematic path must stay under schematics/' };
  }
  const resolved = path.resolve(SCHEMATIC_DIR, relative);
  if (!isInsideDirectory(resolved, SCHEMATIC_DIR)) {
    return { ok: false, reason: 'build dry-run schematic path must stay under schematics/' };
  }

  const ext = path.extname(relative).toLowerCase();
  if (ext === '.json') return loadJsonSchematic(resolved, ref);
  if (ext === '.schem') return loadSpongeSchematic(resolved, ref);
  if (ext === '.litematic') {
    return {
      ok: false,
      reason: `build dry-run supports JSON and Sponge .schem files under schematics/; .litematic parsing is not implemented for "${ref}"`,
    };
  }
  return {
    ok: false,
    reason: `build dry-run supports JSON and Sponge .schem files under schematics/; unsupported extension "${ext || '(none)'}" for "${ref}"`,
  };
}

function loadJsonSchematic(resolved, ref) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `build dry-run could not read schematic "${ref}": ${err.message || String(err)}` };
  }

  if (!Array.isArray(parsed) && !Array.isArray(parsed?.blocks)) {
    return { ok: false, reason: `build dry-run schematic "${ref}" must be a JSON array or object with blocks[]` };
  }
  const schematic = Array.isArray(parsed) ? { blocks: parsed } : parsed;
  const shape = validateLoadedSchematicBlocks(schematic.blocks, `schematic "${ref}"`);
  if (!shape.ok) return shape;

  return {
    ok: true,
    schematic,
  };
}

async function loadSpongeSchematic(resolved, ref) {
  let simplified;
  try {
    const parsed = await nbt.parse(fs.readFileSync(resolved));
    simplified = nbt.simplify(parsed.parsed);
  } catch (err) {
    return { ok: false, reason: `build dry-run could not parse Sponge schematic "${ref}": ${errorMessage(err)}` };
  }

  const schematic = parseSpongeSchematic(simplified?.Schematic || simplified, ref);
  if (!schematic.ok) return schematic;
  return { ok: true, schematic: { blocks: schematic.blocks } };
}

function parseSpongeSchematic(schematic, ref) {
  const width = positiveInteger(schematic?.Width);
  const height = positiveInteger(schematic?.Height);
  const length = positiveInteger(schematic?.Length);
  if (!width || !height || !length) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include positive Width, Height, and Length` };
  }

  const palette = schematic?.Palette;
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include a Palette compound` };
  }

  const blockData = byteArray(schematic?.BlockData);
  if (!blockData) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include BlockData byte array` };
  }

  const expectedBlocks = width * height * length;
  const indices = decodeVarints(blockData, expectedBlocks);
  if (!indices.ok) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" has invalid BlockData: ${indices.reason}` };
  }
  if (indices.values.length !== expectedBlocks) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" decoded ${indices.values.length} blocks but expected ${expectedBlocks}`,
    };
  }

  const paletteById = [];
  for (const [blockState, id] of Object.entries(palette)) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 0) {
      return { ok: false, reason: `build dry-run Sponge schematic "${ref}" has invalid palette id for "${blockState}"` };
    }
    paletteById[numericId] = blockState;
  }

  const baseOffset = intVector(schematic?.Offset) || { x: 0, y: 0, z: 0 };
  const blocks = [];
  for (let i = 0; i < expectedBlocks; i++) {
    const blockState = paletteById[indices.values[i]];
    if (!blockState) {
      return { ok: false, reason: `build dry-run Sponge schematic "${ref}" references missing palette id ${indices.values[i]}` };
    }
    const y = Math.floor(i / (width * length));
    const rem = i % (width * length);
    const z = Math.floor(rem / width);
    const x = rem % width;
    blocks.push({
      blockState,
      offset: {
        x: baseOffset.x + x,
        y: baseOffset.y + y,
        z: baseOffset.z + z,
      },
    });
  }

  return { ok: true, blocks };
}

function validateLoadedSchematicBlocks(blocks, label) {
  if (!Array.isArray(blocks)) {
    return { ok: false, reason: `build dry-run ${label} must be a JSON array or object with blocks[]` };
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = validateSchematicBlock(blocks[i], `build dry-run ${label}: "blocks[${i}]"`);
    if (!block.ok) return block;
  }
  return { ok: true };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function byteArray(value) {
  if (Buffer.isBuffer(value)) return [...value];
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value;
  return null;
}

function intVector(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const items = Array.from(value);
  if (items.length < 3) return null;
  const [x, y, z] = items.map((item) => Number(item));
  if (![x, y, z].every(Number.isInteger)) return null;
  return { x, y, z };
}

function decodeVarints(bytes, expectedCount) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const rawByte of bytes) {
    const byte = Number(rawByte) & 0xff;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      values.push(value);
      value = 0;
      shift = 0;
      if (expectedCount > 0 && values.length > expectedCount) {
        return { ok: false, reason: `decoded more than ${expectedCount} block indices` };
      }
      continue;
    }
    shift += 7;
    if (shift > 28) return { ok: false, reason: 'varint is too long' };
  }
  if (shift !== 0) return { ok: false, reason: 'truncated varint' };
  return { ok: true, values };
}

function validateRegistryBlocks(bot, schematic) {
  const blocksByName = bot?.registry?.blocksByName;
  const known = knownBlockLookup(blocksByName);
  if (!known) return { ok: true };

  for (const block of normalizeSchematicBlocks(schematic)) {
    if (!known(block.name)) {
      return {
        ok: false,
        reason: `build dry-run unknown block "${block.name}" at blocks[${block.sourceIndex}]`,
      };
    }
  }
  return { ok: true };
}

function knownBlockLookup(blocksByName) {
  if (blocksByName instanceof Map) {
    if (!blocksByName.has('air')) return null;
    return (name) => blocksByName.has(name);
  }
  if (!blocksByName || typeof blocksByName !== 'object') return null;
  if (!Object.hasOwn(blocksByName, 'air')) return null;
  return (name) => Object.hasOwn(blocksByName, name);
}

function isInsideDirectory(file, directory) {
  const relative = path.relative(directory, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function buildDryRunFailureReason(dryRun) {
  const reasons = [];
  if (Object.keys(dryRun.missingMaterials || {}).length > 0) {
    reasons.push(`missing materials: ${formatCounts(dryRun.missingMaterials)}`);
  }
  if (dryRun.placementIssues.blocked.length > 0) {
    const first = dryRun.placementIssues.blocked[0];
    reasons.push(`blocked placements: ${first.name} at ${formatPos(first.position)} occupied by ${first.existing}`);
  }
  if (dryRun.placementIssues.protected.length > 0) {
    const first = dryRun.placementIssues.protected[0];
    reasons.push(`protected placements: ${first.name} at ${formatPos(first.position)} ${first.reason}`);
  }
  if (dryRun.placementIssues.unsafe.length > 0) {
    const first = dryRun.placementIssues.unsafe[0];
    reasons.push(`unsafe placements: ${first.name} at ${formatPos(first.position)} ${first.reason}`);
  }
  return reasons.length > 0 ? `build dry-run failed; ${reasons.join('; ')}` : 'build dry-run failed';
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}

function formatPos(position) {
  return `${position.x},${position.y},${position.z}`;
}

function isVec(value) {
  return value && [value.x, value.y, value.z].every((n) => Number.isFinite(Number(n)));
}

function errorMessage(err) {
  return err?.message || String(err);
}
