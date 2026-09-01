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
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzip } from 'node:zlib';
import nbt from 'prismarine-nbt';

import { dryRunBuildPlan, normalizeSchematicBlocks } from '../state/build_plan.js';
import { readBotInventoryCounts } from '../state/materials.js';
import buildSnapshot from '../state/snapshot.js';
import { filterAccessibleStorage } from '../state/world_model.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import { validateSchematicBlock } from './schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMATIC_DIR = path.join(ROOT, 'schematics');
const gunzipAsync = promisify(gunzip);

export const SCHEMATIC_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  decompressedNbtBytes: 32 * 1024 * 1024,
  dimension: 256,
  expandedBlocks: 262_144,
  paletteEntries: 4_096,
  blockDataBytesPerBlock: 5,
  blockDataBytesAbsolute: 1_310_720,
});

export const SPONGE_NBT_BUDGETS = Object.freeze({
  depth: 64,
  tags: 65_536,
  nodes: 262_144,
  stringBytes: 4 * 1024 * 1024,
  aggregateArrayBytes: 8 * 1024 * 1024,
});

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
  if (ext === '.litematic') {
    return {
      ok: false,
      reason: `build dry-run supports JSON and Sponge .schem files under schematics/; .litematic parsing is not implemented for "${ref}"`,
    };
  }
  if (ext !== '.json' && ext !== '.schem') {
    return {
      ok: false,
      reason: `build dry-run supports JSON and Sponge .schem files under schematics/; unsupported extension "${ext || '(none)'}" for "${ref}"`,
    };
  }

  const source = await readBoundedSchematicFile(resolved, ref);
  if (!source.ok) return source;
  if (ext === '.json') return loadJsonSchematic(source.bytes, ref);
  return loadSpongeSchematic(source.bytes, ref);
}

async function readBoundedSchematicFile(resolved, ref) {
  let handle = null;
  try {
    const realPath = await fs.promises.realpath(resolved);
    if (!isInsideDirectory(realPath, SCHEMATIC_DIR)) {
      return { ok: false, reason: 'build dry-run schematic path must stay under schematics/' };
    }

    handle = await fs.promises.open(realPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { ok: false, reason: `build dry-run schematic "${ref}" must be a regular file` };
    }
    if (!Number.isSafeInteger(stat.size) || stat.size > SCHEMATIC_LIMITS.fileBytes) {
      return { ok: false, reason: `build dry-run schematic "${ref}" exceeds the 8 MiB file limit` };
    }

    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(bytes, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset);
    if (extraBytes !== 0) {
      return { ok: false, reason: `build dry-run schematic "${ref}" changed while it was being read` };
    }
    return { ok: true, bytes: offset === bytes.length ? bytes : bytes.subarray(0, offset) };
  } catch (err) {
    return { ok: false, reason: `build dry-run could not read schematic "${ref}": ${errorMessage(err)}` };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function loadJsonSchematic(bytes, ref) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
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

async function loadSpongeSchematic(sourceBytes, ref) {
  let simplified;
  try {
    const nbtBytes = await decompressSchematicNbt(sourceBytes);
    preflightSpongeNbt(nbtBytes, ref);
    const parsed = nbt.parseUncompressed(nbtBytes, 'big');
    simplified = nbt.simplify(parsed);
  } catch (err) {
    return { ok: false, reason: `build dry-run could not parse Sponge schematic "${ref}": ${errorMessage(err)}` };
  }

  const schematic = parseSpongeSchematic(simplified?.Schematic || simplified, ref);
  if (!schematic.ok) return schematic;
  return { ok: true, schematic: { blocks: schematic.blocks } };
}

const NBT_TAG = Object.freeze({
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12,
});

const SPONGE_DIMENSION_NAMES = Object.freeze(['Width', 'Height', 'Length']);

// prismarine-nbt/protodef allocates declared arrays and objects as it parses.
// Walk the uncompressed bytes first without allocating attacker-sized
// collections, then permit the repository's established decoder to build only
// a document that has already satisfied these resource and Sponge limits.
function preflightSpongeNbt(bytes, ref = 'schematic') {
  const scan = new BoundedSpongeNbtScanner(bytes).scan();
  if (scan.schematicTagCount > 1) {
    throw new Error('NBT root contains duplicate Schematic compounds');
  }
  if (scan.schematicTagCount === 1 && !scan.schematicCandidate) {
    throw new Error('NBT Schematic tag must be a compound');
  }

  const candidate = scan.schematicCandidate || scan.rootCandidate;
  const validation = validatePrescannedSpongeCandidate(candidate, ref);
  if (!validation.ok) throw new Error(validation.reason);
  return validation;
}

class BoundedSpongeNbtScanner {
  constructor(bytes) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('Sponge NBT must be a Buffer');
    this.bytes = bytes;
    this.offset = 0;
    this.tags = 0;
    this.nodes = 0;
    this.stringBytes = 0;
    this.arrayBytes = 0;
    this.rootCandidate = createPrescanCandidate();
    this.schematicCandidate = null;
    this.schematicTagCount = 0;
  }

  scan() {
    const rootType = this.readUnsignedByte();
    this.chargeTagAndNode();
    this.readString(true);
    if (rootType !== NBT_TAG.compound) throw new Error('NBT root must be a compound');
    this.readCompound(1, { candidate: this.rootCandidate, isRoot: true });
    if (this.offset !== this.bytes.length) throw new Error('NBT document contains trailing bytes');
    return {
      rootCandidate: this.rootCandidate,
      schematicCandidate: this.schematicCandidate,
      schematicTagCount: this.schematicTagCount,
    };
  }

  readCompound(depth, context = {}) {
    this.ensureDepth(depth);
    while (true) {
      const type = this.readUnsignedByte();
      if (type === NBT_TAG.end) return;
      this.ensureTagType(type);
      this.chargeTagAndNode();
      const name = this.readString(true);

      if (context.palette) {
        this.readPaletteEntry(type, depth, context.palette);
      } else if (context.isRoot && name === 'Schematic') {
        this.readSchematicWrapper(type, depth);
      } else if (context.candidate) {
        this.readCandidateEntry(type, name, depth, context.candidate);
      } else {
        this.readPayload(type, depth + 1);
      }
    }
  }

  readSchematicWrapper(type, depth) {
    this.schematicTagCount += 1;
    if (type !== NBT_TAG.compound) {
      this.readPayload(type, depth + 1);
      return;
    }
    const candidate = createPrescanCandidate();
    this.schematicCandidate = candidate;
    this.readCompound(depth + 1, { candidate });
  }

  readCandidateEntry(type, name, depth, candidate) {
    if (SPONGE_DIMENSION_NAMES.includes(name)) {
      const field = notePrescanField(candidate, name, type);
      const payload = this.readPayload(type, depth + 1);
      if (payload.kind === 'integer') field.value = payload.value;
      return;
    }

    if (name === 'Palette') {
      const field = notePrescanField(candidate, name, type);
      if (type !== NBT_TAG.compound) {
        this.readPayload(type, depth + 1);
        return;
      }
      const palette = { count: 0, invalidValueType: false, ids: [] };
      field.palette = palette;
      this.readCompound(depth + 1, { palette });
      return;
    }

    if (name === 'BlockData') {
      const field = notePrescanField(candidate, name, type);
      const payload = this.readPayload(type, depth + 1, {
        byteArrayLimit: SCHEMATIC_LIMITS.blockDataBytesAbsolute,
        byteArrayLimitLabel: `BlockData exceeds the ${SCHEMATIC_LIMITS.blockDataBytesAbsolute}-byte absolute limit`,
      });
      if (payload.kind === 'byteArray') field.length = payload.length;
      return;
    }

    this.readPayload(type, depth + 1);
  }

  readPaletteEntry(type, depth, palette) {
    palette.count += 1;
    if (palette.count > SCHEMATIC_LIMITS.paletteEntries) {
      throw new Error(`Palette contains more than ${SCHEMATIC_LIMITS.paletteEntries} entries`);
    }
    const payload = this.readPayload(type, depth + 1);
    if (payload.kind !== 'integer') {
      palette.invalidValueType = true;
      return;
    }
    palette.ids.push(payload.value);
  }

  readPayload(type, depth, options = {}) {
    this.ensureDepth(depth);
    switch (type) {
      case NBT_TAG.byte:
        return { kind: 'integer', value: this.readSignedByte() };
      case NBT_TAG.short:
        return { kind: 'integer', value: this.readSignedShort() };
      case NBT_TAG.int:
        return { kind: 'integer', value: this.readSignedInt() };
      case NBT_TAG.long:
        this.skip(8);
        return { kind: 'scalar' };
      case NBT_TAG.float:
        this.skip(4);
        return { kind: 'scalar' };
      case NBT_TAG.double:
        this.skip(8);
        return { kind: 'scalar' };
      case NBT_TAG.byteArray:
        return {
          kind: 'byteArray',
          length: this.readAndSkipArray(1, 'byte array', options.byteArrayLimit, options.byteArrayLimitLabel),
        };
      case NBT_TAG.string:
        this.readString(false);
        return { kind: 'string' };
      case NBT_TAG.list:
        this.readList(depth);
        return { kind: 'list' };
      case NBT_TAG.compound:
        this.readCompound(depth);
        return { kind: 'compound' };
      case NBT_TAG.intArray:
        return { kind: 'intArray', length: this.readAndSkipArray(4, 'int array') };
      case NBT_TAG.longArray:
        return { kind: 'longArray', length: this.readAndSkipArray(8, 'long array') };
      default:
        throw new Error(`unsupported NBT tag type ${type}`);
    }
  }

  readList(depth) {
    const elementType = this.readUnsignedByte();
    const count = this.readSignedInt();
    if (count < 0) throw new Error('NBT list has a negative length');
    if (elementType === NBT_TAG.end && count !== 0) throw new Error('non-empty NBT list cannot use TAG_End elements');
    if (elementType !== NBT_TAG.end) this.ensureTagType(elementType);
    this.chargeNodes(count);
    this.chargeArrayBytes(count * 8, 'list slots');
    for (let i = 0; i < count; i++) this.readPayload(elementType, depth + 1);
  }

  readAndSkipArray(elementBytes, label, itemLimit = null, itemLimitLabel = null) {
    const count = this.readSignedInt();
    if (count < 0) throw new Error(`NBT ${label} has a negative length`);
    if (itemLimit != null && count > itemLimit) throw new Error(itemLimitLabel || `NBT ${label} exceeds its item limit`);
    const payloadBytes = count * elementBytes;
    if (!Number.isSafeInteger(payloadBytes)) throw new Error(`NBT ${label} length is not safely representable`);
    this.chargeArrayBytes(payloadBytes, `${label} payload`);
    this.skip(payloadBytes);
    return count;
  }

  chargeTagAndNode() {
    this.tags += 1;
    this.nodes += 1;
    if (this.tags > SPONGE_NBT_BUDGETS.tags) {
      throw new Error(`NBT tag count exceeds the ${SPONGE_NBT_BUDGETS.tags}-tag budget`);
    }
    if (this.nodes > SPONGE_NBT_BUDGETS.nodes) {
      throw new Error(`NBT node count exceeds the ${SPONGE_NBT_BUDGETS.nodes}-node budget`);
    }
  }

  chargeNodes(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > SPONGE_NBT_BUDGETS.nodes - this.nodes) {
      throw new Error(`NBT node count exceeds the ${SPONGE_NBT_BUDGETS.nodes}-node budget`);
    }
    this.nodes += count;
  }

  chargeArrayBytes(count, label) {
    if (!Number.isSafeInteger(count) || count < 0 || count > SPONGE_NBT_BUDGETS.aggregateArrayBytes - this.arrayBytes) {
      throw new Error(`NBT aggregate ${label} exceeds the ${formatByteLimit(SPONGE_NBT_BUDGETS.aggregateArrayBytes)} budget`);
    }
    this.arrayBytes += count;
  }

  readString(decode) {
    const length = this.readUnsignedShort();
    if (length > SPONGE_NBT_BUDGETS.stringBytes - this.stringBytes) {
      throw new Error(`NBT strings exceed the ${formatByteLimit(SPONGE_NBT_BUDGETS.stringBytes)} aggregate budget`);
    }
    this.stringBytes += length;
    this.ensureAvailable(length);
    const start = this.offset;
    this.offset += length;
    return decode ? this.bytes.toString('utf8', start, this.offset) : null;
  }

  ensureDepth(depth) {
    if (depth > SPONGE_NBT_BUDGETS.depth) {
      throw new Error(`NBT nesting exceeds the ${SPONGE_NBT_BUDGETS.depth}-level depth budget`);
    }
  }

  ensureTagType(type) {
    if (!Number.isInteger(type) || type < NBT_TAG.byte || type > NBT_TAG.longArray) {
      throw new Error(`unsupported NBT tag type ${type}`);
    }
  }

  ensureAvailable(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length - this.offset) {
      throw new Error('NBT payload is truncated');
    }
  }

  skip(count) {
    this.ensureAvailable(count);
    this.offset += count;
  }

  readUnsignedByte() {
    this.ensureAvailable(1);
    const value = this.bytes.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readSignedByte() {
    this.ensureAvailable(1);
    const value = this.bytes.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUnsignedShort() {
    this.ensureAvailable(2);
    const value = this.bytes.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readSignedShort() {
    this.ensureAvailable(2);
    const value = this.bytes.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readSignedInt() {
    this.ensureAvailable(4);
    const value = this.bytes.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
}

function createPrescanCandidate() {
  return { fields: Object.create(null) };
}

function notePrescanField(candidate, name, type) {
  const prior = candidate.fields[name];
  const field = { count: (prior?.count || 0) + 1, type };
  candidate.fields[name] = field;
  return field;
}

function validatePrescannedSpongeCandidate(candidate, ref) {
  for (const name of [...SPONGE_DIMENSION_NAMES, 'Palette', 'BlockData']) {
    const field = candidate.fields[name];
    if (!field || field.count !== 1) {
      return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include exactly one ${name} tag` };
    }
  }

  for (const name of SPONGE_DIMENSION_NAMES) {
    const field = candidate.fields[name];
    if (![NBT_TAG.byte, NBT_TAG.short, NBT_TAG.int].includes(field.type) || !Number.isInteger(field.value)) {
      return { ok: false, reason: `build dry-run Sponge schematic "${ref}" ${name} must be an integer tag` };
    }
  }

  const dimensions = validateSpongeDimensions({
    Width: candidate.fields.Width.value,
    Height: candidate.fields.Height.value,
    Length: candidate.fields.Length.value,
  }, ref);
  if (!dimensions.ok) return dimensions;

  const paletteField = candidate.fields.Palette;
  const palette = paletteField.palette;
  if (paletteField.type !== NBT_TAG.compound || !palette) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include a Palette compound` };
  }
  if (palette.count < 1 || palette.count > SCHEMATIC_LIMITS.paletteEntries) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" Palette must contain 1-${SCHEMATIC_LIMITS.paletteEntries} entries`,
    };
  }
  if (palette.invalidValueType || palette.ids.length !== palette.count) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" Palette values must be integer tags` };
  }
  const paletteIds = new Set(palette.ids);
  if (paletteIds.size !== palette.count || !palette.ids.every((id) => id >= 0 && id < palette.count)) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" has invalid or non-dense palette ids` };
  }

  const blockDataField = candidate.fields.BlockData;
  if (blockDataField.type !== NBT_TAG.byteArray || !Number.isSafeInteger(blockDataField.length)) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include BlockData byte array` };
  }
  if (blockDataField.length > SCHEMATIC_LIMITS.blockDataBytesAbsolute) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" BlockData exceeds the ${SCHEMATIC_LIMITS.blockDataBytesAbsolute}-byte absolute limit`,
    };
  }
  const exactBlockDataLimit = dimensions.volume * SCHEMATIC_LIMITS.blockDataBytesPerBlock;
  if (blockDataField.length > exactBlockDataLimit) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" BlockData exceeds ${exactBlockDataLimit} bytes (five times volume)`,
    };
  }

  return { ok: true, dimensions, paletteEntries: palette.count, blockDataBytes: blockDataField.length };
}

function parseSpongeSchematic(schematic, ref) {
  const dimensions = validateSpongeDimensions(schematic, ref);
  if (!dimensions.ok) return dimensions;
  const { width, height, length, volume: expectedBlocks } = dimensions;

  const palette = schematic?.Palette;
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include a Palette compound` };
  }
  const parsedPalette = validateSpongePalette(palette, ref);
  if (!parsedPalette.ok) return parsedPalette;

  const blockData = byteArrayView(schematic?.BlockData);
  if (!blockData) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include BlockData byte array` };
  }
  if (blockData.length > SCHEMATIC_LIMITS.blockDataBytesAbsolute) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" BlockData exceeds the ${SCHEMATIC_LIMITS.blockDataBytesAbsolute}-byte absolute limit`,
    };
  }
  const maximumBlockDataBytes = expectedBlocks * SCHEMATIC_LIMITS.blockDataBytesPerBlock;
  if (blockData.length > maximumBlockDataBytes) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" BlockData exceeds ${maximumBlockDataBytes} bytes (five times volume)`,
    };
  }

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

  const paletteById = parsedPalette.paletteById;

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
  const count = validateSchematicBlockCount(blocks.length, label);
  if (!count.ok) return count;
  for (let i = 0; i < blocks.length; i++) {
    const block = validateSchematicBlock(blocks[i], `build dry-run ${label}: "blocks[${i}]"`);
    if (!block.ok) return block;
  }
  return { ok: true };
}

function validateSchematicBlockCount(count, label = 'schematic') {
  if (!Number.isSafeInteger(count) || count < 0 || count > SCHEMATIC_LIMITS.expandedBlocks) {
    return {
      ok: false,
      reason: `build dry-run ${label} exceeds the ${SCHEMATIC_LIMITS.expandedBlocks}-block expansion limit`,
    };
  }
  return { ok: true };
}

function validateSpongeDimensions(schematic, ref = 'schematic') {
  const width = positiveInteger(schematic?.Width);
  const height = positiveInteger(schematic?.Height);
  const length = positiveInteger(schematic?.Length);
  if (!width || !height || !length) {
    return { ok: false, reason: `build dry-run Sponge schematic "${ref}" must include positive Width, Height, and Length` };
  }
  for (const [name, value] of [['Width', width], ['Height', height], ['Length', length]]) {
    if (value > SCHEMATIC_LIMITS.dimension) {
      return {
        ok: false,
        reason: `build dry-run Sponge schematic "${ref}" ${name} exceeds the ${SCHEMATIC_LIMITS.dimension}-block dimension limit`,
      };
    }
  }
  const area = width * height;
  const volume = area * length;
  if (!Number.isSafeInteger(area) || !Number.isSafeInteger(volume) || volume > SCHEMATIC_LIMITS.expandedBlocks) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" volume exceeds the ${SCHEMATIC_LIMITS.expandedBlocks}-block expansion limit`,
    };
  }
  return { ok: true, width, height, length, volume };
}

function validateSpongePalette(palette, ref = 'schematic') {
  let entryCount = 0;
  for (const blockState in palette) {
    if (!Object.hasOwn(palette, blockState)) continue;
    entryCount += 1;
    if (entryCount > SCHEMATIC_LIMITS.paletteEntries) break;
  }
  if (entryCount === 0 || entryCount > SCHEMATIC_LIMITS.paletteEntries) {
    return {
      ok: false,
      reason: `build dry-run Sponge schematic "${ref}" Palette must contain 1-${SCHEMATIC_LIMITS.paletteEntries} entries`,
    };
  }

  const paletteById = new Array(entryCount);
  const seenIds = new Set();
  for (const blockState in palette) {
    if (!Object.hasOwn(palette, blockState)) continue;
    const id = palette[blockState];
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 0 || numericId >= entryCount || seenIds.has(numericId)) {
      return { ok: false, reason: `build dry-run Sponge schematic "${ref}" has invalid or non-dense palette id for "${blockState}"` };
    }
    paletteById[numericId] = blockState;
    seenIds.add(numericId);
  }
  return { ok: true, paletteById };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function byteArrayView(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
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
    const numericByte = Number(rawByte);
    if (!Number.isInteger(numericByte) || numericByte < -128 || numericByte > 255) {
      return { ok: false, reason: 'contains a non-byte value' };
    }
    const byte = numericByte & 0xff;
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

async function decompressSchematicNbt(sourceBytes, maximumBytes = SCHEMATIC_LIMITS.decompressedNbtBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError('maximum decompressed NBT size must be a positive safe integer');
  }
  if (!hasGzipHeader(sourceBytes)) {
    if (sourceBytes.length > maximumBytes) {
      throw new Error(`decompressed NBT exceeds the ${formatByteLimit(maximumBytes)} limit`);
    }
    return sourceBytes;
  }
  try {
    const bytes = await gunzipAsync(sourceBytes, { maxOutputLength: maximumBytes });
    if (bytes.length > maximumBytes) {
      throw new Error(`decompressed NBT exceeds the ${formatByteLimit(maximumBytes)} limit`);
    }
    if (hasGzipHeader(bytes)) {
      throw new Error('nested gzip-compressed Sponge NBT is not permitted');
    }
    return bytes;
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`decompressed NBT exceeds the ${formatByteLimit(maximumBytes)} limit`);
    }
    throw err;
  }
}

function hasGzipHeader(bytes) {
  return bytes?.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function formatByteLimit(bytes) {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes}-byte`;
}

export const schematicSafetyTestApi = Object.freeze({
  decompressSchematicNbt,
  loadSpongeSchematic,
  parseSpongeSchematic,
  preflightSpongeNbt,
  validateSchematicBlockCount,
  validateSpongeDimensions,
  validateSpongePalette,
});

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
