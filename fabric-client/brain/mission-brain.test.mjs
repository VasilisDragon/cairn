import assert from 'node:assert/strict';
import test from 'node:test';

import { THRESHOLDS, expectedObjective } from './mission-planner.js';
import { createMissionBrainHandler } from './mission-brain.js';
import { applyAction, createInitialState } from './mission-sim.js';
import {
  villageOpportunityInventoryFingerprint,
  villageOpportunitySemanticFingerprint,
} from './village-opportunity-transaction.js';

// Valid low-level action ids the Fabric client executes (per BrainLink.java), plus the idle marker.
const VALID_ACTIONS = new Set([
  'gather_log', 'gather_tree', 'mine_stone', 'mine_nearby_stone', 'mine_nearby_iron', 'mine_nearby_diamond',
  'navigate_to_point',
  'descend_staircase', 'return_staircase', 'r2_mine_stone_return', 'r5_iron_chain',
  'craft_planks', 'craft_sticks', 'craft_table', 'craft_pickaxe', 'craft_stone_pickaxe',
  'craft_stone_sword', 'craft_furnace', 'craft_iron_pickaxe', 'craft_diamond_pickaxe', 'craft_iron_helmet',
  'craft_iron_chestplate', 'craft_iron_leggings', 'craft_iron_boots',
  'place_table', 'retrieve_table', 'place_furnace', 'smelt_raw_iron', 'smelt_charcoal', 'make_charcoal', 'equip_armor', 'eat', 'stop',
  'village_travel', 'village_revalidate', 'village_inspect_container', 'village_withdraw_item',
  'village_harvest_hay', 'village_craft_bread', 'village_collect_bed',
]);

// Perfect-planner mock (reuses the real prompt/encode path; returns the oracle's pick).
function oracleBrain() {
  return async (messages) => {
    const view = JSON.parse(messages.find((m) => m.role === 'user').content.match(/State: (\{.*\})/)[1]);
    const raw = {
      logs: view.logs, planks: view.planks, sticks: view.sticks,
      woodenPickaxes: view.hasWoodenPickaxe ? 1 : 0, cobblestone: view.cobblestone,
      stonePickaxes: view.stonePickaxes ?? (view.hasStonePickaxe ? 1 : 0),
      bestStonePickaxeRemaining: view.bestStonePickaxeRemaining,
      stoneSwords: view.hasStoneSword ? 1 : 0,
      furnaces: view.hasFurnace ? 1 : 0, fuel: view.fuel, rawIron: view.rawIron,
      ironIngots: view.ironIngots, ironPickaxes: view.ironPickaxes ?? (view.hasIronPickaxe ? 1 : 0),
      diamonds: view.diamonds, diamondPickaxes: view.diamondPickaxes, targetDiamondTier: view.targetDiamondTier,
      targetIronPickaxeOnly: view.targetIronPickaxeOnly,
      equippedArmorPieces: view.equippedIronArmorPieces, foodLevel: view.foodLevel,
      hasFood: view.hasFood, atIronDepth: view.atIronDepth, atDiamondDepth: view.atDiamondDepth,
    };
    const objective = expectedObjective(raw);
    return JSON.stringify({ objective, done: objective === 'DONE', reason: 'oracle' });
  };
}

// Drive the mission through the brain CONTRACT: handle(instanceId, snapshot) -> intent, apply, repeat.
async function runThroughHandler(handle, instanceId, overrides = {}, maxSteps = 400) {
  let state = createInitialState(overrides);
  const intents = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const intent = await handle(instanceId, state);
    intents.push(intent);
    if (intent.missionDone) return { done: true, steps: i + 1, state, intents };
    state = applyAction(state, intent.action).state;
  }
  return { done: false, steps: maxSteps, state, intents };
}

function liveWoodSearchSnapshot(overrides = {}) {
  return {
    ...createInitialState({ x: 0, y: 70, z: 0 }),
    onGround: true,
    nearbyLogs: [],
    farPerception: {
      loadedChunkCount: 9,
      scannedChunkCount: 9,
      resources: [{
        resource: 'wood',
        targets: [],
        directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
      }],
    },
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
    ...overrides,
  };
}

function villageDiscovery() {
  return {
    id: 'village:184:-96',
    type: 'village',
    dimension: 'overworld',
    x: 184,
    y: 72,
    z: -96,
    confidence: 0.94,
    signals: { beds: 5, hayBales: 18, villagers: 7, ironGolem: 1 },
  };
}

function villageReceipt(intent, result, worldId, routeReplanCount = 0) {
  return {
    commandId: intent.commandId,
    action: intent.action,
    opportunityId: intent.opportunityId,
    opportunityRevision: intent.opportunityRevision,
    detourId: intent.detourId,
    detourStageSeq: intent.detourStageSeq,
    stage: intent.opportunityStage,
    result,
    receiptId: `receipt:${intent.commandId}`,
    worldId,
    dimension: 'overworld',
    mission: intent.opportunityMission,
    routeReplanCount,
    inventoryDelta: {},
  };
}

function activeVillageScenario(suffix = 'strategy') {
  const worldId = `world:${suffix}`;
  const rawVillage = {
    id: `village:${suffix}`,
    type: 'village',
    x: 8,
    y: 70,
    z: 0,
    count: 4,
    status: 'observed',
    signals: ['access_proven', 'hazard_free', 'executor_ready'],
    executorReady: true,
    safe: true,
  };
  const snapshot = {
    ...createInitialState({ x: 0, y: 70, z: 0 }),
    worldIdentity: { id: worldId, dimension: 'overworld' },
    dimension: 'overworld',
    onGround: true,
    isDaytime: true,
    nearbyHostileCount: 0,
    inventoryItemCounts: {},
    opportunityDiscoveries: [rawVillage],
  };
  const selected = {
    id: rawVillage.id,
    type: rawVillage.type,
    observedRevision: 3,
    semanticRevision: villageOpportunitySemanticFingerprint(rawVillage),
    x: rawVillage.x,
    y: rawVillage.y,
    z: rawVillage.z,
    status: rawVillage.status,
    count: rawVillage.count,
    signals: rawVillage.signals,
    safe: true,
    ready: true,
    feasible: true,
    aggregateMembers: [],
  };
  const decision = {
    decisionId: `decision:${suffix}`,
    claimId: `claim:${suffix}`,
    mode: 'active',
    worldId,
    dimension: 'overworld',
    missionGoal: 'armor',
    defaultObjective: 'GATHER_WOOD',
    memoryRevision: 2,
    ledgerRevision: `ledger:${suffix}`,
    inventoryFingerprint: villageOpportunityInventoryFingerprint(snapshot),
    admissionPosition: { x: 0, y: 70, z: 0 },
    shouldSwitch: true,
    reason: 'opportunity_selected',
    recommendation: {
      choiceId: `opportunity:${rawVillage.id}`,
      kind: 'opportunity',
      opportunityIds: [rawVillage.id],
      scoreSeconds: 10,
      conservativeBenefitSeconds: 100,
    },
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:wood_complete': 1 } },
    selectedOpportunities: [selected],
  };
  return { worldId, rawVillage, snapshot, decision };
}

async function runCompletedVillageResume(
  instanceId,
  authoritativeInventory = {},
  routeReplanCount = 0,
  missionGoal = null,
) {
  const events = [];
  const worldId = `world:${instanceId}`;
  const rawVillage = {
    id: `village:${instanceId}`, type: 'village', x: 8, y: 70, z: 0, count: 4, status: 'observed',
    signals: ['access_proven', 'hazard_free', 'executor_ready'], executorReady: true, safe: true,
  };
  const base = {
    ...createInitialState({
      logs: 6, planks: 16, sticks: 12, craftingTables: 1,
      woodenPickaxes: 1, cobblestone: 12, stonePickaxes: 2,
      stoneSwords: 1, furnaces: 1, x: 0, y: 70, z: 0,
    }),
    worldIdentity: { id: worldId, dimension: 'overworld' },
    dimension: 'overworld',
    onGround: true,
    isDaytime: true,
    nearbyHostileCount: 0,
    inventoryItemCounts: {},
    opportunityDiscoveries: [rawVillage],
  };
  const chosen = {
    id: rawVillage.id,
    type: rawVillage.type,
    observedRevision: 3,
    semanticRevision: villageOpportunitySemanticFingerprint(rawVillage),
    x: rawVillage.x,
    y: rawVillage.y,
    z: rawVillage.z,
    status: rawVillage.status,
    count: rawVillage.count,
    signals: rawVillage.signals,
    safe: true,
    ready: true,
    feasible: true,
    aggregateMembers: [],
  };
  let latest = null;
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (event) => events.push(event),
    ...(missionGoal ? { missionGoal } : {}),
    opportunityCoordinator: {
      mode: 'active',
      observe() {},
      latestDecision() { return latest; },
      applyVillageReceipt() { return { ok: true }; },
    },
  });

  const baseline = await handle(instanceId, base);
  assert.equal(baseline.action, 'descend_staircase');
  latest = {
    decisionId: `decision:${instanceId}`,
    claimId: `claim:${instanceId}`,
    mode: 'active',
    worldId,
    dimension: 'overworld',
    missionGoal: missionGoal || 'armor',
    defaultObjective: 'DESCEND',
    memoryRevision: 2,
    ledgerRevision: `ledger:${instanceId}`,
    inventoryFingerprint: villageOpportunityInventoryFingerprint(base),
    admissionPosition: { x: 0, y: 70, z: 0 },
    shouldSwitch: true,
    reason: 'opportunity_selected',
    recommendation: {
      choiceId: `opportunity:${rawVillage.id}`,
      kind: 'opportunity',
      opportunityIds: [rawVillage.id],
      scoreSeconds: 10,
      conservativeBenefitSeconds: 100,
    },
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:iron_pickaxe': 1 } },
    selectedOpportunities: [chosen],
  };

  let intent = await handle(instanceId, {
    ...base,
    currentCommandCompleted: true,
    currentCommandId: baseline.commandId,
  });
  assert.equal(intent.action, 'village_travel', JSON.stringify(events));
  intent = await handle(instanceId, {
    ...base,
    x: intent.targetX,
    y: intent.targetY,
    z: intent.targetZ,
    currentCommandCompleted: true,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: 'village_travel_complete:opportunity_arrived',
    villageOpportunityReceipt: villageReceipt(intent, 'arrived', worldId, routeReplanCount),
  });
  assert.equal(intent.action, 'village_revalidate');
  intent = await handle(instanceId, {
    ...base,
    x: 8,
    currentCommandCompleted: true,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: 'village_revalidate_complete:opportunity_verified',
    villageOpportunityReceipt: villageReceipt(intent, 'verified', worldId),
  });
  assert.equal(intent.action, 'stop');
  assert.equal(intent.opportunityStage, 'complete');
  const terminal = intent;

  const resumedSnapshot = {
    ...base,
    x: 8,
    ...authoritativeInventory,
    currentCommandCompleted: true,
    currentCommandId: terminal.commandId,
    currentCommandCompletionReason: 'stop_complete:opportunity_complete',
  };
  const resumed = await handle(instanceId, resumedSnapshot);
  return { events, terminal, resumed, resumedSnapshot, handle };
}

test('handler returns well-formed intents (valid action id + required fields)', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: (s) => signals.push(s) });
  const intent = await handle('inst-1', createInitialState());
  assert.ok(VALID_ACTIONS.has(intent.action), `bad action id: ${intent.action}`);
  assert.equal(typeof intent.ttlMs, 'number');
  assert.equal(typeof intent.maxTtlMs, 'number');
  assert.match(intent.commandId, /^mission-inst-1-\d+$/);
  assert.equal(typeof intent.missionDone, 'boolean');
  assert.equal(intent.completionInventoryLogCount, 20);
  assert.equal(intent.completionInventoryPlankCount, 48);
});

test('mission gather_tree intents freeze exact wood requirements on a stable command', async () => {
  const defaultHandle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const first = await defaultHandle('wood-default', createInitialState());
  const continued = await defaultHandle('wood-default', createInitialState());
  assert.equal(continued.commandId, first.commandId);
  assert.equal(continued.completionInventoryLogCount, 20);
  assert.equal(continued.completionInventoryPlankCount, 48);

  const ironHandle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    missionGoal: 'iron_pickaxe',
  });
  const iron = await ironHandle('wood-iron', createInitialState());
  assert.equal(iron.action, 'gather_tree');
  assert.equal(iron.completionInventoryLogCount, 5);
  assert.equal(iron.completionInventoryPlankCount, 18);

  const diamondHandle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    missionGoal: 'diamond',
  });
  const diamond = await diamondHandle('wood-diamond', createInitialState());
  assert.equal(diamond.action, 'gather_tree');
  assert.equal(diamond.completionInventoryLogCount, 5);
  assert.equal(diamond.completionInventoryPlankCount, 18);

  const unrelated = await defaultHandle('wood-unrelated', createInitialState({ logs: 20 }));
  assert.equal(unrelated.action, 'craft_planks');
  assert.equal(Object.hasOwn(unrelated, 'completionInventoryLogCount'), false);
  assert.equal(Object.hasOwn(unrelated, 'completionInventoryPlankCount'), false);
});

test('mission mine_nearby_stone intents carry the exact absolute cobblestone stage target', async () => {
  const defaultHandle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const armor = await defaultHandle('stone-armor', createInitialState({
    logs: 20,
    woodenPickaxes: 1,
  }));
  assert.equal(armor.action, 'mine_nearby_stone');
  assert.equal(armor.completionInventoryCobblestoneCount, 8);

  const continued = await defaultHandle('stone-armor', createInitialState({
    logs: 20,
    woodenPickaxes: 1,
    cobblestone: 7,
  }));
  assert.equal(continued.commandId, armor.commandId);
  assert.equal(continued.completionInventoryCobblestoneCount, 8);

  const ironHandle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    missionGoal: 'iron_pickaxe',
  });
  const pickaxeOnly = await ironHandle('stone-pickaxe-only', createInitialState({
    logs: 5,
    woodenPickaxes: 1,
  }));
  assert.equal(pickaxeOnly.action, 'mine_nearby_stone');
  assert.equal(pickaxeOnly.completionInventoryCobblestoneCount, 3);

  const armorReserve = await defaultHandle('stone-armor-reserve', createInitialState({
    logs: 20,
    stonePickaxes: 2,
    stoneSwords: 1,
    y: 70,
  }));
  assert.equal(armorReserve.action, 'mine_nearby_stone');
  assert.equal(armorReserve.completionInventoryCobblestoneCount, 11);

  const pickaxeOnlyReserve = await ironHandle('stone-pickaxe-only-reserve', createInitialState({
    logs: 5,
    targetIronPickaxeOnly: true,
    stonePickaxes: 1,
    y: 70,
  }));
  assert.equal(pickaxeOnlyReserve.action, 'mine_nearby_stone');
  assert.equal(pickaxeOnlyReserve.completionInventoryCobblestoneCount, 14);

  const villagePickaxeFurnace = await defaultHandle('stone-village-pickaxe-furnace', createInitialState({
    logs: 20,
    sticks: 4,
    craftingTables: 1,
    ironPickaxes: 1,
    cobblestone: 0,
    furnaces: 0,
    foodLevel: 20,
    y: 70,
  }));
  assert.equal(villagePickaxeFurnace.action, 'mine_nearby_stone');
  assert.equal(villagePickaxeFurnace.completionInventoryCobblestoneCount, 8);

  const unrelated = await defaultHandle('stone-unrelated', createInitialState({ logs: 20 }));
  assert.equal(unrelated.action, 'craft_planks');
  assert.equal(Object.hasOwn(unrelated, 'completionInventoryCobblestoneCount'), false);
});

test('handler binds a provisional stone anchor to each stable command id and rejects stale-command descent', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: (signal) => signals.push(signal) });
  const start = createInitialState({
    logs: 20,
    woodenPickaxes: 1,
    x: 5.8,
    y: 70.9,
    z: -2.2,
    onGround: true,
    touchingWater: false,
  });

  const first = await handle('stone-anchor-owner', start);
  assert.equal(first.action, 'mine_nearby_stone');

  const retry = await handle('stone-anchor-owner', {
    ...start,
    currentCommandCompleted: true,
    currentCommandId: first.commandId,
    currentCommandCompletionReason: 'mine_nearby_stone_failed:no_safe_route',
  });
  assert.equal(retry.action, 'mine_nearby_stone');
  assert.notEqual(retry.commandId, first.commandId);
  assert.ok(signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_declined'
      && signal.commandId === first.commandId
      && signal.reason === 'stone_command_failed_without_grounded_descent'
  )));

  const activationCountBefore = signals.filter((signal) => signal.evt === 'mission.surface_return.anchor_activated').length;
  const stale = await handle('stone-anchor-owner', {
    ...start,
    y: 69.2,
    cobblestone: 1,
    activeNavigationCommandId: first.commandId,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(stale.commandId, retry.commandId, 'the retry keeps its stable identity while the stale response is ignored');
  assert.equal(
    signals.filter((signal) => signal.evt === 'mission.surface_return.anchor_activated').length,
    activationCountBefore,
    'lower progress reported under the old command cannot activate the retry anchor',
  );

  const matching = await handle('stone-anchor-owner', {
    ...start,
    y: 69.2,
    cobblestone: 1,
    activeNavigationCommandId: retry.commandId,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
  });
  assert.equal(matching.commandId, retry.commandId);
  assert.ok(signals.some((signal) => (
    signal.evt === 'mission.surface_return.anchor_activated'
      && signal.commandId === retry.commandId
      && signal.reason === 'grounded_lower_stance'
  )));
});

test('active canary setup observations target the first unopened boundary', async () => {
  const scheduled = [];
  const observations = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    setupCommands: ['time set day'],
    setupSettleMs: 500,
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: { mode: 'active', observe() {}, latestDecision() { return null; } },
    strategyCoordinator: {
      mode: 'active_canary',
      observe(_instanceId, _snapshot, context) { observations.push(context); },
      consumeBoundary() { throw new Error('setup cannot consume a boundary'); },
    },
  });

  const setup = await handle('strategy-setup', createInitialState());
  assert.equal(setup.action, 'setup_commands');
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].preMissionObservation, true);
  assert.equal(observations[0].strategyTrigger, 'pre_mission_setup');
  assert.equal(observations[0].targetBoundaryGeneration, 1);
  assert.equal(observations[0].boundaryOpen, false);
});

test('active canary baseline choice suppresses deterministic detour for exactly one boundary', async () => {
  const { snapshot, decision } = activeVillageScenario('strategy-baseline');
  const consumes = [];
  const expirations = [];
  const events = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (event) => events.push(event),
    opportunityCoordinator: {
      mode: 'active',
      observe() {},
      latestDecision() { return decision; },
    },
    strategyCoordinator: {
      mode: 'active_canary',
      observe() {},
      consumeBoundary(_instanceId, _observedSnapshot, context) {
        consumes.push(context.boundaryGeneration);
        if (context.boundaryGeneration === 1) {
          return { ok: true, outcome: 'baseline', boundaryGeneration: 1 };
        }
        return { ok: false, reason: 'no_ready_receipt', boundaryGeneration: context.boundaryGeneration };
      },
      expireBoundary(instanceId, generation, reason) {
        expirations.push({ instanceId, generation, reason });
      },
    },
  });

  const first = await handle('strategy-baseline', snapshot);
  assert.equal(first.action, 'gather_tree');
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.started'), false);
  const held = await handle('strategy-baseline', snapshot);
  assert.equal(held.commandId, first.commandId);
  assert.deepEqual(consumes, [1]);

  const nextBoundary = await handle('strategy-baseline', {
    ...snapshot,
    currentCommandCompleted: true,
    currentCommandId: first.commandId,
  });
  assert.equal(nextBoundary.action, 'village_travel',
    'an absent receipt at the next boundary immediately restores deterministic opportunity choice');
  assert.deepEqual(consumes, [1, 2]);
  assert.deepEqual(expirations.map((entry) => entry.generation), [2],
    'a consumed baseline receipt closes itself; only the unanswered boundary is expired');
  assert.ok(expirations.every((entry) => entry.reason === 'physical_choice_committed'));
});

test('active canary opportunity choice enters the existing transaction without a deterministic latest decision', async () => {
  const { snapshot, decision } = activeVillageScenario('strategy-opportunity');
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    opportunityCoordinator: {
      mode: 'active',
      observe() {},
      latestDecision() { return null; },
    },
    strategyCoordinator: {
      mode: 'active_canary',
      observe() {},
      consumeBoundary() {
        return { ok: true, outcome: 'opportunity', decision, boundaryGeneration: 1 };
      },
    },
  });

  const intent = await handle('strategy-opportunity', snapshot);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, 'village:strategy-opportunity');
  assert.equal(intent.missionObjective, 'GATHER_WOOD');
});

test('active canary absent, rejected, and late receipts fall back without interrupting an in-flight command', async (t) => {
  for (const [label, firstReceipt] of [
    ['absent', { ok: false, reason: 'no_ready_receipt' }],
    ['rejected', { ok: false, reason: 'dominated_choice' }],
  ]) {
    await t.test(label, async () => {
      const { snapshot, decision } = activeVillageScenario(`strategy-${label}`);
      const handle = createMissionBrainHandler({
        complete: oracleBrain(),
        emit: () => {},
        opportunityCoordinator: {
          mode: 'active', observe() {}, latestDecision() { return decision; },
        },
        strategyCoordinator: {
          mode: 'active_canary', observe() {}, consumeBoundary() { return firstReceipt; },
        },
      });
      const intent = await handle(`strategy-${label}`, snapshot);
      assert.equal(intent.action, 'village_travel');
    });
  }

  await t.test('late', async () => {
    const { snapshot, decision } = activeVillageScenario('strategy-late');
    let ready = false;
    const consumed = [];
    const handle = createMissionBrainHandler({
      complete: oracleBrain(),
      emit: () => {},
      opportunityCoordinator: {
        mode: 'active', observe() {}, latestDecision() { return null; },
      },
      strategyCoordinator: {
        mode: 'active_canary',
        observe() {},
        consumeBoundary(_instanceId, _observedSnapshot, context) {
          consumed.push(context.boundaryGeneration);
          return ready
            ? { ok: true, outcome: 'opportunity', decision, boundaryGeneration: context.boundaryGeneration }
            : { ok: false, reason: 'no_ready_receipt', boundaryGeneration: context.boundaryGeneration };
        },
      },
    });
    const first = await handle('strategy-late', snapshot);
    assert.equal(first.action, 'gather_tree');
    ready = true;
    const held = await handle('strategy-late', snapshot);
    assert.equal(held.action, 'gather_tree');
    assert.equal(held.commandId, first.commandId);
    assert.deepEqual(consumed, [1], 'late strategy output cannot be consumed in flight');
    const next = await handle('strategy-late', {
      ...snapshot,
      currentCommandCompleted: true,
      currentCommandId: first.commandId,
    });
    assert.equal(next.action, 'village_travel');
    assert.deepEqual(consumed, [1, 2]);
  });
});

test('verified village outcome prepares the next unopened strategy boundary', async () => {
  const scheduled = [];
  const observations = [];
  const { snapshot, decision } = activeVillageScenario('strategy-outcome');
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: {
      mode: 'active', observe() {}, latestDecision() { return decision; },
    },
    strategyCoordinator: {
      mode: 'active_canary',
      observe(_instanceId, _snapshot, context) { observations.push(context); },
      consumeBoundary() { return { ok: false, reason: 'no_ready_receipt' }; },
    },
  });

  const travel = await handle('strategy-outcome', snapshot);
  assert.equal(travel.action, 'village_travel');
  const terminal = await handle('strategy-outcome', {
    ...snapshot,
    currentCommandCompleted: true,
    currentCommandId: travel.commandId,
    currentCommandCompletionReason: 'village_travel_failed:no_safe_route',
  });
  assert.equal(terminal.action, 'stop');
  assert.equal(terminal.opportunityStage, 'fallback');
  assert.equal(scheduled.length, 1, 'latest-wins mailbox retains the verified terminal outcome');
  await scheduled.shift()();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].strategyTrigger, 'verified_opportunity_outcome');
  assert.equal(observations[0].verifiedOpportunityOutcome, 'fallback');
  assert.equal(observations[0].targetBoundaryGeneration, 2);
});

test('opportunity shadow observes the final intent without changing physical output or command identity', async () => {
  const observations = [];
  const scheduled = [];
  let forbiddenProviderCalls = 0;
  let handlerReturned = false;
  const baseline = createMissionBrainHandler({
    complete: oracleBrain(), emit: () => {}, missionGoal: 'iron_pickaxe',
  });
  const shadow = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    missionGoal: 'iron_pickaxe',
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: {
      complete() {
        forbiddenProviderCalls += 1;
        throw new Error('opportunity shadow must not call a provider');
      },
      observe(instanceId, observedSnapshot, context) {
        assert.equal(handlerReturned, true, 'observer ran on the deterministic response path');
        observations.push({ instanceId, observedSnapshot, context });
        return {
          action: 'stop',
          commandId: 'shadow-must-not-apply',
          targetX: 999,
        };
      },
    },
  });
  const state = createInitialState({
    nearbyLogs: [{ x: 4, y: 64, z: -2 }],
  });

  const baselineFirst = await baseline('opportunity-equivalence', state);
  const shadowFirst = await shadow('opportunity-equivalence', state);
  handlerReturned = true;
  assert.equal(JSON.stringify(shadowFirst), JSON.stringify(baselineFirst));
  assert.equal(shadowFirst.commandId, baselineFirst.commandId);
  assert.equal(shadowFirst.targetX, 4);
  assert.equal(shadowFirst.targetY, 64);
  assert.equal(shadowFirst.targetZ, -2);
  assert.equal(observations.length, 0);
  assert.equal(scheduled.length, 1);

  const baselineHeld = await baseline('opportunity-equivalence', state);
  const shadowHeld = await shadow('opportunity-equivalence', state);
  assert.equal(JSON.stringify(shadowHeld), JSON.stringify(baselineHeld));
  assert.equal(shadowHeld.commandId, shadowFirst.commandId);
  assert.equal(scheduled.length, 1, 'a pending observation must not schedule duplicate work');
  await scheduled.shift()();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].instanceId, 'opportunity-equivalence');
  assert.equal(observations[0].observedSnapshot.missionGoal, 'iron_pickaxe');
  assert.equal(observations[0].context.defaultObjective, 'GATHER_WOOD');
  assert.equal(observations[0].context.behaviorApplied, false);
  assert.deepEqual(observations[0].context.appliedIntent, shadowHeld);
  assert.equal(forbiddenProviderCalls, 0);
});

test('opportunity shadow exceptions are contained after deterministic intent selection', async () => {
  const events = [];
  const scheduled = [];
  const baseline = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const shadow = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (event) => events.push(event),
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: {
      observe() {
        throw new Error('shadow exploded\nwith detail');
      },
    },
  });
  const state = createInitialState();

  const baselineIntent = await baseline('opportunity-error', state);
  const shadowIntent = await shadow('opportunity-error', state);
  assert.equal(JSON.stringify(shadowIntent), JSON.stringify(baselineIntent));
  assert.equal(events.some((event) => event.evt === 'opportunity.shadow.rejected'), false);
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.deepEqual(events.filter((event) => event.evt === 'opportunity.shadow.rejected'), [{
    evt: 'opportunity.shadow.rejected',
    instanceId: 'opportunity-error',
    trigger: 'observation',
    deterministicObjective: 'GATHER_WOOD',
    reason: 'shadow exploded with detail',
    behaviorApplied: false,
  }]);
});

test('opportunity shadow mailbox coalesces bursts and retains only the latest state while busy', async () => {
  const scheduled = [];
  const observedMarkers = [];
  let releaseFirst;
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: {
      observe(_instanceId, snapshot) {
        observedMarkers.push(snapshot.shadowMarker);
        if (observedMarkers.length === 1) {
          return new Promise((resolve) => { releaseFirst = resolve; });
        }
        return undefined;
      },
    },
  });
  const state = createInitialState();

  await handle('opportunity-backpressure', { ...state, shadowMarker: 1 });
  await handle('opportunity-backpressure', { ...state, shadowMarker: 2 });
  await handle('opportunity-backpressure', { ...state, shadowMarker: 3 });
  assert.equal(scheduled.length, 1);
  const firstDrain = scheduled.shift()();
  assert.deepEqual(observedMarkers, [3], 'pre-launch burst must be latest-wins');

  await handle('opportunity-backpressure', { ...state, shadowMarker: 4 });
  await handle('opportunity-backpressure', { ...state, shadowMarker: 5 });
  assert.equal(scheduled.length, 0, 'busy observer may retain only one unscheduled pending entry');
  releaseFirst();
  await firstDrain;
  assert.equal(scheduled.length, 1, 'settlement schedules exactly one drain for the pending latest state');
  await scheduled.shift()();
  assert.deepEqual(observedMarkers, [3, 5]);
  assert.equal(scheduled.length, 0);
});

test('opportunity shadow mailboxes are isolated per instance', async () => {
  const scheduled = [];
  const observed = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: {
      observe(instanceId, snapshot) {
        observed.push([instanceId, snapshot.shadowMarker]);
      },
    },
  });
  const state = createInitialState();

  await handle('opportunity-a', { ...state, shadowMarker: 1 });
  await handle('opportunity-a', { ...state, shadowMarker: 2 });
  await handle('opportunity-b', { ...state, shadowMarker: 3 });
  assert.equal(scheduled.length, 2, 'each instance may own at most one scheduled drain');
  await scheduled.shift()();
  await scheduled.shift()();
  assert.deepEqual(observed, [
    ['opportunity-a', 2],
    ['opportunity-b', 3],
  ]);
});

test('opportunity shadow lifecycle hooks flush latest work and close bounded admission', async () => {
  const scheduled = [];
  const observed = [];
  let releaseRunning;
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: {
      observe(_instanceId, snapshot) {
        observed.push(snapshot.shadowMarker);
        if (snapshot.shadowMarker === 3) {
          return new Promise((resolve) => { releaseRunning = resolve; });
        }
        return undefined;
      },
    },
  });
  const state = createInitialState();

  assert.equal(typeof handle.flushOpportunityObservations, 'function');
  assert.equal(typeof handle.closeOpportunityObservations, 'function');

  await handle('opportunity-lifecycle', { ...state, shadowMarker: 1 });
  await handle('opportunity-lifecycle', { ...state, shadowMarker: 2 });
  await handle.flushOpportunityObservations('opportunity-lifecycle');
  assert.deepEqual(observed, [2], 'explicit flush drains only the latest queued state');
  assert.equal(scheduled.length, 1, 'the original scheduler callback remains harmlessly queued');
  await scheduled.shift()();
  assert.deepEqual(observed, [2], 'late scheduler callback cannot duplicate flushed work');

  await handle('opportunity-lifecycle', { ...state, shadowMarker: 3 });
  const runningDrain = scheduled.shift()();
  assert.deepEqual(observed, [2, 3]);
  await handle('opportunity-lifecycle', { ...state, shadowMarker: 4 });
  await handle('opportunity-lifecycle', { ...state, shadowMarker: 5 });

  const closePromise = handle.closeOpportunityObservations();
  await handle('opportunity-lifecycle', { ...state, shadowMarker: 6 });
  releaseRunning();
  await runningDrain;
  await closePromise;
  assert.deepEqual(observed, [2, 3, 5], 'close waits for one running plus one latest pending item');

  while (scheduled.length > 0) await scheduled.shift()();
  await handle('opportunity-lifecycle', { ...state, shadowMarker: 7 });
  assert.deepEqual(observed, [2, 3, 5], 'closed handler no longer admits shadow observer work');
  assert.equal(scheduled.length, 0);
});

test('active village detour consumes its receipts outside MissionOrchestrator and resumes the exact baseline', async () => {
  let now = 1_000;
  const events = [];
  const scheduled = [];
  const rawVillage = {
    id: 'village:active', type: 'village', x: 8, y: 70, z: 0, count: 4, status: 'observed',
    signals: ['access_proven', 'hazard_free', 'executor_ready'], executorReady: true, safe: true,
  };
  const base = {
    ...createInitialState({ x: 0, y: 70, z: 0 }),
    worldIdentity: { id: 'world:active', dimension: 'overworld' },
    dimension: 'overworld',
    onGround: true,
    isDaytime: true,
    nearbyHostileCount: 0,
    inventoryItemCounts: {},
    opportunityDiscoveries: [rawVillage],
  };
  const chosen = {
    id: rawVillage.id,
    type: rawVillage.type,
    observedRevision: 3,
    semanticRevision: villageOpportunitySemanticFingerprint(rawVillage),
    x: rawVillage.x, y: rawVillage.y, z: rawVillage.z,
    status: rawVillage.status,
    count: rawVillage.count,
    signals: rawVillage.signals,
    safe: true, ready: true, feasible: true,
    aggregateMembers: [],
  };
  const activeDecision = {
    decisionId: 'decision:active', claimId: 'claim:active', mode: 'active',
    worldId: 'world:active', dimension: 'overworld', missionGoal: 'armor',
    defaultObjective: 'GATHER_WOOD', memoryRevision: 2, ledgerRevision: 'ledger:active',
    inventoryFingerprint: villageOpportunityInventoryFingerprint(base),
    admissionPosition: { x: 0, y: 70, z: 0 },
    shouldSwitch: true, reason: 'opportunity_selected',
    recommendation: { choiceId: 'opportunity:village:active', kind: 'opportunity',
      opportunityIds: ['village:active'], scoreSeconds: 10, conservativeBenefitSeconds: 100 },
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:wood_complete': 1 } },
    selectedOpportunities: [chosen],
  };
  let latest = null;
  const coordinator = {
    mode: 'active',
    observe() {},
    latestDecision() { return latest; },
    applyVillageReceipt() { return { ok: true }; },
  };
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (event) => events.push(event),
    now: () => now,
    opportunityCoordinator: coordinator,
    opportunityScheduler: (task) => scheduled.push(task),
  });

  const baselineIntent = await handle('active-detour', base);
  assert.equal(baselineIntent.action, 'gather_tree');
  latest = activeDecision;
  const uninterrupted = await handle('active-detour', base);
  assert.equal(uninterrupted.commandId, baselineIntent.commandId,
    'an async decision cannot replace a command Fabric has already started');
  assert.equal(uninterrupted.action, baselineIntent.action);
  assert.equal(events.some((event) => event.evt === 'opportunity.active.baseline_retained'
    && event.reason === 'baseline_command_in_flight'), true);

  const travel = await handle('active-detour', {
    ...base,
    currentCommandCompleted: true,
    currentCommandId: baselineIntent.commandId,
    currentCommandCompletionReason: '',
  });
  assert.equal(travel.action, 'village_travel');
  assert.equal(travel.missionObjective, 'GATHER_WOOD');

  now += 60_000;
  const held = await handle('active-detour', { ...base, x: 4 });
  assert.equal(held.commandId, travel.commandId, 'held travel does not step or remint the baseline');
  assert.equal(events.some((event) => event.evt === 'mission.objective.failed'), false);

  const terminal = await handle('active-detour', {
    ...base,
    x: 4,
    currentCommandCompleted: true,
    currentCommandId: travel.commandId,
    currentCommandCompletionReason: 'village_travel_failed:no_safe_route',
  });
  assert.equal(terminal.action, 'stop');
  assert.equal(terminal.opportunityStage, 'fallback');
  assert.equal(events.filter((event) => event.evt === 'opportunity.detour.replanned').length, 0,
    'the one physical route replan belongs to Java before its terminal receipt');

  const resumed = await handle('active-detour', {
    ...base,
    x: 4,
    currentCommandCompleted: true,
    currentCommandId: terminal.commandId,
    currentCommandCompletionReason: 'stop_complete:opportunity_fallback',
  });
  assert.equal(resumed.action, 'gather_tree');
  const started = events.find((event) => event.evt === 'opportunity.detour.started');
  assert.equal(started.health, 20);
  assert.equal(resumed.commandId, started.originalCommandId,
    'neutral detour completion cannot consume or remint the new boundary command frozen before dispatch');
  assert.notEqual(resumed.commandId, baselineIntent.commandId,
    'the already-completed pre-detour command is not resurrected');
  assert.equal(events.filter((event) => event.evt === 'mission.objective.failed').length, 0);
  const failure = events.find((event) => event.evt === 'opportunity.detour.failed');
  assert.equal(failure.chargedAsBaselineFailure, false);
  assert.equal(failure.retriesConsumed, 0);
  assert.equal(failure.clocksReset, false);
  const baselineResumed = events.filter((event) => event.evt === 'opportunity.detour.baseline_resumed');
  assert.equal(baselineResumed.length, 1);
  assert.deepEqual({
    detourId: baselineResumed[0].detourId,
    resumeToken: baselineResumed[0].resumeToken,
    outcome: baselineResumed[0].outcome,
    terminalCommandId: baselineResumed[0].terminalCommandId,
    originalObjective: baselineResumed[0].originalObjective,
    inventoryIronPickaxeCount: baselineResumed[0].inventoryIronPickaxeCount,
    inventoryIronIngotCount: baselineResumed[0].inventoryIronIngotCount,
    inventoryRawIronCount: baselineResumed[0].inventoryRawIronCount,
    authoritativeInventory: baselineResumed[0].authoritativeInventory,
    ironPickaxe: baselineResumed[0].ironPickaxe,
    ironPickaxeCount: baselineResumed[0].ironPickaxeCount,
    ironPickaxeDeficit: baselineResumed[0].ironPickaxeDeficit,
    ironIngotCount: baselineResumed[0].ironIngotCount,
    ironPickaxeIngotDeficit: baselineResumed[0].ironPickaxeIngotDeficit,
    objective: baselineResumed[0].objective,
    nextObjective: baselineResumed[0].nextObjective,
    nextAction: baselineResumed[0].nextAction,
    objectiveCompleted: baselineResumed[0].objectiveCompleted,
    missionDone: baselineResumed[0].missionDone,
    routeReplanCount: baselineResumed[0].routeReplanCount,
    chargedAsBaselineFailure: baselineResumed[0].chargedAsBaselineFailure,
    clocksReset: baselineResumed[0].clocksReset,
    retriesConsumed: baselineResumed[0].retriesConsumed,
  }, {
    detourId: terminal.detourId,
    resumeToken: terminal.resumeToken,
    outcome: 'fallback',
    terminalCommandId: terminal.commandId,
    originalObjective: 'GATHER_WOOD',
    inventoryIronPickaxeCount: 0,
    inventoryIronIngotCount: 0,
    inventoryRawIronCount: 0,
    authoritativeInventory: true,
    ironPickaxe: false,
    ironPickaxeCount: 0,
    ironPickaxeDeficit: 1,
    ironIngotCount: 0,
    ironPickaxeIngotDeficit: 3,
    objective: 'GATHER_WOOD',
    nextObjective: 'GATHER_WOOD',
    nextAction: 'gather_tree',
    objectiveCompleted: false,
    missionDone: false,
    routeReplanCount: 0,
    chargedAsBaselineFailure: false,
    clocksReset: false,
    retriesConsumed: 0,
  });
  await handle('active-detour', { ...base, x: 4 });
  assert.equal(events.filter((event) => event.evt === 'opportunity.detour.baseline_resumed').length, 1,
    'the terminal-to-baseline handoff is reported exactly once');
});

test('completed village detours report authoritative iron loot on the first exact baseline continuation', async () => {
  const pickaxeCase = await runCompletedVillageResume('resume-pickaxe', {
    ironPickaxes: 1,
    inventoryIronPickaxeCount: 1,
    inventoryIronIngotCount: 0,
    inventoryRawIronCount: 0,
    inventoryItemCounts: { 'minecraft:iron_pickaxe': 1 },
  }, 1);
  assert.equal(pickaxeCase.resumed.action, 'descend_staircase');
  assert.equal(pickaxeCase.resumed.missionDone, false);
  const pickaxeResume = pickaxeCase.events.filter(
    (event) => event.evt === 'opportunity.detour.baseline_resumed',
  );
  assert.equal(pickaxeResume.length, 1);
  assert.deepEqual({
    outcome: pickaxeResume[0].outcome,
    terminalCommandId: pickaxeResume[0].terminalCommandId,
    inventoryIronPickaxeCount: pickaxeResume[0].inventoryIronPickaxeCount,
    inventoryIronIngotCount: pickaxeResume[0].inventoryIronIngotCount,
    inventoryRawIronCount: pickaxeResume[0].inventoryRawIronCount,
    authoritativeInventory: pickaxeResume[0].authoritativeInventory,
    ironPickaxe: pickaxeResume[0].ironPickaxe,
    ironPickaxeCount: pickaxeResume[0].ironPickaxeCount,
    ironPickaxeDeficit: pickaxeResume[0].ironPickaxeDeficit,
    ironIngotCount: pickaxeResume[0].ironIngotCount,
    ironPickaxeIngotDeficit: pickaxeResume[0].ironPickaxeIngotDeficit,
    objective: pickaxeResume[0].objective,
    nextObjective: pickaxeResume[0].nextObjective,
    nextAction: pickaxeResume[0].nextAction,
    objectiveCompleted: pickaxeResume[0].objectiveCompleted,
    missionDone: pickaxeResume[0].missionDone,
    routeReplanCount: pickaxeResume[0].routeReplanCount,
  }, {
    outcome: 'complete',
    terminalCommandId: pickaxeCase.terminal.commandId,
    inventoryIronPickaxeCount: 1,
    inventoryIronIngotCount: 0,
    inventoryRawIronCount: 0,
    authoritativeInventory: true,
    ironPickaxe: true,
    ironPickaxeCount: 1,
    ironPickaxeDeficit: 0,
    ironIngotCount: 0,
    ironPickaxeIngotDeficit: 0,
    objective: 'DESCEND',
    nextObjective: 'DESCEND',
    nextAction: 'descend_staircase',
    objectiveCompleted: false,
    missionDone: false,
    routeReplanCount: 1,
  });
  assert.equal(pickaxeCase.events.some(
    (event) => event.evt === 'opportunity.detour.baseline_resumed'
      && event.nextObjective === 'MAKE_IRON_TOOLS'), false);
  await pickaxeCase.handle('resume-pickaxe', pickaxeCase.resumedSnapshot);
  assert.equal(pickaxeCase.events.filter(
    (event) => event.evt === 'opportunity.detour.baseline_resumed',
  ).length, 1);

  const ingotCase = await runCompletedVillageResume('resume-ingots', {
    ironIngots: 2,
    inventoryIronPickaxeCount: 0,
    inventoryIronIngotCount: 2,
    inventoryRawIronCount: 0,
    inventoryItemCounts: { 'minecraft:iron_ingot': 2 },
  });
  assert.equal(ingotCase.resumed.action, 'descend_staircase');
  assert.equal(ingotCase.resumed.missionDone, false);
  const ingotResume = ingotCase.events.filter(
    (event) => event.evt === 'opportunity.detour.baseline_resumed',
  );
  assert.equal(ingotResume.length, 1);
  assert.deepEqual({
    outcome: ingotResume[0].outcome,
    inventoryIronPickaxeCount: ingotResume[0].inventoryIronPickaxeCount,
    inventoryIronIngotCount: ingotResume[0].inventoryIronIngotCount,
    inventoryRawIronCount: ingotResume[0].inventoryRawIronCount,
    authoritativeInventory: ingotResume[0].authoritativeInventory,
    ironPickaxe: ingotResume[0].ironPickaxe,
    ironPickaxeCount: ingotResume[0].ironPickaxeCount,
    ironPickaxeDeficit: ingotResume[0].ironPickaxeDeficit,
    ironIngotCount: ingotResume[0].ironIngotCount,
    ironPickaxeIngotDeficit: ingotResume[0].ironPickaxeIngotDeficit,
    objective: ingotResume[0].objective,
    nextObjective: ingotResume[0].nextObjective,
    nextAction: ingotResume[0].nextAction,
    objectiveCompleted: ingotResume[0].objectiveCompleted,
    missionDone: ingotResume[0].missionDone,
    routeReplanCount: ingotResume[0].routeReplanCount,
  }, {
    outcome: 'complete',
    inventoryIronPickaxeCount: 0,
    inventoryIronIngotCount: 2,
    inventoryRawIronCount: 0,
    authoritativeInventory: true,
    ironPickaxe: false,
    ironPickaxeCount: 0,
    ironPickaxeDeficit: 1,
    ironIngotCount: 2,
    ironPickaxeIngotDeficit: 1,
    objective: 'DESCEND',
    nextObjective: 'DESCEND',
    nextAction: 'descend_staircase',
    objectiveCompleted: false,
    missionDone: false,
    routeReplanCount: 0,
  });

  const shortcutCase = await runCompletedVillageResume('resume-golem-shortcut', {
    ironIngots: 4,
    inventoryIronPickaxeCount: 0,
    inventoryIronIngotCount: 4,
    inventoryRawIronCount: 0,
    inventoryItemCounts: { 'minecraft:iron_ingot': 4 },
  }, 0, 'iron_pickaxe');
  assert.equal(shortcutCase.resumed.action, 'place_table');
  assert.equal(shortcutCase.resumed.missionObjective, 'MAKE_IRON_TOOLS');
  const shortcutResume = shortcutCase.events.find(
    (event) => event.evt === 'opportunity.detour.baseline_resumed',
  );
  assert.equal(shortcutResume.nextObjective, 'MAKE_IRON_TOOLS');
  assert.equal(shortcutResume.nextAction, 'place_table');
  assert.equal(shortcutResume.ironIngotCount, 4);
  assert.equal(shortcutCase.events.filter(
    (event) => event.evt === 'opportunity.detour.authoritative_replan'
      && event.fromObjective === 'DESCEND'
      && event.toObjective === 'MAKE_IRON_TOOLS',
  ).length, 1);
});

test('setup and settle observations make an active village decision available before the first long baseline command', async () => {
  let now = 1_000;
  const scheduled = [];
  const observed = [];
  const events = [];
  let latest = null;
  const rawVillage = {
    id: 'village:premission', type: 'village', x: 12, y: 70, z: 0, count: 4, status: 'observed',
    signals: ['access_proven', 'hazard_free', 'executor_ready'], executorReady: true, safe: true,
  };
  const fullKit = {
    ...createInitialState({
      logs: 6, planks: 16, sticks: 12, craftingTables: 1,
      woodenPickaxes: 1, cobblestone: 12, stonePickaxes: 2,
      stoneSwords: 1, furnaces: 1, x: 0, y: 70, z: 0,
    }),
    worldIdentity: { id: 'world:premission', dimension: 'overworld' },
    dimension: 'overworld',
    onGround: true,
    isDaytime: true,
    nearbyHostileCount: 0,
    inventoryItemCounts: {},
    opportunityDiscoveries: [rawVillage],
  };
  const coordinator = {
    mode: 'active',
    observe(_instanceId, snapshot, context) {
      observed.push({ snapshot, context });
      if (context.defaultObjective !== 'DESCEND') return;
      latest = {
        decisionId: 'decision:premission', claimId: 'claim:premission', mode: 'active',
        worldId: 'world:premission', dimension: 'overworld', missionGoal: 'armor',
        defaultObjective: 'DESCEND', memoryRevision: 2, ledgerRevision: 'ledger:premission',
        inventoryFingerprint: villageOpportunityInventoryFingerprint(snapshot),
        admissionPosition: { x: 0, y: 70, z: 0 },
        shouldSwitch: true, reason: 'opportunity_selected',
        recommendation: {
          choiceId: 'opportunity:village:premission', kind: 'opportunity',
          opportunityIds: ['village:premission'], scoreSeconds: 10,
          conservativeBenefitSeconds: 100,
        },
        ledger: { owned: {}, reserved: {}, deficit: { 'mission:iron_pickaxe': 1 } },
        selectedOpportunities: [{
          id: rawVillage.id,
          type: rawVillage.type,
          observedRevision: 3,
          semanticRevision: villageOpportunitySemanticFingerprint(rawVillage),
          x: rawVillage.x, y: rawVillage.y, z: rawVillage.z,
          status: rawVillage.status,
          count: rawVillage.count,
          signals: rawVillage.signals,
          safe: true, ready: true, feasible: true,
          aggregateMembers: [],
        }],
      };
    },
    latestDecision() { return latest; },
    applyVillageReceipt() { return { ok: true }; },
  };
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (event) => events.push(event),
    now: () => now,
    missionGoal: 'iron_pickaxe',
    setupCommands: ['time set day', 'give @p minecraft:stone_pickaxe 2'],
    setupSettleMs: 500,
    opportunityCoordinator: coordinator,
    opportunityScheduler: (task) => scheduled.push(task),
  });

  const setup = await handle('premission-opportunity', createInitialState());
  assert.equal(setup.action, 'setup_commands');
  const settle = await handle('premission-opportunity', fullKit);
  assert.equal(settle.action, 'stop');
  assert.equal(settle.reason, 'mission:settle');
  assert.equal(scheduled.length, 1, 'setup/settle snapshots share one latest-wins mailbox drain');
  await scheduled.shift()();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].snapshot.missionGoal, 'iron_pickaxe');
  assert.equal(observed[0].context.defaultObjective, 'DESCEND');
  assert.equal(observed[0].context.preMissionObservation, true);
  assert.equal(observed[0].context.behaviorApplied, false);

  now = 2_000;
  const travel = await handle('premission-opportunity', fullKit);
  assert.equal(travel.action, 'village_travel');
  assert.equal(travel.missionObjective, 'DESCEND');
  const started = events.find((event) => event.evt === 'opportunity.detour.started');
  assert.equal(started.originalObjective, 'DESCEND');
  assert.equal(started.health, 20);
  assert.match(started.originalCommandId, /^mission-premission-opportunity-\d+$/);
  assert.equal(events.some((event) => event.evt === 'opportunity.active.baseline_retained'
    && event.reason === 'baseline_command_in_flight'), false,
  'the first long baseline command must not be emitted before the ready decision is admitted');
});

test('a late active decision cannot interrupt in-flight mining or GUI crafting', async () => {
  for (const [label, state, expectedAction] of [
    ['mining', createInitialState({ logs: 20, woodenPickaxes: 1 }), 'mine_nearby_stone'],
    ['gui', createInitialState({ logs: 20 }), 'craft_planks'],
  ]) {
    const events = [];
    let latest = null;
    const handle = createMissionBrainHandler({
      complete: oracleBrain(),
      emit: (event) => events.push(event),
      opportunityCoordinator: {
        mode: 'active',
        observe() {},
        latestDecision() { return latest; },
      },
      opportunityScheduler: () => {},
    });
    const first = await handle(`late-${label}`, state);
    assert.equal(first.action, expectedAction);
    latest = { decisionId: `decision:late-${label}`, shouldSwitch: true };
    const held = await handle(`late-${label}`, state);
    assert.equal(held.action, expectedAction);
    assert.equal(held.commandId, first.commandId);
    const retained = events.filter((event) => event.evt === 'opportunity.active.baseline_retained'
      && event.reason === 'baseline_command_in_flight');
    assert.equal(retained.length, 1);
    assert.equal(retained[0].health, 20);
    assert.equal(retained[0].foodLevel, 20);
    assert.equal(retained[0].foodDeficit, 0);
    assert.equal(retained[0].missionFoodDeficit, 0);
  }
});

test('orphaned village completion is neutral infrastructure feedback, never a baseline failure', async () => {
  const events = [];
  const coordinator = {
    mode: 'active',
    observe() {},
    latestDecision() { return null; },
  };
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (event) => events.push(event),
    opportunityCoordinator: coordinator,
    opportunityScheduler: () => {},
  });
  const state = createInitialState();
  const first = await handle('orphaned-village', state);
  const resumed = await handle('orphaned-village', {
    ...state,
    currentCommandCompleted: true,
    currentCommandId: 'mission-village-prior-process-7',
    currentCommandCompletionReason: 'village_inspect_container_failed:screen_changed',
  });
  assert.equal(resumed.commandId, first.commandId);
  assert.equal(resumed.action, first.action);
  assert.equal(events.filter((event) => event.evt === 'mission.objective.failed').length, 0);
  assert.equal(events.filter((event) => event.evt === 'opportunity.detour.receipt_rejected'
    && event.reason === 'orphaned_detour_receipt').length, 1);
});

test('a stale latest village receipt cannot hide a later baseline completion', async () => {
  const coordinator = {
    mode: 'active',
    observe() {},
    latestDecision() { return null; },
  };
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    opportunityCoordinator: coordinator,
    opportunityScheduler: () => {},
  });
  const base = createInitialState({ logs: 5 });
  const first = await handle('stale-village-receipt', base);
  const next = await handle('stale-village-receipt', {
    ...base,
    currentCommandCompleted: true,
    currentCommandId: first.commandId,
    currentCommandCompletionReason: 'village_inspect_container_complete:inspected',
    villageOpportunityReceipt: {
      commandId: 'mission-village-prior-detour-4',
      action: 'village_revalidate',
      result: 'verified',
    },
  });
  assert.notEqual(next.commandId, first.commandId);
});

test('handler passes DESCEND_DEEP targetY through to the Fabric client', async () => {
  const handle = createMissionBrainHandler({
    complete: async () => JSON.stringify({ objective: 'DESCEND_DEEP', done: false, reason: 'diamond depth' }),
    emit: () => {},
    forceLlm: true,
  });
  const intent = await handle('inst-1', createInitialState({ ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent, targetDiamondTier: true }));
  assert.equal(intent.action, 'descend_staircase');
  assert.equal(intent.targetY, THRESHOLDS.diamondTargetY);
});

test('opts.missionGoal is merged into the snapshot so the planner targets diamond', async () => {
  // The goal is NOT in the snapshot; it is injected via opts (the adapter reads MCBOT_FABRIC_MISSION_GOAL).
  // With it, a diamond-depth state with iron pickaxes must drive the diamond-mining action.
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {}, missionGoal: 'diamond' });
  // Iron-tier prerequisites satisfied (furnace + iron pickaxe + at depth) so the planner reaches the
  // diamond branch; the goal is what flips it from MAKE_ARMOR to the diamond track.
  const intent = await handle('inst-diamond', createInitialState({
    atIronDepth: true, atDiamondDepth: true, furnaces: 1,
    ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent, ironIngots: 24,
  }));
  assert.equal(intent.missionObjective, 'MINE_DIAMOND');
  assert.equal(intent.action, 'mine_nearby_diamond');
});

test('without a mission goal the same diamond-depth state stays off the diamond track', async () => {
  // Negative control: no goal injected -> targetDiamondTier stays false -> the bot does NOT mine diamond.
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const intent = await handle('inst-default', createInitialState({
    atIronDepth: true, atDiamondDepth: true, furnaces: 1,
    ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent, ironIngots: 24,
  }));
  assert.notEqual(intent.action, 'mine_nearby_diamond');
});

test('handler drives a full mission to DONE through the brain contract', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: (s) => signals.push(s) });
  const res = await runThroughHandler(handle, 'inst-1');
  assert.equal(res.done, true, `did not finish in ${res.steps} steps`);
  assert.ok(res.state.ironPickaxes >= 1 && res.state.equippedArmorPieces >= 4);
  // every emitted action is a valid client action id
  for (const it of res.intents) assert.ok(VALID_ACTIONS.has(it.action), `bad action: ${it.action}`);
  // mission.* signals were emitted, including the terminal one
  assert.ok(signals.some((s) => s.evt === 'mission.objective.chosen'));
  assert.ok(signals.some((s) => s.evt === 'mission.done'));
  // signals carry the instanceId
  assert.ok(signals.every((s) => s.instanceId === 'inst-1'));
});

test('handler surfaces the planner decision (planSource + planReason) for the cockpit', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const intent = await handle('inst-1', createInitialState());
  // First poll re-plans (no active objective) -> mission.objective.chosen captured into the intent.
  assert.equal(intent.planSource, 'oracle');
  assert.equal(typeof intent.planReason, 'string');
  assert.ok(intent.planReason.length > 0, 'planReason should be populated from the decision');
});

test('handler keeps mission state isolated per instanceId', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  // Advance instance A a few steps along its own world; B starts fresh and independently.
  let aState = createInitialState();
  for (let i = 0; i < 5; i += 1) {
    const it = await handle('A', aState);
    aState = applyAction(aState, it.action).state;
  }
  const bFirst = await handle('B', createInitialState());
  // B, brand new, must start at the very first objective (GATHER_WOOD), unaffected by A's progress.
  assert.equal(bFirst.missionObjective, 'GATHER_WOOD');
  assert.equal(bFirst.action, 'gather_tree');
});

test('handler attaches a gather target when the snapshot has nearby logs', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const snap = createInitialState();
  snap.nearbyLogs = [{ x: 12, y: 70, z: -4 }];
  const intent = await handle('inst-1', snap);
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.targetX, 12);
  assert.equal(intent.targetZ, -4);
});

test('handler uses a gather target hint when live perception has no nearby logs yet', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [];
  const intent = await handle('inst-1', snap);
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.targetX, -2);
  assert.equal(intent.targetY, 25);
  assert.equal(intent.targetZ, 0);
  assert.ok(signals.some((s) => (
    s.evt === 'mission.target.used'
      && s.source === 'hint'
      && s.targetX === -2
  )));
  assert.ok(signals.some((s) => s.evt === 'mission.target_hint.used' && s.targetX === -2));
});

test('handler prefers fixture target hints over sensed nearby logs', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [{ x: 12, y: 70, z: -4 }];
  const intent = await handle('inst-1', snap);
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.targetX, -2);
  assert.equal(intent.targetY, 25);
  assert.equal(intent.targetZ, 0);
  assert.ok(signals.some((s) => s.evt === 'mission.target.used' && s.source === 'hint'));
});

test('handler consumes fixture hints that were completed through live perception', async () => {
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
      { action: 'gather_log', x: -3, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [{ x: -2, y: 25, z: 0 }];
  const first = await handle('inst-1', snap);
  assert.equal(first.targetX, -2);
  assert.equal(first.targetY, 25);

  const second = await handle('inst-1', {
    ...snap,
    nearbyLogs: [],
    currentCommandCompleted: true,
  });
  assert.equal(second.targetX, -3);
  assert.equal(second.targetY, 25);
});

test('handler consumes completed gather target hints in fixture order', async () => {
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
      { action: 'gather_log', x: -3, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [];
  const first = await handle('inst-1', snap);
  assert.equal(first.targetX, -2);
  assert.equal(first.targetY, 25);

  const second = await handle('inst-1', { ...snap, currentCommandCompleted: true });
  assert.equal(second.targetX, -3);
  assert.equal(second.targetY, 25);
});

test('handler consumes rejected gather target hints without replaying the same fixture target', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
      { action: 'gather_log', x: -3, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [];
  const first = await handle('inst-1', snap);
  assert.equal(first.targetX, -2);

  const second = await handle('inst-1', {
    ...snap,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_log_failed:adjacent_no_path',
  });
  assert.equal(second.action, 'gather_tree');
  assert.equal(second.targetX, -3);
  assert.ok(signals.some((s) => (
    s.evt === 'mission.target_hint.consumed'
      && s.targetX === -2
      && s.reason === 'gather_log_failed:adjacent_no_path'
  )));
});

test('handler attaches mining target hints without rewriting them to gather hints', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: async () => JSON.stringify({ objective: 'MINE_IRON', done: false, reason: 'fixture iron' }),
    emit: (s) => signals.push(s),
    forceLlm: true,
    targetHints: [
      { action: 'mine_nearby_iron', x: 16, y: 16, z: -3 },
    ],
  });

  const intent = await handle('inst-iron', createInitialState({ atIronDepth: true, stonePickaxes: 1 }));

  assert.equal(intent.action, 'mine_nearby_iron');
  assert.equal(intent.targetX, 16);
  assert.equal(intent.targetY, 16);
  assert.equal(intent.targetZ, -3);
  assert.ok(signals.some((s) => s.evt === 'mission.target_hint.used' && s.action === 'mine_nearby_iron'));
});

test('handler requires an injected complete function', () => {
  assert.throws(() => createMissionBrainHandler({}), /requires opts\.complete/);
});

test('handler reuses the commandId while the command runs, mints a new one when it completes', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const base = createInitialState({ logs: 5 }); // MAKE_WOOD_TOOLS -> craft_planks (stable action)
  const i1 = await handle('inst-1', { ...base, currentCommandCompleted: false }); // first -> mint X
  const i2 = await handle('inst-1', { ...base, currentCommandCompleted: false }); // X still running -> reuse
  const i3 = await handle('inst-1', { ...base, currentCommandCompleted: false }); // still running -> reuse
  assert.equal(i2.commandId, i1.commandId);
  assert.equal(i3.commandId, i1.commandId);
  const i4 = await handle('inst-1', { ...base, currentCommandCompleted: true }); // finished -> new id
  assert.notEqual(i4.commandId, i1.commandId);
});

async function beginLiveShapedSurfaceReturn(handle, instanceId) {
  const surface = createInitialState({
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
  const descent = await handle(instanceId, surface);
  assert.equal(descent.action, 'descend_staircase');

  const atDepthNeedsWood = createInitialState({
    woodenPickaxes: 1,
    cobblestone: 12,
    stonePickaxes: 2,
    stoneSwords: 1,
    furnaces: 1,
    ironIngots: 3,
    atIronDepth: true,
    x: 21.5,
    y: 14.2,
    z: 30.5,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent.complete',
  });
  const returning = await handle(instanceId, atDepthNeedsWood);
  assert.equal(returning.action, 'return_staircase');
  assert.deepEqual(
    [returning.targetX, returning.targetY, returning.targetZ],
    [5, 70, -3],
  );
  return { atDepthNeedsWood, returning };
}

test('handler suppresses an unchanged structural surface-return retry until grounded displacement', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (signal) => signals.push(signal),
  });
  const { atDepthNeedsWood, returning } = await beginLiveShapedSurfaceReturn(handle, 'surface-retries');
  const failedSnapshot = {
    ...atDepthNeedsWood,
    activeNavigationCommandId: returning.commandId,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'return_staircase_failed:return_staircase_timeout',
  };
  assert.equal('currentCommandId' in failedSnapshot, false, 'live-shaped feedback intentionally omits command id');

  const retryOne = await handle('surface-retries', failedSnapshot);
  assert.equal(retryOne.action, 'stop');
  assert.equal(retryOne.reason, 'mission:surface_return_retry_suppressed');
  assert.notEqual(retryOne.commandId, returning.commandId);
  assert.equal(
    signals.filter((signal) => signal.evt === 'mission.surface_return.failed').length,
    1,
  );

  const retransmitted = await handle('surface-retries', failedSnapshot);
  assert.equal(retransmitted.commandId, retryOne.commandId);
  assert.equal(
    signals.filter((signal) => signal.evt === 'mission.surface_return.failed').length,
    1,
  );

  const acknowledgedStop = await handle('surface-retries', {
    ...failedSnapshot,
    activeNavigationCommandId: retryOne.commandId,
  });
  assert.equal(acknowledgedStop.action, 'stop');
  assert.equal(acknowledgedStop.commandId, retryOne.commandId, 'terminal feedback under the stop id cannot churn suppression commands');

  const retryTwo = await handle('surface-retries', {
    ...failedSnapshot,
    activeNavigationCommandId: retryOne.commandId,
    x: atDepthNeedsWood.x + 1,
  });
  assert.equal(retryTwo.action, 'return_staircase');
  assert.notEqual(retryTwo.commandId, retryOne.commandId);
  const failures = signals.filter((signal) => signal.evt === 'mission.surface_return.failed');
  assert.deepEqual(failures.map((signal) => signal.attempts), [1]);
  assert.equal(
    signals.filter((signal) => signal.evt === 'mission.surface_return.retry_suppressed').length,
    1,
  );
  assert.equal(
    signals.filter((signal) => signal.evt === 'mission.surface_return.retry_released').length,
    1,
  );
});

test('handler accepts exact surface arrival after a prior wrong-anchor completion with the same reason', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (signal) => signals.push(signal),
  });
  const { atDepthNeedsWood, returning } = await beginLiveShapedSurfaceReturn(handle, 'surface-mismatch');
  const completionReason = 'return_staircase_complete:surface_reached';

  const mismatch = await handle('surface-mismatch', {
    ...atDepthNeedsWood,
    activeNavigationCommandId: returning.commandId,
    x: 5.5,
    y: 71.2,
    z: -2.5,
    atIronDepth: false,
    currentCommandCompleted: true,
    currentCommandCompletionReason: completionReason,
  });
  assert.equal(mismatch.action, 'return_staircase');
  assert.notEqual(mismatch.commandId, returning.commandId);
  assert.ok(signals.some((signal) => (
    signal.evt === 'mission.surface_return.failed'
      && signal.reason === 'return_staircase_failed:surface_target_mismatch'
  )));

  const arrived = await handle('surface-mismatch', {
    ...atDepthNeedsWood,
    activeNavigationCommandId: mismatch.commandId,
    x: 5.5,
    y: 70.2,
    z: -2.5,
    atIronDepth: false,
    currentCommandCompleted: true,
    currentCommandCompletionReason: completionReason,
  });
  assert.equal(arrived.action, 'gather_tree');
  assert.ok(signals.some((signal) => signal.evt === 'mission.surface_return.completed'));
  assert.equal(
    signals.filter((signal) => signal.evt === 'mission.surface_return.failed').length,
    1,
  );
});

test('neutral workspace fallback hands a remote action to a fresh local setup command', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const remote = createInitialState({
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
  const first = await handle('workspace-fallback', remote);
  assert.equal(first.action, 'smelt_raw_iron');

  const local = await handle('workspace-fallback', {
    ...remote,
    miningWorkspaceReturnAvailable: false,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'smelt_raw_iron_complete:mining_workspace_local_fallback_required',
  });
  assert.equal(local.action, 'craft_table');
  assert.notEqual(local.commandId, first.commandId);
  assert.equal(local.missionObjective, 'SMELT_IRON');
  assert.equal(local.missionDone, false);
});

test('handler aborts when a stalled objective replans to the same action', async () => {
  let now = 1000;
  const signals = [];
  const opportunityObservations = [];
  const scheduled = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    now: () => now,
    stallTimeoutMs: 10,
    abortTimeoutMs: 1000,
    opportunityScheduler: (task) => scheduled.push(task),
    opportunityCoordinator: {
      observe(instanceId, snapshot, context) {
        opportunityObservations.push({ instanceId, snapshot, context });
      },
    },
    // Pin the 1-strike abort plumbing this test exercises; the budgeted GATHER_WOOD retry
    // (default gatherRecoveryLimit 3, run-14 fix) has its own orchestrator-level test.
    gatherRecoveryLimit: 0,
  });
  const base = createInitialState();
  const first = await handle('inst-1', { ...base, currentCommandCompleted: false });
  assert.equal(first.action, 'gather_tree');
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(opportunityObservations.length, 1);

  now += 20;
  const replanned = await handle('inst-1', { ...base, currentCommandCompleted: false });
  assert.equal(replanned.action, 'stop');
  assert.equal(replanned.reason, 'mission:aborted');
  assert.equal(replanned.missionObjective, 'ABORTED');
  assert.equal(replanned.missionDone, true);
  assert.notEqual(replanned.commandId, first.commandId);
  assert.equal(scheduled.length, 0, 'terminal mission intents must not enqueue opportunity work');
  assert.equal(opportunityObservations.length, 1);
  assert.ok(signals.some((s) => s.evt === 'mission.objective.exhausted' && s.reason === 'same_objective_reselected'), 'missing same-objective exhaustion telemetry');
  assert.ok(signals.some((s) => s.evt === 'mission.aborted' && s.reason === 'objective_exhausted'), 'missing objective_exhausted abort telemetry');
});

test('handler sends setup commands once, settles, then drives the mission', async () => {
  let t = 1000;
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    setupCommands: ['time set day', 'give @p minecraft:oak_log 20'],
    setupSettleMs: 500,
    now: () => t,
  });
  // 1st poll -> the setup_commands intent (run once)
  const first = await handle('inst-1', createInitialState());
  assert.equal(first.action, 'setup_commands');
  assert.deepEqual(first.serverCommands, ['time set day', 'give @p minecraft:oak_log 20']);
  // still settling -> idle (don't act until setup lands)
  const settling = await handle('inst-1', createInitialState());
  assert.equal(settling.action, 'stop');
  assert.equal(settling.missionObjective, 'SETUP');
  // after settle -> the mission begins from the (now staged) world
  t = 2000;
  const go = await handle('inst-1', createInitialState({ logs: 20 }));
  assert.equal(go.missionObjective, 'MAKE_WOOD_TOOLS');
});

test('handler exposes deterministic EXPLORE navigation with the injected flag and knobs', async () => {
  let deepseekCallCount = 0;
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: async () => { deepseekCallCount += 1; throw new Error('paid planner must not run'); },
    emit: (signal) => signals.push(signal),
    exploreEnabled: true,
    exploreLegBlocks: 130,
    exploreLegLimit: 4,
    exploreArriveDist: 5,
    exploreHopBlocks: 11,
  });
  const base = liveWoodSearchSnapshot();
  const gather = await handle('inst-explore', base);
  assert.equal(gather.action, 'gather_tree');

  const explore = await handle('inst-explore', {
    ...base,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_tree_complete:bounded_search_exhausted:route_attempt_limit',
  });

  assert.equal(explore.action, 'navigate_to_point');
  assert.equal(explore.missionObjective, 'EXPLORE');
  assert.equal(explore.targetX, 11);
  assert.equal(explore.targetZ, 0);
  assert.match(explore.commandId, /^mission-inst-explore-\d+$/);
  assert.equal(typeof explore.ttlMs, 'number');
  assert.equal(typeof explore.maxTtlMs, 'number');
  assert.equal(deepseekCallCount, 0);
  assert.ok(signals.some((signal) => signal.evt === 'exploration.leg.queued'));
  assert.ok(signals.some((signal) => signal.evt === 'exploration.hop.queued'));

  const nextHop = await handle('inst-explore', { ...base, x: 11, z: 0 });
  assert.equal(nextHop.action, 'navigate_to_point');
  assert.equal(nextHop.targetX, 22);
  assert.notEqual(nextHop.commandId, explore.commandId);
});

test('handler keeps EXPLORE default-off and never bypasses reachable local wood', async () => {
  const exhaustedReason = 'gather_tree_complete:bounded_search_exhausted:route_attempt_limit';
  const base = liveWoodSearchSnapshot();
  const offSignals = [];
  const off = createMissionBrainHandler({ complete: oracleBrain(), emit: (signal) => offSignals.push(signal) });
  await off('inst-off', base);
  const unchanged = await off('inst-off', {
    ...base,
    currentCommandCompleted: true,
    currentCommandCompletionReason: exhaustedReason,
  });
  assert.equal(unchanged.action, 'gather_tree');
  assert.equal(unchanged.missionObjective, 'GATHER_WOOD');
  assert.ok(!offSignals.some((signal) => signal.evt?.startsWith('exploration.')));

  const onSignals = [];
  const on = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (signal) => onSignals.push(signal),
    exploreEnabled: true,
  });
  await on('inst-local', base);
  const local = await on('inst-local', {
    ...base,
    nearbyLogs: [{ x: 12, y: 70, z: -4 }],
    currentCommandCompleted: true,
    currentCommandCompletionReason: exhaustedReason,
  });
  assert.equal(local.action, 'gather_tree');
  assert.equal(local.missionObjective, 'GATHER_WOOD');
  assert.equal(local.targetX, 12);
  assert.equal(local.targetZ, -4);
  assert.ok(!onSignals.some((signal) => signal.evt === 'exploration.leg.queued'));
});
