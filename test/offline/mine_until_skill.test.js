import test from 'node:test';
import assert from 'node:assert/strict';

import { run as runMineUntil } from '../../src/skills/mine_until.js';
import { posKey } from '../../src/skills/_pathing.js';

const BLOCK_IDS = Object.freeze({
  coal_ore: 1,
  iron_ore: 2,
  diamond_ore: 3,
  dirt: 4,
  gold_ore: 5,
});

const ITEM_IDS = Object.freeze({
  wooden_pickaxe: 101,
  stone_pickaxe: 102,
  iron_pickaxe: 103,
  diamond_pickaxe: 104,
  netherite_pickaxe: 105,
});

const HARVEST_TOOLS = Object.freeze({
  coal_ore: harvestTools(['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']),
  iron_ore: harvestTools(['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']),
  gold_ore: harvestTools(['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']),
  diamond_ore: harvestTools(['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']),
});

const DROPS = Object.freeze({
  coal_ore: 'coal',
  iron_ore: 'raw_iron',
  diamond_ore: 'diamond',
  gold_ore: 'raw_gold',
});

function harvestTools(names) {
  return Object.fromEntries(names.map((name) => [ITEM_IDS[name], true]));
}

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    clone() { return pos(x, y, z); },
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
  };
}

function ctx(overrides = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    ...overrides,
  };
}

function makeMovements() {
  return {
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
}

function makeMiningHarness(blocksInput = [], opts = {}) {
  const blocks = new Map(blocksInput.map((entry) => [
    posKey(entry.position),
    { name: entry.name, position: entry.position },
  ]));
  const inventory = { ...(opts.inventory || {}) };
  const collected = [];
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0), isInWater: false },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: {
      blocksByName: Object.fromEntries(
        Object.entries(BLOCK_IDS).map(([name, id]) => [name, {
          id,
          name,
          harvestTools: opts.toolRequirements ? (HARVEST_TOOLS[name] || {}) : {},
        }]),
      ),
      items: Object.fromEntries(
        Object.entries(ITEM_IDS).map(([name, id]) => [id, { id, name }]),
      ),
    },
    inventory: {
      items: () => Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count })),
    },
    findBlocks({ matching }) {
      const ids = new Set(Array.isArray(matching) ? matching : [matching]);
      return [...blocks.values()]
        .filter((block) => ids.has(BLOCK_IDS[block.name]))
        .map((block) => block.position);
    },
    blockAt(position) {
      const block = blocks.get(posKey(position));
      return block
        ? { name: block.name, position: block.position }
        : { name: 'air', position };
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async (target) => {
        collected.push({ name: target.name, position: posKey(target.position) });
        if (opts.collectError) throw opts.collectError;
        blocks.delete(posKey(target.position));
        const drop = DROPS[target.name] || target.name;
        inventory[drop] = (inventory[drop] || 0) + 1;
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'mine-until-test' }, release() {} }),
      stop() {},
      currentOwner: () => null,
      isIdle: () => true,
    },
  };

  return { bot, blocks, inventory, collected };
}

test('mine_until mines visible ore targets in requested priority order', async () => {
  const harness = makeMiningHarness([
    { name: 'iron_ore', position: pos(5, 64, 0) },
    { name: 'coal_ore', position: pos(3, 64, 0) },
  ]);

  const result = await runMineUntil(harness.bot, {
    count: 2,
    maxAttempts: 4,
    ores: ['coal_ore', 'iron_ore'],
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.minedTargetCount, 2);
  assert.deepEqual(result.minedCounts, { coal: 1, raw_iron: 1 });
  assert.deepEqual(result.minedBlocks, { coal_ore: 1, iron_ore: 1 });
  assert.deepEqual(harness.collected.map((entry) => entry.name), ['coal_ore', 'iron_ore']);
  assert.deepEqual(harness.inventory, { coal: 1, raw_iron: 1 });
});

test('mine_until reports no visible ore targets before claiming success', async () => {
  const harness = makeMiningHarness([]);

  const result = await runMineUntil(harness.bot, {
    count: 1,
    maxAttempts: 2,
    ores: ['coal_ore', 'iron_ore'],
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /mined 0\/1 visible ore targets before no-visible-targets/);
  assert.equal(result.minedTargetCount, 0);
  assert.deepEqual(result.minedCounts, {});
});

test('mine_until duration mode can stop cleanly after visible target exhaustion', async () => {
  const harness = makeMiningHarness([
    { name: 'diamond_ore', position: pos(2, 64, 0) },
  ]);

  const result = await runMineUntil(harness.bot, {
    durationMs: 60000,
    maxAttempts: 3,
    ores: ['diamond_ore'],
  }, ctx());

  assert.equal(result.ok, true);
  assert.match(result.reason, /before no-visible-targets/);
  assert.equal(result.minedTargetCount, 1);
  assert.deepEqual(result.minedCounts, { diamond: 1 });
  assert.deepEqual(result.minedBlocks, { diamond_ore: 1 });
});

test('mine_until skips visible ores that current tools cannot harvest and mines feasible prerequisites', async () => {
  const harness = makeMiningHarness([
    { name: 'diamond_ore', position: pos(2, 64, 0) },
    { name: 'gold_ore', position: pos(3, 64, 0) },
    { name: 'iron_ore', position: pos(4, 64, 0) },
    { name: 'coal_ore', position: pos(5, 64, 0) },
  ], {
    inventory: { stone_pickaxe: 1 },
    toolRequirements: true,
  });

  const result = await runMineUntil(harness.bot, {
    count: 2,
    maxAttempts: 4,
    ores: ['diamond_ore', 'gold_ore', 'iron_ore', 'coal_ore'],
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.minedTargetCount, 2);
  assert.deepEqual(harness.collected.map((entry) => entry.name), ['iron_ore', 'coal_ore']);
  assert.deepEqual(result.minedCounts, { coal: 1, raw_iron: 1 });
  assert.deepEqual(result.minedBlocks, { coal_ore: 1, iron_ore: 1 });
  assert.deepEqual(Object.keys(result.toolBlockedTargets), ['diamond_ore', 'gold_ore']);
  assert.deepEqual(result.toolBlockedTargets.diamond_ore.missingTools, [
    'iron_pickaxe',
    'diamond_pickaxe',
    'netherite_pickaxe',
  ]);
  assert.deepEqual(result.toolBlockedTargets.gold_ore.missingTools, [
    'iron_pickaxe',
    'diamond_pickaxe',
    'netherite_pickaxe',
  ]);
});

test('mine_until fails actionably when all visible ore targets require a better tool', async () => {
  const harness = makeMiningHarness([
    { name: 'diamond_ore', position: pos(2, 64, 0) },
    { name: 'gold_ore', position: pos(3, 64, 0) },
  ], {
    inventory: { stone_pickaxe: 1 },
    toolRequirements: true,
  });

  const result = await runMineUntil(harness.bot, {
    count: 1,
    maxAttempts: 4,
    ores: ['diamond_ore', 'gold_ore'],
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /mined 0\/1 visible ore targets before no-harvestable-visible-targets/);
  assert.equal(result.minedTargetCount, 0);
  assert.deepEqual(harness.collected, []);
  assert.deepEqual(Object.keys(result.toolBlockedTargets), ['diamond_ore', 'gold_ore']);
  assert.match(result.toolBlockedTargets.diamond_ore.reason, /iron_pickaxe/);
});

test('mine_until propagates non-exhaustion collect failures with the target block', async () => {
  const harness = makeMiningHarness([
    { name: 'coal_ore', position: pos(3, 64, 0) },
  ], {
    collectError: new Error('dig failed'),
  });

  const result = await runMineUntil(harness.bot, {
    count: 1,
    maxAttempts: 1,
    ores: ['coal_ore'],
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mine_until coal_ore failed: collectBlock error: dig failed');
  assert.equal(result.minedTargetCount, 0);
});

test('mine_until validates ore-like known block targets', async () => {
  const harness = makeMiningHarness([{ name: 'coal_ore', position: pos(3, 64, 0) }]);

  const unknown = await runMineUntil(harness.bot, {
    count: 1,
    ores: ['not_real_ore'],
  }, ctx());
  const notOre = await runMineUntil(harness.bot, {
    count: 1,
    ores: ['dirt'],
  }, ctx());

  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown ore block "not_real_ore"');
  assert.equal(notOre.ok, false);
  assert.equal(notOre.reason, 'mine_until target "dirt" is not an ore-like block');
});
