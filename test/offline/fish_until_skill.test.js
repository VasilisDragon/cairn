import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { run as runFishUntil } from '../../src/skills/fish_until.js';

function position(x = 0, y = 64, z = 0) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
  };
}

function makeBot(overrides = {}) {
  const client = new EventEmitter();
  const items = overrides.items || [{ name: 'fishing_rod', count: 1, slot: 5 }];
  const bot = {
    _client: client,
    chunksReady: Promise.resolve(),
    entity: {
      position: position(),
      isInWater: false,
      velocity: { y: 0 },
      equipment: [],
    },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: {
      blocksByName: {},
      itemsByName: { fishing_rod: { id: 346 }, cod: { id: 349 } },
      entitiesByName: { fishing_bobber: { id: 90 } },
    },
    inventory: {
      items: () => items,
    },
    async equip(item, destination) {
      this.equipped = { item, destination };
      this.heldItem = item;
    },
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
      if (this.activateCalls === 1) {
        setTimeout(() => {
          client.emit('spawn_entity', {
            type: 90,
            entityId: 77,
            x: 0,
            y: 64,
            z: 2,
          });
          client.emit('world_particles', {
            particle: { name: 'fishing' },
            amount: 8,
            x: 0,
            y: 64,
            z: 2,
          });
        }, 5);
      } else if (this.activateCalls === 2) {
        items.push({ name: 'cod', count: 1, slot: 10 });
      }
    },
    ...overrides,
  };
  return bot;
}

function ctx(overrides = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    ...overrides,
  };
}

test('fish_until equips a rod, reels on a bite, and reports caught item deltas', async () => {
  const bot = makeBot();

  const result = await runFishUntil(bot, {
    catches: 1,
    attemptTimeoutMs: 1000,
    pickupTimeoutMs: 500,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'fish_until caught 1 item');
  assert.equal(result.attempts, 1);
  assert.equal(result.catches, 1);
  assert.deepEqual(result.caughtCounts, { cod: 1 });
  assert.equal(bot.equipped.destination, 'hand');
  assert.equal(bot.equipped.item.name, 'fishing_rod');
  assert.equal(bot.activateCalls, 2);
  assert.deepEqual(result.state.inventory, [
    { name: 'fishing_rod', count: 1 },
    { name: 'cod', count: 1 },
  ]);
});

test('fish_until routes cast and reel through the humanization item-use boundary', async () => {
  const reasons = [];
  const bot = makeBot();
  bot.humanizer = {
    equipItem(targetBot, item, destination, opts = {}) {
      reasons.push(opts.reason);
      return Promise.resolve(targetBot.equip(item, destination));
    },
    activateItem(targetBot, opts = {}) {
      reasons.push(opts.reason);
      return Promise.resolve(targetBot.activateItem());
    },
  };

  const result = await runFishUntil(bot, {
    catches: 1,
    attemptTimeoutMs: 1000,
    pickupTimeoutMs: 500,
  }, ctx());

  assert.equal(result.ok, true);
  assert.deepEqual(reasons, ['fish_until.equip_rod', 'fish_until.cast', 'fish_until.reel']);
  assert.equal(bot.activateCalls, 2);
});

test('fish_until ignores stale low oxygen when block reads show dry air', async () => {
  const items = [{ name: 'fishing_rod', count: 1, slot: 5 }];
  const bot = makeBot({
    items,
    oxygenLevel: 12,
    blockAt() {
      return { name: 'air' };
    },
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
      if (this.activateCalls === 1) {
        setTimeout(() => {
          this._client.emit('spawn_entity', {
            type: 90,
            entityId: 77,
            x: 0,
            y: 64,
            z: 2,
          });
          this._client.emit('world_particles', {
            particle: { name: 'fishing' },
            amount: 8,
            x: 0,
            y: 64,
            z: 2,
          });
        }, 40);
      } else if (this.activateCalls === 2) {
        items.push({ name: 'cod', count: 1, slot: 10 });
      }
    },
  });

  const result = await runFishUntil(bot, {
    catches: 1,
    attemptTimeoutMs: 1000,
    pickupTimeoutMs: 500,
    waterSafetyPollMs: 5,
  }, ctx());

  assert.equal(result.ok, true);
  assert.deepEqual(result.caughtCounts, { cod: 1 });
});

test('fish_until reports a missing rod before casting', async () => {
  const bot = makeBot({ items: [] });

  const result = await runFishUntil(bot, { catches: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no fishing_rod in inventory or hand');
  assert.equal(bot.activateCalls || 0, 0);
});

test('fish_until reports missing client packet listener support', async () => {
  const bot = makeBot({ _client: null });

  const result = await runFishUntil(bot, { catches: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fish_until failed: bot client packet listeners unavailable');
});

test('fish_until times out when no bite packet arrives', async () => {
  const bot = makeBot({
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
    },
  });

  const result = await runFishUntil(bot, {
    catches: 1,
    attemptTimeoutMs: 20,
    pickupTimeoutMs: 20,
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /fish_until attempt 1 failed: fishing attempt timed out after 20ms/);
  assert.equal(bot.activateCalls, 2);
});

test('fish_until retries when a cast bobber disappears before a bite', async () => {
  const bot = makeBot({
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
      if (this.activateCalls === 1) {
        setTimeout(() => {
          this._client.emit('spawn_entity', {
            type: 90,
            entityId: 77,
            x: 0,
            y: 64,
            z: 2,
          });
          this._client.emit('entity_destroy', { entityIds: [77] });
        }, 5);
      } else if (this.activateCalls === 3) {
        setTimeout(() => {
          this._client.emit('spawn_entity', {
            type: 90,
            entityId: 78,
            x: 0,
            y: 64,
            z: 2,
          });
          this._client.emit('world_particles', {
            particle: { name: 'fishing' },
            amount: 8,
            x: 0,
            y: 64,
            z: 2,
          });
        }, 5);
      } else if (this.activateCalls === 4) {
        this.inventory.items().push({ name: 'cod', count: 1, slot: 10 });
      }
    },
  });

  const result = await runFishUntil(bot, {
    catches: 1,
    maxAttempts: 2,
    attemptTimeoutMs: 1000,
    bobberSpawnTimeoutMs: 100,
    pickupTimeoutMs: 500,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'fish_until caught 1 item');
  assert.equal(result.attempts, 2);
  assert.equal(result.catches, 1);
  assert.deepEqual(result.caughtCounts, { cod: 1 });
  assert.equal(bot.activateCalls, 4);
});

test('fish_until reports reactive preempt during a pending cast', async () => {
  const controller = new AbortController();
  const bot = makeBot({
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
    },
  });

  setTimeout(() => controller.abort('reactive-preempt'), 10);
  const result = await runFishUntil(bot, {
    catches: 1,
    attemptTimeoutMs: 1000,
    pickupTimeoutMs: 1000,
  }, ctx({ signal: controller.signal }));

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during fish_until attempt 1');
  assert.equal(bot.activateCalls, 2);
});

test('fish_until cancels fishing when water becomes unsafe during a pending cast', async () => {
  const humanizedControls = [];
  const bot = makeBot({
    setControlState(state, value) {
      this.controlStates = [...(this.controlStates || []), { state, value }];
    },
    activateItem() {
      this.activateCalls = (this.activateCalls || 0) + 1;
      if (this.activateCalls === 1) {
        setTimeout(() => {
          this.entity.isInWater = true;
          this.entity.velocity = { y: -0.12 };
        }, 5);
      }
    },
  });
  bot.humanizer = {
    setControlState(targetBot, state, value, opts = {}) {
      humanizedControls.push({ state, value, reason: opts.reason, critical: opts.critical === true });
      return targetBot.setControlState(state, value);
    },
  };

  const result = await runFishUntil(bot, {
    catches: 1,
    attemptTimeoutMs: 1000,
    pickupTimeoutMs: 20,
    waterSafetyPollMs: 5,
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /fish_until attempt 1 failed: unsafe water state while fishing/);
  assert.match(result.reason, /in-water/);
  assert.ok(bot.activateCalls >= 2, 'expected cancelFishing to deactivate the rod after unsafe water state');
  assert.deepEqual(bot.controlStates.at(0), { state: 'jump', value: true });
  assert.deepEqual(humanizedControls.at(0), {
    state: 'jump',
    value: true,
    reason: 'fish_until.water_rescue',
    critical: true,
  });
});
