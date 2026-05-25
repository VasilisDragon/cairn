import test from 'node:test';
import assert from 'node:assert/strict';
import registryLoader from 'prismarine-registry';
import blockLoader from 'prismarine-block';

import { estimateFallbackDigTime, installDigTimeFallback, toolSpeedForItem } from '../../src/control/dig_time.js';

const registry = registryLoader('1.21.1');
const Block = blockLoader(registry);

function blockByName(name) {
  const descriptor = registry.blocksByName[name];
  const block = Block.fromStateId(descriptor.minStateId, 0);
  block.position = { x: 0, y: 64, z: 0 };
  return block;
}

function makeBot({ heldItemName = 'netherite_pickaxe', onGround = true, effects = {} } = {}) {
  const heldItem = heldItemName ? registry.itemsByName[heldItemName] : null;
  return {
    registry,
    heldItem: heldItem ? { ...heldItem, type: heldItem.id, enchants: [] } : null,
    entity: { onGround, effects },
    game: { gameMode: 'survival' },
    inventory: { slots: [] },
    getEquipmentDestSlot: () => 5,
    _getBlockAtEyeLevel: () => ({ name: 'air' }),
  };
}

test('toolSpeedForItem maps vanilla mining tool tiers', () => {
  assert.equal(toolSpeedForItem('wooden_pickaxe'), 2);
  assert.equal(toolSpeedForItem('stone_pickaxe'), 4);
  assert.equal(toolSpeedForItem('iron_pickaxe'), 6);
  assert.equal(toolSpeedForItem('diamond_pickaxe'), 8);
  assert.equal(toolSpeedForItem('netherite_pickaxe'), 9);
  assert.equal(toolSpeedForItem('golden_pickaxe'), 12);
  assert.equal(toolSpeedForItem('stick'), null);
});

test('fallback corrects missing modern ore tool-speed multipliers', () => {
  const bot = makeBot();
  const diamondOre = blockByName('diamond_ore');

  assert.equal(diamondOre.digTime(bot.heldItem.type, false, false, false, [], {}), 4550);
  assert.equal(estimateFallbackDigTime(bot, diamondOre), 500);
});

test('fallback preserves air and water penalties', () => {
  const diamondOre = blockByName('diamond_ore');

  assert.equal(estimateFallbackDigTime(makeBot({ onGround: false }), diamondOre), 2500);
  assert.equal(estimateFallbackDigTime({
    ...makeBot(),
    _getBlockAtEyeLevel: () => ({ name: 'water' }),
  }, diamondOre), 2500);
});

test('installDigTimeFallback only replaces slower registry results', () => {
  const records = [];
  const bot = makeBot();
  bot.digTime = (block) => block.digTime(bot.heldItem.type, false, false, false, [], {});
  installDigTimeFallback(bot, {
    info(evt, fields) {
      records.push({ evt, fields });
    },
  });

  assert.equal(bot.digTime(blockByName('diamond_ore')), 500);
  assert.equal(bot.digTime(blockByName('stone')), 250);
  assert.deepEqual(records.map((record) => record.evt), ['dig-time.fallback-installed', 'dig-time.fallback']);
});
