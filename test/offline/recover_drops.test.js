import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { run as runRecoverDrops } from '../../src/skills/recover_drops.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.hypot(x - other.x, y - other.y, z - other.z);
    },
    clone() {
      return pos(x, y, z);
    },
  };
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

function makeBot(overrides = {}) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    registry: TEST_REGISTRY,
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'recover-drops-test' }, release() {} }),
      setGoal: () => {
        setImmediate(() => bot.emit('goal_reached'));
        return true;
      },
      stop() {},
      currentOwner: () => null,
      isIdle: () => true,
    },
    ...overrides,
  });
  return bot;
}

test('recover_drops reports a deterministic pickup inventory delta', async () => {
  let inventoryItems = [];
  const bot = makeBot({
    inventory: {
      items: () => inventoryItems,
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => {
      bot.entity.position = pos(4, 64, 0);
      bot.emit('goal_reached');
      setTimeout(() => {
        inventoryItems = [{ name: 'diamond', count: 3, slot: 9 }];
      }, 10);
    });
    return true;
  };

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 250 }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'recovered dropped items');
  assert.deepEqual(result.recoveredItems, { diamond: 3 });
  assert.deepEqual(result.inventoryBefore, {});
  assert.deepEqual(result.inventoryAfter, { diamond: 3 });
});

test('recover_drops waits for pickup deltas to settle before reporting success', async () => {
  let inventoryReads = 0;
  const bot = makeBot({
    inventory: {
      items: () => {
        inventoryReads += 1;
        if (inventoryReads < 3) return [];
        if (inventoryReads === 3) return [{ name: 'diamond', count: 1, slot: 9 }];
        return [
          { name: 'diamond', count: 1, slot: 9 },
          { name: 'dirt', count: 4, slot: 10 },
        ];
      },
    },
  });

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 800, settleMs: 50 }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'recovered dropped items');
  assert.deepEqual(result.recoveredItems, { diamond: 1, dirt: 4 });
  assert.deepEqual(result.inventoryAfter, { diamond: 1, dirt: 4 });
});

test('recover_drops sweeps visible nearby item entities after reaching the death point', async () => {
  let inventoryItems = [];
  let setGoalCalls = 0;
  const bot = makeBot({
    entities: {
      7: { id: 7, name: 'item', position: pos(6, 64, 1) },
    },
    inventory: {
      items: () => inventoryItems,
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setGoalCalls += 1;
    setImmediate(() => {
      if (setGoalCalls === 2) {
        bot.entity.position = pos(6, 64, 1);
        delete bot.entities[7];
        inventoryItems = [{ name: 'dirt', count: 1, slot: 9 }];
      } else {
        bot.entity.position = pos(4, 64, 0);
      }
      bot.emit('goal_reached');
    });
    return true;
  };

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 0, settleMs: 0 }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'recovered dropped items');
  assert.deepEqual(result.recoveredItems, { dirt: 1 });
  assert.deepEqual(result.itemSweep.visited, [7]);
  assert.equal(setGoalCalls, 2);
});

test('recover_drops locally sweeps clustered visible drops before per-item pathing', async () => {
  let inventoryItems = [];
  let setGoalCalls = 0;
  const pickupOrder = [7, 8];
  const controls = [];
  const bot = makeBot({
    entities: {
      7: { id: 7, name: 'item', position: pos(5.2, 64, 0) },
      8: { id: 8, name: 'item', position: pos(6.2, 64, 0) },
    },
    inventory: {
      items: () => inventoryItems,
    },
    lookAt: async () => {},
    setControlState: (control, value) => {
      controls.push({ control, value });
      if (control !== 'forward' || value !== true || pickupOrder.length === 0) return;
      const id = pickupOrder.shift();
      delete bot.entities[id];
      if (id === 7) {
        inventoryItems = [{ name: 'dirt', count: 1, slot: 9 }];
      } else {
        inventoryItems = [
          { name: 'dirt', count: 1, slot: 9 },
          { name: 'cooked_beef', count: 4, slot: 10 },
        ];
      }
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setGoalCalls += 1;
    setImmediate(() => {
      bot.entity.position = pos(4, 64, 0);
      bot.emit('goal_reached');
    });
    return true;
  };

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 0, settleMs: 0 }, ctx());

  assert.equal(result.ok, true);
  assert.deepEqual(result.recoveredItems, { cooked_beef: 4, dirt: 1 });
  assert.equal(setGoalCalls, 1);
  assert.deepEqual(result.itemSweep.local.visited, [7, 8]);
  assert.deepEqual(result.itemSweep.visited, []);
  assert.equal(controls.some((entry) => entry.control === 'forward' && entry.value === true), true);
});

test('recover_drops reports partial recovery when visible nearby drops remain', async () => {
  let inventoryItems = [];
  let setGoalCalls = 0;
  const bot = makeBot({
    entities: {
      7: { id: 7, name: 'item', position: pos(6, 64, 1) },
      8: { id: 8, name: 'item', position: pos(7, 64, 1) },
    },
    inventory: {
      items: () => inventoryItems,
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setGoalCalls += 1;
    setImmediate(() => {
      if (setGoalCalls === 2) {
        bot.entity.position = pos(6, 64, 1);
        delete bot.entities[7];
        inventoryItems = [{ name: 'dirt', count: 1, slot: 9 }];
      } else if (setGoalCalls === 3) {
        bot.entity.position = pos(4, 64, 0);
        bot.emit('path_update', { status: 'noPath' });
        return;
      } else {
        bot.entity.position = pos(4, 64, 0);
      }
      bot.emit('goal_reached');
    });
    return true;
  };

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 0, settleMs: 0 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'partial drop recovery left visible dropped items nearby');
  assert.deepEqual(result.recoveredItems, { dirt: 1 });
  assert.equal(result.nearbyItems.length, 1);
  assert.equal(result.nearbyItems[0].id, 8);
});

test('recover_drops refuses dimension mismatch before pathing', async () => {
  let acquireCalls = 0;
  const bot = makeBot({
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'should-not-acquire' }, release() {} };
      },
    },
  });

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, dimension: 'the_nether' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'drop recovery dimension the_nether differs from current dimension overworld');
  assert.equal(acquireCalls, 0);
});

test('recover_drops refuses unverifiable dimension before pathing', async () => {
  let acquireCalls = 0;
  const bot = makeBot({
    game: {},
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'should-not-acquire' }, release() {} };
      },
    },
  });

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, dimension: 'overworld' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'drop recovery dimension overworld cannot be verified because current dimension is unavailable');
  assert.equal(acquireCalls, 0);
});

test('recover_drops reports travel failure without waiting for pickup', async () => {
  let inventoryReads = 0;
  const bot = makeBot({
    inventory: {
      items: () => {
        inventoryReads += 1;
        return [];
      },
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('path_update', { status: 'noPath' }));
    return true;
  };

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 250 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'drop recovery travel failed: noPath');
  assert.equal(inventoryReads, 2);
});

test('recover_drops reports no dropped items found at the location', async () => {
  const bot = makeBot();

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 0 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no dropped items picked up at recovery location');
  assert.deepEqual(result.recoveredItems, {});
});

test('recover_drops abandons the single recovery attempt after preempt during pickup wait', async () => {
  const controller = new AbortController();
  const bot = makeBot();
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => {
      bot.emit('goal_reached');
      setTimeout(() => controller.abort('reactive-preempt'), 5);
    });
    return true;
  };

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 50 }, ctx({ signal: controller.signal }));

  assert.equal(result.ok, false);
  assert.equal(result.preempted, undefined);
  assert.equal(result.reason, 'drop recovery abandoned after reactive preempt during pickup wait');
});

test('recover_drops abandons the single recovery attempt after preempt during travel', async () => {
  const controller = new AbortController();
  const bot = makeBot();
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => controller.abort('reactive-preempt'));
    return true;
  };

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0, waitMs: 50 }, ctx({ signal: controller.signal }));

  assert.equal(result.ok, false);
  assert.equal(result.preempted, undefined);
  assert.equal(result.reason, 'drop recovery abandoned after reactive preempt during travel');
});

test('recover_drops reports inventory read failures before travel', async () => {
  const bot = makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
    pathfinderOwner: {
      acquire: () => {
        throw new Error('should not acquire pathfinder');
      },
    },
  });

  const result = await runRecoverDrops(bot, { x: 4, y: 64, z: 0 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory unavailable before drop recovery: inventory cache unavailable');
});
