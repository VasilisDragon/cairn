import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import { SkillExecutor } from '../../src/executor/queue.js';
import interrupts from '../../src/reactive/interrupts.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    clone() { return pos(x, y, z); },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function recipe(id, output, ingredients) {
  return {
    id,
    result: output,
    ingredients,
  };
}

function storageSighting(storagePos, contents) {
  return {
    key: `chest:${storagePos.x},${storagePos.y},${storagePos.z}`,
    kind: 'storage',
    name: 'chest',
    position: storagePos,
    seenAt: '2026-05-22T00:00:00.000Z',
    contents,
  };
}

function inventoryItems(inventory) {
  return Object.entries(inventory)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, type: TEST_REGISTRY.itemsByName[name].id, count }));
}

function samePos(a, b) {
  return a?.x === b.x && a?.y === b.y && a?.z === b.z;
}

function makeBot({
  inventory,
  storageContents,
  allowedPos,
  craftOrder,
  selectedGoals,
  interruptFirstStorageWalk = false,
  interruptFirstStorageWalkReason = 'test storage interruption',
  interruptFirstStorageWalkReleaseReason = null,
  interruptReasons = null,
  stallStorageWalkInWater = false,
  onOpenContainer = null,
}) {
  const bot = new EventEmitter();
  let storageWalkAttempts = 0;
  const plankRecipe = recipe(
    'oak_planks_from_log',
    { name: 'oak_planks', count: 4 },
    [{ name: 'oak_log', count: 1 }],
  );
  const stickRecipe = recipe(
    'stick_from_planks',
    { name: 'stick', count: 4 },
    [{ name: 'oak_planks', count: 2 }],
  );

  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0), velocity: { y: 0 }, onGround: true, isInWater: stallStorageWalkInWater },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => inventoryItems(inventory) },
    registry: TEST_REGISTRY,
    pathfinderOwner: {
      bindSkillSignal(controller) { this.controller = controller; },
      unbindSkillSignal() { this.controller = null; },
      isIdle: () => true,
      currentOwner: () => null,
      acquire: () => ({ token: { id: 'scenario-storage-withdraw' }, release() {} }),
      setGoal: (_token, goal) => {
        selectedGoals.push({ x: goal.x, y: goal.y, z: goal.z });
        storageWalkAttempts += 1;
        if (interruptFirstStorageWalk && storageWalkAttempts === 1) {
          setImmediate(() => {
            const releaseReason = interruptFirstStorageWalkReleaseReason || `${interruptFirstStorageWalkReason} cleared`;
            bot.pathfinderOwner.controller?.abort('reactive-preempt');
            interruptReasons?.push(interruptFirstStorageWalkReason);
            interrupts.notifyPreempt(interruptFirstStorageWalkReason);
            setTimeout(() => interrupts.notifyRelease(releaseReason), 10);
          });
        } else if (stallStorageWalkInWater) {
          // Let awaitGoalReached's water progress watchdog decide the outcome.
        } else {
          setImmediate(() => bot.emit('goal_reached'));
        }
        return true;
      },
      stop() {},
    },
    recipesFor: (itemId) => {
      if (itemId === TEST_REGISTRY.itemsByName.oak_planks.id && inventory.oak_log >= 1) return [plankRecipe];
      if (itemId === TEST_REGISTRY.itemsByName.stick.id && inventory.oak_planks >= 2) return [stickRecipe];
      return [];
    },
    recipesAll: (itemId) => {
      if (itemId === TEST_REGISTRY.itemsByName.oak_planks.id) return [plankRecipe];
      if (itemId === TEST_REGISTRY.itemsByName.stick.id) return [stickRecipe];
      return [];
    },
    blockAt: (p) => (samePos(p, allowedPos) ? { name: 'chest', position: p } : { name: 'air', position: p }),
    openContainer: async (block) => {
      if (onOpenContainer) onOpenContainer(block);
      assert.deepEqual(block.position, allowedPos);
      return {
        withdraw: async (type, _metadata, count) => {
          assert.equal(type, TEST_REGISTRY.itemsByName.oak_log.id);
          assert.equal(count, 1);
          storageContents.oak_log -= count;
          inventory.oak_log += count;
        },
        containerItems: () => (storageContents.oak_log > 0 ? [{ name: 'oak_log', count: storageContents.oak_log }] : []),
        close() {},
      };
    },
    craft: async (resolvedRecipe, count) => {
      craftOrder.push(`${resolvedRecipe.id}:${count}`);
      if (resolvedRecipe.id === 'oak_planks_from_log') {
        inventory.oak_log -= count;
        inventory.oak_planks += 4 * count;
      } else if (resolvedRecipe.id === 'stick_from_planks') {
        inventory.oak_planks -= 2 * count;
        inventory.stick += 4 * count;
      }
    },
  });
  return bot;
}

test('offline scenario: executor crafts via allowed known storage and persisted world-model context', async (t) => {
  const protectedPos = pos(2, 64, 0);
  const allowedPos = pos(8, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.storageSightings.push(storageSighting(protectedPos, { oak_log: 1 }));
  model.storageSightings.push(storageSighting(allowedPos, { oak_log: 1 }));
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min: [2, 63, 0], max: [2, 65, 0] },
    reason: 'likely_player_made',
    confidence: 0.9,
  });

  const inventory = { oak_log: 0, oak_planks: 0, stick: 0 };
  const storageContents = { oak_log: 1 };
  const craftOrder = [];
  const selectedGoals = [];
  const savedModels = [];
  const store = {
    loadCalls: 0,
    load() {
      this.loadCalls += 1;
      return model;
    },
    save(nextModel) {
      savedModels.push(nextModel);
    },
  };
  const bot = makeBot({ inventory, storageContents, allowedPos, craftOrder, selectedGoals });
  const executor = new SkillExecutor(bot, { context: { worldModelStore: store } });
  t.after(() => executor.dispose());
  const results = [];
  const failures = [];
  let emptied = false;

  interrupts.lastReleasedAt = Date.now() - 5000;
  executor.on('skill:result', (event) => results.push(event));
  executor.on('queue:failure', (event) => failures.push(event));
  executor.on('queue:empty', () => { emptied = true; });

  executor.enqueue([
    { skill: 'observe', params: {} },
    { skill: 'craft', params: { item: 'stick', count: 1 } },
    { skill: 'observe', params: {} },
  ]);
  await executor.runUntilDone();

  assert.equal(emptied, true);
  assert.equal(failures.length, 0);
  assert.deepEqual(results.map((event) => `${event.call.skill}:${event.result.ok}`), [
    'observe:true',
    'craft:true',
    'observe:true',
  ]);
  assert.equal(results[1].result.reason, 'crafted 1 stick');
  assert.deepEqual(craftOrder, ['oak_planks_from_log:1', 'stick_from_planks:1']);
  assert.deepEqual(inventory, { oak_log: 0, oak_planks: 2, stick: 4 });
  assert.deepEqual(selectedGoals, [{ x: allowedPos.x, y: allowedPos.y, z: allowedPos.z }]);
  assert.equal(savedModels.length, 1);
  assert.equal(savedModels[0], model);
  assert.ok(store.loadCalls >= 3);
  assert.deepEqual(model.storageSightings.find((sighting) => sighting.key === `chest:${allowedPos.x},${allowedPos.y},${allowedPos.z}`).contents, {});
  assert.equal(results[0].result.state.worldModel.knownStorage.length, 2);
  assert.equal(results[2].result.state.worldModel.knownStorage.some((sighting) => sighting.position.x === allowedPos.x), true);
});

test('offline scenario: storage-backed craft resumes after withdrawal walk preempt', async (t) => {
  const allowedPos = pos(8, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.storageSightings.push(storageSighting(allowedPos, { oak_log: 1 }));

  const inventory = { oak_log: 0, oak_planks: 0, stick: 0 };
  const storageContents = { oak_log: 1 };
  const craftOrder = [];
  const selectedGoals = [];
  const savedModels = [];
  const store = {
    load() {
      return model;
    },
    save(nextModel) {
      savedModels.push(nextModel);
    },
  };
  const bot = makeBot({
    inventory,
    storageContents,
    allowedPos,
    craftOrder,
    selectedGoals,
    interruptFirstStorageWalk: true,
  });
  const executor = new SkillExecutor(bot, { context: { worldModelStore: store } });
  t.after(() => executor.dispose());
  const results = [];
  const failures = [];
  const preemptions = [];
  let emptied = false;

  interrupts.lastReleasedAt = Date.now() - 5000;
  executor.on('skill:preempted', (event) => preemptions.push(event));
  executor.on('skill:result', (event) => results.push(event));
  executor.on('queue:failure', (event) => failures.push(event));
  executor.on('queue:empty', () => { emptied = true; });

  executor.enqueue([{ skill: 'craft', params: { item: 'stick', count: 1 } }]);
  await executor.runUntilDone();

  assert.equal(emptied, true);
  assert.equal(failures.length, 0);
  assert.equal(preemptions.length, 1);
  assert.equal(preemptions[0].call.skill, 'craft');
  assert.match(preemptions[0].result.reason, /storage withdrawal walk/);
  assert.equal(results.length, 1);
  assert.equal(results[0].result.ok, true);
  assert.equal(results[0].result.reason, 'crafted 1 stick');
  assert.deepEqual(selectedGoals, [
    { x: allowedPos.x, y: allowedPos.y, z: allowedPos.z },
    { x: allowedPos.x, y: allowedPos.y, z: allowedPos.z },
  ]);
  assert.deepEqual(craftOrder, ['oak_planks_from_log:1', 'stick_from_planks:1']);
  assert.deepEqual(inventory, { oak_log: 0, oak_planks: 2, stick: 4 });
  assert.deepEqual(storageContents, { oak_log: 0 });
  assert.equal(savedModels.length, 1);
});

test('offline scenario: storage-backed craft resumes after hostile-flee preempt during withdrawal walk', async (t) => {
  const allowedPos = pos(8, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.storageSightings.push(storageSighting(allowedPos, { oak_log: 1 }));

  const inventory = { oak_log: 0, oak_planks: 0, stick: 0 };
  const storageContents = { oak_log: 1 };
  const craftOrder = [];
  const selectedGoals = [];
  const interruptReasons = [];
  const savedModels = [];
  const store = {
    load() {
      return model;
    },
    save(nextModel) {
      savedModels.push(nextModel);
    },
  };
  const bot = makeBot({
    inventory,
    storageContents,
    allowedPos,
    craftOrder,
    selectedGoals,
    interruptFirstStorageWalk: true,
    interruptFirstStorageWalkReason: 'hostile-flee',
    interruptFirstStorageWalkReleaseReason: 'threat-cleared',
    interruptReasons,
  });
  const executor = new SkillExecutor(bot, { context: { worldModelStore: store } });
  t.after(() => executor.dispose());
  const results = [];
  const failures = [];
  const preemptions = [];
  let emptied = false;

  interrupts.lastReleasedAt = Date.now() - 5000;
  executor.on('skill:preempted', (event) => preemptions.push(event));
  executor.on('skill:result', (event) => results.push(event));
  executor.on('queue:failure', (event) => failures.push(event));
  executor.on('queue:empty', () => { emptied = true; });

  executor.enqueue([{ skill: 'craft', params: { item: 'stick', count: 1 } }]);
  await executor.runUntilDone();

  assert.equal(emptied, true);
  assert.equal(failures.length, 0);
  assert.deepEqual(interruptReasons, ['hostile-flee']);
  assert.equal(preemptions.length, 1);
  assert.equal(preemptions[0].call.skill, 'craft');
  assert.equal(preemptions[0].result.reason, 'reactive preempt during storage withdrawal walk');
  assert.equal(results.length, 1);
  assert.equal(results[0].result.ok, true);
  assert.equal(results[0].result.reason, 'crafted 1 stick');
  assert.deepEqual(selectedGoals, [
    { x: allowedPos.x, y: allowedPos.y, z: allowedPos.z },
    { x: allowedPos.x, y: allowedPos.y, z: allowedPos.z },
  ]);
  assert.deepEqual(craftOrder, ['oak_planks_from_log:1', 'stick_from_planks:1']);
  assert.deepEqual(inventory, { oak_log: 0, oak_planks: 2, stick: 4 });
  assert.deepEqual(storageContents, { oak_log: 0 });
  assert.equal(savedModels.length, 1);
});

test('offline scenario: storage-backed craft fails cleanly on water stall during withdrawal walk', async (t) => {
  const allowedPos = pos(8, 64, 0);
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.storageSightings.push(storageSighting(allowedPos, { oak_log: 1 }));

  const inventory = { oak_log: 0, oak_planks: 0, stick: 0 };
  const storageContents = { oak_log: 1 };
  const craftOrder = [];
  const selectedGoals = [];
  let openContainerCalls = 0;
  const store = {
    load() {
      return model;
    },
    save() {
      throw new Error('should not save storage memory when pathing stalls before open');
    },
  };
  const bot = makeBot({
    inventory,
    storageContents,
    allowedPos,
    craftOrder,
    selectedGoals,
    stallStorageWalkInWater: true,
    onOpenContainer: () => {
      openContainerCalls += 1;
    },
  });
  const executor = new SkillExecutor(bot, {
    context: {
      worldModelStore: store,
      storageWithdrawalOptions: {
        timeoutMs: 1000,
        waterStallMs: 20,
        watchdogIntervalMs: 5,
      },
    },
  });
  t.after(() => executor.dispose());
  const results = [];
  const failures = [];
  const preemptions = [];

  interrupts.lastReleasedAt = Date.now() - 5000;
  executor.on('skill:preempted', (event) => preemptions.push(event));
  executor.on('skill:result', (event) => results.push(event));
  executor.on('queue:failure', (event) => failures.push(event));

  executor.enqueue([{ skill: 'craft', params: { item: 'stick', count: 1 } }]);
  await executor.runUntilDone();

  assert.equal(preemptions.length, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].result.ok, false);
  assert.match(results[0].result.reason, /walk to known storage chest:8,64,0: waterStall/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].result.reason, results[0].result.reason);
  assert.deepEqual(selectedGoals, [{ x: allowedPos.x, y: allowedPos.y, z: allowedPos.z }]);
  assert.equal(openContainerCalls, 0);
  assert.deepEqual(craftOrder, []);
  assert.deepEqual(inventory, { oak_log: 0, oak_planks: 0, stick: 0 });
  assert.deepEqual(storageContents, { oak_log: 1 });
});
