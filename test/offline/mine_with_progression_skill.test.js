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
    place_workstation: async (_bot, params, callCtx = {}) => {
      records.push({
        skill: 'place_workstation',
        params: { ...params },
        protectedPositions: callCtx.protectedPositions ? [...callCtx.protectedPositions].sort() : [],
      });
      if (params.action === 'place') {
        assert.ok((inventory[params.workstation] || 0) > 0, `expected ${params.workstation} in inventory before placement`);
        inventory[params.workstation] = Math.max(0, (inventory[params.workstation] || 0) - 1);
      } else if (params.action === 'break_and_carry') {
        inventory[params.workstation] = (inventory[params.workstation] || 0) + 1;
      }
      return { ok: true, reason: `${params.action} ${params.workstation}` };
    },
    equip: async (_bot, params) => {
      records.push({ skill: 'equip', params: { ...params } });
      assert.ok((inventory[params.item] || 0) > 0, `expected ${params.item} in inventory before equip`);
      return { ok: true, reason: `equipped ${params.item}` };
    },
    excavate_shaft: async (_bot, params, callCtx = {}) => {
      records.push({ skill: 'excavate_shaft', params: { ...params } });
      if (typeof opts.excavateShaft === 'function') {
        const override = await opts.excavateShaft({ bot, params, callCtx, inventory, records });
        if (override) return override;
      }
      if (params.returnToSurface === true) {
        bot.entity.position = pos(0, 64, 0);
        return { ok: true, reason: 'returned to surface' };
      }
      bot.entity.position = pos(bot.entity.position.x, params.targetY, bot.entity.position.z);
      return { ok: true, reason: `excavated to Y ${params.targetY}` };
    },
    goto: async (_bot, params) => {
      records.push({ skill: 'goto', params: { ...params } });
      bot.entity.position = pos(params.x, params.y, params.z);
      return { ok: true, reason: 'reached' };
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
    'goto:0,64,0:0.75',
    'smelt:raw_iron->iron_ingot:3',
    'collect:oak_log:1',
    'goto:0,64,0:0.75',
    'craft:oak_planks:2',
    'craft:crafting_table:1',
    'place_workstation:crafting_table:place',
    'craft:stick:1',
    'craft:iron_pickaxe:1',
    'equip:iron_pickaxe:hand',
    'excavate_shaft:-58',
    'mine_until:diamond_ore:1',
  ]);
  assert.deepEqual(result.preparation.plannedCalls.map((entry) => entry.skill), [
    'mine_until',
    'mine_until',
    'collect',
    'goto',
    'smelt',
    'collect',
    'goto',
    'craft',
    'craft',
    'place_workstation',
    'craft',
    'craft',
    'equip',
    'excavate_shaft',
  ]);
  assert.equal(result.preparation.completed, 14);
  assert.equal(harness.records.find((entry) => entry.skill === 'smelt').params.furnace, furnace);
});

test('mine_with_progression rotates final diamond shaft direction after an open-air hazard', async () => {
  const harness = makeHarness({ iron_pickaxe: 1 }, {
    excavateShaft: ({ params }) => {
      if (params.targetY === -58 && params.direction === 'west') {
        return {
          ok: false,
          reason: 'hazard ahead: air at (178,0,470)',
          hazardClass: 'void_air',
          hazardBlock: 'air',
          hazardPosition: { x: 178, y: 0, z: 470 },
        };
      }
      return null;
    },
  });

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
    maxDistance: 48,
    optionalCrafts: [],
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  const shaftDirections = harness.records
    .filter((entry) => entry.skill === 'excavate_shaft' && entry.params.targetY === -58)
    .map((entry) => entry.params.direction);
  assert.deepEqual(shaftDirections, ['west', 'north']);
  assert.deepEqual(result.preparation.finalDepthShaftAttempts, [{
    direction: 'west',
    reason: 'hazard ahead: air at (178,0,470)',
    hazardClass: 'void_air',
    hazardBlock: 'air',
    hazardPosition: { x: 178, y: 0, z: 470 },
  }]);
});

test('mine_with_progression rotates final diamond shaft direction after unsafe shaft-start staging', async () => {
  const harness = makeHarness({ iron_pickaxe: 1 }, {
    excavateShaft: ({ params }) => {
      if (params.targetY === -58 && params.direction === 'west') {
        return {
          ok: false,
          code: 'no_safe_shaft_start_within_radius',
          reason: 'no_safe_shaft_start_within_radius: no reachable safe staircase start within 7 blocks of 219,42,470',
          shaftStartStaging: {
            code: 'no_safe_shaft_start_within_radius',
            reason: 'no reachable safe staircase start',
            origin: { x: 219, y: 42, z: 470 },
            radius: 7,
            candidateCount: 0,
            originalInspection: { reason: 'unsafe_adjacent_drop' },
            walkFailures: [],
          },
        };
      }
      return null;
    },
  });

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
    maxDistance: 48,
    optionalCrafts: [],
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  const shaftDirections = harness.records
    .filter((entry) => entry.skill === 'excavate_shaft' && entry.params.targetY === -58)
    .map((entry) => entry.params.direction);
  assert.deepEqual(shaftDirections, ['west', 'north']);
  assert.deepEqual(result.preparation.finalDepthShaftAttempts, [{
    direction: 'west',
    reason: 'no_safe_shaft_start_within_radius: no reachable safe staircase start within 7 blocks of 219,42,470',
    code: 'no_safe_shaft_start_within_radius',
    shaftStartStaging: {
      code: 'no_safe_shaft_start_within_radius',
      reason: 'no reachable safe staircase start',
      origin: { x: 219, y: 42, z: 470 },
      radius: 7,
      candidateCount: 0,
      originalInspectionReason: 'unsafe_adjacent_drop',
      walkFailureCount: 0,
    },
  }]);
});

test('mine_with_progression bootstraps from empty inventory through portable workstations', async () => {
  const harness = makeHarness({});

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
    maxDistance: 48,
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.records.map((entry) => callKey(entry)), [
    'collect:oak_log:2',
    'collect:oak_log:2',
    'goto:0,64,0:0.75',
    'craft:oak_planks:4',
    'craft:crafting_table:1',
    'place_workstation:crafting_table:place',
    'craft:stick:1',
    'craft:wooden_pickaxe:1',
    'equip:wooden_pickaxe:hand',
    'goto:0,64,0:0.75',
    'excavate_shaft:61',
    'collect:cobblestone:11',
    'craft:stone_pickaxe:1',
    'equip:stone_pickaxe:hand',
    'mine_until:iron_ore:3',
    'mine_until:coal_ore:1',
    'craft:furnace:1',
    'place_workstation:furnace:place',
    'smelt:raw_iron->iron_ingot:3',
    'craft:stick:1',
    'craft:iron_pickaxe:1',
    'equip:iron_pickaxe:hand',
    'excavate_shaft:-58',
    'mine_until:diamond_ore:1',
  ]);
  assert.equal(harness.records.find((entry) => entry.skill === 'smelt')?.params.fuel, 'coal');
  assert.deepEqual(result.preparation.progression.requiredTools, ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']);
  assert.equal(
    harness.records
      .filter((entry) => entry.skill === 'collect' && entry.params.block === 'oak_log')
      .every((entry) => entry.params.finishTree === false && entry.params.maxTargetY === 66),
    true,
  );
  assert.equal(
    harness.records
      .filter((entry) => entry.skill === 'collect' && entry.params.block === 'cobblestone')
      .every((entry) => entry.params.allowBuriedTargets === true),
    true,
  );
  const tablePlacement = harness.records.find((entry) => (
    entry.skill === 'place_workstation'
    && entry.params.workstation === 'crafting_table'
    && entry.params.action === 'place'
  ));
  assert.deepEqual(
    pickPosition(tablePlacement.params),
    { x: -3, y: 64, z: 3 },
    'bootstrap crafting table should be placed on a reachable side pad away from the starter logs and shaft',
  );
  assert.equal(tablePlacement.params.searchRadius, 4);
  assert.equal(tablePlacement.params.verticalRadius, 2);
  assert.equal(tablePlacement.protectedPositions.includes('0,64,0'), true);
  assert.equal(tablePlacement.protectedPositions.includes('1,64,0'), true);
  assert.equal(tablePlacement.protectedPositions.includes('2,64,2'), false);
  assert.ok(harness.records.some((entry) => callKey(entry) === 'goto:0,64,0:0.75'));
  assert.equal(harness.records
    .filter((entry) => entry.skill === 'excavate_shaft')
    .every((entry) => entry.params.direction === 'west'), true);
});

test('mine_with_progression keeps explicit bootstrap wood overrides near the start elevation', async () => {
  const harness = makeHarness({});

  const result = await runMineWithProgression(harness.bot, {
    ores: ['iron_ore'],
    count: 3,
    woodBlock: 'jungle_log',
    optionalCrafts: ['iron_pickaxe'],
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  const woodCollects = harness.records.filter((entry) => entry.skill === 'collect' && entry.params.block === 'jungle_log');
  assert.ok(woodCollects.length > 0);
  assert.equal(woodCollects.every((entry) => entry.params.finishTree === false), true);
  assert.equal(woodCollects.every((entry) => entry.params.maxTargetY === 66), true);
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
    'collect:oak_log:1',
    'goto:0,64,0:0.75',
    'craft:oak_planks:2',
    'craft:crafting_table:1',
    'place_workstation:crafting_table:place',
    'goto:0,64,0:0.75',
    'excavate_shaft:61',
    'collect:cobblestone:8',
    'craft:furnace:1',
    'place_workstation:furnace:place',
    'smelt:raw_iron->iron_ingot:3',
    'craft:stick:1',
    'craft:iron_pickaxe:1',
    'equip:iron_pickaxe:hand',
    'excavate_shaft:-58',
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
    'excavate_shaft:-58',
    'mine_and_return:diamond_ore:1',
  ]);
  const finalMine = harness.records.find((entry) => entry.skill === 'mine_and_return');
  assert.equal(finalMine.params.returnChest.x, 3);
  assert.equal(result.preparation.total, 1);
});

test('mine_with_progression includes optional iron sword only when surplus resources are ready', async () => {
  const harness = makeHarness({ stone_pickaxe: 1, raw_iron: 5, coal: 1, oak_log: 1 });

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  assert.deepEqual(harness.records.map((entry) => callKey(entry)), [
    'collect:oak_log:1',
    'goto:0,64,0:0.75',
    'craft:oak_planks:2',
    'craft:crafting_table:1',
    'place_workstation:crafting_table:place',
    'goto:0,64,0:0.75',
    'excavate_shaft:61',
    'collect:cobblestone:8',
    'craft:furnace:1',
    'place_workstation:furnace:place',
    'smelt:raw_iron->iron_ingot:5',
    'craft:stick:1',
    'craft:iron_pickaxe:1',
    'equip:iron_pickaxe:hand',
    'craft:iron_sword:1',
    'excavate_shaft:-58',
    'mine_until:diamond_ore:1',
  ]);
});

test('mine_with_progression treats explicit optionalCrafts as required outputs', async () => {
  const harness = makeHarness({});

  const result = await runMineWithProgression(harness.bot, {
    ores: ['iron_ore'],
    count: 3,
    optionalCrafts: ['iron_pickaxe'],
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  assert.ok(harness.records.some((entry) => callKey(entry) === 'craft:iron_pickaxe:1'));
  assert.ok(harness.records.some((entry) => callKey(entry) === 'equip:iron_pickaxe:hand'));
  assert.deepEqual(harness.records.slice(-1).map((entry) => callKey(entry)), [
    'mine_until:iron_ore:3',
  ]);
});

test('mine_with_progression crafts diamond pickaxe after final diamond mining', async () => {
  const harness = makeHarness({});

  const result = await runMineWithProgression(harness.bot, {
    ores: ['diamond_ore'],
    count: 1,
    optionalCrafts: ['diamond_pickaxe'],
  }, ctx({ skillRunners: harness.skillRunners }));

  assert.equal(result.ok, true);
  const keys = harness.records.map((entry) => callKey(entry));
  const diamondMineIndex = keys.indexOf('mine_until:diamond_ore:3');
  const returnIndex = keys.indexOf('excavate_shaft:returnToSurface');
  const craftIndex = keys.indexOf('craft:diamond_pickaxe:1');
  const equipIndex = keys.indexOf('equip:diamond_pickaxe:hand');

  assert.ok(diamondMineIndex >= 0, 'expected final diamond mining to gather enough diamonds for the pickaxe');
  assert.ok(returnIndex > diamondMineIndex, 'expected return to the recorded shaft entry after diamond mining');
  assert.ok(craftIndex > returnIndex, 'expected diamond_pickaxe craft after returning from the final shaft');
  assert.ok(equipIndex > craftIndex, 'expected crafted diamond_pickaxe to be equipped');
  assert.equal(result.preparation.postMiningTotal, 3);
  assert.equal(result.preparation.postMiningCompleted, 3);
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
  if (entry.skill === 'goto') return `goto:${entry.params.x},${entry.params.y},${entry.params.z}:${entry.params.range}`;
  if (entry.skill === 'mine_until' || entry.skill === 'mine_and_return') {
    return `${entry.skill}:${entry.params.ores.join(',')}:${entry.params.count || entry.params.durationMs}`;
  }
  if (entry.skill === 'excavate_shaft') return entry.params.returnToSurface === true
    ? 'excavate_shaft:returnToSurface'
    : `excavate_shaft:${entry.params.targetY}`;
  if (entry.skill === 'collect') return `collect:${entry.params.block}:${entry.params.count}`;
  if (entry.skill === 'smelt') return `smelt:${entry.params.input}->${entry.params.output}:${entry.params.count}`;
  if (entry.skill === 'craft') return `craft:${entry.params.item}:${entry.params.count}`;
  if (entry.skill === 'place_workstation') return `place_workstation:${entry.params.workstation}:${entry.params.action}`;
  if (entry.skill === 'equip') return `equip:${entry.params.item}:${entry.params.destination}`;
  return entry.skill;
}

function pickPosition(params) {
  return { x: params.x, y: params.y, z: params.z };
}
