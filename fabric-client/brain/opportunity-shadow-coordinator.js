import crypto from 'node:crypto';

import { createMissionResourceLedger, normalizeExactItemCounts } from './opportunity-ledger.js';
import {
  FabricWorldMemoryStore,
  resolveFabricWorldMemoryScope,
} from './mission-world-memory.js';
import { OpportunityRoutePlanner } from './opportunity-route-planner.js';
import {
  VILLAGE_AGGREGATE_MEMBER_LIMITS,
  villageOpportunityInventoryFingerprint,
  villageOpportunitySemanticFingerprint,
} from './village-opportunity-transaction.js';

export const FABRIC_OPPORTUNITY_MODES = Object.freeze(['off', 'shadow', 'active']);
export const DEFAULT_FABRIC_OPPORTUNITY_CONFIG = Object.freeze({
  mode: 'off',
  maxDiscoveries: 256,
  freshnessRefreshMs: 30_000,
  freshnessPenaltyMs: 120_000,
  freshnessRejectMs: 300_000,
});

const MODE_SET = new Set(FABRIC_OPPORTUNITY_MODES);
const ID_RE = /^[a-zA-Z0-9_.:-]{1,96}$/;
const MAX_REJECTION_DIAGNOSTICS = 8;
const DISCOVERY_TYPE_ALIASES = Object.freeze({
  village_marker_cluster: 'village',
  village_cluster: 'village',
  hay_bale: 'hay',
  hay_bales: 'hay',
  exposed_iron_ore: 'exposed_iron',
  exposed_coal_ore: 'exposed_coal',
  ruined_portal_evidence: 'ruined_portal',
});
const SUPPORTED_TYPES = new Set([
  'village', 'villager', 'iron_golem', 'hay', 'bed', 'container',
  'exposed_stone', 'exposed_iron', 'exposed_coal', 'passive_food',
  'ruined_portal',
]);
const CODE_OWNED_DISCOVERY_EXECUTORS = Object.freeze({
  village: Object.freeze({
    capabilityId: 'village_transaction',
    executorId: 'village_revalidate',
  }),
  container: Object.freeze({
    capabilityId: 'village_container',
    executorId: 'village_inspect_container',
  }),
  hay: Object.freeze({
    capabilityId: 'village_hay',
    executorId: 'village_harvest_hay',
  }),
  bed: Object.freeze({
    capabilityId: 'village_bed',
    executorId: 'village_collect_bed',
  }),
  iron_golem: Object.freeze({
    capabilityId: 'village_golem_iron',
    executorId: 'village_defeat_iron_golem',
  }),
  exposed_stone: Object.freeze({
    capabilityId: 'local_exposed_stone',
    executorId: 'mine_nearby_stone',
  }),
  exposed_iron: Object.freeze({
    capabilityId: 'local_exposed_iron',
    executorId: 'mine_nearby_iron',
  }),
  exposed_coal: Object.freeze({
    capabilityId: 'local_exposed_coal',
    executorId: 'mine_nearby_coal',
  }),
});
const CODE_OWNED_READINESS_SOURCE = 'code_owned_registry_v1';
const OBJECTIVE_ORDER = Object.freeze([
  'GATHER_WOOD', 'MAKE_WOOD_TOOLS', 'MINE_STONE', 'MAKE_STONE_TOOLS',
  'MAKE_FURNACE', 'DESCEND', 'MINE_IRON', 'SMELT_IRON',
  'MAKE_IRON_TOOLS', 'MAKE_ARMOR', 'EAT', 'DONE',
]);
const ARMOR = Object.freeze([
  ['equippedHelmetItem', 'minecraft:iron_helmet', 5],
  ['equippedChestplateItem', 'minecraft:iron_chestplate', 8],
  ['equippedLeggingsItem', 'minecraft:iron_leggings', 7],
  ['equippedBootsItem', 'minecraft:iron_boots', 4],
]);
const FOOD_NUTRITION = Object.freeze({
  'minecraft:bread': 5,
  'minecraft:apple': 4,
  'minecraft:golden_apple': 4,
});
const FOOD_RESERVE_TARGET = 25;
const FOOD_RESOURCE = 'mission:food_units';
const MAX_STRATEGY_ENVELOPES_PER_INSTANCE = 8;
const MAX_STRATEGY_OPPORTUNITY_CHOICES = 7;
const MAX_STRATEGY_LEDGER_ENTRIES = 64;
const STRATEGY_MATERIAL_SLOWER_FRACTION = 0.10;
const STRATEGY_MATERIAL_SLOWER_SECONDS = 30;
const PUBLIC_STRATEGY_RESOURCES = new Set([
  'mission:wood_complete', 'mission:equipped_iron_armor', 'mission:fed',
  'mission:food_units', 'mission:iron_units', 'mission:logs', 'mission:planks',
  'mission:beds', 'mission:wool',
  'minecraft:crafting_table', 'minecraft:furnace', 'minecraft:stick',
  'minecraft:cobblestone', 'minecraft:coal', 'minecraft:charcoal',
  'minecraft:wooden_pickaxe', 'minecraft:stone_pickaxe', 'minecraft:stone_sword',
  'minecraft:iron_pickaxe', 'minecraft:iron_sword', 'minecraft:diamond_pickaxe',
  'minecraft:raw_iron', 'minecraft:iron_ingot', 'minecraft:diamond',
  'minecraft:iron_helmet', 'minecraft:iron_chestplate', 'minecraft:iron_leggings',
  'minecraft:iron_boots', 'minecraft:bread', 'minecraft:apple',
  'minecraft:golden_apple', 'minecraft:hay_block', 'minecraft:wheat',
  'minecraft:bucket', 'minecraft:water_bucket', 'minecraft:flint',
  'minecraft:flint_and_steel', 'minecraft:gravel', 'minecraft:string',
  'minecraft:bow', 'minecraft:arrow', 'minecraft:gold_ingot',
  'minecraft:raw_gold', 'minecraft:golden_boots', 'minecraft:obsidian',
  'minecraft:ender_pearl', 'minecraft:blaze_rod', 'minecraft:blaze_powder',
  'minecraft:ender_eye',
]);

export function resolveFabricOpportunityConfig(env = process.env, overrides = {}) {
  const requestedMode = String(
    overrides.mode ?? env.MCBOT_FABRIC_OPPORTUNITY_MODE ?? DEFAULT_FABRIC_OPPORTUNITY_CONFIG.mode,
  ).trim().toLowerCase();
  const valid = MODE_SET.has(requestedMode);
  return Object.freeze({
    mode: valid ? requestedMode : 'off',
    requestedMode,
    rejectedReason: valid ? null : 'invalid_mode',
    maxDiscoveries: boundedInteger(
      overrides.maxDiscoveries,
      DEFAULT_FABRIC_OPPORTUNITY_CONFIG.maxDiscoveries,
      1,
      DEFAULT_FABRIC_OPPORTUNITY_CONFIG.maxDiscoveries,
    ),
    freshnessRefreshMs: boundedInteger(
      overrides.freshnessRefreshMs,
      DEFAULT_FABRIC_OPPORTUNITY_CONFIG.freshnessRefreshMs,
      1_000,
      60_000,
    ),
    freshnessPenaltyMs: boundedInteger(
      overrides.freshnessPenaltyMs,
      DEFAULT_FABRIC_OPPORTUNITY_CONFIG.freshnessPenaltyMs,
      30_000,
      600_000,
    ),
    freshnessRejectMs: boundedInteger(
      overrides.freshnessRejectMs,
      DEFAULT_FABRIC_OPPORTUNITY_CONFIG.freshnessRejectMs,
      60_000,
      3_600_000,
    ),
    configuredWorldId: text(overrides.configuredWorldId ?? env.MCBOT_WORLD_ID),
    memoryRootDir: overrides.memoryRootDir,
  });
}

/**
 * No-provider physical-shadow coordinator. `observe` deliberately returns
 * undefined and never mutates or substitutes the applied deterministic intent.
 */
export function createOpportunityShadowCoordinator(options = {}) {
  const config = resolveFabricOpportunityConfig(options.env || process.env, options.config || {});
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const planner = options.planner || new OpportunityRoutePlanner(options.plannerConfig || {});
  const sessions = new Map();
  const latestDecisions = new Map();
  const latestStrategyCatalogs = new Map();
  const strategyEnvelopes = new Map();
  let nextStrategyCatalogRevision = 1;
  let nextStrategyEnvelopeRevision = 1;
  if (config.rejectedReason) {
    emit({
      evt: 'opportunity.mode.rejected',
      requestedMode: config.requestedMode,
      appliedMode: 'off',
      reason: config.rejectedReason,
      behaviorApplied: false,
    });
  }

  function observe(instanceId, snapshot = {}, context = {}) {
    if (config.mode !== 'shadow' && config.mode !== 'active') return undefined;
    const normalizedInstanceId = text(instanceId) || 'anonymous';
    const originalIntent = context.appliedIntent ?? context.intent ?? null;
    const defaultObjective = normalizedObjective(context.defaultObjective);
    const missionGoal = normalizedMissionGoal(snapshot, context);
    const scope = resolveObservationScope(
      normalizedInstanceId,
      snapshot,
      missionGoal,
      config,
    );
    const sessionKey = stableStringify([
      scope.persistenceEligible ? 'persistent' : normalizedInstanceId,
      scope.worldId,
      scope.dimension,
      scope.mission,
    ]);
    let session = sessions.get(sessionKey);
    if (!session) {
      const store = typeof options.createMemoryStore === 'function'
        ? options.createMemoryStore(scope)
        : new FabricWorldMemoryStore({ rootDir: config.memoryRootDir, clock });
      const load = store.loadSession({ scope });
      session = {
        store,
        scope,
        load,
        observers: new Set(),
        lastFingerprints: new Map(),
        activeRejectionFingerprints: new Map(),
      };
      sessions.set(sessionKey, session);
      emit({
        evt: 'opportunity.memory.session_loaded',
        instanceId: normalizedInstanceId,
        worldId: scope.worldId,
        dimension: scope.dimension,
        missionGoal,
        ok: load.ok === true,
        reason: load.reason,
        persistenceEligible: load.persistenceEligible === true,
        persistenceReason: load.persistenceReason,
        degradedReason: load.degradedReason,
        behaviorApplied: false,
      });
      if (!load.ok) {
        emit({
          evt: 'opportunity.memory.degraded',
          instanceId: normalizedInstanceId,
          worldId: scope.worldId,
          dimension: scope.dimension,
          missionGoal,
          reason: load.degradedReason || load.reason,
          behaviorApplied: false,
        });
      }
    }

    session.observers.add(normalizedInstanceId);

    const rawDiscoveries = Array.isArray(snapshot.opportunityDiscoveries)
      ? snapshot.opportunityDiscoveries.slice(0, config.maxDiscoveries)
      : [];
    const now = nonNegative(clock());
    const semanticDiscoveries = rawDiscoveries
      .map(semanticDiscoveryFingerprintInput)
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
    const ledgerInput = buildLedgerInput(snapshot, context, defaultObjective, missionGoal);
    const normalizedDiscoveries = [];
    const normalizationRejections = [];
    for (let index = 0; index < rawDiscoveries.length; index += 1) {
      const normalized = normalizeDiscovery(rawDiscoveries[index], index, scope, now);
      if (!normalized.ok) {
        const event = {
          evt: 'opportunity.discovery.rejected',
          instanceId: normalizedInstanceId,
          worldId: scope.worldId,
          dimension: scope.dimension,
          discoveryId: normalized.id,
          reason: normalized.reason,
          behaviorApplied: false,
        };
        normalizationRejections.push({
          key: normalized.id || `raw:${fingerprint(semanticDiscoveryFingerprintInput(rawDiscoveries[index]))}`,
          event,
        });
        continue;
      }
      normalizedDiscoveries.push(normalized.discovery);
    }
    synchronizeDiscoveryRejections(
      session,
      normalizedInstanceId,
      'normalization',
      normalizationRejections,
      emit,
    );
    let batch = { ok: true, results: [], storeRevision: session.store.snapshot().revision };
    if (normalizedDiscoveries.length > 0) {
      try {
        batch = session.store.ingestDiscoveriesBatch(
          normalizedDiscoveries.map((entry) => entry.memoryRecord),
          { refreshIntervalMs: config.freshnessRefreshMs },
        );
      } catch (error) {
        batch = { ok: false, reason: classifiedError(error), results: [] };
      }
    }
    const memoryBatchRejections = [];
    if (!batch?.ok) {
      memoryBatchRejections.push({ key: 'batch:all', event: {
        evt: 'opportunity.discovery.rejected',
        instanceId: normalizedInstanceId,
        worldId: scope.worldId,
        dimension: scope.dimension,
        discoveryId: null,
        type: 'batch',
        stage: 'memory_batch',
        reason: batch?.reason || 'memory_ingest_failed',
        behaviorApplied: false,
      } });
    }
    const discoveryById = new Map(normalizedDiscoveries.map((entry) => [entry.id, entry]));
    for (const result of batch?.results || []) {
      const discovery = discoveryById.get(result.id);
      if (!result?.ok) {
        memoryBatchRejections.push({ key: `discovery:${result?.id || 'unknown'}`, event: {
          evt: 'opportunity.discovery.rejected',
          instanceId: normalizedInstanceId,
          worldId: scope.worldId,
          dimension: scope.dimension,
          discoveryId: result?.id || null,
          type: discovery?.type || result?.collection || 'unknown',
          stage: 'memory_batch',
          reason: result?.reason || 'memory_ingest_failed',
          behaviorApplied: false,
        } });
        continue;
      }
      if (result.action === 'coalesced') continue;
      emit({
        evt: result.action === 'refreshed'
          ? 'opportunity.discovery.refreshed'
          : 'opportunity.discovery.recorded',
        instanceId: normalizedInstanceId,
        worldId: scope.worldId,
        dimension: scope.dimension,
        missionGoal,
        discoveryId: discovery.id,
        type: discovery.type,
        recordRevision: result.recordRevision ?? null,
        memoryRevision: batch.storeRevision,
        action: result.action,
        observedAccessProven: discovery?.memoryRecord?.details?.accessProof != null,
        observedHazardFree: discovery?.memoryRecord?.details?.hazardFree === true,
        executorReady: discovery?.memoryRecord?.details?.executorReady === true,
        capabilityId: discovery?.memoryRecord?.details?.capabilityId || null,
        executorId: discovery?.memoryRecord?.details?.executorId || null,
        executorReadinessSource:
          discovery?.memoryRecord?.details?.executorReadinessSource || null,
        executorReadinessReason:
          discovery?.memoryRecord?.details?.executorReadinessReason || null,
        admissionReason: discovery?.memoryRecord?.details?.admissionReason || null,
        retained: result.retained === true,
        persisted: batch.persisted === true,
        behaviorApplied: false,
      });
    }
    synchronizeDiscoveryRejections(
      session,
      normalizedInstanceId,
      'memory_batch',
      memoryBatchRejections,
      emit,
    );

    const memory = session.store.snapshot();
    const remembered = rememberedDiscoveries(memory, scope, now, config);
    const admissionPosition = canonicalAdmissionPosition(snapshot);
    const freshnessDigest = remembered.map((entry) => ({
      id: entry.id,
      revision: entry.revision,
      status: entry.status,
      freshness: entry.freshness,
    }));
    const decisionFingerprint = fingerprint({
      scope: session.scope,
      memoryRevision: memory.revision,
      freshnessDigest,
      ledgerInput,
      discoveries: semanticDiscoveries,
      admissionPosition,
      defaultObjective,
      intent: compactIntent(originalIntent),
    });
    if (decisionFingerprint === session.lastFingerprints.get(normalizedInstanceId)) return undefined;

    emitBaseline(emit, {
      instanceId: normalizedInstanceId,
      scope,
      defaultObjective,
      originalIntent,
      memoryRevision: memory.revision,
    });

    const ledgerOpportunities = remembered.map((entry) => toLedgerOpportunity(entry));
    const ledger = createMissionResourceLedger({
      ...ledgerInput,
      opportunities: ledgerOpportunities,
    });
    const ledgerRevision = strategyLedgerRevision(ledger);
    emit({
      evt: 'opportunity.ledger.summary',
      instanceId: normalizedInstanceId,
      worldId: scope.worldId,
      dimension: scope.dimension,
      missionGoal,
      memoryRevision: memory.revision,
      ledgerRevision,
      discoveryCount: remembered.length,
      owned: ledger.owned,
      reserved: ledger.reserved,
      convertible: ledger.convertible,
      opportunity: ledger.opportunity,
      estimated: ledger.estimated,
      deficit: ledger.deficit,
      authoritativeSatisfied: ledger.feasibility.authoritativeSatisfied,
      estimatedCountedAsOwned: false,
      reservationDiagnostics: ledgerInput.reservationDiagnostics,
      behaviorApplied: false,
    });

    const baseline = buildDeterministicBaseline(ledger, defaultObjective, context.signals);
    // A container/hay/bed within an admissible village transaction is one
    // member of that bounded transaction, not a competing cheaper detour. If
    // members remain standalone here, their local execution estimate can beat
    // the village root and silently skip arrival revalidation, chest
    // inspection, and bed/hay work. Assign each eligible member to one nearest
    // eligible village deterministically; discoveries outside a verified
    // village remain independent opportunities.
    const villageComposition = buildVillageCompositeMembership(remembered);
    const allPackages = remembered.map((entry) => toOpportunityPackage(entry, {
      snapshot,
      scope,
      memoryRevision: memory.revision,
      ledgerRevision,
      remembered,
      villageMembersById: villageComposition.membersByVillageId,
    }));
    const packages = allPackages.filter((entry) => !villageComposition.subsumedMemberIds.has(entry.id));
    const packageById = new Map(packages.map((entry) => [entry.id, entry]));
    let result;
    try {
      result = planner.plan({
        context: {
          worldId: scope.worldId,
          dimension: scope.dimension,
          memoryRevision: memory.revision,
          ledgerRevision,
        },
        ledger,
        baseline,
        opportunities: packages,
      });
      result = enforceStandaloneIronGolemDecision(result, packageById);
    } catch (error) {
      synchronizeDiscoveryRejections(
        session,
        normalizedInstanceId,
        'planner_admission',
        [],
        emit,
      );
      const plannerReason = `planner_rejected:${classifiedError(error)}`;
      emit({
        evt: 'opportunity.shadow.evaluated',
        instanceId: normalizedInstanceId,
        worldId: scope.worldId,
        dimension: scope.dimension,
        missionGoal,
        defaultObjective,
        reason: plannerReason,
        behaviorApplied: false,
        estimatedCountedAsOwned: false,
      });
      if (config.mode === 'active') {
        latestDecisions.set(normalizedInstanceId, freezeActiveDecision({
          mode: config.mode,
          instanceId: normalizedInstanceId,
          scope,
          missionGoal,
          defaultObjective,
          observedAtMs: now,
          memoryRevision: memory.revision,
          ledgerRevision,
          inventoryFingerprint: villageOpportunityInventoryFingerprint(snapshot),
          admissionPosition,
          ledger,
          reason: plannerReason,
          result: null,
          selected: [],
        }));
        publishStrategyCatalog({
          instanceId: normalizedInstanceId,
          session,
          scope,
          missionGoal,
          defaultObjective,
          observedAtMs: now,
          memory,
          remembered,
          ledger,
          ledgerRevision,
          inventoryFingerprint: villageOpportunityInventoryFingerprint(snapshot),
          admissionPosition,
          deterministicIntent: originalIntent,
          baseline,
          result: null,
          packageById,
        });
      }
      session.lastFingerprints.set(normalizedInstanceId, decisionFingerprint);
      return undefined;
    }

    const typedRejections = result.rejectedOpportunities.map((rejected) => {
      const diagnostic = opportunityDiagnostic(packageById.get(rejected.id));
      return Object.freeze({
        ...rejected,
        type: diagnostic.type,
        admissionProof: diagnostic.admissionProof,
        admissionReason: diagnostic.admissionReason,
        freshness: diagnostic.freshness,
        reason: typedPlannerRejectionReason(rejected, remembered),
      });
    });
    synchronizeDiscoveryRejections(
      session,
      normalizedInstanceId,
      'planner_admission',
      typedRejections.map((rejected) => ({ key: `discovery:${rejected.id}`, event: {
        evt: 'opportunity.discovery.rejected',
        instanceId: normalizedInstanceId,
        worldId: scope.worldId,
        dimension: scope.dimension,
        discoveryId: rejected.id,
        type: rejected.type,
        stage: 'planner_admission',
        reason: rejected.reason,
        admissionProof: rejected.admissionProof,
        admissionReason: rejected.admissionReason,
        freshness: rejected.freshness,
        behaviorApplied: false,
      } })),
      emit,
    );

    emit({
      evt: 'opportunity.shadow.evaluated',
      instanceId: normalizedInstanceId,
      worldId: scope.worldId,
      dimension: scope.dimension,
      missionGoal,
      defaultObjective,
      memoryRevision: memory.revision,
      ledgerRevision,
      choiceId: result.recommendation.choiceId,
      selectedChoiceId: result.selected.choiceId,
      shouldSwitch: result.shouldSwitch,
      recommendationEligible: result.recommendationEligible,
      reason: result.reason,
      consideredOpportunityIds: result.consideredOpportunityIds,
      rejectedOpportunityCount: typedRejections.length,
      rejectedOpportunityReasonCounts: rejectionReasonCounts(typedRejections),
      rejectedOpportunities: typedRejections.slice(0, MAX_REJECTION_DIAGNOSTICS),
      selectedOpportunityDiagnostics: result.recommendation.opportunityIds.map((id) => (
        opportunityDiagnostic(packageById.get(id))
      )),
      candidateCount: result.candidates.length,
      expandedStates: result.expandedStates,
      costBreakdown: result.recommendation.costBreakdown,
      bounds: result.bounds,
      authoritativeDeficit: result.recommendation.authoritativeDeficit,
      estimatedGain: result.recommendation.estimatedGain,
      estimatedCountedAsOwned: false,
      behaviorApplied: false,
    });
    if (config.mode === 'active') {
      const selected = result.recommendation.opportunityIds
        .map((id) => remembered.find((entry) => entry.id === id))
        .filter(Boolean)
        .map((entry) => activeOpportunityView(
          entry,
          remembered,
          packageById.get(entry.id)?.aggregateMemberIds || [],
        ));
      latestDecisions.set(normalizedInstanceId, freezeActiveDecision({
        mode: config.mode,
        instanceId: normalizedInstanceId,
        scope,
        missionGoal,
        defaultObjective,
        observedAtMs: now,
        memoryRevision: memory.revision,
        ledgerRevision,
        inventoryFingerprint: villageOpportunityInventoryFingerprint(snapshot),
        admissionPosition,
        ledger,
        reason: result.reason,
        result,
        selected,
      }));
      publishStrategyCatalog({
        instanceId: normalizedInstanceId,
        session,
        scope,
        missionGoal,
        defaultObjective,
        observedAtMs: now,
        memory,
        remembered,
        ledger,
        ledgerRevision,
        inventoryFingerprint: villageOpportunityInventoryFingerprint(snapshot),
        admissionPosition,
        deterministicIntent: originalIntent,
        baseline,
        result,
        packageById,
      });
    }
    if (result.shouldSwitch) {
      emit({
        evt: 'opportunity.shadow.recommended',
        instanceId: normalizedInstanceId,
        worldId: scope.worldId,
        dimension: scope.dimension,
        missionGoal,
        defaultObjective,
        choiceId: result.recommendation.choiceId,
        opportunityIds: result.recommendation.opportunityIds,
        opportunityDiagnostics: result.recommendation.opportunityIds.map((id) => (
          opportunityDiagnostic(packageById.get(id))
        )),
        costBreakdown: result.recommendation.costBreakdown,
        conservativeBenefitSeconds: result.recommendation.conservativeBenefitSeconds,
        conservativeBenefitFraction: result.recommendation.conservativeBenefitFraction,
        reliability: result.recommendation.reliability,
        authoritativeGoalSatisfied: result.recommendation.authoritativeGoalSatisfied,
        requiresAuthoritativeVerification: result.recommendation.requiresAuthoritativeVerification,
        estimatedCountedAsOwned: false,
        behaviorApplied: false,
      });
    }

    session.lastFingerprints.set(normalizedInstanceId, decisionFingerprint);
    return undefined;
  }

  function publishStrategyCatalog(input) {
    const prior = latestStrategyCatalogs.get(input.instanceId);
    const candidate = buildStrategyCatalog({
      ...input,
      catalogRevision: nextStrategyCatalogRevision,
    });
    if (prior?.catalogFingerprint === candidate.catalogFingerprint) return prior;
    nextStrategyCatalogRevision += 1;
    latestStrategyCatalogs.set(input.instanceId, candidate);
    const envelopes = strategyEnvelopes.get(input.instanceId);
    if (envelopes) {
      for (const envelope of envelopes.values()) {
        if (envelope.status === 'OPEN') envelope.status = 'EXPIRED';
      }
    }
    return candidate;
  }

  function latestStrategyEnvelope(instanceId, rawJunction = {}) {
    const normalized = text(instanceId) || 'anonymous';
    const catalog = latestStrategyCatalogs.get(normalized);
    if (!catalog) return null;
    const targetBoundaryGeneration = nonNegativeSafeInteger(rawJunction.targetBoundaryGeneration);
    if (targetBoundaryGeneration == null) return null;
    const junctionType = safeJunctionType(rawJunction.junctionType);
    const junctionRevision = opaqueJunctionRevision(rawJunction.junctionRevision);
    const signature = fingerprint({
      catalogRevision: catalog.catalogRevision,
      targetBoundaryGeneration,
      junctionType,
      junctionRevision,
    });
    let envelopes = strategyEnvelopes.get(normalized);
    if (!envelopes) {
      envelopes = new Map();
      strategyEnvelopes.set(normalized, envelopes);
    }
    for (const envelope of envelopes.values()) {
      if (envelope.signature === signature && envelope.status === 'OPEN') return envelope.privateEnvelope;
    }
    const envelopeRevision = nextStrategyEnvelopeRevision;
    nextStrategyEnvelopeRevision += 1;
    const envelopeId = `e${envelopeRevision}`;
    const publicPayload = freezeStrategyEnvelopePayload({
      junctionType,
      catalog,
    });
    const privateEnvelope = Object.freeze({
      envelopeId,
      envelopeRevision,
      targetBoundaryGeneration,
      publicPayload,
    });
    envelopes.set(envelopeId, {
      envelopeId,
      envelopeRevision,
      signature,
      targetBoundaryGeneration,
      catalog,
      status: 'OPEN',
      privateEnvelope,
    });
    while (envelopes.size > MAX_STRATEGY_ENVELOPES_PER_INSTANCE) {
      envelopes.delete(envelopes.keys().next().value);
    }
    return privateEnvelope;
  }

  function admitStrategyChoice(instanceId, request = {}, snapshot = {}, context = {}) {
    const normalized = text(instanceId) || 'anonymous';
    const envelopes = strategyEnvelopes.get(normalized);
    const envelopeId = text(request.envelopeId);
    const envelope = envelopes?.get(envelopeId);
    if (!envelope || envelope.envelopeRevision !== request.envelopeRevision) {
      return strategyAdmissionResult(false, 'unknown_envelope');
    }
    if (envelope.status !== 'OPEN') {
      return strategyAdmissionResult(false, `envelope_${envelope.status.toLowerCase()}`);
    }
    const boundaryGeneration = nonNegativeSafeInteger(context.boundaryGeneration);
    if (boundaryGeneration == null || boundaryGeneration < envelope.targetBoundaryGeneration) {
      return strategyAdmissionResult(false, 'boundary_not_reached');
    }
    if (boundaryGeneration !== envelope.targetBoundaryGeneration) {
      envelope.status = 'EXPIRED';
      return strategyAdmissionResult(false, 'stale_boundary');
    }
    const reject = (reason) => {
      envelope.status = 'REJECTED';
      return strategyAdmissionResult(false, reason);
    };
    const catalog = envelope.catalog;
    if (latestStrategyCatalogs.get(normalized)?.catalogFingerprint !== catalog.catalogFingerprint) {
      return reject('stale_catalog');
    }
    const liveMissionGoal = normalizedMissionGoal(snapshot, context);
    if (liveMissionGoal !== catalog.missionGoal) return reject('stale_mission');
    const liveObjective = normalizedObjective(context.defaultObjective);
    if (liveObjective !== catalog.defaultObjective) return reject('stale_objective');
    const liveScope = resolveObservationScope(normalized, snapshot, liveMissionGoal, config);
    if (liveScope.worldId !== catalog.scope.worldId
        || liveScope.dimension !== catalog.scope.dimension
        || liveScope.mission !== catalog.scope.mission) {
      return reject('stale_scope');
    }
    const liveMemory = catalog.session.store.snapshot();
    if (liveMemory.revision !== catalog.memoryRevision) return reject('stale_memory');
    const liveRemembered = rememberedDiscoveries(liveMemory, liveScope, nonNegative(clock()), config);
    if (fingerprint(strategyFreshnessDigest(liveRemembered)) !== catalog.freshnessFingerprint) {
      return reject('stale_memory_freshness');
    }
    const liveLedgerInput = buildLedgerInput(
      snapshot,
      { signals: context.signals || {} },
      liveObjective,
      liveMissionGoal,
    );
    const liveLedger = createMissionResourceLedger({
      ...liveLedgerInput,
      opportunities: liveRemembered.map((entry) => toLedgerOpportunity(entry)),
    });
    const liveLedgerRevision = strategyLedgerRevision(liveLedger);
    if (liveLedgerRevision !== catalog.ledgerRevision) return reject('stale_ledger');
    if (villageOpportunityInventoryFingerprint(snapshot) !== catalog.inventoryFingerprint) {
      return reject('stale_inventory');
    }
    const frozenChoice = catalog.choicesById.get(text(request.choiceId));
    if (!frozenChoice) return reject('unknown_choice');
    const liveBaseline = buildDeterministicBaseline(liveLedger, liveObjective, context.signals || {});
    const liveComposition = buildVillageCompositeMembership(liveRemembered);
    const livePackages = liveRemembered
      .map((entry) => toOpportunityPackage(entry, {
        snapshot,
        scope: liveScope,
        memoryRevision: liveMemory.revision,
        ledgerRevision: liveLedgerRevision,
        remembered: liveRemembered,
        villageMembersById: liveComposition.membersByVillageId,
      }))
      .filter((entry) => !liveComposition.subsumedMemberIds.has(entry.id));
    const livePackageById = new Map(livePackages.map((entry) => [entry.id, entry]));
    let liveResult;
    try {
      liveResult = enforceStandaloneIronGolemDecision(planner.plan({
        context: {
          worldId: liveScope.worldId,
          dimension: liveScope.dimension,
          memoryRevision: liveMemory.revision,
          ledgerRevision: liveLedgerRevision,
        },
        ledger: liveLedger,
        baseline: liveBaseline,
        opportunities: livePackages,
      }), livePackageById);
    } catch {
      return reject('live_reprice_failed');
    }
    const liveCandidates = (liveResult.candidates || [])
      .filter((candidate) => candidate.thresholdEligible === true)
      .filter((candidate) => candidate.opportunityIds?.length === 1)
      .filter((candidate) => {
        const kind = livePackageById.get(candidate.opportunityIds[0])?.kind;
        return kind === 'village' || kind === 'iron_golem';
      })
      .map((recommendation) => strategyCatalogChoice({
        recommendation,
        remembered: liveRemembered,
        packageById: livePackageById,
      }));
    const liveBaselineChoice = strategyCatalogChoice({
      recommendation: liveResult.baseline || strategyBaselineRecommendation(liveBaseline, liveLedger),
      remembered: liveRemembered,
      packageById: livePackageById,
    });
    const frozenOpportunityIds = frozenChoice.recommendation.opportunityIds || [];
    const choice = frozenChoice.recommendation.kind === 'baseline'
      ? liveBaselineChoice
      : liveCandidates.find((candidate) => (
          stableStringify(candidate.recommendation.opportunityIds)
            === stableStringify(frozenOpportunityIds)
        ));
    if (!choice) return reject('choice_no_longer_feasible');
    if (liveCandidates.some((other) => other !== choice && strategyChoiceDominates(other, choice))) {
      return reject('dominated_choice');
    }
    const liveRecommendedIds = liveResult.recommendation?.opportunityIds || [];
    const deterministicBest = liveResult.recommendation?.kind === 'opportunity'
      ? liveCandidates.find((candidate) => (
          stableStringify(candidate.recommendation.opportunityIds)
            === stableStringify(liveRecommendedIds)
        )) || liveBaselineChoice
      : liveBaselineChoice;
    if (strategyChoiceMateriallySlower(choice, deterministicBest)
        && !strategyIntervalsOverlap(choice.interval, deterministicBest.interval)) {
      return reject('materially_slower_choice');
    }
    envelope.status = 'CONSUMED';
    if (choice.recommendation.kind === 'baseline') {
      return Object.freeze({
        ok: true,
        admitted: true,
        outcome: 'baseline',
        reason: 'baseline_selected',
        choiceId: frozenChoice.choiceId,
        kind: 'baseline',
        decision: null,
      });
    }
    const decision = freezeActiveDecision({
      mode: 'active',
      instanceId: normalized,
      scope: catalog.scope,
      missionGoal: catalog.missionGoal,
      defaultObjective: catalog.defaultObjective,
      observedAtMs: catalog.observedAtMs,
      memoryRevision: catalog.memoryRevision,
      ledgerRevision: catalog.ledgerRevision,
      inventoryFingerprint: catalog.inventoryFingerprint,
      admissionPosition: canonicalAdmissionPosition(snapshot),
      ledger: liveLedger,
      reason: 'strategy_active_canary_admitted',
      recommendation: choice.recommendation,
      shouldSwitch: true,
      selected: choice.selected,
      decisionSource: 'strategy_active_canary',
      strategyEnvelopeId: envelope.envelopeId,
      strategyEnvelopeRevision: envelope.envelopeRevision,
      strategyChoiceId: choice.choiceId,
    });
    return Object.freeze({
      ok: true,
      admitted: true,
      outcome: 'opportunity',
      reason: 'opportunity_selected',
      choiceId: frozenChoice.choiceId,
      kind: 'opportunity',
      decision,
    });
  }

  function expireStrategyBoundary(instanceId, boundaryGeneration) {
    const normalized = text(instanceId) || 'anonymous';
    const generation = nonNegativeSafeInteger(boundaryGeneration);
    if (generation == null) return Object.freeze({ expired: 0 });
    let expired = 0;
    for (const envelope of strategyEnvelopes.get(normalized)?.values() || []) {
      if (envelope.status !== 'OPEN' || envelope.targetBoundaryGeneration > generation) continue;
      envelope.status = 'EXPIRED';
      expired += 1;
    }
    return Object.freeze({ expired });
  }

  return Object.freeze({
    mode: config.mode,
    config,
    observe,
    latestStrategyEnvelope,
    admitStrategyChoice,
    expireStrategyBoundary,
    latestDecision(instanceId) {
      const normalized = text(instanceId) || 'anonymous';
      return latestDecisions.get(normalized) || null;
    },
    applyVillageReceipt(instanceId, receipt = {}) {
      const normalized = text(instanceId) || 'anonymous';
      const decision = latestDecisions.get(normalized);
      if (!decision) return Object.freeze({ ok: false, reason: 'no_active_decision' });
      const session = [...sessions.values()].find((candidate) => (
        candidate.observers.has(normalized)
          && candidate.scope.worldId === decision.worldId
          && candidate.scope.dimension === decision.dimension
          && candidate.scope.mission === decision.missionGoal
      ));
      if (!session) return Object.freeze({ ok: false, reason: 'stale_scope' });
      const scope = {
        worldId: decision.worldId,
        dimension: decision.dimension,
        mission: decision.missionGoal,
      };
      if (receipt.type === 'container_inspection') {
        return session.store.applyContainerInspectionReceipt({ ...receipt, scope });
      }
      if (receipt.type === 'container_withdrawal') {
        return session.store.applyContainerWithdrawalReceipt({ ...receipt, scope });
      }
      if (receipt.type === 'container_refresh_required') {
        return session.store.applyContainerRefreshRequiredReceipt({ ...receipt, scope });
      }
      if (receipt.type === 'iron_golem_collection') {
        return session.store.applyIronGolemCollectionReceipt({ ...receipt, scope });
      }
      if (receipt.type === 'transaction_outcome') {
        return session.store.recordVillageTransactionOutcome({ ...receipt, scope });
      }
      return Object.freeze({ ok: false, reason: 'unsupported_receipt_type' });
    },
    reset(instanceId) {
      const normalized = instanceId == null ? null : text(instanceId) || 'anonymous';
      let cleared = 0;
      for (const [key, session] of [...sessions.entries()]) {
        if (normalized == null) {
          sessions.delete(key);
          latestDecisions.clear();
          latestStrategyCatalogs.clear();
          strategyEnvelopes.clear();
          cleared += 1;
          continue;
        }
        if (!session.observers.has(normalized)) continue;
        session.observers.delete(normalized);
        session.lastFingerprints.delete(normalized);
        session.activeRejectionFingerprints.delete(normalized);
        latestDecisions.delete(normalized);
        latestStrategyCatalogs.delete(normalized);
        strategyEnvelopes.delete(normalized);
        cleared += 1;
        if (!session.scope.persistenceEligible && session.observers.size === 0) {
          sessions.delete(key);
        }
      }
      return Object.freeze({ cleared });
    },
    shutdown() {
      let flushed = 0;
      let failed = 0;
      for (const session of sessions.values()) {
        const result = session.store.flush();
        if (result?.ok) flushed += 1;
        else failed += 1;
      }
      sessions.clear();
      latestDecisions.clear();
      latestStrategyCatalogs.clear();
      strategyEnvelopes.clear();
      return Object.freeze({ flushed, failed });
    },
  });
}

function synchronizeDiscoveryRejections(session, instanceId, stage, entries, emit) {
  let observerStages = session.activeRejectionFingerprints.get(instanceId);
  if (!observerStages) {
    observerStages = new Map();
    session.activeRejectionFingerprints.set(instanceId, observerStages);
  }
  const previous = observerStages.get(stage) || new Map();
  const current = new Map();
  for (const entry of entries) {
    const event = entry?.event;
    if (!event) continue;
    const key = String(entry.key ?? event.discoveryId ?? 'unknown');
    const rejectionFingerprint = fingerprint({
      discoveryId: event.discoveryId ?? null,
      type: event.type ?? null,
      stage,
      reason: event.reason ?? null,
      admissionProof: event.admissionProof ?? null,
      admissionReason: event.admissionReason ?? null,
      freshness: event.freshness ?? null,
    });
    if (current.get(key) === rejectionFingerprint) continue;
    current.set(key, rejectionFingerprint);
    if (previous.get(key) !== rejectionFingerprint) emit(event);
  }
  observerStages.set(stage, current);
}

function resolveObservationScope(instanceId, snapshot, missionGoal, config) {
  const identity = snapshot.worldIdentity && typeof snapshot.worldIdentity === 'object'
    ? snapshot.worldIdentity
    : {};
  const worldId = text(
    (typeof snapshot.worldIdentity === 'string' ? snapshot.worldIdentity : null)
      ?? identity.id ?? identity.worldId ?? snapshot.worldIdentityId ?? snapshot.worldId,
  );
  const remote = identity.remote === true || snapshot.worldRemote === true || snapshot.isRemote === true;
  const dimension = normalizedDimension(
    identity.dimension ?? snapshot.dimensionIdentity ?? snapshot.dimension ?? snapshot.worldDimension,
  );
  if (worldId && typeof snapshot.worldPersistenceEligible === 'boolean') {
    const persistenceEligible = snapshot.worldPersistenceEligible === true;
    return Object.freeze({
      worldId,
      dimension,
      mission: missionGoal,
      remote,
      identitySource: text(snapshot.worldIdentitySource) || (persistenceEligible ? 'client_verified' : 'session'),
      persistenceEligible,
      persistenceReason: persistenceEligible ? 'client_verified_world_identity' : 'client_session_only',
    });
  }
  return resolveFabricWorldMemoryScope({
    remote,
    configuredWorldId: config.configuredWorldId,
    worldId,
    sessionId: instanceId,
    dimension,
    mission: missionGoal,
  });
}

function buildLedgerInput(snapshot, context, defaultObjective, missionGoal) {
  const exact = normalizeExactItemCounts(
    snapshot.inventoryItemCounts ?? snapshot.inventory?.itemCounts ?? {},
  );
  const owned = { ...exact };
  const requirementsOverride = context.signals?.opportunityRequirements;
  const reservationOverride = context.signals?.opportunityReservations;
  const goal = missionGoal.toLowerCase();
  const pickaxeOnly = goal.includes('pickaxe') || goal.includes('diamond');
  const objectiveIndex = OBJECTIVE_ORDER.indexOf(defaultObjective);
  const logs = count(snapshot.inventoryLogCount ?? snapshot.logCount);
  const planks = count(snapshot.inventoryPlankCount ?? snapshot.plankCount);
  const woodComplete = objectiveIndex > 0
    || (pickaxeOnly ? logs >= 5 || planks >= 18 : logs >= 20 || planks >= 48);
  owned['mission:wood_complete'] = woodComplete ? 1 : 0;
  const armor = equippedIronArmor(snapshot);
  owned['mission:equipped_iron_armor'] = armor.count;
  const foodLevel = Math.max(0, Math.min(20, finite(snapshot.foodLevel, 20)));
  owned['mission:fed'] = foodLevel > 6 ? 1 : 0;
  const foodUnitsOwned = Math.min(
    FOOD_RESERVE_TARGET,
    foodLevel + inventoryFoodNutrition(snapshot, exact),
  );
  if (foodLevel <= 6) owned[FOOD_RESOURCE] = foodUnitsOwned;
  const rawIron = count(exact['minecraft:raw_iron'] ?? snapshot.inventoryRawIronCount);
  const ironIngots = count(exact['minecraft:iron_ingot'] ?? snapshot.inventoryIronIngotCount);
  if (rawIron > 0) owned['minecraft:raw_iron'] = rawIron;
  if (ironIngots > 0) owned['minecraft:iron_ingot'] = ironIngots;
  const ironPickaxes = count(exact['minecraft:iron_pickaxe'] ?? snapshot.inventoryIronPickaxeCount);
  if (ironPickaxes > 0) owned['minecraft:iron_pickaxe'] = ironPickaxes;
  const investedIron = (ironPickaxes > 0 ? 3 : 0) + (24 - armor.missingIronCost);
  owned['mission:iron_units'] = rawIron + ironIngots + investedIron;

  const requirements = requirementsOverride || {
    'mission:wood_complete': 1,
    'minecraft:iron_pickaxe': 1,
    ...(pickaxeOnly ? {} : { 'mission:equipped_iron_armor': 4 }),
    ...(foodLevel <= 6 ? { [FOOD_RESOURCE]: FOOD_RESERVE_TARGET } : {}),
    'mission:iron_units': pickaxeOnly ? 3 : 27,
  };
  const reservationPlan = reservationOverride
    ? {
        reservations: normalizeExactItemCounts(reservationOverride),
        diagnostics: Object.freeze({ source: 'code_owned_override' }),
      }
    : defaultReservations(snapshot, exact, defaultObjective, context.signals || {});
  return {
    itemCounts: owned,
    equipment: snapshot.inventoryEquipment ?? snapshot.equipment,
    requirements,
    reservations: reservationPlan.reservations,
    reservationDiagnostics: reservationPlan.diagnostics,
    capabilities: context.signals?.opportunityCapabilities,
    // Included in the decision fingerprint even though the generic resource
    // ledger does not consume it. A newly carried or locally usable table must
    // make previously stranded hay eligible for a fresh deterministic plan.
    breadExecutorReady: carriedCraftingTableAvailable(snapshot),
  };
}

function buildDeterministicBaseline(ledger, defaultObjective, signals = {}) {
  if (signals?.opportunityBaseline) return signals.opportunityBaseline;
  const costs = Object.freeze({
    'mission:wood_complete': 240,
    'minecraft:iron_pickaxe': 240,
    'mission:iron_units': 540,
    'mission:equipped_iron_armor': 300,
    'mission:fed': 400,
    [FOOD_RESOURCE]: 400,
  });
  const modes = Object.freeze({
    'mission:wood_complete': 'all_or_nothing',
    'minecraft:iron_pickaxe': 'all_or_nothing',
    'mission:iron_units': 'proportional',
    'mission:equipped_iron_armor': 'proportional',
    'mission:fed': 'all_or_nothing',
    [FOOD_RESOURCE]: 'proportional',
  });
  const components = [];
  let p75Seconds = defaultObjective === 'DONE' ? 0 : 60;
  for (const resource of Object.keys(ledger.deficit).sort()) {
    const componentCost = costs[resource];
    if (!componentCost) continue;
    components.push({
      id: `baseline:${resource.replace(/[^a-z0-9]+/gi, '_')}`,
      resource,
      mode: modes[resource],
      p75Seconds: componentCost,
      initialDeficit: ledger.deficit[resource],
    });
    p75Seconds += componentCost;
  }
  return {
    choiceId: 'continue_baseline',
    p75Seconds,
    reliability: 0.9,
    failureUpperBound: 0.1,
    components,
  };
}

function normalizeDiscovery(raw, index, scope, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, id: null, reason: 'not_object' };
  }
  const id = text(raw.id ?? raw.stableId);
  if (!ID_RE.test(id)) return { ok: false, id: id || null, reason: 'invalid_id' };
  const rawType = text(raw.type ?? raw.kind).toLowerCase();
  const type = DISCOVERY_TYPE_ALIASES[rawType] || rawType;
  if (!SUPPORTED_TYPES.has(type)) return { ok: false, id, reason: 'unsupported_type' };
  const rawDimension = raw.dimension ?? raw.dimensionIdentity;
  if (rawDimension != null && normalizedDimension(rawDimension) !== scope.dimension) {
    return { ok: false, id, reason: 'wrong_dimension' };
  }
  const position = normalizedPosition(raw.anchor ?? raw.position ?? raw);
  const confidence = probability(raw.confidence, 0);
  const status = text(raw.status).toLowerCase() || 'observed';
  const countValue = count(raw.count ?? raw.memberCount ?? raw.blockCount);
  const details = {
    type,
    ...(position ? position : {}),
    ...(countValue > 0 ? { count: countValue } : {}),
    signals: normalizedSignals(raw.signals),
    ...shadowAdmission(raw, type, confidence),
    reliability: probability(raw.reliability, confidence),
    failureUpperBound: probability(raw.failureUpperBound, Math.max(0, 1 - confidence)),
    travelP75Seconds: nonNegative(raw.travelP75Seconds),
    executionP75Seconds: nonNegative(raw.executionP75Seconds),
    uncertaintyPenaltySeconds: nonNegative(raw.uncertaintyPenaltySeconds),
    contentsKnown: raw.contentsKnown === true || raw.inspected === true,
    items: normalizeExactItemCounts(raw.items ?? raw.contents),
    expectedYield: count(raw.expectedYield),
  };
  const memoryRecord = {
    id,
    type,
    confidence,
    lastSeen: raw.observedAtMs == null && raw.lastSeen == null
      ? now
      : nonNegative(raw.observedAtMs ?? raw.lastSeen),
    status,
    details,
  };
  return {
    ok: true,
    discovery: Object.freeze({
      id,
      type,
      memoryRecord,
      semanticRecord: Object.freeze({
        ...memoryRecord,
        lastSeen: undefined,
      }),
    }),
  };
}

function shadowAdmission(raw, type, confidence) {
  const signals = signalSet(raw.signals);
  const hazardVeto = [...signals].some((signal) => (
    signal === 'unsafe'
    || signal === 'hazard'
    || signal === 'hostile'
    || signal === 'night_hostiles'
    || signal === 'lava_adjacent'
    || signal === 'blocked'
    || signal.startsWith('unsafe:')
    || signal.startsWith('hazard:')
  ));
  const explicitlyUnsafe = raw.safe === false || raw.safety?.safe === false;
  const accessProof = signals.has('access_proven')
    ? 'access_proven'
    : signals.has('route_reachable')
      ? 'route_reachable'
      : null;
  const hazardFree = signals.has('hazard_free');
  const defenseReady = signals.has('defense_ready');
  const executorReadiness = discoveryExecutorReadiness(raw, type, signals);
  const executorReady = executorReadiness.ready;
  const safe = accessProof != null && hazardFree && !hazardVeto && !explicitlyUnsafe;
  const ready = safe && executorReady && (type !== 'iron_golem' || defenseReady);
  const feasible = safe && ready;
  const admissionReason = !accessProof
    ? 'access_unproven'
    : !hazardFree
      ? 'hazard_clearance_unproven'
      : hazardVeto || explicitlyUnsafe
        ? 'hazard_veto'
        : !executorReady
          ? 'executor_unready'
        : type === 'iron_golem' && !defenseReady
          ? 'defense_unready'
          : 'code_owned_proof';
  return {
    safe,
    ready,
    feasible,
    accessProof,
    hazardFree,
    hazardVeto,
    explicitlyUnsafe,
    defenseReady,
    executorReady,
    executorId: executorReadiness.executorId,
    capabilityId: executorReadiness.capabilityId,
    executorReadinessSource: executorReadiness.source,
    executorReadinessReason: executorReadiness.reason,
    admissionReason,
  };
}

function discoveryExecutorReadiness(raw, type, signals) {
  const source = text(raw.readinessSource).toLowerCase();
  const executorId = text(raw.executorId).toLowerCase();
  const capabilityId = text(raw.capabilityId).toLowerCase();
  const reason = text(raw.readinessReason).toLowerCase();
  if (source) {
    const expected = CODE_OWNED_DISCOVERY_EXECUTORS[type];
    const registryProof = source === CODE_OWNED_READINESS_SOURCE
      && expected != null
      && executorId === expected.executorId
      && capabilityId === expected.capabilityId;
    return Object.freeze({
      ready: registryProof && raw.executorReady === true,
      executorId,
      capabilityId,
      source,
      reason: registryProof ? (reason || 'registry_verdict') : 'invalid_registry_proof',
    });
  }
  // Compatibility for recorded pre-registry corpora and unit-level synthetic discoveries. Live
  // scanner payloads always carry a readinessSource, so a stamped unready verdict cannot be
  // overridden by an incidental or injected signal.
  if (type === 'iron_golem') {
    return Object.freeze({
      ready: false,
      executorId: '',
      capabilityId: '',
      source: '',
      reason: 'code_owned_registry_proof_required',
    });
  }
  const ready = signals.has('executor_ready')
    || signals.has('capability_ready')
    || signals.has(`${type}_executor_ready`);
  return Object.freeze({
    ready,
    executorId: '',
    capabilityId: '',
    source: '',
    reason: ready ? 'legacy_explicit_proof' : 'executor_unready',
  });
}

function semanticDiscoveryFingerprintInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const result = {};
  for (const key of Object.keys(raw)) {
    if (key === 'observedAtMs' || key === 'lastSeen') continue;
    result[key] = raw[key];
  }
  return result;
}

function rememberedDiscoveries(memory, scope, now, config) {
  const records = [
    ...memory.landmarks,
    ...memory.resourcePatches,
    ...memory.containers,
  ];
  return records
    .map((record) => {
      const ageMs = Math.max(0, now - nonNegative(record.lastSeen));
      const terminal = record.status === 'invalidated'
        || record.status === 'disappeared'
        || record.status === 'collected';
      const freshness = terminal || ageMs >= config.freshnessRejectMs
        ? 'stale'
        : ageMs >= config.freshnessPenaltyMs
          ? 'aging'
          : 'fresh';
      return Object.freeze({
        id: record.id,
        revision: record.revision,
        confidence: record.confidence,
        lastSeen: record.lastSeen,
        ageMs,
        freshness,
        freshnessEligible: !terminal && freshness !== 'stale',
        status: record.status,
        worldId: scope.worldId,
        dimension: scope.dimension,
        ...record.details,
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function toLedgerOpportunity(entry) {
  const verified = entry.freshnessEligible === true && entry.confidence > 0;
  if (entry.type === 'container') {
    return {
      id: entry.id,
      type: 'container',
      verified,
      contentsKnown: entry.contentsKnown === true,
      items: entry.items,
    };
  }
  if (entry.type === 'iron_golem') {
    return {
      id: entry.id,
      type: 'iron_golem',
      verified,
      feasible: entry.feasible === true,
      count: entry.count || 1,
    };
  }
  if (entry.type === 'hay') {
    return { id: entry.id, type: 'hay', verified, count: entry.count };
  }
  if (entry.type === 'exposed_iron') {
    return {
      id: entry.id,
      type: 'exposed_iron',
      verified,
      count: entry.count,
      expectedYield: entry.expectedYield,
    };
  }
  return { id: entry.id, type: entry.type, verified };
}

function toOpportunityPackage(entry, context) {
  const distance = distanceFromSnapshot(context.snapshot, entry);
  const type = entry.type;
  const aggregateMembers = type === 'village'
    ? context.villageMembersById?.get(entry.id) || Object.freeze([])
    : [];
  const estimatedGain = {};
  const remoteBreadReady = villageBreadRemoteExecutorReady(
    context.snapshot,
    entry,
    ...aggregateMembers,
  );
  const carriedBreadUnlock = (type === 'village' || type === 'hay')
      && remoteBreadReady
    ? rawCraftableCarriedBread(context.snapshot) * FOOD_NUTRITION['minecraft:bread']
    : 0;
  if (carriedBreadUnlock > 0) {
    estimatedGain[FOOD_RESOURCE] = carriedBreadUnlock;
  }
  if (type === 'hay' && count(entry.count) > 0 && remoteBreadReady) {
    estimatedGain[FOOD_RESOURCE] = safeAdd(
      estimatedGain[FOOD_RESOURCE],
      count(entry.count) * 3 * FOOD_NUTRITION['minecraft:bread'],
    );
  }
  if (type === 'container' && entry.contentsKnown === true) {
    Object.assign(estimatedGain, entry.items || {});
    const foodUnits = foodNutritionFromCounts(entry.items);
    if (foodUnits > 0 && context.snapshot?.eatExecutorReady !== false) {
      estimatedGain[FOOD_RESOURCE] = foodUnits;
    }
    const pickaxes = count(entry.items?.['minecraft:iron_pickaxe']);
    if (pickaxes > 0 && !authoritativeIronPickaxeOwned(context.snapshot)) {
      estimatedGain['mission:iron_units'] = 3;
    }
    const ingots = count(entry.items?.['minecraft:iron_ingot']);
    if (ingots > 0) estimatedGain['mission:iron_units'] = safeAdd(estimatedGain['mission:iron_units'], ingots);
  }
  if (type === 'iron_golem' && entry.feasible === true) {
    // The resource ledger keeps the guaranteed feasibility floor at three,
    // while its separate estimated view records the vanilla expected yield of
    // four. Route ranking consumes that expected view only; neither objective
    // completion nor executor admission may treat it as owned inventory.
    estimatedGain['minecraft:iron_ingot'] = 4;
    estimatedGain['mission:iron_units'] = 4;
  }
  if (type === 'exposed_iron') {
    const iron = count(entry.count);
    if (iron > 0) {
      estimatedGain['minecraft:raw_iron'] = iron;
      estimatedGain['mission:iron_units'] = iron;
    }
  }
  if (type === 'village') {
    for (const member of aggregateMembers) {
      addCompositeMemberGain(estimatedGain, member, context.snapshot, entry);
    }
  }
  const confidence = probability(entry.confidence, 0);
  const defaults = opportunityDefaults(type, distance, confidence);
  const aggregateTaskOrder = type === 'village'
    ? villageCompositeTaskOrder(aggregateMembers)
    : Object.freeze([]);
  const compositeMemberTravelSeconds = type === 'village'
    ? villageCompositeMemberTravelSeconds(entry, aggregateTaskOrder)
    : 0;
  const compositeExecutionSeconds = type === 'village'
    ? 15 + aggregateMembers.reduce((sum, member) => sum + ({ container: 25, hay: 35, bed: 20 }[member.type] || 0), 0)
    : null;
  const compositeReliability = aggregateMembers.reduce(
    (minimum, member) => Math.min(minimum, probability(member.reliability, member.confidence)),
    probability(entry.reliability, confidence),
  );
  const compositeReady = aggregateMembers.every((member) => compositeMemberEligible(member, entry));
  const freshnessPenalty = entry.freshness === 'aging' ? 60 : 0;
  const freshnessReliabilityFactor = entry.freshness === 'aging' ? 0.85 : 1;
  const valid = entry.freshnessEligible === true;
  return {
    id: entry.id,
    kind: type,
    status: entry.status,
    valid,
    safe: valid && entry.safe === true,
    ready: valid && entry.ready === true && compositeReady,
    feasible: valid && entry.feasible === true && compositeReady,
    admissionProof: entry.accessProof || null,
    admissionReason: valid ? entry.admissionReason : 'stale_observation',
    freshness: entry.freshness,
    ageMs: entry.ageMs,
    reliability: compositeReliability * freshnessReliabilityFactor,
    failureUpperBound: Math.min(1, probability(entry.failureUpperBound, defaults.failureUpperBound)
      + (entry.freshness === 'aging' ? 0.15 : 0)),
    travelP75Seconds: entry.travelP75Seconds || defaults.travelP75Seconds,
    executionP75Seconds: type === 'village'
      ? Math.max(entry.executionP75Seconds || 0, compositeExecutionSeconds || 0, defaults.executionP75Seconds)
        + compositeMemberTravelSeconds
      : entry.executionP75Seconds || defaults.executionP75Seconds,
    uncertaintyPenaltySeconds: (entry.uncertaintyPenaltySeconds || defaults.uncertaintyPenaltySeconds)
      + freshnessPenalty,
    conservativeEstimatedGain: estimatedGain,
    worldId: context.scope.worldId,
    dimension: context.scope.dimension,
    memoryRevision: context.memoryRevision,
    ledgerRevision: context.ledgerRevision,
    aggregateMemberIds: Object.freeze(aggregateMembers.map((member) => member.id)),
  };
}

function buildVillageCompositeMembership(remembered) {
  const villages = remembered
    .filter((entry) => entry.type === 'village' && compositeEntryEligible(entry))
    .filter((entry) => normalizedPosition(entry) !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  const assigned = new Map(villages.map((entry) => [entry.id, []]));
  const members = remembered
    .filter((entry) => ['container', 'hay', 'bed'].includes(entry.type))
    .filter(freshCompositeEntry)
    .filter((entry) => normalizedPosition(entry) !== null)
    .sort((left, right) => left.id.localeCompare(right.id));

  // A member belongs to its nearest admissible village. Stable-id ordering is
  // the final tie break, so scanner order cannot alter package identity.
  for (const member of members) {
    const position = normalizedPosition(member);
    const parent = villages
      .map((village) => ({
        village,
        distance: horizontalDistanceBetween(position, normalizedPosition(village)),
      }))
      .filter((candidate) => candidate.distance
        <= VILLAGE_AGGREGATE_MEMBER_LIMITS.maxHorizontalBlocks)
      .filter((candidate) => villageAggregateMemberInRange(candidate.village, member))
      .filter((candidate) => compositeMemberEligible(member, candidate.village))
      .sort((left, right) => left.distance - right.distance
        || left.village.id.localeCompare(right.village.id))[0]?.village;
    if (parent) assigned.get(parent.id).push(member);
  }

  const membersByVillageId = new Map();
  const subsumedMemberIds = new Set();
  for (const village of villages) {
    const eligible = assigned.get(village.id).sort((left, right) => left.id.localeCompare(right.id));
    const containers = eligible.filter((entry) => entry.type === 'container').slice(0, 2);
    const hay = eligible.find((entry) => entry.type === 'hay');
    const bed = eligible.find((entry) => entry.type === 'bed');
    const selected = Object.freeze([
      ...containers,
      ...(hay ? [hay] : []),
      ...(bed ? [bed] : []),
    ].sort((left, right) => left.id.localeCompare(right.id)));
    membersByVillageId.set(village.id, selected);
    for (const member of selected) subsumedMemberIds.add(member.id);
  }
  return Object.freeze({ membersByVillageId, subsumedMemberIds });
}

function compositeEntryEligible(entry) {
  return freshCompositeEntry(entry)
    && entry.safe === true
    && entry.ready === true
    && entry.feasible === true;
}

function freshCompositeEntry(entry) {
  return entry?.freshnessEligible === true
    && entry.status !== 'invalidated'
    && entry.status !== 'disappeared';
}

function compositeMemberEligible(member, village) {
  if (compositeEntryEligible(member)) return true;
  return remoteVillageMemberEligible(member, village);
}

function remoteVillageMemberEligible(member, village) {
  return freshCompositeEntry(member)
    && compositeEntryEligible(village)
    && village.accessProof === 'route_reachable'
    && village.executorReadinessSource === CODE_OWNED_READINESS_SOURCE
    && village.executorReady === true
    && member.accessProof == null
    && member.hazardFree === true
    && member.hazardVeto !== true
    && member.explicitlyUnsafe !== true
    && member.executorReady === true
    && member.executorReadinessSource === CODE_OWNED_READINESS_SOURCE;
}

function villageCompositeTaskOrder(members) {
  const ordered = [...members].sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze([
    ...ordered.filter((entry) => entry.type === 'container').slice(0, 2),
    ...ordered.filter((entry) => entry.type === 'hay').slice(0, 1),
    ...ordered.filter((entry) => entry.type === 'bed').slice(0, 1),
  ]);
}

function villageCompositeMemberTravelSeconds(village, members) {
  let prior = normalizedPosition(village);
  let seconds = 0;
  for (const member of members) {
    const position = normalizedPosition(member);
    if (!prior || !position) continue;
    const blocks = horizontalDistanceBetween(prior, position);
    // Mirrors the bounded transaction's deterministic TRAVEL_EDGE order. The
    // five-second floor accounts for edge admission/revalidation even when
    // two semantic targets share one physical cell.
    seconds += Math.max(5, blocks / 4.3 + 5);
    prior = position;
  }
  return seconds;
}

function horizontalDistanceBetween(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function villageAggregateMemberInRange(village, member) {
  const root = normalizedPosition(village);
  const target = normalizedPosition(member);
  return root != null
    && target != null
    && horizontalDistanceBetween(root, target)
      <= VILLAGE_AGGREGATE_MEMBER_LIMITS.maxHorizontalBlocks
    && Math.abs(root.y - target.y)
      <= VILLAGE_AGGREGATE_MEMBER_LIMITS.maxVerticalBlocks;
}

/**
 * An iron-golem engagement owns a live hostile UUID from defense-package
 * admission through drop recovery. It therefore cannot share one optimizer
 * path with a chest, hay, bed, or another golem. The generic bounded route
 * planner still evaluates every candidate, but a mixed recommendation is
 * reduced to the best independently eligible single-golem candidate. If the
 * golem is not independently worthwhile, the proven baseline wins.
 */
function enforceStandaloneIronGolemDecision(result, packageById) {
  const recommendedIds = result?.recommendation?.opportunityIds || [];
  const includesGolem = recommendedIds.some((id) => packageById.get(id)?.kind === 'iron_golem');
  if (!includesGolem || recommendedIds.length === 1) return result;

  const standalone = (result.candidates || []).find((candidate) => (
    candidate.thresholdEligible === true
      && candidate.opportunityIds?.length === 1
      && packageById.get(candidate.opportunityIds[0])?.kind === 'iron_golem'
  ));
  const recommendation = standalone || result.baseline;
  const shouldSwitch = recommendation?.kind === 'opportunity';
  return Object.freeze({
    ...result,
    recommendation,
    selected: recommendation,
    shouldSwitch,
    recommendationEligible: shouldSwitch,
    reason: shouldSwitch
      ? 'standalone_iron_golem_selected'
      : 'standalone_iron_golem_benefit_threshold_not_met',
    reasons: Object.freeze({
      ...(result.reasons || {}),
      decision: shouldSwitch
        ? 'standalone_iron_golem_selected'
        : 'standalone_iron_golem_benefit_threshold_not_met',
    }),
  });
}

function addCompositeMemberGain(result, member, snapshot, root = null) {
  if (member.type === 'hay' && count(member.count) > 0
      && villageBreadRemoteExecutorReady(snapshot, root, member)) {
    result[FOOD_RESOURCE] = safeAdd(
      result[FOOD_RESOURCE],
      count(member.count) * 3 * FOOD_NUTRITION['minecraft:bread'],
    );
  }
  if (member.type === 'bed' && count(member.count) > 0) {
    result['minecraft:white_bed'] = safeAdd(result['minecraft:white_bed'], 1);
  }
  if (member.type !== 'container' || member.contentsKnown !== true) return;
  const items = normalizeExactItemCounts(member.items);
  const priorPickaxes = count(result['minecraft:iron_pickaxe']);
  const priorArmorCounts = Object.freeze(Object.fromEntries(
    ARMOR.map(([, itemId]) => [itemId, count(result[itemId])]),
  ));
  for (const [itemId, value] of Object.entries(items)) result[itemId] = safeAdd(result[itemId], value);
  const pickaxes = count(items['minecraft:iron_pickaxe']);
  if (pickaxes > 0 && priorPickaxes === 0 && !authoritativeIronPickaxeOwned(snapshot)) {
    result['mission:iron_units'] = safeAdd(result['mission:iron_units'], 3);
  }
  const armorCosts = {
    'minecraft:iron_helmet': 5,
    'minecraft:iron_chestplate': 8,
    'minecraft:iron_leggings': 7,
    'minecraft:iron_boots': 4,
  };
  for (const [itemId, cost] of Object.entries(armorCosts)) {
    const pieces = count(items[itemId]);
    if (pieces <= 0 || priorArmorCounts[itemId] > 0
        || authoritativeArmorPieceOwned(snapshot, itemId)) continue;
    result['mission:equipped_iron_armor'] = safeAdd(result['mission:equipped_iron_armor'], 1);
    result['mission:iron_units'] = safeAdd(result['mission:iron_units'], cost);
  }
  const ingots = count(items['minecraft:iron_ingot']);
  if (ingots > 0) result['mission:iron_units'] = safeAdd(result['mission:iron_units'], ingots);
  const rawIron = count(items['minecraft:raw_iron']);
  if (rawIron > 0 && snapshot?.smeltExecutorReady === true && snapshot?.smeltFuelReady === true) {
    result['mission:iron_units'] = safeAdd(result['mission:iron_units'], rawIron);
  }
  const foodUnits = foodNutritionFromCounts(items);
  if (foodUnits > 0 && snapshot?.eatExecutorReady !== false) {
    result[FOOD_RESOURCE] = safeAdd(result[FOOD_RESOURCE], foodUnits);
  }
}

function authoritativeIronPickaxeOwned(snapshot = {}) {
  const exact = normalizeExactItemCounts(
    snapshot.inventoryItemCounts ?? snapshot.inventory?.itemCounts ?? {},
  );
  return count(exact['minecraft:iron_pickaxe']) > 0
    || count(snapshot.inventoryIronPickaxeCount ?? snapshot.ironPickaxes) > 0;
}

function authoritativeArmorPieceOwned(snapshot = {}, itemId) {
  const exact = normalizeExactItemCounts(
    snapshot.inventoryItemCounts ?? snapshot.inventory?.itemCounts ?? {},
  );
  if (count(exact[itemId]) > 0) return true;
  const armor = ARMOR.find(([, candidate]) => candidate === itemId);
  if (!armor) return false;
  const [field] = armor;
  return canonicalItem(snapshot[field] ?? snapshot.equipment?.[field]?.itemId) === itemId;
}

function carriedCraftingTableAvailable(snapshot = {}) {
  const exact = normalizeExactItemCounts(
    snapshot.inventoryItemCounts ?? snapshot.inventory?.itemCounts ?? {},
  );
  return count(exact['minecraft:crafting_table'] ?? snapshot.inventoryCraftingTableCount) > 0
    || count(snapshot.inventoryCraftingTableCount) > 0;
}

function foodNutritionFromCounts(raw = {}) {
  const exact = normalizeExactItemCounts(raw);
  return Object.entries(FOOD_NUTRITION).reduce(
    (sum, [itemId, nutrition]) => safeAdd(sum, count(exact[itemId]) * nutrition),
    0,
  );
}

function inventoryFoodNutrition(snapshot = {}, exactCounts = null) {
  const published = snapshot?.inventoryNutritionReserve?.carriedNutrition;
  if (Number.isFinite(Number(published)) && Number(published) >= 0) {
    return Math.floor(Number(published));
  }
  const exact = exactCounts || normalizeExactItemCounts(
    snapshot.inventoryItemCounts ?? snapshot.inventory?.itemCounts ?? {},
  );
  return foodNutritionFromCounts(exact);
}

function rawCraftableCarriedBread(snapshot = {}, exactCounts = null) {
  const exact = exactCounts || normalizeExactItemCounts(
    snapshot.inventoryItemCounts ?? snapshot.inventory?.itemCounts ?? {},
  );
  return count(exact['minecraft:hay_block']) * 3
    + Math.floor(count(exact['minecraft:wheat']) / 3);
}

function villageBreadRemoteExecutorReady(snapshot = {}, ...opportunities) {
  return carriedCraftingTableAvailable(snapshot)
    || opportunities.some(destinationCraftingTableVerified);
}

function destinationCraftingTableVerified(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return false;
  const signals = normalizedSignals(opportunity.signals);
  return Array.isArray(signals)
    ? signals.includes('destination_crafting_table_verified')
    : signals.destination_crafting_table_verified === true;
}

function typedPlannerRejectionReason(rejected, remembered) {
  const entry = remembered.find((candidate) => candidate.id === rejected.id);
  if (entry?.freshness === 'stale') return 'stale_observation';
  const reason = text(rejected.reason) || 'planner_rejected';
  if (entry?.admissionReason && ['unsafe', 'unready', 'infeasible'].some((prefix) => (
    reason === prefix || reason.startsWith(`${prefix}:`)
  ))) {
    return `${reason.split(':')[0]}:${entry.admissionReason}`;
  }
  return reason;
}

function opportunityDiagnostic(entry) {
  return Object.freeze({
    id: entry?.id || null,
    type: entry?.kind || 'unknown',
    admissionProof: entry?.admissionProof || null,
    admissionReason: entry?.admissionReason || null,
    freshness: entry?.freshness || null,
  });
}

function activeOpportunityView(entry, remembered = [], aggregateMemberIds = []) {
  const position = normalizedPosition(entry);
  const memberIdSet = new Set(aggregateMemberIds);
  const aggregateMembers = entry.type === 'village' && position
    ? remembered
      .filter((candidate) => memberIdSet.has(candidate.id))
      .filter((candidate) => ['container', 'hay', 'bed'].includes(candidate.type))
      .filter((candidate) => {
        return villageAggregateMemberInRange(entry, candidate);
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 16)
      .map((candidate) => Object.freeze({
        id: candidate.id,
        type: candidate.type,
        observedRevision: candidate.revision,
        semanticRevision: villageOpportunitySemanticFingerprint(candidate),
        status: candidate.status,
        ...(normalizedPosition(candidate) || {}),
        count: count(candidate.count),
        signals: Object.freeze([...(Array.isArray(candidate.signals) ? candidate.signals : [])]),
        remoteAccessDeferred: candidate.accessProof == null
          && remoteVillageMemberEligible(candidate, entry),
        hazardFree: candidate.hazardFree === true,
        executorReady: candidate.executorReady === true,
        readinessSource: candidate.executorReadinessSource || null,
        capabilityId: candidate.capabilityId || null,
        executorId: candidate.executorId || null,
        contentsKnown: candidate.contentsKnown === true,
        items: Object.freeze({ ...(candidate.items || {}) }),
      }))
    : [];
  return Object.freeze({
    id: entry.id,
    type: entry.type,
    observedRevision: entry.revision,
    semanticRevision: villageOpportunitySemanticFingerprint(entry),
    status: entry.status,
    ...(position || {}),
    count: count(entry.count),
    signals: Object.freeze([...(Array.isArray(entry.signals) ? entry.signals : [])]),
    safe: entry.safe === true,
    ready: entry.ready === true,
    feasible: entry.feasible === true,
    accessProof: entry.accessProof || null,
    hazardFree: entry.hazardFree === true,
    executorReady: entry.executorReady === true,
    readinessSource: entry.executorReadinessSource || null,
    capabilityId: entry.capabilityId || null,
    executorId: entry.executorId || null,
    contentsKnown: entry.contentsKnown === true,
    items: Object.freeze({ ...(entry.items || {}) }),
    aggregateMembers: Object.freeze(aggregateMembers),
  });
}

function buildStrategyCatalog(input) {
  const baselineRecommendation = input.result?.baseline
    || strategyBaselineRecommendation(input.baseline, input.ledger);
  const physicalCandidates = (input.result?.candidates || [])
    .filter((candidate) => candidate?.thresholdEligible === true)
    .filter((candidate) => candidate?.kind === 'opportunity')
    .filter((candidate) => candidate.opportunityIds?.length === 1)
    .filter((candidate) => {
      const kind = input.packageById.get(candidate.opportunityIds[0])?.kind;
      return kind === 'village' || kind === 'iron_golem';
    })
    .map((recommendation) => strategyCatalogChoice({
      recommendation,
      remembered: input.remembered,
      packageById: input.packageById,
    }))
    .sort(compareStrategyCatalogChoice);
  const nondominated = physicalCandidates.filter((candidate, index, values) => (
    !values.some((other, otherIndex) => otherIndex !== index && strategyChoiceDominates(other, candidate))
  )).slice(0, MAX_STRATEGY_OPPORTUNITY_CHOICES)
    .sort((left, right) => left.recommendation.opportunityIds.join('\u0000')
      .localeCompare(right.recommendation.opportunityIds.join('\u0000')));
  const baselineChoice = strategyCatalogChoice({
    recommendation: baselineRecommendation,
    remembered: input.remembered,
    packageById: input.packageById,
  });
  const choices = [baselineChoice, ...nondominated].map((choice, index) => Object.freeze({
    ...choice,
    choiceId: `c${index}`,
  }));
  const choicesById = new Map(choices.map((choice) => [choice.choiceId, choice]));
  const recommendedChoice = choices.find((choice) => (
    choice.recommendation.choiceId === input.result?.recommendation?.choiceId
  ));
  const deterministicBestChoiceId = recommendedChoice?.choiceId || 'c0';
  const deterministicIntent = compactIntent(input.deterministicIntent);
  const memorySummary = strategyMemorySummary(input.remembered);
  const ledger = Object.freeze({
    owned: freezeStrategyCountMap(input.ledger?.owned),
    reserved: freezeStrategyCountMap(input.ledger?.reserved),
    convertible: freezeStrategyCountMap(input.ledger?.convertible),
    deficit: freezeStrategyCountMap(input.ledger?.deficit),
  });
  const catalogFingerprint = fingerprint({
    scope: input.scope,
    missionGoal: input.missionGoal,
    defaultObjective: input.defaultObjective,
    memoryRevision: input.memory.revision,
    freshness: strategyFreshnessDigest(input.remembered),
    ledgerRevision: input.ledgerRevision,
    inventoryFingerprint: input.inventoryFingerprint,
    choices: choices.map((choice) => ({
      choiceId: choice.choiceId,
      kind: choice.recommendation.kind,
      selected: choice.selected.map((entry) => ({
        id: entry.id,
        semanticRevision: entry.semanticRevision,
        members: entry.aggregateMembers.map((member) => ({
          id: member.id,
          semanticRevision: member.semanticRevision,
        })),
      })),
    })),
  });
  return Object.freeze({
    catalogRevision: input.catalogRevision,
    catalogFingerprint,
    session: input.session,
    scope: input.scope,
    missionGoal: input.missionGoal,
    defaultObjective: input.defaultObjective,
    observedAtMs: input.observedAtMs,
    memoryRevision: input.memory.revision,
    freshnessFingerprint: fingerprint(strategyFreshnessDigest(input.remembered)),
    ledgerRevision: input.ledgerRevision,
    inventoryFingerprint: input.inventoryFingerprint,
    admissionPosition: input.admissionPosition,
    deterministicIntent,
    ledger: input.ledger,
    publicLedger: ledger,
    memorySummary,
    checklist: strategyMissionChecklist(input.ledger, input.missionGoal),
    deterministicBestChoiceId,
    choices: Object.freeze(choices),
    choicesById,
  });
}

function strategyBaselineRecommendation(baseline = {}, ledger = {}) {
  const scoreSeconds = nonNegative(baseline.p75Seconds);
  return Object.freeze({
    choiceId: text(baseline.choiceId) || 'continue_baseline',
    kind: 'baseline',
    opportunityIds: Object.freeze([]),
    scoreSeconds,
    baselineRemainingTimeSeconds: scoreSeconds,
    p75TravelExecutionSeconds: 0,
    failurePenaltySeconds: 0,
    uncertaintyPenaltySeconds: 0,
    failureUpperBound: probability(baseline.failureUpperBound, 0),
    reliability: probability(baseline.reliability, 1),
    estimatedGain: Object.freeze({}),
    estimatedResidualDeficit: Object.freeze({ ...(ledger.deficit || {}) }),
    authoritativeDeficit: Object.freeze({ ...(ledger.deficit || {}) }),
    requiresAuthoritativeVerification: Object.keys(ledger.deficit || {}).length > 0,
    costBreakdown: Object.freeze({
      p75TravelExecutionSeconds: 0,
      failurePenaltySeconds: 0,
      uncertaintyPenaltySeconds: 0,
      baselineRemainingTimeSeconds: scoreSeconds,
      totalSeconds: scoreSeconds,
    }),
  });
}

function strategyCatalogChoice({ recommendation, remembered, packageById }) {
  const ids = Object.freeze([...(recommendation?.opportunityIds || [])]);
  const selected = Object.freeze(ids
    .map((id) => remembered.find((entry) => entry.id === id))
    .filter(Boolean)
    .map((entry) => activeOpportunityView(
      entry,
      remembered,
      packageById.get(entry.id)?.aggregateMemberIds || [],
    )));
  const scoreSeconds = nonNegative(
    recommendation?.costBreakdown?.totalSeconds ?? recommendation?.scoreSeconds,
  );
  const p75TravelExecutionSeconds = nonNegative(
    recommendation?.costBreakdown?.p75TravelExecutionSeconds
      ?? recommendation?.p75TravelExecutionSeconds,
  );
  const baselineRemainingTimeSeconds = nonNegative(
    recommendation?.costBreakdown?.baselineRemainingTimeSeconds
      ?? recommendation?.baselineRemainingTimeSeconds,
  );
  const failurePenaltySeconds = nonNegative(
    recommendation?.costBreakdown?.failurePenaltySeconds
      ?? recommendation?.failurePenaltySeconds,
  );
  const uncertaintyPenaltySeconds = nonNegative(
    recommendation?.costBreakdown?.uncertaintyPenaltySeconds
      ?? recommendation?.uncertaintyPenaltySeconds,
  );
  const lowerSeconds = p75TravelExecutionSeconds + baselineRemainingTimeSeconds;
  const upperSeconds = lowerSeconds + failurePenaltySeconds + (2 * uncertaintyPenaltySeconds);
  const kinds = Object.freeze([...new Set(ids.map((id) => packageById.get(id)?.kind).filter(Boolean))].sort());
  return Object.freeze({
    choiceId: '',
    recommendation,
    selected,
    kinds,
    scoreSeconds,
    failureUpperBound: probability(recommendation?.failureUpperBound, 0),
    reliability: probability(recommendation?.reliability, 1),
    uncertaintyPenaltySeconds,
    interval: Object.freeze({ lowerSeconds, upperSeconds: Math.max(lowerSeconds, upperSeconds) }),
    dominated: false,
  });
}

function compareStrategyCatalogChoice(left, right) {
  return left.scoreSeconds - right.scoreSeconds
    || left.failureUpperBound - right.failureUpperBound
    || right.reliability - left.reliability
    || left.recommendation.opportunityIds.join('\u0000')
      .localeCompare(right.recommendation.opportunityIds.join('\u0000'));
}

function strategyChoiceDominates(left, right) {
  const noWorse = left.scoreSeconds <= right.scoreSeconds
    && left.failureUpperBound <= right.failureUpperBound
    && left.reliability >= right.reliability
    && left.uncertaintyPenaltySeconds <= right.uncertaintyPenaltySeconds;
  if (!noWorse) return false;
  return left.scoreSeconds < right.scoreSeconds
    || left.failureUpperBound < right.failureUpperBound
    || left.reliability > right.reliability
    || left.uncertaintyPenaltySeconds < right.uncertaintyPenaltySeconds;
}

function strategyChoiceMateriallySlower(choice, deterministicBest) {
  if (!choice || !deterministicBest || choice === deterministicBest) return false;
  const delta = choice.scoreSeconds - deterministicBest.scoreSeconds;
  if (!(delta > STRATEGY_MATERIAL_SLOWER_SECONDS)) return false;
  if (!(deterministicBest.scoreSeconds > 0)) return delta > STRATEGY_MATERIAL_SLOWER_SECONDS;
  return delta / deterministicBest.scoreSeconds > STRATEGY_MATERIAL_SLOWER_FRACTION;
}

function strategyIntervalsOverlap(left, right) {
  if (!left || !right) return false;
  return left.lowerSeconds <= right.upperSeconds && right.lowerSeconds <= left.upperSeconds;
}

function freezeStrategyEnvelopePayload(input) {
  return Object.freeze({
    schemaVersion: 'strategy_envelope_v1',
    trigger: Object.freeze({
      type: input.junctionType,
    }),
    mission: Object.freeze({
      goal: publicStrategyMissionGoal(input.catalog.missionGoal),
      phase: strategyMissionPhase(input.catalog.defaultObjective),
      checklist: input.catalog.checklist,
    }),
    ledger: input.catalog.publicLedger,
    memory: input.catalog.memorySummary,
    deterministicBestChoiceId: input.catalog.deterministicBestChoiceId,
    choices: Object.freeze(input.catalog.choices.map(freezePublicStrategyChoice)),
  });
}

function freezePublicStrategyChoice(choice) {
  const recommendation = choice.recommendation;
  return Object.freeze({
    choiceId: choice.choiceId,
    kind: recommendation.kind === 'opportunity' ? 'opportunity' : 'baseline',
    opportunityKinds: choice.kinds,
    opportunityCount: recommendation.opportunityIds?.length || 0,
    estimatedGain: freezeStrategyCountMap(recommendation.estimatedGain),
    estimatedResidualDeficit: freezeStrategyCountMap(recommendation.estimatedResidualDeficit),
    requiresAuthoritativeVerification: recommendation.requiresAuthoritativeVerification === true,
    cost: Object.freeze({
      p75TravelExecutionSeconds: nonNegative(
        recommendation.costBreakdown?.p75TravelExecutionSeconds
          ?? recommendation.p75TravelExecutionSeconds,
      ),
      baselineRemainingTimeSeconds: nonNegative(
        recommendation.costBreakdown?.baselineRemainingTimeSeconds
          ?? recommendation.baselineRemainingTimeSeconds,
      ),
      totalSeconds: choice.scoreSeconds,
    }),
    risk: Object.freeze({
      reliability: choice.reliability,
      failureUpperBound: choice.failureUpperBound,
      uncertaintyPenaltySeconds: choice.uncertaintyPenaltySeconds,
      lowerBoundSeconds: choice.interval.lowerSeconds,
      upperBoundSeconds: choice.interval.upperSeconds,
    }),
  });
}

function strategyMemorySummary(remembered) {
  const byKind = {};
  let verified = 0;
  let aging = 0;
  for (const entry of remembered || []) {
    const kind = publicStrategyDiscoveryKind(entry.type);
    byKind[kind] = count(byKind[kind]) + 1;
    if (entry.freshnessEligible === true) verified += 1;
    if (entry.freshness === 'aging') aging += 1;
  }
  return Object.freeze({
    totalDiscoveries: remembered?.length || 0,
    verifiedDiscoveries: verified,
    agingDiscoveries: aging,
    byKind: Object.freeze(Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b)))),
  });
}

function publicStrategyDiscoveryKind(value) {
  const kind = text(value).toLowerCase();
  if ([
    'village', 'villager', 'iron_golem', 'hay', 'bed', 'container',
    'exposed_stone', 'exposed_iron', 'exposed_coal', 'passive_food', 'ruined_portal',
  ].includes(kind)) return kind;
  return 'unknown';
}

function strategyMissionChecklist(ledger, missionGoal) {
  const deficit = ledger?.deficit || {};
  const pickaxeOnly = text(missionGoal).toLowerCase().includes('pickaxe')
    || text(missionGoal).toLowerCase().includes('diamond');
  return Object.freeze({
    woodReady: count(deficit['mission:wood_complete']) === 0,
    ironPickaxeReady: count(deficit['minecraft:iron_pickaxe']) === 0,
    ironArmorReady: pickaxeOnly || count(deficit['mission:equipped_iron_armor']) === 0,
    foodReady: count(deficit[FOOD_RESOURCE]) === 0,
    ironUnitsReady: count(deficit['mission:iron_units']) === 0,
  });
}

function strategyMissionPhase(objective) {
  const index = OBJECTIVE_ORDER.indexOf(normalizedObjective(objective));
  if (index <= OBJECTIVE_ORDER.indexOf('MAKE_STONE_TOOLS')) return 'surface_preparation';
  if (index <= OBJECTIVE_ORDER.indexOf('DESCEND')) return 'mining_setup';
  if (index <= OBJECTIVE_ORDER.indexOf('MAKE_ARMOR')) return 'underground_iron';
  if (normalizedObjective(objective) === 'EAT') return 'survival';
  return 'complete';
}

function publicStrategyMissionGoal(value) {
  const goal = text(value).toLowerCase();
  if (goal.includes('diamond')) return 'diamond';
  if (goal.includes('pickaxe')) return 'iron_pickaxe';
  return 'iron_armor';
}

function freezeStrategyCountMap(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze(result);
  for (const key of Object.keys(raw).sort()) {
    const publicKey = publicStrategyResourceKey(key);
    if (!publicKey) continue;
    const value = count(raw[key]);
    if (value > 0) result[publicKey] = safeAdd(result[publicKey], value);
    if (Object.keys(result).length >= MAX_STRATEGY_LEDGER_ENTRIES) break;
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))));
}

function publicStrategyResourceKey(value) {
  const item = text(value).toLowerCase();
  if (PUBLIC_STRATEGY_RESOURCES.has(item)) return item;
  if (/^minecraft:[a-z0-9_]+_(?:log|stem|hyphae)$/.test(item)) return 'mission:logs';
  if (/^minecraft:[a-z0-9_]+_planks$/.test(item)) return 'mission:planks';
  if (/^minecraft:[a-z0-9_]+_bed$/.test(item)) return 'mission:beds';
  if (/^minecraft:[a-z0-9_]+_wool$/.test(item)) return 'mission:wool';
  return null;
}

function strategyFreshnessDigest(remembered) {
  return (remembered || []).map((entry) => Object.freeze({
    id: entry.id,
    revision: entry.revision,
    status: entry.status,
    freshness: entry.freshness,
  }));
}

function strategyLedgerRevision(ledger) {
  return fingerprint({
    owned: ledger.owned,
    reserved: ledger.reserved,
    convertible: ledger.convertible,
    deficit: ledger.deficit,
    requirements: ledger.requirements,
    reservation: ledger.reservation,
    conversion: ledger.conversion,
    opportunity: ledger.opportunity,
    estimated: ledger.estimated,
  });
}

function strategyAdmissionResult(ok, reason) {
  return Object.freeze({ ok, admitted: false, reason, decision: null });
}

function safeJunctionType(value) {
  const raw = text(value).toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 48);
  return raw || 'unspecified';
}

function opaqueJunctionRevision(value) {
  return nonNegativeSafeInteger(value) ?? `j${fingerprint(value ?? null).slice(0, 16)}`;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function freezeActiveDecision(input) {
  const recommendation = input.recommendation || input.result?.recommendation || Object.freeze({
    choiceId: 'continue_baseline',
    kind: 'baseline',
    opportunityIds: Object.freeze([]),
  });
  const selected = Object.freeze([...(input.selected || [])]);
  const decisionId = fingerprint({
    worldId: input.scope.worldId,
    dimension: input.scope.dimension,
    missionGoal: input.missionGoal,
    memoryRevision: input.memoryRevision,
    ledgerRevision: input.ledgerRevision,
    inventoryFingerprint: input.inventoryFingerprint,
    admissionPosition: input.admissionPosition,
    ledger: Object.freeze({
      owned: Object.freeze({ ...(input.ledger?.owned || {}) }),
      reserved: Object.freeze({ ...(input.ledger?.reserved || {}) }),
      deficit: Object.freeze({ ...(input.ledger?.deficit || {}) }),
    }),
    choiceId: recommendation.choiceId,
    selected: selected.map((entry) => ({
      id: entry.id,
      semanticRevision: entry.semanticRevision,
      members: entry.aggregateMembers.map((member) => ({ id: member.id, semanticRevision: member.semanticRevision })),
    })),
  });
  const claimId = fingerprint({
    worldId: input.scope.worldId,
    dimension: input.scope.dimension,
    missionGoal: input.missionGoal,
    ledgerRevision: input.ledgerRevision,
    choiceId: recommendation.choiceId,
    selected: selected.map((entry) => ({
      id: entry.id,
      semanticRevision: entry.semanticRevision,
      members: entry.aggregateMembers.map((member) => ({ id: member.id, semanticRevision: member.semanticRevision })),
    })),
  });
  return Object.freeze({
    decisionId,
    claimId,
    mode: input.mode,
    instanceId: input.instanceId,
    worldId: input.scope.worldId,
    dimension: input.scope.dimension,
    missionGoal: input.missionGoal,
    defaultObjective: input.defaultObjective,
    observedAtMs: input.observedAtMs,
    memoryRevision: input.memoryRevision,
    ledgerRevision: input.ledgerRevision,
    inventoryFingerprint: input.inventoryFingerprint,
    admissionPosition: input.admissionPosition
      ? Object.freeze({ ...input.admissionPosition })
      : null,
    ledger: Object.freeze({
      owned: Object.freeze({ ...(input.ledger?.owned || {}) }),
      reserved: Object.freeze({ ...(input.ledger?.reserved || {}) }),
      deficit: Object.freeze({ ...(input.ledger?.deficit || {}) }),
    }),
    shouldSwitch: input.shouldSwitch === true || input.result?.shouldSwitch === true,
    recommendation,
    reason: input.reason,
    selectedOpportunities: selected,
    decisionSource: input.decisionSource || 'deterministic_optimizer',
    strategyEnvelopeId: input.strategyEnvelopeId || null,
    strategyEnvelopeRevision: input.strategyEnvelopeRevision ?? null,
    strategyChoiceId: input.strategyChoiceId || null,
  });
}

function canonicalAdmissionPosition(snapshot = {}) {
  const position = normalizedPosition(snapshot);
  if (!position) return null;
  return Object.freeze({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

function opportunityDefaults(type, distance, confidence) {
  const execution = {
    village: 75,
    container: 25,
    hay: 35,
    iron_golem: 70,
    exposed_iron: 30,
    passive_food: 45,
    bed: 20,
  }[type] ?? 45;
  return {
    travelP75Seconds: Math.max(5, distance / 4.3 + 5),
    executionP75Seconds: execution,
    failureUpperBound: Math.max(0, 1 - confidence),
    uncertaintyPenaltySeconds: Math.max(0, (1 - confidence) * 120),
  };
}

function emitBaseline(emit, input) {
  emit({
    evt: 'opportunity.shadow.baseline',
    instanceId: input.instanceId,
    worldId: input.scope.worldId,
    dimension: input.scope.dimension,
    missionGoal: input.scope.mission,
    defaultObjective: input.defaultObjective,
    choiceId: 'continue_baseline',
    byteEquivalent: true,
    behaviorApplied: false,
    appliedIntent: compactIntent(input.originalIntent),
    memoryRevision: input.memoryRevision,
  });
}

function defaultReservations(snapshot, exact, defaultObjective, signals) {
  const result = {};
  addBoundedReservation(result, exact, 'minecraft:crafting_table', 1);
  addBoundedReservation(result, exact, 'minecraft:stick', 4);
  addBoundedReservation(result, exact, 'minecraft:cobblestone', 3);
  let remainingPlanks = Math.min(6, totalMatching(exact, (item) => item.endsWith('_planks')));
  for (const item of Object.keys(exact).filter((key) => key.endsWith('_planks')).sort()) {
    if (remainingPlanks <= 0) break;
    const reserved = addBoundedReservation(result, exact, item, remainingPlanks);
    remainingPlanks -= reserved;
  }

  const objectiveIndex = OBJECTIVE_ORDER.indexOf(defaultObjective);
  const miningStage = objectiveIndex >= OBJECTIVE_ORDER.indexOf('MINE_STONE')
    && objectiveIndex <= OBJECTIVE_ORDER.indexOf('MAKE_ARMOR');
  const pickaxe = miningStage ? reserveFirstOwnedTool(result, exact, [
    'minecraft:diamond_pickaxe',
    'minecraft:iron_pickaxe',
    'minecraft:stone_pickaxe',
    'minecraft:wooden_pickaxe',
  ]) : null;
  const sword = miningStage ? reserveFirstOwnedTool(result, exact, [
    'minecraft:diamond_sword',
    'minecraft:iron_sword',
    'minecraft:stone_sword',
    'minecraft:wooden_sword',
  ]) : null;

  const fuel = reservePendingSmeltFuel(result, exact, defaultObjective);
  const food = reserveSurvivalFood(result, exact, snapshot, defaultObjective);
  const defaultLaterKit = defaultLaterKitRequirements(exact);
  const explicitLaterKit = normalizeExactItemCounts(signals.opportunityLaterKitRequirements);
  const laterKitRequested = mergeMaximumCounts(defaultLaterKit, explicitLaterKit);
  const laterKitReserved = {};
  for (const [item, requested] of Object.entries(laterKitRequested)) {
    const added = addBoundedReservation(result, exact, item, requested);
    if (added > 0) laterKitReserved[item] = added;
  }

  return {
    reservations: Object.freeze(Object.fromEntries(
      Object.entries(result).filter(([, value]) => value > 0).sort(([a], [b]) => a.localeCompare(b)),
    )),
    diagnostics: Object.freeze({
      source: 'stage_default',
      objective: defaultObjective,
      pickaxe: pickaxe ? Object.freeze({
        itemId: pickaxe,
        remainingDurability: toolDurability(snapshot, pickaxe),
      }) : null,
      sword: sword ? Object.freeze({
        itemId: sword,
        remainingDurability: toolDurability(snapshot, sword),
      }) : null,
      viableToolSet: !miningStage || Boolean(pickaxe && sword),
      fuel,
      food,
      laterKitRequired: Object.keys(laterKitRequested).length > 0,
      laterKitSource: Object.keys(explicitLaterKit).length > 0
        ? 'code_owned_default_and_explicit'
        : 'code_owned_default',
      laterKitReserved: Object.freeze(laterKitReserved),
    }),
  };
}

function reservePendingSmeltFuel(result, exact, objective) {
  if (objective !== 'SMELT_IRON') return Object.freeze({ pending: false });
  const batch = Math.min(3, count(exact['minecraft:raw_iron']));
  if (batch <= 0) return Object.freeze({ pending: false, reason: 'no_raw_iron' });
  const efficientRequired = Math.ceil(batch / 8);
  for (const item of ['minecraft:coal', 'minecraft:charcoal']) {
    if (count(exact[item]) >= efficientRequired) {
      const reserved = addBoundedReservation(result, exact, item, efficientRequired);
      return Object.freeze({ pending: true, sourceClass: 'efficient', itemId: item, reserved });
    }
  }
  const woodRequired = Math.ceil((2 * batch) / 3);
  const logIds = Object.keys(exact).filter(isLogFuel).sort();
  let remaining = woodRequired;
  for (const item of logIds) remaining -= addBoundedReservation(result, exact, item, remaining);
  if (remaining <= 0) {
    return Object.freeze({ pending: true, sourceClass: 'logs', reserved: woodRequired });
  }
  // Do not mix source classes. Roll back a partial log reservation.
  for (const item of logIds) delete result[item];
  remaining = woodRequired;
  const plankIds = Object.keys(exact).filter((key) => key.endsWith('_planks')).sort();
  const plankBefore = Object.fromEntries(plankIds.map((item) => [item, count(result[item])]));
  for (const item of plankIds) {
    const excess = Math.max(0, count(exact[item]) - count(result[item]));
    const add = Math.min(excess, remaining);
    if (add > 0) result[item] = count(result[item]) + add;
    remaining -= add;
  }
  if (remaining <= 0) {
    return Object.freeze({ pending: true, sourceClass: 'planks', reserved: woodRequired });
  }
  // Preserve the six-plank field-kit reserve when a complete fuel admission is impossible.
  for (const item of plankIds) {
    if (plankBefore[item] > 0) result[item] = plankBefore[item];
    else delete result[item];
  }
  return Object.freeze({ pending: true, sourceClass: null, reserved: 0, reason: 'usable_fuel_unavailable' });
}

function reserveSurvivalFood(result, exact, snapshot, objective) {
  if (objective !== 'EAT' && finite(snapshot.foodLevel, 20) > 10) {
    return Object.freeze({ required: false });
  }
  const foods = [
    'minecraft:golden_carrot', 'minecraft:cooked_beef', 'minecraft:cooked_porkchop',
    'minecraft:cooked_mutton', 'minecraft:cooked_chicken', 'minecraft:bread',
    'minecraft:baked_potato', 'minecraft:apple', 'minecraft:carrot',
  ];
  const item = foods.find((candidate) => count(exact[candidate]) > count(result[candidate]));
  if (!item) return Object.freeze({ required: true, available: false });
  addBoundedReservation(result, exact, item, 1);
  return Object.freeze({ required: true, available: true, itemId: item, reserved: 1 });
}

function reserveFirstOwnedTool(result, exact, candidates) {
  const item = candidates.find((candidate) => count(exact[candidate]) > 0);
  if (item) addBoundedReservation(result, exact, item, 1);
  return item || null;
}

function defaultLaterKitRequirements(exact) {
  const result = {};
  const bed = Object.keys(exact).filter((item) => item.endsWith('_bed')).sort()
    .find((item) => count(exact[item]) > 0);
  if (bed) result[bed] = 1;
  for (const item of [
    'minecraft:water_bucket',
    'minecraft:flint_and_steel',
    'minecraft:shield',
    'minecraft:bow',
  ]) {
    if (count(exact[item]) > 0) result[item] = 1;
  }
  const goldArmor = [
    'minecraft:golden_boots',
    'minecraft:golden_helmet',
    'minecraft:golden_leggings',
    'minecraft:golden_chestplate',
  ].find((item) => count(exact[item]) > 0);
  if (goldArmor) result[goldArmor] = 1;
  if (count(exact['minecraft:arrow']) > 0) {
    result['minecraft:arrow'] = Math.min(16, count(exact['minecraft:arrow']));
  }
  return Object.freeze(result);
}

function mergeMaximumCounts(left, right) {
  const result = {};
  for (const item of new Set([...Object.keys(left || {}), ...Object.keys(right || {})])) {
    const value = Math.max(count(left?.[item]), count(right?.[item]));
    if (value > 0) result[item] = value;
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))));
}

function addBoundedReservation(result, exact, item, requested) {
  const available = Math.max(0, count(exact[item]) - count(result[item]));
  const added = Math.min(available, count(requested));
  if (added > 0) result[item] = count(result[item]) + added;
  return added;
}

function totalMatching(exact, predicate) {
  return Object.entries(exact).reduce((sum, [item, value]) => (
    predicate(item) ? safeAdd(sum, value) : sum
  ), 0);
}

function isLogFuel(item) {
  return item.endsWith('_log') || item.endsWith('_stem') || item.endsWith('_hyphae');
}

function toolDurability(snapshot, item) {
  const keyed = snapshot.inventoryToolRemainingDurability;
  if (keyed && typeof keyed === 'object' && Number.isSafeInteger(keyed[item])) return keyed[item];
  if (item === 'minecraft:stone_pickaxe'
      && Number.isSafeInteger(snapshot.inventoryStonePickaxeTotalRemainingDurability)) {
    return snapshot.inventoryStonePickaxeTotalRemainingDurability;
  }
  return null;
}

function equippedIronArmor(snapshot) {
  let countValue = 0;
  let missingIronCost = 0;
  for (const [field, item, cost] of ARMOR) {
    const equipped = canonicalItem(snapshot[field] ?? snapshot.equipment?.[field]?.itemId);
    if (equipped === item) countValue += 1;
    else missingIronCost += cost;
  }
  if (countValue === 0 && Number.isSafeInteger(snapshot.equippedArmorPieces)) {
    countValue = Math.max(0, Math.min(4, snapshot.equippedArmorPieces));
    // Aggregate-only compatibility cannot identify slots. Use the conservative
    // most-expensive remaining-prefix cost solely for shadow ranking.
    missingIronCost = [24, 19, 11, 4, 0][countValue];
  }
  return { count: countValue, missingIronCost };
}

function normalizedMissionGoal(snapshot, context) {
  return text(context.missionGoal ?? snapshot.missionGoal ?? snapshot.goal) || 'iron_armor';
}

function normalizedObjective(value) {
  const objective = text(value).toUpperCase();
  return OBJECTIVE_ORDER.includes(objective) ? objective : 'GATHER_WOOD';
}

function normalizedDimension(value) {
  const raw = text(value).toLowerCase() || 'minecraft:overworld';
  if (raw.includes(':')) return raw;
  if (raw === 'overworld' || raw === 'the_nether' || raw === 'the_end') return `minecraft:${raw}`;
  return `minecraft:${raw.replace(/[^a-z0-9_.-]+/g, '_')}`;
}

function normalizedPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = finiteOrNull(raw.x);
  const y = finiteOrNull(raw.y);
  const z = finiteOrNull(raw.z);
  return x == null || y == null || z == null ? null : { x, y, z };
}

function normalizedSignals(raw) {
  if (Array.isArray(raw)) return Object.freeze([...new Set(raw.map(text).filter(Boolean))].sort());
  if (!raw || typeof raw !== 'object') return Object.freeze({});
  const result = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (Number.isSafeInteger(value) && value >= 0) result[key] = value;
    else if (value === true || value === false) result[key] = value;
    else if (typeof value === 'string') result[key] = value.slice(0, 128);
  }
  return Object.freeze(result);
}

function signalCount(signals, key) {
  if (signals && !Array.isArray(signals) && typeof signals === 'object') return count(signals[key]);
  if (!Array.isArray(signals)) return 0;
  const prefix = `${key.toLowerCase()}:`;
  for (const signal of signals) {
    const normalized = text(signal).toLowerCase();
    if (normalized.startsWith(prefix)) return count(Number(normalized.slice(prefix.length)));
  }
  return 0;
}

function signalSet(raw) {
  const result = new Set();
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const signal = text(value).toLowerCase();
      if (signal) result.add(signal);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const signal = text(key).toLowerCase();
      if (signal && value !== false && value !== 0 && value != null) result.add(signal);
    }
  }
  return result;
}

function distanceFromSnapshot(snapshot, target) {
  const x = finiteOrNull(snapshot.x);
  const z = finiteOrNull(snapshot.z);
  const tx = finiteOrNull(target.x);
  const tz = finiteOrNull(target.z);
  return x == null || z == null || tx == null || tz == null ? 384 : Math.hypot(tx - x, tz - z);
}

function compactIntent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.freeze({
    action: text(raw.action) || null,
    commandId: text(raw.commandId) || null,
    missionObjective: text(raw.missionObjective) || null,
    reason: text(raw.reason).slice(0, 160) || null,
  });
}

function rejectionReasonCounts(rejections) {
  const counts = new Map();
  for (const entry of rejections || []) {
    const reason = text(entry?.reason) || 'unknown';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return Object.freeze(Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function canonicalItem(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return '';
  return raw.includes(':') ? raw : `minecraft:${raw}`;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function classifiedError(error) {
  return text(error instanceof Error ? error.message : error)
    .toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 96) || 'unknown';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function finite(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function nonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : 0;
}

function probability(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : fallback;
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min ? Math.min(max, value) : fallback;
}

function safeAdd(left, right) {
  const sum = count(left) + count(right);
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
