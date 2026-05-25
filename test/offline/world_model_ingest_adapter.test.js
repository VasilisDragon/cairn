import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WorldModelStore,
  collectVisibleBlockSamples,
  ingestVisibleWorld,
} from '../../src/state/world_model.js';

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
    entity: { position: { x: 0, y: 64, z: 0 } },
    calls,
    blockAt(pos) {
      calls.push(pos);
      return blocks[key(pos.x, pos.y, pos.z)] || block('air', pos.x, pos.y, pos.z);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('collectVisibleBlockSamples samples non-air blocks around bot position', () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('grass_block', 0, 64, 0),
      [key(1, 64, 0)]: block('chest', 1, 64, 0),
      [key(0, 65, 0)]: block('air', 0, 65, 0),
    },
  });

  const samples = collectVisibleBlockSamples(bot, { radius: 1, yMin: 0, yMax: 1 });

  assert.equal(samples.some((sample) => sample.name === 'grass_block'), true);
  assert.equal(samples.some((sample) => sample.name === 'chest'), true);
  assert.equal(samples.some((sample) => sample.name === 'air'), false);
});

test('collectVisibleBlockSamples respects deterministic sample limit', () => {
  const bot = makeBot({
    blocks: {
      [key(-1, 64, -1)]: block('stone', -1, 64, -1),
      [key(-1, 64, 0)]: block('stone', -1, 64, 0),
      [key(-1, 64, 1)]: block('stone', -1, 64, 1),
    },
  });

  const samples = collectVisibleBlockSamples(bot, { radius: 1, yMin: 0, yMax: 0, limit: 2 });

  assert.equal(samples.length, 2);
});

test('ingestVisibleWorld waits for chunksReady before sampling and persists results', async () => {
  const gate = deferred();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-world-ingest-'));
  const store = new WorldModelStore(path.join(dir, 'world-model.json'));
  const bot = makeBot({
    chunksReady: gate.promise,
    blocks: {
      [key(0, 64, 0)]: block('oak_planks', 0, 64, 0),
      [key(1, 64, 0)]: block('oak_door', 1, 64, 0),
      [key(0, 65, 0)]: block('glass_pane', 0, 65, 0),
      [key(1, 65, 0)]: block('chest', 1, 65, 0),
    },
  });

  const running = ingestVisibleWorld(bot, store, {
    radius: 1,
    yMin: 0,
    yMax: 1,
    now: '2026-05-22T00:00:00.000Z',
  });
  await Promise.resolve();

  assert.equal(bot.calls.length, 0);

  gate.resolve();
  const model = await running;

  assert.ok(bot.calls.length > 0);
  assert.equal(model.visitedAreas.length, 1);
  assert.equal(model.storageSightings.some((sighting) => sighting.name === 'chest'), true);
  assert.equal(store.load().visitedAreas.length, 1);
});

test('ingestVisibleWorld chunk wait is abortable before sampling', async () => {
  const gate = deferred();
  const store = {
    ingestBlockSamples() {
      throw new Error('should not ingest after abort');
    },
  };
  const bot = makeBot({ chunksReady: gate.promise });
  const controller = new AbortController();
  const running = ingestVisibleWorld(bot, store, { signal: controller.signal });
  await Promise.resolve();

  controller.abort('reactive-preempt');
  const result = await running;

  assert.equal(bot.calls.length, 0);
  assert.equal(result.preempted, true);
  assert.match(result.reason, /chunk/i);
});

test('ingestVisibleWorld reports sampling failures', async () => {
  const bot = makeBot();
  bot.blockAt = () => {
    throw new Error('block cache unavailable');
  };
  const store = {
    ingestBlockSamples() {
      throw new Error('should not ingest after sampling failure');
    },
  };

  const result = await ingestVisibleWorld(bot, store, { radius: 1, yMin: 0, yMax: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'visible-world ingest failed: block cache unavailable');
});

test('ingestVisibleWorld reports store failures', async () => {
  const bot = makeBot({
    blocks: {
      [key(0, 64, 0)]: block('oak_planks', 0, 64, 0),
    },
  });
  const store = {
    ingestBlockSamples() {
      throw new Error('store unavailable');
    },
  };

  const result = await ingestVisibleWorld(bot, store, { radius: 1, yMin: 0, yMax: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'visible-world ingest failed: store unavailable');
});

test('ingestVisibleWorld reports preempt when sampling aborts before throwing', async () => {
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
  };

  const result = await ingestVisibleWorld(bot, store, {
    radius: 1,
    yMin: 0,
    yMax: 0,
    signal: controller.signal,
  });

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during visible-world ingest');
});

test('ingestVisibleWorld reports preempt when store ingest aborts before throwing', async () => {
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
  };

  const result = await ingestVisibleWorld(bot, store, {
    radius: 1,
    yMin: 0,
    yMax: 0,
    signal: controller.signal,
  });

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during visible-world ingest');
});
