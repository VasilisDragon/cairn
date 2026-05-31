import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSelfDugHole, recoverToSurface } from '../../src/runtime/recover_to_surface.js';

test('detectSelfDugHole detects bot below nearby standable surface', () => {
  const bot = makeHoleBot({ dirt: 4 });

  const result = detectSelfDugHole(bot);

  assert.equal(result.ok, true);
  assert.equal(result.inHole, true);
  assert.equal(result.currentY, 64);
  assert.equal(result.targetY, 68);
  assert.equal(result.depth, 4);
});

test('detectSelfDugHole ignores leaf canopy as a recovery surface', () => {
  const bot = makeLeafCanopyBot();

  const result = detectSelfDugHole(bot);

  assert.equal(result.ok, true);
  assert.equal(result.inHole, false);
  assert.equal(result.reason, 'no nearby standable surface samples');
});

test('recoverToSurface pillars up with available dirt until surface height', async () => {
  const bot = makeHoleBot({ dirt: 4 });

  const result = await recoverToSurface(bot, { signal: new AbortController().signal }, {
    prePlaceJumpMs: 1,
    stepSettleMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'pillar_up');
  assert.equal(result.steps, 4);
  assert.equal(bot.entity.position.y, 68);
  assert.deepEqual(bot.equipCalls, ['dirt']);
  assert.equal(bot.placeCalls.length, 4);
  assert.deepEqual(bot.controlCalls, [
    ['jump', true],
    ['jump', false],
    ['jump', true],
    ['jump', false],
    ['jump', true],
    ['jump', false],
    ['jump', true],
    ['jump', false],
  ]);
});

test('recoverToSurface reports missing pillar blocks without placing', async () => {
  const bot = makeHoleBot({});

  const result = await recoverToSurface(bot, { signal: new AbortController().signal });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no pillar block available/);
  assert.equal(bot.placeCalls.length, 0);
});

test('recoverToSurface is a no-op when the bot is not deep enough', async () => {
  const bot = makeHoleBot({ dirt: 4, y: 66 });

  const result = await recoverToSurface(bot, { signal: new AbortController().signal });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'none');
  assert.equal(bot.placeCalls.length, 0);
});

test('recoverToSurface waits for the bot to settle before pillaring', async () => {
  const bot = makeHoleBot({ dirt: 4 });
  bot.entity.onGround = false;
  let groundChecks = 0;
  Object.defineProperty(bot.entity, 'onGround', {
    get() {
      groundChecks += 1;
      return groundChecks >= 3;
    },
    configurable: true,
  });

  const result = await recoverToSurface(bot, { signal: new AbortController().signal }, {
    prePlaceJumpMs: 1,
    stepSettleMs: 1,
    groundSettlePollMs: 1,
  });

  assert.equal(result.ok, true);
  assert.ok(groundChecks >= 3);
  assert.equal(bot.placeCalls.length, 4);
});

function makeHoleBot(inventoryCounts = {}) {
  const y = inventoryCounts.y ?? 64;
  const world = new Map();
  const bot = {
    entity: { position: { x: 0.5, y, z: 0.5 } },
    heldItem: null,
    equipCalls: [],
    placeCalls: [],
    controlCalls: [],
    inventory: {
      items: () => Object.entries(inventoryCounts)
        .filter(([name, count]) => name !== 'y' && count > 0)
        .map(([name, count], index) => ({ name, count, slot: index })),
    },
    async equip(item) {
      bot.equipCalls.push(item.name);
      bot.heldItem = item;
    },
    setControlState(control, value) {
      bot.controlCalls.push([control, value]);
    },
    blockAt(position) {
      assert.equal(typeof position.floored, 'function');
      const key = posKey(position);
      if (world.has(key)) return world.get(key);
      if (isSurfaceFloor(position)) return block('stone', position);
      if (isHoleFloor(position)) return block('stone', position);
      return block('air', position, 'empty');
    },
    async placeBlock(referenceBlock) {
      bot.placeCalls.push(posKey(referenceBlock.position));
      const placed = {
        x: referenceBlock.position.x,
        y: referenceBlock.position.y + 1,
        z: referenceBlock.position.z,
      };
      world.set(posKey(placed), block(bot.heldItem?.name || 'dirt', placed));
      bot.entity.position.y += 1;
    },
  };
  return bot;
}

function makeLeafCanopyBot() {
  return {
    entity: { position: { x: 0.5, y: 70, z: 0.5 } },
    blockAt(position) {
      assert.equal(typeof position.floored, 'function');
      if (Math.abs(position.x) + Math.abs(position.z) === 1 && position.y === 74) {
        return block('oak_leaves', position);
      }
      return block('air', position, 'empty');
    },
  };
}

function isSurfaceFloor(position) {
  return Math.abs(position.x) + Math.abs(position.z) === 1 && position.y === 67;
}

function isHoleFloor(position) {
  return position.x === 0 && position.z === 0 && position.y < 64;
}

function block(name, position, boundingBox = 'block') {
  return {
    name,
    boundingBox,
    position: { x: position.x, y: position.y, z: position.z },
  };
}

function posKey(position) {
  return `${position.x},${position.y},${position.z}`;
}
