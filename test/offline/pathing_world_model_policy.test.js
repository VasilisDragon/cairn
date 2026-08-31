import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { run as runCollect } from '../../src/skills/collect.js';
import { run as runCraft } from '../../src/skills/craft.js';
import { run as runDeposit } from '../../src/skills/deposit.js';
import { run as runFlee } from '../../src/skills/flee.js';
import { run as runGoto } from '../../src/skills/goto.js';
import { applyHazardMovementPolicy, applyWaterAvoidanceMovementPolicy, applyWorldModelMovementPolicy, posKey } from '../../src/skills/_pathing.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';
import { createWorldActionAuthorization } from '../../src/state/world_action_authorization.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    clone() { return pos(x, y, z); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function modelWithProtectedBox(min = [0, 63, 0], max = [2, 66, 2]) {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min, max },
    reason: 'likely_player_made',
    confidence: 0.91,
  });
  return model;
}

function ctx(worldModel = modelWithProtectedBox()) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldModel,
    worldIdentity: 'pathing-policy-test-world',
    worldActionAuthorization: createWorldActionAuthorization({
      worldIdentity: 'pathing-policy-test-world',
      operatorAnchors: [
        {
          kind: 'storage',
          blockName: 'chest',
          position: { x: 8, y: 64, z: 0 },
          dimension: 'overworld',
          worldIdentity: 'pathing-policy-test-world',
        },
        {
          kind: 'workstation',
          blockName: 'crafting_table',
          position: { x: 8, y: 64, z: 0 },
          dimension: 'overworld',
          worldIdentity: 'pathing-policy-test-world',
        },
      ],
    }),
  };
}

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  let capturedMovements = null;
  const blockAt = overrides.blockAt || ((p) => ({ name: 'stone', position: p }));

  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    worldIdentity: 'pathing-policy-test-world',
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    registry: TEST_REGISTRY,
    blockAt,
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'pathing-policy-test' }, release() {} }),
      setGoal: (_token, _goal, opts = {}) => {
        capturedMovements = opts.movements;
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
    },
    ...overrides,
  });

  Object.defineProperty(bot, 'capturedMovements', {
    get() { return capturedMovements; },
  });
  return bot;
}

function makeLogger() {
  const records = [];
  return {
    logger: {
      warn(evt, fields = {}) { records.push({ evt, ...fields }); },
    },
    records,
  };
}

function assertMovementsAvoidProtected(movements) {
  for (const field of ['exclusionAreasStep', 'exclusionAreasBreak', 'exclusionAreasPlace']) {
    assert.equal(Array.isArray(movements[field]), true, `${field} should be an array`);
    assert.equal(movements[field].length > 0, true, `${field} should include a world-model exclusion`);
    const exclusion = movements[field].at(-1);
    assert.equal(exclusion({ position: pos(0, 64, 0) }), 100);
    assert.equal(exclusion({ position: pos(8, 64, 0) }), 0);
    assert.equal(exclusion({}), 0);
  }
}

function assertMovementsAvoidHazards(movements) {
  for (const field of ['exclusionAreasStep', 'exclusionAreasBreak', 'exclusionAreasPlace']) {
    assert.equal(Array.isArray(movements[field]), true, `${field} should be an array`);
    assert.equal(
      movements[field].some((exclusion) => exclusion({ name: 'lava', position: pos(8, 64, 0) }) === 100),
      true,
      `${field} should include a direct hazard exclusion`,
    );
  }
}

function assertMovementsAvoidWater(movements) {
  assert.equal(movements.liquidCost >= 100, true);
  assert.equal(movements.blocksToAvoid.has(TEST_REGISTRY.blocksByName.water.id), true);
  for (const field of ['exclusionAreasStep', 'exclusionAreasBreak', 'exclusionAreasPlace']) {
    assert.equal(Array.isArray(movements[field]), true, `${field} should be an array`);
    assert.equal(
      movements[field].some((exclusion) => exclusion({ name: 'water', position: pos(8, 64, 0) }) === 100),
      true,
      `${field} should include a direct water exclusion`,
    );
    assert.equal(
      movements[field].some((exclusion) => exclusion({ name: 'air', isWaterlogged: true, position: pos(8, 64, 0) }) === 100),
      true,
      `${field} should include a waterlogged exclusion`,
    );
  }
}

test('hazard movement policy installs direct and adjacent physical hazard exclusions', () => {
  const movements = {
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
  const hazardPos = pos(9, 64, 0);
  const bot = makeBot({
    blockAt: (p) => (posKey(p) === posKey(hazardPos)
      ? { name: 'lava', position: hazardPos }
      : { name: 'stone', position: p }),
  });

  const result = applyHazardMovementPolicy(movements, bot);
  const reapplied = applyHazardMovementPolicy(movements, bot);

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(reapplied.ok, true);
  assert.equal(movements.exclusionAreasStep.length, 1);
  assert.equal(movements.exclusionAreasBreak.length, 1);
  assert.equal(movements.exclusionAreasPlace.length, 1);
  for (const field of ['exclusionAreasStep', 'exclusionAreasBreak', 'exclusionAreasPlace']) {
    const exclusion = movements[field][0];
    assert.equal(exclusion({ name: 'lava', position: pos(8, 64, 0) }), 100);
    assert.equal(exclusion({ name: 'air', position: pos(8, 64, 0) }), 100);
    assert.equal(exclusion({ name: 'air', position: pos(12, 64, 0) }), 0);
  }
});

test('hazard movement policy treats unreadable adjacent blocks as unsafe', () => {
  const movements = {
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
  const { logger, records } = makeLogger();
  const bot = makeBot({
    blockAt: () => {
      throw new Error('adjacent cache unavailable');
    },
  });

  applyHazardMovementPolicy(movements, bot, { logger });

  for (const field of ['exclusionAreasStep', 'exclusionAreasBreak', 'exclusionAreasPlace']) {
    const exclusion = movements[field][0];
    assert.equal(exclusion({ name: 'air', position: pos(8, 64, 0) }), 100);
  }
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    evt: 'movement.hazard-read-error',
    err: 'adjacent cache unavailable',
    position: { x: 8, y: 64, z: 0 },
    offset: { x: 1, y: -1, z: 0 },
  });
});

test('water avoidance movement policy installs water exclusions without duplicating', () => {
  const movements = {
    liquidCost: 1,
    blocksToAvoid: new Set(),
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
  const bot = makeBot();

  const result = applyWaterAvoidanceMovementPolicy(movements, bot);
  const reapplied = applyWaterAvoidanceMovementPolicy(movements, bot);

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(reapplied.ok, true);
  assert.equal(movements.exclusionAreasStep.length, 1);
  assert.equal(movements.exclusionAreasBreak.length, 1);
  assert.equal(movements.exclusionAreasPlace.length, 1);
  assertMovementsAvoidWater(movements);
});

test('world-model movement policy installs step break and place exclusions', () => {
  const movements = {
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };

  const result = applyWorldModelMovementPolicy(movements, ctx());
  const reapplied = applyWorldModelMovementPolicy(movements, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(reapplied.ok, true);
  assert.equal(movements.exclusionAreasStep.length, 1);
  assert.equal(movements.exclusionAreasBreak.length, 1);
  assert.equal(movements.exclusionAreasPlace.length, 1);
  assertMovementsAvoidProtected(movements);
});

test('goto xyz installs do-not-touch movement exclusions', async () => {
  const bot = makeBot();

  const result = await runGoto(bot, { x: 10, y: 64, z: 0 }, ctx());

  assert.equal(result.ok, true);
  assertMovementsAvoidHazards(bot.capturedMovements);
  assertMovementsAvoidProtected(bot.capturedMovements);
});

test('deposit installs do-not-touch movement exclusions', async () => {
  const chestPos = pos(8, 64, 0);
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      deposit: async () => {},
      close() {},
    }),
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, true);
  assertMovementsAvoidHazards(bot.capturedMovements);
  assertMovementsAvoidWater(bot.capturedMovements);
  assertMovementsAvoidProtected(bot.capturedMovements);
});

test('craft installs do-not-touch movement exclusions when walking to a table', async () => {
  const tablePos = pos(8, 64, 0);
  const recipe = { id: 'oak_planks_recipe' };
  const bot = makeBot({
    recipesFor: (_itemId, _metadata, _min, table) => (table ? [recipe] : []),
    findBlock: () => ({ name: 'crafting_table', position: tablePos }),
    blockAt: () => ({ name: 'crafting_table', position: tablePos }),
    craft: async () => {},
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, true);
  assertMovementsAvoidHazards(bot.capturedMovements);
  assertMovementsAvoidProtected(bot.capturedMovements);
});

test('flee installs do-not-touch movement exclusions', async () => {
  const bot = makeBot();

  const result = await runFlee(bot, { from: { x: -10, y: 64, z: 0 }, distance: 16 }, ctx());

  assert.equal(result.ok, true);
  assertMovementsAvoidHazards(bot.capturedMovements);
  assertMovementsAvoidProtected(bot.capturedMovements);
});

test('collectBlock receives do-not-touch movement exclusions', async () => {
  const inventory = { oak_log: 0 };
  const target = pos(8, 64, 0);
  const blocks = new Map([[posKey(target), target]]);
  const movements = {
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
  const bot = makeBot({
    inventory: {
      items: () => (inventory.oak_log > 0 ? [{ name: 'oak_log', count: inventory.oak_log }] : []),
    },
    findBlocks: () => [...blocks.values()],
    blockAt: (p) => {
      const found = blocks.get(posKey(p));
      return found ? { name: 'oak_log', position: found } : null;
    },
    collectBlock: {
      movements,
      collect: async (block) => {
        blocks.delete(posKey(block.position));
        inventory.oak_log += 1;
      },
    },
    stopDigging() {},
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1 }, ctx());

  assert.equal(result.ok, true);
  assertMovementsAvoidHazards(bot.collectBlock.movements);
  assertMovementsAvoidProtected(bot.collectBlock.movements);
});
