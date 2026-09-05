// Mission-mode brain handler (Slice 2 in-world wiring).
//
// Adapts the MissionOrchestrator to the brain HTTP contract used by the Fabric client:
// `handleMissionIntent(instanceId, snapshot) -> intent`. Keeps one orchestrator per instanceId
// (so mission state persists across polls), emits the orchestrator's mission.* signals, and shapes
// the orchestrator's chosen action into the intent the client expects.
//
// PURE by construction: the model call (`complete`) and the signal sink (`emit`) are both injected,
// so the offline test needs no advisor/openai/network. The server wiring (deepseek-adapter.js) passes
// the real advisor `complete` and console-logging `emit`.
//
// Live-wiring note: actions that need a world target (gather_log, fixture-guided mine_nearby_iron)
// get a best-effort target from the snapshot or controlled fixture hints here.

import { MissionOrchestrator } from './mission-orchestrator.js';
import { expectedObjective } from './mission-planner.js';
import {
  isVillageOpportunityReceiptSnapshot,
  sanitizeVillageReceiptSnapshot,
  VillageOpportunityTransactionController,
  villageOpportunityFoodTelemetry,
} from './village-opportunity-transaction.js';

const DEFAULT_TTL_MS = 4000;
const DEFAULT_MAX_TTL_MS = 15000;

export function createMissionBrainHandler(opts = {}) {
  const complete = opts.complete;
  if (typeof complete !== 'function') {
    throw new Error('createMissionBrainHandler requires opts.complete(messages, opts) function');
  }
  const emit = typeof opts.emit === 'function'
    ? opts.emit
    : (sig) => console.log(JSON.stringify(sig));
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxTtlMs = opts.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  const setupCommands = Array.isArray(opts.setupCommands) ? opts.setupCommands : [];
  const setupSettleMs = Number.isFinite(opts.setupSettleMs) ? opts.setupSettleMs : 1000;
  const targetHints = normalizeTargetHints(opts.targetHints);
  // Optional top-level mission goal (e.g. 'diamond'), merged into each snapshot so the planner's
  // summarizeState sees it (-> targetDiamondTier). Injected via opts (the adapter reads the env) to keep
  // this module pure; this is the same seam the future goal-input UI will drive.
  const missionGoal = typeof opts.missionGoal === 'string' ? opts.missionGoal.trim() : '';
  const strategy = opts.strategyCoordinator;
  const strategyActiveCanary = strategy?.mode === 'active_canary';
  // Deterministic, no-provider opportunity subsystem. Shadow mode remains
  // observational. Active mode may wrap a code-generated, already-feasible
  // village choice in the bounded transaction controller below; no model is
  // consulted and the baseline orchestrator remains authoritative.
  const opportunity = opts.opportunityCoordinator;
  const opportunityActive = opportunity?.mode === 'active';
  const opportunityScheduler = typeof opts.opportunityScheduler === 'function'
    ? opts.opportunityScheduler
    : (task) => setImmediate(task);
  const orchestratorOpts = {
    complete,
    model: opts.model,
    maxTokens: opts.maxTokens,
    costGuard: opts.costGuard,
    ttlMs,
    now: nowFn,
    stallTimeoutMs: opts.stallTimeoutMs,
    abortTimeoutMs: opts.abortTimeoutMs,
    gatherRecoveryLimit: opts.gatherRecoveryLimit,
    exploreEnabled: opts.exploreEnabled === true,
    exploreLegBlocks: opts.exploreLegBlocks,
    exploreLegLimit: opts.exploreLegLimit,
    exploreArriveDist: opts.exploreArriveDist,
    exploreHopBlocks: opts.exploreHopBlocks,
    woodOriginRecoveryLimit: opts.woodOriginRecoveryLimit,
    woodOriginRecoveryBlocks: opts.woodOriginRecoveryBlocks,
    woodOriginRecoveryArriveDist: opts.woodOriginRecoveryArriveDist,
    woodOriginAcquireTimeoutMs: opts.woodOriginAcquireTimeoutMs,
    woodOriginTravelTimeoutMs: opts.woodOriginTravelTimeoutMs,
    forceLlm: opts.forceLlm === true,
    oraclePrimary: opts.oraclePrimary !== false,
  };

  const byInstance = new Map(); // instanceId -> { orch, setupSent, setupReadyAtMs }
  let commandSeq = 0;
  let opportunityAccepting = true;

  function emitStrategyRejection(instanceId, objective, error, trigger = 'observation') {
    emit({
      evt: strategyActiveCanary ? 'strategy.active_canary.rejected' : 'strategy.shadow.rejected',
      instanceId,
      trigger,
      deterministicObjective: objective || null,
      reason: String(error?.message || error || 'strategy_observation_failed').replace(/[\r\n]+/g, ' ').slice(0, 600),
      behaviorApplied: false,
    });
  }

  function observeStrategy(instanceId, entry, snapshot, context = {}, afterOpportunity = false) {
    if (!strategy || typeof strategy.observe !== 'function') return;
    // Active canary prompts must see the opportunity catalog produced from the
    // exact same snapshot. They are chained from the opportunity mailbox drain
    // below, never raced against its asynchronous observation. Shadow retains
    // its historical immediate, physically inert observation behavior.
    if (strategyActiveCanary && !afterOpportunity) return;
    const nextBoundaryGeneration = Number.isInteger(context.targetBoundaryGeneration)
      && context.targetBoundaryGeneration > 0
      ? context.targetBoundaryGeneration
      : entry.strategyBoundaryGeneration + 1;
    const enrichedContext = Object.freeze({
      ...context,
      strategyBoundaryGeneration: nextBoundaryGeneration,
      targetBoundaryGeneration: nextBoundaryGeneration,
      boundaryOpen: false,
    });
    try {
      const observed = strategy.observe(instanceId, snapshot, enrichedContext);
      // Observations must never delay deterministic physical work. Coordinators
      // own and contain their asynchronous provider lifecycle; this catch only
      // prevents a rejected observer promise from escaping the brain process.
      if (observed && typeof observed.then === 'function') {
        Promise.resolve(observed).catch((error) => {
          emitStrategyRejection(instanceId, enrichedContext.defaultObjective, error);
        });
      }
    } catch (error) {
      emitStrategyRejection(instanceId, enrichedContext.defaultObjective, error);
    }
  }

  function consumeStrategyBoundary(instanceId, entry, snapshot, context) {
    if (!strategyActiveCanary || typeof strategy?.consumeBoundary !== 'function') {
      return Object.freeze({ kind: 'absent', reason: 'active_canary_unavailable' });
    }
    try {
      const result = strategy.consumeBoundary(instanceId, snapshot, context);
      // A boundary consume is an O(1), nonblocking mailbox read. Never await a
      // model call here: an unfinished response belongs to a later boundary and
      // deterministic opportunity selection proceeds immediately.
      if (result && typeof result.then === 'function') {
        return Object.freeze({ kind: 'rejected', reason: 'asynchronous_boundary_receipt' });
      }
      return normalizeStrategyBoundaryReceipt(result, context.boundaryGeneration);
    } catch (error) {
      emitStrategyRejection(instanceId, context.defaultObjective, error, 'boundary_consume');
      return Object.freeze({ kind: 'rejected', reason: 'boundary_consume_failed' });
    }
  }

  function expireStrategyBoundary(instanceId, boundaryGeneration, reason) {
    if (!strategyActiveCanary || typeof strategy?.expireBoundary !== 'function') return;
    try {
      strategy.expireBoundary(instanceId, boundaryGeneration, reason);
    } catch (error) {
      emitStrategyRejection(instanceId, null, error, 'boundary_expire');
    }
  }

  function emitOpportunityRejection(instanceId, objective, error, trigger = 'observation') {
    emit({
      evt: 'opportunity.shadow.rejected',
      instanceId,
      trigger,
      deterministicObjective: objective || null,
      reason: String(error?.message || error || 'opportunity_observation_failed').replace(/[\r\n]+/g, ' ').slice(0, 600),
      behaviorApplied: false,
    });
  }

  function scheduleOpportunityDrain(instanceId, mailbox) {
    if (!opportunity || typeof opportunity.observe !== 'function') return;
    if (mailbox.scheduled || mailbox.running || mailbox.pending === null) return;
    mailbox.scheduled = true;
    try {
      opportunityScheduler(() => {
        mailbox.scheduled = false;
        return drainOpportunityObservation(instanceId, mailbox);
      });
    } catch (error) {
      mailbox.scheduled = false;
      const pending = mailbox.pending;
      mailbox.pending = null;
      emitOpportunityRejection(instanceId, pending?.context?.defaultObjective, error, 'scheduler');
    }
  }

  function drainOpportunityObservation(instanceId, mailbox) {
    if (mailbox.running) return mailbox.activePromise || Promise.resolve();
    if (mailbox.pending === null) return Promise.resolve();
    const observation = mailbox.pending;
    mailbox.pending = null;
    mailbox.running = true;
    let observerResult;
    try {
      // Start only from the scheduler/explicit flush path, while retaining
      // compatibility with synchronous observers used by the offline corpus.
      observerResult = opportunity.observe(instanceId, observation.snapshot, observation.context);
    } catch (error) {
      emitOpportunityRejection(instanceId, observation.context.defaultObjective, error);
    }
    const activePromise = Promise.resolve(observerResult)
      .then(() => {
        if (!strategyActiveCanary) return;
        const entry = byInstance.get(instanceId);
        if (!entry) return;
        observeStrategy(
          instanceId,
          entry,
          observation.snapshot,
          observation.context,
          true,
        );
      })
      .catch((error) => {
        emitOpportunityRejection(instanceId, observation.context.defaultObjective, error);
      })
      .finally(() => {
        mailbox.running = false;
        if (mailbox.activePromise === activePromise) mailbox.activePromise = null;
        scheduleOpportunityDrain(instanceId, mailbox);
      });
    mailbox.activePromise = activePromise;
    return activePromise;
  }

  function enqueueOpportunityObservation(instanceId, entry, snapshot, context) {
    if (!opportunityAccepting || !opportunity || typeof opportunity.observe !== 'function') return;
    // One in-flight observation plus one replaceable mailbox entry per
    // instance. Poll bursts therefore exert bounded backpressure and retain
    // only their newest counterfactual state.
    const baseSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const opportunitySnapshot = missionGoal ? { ...baseSnapshot, missionGoal } : baseSnapshot;
    entry.opportunityObservation.pending = { snapshot: opportunitySnapshot, context };
    scheduleOpportunityDrain(instanceId, entry.opportunityObservation);
  }

  function enqueuePreMissionOpportunityObservation(instanceId, entry, snapshot, intent) {
    const baseSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const raw = missionGoal ? { ...baseSnapshot, missionGoal } : baseSnapshot;
    // Setup and settling are physical fixture/bootstrap work, not mission
    // objectives. Still feed their newest authoritative snapshot to the
    // provider-free opportunity mailbox so a deterministic decision can be
    // ready at the only clean boundary before a long first command (commonly
    // DESCEND). `expectedObjective` is pure and does not start or mutate the
    // orchestrator, so the setup/settle output remains byte-equivalent.
    const defaultObjective = expectedObjective(raw);
    const targetBoundaryGeneration = entry.strategyBoundaryGeneration + 1;
    const context = Object.freeze({
      defaultObjective,
      signals: Object.freeze([]),
      appliedIntent: Object.freeze({ ...intent }),
      deterministicIntent: Object.freeze({ ...intent }),
      behaviorApplied: false,
      preMissionObservation: true,
      strategyTrigger: 'pre_mission_setup',
      targetBoundaryGeneration,
      junctionType: 'run_start',
      junctionRevision: targetBoundaryGeneration,
    });
    enqueueOpportunityObservation(instanceId, entry, baseSnapshot, context);
  }

  async function flushOpportunityMailbox(instanceId, mailbox) {
    // Explicit lifecycle flushing bypasses an outstanding scheduler callback,
    // but still goes through the same single-consumer drain. A subsequently
    // invoked callback observes an empty mailbox and is harmless.
    while (mailbox.running || mailbox.pending !== null) {
      if (mailbox.running) {
        await mailbox.activePromise;
      } else {
        await drainOpportunityObservation(instanceId, mailbox);
      }
    }
  }

  async function flushOpportunityObservations(instanceId = null) {
    if (!opportunity || typeof opportunity.observe !== 'function') return;
    if (instanceId !== null && instanceId !== undefined) {
      const entry = byInstance.get(instanceId);
      if (entry) await flushOpportunityMailbox(instanceId, entry.opportunityObservation);
      return;
    }
    await Promise.all([...byInstance.entries()].map(([id, entry]) => (
      flushOpportunityMailbox(id, entry.opportunityObservation)
    )));
  }

  async function closeOpportunityObservations() {
    // Stop admitting new shadow work before flushing so shutdown has a finite
    // amount of observer work: at most one running and one latest pending item
    // per instance.
    opportunityAccepting = false;
    for (const entry of byInstance.values()) entry.villageDetour.reset('handler_shutdown');
    await flushOpportunityObservations();
  }

  const handleMissionIntent = async function handleMissionIntent(instanceId, snapshot) {
    let entry = byInstance.get(instanceId);
    if (!entry) {
      let entryRef = null;
      const villageDetour = new VillageOpportunityTransactionController({
        now: nowFn,
        ttlMs,
        maxTtlMs,
        emit: (event) => {
          if (entryRef && (event?.evt === 'opportunity.detour.completed'
              || event?.evt === 'opportunity.detour.failed')) {
            entryRef.lastVillageTerminalSummary = Object.freeze({ ...event });
          }
          emit({ ...event, instanceId });
        },
        applyReceipt: typeof opportunity?.applyVillageReceipt === 'function'
          ? (receipt) => opportunity.applyVillageReceipt(instanceId, receipt)
          : null,
      });
      entry = {
        orch: new MissionOrchestrator(orchestratorOpts),
        setupSent: false,
        setupReadyAtMs: 0,
        lastCommandId: null,
        lastAction: null,
        frozenIronToolContract: null,
        lastPlanSource: 'none',
        lastPlanReason: '',
        lastTargetCommandId: null,
        lastTargetHintCommandId: null,
        lastHintTarget: null,
        consumedTargetHints: new Set(),
        opportunityObservation: {
          scheduled: false,
          running: false,
          pending: null,
          activePromise: null,
        },
        villageDetour,
        pendingVillageBaselineResume: null,
        lastVillageTerminalSummary: null,
        orphanedVillageReceipts: new Set(),
        lastDeferredOpportunityDecisionId: null,
        strategyBoundaryGeneration: 0,
      };
      entryRef = entry;
      byInstance.set(instanceId, entry);
    }
    // Consume and classify `village_*` receipts before MissionOrchestrator is
    // allowed to see them. The orchestrator is held completely still while the
    // transaction owns physical control; on the first neutral terminal poll it
    // resumes from authoritative inventory/world state without ever seeing an
    // infrastructure command completion or failure.
    const detourStateBeforeTick = opportunityActive ? entry.villageDetour.activeSnapshot() : null;
    const detourIntent = opportunityActive ? entry.villageDetour.tick(snapshot) : null;
    const knownDetourReceipt = opportunityActive && entry.villageDetour.ownsReceipt(snapshot);
    const detourReceiptOwned = opportunityActive
      && (knownDetourReceipt || isVillageOpportunityReceiptSnapshot(snapshot));
    if (detourReceiptOwned && !knownDetourReceipt) {
      const orphanedId = typeof snapshot?.currentCommandId === 'string'
        ? snapshot.currentCommandId.trim()
        : '';
      const key = `${orphanedId}:${snapshot?.currentCommandCompletionReason || ''}`;
      if (!entry.orphanedVillageReceipts.has(key)) {
        if (entry.orphanedVillageReceipts.size >= 64) {
          entry.orphanedVillageReceipts.delete(entry.orphanedVillageReceipts.values().next().value);
        }
        entry.orphanedVillageReceipts.add(key);
        emit({
          evt: 'opportunity.detour.receipt_rejected',
          instanceId,
          commandId: orphanedId || null,
          reason: 'orphaned_detour_receipt',
          completionReason: snapshot?.currentCommandCompletionReason || '',
          chargedAsBaselineFailure: false,
          clocksReset: false,
          retriesConsumed: 0,
          behaviorApplied: false,
          ...villageOpportunityFoodTelemetry(snapshot),
        });
      }
    }
    const orchestratorSnapshot = detourReceiptOwned
      ? sanitizeVillageReceiptSnapshot(snapshot)
      : snapshot;
    if (detourIntent) {
      // Do not feed detour travel coordinates into MissionOrchestrator's
      // baseline progress key. Its absolute timestamps continue aging via the
      // injected clock and are evaluated on the first sanitized resume poll;
      // retries, objective state, and progress clocks remain byte-for-byte
      // untouched while physical village work is active.
      const detourState = entry.villageDetour.activeSnapshot() || detourStateBeforeTick;
      // Keep the planner's frozen memory revisions stable during a transaction.
      // The terminal stop is queued only after its correlated executor receipt
      // has been synchronously committed by the transaction controller.
      if (detourIntent.opportunityStage === 'complete'
          || detourIntent.opportunityStage === 'fallback') {
        const terminalSummary = entry.lastVillageTerminalSummary?.detourId === detourIntent.detourId
          ? entry.lastVillageTerminalSummary
          : null;
        entry.pendingVillageBaselineResume = Object.freeze({
          detourId: detourIntent.detourId || null,
          resumeToken: detourIntent.resumeToken || null,
          outcome: detourIntent.opportunityStage,
          terminalCommandId: detourIntent.commandId || null,
          originalObjective: terminalSummary?.originalObjective
            || detourState?.originalObjective
            || detourIntent.missionObjective
            || null,
          routeReplanCount: terminalRouteReplanCount(terminalSummary || detourState),
        });
        entry.lastVillageTerminalSummary = null;
        const targetBoundaryGeneration = entry.strategyBoundaryGeneration + 1;
        enqueueOpportunityObservation(
          instanceId,
          entry,
          snapshot && typeof snapshot === 'object' ? snapshot : {},
          Object.freeze({
            defaultObjective: detourState?.originalObjective || detourIntent.missionObjective || null,
            signals: Object.freeze([]),
            appliedIntent: Object.freeze({ ...detourIntent }),
            deterministicIntent: null,
            behaviorApplied: true,
            strategyTrigger: 'verified_opportunity_outcome',
            verifiedOpportunityOutcome: detourIntent.opportunityStage,
            detourId: detourIntent.detourId || null,
            targetBoundaryGeneration,
            junctionType: 'verified_opportunity_outcome',
            junctionRevision: targetBoundaryGeneration,
          }),
        );
      }
      return detourIntent;
    }
    const rawCompletion = orchestratorSnapshot?.currentCommandCompleted === true;
    const explicitCompletedCommandId = typeof orchestratorSnapshot?.currentCommandId === 'string'
      && orchestratorSnapshot.currentCommandId.trim()
      ? orchestratorSnapshot.currentCommandId.trim()
      : (typeof orchestratorSnapshot?.activeNavigationCommandId === 'string'
          ? orchestratorSnapshot.activeNavigationCommandId.trim()
          : '');
    const completedCommandId = rawCompletion
      ? (explicitCompletedCommandId || entry.lastCommandId)
      : null;
    const completionAcknowledged = rawCompletion
      && Boolean(completedCommandId)
      && completedCommandId === entry.lastCommandId;
    if (completionAcknowledged && entry.lastHintTarget) {
      const completedTarget = entry.lastHintTarget;
      const completionReason = typeof orchestratorSnapshot.currentCommandCompletionReason === 'string'
        ? orchestratorSnapshot.currentCommandCompletionReason
        : '';
      entry.consumedTargetHints.add(targetKey(completedTarget));
      emit({
        evt: 'mission.target_hint.consumed',
        action: completedTarget.action,
        targetX: completedTarget.x,
        targetY: completedTarget.y,
        targetZ: completedTarget.z,
        reason: completionReason || 'command_complete',
        instanceId,
      });
      entry.lastHintTarget = null;
    }

    // One-time world setup (give items, set time/difficulty, …) before the mission begins — the
    // mission handler owns this since it bypasses the legacy adapter that normally sends it.
    if (setupCommands.length && !entry.setupSent) {
      entry.setupSent = true;
      entry.setupReadyAtMs = nowFn() + setupSettleMs;
      commandSeq += 1;
      const setupIntent = {
        action: 'setup_commands', serverCommands: setupCommands, ttlMs, maxTtlMs,
        commandId: `mission-${instanceId}-setup-${commandSeq}`, reason: 'mission:setup',
        missionObjective: 'SETUP', missionDone: false,
      };
      enqueuePreMissionOpportunityObservation(instanceId, entry, snapshot, setupIntent);
      return setupIntent;
    }
    if (entry.setupSent && nowFn() < entry.setupReadyAtMs) {
      commandSeq += 1;
      const settleIntent = {
        action: 'stop', ttlMs, maxTtlMs, commandId: `mission-${instanceId}-settle-${commandSeq}`,
        reason: 'mission:settle', missionObjective: 'SETUP', missionDone: false,
      };
      enqueuePreMissionOpportunityObservation(instanceId, entry, snapshot, settleIntent);
      return settleIntent;
    }

    const baseSnapshot = orchestratorSnapshot && typeof orchestratorSnapshot === 'object'
      ? orchestratorSnapshot
      : {};
    const raw = missionGoal ? { ...baseSnapshot, missionGoal } : baseSnapshot;
    if (entry.pendingVillageBaselineResume?.outcome === 'complete') {
      const reconsidered = entry.orch.reconsiderAfterAuthoritativeOpportunity(raw);
      if (reconsidered.changed) {
        emit({
          evt: 'opportunity.detour.authoritative_replan',
          instanceId,
          detourId: entry.pendingVillageBaselineResume.detourId,
          resumeToken: entry.pendingVillageBaselineResume.resumeToken,
          fromObjective: reconsidered.from,
          toObjective: reconsidered.to,
          chargedAsBaselineFailure: false,
          clocksReset: false,
          retriesConsumed: 0,
        });
      }
    }
    // At terminal polls Fabric reuses the existing activeNavigationCommandId context field for the
    // acknowledged command (including non-navigation actions). Pass that private identity to the
    // orchestrator so same-reason retries remain distinct without expanding the snapshot schema.
    const out = await entry.orch.step(raw, {
      completedCommandId,
      activeCommandId: explicitCompletedCommandId || entry.lastCommandId,
    });
    for (const sig of out.signals) {
      emit({ ...sig, instanceId });
      // Capture the planner's last decision (source + the LLM's "why") for the cockpit DeepSeek panel.
      // It rides the mission.objective.chosen signal; persist it so the panel stays populated between
      // re-plans (the orchestrator only re-plans on transitions).
      if (sig.evt === 'mission.objective.chosen') {
        entry.lastPlanSource = sig.source || 'none';
        entry.lastPlanReason = sig.reason || '';
      }
    }

    // Command lifecycle: the client CONTINUES a command on the same commandId but RESTARTS on a new id.
    // So reuse the id while the command is still running, and mint a fresh id only once the client
    // reports it FINISHED (snapshot.currentCommandCompleted — a recorded completion, robust to a craft
    // that finishes within one tick between polls) or the action changed.
    const action = out.intent.action;
    // A response can be computed by the brain server but lost before Fabric applies it. In that
    // case the client repeats the old completed command id. Keep returning the already-generated
    // retry instead of charging or minting another retry until Fabric acknowledges that id.
    const suppressionStop = action === 'stop' && out.source === 'surface_return_retry_suppressed';
    const completed = completionAcknowledged && !suppressionStop;
    const cleanOpportunityBoundary = !entry.lastCommandId || completionAcknowledged;
    const baselineCommandNewThisPoll = !entry.lastCommandId
      || action !== entry.lastAction
      || completed
      || out.replanned === true
      || out.restartCommand === true;
    if (baselineCommandNewThisPoll) {
      commandSeq += 1;
      entry.lastCommandId = `mission-${instanceId}-${commandSeq}`;
      const remainingMissionIronCount = out.intent.remainingMissionIronCount;
      const reservedIronPickaxeCount = out.intent.reservedIronPickaxeCount;
      const reservedIronPickaxeDurabilityFloor = out.intent.reservedIronPickaxeDurabilityFloor;
      entry.frozenIronToolContract = Number.isInteger(remainingMissionIronCount)
          && remainingMissionIronCount >= 0
          && Number.isInteger(reservedIronPickaxeCount)
          && reservedIronPickaxeCount > 0
          && Number.isInteger(reservedIronPickaxeDurabilityFloor)
          && reservedIronPickaxeDurabilityFloor > 0
        ? Object.freeze({
          remainingMissionIronCount,
          reservedIronPickaxeCount,
          reservedIronPickaxeDurabilityFloor,
        })
        : null;
    }
    entry.lastAction = action;
    entry.orch.bindSurfaceProvisionalAnchorCommand(entry.lastCommandId, action, out.objective);
    entry.orch.bindWoodGatherCommand(entry.lastCommandId, action, out.objective, raw);
    entry.orch.bindWoodOriginRecoveryCommand(entry.lastCommandId, action, out.intent.reason);

    const intent = {
      action,
      ttlMs: out.intent.ttlMs ?? ttlMs,
      maxTtlMs,
      commandId: entry.lastCommandId,
      reason: out.intent.reason || `mission:${out.objective || 'idle'}`,
      missionObjective: out.objective || null,
      missionDone: out.done === true,
      // Cockpit DeepSeek panel: the planner's last decision provenance + justification.
      planSource: entry.lastPlanSource,
      planReason: entry.lastPlanReason,
    };
    for (const key of ['targetX', 'targetY', 'targetZ']) {
      if (Number.isFinite(out.intent[key])) intent[key] = out.intent[key];
    }
    for (const key of [
      'completionInventoryLogCount',
      'completionInventoryPlankCount',
      'completionInventoryCobblestoneCount',
    ]) {
      if (Number.isInteger(out.intent[key]) && out.intent[key] > 0) intent[key] = out.intent[key];
    }
    if (entry.frozenIronToolContract) Object.assign(intent, entry.frozenIronToolContract);

    if (entry.pendingVillageBaselineResume) {
      const pending = entry.pendingVillageBaselineResume;
      // Clear before publishing so even a re-entrant/throwing sink cannot
      // report the same neutral handoff twice. Inventory is read from this
      // post-detour snapshot, never from the planner's pre-detour ledger.
      entry.pendingVillageBaselineResume = null;
      const inventoryIronPickaxeCount = authoritativeInventoryItemCount(
        orchestratorSnapshot,
        'minecraft:iron_pickaxe',
        ['inventoryIronPickaxeCount', 'ironPickaxes'],
      );
      const inventoryIronIngotCount = authoritativeInventoryItemCount(
        orchestratorSnapshot,
        'minecraft:iron_ingot',
        ['inventoryIronIngotCount', 'ironIngots'],
      );
      const inventoryRawIronCount = authoritativeInventoryItemCount(
        orchestratorSnapshot,
        'minecraft:raw_iron',
        ['inventoryRawIronCount', 'rawIron'],
      );
      emit({
        evt: 'opportunity.detour.baseline_resumed',
        instanceId,
        detourId: pending.detourId,
        resumeToken: pending.resumeToken,
        outcome: pending.outcome,
        terminalCommandId: pending.terminalCommandId,
        originalObjective: pending.originalObjective,
        inventoryIronPickaxeCount,
        inventoryIronIngotCount,
        inventoryRawIronCount,
        authoritativeInventory: true,
        ironPickaxe: inventoryIronPickaxeCount > 0,
        ironPickaxeCount: inventoryIronPickaxeCount,
        ironPickaxeDeficit: inventoryIronPickaxeCount > 0 ? 0 : 1,
        ironIngotCount: inventoryIronIngotCount,
        ironPickaxeIngotDeficit: inventoryIronPickaxeCount > 0
          ? 0
          : Math.max(0, 3 - inventoryIronIngotCount),
        objective: out.objective || null,
        nextObjective: out.objective || null,
        nextAction: intent.action,
        nextCommandId: intent.commandId,
        objectiveCompleted: out.done === true,
        missionDone: intent.missionDone === true,
        routeReplanCount: pending.routeReplanCount,
        chargedAsBaselineFailure: false,
        clocksReset: false,
        retriesConsumed: 0,
      });
    }

    // Best-effort target for live actions that benefit from a known fixture direction. Controlled
    // fixture hints come first when present; otherwise live perception supplies opportunistic targets.
    if (supportsTargetHints(intent.action)) {
      const target = chooseTargetHint(intent.action, baseSnapshot, targetHints, entry.consumedTargetHints);
      if (target) {
        intent.targetX = target.x;
        intent.targetY = target.y;
        intent.targetZ = target.z;
        if (entry.lastTargetCommandId !== intent.commandId) {
          entry.lastTargetCommandId = intent.commandId;
          emit({
            evt: 'mission.target.used',
            action: intent.action,
            source: target.source,
            targetX: target.x,
            targetY: target.y,
            targetZ: target.z,
            instanceId,
          });
        }
        if (target.source === 'hint' && entry.lastTargetHintCommandId !== intent.commandId) {
          entry.lastTargetHintCommandId = intent.commandId;
          emit({
            evt: 'mission.target_hint.used',
            action: intent.action,
            targetX: target.x,
            targetY: target.y,
            targetZ: target.z,
            instanceId,
          });
        }
        entry.lastHintTarget = target;
      }
    }
    // Schedule after the deterministic intent is fully assembled, but never
    // execute opportunity work on the response path. The copied/frozen
    // context cannot mutate the intent returned to Fabric.
    let appliedIntent = detourIntent;
    const latestDecision = opportunityActive && typeof opportunity.latestDecision === 'function'
      ? opportunity.latestDecision(instanceId)
      : null;
    let openedStrategyBoundary = null;
    let strategyBoundaryReceipt = Object.freeze({ kind: 'absent', reason: 'inactive' });
    if (!appliedIntent && !entry.villageDetour.isActive()
        && cleanOpportunityBoundary && strategyActiveCanary) {
      entry.strategyBoundaryGeneration += 1;
      openedStrategyBoundary = entry.strategyBoundaryGeneration;
      strategyBoundaryReceipt = consumeStrategyBoundary(instanceId, entry, raw, Object.freeze({
        boundaryGeneration: openedStrategyBoundary,
        targetBoundaryGeneration: openedStrategyBoundary,
        boundaryOpen: true,
        defaultObjective: out.objective,
        signals: Object.freeze([...out.signals]),
        deterministicIntent: Object.freeze({ ...intent }),
      }));
      if (strategyBoundaryReceipt.kind === 'opportunity' && !opportunityActive) {
        strategyBoundaryReceipt = Object.freeze({
          kind: 'rejected',
          reason: 'opportunity_controller_inactive',
        });
      }
    }
    if (!appliedIntent && opportunityActive && !entry.villageDetour.isActive()) {
      if (cleanOpportunityBoundary) {
        const strategySuppressedDetour = strategyBoundaryReceipt.kind === 'baseline';
        const selectedDecision = strategyBoundaryReceipt.kind === 'opportunity'
          ? strategyBoundaryReceipt.decision
          : latestDecision;
        if (!strategySuppressedDetour) {
          const transactionContext = {
            intent,
            objective: out.objective,
            objectiveStartedAtMs: entry.orch.state?.objectiveStartedAtMs,
            objectiveFailures: entry.orch.state?.objectiveFailures?.[out.objective] || 0,
          };
          appliedIntent = entry.villageDetour.maybeStart(selectedDecision, snapshot, transactionContext);
          // The strategy coordinator can only select a code-generated decision,
          // but authoritative admission may still invalidate it at this exact
          // poll. The deterministic optimizer remains available immediately.
          if (!appliedIntent && strategyBoundaryReceipt.kind === 'opportunity'
              && latestDecision && latestDecision !== selectedDecision
              && latestDecision.decisionId !== selectedDecision?.decisionId) {
            appliedIntent = entry.villageDetour.maybeStart(latestDecision, snapshot, transactionContext);
          }
        }
      } else if (latestDecision?.decisionId && latestDecision.shouldSwitch === true
          && entry.lastDeferredOpportunityDecisionId !== latestDecision.decisionId) {
        entry.lastDeferredOpportunityDecisionId = latestDecision.decisionId;
        emit({
          evt: 'opportunity.active.baseline_retained',
          instanceId,
          decisionId: latestDecision.decisionId,
          reason: 'baseline_command_in_flight',
          originalObjective: out.objective,
          originalCommandId: intent.commandId,
          chargedAsBaselineFailure: false,
          clocksReset: false,
          retriesConsumed: 0,
          behaviorApplied: false,
          ...villageOpportunityFoodTelemetry(snapshot),
        });
      }
    }
    if (openedStrategyBoundary !== null
        && (strategyBoundaryReceipt.kind === 'absent' || strategyBoundaryReceipt.kind === 'rejected')) {
      expireStrategyBoundary(instanceId, openedStrategyBoundary, 'physical_choice_committed');
    }
    const physicalIntent = appliedIntent || intent;
    const strategyTargetBoundaryGeneration = entry.strategyBoundaryGeneration + 1;
    const strategyJunctionType = cleanOpportunityBoundary
      ? 'clean_opportunity_boundary'
      : 'physical_command';
    // Terminal mission intents are immutable and cannot admit another opportunity. Continuing to
    // rescan and optimize them only produces stale recommendations and can overwhelm a live-fixture
    // watcher after the decisive abort/done event has already been emitted.
    if (out.objective !== 'ABORTED' && out.objective !== 'DONE') {
      enqueueOpportunityObservation(instanceId, entry, snapshot && typeof snapshot === 'object' ? snapshot : {}, Object.freeze({
        defaultObjective: out.objective,
        signals: Object.freeze([...out.signals]),
        appliedIntent: Object.freeze({ ...physicalIntent }),
        deterministicIntent: Object.freeze({ ...intent }),
        behaviorApplied: appliedIntent !== null,
        strategyTrigger: cleanOpportunityBoundary ? 'clean_opportunity_boundary' : 'physical_command',
        openedBoundaryGeneration: openedStrategyBoundary,
        targetBoundaryGeneration: strategyTargetBoundaryGeneration,
        junctionType: strategyJunctionType,
        junctionRevision: strategyTargetBoundaryGeneration,
      }));
    }
    observeStrategy(instanceId, entry, raw, Object.freeze({
      defaultObjective: out.objective,
      signals: Object.freeze([...out.signals]),
      appliedIntent: Object.freeze({ ...physicalIntent }),
      deterministicIntent: Object.freeze({ ...intent }),
      behaviorApplied: appliedIntent !== null,
      strategyTrigger: cleanOpportunityBoundary ? 'clean_opportunity_boundary' : 'physical_command',
      openedBoundaryGeneration: openedStrategyBoundary,
      targetBoundaryGeneration: strategyTargetBoundaryGeneration,
      junctionType: strategyJunctionType,
      junctionRevision: strategyTargetBoundaryGeneration,
    }));
    return physicalIntent;
  };

  // Lifecycle hooks are properties of the returned handler so server owners
  // can drain shadow-only memory/telemetry work without changing the intent
  // response contract.
  handleMissionIntent.flushOpportunityObservations = flushOpportunityObservations;
  handleMissionIntent.closeOpportunityObservations = closeOpportunityObservations;
  return handleMissionIntent;
}

function normalizeStrategyBoundaryReceipt(value, expectedGeneration) {
  if (!value || typeof value !== 'object') {
    return Object.freeze({ kind: 'absent', reason: 'no_ready_receipt' });
  }
  const receiptGeneration = Number.isInteger(value.boundaryGeneration)
    ? value.boundaryGeneration
    : (Number.isInteger(value.targetBoundaryGeneration) ? value.targetBoundaryGeneration : null);
  if (receiptGeneration !== null && receiptGeneration !== expectedGeneration) {
    return Object.freeze({ kind: 'rejected', reason: 'boundary_generation_mismatch' });
  }
  const accepted = value.ok === true || value.accepted === true || value.status === 'accepted';
  if (!accepted) {
    const reason = typeof value.reason === 'string' && value.reason.trim()
      ? value.reason.trim()
      : 'receipt_rejected';
    const absent = value.absent === true
      || value.status === 'absent'
      || /(?:no[_ -]?ready|not[_ -]?ready|absent|pending)/i.test(reason);
    return Object.freeze({ kind: absent ? 'absent' : 'rejected', reason });
  }
  const outcome = String(value.outcome ?? value.kind ?? value.choice?.kind ?? '').trim().toLowerCase();
  if (outcome === 'baseline') {
    return Object.freeze({ kind: 'baseline', reason: value.reason || 'strategy_baseline_selected' });
  }
  if (outcome === 'opportunity') {
    const decision = value.decision ?? value.opportunityDecision ?? value.choice?.decision ?? null;
    if (!decision || typeof decision !== 'object') {
      return Object.freeze({ kind: 'rejected', reason: 'accepted_opportunity_missing_decision' });
    }
    return Object.freeze({
      kind: 'opportunity',
      reason: value.reason || 'strategy_opportunity_selected',
      decision,
    });
  }
  return Object.freeze({ kind: 'rejected', reason: 'unknown_strategy_outcome' });
}

function isGatherAction(action) {
  return action === 'gather_log' || action === 'gather_tree';
}

function supportsTargetHints(action) {
  return isGatherAction(action) || action === 'mine_nearby_iron' || action === 'mine_nearby_diamond';
}

function chooseTargetHint(action, snapshot = {}, targetHints = [], consumedTargetHints = new Set()) {
  const matching = targetHints.filter((hint) => (
    (hint.action === action || (isGatherAction(action) && isGatherAction(hint.action)))
      && !consumedTargetHints.has(targetKey(hint))
  ));
  if (matching.length > 0) return { ...matching[0], source: 'hint' };

  if (isGatherAction(action)) {
    const sensed = firstFiniteTarget(snapshot?.nearbyLogs);
    if (sensed) return { ...sensed, source: 'snapshot' };
  }
  return null;
}

function firstFiniteTarget(values) {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const target = normalizeTarget(value);
    if (target) return target;
  }
  return null;
}

function normalizeTargetHints(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeTarget(value))
    .filter(Boolean)
    .slice(0, 64);
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const x = finiteNumberOrNull(value.x ?? value.targetX);
  const y = finiteNumberOrNull(value.y ?? value.targetY);
  const z = finiteNumberOrNull(value.z ?? value.targetZ);
  if (x === null || y === null || z === null) return null;
  const action = supportsTargetHints(value.action) ? value.action : 'gather_log';
  return { action, x, y, z };
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function authoritativeInventoryItemCount(snapshot, itemId, fallbackKeys = []) {
  const exact = snapshot?.inventoryItemCounts ?? snapshot?.inventory?.itemCounts;
  if (exact && typeof exact === 'object' && Object.hasOwn(exact, itemId)) {
    return nonNegativeInventoryCount(exact[itemId]);
  }
  for (const key of fallbackKeys) {
    if (snapshot && Object.hasOwn(snapshot, key)) {
      return nonNegativeInventoryCount(snapshot[key]);
    }
  }
  return 0;
}

function nonNegativeInventoryCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function terminalRouteReplanCount(detourState) {
  return Number.isInteger(detourState?.routeReplanCount)
    && detourState.routeReplanCount >= 0
    && detourState.routeReplanCount <= 1
    ? detourState.routeReplanCount
    : 0;
}

function targetKey(target) {
  return `${target.x},${target.y},${target.z}`;
}
