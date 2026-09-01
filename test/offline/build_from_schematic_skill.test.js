import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  run as runBuild,
  SCHEMATIC_LIMITS,
  SPONGE_NBT_BUDGETS,
  schematicSafetyTestApi,
} from '../../src/skills/build_from_schematic.js';
import { validateSkillCall } from '../../src/skills/schema.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';

function pos(x, y, z) {
  return { x, y, z };
}

function item(name, count) {
  return { name, count };
}

function makeBot(overrides = {}) {
  return {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    registry: { blocksByName: {}, itemsByName: {} },
    blockAt() {
      return { name: 'air' };
    },
    ...overrides,
  };
}

function ctx(extra = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    ...extra,
  };
}

function block(name, x, y, z) {
  return { name, x, y, z };
}

function nbtShort(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value);
  return bytes;
}

function nbtInt(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

function nbtString(value) {
  const bytes = Buffer.from(value, 'utf8');
  assert.ok(bytes.length <= 0xffff);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function nbtNamedTag(type, name, payload) {
  return Buffer.concat([Buffer.from([type]), nbtString(name), payload]);
}

function nbtRoot(tags) {
  return Buffer.concat([Buffer.from([10, 0, 0]), ...tags, Buffer.from([0])]);
}

function spongeDimensionTags(width = 1, height = 1, length = 1) {
  return [
    nbtNamedTag(2, 'Width', nbtShort(width)),
    nbtNamedTag(2, 'Height', nbtShort(height)),
    nbtNamedTag(2, 'Length', nbtShort(length)),
  ];
}

function spongePaletteTag(entries) {
  return nbtNamedTag(10, 'Palette', Buffer.concat([
    ...entries.map(([name, id]) => nbtNamedTag(3, name, nbtInt(id))),
    Buffer.from([0]),
  ]));
}

function spongeBlockDataTag(bytes) {
  return nbtNamedTag(7, 'BlockData', Buffer.concat([nbtInt(bytes.length), bytes]));
}

test('build_from_schematic schema allows dry-run inline blocks without a file path', () => {
  assert.deepEqual(validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      blocks: [block('oak_planks', 0, 0, 0)],
      anchor: pos(0, 64, 0),
      dryRun: true,
    },
  }), { ok: true });
});

test('build_from_schematic schema allows dry-run JSON and Sponge schematic files', () => {
  assert.deepEqual(validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      schematic: 'simple_dry_run.json',
      anchor: pos(0, 64, 0),
      dryRun: true,
    },
  }), { ok: true });

  assert.deepEqual(validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      schematic: 'simple_sponge.schem',
      anchor: pos(0, 64, 0),
      dryRun: true,
    },
  }), { ok: true });
});

test('build_from_schematic dry-run succeeds with available materials and clear targets', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 2), item('glass', 1)] },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [
      block('oak_planks', 0, 0, 0),
      block('oak_planks', 1, 0, 0),
      block('glass', 0, 1, 0),
    ],
    anchor: pos(10, 64, 10),
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'build dry-run ok (3 blocks)');
  assert.deepEqual(result.dryRun.billOfMaterials, { glass: 1, oak_planks: 2 });
  assert.deepEqual(result.dryRun.placements.map((placement) => placement.position), [
    pos(10, 64, 10),
    pos(11, 64, 10),
    pos(10, 65, 10),
  ]);
});

test('build_from_schematic dry-run can load a JSON file under schematics', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 1), item('glass', 1), item('torch', 1)] },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    schematic: 'simple_dry_run.json',
    anchor: pos(10, 64, 10),
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'build dry-run ok (3 blocks)');
  assert.deepEqual(result.dryRun.billOfMaterials, { glass: 1, oak_planks: 1, torch: 1 });
  assert.deepEqual(result.dryRun.placements.map((placement) => `${placement.name}@${placement.position.x},${placement.position.y},${placement.position.z}`), [
    'oak_planks@10,64,10',
    'glass@11,64,10',
    'torch@10,65,10',
  ]);
});

test('build_from_schematic dry-run can load a Sponge .schem file under schematics', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 1), item('glass', 1), item('torch', 1)] },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    schematic: 'simple_sponge.schem',
    anchor: pos(10, 64, 10),
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'build dry-run ok (3 blocks)');
  assert.deepEqual(result.dryRun.billOfMaterials, { glass: 1, oak_planks: 1, torch: 1 });
  assert.deepEqual(result.dryRun.placements.map((placement) => `${placement.name}@${placement.position.x},${placement.position.y},${placement.position.z}`), [
    'oak_planks@10,64,10',
    'glass@11,64,10',
    'torch@10,65,10',
  ]);
});

test('build_from_schematic preserves raw uncompressed Sponge NBT support', async (t) => {
  const name = `.security-raw-sponge-${process.pid}.schem`;
  const rawPath = path.resolve('schematics', name);
  t.after(() => fs.rmSync(rawPath, { force: true }));
  fs.writeFileSync(rawPath, gunzipSync(fs.readFileSync(path.resolve('schematics', 'simple_sponge.schem'))));

  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 1), item('glass', 1), item('torch', 1)] },
  });
  const result = await runBuild(bot, {
    dryRun: true,
    schematic: name,
    anchor: pos(10, 64, 10),
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'build dry-run ok (3 blocks)');
});

test('build_from_schematic rejects malformed JSON schematic blocks before normalization', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 1)] },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    schematic: 'malformed_dry_run.json',
    anchor: pos(10, 64, 10),
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    'build dry-run schematic "malformed_dry_run.json": "blocks[0]" must include one of name|block|blockState|block_state'
  );
  assert.equal(result.dryRun, undefined);
});

test('build_from_schematic rejects registry-unknown block names before material planning', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('definitely_not_a_block', 1)] },
    registry: { blocksByName: { air: {}, oak_planks: {} }, itemsByName: {} },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [block('definitely_not_a_block', 0, 0, 0)],
    anchor: pos(10, 64, 10),
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'build dry-run unknown block "definitely_not_a_block" at blocks[0]');
  assert.equal(result.dryRun, undefined);
});

test('build_from_schematic dry-run reports missing materials through skill result', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 1)] },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [block('oak_planks', 0, 0, 0), block('glass', 0, 1, 0)],
    anchor: pos(0, 64, 0),
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing materials: 1 glass/);
  assert.deepEqual(result.dryRun.missingMaterials, { glass: 1 });
});

test('build_from_schematic dry-run uses known world-model storage contents', async () => {
  const model = createEmptyWorldModel();
  model.storageSightings.push({
    key: 'chest:3,64,0',
    kind: 'storage',
    name: 'chest',
    position: pos(3, 64, 0),
    seenAt: '2026-05-22T00:00:00.000Z',
    contents: { glass: 1, oak_planks: 1 },
  });
  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 1)] },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [
      block('oak_planks', 0, 0, 0),
      block('oak_planks', 1, 0, 0),
      block('glass', 0, 1, 0),
    ],
    anchor: pos(0, 64, 0),
  }, ctx({ worldModel: model }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.dryRun.missingMaterials, {});
  assert.deepEqual(result.dryRun.materialPlan.withdrawals.map((w) => `${w.storageId}:${w.item}:${w.count}`), [
    'chest:3,64,0:glass:1',
    'chest:3,64,0:oak_planks:1',
  ]);
});

test('build_from_schematic dry-run ignores protected world-model storage contents', async () => {
  const model = createEmptyWorldModel();
  model.storageSightings.push({
    key: 'chest:3,64,0',
    kind: 'storage',
    name: 'chest',
    position: pos(3, 64, 0),
    seenAt: '2026-05-22T00:00:00.000Z',
    contents: { glass: 1 },
  });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min: [3, 63, 0], max: [3, 65, 0] },
    reason: 'likely_player_made',
    confidence: 0.9,
  });

  const result = await runBuild(makeBot(), {
    dryRun: true,
    blocks: [block('glass', 0, 0, 0)],
    anchor: pos(0, 64, 0),
  }, ctx({ worldModel: model }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.dryRun.materialPlan.withdrawals, []);
  assert.deepEqual(result.dryRun.missingMaterials, { glass: 1 });
});

test('build_from_schematic dry-run reports blocked target positions', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('glass', 1)] },
    blockAt(position) {
      return position.x === 0 && position.y === 64 && position.z === 0 ? { name: 'stone' } : { name: 'air' };
    },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [block('glass', 0, 0, 0)],
    anchor: pos(0, 64, 0),
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /blocked placements: glass at 0,64,0 occupied by stone/);
});

test('build_from_schematic dry-run reports world-read failures', async () => {
  const bot = makeBot({
    inventory: { items: () => [item('glass', 1)] },
    blockAt() {
      throw new Error('block cache unavailable');
    },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [block('glass', 0, 0, 0)],
    anchor: pos(0, 64, 0),
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'build dry-run failed during world reads: block cache unavailable');
});

test('build_from_schematic dry-run reports preempt when world read aborts before throwing', async () => {
  const controller = new AbortController();
  const bot = makeBot({
    inventory: { items: () => [item('glass', 1)] },
    blockAt() {
      controller.abort('reactive-preempt');
      throw new Error('block cache interrupted');
    },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [block('glass', 0, 0, 0)],
    anchor: pos(0, 64, 0),
  }, ctx({ signal: controller.signal }));

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during build dry-run world reads');
});

test('build_from_schematic dry-run consumes world-model do-not-touch policy from context', async () => {
  const model = createEmptyWorldModel();
  model.doNotTouchRegions.push({
    id: 'region_001',
    bbox: { min: [0, 64, 0], max: [2, 66, 2] },
    reason: 'likely_player_made',
    confidence: 0.9,
  });
  const bot = makeBot({
    inventory: { items: () => [item('oak_planks', 1)] },
  });

  const result = await runBuild(bot, {
    dryRun: true,
    blocks: [block('oak_planks', 0, 0, 0)],
    anchor: pos(1, 65, 1),
  }, ctx({ worldModel: model }));

  assert.equal(result.ok, false);
  assert.match(result.reason, /protected placements: oak_planks at 1,65,1 inside do-not-touch region region_001/);
});

test('build_from_schematic rejects unsupported litematic parsing and live placement explicitly', async () => {
  const bot = makeBot();
  const placement = await runBuild(bot, { schematic: 'house.schem', anchor: pos(0, 64, 0) }, ctx());
  const fileDryRun = await runBuild(bot, { dryRun: true, schematic: 'house.litematic', anchor: pos(0, 64, 0) }, ctx());

  assert.equal(placement.ok, false);
  assert.match(placement.reason, /placement is not implemented/);
  assert.equal(fileDryRun.ok, false);
  assert.match(fileDryRun.reason, /\.litematic parsing is not implemented/);
});

test('build_from_schematic rejects dry-run file paths outside schematics', async () => {
  const result = await runBuild(makeBot(), {
    dryRun: true,
    schematic: '../keys.json',
    anchor: pos(0, 64, 0),
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'build dry-run schematic path must stay under schematics/');
});

test('schematic safety limits are fixed at the stabilization policy values', () => {
  assert.deepEqual(SCHEMATIC_LIMITS, {
    fileBytes: 8 * 1024 * 1024,
    decompressedNbtBytes: 32 * 1024 * 1024,
    dimension: 256,
    expandedBlocks: 262_144,
    paletteEntries: 4_096,
    blockDataBytesPerBlock: 5,
    blockDataBytesAbsolute: 1_310_720,
  });
  assert.deepEqual(SPONGE_NBT_BUDGETS, {
    depth: 64,
    tags: 65_536,
    nodes: 262_144,
    stringBytes: 4 * 1024 * 1024,
    aggregateArrayBytes: 8 * 1024 * 1024,
  });
});

test('inline expansion count accepts the exact boundary and rejects one over before iteration', async () => {
  assert.deepEqual(
    schematicSafetyTestApi.validateSchematicBlockCount(SCHEMATIC_LIMITS.expandedBlocks, 'inline schematic'),
    { ok: true }
  );
  assert.match(
    schematicSafetyTestApi.validateSchematicBlockCount(SCHEMATIC_LIMITS.expandedBlocks + 1, 'inline schematic').reason,
    /262144-block expansion limit/
  );

  const oversized = new Array(SCHEMATIC_LIMITS.expandedBlocks + 1);
  const result = await runBuild(makeBot(), {
    dryRun: true,
    blocks: oversized,
    anchor: pos(0, 64, 0),
  }, ctx());
  assert.equal(result.ok, false);
  assert.match(result.reason, /262144-block expansion limit/);
});

test('Sponge dimensions accept exact boundaries and reject dimension or safe-volume overflow', () => {
  assert.equal(schematicSafetyTestApi.validateSpongeDimensions({
    Width: SCHEMATIC_LIMITS.dimension,
    Height: SCHEMATIC_LIMITS.dimension,
    Length: 4,
  }, 'boundary').volume, SCHEMATIC_LIMITS.expandedBlocks);

  assert.match(schematicSafetyTestApi.validateSpongeDimensions({
    Width: SCHEMATIC_LIMITS.dimension + 1,
    Height: 1,
    Length: 1,
  }, 'too-wide').reason, /Width exceeds the 256-block dimension limit/);

  assert.match(schematicSafetyTestApi.validateSpongeDimensions({
    Width: SCHEMATIC_LIMITS.dimension,
    Height: SCHEMATIC_LIMITS.dimension,
    Length: 5,
  }, 'too-large').reason, /volume exceeds the 262144-block expansion limit/);
});

test('Sponge palette accepts 4096 dense IDs and rejects oversized, sparse, or duplicate IDs', () => {
  const boundaryPalette = Object.fromEntries(
    Array.from({ length: SCHEMATIC_LIMITS.paletteEntries }, (_, id) => [`minecraft:test_${id}`, id])
  );
  const accepted = schematicSafetyTestApi.validateSpongePalette(boundaryPalette, 'boundary');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.paletteById.length, SCHEMATIC_LIMITS.paletteEntries);

  const oversizedPalette = { ...boundaryPalette, 'minecraft:one_too_many': SCHEMATIC_LIMITS.paletteEntries };
  assert.match(
    schematicSafetyTestApi.validateSpongePalette(oversizedPalette, 'oversized').reason,
    /Palette must contain 1-4096 entries/
  );
  assert.match(
    schematicSafetyTestApi.validateSpongePalette({ 'minecraft:a': 0, 'minecraft:b': 2 }, 'sparse').reason,
    /invalid or non-dense palette id/
  );
  assert.match(
    schematicSafetyTestApi.validateSpongePalette({ 'minecraft:a': 0, 'minecraft:b': 0 }, 'duplicate').reason,
    /invalid or non-dense palette id/
  );
});

test('Sponge BlockData is bounded before decode and still supports multibyte IDs and negative offsets', () => {
  const tooLarge = schematicSafetyTestApi.parseSpongeSchematic({
    Width: 1,
    Height: 1,
    Length: 1,
    Palette: { 'minecraft:air': 0 },
    BlockData: [0, 0, 0, 0, 0, 0],
  }, 'blockdata-over');
  assert.match(tooLarge.reason, /BlockData exceeds 5 bytes/);

  const exactLength = schematicSafetyTestApi.parseSpongeSchematic({
    Width: 1,
    Height: 1,
    Length: 1,
    Palette: { 'minecraft:air': 0 },
    BlockData: [0x80, 0x80, 0x80, 0x80, 0x00],
  }, 'blockdata-boundary');
  assert.equal(exactLength.ok, true);

  const palette = Object.fromEntries(Array.from({ length: 129 }, (_, id) => [`minecraft:test_${id}`, id]));
  const multibyte = schematicSafetyTestApi.parseSpongeSchematic({
    Width: 1,
    Height: 1,
    Length: 1,
    Palette: palette,
    BlockData: [0x80, 0x01],
    Offset: new Int32Array([-3, -2, -1]),
  }, 'multibyte');
  assert.equal(multibyte.ok, true);
  assert.deepEqual(multibyte.blocks, [{
    blockState: 'minecraft:test_128',
    offset: { x: -3, y: -2, z: -1 },
  }]);
});

test('bounded binary Sponge parser preserves multibyte varints, signed offsets, raw NBT, and one gzip layer', async () => {
  const palette = Array.from({ length: 129 }, (_, id) => [`minecraft:test_${id}`, id]);
  const offset = nbtNamedTag(11, 'Offset', Buffer.concat([
    nbtInt(3),
    nbtInt(-3),
    nbtInt(-2),
    nbtInt(-1),
  ]));
  const raw = nbtRoot([
    ...spongeDimensionTags(),
    spongePaletteTag(palette),
    spongeBlockDataTag(Buffer.from([0x80, 0x01])),
    offset,
  ]);

  const rawResult = await schematicSafetyTestApi.loadSpongeSchematic(raw, 'raw-multibyte');
  const gzipResult = await schematicSafetyTestApi.loadSpongeSchematic(gzipSync(raw), 'gzip-multibyte');
  const expected = [{
    blockState: 'minecraft:test_128',
    offset: { x: -3, y: -2, z: -1 },
  }];
  assert.equal(rawResult.ok, true);
  assert.equal(gzipResult.ok, true);
  assert.deepEqual(rawResult.schematic.blocks, expected);
  assert.deepEqual(gzipResult.schematic.blocks, expected);
});

test('binary Sponge preflight enforces dimensions, palette, and BlockData before prismarine allocation', async () => {
  const palette = spongePaletteTag([['minecraft:air', 0]]);

  const absoluteOverflow = nbtRoot([
    ...spongeDimensionTags(),
    palette,
    nbtNamedTag(7, 'BlockData', nbtInt(SCHEMATIC_LIMITS.blockDataBytesAbsolute + 1)),
  ]);
  const absoluteResult = await schematicSafetyTestApi.loadSpongeSchematic(absoluteOverflow, 'absolute-overflow');
  assert.equal(absoluteResult.ok, false);
  assert.match(absoluteResult.reason, /BlockData exceeds the 1310720-byte absolute limit/);
  assert.doesNotMatch(absoluteResult.reason, /truncated/);

  const volumeOverflow = nbtRoot([
    ...spongeDimensionTags(),
    palette,
    spongeBlockDataTag(Buffer.alloc(6)),
  ]);
  const volumeResult = await schematicSafetyTestApi.loadSpongeSchematic(volumeOverflow, 'volume-overflow');
  assert.equal(volumeResult.ok, false);
  assert.match(volumeResult.reason, /BlockData exceeds 5 bytes \(five times volume\)/);

  const dimensionOverflow = nbtRoot([
    ...spongeDimensionTags(SCHEMATIC_LIMITS.dimension + 1, 1, 1),
    palette,
    spongeBlockDataTag(Buffer.from([0])),
  ]);
  const dimensionResult = await schematicSafetyTestApi.loadSpongeSchematic(dimensionOverflow, 'dimension-overflow');
  assert.equal(dimensionResult.ok, false);
  assert.match(dimensionResult.reason, /Width exceeds the 256-block dimension limit/);

  const oversizedPalette = spongePaletteTag(Array.from(
    { length: SCHEMATIC_LIMITS.paletteEntries + 1 },
    (_, id) => [`minecraft:test_${id}`, id]
  ));
  const paletteOverflow = nbtRoot([
    ...spongeDimensionTags(),
    oversizedPalette,
    spongeBlockDataTag(Buffer.from([0])),
  ]);
  const paletteResult = await schematicSafetyTestApi.loadSpongeSchematic(paletteOverflow, 'palette-overflow');
  assert.equal(paletteResult.ok, false);
  assert.match(paletteResult.reason, /Palette contains more than 4096 entries/);
});

test('binary Sponge preflight rejects oversized unknown arrays and lists from their declarations', async () => {
  const unknownArray = nbtRoot([
    nbtNamedTag(7, 'UnknownPayload', nbtInt(SPONGE_NBT_BUDGETS.aggregateArrayBytes + 1)),
  ]);
  const arrayResult = await schematicSafetyTestApi.loadSpongeSchematic(unknownArray, 'unknown-array');
  assert.equal(arrayResult.ok, false);
  assert.match(arrayResult.reason, /aggregate byte array payload exceeds the 8 MiB budget/);
  assert.doesNotMatch(arrayResult.reason, /truncated/);

  const unknownList = nbtRoot([
    nbtNamedTag(9, 'UnknownList', Buffer.concat([
      Buffer.from([1]),
      nbtInt(SPONGE_NBT_BUDGETS.nodes + 1),
    ])),
  ]);
  const listResult = await schematicSafetyTestApi.loadSpongeSchematic(unknownList, 'unknown-list');
  assert.equal(listResult.ok, false);
  assert.match(listResult.reason, /node count exceeds the 262144-node budget/);
  assert.doesNotMatch(listResult.reason, /truncated/);
});

test('oversized unknown NBT arrays fail cleanly in a low-memory child', () => {
  const unknownArray = nbtRoot([
    nbtNamedTag(7, 'UnknownPayload', nbtInt(SPONGE_NBT_BUDGETS.aggregateArrayBytes + 1)),
  ]);
  const moduleHref = new URL('../../src/skills/build_from_schematic.js', import.meta.url).href;
  const script = [
    `import { schematicSafetyTestApi } from ${JSON.stringify(moduleHref)};`,
    `const bytes = Buffer.from(${JSON.stringify(unknownArray.toString('base64'))}, 'base64');`,
    "const result = await schematicSafetyTestApi.loadSpongeSchematic(bytes, 'low-memory-array');",
    "if (result.ok || !/aggregate byte array payload exceeds the 8 MiB budget/.test(result.reason)) {",
    "  process.stderr.write(JSON.stringify(result));",
    '  process.exit(1);',
    '}',
  ].join('\n');
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=64',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

test('bounded gzip accepts the exact output limit and rejects one byte less', async () => {
  const raw = Buffer.from('bounded-nbt-output');
  const compressed = gzipSync(raw);
  assert.deepEqual(
    await schematicSafetyTestApi.decompressSchematicNbt(compressed, raw.length),
    raw
  );
  await assert.rejects(
    schematicSafetyTestApi.decompressSchematicNbt(compressed, raw.length - 1),
    /decompressed NBT exceeds the 17-byte limit/
  );
});

test('bounded gzip rejects a second gzip layer before the NBT decoder', async () => {
  const nested = gzipSync(gzipSync(Buffer.from('nested-gzip-payload')));
  await assert.rejects(
    schematicSafetyTestApi.decompressSchematicNbt(nested),
    /nested gzip-compressed Sponge NBT is not permitted/
  );
});

test('schematic file cap is enforced from file metadata before parsing', async (t) => {
  const schematicDirectory = path.resolve('schematics');
  const exactName = `.security-file-limit-exact-${process.pid}.json`;
  const overName = `.security-file-limit-over-${process.pid}.json`;
  const exactPath = path.join(schematicDirectory, exactName);
  const overPath = path.join(schematicDirectory, overName);
  t.after(() => {
    fs.rmSync(exactPath, { force: true });
    fs.rmSync(overPath, { force: true });
  });

  fs.closeSync(fs.openSync(exactPath, 'w'));
  fs.truncateSync(exactPath, SCHEMATIC_LIMITS.fileBytes);
  fs.closeSync(fs.openSync(overPath, 'w'));
  fs.truncateSync(overPath, SCHEMATIC_LIMITS.fileBytes + 1);

  const exact = await runBuild(makeBot(), {
    dryRun: true,
    schematic: exactName,
    anchor: pos(0, 64, 0),
  }, ctx());
  const over = await runBuild(makeBot(), {
    dryRun: true,
    schematic: overName,
    anchor: pos(0, 64, 0),
  }, ctx());

  assert.doesNotMatch(exact.reason, /8 MiB file limit/);
  assert.equal(over.reason, `build dry-run schematic "${overName}" exceeds the 8 MiB file limit`);
});
