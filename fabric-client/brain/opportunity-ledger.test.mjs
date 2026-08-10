import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_OPPORTUNITY_CAPABILITY_REGISTRY,
  createOpportunityCapabilityRegistry,
} from './opportunity-capabilities.js';
import {
  authoritativeRequirementSatisfied,
  createMissionResourceLedger,
  normalizeExactItemCounts,
  requirementSatisfied,
  resourceDeficit,
} from './opportunity-ledger.js';

function foodCapabilities(options = {}) {
  return createOpportunityCapabilityRegistry({
    readyExecutors: options.readyExecutors ?? ['craft_hay_to_wheat', 'craft_bread'],
    definitions: [
      {
        id: 'hay_to_wheat',
        executor: 'craft_hay_to_wheat',
        proven: options.hayProven ?? true,
        priority: 10,
        inputs: { hay_block: 1 },
        outputs: { wheat: 9 },
      },
      {
        id: 'wheat_to_bread',
        executor: 'craft_bread',
        proven: options.breadProven ?? true,
        priority: 20,
        inputs: { wheat: 3 },
        outputs: { bread: 1 },
      },
    ],
  });
}

test('exact inventory normalization aggregates all stacks and rejects malformed counts without rounding', () => {
  assert.deepEqual(normalizeExactItemCounts([
    { itemId: 'iron_ingot', count: 2 },
    { id: 'minecraft:iron_ingot', count: 3 },
    { item: 'Oak_Log', count: 4 },
    { itemId: 'minecraft:iron_ingot', count: 1.9 },
    { itemId: 'minecraft:diamond', count: -1 },
    { itemId: 'bad item', count: 64 },
  ]), {
    'minecraft:iron_ingot': 5,
    'minecraft:oak_log': 4,
  });
  assert.deepEqual(normalizeExactItemCounts(new Map([
    ['bread', 2],
    ['minecraft:wheat', 7],
  ])), {
    'minecraft:bread': 2,
    'minecraft:wheat': 7,
  });
  assert.throws(
    () => normalizeExactItemCounts([
      { itemId: 'stick', count: Number.MAX_SAFE_INTEGER },
      { itemId: 'stick', count: 1 },
    ]),
    /resource count overflow/,
  );
});

test('ledger exposes immutable direct maps and keeps authoritative deficit owned-only', () => {
  const ledger = createMissionResourceLedger({
    itemCounts: { iron_ingot: 1, stick: 5 },
    reservations: { stick: 4, iron_ingot: 9 },
    requirements: { iron_ingot: 4 },
    opportunities: [{
      id: 'ore:1',
      type: 'exposed_iron',
      verified: true,
      count: 3,
    }],
  });

  assert.deepEqual(ledger.owned, {
    'minecraft:iron_ingot': 1,
    'minecraft:stick': 5,
  });
  assert.deepEqual(ledger.reserved, {
    'minecraft:iron_ingot': 1,
    'minecraft:stick': 4,
  });
  assert.deepEqual(ledger.reservation.unmet, { 'minecraft:iron_ingot': 8 });
  assert.deepEqual(ledger.reservation.available, { 'minecraft:stick': 1 });
  assert.deepEqual(ledger.opportunity, { 'minecraft:raw_iron': 3 });
  assert.deepEqual(ledger.deficit, { 'minecraft:iron_ingot': 3 });
  assert.equal(authoritativeRequirementSatisfied(ledger), false);
  assert.equal(requirementSatisfied(ledger), false);
  assert.equal(resourceDeficit(ledger, 'iron_ingot'), 3);
  assert.throws(() => { ledger.owned['minecraft:iron_ingot'] = 99; }, TypeError);
  assert.throws(() => { ledger.reservation.available['minecraft:stick'] = 99; }, TypeError);
});

test('reservation conservation holds exactly and conversion cannot consume reserves', () => {
  const ledger = createMissionResourceLedger({
    itemCounts: { hay_block: 2, wheat: 2, stick: 6 },
    reservations: { hay_block: 1, stick: 4 },
    requirements: { bread: 3 },
    capabilities: foodCapabilities(),
  });

  for (const item of Object.keys(ledger.owned)) {
    assert.equal(
      (ledger.reserved[item] || 0) + (ledger.reservation.available[item] || 0),
      ledger.owned[item],
      `reservation conservation failed for ${item}`,
    );
  }
  assert.deepEqual(ledger.convertible, { 'minecraft:bread': 3 });
  assert.equal(ledger.conversion.projectedOwned['minecraft:hay_block'], 1);
  assert.equal(ledger.conversion.projectedOwned['minecraft:stick'], 6);
  assert.equal(ledger.conversion.projectedOwned['minecraft:bread'], 3);
  assert.equal(ledger.feasibility.convertibleCouldSatisfy, true);
  assert.deepEqual(ledger.deficit, { 'minecraft:bread': 3 });
  assert.equal(authoritativeRequirementSatisfied(ledger), false);

  for (const item of new Set([
    ...Object.keys(ledger.reservation.available),
    ...Object.keys(ledger.conversion.consumed),
    ...Object.keys(ledger.conversion.produced),
    ...Object.keys(ledger.conversion.projectedAvailable),
  ])) {
    assert.equal(
      (ledger.reservation.available[item] || 0)
        + (ledger.conversion.produced[item] || 0)
        - (ledger.conversion.consumed[item] || 0),
      ledger.conversion.projectedAvailable[item] || 0,
      `conversion conservation failed for ${item}`,
    );
  }
});

test('only explicitly proven recipes with ready executors become convertible', () => {
  const noRegistry = createMissionResourceLedger({
    itemCounts: { hay_block: 1 },
    requirements: { bread: 3 },
  });
  assert.equal(noRegistry.conversion.rejectedCapabilities, EMPTY_OPPORTUNITY_CAPABILITY_REGISTRY.rejected);
  assert.deepEqual(noRegistry.convertible, {});

  const forgedRegistry = createMissionResourceLedger({
    itemCounts: { hay_block: 1 },
    requirements: { wheat: 9 },
    capabilities: {
      capabilities: [{
        id: 'forged',
        executor: 'not_registered',
        inputs: { 'minecraft:hay_block': 1 },
        outputs: { 'minecraft:wheat': 9 },
        catalysts: {},
      }],
    },
  });
  assert.deepEqual(forgedRegistry.convertible, {}, 'callers cannot bypass registry proof/readiness');

  const notProven = foodCapabilities({ hayProven: false });
  assert.deepEqual(notProven.capabilities.map((value) => value.id), ['wheat_to_bread']);
  assert.equal(notProven.rejected.find((value) => value.id === 'hay_to_wheat').reason, 'recipe_not_proven');
  const noRecipeAuthority = createMissionResourceLedger({
    itemCounts: { hay_block: 1 },
    requirements: { bread: 3 },
    capabilities: notProven,
  });
  assert.deepEqual(noRecipeAuthority.convertible, {});

  const executorMissing = foodCapabilities({ readyExecutors: ['craft_hay_to_wheat'] });
  assert.deepEqual(executorMissing.capabilities.map((value) => value.id), ['hay_to_wheat']);
  assert.equal(executorMissing.rejected.find((value) => value.id === 'wheat_to_bread').reason, 'executor_not_ready');
  const noBreadExecutor = createMissionResourceLedger({
    itemCounts: { hay_block: 1 },
    requirements: { bread: 3 },
    capabilities: executorMissing,
  });
  assert.deepEqual(noBreadExecutor.convertible, { 'minecraft:wheat': 9 });
  assert.equal(noBreadExecutor.feasibility.convertibleCouldSatisfy, false);
});

test('hay to wheat to bread chain is represented as executable potential, never as owned food', () => {
  const ledger = createMissionResourceLedger({
    itemCounts: { hay_block: 1 },
    requirements: { bread: 3 },
    capabilities: foodCapabilities(),
  });
  assert.deepEqual(ledger.conversion.plan.map((step) => [step.capabilityId, step.batches]), [
    ['hay_to_wheat', 1],
    ['wheat_to_bread', 3],
  ]);
  assert.deepEqual(ledger.convertible, { 'minecraft:bread': 3 });
  assert.deepEqual(ledger.owned, { 'minecraft:hay_block': 1 });
  assert.deepEqual(ledger.deficit, { 'minecraft:bread': 3 });
  assert.equal(ledger.feasibility.convertibleCouldSatisfy, true);
  assert.equal(requirementSatisfied(ledger), false);

  const afterVerifiedCraft = createMissionResourceLedger({
    itemCounts: { bread: 3 },
    requirements: { bread: 3 },
    capabilities: foodCapabilities(),
  });
  assert.deepEqual(afterVerifiedCraft.deficit, {});
  assert.equal(requirementSatisfied(afterVerifiedCraft), true);
});

test('unknown chest has zero value until inspected and known contents remain unowned', () => {
  const unknown = createMissionResourceLedger({
    requirements: { iron_pickaxe: 1 },
    opportunities: [{
      id: 'chest:unknown',
      type: 'container',
      verified: true,
      estimatedItems: { iron_pickaxe: 1, diamond: 3 },
    }],
  });
  assert.deepEqual(unknown.opportunity, {});
  assert.deepEqual(unknown.estimated, {});
  assert.equal(unknown.opportunitySources[0].reason, 'unknown_contents');
  assert.equal(requirementSatisfied(unknown), false);

  const inspected = createMissionResourceLedger({
    requirements: { iron_pickaxe: 1 },
    opportunities: [{
      id: 'chest:known',
      type: 'container',
      verified: true,
      inspected: true,
      items: { iron_pickaxe: 1, iron_ingot: 2 },
    }],
  });
  assert.deepEqual(inspected.opportunity, {
    'minecraft:iron_ingot': 2,
    'minecraft:iron_pickaxe': 1,
  });
  assert.deepEqual(inspected.estimated, inspected.opportunity);
  assert.equal(inspected.feasibility.conservativeOpportunityCouldSatisfy, true);
  assert.deepEqual(inspected.deficit, { 'minecraft:iron_pickaxe': 1 });
  assert.equal(requirementSatisfied(inspected), false);
});

test('golem uses minimum three for feasibility and expected four only for ranking', () => {
  const ledger = createMissionResourceLedger({
    itemCounts: { iron_ingot: 1 },
    requirements: { iron_ingot: 5 },
    opportunities: [{
      id: 'golem:uuid-1',
      type: 'iron_golem',
      verified: true,
      feasible: true,
      count: 1,
    }],
  });
  assert.deepEqual(ledger.deficit, { 'minecraft:iron_ingot': 4 });
  assert.deepEqual(ledger.opportunity, { 'minecraft:iron_ingot': 3 });
  assert.deepEqual(ledger.estimated, { 'minecraft:iron_ingot': 4 });
  assert.equal(ledger.feasibility.conservativeOpportunityCouldSatisfy, false);
  assert.equal(ledger.feasibility.expectedOpportunityCouldSatisfy, true);
  assert.equal(ledger.feasibility.authoritativeSatisfied, false);
  assert.equal(requirementSatisfied(ledger), false);

  const unsafe = createMissionResourceLedger({
    requirements: { iron_ingot: 3 },
    opportunities: [{
      id: 'golem:unsafe',
      type: 'iron_golem',
      verified: true,
      feasible: false,
    }],
  });
  assert.deepEqual(unsafe.opportunity, {});
  assert.equal(unsafe.opportunitySources[0].reason, 'golem_not_feasible');
});

test('partial iron and exposed iron reduce modeled route deficits but never authoritative deficits', () => {
  const partial = createMissionResourceLedger({
    itemCounts: { raw_iron: 1 },
    requirements: { raw_iron: 3 },
    opportunities: [{
      id: 'exposed:vein-a',
      type: 'exposed_iron',
      verified: true,
      count: 2,
    }],
  });
  assert.deepEqual(partial.owned, { 'minecraft:raw_iron': 1 });
  assert.deepEqual(partial.deficit, { 'minecraft:raw_iron': 2 });
  assert.deepEqual(partial.opportunity, { 'minecraft:raw_iron': 2 });
  assert.equal(partial.feasibility.conservativeOpportunityCouldSatisfy, true);
  assert.equal(partial.feasibility.authoritativeSatisfied, false);
  assert.equal(requirementSatisfied(partial), false);

  const afterPickup = createMissionResourceLedger({
    itemCounts: { raw_iron: 3 },
    requirements: { raw_iron: 3 },
  });
  assert.equal(requirementSatisfied(afterPickup), true);
});

test('equipment metadata is canonical, immutable, and does not double-count inventory', () => {
  const ledger = createMissionResourceLedger({
    itemCounts: { iron_pickaxe: 1 },
    equipment: {
      mainHand: { itemId: 'Iron_Pickaxe', count: 1, remainingDurability: 117 },
      head: 'iron_helmet',
      malformed: { itemId: 'stick', count: 0 },
    },
    requirements: { iron_pickaxe: 1 },
  });
  assert.deepEqual(ledger.owned, { 'minecraft:iron_pickaxe': 1 });
  assert.deepEqual(ledger.equipment, {
    head: { itemId: 'minecraft:iron_helmet', count: 1 },
    mainHand: { itemId: 'minecraft:iron_pickaxe', count: 1, remainingDurability: 117 },
  });
  assert.equal(requirementSatisfied(ledger), true);
  assert.throws(() => { ledger.equipment.mainHand.remainingDurability = 0; }, TypeError);
});
