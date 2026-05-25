import test from 'node:test';
import assert from 'node:assert/strict';

import {
  armorScore,
  chooseCombatResponse,
  chooseShieldBlockResponse,
  estimateMeleeOffense,
  estimateMeleeSurvival,
  hasRangedAmmo,
  isMeleeWeapon,
  isRangedWeapon,
  isRangedAmmo,
  isShield,
  selectBestRangedWeapon,
  selectShield,
  selectBestMeleeWeapon,
  rangedWeaponScore,
  totalArmorScore,
  weaponScore,
} from '../../src/reactive/combat_policy.js';

function threat(name, extra = {}) {
  const { distance = 5, ...entityExtra } = extra;
  return { entity: { id: 1, name, ...entityExtra }, distance };
}

const IRON_CHESTPLATE = Object.freeze({ name: 'iron_chestplate', slot: 10 });
const ZOMBIE_IRON_SWORD_OFFENSE = Object.freeze({
  weapon: 'iron_sword',
  target: 'zombie',
  estimatedTargetHealth: 20,
  estimatedWeaponDamage: 6,
  estimatedAttackIntervalSeconds: 0.63,
  estimatedHitsToKill: 4,
  estimatedSecondsToKill: 2.52,
});
const ZOMBIE_DIAMOND_SWORD_OFFENSE = Object.freeze({
  weapon: 'diamond_sword',
  target: 'zombie',
  estimatedTargetHealth: 20,
  estimatedWeaponDamage: 7,
  estimatedAttackIntervalSeconds: 0.63,
  estimatedHitsToKill: 3,
  estimatedSecondsToKill: 1.89,
});
const ZOMBIE_NETHERITE_SWORD_OFFENSE = Object.freeze({
  weapon: 'netherite_sword',
  target: 'zombie',
  estimatedTargetHealth: 20,
  estimatedWeaponDamage: 8,
  estimatedAttackIntervalSeconds: 0.63,
  estimatedHitsToKill: 3,
  estimatedSecondsToKill: 1.89,
});

test('combat policy scores only swords and axes deterministically', () => {
  assert.equal(isMeleeWeapon({ name: 'netherite_sword' }), true);
  assert.equal(isMeleeWeapon({ name: 'diamond_axe' }), true);
  assert.equal(isMeleeWeapon({ name: 'bow' }), false);
  assert.equal(weaponScore({ name: 'netherite_sword' }) > weaponScore({ name: 'diamond_sword' }), true);
  assert.equal(weaponScore({ name: 'diamond_sword' }) > weaponScore({ name: 'diamond_axe' }), true);
});

test('combat policy selects the best melee weapon with stable tie-breaking', () => {
  const best = selectBestMeleeWeapon([
    { name: 'stone_axe', slot: 12 },
    { name: 'diamond_sword', slot: 20 },
    { name: 'diamond_sword', slot: 4 },
    { name: 'bow', slot: 1 },
  ]);

  assert.deepEqual(best, { name: 'diamond_sword', slot: 4 });
});

test('combat policy scores ranged weapons and ammo deterministically', () => {
  assert.equal(isRangedWeapon({ name: 'bow' }), true);
  assert.equal(isRangedWeapon({ name: 'crossbow' }), true);
  assert.equal(isRangedWeapon({ name: 'diamond_sword' }), false);
  assert.equal(rangedWeaponScore({ name: 'bow' }) > rangedWeaponScore({ name: 'crossbow' }), true);
  assert.equal(isRangedAmmo({ name: 'arrow', count: 1 }), true);
  assert.equal(isRangedAmmo({ name: 'spectral_arrow', count: 1 }), true);
  assert.equal(isRangedAmmo({ name: 'tipped_arrow', count: 1 }), true);
  assert.equal(isRangedAmmo({ name: 'arrow', count: 0 }), false);
  assert.equal(hasRangedAmmo([{ name: 'stick' }, { name: 'arrow', count: 2 }]), true);
  assert.deepEqual(
    selectBestRangedWeapon([
      { name: 'crossbow', slot: 4 },
      { name: 'bow', slot: 12 },
      { name: 'bow', slot: 3 },
    ]),
    { name: 'bow', slot: 3 },
  );
});

test('combat policy detects and selects shields deterministically', () => {
  assert.equal(isShield({ name: 'shield' }), true);
  assert.equal(isShield({ name: 'iron_sword' }), false);
  assert.deepEqual(
    selectShield([
      { name: 'shield', slot: 12 },
      { name: 'shield', slot: 4 },
      { name: 'diamond_sword', slot: 1 },
    ]),
    { name: 'shield', slot: 4 },
  );
});

test('combat policy scores equipped armor deterministically', () => {
  assert.equal(armorScore({ name: 'iron_chestplate' }), 6);
  assert.equal(armorScore({ name: 'netherite_boots' }), 3);
  assert.equal(armorScore({ name: 'turtle_helmet' }), 2);
  assert.equal(armorScore({ name: 'shield' }), 0);
  assert.equal(totalArmorScore([{ name: 'diamond_helmet' }, { name: 'diamond_chestplate' }]), 11);
});

test('combat policy estimates melee survival from threat set, armor, and effects', () => {
  const zombie = threat('zombie');
  zombie.threats = [
    threat('zombie', { distance: 5 }),
    threat('zombie', { distance: 7 }),
  ];

  assert.deepEqual(estimateMeleeSurvival({
    threat: zombie,
    health: 20,
    lowHealthFleeThreshold: 8,
    armorItems: [
      { name: 'netherite_helmet' },
      { name: 'netherite_chestplate' },
      { name: 'netherite_leggings' },
      { name: 'netherite_boots' },
    ],
    activeEffects: [{ name: 'resistance', level: 2 }],
  }), {
    threatCount: 2,
    armorScore: 20,
    armorReduction: 0.8,
    resistanceLevel: 2,
    resistanceReduction: 0.4,
    estimatedIncomingDps: 0.8,
    estimatedMaxHitDamage: 0.48,
    estimatedSecondsToLowHealth: 15,
    estimatedSecondsToDeath: 25,
    estimatedHitsToLowHealth: 25,
  });
});

test('combat policy estimates melee offense from weapon and target health', () => {
  assert.deepEqual(estimateMeleeOffense({
    threat: threat('hoglin'),
    weaponItem: { name: 'iron_sword' },
  }), {
    weapon: 'iron_sword',
    target: 'hoglin',
    estimatedTargetHealth: 40,
    estimatedWeaponDamage: 6,
    estimatedAttackIntervalSeconds: 0.63,
    estimatedHitsToKill: 7,
    estimatedSecondsToKill: 4.41,
  });

  assert.equal(estimateMeleeOffense({
    threat: threat('zombie'),
    weaponItem: { name: 'bow' },
  }), null);
});

test('combat policy estimates active strength as real melee kill pressure', () => {
  assert.deepEqual(estimateMeleeOffense({
    threat: threat('zombie'),
    weaponItem: { name: 'iron_sword' },
    activeEffects: [{ name: 'strength', level: 2 }],
  }), {
    weapon: 'iron_sword',
    target: 'zombie',
    estimatedTargetHealth: 20,
    estimatedWeaponDamage: 12,
    estimatedBaseWeaponDamage: 6,
    strengthLevel: 2,
    estimatedStrengthBonusDamage: 6,
    estimatedAttackIntervalSeconds: 0.63,
    estimatedHitsToKill: 2,
    estimatedSecondsToKill: 1.26,
  });
});

test('combat policy estimates regeneration and absorption as defensive survival buffers', () => {
  assert.deepEqual(estimateMeleeSurvival({
    threat: threat('zombie'),
    health: 20,
    lowHealthFleeThreshold: 8,
    armorItems: [IRON_CHESTPLATE],
    activeEffects: [
      { name: 'regeneration', level: 2 },
      { name: 'absorption', level: 1 },
    ],
    weaponItem: { name: 'iron_sword' },
  }), {
    threatCount: 1,
    armorScore: 6,
    armorReduction: 0.24,
    resistanceLevel: 0,
    resistanceReduction: 0,
    regenerationLevel: 2,
    estimatedRegenerationHps: 0.8,
    absorptionLevel: 1,
    estimatedAbsorptionHealth: 4,
    estimatedIncomingDps: 2.53,
    effectiveIncomingDps: 1.73,
    estimatedMaxHitDamage: 3.04,
    estimatedSecondsToLowHealth: 9.23,
    estimatedSecondsToDeath: 13.85,
    estimatedHitsToLowHealth: 5,
    meleeOffense: ZOMBIE_IRON_SWORD_OFFENSE,
  });
});

test('combat policy lets defensive effects improve the melee kill-window gate', () => {
  const decision = chooseCombatResponse({
    threat: threat('hoglin'),
    health: 20,
    heldItem: { name: 'iron_sword' },
    armorItems: [IRON_CHESTPLATE],
    activeEffects: [
      { name: 'regeneration', level: 2 },
      { name: 'absorption', level: 1 },
    ],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    minMeleeSurvivalSecondsToEngage: 3,
    minMeleeKillMarginSecondsToEngage: 1,
  });

  assert.deepEqual(decision, {
    action: 'engage',
    reason: 'armed',
    meleeRisk: {
      threatCount: 1,
      armorScore: 6,
      armorReduction: 0.24,
      resistanceLevel: 0,
      resistanceReduction: 0,
      regenerationLevel: 2,
      estimatedRegenerationHps: 0.8,
      absorptionLevel: 1,
      estimatedAbsorptionHealth: 4,
      estimatedIncomingDps: 3.26,
      effectiveIncomingDps: 2.46,
      estimatedMaxHitDamage: 4.56,
      estimatedSecondsToLowHealth: 6.51,
      estimatedSecondsToDeath: 9.77,
      estimatedHitsToLowHealth: 3,
      meleeOffense: {
        weapon: 'iron_sword',
        target: 'hoglin',
        estimatedTargetHealth: 40,
        estimatedWeaponDamage: 6,
        estimatedAttackIntervalSeconds: 0.63,
        estimatedHitsToKill: 7,
        estimatedSecondsToKill: 4.41,
      },
    },
  });
});

test('combat policy flees from creepers even when armed', () => {
  const decision = chooseCombatResponse({
    threat: threat('creeper'),
    health: 20,
    heldItem: { name: 'netherite_sword' },
    engageOverFlee: true,
  });

  assert.deepEqual(decision, { action: 'flee', reason: 'creeper-anti-explosion' });
});

test('combat policy can prep ranged weapon for creepers without enabling melee or firing', () => {
  const bow = { name: 'bow', slot: 7 };
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('creeper'),
      health: 20,
      heldItem: { name: 'netherite_sword' },
      inventoryItems: [bow, { name: 'arrow', count: 12, slot: 8 }],
      engageOverFlee: true,
      rangedCombatPrepEnabled: true,
    }),
    { action: 'equip_ranged_weapon', reason: 'creeper-ranged-weapon-available', item: bow },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('creeper'),
      health: 20,
      heldItem: { name: 'bow' },
      inventoryItems: [{ name: 'arrow', count: 12, slot: 8 }],
      engageOverFlee: true,
      rangedCombatPrepEnabled: true,
    }),
    { action: 'flee', reason: 'creeper-ranged-ready-no-fire-policy' },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('creeper'),
      health: 20,
      heldItem: { name: 'netherite_sword' },
      inventoryItems: [bow],
      engageOverFlee: true,
      rangedCombatPrepEnabled: true,
    }),
    { action: 'flee', reason: 'creeper-anti-explosion' },
  );
});

test('combat policy only fires ranged weapons when explicit safe gates pass', () => {
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('creeper', { distance: 10 }),
      health: 20,
      heldItem: { name: 'bow' },
      inventoryItems: [{ name: 'arrow', count: 12, slot: 8 }],
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatLineOfSight: true,
      rangedCombatFireMinDistance: 7,
      rangedCombatFireMaxDistance: 16,
    }),
    { action: 'fire_ranged_weapon', reason: 'creeper-ranged-fire-safe', item: { name: 'bow' } },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('creeper', { distance: 4 }),
      health: 20,
      heldItem: { name: 'bow' },
      inventoryItems: [{ name: 'arrow', count: 12, slot: 8 }],
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatLineOfSight: true,
      rangedCombatFireMinDistance: 7,
      rangedCombatFireMaxDistance: 16,
    }),
    { action: 'flee', reason: 'ranged-fire-too-close' },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('skeleton', { distance: 10 }),
      health: 20,
      heldItem: { name: 'bow' },
      inventoryItems: [{ name: 'arrow', count: 12, slot: 8 }],
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatLineOfSight: false,
    }),
    { action: 'flee', reason: 'ranged-fire-line-of-sight-blocked' },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('skeleton', { distance: 10 }),
      health: 8,
      heldItem: { name: 'bow' },
      inventoryItems: [{ name: 'arrow', count: 12, slot: 8 }],
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatLineOfSight: true,
      lowHealthFleeThreshold: 8,
    }),
    { action: 'flee', reason: 'low-health' },
  );
});

test('combat policy binds mixed-threat ranged fire to the unsafe target', () => {
  const zombie = threat('zombie', { id: 1, distance: 5 });
  const creeper = threat('creeper', { id: 2, distance: 10 });
  zombie.threats = [zombie, creeper];
  const lineOfSightChecks = [];

  const decision = chooseCombatResponse({
    threat: zombie,
    health: 20,
    heldItem: { name: 'bow' },
    inventoryItems: [{ name: 'arrow', count: 12, slot: 8 }],
    armorItems: [{ name: 'netherite_chestplate' }],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    maxMeleeEngageThreatCount: 2,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatLineOfSight(entry) {
      lineOfSightChecks.push(entry.entity.name);
      return entry.entity.name === 'creeper';
    },
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
  });

  assert.equal(decision.action, 'fire_ranged_weapon');
  assert.equal(decision.reason, 'creeper-ranged-fire-safe');
  assert.equal(decision.unsafeThreat, 'creeper');
  assert.equal(decision.targetThreat.entity.name, 'creeper');
  assert.equal(decision.targetThreat.distance, 10);
  assert.deepEqual(lineOfSightChecks, ['creeper']);
});

test('combat policy does not reuse nearest-hostile line of sight for mixed unsafe targets', () => {
  const zombie = threat('zombie', { id: 1, distance: 5 });
  const creeper = threat('creeper', { id: 2, distance: 10 });
  zombie.threats = [zombie, creeper];

  const decision = chooseCombatResponse({
    threat: zombie,
    health: 20,
    heldItem: { name: 'bow' },
    inventoryItems: [{ name: 'arrow', count: 12, slot: 8 }],
    armorItems: [{ name: 'netherite_chestplate' }],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    maxMeleeEngageThreatCount: 2,
    rangedCombatPrepEnabled: true,
    rangedCombatFireEnabled: true,
    rangedCombatLineOfSight(entry) {
      return entry.entity.name === 'zombie';
    },
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
  });

  assert.equal(decision.action, 'flee');
  assert.equal(decision.reason, 'ranged-fire-line-of-sight-blocked');
  assert.equal(decision.unsafeThreat, 'creeper');
  assert.equal(decision.targetThreat.entity.name, 'creeper');
});

test('combat policy equips a weapon before engaging', () => {
  const sword = { name: 'iron_sword', slot: 5 };
  const decision = chooseCombatResponse({
    threat: threat('zombie'),
    health: 20,
    heldItem: null,
    inventoryItems: [sword],
    armorItems: [IRON_CHESTPLATE],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
  });

  assert.deepEqual(decision, {
    action: 'equip_weapon',
    reason: 'weapon-available',
    item: sword,
    meleeRisk: {
      threatCount: 1,
      armorScore: 6,
      armorReduction: 0.24,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 2.53,
      estimatedMaxHitDamage: 3.04,
      estimatedSecondsToLowHealth: 4.74,
      estimatedSecondsToDeath: 7.89,
      estimatedHitsToLowHealth: 3,
      meleeOffense: ZOMBIE_IRON_SWORD_OFFENSE,
    },
  });
});

test('combat policy engages only when healthy, armored, armed, and enabled', () => {
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('zombie'),
      health: 20,
      heldItem: { name: 'iron_sword' },
      inventoryItems: [{ name: 'stone_sword', slot: 2 }],
      armorItems: [IRON_CHESTPLATE],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
    }),
    {
      action: 'engage',
      reason: 'armed',
      meleeRisk: {
        threatCount: 1,
        armorScore: 6,
        armorReduction: 0.24,
        resistanceLevel: 0,
        resistanceReduction: 0,
        estimatedIncomingDps: 2.53,
        estimatedMaxHitDamage: 3.04,
        estimatedSecondsToLowHealth: 4.74,
        estimatedSecondsToDeath: 7.89,
        estimatedHitsToLowHealth: 3,
        meleeOffense: ZOMBIE_IRON_SWORD_OFFENSE,
      },
    },
  );
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('zombie'),
      health: 8,
      heldItem: { name: 'iron_sword' },
      armorItems: [IRON_CHESTPLATE],
      engageOverFlee: true,
      lowHealthFleeThreshold: 8,
      minArmorScoreToEngage: 6,
    }),
    { action: 'flee', reason: 'low-health' },
  );
});

test('combat policy flees instead of engaging when armor is below threshold', () => {
  const decision = chooseCombatResponse({
    threat: threat('zombie'),
    health: 20,
    heldItem: { name: 'diamond_sword' },
    armorItems: [{ name: 'leather_boots' }],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
  });

  assert.deepEqual(decision, {
    action: 'flee',
    reason: 'insufficient-armor',
    armorScore: 1,
    requiredArmorScore: 6,
    meleeRisk: {
      threatCount: 1,
      armorScore: 1,
      armorReduction: 0.04,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 3.2,
      estimatedMaxHitDamage: 3.84,
      estimatedSecondsToLowHealth: 3.75,
      estimatedSecondsToDeath: 6.25,
      estimatedHitsToLowHealth: 3,
      meleeOffense: ZOMBIE_DIAMOND_SWORD_OFFENSE,
    },
  });
});

test('combat policy refuses melee engagement against hostile groups by default', () => {
  const zombie = threat('zombie');
  zombie.threats = [
    threat('zombie', { distance: 5 }),
    threat('zombie', { distance: 7 }),
  ];

  const decision = chooseCombatResponse({
    threat: zombie,
    health: 20,
    heldItem: { name: 'netherite_sword' },
    armorItems: [
      { name: 'netherite_helmet' },
      { name: 'netherite_chestplate' },
      { name: 'netherite_leggings' },
      { name: 'netherite_boots' },
    ],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
  });

  assert.deepEqual(decision, {
    action: 'flee',
    reason: 'too-many-hostiles',
    threatCount: 2,
    maxMeleeEngageThreatCount: 1,
    meleeRisk: {
      threatCount: 2,
      armorScore: 20,
      armorReduction: 0.8,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 1.33,
      estimatedMaxHitDamage: 0.8,
      estimatedSecondsToLowHealth: 9,
      estimatedSecondsToDeath: 15,
      estimatedHitsToLowHealth: 15,
      meleeOffense: {
        ...ZOMBIE_NETHERITE_SWORD_OFFENSE,
        estimatedThreatsToClear: 2,
        estimatedHitsToClearThreats: 6,
        estimatedSecondsToClearThreats: 3.78,
      },
    },
  });
});

test('combat policy refuses melee engagement when estimated survival margin is too low', () => {
  const decision = chooseCombatResponse({
    threat: threat('zombie'),
    health: 10,
    heldItem: { name: 'iron_sword' },
    armorItems: [IRON_CHESTPLATE],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    minMeleeSurvivalSecondsToEngage: 3,
  });

  assert.deepEqual(decision, {
    action: 'flee',
    reason: 'melee-survival-margin-too-low',
    minMeleeSurvivalSecondsToEngage: 3,
    meleeRisk: {
      threatCount: 1,
      armorScore: 6,
      armorReduction: 0.24,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 2.53,
      estimatedMaxHitDamage: 3.04,
      estimatedSecondsToLowHealth: 0.79,
      estimatedSecondsToDeath: 3.95,
      estimatedHitsToLowHealth: 0,
      meleeOffense: ZOMBIE_IRON_SWORD_OFFENSE,
    },
  });
});

test('combat policy refuses melee when estimated kill window outruns survival margin', () => {
  const decision = chooseCombatResponse({
    threat: threat('hoglin'),
    health: 20,
    heldItem: { name: 'iron_sword' },
    armorItems: [IRON_CHESTPLATE],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    minMeleeSurvivalSecondsToEngage: 3,
    minMeleeKillMarginSecondsToEngage: 1,
  });

  assert.deepEqual(decision, {
    action: 'flee',
    reason: 'melee-kill-window-too-risky',
    minMeleeKillMarginSecondsToEngage: 1,
    meleeRisk: {
      threatCount: 1,
      armorScore: 6,
      armorReduction: 0.24,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 3.26,
      estimatedMaxHitDamage: 4.56,
      estimatedSecondsToLowHealth: 3.68,
      estimatedSecondsToDeath: 6.14,
      estimatedHitsToLowHealth: 2,
      meleeOffense: {
        weapon: 'iron_sword',
        target: 'hoglin',
        estimatedTargetHealth: 40,
        estimatedWeaponDamage: 6,
        estimatedAttackIntervalSeconds: 0.63,
        estimatedHitsToKill: 7,
        estimatedSecondsToKill: 4.41,
      },
    },
  });
});

test('combat policy lets active strength improve the melee kill-window gate', () => {
  const decision = chooseCombatResponse({
    threat: threat('hoglin'),
    health: 20,
    heldItem: { name: 'iron_sword' },
    armorItems: [IRON_CHESTPLATE],
    activeEffects: [{ name: 'strength', level: 2 }],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    minMeleeSurvivalSecondsToEngage: 3,
    minMeleeKillMarginSecondsToEngage: 1,
  });

  assert.deepEqual(decision, {
    action: 'engage',
    reason: 'armed',
    meleeRisk: {
      threatCount: 1,
      armorScore: 6,
      armorReduction: 0.24,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 3.26,
      estimatedMaxHitDamage: 4.56,
      estimatedSecondsToLowHealth: 3.68,
      estimatedSecondsToDeath: 6.14,
      estimatedHitsToLowHealth: 2,
      meleeOffense: {
        weapon: 'iron_sword',
        target: 'hoglin',
        estimatedTargetHealth: 40,
        estimatedWeaponDamage: 12,
        estimatedBaseWeaponDamage: 6,
        strengthLevel: 2,
        estimatedStrengthBonusDamage: 6,
        estimatedAttackIntervalSeconds: 0.63,
        estimatedHitsToKill: 4,
        estimatedSecondsToKill: 2.52,
      },
    },
  });
});

test('combat policy uses observed recent damage when it is worse than static threat estimate', () => {
  const decision = chooseCombatResponse({
    threat: threat('zombie'),
    health: 20,
    heldItem: { name: 'iron_sword' },
    armorItems: [IRON_CHESTPLATE],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    minMeleeSurvivalSecondsToEngage: 3,
    recentDamage: {
      totalDamage: 10,
      recentDamagePerSecond: 10,
      windowMs: 1000,
      lastDamageMsAgo: 100,
    },
  });

  assert.deepEqual(decision, {
    action: 'flee',
    reason: 'melee-survival-margin-too-low',
    minMeleeSurvivalSecondsToEngage: 3,
    meleeRisk: {
      threatCount: 1,
      armorScore: 6,
      armorReduction: 0.24,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 2.53,
      observedRecentDamageDps: 10,
      effectiveIncomingDps: 10,
      recentDamageTotal: 10,
      recentDamageWindowMs: 1000,
      lastDamageMsAgo: 100,
      estimatedMaxHitDamage: 3.04,
      estimatedSecondsToLowHealth: 1.2,
      estimatedSecondsToDeath: 2,
      estimatedHitsToLowHealth: 3,
      meleeOffense: ZOMBIE_IRON_SWORD_OFFENSE,
    },
  });
});

test('combat policy uses group clear time for multi-hostile kill-window gates', () => {
  const zombie = threat('zombie');
  zombie.threats = [
    threat('zombie', { distance: 4 }),
    threat('zombie', { distance: 5 }),
    threat('zombie', { distance: 6 }),
  ];

  const decision = chooseCombatResponse({
    threat: zombie,
    health: 20,
    heldItem: { name: 'netherite_sword' },
    armorItems: [
      { name: 'netherite_helmet' },
      { name: 'netherite_chestplate' },
      { name: 'netherite_leggings' },
      { name: 'netherite_boots' },
    ],
    engageOverFlee: true,
    minArmorScoreToEngage: 6,
    maxMeleeEngageThreatCount: 3,
    minMeleeSurvivalSecondsToEngage: 3,
    minMeleeKillMarginSecondsToEngage: 1,
  });

  assert.deepEqual(decision, {
    action: 'flee',
    reason: 'melee-kill-window-too-risky',
    minMeleeKillMarginSecondsToEngage: 1,
    meleeRisk: {
      threatCount: 3,
      armorScore: 20,
      armorReduction: 0.8,
      resistanceLevel: 0,
      resistanceReduction: 0,
      estimatedIncomingDps: 2,
      estimatedMaxHitDamage: 0.8,
      estimatedSecondsToLowHealth: 6,
      estimatedSecondsToDeath: 10,
      estimatedHitsToLowHealth: 15,
      meleeOffense: {
        ...ZOMBIE_NETHERITE_SWORD_OFFENSE,
        estimatedThreatsToClear: 3,
        estimatedHitsToClearThreats: 9,
        estimatedSecondsToClearThreats: 5.67,
      },
    },
  });
});

test('combat policy can explicitly allow larger melee threat budgets', () => {
  const zombie = threat('zombie');
  zombie.threats = [
    threat('zombie', { distance: 5 }),
    threat('zombie', { distance: 7 }),
  ];

  assert.deepEqual(
    chooseCombatResponse({
      threat: zombie,
      health: 20,
      heldItem: { name: 'netherite_sword' },
      armorItems: [
        { name: 'netherite_helmet' },
        { name: 'netherite_chestplate' },
        { name: 'netherite_leggings' },
        { name: 'netherite_boots' },
      ],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      maxMeleeEngageThreatCount: 2,
    }),
    {
      action: 'engage',
      reason: 'armed',
      meleeRisk: {
        threatCount: 2,
        armorScore: 20,
        armorReduction: 0.8,
        resistanceLevel: 0,
        resistanceReduction: 0,
        estimatedIncomingDps: 1.33,
        estimatedMaxHitDamage: 0.8,
        estimatedSecondsToLowHealth: 9,
        estimatedSecondsToDeath: 15,
        estimatedHitsToLowHealth: 15,
        meleeOffense: {
          ...ZOMBIE_NETHERITE_SWORD_OFFENSE,
          estimatedThreatsToClear: 2,
          estimatedHitsToClearThreats: 6,
          estimatedSecondsToClearThreats: 3.78,
        },
      },
    },
  );
});

test('combat policy vetoes mixed unsafe threat sets before group melee engagement', () => {
  const zombieWithCreeper = threat('zombie');
  zombieWithCreeper.threats = [
    threat('zombie', { distance: 4 }),
    threat('creeper', { distance: 6 }),
  ];

  assert.deepEqual(
    chooseCombatResponse({
      threat: zombieWithCreeper,
      health: 20,
      heldItem: { name: 'netherite_sword' },
      armorItems: [
        { name: 'netherite_helmet' },
        { name: 'netherite_chestplate' },
        { name: 'netherite_leggings' },
        { name: 'netherite_boots' },
      ],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      maxMeleeEngageThreatCount: 2,
    }),
    { action: 'flee', reason: 'creeper-anti-explosion', threatCount: 2, unsafeThreat: 'creeper' },
  );

  const zombieWithSkeleton = threat('zombie');
  zombieWithSkeleton.threats = [
    threat('zombie', { distance: 5 }),
    threat('skeleton', { distance: 9 }),
  ];
  const skeletonThreat = zombieWithSkeleton.threats[1];
  const bow = { name: 'bow', slot: 7 };

  assert.deepEqual(
    chooseCombatResponse({
      threat: zombieWithSkeleton,
      health: 20,
      heldItem: { name: 'netherite_sword' },
      inventoryItems: [bow, { name: 'arrow', count: 12, slot: 8 }],
      armorItems: [
        { name: 'netherite_helmet' },
        { name: 'netherite_chestplate' },
        { name: 'netherite_leggings' },
        { name: 'netherite_boots' },
      ],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      maxMeleeEngageThreatCount: 2,
      rangedCombatPrepEnabled: true,
    }),
    {
      action: 'equip_ranged_weapon',
      reason: 'ranged-weapon-available',
      item: bow,
      threatCount: 2,
      unsafeThreat: 'skeleton',
      targetThreat: skeletonThreat,
    },
  );
});

test('combat policy refuses ranged actions while another hostile is in close pressure range', () => {
  const mixed = threat('zombie');
  mixed.threats = [
    threat('zombie', { id: 1, distance: 2.5 }),
    threat('creeper', { id: 2, distance: 10 }),
  ];
  const creeperThreat = mixed.threats[1];

  assert.deepEqual(
    chooseCombatResponse({
      threat: mixed,
      health: 20,
      heldItem: { name: 'bow' },
      inventoryItems: [{ name: 'bow', slot: 4 }, { name: 'arrow', count: 12, slot: 8 }],
      engageOverFlee: true,
      maxMeleeEngageThreatCount: 2,
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatLineOfSight: true,
      rangedCombatFireMinDistance: 7,
      rangedCombatFireMaxDistance: 16,
    }),
    {
      action: 'flee',
      reason: 'close-hostile-pressure-before-ranged',
      threatCount: 2,
      unsafeThreat: 'zombie',
      closeThreatDistance: 2.5,
      targetThreat: creeperThreat,
    },
  );
});

test('combat policy can require a shield before melee engagement', () => {
  const shield = { name: 'shield', slot: 8 };
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('zombie'),
      health: 20,
      heldItem: { name: 'iron_sword' },
      offHandItem: null,
      inventoryItems: [shield],
      armorItems: [IRON_CHESTPLATE],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      requireShieldToEngage: true,
    }),
    { action: 'equip_shield', reason: 'shield-available', item: shield },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('zombie'),
      health: 20,
      heldItem: { name: 'iron_sword' },
      offHandItem: null,
      inventoryItems: [],
      armorItems: [IRON_CHESTPLATE],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      requireShieldToEngage: true,
    }),
    { action: 'flee', reason: 'shield-required' },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('zombie'),
      health: 20,
      heldItem: { name: 'iron_sword' },
      offHandItem: { name: 'shield' },
      inventoryItems: [],
      armorItems: [IRON_CHESTPLATE],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      requireShieldToEngage: true,
    }),
    {
      action: 'engage',
      reason: 'armed',
      meleeRisk: {
        threatCount: 1,
        armorScore: 6,
        armorReduction: 0.24,
        resistanceLevel: 0,
        resistanceReduction: 0,
        estimatedIncomingDps: 2.53,
        estimatedMaxHitDamage: 3.04,
        estimatedSecondsToLowHealth: 4.74,
        estimatedSecondsToDeath: 7.89,
        estimatedHitsToLowHealth: 3,
        meleeOffense: ZOMBIE_IRON_SWORD_OFFENSE,
      },
    },
  );
});

test('combat policy chooses active shield blocking for close defensive threats', () => {
  assert.deepEqual(
    chooseShieldBlockResponse({
      threat: threat('creeper', { distance: 3 }),
      combatAction: 'flee',
      offHandItem: { name: 'shield' },
      enabled: true,
    }),
    { action: 'activate_shield', reason: 'creeper-shield-block' },
  );

  assert.deepEqual(
    chooseShieldBlockResponse({
      threat: threat('skeleton', { distance: 3 }),
      combatAction: 'flee',
      offHandItem: { name: 'shield' },
      enabled: true,
      shieldActive: true,
    }),
    { action: 'hold_shield', reason: 'ranged-shield-block' },
  );
});

test('combat policy applies shield-block hysteresis and release decisions', () => {
  assert.deepEqual(
    chooseShieldBlockResponse({
      threat: threat('zombie', { distance: 4 }),
      combatAction: 'engage',
      offHandItem: { name: 'shield' },
      enabled: true,
    }),
    { action: 'activate_shield', reason: 'melee-shield-block' },
  );

  assert.deepEqual(
    chooseShieldBlockResponse({
      threat: threat('zombie', { distance: 6 }),
      combatAction: 'engage',
      offHandItem: { name: 'shield' },
      enabled: true,
      shieldActive: true,
      blockDistance: 4.5,
      releaseDistance: 7,
    }),
    { action: 'hold_shield', reason: 'shield-block-hysteresis' },
  );

  assert.deepEqual(
    chooseShieldBlockResponse({
      threat: threat('zombie', { distance: 9 }),
      combatAction: 'engage',
      offHandItem: { name: 'shield' },
      enabled: true,
      shieldActive: true,
      blockDistance: 4.5,
      releaseDistance: 7,
    }),
    { action: 'release_shield', reason: 'threat-outside-shield-range' },
  );
});

test('combat policy does not shield-block player threats or missing shields', () => {
  assert.deepEqual(
    chooseShieldBlockResponse({
      threat: threat('player', { type: 'player', username: 'Steve', distance: 2 }),
      combatAction: 'flee',
      offHandItem: { name: 'shield' },
      enabled: true,
    }),
    { action: 'none', reason: 'player-threat-no-pvp-policy' },
  );

  assert.deepEqual(
    chooseShieldBlockResponse({
      threat: threat('creeper', { distance: 2 }),
      combatAction: 'flee',
      offHandItem: null,
      enabled: true,
      shieldActive: true,
    }),
    { action: 'release_shield', reason: 'shield-missing' },
  );
});

test('combat policy refuses melee engagement for ranged or special hostiles', () => {
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('skeleton'),
      health: 20,
      heldItem: { name: 'netherite_sword' },
      armorItems: [{ name: 'netherite_chestplate' }],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
    }),
    { action: 'flee', reason: 'ranged-threat-no-melee-policy' },
  );
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('witch'),
      health: 20,
      heldItem: { name: 'netherite_sword' },
      armorItems: [{ name: 'netherite_chestplate' }],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
    }),
    { action: 'flee', reason: 'special-threat-no-melee-policy' },
  );
});

test('combat policy can prep ranged weapon for ranged hostiles', () => {
  const bow = { name: 'bow', slot: 7 };
  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('skeleton'),
      health: 20,
      heldItem: { name: 'netherite_sword' },
      inventoryItems: [bow, { name: 'arrow', count: 12, slot: 8 }],
      armorItems: [{ name: 'netherite_chestplate' }],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      rangedCombatPrepEnabled: true,
    }),
    { action: 'equip_ranged_weapon', reason: 'ranged-weapon-available', item: bow },
  );

  assert.deepEqual(
    chooseCombatResponse({
      threat: threat('bogged'),
      health: 20,
      heldItem: { name: 'netherite_sword' },
      inventoryItems: [],
      armorItems: [{ name: 'netherite_chestplate' }],
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      rangedCombatPrepEnabled: true,
    }),
    { action: 'flee', reason: 'ranged-threat-no-melee-policy' },
  );
});

test('combat policy does not PvP players without an explicit player policy', () => {
  const decision = chooseCombatResponse({
    threat: threat('player', { type: 'player', username: 'Steve' }),
    health: 20,
    heldItem: { name: 'netherite_sword' },
    engageOverFlee: true,
  });

  assert.deepEqual(decision, { action: 'flee', reason: 'player-threat-no-pvp-policy' });
});
