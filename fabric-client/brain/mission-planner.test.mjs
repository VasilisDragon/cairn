import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBJECTIVE_IDS,
  THRESHOLDS,
  acceptableObjectives,
  buildPlannerPrompt,
  chooseNextObjective,
  expectedObjective,
  gradeChoice,
  isObjectiveId,
  missionComplete,
  objectiveAchieved,
  parsePlannerReply,
  plannerStateView,
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
  { label: 'have logs, no tools', s: state({ logs: 5 }), expected: 'MAKE_WOOD_TOOLS' },
  { label: 'wooden pickaxe, no cobble', s: state({ woodenPickaxes: 1, logs: 2 }), expected: 'MINE_STONE' },
  { label: 'have cobble, no stone tools', s: state({ woodenPickaxes: 1, cobblestone: 6 }), expected: 'MAKE_STONE_TOOLS' },
  { label: 'stone tools, low cobble for furnace', s: state({ woodenPickaxes: 1, stonePickaxes: 1, stoneSwords: 1, cobblestone: 3 }), expected: 'MINE_STONE' },
  { label: 'stone tools, enough cobble, no furnace', s: state({ woodenPickaxes: 1, stonePickaxes: 1, stoneSwords: 1, cobblestone: 10 }), expected: 'MAKE_FURNACE' },
  { label: 'geared on surface, must descend', s: state({ woodenPickaxes: 1, stonePickaxes: 1, stoneSwords: 1, furnaces: 1, atIronDepth: false, y: 70 }), expected: 'DESCEND' },
  { label: 'at depth, no iron, cannot smelt', s: state({ stonePickaxes: 1, stoneSwords: 1, furnaces: 1, atIronDepth: true }), expected: 'MINE_IRON' },
  { label: 'raw iron + furnace + fuel', s: state({ stonePickaxes: 1, stoneSwords: 1, furnaces: 1, atIronDepth: true, rawIron: 6, fuel: 5 }), expected: 'SMELT_IRON' },
  { label: 'ingots, no iron pickaxe', s: state({ stonePickaxes: 1, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 10 }), expected: 'MAKE_IRON_TOOLS' },
  { label: 'iron pickaxe, ingots, no armor', s: state({ stonePickaxes: 1, furnaces: 1, atIronDepth: true, ironPickaxes: 1, ironIngots: 24, equippedArmorPieces: 0 }), expected: 'MAKE_ARMOR' },
  { label: 'fully geared and fed', s: state({ ironPickaxes: 1, equippedArmorPieces: 4, foodLevel: 20 }), expected: 'DONE' },
];

// ---- oracle ----------------------------------------------------------------

test('oracle returns the canonical next objective along the early-game spine', () => {
  for (const { label, s, expected } of SPINE) {
    assert.equal(expectedObjective(s), expected, `oracle mismatch for: ${label}`);
  }
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
    expectedObjective(state({ stonePickaxes: 1, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 1 })),
    'MINE_IRON',
  );
  // Same but raw iron + fuel on hand -> smelt.
  assert.equal(
    expectedObjective(state({ stonePickaxes: 1, stoneSwords: 1, furnaces: 1, atIronDepth: true, ironIngots: 1, rawIron: 4, fuel: 2 })),
    'SMELT_IRON',
  );
});

test('missionComplete requires iron pickaxe, full armor, and not hungry', () => {
  assert.equal(missionComplete(state({ ironPickaxes: 1, equippedArmorPieces: 4, foodLevel: 20 })), true);
  assert.equal(missionComplete(state({ ironPickaxes: 1, equippedArmorPieces: 3, foodLevel: 20 })), false);
  assert.equal(missionComplete(state({ ironPickaxes: 0, equippedArmorPieces: 4, foodLevel: 20 })), false);
  assert.equal(missionComplete(state({ ironPickaxes: 1, equippedArmorPieces: 4, foodLevel: 4 })), false);
});

// ---- state normalization ---------------------------------------------------

test('summarizeState accepts raw ClientSnapshot field names', () => {
  const s = summarizeState({
    inventoryLogCount: 7,
    inventoryCoalCount: 2,
    inventoryCharcoalCount: 1,
    equippedHelmetItem: 'iron_helmet',
    equippedChestplateItem: 'iron_chestplate',
    equippedLeggingsItem: 'iron_leggings',
    equippedBootsItem: 'iron_boots',
  });
  assert.equal(s.logs, 7);
  assert.equal(s.fuel, 3);
  assert.equal(s.equippedArmorPieces, 4);
});

test('summarizeState derives iron depth from y when no flag is given', () => {
  assert.equal(summarizeState({ y: 10 }).atIronDepth, true);
  assert.equal(summarizeState({ y: 70 }).atIronDepth, false);
  // explicit flag wins
  assert.equal(summarizeState({ y: 70, atIronDepth: true }).atIronDepth, true);
});

test('plannerStateView exposes decision-relevant fields as booleans', () => {
  const view = plannerStateView(state({ woodenPickaxes: 1, ironIngots: 4, equippedArmorPieces: 2 }));
  assert.equal(view.hasWoodenPickaxe, true);
  assert.equal(view.hasStonePickaxe, false);
  assert.equal(view.ironIngots, 4);
  assert.equal(view.equippedIronArmorPieces, 2);
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

// ---- chooseNextObjective (mock model) -------------------------------------

test('chooseNextObjective passes through a valid in-catalog LLM choice', async () => {
  const res = await chooseNextObjective(state({ logs: 5 }), { complete: mockComplete(jsonReply('MAKE_WOOD_TOOLS')) });
  assert.equal(res.objective, 'MAKE_WOOD_TOOLS');
  assert.equal(res.source, 'llm');
  assert.equal(res.done, false);
});

test('chooseNextObjective: an LLM that matches the oracle walks the whole spine correctly', async () => {
  for (const { label, s, expected } of SPINE) {
    const res = await chooseNextObjective(s, {
      complete: mockComplete(jsonReply(expected, expected === 'DONE')),
    });
    assert.equal(res.objective, expected, `spine step failed: ${label}`);
    assert.equal(res.source, 'llm');
  }
});

test('chooseNextObjective falls back to the oracle on an out-of-catalog objective', async () => {
  const res = await chooseNextObjective(state({}), { complete: mockComplete('{"objective":"DELETE_WORLD"}') });
  assert.equal(res.source, 'fallback');
  assert.equal(res.objective, 'GATHER_WOOD'); // oracle pick for empty inventory
  assert.ok(OBJECTIVE_IDS.includes(res.objective));
});

test('chooseNextObjective falls back on malformed output and on model errors', async () => {
  const malformed = await chooseNextObjective(state({ logs: 5 }), { complete: mockComplete('I think gather wood') });
  assert.equal(malformed.source, 'fallback');
  assert.equal(malformed.objective, 'MAKE_WOOD_TOOLS');

  const errored = await chooseNextObjective(state({}), {
    complete: async () => { throw new Error('boom'); },
  });
  assert.equal(errored.source, 'fallback');
  assert.equal(errored.objective, 'GATHER_WOOD');
  assert.ok(errored.error);
});

test('chooseNextObjective never emits an out-of-catalog action (bounded authority property)', async () => {
  const junkReplies = ['{}', '{"objective":123}', '{"objective":"hack"}', 'null', '"GATHER_WOOD"', '{"objective":""}'];
  for (const reply of junkReplies) {
    const res = await chooseNextObjective(state({ woodenPickaxes: 1, cobblestone: 6 }), { complete: mockComplete(reply) });
    assert.ok(isObjectiveId(res.objective), `emitted non-catalog objective for reply ${reply}: ${res.objective}`);
  }
});

test('chooseNextObjective accepts a sane recovery choice after a failed objective', async () => {
  // MAKE_STONE_TOOLS failed for lack of cobble; oracle + a good LLM both pick MINE_STONE.
  const failedState = state({ woodenPickaxes: 1, cobblestone: 1 });
  assert.equal(expectedObjective(failedState), 'MINE_STONE');
  const res = await chooseNextObjective(failedState, {
    complete: mockComplete(jsonReply('MINE_STONE', false, 'need cobble')),
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
  const s = state({ stonePickaxes: 1, furnaces: 1, atIronDepth: true, ironPickaxes: 1, ironIngots: 24, equippedArmorPieces: 0 });
  const acc = acceptableObjectives(s);
  assert.ok(acc.has('MAKE_ARMOR'));
});

// ---- objectiveAchieved -----------------------------------------------------

test('objectiveAchieved checks each objective postcondition', () => {
  assert.equal(objectiveAchieved('GATHER_WOOD', state({ logs: THRESHOLDS.woodForTools })), true);
  assert.equal(objectiveAchieved('MAKE_WOOD_TOOLS', state({ woodenPickaxes: 1 })), true);
  assert.equal(objectiveAchieved('MAKE_FURNACE', state({ furnaces: 1 })), true);
  assert.equal(objectiveAchieved('DESCEND', state({ atIronDepth: true })), true);
  assert.equal(objectiveAchieved('MAKE_ARMOR', state({ equippedArmorPieces: 4 })), true);
  assert.equal(objectiveAchieved('MAKE_ARMOR', state({ equippedArmorPieces: 3 })), false);
  assert.equal(objectiveAchieved('EAT', state({ foodLevel: 18 })), true);
});
