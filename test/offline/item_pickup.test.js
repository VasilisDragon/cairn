import test from 'node:test';
import assert from 'node:assert/strict';

import { nudgeTowardItemEntity } from '../../src/skills/item_pickup.js';

test('item pickup nudge uses bounded controls and releases them after completion', async () => {
  const controls = [];
  let completeChecks = 0;
  const bot = fakeBot(controls, {
    7: { id: 7, name: 'item', position: { x: 2, y: 64, z: 0 } },
  });

  const result = await nudgeTowardItemEntity(bot, () => bot.entities[7], {}, {
    maxMs: 100,
    intervalMs: 1,
    useSneak: true,
    reason: 'test.pickup',
    isComplete: () => {
      completeChecks += 1;
      return completeChecks >= 3;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(controls.some(([control, value]) => control === 'forward' && value === true), true);
  assert.equal(controls.some(([control, value]) => control === 'sneak' && value === true), true);
  assert.deepEqual(controls.slice(-4), [
    ['forward', false],
    ['sprint', false],
    ['jump', false],
    ['sneak', false],
  ]);
});

test('item pickup nudge stops and reports unsafe state', async () => {
  const controls = [];
  let unsafeChecks = 0;
  const bot = fakeBot(controls, {
    8: { id: 8, name: 'item', position: { x: 3, y: 64, z: 0 } },
  });

  const result = await nudgeTowardItemEntity(bot, () => bot.entities[8], {}, {
    maxMs: 100,
    intervalMs: 1,
    reason: 'test.unsafe',
    unsafeState: () => {
      unsafeChecks += 1;
      return unsafeChecks >= 2 ? { unsafe: true, reason: 'entered unsafe area' } : { unsafe: false };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.unsafe, true);
  assert.equal(result.reason, 'entered unsafe area');
  assert.deepEqual(controls.slice(-3), [
    ['forward', false],
    ['sprint', false],
    ['jump', false],
  ]);
});

test('item pickup nudge treats missing target entity as gone', async () => {
  const controls = [];
  const bot = fakeBot(controls, {});

  const result = await nudgeTowardItemEntity(bot, () => null, {}, {
    maxMs: 100,
    intervalMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetGone, true);
  assert.equal(result.reason, 'target item entity gone');
});

test('item pickup nudge can settle a late inventory completion before fallback', async () => {
  const controls = [];
  let complete = false;
  const bot = fakeBot(controls, {
    9: { id: 9, name: 'item', position: { x: 2, y: 64, z: 0 } },
  });
  setTimeout(() => {
    complete = true;
  }, 10);

  const result = await nudgeTowardItemEntity(bot, () => bot.entities[9], {}, {
    maxMs: 1,
    intervalMs: 1,
    settleMs: 80,
    reason: 'test.settle',
    isComplete: () => complete,
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.settled, true);
  assert.equal(result.reason, 'pickup complete after settle');
  assert.deepEqual(controls.slice(-3), [
    ['forward', false],
    ['sprint', false],
    ['jump', false],
  ]);
});

function fakeBot(controls, entities) {
  return {
    entities,
    entity: { position: { x: 0, y: 64, z: 0 } },
    async lookAt() {},
    setControlState(control, value) {
      controls.push([control, value]);
    },
  };
}
