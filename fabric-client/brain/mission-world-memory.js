import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FABRIC_WORLD_MEMORY_SCHEMA_VERSION = 1;

export const FABRIC_WORLD_MEMORY_CAPS = Object.freeze({
  landmarks: 256,
  resourcePatches: 512,
  containers: 128,
  routeSummaries: 64,
  outcomes: 16,
});

export const DEFAULT_FABRIC_WORLD_MEMORY_ROOT = path.join(
  os.homedir(),
  '.mcbot',
  'fabric-world-memory',
);

const RECORD_COLLECTIONS = Object.freeze([
  'landmarks',
  'resourcePatches',
  'containers',
  'routeSummaries',
]);
const RECORD_COLLECTION_SET = new Set(RECORD_COLLECTIONS);
const IDENTITY_PART_MAX_LENGTH = 192;
const RECORD_ID_MAX_LENGTH = 192;
const STATUS_MAX_LENGTH = 64;
const CORRELATION_ID_MAX_LENGTH = 192;
const EXACT_CONTAINER_ITEM_LIMIT = 64;
const ITEM_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const CONTAINER_INSPECTION_AUTHORITY = 'inspection_receipt_v1';
const IRON_GOLEM_COLLECTION_AUTHORITY = 'iron_golem_collection_receipt_v1';
const VILLAGE_TRANSACTION_OUTCOME_KIND = 'village_transaction_v1';
const DETAIL_LIMITS = Object.freeze({
  depth: 5,
  arrayLength: 32,
  objectKeys: 64,
  stringLength: 512,
});
const FORBIDDEN_PERSISTED_KEY = /(inventory|equipment|durability)/i;

/**
 * Resolve the exact memory key and whether it is safe to persist it.
 *
 * A remote server has no durable identity unless MCBOT_WORLD_ID (supplied as
 * configuredWorldId here) is explicit. Its observed address/name may still be
 * useful as a session label, but it never grants persistence authority.
 */
export function resolveFabricWorldMemoryScope(input = {}) {
  const remote = input.remote === true || input.isRemote === true;
  const configuredWorldId = identityPart(input.configuredWorldId, 'configuredWorldId', false);
  const observedWorldId = identityPart(
    input.worldId ?? input.observedWorldId,
    'worldId',
    false,
  );
  const sessionId = identityPart(input.sessionId, 'sessionId', false) || 'anonymous';
  const dimension = identityPart(input.dimension, 'dimension');
  const mission = identityPart(input.mission, 'mission');
  const persistenceRequested = input.persistence !== false;

  if (remote) {
    if (configuredWorldId) {
      return Object.freeze({
        worldId: configuredWorldId,
        dimension,
        mission,
        remote: true,
        identitySource: 'configured_remote',
        persistenceEligible: persistenceRequested,
        persistenceReason: persistenceRequested ? 'configured_remote_world_id' : 'disabled',
      });
    }
    return Object.freeze({
      worldId: observedWorldId || `session:${sessionId}`,
      dimension,
      mission,
      remote: true,
      identitySource: 'session',
      persistenceEligible: false,
      persistenceReason: 'remote_world_id_unconfigured',
    });
  }

  if (!observedWorldId) {
    return Object.freeze({
      worldId: `session:${sessionId}`,
      dimension,
      mission,
      remote: false,
      identitySource: 'session',
      persistenceEligible: false,
      persistenceReason: 'local_world_id_unavailable',
    });
  }

  return Object.freeze({
    worldId: observedWorldId,
    dimension,
    mission,
    remote: false,
    identitySource: 'local_world',
    persistenceEligible: persistenceRequested,
    persistenceReason: persistenceRequested ? 'local_world_id' : 'disabled',
  });
}

export class FabricWorldMemoryStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || DEFAULT_FABRIC_WORLD_MEMORY_ROOT);
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    this._tempSequence = 0;
    const hasSession = options.scope
      || options.worldId
      || options.observedWorldId
      || options.dimension
      || options.mission;
    const scope = hasSession
      ? (options.scope ? sessionScope({ scope: options.scope }) : sessionScope(options))
      : {
          worldId: 'session:uninitialized',
          dimension: 'uninitialized',
          mission: 'uninitialized',
          remote: false,
          identitySource: 'session',
          persistenceEligible: false,
          persistenceReason: 'session_not_loaded',
        };
    this._installScope(scope);
  }

  loadSession(session) {
    this._installScope(sessionScope(session));
    return this.load();
  }

  _installScope(scope) {
    validateScope(scope);
    this.scope = Object.freeze({ ...scope });
    this.identity = Object.freeze({
      worldId: scope.worldId,
      dimension: scope.dimension,
      mission: scope.mission,
    });
    this.persistenceEligible = scope.persistenceEligible === true;
    this.persistenceReason = String(scope.persistenceReason || (
      this.persistenceEligible ? 'eligible' : 'session_only'
    ));
    this.degradedReason = null;
    const scopeDigest = crypto
      .createHash('sha256')
      .update(JSON.stringify([
        this.identity.worldId,
        this.identity.dimension,
        this.identity.mission,
      ]))
      .digest('hex');
    this.scopeDir = path.join(this.rootDir, scopeDigest);
    this.statePath = path.join(this.scopeDir, 'state.json');
    this._state = emptyState(this.identity);
  }

  load() {
    this._state = emptyState(this.identity);
    if (!this.persistenceEligible) {
      return this._loadResult(true, this.persistenceReason);
    }
    if (!fs.existsSync(this.statePath)) {
      return this._loadResult(true, 'not_found');
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return this._degrade('corrupt_state');
    }
    const validation = validatePersistedState(parsed, this.identity);
    if (!validation.ok) return this._degrade(validation.reason);
    this._state = validation.state;
    return this._loadResult(true, 'loaded');
  }

  snapshot() {
    return clone(this._state);
  }

  list(collection) {
    assertCollection(collection);
    return clone(this._state[collection]);
  }

  get(collection, id) {
    assertCollection(collection);
    const normalizedId = recordId(id);
    const found = this._state[collection].find((entry) => entry.id === normalizedId);
    return found ? clone(found) : null;
  }

  upsertLandmark(record) {
    return this.upsert('landmarks', record);
  }

  upsertResourcePatch(record) {
    return this.upsert('resourcePatches', record);
  }

  upsertContainer(record) {
    return this.upsert('containers', record);
  }

  upsertRouteSummary(record) {
    return this.upsert('routeSummaries', record);
  }

  ingest(collectionOrDiscovery, maybeRecord) {
    if (typeof collectionOrDiscovery === 'string') {
      return this.upsert(normalizedCollection(collectionOrDiscovery), maybeRecord);
    }
    if (!collectionOrDiscovery || typeof collectionOrDiscovery !== 'object') {
      throw new TypeError('world-memory discovery must be an object');
    }
    const collection = discoveryCollection(collectionOrDiscovery);
    return this.upsert(collection, collectionOrDiscovery.record || collectionOrDiscovery);
  }

  ingestDiscovery(discovery) {
    return this.ingest(discovery);
  }

  /**
   * Atomically ingest one scanner observation batch with at most one commit.
   * Semantic record changes advance the store/record revisions. An unchanged
   * observation may refresh lastSeen after the coalescing interval without
   * changing either semantic revision, so planner fingerprints stay stable.
   */
  ingestDiscoveriesBatch(discoveries, options = {}) {
    const values = Array.isArray(discoveries) ? discoveries : [];
    const refreshIntervalMs = boundedRefreshInterval(options.refreshIntervalMs);
    const now = timestamp(this.clock());
    const next = clone(this._state);
    const results = [];
    const seen = new Set();
    const touchedCollections = new Set();
    let semanticChanged = false;
    let freshnessChanged = false;

    for (const discovery of values) {
      let collection;
      let id;
      try {
        collection = discoveryCollection(discovery);
        id = recordId(discovery?.record?.id ?? discovery?.id);
      } catch (error) {
        results.push({
          ok: false,
          id: null,
          action: 'rejected',
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const key = `${collection}\u0000${id}`;
      if (seen.has(key)) {
        results.push({ ok: false, id, collection, action: 'rejected', reason: 'duplicate_id' });
        continue;
      }
      seen.add(key);
      touchedCollections.add(collection);
      const record = discovery.record || discovery;
      const entries = next[collection];
      const priorIndex = entries.findIndex((entry) => entry.id === id);
      const prior = priorIndex >= 0 ? entries[priorIndex] : null;
      let normalized;
      try {
        normalized = normalizeRecord(record, prior, now, collection);
      } catch (error) {
        results.push({
          ok: false,
          id,
          collection,
          action: 'rejected',
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (prior == null) {
        entries.push(normalized);
        semanticChanged = true;
        results.push({
          ok: true,
          id,
          collection,
          action: 'inserted',
          semanticChanged: true,
          refreshed: true,
          recordRevision: normalized.revision,
        });
        continue;
      }

      if (!sameRecordSemantics(prior, normalized)) {
        entries[priorIndex] = normalized;
        semanticChanged = true;
        results.push({
          ok: true,
          id,
          collection,
          action: 'updated',
          semanticChanged: true,
          refreshed: normalized.lastSeen > prior.lastSeen,
          recordRevision: normalized.revision,
        });
        continue;
      }

      const observedAt = Math.max(prior.lastSeen, normalized.lastSeen);
      const refreshDue = observedAt > prior.lastSeen
        && observedAt - prior.lastSeen >= refreshIntervalMs;
      if (refreshDue) {
        entries[priorIndex] = { ...prior, lastSeen: observedAt };
        freshnessChanged = true;
        results.push({
          ok: true,
          id,
          collection,
          action: 'refreshed',
          semanticChanged: false,
          refreshed: true,
          recordRevision: prior.revision,
        });
      } else {
        results.push({
          ok: true,
          id,
          collection,
          action: 'coalesced',
          semanticChanged: false,
          refreshed: false,
          recordRevision: prior.revision,
        });
      }
    }

    const evicted = [];
    for (const collection of [...touchedCollections].sort()) {
      const entries = next[collection];
      entries.sort(compareRecordId);
      while (entries.length > FABRIC_WORLD_MEMORY_CAPS[collection]) {
        const victim = entries.reduce((selected, candidate, index) => {
          if (selected == null) return index;
          return compareEviction(candidate, entries[selected]) < 0 ? index : selected;
        }, null);
        evicted.push({ collection, id: entries[victim].id });
        entries.splice(victim, 1);
        semanticChanged = true;
      }
    }

    if (!semanticChanged && !freshnessChanged) {
      return {
        ok: true,
        results,
        evicted,
        storeRevision: this._state.revision,
        persisted: false,
        commitPerformed: false,
        semanticChanged: false,
        freshnessChanged: false,
      };
    }
    if (semanticChanged) next.revision += 1;
    next.updatedAt = now;
    const committed = this._commit(next);
    if (!committed.ok) {
      return {
        ok: false,
        reason: committed.reason,
        error: committed.error,
        results: results.map((entry) => entry.ok
          ? { ...entry, ok: false, action: 'rejected', reason: 'batch_commit_failed' }
          : entry),
        evicted: [],
        storeRevision: this._state.revision,
        persisted: false,
        commitPerformed: true,
        semanticChanged: false,
        freshnessChanged: false,
      };
    }
    return {
      ok: true,
      results: results.map((entry) => entry.ok
        ? { ...entry, retained: this.get(entry.collection, entry.id) != null }
        : entry),
      evicted,
      storeRevision: this._state.revision,
      persisted: committed.persisted,
      commitPerformed: true,
      semanticChanged,
      freshnessChanged,
    };
  }

  upsert(collection, record) {
    assertCollection(collection);
    const now = timestamp(this.clock());
    const next = clone(this._state);
    const entries = next[collection];
    const id = recordId(record?.id);
    const priorIndex = entries.findIndex((entry) => entry.id === id);
    const prior = priorIndex >= 0 ? entries[priorIndex] : null;
    const normalized = normalizeRecord(record, prior, now, collection);
    if (priorIndex >= 0) entries[priorIndex] = normalized;
    else entries.push(normalized);
    entries.sort(compareRecordId);

    const evicted = [];
    while (entries.length > FABRIC_WORLD_MEMORY_CAPS[collection]) {
      const victim = entries.reduce((selected, candidate, index) => {
        if (selected == null) return index;
        return compareEviction(candidate, entries[selected]) < 0 ? index : selected;
      }, null);
      evicted.push(entries[victim].id);
      entries.splice(victim, 1);
    }
    next.revision += 1;
    next.updatedAt = now;
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      value: this.get(collection, id),
      retained: this.get(collection, id) != null,
      evicted: evicted.sort(compareText),
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  remove(collection, id) {
    assertCollection(collection);
    const normalizedId = recordId(id);
    const next = clone(this._state);
    const index = next[collection].findIndex((entry) => entry.id === normalizedId);
    if (index < 0) {
      return {
        ok: true,
        removed: false,
        storeRevision: this._state.revision,
        persisted: false,
      };
    }
    next[collection].splice(index, 1);
    next.revision += 1;
    next.updatedAt = timestamp(this.clock());
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      removed: true,
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  /**
   * Apply one executor-issued container inspection receipt.
   *
   * The receipt is deliberately correlated to the exact memory scope and
   * container revision observed before opening the screen. This makes a late
   * GUI result unable to overwrite a newer container observation or another
   * world's record. Exact contents are opportunity evidence, never player
   * inventory, and remain protected from later scanner observations that can
   * only report an unknown container.
   */
  applyContainerInspectionReceipt(receipt) {
    const before = this._state;
    let normalized;
    try {
      normalized = normalizeContainerInspectionReceipt(receipt);
    } catch (error) {
      return rejectedAtomicUpdate(
        'invalid_receipt',
        before.revision,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!sameIdentity(normalized.scope, this.identity)) {
      return rejectedAtomicUpdate('scope_mismatch', before.revision);
    }
    const priorIndex = before.containers.findIndex((entry) => entry.id === normalized.containerId);
    if (priorIndex < 0) {
      return rejectedAtomicUpdate('container_not_found', before.revision);
    }
    const prior = before.containers[priorIndex];
    if (prior.revision !== normalized.expectedContainerRevision) {
      return rejectedAtomicUpdate('stale_container_revision', before.revision);
    }
    if (normalized.inspectedAt < prior.lastSeen) {
      return rejectedAtomicUpdate('stale_inspection_time', before.revision);
    }
    const priorReceiptId = String(
      prior.details?.contentsReceiptId || prior.details?.inspectionReceiptId || '',
    );
    if (priorReceiptId && priorReceiptId === normalized.receiptId) {
      return rejectedAtomicUpdate('receipt_already_applied', before.revision);
    }

    const next = clone(before);
    const details = sanitizeDetails({
      ...prior.details,
      contentsKnown: true,
      items: normalized.items,
      inspectedAt: normalized.inspectedAt,
      inspectionStatus: normalized.status,
      inspectionAuthority: CONTAINER_INSPECTION_AUTHORITY,
      inspectionCommandId: normalized.commandId,
      inspectionReceiptId: normalized.receiptId,
      contentsUpdatedAt: normalized.inspectedAt,
      contentsCommandId: normalized.commandId,
      contentsReceiptId: normalized.receiptId,
      contentsReceiptKind: 'inspection',
    });
    next.containers[priorIndex] = {
      ...prior,
      revision: prior.revision + 1,
      lastSeen: normalized.inspectedAt,
      status: normalized.status,
      details,
    };
    next.revision += 1;
    next.updatedAt = timestamp(this.clock());
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      action: 'inspection_applied',
      value: this.get('containers', normalized.containerId),
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  /**
   * Apply an inventory-delta-verified withdrawal and its authoritative final
   * container contents. The exact prior revision makes replacement atomic: an
   * executor can never overwrite a chest view that was refreshed or consumed
   * by another receipt, and concurrent container changes are never reconstructed
   * by subtracting from stale remembered contents.
   */
  applyContainerWithdrawalReceipt(receipt) {
    const before = this._state;
    let normalized;
    try {
      normalized = normalizeContainerWithdrawalReceipt(receipt);
    } catch (error) {
      return rejectedAtomicUpdate(
        'invalid_receipt',
        before.revision,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!sameIdentity(normalized.scope, this.identity)) {
      return rejectedAtomicUpdate('scope_mismatch', before.revision);
    }
    const priorIndex = before.containers.findIndex((entry) => entry.id === normalized.containerId);
    if (priorIndex < 0) {
      return rejectedAtomicUpdate('container_not_found', before.revision);
    }
    const prior = before.containers[priorIndex];
    if (prior.revision !== normalized.expectedContainerRevision) {
      return rejectedAtomicUpdate('stale_container_revision', before.revision);
    }
    if (!hasKnownContainerContents(prior)) {
      return rejectedAtomicUpdate('container_contents_unknown', before.revision);
    }
    if (normalized.withdrawnAt < prior.lastSeen) {
      return rejectedAtomicUpdate('stale_withdrawal_time', before.revision);
    }
    const priorContentsReceiptId = String(
      prior.details?.contentsReceiptId || prior.details?.inspectionReceiptId || '',
    );
    if (priorContentsReceiptId && priorContentsReceiptId === normalized.receiptId) {
      return rejectedAtomicUpdate('receipt_already_applied', before.revision);
    }
    const next = clone(before);
    next.containers[priorIndex] = {
      ...prior,
      revision: prior.revision + 1,
      lastSeen: normalized.withdrawnAt,
      status: normalized.status,
      details: sanitizeDetails({
        ...prior.details,
        contentsKnown: true,
        items: normalized.items,
        inspectionStatus: normalized.status,
        contentsUpdatedAt: normalized.withdrawnAt,
        contentsCommandId: normalized.commandId,
        contentsReceiptId: normalized.receiptId,
        contentsReceiptKind: 'withdrawal',
      }),
    };
    next.revision += 1;
    next.updatedAt = timestamp(this.clock());
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      action: 'withdrawal_applied',
      value: this.get('containers', normalized.containerId),
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  /**
   * Retire persisted contents after an exactly correlated executor reports
   * that a previously inspected container changed or could no longer be
   * authoritatively read. The physical container record remains available for
   * a later fresh inspection, but stale remembered loot immediately loses all
   * planner value.
   */
  applyContainerRefreshRequiredReceipt(receipt) {
    const before = this._state;
    let normalized;
    try {
      normalized = normalizeContainerRefreshRequiredReceipt(receipt);
    } catch (error) {
      return rejectedAtomicUpdate(
        'invalid_receipt',
        before.revision,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!sameIdentity(normalized.scope, this.identity)) {
      return rejectedAtomicUpdate('scope_mismatch', before.revision);
    }
    const priorIndex = before.containers.findIndex((entry) => entry.id === normalized.containerId);
    if (priorIndex < 0) return rejectedAtomicUpdate('container_not_found', before.revision);
    const prior = before.containers[priorIndex];
    if (prior.revision !== normalized.expectedContainerRevision) {
      return rejectedAtomicUpdate('stale_container_revision', before.revision);
    }
    if (normalized.observedAt < prior.lastSeen) {
      return rejectedAtomicUpdate('stale_refresh_required_time', before.revision);
    }

    const next = clone(before);
    next.containers[priorIndex] = {
      ...prior,
      revision: prior.revision + 1,
      lastSeen: normalized.observedAt,
      details: sanitizeDetails({
        ...retireKnownContainerContents(prior.details),
        contentsRefreshRequiredAt: normalized.observedAt,
        contentsRefreshRequiredReason: normalized.reason,
        contentsRefreshRequiredCommandId: normalized.commandId,
        contentsRefreshRequiredReceiptId: normalized.receiptId,
      }),
    };
    next.revision += 1;
    next.updatedAt = timestamp(this.clock());
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      action: 'container_refresh_required_applied',
      value: this.get('containers', normalized.containerId),
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  /**
   * Atomically retire one exact iron-golem opportunity after the executor has
   * proved both the correlated kill/drop boundary and a 3-5 iron-ingot player
   * inventory delta. The opaque opportunity id and its record revision are the
   * authority fence; scanner disappearance alone can never award resources.
   */
  applyIronGolemCollectionReceipt(receipt) {
    const before = this._state;
    let normalized;
    try {
      normalized = normalizeIronGolemCollectionReceipt(receipt);
    } catch (error) {
      return rejectedAtomicUpdate(
        'invalid_receipt',
        before.revision,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!sameIdentity(normalized.scope, this.identity)) {
      return rejectedAtomicUpdate('scope_mismatch', before.revision);
    }
    const priorIndex = before.landmarks.findIndex((entry) => entry.id === normalized.opportunityId);
    if (priorIndex < 0) return rejectedAtomicUpdate('golem_not_found', before.revision);
    const prior = before.landmarks[priorIndex];
    if (prior.details?.type !== 'iron_golem') {
      return rejectedAtomicUpdate('opportunity_type_mismatch', before.revision);
    }
    if (prior.revision !== normalized.expectedOpportunityRevision) {
      return rejectedAtomicUpdate('stale_opportunity_revision', before.revision);
    }
    if (normalized.collectedAt < prior.lastSeen) {
      return rejectedAtomicUpdate('stale_collection_time', before.revision);
    }
    if (prior.details?.collectionReceiptId === normalized.receiptId) {
      return rejectedAtomicUpdate('receipt_already_applied', before.revision);
    }
    if (isReceiptTerminalIronGolem(prior)) {
      return rejectedAtomicUpdate('golem_already_collected', before.revision);
    }

    const next = clone(before);
    next.landmarks[priorIndex] = {
      ...prior,
      revision: prior.revision + 1,
      lastSeen: normalized.collectedAt,
      status: 'collected',
      details: sanitizeDetails({
        ...prior.details,
        collectionAuthority: IRON_GOLEM_COLLECTION_AUTHORITY,
        collectionCommandId: normalized.commandId,
        collectionReceiptId: normalized.receiptId,
        collectedAt: normalized.collectedAt,
        collectedIronIngots: normalized.ironIngots,
      }),
    };
    next.revision += 1;
    next.updatedAt = timestamp(this.clock());
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      action: 'iron_golem_collection_applied',
      value: this.get('landmarks', normalized.opportunityId),
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  /**
   * Record a final bounded village-detour outcome with stable command/receipt
   * correlation. Reusing an outcome id for a different receipt is rejected
   * without mutating the existing evidence.
   */
  recordVillageTransactionOutcome(outcome) {
    const before = this._state;
    let normalized;
    try {
      normalized = normalizeVillageTransactionOutcome(outcome, timestamp(this.clock()));
    } catch (error) {
      return rejectedAtomicUpdate(
        'invalid_outcome',
        before.revision,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!sameIdentity(normalized.scope, this.identity)) {
      return rejectedAtomicUpdate('scope_mismatch', before.revision);
    }
    const prior = before.outcomes.find((entry) => entry.id === normalized.id);
    if (prior) {
      const priorCommandId = String(prior.details?.commandId || '');
      const priorReceiptId = String(prior.details?.receiptId || '');
      if (priorCommandId !== normalized.commandId || priorReceiptId !== normalized.receiptId) {
        return rejectedAtomicUpdate('outcome_correlation_mismatch', before.revision);
      }
      return rejectedAtomicUpdate('outcome_already_recorded', before.revision);
    }
    const receiptConflict = before.outcomes.some((entry) => (
      entry.details?.kind === VILLAGE_TRANSACTION_OUTCOME_KIND
      && entry.details?.commandId === normalized.commandId
      && entry.details?.receiptId === normalized.receiptId
    ));
    if (receiptConflict) {
      return rejectedAtomicUpdate('outcome_receipt_conflict', before.revision);
    }
    return this.recordOutcome({
      id: normalized.id,
      at: normalized.at,
      status: normalized.status,
      details: {
        ...normalized.details,
        kind: VILLAGE_TRANSACTION_OUTCOME_KIND,
        commandId: normalized.commandId,
        receiptId: normalized.receiptId,
      },
    });
  }

  recordOutcome(outcome) {
    const now = timestamp(this.clock());
    const next = clone(this._state);
    const id = recordId(outcome?.id);
    const priorIndex = next.outcomes.findIndex((entry) => entry.id === id);
    const prior = priorIndex >= 0 ? next.outcomes[priorIndex] : null;
    const normalized = normalizeOutcome(outcome, prior, now);
    if (priorIndex >= 0) next.outcomes[priorIndex] = normalized;
    else next.outcomes.push(normalized);
    next.outcomes.sort(compareOutcomeOrder);
    const evicted = [];
    while (next.outcomes.length > FABRIC_WORLD_MEMORY_CAPS.outcomes) {
      evicted.push(next.outcomes.shift().id);
    }
    next.revision += 1;
    next.updatedAt = now;
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      value: clone(this._state.outcomes.find((entry) => entry.id === id) || null),
      retained: this._state.outcomes.some((entry) => entry.id === id),
      evicted,
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  appendOutcome(outcome) {
    return this.recordOutcome(outcome);
  }

  flush() {
    return this._commit(clone(this._state));
  }

  clear() {
    const next = emptyState(this.identity);
    next.revision = this._state.revision + 1;
    next.updatedAt = timestamp(this.clock());
    const committed = this._commit(next);
    if (!committed.ok) return committed;
    return {
      ok: true,
      storeRevision: this._state.revision,
      persisted: committed.persisted,
    };
  }

  _commit(next) {
    if (!this.persistenceEligible) {
      this._state = next;
      return { ok: true, persisted: false };
    }
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    let tempPath = null;
    try {
      fs.mkdirSync(this.scopeDir, { recursive: true });
      tempPath = `${this.statePath}.tmp-${process.pid}-${++this._tempSequence}`;
      const descriptor = fs.openSync(tempPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, serialized, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(tempPath, this.statePath);
      fsyncDirectoryBestEffort(this.scopeDir);
      this._state = next;
      return { ok: true, persisted: true };
    } catch (error) {
      if (tempPath) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // The original write failure remains authoritative.
        }
      }
      return {
        ok: false,
        reason: 'persist_failed',
        error: error instanceof Error ? error.message : String(error),
        persisted: false,
      };
    }
  }

  _degrade(reason) {
    this._state = emptyState(this.identity);
    this.persistenceEligible = false;
    this.persistenceReason = 'session_only_after_load_failure';
    this.degradedReason = reason;
    return this._loadResult(false, reason);
  }

  _loadResult(ok, reason) {
    return {
      ok,
      reason,
      persistenceEligible: this.persistenceEligible,
      persistenceReason: this.persistenceReason,
      degradedReason: this.degradedReason,
      value: this.snapshot(),
    };
  }
}

export function createFabricWorldMemoryStore(options = {}) {
  return new FabricWorldMemoryStore(options);
}

function emptyState(identity) {
  return {
    schemaVersion: FABRIC_WORLD_MEMORY_SCHEMA_VERSION,
    identity: { ...identity },
    revision: 0,
    updatedAt: 0,
    landmarks: [],
    resourcePatches: [],
    containers: [],
    routeSummaries: [],
    outcomes: [],
  };
}

function sessionScope(input = {}, trustedResolvedScope = false) {
  if (input.scope && typeof input.scope === 'object') return sessionScope(input.scope, true);
  if (trustedResolvedScope) {
    return Object.freeze({
      worldId: identityPart(input.worldId, 'worldId'),
      dimension: identityPart(input.dimension, 'dimension'),
      mission: identityPart(input.mission, 'mission'),
      remote: input.remote === true,
      identitySource: String(input.identitySource || 'resolved'),
      persistenceEligible: input.persistenceEligible === true,
      persistenceReason: String(input.persistenceReason || (
        input.persistenceEligible ? 'resolved_eligible' : 'session_only'
      )),
    });
  }
  if (Object.hasOwn(input, 'persistenceEligible') && !input.remote && !input.isRemote) {
    const worldId = identityPart(input.worldId, 'worldId');
    const dimension = identityPart(input.dimension, 'dimension');
    const mission = identityPart(input.mission, 'mission');
    return Object.freeze({
      worldId,
      dimension,
      mission,
      remote: false,
      identitySource: String(input.identitySource || (
        input.persistenceEligible ? 'coordinator' : 'session'
      )),
      persistenceEligible: input.persistenceEligible === true,
      persistenceReason: String(input.persistenceReason || (
        input.persistenceEligible ? 'coordinator_eligible' : 'session_only'
      )),
    });
  }
  return resolveFabricWorldMemoryScope(input);
}

function normalizedCollection(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'landmark' || key === 'landmarks') return 'landmarks';
  if (key === 'resource' || key === 'resources' || key === 'resourcepatch' || key === 'resourcepatches') {
    return 'resourcePatches';
  }
  if (key === 'container' || key === 'containers') return 'containers';
  if (key === 'route' || key === 'routes' || key === 'routesummary' || key === 'routesummaries') {
    return 'routeSummaries';
  }
  throw new TypeError(`unknown world-memory collection: ${String(value)}`);
}

function discoveryCollection(discovery) {
  const explicit = discovery.collection ?? discovery.memoryKind ?? discovery.kind;
  if (explicit != null) {
    try {
      return normalizedCollection(explicit);
    } catch {
      // Some scanners use kind for the discovery's semantic type. Fall
      // through to the bounded type mapping rather than widening the store.
    }
  }
  const type = String(discovery.type ?? discovery.kind ?? '').trim().toLowerCase();
  if (['container', 'chest', 'barrel'].includes(type)) return 'containers';
  if (['route', 'route_summary'].includes(type)) return 'routeSummaries';
  if ([
    'resource_patch',
    'exposed_stone',
    'exposed_iron',
    'exposed_coal',
    'hay',
    'hay_bale',
    'passive_food',
  ].includes(type)) return 'resourcePatches';
  if ([
    'landmark',
    'village',
    'village_marker',
    'villager',
    'iron_golem',
    'bed',
    'ruined_portal',
  ].includes(type)) return 'landmarks';
  throw new TypeError('world-memory discovery collection is required');
}

function normalizeRecord(input, prior, now, collection = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('world-memory record must be an object');
  }
  const id = recordId(input.id);
  const confidence = input.confidence == null
    ? (prior?.confidence ?? 1)
    : boundedConfidence(input.confidence);
  const lastSeen = input.lastSeen == null ? now : timestamp(input.lastSeen);
  const status = normalizedStatus(input.status ?? prior?.status ?? 'active');
  const sourceDetails = input.details && typeof input.details === 'object' && !Array.isArray(input.details)
    ? input.details
    : extractRecordDetails(input);
  let details = sanitizeDetails(sourceDetails);
  // An executor-correlated golem collection is terminal for that opaque
  // entity opportunity. A delayed scanner observation of the same UUID may
  // refresh when it was last seen, but it cannot resurrect the opportunity or
  // discard the receipt authority.
  if (collection === 'landmarks' && isReceiptTerminalIronGolem(prior)) {
    return {
      ...prior,
      lastSeen: Math.max(prior.lastSeen, lastSeen),
    };
  }
  if (collection === 'containers' && status === 'disappeared') {
    details = retireKnownContainerContents(details);
  } else if (collection === 'containers'
      && hasKnownContainerContents(prior)
      && !hasKnownContainerContents({ details })) {
    details = preserveKnownContainerContents(prior.details, details);
  }
  return {
    id,
    revision: (prior?.revision || 0) + 1,
    confidence,
    lastSeen,
    status,
    details,
  };
}

function isReceiptTerminalIronGolem(record) {
  return record?.details?.type === 'iron_golem'
    && record.status === 'collected'
    && record.details?.collectionAuthority === IRON_GOLEM_COLLECTION_AUTHORITY
    && typeof record.details?.collectionReceiptId === 'string'
    && record.details.collectionReceiptId.length > 0;
}

function hasKnownContainerContents(record) {
  return record?.details?.contentsKnown === true
    && record.details.items != null
    && typeof record.details.items === 'object'
    && !Array.isArray(record.details.items);
}

function preserveKnownContainerContents(priorDetails, observedDetails) {
  return sanitizeDetails({
    ...observedDetails,
    contentsKnown: true,
    items: priorDetails.items,
    inspectedAt: priorDetails.inspectedAt,
    inspectionStatus: priorDetails.inspectionStatus,
    inspectionAuthority: priorDetails.inspectionAuthority,
    inspectionCommandId: priorDetails.inspectionCommandId,
    inspectionReceiptId: priorDetails.inspectionReceiptId,
    contentsUpdatedAt: priorDetails.contentsUpdatedAt,
    contentsCommandId: priorDetails.contentsCommandId,
    contentsReceiptId: priorDetails.contentsReceiptId,
    contentsReceiptKind: priorDetails.contentsReceiptKind,
  });
}

function retireKnownContainerContents(observedDetails) {
  const {
    contentsKnown: _contentsKnown,
    items: _items,
    inspectedAt: _inspectedAt,
    inspectionStatus: _inspectionStatus,
    inspectionAuthority: _inspectionAuthority,
    inspectionCommandId: _inspectionCommandId,
    inspectionReceiptId: _inspectionReceiptId,
    contentsUpdatedAt: _contentsUpdatedAt,
    contentsCommandId: _contentsCommandId,
    contentsReceiptId: _contentsReceiptId,
    contentsReceiptKind: _contentsReceiptKind,
    ...rest
  } = observedDetails;
  return sanitizeDetails({ ...rest, contentsKnown: false, items: {} });
}

function normalizeContainerInspectionReceipt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('container inspection receipt must be an object');
  }
  const expectedContainerRevision = Number(input.expectedContainerRevision);
  if (!Number.isSafeInteger(expectedContainerRevision) || expectedContainerRevision < 1) {
    throw new TypeError('expectedContainerRevision must be a positive safe integer');
  }
  return {
    scope: exactReceiptScope(input.scope),
    containerId: recordId(input.containerId),
    expectedContainerRevision,
    commandId: correlationId(input.commandId, 'commandId'),
    receiptId: correlationId(input.receiptId, 'receiptId'),
    items: normalizeExactContainerItems(input.items),
    inspectedAt: timestamp(input.inspectedAt),
    status: normalizedStatus(input.status),
  };
}

function normalizeContainerWithdrawalReceipt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('container withdrawal receipt must be an object');
  }
  const expectedContainerRevision = Number(input.expectedContainerRevision);
  if (!Number.isSafeInteger(expectedContainerRevision) || expectedContainerRevision < 1) {
    throw new TypeError('expectedContainerRevision must be a positive safe integer');
  }
  const withdrawnItems = normalizeExactContainerItems(input.withdrawnItems);
  if (Object.keys(withdrawnItems).length === 0) {
    throw new TypeError('withdrawnItems must contain an exact positive count');
  }
  const items = normalizeExactContainerItems(input.items);
  return {
    scope: exactReceiptScope(input.scope),
    containerId: recordId(input.containerId),
    expectedContainerRevision,
    commandId: correlationId(input.commandId, 'commandId'),
    receiptId: correlationId(input.receiptId, 'receiptId'),
    withdrawnItems,
    items,
    withdrawnAt: timestamp(input.withdrawnAt),
    status: normalizedStatus(input.status),
  };
}

function normalizeContainerRefreshRequiredReceipt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('container refresh-required receipt must be an object');
  }
  const expectedContainerRevision = Number(input.expectedContainerRevision);
  if (!Number.isSafeInteger(expectedContainerRevision) || expectedContainerRevision < 1) {
    throw new TypeError('expectedContainerRevision must be a positive safe integer');
  }
  return {
    scope: exactReceiptScope(input.scope),
    containerId: recordId(input.containerId),
    expectedContainerRevision,
    commandId: correlationId(input.commandId, 'commandId'),
    receiptId: correlationId(input.receiptId, 'receiptId'),
    observedAt: timestamp(input.observedAt),
    reason: correlationId(input.reason, 'reason'),
  };
}

function normalizeIronGolemCollectionReceipt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('iron-golem collection receipt must be an object');
  }
  const expectedOpportunityRevision = Number(input.expectedOpportunityRevision);
  if (!Number.isSafeInteger(expectedOpportunityRevision) || expectedOpportunityRevision < 1) {
    throw new TypeError('expectedOpportunityRevision must be a positive safe integer');
  }
  const inventoryDelta = normalizeExactContainerItems(input.inventoryDelta);
  const deltaEntries = Object.entries(inventoryDelta);
  if (deltaEntries.length !== 1 || deltaEntries[0][0] !== 'minecraft:iron_ingot') {
    throw new TypeError('inventoryDelta must contain only minecraft:iron_ingot');
  }
  const ironIngots = deltaEntries[0][1];
  if (ironIngots < 3 || ironIngots > 5) {
    throw new TypeError('iron-golem receipt must prove 3-5 iron ingots');
  }
  const consumed = input.consumedInventoryDelta == null
    ? {}
    : normalizeExactContainerItems(input.consumedInventoryDelta);
  if (Object.keys(consumed).length !== 0) {
    throw new TypeError('iron-golem receipt cannot consume inventory items');
  }
  return {
    scope: exactReceiptScope(input.scope),
    opportunityId: recordId(input.opportunityId),
    expectedOpportunityRevision,
    commandId: correlationId(input.commandId, 'commandId'),
    receiptId: correlationId(input.receiptId, 'receiptId'),
    collectedAt: timestamp(input.collectedAt),
    ironIngots,
  };
}

function normalizeVillageTransactionOutcome(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('village transaction outcome must be an object');
  }
  const commandId = correlationId(input.commandId, 'commandId');
  const receiptId = correlationId(input.receiptId, 'receiptId');
  const sourceDetails = input.details && typeof input.details === 'object' && !Array.isArray(input.details)
    ? input.details
    : {};
  return {
    scope: exactReceiptScope(input.scope),
    id: recordId(input.id ?? `village:${commandId}:${receiptId}`),
    commandId,
    receiptId,
    at: input.at == null ? now : timestamp(input.at),
    status: normalizedStatus(input.status),
    details: sanitizeDetails(sourceDetails),
  };
}

function exactReceiptScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('receipt scope is required');
  }
  return {
    worldId: identityPart(value.worldId, 'worldId'),
    dimension: identityPart(value.dimension, 'dimension'),
    mission: identityPart(value.mission, 'mission'),
  };
}

function correlationId(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized
      || normalized.length > CORRELATION_ID_MAX_LENGTH
      || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function normalizeExactContainerItems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('container items must be an exact item-count object');
  }
  const keys = Object.keys(value).sort(compareText);
  if (keys.length > EXACT_CONTAINER_ITEM_LIMIT) {
    throw new TypeError('container item-count limit exceeded');
  }
  const result = {};
  for (const itemId of keys) {
    if (!ITEM_ID_RE.test(itemId)) throw new TypeError(`invalid container item id: ${itemId}`);
    const count = value[itemId];
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new TypeError(`invalid exact count for ${itemId}`);
    }
    result[itemId] = count;
  }
  return result;
}

function rejectedAtomicUpdate(reason, storeRevision, error = undefined) {
  return {
    ok: false,
    action: 'rejected',
    reason,
    ...(error ? { error } : {}),
    storeRevision,
    persisted: false,
  };
}

function sameRecordSemantics(left, right) {
  return left.id === right.id
    && left.confidence === right.confidence
    && left.status === right.status
    && JSON.stringify(left.details) === JSON.stringify(right.details);
}

function boundedRefreshInterval(value) {
  return Number.isSafeInteger(value) && value >= 1_000
    ? Math.min(3_600_000, value)
    : 30_000;
}

function normalizeOutcome(input, prior, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('world-memory outcome must be an object');
  }
  const id = recordId(input.id);
  const at = input.at == null ? now : timestamp(input.at);
  const status = normalizedStatus(input.status ?? prior?.status ?? 'observed');
  const sourceDetails = input.details && typeof input.details === 'object' && !Array.isArray(input.details)
    ? input.details
    : extractRecordDetails(input, new Set(['at']));
  return {
    id,
    revision: (prior?.revision || 0) + 1,
    at,
    status,
    details: sanitizeDetails(sourceDetails),
  };
}

function extractRecordDetails(input, extraReserved = new Set()) {
  const reserved = new Set([
    'id',
    'revision',
    'confidence',
    'lastSeen',
    'status',
    'details',
    'collection',
    'memoryKind',
    'kind',
    'record',
    ...extraReserved,
  ]);
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !reserved.has(key)),
  );
}

function sanitizeDetails(value, depth = 0) {
  if (depth > DETAIL_LIMITS.depth) return null;
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, DETAIL_LIMITS.stringLength);
  if (Array.isArray(value)) {
    return value
      .slice(0, DETAIL_LIMITS.arrayLength)
      .map((entry) => sanitizeDetails(entry, depth + 1));
  }
  if (typeof value !== 'object') return null;
  const output = {};
  const keys = Object.keys(value)
    .filter((key) => !FORBIDDEN_PERSISTED_KEY.test(key))
    .sort(compareText)
    .slice(0, DETAIL_LIMITS.objectKeys);
  for (const key of keys) output[key] = sanitizeDetails(value[key], depth + 1);
  return output;
}

function validatePersistedState(value, identity) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'corrupt_state' };
  }
  if (containsForbiddenKey(value)) return { ok: false, reason: 'forbidden_inventory_state' };
  if (value.schemaVersion !== FABRIC_WORLD_MEMORY_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema_mismatch' };
  }
  if (!sameIdentity(value.identity, identity)) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    return { ok: false, reason: 'corrupt_state' };
  }
  if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    return { ok: false, reason: 'corrupt_state' };
  }

  const state = emptyState(identity);
  state.revision = value.revision;
  state.updatedAt = value.updatedAt;
  for (const collection of RECORD_COLLECTIONS) {
    if (!Array.isArray(value[collection]) || value[collection].length > FABRIC_WORLD_MEMORY_CAPS[collection]) {
      return { ok: false, reason: 'corrupt_state' };
    }
    const seen = new Set();
    for (const raw of value[collection]) {
      const validated = validateStoredRecord(raw, collection);
      if (!validated || seen.has(validated.id)) return { ok: false, reason: 'corrupt_state' };
      seen.add(validated.id);
      state[collection].push(validated);
    }
    state[collection].sort(compareRecordId);
  }
  if (!Array.isArray(value.outcomes) || value.outcomes.length > FABRIC_WORLD_MEMORY_CAPS.outcomes) {
    return { ok: false, reason: 'corrupt_state' };
  }
  const outcomeIds = new Set();
  for (const raw of value.outcomes) {
    const validated = validateStoredOutcome(raw);
    if (!validated || outcomeIds.has(validated.id)) return { ok: false, reason: 'corrupt_state' };
    outcomeIds.add(validated.id);
    state.outcomes.push(validated);
  }
  state.outcomes.sort(compareOutcomeOrder);
  return { ok: true, state };
}

function validateStoredRecord(value, collection) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = recordId(value.id);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return null;
    if (!Number.isFinite(value.lastSeen) || value.lastSeen < 0) return null;
    const status = normalizedStatus(value.status);
    if (!value.details || typeof value.details !== 'object' || Array.isArray(value.details)) return null;
    const details = sanitizeDetails(value.details);
    if (collection === 'containers' && value.details.contentsKnown === true) {
      details.items = normalizeExactContainerItems(value.details.items);
    }
    return {
      id,
      revision: value.revision,
      confidence: value.confidence,
      lastSeen: value.lastSeen,
      status,
      details,
    };
  } catch {
    return null;
  }
}

function validateStoredOutcome(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = recordId(value.id);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    if (!Number.isFinite(value.at) || value.at < 0) return null;
    const status = normalizedStatus(value.status);
    if (!value.details || typeof value.details !== 'object' || Array.isArray(value.details)) return null;
    return {
      id,
      revision: value.revision,
      at: value.at,
      status,
      details: sanitizeDetails(value.details),
    };
  } catch {
    return null;
  }
}

function containsForbiddenKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry, seen));
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_PERSISTED_KEY.test(key) || containsForbiddenKey(child, seen)
  ));
}

function sameIdentity(left, right) {
  return left
    && left.worldId === right.worldId
    && left.dimension === right.dimension
    && left.mission === right.mission;
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object') throw new TypeError('world-memory scope is required');
  identityPart(scope.worldId, 'worldId');
  identityPart(scope.dimension, 'dimension');
  identityPart(scope.mission, 'mission');
}

function identityPart(value, name, required = true) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    if (!required) return '';
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (normalized.length > IDENTITY_PART_MAX_LENGTH || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function recordId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > RECORD_ID_MAX_LENGTH || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError('world-memory record id is invalid');
  }
  return normalized;
}

function normalizedStatus(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > STATUS_MAX_LENGTH || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError('world-memory status is invalid');
  }
  return normalized;
}

function boundedConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError('world-memory confidence must be finite');
  return Math.max(0, Math.min(1, numeric));
}

function timestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new TypeError('world-memory timestamp must be a non-negative finite number');
  }
  return Math.floor(numeric);
}

function assertCollection(collection) {
  if (!RECORD_COLLECTION_SET.has(collection)) {
    throw new TypeError(`unknown world-memory collection: ${String(collection)}`);
  }
}

function compareEviction(left, right) {
  if (left.lastSeen !== right.lastSeen) return left.lastSeen - right.lastSeen;
  if (left.confidence !== right.confidence) return left.confidence - right.confidence;
  return compareText(left.id, right.id);
}

function compareRecordId(left, right) {
  return compareText(left.id, right.id);
}

function compareOutcomeOrder(left, right) {
  if (left.at !== right.at) return left.at - right.at;
  return compareText(left.id, right.id);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function clone(value) {
  return structuredClone(value);
}

function fsyncDirectoryBestEffort(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // File fsync plus same-directory rename is the portable guarantee. Some
    // Windows filesystems do not permit opening directories for fsync.
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Nothing useful can be done after the atomic rename has succeeded.
      }
    }
  }
}
