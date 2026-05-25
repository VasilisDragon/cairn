import test from 'node:test';
import assert from 'node:assert/strict';

import { FleeGoal } from '../../src/reactive/flee_goal.js';

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    floored() {
      return pos(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    },
  };
}

test('FleeGoal.isEnd is always false', () => {
  const goal = new FleeGoal({ position: pos(0, 64, 0) });

  assert.equal(goal.isEnd({ x: 0, y: 64, z: 0 }), false);
  assert.equal(goal.isEnd({ x: 100, y: 70, z: -100 }), false);
  assert.equal(goal.isEnd(null), false);
});

test('FleeGoal.hasChanged trips after entity moves beyond threshold and consumes the change', () => {
  const entity = { position: pos(0, 64, 0) };
  const goal = new FleeGoal(entity, { hasChangedThresholdBlocks: 4 });

  entity.position = pos(4, 64, 0);
  assert.equal(goal.hasChanged(), false);

  entity.position = pos(5, 64, 0);
  assert.equal(goal.hasChanged(), true);
  assert.equal(goal.hasChanged(), false);
});

test('FleeGoal.isValid handles null, dead, and missing-position entities safely', () => {
  assert.equal(new FleeGoal(null).isValid(), false);
  assert.equal(new FleeGoal({ position: pos(0, 64, 0), isValid: false }).isValid(), false);
  assert.equal(new FleeGoal({ isValid: true }).isValid(), false);
  assert.equal(new FleeGoal({ position: pos(0, 64, 0), isValid: true }).isValid(), true);
  assert.equal(new FleeGoal({ position: pos(0, 64, 0) }).isValid(), true);
});

test('FleeGoal heuristic prefers nodes farther from the live entity', () => {
  const entity = { position: pos(0, 64, 0) };
  const goal = new FleeGoal(entity);

  const near = goal.heuristic({ x: 2, y: 64, z: 0 });
  const far = goal.heuristic({ x: 12, y: 64, z: 0 });

  assert.ok(far < near, `expected farther node to have lower heuristic: far=${far}, near=${near}`);
});

test('FleeGoal heuristic prefers nodes away from an aggregate threat field', () => {
  const left = { position: pos(-5, 64, 0) };
  const right = { position: pos(5, 64, 0) };
  const goal = new FleeGoal([left, right]);

  const throughOneThreat = goal.heuristic({ x: -10, y: 64, z: 0 });
  const awayFromBoth = goal.heuristic({ x: 0, y: 64, z: 10 });

  assert.ok(
    awayFromBoth < throughOneThreat,
    `expected aggregate field to prefer away-from-both node: away=${awayFromBoth}, through=${throughOneThreat}`,
  );
});

test('FleeGoal.hasChanged trips when any live threat moves beyond threshold', () => {
  const left = { position: pos(-5, 64, 0) };
  const right = { position: pos(5, 64, 0) };
  const goal = new FleeGoal([left, right], { hasChangedThresholdBlocks: 4 });

  left.position = pos(-10, 64, 0);

  assert.equal(goal.hasChanged(), true);
  assert.equal(goal.hasChanged(), false);
});

test('FleeGoal.isValid accepts a live threat set and rejects an empty one', () => {
  assert.equal(new FleeGoal([{ isValid: false, position: pos(0, 64, 0) }, { position: pos(5, 64, 0) }]).isValid(), true);
  assert.equal(new FleeGoal([{ isValid: false, position: pos(0, 64, 0) }, { isValid: true }]).isValid(), false);
});
