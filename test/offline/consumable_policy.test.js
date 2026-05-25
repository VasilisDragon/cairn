import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseConsumableAction,
  classifyConsumable,
} from '../../src/reactive/consumable_policy.js';

const playerThreat = { entity: { name: 'player', type: 'player', username: 'Alex' }, distance: 8 };
const zombieThreat = { entity: { name: 'zombie' }, distance: 6 };

function item(name, slot, extra = {}) {
  return { name, slot, count: 1, ...extra };
}

test('consumable policy classifies food, golden apples, and drinkable potions', () => {
  assert.deepEqual(classifyConsumable(item('cooked_beef', 3)), { kind: 'food', foodPoints: 8 });
  assert.deepEqual(classifyConsumable(item('golden_apple', 4)), { kind: 'golden_apple' });
  assert.deepEqual(classifyConsumable(item('enchanted_golden_apple', 5)), { kind: 'enchanted_golden_apple' });
  assert.deepEqual(
    classifyConsumable(item('potion', 6, { nbt: { value: { Potion: { value: 'minecraft:strong_strength' } } } })),
    { kind: 'potion', effect: 'strength', level: 2 },
  );
  assert.deepEqual(
    classifyConsumable(item('potion', 7, { displayName: 'Potion of Strength II' })),
    { kind: 'potion', effect: 'strength', level: 2 },
  );
});

test('critical health chooses instant health potion only when potions are authorized', () => {
  const potion = item('potion', 2, { potionType: 'minecraft:strong_healing' });

  assert.deepEqual(
    chooseConsumableAction({
      health: 5,
      inventoryItems: [potion],
      allowPotions: false,
    }),
    { action: 'none', reason: 'no-consumable-needed' },
  );

  assert.deepEqual(
    chooseConsumableAction({
      health: 5,
      inventoryItems: [potion],
      allowPotions: true,
      thresholds: { food: 10 },
    }),
    {
      action: 'drink_potion',
      reason: 'critical-instant-health',
      item: potion,
      effect: 'instant_health',
      level: 2,
    },
  );
});

test('low health uses regeneration before normal golden apple when authorized', () => {
  const regeneration = item('potion', 8, { potionType: 'minecraft:regeneration' });
  const golden = item('golden_apple', 3);

  assert.deepEqual(
    chooseConsumableAction({
      health: 11,
      inventoryItems: [golden, regeneration],
      allowPotions: true,
    }),
    {
      action: 'drink_potion',
      reason: 'low-health-regeneration',
      item: regeneration,
      effect: 'regeneration',
      level: 1,
    },
  );
});

test('enchanted golden apples require an explicit authorization flag', () => {
  const enchanted = item('enchanted_golden_apple', 1);

  assert.deepEqual(
    chooseConsumableAction({
      health: 5,
      inventoryItems: [enchanted],
      allowEnchantedGoldenApples: false,
    }),
    { action: 'none', reason: 'no-consumable-needed' },
  );

  assert.deepEqual(
    chooseConsumableAction({
      health: 5,
      inventoryItems: [enchanted],
      allowEnchantedGoldenApples: true,
    }),
    { action: 'eat', reason: 'critical-enchanted-golden-apple', item: enchanted },
  );
});

test('low food chooses the best normal food without spending golden apples', () => {
  const apple = item('apple', 1);
  const steak = item('cooked_beef', 8);
  const golden = item('golden_apple', 0);

  assert.deepEqual(
    chooseConsumableAction({
      food: 12,
      inventoryItems: [golden, apple, steak],
    }),
    { action: 'eat', reason: 'low-food', item: steak },
  );
});

test('authorized player combat can prebuff with strength II before attacking', () => {
  const strength = item('potion', 4, { potionType: 'minecraft:strong_strength' });

  assert.deepEqual(
    chooseConsumableAction({
      threat: playerThreat,
      intent: 'player_combat',
      inventoryItems: [strength],
      allowPotions: true,
      authorizedPlayerCombat: true,
    }),
    {
      action: 'drink_potion',
      reason: 'combat-strength',
      item: strength,
      effect: 'strength',
      level: 2,
    },
  );
});

test('player combat prebuffs are refused without explicit authorization', () => {
  const strength = item('potion', 4, { potionType: 'minecraft:strong_strength' });

  assert.deepEqual(
    chooseConsumableAction({
      threat: playerThreat,
      intent: 'player_combat',
      inventoryItems: [strength],
      allowPotions: true,
      authorizedPlayerCombat: false,
    }),
    { action: 'none', reason: 'player-combat-not-authorized' },
  );
});

test('combat buff policy avoids wasting potions already active at equal level', () => {
  const strength = item('potion', 4, { potionType: 'minecraft:strong_strength' });

  assert.deepEqual(
    chooseConsumableAction({
      threat: zombieThreat,
      intent: 'hostile_combat',
      inventoryItems: [strength],
      activeEffects: [{ name: 'strength', level: 2 }],
      allowPotions: true,
    }),
    { action: 'none', reason: 'no-consumable-needed' },
  );
});

test('combat buff policy prioritizes fire resistance when lava or fire is present', () => {
  const strength = item('potion', 4, { potionType: 'minecraft:strong_strength' });
  const fireResistance = item('potion', 3, { potionType: 'minecraft:fire_resistance' });

  assert.deepEqual(
    chooseConsumableAction({
      threat: zombieThreat,
      intent: 'hostile_combat',
      inventoryItems: [strength, fireResistance],
      allowPotions: true,
      environment: { fireOrLava: true },
    }),
    {
      action: 'drink_potion',
      reason: 'combat-fire-resistance',
      item: fireResistance,
      effect: 'fire_resistance',
      level: 1,
    },
  );
});

test('combat risk policy uses regeneration when melee survival margin is thin', () => {
  const regeneration = item('potion', 3, { potionType: 'minecraft:strong_regeneration' });

  assert.deepEqual(
    chooseConsumableAction({
      threat: zombieThreat,
      intent: 'hostile_combat',
      health: 20,
      inventoryItems: [regeneration],
      allowPotions: true,
      combatRisk: {
        estimatedSecondsToLowHealth: 3.4,
        meleeOffense: { estimatedSecondsToKill: 2.8 },
      },
    }),
    {
      action: 'drink_potion',
      reason: 'combat-risk-regeneration',
      item: regeneration,
      effect: 'regeneration',
      level: 2,
    },
  );
});

test('combat risk policy prioritizes immediate defensive prep before strength', () => {
  const strength = item('potion', 4, { potionType: 'minecraft:strong_strength' });
  const regeneration = item('potion', 3, { potionType: 'minecraft:strong_regeneration' });

  assert.deepEqual(
    chooseConsumableAction({
      threat: zombieThreat,
      intent: 'hostile_combat',
      health: 20,
      inventoryItems: [strength, regeneration],
      allowPotions: true,
      combatRisk: {
        estimatedSecondsToLowHealth: 2.5,
        meleeOffense: { estimatedSecondsToKill: 1.8 },
      },
    }),
    {
      action: 'drink_potion',
      reason: 'combat-risk-regeneration',
      item: regeneration,
      effect: 'regeneration',
      level: 2,
    },
  );
});

test('combat risk policy can choose strength before defensive prep for kill-window risk', () => {
  const strength = item('potion', 4, { potionType: 'minecraft:strong_strength' });
  const regeneration = item('potion', 3, { potionType: 'minecraft:strong_regeneration' });

  assert.deepEqual(
    chooseConsumableAction({
      threat: zombieThreat,
      intent: 'hostile_combat',
      health: 20,
      inventoryItems: [strength, regeneration],
      allowPotions: true,
      combatRisk: {
        estimatedSecondsToLowHealth: 5,
        meleeOffense: { estimatedSecondsToKill: 4.3 },
      },
    }),
    {
      action: 'drink_potion',
      reason: 'combat-strength',
      item: strength,
      effect: 'strength',
      level: 2,
    },
  );
});

test('combat risk policy can use a normal golden apple without potion authorization', () => {
  const golden = item('golden_apple', 2);

  assert.deepEqual(
    chooseConsumableAction({
      threat: zombieThreat,
      intent: 'hostile_combat',
      health: 20,
      inventoryItems: [golden],
      allowPotions: false,
      allowGoldenApples: true,
      combatRisk: {
        estimatedSecondsToLowHealth: 2.5,
        meleeOffense: { estimatedSecondsToKill: 1.8 },
      },
    }),
    { action: 'eat', reason: 'combat-risk-golden-apple', item: golden },
  );
});

test('combat risk policy does not spend golden apples when absorption is already active', () => {
  const golden = item('golden_apple', 2);

  assert.deepEqual(
    chooseConsumableAction({
      threat: zombieThreat,
      intent: 'hostile_combat',
      health: 20,
      inventoryItems: [golden],
      activeEffects: [{ name: 'absorption', level: 1 }],
      allowPotions: false,
      allowGoldenApples: true,
      combatRisk: {
        estimatedSecondsToLowHealth: 2.5,
        meleeOffense: { estimatedSecondsToKill: 1.8 },
      },
    }),
    { action: 'none', reason: 'no-consumable-needed' },
  );
});
