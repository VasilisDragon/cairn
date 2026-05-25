import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import config from '../../src/config.js';
import {
  ReactiveController,
  buildFleeTrackingRecord,
  evaluateFleeThreat,
  REACTIVE_STATE,
} from '../../src/reactive/reactive.js';

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

function entity(id, name, x, y, z, extra = {}) {
  return { id, name, position: pos(x, y, z), ...extra };
}

function botWithEntities(entities, botPos = pos(0, 64, 0)) {
  const byId = {};
  for (const e of entities) byId[e.id] = e;
  return {
    entity: { id: 'bot', position: botPos },
    entities: byId,
  };
}

function key(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

function reactiveBot(overrides = {}) {
  const { entity: entityOverrides = {}, ...rest } = overrides;
  const bot = new EventEmitter();
  const blocks = new Map(Object.entries(overrides.blocks || {}));
  Object.assign(bot, {
    registry: TEST_REGISTRY,
    entity: {
      id: 'bot',
      position: pos(0, 64, 0),
      yaw: 0,
      onGround: true,
      velocity: { y: 0 },
      equipment: [],
      ...entityOverrides,
    },
    entities: {},
    health: 20,
    food: 20,
    autoEat: null,
    pvp: { stop() {}, attack() {} },
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'reactive-test' }, release() {} }),
      setGoal: () => true,
      stop() {},
      currentOwner: () => null,
      isIdle: () => true,
    },
    blockAt(p) {
      return { name: blocks.get(key(p)) || 'stone', position: p };
    },
    ...rest,
  });
  return bot;
}

function armorEquipment(names = {}) {
  return [
    null,
    names.offHand ? { name: names.offHand } : null,
    names.feet ? { name: names.feet } : null,
    names.legs ? { name: names.legs } : null,
    names.torso ? { name: names.torso } : null,
    names.head ? { name: names.head } : null,
  ];
}

function reactiveFleeGoalScenario(setGoalImpl) {
  const zombie = entity(1, 'zombie', 8, 64, 0);
  const token = { id: 'reactive-flee-failed-goal' };
  const errors = [];
  const setGoalCalls = [];
  let currentOwner = null;
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    pathfinderOwner: {
      acquire(owner) {
        currentOwner = owner;
        return { token, release() { currentOwner = null; } };
      },
      setGoal(givenToken, goal, opts) {
        setGoalCalls.push({ givenToken, goal, opts });
        return setGoalImpl(givenToken, goal, opts);
      },
      stop() {},
      currentOwner: () => currentOwner,
      isIdle: () => true,
    },
  });

  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error(event, payload) { errors.push({ event, payload }); },
    fatal() {},
  };
  controller.lastTick = 0;
  controller.hostileScanCounter = 4;

  return { controller, errors, setGoalCalls, token, zombie };
}

test('reactive controller tracks recent health-loss pressure in a bounded window', () => {
  const bot = reactiveBot({ health: 20 });
  const controller = new ReactiveController(bot);
  controller.cfg = { ...controller.cfg, recentDamageWindowMs: 10000 };

  bot.health = 17;
  controller._recordRecentDamage(1000);
  assert.deepEqual(controller.recentDamagePressure(1000), {
    windowMs: 10000,
    totalDamage: 3,
    recentDamagePerSecond: 0.3,
    lastDamageMsAgo: 0,
  });

  bot.health = 15;
  controller._recordRecentDamage(5000);
  assert.deepEqual(controller.recentDamagePressure(5000), {
    windowMs: 10000,
    totalDamage: 5,
    recentDamagePerSecond: 0.5,
    lastDamageMsAgo: 0,
  });

  assert.deepEqual(controller.recentDamagePressure(12001), {
    windowMs: 10000,
    totalDamage: 2,
    recentDamagePerSecond: 0.2,
    lastDamageMsAgo: 7001,
  });
});

test('reactive flee movements install physical hazard exclusions', () => {
  const bot = reactiveBot({
    blocks: {
      [key(pos(9, 64, 0))]: 'lava',
    },
  });

  const controller = new ReactiveController(bot);
  const movements = controller._fleeMovements;
  const waterId = TEST_REGISTRY.blocksByName.water.id;

  for (const field of ['exclusionAreasStep', 'exclusionAreasBreak', 'exclusionAreasPlace']) {
    assert.equal(
      movements[field].some((exclusion) => exclusion({ name: 'lava', position: pos(8, 64, 0) }) === 100),
      true,
      `${field} should avoid direct physical hazards`,
    );
    assert.equal(
      movements[field].some((exclusion) => exclusion({ name: 'air', position: pos(8, 64, 0) }) === 100),
      true,
      `${field} should avoid blocks adjacent to physical hazards`,
    );
  }
  assert.equal(movements.liquidCost >= 80, true);
  assert.equal(movements.infiniteLiquidDropdownDistance, false);
  assert.equal(movements.blocksToAvoid.has(waterId), true);
});

test('reactive flee reports pathfinder goal install failures', () => {
  const { controller, errors, setGoalCalls, token, zombie } = reactiveFleeGoalScenario(() => false);

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(setGoalCalls.length, 1);
  assert.equal(setGoalCalls[0].givenToken, token);
  assert.equal(setGoalCalls[0].opts.dynamic, true);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'flee.goal-failed')?.payload,
    {
      entity: 'zombie',
      entityId: 1,
      owner: 'reactive',
      pathfinderIdle: true,
    },
  );
});

test('reactive flee isolates pathfinder goal install exceptions', () => {
  const { controller, errors, setGoalCalls, token, zombie } = reactiveFleeGoalScenario(() => {
    throw new Error('pathfinder rejected goal');
  });

  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(setGoalCalls.length, 1);
  assert.equal(setGoalCalls[0].givenToken, token);
  assert.equal(setGoalCalls[0].opts.dynamic, true);
  assert.deepEqual(
    errors.find((entry) => entry.event === 'flee.goal-failed')?.payload,
    {
      entity: 'zombie',
      entityId: 1,
      owner: 'reactive',
      pathfinderIdle: true,
      err: 'pathfinder rejected goal',
    },
  );
});

test('reactive flee refreshes the goal when a locked hostile pins close range', () => {
  const zombie = entity(1, 'zombie', 1.2, 64, 0);
  const token = { id: 'reactive-close-repath' };
  const setGoalCalls = [];
  const warnings = [];
  let currentOwner = 'reactive';
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    pathfinderOwner: {
      acquire(owner) {
        currentOwner = owner;
        return { token, release() { currentOwner = null; } };
      },
      setGoal(givenToken, goal, opts) {
        setGoalCalls.push({ givenToken, goal, opts });
        return true;
      },
      stop() {},
      currentOwner: () => currentOwner,
      isIdle: () => false,
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    fleeCloseRepathDistance: 3,
    fleeCloseRepathMs: 500,
  };
  controller.state = REACTIVE_STATE.FLEEING;
  controller.fleeingFrom = zombie;
  controller._tokenHandle = { token, release() { currentOwner = null; } };
  controller._lastCloseFleeRepathAt = Date.now() - 1000;
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(setGoalCalls.length, 1);
  assert.equal(setGoalCalls[0].givenToken, token);
  assert.equal(setGoalCalls[0].opts.dynamic, true);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'flee.close-repath')?.payload,
    {
      entity: 'zombie',
      entityId: 1,
      distance: 1.2,
      threshold: 3,
      replanMs: 500,
      owner: 'reactive',
      pathfinderIdle: false,
    },
  );
});

test('reactive flee reports pvp stop failures when threat clears', () => {
  const zombie = entity(1, 'zombie', config.reactive.hostileExitRadius + 2, 64, 0);
  const warnings = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    pvp: {
      stop() {
        throw new Error('pvp stop failed');
      },
      attack() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.state = REACTIVE_STATE.FLEEING;
  controller.fleeingFrom = zombie;
  controller._exitClearSince = Date.now() - 1000;
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(controller.fleeingFrom, null);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'pvp.stop-error')?.payload,
    { reason: 'threat-cleared', state: REACTIVE_STATE.FLEEING, err: 'pvp stop failed' },
  );
});

test('reactive engage reports pvp stop failures when target clears', () => {
  const zombie = entity(1, 'zombie', 24, 64, 0);
  const warnings = [];
  const bot = reactiveBot({
    entities: {},
    pvp: {
      stop() {
        throw new Error('pvp stop failed');
      },
      attack() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.state = REACTIVE_STATE.ENGAGING;
  controller.engaging = zombie;
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  assert.doesNotThrow(() => controller._tick());

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(controller.engaging, null);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'pvp.stop-error')?.payload,
    { reason: 'engage-cleared', state: REACTIVE_STATE.ENGAGING, err: 'pvp stop failed' },
  );
});

test('reactive engage falls back to flee when other hostiles remain inside exit radius', () => {
  const clearedZombie = entity(1, 'zombie', 5, 64, 0);
  const waveZombie = entity(2, 'zombie', 39, 64, 0);
  const setGoalCalls = [];
  const stopCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: { [waveZombie.id]: waveZombie },
    pvp: {
      stop() {
        stopCalls.push(true);
      },
      attack() {},
    },
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'engage-clear-flee' }, release() {} }),
      setGoal(givenToken, goal, opts) {
        setGoalCalls.push({ givenToken, goal, opts });
        return true;
      },
      stop() {},
      currentOwner: () => 'reactive',
      isIdle: () => true,
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    hostileExitRadius: 42,
  };
  controller.state = REACTIVE_STATE.ENGAGING;
  controller.engaging = clearedZombie;
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.engaging, null);
  assert.equal(controller.fleeingFrom, waveZombie);
  assert.equal(stopCalls.length, 1);
  assert.equal(setGoalCalls.length, 1);
  const transition = infos.find((entry) => entry.event === 'state.transition')?.payload;
  assert.equal(transition.reason, 'engage-cleared-threats-remain');
  assert.equal(transition.entity, 'zombie');
  assert.equal(transition.dist, 39);
  assert.equal(transition.exitRadius, 42);
});

test('reactive flee does not reacquire engagement from the exit buffer', () => {
  const zombie = entity(1, 'zombie', 35, 64, 0);
  const attackCalls = [];
  const bot = reactiveBot({
    entity: {
      equipment: armorEquipment({
        head: 'netherite_helmet',
        torso: 'netherite_chestplate',
        legs: 'netherite_leggings',
        feet: 'netherite_boots',
      }),
    },
    entities: { [zombie.id]: zombie },
    heldItem: { name: 'netherite_sword' },
    inventory: { items: () => [{ name: 'netherite_sword', slot: 0 }] },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    hostileExitRadius: 42,
    minArmorScoreToEngage: 16,
  };
  controller.state = REACTIVE_STATE.FLEEING;
  controller.fleeingFrom = zombie;
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(attackCalls.length, 0);
});

test('reactive combat policy flees from creepers even when armed', () => {
  const creeper = entity(1, 'creeper', 5, 64, 0);
  const attackCalls = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'netherite_sword' },
    inventory: { items: () => [{ name: 'netherite_sword', slot: 10 }] },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, creeper);
  assert.equal(attackCalls.length, 0);
});

test('reactive combat policy vetoes mixed unsafe threat sets before engaging', () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const creeper = entity(2, 'creeper', 6, 64, 0);
  const attackCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entity: {
      equipment: armorEquipment({
        head: 'netherite_helmet',
        torso: 'netherite_chestplate',
        legs: 'netherite_leggings',
        feet: 'netherite_boots',
      }),
    },
    entities: { [zombie.id]: zombie, [creeper.id]: creeper },
    heldItem: { name: 'netherite_sword' },
    inventory: { items: () => [{ name: 'netherite_sword', slot: 10 }] },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    maxMeleeEngageThreatCount: 2,
    minArmorScoreToEngage: 6,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(controller.engaging, null);
  assert.equal(attackCalls.length, 0);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'state.transition')?.payload,
    {
      from: 'NORMAL',
      to: 'FLEEING',
      reason: 'hostile-flee',
      entity: 'zombie',
      dist: 5,
      policy: 'creeper-anti-explosion',
      threatCount: 2,
      unsafeThreat: 'creeper',
      at: infos.find((entry) => entry.event === 'state.transition')?.payload.at,
    },
  );
});

test('reactive combat policy equips bow before fleeing creeper when ranged prep is enabled', async () => {
  const creeper = entity(1, 'creeper', 5, 64, 0);
  const bow = { name: 'bow', slot: 6 };
  const attackCalls = [];
  const equipCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'netherite_sword' },
    inventory: { items: () => [bow, { name: 'arrow', count: 16, slot: 7 }, { name: 'netherite_sword', slot: 10 }] },
    async equip(item, destination) {
      equipCalls.push({ item, destination });
      this.heldItem = item;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await Promise.resolve();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, creeper);
  assert.deepEqual(equipCalls, [{ item: bow, destination: 'hand' }]);
  assert.equal(attackCalls.length, 0);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-equip-start')?.payload,
    { item: 'bow', slot: 6, entity: 'creeper', entityId: 1, reason: 'creeper-ranged-weapon-available' },
  );
});

test('reactive combat ranged prep logs the unsafe target in a mixed threat set', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const skeleton = entity(2, 'skeleton', 9, 64, 0);
  const bow = { name: 'bow', slot: 6 };
  const equipCalls = [];
  const attackCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entity: {
      equipment: armorEquipment({
        head: 'netherite_helmet',
        torso: 'netherite_chestplate',
        legs: 'netherite_leggings',
        feet: 'netherite_boots',
      }),
    },
    entities: { [zombie.id]: zombie, [skeleton.id]: skeleton },
    heldItem: { name: 'netherite_sword' },
    inventory: { items: () => [bow, { name: 'arrow', count: 16, slot: 7 }, { name: 'netherite_sword', slot: 10 }] },
    async equip(item, destination) {
      equipCalls.push({ item, destination });
      this.heldItem = item;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    maxMeleeEngageThreatCount: 2,
    minArmorScoreToEngage: 6,
    rangedCombatPrepEnabled: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await Promise.resolve();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(attackCalls.length, 0);
  assert.deepEqual(equipCalls, [{ item: bow, destination: 'hand' }]);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-equip-start')?.payload,
    { item: 'bow', slot: 6, entity: 'skeleton', entityId: 2, reason: 'ranged-weapon-available' },
  );
  assert.deepEqual(
    infos.find((entry) => entry.event === 'state.transition')?.payload,
    {
      from: 'NORMAL',
      to: 'FLEEING',
      reason: 'hostile-flee',
      entity: 'zombie',
      dist: 5,
      policy: 'ranged-weapon-available',
      threatCount: 2,
      unsafeThreat: 'skeleton',
      targetEntity: 'skeleton',
      targetEntityId: 2,
      targetDistance: 9,
      at: infos.find((entry) => entry.event === 'state.transition')?.payload.at,
    },
  );
});

test('reactive combat policy can fire one bounded bow shot when ranged fire gates pass', async () => {
  const creeper = entity(1, 'creeper', 10, 64, 0);
  const attackCalls = [];
  const lookCalls = [];
  const activateCalls = [];
  const deactivateCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt(target, force) {
      lookCalls.push({ target, force });
    },
    activateItem() {
      activateCalls.push('main-hand');
      this.usingHeldItem = true;
    },
    deactivateItem() {
      deactivateCalls.push('main-hand');
      this.usingHeldItem = false;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
    rangedCombatFireVerifyMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, creeper);
  assert.equal(attackCalls.length, 0);
  assert.equal(activateCalls.length, 1);
  assert.equal(deactivateCalls.length, 1);
  assert.deepEqual(
    lookCalls.map(({ target, force }) => ({ target: { x: target.x, y: target.y, z: target.z }, force })),
    [{ target: { x: 10, y: 65, z: 0 }, force: true }],
  );
  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-fire-start')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 1,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
    },
  );
  assert.equal(infos.some((entry) => entry.event === 'combat.ranged-fire-done'), true);
});

test('reactive combat ranged fire targets the unsafe creeper in a mixed threat set', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const creeper = entity(2, 'creeper', 10, 64, 0);
  const attackCalls = [];
  const lookCalls = [];
  const activateCalls = [];
  const deactivateCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie, [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt(target, force) {
      lookCalls.push({ target, force });
    },
    activateItem() {
      activateCalls.push('main-hand');
      this.usingHeldItem = true;
    },
    deactivateItem() {
      deactivateCalls.push('main-hand');
      this.usingHeldItem = false;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
    rangedCombatFireVerifyMs: 0,
    maxMeleeEngageThreatCount: 2,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(attackCalls.length, 0);
  assert.equal(activateCalls.length, 1);
  assert.equal(deactivateCalls.length, 1);
  assert.deepEqual(
    lookCalls.map(({ target, force }) => ({ target: { x: target.x, y: target.y, z: target.z }, force })),
    [{ target: { x: 10, y: 65, z: 0 }, force: true }],
  );
  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-fire-start')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 2,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
    },
  );
  assert.deepEqual(
    infos.find((entry) => entry.event === 'state.transition')?.payload,
    {
      from: 'NORMAL',
      to: 'FLEEING',
      reason: 'hostile-flee',
      entity: 'zombie',
      dist: 5,
      policy: 'creeper-ranged-fire-safe',
      threatCount: 2,
      unsafeThreat: 'creeper',
      targetEntity: 'creeper',
      targetEntityId: 2,
      targetDistance: 10,
      at: infos.find((entry) => entry.event === 'state.transition')?.payload.at,
    },
  );
});

test('reactive combat refuses ranged fire while a close hostile is pressuring the bot', async () => {
  const zombie = entity(1, 'zombie', 2.5, 64, 0);
  const creeper = entity(2, 'creeper', 10, 64, 0);
  const lookCalls = [];
  const activateCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie, [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt(target, force) {
      lookCalls.push({ target, force });
    },
    activateItem() {
      activateCalls.push('main-hand');
      this.usingHeldItem = true;
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
    maxMeleeEngageThreatCount: 2,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.deepEqual(activateCalls, []);
  assert.deepEqual(lookCalls, []);
  assert.equal(infos.some((entry) => entry.event === 'combat.ranged-fire-start'), false);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'state.transition')?.payload,
    {
      from: 'NORMAL',
      to: 'FLEEING',
      reason: 'hostile-flee',
      entity: 'zombie',
      dist: 2.5,
      policy: 'close-hostile-pressure-before-ranged',
      threatCount: 2,
      unsafeThreat: 'zombie',
      closeThreatDistance: 2.5,
      targetEntity: 'creeper',
      targetEntityId: 2,
      targetDistance: 10,
      at: infos.find((entry) => entry.event === 'state.transition')?.payload.at,
    },
  );
});

test('reactive combat ranged fire rechecks distance after looking before item use', async () => {
  const creeper = entity(1, 'creeper', 10, 64, 0);
  const attackCalls = [];
  const lookCalls = [];
  const activateCalls = [];
  const deactivateCalls = [];
  const warnings = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt(target, force) {
      lookCalls.push({ target, force });
      creeper.position = pos(4, 64, 0);
    },
    activateItem() {
      activateCalls.push('main-hand');
      this.usingHeldItem = true;
    },
    deactivateItem() {
      deactivateCalls.push('main-hand');
      this.usingHeldItem = false;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, creeper);
  assert.equal(attackCalls.length, 0);
  assert.equal(lookCalls.length, 1);
  assert.equal(activateCalls.length, 0);
  assert.equal(deactivateCalls.length, 0);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.ranged-fire-cancel')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 1,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
      cancelReason: 'ranged-fire-too-close-before-activate',
      currentDistance: 4,
      lineOfSight: null,
    },
  );
});

test('reactive combat ranged fire rechecks close hostile pressure before item use', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const creeper = entity(2, 'creeper', 10, 64, 0);
  const lookCalls = [];
  const activateCalls = [];
  const deactivateCalls = [];
  const warnings = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie, [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt(target, force) {
      lookCalls.push({ target, force });
      zombie.position = pos(2.5, 64, 0);
    },
    activateItem() {
      activateCalls.push('main-hand');
      this.usingHeldItem = true;
    },
    deactivateItem() {
      deactivateCalls.push('main-hand');
      this.usingHeldItem = false;
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    maxMeleeEngageThreatCount: 2,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(lookCalls.length, 1);
  assert.equal(activateCalls.length, 0);
  assert.equal(deactivateCalls.length, 0);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.ranged-fire-cancel')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 2,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
      cancelReason: 'close-hostile-pressure-before-ranged-activate',
      currentDistance: 10,
      lineOfSight: null,
      closeThreat: 'zombie',
      closeThreatId: 1,
      closeThreatDistance: 2.5,
    },
  );
});

test('reactive combat ranged fire cancels active draw when close hostile pressure appears', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const creeper = entity(2, 'creeper', 10, 64, 0);
  const lookCalls = [];
  const activateCalls = [];
  const deactivateCalls = [];
  const infos = [];
  const warnings = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie, [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt(target, force) {
      lookCalls.push({ target, force });
    },
    activateItem() {
      activateCalls.push('main-hand');
      this.usingHeldItem = true;
      zombie.position = pos(2.5, 64, 0);
    },
    deactivateItem() {
      deactivateCalls.push('main-hand');
      this.usingHeldItem = false;
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    maxMeleeEngageThreatCount: 2,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 50,
    rangedCombatFireCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(lookCalls.length, 1);
  assert.equal(activateCalls.length, 1);
  assert.equal(deactivateCalls.length, 1);
  assert.equal(infos.some((entry) => entry.event === 'combat.ranged-fire-done'), false);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.ranged-fire-cancel')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 2,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 50,
      reason: 'creeper-ranged-fire-safe',
      cancelReason: 'close-hostile-pressure-during-ranged-draw',
      currentDistance: 10,
      lineOfSight: null,
      closeThreat: 'zombie',
      closeThreatId: 1,
      closeThreatDistance: 2.5,
    },
  );
});

test('reactive combat ranged fire verifies a target that remains after release', async () => {
  const creeper = entity(1, 'creeper', 10, 64, 0);
  const infos = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt() {},
    activateItem() {
      this.usingHeldItem = true;
    },
    deactivateItem() {
      this.usingHeldItem = false;
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
    rangedCombatFireVerifyMs: 30,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-fire-verify')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 1,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
      verifyMs: 30,
      outcome: 'target-still-present',
      currentDistance: 10,
      lineOfSight: true,
    },
  );
  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-fire-followup')?.payload,
    {
      entity: 'creeper',
      entityId: 1,
      outcome: 'target-still-present',
      followUpShots: 1,
      maxFollowUpShots: 3,
      followUpWindowMs: 10000,
      lastDistance: 10,
    },
  );
});

test('reactive combat ranged fire verifies a target disappearing after release', async () => {
  const creeper = entity(1, 'creeper', 10, 64, 0);
  const infos = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt() {},
    activateItem() {
      this.usingHeldItem = true;
    },
    deactivateItem() {
      this.usingHeldItem = false;
      delete this.entities[creeper.id];
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
    rangedCombatFireVerifyMs: 30,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-fire-verify')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 1,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
      verifyMs: 30,
      outcome: 'target-gone',
      currentDistance: null,
      lineOfSight: null,
    },
  );
});

test('reactive combat ranged fire verifies target health damage after release', async () => {
  const creeper = entity(1, 'creeper', 10, 64, 0, { health: 20 });
  const infos = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt() {},
    activateItem() {
      this.usingHeldItem = true;
    },
    deactivateItem() {
      this.usingHeldItem = false;
      creeper.health = 14;
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
    rangedCombatFireVerifyMs: 30,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.ranged-fire-verify')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 1,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
      verifyMs: 30,
      outcome: 'target-damaged',
      currentDistance: 10,
      lineOfSight: true,
      initialHealth: 20,
      currentHealth: 14,
    },
  );
  const stored = controller.lastRangedFireVerification(Date.now() + 100, 5000);
  assert.equal(stored.outcome, 'target-damaged');
  assert.equal(stored.entity, 'creeper');
  assert.equal(stored.currentDistance, 10);
  assert.equal(stored.initialHealth, 20);
  assert.equal(stored.currentHealth, 14);
  assert.equal(stored.followUpShots, 1);
  assert.equal(stored.maxFollowUpShots, 3);
  assert.equal(stored.ageMs >= 0, true);
});

test('reactive combat ranged fire refuses unbounded unresolved follow-up shots', async () => {
  const creeper = entity(1, 'creeper', 10, 64, 0);
  const activateCalls = [];
  const warnings = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', slot: 6 }] },
    canSeeEntity(target) {
      return target === creeper;
    },
    async lookAt() {},
    activateItem() {
      activateCalls.push('main-hand');
      this.usingHeldItem = true;
    },
    deactivateItem() {
      this.usingHeldItem = false;
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  const startedAt = Date.now();
  controller._combatRangedFireFollowUp = {
    targetKey: 'id:1',
    entity: 'creeper',
    entityId: 1,
    startedAt,
    shots: 2,
    lastOutcome: 'target-still-present',
    lastDistance: 10,
    lastAt: startedAt,
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
    rangedCombatFireVerifyMs: 30,
    rangedCombatFireMaxFollowUpShots: 2,
    rangedCombatFireFollowUpWindowMs: 10000,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(activateCalls.length, 0);
  const warning = warnings.find((entry) => entry.event === 'combat.ranged-fire-followup-limit')?.payload;
  assert.ok(warning);
  assert.deepEqual(warning, {
    item: 'bow',
    entity: 'creeper',
    entityId: 1,
    distance: 10,
    target: { x: 10, y: 65, z: 0 },
    drawMs: 1,
    reason: 'creeper-ranged-fire-safe',
    cancelReason: 'ranged-fire-followup-limit',
    followUpShots: 2,
    maxFollowUpShots: 2,
    followUpWindowMs: 10000,
    followUpAgeMs: warning.followUpAgeMs,
    lastOutcome: 'target-still-present',
    lastDistance: 10,
  });
  assert.equal(warning.followUpAgeMs >= 0, true);
});

test('reactive combat policy equips best weapon before engaging', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const sword = { name: 'diamond_sword', slot: 7 };
  const attackCalls = [];
  const equipCalls = [];
  const humanizedEquipCalls = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ torso: 'iron_chestplate' }) },
    entities: { [zombie.id]: zombie },
    heldItem: null,
    inventory: { items: () => [sword] },
    async equip(item, destination) {
      equipCalls.push({ item, destination });
      this.heldItem = item;
    },
    humanizer: {
      equipItem(targetBot, item, destination, opts = {}) {
        humanizedEquipCalls.push({
          item,
          destination,
          reason: opts.reason,
          critical: opts.critical === true,
        });
        return targetBot.equip(item, destination);
      },
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await Promise.resolve();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.deepEqual(equipCalls, [{ item: sword, destination: 'hand' }]);
  assert.deepEqual(humanizedEquipCalls, [{
    item: sword,
    destination: 'hand',
    reason: 'combat.weapon-equip',
    critical: true,
  }]);
  assert.equal(attackCalls.length, 0);

  controller.hostileScanCounter = 4;
  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.ENGAGING);
  assert.equal(controller.engaging, zombie);
  assert.deepEqual(attackCalls, [zombie]);
});

test('reactive combat policy applies active effects to live engage risk', () => {
  const hoglin = entity(1, 'hoglin', 5, 64, 0);
  const attackCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entity: {
      equipment: armorEquipment({ torso: 'iron_chestplate' }),
      effects: [{ name: 'strength', amplifier: 1, duration: 600 }],
    },
    entities: { [hoglin.id]: hoglin },
    heldItem: { name: 'iron_sword' },
    inventory: { items: () => [{ name: 'iron_sword', slot: 3 }] },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    minMeleeSurvivalSecondsToEngage: 3,
    minMeleeKillMarginSecondsToEngage: 1,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.ENGAGING);
  assert.equal(controller.engaging, hoglin);
  assert.deepEqual(attackCalls, [hoglin]);
  const transition = infos.find((entry) => entry.event === 'state.transition')?.payload;
  assert.equal(transition.reason, 'hostile-engage');
  assert.equal(transition.meleeRisk.meleeOffense.strengthLevel, 2);
  assert.equal(transition.meleeRisk.meleeOffense.estimatedSecondsToKill, 2.52);
  assert.equal(transition.meleeRisk.estimatedSecondsToLowHealth, 3.68);
});

test('reactive combat policy applies active defensive effects to live survival risk', () => {
  const hoglin = entity(1, 'hoglin', 5, 64, 0);
  const attackCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entity: {
      equipment: armorEquipment({ torso: 'iron_chestplate' }),
      effects: [
        { name: 'regeneration', amplifier: 1, duration: 500 },
        { name: 'absorption', amplifier: 0, duration: 1200 },
      ],
    },
    entities: { [hoglin.id]: hoglin },
    heldItem: { name: 'iron_sword' },
    inventory: { items: () => [{ name: 'iron_sword', slot: 3 }] },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    minMeleeSurvivalSecondsToEngage: 3,
    minMeleeKillMarginSecondsToEngage: 1,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.ENGAGING);
  assert.equal(controller.engaging, hoglin);
  assert.deepEqual(attackCalls, [hoglin]);
  const transition = infos.find((entry) => entry.event === 'state.transition')?.payload;
  assert.equal(transition.reason, 'hostile-engage');
  assert.equal(transition.meleeRisk.regenerationLevel, 2);
  assert.equal(transition.meleeRisk.absorptionLevel, 1);
  assert.equal(transition.meleeRisk.estimatedSecondsToLowHealth, 6.51);
  assert.equal(transition.meleeRisk.meleeOffense.estimatedSecondsToKill, 4.41);
});

test('reactive combat policy equips shield before engaging when required', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const shield = { name: 'shield', slot: 8 };
  const attackCalls = [];
  const equipCalls = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ torso: 'iron_chestplate' }) },
    entities: { [zombie.id]: zombie },
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [shield, { name: 'diamond_sword', slot: 3 }] },
    async equip(item, destination) {
      equipCalls.push({ item, destination });
      if (destination === 'off-hand') this.entity.equipment[1] = item;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    requireShieldToEngage: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await Promise.resolve();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.deepEqual(equipCalls, [{ item: shield, destination: 'off-hand' }]);
  assert.equal(attackCalls.length, 0);

  controller.hostileScanCounter = 4;
  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.ENGAGING);
  assert.equal(controller.engaging, zombie);
  assert.deepEqual(attackCalls, [zombie]);
});

test('reactive combat policy flees when shield is required but unavailable', () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const attackCalls = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ torso: 'iron_chestplate' }) },
    entities: { [zombie.id]: zombie },
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [{ name: 'diamond_sword', slot: 3 }] },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    requireShieldToEngage: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(attackCalls.length, 0);
});

test('reactive combat shield blocking activates off-hand shield while engaging', () => {
  const zombie = entity(1, 'zombie', 4, 64, 0);
  const attackCalls = [];
  const activateCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ offHand: 'shield', torso: 'iron_chestplate' }) },
    entities: { [zombie.id]: zombie },
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [{ name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: false,
    activateItem(offHand) {
      activateCalls.push(offHand);
      this.usingHeldItem = true;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    shieldBlockingEnabled: true,
    shieldBlockDistance: 4.5,
    shieldReleaseDistance: 7,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.ENGAGING);
  assert.equal(controller._shieldBlockActive, true);
  assert.deepEqual(activateCalls, [true]);
  assert.deepEqual(attackCalls, [zombie]);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.shield-block-start')?.payload,
    { entity: 'zombie', entityId: 1, distance: 4, reason: 'melee-shield-block' },
  );
});

test('reactive combat shield blocking releases when engagement clears', () => {
  const zombie = entity(1, 'zombie', 24, 64, 0);
  const deactivateCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: {},
    usingHeldItem: true,
    deactivateItem() {
      deactivateCalls.push(true);
      this.usingHeldItem = false;
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.state = REACTIVE_STATE.ENGAGING;
  controller.engaging = zombie;
  controller._shieldBlockActive = true;
  controller._shieldBlockThreatId = zombie.id;
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.NORMAL);
  assert.equal(controller._shieldBlockActive, false);
  assert.deepEqual(deactivateCalls, [true]);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'combat.shield-block-release')?.payload,
    { reason: 'engage-cleared', entityId: 1 },
  );
});

test('reactive combat shield blocking does not stomp unrelated item use', () => {
  const creeper = entity(1, 'creeper', 3, 64, 0);
  const warnings = [];
  const activateCalls = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ offHand: 'shield' }) },
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [{ name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: true,
    activateItem(offHand) {
      activateCalls.push(offHand);
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    shieldBlockingEnabled: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller._shieldBlockActive, false);
  assert.equal(activateCalls.length, 0);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.shield-block-busy')?.payload,
    { entity: 'creeper', entityId: 1, distance: 3, reason: 'creeper-shield-block' },
  );
});

test('reactive combat shield blocking activates for close creeper flee backup', () => {
  const creeper = entity(1, 'creeper', 3, 64, 0);
  const activateCalls = [];
  const attackCalls = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ offHand: 'shield' }) },
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [{ name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: false,
    activateItem(offHand) {
      activateCalls.push(offHand);
      this.usingHeldItem = true;
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    shieldBlockingEnabled: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, creeper);
  assert.equal(controller._shieldBlockActive, true);
  assert.deepEqual(activateCalls, [true]);
  assert.equal(attackCalls.length, 0);
});

test('reactive consumable bridge uses golden apple during hostile pressure before engaging', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const golden = { name: 'golden_apple', count: 1, slot: 6 };
  const attackCalls = [];
  const equipCalls = [];
  const consumeCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    health: 9,
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [golden, { name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: false,
    autoEat: { isEating: false },
    async equip(item, destination) {
      equipCalls.push({ item, destination });
      this.heldItem = item;
    },
    async consume() {
      consumeCalls.push(this.heldItem?.name);
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    reactiveConsumablesEnabled: true,
    reactiveConsumableCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.deepEqual(equipCalls, [{ item: golden, destination: 'hand' }]);
  assert.deepEqual(consumeCalls, ['golden_apple']);
  assert.equal(attackCalls.length, 0);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'reactive.consume-start')?.payload,
    { item: 'golden_apple', action: 'eat', reason: 'low-health-golden-apple', entity: 'zombie', entityId: 1 },
  );
});

test('reactive consumable bridge keeps potion use explicitly opt-in', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const strength = { name: 'potion', count: 1, slot: 6, potionType: 'minecraft:strong_strength' };
  const attackCalls = [];
  const consumeCalls = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ torso: 'iron_chestplate' }) },
    entities: { [zombie.id]: zombie },
    health: 20,
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [strength, { name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: false,
    autoEat: { isEating: false },
    async equip(item) {
      this.heldItem = item;
    },
    async consume() {
      consumeCalls.push(this.heldItem?.name);
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    reactiveConsumablesEnabled: true,
    reactiveConsumablePotions: false,
    reactiveConsumableCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.ENGAGING);
  assert.deepEqual(attackCalls, [zombie]);
  assert.equal(consumeCalls.length, 0);

  attackCalls.length = 0;
  controller.state = REACTIVE_STATE.NORMAL;
  controller.engaging = null;
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;
  controller.cfg.reactiveConsumablePotions = true;

  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.deepEqual(consumeCalls, ['potion']);
  assert.equal(attackCalls.length, 0);
});

test('reactive consumable bridge does not spend offensive potions while flee-only', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const strength = { name: 'potion', count: 1, slot: 6, potionType: 'minecraft:strong_strength' };
  const consumeCalls = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    health: 20,
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [strength, { name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: false,
    autoEat: { isEating: false },
    async equip(item) {
      this.heldItem = item;
    },
    async consume() {
      consumeCalls.push(this.heldItem?.name);
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: false,
    hostileScanRadius: 16,
    reactiveConsumablesEnabled: true,
    reactiveConsumablePotions: true,
    reactiveConsumableCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.deepEqual(consumeCalls, []);
  assert.equal(bot.heldItem.name, 'diamond_sword');
});

test('reactive consumable bridge still allows survival potions while flee-only', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const healing = { name: 'potion', count: 1, slot: 6, potionType: 'minecraft:strong_healing' };
  const consumeCalls = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    health: 5,
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [healing, { name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: false,
    autoEat: { isEating: false },
    async equip(item) {
      this.heldItem = item;
    },
    async consume() {
      consumeCalls.push(this.heldItem?.name);
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: false,
    hostileScanRadius: 16,
    reactiveConsumablesEnabled: true,
    reactiveConsumablePotions: true,
    reactiveConsumableCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.deepEqual(consumeCalls, ['potion']);
});

test('reactive consumable bridge uses combat risk to prebuff regeneration before engaging', async () => {
  const hoglin = entity(1, 'hoglin', 5, 64, 0);
  const regeneration = { name: 'potion', count: 1, slot: 6, potionType: 'minecraft:strong_regeneration' };
  const attackCalls = [];
  const consumeCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ torso: 'iron_chestplate' }) },
    entities: { [hoglin.id]: hoglin },
    health: 20,
    heldItem: { name: 'iron_sword' },
    inventory: { items: () => [regeneration, { name: 'iron_sword', slot: 3 }] },
    usingHeldItem: false,
    autoEat: { isEating: false },
    async equip(item) {
      this.heldItem = item;
    },
    async consume() {
      consumeCalls.push(this.heldItem?.name);
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    reactiveConsumablesEnabled: true,
    reactiveConsumablePotions: true,
    reactiveConsumableCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, hoglin);
  assert.deepEqual(consumeCalls, ['potion']);
  assert.equal(attackCalls.length, 0);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'reactive.consume-start')?.payload,
    {
      item: 'potion',
      action: 'drink_potion',
      reason: 'combat-risk-regeneration',
      entity: 'hoglin',
      entityId: 1,
      effect: 'regeneration',
      level: 2,
    },
  );
});

test('reactive consumable bridge prioritizes urgent defensive prep over strength', async () => {
  const hoglin = entity(1, 'hoglin', 5, 64, 0);
  const strength = { name: 'potion', count: 1, slot: 5, potionType: 'minecraft:strong_strength' };
  const regeneration = { name: 'potion', count: 1, slot: 6, potionType: 'minecraft:strong_regeneration' };
  const attackCalls = [];
  const consumeCalls = [];
  const infos = [];
  const bot = reactiveBot({
    entities: { [hoglin.id]: hoglin },
    health: 20,
    heldItem: { name: 'iron_sword' },
    inventory: { items: () => [strength, regeneration, { name: 'iron_sword', slot: 3 }] },
    usingHeldItem: false,
    autoEat: { isEating: false },
    async equip(item) {
      this.heldItem = item;
    },
    async consume() {
      consumeCalls.push(this.heldItem?.potionType || this.heldItem?.name);
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info(event, payload) { infos.push({ event, payload }); },
    warn() {},
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 0,
    reactiveConsumablesEnabled: true,
    reactiveConsumablePotions: true,
    reactiveConsumableCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, hoglin);
  assert.deepEqual(consumeCalls, ['minecraft:strong_regeneration']);
  assert.equal(attackCalls.length, 0);
  assert.deepEqual(
    infos.find((entry) => entry.event === 'reactive.consume-start')?.payload,
    {
      item: 'potion',
      action: 'drink_potion',
      reason: 'combat-risk-regeneration',
      entity: 'hoglin',
      entityId: 1,
      effect: 'regeneration',
      level: 2,
    },
  );
});

test('reactive consumable bridge holds flee while a consume is still running', async () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const golden = { name: 'golden_apple', count: 1, slot: 6 };
  const attackCalls = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    health: 9,
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [golden, { name: 'diamond_sword', slot: 3 }] },
    usingHeldItem: false,
    autoEat: { isEating: false },
    async equip(item) {
      this.heldItem = item;
    },
    consume() {
      return new Promise(() => {});
    },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    reactiveConsumablesEnabled: true,
    reactiveConsumableCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await Promise.resolve();
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;
  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(attackCalls.length, 0);
  controller._abortReactiveConsume('test-cleanup');
  await new Promise((resolve) => setImmediate(resolve));
});

test('reactive combat policy flees instead of engaging when armor is insufficient', () => {
  const zombie = entity(1, 'zombie', 5, 64, 0);
  const attackCalls = [];
  const bot = reactiveBot({
    entities: { [zombie.id]: zombie },
    heldItem: { name: 'netherite_sword' },
    inventory: { items: () => [{ name: 'netherite_sword', slot: 10 }] },
    pvp: {
      attack(target) {
        attackCalls.push(target);
      },
      stop() {},
    },
  });
  const controller = new ReactiveController(bot);
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();

  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.equal(controller.fleeingFrom, zombie);
  assert.equal(attackCalls.length, 0);
});

test('reactive combat weapon equip is operation-bounded', async (t) => {
  const originalTimeout = config.executor.equipOperationTimeoutMs;
  config.executor.equipOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.equipOperationTimeoutMs = originalTimeout;
  });

  const zombie = entity(1, 'zombie', 5, 64, 0);
  const warnings = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ torso: 'iron_chestplate' }) },
    entities: { [zombie.id]: zombie },
    heldItem: null,
    inventory: { items: () => [{ name: 'diamond_sword', slot: 7 }] },
    equip: () => new Promise(() => {}),
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(controller._combatEquipPromise, null);
  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.weapon-equip-error')?.payload,
    {
      item: 'diamond_sword',
      slot: 7,
      entity: 'zombie',
      entityId: 1,
      reason: 'weapon-available',
      err: 'combat weapon equip timed out after 20ms',
    },
  );
});

test('reactive combat ranged equip is operation-bounded', async (t) => {
  const originalTimeout = config.executor.equipOperationTimeoutMs;
  config.executor.equipOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.equipOperationTimeoutMs = originalTimeout;
  });

  const creeper = entity(1, 'creeper', 5, 64, 0);
  const warnings = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [{ name: 'bow', slot: 7 }, { name: 'arrow', count: 12, slot: 8 }] },
    equip: () => new Promise(() => {}),
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(controller._combatRangedEquipPromise, null);
  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.ranged-equip-error')?.payload,
    {
      item: 'bow',
      slot: 7,
      entity: 'creeper',
      entityId: 1,
      reason: 'creeper-ranged-weapon-available',
      err: 'combat ranged equip timed out after 20ms',
    },
  );
});

test('reactive combat ranged fire is operation-bounded', async (t) => {
  const originalTimeout = config.executor.rangedShotOperationTimeoutMs;
  config.executor.rangedShotOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.rangedShotOperationTimeoutMs = originalTimeout;
  });

  const creeper = entity(1, 'creeper', 10, 64, 0);
  const warnings = [];
  const bot = reactiveBot({
    entities: { [creeper.id]: creeper },
    heldItem: { name: 'bow' },
    inventory: { items: () => [{ name: 'arrow', count: 12, slot: 8 }] },
    canSeeEntity: () => true,
    lookAt: () => new Promise(() => {}),
    activateItem() {},
    deactivateItem() {},
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    hostileScanRadius: 16,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatFireShotDrawMs: 1,
    rangedCombatFireCooldownMs: 0,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(controller._combatRangedFirePromise, null);
  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.ranged-fire-error')?.payload,
    {
      item: 'bow',
      entity: 'creeper',
      entityId: 1,
      distance: 10,
      target: { x: 10, y: 65, z: 0 },
      drawMs: 1,
      reason: 'creeper-ranged-fire-safe',
      err: 'combat ranged look timed out after 20ms',
    },
  );
});

test('reactive combat shield equip is operation-bounded', async (t) => {
  const originalTimeout = config.executor.equipOperationTimeoutMs;
  config.executor.equipOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.equipOperationTimeoutMs = originalTimeout;
  });

  const zombie = entity(1, 'zombie', 5, 64, 0);
  const warnings = [];
  const bot = reactiveBot({
    entity: { equipment: armorEquipment({ torso: 'iron_chestplate' }) },
    entities: { [zombie.id]: zombie },
    heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [{ name: 'shield', slot: 8 }, { name: 'diamond_sword', slot: 3 }] },
    equip: () => new Promise(() => {}),
  });
  const controller = new ReactiveController(bot);
  controller.log = {
    info() {},
    warn(event, payload) { warnings.push({ event, payload }); },
    error() {},
    fatal() {},
  };
  controller.cfg = {
    ...controller.cfg,
    engageOverFlee: true,
    hostileScanRadius: 16,
    minArmorScoreToEngage: 6,
    requireShieldToEngage: true,
  };
  controller.hostileScanCounter = 4;
  controller.lastTick = 0;

  controller._tick();
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(controller._combatShieldEquipPromise, null);
  assert.equal(controller.state, REACTIVE_STATE.FLEEING);
  assert.deepEqual(
    warnings.find((entry) => entry.event === 'combat.shield-equip-error')?.payload,
    {
      item: 'shield',
      slot: 8,
      entity: 'zombie',
      entityId: 1,
      reason: 'shield-available',
      err: 'combat shield equip timed out after 20ms',
    },
  );
});

test('evaluateFleeThreat enters FLEEING when a hostile is inside enter radius', () => {
  const zombie = entity(1, 'zombie', 10, 64, 0);
  const bot = botWithEntities([zombie]);

  const decision = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.NORMAL,
    fleeingFrom: null,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 0,
    now: 1000,
  });

  assert.equal(decision.threat.entity, zombie);
  assert.equal(decision.clearFleeing, false);
  assert.equal(decision.exitClearSince, 0);
});

test('evaluateFleeThreat selects the nearest hostile from a multi-hostile set', () => {
  const zombie = entity(1, 'zombie', 12, 64, 0);
  const spider = entity(2, 'spider', 5, 64, 0);
  const skeleton = entity(3, 'skeleton', 9, 64, 0);
  const bot = botWithEntities([zombie, spider, skeleton]);

  const decision = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.NORMAL,
    fleeingFrom: null,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 0,
    now: 1000,
  });

  assert.equal(decision.threat.entity, spider);
  assert.equal(decision.threat.distance, 5);
  assert.deepEqual(decision.threat.threats.map((threat) => threat.entity.id), [2, 3, 1]);
  assert.equal(decision.clearFleeing, false);
});

test('evaluateFleeThreat ignores closer non-hostile entities when choosing from a threat set', () => {
  const cow = entity(1, 'cow', 2, 64, 0);
  const zombie = entity(2, 'zombie', 9, 64, 0);
  const bot = botWithEntities([cow, zombie]);

  const decision = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.NORMAL,
    fleeingFrom: null,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 0,
    now: 1000,
  });

  assert.equal(decision.threat.entity, zombie);
  assert.equal(decision.threat.distance, 9);
});

test('evaluateFleeThreat holds FLEEING while locked hostile remains inside exit radius', () => {
  const zombie = entity(1, 'zombie', 20, 64, 0);
  const bot = botWithEntities([zombie]);

  const decision = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.FLEEING,
    fleeingFrom: zombie,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 900,
    now: 1000,
  });

  assert.equal(decision.threat.entity, zombie);
  assert.equal(decision.clearFleeing, false);
  assert.equal(decision.exitClearSince, 0);
  assert.deepEqual(decision.threat.threats.map((threat) => threat.entity.id), [1]);
});

test('evaluateFleeThreat does not flip targets while locked hostile remains inside exit radius', () => {
  const zombie = entity(1, 'zombie', 20, 64, 0);
  const spider = entity(2, 'spider', 6, 64, 0);
  const bot = botWithEntities([zombie, spider]);

  const decision = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.FLEEING,
    fleeingFrom: zombie,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 0,
    now: 1000,
  });

  assert.equal(decision.threat.entity, zombie);
  assert.equal(decision.clearFleeing, false);
  assert.equal(decision.exitClearSince, 0);
  assert.deepEqual(decision.threat.threats.map((threat) => threat.entity.id), [2, 1]);
});

test('evaluateFleeThreat holds FLEEING when another wave hostile remains inside exit radius', () => {
  const oldZombie = entity(1, 'zombie', 24, 64, 0);
  const waveZombie = entity(2, 'zombie', 20, 64, 0);
  const bot = botWithEntities([oldZombie, waveZombie]);

  const decision = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.FLEEING,
    fleeingFrom: oldZombie,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 1000,
    now: 1200,
  });

  assert.equal(decision.threat.entity, waveZombie);
  assert.equal(decision.clearFleeing, false);
  assert.equal(decision.exitClearSince, 0);
  assert.deepEqual(decision.threat.threats.map((threat) => threat.entity.id), [2]);
});

test('evaluateFleeThreat exits FLEEING only after exit radius and debounce', () => {
  const zombie = entity(1, 'zombie', 24, 64, 0);
  const bot = botWithEntities([zombie]);

  const firstClear = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.FLEEING,
    fleeingFrom: zombie,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 0,
    now: 1000,
  });

  assert.equal(firstClear.threat, null);
  assert.equal(firstClear.clearFleeing, false);
  assert.equal(firstClear.exitClearSince, 1000);

  const debouncedClear = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.FLEEING,
    fleeingFrom: zombie,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: firstClear.exitClearSince,
    now: 1500,
  });

  assert.equal(debouncedClear.threat, null);
  assert.equal(debouncedClear.clearFleeing, true);
  assert.equal(debouncedClear.exitClearSince, 0);
});

test('evaluateFleeThreat switches to a new hostile inside enter radius during exit debounce', () => {
  const oldZombie = entity(1, 'zombie', 24, 64, 0);
  const spider = entity(2, 'spider', 8, 64, 0);
  const bot = botWithEntities([oldZombie, spider]);

  const decision = evaluateFleeThreat({
    bot,
    state: REACTIVE_STATE.FLEEING,
    fleeingFrom: oldZombie,
    enterRadius: 16,
    exitRadius: 22,
    exitDebounceMs: 500,
    exitClearSince: 1000,
    now: 1200,
  });

  assert.equal(decision.threat.entity, spider);
  assert.equal(decision.clearFleeing, false);
  assert.equal(decision.exitClearSince, 0);
});

test('buildFleeTrackingRecord includes the required log fields', () => {
  const zombie = entity(7, 'zombie', 3, 64, 4);
  const bot = {
    entity: { position: pos(1, 65, 1) },
    pathfinderOwner: {
      currentOwner: () => 'reactive',
      isIdle: () => false,
    },
    controlState: { sprint: true },
    health: 18,
    food: 17,
  };

  const skeleton = entity(8, 'skeleton', 6, 64, 1);
  const record = buildFleeTrackingRecord(bot, {
    entity: zombie,
    distance: 5,
    threats: [
      { entity: zombie, distance: 5 },
      { entity: skeleton, distance: 7 },
    ],
  });

  assert.deepEqual(Object.keys(record).sort(), [
    'botPos',
    'distance',
    'entity',
    'entityId',
    'entityPos',
    'food',
    'health',
    'owner',
    'pathfinderIdle',
    'sprint',
    'threatCount',
    'threats',
  ]);
  assert.equal(record.entity, 'zombie');
  assert.equal(record.entityId, 7);
  assert.equal(record.distance, 5);
  assert.equal(record.threatCount, 2);
  assert.deepEqual(record.threats, [
    {
      entity: 'zombie',
      entityId: 7,
      distance: 5,
      position: { x: 3, y: 64, z: 4 },
    },
    {
      entity: 'skeleton',
      entityId: 8,
      distance: 7,
      position: { x: 6, y: 64, z: 1 },
    },
  ]);
  assert.deepEqual(record.botPos, { x: 1, y: 65, z: 1 });
  assert.deepEqual(record.entityPos, { x: 3, y: 64, z: 4 });
  assert.equal(record.owner, 'reactive');
  assert.equal(record.pathfinderIdle, false);
  assert.equal(record.sprint, true);
  assert.equal(record.health, 18);
  assert.equal(record.food, 17);
});

test('buildFleeTrackingRecord reports pathfinder context read failures', () => {
  const zombie = entity(7, 'zombie', 3, 64, 4);
  const bot = {
    entity: { position: pos(1, 65, 1) },
    pathfinderOwner: {
      currentOwner() {
        throw new Error('owner unavailable');
      },
      isIdle() {
        throw new Error('idle unavailable');
      },
    },
    controlState: {},
    health: 18,
    food: 17,
  };

  const record = buildFleeTrackingRecord(bot, { entity: zombie, distance: 5 });

  assert.equal(record.owner, null);
  assert.equal(record.ownerError, 'owner unavailable');
  assert.equal(record.pathfinderIdle, null);
  assert.equal(record.pathfinderIdleError, 'idle unavailable');
});
