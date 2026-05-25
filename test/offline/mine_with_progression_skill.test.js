import test from 'node:test';
import assert from 'node:assert/strict';
import mcDataLoader from 'minecraft-data';

import { run as runMineWithProgression } from '../../src/skills/mine_with_progression.js';

const registry = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    clone() { return pos(x, y, z); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function ctx(extra = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    ...extra,
  };
}

function inventoryItems(counts) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count], slot) => ({
      name,
      count,
      slot,
      type: registry.itemsByName[name]?.id || 9999,
    }));
}

function makeHarness(initialInventory = {}, opts = {}) {
  const inventory = { ...initialInventory };
  const records = [];
  const preemptOnce = new Set(opts.preemptOnce || []);
  const preempted = new Set();
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0), isInWater: false, equipment: [] },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry,
    inventory: {
      items: () => inventoryItems(inventory),
    },
    pathfinderOwner: {
      currentOwner: () => null,
      isIdle: () => true,
    },
  };

  const skillRunners = {
    collect: async (_bot, params) => {
      records.push({ skill: 'collect', params: { ...params } });
      const drop = params.block;
      inventory[drop] = (inventory[drop] || 0) + params.count;
      return { ok: true, reason: `collected ${params.count} ${params.block}` };
    },
    mine_until: async (_bot, params) => {
      records.push({ skill: 'mine_until', params: { ...params, ores: [...params.ores] } });
      const key = `mine_until:${params.ores.join(',')}`;
      if (preemptOnce.has(key) && !preempted.has(key)) {
        preempted.add(key);
        return { preempted: true, reason: `mock preempt ${key}` };
      }
      const block = params.ores[0];
      const drop = oreDrop(block);
      const count = params.count || 1;
      inventory[drop] = (inventory[drop] || 0) + count;
      return {
        ok: true,
        reason: `mined ${count} ${block}`,
        minedTargetCount: count,
        minedCounts: { [drop]: count },
        minedBlocks: { [block]: count },
      };
    },
    mine_and_return: async (_bot, params) => {
      records.push({ skill: 'mine_and_return', params: { ...params, ores: [...params.ores] } });
      const block = params.ores[0];
      const drop = oreDrop(block);
      const count = params.count || 1;
      return {
        ok: true,
        reason: `returned with ${count} ${drop}`,
        minedTargetCount: count,
        minedCounts: { [drop]: count },
        minedBlocks: { [block]: count },
      };
    },
    smelt: async (_bot, params) => {
      records.push({ skill: 'smelt', params: { ...params } });
      inventory[params.input] = Math.max(0, (inventory[params.input] || 0) - params.count);
      inventory[params.output] = (inventory[params.output] || 0) + params.count;
      return { ok: true, reason: `smelted ${params.count} ${params.output}` };
    },
    craft: async (_bot, params) => {
      records.push({ skill: 'craft', params: { ...params } });
      inventory[params.item] = (inventory[params.item] || 0) + params.count;
      return { ok: true, reason: `crafted ${params.count} ${params.item}` };
    },
    equip: async (_bot, params) => {
      records.push({ skill: 'equip', params: { ...params } });
      assert.ok((inventory[params.item] || 0) > 0, `expected ${params.item} in inventory before equip`);
      return { ok: true, reason: `equipped ${params.item}` };
    },
  };

  return { bot, inventory, records, skillRunners };
}

test('mine_with_progression mines prerequisites, smelts, crafts, equips, then resumes diamond mining', async () => {
  const harness = makeHarness({ stone_pickaxe: 1, cooked_beef: 32 });
  const furnace = { x: 4, y: 64, z: 0 };

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
    maxDistance: 48,
    prepMaxAttempts: 12,
    furnace,
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.records.map((entry) => callKey(entry)), [
    'mine_until:iron_ore:3',
    'mine_until:coal_ore:1',
    'collect:oak_log:1',
    'smelt:raw_iron->iron_ingot:3',
    'craft:iron_pickaxe:1',
    'equip:iron_pickaxe:hand',
    'mine_until:diamond_ore:1',
  ]);
  assert.deepEqual(result.preparation.plannedCalls.map((entry) => entry.skill), [
    'mine_until',
    'mine_until',
    'collect',
    'smelt',
    'craft',
    'equip',
  ]);
  assert.equal(result.preparation.completed, 6);
  assert.equal(harness.records[3].params.furnace, furnace);
});

test('mine_with_progression resumes the current prep step without rerunning completed steps', async () => {
  const harness = makeHarness(
    { stone_pickaxe: 1 },
    { preemptOnce: ['mine_until:coal_ore'] },
  );
  const callState = {};

  const first = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
  }, ctx({ callState, skillRunners: harness.skillRunners }));

  assert.equal(first.preempted, true);
  assert.equal(callState.prepStepIndex, 1);
  assert.deepEqual(harness.records.map((entry) => callKey(entry)), [
    'mine_until:iron_ore:3',
    'mine_until:coal_ore:1',
  ]);

  const second = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
  }, ctx({ callState, skillRunners: harness.skillRunners }));

  assert.equal(second.ok, true);
  assert.deepEqual(harness.records.map((entry) => callKey(entry)), [
    'mine_until:iron_ore:3',
    'mine_until:coal_ore:1',
    'mine_until:coal_ore:1',
    'collect:oak_log:1',
    'smelt:raw_iron->iron_ingot:3',
    'craft:iron_pickaxe:1',
    'equip:iron_pickaxe:hand',
    'mine_until:diamond_ore:1',
  ]);
});

test('mine_with_progression uses mine_and_return for the final leg when returnChest is provided', async () => {
  const harness = makeHarness({ iron_pickaxe: 1 });

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
    returnChest: { x: 3, y: 64, z: 0 },
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.records.map((entry) => callKey(entry)), [
    'mine_and_return:diamond_ore:1',
  ]);
  assert.equal(harness.records[0].params.returnChest.x, 3);
  assert.equal(result.preparation.total, 0);
});

test('mine_with_progression includes optional iron sword only when surplus resources are ready', async () => {
  const harness = makeHarness({ stone_pickaxe: 1, raw_iron: 5, coal: 1, oak_log: 1 });

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.records.map((entry) => callKey(entry)), [
    'smelt:raw_iron->iron_ingot:5',
    'craft:iron_pickaxe:1',
    'equip:iron_pickaxe:hand',
    'craft:iron_sword:1',
    'mine_until:diamond_ore:1',
  ]);
});

test('mine_with_progression reports unknown ores before planning', async () => {
  const harness = makeHarness({ stone_pickaxe: 1 });

  const result = await runMineWithProgression(harness.bot, {
    ores: ['not_an_ore'],
    count: 1,
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown ore block "not_an_ore"');
  assert.deepEqual(harness.records, []);
});

function oreDrop(block) {
  return {
    coal_ore: 'coal',
    deepslate_coal_ore: 'coal',
    iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron',
    gold_ore: 'raw_gold',
    deepslate_gold_ore: 'raw_gold',
    diamond_ore: 'diamond',
    deepslate_diamond_ore: 'diamond',
  }[block] || block;
}

function callKey(entry) {
  if (entry.skill === 'mine_until' || entry.skill === 'mine_and_return') {
    return `${entry.skill}:${entry.params.ores.join(',')}:${entry.params.count || entry.params.durationMs}`;
  }
  if (entry.skill === 'collect') return `collect:${entry.params.block}:${entry.params.count}`;
  if (entry.skill === 'smelt') return `smelt:${entry.params.input}->${entry.params.output}:${entry.params.count}`;
  if (entry.skill === 'craft') return `craft:${entry.params.item}:${entry.params.count}`;
  if (entry.skill === 'equip') return `equip:${entry.params.item}:${entry.params.destination}`;
  return entry.skill;
}
