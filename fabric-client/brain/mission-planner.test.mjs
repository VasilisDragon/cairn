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
  isObjectiveId,
  missionComplete,
  objectiveEffects,
  objectivePreconditionStatus,
  objectivePreconditionsMet,
  objectiveAchieved,
  parsePlannerReply,
  plannerStateView,
  shouldConsultPlanner,
  summarizeState,
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
  { label: 'have full surface cobble reserve, no stone tools', s: state({ woodenPickaxes: 1, cobblestone: 16, sticks: 8, tablePlaced: true }), expected: 'MAKE_STONE_TOOLS' },
  { label: 'stone tools, low cobble for furnace', s: state({ woodenPickaxes: 1, stonePickaxes: 2, stoneSwords: 1, cobblestone: 3 }), expected: 'MINE_STONE' },
  { label: 'stone tools, enough cobble, no furnace', s: state({ woodenPickaxes: 1, stonePickaxes: 2, stoneSwords: 1, cobblestone: 10, tablePlaced: true }), expected: 'MAKE_FURNACE' },
  { label: 'geared on surface, must descend', s: state({ woodenPickaxes: 1, stonePickaxes: 2, stoneSwords: 1, furnaces: 1, craftingTables: 1, atIronDepth: false, y: 70 }), expected: 'DESCEND' },
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

test('oracle reserves furnace cobble before crafting stone tools', () => {
  const fullArmorStoneToolCobble = (THRESHOLDS.stonePickaxesForIronArmorMission * 3) + 1;
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, cobblestone: 7, sticks: 4, tablePlaced: true })),
    'MINE_STONE',
  );
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, cobblestone: fullArmorStoneToolCobble + THRESHOLDS.cobbleForFurnace - 1, sticks: 8, tablePlaced: true })),
    'MINE_STONE',
  );
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, cobblestone: fullArmorStoneToolCobble + THRESHOLDS.cobbleForFurnace, sticks: 8, tablePlaced: true })),
    'MAKE_STONE_TOOLS',
  );
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 10, sticks: 2, tablePlaced: true })),
    'MINE_STONE',
  );
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 11, sticks: 2, tablePlaced: true })),
    'MAKE_STONE_TOOLS',
  );
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

test('oracle treats stone pickaxe as enough stone tooling for iron-pickaxe-only missions', () => {
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, stonePickaxes: 1, cobblestone: 8, tablePlaced: true })),
    'MAKE_FURNACE',
  );
  assert.equal(
    expectedObjective(state({ woodenPickaxes: 1, stonePickaxes: 1, cobblestone: (THRESHOLDS.stonePickaxesForIronArmorMission * 3) + 1 + THRESHOLDS.cobbleForFurnace, tablePlaced: true })),
    'MAKE_STONE_TOOLS',
  );
});

test('oracle refreshes weak stone pickaxes before the iron phase', () => {
  const weak = state({
    woodenPickaxes: 1,
    stonePickaxes: THRESHOLDS.stonePickaxesForIronArmorMission,
    stoneSwords: 1,
    bestStonePickaxeRemaining: THRESHOLDS.minStonePickaxeRemainingForIronPhase - 1,
    cobblestone: 3,
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
  // Fuel v2, selector layer: at depth, fuel-out with raw iron banked STAYS
  // SMELT_IRON even with zero wood — coal is minable right there and the action layer mines it. The
  // underground wood search this used to trigger is unwinnable (it killed live runs). The
  // surface fuel-out path still routes to GATHER_WOOD (pinned in mission-orchestrator.test.mjs).
  assert.equal(
    expectedObjective(state({ targetIronPickaxeOnly: true, stonePickaxes: 1, furnaces: 1, atIronDepth: true, rawIron: 3, fuel: 0, logs: 0, planks: 0 })),
    'SMELT_IRON',
  );
});

test('oracle recovers table access before table-dependent crafts', () => {
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: 8, tablePlaced: false, craftingTables: 0, logs: 0, planks: 1 })),
    'GATHER_WOOD',
  );
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: 8, logs: 1 })),
    'MAKE_FURNACE',
  );
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: false, logs: 0, planks: 0, tablePlaced: false, craftingTables: 0 })),
    'GATHER_WOOD',
  );
  assert.equal(
    expectedObjective(state({ stonePickaxes: 2, stoneSwords: 1, furnaces: 1, atIronDepth: false, logs: 0, planks: 0, tablePlaced: true, craftingTables: 0 })),
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
  assert.equal(expectedObjective(s), 'EAT');
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
  assert.equal(objectiveAchieved('MINE_STONE', state({ woodenPickaxes: 1, cobblestone: THRESHOLDS.cobbleForStoneTools })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ woodenPickaxes: 1, cobblestone: (THRESHOLDS.stonePickaxesForIronArmorMission * 3) + 1 + THRESHOLDS.cobbleForFurnace })), true);
  assert.equal(objectiveAchieved('MINE_STONE', state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 10 })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ targetIronPickaxeOnly: true, woodenPickaxes: 1, cobblestone: 11 })), true);
  assert.equal(objectiveAchieved('MAKE_STONE_TOOLS', state({ targetIronPickaxeOnly: true, stonePickaxes: 1, stoneSwords: 0 })), true);
  assert.equal(objectiveAchieved('MAKE_STONE_TOOLS', state({ stonePickaxes: 1, stoneSwords: 0 })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: THRESHOLDS.cobbleForStoneTools })), false);
  assert.equal(objectiveAchieved('MINE_STONE', state({ stonePickaxes: 2, stoneSwords: 1, cobblestone: THRESHOLDS.cobbleForFurnace })), true);
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
