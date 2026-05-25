import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WorldModelStore,
  buildAdvisorWorldModelSummary,
  classifyBlockRegion,
  createEmptyWorldModel,
  ingestBlockSamples,
  renderWorldModelReport,
} from '../../src/state/world_model.js';

function sample(name, x, y, z) {
  return { name, position: { x, y, z } };
}

function naturalHill() {
  const blocks = [];
  for (let x = 0; x < 6; x++) {
    for (let z = 0; z < 6; z++) {
      const y = 64 + Math.floor((x + z) / 5);
      blocks.push(sample('grass_block', x, y, z));
      blocks.push(sample('dirt', x, y - 1, z));
      if ((x + z) % 7 === 0) blocks.push(sample('oak_log', x, y + 1, z));
      if ((x + z) % 7 === 1) blocks.push(sample('oak_leaves', x, y + 2, z));
    }
  }
  return blocks;
}

function plankHouse() {
  const blocks = [];
  for (let x = 0; x <= 4; x++) {
    for (let z = 0; z <= 4; z++) {
      blocks.push(sample('oak_planks', x, 64, z));
      if (x === 0 || x === 4 || z === 0 || z === 4) {
        blocks.push(sample('oak_planks', x, 65, z));
        blocks.push(sample('oak_planks', x, 66, z));
      }
    }
  }
  blocks.push(sample('oak_door', 2, 65, 0));
  blocks.push(sample('glass_pane', 0, 66, 2));
  blocks.push(sample('torch', 1, 66, 1));
  blocks.push(sample('chest', 3, 65, 3));
  return blocks;
}

function villageLikeStructure() {
  return [
    sample('cobblestone', 0, 64, 0),
    sample('cobblestone', 1, 64, 0),
    sample('cobblestone', 0, 64, 1),
    sample('cobblestone', 1, 64, 1),
    sample('oak_planks', 0, 65, 0),
    sample('oak_planks', 1, 65, 0),
    sample('oak_planks', 0, 65, 1),
    sample('oak_planks', 1, 65, 1),
    sample('hay_block', 3, 64, 0),
    sample('bell', 2, 65, 0),
    sample('lantern', 1, 66, 1),
  ];
}

test('natural terrain classifies as natural and does not create interesting regions', () => {
  const region = classifyBlockRegion(naturalHill());
  const model = ingestBlockSamples(createEmptyWorldModel(), naturalHill(), { now: '2026-05-22T00:00:00.000Z' });

  assert.equal(region.classification, 'natural');
  assert.ok(region.confidence < 0.55);
  assert.equal(model.interestingRegions.length, 0);
});

test('simple plank glass door house flags likely player-made region', () => {
  const region = classifyBlockRegion(plankHouse(), { id: 'house' });

  assert.equal(region.classification, 'likely_player_made');
  assert.ok(region.confidence >= 0.8);
  assert.ok(region.signals.includes('door_present'));
  assert.ok(region.signals.includes('glass_present'));
  assert.ok(region.signals.includes('rectangular_planes'));
  assert.equal(region.recommendedPolicy, 'avoid_breaking_and_log_for_human_review');
});

test('village-like generated structure flags artificial/generated structure', () => {
  const region = classifyBlockRegion(villageLikeStructure(), { id: 'village' });

  assert.equal(region.classification, 'artificial_or_generated_structure');
  assert.ok(region.signals.includes('village_marker'));
  assert.equal(region.recommendedPolicy, 'avoid_breaking_and_log_for_human_review');
});

test('isolated chest and crafting table flag as player-interesting', () => {
  const region = classifyBlockRegion([
    sample('grass_block', 0, 64, 0),
    sample('chest', 1, 64, 0),
    sample('crafting_table', 2, 64, 0),
  ]);

  assert.equal(region.classification, 'player_interesting');
  assert.ok(region.signals.includes('storage_present'));
  assert.ok(region.signals.includes('workstation_present'));
});

test('ingest records visited areas, resources, hazards, storage, and do-not-touch regions', () => {
  const model = createEmptyWorldModel({ home: { x: 10, y: 65, z: 10 } });
  ingestBlockSamples(model, [
    ...plankHouse(),
    sample('diamond_ore', 8, 12, 8),
    sample('lava', 9, 11, 8),
  ], { now: '2026-05-22T00:00:00.000Z', source: 'unit' });

  assert.deepEqual(model.markers.home, { x: 10, y: 65, z: 10 });
  assert.equal(model.visitedAreas.length, 1);
  assert.equal(model.resourceSightings.some((s) => s.name === 'diamond_ore'), true);
  assert.equal(model.hazardSightings.some((s) => s.name === 'lava'), true);
  assert.equal(model.storageSightings.some((s) => s.name === 'chest'), true);
  assert.equal(model.interestingRegions.length, 1);
  assert.equal(model.doNotTouchRegions.length, 1);
});

test('repeated ingest compacts visited areas and protected regions', () => {
  const model = createEmptyWorldModel();
  ingestBlockSamples(model, plankHouse(), { now: '2026-05-22T00:00:00.000Z', source: 'observe' });
  ingestBlockSamples(model, plankHouse(), { now: '2026-05-22T00:01:00.000Z', source: 'observe' });

  assert.equal(model.visitedAreas.length, 1);
  assert.equal(model.visitedAreas[0].seenAt, '2026-05-22T00:00:00.000Z');
  assert.equal(model.visitedAreas[0].lastSeenAt, '2026-05-22T00:01:00.000Z');
  assert.equal(model.visitedAreas[0].seenCount, 2);
  assert.equal(model.storageSightings.length, 1);
  assert.equal(model.interestingRegions.length, 1);
  assert.equal(model.interestingRegions[0].seenCount, 2);
  assert.equal(model.interestingRegions[0].lastSeenAt, '2026-05-22T00:01:00.000Z');
  assert.equal(model.doNotTouchRegions.length, 1);
  assert.equal(model.doNotTouchRegions[0].seenCount, 2);
  assert.equal(buildAdvisorWorldModelSummary(model).visitedAreaCount, 1);
  assert.equal(buildAdvisorWorldModelSummary(model).interestingRegions[0].seenCount, 2);
});

test('advisor summary is compact and excludes raw block grids', () => {
  const model = createEmptyWorldModel();
  ingestBlockSamples(model, plankHouse(), { now: '2026-05-22T00:00:00.000Z' });

  const summary = buildAdvisorWorldModelSummary(model);

  assert.equal(summary.interestingRegions.length, 1);
  assert.equal(summary.visitedAreaCount, 1);
  assert.equal(summary.interestingRegions[0].classification, 'likely_player_made');
  assert.equal('blocks' in summary.interestingRegions[0], false);
});

test('world model store persists machine-readable JSON and report renders human summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-world-model-'));
  const filePath = path.join(dir, 'world-model.json');
  const store = new WorldModelStore(filePath);

  const model = store.ingestBlockSamples(plankHouse(), { now: '2026-05-22T00:00:00.000Z' });
  const loaded = store.load();
  const report = renderWorldModelReport(loaded);

  assert.equal(fs.existsSync(filePath), true);
  assert.equal(loaded.interestingRegions.length, model.interestingRegions.length);
  assert.match(report, /Interesting regions: 1/);
  assert.match(report, /likely_player_made/);
});
