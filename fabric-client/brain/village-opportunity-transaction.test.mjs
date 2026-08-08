import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeVillageReceiptSnapshot,
  VillageOpportunityTransactionController,
  villageOpportunityInventoryFingerprint,
  villageOpportunitySemanticFingerprint,
} from './village-opportunity-transaction.js';

function liveDiscovery(overrides = {}) {
  return {
    id: 'village:near',
    type: 'village',
    x: 10,
    y: 64,
    z: 0,
    count: 6,
    status: 'observed',
    signals: ['access_proven', 'hazard_free', 'executor_ready'],
    executorReady: true,
    safe: true,
    ...overrides,
  };
}

function liveGolem(overrides = {}) {
  return liveDiscovery({
    id: 'iron_golem:opaque-7f12',
    type: 'iron_golem',
    x: 8,
    count: 1,
    signals: ['access_proven', 'hazard_free', 'defense_ready'],
    readinessSource: 'code_owned_registry_v1',
    capabilityId: 'village_golem_iron',
    executorId: 'village_defeat_iron_golem',
    executorReady: true,
    ...overrides,
  });
}

function snapshot(overrides = {}) {
  return {
    worldIdentity: { id: 'world:test', dimension: 'overworld' },
    dimension: 'overworld',
    x: 0,
    y: 64,
    z: 0,
    onGround: true,
    health: 20,
    foodLevel: 10,
    isDaytime: true,
    nearbyHostileCount: 0,
    inventoryItemCounts: {},
    opportunityDiscoveries: [liveDiscovery()],
    currentCommandCompleted: false,
    currentCommandId: '',
    currentCommandCompletionReason: '',
    ...overrides,
  };
}

function selected(raw = liveDiscovery(), overrides = {}) {
  return {
    id: raw.id,
    type: raw.type,
    observedRevision: 7,
    semanticRevision: villageOpportunitySemanticFingerprint(raw),
    status: raw.status,
    x: raw.x,
    y: raw.y,
    z: raw.z,
    count: raw.count,
    signals: raw.signals,
    executorReady: raw.executorReady,
    readinessSource: raw.readinessSource,
    capabilityId: raw.capabilityId,
    executorId: raw.executorId,
    safe: true,
    ready: true,
    feasible: true,
    aggregateMembers: [],
    ...overrides,
  };
}

function decision(state, chosen = [selected()], overrides = {}) {
  const ids = chosen.map((entry) => entry.id);
  return {
    decisionId: 'decision:1',
    claimId: 'claim:1',
    mode: 'active',
    worldId: 'world:test',
    dimension: 'overworld',
    missionGoal: 'armor',
    defaultObjective: 'GATHER_WOOD',
    memoryRevision: 11,
    ledgerRevision: 'ledger:1',
    inventoryFingerprint: villageOpportunityInventoryFingerprint(state),
    admissionPosition: {
      x: Math.floor(state.x),
      y: Math.floor(state.y),
      z: Math.floor(state.z),
    },
    shouldSwitch: true,
    reason: 'opportunity_selected',
    recommendation: {
      choiceId: `opportunity:${ids.join('+')}`,
      kind: 'opportunity',
      opportunityIds: ids,
      scoreSeconds: 100,
      conservativeBenefitSeconds: 120,
    },
    ledger: {
      owned: {},
      reserved: {},
      deficit: { 'mission:fed': 1, 'mission:iron_units': 27 },
    },
    selectedOpportunities: chosen,
    ...overrides,
  };
}

function baseline() {
  return {
    objective: 'GATHER_WOOD',
    objectiveStartedAtMs: 123,
    objectiveFailures: 1,
    intent: {
      action: 'gather_tree',
      commandId: 'mission-baseline-9',
      missionObjective: 'GATHER_WOOD',
    },
  };
}

function receiptFor(intent, result, overrides = {}) {
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
    worldId: 'world:test',
    dimension: 'overworld',
    mission: intent.opportunityMission,
    routeReplanCount: 0,
    inventoryDelta: {},
    ...overrides,
  };
}

function completed(state, intent, result, overrides = {}) {
  return snapshot({
    ...state,
    currentCommandCompleted: true,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: `${intent.action}_complete:opportunity_${result}`,
    villageOpportunityReceipt: receiptFor(intent, result, overrides.receipt),
    ...overrides,
  });
}

function advanceToAction(controller, initialState, initialIntent, expectedAction) {
  let state = initialState;
  let intent = initialIntent;
  for (let step = 0; step < 12 && intent?.action !== expectedAction; step += 1) {
    if (!['village_travel', 'village_revalidate'].includes(intent?.action)) break;
    const result = intent.action === 'village_travel' ? 'arrived' : 'verified';
    const position = intent.action === 'village_travel'
      ? { x: intent.targetX, y: intent.targetY, z: intent.targetZ }
      : {};
    state = completed({ ...state, ...position }, intent, result);
    intent = controller.tick(state);
  }
  assert.equal(intent?.action, expectedAction);
  return { state, intent };
}

test('active admission is planner-, scope-, inventory-, objective-, safety-, and distance-gated', () => {
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  const state = snapshot();
  assert.equal(controller.maybeStart(null, state, baseline()), null);
  assert.equal(events.at(-1).reason, 'no_completed_decision');

  assert.equal(controller.maybeStart(decision(state, [selected()], { defaultObjective: 'MINE_STONE' }), state, baseline()), null);
  assert.equal(events.at(-1).reason, 'stale_objective');
  assert.equal(controller.maybeStart(decision(state, [selected()], { missionGoal: '' }), state, baseline()), null);
  assert.equal(events.at(-1).reason, 'invalid_mission_scope');
  assert.equal(controller.maybeStart(decision(state, [selected()], { inventoryFingerprint: 'old' }), state, baseline()), null);
  assert.equal(events.at(-1).reason, 'stale_ledger_revision');
  assert.equal(controller.maybeStart(decision(state), { ...state, isDaytime: false, isNight: true }, baseline()), null);
  assert.equal(events.at(-1).reason, 'night_unsafe');
  assert.equal(controller.maybeStart(decision(state), { ...state, nearbyHostileCount: 1 }, baseline()), null);
  assert.equal(events.at(-1).reason, 'threat_present');
  const lowHealth = { ...state, health: 11 };
  assert.equal(controller.maybeStart(decision(lowHealth), lowHealth, baseline()), null);
  assert.equal(events.at(-1).reason, 'low_health');
  assert.equal(controller.maybeStart(decision(state), { ...state, onGround: false }, baseline()), null);
  assert.equal(events.at(-1).reason, 'not_grounded');
  assert.equal(controller.maybeStart(decision(state), { ...state, isTouchingWater: true }, baseline()), null);
  assert.equal(events.at(-1).reason, 'wet');
  assert.equal(controller.maybeStart(decision(state), {
    ...state,
    worldTimeOfDay: 14_000,
    opportunityTravelSafeAtNight: true,
  }, baseline()), null);
  assert.equal(events.at(-1).reason, 'night_unsafe');

  const farRaw = liveDiscovery({ id: 'village:far', x: 385 });
  const farState = snapshot({ opportunityDiscoveries: [farRaw] });
  assert.equal(controller.maybeStart(decision(farState, [selected(farRaw)]), farState, baseline()), null);
  assert.equal(events.at(-1).reason, 'travel_budget_infeasible');
  assert.equal(events.every((event) => event.chargedAsBaselineFailure === false), true);

  const hungryNight = { ...state, foodLevel: 5, isDaytime: false, isNight: true };
  assert.equal(controller.maybeStart(decision(hungryNight), hungryNight, baseline()), null);
  assert.equal(events.at(-1).reason, 'night_unsafe');
  assert.deepEqual({
    health: events.at(-1).health,
    foodLevel: events.at(-1).foodLevel,
    foodDeficit: events.at(-1).foodDeficit,
    missionFoodDeficit: events.at(-1).missionFoodDeficit,
    breadCount: events.at(-1).breadCount,
    foodItemCount: events.at(-1).foodItemCount,
    hasFood: events.at(-1).hasFood,
  }, {
    health: 20,
    foodLevel: 5,
    foodDeficit: 15,
    missionFoodDeficit: 2,
    breadCount: 0,
    foodItemCount: 0,
    hasFood: false,
  });
});

test('active admission accepts subcell jitter but rejects a decision from another stance cell', () => {
  const state = snapshot({ x: 0.1, y: 64.2, z: 0.1 });
  const frozen = decision(state, [selected()]);

  const staleEvents = [];
  const stale = new VillageOpportunityTransactionController({
    emit: (event) => staleEvents.push(event),
  });
  assert.equal(stale.maybeStart(frozen, { ...state, x: 1.01 }, baseline()), null);
  assert.equal(staleEvents.at(-1).reason, 'stale_admission_position');

  const jitter = new VillageOpportunityTransactionController();
  const admitted = jitter.maybeStart(frozen, { ...state, x: 0.99, y: 64.99, z: 0.99 }, baseline());
  assert.equal(admitted.action, 'village_travel');
});

test('a code-owned iron golem starts directly at DEFEAT_GOLEM and receipt-first disappearance completes neutrally', () => {
  const golem = liveGolem();
  const state = snapshot({
    opportunityDiscoveries: [golem],
    inventoryItemCounts: {},
  });
  const events = [];
  const memoryReceipts = [];
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      return receipt.type === 'iron_golem_collection'
        ? { ok: true, value: { revision: 8, details: { type: 'iron_golem' } } }
        : { ok: true };
    },
  });
  const intent = controller.maybeStart(decision(state, [selected(golem)]), state, baseline());
  assert.equal(intent.action, 'village_defeat_iron_golem');
  assert.equal(intent.opportunityStage, 'defeat_golem');
  assert.equal(intent.opportunityId, golem.id);
  assert.equal(Object.hasOwn(intent, 'targetIdentity'), false,
    'the exact entity UUID remains Java-owned; brain receives only the opaque opportunity id');
  assert.equal(events.some((event) => event.stage === 'TRAVEL'), false,
    'the golem executor owns bounded travel to its defense base');

  const terminal = controller.tick(completed({
    ...state,
    opportunityDiscoveries: [],
    inventoryItemCounts: { 'minecraft:iron_ingot': 3 },
  }, intent, 'collected', {
    receipt: {
      inventoryDelta: { 'minecraft:iron_ingot': 3 },
      consumedInventoryDelta: {},
    },
  }));
  assert.equal(terminal.action, 'stop');
  assert.equal(controller.isActive(), false);
  const collection = memoryReceipts.find((receipt) => receipt.type === 'iron_golem_collection');
  assert.deepEqual(collection.inventoryDelta, { 'minecraft:iron_ingot': 3 });
  assert.equal(collection.expectedOpportunityRevision, 7);
  assert.equal(collection.opportunityId, golem.id);
  const completedEvent = events.find((event) => event.evt === 'opportunity.detour.completed');
  assert.equal(completedEvent.originalCommandId, 'mission-baseline-9');
  assert.equal(completedEvent.clocksReset, false);
  assert.equal(completedEvent.retriesConsumed, 0);
  assert.equal(completedEvent.chargedAsBaselineFailure, false);
});

test('active golem low-health, wet, and threat state preserves Java escape until its exact neutral receipt', () => {
  const golem = liveGolem({ id: 'iron_golem:safety-lease' });
  const state = snapshot({ opportunityDiscoveries: [golem], inventoryItemCounts: {} });
  const events = [];
  const applied = [];
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      applied.push(receipt);
      return { ok: true };
    },
  });
  const intent = controller.maybeStart(decision(state, [selected(golem)], {
    decisionId: 'decision:golem-safety-lease',
    claimId: 'claim:golem-safety-lease',
  }), state, baseline());

  const stillEscaping = controller.tick({
    ...state,
    health: 5,
    isTouchingWater: true,
    nearbyHostileCount: 1,
    opportunityTravelSafe: false,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
  });
  assert.equal(stillEscaping.commandId, intent.commandId);
  assert.equal(stillEscaping.action, 'village_defeat_iron_golem');
  assert.equal(controller.isActive(), true);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.failed'), false);

  const terminal = controller.tick(completed({
    ...state,
    health: 5,
    isTouchingWater: true,
    nearbyHostileCount: 1,
    opportunityTravelSafe: false,
    opportunityDiscoveries: [],
  }, intent, 'unsafe', {
    receipt: {
      result: 'unsafe',
      inventoryDelta: {},
      consumedInventoryDelta: {},
    },
  }));
  assert.equal(terminal.action, 'stop');
  assert.equal(terminal.opportunityStage, 'fallback');
  assert.equal(controller.isActive(), false);
  assert.equal(applied.some((receipt) => receipt.type === 'iron_golem_collection'), false);
  const failed = events.find((event) => event.evt === 'opportunity.detour.failed');
  assert.equal(failed.reason, 'unsafe');
  assert.equal(failed.chargedAsBaselineFailure, false);
  assert.equal(failed.clocksReset, false);
  assert.equal(failed.retriesConsumed, 0);
});

test('golem safety lease never masks world, dimension, or death invariants', () => {
  const cases = [
    ['world_changed', { worldIdentity: { id: 'world:other', dimension: 'overworld' } }],
    ['dimension_changed', { worldIdentity: { id: 'world:test', dimension: 'the_nether' } }],
    ['player_dead', { dead: true, health: 0 }],
  ];
  for (const [reason, mutation] of cases) {
    const golem = liveGolem({ id: `iron_golem:${reason}` });
    const state = snapshot({ opportunityDiscoveries: [golem] });
    const events = [];
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    const intent = controller.maybeStart(decision(state, [selected(golem)], {
      decisionId: `decision:${reason}`,
      claimId: `claim:${reason}`,
    }), state, baseline());
    assert.equal(intent.action, 'village_defeat_iron_golem');
    const terminal = controller.tick({ ...state, ...mutation });
    assert.equal(terminal.action, 'stop', reason);
    assert.equal(terminal.opportunityStage, 'fallback', reason);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed')?.reason, reason);
  }
});

test('iron golem receipts accept exactly 3-5 iron ingots and reject every uncorrelated or embellished delta', () => {
  for (const ironIngots of [3, 4, 5]) {
    const golem = liveGolem({ id: `iron_golem:valid-${ironIngots}` });
    const state = snapshot({ opportunityDiscoveries: [golem], inventoryItemCounts: {} });
    const applied = [];
    const controller = new VillageOpportunityTransactionController({
      applyReceipt(receipt) {
        applied.push(receipt);
        return { ok: true, value: { revision: 8, details: { type: 'iron_golem' } } };
      },
    });
    const intent = controller.maybeStart(decision(state, [selected(golem)], {
      decisionId: `decision:valid-${ironIngots}`,
      claimId: `claim:valid-${ironIngots}`,
    }), state, baseline());
    controller.tick(completed({
      ...state,
      opportunityDiscoveries: [],
      inventoryItemCounts: { 'minecraft:iron_ingot': ironIngots },
    }, intent, 'collected', {
      receipt: {
        inventoryDelta: { 'minecraft:iron_ingot': ironIngots },
        consumedInventoryDelta: {},
      },
    }));
    assert.equal(applied.filter((receipt) => receipt.type === 'iron_golem_collection').length, 1,
      `${ironIngots} ingots`);
  }

  const invalidCases = [
    ['two_ingots', 2, { inventoryDelta: { 'minecraft:iron_ingot': 2 } }],
    ['six_ingots', 6, { inventoryDelta: { 'minecraft:iron_ingot': 6 } }],
    ['extra_item', 3, {
      inventoryDelta: { 'minecraft:iron_ingot': 3, 'minecraft:poppy': 1 },
    }],
    ['consumed_item', 3, {
      inventoryDelta: { 'minecraft:iron_ingot': 3 },
      consumedInventoryDelta: { 'minecraft:cobblestone': 1 },
    }],
    ['stale_revision', 3, {
      inventoryDelta: { 'minecraft:iron_ingot': 3 },
      opportunityRevision: 8,
    }],
  ];
  for (const [name, observedIngots, receiptOverrides] of invalidCases) {
    const golem = liveGolem({ id: `iron_golem:invalid-${name}` });
    const state = snapshot({ opportunityDiscoveries: [golem], inventoryItemCounts: {} });
    const events = [];
    const applied = [];
    const controller = new VillageOpportunityTransactionController({
      emit: (event) => events.push(event),
      applyReceipt(receipt) {
        applied.push(receipt);
        return { ok: true };
      },
    });
    const intent = controller.maybeStart(decision(state, [selected(golem)], {
      decisionId: `decision:invalid-${name}`,
      claimId: `claim:invalid-${name}`,
    }), state, baseline());
    const terminal = controller.tick(completed({
      ...state,
      opportunityDiscoveries: [],
      inventoryItemCounts: { 'minecraft:iron_ingot': observedIngots },
    }, intent, 'collected', {
      receipt: {
        inventoryDelta: { 'minecraft:iron_ingot': observedIngots },
        consumedInventoryDelta: {},
        ...receiptOverrides,
      },
    }));
    assert.equal(terminal.action, 'stop', name);
    assert.equal(applied.some((receipt) => receipt.type === 'iron_golem_collection'), false, name);
    assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'), true, name);
    const failed = events.find((event) => event.evt === 'opportunity.detour.failed');
    assert.equal(failed.chargedAsBaselineFailure, false, name);
    assert.equal(failed.retriesConsumed, 0, name);
  }
});

test('iron golem admission is exact, live, defense-ready, and standalone', () => {
  const ready = liveGolem();
  const cases = [
    ['mixed', [selected(ready), selected(liveDiscovery({ id: 'village:mixed' }))],
      snapshot({ opportunityDiscoveries: [ready, liveDiscovery({ id: 'village:mixed' })] }),
      'iron_golem_must_be_standalone'],
    ['missing', [selected(ready)], snapshot({ opportunityDiscoveries: [] }), 'opportunity_vanished'],
    ['no_defense', [selected(liveGolem({ signals: ['access_proven', 'hazard_free'] }))],
      snapshot({ opportunityDiscoveries: [liveGolem({ signals: ['access_proven', 'hazard_free'] })] }),
      'defense_unready'],
    ['wrong_executor', [selected(liveGolem({ executorId: 'village_revalidate' }))],
      snapshot({ opportunityDiscoveries: [liveGolem({ executorId: 'village_revalidate' })] }),
      'executor_unready'],
  ];
  for (const [name, chosen, state, reason] of cases) {
    const events = [];
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    assert.equal(controller.maybeStart(decision(state, chosen, {
      decisionId: `decision:${name}`,
      claimId: `claim:${name}`,
      recommendation: {
        choiceId: `opportunity:${chosen.map((entry) => entry.id).join('+')}`,
        kind: 'opportunity',
        opportunityIds: chosen.map((entry) => entry.id),
        scoreSeconds: 100,
        conservativeBenefitSeconds: 120,
      },
    }), state, baseline()), null, name);
    assert.equal(events.at(-1).reason, reason, name);
  }
});

test('one hay transaction travels, revalidates, harvests, crafts, and resumes neutrally', () => {
  let now = 1_000;
  const events = [];
  const rawVillage = liveDiscovery();
  const rawHay = liveDiscovery({ id: 'hay:1', type: 'hay', x: 12, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
  });
  let state = snapshot({
    opportunityDiscoveries: [rawVillage, rawHay], foodLevel: 6,
    craftingTableInReach: true, inventoryCraftingTableCount: 1,
  });
  const controller = new VillageOpportunityTransactionController({
    now: () => now,
    emit: (event) => events.push(event),
  });
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityRevision, 7);

  now += 1_000;
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_revalidate');

  now += 1_000;
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.targetX, 12);

  now += 1_000;
  state = completed({ ...state, x: 12 }, intent, 'arrived');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_revalidate');

  now += 1_000;
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_harvest_hay');
  assert.equal(intent.targetItemCount, 2);

  now += 1_000;
  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:hay_block': 2 },
    opportunityDiscoveries: [rawVillage],
  }, intent, 'harvested', {
    receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_craft_bread');
  assert.equal(intent.targetItemCount, 4,
    'hunger six requests one exact three-meal-plus-buffer batch');

  now += 1_000;
  state = completed({
    ...state,
    foodLevel: 20,
    inventoryItemCounts: { 'minecraft:bread': 1 },
  }, intent, 'crafted', {
    receipt: {
      inventoryDelta: { 'minecraft:bread': 4 },
      consumedInventoryDelta: { 'minecraft:bread': 3 },
    },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'stop');
  assert.equal(intent.opportunityStage, 'complete');
  assert.equal(controller.isActive(), false);
  assert.equal(events.filter((event) => event.evt === 'opportunity.detour.started').length, 1);
  const terminal = events.find((event) => event.evt === 'opportunity.detour.completed');
  const started = events.find((event) => event.evt === 'opportunity.detour.started');
  assert.equal(started.foodLevel, 6);
  assert.equal(started.health, 20);
  assert.equal(started.foodDeficit, 14);
  assert.equal(started.missionFoodDeficit, 1);
  assert.equal(started.breadCount, 0);
  assert.equal(started.hasFood, false);
  assert.equal(terminal.originalCommandId, 'mission-baseline-9');
  assert.equal(terminal.objectiveStartedAtMs, 123);
  assert.equal(terminal.objectiveFailuresBefore, 1);
  assert.equal(terminal.clocksReset, false);
  assert.equal(terminal.retriesConsumed, 0);
  assert.equal(terminal.chargedAsBaselineFailure, false);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.fallback'), false);
  assert.equal(state.inventoryItemCounts['minecraft:bread'], 1,
    'food consumed during the typed batch still leaves the requested buffer');

  assert.equal(controller.maybeStart(decision(state, [chosen]), state, baseline()), null);
  assert.equal(events.at(-1).reason, 'decision_already_consumed');
});

test('food production accepts only exact correlated target-item consumption evidence', () => {
  const cases = [
    {
      name: 'missing',
      consumedInventoryDelta: undefined,
      reason: 'inventory_delta_unverified',
    },
    {
      name: 'unrelated-item',
      consumedInventoryDelta: { 'minecraft:apple': 3 },
      reason: 'receipt_consumed_item_mismatch',
    },
    {
      name: 'overstated',
      consumedInventoryDelta: { 'minecraft:bread': 4 },
      reason: 'receipt_consumed_count_overstated',
    },
    {
      name: 'malformed',
      consumedInventoryDelta: { 'minecraft:bread': 1.5 },
      reason: 'receipt_consumed_inventory_delta_invalid',
    },
  ];

  for (const entry of cases) {
    const rawVillage = liveDiscovery({ id: `village:food-consumption:${entry.name}` });
    const rawHay = liveDiscovery({
      id: `hay:food-consumption:${entry.name}`,
      type: 'hay',
      x: 12,
      count: 2,
    });
    const chosen = selected(rawVillage, {
      aggregateMembers: [selected(rawHay, {
        observedRevision: 4,
        aggregateMembers: undefined,
      })],
    });
    let state = snapshot({
      opportunityDiscoveries: [rawVillage, rawHay],
      foodLevel: 6,
      craftingTableInReach: true,
      inventoryCraftingTableCount: 1,
    });
    const events = [];
    const controller = new VillageOpportunityTransactionController({
      emit: (event) => events.push(event),
    });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:food-consumption:${entry.name}`,
      claimId: `claim:food-consumption:${entry.name}`,
    }), state, baseline());
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
    state = completed({
      ...state,
      inventoryItemCounts: { 'minecraft:hay_block': 2 },
      opportunityDiscoveries: [rawVillage],
    }, intent, 'harvested', {
      receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
    });
    intent = controller.tick(state);
    assert.equal(intent.action, 'village_craft_bread', entry.name);

    state = completed({
      ...state,
      foodLevel: 20,
      inventoryItemCounts: { 'minecraft:bread': 1 },
    }, intent, 'crafted', {
      receipt: {
        inventoryDelta: { 'minecraft:bread': 4 },
        ...(entry.consumedInventoryDelta === undefined
          ? {}
          : { consumedInventoryDelta: entry.consumedInventoryDelta }),
      },
    });
    const terminal = controller.tick(state);
    assert.equal(terminal.action, 'stop', entry.name);
    assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'
      && event.reason === entry.reason), true, entry.name);
  }
});

test('exact travel and revalidation receipts outrank a same-poll catalog omission', () => {
  const events = [];
  const state = snapshot();
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
  });
  let intent = controller.maybeStart(decision(state), state, baseline());

  intent = controller.tick(completed({
    ...state,
    x: intent.targetX,
    y: intent.targetY,
    z: intent.targetZ,
    opportunityDiscoveries: [],
  }, intent, 'arrived'));
  assert.equal(intent.action, 'village_revalidate');
  assert.equal(intent.opportunityStage, 'revalidate');
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.failed'), false);

  intent = controller.tick(completed({
    ...state,
    x: intent.targetX,
    y: intent.targetY,
    z: intent.targetZ,
    opportunityDiscoveries: [],
  }, intent, 'verified'));
  assert.equal(intent.action, 'stop');
  assert.equal(intent.opportunityStage, 'complete');
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.failed'), false);
});

test('catalog omission without an exact boundary receipt remains fail-closed', () => {
  const cases = [
    {
      name: 'nonterminal',
      mutate: (state) => ({ ...state, opportunityDiscoveries: [] }),
    },
    {
      name: 'stale receipt',
      mutate: (state, intent) => completed({
        ...state,
        x: intent.targetX,
        y: intent.targetY,
        z: intent.targetZ,
        opportunityDiscoveries: [],
      }, intent, 'arrived', { receipt: { opportunityRevision: 99 } }),
    },
    {
      name: 'malformed completion',
      mutate: (state, intent) => ({
        ...completed({
          ...state,
          x: intent.targetX,
          y: intent.targetY,
          z: intent.targetZ,
          opportunityDiscoveries: [],
        }, intent, 'arrived'),
        currentCommandCompletionReason: 'village_travel_complete:not_authoritative',
      }),
    },
  ];
  for (const entry of cases) {
    const events = [];
    const state = snapshot();
    const controller = new VillageOpportunityTransactionController({
      emit: (event) => events.push(event),
    });
    const intent = controller.maybeStart(decision(state), state, baseline());
    const stop = controller.tick(entry.mutate(state, intent));
    assert.equal(stop.action, 'stop', entry.name);
    assert.equal(stop.opportunityStage, 'fallback', entry.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      'opportunity_vanished', entry.name);
    assert.equal(events.some((event) => event.evt === 'opportunity.detour.stage_changed'),
      false, entry.name);
  }
});

test('scope, safety, travel budget, and deadline outrank an exact travel receipt', () => {
  let now = 0;
  const cases = [
    {
      name: 'world',
      reason: 'world_changed',
      mutate: (state) => ({ ...state, worldIdentity: { id: 'world:other', dimension: 'overworld' } }),
    },
    {
      name: 'dimension',
      reason: 'dimension_changed',
      mutate: (state) => ({ ...state, worldIdentity: { id: 'world:test', dimension: 'the_nether' } }),
    },
    { name: 'health', reason: 'health_loss', mutate: (state) => ({ ...state, health: 19 }) },
    { name: 'threat', reason: 'threat_present', mutate: (state) => ({ ...state, nearbyHostileCount: 1 }) },
    { name: 'travel', reason: 'travel_budget_exhausted', mutate: (state) => ({ ...state, x: 400 }) },
    {
      name: 'deadline',
      reason: 'detour_deadline',
      mutate: (state) => {
        now = 420_000;
        return state;
      },
    },
  ];
  for (const entry of cases) {
    now = 0;
    const events = [];
    const state = snapshot();
    const controller = new VillageOpportunityTransactionController({
      now: () => now,
      emit: (event) => events.push(event),
    });
    const intent = controller.maybeStart(decision(state), state, baseline());
    const terminal = completed({
      ...state,
      x: intent.targetX,
      y: intent.targetY,
      z: intent.targetZ,
      opportunityDiscoveries: [],
    }, intent, 'arrived');
    const stop = controller.tick(entry.mutate(terminal));
    assert.equal(stop.action, 'stop', entry.name);
    assert.equal(stop.opportunityStage, 'fallback', entry.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      entry.reason, entry.name);
    assert.equal(events.some((event) => event.evt === 'opportunity.detour.stage_changed'),
      false, entry.name);
  }
});

test('an active multi-hay mutation tolerates scanner updates until its verified inventory receipt', () => {
  const rawVillage = liveDiscovery();
  const rawHay = liveDiscovery({ id: 'hay:multi', type: 'hay', x: 12, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
  });
  let state = snapshot({
    foodLevel: 5,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [rawVillage, rawHay],
  });
  const controller = new VillageOpportunityTransactionController();
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
  assert.equal(intent.targetItemCount, 2);

  // Java has broken and picked up the first block, so the throttled scanner
  // observes a changed aggregate member before the two-block command has a
  // terminal receipt. The exact active member alone remains executor-owned.
  state = snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    inventoryItemCounts: { 'minecraft:hay_block': 1 },
    opportunityDiscoveries: [rawVillage, { ...rawHay, count: 1, revision: 5 }],
  });
  const stillHarvesting = controller.tick(state);
  assert.equal(stillHarvesting.commandId, intent.commandId);
  assert.equal(stillHarvesting.action, 'village_harvest_hay');

  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:hay_block': 2 },
    opportunityDiscoveries: [rawVillage],
  }, intent, 'harvested', {
    receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_craft_bread');
  // The receipt poll still contained the revalidated root. Its exact verified
  // hay mutation nevertheless arms a later bounded-wire omission proof, so a
  // truncated next poll may omit both root and consumed member during craft.
  const sameCraft = controller.tick(snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [],
    opportunityDiscoveriesTruncated: true,
  }));
  assert.equal(sameCraft.commandId, intent.commandId);
});

test('an exact hay receipt outranks only its previously revalidated owning-root truncated-wire omission', () => {
  const rawVillage = liveDiscovery({ id: 'village:hay-owner' });
  const rawHay = liveDiscovery({ id: 'hay:root-omission', type: 'hay', x: 12, count: 2 });
  const rawBed = liveDiscovery({ id: 'bed:root-sibling', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [rawHay, rawBed].map((raw) => selected(raw, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })),
  });
  let state = snapshot({
    foodLevel: 5,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [rawVillage, rawHay, rawBed],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, [chosen], {
    decisionId: 'decision:hay-root-omission',
    claimId: 'claim:hay-root-omission',
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));

  // The exact Java receipt and inventory delta remain authoritative when the
  // declared-truncated catalog omits both the consumed member and its
  // already-revalidated aggregate root in the same poll. The unchanged
  // sibling remains required.
  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:hay_block': 2 },
    opportunityDiscoveries: [rawBed],
    opportunityDiscoveriesTruncated: true,
  }, intent, 'harvested', {
    receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_craft_bread');
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.failed'), false);

  // The absence proof is bounded to wire omission: it keeps the exact craft
  // command alive, but does not declare the physical root self-modified.
  const held = controller.tick(snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [rawBed],
    opportunityDiscoveriesTruncated: true,
  }));
  assert.equal(held.commandId, intent.commandId);
  assert.equal(held.action, 'village_craft_bread');
});

test('hay receipt-first ordering rejects absent, stale, malformed, root-changed, and sibling-changed evidence', () => {
  const rawVillage = liveDiscovery({ id: 'village:hay-guard' });
  const rawHay = liveDiscovery({ id: 'hay:receipt-guard', type: 'hay', x: 12, count: 2 });
  const rawBed = liveDiscovery({ id: 'bed:receipt-guard', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [rawHay, rawBed].map((raw) => selected(raw, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })),
  });

  const cases = [
    {
      name: 'absent-receipt',
      finish(state, intent) {
        return snapshot({
          ...state,
          currentCommandCompleted: false,
          currentCommandId: intent.commandId,
          currentCommandCompletionReason: '',
          villageOpportunityReceipt: null,
          inventoryItemCounts: { 'minecraft:hay_block': 2 },
          opportunityDiscoveries: [rawBed],
        });
      },
      reason: 'opportunity_vanished',
    },
    {
      name: 'stale-command',
      finish(state, intent) {
        return completed({
          ...state,
          inventoryItemCounts: { 'minecraft:hay_block': 2 },
          opportunityDiscoveries: [rawBed],
        }, intent, 'harvested', {
          currentCommandId: 'mission-village-stale-harvest',
          receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
        });
      },
      reason: 'opportunity_vanished',
    },
    {
      name: 'malformed-delta',
      finish(state, intent) {
        return completed({
          ...state,
          inventoryItemCounts: { 'minecraft:hay_block': 2 },
          opportunityDiscoveries: [rawBed],
        }, intent, 'harvested', {
          receipt: { inventoryDelta: { 'minecraft:hay_block': 1 } },
        });
      },
      reason: 'opportunity_vanished',
    },
    {
      name: 'owning-root-changed',
      finish(state, intent) {
        return completed({
          ...state,
          inventoryItemCounts: { 'minecraft:hay_block': 2 },
          opportunityDiscoveries: [{ ...rawVillage, x: rawVillage.x + 1 }, rawBed],
        }, intent, 'harvested', {
          receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
        });
      },
      reason: 'opportunity_changed',
    },
    {
      name: 'sibling-changed',
      finish(state, intent) {
        return completed({
          ...state,
          inventoryItemCounts: { 'minecraft:hay_block': 2 },
          opportunityDiscoveries: [rawVillage, { ...rawBed, x: rawBed.x + 1 }],
        }, intent, 'harvested', {
          receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
        });
      },
      reason: 'aggregate_member_changed',
    },
  ];

  for (const entry of cases) {
    let state = snapshot({
      foodLevel: 5,
      craftingTableInReach: true,
      inventoryCraftingTableCount: 1,
      opportunityDiscoveries: [rawVillage, rawHay, rawBed],
    });
    const events = [];
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:hay-guard:${entry.name}`,
      claimId: `claim:hay-guard:${entry.name}`,
    }), state, baseline());
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
    const stop = controller.tick(entry.finish(state, intent));
    assert.equal(stop.action, 'stop', entry.name);
    assert.equal(stop.opportunityStage, 'fallback', entry.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      entry.reason, entry.name);
    assert.equal(events.some((event) => (
      event.evt === 'opportunity.detour.stage_changed' && event.stage === 'CRAFT_BREAD'
    )), false, entry.name);
  }
});

test('an exact neutral hay receipt spends one local failure before catalog liveness without mutation authority', () => {
  const rawVillage = liveDiscovery({ id: 'village:hay-neutral' });
  const rawHay = liveDiscovery({ id: 'hay:neutral', type: 'hay', x: 12, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
  });
  let state = snapshot({
    foodLevel: 5,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [rawVillage, rawHay],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, [chosen], {
    decisionId: 'decision:hay-neutral',
    claimId: 'claim:hay-neutral',
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));

  const stop = controller.tick(completed({
    ...state,
    // The mutation has already removed the bounded catalog entries, but its
    // exact neutral result is executor-owned terminal feedback.
    opportunityDiscoveries: [],
    opportunityDiscoveriesTruncated: false,
  }, intent, 'unavailable'));
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'complete');
  assert.match(stop.reason, /:village_transaction_partial$/);
  const skipped = events.find((event) => event.evt === 'opportunity.detour.stage_failed');
  assert.equal(skipped.reason, 'unavailable');
  assert.equal(skipped.failureCount, 1);
  const terminal = events.find((event) => event.evt === 'opportunity.detour.completed');
  assert.equal(terminal.failureCount, 1);
  assert.equal(terminal.objectiveFailuresBefore, 1);
  assert.equal(terminal.chargedAsBaselineFailure, false);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.fallback'), false);
  assert.equal(events.some((event) => (
    event.evt === 'opportunity.detour.stage_changed' && event.stage === 'CRAFT_BREAD'
  )), false, 'neutral feedback never enters successful mutation bookkeeping');
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'),
    false);
});

test('stale or malformed neutral hay receipts cannot outrank catalog liveness', () => {
  const rawVillage = liveDiscovery({ id: 'village:hay-neutral-guard' });
  const rawHay = liveDiscovery({ id: 'hay:neutral-guard', type: 'hay', x: 12, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
  });
  for (const entry of [
    {
      name: 'stale-stage',
      receipt: (intent) => ({ detourStageSeq: intent.detourStageSeq + 1 }),
    },
    {
      name: 'malformed-id',
      receipt: () => ({ receiptId: '' }),
    },
  ]) {
    let state = snapshot({
      foodLevel: 5,
      craftingTableInReach: true,
      inventoryCraftingTableCount: 1,
      opportunityDiscoveries: [rawVillage, rawHay],
    });
    const events = [];
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:hay-neutral-guard:${entry.name}`,
      claimId: `claim:hay-neutral-guard:${entry.name}`,
    }), state, baseline());
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
    const stop = controller.tick(completed({
      ...state,
      opportunityDiscoveries: [],
      opportunityDiscoveriesTruncated: false,
    }, intent, 'unavailable', { receipt: entry.receipt(intent) }));
    assert.equal(stop.action, 'stop', entry.name);
    assert.equal(stop.opportunityStage, 'fallback', entry.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      'opportunity_vanished', entry.name);
    assert.equal(events.some((event) => (
      event.evt === 'opportunity.detour.stage_changed' && event.stage === 'CRAFT_BREAD'
    )), false, entry.name);
  }
});

test('an exact Java revalidation rejection remains terminal with a truncated wire catalog', () => {
  const state = snapshot();
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state), state, baseline());
  intent = controller.tick(completed({
    ...state,
    x: intent.targetX,
    y: intent.targetY,
    z: intent.targetZ,
    opportunityDiscoveries: [],
    opportunityDiscoveriesTruncated: true,
  }, intent, 'arrived'));
  assert.equal(intent.action, 'village_revalidate');

  const stop = controller.tick(completed({
    ...state,
    opportunityDiscoveries: [],
    opportunityDiscoveriesTruncated: true,
  }, intent, 'unavailable'));
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
    'unavailable');
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').failureCount, 1);
  assert.equal(events.every((event) => event.chargedAsBaselineFailure === false), true);
  assert.equal(events.some((event) => (
    event.evt === 'opportunity.detour.stage_changed' && event.stage === 'HARVEST_HAY'
  )), false);
});

test('the first local neutral failure skips its source and the second exhausts only the detour budget', () => {
  const rawVillage = liveDiscovery({ id: 'village:failure-budget' });
  const rawChest = liveDiscovery({ id: 'container:first-failure', type: 'container', x: 11 });
  const rawBed = liveDiscovery({ id: 'bed:second-failure', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [rawChest, rawBed].map((raw) => selected(raw, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })),
  });
  let state = snapshot({
    foodLevel: 20,
    opportunityDiscoveries: [rawVillage, rawChest, rawBed],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    decisionId: 'decision:failure-budget',
    claimId: 'claim:failure-budget',
    ledger: { owned: {}, reserved: {}, deficit: {} },
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_inspect_container'));

  state = completed(state, intent, 'unavailable');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawBed.id, 'the unavailable container source is skipped');
  assert.equal(controller.activeSnapshot().failureCount, 1);
  const firstFailure = events.find((event) => event.evt === 'opportunity.detour.stage_failed');
  assert.equal(firstFailure.reason, 'unavailable');
  assert.equal(firstFailure.chargedAsBaselineFailure, false);

  ({ state, intent } = advanceToAction(controller, state, intent, 'village_collect_bed'));
  state = completed(state, intent, 'unsafe');
  const stop = controller.tick(state);
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  const terminal = events.find((event) => event.evt === 'opportunity.detour.failed');
  assert.equal(terminal.reason, 'unsafe');
  assert.equal(terminal.failureCount, 2);
  assert.equal(terminal.objectiveFailuresBefore, 1);
  assert.equal(terminal.chargedAsBaselineFailure, false);
  assert.equal(events.every((event) => event.chargedAsBaselineFailure === false), true);
});

test('a neutral withdrawal skips every remaining item from that container source', () => {
  const items = {
    'minecraft:iron_pickaxe': 1,
    'minecraft:iron_ingot': 3,
  };
  const rawVillage = liveDiscovery({ id: 'village:withdraw-source-skip' });
  const rawChest = liveDiscovery({
    id: 'container:withdraw-source-skip',
    type: 'container',
    x: 11,
    contentsKnown: false,
    items: {},
  });
  const rawBed = liveDiscovery({ id: 'bed:after-withdraw-source', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [
      selected(rawChest, { observedRevision: 4, aggregateMembers: undefined }),
      selected(rawBed, { observedRevision: 4, aggregateMembers: undefined }),
    ],
  });
  let state = snapshot({
    foodLevel: 20,
    opportunityDiscoveries: [rawVillage, rawChest, rawBed],
  });
  const events = [];
  const memoryReceipts = [];
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      if (receipt.type === 'container_inspection') {
        return { ok: true, value: { revision: 13, details: { contentsKnown: true, items } } };
      }
      if (receipt.type === 'container_refresh_required') {
        return { ok: true, value: { revision: 14, details: { contentsKnown: false, items: {} } } };
      }
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    decisionId: 'decision:withdraw-source-skip',
    claimId: 'claim:withdraw-source-skip',
    ledger: {
      owned: {},
      reserved: {},
      deficit: { 'minecraft:iron_pickaxe': 1, 'mission:iron_units': 3 },
    },
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_inspect_container'));
  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: items },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_withdraw_item');
  assert.equal(intent.targetItemId, 'minecraft:iron_pickaxe');

  state = completed(state, intent, 'invalidated');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawBed.id);
  assert.equal(controller.activeSnapshot().failureCount, 1);
  assert.equal(memoryReceipts.filter((entry) => entry.type === 'container_refresh_required').length, 1);
  assert.equal(events.filter((event) => event.evt === 'opportunity.detour.stage_changed'
    && event.stage === 'WITHDRAW_ITEM').length, 1,
  'the queued iron-ingot withdrawal from the same container is removed');
});

test('a neutral bread craft skips its hay source and continues to the next value source', () => {
  const rawHay = liveDiscovery({ id: 'hay:craft-source-skip', type: 'hay', x: 10, count: 2 });
  const rawBed = liveDiscovery({ id: 'bed:after-craft-source', type: 'bed', x: 20, count: 1 });
  const chosen = [
    selected(rawHay, { observedRevision: 4 }),
    selected(rawBed, { observedRevision: 5 }),
  ];
  let state = snapshot({
    foodLevel: 5,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [rawHay, rawBed],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, chosen, {
    decisionId: 'decision:craft-source-skip',
    claimId: 'claim:craft-source-skip',
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:hay_block': 2 },
  }, intent, 'harvested', {
    receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_craft_bread');

  state = completed(state, intent, 'invalidated');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawBed.id);
  assert.equal(controller.activeSnapshot().failureCount, 1);
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.stage_failed').reason,
    'invalidated');
  assert.equal(events.every((event) => event.chargedAsBaselineFailure === false), true);
});

test('a wire-omissible hay root still fails closed on complete omission, tombstone, or semantic mutation during bread crafting', () => {
  const rawVillage = liveDiscovery({ id: 'village:hay-post-receipt' });
  const rawHay = liveDiscovery({ id: 'hay:post-receipt', type: 'hay', x: 12, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
  });

  for (const entry of [
    {
      name: 'complete-catalog-omission',
      root: null,
      truncated: false,
      reason: 'opportunity_vanished',
    },
    {
      name: 'tombstone',
      root: { ...rawVillage, status: 'disappeared', signals: ['disappeared'] },
      truncated: true,
      reason: 'opportunity_invalidated',
    },
    {
      name: 'semantic-change',
      root: { ...rawVillage, signals: [...rawVillage.signals, 'bell'] },
      truncated: true,
      reason: 'opportunity_changed',
    },
  ]) {
    let state = snapshot({
      foodLevel: 5,
      craftingTableInReach: true,
      inventoryCraftingTableCount: 1,
      opportunityDiscoveries: [rawVillage, rawHay],
    });
    const events = [];
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:hay-post:${entry.name}`,
      claimId: `claim:hay-post:${entry.name}`,
    }), state, baseline());
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
    state = completed({
      ...state,
      inventoryItemCounts: { 'minecraft:hay_block': 2 },
      // The root is still present on the exact receipt poll; the verified hay
      // mutation arms permission for only a later *truncated* omission.
      opportunityDiscoveries: [rawVillage],
      opportunityDiscoveriesTruncated: false,
    }, intent, 'harvested', {
      receipt: { inventoryDelta: { 'minecraft:hay_block': 2 } },
    });
    intent = controller.tick(state);
    assert.equal(intent.action, 'village_craft_bread', entry.name);

    const stop = controller.tick(snapshot({
      ...state,
      currentCommandCompleted: false,
      currentCommandId: intent.commandId,
      currentCommandCompletionReason: '',
      villageOpportunityReceipt: null,
      opportunityDiscoveries: entry.root ? [entry.root] : [],
      opportunityDiscoveriesTruncated: entry.truncated,
    }));
    assert.equal(stop.action, 'stop', entry.name);
    assert.equal(stop.opportunityStage, 'fallback', entry.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      entry.reason, entry.name);
  }
});

test('an active bed mutation tolerates scanner disappearance until its verified pickup receipt', () => {
  const rawVillage = liveDiscovery({
    count: 6,
    signals: ['access_proven', 'bed', 'executor_ready', 'hazard_free', 'marker_count:6'],
  });
  const villageAfterBedBreak = {
    ...rawVillage,
    count: 5,
    revision: 8,
    signals: ['access_proven', 'executor_ready', 'hazard_free', 'marker_count:5'],
  };
  const rawBed = liveDiscovery({ id: 'bed:scanner-race', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawBed, { observedRevision: 4, aggregateMembers: undefined })],
  });
  let state = snapshot({
    foodLevel: 20,
    opportunityDiscoveries: [rawVillage, rawBed],
  });
  const controller = new VillageOpportunityTransactionController();
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_collect_bed'));

  state = snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    // A bed is also a village marker. One scan can therefore remove the bed
    // member and update the owning cluster's count/labels before pickup is
    // visible in inventory.
    opportunityDiscoveries: [villageAfterBedBreak],
  });
  const stillCollecting = controller.tick(state);
  assert.equal(stillCollecting.commandId, intent.commandId);
  assert.equal(stillCollecting.action, 'village_collect_bed');

  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:white_bed': 1 },
    opportunityDiscoveries: [villageAfterBedBreak],
  }, intent, 'collected', {
    receipt: { inventoryDelta: { 'minecraft:white_bed': 1 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'stop');
  assert.equal(intent.opportunityStage, 'complete');
});

test('an active bed mutation follows one provable minimum-marker village re-key', () => {
  const oldRoot = liveDiscovery({
    id: 'village:old-minimum',
    x: 10,
    count: 6,
    signals: ['access_proven', 'bed', 'executor_ready', 'hazard_free', 'marker_count:6'],
  });
  const rawBed = liveDiscovery({
    id: 'bed:minimum-marker', type: 'bed', x: 10, count: 1,
  });
  const laterRoot = liveDiscovery({ id: 'village:after-rekey', x: 30 });
  const laterContainer = liveDiscovery({
    id: 'container:after-rekey', type: 'container', x: 31, count: 1,
  });
  const chosen = [
    selected(oldRoot, {
      aggregateMembers: [selected(rawBed, { observedRevision: 4, aggregateMembers: undefined })],
    }),
    selected(laterRoot, {
      aggregateMembers: [selected(laterContainer, {
        observedRevision: 5, aggregateMembers: undefined,
      })],
    }),
  ];
  let state = snapshot({
    foodLevel: 20,
    inventoryItemCounts: { 'minecraft:bread': 1 },
    opportunityDiscoveries: [oldRoot, rawBed, laterRoot, laterContainer],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, chosen, {
    decisionId: 'decision:bed-root-rekey',
    claimId: 'claim:bed-root-rekey',
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_collect_bed'));

  const rekeyedRoot = {
    ...oldRoot,
    id: 'village:new-minimum',
    x: 11,
    revision: 8,
    count: 5,
    signals: ['access_proven', 'executor_ready', 'hazard_free', 'marker_count:5'],
  };
  const oldRootTombstone = {
    ...oldRoot,
    status: 'disappeared',
    signals: ['disappeared'],
  };
  state = snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [oldRootTombstone, rekeyedRoot, laterRoot, laterContainer],
  });
  const stillCollecting = controller.tick(state);
  assert.equal(stillCollecting.commandId, intent.commandId);
  assert.equal(stillCollecting.action, 'village_collect_bed');

  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:bread': 1, 'minecraft:white_bed': 1 },
    opportunityDiscoveries: [oldRootTombstone, rekeyedRoot, laterRoot, laterContainer],
  }, intent, 'collected', {
    receipt: { inventoryDelta: { 'minecraft:white_bed': 1 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, laterRoot.id,
    'a unique scanner re-key preserves the remaining bounded village transaction');

  const held = controller.tick(snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [rekeyedRoot, laterRoot, laterContainer],
  }));
  assert.equal(held.commandId, intent.commandId);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.failed'), false);
});

test('an ambiguous owning-root re-key completes after the exact bed receipt without adopting stale authority', () => {
  const oldRoot = liveDiscovery({
    id: 'village:ambiguous-old',
    x: 10,
    count: 6,
    signals: ['access_proven', 'bed', 'executor_ready', 'hazard_free', 'marker_count:6'],
  });
  const rawBed = liveDiscovery({
    id: 'bed:ambiguous-minimum', type: 'bed', x: 10, count: 1,
  });
  const laterRoot = liveDiscovery({ id: 'village:should-not-run', x: 30 });
  const laterContainer = liveDiscovery({
    id: 'container:should-not-run', type: 'container', x: 31, count: 1,
  });
  const chosen = [
    selected(oldRoot, {
      aggregateMembers: [selected(rawBed, { observedRevision: 4, aggregateMembers: undefined })],
    }),
    selected(laterRoot, {
      aggregateMembers: [selected(laterContainer, {
        observedRevision: 5, aggregateMembers: undefined,
      })],
    }),
  ];
  let state = snapshot({
    foodLevel: 20,
    inventoryItemCounts: { 'minecraft:bread': 1 },
    opportunityDiscoveries: [oldRoot, rawBed, laterRoot, laterContainer],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, chosen, {
    decisionId: 'decision:bed-root-ambiguous',
    claimId: 'claim:bed-root-ambiguous',
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_collect_bed'));

  const expectedSignals = ['access_proven', 'executor_ready', 'hazard_free', 'marker_count:5'];
  const candidates = [
    { ...oldRoot, id: 'village:ambiguous-a', x: 11, count: 5, signals: expectedSignals },
    { ...oldRoot, id: 'village:ambiguous-b', x: 12, count: 5, signals: expectedSignals },
  ];
  const oldRootTombstone = {
    ...oldRoot,
    status: 'disappeared',
    signals: ['disappeared'],
  };
  state = snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [oldRootTombstone, ...candidates, laterRoot, laterContainer],
  });
  assert.equal(controller.tick(state).commandId, intent.commandId,
    'the exact in-flight bed command remains authoritative until its receipt');

  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:bread': 1, 'minecraft:white_bed': 1 },
    opportunityDiscoveries: [oldRootTombstone, ...candidates, laterRoot, laterContainer],
  }, intent, 'collected', {
    receipt: { inventoryDelta: { 'minecraft:white_bed': 1 } },
  });
  const stop = controller.tick(state);
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'complete');
  assert.equal(controller.isActive(), false);
  assert.equal(events.some((event) => (
    event.evt === 'opportunity.detour.stage_changed'
      && event.reason === 'verified_mutation_root_unresolved'
  )), true);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.failed'), false);
});

test('bed marker reconciliation rejects owning-root geometry and unrelated semantic mutations', () => {
  const rawVillage = liveDiscovery({
    count: 6,
    signals: ['access_proven', 'bed', 'executor_ready', 'hazard_free', 'marker_count:6'],
  });
  const rawBed = liveDiscovery({ id: 'bed:root-guard', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawBed, { observedRevision: 4, aggregateMembers: undefined })],
  });
  const expectedSignals = ['access_proven', 'executor_ready', 'hazard_free', 'marker_count:5'];
  for (const scenario of [
    {
      name: 'geometry',
      liveRoot: { ...rawVillage, x: 11, count: 5, signals: expectedSignals },
    },
    {
      name: 'unrelated-semantic',
      liveRoot: { ...rawVillage, count: 5, signals: [...expectedSignals, 'bell'] },
    },
  ]) {
    let state = snapshot({
      foodLevel: 20,
      opportunityDiscoveries: [rawVillage, rawBed],
    });
    const events = [];
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:bed-root:${scenario.name}`,
      claimId: `claim:bed-root:${scenario.name}`,
    }), state, baseline());
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_collect_bed'));
    const stop = controller.tick(snapshot({
      ...state,
      currentCommandCompleted: false,
      currentCommandId: intent.commandId,
      currentCommandCompletionReason: '',
      villageOpportunityReceipt: null,
      opportunityDiscoveries: [scenario.liveRoot],
    }));
    assert.equal(stop.action, 'stop', scenario.name);
    assert.equal(stop.opportunityStage, 'fallback', scenario.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      'opportunity_changed', scenario.name);
  }
});

test('a verified bed receipt rebases one delayed owning-root marker update exactly once', () => {
  const bedRoot = liveDiscovery({
    id: 'village:bed-owner',
    count: 6,
    signals: ['access_proven', 'bed', 'executor_ready', 'hazard_free', 'marker_count:6'],
  });
  const rawBed = liveDiscovery({ id: 'bed:delayed-root', type: 'bed', x: 11, count: 1 });
  const laterRoot = liveDiscovery({ id: 'village:later', x: 20 });
  const rawHay = liveDiscovery({ id: 'hay:later', type: 'hay', x: 21, count: 2 });
  const chosen = [
    selected(bedRoot, {
      aggregateMembers: [selected(rawBed, { observedRevision: 4, aggregateMembers: undefined })],
    }),
    selected(laterRoot, {
      aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
    }),
  ];
  let state = snapshot({
    foodLevel: 5,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [bedRoot, rawBed, laterRoot, rawHay],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, chosen), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_collect_bed'));

  // The verified pickup arrives before the throttled scanner updates the
  // owning village cluster. That receipt creates one pending expected rebase.
  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:white_bed': 1 },
    opportunityDiscoveries: [bedRoot, laterRoot, rawHay],
  }, intent, 'collected', {
    receipt: { inventoryDelta: { 'minecraft:white_bed': 1 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, laterRoot.id);

  const rebasedRoot = {
    ...bedRoot,
    revision: 8,
    count: 5,
    signals: ['access_proven', 'executor_ready', 'hazard_free', 'marker_count:5'],
  };
  state = snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [rebasedRoot, laterRoot, rawHay],
  });
  assert.equal(controller.tick(state).commandId, intent.commandId);

  // Once rebased, a second unrelated semantic change is ordinary external
  // mutation and must fail closed rather than spend the bed allowance twice.
  const stop = controller.tick(snapshot({
    ...state,
    opportunityDiscoveries: [{ ...rebasedRoot, signals: [...rebasedRoot.signals, 'bell'] }, laterRoot, rawHay],
  }));
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
    'opportunity_changed');
});

test('active mutation exemption never masks root or sibling aggregate-member changes', () => {
  const rawVillage = liveDiscovery();
  const rawHay = liveDiscovery({ id: 'hay:active', type: 'hay', x: 12, count: 2 });
  const rawBed = liveDiscovery({ id: 'bed:sibling', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [rawHay, rawBed].map((raw) => selected(raw, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })),
  });

  for (const scenario of [
    {
      name: 'root',
      discoveries: [{ ...rawVillage, x: 11 }, rawBed],
      reason: 'opportunity_changed',
    },
    {
      name: 'sibling',
      discoveries: [rawVillage, { ...rawBed, x: 14 }],
      reason: 'aggregate_member_changed',
    },
  ]) {
    let state = snapshot({
      foodLevel: 5,
      craftingTableInReach: true,
      inventoryCraftingTableCount: 1,
      opportunityDiscoveries: [rawVillage, rawHay, rawBed],
    });
    const events = [];
    const controller = new VillageOpportunityTransactionController({
      emit: (event) => events.push(event),
    });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:mutation:${scenario.name}`,
      claimId: `claim:mutation:${scenario.name}`,
    }), state, baseline());
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
    const stop = controller.tick(snapshot({
      ...state,
      currentCommandCompleted: false,
      currentCommandId: intent.commandId,
      currentCommandCompletionReason: '',
      villageOpportunityReceipt: null,
      inventoryItemCounts: { 'minecraft:hay_block': 1 },
      // The active hay may disappear, but that cannot hide another member's
      // mutation from the transaction lifecycle.
      opportunityDiscoveries: scenario.discoveries,
    }));
    assert.equal(stop.action, 'stop', scenario.name);
    assert.equal(stop.opportunityStage, 'fallback', scenario.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      scenario.reason, scenario.name);
  }
});

test('an unverified mutating receipt never persists the active-member exemption', () => {
  const rawVillage = liveDiscovery();
  const rawHay = liveDiscovery({ id: 'hay:unverified', type: 'hay', x: 12, count: 2 });
  const rawBed = liveDiscovery({ id: 'bed:after-failure', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [rawHay, rawBed].map((raw) => selected(raw, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })),
  });
  let state = snapshot({
    foodLevel: 5,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [rawVillage, rawHay, rawBed],
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));

  // The scanner has already removed hay, but the structured inventory delta
  // is deliberately wrong. The command may skip that source locally, but it
  // must not record hay as a verified self-mutation.
  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:hay_block': 1 },
    opportunityDiscoveries: [rawVillage, rawBed],
  }, intent, 'harvested', {
    receipt: { inventoryDelta: { 'minecraft:hay_block': 1 } },
  });
  intent = controller.tick(state);
  assert.notEqual(intent.action, 'stop');

  const stop = controller.tick(snapshot({
    ...state,
    currentCommandCompleted: false,
    currentCommandId: intent.commandId,
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [rawVillage, rawBed],
  }));
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
    'aggregate_member_vanished');
});

test('a village composite queues empty-container inspection, hay bread, and bed collection once', () => {
  const rawVillage = liveDiscovery();
  const rawChest = liveDiscovery({ id: 'container:empty', type: 'container', x: 11 });
  const rawHay = liveDiscovery({ id: 'hay:buffer', type: 'hay', x: 12, count: 1 });
  const rawBed = liveDiscovery({ id: 'bed:white', type: 'bed', x: 13, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [rawChest, rawHay, rawBed].map((raw) => selected(raw, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })),
  });
  let state = snapshot({
    foodLevel: 20,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [rawVillage, rawChest, rawHay, rawBed],
  });
  const controller = new VillageOpportunityTransactionController();
  const actions = [];
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());

  function advance(result, overrides = {}) {
    actions.push(intent.action);
    state = completed(state, intent, result, overrides);
    intent = controller.tick(state);
  }

  advance('arrived', { x: 10 });
  advance('verified');
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawChest.id);
  advance('arrived', { x: 11 });
  advance('verified');
  assert.equal(intent.action, 'village_inspect_container');
  advance('inspected', { receipt: { knownContainerContents: {} } });
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawHay.id);
  advance('arrived', { x: 12 });
  advance('verified');
  assert.equal(intent.action, 'village_harvest_hay');
  advance('harvested', {
    inventoryItemCounts: { 'minecraft:hay_block': 1 },
    opportunityDiscoveries: [rawVillage, rawChest, rawBed],
    receipt: { inventoryDelta: { 'minecraft:hay_block': 1 } },
  });
  assert.equal(intent.action, 'village_craft_bread');
  assert.equal(intent.targetItemCount, 1);
  advance('crafted', {
    inventoryItemCounts: { 'minecraft:bread': 1 },
    receipt: { inventoryDelta: { 'minecraft:bread': 1 } },
  });
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawBed.id);
  advance('arrived', { x: 13 });
  advance('verified');
  assert.equal(intent.action, 'village_collect_bed');
  advance('collected', {
    inventoryItemCounts: { 'minecraft:bread': 1, 'minecraft:white_bed': 1 },
    opportunityDiscoveries: [rawVillage, rawChest],
    receipt: { inventoryDelta: { 'minecraft:white_bed': 1 } },
  });
  assert.equal(intent.action, 'stop');
  assert.equal(intent.opportunityStage, 'complete');
  assert.equal(actions.filter((action) => action === 'village_inspect_container').length, 1);
  assert.equal(actions.filter((action) => action === 'village_harvest_hay').length, 1);
  assert.equal(actions.filter((action) => action === 'village_craft_bread').length, 1);
  assert.equal(actions.filter((action) => action === 'village_collect_bed').length, 1);
});

test('known chest value remains executable without a bread table while hay is omitted', () => {
  const rawVillage = liveDiscovery();
  const rawChest = liveDiscovery({
    id: 'container:no-table-value', type: 'container', x: 11, count: 1,
    contentsKnown: true, items: { 'minecraft:iron_pickaxe': 1 },
  });
  const rawHay = liveDiscovery({ id: 'hay:no-table', type: 'hay', x: 12, count: 3 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [
      selected(rawChest, {
        observedRevision: 9,
        contentsKnown: true,
        items: { 'minecraft:iron_pickaxe': 1 },
        aggregateMembers: undefined,
      }),
      selected(rawHay, { observedRevision: 4, aggregateMembers: undefined }),
    ],
  });
  let state = snapshot({
    foodLevel: 5,
    craftingTableInReach: false,
    inventoryCraftingTableCount: 0,
    opportunityDiscoveries: [rawVillage, rawChest, rawHay],
  });
  const actions = [];
  const controller = new VillageOpportunityTransactionController({
    applyReceipt(receipt) {
      if (receipt.type === 'container_inspection') {
        return { ok: true, value: {
          revision: 10,
          details: { contentsKnown: true, items: receipt.items },
        } };
      }
      if (receipt.type === 'container_withdrawal') {
        return { ok: true, value: { revision: 11, details: { contentsKnown: true, items: {} } } };
      }
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: {
      owned: {}, reserved: {},
      deficit: { 'minecraft:iron_pickaxe': 1, 'mission:iron_units': 27, 'mission:fed': 1 },
    },
  }), state, baseline());
  actions.push(intent.action);
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_inspect_container'));
  actions.push(intent.action);
  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: { 'minecraft:iron_pickaxe': 1 } },
  });
  intent = controller.tick(state);
  actions.push(intent.action);
  assert.equal(intent.action, 'village_withdraw_item');
  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:iron_pickaxe': 1 },
  }, intent, 'withdrawn', {
    receipt: {
      inventoryDelta: { 'minecraft:iron_pickaxe': 1 },
      knownContainerContents: {},
    },
  });
  intent = controller.tick(state);
  actions.push(intent.action);
  assert.equal(intent.opportunityStage, 'complete');
  assert.equal(actions.includes('village_harvest_hay'), false);
  assert.equal(actions.includes('village_craft_bread'), false);
});

test('a table verified only after village arrival enables hay at that exact site', () => {
  const rawVillage = liveDiscovery({ id: 'village:table-at-site' });
  const rawHay = liveDiscovery({ id: 'hay:table-at-site', type: 'hay', x: 12, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })],
  });
  let state = snapshot({
    foodLevel: 6,
    craftingTableInReach: false,
    inventoryCraftingTableCount: 0,
    opportunityDiscoveries: [rawVillage, rawHay],
  });
  const controller = new VillageOpportunityTransactionController();
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  assert.equal(intent.action, 'village_travel');
  state = completed({
    ...state,
    x: 10,
    craftingTableInReach: true,
  }, intent, 'arrived');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_revalidate');
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawHay.id);
  state = completed({ ...state, x: 12, craftingTableInReach: true }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_harvest_hay');
  assert.equal(intent.targetItemCount, 2);
});

test('verified chest food clamps hay and the remaining bread into one smaller batch', () => {
  function runScenario(label, foodLevelAfter, expectedHayCount, expectedBreadBatch) {
    const rawVillage = liveDiscovery();
    const rawChest = liveDiscovery({ id: `container:food:${label}`, type: 'container', x: 11, count: 1 });
    const rawHay = liveDiscovery({ id: `hay:food:${label}`, type: 'hay', x: 12, count: 3 });
    const chosen = selected(rawVillage, {
      aggregateMembers: [rawChest, rawHay].map((raw) => selected(raw, {
        observedRevision: 4,
        aggregateMembers: undefined,
      })),
    });
    let state = snapshot({
      foodLevel: 5,
      craftingTableInReach: true,
      inventoryCraftingTableCount: 1,
      opportunityDiscoveries: [rawVillage, rawChest, rawHay],
    });
    const controller = new VillageOpportunityTransactionController({
      applyReceipt(receipt) {
        if (receipt.type === 'container_inspection') {
          return {
            ok: true,
            value: { revision: 10, details: { contentsKnown: true, items: { 'minecraft:bread': 1 } } },
          };
        }
        if (receipt.type === 'container_withdrawal') {
          return { ok: true, value: { revision: 11, details: { contentsKnown: true, items: {} } } };
        }
        return { ok: true };
      },
    });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:food-clamp:${label}`,
      claimId: `claim:food-clamp:${label}`,
    }), state, baseline());
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_inspect_container'));
    state = completed(state, intent, 'inspected', {
      receipt: { knownContainerContents: { 'minecraft:bread': 1 } },
    });
    intent = controller.tick(state);
    assert.equal(intent.action, 'village_withdraw_item');
    assert.equal(intent.targetItemId, 'minecraft:bread');
    assert.equal(intent.targetItemCount, 1);

    state = completed({
      ...state,
      foodLevel: foodLevelAfter,
      inventoryItemCounts: { 'minecraft:bread': 1 },
    }, intent, 'withdrawn', {
      receipt: {
        inventoryDelta: { 'minecraft:bread': 1 },
        knownContainerContents: {},
      },
    });
    intent = controller.tick(state);
    if (expectedHayCount === 0) {
      assert.equal(intent.action, 'stop');
      assert.equal(intent.opportunityStage, 'complete');
      return;
    }
    ({ state, intent } = advanceToAction(controller, state, intent, 'village_harvest_hay'));
    assert.equal(intent.targetItemCount, expectedHayCount);
    state = completed({
      ...state,
      inventoryItemCounts: {
        'minecraft:bread': 1,
        'minecraft:hay_block': expectedHayCount,
      },
      opportunityDiscoveries: [rawVillage, rawChest],
    }, intent, 'harvested', {
      receipt: { inventoryDelta: { 'minecraft:hay_block': expectedHayCount } },
    });
    intent = controller.tick(state);
    assert.equal(intent.action, 'village_craft_bread');
    assert.equal(intent.targetItemCount, expectedBreadBatch);
    state = completed({
      ...state,
      inventoryItemCounts: { 'minecraft:bread': 1 + expectedBreadBatch },
    }, intent, 'crafted', {
      receipt: { inventoryDelta: { 'minecraft:bread': expectedBreadBatch } },
    });
    intent = controller.tick(state);
    assert.equal(intent.opportunityStage, 'complete');
  }

  // The queue originally froze two hay blocks at food level five. One chest
  // bread reduces the current reserve need to one exact hay block.
  runScenario('reduced', 5, 1, 3);
  // If Survival consumed that bread and restored the hunger bar before the
  // queued edge launches, the hay detour is skipped altogether.
  runScenario('satisfied', 20, 0, 0);
});

test('low-food container withdrawals use exact nutrition rather than one-item boolean credit', () => {
  const rawVillage = liveDiscovery({ id: 'village:nutrition' });
  const rawChest = liveDiscovery({
    id: 'container:nutrition', type: 'container', x: 11, count: 1,
  });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawChest, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })],
  });
  let state = snapshot({
    foodLevel: 0,
    opportunityDiscoveries: [rawVillage, rawChest],
  });
  const controller = new VillageOpportunityTransactionController({
    applyReceipt(receipt) {
      if (receipt.type === 'container_inspection') {
        return { ok: true, value: {
          revision: 5,
          details: { contentsKnown: true, items: { 'minecraft:bread': 5 } },
        } };
      }
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  ({ state, intent } = advanceToAction(
    controller, state, intent, 'village_inspect_container',
  ));
  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: { 'minecraft:bread': 5 } },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_withdraw_item');
  assert.equal(intent.targetItemId, 'minecraft:bread');
  assert.equal(intent.targetItemCount, 5,
    'food zero needs five bread for the full bar plus one-buffer reserve');
});

test('carried hay crafts its bounded partial capacity without requiring a harvest stage', () => {
  const rawVillage = liveDiscovery({ id: 'village:carried-hay' });
  const chosen = selected(rawVillage, { aggregateMembers: [] });
  let state = snapshot({
    foodLevel: 0,
    inventoryCraftingTableCount: 1,
    inventoryItemCounts: {
      'minecraft:crafting_table': 1,
      'minecraft:hay_block': 1,
    },
    opportunityDiscoveries: [rawVillage],
  });
  const controller = new VillageOpportunityTransactionController();
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_craft_bread'));
  assert.equal(intent.targetItemCount, 3,
    'one hay block can authoritatively produce only three bread');
});

test('a terminal travel failure never duplicates Java-owned route replanning', () => {
  const events = [];
  const state = snapshot();
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  const first = controller.maybeStart(decision(state), state, baseline());
  const failedOnce = completed(state, first, 'arrived', {
    currentCommandCompletionReason: 'village_travel_failed:no_safe_route',
    villageOpportunityReceipt: null,
  });
  const stop = controller.tick(failedOnce);
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  assert.equal(events.filter((event) => event.evt === 'opportunity.detour.replanned').length, 0);
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').failureCount, 1);
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').routeReplanCount, 0);
});

test('verified executor route replans propagate monotonically into terminal outcome truth', () => {
  const events = [];
  const memoryReceipts = [];
  let state = snapshot({
    foodLevel: 20,
    inventoryItemCounts: { 'minecraft:white_bed': 1 },
  });
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [selected()], {
    ledger: { owned: {}, reserved: {}, deficit: {} },
  }), state, baseline());
  state = completed({ ...state, x: intent.targetX, y: intent.targetY, z: intent.targetZ },
    intent, 'arrived', { receipt: { routeReplanCount: 1 } });
  intent = controller.tick(state);
  assert.equal(controller.activeSnapshot().routeReplanCount, 1);

  state = completed(state, intent, 'verified', {
    receipt: { routeReplanCount: 0 },
  });
  intent = controller.tick(state);
  assert.equal(intent.opportunityStage, 'complete');
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.completed').routeReplanCount, 1);
  assert.equal(memoryReceipts.find((receipt) => receipt.type === 'transaction_outcome')
    .details.routeReplanCount, 1);
});

test('malformed or excessive physical route-replan counts reject without mutating telemetry', () => {
  for (const routeReplanCount of [1.5, 2, -1, '1']) {
    const events = [];
    const state = snapshot();
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    const intent = controller.maybeStart(decision(state, [selected()], {
      decisionId: `decision:bad-replans:${String(routeReplanCount)}`,
      claimId: `claim:bad-replans:${String(routeReplanCount)}`,
    }), state, baseline());
    const rejected = completed({ ...state, x: intent.targetX, y: intent.targetY, z: intent.targetZ },
      intent, 'arrived', { receipt: { routeReplanCount } });
    const stop = controller.tick(rejected);
    assert.equal(stop.opportunityStage, 'fallback');
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.receipt_rejected').reason,
      'receipt_route_replan_count_invalid');
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').routeReplanCount, 0);
  }
});

test('empty inspected container is authoritative and does not invent loot', () => {
  const memoryReceipts = [];
  const rawVillage = liveDiscovery();
  const rawChest = liveDiscovery({ id: 'container:1', type: 'container', x: 11, count: 1 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawChest, { observedRevision: 9, aggregateMembers: undefined })],
  });
  let state = snapshot({ opportunityDiscoveries: [rawVillage, rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      if (receipt.type === 'container_inspection') {
        return { ok: true, value: { revision: 10, details: { contentsKnown: true, items: receipt.items } } };
      }
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: {} },
  }), state, baseline());
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  state = completed({ ...state, x: 11 }, intent, 'arrived');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_revalidate');
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_inspect_container');
  assert.equal(intent.opportunityRevision, 9);
  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: {} },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'stop');
  assert.deepEqual(memoryReceipts[0].items, {});
  assert.equal(memoryReceipts.some((entry) => entry.type === 'container_withdrawal'), false);
});

test('mixed valid and malformed inspection contents cannot be partially persisted', () => {
  const events = [];
  const memoryReceipts = [];
  const rawChest = liveDiscovery({
    id: 'container:malformed-inspection',
    type: 'container',
    x: 10,
    contentsKnown: false,
    items: {},
  });
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: false,
    items: {},
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: {} },
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_inspect_container'));

  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: {
      'minecraft:bread': 2,
      'minecraft:iron_ingot': 1.5,
    } },
  });
  const terminal = controller.tick(state);
  assert.equal(terminal.action, 'stop');
  assert.equal(memoryReceipts.some((entry) => entry.type === 'container_inspection'), false);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'
    && event.reason === 'container_contents_unverified'), true);
});

test('known positive loot forwards authoritative final contents with an exact receipt delta', () => {
  const memoryReceipts = [];
  const rawChest = liveDiscovery({ id: 'container:iron', type: 'container', x: 10, contentsKnown: true,
    items: { 'minecraft:iron_ingot': 5 } });
  const finalContents = {
    'minecraft:bread': 9,
    'minecraft:emerald': 3,
    'minecraft:iron_ingot': 1,
  };
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: true,
    items: rawChest.items,
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      return { ok: true, value: {
        revision: 13,
        details: { contentsKnown: true, items: receipt.items || rawChest.items },
      } };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:iron_units': 2 } },
  }), state, baseline());
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_inspect_container');
  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: rawChest.items },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_withdraw_item');
  assert.equal(intent.targetItemId, 'minecraft:iron_ingot');
  assert.equal(intent.targetItemCount, 2);
  state = completed({ ...state, inventoryItemCounts: { 'minecraft:iron_ingot': 5 } }, intent, 'withdrawn', {
    receipt: {
      inventoryDelta: { 'minecraft:iron_ingot': 2 },
      knownContainerContents: finalContents,
    },
  });
  const refreshedIntent = controller.tick(state);
  const withdrawalReceipt = memoryReceipts.find((entry) => entry.type === 'container_withdrawal');
  assert.deepEqual(
    withdrawalReceipt.withdrawnItems,
    { 'minecraft:iron_ingot': 2 },
  );
  assert.deepEqual(withdrawalReceipt.items, finalContents);
  assert.equal(memoryReceipts.some((entry) => entry.withdrawnItems?.['minecraft:bread']), false);
  assert.equal(refreshedIntent.action, 'village_withdraw_item');
  assert.equal(refreshedIntent.targetItemId, 'minecraft:bread');
  assert.equal(refreshedIntent.targetItemCount, 1);
});

test('malformed post-withdraw container truth cannot advance or reach memory', () => {
  const events = [];
  const memoryReceipts = [];
  const items = { 'minecraft:iron_ingot': 2 };
  const rawChest = liveDiscovery({
    id: 'container:malformed-final-contents',
    type: 'container',
    x: 10,
    contentsKnown: true,
    items,
  });
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: true,
    items,
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      if (receipt.type === 'container_inspection') {
        return { ok: true, value: { revision: 13, details: { contentsKnown: true, items } } };
      }
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:iron_units': 2 } },
  }), state, baseline());
  ({ state, intent } = advanceToAction(controller, state, intent, 'village_inspect_container'));
  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: items },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_withdraw_item');

  state = completed({
    ...state,
    inventoryItemCounts: { 'minecraft:iron_ingot': 2 },
  }, intent, 'withdrawn', {
    receipt: {
      inventoryDelta: { 'minecraft:iron_ingot': 2 },
      knownContainerContents: {
        'minecraft:bread': 7,
        'minecraft:iron_ingot': 1.5,
      },
    },
  });
  const terminal = controller.tick(state);
  assert.equal(terminal.action, 'stop');
  assert.equal(memoryReceipts.some((entry) => entry.type === 'container_withdrawal'), false);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'
    && event.reason === 'container_contents_unverified'), true);
});

test('an over-withdrawal receipt is neutral but cannot advance or debit memory', () => {
  const events = [];
  const memoryReceipts = [];
  const rawChest = liveDiscovery({ id: 'container:overdraw', type: 'container', x: 10,
    contentsKnown: true, items: { 'minecraft:iron_ingot': 5 } });
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: true,
    items: rawChest.items,
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      return { ok: true, value: {
        revision: 13,
        details: { contentsKnown: true, items: receipt.items || rawChest.items },
      } };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:iron_units': 2 } },
  }), state, baseline());
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  state = completed(state, intent, 'inspected', {
    receipt: { knownContainerContents: rawChest.items },
  });
  intent = controller.tick(state);
  assert.equal(intent.targetItemCount, 2);
  state = completed({ ...state, inventoryItemCounts: { 'minecraft:iron_ingot': 5 } }, intent, 'withdrawn', {
    receipt: {
      inventoryDelta: { 'minecraft:iron_ingot': 5 },
      knownContainerContents: {},
    },
  });
  assert.equal(controller.tick(state).action, 'stop');
  assert.equal(memoryReceipts.some((entry) => entry.type === 'container_withdrawal'), false);
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'
    && event.reason === 'receipt_inventory_delta_mismatch'), true);
});

test('fresh inspection replaces stale known contents before withdrawal planning', () => {
  const memoryReceipts = [];
  const rawChest = liveDiscovery({ id: 'container:changed', type: 'container', x: 10,
    contentsKnown: true, items: { 'minecraft:iron_pickaxe': 1 } });
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: true,
    items: rawChest.items,
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      return { ok: true, value: {
        revision: 13,
        details: { contentsKnown: true, items: {} },
      } };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: {
      'minecraft:iron_pickaxe': 1,
      'mission:iron_units': 3,
    } },
  }), state, baseline());
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_inspect_container');
  state = completed(state, intent, 'inspected', { receipt: { knownContainerContents: {} } });
  intent = controller.tick(state);
  assert.equal(intent.action, 'stop');
  assert.deepEqual(memoryReceipts.find((entry) => entry.type === 'container_inspection').items, {});
  assert.equal(memoryReceipts.some((entry) => entry.type === 'container_withdrawal'), false);
});

test('an exact neutral withdrawal failure retires stale persisted container contents', () => {
  const events = [];
  const memoryReceipts = [];
  const items = { 'minecraft:iron_ingot': 2 };
  const rawChest = liveDiscovery({
    id: 'container:changed-before-withdraw',
    type: 'container',
    x: 10,
    contentsKnown: false,
    items: {},
  });
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: true,
    items,
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      if (receipt.type === 'container_inspection') {
        return { ok: true, value: { revision: 13, details: { contentsKnown: true, items } } };
      }
      if (receipt.type === 'container_refresh_required') {
        return { ok: true, value: { revision: 14, details: { contentsKnown: false, items: {} } } };
      }
      return { ok: false, reason: 'unexpected_receipt' };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:iron_units': 2 } },
  }), state, baseline());
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  state = completed(state, intent, 'inspected', { receipt: { knownContainerContents: items } });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_withdraw_item');

  state = completed(state, intent, 'invalidated');
  const stop = controller.tick(state);
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'complete');
  assert.match(stop.reason, /:village_transaction_partial$/);
  const refresh = memoryReceipts.find((entry) => entry.type === 'container_refresh_required');
  assert.equal(refresh.containerId, rawChest.id);
  assert.equal(refresh.expectedContainerRevision, 13);
  assert.equal(refresh.commandId, intent.commandId);
  assert.equal(refresh.reason, 'invalidated');
  assert.equal(memoryReceipts.some((entry) => entry.type === 'container_withdrawal'), false);
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.stage_failed').failureCount, 1);
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.completed').failureCount, 1);
  assert.equal(events.every((event) => event.chargedAsBaselineFailure === false), true);
});

test('an exact neutral inspection retires stale persisted container contents before continuing', () => {
  const items = { 'minecraft:iron_ingot': 2 };
  const rawChest = liveDiscovery({
    id: 'container:inspection-refresh-required',
    type: 'container',
    x: 10,
    contentsKnown: true,
    items,
  });
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: true,
    items,
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const memoryReceipts = [];
  const controller = new VillageOpportunityTransactionController({
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      if (receipt.type === 'container_refresh_required') {
        return { ok: true, value: {
          revision: 13,
          details: { contentsKnown: false, items: {} },
        } };
      }
      return { ok: true };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: { 'mission:iron_units': 2 } },
  }), state, baseline());
  ({ state, intent } = advanceToAction(
    controller, state, intent, 'village_inspect_container',
  ));

  state = completed(state, intent, 'unavailable');
  const stop = controller.tick(state);
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'complete');
  const refresh = memoryReceipts.find((entry) => entry.type === 'container_refresh_required');
  assert.equal(refresh.containerId, rawChest.id);
  assert.equal(refresh.expectedContainerRevision, 12);
  assert.equal(refresh.commandId, intent.commandId);
  assert.equal(refresh.reason, 'unavailable');
  assert.equal(memoryReceipts.some((entry) => entry.type === 'container_inspection'), false);
});

test('verified pickaxe gain eliminates the queued iron-unit withdrawal', () => {
  const memoryReceipts = [];
  const items = { 'minecraft:iron_pickaxe': 1, 'minecraft:iron_ingot': 3 };
  const rawChest = liveDiscovery({ id: 'container:hybrid', type: 'container', x: 10,
    contentsKnown: true, items });
  const chosen = selected(rawChest, {
    observedRevision: 12,
    contentsKnown: true,
    items,
  });
  let state = snapshot({ opportunityDiscoveries: [rawChest], foodLevel: 20 });
  const controller = new VillageOpportunityTransactionController({
    applyReceipt(receipt) {
      memoryReceipts.push(receipt);
      if (receipt.type === 'container_inspection') {
        return { ok: true, value: { revision: 13, details: { contentsKnown: true, items } } };
      }
      return { ok: true, value: { revision: 14, details: { contentsKnown: true,
        items: { 'minecraft:iron_ingot': 3 } } } };
    },
  });
  let intent = controller.maybeStart(decision(state, [chosen], {
    ledger: { owned: {}, reserved: {}, deficit: {
      'minecraft:iron_pickaxe': 1,
      'mission:iron_units': 3,
    } },
  }), state, baseline());
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  state = completed(state, intent, 'inspected', { receipt: { knownContainerContents: items } });
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_withdraw_item');
  assert.equal(intent.targetItemId, 'minecraft:iron_pickaxe');
  state = completed({ ...state, inventoryItemCounts: { 'minecraft:iron_pickaxe': 1 } }, intent, 'withdrawn', {
    receipt: {
      inventoryDelta: { 'minecraft:iron_pickaxe': 1 },
      knownContainerContents: { 'minecraft:iron_ingot': 3 },
    },
  });
  intent = controller.tick(state);
  assert.equal(intent.action, 'stop');
  assert.equal(memoryReceipts.filter((entry) => entry.type === 'container_withdrawal').length, 1);
  assert.deepEqual(
    memoryReceipts.find((entry) => entry.type === 'container_withdrawal').withdrawnItems,
    { 'minecraft:iron_pickaxe': 1 },
  );
});

test('container armor withdrawal skips exact carried or equipped duplicates but takes a missing piece', () => {
  const cases = [
    {
      name: 'carried',
      state: { inventoryItemCounts: { 'minecraft:iron_helmet': 1 } },
      owned: { 'minecraft:iron_helmet': 1 },
      expectedWithdrawal: false,
    },
    {
      name: 'equipped',
      state: { equippedHelmetItem: 'minecraft:iron_helmet' },
      owned: { 'mission:equipped_iron_armor': 1 },
      expectedWithdrawal: false,
    },
    {
      name: 'missing',
      state: {},
      owned: {},
      expectedWithdrawal: true,
    },
  ];
  for (const fixture of cases) {
    const items = { 'minecraft:iron_helmet': 1 };
    const rawChest = liveDiscovery({
      id: `container:armor-${fixture.name}`,
      type: 'container',
      x: 10,
      contentsKnown: true,
      items,
    });
    const chosen = selected(rawChest, {
      observedRevision: 12,
      contentsKnown: true,
      items,
    });
    let state = snapshot({
      ...fixture.state,
      opportunityDiscoveries: [rawChest],
      foodLevel: 20,
    });
    const controller = new VillageOpportunityTransactionController({
      applyReceipt(receipt) {
        if (receipt.type === 'container_inspection') {
          return { ok: true, value: {
            revision: 13,
            details: { contentsKnown: true, items },
          } };
        }
        return { ok: true };
      },
    });
    let intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:armor-${fixture.name}`,
      claimId: `claim:armor-${fixture.name}`,
      ledger: {
        owned: fixture.owned,
        reserved: {},
        deficit: { 'mission:equipped_iron_armor': fixture.name === 'equipped' ? 3 : 4 },
      },
    }), state, baseline());
    state = completed({ ...state, x: 10 }, intent, 'arrived');
    intent = controller.tick(state);
    state = completed(state, intent, 'verified');
    intent = controller.tick(state);
    assert.equal(intent.action, 'village_inspect_container', fixture.name);
    state = completed(state, intent, 'inspected', {
      receipt: { knownContainerContents: items },
    });
    intent = controller.tick(state);
    assert.equal(intent.action === 'village_withdraw_item', fixture.expectedWithdrawal, fixture.name);
    if (fixture.expectedWithdrawal) {
      assert.equal(intent.targetItemId, 'minecraft:iron_helmet');
      assert.equal(intent.targetItemCount, 1);
    } else {
      assert.equal(intent.opportunityStage, 'complete', fixture.name);
    }
  }
});

test('stale structured receipts cannot advance a correlated stage', () => {
  const events = [];
  const state = snapshot();
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  const intent = controller.maybeStart(decision(state), state, baseline());
  const stale = completed({ ...state, x: 10 }, intent, 'arrived', {
    receipt: { opportunityRevision: 99 },
  });
  const result = controller.tick(stale);
  assert.equal(result.action, 'stop');
  assert.equal(result.opportunityStage, 'fallback');
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'
    && event.reason === 'receipt_revision_mismatch'), true);
});

test('structured receipts require every code-owned correlation field exactly', () => {
  const cases = [
    ['action', '', 'receipt_action_mismatch'],
    ['detourId', '', 'receipt_detour_mismatch'],
    ['detourStageSeq', -1, 'receipt_stage_sequence_mismatch'],
    ['stage', '', 'receipt_stage_mismatch'],
    ['worldId', '', 'receipt_world_mismatch'],
    ['dimension', '', 'receipt_dimension_mismatch'],
    ['mission', '', 'receipt_mission_mismatch'],
    ['opportunityRevision', null, 'receipt_revision_mismatch'],
  ];
  for (const [field, value, expectedReason] of cases) {
    const events = [];
    const state = snapshot();
    const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
    const intent = controller.maybeStart(decision(state), state, baseline());
    const rejected = completed({ ...state, x: 10 }, intent, 'arrived', {
      receipt: { [field]: value },
    });
    const result = controller.tick(rejected);
    assert.equal(result.action, 'stop', field);
    assert.equal(events.some((event) => event.evt === 'opportunity.detour.receipt_rejected'
      && event.reason === expectedReason), true, field);
  }
});

test('neutral executor feedback also requires an exact structured receipt', () => {
  const state = snapshot();
  const acceptedEvents = [];
  const accepted = new VillageOpportunityTransactionController({ emit: (event) => acceptedEvents.push(event) });
  const intent = accepted.maybeStart(decision(state), state, baseline());
  const unavailable = completed(state, intent, 'unavailable', {
    receipt: { result: 'unavailable' },
  });
  assert.equal(accepted.tick(unavailable).opportunityStage, 'fallback');
  assert.equal(acceptedEvents.some((event) => event.evt === 'opportunity.detour.receipt_rejected'), false);
  assert.equal(acceptedEvents.find((event) => event.evt === 'opportunity.detour.failed').failureCount, 1);
  assert.equal(acceptedEvents.every((event) => event.chargedAsBaselineFailure === false), true);

  const rejectedEvents = [];
  const rejected = new VillageOpportunityTransactionController({ emit: (event) => rejectedEvents.push(event) });
  const otherIntent = rejected.maybeStart(decision(state, [selected()], {
    decisionId: 'decision:neutral:2', claimId: 'claim:neutral:2',
  }), state, baseline());
  const partial = completed(state, otherIntent, 'unavailable', {
    receipt: { result: 'unavailable', mission: '' },
  });
  assert.equal(rejected.tick(partial).opportunityStage, 'fallback');
  assert.equal(rejectedEvents.some((event) => event.evt === 'opportunity.detour.receipt_rejected'
    && event.reason === 'receipt_mission_mismatch'), true);
});

test('aggregate members are live-revalidated before admission and throughout the detour', () => {
  const rawVillage = liveDiscovery();
  const rawHay = liveDiscovery({ id: 'hay:member', type: 'hay', x: 12, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
  });
  const full = snapshot({ opportunityDiscoveries: [rawVillage, rawHay] });

  const vanishedEvents = [];
  const vanished = snapshot({ opportunityDiscoveries: [rawVillage] });
  const vanishedController = new VillageOpportunityTransactionController({
    emit: (event) => vanishedEvents.push(event),
  });
  assert.equal(vanishedController.maybeStart(decision(vanished, [chosen]), vanished, baseline()), null);
  assert.equal(vanishedEvents.at(-1).reason, 'aggregate_member_vanished');

  const changedEvents = [];
  const changedHay = { ...rawHay, x: 13 };
  const changed = snapshot({ opportunityDiscoveries: [rawVillage, changedHay] });
  const changedController = new VillageOpportunityTransactionController({
    emit: (event) => changedEvents.push(event),
  });
  assert.equal(changedController.maybeStart(decision(changed, [chosen]), changed, baseline()), null);
  assert.equal(changedEvents.at(-1).reason, 'aggregate_member_changed');

  const activeEvents = [];
  const active = new VillageOpportunityTransactionController({ emit: (event) => activeEvents.push(event) });
  assert.equal(active.maybeStart(decision(full, [chosen]), full, baseline()).action, 'village_travel');
  const stop = active.tick(vanished);
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  assert.equal(activeEvents.find((event) => event.evt === 'opportunity.detour.failed').reason,
    'aggregate_member_vanished');
});

test('aggregate admission enforces the shared sixteen-block vertical village bound', () => {
  const rawVillage = liveDiscovery({ id: 'village:vertical-bound', y: 64 });
  for (const fixture of [
    { name: 'exact-bound', y: 80, admitted: true },
    { name: 'beyond-bound', y: 81, admitted: false },
  ]) {
    const events = [];
    const rawHay = liveDiscovery({
      id: `hay:vertical-${fixture.name}`,
      type: 'hay',
      x: 12,
      y: fixture.y,
      count: 2,
    });
    const chosen = selected(rawVillage, {
      aggregateMembers: [selected(rawHay, {
        observedRevision: 4,
        aggregateMembers: undefined,
      })],
    });
    const state = snapshot({ opportunityDiscoveries: [rawVillage, rawHay] });
    const controller = new VillageOpportunityTransactionController({
      emit: (event) => events.push(event),
    });
    const intent = controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:vertical:${fixture.name}`,
      claimId: `claim:vertical:${fixture.name}`,
    }), state, baseline());
    assert.equal(intent?.action === 'village_travel', fixture.admitted, fixture.name);
    if (!fixture.admitted) {
      assert.equal(events.at(-1).reason, 'aggregate_member_out_of_range');
    }
  }
});

test('a truncated wire catalog may omit a frozen village until exact arrival revalidation', () => {
  const rawVillage = liveDiscovery({ id: 'village:wire-truncated' });
  const rawHay = liveDiscovery({
    id: 'hay:wire-truncated', type: 'hay', x: 12, count: 2,
  });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, {
      observedRevision: 4,
      aggregateMembers: undefined,
    })],
  });
  const omitted = snapshot({
    opportunityDiscoveries: [],
    opportunityDiscoveriesTruncated: true,
  });
  const events = [];
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
  });

  const travel = controller.maybeStart(decision(omitted, [chosen], {
    decisionId: 'decision:wire-truncated',
    claimId: 'claim:wire-truncated',
  }), omitted, baseline());
  assert.equal(travel.action, 'village_travel');
  assert.equal(events.some((event) => event.evt === 'opportunity.detour.started'), true);

  const continued = controller.tick(omitted);
  assert.equal(continued.commandId, travel.commandId);
  assert.equal(continued.action, 'village_travel');

  const completeCatalog = { ...omitted, opportunityDiscoveriesTruncated: false };
  const stop = controller.tick(completeCatalog);
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
    'opportunity_vanished');
});

test('truncated catalogs do not hide explicit invalidation or semantic mutation', () => {
  const rawVillage = liveDiscovery({ id: 'village:wire-contradiction' });
  const chosen = selected(rawVillage);
  for (const entry of [
    {
      name: 'invalidated',
      live: { ...rawVillage, status: 'invalidated', signals: ['invalidated'] },
      reason: 'stale_opportunity_revision',
    },
    {
      name: 'moved',
      live: { ...rawVillage, x: rawVillage.x + 1 },
      reason: 'stale_opportunity_revision',
    },
  ]) {
    const state = snapshot({
      opportunityDiscoveries: [entry.live],
      opportunityDiscoveriesTruncated: true,
    });
    const events = [];
    const controller = new VillageOpportunityTransactionController({
      emit: (event) => events.push(event),
    });
    assert.equal(controller.maybeStart(decision(state, [chosen], {
      decisionId: `decision:wire-contradiction:${entry.name}`,
      claimId: `claim:wire-contradiction:${entry.name}`,
    }), state, baseline()), null, entry.name);
    assert.equal(events.at(-1).reason, entry.reason, entry.name);
  }
});

test('a distant frozen aggregate member receives an explicit travel and revalidation edge', () => {
  const events = [];
  const rawVillage = liveDiscovery();
  const rawHay = liveDiscovery({ id: 'hay:distant', type: 'hay', x: 45, count: 2 });
  const chosen = selected(rawVillage, {
    aggregateMembers: [selected(rawHay, { observedRevision: 4, aggregateMembers: undefined })],
  });
  let state = snapshot({
    opportunityDiscoveries: [rawVillage, rawHay], craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
  });
  const controller = new VillageOpportunityTransactionController({ emit: (event) => events.push(event) });
  let intent = controller.maybeStart(decision(state, [chosen]), state, baseline());
  state = completed({ ...state, x: 10 }, intent, 'arrived');
  intent = controller.tick(state);
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, 'hay:distant');
  assert.equal(intent.targetX, 45);
  assert.equal(intent.opportunityStage, 'travel_edge');
  assert.equal(controller.tick(snapshot({
    ...state,
    x: 30,
    currentCommandCompleted: false,
    currentCommandId: '',
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [rawVillage, rawHay],
  })).commandId, intent.commandId);
  state = completed({ ...state, x: 45 }, intent, 'arrived');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_revalidate', JSON.stringify(events.at(-1)));
  assert.equal(intent.opportunityId, 'hay:distant');
  assert.equal(intent.opportunityStage, 'revalidate_edge');
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_harvest_hay');
  assert.equal(intent.opportunityId, 'hay:distant');
});

test('remote deferred member access still requires physical edge revalidation and fails neutrally', () => {
  const events = [];
  const rawVillage = liveDiscovery({
    id: 'village:remote-root',
    signals: ['route_reachable', 'hazard_free'],
    readinessSource: 'code_owned_registry_v1',
    capabilityId: 'village_transaction',
    executorId: 'village_revalidate',
    executorReady: true,
  });
  const rawHay = liveDiscovery({
    id: 'hay:remote-deferred',
    type: 'hay',
    x: 42,
    count: 2,
    signals: ['hazard_free'],
    readinessSource: 'code_owned_registry_v1',
    capabilityId: 'village_hay',
    executorId: 'village_harvest_hay',
    executorReady: true,
  });
  const frozenHay = selected(rawHay, {
    observedRevision: 4,
    aggregateMembers: undefined,
    remoteAccessDeferred: true,
    hazardFree: true,
    executorReady: true,
    readinessSource: 'code_owned_registry_v1',
    capabilityId: 'village_hay',
    executorId: 'village_harvest_hay',
  });
  const chosen = selected(rawVillage, {
    accessProof: 'route_reachable',
    executorReady: true,
    readinessSource: 'code_owned_registry_v1',
    capabilityId: 'village_transaction',
    executorId: 'village_revalidate',
    aggregateMembers: [frozenHay],
  });
  let state = snapshot({
    opportunityDiscoveries: [rawVillage, rawHay],
    craftingTableInReach: true,
    inventoryCraftingTableCount: 1,
  });
  const controller = new VillageOpportunityTransactionController({
    emit: (event) => events.push(event),
  });

  let intent = controller.maybeStart(decision(state, [chosen], {
    decisionId: 'decision:remote-deferred',
    claimId: 'claim:remote-deferred',
  }), state, baseline());
  assert.equal(intent.action, 'village_travel');
  const promotedVillage = {
    ...rawVillage,
    status: 'verified',
    signals: ['access_proven', 'hazard_free'],
  };
  const promotedHay = {
    ...rawHay,
    status: 'verified',
    signals: ['access_proven', 'hazard_free'],
  };
  const rootPromotionPoll = snapshot({
    ...state,
    opportunityDiscoveries: [promotedVillage, rawHay],
  });
  assert.equal(controller.tick(rootPromotionPoll).commandId, intent.commandId,
    'route-reachable to access-proven root promotion preserves the active command');
  state = completed({
    ...rootPromotionPoll,
    x: rawVillage.x,
  }, intent, 'arrived');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_revalidate');
  state = completed(state, intent, 'verified');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_travel');
  assert.equal(intent.opportunityId, rawHay.id);
  assert.equal(intent.opportunityStage, 'travel_edge');
  const memberPromotionPoll = snapshot({
    ...state,
    opportunityDiscoveries: [promotedVillage, promotedHay],
  });
  assert.equal(controller.tick(memberPromotionPoll).commandId, intent.commandId,
    'deferred member to access-proven promotion preserves its travel edge');
  state = completed({
    ...memberPromotionPoll,
    x: rawHay.x,
  }, intent, 'arrived');
  intent = controller.tick(state);
  assert.equal(intent.action, 'village_revalidate');
  assert.equal(intent.opportunityId, rawHay.id);
  assert.equal(intent.opportunityStage, 'revalidate_edge');
  assert.equal(events.some((event) => event.action === 'village_harvest_hay'), false,
    'remote value work cannot start before exact member revalidation');

  const stop = controller.tick(completed(state, intent, 'unavailable', {
    receipt: { result: 'unavailable' },
  }));
  assert.equal(stop.action, 'stop');
  assert.equal(stop.opportunityStage, 'fallback');
  const failed = events.find((event) => event.evt === 'opportunity.detour.failed');
  assert.equal(failed.reason, 'unavailable');
  assert.equal(failed.chargedAsBaselineFailure, false);
  assert.equal(failed.retriesConsumed, 0);
});

test('access promotion preserves identity while hazard readiness and geometry mutations fail closed', () => {
  const raw = liveDiscovery({
    id: 'village:identity-promotion',
    signals: ['route_reachable', 'hazard_free'],
    readinessSource: 'code_owned_registry_v1',
    capabilityId: 'village_transaction',
    executorId: 'village_revalidate',
    executorReady: true,
  });
  const frozen = selected(raw, {
    accessProof: 'route_reachable',
    executorReady: true,
    readinessSource: 'code_owned_registry_v1',
    capabilityId: 'village_transaction',
    executorId: 'village_revalidate',
  });
  const promoted = {
    ...raw,
    status: 'verified',
    signals: ['access_proven', 'hazard_free'],
  };
  for (const fixture of [
    {
      name: 'hazard',
      live: { ...promoted, signals: ['access_proven', 'hazard_free', 'hazard'] },
      reason: 'opportunity_unsafe',
    },
    {
      name: 'readiness',
      live: { ...promoted, executorReady: false },
      reason: 'opportunity_changed',
    },
    {
      name: 'geometry',
      live: { ...promoted, x: raw.x + 1 },
      reason: 'opportunity_changed',
    },
  ]) {
    const events = [];
    const initial = snapshot({ opportunityDiscoveries: [raw] });
    const controller = new VillageOpportunityTransactionController({
      emit: (event) => events.push(event),
    });
    const intent = controller.maybeStart(decision(initial, [frozen], {
      decisionId: `decision:identity:${fixture.name}`,
      claimId: `claim:identity:${fixture.name}`,
    }), initial, baseline());
    assert.equal(intent.action, 'village_travel', fixture.name);
    const stop = controller.tick(snapshot({ opportunityDiscoveries: [fixture.live] }));
    assert.equal(stop.action, 'stop', fixture.name);
    assert.equal(stop.opportunityStage, 'fallback', fixture.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason,
      fixture.reason, fixture.name);
  }
});

test('semantic refresh does not invalidate a frozen catalog but changed geometry does', () => {
  const raw = liveDiscovery();
  const frozen = selected(raw, { observedRevision: 7 });
  const refreshedState = snapshot({ opportunityDiscoveries: [{ ...raw, revision: 99, observedAtMs: 50_000 }] });
  const controller = new VillageOpportunityTransactionController();
  assert.equal(controller.maybeStart(decision(refreshedState, [frozen]), refreshedState, baseline()).action, 'village_travel');

  const changed = snapshot({ opportunityDiscoveries: [{ ...raw, x: 11, revision: 100 }] });
  assert.equal(controller.tick(changed).opportunityStage, 'fallback');
});

test('deadline, travel budget, world, and dimension changes fail closed without retries', () => {
  let now = 0;
  const cases = [
    { name: 'deadline', mutate: (state) => { now = 420_000; return state; }, reason: 'detour_deadline' },
    { name: 'travel', mutate: (state) => ({ ...state, x: 40 }), reason: 'travel_budget_exhausted', repeat: 10 },
    { name: 'world', mutate: (state) => ({ ...state, worldIdentity: { id: 'world:other', dimension: 'overworld' } }), reason: 'world_changed' },
    { name: 'dimension', mutate: (state) => ({ ...state, worldIdentity: { id: 'world:test', dimension: 'the_nether' } }), reason: 'dimension_changed' },
  ];
  for (const entry of cases) {
    now = 0;
    const events = [];
    const target = liveDiscovery({ x: 300 });
    const state = snapshot({ opportunityDiscoveries: [target] });
    const controller = new VillageOpportunityTransactionController({ now: () => now, emit: (event) => events.push(event) });
    controller.maybeStart(decision(state, [selected(target)]), state, baseline());
    let mutated = state;
    for (let i = 0; i < (entry.repeat || 1); i += 1) mutated = entry.mutate(mutated);
    const stop = controller.tick(mutated);
    assert.equal(stop.action, 'stop', entry.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').reason, entry.reason, entry.name);
    assert.equal(events.find((event) => event.evt === 'opportunity.detour.failed').retriesConsumed, 0);
  }
});

test('detour completion sanitizer removes only command receipt authority', () => {
  const raw = snapshot({
    currentCommandCompleted: true,
    currentCommandId: 'mission-village-1',
    activeNavigationCommandId: 'mission-village-1',
    currentCommandCompletionReason: 'village_travel_failed:no_path',
    inventoryItemCounts: { 'minecraft:iron_ingot': 3 },
  });
  const sanitized = sanitizeVillageReceiptSnapshot(raw);
  assert.equal(sanitized.currentCommandCompleted, false);
  assert.equal(sanitized.currentCommandId, '');
  assert.equal(sanitized.currentCommandCompletionReason, '');
  assert.deepEqual(sanitized.inventoryItemCounts, raw.inventoryItemCounts);
  assert.equal(sanitized.x, raw.x);
});
