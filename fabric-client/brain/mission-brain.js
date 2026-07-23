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
    forceLlm: opts.forceLlm === true,
    oraclePrimary: opts.oraclePrimary !== false,
  };

  const byInstance = new Map(); // instanceId -> { orch, setupSent, setupReadyAtMs }
  let commandSeq = 0;

  return async function handleMissionIntent(instanceId, snapshot) {
    let entry = byInstance.get(instanceId);
    if (!entry) {
      entry = {
        orch: new MissionOrchestrator(orchestratorOpts),
        setupSent: false,
        setupReadyAtMs: 0,
        lastCommandId: null,
        lastAction: null,
        lastPlanSource: 'none',
        lastPlanReason: '',
        lastTargetCommandId: null,
        lastTargetHintCommandId: null,
        lastHintTarget: null,
        consumedTargetHints: new Set(),
      };
      byInstance.set(instanceId, entry);
    }
    if (snapshot?.currentCommandCompleted === true && entry.lastHintTarget) {
      const completedTarget = entry.lastHintTarget;
      const completionReason = typeof snapshot.currentCommandCompletionReason === 'string'
        ? snapshot.currentCommandCompletionReason
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
      return {
        action: 'setup_commands', serverCommands: setupCommands, ttlMs, maxTtlMs,
        commandId: `mission-${instanceId}-setup-${commandSeq}`, reason: 'mission:setup',
        missionObjective: 'SETUP', missionDone: false,
      };
    }
    if (entry.setupSent && nowFn() < entry.setupReadyAtMs) {
      commandSeq += 1;
      return {
        action: 'stop', ttlMs, maxTtlMs, commandId: `mission-${instanceId}-settle-${commandSeq}`,
        reason: 'mission:settle', missionObjective: 'SETUP', missionDone: false,
      };
    }

    const baseSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const raw = missionGoal ? { ...baseSnapshot, missionGoal } : baseSnapshot;
    const out = await entry.orch.step(raw);
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
    const completed = snapshot?.currentCommandCompleted === true;
    if (!entry.lastCommandId || action !== entry.lastAction || completed || out.replanned === true || out.restartCommand === true) {
      commandSeq += 1;
      entry.lastCommandId = `mission-${instanceId}-${commandSeq}`;
    }
    entry.lastAction = action;

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

    // Best-effort target for live actions that benefit from a known fixture direction. Controlled
    // fixture hints come first when present; otherwise live perception supplies opportunistic targets.
    if (supportsTargetHints(intent.action)) {
      const target = chooseTargetHint(intent.action, snapshot, targetHints, entry.consumedTargetHints);
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
    if (strategy && typeof strategy.observe === 'function') {
      try {
        strategy.observe(instanceId, raw, {
          defaultObjective: out.objective,
          signals: out.signals,
        });
      } catch (error) {
        emit({
          evt: 'strategy.shadow.rejected',
          instanceId,
          trigger: 'observation',
          deterministicObjective: out.objective || null,
          reason: String(error?.message || error || 'strategy_observation_failed').replace(/[\r\n]+/g, ' ').slice(0, 600),
        });
      }
    }
    return intent;
  };
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

function targetKey(target) {
  return `${target.x},${target.y},${target.z}`;
}
