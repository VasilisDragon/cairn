import {
  EMPTY_OPPORTUNITY_CAPABILITY_REGISTRY,
  isOpportunityCapabilityRegistry,
} from './opportunity-capabilities.js';

const ITEM_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const SOURCE_ID_RE = /^[a-zA-Z0-9_.:-]{1,96}$/;
const MAX_CONVERSION_OPERATIONS = 64;

/**
 * Normalize a complete inventory count map without category approximation.
 *
 * Accepted forms are a Map/object of item id -> count, or an array of stack
 * observations (`{itemId|id|item, count}`). Duplicate stacks are summed. Only
 * positive safe-integer observations are authoritative; malformed values are
 * ignored rather than rounded into invented inventory.
 */
export function normalizeExactItemCounts(raw) {
  const counts = new Map();
  if (raw instanceof Map) {
    for (const [item, count] of raw.entries()) addExactCount(counts, item, count);
  } else if (Array.isArray(raw)) {
    for (const stack of raw) {
      if (!stack || typeof stack !== 'object' || Array.isArray(stack)) continue;
      addExactCount(counts, stack.itemId ?? stack.id ?? stack.item, stack.count);
    }
  } else if (raw && typeof raw === 'object') {
    for (const item of Object.keys(raw)) addExactCount(counts, item, raw[item]);
  }
  return freezeCountMap(Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * Build immutable, authority-separated mission resource views.
 *
 * `deficit` is intentionally derived from verified `owned` inventory only.
 * Convertible resources describe a code-executable future, while opportunity
 * and estimated resources describe unowned futures. None of those views can
 * satisfy an inventory postcondition until a later snapshot moves the result
 * into `owned`.
 */
export function createMissionResourceLedger(input = {}) {
  const inventorySource = input.inventoryItemCounts
    ?? input.itemCounts
    ?? input.inventory?.itemCounts
    ?? input.owned
    ?? {};
  const owned = normalizeExactItemCounts(inventorySource);
  const requirements = normalizeExactItemCounts(input.requirements ?? input.required ?? {});
  const reservationRequested = normalizeExactItemCounts(input.reservations ?? input.reserved ?? {});
  const reservation = reserveOwnedItems(owned, reservationRequested);
  const deficit = subtractFloor(requirements, owned);
  const registry = normalizeRegistry(input.capabilities);
  const conversion = evaluateConversions({
    available: reservation.available,
    owned,
    deficit,
    registry,
  });
  const discoveries = evaluateOpportunities(input.opportunities);
  const convertibleDeficit = subtractFloor(deficit, conversion.convertible);
  const opportunityDeficit = subtractFloor(deficit, discoveries.minimum);
  const estimatedDeficit = subtractFloor(deficit, discoveries.expected);

  const ledger = {
    owned,
    reserved: reservation.actual,
    convertible: conversion.convertible,
    opportunity: discoveries.minimum,
    estimated: discoveries.expected,
    deficit,
    requirements,
    equipment: freezeEquipment(input.equipment ?? input.inventory?.equipment),
    reservation: Object.freeze({
      requested: reservationRequested,
      unmet: reservation.unmet,
      available: reservation.available,
    }),
    conversion: Object.freeze({
      projectedAvailable: conversion.projectedAvailable,
      projectedOwned: conversion.projectedOwned,
      consumed: conversion.consumed,
      produced: conversion.produced,
      plan: conversion.plan,
      rejectedCapabilities: registry.rejected,
      operations: conversion.plan.length,
      operationLimitReached: conversion.operationLimitReached,
      remainingDeficit: convertibleDeficit,
    }),
    opportunitySources: discoveries.sources,
    feasibility: Object.freeze({
      authoritativeSatisfied: countMapEmpty(deficit),
      convertibleCouldSatisfy: countMapEmpty(convertibleDeficit),
      conservativeOpportunityCouldSatisfy: countMapEmpty(opportunityDeficit),
      expectedOpportunityCouldSatisfy: countMapEmpty(estimatedDeficit),
      convertibleDeficit,
      conservativeOpportunityDeficit: opportunityDeficit,
      expectedOpportunityDeficit: estimatedDeficit,
    }),
  };
  return Object.freeze(ledger);
}

/** Objective/postcondition authority: verified owned inventory only. */
export function authoritativeRequirementSatisfied(ledger) {
  return Boolean(ledger && countMapEmpty(ledger.deficit));
}

export const requirementSatisfied = authoritativeRequirementSatisfied;

/** Remaining verified-inventory requirement for one exact item id. */
export function resourceDeficit(ledger, itemId) {
  const item = canonicalItemId(itemId);
  return item && ledger?.deficit ? exactCount(ledger.deficit[item]) : 0;
}

function reserveOwnedItems(owned, requested) {
  const actual = {};
  const unmet = {};
  const available = { ...owned };
  for (const item of unionKeys(owned, requested)) {
    const ownedCount = exactCount(owned[item]);
    const requestedCount = exactCount(requested[item]);
    const reserved = Math.min(ownedCount, requestedCount);
    const missing = Math.max(0, requestedCount - reserved);
    if (reserved > 0) actual[item] = reserved;
    if (missing > 0) unmet[item] = missing;
    if (ownedCount - reserved > 0) available[item] = ownedCount - reserved;
    else delete available[item];
  }
  return {
    actual: freezeCountMap(actual),
    unmet: freezeCountMap(unmet),
    available: freezeCountMap(available),
  };
}

function evaluateConversions({ available, owned, deficit, registry }) {
  const working = { ...available };
  const initial = { ...available };
  const consumed = {};
  const produced = {};
  const plan = [];
  const applied = new Set();
  let advanced = true;

  while (advanced && plan.length < MAX_CONVERSION_OPERATIONS) {
    advanced = false;
    for (const capability of registry.capabilities) {
      if (applied.has(capability.id)) continue;
      if (!hasCounts(owned, capability.catalysts)) continue;
      const batches = maximumBatches(working, capability.inputs);
      if (batches <= 0) continue;
      applied.add(capability.id);
      advanced = true;
      const operationConsumed = scaleCounts(capability.inputs, batches);
      const operationProduced = scaleCounts(capability.outputs, batches);
      applySubtraction(working, operationConsumed);
      applyAddition(working, operationProduced);
      applyAddition(consumed, operationConsumed);
      applyAddition(produced, operationProduced);
      plan.push(Object.freeze({
        capabilityId: capability.id,
        executor: capability.executor,
        batches,
        consumed: freezeCountMap(operationConsumed),
        produced: freezeCountMap(operationProduced),
      }));
    }
  }

  const convertible = {};
  for (const item of unionKeys(initial, working)) {
    const additional = exactCount(working[item]) - exactCount(initial[item]);
    if (additional > 0) convertible[item] = additional;
  }
  const projectedOwned = { ...owned };
  for (const item of unionKeys(initial, working)) {
    const delta = exactCount(working[item]) - exactCount(initial[item]);
    const next = exactCount(projectedOwned[item]) + delta;
    if (next > 0) projectedOwned[item] = next;
    else delete projectedOwned[item];
  }
  return {
    convertible: freezeCountMap(convertible),
    projectedAvailable: freezeCountMap(working),
    projectedOwned: freezeCountMap(projectedOwned),
    consumed: freezeCountMap(consumed),
    produced: freezeCountMap(produced),
    plan: Object.freeze(plan),
    operationLimitReached: advanced && plan.length >= MAX_CONVERSION_OPERATIONS,
  };
}

function evaluateOpportunities(rawValues) {
  const minimum = {};
  const expected = {};
  const sources = [];
  const values = Array.isArray(rawValues) ? rawValues : [];
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    const source = normalizeOpportunity(raw, index);
    sources.push(source);
    applyAddition(minimum, source.minimumItems);
    applyAddition(expected, source.expectedItems);
  }
  return {
    minimum: freezeCountMap(minimum),
    expected: freezeCountMap(expected),
    sources: Object.freeze(sources),
  };
}

function normalizeOpportunity(raw, index) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = SOURCE_ID_RE.test(String(value.id || '').trim()) ? String(value.id).trim() : `source:${index}`;
  const type = String(value.type || value.kind || 'unknown').trim().toLowerCase();
  const verified = value.verified === true;
  let minimumItems = {};
  let expectedItems = {};
  let reason = verified ? 'no_registered_yield' : 'unverified';

  if (type === 'container' || type === 'chest') {
    const known = value.contentsKnown === true || value.inspected === true;
    if (verified && known) {
      minimumItems = normalizeExactItemCounts(value.items ?? value.contents);
      expectedItems = minimumItems;
      reason = 'known_contents';
    } else {
      // Unknown containers have exactly zero ledger value. Appearance, village
      // type, or historical loot tables are never inventory evidence.
      reason = known ? 'unverified_contents' : 'unknown_contents';
    }
  } else if (type === 'iron_golem' || type === 'golem') {
    const count = positiveObservationCount(value.count, 1);
    if (verified && value.feasible === true && count > 0) {
      minimumItems = freezeCountMap({ 'minecraft:iron_ingot': safeMultiply(count, 3) });
      expectedItems = freezeCountMap({ 'minecraft:iron_ingot': safeMultiply(count, 4) });
      reason = 'golem_minimum_three_expected_four';
    } else {
      reason = verified ? 'golem_not_feasible' : 'unverified';
    }
  } else if (type === 'hay_patch' || type === 'hay_bales' || type === 'hay') {
    const count = positiveObservationCount(value.count ?? value.blockCount, 0);
    if (verified && count > 0) {
      minimumItems = freezeCountMap({ 'minecraft:hay_block': count });
      expectedItems = minimumItems;
      reason = 'verified_hay';
    }
  } else if (type === 'exposed_iron' || type === 'exposed_iron_ore') {
    const count = positiveObservationCount(value.count ?? value.blockCount, 0);
    if (verified && count > 0) {
      minimumItems = freezeCountMap({ 'minecraft:raw_iron': count });
      const expectedYield = positiveObservationCount(value.expectedYield, count);
      expectedItems = freezeCountMap({ 'minecraft:raw_iron': Math.max(count, expectedYield) });
      reason = 'verified_exposed_iron';
    }
  } else if (verified) {
    minimumItems = normalizeExactItemCounts(value.minimumItems ?? value.items);
    const rawExpected = normalizeExactItemCounts(value.expectedItems ?? value.estimatedItems);
    expectedItems = maxCounts(minimumItems, rawExpected);
    reason = Object.keys(minimumItems).length > 0 || Object.keys(expectedItems).length > 0
      ? 'verified_generic'
      : 'no_registered_yield';
  }

  return Object.freeze({
    id,
    type,
    verified,
    reason,
    minimumItems: freezeCountMap(minimumItems),
    expectedItems: freezeCountMap(expectedItems),
  });
}

function normalizeRegistry(raw) {
  return isOpportunityCapabilityRegistry(raw)
    ? raw
    : EMPTY_OPPORTUNITY_CAPABILITY_REGISTRY;
}

function freezeEquipment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze({});
  const result = {};
  for (const slot of Object.keys(raw).sort()) {
    const value = raw[slot];
    if (typeof value === 'string') {
      const itemId = canonicalItemId(value);
      if (itemId) result[slot] = Object.freeze({ itemId, count: 1 });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const itemId = canonicalItemId(value.itemId ?? value.id ?? value.item);
    const count = exactCount(value.count);
    if (!itemId || count <= 0) continue;
    const remainingDurability = Number.isSafeInteger(value.remainingDurability)
      && value.remainingDurability >= 0 ? value.remainingDurability : null;
    result[slot] = Object.freeze({ itemId, count, remainingDurability });
  }
  return Object.freeze(result);
}

function subtractFloor(required, supplied) {
  const result = {};
  for (const item of Object.keys(required).sort()) {
    const missing = exactCount(required[item]) - exactCount(supplied[item]);
    if (missing > 0) result[item] = missing;
  }
  return freezeCountMap(result);
}

function maxCounts(left, right) {
  const result = {};
  for (const item of unionKeys(left, right)) {
    const count = Math.max(exactCount(left[item]), exactCount(right[item]));
    if (count > 0) result[item] = count;
  }
  return freezeCountMap(result);
}

function maximumBatches(available, inputs) {
  let batches = Number.MAX_SAFE_INTEGER;
  for (const [item, count] of Object.entries(inputs)) {
    batches = Math.min(batches, Math.floor(exactCount(available[item]) / count));
  }
  return Number.isSafeInteger(batches) && batches > 0 ? batches : 0;
}

function hasCounts(have, required) {
  return Object.entries(required).every(([item, count]) => exactCount(have[item]) >= count);
}

function scaleCounts(counts, multiplier) {
  const result = {};
  for (const [item, count] of Object.entries(counts)) result[item] = safeMultiply(count, multiplier);
  return result;
}

function applyAddition(target, addition) {
  for (const [item, count] of Object.entries(addition)) {
    target[item] = safeAdd(exactCount(target[item]), count);
  }
}

function applySubtraction(target, subtraction) {
  for (const [item, count] of Object.entries(subtraction)) {
    const next = exactCount(target[item]) - count;
    if (next > 0) target[item] = next;
    else delete target[item];
  }
}

function addExactCount(target, rawItem, rawCount) {
  const item = canonicalItemId(rawItem);
  if (!item || !Number.isSafeInteger(rawCount) || rawCount <= 0) return;
  target.set(item, safeAdd(target.get(item) || 0, rawCount));
}

function canonicalItemId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const item = raw.includes(':') ? raw : `minecraft:${raw}`;
  return ITEM_ID_RE.test(item) ? item : null;
}

function positiveObservationCount(value, fallback) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  return Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 0;
}

function exactCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function safeAdd(left, right) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('resource count overflow');
  return value;
}

function safeMultiply(left, right) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('resource count overflow');
  return value;
}

function unionKeys(...maps) {
  const keys = new Set();
  for (const map of maps) for (const key of Object.keys(map || {})) keys.add(key);
  return [...keys].sort();
}

function freezeCountMap(raw) {
  const result = {};
  for (const key of Object.keys(raw || {}).sort()) {
    const count = exactCount(raw[key]);
    if (count > 0) result[key] = count;
  }
  return Object.freeze(result);
}

function countMapEmpty(counts) {
  return !counts || Object.keys(counts).length === 0;
}
