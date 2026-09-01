import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import config from '../../src/config.js';
import { run as runCollect } from '../../src/skills/collect.js';
import { run as runBuild } from '../../src/skills/build_from_schematic.js';
import { run as runCraft } from '../../src/skills/craft.js';
import { run as runDeposit } from '../../src/skills/deposit.js';
import { run as runEquip } from '../../src/skills/equip.js';
import { run as runFlee } from '../../src/skills/flee.js';
import { run as runGoto } from '../../src/skills/goto.js';
import { posKey } from '../../src/skills/_pathing.js';
import { withdrawFromKnownStorage } from '../../src/skills/_storage.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';
import {
  addDisposableWorldFixtureBotState,
  disposableWorldActionFixture,
} from './helpers/world_action_fixture.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return { x, y, z, clone() { return pos(x, y, z); } };
}

function modelWithProtectedBox(min, max) {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min, max },
    reason: 'likely_player_made',
    confidence: 0.91,
  });
  return model;
}

function ctx() {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldActionAuthorization: disposableWorldActionFixture(),
  };
}

function registryWithMissingMovementBlocks({ blocksByName = {}, itemsByName = {} } = {}) {
  return {
    blocksByName,
    blocksArray: [],
    itemsByName,
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
      acquire: () => ({ token: { id: 'skill-runtime-test' }, release() {} }),
      setGoal: () => true,
      stop() {},
    },
    ...overrides,
  });
  return addDisposableWorldFixtureBotState(bot);
}

async function captureStdoutRecords(fn) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function write(chunk, ...args) {
    const text = String(chunk);
    if (text.trim().startsWith('{')) {
      writes.push(text);
      if (typeof args.at(-1) === 'function') args.at(-1)();
      return true;
    }
    return originalWrite.call(process.stdout, chunk, ...args);
  };
  try {
    const value = await fn();
    return {
      value,
      records: writes
        .flatMap((text) => text.trim().split(/\r?\n/).filter(Boolean))
        .map((line) => JSON.parse(line)),
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('goto block reports noPath and excludes the failed scanned target', async () => {
  const target = pos(4, 64, 0);
  const callCtx = ctx();
  const bot = makeBot({
    findBlocks: () => [target],
    blockAt: () => ({ name: 'oak_log', position: target }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('path_update', { status: 'noPath' }));
    return true;
  };

  const result = await runGoto(bot, { block: 'oak_log', maxDistance: 16 }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'noPath');
  assert.equal(callCtx.callState.excluded.has(posKey(target)), true);
});

test('goto block skips world-model protected scanned targets', async () => {
  const protectedTarget = pos(0, 64, 0);
  const allowedTarget = pos(8, 64, 0);
  const callCtx = ctx();
  let selectedGoal = null;
  const bot = makeBot({
    findBlocks: () => [protectedTarget, allowedTarget],
    blockAt: (p) => ({ name: 'oak_log', position: p }),
  });
  bot.pathfinderOwner.setGoal = (_token, goal) => {
    selectedGoal = goal;
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };
  callCtx.worldModel = modelWithProtectedBox([0, 63, 0], [2, 66, 2]);

  const result = await runGoto(bot, { block: 'oak_log', maxDistance: 16 }, callCtx);

  assert.equal(result.ok, true);
  assert.equal(selectedGoal.x, allowedTarget.x);
  assert.equal(selectedGoal.y, allowedTarget.y);
  assert.equal(selectedGoal.z, allowedTarget.z);
});

test('goto block reports when only protected targets remain', async () => {
  const protectedTarget = pos(0, 64, 0);
  const callCtx = ctx();
  callCtx.worldModel = modelWithProtectedBox([0, 63, 0], [2, 66, 2]);
  let acquireCalls = 0;
  const bot = makeBot({
    findBlocks: () => [protectedTarget],
    blockAt: (p) => ({ name: 'oak_log', position: p }),
    pathfinderOwner: {
      acquire: () => {
        acquireCalls++;
        return { token: { id: 'goto-protected-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path to protected target');
      },
      stop() {},
    },
  });

  const result = await runGoto(bot, { block: 'oak_log', maxDistance: 16 }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no oak_log within 16 blocks (excluded 0, protected 1)');
  assert.equal(acquireCalls, 0);
});

test('goto block reports world-query failures during target validation', async () => {
  const target = pos(4, 64, 0);
  const callCtx = ctx();
  callCtx.callState.currentTarget = target;
  let acquireCalls = 0;
  const bot = makeBot({
    blockAt: () => {
      throw new Error('block cache unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls++;
        return { token: { id: 'goto-world-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when target validation fails');
      },
      stop() {},
    },
  });

  const result = await runGoto(bot, { block: 'oak_log', maxDistance: 16 }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during goto block target validation: block cache unavailable');
  assert.equal(acquireCalls, 0);
});

test('goto block reports world-query failures during block scan', async () => {
  let acquireCalls = 0;
  const bot = makeBot({
    findBlocks: () => {
      throw new Error('chunk section unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls++;
        return { token: { id: 'goto-scan-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when target scan fails');
      },
      stop() {},
    },
  });

  const result = await runGoto(bot, { block: 'oak_log', maxDistance: 16 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during goto block scan: chunk section unavailable');
  assert.equal(acquireCalls, 0);
});

test('goto block reports preempt when block scan aborts before throwing', async () => {
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  let acquireCalls = 0;
  const bot = makeBot({
    findBlocks: () => {
      controller.abort('reactive-preempt');
      throw new Error('scan interrupted');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls++;
        return { token: { id: 'goto-scan-preempt-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when target scan preempts');
      },
      stop() {},
    },
  });

  const result = await runGoto(bot, { block: 'oak_log', maxDistance: 16 }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during goto block scan');
  assert.equal(acquireCalls, 0);
});

test('goto fails closed when movement setup is unavailable', async () => {
  let setGoalCalls = 0;
  let releaseCalls = 0;
  const bot = makeBot({
    registry: registryWithMissingMovementBlocks(),
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'goto-movement-setup-test' }, release() { releaseCalls += 1; } }),
      setGoal: () => {
        setGoalCalls += 1;
        return true;
      },
      stop() {},
    },
  });

  const result = await runGoto(bot, { x: 4, y: 64, z: 0 }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /^goto movement setup failed: /);
  assert.equal(setGoalCalls, 0);
  assert.equal(releaseCalls, 1);
});

test('collect reports no progress when a broken block yields no inventory delta', async () => {
  const target = pos(4, 64, 0);
  const blocks = new Map([[posKey(target), target]]);
  const callCtx = ctx();
  const bot = makeBot({
    inventory: { items: () => [] },
    findBlocks: () => [...blocks.values()],
    blockAt: (p) => (blocks.has(posKey(p)) ? { name: 'oak_log', position: blocks.get(posKey(p)) } : null),
    collectBlock: {
      collect: async (block) => {
        blocks.delete(posKey(block.position));
      },
    },
    stopDigging() {},
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, callCtx);

  assert.equal(result.ok, false);
  assert.match(result.reason, /no more oak_log within 16 blocks \(have 0\/1, excluded 1\)/);
  assert.equal(callCtx.callState.excluded.has(posKey(target)), true);
});

test('collect fast-dig nudges toward nearby drops before reporting no progress', async () => {
  const target = pos(1, 64, 0);
  const blocks = new Map([[posKey(target), target]]);
  let diamondCount = 0;
  let collectBlockCalls = 0;
  let forwardCalls = 0;
  const bot = makeBot({
    entity: {
      isInWater: false,
      onGround: true,
      position: pos(1.2, 64, 0.4),
    },
    heldItem: {
      name: 'netherite_pickaxe',
      type: TEST_REGISTRY.itemsByName.netherite_pickaxe.id,
    },
    inventory: {
      items: () => (diamondCount > 0 ? [{ name: 'diamond', count: diamondCount }] : []),
    },
    findBlocks: () => [...blocks.values()],
    blockAt: (p) => (blocks.has(posKey(p))
      ? {
        name: 'diamond_ore',
        type: TEST_REGISTRY.blocksByName.diamond_ore.id,
        position: blocks.get(posKey(p)),
      }
      : null),
    canDigBlock: () => true,
    dig: async (block) => {
      blocks.delete(posKey(block.position));
      bot.entities[17] = {
        id: 17,
        name: 'item',
        displayName: 'Item',
        position: pos(1.9, 64, 0.4),
      };
    },
    lookAt: async () => {},
    setControlState(control, value) {
      if (control === 'forward' && value) {
        forwardCalls += 1;
        delete bot.entities[17];
        diamondCount = 1;
      }
    },
    collectBlock: {
      collect: async () => {
        collectBlockCalls += 1;
        throw new Error('collectBlock fallback should not run after local pickup');
      },
    },
  });

  const result = await runCollect(bot, {
    block: 'diamond_ore',
    count: 1,
    maxDistance: 16,
    progressItems: ['diamond'],
    finishTree: false,
    fastDigPickupWaitMs: 1,
    fastDigPostPickupWaitMs: 50,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 diamond_ore');
  assert.equal(diamondCount, 1);
  assert.equal(collectBlockCalls, 0);
  assert.equal(forwardCalls > 0, true);
});

test('collect fast-dig waits briefly for delayed dropped item entities', async () => {
  const target = pos(1, 64, 0);
  const blocks = new Map([[posKey(target), target]]);
  let diamondCount = 0;
  let forwardCalls = 0;
  const bot = makeBot({
    entity: {
      isInWater: false,
      onGround: true,
      position: pos(1.2, 64, 0.4),
    },
    heldItem: {
      name: 'netherite_pickaxe',
      type: TEST_REGISTRY.itemsByName.netherite_pickaxe.id,
    },
    inventory: {
      items: () => (diamondCount > 0 ? [{ name: 'diamond', count: diamondCount }] : []),
    },
    findBlocks: () => [...blocks.values()],
    blockAt: (p) => (blocks.has(posKey(p))
      ? {
        name: 'diamond_ore',
        type: TEST_REGISTRY.blocksByName.diamond_ore.id,
        position: blocks.get(posKey(p)),
      }
      : null),
    canDigBlock: () => true,
    dig: async (block) => {
      blocks.delete(posKey(block.position));
      setTimeout(() => {
        bot.entities[18] = {
          id: 18,
          name: 'item',
          displayName: 'Item',
          position: pos(1.9, 64, 0.4),
        };
      }, 30);
    },
    lookAt: async () => {},
    setControlState(control, value) {
      if (control === 'forward' && value && bot.entities[18]) {
        forwardCalls += 1;
        delete bot.entities[18];
        diamondCount = 1;
      }
    },
    collectBlock: {
      collect: async () => {
        throw new Error('collectBlock fallback should not run after delayed local pickup');
      },
    },
  });

  const result = await runCollect(bot, {
    block: 'diamond_ore',
    count: 1,
    maxDistance: 16,
    progressItems: ['diamond'],
    finishTree: false,
    fastDigPickupWaitMs: 1,
    fastDigPostPickupWaitMs: 100,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 diamond_ore');
  assert.equal(diamondCount, 1);
  assert.equal(forwardCalls > 0, true);
});

test('collect retries nearby dropped items after collectBlock completes without pickup', async () => {
  const target = pos(4, 64, 0);
  const blocks = new Map([[posKey(target), target]]);
  let diamondCount = 0;
  let collectBlockCalls = 0;
  let forwardCalls = 0;
  const bot = makeBot({
    entity: {
      isInWater: false,
      onGround: true,
      position: pos(0, 64, 0),
    },
    inventory: {
      items: () => (diamondCount > 0 ? [{ name: 'diamond', count: diamondCount }] : []),
    },
    findBlocks: () => [...blocks.values()],
    blockAt: (p) => (blocks.has(posKey(p))
      ? {
        name: 'diamond_ore',
        type: TEST_REGISTRY.blocksByName.diamond_ore.id,
        position: blocks.get(posKey(p)),
      }
      : null),
    dig: async () => {
      throw new Error('fast dig should not run for this collectBlock recovery test');
    },
    lookAt: async () => {},
    setControlState(control, value) {
      if (control === 'forward' && value && bot.entities[19]) {
        forwardCalls += 1;
        delete bot.entities[19];
        diamondCount = 1;
      }
    },
    collectBlock: {
      collect: async (targetEntity) => {
        collectBlockCalls += 1;
        if (targetEntity?.name === 'item') {
          delete bot.entities[targetEntity.id];
          diamondCount = 1;
          return;
        }
        blocks.delete(posKey(targetEntity.position));
        bot.entities[19] = {
          id: 19,
          name: 'item',
          displayName: 'Item',
          position: pos(4.7, 64, 0.4),
        };
      },
    },
  });

  const result = await runCollect(bot, {
    block: 'diamond_ore',
    count: 1,
    maxDistance: 16,
    progressItems: ['diamond'],
    finishTree: false,
    pickupWaitMs: 1,
    fastDigPostPickupWaitMs: 100,
  }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 diamond_ore');
  assert.equal(diamondCount, 1);
  assert.equal(collectBlockCalls, 1);
  assert.equal(forwardCalls > 0, true);
});

test('collect reports synchronous collectBlock failures through skill result', async () => {
  const target = pos(4, 64, 0);
  let releaseCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [] },
    findBlocks: () => [target],
    blockAt: (p) => ({ name: 'oak_log', position: p }),
    collectBlock: {
      collect: () => {
        throw new Error('collect plugin unavailable');
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'collect-sync-failure' }, release() { releaseCalls += 1; } }),
      stop() {},
    },
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16, finishTree: false }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'collectBlock error: collect plugin unavailable');
  assert.equal(releaseCalls, 1);
});

test('pathing skills report pathfinder acquire failures through skill results', async () => {
  const acquireFailureOwner = {
    acquire() {
      throw new Error('owner bus unavailable');
    },
  };
  const target = pos(4, 64, 0);
  const chestPos = pos(3, 64, 0);
  const tablePos = pos(2, 64, 0);

  const gotoResult = await runGoto(makeBot({ pathfinderOwner: acquireFailureOwner }), { x: 1, y: 64, z: 1 }, ctx());
  assert.equal(gotoResult.ok, false);
  assert.equal(gotoResult.reason, 'pathfinder acquire failed during goto: owner bus unavailable');

  const collectResult = await runCollect(makeBot({
    pathfinderOwner: acquireFailureOwner,
    inventory: { items: () => [] },
    findBlocks: () => [target],
    blockAt: (p) => ({ name: 'oak_log', position: p }),
  }), { block: 'oak_log', count: 1, maxDistance: 16 }, ctx());
  assert.equal(collectResult.ok, false);
  assert.equal(collectResult.reason, 'pathfinder acquire failed during collect: owner bus unavailable');

  const depositResult = await runDeposit(makeBot({
    pathfinderOwner: acquireFailureOwner,
    findBlocks: () => [chestPos],
    blockAt: (p) => ({ name: 'chest', position: p }),
  }), { items: [{ name: 'oak_log', count: 1 }], maxDistance: 16 }, ctx());
  assert.equal(depositResult.ok, false);
  assert.equal(depositResult.reason, 'pathfinder acquire failed during deposit: owner bus unavailable');

  const craftResult = await runCraft(makeBot({
    pathfinderOwner: acquireFailureOwner,
    recipesFor: () => [],
    findBlocks: () => [tablePos],
    blockAt: (p) => ({ name: 'crafting_table', position: p }),
  }), { item: 'oak_planks', count: 1 }, ctx());
  assert.equal(craftResult.ok, false);
  assert.equal(craftResult.reason, 'pathfinder acquire failed during craft walk: owner bus unavailable');

  const storageResult = await withdrawFromKnownStorage(makeBot({
    pathfinderOwner: acquireFailureOwner,
  }), [{
    storageId: 'storage_acquire_failure',
    item: 'oak_log',
    count: 1,
    position: chestPos,
  }], ctx());
  assert.equal(storageResult.ok, false);
  assert.equal(storageResult.reason, 'pathfinder acquire failed during storage withdrawal: owner bus unavailable');

  const fleeResult = await runFlee(makeBot({
    pathfinderOwner: acquireFailureOwner,
  }), { from: { x: -10, y: 64, z: 0 }, distance: 16 }, ctx());
  assert.equal(fleeResult.ok, false);
  assert.equal(fleeResult.reason, 'pathfinder acquire failed during flee: owner bus unavailable');
});

test('pathing skills report pathfinder setGoal failures through skill results', async () => {
  let releaseCalls = 0;
  const setGoalFailureOwner = () => ({
    acquire: () => ({
      token: { id: 'setgoal-failure-test' },
      release() {
        releaseCalls += 1;
      },
    }),
    setGoal() {
      throw new Error('goal bus unavailable');
    },
    stop() {},
  });
  const chestPos = pos(3, 64, 0);
  const tablePos = pos(2, 64, 0);

  const gotoResult = await runGoto(makeBot({ pathfinderOwner: setGoalFailureOwner() }), { x: 1, y: 64, z: 1 }, ctx());
  assert.equal(gotoResult.ok, false);
  assert.equal(gotoResult.reason, 'pathfinder setGoal failed during goto: goal bus unavailable');

  const depositResult = await runDeposit(makeBot({
    pathfinderOwner: setGoalFailureOwner(),
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: (p) => ({ name: 'chest', position: p }),
  }), { items: [{ name: 'oak_log', count: 1 }], maxDistance: 16 }, ctx());
  assert.equal(depositResult.ok, false);
  assert.equal(depositResult.reason, 'pathfinder setGoal failed during deposit: goal bus unavailable');

  const craftResult = await runCraft(makeBot({
    pathfinderOwner: setGoalFailureOwner(),
    recipesFor: () => [],
    findBlocks: () => [tablePos],
    blockAt: (p) => ({ name: 'crafting_table', position: p }),
  }), { item: 'oak_planks', count: 1 }, ctx());
  assert.equal(craftResult.ok, false);
  assert.equal(craftResult.reason, 'pathfinder setGoal failed during craft walk: goal bus unavailable');

  const storageResult = await withdrawFromKnownStorage(makeBot({
    pathfinderOwner: setGoalFailureOwner(),
  }), [{
    storageId: 'storage_setgoal_failure',
    item: 'oak_log',
    count: 1,
    position: chestPos,
  }], ctx());
  assert.equal(storageResult.ok, false);
  assert.equal(storageResult.reason, 'pathfinder setGoal failed during storage withdrawal: goal bus unavailable');

  const fleeResult = await runFlee(makeBot({
    pathfinderOwner: setGoalFailureOwner(),
  }), { from: { x: -10, y: 64, z: 0 }, distance: 16 }, ctx());
  assert.equal(fleeResult.ok, false);
  assert.equal(fleeResult.reason, 'pathfinder setGoal failed during flee: goal bus unavailable');
  assert.equal(releaseCalls, 5);
});

test('collect reports preempt when pickup wait aborts before inventory delta', async () => {
  const target = pos(4, 64, 0);
  const blocks = new Map([[posKey(target), target]]);
  const controller = new AbortController();
  const callCtx = { ...ctx(), signal: controller.signal };
  let collectFinished = false;
  const bot = makeBot({
    inventory: {
      items: () => {
        if (collectFinished && !controller.signal.aborted) controller.abort('reactive-preempt');
        return [];
      },
    },
    findBlocks: () => [...blocks.values()],
    blockAt: (p) => (blocks.has(posKey(p)) ? { name: 'oak_log', position: blocks.get(posKey(p)) } : null),
    collectBlock: {
      collect: async (block) => {
        blocks.delete(posKey(block.position));
        collectFinished = true;
      },
    },
    stopDigging() {},
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during collect inventory wait');
  assert.equal(callCtx.callState.excluded.has(posKey(target)), false);
  assert.equal(posKey(callCtx.callState.currentTarget), posKey(target));
});

test('collect reports inventory read failures during progress checks', async () => {
  const target = pos(4, 64, 0);
  let collectCalls = 0;
  let releaseCalls = 0;
  const bot = makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
    findBlocks: () => [target],
    blockAt: (p) => ({ name: 'oak_log', position: p }),
    collectBlock: {
      collect: async () => {
        collectCalls += 1;
      },
    },
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'collect-inventory-failure' }, release() { releaseCalls += 1; } }),
      setGoal: () => {
        throw new Error('should not path before inventory baseline');
      },
      stop() {},
    },
  });

  const result = await runCollect(bot, {
    block: 'oak_log',
    count: 1,
    maxDistance: 16,
    finishTree: false,
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory unavailable during collect progress check: inventory cache unavailable');
  assert.equal(collectCalls, 0);
  assert.equal(releaseCalls, 1);
});

test('collect logs pathfinder release failures without masking the skill result', async () => {
  const target = pos(4, 64, 0);
  let inventoryCount = 0;
  const writes = [];
  const originalWrite = process.stdout.write;
  const bot = makeBot({
    inventory: {
      items: () => (inventoryCount > 0 ? [{ name: 'oak_log', type: TEST_REGISTRY.itemsByName.oak_log.id, count: inventoryCount }] : []),
    },
    findBlocks: () => [target],
    blockAt: (p) => ({ name: 'oak_log', position: p }),
    collectBlock: {
      collect: async () => {
        inventoryCount = 1;
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({
        token: { id: 'collect-release-failure' },
        release() {
          throw new Error('release failed');
        },
      }),
      setGoal: () => true,
      stop() {},
    },
  });
  process.stdout.write = function write(chunk, ...args) {
    writes.push(String(chunk));
    if (typeof args.at(-1) === 'function') args.at(-1)();
    return true;
  };

  let result;
  try {
    result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16, finishTree: false }, ctx());
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 oak_log');
  const records = writes
    .join('')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.some((record) => (
    record.evt === 'pathfinder.release-error' &&
    record.skill === 'collect' &&
    record.err === 'release failed'
  )));
});

test('collect reports world-query failures during current target validation', async () => {
  const target = pos(4, 64, 0);
  const callCtx = ctx();
  callCtx.callState.currentTarget = target;
  let acquireCalls = 0;
  const bot = makeBot({
    blockAt: () => {
      throw new Error('target block cache unavailable');
    },
    findBlocks: () => {
      throw new Error('should not rescan when current target validation fails');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'collect-target-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when target validation fails');
      },
      stop() {},
    },
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during collect target validation: target block cache unavailable');
  assert.equal(acquireCalls, 0);
});

test('collect reports world-query failures during block scan', async () => {
  let acquireCalls = 0;
  const bot = makeBot({
    findBlocks: () => {
      throw new Error('block index unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'collect-scan-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when block scan fails');
      },
      stop() {},
    },
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16, finishTree: false }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during collect block scan: block index unavailable');
  assert.equal(acquireCalls, 0);
});

test('collect reports world-query failures while resolving a scanned candidate', async () => {
  const target = pos(4, 64, 0);
  let acquireCalls = 0;
  const bot = makeBot({
    findBlocks: () => [target],
    blockAt: () => {
      throw new Error('candidate block cache unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'collect-candidate-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when candidate lookup fails');
      },
      stop() {},
    },
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16, finishTree: false }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during collect block scan: candidate block cache unavailable');
  assert.equal(acquireCalls, 0);
});

test('collect reports preempt when block scan aborts before throwing', async () => {
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  let acquireCalls = 0;
  const bot = makeBot({
    findBlocks: () => {
      controller.abort('reactive-preempt');
      throw new Error('scan interrupted');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'collect-scan-preempt-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when block scan preempts');
      },
      stop() {},
    },
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during collect block scan');
  assert.equal(acquireCalls, 0);
});

test('collect fails closed when collectBlock movement setup is unavailable', async () => {
  const target = pos(4, 64, 0);
  let collectCalls = 0;
  const bot = makeBot({
    registry: {
      blocksByName: { oak_log: { id: 1, name: 'oak_log' } },
      blocksArray: [],
      itemsByName: {},
    },
    findBlocks: () => [target],
    blockAt: () => ({ name: 'oak_log', position: target }),
    collectBlock: {
      collect: async () => {
        collectCalls += 1;
      },
    },
    stopDigging() {},
  });

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /^collect movement setup failed: /);
  assert.equal(collectCalls, 0);
});

test('deposit reports openContainer failure after reaching locked chest', async () => {
  const chestPos = pos(3, 64, 0);
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => {
      throw new Error('container busy');
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /openContainer failed: container busy/);
});

test('deposit reports hung openContainer timeouts after reaching locked chest', async (t) => {
  const originalTimeout = config.executor.containerOpenTimeoutMs;
  config.executor.containerOpenTimeoutMs = 20;
  t.after(() => {
    config.executor.containerOpenTimeoutMs = originalTimeout;
  });

  const chestPos = pos(3, 64, 0);
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: () => new Promise(() => {}),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'openContainer failed: container open timed out after 20ms');
});

test('deposit reports reactive preempt when hung openContainer is aborted', async (t) => {
  const originalTimeout = config.executor.containerOpenTimeoutMs;
  config.executor.containerOpenTimeoutMs = 1000;
  t.after(() => {
    config.executor.containerOpenTimeoutMs = originalTimeout;
  });

  const chestPos = pos(3, 64, 0);
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: () => new Promise(() => {}),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const started = Date.now();
  const resultPromise = runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, callCtx);
  setTimeout(() => controller.abort('reactive-preempt'), 10);
  const result = await resultPromise;

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt opening deposit chest');
  assert.ok(Date.now() - started < 250);
});

test('deposit reports when the locked chest disappears after walking', async () => {
  const chestPos = pos(3, 64, 0);
  let blockLookups = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => {
      blockLookups += 1;
      return blockLookups === 1 ? { name: 'chest', position: chestPos } : null;
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'chest no longer present at locked position');
});

test('deposit reports world-query failures during chest scan', async () => {
  let acquireCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => {
      throw new Error('chest index unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'deposit-scan-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when chest scan fails');
      },
      stop() {},
    },
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during deposit chest scan: chest index unavailable');
  assert.equal(acquireCalls, 0);
});

test('deposit reports world-query failures while inspecting scanned chests', async () => {
  const chestPos = pos(3, 64, 0);
  let acquireCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => {
      throw new Error('block cache unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'deposit-scan-block-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when scanned chest lookup fails');
      },
      stop() {},
    },
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during deposit chest scan: block cache unavailable');
  assert.equal(acquireCalls, 0);
});

test('deposit reports preempt when chest scan aborts before throwing', async () => {
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  let acquireCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => {
      controller.abort('reactive-preempt');
      throw new Error('scan interrupted');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'deposit-scan-preempt-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when chest scan preempts');
      },
      stop() {},
    },
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during deposit chest scan');
  assert.equal(acquireCalls, 0);
});

test('deposit fails closed when movement setup is unavailable', async () => {
  const chestPos = pos(3, 64, 0);
  let setGoalCalls = 0;
  const bot = makeBot({
    registry: registryWithMissingMovementBlocks({
      blocksByName: { chest: { id: 1, name: 'chest' } },
    }),
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'deposit-movement-setup-test' }, release() {} }),
      setGoal: () => {
        setGoalCalls += 1;
        return true;
      },
      stop() {},
    },
  });

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /^deposit movement setup failed: /);
  assert.equal(setGoalCalls, 0);
});

test('deposit reports world-query failures while checking the locked chest after walking', async () => {
  const chestPos = pos(3, 64, 0);
  let blockLookups = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => {
      blockLookups += 1;
      if (blockLookups === 1) return { name: 'chest', position: chestPos };
      throw new Error('locked block cache unavailable');
    },
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed checking deposit chest: locked block cache unavailable');
});

test('deposit reports chest transfer failures', async () => {
  const chestPos = pos(3, 64, 0);
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      deposit: async () => {
        throw new Error('slot locked');
      },
      close() {},
    }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /chest\.deposit failed for oak_log: slot locked/);
});

test('deposit reports hung container deposit timeouts', async (t) => {
  const originalTimeout = config.executor.containerTransferTimeoutMs;
  config.executor.containerTransferTimeoutMs = 20;
  t.after(() => {
    config.executor.containerTransferTimeoutMs = originalTimeout;
  });

  const chestPos = pos(3, 64, 0);
  let closeCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      deposit: () => new Promise(() => {}),
      close() {
        closeCalls += 1;
      },
    }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'chest.deposit failed for oak_log: container deposit timed out after 20ms');
  assert.equal(closeCalls, 1);
});

test('deposit closes the container once when preempted during transfer', async () => {
  const chestPos = pos(3, 64, 0);
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  let closeCalls = 0;
  let depositCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      deposit: async () => {
        depositCalls += 1;
        controller.abort('reactive-preempt');
      },
      close() {
        closeCalls += 1;
      },
    }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during deposit transfer');
  assert.equal(depositCalls, 1);
  assert.equal(closeCalls, 1);
});

test('deposit reports reactive preempt when transfer throws after abort', async () => {
  const chestPos = pos(3, 64, 0);
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  let closeCalls = 0;
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      deposit: async () => {
        controller.abort('reactive-preempt');
        throw new Error('transfer interrupted');
      },
      close() {
        closeCalls += 1;
      },
    }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during deposit transfer');
  assert.equal(closeCalls, 1);
});

test('deposit reports inventory shortfall after partial transfer', async () => {
  const chestPos = pos(3, 64, 0);
  const bot = makeBot({
    inventory: { items: () => [{ name: 'oak_log', type: 1, count: 1 }] },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      deposit: async () => {},
      close() {},
    }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 2 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not enough oak_log (short by 1)');
});

test('deposit reports inventory read failures during transfer and closes the chest', async () => {
  const chestPos = pos(3, 64, 0);
  let closeCalls = 0;
  const bot = makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
    findBlocks: () => [chestPos],
    blockAt: () => ({ name: 'chest', position: chestPos }),
    openContainer: async () => ({
      deposit: async () => {
        throw new Error('should not transfer when inventory is unavailable');
      },
      close() {
        closeCalls += 1;
      },
    }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('goal_reached'));
    return true;
  };

  const result = await runDeposit(bot, { items: [{ name: 'oak_log', count: 1 }] }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory unavailable during deposit transfer: inventory cache unavailable');
  assert.equal(closeCalls, 1);
});

test('craft reports craft failure after recipe resolution', async () => {
  const recipe = { id: 'planks_recipe' };
  const bot = makeBot({
    recipesFor: () => [recipe],
    craft: async () => {
      throw new Error('missing grid slot');
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /craft failed: missing grid slot/);
});

test('craft reports hung craft operation timeouts', async (t) => {
  const originalTimeout = config.executor.craftOperationTimeoutMs;
  config.executor.craftOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.craftOperationTimeoutMs = originalTimeout;
  });

  const recipe = { id: 'planks_recipe' };
  const bot = makeBot({
    recipesFor: () => [recipe],
    craft: () => new Promise(() => {}),
  });

  const { value: result, records } = await captureStdoutRecords(() => (
    runCraft(bot, { item: 'oak_planks', count: 1 }, ctx())
  ));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'craft failed: craft operation timed out after 20ms');
  assert.equal(
    records.some((record) => (
      record.evt === 'craft.operation-timeout'
      && record.item === 'oak_planks'
      && record.phase === 'final'
      && record.count === 1
      && record.timeoutMs === 20
    )),
    true,
  );
});

test('craft reports reactive preempt when craft execution aborts', async () => {
  const recipe = { id: 'planks_recipe' };
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  const bot = makeBot({
    recipesFor: () => [recipe],
    craft: async () => {
      controller.abort('reactive-preempt');
      throw new Error('craft interrupted');
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during craft');
});

test('craft reports reactive preempt when hung craft operation is aborted', async (t) => {
  const originalTimeout = config.executor.craftOperationTimeoutMs;
  config.executor.craftOperationTimeoutMs = 1000;
  t.after(() => {
    config.executor.craftOperationTimeoutMs = originalTimeout;
  });

  const recipe = { id: 'planks_recipe' };
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  const bot = makeBot({
    recipesFor: () => [recipe],
    craft: () => new Promise(() => {}),
  });
  const started = Date.now();
  const resultPromise = runCraft(bot, { item: 'oak_planks', count: 1 }, callCtx);
  setTimeout(() => controller.abort('reactive-preempt'), 10);

  const result = await resultPromise;

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during craft');
  assert.ok(Date.now() - started < 250);
});

test('craft reports recipesFor lookup failures before table scan', async () => {
  let findBlocksCalls = 0;
  const bot = makeBot({
    recipesFor: () => {
      throw new Error('recipe index unavailable');
    },
    findBlocks: () => {
      findBlocksCalls += 1;
      return [];
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'recipe lookup failed during craft inventory recipe lookup: recipe index unavailable');
  assert.equal(findBlocksCalls, 0);
});

test('craft reports recipesAll lookup failures before table scan', async () => {
  let findBlocksCalls = 0;
  const bot = makeBot({
    recipesFor: () => [],
    recipesAll: () => {
      throw new Error('recipe catalog unavailable');
    },
    findBlocks: () => {
      findBlocksCalls += 1;
      return [];
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'recipe lookup failed during craft inventory recipe fallback: recipe catalog unavailable');
  assert.equal(findBlocksCalls, 0);
});

test('craft reports crafting-table walk failure', async () => {
  const tablePos = pos(2, 64, 0);
  const bot = makeBot({
    recipesFor: () => [],
    findBlock: () => ({ name: 'crafting_table', position: tablePos }),
    blockAt: () => ({ name: 'crafting_table', position: tablePos }),
  });
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('path_update', { status: 'noPath' }));
    return true;
  };

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'walk to crafting_table: noPath');
});

test('craft reports when the locked crafting table disappears', async () => {
  const callCtx = ctx();
  callCtx.callState.lockedTablePos = pos(2, 64, 0);
  callCtx.callState.walked = false;
  const bot = makeBot({
    blockAt: () => null,
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked crafting_table no longer present');
});

test('craft reports world-query failures during crafting table scan', async () => {
  let acquireCalls = 0;
  const bot = makeBot({
    recipesFor: () => [],
    findBlocks: () => {
      throw new Error('table index unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'craft-table-scan-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when table scan fails');
      },
      stop() {},
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during craft table scan: table index unavailable');
  assert.equal(acquireCalls, 0);
});

test('craft reports world-query failures while inspecting scanned crafting tables', async () => {
  const tablePos = pos(2, 64, 0);
  let acquireCalls = 0;
  const bot = makeBot({
    recipesFor: () => [],
    findBlocks: () => [tablePos],
    blockAt: () => {
      throw new Error('block cache unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'craft-table-scan-block-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when scanned table lookup fails');
      },
      stop() {},
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed during craft table scan: block cache unavailable');
  assert.equal(acquireCalls, 0);
});

test('craft reports preempt when crafting table scan aborts before throwing', async () => {
  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  let acquireCalls = 0;
  const bot = makeBot({
    recipesFor: () => [],
    findBlocks: () => {
      controller.abort('reactive-preempt');
      throw new Error('table scan interrupted');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'craft-table-scan-preempt-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when table scan preempts');
      },
      stop() {},
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, callCtx);

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during craft table scan');
  assert.equal(acquireCalls, 0);
});

test('craft fails closed when movement setup is unavailable', async () => {
  const tablePos = pos(2, 64, 0);
  let setGoalCalls = 0;
  const bot = makeBot({
    registry: registryWithMissingMovementBlocks({
      blocksByName: { crafting_table: { id: 1, name: 'crafting_table' } },
      itemsByName: { oak_planks: { id: 2, name: 'oak_planks' } },
    }),
    recipesFor: () => [],
    findBlock: () => ({ name: 'crafting_table', position: tablePos }),
    blockAt: () => ({ name: 'crafting_table', position: tablePos }),
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'craft-movement-setup-test' }, release() {} }),
      setGoal: () => {
        setGoalCalls += 1;
        return true;
      },
      stop() {},
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /^craft movement setup failed: /);
  assert.equal(setGoalCalls, 0);
});

test('craft reports world-query failures while checking the locked crafting table', async () => {
  const callCtx = ctx();
  callCtx.callState.lockedTablePos = pos(2, 64, 0);
  callCtx.callState.walked = false;
  let acquireCalls = 0;
  const bot = makeBot({
    blockAt: () => {
      throw new Error('locked table cache unavailable');
    },
    pathfinderOwner: {
      acquire: () => {
        acquireCalls += 1;
        return { token: { id: 'craft-locked-table-read-test' }, release() {} };
      },
      setGoal: () => {
        throw new Error('should not path when locked table lookup fails');
      },
      stop() {},
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, callCtx);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'world query failed checking crafting_table: locked table cache unavailable');
  assert.equal(acquireCalls, 0);
});

test('craft reports inventory read failures during dependency staging', async () => {
  const plankRecipe = {
    id: 'oak_planks_from_log',
    result: { id: TEST_REGISTRY.itemsByName.oak_planks.id, count: 4 },
    ingredients: [{ id: TEST_REGISTRY.itemsByName.oak_log.id, count: 1 }],
  };
  const bot = makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
    recipesFor: () => [],
    recipesAll: () => [plankRecipe],
    craft: async () => {
      throw new Error('should not craft when inventory is unavailable');
    },
  });

  const result = await runCraft(bot, { item: 'oak_planks', count: 1 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory unavailable during craft dependency staging: inventory cache unavailable');
});

test('storage withdrawal fails closed when movement setup is unavailable', async () => {
  const storagePos = pos(3, 64, 0);
  let setGoalCalls = 0;
  const bot = makeBot({
    registry: registryWithMissingMovementBlocks(),
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'storage-movement-setup-test' }, release() {} }),
      setGoal: () => {
        setGoalCalls += 1;
        return true;
      },
      stop() {},
    },
  });

  const result = await withdrawFromKnownStorage(
    bot,
    [{ item: 'oak_log', count: 1, position: storagePos, storageId: 'storage_1' }],
    ctx(),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /^storage withdrawal movement setup failed: /);
  assert.equal(setGoalCalls, 0);
});

test('flee reports terminal pathing failures instead of success', async () => {
  const bot = makeBot();
  bot.pathfinderOwner.setGoal = () => {
    setImmediate(() => bot.emit('path_update', { status: 'noPath' }));
    return true;
  };

  const result = await runFlee(bot, { from: { x: -10, y: 64, z: 0 }, distance: 16 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'flee pathing failed: noPath');
});

test('flee fails closed when movement setup is unavailable', async () => {
  let setGoalCalls = 0;
  const bot = makeBot({
    registry: registryWithMissingMovementBlocks(),
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'flee-movement-setup-test' }, release() {} }),
      setGoal: () => {
        setGoalCalls += 1;
        return true;
      },
      stop() {},
    },
  });

  const result = await runFlee(bot, { from: { x: -10, y: 64, z: 0 }, distance: 16 }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /^flee movement setup failed: /);
  assert.equal(setGoalCalls, 0);
});

test('equip reports runtime equip failures', async () => {
  const bot = makeBot({
    inventory: { items: () => [{ name: 'iron_sword', type: 267, count: 1 }] },
    equip: async () => {
      throw new Error('slot rejected');
    },
  });

  const result = await runEquip(bot, { item: 'iron_sword', destination: 'hand' }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.reason, /equip failed: slot rejected/);
});

test('equip reports hung equip operation timeouts', async (t) => {
  const originalTimeout = config.executor.equipOperationTimeoutMs;
  config.executor.equipOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.equipOperationTimeoutMs = originalTimeout;
  });

  const bot = makeBot({
    inventory: { items: () => [{ name: 'iron_sword', type: 267, count: 1 }] },
    equip: () => new Promise(() => {}),
  });

  const { value: result, records } = await captureStdoutRecords(() => (
    runEquip(bot, { item: 'iron_sword', destination: 'hand' }, ctx())
  ));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'equip failed: equip operation timed out after 20ms');
  assert.equal(
    records.some((record) => (
      record.evt === 'equip.operation-timeout'
      && record.item === 'iron_sword'
      && record.destination === 'hand'
      && record.timeoutMs === 20
    )),
    true,
  );
});

test('equip reports reactive preempt when hung equip operation is aborted', async (t) => {
  const originalTimeout = config.executor.equipOperationTimeoutMs;
  config.executor.equipOperationTimeoutMs = 1000;
  t.after(() => {
    config.executor.equipOperationTimeoutMs = originalTimeout;
  });

  const controller = new AbortController();
  const callCtx = {
    ...ctx(),
    signal: controller.signal,
  };
  const bot = makeBot({
    inventory: { items: () => [{ name: 'iron_sword', type: 267, count: 1 }] },
    equip: () => new Promise(() => {}),
  });
  const started = Date.now();
  const resultPromise = runEquip(bot, { item: 'iron_sword', destination: 'hand' }, callCtx);
  setTimeout(() => controller.abort('reactive-preempt'), 10);

  const result = await resultPromise;

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during equip');
  assert.ok(Date.now() - started < 250);
});

test('equip reports inventory read failures', async () => {
  const bot = makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
    equip: async () => {
      throw new Error('should not equip when inventory is unavailable');
    },
  });

  const result = await runEquip(bot, { item: 'iron_sword', destination: 'hand' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory unavailable during equip: inventory cache unavailable');
});

test('build dry-run reports inventory read failures before planning', async () => {
  const bot = makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
  });

  const result = await runBuild(
    bot,
    {
      dryRun: true,
      anchor: { x: 0, y: 64, z: 0 },
      blocks: [{ offset: { x: 0, y: 0, z: 0 }, blockState: 'minecraft:oak_planks' }],
    },
    ctx()
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory unavailable during build dry-run: inventory cache unavailable');
});
