import crypto from 'node:crypto';

export const VILLAGE_OPPORTUNITY_ACTIONS = Object.freeze([
  'village_travel',
  'village_revalidate',
  'village_inspect_container',
  'village_withdraw_item',
  'village_harvest_hay',
  'village_craft_bread',
  'village_collect_bed',
  'village_defeat_iron_golem',
]);

export const VILLAGE_DETOUR_LIMITS = Object.freeze({
  hardDeadlineMs: 420_000,
  maxTravelBlocks: 384,
  maxFailures: 2,
  maxRouteReplans: 1,
  maxContainers: 2,
  maxWithdrawals: 16,
  maxBreadCrafts: 8,
  maxSelectedOpportunities: 3,
  maxReceiptHistory: 64,
});

export const VILLAGE_AGGREGATE_MEMBER_LIMITS = Object.freeze({
  maxHorizontalBlocks: 48,
  maxVerticalBlocks: 16,
});

const VILLAGE_TYPES = new Set(['village', 'container', 'hay', 'bed', 'iron_golem']);
const CODE_OWNED_READINESS_SOURCE = 'code_owned_registry_v1';
const REMOTE_AGGREGATE_EXECUTORS = Object.freeze({
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
});
const IRON_GOLEM_EXECUTOR = Object.freeze({
  capabilityId: 'village_golem_iron',
  executorId: 'village_defeat_iron_golem',
});
const ITEM_ID_RE = /^minecraft:[a-z0-9_./-]+$/;
const EXACT_CONTAINER_ITEM_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const EXACT_CONTAINER_ITEM_LIMIT = 64;
const MISSION_TOKEN_RE = /^[a-z0-9_.-]{1,128}$/;
const SUCCESS_SUFFIX = Object.freeze({
  village_travel: 'arrived',
  village_revalidate: 'verified',
  village_inspect_container: 'inspected',
  village_withdraw_item: 'withdrawn',
  village_harvest_hay: 'harvested',
  village_craft_bread: 'crafted',
  village_collect_bed: 'collected',
  village_defeat_iron_golem: 'collected',
});
const TERMINAL_NEUTRAL_SUFFIXES = new Set(['unavailable', 'invalidated', 'unsafe']);
const LOCAL_VALUE_ACTIONS = new Set([
  'village_inspect_container',
  'village_withdraw_item',
  'village_harvest_hay',
  'village_craft_bread',
  'village_collect_bed',
  'village_defeat_iron_golem',
]);
const RECEIPT_FIRST_CATALOG_BOUNDARY_STAGES = new Set([
  'TRAVEL',
  'TRAVEL_EDGE',
  'REVALIDATE',
  'REVALIDATE_EDGE',
]);
const RECEIPT_FIRST_CATALOG_MUTATION_ACTIONS = new Set([
  'village_harvest_hay',
  'village_collect_bed',
  'village_defeat_iron_golem',
]);
const MUTATING_VALUE_ACTIONS = new Set([
  'village_inspect_container',
  'village_withdraw_item',
  'village_harvest_hay',
  'village_collect_bed',
  'village_defeat_iron_golem',
]);
const POSITIVE_CONTAINER_PRIORITY = Object.freeze([
  'minecraft:iron_pickaxe',
  'minecraft:iron_chestplate',
  'minecraft:iron_leggings',
  'minecraft:iron_helmet',
  'minecraft:iron_boots',
  'minecraft:iron_ingot',
  'minecraft:raw_iron',
  'minecraft:coal',
  'minecraft:charcoal',
  'minecraft:bread',
  'minecraft:golden_apple',
  'minecraft:apple',
  'minecraft:water_bucket',
  'minecraft:flint_and_steel',
  'minecraft:shield',
  'minecraft:bow',
  'minecraft:arrow',
]);
const IRON_VALUE_BY_ITEM = Object.freeze({
  'minecraft:raw_iron': 1,
  'minecraft:iron_ingot': 1,
  'minecraft:iron_pickaxe': 3,
  'minecraft:iron_helmet': 5,
  'minecraft:iron_chestplate': 8,
  'minecraft:iron_leggings': 7,
  'minecraft:iron_boots': 4,
});
const IRON_ARMOR_ITEMS = Object.freeze([
  'minecraft:iron_helmet',
  'minecraft:iron_chestplate',
  'minecraft:iron_leggings',
  'minecraft:iron_boots',
]);
const IRON_ARMOR_EQUIPPED_FIELDS = Object.freeze({
  'minecraft:iron_helmet': 'equippedHelmetItem',
  'minecraft:iron_chestplate': 'equippedChestplateItem',
  'minecraft:iron_leggings': 'equippedLeggingsItem',
  'minecraft:iron_boots': 'equippedBootsItem',
});
const POSITIVE_FOOD_ITEMS = Object.freeze([
  'minecraft:bread',
  'minecraft:apple',
  'minecraft:golden_apple',
]);
const FOOD_NUTRITION = Object.freeze({
  'minecraft:bread': 5,
  'minecraft:apple': 4,
  'minecraft:golden_apple': 4,
});
const FOOD_RESERVE_TARGET = 25;

/**
 * A deterministic, bounded transaction around a code-generated village plan.
 *
 * The controller deliberately knows nothing about MissionOrchestrator. While
 * a detour is active the owner holds that orchestrator completely still; this
 * controller owns only `village_*` command identities and returns one neutral
 * terminal stop before the baseline is recomputed from live state.
 */
export class VillageOpportunityTransactionController {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.emit = typeof options.emit === 'function' ? options.emit : () => {};
    this.applyReceipt = typeof options.applyReceipt === 'function' ? options.applyReceipt : null;
    this.ttlMs = positiveInteger(options.ttlMs, 4_000);
    this.maxTtlMs = positiveInteger(options.maxTtlMs, 15_000);
    this.limits = Object.freeze(normalizeLimits(options.limits));
    this.sequence = 0;
    this.active = null;
    this.consumedCommandIds = [];
    this.consumedCommandIdSet = new Set();
    this.usedDecisionIds = [];
    this.usedDecisionIdSet = new Set();
    this.lastBaselineRetentionKey = null;
  }

  isActive() {
    return this.active !== null;
  }

  ownsReceipt(snapshotOrCommandId) {
    const commandId = typeof snapshotOrCommandId === 'string'
      ? snapshotOrCommandId
      : observedCommandId(snapshotOrCommandId);
    if (!commandId) return false;
    return this.active?.command?.commandId === commandId || this.consumedCommandIdSet.has(commandId);
  }

  activeSnapshot() {
    const tx = this.active;
    if (!tx) return null;
    return Object.freeze({
      detourId: tx.detourId,
      stage: tx.stage,
      stageSeq: tx.stageSeq,
      commandId: tx.command?.commandId || null,
      opportunityIds: Object.freeze([...tx.opportunityIds]),
      originalObjective: tx.originalObjective,
      originalCommandId: tx.originalCommandId,
      resumeToken: tx.resumeToken,
      startedAtMs: tx.startedAtMs,
      deadlineAtMs: tx.deadlineAtMs,
      travelBlocks: tx.travelBlocks,
      failureCount: tx.failureCount,
      routeReplanCount: tx.routeReplanCount,
    });
  }

  reset(reason = 'reset') {
    if (this.active) this.#terminal('failed', reason, null);
    this.active = null;
  }

  /** Returns a physical detour intent, a one-tick terminal stop, or null. */
  tick(snapshot = {}) {
    const tx = this.active;
    if (!tx) return null;
    const now = nonNegative(this.now());
    // Scope, player safety, and the transaction's fixed physical budgets stay
    // authoritative even on a terminal executor tick. Catalog liveness is
    // intentionally ordered later for exact travel/revalidation receipts: the
    // scanner snapshot can rotate or temporarily omit the frozen discovery in
    // the same poll that Java publishes its correlated boundary receipt.
    const invariant = transactionInvariantVerdict(tx, snapshot);
    if (!invariant.ok) return this.#fallback(invariant.reason, snapshot, true);
    // Once the exact golem executor owns an engagement, Java also owns its
    // bounded escape lease. A hit can simultaneously make the generic village
    // policy report low health, a nearby threat, water contact, or unsafe
    // travel; replacing the command here would strand that escape before Java
    // can publish its correlated neutral receipt. Scope changes and death were
    // already handled by transactionInvariantVerdict above and remain
    // immediate. The lease ends with this exact command's terminal receipt.
    const safety = exactActiveGolemSafetyLease(tx)
      ? { safe: true, reason: 'exact_golem_safety_lease' }
      : villageSafetyVerdict(snapshot, { requireGrounded: false });
    if (!safety.safe) return this.#fallback(safety.reason, snapshot, true);
    this.#observeTravel(snapshot);
    if (tx.travelBlocks > this.limits.maxTravelBlocks) {
      return this.#fallback('travel_budget_exhausted', snapshot, true);
    }
    if (now >= tx.deadlineAtMs) return this.#fallback('detour_deadline', snapshot, true);

    if (isExactCatalogBoundaryReceipt(tx, snapshot)) {
      const outcome = this.#consumeReceipt(snapshot);
      if (outcome?.intent) return outcome.intent;
      if (outcome?.terminal) return outcome.terminal;
      if (!this.active) return null;
    }

    // An exact executor-owned local rejection is source-level feedback. Consume
    // it before catalog liveness so UNAVAILABLE/INVALIDATED/UNSAFE can spend the
    // transaction's first local failure and continue with a different source.
    // Correlation remains mandatory, and travel/revalidation still fail closed
    // through the boundary-receipt path above.
    if (isExactLocalNeutralReceipt(tx, snapshot)) {
      const outcome = this.#consumeReceipt(snapshot);
      if (outcome?.intent) return outcome.intent;
      if (outcome?.terminal) return outcome.terminal;
      if (!this.active) return null;
    }

    // Harvesting, collecting, and container mutation legitimately change the
    // scanner record before Java can publish its terminal inventory receipt.
    // Exempt only the exact code-owned member for the lifetime of that one
    // command. Sibling/root discoveries remain live-revalidated, and the
    // member is persisted in selfModifiedOpportunityIds only after the receipt
    // passes the authoritative correlation and inventory checks below.
    const activeMutation = activeMutatingOpportunity(tx);
    const exactMutationReceipt = verifiedCatalogMutationReceipt(tx, snapshot);
    if (exactMutationReceipt) {
      // A physical mutation can invalidate or re-key its scanner aggregate in
      // the same poll that Java publishes the exact terminal receipt. Consume
      // that receipt before ordinary root liveness only when the owning root
      // previously passed exact Java revalidation and is absent from a
      // declared-truncated (rather than contradicted by) wire catalog. All
      // sibling and unrelated-root checks remain authoritative on this tick.
      const receiptLifecycle = lifecycleVerdict(tx, snapshot, activeMutation, {
        allowVerifiedMutationOwnerOmission: true,
      });
      if (!receiptLifecycle.ok) {
        return this.#fallback(receiptLifecycle.reason, snapshot, true);
      }
      for (const rebase of receiptLifecycle.rootRebases || []) {
        rebaseSelectedRoot(tx, rebase.rootId, rebase.live);
        tx.pendingRootMutations.delete(rebase.rootId);
      }
      const outcome = this.#consumeReceipt(snapshot);
      if (outcome?.intent) return outcome.intent;
      if (outcome?.terminal) return outcome.terminal;
      if (!this.active) return null;
    }
    const lifecycle = lifecycleVerdict(tx, snapshot, activeMutation);
    if (!lifecycle.ok) return this.#fallback(lifecycle.reason, snapshot, true);
    for (const rebase of lifecycle.rootRebases || []) {
      rebaseSelectedRoot(tx, rebase.rootId, rebase.live);
      tx.pendingRootMutations.delete(rebase.rootId);
    }

    if (snapshot.currentCommandCompleted === true) {
      const receiptCommandId = observedCommandId(snapshot);
      if (receiptCommandId !== tx.command?.commandId) {
        if (isVillageCommandId(receiptCommandId) && !tx.rejectedReceiptIds.has(receiptCommandId)) {
          tx.rejectedReceiptIds.add(receiptCommandId);
          this.#emit('opportunity.detour.receipt_rejected', tx, {
            commandId: receiptCommandId,
            expectedCommandId: tx.command?.commandId || null,
            reason: 'stale_command_id',
          });
        }
      } else {
        const outcome = this.#consumeReceipt(snapshot);
        if (outcome?.intent) return outcome.intent;
        if (outcome?.terminal) return outcome.terminal;
      }
    }

    if (!this.active) return null;
    if (!this.active.command) this.#installCommand(snapshot);
    return this.active.command?.intent || null;
  }

  /**
   * Start only from a completed, revision-keyed planner decision. The caller
   * must have already built the deterministic baseline intent for this poll.
   */
  maybeStart(decision, snapshot = {}, baseline = {}) {
    if (this.active) return null;
    const admission = admitDecision(decision, snapshot, baseline, this.limits, this.usedDecisionIdSet);
    if (!admission.ok) {
      const retentionKey = `${admission.decisionId || decision?.decisionId || 'none'}:${admission.reason}`;
      if (retentionKey !== this.lastBaselineRetentionKey) {
        this.lastBaselineRetentionKey = retentionKey;
        this.emit({
          evt: 'opportunity.active.baseline_retained',
          reason: admission.reason,
          decisionId: admission.decisionId || decision?.decisionId || null,
          originalObjective: baseline.objective || baseline.intent?.missionObjective || null,
          originalCommandId: baseline.intent?.commandId || null,
          chargedAsBaselineFailure: false,
          clocksReset: false,
          retriesConsumed: 0,
          behaviorApplied: false,
          ...villageOpportunityFoodTelemetry(snapshot),
        });
      }
      return null;
    }

    this.lastBaselineRetentionKey = null;

    this.sequence += 1;
    const now = nonNegative(this.now());
    const detourId = `village-detour-${this.sequence}-${shortHash(admission.decision.decisionId)}`;
    const originalCommandId = text(baseline.intent?.commandId) || null;
    const originalObjective = text(baseline.objective ?? baseline.intent?.missionObjective) || null;
    const resumeToken = `resume-${shortHash(`${detourId}:${originalCommandId || 'none'}:${originalObjective || 'none'}`)}`;
    const current = groundedPosition(snapshot);
    const queue = initialQueue(
      admission.opportunities,
      snapshot,
      admission.decision.ledger,
      this.limits,
    );
    const ironGolemDetour = admission.primary.type === 'iron_golem';
    this.active = {
      detourId,
      decisionId: admission.decision.decisionId,
      worldId: admission.decision.worldId,
      dimension: admission.decision.dimension,
      mission: text(admission.decision.missionGoal).toLowerCase(),
      memoryRevision: admission.decision.memoryRevision,
      ledgerRevision: admission.decision.ledgerRevision,
      opportunityIds: admission.opportunities.map((entry) => entry.id),
      selected: admission.opportunities,
      ledger: admission.decision.ledger || Object.freeze({ owned: {}, reserved: {}, deficit: {} }),
      primary: admission.primary,
      originalObjective,
      originalCommandId,
      resumeToken,
      objectiveStartedAtMs: finiteOrNull(baseline.objectiveStartedAtMs),
      objectiveFailures: nonNegativeInteger(baseline.objectiveFailures, 0),
      healthBaseline: finite(snapshot.health, 20),
      startedAtMs: now,
      deadlineAtMs: now + this.limits.hardDeadlineMs,
      stage: ironGolemDetour ? 'DEFEAT_GOLEM' : 'TRAVEL',
      stageSeq: 1,
      command: null,
      queue: ironGolemDetour ? [] : queue,
      inspectedContainers: new Set(),
      containerRevisions: new Map(),
      selfModifiedOpportunityIds: new Set(),
      pendingRootMutations: new Map(),
      exactlyRevalidatedOpportunityIds: new Set(),
      wireOmissibleRootIds: new Set(),
      forceCompleteAfterVerifiedMutation: false,
      withdrawalCount: 0,
      breadCraftCount: 0,
      failureCount: 0,
      routeReplanCount: 0,
      travelBlocks: 0,
      lastPosition: current,
      rejectedReceiptIds: new Set(),
      stageBaseline: null,
    };
    this.#rememberDecision(admission.decision.claimId || admission.decision.decisionId);
    this.#emit('opportunity.detour.started', this.active, {
      opportunityIds: [...this.active.opportunityIds],
      target: compactPosition(this.active.primary),
      directDistance: admission.directDistance,
      recommendationChoiceId: admission.decision.recommendation?.choiceId || null,
      recommendationScoreSeconds: finiteOrNull(admission.decision.recommendation?.scoreSeconds),
      recommendationBenefitSeconds:
        finiteOrNull(admission.decision.recommendation?.conservativeBenefitSeconds),
      ...villageOpportunityFoodTelemetry(snapshot),
    });
    this.#installCommand(snapshot);
    return this.active.command.intent;
  }

  #consumeReceipt(snapshot) {
    const tx = this.active;
    const command = tx.command;
    const reason = text(snapshot.currentCommandCompletionReason);
    this.#rememberConsumedCommand(command.commandId);
    const receipt = classifyReceipt(command.action, reason);
    if (!receipt.ok) {
      this.#emit('opportunity.detour.receipt_rejected', tx, {
        commandId: command.commandId,
        action: command.action,
        reason: receipt.reason,
        completionReason: reason,
      });
      return this.#handleFailure(receipt.reason, snapshot);
    }
    if (receipt.neutralTerminal) {
      const verifiedNeutral = verifyNeutralReceipt(command, snapshot, tx, receipt.reason);
      if (!verifiedNeutral.ok) {
        this.#emit('opportunity.detour.receipt_rejected', tx, {
          commandId: command.commandId,
          action: command.action,
          reason: verifiedNeutral.reason,
          completionReason: reason,
        });
        return this.#handleFailure(verifiedNeutral.reason, snapshot);
      }
      observePhysicalRouteReplans(tx, verifiedNeutral.receipt);
      const memoryFeedback = this.#applyNeutralAuthoritativeReceipt(
        command, receipt.reason, verifiedNeutral,
      );
      if (!memoryFeedback.ok) {
        this.#emit('opportunity.detour.receipt_rejected', tx, {
          commandId: command.commandId,
          action: command.action,
          reason: `memory_${memoryFeedback.reason}`,
          completionReason: reason,
        });
      }
      return this.#handleFailure(receipt.reason, snapshot);
    }

    const verified = verifyReceipt(command, snapshot, tx);
    if (!verified.ok) {
      this.#emit('opportunity.detour.receipt_rejected', tx, {
        commandId: command.commandId,
        action: command.action,
        reason: verified.reason,
        completionReason: reason,
      });
      return this.#handleFailure(verified.reason, snapshot);
    }
    observePhysicalRouteReplans(tx, verified.receipt);
    const memoryReceipt = this.#applyAuthoritativeReceipt(command, snapshot, reason, verified);
    if (!memoryReceipt.ok) {
      this.#emit('opportunity.detour.receipt_rejected', tx, {
        commandId: command.commandId,
        action: command.action,
        reason: `memory_${memoryReceipt.reason}`,
        completionReason: reason,
      });
      return this.#handleFailure(`memory_${memoryReceipt.reason}`, snapshot);
    }
    if (memoryReceipt.value?.revision != null && command.task?.opportunityId) {
      tx.containerRevisions.set(command.task.opportunityId, memoryReceipt.value.revision);
    }

    const completedStage = tx.stage;
    tx.command = null;
    if (completedStage === 'TRAVEL') {
      this.#setStage('REVALIDATE', { reason: 'travel_arrived' });
    } else if (completedStage === 'TRAVEL_EDGE') {
      this.#setStage('REVALIDATE_EDGE', { reason: 'travel_edge_arrived', task: command.task });
      tx.stageTask = command.task;
    } else if (completedStage === 'REVALIDATE') {
      tx.exactlyRevalidatedOpportunityIds.add(command.task.opportunityId);
      this.#refreshQueue(snapshot);
      this.#advanceQueue(snapshot);
    } else if (completedStage === 'REVALIDATE_EDGE') {
      tx.exactlyRevalidatedOpportunityIds.add(command.task.opportunityId);
      this.#advanceQueue(snapshot);
    } else {
      this.#applyStageSuccess(completedStage, snapshot, command, memoryReceipt, verified);
      if (tx.forceCompleteAfterVerifiedMutation) {
        this.#setStage('COMPLETE', { reason: 'verified_mutation_root_unresolved' });
      } else {
        this.#advanceQueue(snapshot);
      }
    }
    if (!this.active) return { terminal: null };
    if (this.active.stage === 'COMPLETE') {
      return { terminal: this.#terminalStop('completed', 'village_transaction_complete', snapshot) };
    }
    this.#installCommand(snapshot);
    return { intent: this.active.command?.intent || null };
  }

  #handleFailure(reason, snapshot) {
    const tx = this.active;
    const failedOpportunityId = text(tx.command?.task?.opportunityId);
    tx.failureCount += 1;
    if (tx.failureCount >= this.limits.maxFailures
        || ['TRAVEL', 'REVALIDATE', 'TRAVEL_EDGE', 'REVALIDATE_EDGE', 'DEFEAT_GOLEM'].includes(tx.stage)) {
      return { terminal: this.#fallback(reason, snapshot, false) };
    }
    // One local value source may disappear without stranding the whole village
    // detour. Skip it; the second failure remains the hard bound.
    if (failedOpportunityId) {
      tx.queue = tx.queue.filter((queued) => text(queued?.opportunityId) !== failedOpportunityId);
    }
    tx.command = null;
    this.#emit('opportunity.detour.stage_failed', tx, {
      reason,
      chargedAsBaselineFailure: false,
    });
    this.#advanceQueue(snapshot);
    if (tx.stage === 'COMPLETE') {
      return { terminal: this.#terminalStop('completed', 'village_transaction_partial', snapshot) };
    }
    this.#installCommand(snapshot);
    return { intent: tx.command.intent };
  }

  #refreshQueue(snapshot) {
    const tx = this.active;
    tx.queue = initialQueue(tx.selected, snapshot, tx.ledger, this.limits, {
      atSiteOpportunityId: tx.primary.id,
    });
  }

  #advanceQueue(snapshot) {
    const tx = this.active;
    while (tx.queue.length > 0) {
      const next = tx.queue.shift();
      if (next.stage === 'TRAVEL_EDGE') {
        const pendingValue = tx.queue[0];
        if (pendingValue?.opportunityId === next.opportunityId
            && isRefreshableValueStage(pendingValue.stage)) {
          const refreshedValue = refreshTaskForSnapshot(pendingValue, snapshot, tx.ledger);
          if (!refreshedValue) {
            tx.queue.shift();
            continue;
          }
          tx.queue[0] = refreshedValue;
        }
      }
      if (next.stage === 'INSPECT_CONTAINER' && tx.inspectedContainers.size >= this.limits.maxContainers) continue;
      if (next.stage === 'WITHDRAW_ITEM' && tx.withdrawalCount >= this.limits.maxWithdrawals) continue;
      const refreshed = refreshTaskForSnapshot(next, snapshot, tx.ledger);
      if (!refreshed) continue;
      this.#setStage(refreshed.stage, { reason: 'next_value_task', task: refreshed });
      tx.stageTask = refreshed;
      return;
    }
    this.#setStage('COMPLETE', { reason: 'bounded_value_tasks_complete' });
  }

  #applyStageSuccess(stage, snapshot, command, memoryReceipt, verified) {
    const tx = this.active;
    const task = command.task;
    if (MUTATING_VALUE_ACTIONS.has(command.action) && task?.opportunityId) {
      tx.selfModifiedOpportunityIds.add(task.opportunityId);
      commitVerifiedOwningRootMutation(tx, command, snapshot);
    }
    if (stage === 'INSPECT_CONTAINER') {
      tx.inspectedContainers.add(task.opportunityId);
      const memoryValue = memoryReceipt?.value;
      const container = memoryValue ? {
        id: task.opportunityId,
        revision: memoryValue.revision,
        contentsKnown: memoryValue.details?.contentsKnown === true,
        items: memoryValue.details?.items || {},
        ...compactPosition(task),
      } : null;
      tx.queue.unshift(...withdrawalTasks(container, snapshot, tx.ledger, this.limits));
    } else if (stage === 'WITHDRAW_ITEM') {
      tx.withdrawalCount += 1;
      const memoryValue = memoryReceipt?.value;
      const remainingWithdrawals = Math.max(
        0,
        this.limits.maxWithdrawals - tx.withdrawalCount,
      );
      // The executor's post-click container map is newer than every queued task derived from the
      // inspection snapshot. Atomically discard that source's stale withdrawals and rebuild only
      // from the exact final contents. This can discover concurrently added value, while removed
      // items cannot consume the second neutral-failure allowance on a knowingly stale request.
      tx.queue = tx.queue.filter((queued) => !(queued.stage === 'WITHDRAW_ITEM'
        && queued.opportunityId === task.opportunityId));
      if (memoryValue && remainingWithdrawals > 0) {
        const container = {
          id: task.opportunityId,
          revision: memoryValue.revision,
          contentsKnown: memoryValue.details?.contentsKnown === true,
          items: memoryValue.details?.items || {},
          ...compactPosition(task),
        };
        tx.queue.unshift(...withdrawalTasks(
          container,
          snapshot,
          tx.ledger,
          { ...this.limits, maxWithdrawals: remainingWithdrawals },
        ));
      }
    } else if (stage === 'HARVEST_HAY') {
      const breadTask = breadCraftTask(
        snapshot,
        task,
        this.limits.maxBreadCrafts - tx.breadCraftCount,
      );
      if (breadTask) tx.queue.unshift(breadTask);
    } else if (stage === 'CRAFT_BREAD') {
      tx.breadCraftCount += count(verified?.inventoryDelta);
      const breadTask = tx.breadCraftCount < this.limits.maxBreadCrafts
        ? breadCraftTask(
            snapshot,
            task,
            this.limits.maxBreadCrafts - tx.breadCraftCount,
          )
        : null;
      if (breadTask) tx.queue.unshift(breadTask);
    }
  }

  #setStage(stage, extra = {}) {
    const tx = this.active;
    const priorStage = tx.stage;
    tx.stage = stage;
    tx.stageSeq += 1;
    tx.command = null;
    this.#emit('opportunity.detour.stage_changed', tx, {
      priorStage,
      stage,
      ...extra,
    });
  }

  #installCommand(snapshot) {
    const tx = this.active;
    const action = actionForStage(tx.stage);
    if (!action) return;
    const rawTask = tx.stageTask || taskForStage(tx.stage, tx.primary, snapshot);
    const task = rawTask && tx.containerRevisions.has(rawTask.opportunityId)
      ? Object.freeze({ ...rawTask, revision: tx.containerRevisions.get(rawTask.opportunityId) })
      : rawTask;
    const stageBaseline = stageInventoryBaseline(action, task, snapshot);
    const commandId = `mission-village-${sanitizeId(tx.detourId)}-${tx.stageSeq}`;
    const intent = {
      action,
      ttlMs: this.ttlMs,
      maxTtlMs: this.maxTtlMs,
      commandId,
      reason: `opportunity:village:${tx.stage.toLowerCase()}`,
      missionObjective: tx.originalObjective,
      missionDone: false,
      opportunityId: task?.opportunityId || tx.primary.id,
      opportunityRevision: task?.revision ?? tx.primary.revision ?? null,
      opportunityMission: tx.mission,
      opportunityStage: tx.stage.toLowerCase(),
      resumeToken: tx.resumeToken,
      detourId: tx.detourId,
      detourStageSeq: tx.stageSeq,
    };
    const target = compactPosition(task || tx.primary);
    if (target) {
      intent.targetX = target.x;
      intent.targetY = target.y;
      intent.targetZ = target.z;
    }
    if (ITEM_ID_RE.test(task?.targetItemId || '')) intent.targetItemId = task.targetItemId;
    if (positiveIntegerOrNull(task?.targetItemCount)) intent.targetItemCount = task.targetItemCount;
    tx.command = { commandId, action, task, stageBaseline, intent: Object.freeze(intent) };
    tx.stageBaseline = stageBaseline;
  }

  #observeTravel(snapshot) {
    const tx = this.active;
    const current = groundedPosition(snapshot);
    if (!current) return;
    if (tx.lastPosition) {
      const delta = horizontalDistance(tx.lastPosition, current);
      if (delta > 32) {
        tx.travelBlocks = this.limits.maxTravelBlocks + 1;
      } else {
        tx.travelBlocks += delta;
      }
    }
    tx.lastPosition = current;
  }

  #fallback(reason, snapshot, countFailure) {
    const tx = this.active;
    if (!tx) return null;
    if (countFailure) tx.failureCount = Math.min(this.limits.maxFailures, tx.failureCount + 1);
    return this.#terminalStop('failed', reason, snapshot);
  }

  #terminalStop(outcome, reason, snapshot) {
    const tx = this.active;
    if (!tx) return null;
    const stopId = `mission-village-${sanitizeId(tx.detourId)}-terminal-${tx.stageSeq + 1}`;
    this.#rememberConsumedCommand(tx.command?.commandId);
    const summary = this.#terminal(outcome, reason, snapshot);
    this.#rememberConsumedCommand(stopId);
    return Object.freeze({
      action: 'stop',
      ttlMs: this.ttlMs,
      maxTtlMs: this.maxTtlMs,
      commandId: stopId,
      reason: `opportunity:village:${outcome === 'completed' ? 'complete' : 'fallback'}:${reason}`,
      missionObjective: summary.originalObjective,
      missionDone: false,
      opportunityMission: summary.mission,
      opportunityStage: outcome === 'completed' ? 'complete' : 'fallback',
      resumeToken: summary.resumeToken,
      detourId: summary.detourId,
      detourStageSeq: summary.stageSeq + 1,
    });
  }

  #terminal(outcome, reason, snapshot) {
    const tx = this.active;
    const now = nonNegative(this.now());
    const summary = {
      detourId: tx.detourId,
      decisionId: tx.decisionId,
      stage: tx.stage,
      stageSeq: tx.stageSeq,
      opportunityIds: [...tx.opportunityIds],
      mission: tx.mission,
      originalObjective: tx.originalObjective,
      originalCommandId: tx.originalCommandId,
      resumeToken: tx.resumeToken,
      objectiveStartedAtMs: tx.objectiveStartedAtMs,
      objectiveFailuresBefore: tx.objectiveFailures,
      elapsedMs: Math.max(0, now - tx.startedAtMs),
      travelBlocks: round3(tx.travelBlocks),
      failureCount: tx.failureCount,
      routeReplanCount: tx.routeReplanCount,
      reason,
      clocksReset: false,
      retriesConsumed: 0,
      chargedAsBaselineFailure: false,
      behaviorApplied: true,
    };
    this.emit({
      evt: outcome === 'completed' ? 'opportunity.detour.completed' : 'opportunity.detour.failed',
      ...summary,
    });
    if (this.applyReceipt) {
      const result = this.applyReceipt(Object.freeze({
        type: 'transaction_outcome',
        id: tx.detourId,
        commandId: tx.command?.commandId || tx.detourId,
        receiptId: `outcome-${shortHash(`${tx.detourId}:${outcome}:${reason}`)}`,
        at: now,
        status: outcome,
        details: Object.freeze({
          reason,
          opportunityIds: [...tx.opportunityIds],
          elapsedMs: summary.elapsedMs,
          travelBlocks: summary.travelBlocks,
          failureCount: tx.failureCount,
          routeReplanCount: tx.routeReplanCount,
        }),
      }));
      if (result?.ok === false) {
        this.emit({
          evt: 'opportunity.detour.receipt_rejected',
          ...summary,
          action: 'transaction_outcome',
          reason: `memory_${result.reason || 'outcome_rejected'}`,
        });
      }
    }
    if (outcome === 'failed') {
      this.emit({
        evt: 'opportunity.detour.fallback',
        ...summary,
        outcome,
        authoritativeInventoryReplan: true,
      });
    }
    this.active = null;
    return summary;
  }

  #applyAuthoritativeReceipt(command, snapshot, completionReason, verified) {
    if (!this.applyReceipt) return { ok: true, reason: 'no_memory_sink' };
    const structuredReceipt = verified?.receipt;
    const receiptId = structuredReceipt?.receiptId
      || `receipt-${shortHash(`${command.commandId}:${completionReason}`)}`;
    if (command.action === 'village_inspect_container') {
      return this.applyReceipt(Object.freeze({
        type: 'container_inspection',
        containerId: command.task.opportunityId,
        expectedContainerRevision: command.task.revision,
        commandId: command.commandId,
        receiptId,
        items: structuredReceipt.knownContainerContents,
        inspectedAt: nonNegative(this.now()),
        status: 'inspected',
      })) || { ok: false, reason: 'empty_memory_result' };
    }
    if (command.action === 'village_withdraw_item') {
      return this.applyReceipt(Object.freeze({
        type: 'container_withdrawal',
        containerId: command.task.opportunityId,
        expectedContainerRevision: command.task.revision,
        commandId: command.commandId,
        receiptId,
        withdrawnItems: Object.freeze({
          [command.task.targetItemId]: verified.inventoryDelta,
        }),
        items: structuredReceipt.knownContainerContents,
        withdrawnAt: nonNegative(this.now()),
        status: 'inspected',
      })) || { ok: false, reason: 'empty_memory_result' };
    }
    if (command.action === 'village_defeat_iron_golem') {
      return this.applyReceipt(Object.freeze({
        type: 'iron_golem_collection',
        opportunityId: command.task.opportunityId,
        expectedOpportunityRevision: command.task.revision,
        commandId: command.commandId,
        receiptId,
        inventoryDelta: structuredReceipt.inventoryDelta,
        consumedInventoryDelta: structuredReceipt.consumedInventoryDelta,
        collectedAt: nonNegative(this.now()),
      })) || { ok: false, reason: 'empty_memory_result' };
    }
    return { ok: true, reason: 'not_memory_backed' };
  }

  #applyNeutralAuthoritativeReceipt(command, reason, verified) {
    if (!this.applyReceipt || ![
      'village_inspect_container',
      'village_withdraw_item',
    ].includes(command.action)) {
      return { ok: true, reason: 'not_memory_backed' };
    }
    const structuredReceipt = verified?.receipt;
    return this.applyReceipt(Object.freeze({
      type: 'container_refresh_required',
      containerId: command.task.opportunityId,
      expectedContainerRevision: command.task.revision,
      commandId: command.commandId,
      receiptId: structuredReceipt?.receiptId
        || `receipt-${shortHash(`${command.commandId}:${reason}`)}`,
      observedAt: nonNegative(this.now()),
      reason,
    })) || { ok: false, reason: 'empty_memory_result' };
  }

  #emit(evt, tx, extra = {}) {
    this.emit({
      evt,
      detourId: tx.detourId,
      decisionId: tx.decisionId,
      stage: tx.stage,
      stageSeq: tx.stageSeq,
      originalObjective: tx.originalObjective,
      originalCommandId: tx.originalCommandId,
      resumeToken: tx.resumeToken,
      opportunityIds: [...tx.opportunityIds],
      elapsedMs: Math.max(0, nonNegative(this.now()) - tx.startedAtMs),
      travelBlocks: round3(tx.travelBlocks),
      failureCount: tx.failureCount,
      routeReplanCount: tx.routeReplanCount,
      clocksReset: false,
      retriesConsumed: 0,
      chargedAsBaselineFailure: false,
      behaviorApplied: true,
      ...extra,
    });
  }

  #rememberConsumedCommand(commandId) {
    if (!commandId || this.consumedCommandIdSet.has(commandId)) return;
    this.consumedCommandIdSet.add(commandId);
    this.consumedCommandIds.push(commandId);
    while (this.consumedCommandIds.length > this.limits.maxReceiptHistory) {
      this.consumedCommandIdSet.delete(this.consumedCommandIds.shift());
    }
  }

  #rememberDecision(decisionId) {
    if (!decisionId || this.usedDecisionIdSet.has(decisionId)) return;
    this.usedDecisionIdSet.add(decisionId);
    this.usedDecisionIds.push(decisionId);
    while (this.usedDecisionIds.length > 64) this.usedDecisionIdSet.delete(this.usedDecisionIds.shift());
  }
}

export function villageSafetyVerdict(snapshot = {}, options = {}) {
  if (finite(snapshot.health, 20) < 12) {
    return Object.freeze({ safe: false, reason: 'low_health' });
  }
  if (options.requireGrounded !== false && snapshot.onGround !== true) {
    return Object.freeze({ safe: false, reason: 'not_grounded' });
  }
  if (snapshot.isTouchingWater === true || snapshot.touchingWater === true
      || snapshot.inWater === true || snapshot.submerged === true) {
    return Object.freeze({ safe: false, reason: 'wet' });
  }
  const worldTime = finiteOrNull(snapshot.worldTimeOfDay ?? snapshot.timeOfDay);
  const night = snapshot.isNight === true
    || snapshot.daylightState === 'night'
    || (worldTime !== null && ((worldTime % 24_000) + 24_000) % 24_000 >= 13_000
      && ((worldTime % 24_000) + 24_000) % 24_000 < 23_000);
  if (night) return Object.freeze({ safe: false, reason: 'night_unsafe' });
  const hostileCount = nonNegativeInteger(
    snapshot.nearbyHostileCount ?? snapshot.nearbyThreatCount,
    Array.isArray(snapshot.nearbyHostiles) ? snapshot.nearbyHostiles.length : 0,
  );
  if (hostileCount > 0 || snapshot.opportunityTravelThreatSafe === false) {
    return Object.freeze({ safe: false, reason: 'threat_present' });
  }
  if (snapshot.opportunityTravelSafe === false || snapshot.villageOpportunitySafe === false) {
    return Object.freeze({ safe: false, reason: 'unsafe_now' });
  }
  // Active travel requires an authoritative temporal/safety observation. A
  // missing field is not silently interpreted as daylight.
  const timeKnown = snapshot.isDaytime === true || night || worldTime !== null;
  const threatKnown = Number.isFinite(Number(snapshot.nearbyHostileCount ?? snapshot.nearbyThreatCount))
    || Array.isArray(snapshot.nearbyHostiles)
    || snapshot.opportunityTravelThreatSafe === true;
  if (!timeKnown) return Object.freeze({ safe: false, reason: 'time_unknown' });
  if (!threatKnown) return Object.freeze({ safe: false, reason: 'threat_state_unknown' });
  return Object.freeze({ safe: true, reason: 'authoritative_safe' });
}

export function sanitizeVillageReceiptSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  return {
    ...snapshot,
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
    currentCommandId: '',
    activeNavigationCommandId: '',
  };
}

export function isVillageOpportunityReceiptSnapshot(snapshot = {}) {
  const commandId = observedCommandId(snapshot);
  const receiptCommandId = text(snapshot?.villageOpportunityReceipt?.commandId);
  // The Java receipt store intentionally exposes its latest bounded receipt
  // after the corresponding command has ended. It must not gain authority
  // over a later baseline completion merely because the old completion reason
  // or receipt remains in the snapshot. A village command identity is enough
  // for orphan cleanup; a structured receipt is owned only by the exact
  // currently observed command.
  return isVillageCommandId(commandId)
    || (receiptCommandId.startsWith('mission-village-') && receiptCommandId === commandId);
}

function admitDecision(decision, snapshot, baseline, limits, usedDecisionIds) {
  if (!decision || typeof decision !== 'object') return { ok: false, reason: 'no_completed_decision' };
  const decisionId = text(decision.decisionId);
  if (!decisionId) return { ok: false, reason: 'invalid_decision', decisionId: null };
  if (usedDecisionIds.has(decision.claimId || decisionId)) {
    return { ok: false, reason: 'decision_already_consumed', decisionId };
  }
  if (decision.mode !== 'active') return { ok: false, reason: 'inactive_mode', decisionId };
  if (!MISSION_TOKEN_RE.test(text(decision.missionGoal).toLowerCase())) {
    return { ok: false, reason: 'invalid_mission_scope', decisionId };
  }
  const baselineObjective = text(baseline?.objective ?? baseline?.intent?.missionObjective);
  if (baselineObjective && decision.defaultObjective !== baselineObjective) {
    return { ok: false, reason: 'stale_objective', decisionId };
  }
  if (decision.shouldSwitch !== true || decision.recommendation?.kind !== 'opportunity') {
    return { ok: false, reason: decision.reason || 'benefit_threshold_not_met', decisionId };
  }
  const scope = snapshotScope(snapshot);
  if (!scope.worldId || scope.worldId !== decision.worldId || scope.dimension !== decision.dimension) {
    return { ok: false, reason: 'stale_world_or_dimension', decisionId };
  }
  if (decision.inventoryFingerprint !== inventoryFingerprint(snapshot)) {
    return { ok: false, reason: 'stale_ledger_revision', decisionId };
  }
  const safety = villageSafetyVerdict(snapshot);
  if (!safety.safe) return { ok: false, reason: safety.reason, decisionId };
  const admissionPosition = canonicalAdmissionPosition(snapshot);
  if (!sameCanonicalPosition(admissionPosition, decision.admissionPosition)) {
    return { ok: false, reason: 'stale_admission_position', decisionId };
  }
  const rawSelected = Array.isArray(decision.selectedOpportunities)
    ? decision.selectedOpportunities.slice(0, limits.maxSelectedOpportunities)
    : [];
  const recommendedIds = Array.isArray(decision.recommendation.opportunityIds)
    ? [...decision.recommendation.opportunityIds]
    : [];
  const selectedIds = rawSelected.map((entry) => entry?.id);
  if (rawSelected.length === 0
      || rawSelected.length !== recommendedIds.length
      || [...selectedIds].sort().join('\u0000') !== [...recommendedIds].sort().join('\u0000')) {
    return { ok: false, reason: 'stale_decision', decisionId };
  }
  const opportunities = [];
  for (const selected of rawSelected) {
    if (!VILLAGE_TYPES.has(selected?.type)) return { ok: false, reason: 'unsupported_opportunity_type', decisionId };
    const refreshed = refreshFrozenOpportunity(selected, snapshot);
    if (!refreshed.ok) return { ok: false, reason: refreshed.reason, decisionId };
    opportunities.push(refreshed.value);
  }
  const golemCount = opportunities.filter((entry) => entry.type === 'iron_golem').length;
  if (golemCount > 0 && (golemCount !== 1 || opportunities.length !== 1)) {
    return { ok: false, reason: 'iron_golem_must_be_standalone', decisionId };
  }
  const primary = opportunities[0];
  const current = groundedPosition(snapshot) || normalizedPosition(snapshot);
  if (!current || !compactPosition(primary)) return { ok: false, reason: 'missing_position', decisionId };
  const directDistance = horizontalDistance(current, primary);
  if (directDistance > limits.maxTravelBlocks) return { ok: false, reason: 'travel_budget_infeasible', decisionId };
  return { ok: true, decision, opportunities, primary, directDistance };
}

function initialQueue(selected, snapshot, ledger, limits, options = {}) {
  const queue = [];
  let containersRemaining = limits.maxContainers;
  let breadWorkQueued = false;
  const queuedValueSources = new Set();
  for (let rootIndex = 0; rootIndex < selected.length; rootIndex += 1) {
    const root = selected[rootIndex];
    if (rootIndex > 0) queue.push(task('TRAVEL_EDGE', root));
    const eligible = [root, ...(Array.isArray(root.aggregateMembers) ? root.aggregateMembers : [])]
      .filter((entry) => VILLAGE_TYPES.has(normalizedType(entry)))
      .filter((entry, index, values) => values.findIndex((candidate) => candidate.id === entry.id) === index)
      .sort((left, right) => text(left.id ?? left.stableId).localeCompare(text(right.id ?? right.stableId)));
    for (const entry of eligible.filter((item) => normalizedType(item) === 'container')) {
      if (containersRemaining <= 0 || queuedValueSources.has(entry.id)) continue;
      containersRemaining -= 1;
      // Persisted contents are ranking evidence only. Reopen every selected
      // container once so empty or changed contents replace memory before any
      // inventory mutation is authorized.
      const valueTasks = [task('INSPECT_CONTAINER', entry)];
      enqueueValueSource(queue, root, entry, valueTasks);
      if (valueTasks.length > 0) queuedValueSources.add(entry.id);
    }
    const hay = eligible.find((entry) => normalizedType(entry) === 'hay'
      && !queuedValueSources.has(entry.id));
    const hayNeed = hay && villageBreadQueueReady(snapshot, root, hay, options)
      ? hayBlocksNeeded(snapshot)
      : 0;
    if (hayNeed > 0) {
      if (hay) {
        const source = destinationCraftingTableVerified(root)
          || destinationCraftingTableVerified(hay)
          ? { ...hay, destinationCraftingTableVerified: true }
          : hay;
        const valueTasks = [task(
          'HARVEST_HAY', source, 'minecraft:hay_block', Math.min(hayNeed, count(entryCount(hay))),
        )];
        enqueueValueSource(queue, root, hay, valueTasks);
        queuedValueSources.add(hay.id);
        breadWorkQueued = true;
      }
    } else if (!breadWorkQueued
        && villageBreadQueueReady(snapshot, root, hay, options)) {
      const source = destinationCraftingTableVerified(hay)
          && !destinationCraftingTableVerified(root)
          && !carriedCraftingTableAvailable(snapshot)
        ? hay
        : root;
      const breadTask = breadCraftTask(snapshot, source, limits.maxBreadCrafts);
      if (breadTask) {
        enqueueValueSource(queue, root, source, [breadTask]);
        queuedValueSources.add(source.id);
        breadWorkQueued = true;
      }
    }
    if (totalBeds(snapshot) < 1) {
      const bed = eligible.find((entry) => normalizedType(entry) === 'bed' && !queuedValueSources.has(entry.id));
      if (bed) {
        const valueTasks = [task('COLLECT_BED', bed, normalizedBedItem(bed), 1)];
        enqueueValueSource(queue, root, bed, valueTasks);
        queuedValueSources.add(bed.id);
      }
    }
  }
  return queue;
}

function enqueueValueSource(queue, root, source, valueTasks) {
  if (!Array.isArray(valueTasks) || valueTasks.length === 0) return;
  if (source.id !== root.id) queue.push(task('TRAVEL_EDGE', source));
  queue.push(...valueTasks);
}

function withdrawalTasks(container, snapshot, ledger, limits) {
  if (!container || !(container.contentsKnown === true || container.inspected === true)) return [];
  const items = normalizeCounts(container.items ?? container.contents);
  const tasks = [];
  for (const itemId of POSITIVE_CONTAINER_PRIORITY) {
    const available = items[itemId] || 0;
    if (available <= 0) continue;
    const wanted = positiveContainerNeed(itemId, available, snapshot, ledger);
    if (wanted <= 0) continue;
    tasks.push(task('WITHDRAW_ITEM', container, itemId, wanted));
    if (tasks.length >= limits.maxWithdrawals) break;
  }
  return tasks;
}

function positiveContainerNeed(itemId, available, snapshot, ledger = {}) {
  const exactDeficit = remainingExactDeficit(itemId, snapshot, ledger);
  if (exactDeficit > 0) return Math.min(available, exactDeficit);
  if (itemId === 'minecraft:iron_ingot' || itemId === 'minecraft:raw_iron') {
    return Math.min(available, remainingIronUnitDeficit(snapshot, ledger));
  }
  if (IRON_ARMOR_ITEMS.includes(itemId)) {
    if (inventoryCount(snapshot, itemId) > 0 || exactArmorPieceEquipped(snapshot, itemId)) return 0;
    if (authoritativeItemGain(itemId, snapshot, ledger) > 0) return 0;
    const remaining = Math.max(0,
      count(ledger?.deficit?.['mission:equipped_iron_armor']) - acquiredArmorPieces(snapshot, ledger));
    return remaining > 0 ? Math.min(available, 1) : 0;
  }
  if (POSITIVE_FOOD_ITEMS.includes(itemId)) {
    const nutrition = FOOD_NUTRITION[itemId] || 0;
    const remainingNutrition = foodReserveDeficit(snapshot);
    return nutrition > 0 && remainingNutrition > 0
      ? Math.min(available, Math.ceil(remainingNutrition / nutrition))
      : 0;
  }
  return 0;
}

function exactArmorPieceEquipped(snapshot, itemId) {
  const field = IRON_ARMOR_EQUIPPED_FIELDS[itemId];
  if (!field) return false;
  const raw = snapshot?.[field]
    ?? snapshot?.equipment?.[field]?.itemId
    ?? snapshot?.inventoryEquipment?.[field]?.itemId;
  const equipped = text(raw).toLowerCase();
  return equipped === itemId || (equipped && `minecraft:${equipped}` === itemId);
}

function remainingExactDeficit(itemId, snapshot, ledger) {
  return Math.max(0,
    count(ledger?.deficit?.[itemId]) - authoritativeItemGain(itemId, snapshot, ledger));
}

function authoritativeItemGain(itemId, snapshot, ledger) {
  return Math.max(0,
    inventoryCount(snapshot, itemId) - count(ledger?.owned?.[itemId]));
}

function remainingIronUnitDeficit(snapshot, ledger) {
  let acquired = 0;
  for (const [itemId, value] of Object.entries(IRON_VALUE_BY_ITEM)) {
    acquired += authoritativeItemGain(itemId, snapshot, ledger) * value;
  }
  return Math.max(0, count(ledger?.deficit?.['mission:iron_units']) - acquired);
}

function acquiredArmorPieces(snapshot, ledger) {
  return IRON_ARMOR_ITEMS.reduce(
    (sum, itemId) => sum + Math.min(1, authoritativeItemGain(itemId, snapshot, ledger)),
    0,
  );
}

function inventoryFoodNutrition(snapshot) {
  const published = snapshot?.inventoryNutritionReserve?.carriedNutrition;
  if (Number.isFinite(Number(published)) && Number(published) >= 0) {
    return Math.floor(Number(published));
  }
  return POSITIVE_FOOD_ITEMS.reduce(
    (sum, itemId) => sum + inventoryCount(snapshot, itemId) * FOOD_NUTRITION[itemId],
    0,
  );
}

function foodReserveDeficit(snapshot) {
  const food = Math.max(0, Math.min(20, finite(snapshot.foodLevel, 20)));
  return Math.max(0, FOOD_RESERVE_TARGET - food - inventoryFoodNutrition(snapshot));
}

function craftableBreadCount(snapshot) {
  return inventoryCount(snapshot, 'minecraft:hay_block') * 3
    + Math.floor(inventoryCount(snapshot, 'minecraft:wheat') / 3);
}

function hayBlocksNeeded(snapshot) {
  const missingBread = Math.ceil(foodReserveDeficit(snapshot) / FOOD_NUTRITION['minecraft:bread']);
  return Math.max(0, Math.ceil((missingBread - craftableBreadCount(snapshot)) / 3));
}

function carriedCraftingTableAvailable(snapshot = {}) {
  return inventoryCount(snapshot, 'minecraft:crafting_table') > 0
    || count(snapshot.inventoryCraftingTableCount) > 0;
}

function destinationCraftingTableVerified(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return false;
  if (opportunity.destinationCraftingTableVerified === true) return true;
  return normalizedSignals(opportunity.signals)
    .includes('destination_crafting_table_verified');
}

function villageBreadQueueReady(snapshot, root, hay, options = {}) {
  if (carriedCraftingTableAvailable(snapshot)
      || destinationCraftingTableVerified(root)
      || destinationCraftingTableVerified(hay)) return true;
  return text(options.atSiteOpportunityId) === text(root?.id ?? root?.stableId)
    && snapshot.craftingTableInReach === true;
}

function villageBreadTaskReady(snapshot, taskValue = null) {
  return carriedCraftingTableAvailable(snapshot)
    || snapshot.craftingTableInReach === true
    || destinationCraftingTableVerified(taskValue);
}

function breadCraftTask(snapshot, source = null, maximumCount = VILLAGE_DETOUR_LIMITS.maxBreadCrafts) {
  const countNeeded = Math.ceil(foodReserveDeficit(snapshot) / FOOD_NUTRITION['minecraft:bread']);
  const targetItemCount = Math.min(
    countNeeded,
    count(maximumCount),
    craftableBreadCount(snapshot),
  );
  return targetItemCount > 0
    ? {
      stage: 'CRAFT_BREAD',
      opportunityId: text(source?.opportunityId ?? source?.id ?? source?.stableId)
        || 'village:bread',
      revision: source?.revision ?? null,
      ...compactPosition(source),
      targetItemId: 'minecraft:bread',
      targetItemCount,
      ...(destinationCraftingTableVerified(source)
        ? { destinationCraftingTableVerified: true }
        : {}),
    }
    : null;
}

function task(stage, opportunity, targetItemId = null, targetItemCount = null) {
  return Object.freeze({
    stage,
    opportunityId: text(opportunity.id ?? opportunity.stableId),
    revision: opportunity.revision ?? opportunity.recordRevision ?? opportunity.observedRevision ?? null,
    ...compactPosition(opportunity),
    ...(targetItemId ? { targetItemId } : {}),
    ...(positiveIntegerOrNull(targetItemCount) ? { targetItemCount } : {}),
    ...(destinationCraftingTableVerified(opportunity)
      ? { destinationCraftingTableVerified: true }
      : {}),
  });
}

function taskForStage(stage, primary) {
  if (stage === 'TRAVEL' || stage === 'REVALIDATE' || stage === 'DEFEAT_GOLEM') {
    return task(stage, primary);
  }
  return null;
}

function actionForStage(stage) {
  return {
    TRAVEL: 'village_travel',
    TRAVEL_EDGE: 'village_travel',
    REVALIDATE: 'village_revalidate',
    REVALIDATE_EDGE: 'village_revalidate',
    INSPECT_CONTAINER: 'village_inspect_container',
    WITHDRAW_ITEM: 'village_withdraw_item',
    HARVEST_HAY: 'village_harvest_hay',
    CRAFT_BREAD: 'village_craft_bread',
    COLLECT_BED: 'village_collect_bed',
    DEFEAT_GOLEM: 'village_defeat_iron_golem',
  }[stage] || null;
}

function classifyReceipt(action, reason) {
  const expected = `${action}_complete:opportunity_${SUCCESS_SUFFIX[action]}`;
  if (reason === expected) return { ok: true, neutralTerminal: false };
  const neutralPrefix = `${action}_complete:opportunity_`;
  if (reason.startsWith(neutralPrefix)) {
    const suffix = reason.slice(neutralPrefix.length);
    if (TERMINAL_NEUTRAL_SUFFIXES.has(suffix)) return { ok: true, neutralTerminal: true, reason: suffix };
  }
  if (reason.startsWith(`${action}_failed:`)) {
    return { ok: false, reason: reason.slice(`${action}_failed:`.length) || 'executor_failed' };
  }
  return { ok: false, reason: reason ? 'unexpected_completion_reason' : 'missing_completion_reason' };
}

function verifyReceipt(command, snapshot, tx) {
  const receipt = normalizedStructuredReceipt(snapshot?.villageOpportunityReceipt);
  const correlation = correlateStructuredReceipt(receipt, command, tx);
  if (!correlation.ok) return correlation;
  const expectedResult = SUCCESS_SUFFIX[command.action];
  if (receipt.result !== expectedResult) return { ok: false, reason: 'receipt_result_mismatch' };
  if (command.action === 'village_travel') {
    const current = groundedPosition(snapshot);
    if (!current) return { ok: false, reason: 'arrival_not_grounded' };
    const target = compactPosition(command.task);
    if (!target || horizontalDistance(current, target) > 8) return { ok: false, reason: 'arrival_not_at_village' };
    return { ok: true, receipt };
  }
  if (command.action === 'village_revalidate') {
    // The Java revalidation executor performs the bounded live refresh and
    // publishes VERIFIED only after its exact discovery/target safety checks.
    // Requiring the independently bounded wire catalog to contain the same ID
    // on this receipt poll would reintroduce the ordering race handled above.
    return { ok: true, receipt };
  }
  if (command.action === 'village_inspect_container') {
    return receipt.result === 'inspected' && receipt.knownContainerContents !== null
      ? { ok: true, receipt }
      : { ok: false, reason: 'container_contents_unverified' };
  }
  if (['village_withdraw_item', 'village_harvest_hay', 'village_craft_bread'].includes(command.action)) {
    const itemId = command.task.targetItemId;
    const delta = inventoryCount(snapshot, itemId) - command.stageBaseline.count;
    const receiptDelta = count(receipt.inventoryDelta[itemId]);
    if (receiptDelta !== command.task.targetItemCount) {
      return { ok: false, reason: 'receipt_inventory_delta_mismatch' };
    }
    const consumedEntries = Object.entries(receipt.consumedInventoryDelta);
    const consumptionEligible = POSITIVE_FOOD_ITEMS.includes(itemId)
      && ['village_withdraw_item', 'village_craft_bread'].includes(command.action);
    if (consumedEntries.some(([consumedItemId]) => consumedItemId !== itemId)) {
      return { ok: false, reason: 'receipt_consumed_item_mismatch' };
    }
    const consumedTargetCount = count(receipt.consumedInventoryDelta[itemId]);
    if ((!consumptionEligible && consumedTargetCount > 0)
        || consumedTargetCount > receiptDelta) {
      return { ok: false, reason: 'receipt_consumed_count_invalid' };
    }
    const exactConsumptionShortfall = Math.max(0, receiptDelta - delta);
    if (consumedTargetCount !== exactConsumptionShortfall) {
      return { ok: false, reason: consumedTargetCount > exactConsumptionShortfall
        ? 'receipt_consumed_count_overstated'
        : 'inventory_delta_unverified' };
    }
    if (delta + consumedTargetCount < receiptDelta) {
      return { ok: false, reason: 'inventory_delta_unverified' };
    }
    if (command.action === 'village_withdraw_item'
        && receipt.knownContainerContents === null) {
      return { ok: false, reason: 'container_contents_unverified' };
    }
    return { ok: true, receipt, inventoryDelta: receiptDelta };
  }
  if (command.action === 'village_collect_bed') {
    const delta = totalBeds(snapshot) - command.stageBaseline.count;
    const receiptDelta = Object.entries(receipt.inventoryDelta)
      .filter(([itemId]) => itemId.endsWith('_bed'))
      .reduce((sum, [, value]) => sum + count(value), 0);
    if (delta < 1) return { ok: false, reason: 'inventory_delta_unverified' };
    return receiptDelta === 1
      ? { ok: true, receipt }
      : { ok: false, reason: 'receipt_inventory_delta_mismatch' };
  }
  if (command.action === 'village_defeat_iron_golem') {
    const itemId = 'minecraft:iron_ingot';
    const inventoryDelta = inventoryCount(snapshot, itemId) - command.stageBaseline.count;
    const entries = Object.entries(receipt.inventoryDelta);
    if (entries.length !== 1 || entries[0][0] !== itemId) {
      return { ok: false, reason: 'receipt_inventory_item_mismatch' };
    }
    const receiptDelta = count(entries[0][1]);
    if (receiptDelta < 3 || receiptDelta > 5) {
      return { ok: false, reason: 'receipt_inventory_delta_out_of_bounds' };
    }
    if (Object.keys(receipt.consumedInventoryDelta).length !== 0) {
      return { ok: false, reason: 'receipt_consumed_item_mismatch' };
    }
    if (inventoryDelta !== receiptDelta) {
      return { ok: false, reason: 'inventory_delta_unverified' };
    }
    return { ok: true, receipt, inventoryDelta: receiptDelta };
  }
  return { ok: false, reason: 'unsupported_action' };
}

function verifyNeutralReceipt(command, snapshot, tx, expectedResult) {
  const receipt = normalizedStructuredReceipt(snapshot?.villageOpportunityReceipt);
  const correlation = correlateStructuredReceipt(receipt, command, tx);
  if (!correlation.ok) return correlation;
  return receipt.result === expectedResult
    ? { ok: true, receipt }
    : { ok: false, reason: 'receipt_result_mismatch' };
}

function normalizedStructuredReceipt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const routeReplanCountPresent = raw.routeReplanCount !== undefined
    && raw.routeReplanCount !== null;
  const routeReplanCountValid = !routeReplanCountPresent
    || (Number.isInteger(raw.routeReplanCount)
      && raw.routeReplanCount >= 0
      && raw.routeReplanCount <= 1);
  const knownContainerContents = normalizeExactReceiptContainerItems(
    raw.knownContainerContents,
  );
  const consumedInventoryDeltaPresent = raw.consumedInventoryDelta !== undefined
    && raw.consumedInventoryDelta !== null;
  const normalizedConsumedInventoryDelta = consumedInventoryDeltaPresent
    ? normalizeExactReceiptContainerItems(raw.consumedInventoryDelta)
    : Object.freeze({});
  const consumedInventoryDeltaValid = !consumedInventoryDeltaPresent
    || normalizedConsumedInventoryDelta !== null;
  return Object.freeze({
    commandId: text(raw.commandId),
    action: text(raw.action),
    opportunityId: text(raw.opportunityId),
    opportunityRevision: raw.opportunityRevision == null ? null : nonNegativeInteger(raw.opportunityRevision, -1),
    detourId: text(raw.detourId),
    detourStageSeq: nonNegativeInteger(raw.detourStageSeq ?? raw.stageSeq, -1),
    stage: text(raw.stage).toLowerCase(),
    result: text(raw.result).toLowerCase(),
    receiptId: text(raw.receiptId),
    worldId: text(raw.worldId),
    dimension: text(raw.dimension).toLowerCase(),
    mission: text(raw.mission).toLowerCase(),
    routeReplanCount: routeReplanCountValid && routeReplanCountPresent
      ? raw.routeReplanCount
      : 0,
    routeReplanCountValid,
    knownContainerContents,
    consumedInventoryDelta: normalizedConsumedInventoryDelta || Object.freeze({}),
    consumedInventoryDeltaValid,
    inventoryDelta: normalizeCounts(raw.inventoryDelta),
  });
}

function correlateStructuredReceipt(receipt, command, tx) {
  if (!receipt) return { ok: false, reason: 'structured_receipt_missing' };
  if (receipt.routeReplanCountValid !== true) {
    return { ok: false, reason: 'receipt_route_replan_count_invalid' };
  }
  if (receipt.consumedInventoryDeltaValid !== true) {
    return { ok: false, reason: 'receipt_consumed_inventory_delta_invalid' };
  }
  if (receipt.commandId !== command.commandId) return { ok: false, reason: 'receipt_command_mismatch' };
  if (receipt.action !== command.action) return { ok: false, reason: 'receipt_action_mismatch' };
  if (receipt.opportunityId !== command.task.opportunityId) return { ok: false, reason: 'receipt_opportunity_mismatch' };
  if (receipt.detourId !== tx.detourId) return { ok: false, reason: 'receipt_detour_mismatch' };
  if (receipt.detourStageSeq !== tx.stageSeq) {
    return { ok: false, reason: 'receipt_stage_sequence_mismatch' };
  }
  if (receipt.stage !== tx.stage.toLowerCase()) return { ok: false, reason: 'receipt_stage_mismatch' };
  if (receipt.worldId !== tx.worldId) return { ok: false, reason: 'receipt_world_mismatch' };
  if (receipt.dimension !== tx.dimension) return { ok: false, reason: 'receipt_dimension_mismatch' };
  if (receipt.mission !== tx.mission) return { ok: false, reason: 'receipt_mission_mismatch' };
  if (receipt.opportunityRevision !== command.task.revision) {
    return { ok: false, reason: 'receipt_revision_mismatch' };
  }
  if (!receipt.receiptId) return { ok: false, reason: 'receipt_id_missing' };
  return { ok: true };
}

function observePhysicalRouteReplans(tx, receipt) {
  if (!tx || !receipt || receipt.routeReplanCountValid !== true) return;
  tx.routeReplanCount = Math.max(tx.routeReplanCount, receipt.routeReplanCount);
}

function stageInventoryBaseline(action, task, snapshot) {
  if (action === 'village_collect_bed') {
    return { count: totalBeds(snapshot), foodLevel: finite(snapshot.foodLevel, 20) };
  }
  if (action === 'village_defeat_iron_golem') {
    return {
      count: inventoryCount(snapshot, 'minecraft:iron_ingot'),
      foodLevel: finite(snapshot.foodLevel, 20),
    };
  }
  return {
    count: task?.targetItemId ? inventoryCount(snapshot, task.targetItemId) : 0,
    foodLevel: finite(snapshot.foodLevel, 20),
  };
}

function refreshTaskForSnapshot(taskValue, snapshot, ledger) {
  if (taskValue.stage === 'WITHDRAW_ITEM') {
    const wanted = positiveContainerNeed(
      taskValue.targetItemId,
      positiveIntegerOrNull(taskValue.targetItemCount) || 0,
      snapshot,
      ledger,
    );
    return wanted > 0
      ? Object.freeze({ ...taskValue, targetItemCount: wanted })
      : null;
  }
  if (taskValue.stage === 'HARVEST_HAY') {
    if (!villageBreadTaskReady(snapshot, taskValue)) return null;
    const live = findDiscovery(snapshot, taskValue.opportunityId);
    const requested = positiveIntegerOrNull(taskValue.targetItemCount) || 0;
    const required = hayBlocksNeeded(snapshot);
    const available = live ? count(entryCount(live)) : 0;
    const targetItemCount = Math.min(requested, required, available);
    return targetItemCount > 0
      ? Object.freeze({ ...taskValue, targetItemCount })
      : null;
  }
  if (taskValue.stage === 'CRAFT_BREAD') {
    if (!villageBreadTaskReady(snapshot, taskValue)) return null;
    const refreshed = breadCraftTask(snapshot, taskValue, taskValue.targetItemCount);
    return refreshed
      ? Object.freeze({ ...taskValue, targetItemCount: refreshed.targetItemCount })
      : null;
  }
  if (taskValue.stage === 'COLLECT_BED') return totalBeds(snapshot) < 1 ? taskValue : null;
  if (taskValue.stage === 'DEFEAT_GOLEM') return taskValue;
  return taskValue;
}

function isRefreshableValueStage(stage) {
  return ['WITHDRAW_ITEM', 'HARVEST_HAY', 'CRAFT_BREAD', 'COLLECT_BED', 'DEFEAT_GOLEM'].includes(stage);
}

function activeMutatingOpportunity(tx) {
  const command = tx?.command;
  if (!command || !MUTATING_VALUE_ACTIONS.has(command.action)) return null;
  if (actionForStage(tx.stage) !== command.action) return null;
  const opportunityId = text(command.task?.opportunityId);
  if (!opportunityId || command.intent?.opportunityId !== opportunityId) return null;
  if (command.intent?.commandId !== command.commandId) return null;
  if (command.intent?.detourId !== tx.detourId
      || command.intent?.detourStageSeq !== tx.stageSeq) return null;
  const owner = owningAggregateRoot(tx.selected, opportunityId);
  return Object.freeze({
    opportunityId,
    action: command.action,
    ownerRootId: owner?.id || null,
    member: owner?.aggregateMembers?.find((entry) => entry.id === opportunityId) || null,
  });
}

function transactionInvariantVerdict(tx, snapshot) {
  const scope = snapshotScope(snapshot);
  if (!scope.worldId || scope.worldId !== tx.worldId) return { ok: false, reason: 'world_changed' };
  if (scope.dimension !== tx.dimension) return { ok: false, reason: 'dimension_changed' };
  if (snapshot.dead === true || finite(snapshot.health, 20) <= 0) return { ok: false, reason: 'player_dead' };
  if (finite(snapshot.health, 20) + 0.001 < tx.healthBaseline
      && !exactActiveGolemSafetyLease(tx)) {
    return { ok: false, reason: 'health_loss' };
  }
  return { ok: true };
}

function exactActiveGolemSafetyLease(tx) {
  const command = tx?.command;
  return tx?.stage === 'DEFEAT_GOLEM'
    && command?.action === 'village_defeat_iron_golem'
    && actionForStage(tx.stage) === command.action
    && command.intent?.commandId === command.commandId
    && command.intent?.opportunityId === command.task?.opportunityId
    && command.intent?.opportunityRevision === command.task?.revision
    && command.intent?.detourId === tx.detourId
    && command.intent?.detourStageSeq === tx.stageSeq;
}

function lifecycleVerdict(tx, snapshot, activeMutation = null, options = {}) {
  const invariant = transactionInvariantVerdict(tx, snapshot);
  if (!invariant.ok) return invariant;
  const rootRebases = [];
  for (const root of Array.isArray(tx.selected) ? tx.selected : []) {
    if (root.id !== activeMutation?.opportunityId && !tx.selfModifiedOpportunityIds.has(root.id)) {
      const verifiedMutationOwnerOmission = options.allowVerifiedMutationOwnerOmission === true
        && activeMutation?.ownerRootId === root.id
        && RECEIPT_FIRST_CATALOG_MUTATION_ACTIONS.has(activeMutation.action)
        && tx.exactlyRevalidatedOpportunityIds.has(root.id)
        && snapshot.opportunityDiscoveriesTruncated === true;
      const persistedWireOmission = tx.wireOmissibleRootIds.has(root.id)
        && snapshot.opportunityDiscoveriesTruncated === true;
      const activeExpected = activeMutation?.action === 'village_collect_bed'
        && activeMutation.ownerRootId === root.id
        ? activeMutation.member
        : null;
      const pending = tx.pendingRootMutations.get(root.id);
      const expectedMember = activeExpected
        || root.aggregateMembers?.find((entry) => entry.id === pending?.memberId)
        || null;
      let liveRoot = findDiscovery(snapshot, root.id);
      const boundedCatalogOmission = !liveRoot
        && snapshot.opportunityDiscoveriesTruncated === true;
      const verifiedAbsentRoot = !liveRoot
        && (verifiedMutationOwnerOmission || persistedWireOmission || boundedCatalogOmission);
      if (liveRoot && expectedMember && isDisappearedDiscovery(liveRoot)) {
        // The scanner publishes one bounded tombstone for the old minimum
        // marker in the same observation that introduces the re-keyed village
        // root. For an exact in-flight or verified bed-root mutation only,
        // treat that tombstone as absence and require the unique successor
        // proof below. Unrelated disappeared roots remain fail-closed.
        liveRoot = null;
      }
      let rebaseQueued = false;
      if (verifiedAbsentRoot) {
        // Absence in a declared-truncated wire catalog is not contradictory
        // evidence. A complete-list omission, tombstone, unsafe record, or
        // semantic change follows the ordinary fail-closed path below.
      } else if (!liveRoot && expectedMember) {
        liveRoot = findExpectedRekeyedVillageRoot(tx, snapshot, root, expectedMember);
        if (!liveRoot && activeExpected) {
          // If the collected bed was the cluster's minimum marker, the scanner
          // can remove/re-key the owning root before pickup reaches inventory.
          // The exact active bed command remains Java-owned through its
          // receipt; without one unique provable successor, no root authority
          // is carried into another stage.
          liveRoot = null;
        } else if (!liveRoot) {
          return { ok: false, reason: 'opportunity_vanished' };
        }
        if (!liveRoot) {
          // Continue with sibling validation below while skipping only this
          // unresolved owning-root record for the active command.
        } else if (!activeExpected && pending) {
          rootRebases.push({ rootId: root.id, live: liveRoot });
          rebaseQueued = true;
        }
      } else if (!liveRoot) {
        return { ok: false, reason: 'opportunity_vanished' };
      }
      const rootSafety = liveRoot ? liveDiscoverySafety(liveRoot) : { ok: true };
      if (!rootSafety.ok) return rootSafety;
      if (liveRoot && !sameOpportunity(root, liveRoot)) {
        const rekeyed = liveRoot.id !== root.id;
        if (!expectedMember || !sameExpectedVillageRootAfterBedMutation(
          root, liveRoot, expectedMember, { allowRekey: rekeyed },
        )) {
          return { ok: false, reason: 'opportunity_changed' };
        }
        // Pre-receipt changes are tolerated but never persisted. A pending
        // root mutation exists only after a verified bed receipt, so it may be
        // atomically rebased once the scanner observes the expected delta.
        if (!activeExpected && pending && !rebaseQueued) {
          rootRebases.push({ rootId: root.id, live: liveRoot });
        }
      }
    }
    for (const member of Array.isArray(root.aggregateMembers) ? root.aggregateMembers : []) {
      if (member.id === activeMutation?.opportunityId
          || tx.selfModifiedOpportunityIds.has(member.id)) continue;
      const liveMember = findDiscovery(snapshot, member.id);
      if (!liveMember) {
        // The wire catalog intentionally carries only a bounded subset of the
        // scanner result. Absence while that catalog declares truncation is
        // unknown, not evidence that a previously verified block disappeared.
        // The exact village executor still revalidates each frozen target
        // before interaction. A complete-list omission remains terminal.
        if (snapshot.opportunityDiscoveriesTruncated === true) continue;
        return { ok: false, reason: 'aggregate_member_vanished' };
      }
      if (!sameOpportunity(member, liveMember)) {
        return { ok: false, reason: 'aggregate_member_changed' };
      }
      if (!villageAggregateMemberInRange(root, liveMember)) {
        return { ok: false, reason: 'aggregate_member_out_of_range' };
      }
      const memberSafety = aggregateMemberLifecycleSafety(member, liveMember, root);
      if (!memberSafety.ok) return memberSafety;
    }
  }
  return { ok: true, rootRebases };
}

function isExactCatalogBoundaryReceipt(tx, snapshot) {
  if (!tx?.command || !RECEIPT_FIRST_CATALOG_BOUNDARY_STAGES.has(tx.stage)
      || snapshot?.currentCommandCompleted !== true
      || observedCommandId(snapshot) !== tx.command.commandId) return false;
  const classified = classifyReceipt(
    tx.command.action,
    text(snapshot.currentCommandCompletionReason),
  );
  if (!classified.ok) return false;
  const receipt = normalizedStructuredReceipt(snapshot?.villageOpportunityReceipt);
  if (!correlateStructuredReceipt(receipt, tx.command, tx).ok) return false;
  return classified.neutralTerminal
    ? receipt.result === classified.reason
    : receipt.result === SUCCESS_SUFFIX[tx.command.action];
}

function isExactLocalNeutralReceipt(tx, snapshot) {
  if (!tx?.command || !LOCAL_VALUE_ACTIONS.has(tx.command.action)
      || snapshot?.currentCommandCompleted !== true
      || observedCommandId(snapshot) !== tx.command.commandId) return false;
  const classified = classifyReceipt(
    tx.command.action,
    text(snapshot.currentCommandCompletionReason),
  );
  if (!classified.ok || classified.neutralTerminal !== true) return false;
  return verifyNeutralReceipt(tx.command, snapshot, tx, classified.reason).ok;
}

function verifiedCatalogMutationReceipt(tx, snapshot) {
  if (!tx?.command || !RECEIPT_FIRST_CATALOG_MUTATION_ACTIONS.has(tx.command.action)
      || snapshot?.currentCommandCompleted !== true
      || observedCommandId(snapshot) !== tx.command.commandId) return null;
  const classified = classifyReceipt(
    tx.command.action,
    text(snapshot.currentCommandCompletionReason),
  );
  if (!classified.ok) return null;
  const verified = classified.neutralTerminal
    ? verifyNeutralReceipt(tx.command, snapshot, tx, classified.reason)
    : verifyReceipt(tx.command, snapshot, tx);
  return verified.ok ? classified : null;
}

function owningAggregateRoot(selected, opportunityId) {
  return (Array.isArray(selected) ? selected : []).find((root) => (
    Array.isArray(root?.aggregateMembers)
      && root.aggregateMembers.some((member) => member?.id === opportunityId)
  )) || null;
}

function sameExpectedVillageRootAfterBedMutation(frozen, live, bedMember, options = {}) {
  if (frozen?.type !== 'village' || normalizedType(live) !== 'village') return false;
  if (options.allowRekey !== true && text(live?.id ?? live?.stableId) !== frozen.id) return false;
  if (text(live?.status).toLowerCase() !== text(frozen?.status).toLowerCase()) return false;
  const frozenPosition = compactPosition(frozen);
  const livePosition = compactPosition(live);
  if (!frozenPosition || !livePosition) return false;
  if (options.allowRekey !== true && (
    frozenPosition.x !== livePosition.x
      || frozenPosition.y !== livePosition.y
      || frozenPosition.z !== livePosition.z
  )) return false;

  const frozenCount = count(entryCount(frozen));
  const liveCount = count(entryCount(live));
  const maximumMarkerDelta = Math.min(2, Math.max(1, count(entryCount(bedMember))));
  const markerDelta = frozenCount - liveCount;
  if (markerDelta < 1 || markerDelta > maximumMarkerDelta) return false;

  const frozenSignals = normalizedSignals(frozen.signals);
  const liveSignals = normalizedSignals(live.signals);
  const frozenMarkerCount = markerCountSignal(frozenSignals);
  const liveMarkerCount = markerCountSignal(liveSignals);
  if (frozenMarkerCount !== null && frozenMarkerCount !== frozenCount) return false;
  if (liveMarkerCount !== null && liveMarkerCount !== liveCount) return false;
  const frozenLabels = frozenSignals.filter((value) => !value.startsWith('marker_count:'));
  const liveLabels = liveSignals.filter((value) => !value.startsWith('marker_count:'));
  const withoutBed = frozenLabels.filter((value) => value !== 'bed');
  return sameStringList(liveLabels, frozenLabels) || sameStringList(liveLabels, withoutBed);
}

function findExpectedRekeyedVillageRoot(tx, snapshot, frozenRoot, bedMember) {
  const oldPosition = compactPosition(frozenRoot);
  const bedPosition = compactPosition(bedMember);
  if (!oldPosition || !bedPosition
      || oldPosition.x !== bedPosition.x
      || oldPosition.y !== bedPosition.y
      || oldPosition.z !== bedPosition.z) return null;
  const selectedRootIds = new Set((Array.isArray(tx.selected) ? tx.selected : []).map((entry) => entry.id));
  const candidates = (Array.isArray(snapshot?.opportunityDiscoveries)
    ? snapshot.opportunityDiscoveries
    : [])
    .filter((entry) => normalizedType(entry) === 'village')
    .filter((entry) => !selectedRootIds.has(text(entry?.id ?? entry?.stableId)))
    .filter((entry) => {
      const position = compactPosition(entry);
      return position
        && horizontalDistance(oldPosition, position)
          <= VILLAGE_AGGREGATE_MEMBER_LIMITS.maxHorizontalBlocks
        && Math.abs(position.y - oldPosition.y)
          <= VILLAGE_AGGREGATE_MEMBER_LIMITS.maxVerticalBlocks
        && compareScannerAnchor(position, oldPosition) > 0
        && liveDiscoverySafety(entry).ok
        && sameExpectedVillageRootAfterBedMutation(
          frozenRoot, entry, bedMember, { allowRekey: true },
        );
    });
  return candidates.length === 1 ? candidates[0] : null;
}

function compareScannerAnchor(left, right) {
  if (left.y !== right.y) return left.y - right.y;
  if (left.z !== right.z) return left.z - right.z;
  return left.x - right.x;
}

function markerCountSignal(signals) {
  const marker = signals.find((value) => value.startsWith('marker_count:'));
  if (!marker) return null;
  const value = Number(marker.slice('marker_count:'.length));
  return Number.isInteger(value) && value >= 0 ? value : Number.NaN;
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function commitVerifiedOwningRootMutation(tx, command, snapshot) {
  const root = owningAggregateRoot(tx.selected, command.task?.opportunityId);
  const member = root?.aggregateMembers?.find((entry) => entry.id === command.task?.opportunityId);
  if (!root || !member) return;
  if (command.action === 'village_harvest_hay') {
    // A later truncated scanner/catalog may legitimately omit or re-key the
    // aggregate after its exact hay member disappears, even when the receipt
    // poll still contained the old root. Arm only an absence allowance backed
    // by the root's earlier Java revalidation. Using it remains conditional on
    // each later wire snapshot declaring truncation; a complete-list omission,
    // tombstone, or changed semantics still fails.
    if (tx.exactlyRevalidatedOpportunityIds.has(root.id)) {
      tx.wireOmissibleRootIds.add(root.id);
    }
    return;
  }
  if (command.action !== 'village_collect_bed') return;
  const observedRoot = findDiscovery(snapshot, root.id);
  const live = (observedRoot && !isDisappearedDiscovery(observedRoot) ? observedRoot : null)
    || findExpectedRekeyedVillageRoot(tx, snapshot, root, member);
  if (!live) {
    tx.forceCompleteAfterVerifiedMutation = true;
    tx.pendingRootMutations.delete(root.id);
    return;
  }
  if (sameOpportunity(root, live)) {
    tx.pendingRootMutations.set(root.id, Object.freeze({ memberId: member.id }));
    return;
  }
  if (sameExpectedVillageRootAfterBedMutation(root, live, member, {
    allowRekey: text(live?.id ?? live?.stableId) !== root.id,
  })) {
    rebaseSelectedRoot(tx, root.id, live);
    tx.pendingRootMutations.delete(root.id);
  }
}

function isDisappearedDiscovery(raw) {
  return text(raw?.status).toLowerCase() === 'disappeared';
}

function rebaseSelectedRoot(tx, rootId, live) {
  const current = (Array.isArray(tx.selected) ? tx.selected : []).find((root) => root.id === rootId);
  if (!current) return false;
  const position = compactPosition(live);
  if (!position) return false;
  const rebased = Object.freeze({
    ...current,
    ...position,
    id: text(live.id ?? live.stableId),
    type: normalizedType(live),
    observedRevision: live.revision ?? live.recordRevision ?? current.observedRevision,
    semanticRevision: villageOpportunitySemanticFingerprint(live),
    status: text(live.status).toLowerCase() || current.status,
    count: count(entryCount(live)),
    signals: Object.freeze(normalizedSignals(live.signals)),
    raw: live,
  });
  tx.selected = tx.selected.map((root) => root.id === rootId ? rebased : root);
  if (tx.primary?.id === rootId) tx.primary = rebased;
  return true;
}

function refreshFrozenOpportunity(selected, snapshot) {
  const live = findDiscovery(snapshot, selected.id);
  const boundedCatalogOmission = !live && snapshot.opportunityDiscoveriesTruncated === true;
  if (selected?.type === 'iron_golem' && !live) {
    return { ok: false, reason: 'opportunity_vanished' };
  }
  if (!live && !boundedCatalogOmission) return { ok: false, reason: 'opportunity_vanished' };
  if (live && !sameOpportunity(selected, live)) {
    return { ok: false, reason: 'stale_opportunity_revision' };
  }
  if (live) {
    const liveAdmission = liveDiscoverySafety(live);
    if (!liveAdmission.ok) return liveAdmission;
  }
  const effectiveRoot = live || selected;

  const members = [];
  const memberIds = new Set();
  for (const frozen of Array.isArray(selected.aggregateMembers) ? selected.aggregateMembers : []) {
    if (!frozen?.id || memberIds.has(frozen.id)
        || !['container', 'hay', 'bed'].includes(normalizedType(frozen))) {
      return { ok: false, reason: 'invalid_aggregate_member' };
    }
    memberIds.add(frozen.id);
    const memberLive = findDiscovery(snapshot, frozen.id);
    const boundedMemberOmission = !memberLive
      && snapshot.opportunityDiscoveriesTruncated === true;
    if (!memberLive && !boundedMemberOmission) {
      return { ok: false, reason: 'aggregate_member_vanished' };
    }
    if (memberLive && !sameOpportunity(frozen, memberLive)) {
      return { ok: false, reason: 'aggregate_member_changed' };
    }
    if (memberLive) {
      const memberSafety = aggregateMemberLifecycleSafety(frozen, memberLive, selected);
      if (!memberSafety.ok) return { ok: false, reason: `aggregate_member_${memberSafety.reason}` };
    }
    const effectiveMember = memberLive || frozen;
    const rootPosition = compactPosition(effectiveRoot);
    const memberPosition = compactPosition(effectiveMember);
    if (!villageAggregateMemberInRange(rootPosition, memberPosition)) {
      return { ok: false, reason: 'aggregate_member_out_of_range' };
    }
    members.push(Object.freeze({
      ...frozen,
      ...memberPosition,
      aggregateMembers: Object.freeze([]),
      aggregateMember: true,
      raw: effectiveMember,
    }));
  }
  return {
    ok: true,
    value: Object.freeze({
      ...selected,
      ...compactPosition(effectiveRoot),
      aggregateMembers: Object.freeze(members),
      aggregateMember: false,
      raw: effectiveRoot,
    }),
  };
}

function liveDiscoverySafety(raw) {
  const status = text(raw?.status).toLowerCase();
  if (status === 'invalidated' || status === 'disappeared' || status === 'collected') {
    return { ok: false, reason: 'opportunity_invalidated' };
  }
  const signals = normalizedSignals(raw?.signals);
  if (raw?.safe === false || signals.some((value) => (
    value === 'unsafe' || value === 'hazard' || value === 'hostile'
      || value === 'night_hostiles' || value === 'lava_adjacent' || value.startsWith('unsafe:')
  ))) return { ok: false, reason: 'opportunity_unsafe' };
  if (!signals.includes('access_proven') && !signals.includes('route_reachable')) {
    return { ok: false, reason: 'access_unproven' };
  }
  if (!signals.includes('hazard_free')) return { ok: false, reason: 'hazard_clearance_unproven' };
  if (normalizedType(raw) === 'iron_golem') {
    if (!signals.includes('defense_ready')) return { ok: false, reason: 'defense_unready' };
    if (text(raw?.readinessSource).toLowerCase() !== CODE_OWNED_READINESS_SOURCE
        || raw?.executorReady !== true
        || text(raw?.capabilityId).toLowerCase() !== IRON_GOLEM_EXECUTOR.capabilityId
        || text(raw?.executorId).toLowerCase() !== IRON_GOLEM_EXECUTOR.executorId) {
      return { ok: false, reason: 'executor_unready' };
    }
  }
  return { ok: true };
}

function villageAggregateMemberInRange(root, member) {
  const rootPosition = compactPosition(root);
  const memberPosition = compactPosition(member);
  return rootPosition != null
    && memberPosition != null
    && horizontalDistance(rootPosition, memberPosition)
      <= VILLAGE_AGGREGATE_MEMBER_LIMITS.maxHorizontalBlocks
    && Math.abs(rootPosition.y - memberPosition.y)
      <= VILLAGE_AGGREGATE_MEMBER_LIMITS.maxVerticalBlocks;
}

function aggregateMemberLifecycleSafety(frozen, live, root) {
  const ordinary = liveDiscoverySafety(live);
  if (frozen?.remoteAccessDeferred !== true) return ordinary;
  if (!ordinary.ok && ordinary.reason !== 'access_unproven') return ordinary;
  if (root?.accessProof !== 'route_reachable'
      || root?.safe !== true
      || root?.ready !== true
      || root?.feasible !== true) {
    return { ok: false, reason: 'deferred_access_invalid' };
  }
  const type = normalizedType(live);
  const expected = REMOTE_AGGREGATE_EXECUTORS[type];
  if (!expected) return ordinary;
  const signals = normalizedSignals(live?.signals);
  if (!signals.includes('hazard_free')) return { ok: false, reason: 'hazard_clearance_unproven' };
  if (live?.safe === false || signals.some((value) => (
    value === 'unsafe' || value === 'hazard' || value === 'hostile'
      || value === 'night_hostiles' || value === 'lava_adjacent'
      || value.startsWith('unsafe:') || value.startsWith('hazard:')
  ))) return { ok: false, reason: 'opportunity_unsafe' };
  if (text(live?.readinessSource).toLowerCase() !== CODE_OWNED_READINESS_SOURCE
      || live?.executorReady !== true
      || text(live?.capabilityId).toLowerCase() !== expected.capabilityId
      || text(live?.executorId).toLowerCase() !== expected.executorId) {
    return { ok: false, reason: 'executor_unready' };
  }
  return { ok: true, deferredAccess: true };
}

function sameOpportunity(selected, live) {
  return villageOpportunityPhysicalFingerprint(selected)
    === villageOpportunityPhysicalFingerprint(live);
}

// Memory-backed container contents are planning evidence, not a physical
// scanner property. A live Fabric observation cannot reproduce those fields,
// so lifecycle identity deliberately compares only physical discovery state.
// Exact contents remain authoritative through fresh inspection receipts and
// revision-correlated memory updates.
export function villageOpportunityPhysicalFingerprint(raw) {
  return shortHash(stableStringify({
    id: text(raw?.id ?? raw?.stableId),
    type: normalizedType(raw),
    status: physicalIdentityStatus(raw?.status),
    position: compactPosition(raw),
    count: count(entryCount(raw)),
    signals: physicalIdentitySignals(raw?.signals),
    safe: raw?.safe !== false,
    readiness: physicalReadinessIdentity(raw),
  }));
}

function physicalIdentitySignals(raw) {
  return normalizedSignals(raw).filter((signal) => (
    signal !== 'access_proven' && signal !== 'route_reachable'
  ));
}

function physicalIdentityStatus(raw) {
  const status = text(raw).toLowerCase() || 'observed';
  return status === 'observed' || status === 'verified' ? 'live' : status;
}

function physicalReadinessIdentity(raw) {
  const source = text(raw?.readinessSource ?? raw?.executorReadinessSource).toLowerCase();
  return Object.freeze({
    source,
    capabilityId: text(raw?.capabilityId).toLowerCase(),
    executorId: text(raw?.executorId).toLowerCase(),
    ready: source
      ? raw?.executorReady === true
      : raw?.executorReady === true || raw?.ready === true,
  });
}

export function villageOpportunitySemanticFingerprint(raw) {
  return shortHash(stableStringify({
    id: text(raw?.id ?? raw?.stableId),
    type: normalizedType(raw),
    status: text(raw?.status).toLowerCase() || 'observed',
    position: compactPosition(raw),
    count: count(entryCount(raw)),
    signals: normalizedSignals(raw?.signals),
    contentsKnown: raw?.contentsKnown === true || raw?.inspected === true,
    items: normalizeCounts(raw?.items ?? raw?.contents),
    safe: raw?.safe !== false,
    ready: raw?.executorReady === true || raw?.ready === true,
    feasible: raw?.feasible === true || raw?.safe !== false,
  }));
}

function normalizedType(raw) {
  const value = text(raw?.type ?? raw?.kind).toLowerCase();
  return value === 'village_marker_cluster' || value === 'village_cluster' ? 'village'
    : value === 'hay_bale' || value === 'hay_bales' ? 'hay'
      : value;
}

function findDiscovery(snapshot, id) {
  return (Array.isArray(snapshot?.opportunityDiscoveries) ? snapshot.opportunityDiscoveries : [])
    .find((entry) => text(entry?.id ?? entry?.stableId) === id) || null;
}

function snapshotScope(snapshot) {
  const identity = snapshot?.worldIdentity && typeof snapshot.worldIdentity === 'object'
    ? snapshot.worldIdentity
    : {};
  return {
    worldId: text(
      (typeof snapshot?.worldIdentity === 'string' ? snapshot.worldIdentity : null)
        ?? identity.id ?? identity.worldId ?? snapshot?.worldIdentityId ?? snapshot?.worldId,
    ),
    dimension: text(
      identity.dimension ?? snapshot?.dimensionIdentity ?? snapshot?.dimension ?? snapshot?.worldDimension,
    ).toLowerCase() || 'overworld',
  };
}

function inventoryFingerprint(snapshot) {
  return shortHash(stableStringify({
    items: normalizeCounts(snapshot?.inventoryItemCounts ?? snapshot?.inventory?.itemCounts),
    equipment: snapshot?.inventoryEquipment ?? snapshot?.equipment ?? {},
    foodLevel: finite(snapshot?.foodLevel, 20),
    health: finite(snapshot?.health, 20),
  }));
}

export function villageOpportunityInventoryFingerprint(snapshot) {
  return inventoryFingerprint(snapshot);
}

export function villageOpportunityFoodTelemetry(snapshot = {}) {
  const foodLevel = Math.max(0, Math.min(20, finite(snapshot.foodLevel, 20)));
  const health = Math.max(0, finite(snapshot.health, 20));
  const breadCount = inventoryCount(snapshot, 'minecraft:bread');
  const foodItemCount = POSITIVE_FOOD_ITEMS.reduce(
    (sum, itemId) => sum + inventoryCount(snapshot, itemId),
    0,
  );
  return Object.freeze({
    health,
    foodLevel,
    foodDeficit: Math.max(0, 20 - foodLevel),
    missionFoodDeficit: Math.max(0, 7 - foodLevel),
    breadCount,
    foodItemCount,
    hasFood: snapshot.hasFood === true || foodItemCount > 0,
  });
}

function inventoryCount(snapshot, itemId) {
  return normalizeCounts(snapshot?.inventoryItemCounts ?? snapshot?.inventory?.itemCounts)[itemId] || 0;
}

function totalBeds(snapshot) {
  const counts = normalizeCounts(snapshot?.inventoryItemCounts ?? snapshot?.inventory?.itemCounts);
  return Object.entries(counts)
    .filter(([itemId]) => itemId.endsWith('_bed'))
    .reduce((sum, [, value]) => sum + value, 0);
}

function normalizedBedItem(raw) {
  const block = text(raw?.blockId ?? raw?.itemId);
  return ITEM_ID_RE.test(block) && block.endsWith('_bed') ? block : 'minecraft:white_bed';
}

function normalizedSignals(raw) {
  if (Array.isArray(raw)) return raw.map((value) => text(value).toLowerCase()).filter(Boolean).sort();
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).filter(([, value]) => value === true || Number(value) > 0)
      .map(([key]) => text(key).toLowerCase()).filter(Boolean).sort();
  }
  return text(raw).toLowerCase().split(/[\s,;|]+/).filter(Boolean).sort();
}

function normalizeCounts(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const key of Object.keys(raw).sort()) {
    const itemId = text(key).toLowerCase();
    const value = nonNegativeInteger(raw[key], 0);
    if (ITEM_ID_RE.test(itemId) && value > 0) result[itemId] = value;
  }
  return result;
}

function normalizeExactReceiptContainerItems(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.length > EXACT_CONTAINER_ITEM_LIMIT) return null;
  const result = {};
  for (const itemId of keys) {
    if (!EXACT_CONTAINER_ITEM_ID_RE.test(itemId)) return null;
    const value = raw[itemId];
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    result[itemId] = value;
  }
  return Object.freeze(result);
}

function entryCount(raw) {
  return raw?.count ?? raw?.blockCount ?? raw?.memberCount;
}

function normalizedPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw.position && typeof raw.position === 'object' ? raw.position
    : raw.anchor && typeof raw.anchor === 'object' ? raw.anchor
      : raw;
  const x = finiteOrNull(source.x ?? source.targetX);
  const y = finiteOrNull(source.y ?? source.targetY);
  const z = finiteOrNull(source.z ?? source.targetZ);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function groundedPosition(snapshot) {
  if (snapshot?.onGround !== true && snapshot?.grounded !== true) return null;
  if (snapshot?.touchingWater === true || snapshot?.submergedInWater === true) return null;
  return normalizedPosition(snapshot?.position ?? snapshot);
}

function canonicalAdmissionPosition(snapshot) {
  const value = groundedPosition(snapshot);
  return value ? {
    x: Math.floor(value.x),
    y: Math.floor(value.y),
    z: Math.floor(value.z),
  } : null;
}

function sameCanonicalPosition(left, right) {
  return left !== null && right !== null
    && Number.isInteger(right.x)
    && Number.isInteger(right.y)
    && Number.isInteger(right.z)
    && left.x === right.x
    && left.y === right.y
    && left.z === right.z;
}

function compactPosition(raw) {
  const value = normalizedPosition(raw);
  return value ? { x: value.x, y: value.y, z: value.z } : null;
}

function horizontalDistance(left, right) {
  const a = compactPosition(left);
  const b = compactPosition(right);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function observedCommandId(snapshot) {
  return text(snapshot?.currentCommandId ?? snapshot?.activeNavigationCommandId);
}

function isVillageCommandId(commandId) {
  return text(commandId).startsWith('mission-village-');
}

function normalizeLimits(raw = {}) {
  return {
    hardDeadlineMs: bounded(raw.hardDeadlineMs, VILLAGE_DETOUR_LIMITS.hardDeadlineMs, 1, VILLAGE_DETOUR_LIMITS.hardDeadlineMs),
    maxTravelBlocks: bounded(raw.maxTravelBlocks, VILLAGE_DETOUR_LIMITS.maxTravelBlocks, 1, VILLAGE_DETOUR_LIMITS.maxTravelBlocks),
    maxFailures: bounded(raw.maxFailures, VILLAGE_DETOUR_LIMITS.maxFailures, 1, VILLAGE_DETOUR_LIMITS.maxFailures),
    maxRouteReplans: bounded(raw.maxRouteReplans, VILLAGE_DETOUR_LIMITS.maxRouteReplans, 0, VILLAGE_DETOUR_LIMITS.maxRouteReplans),
    maxContainers: bounded(raw.maxContainers, VILLAGE_DETOUR_LIMITS.maxContainers, 0, VILLAGE_DETOUR_LIMITS.maxContainers),
    maxWithdrawals: bounded(raw.maxWithdrawals, VILLAGE_DETOUR_LIMITS.maxWithdrawals, 0, VILLAGE_DETOUR_LIMITS.maxWithdrawals),
    maxBreadCrafts: bounded(raw.maxBreadCrafts, VILLAGE_DETOUR_LIMITS.maxBreadCrafts, 0, VILLAGE_DETOUR_LIMITS.maxBreadCrafts),
    maxSelectedOpportunities: bounded(raw.maxSelectedOpportunities, VILLAGE_DETOUR_LIMITS.maxSelectedOpportunities, 1, VILLAGE_DETOUR_LIMITS.maxSelectedOpportunities),
    maxReceiptHistory: bounded(raw.maxReceiptHistory, VILLAGE_DETOUR_LIMITS.maxReceiptHistory, 8, VILLAGE_DETOUR_LIMITS.maxReceiptHistory),
  };
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function count(value) {
  return nonNegativeInteger(value, 0);
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  return Math.max(0, finite(value, 0));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeId(value) {
  return text(value).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96) || 'detour';
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function round3(value) {
  return Math.round(value * 1_000) / 1_000;
}
