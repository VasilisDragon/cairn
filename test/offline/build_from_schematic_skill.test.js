import test from 'node:test';
import assert from 'node:assert/strict';

import { run as runBuild } from '../../src/skills/build_from_schematic.js';
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
