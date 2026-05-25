import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { ReactiveController, REACTIVE_STATE } from '../../src/reactive/reactive.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
    offset(dx, dy, dz) {
      return pos(this.x + dx, this.y + dy, this.z + dz);
    },
    floored() {
      return pos(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
    },
  };
}

function entity(id, name, x, y, z) {
  return { id, name, position: pos(x, y, z) };
}

function makeAutoEat() {
  const autoEat = new EventEmitter();
  Object.assign(autoEat, {
    enabled: false,
    isEating: true,
    enableCalls: 0,
    disableCalls: 0,
    cancelCalls: 0,
    setOpts(opts) {
      this.opts = opts;
    },
    enableAuto() {
      this.enabled = true;
      this.enableCalls++;
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
  return autoEat;
}

function makePathfinderOwner() {
  return {
    current: null,
    token: null,
    acquireCalls: [],
    setGoalCalls: [],
    stopCalls: 0,
    acquire(owner, { reason } = {}) {
      this.current = owner;
      this.reason = reason;
      this.token = { owner, reason };
      this.acquireCalls.push({ owner, reason });
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
    setGoal(token, goal, opts) {
      if (token !== this.token) return false;
      this.setGoalCalls.push({ goal, opts });
      return true;
    },
    stop(token) {
      if (token !== this.token) return false;
      this.stopCalls++;
      return true;
    },
    currentOwner() {
      return this.current;
    },
    isIdle() {
      return this.setGoalCalls.length === 0;
    },
  };
}

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  const pvp = {
    attackCalls: [],
    stopCalls: 0,
    attack(target) {
      this.attackCalls.push(target);
    },
    stop() {
      this.stopCalls++;
    },
  };
  Object.assign(bot, {
    registry: TEST_REGISTRY,
    entity: {
      id: 'bot',
      position: pos(0, 64, 0),
      yaw: 0,
      onGround: true,
      velocity: { y: 0 },
    },
    entities: {},
    health: 20,
    food: 20,
    autoEat: null,
    usingHeldItem: false,
    deactivateCalls: 0,
    heldItem: null,
    pvp,
    pathfinderOwner: makePathfinderOwner(),
    quitCalls: [],
    quit(reason) {
      this.quitCalls.push(reason);
    },
    deactivateItem() {
      this.deactivateCalls++;
      this.usingHeldItem = false;
    },
    blockAt(p) {
      return { name: 'stone', position: p, boundingBox: 'block' };
    },
    ...overrides,
  });
  return bot;
}

test('low health forces flee instead of engage even when armed', () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const bot = makeBot({
    entities: { [zombie.id]: zombie },
    health: 8,
    heldItem: { name: 'iron_sword' },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    lowHealthFleeThreshold: 8,
    hostileScanRadius: 16,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(bot.pathfinderOwner.currentOwner(), 'reactive');
  assert.equal(bot.pathfinderOwner.acquireCalls.at(-1).reason, 'FLEEING');
  assert.equal(bot.pathfinderOwner.setGoalCalls.length, 1);
  assert.equal(bot.pvp.attackCalls.length, 0);
});

test('critical health logout is idempotent and cancels active eating before quit', () => {
  const bot = makeBot({
    autoEat: makeAutoEat(),
    health: 4,
    food: 12,
    usingHeldItem: true,
  });
  const controller = new ReactiveController(bot);
  controller.lastTick = 0;

  controller._tick();
  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.EMERGENCY);
  assert.equal(controller.shuttingDown, true);
  assert.deepEqual(bot.quitCalls, ['emergency:critical-health']);
  assert.equal(bot.pathfinderOwner.currentOwner(), 'reactive');
  assert.equal(bot.pathfinderOwner.acquireCalls.length, 1);
  assert.equal(bot.pathfinderOwner.acquireCalls[0].reason, 'EMERGENCY');
  assert.equal(bot.autoEat.enabled, false);
  assert.equal(bot.autoEat.disableCalls, 1);
  assert.equal(bot.autoEat.cancelCalls, 1);
  assert.equal(bot.deactivateCalls, 1);
  assert.equal(bot.usingHeldItem, false);
});

test('critical health logout reports quit failures without retrying', () => {
  const errors = [];
  const bot = makeBot({
    health: 4,
    quit(reason) {
      this.quitCalls.push(reason);
      throw new Error('socket already closed');
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    fatal() {},
    error(event, payload) { errors.push({ event, payload }); },
  };
  controller.lastTick = 0;

  assert.doesNotThrow(() => controller._tick());
  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.EMERGENCY);
  assert.equal(controller.shuttingDown, true);
  assert.deepEqual(bot.quitCalls, ['emergency:critical-health']);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'emergency.logout-error')?.payload,
    { health: 4, err: 'socket already closed' },
  );
});

test('critical health logout continues when token acquisition throws', () => {
  const errors = [];
  const bot = makeBot({
    autoEat: makeAutoEat(),
    health: 4,
    usingHeldItem: true,
  });
  bot.pathfinderOwner.acquire = () => {
    throw new Error('owner bus unavailable');
  };
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    fatal() {},
    error(event, payload) { errors.push({ event, payload }); },
  };
  controller.lastTick = 0;

  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.EMERGENCY);
  assert.equal(controller.shuttingDown, true);
  assert.deepEqual(bot.quitCalls, ['emergency:critical-health']);
  assert.equal(bot.autoEat.enabled, false);
  assert.equal(bot.autoEat.cancelCalls, 1);
  assert.equal(bot.deactivateCalls, 1);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'owner.acquire-error')?.payload,
    { reason: 'EMERGENCY', err: 'owner bus unavailable', owner: null, pathfinderIdle: true },
  );
});
