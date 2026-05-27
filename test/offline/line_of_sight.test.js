import test from 'node:test';
import assert from 'node:assert/strict';

import { entityAimPoint, readEntityLineOfSight } from '../../src/control/line_of_sight.js';

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) { return pos(this.x + dx, this.y + dy, this.z + dz); },
    minus(other) { return pos(this.x - other.x, this.y - other.y, this.z - other.z); },
    scaled(factor) { return pos(this.x * factor, this.y * factor, this.z * factor); },
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
}

test('entityAimPoint targets bounded entity body height', () => {
  assert.deepEqual(pointRecord(entityAimPoint({ position: pos(1, 64, 2), height: 1.7 })), { x: 1, y: 65.19, z: 2 });
  assert.deepEqual(pointRecord(entityAimPoint({ position: pos(1, 64, 2), height: 4 })), { x: 1, y: 65.6, z: 2 });
  assert.deepEqual(pointRecord(entityAimPoint({ position: pos(1, 64, 2), height: 0.2 })), { x: 1, y: 64.5, z: 2 });
});

test('readEntityLineOfSight falls back to world raycast when canSeeEntity is unavailable', () => {
  const calls = [];
  const bot = {
    entity: { position: pos(0, 64, 0) },
    world: {
      raycast(origin, direction, distance) {
        calls.push({ origin, direction, distance });
        return null;
      },
    },
  };

  assert.equal(readEntityLineOfSight(bot, { name: 'creeper', id: 1, position: pos(10, 64, 0), height: 1.7 }), true);
  assert.equal(calls.length, 1);
  assert.equal(Math.round(calls[0].distance * 10) / 10, 10);
});

test('readEntityLineOfSight treats raycast block hit as blocked', () => {
  const bot = {
    entity: { position: pos(0, 64, 0) },
    world: {
      raycast() {
        return { name: 'stone' };
      },
    },
  };

  assert.equal(readEntityLineOfSight(bot, { name: 'creeper', id: 1, position: pos(10, 64, 0), height: 1.7 }), false);
});

test('readEntityLineOfSight can verify canSeeEntity false with raycast when requested', () => {
  const calls = [];
  const bot = {
    entity: { position: pos(0, 64, 0), height: 1.8 },
    canSeeEntity() {
      return false;
    },
    world: {
      raycast(origin, direction, distance) {
        calls.push({ origin, direction, distance });
        return null;
      },
    },
  };
  const target = { name: 'creeper', id: 1, position: pos(10, 64, 0), height: 1.7 };

  assert.equal(readEntityLineOfSight(bot, target), false);
  assert.equal(calls.length, 0);
  assert.equal(readEntityLineOfSight(bot, target, null, { raycastOnCanSeeFalse: true }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(pointRecord(calls[0].origin), { x: 0, y: 65.62, z: 0 });
});

test('readEntityLineOfSight uses raycast after canSeeEntity throws', () => {
  const warnings = [];
  const bot = {
    entity: { position: pos(0, 64, 0) },
    canSeeEntity() {
      throw new Error('metadata unavailable');
    },
    world: {
      raycast() {
        return null;
      },
    },
  };

  assert.equal(readEntityLineOfSight(bot, { name: 'creeper', id: 1, position: pos(10, 64, 0), height: 1.7 }, {
    warn(event, payload) {
      warnings.push({ event, payload });
    },
  }, { errorEvent: 'test.los-error' }), true);
  assert.deepEqual(warnings[0], {
    event: 'test.los-error',
    payload: {
      entity: 'creeper',
      entityId: 1,
      err: 'metadata unavailable',
    },
  });
});

function pointRecord(value) {
  return { x: value.x, y: value.y, z: value.z };
}
