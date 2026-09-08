import assert from 'node:assert/strict';
import test from 'node:test';

import { THRESHOLDS, expectedObjective, rawIronFuelFingerprint } from './mission-planner.js';
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
    onGround: true,
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
  const state = createInitialState({
    stonePickaxes: 1,
    stoneSwords: 1,
    tablePlaced: true,
    craftingTables: 0,
    planks: 4,
    sticks: 4,
    cobblestone: 3,
    totalStonePickaxeRemaining: 156,
  });
  assert.equal(nextActionForObjective('DESCEND', state), 'retrieve_table');
  assert.equal(
    nextActionForObjective('DESCEND', state, { retrieveTableSkipped: true }),
    'craft_table'
  );
  const woodState = createInitialState({ woodenPickaxes: 1, tablePlaced: true, craftingTables: 0 });
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', woodState), 'retrieve_table');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', woodState, { retrieveTableSkipped: true }), null);
});

test('nextActionForObjective maps objectives to valid low-level action ids', () => {
  const descentReady = {
    stonePickaxes: 2,
    craftingTables: 1,
    sticks: 4,
    cobblestone: 3,
    totalStonePickaxeRemaining: 156,
  };
  assert.deepEqual(nextActionForObjective('GATHER_WOOD', createInitialState()), {
    action: 'gather_tree',
    ttlMs: 45000,
    completionInventoryLogCount: 20,
    completionInventoryPlankCount: 48,
  });
  assert.deepEqual(
    nextActionForObjective('GATHER_WOOD', createInitialState({ targetIronPickaxeOnly: true })),
    {
      action: 'gather_tree',
      ttlMs: 45000,
      completionInventoryLogCount: 5,
      completionInventoryPlankCount: 18,
    },
  );
  assert.deepEqual(
    nextActionForObjective('GATHER_WOOD', createInitialState({ targetDiamondTier: true })),
    {
      action: 'gather_tree',
      ttlMs: 45000,
      completionInventoryLogCount: 5,
      completionInventoryPlankCount: 18,
    },
  );
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ logs: 4 })), 'craft_planks');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ logs: 10, planks: 12 })), 'craft_planks');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ targetIronPickaxeOnly: true, logs: 10, planks: THRESHOLDS.planksForIronPickaxeMission - 1 })), 'craft_planks');
  assert.equal(nextActionForObjective('MAKE_WOOD_TOOLS', createInitialState({ targetIronPickaxeOnly: true, logs: 10, planks: THRESHOLDS.planksForIronPickaxeMission })), 'craft_sticks');
  assert.deepEqual(nextActionForObjective('MINE_STONE', createInitialState({ woodenPickaxes: 1 })), {
    action: 'mine_nearby_stone',
    ttlMs: 45000,
    completionInventoryCobblestoneCount: 8,
  });
  assert.deepEqual(nextActionForObjective('MINE_STONE', createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    y: 70,
  })), {
    action: 'mine_nearby_stone',
    ttlMs: 45000,
    completionInventoryCobblestoneCount: 11,
  });
  assert.deepEqual(nextActionForObjective('MINE_STONE', createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    y: 70,
  })), {
    action: 'mine_nearby_stone',
    ttlMs: 45000,
    completionInventoryCobblestoneCount: 14,
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
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ stonePickaxes: 1, cobblestone: 2, sticks: 2, tablePlaced: true, targetIronPickaxeOnly: true, atIronDepth: true })), 'retrieve_table');
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({ stonePickaxes: 1, cobblestone: 2, sticks: 2, tablePlaced: false, targetIronPickaxeOnly: true, atIronDepth: true })), null);
  assert.deepEqual(nextActionForObjective('DESCEND', createInitialState(descentReady)), {
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
  assert.equal(nextActionForObjective('DESCEND', createInitialState({ ...descentReady, craftingTables: 0, tablePlaced: true, planks: 0, logs: 0 })), 'retrieve_table');
  assert.equal(nextActionForObjective('DESCEND', createInitialState({ ...descentReady, craftingTables: 0, tablePlaced: true, planks: 4 })), 'retrieve_table');
  assert.deepEqual(nextActionForObjective('DESCEND', createInitialState(descentReady)), {
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
  assert.deepEqual(nextActionForObjective('DESCEND', createInitialState({
    ...descentReady,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 120,
    x: 10.5,
    y: 24,
    z: -3.5,
  })), {
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

test('mining manifest prepares deterministically, deduplicates status, and gates descent', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const needsTable = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    planks: 4,
    sticks: 4,
    cobblestone: 3,
    totalStonePickaxeRemaining: 156,
  });

  const preparing = await orch.step(needsTable);
  assert.equal(preparing.objective, 'DESCEND');
  assert.equal(preparing.intent.action, 'craft_table');
  assert.equal(
    preparing.signals.filter((signal) => signal.evt === 'mission.mining_manifest.preparing').length,
    1,
  );

  const repeated = await orch.step(needsTable);
  assert.equal(repeated.intent.action, 'craft_table');
  assert.equal(
    repeated.signals.some((signal) => signal.evt.startsWith('mission.mining_manifest.')),
    false,
  );

  const ready = await orch.step({
    ...needsTable,
    planks: 0,
    craftingTables: 1,
  });
  assert.equal(ready.intent.action, 'descend_staircase');
  assert.equal(
    ready.signals.filter((signal) => signal.evt === 'mission.mining_manifest.ready').length,
    1,
  );
  assert.equal(ready.signals.find((signal) => signal.evt === 'mission.mining_manifest.ready')?.requiredDurability, 156);
});

test('mining manifest preserves stick and cobblestone reserves while adding durability', () => {
  const base = createInitialState({
    stonePickaxes: 1,
    stoneSwords: 1,
    furnaces: 1,
    tablePlaced: true,
    planks: 2,
    sticks: 4,
    cobblestone: 6,
    totalStonePickaxeRemaining: 131,
  });
  assert.equal(nextActionForObjective('DESCEND', base), 'craft_sticks');
  assert.equal(nextActionForObjective('DESCEND', { ...base, sticks: 6, cobblestone: 5 }), null);
  assert.equal(nextActionForObjective('DESCEND', { ...base, sticks: 6 }), 'craft_stone_pickaxe');
  assert.equal(nextActionForObjective('DESCEND', {
    ...base,
    sticks: 4,
    cobblestone: 3,
    totalStonePickaxeRemaining: 156,
    craftingTables: 0,
  }), 'retrieve_table');
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
  const chestplateInInventory = createInitialState({
    ironChestplates: 1,
    ironIngots: 0,
    tablePlaced: false,
    equippedArmorPieces: 0,
  });
  assert.equal(nextActionForObjective('MAKE_ARMOR', chestplateInInventory), 'equip_armor',
    'out-of-order verified chest armor is equipped before crafting the canonical first gap');
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

test('returnable mining workspace emits final smelt and gear actions without replacement workstations', () => {
  const remoteWorkspace = {
    atIronDepth: true,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: true,
    miningWorkspaceBreadcrumbCount: 72,
    tablePlaced: false,
    furnacePlaced: false,
    craftingTables: 0,
    furnaces: 0,
  };
  assert.equal(nextActionForObjective('MAKE_FURNACE', createInitialState({
    ...remoteWorkspace,
    cobblestone: 16,
    planks: 8,
  })), null);
  assert.deepEqual(nextActionForObjective('SMELT_IRON', createInitialState({
    ...remoteWorkspace,
    rawIron: 3,
    fuel: 4,
    sticks: 2,
  })), { action: 'smelt_raw_iron', ttlMs: 45000 });
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({
    ...remoteWorkspace,
    ironIngots: 3,
    sticks: 2,
  })), 'craft_iron_pickaxe');
  assert.equal(nextActionForObjective('MAKE_ARMOR', createInitialState({
    ...remoteWorkspace,
    ironIngots: 8,
  })), 'craft_iron_helmet');
  assert.equal(nextActionForObjective('MAKE_STONE_TOOLS', createInitialState({
    ...remoteWorkspace,
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    bestStonePickaxeRemaining: 10,
    totalStonePickaxeRemaining: 10,
    cobblestone: 3,
    sticks: 4,
  })), 'craft_stone_pickaxe', 'remote table access must emit the final restock craft');

  const disconnected = { ...remoteWorkspace, miningWorkspaceReturnAvailable: false };
  assert.equal(nextActionForObjective('MAKE_IRON_TOOLS', createInitialState({
    ...disconnected,
    ironIngots: 3,
    sticks: 2,
    planks: 4,
  })), 'craft_table');
  assert.equal(nextActionForObjective('SMELT_IRON', createInitialState({
    ...disconnected,
    rawIron: 3,
    fuel: 4,
    craftingTables: 1,
  })), 'place_table');
  assert.equal(nextActionForObjective('MAKE_ARMOR', createInitialState({
    ...disconnected,
    ironIngots: 8,
    planks: 4,
  })), 'craft_table');

  const residentWorkspace = {
    ...disconnected,
    miningWorkspaceAtSite: true,
  };
  assert.deepEqual(nextActionForObjective('SMELT_IRON', createInitialState({
    ...residentWorkspace,
    rawIron: 3,
    fuel: 4,
  })), { action: 'smelt_raw_iron', ttlMs: 45000 });
  assert.equal(nextActionForObjective('MAKE_ARMOR', createInitialState({
    ...residentWorkspace,
    ironIngots: 8,
  })), 'craft_iron_helmet');
});

test('mission iron intents carry the frozen goal reserve contract and prepare through a remote workspace', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 14,
    x: 4,
    z: 8,
  });
  const mining = await orch.step(ready);
  assert.equal(mining.intent.action, 'mine_nearby_iron');
  assert.equal(mining.intent.remainingMissionIronCount, 3);
  assert.equal(mining.intent.reservedIronPickaxeCount, 1);
  assert.equal(mining.intent.reservedIronPickaxeDurabilityFloor, 64);
  assert.ok(mining.signals.some((signal) => signal.evt === 'mission.mine_iron.tool_reserve.ready'));

  const clocks = {
    started: orch.state.objectiveStartedAtMs,
    failures: orch.state.objectiveFailures.MINE_IRON || 0,
    heading: orch.state.ironSearchPendingHeading,
  };
  const restock = await orch.step({
    ...ready,
    totalStonePickaxeRemaining: 10,
    cobblestone: 3,
    sticks: 4,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: true,
    currentCommandId: 'iron-lane-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_complete:same_plane_continue',
  });
  assert.equal(restock.intent.action, 'craft_stone_pickaxe');
  assert.equal(restock.intent.reason, 'mission:MINE_IRON');
  assert.equal(restock.intent.reservedIronPickaxeDurabilityFloor, undefined,
    'reserve fields are limited to mining and exact recovery intents');
  assert.equal(restock.source, 'same_plane_continue');
  assert.ok(restock.signals.some((signal) => (
    signal.evt === 'mission.mine_iron.tool_reserve.preparing'
      && signal.action === 'craft_stone_pickaxe'
  )));
  assert.deepEqual({
    started: orch.state.objectiveStartedAtMs,
    failures: orch.state.objectiveFailures.MINE_IRON || 0,
    heading: orch.state.ironSearchPendingHeading,
  }, clocks);
});

test('iron recovery prepares reserve-safe tools before dispatch and preserves the pending recovery', async () => {
  let now = 1_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    stallTimeoutMs: 60000,
    abortTimeoutMs: 120000,
    now: () => now,
  });
  const mineReady = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    sticks: 4,
    cobblestone: 3,
    tablePlaced: false,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: true,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 12,
  });
  await orch.step(mineReady);
  const preparing = await orch.step({
    ...mineReady,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_failed:mine_nearby_iron_no_visible_ore',
  });
  assert.equal(preparing.intent.action, 'craft_stone_pickaxe');
  assert.equal(preparing.intent.reason, 'mission:MINE_IRON');
  assert.equal(preparing.source, 'recovery_preparation');
  assert.equal(orch.state.pendingRecoveryIntent?.reason, 'mission:MINE_IRON_RECOVERY');
  const frozenRecoveryHeading = orch.state.ironSearchPendingHeading;
  assert.ok(typeof frozenRecoveryHeading === 'string' && frozenRecoveryHeading.length > 0);
  const clocksDuringPreparation = {
    global: orch.state.globalProgressAtMs,
    objective: orch.state.objectiveProgressAtMs,
    started: orch.state.objectiveStartedAtMs,
  };

  now += 500;
  const inFlight = await orch.step({
    ...mineReady,
    x: 5,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    currentCommandId: 'recovery-restock-1',
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(inFlight.intent.action, 'craft_stone_pickaxe');
  assert.deepEqual({
    global: orch.state.globalProgressAtMs,
    objective: orch.state.objectiveProgressAtMs,
    started: orch.state.objectiveStartedAtMs,
  }, clocksDuringPreparation);

  now += 500;
  const recovery = await orch.step({
    ...mineReady,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 131,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'craft_stone_pickaxe_complete:inventory_delta',
  });
  assert.equal(recovery.intent.action, 'descend_staircase');
  assert.equal(recovery.intent.reason, 'mission:MINE_IRON_RECOVERY');
  assert.equal(recovery.source, 'recovery');
  assert.equal(recovery.intent.reservedIronPickaxeDurabilityFloor, 64);
  assert.equal(orch.state.currentObjective, 'MINE_IRON');
  assert.equal(orch.state.ironSearchPendingHeading, frozenRecoveryHeading);
  assert.equal(orch.state.pendingRecoveryIntent, null);
});

test('mid-recovery tool loss is neutral reserve feedback rather than an iron-search failure', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    sticks: 2,
    cobblestone: 3,
    tablePlaced: true,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 12,
  });
  await orch.step(ready);
  const recovery = await orch.step({
    ...ready,
    currentCommandId: 'iron-before-recovery-loss',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_failed:mine_nearby_iron_no_visible_ore',
  });
  assert.equal(recovery.intent.reason, 'mission:MINE_IRON_RECOVERY');
  const heading = orch.state.ironSearchPendingHeading;
  const failures = orch.state.objectiveFailures.MINE_IRON;

  const feedback = await orch.step({
    ...ready,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    cobblestone: 0,
    sticks: 0,
    planks: 0,
    logs: 0,
    tablePlaced: false,
    currentCommandId: 'iron-recovery-tool-loss',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_complete:tool_reserve_unavailable',
  });
  assert.equal(feedback.done, false);
  assert.equal(feedback.objective, 'MINE_IRON');
  assert.equal(feedback.intent.action, 'stop');
  assert.equal(orch.state.objectiveFailures.MINE_IRON, failures);
  assert.equal(orch.state.ironSearchPendingHeading, heading);
  assert.equal(feedback.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(feedback.signals.some((signal) => signal.evt === 'mission.iron_search.direction_rotated'), false);
});

test('iron reserve stick preparation preserves the six-plank field kit', () => {
  const base = {
    targetIronPickaxeOnly: true,
    atIronDepth: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 1,
    sticks: 0,
    cobblestone: 3,
    logs: 0,
    tablePlaced: true,
  };
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ ...base, planks: 7 })), null);
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ ...base, planks: 8 })), 'craft_sticks');
});

test('local iron tool restock admits the complete table chain only above the plank reserve', () => {
  const withSticks = {
    targetIronPickaxeOnly: false,
    atIronDepth: true,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    ironPickaxes: 1,
    bestIronPickaxeRemaining: 64,
    inventoryDurability: [
      { itemId: 'minecraft:iron_pickaxe', remainingDurability: 64 },
    ],
    sticks: 2,
    cobblestone: 3,
    logs: 0,
    tablePlaced: false,
    craftingTables: 0,
    miningWorkspaceAvailable: false,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: false,
  };
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ ...withSticks, planks: 9 })), null);
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ ...withSticks, planks: 10 })), 'craft_table');

  const withoutSticks = { ...withSticks, sticks: 0 };
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ ...withoutSticks, planks: 11 })), null);
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({ ...withoutSticks, planks: 12 })), 'craft_sticks');
  assert.equal(nextActionForObjective('MINE_IRON', createInitialState({
    ...withSticks,
    planks: 6,
    logs: 1,
  })), 'craft_planks');
});

test('neutral executor tool-reserve feedback prepares once without charging iron recovery', async () => {
  let now = 1_000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 14,
  });
  await orch.step(ready);
  orch.state.objectiveFailures.MINE_IRON = 2;
  orch.state.consecutiveFailureKey = 'sentinel';
  orch.state.consecutiveFailureCount = 2;
  const before = {
    started: orch.state.objectiveStartedAtMs,
    progress: orch.state.objectiveProgressAtMs,
    failures: orch.state.objectiveFailures.MINE_IRON,
    heading: orch.state.ironSearchPendingHeading,
    tried: [...orch.state.ironSearchTriedHeadings],
    pendingRecovery: orch.state.pendingRecoveryIntent,
    lastOutcome: orch.state.lastOutcome,
  };
  now += 500;
  const feedback = await orch.step({
    ...ready,
    totalStonePickaxeRemaining: 10,
    cobblestone: 3,
    sticks: 4,
    tablePlaced: true,
    currentCommandId: 'iron-reserve-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_complete:tool_reserve_required',
  });
  assert.equal(feedback.intent.action, 'craft_stone_pickaxe');
  assert.equal(feedback.source, 'tool_reserve');
  assert.deepEqual({
    started: orch.state.objectiveStartedAtMs,
    progress: orch.state.objectiveProgressAtMs,
    failures: orch.state.objectiveFailures.MINE_IRON,
    heading: orch.state.ironSearchPendingHeading,
    tried: [...orch.state.ironSearchTriedHeadings],
    pendingRecovery: orch.state.pendingRecoveryIntent,
    lastOutcome: orch.state.lastOutcome,
  }, before);
  assert.equal(feedback.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(feedback.signals.some((signal) => signal.evt === 'mission.iron_search.direction_rotated'), false);
  assert.equal(feedback.signals.some((signal) => signal.evt === 'mission.objective.recovery_queued'), false);
});

test('unavailable workspace restock is classified once then aborts as a bounded resource failure', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 14,
  });
  await orch.step(ready);
  const unavailable = {
    ...ready,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    cobblestone: 0,
    sticks: 0,
    planks: 0,
    logs: 0,
    tablePlaced: false,
    craftingTables: 0,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: false,
    currentCommandId: 'restock-unavailable-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'craft_stone_pickaxe_failed:tool_reserve_unavailable',
  };

  const first = await orch.step(unavailable);
  assert.equal(first.done, false);
  assert.equal(first.objective, 'MINE_IRON');
  assert.equal(first.signals.filter((signal) => signal.evt === 'mission.mine_iron.tool_reserve.blocked').length, 1);
  assert.equal(first.signals.filter((signal) => signal.evt === 'mission.resource.failed').length, 1);
  assert.equal(first.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(first.signals.some((signal) => signal.evt === 'mission.iron_search.direction_rotated'), false);
  assert.equal(orch.state.objectiveFailures.MINE_IRON || 0, 0);

  const second = await orch.step({
    ...unavailable,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(second.done, true);
  assert.equal(second.objective, 'ABORTED');
  assert.equal(second.signals.filter((signal) => signal.evt === 'mission.mine_iron.tool_reserve.blocked').length, 0);
  assert.ok(second.signals.some((signal) => (
    signal.evt === 'mission.objective.exhausted' && signal.reason === 'tool_reserve_unavailable'
  )));
  assert.ok(second.signals.some((signal) => (
    signal.evt === 'mission.aborted' && signal.reason === 'resource_unavailable'
  )));
  assert.equal(second.signals.some((signal) => signal.reason === 'iron_search_exhausted'), false);
});

test('unchanged blocked fixture resources cannot re-enter replacement-table preparation', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 14,
  });
  await orch.step(ready);
  const blockedFixture = {
    ...ready,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    cobblestone: 3,
    sticks: 2,
    planks: 4,
    logs: 0,
    tablePlaced: false,
    craftingTables: 0,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: false,
    currentCommandId: 'restock-blocked-fixture-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'craft_stone_pickaxe_failed:tool_reserve_unavailable',
  };

  const first = await orch.step(blockedFixture);
  assert.equal(first.done, false);
  assert.equal(first.intent.action, 'stop');
  const second = await orch.step({
    ...blockedFixture,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(second.done, true);
  assert.equal(second.objective, 'ABORTED');
  assert.equal(second.intent.action, 'stop');
  assert.equal(second.signals.some((signal) => signal.action === 'craft_table'), false);
  assert.ok(second.signals.some((signal) => (
    signal.evt === 'mission.objective.exhausted' && signal.reason === 'tool_reserve_unavailable'
  )));
});

test('post-resume restock identity failure is neutral infrastructure feedback', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 14,
  });
  await orch.step(ready);
  const feedback = await orch.step({
    ...ready,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    cobblestone: 0,
    sticks: 0,
    planks: 0,
    logs: 0,
    currentCommandId: 'post-resume-identity-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_complete:tool_reserve_unavailable',
  });

  assert.equal(feedback.done, false);
  assert.equal(feedback.objective, 'MINE_IRON');
  assert.equal(feedback.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(feedback.signals.some((signal) => signal.evt === 'mission.iron_search.direction_rotated'), false);
  assert.equal(orch.state.objectiveFailures.MINE_IRON || 0, 0);
});

test('changed restock resources clear the blocked fingerprint and admit corrective crafting', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 14,
  });
  await orch.step(ready);
  const unavailable = {
    ...ready,
    stonePickaxes: 0,
    totalStonePickaxeRemaining: 0,
    cobblestone: 0,
    sticks: 0,
    planks: 0,
    logs: 0,
    tablePlaced: false,
    craftingTables: 0,
    miningWorkspaceAvailable: false,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: false,
    currentCommandId: 'restock-unavailable-2',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'craft_stone_pickaxe_failed:tool_reserve_unavailable',
  };
  await orch.step(unavailable);

  const recovered = await orch.step({
    ...unavailable,
    cobblestone: 3,
    sticks: 4,
    tablePlaced: true,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(recovered.done, false);
  assert.equal(recovered.objective, 'MINE_IRON');
  assert.equal(recovered.intent.action, 'craft_stone_pickaxe');
  assert.equal(recovered.signals.some((signal) => signal.evt === 'mission.aborted'), false);
});

test('authoritative iron satisfaction outranks stale tool-restock failure feedback', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const ready = createInitialState({
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    totalStonePickaxeRemaining: 100,
    stoneSwords: 1,
    furnaces: 1,
    furnacePlaced: true,
    atIronDepth: true,
    y: 14,
  });
  await orch.step(ready);
  const result = await orch.step({
    ...ready,
    rawIron: 3,
    currentCommandId: 'restock-stale-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'craft_stone_pickaxe_failed:tool_reserve_unavailable',
  });

  assert.equal(result.signals.some((signal) => signal.evt === 'mission.mine_iron.tool_reserve.blocked'), false);
  assert.ok(result.signals.some((signal) => (
    signal.evt === 'mission.objective.complete' && signal.objective === 'MINE_IRON'
  )));
});

test('neutral workspace fallback completion keeps the unmet objective and selects local setup', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const remoteWorkspace = createInitialState({
    stonePickaxes: 2,
    stoneSwords: 1,
    atIronDepth: true,
    miningWorkspaceAvailable: true,
    miningWorkspaceAtSite: false,
    miningWorkspaceReturnAvailable: true,
    miningWorkspaceBreadcrumbCount: 13,
    tablePlaced: false,
    furnacePlaced: false,
    craftingTables: 0,
    furnaces: 0,
    cobblestone: 8,
    planks: 4,
    sticks: 2,
    rawIron: 3,
    fuel: 4,
  });

  const initial = await orch.step(remoteWorkspace);
  assert.equal(initial.objective, 'SMELT_IRON');
  assert.equal(initial.intent.action, 'smelt_raw_iron');

  const fallback = await orch.step({
    ...remoteWorkspace,
    miningWorkspaceReturnAvailable: false,
    currentCommandId: 'smelt-remote-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'smelt_raw_iron_complete:mining_workspace_local_fallback_required',
  });

  assert.equal(fallback.objective, 'SMELT_IRON');
  assert.equal(fallback.intent.action, 'craft_table');
  assert.equal(orch.state.currentObjective, 'SMELT_IRON');
  assert.equal(orch.state.objectiveFailures.SMELT_IRON || 0, 0);
  assert.equal(fallback.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(fallback.signals.some((signal) => signal.evt === 'mission.objective.complete'), false);
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
  const res = await runMissionInSim(orch, { targetIronPickaxeOnly: true }, { maxSteps: 240 });
  assert.equal(
    res.done,
    true,
    `iron-pickaxe-only mission did not complete in ${res.steps} steps: ${JSON.stringify({
      state: res.state,
      objectives: res.objectiveTrace.slice(-8),
      actions: res.actionTrace.slice(-8),
    })}`,
  );
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

test('world-memory and opportunity metadata cannot refresh progress clocks, but owned inventory can', async () => {
  let t = 0;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => t,
    stallTimeoutMs: 60000,
    abortTimeoutMs: 1000,
  });
  const base = createInitialState({
    logs: undefined,
    inventoryLogCount: 0,
    worldId: 'local:world-a',
    dimension: 'overworld',
    worldMemoryRevision: 1,
    opportunityLedgerRevision: 1,
    strategicDiscoveries: [],
    opportunities: [],
  });

  await orch.step(base);
  assert.equal(orch.state.globalProgressAtMs, 0);
  assert.equal(orch.state.objectiveProgressAtMs, 0);

  t = 900;
  const metadataOnly = await orch.step({
    ...base,
    worldId: 'local:world-b',
    dimension: 'the_nether',
    worldMemoryRevision: 99,
    opportunityLedgerRevision: 77,
    strategicDiscoveries: [{ id: 'village:new', revision: 4 }],
    opportunities: [{ id: 'ore:new', estimatedItems: { 'minecraft:raw_iron': 8 } }],
    opportunityShadow: { selected: 'village:new', scoreSeconds: 1 },
  });
  assert.equal(metadataOnly.done, false);
  assert.equal(orch.state.globalProgressAtMs, 0);
  assert.equal(orch.state.objectiveProgressAtMs, 0);

  t = 999;
  const ownedGain = await orch.step({
    ...base,
    inventoryLogCount: 1,
    worldMemoryRevision: 100,
    strategicDiscoveries: [{ id: 'village:new', revision: 5 }],
  });
  assert.equal(ownedGain.done, false);
  assert.equal(orch.state.globalProgressAtMs, 999);
  assert.equal(orch.state.objectiveProgressAtMs, 999);

  t = 1998;
  const beforeBoundary = await orch.step({
    ...base,
    inventoryLogCount: 1,
    worldMemoryRevision: 101,
    opportunityLedgerRevision: 78,
    opportunities: [{ id: 'hay:new', estimatedItems: { 'minecraft:hay_block': 12 } }],
  });
  assert.equal(beforeBoundary.done, false);
  assert.equal(orch.state.globalProgressAtMs, 999);

  t = 1999;
  const exactBoundary = await orch.step({
    ...base,
    inventoryLogCount: 1,
    worldMemoryRevision: 102,
    opportunityLedgerRevision: 79,
    opportunities: [{ id: 'chest:new', estimatedItems: { 'minecraft:iron_pickaxe': 1 } }],
  });
  assert.equal(exactBoundary.done, true);
  assert.equal(exactBoundary.objective, 'ABORTED');
  assert.ok(exactBoundary.signals.some((signal) => (
    signal.evt === 'mission.aborted'
      && signal.reason === 'no_global_progress'
      && signal.stuckMs === 1000
  )));
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
  assert.equal(failed.intent.remainingMissionIronCount, 27);
  assert.equal(failed.intent.reservedIronPickaxeCount, 1);
  assert.equal(failed.intent.reservedIronPickaxeDurabilityFloor, 64);
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
  assert.equal(orch.bindSurfaceProvisionalAnchorCommand('stone-origin-1', first.intent.action, first.objective), true);
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

const STONE_NO_SAFE_METHOD = 'mine_nearby_stone_failed:mission_stone_method_rejected:no_safe_method';

function completedStoneFailure(state, commandId, reason = STONE_NO_SAFE_METHOD) {
  return {
    ...state,
    currentCommandId: commandId,
    currentCommandCompleted: true,
    currentCommandCompletionReason: reason,
  };
}

test('Chunk 40: exact no-safe-method failure relocates immediately and processes one command once', async () => {
  let now = 1_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => now,
    stallTimeoutMs: 60_000,
    abortTimeoutMs: 600_000,
  });
  const mineReady = createInitialState({ woodenPickaxes: 1, cobblestone: 7, x: 4, y: 80, z: -3 });

  const first = await orch.step(mineReady);
  assert.equal(first.objective, 'MINE_STONE');
  const objectiveStartedAtMs = orch.state.objectiveStartedAtMs;
  now += 100;
  const failed = completedStoneFailure(mineReady, 'stone-origin-1');
  const relocated = await orch.step(failed, { completedCommandId: 'stone-origin-1' });

  assert.equal(relocated.objective, 'RELOCATE');
  assert.equal(relocated.intent.action, 'navigate_to_point');
  assert.deepEqual([relocated.intent.targetX, relocated.intent.targetZ], [4, 7]);
  assert.equal(orch.state.objectiveStartedAtMs, objectiveStartedAtMs, 'relocation must not reset the objective wall clock');
  assert.equal(orch.state.objectiveFailures.MINE_STONE, 1);
  assert.equal(orch.state.mineStoneRelocations, 1);
  assert.equal(relocated.signals.filter((signal) => signal.evt === 'mission.objective.failed').length, 1);
  const queued = relocated.signals.find((signal) => signal.evt === 'mission.relocate.queued');
  assert.deepEqual(queued, {
    evt: 'mission.relocate.queued',
    from: 'MINE_STONE',
    trigger: 'stone_origin_no_safe_method',
    sourceCommandId: 'stone-origin-1',
    originalPosition: { x: 4, y: 80, z: -3 },
    target: [4, 7],
    attempt: 0,
    limit: 3,
  });

  now += 100;
  const settling = await orch.step({ ...failed, x: 4, z: 7 }, { completedCommandId: 'stone-origin-1' });
  assert.equal(settling.objective, 'RELOCATE');
  assert.equal(settling.intent.action, 'stop');
  assert.equal(settling.intent.reason, 'mission:relocate_settle');
  assert.equal(settling.signals.some((signal) => signal.evt === 'mission.relocate.arrived'), false);

  now += 100;
  const stillMoving = await orch.step({ ...failed, x: 4, z: 7.2 }, { completedCommandId: 'stone-origin-1' });
  assert.equal(stillMoving.objective, 'RELOCATE');
  assert.equal(stillMoving.intent.reason, 'mission:relocate_settle');

  now += 100;
  const arrived = await orch.step({ ...failed, x: 4, z: 7.2 }, { completedCommandId: 'stone-origin-1' });
  assert.equal(arrived.objective, 'MINE_STONE');
  assert.equal(arrived.intent.action, 'mine_nearby_stone');
  assert.equal(orch.state.objectiveFailures.MINE_STONE, 1, 'stale completion must not be charged twice');
  assert.equal(orch.state.mineStoneRelocations, 1, 'stale completion must not queue another relocation');
  const arrival = arrived.signals.find((signal) => signal.evt === 'mission.relocate.arrived');
  assert.equal(arrival.sourceCommandId, 'stone-origin-1');
  assert.deepEqual(arrival.originalPosition, { x: 4, y: 80, z: -3 });
  assert.deepEqual(arrival.target, [4, 7]);
  assert.ok(arrived.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_frozen'
      && signal.provisional === true
      && signal.anchor.x === 4
      && signal.anchor.y === 80
      && signal.anchor.z === 7
  )), 'arrival must freeze a fresh provisional anchor at the relocated origin');
});

test('Chunk 40: relocation rotates, times out at 15 seconds, and preserves its bounded budget', async () => {
  let now = 2_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => now,
    stallTimeoutMs: 60_000,
    abortTimeoutMs: 600_000,
  });
  const origin = createInitialState({ woodenPickaxes: 1, x: 0, y: 70, z: 0 });
  await orch.step(origin);

  now += 50;
  const firstFailure = completedStoneFailure(origin, 'timeout-origin-1');
  const firstRelocate = await orch.step(firstFailure, { completedCommandId: 'timeout-origin-1' });
  assert.deepEqual([firstRelocate.intent.targetX, firstRelocate.intent.targetZ], [0, 10]);

  now += 15_000;
  const timedOut = await orch.step(firstFailure, { completedCommandId: 'timeout-origin-1' });
  assert.equal(timedOut.objective, 'MINE_STONE');
  assert.equal(timedOut.intent.action, 'mine_nearby_stone');
  const legFailed = timedOut.signals.find((signal) => signal.evt === 'mission.relocate.leg_failed');
  assert.equal(legFailed.reason, 'timeout');
  assert.equal(legFailed.trigger, 'stone_origin_no_safe_method');
  assert.equal(legFailed.sourceCommandId, 'timeout-origin-1');
  assert.equal(legFailed.limit, 3);
  assert.equal(orch.state.mineStoneRelocations, 1, 'a timeout consumes but never resets an attempt');

  now += 50;
  const secondRelocate = await orch.step(
    completedStoneFailure(origin, 'timeout-origin-2'),
    { completedCommandId: 'timeout-origin-2' },
  );
  assert.equal(secondRelocate.objective, 'RELOCATE');
  assert.deepEqual([secondRelocate.intent.targetX, secondRelocate.intent.targetZ], [10, 0]);
  assert.equal(secondRelocate.signals.find((signal) => signal.evt === 'mission.relocate.queued').attempt, 1);
});

test('Chunk 40: three relocations evaluate four origins then exhaust without block or inventory mutation', async () => {
  let now = 3_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => now,
    stallTimeoutMs: 60_000,
    abortTimeoutMs: 600_000,
  });
  const inventory = { woodenPickaxes: 1, cobblestone: 0 };
  let position = { x: 0, y: 70, z: 0 };
  await orch.step(createInitialState({ ...inventory, ...position }));
  const evaluated = [];

  for (let index = 0; index < 4; index++) {
    now += 100;
    const commandId = `blocked-origin-${index + 1}`;
    const snapshot = completedStoneFailure(createInitialState({ ...inventory, ...position }), commandId);
    const result = await orch.step(snapshot, { completedCommandId: commandId });
    const failed = result.signals.find((signal) => (
      signal.evt === 'mission.objective.failed' && signal.reason === 'stone_origin_no_safe_method'
    ));
    evaluated.push(failed.originalPosition);

    if (index < 3) {
      assert.equal(result.objective, 'RELOCATE');
      position = { x: result.intent.targetX, y: 70, z: result.intent.targetZ };
      now += 100;
      const settling = await orch.step(
        completedStoneFailure(createInitialState({ ...inventory, ...position }), commandId),
        { completedCommandId: commandId },
      );
      assert.equal(settling.objective, 'RELOCATE');
      assert.equal(settling.intent.reason, 'mission:relocate_settle');
      now += 100;
      const arrived = await orch.step(
        completedStoneFailure(createInitialState({ ...inventory, ...position }), commandId),
        { completedCommandId: commandId },
      );
      assert.equal(arrived.objective, 'MINE_STONE');
      assert.equal(arrived.intent.action, 'mine_nearby_stone');
    } else {
      assert.equal(result.done, true);
      assert.equal(result.objective, 'ABORTED');
      assert.ok(result.signals.some((signal) => (
        signal.evt === 'mission.objective.exhausted'
          && signal.reason === 'stone_origin_relocation_limit'
          && signal.attempts === 3
          && signal.limit === 3
      )));
      assert.ok(result.signals.some((signal) => (
        signal.evt === 'mission.aborted'
          && signal.reason === 'stone_origin_relocation_limit'
          && signal.objective === 'MINE_STONE'
      )));
    }
  }

  assert.equal(new Set(evaluated.map((p) => `${p.x},${p.y},${p.z}`)).size, 4);
  assert.equal(orch.state.mineStoneRelocations, 3);
  assert.equal(orch.state.objectiveFailures.MINE_STONE, 4);
  assert.equal(inventory.cobblestone, 0);
});

test('Chunk 40: exact relocation admission fails closed outside a dry supported surface origin', async () => {
  const cases = [
    ['missing command provenance', {}, {}, STONE_NO_SAFE_METHOD],
    ['wet player', { touchingWater: true }, { completedCommandId: 'wet-stone' }, STONE_NO_SAFE_METHOD],
    ['unsupported player', { onGround: false }, { completedCommandId: 'air-stone' }, STONE_NO_SAFE_METHOD],
    ['unrelated failure', {}, { completedCommandId: 'entry-local' }, 'mine_nearby_stone_failed:mission_stone_entry_plan_rejected:break_interaction_invalid'],
  ];

  for (const [label, overrides, context, reason] of cases) {
    const orch = new MissionOrchestrator({ complete: oracleBrain(), stallTimeoutMs: 60_000, abortTimeoutMs: 600_000 });
    const mineReady = createInitialState({ woodenPickaxes: 1, x: 0, y: 70, z: 0, ...overrides });
    await orch.step(mineReady);
    const failed = await orch.step(completedStoneFailure(mineReady, context.completedCommandId, reason), context);
    assert.notEqual(failed.objective, 'RELOCATE', label);
    assert.equal(orch.state.mineStoneRelocations, 0, label);
  }

  const activeDescent = new MissionOrchestrator({ complete: oracleBrain(), stallTimeoutMs: 60_000, abortTimeoutMs: 600_000 });
  const descentState = createInitialState({ woodenPickaxes: 1, x: 0, y: 68, z: 0 });
  await activeDescent.step(descentState);
  activeDescent.state.surfaceExcursionActive = true;
  activeDescent.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  const descentFailure = await activeDescent.step(
    completedStoneFailure(descentState, 'descent-stone'),
    { completedCommandId: 'descent-stone' },
  );
  assert.notEqual(descentFailure.objective, 'RELOCATE');
  assert.equal(activeDescent.state.mineStoneRelocations, 0);

  const satisfied = new MissionOrchestrator({ complete: oracleBrain(), stallTimeoutMs: 60_000, abortTimeoutMs: 600_000 });
  const enoughStone = createInitialState({ woodenPickaxes: 1, cobblestone: 8, x: 0, y: 70, z: 0 });
  satisfied.state.currentObjective = 'MINE_STONE';
  satisfied.state.objectiveStartedAtMs = 1;
  const completed = await satisfied.step(
    completedStoneFailure(enoughStone, 'satisfied-stone'),
    { completedCommandId: 'satisfied-stone' },
  );
  assert.ok(completed.signals.some((signal) => (
    signal.evt === 'mission.objective.complete' && signal.objective === 'MINE_STONE'
  )));
  assert.equal(satisfied.state.mineStoneRelocations, 0);
});

function primeWoodOriginRecovery(orch, snapshot) {
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.objectiveStartedAtMs = 1;
  orch.state.objectiveProgressAtMs = 1;
  orch.state.explorePhaseBaselineLogs = Number(snapshot.inventoryLogCount ?? snapshot.logs ?? 0);
  orch.state.exploreEpochLegsUsed = orch.exploreLegLimit;
  orch.state.exploreCapReported = true;
}

function completedWoodFailure(snapshot, commandId, reason = WOOD_SEARCH_EXHAUSTED) {
  return {
    ...snapshot,
    currentCommandId: commandId,
    currentCommandCompleted: true,
    currentCommandCompletionReason: reason,
  };
}

test('Chunk 41 wood_progressive_origin_recover: a command-bound zero-gain aquatic origin relocates then resumes', async () => {
  let now = 1_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => now,
    exploreEnabled: true,
    abortTimeoutMs: 600_000,
    stallTimeoutMs: 60_000,
  });
  const base = woodSearchSnapshot({
    x: 10,
    z: -5,
    onGround: false,
    touchingWater: true,
    inventoryLogCount: 0,
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  primeWoodOriginRecovery(orch, base);
  assert.equal(orch.bindWoodGatherCommand('wood-origin-1', 'gather_tree', 'GATHER_WOOD', base), true);

  now += 100;
  const failed = completedWoodFailure(base, 'wood-origin-1');
  const recovery = await orch.step(failed, { completedCommandId: 'wood-origin-1' });
  assert.equal(recovery.objective, 'RELOCATE');
  assert.equal(recovery.intent.action, 'navigate_to_point');
  assert.deepEqual([recovery.intent.targetX, recovery.intent.targetZ], [22, -5]);
  assert.equal(recovery.intent.reason, 'exploration:wood:origin_recovery_1');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);
  assert.equal(orch.state.woodOriginRelocations, 1);
  assert.equal(orch.state.exploreEpochLegsUsed, orch.exploreLegLimit);
  const rejected = recovery.signals.find((signal) => signal.evt === 'mission.wood_origin.rejected');
  assert.equal(rejected.sourceCommandId, 'wood-origin-1');
  assert.equal(rejected.startLogs, 0);
  assert.equal(rejected.currentLogs, 0);
  assert.equal(rejected.wet, true);

  orch.bindWoodOriginRecoveryCommand('wood-recovery-1', recovery.intent.action, recovery.intent.reason);
  now += 100;
  const duplicate = await orch.step(failed, { completedCommandId: 'wood-origin-1' });
  assert.equal(duplicate.objective, 'RELOCATE');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);
  assert.equal(orch.state.woodOriginRelocations, 1);

  const arrivedSnapshot = {
    ...base,
    x: recovery.intent.targetX,
    z: recovery.intent.targetZ,
    onGround: true,
    touchingWater: false,
    currentCommandId: 'wood-recovery-1',
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  };
  now += 100;
  const settling = await orch.step(arrivedSnapshot, { activeCommandId: 'wood-recovery-1' });
  assert.equal(settling.objective, 'RELOCATE');
  now += 100;
  const arrived = await orch.step(arrivedSnapshot, { activeCommandId: 'wood-recovery-1' });
  assert.equal(arrived.objective, 'GATHER_WOOD');
  assert.equal(arrived.intent.action, 'gather_tree');
  assert.ok(arrived.signals.some((signal) => signal.evt === 'mission.relocate.arrived'));
  assert.equal(orch.state.exploreCapReported, true, 'arrival must not reopen exploration');
  assert.equal(orch.state.objectiveStartedAtMs, 1, 'arrival must preserve the objective wall clock');
});

test('Chunk 41: navigation rejection rotates immediately and three transport failures exhaust exactly', async () => {
  let now = 2_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(), now: () => now, exploreEnabled: true,
    abortTimeoutMs: 600_000, stallTimeoutMs: 60_000,
  });
  const base = woodSearchSnapshot({ x: 0, z: 0, inventoryLogCount: 0 });
  primeWoodOriginRecovery(orch, base);
  orch.bindWoodGatherCommand('blocked-wood-1', 'gather_tree', 'GATHER_WOOD', base);
  let result = await orch.step(completedWoodFailure(base, 'blocked-wood-1'), { completedCommandId: 'blocked-wood-1' });

  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(result.objective, 'RELOCATE');
    const recoveryId = `blocked-recovery-${attempt + 1}`;
    orch.bindWoodOriginRecoveryCommand(recoveryId, result.intent.action, result.intent.reason);
    now += 100;
    result = await orch.step({
      ...base,
      currentCommandId: recoveryId,
      currentCommandCompleted: true,
      currentCommandCompletionReason: 'target_rejected_no_path',
    }, { completedCommandId: recoveryId });
  }

  assert.equal(result.done, true);
  assert.equal(result.objective, 'ABORTED');
  assert.equal(orch.state.woodOriginRelocations, 3);
  assert.ok(result.signals.some((signal) => (
    signal.evt === 'mission.objective.exhausted'
      && signal.reason === 'wood_origin_relocation_limit'
      && signal.attempts === 3
  )));
});

test('Chunk 41: acquisition and dry-travel clocks rotate independently without resetting mission time', async () => {
  let now = 4_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(), now: () => now, exploreEnabled: true,
    abortTimeoutMs: 600_000, stallTimeoutMs: 60_000,
    woodOriginAcquireTimeoutMs: 300,
    woodOriginTravelTimeoutMs: 150,
  });
  const wet = woodSearchSnapshot({
    x: 0, z: 0, inventoryLogCount: 0, onGround: false, touchingWater: true,
  });
  primeWoodOriginRecovery(orch, wet);
  orch.bindWoodGatherCommand('timed-wood-1', 'gather_tree', 'GATHER_WOOD', wet);
  let result = await orch.step(
    completedWoodFailure(wet, 'timed-wood-1'),
    { completedCommandId: 'timed-wood-1' },
  );
  assert.equal(result.objective, 'RELOCATE');

  now += 301;
  result = await orch.step({
    ...wet,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(result.objective, 'RELOCATE');
  assert.equal(result.signals.find((signal) => signal.evt === 'mission.relocate.leg_failed').reason,
    'stable_origin_acquisition_timeout');
  assert.equal(orch.state.woodOriginRelocations, 2);

  const dryButStationary = {
    ...wet,
    onGround: true,
    touchingWater: false,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  };
  now += 1;
  await orch.step(dryButStationary);
  now += 151;
  result = await orch.step(dryButStationary);
  assert.equal(result.objective, 'RELOCATE');
  assert.equal(result.signals.find((signal) => signal.evt === 'mission.relocate.leg_failed').reason,
    'dry_travel_timeout');
  assert.equal(orch.state.woodOriginRelocations, 3);
  assert.equal(orch.state.objectiveStartedAtMs, 1);
});

test('Chunk 41 wood_progressive_origin_blocked: three relocations evaluate four origins before bounded exhaustion', async () => {
  let now = 3_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(), now: () => now, exploreEnabled: true,
    abortTimeoutMs: 600_000, stallTimeoutMs: 60_000,
  });
  let position = { x: 0, z: 0 };
  const baseAt = () => woodSearchSnapshot({ ...position, y: 70, inventoryLogCount: 0 });
  primeWoodOriginRecovery(orch, baseAt());

  for (let origin = 0; origin < 4; origin++) {
    const commandId = `evaluated-wood-${origin + 1}`;
    const base = baseAt();
    orch.bindWoodGatherCommand(commandId, 'gather_tree', 'GATHER_WOOD', base);
    now += 100;
    const failed = await orch.step(completedWoodFailure(base, commandId), { completedCommandId: commandId });
    if (origin === 3) {
      assert.equal(failed.done, true);
      assert.equal(failed.objective, 'ABORTED');
      assert.equal(failed.signals.find((signal) => signal.evt === 'mission.objective.exhausted').reason,
        'wood_origin_relocation_limit');
      break;
    }
    assert.equal(failed.objective, 'RELOCATE');
    const recoveryId = `evaluated-recovery-${origin + 1}`;
    orch.bindWoodOriginRecoveryCommand(recoveryId, failed.intent.action, failed.intent.reason);
    position = { x: failed.intent.targetX, z: failed.intent.targetZ };
    const arrival = {
      ...baseAt(),
      onGround: true,
      touchingWater: false,
      currentCommandId: recoveryId,
      currentCommandCompleted: false,
      currentCommandCompletionReason: '',
    };
    now += 100;
    await orch.step(arrival, { activeCommandId: recoveryId });
    now += 100;
    const resumed = await orch.step(arrival, { activeCommandId: recoveryId });
    assert.equal(resumed.objective, 'GATHER_WOOD');
    assert.equal(resumed.intent.action, 'gather_tree');
  }

  assert.equal(orch.state.woodOriginRelocations, 3);
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 4);
  assert.equal(new Set(orch.state.woodEvaluatedOrigins.map((origin) => `${origin.x},${origin.z}`)).size, 4);
});

test('Chunk 41: recovery admission fails closed for progress, meaningful dry travel, missing provenance, and unrelated failures', async () => {
  const cases = [
    ['inventory gain', { inventoryLogCount: 1 }, WOOD_SEARCH_EXHAUSTED, true],
    ['meaningful dry travel', { x: 5 }, WOOD_SEARCH_EXHAUSTED, true],
    ['missing command provenance', {}, WOOD_SEARCH_EXHAUSTED, false],
    ['adjacent stall', {}, 'gather_log_failed:adjacent_no_path', true],
  ];
  for (const [label, completionOverrides, reason, bind] of cases) {
    const orch = new MissionOrchestrator({
      complete: oracleBrain(), exploreEnabled: true, abortTimeoutMs: 600_000, stallTimeoutMs: 60_000,
    });
    const base = woodSearchSnapshot({ x: 0, z: 0, inventoryLogCount: 0 });
    primeWoodOriginRecovery(orch, base);
    if (bind) orch.bindWoodGatherCommand(`closed-${label}`, 'gather_tree', 'GATHER_WOOD', base);
    const result = await orch.step(completedWoodFailure(
      { ...base, ...completionOverrides }, `closed-${label}`, reason,
    ), { completedCommandId: `closed-${label}` });
    assert.notEqual(result.source, 'wood_origin_recovery', label);
    assert.equal(orch.state.woodOriginRelocations, 0, label);
  }

  const satisfied = new MissionOrchestrator({
    complete: oracleBrain(), exploreEnabled: true, abortTimeoutMs: 600_000, stallTimeoutMs: 60_000,
  });
  const start = woodSearchSnapshot({ inventoryLogCount: 0 });
  primeWoodOriginRecovery(satisfied, start);
  satisfied.bindWoodGatherCommand('wood-satisfied', 'gather_tree', 'GATHER_WOOD', start);
  const enough = completedWoodFailure({
    ...start,
    inventoryLogCount: THRESHOLDS.woodForIronArmorMission,
  }, 'wood-satisfied');
  const completed = await satisfied.step(enough, { completedCommandId: 'wood-satisfied' });
  assert.equal(satisfied.state.woodOriginRelocations, 0);
  assert.notEqual(completed.source, 'wood_origin_recovery');
  assert.notEqual(completed.objective, 'RELOCATE');
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

test('raw-iron fuel preflight feedback is neutral, deduplicated, and hands off to coal', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const base = {
    inventoryStonePickaxeCount: 2,
    inventoryStoneSwordCount: 1,
    inventoryRawIronCount: 3,
    inventoryIronIngotCount: 0,
    inventoryIronPickaxeCount: 0,
    inventoryCoalCount: 0,
    inventoryCharcoalCount: 0,
    inventoryLogCount: 0,
    inventoryPlankCount: 7,
    inventoryStickCount: 2,
    furnaceInReach: true,
    craftingTableInReach: true,
    atIronDepth: true,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  };

  const probe = await orch.step(base);
  assert.equal(probe.objective, 'SMELT_IRON');
  assert.equal(probe.intent.action, 'smelt_raw_iron');
  assert.equal(probe.signals.filter((s) => s.evt === 'mission.smelt.fuel_probe').length, 1);
  const objectiveStartedAtMs = orch.state.objectiveStartedAtMs;

  now += 100;
  const feedback = {
    ...base,
    currentCommandId: 'smelt-probe-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'smelt_raw_iron_complete:fuel_preflight_unavailable',
  };
  const handoff = await orch.step(feedback);
  assert.equal(handoff.objective, 'SMELT_IRON');
  assert.equal(handoff.intent.action, 'mine_nearby_coal');
  assert.equal(handoff.signals.filter((s) => s.evt === 'mission.smelt.fuel_short').length, 1);
  assert.equal(handoff.signals.filter((s) => s.evt === 'mission.smelt.coal_handoff').length, 1);
  assert.equal(handoff.signals.some((s) => s.evt === 'mission.objective.failed'), false);
  assert.equal(orch.state.objectiveFailures.SMELT_IRON || 0, 0);
  assert.equal(orch.state.objectiveStartedAtMs, objectiveStartedAtMs);
  assert.equal(orch.state.consecutiveFailureCount, 0);

  now += 100;
  const duplicate = await orch.step(feedback);
  assert.equal(duplicate.intent.action, 'mine_nearby_coal');
  assert.equal(duplicate.signals.filter((s) => s.evt === 'mission.smelt.fuel_short').length, 0);
  assert.equal(duplicate.signals.filter((s) => s.evt === 'mission.smelt.coal_handoff').length, 0);

  now += 100;
  const fueled = await orch.step({
    ...base,
    inventoryCoalCount: 8,
    currentCommandId: 'coal-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_coal_complete:inventory_delta',
  });
  assert.equal(fueled.objective, 'SMELT_IRON');
  assert.equal(fueled.intent.action, 'smelt_raw_iron');
  assert.equal(fueled.signals.filter((s) => s.evt === 'mission.smelt.fuel_probe').length, 0);
});

test('surface fuel-preflight feedback records the shortage without advertising a coal handoff', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const atDepth = {
    inventoryStonePickaxeCount: 2,
    inventoryStoneSwordCount: 1,
    inventoryRawIronCount: 3,
    inventoryCoalCount: 0,
    inventoryCharcoalCount: 0,
    inventoryLogCount: 0,
    inventoryPlankCount: 4,
    inventoryStickCount: 2,
    furnaceInReach: true,
    craftingTableInReach: true,
    atIronDepth: true,
  };
  const probe = await orch.step(atDepth);
  assert.equal(probe.intent.action, 'smelt_raw_iron');

  now += 100;
  const feedback = await orch.step({
    ...atDepth,
    atIronDepth: false,
    y: 64,
    currentCommandId: 'surface-feedback',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'smelt_raw_iron_complete:fuel_preflight_unavailable',
  });
  assert.equal(feedback.intent.action, 'stop');
  assert.equal(feedback.source, 'fuel_feedback');
  assert.equal(feedback.signals.filter((s) => s.evt === 'mission.smelt.fuel_short').length, 1);
  assert.equal(feedback.signals.filter((s) => s.evt === 'mission.smelt.coal_handoff').length, 0);
  assert.equal(feedback.signals.some((s) => s.evt === 'mission.objective.failed'), false);
  assert.equal(orch.state.objectiveFailures.SMELT_IRON || 0, 0);

  now += 100;
  const surfaceRecovery = await orch.step({
    ...atDepth,
    atIronDepth: false,
    y: 64,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(surfaceRecovery.objective, 'GATHER_WOOD');
  assert.equal(surfaceRecovery.intent.action, 'gather_tree');
  assert.equal(surfaceRecovery.signals.some((s) => s.evt === 'mission.smelt.coal_handoff'), false);
});

test('legacy fuel-source-missing feedback receives the same neutral coal handoff', async () => {
  let now = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => now, stallTimeoutMs: 60000 });
  const base = {
    inventoryStonePickaxeCount: 2,
    inventoryStoneSwordCount: 1,
    inventoryRawIronCount: 3,
    inventoryCoalCount: 0,
    inventoryCharcoalCount: 0,
    inventoryLogCount: 0,
    inventoryPlankCount: 4,
    inventoryStickCount: 2,
    furnaceInReach: true,
    craftingTableInReach: true,
    atIronDepth: true,
  };
  const first = await orch.step(base);
  assert.equal(first.intent.action, 'smelt_raw_iron');
  now += 100;
  const handoff = await orch.step({
    ...base,
    inventoryRawIronCount: 0,
    currentCommandId: 'legacy-probe',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'smelt_raw_iron_failed:smelt_raw_iron_fuel_source_missing',
  });
  assert.equal(handoff.intent.action, 'mine_nearby_coal');
  assert.equal(handoff.signals.some((s) => s.evt === 'mission.objective.failed'), false);
  assert.equal(orch.state.objectiveFailures.SMELT_IRON || 0, 0);
  assert.equal(orch.state.smeltLoadedRawBatch, 3);

  now += 100;
  const resume = await orch.step({
    ...base,
    inventoryRawIronCount: 0,
    inventoryCoalCount: 8,
    currentCommandId: 'coal-after-stranded-input',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_coal_complete:inventory_delta',
  });
  assert.equal(resume.objective, 'SMELT_IRON');
  assert.equal(resume.intent.action, 'smelt_raw_iron');
  assert.equal(orch.state.smeltLoadedRawBatch, 3);

  now += 100;
  const output = await orch.step({
    ...base,
    inventoryRawIronCount: 0,
    inventoryCoalCount: 7,
    inventoryIronIngotCount: 3,
    currentCommandId: 'smelt-resume',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'smelt_raw_iron_complete:inventory_delta',
  });
  assert.equal(orch.state.smeltLoadedRawBatch, 0);
  assert.notEqual(output.intent.action, 'smelt_raw_iron');
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
    cobblestone: 11,
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

test('recovery: broken stone pickaxe during iron mining is restocked inside the same objective', async () => {
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
  assert.ok(res.signals.some((s) => (
    s.evt === 'mission.mine_iron.tool_reserve.preparing'
      && s.objective === 'MINE_IRON'
      && s.action === 'craft_stone_pickaxe'
  )), 'MINE_IRON did not prepare a replacement pickaxe');
  assert.equal(res.signals.some((s) => s.evt === 'mission.replan' && s.from === 'MINE_IRON'), false,
    'tool restock must preserve the active MINE_IRON objective');
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

test('iron-search same-plane continuation reissues the same heading without resetting clocks or recovery accounting', async () => {
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

  orch.state.objectiveFailures.MINE_IRON = 2;
  orch.state.consecutiveFailureKey = 'MINE_IRON:preserved_failure';
  orch.state.consecutiveFailureCount = 2;
  orch.state.ironSearchTriedHeadings.add('north');
  const before = {
    objectiveStartedAtMs: orch.state.objectiveStartedAtMs,
    objectiveProgressAtMs: orch.state.objectiveProgressAtMs,
    globalProgressAtMs: orch.state.globalProgressAtMs,
    objectiveFailures: orch.state.objectiveFailures.MINE_IRON,
    consecutiveFailureKey: orch.state.consecutiveFailureKey,
    consecutiveFailureCount: orch.state.consecutiveFailureCount,
    pendingRecoveryIntent: orch.state.pendingRecoveryIntent,
    pendingHeading: orch.state.ironSearchPendingHeading,
    triedHeadings: [...orch.state.ironSearchTriedHeadings],
    lastOutcome: orch.state.lastOutcome,
  };

  t += 1000;
  const continued = await orch.step({
    ...atDepth,
    currentCommandId: 'iron-plane-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_complete:same_plane_continue',
  });

  assert.equal(continued.objective, 'MINE_IRON');
  assert.equal(continued.intent.action, 'mine_nearby_iron');
  assert.equal(continued.intent.reason, 'mission:MINE_IRON');
  assert.equal(continued.source, 'same_plane_continue');
  assert.deepEqual([continued.intent.targetX, continued.intent.targetZ], [20, 42]);
  assert.equal(continued.signals.some((signal) => signal.evt === 'mission.iron_search.direction_rotated'), false);
  assert.equal(continued.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(continued.signals.some((signal) => signal.evt === 'mission.objective.recovery_queued'), false);
  assert.deepEqual({
    objectiveStartedAtMs: orch.state.objectiveStartedAtMs,
    objectiveProgressAtMs: orch.state.objectiveProgressAtMs,
    globalProgressAtMs: orch.state.globalProgressAtMs,
    objectiveFailures: orch.state.objectiveFailures.MINE_IRON,
    consecutiveFailureKey: orch.state.consecutiveFailureKey,
    consecutiveFailureCount: orch.state.consecutiveFailureCount,
    pendingRecoveryIntent: orch.state.pendingRecoveryIntent,
    pendingHeading: orch.state.ironSearchPendingHeading,
    triedHeadings: [...orch.state.ironSearchTriedHeadings],
    lastOutcome: orch.state.lastOutcome,
  }, before);
});

test('iron-search same-plane completion still yields to authoritative inventory completion', async () => {
  let t = 1000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, stallTimeoutMs: 30_000 });
  const atDepth = createInitialState({
    logs: 24, sticks: 16, stonePickaxes: 2, stoneSwords: 1, cobblestone: 64,
    tablePlaced: true, craftingTables: 1, furnaces: 1, furnacePlaced: true,
    atIronDepth: true, y: 14, x: 20, z: 30, yaw: 0, targetIronPickaxeOnly: true,
  });
  await orch.step(atDepth);

  t += 1000;
  const satisfied = await orch.step({
    ...atDepth,
    rawIron: 3,
    currentCommandId: 'iron-plane-satisfied',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_iron_complete:same_plane_continue',
  });

  assert.ok(satisfied.signals.some((signal) => signal.evt === 'mission.objective.complete' && signal.objective === 'MINE_IRON'));
  assert.notEqual(satisfied.source, 'same_plane_continue');
  assert.notEqual(satisfied.intent.action, 'mine_nearby_iron');
  assert.equal(orch.state.objectiveFailures.MINE_IRON, 0);
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

test('exact MINE_STONE inventory satisfaction wins on the wall-clock and failure-streak boundary', async () => {
  let t = 1_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => t,
    objectiveWallClockMs: 1_000,
    stallTimeoutMs: 60_000,
  });
  const mining = createInitialState({
    logs: 20,
    woodenPickaxes: 1,
    sticks: 8,
    tablePlaced: true,
    x: 4.5,
    y: 70.2,
    z: -2.5,
  });

  const first = await orch.step(mining);
  assert.equal(first.objective, 'MINE_STONE');
  assert.equal(first.intent.completionInventoryCobblestoneCount, 8);
  orch.state.consecutiveFailureKey = 'MINE_STONE:mine_nearby_stone_failed:no_path';
  orch.state.consecutiveFailureCount = 3;

  t += 1_000;
  const boundary = await orch.step({
    ...mining,
    cobblestone: 8,
    currentCommandId: 'stone-boundary',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'mine_nearby_stone_failed:no_path',
  });
  assert.ok(boundary.signals.some((signal) => (
    signal.evt === 'mission.objective.complete' && signal.objective === 'MINE_STONE'
  )));
  assert.equal(boundary.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(orch.state.objectiveFailures.MINE_STONE, 0);
  assert.equal(boundary.objective, 'MAKE_STONE_TOOLS');
});

test('GATHER_WOOD at depth surfaces via return_staircase to the anchor first (depth-aware wood)', () => {
  // The underground-wood death class, sticks variant: wood needs that arise underground must not
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

test('surface return freezes the first primary descent anchor across segments and recovery observations', async () => {
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
    x: 5.8,
    y: 70.9,
    z: -2.2,
  });

  const first = await orch.step(descentReady);
  assert.equal(first.objective, 'DESCEND');
  assert.equal(first.intent.action, 'descend_staircase');
  assert.deepEqual(orch.state.surfaceAnchor, { x: 5, y: 70, z: -3 });
  assert.ok(first.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_frozen'
      && signal.anchor.x === 5
      && signal.anchor.y === 70
      && signal.anchor.z === -3
  )));

  await orch.step({ ...descentReady, x: 8.2, y: 50.4, z: 17.8 });
  await orch.step({ ...descentReady, x: 12.2, y: 19.9, z: 34.8, atIronDepth: false });
  await orch.step({ ...descentReady, x: 15.2, y: 14.2, z: 36.8, atIronDepth: true });
  assert.deepEqual(
    orch.state.surfaceAnchor,
    { x: 5, y: 70, z: -3 },
    'later descent segments and recovery-band observations must not replace the shaft mouth',
  );
});

test('mission stone freezes a provisional anchor and activates it only after grounded lower progress', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const surfaceStone = createInitialState({
    logs: 20,
    woodenPickaxes: 1,
    x: 5.8,
    y: 70.9,
    z: -2.2,
  });

  const selected = await orch.step(surfaceStone);
  assert.equal(selected.objective, 'MINE_STONE');
  assert.equal(selected.intent.action, 'mine_nearby_stone');
  assert.deepEqual(orch.state.surfaceProvisionalAnchor, { x: 5, y: 70, z: -3 });
  assert.equal(orch.state.surfaceAnchor, null);
  assert.equal(orch.state.surfaceExcursionActive, false);
  assert.ok(selected.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_frozen'
      && signal.objective === 'MINE_STONE'
      && signal.provisional === true
  )));
  assert.equal(orch.bindSurfaceProvisionalAnchorCommand('stone-owner-1', selected.intent.action, selected.objective), true);
  assert.equal(orch.state.surfaceProvisionalAnchorCommandId, 'stone-owner-1');

  const faceOnly = await orch.step(
    { ...surfaceStone, x: 8.2, z: 1.2, cobblestone: 1 },
    { activeCommandId: 'stone-owner-1' },
  );
  assert.equal(faceOnly.objective, 'MINE_STONE');
  assert.deepEqual(orch.state.surfaceProvisionalAnchor, { x: 5, y: 70, z: -3 });
  assert.equal(orch.state.surfaceExcursionActive, false, 'same-height face harvesting cannot create a return');
  assert.equal(faceOnly.signals.some((signal) => signal.evt === 'mission.surface_return.anchor_activated'), false);

  const wrongOwner = await orch.step(
    { ...surfaceStone, x: 9.2, y: 69.2, z: 2.2, cobblestone: 2 },
    { activeCommandId: 'stone-owner-other' },
  );
  assert.equal(wrongOwner.signals.some((signal) => signal.evt === 'mission.surface_return.anchor_activated'), false);
  assert.equal(orch.state.surfaceExcursionActive, false, 'another command cannot claim the provisional anchor');

  const descended = await orch.step(
    { ...surfaceStone, x: 9.2, y: 69.2, z: 2.2, cobblestone: 2 },
    { activeCommandId: 'stone-owner-1' },
  );
  assert.equal(descended.objective, 'MINE_STONE');
  assert.deepEqual(orch.state.surfaceAnchor, { x: 5, y: 70, z: -3 });
  assert.equal(orch.state.surfaceProvisionalAnchor, null);
  assert.equal(orch.state.surfaceProvisionalAnchorCommandId, null);
  assert.equal(orch.state.surfaceExcursionActive, true);
  assert.ok(descended.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_activated'
      && signal.objective === 'MINE_STONE'
      && signal.commandId === 'stone-owner-1'
      && signal.reason === 'grounded_lower_stance'
  )));
});

test('completed or abandoned stone commands decline their owned provisional anchor before a new command can descend', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const stoneStart = createInitialState({
    logs: 20,
    woodenPickaxes: 1,
    x: 5.8,
    y: 70.9,
    z: -2.2,
  });

  const selected = await orch.step(stoneStart);
  assert.equal(orch.bindSurfaceProvisionalAnchorCommand('stone-old', selected.intent.action, selected.objective), true);

  const failed = await orch.step({
    ...stoneStart,
    currentCommandCompleted: true,
    currentCommandId: 'stone-old',
    currentCommandCompletionReason: 'mine_nearby_stone_failed:no_safe_route',
  }, {
    activeCommandId: 'stone-old',
    completedCommandId: 'stone-old',
  });
  assert.ok(failed.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_declined'
      && signal.commandId === 'stone-old'
      && signal.reason === 'stone_command_failed_without_grounded_descent'
  )));
  assert.equal(orch.state.surfaceProvisionalAnchorCommandId, null, 'the retry anchor is not owned until its new command is issued');

  const staleLower = await orch.step(
    { ...stoneStart, y: 69.2, cobblestone: 1 },
    { activeCommandId: 'stone-old' },
  );
  assert.equal(staleLower.signals.some((signal) => signal.evt === 'mission.surface_return.anchor_activated'), false);
  assert.equal(orch.state.surfaceExcursionActive, false);

  assert.equal(orch.bindSurfaceProvisionalAnchorCommand('stone-new', staleLower.intent.action, staleLower.objective), true);
  const matchingLower = await orch.step(
    { ...stoneStart, y: 69.2, cobblestone: 1 },
    { activeCommandId: 'stone-new' },
  );
  assert.ok(matchingLower.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_activated' && signal.commandId === 'stone-new'
  )));
});

test('MINE_STONE no-progress abandonment declines command-owned provisional state', async () => {
  let now = 1_000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => now,
    stallTimeoutMs: 1_000,
    abortTimeoutMs: 60_000,
  });
  const stoneStart = createInitialState({ logs: 20, woodenPickaxes: 1, x: 4.8, y: 70.2, z: 3.8 });
  const selected = await orch.step(stoneStart);
  orch.bindSurfaceProvisionalAnchorCommand('stone-stalled', selected.intent.action, selected.objective);

  now += 1_001;
  const stalled = await orch.step(stoneStart, { activeCommandId: 'stone-stalled' });
  assert.ok(stalled.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_declined'
      && signal.commandId === 'stone-stalled'
      && signal.reason === 'stone_objective_no_progress_abandoned'
  )));
  assert.notEqual(orch.state.surfaceProvisionalAnchorCommandId, 'stone-stalled');
  assert.equal(orch.state.surfaceExcursionActive, false);
});

test('face-only stone completion declines its provisional anchor before primary DESCEND', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  const stoneStart = createInitialState({
    logs: 20,
    woodenPickaxes: 1,
    x: 5.8,
    y: 70.9,
    z: -2.2,
  });
  await orch.step(stoneStart);
  assert.deepEqual(orch.state.surfaceProvisionalAnchor, { x: 5, y: 70, z: -3 });

  orch.state.currentObjective = 'MINE_STONE';
  const faceComplete = await orch.step({ ...stoneStart, cobblestone: 8 });
  assert.equal(orch.state.surfaceProvisionalAnchor, null);
  assert.equal(orch.state.surfaceAnchor, null, 'zero-step stone cannot publish a return anchor');
  assert.equal(orch.state.surfaceExcursionActive, false);
  assert.equal(orch.state.surfaceReturnPending, false, 'zero-step stone cannot leave a return latched');
  assert.ok(faceComplete.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_declined'
      && signal.reason === 'stone_completed_without_grounded_descent'
  )));

  orch.state.currentObjective = 'DESCEND';
  const readyElsewhere = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 3,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    x: 11.6,
    y: 70.1,
    z: 8.9,
  });
  const descent = await orch.step(readyElsewhere);
  assert.equal(descent.intent.action, 'descend_staircase');
  assert.deepEqual(orch.state.surfaceAnchor, { x: 11, y: 70, z: 8 });
  assert.equal(orch.state.surfaceProvisionalAnchor, null);
  assert.equal(orch.state.surfaceExcursionActive, true);
  assert.ok(descent.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_frozen'
      && signal.objective === 'DESCEND'
  )));
  assert.equal(descent.signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_activated' && signal.objective === 'DESCEND'
  )), false);
});

test('surface return remains latched through y17 and resumes the same GATHER_WOOD objective only after verified arrival', async () => {
  let t = 1_000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, abortTimeoutMs: 600_000 });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.objectiveStartedAtMs = t;
  orch.state.objectiveProgressAtMs = t;
  orch.state.globalProgressAtMs = t;
  orch.state.surfaceAnchor = { x: 4, y: 70, z: -3 };
  orch.state.surfaceLatestStable = { x: 4, y: 70, z: -3 };
  orch.state.surfaceExcursionActive = true;

  const depth = createInitialState({ x: 21.5, y: 14.2, z: 30.5, atIronDepth: true });
  const started = await orch.step(depth);
  assert.equal(started.objective, 'GATHER_WOOD');
  assert.equal(started.intent.action, 'return_staircase');
  assert.deepEqual([started.intent.targetX, started.intent.targetY, started.intent.targetZ], [4, 70, -3]);
  assert.ok(started.signals.some((signal) => signal.evt === 'mission.surface_return.started'));

  t += 1_000;
  const aboveDepth = await orch.step({ ...depth, x: 8.5, y: 17.2, z: 2.5, atIronDepth: false });
  assert.equal(aboveDepth.intent.action, 'return_staircase', 'crossing y17 must not release the return latch');

  t += 1_000;
  const unverified = await orch.step({ ...depth, x: 4.5, y: 70.1, z: -2.5, atIronDepth: false });
  assert.equal(unverified.intent.action, 'return_staircase', 'position alone must not complete the return');

  const startedAt = orch.state.objectiveStartedAtMs;
  t += 1_000;
  const arrived = await orch.step({
    ...depth,
    x: 4.5,
    y: 70.1,
    z: -2.5,
    atIronDepth: false,
    currentCommandId: 'return-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_complete:surface_reached',
  });
  assert.equal(arrived.objective, 'GATHER_WOOD');
  assert.equal(arrived.intent.action, 'gather_tree');
  assert.equal(orch.state.objectiveStartedAtMs, startedAt, 'return success must not restart the wood objective clock');
  assert.equal(orch.state.surfaceReturnPending, false);
  assert.equal(orch.state.surfaceExcursionActive, false);
  assert.ok(arrived.signals.some((signal) => signal.evt === 'mission.surface_return.completed'));
  assert.equal(arrived.signals.some((signal) => signal.evt === 'mission.objective.complete'), false);
});

test('surface-return structural failure charges once and suppresses an unchanged retry', async () => {
  let t = 1_000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, abortTimeoutMs: 600_000 });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceLatestStable = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  orch.state.surfaceReturnStarted = true;
  const atDepth = createInitialState({ x: 8.5, y: 14.2, z: 9.5, atIronDepth: true });

  const failedSnapshot = {
    ...atDepth,
    currentCommandId: 'return-failed-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_failed:return_staircase_timeout',
  };
  const failed = await orch.step(failedSnapshot);

  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);
  assert.equal(orch.state.surfaceReturnPending, true);
  assert.equal(failed.objective, 'GATHER_WOOD');
  assert.equal(failed.intent.action, 'stop');
  assert.equal(failed.intent.reason, 'mission:surface_return_retry_suppressed');
  assert.ok(failed.signals.some((signal) => (
    signal.evt === 'mission.surface_return.failed'
      && signal.reason === 'return_staircase_failed:return_staircase_timeout'
      && signal.attempts === 1
  )));
  assert.ok(failed.signals.some((signal) => (
    signal.evt === 'mission.objective.failed'
      && signal.objective === 'GATHER_WOOD'
      && signal.reason === 'return_staircase_failed:return_staircase_timeout'
  )));
  assert.ok(failed.signals.some((signal) => (
    signal.evt === 'mission.surface_return.retry_suppressed'
      && signal.objective === 'GATHER_WOOD'
      && signal.attempts === 1
  )));
  assert.equal(orch.state.consecutiveFailureCount, 0, 'the return must not wait for four streak strikes');

  t += 1_000;
  const duplicate = await orch.step(failedSnapshot);
  assert.equal(duplicate.intent.action, 'stop');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1, 'one terminal command may charge only one retry');
  assert.equal(duplicate.signals.some((signal) => signal.evt === 'mission.surface_return.failed'), false);
  assert.equal(duplicate.signals.some((signal) => signal.evt === 'mission.objective.failed'), false);
  assert.equal(duplicate.signals.some((signal) => signal.evt === 'mission.surface_return.retry_suppressed'), false);

  t += 1_000;
  const displaced = await orch.step({ ...failedSnapshot, x: 9.5 });
  assert.equal(displaced.intent.action, 'return_staircase');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1, 'released retry uses the already-consumed attempt');
  assert.ok(displaced.signals.some((signal) => (
    signal.evt === 'mission.surface_return.retry_released'
      && signal.previousPosition.x === 8
      && signal.position.x === 9
  )));
  assert.equal(displaced.signals.some((signal) => signal.evt === 'mission.objective.recovery_queued'), false);

  t += 100;
  const staleAfterRelease = await orch.step({
    ...failedSnapshot,
    x: 9.5,
    currentCommandId: 'suppression-stop',
  });
  assert.equal(staleAfterRelease.intent.action, 'return_staircase');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1, 'stale terminal feedback cannot charge the released retry');
  assert.equal(staleAfterRelease.signals.some((signal) => signal.evt === 'mission.surface_return.failed'), false);

  t += 100;
  await orch.step({
    ...failedSnapshot,
    x: 9.5,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(orch.state.surfaceReturnRetryAwaitingCommand, false);

  t += 100;
  const secondFailure = await orch.step({
    ...failedSnapshot,
    x: 9.5,
    currentCommandId: 'return-failed-2',
  });
  assert.equal(secondFailure.intent.action, 'stop');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 2);
  assert.ok(secondFailure.signals.some((signal) => (
    signal.evt === 'mission.surface_return.failed'
      && signal.attempts === 2
  )));
});

test('surface-return retry suppression preserves the configured terrain retry ceiling', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    abortTimeoutMs: 600_000,
    gatherRecoveryLimit: 1,
  });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  const firstFailure = createInitialState({
    x: 8.5,
    y: 14.2,
    z: 9.5,
    atIronDepth: true,
    currentCommandId: 'limited-return-1',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_failed:return_ascend_horizontal_stage_blocked',
  });

  assert.equal((await orch.step(firstFailure)).intent.action, 'stop');
  assert.equal((await orch.step({ ...firstFailure, x: 9.5 })).intent.action, 'return_staircase');
  await orch.step({
    ...firstFailure,
    x: 9.5,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  const exhausted = await orch.step({
    ...firstFailure,
    x: 9.5,
    currentCommandId: 'limited-return-2',
  });
  assert.equal(exhausted.done, true);
  assert.equal(exhausted.objective, 'ABORTED');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 2);
  assert.equal(orch.state.surfaceReturnRetryLatch, null);
  assert.ok(exhausted.signals.some((signal) => (
    signal.evt === 'mission.objective.exhausted'
      && signal.objective === 'GATHER_WOOD'
      && signal.attempts === 2
  )));
});

test('surface-return structural failure while airborne waits at the last verified dry feet', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), abortTimeoutMs: 600_000 });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  const grounded = createInitialState({ x: 8.5, y: 14.2, z: 9.5, atIronDepth: true });
  assert.equal((await orch.step(grounded)).intent.action, 'return_staircase');

  const airborneFailure = await orch.step({
    ...grounded,
    y: 14.8,
    onGround: false,
    currentCommandId: 'airborne-return-failure',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_failed:return_ascend_horizontal_stage_blocked',
  });
  assert.equal(airborneFailure.intent.action, 'stop');
  assert.deepEqual(orch.state.surfaceReturnRetryLatch.feet, { x: 8, y: 14, z: 9 });
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);

  const settled = await orch.step({
    ...grounded,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(settled.intent.action, 'stop');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);
});

test('surface-return retry suppression remains bounded by the existing global watchdog', async () => {
  let t = 1_000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, abortTimeoutMs: 10_000 });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  const failedSnapshot = createInitialState({
    x: 8.5,
    y: 14.2,
    z: 9.5,
    atIronDepth: true,
    currentCommandId: 'return-blocked',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_failed:return_ascend_horizontal_stage_blocked',
  });

  const failed = await orch.step(failedSnapshot);
  assert.equal(failed.intent.action, 'stop');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);

  t += 5_000;
  const jittered = await orch.step({ ...failedSnapshot, y: 14.8, onGround: false });
  assert.equal(jittered.intent.action, 'stop');
  assert.equal(jittered.done, false);

  t += 4_999;
  const bounded = await orch.step({ ...failedSnapshot, y: 14.6, touchingWater: true });
  assert.equal(bounded.intent.action, 'stop');
  assert.equal(bounded.done, false);
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);

  t += 1;
  const aborted = await orch.step(failedSnapshot);
  assert.equal(aborted.done, true);
  assert.equal(aborted.objective, 'ABORTED');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);
  assert.ok(aborted.signals.some((signal) => (
    signal.evt === 'mission.aborted'
      && signal.reason === 'no_global_progress'
  )));
});

test('surface-return stale feedback after release cannot extend the global watchdog', async () => {
  let t = 1_000;
  const orch = new MissionOrchestrator({ complete: oracleBrain(), now: () => t, abortTimeoutMs: 10_000 });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  const failedSnapshot = createInitialState({
    x: 8.5,
    y: 14.2,
    z: 9.5,
    atIronDepth: true,
    currentCommandId: 'awaiting-return',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_failed:return_ascend_horizontal_stage_blocked',
  });

  assert.equal((await orch.step(failedSnapshot)).intent.action, 'stop');
  t += 100;
  assert.equal((await orch.step({ ...failedSnapshot, x: 9.5 })).intent.action, 'return_staircase');
  assert.equal(orch.state.surfaceReturnRetryAwaitingCommand, true);

  t += 5_000;
  const airborne = await orch.step({ ...failedSnapshot, x: 9.5, y: 14.8, onGround: false });
  assert.equal(airborne.intent.action, 'return_staircase');
  assert.equal(airborne.done, false);

  t += 4_899;
  const wet = await orch.step({ ...failedSnapshot, x: 9.5, y: 14.6, touchingWater: true });
  assert.equal(wet.intent.action, 'return_staircase');
  assert.equal(wet.done, false);

  t += 1;
  const aborted = await orch.step({ ...failedSnapshot, x: 9.5 });
  assert.equal(aborted.done, true);
  assert.equal(aborted.objective, 'ABORTED');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);
  assert.ok(aborted.signals.some((signal) => (
    signal.evt === 'mission.aborted'
      && signal.reason === 'no_global_progress'
  )));
});

test('surface-return retry suppression releases without another return when wood is already satisfied', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), abortTimeoutMs: 600_000 });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  const failedSnapshot = createInitialState({
    x: 8.5,
    y: 14.2,
    z: 9.5,
    atIronDepth: true,
    currentCommandId: 'return-now-satisfied',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_failed:return_ascend_horizontal_stage_blocked',
  });

  const failed = await orch.step(failedSnapshot);
  assert.equal(failed.intent.action, 'stop');
  assert.notEqual(orch.state.surfaceReturnRetryLatch, null);

  const satisfied = await orch.step({
    ...failedSnapshot,
    logs: 20,
    inventoryLogCount: 20,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.notEqual(satisfied.intent.action, 'return_staircase');
  assert.notEqual(satisfied.intent.action, 'stop');
  assert.equal(orch.state.surfaceReturnRetryLatch, null);
  assert.ok(satisfied.signals.some((signal) => (
    signal.evt === 'mission.objective.complete'
      && signal.objective === 'GATHER_WOOD'
  )));
});

test('surface-return success at the wrong canonical target is an immediate terrain retry', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain(), abortTimeoutMs: 600_000 });
  orch.state.currentObjective = 'GATHER_WOOD';
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  const mismatch = await orch.step(createInitialState({
    x: 0.5,
    y: 71.2,
    z: 0.5,
    currentCommandId: 'return-mismatch',
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_complete:surface_reached',
  }));
  assert.equal(mismatch.intent.action, 'return_staircase');
  assert.equal(orch.state.objectiveFailures.GATHER_WOOD, 1);
  assert.ok(mismatch.signals.some((signal) => (
    signal.evt === 'mission.surface_return.failed'
      && signal.reason === 'return_staircase_failed:surface_target_mismatch'
  )));
});

test('a later primary descent freezes a fresh stable surface anchor', async () => {
  const orch = new MissionOrchestrator({ complete: oracleBrain() });
  orch.state.surfaceAnchor = { x: 0, y: 70, z: 0 };
  orch.state.surfaceLatestStable = { x: 0, y: 70, z: 0 };
  orch.state.surfaceExcursionActive = true;
  orch.state.surfaceReturnPending = true;
  orch.state.currentObjective = 'GATHER_WOOD';
  await orch.step(createInitialState({
    x: 0.5,
    y: 70.2,
    z: 0.5,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_complete:surface_reached',
  }));

  orch.state.currentObjective = 'DESCEND';
  const nextSurface = createInitialState({
    logs: 6,
    planks: 16,
    sticks: 12,
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    craftingTables: 1,
    x: 11.6,
    y: 72.1,
    z: 8.9,
  });
  const descended = await orch.step(nextSurface);
  assert.equal(descended.intent.action, 'descend_staircase');
  assert.deepEqual(orch.state.surfaceAnchor, { x: 11, y: 72, z: 8 });
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

test('SMELT_IRON probes unknown furnace fuel once, then chooses coal at depth', () => {
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
  const probe = nextActionForObjective('SMELT_IRON', base);
  assert.equal(probe && probe.action, 'smelt_raw_iron', 'unknown closed-furnace fuel receives one executor-truth probe');
  const coalPick = nextActionForObjective('SMELT_IRON', base, {
    smeltFuelShortFingerprint: rawIronFuelFingerprint(base),
  });
  assert.equal(coalPick && coalPick.action, 'mine_nearby_coal', 'a rejected fingerprint must hand off to coal');
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

test('EXPLORE chains current-position-derived hops and completes a leg by monotonic projected travel', async () => {
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
  const arrival = arrived.signals.find((signal) => signal.evt === 'exploration.leg.arrived');
  assert.ok(arrival);
  assert.equal(arrival.creditedProgress, 24);
  assert.equal(arrival.distanceTravelled, 24);
  assert.equal(arrival.rawPathDistance, 24);
  assert.equal(arrival.groundedArrival, true);
  assert.equal(arrival.legBlocks, 24);
  assert.equal(arrival.arriveDist, 2);
  assert.equal(deepseekCallCount, 0);
});

test('EXPLORE oscillation and backtracking cannot manufacture leg progress or an epoch', async () => {
  let clock = 1000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => clock,
    exploreEnabled: true,
    exploreLegBlocks: 20,
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

  await orch.step({ ...base, x: 9 });
  await orch.step({ ...base, x: 0 });
  const revisited = await orch.step({ ...base, x: 9 });
  assert.equal(revisited.objective, 'EXPLORE');
  assert.equal(revisited.signals.some((signal) => signal.evt === 'exploration.leg.arrived'), false);
  assert.equal(orch.state.exploration.rawPathDistance, 27);
  assert.equal(orch.state.exploration.projectedProgress, 9);
  assert.equal(orch.state.exploration.creditedProgress, 9);
  assert.equal(orch.state.exploration.distanceTravelled, 9);

  const rejected = {
    ...base,
    x: 9,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'target_rejected_no_path',
  };
  const retry = await orch.step(rejected);
  const exhausted = await orch.step(rejected);
  const signals = [...retry.signals, ...exhausted.signals];
  assert.ok(signals.some((signal) => signal.evt === 'exploration.leg.failed'));
  assert.equal(signals.some((signal) => signal.evt === 'exploration.leg.arrived'), false);
  assert.equal(signals.some((signal) => signal.evt === 'exploration.epoch.earned'), false);
  assert.equal(signals.some((signal) => signal.evt === 'exploration.epoch.renewed'), false);
});

test('EXPLORE projection ignores lateral and backward travel but credits a diagonal heading', async () => {
  const east = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 20,
    exploreHopBlocks: 12,
    exploreArriveDist: 1,
    abortTimeoutMs: 600000,
  });
  const eastBase = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await east.step(eastBase);
  await east.step(exhaustedWoodSearch(eastBase));
  await east.step({ ...eastBase, z: 5 });
  await east.step({ ...eastBase, x: -5, z: 5 });
  await east.step({ ...eastBase, x: 4, z: 5 });
  assert.equal(east.state.exploration.projectedProgress, 4);
  assert.equal(east.state.exploration.creditedProgress, 4);
  assert.ok(east.state.exploration.rawPathDistance > 14);

  const diagonal = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 10,
    exploreHopBlocks: 10,
    exploreArriveDist: 0.5,
    abortTimeoutMs: 600000,
  });
  const diagonalBase = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 1, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await diagonal.step(diagonalBase);
  const queued = await diagonal.step(exhaustedWoodSearch(diagonalBase));
  const arrived = await diagonal.step({
    ...diagonalBase,
    x: queued.intent.targetX,
    z: queued.intent.targetZ,
  });
  const arrival = arrived.signals.find((signal) => signal.evt === 'exploration.leg.arrived');
  assert.ok(arrival);
  assert.ok(Math.abs(arrival.projectedProgress - 10) < 0.001);
  assert.ok(Math.abs(arrival.creditedProgress - 10) < 0.001);
});

test('EXPLORE position-derived hop and leg arrival require a grounded snapshot', async () => {
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 40,
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
  const queued = await orch.step(exhaustedWoodSearch(base));
  const airborne = await orch.step({ ...base, x: queued.intent.targetX, onGround: false });
  assert.equal(airborne.objective, 'EXPLORE');
  assert.equal(airborne.signals.some((signal) => signal.evt === 'exploration.hop.arrived'), false);
  assert.equal(airborne.signals.some((signal) => signal.evt === 'exploration.leg.arrived'), false);
  assert.equal(orch.state.exploration.creditedProgress, 0);
  assert.equal(orch.state.exploration.rawPathDistance, 12);

  const grounded = await orch.step({ ...base, x: queued.intent.targetX, onGround: true });
  const hopArrival = grounded.signals.find((signal) => signal.evt === 'exploration.hop.arrived');
  assert.ok(hopArrival);
  assert.equal(hopArrival.groundedArrival, true);
  assert.equal(hopArrival.creditedProgress, 12);

  const exactLeg = new MissionOrchestrator({
    complete: oracleBrain(),
    exploreEnabled: true,
    exploreLegBlocks: 12,
    exploreHopBlocks: 12,
    exploreArriveDist: 2,
    abortTimeoutMs: 600000,
  });
  await exactLeg.step(base);
  const exactQueued = await exactLeg.step(exhaustedWoodSearch(base));
  const airborneLeg = await exactLeg.step({ ...base, x: exactQueued.intent.targetX, onGround: false });
  assert.equal(airborneLeg.signals.some((signal) => signal.evt === 'exploration.leg.arrived'), false);
  const groundedLeg = await exactLeg.step({ ...base, x: exactQueued.intent.targetX, onGround: true });
  assert.ok(groundedLeg.signals.some((signal) => (
    signal.evt === 'exploration.leg.arrived' && signal.groundedArrival === true
  )));
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

test('repeat zero-delta wood exhaustion escalates to EXPLORE despite local wood (w6 no-net-progress)', async () => {
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

test('EXPLORE sticky dig observation widens but never resets the hop-local stall budget', async () => {
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

  clock = 25999; // 24,999 ms since this hop was queued; current dig flag may already be false
  const stickyAllowance = await orch.step({ ...digging, navDigActive: false });
  assert.equal(stickyAllowance.objective, 'EXPLORE');
  assert.equal(stickyAllowance.signals.some((s) => s.evt === 'exploration.hop.failed'), false);
  assert.equal(stickyAllowance.signals.some((s) => s.evt === 'exploration.hop.digging'), false,
    'digging observability must be transition-only per hop');

  clock = 26000; // exact 25-second sticky allowance boundary
  const stickyExpired = await orch.step({ ...digging, navDigActive: true });
  assert.ok(stickyExpired.signals.some((s) => (
    s.evt === 'exploration.hop.failed'
      && s.reason === 'no_progress'
      && s.hopProgressAgeMs === 25000
  )), 'repeated dig-active observations must not move the 25-second deadline');

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

test('EXPLORE hop liveness ignores generic progress-key churn', async () => {
  let clock = 1000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => clock,
    exploreEnabled: true,
    exploreLegBlocks: 80,
    exploreHopBlocks: 12,
    stallTimeoutMs: 10000,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  await orch.step(exhaustedWoodSearch(base));

  clock = 11000;
  const stalled = await orch.step({ ...base, y: 71, z: 4 });
  assert.equal(orch.state.objectiveProgressAtMs, clock,
    'the control proves the generic Y/XZ progress key changed on this poll');
  assert.ok(stalled.signals.some((signal) => (
    signal.evt === 'exploration.hop.failed'
      && signal.reason === 'no_progress'
      && signal.hopProgressAgeMs === 10000
  )), 'generic position-key churn must not extend the hop-local clock');
});

test('EXPLORE refreshes hop liveness only after 0.2 blocks of grounded closest approach', async () => {
  let clock = 1000;
  const orch = new MissionOrchestrator({
    complete: oracleBrain(),
    now: () => clock,
    exploreEnabled: true,
    exploreLegBlocks: 80,
    exploreHopBlocks: 12,
    exploreArriveDist: 1,
    stallTimeoutMs: 10000,
    abortTimeoutMs: 600000,
  });
  const base = woodSearchSnapshot({
    farPerception: farWoodPerception({
      directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', scannedChunks: 2 }],
    }),
  });
  await orch.step(base);
  await orch.step(exhaustedWoodSearch(base));

  clock = 9000;
  await orch.step({ ...base, x: 0.1 });
  assert.equal(orch.state.exploration.hop.lastRealProgressAtMs, 1000,
    'sub-threshold closest approach must not refresh the clock');
  await orch.step({ ...base, x: 0.21 });
  assert.equal(orch.state.exploration.hop.lastRealProgressAtMs, 9000,
    'cumulative closest approach over the frozen best must refresh at >=0.2 blocks');

  clock = 18999;
  const alive = await orch.step({ ...base, x: 0.21 });
  assert.equal(alive.signals.some((signal) => signal.evt === 'exploration.hop.failed'), false);
  clock = 19000;
  const expired = await orch.step({ ...base, x: 0.21 });
  assert.ok(expired.signals.some((signal) => (
    signal.evt === 'exploration.hop.failed' && signal.hopProgressAgeMs === 10000
  )));
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
