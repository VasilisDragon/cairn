import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WORLD_ACTION_MODE,
  authorizeBlockBreak,
  authorizePlacement,
  authorizeStorageAccess,
  authorizeWorkstationAccess,
  createWorldActionAuthorization,
  deriveServerWorldIdentity,
  installWorldActionBoundary,
  observeServerWorldIdentity,
  observeWorldActionSession,
  registerBotPlacedAnchor,
  revokeWorldActionAnchor,
} from '../../src/state/world_action_authorization.js';
import { WorldModelStore, createEmptyWorldModel } from '../../src/state/world_model.js';

const require = createRequire(import.meta.url);

function pos(x, y, z) {
  return { x, y, z };
}

function sameTestPosition(left, right) {
  return left?.x === right?.x && left?.y === right?.y && left?.z === right?.z;
}

function useItemPacket(bot, hand = 0, rotation = null) {
  return {
    hand,
    rotation: rotation || {
      x: (Math.PI - bot.entity.yaw) * (180 / Math.PI),
      y: -bot.entity.pitch * (180 / Math.PI),
    },
  };
}

function makeBot({
  username = 'MCBot',
  worldIdentity,
  players = { MCBot: { username: 'MCBot' } },
} = {}) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    username,
    game: { dimension: 'overworld' },
    players,
    getControlState: () => false,
    world: { getColumn: () => ({ loaded: true }) },
    findBlocks: () => [],
    blockAt: (position) => liveBlock('air', position),
    QUICK_BAR_START: 36,
    quickBarSlot: 0,
    inventory: { id: 0, type: 'minecraft:inventory', hotbarStart: 36, inventoryEnd: 46, slots: Array(46).fill(null) },
    entity: { id: 1, position: pos(0, 64, 0), yaw: 0, pitch: 0, onGround: true },
  });
  Object.defineProperty(bot, 'heldItem', {
    configurable: true,
    get() { return bot.inventory?.slots?.[bot.QUICK_BAR_START + bot.quickBarSlot]; },
    set(value) { bot.inventory.slots[bot.QUICK_BAR_START + bot.quickBarSlot] = value; },
  });
  bot.clickWindow = async function clickWindow(slot, mouseButton = 0, mode = 0) {
    const window = bot.currentWindow || bot.inventory;
    bot._client.write('window_click', {
      windowId: window.id,
      slot,
      mouseButton,
      mode,
      changedSlots: [],
    });
  };
  if (worldIdentity) bot.worldIdentity = worldIdentity;
  return bot;
}

function observeFixtureWorld(bot, hashedSeed = [0x12345678, -0x1234567]) {
  const packet = { worldState: { hashedSeed } };
  const identity = deriveServerWorldIdentity(packet);
  const observed = observeServerWorldIdentity(bot, {}, packet, 'test-login');
  assert.equal(observed.ok, true);
  assert.equal(observed.identity, identity);
  return identity;
}

function protectedModel(position) {
  const model = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  model.doNotTouchRegions.push({
    id: 'protected-cell',
    bbox: {
      min: [position.x, position.y, position.z],
      max: [position.x, position.y, position.z],
    },
    reason: 'operator protected',
    confidence: 1,
  });
  return model;
}

function liveBlock(name, position, properties = null) {
  const block = { name, position };
  block.getProperties = () => (properties ? { ...properties } : {});
  return block;
}

function exactBlockAt(block) {
  return (position) => (
    sameTestPosition(position, block?.position) ? block : liveBlock('air', position)
  );
}

function openWindowFromBlock(bot, block, window) {
  bot._client.write('block_place', {
    location: block.position,
    direction: 1,
    hand: 0,
  });
  bot.currentWindow = window;
  bot.emit('windowOpen', window);
  return window;
}

test('default and missing authorization deny arbitrary storage and workstations but preserve ordinary excavation', () => {
  const bot = makeBot({ worldIdentity: 'world-a' });
  const target = pos(4, 64, 5);

  assert.equal(authorizeStorageAccess(bot, {}, target, { blockName: 'chest' }).ok, false);
  assert.equal(authorizeWorkstationAccess(bot, {}, target, { blockName: 'furnace' }).ok, false);
  assert.equal(authorizeBlockBreak(bot, {}, { name: 'chest', position: target }).ok, false);
  assert.equal(authorizeBlockBreak(bot, {}, { name: 'stone', position: target }).ok, true);

  const ownedOnly = { worldActionAuthorization: createWorldActionAuthorization() };
  assert.equal(authorizeStorageAccess(bot, ownedOnly, target, { blockName: 'chest' }).ok, false);
  assert.equal(authorizeWorkstationAccess(bot, ownedOnly, target, { blockName: 'crafting_table' }).ok, false);
});

test('explicit operator anchors are world- and dimension-bound and doNotTouch always wins', () => {
  const chest = pos(3, 64, 0);
  const table = pos(4, 64, 0);
  const state = createWorldActionAuthorization({
    operatorAnchors: [
      {
        kind: 'storage',
        blockName: 'chest',
        position: chest,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      },
      {
        kind: 'workstation',
        blockName: 'crafting_table',
        position: table,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      },
    ],
  });
  const ctx = { worldActionAuthorization: state };
  const bot = makeBot({ worldIdentity: 'world-a' });

  assert.equal(authorizeStorageAccess(bot, ctx, chest, { blockName: 'chest' }).ok, true);
  assert.equal(authorizeWorkstationAccess(bot, ctx, table, { blockName: 'crafting_table' }).ok, true);
  assert.equal(authorizeStorageAccess(makeBot({ worldIdentity: 'world-b' }), ctx, chest, { blockName: 'chest' }).ok, false);

  const denied = authorizeStorageAccess(bot, {
    ...ctx,
    worldModel: protectedModel(chest),
  }, chest, { blockName: 'chest' });
  assert.equal(denied.ok, false);
  assert.equal(denied.region.id, 'protected-cell');
});

test('unverified bot-placed anchor claims are never promoted to owned access', () => {
  const target = pos(8, 64, 2);
  const state = createWorldActionAuthorization({ sessionIdentity: 'session-a' });
  const ctx = { worldActionAuthorization: state };
  const firstOpaqueBot = makeBot();
  const secondOpaqueBot = makeBot();

  assert.equal(registerBotPlacedAnchor(firstOpaqueBot, ctx, 'chest', target), null);
  assert.equal(authorizeStorageAccess(firstOpaqueBot, ctx, target, { blockName: 'chest' }).ok, false);
  assert.equal(authorizeStorageAccess(secondOpaqueBot, ctx, target, { blockName: 'chest' }).ok, false);
  assert.equal(revokeWorldActionAnchor(firstOpaqueBot, ctx, 'chest', target), 0);
  assert.equal(authorizeStorageAccess(firstOpaqueBot, ctx, target, { blockName: 'chest' }).ok, false);

  const explicitBot = makeBot({ worldIdentity: 'world-a' });
  assert.equal(registerBotPlacedAnchor(explicitBot, ctx, 'furnace', target), null);
  assert.equal(authorizeWorkstationAccess(explicitBot, ctx, target, { blockName: 'furnace' }).ok, false);
  assert.equal(authorizeWorkstationAccess(makeBot({ worldIdentity: 'world-b' }), ctx, target, { blockName: 'furnace' }).ok, false);

  explicitBot.emit('blockUpdate', { name: 'furnace', position: target }, { name: 'air', position: target });
  assert.equal(authorizeWorkstationAccess(explicitBot, ctx, target, { blockName: 'furnace' }).ok, false);
  assert.equal(state.anchors.some((anchor) => anchor.provenance === 'bot_placed_current_session'), false);
});

test('fresh disposable natural trust requires explicit identity and revokes irreversibly on another player', () => {
  const chest = pos(2, 64, 0);
  const furnace = pos(3, 64, 0);
  const bot = makeBot({ worldIdentity: 'fresh-world' });
  const observedWorldIdentity = observeFixtureWorld(bot);
  const state = createWorldActionAuthorization({
    mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
    sessionIdentity: 'fixture-session',
    freshWorldIdentity: observedWorldIdentity,
    createdFreshWorld: true,
    singlePlayer: true,
    operatorAnchors: [{
      kind: 'storage',
      blockName: 'chest',
      position: chest,
      dimension: 'overworld',
      worldIdentity: observedWorldIdentity,
    }],
  });
  const ctx = { worldActionAuthorization: state };

  assert.equal(authorizeStorageAccess(bot, ctx, chest, { blockName: 'chest' }).ok, true);
  assert.equal(authorizeWorkstationAccess(bot, ctx, furnace, { blockName: 'furnace' }).ok, true);
  bot.emit('playerJoined', { username: 'Alex' });
  assert.equal(state.disposableTrustRevoked, true);
  assert.equal(authorizeWorkstationAccess(bot, ctx, furnace, { blockName: 'furnace' }).ok, false);
  assert.equal(authorizeStorageAccess(bot, ctx, chest, { blockName: 'chest' }).ok, true);

  bot.players = { MCBot: { username: 'MCBot' } };
  assert.equal(authorizeWorkstationAccess(bot, ctx, furnace, { blockName: 'furnace' }).ok, false);

  const implicitSession = createWorldActionAuthorization({
    mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
    worldIdentity: 'fresh-world',
    createdFreshWorld: true,
    singlePlayer: true,
  });
  assert.equal(authorizeStorageAccess(bot, { worldActionAuthorization: implicitSession }, chest, { blockName: 'chest' }).ok, false);
});

test('production boundary observes and pins raw login identity, then revokes on respawn identity change', () => {
  const target = pos(6, 64, 6);
  const bot = makeBot({ worldIdentity: 'config-spoof-must-not-count' });
  const client = new EventEmitter();
  client.write = () => {};
  bot._client = client;
  const state = createWorldActionAuthorization({
    mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
    sessionIdentity: 'production-listener-fixture',
    createdFreshWorld: true,
    singlePlayer: true,
  });
  const ctx = { worldActionAuthorization: state };
  installWorldActionBoundary(bot, ctx);

  assert.equal(authorizeStorageAccess(bot, ctx, target, { blockName: 'chest' }).ok, false);
  client.emit('login', { worldState: { hashedSeed: [101, 202] } });
  assert.equal(authorizeStorageAccess(bot, ctx, target, { blockName: 'chest' }).ok, true);

  client.emit('respawn', { worldState: { hashedSeed: [303, 404] } });
  assert.equal(state.disposableTrustRevoked, true);
  assert.equal(authorizeStorageAccess(bot, ctx, target, { blockName: 'chest' }).ok, false);
});

test('observed players and unidentified join events revoke disposable trust', () => {
  for (const bot of [
    makeBot({
      worldIdentity: 'fresh-world',
      players: { MCBot: { username: 'MCBot' }, Alex: { username: 'Alex' } },
    }),
    makeBot({ worldIdentity: 'fresh-world' }),
  ]) {
    const observedWorldIdentity = observeFixtureWorld(bot);
    const state = createWorldActionAuthorization({
      mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
      sessionIdentity: 'fixture-session',
      freshWorldIdentity: observedWorldIdentity,
      createdFreshWorld: true,
      singlePlayer: true,
    });
    const ctx = { worldActionAuthorization: state };
    observeWorldActionSession(bot, ctx);
    if (Object.keys(bot.players).length === 1) bot.emit('playerJoined', {});
    assert.equal(state.disposableTrustRevoked, true);
    assert.equal(authorizeStorageAccess(bot, ctx, pos(1, 64, 1), { blockName: 'chest' }).ok, false);
  }
});

test('final authorization reloads the authoritative world model and protects placement references', () => {
  const target = pos(0, 65, 0);
  const reference = pos(0, 64, 0);
  const safe = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  const protectedReference = protectedModel(reference);
  const ctx = {
    worldModel: safe,
    worldModelStore: { load: () => protectedReference },
  };

  const result = authorizePlacement(makeBot(), ctx, target, { referencePosition: reference });
  assert.equal(result.ok, false);
  assert.match(result.reason, /placement reference is protected/);
});

test('raw Mineflayer boundary denies protected pathfinder digs without a world write', async () => {
  const target = pos(7, 63, 9);
  const bot = makeBot();
  let writes = 0;
  bot.dig = async () => { writes += 1; };
  bot.blockAt = exactBlockAt(liveBlock('stone', target));
  const ctx = {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(target),
  };
  installWorldActionBoundary(bot, ctx);

  await assert.rejects(
    bot.dig({ name: 'stone', position: target }),
    (error) => error?.code === 'WORLD_ACTION_DENIED',
  );
  assert.equal(writes, 0);

  ctx.worldModel = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  await bot.dig({ name: 'stone', position: target });
  assert.equal(writes, 1);
});

test('final world-action sinks classify freshly resolved blocks instead of stale caller snapshots', async () => {
  const targets = {
    dig: pos(1, 64, 0),
    activate: pos(2, 64, 0),
    container: pos(3, 64, 0),
    furnace: pos(4, 64, 0),
    craft: pos(5, 64, 0),
  };
  const liveBlocks = new Map([
    ['1,64,0', liveBlock('chest', targets.dig)],
    ['2,64,0', liveBlock('furnace', targets.activate)],
    ['3,64,0', liveBlock('chest', targets.container)],
    ['4,64,0', liveBlock('furnace', targets.furnace)],
    ['5,64,0', liveBlock('crafting_table', targets.craft)],
  ]);
  const writes = { dig: 0, activate: 0, container: 0, furnace: 0, craft: 0 };
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot.blockAt = (position) => liveBlocks.get(`${position.x},${position.y},${position.z}`)
    || liveBlock('air', position);
  bot.dig = async () => { writes.dig += 1; };
  bot.activateBlock = async () => { writes.activate += 1; };
  bot.openContainer = async () => { writes.container += 1; };
  bot.openFurnace = async () => { writes.furnace += 1; };
  bot.craft = async () => { writes.craft += 1; };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  const staleOrdinary = (position) => ({ name: 'stone', position });
  await assert.rejects(bot.dig(staleOrdinary(targets.dig)), { code: 'WORLD_ACTION_DENIED' });
  await assert.rejects(bot.activateBlock(staleOrdinary(targets.activate)), { code: 'WORLD_ACTION_DENIED' });
  await assert.rejects(bot.openContainer(staleOrdinary(targets.container)), { code: 'WORLD_ACTION_DENIED' });
  await assert.rejects(bot.openFurnace(staleOrdinary(targets.furnace)), { code: 'WORLD_ACTION_DENIED' });
  await assert.rejects(bot.craft({}, 1, staleOrdinary(targets.craft)), { code: 'WORLD_ACTION_DENIED' });
  assert.deepEqual(writes, { dig: 0, activate: 0, container: 0, furnace: 0, craft: 0 });
});

test('final block lookup fails closed and ordinary digs delegate the fresh block', async () => {
  const target = pos(9, 64, 9);
  for (const blockAt of [
    undefined,
    () => null,
    () => { throw new Error('world query failed'); },
    () => ({ name: 'stone', position: pos(10, 64, 9) }),
  ]) {
    const bot = makeBot();
    let writes = 0;
    bot.blockAt = blockAt;
    bot.dig = async () => { writes += 1; };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    await assert.rejects(bot.dig({ name: 'stone', position: target }), { code: 'WORLD_ACTION_DENIED' });
    assert.equal(writes, 0);
  }

  const current = liveBlock('dirt', target);
  const allowed = makeBot();
  let delegated = null;
  allowed.blockAt = exactBlockAt(current);
  allowed.dig = async (block) => { delegated = block; };
  installWorldActionBoundary(allowed, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await allowed.dig({ name: 'stone', position: target });
  assert.equal(delegated, current);
});

test('container identity changes and unavailable placement references fail closed while inventory craft remains available', async () => {
  const target = pos(11, 64, 11);
  const bot = makeBot({ worldIdentity: 'world-a' });
  let containerWrites = 0;
  let placementWrites = 0;
  let craftWrites = 0;
  bot.blockAt = exactBlockAt(liveBlock('stone', target));
  bot.openContainer = async () => { containerWrites += 1; };
  bot.placeBlock = async () => { placementWrites += 1; };
  bot.craft = async () => { craftWrites += 1; };
  bot.heldItem = { name: 'dirt' };
  const ctx = {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  };
  installWorldActionBoundary(bot, ctx);

  await assert.rejects(
    bot.openContainer({ name: 'chest', position: target }),
    (error) => error?.code === 'WORLD_ACTION_DENIED' && /unsupported/.test(error.message),
  );
  bot.blockAt = () => null;
  await assert.rejects(
    bot.placeBlock({ name: 'stone', position: target }, pos(0, 1, 0)),
    (error) => error?.code === 'WORLD_ACTION_DENIED' && /could not be verified/.test(error.message),
  );
  await bot.craft({}, 1, null);
  assert.deepEqual({ containerWrites, placementWrites, craftWrites }, {
    containerWrites: 0,
    placementWrites: 0,
    craftWrites: 1,
  });
});

test('double-chest access authorizes both live halves and fails closed on malformed partners', async () => {
  const left = pos(20, 64, 20);
  const right = pos(21, 64, 20);
  const blocks = new Map([
    ['20,64,20', liveBlock('chest', left, { type: 'left', facing: 'north' })],
    ['21,64,20', liveBlock('chest', right, { type: 'right', facing: 'north' })],
  ]);
  const makeContainerBot = (operatorAnchors, worldModel = null) => {
    const bot = makeBot({ worldIdentity: 'world-a' });
    let opens = 0;
    const writes = [];
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.blockAt = (position) => blocks.get(`${position.x},${position.y},${position.z}`)
      || liveBlock('air', position);
    bot.openContainer = async (block) => {
      opens += 1;
      const window = { id: 7, type: 'minecraft:generic_9x6' };
      return openWindowFromBlock(bot, block, window);
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization({ operatorAnchors }),
      worldModel,
    });
    return { bot, opens: () => opens, writes };
  };
  const anchor = (position) => ({
    kind: 'storage',
    blockName: 'chest',
    position,
    dimension: 'overworld',
    worldIdentity: 'world-a',
  });

  const partial = makeContainerBot([anchor(left)]);
  await assert.rejects(partial.bot.openContainer(blocks.get('20,64,20')), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(partial.opens(), 0);

  const complete = makeContainerBot([anchor(left), anchor(right)]);
  await complete.bot.openContainer(blocks.get('20,64,20'));
  assert.equal(complete.opens(), 1);
  blocks.set('20,64,20', liveBlock('chest', left, { type: 'single', facing: 'north' }));
  assert.throws(
    () => complete.bot._client.write('window_click', { windowId: 7, slot: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(
    complete.writes.filter(({ name }) => name === 'window_click').length,
    0,
  );
  blocks.set('20,64,20', liveBlock('chest', left, { type: 'left', facing: 'north' }));

  const protectedPartner = makeContainerBot([anchor(left), anchor(right)], protectedModel(right));
  await assert.rejects(
    protectedPartner.bot.openContainer(blocks.get('20,64,20')),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(protectedPartner.opens(), 0);

  blocks.set('21,64,20', liveBlock('trapped_chest', right, { type: 'right', facing: 'north' }));
  const mismatched = makeContainerBot([anchor(left), anchor(right)]);
  await assert.rejects(mismatched.bot.openContainer(blocks.get('20,64,20')), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(mismatched.opens(), 0);
});

test('packet-adjacent guards reject post-look changes and preserve sensor-free non-world item use', async () => {
  const reference = pos(30, 64, 30);
  const destination = pos(30, 65, 30);
  let current = liveBlock('stone', reference);
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.registry = { blocksByName: { dirt: {} } };
  bot.heldItem = { name: 'dirt' };
  bot.blockAt = (position) => {
    if (position.x === reference.x && position.y === reference.y && position.z === reference.z) {
      return current;
    }
    if (position.x === destination.x && position.y === destination.y && position.z === destination.z) {
      return liveBlock('air', destination);
    }
    return null;
  };
  bot.placeBlock = async () => {
    current = liveBlock('chest', reference, { type: 'single', facing: 'north' });
    bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  await assert.rejects(
    bot.placeBlock(liveBlock('stone', reference), pos(0, 1, 0)),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(writes.length, 0);

  current = liveBlock('stone', reference);
  const protectedContext = {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(destination),
  };
  installWorldActionBoundary(bot, protectedContext);
  assert.throws(
    () => bot._client.write('block_place', { location: reference, direction: 1, hand: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(writes.length, 0);

  bot.heldItem = { name: 'apple' };
  bot.blockAt = (position) => liveBlock('air', position);
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  bot._client.write('block_place', {
    location: pos(-1, 255, -1),
    direction: -1,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'block_place');
});

test('packet-adjacent dig checks every bed, door, and double-height plant cell', () => {
  const cases = [
    {
      name: 'red_bed',
      first: pos(70, 64, 70),
      second: pos(70, 64, 69),
      firstProperties: { part: 'foot', facing: 'north' },
      secondProperties: { part: 'head', facing: 'north' },
    },
    {
      name: 'oak_door',
      first: pos(72, 64, 70),
      second: pos(72, 65, 70),
      firstProperties: { half: 'lower', facing: 'north', hinge: 'left' },
      secondProperties: { half: 'upper', facing: 'north', hinge: 'left' },
    },
    {
      name: 'sunflower',
      first: pos(74, 64, 70),
      second: pos(74, 65, 70),
      firstProperties: { half: 'lower' },
      secondProperties: { half: 'upper' },
    },
  ];

  for (const fixture of cases) {
    const blocks = new Map([
      [`${fixture.first.x},${fixture.first.y},${fixture.first.z}`, liveBlock(fixture.name, fixture.first, fixture.firstProperties)],
      [`${fixture.second.x},${fixture.second.y},${fixture.second.z}`, liveBlock(fixture.name, fixture.second, fixture.secondProperties)],
    ]);
    const writes = [];
    const bot = makeBot();
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.blockAt = (position) => blocks.get(`${position.x},${position.y},${position.z}`)
      || liveBlock('air', position);
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
      worldModel: protectedModel(fixture.second),
    });
    assert.throws(
      () => bot._client.write('block_dig', { status: 0, location: fixture.first, face: 1 }),
      { code: 'WORLD_ACTION_DENIED' },
      fixture.name,
    );
    assert.equal(writes.length, 0, fixture.name);
  }

  const lower = pos(76, 64, 70);
  const missingPartnerBot = makeBot();
  missingPartnerBot._client = { write: () => assert.fail('malformed paired geometry must not be sent') };
  missingPartnerBot.blockAt = (position) => (
    position.y === lower.y ? liveBlock('large_fern', lower, { half: 'lower' }) : null
  );
  installWorldActionBoundary(missingPartnerBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => missingPartnerBot._client.write('block_dig', { status: 0, location: lower, face: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const unreadableBed = pos(77, 64, 70);
  const unreadableBot = makeBot();
  unreadableBot._client = { write: () => assert.fail('unreadable paired geometry must not be sent') };
  unreadableBot.blockAt = () => ({
    name: 'red_bed',
    position: unreadableBed,
    getProperties: () => { throw new Error('chunk changed'); },
  });
  installWorldActionBoundary(unreadableBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => unreadableBot._client.write('block_dig', { status: 0, location: unreadableBed, face: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const allowedLower = pos(78, 64, 70);
  const allowedUpper = pos(78, 65, 70);
  const allowedBlocks = new Map([
    ['78,64,70', liveBlock('oak_door', allowedLower, { half: 'lower', facing: 'north', hinge: 'left' })],
    ['78,65,70', liveBlock('oak_door', allowedUpper, { half: 'upper', facing: 'north', hinge: 'left' })],
  ]);
  const allowedWrites = [];
  const allowedBot = makeBot();
  allowedBot._client = { write: (name, packet) => { allowedWrites.push({ name, packet }); } };
  allowedBot.blockAt = (position) => allowedBlocks.get(`${position.x},${position.y},${position.z}`)
    || liveBlock('air', position);
  installWorldActionBoundary(allowedBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  allowedBot._client.write('block_dig', { status: 0, location: allowedLower, face: 1 });
  assert.equal(allowedWrites.length, 1, 'valid unprotected paired geometry remains permitted');
});

test('digging fails closed in DNT worlds with unbounded support fluid attachment or redstone effects', () => {
  const support = pos(79, 64, 70);
  for (const [index, dependentName] of [
    'sand', 'wall_torch', 'water', 'redstone_wire', 'rail',
  ].entries()) {
    const protectedPosition = pos(79 + index, 65, 70);
    const bot = makeBot();
    bot._client = { write: () => assert.fail(`${dependentName} collateral dig must not be sent`) };
    bot.blockAt = (position) => (
      sameTestPosition(position, support)
        ? liveBlock('stone', support)
        : liveBlock(dependentName, protectedPosition)
    );
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
      worldModel: protectedModel(protectedPosition),
    });
    assert.throws(
      () => bot._client.write('block_dig', { status: 0, location: support, face: 1 }),
      (error) => error?.code === 'WORLD_ACTION_DENIED'
        && /effects cannot be bounded/.test(error.message),
      dependentName,
    );
  }
});

test('digging cannot detach or spill any observed entity through an unbounded cascade', () => {
  const support = pos(84, 64, 70);
  for (const entity of [
    {
      id: 90,
      name: 'item_frame',
      type: 'object',
      position: pos(84.5, 64.5, 70),
    },
    {
      id: 91,
      name: 'donkey',
      type: 'mob',
      position: pos(84, 65, 70),
      metadata: [],
      equipment: [],
    },
    {
      id: 92,
      name: 'chest_minecart',
      type: 'object',
      position: pos(84, 90, 70),
    },
  ]) {
    const bot = makeBot();
    bot.entities = { [entity.id]: entity };
    bot._client = { write: () => assert.fail(`${entity.name} support dig must not be sent`) };
    bot.blockAt = exactBlockAt(liveBlock('stone', support));
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    assert.throws(
      () => bot._client.write('block_dig', { status: 0, location: support, face: 1 }),
      (error) => error?.code === 'WORLD_ACTION_DENIED' && /observed unowned entity/.test(error.message),
      entity.name,
    );
  }
});

test('digging an ordinary support cannot break or feed an adjacent unowned anchor', () => {
  const support = pos(86, 64, 70);
  for (const [name, position] of [
    ['flower_pot', pos(86, 65, 70)],
    ['grindstone', pos(87, 64, 70)],
    ['hopper', pos(86, 63, 70)],
  ]) {
    const bot = makeBot();
    bot._client = { write: () => assert.fail(`${name} collateral dig must not be sent`) };
    bot.blockAt = (candidate) => {
      if (sameTestPosition(candidate, support)) return liveBlock('stone', support);
      if (sameTestPosition(candidate, position)) return liveBlock(name, position);
      return liveBlock('air', candidate);
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    assert.throws(
      () => bot._client.write('block_dig', { status: 0, location: support, face: 1 }),
      (error) => error?.code === 'WORLD_ACTION_DENIED'
        && /unowned anchor or dependency/.test(error.message),
      name,
    );
  }
});

test('gravity chains and unreadable adjacent cells fail closed at dig, place, and container boundaries', async () => {
  const support = pos(88, 64, 70);
  const gravity = pos(88, 65, 70);
  const dependentAnchor = pos(88, 66, 70);
  const gravityBot = makeBot();
  gravityBot._client = { write: () => assert.fail('gravity-chain dig must not be sent') };
  gravityBot.blockAt = (position) => {
    if (sameTestPosition(position, support)) return liveBlock('stone', support);
    if (sameTestPosition(position, gravity)) return liveBlock('sand', gravity);
    if (sameTestPosition(position, dependentAnchor)) return liveBlock('flower_pot', dependentAnchor);
    return liveBlock('air', position);
  };
  installWorldActionBoundary(gravityBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => gravityBot._client.write('block_dig', { status: 0, location: support, face: 1 }),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /unowned anchor or dependency/.test(error.message),
  );

  const unreadableDig = makeBot();
  unreadableDig._client = { write: () => assert.fail('unreadable-neighbor dig must not be sent') };
  unreadableDig.blockAt = (position) => (
    sameTestPosition(position, support) ? liveBlock('stone', support) : null
  );
  installWorldActionBoundary(unreadableDig, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => unreadableDig._client.write('block_dig', { status: 0, location: support, face: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const placeReference = pos(89, 64, 70);
  const placeTarget = pos(89, 65, 70);
  const unreadablePlaceNeighbor = pos(90, 65, 70);
  const placeBot = makeBot();
  placeBot.registry = { blocksByName: { stone: {} } };
  placeBot.heldItem = { name: 'stone' };
  placeBot._client = { write: () => assert.fail('unreadable-neighbor placement must not be sent') };
  placeBot.blockAt = (position) => {
    if (sameTestPosition(position, placeReference)) return liveBlock('stone', placeReference);
    if (sameTestPosition(position, placeTarget)) return liveBlock('air', placeTarget);
    if (sameTestPosition(position, unreadablePlaceNeighbor)) return null;
    return liveBlock('air', position);
  };
  placeBot._genericPlace = async () => {
    placeBot._client.write('block_place', { location: placeReference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(placeBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await assert.rejects(
    placeBot._genericPlace(liveBlock('stone', placeReference), pos(0, 1, 0), {}),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const chestPosition = pos(91, 64, 70);
  const chest = liveBlock('chest', chestPosition, { type: 'single', facing: 'north' });
  const containerBot = makeBot({ worldIdentity: 'world-a' });
  containerBot._client = { write: () => assert.fail('unreadable-neighbor open must not be sent') };
  containerBot.blockAt = (position) => (
    sameTestPosition(position, chestPosition) ? chest : null
  );
  containerBot.openContainer = async () => assert.fail('container delegate must not execute');
  installWorldActionBoundary(containerBot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage', blockName: 'chest', position: chestPosition,
        dimension: 'overworld', worldIdentity: 'world-a',
      }],
    }),
  });
  await assert.rejects(containerBot.openContainer(chest), { code: 'WORLD_ACTION_DENIED' });
});

test('fluid-releasing and property-unreadable blocks cannot start unbounded dig flow', () => {
  for (const [index, current] of [
    liveBlock('ice', pos(92, 64, 72)),
    liveBlock('frosted_ice', pos(93, 64, 72)),
    liveBlock('oak_stairs', pos(94, 64, 72), { waterlogged: true }),
    { name: 'stone', position: pos(95, 64, 72) },
  ].entries()) {
    const observer = pos(current.position.x + 2, current.position.y, current.position.z);
    const hopper = pos(current.position.x + 3, current.position.y, current.position.z);
    const bot = makeBot();
    bot._client = { write: () => assert.fail(`fluid-release dig ${index} must not be sent`) };
    bot.blockAt = (position) => {
      if (sameTestPosition(position, current.position)) return current;
      if (sameTestPosition(position, observer)) return liveBlock('observer', observer);
      if (sameTestPosition(position, hopper)) return liveBlock('hopper', hopper);
      return liveBlock('air', position);
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    assert.throws(
      () => bot._client.write('block_dig', { status: 0, location: current.position, face: 1 }),
      { code: 'WORLD_ACTION_DENIED' },
    );
  }
});

test('redstone controls and dependency center cells deny indirect unowned automation effects', async () => {
  const support = pos(92, 64, 70);
  const lever = pos(93, 64, 70);
  const hopper = pos(94, 64, 70);
  const supportBot = makeBot();
  supportBot._client = { write: () => assert.fail('lever-support dig must not be sent') };
  supportBot.blockAt = (position) => {
    if (sameTestPosition(position, support)) return liveBlock('stone', support);
    if (sameTestPosition(position, lever)) return liveBlock('lever', lever);
    if (sameTestPosition(position, hopper)) return liveBlock('hopper', hopper);
    return liveBlock('air', position);
  };
  installWorldActionBoundary(supportBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => supportBot._client.write('block_dig', { status: 0, location: support, face: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const powered = pos(96, 64, 70);
  const centerBot = makeBot();
  centerBot._client = { write: () => assert.fail('redstone center dig must not be sent') };
  centerBot.blockAt = (position) => (
    sameTestPosition(position, powered)
      ? liveBlock('redstone_block', powered)
      : liveBlock('air', position)
  );
  installWorldActionBoundary(centerBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => centerBot._client.write('block_dig', { status: 0, location: powered, face: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const placeReference = pos(97, 63, 70);
  const replaceTarget = pos(97, 64, 70);
  const replacementBot = makeBot();
  replacementBot.registry = { blocksByName: { stone: {} } };
  replacementBot.heldItem = { name: 'stone' };
  replacementBot._client = { write: () => assert.fail('redstone replacement must not be sent') };
  replacementBot.blockAt = (position) => {
    if (sameTestPosition(position, placeReference)) return liveBlock('stone', placeReference);
    if (sameTestPosition(position, replaceTarget)) return liveBlock('redstone_block', replaceTarget);
    return liveBlock('air', position);
  };
  replacementBot._genericPlace = async () => {
    replacementBot._client.write('block_place', { location: placeReference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(replacementBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await assert.rejects(
    replacementBot._genericPlace(liveBlock('stone', placeReference), pos(0, 1, 0), {}),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const log = liveBlock('oak_log', pos(98, 64, 70));
  const observer = liveBlock('observer', pos(99, 64, 70));
  const dispenser = liveBlock('dispenser', pos(100, 64, 70));
  const toolBot = makeBot();
  toolBot.registry = { blocksByName: {} };
  toolBot.heldItem = { name: 'iron_axe' };
  toolBot._client = { write: () => assert.fail('observer-triggering tool transform must not be sent') };
  toolBot.blockAt = (position) => {
    if (sameTestPosition(position, log.position)) return log;
    if (sameTestPosition(position, observer.position)) return observer;
    if (sameTestPosition(position, dispenser.position)) return dispenser;
    return liveBlock('air', position);
  };
  toolBot.activateBlock = async () => {
    toolBot._client.write('block_place', { location: log.position, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(toolBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await assert.rejects(toolBot.activateBlock(log), { code: 'WORLD_ACTION_DENIED' });

  const fenceChainTarget = pos(102, 64, 70);
  const fence = pos(103, 64, 70);
  const chainObserver = pos(104, 64, 70);
  const chainDispenser = pos(105, 64, 70);
  const fenceChainBlocks = (position) => {
    if (sameTestPosition(position, fenceChainTarget)) return liveBlock('stone', fenceChainTarget);
    if (sameTestPosition(position, fence)) return liveBlock('oak_fence', fence);
    if (sameTestPosition(position, chainObserver)) return liveBlock('observer', chainObserver);
    if (sameTestPosition(position, chainDispenser)) return liveBlock('dispenser', chainDispenser);
    return liveBlock('air', position);
  };
  const fenceDigBot = makeBot();
  fenceDigBot.blockAt = fenceChainBlocks;
  fenceDigBot._client = { write: () => assert.fail('two-hop fence observer dig must not be sent') };
  installWorldActionBoundary(fenceDigBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => fenceDigBot._client.write('block_dig', {
      status: 0, location: fenceChainTarget, face: 1,
    }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const fencePlaceReference = pos(102, 63, 70);
  const fencePlaceBot = makeBot();
  fencePlaceBot.registry = { blocksByName: { stone: {} } };
  fencePlaceBot.heldItem = { name: 'stone' };
  fencePlaceBot.blockAt = (position) => {
    if (sameTestPosition(position, fencePlaceReference)) return liveBlock('stone', fencePlaceReference);
    if (sameTestPosition(position, fenceChainTarget)) return liveBlock('air', fenceChainTarget);
    return fenceChainBlocks(position);
  };
  fencePlaceBot._client = { write: () => assert.fail('two-hop fence observer place must not be sent') };
  fencePlaceBot._genericPlace = async () => {
    fencePlaceBot._client.write('block_place', {
      location: fencePlaceReference, direction: 1, hand: 0,
    });
  };
  installWorldActionBoundary(fencePlaceBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await assert.rejects(
    fencePlaceBot._genericPlace(liveBlock('stone', fencePlaceReference), pos(0, 1, 0), {}),
    { code: 'WORLD_ACTION_DENIED' },
  );
});

test('known state-propagation chains fail closed while isolated logs remain diggable', () => {
  const log = pos(106, 64, 70);
  const leaves = Array.from({ length: 6 }, (_unused, index) => (
    pos(log.x + index + 1, log.y, log.z)
  ));
  const observer = pos(log.x + 7, log.y, log.z);
  const dispenser = pos(log.x + 8, log.y, log.z);
  const chainBot = makeBot();
  chainBot.blockAt = (position) => {
    if (sameTestPosition(position, log)) return liveBlock('oak_log', log);
    const leafIndex = leaves.findIndex((candidate) => sameTestPosition(position, candidate));
    if (leafIndex >= 0) {
      return liveBlock('oak_leaves', leaves[leafIndex], {
        distance: leafIndex + 1,
        persistent: false,
      });
    }
    if (sameTestPosition(position, observer)) return liveBlock('observer', observer);
    if (sameTestPosition(position, dispenser)) return liveBlock('dispenser', dispenser);
    return liveBlock('air', position);
  };
  chainBot._client = { write: () => assert.fail('leaf-state cascade dig must not be sent') };
  installWorldActionBoundary(chainBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => chainBot._client.write('block_dig', { status: 0, location: log, face: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const isolatedLog = pos(120, 64, 70);
  let isolatedWrites = 0;
  const isolatedBot = makeBot();
  isolatedBot.blockAt = exactBlockAt(liveBlock('oak_log', isolatedLog));
  isolatedBot._client = { write: () => { isolatedWrites += 1; } };
  installWorldActionBoundary(isolatedBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  isolatedBot._client.write('block_dig', { status: 0, location: isolatedLog, face: 1 });
  assert.equal(isolatedWrites, 1);
});

test('intentional world and window events deny remote vibration-sensor automation at the physical boundary', async () => {
  const chestPosition = pos(104, 64, 70);
  const sensorPosition = pos(106, 64, 70);
  const dispenserPosition = pos(107, 64, 70);
  const chest = liveBlock('chest', chestPosition, { type: 'single', facing: 'north' });
  const openWrites = [];
  const openBot = makeBot({ worldIdentity: 'world-a' });
  let sensorLive = false;
  let sensorScans = 0;
  openBot.findBlocks = (options) => {
    sensorScans += 1;
    assert.equal(options.maxDistance, 16);
    if (!sensorLive) {
      sensorLive = true;
      return [];
    }
    return [sensorPosition];
  };
  openBot.blockAt = (position) => {
    if (sameTestPosition(position, chestPosition)) return chest;
    if (sameTestPosition(position, sensorPosition) && sensorLive) {
      return liveBlock('sculk_sensor', sensorPosition);
    }
    if (sameTestPosition(position, dispenserPosition)) {
      return liveBlock('dispenser', dispenserPosition);
    }
    return liveBlock('air', position);
  };
  openBot._client = { write: (name, packet) => { openWrites.push({ name, packet }); } };
  openBot.openContainer = async (block) => openWindowFromBlock(openBot, block, {
    id: 130, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63,
    slots: Array(63).fill(null),
  });
  installWorldActionBoundary(openBot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage', blockName: 'chest', position: chestPosition,
        dimension: 'overworld', worldIdentity: 'world-a',
      }],
    }),
  });
  await assert.rejects(
    openBot.openContainer(chest),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /remote vibration sensor/.test(error.message),
  );
  assert.equal(sensorScans, 2, 'the sensor appeared after preparation and was caught at raw send');
  assert.deepEqual(openWrites, []);

  const digPosition = pos(110, 64, 70);
  const calibratedPosition = pos(126, 64, 70);
  const digBot = makeBot();
  digBot.findBlocks = (options) => {
    assert.equal(options.maxDistance, 16);
    return [calibratedPosition];
  };
  digBot.blockAt = (position) => {
    if (sameTestPosition(position, digPosition)) return liveBlock('stone', digPosition);
    if (sameTestPosition(position, calibratedPosition)) {
      return liveBlock('calibrated_sculk_sensor', calibratedPosition);
    }
    return liveBlock('air', position);
  };
  digBot._client = { write: () => assert.fail('remote-sensor dig must not be sent') };
  installWorldActionBoundary(digBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => digBot._client.write('block_dig', { status: 0, location: digPosition, face: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const eventSensor = pos(2, 64, 0);
  const itemBot = makeBot();
  itemBot.heldItem = { name: 'apple' };
  itemBot.findBlocks = () => [eventSensor];
  itemBot.blockAt = (position) => (
    sameTestPosition(position, eventSensor)
      ? liveBlock('sculk_sensor', eventSensor)
      : liveBlock('air', position)
  );
  itemBot._client = { write: () => assert.fail('remote-sensor item use must not be sent') };
  itemBot.activateItem = async () => itemBot._client.write('use_item', useItemPacket(itemBot));
  installWorldActionBoundary(itemBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await assert.rejects(itemBot.activateItem(), { code: 'WORLD_ACTION_DENIED' });

  const zombie = { id: 201, name: 'zombie', type: 'mob', position: pos(1, 64, 0) };
  const attackBot = makeBot();
  attackBot.entities = { [zombie.id]: zombie };
  attackBot.findBlocks = () => [eventSensor];
  attackBot.blockAt = itemBot.blockAt;
  attackBot._client = { write: () => assert.fail('remote-sensor attack must not be sent') };
  attackBot.attack = (target) => attackBot._client.write('use_entity', {
    target: target.id, mouse: 1, sneaking: false,
  });
  installWorldActionBoundary(attackBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(() => attackBot.attack(zombie), { code: 'WORLD_ACTION_DENIED' });

  const unreadableBot = makeBot();
  unreadableBot.world = { getColumn: () => null };
  unreadableBot.blockAt = exactBlockAt(liveBlock('stone', digPosition));
  unreadableBot._client = { write: () => assert.fail('incomplete sensor scan must not send') };
  installWorldActionBoundary(unreadableBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => unreadableBot._client.write('block_dig', { status: 0, location: digPosition, face: 1 }),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /unreadable chunk column/.test(error.message),
  );
});

test('packet-adjacent placement uses actual hand and protects multi-cell item geometry', async () => {
  const fixtures = [
    { item: 'red_bed', secondaryOffset: pos(0, 0, -1) },
    { item: 'oak_door', secondaryOffset: pos(0, 1, 0) },
    { item: 'sunflower', secondaryOffset: pos(0, 1, 0) },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const reference = pos(80 + index * 3, 64, 80);
    const primary = pos(reference.x, 65, reference.z);
    const secondary = pos(
      primary.x + fixture.secondaryOffset.x,
      primary.y + fixture.secondaryOffset.y,
      primary.z + fixture.secondaryOffset.z,
    );
    const blocks = new Map([
      [`${reference.x},${reference.y},${reference.z}`, liveBlock('stone', reference)],
      [`${primary.x},${primary.y},${primary.z}`, liveBlock('air', primary)],
      [`${secondary.x},${secondary.y},${secondary.z}`, liveBlock('air', secondary)],
    ]);
    const writes = [];
    const bot = makeBot();
    bot.entity = { ...bot.entity, yaw: 0 };
    bot.registry = { blocksByName: { [fixture.item]: {} } };
    bot.heldItem = { name: fixture.item };
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.blockAt = (position) => blocks.get(`${position.x},${position.y},${position.z}`)
      || liveBlock('air', position);
    bot._genericPlace = async () => {
      bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
      worldModel: protectedModel(secondary),
    });
    await assert.rejects(
      bot._genericPlace(blocks.get(`${reference.x},${reference.y},${reference.z}`), pos(0, 1, 0), {}),
      { code: 'WORLD_ACTION_DENIED' },
      fixture.item,
    );
    assert.equal(writes.length, 0, fixture.item);
  }

  const reference = pos(90, 64, 80);
  const primary = pos(90, 65, 80);
  const upper = pos(90, 66, 80);
  const offhandBot = makeBot();
  offhandBot.entity = { ...offhandBot.entity, yaw: 0 };
  offhandBot.registry = { blocksByName: { dirt: {}, oak_door: {} } };
  offhandBot.heldItem = { name: 'dirt' };
  offhandBot.inventory = {
    id: 0,
    hotbarStart: 36,
    slots: { 36: { name: 'dirt' }, 45: { name: 'oak_door' } },
  };
  offhandBot._client = { write: () => assert.fail('protected offhand door placement must not be sent') };
  offhandBot.blockAt = (position) => {
    if (sameTestPosition(position, reference)) return liveBlock('stone', reference);
    if (sameTestPosition(position, primary)) return liveBlock('air', primary);
    if (sameTestPosition(position, upper)) return liveBlock('air', upper);
    return liveBlock('air', position);
  };
  offhandBot._genericPlace = async () => {
    offhandBot._client.write('block_place', { location: reference, direction: 1, hand: 1 });
  };
  installWorldActionBoundary(offhandBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(upper),
  });
  await assert.rejects(
    offhandBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), { offhand: true }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const allowedReference = pos(92, 64, 80);
  const allowedPrimary = pos(92, 65, 80);
  const allowedUpper = pos(92, 66, 80);
  const allowedWrites = [];
  const allowedBot = makeBot();
  allowedBot.registry = { blocksByName: { oak_door: {} } };
  allowedBot.heldItem = { name: 'oak_door' };
  allowedBot._client = { write: (name, packet) => { allowedWrites.push({ name, packet }); } };
  allowedBot.blockAt = (position) => {
    if (sameTestPosition(position, allowedReference)) return liveBlock('stone', allowedReference);
    if (sameTestPosition(position, allowedPrimary)) return liveBlock('air', allowedPrimary);
    if (sameTestPosition(position, allowedUpper)) return liveBlock('air', allowedUpper);
    return liveBlock('air', position);
  };
  allowedBot._genericPlace = async () => {
    allowedBot._client.write('block_place', { location: allowedReference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(allowedBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await allowedBot._genericPlace(liveBlock('stone', allowedReference), pos(0, 1, 0), {});
  assert.equal(allowedWrites.length, 1, 'valid unprotected multi-cell placement remains permitted');
});

test('placing into one half of a double-height plant protects its counterpart', async () => {
  const reference = pos(95, 64, 80);
  const lower = pos(95, 65, 80);
  const upper = pos(95, 66, 80);
  const blocks = new Map([
    ['95,64,80', liveBlock('stone', reference)],
    ['95,65,80', liveBlock('tall_grass', lower, { half: 'lower' })],
    ['95,66,80', liveBlock('tall_grass', upper, { half: 'upper' })],
  ]);
  const bot = makeBot();
  bot.registry = { blocksByName: { dirt: {} } };
  bot.heldItem = { name: 'dirt' };
  bot._client = { write: () => assert.fail('protected replacement counterpart must not be sent') };
  bot.blockAt = (position) => blocks.get(`${position.x},${position.y},${position.z}`)
    || liveBlock('air', position);
  bot._genericPlace = async () => {
    bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(upper),
  });
  await assert.rejects(
    bot._genericPlace(blocks.get('95,64,80'), pos(0, 1, 0), {}),
    { code: 'WORLD_ACTION_DENIED' },
  );
});

test('chest placement protects every adjacent cell that could merge into a double chest', async () => {
  const reference = pos(96, 64, 80);
  const target = pos(96, 65, 80);
  const protectedNeighbor = pos(97, 65, 80);
  const bot = makeBot();
  bot.registry = { blocksByName: { chest: {} } };
  bot.heldItem = { name: 'chest' };
  bot._client = { write: () => assert.fail('protected chest merge must not be sent') };
  bot.blockAt = (position) => {
    if (sameTestPosition(position, reference)) return liveBlock('stone', reference);
    if (sameTestPosition(position, protectedNeighbor)) {
      return liveBlock('chest', protectedNeighbor, { type: 'single', facing: 'north' });
    }
    return liveBlock('air', position);
  };
  bot._genericPlace = async () => {
    bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(protectedNeighbor),
  });

  await assert.rejects(
    bot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    { code: 'WORLD_ACTION_DENIED' },
  );
});

test('hopper placement cannot pull from or output into an unowned adjacent container', async () => {
  const reference = pos(97, 64, 80);
  const adjacentChest = pos(97, 66, 80);
  const makeHopperBot = (ctx) => {
    const bot = makeBot();
    bot.registry = { blocksByName: { hopper: {} } };
    bot.heldItem = { name: 'hopper' };
    bot._client = { write: () => assert.fail('unauthorized hopper placement must not be sent') };
    bot.blockAt = (position) => {
      if (sameTestPosition(position, reference)) return liveBlock('stone', reference);
      if (sameTestPosition(position, adjacentChest)) return liveBlock('chest', adjacentChest);
      return liveBlock('air', position);
    };
    bot._genericPlace = async () => {
      bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
    };
    installWorldActionBoundary(bot, ctx);
    return bot;
  };

  const unownedBot = makeHopperBot({
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await assert.rejects(
    unownedBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /unowned anchor or dependency/.test(error.message),
  );

  const protectedBot = makeHopperBot({
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: adjacentChest,
        dimension: 'overworld',
      }],
    }),
    worldModel: protectedModel(adjacentChest),
  });
  await assert.rejects(
    protectedBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /do-not-touch regions exist/.test(error.message),
  );

  const minecartBot = makeHopperBot({
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  minecartBot.blockAt = (position) => (
    sameTestPosition(position, reference)
      ? liveBlock('stone', reference)
      : liveBlock('air', position)
  );
  minecartBot.entities = {
    88: {
      id: 88,
      name: 'chest_minecart',
      type: 'object',
      position: pos(97, 66, 80),
    },
  };
  await assert.rejects(
    minecartBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /autonomous container output provenance/.test(error.message),
  );
});

test('dispenser and dropper placement cannot defer effects past target authorization', async () => {
  const reference = pos(98, 64, 82);
  const outputNeighbor = pos(99, 65, 82);
  const makeAutonomousContainerBot = (blockName, ctx, neighborName = 'air') => {
    const bot = makeBot();
    bot.registry = { blocksByName: { [blockName]: {} } };
    bot.heldItem = { name: blockName };
    bot._client = { write: () => assert.fail(`${blockName} placement must not be sent`) };
    bot.blockAt = (position) => {
      if (sameTestPosition(position, reference)) return liveBlock('stone', reference);
      if (sameTestPosition(position, outputNeighbor)) return liveBlock(neighborName, outputNeighbor);
      return liveBlock('air', position);
    };
    bot._genericPlace = async () => {
      bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
    };
    installWorldActionBoundary(bot, ctx);
    return bot;
  };

  const dispenserBot = makeAutonomousContainerBot('dispenser', {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(outputNeighbor),
  });
  await assert.rejects(
    dispenserBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /do-not-touch regions exist/.test(error.message),
  );

  const dropperBot = makeAutonomousContainerBot('dropper', {
    worldActionAuthorization: createWorldActionAuthorization(),
  }, 'chest');
  await assert.rejects(
    dropperBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /unowned anchor or dependency/.test(error.message),
  );

  const clearBot = makeAutonomousContainerBot('dispenser', {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await assert.rejects(
    clearBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /autonomous container output provenance/.test(error.message),
  );
});

test('unmodeled explosive actuator summoning and unknown block placements fail closed', async () => {
  const reference = pos(99, 64, 84);
  const target = pos(99, 65, 84);
  for (const blockName of [
    'tnt', 'piston', 'sticky_piston', 'redstone_block', 'redstone_torch',
    'wither_skeleton_skull', 'carved_pumpkin', 'respawn_anchor',
    'grass_block', 'mycelium', 'dripstone_block',
    'unknown_mod_block',
  ]) {
    const bot = makeBot();
    bot.registry = { blocksByName: { [blockName]: {} } };
    bot.heldItem = { name: blockName };
    bot._client = { write: () => assert.fail(`${blockName} placement must not be sent`) };
    bot.blockAt = (position) => (
      sameTestPosition(position, reference)
        ? liveBlock('stone', reference)
        : liveBlock('air', position)
    );
    bot._genericPlace = async () => {
      bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    await assert.rejects(
      bot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
      (error) => error?.code === 'WORLD_ACTION_DENIED'
        && /placement effect is not explicitly modeled/.test(error.message),
      blockName,
    );
  }
});

test('bed and respawn-anchor activation fail closed until explosion footprints are modeled', async () => {
  for (const [index, blockName] of ['red_bed', 'respawn_anchor'].entries()) {
    const target = pos(101 + index, 64, 84);
    const block = liveBlock(blockName, target);
    const bot = makeBot();
    bot.registry = { blocksByName: {} };
    bot._client = { write: () => assert.fail(`${blockName} activation must not be sent`) };
    bot.blockAt = exactBlockAt(block);
    bot.activateBlock = async () => {
      bot._client.write('block_place', { location: target, direction: 1, hand: 0 });
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    await assert.rejects(
      bot.activateBlock(block),
      (error) => error?.code === 'WORLD_ACTION_DENIED'
        && /dimension-dependent explosion/.test(error.message),
      blockName,
    );
  }
});

test('unmodeled passive controls and held-block activation cannot trigger redstone effects', async () => {
  for (const [index, fixture] of [
    { blockName: 'lever', itemName: null },
    { blockName: 'oak_button', itemName: null },
    { blockName: 'lever', itemName: 'dirt' },
    { blockName: 'lever', itemName: 'iron_axe' },
  ].entries()) {
    const target = pos(105 + index, 64, 84);
    const block = liveBlock(fixture.blockName, target);
    const bot = makeBot();
    bot.registry = { blocksByName: fixture.itemName === 'dirt' ? { dirt: {} } : {} };
    if (fixture.itemName) bot.heldItem = { name: fixture.itemName };
    bot._client = { write: () => assert.fail(`${fixture.blockName} activation must not be sent`) };
    bot.blockAt = exactBlockAt(block);
    bot.activateBlock = async () => {
      bot._client.write('block_place', { location: target, direction: 1, hand: 0 });
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    await assert.rejects(bot.activateBlock(block, pos(0, 1, 0)), {
      code: 'WORLD_ACTION_DENIED',
    });
  }
});

test('modeled placement and tool mutations fail closed when observers could reach DNT', async () => {
  const reference = pos(109, 64, 84);
  const target = pos(109, 65, 84);
  const protectedTnt = pos(115, 64, 84);
  const placementBot = makeBot();
  placementBot.registry = { blocksByName: { stone: {} } };
  placementBot.heldItem = { name: 'stone' };
  placementBot._client = { write: () => assert.fail('observer-triggering placement must not be sent') };
  placementBot.blockAt = (position) => (
    sameTestPosition(position, reference)
      ? liveBlock('stone', reference)
      : liveBlock('air', position)
  );
  placementBot._genericPlace = async () => {
    placementBot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(placementBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(protectedTnt),
  });
  await assert.rejects(
    placementBot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {}),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /redstone effects cannot be bounded/.test(error.message),
  );

  const log = liveBlock('oak_log', pos(110, 64, 84));
  const toolBot = makeBot();
  toolBot.registry = { blocksByName: {} };
  toolBot.heldItem = { name: 'iron_axe' };
  toolBot.blockAt = exactBlockAt(log);
  toolBot._client = { write: () => assert.fail('observer-triggering tool mutation must not be sent') };
  toolBot.activateBlock = async () => {
    toolBot._client.write('block_place', { location: log.position, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(toolBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(protectedTnt),
  });
  await assert.rejects(
    toolBot.activateBlock(log),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /redstone effects cannot be bounded/.test(error.message),
  );
});

test('single-cell main-hand placement remains permitted with readable live geometry', async () => {
  const reference = pos(98, 64, 80);
  const target = pos(98, 65, 80);
  const writes = [];
  const bot = makeBot();
  bot.registry = { blocksByName: { dirt: {} } };
  bot.heldItem = { name: 'dirt' };
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = (position) => (
    sameTestPosition(position, reference) ? liveBlock('stone', reference) : liveBlock('air', position)
  );
  bot._genericPlace = async () => {
    bot._client.write('block_place', { location: reference, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await bot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), {});
  assert.equal(writes.length, 1);
});

test('placement invocations fail closed on unknown item geometry or mismatched packet hand', async () => {
  const reference = pos(100, 64, 80);
  const target = pos(100, 65, 80);
  const makePlacementBot = ({ heldItem, offhandItem, options, packetHand }) => {
    const bot = makeBot();
    bot.registry = { blocksByName: { oak_door: {} } };
    bot.heldItem = heldItem;
    bot.inventory = {
      id: 0,
      hotbarStart: 36,
      slots: { 36: heldItem, 45: offhandItem },
    };
    bot.blockAt = (position) => (
      sameTestPosition(position, reference) ? liveBlock('stone', reference) : liveBlock('air', position)
    );
    bot._client = { write: () => assert.fail('unknown placement geometry must not be sent') };
    bot._genericPlace = async () => {
      bot._client.write('block_place', { location: reference, direction: 1, hand: packetHand });
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    return { bot, options };
  };

  const unknown = makePlacementBot({
    heldItem: { name: 'stick' },
    offhandItem: null,
    options: { offhand: false },
    packetHand: 0,
  });
  await assert.rejects(
    unknown.bot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), unknown.options),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const mismatched = makePlacementBot({
    heldItem: { name: 'stick' },
    offhandItem: { name: 'oak_door' },
    options: { offhand: true },
    packetHand: 0,
  });
  await assert.rejects(
    mismatched.bot._genericPlace(liveBlock('stone', reference), pos(0, 1, 0), mismatched.options),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const malformedHand = makePlacementBot({
    heldItem: { name: 'oak_door' },
    offhandItem: { name: 'oak_door' },
    options: { offhand: false },
    packetHand: 2,
  });
  await assert.rejects(
    malformedHand.bot._genericPlace(
      liveBlock('stone', reference),
      pos(0, 1, 0),
      malformedHand.options,
    ),
    { code: 'WORLD_ACTION_DENIED' },
  );
});

test('packet-adjacent dig guard allows cancellation and safely aborts a denied finish', async () => {
  const target = pos(40, 64, 40);
  let current = liveBlock('stone', target);
  const writes = [];
  let aborts = 0;
  let localCompletions = 0;
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = (position) => (
    sameTestPosition(position, target) ? current : liveBlock('air', position)
  );
  bot._updateBlockState = () => { localCompletions += 1; };
  bot.dig = async (block) => {
    bot.targetDigBlock = block;
    bot.stopDigging = () => {
      bot._client.write('block_dig', { status: 1, location: target, face: 1 });
      bot.targetDigBlock = null;
      aborts += 1;
    };
    current = liveBlock('chest', target, { type: 'single', facing: 'north' });
    bot._client.write('block_dig', { status: 2, location: target, face: 1 });
    bot._updateBlockState(target, 0);
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  await bot.dig(liveBlock('stone', target));
  assert.deepEqual(writes.map(({ packet }) => packet.status), [1]);
  assert.equal(aborts, 1);
  assert.equal(localCompletions, 0);
});

test('authorized block windows are rebound by object identity and reauthorized on every click', async () => {
  const target = pos(50, 64, 50);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const makeAuthorizedChestBot = () => {
    const writes = [];
    const bot = makeBot({ worldIdentity: 'world-a' });
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.blockAt = exactBlockAt(chest);
    bot.registry = { blocksByName: { stone: {} } };
    let placeDelegations = 0;
    bot.placeBlock = async () => { placeDelegations += 1; };
    const window = {
      id: 9,
      type: 'minecraft:generic_9x3',
      inventoryEnd: 63,
      slots: Array(63).fill(null),
    };
    bot.openBlock = async (block) => openWindowFromBlock(bot, block, window);
    bot.openContainer = async (block) => bot.openBlock(block);
    const ctx = {
      worldActionAuthorization: createWorldActionAuthorization({
        operatorAnchors: [{
          kind: 'storage',
          blockName: 'chest',
          position: target,
          dimension: 'overworld',
          worldIdentity: 'world-a',
        }],
      }),
    };
    installWorldActionBoundary(bot, ctx);
    return {
      bot,
      ctx,
      window,
      writes,
      placeDelegations: () => placeDelegations,
    };
  };

  const legitimate = makeAuthorizedChestBot();
  await legitimate.bot.openContainer(chest);
  await legitimate.bot.clickWindow(0, 0, 0);
  assert.equal(
    legitimate.writes.filter(({ name }) => name === 'window_click').length,
    1,
    'the exact owned current window remains usable',
  );

  const malformed = makeAuthorizedChestBot();
  await malformed.bot.openContainer(chest);
  malformed.bot.currentWindow = { id: 9 };
  await assert.rejects(malformed.bot.clickWindow(0, 0, 0), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(malformed.writes.filter(({ name }) => name === 'window_click').length, 0);
  assert.equal(malformed.bot.currentWindow, null);
  await assert.rejects(
    malformed.bot.openContainer(chest),
    (error) => error?.code === 'WORLD_ACTION_DENIED' && /provenance is tainted/.test(error.message),
  );

  const protectedWindow = makeAuthorizedChestBot();
  await protectedWindow.bot.openContainer(chest);
  protectedWindow.ctx.worldModel = protectedModel(target);
  await assert.rejects(
    protectedWindow.bot.clickWindow(0, 0, 0),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(protectedWindow.writes.filter(({ name }) => name === 'window_click').length, 0);
  assert.equal(
    protectedWindow.bot.currentWindow,
    null,
    'denied optimistic window state is synchronously closed',
  );
  protectedWindow.bot.heldItem = { name: 'stone' };
  await assert.rejects(
    protectedWindow.bot.placeBlock(chest, pos(0, 1, 0)),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /authoritative readback/.test(error.message),
  );
  assert.equal(
    protectedWindow.placeDelegations(),
    0,
    'a rejected delegated click taints later held-item authority',
  );

  const wrongId = makeAuthorizedChestBot();
  await wrongId.bot.openContainer(chest);
  assert.throws(
    () => wrongId.bot._client.write('window_click', { windowId: 10, slot: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(wrongId.writes.filter(({ name }) => name === 'window_click').length, 0);
  assert.equal(wrongId.bot.currentWindow, null, 'a different window id cannot reuse the open lease');

  const unbound = makeBot({ worldIdentity: 'world-a' });
  const unboundWrites = [];
  unbound._client = { write: (name, packet) => { unboundWrites.push({ name, packet }); } };
  unbound.currentWindow = {
    id: 10,
    type: 'minecraft:generic_9x3',
    inventoryEnd: 63,
    slots: Array(63).fill(null),
  };
  installWorldActionBoundary(unbound, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(
    () => unbound._client.write('window_click', { windowId: 10, slot: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(
    unboundWrites.filter(({ name }) => name === 'window_click').length,
    0,
    'unbound non-inventory windows fail closed',
  );
  assert.equal(unbound.currentWindow, null);
});

test('a rejected physical click after optimistic local mutation taints later item authority', async () => {
  const target = pos(50, 64, 51);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  let current = chest;
  const item = { name: 'cobblestone', type: 1, count: 1 };
  const window = {
    id: 90,
    type: 'minecraft:generic_9x3',
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: Array(63).fill(null),
    selectedItem: null,
  };
  window.slots[0] = item;
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot.registry = { blocksByName: { stone: {} } };
  bot.blockAt = (position) => (
    sameTestPosition(position, target) ? current : liveBlock('air', position)
  );
  bot._client = { write() {} };
  bot.openContainer = async (block) => openWindowFromBlock(bot, block, window);
  bot.clickWindow = async () => {
    window.selectedItem = window.slots[0];
    window.slots[0] = null;
    bot._client.write('window_click', {
      windowId: window.id,
      slot: 0,
      mouseButton: 0,
      mode: 0,
      changedSlots: [{ location: 0, item: null }],
    });
  };
  let placeDelegations = 0;
  bot.placeBlock = async () => { placeDelegations += 1; };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage', blockName: 'chest', position: target,
        dimension: 'overworld', worldIdentity: 'world-a',
      }],
    }),
  });

  await bot.openContainer(chest);
  current = liveBlock('stone', target);
  await assert.rejects(bot.clickWindow(0, 0, 0), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(window.slots[0], null, 'the fake reproduces Mineflayer optimistic local mutation');
  assert.equal(bot.currentWindow, null);

  bot.heldItem = { name: 'stone' };
  await assert.rejects(
    bot.placeBlock(current, pos(0, 1, 0)),
    (error) => error?.code === 'WORLD_ACTION_DENIED'
      && /authoritative readback/.test(error.message),
  );
  assert.equal(placeDelegations, 0);
});

test('event-bound Mineflayer withdraw uses a per-transfer capability for its lexical raw clicks', async () => {
  const target = pos(51, 64, 50);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  const client = new EventEmitter();
  client.write = (name, packet) => { writes.push({ name, packet }); };
  bot._client = client;
  bot.blockAt = exactBlockAt(chest);
  const item = { name: 'cobblestone', type: 1, metadata: 0, count: 1, stackSize: 64 };
  const window = {
    id: 91,
    type: 'minecraft:generic_9x3',
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: Array(63).fill(null),
    selectedItem: null,
  };
  window.slots[0] = item;
  // This deliberately mirrors Mineflayer 4.37.1's lexical transfer ->
  // lexical clickWindow path: it writes packets without calling bot.clickWindow.
  window.withdraw = async function lexicalWithdraw() {
    this.selectedItem = this.slots[0];
    this.slots[0] = null;
    bot._client.write('window_click', {
      windowId: this.id,
      slot: 0,
      mouseButton: 0,
      mode: 0,
      changedSlots: [{ location: 0, item: null }],
    });
    this.slots[this.inventoryStart] = this.selectedItem;
    this.selectedItem = null;
    bot._client.write('window_click', {
      windowId: this.id,
      slot: this.inventoryStart,
      mouseButton: 0,
      mode: 0,
      changedSlots: [{ location: this.inventoryStart, item }],
    });
  };
  bot.openContainer = async (block) => openWindowFromBlock(bot, block, window);
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });

  const opened = await bot.openContainer(chest);
  await opened.withdraw(1, null, 1, null);
  assert.deepEqual(
    writes.map(({ name }) => name),
    ['block_place', 'window_click', 'window_click'],
  );
  assert.equal(opened.slots[0], null);
  assert.equal(opened.slots[opened.inventoryStart], item);

  assert.throws(() => bot._client.write('window_click', {
    windowId: opened.id,
    slot: 1,
    mouseButton: 0,
    mode: 0,
    changedSlots: [],
  }), { code: 'WORLD_ACTION_DENIED' });
});

test('pinned Mineflayer inventory transfer path works for trusted chest and furnace windows', async () => {
  const injectInventory = require('mineflayer/lib/plugins/inventory.js');
  const injectFurnace = require('mineflayer/lib/plugins/furnace.js');
  const mcData = require('minecraft-data')('1.21.1');
  const Item = require('prismarine-item')(mcData);
  const { Vec3 } = require('vec3');
  const feature = new Set([
    'stateIdUsed',
    'useItemWithOwnPacket',
    'blockPlaceHasInsideBlock',
  ]);

  const runCase = async ({ blockName, windowType, operation }) => {
    const target = new Vec3(blockName === 'chest' ? 60 : 61, 64, 60);
    const block = {
      name: blockName,
      position: target,
      getProperties: () => blockName === 'chest'
        ? ({ type: 'single', facing: 'north' })
        : ({}),
    };
    const bot = new EventEmitter();
    const client = new EventEmitter();
    const writes = [];
    Object.assign(bot, {
      username: 'MCBot',
      worldIdentity: 'world-a',
      version: '1.21.1',
      registry: mcData,
      QUICK_BAR_START: 36,
      entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: true },
      players: { MCBot: { username: 'MCBot' } },
      game: { dimension: 'overworld', gameMode: 'survival' },
      supportFeature: (name) => feature.has(name),
      getControlState: () => false,
      world: { getColumn: () => ({ loaded: true }) },
      findBlocks: () => [],
      lookAt: async () => {},
      swingArm: () => {},
      blockAt: exactBlockAt(block),
      _client: client,
    });
    const windowId = blockName === 'chest' ? 101 : 102;
    client.write = (name, packet) => {
      writes.push({ name, packet });
      if (name !== 'block_place') return;
      queueMicrotask(() => {
        client.emit('open_window', {
          windowId,
          inventoryType: windowType,
          windowTitle: blockName,
          slotCount: blockName === 'chest' ? 27 : 3,
        });
        bot.emit(`setWindowItems:${windowId}`);
      });
    };
    injectInventory(bot, { hideErrors: false });
    if (blockName === 'furnace') injectFurnace(bot, {});
    bot.quickBarSlot = 0;
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization({
        operatorAnchors: [{
          kind: blockName === 'chest' ? 'storage' : 'workstation',
          blockName,
          position: target,
          dimension: 'overworld',
          worldIdentity: 'world-a',
        }],
      }),
    });

    const window = blockName === 'furnace'
      ? await bot.openFurnace(block)
      : await bot.openBlock(block);
    const item = new Item(mcData.itemsByName.cobblestone.id, 1);
    if (operation === 'withdraw') {
      window.updateSlot(0, item);
      await window.withdraw(item.type, null, 1, null);
    } else {
      window.updateSlot(window.inventoryStart, item);
      await window.putInput(item.type, null, 1);
    }
    assert.equal(
      writes.filter(({ name }) => name === 'window_click').length,
      2,
      `${blockName} used Mineflayer's real lexical click path`,
    );
    window.close();
    assert.equal(
      writes.filter(({ name }) => name === 'close_window').length,
      1,
      `${blockName} used Mineflayer's real lexical close path`,
    );
    const reopened = blockName === 'furnace'
      ? await bot.openFurnace(block)
      : await bot.openBlock(block);
    assert.throws(() => client.write('window_click', {
      windowId,
      slot: 0,
      mouseButton: 0,
      mode: 0,
      changedSlots: [],
    }), { code: 'WORLD_ACTION_DENIED' });
    bot.currentWindow = { id: windowId, type: windowType, slots: reopened.slots };
    await assert.rejects(
      reopened.withdraw(item.type, null, 1, null),
      { code: 'WORLD_ACTION_DENIED' },
    );
  };

  await runCase({
    blockName: 'chest',
    windowType: 'minecraft:generic_9x3',
    operation: 'withdraw',
  });
  await runCase({
    blockName: 'furnace',
    windowType: 'minecraft:furnace',
    operation: 'putInput',
  });
});

test('window transfer and trapped-chest access fail closed when effects cannot be bounded', async () => {
  const target = pos(51, 64, 51);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const trappedTarget = pos(52, 64, 51);
  const trapped = liveBlock('trapped_chest', trappedTarget, { type: 'single', facing: 'north' });
  const window = {
    id: 92,
    type: 'minecraft:generic_9x3',
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: Array(63).fill(null),
    withdraw: async () => {
      throw new Error('the denied transfer delegate must not execute');
    },
  };
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write() {} };
  bot.blockAt = exactBlockAt(chest);
  bot.openContainer = async (block) => openWindowFromBlock(bot, block, window);
  const ctx = {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [
        {
          kind: 'storage', blockName: 'chest', position: target,
          dimension: 'overworld', worldIdentity: 'world-a',
        },
      ],
    }),
  };
  installWorldActionBoundary(bot, ctx);

  const opened = await bot.openContainer(chest);
  ctx.worldModel = protectedModel(pos(500, 64, 500));
  await assert.rejects(opened.withdraw(1, null, 1, null), { code: 'WORLD_ACTION_DENIED' });

  const trappedBot = makeBot({ worldIdentity: 'world-a' });
  trappedBot._client = { write() {} };
  trappedBot.blockAt = exactBlockAt(trapped);
  trappedBot.openContainer = async (block) => openWindowFromBlock(trappedBot, block, {
    ...window,
    id: 93,
    slots: Array(63).fill(null),
  });
  installWorldActionBoundary(trappedBot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage', blockName: 'trapped_chest', position: trappedTarget,
        dimension: 'overworld', worldIdentity: 'world-a',
      }],
    }),
  });
  await assert.rejects(trappedBot.openContainer(trapped), { code: 'WORLD_ACTION_DENIED' });
});

test('autonomous windows and adjacent unowned transfer/redstone topology deny trusted container access', async () => {
  for (const [name, kind] of [
    ['hopper', 'storage'],
    ['dropper', 'storage'],
    ['dispenser', 'storage'],
    ['crafter', 'workstation'],
  ]) {
    const target = pos(53, 64, 53);
    const block = liveBlock(name, target);
    const bot = makeBot({ worldIdentity: 'world-a' });
    bot.blockAt = exactBlockAt(block);
    bot._client = { write: () => assert.fail(`${name} open packet must not be sent`) };
    bot.openBlock = async (current) => openWindowFromBlock(bot, current, {
      id: 120, type: `minecraft:${name}`, inventoryStart: 5, inventoryEnd: 41, slots: Array(41).fill(null),
    });
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization({
        operatorAnchors: [{
          kind, blockName: name, position: target,
          dimension: 'overworld', worldIdentity: 'world-a',
        }],
      }),
    });
    await assert.rejects(bot.openBlock(block), { code: 'WORLD_ACTION_DENIED' });
  }

  const target = pos(54, 64, 53);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const hopper = liveBlock('hopper', pos(54, 63, 53));
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot.blockAt = (position) => {
    if (sameTestPosition(position, target)) return chest;
    if (sameTestPosition(position, hopper.position)) return hopper;
    return liveBlock('air', position);
  };
  bot._client = { write: () => assert.fail('chest-over-hopper open packet must not be sent') };
  bot.openContainer = async (current) => openWindowFromBlock(bot, current, {
    id: 121, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63,
    slots: Array(63).fill(null),
  });
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage', blockName: 'chest', position: target,
        dimension: 'overworld', worldIdentity: 'world-a',
      }],
    }),
  });
  await assert.rejects(bot.openContainer(chest), { code: 'WORLD_ACTION_DENIED' });

  const entityBot = makeBot({ worldIdentity: 'world-a' });
  entityBot.entities = {
    81: {
      id: 81,
      name: 'hopper_minecart',
      type: 'object',
      position: pos(54, 63, 53),
      metadata: [],
      equipment: [],
    },
  };
  entityBot.blockAt = (position) => (sameTestPosition(position, target)
    ? chest
    : liveBlock('air', position));
  entityBot._client = { write: () => assert.fail('entity-hopper-adjacent open must not be sent') };
  entityBot.openContainer = async (current) => openWindowFromBlock(entityBot, current, {
    id: 123, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63,
    slots: Array(63).fill(null),
  });
  installWorldActionBoundary(entityBot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage', blockName: 'chest', position: target,
        dimension: 'overworld', worldIdentity: 'world-a',
      }],
    }),
  });
  await assert.rejects(entityBot.openContainer(chest), { code: 'WORLD_ACTION_DENIED' });
});

test('raw protocol byte writes are denied while classified typed writes still use the normal client path', () => {
  const bot = makeBot();
  const typedWrites = [];
  const rawWrites = [];
  bot._client = {
    write(name, packet) { typedWrites.push({ name, packet }); },
    writeRaw(buffer) { rawWrites.push(buffer); },
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  bot._client.write('arm_animation', { hand: 0 });
  assert.equal(typedWrites.length, 1);
  assert.throws(() => bot._client.writeRaw(Buffer.from([0x00])), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.equal(rawWrites.length, 0);
});

test('outside-window item drops and cursor-bearing closes fail closed', async () => {
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot.inventory.slots = Array(46).fill({ name: 'stone', type: 1, count: 64 });
  bot._client = { write() {} };
  await assert.rejects(async () => {
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    await bot.clickWindow(-999, 0, 0);
  }, { code: 'WORLD_ACTION_DENIED' });

  const target = pos(55, 64, 53);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const window = {
    id: 122,
    type: 'minecraft:generic_9x3',
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: Array(63).fill(null),
    selectedItem: { name: 'diamond', type: 4, count: 1 },
  };
  const closeBot = makeBot({ worldIdentity: 'world-a' });
  closeBot.blockAt = exactBlockAt(chest);
  const closeWrites = [];
  closeBot._client = {
    write(name, packet) { closeWrites.push({ name, packet }); },
  };
  closeBot.openContainer = async (block) => openWindowFromBlock(closeBot, block, window);
  let closeDelegations = 0;
  closeBot.closeWindow = async (opened) => {
    closeDelegations += 1;
    closeBot._client.write('close_window', { windowId: opened.id });
  };
  installWorldActionBoundary(closeBot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage', blockName: 'chest', position: target,
        dimension: 'overworld', worldIdentity: 'world-a',
      }],
    }),
  });
  const unhandled = [];
  const noteUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', noteUnhandled);
  try {
    await closeBot.openContainer(chest);
    const writesBeforeDeniedClick = closeWrites.length;
    const deniedClick = closeBot.clickWindow(0, 0, 4);
    assert.equal(closeBot.currentWindow, null, 'denied cleanup clears the local window synchronously');
    await assert.rejects(deniedClick, { code: 'WORLD_ACTION_DENIED' });
    assert.equal(closeDelegations, 0, 'cursor-bearing cleanup must not attempt a physical close');
    assert.equal(closeWrites.length, writesBeforeDeniedClick, 'denied cleanup must not add a packet write');
    assert.equal(closeWrites.filter(({ name }) => name === 'close_window').length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'denied cleanup must not leak a rejected promise');
    await assert.rejects(
      closeBot.openContainer(chest),
      (error) => error?.code === 'WORLD_ACTION_DENIED' && /provenance is tainted/.test(error.message),
    );

    const asyncWindow = {
      ...window,
      id: 123,
      slots: Array(63).fill(null),
      selectedItem: null,
    };
    const asyncCloseBot = makeBot({ worldIdentity: 'world-a' });
    asyncCloseBot.blockAt = exactBlockAt(chest);
    const asyncCloseWrites = [];
    asyncCloseBot._client = {
      write(name, packet) { asyncCloseWrites.push({ name, packet }); },
    };
    asyncCloseBot.openContainer = async (block) => openWindowFromBlock(asyncCloseBot, block, asyncWindow);
    let asyncCloseDelegations = 0;
    asyncCloseBot.closeWindow = async () => {
      asyncCloseDelegations += 1;
      throw new Error('simulated asynchronous close failure');
    };
    installWorldActionBoundary(asyncCloseBot, {
      worldActionAuthorization: createWorldActionAuthorization({
        operatorAnchors: [{
          kind: 'storage', blockName: 'chest', position: target,
          dimension: 'overworld', worldIdentity: 'world-a',
        }],
      }),
    });
    await asyncCloseBot.openContainer(chest);
    const asyncWritesBeforeDeniedClick = asyncCloseWrites.length;
    const asyncDeniedClick = asyncCloseBot.clickWindow(0, 0, 4);
    assert.equal(asyncCloseBot.currentWindow, null);
    await assert.rejects(asyncDeniedClick, { code: 'WORLD_ACTION_DENIED' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asyncCloseDelegations, 1);
    assert.equal(asyncCloseWrites.length, asyncWritesBeforeDeniedClick);
    assert.equal(asyncCloseWrites.filter(({ name }) => name === 'close_window').length, 0);
    assert.deepEqual(unhandled, [], 'asynchronous cleanup rejection must be consumed');
    await assert.rejects(
      asyncCloseBot.openContainer(chest),
      (error) => error?.code === 'WORLD_ACTION_DENIED' && /provenance is tainted/.test(error.message),
    );
  } finally {
    process.off('unhandledRejection', noteUnhandled);
  }
  await assert.rejects(closeBot.closeWindow(window), { code: 'WORLD_ACTION_DENIED' });
});

test('another player joining after a natural container opens revokes its next slot mutation', async () => {
  const target = pos(52, 64, 52);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const window = {
    id: 11, type: 'minecraft:chest', inventoryEnd: 63, slots: Array(63).fill(null),
  };
  const writes = [];
  const bot = makeBot({ worldIdentity: 'fresh-world' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  const observedWorldIdentity = observeFixtureWorld(bot);
  bot.blockAt = exactBlockAt(chest);
  bot.openContainer = async (block) => openWindowFromBlock(bot, block, window);
  const state = createWorldActionAuthorization({
    mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
    sessionIdentity: 'fixture-session',
    freshWorldIdentity: observedWorldIdentity,
    createdFreshWorld: true,
    singlePlayer: true,
  });
  installWorldActionBoundary(bot, { worldActionAuthorization: state });

  await bot.openContainer(chest);
  bot.players.Alex = { username: 'Alex' };
  bot.emit('playerJoined', bot.players.Alex);

  assert.equal(state.disposableTrustRevoked, true);
  await assert.rejects(
    bot.clickWindow(0, 0, 0),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(writes.filter(({ name }) => name === 'window_click').length, 0);
  assert.equal(bot.currentWindow, null);
});

test('table craft clicks retain one exact current window and revalidate the live table', async () => {
  const tablePosition = pos(55, 64, 55);
  const staleTable = liveBlock('crafting_table', tablePosition);
  const makeCraftBot = () => {
    let current = staleTable;
    const writes = [];
    const window = {
      id: 12,
      type: 'minecraft:crafting',
      inventoryEnd: 46,
      slots: Array(46).fill(null),
    };
    const bot = makeBot({ worldIdentity: 'world-a' });
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.blockAt = (position) => (
      sameTestPosition(position, tablePosition) ? current : liveBlock('air', position)
    );
    bot.activateBlock = async (block) => openWindowFromBlock(bot, block, window);
    bot.craft = async (recipe, _count, table) => {
      if (!table) {
        await bot.clickWindow(1, 0, 0);
        return;
      }
      await bot.activateBlock(table);
      if (recipe?.windowZero) {
        bot._client.write('window_click', {
          windowId: 0,
          slot: 1,
          mouseButton: 0,
          mode: 0,
          changedSlots: [],
        });
        return;
      }
      await bot.clickWindow(1, 0, 0);
      if (recipe?.substituteWindow) {
        bot.currentWindow = { id: 12 };
        await bot.clickWindow(2, 0, 0);
      }
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization({
        operatorAnchors: [{
          kind: 'workstation',
          blockName: 'crafting_table',
          position: tablePosition,
          dimension: 'overworld',
          worldIdentity: 'world-a',
        }],
      }),
    });
    return {
      bot,
      writes,
      setCurrent(block) { current = block; },
    };
  };

  const inventoryCraft = makeCraftBot();
  await inventoryCraft.bot.craft({}, 1, null);
  assert.equal(
    inventoryCraft.writes.filter(({ name }) => name === 'window_click').length,
    1,
    'inventory-only craft retains window id 0 access',
  );

  const substituted = makeCraftBot();
  await assert.rejects(
    substituted.bot.craft({ substituteWindow: true }, 1, staleTable),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(
    substituted.writes.filter(({ name }) => name === 'window_click').length,
    1,
    'the exact event-bound table window permits its first typed click',
  );
  assert.equal(substituted.bot.currentWindow, null);

  const windowZero = makeCraftBot();
  await assert.rejects(windowZero.bot.craft({ windowZero: true }, 1, staleTable), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.equal(windowZero.writes.filter(({ name }) => name === 'window_click').length, 0);

  const replacedTable = makeCraftBot();
  replacedTable.setCurrent(liveBlock('stone', tablePosition));
  await assert.rejects(replacedTable.bot.craft({}, 1, staleTable), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.equal(replacedTable.writes.length, 0, 'live table replacement denies before any packet');
});

test('unowned entity containers and spontaneous HorseWindow clicks fail closed', async () => {
  class Entity {
    constructor() {
      this.id = 1;
      this.metadata = [];
      this.equipment = [];
    }
  }
  class Horse extends Entity {}
  const entity = new Entity();
  const horse = new Horse();
  const window = { id: 14 };
  const writes = [];
  const bot = makeBot();
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = () => { throw new Error('entity containers must not query world blocks'); };
  bot.openEntity = async (target) => {
    assert.equal(target, entity);
    bot.currentWindow = window;
    return window;
  };
  bot.openContainer = async (target) => {
    assert.equal(target, entity);
    return bot.openEntity(target);
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  await assert.rejects(bot.openContainer(entity), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(bot.currentWindow ?? null, null);
  assert.equal(writes.length, 0);

  await assert.rejects(bot.openContainer(horse), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(bot.currentWindow ?? null, null);
  assert.equal(writes.length, 0);

  await assert.rejects(bot.openEntity(entity), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(bot.currentWindow ?? null, null);
  assert.equal(writes.length, 0);

  const horseWindow = { id: 15, type: 'HorseWindow' };
  bot.currentWindow = horseWindow;
  bot.emit('windowOpen', horseWindow);
  assert.throws(
    () => bot._client.write('window_click', { windowId: 15, slot: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(writes.length, 0);
});

test('entity attacks require an exact live hostile-mob capability and deny destructive targets', () => {
  const writes = [];
  const bot = makeBot();
  const zombie = { id: 42, name: 'zombie', type: 'mob', position: pos(2, 64, 0) };
  bot.entities = { 42: zombie };
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.attack = (target) => {
    bot._client.write('use_entity', { target: target.id, mouse: 1, sneaking: false });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  assert.throws(
    () => bot._client.write('use_entity', { target: 42, mouse: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(writes, []);

  assert.throws(
    () => bot._client.write('use_entity', { target: 42, mouse: 1, sneaking: false }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  bot.attack(zombie);
  assert.deepEqual(writes.map(({ name }) => name), ['use_entity']);

  for (const [index, name] of [
    'chest_minecart', 'hopper_minecart', 'chest_boat', 'horse',
    'armor_stand', 'item_frame', 'end_crystal', 'ender_dragon', 'silverfish',
  ].entries()) {
    const target = {
      id: 50 + index,
      name,
      type: ['horse', 'ender_dragon', 'silverfish'].includes(name) ? 'mob' : 'object',
      position: pos(3 + index, 64, 0),
    };
    bot.entities[target.id] = target;
    assert.throws(() => bot.attack(target), { code: 'WORLD_ACTION_DENIED' });
  }

  const protectedZombie = { id: 70, name: 'zombie', type: 'mob', position: pos(7, 64, 0) };
  bot.entities[protectedZombie.id] = protectedZombie;
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(protectedZombie.position),
  });
  assert.throws(() => bot.attack(protectedZombie), { code: 'WORLD_ACTION_DENIED' });
  assert.deepEqual(writes.map(({ name }) => name), ['use_entity']);
});

test('entity attack packets reject target substitution and stale entity identity', () => {
  const target = { id: 72, name: 'skeleton', type: 'mob', position: pos(2, 64, 1) };
  const replacement = { ...target };
  const bot = makeBot();
  bot.entities = { 72: target, 73: { ...target, id: 73 } };
  bot._client = { write: () => assert.fail('substituted entity attack must not be sent') };
  bot.attack = (entity) => {
    bot._client.write('use_entity', { target: entity.id + 1, mouse: 1, sneaking: false });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  assert.throws(() => bot.attack(target), { code: 'WORLD_ACTION_DENIED' });

  bot.attack = (entity) => {
    bot.entities[entity.id] = replacement;
    bot._client.write('use_entity', { target: entity.id, mouse: 1, sneaking: false });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  bot.entities[target.id] = target;
  assert.throws(() => bot.attack(target), { code: 'WORLD_ACTION_DENIED' });
});

test('sword and mace attacks fail closed before collateral can hit an entity container', () => {
  for (const itemName of ['iron_sword', 'mace']) {
    const target = { id: 80, name: 'warden', type: 'mob', position: pos(2, 64, 2) };
    const chestDonkey = {
      id: 81,
      name: 'donkey',
      type: 'mob',
      position: pos(2.5, 64, 2),
      metadata: [],
      equipment: [],
    };
    const bot = makeBot();
    bot.heldItem = { name: itemName };
    bot.entities = { 80: target, 81: chestDonkey };
    bot._client = { write: () => assert.fail(`${itemName} collateral attack must not be sent`) };
    bot.attack = (entity) => {
      bot._client.write('use_entity', { target: entity.id, mouse: 1, sneaking: false });
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    assert.throws(
      () => bot.attack(target),
      (error) => error?.code === 'WORLD_ACTION_DENIED'
        && /collateral attack footprint/.test(error.message),
      itemName,
    );
  }
});

test('silverfish attacks stay denied when their wake radius could reach protected blocks', () => {
  const silverfish = { id: 82, name: 'silverfish', type: 'mob', position: pos(2, 64, 2) };
  const bot = makeBot();
  bot.entities = { 82: silverfish };
  bot._client = { write: () => assert.fail('silverfish wake-chain attack must not be sent') };
  bot.attack = (entity) => {
    bot._client.write('use_entity', { target: entity.id, mouse: 1, sneaking: false });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(pos(12, 64, 2)),
  });
  assert.throws(() => bot.attack(silverfish), { code: 'WORLD_ACTION_DENIED' });
});

test('a returned block window without a packet-authorized windowOpen transition fails closed', async () => {
  const target = pos(57, 64, 57);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const window = { id: 13, type: 'minecraft:generic_9x3' };
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = exactBlockAt(chest);
  bot.openContainer = async () => {
    bot.currentWindow = window;
    return window;
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });

  await assert.rejects(bot.openContainer(chest), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(bot.currentWindow, null);
  assert.deepEqual(writes, []);
});

test('a pending authorized block open cannot lend its provenance to a HorseWindow', async () => {
  const target = pos(59, 64, 59);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const horseWindow = { id: 17, type: 'HorseWindow' };
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = exactBlockAt(chest);
  bot.openBlock = async () => {
    bot._client.write('block_place', { location: target, direction: 1, hand: 0 });
    bot.currentWindow = horseWindow;
    bot.emit('windowOpen', horseWindow);
    return horseWindow;
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });

  await assert.rejects(bot.openBlock(chest), { code: 'WORLD_ACTION_DENIED' });
  bot.currentWindow = horseWindow;
  assert.throws(
    () => bot._client.write('window_click', { windowId: 17, slot: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(writes.map(({ name }) => name), ['block_place']);
  assert.equal(bot.currentWindow, null);
});

test('a non-attack entity interaction cannot substitute a generic window during block open', async () => {
  const target = pos(59, 64, 58);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const genericEntityWindow = { id: 18, type: 'minecraft:generic_9x3' };
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = exactBlockAt(chest);
  let releaseDelayedWindow;
  bot.openBlock = async () => {
    bot._client.write('block_place', { location: target, direction: 1, hand: 0 });
    assert.throws(
      () => bot._client.write('use_entity', { target: 42, mouse: 1, sneaking: false }),
      { code: 'WORLD_ACTION_DENIED' },
    );
    assert.throws(
      () => bot._client.write('use_entity', { target: 42, mouse: 0 }),
      { code: 'WORLD_ACTION_DENIED' },
    );
    return new Promise((resolve) => {
      releaseDelayedWindow = () => {
        bot.currentWindow = genericEntityWindow;
        bot.emit('windowOpen', genericEntityWindow);
        resolve(genericEntityWindow);
      };
    });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });
  let immediateClickError = null;
  bot.on('windowOpen', (openedWindow) => {
    try {
      bot._client.write('window_click', { windowId: openedWindow.id, slot: 0 });
    } catch (error) {
      immediateClickError = error;
    }
  });

  const first = bot.openBlock(chest);
  assert.equal(typeof releaseDelayedWindow, 'function');
  await assert.rejects(
    bot.openBlock(chest),
    (error) => error?.code === 'WORLD_ACTION_DENIED' && /tainted/.test(error.message),
  );
  releaseDelayedWindow();
  await assert.rejects(first, { code: 'WORLD_ACTION_DENIED' });
  assert.equal(immediateClickError?.code, 'WORLD_ACTION_DENIED');
  bot.currentWindow = genericEntityWindow;
  assert.throws(
    () => bot._client.write('window_click', { windowId: 18, slot: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(writes.map(({ name }) => name), ['block_place']);
  assert.equal(bot.currentWindow, null);
});

test('a sent block open that fails before windowOpen quarantines later container opens', async () => {
  const target = pos(57, 64, 58);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = exactBlockAt(chest);
  bot.openBlock = async () => {
    bot._client.write('block_place', { location: target, direction: 1, hand: 0 });
    throw new Error('simulated open transport failure');
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });

  await assert.rejects(bot.openBlock(chest), /simulated open transport failure/);
  await assert.rejects(
    bot.openBlock(chest),
    (error) => error?.code === 'WORLD_ACTION_DENIED' && /tainted/.test(error.message),
  );
  assert.deepEqual(writes.map(({ name }) => name), ['block_place']);
});

test('an event-bound window is revoked if its open wrapper exits exceptionally', async () => {
  const target = pos(57, 64, 59);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
  const window = { id: 20, type: 'minecraft:chest' };
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = exactBlockAt(chest);
  bot.openBlock = async (block) => {
    openWindowFromBlock(bot, block, window);
    throw new Error('simulated post-window extension failure');
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });

  await assert.rejects(bot.openBlock(chest), /simulated post-window extension failure/);
  assert.equal(bot.currentWindow, null);
  assert.throws(
    () => bot._client.write('window_click', { windowId: 20, slot: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(writes.map(({ name }) => name), ['block_place']);
});

test('concurrent block opens cannot share or replace a pending window token', async () => {
  const target = pos(58, 64, 57);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'west' });
  const window = {
    id: 19, type: 'minecraft:chest', inventoryEnd: 63, slots: Array(63).fill(null),
  };
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = exactBlockAt(chest);
  let calls = 0;
  let releaseFirst;
  bot.openBlock = async () => {
    calls += 1;
    bot._client.write('block_place', { location: target, direction: 1, hand: 0 });
    if (calls !== 1) throw new Error('second open unexpectedly reached its delegate');
    return new Promise((resolve) => {
      releaseFirst = () => {
        bot.currentWindow = window;
        bot.emit('windowOpen', window);
        resolve(window);
      };
    });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });

  const first = bot.openBlock(chest);
  assert.equal(typeof releaseFirst, 'function');
  await assert.rejects(bot.openBlock(chest), { code: 'WORLD_ACTION_DENIED' });
  assert.deepEqual(writes.map(({ name }) => name), ['block_place']);

  releaseFirst();
  assert.equal(await first, window);
  await bot.clickWindow(0, 0, 0);
  assert.deepEqual(writes.map(({ name }) => name), ['block_place', 'window_click']);
});

test('raw openBlock binds the packet-authorized block window before any click', async () => {
  const target = pos(58, 64, 58);
  const chest = liveBlock('chest', target, { type: 'single', facing: 'west' });
  const window = {
    id: 16, type: 'minecraft:chest', inventoryEnd: 63, slots: Array(63).fill(null),
  };
  const writes = [];
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.blockAt = exactBlockAt(chest);
  bot.openBlock = async () => {
    bot._client.write('block_place', { location: target, direction: 1, hand: 0 });
    bot.currentWindow = window;
    bot.emit('windowOpen', window);
    return window;
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: target,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });

  assert.equal(await bot.openBlock(chest), window);
  await bot.clickWindow(0, 0, 0);
  assert.deepEqual(writes.map(({ name }) => name), ['block_place', 'window_click']);
});

test('placement completion never promotes an unreceipted local block observation', async () => {
  const reference = pos(60, 64, 60);
  const target = pos(60, 65, 60);
  const wrong = pos(61, 65, 60);
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot.heldItem = { name: 'chest' };
  bot.blockAt = (position) => {
    if (sameTestPosition(position, reference)) return liveBlock('stone', reference);
    if (sameTestPosition(position, wrong)) {
      return liveBlock('chest', wrong, { type: 'single', facing: 'north' });
    }
    return liveBlock('air', position);
  };
  bot.placeBlock = async () => {};
  const ctx = { worldActionAuthorization: createWorldActionAuthorization() };
  installWorldActionBoundary(bot, ctx);

  await bot.placeBlock(liveBlock('stone', reference), pos(0, 1, 0));
  assert.equal(authorizeStorageAccess(bot, ctx, wrong, { blockName: 'chest' }).ok, false);
  assert.equal(authorizeStorageAccess(bot, ctx, target, { blockName: 'chest' }).ok, false);
});

test('another-player same-target placement race cannot become a bot-owned anchor', async () => {
  const reference = pos(62, 64, 60);
  const target = pos(62, 65, 60);
  const bot = makeBot({ worldIdentity: 'world-a' });
  bot.heldItem = { name: 'chest' };
  bot.blockAt = (position) => (
    sameTestPosition(position, reference)
      ? liveBlock('stone', reference)
      : liveBlock('chest', target, { type: 'single', facing: 'north' })
  );
  bot.placeBlock = async () => {
    bot.players.Alex = { username: 'Alex' };
    bot.emit('playerJoined', { username: 'Alex' });
  };
  const state = createWorldActionAuthorization({ sessionIdentity: 'race-fixture' });
  const ctx = { worldActionAuthorization: state };
  installWorldActionBoundary(bot, ctx);

  await bot.placeBlock(liveBlock('stone', reference), pos(0, 1, 0));
  assert.equal(state.anchors.some((anchor) => anchor.provenance === 'bot_placed_current_session'), false);
  assert.equal(authorizeStorageAccess(bot, ctx, target, { blockName: 'chest' }).ok, false);
  assert.equal(registerBotPlacedAnchor(bot, ctx, 'chest', target), null);
});

test('boundary reinstall re-wraps plugin-replaced sinks exactly once and retains wrapper identity', async () => {
  const reference = liveBlock('stone', pos(0, 64, 0));
  const target = pos(0, 65, 0);
  const ctx = {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(target),
  };
  const bot = makeBot();
  bot.heldItem = { name: 'dirt' };
  bot.blockAt = (position) => {
    if (sameTestPosition(position, reference.position)) return reference;
    if (sameTestPosition(position, target)) return liveBlock('dirt', target);
    return liveBlock('air', position);
  };

  let digWrites = 0;
  let placeWrites = 0;
  bot.dig = async () => { digWrites += 1; };
  bot.placeBlock = async () => { placeWrites += 1; };
  installWorldActionBoundary(bot, ctx);
  const firstDigWrapper = bot.dig;
  const firstPlaceWrapper = bot.placeBlock;

  let pluginDigCalls = 0;
  let pluginPlaceCalls = 0;
  const pluginDig = async (...args) => {
    pluginDigCalls += 1;
    return firstDigWrapper(...args);
  };
  const pluginPlace = async (...args) => {
    pluginPlaceCalls += 1;
    return firstPlaceWrapper(...args);
  };
  bot.dig = pluginDig;
  bot.placeBlock = pluginPlace;
  installWorldActionBoundary(bot, ctx);
  const replacementDigWrapper = bot.dig;
  const replacementPlaceWrapper = bot.placeBlock;
  assert.equal(replacementDigWrapper, firstDigWrapper);
  assert.equal(replacementPlaceWrapper, firstPlaceWrapper);

  installWorldActionBoundary(bot, ctx);
  assert.equal(bot.dig, replacementDigWrapper);
  assert.equal(bot.placeBlock, replacementPlaceWrapper);
  await assert.rejects(bot.dig({ name: 'stone', position: target }), { code: 'WORLD_ACTION_DENIED' });
  await assert.rejects(bot.placeBlock(reference, pos(0, 1, 0)), { code: 'WORLD_ACTION_DENIED' });
  assert.deepEqual(
    { digWrites, placeWrites, pluginDigCalls, pluginPlaceCalls },
    { digWrites: 0, placeWrites: 0, pluginDigCalls: 0, pluginPlaceCalls: 0 },
  );

  ctx.worldModel = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  await bot.dig({ name: 'stone', position: target });
  await bot.placeBlock(reference, pos(0, 1, 0));
  assert.deepEqual(
    { digWrites, placeWrites, pluginDigCalls, pluginPlaceCalls },
    { digWrites: 1, placeWrites: 1, pluginDigCalls: 1, pluginPlaceCalls: 1 },
  );

  bot.dig = pluginDig;
  bot.placeBlock = pluginPlace;
  installWorldActionBoundary(bot, ctx);
  assert.equal(bot.dig, firstDigWrapper);
  assert.equal(bot.placeBlock, firstPlaceWrapper);
  await bot.dig({ name: 'stone', position: target });
  await bot.placeBlock(reference, pos(0, 1, 0));
  assert.deepEqual(
    { digWrites, placeWrites, pluginDigCalls, pluginPlaceCalls },
    { digWrites: 2, placeWrites: 2, pluginDigCalls: 2, pluginPlaceCalls: 2 },
  );
});

test('raw interaction boundary rejects unowned containers and live interactive placement supports', async () => {
  const reference = liveBlock('furnace', pos(0, 64, 0));
  const target = pos(0, 65, 0);
  const bot = makeBot({ worldIdentity: 'world-a' });
  let containerWrites = 0;
  let placementWrites = 0;
  bot.heldItem = { name: 'dirt' };
  bot.openContainer = async () => { containerWrites += 1; };
  bot.placeBlock = async () => { placementWrites += 1; };
  bot.blockAt = (position) => (
    position.x === reference.position.x && position.y === reference.position.y && position.z === reference.position.z
      ? reference
      : liveBlock('air', position)
  );
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  await assert.rejects(
    bot.openContainer({ name: 'white_shulker_box', position: target }),
    (error) => error?.code === 'WORLD_ACTION_DENIED',
  );
  await assert.rejects(
    bot.placeBlock(reference, pos(0, 1, 0)),
    (error) => error?.code === 'WORLD_ACTION_DENIED',
  );
  assert.equal(containerWrites, 0);
  assert.equal(placementWrites, 0);
});

test('configured world identity scopes operator anchors without enabling disposable trust', () => {
  const chest = pos(3, 64, 0);
  const state = createWorldActionAuthorization({
    mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
    sessionIdentity: 'explicit-session',
    worldIdentity: 'world-a',
    freshWorldIdentity: 'world-a',
    createdFreshWorld: true,
    singlePlayer: true,
    operatorAnchors: [{
      kind: 'storage',
      blockName: 'chest',
      position: chest,
      dimension: 'overworld',
      worldIdentity: 'world-a',
    }],
  });
  const bot = makeBot();
  const ctx = { worldActionAuthorization: state };
  assert.equal(authorizeStorageAccess(bot, ctx, chest, { blockName: 'chest' }).ok, true);
  assert.equal(authorizeWorkstationAccess(bot, ctx, pos(4, 64, 0), { blockName: 'furnace' }).ok, false);
});

test('raw activation boundary checks adjacent placement and denies unbounded bucket item use', async () => {
  const reference = liveBlock('stone', pos(0, 64, 0));
  const target = pos(1, 64, 0);
  const ctx = {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(target),
  };
  const bot = makeBot();
  bot.registry = { blocksByName: { dirt: {} } };
  bot.heldItem = { name: 'dirt' };
  let blockActivations = 0;
  bot.activateBlock = async () => { blockActivations += 1; };
  installWorldActionBoundary(bot, ctx);
  await assert.rejects(bot.activateBlock(reference, pos(1, 0, 0)), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(blockActivations, 0);

  const bucketWrites = [];
  const bucketBot = makeBot();
  bucketBot._client = { write: (name, packet) => { bucketWrites.push({ name, packet }); } };
  bucketBot.heldItem = { name: 'water_bucket' };
  bucketBot.blockAt = (position) => (
    position.x === reference.position.x
      && position.y === reference.position.y
      && position.z === reference.position.z
      ? { ...reference, face: 5 }
      : liveBlock('air', position)
  );
  bucketBot.blockAtCursor = () => ({ ...reference, face: 5 });
  let itemActivations = 0;
  bucketBot.activateItem = async (offHand) => {
    itemActivations += 1;
    bucketBot._client.write('use_item', useItemPacket(
      bucketBot,
      offHand === true ? 1 : 0,
      bucketBot.packetRotationOverride,
    ));
  };
  installWorldActionBoundary(bucketBot, ctx);
  assert.throws(
    () => bucketBot._client.write('use_item', { hand: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  await assert.rejects(bucketBot.activateItem(), { code: 'WORLD_ACTION_DENIED' });
  await assert.rejects(
    bucketBot.activateItem(undefined, {
      worldAction: {
        kind: 'placement',
        target,
        referencePosition: reference.position,
        referenceBlockName: reference.name,
      },
    }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.equal(itemActivations, 0);
  assert.equal(bucketWrites.length, 0);

  installWorldActionBoundary(bucketBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(pos(target.x + 2, target.y, target.z)),
  });
  await assert.rejects(bucketBot.activateItem(undefined, {
    worldAction: {
      kind: 'placement',
      target,
      referencePosition: reference.position,
      referenceBlockName: reference.name,
    },
  }), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(bucketWrites.length, 0, 'unbounded fluid flow cannot approach a protected region');

  const allowedCtx = { worldActionAuthorization: createWorldActionAuthorization() };
  installWorldActionBoundary(bucketBot, allowedCtx);
  bucketBot.packetRotationOverride = { x: 0, y: 0 };
  await assert.rejects(bucketBot.activateItem(undefined, {
    worldAction: {
      kind: 'placement',
      target,
      referencePosition: reference.position,
      referenceBlockName: reference.name,
    },
  }), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(bucketWrites.length, 0);
  bucketBot.packetRotationOverride = null;
  await assert.rejects(bucketBot.activateItem(undefined, {
    worldAction: {
      kind: 'placement',
      target,
      referencePosition: reference.position,
      referenceBlockName: reference.name,
    },
  }), (error) => error?.code === 'WORLD_ACTION_DENIED'
    && /bucket flow\/source effects are not modeled/.test(error.message));
  assert.equal(itemActivations, 0);
  assert.deepEqual(bucketWrites, []);

  const foodBot = makeBot();
  const foodWrites = [];
  foodBot._client = { write: (name, packet) => { foodWrites.push({ name, packet }); } };
  foodBot.heldItem = { name: 'apple' };
  foodBot.activateItem = async () => { foodBot._client.write('use_item', { hand: 0 }); };
  installWorldActionBoundary(foodBot, allowedCtx);
  await foodBot.activateItem();
  assert.throws(() => foodBot._client.write('use_item', { hand: 0 }), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.deepEqual(foodWrites.map(({ name }) => name), ['use_item']);

  const handMismatchBot = makeBot();
  handMismatchBot.heldItem = { name: 'apple' };
  handMismatchBot.inventory = {
    id: 0,
    hotbarStart: 36,
    slots: { 36: { name: 'apple' }, 45: { name: 'water_bucket' } },
  };
  handMismatchBot.blockAt = bucketBot.blockAt;
  handMismatchBot.blockAtCursor = bucketBot.blockAtCursor;
  handMismatchBot._client = { write: () => assert.fail('wrong-hand bucket packet must not be sent') };
  handMismatchBot.activateItem = async () => { handMismatchBot._client.write('use_item', { hand: 0 }); };
  installWorldActionBoundary(handMismatchBot, allowedCtx);
  await assert.rejects(
    handMismatchBot.activateItem(true, {
      worldAction: {
        kind: 'placement',
        target,
        referencePosition: reference.position,
        referenceBlockName: reference.name,
      },
    }),
    { code: 'WORLD_ACTION_DENIED' },
  );

  const boatBot = makeBot();
  boatBot._client = { write: () => assert.fail('untyped boat use must not reach the raw writer') };
  boatBot.heldItem = { name: 'oak_boat' };
  boatBot.activateItem = async () => { boatBot._client.write('use_item', { hand: 0 }); };
  installWorldActionBoundary(boatBot, allowedCtx);
  await assert.rejects(boatBot.activateItem(), { code: 'WORLD_ACTION_DENIED' });
});

test('raw item activation rejects truthy non-boolean offHand selectors before item inspection or mutation', async () => {
  const bot = makeBot();
  bot.heldItem = { name: 'apple' };
  bot.inventory = {
    id: 0,
    hotbarStart: 36,
    slots: { 36: { name: 'apple' }, 45: { name: 'water_bucket' } },
  };
  let activations = 0;
  bot.activateItem = async () => { activations += 1; };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  await assert.rejects(
    bot.activateItem(1, { worldAction: { kind: 'placement', target: pos(1, 64, 1) } }),
    (error) => error?.code === 'WORLD_ACTION_DENIED' && /offHand must be a boolean/.test(error.message),
  );
  assert.equal(activations, 0);
});

test('block-place mutation packets require a typed active capability and reject ambiguous item effects', async () => {
  const reference = liveBlock('oak_log', pos(12, 64, 12));
  const target = pos(12, 65, 12);
  for (const itemName of [
    'flint_and_steel',
    'fire_charge',
    'bone_meal',
    'ender_eye',
    'oak_boat',
    'armor_stand',
  ]) {
    const bot = makeBot();
    bot.registry = { blocksByName: {} };
    bot.heldItem = { name: itemName };
    bot.blockAt = (position) => (
      sameTestPosition(position, reference.position) ? reference : liveBlock('air', position)
    );
    bot._client = { write: () => assert.fail(`${itemName} mutation must not reach the raw writer`) };
    bot.activateBlock = async () => {
      bot._client.write('block_place', { location: reference.position, direction: 1, hand: 0 });
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    assert.throws(
      () => bot._client.write('block_place', { location: reference.position, direction: 1, hand: 0 }),
      { code: 'WORLD_ACTION_DENIED' },
    );
    await assert.rejects(bot.activateBlock(reference, pos(0, 1, 0)), { code: 'WORLD_ACTION_DENIED' });
  }

  const writes = [];
  const axeBot = makeBot();
  axeBot.registry = { blocksByName: {} };
  axeBot.heldItem = { name: 'iron_axe' };
  axeBot.blockAt = exactBlockAt(reference);
  axeBot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  axeBot.activateBlock = async () => {
    axeBot._client.write('block_place', { location: reference.position, direction: 1, hand: 0 });
  };
  installWorldActionBoundary(axeBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  await axeBot.activateBlock(reference, pos(0, 1, 0));
  assert.deepEqual(writes.map(({ name }) => name), ['block_place']);
});

test('workstation control packets require the current authorized block-window lease', async () => {
  async function openWorkstation(blockName, windowType, windowId) {
    const target = pos(windowId, 64, windowId);
    const block = liveBlock(blockName, target);
    const window = { id: windowId, type: windowType };
    const writes = [];
    const bot = makeBot({ worldIdentity: 'world-a' });
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.blockAt = exactBlockAt(block);
    bot.openBlock = async (current) => openWindowFromBlock(bot, current, window);
    const ctx = {
      worldActionAuthorization: createWorldActionAuthorization({
        operatorAnchors: [{
          kind: 'workstation',
          blockName,
          position: target,
          dimension: 'overworld',
          worldIdentity: 'world-a',
        }],
      }),
    };
    installWorldActionBoundary(bot, ctx);
    await bot.openBlock(block);
    return { bot, block, ctx, target, writes, window };
  }

  const enchant = await openWorkstation('enchanting_table', 'minecraft:enchanting', 31);
  enchant.bot._client.write('enchant_item', { windowId: 31, enchantment: 0 });
  assert.deepEqual(enchant.writes.map(({ name }) => name), ['block_place', 'enchant_item']);
  enchant.ctx.worldModel = protectedModel(enchant.target);
  assert.throws(
    () => enchant.bot._client.write('enchant_item', { windowId: 31, enchantment: 1 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(enchant.writes.map(({ name }) => name), ['block_place', 'enchant_item']);

  const anvil = await openWorkstation('anvil', 'minecraft:anvil', 32);
  anvil.bot._client.write('name_item', { name: 'authorized' });
  assert.deepEqual(anvil.writes.map(({ name }) => name), ['block_place', 'name_item']);

  const staleAnvil = await openWorkstation('anvil', 'minecraft:anvil', 33);
  staleAnvil.bot.currentWindow = { id: 33, type: 'minecraft:anvil' };
  assert.throws(
    () => staleAnvil.bot._client.write('name_item', { name: 'stale' }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(staleAnvil.writes.map(({ name }) => name), ['block_place']);

  const wrongEnchant = await openWorkstation('enchanting_table', 'minecraft:enchanting', 34);
  assert.throws(
    () => wrongEnchant.bot._client.write('enchant_item', { windowId: 35, enchantment: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(wrongEnchant.writes.map(({ name }) => name), ['block_place']);

  const unboundWrites = [];
  const unbound = makeBot();
  unbound._client = { write: (name, packet) => { unboundWrites.push({ name, packet }); } };
  installWorldActionBoundary(unbound, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  for (const [name, packet] of [
    ['enchant_item', { windowId: 9, enchantment: 0 }],
    ['name_item', { name: 'bypass' }],
    ['select_trade', { slot: 0 }],
    ['update_command_block', { location: pos(1, 64, 1), command: 'say bypass' }],
  ]) {
    assert.throws(() => unbound._client.write(name, packet), { code: 'WORLD_ACTION_DENIED' });
  }
  assert.equal(unboundWrites.length, 0);

  for (const unsafeState of ['held-block', 'sneaking', 'reference-mutator']) {
    const target = pos(40, 64, {
      'held-block': 40,
      sneaking: 41,
      'reference-mutator': 42,
    }[unsafeState]);
    const chest = liveBlock('chest', target, { type: 'single', facing: 'north' });
    const writes = [];
    const bot = makeBot({ worldIdentity: 'world-a' });
    bot.registry = { blocksByName: { dirt: {} } };
    if (unsafeState === 'held-block') bot.heldItem = { name: 'dirt' };
    if (unsafeState === 'sneaking') bot.getControlState = () => true;
    if (unsafeState === 'reference-mutator') bot.heldItem = { name: 'bucket' };
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.blockAt = exactBlockAt(chest);
    bot.openBlock = async (current) => openWindowFromBlock(
      bot,
      current,
      { id: 40, type: 'minecraft:chest' },
    );
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization({
        operatorAnchors: [{
          kind: 'storage',
          blockName: 'chest',
          position: target,
          dimension: 'overworld',
          worldIdentity: 'world-a',
        }],
      }),
    });
    await assert.rejects(bot.openBlock(chest), { code: 'WORLD_ACTION_DENIED' });
    assert.equal(writes.length, 0, unsafeState);
  }

  const offhandTarget = pos(40, 64, 43);
  const offhandChest = liveBlock('chest', offhandTarget, { type: 'single', facing: 'north' });
  const offhandWrites = [];
  const offhandBot = makeBot({ worldIdentity: 'world-a' });
  offhandBot.registry = { blocksByName: { dirt: {} } };
  offhandBot.inventory = { id: 0, hotbarStart: 36, slots: [] };
  offhandBot.inventory.slots[45] = { name: 'dirt' };
  offhandBot._client = { write: (name, packet) => { offhandWrites.push({ name, packet }); } };
  offhandBot.blockAt = exactBlockAt(offhandChest);
  offhandBot.openBlock = async (current) => {
    offhandBot._client.write('block_place', {
      location: current.position,
      direction: 1,
      hand: 1,
    });
  };
  installWorldActionBoundary(offhandBot, {
    worldActionAuthorization: createWorldActionAuthorization({
      operatorAnchors: [{
        kind: 'storage',
        blockName: 'chest',
        position: offhandTarget,
        dimension: 'overworld',
        worldIdentity: 'world-a',
      }],
    }),
  });
  await assert.rejects(offhandBot.openBlock(offhandChest), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(offhandWrites.length, 0);
});

test('sign updates require an active exact-target capability at packet emission', async () => {
  const target = pos(18, 64, 18);
  const sign = liveBlock('oak_sign', target);
  const writes = [];
  const bot = makeBot();
  const client = new EventEmitter();
  client.write = (name, packet) => { writes.push({ name, packet }); };
  bot._client = client;
  bot.blockAt = exactBlockAt(sign);
  bot.updateSign = async (block) => {
    bot._client.write('update_sign', { location: block.position, text1: 'safe' });
  };
  const ctx = { worldActionAuthorization: createWorldActionAuthorization() };
  installWorldActionBoundary(bot, ctx);

  assert.throws(
    () => bot._client.write('update_sign', { location: target, text1: 'raw bypass' }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  await bot.updateSign(sign, 'safe');
  assert.deepEqual(writes.map(({ name }) => name), ['update_sign']);

  ctx.worldModel = protectedModel(target);
  await assert.rejects(bot.updateSign(sign, 'blocked'), { code: 'WORLD_ACTION_DENIED' });
  assert.deepEqual(writes.map(({ name }) => name), ['update_sign']);
});

test('raw packet boundary allows only explicit non-mutating packets and safe payload channels', () => {
  const writes = [];
  const bot = makeBot();
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  bot._client.write('position', { x: 0, y: 64, z: 0, onGround: true });
  bot._client.write('custom_payload', { channel: 'minecraft:brand', data: Buffer.from('mcbot') });
  bot._client.write('block_dig', { status: 1, location: pos(1, 64, 1), face: 1 });
  for (const status of [3, 4, 5, 6, 99]) {
    assert.throws(
      () => bot._client.write('block_dig', { status, location: pos(0, 0, 0), face: 0 }),
      { code: 'WORLD_ACTION_DENIED' },
    );
  }
  assert.throws(
    () => bot._client.write('custom_payload', { channel: 'MC|AdvCdm', data: Buffer.alloc(0) }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.throws(() => bot._client.write('unclassified_mutator', {}), { code: 'WORLD_ACTION_DENIED' });
  assert.throws(
    () => bot._client.write('client_command', { actionId: 0 }),
    { code: 'WORLD_ACTION_DENIED' },
    'respawn can consume a protected respawn-anchor charge and is not non-mutating',
  );
  assert.throws(
    () => bot._client.write('position', { x: 100, y: 64, z: 0, onGround: true }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.throws(
    () => bot._client.write('look', { yaw: 0, pitch: 0, onGround: true }),
    { code: 'WORLD_ACTION_DENIED' },
  );
  assert.deepEqual(writes.map(({ name }) => name), [
    'position',
    'custom_payload',
    'block_dig',
  ]);
});

test('selected-slot, sneak, and inventory transitions require exact active capabilities', async () => {
  const writes = [];
  const bot = makeBot();
  bot.inventory.slots[36] = { name: 'apple' };
  bot.inventory.slots[37] = { name: 'water_bucket' };
  let sneaking = false;
  bot.getControlState = (control) => (control === 'sneak' ? sneaking : false);
  bot.setQuickBarSlot = (slot) => {
    bot.quickBarSlot = slot;
    bot._client.write('held_item_slot', { slotId: slot });
  };
  bot.setControlState = (control, enabled) => {
    if (control === 'sneak') sneaking = enabled;
    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: enabled ? 0 : 1,
      jumpBoost: 0,
    });
  };
  const client = new EventEmitter();
  client.write = (name, packet) => { writes.push({ name, packet }); };
  bot._client = client;
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  assert.throws(() => bot._client.write('held_item_slot', { slotId: 1 }), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.throws(() => bot._client.write('entity_action', {
    entityId: bot.entity.id,
    actionId: 0,
    jumpBoost: 0,
  }), { code: 'WORLD_ACTION_DENIED' });
  assert.throws(() => bot._client.write('player_input', { inputs: { shift: true } }), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.throws(() => bot._client.write('window_click', {
    windowId: 0,
    slot: 36,
    mouseButton: 0,
    mode: 0,
    changedSlots: [],
  }), { code: 'WORLD_ACTION_DENIED' });

  client.emit('window_items', {
    windowId: 0,
    stateId: 1,
    items: Array.from(bot.inventory.slots),
  });
  await Promise.resolve();

  bot.setQuickBarSlot(1);
  assert.throws(() => bot._client.write('use_item', useItemPacket(bot)), {
    code: 'WORLD_ACTION_DENIED',
  });
  bot.setQuickBarSlot(0);
  bot.setControlState('sneak', true);
  bot.setControlState('sneak', false);
  await bot.clickWindow(0, 0, 0);
  assert.deepEqual(writes.map(({ name }) => name), [
    'held_item_slot',
    'held_item_slot',
    'entity_action',
    'entity_action',
    'window_click',
  ]);
});

test('an unconfirmed non-selected hotbar mutation cannot later become the held item', async () => {
  const bot = makeBot();
  const client = new EventEmitter();
  client.write = () => {};
  bot._client = client;
  bot.inventory.slots[36] = { name: 'stone', type: 1, count: 1 };
  bot.inventory.slots[37] = { name: 'dirt', type: 2, count: 1 };
  bot.setQuickBarSlot = (slot) => {
    bot.quickBarSlot = slot;
    bot._client.write('held_item_slot', { slotId: slot });
  };
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot.inventory.slots[slot] = { name: 'cobblestone', type: 3, count: 1 };
    bot._client.write('window_click', {
      windowId: 0,
      stateId: 10,
      slot,
      mouseButton,
      mode,
      changedSlots: [{ location: slot, item: bot.inventory.slots[slot] }],
    });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  await bot.clickWindow(37, 0, 0);
  assert.throws(() => bot.setQuickBarSlot(1), { code: 'WORLD_ACTION_DENIED' });
  client.emit('set_slot', {
    windowId: 0,
    stateId: 11,
    slot: 37,
    item: bot.inventory.slots[37],
  });
  await Promise.resolve();
  bot.setQuickBarSlot(1);
  assert.equal(bot.quickBarSlot, 1);
});

test('movement packets deny DNT mechanics and nearby unowned entity collisions', () => {
  const target = pos(0, 64, 0);
  const makeMovingBot = (ctx, entities = null) => {
    const bot = makeBot();
    if (entities) bot.entities = entities;
    let forward = false;
    bot.setControlState = (control, enabled) => {
      if (control === 'forward') forward = enabled;
    };
    bot.getControlState = (control) => control === 'forward' && forward;
    bot._client = { write() {} };
    installWorldActionBoundary(bot, ctx);
    return bot;
  };

  const protectedBot = makeMovingBot({
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(pos(100, 64, 100)),
  });
  assert.throws(() => protectedBot.setControlState('forward', true), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.throws(() => protectedBot._client.write('position', {
    ...target,
    onGround: true,
  }), { code: 'WORLD_ACTION_DENIED' });

  const chestMinecart = {
    id: 7, name: 'chest_minecart', type: 'object', position: pos(1, 64, 0),
  };
  const entityBot = makeMovingBot(
    { worldActionAuthorization: createWorldActionAuthorization() },
    { 7: chestMinecart },
  );
  assert.throws(() => entityBot._client.write('position', {
    ...target,
    onGround: true,
  }), { code: 'WORLD_ACTION_DENIED' });

  const sensorPosition = pos(2, 64, 0);
  const sensorBot = makeBot();
  const sensorWrites = [];
  sensorBot.findBlocks = () => [sensorPosition];
  sensorBot.blockAt = (position) => (
    sameTestPosition(position, sensorPosition)
      ? liveBlock('sculk_sensor', sensorPosition)
      : liveBlock('air', position)
  );
  sensorBot._client = { write: (name, packet) => { sensorWrites.push({ name, packet }); } };
  installWorldActionBoundary(sensorBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });
  sensorBot._client.write('position', { ...target, onGround: true });
  assert.equal(
    sensorWrites.length,
    1,
    'ambient locomotion vibration around unmarked automation is explicitly out of Phase-1 scope',
  );
});

test('movement uses one subscribed world-model snapshot and performs no per-pose disk loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-movement-policy-'));
  const store = new WorldModelStore(path.join(dir, 'world-model.json'));
  const safe = createEmptyWorldModel({ now: '2026-08-29T00:00:00.000Z' });
  store.save(safe);
  const originalLoad = store.load.bind(store);
  let loads = 0;
  store.load = () => {
    loads += 1;
    return originalLoad();
  };

  try {
    const bot = makeBot();
    let movementEnabled = false;
    let writes = 0;
    bot.setControlState = (control, enabled) => {
      if (control === 'forward') movementEnabled = enabled;
      if (control === 'sprint') {
        bot._client.write('entity_action', {
          entityId: bot.entity.id,
          actionId: enabled ? 3 : 4,
          jumpBoost: 0,
        });
      }
    };
    bot.getControlState = (control) => control === 'forward' && movementEnabled;
    bot.elytraFly = () => {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: 8,
        jumpBoost: 0,
      });
    };
    bot._client = { write: () => { writes += 1; } };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
      worldModelStore: store,
    });

    assert.equal(loads, 1, 'boundary initialization performs the only synchronous store load');
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.elytraFly();
    for (let index = 0; index < 40; index += 1) {
      bot._client.write('position', { ...bot.entity.position, onGround: true });
    }
    assert.equal(loads, 1, 'movement transitions and pose packets use only the subscribed cache');
    assert.equal(writes, 42);

    store.save(protectedModel(pos(200, 64, 200)));
    assert.throws(() => bot._client.write('position', {
      ...bot.entity.position,
      onGround: true,
    }), { code: 'WORLD_ACTION_DENIED' });
    assert.throws(() => bot.setControlState('forward', true), {
      code: 'WORLD_ACTION_DENIED',
    });
    assert.equal(loads, 1, 'save publication updates movement policy without a reload');

    store.save(safe);
    assert.throws(() => bot._client.write('position', {
      ...bot.entity.position,
      onGround: true,
    }), { code: 'WORLD_ACTION_DENIED' });
    assert.equal(loads, 1, 'observed DNT remains sticky for the connection');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('movement denies untrackable world-model stores without polling them', () => {
  let loads = 0;
  let writes = 0;
  const bot = makeBot();
  bot.setControlState = () => {};
  bot._client = { write: () => { writes += 1; } };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModelStore: {
      load: () => {
        loads += 1;
        return createEmptyWorldModel();
      },
    },
  });

  assert.throws(() => bot.setControlState('forward', true), {
    code: 'WORLD_ACTION_DENIED',
  });
  assert.throws(() => bot._client.write('position', {
    ...bot.entity.position,
    onGround: true,
  }), { code: 'WORLD_ACTION_DENIED' });
  assert.equal(loads, 0, 'custom stores are never synchronously polled by movement');
  assert.equal(writes, 0);
});

test('chorus fruit cannot bypass movement authorization through random server teleportation', async () => {
  const bot = makeBot();
  bot.heldItem = { name: 'chorus_fruit' };
  bot._client = { write: () => assert.fail('chorus-fruit packet must not be sent') };
  bot.activateItem = async () => {
    bot._client.write('use_item', useItemPacket(bot));
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  assert.throws(() => bot._client.write('use_item', useItemPacket(bot)), {
    code: 'WORLD_ACTION_DENIED',
  });
  await assert.rejects(bot.activateItem(), { code: 'WORLD_ACTION_DENIED' });

  const hornBot = makeBot();
  hornBot.heldItem = { name: 'goat_horn' };
  hornBot._client = { write: () => assert.fail('DNT-adjacent vibration packet must not be sent') };
  installWorldActionBoundary(hornBot, {
    worldActionAuthorization: createWorldActionAuthorization(),
    worldModel: protectedModel(pos(200, 64, 200)),
  });
  assert.throws(() => hornBot._client.write('use_item', useItemPacket(hornBot)), {
    code: 'WORLD_ACTION_DENIED',
  });
});

test('item use fails closed until a matching newer held-slot readback arrives', async () => {
  const writes = [];
  const bot = makeBot();
  bot.heldItem = { name: 'apple' };
  const client = new EventEmitter();
  client.write = (name, packet) => { writes.push({ name, packet }); };
  bot._client = client;
  bot.activateItem = async () => {
    bot._client.write('use_item', { hand: 0 });
  };
  installWorldActionBoundary(bot, {
    worldActionAuthorization: createWorldActionAuthorization(),
  });

  client.emit('window_items', {
    windowId: 0,
    stateId: 10,
    items: Array(46).fill(null),
  });
  await Promise.resolve();
  await bot.activateItem();
  await assert.rejects(bot.activateItem(), { code: 'WORLD_ACTION_DENIED' });

  client.emit('set_slot', {
    windowId: 0,
    stateId: 10,
    slot: 36,
    item: { name: 'apple' },
  });
  await Promise.resolve();
  await assert.rejects(bot.activateItem(), { code: 'WORLD_ACTION_DENIED' });

  client.emit('set_slot', {
    windowId: 0,
    stateId: 11,
    slot: 36,
    item: { name: 'apple' },
  });
  await Promise.resolve();
  await bot.activateItem();
  assert.deepEqual(writes.map(({ name }) => name), ['use_item', 'use_item']);
});

test('activateItem decorators retain one boundary wrapper but cannot revive denied bucket effects', async () => {
  const reference = { ...liveBlock('stone', pos(0, 64, 1)), face: 5 };
  const target = pos(1, 64, 1);
  const bot = makeBot();
  const writes = [];
  bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
  bot.heldItem = { name: 'water_bucket' };
  bot.blockAt = (position) => (
    sameTestPosition(position, reference.position) ? reference : liveBlock('air', position)
  );
  bot.blockAtCursor = () => reference;
  let mutations = 0;
  bot.activateItem = async () => {
    mutations += 1;
    bot._client.write('use_item', useItemPacket(bot));
  };
  const ctx = { worldActionAuthorization: createWorldActionAuthorization() };
  installWorldActionBoundary(bot, ctx);
  const boundaryWrapper = bot.activateItem;

  let decoratorCalls = 0;
  bot.activateItem = async (offHand) => {
    decoratorCalls += 1;
    return boundaryWrapper(offHand);
  };
  installWorldActionBoundary(bot, ctx);
  assert.equal(bot.activateItem, boundaryWrapper);

  await assert.rejects(bot.activateItem(undefined, {
    worldAction: {
      kind: 'placement',
      target,
      referencePosition: reference.position,
      referenceBlockName: reference.name,
    },
  }), (error) => error?.code === 'WORLD_ACTION_DENIED'
    && /bucket flow\/source effects are not modeled/.test(error.message));
  assert.deepEqual({ mutations, decoratorCalls }, { mutations: 0, decoratorCalls: 0 });
  assert.deepEqual(writes, []);
});

test('disposable trust revocation is monotonic across boundary context replacement', () => {
  const makeDisposableContext = (freshWorldIdentity) => ({
    worldActionAuthorization: createWorldActionAuthorization({
      mode: WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER,
      sessionIdentity: 'fixture-session',
      freshWorldIdentity,
      createdFreshWorld: true,
      singlePlayer: true,
    }),
  });
  const chest = pos(2, 64, 0);

  const alreadyRevokedBot = makeBot({ worldIdentity: 'fresh-world' });
  const alreadyRevokedIdentity = observeFixtureWorld(alreadyRevokedBot);
  const first = makeDisposableContext(alreadyRevokedIdentity);
  installWorldActionBoundary(alreadyRevokedBot, first);
  assert.equal(authorizeStorageAccess(alreadyRevokedBot, first, chest, { blockName: 'chest' }).ok, true);
  alreadyRevokedBot.emit('playerJoined', { username: 'Alex' });
  const replacement = makeDisposableContext(alreadyRevokedIdentity);
  installWorldActionBoundary(alreadyRevokedBot, replacement);
  assert.equal(replacement.worldActionAuthorization.disposableTrustRevoked, true);
  assert.equal(authorizeStorageAccess(alreadyRevokedBot, replacement, chest, { blockName: 'chest' }).ok, false);

  const lateEventBot = makeBot({ worldIdentity: 'fresh-world' });
  const lateEventIdentity = observeFixtureWorld(lateEventBot);
  const oldContext = makeDisposableContext(lateEventIdentity);
  const currentContext = makeDisposableContext(lateEventIdentity);
  installWorldActionBoundary(lateEventBot, oldContext);
  assert.equal(authorizeStorageAccess(lateEventBot, oldContext, chest, { blockName: 'chest' }).ok, true);
  installWorldActionBoundary(lateEventBot, currentContext);
  lateEventBot.emit('playerJoined', { username: 'Alex' });
  assert.equal(currentContext.worldActionAuthorization.disposableTrustRevoked, true);
  assert.equal(authorizeStorageAccess(lateEventBot, currentContext, chest, { blockName: 'chest' }).ok, false);

  const unprimedBot = makeBot({ worldIdentity: 'fresh-world' });
  const unprimedIdentity = observeFixtureWorld(unprimedBot);
  const unprimedOldContext = makeDisposableContext(unprimedIdentity);
  const unprimedCurrentContext = makeDisposableContext(unprimedIdentity);
  installWorldActionBoundary(unprimedBot, unprimedOldContext);
  installWorldActionBoundary(unprimedBot, unprimedCurrentContext);
  unprimedBot.emit('playerJoined', { username: 'Alex' });
  assert.equal(unprimedCurrentContext.worldActionAuthorization.disposableTrustRevoked, true);
  assert.equal(
    authorizeStorageAccess(unprimedBot, unprimedCurrentContext, chest, { blockName: 'chest' }).ok,
    false,
  );
});

test('bucket action kind is derived from the held item before all world-mutating bucket effects deny', async () => {
  const makeBucketBot = (itemName, reference, entities = null) => {
    const writes = [];
    const bot = makeBot();
    if (entities) bot.entities = entities;
    bot.heldItem = { name: itemName };
    bot.blockAt = exactBlockAt(reference);
    bot.blockAtCursor = () => reference;
    bot._client = { write: (name, packet) => { writes.push({ name, packet }); } };
    bot.activateItem = async () => {
      bot._client.write('use_item', useItemPacket(bot));
    };
    installWorldActionBoundary(bot, {
      worldActionAuthorization: createWorldActionAuthorization(),
    });
    return { bot, writes };
  };

  const water = liveBlock('water', pos(20, 64, 20));
  const filledSpoof = makeBucketBot('water_bucket', water);
  await assert.rejects(filledSpoof.bot.activateItem(undefined, {
    worldAction: { kind: 'excavation', target: water.position },
  }), (error) => error?.code === 'WORLD_ACTION_DENIED' && /requires a placement/.test(error.message));
  assert.deepEqual(filledSpoof.writes, []);

  const stone = { ...liveBlock('stone', pos(21, 64, 20)), face: 5 };
  const emptySpoof = makeBucketBot('bucket', stone);
  await assert.rejects(emptySpoof.bot.activateItem(undefined, {
    worldAction: {
      kind: 'placement',
      target: pos(22, 64, 20),
      referencePosition: stone.position,
      referenceBlockName: stone.name,
    },
  }), (error) => error?.code === 'WORLD_ACTION_DENIED' && /requires an excavation/.test(error.message));
  assert.deepEqual(emptySpoof.writes, []);

  const cauldron = liveBlock('water_cauldron', pos(23, 64, 20));
  const emptyDrain = makeBucketBot('bucket', cauldron);
  await assert.rejects(emptyDrain.bot.activateItem(undefined, {
    worldAction: { kind: 'excavation', target: cauldron.position },
  }), (error) => error?.code === 'WORLD_ACTION_DENIED'
    && /bucket flow\/source effects are not modeled/.test(error.message));
  assert.deepEqual(emptyDrain.writes, []);

  const campfire = { ...liveBlock('campfire', pos(24, 64, 20)), face: 5 };
  const filledContainer = makeBucketBot('water_bucket', campfire);
  await assert.rejects(filledContainer.bot.activateItem(undefined, {
    worldAction: {
      kind: 'placement',
      target: pos(25, 64, 20),
      referencePosition: campfire.position,
      referenceBlockName: campfire.name,
    },
  }), (error) => error?.code === 'WORLD_ACTION_DENIED'
    && /bucket flow\/source effects are not modeled/.test(error.message));
  assert.deepEqual(filledContainer.writes, []);

  const lavaReference = { ...liveBlock('stone', pos(26, 64, 20)), face: 5 };
  const chestHorse = {
    id: 41,
    name: 'donkey',
    type: 'mob',
    position: pos(30, 64, 20),
    metadata: [],
    equipment: [],
  };
  const entityCollateral = makeBucketBot(
    'lava_bucket',
    lavaReference,
    { 41: chestHorse },
  );
  await assert.rejects(entityCollateral.bot.activateItem(undefined, {
    worldAction: {
      kind: 'placement',
      target: pos(27, 64, 20),
      referencePosition: lavaReference.position,
      referenceBlockName: lavaReference.name,
    },
  }), (error) => error?.code === 'WORLD_ACTION_DENIED'
    && /bucket flow\/source effects are not modeled/.test(error.message));
  assert.deepEqual(entityCollateral.writes, []);
});

test('1.21.11 item-bearing blocks never fall through to natural excavation', () => {
  const bot = makeBot({ worldIdentity: 'world-a' });
  const ctx = { worldActionAuthorization: createWorldActionAuthorization() };
  for (const name of [
    'white_shulker_box', 'blue_shulker_box',
    'cauldron', 'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron', 'composter',
    'copper_chest', 'waxed_oxidized_copper_chest', 'crafter', 'oak_shelf',
    'bookshelf', 'chiseled_bookshelf', 'decorated_pot', 'potted_cactus',
    'jukebox', 'campfire', 'soul_campfire', 'beacon', 'beehive',
  ]) {
    assert.equal(authorizeBlockBreak(bot, ctx, { name, position: pos(1, 64, 1) }).ok, false, name);
  }
  assert.equal(
    authorizeBlockBreak(bot, ctx, { name: 'bee_nest', position: pos(1, 64, 1) }).ok,
    true,
    'natural bee nests remain excavatable resources unless separately protected',
  );
});
