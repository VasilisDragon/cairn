// Mission orchestrator (brain-as-planner Slice 2): the closed loop.
//
//   plan  -> chooseNextObjective(snapshot) picks the next objective (LLM, only on transitions)
//   do    -> nextActionForObjective(objective, snapshot) emits the next low-level action (deterministic)
//   observe -> objectiveAchieved / progress-stall / infeasible-block, fed back as lastOutcome
//   re-plan -> on complete OR block OR stall, ask the planner again (with the outcome as context)
//
// The LLM is called ONCE PER OBJECTIVE TRANSITION, never per tick — the deterministic sub-executor
// owns the multi-step "how". This module is world-agnostic: `snapshot` may be a sim state or a real
// ClientSnapshot (mission-planner.summarizeState reads both). The model call is injected via
// opts.complete, so it is offline-testable with a mock and live-runnable with the real advisor.

import {
  chooseNextObjective,
  objectiveAchieved,
  summarizeState,
} from './mission-planner.js';

const DEFAULT_TTL_MS = 4000;

// Iron armor pieces in canonical equip order, with their crafting cost and the ClientSnapshot slot
// field that reports whether the piece is currently worn (the sim sets the same fields).
const IRON_ARMOR_PIECES = [
  { slot: 'equippedHelmetItem', item: 'iron_helmet', action: 'craft_iron_helmet', cost: 5 },
  { slot: 'equippedChestplateItem', item: 'iron_chestplate', action: 'craft_iron_chestplate', cost: 8 },
  { slot: 'equippedLeggingsItem', item: 'iron_leggings', action: 'craft_iron_leggings', cost: 7 },
  { slot: 'equippedBootsItem', item: 'iron_boots', action: 'craft_iron_boots', cost: 4 },
];

// First iron-armor slot NOT already filled with iron, in canonical order. Picking by EMPTY SLOT
// (not by equipped count) means out-of-order armor — a piece picked up, or replaced after breaking
// via the R7 durability reflex — crafts the actually-missing piece instead of re-crafting a worn
// one (which would stall the count at <4 forever).
function nextArmorPiece(raw) {
  for (const piece of IRON_ARMOR_PIECES) {
    if (raw?.[piece.slot] !== piece.item) return piece;
  }
  return null;
}

// Objective -> next low-level action id (verified against BrainLink.java). Returns null when the
// objective cannot make progress from this state (missing prerequisites) -> the orchestrator treats
// that as "blocked" and re-plans, which is how recovery is triggered.
export function nextActionForObjective(objective, raw) {
  const s = summarizeStatePlus(raw);
  switch (objective) {
    case 'GATHER_WOOD':
      return 'gather_log';
    case 'MAKE_WOOD_TOOLS': {
      if (s.woodenPickaxes >= 1) return null;
      if (s.planks < 7 && s.logs >= 1) return 'craft_planks';
      if (s.sticks < 2 && s.planks >= 2) return 'craft_sticks';
      if (s.craftingTables < 1 && !s.tablePlaced && s.planks >= 4) return 'craft_table';
      if (!s.tablePlaced && s.craftingTables >= 1) return 'place_table';
      if (s.planks >= 3 && s.sticks >= 2 && s.tablePlaced) return 'craft_pickaxe';
      return null;
    }
    case 'MINE_STONE':
      return (s.woodenPickaxes >= 1 || s.stonePickaxes >= 1 || s.ironPickaxes >= 1) ? 'mine_stone' : null;
    case 'MAKE_STONE_TOOLS': {
      if (s.stonePickaxes >= 1 && s.stoneSwords >= 1) return null;
      if (s.sticks < 2) return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
      if (!s.tablePlaced) return tableSetupAction(s);
      if (s.stonePickaxes < 1) return s.cobblestone >= 3 ? 'craft_stone_pickaxe' : null;
      if (s.stoneSwords < 1) return s.cobblestone >= 1 ? 'craft_stone_sword' : null;
      return null;
    }
    case 'MAKE_FURNACE': {
      if (s.furnaces >= 1 || s.furnacePlaced) return s.furnacePlaced ? null : 'place_furnace';
      if (!s.tablePlaced) return tableSetupAction(s); // furnace is a 3x3 craft -> needs a table
      return s.cobblestone >= 8 ? 'craft_furnace' : null;
    }
    case 'DESCEND':
      return (s.stonePickaxes >= 1 || s.ironPickaxes >= 1) ? 'descend_staircase' : null;
    case 'MINE_IRON':
      return (s.atIronDepth && (s.stonePickaxes >= 1 || s.ironPickaxes >= 1)) ? 'mine_nearby_iron' : null;
    case 'SMELT_IRON': {
      if (!s.furnacePlaced) {
        if (s.furnaces >= 1) return 'place_furnace'; // place a carried furnace right here (no trip up)
        if (!s.tablePlaced) return tableSetupAction(s); // a furnace is a 3x3 craft -> needs a table
        return s.cobblestone >= 8 ? 'craft_furnace' : null;
      }
      return (s.fuel >= 1 && s.rawIron >= 1) ? 'smelt_raw_iron' : null;
    }
    case 'MAKE_IRON_TOOLS': {
      if (s.ironPickaxes >= 1) return null;
      if (s.sticks < 2) return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
      if (!s.tablePlaced) return tableSetupAction(s);
      return s.ironIngots >= 3 ? 'craft_iron_pickaxe' : null;
    }
    case 'MAKE_ARMOR': {
      const piece = nextArmorPiece(raw);
      if (!piece) return null;
      if (!s.tablePlaced) return tableSetupAction(s); // iron armor is a 3x3 craft -> needs a table
      return s.ironIngots >= piece.cost ? piece.action : null;
    }
    case 'EAT':
      // In-world this is a fast-loop reflex; as a mission objective we emit the eat action.
      return 'eat';
    case 'DONE':
    default:
      return null;
  }
}

// Get a crafting table within reach for a 3x3 craft WITHOUT travelling back to a surface table: place
// a carried table, else craft one from planks (making planks from logs first). Returns the next action,
// or null if it has no way to obtain a table (caller then blocks -> re-plan). This is what lets the bot
// craft iron tools / armor / a furnace down at iron depth.
function tableSetupAction(s) {
  if (s.craftingTables >= 1) return 'place_table';
  if (s.planks >= 4) return 'craft_table';
  if (s.logs >= 1) return 'craft_planks';
  return null;
}

// summarizeState (planner-visible inventory) plus the sub-executor's "how" flags (placement/depth),
// which a real ClientSnapshot may not expose — see the note in the goal file about live wiring.
function summarizeStatePlus(raw) {
  const base = summarizeState(raw);
  // A crafting-table/furnace ITEM (count) is NOT the same as a PLACED block — the sub-executor must
  // emit place_table/place_furnace before crafting against it. (Live-wiring note: a real ClientSnapshot
  // has no placement flag yet; either add one, or have the craft actions place-on-demand internally.)
  return {
    ...base,
    // sim uses tablePlaced/furnacePlaced; the live ClientSnapshot uses craftingTableInReach/furnaceInReach.
    tablePlaced: raw?.tablePlaced === true || raw?.craftingTableInReach === true,
    furnacePlaced: raw?.furnacePlaced === true || raw?.furnaceInReach === true,
  };
}

function progressKey(raw) {
  // Inventory (planner-visible) plus a few progress signals summarizeState omits, so multi-step
  // objectives that advance via position/placement (descend, place_table/furnace) are not mistaken
  // for a stall. In-world _y is the descent signal; the sim flags cover the rest. Undefined fields
  // are harmless.
  const s = summarizeState(raw);
  return JSON.stringify({
    ...s,
    _y: raw?.y,
    _depth: raw?.depthSteps,
    _table: raw?.tablePlaced,
    _furnace: raw?.furnacePlaced,
  });
}

function lastObjectiveOf(outcome) {
  if (typeof outcome !== 'string') return null;
  const parts = outcome.split(':');
  return parts.length >= 2 && parts[1] ? parts[1] : null;
}

function idleIntent(reason, ttlMs) {
  return { action: 'stop', ttlMs, reason: `mission:${reason}` };
}

export class MissionOrchestrator {
  constructor(opts = {}) {
    this.complete = opts.complete; // injected (messages, opts) => Promise<string>
    this.model = opts.model;
    this.maxTokens = opts.maxTokens; // undefined -> planner default (2048)
    this.temperature = opts.temperature ?? 0;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    // Stall/abort are TIME-based, not poll-count: a single in-world action (e.g. a craft) spans many
    // brain polls without changing inventory, so a poll-count stall would abandon a succeeding craft.
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 10000; // no progress on the active objective -> re-plan
    this.abortTimeoutMs = opts.abortTimeoutMs ?? 45000; // no progress at all (across re-plans) -> abort
    this.costGuard = opts.costGuard; // forwarded to the model call so the cost ceiling is enforced
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.state = {
      currentObjective: null,
      lastOutcome: 'none',
      lastKey: null,
      objectiveProgressAtMs: 0,
      globalLastKey: null,
      globalProgressAtMs: 0,
      objectivesCompleted: [],
      replans: 0,
      done: false,
    };
  }

  // One control step against `snapshot` (sim state or ClientSnapshot).
  // Returns { intent, signals, objective, done, replanned, source }.
  async step(snapshot) {
    const signals = [];
    const ms = this.state;
    if (ms.done) {
      return { intent: idleIntent('done', this.ttlMs), signals, objective: 'DONE', done: true, replanned: false, source: 'done' };
    }

    const now = this.now();
    const key = progressKey(snapshot);

    // Initialize the progress clocks on the first observation.
    if (ms.globalLastKey === null) { ms.globalLastKey = key; ms.globalProgressAtMs = now; }
    if (ms.lastKey === null) { ms.lastKey = key; ms.objectiveProgressAtMs = now; }
    // Any inventory/position change = progress; reset the stall clocks.
    if (key !== ms.globalLastKey) { ms.globalLastKey = key; ms.globalProgressAtMs = now; }
    if (key !== ms.lastKey) { ms.lastKey = key; ms.objectiveProgressAtMs = now; }

    // 0) Global watchdog — no progress AT ALL for abortTimeoutMs across any number of re-plans means
    // the mission is genuinely stuck. Abort rather than loop forever.
    if (now - ms.globalProgressAtMs >= this.abortTimeoutMs) {
      ms.done = true;
      signals.push({ evt: 'mission.aborted', reason: 'no_global_progress', stuckMs: now - ms.globalProgressAtMs, objective: ms.currentObjective || null });
      return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
    }

    // 1) Resolve the active objective: complete? or stalled (no progress for stallTimeoutMs — long
    // enough that a multi-poll in-world craft is NOT mistaken for a stall)?
    if (ms.currentObjective) {
      if (objectiveAchieved(ms.currentObjective, snapshot)) {
        signals.push({ evt: 'mission.objective.complete', objective: ms.currentObjective });
        ms.objectivesCompleted.push(ms.currentObjective);
        ms.lastOutcome = `done:${ms.currentObjective}`;
        ms.currentObjective = null;
      } else if (now - ms.objectiveProgressAtMs >= this.stallTimeoutMs) {
        signals.push({ evt: 'mission.objective.failed', objective: ms.currentObjective, reason: 'no_progress' });
        ms.lastOutcome = `failed:${ms.currentObjective}:no_progress`;
        ms.currentObjective = null;
      }
    }

    // 2) No active objective -> ask the planner (the ONLY place the LLM is called).
    let replanned = false;
    let source = 'continue';
    if (!ms.currentObjective) {
      const fromObj = lastObjectiveOf(ms.lastOutcome);
      const wasRecovery = ms.lastOutcome.startsWith('blocked') || ms.lastOutcome.startsWith('failed');
      const decision = await chooseNextObjective(snapshot, {
        complete: this.complete,
        model: this.model,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
        costGuard: this.costGuard,
        currentObjective: fromObj,
        lastOutcome: ms.lastOutcome,
      });
      replanned = true;
      source = decision.source;

      if (decision.done || decision.objective === 'DONE') {
        ms.done = true;
        signals.push({ evt: 'mission.done', objectivesCompleted: ms.objectivesCompleted.length });
        return { intent: idleIntent('done', this.ttlMs), signals, objective: 'DONE', done: true, replanned, source };
      }

      signals.push({ evt: 'mission.objective.chosen', objective: decision.objective, source: decision.source, reason: decision.reason });
      if (wasRecovery && fromObj && fromObj !== decision.objective) {
        signals.push({ evt: 'mission.replan', from: fromObj, to: decision.objective });
        ms.replans += 1;
      }
      ms.currentObjective = decision.objective;
      ms.objectiveProgressAtMs = now; // give the new objective a fresh stall window
    }

    // 3) Map the active objective -> next low-level action (deterministic "how").
    const action = nextActionForObjective(ms.currentObjective, snapshot);
    if (action === null) {
      signals.push({ evt: 'mission.objective.blocked', objective: ms.currentObjective, reason: 'missing_inputs' });
      ms.lastOutcome = `blocked:${ms.currentObjective}:missing_inputs`;
      ms.currentObjective = null;
      return { intent: idleIntent('replan', this.ttlMs), signals, objective: null, done: false, replanned, source };
    }

    return {
      intent: { action, ttlMs: this.ttlMs, reason: `mission:${ms.currentObjective}`, objective: ms.currentObjective },
      signals,
      objective: ms.currentObjective,
      done: false,
      replanned,
      source,
    };
  }
}
