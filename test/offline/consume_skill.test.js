import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../../src/config.js';
import { run as runConsume } from '../../src/skills/consume.js';

function makeBot(overrides = {}) {
  return {
    chunksReady: Promise.resolve(),
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 12,
    foodSaturation: 2,
    entities: {},
    usingHeldItem: false,
    autoEat: { isEating: false },
    inventory: { items: () => [] },
    registry: { blocksByName: {}, itemsByName: {} },
    async equip(item, destination) {
      this.equipped = { item, destination };
      this.heldItem = item;
    },
    async consume() {
      this.consumeCalls = (this.consumeCalls || 0) + 1;
    },
    deactivateItem() {
      this.deactivateCalls = (this.deactivateCalls || 0) + 1;
      this.usingHeldItem = false;
    },
    ...overrides,
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

test('consume equips and consumes the lowest-slot normal food', async () => {
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'cooked_beef', count: 1, slot: 20 },
        { name: 'cooked_beef', count: 1, slot: 7 },
      ],
    },
  });

  const result = await runConsume(bot, { item: 'cooked_beef' }, ctx());

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'consumed cooked_beef');
  assert.equal(bot.equipped.item.slot, 7);
  assert.equal(bot.equipped.destination, 'hand');
  assert.equal(bot.consumeCalls, 1);
});

test('consume routes equip and use through the humanization boundary', async () => {
  const calls = [];
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'cooked_beef', count: 1, slot: 7 },
      ],
    },
  });
  bot.humanizer = {
    equipItem(targetBot, item, destination, opts = {}) {
      calls.push(['equip', opts.reason, opts.critical === true, item.name, destination]);
      return Promise.resolve(targetBot.equip(item, destination));
    },
    consumeHeldItem(targetBot, opts = {}) {
      calls.push(['consume', opts.reason, opts.critical === true]);
      return Promise.resolve(targetBot.consume());
    },
  };

  const result = await runConsume(bot, { item: 'cooked_beef' }, ctx());

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['equip', 'consume.equip', false, 'cooked_beef', 'hand'],
    ['consume', 'consume.use', false],
  ]);
});

test('reactive consume marks equip and use as critical humanization exemptions', async () => {
  const calls = [];
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'golden_apple', count: 1, slot: 7 },
      ],
    },
  });
  bot.humanizer = {
    equipItem(targetBot, item, destination, opts = {}) {
      calls.push(['equip', opts.reason, opts.critical === true, item.name, destination]);
      return Promise.resolve(targetBot.equip(item, destination));
    },
    consumeHeldItem(targetBot, opts = {}) {
      calls.push(['consume', opts.reason, opts.critical === true]);
      return Promise.resolve(targetBot.consume());
    },
  };

  const result = await runConsume(
    bot,
    { item: 'golden_apple' },
    ctx({ currentSubtask: 'reactive.consume(golden_apple)' }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['equip', 'consume.equip', true, 'golden_apple', 'hand'],
    ['consume', 'consume.use', true],
  ]);
});

test('consume refuses potions unless potion use is explicitly authorized', async () => {
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'potion', count: 1, slot: 7, potionType: 'minecraft:strong_strength' },
      ],
    },
  });

  const result = await runConsume(bot, { item: 'potion', effect: 'strength', minLevel: 2 }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'potion consumption requires allowPotions=true');
  assert.equal(bot.consumeCalls || 0, 0);
});

test('consume selects a potion by effect and minimum level', async () => {
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'potion', count: 1, slot: 3, potionType: 'minecraft:regeneration' },
        { name: 'potion', count: 1, slot: 5, potionType: 'minecraft:strength' },
        { name: 'potion', count: 1, slot: 12, displayName: 'Potion of Strength II' },
      ],
    },
  });

  const result = await runConsume(
    bot,
    { item: 'potion', effect: 'strength', minLevel: 2, allowPotions: true },
    ctx(),
  );

  assert.equal(result.ok, true);
  assert.equal(bot.equipped.item.slot, 12);
  assert.equal(bot.consumeCalls, 1);
});

test('consume refuses enchanted golden apples unless explicitly authorized', async () => {
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'enchanted_golden_apple', count: 1, slot: 9 },
      ],
    },
  });

  const result = await runConsume(bot, { item: 'enchanted_golden_apple' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'enchanted golden apple consumption requires allowEnchantedGoldenApples=true');
  assert.equal(bot.consumeCalls || 0, 0);
});

test('consume can use an explicitly authorized enchanted golden apple', async () => {
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'enchanted_golden_apple', count: 1, slot: 9 },
      ],
    },
  });

  const result = await runConsume(
    bot,
    { item: 'enchanted_golden_apple', allowEnchantedGoldenApples: true },
    ctx(),
  );

  assert.equal(result.ok, true);
  assert.equal(bot.equipped.item.slot, 9);
  assert.equal(bot.consumeCalls, 1);
});

test('consume reports unsupported items before equip or use', async () => {
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'stone', count: 1, slot: 9 },
      ],
    },
  });

  const result = await runConsume(bot, { item: 'stone' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stone is not a supported consumable');
  assert.equal(bot.consumeCalls || 0, 0);
});

test('consume reports inventory read failures', async () => {
  const bot = makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
  });

  const result = await runConsume(bot, { item: 'cooked_beef' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory unavailable during consume: inventory cache unavailable');
  assert.equal(bot.consumeCalls || 0, 0);
});

test('consume fails cleanly when another item use is active', async () => {
  const bot = makeBot({
    usingHeldItem: true,
    inventory: {
      items: () => [
        { name: 'cooked_beef', count: 1, slot: 9 },
      ],
    },
  });

  const result = await runConsume(bot, { item: 'cooked_beef' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'consume blocked: item use already active');
  assert.equal(bot.consumeCalls || 0, 0);
});

test('consume bounds hung item use and deactivates the held item on timeout', async (t) => {
  const originalTimeout = config.executor.consumeOperationTimeoutMs;
  config.executor.consumeOperationTimeoutMs = 20;
  t.after(() => {
    config.executor.consumeOperationTimeoutMs = originalTimeout;
  });

  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'cooked_beef', count: 1, slot: 9 },
      ],
    },
    consume() {
      this.usingHeldItem = true;
      return new Promise(() => {});
    },
  });

  const result = await runConsume(bot, { item: 'cooked_beef' }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'consume failed: consume operation timed out after 20ms');
  assert.equal(bot.deactivateCalls, 1);
  assert.equal(bot.usingHeldItem, false);
});

test('consume reports reactive preempt and deactivates held item during hung use', async () => {
  const controller = new AbortController();
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'cooked_beef', count: 1, slot: 9 },
      ],
    },
    consume() {
      this.usingHeldItem = true;
      return new Promise(() => {});
    },
  });

  const started = Date.now();
  const resultPromise = runConsume(bot, { item: 'cooked_beef' }, ctx({ signal: controller.signal }));
  setTimeout(() => controller.abort('reactive-preempt'), 10);
  const result = await resultPromise;

  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during consume');
  assert.equal(bot.deactivateCalls, 1);
  assert.equal(bot.usingHeldItem, false);
  assert.ok(Date.now() - started < 250);
});
