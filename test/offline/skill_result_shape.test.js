import test from 'node:test';
import assert from 'node:assert/strict';

import { run as runBuild } from '../../src/skills/build_from_schematic.js';
import { run as runCollect } from '../../src/skills/collect.js';
import { run as runConsume } from '../../src/skills/consume.js';
import { run as runCraft } from '../../src/skills/craft.js';
import { run as runDeposit } from '../../src/skills/deposit.js';
import { run as runEquip } from '../../src/skills/equip.js';
import { run as runFishAndDeposit } from '../../src/skills/fish_and_deposit.js';
import { run as runFishUntil } from '../../src/skills/fish_until.js';
import { run as runGoto } from '../../src/skills/goto.js';
import { run as runLogout } from '../../src/skills/logout.js';
import { run as runMineAndReturn } from '../../src/skills/mine_and_return.js';
import { run as runMineUntil } from '../../src/skills/mine_until.js';
import { run as runMineWithProgression } from '../../src/skills/mine_with_progression.js';
import { run as runObserve } from '../../src/skills/observe.js';
import { run as runRecoverDrops } from '../../src/skills/recover_drops.js';
import { run as runSmelt } from '../../src/skills/smelt.js';

function makeBot(overrides = {}) {
  return {
    chunksReady: Promise.resolve(),
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    registry: {
      blocksByName: {},
      itemsByName: {},
    },
    quitReason: null,
    quit(reason) {
      this.quitReason = reason;
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

function assertResultShape(result, { terminal = true } = {}) {
  assert.equal(typeof result, 'object');
  if (terminal) assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.reason, 'string');
  assert.ok('state' in result);
  assert.equal(typeof result.state, 'object');
}

test('observe returns a structured success result', async () => {
  const result = await runObserve(makeBot(), {}, ctx());

  assertResultShape(result);
  assert.equal(result.ok, true);
});

test('collect unknown block returns structured actionable failure', async () => {
  const result = await runCollect(makeBot(), { block: 'not_a_block', count: 1 }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown block "not_a_block"/);
});

test('goto missing target returns structured actionable failure', async () => {
  const result = await runGoto(makeBot(), {}, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires \{x,y,z\} OR \{block\} OR \{entity\}/);
});

test('deposit empty item list returns structured actionable failure', async () => {
  const result = await runDeposit(makeBot(), { items: [] }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /deposit\.items must be a non-empty array/);
});

test('craft unknown item returns structured actionable failure', async () => {
  const result = await runCraft(makeBot(), { item: 'not_an_item', count: 1 }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown item "not_an_item"/);
});

test('smelt unknown input returns structured actionable failure', async () => {
  const result = await runSmelt(makeBot(), { input: 'not_an_item', output: 'iron_ingot', count: 1 }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown input item "not_an_item"/);
});

test('equip bad destination returns structured actionable failure', async () => {
  const result = await runEquip(makeBot(), { item: 'oak_log', destination: 'pocket' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /bad destination "pocket"/);
});

test('equip unknown item returns structured actionable failure before inventory read', async () => {
  const bot = makeBot({
    registry: { blocksByName: {}, itemsByName: { iron_sword: { id: 267 } } },
    inventory: {
      items() {
        throw new Error('inventory should not be read for unknown item');
      },
    },
  });

  const result = await runEquip(bot, { item: 'not_an_item', destination: 'hand' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown item "not_an_item"/);
});

test('fish_until missing target returns structured actionable failure', async () => {
  const result = await runFishUntil(makeBot({
    _client: { on() {}, removeListener() {} },
    activateItem() {},
  }), {}, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires catches or durationMs/);
});

test('fish_and_deposit missing chest returns structured actionable failure', async () => {
  const result = await runFishAndDeposit(makeBot(), { catches: 1 }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires depositChest/);
});

test('mine_until unknown ore returns structured actionable failure', async () => {
  const result = await runMineUntil(makeBot(), { count: 1, ores: ['not_an_ore'] }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown ore block "not_an_ore"/);
});

test('mine_and_return missing return chest returns structured actionable failure', async () => {
  const result = await runMineAndReturn(makeBot(), { count: 1, ores: ['coal_ore'] }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires returnChest/);
});

test('mine_with_progression missing ores returns structured actionable failure', async () => {
  const result = await runMineWithProgression(makeBot(), { count: 1 }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires ores/);
});

test('consume unknown item returns structured actionable failure before inventory read', async () => {
  const bot = makeBot({
    registry: { blocksByName: {}, itemsByName: { cooked_beef: { id: 364 } } },
    inventory: {
      items() {
        throw new Error('inventory should not be read for unknown item');
      },
    },
  });

  const result = await runConsume(bot, { item: 'not_an_item' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown item "not_an_item"/);
});

test('equip selects the lowest-slot matching inventory item', async () => {
  let equipped = null;
  let destination = null;
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'iron_sword', slot: 30, count: 1 },
        { name: 'iron_sword', slot: 8, count: 1 },
        { name: 'stone', slot: 1, count: 64 },
      ],
    },
    equip(item, dest) {
      equipped = item;
      destination = dest;
    },
  });

  const result = await runEquip(bot, { item: 'iron_sword', destination: 'hand' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, true);
  assert.equal(equipped.slot, 8);
  assert.equal(destination, 'hand');
});

test('equip routes through the humanization boundary when installed', async () => {
  const calls = [];
  const bot = makeBot({
    inventory: {
      items: () => [
        { name: 'iron_sword', slot: 8, count: 1 },
      ],
    },
    equip(item, dest) {
      calls.push(['raw', item.name, dest]);
    },
  });
  bot.humanizer = {
    equipItem(targetBot, item, destination, opts = {}) {
      calls.push(['humanized', opts.reason, opts.critical === true, item.name, destination]);
      return Promise.resolve(targetBot.equip(item, destination));
    },
  };

  const result = await runEquip(bot, { item: 'iron_sword', destination: 'hand' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['humanized', 'equip.skill', false, 'iron_sword', 'hand'],
    ['raw', 'iron_sword', 'hand'],
  ]);
});

test('logout returns structured success and quits', async () => {
  const bot = makeBot();
  const result = await runLogout(bot, { reason: 'unit-test' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, true);
  assert.equal(bot.quitReason, 'unit-test');
});

test('logout reports unavailable quit hook', async () => {
  const bot = makeBot({ quit: null });
  const result = await runLogout(bot, { reason: 'unit-test' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'logout failed: bot.quit unavailable');
});

test('logout reports quit failures', async () => {
  const bot = makeBot({
    quit() {
      throw new Error('socket already closed');
    },
  });
  const result = await runLogout(bot, { reason: 'unit-test' }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'logout failed: socket already closed');
});

test('logout reports preempt when quit aborts before throwing', async () => {
  const controller = new AbortController();
  const bot = makeBot({
    quit() {
      controller.abort('reactive-preempt');
      throw new Error('socket interrupted');
    },
  });
  const result = await runLogout(bot, { reason: 'unit-test' }, ctx({ signal: controller.signal }));

  assertResultShape(result, { terminal: false });
  assert.equal(result.preempted, true);
  assert.equal(result.reason, 'reactive preempt during logout');
});

test('recover_drops dimension mismatch returns structured actionable failure', async () => {
  const result = await runRecoverDrops(
    makeBot(),
    { x: 0, y: 64, z: 0, dimension: 'the_nether' },
    ctx(),
  );

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /dimension the_nether differs from current dimension overworld/);
});

test('build_from_schematic live placement path returns structured actionable failure', async () => {
  const result = await runBuild(makeBot(), { schematic: 'house.schem', anchor: { x: 0, y: 64, z: 0 } }, ctx());

  assertResultShape(result);
  assert.equal(result.ok, false);
  assert.match(result.reason, /placement is not implemented/);
});
