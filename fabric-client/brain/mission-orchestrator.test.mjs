import assert from 'node:assert/strict';
import test from 'node:test';

import { THRESHOLDS, expectedObjective } from './mission-planner.js';
import { MissionOrchestrator, nextActionForObjective } from './mission-orchestrator.js';
import { applyAction, createInitialState, runMissionInSim } from './mission-sim.js';

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
      stonePickaxes: view.stonePickaxes ?? (view.hasStonePickaxe ? 1 : 0),
      bestStonePickaxeRemaining: view.bestStonePickaxeRemaining,
      stoneSwords: view.hasStoneSword ? 1 : 0,
      tablePlaced: view.hasTable,
      furnaces: view.hasFurnace ? 1 : 0,
      fuel: view.fuel,
      rawIron: view.rawIron,
      ironIngots: view.ironIngots,
      ironPickaxes: view.ironPickaxes ?? (view.hasIronPickaxe ? 1 : 0),
      diamonds: view.diamonds,
      diamondPickaxes: view.diamondPickaxes,
      targetDiamondTier: view.targetDiamondTier,
      targetIronPickaxeOnly: view.targetIronPickaxeOnly,
      equippedArmorPieces: view.equippedIronArmorPieces,
      foodLevel: view.foodLevel,
      hasFood: view.hasFood,
      atIronDepth: view.atIronDepth,
      atDiamondDepth: view.atDiamondDepth,
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

const WOOD_SEARCH_EXHAUSTED = 'gather_tree_complete:bounded_search_exhausted:route_attempt_limit';

function farWoodPerception({ targets = [], directions = [] } = {}) {
  return {
    loadedChunkCount: 9,
    scannedChunkCount: 9,
    resources: [{ resource: 'wood', targets, directions }],
  };
}

function woodSearchSnapshot(overrides = {}) {
  return {
    ...createInitialState({ x: 0, y: 70, z: 0 }),
    nearbyLogs: [],
    farPerception: farWoodPerception(),
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
    ...overrides,
  };
}

function exhaustedWoodSearch(snapshot, reason = WOOD_SEARCH_EXHAUSTED) {
  return {
    ...snapshot,
    currentCommandCompleted: true,
    currentCommandCompletionReason: reason,
  };
}

// ---- sub-executor ----------------------------------------------------------

test('retrieve_table gates honor the executor skip latch', () => {
  // The executor can complete retrieve_table as "skipped" (table ray-occluded; replacement
  // materials in hand). The latched flag must suppress every retrieve gate or the sequencer
  // re-demands retrieval forever (a live DESCEND abort).
  const state = createInitialState({ stonePickaxes: 1, stoneSwords: 1, tablePlaced: true, craftingTables: 0 });
  assert.equal(nextActionForObjective('DESCEND', state), 'retrieve_table');
  assert.notEqual(
    nextActionForObjective('DESCEND', state, { retrieveTableSkipped: true }),
    'retrieve_table'
  );
  const woodState = createInitialState({ woodenPickaxes: 1, tablePlaced: true, craftingTables: 0 });
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', woodState), 'retrieve_table');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', woodState, { retrieveTableSkipped: true }), null);
});

test('nextActionForObjective maps objectives to valid low-level action ids', () => {
  assert.deepEqual(nextActionForObjective('GATHER_WOOD', createInitialState()), {
    action: 'gather_tree',
    ttlMs: 45000,
  });
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ logs: 4 })), 'craft_planks');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ logs: 10, planks: 12 })), 'craft_planks');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ targetIronPickaxeOnly: true, logs: 10, planks: THRESHOLDS.planksForIronPickaxeMission - 1 })), 'craft_planks');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ targetIronPickaxeOnly: true, logs: 10, planks: THRESHOLDS.planksForIronPickaxeMission })), 'craft_sticks');
  assert.deepEqual(nextActionForObjective('MINE_STONE', createInitialState({ woodenPickaxes: 1 })), {
    action: 'mine_nearby_stone',
    ttlMs: 45000,
  });
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ stonePickaxes: 1, cobblestone: 3, sticks: 2, tablePlaced: true })), 'craft_stone_pickaxe');
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ stonePickaxes: 2, cobblestone: 2, sticks: 2, tablePlaced: true })), 'craft_stone_sword');
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({
    stonePickaxes: 2,
    bestStonePickaxeRemaining: THRESHOLDS.minStonePickaxeRemainingForIronPhase - 1,
    cobblestone: 3,
    sticks: 2,
    tablePlaced: true,
  })), 'craft_stone_pickaxe');
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ stonePickaxes: 1, cobblestone: 2, sticks: 2, tablePlaced: true, targetIronPickaxeOnly: true })), 'retrieve_table');
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ stonePickaxes: 1, cobblestone: 2, sticks: 2, tablePlaced: false, targetIronPickaxeOnly: true })), null);
  assert.deepEqual(nextActionForObjective('DESCEND', createInitialState({ stonePickaxes: 1 })), {
    action: 'descend_staircase',
    targetY: THRESHOLDS.ironDepthY,
    ttlMs: 45000,
    // sim states now carry a default position (0, 70, 0), so the heading guidance engages:
    // depth 70-16=54 along the default axis.
    targetX: 0,
    targetZ: 54,
  });
  assert.equal(nextActionForObjective('DESCEND', createInitialState({ tablePlaced: true, craftingTables: 0 })), null);
  assert.equal(nextActionForObjective('DESCEND', createInitialState({ stonePickaxes: 1, atIronDepth: true })), null);
  assert.equal(nextActionForObjective('DESCEND', createInitialState({ stonePickaxes: 1, tablePlaced: true, craftingTables: 0, planks: 0, logs: 0 })), 'retrieve_table');
  assert.equal(nextActionForObjective('DESCEND', createInitialState({ stonePickaxes: 1, tablePlaced: true, craftingTables: 0, planks: 4 })), 'retrieve_table');
  assert.deepEqual(nextActionForObjective('DESCEND', createInitialState({ stonePickaxes: 1, tablePlaced: false, craftingTables: 1 })), {
    action: 'descend_staircase',
    targetY: THRESHOLDS.ironDepthY,
    ttlMs: 45000,
    targetX: 0,
    targetZ: 54,
  });
  assert.equal(nextActionForObjective('DESCEND_DEEP', createInitialState({ ironPickaxes: 1 })), null);
  assert.deepEqual(nextActionForObjective('DESCEND_DEEP', createInitialState({ ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent })), {
    action: 'descend_staircase',
    targetY: THRESHOLDS.diamondTargetY,
    ttlMs: 45000,
  });
  assert.equal(nextActionForObjective('MINE_DIAMOND', createInitialState({ ironPickaxes: 1, atDiamondDepth: true })), 'mine_nearby_diamond');
  assert.equal(nextActionForObjective('MAKE_DIAMOND_TOOLS', createInitialState({ diamonds: 3, sticks: 4, tablePlaced: true })), 'craft_diamond_pickaxe');
  assert.deepEqual(nextActionForObjective('MINE_IRON', createInitialState({ stonePickaxes: 1, atIronDepth: true })), {
    action: 'mine_nearby_iron',
    ttlMs: 45000,
  });
  assert.deepEqual(nextActionForObjective('DESCEND', createInitialState({ stonePickaxes: 1, x: 10.5, y: 24, z: -3.5 })), {
    action: 'descend_staircase',
    targetY: THRESHOLDS.ironDepthY,
    ttlMs: 45000,
    targetX: 10,
    targetZ: 4,
  });
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({ ironIngots: 5, sticks: 4, tablePlaced: true })), 'craft_iron_pickaxe');
  assert.equal(nextActionForObjective('MAKE_ARMOR', createInitialState({ ironIngots: 10, tablePlaced: true })), 'craft_iron_helmet');
  assert.equal(nextActionForObjective('MAKE_ARMOR', createInitialState({ ironHelmets: 1, tablePlaced: true })), 'equip_armor');
  assert.equal(nextActionForObjective('DONE', createInitialState()), null);
});

test('nextActionForObjective returns null when prerequisites are missing (drives a re-plan)', () => {
  // wants iron but not at depth
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ stonePickaxes: 1, atIronDepth: false })), null);
  // wants stone tools but no cobblestone
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ tablePlaced: true, sticks: 4, cobblestone: 0 })), null);
  // wants diamonds but has not reached diamond depth
  assert.equal(nextActionForObjective('MINE_DIAMOND', createInitialState({ ironPickaxes: 1, atDiamondDepth: false })), null);
  // wants diamonds but the last iron pickaxe is below the diamond safety threshold
  assert.equal(nextActionForObjective('MINE_DIAMOND', createInitialState({
    ironPickaxes: 1,
    bestIronPickaxeRemaining: THRESHOLDS.minLastIronPickaxeRemainingForDiamond - 1,
    atDiamondDepth: true,
  })), null);
});

test('mission sim 2x2 crafting output matches the live Fabric recipe planner', () => {
  const planks = applyAction(createInitialState({ logs: 2 }), 'craft_planks');
  assert.equal(planks.state.logs, 1);
  assert.equal(planks.state.planks, 4);

  const sticks = applyAction(createInitialState({ planks: 2 }), 'craft_sticks');
  assert.equal(sticks.state.planks, 0);
  assert.equal(sticks.state.sticks, 4);

  const table = applyAction(createInitialState({ planks: 4 }), 'craft_table');
  assert.equal(table.state.planks, 0);
  assert.equal(table.state.craftingTables, 1);
});

test('mission sim iron mining is mine-only while smelting consumes carried wood fuel', () => {
  const mined = applyAction(createInitialState({ stonePickaxes: 1, atIronDepth: true, fuel: 0 }), 'mine_nearby_iron');
  assert.equal(mined.state.rawIron, 3);
  assert.equal(mined.state.fuel, 0);

  const smelted = applyAction(createInitialState({ furnacePlaced: true, rawIron: 3, planks: 2, fuel: 0 }), 'smelt_raw_iron');
  assert.equal(smelted.state.rawIron, 0);
  assert.equal(smelted.state.ironIngots, 3);
  assert.equal(smelted.state.planks, 0);
  assert.equal(smelted.state.fuel, 0);
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
  const helmetInInventory = createInitialState({ ironHelmets: 1, ironIngots: 30, tablePlaced: true, equippedArmorPieces: 0 });
  assert.equal(nextActionForObjective('MAKE_ARMOR', helmetInInventory), 'equip_armor');
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
  // diamond-tier runs craft a spare iron pickaxe before deep descent
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({
    targetDiamondTier: true,
    atDiamondDepth: false,
    ironPickaxes: 1,
    ironIngots: 5,
    sticks: 4,
    tablePlaced: true,
  })), 'craft_iron_pickaxe');
  // SMELT_IRON: no furnace block, carrying a furnace item -> place it at depth
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({ furnaces: 1, furnacePlaced: false })), 'place_furnace');
  // SMELT_IRON: no furnace at all, but table + cobble -> craft one at depth
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({ furnaces: 0, furnacePlaced: false, tablePlaced: true, cobblestone: 8 })), 'craft_furnace');
  // SMELT_IRON: furnace placed + fuel + raw iron -> smelt with a long enough TTL for batched output
  assert.deepEqual(nextActionForObjective('SMELT_IRON', createInitialState({ furnacePlaced: true, fuel: 4, rawIron: 4 })), { action: 'smelt_raw_iron', ttlMs: 45000 });
  // SMELT_IRON: preserve an iron-pickaxe stick reserve before burning the last craftable planks.
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({
    targetIronPickaxeOnly: true,
    furnacePlaced: true,
    rawIron: 10,
    ironIngots: 1,
    planks: 4,
    sticks: 0,
  })), 'craft_sticks');
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({
    targetIronPickaxeOnly: true,
    furnacePlaced: true,
    rawIron: 10,
    ironIngots: 1,
    planks: 3,
    logs: 1,
    sticks: 0,
  })), 'craft_planks');
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
  assert.ok(
    res.actionTrace.filter((action) => action === 'mine_nearby_iron').length >= 9,
    'full armor mission must exercise armor-scale repeated iron mining',
  );
  assert.ok(
    res.actionTrace.filter((action) => action === 'smelt_raw_iron').length >= 9,
    'full armor mission must exercise live-scale repeated raw-iron smelting',
  );
  assert.ok(
    res.actionTrace.filter((action) => action === 'craft_planks').length >= 11,
    'full armor mission must exercise live-scale repeated plank crafting',
  );
  assert.ok(
    res.actionTrace.filter((action) => action === 'craft_sticks').length >= 2,
    'full armor mission must exercise live-scale repeated stick crafting',
  );
  assert.ok(
    res.actionTrace.filter((action) => action === 'craft_stone_pickaxe').length >= THRESHOLDS.stonePickaxesForIronArmorMission,
    'full armor mission should prepare spare stone pickaxes before the iron phase',
  );
  const seen = firstSeen(res.objectiveTrace);
  for (const o of ['GATHER_WOOD', 'MAKE_WOOD_TOOLS', 'MINE_STONE', 'MAKE_STONE_TOOLS', 'MAKE_FURNACE', 'DESCEND', 'MINE_IRON', 'SMELT_IRON', 'MAKE_IRON_TOOLS', 'MAKE_ARMOR']) {
    assert.ok(seen.includes(o), `objective ${o} was never chosen`);
  }
  assert.ok(res.signals.some((s) => s.evt === 'mission.done'), 'no mission.done signal');
});

test('full mission retrieves the surface table before descending', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  const retrieveIndex = res.actionTrace.indexOf('retrieve_table');
  const descendIndex = res.actionTrace.indexOf('descend_staircase');
  assert.notEqual(retrieveIndex, -1, 'surface table was not retrieved');
  assert.notEqual(descendIndex, -1, 'mission never descended');
  assert.ok(retrieveIndex < descendIndex, 'table retrieval should happen before descent');
});

test('tool objectives retrieve their workstation before movement objectives can strand it', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, { targetIronPickaxeOnly: true }, { maxSteps: 220 });
  const woodPickaxeIndex = res.actionTrace.indexOf('craft_pickaxe');
  const stoneMineIndex = res.actionTrace.indexOf('mine_nearby_stone');
  const firstRetrieveIndex = res.actionTrace.indexOf('retrieve_table');
  assert.notEqual(woodPickaxeIndex, -1, 'wooden pickaxe was never crafted');
  assert.notEqual(stoneMineIndex, -1, 'stone mining never started');
  assert.notEqual(firstRetrieveIndex, -1, 'table was not retrieved after wooden tools');
  assert.ok(woodPickaxeIndex < firstRetrieveIndex && firstRetrieveIndex < stoneMineIndex, 'wood tool table should be retrieved before mining moves away');

  const stonePickaxeIndex = res.actionTrace.indexOf('craft_stone_pickaxe');
  const furnaceCraftIndex = res.actionTrace.indexOf('craft_furnace');
  const secondRetrieveIndex = res.actionTrace.indexOf('retrieve_table', firstRetrieveIndex + 1);
  assert.notEqual(stonePickaxeIndex, -1, 'stone pickaxe was never crafted');
  assert.notEqual(furnaceCraftIndex, -1, 'furnace was never crafted');
  assert.notEqual(secondRetrieveIndex, -1, 'table was not retrieved after stone tools');
  assert.ok(stonePickaxeIndex < secondRetrieveIndex && secondRetrieveIndex < furnaceCraftIndex, 'stone tool table should be retrieved before furnace prep movement');
});

test('furnace crafting retrieves its table before descent even with spare table materials', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  const furnaceCraftIndex = res.actionTrace.indexOf('craft_furnace');
  const descendIndex = res.actionTrace.indexOf('descend_staircase');
  const retrieveAfterFurnaceIndex = res.actionTrace.indexOf('retrieve_table', furnaceCraftIndex + 1);

  assert.notEqual(furnaceCraftIndex, -1, 'furnace was never crafted');
  assert.notEqual(descendIndex, -1, 'mission never descended');
  assert.notEqual(retrieveAfterFurnaceIndex, -1, 'table was not retrieved after furnace craft');
  assert.ok(
    furnaceCraftIndex < retrieveAfterFurnaceIndex && retrieveAfterFurnaceIndex < descendIndex,
    'furnace table should be retrieved before descent can start',
  );
});

test('diamond-tier sim crafts a spare iron pickaxe, mines diamonds, then crafts a diamond pickaxe', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, { targetDiamondTier: true }, { maxSteps: 400 });
  assert.equal(res.done, true, `diamond mission did not complete in ${res.steps} steps`);
  assert.ok(res.state.ironPickaxes >= THRESHOLDS.ironPickaxesForDiamondDescent, 'no spare iron pickaxe before diamond run');
  assert.ok(res.state.atDiamondDepth, 'did not reach diamond depth');
  assert.ok(res.state.diamondPickaxes >= THRESHOLDS.diamondPickaxesForProgress, 'did not craft a diamond pickaxe');
  const seen = firstSeen(res.objectiveTrace);
  for (const o of ['MAKE_IRON_TOOLS', 'DESCEND_DEEP', 'MINE_DIAMOND', 'MAKE_DIAMOND_TOOLS']) {
    assert.ok(seen.includes(o), `objective ${o} was never chosen`);
  }
});

test('iron-pickaxe-only mission goal stops before armor crafting', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, { targetIronPickaxeOnly: true }, { maxSteps: 180 });
  assert.equal(res.done, true, `iron-pickaxe-only mission did not complete in ${res.steps} steps`);
  assert.ok(res.state.ironPickaxes >= 1, 'no iron pickaxe');
  assert.equal(res.state.equippedArmorPieces, 0, 'pickaxe-only goal should not craft/equip armor');
  assert.equal(res.objectiveTrace.includes('MAKE_ARMOR'), false, 'pickaxe-only objective should not enter armor rung');
});

test('recovery: terminal descent command failure queues one alternate-axis recovery descent', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const descentReady = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    tablePlaced: false,
    atIronDepth: false,
    x: 10.5,
    y: 24,
    z: -3.5,
  });

  const first = await orch.step(descentReady);
  assert.equal(first.objective, 'DESCEND');
  assert.equal(first.intent.action, 'descend_staircase');

  const failed = await orch.step({
    ...descentReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_water_adjacent:-1, 24, 11',
  });

  assert.equal(failed.done, false);
  assert.equal(failed.objective, 'DESCEND_RECOVERY');
  assert.equal(failed.intent.action, 'descend_staircase');
  assert.equal(failed.intent.objective, 'DESCEND');
  assert.equal(failed.intent.reason, 'mission:DESCEND_RECOVERY');
  assert.equal(failed.intent.targetY, THRESHOLDS.ironDepthY);
  assert.equal(failed.intent.targetX, 18);
  assert.equal(failed.intent.targetZ, -4);
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'DESCEND'
      && s.reason === 'descent_failed:descent_water_adjacent:-1, 24, 11'
  )));
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.recovery_queued'
      && s.objective === 'DESCEND'
      && s.reason === 'descent_relocate'
      && s.attempt === 1
  )));
});

test('recovery: terminal descent command failure steers perpendicular to east-west yaw', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const descentReady = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    tablePlaced: false,
    atIronDepth: false,
    x: 10.5,
    y: 24,
    z: -3.5,
    yaw: -90,
  });

  await orch.step(descentReady);
  const failed = await orch.step({
    ...descentReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_water_adjacent:-1, 24, 11',
  });

  assert.equal(failed.objective, 'DESCEND_RECOVERY');
  assert.equal(failed.intent.targetX, 10);
  assert.equal(failed.intent.targetZ, 4);
});

test('recovery: terminal descent command failure steers perpendicular to north-south yaw', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const descentReady = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    tablePlaced: false,
    atIronDepth: false,
    x: 10.5,
    y: 24,
    z: -3.5,
    yaw: 0,
  });

  await orch.step(descentReady);
  const failed = await orch.step({
    ...descentReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_water_adjacent:-1, 24, 11',
  });

  assert.equal(failed.objective, 'DESCEND_RECOVERY');
  assert.equal(failed.intent.targetX, 18);
  assert.equal(failed.intent.targetZ, -4);
});

test('recovery: terminal descent command failure aborts instead of retrying while player is in water', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), descentRecoveryLimit: 1 });
  const descentReady = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    tablePlaced: false,
    atIronDepth: false,
    x: -1.2,
    y: 24,
    z: 11.4,
    yaw: 0,
    touchingWater: true,
  });

  const first = await orch.step(descentReady);
  assert.equal(first.objective, 'DESCEND');
  assert.equal(first.intent.action, 'descend_staircase');

  const failed = await orch.step({
    ...descentReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_player_in_hazard:water:-1, 24, 11',
  });

  assert.equal(failed.done, true);
  assert.equal(failed.objective, 'ABORTED');
  assert.equal(failed.intent.action, 'stop');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.exhausted'
      && s.objective === 'DESCEND'
      && s.reason === 'recovery_unsafe_player_in_water'
      && s.attempts === 1
  )));
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.aborted'
      && s.reason === 'descent_recovery_exhausted'
      && s.objective === 'DESCEND'
      && s.detail === 'descent_failed:descent_player_in_hazard:water:-1, 24, 11'
      && s.attempts === 1
  )));
  assert.equal(failed.signals.some((s) => s.evt === 'mission.objective.recovery_queued'), false);
});

test('recovery: active descent aborts when completion was missed but player is already in water', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), descentRecoveryLimit: 1 });
  const descentReady = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    tablePlaced: false,
    atIronDepth: false,
    x: -1.2,
    y: 24,
    z: 11.4,
    yaw: 0,
  });

  const first = await orch.step(descentReady);
  assert.equal(first.objective, 'DESCEND');
  assert.equal(first.intent.action, 'descend_staircase');

  const failed = await orch.step({
    ...descentReady,
    touchingWater: true,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });

  assert.equal(failed.done, true);
  assert.equal(failed.objective, 'ABORTED');
  assert.equal(failed.intent.action, 'stop');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'DESCEND'
      && s.reason === 'recovery_unsafe_player_in_water'
  )));
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.exhausted'
      && s.objective === 'DESCEND'
      && s.reason === 'recovery_unsafe_player_in_water'
      && s.attempts === 1
  )));
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.aborted'
      && s.reason === 'descent_recovery_exhausted'
      && s.objective === 'DESCEND'
      && s.detail === 'current_state:recovery_unsafe_player_in_water'
      && s.attempts === 1
  )));
  assert.equal(failed.signals.some((s) => s.evt === 'mission.objective.recovery_queued'), false);
});

test('recovery: terminal descent command failure aborts cleanly after the bounded retry', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), descentRecoveryLimit: 1 });
  const descentReady = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    tablePlaced: false,
    atIronDepth: false,
  });

  const first = await orch.step(descentReady);
  assert.equal(first.objective, 'DESCEND');
  assert.equal(first.intent.action, 'descend_staircase');

  const retry = await orch.step({
    ...descentReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_water_adjacent:-1, 24, 11',
  });
  assert.equal(retry.objective, 'DESCEND_RECOVERY');
  assert.equal(retry.intent.action, 'descend_staircase');

  const exhausted = await orch.step({
    ...descentReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_water_adjacent:-1, 24, 11',
  });

  assert.equal(exhausted.done, true);
  assert.equal(exhausted.objective, 'ABORTED');
  assert.equal(exhausted.intent.action, 'stop');
  assert.ok(exhausted.signals.some((s) => (
    s.evt === 'mission.objective.exhausted'
      && s.objective === 'DESCEND'
      && s.reason === 'recovery_limit_reached'
      && s.attempts === 2
  )));
  assert.ok(exhausted.signals.some((s) => (
    s.evt === 'mission.aborted'
      && s.reason === 'descent_recovery_exhausted'
      && s.objective === 'DESCEND'
      && s.attempts === 2
  )));
});

test('the LLM is consulted only on objective transitions, not every step', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  assert.equal(res.llmCalls, 0, `oracle-primary should not call the LLM; got ${res.llmCalls}`);
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

test('recovery: failed MINE_IRON queues one relocation descent instead of immediately re-picking MINE_IRON', async () => {
  let t = 0;
  let blockedMine = false;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 1000, abortTimeoutMs: 60000 });
  const res = await runMissionInSim(orch, {
    stonePickaxes: 2,
    stoneSwords: 1,
    sticks: 64,
    tablePlaced: true,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 12,
  }, {
    maxSteps: 160,
    applyAction: (state, action) => {
      if (action === 'mine_nearby_iron' && !blockedMine) {
        blockedMine = true;
        t += 1500;
        return { state, progressed: false, note: 'iron_exhausted' };
      }
      t += 200;
      return applyAction(state, action);
    },
  });
  assert.ok(blockedMine, 'test never blocked the first iron mine');
  assert.ok(res.signals.some((s) => s.evt === 'mission.objective.failed' && s.objective === 'MINE_IRON'), 'no failed MINE_IRON signal');
  assert.ok(res.signals.some((s) => s.evt === 'mission.objective.recovery_queued'), 'no recovery queued signal');
  assert.ok(res.actionTrace.includes('descend_staircase'), 'no relocation descent action');
  assert.ok(res.done, 'mission should still finish after relocation');
});

test('watchdog: horizontal travel counts as progress, stationary still aborts (run-12 mountain abort)', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 60000, abortTimeoutMs: 45000 });
  let x = 0;
  let aborted = false;
  for (let i = 0; i < 20; i++) {
    const res = await orch.step({ x, y: 120, z: 0 });
    if (res.signals.some((s) => s.evt === 'mission.aborted')) {
      aborted = true;
      break;
    }
    x += 8; // two 4-block buckets per poll — a searching/marching bot
    t += 10000; // 200 s total, far beyond abortTimeoutMs
  }
  assert.equal(aborted, false, 'a moving bot must not trip the no-global-progress watchdog');

  const orch2 = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 60000, abortTimeoutMs: 45000 });
  let aborted2 = false;
  for (let i = 0; i < 20; i++) {
    const res = await orch2.step({ x: 0, y: 120, z: 0 });
    if (res.signals.some((s) => s.evt === 'mission.aborted')) {
      aborted2 = true;
      break;
    }
    t += 10000;
  }
  assert.equal(aborted2, true, 'a stationary no-progress bot must still abort on schedule');
});

test('recovery: completed MINE_IRON command failure queues relocation without waiting for stall timeout', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), stallTimeoutMs: 60000, abortTimeoutMs: 120000 });
  const mineReady = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    sticks: 16,
    tablePlaced: true,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 12,
  });

  const first = await orch.step(mineReady);
  assert.equal(first.objective, 'MINE_IRON');
  assert.equal(first.intent.action, 'mine_nearby_iron');

  const failed = await orch.step({
    ...mineReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_failed:mine_nearby_iron_no_visible_ore',
  });

  assert.equal(failed.objective, 'MINE_IRON_RECOVERY');
  assert.equal(failed.intent.action, 'descend_staircase');
  assert.equal(failed.source, 'recovery');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'MINE_IRON'
      && s.reason === 'mine_nearby_iron_failed:mine_nearby_iron_no_visible_ore'
  )));
  assert.ok(failed.signals.some((s) => s.evt === 'mission.objective.recovery_queued' && s.objective === 'MINE_IRON'));
});

test('R0 dead-column relocate: MINE_STONE pinned on no_safe_reroute walks to a fresh column then resumes', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), stallTimeoutMs: 60000, abortTimeoutMs: 600000 });
  const mineReady = createInitialState({ woodenPickaxes: 1, x: 0, y: 80, z: 0 });

  const first = await orch.step(mineReady);
  assert.equal(first.objective, 'MINE_STONE');
  assert.equal(first.intent.action, 'mine_nearby_stone');

  // Four consecutive dead-column descent failures fire the R0 streak (limit 4) -> horizontal relocate.
  const deadColumn = {
    ...mineReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_stone_descent_fallback_failed:descent_failed:descent_next_support_missing:-6, 82, -10:no_safe_reroute',
  };
  let relocated;
  for (let i = 0; i < 4; i++) relocated = await orch.step(deadColumn);

  assert.equal(relocated.objective, 'RELOCATE', 'the dead-column streak should escalate to a horizontal relocate');
  assert.equal(relocated.intent.action, 'navigate_to_point');
  assert.ok(Number.isFinite(relocated.intent.targetX) && Number.isFinite(relocated.intent.targetZ));
  const moved = Math.hypot(relocated.intent.targetX, relocated.intent.targetZ);
  assert.ok(moved >= 8, `relocate target should be a fresh column away (got ${moved})`);
  assert.ok(relocated.signals.some((s) => s.evt === 'mission.relocate.queued' && s.from === 'MINE_STONE'));

  // Still walking (bot at origin, far from target): held as RELOCATE, not interrupted by MINE_STONE.
  const walking = await orch.step(mineReady);
  assert.equal(walking.objective, 'RELOCATE');

  // Arrived at the fresh column -> resume MINE_STONE from the new position.
  const arrived = await orch.step({ ...mineReady, x: relocated.intent.targetX, z: relocated.intent.targetZ });
  assert.equal(arrived.objective, 'MINE_STONE');
  assert.equal(arrived.intent.action, 'mine_nearby_stone');
  assert.ok(arrived.signals.some((s) => s.evt === 'mission.relocate.arrived'));
});

test('recovery: completed EAT command failure replans instead of holding the survival objective', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const hungryWithFood = createInitialState({ foodLevel: 3, hasFood: true });

  const first = await orch.step(hungryWithFood);
  assert.equal(first.objective, 'EAT');
  assert.equal(first.intent.action, 'eat');

  now += 100;
  const failed = await orch.step({
    ...hungryWithFood,
    hasFood: false,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'eat_failed:no_hotbar_food',
  });

  assert.equal(failed.objective, 'GATHER_WOOD');
  assert.equal(failed.intent.action, 'gather_tree');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'EAT'
      && s.reason === 'eat_failed:no_hotbar_food'
  )));
  assert.ok(failed.signals.some((s) => s.evt === 'mission.replan' && s.from === 'EAT' && s.to === 'GATHER_WOOD'));
});

test('recovery: completed armor craft failure replans immediately toward missing iron', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const armorReady = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    ironPickaxes: 1,
    ironIngots: 5,
    tablePlaced: true,
    furnacePlaced: true,
    atIronDepth: true,
  });

  const first = await orch.step(armorReady);
  assert.equal(first.objective, 'MAKE_ARMOR');
  assert.equal(first.intent.action, 'craft_iron_helmet');

  now += 100;
  const failed = await orch.step({
    ...armorReady,
    ironIngots: 0,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'craft_iron_helmet_failed:craft_iron_helmet_missing_inputs',
  });

  assert.equal(failed.objective, 'MINE_IRON');
  assert.equal(failed.intent.action, 'mine_nearby_iron');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'MAKE_ARMOR'
      && s.reason === 'craft_iron_helmet_failed:craft_iron_helmet_missing_inputs'
  )));
  assert.ok(failed.signals.some((s) => s.evt === 'mission.replan' && s.from === 'MAKE_ARMOR' && s.to === 'MINE_IRON'));
});

test('recovery: completed armor equip failure replans immediately toward missing iron', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const spareArmorReady = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    ironPickaxes: 1,
    ironHelmets: 1,
    furnacePlaced: true,
    atIronDepth: true,
  });

  const first = await orch.step(spareArmorReady);
  assert.equal(first.objective, 'MAKE_ARMOR');
  assert.equal(first.intent.action, 'equip_armor');

  now += 100;
  const failed = await orch.step({
    ...spareArmorReady,
    ironHelmets: 0,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'equip_armor_failed:equip_armor_missing_piece',
  });

  assert.equal(failed.objective, 'MINE_IRON');
  assert.equal(failed.intent.action, 'mine_nearby_iron');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'MAKE_ARMOR'
      && s.reason === 'equip_armor_failed:equip_armor_missing_piece'
  )));
  assert.ok(failed.signals.some((s) => s.evt === 'mission.replan' && s.from === 'MAKE_ARMOR' && s.to === 'MINE_IRON'));
});

test('recovery: completed raw-iron smelt failure replans immediately toward fuel recovery', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const smeltReady = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    rawIron: 3,
    fuel: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
  });

  const first = await orch.step(smeltReady);
  assert.equal(first.objective, 'SMELT_IRON');
  assert.equal(first.intent.action, 'smelt_raw_iron');

  now += 100;
  const failed = await orch.step({
    ...smeltReady,
    fuel: 0,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'smelt_raw_iron_failed:smelt_raw_iron_missing_fuel',
  });

  // Fuel v2 selector layer: fuel-out AT DEPTH stays on the smelt track and mines coal
  // right there — the old GATHER_WOOD-underground replan was the unwinnable cascade.
  assert.equal(failed.objective, 'SMELT_IRON');
  assert.equal(failed.intent.action, 'mine_nearby_coal');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'SMELT_IRON'
      && s.reason === 'smelt_raw_iron_failed:smelt_raw_iron_missing_fuel'
  )));
  assert.ok(
    !failed.signals.some((s) => s.evt === 'mission.replan' && s.to === 'GATHER_WOOD'),
    'must not replan to wood-gathering underground'
  );
});

test('recovery: completed table placement failure replans immediately toward table recovery', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const ironToolReady = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    ironIngots: 3,
    sticks: 2,
    craftingTables: 1,
    furnacePlaced: true,
    atIronDepth: true,
  });

  const first = await orch.step(ironToolReady);
  assert.equal(first.objective, 'MAKE_IRON_TOOLS');
  assert.equal(first.intent.action, 'place_table');

  now += 100;
  const failed = await orch.step({
    ...ironToolReady,
    craftingTables: 0,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'place_table_failed:place_table_no_table',
  });

  assert.equal(failed.objective, 'GATHER_WOOD');
  assert.equal(failed.intent.action, 'gather_tree');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'MAKE_IRON_TOOLS'
      && s.reason === 'place_table_failed:place_table_no_table'
  )));
  assert.ok(failed.signals.some((s) => s.evt === 'mission.replan' && s.from === 'MAKE_IRON_TOOLS' && s.to === 'GATHER_WOOD'));
});

test('recovery: completed furnace placement failure replans immediately toward furnace recovery', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const smeltReady = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    rawIron: 3,
    fuel: 1,
    furnaces: 1,
    atIronDepth: true,
  });

  const first = await orch.step(smeltReady);
  assert.equal(first.objective, 'SMELT_IRON');
  assert.equal(first.intent.action, 'place_furnace');

  now += 100;
  const failed = await orch.step({
    ...smeltReady,
    furnaces: 0,
    cobblestone: 8,
    tablePlaced: true,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'place_furnace_failed:place_furnace_no_furnace',
  });

  assert.equal(failed.objective, 'MAKE_FURNACE');
  assert.equal(failed.intent.action, 'craft_furnace');
  assert.ok(failed.signals.some((s) => (
    s.evt === 'mission.objective.failed'
      && s.objective === 'SMELT_IRON'
      && s.reason === 'place_furnace_failed:place_furnace_no_furnace'
  )));
  assert.ok(failed.signals.some((s) => s.evt === 'mission.replan' && s.from === 'SMELT_IRON' && s.to === 'MAKE_FURNACE'));
});

test('recovery: broken stone pickaxe during iron mining replans to remake tools and completes', async () => {
  let brokePickaxe = false;
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, {
    maxSteps: 400,
    mutate: (state) => {
      if (!brokePickaxe
        && orch.state.currentObjective === 'MINE_IRON'
        && state.stonePickaxes >= 1
        && state.ironPickaxes < 1
        && state.rawIron < 1) {
        brokePickaxe = true;
        return { ...state, stonePickaxes: 0 };
      }
      return undefined;
    },
  });

  assert.ok(brokePickaxe, 'the injected pickaxe break never fired');
  assert.ok(res.done, 'mission should complete after remaking a stone pickaxe');
  assert.ok(res.signals.some((s) => s.evt === 'mission.objective.blocked' && s.objective === 'MINE_IRON'), 'MINE_IRON did not block after the broken pickaxe');
  assert.ok(res.signals.some((s) => s.evt === 'mission.replan' && s.from === 'MINE_IRON' && ['MINE_STONE', 'MAKE_STONE_TOOLS'].includes(s.to)), 'did not replan toward stone-tool recovery');
  assert.ok(res.state.ironPickaxes >= 1 && res.state.equippedArmorPieces >= 4, 'final iron gear objective incomplete');
});

test('recovery: fuel-out before smelting mines coal at depth and completes (fuel v2)', async () => {
  let fuelRemoved = false;
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, {
    maxSteps: 400,
    mutate: (state) => {
      if (!fuelRemoved
        && orch.state.currentObjective === 'SMELT_IRON'
        && state.rawIron >= 1
        && (state.fuel >= 1 || state.logs >= 1 || state.planks >= 1)
        && state.ironPickaxes < 1) {
        fuelRemoved = true;
        return { ...state, fuel: 0, logs: 0, planks: 0 };
      }
      return undefined;
    },
  });

  assert.ok(fuelRemoved, 'the injected fuel-out condition never fired');
  assert.ok(res.done, 'mission should complete after mining coal fuel');
  // Fuel v2 contract: fuel-out AT DEPTH mines coal as a first-class goal; the old behavior — a
  // replan to GATHER_WOOD underground (the resource cascade, unwinnable) — must NOT
  // happen from the smelt phase.
  assert.ok(res.actionTrace.includes('mine_nearby_coal'), 'fuel-out at depth must mine coal');
  assert.ok(
    !res.signals.some((s) => s.evt === 'mission.replan' && s.from === 'SMELT_IRON' && s.to === 'GATHER_WOOD'),
    'must not cascade from smelting to wood-gathering underground'
  );
  assert.ok(res.state.ironPickaxes >= 1 && res.state.equippedArmorPieces >= 4, 'final iron gear objective incomplete');
});

test('recovery: transient full inventory during iron pickup relocates once, clears pressure, and completes', async () => {
  let t = 0;
  let clearedInventoryPressure = false;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => t,
    stallTimeoutMs: 1000,
    abortTimeoutMs: 60000,
    ironSearchRecoveryLimit: 1,
  });
  const res = await runMissionInSim(orch, {
    stonePickaxes: 2,
    stoneSwords: 1,
    sticks: 32,
    tablePlaced: true,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    inventoryFull: true,
    y: 12,
  }, {
    maxSteps: 240,
    applyAction: (state, action) => {
      if (action === 'mine_nearby_iron') {
        t += state.inventoryFull ? 1500 : 200;
        return applyAction(state, action);
      }
      if (action === 'descend_staircase' && state.inventoryFull) {
        clearedInventoryPressure = true;
        t += 200;
        return applyAction({ ...state, inventoryFull: false }, action);
      }
      t += 200;
      return applyAction(state, action);
    },
  });

  assert.ok(clearedInventoryPressure, 'the relocation never cleared inventory pressure');
  assert.ok(res.done, 'mission should finish after transient inventory pressure clears');
  assert.ok(res.signals.some((s) => s.evt === 'mission.objective.failed' && s.objective === 'MINE_IRON'), 'MINE_IRON did not fail on the blocked pickup');
  assert.ok(res.signals.some((s) => s.evt === 'mission.objective.recovery_queued' && s.objective === 'MINE_IRON'), 'missing bounded relocation recovery');
  assert.equal(res.actionTrace.filter((action) => action === 'descend_staircase').length, 1, 'transient pressure should need exactly one relocation descent');
  assert.ok(res.state.ironPickaxes >= 1 && res.state.equippedArmorPieces >= 4, 'final iron gear objective incomplete');
});

test('recovery: full inventory during iron pickup aborts cleanly after the bounded relocation attempt', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => t,
    stallTimeoutMs: 1000,
    abortTimeoutMs: 60000,
    ironSearchRecoveryLimit: 1,
  });
  const res = await runMissionInSim(orch, {
    stonePickaxes: 2,
    stoneSwords: 1,
    sticks: 16,
    tablePlaced: true,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    inventoryFull: true,
    y: 12,
  }, {
    maxSteps: 80,
    applyAction: (state, action) => {
      t += action === 'mine_nearby_iron' ? 1500 : 200;
      return applyAction(state, action);
    },
  });

  assert.equal(res.done, true, 'mission should terminate cleanly when pickup stays impossible');
  assert.ok(res.signals.some((s) => s.evt === 'mission.objective.recovery_queued' && s.objective === 'MINE_IRON'), 'missing the bounded relocation attempt');
  assert.ok(res.signals.some((s) => s.evt === 'mission.objective.exhausted' && s.reason === 'recovery_limit_reached'), 'iron search did not exhaust after the recovery cap');
  assert.ok(res.signals.some((s) => s.evt === 'mission.aborted' && s.reason === 'iron_search_exhausted'), 'missing clean mission abort for persistent full inventory');
  assert.equal(res.actionTrace.filter((action) => action === 'descend_staircase').length, 1, 'should not queue repeated relocation descents');
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

test('iron-search recovery stays in the iron band instead of drifting deeper (o3 dry-pocket fix)', async () => {
  // 5 of 6 exhausted o3 runs ended prospecting at y=-1..-30 after recoveries descended -8 each
  // (old floor -48). Recoveries must stay near the y~16 iron peak.
  let t = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 1000 });
  const atDepth = createInitialState({
    stonePickaxes: 2, stoneSwords: 1, cobblestone: 12, sticks: 4,
    tablePlaced: true, craftingTables: 1, furnaces: 1, furnacePlaced: true,
    atIronDepth: true, y: 14,
  });
  const first = await orch.step(atDepth);
  assert.equal(first.objective, 'MINE_IRON');
  t += 1500; // stall MINE_IRON -> recovery queued and returned in the same step
  const second = await orch.step(atDepth);
  assert.ok(
    second.signals.some((s) => s.evt === 'mission.objective.recovery_queued'),
    'expected an iron-search recovery'
  );
  assert.equal(second.intent.action, 'descend_staircase');
  assert.equal(second.intent.targetY, 12, 'recovery from y=14 descends to 12 (in-band), not toward -48');
  // From below the band, the reset clamps to the band floor rather than drifting deeper.
  const deep = { ...atDepth, y: -20 };
  let t2 = 1000;
  const orch2 = new MissionOrchestrator({ complete: oracleBrain(), now: () => t2, stallTimeoutMs: 1000 });
  await orch2.step(deep);
  t2 += 1500;
  const reset = await orch2.step(deep);
  assert.equal(reset.intent.action, 'descend_staircase');
  assert.equal(reset.intent.targetY, 6, 'below-band recovery clamps to the band floor (no further drift)');
});

test('iron-search partial progress resets failures and rotates a code-owned heading without recovery charge', async () => {
  let t = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 30_000 });
  const atDepth = createInitialState({
    logs: 24, sticks: 16, stonePickaxes: 2, stoneSwords: 1, cobblestone: 64,
    tablePlaced: true, craftingTables: 1, furnaces: 1, furnacePlaced: true,
    atIronDepth: true, y: 14, x: 20, z: 30, yaw: 0, targetIronPickaxeOnly: true,
  });
  const first = await orch.step(atDepth);
  assert.equal(first.objective, 'MINE_IRON');
  assert.equal(first.intent.action, 'mine_nearby_iron');
  assert.deepEqual([first.intent.targetX, first.intent.targetZ], [20, 42]);

  t += 1000;
  const partial = await orch.step({
    ...atDepth,
    rawIron: 2,
    currentCommandId: 'iron-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_complete:partial_raw_iron_delta',
  });
  assert.equal(partial.objective, 'MINE_IRON');
  assert.equal(partial.intent.action, 'mine_nearby_iron');
  assert.deepEqual([partial.intent.targetX, partial.intent.targetZ], [32, 30]);
  assert.equal(orch.state.objectiveFailures.MINE_IRON, 0);
  assert.ok(partial.signals.some((signal) => signal.evt === 'mission.iron_search.partial_progress'));
  assert.ok(partial.signals.some((signal) => signal.evt === 'mission.iron_search.direction_rotated' && signal.from === 'south' && signal.to === 'east'));
  assert.equal(partial.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
});

test('iron-search zero gain rotates the recovery sector and cumulative exhaustion aborts immediately', async () => {
  let t = 1000;
  const atDepth = createInitialState({
    logs: 24, sticks: 16, stonePickaxes: 2, stoneSwords: 1, cobblestone: 64,
    tablePlaced: true, craftingTables: 1, furnaces: 1, furnacePlaced: true,
    atIronDepth: true, y: 14, x: 20, z: 30, yaw: 0, targetIronPickaxeOnly: true,
  });
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 30_000 });
  await orch.step(atDepth);
  t += 1000;
  const failed = await orch.step({
    ...atDepth,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_failed:mine_nearby_iron_no_iron_after_prospecting',
  });
  assert.equal(failed.intent.action, 'descend_staircase');
  assert.deepEqual([failed.intent.targetX, failed.intent.targetZ], [32, 30]);
  assert.ok(failed.signals.some((signal) => signal.evt === 'mission.iron_search.direction_rotated'));

  let t2 = 1000;
  const capped = new MissionOrchestrator({ complete: oracleBrain(), now: () => t2, stallTimeoutMs: 30_000 });
  await capped.step(atDepth);
  t2 += 1000;
  const terminal = await capped.step({
    ...atDepth,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_failed:mine_nearby_iron_search_epoch_exhausted',
  });
  assert.equal(terminal.done, true);
  assert.equal(terminal.objective, 'ABORTED');
  assert.ok(terminal.signals.some((signal) => signal.evt === 'mission.objective.exhausted' && signal.reason === 'search_epoch_budget'));
  assert.equal(terminal.signals.some((signal) => signal.evt === 'mission.objective.recovery_queued'), false);
});

test('an objective that runs past the wall clock fails through the normal retry machinery (o3-c19)', async () => {
  // A treeless world kept GATHER_WOOD alive a full 40-min run: endless search marches register as
  // progress, so the stall window never fires. The absolute cap converts that into a normal
  // objective failure.
  let t = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, objectiveWallClockMs: 600_000 });
  const state = createInitialState();
  const first = await orch.step(state);
  assert.equal(first.objective, 'GATHER_WOOD');
  t += 599_000;
  const speedBump = await orch.step({ ...state, logs: 1 }); // inventory change = progress, stall window resets
  assert.equal(speedBump.objective, 'GATHER_WOOD');
  t += 2_000; // now past the 600 s wall clock despite recent progress
  const capped = await orch.step({ ...state, logs: 2 });
  assert.ok(
    capped.signals.some((s) => s.evt === 'mission.objective.failed' && s.reason === 'wall_clock'),
    'wall clock must fail the objective even while progress trickles'
  );
});

test('GATHER_WOOD at depth surfaces via return_staircase to the anchor first (depth-aware wood)', () => {
  // The an observed regression/22 death class, sticks variant: wood needs that arise underground must not
  // search for trees in a mine. The anchor is the last not-at-depth position the orchestrator saw.
  const atDepth = createInitialState({ atIronDepth: true, y: 12 });
  const plan = nextActionForObjective('GATHER_WOOD', atDepth, { surfaceAnchor: { x: 5, y: 71, z: -3 } });
  assert.equal(plan.action, 'return_staircase');
  assert.equal(plan.targetX, 5);
  assert.equal(plan.targetY, 71);
  assert.equal(plan.targetZ, -3);
  const noAnchor = nextActionForObjective('GATHER_WOOD', atDepth, {});
  assert.equal(noAnchor.action, 'gather_tree', 'no known anchor falls back to the old behavior');
  const surface = nextActionForObjective('GATHER_WOOD', createInitialState({}), { surfaceAnchor: { x: 5, y: 71, z: -3 } });
  assert.equal(surface.action, 'gather_tree', 'on the surface the anchor is irrelevant');
});

test('recovery: stick-out at depth surfaces for wood and completes (depth-aware GATHER_WOOD)', async () => {
  let stripped = false;
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const res = await runMissionInSim(orch, {}, {
    maxSteps: 400,
    mutate: (state) => {
      if (!stripped && state.atIronDepth && state.ironIngots >= 3) {
        stripped = true;
        return { ...state, sticks: 0, planks: 0, logs: 0 };
      }
      return undefined;
    },
  });
  assert.ok(stripped, 'the injected stick-out condition never fired');
  assert.ok(res.done, 'mission should complete after surfacing for wood');
  const trace = res.actionTrace;
  const returnIdx = trace.indexOf('return_staircase');
  assert.ok(returnIdx >= 0, 'must surface via return_staircase');
  assert.ok(
    trace.slice(returnIdx + 1).includes('gather_tree'),
    'gathering must happen after the surface return, not underground'
  );
});

test('fuel-out at depth keeps the OBJECTIVE on the smelt track (fuel v2 selector layer)', () => {
  // Root cause of the run-18/22 deep-run deaths: the selector flipped to GATHER_WOOD underground
  // before SMELT_IRON was ever the objective, so the action-layer coal branch never ran live.
  const base = {
    stonePickaxes: 2, stoneSwords: 1, cobblestone: 12, sticks: 4,
    tablePlaced: true, craftingTables: 1,
    furnaces: 1, furnacePlaced: true,
  };
  assert.equal(
    expectedObjective(createInitialState({ ...base, rawIron: 3, atIronDepth: true, logs: 0, planks: 0 })),
    'SMELT_IRON',
    'at depth, fuel-out with raw iron stays on SMELT_IRON (coal is minable there)'
  );
  assert.equal(
    expectedObjective(createInitialState({ ...base, rawIron: 3, atIronDepth: false, logs: 0, planks: 0 })),
    'GATHER_WOOD',
    'on the surface the wood path remains'
  );
});

test('SMELT_IRON fuel-short at depth chooses mine_nearby_coal, never wood underground (fuel v2)', () => {
  const base = {
    furnacePlaced: true,
    tablePlaced: true,
    inventoryRawIronCount: 3,
    inventoryCoalCount: 0,
    inventoryCharcoalCount: 0,
    inventoryPlankCount: 0,
    inventoryLogCount: 0,
    inventorySticksCount: 4,
    atIronDepth: true,
  };
  const coalPick = nextActionForObjective('SMELT_IRON', base);
  assert.equal(coalPick && coalPick.action, 'mine_nearby_coal', 'fuel-short at depth must mine coal');
  const surface = nextActionForObjective('SMELT_IRON', { ...base, atIronDepth: false });
  assert.equal(surface, null, 'fuel-short on the surface keeps the old replan path');
  const fueled = nextActionForObjective('SMELT_IRON', { ...base, inventoryCoalCount: 2 });
  assert.equal(fueled && fueled.action, 'smelt_raw_iron', 'with fuel the smelt proceeds');
});

test('GATHER_WOOD failures retry with a budget before exhausting (run-14 mountain abort)', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 4000, abortTimeoutMs: 600000 });
  const frozen = createInitialState({ logs: 0 });
  let terminal = null;
  let retries = 0;
  for (let i = 0; i < 60; i += 1) {
    const out = await orch.step(frozen);
    retries += out.signals.filter((s) => s.evt === 'mission.objective.recovery_queued'
      && s.objective === 'GATHER_WOOD' && s.reason === 'wild_terrain_retry').length;
    if (out.done) {
      terminal = out;
      break;
    }
    t += 3000;
  }
  assert.ok(retries >= 3, `expected at least 3 budgeted gather retries, got ${retries}`);
  assert.ok(terminal, 'mission should still exhaust after the budget');
  assert.ok(
    terminal.signals.some((s) => s.evt === 'mission.aborted' && s.reason === 'objective_exhausted' && s.attempts > 3),
    'final abort is the exhaustion, beyond the retry budget'
  );
});

test('MINE_STONE failures retry with the terrain-local budget (run-15 1-strike abort)', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 4000, abortTimeoutMs: 600000 });
  // Wooden pickaxe in hand, no cobblestone: the oracle picks MINE_STONE and the frozen sim never
  // applies the action, so each stall window records a failure and re-picks MINE_STONE.
  const frozen = createInitialState({
    logs: 4, planks: 8, sticks: 4, woodenPickaxes: 1, craftingTables: 1, tablePlaced: true,
  });
  let terminal = null;
  let retries = 0;
  for (let i = 0; i < 60; i += 1) {
    const out = await orch.step(frozen);
    retries += out.signals.filter((s) => s.evt === 'mission.objective.recovery_queued'
      && s.objective === 'MINE_STONE' && s.reason === 'wild_terrain_retry').length;
    if (out.done) {
      terminal = out;
      break;
    }
    t += 3000;
  }
  assert.ok(retries >= 3, `expected at least 3 budgeted stone retries, got ${retries}`);
  assert.ok(terminal, 'mission should still exhaust after the budget');
  assert.ok(
    terminal.signals.some((s) => s.evt === 'mission.aborted' && s.attempts > 3),
    'final abort comes only beyond the retry budget'
  );
});

test('same-objective exhaustion aborts a frozen mission before the global watchdog', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 4000, abortTimeoutMs: 60000 });
  const frozen = createInitialState({ logs: 0 }); // GATHER_WOOD chosen; we never apply the action
  let terminal = null;
  for (let i = 0; i < 12; i += 1) {
    const out = await orch.step(frozen);
    if (out.done) { terminal = out; break; }
    t += 3000;
  }
  assert.ok(terminal, 'expected the mission to end after same-objective exhaustion');
  assert.equal(terminal.objective, 'ABORTED');
  assert.ok(terminal.signals.some((s) => s.evt === 'mission.objective.failed' && s.objective === 'GATHER_WOOD'), 'expected the stalled objective failure');
  assert.ok(terminal.signals.some((s) => s.evt === 'mission.objective.exhausted' && s.objective === 'GATHER_WOOD' && s.reason === 'same_objective_reselected'), 'expected same-objective exhaustion telemetry');
  assert.ok(terminal.signals.some((s) => s.evt === 'mission.aborted' && s.reason === 'objective_exhausted'), 'expected clean objective_exhausted abort');
});

test('global watchdog still aborts a pathological no-progress mission state', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 4000, abortTimeoutMs: 12000 });
  const frozen = createInitialState({ logs: 0 });
  await orch.step(frozen);
  orch.state.currentObjective = null;
  orch.state.lastOutcome = 'none';
  orch.state.objectiveFailures = {};
  t = 13000;
  const out = await orch.step(frozen);
  assert.equal(out.done, true);
  assert.equal(out.objective, 'ABORTED');
  assert.ok(out.signals.some((s) => s.evt === 'mission.aborted' && s.reason === 'no_global_progress'), 'expected the global watchdog abort');
});

// ---- R0: repeated-command-failure escalation -------------------------------

test('R0: repeated same-class command failure escalates before the slow stall ', async () => {
  // repro: mine_nearby_stone's descent fallback hit an unbridgeable gap and fast-failed
  // (no_safe_reroute) ~9x/s for the full 10 s stall window (359 identical starts across 4 attempts),
  // because micro-movement kept resetting the stall clock. Here t never advances and the timers are
  // huge -- so the ONLY thing that can fail the objective is the R0 streak. If it works, the spin
  // collapses to the limit; if it were broken, the objective would re-dispatch forever.
  let t = 0;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => t,
    stallTimeoutMs: 600000,
    abortTimeoutMs: 600000,
    commandFailureStreakLimit: 4,
  });
  const mineStoneReady = createInitialState({ logs: 6, planks: 16, sticks: 12, woodenPickaxes: 1, cobblestone: 0 });
  const first = await orch.step(mineStoneReady);
  assert.equal(first.objective, 'MINE_STONE');
  assert.equal(first.intent.action, 'mine_nearby_stone');

  // Coords vary each cycle (different step) but the failure CLASS is identical -> must still accumulate.
  const failReason = (n) =>
    `mine_nearby_stone_failed:mine_nearby_stone_descent_fallback_failed:descent_failed:descent_next_support_missing:${n}, 82, -11:no_safe_reroute`;
  let escalated = null;
  for (let i = 1; i <= 4; i += 1) {
    const out = await orch.step({
      ...mineStoneReady,
      currentCommandCompleted: true,
      currentCommandCompletionReason: failReason(-i),
    });
    const sig = out.signals.find((s) => s.evt === 'mission.objective.failed' && s.reason === 'repeated_command_failure');
    if (i < 4) {
      assert.equal(sig, undefined, `escalated too early at i=${i}`);
    } else {
      escalated = sig;
    }
  }
  assert.ok(escalated, 'expected repeated_command_failure escalation at the 4th identical failure');
  assert.equal(escalated.objective, 'MINE_STONE');
  assert.equal(escalated.streak, 4);
  // The escalation feeds the EXISTING terrain-retry budget rather than a new abort path.
  assert.equal(orch.state.objectiveFailures.MINE_STONE >= 1, true);
});

test('R0: a non-failing completion resets the consecutive-failure streak', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => t,
    stallTimeoutMs: 600000,
    abortTimeoutMs: 600000,
    commandFailureStreakLimit: 4,
  });
  const mineStoneReady = createInitialState({ logs: 6, planks: 16, sticks: 12, woodenPickaxes: 1, cobblestone: 0 });
  await orch.step(mineStoneReady);
  const failReason = 'mine_nearby_stone_failed:descent_failed:descent_next_support_missing:-7, 82, -11:no_safe_reroute';
  let escalations = 0;
  const feed = async (snap) => {
    const out = await orch.step(snap);
    escalations += out.signals.filter((s) => s.evt === 'mission.objective.failed' && s.reason === 'repeated_command_failure').length;
  };
  const fail = { ...mineStoneReady, currentCommandCompleted: true, currentCommandCompletionReason: failReason };
  const running = { ...mineStoneReady, currentCommandCompleted: false };
  // 3 fails (below the limit), one in-progress tick that clears the streak, then 3 more fails:
  // 6 failures total but never 4 consecutive -> no escalation.
  await feed(fail); await feed(fail); await feed(fail);
  await feed(running);
  await feed(fail); await feed(fail); await feed(fail);
  assert.equal(escalations, 0, 'a non-failing tick must reset the streak (never reached 4-in-a-row)');
});

test('R0: non-streak objectives keep their existing recovery path (DESCEND unaffected)', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const descentReady = createInitialState({
    logs: 6, planks: 16, sticks: 12, woodenPickaxes: 1, cobblestone: 12,
    stonePickaxes: 2, stoneSwords: 1, furnaces: 1, craftingTables: 1,
    tablePlaced: false, atIronDepth: false, x: 10.5, y: 24, z: -3.5,
  });
  const first = await orch.step(descentReady);
  assert.equal(first.objective, 'DESCEND');
  const failed = await orch.step({
    ...descentReady,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_water_adjacent:-1, 24, 11',
  });
  // DESCEND must still route through descent recovery, NOT the R0 repeated-failure path.
  assert.equal(failed.objective, 'DESCEND_RECOVERY');
  assert.equal(failed.signals.some((s) => s.reason === 'repeated_command_failure'), false);
  assert.ok(failed.signals.some((s) => s.evt === 'mission.objective.recovery_queued' && s.objective === 'DESCEND'));
});

test('terminal abort stays labeled aborted on later polls', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 4000, abortTimeoutMs: 60000 });
  const frozen = createInitialState({ logs: 0 });
  let terminal = null;
  for (let i = 0; i < 12; i += 1) {
    terminal = await orch.step(frozen);
    if (terminal.done) break;
    t += 3000;
  }
  assert.equal(terminal.done, true);
  assert.equal(terminal.intent.reason, 'mission:aborted');
  const later = await orch.step(frozen);
  assert.equal(later.intent.reason, 'mission:aborted');
  assert.equal(later.objective, 'ABORTED');
});

// ---- Tier-1.2 deterministic resource exploration -------------------------

test('EXPLORE triggers only on explicit exhausted local wood search and never calls the planner', async () => {
  const exhaustionReasons = [
    WOOD_SEARCH_EXHAUSTED,
    'gather_tree_failed:no_reachable_tree_logs:left_unreached=4',
    'gather_tree_complete:no_reachable_tree_logs',
  ];
  for (const reason of exhaustionReasons) {
    let deepseekCallCount = 0;
    const orch = new MissionOrchestrator({
      complete: async () => { deepseekCallCount += 1; throw new Error('planner must stay unused'); },
      exploreEnabled: true,
      abortTimeoutMs: 600000,
    });
    const base = woodSearchSnapshot({
      farPerception: farWoodPerception({
        targets: [
          { x: 180, z: 0, count: 4, biomeClass: 'wood_bearing' },
          { x: 120, z: 0, count: 2, biomeClass: 'wood_bearing' },
        ],
      }),
    });

    const local = await orch.step(base);
    assert.equal(local.objective, 'GATHER_WOOD');
    assert.equal(local.intent.action, 'gather_tree');

    const explore = await orch.step(exhaustedWoodSearch(base, reason));
    assert.equal(explore.objective, 'EXPLORE');
    assert.equal(explore.intent.action, 'navigate_to_point');
    assert.equal(explore.intent.targetX, 12, `nearest perceived wood direction was not selected for ${reason}`);
    assert.equal(explore.intent.targetZ, 0);
    assert.equal(explore.source, 'exploration');
    assert.equal(deepseekCallCount, 0);
  }

  const orch = new MissionOrchestrator({ complete: oracleBrain(), exploreEnabled: true, abortTimeoutMs: 600000 });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({ targets: [{ x: 120, z: 0, count: 2, biomeClass: 'wood_bearing' }] }),
  });
  await orch.step(base);
  const otherFailure = await orch.step(exhaustedWoodSearch(base, 'gather_tree_failed:collect_timeout:left_unreached=4'));
  assert.equal(otherFailure.objective, 'GATHER_WOOD');
  assert.equal(otherFailure.intent.action, 'gather_tree');
});

test('explicit local wood exhaustion hands off to EXPLORE before an expired global watchdog', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => now,
    exploreEnabled: true,
    abortTimeoutMs: 10,
    stallTimeoutMs: 60000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      targets: [{ x: 120, z: 0, count: 3, biomeClass: 'wood_bearing' }],
    }),
  });
  await orch.step(base);
  now += 20;

  const explore = await orch.step(exhaustedWoodSearch(base));

  assert.equal(explore.objective, 'EXPLORE');
  assert.equal(explore.intent.action, 'navigate_to_point');
  assert.ok(!explore.signals.some((signal) => signal.evt === 'mission.aborted'));

  now += 5;
  const walking = await orch.step(base);
  assert.equal(walking.objective, 'EXPLORE');
  assert.equal(walking.intent.action, 'navigate_to_point');
  assert.ok(!walking.signals.some((signal) => signal.evt === 'mission.aborted'));
});

test('EXPLORE prefers a wood-bearing direction over a high-count barren direction', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 150,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [
        { dx: 0, dz: -1, biomeClass: 'barren', resourceCount: 99, barrenChunks: 8, scannedChunks: 8 },
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', resourceCount: 0, woodBearingChunks: 1, scannedChunks: 2 },
        { dx: -1, dz: 0, biomeClass: 'unknown', resourceCount: 0, scannedChunks: 0 },
      ],
    }),
  });
  await orch.step(base);

  const explore = await orch.step(exhaustedWoodSearch(base));

  assert.equal(explore.objective, 'EXPLORE');
  assert.equal(explore.intent.targetX, 12);
  assert.equal(explore.intent.targetZ, 0);
  assert.ok(explore.signals.some((signal) => (
    signal.evt === 'exploration.leg.queued' && signal.biomeClass === 'wood_bearing'
  )));
});

test('EXPLORE prefers a flat wood direction over a cliff wood direction (terrain ranking traversability)', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 150,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [
        // abundant but a cliff (steep bucket) -- the unreachable-wood trap
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', resourceCount: 80, woodBearingChunks: 6, scannedChunks: 6, avgRoughness: 34 },
        // sparser but flat (traversable) -- should win
        { dx: 0, dz: 1, biomeClass: 'wood_bearing', resourceCount: 6, woodBearingChunks: 3, scannedChunks: 4, avgRoughness: 3 },
      ],
    }),
  });
  await orch.step(base);

  const explore = await orch.step(exhaustedWoodSearch(base));

  assert.equal(explore.objective, 'EXPLORE');
  // dominant axis is +z (the flat direction), not +x (the cliff)
  assert.equal(explore.intent.targetX, 0);
  assert.equal(explore.intent.targetZ, 12);
  assert.ok(explore.signals.some((signal) => (
    signal.evt === 'exploration.leg.queued' && signal.direction === '0,1'
  )));
});

test('EXPLORE steers around a steep wood target through a flat mixed octant', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 80,
    exploreHopBlocks: 12,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      targets: [{ x: 48, z: 0, count: 8, biomeClass: 'wood_bearing' }],
      directions: [
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', resourceCount: 8, avgRoughness: 30, scannedChunks: 3 },
        { dx: 1, dz: 1, biomeClass: 'mixed', avgRoughness: 2, scannedChunks: 3 },
      ],
    }),
  });
  await orch.step(base);

  const explore = await orch.step(exhaustedWoodSearch(base));

  assert.equal(explore.objective, 'EXPLORE');
  assert.ok(Math.abs(explore.intent.targetX - (12 / Math.sqrt(2))) < 0.001);
  assert.ok(Math.abs(explore.intent.targetZ - (12 / Math.sqrt(2))) < 0.001);
  assert.ok(explore.signals.some((signal) => (
    signal.evt === 'exploration.leg.queued'
      && signal.source === 'direction'
      && signal.direction === '1,1'
  )));

  const rejected = { ...base, currentCommandCompleted: true, currentCommandCompletionReason: 'target_rejected_no_path' };
  const diagonalRetry = await orch.step(rejected);
  assert.ok(diagonalRetry.intent.targetX > 0 && diagonalRetry.intent.targetZ > 0);
  const rotated = await orch.step(rejected);
  assert.equal(rotated.intent.targetX, 12);
  assert.equal(rotated.intent.targetZ, 0);
  assert.ok(rotated.signals.some((signal) => (
    signal.evt === 'exploration.direction.rotated'
      && signal.from === '1,1'
      && signal.to === '1,0'
  )));
});

test('EXPLORE never trades a steep wood direction for a flat barren one', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 80,
    exploreHopBlocks: 12,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', avgRoughness: 30, scannedChunks: 3 },
        { dx: 0, dz: 1, biomeClass: 'barren', avgRoughness: 1, barrenChunks: 3, scannedChunks: 3 },
      ],
    }),
  });
  await orch.step(base);

  const explore = await orch.step(exhaustedWoodSearch(base));

  assert.equal(explore.intent.targetX, 12);
  assert.equal(explore.intent.targetZ, 0);
});

test('EXPLORE chains current-position-derived hops and completes a leg by cumulative travel', async () => {
  let deepseekCallCount = 0;
  const orch = new MissionOrchestrator({
    complete: async () => { deepseekCallCount += 1; throw new Error('planner must stay unused'); },
    exploreEnabled: true,
    exploreLegBlocks: 24,
    exploreHopBlocks: 10,
    exploreArriveDist: 2,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  const queued = await orch.step(exhaustedWoodSearch(base));
  const walking = await orch.step(base);
  assert.equal(walking.objective, 'EXPLORE');
  assert.equal(walking.intent.targetX, queued.intent.targetX);
  assert.equal(walking.intent.targetZ, queued.intent.targetZ);

  const hop2 = await orch.step({ ...base, x: 10, z: 0 });
  assert.equal(hop2.objective, 'EXPLORE');
  assert.equal(hop2.intent.targetX, 20);
  assert.ok(hop2.signals.some((signal) => signal.evt === 'exploration.hop.arrived' && signal.hop === 1));
  const hop3 = await orch.step({ ...base, x: 20, z: 0 });
  assert.equal(hop3.objective, 'EXPLORE');
  assert.equal(hop3.intent.targetX, 24);
  const arrived = await orch.step({ ...base, x: 24, z: 0 });
  assert.equal(arrived.objective, 'GATHER_WOOD');
  assert.equal(arrived.intent.action, 'gather_tree');
  assert.equal(arrived.replanned, false);
  assert.ok(queued.signals.some((signal) => signal.evt === 'exploration.leg.queued'));
  assert.ok(arrived.signals.some((signal) => signal.evt === 'exploration.leg.arrived'));
  assert.equal(deepseekCallCount, 0);
});

test('EXPLORE fires on unreachable-but-present local wood (the unreachable-wood pass left_unreached)', async () => {
  const orch = new MissionOrchestrator({
    complete: async () => { throw new Error('planner must stay unused'); },
    exploreEnabled: true,
    exploreLegBlocks: 150,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  // Wood IS present locally (a tree in nearbyLogs) but the gather reached ZERO of it -> left_unreached.
  const unreachable = {
    ...base,
    nearbyLogs: [{ x: 5, y: 71, z: 0 }],
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_tree_failed:tree_exhausted:left_unreached=1',
  };
  const explore = await orch.step(unreachable);
  assert.equal(explore.objective, 'EXPLORE', 'unreachable local wood must hand off to EXPLORE, not stall to the watchdog');
  assert.ok(explore.signals.some((s) => s.evt === 'exploration.leg.queued'));
});

test('repeat zero-delta wood exhaustion escalates to EXPLORE despite local wood (no-net-progress escalation)', async () => {
  const orch = new MissionOrchestrator({
    complete: async () => { throw new Error('planner must stay unused'); },
    exploreEnabled: true,
    exploreLegBlocks: 150,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  // First search-exhausted completion WITH local wood: must stay on GATHER_WOOD (single
  // exhaustion = the next attempt usually harvests the local wood).
  const exhaustedWithWood = {
    ...base,
    nearbyLogs: [{ x: 5, y: 71, z: 0 }],
    inventoryLogCount: 5,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_tree_complete:bounded_search_exhausted:route_attempt_limit',
  };
  const first = await orch.step(exhaustedWithWood);
  assert.notEqual(first.objective, 'EXPLORE', 'a single exhaustion with local wood must keep gathering');
  // The reissued command runs (completion clears from the snapshot) ...
  await orch.step({ ...exhaustedWithWood, currentCommandCompleted: false, currentCommandCompletionReason: '' });
  // ... and exhausts AGAIN with ZERO net logs: the wood is provably not gatherable from here ->
  // EXPLORE fires with the escalation signal.
  const second = await orch.step(exhaustedWithWood);
  assert.equal(second.objective, 'EXPLORE', 'repeat zero-delta exhaustion must escalate to EXPLORE');
  assert.ok(second.signals.some((s) => s.evt === 'exploration.no_net_progress_escalation'));
  assert.ok(second.signals.some((s) => s.evt === 'exploration.leg.queued'));
});

test('a log gain between exhaustions resets the no-net-progress streak', async () => {
  const orch = new MissionOrchestrator({
    complete: async () => { throw new Error('planner must stay unused'); },
    exploreEnabled: true,
    exploreLegBlocks: 150,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  const exhaustedAt = (logs) => ({
    ...base,
    nearbyLogs: [{ x: 5, y: 71, z: 0 }],
    inventoryLogCount: logs,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_tree_complete:bounded_search_exhausted:search_timeout',
  });
  await orch.step(exhaustedAt(5));
  await orch.step({ ...exhaustedAt(5), currentCommandCompleted: false, currentCommandCompletionReason: '' });
  // Logs GREW between failures: the attempt made real progress, no escalation.
  const gained = await orch.step(exhaustedAt(9));
  assert.notEqual(gained.objective, 'EXPLORE', 'a gaining attempt must not escalate');
  assert.ok(!gained.signals.some((s) => s.evt === 'exploration.no_net_progress_escalation'));
});

test('EXPLORE fires on no_reachable_tree_logs with zero gathered (canopy-locked spawns)', async () => {
  const orch = new MissionOrchestrator({
    complete: async () => { throw new Error('planner must stay unused'); },
    exploreEnabled: true,
    exploreLegBlocks: 150,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  // a live run: 26 logs visible on a canopy world, NONE ever reachable, zero gathered.
  const canopyLocked = {
    ...base,
    nearbyLogs: [{ x: 23, y: 127, z: -1 }],
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_tree_failed:no_reachable_tree_logs:left_unreached=26',
  };
  const explore = await orch.step(canopyLocked);
  assert.equal(explore.objective, 'EXPLORE', 'a canopy-locked spawn must hand off to EXPLORE');
  assert.ok(explore.signals.some((s) => s.evt === 'exploration.leg.queued'));
});

test('EXPLORE keeps a dig-active hop alive past the normal stall budget (the dig-tolerance pass)', async () => {
  let clock = 1000;
  const orch = new MissionOrchestrator({
    complete: async () => { throw new Error('planner must stay unused'); },
    exploreEnabled: true,
    exploreLegBlocks: 200,
    exploreHopBlocks: 12,
    exploreArriveDist: 2,
    stallTimeoutMs: 10000,
    exploreHopDigTimeoutMs: 25000,
    abortTimeoutMs: 600000,
    now: () => clock,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  await orch.step(exhaustedWoodSearch(base)); // queues leg 1, hop 1
  // Bot pinned at origin (a blocker), but the substrate reports it is productively digging.
  const digging = { ...base, x: 0, z: 0, navDigActive: true };
  clock += 15000; // past stallTimeoutMs (10s) but under exploreHopDigTimeoutMs (25s)
  const stillDigging = await orch.step(digging);
  assert.equal(stillDigging.objective, 'EXPLORE');
  assert.ok(!stillDigging.signals.some((s) => s.evt === 'exploration.hop.failed'),
    'a productively-digging hop must not be declared failed at the normal stall budget');
  assert.ok(!stillDigging.signals.some((s) => s.evt === 'exploration.direction.rotated'),
    'a productively-digging hop must not trigger a direction rotation');
  assert.ok(stillDigging.signals.some((s) => s.evt === 'exploration.hop.digging'),
    'the dig-tolerance must emit an observable exploration.hop.digging signal');

  // A NON-digging hop pinned the same duration DOES stall out (control).
  let clock2 = 1000;
  const orch2 = new MissionOrchestrator({
    complete: async () => { throw new Error('planner must stay unused'); },
    exploreEnabled: true, exploreLegBlocks: 200, exploreHopBlocks: 12, exploreArriveDist: 2,
    stallTimeoutMs: 10000, exploreHopDigTimeoutMs: 25000, abortTimeoutMs: 600000, now: () => clock2,
  });
  await orch2.step(base);
  await orch2.step(exhaustedWoodSearch(base));
  clock2 += 15000;
  const stalledOut = await orch2.step({ ...base, x: 0, z: 0, navDigActive: false });
  assert.ok(stalledOut.signals.some((s) => s.evt === 'exploration.hop.failed'),
    'a pinned non-digging hop must fail at the normal stall budget');
});

test('EXPLORE arrived legs earn a second epoch with monotonic numbering capped at eight', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 10,
    exploreHopBlocks: 10,
    exploreArriveDist: 2,
    exploreLegLimit: 4,
    gatherRecoveryLimit: 0,
    abortTimeoutMs: 600000,
  });
  let snapshot = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 4, scannedChunks: 4 },
        { dx: 0, dz: 1, biomeClass: 'mixed', woodBearingChunks: 3, scannedChunks: 4 },
        { dx: -1, dz: 0, biomeClass: 'unknown', woodBearingChunks: 0, scannedChunks: 1 },
        { dx: 0, dz: -1, biomeClass: 'barren', barrenChunks: 4, scannedChunks: 4 },
      ],
    }),
  });
  await orch.step(snapshot);
  const signals = [];

  for (let leg = 1; leg <= 8; leg += 1) {
    const queued = await orch.step(exhaustedWoodSearch(snapshot));
    signals.push(...queued.signals);
    assert.equal(queued.objective, 'EXPLORE');
    assert.equal(queued.intent.action, 'navigate_to_point');
    snapshot = {
      ...snapshot,
      x: queued.intent.targetX,
      z: queued.intent.targetZ,
      currentCommandCompleted: false,
      currentCommandCompletionReason: '',
    };
    const arrived = await orch.step(snapshot);
    signals.push(...arrived.signals);
    assert.equal(arrived.objective, 'GATHER_WOOD');
    assert.equal(arrived.intent.action, 'gather_tree');
  }

  const capped = await orch.step(exhaustedWoodSearch(snapshot));
  signals.push(...capped.signals);
  assert.equal(capped.objective, 'ABORTED');
  assert.equal(capped.intent.action, 'stop');
  assert.equal(capped.done, true);
  const queuedLegs = signals.filter((signal) => signal.evt === 'exploration.leg.queued');
  assert.deepEqual(queuedLegs.map((signal) => signal.totalLeg), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(queuedLegs.map((signal) => [signal.epoch, signal.epochLeg]), [
    [1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [2, 4],
  ]);
  assert.equal(signals.filter((signal) => signal.evt === 'exploration.epoch.earned').length, 1);
  assert.equal(signals.filter((signal) => signal.evt === 'exploration.epoch.renewed').length, 1);
  assert.ok(capped.signals.some((signal) => (
    signal.evt === 'exploration.exhausted'
      && signal.epochsUsed === 2
      && signal.totalLegs === 8
      && signal.totalLimit === 8
  )));
  assert.ok(capped.signals.some((signal) => (
    signal.evt === 'mission.objective.exhausted'
      && signal.objective === 'GATHER_WOOD'
      && signal.reason === 'same_objective_reselected'
  )));
  assert.ok(capped.signals.some((signal) => signal.evt === 'mission.aborted' && signal.reason === 'objective_exhausted'));
});

test('EXPLORE partial wood gain earns one renewal after the current epoch is spent', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 40,
    exploreHopBlocks: 12,
    exploreLegLimit: 1,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    inventoryLogCount: 0,
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await orch.step(base);

  const gained = await orch.step({ ...base, inventoryLogCount: 3 });
  assert.equal(gained.signals.some((signal) => signal.evt === 'exploration.epoch.earned'), false);
  assert.equal(orch.state.exploreEpochProgressEarned, true);
  const leg1 = await orch.step(exhaustedWoodSearch({ ...base, inventoryLogCount: 3 }));
  assert.equal(leg1.objective, 'EXPLORE');
  assert.ok(leg1.signals.some((signal) => (
    signal.evt === 'exploration.epoch.earned'
      && signal.reason === 'wood_gain'
      && signal.phaseBaselineLogs === 0
      && signal.currentLogs === 3
  )));
  const rejected = {
    ...base,
    inventoryLogCount: 3,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'target_rejected_no_path',
  };
  await orch.step(rejected);
  const renewed = await orch.step(rejected);
  assert.equal(renewed.objective, 'EXPLORE');
  assert.ok(renewed.signals.some((signal) => (
    signal.evt === 'exploration.epoch.renewed'
      && signal.oldEpoch === 1
      && signal.newEpoch === 2
      && signal.previousEpochLegs === 1
      && signal.totalLegs === 1
      && signal.earningReasons.length === 1
      && signal.earningReasons[0] === 'wood_gain'
  )));
  assert.ok(renewed.signals.some((signal) => (
    signal.evt === 'exploration.leg.queued'
      && signal.epoch === 2
      && signal.epochLeg === 1
      && signal.totalLeg === 2
  )));
});

test('EXPLORE leg arrival earns renewal and clears direction exclusions', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 10,
    exploreHopBlocks: 10,
    exploreArriveDist: 2,
    exploreLegLimit: 1,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  const first = await orch.step(exhaustedWoodSearch(base));
  const atFrontier = { ...base, x: first.intent.targetX, z: first.intent.targetZ };
  const arrived = await orch.step(atFrontier);
  assert.ok(arrived.signals.some((signal) => (
    signal.evt === 'exploration.epoch.earned' && signal.reason === 'leg_arrival'
  )));
  assert.equal(orch.state.exploreTriedDirections.has('1,0'), true);

  const renewed = await orch.step(exhaustedWoodSearch(atFrontier));
  assert.equal(renewed.objective, 'EXPLORE');
  assert.equal(renewed.intent.targetX, atFrontier.x + 10);
  assert.equal(renewed.intent.targetZ, atFrontier.z);
  assert.ok(renewed.signals.some((signal) => signal.evt === 'exploration.epoch.renewed'));
  assert.equal(orch.state.exploreTriedDirections.size, 0);
});

test('EXPLORE no-progress failures still exhaust after the original four legs', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 80,
    exploreHopBlocks: 12,
    exploreLegLimit: 4,
    gatherRecoveryLimit: 0,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 },
        { dx: 0, dz: 1, biomeClass: 'mixed', scannedChunks: 2 },
        { dx: -1, dz: 0, biomeClass: 'unknown', scannedChunks: 1 },
        { dx: 0, dz: -1, biomeClass: 'barren', scannedChunks: 2 },
      ],
    }),
  });
  await orch.step(base);
  const signals = [];
  let out = await orch.step(exhaustedWoodSearch(base));
  signals.push(...out.signals);
  const rejected = {
    ...base,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'target_rejected_no_path',
  };
  for (let leg = 1; leg <= 4; leg += 1) {
    out = await orch.step(rejected);
    signals.push(...out.signals);
    out = await orch.step(rejected);
    signals.push(...out.signals);
  }
  assert.equal(out.objective, 'ABORTED');
  assert.equal(signals.filter((signal) => signal.evt === 'exploration.leg.queued').length, 4);
  assert.equal(signals.some((signal) => signal.evt === 'exploration.epoch.earned'), false);
  assert.equal(signals.some((signal) => signal.evt === 'exploration.epoch.renewed'), false);
  assert.ok(signals.some((signal) => (
    signal.evt === 'exploration.exhausted'
      && signal.epochsUsed === 1
      && signal.totalLegs === 4
  )));
});

test('EXPLORE hop, frontier, safe-drop, and small movement progress do not earn renewal', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 80,
    exploreHopBlocks: 12,
    exploreArriveDist: 2,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  await orch.step(exhaustedWoodSearch(base));
  const hop = await orch.step({
    ...base,
    x: 12,
    explorationFrontierReached: true,
    explorationSafeDropLanded: true,
  });
  assert.ok(hop.signals.some((signal) => signal.evt === 'exploration.hop.arrived'));
  assert.equal(hop.signals.some((signal) => signal.evt === 'exploration.epoch.earned'), false);
  assert.equal(orch.state.exploreEpochProgressEarned, false);
});

test('EXPLORE epoch events deduplicate and retain every earning reason', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 10,
    exploreHopBlocks: 10,
    exploreArriveDist: 2,
    exploreLegLimit: 1,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    inventoryLogCount: 0,
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  const earned = [];
  earned.push(...(await orch.step({ ...base, inventoryLogCount: 1 })).signals);
  earned.push(...(await orch.step({ ...base, inventoryLogCount: 2 })).signals);
  const first = await orch.step(exhaustedWoodSearch({ ...base, inventoryLogCount: 2 }));
  earned.push(...first.signals);
  const atFrontier = { ...base, inventoryLogCount: 2, x: first.intent.targetX, z: first.intent.targetZ };
  earned.push(...(await orch.step(atFrontier)).signals);
  const renewed = await orch.step(exhaustedWoodSearch(atFrontier));
  assert.equal(earned.filter((signal) => signal.evt === 'exploration.epoch.earned').length, 1);
  assert.deepEqual(
    renewed.signals.find((signal) => signal.evt === 'exploration.epoch.renewed').earningReasons,
    ['wood_gain', 'leg_arrival'],
  );
});

test('EXPLORE epoch two never renews after additional progress', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 10,
    exploreHopBlocks: 10,
    exploreArriveDist: 2,
    exploreLegLimit: 1,
    gatherRecoveryLimit: 0,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  const first = await orch.step(exhaustedWoodSearch(base));
  let position = { ...base, x: first.intent.targetX, z: first.intent.targetZ };
  await orch.step(position);
  const second = await orch.step(exhaustedWoodSearch(position));
  position = { ...position, x: second.intent.targetX, z: second.intent.targetZ, inventoryLogCount: 1 };
  const secondArrival = await orch.step(position);
  assert.equal(secondArrival.signals.some((signal) => signal.evt === 'exploration.epoch.earned'), false);
  const exhausted = await orch.step(exhaustedWoodSearch(position));
  assert.equal(exhausted.objective, 'ABORTED');
  assert.equal(exhausted.signals.some((signal) => signal.evt === 'exploration.epoch.renewed'), false);
  assert.ok(exhausted.signals.some((signal) => (
    signal.evt === 'exploration.exhausted' && signal.epochsUsed === 2 && signal.totalLegs === 2
  )));
});

test('GATHER_WOOD completion prevents renewal and a later fresh wood phase resets allowance', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({ inventoryLogCount: 0 });
  await orch.step(base);
  const sufficient = {
    ...base,
    logs: THRESHOLDS.woodForIronArmorMission,
    inventoryLogCount: THRESHOLDS.woodForIronArmorMission,
  };
  const completed = await orch.step(sufficient);
  assert.equal(completed.signals.some((signal) => signal.evt === 'exploration.epoch.earned'), false);
  assert.equal(orch.state.explorePhaseBaselineLogs, null);

  orch.state.currentObjective = null;
  orch.state.lastOutcome = 'done:MAKE_WOOD_TOOLS';
  orch.state.exploreEpoch = 2;
  orch.state.exploreEpochLegsUsed = 4;
  orch.state.exploreLegsUsed = 8;
  orch.state.exploreTriedDirections.add('1,0');
  const fresh = await orch.step(base);
  assert.equal(fresh.objective, 'GATHER_WOOD');
  assert.equal(orch.state.exploreEpoch, 1);
  assert.equal(orch.state.exploreEpochLegsUsed, 0);
  assert.equal(orch.state.exploreLegsUsed, 0);
  assert.equal(orch.state.exploreTriedDirections.size, 0);
  assert.equal(orch.state.explorePhaseBaselineLogs, 0);
});

test('EXPLORE rotates after two rejected hops and excludes every tried direction', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 80,
    exploreHopBlocks: 12,
    exploreLegLimit: 4,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 },
        { dx: 0, dz: -1, biomeClass: 'mixed', woodBearingChunks: 1, scannedChunks: 2 },
        { dx: -1, dz: 0, biomeClass: 'unknown', scannedChunks: 1 },
      ],
    }),
  });
  await orch.step(base);
  const east = await orch.step(exhaustedWoodSearch(base));
  assert.equal(east.intent.targetX, 12);
  assert.equal(east.intent.targetZ, 0);

  const rejected = { ...base, currentCommandCompleted: true, currentCommandCompletionReason: 'target_rejected_no_path' };
  const eastRetry = await orch.step(rejected);
  assert.equal(eastRetry.objective, 'EXPLORE');
  assert.equal(eastRetry.intent.targetX, 12);
  assert.ok(eastRetry.signals.some((signal) => signal.evt === 'exploration.hop.failed' && signal.consecutiveFailures === 1));

  const north = await orch.step(rejected);
  assert.equal(north.objective, 'EXPLORE');
  assert.equal(north.intent.targetX, 0);
  assert.equal(north.intent.targetZ, -12);
  assert.ok(north.signals.some((signal) => signal.evt === 'exploration.direction.rotated' && signal.from === '1,0' && signal.to === '0,-1'));

  await orch.step(rejected);
  const west = await orch.step(rejected);
  assert.equal(west.intent.targetX, -12);
  assert.equal(west.intent.targetZ, 0);
  assert.ok(west.signals.some((signal) => (
    signal.evt === 'exploration.direction.rotated'
      && signal.to === '-1,0'
      && signal.tried.includes('1,0')
      && signal.tried.includes('0,-1')
  )));
});

test('EXPLORE rotates after two bounded no-progress hops without waiting a leg window', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => now,
    exploreEnabled: true,
    exploreHopBlocks: 12,
    exploreLegBlocks: 80,
    stallTimeoutMs: 10,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [
        { dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 },
        { dx: 0, dz: 1, biomeClass: 'mixed', scannedChunks: 2 },
      ],
    }),
  });
  await orch.step(base);
  await orch.step(exhaustedWoodSearch(base));

  now += 11;
  const retry = await orch.step(base);
  assert.ok(retry.signals.some((signal) => signal.evt === 'exploration.hop.failed' && signal.reason === 'no_progress'));
  assert.equal(retry.intent.targetX, 12);

  now += 11;
  const rotated = await orch.step(base);
  assert.equal(rotated.objective, 'EXPLORE');
  assert.equal(rotated.intent.targetX, 0);
  assert.equal(rotated.intent.targetZ, 12);
  assert.ok(rotated.signals.some((signal) => signal.evt === 'exploration.direction.rotated'));
});

// ---- bounded authority / robustness to a broken brain ----------------------

test('a junk (non-JSON) brain still completes the mission via deterministic oracle-primary path', async () => {
  const junkBrain = async () => 'sorry, I am not going to answer in JSON';
  const orch = new MissionOrchestrator({ complete: junkBrain });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  assert.equal(res.done, true, 'mission did not complete under a junk brain');
  const chosen = res.signals.filter((s) => s.evt === 'mission.objective.chosen');
  assert.ok(chosen.length > 0 && chosen.every((s) => s.source === 'oracle'), 'expected every choice to come from oracle-primary');
});

test('forced LLM mode still falls back cleanly on junk output', async () => {
  const junkBrain = async () => 'sorry, I am not going to answer in JSON';
  const orch = new MissionOrchestrator({ complete: junkBrain, forceLlm: true });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  assert.equal(res.done, true, 'mission did not complete under forced junk brain');
  const chosen = res.signals.filter((s) => s.evt === 'mission.objective.chosen');
  assert.ok(chosen.length > 0 && chosen.every((s) => s.source === 'fallback'), 'expected forced junk choices to fall back');
});
