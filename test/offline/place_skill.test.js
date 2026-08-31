import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';
import { Vec3 } from 'vec3';

import { run as runPlace } from '../../src/skills/place.js';
import { SKILL_REGISTRY } from '../../src/skills/index.js';
import { ADVISOR_SKILL_NAMES, validateSkillCall } from '../../src/skills/schema.js';
import {
  authorizeStorageAccess,
  authorizeWorkstationAccess,
  createWorldActionAuthorization,
} from '../../src/state/world_action_authorization.js';

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
  return `${position.x},${position.y},${position.z}`;
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
  const activated = [];
  const equipped = [];

  for (const entry of opts.blocks || []) {
    world.set(key(entry.position), makeBlock(entry.name, entry.position));
  }

  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: {
      position: opts.position || new Vec3(0, 64, 0),
      yaw: opts.yaw ?? 0,
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
      return world.get(key(position)) || makeBlock('stone', position);
    },
    equip: async (item, destination) => {
      equipped.push({ item: item.name, destination });
      bot.heldItem = item;
    },
    placeBlock: async (referenceBlock, faceVector) => {
      if (opts.placeThrows) throw new Error(opts.placeThrows);
      const target = referenceBlock.position.offset(faceVector.x, faceVector.y, faceVector.z);
      placed.push({ referenceBlock, faceVector, target });
      const held = bot.heldItem;
      assert.ok(held, 'expected a held item before placeBlock');
      inventory[held.name] = Math.max(0, (inventory[held.name] || 0) - 1);
      world.set(key(target), makeBlock(held.name, target));
    },
    activateBlock: async (referenceBlock, faceVector) => {
      const target = referenceBlock.position.offset(faceVector.x, faceVector.y, faceVector.z);
      activated.push({ referenceBlock, faceVector, target });
      const held = bot.heldItem;
      assert.ok(held, 'expected a held item before activateBlock');
      inventory[held.name] = Math.max(0, (inventory[held.name] || 0) - 1);
      world.set(key(target), makeBlock(held.name, target));
    },
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'place-test' }, release() {} }),
      setGoal: () => {
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
      currentOwner: () => null,
      isIdle: () => true,
    },
  });

  return { bot, inventory, world, placed, activated, equipped };
}

test('place is registered and advisor-callable with block-only or explicit coords schema', () => {
  assert.equal(typeof SKILL_REGISTRY.place, 'function');
  assert.ok(ADVISOR_SKILL_NAMES.includes('place'));
  assert.deepEqual(validateSkillCall({ skill: 'place', params: { block: 'crafting_table' } }), { ok: true });
  assert.deepEqual(validateSkillCall({
    skill: 'place',
    params: { block: 'crafting_table', x: 1, y: 64, z: 0 },
  }), { ok: true });
  assert.match(
    validateSkillCall({ skill: 'place', params: { block: 'crafting_table', dryRun: true } }).reason,
    /unknown param "dryRun"/,
  );
});

test('locally observed placements do not self-assert owned anchors without actor-bound receipts', async () => {
  for (const blockName of ['chest', 'furnace', 'crafting_table']) {
    const target = new Vec3(1, 64, 0);
    const harness = makeBot({
      inventory: { [blockName]: 1 },
      blocks: [
        { name: 'air', position: target },
        { name: 'dirt', position: target.offset(0, -1, 0) },
        { name: 'stone', position: target.offset(0, -2, 0) },
      ],
    });
    const authorization = createWorldActionAuthorization({
      sessionIdentity: `place-skill-${blockName}`,
    });
    const callCtx = ctx({ worldActionAuthorization: authorization });

    const result = await runPlace(harness.bot, {
      block: blockName,
      x: target.x,
      y: target.y,
      z: target.z,
    }, callCtx);

    assert.equal(result.ok, true, `${blockName} placement should succeed`);
    const decision = blockName === 'chest'
      ? authorizeStorageAccess(harness.bot, callCtx, target, { blockName })
      : authorizeWorkstationAccess(harness.bot, callCtx, target, { blockName });
    assert.equal(
      authorization.anchors.some((anchor) => anchor.provenance === 'bot_placed_current_session'),
      false,
      `${blockName} placement must not be promoted from a client-side observation`,
    );
    assert.equal(decision.ok, false, `${blockName} access should remain owned-only`);
    assert.match(decision.reason, /unowned (storage|workstation) denied by owned-only policy/);
  }
});

test('place reports missing inventory item before touching world', async () => {
  const target = new Vec3(1, 64, 0);
  const harness = makeBot({
    blocks: [
      { name: 'air', position: target },
      { name: 'dirt', position: target.offset(0, -1, 0) },
      { name: 'stone', position: target.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(harness.bot, { block: 'crafting_table', x: 1, y: 64, z: 0 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no crafting_table in inventory');
  assert.equal(harness.placed.length, 0);
  assert.equal(harness.equipped.length, 0);
});

test('place rejects hazard supports and do-not-touch targets', async () => {
  for (const supportName of ['lava', 'magma_block', 'fire']) {
    const hazardTarget = new Vec3(1, 64, 0);
    const hazardHarness = makeBot({
      inventory: { crafting_table: 1 },
      blocks: [
        { name: 'air', position: hazardTarget },
        { name: supportName, position: hazardTarget.offset(0, -1, 0) },
        { name: 'stone', position: hazardTarget.offset(0, -2, 0) },
      ],
    });

    const hazardResult = await runPlace(
      hazardHarness.bot,
      { block: 'crafting_table', x: 1, y: 64, z: 0 },
      ctx(),
    );

    assert.equal(hazardResult.ok, false);
    assert.match(hazardResult.reason, /no valid placement target within radius=2/);
    assert.equal(hazardResult.placementSearch.failureCounts.supportHazard, 1);
    assert.equal(hazardHarness.placed.length, 0);
  }

  const protectedTarget = new Vec3(2, 64, 0);
  const protectedHarness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'air', position: protectedTarget },
      { name: 'dirt', position: protectedTarget.offset(0, -1, 0) },
      { name: 'stone', position: protectedTarget.offset(0, -2, 0) },
    ],
  });
  const worldModel = {
    doNotTouchRegions: [{
      id: 'protected_fixture',
      bbox: { min: [2, 64, 0], max: [2, 64, 0] },
    }],
  };

  const protectedResult = await runPlace(
    protectedHarness.bot,
    { block: 'crafting_table', x: 2, y: 64, z: 0 },
    ctx({ worldModel }),
  );

  assert.equal(protectedResult.ok, false);
  assert.match(protectedResult.reason, /no valid placement target within radius=2/);
  assert.equal(protectedResult.placementSearch.failureCounts.targetProtected, 1);
  assert.equal(protectedHarness.placed.length, 0);
});

test('place rejects targets with no solid support below', async () => {
  const target = new Vec3(1, 64, 0);
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'air', position: target },
      { name: 'water', position: target.offset(0, -1, 0) },
      { name: 'stone', position: target.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /no valid placement target within radius=2/);
  assert.equal(result.placementSearch.failureCounts.supportMissing, 1);
  assert.equal(harness.placed.length, 0);
  assert.equal(harness.equipped.length, 0);
});

test('place rejects blocked placement target before equipping', async () => {
  const target = new Vec3(1, 64, 0);
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'stone', position: target },
      { name: 'dirt', position: target.offset(0, -1, 0) },
      { name: 'stone', position: target.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /no valid placement target within radius=2/);
  assert.equal(result.placementSearch.failureCounts.targetBlocked > 0, true);
  assert.equal(harness.placed.length, 0);
  assert.equal(harness.equipped.length, 0);
});

test('place nearby search uses a valid alternative when explicit target is invalid', async () => {
  const requested = new Vec3(1, 64, 0);
  const actual = new Vec3(1, 64, 1);
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'air', position: requested },
      { name: 'air', position: requested.offset(0, -1, 0) },
      { name: 'stone', position: requested.offset(0, -2, 0) },
      { name: 'air', position: actual },
      { name: 'dirt', position: actual.offset(0, -1, 0) },
      { name: 'stone', position: actual.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'placed crafting_table at 1,64,1 (requested 1,64,0)');
  assert.deepEqual(result.state.requestedPlaceAt, { x: 1, y: 64, z: 0 });
  assert.deepEqual(result.state.placedAt, { x: 1, y: 64, z: 1 });
  assert.equal(result.state.placementAdjusted, true);
  assert.equal(result.state.placementSearch.checked, 2);
  assert.equal(harness.placed.length, 1);
  assert.deepEqual({
    x: harness.placed[0].target.x,
    y: harness.placed[0].target.y,
    z: harness.placed[0].target.z,
  }, { x: actual.x, y: actual.y, z: actual.z });
  assert.equal(harness.bot.blockAt(actual).name, 'crafting_table');
});

test('place nearby search skips the bot occupied feet cell', async () => {
  const requested = new Vec3(1, 64, 0);
  const actual = new Vec3(1, 64, 1);
  const harness = makeBot({
    position: new Vec3(1.5, 64, 0.5),
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'air', position: requested },
      { name: 'dirt', position: requested.offset(0, -1, 0) },
      { name: 'stone', position: requested.offset(0, -2, 0) },
      { name: 'air', position: actual },
      { name: 'dirt', position: actual.offset(0, -1, 0) },
      { name: 'stone', position: actual.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'placed crafting_table at 1,64,1 (requested 1,64,0)');
  assert.equal(result.state.placementSearch.initialReason, 'placement target 1,64,0 is occupied by the bot');
  assert.equal(harness.bot.blockAt(actual).name, 'crafting_table');
  assert.equal(harness.bot.blockAt(requested).name, 'air');
});

test('place nearby search returns structured failure when no valid target exists', async () => {
  const requested = new Vec3(1, 64, 0);
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'air', position: requested },
      { name: 'water', position: requested.offset(0, -1, 0) },
      { name: 'stone', position: requested.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /no valid placement target within radius=2 verticalRadius=1 of \(1,64,0\)/);
  assert.match(result.reason, /75 candidates checked/);
  assert.equal(result.placementSearch.checked, 75);
  assert.equal(result.placementSearch.failureCounts.supportMissing, 1);
  assert.equal(result.placementSearch.failureCounts.targetBlocked, 74);
  assert.equal(result.initialReason, 'no solid support below placement target 1,64,0');
  assert.equal(harness.placed.length, 0);
});

test('place allows replaceable non-hazard targets like tall grass', async () => {
  const target = new Vec3(1, 64, 0);
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'tall_grass', position: target },
      { name: 'dirt', position: target.offset(0, -1, 0) },
      { name: 'stone', position: target.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'placed crafting_table at 1,64,0');
  assert.equal(harness.placed.length, 1);
  assert.equal(harness.bot.blockAt(target).name, 'crafting_table');
});

test('place equips, places, verifies, and returns structured placement state', async () => {
  const target = new Vec3(1, 64, 0);
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    blocks: [
      { name: 'air', position: target },
      { name: 'dirt', position: target.offset(0, -1, 0) },
      { name: 'stone', position: target.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'placed crafting_table at 1,64,0');
  assert.deepEqual(result.state.placedAt, { x: 1, y: 64, z: 0 });
  assert.equal(result.state.blockName, 'crafting_table');
  assert.deepEqual(harness.equipped, [{ item: 'crafting_table', destination: 'hand' }]);
  assert.equal(harness.placed.length, 1);
  assert.equal(harness.placed[0].referenceBlock.name, 'dirt');
  assert.deepEqual(harness.placed[0].faceVector, new Vec3(0, 1, 0));
  assert.equal(harness.inventory.crafting_table, 0);
  assert.equal(harness.bot.blockAt(target).name, 'crafting_table');
});

test('place falls back to activateBlock when placeBlock never observes the server update', async () => {
  const target = new Vec3(1, 64, 0);
  const harness = makeBot({
    inventory: { crafting_table: 1 },
    placeThrows: 'Event blockUpdate:(1, 64, 0) did not fire within timeout of 5000ms',
    blocks: [
      { name: 'air', position: target },
      { name: 'dirt', position: target.offset(0, -1, 0) },
      { name: 'stone', position: target.offset(0, -2, 0) },
    ],
  });

  const result = await runPlace(
    harness.bot,
    { block: 'crafting_table', x: 1, y: 64, z: 0 },
    ctx(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'placed crafting_table at 1,64,0');
  assert.equal(harness.placed.length, 0);
  assert.equal(harness.activated.length, 1);
  assert.equal(harness.inventory.crafting_table, 0);
  assert.equal(harness.bot.blockAt(target).name, 'crafting_table');
});
