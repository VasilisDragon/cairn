import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockModificationPolicy,
  createEmptyWorldModel,
  filterAccessibleStorage,
  findDoNotTouchRegion,
  findNearestKnownResource,
  findNearestKnownStorage,
} from '../../src/state/world_model.js';

function makeModel() {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min: [0, 60, 0], max: [5, 70, 5] },
    reason: 'likely_player_made',
    confidence: 0.91,
  });
  model.resourceSightings.push(
    sighting('resource', 'oak_log', 1, 64, 1),
    sighting('resource', 'oak_log', 12, 64, 0),
    sighting('resource', 'iron_ore', 20, 32, 0),
  );
  model.storageSightings.push(
    sighting('storage', 'chest', 3, 64, 3),
    sighting('storage', 'barrel', 9, 64, 0),
  );
  return model;
}

function sighting(kind, name, x, y, z) {
  return {
    key: `${name}:${x},${y},${z}`,
    kind,
    name,
    position: { x, y, z },
    seenAt: '2026-05-22T00:00:00.000Z',
  };
}

test('do-not-touch lookup and block policy deny protected positions', () => {
  const model = makeModel();

  const region = findDoNotTouchRegion(model, { x: 2, y: 64, z: 2 });
  const denied = blockModificationPolicy(model, { x: 2, y: 64, z: 2 });
  const allowed = blockModificationPolicy(model, { x: 8, y: 64, z: 8 });

  assert.equal(region.id, 'region_protected');
  assert.equal(denied.ok, false);
  assert.equal(denied.action, 'avoid');
  assert.equal(denied.region.id, 'region_protected');
  assert.equal(allowed.ok, true);
});

test('do-not-touch lookup can use a deterministic margin', () => {
  const model = makeModel();

  assert.equal(findDoNotTouchRegion(model, { x: 6, y: 64, z: 5 }), null);
  assert.equal(findDoNotTouchRegion(model, { x: 6, y: 64, z: 5 }, { margin: 1 }).id, 'region_protected');
});

test('nearest known resource skips protected regions by default', () => {
  const model = makeModel();
  const from = { x: 0, y: 64, z: 0 };

  const defaultTarget = findNearestKnownResource(model, from, { name: 'oak_log' });
  const protectedTarget = findNearestKnownResource(model, from, { name: 'oak_log', avoidDoNotTouch: false });

  assert.deepEqual(defaultTarget.position, { x: 12, y: 64, z: 0 });
  assert.deepEqual(protectedTarget.position, { x: 1, y: 64, z: 1 });
  assert.equal(defaultTarget.distance, 12);
});

test('nearest known storage supports name and distance filters', () => {
  const model = makeModel();
  const from = { x: 0, y: 64, z: 0 };

  const anyStorage = findNearestKnownStorage(model, from, { avoidDoNotTouch: false });
  const nearBarrel = findNearestKnownStorage(model, from, { name: 'barrel', maxDistance: 8 });
  const farBarrel = findNearestKnownStorage(model, from, { name: 'barrel', maxDistance: 10 });

  assert.equal(anyStorage.name, 'chest');
  assert.equal(nearBarrel, null);
  assert.equal(farBarrel.name, 'barrel');
});

test('accessible storage filter excludes do-not-touch storage sightings', () => {
  const model = makeModel();
  const result = filterAccessibleStorage(model);

  assert.deepEqual(result.storages.map((storage) => storage.key), ['barrel:9,64,0']);
  assert.deepEqual(result.protected.map((entry) => entry.storage.key), ['chest:3,64,3']);
  assert.equal(result.protected[0].policy.region.id, 'region_protected');
});
