import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createOpportunityShadowCoordinator,
  resolveFabricOpportunityConfig,
} from './opportunity-shadow-coordinator.js';
import { OpportunityRoutePlanner } from './opportunity-route-planner.js';
import { FabricWorldMemoryStore } from './mission-world-memory.js';
import { VillageOpportunityTransactionController } from './village-opportunity-transaction.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-opportunity-shadow-test-'));
}

function snapshot(overrides = {}) {
  return {
    worldIdentity: 'world:a',
    worldPersistenceEligible: true,
    worldIdentitySource: 'integrated_server_save',
    dimension: 'overworld',
    missionGoal: 'iron_armor',
    x: 0,
    y: 70,
    z: 0,
    foodLevel: 20,
    inventoryItemCounts: {},
    inventoryLogCount: 20,
    inventoryPlankCount: 0,
    opportunityDiscoveries: [],
    ...overrides,
  };
}

function discovery(overrides = {}) {
  return {
    id: 'village:near',
    type: 'village',
    dimension: 'overworld',
    x: 12,
    y: 70,
    z: 0,
    confidence: 0.98,
    status: 'verified',
    safe: true,
    ready: true,
    feasible: true,
    reliability: 0.98,
    failureUpperBound: 0.01,
    travelP75Seconds: 8,
    executionP75Seconds: 20,
    uncertaintyPenaltySeconds: 2,
    observedAtMs: 100,
    signals: ['access_proven', 'hazard_free', 'executor_ready'],
    ...overrides,
  };
}

function registryDiscovery(type, overrides = {}) {
  const executor = {
    village: ['village_transaction', 'village_revalidate'],
    container: ['village_container', 'village_inspect_container'],
    hay: ['village_hay', 'village_harvest_hay'],
    bed: ['village_bed', 'village_collect_bed'],
    iron_golem: ['village_golem_iron', 'village_defeat_iron_golem'],
  }[type];
  return discovery({
    type,
    signals: ['hazard_free'],
    readinessSource: 'code_owned_registry_v1',
    capabilityId: executor[0],
    executorId: executor[1],
    executorReady: true,
    readinessReason: 'fixture_ready',
    ...overrides,
  });
}

function harness(overrides = {}) {
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'shadow', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => 100,
    ...overrides,
  });
  return { coordinator, events };
}

function observe(coordinator, current, overrides = {}) {
  return coordinator.observe('instance:a', current, {
    defaultObjective: 'DESCEND',
    appliedIntent: {
      action: 'descend_staircase',
      commandId: 'mission:DESCEND:1',
      missionObjective: 'DESCEND',
      reason: 'deterministic baseline',
    },
    ...overrides,
  });
}

function syntheticStrategyCandidate(id, overrides = {}) {
  const p75TravelExecutionSeconds = overrides.p75TravelExecutionSeconds ?? 20;
  const baselineRemainingTimeSeconds = overrides.baselineRemainingTimeSeconds ?? 60;
  const failurePenaltySeconds = overrides.failurePenaltySeconds ?? 0;
  const uncertaintyPenaltySeconds = overrides.uncertaintyPenaltySeconds ?? 0;
  const totalSeconds = overrides.totalSeconds
    ?? p75TravelExecutionSeconds + baselineRemainingTimeSeconds
      + failurePenaltySeconds + uncertaintyPenaltySeconds;
  return Object.freeze({
    choiceId: `opportunity:${id}`,
    kind: 'opportunity',
    opportunityIds: Object.freeze([id]),
    detourEdges: 1,
    scoreSeconds: totalSeconds,
    baselineRemainingTimeSeconds,
    p75TravelExecutionSeconds,
    failurePenaltySeconds,
    uncertaintyPenaltySeconds,
    failureUpperBound: overrides.failureUpperBound ?? 0.05,
    reliability: overrides.reliability ?? 0.95,
    estimatedGain: Object.freeze({ 'mission:food_units': 15 }),
    estimatedResidualDeficit: Object.freeze({ 'mission:food_units': 5 }),
    authoritativeDeficit: Object.freeze({ 'mission:food_units': 20 }),
    authoritativeGoalSatisfied: false,
    requiresAuthoritativeVerification: true,
    conservativeBenefitSeconds: 500 - totalSeconds,
    conservativeBenefitFraction: (500 - totalSeconds) / 500,
    thresholdEligible: true,
    costBreakdown: Object.freeze({
      p75TravelExecutionSeconds,
      failurePenaltySeconds,
      uncertaintyPenaltySeconds,
      baselineRemainingTimeSeconds,
      totalSeconds,
    }),
  });
}

function syntheticStrategyPlanner(candidates, recommendationIndex = 0) {
  const baseline = Object.freeze({
    choiceId: 'continue_baseline',
    kind: 'baseline',
    opportunityIds: Object.freeze([]),
    scoreSeconds: 500,
    baselineRemainingTimeSeconds: 500,
    p75TravelExecutionSeconds: 0,
    failurePenaltySeconds: 0,
    uncertaintyPenaltySeconds: 0,
    failureUpperBound: 0.1,
    reliability: 0.9,
    estimatedGain: Object.freeze({}),
    estimatedResidualDeficit: Object.freeze({ 'mission:food_units': 20 }),
    authoritativeDeficit: Object.freeze({ 'mission:food_units': 20 }),
    authoritativeGoalSatisfied: false,
    requiresAuthoritativeVerification: true,
    thresholdEligible: false,
    costBreakdown: Object.freeze({
      p75TravelExecutionSeconds: 0,
      failurePenaltySeconds: 0,
      uncertaintyPenaltySeconds: 0,
      baselineRemainingTimeSeconds: 500,
      totalSeconds: 500,
    }),
  });
  return Object.freeze({
    plan() {
      const recommendation = candidates[recommendationIndex] || baseline;
      return Object.freeze({
        recommendation,
        baseline,
        candidates: Object.freeze(candidates),
        evaluated: Object.freeze(candidates),
        selected: recommendation,
        rejectedOpportunities: Object.freeze([]),
        consideredOpportunityIds: Object.freeze(candidates.map((entry) => entry.opportunityIds[0])),
        shouldSwitch: recommendation.kind === 'opportunity',
        recommendationEligible: recommendation.kind === 'opportunity',
        reason: recommendation.kind === 'opportunity' ? 'opportunity_selected' : 'benefit_threshold_not_met',
        expandedStates: candidates.length + 1,
        bounds: Object.freeze({ generatedCandidates: candidates.length }),
      });
    },
  });
}

test('opportunity mode defaults off, admits deterministic active, and invalid values fail closed', () => {
  assert.deepEqual(resolveFabricOpportunityConfig({}), {
    mode: 'off',
    requestedMode: 'off',
    rejectedReason: null,
    maxDiscoveries: 256,
    freshnessRefreshMs: 30000,
    freshnessPenaltyMs: 120000,
    freshnessRejectMs: 300000,
    configuredWorldId: '',
    memoryRootDir: undefined,
  });
  const active = resolveFabricOpportunityConfig({ MCBOT_FABRIC_OPPORTUNITY_MODE: 'active' });
  assert.equal(active.mode, 'active');
  assert.equal(active.requestedMode, 'active');
  assert.equal(active.rejectedReason, null);

  const invalid = resolveFabricOpportunityConfig({ MCBOT_FABRIC_OPPORTUNITY_MODE: 'actve' });
  assert.equal(invalid.mode, 'off');
  assert.equal(invalid.requestedMode, 'actve');
  assert.equal(invalid.rejectedReason, 'invalid_mode');

  const events = [];
  createOpportunityShadowCoordinator({
    env: { MCBOT_FABRIC_OPPORTUNITY_MODE: 'broken' },
    emit: (event) => events.push(event),
  });
  assert.deepEqual(events, [{
    evt: 'opportunity.mode.rejected',
    requestedMode: 'broken',
    appliedMode: 'off',
    reason: 'invalid_mode',
    behaviorApplied: false,
  }]);
});

test('off mode is byte-equivalent, emits nothing, and never invokes a provider', () => {
  const events = [];
  let providerCalls = 0;
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'off' },
    emit: (event) => events.push(event),
    complete: () => { providerCalls += 1; throw new Error('provider forbidden'); },
  });
  const current = snapshot({ opportunityDiscoveries: [discovery()] });
  const intent = { action: 'gather_tree', commandId: 'mission:GATHER_WOOD:1' };
  const beforeSnapshot = JSON.stringify(current);
  const beforeIntent = JSON.stringify(intent);
  const result = coordinator.observe('off', current, { defaultObjective: 'GATHER_WOOD', intent });

  assert.equal(result, undefined);
  assert.equal(JSON.stringify(current), beforeSnapshot);
  assert.equal(JSON.stringify(intent), beforeIntent);
  assert.equal(events.length, 0);
  assert.equal(providerCalls, 0);
});

test('active mode publishes one revision-keyed code-owned village composite without applying it', () => {
  let now = 100;
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => now,
  });
  const village = discovery();
  const hay = discovery({
    id: 'hay:near',
    type: 'hay',
    x: 14,
    count: 3,
  });
  const current = snapshot({
    foodLevel: 5,
    inventoryItemCounts: {
      'minecraft:crafting_table': 1,
      'minecraft:dirt': 12,
      'mission:world_uuid_command_route_action_x_123_y_64_z_789': 1,
    },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [village, hay],
  });
  observe(coordinator, current, { defaultObjective: 'EAT' });
  const first = coordinator.latestDecision('instance:a');
  assert.equal(first.mode, 'active');
  assert.equal(first.shouldSwitch, true);
  assert.equal(first.defaultObjective, 'EAT');
  assert.deepEqual(first.recommendation.opportunityIds, ['village:near']);
  assert.deepEqual(first.selectedOpportunities[0].aggregateMembers.map((entry) => entry.id), ['hay:near']);
  assert.equal(first.ledger.deficit['mission:food_units'], 20);
  assert.equal(events.some((event) => event.behaviorApplied === true), false,
    'coordinator publishes a claim but never applies physical behavior itself');

  now += 31_000;
  observe(coordinator, {
    ...current,
    opportunityDiscoveries: [
      { ...village, observedAtMs: now },
      { ...hay, observedAtMs: now },
    ],
  }, { defaultObjective: 'EAT' });
  const refreshed = coordinator.latestDecision('instance:a');
  assert.equal(refreshed.claimId, first.claimId, 'semantically identical target keeps one active claim');
  assert.equal(refreshed.selectedOpportunities[0].semanticRevision,
    first.selectedOpportunities[0].semanticRevision);
});

test('food opportunities retain exact nutrition and never turn one apple into a full reserve', () => {
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => 100,
  });
  const village = discovery({ id: 'village:nutrition' });
  const container = discovery({
    id: 'container:nutrition',
    type: 'container',
    x: 13,
    contentsKnown: true,
    items: {
      'minecraft:apple': 1,
      'minecraft:iron_pickaxe': 1,
    },
  });
  const current = snapshot({
    foodLevel: 0,
    opportunityDiscoveries: [village, container],
  });
  observe(coordinator, current, { defaultObjective: 'EAT' });
  const decision = coordinator.latestDecision('instance:a');
  assert.equal(decision.ledger.deficit['mission:food_units'], 25);
  assert.equal(decision.shouldSwitch, true, 'valuable tool keeps the composite inspectable');
  const gain = events.find((event) => event.evt === 'opportunity.shadow.evaluated')
    .estimatedGain;
  assert.equal(gain['minecraft:apple'], 1);
  assert.equal(gain['mission:food_units'], 4);
  assert.equal(gain['mission:fed'], undefined);
});

test('carried hay and wheat remain convertible evidence and never become owned food', () => {
  const ready = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  observe(ready, snapshot({
    foodLevel: 5,
    inventoryCraftingTableCount: 1,
    inventoryItemCounts: {
      'minecraft:crafting_table': 1,
      'minecraft:hay_block': 1,
      'minecraft:wheat': 3,
    },
  }), { defaultObjective: 'EAT' });
  const readyDecision = ready.latestDecision('instance:a');
  assert.equal(readyDecision.ledger.owned['mission:food_units'], 5);
  assert.equal(readyDecision.ledger.deficit['mission:food_units'], 20);

  const blocked = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  observe(blocked, snapshot({
    foodLevel: 5,
    inventoryItemCounts: {
      'minecraft:hay_block': 1,
      'minecraft:wheat': 3,
    },
  }), { defaultObjective: 'EAT' });
  const blockedDecision = blocked.latestDecision('instance:a');
  assert.equal(blockedDecision.ledger.owned['mission:food_units'], 5);
  assert.equal(blockedDecision.ledger.deficit['mission:food_units'], 20);
});

test('a verified destination table gives carried hay food value exactly once without making it owned', () => {
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => 100,
  });
  const village = discovery({
    id: 'village:carried-hay-table',
    signals: [
      'access_proven',
      'hazard_free',
      'executor_ready',
      'destination_crafting_table_verified',
    ],
  });
  const current = snapshot({
    foodLevel: 0,
    inventoryItemCounts: { 'minecraft:hay_block': 2 },
    inventoryCraftingTableCount: 0,
    craftingTableInReach: false,
    opportunityDiscoveries: [village],
  });
  observe(coordinator, current, { defaultObjective: 'EAT' });
  const decision = coordinator.latestDecision('instance:a');
  assert.equal(decision.ledger.owned['mission:food_units'], undefined,
    'remote conversion remains estimated until bread is actually crafted');
  assert.equal(decision.ledger.deficit['mission:food_units'], 25);
  assert.equal(decision.shouldSwitch, true);
  assert.deepEqual(decision.recommendation.opportunityIds, [village.id]);
  const evaluated = events.find((event) => event.evt === 'opportunity.shadow.evaluated'
    && event.choiceId.includes(village.id));
  assert.equal(evaluated.estimatedGain['mission:food_units'], 30,
    'two already-carried hay blocks unlock six bread exactly once');

  const noTable = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  observe(noTable, {
    ...current,
    opportunityDiscoveries: [discovery({ id: 'village:no-table-unlock' })],
  }, { defaultObjective: 'EAT' });
  assert.equal(noTable.latestDecision('instance:a').shouldSwitch, false,
    'carried hay has no opportunity value without a verified destination executor');
});

test('hay is member-granular and reevaluates only when bread table readiness appears', () => {
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  const village = discovery({ id: 'village:table-gate' });
  const hay = discovery({ id: 'hay:table-gate', type: 'hay', x: 14, count: 3 });
  const noTable = snapshot({
    foodLevel: 5,
    inventoryItemCounts: {},
    inventoryCraftingTableCount: 0,
    craftingTableInReach: false,
    opportunityDiscoveries: [village, hay],
  });
  observe(coordinator, noTable, { defaultObjective: 'EAT' });
  const retained = coordinator.latestDecision('instance:a');
  assert.equal(retained.shouldSwitch, false,
    'run-start hay cannot claim food value when bread crafting would strand it');

  observe(coordinator, {
    ...noTable,
    inventoryItemCounts: {
      'minecraft:crafting_table': 1,
      'minecraft:dirt': 12,
      'mission:world_uuid_command_route_action_x_123_y_64_z_789': 1,
    },
    inventoryCraftingTableCount: 1,
  }, { defaultObjective: 'EAT' });
  const ready = coordinator.latestDecision('instance:a');
  assert.equal(ready.shouldSwitch, true,
    'an authoritative material change must re-evaluate the same village');
  assert.deepEqual(ready.recommendation.opportunityIds, [village.id]);

  const lootCoordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  const chest = discovery({
    id: 'container:table-independent',
    type: 'container',
    x: 13,
    contentsKnown: true,
    items: { 'minecraft:iron_pickaxe': 1 },
  });
  observe(lootCoordinator, snapshot({
    foodLevel: 20,
    inventoryItemCounts: {},
    inventoryCraftingTableCount: 0,
    craftingTableInReach: false,
    opportunityDiscoveries: [village, hay, chest],
  }), { defaultObjective: 'DESCEND' });
  const loot = lootCoordinator.latestDecision('instance:a');
  assert.equal(loot.shouldSwitch, true,
    'known non-hay loot retains value independently of bread readiness');
  assert.deepEqual(loot.recommendation.opportunityIds, [village.id]);
});

test('an origin-only nearby table cannot authorize remote hay conversion', () => {
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  const village = discovery({ id: 'village:remote-table' });
  const hay = discovery({ id: 'hay:remote-table', type: 'hay', x: 14, count: 3 });
  const originOnly = snapshot({
    foodLevel: 5,
    craftingTableInReach: true,
    inventoryCraftingTableCount: 0,
    inventoryItemCounts: {},
    opportunityDiscoveries: [village, hay],
  });
  observe(coordinator, originOnly, { defaultObjective: 'EAT' });
  assert.equal(coordinator.latestDecision('instance:a').shouldSwitch, false,
    'a table beside the origin does not travel with the player');

  observe(coordinator, {
    ...originOnly,
    opportunityDiscoveries: [{
      ...village,
      signals: [...village.signals, 'destination_crafting_table_verified'],
    }, hay],
  }, { defaultObjective: 'EAT' });
  assert.equal(coordinator.latestDecision('instance:a').shouldSwitch, true,
    'an exact code-owned destination-table proof may authorize the remote conversion');
});

test('default-cost village composites subsume nearby value members without hiding standalone resources', () => {
  const cases = [
    {
      name: 'adjacent_hay_empty',
      snapshot: {
        foodLevel: 5,
        inventoryItemCounts: { 'minecraft:crafting_table': 1 },
        inventoryCraftingTableCount: 1,
      },
      members: [
        discovery({
          id: 'container:empty', type: 'container', x: 13,
          contentsKnown: true, items: {},
        }),
        discovery({ id: 'hay:food', type: 'hay', x: 14, count: 3 }),
      ],
      expectedMembers: ['container:empty', 'hay:food'],
    },
    {
      name: 'chest_pickaxe_ingots',
      snapshot: { foodLevel: 20 },
      members: [discovery({
        id: 'container:smith', type: 'container', x: 13,
        contentsKnown: true,
        items: { 'minecraft:iron_pickaxe': 1, 'minecraft:iron_ingot': 4 },
      })],
      expectedMembers: ['container:smith'],
    },
    {
      name: 'bed_hay',
      snapshot: {
        foodLevel: 5,
        inventoryItemCounts: { 'minecraft:crafting_table': 1 },
        inventoryCraftingTableCount: 1,
      },
      members: [
        discovery({ id: 'bed:white', type: 'bed', x: 13, count: 1 }),
        discovery({ id: 'hay:bed-food', type: 'hay', x: 14, count: 3 }),
      ],
      expectedMembers: ['bed:white', 'hay:bed-food'],
    },
  ];

  for (const fixture of cases) {
    const coordinator = createOpportunityShadowCoordinator({
      config: { mode: 'active', memoryRootDir: tempRoot() },
      emit: () => {},
      clock: () => 100,
    });
    const village = discovery({ id: `village:${fixture.name}` });
    const current = snapshot({
      ...fixture.snapshot,
      opportunityDiscoveries: [village, ...fixture.members],
    });
    observe(coordinator, current, { defaultObjective: fixture.snapshot.foodLevel <= 6 ? 'EAT' : 'DESCEND' });
    const decision = coordinator.latestDecision('instance:a');
    assert.equal(decision.shouldSwitch, true, fixture.name);
    assert.deepEqual(decision.recommendation.opportunityIds, [village.id], fixture.name);
    assert.equal(decision.selectedOpportunities[0].id, village.id, fixture.name);
    assert.deepEqual(
      decision.selectedOpportunities[0].aggregateMembers.map((entry) => entry.id),
      fixture.expectedMembers,
      fixture.name,
    );
  }

  const standalone = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  const loneHay = discovery({ id: 'hay:standalone', type: 'hay', x: 14, count: 3 });
  observe(standalone, snapshot({
    foodLevel: 5,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [loneHay],
  }), {
    defaultObjective: 'EAT',
  });
  assert.deepEqual(
    standalone.latestDecision('instance:a').recommendation.opportunityIds,
    ['hay:standalone'],
  );
});

test('remote code-owned village aggregates deferred members and charges deterministic member travel', () => {
  const run = (discoveries) => {
    const events = [];
    const delegate = new OpportunityRoutePlanner();
    let planResult = null;
    const coordinator = createOpportunityShadowCoordinator({
      config: { mode: 'active', memoryRootDir: tempRoot() },
      emit: (event) => events.push(event),
      clock: () => 100,
      planner: {
        plan(input) {
          planResult = delegate.plan(input);
          return planResult;
        },
      },
    });
    observe(coordinator, snapshot({
      foodLevel: 5,
      inventoryItemCounts: { 'minecraft:crafting_table': 1 },
      inventoryCraftingTableCount: 1,
      opportunityDiscoveries: discoveries,
    }), { defaultObjective: 'EAT' });
    return { decision: coordinator.latestDecision('instance:a'), events, planResult };
  };
  const village = registryDiscovery('village', {
    id: 'village:far-remote',
    x: 300,
    signals: ['route_reachable', 'hazard_free'],
    travelP75Seconds: 200,
  });
  const hay = registryDiscovery('hay', {
    id: 'hay:far-remote',
    x: 314,
    count: 1,
  });
  const chest = registryDiscovery('container', {
    id: 'container:far-unknown',
    x: 306,
    contentsKnown: false,
    estimatedItems: { 'minecraft:iron_pickaxe': 1 },
  });

  const forward = run([village, hay, chest]);
  const reverse = run([chest, hay, village]);
  for (const result of [forward, reverse]) {
    assert.equal(result.decision.reason, 'benefit_threshold_not_met');
    assert.equal(result.decision.shouldSwitch, false);
    const evaluated = result.events.find((event) => event.evt === 'opportunity.shadow.evaluated');
    assert.deepEqual(evaluated.consideredOpportunityIds, [village.id],
      'deferred members are admitted only through the village root');
    assert.equal(evaluated.rejectedOpportunityCount, 0,
      'fresh exact-executor-ready members are not rejected for origin-local access');
    const candidate = result.planResult.candidates.find((entry) => (
      entry.opportunityIds.length === 1 && entry.opportunityIds[0] === village.id
    ));
    assert.ok(candidate.costBreakdown.p75TravelExecutionSeconds > 288,
      'root travel plus ordered container→hay member travel is charged');
    const ledger = result.events.find((event) => event.evt === 'opportunity.ledger.summary');
    assert.equal(ledger.owned['minecraft:iron_pickaxe'], undefined);
    assert.equal(ledger.estimated['minecraft:iron_pickaxe'], undefined,
      'unknown remote contents have zero estimated value');
    assert.equal(ledger.deficit['mission:food_units'], 20,
      'estimated hay cannot satisfy the authoritative food deficit');
    assert.equal(ledger.estimatedCountedAsOwned, false);
  }
  assert.deepEqual(forward.decision.recommendation, reverse.decision.recommendation,
    'scanner candidate order cannot alter the bounded package result');
});

test('remote village aggregation vetoes hazardous or non-registry-ready members', () => {
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => 100,
  });
  const village = registryDiscovery('village', {
    id: 'village:remote-member-veto',
    x: 120,
    signals: ['route_reachable', 'hazard_free'],
  });
  const hazardous = registryDiscovery('hay', {
    id: 'hay:remote-hazard',
    x: 124,
    count: 9,
    signals: ['hazard_free', 'hazard'],
  });
  const unready = registryDiscovery('container', {
    id: 'container:remote-unready',
    x: 126,
    contentsKnown: true,
    items: { 'minecraft:iron_pickaxe': 1 },
    executorReady: false,
  });
  observe(coordinator, snapshot({
    foodLevel: 5,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [unready, village, hazardous],
  }), { defaultObjective: 'EAT' });

  const evaluated = events.find((event) => event.evt === 'opportunity.shadow.evaluated');
  assert.equal(evaluated.reason, 'benefit_threshold_not_met');
  assert.deepEqual(evaluated.consideredOpportunityIds, [village.id]);
  assert.deepEqual(evaluated.estimatedGain, {});
  assert.equal(events.some((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === hazardous.id && event.reason.startsWith('unsafe:')), true);
  assert.equal(events.some((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === unready.id && event.reason.startsWith('unsafe:')), true);
  const ledger = events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(ledger.owned['minecraft:iron_pickaxe'], undefined);
  assert.equal(ledger.deficit['minecraft:iron_pickaxe'], 1);
});

test('village composites exclude vertically remote members without poisoning the root', () => {
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => 100,
  });
  const village = registryDiscovery('village', {
    id: 'village:surface-root',
    x: 300,
    y: 149,
    confidence: 0.99,
    reliability: 0.99,
    signals: ['route_reachable', 'hazard_free'],
    travelP75Seconds: 200,
  });
  const undergroundHay = registryDiscovery('hay', {
    id: 'hay:natural-underground',
    x: 302,
    y: 72,
    count: 9,
    confidence: 0.5,
    reliability: 0.5,
  });
  observe(coordinator, snapshot({
    y: 149,
    foodLevel: 5,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [undergroundHay, village],
  }), { defaultObjective: 'EAT' });

  const evaluated = events.find((event) => event.evt === 'opportunity.shadow.evaluated');
  assert.equal(evaluated.reason, 'benefit_threshold_not_met');
  assert.deepEqual(evaluated.consideredOpportunityIds, [village.id],
    'the low-reliability underground member cannot lower the surface root reliability');
  assert.deepEqual(evaluated.estimatedGain, {});
  assert.equal(events.some((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === village.id && event.reason === 'reliability_below_baseline'), false);
  assert.equal(events.some((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === undergroundHay.id), true,
    'the excluded member remains an unready standalone discovery');
});

test('persisted container contents rank, physically admit, and are replaced by fresh inspection', () => {
  let now = 200;
  const rootDir = tempRoot();
  const scope = {
    worldId: 'world:a',
    dimension: 'minecraft:overworld',
    mission: 'iron_armor',
    persistenceEligible: true,
    identitySource: 'client_verified',
    persistenceReason: 'client_verified_world_identity',
  };
  const seed = new FabricWorldMemoryStore({ rootDir, clock: () => now });
  assert.equal(seed.loadSession({ scope }).ok, true);
  const inserted = seed.upsertContainer({
    id: 'container:persisted-smith',
    confidence: 0.98,
    lastSeen: 100,
    status: 'observed',
    details: {
      type: 'container',
      x: 13,
      y: 70,
      z: 0,
      count: 1,
      signals: ['access_proven', 'hazard_free', 'executor_ready'],
      safe: true,
      ready: true,
      feasible: true,
      contentsKnown: false,
      items: {},
    },
  });
  assert.equal(inserted.ok, true);
  assert.equal(seed.applyContainerInspectionReceipt({
    scope: { worldId: scope.worldId, dimension: scope.dimension, mission: scope.mission },
    containerId: 'container:persisted-smith',
    expectedContainerRevision: inserted.value.revision,
    commandId: 'seed-inspection',
    receiptId: 'seed-inspection:1',
    items: { 'minecraft:iron_pickaxe': 1 },
    inspectedAt: 150,
    status: 'inspected',
  }).ok, true);
  assert.equal(seed.flush().ok, true);

  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: rootDir },
    emit: () => {},
    clock: () => now,
  });
  const rawVillage = discovery({ id: 'village:persisted-smith', x: 12, observedAtMs: now });
  const rawUnknownChest = discovery({
    id: 'container:persisted-smith',
    type: 'container',
    x: 13,
    count: 1,
    contentsKnown: false,
    items: {},
    observedAtMs: now,
  });
  let current = snapshot({
    dimension: 'minecraft:overworld',
    onGround: true,
    health: 20,
    isDaytime: true,
    nearbyHostileCount: 0,
    opportunityDiscoveries: [rawVillage, rawUnknownChest],
  });
  observe(coordinator, current, { defaultObjective: 'DESCEND' });
  const activeDecision = coordinator.latestDecision('instance:a');
  assert.equal(activeDecision.shouldSwitch, true);
  assert.deepEqual(activeDecision.recommendation.opportunityIds, [rawVillage.id]);
  const selectedChest = activeDecision.selectedOpportunities[0].aggregateMembers
    .find((entry) => entry.id === rawUnknownChest.id);
  assert.equal(selectedChest.contentsKnown, true);
  assert.deepEqual(selectedChest.items, { 'minecraft:iron_pickaxe': 1 });

  const baseline = {
    objective: 'DESCEND',
    objectiveStartedAtMs: 100,
    objectiveFailures: 0,
    intent: { action: 'descend_staircase', commandId: 'mission-descend-1', missionObjective: 'DESCEND' },
  };
  const movedEvents = [];
  const moved = new VillageOpportunityTransactionController({ emit: (event) => movedEvents.push(event) });
  assert.equal(moved.maybeStart(activeDecision, {
    ...current,
    opportunityDiscoveries: [rawVillage, { ...rawUnknownChest, x: 14 }],
  }, baseline), null);
  assert.equal(movedEvents.at(-1).reason, 'aggregate_member_changed');

  const controller = new VillageOpportunityTransactionController({
    now: () => now,
    applyReceipt: (receipt) => coordinator.applyVillageReceipt('instance:a', receipt),
  });
  let intent = controller.maybeStart(activeDecision, current, baseline);
  assert.equal(intent.action, 'village_travel');

  function finish(result, overrides = {}) {
    const receipt = {
      commandId: intent.commandId,
      action: intent.action,
      opportunityId: intent.opportunityId,
      opportunityRevision: intent.opportunityRevision,
      detourId: intent.detourId,
      detourStageSeq: intent.detourStageSeq,
      stage: intent.opportunityStage,
      result,
      receiptId: `receipt:${intent.commandId}`,
      worldId: 'world:a',
      dimension: 'minecraft:overworld',
      mission: intent.opportunityMission,
      inventoryDelta: {},
      ...(overrides.receipt || {}),
    };
    current = {
      ...current,
      currentCommandCompleted: true,
      currentCommandId: intent.commandId,
      currentCommandCompletionReason: `${intent.action}_complete:opportunity_${result}`,
      villageOpportunityReceipt: receipt,
      ...overrides,
    };
    intent = controller.tick(current);
  }

  finish('arrived', { x: 12 });
  finish('verified');
  finish('arrived', { x: 13 });
  finish('verified');
  assert.equal(intent.action, 'village_inspect_container');
  finish('inspected', { receipt: { knownContainerContents: {} } });
  assert.equal(intent.action, 'stop');
  assert.equal(intent.opportunityStage, 'complete');

  now += 31_000;
  current = {
    ...current,
    currentCommandCompleted: false,
    currentCommandId: '',
    currentCommandCompletionReason: '',
    villageOpportunityReceipt: null,
    opportunityDiscoveries: [
      { ...rawVillage, observedAtMs: now },
      { ...rawUnknownChest, observedAtMs: now },
    ],
  };
  observe(coordinator, current, { defaultObjective: 'DESCEND' });
  const refreshed = coordinator.latestDecision('instance:a');
  assert.equal(refreshed.shouldSwitch, false);
  assert.equal(refreshed.selectedOpportunities.length, 0);
});

test('shadow mode is observational, provider-free, and always emits byte-equivalent baseline evidence', () => {
  let providerCalls = 0;
  const { coordinator, events } = harness({
    complete: () => { providerCalls += 1; throw new Error('provider forbidden'); },
  });
  const intent = { action: 'descend_staircase', commandId: 'mission:DESCEND:1' };
  const result = coordinator.observe('instance:a', snapshot(), {
    defaultObjective: 'DESCEND',
    appliedIntent: intent,
  });

  assert.equal(result, undefined);
  assert.equal(providerCalls, 0);
  const baseline = events.find((event) => event.evt === 'opportunity.shadow.baseline');
  assert.equal(baseline.choiceId, 'continue_baseline');
  assert.equal(baseline.byteEquivalent, true);
  assert.equal(baseline.behaviorApplied, false);
  assert.deepEqual(intent, { action: 'descend_staircase', commandId: 'mission:DESCEND:1' });
  assert.equal(events.some((event) => event.evt === 'opportunity.ledger.summary'), true);
  assert.equal(events.some((event) => event.evt === 'opportunity.shadow.evaluated'), true);
  assert.equal(events.some((event) => event.evt === 'opportunity.shadow.recommended'), false);
  const evaluated = events.find((event) => event.evt === 'opportunity.shadow.evaluated');
  assert.equal(evaluated.choiceId, 'continue_baseline');
  assert.equal(evaluated.estimatedCountedAsOwned, false);
  assert.ok(evaluated.costBreakdown);
  assert.ok(evaluated.bounds);
  assert.equal(evaluated.recommendationEligible, false);
  assert.equal(evaluated.selectedChoiceId, 'continue_baseline');
});

test('authoritative world-memory-ledger-discovery fingerprint deduplicates identical observations', () => {
  const { coordinator, events } = harness();
  const current = snapshot({
    foodLevel: 5,
    opportunityDiscoveries: [discovery({
      type: 'village_marker_cluster',
      signals: { hayBales: 18, villagers: 4 },
    })],
  });
  observe(coordinator, current);
  const afterFirst = events.length;
  observe(coordinator, {
    ...current,
    opportunityDiscoveries: [{ ...current.opportunityDiscoveries[0], observedAtMs: 9999 }],
  });
  assert.equal(events.length, afterFirst, 'identical authoritative fingerprint emits no duplicate evidence');
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.recorded').length, 1);

  observe(coordinator, {
    ...current,
    inventoryItemCounts: { 'minecraft:raw_iron': 1 },
  });
  assert.ok(events.length > afterFirst, 'authoritative inventory change triggers a fresh shadow evaluation');
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.recorded').length, 1,
    'unchanged discovery is not re-ingested when only the ledger changes');
});

test('active decisions are stance-cell bound without subcell jitter churn', () => {
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => 100,
  });
  const current = snapshot({
    x: 0.1,
    y: 70.2,
    z: 0.1,
    opportunityDiscoveries: [discovery()],
  });
  observe(coordinator, current);
  const first = coordinator.latestDecision('instance:a');
  const evaluatedAfterFirst = events.filter((event) => event.evt === 'opportunity.shadow.evaluated').length;
  assert.deepEqual(first.admissionPosition, { x: 0, y: 70, z: 0 });

  observe(coordinator, { ...current, x: 0.99, y: 70.99, z: 0.99 });
  assert.equal(coordinator.latestDecision('instance:a'), first);
  assert.equal(events.filter((event) => event.evt === 'opportunity.shadow.evaluated').length,
    evaluatedAfterFirst);

  observe(coordinator, { ...current, x: 1.01 });
  const moved = coordinator.latestDecision('instance:a');
  assert.notEqual(moved.decisionId, first.decisionId);
  assert.deepEqual(moved.admissionPosition, { x: 1, y: 70, z: 0 });
  assert.equal(events.filter((event) => event.evt === 'opportunity.shadow.evaluated').length,
    evaluatedAfterFirst + 1);
});

test('world, dimension, mission, and absent-world session scopes remain isolated', () => {
  const { coordinator, events } = harness();
  const seen = discovery({ type: 'exposed_iron', id: 'ore:same', count: 3 });
  observe(coordinator, snapshot({ worldIdentity: 'world:a', opportunityDiscoveries: [seen] }));
  observe(coordinator, snapshot({ worldIdentity: 'world:b', opportunityDiscoveries: [seen] }));
  coordinator.observe('session:one', snapshot({
    worldIdentity: null,
    worldPersistenceEligible: false,
    opportunityDiscoveries: [],
  }), {
    defaultObjective: 'DESCEND',
  });
  coordinator.observe('session:two', snapshot({
    worldIdentity: null,
    worldPersistenceEligible: false,
    opportunityDiscoveries: [],
  }), {
    defaultObjective: 'DESCEND',
  });

  const recorded = events.filter((event) => event.evt === 'opportunity.discovery.recorded');
  assert.deepEqual(recorded.map((event) => event.worldId).sort(), ['world:a', 'world:b']);
  const baselines = events.filter((event) => event.evt === 'opportunity.shadow.baseline');
  assert.ok(baselines.some((event) => event.worldId === 'session:session:one'));
  assert.ok(baselines.some((event) => event.worldId === 'session:session:two'));
  assert.equal(baselines.every((event) => event.dimension === 'minecraft:overworld'), true);
});

test('persistent same-world observers share one store without stale overwrites', () => {
  const rootDir = tempRoot();
  const events = [];
  let storesCreated = 0;
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'shadow', memoryRootDir: rootDir },
    clock: () => 100,
    emit: (event) => events.push(event),
    createMemoryStore: (scope) => {
      storesCreated += 1;
      return new FabricWorldMemoryStore({ rootDir, scope, clock: () => 100 });
    },
  });
  coordinator.observe('instance:a', snapshot({
    opportunityDiscoveries: [discovery({ id: 'ore:from-a', type: 'exposed_iron', count: 1 })],
  }), { defaultObjective: 'DESCEND' });
  coordinator.observe('instance:b', snapshot({
    opportunityDiscoveries: [discovery({ id: 'ore:from-b', type: 'exposed_iron', count: 2 })],
  }), { defaultObjective: 'DESCEND' });
  assert.equal(storesCreated, 1);
  const secondLedger = events.filter((event) => event.evt === 'opportunity.ledger.summary'
    && event.instanceId === 'instance:b').at(-1);
  assert.equal(secondLedger.discoveryCount, 2);
  assert.equal(coordinator.reset('instance:a').cleared, 1);
  coordinator.observe('instance:b', snapshot({ opportunityDiscoveries: [] }), { defaultObjective: 'DESCEND' });
  assert.equal(storesCreated, 1, 'detaching one observer must not destroy shared persistent memory');

  coordinator.observe('session:a', snapshot({
    worldIdentity: null,
    worldPersistenceEligible: false,
    opportunityDiscoveries: [discovery({ id: 'ore:session-a', type: 'exposed_iron', count: 1 })],
  }), { defaultObjective: 'DESCEND' });
  coordinator.observe('session:b', snapshot({
    worldIdentity: null,
    worldPersistenceEligible: false,
    opportunityDiscoveries: [],
  }), { defaultObjective: 'DESCEND' });
  const sessionBLedger = events.filter((event) => event.evt === 'opportunity.ledger.summary'
    && event.instanceId === 'session:b').at(-1);
  assert.equal(sessionBLedger.discoveryCount, 0);
});

test('one scanner observation batch performs one memory transaction and never legacy-ingests', () => {
  const rootDir = tempRoot();
  let batchCalls = 0;
  let legacyCalls = 0;
  let commits = 0;
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'shadow', memoryRootDir: rootDir },
    clock: () => 100,
    createMemoryStore: (scope) => {
      const store = new FabricWorldMemoryStore({ rootDir, scope, clock: () => 100 });
      const batch = store.ingestDiscoveriesBatch.bind(store);
      const legacy = store.ingestDiscovery.bind(store);
      const commit = store._commit.bind(store);
      store.ingestDiscoveriesBatch = (...args) => { batchCalls += 1; return batch(...args); };
      store.ingestDiscovery = (...args) => { legacyCalls += 1; return legacy(...args); };
      store._commit = (...args) => { commits += 1; return commit(...args); };
      return store;
    },
  });
  const intent = { action: 'descend_staircase', commandId: 'mission:DESCEND:batch' };
  const discoveries = Array.from({ length: 32 }, (_, index) => discovery({
    id: `ore:batch:${index}`,
    type: 'exposed_iron',
    count: 1,
  }));
  const started = performance.now();
  const result = coordinator.observe('instance:a', snapshot({ opportunityDiscoveries: discoveries }), {
    defaultObjective: 'DESCEND',
    appliedIntent: intent,
  });
  assert.equal(result, undefined);
  assert.deepEqual(intent, { action: 'descend_staircase', commandId: 'mission:DESCEND:batch' });
  assert.equal(batchCalls, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(commits, 1);
  assert.ok(performance.now() - started < 250, 'bounded shadow ingestion must not stall physical intent');
});

test('dedicated opportunityDiscoveries are used and legacy strategicDiscoveries stay isolated', () => {
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    strategicDiscoveries: [discovery({ id: 'legacy:paid-router' })],
    opportunityDiscoveries: [],
  }));
  assert.equal(events.some((event) => event.evt === 'opportunity.discovery.recorded'), false);
  const ledger = events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(ledger.discoveryCount, 0);
});

test('actual wire village and hay remain observable but unready before the executors exist', () => {
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    foodLevel: 5,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [
      {
        stableId: 'village:near',
        type: 'VILLAGE_MARKER_CLUSTER',
        dimensionIdentity: 'minecraft:overworld',
        anchor: { x: 12, y: 70, z: 0 },
        memberCount: 8,
        confidence: 0.98,
        status: 'verified',
        signals: ['bell', 'job_site', 'villager', 'marker_count:8'],
        readinessSource: 'code_owned_registry_v1',
        capabilityId: '',
        executorId: '',
        executorReady: false,
        readinessReason: 'phase_executor_unavailable',
        observedAtMs: 100,
        reliability: 0.98,
        failureUpperBound: 0.01,
        travelP75Seconds: 8,
        executionP75Seconds: 20,
        uncertaintyPenaltySeconds: 2,
      },
      {
        stableId: 'hay:near',
        type: 'HAY',
        dimensionIdentity: 'minecraft:overworld',
        anchor: { x: 14, y: 70, z: 1 },
        memberCount: 18,
        confidence: 0.99,
        status: 'verified',
        signals: ['kind:hay_bale', 'accessible', 'access_proven', 'hazard_free'],
        readinessSource: 'code_owned_registry_v1',
        capabilityId: '',
        executorId: '',
        executorReady: false,
        readinessReason: 'phase_executor_unavailable',
        observedAtMs: 100,
        reliability: 0.99,
        failureUpperBound: 0.01,
        travelP75Seconds: 9,
        executionP75Seconds: 20,
        uncertaintyPenaltySeconds: 1,
      },
    ],
  }));

  const recorded = events.find((event) => event.evt === 'opportunity.discovery.recorded'
    && event.discoveryId === 'village:near');
  assert.equal(recorded.type, 'village');
  assert.equal(recorded.executorReady, false);
  const hayRecorded = events.find((event) => event.evt === 'opportunity.discovery.recorded'
    && event.discoveryId === 'hay:near');
  assert.equal(hayRecorded.observedAccessProven, true);
  assert.equal(hayRecorded.observedHazardFree, true);
  assert.equal(hayRecorded.executorReady, false);
  const recommendation = events.find((event) => event.evt === 'opportunity.shadow.recommended');
  assert.equal(recommendation, undefined);
  const rejection = events.find((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === 'hay:near' && event.stage === 'planner_admission');
  assert.equal(rejection.type, 'hay');
  assert.equal(rejection.reason, 'unready:executor_unready');
  const ledger = events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(ledger.owned['mission:fed'], undefined);
  assert.equal(ledger.deficit['mission:food_units'], 20);
  assert.equal(ledger.estimatedCountedAsOwned, false);
});

test('admission requires code-owned route, hazard, executor, and golem-defense proofs', () => {
  const cases = [
    { id: 'hay:accessible', signals: ['accessible', 'hazard_free'], reason: 'unsafe:access_unproven' },
    { id: 'hay:no-hazard-proof', signals: ['access_proven', 'executor_ready'], reason: 'unsafe:hazard_clearance_unproven' },
    { id: 'hay:no-executor', signals: ['route_reachable', 'hazard_free'], reason: 'unready:executor_unready' },
    { id: 'hay:hazard', signals: ['access_proven', 'hazard_free', 'executor_ready', 'hazard'], reason: 'unsafe:hazard_veto' },
    {
      id: 'golem:no-defense',
      type: 'iron_golem',
      signals: ['access_proven', 'hazard_free'],
      readinessSource: 'code_owned_registry_v1',
      capabilityId: 'village_golem_iron',
      executorId: 'village_defeat_iron_golem',
      executorReady: true,
      reason: 'unready:defense_unready',
    },
  ];
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    foodLevel: 5,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [
      ...cases.map((entry) => discovery({
        type: 'hay',
        count: 9,
        safe: true,
        ready: true,
        feasible: true,
        ...entry,
      })),
      discovery({
        id: 'hay:ready',
        type: 'hay',
        count: 9,
        signals: ['route_reachable', 'hazard_free', 'executor_ready'],
      }),
    ],
  }));
  for (const entry of cases) {
    const rejected = events.find((event) => event.evt === 'opportunity.discovery.rejected'
      && event.discoveryId === entry.id && event.stage === 'planner_admission');
    assert.equal(rejected?.reason, entry.reason, entry.id);
  }
  const recommendation = events.find((event) => event.evt === 'opportunity.shadow.recommended');
  assert.deepEqual(recommendation?.opportunityIds, ['hay:ready']);
});

test('active iron-golem decisions require registry defense proof and remain standalone', () => {
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: (event) => events.push(event),
    clock: () => 100,
  });
  const opaqueGolemId = 'iron_golem:9f0a8b7c';
  observe(coordinator, snapshot({
    missionGoal: 'iron_pickaxe_only',
    foodLevel: 5,
    inventoryLogCount: 5,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [
      registryDiscovery('iron_golem', {
        id: opaqueGolemId,
        x: 5,
        count: 1,
        confidence: 1,
        reliability: 1,
        failureUpperBound: 0,
        travelP75Seconds: 5,
        executionP75Seconds: 10,
        uncertaintyPenaltySeconds: 0,
        signals: ['access_proven', 'hazard_free', 'defense_ready'],
      }),
      registryDiscovery('hay', {
        id: 'hay:near-golem',
        x: 6,
        count: 9,
        signals: ['access_proven', 'hazard_free'],
      }),
    ],
  }), { defaultObjective: 'MINE_IRON' });

  const decision = coordinator.latestDecision('instance:a');
  assert.equal(decision.shouldSwitch, true);
  assert.deepEqual(decision.recommendation.opportunityIds, [opaqueGolemId]);
  assert.equal(decision.recommendation.estimatedGain['minecraft:iron_ingot'], 4);
  assert.equal(decision.recommendation.estimatedGain['mission:iron_units'], 4);
  assert.equal(decision.ledger.owned['minecraft:iron_ingot'], undefined);
  assert.equal(decision.ledger.deficit['minecraft:iron_pickaxe'], 1,
    'expected yield can rank the shortcut but cannot satisfy the authoritative postcondition');
  assert.equal(decision.selectedOpportunities.length, 1);
  assert.equal(decision.selectedOpportunities[0].type, 'iron_golem');
  assert.equal(JSON.stringify(decision).includes('UUID'), false,
    'brain decision carries only the scanner-issued opaque opportunity id');

  const recorded = events.find((event) => event.evt === 'opportunity.discovery.recorded'
    && event.discoveryId === opaqueGolemId);
  assert.equal(recorded.capabilityId, 'village_golem_iron');
  assert.equal(recorded.executorId, 'village_defeat_iron_golem');
});

test('iron-golem executor_ready signals cannot replace code-owned registry proof', () => {
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    opportunityDiscoveries: [discovery({
      id: 'iron_golem:legacy-signal',
      type: 'iron_golem',
      count: 1,
      signals: ['access_proven', 'hazard_free', 'defense_ready', 'executor_ready'],
    })],
  }), { defaultObjective: 'MINE_IRON' });
  const rejected = events.find((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === 'iron_golem:legacy-signal'
    && event.stage === 'planner_admission');
  assert.equal(rejected?.reason, 'unready:executor_unready');
});

test('unchanged discovery rejections emit once across command and cell churn, then re-emit after recovery', () => {
  const { coordinator, events } = harness();
  const unready = discovery({
    id: 'hay:transition-dedupe',
    type: 'hay',
    count: 9,
    signals: ['access_proven', 'hazard_free'],
  });
  const current = (entry, x, commandId) => observe(coordinator, snapshot({
    x,
    foodLevel: 5,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: entry ? [entry] : [],
  }), {
    defaultObjective: 'EAT',
    appliedIntent: {
      action: 'gather_tree',
      commandId,
      missionObjective: 'EAT',
      reason: 'settle churn',
    },
  });

  current(unready, 0, 'mission:EAT:settle-1');
  current(unready, 1, 'mission:EAT:settle-2');
  current(unready, 2, 'mission:EAT:settle-3');
  assert.equal(events.filter((event) => event.evt === 'opportunity.shadow.evaluated').length, 3);
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === unready.id && event.stage === 'planner_admission').length, 1);

  current({ ...unready, signals: ['access_proven', 'hazard_free', 'executor_ready'] }, 3,
    'mission:EAT:ready');
  current(unready, 4, 'mission:EAT:settle-4');
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === unready.id && event.stage === 'planner_admission').length, 2);

  coordinator.reset('instance:a');
  current(unready, 5, 'mission:EAT:settle-5');
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === unready.id && event.stage === 'planner_admission').length, 3);
});

test('normalization rejection telemetry is transition-deduplicated before planner fingerprinting', () => {
  const { coordinator, events } = harness();
  const invalid = { id: '../bad', type: 'village' };
  observe(coordinator, snapshot({ opportunityDiscoveries: [invalid] }));
  observe(coordinator, snapshot({ x: 1, opportunityDiscoveries: [invalid] }), {
    appliedIntent: { action: 'descend_staircase', commandId: 'mission:DESCEND:2' },
  });
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.rejected'
    && event.reason === 'invalid_id').length, 1);

  observe(coordinator, snapshot({ x: 2, opportunityDiscoveries: [] }));
  observe(coordinator, snapshot({ x: 3, opportunityDiscoveries: [invalid] }));
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.rejected'
    && event.reason === 'invalid_id').length, 2);
});

test('live readiness accepts only registry-matched local executors and stamped false wins over signals', () => {
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    opportunityDiscoveries: [
      discovery({
        id: 'ore:live-ready',
        type: 'exposed_iron',
        count: 3,
        signals: ['access_proven', 'hazard_free'],
        readinessSource: 'code_owned_registry_v1',
        capabilityId: 'local_exposed_iron',
        executorId: 'mine_nearby_iron',
        executorReady: true,
        readinessReason: 'code_owned_executor_ready',
      }),
      discovery({
        id: 'coal:no-tool',
        type: 'exposed_coal',
        signals: ['access_proven', 'hazard_free', 'executor_ready'],
        readinessSource: 'code_owned_registry_v1',
        capabilityId: 'local_exposed_coal',
        executorId: 'mine_nearby_coal',
        executorReady: false,
        readinessReason: 'required_tool_unavailable',
      }),
      discovery({
        id: 'hay:spoofed',
        type: 'hay',
        count: 9,
        signals: ['access_proven', 'hazard_free', 'executor_ready'],
        readinessSource: 'code_owned_registry_v1',
        capabilityId: 'local_exposed_iron',
        executorId: 'mine_nearby_iron',
        executorReady: true,
        readinessReason: 'code_owned_executor_ready',
      }),
    ],
  }));

  const ready = events.find((event) => event.evt === 'opportunity.discovery.recorded'
    && event.discoveryId === 'ore:live-ready');
  assert.equal(ready.executorReady, true);
  const readyRejection = events.find((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === 'ore:live-ready' && event.stage === 'planner_admission');
  assert.equal(readyRejection, undefined);

  for (const id of ['coal:no-tool', 'hay:spoofed']) {
    const rejected = events.find((event) => event.evt === 'opportunity.discovery.rejected'
      && event.discoveryId === id && event.stage === 'planner_admission');
    assert.equal(rejected?.reason, 'unready:executor_unready', id);
  }
});

test('semantic observations coalesce, refresh at thirty seconds, and stale tiers reevaluate once', () => {
  let now = 1_000;
  const rootDir = tempRoot();
  let store;
  const events = [];
  const coordinator = createOpportunityShadowCoordinator({
    config: {
      mode: 'shadow',
      memoryRootDir: rootDir,
      freshnessRefreshMs: 30_000,
      freshnessPenaltyMs: 120_000,
      freshnessRejectMs: 300_000,
    },
    clock: () => now,
    emit: (event) => events.push(event),
    createMemoryStore: (scope) => {
      store = new FabricWorldMemoryStore({ rootDir, scope, clock: () => now });
      return store;
    },
  });
  const seen = discovery({ id: 'hay:fresh', type: 'hay', count: 9, observedAtMs: undefined });
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [seen] }));
  const semanticRevision = store.snapshot().revision;
  const firstEventCount = events.length;

  now += 5_000;
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [seen] }));
  assert.equal(events.length, firstEventCount);
  assert.equal(store.snapshot().revision, semanticRevision);
  assert.equal(store.get('resourcePatches', seen.id).lastSeen, 1_000);

  now = 31_000;
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [seen] }));
  assert.equal(store.snapshot().revision, semanticRevision);
  assert.equal(store.get('resourcePatches', seen.id).revision, 1);
  assert.equal(store.get('resourcePatches', seen.id).lastSeen, 31_000);
  assert.equal(events.filter((event) => event.evt === 'opportunity.discovery.refreshed').length, 1);

  now = 31_001;
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [] }));
  const evaluationsBeforeAging = events.filter((event) => event.evt === 'opportunity.shadow.evaluated').length;
  now = 151_001;
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [] }));
  const agingEvaluations = events.filter((event) => event.evt === 'opportunity.shadow.evaluated').length;
  assert.equal(agingEvaluations, evaluationsBeforeAging + 1);
  now += 1_000;
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [] }));
  assert.equal(events.filter((event) => event.evt === 'opportunity.shadow.evaluated').length, agingEvaluations);

  now = 331_001;
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [] }));
  const stale = events.findLast((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === seen.id && event.stage === 'planner_admission');
  assert.equal(stale.reason, 'stale_observation');
  assert.equal(stale.freshness, 'stale');
});

test('invalidated and disappeared observations immediately lose ledger and planner value', () => {
  let now = 100;
  const { coordinator, events } = harness({ clock: () => now });
  const seen = discovery({ id: 'hay:vanishing', type: 'hay', count: 9 });
  observe(coordinator, snapshot({ foodLevel: 5, opportunityDiscoveries: [seen] }));
  assert.equal(events.findLast((event) => event.evt === 'opportunity.ledger.summary')
    .opportunity['minecraft:hay_block'], 9);

  now += 1;
  observe(coordinator, snapshot({
    foodLevel: 5,
    opportunityDiscoveries: [{ ...seen, observedAtMs: now, status: 'invalidated' }],
  }));
  assert.equal(events.findLast((event) => event.evt === 'opportunity.ledger.summary')
    .opportunity['minecraft:hay_block'], undefined);
  assert.equal(events.findLast((event) => event.evt === 'opportunity.discovery.rejected'
    && event.discoveryId === seen.id)?.reason, 'stale_observation');

  now += 1;
  observe(coordinator, snapshot({
    foodLevel: 5,
    opportunityDiscoveries: [{ ...seen, observedAtMs: now, status: 'disappeared' }],
  }));
  assert.equal(events.findLast((event) => event.evt === 'opportunity.ledger.summary')
    .opportunity['minecraft:hay_block'], undefined);
});

test('far, unsafe, empty-container, and invalid opportunities remain on baseline', () => {
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    foodLevel: 5,
    opportunityDiscoveries: [
      discovery({ id: 'village:far', signals: { hayBales: 18 }, travelP75Seconds: 1500 }),
      discovery({ id: 'village:unsafe', safe: false, signals: { hayBales: 18 } }),
      discovery({
        id: 'chest:unknown',
        type: 'container',
        contentsKnown: false,
        estimatedItems: { iron_pickaxe: 1 },
      }),
      { id: '../bad', type: 'village' },
    ],
  }));

  assert.equal(events.some((event) => event.evt === 'opportunity.shadow.recommended'), false);
  assert.equal(events.some((event) => event.evt === 'opportunity.discovery.rejected'
    && event.reason === 'invalid_id'), true);
  const ledger = events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(ledger.opportunity['minecraft:iron_pickaxe'], undefined);
  assert.equal(ledger.estimated['minecraft:iron_pickaxe'], undefined);
  const evaluated = events.find((event) => event.evt === 'opportunity.shadow.evaluated');
  assert.equal(evaluated.choiceId, 'continue_baseline');
  assert.equal(evaluated.rejectedOpportunities.some((entry) => entry.id === 'village:unsafe'), true);
});

test('evaluated telemetry bounds rejection details while retaining exact aggregate counts', () => {
  const { coordinator, events } = harness();
  const rejected = Array.from({ length: 24 }, (_, index) => discovery({
    id: `village:unsafe:${String(index).padStart(2, '0')}`,
    safe: false,
    signals: { hayBales: 18 },
  }));
  observe(coordinator, snapshot({
    foodLevel: 5,
    opportunityDiscoveries: rejected,
  }));

  const evaluated = events.find((event) => event.evt === 'opportunity.shadow.evaluated');
  assert.equal(evaluated.rejectedOpportunityCount, 24);
  assert.equal(evaluated.rejectedOpportunities.length, 8);
  assert.equal(
    Object.values(evaluated.rejectedOpportunityReasonCounts)
      .reduce((sum, value) => sum + value, 0),
    24,
  );
});

test('known loot, partial iron, golem minimum, and exposed iron remain estimates until pickup', () => {
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    foodLevel: 20,
    opportunityDiscoveries: [
      discovery({
        id: 'chest:smith',
        type: 'container',
        contentsKnown: true,
        items: { iron_pickaxe: 1, iron_ingot: 2 },
      }),
      discovery({
        id: 'golem:uuid',
        type: 'iron_golem',
        count: 1,
        signals: ['access_proven', 'hazard_free', 'defense_ready'],
        readinessSource: 'code_owned_registry_v1',
        capabilityId: 'village_golem_iron',
        executorId: 'village_defeat_iron_golem',
        executorReady: true,
      }),
      discovery({
        id: 'ore:exposed',
        type: 'exposed_iron',
        count: 3,
      }),
    ],
  }));

  const ledger = events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(ledger.owned['minecraft:iron_pickaxe'], undefined);
  assert.equal(ledger.deficit['minecraft:iron_pickaxe'], 1);
  assert.equal(ledger.opportunity['minecraft:iron_pickaxe'], 1);
  assert.equal(ledger.opportunity['minecraft:iron_ingot'], 5, 'known two ingots plus golem minimum three');
  assert.equal(ledger.estimated['minecraft:iron_ingot'], 6, 'known two ingots plus golem expected four');
  assert.equal(ledger.opportunity['minecraft:raw_iron'], 3);
  assert.equal(ledger.estimatedCountedAsOwned, false);
  const evaluated = events.find((event) => event.evt === 'opportunity.shadow.evaluated');
  assert.equal(evaluated.authoritativeDeficit['minecraft:iron_pickaxe'], 1);
  assert.equal(evaluated.estimatedCountedAsOwned, false);
});

test('duplicate chest tools and armor cannot manufacture optimizer benefit', () => {
  const cases = [
    {
      name: 'duplicate-pickaxe',
      inventoryItemCounts: { 'minecraft:iron_pickaxe': 1 },
      snapshot: { inventoryIronPickaxeCount: 1 },
      chestItems: { 'minecraft:iron_pickaxe': 2 },
      expectedSwitch: false,
    },
    {
      name: 'duplicate-carried-helmet',
      inventoryItemCounts: {
        'minecraft:iron_pickaxe': 1,
        'minecraft:iron_helmet': 1,
      },
      snapshot: { inventoryIronPickaxeCount: 1 },
      chestItems: { 'minecraft:iron_helmet': 1 },
      expectedSwitch: false,
    },
    {
      name: 'duplicate-equipped-helmet',
      inventoryItemCounts: { 'minecraft:iron_pickaxe': 1 },
      snapshot: {
        inventoryIronPickaxeCount: 1,
        equippedHelmetItem: 'minecraft:iron_helmet',
      },
      chestItems: { 'minecraft:iron_helmet': 1 },
      expectedSwitch: false,
    },
    {
      name: 'missing-chestplate',
      inventoryItemCounts: { 'minecraft:iron_pickaxe': 1 },
      snapshot: {
        inventoryIronPickaxeCount: 1,
        equippedHelmetItem: 'minecraft:iron_helmet',
      },
      chestItems: { 'minecraft:iron_chestplate': 1 },
      expectedSwitch: true,
    },
  ];
  for (const fixture of cases) {
    const coordinator = createOpportunityShadowCoordinator({
      config: { mode: 'active', memoryRootDir: tempRoot() },
      emit: () => {},
      clock: () => 100,
    });
    const village = discovery({ id: `village:${fixture.name}` });
    const chest = discovery({
      id: `container:${fixture.name}`,
      type: 'container',
      x: 13,
      contentsKnown: true,
      items: fixture.chestItems,
    });
    observe(coordinator, snapshot({
      foodLevel: 20,
      ...fixture.snapshot,
      inventoryItemCounts: fixture.inventoryItemCounts,
      opportunityDiscoveries: [village, chest],
    }), { defaultObjective: 'MAKE_ARMOR' });
    assert.equal(coordinator.latestDecision('instance:a').shouldSwitch,
      fixture.expectedSwitch, fixture.name);
  }
});

test('village composite caps the same tool and armor slot across two containers', () => {
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    emit: () => {},
    clock: () => 100,
  });
  const village = discovery({ id: 'village:duplicate-containers' });
  const duplicatedItems = {
    'minecraft:iron_pickaxe': 1,
    'minecraft:iron_helmet': 1,
  };
  const containers = [13, 14].map((x, index) => discovery({
    id: `container:duplicate-${index}`,
    type: 'container',
    x,
    contentsKnown: true,
    items: duplicatedItems,
  }));
  observe(coordinator, snapshot({
    foodLevel: 20,
    opportunityDiscoveries: [village, ...containers],
  }), { defaultObjective: 'DESCEND' });
  const gain = coordinator.latestDecision('instance:a').recommendation.estimatedGain;
  assert.equal(gain['minecraft:iron_pickaxe'], 2,
    'exact chest contents remain truthful diagnostics');
  assert.equal(gain['minecraft:iron_helmet'], 2);
  assert.equal(gain['mission:equipped_iron_armor'], 1,
    'one equipment slot can advance at most once');
  assert.equal(gain['mission:iron_units'], 8,
    'one pickaxe and one helmet contribute only one non-recyclable mission value each');
});

test('plank reserve follows actual deterministic item ids', () => {
  const { coordinator, events } = harness();
  observe(coordinator, snapshot({
    inventoryItemCounts: {
      'minecraft:birch_planks': 4,
      'minecraft:spruce_planks': 5,
    },
    inventoryPlankCount: 9,
  }));
  const ledger = events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.deepEqual(ledger.reserved, {
    'minecraft:birch_planks': 4,
    'minecraft:spruce_planks': 2,
  });
  assert.equal(ledger.reserved['minecraft:oak_planks'], undefined);
});

test('stage reservations protect exact tools, fuel, food, and explicitly required later kit only', () => {
  const mining = harness();
  observe(mining.coordinator, snapshot({
    inventoryItemCounts: {
      'minecraft:crafting_table': 1,
      'minecraft:stick': 7,
      'minecraft:cobblestone': 9,
      'minecraft:birch_planks': 4,
      'minecraft:spruce_planks': 5,
      'minecraft:stone_pickaxe': 2,
      'minecraft:stone_sword': 1,
    },
    inventoryStonePickaxeTotalRemainingDurability: 211,
    inventoryPlankCount: 9,
  }), { defaultObjective: 'MINE_IRON' });
  const miningLedger = mining.events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.deepEqual(miningLedger.reserved, {
    'minecraft:birch_planks': 4,
    'minecraft:cobblestone': 3,
    'minecraft:crafting_table': 1,
    'minecraft:spruce_planks': 2,
    'minecraft:stick': 4,
    'minecraft:stone_pickaxe': 1,
    'minecraft:stone_sword': 1,
  });
  assert.deepEqual(miningLedger.reservationDiagnostics.pickaxe, {
    itemId: 'minecraft:stone_pickaxe',
    remainingDurability: 211,
  });
  assert.equal(miningLedger.reservationDiagnostics.viableToolSet, true);
  for (const [item, reserved] of Object.entries(miningLedger.reserved)) {
    assert.ok(reserved <= miningLedger.owned[item], item);
  }

  const smelt = harness();
  observe(smelt.coordinator, snapshot({
    inventoryItemCounts: {
      'minecraft:raw_iron': 3,
      'minecraft:coal': 2,
      'minecraft:oak_planks': 8,
      'minecraft:stone_pickaxe': 1,
      'minecraft:stone_sword': 1,
    },
    inventoryPlankCount: 8,
  }), { defaultObjective: 'SMELT_IRON' });
  const smeltLedger = smelt.events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(smeltLedger.reserved['minecraft:coal'], 1);
  assert.equal(smeltLedger.reserved['minecraft:oak_planks'], 6);
  assert.equal(smeltLedger.reservationDiagnostics.fuel.sourceClass, 'efficient');

  const hungry = harness();
  observe(hungry.coordinator, snapshot({
    foodLevel: 5,
    inventoryItemCounts: {
      'minecraft:bread': 3,
      'minecraft:white_bed': 1,
      'minecraft:white_wool': 4,
    },
  }), {
    defaultObjective: 'EAT',
    signals: { opportunityLaterKitRequirements: { 'minecraft:white_bed': 1, 'minecraft:white_wool': 3 } },
  });
  const hungryLedger = hungry.events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(hungryLedger.reserved['minecraft:bread'], 1);
  assert.equal(hungryLedger.reserved['minecraft:white_bed'], 1);
  assert.equal(hungryLedger.reserved['minecraft:white_wool'], 3);

  const defaultKit = harness();
  observe(defaultKit.coordinator, snapshot({
    inventoryItemCounts: {
      'minecraft:red_bed': 1,
      'minecraft:water_bucket': 1,
      'minecraft:flint_and_steel': 1,
      'minecraft:golden_boots': 1,
      'minecraft:golden_chestplate': 1,
      'minecraft:shield': 1,
      'minecraft:bow': 1,
      'minecraft:arrow': 23,
    },
  }), { defaultObjective: 'DESCEND' });
  const defaultKitLedger = defaultKit.events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.deepEqual(defaultKitLedger.reserved, {
    'minecraft:arrow': 16,
    'minecraft:bow': 1,
    'minecraft:flint_and_steel': 1,
    'minecraft:golden_boots': 1,
    'minecraft:red_bed': 1,
    'minecraft:shield': 1,
    'minecraft:water_bucket': 1,
  });
  assert.equal(defaultKitLedger.reserved['minecraft:golden_chestplate'], undefined,
    'one deterministic gold armor piece is sufficient');
  assert.equal(defaultKitLedger.reservationDiagnostics.laterKitSource, 'code_owned_default');
});

test('reset and shutdown clear coordinator-local session state without applying behavior', () => {
  const { coordinator } = harness();
  observe(coordinator, snapshot());
  assert.deepEqual(coordinator.reset('instance:a'), { cleared: 1 });
  observe(coordinator, snapshot());
  const stopped = coordinator.shutdown();
  assert.equal(stopped.flushed, 1);
  assert.equal(stopped.failed, 0);
});

test('OR/category mission predicates are projected as code-owned synthetic resources', () => {
  const planksSatisfied = harness();
  observe(planksSatisfied.coordinator, snapshot({
    inventoryLogCount: 0,
    inventoryPlankCount: 48,
  }), { defaultObjective: 'GATHER_WOOD' });
  const first = planksSatisfied.events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(first.owned['mission:wood_complete'], 1);
  assert.equal(first.deficit['mission:wood_complete'], undefined);

  const logsUnsatisfied = harness();
  observe(logsUnsatisfied.coordinator, snapshot({
    inventoryLogCount: 19,
    inventoryPlankCount: 47,
  }), { defaultObjective: 'GATHER_WOOD' });
  const second = logsUnsatisfied.events.find((event) => event.evt === 'opportunity.ledger.summary');
  assert.equal(second.owned['mission:wood_complete'], undefined);
  assert.equal(second.deficit['mission:wood_complete'], 1);
});

test('strategy catalogs cap executable choices at baseline plus seven nondominated opaque alternatives', () => {
  const discoveries = Array.from({ length: 9 }, (_, index) => discovery({
    id: `village:bounded-${index}`,
    x: 10 + index,
  }));
  const candidates = discoveries.map((entry, index) => syntheticStrategyCandidate(entry.id, {
    totalSeconds: 100 + index,
    p75TravelExecutionSeconds: 40 + index,
    baselineRemainingTimeSeconds: 60,
    reliability: 0.91 + (index * 0.009),
    failureUpperBound: 0.09 - (index * 0.009),
  }));
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    planner: syntheticStrategyPlanner(candidates),
    clock: () => 100,
  });
  coordinator.observe('instance:a', snapshot({ opportunityDiscoveries: discoveries }), {
    defaultObjective: 'DESCEND',
  });
  const payload = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'run_start', junctionRevision: 1, targetBoundaryGeneration: 1,
  }).publicPayload;
  assert.equal(payload.choices.length, 8);
  assert.deepEqual(payload.choices.map((entry) => entry.choiceId), [
    'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7',
  ]);
  assert.equal(payload.choices.filter((entry) => entry.kind === 'baseline').length, 1);
  assert.equal(JSON.stringify(payload).includes('village:bounded-'), false);
});

test('live admission rejects a materially slower disjoint choice but admits uncertainty-overlapping alternative', () => {
  const discoveries = ['best', 'overlap', 'slow'].map((name, index) => discovery({
    id: `village:${name}`,
    x: 10 + index,
  }));
  const candidates = [
    syntheticStrategyCandidate('village:best', {
      totalSeconds: 100,
      p75TravelExecutionSeconds: 40,
      baselineRemainingTimeSeconds: 60,
      reliability: 0.91,
      failureUpperBound: 0.09,
    }),
    syntheticStrategyCandidate('village:overlap', {
      totalSeconds: 145,
      p75TravelExecutionSeconds: 20,
      baselineRemainingTimeSeconds: 70,
      uncertaintyPenaltySeconds: 55,
      reliability: 0.99,
      failureUpperBound: 0.01,
    }),
    syntheticStrategyCandidate('village:slow', {
      totalSeconds: 145,
      p75TravelExecutionSeconds: 85,
      baselineRemainingTimeSeconds: 60,
      reliability: 0.93,
      failureUpperBound: 0.07,
    }),
  ];
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    planner: syntheticStrategyPlanner(candidates),
    clock: () => 100,
  });
  const current = snapshot({ opportunityDiscoveries: discoveries });
  coordinator.observe('instance:a', current, { defaultObjective: 'DESCEND' });
  const first = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'run_start', junctionRevision: 1, targetBoundaryGeneration: 1,
  });
  const byLowerBound = new Map(first.publicPayload.choices.map((choice) => [
    choice.risk.lowerBoundSeconds,
    choice.choiceId,
  ]));
  const rejected = coordinator.admitStrategyChoice('instance:a', {
    envelopeId: first.envelopeId,
    envelopeRevision: first.envelopeRevision,
    choiceId: byLowerBound.get(145),
  }, current, { boundaryGeneration: 1, defaultObjective: 'DESCEND' });
  assert.equal(rejected.reason, 'materially_slower_choice');

  const second = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'phase_transition', junctionRevision: 2, targetBoundaryGeneration: 2,
  });
  const overlap = second.publicPayload.choices.find((choice) => (
    choice.kind === 'opportunity'
      && choice.risk.lowerBoundSeconds === 90
      && choice.risk.upperBoundSeconds >= 100
  ));
  assert.ok(overlap);
  const admitted = coordinator.admitStrategyChoice('instance:a', {
    envelopeId: second.envelopeId,
    envelopeRevision: second.envelopeRevision,
    choiceId: overlap.choiceId,
  }, current, { boundaryGeneration: 2, defaultObjective: 'DESCEND' });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.outcome, 'opportunity');
  assert.deepEqual(admitted.decision.recommendation.opportunityIds, ['village:overlap']);
});

test('one-shot strategy admission accepts equivalent movement, returns an executable decision, and rejects replay', () => {
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    clock: () => 100,
  });
  const deterministicIntent = {
    action: 'descend_staircase',
    commandId: 'mission:DESCEND:strategy',
    missionObjective: 'EAT',
    reason: 'deterministic baseline',
  };
  const opportunities = [
    discovery({ id: 'village:strategy', travelP75Seconds: 0 }),
    discovery({ id: 'hay:strategy', type: 'hay', x: 14, count: 3, travelP75Seconds: 0 }),
  ];
  const current = snapshot({
    dimension: 'minecraft:overworld',
    foodLevel: 5,
    onGround: true,
    health: 20,
    isDaytime: true,
    nearbyHostileCount: 0,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: opportunities,
  });
  coordinator.observe('instance:a', current, {
    defaultObjective: 'EAT',
    appliedIntent: deterministicIntent,
  });
  const envelope = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'run_start',
    junctionRevision: 1,
    targetBoundaryGeneration: 1,
  });
  const opportunityChoice = envelope.publicPayload.choices.find((choice) => choice.kind === 'opportunity');
  assert.ok(opportunityChoice);

  const movedIntent = { ...deterministicIntent, commandId: 'mission:EAT:next-boundary' };
  const moved = { ...current, x: 1.2 };
  coordinator.observe('instance:a', moved, {
    defaultObjective: 'EAT',
    appliedIntent: movedIntent,
  });
  const admitted = coordinator.admitStrategyChoice('instance:a', {
    envelopeId: envelope.envelopeId,
    envelopeRevision: envelope.envelopeRevision,
    choiceId: opportunityChoice.choiceId,
  }, moved, {
    boundaryGeneration: 1,
    defaultObjective: 'EAT',
    deterministicIntent: movedIntent,
  });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.outcome, 'opportunity');
  assert.equal(admitted.kind, 'opportunity');
  assert.equal(admitted.decision.decisionSource, 'strategy_active_canary');
  assert.equal(admitted.decision.strategyEnvelopeId, envelope.envelopeId);
  assert.deepEqual(admitted.decision.recommendation.opportunityIds, ['village:strategy']);
  assert.equal(admitted.decision.admissionPosition.x, 1);

  const baseline = {
    objective: 'EAT',
    objectiveStartedAtMs: 100,
    objectiveFailures: 0,
    intent: deterministicIntent,
  };
  const transactionEvents = [];
  const transaction = new VillageOpportunityTransactionController({
    now: () => 100,
    emit: (event) => transactionEvents.push(event),
  });
  assert.equal(transaction.maybeStart(admitted.decision, moved, baseline)?.action, 'village_travel',
    JSON.stringify(transactionEvents.at(-1)));

  const replay = coordinator.admitStrategyChoice('instance:a', {
    envelopeId: envelope.envelopeId,
    envelopeRevision: envelope.envelopeRevision,
    choiceId: opportunityChoice.choiceId,
  }, moved, {
    boundaryGeneration: 1,
    defaultObjective: 'EAT',
    deterministicIntent,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'envelope_consumed');
});

test('strategy admission supports baseline, expires boundaries, and rejects stale authority', () => {
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    clock: () => 100,
  });
  const deterministicIntent = {
    action: 'descend_staircase',
    commandId: 'mission:DESCEND:baseline',
    missionObjective: 'DESCEND',
  };
  const current = snapshot({ onGround: true, health: 20 });
  coordinator.observe('instance:a', current, {
    defaultObjective: 'DESCEND',
    appliedIntent: deterministicIntent,
  });

  const baselineEnvelope = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'phase_transition', junctionRevision: 1, targetBoundaryGeneration: 2,
  });
  const baseline = coordinator.admitStrategyChoice('instance:a', {
    envelopeId: baselineEnvelope.envelopeId,
    envelopeRevision: baselineEnvelope.envelopeRevision,
    choiceId: 'c0',
  }, current, {
    boundaryGeneration: 2,
    defaultObjective: 'DESCEND',
    deterministicIntent,
  });
  assert.deepEqual(baseline, {
    ok: true,
    admitted: true,
    outcome: 'baseline',
    reason: 'baseline_selected',
    choiceId: 'c0',
    kind: 'baseline',
    decision: null,
  });

  const expired = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'repeated_failure', junctionRevision: 2, targetBoundaryGeneration: 3,
  });
  assert.deepEqual(coordinator.expireStrategyBoundary('instance:a', 3), { expired: 1 });
  assert.equal(coordinator.admitStrategyChoice('instance:a', {
    envelopeId: expired.envelopeId,
    envelopeRevision: expired.envelopeRevision,
    choiceId: 'c0',
  }, current, { boundaryGeneration: 3, defaultObjective: 'DESCEND' }).reason, 'envelope_expired');

  const staleBoundary = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'repeated_failure', junctionRevision: 3, targetBoundaryGeneration: 4,
  });
  assert.equal(coordinator.admitStrategyChoice('instance:a', {
    envelopeId: staleBoundary.envelopeId,
    envelopeRevision: staleBoundary.envelopeRevision,
    choiceId: 'c0',
  }, current, { boundaryGeneration: 5, defaultObjective: 'DESCEND' }).reason, 'stale_boundary');

  const staleObjective = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'phase_transition', junctionRevision: 4, targetBoundaryGeneration: 6,
  });
  assert.equal(coordinator.admitStrategyChoice('instance:a', {
    envelopeId: staleObjective.envelopeId,
    envelopeRevision: staleObjective.envelopeRevision,
    choiceId: 'c0',
  }, current, { boundaryGeneration: 6, defaultObjective: 'MINE_IRON' }).reason, 'stale_objective');

  const staleScope = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'phase_transition', junctionRevision: 5, targetBoundaryGeneration: 7,
  });
  assert.equal(coordinator.admitStrategyChoice('instance:a', {
    envelopeId: staleScope.envelopeId,
    envelopeRevision: staleScope.envelopeRevision,
    choiceId: 'c0',
  }, { ...current, worldIdentity: 'world:other' }, {
    boundaryGeneration: 7,
    defaultObjective: 'DESCEND',
  }).reason, 'stale_scope');

  const staleLedger = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'material_discovery_change', junctionRevision: 6, targetBoundaryGeneration: 8,
  });
  assert.equal(coordinator.admitStrategyChoice('instance:a', {
    envelopeId: staleLedger.envelopeId,
    envelopeRevision: staleLedger.envelopeRevision,
    choiceId: 'c0',
  }, { ...current, inventoryItemCounts: { 'minecraft:iron_pickaxe': 1 } }, {
    boundaryGeneration: 8,
    defaultObjective: 'DESCEND',
  }).reason, 'stale_ledger');
});

test('live strategy repricing rejects a formerly useful opportunity after movement makes it infeasible', () => {
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    clock: () => 100,
  });
  const current = snapshot({
    foodLevel: 5,
    onGround: true,
    inventoryItemCounts: { 'minecraft:crafting_table': 1 },
    inventoryCraftingTableCount: 1,
    opportunityDiscoveries: [
      discovery({ id: 'village:repriced', travelP75Seconds: 0 }),
      discovery({ id: 'hay:repriced', type: 'hay', x: 14, count: 3, travelP75Seconds: 0 }),
    ],
  });
  coordinator.observe('instance:a', current, { defaultObjective: 'EAT' });
  const envelope = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'run_start', junctionRevision: 1, targetBoundaryGeneration: 1,
  });
  const choiceId = envelope.publicPayload.choices.find((choice) => choice.kind === 'opportunity').choiceId;
  const result = coordinator.admitStrategyChoice('instance:a', {
    envelopeId: envelope.envelopeId,
    envelopeRevision: envelope.envelopeRevision,
    choiceId,
  }, { ...current, x: -10_000 }, {
    boundaryGeneration: 1,
    defaultObjective: 'EAT',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'choice_no_longer_feasible');
});

test('golem strategy payload exposes only code-owned kind and cost, never combat identity or mechanics', () => {
  const coordinator = createOpportunityShadowCoordinator({
    config: { mode: 'active', memoryRootDir: tempRoot() },
    clock: () => 100,
  });
  coordinator.observe('instance:a', snapshot({
    missionGoal: 'iron_pickaxe_only',
    inventoryLogCount: 5,
    opportunityDiscoveries: [registryDiscovery('iron_golem', {
      id: 'iron_golem:uuid-secret-1234',
      x: 5,
      count: 1,
      confidence: 1,
      reliability: 1,
      failureUpperBound: 0,
      travelP75Seconds: 5,
      executionP75Seconds: 10,
      uncertaintyPenaltySeconds: 0,
      signals: ['access_proven', 'hazard_free', 'defense_ready'],
    })],
  }), { defaultObjective: 'MINE_IRON' });
  const payload = coordinator.latestStrategyEnvelope('instance:a', {
    junctionType: 'material_discovery_change',
    junctionRevision: 1,
    targetBoundaryGeneration: 1,
  }).publicPayload;
  const golem = payload.choices.find((choice) => choice.kind === 'opportunity');
  assert.deepEqual(golem.opportunityKinds, ['iron_golem']);
  const wire = JSON.stringify(payload);
  for (const secret of [
    'iron_golem:uuid-secret-1234', 'pillar', 'attack', 'escape', 'combat', 'executor', 'capability',
  ]) assert.equal(wire.includes(secret), false, secret);
});
