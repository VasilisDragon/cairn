import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBJECTIVE_IDS,
  OBJECTIVE_MODEL,
  THRESHOLDS,
  acceptableObjectives,
  buildPlannerPrompt,
  chooseNextObjective,
  expectedObjective,
  gradeChoice,
  ironAcquisitionToolBudget,
  isObjectiveId,
  missionComplete,
  miningManifestStatus,
  objectiveEffects,
  objectivePreconditionStatus,
  objectivePreconditionsMet,
  objectiveAchieved,
  parsePlannerReply,
  plannerStateView,
  rawIronFuelAdmission,
  rawIronFuelFingerprint,
  shouldConsultPlanner,
  stoneCompletionRequirement,
  summarizeState,
  woodCompletionRequirement,
} from './mission-planner.js';

// ---- helpers ---------------------------------------------------------------

function state(overrides = {}) {
  return {
    logs: 0,
    planks: 0,
    sticks: 0,
    craftingTables: 0,
    woodenPickaxes: 0,
    cobblestone: 0,
    stonePickaxes: 0,
    stoneSwords: 0,
    furnaces: 0,
    fuel: 0,
    rawIron: 0,
    ironIngots: 0,
    ironPickaxes: 0,
    diamonds: 0,
    diamondPickaxes: 0,
    equippedArmorPieces: 0,
    foodLevel: 20,
    hasFood: false,
    atIronDepth: false,
    threatPresent: false,
    ...overrides,
  };
}

function mockComplete(reply) {
  return async () => (typeof reply === 'function' ? reply() : reply);
}

function jsonReply(objective, done = false, reason = 'x') {
  return JSON.stringify({ objective, done, reason });
}

// A clear, unambiguous walk along the early-game spine. Each state has exactly one sensible
// next objective — this is the known-answer test bed used to grade the planner.
const SPINE = [
  { label: 'empty inventory', s: state({}), expected: 'GATHER_WOOD' },
  { label: 'have reserve logs, no tools', s: state({ logs: THRESHOLDS.woodForIronArmorMission }), expected: 'MAKE_WOOD_TOOLS' },
  { label: 'wooden pickaxe, no cobble', s: state({ woodenPickaxes: 1, logs: 2 }), expected: 'MINE_STONE' },
  { label: 'have exact first-stage cobble, no stone tools', s: state({ woodenPickaxes: 1, cobblestone: 8, sticks: 8, tablePlaced: true }), expected: 'MAKE_STONE_TOOLS' },
  { label: 'stone tools, low cobble for furnace', s: state({ woodenPickaxes: 1, stonePickaxes: 2, stoneSwords: 1, cobblestone: 3 }), expected: 'MINE_STONE' },
  { label: 'stone tools, enough cobble, no furnace', s: state({ woodenPickaxes: 1, stonePickaxes: 2, stoneSwords: 1, cobblestone: 11, tablePlaced: true }), expected: 'MAKE_FURNACE' },
  { label: 'geared on surface, must descend', s: state({ woodenPickaxes: 1, stonePickaxes: 2, stoneSwords: 1, furnaces: 1, craftingTables: 1, sticks: 4, cobblestone: 3, atIronDepth: false, y: 70 }), expected: 'DESCEND' },
  { label: 'at depth, no iron, cannot smelt', s: state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: true }), expected: 'MINE_IRON' },
  { label: 'raw iron + furnace + fuel', s: state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: true, rawIron: 6, fuel: 5 }), expected: 'SMELT_IRON' },
  { label: 'ingots, no iron pickaxe', s: state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 10, sticks: 4, tablePlaced: true }), expected: 'MAKE_IRON_TOOLS' },
  { label: 'iron pickaxe, ingots, no armor', s: state({ stonePickaxes: 1, furnaces: 1, atIronDepth: true, ironPickaxes: 1, ironIngots: 24, equippedArmorPieces: 0, tablePlaced: true }), expected: 'MAKE_ARMOR' },
  { label: 'fully geared and fed', s: state({ ironPickaxes: 1, equippedArmorPieces: 4, foodLevel: 20 }), expected: 'DONE' },
];

// ---- oracle ----------------------------------------------------------------

test('oracle returns the canonical next objective along the early-game spine', () => {
  for (const { label, s, expected } of SPINE) {
    assert.equal(expectedObjective(s), expected, `oracle mismatch for: ${label}`);
  }
});

test('oracle keeps gathering wood until the iron-smelting fuel reserve is met', () => {
  assert.equal(expectedObjective(state({ logs: THRESHOLDS.woodForIronArmorMission - 1 })), 'GATHER_WOOD');
  assert.equal(expectedObjective(state({ logs: THRESHOLDS.woodForIronArmorMission })), 'MAKE_WOOD_TOOLS');
  assert.equal(expectedObjective(state({ targetIronPickaxeOnly: true, logs: THRESHOLDS.woodForTools - 1 })), 'GATHER_WOOD');
  assert.equal(expectedObjective(state({ targetIronPickaxeOnly: true, logs: THRESHOLDS.woodForTools })), 'MAKE_WOOD_TOOLS');
  assert.equal(expectedObjective(state({ targetIronPickaxeOnly: true, planks: THRESHOLDS.planksForIronPickaxeMission - 1 })), 'GATHER_WOOD');
  assert.equal(expectedObjective(state({ targetIronPickaxeOnly: true, planks: THRESHOLDS.planksForIronPickaxeMission })), 'MAKE_WOOD_TOOLS');
  assert.equal(expectedObjective(state({ planks: THRESHOLDS.planksForIronArmorMission - 1 })), 'GATHER_WOOD');
  assert.equal(expectedObjective(state({ planks: THRESHOLDS.planksForIronArmorMission })), 'MAKE_WOOD_TOOLS');
});

test('wood completion requirements are shared by the mission predicate', () => {
  assert.deepEqual(woodCompletionRequirement(state()), {
    inventoryLogCount: 20,
    inventoryPlankCount: 48,
  });
  assert.deepEqual(woodCompletionRequirement(state({ targetIronPickaxeOnly: true })), {
    inventoryLogCount: 5,
    inventoryPlankCount: 18,
  });
  assert.deepEqual(woodCompletionRequirement(state({ targetDiamondTier: true })), {
    inventoryLogCount: 5,
    inventoryPlankCount: 18,
  });

  for (const goal of [{}, { targetIronPickaxeOnly: true }, { targetDiamondTier: true }]) {
    const requirement = woodCompletionRequirement(state(goal));
    assert.equal(objectiveAchieved('GATHER_WOOD', state({
      ...goal,
      logs: requirement.inventoryLogCount - 1,
      planks: requirement.inventoryPlankCount - 1,
    })), false);
    assert.equal(objectiveAchieved('GATHER_WOOD', state({
      ...goal,
      logs: requirement.inventoryLogCount,
    })), true);
    assert.equal(objectiveAchieved('GATHER_WOOD', state({
      ...goal,
      planks: requirement.inventoryPlankCount,
    })), true);
  }
});

test('stone completion requirement stages an early tool upgrade before exact reserves', () => {
  const fullArmorStoneToolCobble = (THRESHOLDS.stonePickaxesForIronArmorMission * 3) + 2;
  assert.equal(fullArmorStoneToolCobble, 8, 'two pickaxes plus a real stone sword cost eight cobblestone');
  assert.equal(stoneCompletionRequirement(state({ woodenPickaxes: 1 })), 8);
  assert.equal(stoneCompletionRequirement(state({ targetIronPickaxeOnly: true, woodenPickaxes: 1 })), 3);
  assert.equal(stoneCompletionRequirement(state({ targetDiamondTier: true, woodenPickaxes: 1 })), 8);
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, cobblestone: 7, sticks: 4, tablePlaced: true })),
    'MINE_STONE',
  );
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, cobblestone: fullArmorStoneToolCobble, sticks: 8, tablePlaced: true })),
    'MAKE_STONE_TOOLS',
  );
  const armoredTools = state({ woodenPickaxes: 1, stonePickaxes: 2, stoneSwords: 1, tablePlaced: true });
  assert.equal(stoneCompletionRequirement(armoredTools), 11);
  assert.equal(expectedObjective({ ...armoredTools, cobblestone: 10 }), 'MINE_STONE');
  assert.equal(expectedObjective({ ...armoredTools, cobblestone: 11 }), 'MAKE_FURNACE');

  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 2, sticks: 2, tablePlaced: true })),
    'MINE_STONE',
  );
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 3, sticks: 2, tablePlaced: true })),
    'MAKE_STONE_TOOLS',
  );
  const pickaxeOnlyTools = state({ targetIronPickaxeOnly: true, stonePickaxes: 1, tablePlaced: true, y: 70 });
  assert.equal(stoneCompletionRequirement(pickaxeOnlyTools), 14);
  assert.equal(stoneCompletionRequirement({ ...pickaxeOnlyTools, furnaces: 1 }), 6);
  assert.equal(stoneCompletionRequirement({ ...armoredTools, furnaces: 1 }), 3);
  assert.equal(stoneCompletionRequirement({ ...armoredTools, ironPickaxes: 1 }), 8);
});

test('verified village iron gear takes executable progress before exact furnace preparation', () => {
  const chestPickaxe = state({
    ironPickaxes: 1,
    craftingTables: 1,
    logs: 20,
    sticks: 4,
    cobblestone: 0,
    furnaces: 0,
    foodLevel: 20,
    y: 70,
  });
  assert.equal(stoneCompletionRequirement(chestPickaxe), 8);
  assert.equal(expectedObjective(chestPickaxe), 'MINE_STONE');
  assert.equal(objectivePreconditionsMet('MINE_STONE', chestPickaxe), true);
  assert.equal(expectedObjective({ ...chestPickaxe, cobblestone: 7 }), 'MINE_STONE');
  const furnaceReady = { ...chestPickaxe, cobblestone: 8 };
  assert.equal(expectedObjective(furnaceReady), 'MAKE_FURNACE');
  assert.equal(objectivePreconditionsMet('MAKE_FURNACE', furnaceReady), true,
    'the oracle must never advertise a precondition-invalid furnace craft');
  assert.equal(expectedObjective({ ...chestPickaxe, furnaces: 1 }), 'DESCEND');

  const partialArmor = {
    ...chestPickaxe,
    equippedArmorPieces: 1,
    equippedHelmetItem: 'iron_helmet',
  };
  assert.equal(expectedObjective({ ...partialArmor, ironIngots: 7 }), 'MINE_STONE');
  assert.equal(expectedObjective({ ...partialArmor, ironIngots: 8 }), 'MAKE_ARMOR',
    'already-owned ingots should craft the next piece before building unnecessary infrastructure');
  assert.equal(objectivePreconditionsMet('MAKE_ARMOR', { ...partialArmor, ironIngots: 8 }), true);
  assert.equal(expectedObjective({ ...chestPickaxe, rawIron: 3 }), 'MINE_STONE',
    'raw iron still requires real furnace materials');

  const outOfOrderChestplate = {
    ...chestPickaxe,
    ironChestplates: 1,
  };
  assert.equal(expectedObjective(outOfOrderChestplate), 'MAKE_ARMOR');
  assert.equal(objectivePreconditionsMet('MAKE_ARMOR', outOfOrderChestplate), true,
    'a verified inventory armor piece is authoritative equip progress');

  const ingotPickaxe = state({
    stonePickaxes: 2,
    stoneSwords: 1,
    ironIngots: 3,
    sticks: 2,
    tablePlaced: true,
    furnaces: 0,
  });
  assert.equal(expectedObjective(ingotPickaxe), 'MAKE_IRON_TOOLS');
  assert.equal(objectivePreconditionsMet('MAKE_IRON_TOOLS', ingotPickaxe), true);
  assert.equal(expectedObjective(state({
    targetIronPickaxeOnly: true,
    ironPickaxes: 1,
    foodLevel: 20,
  })), 'DONE');
});

test('oracle uses the actual next missing armor-piece cost, not a helmet-sized threshold', () => {
  const afterHelmet = state({
    stonePickaxes: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    ironPickaxes: 1,
    ironIngots: 5,
    equippedArmorPieces: 1,
    equippedHelmetItem: 'iron_helmet',
    tablePlaced: true,
  });
  assert.equal(expectedObjective(afterHelmet), 'MINE_IRON');
  assert.equal(objectivePreconditionsMet('MAKE_ARMOR', afterHelmet), false);
  const staleHelmetSpare = { ...afterHelmet, ironIngots: 0, ironHelmets: 1 };
  assert.equal(expectedObjective(staleHelmetSpare), 'MINE_IRON');
  assert.equal(objectivePreconditionsMet('MAKE_ARMOR', staleHelmetSpare), false);
  assert.equal(expectedObjective({ ...afterHelmet, ironIngots: 8 }), 'MAKE_ARMOR');
  assert.equal(objectivePreconditionsMet('MAKE_ARMOR', { ...afterHelmet, ironIngots: 8 }), true);
});

test('oracle reserves the cobble needed to top up descent durability for iron-pickaxe-only missions', () => {
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, stonePickaxes: 1, cobblestone: 14, tablePlaced: true })),
    'MAKE_FURNACE',
  );
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, stonePickaxes: 1, cobblestone: 4, tablePlaced: true })),
    'MINE_STONE',
  );
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, stonePickaxes: 1, cobblestone: 5, tablePlaced: true })),
    'MAKE_STONE_TOOLS',
  );
});

test('oracle refreshes weak stone pickaxes before the iron phase', () => {
  const weak = state({
    woodenPickaxes: 1,
    stonePickaxes: THRESHOLDS.stonePickaxesForIronArmorMission,
    stoneSwords: 1,
    bestStonePickaxeRemaining: THRESHOLDS.minStonePickaxeRemainingForIronPhase - 1,
    cobblestone: 6,
    sticks: 2,
    furnaces: 1,
    tablePlaced: true,
    atIronDepth: false,
  });
  assert.equal(expectedObjective(weak), 'MAKE_STONE_TOOLS');
  assert.equal(objectivePreconditionsMet('MAKE_STONE_TOOLS', weak), true);
  assert.equal(
    expectedObjective({ ...weak, cobblestone: 2 }),
    'MINE_STONE',
  );
});

test('mining manifest uses the bounded segment formula and exact inventory durability', () => {
  const ready = miningManifestStatus(state({
    y: 70,
    stonePickaxes: 2,
    totalStonePickaxeRemaining: 156,
    craftingTables: 1,
    sticks: 4,
    cobblestone: 3,
  }));
  assert.equal(ready.nextDescentDepth, 20);
  assert.equal(ready.requiredDurability, 156);
  assert.equal(ready.availableDurability, 156);
  assert.equal(ready.additionalStonePickaxes, 0);
  assert.equal(ready.requiredCobblestoneForDurability, 3);
  assert.equal(ready.requiredSticksForDurability, 4);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);

  const shallow = miningManifestStatus(state({
    y: 24,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 119,
    craftingTables: 1,
    sticks: 4,
    cobblestone: 3,
  }));
  assert.equal(shallow.nextDescentDepth, 8);
  assert.equal(shallow.requiredDurability, 120);
  assert.equal(shallow.additionalStonePickaxes, 1);
  assert.equal(shallow.requiredCobblestoneForDurability, 6);
  assert.equal(shallow.requiredSticksForDurability, 6);
  assert.deepEqual(shallow.missing, ['stone_pickaxe_durability']);

  const exempt = miningManifestStatus(state({ ironPickaxes: 1 }));
  assert.equal(exempt.ready, true);
  assert.equal(exempt.exempt, true);
  assert.equal(exempt.requiredDurability, 0);
});

test('goal-aware iron acquisition budget counts exact goal deficits and reserves', () => {
  const armorStart = ironAcquisitionToolBudget(state());
  assert.equal(armorStart.totalIronRequirement, 27);
  assert.equal(armorStart.remainingMissionIronCount, 27);
  assert.equal(armorStart.currentMilestoneDeficit, 3);
  assert.equal(armorStart.reservedIronPickaxeCount, 1);
  assert.equal(armorStart.reservedIronPickaxeDurabilityFloor, 64);

  assert.equal(ironAcquisitionToolBudget(state({ targetIronPickaxeOnly: true })).remainingMissionIronCount, 3);
  assert.equal(ironAcquisitionToolBudget(state({ targetDiamondTier: true, ironPickaxes: 1 })).remainingMissionIronCount, 3);
  assert.equal(ironAcquisitionToolBudget(state({ ironPickaxes: 1 })).remainingMissionIronCount, 24);

  const partial = ironAcquisitionToolBudget(state({
    ironPickaxes: 1,
    equippedArmorPieces: 1,
    equippedHelmetItem: 'iron_helmet',
    equippedChestplateItem: '',
    equippedLeggingsItem: '',
    equippedBootsItem: '',
    ironChestplates: 1,
    rawIron: 2,
    ironIngots: 3,
  }));
  assert.equal(partial.totalIronRequirement, 11, 'carried chestplate and equipped helmet cost no new iron');
  assert.equal(partial.remainingMissionIronCount, 6);
});

test('goal-aware iron acquisition budget reserves healthiest picks and pins exact horizons', () => {
  const raw = state({
    ironPickaxes: 3,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 10,
    equippedArmorPieces: 1,
    equippedHelmetItem: 'iron_helmet',
    equippedChestplateItem: '',
    equippedLeggingsItem: '',
    equippedBootsItem: '',
    inventoryDurability: [
      { itemId: 'minecraft:iron_pickaxe', remainingDurability: 65 },
      { itemId: 'iron_pickaxe', remainingDurability: 40 },
      { itemId: 'minecraft:iron_pickaxe', remainingDurability: 100 },
      { itemId: 'minecraft:stone_pickaxe', remainingDurability: 10 },
    ],
  });
  const armor = ironAcquisitionToolBudget(raw);
  assert.deepEqual(armor.reservedIronPickaxeDurability, [100]);
  assert.equal(armor.reservedSpendableDurability, 36);
  assert.equal(armor.surplusIronPickaxeDurability, 105);
  assert.equal(armor.spendableDurability, 151);
  assert.equal(armor.currentMilestoneDeficit, 8);
  assert.equal(armor.laneProspectBreaks, 30);
  assert.equal(armor.connectedVeinAllowance, 8);
  assert.equal(armor.laneRequiredDurability, 46);
  assert.equal(armor.recoveryReady, true);

  const diamond = ironAcquisitionToolBudget({ ...raw, targetDiamondTier: true }, { recoveryDepth: 2 });
  assert.deepEqual(diamond.reservedIronPickaxeDurability, [100, 65]);
  assert.equal(diamond.reservedSpendableDurability, 37);
  assert.equal(diamond.surplusIronPickaxeDurability, 40);
  assert.equal(diamond.spendableDurability, 87);
  assert.equal(diamond.recoveryBreaks, 30);
  assert.equal(diamond.recoveryRequiredDurability, 68, 'all required diamond-descent picks already exist');

  const recoveryMaximum = ironAcquisitionToolBudget(raw, { recoveryDepth: 2 });
  assert.equal(recoveryMaximum.recoveryRequiredDurability, 76);

  const clamped = ironAcquisitionToolBudget(raw, { recoveryDepth: 2, remainingEpochBlocks: 4 });
  assert.equal(clamped.laneRequiredDurability, 20);
  assert.equal(clamped.recoveryRequiredDurability, 50);

  for (const [remaining, spendable] of [[63, 0], [64, 0], [65, 1]]) {
    assert.equal(ironAcquisitionToolBudget(state({
      targetIronPickaxeOnly: true,
      ironPickaxes: 1,
      inventoryDurability: [{ itemId: 'minecraft:iron_pickaxe', remainingDurability: remaining }],
    })).spendableDurability, spendable, `reserve boundary ${remaining}`);
  }

  const localRestock = {
    ironPickaxes: 1,
    inventoryDurability: [{ itemId: 'minecraft:iron_pickaxe', remainingDurability: 64 }],
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    cobblestone: 3,
    sticks: 2,
    craftingTables: 0,
    tablePlaced: false,
    miningWorkspaceAvailable: false,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: false,
    logs: 0,
  };
  assert.equal(ironAcquisitionToolBudget(state({ ...localRestock, planks: 9 })).canPrepareStonePickaxe, false);
  assert.equal(ironAcquisitionToolBudget(state({ ...localRestock, planks: 10 })).canPrepareStonePickaxe, true);
});

test('oracle treats survival as an interrupt when hungry with food', () => {
  assert.equal(expectedObjective(state({ foodLevel: 3, hasFood: true })), 'EAT');
  // Hungry but no food: cannot eat, so continue the progression instead of stalling on EAT.
  assert.equal(expectedObjective(state({ foodLevel: 3, hasFood: false })), 'GATHER_WOOD');
  // Gear complete but hungry: not done yet -> eat first.
  assert.equal(
    expectedObjective(state({ ironPickaxes: 1, equippedArmorPieces: 4, foodLevel: 3, hasFood: true })),
    'EAT',
  );
});

test('oracle recovers: needs more iron when ingots are short and it cannot smelt', () => {
  // At depth, want a pickaxe, only 1 ingot, no raw iron / no fuel -> must mine more.
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 1 })),
    'MINE_IRON',
  );
  // Same but raw iron + fuel on hand -> smelt.
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 1, rawIron: 4, fuel: 2 })),
    'SMELT_IRON',
  );
});

test('oracle smelts carried raw iron before forcing another descent', () => {
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, stonePickaxes: 1, furnaces: 1, atIronDepth: false, rawIron: 4, fuel: 2 })),
    'SMELT_IRON',
  );
  assert.equal(
    expectedObjective(state({ ironPickaxes: 1, furnaces: 1, atIronDepth: false, rawIron: 4, fuel: 2, equippedArmorPieces: 0 })),
    'SMELT_IRON',
  );
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, stonePickaxes: 1, furnaces: 1, atIronDepth: true, rawIron: 3, fuel: 0, planks: 2 })),
    'SMELT_IRON',
  );
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, stonePickaxes: 1, furnaces: 1, atIronDepth: true, rawIron: 3, fuel: 0, logs: 2 })),
    'SMELT_IRON',
  );
  // Fuel v2, selector layer (fuel selector fix): at depth, fuel-out with raw iron banked STAYS
  // SMELT_IRON even with zero wood — coal is minable right there and the action layer mines it. The
  // underground wood search this used to trigger is unwinnable (it killed live runs 18/22). The
  // surface fuel-out path still routes to GATHER_WOOD (pinned in mission-orchestrator.test.mjs).
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, stonePickaxes: 1, furnaces: 1, atIronDepth: true, rawIron: 3, fuel: 0, logs: 0, planks: 0 })),
    'SMELT_IRON',
  );
});

test('oracle recovers table access before table-dependent crafts', () => {
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: 11, tablePlaced: false, craftingTables: 0, logs: 0, planks: 1 })),
    'GATHER_WOOD',
  );
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: 11, logs: 1 })),
    'MAKE_FURNACE',
  );
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: false, logs: 0, planks: 0, tablePlaced: false, craftingTables: 0 })),
    'GATHER_WOOD',
  );
  assert.equal(
    expectedObjective(state({
      stonePickaxes: 2,
      stoneSwords: 1,
      furnaces: 1,
      sticks: 4,
      cobblestone: 3,
      totalStonePickaxeRemaining: 156,
      atIronDepth: false,
      logs: 0,
      planks: 0,
      tablePlaced: true,
      craftingTables: 0,
    })),
    'DESCEND',
  );
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 3, sticks: 2, logs: 0, planks: 0, tablePlaced: false })),
    'GATHER_WOOD',
  );
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 3, sticks: 2, craftingTables: 1 })),
    'MAKE_IRON_TOOLS',
  );
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, stonePickaxes: 1, furnaces: 1, furnacePlaced: true, atIronDepth: true, ironIngots: 3, sticks: 0, logs: 0, planks: 0, tablePlaced: true })),
    'GATHER_WOOD',
  );
  assert.equal(
    objectivePreconditionsMet('MAKE_IRON_TOOLS', state({ ironIngots: 3, sticks: 0, logs: 0, planks: 0, tablePlaced: true })),
    false,
  );
});

test('oracle treats only an in-band returnable workspace as remote table and furnace access', () => {
  const remoteWorkspace = {
    stonePickaxes: 2,
    stoneSwords: 1,
    atIronDepth: true,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: true,
  };
  assert.equal(expectedObjective(state({
    ...remoteWorkspace,
    rawIron: 3,
    fuel: 4,
  })), 'SMELT_IRON');
  assert.equal(expectedObjective(state({
    ...remoteWorkspace,
    ironIngots: 3,
    sticks: 2,
  })), 'MAKE_IRON_TOOLS');
  assert.equal(expectedObjective(state({
    ...remoteWorkspace,
    ironPickaxes: 1,
    ironIngots: 5,
  })), 'MAKE_ARMOR');

  assert.equal(expectedObjective(state({
    ...remoteWorkspace,
    miningWorkspaceReturnAvailable: false,
    rawIron: 3,
    fuel: 4,
    logs: 0,
    planks: 0,
  })), 'MINE_STONE');
  assert.equal(expectedObjective(state({
    ...remoteWorkspace,
    atIronDepth: false,
    rawIron: 3,
    fuel: 4,
    logs: 0,
    planks: 0,
  })), 'MINE_STONE');
});

test('missionComplete requires iron pickaxe, full armor, and not hungry', () => {
  assert.equal(missionComplete(state({ ironPickaxes: 1, equippedArmorPieces: 4, foodLevel: 20 })), true);
  assert.equal(missionComplete(state({ ironPickaxes: 1, equippedArmorPieces: 3, foodLevel: 20 })), false);
  assert.equal(missionComplete(state({ ironPickaxes: 0, equippedArmorPieces: 4, foodLevel: 20 })), false);
  assert.equal(missionComplete(state({ ironPickaxes: 1, equippedArmorPieces: 4, foodLevel: 4 })), false);
  assert.equal(missionComplete(state({ targetIronPickaxeOnly: true, ironPickaxes: 1, equippedArmorPieces: 0, foodLevel: 20 })), true);
  assert.equal(missionComplete(state({ missionGoal: 'iron_pickaxe', ironPickaxes: 1, equippedArmorPieces: 0, foodLevel: 20 })), true);
  assert.equal(missionComplete(state({ targetDiamondTier: true, ironPickaxes: 1, equippedArmorPieces: 4, diamonds: THRESHOLDS.diamondsForPickaxe, foodLevel: 20 })), false);
  assert.equal(missionComplete(state({ targetDiamondTier: true, diamondPickaxes: THRESHOLDS.diamondPickaxesForProgress, foodLevel: 20 })), true);
});

// ---- state normalization ---------------------------------------------------

test('summarizeState accepts raw ClientSnapshot field names', () => {
  const s = summarizeState({
    inventoryLogCount: 7,
    inventoryDiamondCount: 2,
    inventoryDiamondPickaxeCount: 1,
    inventoryBestIronPickaxeRemainingDurability: 123,
    inventoryBestStonePickaxeRemainingDurability: 45,
    inventoryCoalCount: 2,
    inventoryCharcoalCount: 1,
    inventoryIronHelmetCount: 1,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: true,
    miningWorkspaceBreadcrumbCount: 72,
    foodLevel: 3,
    hasFood: true,
    equippedHelmetItem: 'iron_helmet',
    equippedChestplateItem: 'iron_chestplate',
    equippedLeggingsItem: 'iron_leggings',
    equippedBootsItem: 'iron_boots',
  });
  assert.equal(s.logs, 7);
  assert.equal(s.diamonds, 2);
  assert.equal(s.diamondPickaxes, 1);
  assert.equal(s.bestIronPickaxeRemaining, 123);
  assert.equal(s.bestStonePickaxeRemaining, 45);
  assert.equal(s.fuel, 10);
  assert.equal(s.ironHelmets, 1);
  assert.equal(s.equippedArmorPieces, 4);
  assert.equal(s.foodLevel, 3);
  assert.equal(s.hasFood, true);
  assert.equal(s.miningWorkspaceAvailable, true);
  assert.equal(s.miningWorkspaceAtSite, false);
  assert.equal(s.miningWorkspaceReturnAvailable, true);
  assert.equal(s.miningWorkspaceBreadcrumbCount, 72);
  assert.equal(expectedObjective(s), 'EAT');
});

test('raw-iron fuel admission mirrors Fabric batch and protected-plank rules', () => {
  const threeItem = rawIronFuelAdmission(state({ rawIron: 3, ironIngots: 0, fuel: 0 }));
  assert.deepEqual({
    batch: threeItem.batchSize,
    wood: threeItem.woodFuelRequired,
    efficient: threeItem.efficientFuelRequired,
    reserve: threeItem.protectedPlanks,
  }, { batch: 3, wood: 2, efficient: 1, reserve: 6 });

  assert.equal(rawIronFuelAdmission(state({ rawIron: 3, planks: 4, fuel: 0 })).inventoryAdmitted, false);
  assert.equal(rawIronFuelAdmission(state({ rawIron: 3, planks: 7, fuel: 0 })).inventoryAdmitted, false);
  assert.equal(rawIronFuelAdmission(state({ rawIron: 3, planks: 8, fuel: 0 })).sourceClass, 'planks');

  const oneItem = rawIronFuelAdmission(state({ rawIron: 3, ironIngots: 2, planks: 7, fuel: 0 }));
  assert.equal(oneItem.batchSize, 1);
  assert.equal(oneItem.woodFuelRequired, 1);
  assert.equal(oneItem.sourceClass, 'planks');

  const afterPickaxe = rawIronFuelAdmission(state({ rawIron: 3, ironIngots: 2, ironPickaxes: 1, planks: 7, fuel: 0 }));
  assert.equal(afterPickaxe.batchSize, 3);
  assert.equal(afterPickaxe.inventoryAdmitted, false);
  assert.equal(rawIronFuelAdmission(state({ rawIron: 3, logs: 2, fuel: 0 })).sourceClass, 'logs');
  assert.equal(rawIronFuelAdmission(state({ rawIron: 3, fuel: 1 })).sourceClass, 'efficient');
  assert.equal(rawIronFuelAdmission({ inventoryRawIronCount: 3, inventoryCoalCount: 1 }).sourceClass, 'efficient');
  assert.equal(rawIronFuelAdmission({ inventoryRawIronCount: 3, inventoryCharcoalCount: 1 }).sourceClass, 'efficient');
});

test('raw-iron fuel fingerprint is stable and includes executor-relevant resource changes', () => {
  const base = {
    inventoryRawIronCount: 3,
    inventoryIronIngotCount: 0,
    inventoryIronPickaxeCount: 0,
    inventoryCoalCount: 0,
    inventoryCharcoalCount: 0,
    inventoryLogCount: 0,
    inventoryPlankCount: 7,
    furnaceInReach: true,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: true,
  };
  assert.equal(rawIronFuelFingerprint(base), rawIronFuelFingerprint({ ...base }));
  assert.notEqual(rawIronFuelFingerprint(base), rawIronFuelFingerprint({ ...base, inventoryPlankCount: 8 }));
  assert.notEqual(rawIronFuelFingerprint(base), rawIronFuelFingerprint({ ...base, furnaceInReach: false }));
});

test('summarizeState prefers explicit equipped armor slots over aggregate count evidence', () => {
  const contradictory = summarizeState({
    inventoryIronPickaxeCount: 1,
    equippedArmorPieces: 4,
    equippedHelmetItem: 'iron_helmet',
    equippedChestplateItem: '',
    equippedLeggingsItem: '',
    equippedBootsItem: '',
    foodLevel: 20,
  });
  assert.equal(contradictory.equippedArmorPieces, 1);
  assert.equal(missionComplete(contradictory), false);

  const complete = summarizeState({
    inventoryIronPickaxeCount: 1,
    equippedArmorPieces: 0,
    equippedHelmetItem: 'iron_helmet',
    equippedChestplateItem: 'iron_chestplate',
    equippedLeggingsItem: 'iron_leggings',
    equippedBootsItem: 'iron_boots',
    foodLevel: 20,
  });
  assert.equal(complete.equippedArmorPieces, 4);
  assert.equal(missionComplete(complete), true);
});

test('raw ClientSnapshot hunger and food fields drive the survival interrupt', () => {
  assert.equal(
    expectedObjective({
      inventoryLogCount: THRESHOLDS.woodForIronArmorMission,
      foodLevel: 4,
      hasFood: true,
    }),
    'EAT',
  );
  assert.equal(
    missionComplete({
      inventoryIronPickaxeCount: 1,
      equippedHelmetItem: 'iron_helmet',
      equippedChestplateItem: 'iron_chestplate',
      equippedLeggingsItem: 'iron_leggings',
      equippedBootsItem: 'iron_boots',
      foodLevel: 4,
      hasFood: true,
    }),
    false,
  );
});

test('summarizeState derives iron depth from y when no flag is given', () => {
  assert.equal(summarizeState({ y: 10 }).atIronDepth, true);
  assert.equal(summarizeState({ y: 70 }).atIronDepth, false);
  // explicit flag wins
  assert.equal(summarizeState({ y: 70, atIronDepth: true }).atIronDepth, true);
});

test('summarizeState derives conservative diamond depth from y when no flag is given', () => {
  assert.equal(summarizeState({ y: -50 }).atDiamondDepth, true);
  assert.equal(summarizeState({ y: -49 }).atDiamondDepth, false);
  // explicit flag wins
  assert.equal(summarizeState({ y: 70, atDiamondDepth: true }).atDiamondDepth, true);
});

test('plannerStateView exposes decision-relevant fields as booleans and counts', () => {
  const view = plannerStateView(state({ woodenPickaxes: 1, ironIngots: 4, diamonds: 2, diamondPickaxes: 1, equippedArmorPieces: 2, targetDiamondTier: true, targetIronPickaxeOnly: true, atDiamondDepth: true }));
  assert.equal(view.hasWoodenPickaxe, true);
  assert.equal(view.hasStonePickaxe, false);
  assert.equal(view.stonePickaxes, 0);
  assert.equal(view.bestStonePickaxeRemaining, -1);
  assert.equal(view.ironIngots, 4);
  assert.equal(view.ironPickaxes, 0);
  assert.equal(view.diamonds, 2);
  assert.equal(view.hasDiamondPickaxe, true);
  assert.equal(view.diamondPickaxes, 1);
  assert.equal(view.spareIronArmorPieces, 0);
  assert.equal(view.equippedIronArmorPieces, 2);
  assert.equal(view.targetDiamondTier, true);
  assert.equal(view.targetIronPickaxeOnly, true);
  assert.equal(view.atDiamondDepth, true);
});

// ---- prompt ----------------------------------------------------------------

test('buildPlannerPrompt includes goal, catalog, JSON instruction, state, and recovery context', () => {
  const msgs = buildPlannerPrompt(state({ logs: 5 }), {
    currentObjective: 'MAKE_STONE_TOOLS',
    lastOutcome: 'failed:insufficient_cobblestone',
  });
  assert.equal(msgs.length, 2);
  const sys = msgs[0].content;
  const user = msgs[1].content;
  assert.match(sys, /GOAL:/);
  for (const id of OBJECTIVE_IDS) assert.ok(sys.includes(id), `catalog missing ${id}`);
  assert.match(sys, /JSON/);
  assert.match(user, /MAKE_STONE_TOOLS/);
  assert.match(user, /insufficient_cobblestone/);
  assert.match(user, /"logs":5/);
});

// ---- parsing ---------------------------------------------------------------

test('parsePlannerReply parses clean, fenced, and embedded JSON', () => {
  assert.deepEqual(
    parsePlannerReply('{"objective":"MINE_IRON","done":false,"reason":"r"}'),
    { ok: true, objective: 'MINE_IRON', done: false, reason: 'r' },
  );
  assert.equal(parsePlannerReply('```json\n{"objective":"EAT","done":false}\n```').objective, 'EAT');
  assert.equal(parsePlannerReply('Sure! {"objective":"DESCEND","done":false} done.').objective, 'DESCEND');
  assert.equal(parsePlannerReply('{"objective":"descend"}').objective, 'DESCEND'); // case-normalized
});

test('parsePlannerReply enforces bounded authority and coerces done', () => {
  assert.equal(parsePlannerReply('{"objective":"FLY_TO_MOON"}').ok, false);
  assert.equal(parsePlannerReply('{"objective":"FLY_TO_MOON"}').error, 'objective_not_in_catalog');
  assert.equal(parsePlannerReply('not json at all').ok, false);
  assert.equal(parsePlannerReply('{"objective":"DONE"}').done, true); // DONE implies done
  assert.equal(parsePlannerReply('{"objective":"EAT","done":"yes"}').done, false); // only strict true
});

// ---- objective model -------------------------------------------------------

test('objective model exposes preconditions and effects for each catalog id', () => {
  for (const id of OBJECTIVE_IDS) {
    assert.ok(OBJECTIVE_MODEL[id], `missing objective model for ${id}`);
    assert.ok(Array.isArray(objectiveEffects(id)), `missing effects for ${id}`);
  }
  assert.equal(objectivePreconditionsMet('MINE_IRON', state({ stonePickaxes: 1, atIronDepth: true })), true);
  assert.deepEqual(objectivePreconditionStatus('MINE_IRON', state({ stonePickaxes: 1, atIronDepth: false })).missing, ['iron_depth']);
  assert.equal(objectivePreconditionsMet('MAKE_ARMOR', state({ ironHelmets: 1, equippedArmorPieces: 0 })), true);
  assert.equal(
    objectivePreconditionsMet('MAKE_ARMOR', state({ ironHelmets: 1, equippedArmorPieces: 1, equippedHelmetItem: 'iron_helmet' })),
    false,
  );
  assert.deepEqual(
    objectivePreconditionStatus('MAKE_FURNACE', state({ stonePickaxes: 1, stoneSwords: 1, cobblestone: 8, tablePlaced: false, logs: 0, planks: 1 })).missing,
    ['crafting_table_or_wood'],
  );
  assert.equal(
    objectivePreconditionsMet('MAKE_FURNACE', state({ stonePickaxes: 1, stoneSwords: 1, cobblestone: 8, logs: 1 })),
    true,
  );
  assert.deepEqual(
    objectivePreconditionStatus('MAKE_IRON_TOOLS', state({ ironIngots: 3, sticks: 0, logs: 0, planks: 0, tablePlaced: true })).missing,
    ['sticks_or_wood'],
  );
  assert.equal(
    objectivePreconditionsMet('MAKE_IRON_TOOLS', state({ ironIngots: 3, sticks: 0, logs: 1, planks: 0, tablePlaced: true })),
    true,
  );
});

// ---- chooseNextObjective (mock model) -------------------------------------

test('chooseNextObjective defaults to oracle-primary and does not call the LLM on spine states', async () => {
  let calls = 0;
  const res = await chooseNextObjective(state({ logs: THRESHOLDS.woodForIronArmorMission }), {
    complete: async () => {
      calls += 1;
      return jsonReply('MINE_IRON');
    },
  });
  assert.equal(res.objective, 'MAKE_WOOD_TOOLS');
  assert.equal(res.source, 'oracle');
  assert.equal(res.done, false);
  assert.equal(calls, 0);
  assert.equal(shouldConsultPlanner(state({ logs: THRESHOLDS.woodForIronArmorMission })), false);
});

test('chooseNextObjective with forceLlm passes through a valid guarded LLM choice', async () => {
  const res = await chooseNextObjective(state({ logs: THRESHOLDS.woodForIronArmorMission }), { complete: mockComplete(jsonReply('MAKE_WOOD_TOOLS')), forceLlm: true });
  assert.equal(res.objective, 'MAKE_WOOD_TOOLS');
  assert.equal(res.source, 'llm');
  assert.equal(res.done, false);
});

test('chooseNextObjective: forced LLM that matches the oracle walks the whole spine correctly', async () => {
  for (const { label, s, expected } of SPINE) {
    const res = await chooseNextObjective(s, {
      complete: mockComplete(jsonReply(expected, expected === 'DONE')),
      forceLlm: true,
    });
    assert.equal(res.objective, expected, `spine step failed: ${label}`);
    assert.equal(res.source, 'llm');
  }
});

test('chooseNextObjective falls back to the oracle on an out-of-catalog objective', async () => {
  const res = await chooseNextObjective(state({}), { complete: mockComplete('{"objective":"DELETE_WORLD"}'), forceLlm: true });
  assert.equal(res.source, 'fallback');
  assert.equal(res.objective, 'GATHER_WOOD'); // oracle pick for empty inventory
  assert.ok(OBJECTIVE_IDS.includes(res.objective));
});

test('chooseNextObjective falls back on malformed output and on model errors', async () => {
  const malformed = await chooseNextObjective(state({ logs: THRESHOLDS.woodForIronArmorMission }), { complete: mockComplete('I think gather wood'), forceLlm: true });
  assert.equal(malformed.source, 'fallback');
  assert.equal(malformed.objective, 'MAKE_WOOD_TOOLS');

  const errored = await chooseNextObjective(state({}), {
    complete: async () => { throw new Error('boom'); },
    forceLlm: true,
  });
  assert.equal(errored.source, 'fallback');
  assert.equal(errored.objective, 'GATHER_WOOD');
  assert.ok(errored.error);
});

test('chooseNextObjective never emits an out-of-catalog action (bounded authority property)', async () => {
  const junkReplies = ['{}', '{"objective":123}', '{"objective":"hack"}', 'null', '"GATHER_WOOD"', '{"objective":""}'];
  for (const reply of junkReplies) {
    const res = await chooseNextObjective(state({ woodenPickaxes: 1, cobblestone: 6 }), { complete: mockComplete(reply), forceLlm: true });
    assert.ok(isObjectiveId(res.objective), `emitted non-catalog objective for reply ${reply}: ${res.objective}`);
  }
});

test('chooseNextObjective rejects model DONE until missionComplete is true', async () => {
  const res = await chooseNextObjective(state({}), { complete: mockComplete(jsonReply('DONE', true, 'done')), forceLlm: true });
  assert.equal(res.source, 'oracle_guard');
  assert.equal(res.objective, 'GATHER_WOOD');
  assert.equal(res.done, false);
  assert.equal(res.error, 'model_done_before_goal');
});

test('chooseNextObjective accepts a sane recovery choice after a failed objective', async () => {
  // MAKE_STONE_TOOLS failed for lack of cobble; oracle + a good LLM both pick MINE_STONE.
  const failedState = state({ woodenPickaxes: 1, cobblestone: 1 });
  assert.equal(expectedObjective(failedState), 'MINE_STONE');
  const res = await chooseNextObjective(failedState, {
    complete: mockComplete(jsonReply('MINE_STONE', false, 'need cobble')),
    forceLlm: true,
    currentObjective: 'MAKE_STONE_TOOLS',
    lastOutcome: 'failed:insufficient_cobblestone',
  });
  assert.equal(res.objective, 'MINE_STONE');
  assert.equal(res.source, 'llm');
});

// ---- grading ---------------------------------------------------------------

test('gradeChoice marks oracle-matching choices correct and others wrong', () => {
  assert.equal(gradeChoice(state({}), 'GATHER_WOOD').correct, true);
  assert.equal(gradeChoice(state({}), 'MINE_IRON').correct, false);
  assert.equal(gradeChoice(state({ foodLevel: 3, hasFood: true }), 'EAT').correct, true);
});

test('acceptableObjectives tolerates either remaining gear craft once ingots are on hand', () => {
  const s = state({ stonePickaxes: 1, furnaces: 1, atIronDepth: true, ironPickaxes: 1, ironIngots: 24, equippedArmorPieces: 0, tablePlaced: true });
  const acc = acceptableObjectives(s);
  assert.ok(acc.has('MAKE_ARMOR'));
});

test('diamond-tier oracle descends deeper after iron pickaxe without changing default armor goal', () => {
  const ready = state({ atIronDepth: true, furnaces: 1, ironPickaxes: 1, ironIngots: 24, sticks: 2, equippedArmorPieces: 0, tablePlaced: true });
  assert.equal(expectedObjective(ready), 'MAKE_ARMOR');
  assert.equal(expectedObjective({ ...ready, targetDiamondTier: true, atDiamondDepth: false }), 'MAKE_IRON_TOOLS');
  assert.equal(expectedObjective({ ...ready, targetDiamondTier: true, ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent, atDiamondDepth: false }), 'DESCEND_DEEP');
  assert.equal(expectedObjective({ ...ready, targetDiamondTier: true, atDiamondDepth: true, diamonds: 0 }), 'MINE_DIAMOND');
  assert.equal(expectedObjective({ ...ready, targetDiamondTier: true, atDiamondDepth: true, diamonds: THRESHOLDS.diamondsForPickaxe }), 'MAKE_DIAMOND_TOOLS');
  assert.equal(expectedObjective({ ...ready, targetDiamondTier: true, atDiamondDepth: true, diamondPickaxes: THRESHOLDS.diamondPickaxesForProgress }), 'DONE');
});

// ---- objectiveAchieved -----------------------------------------------------

test('objectiveAchieved checks each objective postcondition', () => {
  assert.equal(objectiveAchieved('GATHER_WOOD', state({ logs: THRESHOLDS.woodForIronArmorMission })), true);
  assert.equal(objectiveAchieved('MAKE_WOOD_TOOLS', state({ woodenPickaxes: 1 })), true);
  assert.equal(objectiveAchieved('MINE_STONE', state({ woodenPickaxes: 1, cobblestone: THRESHOLDS.cobbleForStoneTools - 1 })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ woodenPickaxes: 1, cobblestone: THRESHOLDS.cobbleForStoneTools })), true);
  assert.equal(objectiveAchieved('MINE_STONE', state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 2 })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 3 })), true);
  assert.equal(objectiveAchieved('MAKE_STONE_TOOLS', state({ targetIronPickaxeOnly: true, stonePickaxes: 1, stoneSwords: 0 })), true);
  assert.equal(objectiveAchieved('MAKE_STONE_TOOLS', state({ stonePickaxes: 1, stoneSwords: 0 })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: THRESHOLDS.cobbleForFurnace + THRESHOLDS.miningFieldKitCobblestone - 1 })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: THRESHOLDS.cobbleForFurnace + THRESHOLDS.miningFieldKitCobblestone })), true);
  assert.equal(objectiveAchieved('MAKE_FURNACE', state({ furnaces: 1 })), true);
  assert.equal(objectiveAchieved('DESCEND', state({ atIronDepth: true })), true);
  assert.equal(objectiveAchieved('DESCEND_DEEP', state({ atDiamondDepth: true })), true);
  assert.equal(objectiveAchieved('MINE_IRON', state({ atIronDepth: true, stonePickaxes: 1, ironIngots: 1 })), false);
  assert.equal(objectiveAchieved('MINE_IRON', state({ atIronDepth: true, stonePickaxes: 1, rawIron: 1 })), false);
  assert.equal(objectiveAchieved('MINE_IRON', state({ atIronDepth: true, stonePickaxes: 1, rawIron: THRESHOLDS.ingotsForIronPickaxe })), true);
  assert.equal(objectiveAchieved('MINE_IRON', state({ atIronDepth: true, stonePickaxes: 1, ironIngots: THRESHOLDS.ingotsForIronPickaxe })), true);
  assert.equal(objectiveAchieved('SMELT_IRON', state({ atIronDepth: true, stonePickaxes: 1, rawIron: 4, ironIngots: 1 })), false);
  assert.equal(objectiveAchieved('SMELT_IRON', state({ atIronDepth: true, stonePickaxes: 1, rawIron: 4, ironIngots: THRESHOLDS.ingotsForIronPickaxe })), true);
  assert.equal(objectiveAchieved('SMELT_IRON', state({ atIronDepth: true, stonePickaxes: 1, rawIron: 0, ironIngots: 1 })), false);
  assert.equal(objectiveAchieved('MINE_DIAMOND', state({ diamonds: THRESHOLDS.diamondsForPickaxe })), true);
  assert.equal(objectiveAchieved('MAKE_DIAMOND_TOOLS', state({ diamondPickaxes: THRESHOLDS.diamondPickaxesForProgress })), true);
  assert.equal(objectiveAchieved('MAKE_IRON_TOOLS', state({ targetDiamondTier: true, atDiamondDepth: false, ironPickaxes: 1 })), false);
  assert.equal(objectiveAchieved('MAKE_IRON_TOOLS', state({ targetDiamondTier: true, atDiamondDepth: false, ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent })), true);
  assert.equal(objectiveAchieved('MAKE_ARMOR', state({ equippedArmorPieces: 4 })), true);
  assert.equal(objectiveAchieved('MAKE_ARMOR', state({ equippedArmorPieces: 3 })), false);
  assert.equal(objectiveAchieved('EAT', state({ foodLevel: 18 })), true);
});
