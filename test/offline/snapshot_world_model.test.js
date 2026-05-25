import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import buildSnapshot from '../../src/state/snapshot.js';
import {
  WorldModelStore,
  createEmptyWorldModel,
  ingestBlockSamples,
} from '../../src/state/world_model.js';

function makeBot() {
  return {
    entity: { position: { x: 12.345, y: 64, z: -3.21 } },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
  };
}

function sample(name, x, y, z) {
  return { name, position: { x, y, z } };
}

function makeModel() {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  ingestBlockSamples(model, [
    sample('oak_log', 0, 64, 0),
    sample('chest', 1, 64, 0),
    sample('crafting_table', 2, 64, 0),
    sample('lava', 3, 64, 0),
  ], {
    now: '2026-05-22T00:01:00.000Z',
    source: 'test',
  });
  return model;
}

test('snapshot omits world model summary unless explicitly provided', () => {
  const snapshot = buildSnapshot(makeBot());

  assert.equal('worldModel' in snapshot, false);
});

test('snapshot includes compact world model summary when model is provided', () => {
  const snapshot = buildSnapshot(makeBot(), {
    worldModel: makeModel(),
    worldModelSummaryOptions: { limit: 1 },
  });

  assert.equal(snapshot.worldModel.visitedAreaCount, 1);
  assert.equal(snapshot.worldModel.knownStorage[0].name, 'chest');
  assert.equal(snapshot.worldModel.recentHazards[0].name, 'lava');
  assert.equal('visitedAreas' in snapshot.worldModel, false);
  assert.equal('resourceSightings' in snapshot.worldModel, false);
});

test('snapshot can load compact world model summary from a store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-snapshot-world-model-'));
  const store = new WorldModelStore(path.join(dir, 'world-model.json'));
  store.save(makeModel());

  const snapshot = buildSnapshot(makeBot(), { worldModelStore: store });

  assert.equal(snapshot.worldModel.visitedAreaCount, 1);
  assert.equal(snapshot.worldModel.knownStorage.some((sighting) => sighting.name === 'chest'), true);
});

test('snapshot reports unavailable world model summary without throwing', () => {
  const snapshot = buildSnapshot(makeBot(), {
    worldModelStore: {
      load() {
        throw new Error('store unavailable');
      },
    },
  });

  assert.equal('worldModel' in snapshot, false);
  assert.deepEqual(snapshot.worldModelStatus, {
    ok: false,
    reason: 'world-model summary unavailable: store unavailable',
  });
});
