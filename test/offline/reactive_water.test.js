import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import {
  buildWaterEscapeRecord,
  findNearestDryLand,
  ReactiveController,
  REACTIVE_STATE,
  scanWaterHazard,
  waterEscapeClearStatus,
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

function block(name, extra = {}) {
  return {
    name,
    boundingBox: name === 'air' ? 'empty' : 'block',
    isWaterlogged: false,
    ...extra,
  };
}

function makeBot({ blocks = {}, isInWater = false, velocityY = 0, oxygenLevel = 20 } = {}) {
  const blockMap = new Map(Object.entries(blocks));
  return {
    entity: {
      position: new Pos(0, 64, 0),
      isInWater,
      velocity: { y: velocityY },
    },
    oxygenLevel,
    pathfinderOwner: {
      currentOwner: () => 'reactive',
      isIdle: () => true,
    },
    health: 18,
    food: 17,
    blockAt(p) {
      return blockMap.get(key(p.x, p.y, p.z)) || block('air');
    },
  };
}

function makeControllerBot({ setControlState } = {}) {
  const bot = new EventEmitter();
  const pathfinderOwner = {
    current: null,
    token: null,
    stopCalls: 0,
    acquire(owner, { reason } = {}) {
      this.current = owner;
      this.reason = reason;
      this.token = { owner, reason };
      const token = this.token;
      return {
        token,
        release: () => {
          if (this.token !== token) return;
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

  Object.assign(bot, {
    registry: TEST_REGISTRY,
    entity: {
      id: 'bot',
      position: new Pos(0, 64, 0),
      isInWater: true,
      velocity: { y: -0.12 },
      yaw: 0,
      onGround: true,
    },
    oxygenLevel: 12,
    entities: {},
    health: 18,
    food: 17,
    autoEat: null,
    usingHeldItem: false,
    pvp: { stop() {}, attack() {} },
    pathfinderOwner,
    blockAt() {
      return block('water');
    },
    setControlState,
  });
  return bot;
}

test('scanWaterHazard ignores shallow water when oxygen is full and bot is not sinking', () => {
  const bot = makeBot({
    blocks: { [key(0, 64, 0)]: block('water') },
    isInWater: true,
    velocityY: 0,
    oxygenLevel: 20,
  });

  assert.equal(scanWaterHazard(bot), null);
});

test('ReactiveController promotes level shallow-water stall into water escape', () => {
  const originalNow = Date.now;
  let now = 1000;
  const controls = [];
  const transitions = [];
  const blocks = new Map([
    [key(0, 64, 0), 'water'],
    [key(0, 65, 0), 'air'],
    [key(2, 63, 0), 'grass_block'],
    [key(2, 64, 0), 'air'],
    [key(2, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState(control, value) {
      controls.push({ control, value });
    },
  });
  bot.entity.velocity.y = 0;
  bot.oxygenLevel = 20;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'air');
  bot.lookAt = () => {};
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) {
      if (event === 'state.transition') transitions.push(payload);
    },
    warn() {},
    error() {},
    fatal() {},
  };

  try {
    Date.now = () => now;
    controller._tick();
    assert.equal(controller.state, REACTIVE_STATE.NORMAL);

    now += 2600;
    controller._tick();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(controller.state, REACTIVE_STATE.WATER_ESCAPE);
  assert.equal(transitions.at(-1)?.reason, 'water-escape');
  assert.equal(transitions.at(-1)?.holdReason, 'shallow-water-stall');
  assert.deepEqual(controls.map((call) => call.control), ['forward', 'jump', 'sprint', 'sneak']);
});

test('ReactiveController promotes stationary surface-floating water into water escape', () => {
  const originalNow = Date.now;
  let now = 1000;
  const controls = [];
  const transitions = [];
  const blocks = new Map([
    [key(0, 63, 0), 'water'],
    [key(0, 64, 0), 'air'],
    [key(0, 65, 0), 'air'],
    [key(2, 63, 0), 'grass_block'],
    [key(2, 64, 0), 'air'],
    [key(2, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState(control, value) {
      controls.push({ control, value });
    },
  });
  bot.entity.position = new Pos(0.25, 64.05, 0.25);
  bot.entity.isInWater = false;
  bot.entity.onGround = false;
  bot.entity.velocity.y = 0;
  bot.oxygenLevel = 20;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'air');
  bot.lookAt = () => {};
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) {
      if (event === 'state.transition') transitions.push(payload);
    },
    warn() {},
    error() {},
    fatal() {},
  };

  try {
    Date.now = () => now;
    controller._tick();
    assert.equal(controller.state, REACTIVE_STATE.NORMAL);

    now += 2600;
    controller._tick();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(controller.state, REACTIVE_STATE.WATER_ESCAPE);
  assert.equal(transitions.at(-1)?.holdReason, 'surface-water-stall');
  assert.deepEqual(controls.map((call) => call.control), ['forward', 'jump', 'sprint', 'sneak']);
});

test('ReactiveController promotes shallow-water stall despite vertical bobbing', () => {
  const originalNow = Date.now;
  let now = 1000;
  const controls = [];
  const transitions = [];
  const blocks = new Map([
    [key(0, 64, 0), 'water'],
    [key(0, 65, 0), 'air'],
    [key(2, 63, 0), 'grass_block'],
    [key(2, 64, 0), 'air'],
    [key(2, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState(control, value) {
      controls.push({ control, value });
    },
  });
  bot.entity.position = new Pos(0.25, 64.05, 0.25);
  bot.entity.velocity.y = 0.08;
  bot.oxygenLevel = 20;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'air');
  bot.lookAt = () => {};
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) {
      if (event === 'state.transition') transitions.push(payload);
    },
    warn() {},
    error() {},
    fatal() {},
  };

  try {
    Date.now = () => now;
    controller._tick();
    assert.equal(controller.state, REACTIVE_STATE.NORMAL);

    bot.entity.position = new Pos(0.25, 64.35, 0.25);
    now += 2600;
    controller._tick();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(controller.state, REACTIVE_STATE.WATER_ESCAPE);
  assert.equal(transitions.at(-1)?.holdReason, 'shallow-water-stall');
  assert.deepEqual(controls.map((call) => call.control), ['forward', 'jump', 'sprint', 'sneak']);
});

test('ReactiveController does not treat grounded dry space over water as surface-floating', () => {
  const originalNow = Date.now;
  let now = 1000;
  const blocks = new Map([
    [key(0, 63, 0), 'water'],
    [key(0, 64, 0), 'air'],
    [key(0, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot();
  bot.entity.position = new Pos(0.25, 64.05, 0.25);
  bot.entity.isInWater = false;
  bot.entity.onGround = true;
  bot.entity.velocity.y = 0;
  bot.oxygenLevel = 20;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'air');
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error() {},
    fatal() {},
  };

  try {
    Date.now = () => now;
    controller._tick();
    now += 2600;
    controller._tick();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
});

test('scanWaterHazard holds water escape until the bot is actually out of water', () => {
  const bot = makeBot({
    blocks: { [key(0, 64, 0)]: block('water') },
    isInWater: true,
    velocityY: 0,
    oxygenLevel: 20,
  });

  const water = scanWaterHazard(bot, { holdInWater: true });

  assert.equal(water.kind, 'water_escape');
  assert.equal(water.holdingInWater, true);
  assert.equal(water.submerged, false);
  assert.equal(water.sinking, false);
  assert.equal(water.oxygenLow, false);
});

test('scanWaterHazard detects submersion before oxygen is depleted', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 65, 0)]: block('water'),
    },
    isInWater: true,
    velocityY: 0,
    oxygenLevel: 20,
  });

  const water = scanWaterHazard(bot);

  assert.equal(water.kind, 'water_escape');
  assert.equal(water.submerged, true);
  assert.equal(water.oxygenLow, false);
});

test('scanWaterHazard detects oxygen depletion through Mineflayer oxygenLevel', () => {
  const bot = makeBot({ isInWater: true, oxygenLevel: 12 });

  const water = scanWaterHazard(bot);

  assert.equal(water.kind, 'water_escape');
  assert.equal(water.oxygenLow, true);
  assert.equal(water.oxygenLevel, 12);
});

test('scanWaterHazard ignores low oxygen after reaching readable dry air', () => {
  const bot = makeBot({ oxygenLevel: 12 });

  assert.equal(scanWaterHazard(bot), null);
});

test('scanWaterHazard preserves direct oxygen detection when block reads fail', () => {
  const bot = makeBot({ oxygenLevel: 12 });
  bot.blockAt = () => {
    throw new Error('chunk cache unavailable');
  };

  const water = scanWaterHazard(bot);

  assert.equal(water.kind, 'water_escape');
  assert.equal(water.oxygenLow, true);
  assert.equal(water.oxygenLevel, 12);
});

test('scanWaterHazard detects sinking in water', () => {
  const bot = makeBot({ isInWater: true, velocityY: -0.12, oxygenLevel: 20 });

  const water = scanWaterHazard(bot);

  assert.equal(water.kind, 'water_escape');
  assert.equal(water.sinking, true);
});

test('scanWaterHazard labels entity-only water over surface contact', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 63, 0)]: block('water'),
    },
    isInWater: true,
    velocityY: -0.08,
    oxygenLevel: 20,
  });

  const water = scanWaterHazard(bot);

  assert.equal(water.kind, 'water_escape');
  assert.equal(water.holdReason, 'surface-water-stall');
  assert.equal(water.surfaceWaterContact, true);
  assert.equal(water.submerged, false);
});

test('findNearestDryLand prefers nearby dry land with solid support', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('water'),
      [key(2, 63, 0)]: block('grass_block'),
      [key(2, 64, 0)]: block('air'),
      [key(2, 65, 0)]: block('air'),
    },
    isInWater: true,
  });

  const target = findNearestDryLand(bot, 4);

  assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: 2, y: 64, z: 0 });
});

test('findNearestDryLand accepts dry shore vegetation as passable body space', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('water'),
      [key(2, 63, 0)]: block('grass_block'),
      [key(2, 64, 0)]: block('short_grass', { boundingBox: 'empty' }),
      [key(2, 65, 0)]: block('air'),
    },
    isInWater: true,
  });

  const target = findNearestDryLand(bot, 4);

  assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: 2, y: 64, z: 0 });
});

test('findNearestDryLand skips unreadable candidates instead of throwing', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('water'),
      [key(2, 63, 0)]: block('grass_block'),
      [key(2, 64, 0)]: block('air'),
      [key(2, 65, 0)]: block('air'),
    },
    isInWater: true,
  });
  const originalBlockAt = bot.blockAt;
  bot.blockAt = (p) => {
    if (Math.floor(p.x) === 1) throw new Error('candidate column unavailable');
    return originalBlockAt(p);
  };

  const target = findNearestDryLand(bot, 4);

  assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: 2, y: 64, z: 0 });
});

test('findNearestDryLand prefers an inland landing over a water-edge block', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('water'),
      [key(1, 63, 0)]: block('grass_block'),
      [key(1, 64, 0)]: block('air'),
      [key(1, 65, 0)]: block('air'),
      [key(3, 63, 0)]: block('grass_block'),
      [key(3, 64, 0)]: block('air'),
      [key(3, 65, 0)]: block('air'),
    },
    isInWater: true,
  });

  const target = findNearestDryLand(bot, 4);

  assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: 3, y: 64, z: 0 });
});

test('findNearestDryLand prefers dry land away from nearby threats when provided', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('water'),
      [key(1, 63, 0)]: block('grass_block'),
      [key(1, 64, 0)]: block('air'),
      [key(1, 65, 0)]: block('air'),
      [key(-3, 63, 0)]: block('grass_block'),
      [key(-3, 64, 0)]: block('air'),
      [key(-3, 65, 0)]: block('air'),
    },
    isInWater: true,
  });
  const target = findNearestDryLand(bot, 4, {
    avoidThreats: [{ position: new Pos(2, 64, 0) }],
  });

  assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: -3, y: 64, z: 0 });
});

test('findNearestDryLand skips shore exits too high from the current water level', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 62, 0)]: block('water'),
      [key(1, 63, 0)]: block('grass_block'),
      [key(1, 64, 0)]: block('air'),
      [key(1, 65, 0)]: block('air'),
      [key(4, 62, 0)]: block('grass_block'),
      [key(4, 63, 0)]: block('air'),
      [key(4, 64, 0)]: block('air'),
    },
    isInWater: true,
  });
  bot.entity.position = new Pos(0.4, 62.7, 0.4);

  const target = findNearestDryLand(bot, 5, { maxRiseFromCurrentY: 1 });

  assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: 4, y: 63, z: 0 });
});

test('findNearestDryLand can avoid a recently stalled shore target', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('water'),
      [key(2, 63, 0)]: block('grass_block'),
      [key(2, 64, 0)]: block('air'),
      [key(2, 65, 0)]: block('air'),
      [key(4, 63, 0)]: block('grass_block'),
      [key(4, 64, 0)]: block('air'),
      [key(4, 65, 0)]: block('air'),
    },
    isInWater: true,
  });

  const target = findNearestDryLand(bot, 5, { avoidTargets: [new Pos(2, 64, 0)] });

  assert.deepEqual({ x: target.x, y: target.y, z: target.z }, { x: 4, y: 64, z: 0 });
});

test('waterEscapeClearStatus requires stable dry ground before clearing', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 63, 0)]: block('grass_block'),
      [key(0, 64, 0)]: block('air'),
      [key(0, 65, 0)]: block('air'),
    },
    isInWater: false,
  });
  bot.entity.onGround = true;

  const pending = waterEscapeClearStatus(bot, 0, 1000, 800);
  assert.equal(pending.ready, false);
  assert.equal(pending.reason, 'waiting-for-stable-dry-ground');
  assert.equal(pending.clearSince, 1000);

  const ready = waterEscapeClearStatus(bot, pending.clearSince, 1801, 800);
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, 'stable-dry-ground');
  assert.equal(ready.stableForMs, 801);
});

test('ReactiveController clears water escape from stable dry ground despite stale low oxygen', () => {
  const transitions = [];
  const controls = [];
  const humanizedControls = [];
  const bot = makeControllerBot({
    setControlState(control, value) {
      controls.push({ control, value });
    },
  });
  bot.humanizer = {
    setControlState(targetBot, control, value, opts = {}) {
      humanizedControls.push({ control, value, reason: opts.reason, critical: opts.critical === true });
      return targetBot.setControlState(control, value);
    },
  };
  bot.entity.isInWater = false;
  bot.entity.velocity = { y: 0 };
  bot.entity.onGround = true;
  bot.oxygenLevel = 12;
  bot.blockAt = (p) => {
    const k = key(p.x, p.y, p.z);
    if (k === key(0, 63, 0)) return block('grass_block');
    return block('air');
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) {
      if (event === 'state.transition') transitions.push(payload);
    },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.state = REACTIVE_STATE.WATER_ESCAPE;
  controller._waterEscapeClearSince = Date.now() - 1000;
  controller.lastTick = 0;

  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(transitions.at(-1)?.reason, 'water-cleared');
  assert.ok(controls.some((call) => call.control === 'jump' && call.value === false));
  assert.ok(humanizedControls.some((call) => (
    call.control === 'jump' &&
    call.value === false &&
    call.reason === 'water_escape.clear' &&
    call.critical === true
  )));
});

test('waterEscapeClearStatus refuses to clear while body space still contains water', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 63, 0)]: block('grass_block'),
      [key(0, 64, 0)]: block('water'),
      [key(0, 65, 0)]: block('air'),
    },
    isInWater: false,
  });
  bot.entity.onGround = true;

  const status = waterEscapeClearStatus(bot, 1000, 1801, 800);

  assert.equal(status.ready, false);
  assert.equal(status.clearSince, 0);
  assert.equal(status.reason, 'water-block-present');
});

test('waterEscapeClearStatus allows dry vegetation on otherwise stable shore', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 63, 0)]: block('grass_block'),
      [key(0, 64, 0)]: block('short_grass', { boundingBox: 'empty' }),
      [key(0, 65, 0)]: block('air'),
    },
    isInWater: false,
  });
  bot.entity.onGround = true;

  const status = waterEscapeClearStatus(bot, 1000, 1801, 800);

  assert.equal(status.ready, true);
  assert.equal(status.reason, 'stable-dry-ground');
});

test('buildWaterEscapeRecord includes state, target, and survival context', () => {
  const bot = makeBot({ isInWater: true, velocityY: -0.2, oxygenLevel: 10 });
  const water = scanWaterHazard(bot);
  const target = new Pos(2, 64, 0);

  const record = buildWaterEscapeRecord(bot, water, target);

  assert.deepEqual(Object.keys(record).sort(), [
    'botPos',
    'food',
    'health',
    'inWater',
    'kind',
    'owner',
    'oxygenLevel',
    'oxygenLow',
    'pathfinderIdle',
    'sinking',
    'submerged',
    'target',
    'velocityY',
  ]);
  assert.equal(record.kind, 'water_escape');
  assert.equal(record.oxygenLevel, 10);
  assert.deepEqual(record.target, { x: 2, y: 64, z: 0 });
});

test('buildWaterEscapeRecord reports pathfinder context read failures', () => {
  const bot = makeBot({ isInWater: true, velocityY: -0.2, oxygenLevel: 10 });
  bot.pathfinderOwner = {
    currentOwner() {
      throw new Error('owner unavailable');
    },
    isIdle() {
      throw new Error('idle unavailable');
    },
  };
  const water = scanWaterHazard(bot);

  const record = buildWaterEscapeRecord(bot, water, null);

  assert.equal(record.owner, null);
  assert.equal(record.ownerError, 'owner unavailable');
  assert.equal(record.pathfinderIdle, null);
  assert.equal(record.pathfinderIdleError, 'idle unavailable');
});

test('ReactiveController isolates water escape control write failures', () => {
  const calls = [];
  const warnings = [];
  const bot = makeControllerBot({
    setControlState(control, value) {
      calls.push({ control, value });
      if (control === 'jump') throw new Error('control bus unavailable');
    },
  });
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
  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.WATER_ESCAPE);
  assert.deepEqual(calls.map((call) => call.control), ['forward', 'jump', 'sprint', 'sneak']);
  const controlWarnings = warnings.filter((entry) => entry.event === 'water_escape.control-error');
  assert.equal(controlWarnings.length, 1);
  assert.equal(controlWarnings[0].payload.control, 'jump');
  assert.equal(controlWarnings[0].payload.err, 'control bus unavailable');
});

test('ReactiveController reports water escape lookAt failures', async () => {
  const calls = [];
  const warnings = [];
  const bot = makeControllerBot({
    setControlState(control, value) {
      calls.push({ control, value });
    },
  });
  bot.blockAt = (p) => {
    const k = key(p.x, p.y, p.z);
    if (k === key(2, 63, 0)) return block('grass_block');
    if (k === key(2, 64, 0) || k === key(2, 65, 0)) return block('air');
    return block('water');
  };
  bot.lookAt = () => Promise.reject(new Error('look failed'));
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
  assert.doesNotThrow(() => controller._tick());
  await Promise.resolve();

  assert.equal(controller.state, REACTIVE_STATE.WATER_ESCAPE);
  assert.deepEqual(calls.map((call) => call.control), ['forward', 'jump', 'sprint', 'sneak']);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'water_escape.look-error')?.payload,
    { err: 'look failed' },
  );
});

test('ReactiveController keeps a usable water escape target briefly instead of head-snapping', () => {
  const looks = [];
  const blocks = new Map([
    [key(0, 64, 0), 'water'],
    [key(4, 63, 0), 'grass_block'],
    [key(4, 64, 0), 'air'],
    [key(4, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState() {},
  });
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'water');
  bot.lookAt = (target) => {
    looks.push({ x: target.x, y: target.y, z: target.z });
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error() {},
    fatal() {},
  };
  const water = scanWaterHazard(bot, { holdInWater: true });

  controller._applyWaterEscape(water, 1000);
  blocks.set(key(1, 63, 0), 'grass_block');
  blocks.set(key(1, 64, 0), 'air');
  blocks.set(key(1, 65, 0), 'air');
  controller._applyWaterEscape(water, 1500);

  assert.equal(looks.length, 2);
  assert.deepEqual(looks.map((target) => target.x), [4.5, 4.5]);
});

test('ReactiveController relocks water escape when the bot floats level without progress', () => {
  const looks = [];
  const warnings = [];
  const blocks = new Map([
    [key(0, 64, 0), 'water'],
    [key(2, 63, 0), 'grass_block'],
    [key(2, 64, 0), 'air'],
    [key(2, 65, 0), 'air'],
    [key(4, 63, 0), 'grass_block'],
    [key(4, 64, 0), 'air'],
    [key(4, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState() {},
  });
  bot.entity.velocity.y = -0.005;
  bot.oxygenLevel = 300;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'water');
  bot.lookAt = (target) => {
    looks.push({ x: target.x, y: target.y, z: target.z });
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) {
      warnings.push({ event, payload });
    },
    error() {},
    fatal() {},
  };
  const water = scanWaterHazard(bot, { holdInWater: true });

  controller._applyWaterEscape(water, 1000);
  controller._applyWaterEscape(water, 3600);

  assert.equal(looks.length, 2);
  assert.deepEqual(looks.map((target) => target.x), [2.5, 4.5]);
  assert.equal(warnings.some((entry) => entry.event === 'water_escape.target-stalled'), true);
});

test('ReactiveController treats vertical bobbing without horizontal progress as water escape stall', () => {
  const looks = [];
  const warnings = [];
  const blocks = new Map([
    [key(0, 64, 0), 'water'],
    [key(2, 63, 0), 'grass_block'],
    [key(2, 64, 0), 'air'],
    [key(2, 65, 0), 'air'],
    [key(4, 63, 0), 'grass_block'],
    [key(4, 64, 0), 'air'],
    [key(4, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState() {},
  });
  bot.entity.velocity.y = 0.08;
  bot.oxygenLevel = 300;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'water');
  bot.lookAt = (target) => {
    looks.push({ x: target.x, y: target.y, z: target.z });
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) {
      warnings.push({ event, payload });
    },
    error() {},
    fatal() {},
  };
  const water = scanWaterHazard(bot, { holdInWater: true });

  controller._applyWaterEscape(water, 1000);
  bot.entity.position = new Pos(0, 64.35, 0);
  controller._applyWaterEscape(water, 3600);

  assert.equal(looks.length, 2);
  assert.deepEqual(looks.map((target) => target.x), [2.5, 4.5]);
  const stall = warnings.find((entry) => entry.event === 'water_escape.target-stalled');
  assert.ok(stall);
  assert.equal(stall.payload.horizontalUnmovedForMs >= 2500, true);
});

test('ReactiveController relocks close dry targets when edge bobbing stays in water', () => {
  const looks = [];
  const warnings = [];
  const blocks = new Map([
    [key(0, 64, 0), 'water'],
    [key(1, 63, 0), 'grass_block'],
    [key(1, 64, 0), 'air'],
    [key(1, 65, 0), 'air'],
    [key(4, 63, 0), 'grass_block'],
    [key(4, 64, 0), 'air'],
    [key(4, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState() {},
  });
  bot.entity.velocity.y = 0.08;
  bot.oxygenLevel = 300;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'water');
  bot.lookAt = (target) => {
    looks.push({ x: target.x, y: target.y, z: target.z });
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) {
      warnings.push({ event, payload });
    },
    error() {},
    fatal() {},
  };
  const water = scanWaterHazard(bot, { holdInWater: true });

  controller._applyWaterEscape(water, 1000);
  bot.entity.position = new Pos(0.56, 64.34, 0.22);
  controller._applyWaterEscape(water, 2000);
  bot.entity.position = new Pos(0.44, 64.12, -0.22);
  controller._applyWaterEscape(water, 3600);

  assert.equal(looks.length, 3);
  assert.deepEqual(looks.map((target) => target.x), [1.5, 1.5, 4.5]);
  const stall = warnings.find((entry) => entry.event === 'water_escape.target-stalled');
  assert.ok(stall);
  assert.equal(stall.payload.edgeTrap, true);
  assert.equal(stall.payload.closeInWaterForMs >= 2500, true);
});

test('ReactiveController fallback-swims away from a stalled water target when no dry target is visible', () => {
  const calls = [];
  const looks = [];
  const warnings = [];
  const blocks = new Map([
    [key(0, 64, 0), 'water'],
    [key(2, 63, 0), 'grass_block'],
    [key(2, 64, 0), 'air'],
    [key(2, 65, 0), 'air'],
  ]);
  const bot = makeControllerBot({
    setControlState(control, value) {
      calls.push({ control, value });
    },
  });
  bot.entity.velocity.y = 0.08;
  bot.oxygenLevel = 300;
  bot.blockAt = (p) => block(blocks.get(key(p.x, p.y, p.z)) || 'water');
  bot.lookAt = (target) => {
    looks.push({ x: target.x, y: target.y, z: target.z });
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) {
      warnings.push({ event, payload });
    },
    error() {},
    fatal() {},
  };
  const water = scanWaterHazard(bot, { holdInWater: true });

  controller._applyWaterEscape(water, 1000);
  bot.entity.position = new Pos(0, 64.35, 0);
  controller._applyWaterEscape(water, 3600);

  assert.equal(warnings.some((entry) => entry.event === 'water_escape.target-stalled'), true);
  assert.equal(warnings.some((entry) => entry.event === 'water_escape.fallback-swim'), true);
  assert.equal(calls.some((entry) => entry.control === 'forward' && entry.value === true), true);
  assert.equal(looks.at(-1).x < 0, true);
});

test('ReactiveController fallback-swims by facing when no dry target has ever been found', () => {
  const calls = [];
  const looks = [];
  const warnings = [];
  const bot = makeControllerBot({
    setControlState(control, value) {
      calls.push({ control, value });
    },
  });
  bot.entity.velocity.y = 0;
  bot.entity.yaw = 0;
  bot.oxygenLevel = 20;
  bot.blockAt = () => block('water');
  bot.lookAt = (target) => {
    looks.push({ x: target.x, y: target.y, z: target.z });
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) {
      warnings.push({ event, payload });
    },
    error() {},
    fatal() {},
  };
  const water = scanWaterHazard(bot, { holdInWater: true });

  controller._applyWaterEscape(water, 2001);

  assert.equal(warnings.some((entry) => entry.event === 'water_escape.fallback-swim'), true);
  assert.equal(warnings.find((entry) => entry.event === 'water_escape.fallback-swim')?.payload.stalledTarget, null);
  assert.equal(calls.some((entry) => entry.control === 'forward' && entry.value === true), true);
  assert.equal(calls.some((entry) => entry.control === 'jump' && entry.value === true), true);
  assert.equal(looks.at(-1).z < 0, true);
});

test('ReactiveController keeps escaping water when pathfinder stop throws', () => {
  const calls = [];
  const errors = [];
  const bot = makeControllerBot({
    setControlState(control, value) {
      calls.push({ control, value });
    },
  });
  bot.pathfinderOwner.stop = function stop(token) {
    if (this.token !== token) return false;
    this.stopCalls++;
    throw new Error('pathfinder stop failed');
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error(event, payload) { errors.push({ event, payload }); },
    fatal() {},
  };

  controller.lastTick = 0;
  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.WATER_ESCAPE);
  assert.equal(bot.pathfinderOwner.currentOwner(), 'reactive');
  assert.equal(bot.pathfinderOwner.stopCalls, 1);
  assert.deepEqual(calls.map((call) => call.control), ['forward', 'jump', 'sprint', 'sneak']);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'water_escape.stop-error')?.payload,
    { err: 'pathfinder stop failed', owner: 'reactive', pathfinderIdle: true },
  );
});

test('ReactiveController keeps escaping water when token acquisition throws', () => {
  const calls = [];
  const errors = [];
  const bot = makeControllerBot({
    setControlState(control, value) {
      calls.push({ control, value });
    },
  });
  bot.pathfinderOwner.acquire = () => {
    throw new Error('owner bus unavailable');
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error(event, payload) { errors.push({ event, payload }); },
    fatal() {},
  };

  controller.lastTick = 0;
  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.WATER_ESCAPE);
  assert.deepEqual(calls.map((call) => call.control), ['forward', 'jump', 'sprint', 'sneak']);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'owner.acquire-error')?.payload,
    { reason: 'WATER_ESCAPE', err: 'owner bus unavailable', owner: null, pathfinderIdle: true },
  );
});
