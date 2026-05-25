import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run as runObserve } from '../../src/skills/observe.js';
import { WorldModelStore, createEmptyWorldModel } from '../../src/state/world_model.js';

function key(x, y, z) {
  return `${x},${y},${z}`;
}

function block(name, x, y, z) {
  return { name, position: { x, y, z } };
}

function makeBot({ blocks = {}, chunksReady = Promise.resolve() } = {}) {
  const calls = [];
  return {
    chunksReady,
    calls,
    entity: { position: { x: 0, y: 64, z: 0 }, velocity: { y: 0 }, onGround: true, isInWater: false },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    pathfinderOwner: { currentOwner: () => null, isIdle: () => true },
    blockAt(pos) {
      calls.push(pos);
      return blocks[key(pos.x, pos.y, pos.z)] || block('air', pos.x, pos.y, pos.z);
    },
  };
}

function ctx(extra = {}) {
  return {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldModelIngestOptions: {
      radius: 1,
      yMin: 0,
      yMax: 1,
      now: '2026-05-22T00:00:00.000Z',
    },
    ...extra,
  };
}

test('observe ingests visible world into the provided world-model store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-observe-ingest-'));
  const store = new WorldModelStore(path.join(dir, 'world-model.json'));
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('oak_planks', 0, 64, 0),
      [key(1, 64, 0)]: block('chest', 1, 64, 0),
    },
  });

  const result = await runObserve(bot, {}, ctx({ worldModelStore: store }));

  assert.equal(result.ok, true);
  assert.match(result.reason, /world-model samples:/);
  assert.ok(bot.calls.length > 0);
  assert.equal(store.load().visitedAreas.length, 1);
  assert.equal(store.load().storageSightings.some((sighting) => sighting.name === 'chest'), true);
  assert.equal(result.state.worldModel.knownStorage.some((sighting) => sighting.name === 'chest'), true);
});

test('observe compacts repeated visible-world observations for the same area', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-observe-repeat-'));
  const store = new WorldModelStore(path.join(dir, 'world-model.json'));
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('oak_planks', 0, 64, 0),
      [key(1, 64, 0)]: block('chest', 1, 64, 0),
    },
  });

  await runObserve(bot, {}, ctx({ worldModelStore: store }));
  const result = await runObserve(bot, {}, ctx({
    worldModelStore: store,
    worldModelIngestOptions: {
      radius: 1,
      yMin: 0,
      yMax: 1,
      now: '2026-05-22T00:01:00.000Z',
    },
  }));

  const model = store.load();
  assert.equal(model.visitedAreas.length, 1);
  assert.equal(model.visitedAreas[0].seenCount, 2);
  assert.equal(model.visitedAreas[0].lastSeenAt, '2026-05-22T00:01:00.000Z');
  assert.equal(model.interestingRegions.length, 1);
  assert.equal(model.interestingRegions[0].seenCount, 2);
  assert.equal(model.doNotTouchRegions.length, 1);
  assert.equal(model.doNotTouchRegions[0].seenCount, 2);
  assert.equal(result.state.worldModel.visitedAreaCount, 1);
});

test('observe reports but isolates world-model ingest failures', async () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('oak_planks', 0, 64, 0),
    },
  });
  const store = {
    ingestBlockSamples() {
      throw new Error('store unavailable');
    },
    load() {
      return createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
    },
  };

  const result = await runObserve(bot, {}, ctx({ worldModelStore: store }));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'snapshot captured (world-model ingest failed: store unavailable)');
  assert.equal(result.state.worldModel.visitedAreaCount, 0);
});

test('observe reports but isolates visible-world sampling failures', async () => {
  const bot = makeBot();
  bot.blockAt = () => {
    throw new Error('block cache unavailable');
  };
  const store = {
    ingestBlockSamples() {
      throw new Error('should not ingest after sampling failure');
    },
    load() {
      return createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
    },
  };

  const result = await runObserve(bot, {}, ctx({ worldModelStore: store }));

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'snapshot captured (world-model ingest failed: block cache unavailable)');
  assert.equal(result.state.worldModel.visitedAreaCount, 0);
});

test('observe reports preempt when sampling aborts before throwing', async () => {
  const controller = new AbortController();
  const bot = makeBot();
  bot.blockAt = () => {
    controller.abort('reactive-preempt');
    throw new Error('block cache interrupted');
  };
  const store = {
    ingestBlockSamples() {
      throw new Error('should not ingest after sampling failure');
    },
    load() {
      return createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
    },
  };

  const result = await runObserve(bot, {}, ctx({ worldModelStore: store, signal: controller.signal }));

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during observe world-model ingest');
  assert.equal(result.state.worldModel.visitedAreaCount, 0);
});

test('observe reports preempt when store ingest aborts before throwing', async () => {
  const controller = new AbortController();
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('oak_planks', 0, 64, 0),
    },
  });
  const store = {
    ingestBlockSamples() {
      controller.abort('reactive-preempt');
      throw new Error('store interrupted');
    },
    load() {
      return createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
    },
  };

  const result = await runObserve(bot, {}, ctx({ worldModelStore: store, signal: controller.signal }));

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during observe world-model ingest');
  assert.equal(result.state.worldModel.visitedAreaCount, 0);
});

test('observe world-model chunk wait is abortable before sampling', async () => {
  let resolveChunks;
  const chunksReady = new Promise((resolve) => { resolveChunks = resolve; });
  const bot = makeBot({ chunksReady });
  const store = {
    ingestBlockSamples() {
      throw new Error('should not ingest after abort');
    },
    load() {
      return createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
    },
  };
  const controller = new AbortController();
  const running = runObserve(bot, {}, ctx({ worldModelStore: store, signal: controller.signal }));
  await Promise.resolve();

  controller.abort('reactive-preempt');
  const result = await running;

  assert.equal(bot.calls.length, 0);
  assert.equal(result.preempted, true);
  assert.match(result.reason, /chunk|world-model ingest/i);
  resolveChunks();
});
