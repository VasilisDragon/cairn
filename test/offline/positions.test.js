import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { clonePositionPlain, toVec3 } from '../../src/state/positions.js';

test('toVec3 converts plain position objects into independent Vec3 instances', () => {
  const input = { x: '1', y: 64, z: 2.5 };
  const converted = toVec3(input);

  assert.ok(converted instanceof Vec3);
  assert.equal(converted.x, 1);
  assert.equal(converted.y, 64);
  assert.equal(converted.z, 2.5);
  assert.notEqual(converted, input);
});

test('toVec3 clones existing Vec3 positions without sharing references', () => {
  const original = new Vec3(3, 70, -4);
  const converted = toVec3(original);

  assert.ok(converted instanceof Vec3);
  assert.deepEqual(converted, original);
  assert.notEqual(converted, original);
});

test('toVec3 rejects invalid positions clearly', () => {
  assert.throws(() => toVec3({ x: 1, y: NaN, z: 2 }), /finite x, y, and z/);
  assert.throws(() => toVec3(null), /finite x, y, and z/);
});

test('clonePositionPlain returns JSON-safe coordinates and tolerates invalid input', () => {
  const original = new Vec3(4, 65, -8);

  assert.deepEqual(clonePositionPlain(original), { x: 4, y: 65, z: -8 });
  assert.equal(clonePositionPlain({ x: 1, y: Infinity, z: 2 }), null);
  assert.equal(clonePositionPlain(undefined), null);
});
