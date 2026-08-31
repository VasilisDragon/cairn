import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

import {
  protectedPositionsForEscapeTrail,
  run as runExcavateShaft,
} from '../../src/skills/excavate_shaft.js';
import { SKILL_REGISTRY } from '../../src/skills/index.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';

function ctx(signal = new AbortController().signal, callState = {}, extra = {}) {
  return {
    ...extra,
    signal,
    callState,
    remainingQueue: [],
    currentSubtask: null,
  };
}

function key(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function block(name, position) {
  return {
    name,
    type: name === 'air' ? 0 : 1,
    position: position.clone ? position.clone() : new Vec3(position.x, position.y, position.z),
    boundingBox: name === 'air' || name === 'cave_air' || name === 'void_air' ? 'empty' : 'block',
  };
}

function makeBot(opts = {}) {
  const bot = new EventEmitter();
  const dug = [];
  const digStates = [];
  const walks = [];
  const world = new Map();
  const preemptAtDig = opts.preemptAtDig ?? null;
  let digCalls = 0;

  for (const name of opts.airBlocks || []) {
    world.set(name, 'air');
  }
  for (const [name, value] of Object.entries(opts.blocks || {})) {
    world.set(name, value);
  }

  Object.assign(bot, {
    entity: {
      position: opts.position || new Vec3(0.5, 64, 0.5),
      onGround: true,
      isInWater: false,
      velocity: { x: 0, y: 0, z: 0 },
      equipment: [],
    },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    entities: {},
    inventory: { items: () => [] },
    pathfinder: {
      movements: { safeToBreak: () => true },
      async goto(goal) {
        const target = new Vec3(goal.x, goal.y, goal.z);
        walks.push(target);
        bot.entity.position = target;
        if (opts.groundAfterWalkMs) {
          bot.entity.onGround = false;
          setTimeout(() => {
            bot.entity.onGround = true;
          }, opts.groundAfterWalkMs);
        }
      },
    },
    blockAt(position) {
      const pos = position.clone ? position : new Vec3(position.x, position.y, position.z);
      const stored = world.get(key(pos));
      return block(stored || opts.defaultBlock || 'stone', pos);
    },
    canDigBlock(target) {
      return target?.name !== 'air';
    },
    digTime() {
      return 1;
    },
    async dig(target) {
      digCalls += 1;
      if (preemptAtDig && digCalls === preemptAtDig) {
        const err = new Error('reactive preempt during test dig');
        err.name = 'PathStopped';
        throw err;
      }
      dug.push(key(target.position));
      digStates.push({
        target: key(target.position),
        botFeet: key(bot.entity.position),
        supportUnderBot: key({ x: bot.entity.position.x, y: bot.entity.position.y - 1, z: bot.entity.position.z }),
      });
      world.set(key(target.position), 'air');
      if (typeof opts.afterDig === 'function') {
        await opts.afterDig({ bot, target, digCalls, world });
      }
    },
    collectBlock: {
      async collect(target) {
        await bot.dig(target);
      },
    },
  });

  bot.records = { dug, digStates, walks, world };
  return bot;
}

test('excavate_shaft descends a three-step staircase', async () => {
  const bot = makeBot();

  const result = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.startStaging?.moved, false);
  assert.equal(result.steps, 3);
  assert.deepEqual(result.exitPosition, { x: 0, y: 61, z: -3 });
  assert.equal(Math.floor(bot.entity.position.y), 61);
  assert.deepEqual(bot.records.dug, [
    '0,65,-1',
    '0,64,-1',
    '0,63,-1',
    '0,64,-2',
    '0,63,-2',
    '0,62,-2',
    '0,63,-3',
    '0,62,-3',
    '0,61,-3',
  ]);
  assert.deepEqual(bot.records.walks.map((pos) => key(pos)), [
    '0,63,-1',
    '0,62,-2',
    '0,61,-3',
  ]);
  assert.equal(bot.records.digStates.some((entry) => entry.target === entry.supportUnderBot), false);
});

test('excavate_shaft stages away from tree clutter before starting descent', async () => {
  const bot = makeBot({
    airBlocks: ['2,64,0', '2,65,0', '2,66,0'],
    blocks: {
      '0,65,-1': 'oak_leaves',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.startStaging?.moved, true);
  assert.deepEqual(result.startStaging?.origin, { x: 0, y: 64, z: 0 });
  assert.deepEqual(result.entryPosition, { x: 2, y: 64, z: 0 });
  assert.equal(key(bot.records.walks[0]), '2,64,0');
  assert.deepEqual(bot.records.dug, [
    '2,65,-1',
    '2,64,-1',
    '2,63,-1',
  ]);
  assert.equal(bot.records.digStates.some((entry) => entry.target === entry.supportUnderBot), false);
});

test('excavate_shaft allows harmless canopy above the two-block body clearance', async () => {
  const bot = makeBot({
    blocks: {
      '0,66,0': 'oak_leaves',
      '0,66,-1': 'oak_leaves',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.startStaging?.moved, false);
  assert.deepEqual(result.entryPosition, { x: 0, y: 64, z: 0 });
  assert.equal(bot.records.dug.includes('0,66,0'), false);
  assert.equal(bot.records.dug.includes('0,66,-1'), false);
});

test('excavate_shaft can stage under canopy when feet and head are clear', async () => {
  const bot = makeBot({
    airBlocks: ['1,64,0', '1,65,0'],
    blocks: {
      '0,65,-1': 'oak_leaves',
      '1,66,0': 'oak_leaves',
      '1,66,-1': 'oak_leaves',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.startStaging?.moved, true);
  assert.deepEqual(result.entryPosition, { x: 1, y: 64, z: 0 });
  assert.equal(key(bot.records.walks[0]), '1,64,0');
  assert.equal(bot.records.dug.includes('1,66,0'), false);
  assert.equal(bot.records.dug.includes('1,66,-1'), false);
});

test('excavate_shaft stages away from workstation blocks before starting descent', async () => {
  const bot = makeBot({
    airBlocks: ['1,64,0', '1,65,0', '1,66,0'],
    blocks: {
      '0,65,-1': 'crafting_table',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.startStaging?.moved, true);
  assert.deepEqual(result.startStaging?.origin, { x: 0, y: 64, z: 0 });
  assert.deepEqual(result.entryPosition, { x: 1, y: 64, z: 0 });
  assert.equal(key(bot.records.walks[0]), '1,64,0');
  assert.equal(bot.records.dug.includes('0,65,-1'), false);
  assert.equal(bot.records.world.get('0,65,-1'), 'crafting_table');
});

test('excavate_shaft stages away from an open first staircase step', async () => {
  const bot = makeBot({
    airBlocks: ['1,64,0', '1,65,0', '1,66,0'],
    blocks: {
      '0,63,-1': 'air',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.startStaging?.moved, true);
  assert.deepEqual(result.entryPosition, { x: 1, y: 64, z: 0 });
  assert.equal(key(bot.records.walks[0]), '1,64,0');
  assert.deepEqual(bot.records.dug, [
    '1,65,-1',
    '1,64,-1',
    '1,63,-1',
  ]);
});

test('excavate_shaft fails clearly when no safe shaft start is nearby', async () => {
  const bot = makeBot({
    blocks: {
      '0,65,-1': 'oak_leaves',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_safe_shaft_start_within_radius');
  assert.match(result.reason, /^no_safe_shaft_start_within_radius:/);
  assert.deepEqual(bot.records.dug, []);
  assert.deepEqual(bot.records.walks, []);
});

test('excavate_shaft stabilizes from a leaf canopy before starting descent', async () => {
  const bot = makeBot({
    position: new Vec3(0.5, 72, 0.5),
    airBlocks: ['0,72,0', '0,73,0', '0,70,0', '0,69,0', '0,68,0', '1,68,0', '1,69,0'],
    blocks: {
      '0,71,0': 'oak_leaves',
      '0,67,0': 'grass_block',
      '1,67,0': 'grass_block',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 65,
    direction: 'north',
    maxDepth: 4,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.startStabilization?.action, 'canopy_descent');
  assert.deepEqual(result.entryPosition, { x: 1, y: 68, z: 0 });
  assert.equal(key(bot.records.walks[0]), '1,68,0');
});

test('excavate_shaft does not pillar up to unrelated nearby high terrain before shallow descent', async () => {
  const bot = makeBot({
    position: new Vec3(0.5, 66, 0.5),
    airBlocks: ['1,71,0', '1,72,0'],
    blocks: {
      '1,70,0': 'grass_block',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 65,
    direction: 'north',
    maxDepth: 2,
  }, ctx());

  assert.equal(result.ok, true);
  assert.notEqual(result.startStabilization?.action, 'pillar_up');
  assert.deepEqual(result.entryPosition, { x: 0, y: 66, z: 0 });
  assert.deepEqual(result.exitPosition, { x: 0, y: 65, z: -1 });
});

test('excavate_shaft stops early when requested ore is exposed adjacent to the shaft', async () => {
  const bot = makeBot({
    blocks: {
      '1,63,-1': 'iron_ore',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
    stopOnExposedBlock: ['iron_ore'],
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.stoppedOnExposedBlock, true);
  assert.equal(result.reason, 'exposed target block iron_ore at (1,63,-1)');
  assert.deepEqual(result.exposedBlock, {
    name: 'iron_ore',
    position: { x: 1, y: 63, z: -1 },
  });
  assert.deepEqual(result.exitPosition, { x: 0, y: 63, z: -1 });
  assert.deepEqual(result.escapeTrail, [
    { x: 0, y: 64, z: 0 },
    { x: 0, y: 63, z: -1 },
  ]);
  assert.deepEqual(bot.records.dug, [
    '0,65,-1',
    '0,64,-1',
    '0,63,-1',
  ]);
});

test('excavate_shaft proceeds normally when stopOnExposedBlock targets are absent', async () => {
  const bot = makeBot();

  const result = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
    stopOnExposedBlock: ['iron_ore'],
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.stoppedOnExposedBlock, undefined);
  assert.equal(result.steps, 3);
  assert.deepEqual(result.exitPosition, { x: 0, y: 61, z: -3 });
});

test('excavate_shaft keeps current behavior when stopOnExposedBlock is undefined', async () => {
  const bot = makeBot({
    blocks: {
      '1,63,-1': 'iron_ore',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.stoppedOnExposedBlock, undefined);
  assert.equal(result.steps, 3);
  assert.deepEqual(result.exitPosition, { x: 0, y: 61, z: -3 });
});

test('excavate_shaft stops on any target from a multi-block exposed list', async () => {
  const bot = makeBot({
    blocks: {
      '-1,63,-1': 'coal_ore',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
    stopOnExposedBlock: ['iron_ore', 'deepslate_iron_ore', 'coal_ore'],
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.stoppedOnExposedBlock, true);
  assert.deepEqual(result.exposedBlock, {
    name: 'coal_ore',
    position: { x: -1, y: 63, z: -1 },
  });
  assert.deepEqual(result.exitPosition, { x: 0, y: 63, z: -1 });
});

test('excavate_shaft resumes mid-descent without re-mining cleared steps', async () => {
  const controller = new AbortController();
  const state = {};
  const bot = makeBot({ preemptAtDig: 4 });

  const first = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
  }, ctx(controller.signal, state));

  assert.equal(first.preempted, true);
  assert.equal(state.steps, 1);
  assert.equal(state.phase, 'digHead');
  assert.deepEqual(bot.records.dug, [
    '0,65,-1',
    '0,64,-1',
    '0,63,-1',
  ]);

  bot.records.dug.length = 0;
  const second = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
  }, ctx(new AbortController().signal, state));

  assert.equal(second.ok, true);
  assert.equal(second.steps, 3);
  assert.deepEqual(bot.records.dug, [
    '0,64,-2',
    '0,63,-2',
    '0,62,-2',
    '0,63,-3',
    '0,62,-3',
    '0,61,-3',
  ]);
});

test('excavate_shaft resets stale state and starts at the current underground position', async () => {
  const state = {
    initialized: true,
    entryPosition: { x: 0, y: 64, z: 0 },
    escapeTrail: [
      { x: 0, y: 64, z: 0 },
      { x: 0, y: 63, z: -1 },
    ],
    steps: 1,
    phase: 'digHead',
    direction: { dx: 0, dz: -1 },
    targetY: 63,
    maxDepth: 2,
    hazardScanDepth: 1,
    currentStep: {
      start: { x: 0, y: 64, z: 0 },
      head: { x: 0, y: 65, z: -1 },
      feet: { x: 0, y: 64, z: -1 },
      forward: { x: 0.5, y: 64, z: -0.5 },
      down: { x: 0, y: 63, z: -1 },
      descend: { x: 0.5, y: 63, z: -0.5 },
    },
  };
  const bot = makeBot({ position: new Vec3(10.5, 40, 10.5) });

  const result = await runExcavateShaft(bot, {
    targetY: 39,
    direction: 'north',
    maxDepth: 2,
    hazardScanDepth: 1,
  }, ctx(new AbortController().signal, state));

  assert.equal(result.ok, true);
  assert.equal(result.steps, 1);
  assert.deepEqual(result.entryPosition, { x: 10, y: 40, z: 10 });
  assert.deepEqual(result.exitPosition, { x: 10, y: 39, z: 9 });
  assert.deepEqual(state.escapeTrail, [
    { x: 10, y: 40, z: 10 },
    { x: 10, y: 39, z: 9 },
  ]);
  assert.deepEqual(bot.records.dug, [
    '10,41,9',
    '10,40,9',
    '10,39,9',
  ]);
  assert.equal(bot.records.dug.some((target) => target.startsWith('0,')), false);
});

test('excavate_shaft refuses lava within the forward hazard scan', async () => {
  const bot = makeBot({
    blocks: {
      '0,64,-2': 'lava',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
    hazardScanDepth: 2,
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.hazardClass, 'lava');
  assert.match(result.reason, /hazard ahead: lava at \(0,64,-2\)/);
  assert.deepEqual(bot.records.dug, []);
});

test('excavate_shaft refuses water at the next foot block', async () => {
  const bot = makeBot({
    blocks: {
      '0,64,-1': 'water',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
    hazardScanDepth: 1,
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.hazardClass, 'water');
  assert.match(result.reason, /hazard ahead: water at \(0,64,-1\)/);
  assert.deepEqual(bot.records.dug, []);
});

test('excavate_shaft refuses open cave air below the planned step', async () => {
  const bot = makeBot({
    blocks: {
      '0,63,-1': 'cave_air',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
    hazardScanDepth: 1,
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_safe_shaft_start_within_radius');
  assert.equal(result.shaftStartStaging?.originalInspection?.hazardClass, 'void_air');
  assert.match(result.shaftStartStaging?.originalInspection?.reason, /hazard ahead: cave_air at \(0,63,-1\)/);
  assert.deepEqual(bot.records.dug, []);
});

test('excavate_shaft permits normal surface air above a solid first step', async () => {
  const bot = makeBot({
    blocks: {
      '0,65,-1': 'air',
      '0,64,-1': 'air',
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
    hazardScanDepth: 1,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.steps, 1);
  assert.deepEqual(result.exitPosition, { x: 0, y: 63, z: -1 });
  assert.deepEqual(bot.records.dug, ['0,63,-1']);
  assert.deepEqual(bot.records.walks.map((pos) => key(pos)), [
    '0,63,-1',
  ]);
});

test('excavate_shaft waits for grounded footing after pathfinder movement before digging down', async () => {
  const bot = makeBot({ groundAfterWalkMs: 180 });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
    hazardScanDepth: 1,
  }, ctx());

  assert.equal(result.ok, true);
  assert.deepEqual(result.exitPosition, { x: 0, y: 63, z: -1 });
  assert.deepEqual(bot.records.dug, [
    '0,65,-1',
    '0,64,-1',
    '0,63,-1',
  ]);
});

test('excavate_shaft performs zero writes when the first exact dig target is protected', async () => {
  const target = { x: 0, y: 65, z: -1 };
  const model = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  model.doNotTouchRegions.push({
    id: 'protected-head',
    bbox: { min: [target.x, target.y, target.z], max: [target.x, target.y, target.z] },
    reason: 'test protection',
    confidence: 1,
  });
  const bot = makeBot();

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx(undefined, {}, { worldModel: model }));

  assert.equal(result.ok, false);
  assert.match(result.reason, /shaft head dig denied.*protected-head/);
  assert.deepEqual(bot.records.dug, []);
});

test('excavate_shaft rechecks each exact dig target after policy mutation between phases', async () => {
  const protectedFeet = { x: 0, y: 64, z: -1 };
  const model = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  const bot = makeBot({
    afterDig({ digCalls }) {
      if (digCalls !== 1) return;
      model.doNotTouchRegions.push({
        id: 'protected-feet-after-head',
        bbox: {
          min: [protectedFeet.x, protectedFeet.y, protectedFeet.z],
          max: [protectedFeet.x, protectedFeet.y, protectedFeet.z],
        },
        reason: 'test phase mutation',
        confidence: 1,
      });
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx(undefined, {}, { worldModel: model }));

  assert.equal(result.ok, false);
  assert.match(result.reason, /shaft feet dig denied.*protected-feet-after-head/);
  assert.deepEqual(bot.records.dug, ['0,65,-1']);
});

test('excavate_shaft denies a protected step-down target after head and feet are cleared', async () => {
  const protectedDown = { x: 0, y: 63, z: -1 };
  const model = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  const bot = makeBot({
    afterDig({ digCalls }) {
      if (digCalls !== 2) return;
      model.doNotTouchRegions.push({
        id: 'protected-step-down',
        bbox: {
          min: [protectedDown.x, protectedDown.y, protectedDown.z],
          max: [protectedDown.x, protectedDown.y, protectedDown.z],
        },
        reason: 'test step-down protection',
        confidence: 1,
      });
    },
  });

  const result = await runExcavateShaft(bot, {
    targetY: 63,
    direction: 'north',
    maxDepth: 2,
  }, ctx(undefined, {}, { worldModel: model }));

  assert.equal(result.ok, false);
  assert.match(result.reason, /shaft step-down dig denied.*protected-step-down/);
  assert.deepEqual(bot.records.dug, ['0,65,-1', '0,64,-1']);
});

test('excavate_shaft returns to the recorded entry without additional digging', async () => {
  const state = {};
  const bot = makeBot();

  const descent = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    maxDepth: 4,
  }, ctx(new AbortController().signal, state));

  assert.equal(descent.ok, true);
  assert.deepEqual(state.escapeTrail, [
    { x: 0, y: 64, z: 0 },
    { x: 0, y: 63, z: -1 },
    { x: 0, y: 62, z: -2 },
    { x: 0, y: 61, z: -3 },
  ]);

  bot.records.dug.length = 0;
  bot.records.walks.length = 0;
  const returned = await runExcavateShaft(bot, {
    targetY: 61,
    direction: 'north',
    returnToSurface: true,
  }, ctx(new AbortController().signal, state));

  assert.equal(returned.ok, true);
  assert.equal(returned.returnSteps, 3);
  assert.deepEqual(returned.exitPosition, { x: 0, y: 64, z: 0 });
  assert.deepEqual(bot.records.dug, []);
  assert.deepEqual(bot.records.walks.map((pos) => key(pos)), [
    '0,62,-2',
    '0,63,-1',
    '0,64,0',
  ]);
});

test('excavate_shaft publishes escape trail protection to runtime context after successful descent', async () => {
  const state = {};
  const runtimeContext = {};
  const bot = makeBot();

  const result = await runExcavateShaft(bot, {
    targetY: 62,
    direction: 'north',
    maxDepth: 4,
  }, ctx(new AbortController().signal, state, { runtimeContext }));

  assert.equal(result.ok, true);
  assert.equal(runtimeContext.collectProtectedPositions instanceof Set, true);
  assert.equal(runtimeContext.collectProtectedPositions.has('0,64,0'), true);
  assert.equal(runtimeContext.collectProtectedPositions.has('0,63,0'), true);
  assert.equal(runtimeContext.collectProtectedPositions.has('0,63,-1'), true);
  assert.equal(runtimeContext.collectProtectedPositions.has('0,62,-1'), true);
  assert.equal(runtimeContext.collectProtectedPositions.has('0,62,-2'), true);
  assert.equal(runtimeContext.collectProtectedPositions.has('0,61,-2'), true);
});

test('excavate_shaft clears runtime collect protection after returning to surface', async () => {
  const state = {};
  const runtimeContext = {};
  const bot = makeBot();

  const descent = await runExcavateShaft(bot, {
    targetY: 62,
    direction: 'north',
    maxDepth: 4,
  }, ctx(new AbortController().signal, state, { runtimeContext }));

  assert.equal(descent.ok, true);
  assert.equal(runtimeContext.collectProtectedPositions instanceof Set, true);

  const returned = await runExcavateShaft(bot, {
    targetY: 62,
    direction: 'north',
    returnToSurface: true,
  }, ctx(new AbortController().signal, state, { runtimeContext }));

  assert.equal(returned.ok, true);
  assert.equal(Object.hasOwn(runtimeContext, 'collectProtectedPositions'), false);
});

test('protectedPositionsForEscapeTrail protects trail feet and support blocks', () => {
  const protectedPositions = protectedPositionsForEscapeTrail([
    { x: 201.9, y: 67.1, z: 476.8 },
    { x: 201, y: 66, z: 475 },
    { x: 'bad', y: 1, z: 2 },
  ]);

  assert.deepEqual([...protectedPositions].sort(), [
    '201,65,475',
    '201,66,475',
    '201,66,476',
    '201,67,476',
  ]);
});

test('excavate_shaft returns from a partial descent using only recorded safe steps', async () => {
  const state = {};
  const bot = makeBot({
    blocks: {
      '0,59,-6': 'water',
    },
  });

  const descent = await runExcavateShaft(bot, {
    targetY: 57,
    direction: 'north',
    maxDepth: 10,
    hazardScanDepth: 1,
  }, ctx(new AbortController().signal, state));

  assert.equal(descent.ok, false);
  assert.equal(descent.hazardClass, 'water');
  assert.equal(state.steps, 5);
  assert.equal(state.escapeTrail.length, 6);
  assert.deepEqual(state.escapeTrail.at(-1), { x: 0, y: 59, z: -5 });

  bot.records.dug.length = 0;
  bot.records.walks.length = 0;
  const returned = await runExcavateShaft(bot, {
    targetY: 57,
    direction: 'north',
    returnToSurface: true,
  }, ctx(new AbortController().signal, state));

  assert.equal(returned.ok, true);
  assert.equal(returned.returnSteps, 5);
  assert.deepEqual(returned.exitPosition, { x: 0, y: 64, z: 0 });
  assert.deepEqual(bot.records.dug, []);
  assert.deepEqual(bot.records.walks.map((pos) => key(pos)), [
    '0,60,-4',
    '0,61,-3',
    '0,62,-2',
    '0,63,-1',
    '0,64,0',
  ]);
});

test('skill registry exposes excavate_shaft for deterministic runtime use', () => {
  assert.equal(SKILL_REGISTRY.excavate_shaft, runExcavateShaft);
});
