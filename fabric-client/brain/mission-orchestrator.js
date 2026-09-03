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
  ironAcquisitionToolBudget,
  missionComplete,
  miningManifestStatus,
  objectiveAchieved,
  rawIronFuelAdmission,
  rawIronFuelFingerprint,
  stoneCompletionRequirement,
  summarizeState,
  woodCompletionRequirement,
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
  const missing = IRON_ARMOR_PIECES.filter((piece) => raw?.[piece.slot] !== piece.item);
  const selected = missing.find((piece) => (summary[piece.count] || 0) > 0)
    || missing[0]
    || null;
  return selected
    ? { ...selected, hasSpare: (summary[selected.count] || 0) > 0 }
    : null;
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
      // Depth-aware (the underground-wood death class): wood does not exist underground. Whatever
      // selector gate landed here (sticks, planks, table materials — fuel routes via SMELT_IRON),
      // surface FIRST through the return machinery (breadcrumb trail or 3-D nav fallback), then
      // gather. Falls back to the old behavior when no surface anchor is known.
      const anchor = opts.surfaceAnchor;
      const surfaceReturnRequested = opts.surfaceReturnPending === true
        || (opts.surfaceReturnPending === undefined && s.atIronDepth);
      if (surfaceReturnRequested
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
      const requirement = woodCompletionRequirement(s);
      return {
        action: 'gather_tree',
        ttlMs: LONG_WORLD_ACTION_TTL_MS,
        completionInventoryLogCount: requirement.inventoryLogCount,
        completionInventoryPlankCount: requirement.inventoryPlankCount,
      };
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
        ? {
          action: 'mine_nearby_stone',
          ttlMs: LONG_WORLD_ACTION_TTL_MS,
          completionInventoryCobblestoneCount: stoneCompletionRequirement(s),
        }
        : null;
    case 'MAKE_STONE_TOOLS': {
      if (s.stonePickaxes >= 1 && (s.targetIronPickaxeOnly || s.stoneSwords >= 1)) {
        if (!needsStonePickaxeCraftForIronPhase(s)) {
          return s.tablePlaced && s.craftingTables < 1 && allowRetrieveTable ? 'retrieve_table' : null;
        }
      }
      if (s.sticks < 2) return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
      if (!s.tablePlaced && !miningWorkspaceUsable(s)) return tableSetupAction(s);
      if (s.stonePickaxes < 1 || needsStonePickaxeCraftForIronPhase(s)) {
        return s.cobblestone >= 3 ? 'craft_stone_pickaxe' : null;
      }
      if (s.targetIronPickaxeOnly) return null;
      if (s.stoneSwords < 1) return s.cobblestone >= 2 ? 'craft_stone_sword' : null;
      return null;
    }
    case 'MAKE_FURNACE': {
      if (miningWorkspaceUsable(s)) return null;
      if (s.furnaces >= 1 || s.furnacePlaced) return s.furnacePlaced ? null : 'place_furnace';
      if (!s.tablePlaced) return tableSetupAction(s); // furnace is a 3x3 craft -> needs a table
      return s.cobblestone >= 8 ? 'craft_furnace' : null;
    }
    case 'DESCEND':
      if (s.atIronDepth) return null;
      if (s.stonePickaxes < 1 && s.ironPickaxes < 1) return null;
      if (s.ironPickaxes < 1) {
        const manifest = miningManifestStatus(raw);
        if (s.craftingTables < 1 && !s.tablePlaced) {
          if (s.planks >= 4) return 'craft_table';
          if (s.logs >= 1) return 'craft_planks';
          return null;
        }
        if (manifest.availableDurability < manifest.requiredDurability) {
          if (s.sticks < manifest.requiredSticksForDurability) {
            return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
          }
          if (s.cobblestone < manifest.requiredCobblestoneForDurability) return null;
          if (!s.tablePlaced) return tableSetupAction(s);
          return 'craft_stone_pickaxe';
        }
        if (s.sticks < THRESHOLDS.miningFieldKitSticks) {
          return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
        }
        if (s.cobblestone < THRESHOLDS.miningFieldKitCobblestone) return null;
        if (s.craftingTables < 1) {
          if (s.tablePlaced && allowRetrieveTable) return 'retrieve_table';
          if (s.planks >= 4) return 'craft_table';
          if (s.logs >= 1) return 'craft_planks';
          return null;
        }
      }
      return descentToIronPlan(raw);
    case 'MINE_IRON': {
      if (!s.atIronDepth) return null;
      const budget = ironAcquisitionToolBudget(raw);
      if (!budget.laneReady) return missionIronToolPreparationAction(s, budget);
      if (s.stonePickaxes < 1 && s.ironPickaxes < 1) return null;
      return { action: 'mine_nearby_iron', ttlMs: LONG_WORLD_ACTION_TTL_MS };
    }
    case 'SMELT_IRON': {
      if (!s.furnacePlaced && !miningWorkspaceUsable(s)) {
        if (s.furnaces >= 1) return 'place_furnace'; // place a carried furnace right here (no trip up)
        if (!s.tablePlaced) return tableSetupAction(s); // a furnace is a 3x3 craft -> needs a table
        return s.cobblestone >= 8 ? 'craft_furnace' : null;
      }
      if (needsIronToolStickReserve(s)) {
        if (s.planks >= planksNeededForStickReserveAndNextSmelt(s)) return 'craft_sticks';
        if (s.logs >= 1) return 'craft_planks';
      }
      const loadedRawBatch = Math.max(0, Math.floor(Number(opts.smeltLoadedRawBatch) || 0));
      const rawAvailableForSmelt = Math.max(s.rawIron, loadedRawBatch);
      const fuelAdmission = rawIronFuelAdmission(
        loadedRawBatch > 0 ? { ...s, rawIron: rawAvailableForSmelt } : s,
      );
      const fuelFingerprint = rawIronFuelFingerprint(s);
      if (fuelAdmission.inventoryAdmitted && rawAvailableForSmelt >= 1) {
        return { action: 'smelt_raw_iron', ttlMs: LONG_WORLD_ACTION_TTL_MS };
      }
      if (rawAvailableForSmelt >= 1
        && s.atIronDepth
        && !s.explicitEfficientFuel
        && opts.smeltFuelShortFingerprint !== fuelFingerprint) {
        return { action: 'smelt_raw_iron', ttlMs: LONG_WORLD_ACTION_TTL_MS };
      }
      if (rawAvailableForSmelt >= 1 && s.atIronDepth) {
        return { action: 'mine_nearby_coal', ttlMs: LONG_WORLD_ACTION_TTL_MS };
      }
      return null;
    }
    case 'MAKE_IRON_TOOLS': {
      const requiredPickaxes = s.targetDiamondTier && !s.atDiamondDepth ? THRESHOLDS.ironPickaxesForDiamondDescent : 1;
      if (s.ironPickaxes >= requiredPickaxes) return null;
      if (s.sticks < 2) return s.planks >= 2 ? 'craft_sticks' : (s.logs >= 1 ? 'craft_planks' : null);
      if (!s.tablePlaced && !miningWorkspaceUsable(s)) return tableSetupAction(s);
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
      if (!s.tablePlaced && !miningWorkspaceUsable(s)) return tableSetupAction(s);
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

function canonicalGroundedDryPosition(raw) {
  if (raw?.onGround !== true || raw?.touchingWater === true) return null;
  if (!Number.isFinite(raw?.x) || !Number.isFinite(raw?.y) || !Number.isFinite(raw?.z)) return null;
  return { x: Math.floor(raw.x), y: Math.floor(raw.y), z: Math.floor(raw.z) };
}

function validSurfaceAnchor(anchor) {
  return Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y) && Number.isFinite(anchor?.z);
}

function normalizedCommandId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function observedCommandId(raw, context = {}) {
  return normalizedCommandId(raw?.currentCommandId)
    || normalizedCommandId(raw?.activeNavigationCommandId)
    || normalizedCommandId(context?.activeCommandId);
}

function declineProvisionalSurfaceAnchor(ms, signals, reason, details = {}) {
  const anchor = validSurfaceAnchor(ms.surfaceProvisionalAnchor)
    ? { ...ms.surfaceProvisionalAnchor }
    : null;
  const commandId = normalizedCommandId(ms.surfaceProvisionalAnchorCommandId);
  ms.surfaceProvisionalAnchor = null;
  ms.surfaceProvisionalAnchorCommandId = null;
  if (!anchor) return false;
  signals.push({
    evt: 'mission.surface_return.anchor_declined',
    objective: 'MINE_STONE',
    anchor,
    commandId,
    reason,
    ...details,
  });
  return true;
}

function atSurfaceAnchor(raw, anchor) {
  const feet = canonicalGroundedDryPosition(raw);
  return feet !== null
    && validSurfaceAnchor(anchor)
    && feet.x === anchor.x
    && feet.y === anchor.y
    && feet.z === anchor.z;
}

function surfaceReturnCompletion(raw, anchor) {
  if (raw?.currentCommandCompleted !== true) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  if (reason === 'return_staircase_complete:surface_reached') {
    return atSurfaceAnchor(raw, anchor)
      ? { status: 'complete', reason }
      : { status: 'failed', reason: 'return_staircase_failed:surface_target_mismatch', detail: reason };
  }
  if (reason.startsWith('return_staircase_failed:')) return { status: 'failed', reason };
  return null;
}

function surfaceReturnRetryKey(anchor, feet) {
  if (!validSurfaceAnchor(anchor) || !validSurfaceAnchor(feet)) return null;
  return `${anchor.x},${anchor.y},${anchor.z}|${feet.x},${feet.y},${feet.z}`;
}

function structuralSurfaceReturnFailure(feedback) {
  return feedback?.status === 'failed'
    && typeof feedback.reason === 'string'
    && feedback.reason.startsWith('return_staircase_failed:')
    && feedback.reason !== 'return_staircase_failed:surface_target_mismatch';
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

function missionIronToolPreparationAction(s, budget, readiness = 'laneReady') {
  if (!budget || budget?.[readiness] === true) return null;
  if (s.cobblestone < 3) return null;

  // Local reserve preparation is a single resource transaction even though the executors
  // perform it as several commands. Prove that the complete chain can leave the six-plank
  // field kit intact before spending its first plank. A returnable/nearby workspace needs no
  // replacement table; a carried table needs placement but no table recipe.
  const workspaceUsable = s.tablePlaced || miningWorkspaceUsable(s);
  const needsSticks = s.sticks < budget.requiredSticksForRestock;
  const needsCraftedTable = !workspaceUsable && s.craftingTables < 1;
  const consumedPlanks = (needsSticks ? 2 : 0) + (needsCraftedTable ? 4 : 0);
  const requiredConvertiblePlanks = consumedPlanks > 0
    ? THRESHOLDS.miningFieldKitPlankReserve + consumedPlanks
    : 0;
  const convertiblePlanks = s.planks + (s.logs * 4);
  if (convertiblePlanks < requiredConvertiblePlanks) return null;

  if (s.sticks < budget.requiredSticksForRestock) {
    if (s.planks >= THRESHOLDS.miningFieldKitPlankReserve + 2) return 'craft_sticks';
    if (s.logs >= 1) return 'craft_planks';
    return null;
  }
  if (!workspaceUsable) {
    if (s.craftingTables >= 1) return 'place_table';
    if (s.planks >= THRESHOLDS.miningFieldKitPlankReserve + 4) return 'craft_table';
    if (s.logs >= 1) return 'craft_planks';
    return null;
  }
  return 'craft_stone_pickaxe';
}

function ironToolReserveFingerprint(snapshot, budgetOpts = {}) {
  const budget = ironAcquisitionToolBudget(snapshot, budgetOpts);
  const requiredDurability = budget.recoveryDepth > 0
    ? budget.recoveryRequiredDurability
    : budget.laneRequiredDurability;
  const state = summarizeStatePlus(snapshot);
  return JSON.stringify({
    remaining: budget.remainingMissionIronCount,
    required: requiredDurability,
    available: budget.spendableDurability,
    cobblestone: state.cobblestone,
    sticks: state.sticks,
    planks: state.planks,
    logs: state.logs,
    workspaceAvailable: snapshot?.miningWorkspaceAvailable === true,
    workspaceAtSite: snapshot?.miningWorkspaceAtSite === true,
    workspaceReturnAvailable: snapshot?.miningWorkspaceReturnAvailable === true,
  });
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

function miningWorkspaceUsable(s) {
  return s.atIronDepth
    && s.miningWorkspaceAvailable
    && (s.miningWorkspaceAtSite || s.miningWorkspaceReturnAvailable);
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
  if (objective === 'GATHER_WOOD' && reason.startsWith('return_staircase_failed:')) {
    return reason;
  }
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

function withIronToolBudgetFields(intent, raw, opts = {}) {
  if (!intent) return intent;
  const budget = ironAcquisitionToolBudget(raw, opts);
  return {
    ...intent,
    remainingMissionIronCount: budget.remainingMissionIronCount,
    reservedIronPickaxeCount: budget.reservedIronPickaxeCount,
    reservedIronPickaxeDurabilityFloor: budget.reservedIronPickaxeDurabilityFloor,
  };
}

function ironSearchRecoveryIntent(raw, ttlMs, heading = null) {
  const s = summarizeStatePlus(raw);
  if (!s.atIronDepth) {
    return null;
  }
  let intent = {
    action: 'descend_staircase',
    ttlMs,
    reason: 'mission:MINE_IRON_RECOVERY',
    objective: 'MINE_IRON_RECOVERY',
    recoveryObjective: 'MINE_IRON_RECOVERY',
    trackObjective: 'MINE_IRON',
  };
  let recoveryDepth = 0;
  if (Number.isFinite(raw?.y)) {
    // IN-BAND recovery (o3 census, dry pockets x6 = the #1 fail class): the old floor (-48)
    // marched each retry 8 blocks deeper, OUT of the iron band (peak y~16, thin below -24) and
    // into half-speed deepslate — 5 of 6 exhausted runs ended prospecting at y=-1..-30. Recoveries
    // now stay in the band: a shallow reset-descend toward the peak; the real relocation is the
    // fresh MINE_IRON command's new prospect direction + full block budget.
    const y = Math.floor(raw.y);
    intent.targetY = Math.max(6, Math.min(y - 2, 16));
    recoveryDepth = Math.max(0, y - intent.targetY);
  }
  intent = withIronHeading(intent, raw, heading);
  return withIronToolBudgetFields(intent, raw, { recoveryDepth });
}

function ironSearchRecoveryDepth(raw, recovery) {
  if (!Number.isFinite(raw?.y) || !Number.isFinite(recovery?.targetY)) return 0;
  return Math.max(0, Math.floor(raw.y) - Math.floor(recovery.targetY));
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

const MINE_STONE_NO_SAFE_METHOD_FAILURE =
  'mine_nearby_stone_failed:mission_stone_method_rejected:no_safe_method';
const STONE_RELOCATE_SETTLE_DISTANCE = 0.05;

function mineStoneOriginFailure(raw, context = {}) {
  if (raw?.currentCommandCompleted !== true) return null;
  const reason = typeof raw?.currentCommandCompletionReason === 'string'
    ? raw.currentCommandCompletionReason.trim()
    : '';
  if (reason !== MINE_STONE_NO_SAFE_METHOD_FAILURE) return null;
  const commandId = normalizedCommandId(context?.completedCommandId)
    || normalizedCommandId(raw?.currentCommandId);
  const originalPosition = canonicalGroundedDryPosition(raw);
  if (!commandId || !originalPosition) return null;
  return {
    commandId,
    reason,
    originalPosition,
    fingerprint: JSON.stringify([commandId, reason]),
  };
}

function relocateTelemetry(relocate, fallbackLimit) {
  return {
    trigger: relocate.trigger || 'dead_column_descent',
    sourceCommandId: relocate.sourceCommandId || null,
    originalPosition: relocate.originalPosition || null,
    target: [relocate.targetX, relocate.targetZ],
    attempt: relocate.attempt,
    limit: Number.isFinite(relocate.limit) ? relocate.limit : fallbackLimit,
  };
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
  const targetX = x + (dx / distance) * blocks;
  const targetZ = z + (dz / distance) * blocks;
  return {
    targetX,
    targetZ,
    startedAtMs: now,
    bestGroundedDistance: raw?.onGround === true
      ? Math.hypot(targetX - x, targetZ - z)
      : Infinity,
    lastRealProgressAtMs: now,
    digObserved: false,
    diggingReported: false,
  };
}

function startExploreLeg(raw, leg, legNumbers, hopBlocks, now) {
  const x = Number.isFinite(raw?.x) ? raw.x : 0;
  const z = Number.isFinite(raw?.z) ? raw.z : 0;
  const targetDx = leg.targetX - x;
  const targetDz = leg.targetZ - z;
  const targetDistance = Math.hypot(targetDx, targetDz);
  const exploration = {
    ...leg,
    leg: legNumbers.totalLeg,
    epoch: legNumbers.epoch,
    epochLeg: legNumbers.epochLeg,
    totalLeg: legNumbers.totalLeg,
    distanceTravelled: 0,
    rawPathDistance: 0,
    projectedProgress: 0,
    creditedProgress: 0,
    originX: x,
    originZ: z,
    directionX: targetDistance > 0 ? targetDx / targetDistance : 0,
    directionZ: targetDistance > 0 ? targetDz / targetDistance : 0,
    lastX: x,
    lastZ: z,
    consecutiveHopFailures: 0,
    hopsQueued: 1,
    startedAtMs: now,
  };
  exploration.hop = exploreHopTarget(raw, exploration, hopBlocks, now);
  return exploration;
}

function observeExploreTravel(raw, exploration, now) {
  const positioned = Number.isFinite(raw?.x) && Number.isFinite(raw?.z);
  const grounded = raw?.onGround === true;
  if (positioned) {
    exploration.rawPathDistance += Math.hypot(raw.x - exploration.lastX, raw.z - exploration.lastZ);
    exploration.lastX = raw.x;
    exploration.lastZ = raw.z;
  }

  const legDistance = positioned
    ? Math.hypot(raw.x - exploration.targetX, raw.z - exploration.targetZ)
    : Infinity;
  const hopDistance = positioned && exploration.hop
    ? Math.hypot(raw.x - exploration.hop.targetX, raw.z - exploration.hop.targetZ)
    : Infinity;

  if (positioned && grounded) {
    exploration.projectedProgress = ((raw.x - exploration.originX) * exploration.directionX)
      + ((raw.z - exploration.originZ) * exploration.directionZ);
    exploration.creditedProgress = Math.max(
      exploration.creditedProgress,
      Math.max(0, exploration.projectedProgress),
    );
    exploration.distanceTravelled = exploration.creditedProgress;

    if (!Number.isFinite(exploration.hop.bestGroundedDistance)) {
      exploration.hop.bestGroundedDistance = hopDistance;
      exploration.hop.lastRealProgressAtMs = now;
    } else if (exploration.hop.bestGroundedDistance - hopDistance >= 0.2) {
      exploration.hop.bestGroundedDistance = hopDistance;
      exploration.hop.lastRealProgressAtMs = now;
    }
  }

  return { positioned, grounded, legDistance, hopDistance };
}

function exploreTravelMetadata(exploration, now, groundedArrival = false) {
  return {
    distanceTravelled: exploration.creditedProgress,
    rawPathDistance: exploration.rawPathDistance,
    projectedProgress: exploration.projectedProgress,
    creditedProgress: exploration.creditedProgress,
    bestHopDistance: Number.isFinite(exploration.hop?.bestGroundedDistance)
      ? exploration.hop.bestGroundedDistance
      : null,
    hopProgressAgeMs: exploration.hop
      ? Math.max(0, now - exploration.hop.lastRealProgressAtMs)
      : null,
    groundedArrival,
  };
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
      ironToolReserveEventKey: null,
      ironToolReserveBlockedKey: null,
      smeltFuelFingerprint: null,
      smeltFuelShortFingerprint: null,
      smeltFuelProbeReportedFingerprint: null,
      smeltFuelProbeBatchSize: 0,
      smeltLoadedRawBatch: 0,
      smeltLoadedRawBaselineIngots: null,
      lastSmeltFuelFeedbackKey: null,
      relocate: null,
      mineStoneRelocations: 0,
      processedMineStoneOriginFailures: new Set(),
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
      miningManifestEventKey: null,
      miningManifestReadyReported: false,
      surfaceLatestStable: null,
      // Mission stone may begin the canonical descent shaft before the explicit DESCEND
      // objective. Keep that first dry/grounded stance frozen provisionally, but do not make
      // underground resource returns authoritative until a later grounded observation proves
      // that the player actually descended. A face-only stone harvest therefore cannot invent
      // a surface excursion.
      surfaceProvisionalAnchor: null,
      surfaceProvisionalAnchorCommandId: null,
      surfaceAnchor: null,
      surfaceExcursionActive: false,
      surfaceReturnPending: false,
      surfaceReturnStarted: false,
      surfaceReturnTerminalFeedbackKey: null,
      surfaceReturnRetryLatch: null,
      surfaceReturnRetryAwaitingCommand: false,
      surfaceReturnLastStableFeet: null,
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

  #reportIronToolReserve(snapshot, intent, signals, source, budgetOpts = {}) {
    const budget = ironAcquisitionToolBudget(snapshot, budgetOpts);
    const requiredDurability = budget.recoveryDepth > 0
      ? budget.recoveryRequiredDurability
      : budget.laneRequiredDurability;
    // Any executable reserve plan is authoritative evidence that the prior resource/workspace
    // fingerprint is no longer blocking. A future shortage must be classified afresh.
    this.state.ironToolReserveBlockedKey = null;
    const preparing = intent?.action !== 'mine_nearby_iron';
    const eventKey = JSON.stringify({
      source,
      action: intent?.action || null,
      remaining: budget.remainingMissionIronCount,
      required: requiredDurability,
      available: budget.spendableDurability,
      workspace: [
        snapshot?.miningWorkspaceAvailable === true,
        snapshot?.miningWorkspaceAtSite === true,
        snapshot?.miningWorkspaceReturnAvailable === true,
      ],
    });
    if (eventKey === this.state.ironToolReserveEventKey) return;
    this.state.ironToolReserveEventKey = eventKey;
    signals.push({
      evt: preparing ? 'mission.mine_iron.tool_reserve.preparing' : 'mission.mine_iron.tool_reserve.ready',
      objective: 'MINE_IRON',
      source,
      action: intent?.action || null,
      currentMilestoneDeficit: budget.currentMilestoneDeficit,
      remainingMissionIronCount: budget.remainingMissionIronCount,
      requiredDurability,
      availableDurability: budget.spendableDurability,
      reservedIronPickaxeCount: budget.reservedIronPickaxeCount,
      reservedIronPickaxeDurabilityFloor: budget.reservedIronPickaxeDurabilityFloor,
      stonePickaxeDurability: budget.stonePickaxeDurability,
      workspaceAvailable: snapshot?.miningWorkspaceAvailable === true,
      workspaceAtSite: snapshot?.miningWorkspaceAtSite === true,
      workspaceReturnAvailable: snapshot?.miningWorkspaceReturnAvailable === true,
    });
  }

  #blockIronToolReserve(snapshot, signals, source, budgetOpts = {}) {
    const ms = this.state;
    const budget = ironAcquisitionToolBudget(snapshot, budgetOpts);
    const requiredDurability = budget.recoveryDepth > 0
      ? budget.recoveryRequiredDurability
      : budget.laneRequiredDurability;
    const fingerprint = ironToolReserveFingerprint(snapshot, budgetOpts);
    if (fingerprint === ms.ironToolReserveBlockedKey) {
      ms.done = true;
      ms.terminalReason = 'aborted';
      ms.terminalObjective = 'ABORTED';
      ms.lastOutcome = 'blocked:MINE_IRON:tool_reserve_unavailable';
      ms.currentObjective = null;
      signals.push({
        evt: 'mission.objective.exhausted',
        objective: 'MINE_IRON',
        reason: 'tool_reserve_unavailable',
        attempts: 1,
      });
      signals.push({
        evt: 'mission.aborted',
        reason: 'resource_unavailable',
        objective: 'MINE_IRON',
        detail: 'tool_reserve_unavailable',
        attempts: 1,
      });
      return {
        intent: idleIntent('aborted', this.ttlMs),
        signals,
        objective: 'ABORTED',
        done: true,
        replanned: false,
        source,
      };
    }
    ms.ironToolReserveBlockedKey = fingerprint;
    signals.push({
      evt: 'mission.mine_iron.tool_reserve.blocked',
      objective: 'MINE_IRON',
      source,
      reason: 'tool_reserve_unavailable',
      currentMilestoneDeficit: budget.currentMilestoneDeficit,
      remainingMissionIronCount: budget.remainingMissionIronCount,
      requiredDurability,
      availableDurability: budget.spendableDurability,
      reservedIronPickaxeCount: budget.reservedIronPickaxeCount,
      reservedIronPickaxeDurabilityFloor: budget.reservedIronPickaxeDurabilityFloor,
    });
    signals.push({
      evt: 'mission.objective.blocked',
      objective: 'MINE_IRON',
      reason: 'tool_reserve_unavailable',
    });
    signals.push({
      evt: 'mission.resource.failed',
      objective: 'MINE_IRON',
      resource: 'mining_tool_durability',
      reason: 'tool_reserve_unavailable',
    });
    ms.lastOutcome = 'blocked:MINE_IRON:tool_reserve_unavailable';
    // The neutral executor handoff does not earn time or reset any search state. A genuinely
    // unfulfillable reserve is re-evaluated once under the same objective; an unchanged
    // fingerprint exits through the bounded resource-failure path on the next tick.
    return {
      intent: idleIntent('tool_reserve_unavailable', this.ttlMs),
      signals,
      objective: 'MINE_IRON',
      done: false,
      replanned: false,
      source,
    };
  }

  #rejectRepeatedIronToolReserveBlock(snapshot, signals, source, budgetOpts = {}) {
    const blocked = this.state.ironToolReserveBlockedKey;
    if (blocked === null) return null;
    const current = ironToolReserveFingerprint(snapshot, budgetOpts);
    if (current !== blocked) {
      this.state.ironToolReserveBlockedKey = null;
      return null;
    }
    return this.#blockIronToolReserve(snapshot, signals, source, budgetOpts);
  }

  // The HTTP adapter owns the stable command id and assigns it only after this orchestrator has
  // selected an action. Bind the provisional shaft mouth after that assignment so a later command
  // can never claim descent progress produced by an earlier mine_nearby_stone episode.
  bindSurfaceProvisionalAnchorCommand(commandId, action, objective) {
    const normalized = normalizedCommandId(commandId);
    const ms = this.state;
    if (normalized === null
      || action !== 'mine_nearby_stone'
      || objective !== 'MINE_STONE'
      || ms.surfaceExcursionActive
      || !validSurfaceAnchor(ms.surfaceProvisionalAnchor)) {
      return false;
    }
    if (ms.surfaceProvisionalAnchorCommandId === null) {
      ms.surfaceProvisionalAnchorCommandId = normalized;
      return true;
    }
    return ms.surfaceProvisionalAnchorCommandId === normalized;
  }

  /**
   * A completed opportunity may make the frozen baseline objective obsolete (e.g. a
   * verified golem drop can make surface DESCEND unnecessary for an iron-pickaxe goal).
   * Reconsider only at the neutral transaction boundary and only when the deterministic oracle's
   * authoritative next objective differs. Failure counts and global clocks remain untouched; a
   * genuinely new objective receives its normal wall clock when step() selects it.
   */
  reconsiderAfterAuthoritativeOpportunity(raw) {
    const ms = this.state;
    if (ms.done || !ms.currentObjective) {
      return Object.freeze({ changed: false, from: ms.currentObjective, to: null });
    }
    const next = expectedObjective(raw);
    if (!next || next === ms.currentObjective) {
      return Object.freeze({ changed: false, from: ms.currentObjective, to: next || null });
    }
    const from = ms.currentObjective;
    ms.currentObjective = null;
    ms.lastOutcome = `opportunity:${from}:authoritative_gain`;
    return Object.freeze({ changed: true, from, to: next });
  }

  // One control step against `snapshot` (sim state or ClientSnapshot).
  // Returns { intent, signals, objective, done, replanned, source }.
  async step(snapshot, context = {}) {
    const signals = [];
    const ms = this.state;
    if (ms.done) {
      const reason = ms.terminalReason || 'done';
      const objective = ms.terminalObjective || 'DONE';
      return { intent: idleIntent(reason, this.ttlMs), signals, objective, done: true, replanned: false, source: reason };
    }

    const now = this.now();
    const key = progressKey(snapshot);
    const smeltState = summarizeStatePlus(snapshot);
    if (ms.smeltLoadedRawBatch > 0
      && Number.isFinite(ms.smeltLoadedRawBaselineIngots)
      && smeltState.ironIngots > ms.smeltLoadedRawBaselineIngots) {
      ms.smeltLoadedRawBatch = 0;
      ms.smeltLoadedRawBaselineIngots = null;
    }
    const smeltFuelFingerprint = rawIronFuelFingerprint(snapshot);
    if (smeltFuelFingerprint !== ms.smeltFuelFingerprint) {
      ms.smeltFuelFingerprint = smeltFuelFingerprint;
      ms.smeltFuelShortFingerprint = null;
      ms.smeltFuelProbeReportedFingerprint = null;
    }

    const stableFeet = canonicalGroundedDryPosition(snapshot);
    if (validSurfaceAnchor(ms.surfaceProvisionalAnchor)
      && ms.currentObjective !== null
      && ms.currentObjective !== 'MINE_STONE') {
      declineProvisionalSurfaceAnchor(ms, signals, 'stone_objective_no_longer_active', {
        nextObjective: ms.currentObjective,
      });
    }
    if (!ms.surfaceExcursionActive && stableFeet) ms.surfaceLatestStable = stableFeet;
    const provisionalObservedCommandId = observedCommandId(snapshot, context);
    const provisionalOwner = normalizedCommandId(ms.surfaceProvisionalAnchorCommandId);
    const provisionalCommandMatches = ms.currentObjective === 'MINE_STONE'
      && provisionalOwner !== null
      && provisionalObservedCommandId === provisionalOwner;
    const provisionalCommandFailure = provisionalCommandMatches
      ? streakCommandFailureForObjective('MINE_STONE', snapshot)
      : null;
    if (!ms.surfaceExcursionActive
      && validSurfaceAnchor(ms.surfaceProvisionalAnchor)
      && provisionalCommandMatches
      && provisionalCommandFailure === null
      && stableFeet
      && stableFeet.y < ms.surfaceProvisionalAnchor.y) {
      ms.surfaceAnchor = { ...ms.surfaceProvisionalAnchor };
      ms.surfaceProvisionalAnchor = null;
      ms.surfaceProvisionalAnchorCommandId = null;
      ms.surfaceExcursionActive = true;
      ms.surfaceReturnPending = false;
      ms.surfaceReturnStarted = false;
      ms.surfaceReturnTerminalFeedbackKey = null;
      ms.surfaceReturnRetryLatch = null;
      ms.surfaceReturnRetryAwaitingCommand = false;
      ms.surfaceReturnLastStableFeet = null;
      signals.push({
        evt: 'mission.surface_return.anchor_activated',
        objective: 'MINE_STONE',
        commandId: provisionalOwner,
        anchor: ms.surfaceAnchor,
        position: stableFeet,
        reason: 'grounded_lower_stance',
      });
    }
    const completedProvisionalCommandId = snapshot?.currentCommandCompleted === true
      ? (normalizedCommandId(context?.completedCommandId) || provisionalObservedCommandId)
      : null;
    if (!ms.surfaceExcursionActive
      && validSurfaceAnchor(ms.surfaceProvisionalAnchor)
      && provisionalOwner !== null
      && completedProvisionalCommandId === provisionalOwner
      && !objectiveAchieved('MINE_STONE', snapshot)) {
      const reason = provisionalCommandFailure
        ? (provisionalCommandFailure.includes('_abandoned:')
            ? 'stone_command_abandoned_without_grounded_descent'
            : 'stone_command_failed_without_grounded_descent')
        : 'stone_command_completed_without_grounded_descent';
      declineProvisionalSurfaceAnchor(ms, signals, reason, {
        completionReason: typeof snapshot?.currentCommandCompletionReason === 'string'
          ? snapshot.currentCommandCompletionReason
          : '',
      });
    }
    if (ms.surfaceReturnPending && stableFeet) ms.surfaceReturnLastStableFeet = stableFeet;
    const surfaceReturnFeedbackAtStart = ms.currentObjective === 'GATHER_WOOD' && ms.surfaceReturnPending
      ? surfaceReturnCompletion(snapshot, ms.surfaceAnchor)
      : null;
    const suppressSurfaceReturnClockRefresh = ms.surfaceReturnPending && (
      (ms.surfaceReturnRetryLatch !== null && (
        ms.surfaceReturnRetryLatch.key === null
          || surfaceReturnRetryKey(ms.surfaceAnchor, stableFeet) === ms.surfaceReturnRetryLatch.key
          || stableFeet === null
      ))
      || (ms.surfaceReturnRetryAwaitingCommand && structuralSurfaceReturnFailure(surfaceReturnFeedbackAtStart))
    );
    const completionReasonAtStart = typeof snapshot?.currentCommandCompletionReason === 'string'
      ? snapshot.currentCommandCompletionReason
      : '';
    const recoveryToolPreparationPending = ms.currentObjective === null
      && ms.pendingRecoveryIntent?.reason === 'mission:MINE_IRON_RECOVERY';
    const suppressIronToolReserveClockRefresh = recoveryToolPreparationPending
      || (ms.currentObjective === 'MINE_IRON'
        && snapshot?.currentCommandCompleted === true
        && (
          completionReasonAtStart === 'mine_nearby_iron_complete:tool_reserve_required'
          || completionReasonAtStart === 'descent_complete:tool_reserve_required'
          || completionReasonAtStart === 'mine_nearby_iron_complete:tool_reserve_unavailable'
          || completionReasonAtStart === 'craft_stone_pickaxe_failed:tool_reserve_unavailable'
          || completionReasonAtStart === 'descent_complete:tool_reserve_unavailable'
        ));
    const suppressMissionClockRefresh = suppressSurfaceReturnClockRefresh
      || suppressIronToolReserveClockRefresh;

    if (missionComplete(snapshot)) {
      declineProvisionalSurfaceAnchor(ms, signals, 'mission_completed_without_grounded_descent');
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
    if (key !== ms.globalLastKey) {
      ms.globalLastKey = key;
      if (!suppressMissionClockRefresh) ms.globalProgressAtMs = now;
    }
    if (key !== ms.lastKey) {
      ms.lastKey = key;
      if (!suppressMissionClockRefresh) ms.objectiveProgressAtMs = now;
    }

    let surfaceReturnTerminalHandled = false;
    let surfaceReturnFeedbackConsumed = false;
    if (ms.currentObjective === 'GATHER_WOOD' && ms.surfaceReturnPending) {
      if (ms.surfaceReturnRetryAwaitingCommand && snapshot?.currentCommandCompleted !== true) {
        ms.surfaceReturnRetryAwaitingCommand = false;
        ms.surfaceReturnTerminalFeedbackKey = null;
      }
      const feedback = surfaceReturnFeedbackAtStart;
      const completedCommandId = typeof snapshot?.currentCommandId === 'string'
        && snapshot.currentCommandId.trim()
        ? snapshot.currentCommandId.trim()
        : (typeof context?.completedCommandId === 'string' ? context.completedCommandId.trim() : '');
      const feedbackKey = feedback
        ? `${completedCommandId}:${snapshot?.currentCommandCompletionReason || ''}`
        : null;
      if (ms.surfaceReturnRetryAwaitingCommand && structuralSurfaceReturnFailure(feedback)) {
        // A released retry is not allowed to charge the prior terminal feedback under a new
        // response identity. Observe one nonterminal replacement-command poll first.
        surfaceReturnTerminalHandled = false;
        surfaceReturnFeedbackConsumed = true;
      } else if (ms.surfaceReturnRetryLatch && structuralSurfaceReturnFailure(feedback)) {
        // The client can keep reporting the terminal return reason while the newly issued stop
        // command propagates, sometimes under that stop command's identity. The latch, rather
        // than the volatile command id, owns this already-charged structural failure.
        surfaceReturnTerminalHandled = false;
        surfaceReturnFeedbackConsumed = true;
      } else if (feedbackKey !== null && feedbackKey === ms.surfaceReturnTerminalFeedbackKey) {
        // A structural failure can remain visible while the client applies the stopped
        // suppression command. Keep the feedback deduplicated, but leave the global watchdog
        // authoritative on later polls so an unchanged blocked return still terminates.
        surfaceReturnTerminalHandled = ms.surfaceReturnRetryLatch === null;
        surfaceReturnFeedbackConsumed = true;
      } else if (feedback?.status === 'complete') {
        ms.surfaceReturnTerminalFeedbackKey = feedbackKey;
        signals.push({
          evt: 'mission.surface_return.completed',
          objective: 'GATHER_WOOD',
          anchor: ms.surfaceAnchor,
          position: stableFeet,
          reason: feedback.reason,
        });
        ms.surfaceReturnPending = false;
        ms.surfaceReturnStarted = false;
        ms.surfaceExcursionActive = false;
        ms.surfaceReturnRetryLatch = null;
        ms.surfaceReturnRetryAwaitingCommand = false;
        ms.surfaceReturnLastStableFeet = null;
        if (stableFeet) ms.surfaceLatestStable = stableFeet;
      } else if (feedback?.status === 'failed') {
        ms.surfaceReturnTerminalFeedbackKey = feedbackKey;
        const attempts = (ms.objectiveFailures.GATHER_WOOD || 0) + 1;
        signals.push({
          evt: 'mission.surface_return.failed',
          objective: 'GATHER_WOOD',
          anchor: ms.surfaceAnchor,
          position: stableFeet,
          reason: feedback.reason,
          detail: feedback.detail || null,
          attempts,
        });
        signals.push({ evt: 'mission.objective.failed', objective: 'GATHER_WOOD', reason: feedback.reason });
        ms.objectiveFailures.GATHER_WOOD = attempts;
        ms.consecutiveFailureKey = null;
        ms.consecutiveFailureCount = 0;
        ms.lastOutcome = `failed:GATHER_WOOD:${feedback.reason}`;
        const suppressibleStructuralFailure = structuralSurfaceReturnFailure(feedback)
          && validSurfaceAnchor(ms.surfaceAnchor)
          && attempts <= (this.terrainRetryLimits.GATHER_WOOD ?? 0);
        const failureFeet = stableFeet || ms.surfaceReturnLastStableFeet;
        const retryKey = suppressibleStructuralFailure
          ? surfaceReturnRetryKey(ms.surfaceAnchor, failureFeet)
          : null;
        if (suppressibleStructuralFailure) {
          ms.surfaceReturnRetryLatch = {
            key: retryKey,
            anchor: { ...ms.surfaceAnchor },
            feet: failureFeet ? { ...failureFeet } : null,
            reason: feedback.reason,
            attempts,
          };
          signals.push({
            evt: 'mission.surface_return.retry_suppressed',
            objective: 'GATHER_WOOD',
            anchor: ms.surfaceAnchor,
            position: failureFeet,
            reason: feedback.reason,
            attempts,
          });
          // Keep the same objective and its original clocks alive. A genuine canonical
          // displacement releases this already-charged retry; otherwise the global watchdog
          // is the bounded fail-closed terminal.
          surfaceReturnFeedbackConsumed = true;
        } else {
          ms.currentObjective = null;
        }
        surfaceReturnTerminalHandled = true;
      }
    }

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
      // No-net-progress escalation (2 of 5 campaign kills): a SINGLE search-exhausted
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
    if (!surfaceReturnTerminalHandled && !gatherExhaustion && now - ms.globalProgressAtMs >= this.abortTimeoutMs) {
      declineProvisionalSurfaceAnchor(ms, signals, 'mission_abandoned_no_global_progress');
      ms.done = true;
      ms.terminalReason = 'aborted';
      ms.terminalObjective = 'ABORTED';
      signals.push({ evt: 'mission.aborted', reason: 'no_global_progress', stuckMs: now - ms.globalProgressAtMs, objective: ms.currentObjective || null });
      return { intent: idleIntent('aborted', this.ttlMs), signals, objective: 'ABORTED', done: true, replanned: false, source: 'aborted' };
    }

    if (ms.surfaceReturnRetryLatch) {
      if (ms.currentObjective !== 'GATHER_WOOD'
        || !ms.surfaceReturnPending
        || objectiveAchieved('GATHER_WOOD', snapshot)) {
        ms.surfaceReturnRetryLatch = null;
        ms.surfaceReturnRetryAwaitingCommand = false;
      } else {
        if (ms.surfaceReturnRetryLatch.key === null) {
          if (stableFeet) {
            ms.surfaceReturnRetryLatch.feet = { ...stableFeet };
            ms.surfaceReturnRetryLatch.key = surfaceReturnRetryKey(ms.surfaceAnchor, stableFeet);
            ms.surfaceReturnLastStableFeet = stableFeet;
          }
          return {
            intent: idleIntent('surface_return_retry_suppressed', this.ttlMs),
            signals,
            objective: 'GATHER_WOOD',
            done: false,
            replanned: false,
            source: 'surface_return_retry_suppressed',
          };
        }
        const retryKey = surfaceReturnRetryKey(ms.surfaceAnchor, stableFeet);
        if (retryKey === ms.surfaceReturnRetryLatch.key || retryKey === null) {
          return {
            intent: idleIntent('surface_return_retry_suppressed', this.ttlMs),
            signals,
            objective: 'GATHER_WOOD',
            done: false,
            replanned: false,
            source: 'surface_return_retry_suppressed',
          };
        }
        const released = ms.surfaceReturnRetryLatch;
        ms.surfaceReturnRetryLatch = null;
        ms.surfaceReturnRetryAwaitingCommand = true;
        signals.push({
          evt: 'mission.surface_return.retry_released',
          objective: 'GATHER_WOOD',
          anchor: ms.surfaceAnchor,
          previousPosition: released.feet,
          position: stableFeet,
          reason: released.reason,
          attempts: released.attempts,
        });
      }
    }

    // EXPLORE travel is decomposed into bounded local hops. Grounded closest approach proves hop
    // progress, while monotonic origin-to-target projection proves leg progress; executor rejection
    // fails immediately instead of burning a stall window.
    if (ms.exploration) {
      const exploration = ms.exploration;
      const travel = observeExploreTravel(snapshot, exploration, now);
      const legComplete = travel.grounded && (
        exploration.creditedProgress >= this.exploreLegBlocks
        || travel.legDistance <= this.exploreArriveDist
      );
      const resourceDetected = hasLocalWood(snapshot);
      if (resourceDetected || legComplete) {
        signals.push({
          evt: resourceDetected ? 'exploration.resource.detected' : 'exploration.leg.arrived',
          resource: exploration.resource,
          leg: exploration.leg,
          ...exploreMetadata(exploration),
          target: [exploration.targetX, exploration.targetZ],
          distance: travel.legDistance,
          legBlocks: this.exploreLegBlocks,
          arriveDist: this.exploreArriveDist,
          ...exploreTravelMetadata(exploration, now, !resourceDetected && legComplete),
        });
        if (!resourceDetected) {
          ms.exploreTriedDirections.add(exploration.directionKey);
          earnExploreEpoch(ms, 'leg_arrival', snapshot, signals);
        }
        ms.exploration = null;
        ms.currentObjective = 'GATHER_WOOD';
        ms.objectiveProgressAtMs = now;
        ms.objectiveStartedAtMs = now;
        ms.lastOutcome = `exploration:${exploration.resource}:resume`;
      } else {
        const rejected = exploreHopFailure(snapshot);
        exploration.hop.digObserved ||= snapshot?.navDigActive === true;
        const hopProgressAgeMs = Math.max(0, now - exploration.hop.lastRealProgressAtMs);
        const hopStallBudget = exploration.hop.digObserved
          ? this.exploreHopDigTimeoutMs
          : this.stallTimeoutMs;
        const stalled = hopProgressAgeMs >= hopStallBudget;
        const hopArrived = travel.grounded
          && travel.hopDistance <= Math.min(this.exploreArriveDist, 2.5);
        // Observable proof the dig-tolerance is doing work: the hop would have stalled on the normal
        // budget but is being kept alive because the substrate is productively digging through.
        if (exploration.hop.digObserved
          && !exploration.hop.diggingReported
          && !rejected
          && !hopArrived
          && hopProgressAgeMs >= this.stallTimeoutMs) {
          exploration.hop.diggingReported = true;
          signals.push({
            evt: 'exploration.hop.digging',
            resource: exploration.resource,
            leg: exploration.leg,
            ...exploreMetadata(exploration),
            hop: exploration.hopsQueued,
            heldMs: hopProgressAgeMs,
            ...exploreTravelMetadata(exploration, now),
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
            ...exploreTravelMetadata(exploration, now, true),
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
            ...exploreTravelMetadata(exploration, now),
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
            ...exploreTravelMetadata(exploration, now),
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
          ...exploreTravelMetadata(exploration, now),
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
      const timedOut = now - r.startedAtMs >= this.mineRelocateTimeoutMs;
      const stoneOriginRelocate = r.trigger === 'stone_origin_no_safe_method';
      const groundedDry = canonicalGroundedDryPosition(snapshot);
      let stoneOriginSettled = !stoneOriginRelocate;
      if (stoneOriginRelocate && dist <= this.mineRelocateArriveDist && groundedDry && !timedOut) {
        const currentPosition = { x: snapshot.x, z: snapshot.z };
        const settleDistance = r.settlePosition
          ? Math.hypot(currentPosition.x - r.settlePosition.x, currentPosition.z - r.settlePosition.z)
          : Infinity;
        r.settlePosition = currentPosition;
        stoneOriginSettled = settleDistance <= STONE_RELOCATE_SETTLE_DISTANCE;
        if (!stoneOriginSettled) {
          return {
            intent: idleIntent('relocate_settle', this.ttlMs),
            signals,
            objective: 'RELOCATE',
            done: false,
            replanned: false,
            source: 'relocate',
          };
        }
      } else if (stoneOriginRelocate) {
        r.settlePosition = null;
      }

      if (dist <= this.mineRelocateArriveDist && stoneOriginSettled && groundedDry) {
        signals.push({
          evt: 'mission.relocate.arrived',
          from: r.from,
          ...relocateTelemetry(r, this.mineRelocateLimit),
        });
        ms.relocate = null;
        ms.currentObjective = r.from;
        ms.objectiveProgressAtMs = now;
        ms.lastOutcome = `relocate:${r.from}:arrived`;
      } else if (timedOut) {
        signals.push({
          evt: 'mission.relocate.leg_failed',
          from: r.from,
          reason: 'timeout',
          ...relocateTelemetry(r, this.mineRelocateLimit),
        });
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
          ...exploreTravelMetadata(ms.exploration, now),
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
          ...exploreTravelMetadata(ms.exploration, now),
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
    if (ms.currentObjective && !surfaceReturnFeedbackConsumed) {
      const completionReason = typeof snapshot?.currentCommandCompletionReason === 'string'
        ? snapshot.currentCommandCompletionReason
        : '';
      // Plane continuity: a completed 96-block executor slice is an accounting
      // boundary, not an objective outcome. The client has already proved that a productive
      // lane remains on the frozen plane, so immediately issue the next slice on the same
      // code-owned heading. Deliberately do not refresh either objective clock, clear failure
      // state, consume a retry, or queue MINE_IRON_RECOVERY. Authoritative inventory still wins
      // if the completed slice satisfied the objective on this same observation.
      if (ms.currentObjective === 'MINE_IRON'
        && completionReason === 'mine_nearby_iron_complete:same_plane_continue'
        && !objectiveAchieved('MINE_IRON', snapshot)) {
        const heading = ensureIronSearchHeading(ms, snapshot);
        const continuationPlan = nextActionForObjective('MINE_IRON', snapshot);
        if (continuationPlan === null) {
          return this.#blockIronToolReserve(snapshot, signals, 'same_plane_continue');
        }
        let continuationIntent = typeof continuationPlan === 'string'
          ? { action: continuationPlan }
          : continuationPlan;
        if (continuationIntent.action === 'mine_nearby_iron') {
          continuationIntent = withIronHeading(continuationIntent, snapshot, heading);
        }
        continuationIntent = {
          ...continuationIntent,
          ttlMs: continuationIntent.ttlMs ?? this.ttlMs,
          reason: 'mission:MINE_IRON',
          objective: 'MINE_IRON',
        };
        if (continuationIntent.action === 'mine_nearby_iron') {
          continuationIntent = withIronToolBudgetFields(continuationIntent, snapshot);
        }
        this.#reportIronToolReserve(snapshot, continuationIntent, signals, 'same_plane_continue');
        return {
          intent: continuationIntent,
          signals,
          objective: 'MINE_IRON',
          done: false,
          replanned: false,
          source: 'same_plane_continue',
        };
      }
      if (ms.currentObjective === 'MINE_IRON'
        && (
          completionReason === 'mine_nearby_iron_complete:tool_reserve_required'
          || completionReason === 'descent_complete:tool_reserve_required'
        )
        && !objectiveAchieved('MINE_IRON', snapshot)) {
        const reservePlan = nextActionForObjective('MINE_IRON', snapshot);
        if (reservePlan === null) {
          return this.#blockIronToolReserve(snapshot, signals, 'executor_feedback');
        }
        let reserveIntent = typeof reservePlan === 'string' ? { action: reservePlan } : reservePlan;
        if (reserveIntent.action === 'mine_nearby_iron') {
          reserveIntent = withIronHeading(reserveIntent, snapshot, ensureIronSearchHeading(ms, snapshot));
        }
        reserveIntent = {
          ...reserveIntent,
          ttlMs: reserveIntent.ttlMs ?? this.ttlMs,
          reason: 'mission:MINE_IRON',
          objective: 'MINE_IRON',
        };
        if (reserveIntent.action === 'mine_nearby_iron') {
          reserveIntent = withIronToolBudgetFields(reserveIntent, snapshot);
        }
        this.#reportIronToolReserve(snapshot, reserveIntent, signals, 'executor_feedback');
        return {
          intent: reserveIntent,
          signals,
          objective: 'MINE_IRON',
          done: false,
          replanned: false,
          source: 'tool_reserve',
        };
      }
      if (ms.currentObjective === 'MINE_IRON'
        && (
          completionReason === 'craft_stone_pickaxe_failed:tool_reserve_unavailable'
          || completionReason === 'mine_nearby_iron_complete:tool_reserve_unavailable'
          || completionReason === 'descent_complete:tool_reserve_unavailable'
        )
        && !objectiveAchieved('MINE_IRON', snapshot)) {
        return this.#blockIronToolReserve(snapshot, signals, 'workspace_restock');
      }
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
        let partialIntent = withIronHeading(
          { action: 'mine_nearby_iron', ttlMs: this.ttlMs, reason: 'mission:MINE_IRON', objective: 'MINE_IRON' },
          snapshot,
          heading,
        );
        partialIntent = withIronToolBudgetFields(partialIntent, snapshot);
        return { intent: partialIntent, signals, objective: 'MINE_IRON', done: false, replanned: false, source: 'partial_progress' };
      }
      const neutralFuelFeedback = ms.currentObjective === 'SMELT_IRON' && (
        completionReason === 'smelt_raw_iron_complete:fuel_preflight_unavailable'
        || completionReason === 'smelt_raw_iron_failed:smelt_raw_iron_fuel_source_missing'
      );
      if (neutralFuelFeedback) {
        const feedbackKey = `${snapshot?.currentCommandId || ''}:${completionReason}`;
        const duplicate = feedbackKey === ms.lastSmeltFuelFeedbackKey;
        ms.smeltFuelShortFingerprint = smeltFuelFingerprint;
        const state = summarizeStatePlus(snapshot);
        if (completionReason === 'smelt_raw_iron_failed:smelt_raw_iron_fuel_source_missing'
          && state.rawIron < 1) {
          ms.smeltLoadedRawBatch = Math.max(1, ms.smeltFuelProbeBatchSize);
          ms.smeltLoadedRawBaselineIngots = state.ironIngots;
        }
        ms.consecutiveFailureKey = null;
        ms.consecutiveFailureCount = 0;
        const admission = rawIronFuelAdmission(
          ms.smeltLoadedRawBatch > 0 ? { ...state, rawIron: ms.smeltLoadedRawBatch } : state,
        );
        const details = {
          commandId: snapshot?.currentCommandId || null,
          objective: 'SMELT_IRON',
          batchSize: admission.batchSize,
          requiredWoodFuel: admission.woodFuelRequired,
          requiredEfficientFuel: admission.efficientFuelRequired,
          protectedPlanks: admission.protectedPlanks,
          sourceClass: admission.sourceClass,
          inventoryAdmitted: admission.inventoryAdmitted,
          coal: admission.coal,
          charcoal: admission.charcoal,
          logs: admission.logs,
          planks: admission.planks,
          feedbackReason: completionReason,
        };
        if (!duplicate) {
          ms.lastSmeltFuelFeedbackKey = feedbackKey;
          ms.objectiveProgressAtMs = now;
          signals.push({ evt: 'mission.smelt.fuel_short', ...details });
        }
        if (state.atIronDepth && (state.rawIron >= 1 || ms.smeltLoadedRawBatch > 0)) {
          if (!duplicate) signals.push({ evt: 'mission.smelt.coal_handoff', ...details });
          return {
            intent: {
              action: 'mine_nearby_coal',
              ttlMs: LONG_WORLD_ACTION_TTL_MS,
              reason: 'mission:SMELT_IRON',
              objective: 'SMELT_IRON',
            },
            signals,
            objective: 'SMELT_IRON',
            done: false,
            replanned: false,
            source: 'fuel_handoff',
          };
        }
        ms.lastOutcome = 'blocked:SMELT_IRON:fuel_preflight_unavailable';
        ms.currentObjective = null;
        return {
          intent: idleIntent('fuel_preflight_unavailable', this.ttlMs),
          signals,
          objective: null,
          done: false,
          replanned: false,
          source: 'fuel_feedback',
        };
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
      // Cobblestone inventory is the sole MINE_STONE completion authority. If the exact absolute
      // requirement appears on the same observation as a stale failure-shaped completion, do not
      // let the repeated-command streak outrank the verified postcondition. The ordinary timeout
      // check already follows objectiveAchieved below, so the exact wall-clock boundary is handled
      // the same way.
      const mineStoneInventorySatisfied = ms.currentObjective === 'MINE_STONE'
        && objectiveAchieved('MINE_STONE', snapshot);
      const stoneOriginFailure = ms.currentObjective === 'MINE_STONE' && !mineStoneInventorySatisfied
        ? mineStoneOriginFailure(snapshot, context)
        : null;
      const stoneOriginFailureEligible = stoneOriginFailure !== null
        && ms.surfaceExcursionActive === false;
      const stoneOriginFailureAlreadyProcessed = stoneOriginFailureEligible
        && ms.processedMineStoneOriginFailures.has(stoneOriginFailure.fingerprint);
      if (stoneOriginFailureEligible && !stoneOriginFailureAlreadyProcessed) {
        ms.processedMineStoneOriginFailures.add(stoneOriginFailure.fingerprint);
        declineProvisionalSurfaceAnchor(ms, signals, 'stone_origin_no_safe_method', {
          completionReason: stoneOriginFailure.reason,
        });
        ms.objectiveFailures.MINE_STONE = (ms.objectiveFailures.MINE_STONE || 0) + 1;
        ms.consecutiveFailureKey = null;
        ms.consecutiveFailureCount = 0;
        ms.lastOutcome = `failed:MINE_STONE:${stoneOriginFailure.reason}`;
        signals.push({
          evt: 'mission.objective.failed',
          objective: 'MINE_STONE',
          reason: 'stone_origin_no_safe_method',
          detail: stoneOriginFailure.reason,
          sourceCommandId: stoneOriginFailure.commandId,
          originalPosition: stoneOriginFailure.originalPosition,
        });
        ms.currentObjective = null;

        if (ms.mineStoneRelocations < this.mineRelocateLimit) {
          const attempt = ms.mineStoneRelocations;
          const target = relocateTargetFor(snapshot, attempt, this.mineRelocateBlocks);
          ms.relocate = {
            ...target,
            from: 'MINE_STONE',
            attempt,
            startedAtMs: now,
            trigger: 'stone_origin_no_safe_method',
            sourceCommandId: stoneOriginFailure.commandId,
            originalPosition: stoneOriginFailure.originalPosition,
            limit: this.mineRelocateLimit,
          };
          ms.mineStoneRelocations += 1;
          signals.push({
            evt: 'mission.relocate.queued',
            from: 'MINE_STONE',
            ...relocateTelemetry(ms.relocate, this.mineRelocateLimit),
          });
          return {
            intent: relocateNavIntent(ms.relocate, this.ttlMs),
            signals,
            objective: 'RELOCATE',
            done: false,
            replanned: false,
            source: 'relocate',
          };
        }

        ms.done = true;
        ms.terminalReason = 'aborted';
        ms.terminalObjective = 'ABORTED';
        signals.push({
          evt: 'mission.objective.exhausted',
          objective: 'MINE_STONE',
          reason: 'stone_origin_relocation_limit',
          attempts: ms.mineStoneRelocations,
          limit: this.mineRelocateLimit,
          trigger: 'stone_origin_no_safe_method',
          sourceCommandId: stoneOriginFailure.commandId,
          originalPosition: stoneOriginFailure.originalPosition,
        });
        signals.push({
          evt: 'mission.aborted',
          reason: 'stone_origin_relocation_limit',
          objective: 'MINE_STONE',
          detail: stoneOriginFailure.reason,
          attempts: ms.mineStoneRelocations,
          limit: this.mineRelocateLimit,
        });
        return {
          intent: idleIntent('aborted', this.ttlMs),
          signals,
          objective: 'ABORTED',
          done: true,
          replanned: false,
          source: 'aborted',
        };
      }
      const streakFailure = mineStoneInventorySatisfied || stoneOriginFailureAlreadyProcessed
        ? null
        : streakCommandFailureForObjective(ms.currentObjective, snapshot);
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
          if (failedObjective === 'MINE_STONE') {
            declineProvisionalSurfaceAnchor(ms, signals, 'stone_objective_repeated_command_failure', {
              completionReason: streakFailure,
            });
          }
          ms.currentObjective = null;
          escalatedRepeated = true;
          // R0 dead-column relocate: MINE_STONE pinned on a void-edge descent column the executor
          // cannot leave -- walk to a fresh column (rotating dir) before re-trying, bounded.
          if (failedObjective === 'MINE_STONE'
            && isDeadColumnDescentFailure(streakFailure)
            && ms.mineStoneRelocations < this.mineRelocateLimit) {
            const attempt = ms.mineStoneRelocations;
            const target = relocateTargetFor(snapshot, attempt, this.mineRelocateBlocks);
            ms.relocate = {
              ...target,
              from: 'MINE_STONE',
              attempt,
              startedAtMs: now,
              trigger: 'dead_column_descent',
              sourceCommandId: normalizedCommandId(context?.completedCommandId)
                || normalizedCommandId(snapshot?.currentCommandId),
              originalPosition: canonicalGroundedDryPosition(snapshot),
              limit: this.mineRelocateLimit,
            };
            ms.mineStoneRelocations += 1;
            signals.push({
              evt: 'mission.relocate.queued',
              from: 'MINE_STONE',
              ...relocateTelemetry(ms.relocate, this.mineRelocateLimit),
            });
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
        if (ms.currentObjective === 'MINE_STONE') {
          ms.mineStoneRelocations = 0;
          if (!ms.surfaceExcursionActive) {
            declineProvisionalSurfaceAnchor(ms, signals, 'stone_completed_without_grounded_descent');
          }
        }
        if (ms.currentObjective === 'MINE_IRON') {
          ms.ironSearchTriedHeadings.clear();
          ms.ironSearchPendingHeading = null;
          ms.lastIronPartialCompletionKey = null;
        }
        if (ms.currentObjective === 'SMELT_IRON') {
          ms.smeltLoadedRawBatch = 0;
          ms.smeltLoadedRawBaselineIngots = null;
          ms.smeltFuelProbeBatchSize = 0;
          ms.smeltFuelShortFingerprint = null;
        }
        if (ms.currentObjective === 'GATHER_WOOD') {
          ms.surfaceReturnRetryLatch = null;
          ms.surfaceReturnRetryAwaitingCommand = false;
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
        if (ms.currentObjective === 'MINE_STONE') {
          declineProvisionalSurfaceAnchor(
            ms,
            signals,
            wallClocked ? 'stone_objective_wall_clock_abandoned' : 'stone_objective_no_progress_abandoned',
          );
        }
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
      const recoveryObjective = recovery.recoveryObjective || recovery.objective || 'RECOVERY';
      const recoveryFrom = recoveryObjective.endsWith('_RECOVERY')
        ? recoveryObjective.slice(0, -'_RECOVERY'.length)
        : recoveryObjective;
      const missionIronRecovery = recovery.reason === 'mission:MINE_IRON_RECOVERY';
      const recoveryDepth = missionIronRecovery ? ironSearchRecoveryDepth(snapshot, recovery) : 0;
      if (missionIronRecovery) {
        const repeatedBlock = this.#rejectRepeatedIronToolReserveBlock(
          snapshot,
          signals,
          'recovery_preparation',
          { recoveryDepth },
        );
        if (repeatedBlock !== null) return repeatedBlock;
        const state = summarizeStatePlus(snapshot);
        const budget = ironAcquisitionToolBudget(snapshot, { recoveryDepth });
        if (!budget.recoveryReady) {
          const preparation = missionIronToolPreparationAction(state, budget, 'recoveryReady');
          if (preparation === null) {
            return this.#blockIronToolReserve(
              snapshot,
              signals,
              'recovery_preparation',
              { recoveryDepth },
            );
          }
          const preparationIntent = {
            action: preparation,
            ttlMs: this.ttlMs,
            reason: 'mission:MINE_IRON',
            objective: 'MINE_IRON',
          };
          this.#reportIronToolReserve(
            snapshot,
            preparationIntent,
            signals,
            'recovery_preparation',
            { recoveryDepth },
          );
          return {
            intent: preparationIntent,
            signals,
            objective: 'MINE_IRON',
            done: false,
            replanned: false,
            source: 'recovery_preparation',
          };
        }
      }
      ms.pendingRecoveryIntent = null;
      const trackObjective = recovery.trackObjective || null;
      let intent = { ...recovery };
      delete intent.recoveryObjective;
      delete intent.trackObjective;
      if (missionIronRecovery) {
        intent = withIronToolBudgetFields(intent, snapshot, { recoveryDepth });
        this.#reportIronToolReserve(snapshot, intent, signals, 'recovery_ready', { recoveryDepth });
      }
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
        if (fromObj === 'MINE_STONE') {
          declineProvisionalSurfaceAnchor(ms, signals, 'stone_objective_exhausted');
        }
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
    if (ms.currentObjective === 'GATHER_WOOD'
      && ms.surfaceExcursionActive
      && validSurfaceAnchor(ms.surfaceAnchor)
      && !ms.surfaceReturnPending
      && !objectiveAchieved('GATHER_WOOD', snapshot)) {
      ms.surfaceReturnPending = true;
      ms.surfaceReturnLastStableFeet = stableFeet;
      if (!ms.surfaceReturnStarted) {
        ms.surfaceReturnStarted = true;
        signals.push({
          evt: 'mission.surface_return.started',
          objective: 'GATHER_WOOD',
          anchor: ms.surfaceAnchor,
          position: stableFeet,
        });
      }
    }
    if (ms.currentObjective === 'MINE_IRON') {
      const repeatedBlock = this.#rejectRepeatedIronToolReserveBlock(
        snapshot,
        signals,
        'objective',
      );
      if (repeatedBlock !== null) return repeatedBlock;
    }
    const actionPlan = nextActionForObjective(ms.currentObjective, snapshot, {
      retrieveTableSkipped: ms.retrieveTableSkipped,
      surfaceAnchor: ms.surfaceAnchor,
      surfaceReturnPending: ms.surfaceReturnPending,
      smeltFuelShortFingerprint: ms.smeltFuelShortFingerprint,
      smeltLoadedRawBatch: ms.smeltLoadedRawBatch,
    });
    if (ms.currentObjective === 'DESCEND') {
      const manifest = miningManifestStatus(snapshot);
      const eventKey = JSON.stringify({
        missing: manifest.missing,
        required: manifest.requiredDurability,
        available: manifest.availableDurability,
        y: Number.isFinite(snapshot?.y) ? Math.floor(snapshot.y) : null,
      });
      if (manifest.ready && !ms.miningManifestReadyReported) {
        ms.miningManifestReadyReported = true;
        signals.push({
          evt: 'mission.mining_manifest.ready',
          objective: 'DESCEND',
          table: summarizeStatePlus(snapshot).craftingTables,
          sticks: summarizeStatePlus(snapshot).sticks,
          cobblestone: summarizeStatePlus(snapshot).cobblestone,
          requiredDurability: manifest.requiredDurability,
          availableDurability: manifest.availableDurability,
          nextDescentDepth: manifest.nextDescentDepth,
        });
      } else if (!manifest.ready && eventKey !== ms.miningManifestEventKey) {
        signals.push({
          evt: actionPlan === null ? 'mission.mining_manifest.blocked' : 'mission.mining_manifest.preparing',
          objective: 'DESCEND',
          missing: manifest.missing,
          requiredDurability: manifest.requiredDurability,
          availableDurability: manifest.availableDurability,
          nextDescentDepth: manifest.nextDescentDepth,
          action: typeof actionPlan === 'string' ? actionPlan : actionPlan?.action ?? null,
        });
      }
      ms.miningManifestEventKey = eventKey;
    } else {
      ms.miningManifestEventKey = null;
      ms.miningManifestReadyReported = false;
    }
    if (actionPlan === null) {
      if (ms.currentObjective === 'MINE_IRON') {
        return this.#blockIronToolReserve(snapshot, signals, 'objective');
      }
      if (ms.currentObjective === 'MINE_STONE') {
        declineProvisionalSurfaceAnchor(ms, signals, 'stone_objective_blocked_missing_inputs');
      }
      signals.push({ evt: 'mission.objective.blocked', objective: ms.currentObjective, reason: 'missing_inputs' });
      ms.lastOutcome = `blocked:${ms.currentObjective}:missing_inputs`;
      ms.currentObjective = null;
      return { intent: idleIntent('replan', this.ttlMs), signals, objective: null, done: false, replanned, source };
    }
    let intentFields = typeof actionPlan === 'string' ? { action: actionPlan } : actionPlan;
    if (ms.currentObjective === 'MINE_STONE'
      && intentFields.action === 'mine_nearby_stone'
      && !ms.surfaceExcursionActive
      && !validSurfaceAnchor(ms.surfaceProvisionalAnchor)) {
      const anchor = ms.surfaceLatestStable || stableFeet;
      if (validSurfaceAnchor(anchor)) {
        ms.surfaceProvisionalAnchor = { ...anchor };
        ms.surfaceProvisionalAnchorCommandId = null;
        signals.push({
          evt: 'mission.surface_return.anchor_frozen',
          objective: 'MINE_STONE',
          anchor: ms.surfaceProvisionalAnchor,
          provisional: true,
        });
      }
    }
    if (ms.currentObjective === 'DESCEND'
      && intentFields.action === 'descend_staircase'
      && !ms.surfaceExcursionActive) {
      declineProvisionalSurfaceAnchor(ms, signals, 'stone_command_replaced_by_primary_descent');
      const anchor = ms.surfaceLatestStable || stableFeet;
      if (validSurfaceAnchor(anchor)) {
        ms.surfaceAnchor = { ...anchor };
        ms.surfaceProvisionalAnchor = null;
        ms.surfaceProvisionalAnchorCommandId = null;
        ms.surfaceExcursionActive = true;
        ms.surfaceReturnPending = false;
        ms.surfaceReturnStarted = false;
        ms.surfaceReturnTerminalFeedbackKey = null;
        ms.surfaceReturnRetryLatch = null;
        ms.surfaceReturnRetryAwaitingCommand = false;
        ms.surfaceReturnLastStableFeet = null;
        signals.push({
          evt: 'mission.surface_return.anchor_frozen',
          objective: 'DESCEND',
          anchor: ms.surfaceAnchor,
        });
      }
    }
    if (ms.currentObjective === 'MINE_IRON' && intentFields.action === 'mine_nearby_iron') {
      intentFields = withIronHeading(intentFields, snapshot, ensureIronSearchHeading(ms, snapshot));
    }
    if (ms.currentObjective === 'MINE_IRON' && intentFields.action === 'mine_nearby_iron') {
      intentFields = withIronToolBudgetFields(intentFields, snapshot);
    }
    if (ms.currentObjective === 'MINE_IRON') this.#reportIronToolReserve(snapshot, intentFields, signals, 'objective');
    const ttlMs = intentFields.ttlMs ?? this.ttlMs;
    if (ms.currentObjective === 'SMELT_IRON' && intentFields.action === 'smelt_raw_iron') {
      const state = summarizeStatePlus(snapshot);
      const admission = rawIronFuelAdmission(
        ms.smeltLoadedRawBatch > 0 ? { ...state, rawIron: ms.smeltLoadedRawBatch } : state,
      );
      if (!admission.inventoryAdmitted
        && ms.smeltFuelProbeReportedFingerprint !== smeltFuelFingerprint) {
        ms.smeltFuelProbeReportedFingerprint = smeltFuelFingerprint;
        ms.smeltFuelProbeBatchSize = admission.batchSize;
        signals.push({
          evt: 'mission.smelt.fuel_probe',
          commandId: snapshot?.currentCommandId || null,
          objective: 'SMELT_IRON',
          batchSize: admission.batchSize,
          requiredWoodFuel: admission.woodFuelRequired,
          requiredEfficientFuel: admission.efficientFuelRequired,
          protectedPlanks: admission.protectedPlanks,
          sourceClass: admission.sourceClass,
          inventoryAdmitted: admission.inventoryAdmitted,
          coal: admission.coal,
          charcoal: admission.charcoal,
          logs: admission.logs,
          planks: admission.planks,
        });
      }
    }

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
