import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMaterialBill,
  buildPlacementPlan,
  detectPlacementIssues,
  dryRunBuildPlan,
  normalizeSchematicBlocks,
} from '../../src/state/build_plan.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';

function pos(x, y, z) {
  return { x, y, z };
}

test('schematic normalization strips state names and material bill ignores air', () => {
  const blocks = normalizeSchematicBlocks({
    blocks: [
      { blockState: 'minecraft:oak_planks[axis=x]', offset: pos(0, 0, 0) },
      { name: 'glass', x: 1, y: 0, z: 0 },
      { block: 'air', x: 2, y: 0, z: 0 },
      { name: 'cave_air', x: 3, y: 0, z: 0 },
    ],
  });

  assert.deepEqual(blocks.map((block) => `${block.name}@${block.offset.x},${block.offset.y},${block.offset.z}`), [
    'oak_planks@0,0,0',
    'glass@1,0,0',
  ]);
  assert.deepEqual(buildMaterialBill(blocks), { glass: 1, oak_planks: 1 });
});

test('placement plan applies anchor and orders bottom-up by layer scan', () => {
  const placements = buildPlacementPlan([
    { name: 'glass', x: 0, y: 1, z: 0 },
    { name: 'oak_planks', x: 1, y: 0, z: 0 },
    { name: 'oak_planks', x: 0, y: 0, z: 0 },
  ], pos(10, 64, -3));

  assert.deepEqual(placements.map((placement) => ({
    name: placement.name,
    offset: placement.offset,
    position: placement.position,
  })), [
    { name: 'oak_planks', offset: pos(0, 0, 0), position: pos(10, 64, -3) },
    { name: 'oak_planks', offset: pos(1, 0, 0), position: pos(11, 64, -3) },
    { name: 'glass', offset: pos(0, 1, 0), position: pos(10, 65, -3) },
  ]);
});

test('dry run reports actionable missing materials after inventory and storage', () => {
  const dryRun = dryRunBuildPlan({
    schematic: [
      { name: 'oak_planks', x: 0, y: 0, z: 0 },
      { name: 'oak_planks', x: 1, y: 0, z: 0 },
      { name: 'glass', x: 0, y: 1, z: 0 },
    ],
    anchor: pos(0, 64, 0),
    inventory: { oak_planks: 1 },
    storages: [
      { id: 'near', position: pos(2, 64, 0), items: { oak_planks: 1 } },
      { id: 'far', position: pos(10, 64, 0), items: { glass: 0 } },
    ],
  });

  assert.equal(dryRun.ok, false);
  assert.deepEqual(dryRun.billOfMaterials, { glass: 1, oak_planks: 2 });
  assert.deepEqual(dryRun.materialPlan.withdrawals.map((w) => `${w.storageId}:${w.item}:${w.count}`), [
    'near:oak_planks:1',
  ]);
  assert.deepEqual(dryRun.missingMaterials, { glass: 1 });
});

test('placement issue detection allows matching existing blocks and blocks mismatches', () => {
  const placements = buildPlacementPlan([
    { name: 'oak_planks', x: 0, y: 0, z: 0 },
    { name: 'glass', x: 1, y: 0, z: 0 },
    { name: 'torch', x: 2, y: 0, z: 0 },
  ], pos(0, 64, 0));

  const issues = detectPlacementIssues(placements, {
    worldBlocks: {
      '0,64,0': 'oak_planks',
      '1,64,0': 'stone',
      '2,64,0': 'air',
    },
  });

  assert.equal(issues.ok, false);
  assert.deepEqual(issues.blocked.map((issue) => `${issue.name}:${issue.existing}`), ['glass:stone']);
});

test('dry run flags do-not-touch protected build positions', () => {
  const model = createEmptyWorldModel();
  model.doNotTouchRegions.push({
    id: 'region_001',
    bbox: { min: [10, 64, 10], max: [12, 66, 12] },
    reason: 'likely_player_made',
    confidence: 0.9,
  });

  const dryRun = dryRunBuildPlan({
    schematic: [{ name: 'oak_planks', x: 0, y: 0, z: 0 }],
    anchor: pos(11, 65, 11),
    inventory: { oak_planks: 1 },
    worldModel: model,
  });

  assert.equal(dryRun.ok, false);
  assert.equal(dryRun.placementIssues.protected[0].reason, 'inside do-not-touch region region_001');
});

test('placement issue detection can flag hazards and unsupported placements', () => {
  const placements = buildPlacementPlan([
    { name: 'oak_planks', x: 0, y: 0, z: 0 },
    { name: 'glass', x: 2, y: 0, z: 0 },
    { name: 'torch', x: 10, y: 0, z: 0 },
  ], pos(0, 64, 0));

  const issues = detectPlacementIssues(placements, {
    requireSupport: true,
    worldBlocks: {
      '0,63,0': 'stone',
      '1,64,0': 'lava',
    },
  });

  assert.equal(issues.ok, false);
  assert.deepEqual(issues.unsafe.map((issue) => issue.reason), [
    'near hazard lava',
    'near hazard lava',
    'no adjacent support block in world or earlier placement',
  ]);
});
