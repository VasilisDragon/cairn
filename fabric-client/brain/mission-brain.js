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
// Live-wiring note: actions that need a world target (gather_log) get a best-effort target from the
// snapshot here; full in-world target/direction parity with the legacy adapter is a live-tuning task.

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
  const orchestratorOpts = { complete, model: opts.model, maxTokens: opts.maxTokens, costGuard: opts.costGuard, ttlMs };

  const byInstance = new Map(); // instanceId -> { orch, setupSent, setupReadyAtMs }
  let commandSeq = 0;

  return async function handleMissionIntent(instanceId, snapshot) {
    let entry = byInstance.get(instanceId);
    if (!entry) {
      entry = { orch: new MissionOrchestrator(orchestratorOpts), setupSent: false, setupReadyAtMs: 0, lastCommandId: null, lastAction: null };
      byInstance.set(instanceId, entry);
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

    const out = await entry.orch.step(snapshot || {});
    for (const sig of out.signals) emit({ ...sig, instanceId });

    // Command lifecycle: the client CONTINUES a command on the same commandId but RESTARTS on a new id.
    // So reuse the id while the command is still running, and mint a fresh id only once the client
    // reports it FINISHED (snapshot.currentCommandCompleted — a recorded completion, robust to a craft
    // that finishes within one tick between polls) or the action changed.
    const action = out.intent.action;
    const completed = snapshot?.currentCommandCompleted === true;
    if (!entry.lastCommandId || action !== entry.lastAction || completed) {
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
    };

    // Best-effort target for gather (the sim ignores targets; the live client needs one).
    if ((intent.action === 'gather_log' || intent.action === 'gather_tree')
      && Array.isArray(snapshot?.nearbyLogs) && snapshot.nearbyLogs.length) {
      const t = snapshot.nearbyLogs[0];
      if (t && Number.isFinite(t.x)) { intent.targetX = t.x; intent.targetY = t.y; intent.targetZ = t.z; }
    }
    return intent;
  };
}
