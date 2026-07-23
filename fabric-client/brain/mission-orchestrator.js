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
  THRESHOLDS,
  chooseNextObjective,
  expectedObjective,
  missionComplete,
  objectiveAchieved,
  summarizeState,
} from './mission-planner.js';

const DEFAULT_TTL_MS = 4000;
const LONG_WORLD_ACTION_TTL_MS = 45000;
const CRAFT_OBJECTIVES = new Set([
  'MAKE_WOOD_TOOLS',
  'MAKE_STONE_TOOLS',
  'MAKE_FURNACE',
  'MAKE_IRON_TOOLS',
  'MAKE_DIAMOND_TOOLS',
  'MAKE_ARMOR',
]);
const TABLE_FAILURE_OBJECTIVES = new Set([...CRAFT_OBJECTIVES, 'DESCEND', 'SMELT_IRON']);
const FURNACE_FAILURE_OBJECTIVES = new Set(['MAKE_FURNACE', 'SMELT_IRON']);
const EXPLORE_EPOCH_LIMIT = 2;

// Iron armor pieces in canonical equip order, with their crafting cost and the ClientSnapshot slot
// field that reports whether the piece is currently worn (the sim sets the same fields).
const IRON_ARMOR_PIECES = [
  { slot: 'equippedHelmetItem', item: 'iron_helmet', action: 'craft_iron_helmet', count: 'ironHelmets', cost: 5 },
  { slot: 'equippedChestplateItem', item: 'iron_chestplate', action: 'craft_iron_chestplate', count: 'ironChestplates', cost: 8 },
  { slot: 'equippedLeggingsItem', item: 'iron_leggings', action: 'craft_iron_leggings', count: 'ironLeggings', cost: 7 },
  { slot: 'equippedBootsItem', item: 'iron_boots', action: 'craft_iron_boots', count: 'ironBoots', cost: 4 },
];

// First iron-armor slot NOT already filled with iron, in canonical order. Picking by EMPTY SLOT
// (not by equipped count) means out-of-order armor — a piece picked up, or replaced after breaking
// via the R7 durability reflex — crafts the actually-missing piece instead of re-crafting a worn
// one (which would stall the count at <4 forever).
function nextArmorPiece(raw, summary = summarizeStatePlus(raw)) {
  for (const piece of IRON_ARMOR_PIECES) {
    if (raw?.[piece.slot] !== piece.item) {
      return { ...piece, hasSpare: (summary[piece.count] || 0) > 0 };
    }
  }
  return null;
}

// Objective -> next low-level action id (verified against BrainLink.java). Returns null when the
// objective cannot make progress from this state (missing prerequisites) -> the orchestrator treats
// that as "blocked" and re-plans, which is how recovery is triggered.
export function nextActionForObjective(objective, raw, opts = {}) {
  const s = summarizeStatePlus(raw);
  // opts.retrieveTableSkipped: the executor completed retrieve_table as "skipped" (table
  // ray-occluded; replacement materials in hand). The skip's premise — a fresh table is cheaper
  // than this retrieval — does not expire, so every retrieve gate honors it for the mission.
  // Without this the sequencer re-demands retrieval forever (a live DESCEND abort).
  const allowRetrieveTable = opts.retrieveTableSkipped !== true;
  switch (objective) {
    case 'GATHER_WOOD': {
      // Depth-aware (the an observed regression/22 death class): wood does not exist underground. Whatever
      // selector gate landed here (sticks, planks, table materials — fuel routes via SMELT_IRON),
      // surface FIRST through the return machinery (breadcrumb trail or 3-D nav fallback), then
      // gather. Falls back to the old behavior when no surface anchor is known.
      const anchor = opts.surfaceAnchor;
      if (s.atIronDepth
        && anchor
        && Number.isFinite(anchor.x)
        && Number.isFinite(anchor.y)
        && Number.isFinite(anchor.z)) {
        return {
          action: 'return_staircase',
          targetX: anchor.x,
          targetY: anchor.y,
          targetZ: anchor.z,
          ttlMs: LONG_WORLD_ACTION_TTL_MS,
        };
      }
      return { action: 'gather_tree', ttlMs: LONG_WORLD_ACTION_TTL_MS };
    }
    case 'MAKE_WOOD_TOOLS': {
      if (s.woodenPickaxes >= 1) return s.tablePlaced && s.craftingTables < 1 && allowRetrieveTable ? 'retrieve_table' : null;
      const targetPlanks = (!s.targetIronPickaxeOnly && !s.targetDiamondTier)
        ? THRESHOLDS.planksForIronArmorMission
        : THRESHOLDS.planksForIronPickaxeMission;
      if (s.planks < targetPlanks && s.logs >= 1) return 'craft_planks';
      if (s.sticks < 2 && s.planks >= 2) return 'craft_sticks';
      if (s.craftingTables < 1 && !s.tablePlaced && s.planks >= 4) return 'craft_table';
      if (!s.tablePlaced && s.craftingTables >= 1) return 'place_table';
      if (s.planks >= 3 && s.sticks >= 2 && s.tablePlaced) return 'craft_pickaxe';
      return null;
    }
    case 'MINE_STONE':
      return (s.woodenPickaxes >= 1 || s.stonePickaxes >= 1 || s.ironPickaxes >= 1)
        ? { action: 'mine_nearby_stone', ttlMs: LONG_WORLD_ACTION_TTL_MS }
        : null;
    case 'MAKE_STONE_TOOLS': {
      if (s.stonePickaxes >= 1 && (s.targetIronPickaxeOnly || s.stoneSwords >= 1)) {
        if (!needsStonePickaxeCraftForIronPhase(s)) {
          return s.tablePlaced && s.craftingTables < 1 && allowRetrieveTable ? 'retrieve_table' : null;
        }
      }
      if (s.sticks < 2) return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
      if (!s.tablePlaced) return tableSetupAction(s);
      if (s.stonePickaxes < 1 || needsStonePickaxeCraftForIronPhase(s)) {
        return s.cobblestone >= 3 ? 'craft_stone_pickaxe' : null;
      }
      if (s.targetIronPickaxeOnly) return null;
      if (s.stoneSwords < 1) return s.cobblestone >= 1 ? 'craft_stone_sword' : null;
      return null;
    }
    case 'MAKE_FURNACE': {
      if (s.furnaces >= 1 || s.furnacePlaced) return s.furnacePlaced ? null : 'place_furnace';
      if (!s.tablePlaced) return tableSetupAction(s); // furnace is a 3x3 craft -> needs a table
      return s.cobblestone >= 8 ? 'craft_furnace' : null;
    }
    case 'DESCEND':
      if (s.atIronDepth) return null;
      if (s.stonePickaxes < 1 && s.ironPickaxes < 1) return null;
      if (s.tablePlaced && s.craftingTables < 1 && allowRetrieveTable) return 'retrieve_table';
      return descentToIronPlan(raw);
    case 'MINE_IRON':
      return (s.atIronDepth && (s.stonePickaxes >= 1 || s.ironPickaxes >= 1))
        ? { action: 'mine_nearby_iron', ttlMs: LONG_WORLD_ACTION_TTL_MS }
        : null;
    case 'SMELT_IRON': {
      if (!s.furnacePlaced) {
        if (s.furnaces >= 1) return 'place_furnace'; // place a carried furnace right here (no trip up)
        if (!s.tablePlaced) return tableSetupAction(s); // a furnace is a 3x3 craft -> needs a table
        return s.cobblestone >= 8 ? 'craft_furnace' : null;
      }
      if (needsIronToolStickReserve(s)) {
        if (s.planks >= planksNeededForStickReserveAndNextSmelt(s)) return 'craft_sticks';
        if (s.logs >= 1) return 'craft_planks';
      }
      if (s.fuel >= 1 && s.rawIron >= 1) {
        return { action: 'smelt_raw_iron', ttlMs: LONG_WORLD_ACTION_TTL_MS };
      }
      // Fuel v2 (the resource-cascade fix): fuel-short AT DEPTH with raw iron
      // waiting mines coal as a first-class delta-completed goal — never GATHER_WOOD underground.
      // If coal honestly is not in range the command fails and the normal objective-failure
      // machinery takes over.
      if (s.rawIron >= 1 && s.fuel < 1 && s.atIronDepth) {
        return { action: 'mine_nearby_coal', ttlMs: LONG_WORLD_ACTION_TTL_MS };
      }
      return null;
    }
    case 'MAKE_IRON_TOOLS': {
      const requiredPickaxes = s.targetDiamondTier && !s.atDiamondDepth ? THRESHOLDS.ironPickaxesForDiamondDescent : 1;
      if (s.ironPickaxes >= requiredPickaxes) return null;
      if (s.sticks < 2) return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
      if (!s.tablePlaced) return tableSetupAction(s);
      return s.ironIngots >= 3 ? 'craft_iron_pickaxe' : null;
    }
    case 'DESCEND_DEEP':
      return s.ironPickaxes >= THRESHOLDS.ironPickaxesForDiamondDescent
        ? { action: 'descend_staircase', targetY: THRESHOLDS.diamondTargetY, ttlMs: LONG_WORLD_ACTION_TTL_MS }
        : null;
    case 'MINE_DIAMOND':
      if (!s.atDiamondDepth || s.ironPickaxes < 1) return null;
      if (s.ironPickaxes <= 1
        && s.bestIronPickaxeRemaining >= 0
        && s.bestIronPickaxeRemaining < THRESHOLDS.minLastIronPickaxeRemainingForDiamond) {
        return null;
      }
      return 'mine_nearby_diamond';
    case 'MAKE_DIAMOND_TOOLS': {
      if (s.diamondPickaxes >= 1) return null;
      if (s.sticks < 2) return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
      if (!s.tablePlaced) return tableSetupAction(s);
      return s.diamonds >= THRESHOLDS.diamondsForPickaxe ? 'craft_diamond_pickaxe' : null;
    }
    case 'MAKE_ARMOR': {
      const piece = nextArmorPiece(raw, s);
      if (!piece) return null;
      if (piece.hasSpare) return 'equip_armor';
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

function hasCraftingTableReplacementMaterials(s) {
  return s.craftingTables >= 1 || s.planks >= 4 || s.logs >= 1;
}

function requiredStonePickaxeCount(s) {
  return s.targetIronPickaxeOnly ? 1 : THRESHOLDS.stonePickaxesForIronArmorMission;
}

function lowStonePickaxeForIronPhase(s) {
  return s.ironPickaxes < 1
    && s.stonePickaxes >= 1
    && s.bestStonePickaxeRemaining >= 0
    && s.bestStonePickaxeRemaining < THRESHOLDS.minStonePickaxeRemainingForIronPhase;
}

function needsStonePickaxeCraftForIronPhase(s) {
  return s.stonePickaxes < requiredStonePickaxeCount(s) || lowStonePickaxeForIronPhase(s);
}

function needsIronToolStickReserve(s) {
  const requiredPickaxes = s.targetDiamondTier && !s.atDiamondDepth ? THRESHOLDS.ironPickaxesForDiamondDescent : 1;
  return s.ironPickaxes < requiredPickaxes && s.sticks < 2;
}

function planksNeededForStickReserveAndNextSmelt(s) {
  const ingotShortfall = Math.max(1, THRESHOLDS.ingotsForIronPickaxe - s.ironIngots);
  const nextSmeltFuel = Math.min(2, ingotShortfall);
  return 2 + nextSmeltFuel;
}

function descentToIronPlan(raw) {
  const targetY = THRESHOLDS.ironDepthY;
  const plan = { action: 'descend_staircase', targetY, ttlMs: LONG_WORLD_ACTION_TTL_MS };
  const x = Number.isFinite(raw?.x) ? Math.floor(raw.x) : null;
  const y = Number.isFinite(raw?.y) ? Math.floor(raw.y) : null;
  const z = Number.isFinite(raw?.z) ? Math.floor(raw.z) : null;
  if (x !== null && y !== null && z !== null && y > targetY) {
    const depth = Math.max(1, y - targetY);
    plan.targetX = x;
    plan.targetZ = z + depth;
  }
  return plan;
}

function normalizedYaw(yaw) {
  if (!Number.isFinite(yaw)) return null;
  let normalized = yaw % 360;
  if (normalized >= 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
}

function yawHeadingAxis(yaw) {
  const normalized = normalizedYaw(yaw);
  if (normalized === null) return null;
  if ((normalized >= -45 && normalized <= 45) || normalized > 135 || normalized < -135) {
    return 'z';
  }
  return 'x';
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
  //
  // _xz (run-12 fix): horizontal travel IS progress — wild-terrain searching/marching at constant
  // altitude was invisible to the watchdog and aborted at 45 s mid-walk. Bucketed to 4-block cells
  // so the genuinely-wedged stationary loops (run-9: 119 commands within +-1 block) still trip the
  // watchdog on schedule, while search legs (~20 blocks) keep the clock alive.
  const s = summarizeState(raw);
  const xzBucket = Number.isFinite(raw?.x) && Number.isFinite(raw?.z)
    ? `${Math.floor(raw.x / 4)},${Math.floor(raw.z / 4)}`
    : undefined;
  return JSON.stringify({
    ...s,
    _y: raw?.y,
    _xz: xzBucket,
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

function terminalCommandFailureForObjective(objective, raw) {
  if (raw?.currentCommandCompleted !== true) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  if (!reason) return null;
  if ((objective === 'DESCEND' || objective === 'DESCEND_DEEP') && reason.startsWith('descent_failed:')) {
    return reason;
  }
  return null;
}

function descentRecoveryBlockReason(terminalFailure, raw) {
  if (raw?.touchingWater === true) {
    return 'recovery_unsafe_player_in_water';
  }
  if (typeof terminalFailure !== 'string') return null;
  if (terminalFailure.includes('descent_player_in_hazard:water')) {
    return 'recovery_unsafe_player_in_water';
  }
  if (terminalFailure.includes('descent_player_in_hazard:lava')) {
    return 'recovery_unsafe_player_in_lava';
  }
  if (terminalFailure.includes('descent_player_lava_adjacent')) {
    return 'recovery_unsafe_player_lava_adjacent';
  }
  return null;
}

function currentDescentStateBlockReason(raw) {
  if (raw?.touchingWater === true) {
    return 'recovery_unsafe_player_in_water';
  }
  return null;
}

function abortUnsafeDescent(ms, signals, objective, reason, detail, attempts, ttlMs) {
  ms.done = true;
  ms.terminalReason = 'aborted';
  ms.terminalObjective = 'ABORTED';
  signals.push({
    evt: 'mission.objective.exhausted',
    objective,
    reason,
    attempts,
  });
  signals.push({
    evt: 'mission.aborted',
    reason: 'descent_recovery_exhausted',
    objective,
    detail,
    attempts,
  });
  ms.currentObjective = null;
  return { intent: idleIntent('aborted', ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
}

function completedCommandFailureForObjective(objective, raw) {
  if (raw?.currentCommandCompleted !== true) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  if (!reason) return null;
  if (objective === 'MINE_IRON' && reason.startsWith('mine_nearby_iron_failed:')) {
    return reason;
  }
  if (objective === 'EAT' && reason.startsWith('eat_failed:')) {
    return reason;
  }
  if (CRAFT_OBJECTIVES.has(objective) && /^craft_[a-z0-9_]+_failed:/.test(reason)) {
    return reason;
  }
  if (TABLE_FAILURE_OBJECTIVES.has(objective)
    && (reason.startsWith('place_table_failed:') || reason.startsWith('retrieve_table_failed:'))) {
    return reason;
  }
  if (FURNACE_FAILURE_OBJECTIVES.has(objective) && reason.startsWith('place_furnace_failed:')) {
    return reason;
  }
  if (objective === 'MAKE_ARMOR' && reason.startsWith('equip_armor_failed:')) {
    return reason;
  }
  if (objective === 'SMELT_IRON' && reason.startsWith('smelt_raw_iron_failed:')) {
    return reason;
  }
  if (objective === 'SMELT_IRON' && reason.startsWith('make_charcoal_failed:')) {
    return reason;
  }
  return null;
}

// R0 (repeated-command-failure escalation). Some objectives have no objective-specific
// completed-failure handler, so a failed command is otherwise only caught by the slow stall timer.
// On wild terrain a fast-failing command (e.g. mine_nearby_stone's descent fallback hitting an
// unbridgeable gap -> no_safe_reroute) completes in well under a second; the objective re-dispatches,
// the bot micro-moves, and that movement resets the stall clock -- so the SAME command re-fires
// ~9x/s for the whole 10 s window (observed: 359 identical descent-fallback starts across 4 attempts
// before one no_progress fired). Detect K consecutive same-class completed failures and route them
// into the normal failure path immediately. This never removes the stall backstop: below the limit,
// control falls through to the existing achieved/stall checks.
const STREAK_FAILURE_OBJECTIVES = new Set(['GATHER_WOOD', 'MINE_STONE', 'SMELT_IRON']);

function streakCommandFailureForObjective(objective, raw) {
  if (raw?.currentCommandCompleted !== true) return null;
  if (!STREAK_FAILURE_OBJECTIVES.has(objective)) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  if (!reason) return null;
  // Only failure-shaped completions count toward the streak. A successful completion is handled by
  // objectiveAchieved; a clean executor-side abandonment ends in *_abandoned: and is also terminal.
  if (reason.includes('_failed:') || reason.includes('_abandoned:') || reason.endsWith('_failed')) {
    return reason;
  }
  return null;
}

// Coarse class key: collapse coordinates/indices so the SAME kind of failure at slightly different
// blocks still accumulates (support_missing at -6,82,-11 vs 32,42,5 -> one class).
function commandFailureClassKey(objective, reason) {
  return `${objective}:${reason.replace(/-?\d+/g, '#')}`;
}

function idleIntent(reason, ttlMs) {
  return { action: 'stop', ttlMs, reason: `mission:${reason}` };
}

const IRON_HEADINGS = Object.freeze([
  { name: 'north', dx: 0, dz: -1 },
  { name: 'east', dx: 1, dz: 0 },
  { name: 'south', dx: 0, dz: 1 },
  { name: 'west', dx: -1, dz: 0 },
]);

function ironHeadingFromYaw(yaw) {
  if (!Number.isFinite(yaw)) return IRON_HEADINGS[2];
  const normalized = ((yaw % 360) + 360) % 360;
  if (normalized >= 315 || normalized < 45) return IRON_HEADINGS[2];
  if (normalized < 135) return IRON_HEADINGS[3];
  if (normalized < 225) return IRON_HEADINGS[0];
  return IRON_HEADINGS[1];
}

function ironHeadingByName(name) {
  return IRON_HEADINGS.find((heading) => heading.name === name) || null;
}

function ensureIronSearchHeading(ms, raw) {
  if (!ironHeadingByName(ms.ironSearchPendingHeading)) {
    ms.ironSearchPendingHeading = ironHeadingFromYaw(raw?.yaw).name;
  }
  return ironHeadingByName(ms.ironSearchPendingHeading);
}

function rotateIronSearchHeading(ms, raw, signals, reason) {
  const current = ensureIronSearchHeading(ms, raw);
  ms.ironSearchTriedHeadings.add(current.name);
  const currentIndex = IRON_HEADINGS.findIndex((heading) => heading.name === current.name);
  let next = null;
  for (let offset = 1; offset < IRON_HEADINGS.length; offset += 1) {
    const candidate = IRON_HEADINGS[(currentIndex - offset + IRON_HEADINGS.length) % IRON_HEADINGS.length];
    if (!ms.ironSearchTriedHeadings.has(candidate.name)) {
      next = candidate;
      break;
    }
  }
  if (!next) {
    ms.ironSearchTriedHeadings.clear();
    ms.ironSearchTriedHeadings.add(current.name);
    next = IRON_HEADINGS[(currentIndex - 1 + IRON_HEADINGS.length) % IRON_HEADINGS.length];
  }
  ms.ironSearchPendingHeading = next.name;
  signals.push({
    evt: 'mission.iron_search.direction_rotated',
    from: current.name,
    to: next.name,
    reason,
    triedHeadings: [...ms.ironSearchTriedHeadings],
  });
  return next;
}

function withIronHeading(intent, raw, heading) {
  if (!intent || !heading || !Number.isFinite(raw?.x) || !Number.isFinite(raw?.z)) return intent;
  return {
    ...intent,
    targetX: Math.floor(raw.x) + heading.dx * 12,
    targetZ: Math.floor(raw.z) + heading.dz * 12,
  };
}

function ironSearchRecoveryIntent(raw, ttlMs, heading = null) {
  const s = summarizeStatePlus(raw);
  if (!s.atIronDepth || (s.stonePickaxes < 1 && s.ironPickaxes < 1)) {
    return null;
  }
  const intent = { action: 'descend_staircase', ttlMs, reason: 'mission:MINE_IRON_RECOVERY', objective: 'MINE_IRON_RECOVERY' };
  if (Number.isFinite(raw?.y)) {
    // IN-BAND recovery (o3 census, dry pockets x6 = the #1 fail class): the old floor (-48)
    // marched each retry 8 blocks deeper, OUT of the iron band (peak y~16, thin below -24) and
    // into half-speed deepslate — 5 of 6 exhausted runs ended prospecting at y=-1..-30. Recoveries
    // now stay in the band: a shallow reset-descend toward the peak; the real relocation is the
    // fresh MINE_IRON command's new prospect direction + full block budget.
    const y = Math.floor(raw.y);
    intent.targetY = Math.max(6, Math.min(y - 2, 16));
  }
  return withIronHeading(intent, raw, heading);
}

function descentRecoveryIntent(raw, ttlMs, objective) {
  const s = summarizeStatePlus(raw);
  const targetY = objective === 'DESCEND_DEEP' ? THRESHOLDS.diamondTargetY : THRESHOLDS.ironDepthY;
  if (objective === 'DESCEND_DEEP') {
    if (s.ironPickaxes < THRESHOLDS.ironPickaxesForDiamondDescent) return null;
  } else if (s.stonePickaxes < 1 && s.ironPickaxes < 1) {
    return null;
  }

  const intent = {
    action: 'descend_staircase',
    targetY,
    ttlMs,
    reason: `mission:${objective}_RECOVERY`,
    objective,
    recoveryObjective: `${objective}_RECOVERY`,
    trackObjective: objective,
  };
  const x = Number.isFinite(raw?.x) ? Math.floor(raw.x) : null;
  const y = Number.isFinite(raw?.y) ? Math.floor(raw.y) : null;
  const z = Number.isFinite(raw?.z) ? Math.floor(raw.z) : null;
  if (x !== null && y !== null && z !== null && y > targetY) {
    const depth = Math.max(1, y - targetY);
    if (yawHeadingAxis(raw?.yaw) === 'x') {
      intent.targetX = x;
      intent.targetZ = z + depth;
    } else {
      intent.targetX = x + depth;
      intent.targetZ = z;
    }
  }
  return intent;
}

function isDeadColumnDescentFailure(reason) {
  return typeof reason === 'string'
    && (reason.includes('no_safe_reroute') || reason.includes('descent_next_support_missing'));
}

// A fresh column `blocks` away in a rotating compass direction (S, E, N, W per attempt).
function relocateTargetFor(snapshot, attempt, blocks) {
  const x = Number.isFinite(snapshot?.x) ? Math.floor(snapshot.x) : 0;
  const z = Number.isFinite(snapshot?.z) ? Math.floor(snapshot.z) : 0;
  const dirs = [[0, blocks], [blocks, 0], [0, -blocks], [-blocks, 0]];
  const [dx, dz] = dirs[((attempt % 4) + 4) % 4];
  return { targetX: x + dx, targetZ: z + dz };
}

function relocateNavIntent(relocate, ttlMs) {
  return {
    action: 'navigate_to_point',
    targetX: relocate.targetX,
    targetZ: relocate.targetZ,
    ttlMs,
    reason: `mission:${relocate.from}_RELOCATE`,
    objective: 'RELOCATE',
  };
}

const EXPLORE_LOCAL_TARGET_MIN_DISTANCE = 48;

function localWoodSearchExhausted(raw) {
  if (raw?.currentCommandCompleted !== true) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  if (reason.startsWith('gather_tree_complete:bounded_search_exhausted:')) return reason;
  if (/^gather_tree_(?:complete|failed):no_reachable_tree_logs(?:$|:)/.test(reason)) return reason;
  return null;
}

// the unreachable-wood pass: reachable-log work concluded with ZERO gathered (the substrate appends left_unreached
// only when inventoryDelta==0), i.e. the visible wood is terrain-UNREACHABLE. Unlike the
// search-exhausted reasons above, this fires EVEN when hasLocalWood is true, because the local
// wood is exactly what could not be reached. Two flavors carry that meaning: tree_exhausted (a
// tree was worked, every remaining log unreachable) and no_reachable_tree_logs (a live run canopy
// world: 26 logs visible, none ever reachable — the strongest case). collect_timeout stays
// excluded -- the tree WAS reachable and a drop collect failed (handled by the nav3d collect /
// blacklist, not a reason to leave); partial gathers complete with a positive delta and no
// suffix, so this can never fire on a working local gather.
function unreachableLocalWood(raw) {
  if (raw?.currentCommandCompleted !== true) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  return /^gather_tree_failed:(?:tree_exhausted|no_reachable_tree_logs):left_unreached=\d+/.test(reason)
    ? reason
    : null;
}

// Streak bookkeeping for the no-net-progress escalation: called at the GATHER_WOOD failure
// sites. A failure at the same-or-lower log count extends the streak; any gain restarts it.
function recordWoodNoProgressFailure(ms, raw) {
  const logs = Number(raw?.inventoryLogCount) || 0;
  if (ms.lastWoodFailureLogs !== null && logs <= ms.lastWoodFailureLogs) {
    ms.woodNoProgressFailures += 1;
  } else {
    ms.woodNoProgressFailures = 1;
  }
  ms.lastWoodFailureLogs = logs;
}

function hasLocalWood(raw) {
  return Array.isArray(raw?.nearbyLogs) && raw.nearbyLogs.length > 0;
}

function perceivedResource(raw, resource) {
  const far = raw?.farPerception;
  const resources = Array.isArray(far?.resources) ? far.resources : [];
  const summary = resources.find((candidate) => candidate?.resource === resource);
  if (summary) {
    return {
      targets: Array.isArray(summary.targets) ? summary.targets : [],
      directions: Array.isArray(summary.directions) ? summary.directions : [],
    };
  }
  // Compatibility seam for early fixtures and future substrate versions that expose wood flat.
  if (resource === 'wood') {
    return {
      targets: Array.isArray(far?.woodTargets) ? far.woodTargets : [],
      directions: Array.isArray(far?.directions) ? far.directions : [],
    };
  }
  return { targets: [], directions: [] };
}

function boundedVectorTarget(x, z, dx, dz, maxBlocks) {
  const distance = Math.hypot(dx, dz);
  if (!Number.isFinite(distance) || distance === 0) return null;
  const blocks = Math.min(distance, maxBlocks);
  return {
    targetX: x + (dx / distance) * blocks,
    targetZ: z + (dz / distance) * blocks,
  };
}

function roughnessBucket(avgRoughness) {
  if (!Number.isFinite(avgRoughness) || avgRoughness < 0) return 1;
  if (avgRoughness < 6) return 0;
  if (avgRoughness < 16) return 1;
  return 2;
}

function exploreDirectionKey(dx, dz) {
  return `${Math.sign(dx)},${Math.sign(dz)}`;
}

const EXPLORE_CLASS_RANK = { wood_bearing: 0, mixed: 1, unknown: 2, barren: 3 };

function exploreDirectionSort(left, right) {
  return left.rank - right.rank
    || left.roughBucket - right.roughBucket
    || right.resourceCount - left.resourceCount
    || right.woodBearingChunks - left.woodBearingChunks
    || left.barrenChunks - right.barrenChunks
    || left.scannedChunks - right.scannedChunks
    || left.index - right.index;
}

function chooseTerrainAwareDirection(directions, triedDirections) {
  const candidates = directions
    .filter((candidate) => !triedDirections.has(candidate.directionKey))
    .sort(exploreDirectionSort);
  const baseline = candidates[0];
  if (!baseline || baseline.roughBucket < 2) return baseline ?? null;
  return candidates
    .filter((candidate) => candidate.rank < EXPLORE_CLASS_RANK.barren
      && candidate.rank <= baseline.rank + 1
      && candidate.roughBucket < baseline.roughBucket)
    .sort((left, right) => left.roughBucket - right.roughBucket
      || left.rank - right.rank
      || exploreDirectionSort(left, right))[0] ?? baseline;
}

function chooseExploreLeg(raw, resource, legBlocks, arriveDist, triedDirections = new Set()) {
  const x = Number.isFinite(raw?.x) ? raw.x : null;
  const z = Number.isFinite(raw?.z) ? raw.z : null;
  if (x === null || z === null) return null;
  const perceived = perceivedResource(raw, resource);
  const directions = perceived.directions
    .map((direction, index) => {
      const dx = Number(direction?.dx);
      const dz = Number(direction?.dz);
      if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx === 0 && dz === 0)) return null;
      const biomeClass = typeof direction?.biomeClass === 'string' ? direction.biomeClass : 'unknown';
      return {
        dx,
        dz,
        biomeClass,
        rank: EXPLORE_CLASS_RANK[biomeClass] ?? EXPLORE_CLASS_RANK.unknown,
        roughBucket: roughnessBucket(Number(direction?.avgRoughness ?? -1)),
        avgRoughness: Number(direction?.avgRoughness ?? -1),
        resourceCount: Number(direction?.resourceCount ?? direction?.logCount ?? 0) || 0,
        woodBearingChunks: Number(direction?.woodBearingChunks ?? 0) || 0,
        barrenChunks: Number(direction?.barrenChunks ?? 0) || 0,
        scannedChunks: Number(direction?.scannedChunks ?? 0) || 0,
        directionKey: exploreDirectionKey(dx, dz),
        index,
      };
    })
    .filter(Boolean);
  const directionByKey = new Map(directions.map((direction) => [direction.directionKey, direction]));
  const direction = chooseTerrainAwareDirection(directions, triedDirections);
  const minTargetDistance = Math.max(arriveDist, EXPLORE_LOCAL_TARGET_MIN_DISTANCE);
  const targets = perceived.targets
    .map((target) => {
      const targetX = Number(target?.x ?? target?.targetX);
      const targetZ = Number(target?.z ?? target?.targetZ);
      const count = Number(target?.count ?? target?.logCount ?? 0);
      if (!Number.isFinite(targetX) || !Number.isFinite(targetZ) || count <= 0) return null;
      const distance = Math.hypot(targetX - x, targetZ - z);
      if (distance <= minTargetDistance) return null;
      const directionKey = exploreDirectionKey(targetX - x, targetZ - z);
      return {
        targetX,
        targetZ,
        distance,
        count,
        biomeClass: target?.biomeClass,
        directionKey,
        direction: directionByKey.get(directionKey),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance || right.count - left.count);
  const target = targets.find((candidate) => (
    !triedDirections.has(candidate.directionKey)
  ));
  const steerAroundTarget = target?.direction?.roughBucket === 2
    && direction
    && direction.directionKey !== target.directionKey
    && direction.rank <= target.direction.rank + 1
    && direction.roughBucket < target.direction.roughBucket;
  if (target && !steerAroundTarget) {
    return {
      ...boundedVectorTarget(x, z, target.targetX - x, target.targetZ - z, legBlocks),
      resource,
      source: 'target',
      biomeClass: target.biomeClass || 'unknown',
      perceivedTarget: [target.targetX, target.targetZ],
      directionKey: target.directionKey,
      avgRoughness: target.direction?.avgRoughness ?? -1,
      roughBucket: target.direction?.roughBucket ?? 1,
    };
  }
  if (!direction) return null;
  const directionTarget = boundedVectorTarget(x, z, direction.dx * legBlocks, direction.dz * legBlocks, legBlocks);
  return {
    ...directionTarget,
    resource,
    source: 'direction',
    biomeClass: direction.biomeClass,
    direction: [direction.dx, direction.dz],
    directionKey: direction.directionKey,
    avgRoughness: direction.avgRoughness,
    roughBucket: direction.roughBucket,
  };
}

function exploreHopTarget(raw, exploration, hopBlocks, now) {
  const x = Number.isFinite(raw?.x) ? raw.x : exploration.lastX;
  const z = Number.isFinite(raw?.z) ? raw.z : exploration.lastZ;
  const dx = exploration.targetX - x;
  const dz = exploration.targetZ - z;
  const distance = Math.hypot(dx, dz);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(distance) || distance === 0) return null;
  const blocks = Math.min(hopBlocks, distance);
  return {
    targetX: x + (dx / distance) * blocks,
    targetZ: z + (dz / distance) * blocks,
    startedAtMs: now,
  };
}

function startExploreLeg(raw, leg, legNumbers, hopBlocks, now) {
  const x = Number.isFinite(raw?.x) ? raw.x : 0;
  const z = Number.isFinite(raw?.z) ? raw.z : 0;
  const exploration = {
    ...leg,
    leg: legNumbers.totalLeg,
    epoch: legNumbers.epoch,
    epochLeg: legNumbers.epochLeg,
    totalLeg: legNumbers.totalLeg,
    distanceTravelled: 0,
    lastX: x,
    lastZ: z,
    consecutiveHopFailures: 0,
    hopsQueued: 1,
    startedAtMs: now,
  };
  exploration.hop = exploreHopTarget(raw, exploration, hopBlocks, now);
  return exploration;
}

function inventoryLogCount(raw) {
  const direct = Number(raw?.inventoryLogCount);
  return Number.isFinite(direct) ? direct : Math.max(0, Number(summarizeState(raw).logs) || 0);
}

function resetExplorePhase(ms, raw) {
  const logs = inventoryLogCount(raw);
  ms.exploration = null;
  ms.exploreEpoch = 1;
  ms.exploreEpochLegsUsed = 0;
  ms.exploreLegsUsed = 0;
  ms.exploreEpochProgressEarned = false;
  ms.exploreEpochEarnedReported = false;
  ms.exploreEpochEarnReasons = new Set();
  ms.explorePhaseBaselineLogs = logs;
  ms.exploreEpochStartLogs = logs;
  ms.exploreCapReported = false;
  ms.exploreTriedDirections = new Set();
}

function clearExplorePhase(ms) {
  ms.exploration = null;
  ms.exploreEpoch = 1;
  ms.exploreEpochLegsUsed = 0;
  ms.exploreLegsUsed = 0;
  ms.exploreEpochProgressEarned = false;
  ms.exploreEpochEarnedReported = false;
  ms.exploreEpochEarnReasons = new Set();
  ms.explorePhaseBaselineLogs = null;
  ms.exploreEpochStartLogs = null;
  ms.exploreCapReported = false;
  ms.exploreTriedDirections = new Set();
}

function earnExploreEpoch(ms, reason, raw, signals) {
  if (ms.exploreEpoch >= EXPLORE_EPOCH_LIMIT || ms.explorePhaseBaselineLogs === null) return;
  ms.exploreEpochEarnReasons.add(reason);
  ms.exploreEpochProgressEarned = true;
  if (ms.exploration) reportExploreEpochEarned(ms, raw, signals);
}

function reportExploreEpochEarned(ms, raw, signals) {
  if (!ms.exploreEpochProgressEarned || ms.exploreEpochEarnedReported) return;
  ms.exploreEpochEarnedReported = true;
  signals.push({
    evt: 'exploration.epoch.earned',
    reason: [...ms.exploreEpochEarnReasons][0],
    phaseBaselineLogs: ms.explorePhaseBaselineLogs,
    currentLogs: inventoryLogCount(raw),
    epoch: ms.exploreEpoch,
    totalLegs: ms.exploreLegsUsed,
  });
}

function renewExploreEpoch(ms, raw, signals, now) {
  const oldEpoch = ms.exploreEpoch;
  const previousEpochLegs = ms.exploreEpochLegsUsed;
  const previousEpochStartLogs = ms.exploreEpochStartLogs;
  const currentLogs = inventoryLogCount(raw);
  ms.exploreEpoch += 1;
  ms.exploreEpochLegsUsed = 0;
  ms.exploreEpochProgressEarned = false;
  ms.exploreEpochStartLogs = currentLogs;
  ms.exploreCapReported = false;
  ms.exploreTriedDirections = new Set();
  ms.objectiveProgressAtMs = now;
  ms.objectiveStartedAtMs = now;
  signals.push({
    evt: 'exploration.epoch.renewed',
    oldEpoch,
    newEpoch: ms.exploreEpoch,
    earningReasons: [...ms.exploreEpochEarnReasons],
    position: Number.isFinite(raw?.x) && Number.isFinite(raw?.z) ? [raw.x, raw.z] : null,
    previousEpochStartLogs,
    currentLogs,
    previousEpochLegs,
    totalLegs: ms.exploreLegsUsed,
  });
}

function exploreMetadata(exploration) {
  return {
    epoch: exploration.epoch,
    epochLeg: exploration.epochLeg,
    totalLeg: exploration.totalLeg,
  };
}

function exploreHopFailure(raw) {
  if (raw?.currentCommandCompleted !== true) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  if (reason.startsWith('target_rejected') || reason.startsWith('navigate_to_point_failed:')) return reason;
  return null;
}

function exploreNavIntent(exploration, ttlMs) {
  return {
    action: 'navigate_to_point',
    targetX: exploration.hop.targetX,
    targetZ: exploration.hop.targetZ,
    ttlMs,
    reason: `exploration:${exploration.resource}:leg_${exploration.leg}:hop_${exploration.hopsQueued}`,
    objective: 'EXPLORE',
  };
}

export class MissionOrchestrator {
  constructor(opts = {}) {
    this.complete = opts.complete; // injected (messages, opts) => Promise<string>
    this.model = opts.model;
    this.maxTokens = opts.maxTokens; // undefined -> planner default (2048)
    this.temperature = opts.temperature ?? 0;
    this.forceLlm = opts.forceLlm === true;
    this.oraclePrimary = opts.oraclePrimary !== false;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    // Stall/abort are TIME-based, not poll-count: a single in-world action (e.g. a craft) spans many
    // brain polls without changing inventory, so a poll-count stall would abandon a succeeding craft.
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 10000; // no progress on the active objective -> re-plan
    // observed: a treeless world kept GATHER_WOOD alive for the full 40-min run — endless search
    // marches register as progress, so the stall window never fires. An objective also has an
    // absolute wall clock; crossing it counts as a failure through the normal retry machinery.
    this.objectiveWallClockMs = opts.objectiveWallClockMs ?? 600_000;
    this.abortTimeoutMs = opts.abortTimeoutMs ?? 45000; // no progress at all (across re-plans) -> abort
    // 3 relocation attempts (was 1): the dominant observed failure family was the ARMOR phase
    // exhausting one iron pocket, relocating once, and aborting when the second pocket was also dry
    // (6 instances on 2026-06-09/10; iron-pickaxe runs were 5-for-5 once wood cleared). Same designed
    // recovery mechanics, just a larger search budget before surrendering; the wrapper duration caps
    // total run time regardless.
    this.ironSearchRecoveryLimit = opts.ironSearchRecoveryLimit ?? 3;
    this.descentRecoveryLimit = opts.descentRecoveryLimit ?? 1;
    // Run-14/15 fix: re-selecting a TERRAIN-LOCAL objective after a failure is NOT a frozen
    // mission — the executor is stateful (failed clusters/spots ignored; search/march/staircase
    // relocation engages on reissue), so these get a retry budget instead of the 1-strike
    // same-objective abort. Run 15 hit the 1-strike rule on MINE_STONE minutes after it was fixed
    // for GATHER_WOOD; the budget is now a map, not a special case. MINE_IRON/DESCEND keep their
    // dedicated recovery paths upstream.
    this.gatherRecoveryLimit = opts.gatherRecoveryLimit ?? 3;
    this.terrainRetryLimits = {
      GATHER_WOOD: this.gatherRecoveryLimit,
      MINE_STONE: opts.stoneRecoveryLimit ?? 3,
      // Fuel v2: a fuel-out smelt failure re-selects SMELT_IRON at depth (the action
      // layer mines coal); that recovery re-entry needs a retry budget or the 1-strike rule aborts.
      SMELT_IRON: opts.smeltRecoveryLimit ?? 2,
      // a live run: MAKE_FURNACE at depth failed ONCE on an environment-guarded placement (every alcove
      // candidate lava-adjacent) and the zero-retry rule aborted a run that had already crafted
      // the iron pickaxe. Placement objectives are spot-local exactly like the terrain ones — the
      // bot drifts between attempts and the world flows — so give the MAKE_* family a small
      // budget instead of one-strike.
      MAKE_FURNACE: 2,
      MAKE_IRON_TOOLS: 2,
      MAKE_STONE_TOOLS: 1,
      MAKE_WOOD_TOOLS: 1,
    };
    // R0: K consecutive same-class completed-command failures on a streak objective escalate into
    // the normal failure path before the 10 s stall (which micro-movement keeps resetting). 4 is
    // small enough to collapse the spin to well under a second, yet tolerant of a transient
    // double-fail that then succeeds.
    this.commandFailureStreakLimit = opts.commandFailureStreakLimit ?? 4;
    this.costGuard = opts.costGuard; // forwarded to the model call so the cost ceiling is enforced
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    // R0 dead-column relocate : MINE_STONE's descent fallback can pin on a void-edge column
    // (no_safe_reroute, depthReached=0) the executor cannot leave on its own. After the failure-streak
    // fires, walk the bot to a fresh column (rotating direction) before re-trying, bounded.
    this.mineRelocateLimit = opts.mineRelocateLimit ?? 3;
    this.mineRelocateBlocks = opts.mineRelocateBlocks ?? 10;
    this.mineRelocateArriveDist = opts.mineRelocateArriveDist ?? 2.5;
    this.mineRelocateTimeoutMs = opts.mineRelocateTimeoutMs ?? 15000;
    // Tier-1.2 find-and-travel: an internal deterministic objective, never a planner/LLM objective.
    this.exploreEnabled = opts.exploreEnabled === true;
    this.exploreLegBlocks = Number.isFinite(opts.exploreLegBlocks) && opts.exploreLegBlocks > 0
      ? opts.exploreLegBlocks
      : 160;
    this.exploreLegLimit = Number.isInteger(opts.exploreLegLimit) && opts.exploreLegLimit >= 0
      ? opts.exploreLegLimit
      : 4;
    this.exploreArriveDist = Number.isFinite(opts.exploreArriveDist) && opts.exploreArriveDist > 0
      ? opts.exploreArriveDist
      : 8;
    this.exploreHopBlocks = Number.isFinite(opts.exploreHopBlocks) && opts.exploreHopBlocks > 0
      ? opts.exploreHopBlocks
      : 12;
    // the dig-tolerance pass: a hop that is actively digging through a blocker (snapshot.navDigActive) gets this
    // wider stall budget instead of stallTimeoutMs, so a slow-but-productive tunnel can break through
    // before the brain rotates. The substrate's own no-route floor bounds a doomed dig first.
    this.exploreHopDigTimeoutMs = Number.isFinite(opts.exploreHopDigTimeoutMs) && opts.exploreHopDigTimeoutMs > 0
      ? opts.exploreHopDigTimeoutMs
      : 25000;
    this.state = {
      currentObjective: null,
      lastOutcome: 'none',
      lastKey: null,
      objectiveProgressAtMs: 0,
      objectiveStartedAtMs: 0,
      globalLastKey: null,
      globalProgressAtMs: 0,
      objectivesCompleted: [],
      objectiveFailures: {},
      pendingRecoveryIntent: null,
      ironSearchTriedHeadings: new Set(),
      ironSearchPendingHeading: null,
      lastIronPartialCompletionKey: null,
      relocate: null,
      mineStoneRelocations: 0,
      exploration: null,
      exploreEpoch: 1,
      exploreEpochLegsUsed: 0,
      exploreLegsUsed: 0,
      exploreEpochProgressEarned: false,
      exploreEpochEarnedReported: false,
      exploreEpochEarnReasons: new Set(),
      explorePhaseBaselineLogs: null,
      exploreEpochStartLogs: null,
      exploreCapReported: false,
      exploreTriedDirections: new Set(),
      replans: 0,
      retrieveTableSkipped: false,
      surfaceAnchor: null,
      done: false,
      terminalReason: null,
      terminalObjective: null,
      consecutiveFailureKey: null,
      consecutiveFailureCount: 0,
      // live runs no-net-progress escalation: log count at the last GATHER_WOOD failure and how
      // many consecutive failures gained nothing. A repeat zero-delta exhaustion fires EXPLORE
      // even with local wood present; any log gain or a fresh objective transition resets.
      lastWoodFailureLogs: null,
      woodNoProgressFailures: 0,
      woodExhaustLatch: false,
    };
  }

  // One control step against `snapshot` (sim state or ClientSnapshot).
  // Returns { intent, signals, objective, done, replanned, source }.
  async step(snapshot) {
    const signals = [];
    const ms = this.state;
    if (ms.done) {
      const reason = ms.terminalReason || 'done';
      const objective = ms.terminalObjective || 'DONE';
      return { intent: idleIntent(reason, this.ttlMs), signals, objective, done: true, replanned: false, source: reason };
    }

    const now = this.now();
    const key = progressKey(snapshot);

    // Surface anchor (depth-aware GATHER_WOOD, an observed regression/22 deaths): remember the last position
    // seen while NOT at iron depth, so a wood need that arises underground can target the surface
    // via return_staircase instead of searching for trees in a mine.
    const anchorY = Number.isFinite(snapshot?.y) ? Math.floor(snapshot.y) : null;
    const atDepthNow = snapshot?.atIronDepth === true
      || (snapshot?.atIronDepth === undefined && anchorY !== null && anchorY <= THRESHOLDS.ironDepthY);
    if (!atDepthNow
      && Number.isFinite(snapshot?.x)
      && anchorY !== null
      && Number.isFinite(snapshot?.z)) {
      ms.surfaceAnchor = { x: Math.floor(snapshot.x), y: anchorY, z: Math.floor(snapshot.z) };
    }

    if (missionComplete(snapshot)) {
      ms.done = true;
      ms.terminalReason = 'done';
      ms.terminalObjective = 'DONE';
      signals.push({ evt: 'mission.done', objectivesCompleted: ms.objectivesCompleted.length, reason: 'mission_complete_verified' });
      return { intent: idleIntent('done', this.ttlMs), signals, objective: 'DONE', done: true, replanned: false, source: 'oracle' };
    }

    // Initialize the progress clocks on the first observation.
    if (ms.globalLastKey === null) { ms.globalLastKey = key; ms.globalProgressAtMs = now; }
    if (ms.lastKey === null) { ms.lastKey = key; ms.objectiveProgressAtMs = now; }
    // Any inventory/position change = progress; reset the stall clocks.
    if (key !== ms.globalLastKey) { ms.globalLastKey = key; ms.globalProgressAtMs = now; }
    if (key !== ms.lastKey) { ms.lastKey = key; ms.objectiveProgressAtMs = now; }

    if (this.exploreEnabled
      && ms.currentObjective === 'GATHER_WOOD'
      && !objectiveAchieved('GATHER_WOOD', snapshot)
      && ms.explorePhaseBaselineLogs !== null
      && inventoryLogCount(snapshot) > ms.explorePhaseBaselineLogs) {
      earnExploreEpoch(ms, 'wood_gain', snapshot, signals);
    }

    // A completed local gather search is the exact handoff into Tier-1.2. Let that fresh terminal
    // observation queue EXPLORE even if the old GATHER_WOOD command consumed the global no-progress
    // window; otherwise the watchdog wins on the same snapshot before the handoff can run.
    // EXPLORE fires when GATHER_WOOD can make no local progress: either the bounded search for MORE
    // wood is exhausted AND there is no reachable local wood (the barren case -- hasLocalWood gates
    // it so we never leave gatherable local wood), OR the visible local tree was genuinely
    // UNREACHABLE (the unreachable-wood pass: tree_exhausted with zero gathered -> fire even with local wood present).
    if (snapshot?.currentCommandCompleted !== true) {
      ms.woodExhaustLatch = false;
    }
    let gatherExhaustion = null;
    if (ms.currentObjective === 'GATHER_WOOD'
      && this.exploreEnabled
      && !objectiveAchieved('GATHER_WOOD', snapshot)) {
      const exhaustedNow = localWoodSearchExhausted(snapshot);
      gatherExhaustion = unreachableLocalWood(snapshot)
        || (!hasLocalWood(snapshot) ? exhaustedNow : null);
      // No-net-progress escalation (a dominant live failure mode): a SINGLE search-exhausted
      // completion with local wood stays and gathers (the next attempt usually harvests it — the
      // semantics the mission-brain test encodes), but a REPEAT exhaustion with zero log gain
      // since the last one proves that wood is not actually gatherable from here; fire EXPLORE
      // even with local wood present instead of burning the remaining attempts. The latch counts
      // each completion once across the polls it stays visible in.
      if (!gatherExhaustion && exhaustedNow && !ms.woodExhaustLatch) {
        ms.woodExhaustLatch = true;
        const logsNow = Number(snapshot?.inventoryLogCount) || 0;
        const repeatNoProgress = ms.woodNoProgressFailures >= 1
          && ms.lastWoodFailureLogs !== null
          && logsNow <= ms.lastWoodFailureLogs;
        recordWoodNoProgressFailure(ms, snapshot);
        if (repeatNoProgress) {
          gatherExhaustion = exhaustedNow;
          signals.push({
            evt: 'exploration.no_net_progress_escalation',
            objective: 'GATHER_WOOD',
            attempts: ms.woodNoProgressFailures,
            logs: logsNow,
          });
        }
      }
    }

    // 0) Global watchdog — no progress AT ALL for abortTimeoutMs across any number of re-plans means
    // the mission is genuinely stuck. Abort rather than loop forever.
    if (!gatherExhaustion && now - ms.globalProgressAtMs >= this.abortTimeoutMs) {
      ms.done = true;
      ms.terminalReason = 'aborted';
      ms.terminalObjective = 'ABORTED';
      signals.push({ evt: 'mission.aborted', reason: 'no_global_progress', stuckMs: now - ms.globalProgressAtMs, objective: ms.currentObjective || null });
      return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
    }

    // EXPLORE travel is decomposed into bounded local hops. Position proves hop arrival and also
    // accumulates leg travel; executor rejection fails immediately instead of burning a stall window.
    if (ms.exploration) {
      const exploration = ms.exploration;
      const positioned = Number.isFinite(snapshot?.x) && Number.isFinite(snapshot?.z);
      if (positioned) {
        exploration.distanceTravelled += Math.hypot(snapshot.x - exploration.lastX, snapshot.z - exploration.lastZ);
        exploration.lastX = snapshot.x;
        exploration.lastZ = snapshot.z;
      }
      const dist = positioned
        ? Math.hypot(snapshot.x - exploration.targetX, snapshot.z - exploration.targetZ)
        : Infinity;
      const legComplete = exploration.distanceTravelled >= this.exploreLegBlocks || dist <= this.exploreArriveDist;
      if (hasLocalWood(snapshot) || legComplete) {
        signals.push({
          evt: hasLocalWood(snapshot) ? 'exploration.resource.detected' : 'exploration.leg.arrived',
          resource: exploration.resource,
          leg: exploration.leg,
          ...exploreMetadata(exploration),
          target: [exploration.targetX, exploration.targetZ],
          distance: dist,
          distanceTravelled: exploration.distanceTravelled,
        });
        if (!hasLocalWood(snapshot)) {
          ms.exploreTriedDirections.add(exploration.directionKey);
          earnExploreEpoch(ms, 'leg_arrival', snapshot, signals);
        }
        ms.exploration = null;
        ms.currentObjective = 'GATHER_WOOD';
        ms.objectiveProgressAtMs = now;
        ms.objectiveStartedAtMs = now;
        ms.lastOutcome = `exploration:${exploration.resource}:resume`;
      } else {
        const hopDist = positioned
          ? Math.hypot(snapshot.x - exploration.hop.targetX, snapshot.z - exploration.hop.targetZ)
          : Infinity;
        const rejected = exploreHopFailure(snapshot);
        // the dig-tolerance pass: a hop that is productively digging through a blocker barely moves, so the normal
        // stall clock would kill it. While the substrate reports navDigActive, widen the hop's stall
        // budget so the dig can break through. The substrate bounds a DOOMED dig itself (its no-route
        // floor abandons -> target_rejected_no_path -> rejected here), so this only protects a live
        // productive dig; the wider budget is a belt-and-suspenders cap for a dig that never resolves.
        const digActive = snapshot?.navDigActive === true;
        const hopStallBudget = digActive ? this.exploreHopDigTimeoutMs : this.stallTimeoutMs;
        const stalled = now - ms.objectiveProgressAtMs >= hopStallBudget;
        const hopArrived = hopDist <= Math.min(this.exploreArriveDist, 2.5);
        // Observable proof the dig-tolerance is doing work: the hop would have stalled on the normal
        // budget but is being kept alive because the substrate is productively digging through.
        if (digActive && !rejected && !hopArrived && now - ms.objectiveProgressAtMs >= this.stallTimeoutMs) {
          signals.push({
            evt: 'exploration.hop.digging',
            resource: exploration.resource,
            leg: exploration.leg,
            ...exploreMetadata(exploration),
            hop: exploration.hopsQueued,
            heldMs: now - ms.objectiveProgressAtMs,
          });
        }
        if (!rejected && !stalled && !hopArrived) {
          return {
            intent: exploreNavIntent(exploration, this.ttlMs),
            signals,
            objective: 'EXPLORE',
            done: false,
            replanned: false,
            source: 'exploration',
          };
        }

        if (hopArrived) {
          signals.push({
            evt: 'exploration.hop.arrived',
            resource: exploration.resource,
            leg: exploration.leg,
            ...exploreMetadata(exploration),
            hop: exploration.hopsQueued,
            target: [exploration.hop.targetX, exploration.hop.targetZ],
            distanceTravelled: exploration.distanceTravelled,
          });
          exploration.consecutiveHopFailures = 0;
        } else {
          exploration.consecutiveHopFailures += 1;
          signals.push({
            evt: 'exploration.hop.failed',
            resource: exploration.resource,
            leg: exploration.leg,
            ...exploreMetadata(exploration),
            hop: exploration.hopsQueued,
            target: [exploration.hop.targetX, exploration.hop.targetZ],
            reason: rejected || 'no_progress',
            consecutiveFailures: exploration.consecutiveHopFailures,
          });
        }

        if (exploration.consecutiveHopFailures < 2) {
          exploration.hopsQueued += 1;
          exploration.hop = exploreHopTarget(snapshot, exploration, this.exploreHopBlocks, now);
          ms.objectiveProgressAtMs = now;
          ms.globalProgressAtMs = now;
          signals.push({
            evt: 'exploration.hop.queued',
            resource: exploration.resource,
            leg: exploration.leg,
            ...exploreMetadata(exploration),
            hop: exploration.hopsQueued,
            target: [exploration.hop.targetX, exploration.hop.targetZ],
          });
          return {
            intent: exploreNavIntent(exploration, this.ttlMs), signals, objective: 'EXPLORE', done: false,
            replanned: false, restartCommand: true, source: 'exploration',
          };
        }

        signals.push({
          evt: 'exploration.leg.failed',
          resource: exploration.resource,
          leg: exploration.leg,
          ...exploreMetadata(exploration),
          target: [exploration.targetX, exploration.targetZ],
          reason: rejected ? 'hop_rejected' : 'no_progress',
        });
        ms.exploreTriedDirections.add(exploration.directionKey);
        ms.exploration = null;
        ms.currentObjective = 'GATHER_WOOD';
        ms.objectiveProgressAtMs = now;
        ms.objectiveStartedAtMs = now;
        ms.lastOutcome = `exploration:${exploration.resource}:leg_failed`;
        gatherExhaustion = exploration.gatherExhaustion;
      }
    }

    // R0 dead-column relocate: while a relocate walk is active, drive the bot toward the fresh column
    // and only resume the mining objective once it arrives (or the walk times out / cannot path).
    if (ms.relocate) {
      const r = ms.relocate;
      const dist = (Number.isFinite(snapshot?.x) && Number.isFinite(snapshot?.z))
        ? Math.hypot(snapshot.x - r.targetX, snapshot.z - r.targetZ)
        : Infinity;
      if (dist <= this.mineRelocateArriveDist) {
        signals.push({ evt: 'mission.relocate.arrived', from: r.from, attempt: r.attempt, target: [r.targetX, r.targetZ] });
        ms.relocate = null;
        ms.currentObjective = r.from;
        ms.objectiveProgressAtMs = now;
        ms.lastOutcome = `relocate:${r.from}:arrived`;
      } else if (now - r.startedAtMs >= this.mineRelocateTimeoutMs) {
        signals.push({ evt: 'mission.relocate.leg_failed', from: r.from, attempt: r.attempt, reason: 'timeout' });
        ms.relocate = null;
        ms.currentObjective = r.from;
        ms.objectiveProgressAtMs = now;
        ms.lastOutcome = `relocate:${r.from}:leg_failed`;
      } else {
        return { intent: relocateNavIntent(r, this.ttlMs), signals, objective: 'RELOCATE', done: false, replanned: false, source: 'relocate' };
      }
    }

    // Trigger only after the existing local gather-tree executor explicitly reports exhaustion and
    // the reachable local snapshot is empty. Before the cap, queue one cardinal/dominant-axis leg so
    // direction, preserving the scanner's octant as a chain of local hops. At the cap (or
    // with no usable perception), feed the failure into today's normal gather retry/abandon path.
    if (gatherExhaustion) {
      reportExploreEpochEarned(ms, snapshot, signals);
      let leg = ms.exploreEpochLegsUsed < this.exploreLegLimit
        ? chooseExploreLeg(snapshot, 'wood', this.exploreLegBlocks, this.exploreArriveDist, ms.exploreTriedDirections)
        : null;
      if (!leg && ms.exploreEpochProgressEarned && ms.exploreEpoch < EXPLORE_EPOCH_LIMIT) {
        renewExploreEpoch(ms, snapshot, signals, now);
        leg = chooseExploreLeg(snapshot, 'wood', this.exploreLegBlocks, this.exploreArriveDist, ms.exploreTriedDirections);
      }
      if (leg) {
        const rotatedFrom = ms.exploration === null && ms.exploreTriedDirections.size > 0
          ? [...ms.exploreTriedDirections].at(-1)
          : null;
        ms.exploreLegsUsed += 1;
        ms.exploreEpochLegsUsed += 1;
        ms.exploration = startExploreLeg(snapshot, { ...leg, gatherExhaustion }, {
          epoch: ms.exploreEpoch,
          epochLeg: ms.exploreEpochLegsUsed,
          totalLeg: ms.exploreLegsUsed,
        }, this.exploreHopBlocks, now);
        ms.objectiveProgressAtMs = now;
        ms.globalProgressAtMs = now;
        if (rotatedFrom) {
          signals.push({
            evt: 'exploration.direction.rotated',
            resource: leg.resource,
            from: rotatedFrom,
            to: leg.directionKey,
            tried: [...ms.exploreTriedDirections],
            ...exploreMetadata(ms.exploration),
          });
        }
        signals.push({
          evt: 'exploration.leg.queued',
          resource: leg.resource,
          leg: ms.exploreLegsUsed,
          ...exploreMetadata(ms.exploration),
          limit: this.exploreLegLimit,
          source: leg.source,
          biomeClass: leg.biomeClass,
          target: [leg.targetX, leg.targetZ],
          direction: leg.directionKey,
          avgRoughness: leg.avgRoughness,
          roughBucket: leg.roughBucket,
        });
        if (leg.source === 'target') {
          signals.push({
            evt: 'exploration.resource.detected',
            resource: leg.resource,
            leg: ms.exploreLegsUsed,
            ...exploreMetadata(ms.exploration),
            perceivedTarget: leg.perceivedTarget,
          });
        }
        signals.push({
          evt: 'exploration.hop.queued',
          resource: leg.resource,
          leg: ms.exploreLegsUsed,
          ...exploreMetadata(ms.exploration),
          hop: 1,
          target: [ms.exploration.hop.targetX, ms.exploration.hop.targetZ],
        });
        return {
          intent: exploreNavIntent(ms.exploration, this.ttlMs),
          signals,
          objective: 'EXPLORE',
          done: false,
          replanned: false,
          restartCommand: rotatedFrom !== null,
          source: 'exploration',
        };
      }

      if (!ms.exploreCapReported) {
        ms.exploreCapReported = true;
        signals.push({
          evt: 'exploration.exhausted',
          resource: 'wood',
          legs: ms.exploreLegsUsed,
          limit: this.exploreLegLimit,
          reason: ms.exploreEpochLegsUsed >= this.exploreLegLimit ? 'leg_limit' : 'no_candidate',
          epochsUsed: ms.exploreEpoch,
          epochLimit: EXPLORE_EPOCH_LIMIT,
          totalLegs: ms.exploreLegsUsed,
          totalLimit: this.exploreLegLimit * EXPLORE_EPOCH_LIMIT,
        });
      }
      signals.push({ evt: 'mission.objective.failed', objective: 'GATHER_WOOD', reason: gatherExhaustion });
      ms.objectiveFailures.GATHER_WOOD = (ms.objectiveFailures.GATHER_WOOD || 0) + 1;
      ms.lastOutcome = `failed:GATHER_WOOD:${gatherExhaustion}`;
      ms.currentObjective = null;
    }

    // 1) Resolve the active objective: complete? or stalled (no progress for stallTimeoutMs — long
    // enough that a multi-poll in-world craft is NOT mistaken for a stall)?
    if (ms.currentObjective) {
      const completionReason = typeof snapshot?.currentCommandCompletionReason === 'string'
        ? snapshot.currentCommandCompletionReason
        : '';
      const partialKey = `${snapshot?.currentCommandId || ''}:${completionReason}`;
      if (ms.currentObjective === 'MINE_IRON'
        && completionReason === 'mine_nearby_iron_complete:partial_raw_iron_delta'
        && partialKey !== ms.lastIronPartialCompletionKey) {
        ms.lastIronPartialCompletionKey = partialKey;
        ms.objectiveFailures.MINE_IRON = 0;
        ms.consecutiveFailureKey = null;
        ms.consecutiveFailureCount = 0;
        ms.objectiveProgressAtMs = now;
        ms.objectiveStartedAtMs = now;
        const heading = rotateIronSearchHeading(ms, snapshot, signals, 'partial_progress');
        signals.push({
          evt: 'mission.iron_search.partial_progress',
          objective: 'MINE_IRON',
          heading: heading.name,
          rawIron: summarizeStatePlus(snapshot).rawIron,
          reason: 'partial_raw_iron_delta',
        });
        const partialIntent = withIronHeading(
          { action: 'mine_nearby_iron', ttlMs: this.ttlMs, reason: 'mission:MINE_IRON', objective: 'MINE_IRON' },
          snapshot,
          heading,
        );
        return { intent: partialIntent, signals, objective: 'MINE_IRON', done: false, replanned: false, source: 'partial_progress' };
      }
      const terminalFailure = terminalCommandFailureForObjective(ms.currentObjective, snapshot);
      if (terminalFailure) {
        signals.push({ evt: 'mission.objective.failed', objective: ms.currentObjective, reason: terminalFailure });
        ms.objectiveFailures[ms.currentObjective] = (ms.objectiveFailures[ms.currentObjective] || 0) + 1;
        if (ms.currentObjective === 'DESCEND' || ms.currentObjective === 'DESCEND_DEEP') {
          const recoveryCount = ms.objectiveFailures[ms.currentObjective];
          const recoveryBlockReason = descentRecoveryBlockReason(terminalFailure, snapshot);
          const recovery = recoveryBlockReason === null && recoveryCount <= this.descentRecoveryLimit
            ? descentRecoveryIntent(snapshot, this.ttlMs, ms.currentObjective)
            : null;
          if (recovery) {
            ms.pendingRecoveryIntent = recovery;
            signals.push({
              evt: 'mission.objective.recovery_queued',
              objective: ms.currentObjective,
              action: recovery.action,
              reason: 'descent_relocate',
              attempt: recoveryCount,
            });
            ms.lastOutcome = `failed:${ms.currentObjective}:${terminalFailure}`;
            ms.currentObjective = null;
          } else {
            return abortUnsafeDescent(
              ms,
              signals,
              ms.currentObjective,
              recoveryCount > this.descentRecoveryLimit
                ? 'recovery_limit_reached'
                : (recoveryBlockReason || 'no_recovery_available'),
              terminalFailure,
              recoveryCount,
              this.ttlMs,
            );
          }
        } else {
          ms.lastOutcome = `failed:${ms.currentObjective}:${terminalFailure}`;
          ms.done = true;
          ms.terminalReason = 'aborted';
          ms.terminalObjective = 'ABORTED';
          signals.push({
            evt: 'mission.aborted',
            reason: 'terminal_command_failure',
            objective: ms.currentObjective,
            detail: terminalFailure,
            attempts: ms.objectiveFailures[ms.currentObjective],
          });
          ms.currentObjective = null;
          return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
        }
      }
      if (ms.currentObjective === 'DESCEND' || ms.currentObjective === 'DESCEND_DEEP') {
        const stateBlockReason = currentDescentStateBlockReason(snapshot);
        if (stateBlockReason) {
          signals.push({ evt: 'mission.objective.failed', objective: ms.currentObjective, reason: stateBlockReason });
          ms.objectiveFailures[ms.currentObjective] = (ms.objectiveFailures[ms.currentObjective] || 0) + 1;
          return abortUnsafeDescent(
            ms,
            signals,
            ms.currentObjective,
            stateBlockReason,
            `current_state:${stateBlockReason}`,
            ms.objectiveFailures[ms.currentObjective],
            this.ttlMs,
          );
        }
      }
      // R0: escalate K consecutive same-class fast-failing completions before the slow stall fires.
      // Below the limit, control falls through to the existing achieved/stall checks (backstop kept).
      const streakFailure = streakCommandFailureForObjective(ms.currentObjective, snapshot);
      let escalatedRepeated = false;
      if (streakFailure) {
        const fkey = commandFailureClassKey(ms.currentObjective, streakFailure);
        if (fkey === ms.consecutiveFailureKey) {
          ms.consecutiveFailureCount += 1;
        } else {
          ms.consecutiveFailureKey = fkey;
          ms.consecutiveFailureCount = 1;
        }
        if (ms.consecutiveFailureCount >= this.commandFailureStreakLimit) {
          const failedObjective = ms.currentObjective;
          signals.push({
            evt: 'mission.objective.failed',
            objective: ms.currentObjective,
            reason: 'repeated_command_failure',
            detail: streakFailure,
            streak: ms.consecutiveFailureCount,
          });
          ms.objectiveFailures[ms.currentObjective] = (ms.objectiveFailures[ms.currentObjective] || 0) + 1;
          ms.consecutiveFailureKey = null;
          ms.consecutiveFailureCount = 0;
          ms.lastOutcome = `failed:${ms.currentObjective}:${streakFailure}`;
          ms.currentObjective = null;
          escalatedRepeated = true;
          // R0 dead-column relocate: MINE_STONE pinned on a void-edge descent column the executor
          // cannot leave -- walk to a fresh column (rotating dir) before re-trying, bounded.
          if (failedObjective === 'MINE_STONE'
            && isDeadColumnDescentFailure(streakFailure)
            && ms.mineStoneRelocations < this.mineRelocateLimit) {
            const target = relocateTargetFor(snapshot, ms.mineStoneRelocations, this.mineRelocateBlocks);
            ms.relocate = { ...target, from: 'MINE_STONE', attempt: ms.mineStoneRelocations, startedAtMs: now };
            ms.mineStoneRelocations += 1;
            signals.push({ evt: 'mission.relocate.queued', from: 'MINE_STONE', attempt: ms.relocate.attempt, target: [target.targetX, target.targetZ] });
            return { intent: relocateNavIntent(ms.relocate, this.ttlMs), signals, objective: 'RELOCATE', done: false, replanned: false, source: 'relocate' };
          }
        }
      } else {
        ms.consecutiveFailureKey = null;
        ms.consecutiveFailureCount = 0;
      }
      if (!escalatedRepeated) {
      const completedFailure = completedCommandFailureForObjective(ms.currentObjective, snapshot);
      if (completedFailure) {
        signals.push({ evt: 'mission.objective.failed', objective: ms.currentObjective, reason: completedFailure });
        ms.objectiveFailures[ms.currentObjective] = (ms.objectiveFailures[ms.currentObjective] || 0) + 1;
        if (ms.currentObjective === 'MINE_IRON') {
          const recoveryCount = ms.objectiveFailures[ms.currentObjective];
          if (completedFailure.includes('mine_nearby_iron_search_epoch_exhausted')) {
            ms.done = true;
            ms.terminalReason = 'aborted';
            ms.terminalObjective = 'ABORTED';
            signals.push({ evt: 'mission.objective.exhausted', objective: 'MINE_IRON', reason: 'search_epoch_budget', attempts: recoveryCount });
            signals.push({ evt: 'mission.aborted', reason: 'iron_search_exhausted', objective: 'MINE_IRON', attempts: recoveryCount });
            return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
          }
          const heading = rotateIronSearchHeading(ms, snapshot, signals, 'zero_gain');
          const recovery = recoveryCount <= this.ironSearchRecoveryLimit
            ? ironSearchRecoveryIntent(snapshot, this.ttlMs, heading)
            : null;
          if (recovery) {
            ms.pendingRecoveryIntent = recovery;
            signals.push({ evt: 'mission.objective.recovery_queued', objective: 'MINE_IRON', action: recovery.action, reason: 'iron_search_relocate', attempt: recoveryCount });
          } else {
            ms.done = true;
            ms.terminalReason = 'aborted';
            ms.terminalObjective = 'ABORTED';
            signals.push({ evt: 'mission.objective.exhausted', objective: 'MINE_IRON', reason: recoveryCount > this.ironSearchRecoveryLimit ? 'recovery_limit_reached' : 'no_recovery_available', attempts: recoveryCount });
            signals.push({ evt: 'mission.aborted', reason: 'iron_search_exhausted', objective: 'MINE_IRON', attempts: recoveryCount });
            return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
          }
        }
        ms.lastOutcome = `failed:${ms.currentObjective}:${completedFailure}`;
        ms.currentObjective = null;
      } else if (objectiveAchieved(ms.currentObjective, snapshot)) {
        signals.push({ evt: 'mission.objective.complete', objective: ms.currentObjective });
        ms.objectivesCompleted.push(ms.currentObjective);
        ms.objectiveFailures[ms.currentObjective] = 0;
        if (ms.currentObjective === 'MINE_STONE') ms.mineStoneRelocations = 0;
        if (ms.currentObjective === 'MINE_IRON') {
          ms.ironSearchTriedHeadings.clear();
          ms.ironSearchPendingHeading = null;
          ms.lastIronPartialCompletionKey = null;
        }
        if (ms.currentObjective === 'GATHER_WOOD') {
          clearExplorePhase(ms);
        }
        ms.lastOutcome = `done:${ms.currentObjective}`;
        ms.currentObjective = null;
      } else if (
        now - ms.objectiveProgressAtMs >= this.stallTimeoutMs
        || (ms.objectiveStartedAtMs > 0 && now - ms.objectiveStartedAtMs >= this.objectiveWallClockMs)
      ) {
        const wallClocked = ms.objectiveStartedAtMs > 0 && now - ms.objectiveStartedAtMs >= this.objectiveWallClockMs;
        signals.push({ evt: 'mission.objective.failed', objective: ms.currentObjective, reason: wallClocked ? 'wall_clock' : 'no_progress' });
        ms.objectiveFailures[ms.currentObjective] = (ms.objectiveFailures[ms.currentObjective] || 0) + 1;
        if (ms.currentObjective === 'MINE_IRON') {
          const recoveryCount = ms.objectiveFailures[ms.currentObjective];
          const heading = rotateIronSearchHeading(ms, snapshot, signals, wallClocked ? 'wall_clock' : 'no_progress');
          const recovery = recoveryCount <= this.ironSearchRecoveryLimit
            ? ironSearchRecoveryIntent(snapshot, this.ttlMs, heading)
            : null;
          if (recovery) {
            ms.pendingRecoveryIntent = recovery;
            signals.push({ evt: 'mission.objective.recovery_queued', objective: 'MINE_IRON', action: recovery.action, reason: 'iron_search_relocate', attempt: recoveryCount });
          } else {
            ms.done = true;
            ms.terminalReason = 'aborted';
            ms.terminalObjective = 'ABORTED';
            signals.push({ evt: 'mission.objective.exhausted', objective: 'MINE_IRON', reason: recoveryCount > this.ironSearchRecoveryLimit ? 'recovery_limit_reached' : 'no_recovery_available', attempts: recoveryCount });
            signals.push({ evt: 'mission.aborted', reason: 'iron_search_exhausted', objective: 'MINE_IRON', attempts: recoveryCount });
            return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
          }
        }
        ms.lastOutcome = `failed:${ms.currentObjective}:no_progress`;
        ms.currentObjective = null;
      }
      }
    }

    if (!ms.currentObjective && ms.pendingRecoveryIntent) {
      const recovery = ms.pendingRecoveryIntent;
      ms.pendingRecoveryIntent = null;
      const recoveryObjective = recovery.recoveryObjective || recovery.objective || 'RECOVERY';
      const recoveryFrom = recoveryObjective.endsWith('_RECOVERY')
        ? recoveryObjective.slice(0, -'_RECOVERY'.length)
        : recoveryObjective;
      const trackObjective = recovery.trackObjective || null;
      const intent = { ...recovery };
      delete intent.recoveryObjective;
      delete intent.trackObjective;
      ms.lastOutcome = `recovery:${recoveryFrom}:relocate`;
      ms.objectiveProgressAtMs = now;
      if (trackObjective) ms.currentObjective = trackObjective;
      return { intent, signals, objective: recoveryObjective, done: false, replanned: false, source: 'recovery' };
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
        forceLlm: this.forceLlm,
        oraclePrimary: this.oraclePrimary,
        currentObjective: fromObj,
        lastOutcome: ms.lastOutcome,
      });
      replanned = true;
      source = decision.source;

      if ((decision.done || decision.objective === 'DONE') && missionComplete(snapshot)) {
        ms.done = true;
        ms.terminalReason = 'done';
        ms.terminalObjective = 'DONE';
        signals.push({ evt: 'mission.done', objectivesCompleted: ms.objectivesCompleted.length });
        return { intent: idleIntent('done', this.ttlMs), signals, objective: 'DONE', done: true, replanned, source };
      }
      if (decision.done || decision.objective === 'DONE') {
        signals.push({ evt: 'mission.done.rejected', reason: 'mission_incomplete', source });
        decision.objective = expectedObjective(snapshot);
      }

      const sameObjectiveAttempts = fromObj ? (ms.objectiveFailures[fromObj] || 0) : 0;
      // Terrain-local failures are spot-local on wild terrain: the executor already ignored the
      // dead cluster/spot, so a reissue does NEW work (different seed / search / march / staircase
      // site). Budgeted retry per the map; every other objective keeps frozen-mission semantics.
      const sameObjectiveRetryLimit = this.terrainRetryLimits[decision.objective] ?? 0;
      const repeatedFailedObjective = wasRecovery
        && fromObj
        && fromObj === decision.objective
        && sameObjectiveAttempts > sameObjectiveRetryLimit;
      if (wasRecovery && fromObj && fromObj === decision.objective
        && sameObjectiveAttempts > 0 && !repeatedFailedObjective) {
        signals.push({
          evt: 'mission.objective.recovery_queued',
          objective: fromObj,
          action: 'reissue',
          reason: 'wild_terrain_retry',
          attempt: sameObjectiveAttempts,
        });
      }
      if (repeatedFailedObjective) {
        const attempts = sameObjectiveAttempts;
        ms.done = true;
        ms.terminalReason = 'aborted';
        ms.terminalObjective = 'ABORTED';
        ms.currentObjective = null;
        signals.push({
          evt: 'mission.objective.exhausted',
          objective: fromObj,
          reason: 'same_objective_reselected',
          attempts,
        });
        signals.push({
          evt: 'mission.aborted',
          reason: 'objective_exhausted',
          objective: fromObj,
          attempts,
        });
        return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned, source: 'aborted' };
      }

      signals.push({ evt: 'mission.objective.chosen', objective: decision.objective, source: decision.source, reason: decision.reason });
      if (wasRecovery && fromObj && fromObj !== decision.objective) {
        signals.push({ evt: 'mission.replan', from: fromObj, to: decision.objective });
        ms.replans += 1;
      }
      ms.currentObjective = decision.objective;
      if (decision.objective === 'MINE_IRON') {
        ensureIronSearchHeading(ms, snapshot);
      }
      ms.objectiveProgressAtMs = now; // give the new objective a fresh stall window
      ms.objectiveStartedAtMs = now; // wall-clock cap baseline
      if (decision.objective !== fromObj) {
        ms.lastWoodFailureLogs = null;
        ms.woodNoProgressFailures = 0;
        // A FRESH wood phase (repro: wood -> tools -> stone -> wood again after crafting consumed
        // the logs) deserves a fresh exploration budget: the per-mission leg cap spent in an
        // earlier phase otherwise leaves later phases with EXPLORE structurally unavailable, and
        // the exhaustion->retry loop burns straight to objective_exhausted. Reissues of the SAME
        // phase keep one budget (fromObj === decision.objective skips this), so the cap still
        // bounds any single phase.
        if (decision.objective === 'GATHER_WOOD') {
          resetExplorePhase(ms, snapshot);
        }
      }
    }

    // 3) Map the active objective -> next low-level action (deterministic "how").
    // Latch the executor's retrieve_table "skipped" completion (table ray-occluded; replacement
    // materials in hand) so the sequencer never re-demands that retrieval — set-once per mission,
    // because the skip's premise (a fresh table is cheaper) does not expire. A live run
    // aborted DESCEND in exactly this skip->reissue loop.
    if (!ms.retrieveTableSkipped
      && snapshot?.currentCommandCompleted === true
      && typeof snapshot?.currentCommandCompletionReason === 'string'
      && snapshot.currentCommandCompletionReason.startsWith('retrieve_table_complete:skipped')) {
      ms.retrieveTableSkipped = true;
      signals.push({ evt: 'mission.retrieve_table_skip_latched' });
    }
    const actionPlan = nextActionForObjective(ms.currentObjective, snapshot, {
      retrieveTableSkipped: ms.retrieveTableSkipped,
      surfaceAnchor: ms.surfaceAnchor,
    });
    if (actionPlan === null) {
      signals.push({ evt: 'mission.objective.blocked', objective: ms.currentObjective, reason: 'missing_inputs' });
      ms.lastOutcome = `blocked:${ms.currentObjective}:missing_inputs`;
      ms.currentObjective = null;
      return { intent: idleIntent('replan', this.ttlMs), signals, objective: null, done: false, replanned, source };
    }
    let intentFields = typeof actionPlan === 'string' ? { action: actionPlan } : actionPlan;
    if (ms.currentObjective === 'MINE_IRON' && intentFields.action === 'mine_nearby_iron') {
      intentFields = withIronHeading(intentFields, snapshot, ensureIronSearchHeading(ms, snapshot));
    }
    const ttlMs = intentFields.ttlMs ?? this.ttlMs;

    return {
      intent: { ...intentFields, ttlMs, reason: `mission:${ms.currentObjective}`, objective: ms.currentObjective },
      signals,
      objective: ms.currentObjective,
      done: false,
      replanned,
      source,
    };
  }
}
