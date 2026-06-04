import assert from 'node:assert/strict';
import test from 'node:test';

import { expectedObjective } from './mission-planner.js';
import { MissionOrchestrator, nextActionForObjective } from './mission-orchestrator.js';
import { createInitialState, runMissionInSim } from './mission-sim.js';

// A faithful "perfect planner" mock: parse the compact state the orchestrator put in the prompt,
// reconstruct a planner-state, and return the deterministic oracle's choice. Exercises the real
// prompt/encode/parse path while standing in for the LLM at $0.
function oracleBrain() {
  return async (messages) => {
    const user = messages.find((m) => m.role === 'user').content;
    const view = JSON.parse(user.match(/State: (\{.*\})/)[1]);
    const raw = {
      logs: view.logs,
      planks: view.planks,
      sticks: view.sticks,
      woodenPickaxes: view.hasWoodenPickaxe ? 1 : 0,
      cobblestone: view.cobblestone,
      stonePickaxes: view.hasStonePickaxe ? 1 : 0,
      stoneSwords: view.hasStoneSword ? 1 : 0,
      furnaces: view.hasFurnace ? 1 : 0,
      fuel: view.fuel,
      rawIron: view.rawIron,
      ironIngots: view.ironIngots,
      ironPickaxes: view.hasIronPickaxe ? 1 : 0,
      equippedArmorPieces: view.equippedIronArmorPieces,
      foodLevel: view.foodLevel,
      hasFood: view.hasFood,
      atIronDepth: view.atIronDepth,
    };
    const objective = expectedObjective(raw);
    return JSON.stringify({ objective, done: objective === 'DONE', reason: 'oracle' });
  };
}

function firstSeen(trace) {
  const seen = [];
  for (const o of trace) if (!seen.includes(o)) seen.push(o);
  return seen;
}

// ---- sub-executor ----------------------------------------------------------

test('nextActionForObjective maps objectives to valid low-level action ids', () => {
  assert.equal(nextActionForObjective('GATHER_WOOD', createInitialState()), 'gather_log');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ logs: 4 })), 'craft_planks');
  assert.equal(nextActionForObjective('MINE_STONE', createInitialState({ woodenPickaxes: 1 })), 'mine_stone');
  assert.equal(nextActionForObjective('DESCEND', createInitialState({ stonePickaxes: 1 })), 'descend_staircase');
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ stonePickaxes: 1, atIronDepth: true })), 'mine_nearby_iron');
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({ ironIngots: 5, sticks: 4, tablePlaced: true })), 'craft_iron_pickaxe');
  assert.equal(nextActionForObjective('MAKE_ARMOR', createInitialState({ ironIngots: 10, tablePlaced: true })), 'craft_iron_helmet');
  assert.equal(nextActionForObjective('DONE', createInitialState()), null);
});

test('nextActionForObjective returns null when prerequisites are missing (drives a re-plan)', () => {
  // wants iron but not at depth
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ stonePickaxes: 1, atIronDepth: false })), null);
  // wants stone tools but no cobblestone
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ tablePlaced: true, sticks: 4, cobblestone: 0 })), null);
});

test('MAKE_ARMOR crafts the actually-missing slot, not by equipped count (out-of-order armor)', () => {
  // Boots already worn (count=1) but helmet/chest/legs missing — by count this would wrongly pick
  // chestplate; by empty slot it must pick the first gap (helmet).
  const bootsOnly = createInitialState({ ironIngots: 30, tablePlaced: true, equippedArmorPieces: 1, equippedBootsItem: 'iron_boots' });
  assert.equal(nextActionForObjective('MAKE_ARMOR', bootsOnly), 'craft_iron_helmet');
  // Only boots missing -> pick boots (not whatever order[3] happens to be).
  const bootsMissing = createInitialState({
    ironIngots: 30, tablePlaced: true, equippedArmorPieces: 3,
    equippedHelmetItem: 'iron_helmet', equippedChestplateItem: 'iron_chestplate', equippedLeggingsItem: 'iron_leggings',
  });
  assert.equal(nextActionForObjective('MAKE_ARMOR', bootsMissing), 'craft_iron_boots');
});

test('iron objectives obtain a table / furnace at depth instead of blocking (no trip back up)', () => {
  // MAKE_IRON_TOOLS: ingots+sticks but no table in reach, carrying a table item -> place it here
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({ ironIngots: 5, sticks: 4, craftingTables: 1, tablePlaced: false })), 'place_table');
  // no table item but planks on hand -> craft a table right here
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({ ironIngots: 5, sticks: 4, planks: 8, craftingTables: 0, tablePlaced: false })), 'craft_table');
  // no table, no planks, but logs -> make planks first (still no trip up)
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({ ironIngots: 5, sticks: 4, planks: 0, logs: 4, craftingTables: 0, tablePlaced: false })), 'craft_planks');
  // table in reach -> craft the iron pickaxe
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({ ironIngots: 5, sticks: 4, tablePlaced: true })), 'craft_iron_pickaxe');
  // SMELT_IRON: no furnace block, carrying a furnace item -> place it at depth
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({ furnaces: 1, furnacePlaced: false })), 'place_furnace');
  // SMELT_IRON: no furnace at all, but table + cobble -> craft one at depth
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({ furnaces: 0, furnacePlaced: false, tablePlaced: true, cobblestone: 8 })), 'craft_furnace');
  // SMELT_IRON: furnace placed + fuel + raw iron -> smelt
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({ furnacePlaced: true, fuel: 4, rawIron: 4 })), 'smelt_raw_iron');
  // MAKE_ARMOR: ingots but no table in reach -> get a table first
  assert.equal(nextActionForObjective('MAKE_ARMOR', createInitialState({ ironIngots: 10, planks: 8, tablePlaced: false })), 'craft_table');
});

// ---- full closed loop (mock = perfect planner) -----------------------------

test('full mission: a perfect planner drives the sim to DONE (iron pickaxe + full armor + fed)', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  assert.equal(res.done, true, `mission did not complete in ${res.steps} steps`);
  assert.ok(res.state.ironPickaxes >= 1, 'no iron pickaxe');
  assert.ok(res.state.equippedArmorPieces >= 4, 'armor not complete');
  const seen = firstSeen(res.objectiveTrace);
  for (const o of ['GATHER_WOOD', 'MAKE_WOOD_TOOLS', 'MINE_STONE', 'MAKE_STONE_TOOLS', 'MAKE_FURNACE', 'DESCEND', 'MINE_IRON', 'SMELT_IRON', 'MAKE_IRON_TOOLS', 'MAKE_ARMOR']) {
    assert.ok(seen.includes(o), `objective ${o} was never chosen`);
  }
  assert.ok(res.signals.some((s) => s.evt === 'mission.done'), 'no mission.done signal');
});

test('the LLM is consulted only on objective transitions, not every step', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  assert.ok(res.llmCalls < res.steps, `llmCalls ${res.llmCalls} should be < steps ${res.steps}`);
  assert.ok(res.llmCalls <= 45, `llmCalls ${res.llmCalls} unexpectedly high (should be ~one per transition)`);
});

test('the closed loop reaches stone tools (PRIMARY in-world milestone, proven in sim)', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, { maxSteps: 80 });
  assert.ok(res.state.stonePickaxes >= 1, 'did not reach a stone pickaxe');
  const completes = res.signals.filter((s) => s.evt === 'mission.objective.complete').map((s) => s.objective);
  for (const o of ['GATHER_WOOD', 'MAKE_WOOD_TOOLS', 'MINE_STONE', 'MAKE_STONE_TOOLS']) {
    assert.ok(completes.includes(o), `objective ${o} never completed`);
  }
});

// ---- recovery (the real de-risk) -------------------------------------------

test('recovery: a mid-mission material shortfall triggers block -> replan -> re-acquire -> recover', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, {
    maxSteps: 160,
    // The instant MAKE_STONE_TOOLS is active with cobble in hand, yank the cobble away once.
    mutate: (state) => {
      if (orch.state.currentObjective === 'MAKE_STONE_TOOLS' && state.cobblestone >= 3 && state.stonePickaxes < 1) {
        return { ...state, cobblestone: 0 };
      }
      return undefined;
    },
  });
  assert.ok(res.mutated, 'the injected shortfall never fired');
  const evts = res.signals.map((s) => s.evt);
  assert.ok(evts.includes('mission.objective.blocked') || evts.includes('mission.objective.failed'), 'no block/failure detected after shortfall');
  assert.ok(res.signals.some((s) => s.evt === 'mission.replan'), 'no mission.replan after the shortfall');
  assert.ok(res.signals.some((s) => s.evt === 'mission.replan' && s.to === 'MINE_STONE'), 'did not re-plan to re-acquire cobblestone');
  assert.ok(res.state.stonePickaxes >= 1, 'did not recover to a stone pickaxe');
});

// ---- stall backstop --------------------------------------------------------

test('stall backstop: no progress for stallTimeoutMs marks the objective failed (time-based)', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 8000, abortTimeoutMs: 60000 });
  const stuck = createInitialState({ logs: 0 }); // GATHER_WOOD chosen; we never apply the action
  let failed = false;
  for (let i = 0; i < 6; i += 1) {
    const out = await orch.step(stuck);
    if (out.signals.some((s) => s.evt === 'mission.objective.failed')) failed = true;
    t += 3000; // 3s elapse per poll; a 1.5s craft would never reach the 8s window
  }
  assert.ok(failed, 'expected a time-based stall to raise mission.objective.failed');
});

test('global watchdog aborts a frozen (no-progress) mission instead of looping forever (time-based)', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 4000, abortTimeoutMs: 12000 });
  const frozen = createInitialState({ logs: 0 }); // GATHER_WOOD chosen; we never apply the action
  let aborted = false;
  let ended = false;
  for (let i = 0; i < 12; i += 1) {
    const out = await orch.step(frozen);
    if (out.signals.some((s) => s.evt === 'mission.aborted')) aborted = true;
    if (out.done) { ended = true; break; }
    t += 3000;
  }
  assert.ok(aborted, 'expected mission.aborted on a frozen world');
  assert.ok(ended, 'expected the mission to end (done) after abort');
});

// ---- bounded authority / robustness to a broken brain ----------------------

test('a junk (non-JSON) brain still completes the mission via deterministic oracle fallback', async () => {
  const junkBrain = async () => 'sorry, I am not going to answer in JSON';
  const orch = new MissionOrchestrator({ complete: junkBrain });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  assert.equal(res.done, true, 'mission did not complete under a junk brain');
  const chosen = res.signals.filter((s) => s.evt === 'mission.objective.chosen');
  assert.ok(chosen.length > 0 && chosen.every((s) => s.source === 'fallback'), 'expected every choice to come from oracle fallback');
});
