import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { stabilizeVerticalPosition } from '../../src/skills/_pathing.js';

test('vertical movement descends from leaf canopy to stable ground', async () => {
  const bot = makeWorldBot({
    position: new Vec3(0.5, 72, 0.5),
    floors: new Map([
      ['0,71,0', 'oak_leaves'],
      ['0,67,0', 'grass_block'],
      ['1,67,0', 'grass_block'],
    ]),
  });

  const result = await stabilizeVerticalPosition(bot, { signal: new AbortController().signal }, {
    reason: 'test.canopy',
    scanRadius: 1,
    maxScanDown: 8,
    maxSteps: 4,
    settleMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'canopy_descent');
  assert.deepEqual(result.finalPosition, { x: 1, y: 68, z: 0 });
  assert.deepEqual(bot.records.walks.map((pos) => key(pos)), ['1,68,0']);
});

test('vertical movement pillars from a self-dug hole to nearby surface height', async () => {
  const bot = makeHoleBot({ dirt: 4 });

  const result = await stabilizeVerticalPosition(bot, { signal: new AbortController().signal }, {
    reason: 'test.hole',
    maxSteps: 6,
    prePlaceJumpMs: 1,
    stepSettleMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'pillar_up');
  assert.equal(result.stepsApplied, 4);
  assert.deepEqual(result.finalPosition, { x: 0, y: 68, z: 0 });
  assert.equal(bot.records.places.length, 4);
});

test('vertical movement steps over a one-block obstacle without repeated jumping', async () => {
  const bot = makeWorldBot({
    position: new Vec3(0.5, 64, 0.5),
    floors: new Map([
      ['0,63,0', 'grass_block'],
      ['0,64,-1', 'dirt'],
      ['0,63,-2', 'grass_block'],
    ]),
  });

  const result = await stabilizeVerticalPosition(bot, { signal: new AbortController().signal }, {
    reason: 'test.step-up',
    direction: { dx: 0, dz: -1 },
    maxSteps: 4,
    settleMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'step_up');
  assert.deepEqual(result.finalPosition, { x: 0, y: 65, z: -1 });
  assert.deepEqual(bot.records.walks.map((pos) => key(pos)), ['0,65,-1']);
  assert.deepEqual(bot.records.controls, []);
});

test('vertical movement steps back from an unsafe edge', async () => {
  const bot = makeWorldBot({
    position: new Vec3(0.5, 64, 0.5),
    floors: new Map([
      ['0,63,0', 'grass_block'],
      ['0,63,1', 'grass_block'],
    ]),
  });

  const result = await stabilizeVerticalPosition(bot, { signal: new AbortController().signal }, {
    reason: 'test.edge',
    direction: { dx: 0, dz: -1 },
    maxSafeDrop: 2,
    maxSteps: 4,
    settleMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'edge_stepback');
  assert.deepEqual(result.finalPosition, { x: 0, y: 64, z: 1 });
  assert.deepEqual(bot.records.walks.map((pos) => key(pos)), ['0,64,1']);
});

function makeWorldBot(opts = {}) {
  const floors = opts.floors || new Map();
  const bot = {
    entity: {
      position: opts.position || new Vec3(0.5, 64, 0.5),
      onGround: true,
      isInWater: false,
    },
    records: {
      walks: [],
      controls: [],
      places: [],
    },
    inventory: {
      items: () => [],
    },
    blockAt(position) {
      const p = floorVec(position);
      const name = floors.get(key(p));
      if (name) return block(name, p);
      return block('air', p, 'empty');
    },
    setControlState(control, value) {
      bot.records.controls.push([control, value]);
    },
    pathfinder: {
      async goto(goal) {
        const target = new Vec3(goal.x, goal.y, goal.z);
        bot.records.walks.push(target);
        bot.entity.position = target;
      },
    },
  };
  return bot;
}

function makeHoleBot(inventoryCounts = {}) {
  const world = new Map();
  const bot = {
    entity: {
      position: new Vec3(0.5, 64, 0.5),
      onGround: true,
      isInWater: false,
    },
    heldItem: null,
    records: {
      walks: [],
      controls: [],
      places: [],
    },
    inventory: {
      items: () => Object.entries(inventoryCounts)
        .filter(([, count]) => count > 0)
        .map(([name, count], slot) => ({ name, count, slot })),
    },
    blockAt(position) {
      const p = floorVec(position);
      if (world.has(key(p))) return world.get(key(p));
      if (Math.abs(p.x) + Math.abs(p.z) === 1 && p.y === 67) return block('grass_block', p);
      if (p.x === 0 && p.z === 0 && p.y < 64) return block('stone', p);
      return block('air', p, 'empty');
    },
    async equip(item) {
      bot.heldItem = item;
    },
    async placeBlock(referenceBlock) {
      bot.records.places.push(key(referenceBlock.position));
      const placed = new Vec3(referenceBlock.position.x, referenceBlock.position.y + 1, referenceBlock.position.z);
      world.set(key(placed), block(bot.heldItem?.name || 'dirt', placed));
      bot.entity.position.y += 1;
    },
    setControlState(control, value) {
      bot.records.controls.push([control, value]);
    },
  };
  return bot;
}

function block(name, position, boundingBox = 'block') {
  return {
    name,
    boundingBox,
    position: new Vec3(position.x, position.y, position.z),
  };
}

function floorVec(position) {
  return new Vec3(
    Math.floor(Number(position.x)),
    Math.floor(Number(position.y)),
    Math.floor(Number(position.z)),
  );
}

function key(position) {
  return `${Math.floor(Number(position.x))},${Math.floor(Number(position.y))},${Math.floor(Number(position.z))}`;
}
