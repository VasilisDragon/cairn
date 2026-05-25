import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { ReactiveController, REACTIVE_STATE } from '../../src/reactive/reactive.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

async function captureStdoutRecords(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const chunks = [];
  function write(chunk, encoding, callback) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  }
  process.stdout.write = write;
  process.stderr.write = write;
  try {
    const value = await fn();
    const records = chunks.join('')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { value, records };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

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

function makePathfinderOwner() {
  return {
    current: null,
    token: null,
    setGoalCalls: [],
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
    setGoal(...args) {
      this.setGoalCalls.push(args);
      return true;
    },
    stop() {
      return true;
    },
    currentOwner() {
      return this.current;
    },
    isIdle() {
      return true;
    },
  };
}

class ListenerFailureBot extends EventEmitter {
  constructor({ autoEat = null, failBotEvents = [] } = {}) {
    super();
    this.failBotEvents = new Set(failBotEvents);
    Object.assign(this, {
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
      autoEat,
      usingHeldItem: false,
      pvp: { stop() {}, attack() {} },
      pathfinderOwner: makePathfinderOwner(),
      blockAt(p) {
        return { name: 'stone', position: p, boundingBox: 'block' };
      },
    });
  }

  on(eventName, listener) {
    if (this.failBotEvents.has(eventName)) {
      throw new Error(`${eventName} listener unavailable`);
    }
    return super.on(eventName, listener);
  }
}

class AutoEatListenerFailure extends EventEmitter {
  constructor(failEvents = []) {
    super();
    this.failEvents = new Set(failEvents);
    this.enabled = false;
    this.isEating = false;
    this.enableCalls = 0;
    this.setOptsCalls = 0;
  }

  setOpts(opts) {
    this.opts = opts;
    this.setOptsCalls++;
  }

  enableAuto() {
    this.enabled = true;
    this.enableCalls++;
  }

  on(eventName, listener) {
    if (this.failEvents.has(eventName)) {
      throw new Error(`${eventName} listener unavailable`);
    }
    return super.on(eventName, listener);
  }
}

test('ReactiveController isolates bot listener registration failures during startup', async () => {
  const bot = new ListenerFailureBot({ failBotEvents: ['physicsTick'] });

  const { value: controller, records } = await captureStdoutRecords(() => new ReactiveController(bot));

  assert.equal(controller instanceof ReactiveController, true);
  assert.equal(bot.listenerCount('physicsTick'), 0);
  assert.equal(bot.listenerCount('death'), 1);
  assert.equal(bot.listenerCount('end'), 1);
  assert.equal(records.some((record) => (
    record.evt === 'reactive.listener-error'
      && record.source === 'bot'
      && record.event === 'physicsTick'
      && record.err === 'physicsTick listener unavailable'
  )), true);

  controller.state = REACTIVE_STATE.HAZARD;
  bot.emit('death');
  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
});

test('ReactiveController isolates auto-eat listener registration failures during startup', async () => {
  const autoEat = new AutoEatListenerFailure(['eatStart']);
  const bot = new ListenerFailureBot({ autoEat });

  const { value: controller, records } = await captureStdoutRecords(() => new ReactiveController(bot));

  assert.equal(controller instanceof ReactiveController, true);
  assert.equal(autoEat.setOptsCalls, 1);
  assert.equal(autoEat.enableCalls, 1);
  assert.equal(autoEat.enabled, true);
  assert.equal(autoEat.listenerCount('eatStart'), 0);
  assert.equal(autoEat.listenerCount('eatFinish'), 1);
  assert.equal(autoEat.listenerCount('eatFail'), 1);
  assert.equal(records.some((record) => (
    record.evt === 'reactive.listener-error'
      && record.source === 'autoEat'
      && record.event === 'eatStart'
      && record.err === 'eatStart listener unavailable'
  )), true);

  assert.doesNotThrow(() => autoEat.emit('eatFinish', { food: { name: 'apple' } }));
});

test('ReactiveController isolates auto-eat option setup failures during startup', async () => {
  const autoEat = new AutoEatListenerFailure();
  autoEat.setOpts = function setOpts() {
    this.setOptsCalls++;
    throw new Error('auto-eat options rejected');
  };
  const bot = new ListenerFailureBot({ autoEat });

  const { value: controller, records } = await captureStdoutRecords(() => new ReactiveController(bot));

  assert.equal(controller instanceof ReactiveController, true);
  assert.equal(autoEat.setOptsCalls, 1);
  assert.equal(autoEat.enableCalls, 1);
  assert.equal(autoEat.enabled, true);
  assert.equal(autoEat.listenerCount('eatStart'), 1);
  assert.equal(autoEat.listenerCount('eatFinish'), 1);
  assert.equal(autoEat.listenerCount('eatFail'), 1);
  assert.equal(records.some((record) => (
    record.evt === 'autoeat.setopts-error'
      && record.err === 'auto-eat options rejected'
  )), true);
});

test('ReactiveController fails closed when movement setup fails during startup', async () => {
  const bot = new ListenerFailureBot();
  const zombie = { id: 1, name: 'zombie', position: pos(6, 64, 0) };
  bot.registry = null;
  bot.entities = { [zombie.id]: zombie };

  const { value: controller, records } = await captureStdoutRecords(() => {
    const c = new ReactiveController(bot);
    c.lastTick = 0;
    c.hostileScanCounter = 4;
    c._tick();
    return c;
  });

  assert.equal(controller instanceof ReactiveController, true);
  assert.equal(controller._movements, null);
  assert.equal(controller._fleeMovements, null);
  assert.equal(bot.pathfinderOwner.setGoalCalls.length, 0);
  assert.equal(records.some((record) => record.evt === 'reactive.movements.error'), true);
  assert.equal(records.some((record) => record.evt === 'flee.movements.error'), true);
  assert.equal(records.some((record) => (
    record.evt === 'flee.movements-unavailable'
      && record.entity === 'zombie'
      && record.entityId === 1
  )), true);
});
