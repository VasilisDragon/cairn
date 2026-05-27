import test from 'node:test';
import assert from 'node:assert/strict';
import mcDataLoader from 'minecraft-data';

import buildSnapshot from '../../src/state/snapshot.js';
import { run as runObserve } from '../../src/skills/observe.js';

const registry = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return {
    x,
    y,
    z,
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z); },
  };
}

function makeBot(overrides = {}) {
  return {
    entity: {
      position: pos(0, 64, 0),
      onGround: false,
      velocity: { y: -0.42 },
      isInWater: true,
    },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 12,
    food: 15,
    foodSaturation: 2,
    oxygenLevel: 12,
    usingHeldItem: true,
    autoEat: { isEating: true },
    entities: {
      zombie: { id: 1, name: 'zombie', position: pos(3, 64, 0) },
    },
    inventory: {
      items: () => [{ name: 'oak_log', count: 3 }],
    },
    pathfinderOwner: {
      currentOwner: () => 'reactive',
      isIdle: () => false,
    },
    reactiveController: { state: 'HAZARD' },
    skillExecutor: {
      currentCall: { skill: 'collect', params: { block: 'oak_log', count: 2 } },
      queue: [
        { skill: 'collect', params: { block: 'oak_log', count: 2 } },
        { skill: 'deposit', params: { items: [{ name: 'oak_log' }] } },
      ],
    },
    ...overrides,
  };
}

test('snapshot includes reactive executor and hazard context', () => {
  const snapshot = buildSnapshot(makeBot(), {
    currentSubtask: 'collect({"block":"oak_log"})',
    remainingQueue: [{ skill: 'deposit', params: {} }],
  });

  assert.equal(snapshot.reactiveState, 'HAZARD');
  assert.deepEqual(snapshot.currentSkill, { skill: 'collect', params: { block: 'oak_log', count: 2 } });
  assert.equal(snapshot.currentSubtask, 'collect({"block":"oak_log"})');
  assert.equal(snapshot.queueLength, 2);
  assert.deepEqual(snapshot.pathfinder, { owner: 'reactive', idle: false });
  assert.equal(snapshot.nearbyHostiles.length, 1);
  assert.equal(snapshot.nearbyHostiles[0].name, 'zombie');
  assert.deepEqual(snapshot.consumablePolicy, { action: 'none', reason: 'no-consumable-needed' });
  assert.deepEqual(snapshot.hazardFlags, {
    inWater: true,
    oxygenLevel: 12,
    oxygenLow: true,
    onGround: false,
    falling: true,
    velocityY: -0.42,
    usingHeldItem: true,
    autoEatEating: true,
  });
});

test('snapshot does not report low oxygen on dry land when Mineflayer exposes zero oxygen', () => {
  const snapshot = buildSnapshot(makeBot({
    entity: {
      position: pos(0, 64, 0),
      onGround: true,
      velocity: { y: 0 },
      isInWater: false,
    },
    oxygenLevel: 0,
    reactiveController: { state: 'NORMAL' },
  }));

  assert.equal(snapshot.hazardFlags.inWater, false);
  assert.equal(snapshot.hazardFlags.oxygenLevel, 0);
  assert.equal(snapshot.hazardFlags.oxygenLow, false);
});

test('snapshot includes compact recent execution events for advisor planning', () => {
  const longReason = 'x'.repeat(200);
  const snapshot = buildSnapshot(makeBot({ skillExecutor: null }), {
    recentEventsCap: 2,
    recentEvents: [
      { seq: 1, event: 'skill.start', skill: 'collect', params: { block: 'oak_log' }, queueLeft: 2 },
      { seq: 2, type: 'skill.result', skill: 'collect', ok: false, reason: longReason, dtMs: 12.7, state: { raw: true } },
      { seq: 3, evt: 'queue.failure', skill: 'collect', reason: 'no drops', dropped: 1 },
    ],
  });

  assert.deepEqual(snapshot.recentEvents, [
    {
      event: 'skill.result',
      seq: 2,
      skill: 'collect',
      reason: `${'x'.repeat(157)}...`,
      dtMs: 13,
      ok: false,
    },
    {
      event: 'queue.failure',
      seq: 3,
      skill: 'collect',
      reason: 'no drops',
      dropped: 1,
    },
  ]);
  assert.equal('params' in snapshot.recentEvents[0], false);
  assert.equal('state' in snapshot.recentEvents[0], false);
});

test('snapshot includes compact task timing budget for long-running work', () => {
  const snapshot = buildSnapshot(makeBot({ skillExecutor: null }), {
    nowMs: 4500,
    taskBudget: {
      label: 'mining_soak',
      phase: 'mine',
      startedAtMs: 1000,
      durationMs: 10000,
      returnReserveMs: 2500,
      attempts: 2,
    },
  });

  assert.deepEqual(snapshot.taskBudget, {
    label: 'mining_soak',
    phase: 'mine',
    attempts: 2,
    elapsedMs: 3500,
    durationMs: 10000,
    deadlineRemainingMs: 6500,
    overdue: false,
    returnReserveMs: 2500,
    returnByRemainingMs: 4000,
    returnDue: false,
  });
});

test('snapshot can include compact mining progression for advisor planning when requested', () => {
  const snapshot = buildSnapshot(makeBot({
    registry,
    inventory: {
      items: () => [
        { name: 'stone_pickaxe', count: 1 },
        { name: 'cooked_beef', count: 32 },
      ],
    },
  }), {
    miningProgressionTargets: ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'],
  });

  assert.deepEqual(snapshot.miningProgression.targets.harvestable, ['coal_ore', 'iron_ore']);
  assert.deepEqual(snapshot.miningProgression.targets.blocked, [
    {
      block: 'gold_ore',
      missingTools: ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
    },
    {
      block: 'diamond_ore',
      missingTools: ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
    },
  ]);
  assert.deepEqual(snapshot.miningProgression.requiredTools, ['iron_pickaxe']);
  assert.deepEqual(snapshot.miningProgression.steps.map((step) => `${step.action}:${step.item || step.input}`), [
    'mine:raw_iron',
    'mine:coal',
    'carry_or_collect:wood_log',
    'carry_or_collect:wood_log',
    'craft:oak_planks',
    'craft:crafting_table',
    'place_workstation:crafting_table',
    'collect:cobblestone',
    'craft:furnace',
    'place_workstation:furnace',
    'smelt:raw_iron',
    'craft:stick',
    'craft:iron_pickaxe',
  ]);
  assert.deepEqual(snapshot.miningProgression.optional[0], {
    item: 'iron_sword',
    ready: false,
    reason: 'skip optional iron_sword; missing materials',
    missing: { fuel_ticks: 400, raw_iron: 2 },
  });
});

test('snapshot derives task timing from executor current call state', () => {
  const snapshot = buildSnapshot(makeBot({
    skillExecutor: {
      currentCall: {
        skill: 'collect',
        params: { block: 'diamond_ore', count: 1 },
        _state: {
          _executor: {
            startedAtMs: 1000,
            deadlineAtMs: 5000,
            returnByMs: 4000,
            returnReserveMs: 1000,
            attempts: 3,
          },
        },
      },
      queue: [{ skill: 'collect', params: { block: 'diamond_ore', count: 1 } }],
    },
  }), {
    nowMs: 4500,
  });

  assert.deepEqual(snapshot.taskBudget, {
    attempts: 3,
    elapsedMs: 3500,
    deadlineRemainingMs: 500,
    overdue: false,
    returnReserveMs: 1000,
    returnByRemainingMs: -500,
    returnDue: true,
  });
});

test('snapshot reports unavailable task timing without throwing', () => {
  const snapshot = buildSnapshot(makeBot({
    skillExecutor: {
      currentCall: {
        skill: 'collect',
        params: { block: 'oak_log', count: 1 },
        get _state() {
          throw new Error('task state unavailable');
        },
      },
      queue: [],
    },
  }));

  assert.deepEqual(snapshot.taskBudgetStatus, {
    ok: false,
    reason: 'task budget unavailable: task state unavailable',
  });
});

test('snapshot reports unavailable recent event context without throwing', () => {
  const snapshot = buildSnapshot(makeBot({
    skillExecutor: {
      currentCall: null,
      queue: [],
      recentEvents() {
        throw new Error('event buffer unavailable');
      },
    },
  }));

  assert.deepEqual(snapshot.recentEventsStatus, {
    ok: false,
    reason: 'recent events unavailable: event buffer unavailable',
  });
});

test('snapshot includes compact consumable recommendations for advisor planning', () => {
  const steak = { name: 'cooked_beef', count: 2, slot: 12 };
  const snapshot = buildSnapshot(makeBot({
    food: 11,
    inventory: {
      items: () => [steak],
    },
  }));

  assert.deepEqual(snapshot.consumablePolicy, {
    action: 'eat',
    reason: 'low-food',
    item: { name: 'cooked_beef', count: 2, slot: 12 },
  });
});

test('snapshot consumable recommendation can use combat risk context', () => {
  const sword = { name: 'iron_sword', count: 1 };
  const chestplate = { name: 'iron_chestplate', count: 1 };
  const regeneration = {
    name: 'potion',
    count: 1,
    slot: 7,
    potionType: 'minecraft:strong_regeneration',
  };
  const base = makeBot();
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: sword,
    entity: {
      ...base.entity,
      equipment: [sword, null, null, null, chestplate, null],
    },
    entities: {
      hoglin: { id: 1, name: 'hoglin', position: pos(3, 64, 0) },
    },
    inventory: {
      items: () => [regeneration],
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
    },
    consumablePolicyOptions: {
      intent: 'hostile_combat',
      allowPotions: true,
    },
  });

  assert.deepEqual(snapshot.consumablePolicy, {
    action: 'drink_potion',
    reason: 'combat-risk-regeneration',
    item: { name: 'potion', count: 1, slot: 7 },
    effect: 'regeneration',
    level: 2,
  });
});

test('snapshot includes compact equipment and combat policy recommendations', () => {
  const sword = { name: 'iron_sword', count: 1, slot: 12 };
  const shield = { name: 'shield', count: 1 };
  const chestplate = { name: 'iron_chestplate', count: 1 };
  const base = makeBot();
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: null,
    entity: {
      ...base.entity,
      equipment: [null, shield, null, null, chestplate, null],
    },
    inventory: {
      items: () => [sword],
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      requireShieldToEngage: true,
    },
  });

  assert.deepEqual(snapshot.equipment, {
    hand: null,
    offHand: { name: 'shield', count: 1 },
    feet: null,
    legs: null,
    torso: { name: 'iron_chestplate', count: 1 },
    head: null,
    armorScore: 6,
  });
  assert.deepEqual(snapshot.combatPolicy, {
    action: 'equip_weapon',
    reason: 'weapon-available',
    threat: { name: 'zombie', distance: 3 },
    armorScore: 6,
    item: { name: 'iron_sword', count: 1, slot: 12 },
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
      meleeOffense: {
        weapon: 'iron_sword',
        target: 'zombie',
        estimatedTargetHealth: 20,
        estimatedWeaponDamage: 6,
        estimatedAttackIntervalSeconds: 0.63,
        estimatedHitsToKill: 4,
        estimatedSecondsToKill: 2.52,
      },
    },
    shield: { action: 'none', reason: 'shield-block-disabled' },
  });
});

test('snapshot combat policy reports engage and shield-block recommendation when gates pass', () => {
  const shield = { name: 'shield', count: 1 };
  const sword = { name: 'iron_sword', count: 1 };
  const chestplate = { name: 'iron_chestplate', count: 1 };
  const base = makeBot();
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: sword,
    entity: {
      ...base.entity,
      equipment: [sword, shield, null, null, chestplate, null],
    },
    inventory: {
      items: () => [],
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      requireShieldToEngage: true,
      shieldBlockingEnabled: true,
    },
  });

  assert.deepEqual(snapshot.combatPolicy, {
    action: 'engage',
    reason: 'armed',
    threat: { name: 'zombie', distance: 3 },
    armorScore: 6,
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
      meleeOffense: {
        weapon: 'iron_sword',
        target: 'zombie',
        estimatedTargetHealth: 20,
        estimatedWeaponDamage: 6,
        estimatedAttackIntervalSeconds: 0.63,
        estimatedHitsToKill: 4,
        estimatedSecondsToKill: 2.52,
      },
    },
    shield: { action: 'activate_shield', reason: 'melee-shield-block' },
  });
});

test('snapshot combat policy reflects active strength in melee offense', () => {
  const sword = { name: 'iron_sword', count: 1 };
  const chestplate = { name: 'iron_chestplate', count: 1 };
  const base = makeBot();
  const snapshot = buildSnapshot(makeBot({
    registry: {
      effectsArray: [{ id: 4, displayName: 'Strength' }],
    },
    health: 20,
    heldItem: sword,
    entity: {
      ...base.entity,
      equipment: [sword, null, null, null, chestplate, null],
      effects: {
        4: { amplifier: 1, duration: 600 },
      },
    },
    inventory: {
      items: () => [],
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
    },
  });

  assert.equal(snapshot.combatPolicy.action, 'engage');
  assert.deepEqual(snapshot.activeEffects, [
    { name: 'strength', level: 2, duration: 600 },
  ]);
  assert.deepEqual(snapshot.combatPolicy.meleeRisk.meleeOffense, {
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

test('snapshot combat policy reflects defensive potion effects in melee survival', () => {
  const sword = { name: 'iron_sword', count: 1 };
  const chestplate = { name: 'iron_chestplate', count: 1 };
  const base = makeBot();
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: sword,
    entity: {
      ...base.entity,
      equipment: [sword, null, null, null, chestplate, null],
      effects: [
        { name: 'regeneration', amplifier: 1, duration: 500 },
        { name: 'absorption', amplifier: 0, duration: 1200 },
      ],
    },
    inventory: {
      items: () => [],
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
    },
  });

  assert.deepEqual(snapshot.activeEffects, [
    { name: 'absorption', level: 1, duration: 1200 },
    { name: 'regeneration', level: 2, duration: 500 },
  ]);
  assert.deepEqual(snapshot.combatPolicy.meleeRisk, {
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
    meleeOffense: {
      weapon: 'iron_sword',
      target: 'zombie',
      estimatedTargetHealth: 20,
      estimatedWeaponDamage: 6,
      estimatedAttackIntervalSeconds: 0.63,
      estimatedHitsToKill: 4,
      estimatedSecondsToKill: 2.52,
    },
  });
});

test('snapshot combat policy reports hostile group pressure compactly', () => {
  const sword = { name: 'netherite_sword', count: 1 };
  const base = makeBot();
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: sword,
    entity: {
      ...base.entity,
      equipment: [
        sword,
        null,
        { name: 'netherite_boots', count: 1 },
        { name: 'netherite_leggings', count: 1 },
        { name: 'netherite_chestplate', count: 1 },
        { name: 'netherite_helmet', count: 1 },
      ],
    },
    entities: {
      zombie1: { id: 1, name: 'zombie', position: pos(3, 64, 0) },
      zombie2: { id: 2, name: 'zombie', position: pos(5, 64, 0) },
    },
    inventory: {
      items: () => [],
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      maxMeleeEngageThreatCount: 1,
    },
  });

  assert.deepEqual(snapshot.combatPolicy, {
    action: 'flee',
    reason: 'too-many-hostiles',
    threat: { name: 'zombie', distance: 3 },
    armorScore: 20,
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
        weapon: 'netherite_sword',
        target: 'zombie',
        estimatedTargetHealth: 20,
        estimatedWeaponDamage: 8,
        estimatedAttackIntervalSeconds: 0.63,
        estimatedHitsToKill: 3,
        estimatedSecondsToKill: 1.89,
        estimatedThreatsToClear: 2,
        estimatedHitsToClearThreats: 6,
        estimatedSecondsToClearThreats: 3.78,
      },
    },
    shield: { action: 'none', reason: 'shield-block-disabled' },
  });
  assert.deepEqual(snapshot.combatOverview, {
    threatLevel: 'high',
    advisorPriority: 'retreat',
    threatCount: 2,
    nearest: { name: 'zombie', distance: 3 },
    closeCount: 1,
    closeDistance: 4.5,
    maxMeleeEngageThreatCount: 1,
    armorScore: 20,
    composition: [{ name: 'zombie', count: 2 }],
    flags: {
      groupPressure: true,
      closePressure: true,
    },
    replanTriggers: ['group-pressure', 'close-pressure'],
    recommendedAction: 'flee',
    recommendedReason: 'too-many-hostiles',
    recommendedTarget: { name: 'zombie', distance: 3 },
  });
});

test('snapshot combat overview gives DeepSeek a compact clear-state threat summary', () => {
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    entities: {},
    inventory: {
      items: () => [],
    },
  }));

  assert.deepEqual(snapshot.combatOverview, {
    threatLevel: 'clear',
    advisorPriority: 'normal',
    threatCount: 0,
    closeCount: 0,
    closeDistance: 4.5,
    maxMeleeEngageThreatCount: 1,
    armorScore: 0,
    composition: [],
    flags: {},
    replanTriggers: [],
    recommendedAction: 'none',
    recommendedReason: 'no-threat',
  });
});

test('snapshot combat overview summarizes stacked close hostile pressure as critical', () => {
  const sword = { name: 'netherite_sword', count: 1 };
  const base = makeBot();
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: sword,
    entity: {
      ...base.entity,
      equipment: [
        sword,
        null,
        { name: 'netherite_boots', count: 1 },
        { name: 'netherite_leggings', count: 1 },
        { name: 'netherite_chestplate', count: 1 },
        { name: 'netherite_helmet', count: 1 },
      ],
    },
    entities: {
      zombie1: { id: 1, name: 'zombie', position: pos(2, 64, 0) },
      zombie2: { id: 2, name: 'zombie', position: pos(2.5, 64, 0) },
      zombie3: { id: 3, name: 'zombie', position: pos(3, 64, 0) },
      zombie4: { id: 4, name: 'zombie', position: pos(3.5, 64, 0) },
    },
    inventory: {
      items: () => [],
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      maxMeleeEngageThreatCount: 1,
    },
  });

  assert.deepEqual(snapshot.combatOverview, {
    threatLevel: 'critical',
    advisorPriority: 'retreat',
    threatCount: 4,
    nearest: { name: 'zombie', distance: 2 },
    closeCount: 4,
    closeDistance: 4.5,
    maxMeleeEngageThreatCount: 1,
    armorScore: 20,
    composition: [{ name: 'zombie', count: 4 }],
    flags: {
      groupPressure: true,
      closePressure: true,
    },
    replanTriggers: ['group-pressure', 'close-pressure'],
    recommendedAction: 'flee',
    recommendedReason: 'too-many-hostiles',
    recommendedTarget: { name: 'zombie', distance: 2 },
  });
});

test('snapshot combat policy exposes mixed-threat ranged target separately from nearest hostile', () => {
  const bow = { name: 'bow', count: 1 };
  const base = makeBot();
  const zombie = { id: 1, name: 'zombie', position: pos(5, 64, 0) };
  const creeper = { id: 2, name: 'creeper', position: pos(10, 64, 0) };
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: bow,
    entity: {
      ...base.entity,
      equipment: [bow, null, null, null, { name: 'netherite_chestplate', count: 1 }, null],
    },
    entities: {
      [zombie.id]: zombie,
      [creeper.id]: creeper,
    },
    inventory: {
      items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', count: 1, slot: 6 }],
    },
    canSeeEntity(target) {
      return target === creeper;
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      maxMeleeEngageThreatCount: 2,
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatFireMinDistance: 7,
      rangedCombatFireMaxDistance: 16,
    },
  });

  assert.deepEqual(snapshot.combatPolicy, {
    action: 'fire_ranged_weapon',
    reason: 'creeper-ranged-fire-safe',
    threat: { name: 'zombie', distance: 5 },
    armorScore: 8,
    threatCount: 2,
    item: { name: 'bow', count: 1 },
    unsafeThreat: 'creeper',
    targetThreat: { name: 'creeper', distance: 10 },
    lineOfSight: true,
    shield: { action: 'none', reason: 'shield-block-disabled' },
  });
  assert.deepEqual(snapshot.combatOverview, {
    threatLevel: 'high',
    advisorPriority: 'combat',
    threatCount: 2,
    nearest: { name: 'zombie', distance: 5 },
    closeCount: 0,
    closeDistance: 4.5,
    maxMeleeEngageThreatCount: 2,
    armorScore: 8,
    composition: [
      { name: 'creeper', count: 1 },
      { name: 'zombie', count: 1 },
    ],
    flags: {
      explosiveThreat: true,
    },
    replanTriggers: ['explosive-threat'],
    recommendedAction: 'fire_ranged_weapon',
    recommendedReason: 'creeper-ranged-fire-safe',
    recommendedTarget: { name: 'creeper', distance: 10 },
  });
});

test('snapshot combat overview includes compact last ranged verification', () => {
  const bow = { name: 'bow', count: 1 };
  const base = makeBot();
  const creeper = { id: 2, name: 'creeper', position: pos(10, 64, 0) };
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: bow,
    entity: {
      ...base.entity,
      equipment: [bow, null, null, null, { name: 'netherite_chestplate', count: 1 }, null],
    },
    entities: {
      [creeper.id]: creeper,
    },
    inventory: {
      items: () => [{ name: 'arrow', count: 16, slot: 7 }, { name: 'bow', count: 1, slot: 6 }],
    },
    canSeeEntity(target) {
      return target === creeper;
    },
  }), {
    nowMs: 1500,
    combatPolicyOptions: {
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatFireMinDistance: 7,
      rangedCombatFireMaxDistance: 16,
    },
    lastRangedFireVerification: {
      item: 'bow',
      entity: 'creeper',
      entityId: 2,
      reason: 'creeper-ranged-fire-safe',
      outcome: 'target-still-present',
      currentDistance: 10.04,
      lineOfSight: true,
      followUpShots: 2,
      maxFollowUpShots: 3,
      followUpWindowMs: 10000,
      at: 1000,
    },
  });

  assert.deepEqual(snapshot.combatOverview.lastRangedFire, {
    outcome: 'target-still-present',
    entity: 'creeper',
    entityId: 2,
    item: 'bow',
    reason: 'creeper-ranged-fire-safe',
    currentDistance: 10,
    lineOfSight: true,
    followUpShots: 2,
    maxFollowUpShots: 3,
    followUpWindowMs: 10000,
    ageMs: 500,
  });
});

test('snapshot combat policy reports close hostile pressure blocking ranged actions', () => {
  const bow = { name: 'bow', count: 1 };
  const base = makeBot();
  const zombie = { id: 1, name: 'zombie', position: pos(2.5, 64, 0) };
  const creeper = { id: 2, name: 'creeper', position: pos(10, 64, 0) };
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: bow,
    entity: {
      ...base.entity,
      equipment: [bow, null, null, null, { name: 'netherite_chestplate', count: 1 }, null],
    },
    entities: {
      [zombie.id]: zombie,
      [creeper.id]: creeper,
    },
    inventory: {
      items: () => [
        { name: 'bow', count: 1 },
        { name: 'arrow', count: 12 },
      ],
    },
    canSeeEntity(target) {
      return target === creeper;
    },
  }), {
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      maxMeleeEngageThreatCount: 2,
      rangedCombatPrepEnabled: true,
      rangedCombatFireEnabled: true,
      rangedCombatFireMinDistance: 7,
      rangedCombatFireMaxDistance: 16,
    },
  });

  assert.deepEqual(snapshot.combatPolicy, {
    action: 'flee',
    reason: 'close-hostile-pressure-before-ranged',
    threat: { name: 'zombie', distance: 2.5 },
    armorScore: 8,
    threatCount: 2,
    unsafeThreat: 'zombie',
    closeThreatDistance: 2.5,
    targetThreat: { name: 'creeper', distance: 10 },
    lineOfSight: true,
    shield: { action: 'none', reason: 'shield-block-disabled' },
  });
  assert.deepEqual(snapshot.combatOverview.recommendedAction, 'flee');
  assert.deepEqual(snapshot.combatOverview.recommendedReason, 'close-hostile-pressure-before-ranged');
  assert.equal(snapshot.combatOverview.flags.closePressure, true);
});

test('snapshot combat overview treats close creeper pressure as critical', () => {
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    entities: {
      creeper: { id: 1, name: 'creeper', position: pos(3, 64, 0) },
    },
    inventory: {
      items: () => [],
    },
  }));

  assert.deepEqual(snapshot.combatOverview, {
    threatLevel: 'critical',
    advisorPriority: 'retreat',
    threatCount: 1,
    nearest: { name: 'creeper', distance: 3 },
    closeCount: 1,
    closeDistance: 4.5,
    maxMeleeEngageThreatCount: 1,
    armorScore: 0,
    composition: [{ name: 'creeper', count: 1 }],
    flags: {
      closePressure: true,
      explosiveThreat: true,
      closeExplosiveThreat: true,
    },
    replanTriggers: ['close-explosive-threat', 'explosive-threat', 'close-pressure'],
    recommendedAction: 'flee',
    recommendedReason: 'creeper-anti-explosion',
    recommendedTarget: { name: 'creeper', distance: 3 },
  });
});

test('snapshot combat policy includes observed recent damage pressure', () => {
  const shield = { name: 'shield', count: 1 };
  const sword = { name: 'iron_sword', count: 1 };
  const chestplate = { name: 'iron_chestplate', count: 1 };
  const base = makeBot();
  const recentDamage = {
    totalDamage: 10,
    recentDamagePerSecond: 10,
    windowMs: 1000,
    lastDamageMsAgo: 100,
  };
  const snapshot = buildSnapshot(makeBot({
    health: 20,
    heldItem: sword,
    entity: {
      ...base.entity,
      equipment: [sword, shield, null, null, chestplate, null],
    },
    inventory: {
      items: () => [],
    },
  }), {
    recentDamage,
    combatPolicyOptions: {
      engageOverFlee: true,
      minArmorScoreToEngage: 6,
      minMeleeSurvivalSecondsToEngage: 3,
    },
  });

  assert.deepEqual(snapshot.recentDamage, recentDamage);
  assert.deepEqual(snapshot.combatPolicy, {
    action: 'flee',
    reason: 'melee-survival-margin-too-low',
    threat: { name: 'zombie', distance: 3 },
    armorScore: 6,
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
      meleeOffense: {
        weapon: 'iron_sword',
        target: 'zombie',
        estimatedTargetHealth: 20,
        estimatedWeaponDamage: 6,
        estimatedAttackIntervalSeconds: 0.63,
        estimatedHitsToKill: 4,
        estimatedSecondsToKill: 2.52,
      },
    },
    shield: { action: 'none', reason: 'shield-block-disabled' },
  });
});

test('snapshot consumable recommendation keeps potion use opt-in', () => {
  const potion = {
    name: 'potion',
    count: 1,
    slot: 7,
    potionType: 'minecraft:strong_strength',
  };
  const bot = makeBot({
    inventory: { items: () => [potion] },
  });

  assert.deepEqual(
    buildSnapshot(bot, {
      consumablePolicyOptions: {
        intent: 'hostile_combat',
        allowPotions: false,
      },
    }).consumablePolicy,
    { action: 'none', reason: 'no-consumable-needed' },
  );

  assert.deepEqual(
    buildSnapshot(bot, {
      consumablePolicyOptions: {
        intent: 'hostile_combat',
        allowPotions: true,
      },
    }).consumablePolicy,
    {
      action: 'drink_potion',
      reason: 'combat-strength',
      item: { name: 'potion', count: 1, slot: 7 },
      effect: 'strength',
      level: 2,
    },
  );
});

test('snapshot consumable recommendation respects active potion effects', () => {
  const potion = {
    name: 'potion',
    count: 1,
    slot: 7,
    potionType: 'minecraft:strong_strength',
  };
  const base = makeBot();
  const bot = makeBot({
    registry: {
      effectsArray: [{ id: 4, displayName: 'Strength' }],
    },
    entity: {
      ...base.entity,
      effects: {
        4: { amplifier: 1, duration: 600 },
      },
    },
    inventory: { items: () => [potion] },
  });

  const snapshot = buildSnapshot(bot, {
    consumablePolicyOptions: {
      intent: 'hostile_combat',
      allowPotions: true,
    },
  });

  assert.deepEqual(snapshot.activeEffects, [
    { name: 'strength', level: 2, duration: 600 },
  ]);
  assert.deepEqual(snapshot.consumablePolicy, {
    action: 'none',
    reason: 'no-consumable-needed',
  });
});

test('observe returns the enriched snapshot context', async () => {
  const result = await runObserve(makeBot(), {}, {
    signal: new AbortController().signal,
    callState: {},
    currentSubtask: 'observe({})',
    remainingQueue: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.reactiveState, 'HAZARD');
  assert.equal(result.state.currentSkill.skill, 'collect');
  assert.equal(result.state.queueLength, 2);
  assert.equal(result.state.hazardFlags.oxygenLow, true);
});

test('snapshot falls back to call context when no executor is attached', () => {
  const bot = makeBot({ skillExecutor: null, reactiveController: null });
  const snapshot = buildSnapshot(bot, {
    currentSubtask: 'goto({"x":1})',
    remainingQueue: [{ skill: 'deposit', params: {} }],
  });

  assert.equal(snapshot.reactiveState, null);
  assert.deepEqual(snapshot.currentSkill, { skill: 'goto' });
  assert.equal(snapshot.queueLength, 2);
});

test('snapshot reports unavailable inventory without throwing', () => {
  const snapshot = buildSnapshot(makeBot({
    inventory: {
      items() {
        throw new Error('inventory cache unavailable');
      },
    },
  }));

  assert.deepEqual(snapshot.inventory, []);
  assert.deepEqual(snapshot.inventoryStatus, {
    ok: false,
    reason: 'inventory unavailable: inventory cache unavailable',
  });
});

test('snapshot reports unavailable pathfinder context without throwing', () => {
  const snapshot = buildSnapshot(makeBot({
    pathfinderOwner: {
      currentOwner() {
        throw new Error('owner unavailable');
      },
      isIdle() {
        throw new Error('idle unavailable');
      },
    },
  }));

  assert.deepEqual(snapshot.pathfinder, {
    owner: null,
    idle: null,
    ownerError: 'owner unavailable',
    idleError: 'idle unavailable',
  });
});
