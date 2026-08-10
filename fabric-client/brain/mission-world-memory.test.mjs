import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FABRIC_WORLD_MEMORY_CAPS,
  FabricWorldMemoryStore,
  resolveFabricWorldMemoryScope,
} from './mission-world-memory.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-world-memory-test-'));
}

function persistentStore(rootDir, overrides = {}) {
  return new FabricWorldMemoryStore({
    rootDir,
    worldId: 'world-139',
    dimension: 'minecraft:overworld',
    mission: 'iron-armor',
    persistenceEligible: true,
    clock: () => 1000,
    ...overrides,
  });
}

function sessionStore(overrides = {}) {
  return new FabricWorldMemoryStore({
    worldId: 'session:test',
    dimension: 'minecraft:overworld',
    mission: 'iron-armor',
    persistenceEligible: false,
    clock: () => 1000,
    ...overrides,
  });
}

const EXACT_TEST_SCOPE = Object.freeze({
  worldId: 'session:test',
  dimension: 'minecraft:overworld',
  mission: 'iron-armor',
});

test('remote persistence requires an explicit configured world id', () => {
  const unconfigured = resolveFabricWorldMemoryScope({
    remote: true,
    worldId: 'server.example:25565',
    sessionId: 'run-7',
    dimension: 'minecraft:overworld',
    mission: 'iron-armor',
  });
  assert.equal(unconfigured.worldId, 'server.example:25565');
  assert.equal(unconfigured.persistenceEligible, false);
  assert.equal(unconfigured.identitySource, 'session');
  assert.equal(unconfigured.persistenceReason, 'remote_world_id_unconfigured');

  const configured = resolveFabricWorldMemoryScope({
    remote: true,
    worldId: 'server.example:25565',
    configuredWorldId: 'private-survival-world',
    dimension: 'minecraft:the_nether',
    mission: 'dragon',
  });
  assert.deepEqual(configured, {
    worldId: 'private-survival-world',
    dimension: 'minecraft:the_nether',
    mission: 'dragon',
    remote: true,
    identitySource: 'configured_remote',
    persistenceEligible: true,
    persistenceReason: 'configured_remote_world_id',
  });
});

test('loadSession exposes exact world, dimension, and mission isolation', () => {
  const rootDir = tempRoot();
  const store = new FabricWorldMemoryStore({ rootDir, clock: () => 42 });
  const loaded = store.loadSession({
    worldId: 'Exact World ID',
    dimension: 'minecraft:overworld',
    mission: 'mission:A',
    persistenceEligible: true,
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.reason, 'not_found');
  assert.deepEqual(store.snapshot().identity, {
    worldId: 'Exact World ID',
    dimension: 'minecraft:overworld',
    mission: 'mission:A',
  });

  store.ingest('landmark', {
    id: 'village:1',
    confidence: 0.9,
    lastSeen: 42,
    status: 'verified',
    type: 'village',
  });

  const otherMission = persistentStore(rootDir, { mission: 'mission:B' });
  assert.equal(otherMission.load().value.landmarks.length, 0);
  const otherDimension = persistentStore(rootDir, { dimension: 'minecraft:the_nether' });
  assert.equal(otherDimension.load().value.landmarks.length, 0);
  const otherWorld = persistentStore(rootDir, { worldId: 'exact world id' });
  assert.equal(otherWorld.load().value.landmarks.length, 0);

  const same = persistentStore(rootDir, {
    worldId: 'Exact World ID',
    mission: 'mission:A',
  });
  assert.equal(same.load().value.landmarks[0].id, 'village:1');
});

test('discovery ingestion preserves stable identity and increments revisions', () => {
  const store = sessionStore();
  store.load();
  const first = store.ingestDiscovery({
    id: 'ore:iron:4:12:9',
    type: 'exposed_iron',
    confidence: 0.72,
    lastSeen: 100,
    status: 'observed',
    x: 4,
    y: 12,
    z: 9,
  });
  assert.equal(first.ok, true);
  assert.equal(first.value.revision, 1);
  assert.deepEqual(first.value.details, {
    type: 'exposed_iron',
    x: 4,
    y: 12,
    z: 9,
  });

  const second = store.ingest('resource_patch', {
    id: 'ore:iron:4:12:9',
    confidence: 0.95,
    lastSeen: 140,
    status: 'verified',
    type: 'exposed_iron',
    count: 3,
  });
  assert.equal(second.value.revision, 2);
  assert.equal(second.value.status, 'verified');
  assert.equal(second.value.details.count, 3);
  assert.equal(store.snapshot().revision, 2);

  const semanticKind = store.ingestDiscovery({
    id: 'village:kind-only',
    kind: 'village',
    status: 'observed',
  });
  assert.equal(semanticKind.ok, true);
  assert.equal(store.get('landmarks', 'village:kind-only').id, 'village:kind-only');
});

test('scanner batches commit once and coalesce freshness without semantic revision churn', () => {
  let now = 1_000;
  const store = sessionStore({ clock: () => now });
  store.load();
  const originalCommit = store._commit.bind(store);
  let commits = 0;
  store._commit = (next) => {
    commits += 1;
    return originalCommit(next);
  };
  const batch = Array.from({ length: 32 }, (_, index) => ({
    id: `ore:batch:${index}`,
    type: 'exposed_iron',
    confidence: 0.8,
    lastSeen: now,
    status: 'verified',
    details: { type: 'exposed_iron', count: 1 },
  }));
  const first = store.ingestDiscoveriesBatch(batch, { refreshIntervalMs: 30_000 });
  assert.equal(first.ok, true);
  assert.equal(first.commitPerformed, true);
  assert.equal(first.semanticChanged, true);
  assert.equal(first.storeRevision, 1);
  assert.equal(store.snapshot().resourcePatches.length, 32);
  assert.equal(commits, 1);

  now += 5_000;
  const early = store.ingestDiscoveriesBatch(batch.map((entry) => ({ ...entry, lastSeen: now })), {
    refreshIntervalMs: 30_000,
  });
  assert.equal(early.commitPerformed, false);
  assert.equal(early.storeRevision, 1);
  assert.equal(store.get('resourcePatches', 'ore:batch:0').lastSeen, 1_000);
  assert.equal(commits, 1);

  now = 31_000;
  const refreshed = store.ingestDiscoveriesBatch(batch.map((entry) => ({ ...entry, lastSeen: now })), {
    refreshIntervalMs: 30_000,
  });
  assert.equal(refreshed.commitPerformed, true);
  assert.equal(refreshed.semanticChanged, false);
  assert.equal(refreshed.freshnessChanged, true);
  assert.equal(refreshed.storeRevision, 1);
  assert.equal(store.get('resourcePatches', 'ore:batch:0').revision, 1);
  assert.equal(store.get('resourcePatches', 'ore:batch:0').lastSeen, 31_000);
  assert.equal(commits, 2);
});

test('container inspection survives unknown observations until exact disappearance retires it', () => {
  let now = 1_000;
  const store = sessionStore({ clock: () => now });
  store.load();
  const inserted = store.upsertContainer({
    id: 'container:village:10:64:20',
    confidence: 0.8,
    lastSeen: now,
    status: 'observed',
    details: {
      type: 'container',
      x: 10,
      y: 64,
      z: 20,
      contentsKnown: false,
      items: {},
    },
  });
  assert.equal(inserted.value.revision, 1);

  now = 1_100;
  const applied = store.applyContainerInspectionReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: 'container:village:10:64:20',
    expectedContainerRevision: 1,
    commandId: 'village:detour:7',
    receiptId: 'container-open:7:1',
    items: {
      'minecraft:iron_ingot': 2,
      'minecraft:bread': 3,
    },
    inspectedAt: now,
    status: 'inspected',
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.action, 'inspection_applied');
  assert.equal(applied.value.revision, 2);
  assert.equal(applied.value.status, 'inspected');
  assert.deepEqual(applied.value.details.items, {
    'minecraft:bread': 3,
    'minecraft:iron_ingot': 2,
  });
  assert.equal(applied.value.details.contentsKnown, true);
  assert.equal(applied.value.details.inspectionCommandId, 'village:detour:7');
  assert.equal(applied.value.details.inspectionReceiptId, 'container-open:7:1');

  now = 1_200;
  const scannerRefresh = store.ingestDiscoveriesBatch([{
    id: 'container:village:10:64:20',
    type: 'container',
    confidence: 0.95,
    lastSeen: now,
    status: 'observed',
    details: {
      type: 'container',
      x: 11,
      y: 64,
      z: 20,
      contentsKnown: false,
      items: {},
    },
  }]);
  assert.equal(scannerRefresh.ok, true);
  const refreshed = store.get('containers', 'container:village:10:64:20');
  assert.equal(refreshed.revision, 3);
  assert.equal(refreshed.status, 'observed');
  assert.equal(refreshed.details.x, 11);
  assert.equal(refreshed.details.contentsKnown, true);
  assert.deepEqual(refreshed.details.items, {
    'minecraft:bread': 3,
    'minecraft:iron_ingot': 2,
  });
  assert.equal(refreshed.details.inspectedAt, 1_100);

  now = 1_250;
  store.ingestDiscoveriesBatch([{
    id: 'container:village:10:64:20',
    type: 'container',
    lastSeen: now,
    status: 'invalidated',
    details: { type: 'container', contentsKnown: false, items: {} },
  }]);
  assert.equal(store.get('containers', 'container:village:10:64:20').status, 'invalidated');
  assert.equal(store.get('containers', 'container:village:10:64:20').details.contentsKnown, true);
  assert.deepEqual(store.get('containers', 'container:village:10:64:20').details.items, {
    'minecraft:bread': 3,
    'minecraft:iron_ingot': 2,
  });

  now = 1_300;
  store.ingestDiscoveriesBatch([{
    id: 'container:village:10:64:20',
    type: 'container',
    lastSeen: now,
    status: 'disappeared',
    details: { type: 'container', contentsKnown: false, items: {} },
  }]);
  assert.equal(store.get('containers', 'container:village:10:64:20').status, 'disappeared');
  assert.equal(store.get('containers', 'container:village:10:64:20').details.contentsKnown, false);
  assert.deepEqual(store.get('containers', 'container:village:10:64:20').details.items, {});
  assert.equal(
    Object.hasOwn(
      store.get('containers', 'container:village:10:64:20').details,
      'inspectionReceiptId',
    ),
    false,
  );

  now = 1_400;
  store.ingestDiscoveriesBatch([{
    id: 'container:village:10:64:20',
    type: 'container',
    lastSeen: now,
    status: 'observed',
    details: { type: 'container', contentsKnown: false, items: {} },
  }]);
  const replacement = store.get('containers', 'container:village:10:64:20');
  assert.equal(replacement.status, 'observed');
  assert.equal(replacement.details.contentsKnown, false);
  assert.deepEqual(replacement.details.items, {});
});

test('exact refresh-required feedback retires stale container contents without deleting geometry', () => {
  let now = 1_000;
  const store = sessionStore({ clock: () => now });
  store.load();
  const inserted = store.upsertContainer({
    id: 'container:village:refresh-required',
    confidence: 0.9,
    lastSeen: now,
    status: 'observed',
    details: {
      type: 'container', x: 10, y: 64, z: 20,
      contentsKnown: false, items: {},
    },
  });
  now = 1_100;
  const inspected = store.applyContainerInspectionReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: inserted.value.id,
    expectedContainerRevision: inserted.value.revision,
    commandId: 'inspect:refresh-required',
    receiptId: 'inspect:refresh-required:1',
    items: { 'minecraft:iron_pickaxe': 1 },
    inspectedAt: now,
    status: 'inspected',
  });
  assert.equal(inspected.ok, true);

  now = 1_200;
  const retired = store.applyContainerRefreshRequiredReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: inserted.value.id,
    expectedContainerRevision: inspected.value.revision,
    commandId: 'withdraw:refresh-required',
    receiptId: 'withdraw:refresh-required:invalidated',
    observedAt: now,
    reason: 'invalidated',
  });
  assert.equal(retired.ok, true);
  assert.equal(retired.action, 'container_refresh_required_applied');
  assert.equal(retired.value.revision, inspected.value.revision + 1);
  assert.equal(retired.value.details.contentsKnown, false);
  assert.deepEqual(retired.value.details.items, {});
  assert.deepEqual(
    { x: retired.value.details.x, y: retired.value.details.y, z: retired.value.details.z },
    { x: 10, y: 64, z: 20 },
  );
  assert.equal(retired.value.details.contentsRefreshRequiredReason, 'invalidated');

  const before = JSON.stringify(store.snapshot());
  const stale = store.applyContainerRefreshRequiredReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: inserted.value.id,
    expectedContainerRevision: inspected.value.revision,
    commandId: 'withdraw:stale',
    receiptId: 'withdraw:stale:invalidated',
    observedAt: now,
    reason: 'invalidated',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_container_revision');
  assert.equal(JSON.stringify(store.snapshot()), before);
});

test('withdrawal receipts atomically replace known contents with authoritative final truth', () => {
  const store = sessionStore();
  store.load();
  store.upsertContainer({
    id: 'container:withdrawal',
    lastSeen: 1_000,
    status: 'observed',
    details: { type: 'container', contentsKnown: false, items: {} },
  });
  assert.equal(store.applyContainerInspectionReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: 'container:withdrawal',
    expectedContainerRevision: 1,
    commandId: 'village:inspect:1',
    receiptId: 'inspect:receipt:1',
    items: {
      'minecraft:bread': 3,
      'minecraft:iron_ingot': 2,
    },
    inspectedAt: 1_100,
    status: 'inspected',
  }).ok, true);

  const withdrawn = store.applyContainerWithdrawalReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: 'container:withdrawal',
    expectedContainerRevision: 2,
    commandId: 'village:withdraw:1',
    receiptId: 'withdraw:receipt:1',
    withdrawnItems: {
      'minecraft:bread': 2,
      'minecraft:iron_ingot': 2,
    },
    items: {
      'minecraft:bread': 8,
      'minecraft:emerald': 4,
    },
    withdrawnAt: 1_200,
    status: 'partially_looted',
  });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.action, 'withdrawal_applied');
  assert.equal(withdrawn.value.revision, 3);
  assert.equal(withdrawn.value.status, 'partially_looted');
  assert.deepEqual(withdrawn.value.details.items, {
    'minecraft:bread': 8,
    'minecraft:emerald': 4,
  });
  assert.equal(withdrawn.value.details.contentsReceiptKind, 'withdrawal');
  assert.equal(withdrawn.value.details.contentsReceiptId, 'withdraw:receipt:1');

  const beforeRejected = store.snapshot();
  const malformed = store.applyContainerWithdrawalReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: 'container:withdrawal',
    expectedContainerRevision: 3,
    commandId: 'village:withdraw:2',
    receiptId: 'withdraw:receipt:2',
    withdrawnItems: { 'minecraft:bread': 1 },
    items: {
      'minecraft:bread': 0,
      'minecraft:emerald': 4,
    },
    withdrawnAt: 1_300,
    status: 'looted',
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'invalid_receipt');
  assert.deepEqual(store.snapshot(), beforeRejected);

  const stale = store.applyContainerWithdrawalReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: 'container:withdrawal',
    expectedContainerRevision: 2,
    commandId: 'village:withdraw:stale',
    receiptId: 'withdraw:receipt:stale',
    withdrawnItems: { 'minecraft:bread': 1 },
    items: { 'minecraft:bread': 7 },
    withdrawnAt: 1_300,
    status: 'looted',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_container_revision');
  assert.deepEqual(store.snapshot(), beforeRejected);

  const duplicate = store.applyContainerWithdrawalReceipt({
    scope: EXACT_TEST_SCOPE,
    containerId: 'container:withdrawal',
    expectedContainerRevision: 3,
    commandId: 'village:withdraw:1',
    receiptId: 'withdraw:receipt:1',
    withdrawnItems: { 'minecraft:bread': 1 },
    items: {},
    withdrawnAt: 1_300,
    status: 'looted',
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'receipt_already_applied');
  assert.deepEqual(store.snapshot(), beforeRejected);
});

test('receipt-backed exact container contents persist across restart without player inventory', () => {
  const rootDir = tempRoot();
  const scope = {
    worldId: 'world-139',
    dimension: 'minecraft:overworld',
    mission: 'iron-armor',
  };
  const store = persistentStore(rootDir, { clock: () => 2_000 });
  store.load();
  store.upsertContainer({
    id: 'container:persistent',
    status: 'observed',
    lastSeen: 1_900,
    details: { type: 'container', contentsKnown: false, items: {} },
  });
  const applied = store.applyContainerInspectionReceipt({
    scope,
    containerId: 'container:persistent',
    expectedContainerRevision: 1,
    commandId: 'village:inspect:persistent',
    receiptId: 'inspection:persistent:1',
    items: { 'minecraft:iron_pickaxe': 1 },
    inspectedAt: 2_000,
    status: 'inspected',
  });
  assert.equal(applied.persisted, true);

  const restarted = persistentStore(rootDir);
  assert.equal(restarted.load().ok, true);
  const remembered = restarted.get('containers', 'container:persistent');
  assert.equal(remembered.details.contentsKnown, true);
  assert.deepEqual(remembered.details.items, { 'minecraft:iron_pickaxe': 1 });
  assert.equal(remembered.details.inspectionReceiptId, 'inspection:persistent:1');
  assert.doesNotMatch(fs.readFileSync(restarted.statePath, 'utf8'), /"inventory"/i);
});

test('container receipts reject stale or mismatched evidence without any mutation', () => {
  const store = sessionStore();
  store.load();
  store.upsertContainer({
    id: 'container:atomic',
    lastSeen: 1_000,
    status: 'observed',
    details: { type: 'container', contentsKnown: false, items: {} },
  });
  const base = {
    scope: EXACT_TEST_SCOPE,
    containerId: 'container:atomic',
    expectedContainerRevision: 1,
    commandId: 'village:command:1',
    receiptId: 'receipt:1',
    items: { 'minecraft:bread': 2 },
    inspectedAt: 1_100,
    status: 'inspected',
  };

  for (const [reason, receipt] of [
    ['scope_mismatch', {
      ...base,
      scope: { ...EXACT_TEST_SCOPE, dimension: 'minecraft:the_nether' },
    }],
    ['stale_container_revision', { ...base, expectedContainerRevision: 2 }],
    ['stale_inspection_time', { ...base, inspectedAt: 999 }],
    ['invalid_receipt', { ...base, items: { 'minecraft:bread': 1.5 } }],
  ]) {
    const before = store.snapshot();
    const rejected = store.applyContainerInspectionReceipt(receipt);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, reason);
    assert.deepEqual(store.snapshot(), before);
  }

  assert.equal(store.applyContainerInspectionReceipt(base).ok, true);
  const beforeDuplicate = store.snapshot();
  const duplicate = store.applyContainerInspectionReceipt({
    ...base,
    expectedContainerRevision: 2,
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'receipt_already_applied');
  assert.deepEqual(store.snapshot(), beforeDuplicate);
});

test('village transaction outcomes are scope and receipt correlated under the existing cap', () => {
  const store = sessionStore();
  store.load();
  for (let index = 0; index <= FABRIC_WORLD_MEMORY_CAPS.outcomes; index += 1) {
    const result = store.recordVillageTransactionOutcome({
      scope: EXACT_TEST_SCOPE,
      id: `village-outcome:${String(index).padStart(2, '0')}`,
      commandId: `village-command:${index}`,
      receiptId: `village-receipt:${index}`,
      at: index,
      status: index % 2 ? 'failed' : 'completed',
      details: {
        opportunityId: `village:${index}`,
        elapsedMs: index * 10,
        inventory: { 'minecraft:iron_ingot': 64 },
      },
    });
    assert.equal(result.ok, true);
  }
  const outcomes = store.snapshot().outcomes;
  assert.equal(outcomes.length, FABRIC_WORLD_MEMORY_CAPS.outcomes);
  assert.equal(outcomes[0].id, 'village-outcome:01');
  assert.equal(outcomes.at(-1).details.kind, 'village_transaction_v1');
  assert.equal(outcomes.at(-1).details.commandId, 'village-command:16');
  assert.equal(outcomes.at(-1).details.receiptId, 'village-receipt:16');
  assert.equal(Object.hasOwn(outcomes.at(-1).details, 'inventory'), false);

  const beforeMismatch = store.snapshot();
  const mismatch = store.recordVillageTransactionOutcome({
    scope: EXACT_TEST_SCOPE,
    id: 'village-outcome:16',
    commandId: 'village-command:16',
    receiptId: 'different-receipt',
    at: 99,
    status: 'completed',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'outcome_correlation_mismatch');
  assert.deepEqual(store.snapshot(), beforeMismatch);

  const duplicate = store.recordVillageTransactionOutcome({
    scope: EXACT_TEST_SCOPE,
    id: 'village-outcome:16',
    commandId: 'village-command:16',
    receiptId: 'village-receipt:16',
    at: 100,
    status: 'completed',
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'outcome_already_recorded');
  assert.deepEqual(store.snapshot(), beforeMismatch);

  const receiptConflict = store.recordVillageTransactionOutcome({
    scope: EXACT_TEST_SCOPE,
    id: 'village-outcome:duplicate-receipt',
    commandId: 'village-command:16',
    receiptId: 'village-receipt:16',
    at: 101,
    status: 'completed',
  });
  assert.equal(receiptConflict.ok, false);
  assert.equal(receiptConflict.reason, 'outcome_receipt_conflict');
  assert.deepEqual(store.snapshot(), beforeMismatch);

  const wrongScope = store.recordVillageTransactionOutcome({
    scope: { ...EXACT_TEST_SCOPE, worldId: 'another-world' },
    id: 'village-outcome:new',
    commandId: 'village-command:new',
    receiptId: 'village-receipt:new',
    status: 'completed',
  });
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.reason, 'scope_mismatch');
  assert.deepEqual(store.snapshot(), beforeMismatch);
});

test('exact iron-golem collection is atomic, persistent, and cannot be revived by scanner lag', () => {
  const rootDir = tempRoot();
  const store = persistentStore(rootDir);
  store.load();
  const inserted = store.ingestDiscovery({
    id: 'iron_golem:opaque-a1',
    type: 'iron_golem',
    confidence: 1,
    lastSeen: 900,
    status: 'verified',
    x: 12,
    y: 64,
    z: 4,
  });
  const before = store.snapshot();
  const collected = store.applyIronGolemCollectionReceipt({
    scope: { worldId: 'world-139', dimension: 'minecraft:overworld', mission: 'iron-armor' },
    opportunityId: 'iron_golem:opaque-a1',
    expectedOpportunityRevision: inserted.value.revision,
    commandId: 'mission-village-golem-1',
    receiptId: 'golem-drop:1',
    inventoryDelta: { 'minecraft:iron_ingot': 3 },
    consumedInventoryDelta: {},
    collectedAt: 1000,
  });
  assert.equal(collected.ok, true);
  assert.equal(collected.value.status, 'collected');
  assert.equal(collected.value.revision, inserted.value.revision + 1);
  assert.equal(collected.value.details.collectionAuthority, 'iron_golem_collection_receipt_v1');
  assert.equal(collected.value.details.collectedIronIngots, 3);
  assert.equal(store.snapshot().revision, before.revision + 1);

  const lagged = store.ingestDiscoveriesBatch([{
    id: 'iron_golem:opaque-a1',
    type: 'iron_golem',
    confidence: 1,
    lastSeen: 1100,
    status: 'verified',
    x: 12,
    y: 64,
    z: 4,
  }], { refreshIntervalMs: 1 });
  assert.equal(lagged.ok, true);
  const terminal = store.get('landmarks', 'iron_golem:opaque-a1');
  assert.equal(terminal.status, 'collected');
  assert.equal(terminal.details.collectionReceiptId, 'golem-drop:1');
  assert.equal(terminal.revision, collected.value.revision);

  const restarted = persistentStore(rootDir);
  assert.equal(restarted.load().ok, true);
  assert.deepEqual(restarted.get('landmarks', 'iron_golem:opaque-a1'), terminal);
});

test('iron-golem collection accepts only exact 3-5 ingot receipts and rejects stale authority atomically', () => {
  for (const ironIngots of [3, 4, 5]) {
    const store = sessionStore();
    store.load();
    const inserted = store.ingestDiscovery({
      id: `iron_golem:valid-${ironIngots}`,
      type: 'iron_golem',
      confidence: 1,
      lastSeen: 900,
      status: 'verified',
    });
    const result = store.applyIronGolemCollectionReceipt({
      scope: EXACT_TEST_SCOPE,
      opportunityId: `iron_golem:valid-${ironIngots}`,
      expectedOpportunityRevision: inserted.value.revision,
      commandId: `mission-village-golem-${ironIngots}`,
      receiptId: `golem-drop:${ironIngots}`,
      inventoryDelta: { 'minecraft:iron_ingot': ironIngots },
      consumedInventoryDelta: {},
      collectedAt: 1000,
    });
    assert.equal(result.ok, true, `${ironIngots} ingots`);
  }

  const invalidCases = [
    ['two_ingots', { inventoryDelta: { 'minecraft:iron_ingot': 2 } }],
    ['six_ingots', { inventoryDelta: { 'minecraft:iron_ingot': 6 } }],
    ['extra_item', { inventoryDelta: { 'minecraft:iron_ingot': 3, 'minecraft:poppy': 1 } }],
    ['consumed_item', {
      inventoryDelta: { 'minecraft:iron_ingot': 3 },
      consumedInventoryDelta: { 'minecraft:cobblestone': 1 },
    }],
    ['wrong_scope', {
      scope: { ...EXACT_TEST_SCOPE, worldId: 'session:other' },
      inventoryDelta: { 'minecraft:iron_ingot': 3 },
    }],
    ['stale_revision', {
      expectedOpportunityRevision: 2,
      inventoryDelta: { 'minecraft:iron_ingot': 3 },
    }],
  ];
  for (const [name, overrides] of invalidCases) {
    const store = sessionStore();
    store.load();
    const inserted = store.ingestDiscovery({
      id: 'iron_golem:invalid',
      type: 'iron_golem',
      confidence: 1,
      lastSeen: 900,
      status: 'verified',
    });
    const before = store.snapshot();
    const result = store.applyIronGolemCollectionReceipt({
      scope: EXACT_TEST_SCOPE,
      opportunityId: 'iron_golem:invalid',
      expectedOpportunityRevision: inserted.value.revision,
      commandId: 'mission-village-golem-invalid',
      receiptId: `golem-drop:${name}`,
      inventoryDelta: { 'minecraft:iron_ingot': 3 },
      consumedInventoryDelta: {},
      collectedAt: 1000,
      ...overrides,
    });
    assert.equal(result.ok, false, name);
    assert.deepEqual(store.snapshot(), before, `${name} must not partially mutate memory`);
  }
});

test('invalidated and disappeared observations remove value through immediate semantic updates', () => {
  let now = 1_000;
  const store = sessionStore({ clock: () => now });
  store.load();
  const base = {
    id: 'hay:status',
    type: 'hay',
    confidence: 1,
    lastSeen: now,
    status: 'verified',
    details: { type: 'hay', count: 4 },
  };
  store.ingestDiscoveriesBatch([base]);
  now += 1;
  const invalidated = store.ingestDiscoveriesBatch([{ ...base, lastSeen: now, status: 'invalidated' }]);
  assert.equal(invalidated.semanticChanged, true);
  assert.equal(invalidated.storeRevision, 2);
  assert.equal(store.get('resourcePatches', base.id).status, 'invalidated');
  assert.equal(store.get('resourcePatches', base.id).revision, 2);

  now += 1;
  const disappeared = store.ingestDiscoveriesBatch([{ ...base, lastSeen: now, status: 'disappeared' }]);
  assert.equal(disappeared.semanticChanged, true);
  assert.equal(disappeared.storeRevision, 3);
  assert.equal(store.get('resourcePatches', base.id).status, 'disappeared');
  assert.equal(store.get('resourcePatches', base.id).revision, 3);
});

test('batch rejection is per-record and never partially mutates a rejected duplicate', () => {
  const store = sessionStore();
  store.load();
  const result = store.ingestDiscoveriesBatch([
    { id: 'village:one', type: 'village', status: 'verified' },
    { id: 'village:one', type: 'village', status: 'invalidated' },
    { id: '', type: 'village', status: 'verified' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.results.filter((entry) => entry.ok).length, 1);
  assert.equal(result.results.some((entry) => entry.reason === 'duplicate_id'), true);
  assert.equal(store.get('landmarks', 'village:one').status, 'verified');
  assert.equal(store.snapshot().revision, 1);
});

test('all collection caps are exact and eviction is deterministic', () => {
  const store = sessionStore({ clock: () => 5000 });
  store.load();
  for (const [collection, cap] of Object.entries(FABRIC_WORLD_MEMORY_CAPS)) {
    if (collection === 'outcomes') continue;
    let final;
    for (let index = 0; index <= cap; index += 1) {
      final = store.ingest(collection, {
        id: `${collection}:${String(index).padStart(4, '0')}`,
        confidence: 0.5,
        lastSeen: index,
        status: 'observed',
      });
    }
    assert.equal(store.list(collection).length, cap);
    assert.deepEqual(final.evicted, [`${collection}:0000`]);
    assert.equal(store.get(collection, `${collection}:0000`), null);
  }

  const tie = sessionStore();
  tie.load();
  for (let index = 0; index < FABRIC_WORLD_MEMORY_CAPS.landmarks; index += 1) {
    tie.upsertLandmark({
      id: `tie:${String(index).padStart(3, '0')}`,
      confidence: 0.8,
      lastSeen: 10,
      status: 'observed',
    });
  }
  const result = tie.upsertLandmark({
    id: 'tie:new',
    confidence: 0.8,
    lastSeen: 10,
    status: 'observed',
  });
  assert.deepEqual(result.evicted, ['tie:000']);
  assert.deepEqual(tie.list('landmarks').map((entry) => entry.id), [
    ...Array.from({ length: FABRIC_WORLD_MEMORY_CAPS.landmarks - 1 }, (_, index) => (
      `tie:${String(index + 1).padStart(3, '0')}`
    )),
    'tie:new',
  ]);
});

test('outcome history is stable-id upserted and bounded to sixteen', () => {
  const store = sessionStore();
  store.load();
  for (let index = 0; index <= FABRIC_WORLD_MEMORY_CAPS.outcomes; index += 1) {
    store.appendOutcome({
      id: `detour:${String(index).padStart(2, '0')}`,
      at: index,
      status: index % 2 ? 'failed' : 'completed',
      elapsedMs: index * 10,
    });
  }
  assert.equal(store.snapshot().outcomes.length, 16);
  assert.equal(store.snapshot().outcomes[0].id, 'detour:01');

  const updated = store.appendOutcome({
    id: 'detour:01',
    at: 99,
    status: 'completed',
    elapsedMs: 123,
  });
  assert.equal(updated.value.revision, 2);
  assert.equal(store.snapshot().outcomes.at(-1).id, 'detour:01');
  assert.equal(store.snapshot().outcomes.at(-1).details.elapsedMs, 123);
});

test('persistent writes survive restart and leave no temporary file', () => {
  const rootDir = tempRoot();
  const store = persistentStore(rootDir);
  assert.equal(store.load().reason, 'not_found');
  assert.equal(store.upsertContainer({
    id: 'chest:10:64:20',
    confidence: 1,
    lastSeen: 1000,
    status: 'inspected',
    type: 'chest',
    contentsKnown: true,
    items: {},
  }).persisted, true);
  assert.equal(store.appendOutcome({
    id: 'chest:10:64:20:inspection',
    at: 1000,
    status: 'empty',
  }).persisted, true);
  assert.equal(store.flush().persisted, true);
  assert.deepEqual(
    fs.readdirSync(store.scopeDir).filter((name) => name.includes('.tmp-')),
    [],
  );

  const restarted = persistentStore(rootDir);
  const loaded = restarted.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.reason, 'loaded');
  assert.equal(restarted.get('containers', 'chest:10:64:20').status, 'inspected');
  assert.equal(restarted.snapshot().outcomes[0].status, 'empty');
});

test('remote session without configured id never writes or crosses restart', () => {
  const rootDir = tempRoot();
  const options = {
    rootDir,
    remote: true,
    worldId: 'server.example:25565',
    dimension: 'minecraft:overworld',
    mission: 'iron-armor',
  };
  const first = new FabricWorldMemoryStore(options);
  assert.equal(first.load().persistenceEligible, false);
  first.upsertLandmark({ id: 'village:remote', status: 'observed' });
  assert.equal(first.snapshot().landmarks.length, 1);
  assert.equal(fs.readdirSync(rootDir).length, 0);

  const second = new FabricWorldMemoryStore(options);
  assert.equal(second.load().value.landmarks.length, 0);
});

test('configured remote identity persists while observed server label is ignored', () => {
  const rootDir = tempRoot();
  const options = {
    rootDir,
    remote: true,
    worldId: 'first-address',
    configuredWorldId: 'private-world',
    dimension: 'minecraft:overworld',
    mission: 'dragon',
  };
  const first = new FabricWorldMemoryStore(options);
  first.load();
  first.upsertLandmark({ id: 'village:persisted', status: 'verified' });

  const second = new FabricWorldMemoryStore({ ...options, worldId: 'changed-address' });
  assert.equal(second.load().value.landmarks[0].id, 'village:persisted');

  const resolvedScope = resolveFabricWorldMemoryScope(options);
  const fromResolvedScope = new FabricWorldMemoryStore({ rootDir, scope: resolvedScope });
  assert.equal(fromResolvedScope.load().value.landmarks[0].id, 'village:persisted');
});

test('corruption fails empty and session-local without overwriting evidence', () => {
  const rootDir = tempRoot();
  const store = persistentStore(rootDir);
  store.load();
  store.upsertLandmark({ id: 'village:before-corruption', status: 'verified' });
  fs.writeFileSync(store.statePath, '{ definitely not json');

  const restarted = persistentStore(rootDir);
  const loaded = restarted.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'corrupt_state');
  assert.equal(loaded.persistenceEligible, false);
  assert.equal(restarted.snapshot().landmarks.length, 0);
  restarted.upsertLandmark({ id: 'village:session-only', status: 'observed' });
  assert.equal(fs.readFileSync(store.statePath, 'utf8'), '{ definitely not json');
});

test('corrupt persisted known-container item maps fail empty and session-local atomically', () => {
  const corruptMaps = [
    ['fractional count', { 'minecraft:bread': 1.5 }],
    ['invalid item id', { bread: 1 }],
    ['mixed valid and invalid entries', {
      'minecraft:bread': 2,
      'minecraft:iron_ingot': 0,
    }],
  ];

  for (const [label, items] of corruptMaps) {
    const rootDir = tempRoot();
    const store = persistentStore(rootDir);
    store.load();
    store.upsertLandmark({ id: `village:${label}`, status: 'verified' });
    store.upsertContainer({
      id: `container:${label}`,
      status: 'inspected',
      details: {
        contentsKnown: true,
        items: { 'minecraft:bread': 1 },
      },
    });
    const raw = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
    raw.containers[0].details.items = items;
    const corruptEvidence = JSON.stringify(raw);
    fs.writeFileSync(store.statePath, corruptEvidence);

    const restarted = persistentStore(rootDir);
    const loaded = restarted.load();
    assert.equal(loaded.ok, false, label);
    assert.equal(loaded.reason, 'corrupt_state', label);
    assert.equal(loaded.persistenceEligible, false, label);
    assert.equal(restarted.snapshot().revision, 0, label);
    assert.deepEqual(restarted.snapshot().landmarks, [], label);
    assert.deepEqual(restarted.snapshot().containers, [], label);

    restarted.upsertLandmark({ id: 'village:session-only', status: 'observed' });
    assert.equal(fs.readFileSync(store.statePath, 'utf8'), corruptEvidence, label);
  }
});

test('persisted known-container contents may be explicitly empty', () => {
  const rootDir = tempRoot();
  const store = persistentStore(rootDir);
  store.load();
  store.upsertContainer({
    id: 'container:known-empty',
    status: 'inspected',
    details: { contentsKnown: true, items: {} },
  });

  const restarted = persistentStore(rootDir);
  const loaded = restarted.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.reason, 'loaded');
  assert.equal(loaded.persistenceEligible, true);
  assert.deepEqual(restarted.get('containers', 'container:known-empty').details.items, {});
});

test('identity mismatch fails empty and session-local', () => {
  const rootDir = tempRoot();
  const store = persistentStore(rootDir);
  store.load();
  store.upsertLandmark({ id: 'village:original', status: 'verified' });
  const raw = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
  raw.identity.dimension = 'minecraft:the_nether';
  fs.writeFileSync(store.statePath, JSON.stringify(raw));

  const restarted = persistentStore(rootDir);
  const loaded = restarted.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'identity_mismatch');
  assert.equal(loaded.persistenceEligible, false);
  assert.deepEqual(restarted.snapshot().landmarks, []);
});

test('inventory, equipment, and durability are never retained or persisted', () => {
  const rootDir = tempRoot();
  const store = persistentStore(rootDir);
  store.load();
  store.upsertLandmark({
    id: 'village:no-owned-state',
    status: 'verified',
    type: 'village',
    inventory: { iron_ingot: 12 },
    nested: {
      equipment: ['iron_pickaxe'],
      toolDurability: 188,
      safeEvidence: 'beds=4',
    },
  });
  const record = store.get('landmarks', 'village:no-owned-state');
  assert.deepEqual(record.details, {
    nested: { safeEvidence: 'beds=4' },
    type: 'village',
  });
  const persisted = fs.readFileSync(store.statePath, 'utf8');
  assert.doesNotMatch(persisted, /inventory|equipment|durability/i);
});

test('persist failure leaves the prior in-memory state unchanged', () => {
  const rootDir = path.join(tempRoot(), 'not-a-directory');
  fs.writeFileSync(rootDir, 'occupied');
  const store = persistentStore(rootDir);
  const before = store.snapshot();
  const result = store.upsertLandmark({ id: 'village:cannot-write', status: 'observed' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'persist_failed');
  assert.deepEqual(store.snapshot(), before);
});

test('persisted inventory-shaped corruption is rejected rather than trusted', () => {
  const rootDir = tempRoot();
  const store = persistentStore(rootDir);
  store.load();
  store.upsertLandmark({ id: 'village:valid', status: 'verified' });
  const raw = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
  raw.inventory = { iron_ingot: 64 };
  fs.writeFileSync(store.statePath, JSON.stringify(raw));

  const restarted = persistentStore(rootDir);
  const loaded = restarted.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'forbidden_inventory_state');
  assert.equal(loaded.persistenceEligible, false);
  assert.equal(restarted.snapshot().revision, 0);
});

test('record ordering and serialized details are deterministic', () => {
  const store = sessionStore();
  store.load();
  store.upsertLandmark({
    id: 'z-last',
    status: 'observed',
    details: { z: 3, a: 1, middle: 2 },
  });
  store.upsertLandmark({ id: 'a-first', status: 'observed' });
  assert.deepEqual(store.list('landmarks').map((entry) => entry.id), ['a-first', 'z-last']);
  assert.deepEqual(Object.keys(store.get('landmarks', 'z-last').details), ['a', 'middle', 'z']);
});

test('invalid identities, collections, records, and timestamps fail closed', () => {
  assert.throws(() => resolveFabricWorldMemoryScope({
    worldId: 'world-139',
    dimension: '',
    mission: 'iron-armor',
  }), /worldId|dimension|mission/);
  const store = sessionStore();
  store.load();
  assert.throws(() => store.ingest('unknown', { id: 'x' }), /unknown world-memory collection/);
  assert.throws(() => store.upsertLandmark({ id: '', status: 'observed' }), /record id/);
  assert.throws(() => store.upsertLandmark({ id: 'x', status: '', lastSeen: 1 }), /status/);
  assert.throws(() => store.upsertLandmark({ id: 'x', status: 'ok', lastSeen: -1 }), /timestamp/);
});
