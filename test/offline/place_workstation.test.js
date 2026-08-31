import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';
import { Vec3 } from 'vec3';

import { run as runPlaceWorkstation } from '../../src/skills/place_workstation.js';
import { SKILL_REGISTRY } from '../../src/skills/index.js';
import {
  authorizeWorkstationAccess,
  createWorldActionAuthorization,
} from '../../src/state/world_action_authorization.js';
import {
  ADVISOR_SKILL_NAMES,
  RUNTIME_ONLY_SKILL_NAMES,
  validateAdvisorPlan,
  validatePlan,
  validateSkillCall,
} from '../../src/skills/schema.js';

const registry = mcDataLoader('1.21.4');

function ctx(extra = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    ...extra,
  };
}

function key(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function makeBlock(name, position) {
  const data = registry.blocksByName[name] || {};
  return {
    name,
    type: data.id ?? 0,
    position: position.clone ? position.clone() : new Vec3(position.x, position.y, position.z),
    boundingBox: data.boundingBox || (name.includes('air') ? 'empty' : 'block'),
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

function makeBot(opts = {}) {
  const bot = new EventEmitter();
  const inventory = { ...(opts.inventory || {}) };
  const world = new Map();
  const placed = [];
  const dug = [];
  const equipped = [];
  const unequipped = [];

  for (const entry of opts.blocks || []) {
    world.set(key(entry.position), makeBlock(entry.name, entry.position));
  }

  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: {
      position: opts.position || new Vec3(0, 64, 0),
      yaw: opts.yaw ?? -Math.PI / 2,
      onGround: true,
      isInWater: false,
      equipment: [],
    },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    entities: {},
    registry,
    inventory: {
      items: () => inventoryItems(inventory),
    },
    blockAt(position) {
      const p = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
      const existing = world.get(key(p));
      if (existing) return existing;
      if (p.y <= 62) return makeBlock('stone', p);
      if (p.y === 63) return makeBlock('dirt', p);
      return makeBlock('air', p);
    },
    equip: async (item, destination) => {
      equipped.push({ item: item.name, destination });
      bot.heldItem = item;
    },
    unequip: async (destination) => {
      unequipped.push(destination);
      bot.heldItem = null;
    },
    placeBlock: async (referenceBlock, faceVector) => {
      const target = referenceBlock.position.offset(faceVector.x, faceVector.y, faceVector.z);
      placed.push({ referenceBlock, faceVector, target });
      const held = bot.heldItem;
      assert.ok(held, 'expected held item before placeBlock');
      inventory[held.name] = Math.max(0, (inventory[held.name] || 0) - 1);
      world.set(key(target), makeBlock(held.name, target));
    },
    dig: async (block) => {
      dug.push(block.position.clone());
      world.set(key(block.position), makeBlock('air', block.position));
      inventory[block.name] = (inventory[block.name] || 0) + 1;
    },
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'place-workstation-test' }, release() {} }),
      setGoal: () => {
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
      currentOwner: () => null,
      isIdle: () => true,
    },
  });

  if (opts.heldItem) bot.heldItem = { name: opts.heldItem, type: registry.itemsByName[opts.heldItem]?.id || 9999 };

  return { bot, inventory, world, placed, dug, equipped, unequipped };
}

test('place_workstation is registered runtime-only and validates schema shape', () => {
  assert.equal(typeof SKILL_REGISTRY.place_workstation, 'function');
  assert.equal(ADVISOR_SKILL_NAMES.includes('place_workstation'), false);
  assert.equal(RUNTIME_ONLY_SKILL_NAMES.includes('place_workstation'), true);
  assert.deepEqual(validatePlan([
    { skill: 'place_workstation', params: { workstation: 'crafting_table', action: 'place', searchRadius: 4, verticalRadius: 2 } },
  ]), { ok: true });
  assert.deepEqual(validateAdvisorPlan([
    { skill: 'place_workstation', params: { workstation: 'crafting_table', action: 'place' } },
  ]), {
    ok: false,
    reason: 'place_workstation: not advisor-callable (scheduled only by deterministic progression missions until live-proven and advisor-safe)',
    badIndex: 0,
  });
  assert.equal(
    validateSkillCall({ skill: 'place_workstation', params: { workstation: 'anvil', action: 'place' } }).reason,
    'place_workstation: "workstation" must be one of crafting_table|furnace',
  );
  assert.equal(
    validateSkillCall({ skill: 'place_workstation', params: { workstation: 'furnace', action: 'move' } }).reason,
    'place_workstation: "action" must be one of place|break_and_carry',
  );
  assert.equal(
    validateSkillCall({ skill: 'place_workstation', params: { workstation: 'furnace', action: 'place', searchRadius: -1 } }).reason,
    'place_workstation: "searchRadius" must be >= 0',
  );
});

test('place_workstation places a crafting table on safe ground and records it', async () => {
  const target = new Vec3(1, 64, 0);
  const runtimeContext = {};
  const harness = makeBot({ inventory: { crafting_table: 1 } });

  const result = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'place', x: 1, y: 64, z: 0 },
    ctx({ runtimeContext }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'placed crafting_table at 1,64,0');
  assert.deepEqual(result.state.placedAt, { x: 1, y: 64, z: 0 });
  assert.deepEqual(runtimeContext.placedWorkstations.crafting_table, { x: 1, y: 64, z: 0 });
  assert.equal(harness.inventory.crafting_table, 0);
  assert.equal(harness.bot.blockAt(target).name, 'crafting_table');
  assert.deepEqual(harness.equipped, [{ item: 'crafting_table', destination: 'hand' }]);
});

test('place_workstation places on a solid shaft floor even when the support is over air', async () => {
  const target = new Vec3(1, 66, 0);
  const runtimeContext = {};
  const harness = makeBot({
    position: new Vec3(0, 66, 0),
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'stone', position: target.offset(0, -1, 0) },
    ],
  });

  const result = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'place', x: 1, y: 66, z: 0 },
    ctx({ runtimeContext }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'placed crafting_table at 1,66,0');
  assert.deepEqual(result.state.placedAt, { x: 1, y: 66, z: 0 });
  assert.equal(result.state.placementSearch.elevatedSupport, true);
  assert.equal(harness.bot.blockAt(target).name, 'crafting_table');
  assert.deepEqual(harness.placed.map((entry) => key(entry.target)), ['1,66,0']);
});

test('place_workstation avoids existing workstation blocks as placement support', async () => {
  const pollutedTarget = new Vec3(1, 64, 0);
  const runtimeContext = {};
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'crafting_table', position: pollutedTarget.offset(0, -1, 0) },
      { name: 'stone', position: pollutedTarget.offset(0, -2, 0) },
    ],
  });

  const result = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'place', x: 1, y: 64, z: 0 },
    ctx({ runtimeContext }),
  );

  assert.equal(result.ok, true);
  assert.notDeepEqual(result.state.placedAt, { x: 1, y: 64, z: 0 });
  assert.equal(harness.bot.blockAt(pollutedTarget.offset(0, -1, 0)).name, 'crafting_table');
  assert.equal(harness.bot.blockAt(result.state.placedAt).name, 'crafting_table');
  assert.deepEqual(runtimeContext.placedWorkstations.crafting_table, result.state.placedAt);
  assert.ok(result.state.placementSearch.checked > 1);
});

test('place_workstation rejects missing inventory before placement', async () => {
  const harness = makeBot();

  const result = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'furnace', action: 'place', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_workstation_in_inventory');
  assert.equal(harness.placed.length, 0);
});

test('place_workstation rejects protected placement search space', async () => {
  const harness = makeBot({ inventory: { furnace: 1 } });
  const worldModel = {
    doNotTouchRegions: [{
      id: 'protected_work_area',
      bbox: { min: [-2, 62, -2], max: [3, 66, 2] },
    }],
  };

  const result = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'furnace', action: 'place', x: 1, y: 64, z: 0 },
    ctx({ worldModel }),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /^no_safe_placement_position:/);
  assert.equal(result.searchRadius, 2);
  assert.equal(result.placementSearch.failureCounts.targetProtected > 0, true);
  assert.equal(harness.placed.length, 0);
});

test('place_workstation rejects task-protected shaft cells', async () => {
  const harness = makeBot({ inventory: { crafting_table: 1 } });
  const protectedPositions = new Set();
  for (let x = -2; x <= 3; x++) {
    for (let y = 63; y <= 65; y++) {
      for (let z = -2; z <= 2; z++) protectedPositions.add(`${x},${y},${z}`);
    }
  }

  const result = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'place', x: 1, y: 64, z: 0 },
    ctx({ runtimeContext: { collectProtectedPositions: protectedPositions } }),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /^no_safe_placement_position:/);
  assert.equal(result.placementSearch.failureCounts.targetProtected > 0, true);
  assert.equal(harness.placed.length, 0);
});

test('place_workstation break_and_carry recovers an explicitly trusted tracked workstation', async () => {
  const target = new Vec3(1, 64, 0);
  const runtimeContext = {
    worldActionAuthorization: createWorldActionAuthorization({
      worldIdentity: 'place-workstation-fixture-world',
      operatorAnchors: [{
        kind: 'workstation',
        blockName: 'crafting_table',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'place-workstation-fixture-world',
      }],
    }),
  };
  const harness = makeBot({ inventory: { crafting_table: 1 }, heldItem: 'stone_pickaxe' });

  const placed = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'place', x: 1, y: 64, z: 0 },
    ctx({ runtimeContext }),
  );
  assert.equal(placed.ok, true);

  const recovered = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'break_and_carry' },
    ctx({ runtimeContext }),
  );

  assert.equal(recovered.ok, true);
  assert.equal(recovered.reason, 'recovered crafting_table from 1,64,0');
  assert.deepEqual(recovered.state.recoveredAt, { x: 1, y: 64, z: 0 });
  assert.equal(harness.bot.blockAt(target).name, 'air');
  assert.equal(harness.inventory.crafting_table, 1);
  assert.equal(runtimeContext.placedWorkstations.crafting_table, undefined);
  assert.deepEqual(harness.dug.map((p) => key(p)), ['1,64,0']);
  assert.deepEqual(harness.unequipped, ['hand']);
  assert.equal(
    authorizeWorkstationAccess(harness.bot, { runtimeContext }, target, { blockName: 'crafting_table' }).ok,
    false,
  );
});

test('place_workstation break_and_carry refuses a tracked but unreceipted workstation', async () => {
  const target = new Vec3(1, 64, 0);
  const runtimeContext = {
    worldActionAuthorization: createWorldActionAuthorization({
      sessionIdentity: 'place-workstation-unreceipted-fixture',
    }),
  };
  const harness = makeBot({ inventory: { crafting_table: 1 }, heldItem: 'stone_pickaxe' });

  const placed = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'place', x: 1, y: 64, z: 0 },
    ctx({ runtimeContext }),
  );
  assert.equal(placed.ok, true);

  const recovered = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'crafting_table', action: 'break_and_carry' },
    ctx({ runtimeContext }),
  );

  assert.equal(recovered.ok, false);
  assert.match(recovered.reason, /workstation access denied: unowned workstation denied by owned-only policy/);
  assert.equal(harness.bot.blockAt(target).name, 'crafting_table');
  assert.equal(harness.inventory.crafting_table, 0);
  assert.deepEqual(harness.dug, []);
  assert.deepEqual(runtimeContext.placedWorkstations.crafting_table, { x: 1, y: 64, z: 0 });
});

test('place_workstation break_and_carry reports unknown placed position', async () => {
  const harness = makeBot();

  const result = await runPlaceWorkstation(
    harness.bot,
    { workstation: 'furnace', action: 'break_and_carry' },
    ctx({ runtimeContext: {} }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'placed_position_unknown');
});
