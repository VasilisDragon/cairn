import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import {
  ReactiveController,
  REACTIVE_STATE,
  buildHazardLogRecord,
  cancelAutoEatStartIfUnsafe,
  cancelUnsafeItemUse,
  chooseWaterBucketHazardResponse,
  chooseWaterBucketPickupResponse,
  scanHazard,
  scanImmediateHazard,
  shouldSuppressItemUseInState,
} from '../../src/reactive/reactive.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

class Pos {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  offset(dx, dy, dz) {
    return new Pos(this.x + dx, this.y + dy, this.z + dz);
  }

  floored() {
    return new Pos(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }
}

function key(x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

function makeBot({ blocks = {}, onGround = true, velocityY = 0, yaw = 0 } = {}) {
  const blockMap = new Map(Object.entries(blocks));
  return {
    entity: {
      position: new Pos(0, 64, 0),
      yaw,
      onGround,
      velocity: { y: velocityY },
    },
    autoEat: { isEating: false },
    usingHeldItem: false,
    pathfinderOwner: {
      currentOwner: () => null,
      isIdle: () => true,
    },
    health: 20,
    food: 20,
    blockAt(p) {
      const name = blockMap.get(key(p.x, p.y, p.z)) || 'stone';
      return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
  };
}

function airColumn(depth, x = 0, z = 0, name = 'air') {
  const blocks = {};
  for (let dy = 1; dy <= depth; dy++) {
    blocks[key(x, 64 - dy, z)] = name;
  }
  return blocks;
}

function makeBlockReader(blocks = {}) {
  const blockMap = new Map(Object.entries(blocks));
  return function blockAt(p) {
    const name = blockMap.get(key(p.x, p.y, p.z)) || 'stone';
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' };
  };
}

test('scanHazard does not treat standing on solid ground near a drop as falling', () => {
  const blocks = {
    // yaw=0 faces negative Z; this leaves a drop immediately in front while
    // the bot is still standing on solid ground.
    [key(0, 63, -1)]: 'air',
    [key(0, 62, -1)]: 'air',
    [key(0, 61, -1)]: 'air',
    [key(0, 60, -1)]: 'air',
  };
  const hz = scanHazard(makeBot({ blocks, onGround: true, velocityY: 0, yaw: 0 }));

  assert.equal(hz, null);
});

test('scanHazard does not treat standing in a tree canopy with air below as falling', () => {
  const blocks = {
    ...airColumn(6),
    [key(0, 64, 0)]: 'oak_leaves',
  };
  const hz = scanHazard(makeBot({ blocks, onGround: true, velocityY: 0 }));

  assert.equal(hz, null);
});

test('scanHazard detects actual falling over a dangerous drop', () => {
  const hz = scanHazard(makeBot({
    blocks: airColumn(5),
    onGround: false,
    velocityY: -0.35,
  }));

  assert.equal(hz.kind, 'fall');
  assert.equal(hz.depth, 5);
});

test('scanHazard detects actual falling over void air', () => {
  const hz = scanHazard(makeBot({
    blocks: airColumn(6, 0, 0, 'void_air'),
    onGround: false,
    velocityY: -0.6,
  }));

  assert.equal(hz.kind, 'fall');
  assert.equal(hz.depth, 6);
});

test('scanHazard still detects direct danger blocks while not falling', () => {
  for (const blockName of ['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose']) {
    const hz = scanHazard(makeBot({
      blocks: { [key(0, 63, 0)]: blockName },
      onGround: true,
      velocityY: 0,
    }));

    assert.equal(hz.kind, blockName);
  }
});

test('scanHazard detects adjacent danger blocks independent of facing', () => {
  const cases = [
    { blockName: 'lava', pos: key(1, 63, 0) },
    { blockName: 'fire', pos: key(-1, 64, 0) },
    { blockName: 'soul_fire', pos: key(0, 64, 1) },
  ];

  for (const { blockName, pos } of cases) {
    const hz = scanHazard(makeBot({
      blocks: { [pos]: blockName },
      onGround: true,
      velocityY: 0,
      yaw: 0,
    }));

    assert.equal(hz.kind, blockName);
  }
});

test('chooseWaterBucketHazardResponse prefers adjacent safe water placement for adjacent lava', () => {
  const waterBucket = { name: 'water_bucket', slot: 12 };
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: 'air',
      [key(0, 65, 0)]: 'air',
      [key(-1, 64, 0)]: 'air',
      [key(-1, 65, 0)]: 'air',
      [key(1, 64, 0)]: 'lava',
    },
    onGround: true,
    velocityY: 0,
  });
  bot.inventory = { items: () => [waterBucket] };
  bot.equip = async () => {};
  bot.placeBlock = async () => {};
  bot.game = { dimension: 'overworld' };
  const hz = scanHazard(bot);

  const decision = chooseWaterBucketHazardResponse(bot, hz, { enabled: true });

  assert.equal(decision.action, 'place_water');
  assert.equal(decision.item, waterBucket);
  assert.equal(decision.referenceBlock.name, 'stone');
  assert.deepEqual(decision.faceVector, { x: 0, y: 1, z: 0 });
  assert.deepEqual(
    { x: decision.target.x, y: decision.target.y, z: decision.target.z },
    { x: -1, y: 64, z: 0 },
  );
});

test('chooseWaterBucketHazardResponse refuses water placement in the Nether', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: 'air',
      [key(0, 65, 0)]: 'air',
      [key(1, 64, 0)]: 'lava',
    },
    onGround: true,
    velocityY: 0,
  });
  bot.inventory = { items: () => [{ name: 'water_bucket', slot: 12 }] };
  bot.equip = async () => {};
  bot.placeBlock = async () => {};
  bot.game = { dimension: 'the_nether' };
  const hz = scanHazard(bot);

  const decision = chooseWaterBucketHazardResponse(bot, hz, { enabled: true });

  assert.deepEqual(decision, {
    action: 'none',
    reason: 'nether-water-disabled',
    dimension: 'the_nether',
  });
});

test('chooseWaterBucketPickupResponse plans bounded recovery for placed water', () => {
  const bucket = { name: 'bucket', slot: 12 };
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: 'water',
    },
    onGround: true,
    velocityY: 0,
  });
  bot.inventory = { items: () => [bucket] };
  bot.equip = async () => {};
  bot.activateBlock = async () => {};
  bot.game = { dimension: 'overworld' };

  const decision = chooseWaterBucketPickupResponse(bot, {
    target: new Pos(0, 64, 0),
    hazard: 'lava',
    hazardAt: new Pos(1, 64, 0),
  });

  assert.equal(decision.action, 'pickup_water');
  assert.equal(decision.item, bucket);
  assert.equal(decision.targetBlock.name, 'water');
  assert.deepEqual(
    { x: decision.target.x, y: decision.target.y, z: decision.target.z },
    { x: 0, y: 64, z: 0 },
  );
});

test('chooseWaterBucketPickupResponse refuses missing or distant placed water', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: 'air',
      [key(9, 64, 0)]: 'water',
    },
    onGround: true,
    velocityY: 0,
  });
  bot.inventory = { items: () => [{ name: 'bucket', slot: 12 }] };
  bot.equip = async () => {};
  bot.activateBlock = async () => {};
  bot.game = { dimension: 'overworld' };

  assert.deepEqual(
    chooseWaterBucketPickupResponse(bot, { target: new Pos(0, 64, 0) }),
    {
      action: 'none',
      reason: 'placed-water-missing',
      block: 'air',
      target: new Pos(0, 64, 0),
    },
  );
  assert.deepEqual(
    chooseWaterBucketPickupResponse(bot, { target: new Pos(9, 64, 0) }, { maxDistance: 4.5 }),
    { action: 'none', reason: 'placed-water-too-far', currentDistance: 9, maxDistance: 4.5 },
  );
});

test('scanHazard reports unreadable world probes without throwing', () => {
  const bot = makeBot({ onGround: true, velocityY: 0 });
  bot.blockAt = (p) => {
    throw new Error(`missing block at ${key(p.x, p.y, p.z)}`);
  };

  const hz = scanHazard(bot);

  assert.equal(hz.kind, 'world_read_failed');
  assert.equal(hz.error, 'missing block at 0,63,0');
});

test('scanImmediateHazard detects short falls while eating or using an item', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 63, 0)]: 'air',
      [key(0, 62, 0)]: 'stone',
    },
    onGround: false,
    velocityY: -0.2,
  });
  bot.autoEat.isEating = true;

  const hz = scanImmediateHazard(bot);

  assert.equal(hz.kind, 'fall');
  assert.equal(hz.trigger, 'falling-item-use');
});

test('scanImmediateHazard ignores ordinary grounded eating', () => {
  const bot = makeBot({ onGround: true, velocityY: 0 });
  bot.autoEat.isEating = true;

  assert.equal(scanImmediateHazard(bot), null);
});

test('scanImmediateHazard can hold active fall hazard until landing', () => {
  const bot = makeBot({ onGround: false, velocityY: -0.2 });

  assert.equal(scanImmediateHazard(bot), null);
  const hz = scanImmediateHazard(bot, { holdFalling: true });

  assert.equal(hz.kind, 'fall');
  assert.equal(hz.trigger, 'falling-hold');
});

test('scanImmediateHazard holds active fall hazard while airborne without downward velocity', () => {
  const bot = makeBot({ onGround: false, velocityY: 0 });

  assert.equal(scanImmediateHazard(bot), null);
  const hz = scanImmediateHazard(bot, { holdFalling: true });

  assert.equal(hz.kind, 'fall');
  assert.equal(hz.trigger, 'falling-hold');
});

test('buildHazardLogRecord includes fall, eating, and pathfinder context', () => {
  const bot = makeBot({ blocks: airColumn(5), onGround: false, velocityY: -0.4 });
  bot.autoEat.isEating = true;
  bot.autoEat.enabled = true;
  bot.usingHeldItem = true;
  bot.pathfinderOwner = {
    currentOwner: () => 'reactive',
    isIdle: () => false,
  };
  bot.health = 12;
  bot.food = 15;
  const hz = scanHazard(bot);

  const record = buildHazardLogRecord(bot, hz);

  assert.deepEqual(Object.keys(record).sort(), [
    'at',
    'autoEatEating',
    'autoEatEnabled',
    'food',
    'health',
    'kind',
    'onGround',
    'owner',
    'pathfinderIdle',
    'usingHeldItem',
    'velocityY',
  ]);
  assert.equal(record.kind, 'fall');
  assert.equal(record.onGround, false);
  assert.equal(record.velocityY, -0.4);
  assert.equal(record.autoEatEnabled, true);
  assert.equal(record.autoEatEating, true);
  assert.equal(record.usingHeldItem, true);
  assert.equal(record.owner, 'reactive');
  assert.equal(record.pathfinderIdle, false);
  assert.equal(record.health, 12);
  assert.equal(record.food, 15);
});

test('buildHazardLogRecord includes immediate hazard trigger when present', () => {
  const bot = makeBot({ onGround: false, velocityY: -0.2 });
  bot.usingHeldItem = true;
  const hz = scanImmediateHazard(bot);

  const record = buildHazardLogRecord(bot, hz);

  assert.equal(record.kind, 'fall');
  assert.equal(record.trigger, 'falling-item-use');
  assert.equal(record.usingHeldItem, true);
});

test('buildHazardLogRecord reports pathfinder context read failures', () => {
  const bot = makeBot({ blocks: airColumn(5), onGround: false, velocityY: -0.4 });
  bot.pathfinderOwner = {
    currentOwner() {
      throw new Error('owner unavailable');
    },
    isIdle() {
      throw new Error('idle unavailable');
    },
  };
  const hz = scanHazard(bot);

  const record = buildHazardLogRecord(bot, hz);

  assert.equal(record.owner, null);
  assert.equal(record.ownerError, 'owner unavailable');
  assert.equal(record.pathfinderIdle, null);
  assert.equal(record.pathfinderIdleError, 'idle unavailable');
});

test('cancelUnsafeItemUse cancels active auto-eat and held-item use', () => {
  let cancelCalls = 0;
  let deactivateCalls = 0;
  const bot = {
    autoEat: {
      isEating: true,
      cancelEat() {
        cancelCalls++;
      },
    },
    usingHeldItem: true,
    deactivateItem() {
      deactivateCalls++;
      this.usingHeldItem = false;
    },
  };

  const result = cancelUnsafeItemUse(bot);

  assert.deepEqual(result, { autoEatCanceled: true, itemDeactivated: true });
  assert.equal(cancelCalls, 1);
  assert.equal(deactivateCalls, 1);
  assert.equal(bot.usingHeldItem, false);
});

test('cancelUnsafeItemUse falls back to held-item deactivation without auto-eat', () => {
  let deactivateCalls = 0;
  const bot = {
    autoEat: { isEating: false },
    usingHeldItem: true,
    deactivateItem() {
      deactivateCalls++;
      this.usingHeldItem = false;
    },
  };

  const result = cancelUnsafeItemUse(bot);

  assert.deepEqual(result, { autoEatCanceled: false, itemDeactivated: true });
  assert.equal(deactivateCalls, 1);
  assert.equal(bot.usingHeldItem, false);
});

test('auto-eat starts are canceled while hazard owns reactive control', async () => {
  let cancelCalls = 0;
  let deactivateCalls = 0;
  let bindingReady = false;
  let deferredCanceled = false;
  const warnings = [];
  const bot = {
    autoEat: {
      isEating: true,
      cancelEat() {
        cancelCalls++;
        if (bindingReady) deferredCanceled = true;
      },
    },
    usingHeldItem: true,
    deactivateItem() {
      deactivateCalls++;
      this.usingHeldItem = false;
    },
  };

  const canceled = cancelAutoEatStartIfUnsafe(
    bot,
    REACTIVE_STATE.HAZARD,
    { warn: (event, payload) => warnings.push({ event, payload }) },
    { food: { name: 'apple' } },
  );
  bindingReady = true;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(canceled, true);
  assert.equal(cancelCalls, 2);
  assert.equal(deactivateCalls, 1);
  assert.equal(deferredCanceled, true);
  assert.deepEqual(warnings, [{
    event: 'autoeat.start-while-suppressed',
    payload: { state: REACTIVE_STATE.HAZARD, food: 'apple' },
  }]);
});

test('auto-eat starts are allowed during normal reactive state', async () => {
  let cancelCalls = 0;
  const bot = {
    autoEat: {
      isEating: true,
      cancelEat() {
        cancelCalls++;
      },
    },
    usingHeldItem: true,
    deactivateItem() {
      throw new Error('should not deactivate during NORMAL');
    },
  };

  const canceled = cancelAutoEatStartIfUnsafe(bot, REACTIVE_STATE.NORMAL, null, { food: { name: 'apple' } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(canceled, false);
  assert.equal(cancelCalls, 0);
  assert.equal(shouldSuppressItemUseInState(REACTIVE_STATE.NORMAL), false);
  assert.equal(shouldSuppressItemUseInState(REACTIVE_STATE.WATER_ESCAPE), true);
});

function makeControllerBot() {
  const bot = new EventEmitter();
  const pathfinderOwner = {
    current: null,
    token: null,
    stopCalls: 0,
    releaseCalls: 0,
    acquire(owner, { reason } = {}) {
      this.current = owner;
      this.reason = reason;
      this.token = { owner, reason };
      const token = this.token;
      return {
        token,
        release: () => {
          if (this.token !== token) return;
          this.releaseCalls++;
          this.current = null;
          this.reason = null;
          this.token = null;
        },
      };
    },
    stop(token) {
      if (this.token !== token) return false;
      this.stopCalls++;
      return true;
    },
    currentOwner() {
      return this.current;
    },
    isIdle() {
      return true;
    },
  };
  const autoEat = new EventEmitter();
  Object.assign(autoEat, {
    enabled: false,
    isEating: true,
    emitEatStartOnEnable: false,
    enableCalls: 0,
    disableCalls: 0,
    cancelCalls: 0,
    setOpts(opts) {
      this.opts = opts;
    },
    enableAuto() {
      this.enabled = true;
      this.enableCalls++;
      if (this.emitEatStartOnEnable) {
        this.isEating = true;
        this.emit('eatStart', { food: { name: 'apple' } });
      }
    },
    disableAuto() {
      this.enabled = false;
      this.disableCalls++;
    },
    cancelEat() {
      this.cancelCalls++;
      this.isEating = false;
    },
  });

  Object.assign(bot, {
    registry: TEST_REGISTRY,
    entity: {
      id: 'bot',
      position: new Pos(0, 64, 0),
      yaw: 0,
      onGround: false,
      velocity: { y: -0.2 },
    },
    entities: {},
    health: 20,
    food: 17,
    autoEat,
    usingHeldItem: true,
    deactivateCalls: 0,
    pvp: { stop() {}, attack() {} },
    pathfinderOwner,
    deactivateItem() {
      this.deactivateCalls++;
      this.usingHeldItem = false;
    },
    blockAt(p) {
      return { name: 'stone', position: p, boundingBox: 'block' };
    },
  });

  return bot;
}

test('ReactiveController uses a water bucket for opt-in lava/fire hazard response', async () => {
  const bot = makeControllerBot();
  const waterBucket = { name: 'water_bucket', slot: 14 };
  const equipCalls = [];
  const placeCalls = [];
  const logs = [];
  const blocks = new Map([
    [key(0, 64, 0), 'air'],
    [key(0, 65, 0), 'air'],
    [key(-1, 64, 0), 'air'],
    [key(-1, 65, 0), 'air'],
    [key(1, 64, 0), 'lava'],
  ]);
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  bot.autoEat.isEating = false;
  bot.usingHeldItem = false;
  bot.game = { dimension: 'overworld' };
  bot.inventory = { items: () => [waterBucket] };
  bot.blockAt = (p) => {
    const name = blocks.get(key(p.x, p.y, p.z)) || 'stone';
    return { name, position: p, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
  };
  bot.equip = async (item, destination) => {
    equipCalls.push({ item, destination });
    bot.heldItem = item;
  };
  bot.placeBlock = async (referenceBlock, faceVector) => {
    placeCalls.push({ referenceBlock, faceVector });
    blocks.set(key(-1, 64, 0), 'water');
  };
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    waterBucketHazardResponseEnabled: true,
    waterBucketHazardCooldownMs: 0,
  };
  controller.log = {
    info(event, payload) { logs.push({ level: 'info', event, payload }); },
    warn(event, payload) { logs.push({ level: 'warn', event, payload }); },
    error(event, payload) { logs.push({ level: 'error', event, payload }); },
    fatal(event, payload) { logs.push({ level: 'fatal', event, payload }); },
  };

  controller.lastTick = 0;
  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.deepEqual(equipCalls, [{ item: waterBucket, destination: 'hand' }]);
  assert.equal(placeCalls.length, 1);
  assert.equal(placeCalls[0].referenceBlock.name, 'stone');
  assert.deepEqual(placeCalls[0].faceVector, { x: 0, y: 1, z: 0 });
  assert.equal(logs.some((entry) => entry.event === 'hazard.water-bucket-start'), true);
  assert.equal(logs.some((entry) => entry.event === 'hazard.water-bucket-done'), true);
});

test('ReactiveController picks placed hazard water back up after the hazard clears', async () => {
  const bot = makeControllerBot();
  const waterBucket = { name: 'water_bucket', slot: 14 };
  const emptyBucket = { name: 'bucket', slot: 14 };
  const blocks = new Map([
    [key(0, 64, 0), 'air'],
    [key(0, 65, 0), 'air'],
    [key(-1, 64, 0), 'air'],
    [key(-1, 65, 0), 'air'],
    [key(1, 64, 0), 'lava'],
  ]);
  const equipCalls = [];
  const placeCalls = [];
  const activateBlockCalls = [];
  const humanizedCalls = [];
  const logs = [];
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  bot.autoEat.isEating = false;
  bot.usingHeldItem = false;
  bot.game = { dimension: 'overworld' };
  let inventoryItems = [waterBucket];
  bot.inventory = { items: () => inventoryItems };
  bot.blockAt = (p) => {
    const name = blocks.get(key(p.x, p.y, p.z)) || 'stone';
    return { name, position: p, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
  };
  bot.equip = async (item, destination) => {
    equipCalls.push({ item, destination });
    bot.heldItem = item;
  };
  bot.placeBlock = async (referenceBlock, faceVector) => {
    placeCalls.push({ referenceBlock, faceVector });
    blocks.set(key(-1, 64, 0), 'water');
    inventoryItems = [emptyBucket];
    bot.heldItem = emptyBucket;
  };
  bot.activateBlock = async (targetBlock) => {
    activateBlockCalls.push(targetBlock);
    blocks.set(key(-1, 64, 0), 'air');
    inventoryItems = [waterBucket];
    bot.heldItem = waterBucket;
  };
  bot.humanizer = {
    equipItem(targetBot, item, destination, opts = {}) {
      humanizedCalls.push(['equip', opts.reason, opts.critical === true, item.name, destination]);
      return targetBot.equip(item, destination);
    },
    placeBlock(targetBot, referenceBlock, faceVector, opts = {}) {
      humanizedCalls.push(['placeBlock', opts.reason, opts.critical === true, referenceBlock.name]);
      return targetBot.placeBlock(referenceBlock, faceVector);
    },
    activateBlock(targetBot, targetBlock, opts = {}) {
      humanizedCalls.push(['activateBlock', opts.reason, opts.critical === true, targetBlock.name]);
      return targetBot.activateBlock(targetBlock);
    },
  };
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    waterBucketHazardResponseEnabled: true,
    waterBucketHazardCooldownMs: 0,
    waterBucketPickupEnabled: true,
    waterBucketPickupMaxDistance: 4.5,
  };
  controller.log = {
    info(event, payload) { logs.push({ level: 'info', event, payload }); },
    warn(event, payload) { logs.push({ level: 'warn', event, payload }); },
    error(event, payload) { logs.push({ level: 'error', event, payload }); },
    fatal(event, payload) { logs.push({ level: 'fatal', event, payload }); },
  };

  controller.lastTick = 0;
  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.equal(placeCalls.length, 1);
  assert.equal(blocks.get(key(-1, 64, 0)), 'water');

  blocks.delete(key(1, 64, 0));
  controller.lastTick = 0;
  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.deepEqual(equipCalls, [
    { item: waterBucket, destination: 'hand' },
    { item: emptyBucket, destination: 'hand' },
  ]);
  assert.equal(activateBlockCalls.length, 1);
  assert.equal(activateBlockCalls[0].name, 'water');
  assert.deepEqual(humanizedCalls, [
    ['equip', 'hazard.water-bucket.equip', true, 'water_bucket', 'hand'],
    ['placeBlock', 'hazard.water-bucket.place-block', true, 'stone'],
    ['equip', 'hazard.water-bucket-pickup.equip', true, 'bucket', 'hand'],
    ['activateBlock', 'hazard.water-bucket-pickup.activate-block', true, 'water'],
  ]);
  assert.equal(blocks.get(key(-1, 64, 0)), 'air');
  assert.equal(logs.some((entry) => entry.event === 'hazard.water-bucket-pickup-start'), true);
  assert.equal(logs.some((entry) => entry.event === 'hazard.water-bucket-pickup-done'), true);
});

test('ReactiveController verifies pickup and falls back to activateItem when activateBlock fails', async () => {
  const bot = makeControllerBot();
  const waterBucket = { name: 'water_bucket', slot: 14 };
  const emptyBucket = { name: 'bucket', slot: 14 };
  const blocks = new Map([
    [key(0, 64, 0), 'air'],
    [key(0, 65, 0), 'air'],
    [key(-1, 64, 0), 'air'],
    [key(-1, 65, 0), 'air'],
    [key(1, 64, 0), 'magma_block'],
  ]);
  const activateBlockCalls = [];
  const activateItemCalls = [];
  const lookCalls = [];
  const deactivateCalls = [];
  const logs = [];
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  bot.autoEat.isEating = false;
  bot.usingHeldItem = false;
  bot.game = { dimension: 'overworld' };
  let inventoryItems = [waterBucket];
  bot.inventory = { items: () => inventoryItems };
  bot.blockAt = (p) => {
    const name = blocks.get(key(p.x, p.y, p.z)) || 'stone';
    return { name, position: p, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
  };
  bot.equip = async (item) => {
    bot.heldItem = item;
  };
  bot.placeBlock = async () => {
    blocks.set(key(-1, 64, 0), 'water');
    inventoryItems = [emptyBucket];
    bot.heldItem = emptyBucket;
  };
  bot.activateBlock = async (targetBlock) => {
    activateBlockCalls.push(targetBlock.name);
    throw new Error('activateBlock did not clear water');
  };
  bot.lookAt = async (target, force) => {
    lookCalls.push({ target, force });
  };
  bot.activateItem = () => {
    activateItemCalls.push(bot.heldItem?.name);
    blocks.set(key(-1, 64, 0), 'air');
    inventoryItems = [waterBucket];
    bot.heldItem = waterBucket;
    bot.usingHeldItem = true;
  };
  bot.deactivateItem = () => {
    deactivateCalls.push(true);
    bot.usingHeldItem = false;
  };
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    waterBucketHazardResponseEnabled: true,
    waterBucketHazardCooldownMs: 0,
    waterBucketPickupEnabled: true,
    waterBucketPickupMaxDistance: 4.5,
  };
  controller.log = {
    info(event, payload) { logs.push({ level: 'info', event, payload }); },
    warn(event, payload) { logs.push({ level: 'warn', event, payload }); },
    error(event, payload) { logs.push({ level: 'error', event, payload }); },
    fatal(event, payload) { logs.push({ level: 'fatal', event, payload }); },
  };

  controller.lastTick = 0;
  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));
  blocks.delete(key(1, 64, 0));
  controller.lastTick = 0;
  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(activateBlockCalls, ['water']);
  assert.deepEqual(activateItemCalls, ['bucket']);
  assert.equal(lookCalls.length, 1);
  assert.deepEqual(deactivateCalls, [true]);
  assert.equal(blocks.get(key(-1, 64, 0)), 'air');
  const done = logs.find((entry) => entry.event === 'hazard.water-bucket-pickup-done')?.payload;
  assert.equal(done?.method, 'activate-item');
  assert.match(done?.fallbackFrom, /activate-block/);
});

test('ReactiveController falls back to activateItem when water bucket block place fails', async () => {
  const bot = makeControllerBot();
  const waterBucket = { name: 'water_bucket', slot: 14 };
  const emptyBucket = { name: 'bucket', slot: 14 };
  const blocks = new Map([
    [key(0, 64, 0), 'air'],
    [key(0, 65, 0), 'air'],
    [key(-1, 64, 0), 'air'],
    [key(-1, 65, 0), 'air'],
    [key(1, 64, 0), 'magma_block'],
  ]);
  const genericPlaceCalls = [];
  const lookCalls = [];
  const activateCalls = [];
  const deactivateCalls = [];
  const logs = [];
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  bot.autoEat.isEating = false;
  bot.usingHeldItem = false;
  bot.game = { dimension: 'overworld' };
  let inventoryItems = [waterBucket];
  bot.inventory = { items: () => inventoryItems };
  bot.blockAt = (p) => {
    const name = blocks.get(key(p.x, p.y, p.z)) || 'stone';
    return { name, position: p, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
  };
  bot.equip = async (item) => {
    bot.heldItem = item;
  };
  bot._genericPlace = async (referenceBlock, faceVector, opts = {}) => {
    genericPlaceCalls.push({ referenceBlock, faceVector, opts });
    throw new Error('Event blockUpdate:(-1, 64, 0) did not fire within timeout of 5000ms');
  };
  bot.lookAt = async (target, force) => {
    lookCalls.push({ target, force });
  };
  bot.activateItem = () => {
    activateCalls.push(bot.heldItem?.name);
    blocks.set(key(-1, 64, 0), 'water');
    inventoryItems = [emptyBucket];
    bot.heldItem = emptyBucket;
    bot.usingHeldItem = true;
  };
  bot.deactivateItem = () => {
    deactivateCalls.push(true);
    bot.usingHeldItem = false;
  };
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    waterBucketHazardResponseEnabled: true,
    waterBucketHazardCooldownMs: 0,
  };
  controller.log = {
    info(event, payload) { logs.push({ level: 'info', event, payload }); },
    warn(event, payload) { logs.push({ level: 'warn', event, payload }); },
    error(event, payload) { logs.push({ level: 'error', event, payload }); },
    fatal(event, payload) { logs.push({ level: 'fatal', event, payload }); },
  };

  controller.lastTick = 0;
  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(genericPlaceCalls.length, 1);
  assert.equal(lookCalls.length, 1);
  assert.deepEqual(activateCalls, ['water_bucket']);
  assert.deepEqual(deactivateCalls, [true]);
  assert.equal(blocks.get(key(-1, 64, 0)), 'water');
  const done = logs.find((entry) => entry.event === 'hazard.water-bucket-done')?.payload;
  assert.equal(done?.method, 'activate-item');
  assert.match(done?.fallbackFrom, /generic-place/);
});

test('ReactiveController logs exact skip reason for opt-in Nether water bucket hazards', () => {
  const bot = makeControllerBot();
  const warnings = [];
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  bot.autoEat.isEating = false;
  bot.usingHeldItem = false;
  bot.game = { dimension: 'the_nether' };
  bot.inventory = { items: () => [{ name: 'water_bucket', slot: 14 }] };
  bot.blockAt = makeBlockReader({
    [key(0, 64, 0)]: 'air',
    [key(0, 65, 0)]: 'air',
    [key(1, 64, 0)]: 'lava',
  });
  bot.equip = async () => {
    throw new Error('should not equip in the Nether');
  };
  bot.placeBlock = async () => {
    throw new Error('should not place in the Nether');
  };
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    waterBucketHazardResponseEnabled: true,
    waterBucketHazardCooldownMs: 0,
  };
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };

  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'hazard.water-bucket-skip')?.payload,
    {
      kind: 'lava',
      at: { x: 1, y: 64, z: 0 },
      reason: 'nether-water-disabled',
      dimension: 'the_nether',
    },
  );
});

test('ReactiveController recovers from falling while eating after landing', () => {
  const bot = makeControllerBot();
  const controller = new ReactiveController(bot);

  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.equal(bot.pathfinderOwner.currentOwner(), 'reactive');
  assert.equal(bot.pathfinderOwner.stopCalls, 1);
  assert.equal(bot.autoEat.enabled, false);
  assert.equal(bot.autoEat.disableCalls, 1);
  assert.equal(bot.autoEat.cancelCalls, 1);
  assert.equal(bot.deactivateCalls, 1);
  assert.equal(bot.usingHeldItem, false);

  bot.entity.velocity.y = 0;
  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.equal(bot.pathfinderOwner.currentOwner(), 'reactive');
  assert.equal(bot.pathfinderOwner.stopCalls, 1);

  bot.entity.onGround = true;
  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(bot.pathfinderOwner.currentOwner(), null);
  assert.equal(bot.pathfinderOwner.releaseCalls, 1);
  assert.equal(bot.pathfinderOwner.stopCalls, 2);
  assert.equal(bot.autoEat.enabled, true);
  assert.equal(bot.autoEat.enableCalls, 2);
});

test('ReactiveController releases token when release-time pathfinder stop throws', () => {
  const bot = makeControllerBot();
  const errors = [];
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error(event, payload) { errors.push({ event, payload }); },
    fatal() {},
  };
  bot.pathfinderOwner.stop = function stop(token) {
    if (this.token !== token) return false;
    this.stopCalls++;
    if (this.stopCalls === 2) throw new Error('release stop failed');
    return true;
  };

  controller.lastTick = 0;
  controller._tick();
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  controller.lastTick = 0;

  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(bot.pathfinderOwner.currentOwner(), null);
  assert.equal(bot.pathfinderOwner.releaseCalls, 1);
  assert.equal(bot.pathfinderOwner.stopCalls, 2);
  assert.equal(bot.autoEat.enabled, true);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'owner.release.stop-error')?.payload,
    { err: 'release stop failed', owner: 'reactive', pathfinderIdle: true },
  );
});

test('ReactiveController suppresses hazard item use when pathfinder stop throws', () => {
  const bot = makeControllerBot();
  bot.pathfinderOwner.stop = function stop(token) {
    if (this.token !== token) return false;
    this.stopCalls++;
    throw new Error('pathfinder stop failed');
  };
  const errors = [];
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error(event, payload) { errors.push({ event, payload }); },
    fatal() {},
  };

  controller.lastTick = 0;
  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.equal(bot.pathfinderOwner.currentOwner(), 'reactive');
  assert.equal(bot.pathfinderOwner.stopCalls, 1);
  assert.equal(bot.autoEat.enabled, false);
  assert.equal(bot.autoEat.disableCalls, 1);
  assert.equal(bot.autoEat.cancelCalls, 1);
  assert.equal(bot.deactivateCalls, 1);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'hazard.stop-error')?.payload,
    { err: 'pathfinder stop failed', owner: 'reactive', pathfinderIdle: true },
  );
});

test('ReactiveController suppresses hazard item use when token acquisition throws', () => {
  const bot = makeControllerBot();
  bot.pathfinderOwner.acquire = () => {
    throw new Error('owner bus unavailable');
  };
  const errors = [];
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error(event, payload) { errors.push({ event, payload }); },
    fatal() {},
  };

  controller.lastTick = 0;
  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.equal(bot.autoEat.enabled, false);
  assert.equal(bot.autoEat.disableCalls, 1);
  assert.equal(bot.autoEat.cancelCalls, 1);
  assert.equal(bot.deactivateCalls, 1);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'owner.acquire-error')?.payload,
    { reason: 'HAZARD', err: 'owner bus unavailable', owner: null, pathfinderIdle: true },
  );
});

test('ReactiveController marks normal before resuming auto-eat after hazard', async () => {
  const bot = makeControllerBot();
  const controller = new ReactiveController(bot);

  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.equal(bot.autoEat.cancelCalls, 1);

  bot.autoEat.emitEatStartOnEnable = true;
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  controller.lastTick = 0;
  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(bot.pathfinderOwner.currentOwner(), null);
  assert.equal(bot.pathfinderOwner.releaseCalls, 1);
  assert.equal(bot.autoEat.enabled, true);
  assert.equal(bot.autoEat.enableCalls, 2);
  assert.equal(bot.autoEat.cancelCalls, 1);
});

test('ReactiveController retries auto-eat resume after enable failure', () => {
  const bot = makeControllerBot();
  const warnings = [];
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) {
      warnings.push({ event, payload });
    },
    error() {},
    fatal() {},
  };

  controller.lastTick = 0;
  controller._tick();
  assert.equal(controller.state, REACTIVE_STATE.HAZARD);
  assert.equal(controller._autoEatSuppressed, true);
  assert.equal(bot.autoEat.enabled, false);

  let failEnable = true;
  bot.autoEat.enableAuto = function enableAuto() {
    this.enableCalls++;
    if (failEnable) throw new Error('enable failed');
    this.enabled = true;
  };
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  controller.lastTick = 0;

  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(bot.autoEat.enabled, false);
  assert.equal(controller._autoEatSuppressed, true);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'autoeat.resume-error')?.payload,
    { reason: 'hazard-cleared', err: 'enable failed' },
  );

  failEnable = false;
  controller._resumeAutoEat('retry');

  assert.equal(bot.autoEat.enabled, true);
  assert.equal(controller._autoEatSuppressed, false);
  assert.equal(bot.autoEat.enableCalls, 3);
});
