// Mission planner (Slice 1 brain-as-planner de-risk): can DeepSeek advise on the NEXT
// high-level objective for a multi-step survival mission, while deterministic code keeps
// the known-answer early-game spine safe?
//
// Architecture this proves out:
//   code = ORACLE   -> picks the known-correct objective on solved spine states.
//   LLM  = ADVISOR  -> consulted only when explicitly forced or when future branch points open.
//   code = EXECUTOR -> carries out the chosen objective (existing Java/JS deterministic skills).
// The brain decides WHAT to do next, never HOW. This is the opposite of the current adapter,
// which hardcodes the mission order in JS and uses the LLM only as a "not a reasoning test"
// target-picker.
//
// This module is intentionally PURE and dependency-free. The model call is INJECTED via
// opts.complete (a (messages, opts) => Promise<string> function), so:
//   - the offline suite runs with a mock at $0 / no network / no openai dep, and
//   - the live smoke passes the real advisor `complete` (src/advisor/deepseek.js).
//
// The early-game spine (wood -> wood tools -> stone -> stone tools -> furnace -> descend ->
// iron -> smelt -> iron tools -> iron armor) is a KNOWN-ANSWER test bed: `expectedObjective`
// is the deterministic oracle we GRADE the LLM against. We don't need the LLM to sequence the
// early game (the hardcoded router already can) — we need to prove it CAN plan on a problem we
// can grade, before trusting it on late-game branches where hardcoding every path is intractable.

export const MISSION_GOAL_SUMMARY =
  'Reach an iron pickaxe AND a full set of equipped iron armor, unless targetIronPickaxeOnly is true; then stop after the iron pickaxe. If targetDiamondTier is true, craft a diamond pickaxe. Stay fed.';

// Coarse thresholds for the early-game spine. The exact Minecraft economy is a Slice-2
// (in-world) concern; these only need to be self-consistent for grading objective choice.
export const THRESHOLDS = Object.freeze({
  woodForTools: 5, // logs (or planks) for wooden tools plus a small spare fuel/material reserve
  // 14 -> 20 (a live run): 18 logs still dipped below the 48-plank fuel floor after tool/table/stick
  // crafting, forcing a SECOND wood phase mid-mission — from bad terrain, with a spent explore
  // budget, it killed the run. 20 logs = 80 planks keeps the fuel floor clear with margin, so the
  // second phase disappears from the common case.
  woodForIronArmorMission: 20,
  planksForIronPickaxeMission: 18,
  planksForIronArmorMission: 48, // +4 (observed: a late stick-reserve wood detour outran the clock)
  cobbleForStoneTools: 4, // stone pickaxe (3) + stone sword (1); pickaxe-only missions need 3.
  stonePickaxesForIronArmorMission: 2,
  cobbleForFurnace: 8,
  ingotsForIronPickaxe: 3,
  ingotsForOneArmorPiece: 5, // a helmet's worth; coarse gate for "can craft some armor"
  eatFoodLevel: 6, // <= this is "hungry" (also MC's sprint-jump gate); fed = above this
  ironDepthY: 16, // y at/below this counts as iron depth when a flag isn't supplied
  diamondDepthY: -50, // conservative "safe enough to start diamond branch-mining" milestone
  diamondTargetY: -59,
  diamondsForPickaxe: 3,
  diamondPickaxesForProgress: 1,
  ironPickaxesForDiamondDescent: 2,
  minStonePickaxeRemainingForIronPhase: 32,
  minLastIronPickaxeRemainingForDiamond: 64,
});

// The objective catalog = the planner's bounded action space. Each id maps to an existing
// deterministic executor skill. `requires` / `summary` are shown to the LLM in the prompt.
export const OBJECTIVES = Object.freeze([
  { id: 'GATHER_WOOD', summary: 'Chop trees for logs.', requires: 'nothing' },
  { id: 'MAKE_WOOD_TOOLS', summary: 'Craft planks, sticks, a crafting table, and a wooden pickaxe.', requires: 'logs' },
  { id: 'MINE_STONE', summary: 'Mine cobblestone with a pickaxe.', requires: 'a wooden (or better) pickaxe' },
  { id: 'MAKE_STONE_TOOLS', summary: 'Craft a stone pickaxe and a stone sword.', requires: 'cobblestone and sticks' },
  { id: 'MAKE_FURNACE', summary: 'Craft a furnace.', requires: '8 cobblestone' },
  { id: 'DESCEND', summary: 'Dig a safe staircase down to iron depth.', requires: 'a stone pickaxe' },
  { id: 'MINE_IRON', summary: 'Mine raw iron ore.', requires: 'a stone pickaxe at iron depth' },
  { id: 'SMELT_IRON', summary: 'Smelt raw iron into iron ingots.', requires: 'a furnace, fuel, and raw iron' },
  { id: 'MAKE_IRON_TOOLS', summary: 'Craft an iron pickaxe.', requires: 'iron ingots and sticks' },
  { id: 'DESCEND_DEEP', summary: 'Dig a safe staircase down to diamond depth.', requires: 'an iron pickaxe' },
  { id: 'MINE_DIAMOND', summary: 'Mine diamond ore safely at diamond depth.', requires: 'an iron pickaxe at diamond depth' },
  { id: 'MAKE_DIAMOND_TOOLS', summary: 'Craft a diamond pickaxe.', requires: 'diamonds and sticks' },
  { id: 'MAKE_ARMOR', summary: 'Craft and equip a full set of iron armor.', requires: 'iron ingots' },
  { id: 'EAT', summary: 'Eat food to restore hunger.', requires: 'food in inventory and low hunger' },
  { id: 'DONE', summary: 'Mission complete: all goals met.', requires: 'the full goal achieved' },
]);

export const OBJECTIVE_IDS = Object.freeze(OBJECTIVES.map((o) => o.id));
const OBJECTIVE_ID_SET = new Set(OBJECTIVE_IDS);

const IRON_ARMOR_PIECES = [
  { slot: 'equippedHelmetItem', item: 'iron_helmet', count: 'ironHelmets', cost: 5 },
  { slot: 'equippedChestplateItem', item: 'iron_chestplate', count: 'ironChestplates', cost: 8 },
  { slot: 'equippedLeggingsItem', item: 'iron_leggings', count: 'ironLeggings', cost: 7 },
  { slot: 'equippedBootsItem', item: 'iron_boots', count: 'ironBoots', cost: 4 },
];

export function isObjectiveId(id) {
  return typeof id === 'string' && OBJECTIVE_ID_SET.has(id);
}

// First-class objective model. The LLM prompt still gets the compact catalog above; code uses
// these preconditions/effects to keep advisor choices bounded by the substrate's real capabilities.
export const OBJECTIVE_MODEL = Object.freeze({
  GATHER_WOOD: { effects: ['logs'], precondition: () => ({ ok: true, missing: [] }) },
  MAKE_WOOD_TOOLS: { effects: ['planks', 'sticks', 'crafting_table', 'wooden_pickaxe'], precondition: (s) => requireAny(s, [['logs', s.logs], ['planks', s.planks]], 1) },
  MINE_STONE: { effects: ['cobblestone'], precondition: (s) => requireAny(s, [['wooden_pickaxe', s.woodenPickaxes], ['stone_pickaxe', s.stonePickaxes], ['iron_pickaxe', s.ironPickaxes]], 1) },
  MAKE_STONE_TOOLS: {
    effects: ['stone_pickaxe', 'stone_sword'],
    precondition: (s) => requireAll([
      ['cobblestone', s.cobblestone, missingStoneToolCobble(s)],
      ['sticks_or_wood', hasStickMaterials(s) ? 1 : 0, 1],
      ['crafting_table_or_wood', hasCraftingTableAccessOrMaterials(s) ? 1 : 0, 1],
    ]),
  },
  MAKE_FURNACE: {
    effects: ['furnace'],
    precondition: (s) => requireAll([
      ['cobblestone', s.cobblestone, THRESHOLDS.cobbleForFurnace],
      ['crafting_table_or_wood', hasCraftingTableAccessOrMaterials(s) ? 1 : 0, 1],
    ]),
  },
  DESCEND: { effects: ['atIronDepth'], precondition: (s) => requireAny(s, [['stone_pickaxe', s.stonePickaxes], ['iron_pickaxe', s.ironPickaxes]], 1) },
  MINE_IRON: { effects: ['raw_iron'], precondition: (s) => requireAll([['iron_depth', s.atIronDepth ? 1 : 0, 1], ['pickaxe', s.stonePickaxes + s.ironPickaxes, 1]]) },
  // Fuel v2: at iron depth, zero fuel is satisfiable INSIDE the objective via
  // mine_nearby_coal, so the precondition accepts depth as fuel access — otherwise the selector's
  // at-depth choice would immediately block on missing_inputs.
  SMELT_IRON: { effects: ['iron_ingot'], precondition: (s) => requireAll([['raw_iron', s.rawIron, 1], ['fuel_or_minable_coal', (s.fuel >= 1 || s.atIronDepth) ? 1 : 0, 1], ['furnace', hasFurnace(s) ? 1 : 0, 1]]) },
  MAKE_IRON_TOOLS: {
    effects: ['iron_pickaxe'],
    precondition: (s) => requireAll([
      ['iron_ingot', s.ironIngots, THRESHOLDS.ingotsForIronPickaxe],
      ['sticks_or_wood', hasStickMaterials(s) ? 1 : 0, 1],
      ['crafting_table_or_wood', hasCraftingTableAccessOrMaterials(s) ? 1 : 0, 1],
    ]),
  },
  DESCEND_DEEP: { effects: ['atDiamondDepth'], precondition: (s) => requireAll([['iron_pickaxe', s.ironPickaxes, THRESHOLDS.ironPickaxesForDiamondDescent]]) },
  MINE_DIAMOND: { effects: ['diamond'], precondition: (s) => requireAll([['diamond_depth', s.atDiamondDepth ? 1 : 0, 1], ['iron_pickaxe', s.ironPickaxes, 1]]) },
  MAKE_DIAMOND_TOOLS: {
    effects: ['diamond_pickaxe'],
    precondition: (s) => requireAll([
      ['diamond', s.diamonds, THRESHOLDS.diamondsForPickaxe],
      ['sticks_or_wood', hasStickMaterials(s) ? 1 : 0, 1],
      ['crafting_table_or_wood', hasCraftingTableAccessOrMaterials(s) ? 1 : 0, 1],
    ]),
  },
  MAKE_ARMOR: {
    effects: ['equipped_iron_armor'],
    precondition: (s) => hasSpareForNextArmorPiece(s)
      ? { ok: true, missing: [] }
      : requireAll([
        ['iron_ingot', s.ironIngots, nextArmorIngotTarget(s)],
        ['crafting_table_or_wood', hasCraftingTableAccessOrMaterials(s) ? 1 : 0, 1],
      ]),
  },
  EAT: { effects: ['foodLevel'], precondition: (s) => requireAll([['hungry', isHungry(s) ? 1 : 0, 1], ['food', s.hasFood ? 1 : 0, 1]]) },
  DONE: { effects: ['mission_done'], precondition: (s) => ({ ok: missionComplete(s), missing: missionComplete(s) ? [] : ['mission_goal'] }) },
});

// ---------------------------------------------------------------------------
// State normalization
// ---------------------------------------------------------------------------

function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function boolish(value) {
  return value === true;
}

const EQUIPPED_ARMOR_SLOT_KEYS = [
  'equippedHelmetItem',
  'equippedChestplateItem',
  'equippedLeggingsItem',
  'equippedBootsItem',
];

function countEquippedIron(raw) {
  const ironPieces = new Set(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
  let n = 0;
  for (const key of EQUIPPED_ARMOR_SLOT_KEYS) {
    if (ironPieces.has(raw[key])) n += 1;
  }
  return n;
}

function hasEquippedArmorSlotEvidence(raw) {
  return EQUIPPED_ARMOR_SLOT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

function equippedArmorPieceCount(raw) {
  return hasEquippedArmorSlotEvidence(raw)
    ? countEquippedIron(raw)
    : num(raw.equippedArmorPieces ?? countEquippedIron(raw));
}

function requireAll(requirements) {
  const missing = [];
  for (const [name, value, min] of requirements) {
    if (num(value) < min) missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

function requireAny(_s, requirements, min) {
  const missing = [];
  for (const [name, value] of requirements) {
    if (num(value) >= min) return { ok: true, missing: [] };
    missing.push(name);
  }
  return { ok: false, missing };
}

// Accepts either a normalized state object (the fields below) OR a raw ClientSnapshot-shaped
// object (inventoryLogCount, equippedHelmetItem, ...). Normalized scalar counts win when present
// except equipped armor: explicit slot evidence is stricter and wins over aggregate counts.
export function summarizeState(raw = {}) {
  const r = raw || {};
  const logs = num(r.logs ?? r.inventoryLogCount);
  const planks = num(r.planks ?? r.inventoryPlankCount);
  const fuel = (r.fuel !== undefined
    ? num(r.fuel)
    : num(r.inventoryCoalCount) + num(r.inventoryCharcoalCount)) + planks + logs;
  const foodLevel = num(r.foodLevel, 20);
  const y = Number.isFinite(r.y) ? r.y : null;
  const atIronDepth = r.atIronDepth !== undefined
    ? boolish(r.atIronDepth)
    : (y !== null ? y <= THRESHOLDS.ironDepthY : false);
  const atDiamondDepth = r.atDiamondDepth !== undefined
    ? boolish(r.atDiamondDepth)
    : (y !== null ? y <= THRESHOLDS.diamondDepthY : false);
  return {
    __summarized: true,
    logs,
    planks,
    sticks: num(r.sticks ?? r.inventoryStickCount),
    craftingTables: num(r.craftingTables ?? r.inventoryCraftingTableCount),
    woodenPickaxes: num(r.woodenPickaxes ?? r.inventoryWoodenPickaxeCount),
    cobblestone: num(r.cobblestone ?? r.inventoryCobblestoneCount),
    stonePickaxes: num(r.stonePickaxes ?? r.inventoryStonePickaxeCount),
    bestStonePickaxeRemaining: num(
      r.bestStonePickaxeRemaining ?? r.inventoryBestStonePickaxeRemainingDurability ?? r.inventoryStonePickaxeBestRemainingDurability,
      -1,
    ),
    stoneSwords: num(r.stoneSwords ?? r.inventoryStoneSwordCount),
    furnaces: num(r.furnaces ?? r.inventoryFurnaceCount),
    fuel,
    rawIron: num(r.rawIron ?? r.inventoryRawIronCount),
    ironIngots: num(r.ironIngots ?? r.inventoryIronIngotCount),
    ironPickaxes: num(r.ironPickaxes ?? r.inventoryIronPickaxeCount),
    bestIronPickaxeRemaining: num(
      r.bestIronPickaxeRemaining ?? r.inventoryBestIronPickaxeRemainingDurability ?? r.inventoryIronPickaxeBestRemainingDurability,
      -1,
    ),
    diamonds: num(r.diamonds ?? r.inventoryDiamondCount),
    diamondPickaxes: num(r.diamondPickaxes ?? r.inventoryDiamondPickaxeCount),
    ironHelmets: num(r.ironHelmets ?? r.inventoryIronHelmetCount),
    ironChestplates: num(r.ironChestplates ?? r.inventoryIronChestplateCount),
    ironLeggings: num(r.ironLeggings ?? r.inventoryIronLeggingsCount),
    ironBoots: num(r.ironBoots ?? r.inventoryIronBootsCount),
    equippedHelmetItem: r.equippedHelmetItem || '',
    equippedChestplateItem: r.equippedChestplateItem || '',
    equippedLeggingsItem: r.equippedLeggingsItem || '',
    equippedBootsItem: r.equippedBootsItem || '',
    targetDiamondTier: boolish(r.targetDiamondTier) || boolish(r.targetDiamondGoal) || r.goal === 'diamond' || r.missionGoal === 'diamond',
    targetIronPickaxeOnly: boolish(r.targetIronPickaxeOnly) || r.goal === 'iron_pickaxe' || r.missionGoal === 'iron_pickaxe' || r.missionGoal === 'iron_pickaxe_only',
    equippedArmorPieces: equippedArmorPieceCount(r),
    foodLevel,
    hasFood: boolish(r.hasFood),
    atIronDepth,
    atDiamondDepth,
    threatPresent: boolish(r.threatPresent),
    // A PLACED furnace/table (block in reach) vs the inventory ITEM: placing consumes the item, so the
    // planner must treat a placed furnace as "have furnace" or it loops re-crafting one after placing.
    furnacePlaced: boolish(r.furnacePlaced) || boolish(r.furnaceInReach),
    tablePlaced: boolish(r.tablePlaced) || boolish(r.craftingTableInReach),
  };
}

// Compact, decision-relevant view sent to the LLM (binary milestones as booleans to keep it crisp).
export function plannerStateView(rawOrSummary = {}) {
  const s = rawOrSummary.__summarized ? rawOrSummary : summarizeState(rawOrSummary);
  return {
    logs: s.logs,
    planks: s.planks,
    sticks: s.sticks,
    hasWoodenPickaxe: s.woodenPickaxes >= 1,
    cobblestone: s.cobblestone,
    hasStonePickaxe: s.stonePickaxes >= 1,
    stonePickaxes: s.stonePickaxes,
    bestStonePickaxeRemaining: s.bestStonePickaxeRemaining,
    hasStoneSword: s.stoneSwords >= 1,
    hasFurnace: s.furnaces >= 1 || s.furnacePlaced,
    hasTable: s.tablePlaced || s.craftingTables >= 1,
    fuel: s.fuel,
    rawIron: s.rawIron,
    ironIngots: s.ironIngots,
    hasIronPickaxe: s.ironPickaxes >= 1,
    ironPickaxes: s.ironPickaxes,
    bestIronPickaxeRemaining: s.bestIronPickaxeRemaining,
    diamonds: s.diamonds,
    hasDiamondPickaxe: s.diamondPickaxes >= 1,
    diamondPickaxes: s.diamondPickaxes,
    spareIronArmorPieces: spareIronArmorPieces(s),
    targetDiamondTier: s.targetDiamondTier,
    targetIronPickaxeOnly: s.targetIronPickaxeOnly,
    equippedIronArmorPieces: s.equippedArmorPieces,
    foodLevel: s.foodLevel,
    hasFood: s.hasFood,
    atIronDepth: s.atIronDepth,
    atDiamondDepth: s.atDiamondDepth,
    threatNearby: s.threatPresent,
  };
}

// ---------------------------------------------------------------------------
// Milestones, goal, and the deterministic oracle (grading reference)
// ---------------------------------------------------------------------------

function isHungry(s) {
  return s.foodLevel <= THRESHOLDS.eatFoodLevel;
}

function requiredWoodMaterial(s) {
  return !s.targetIronPickaxeOnly && !s.targetDiamondTier
    ? {
      logs: THRESHOLDS.woodForIronArmorMission,
      planks: THRESHOLDS.planksForIronArmorMission,
    }
    : {
      logs: THRESHOLDS.woodForTools,
      planks: THRESHOLDS.planksForIronPickaxeMission,
    };
}

function hasWoodMaterial(s) {
  const required = requiredWoodMaterial(s);
  return s.logs >= required.logs || s.planks >= required.planks;
}

function hasStickMaterials(s) {
  return s.sticks >= 2 || s.planks >= 2 || s.logs >= 1;
}

function hasCraftingTableAccessOrMaterials(s) {
  return s.tablePlaced || s.craftingTables >= 1 || s.planks >= 4 || s.logs >= 1;
}

function hasIronToolCraftAccess(s) {
  return hasStickMaterials(s) && hasCraftingTableAccessOrMaterials(s);
}

function placedTableNeedsRetrieval(s) {
  return s.tablePlaced && s.craftingTables < 1;
}

function woodToolsDone(s) {
  // Having any pickaxe means the wooden-tool stage was cleared (the wooden pickaxe may have
  // been upgraded/discarded since).
  return s.woodenPickaxes >= 1 || s.stonePickaxes >= 1 || s.ironPickaxes >= 1;
}

function stoneToolsDone(s) {
  // An iron pickaxe implies the stone stage was cleared.
  if (s.ironPickaxes >= 1) return true;
  if (!hasRequiredStonePickaxes(s)) return false;
  if (s.targetIronPickaxeOnly) return true;
  return s.stoneSwords >= 1;
}

function requiredStoneToolCobble(s) {
  const swordCost = s.targetIronPickaxeOnly ? 0 : 1;
  return requiredStonePickaxeCount(s) * 3 + swordCost;
}

function requiredStonePickaxeCount(s) {
  if (s.targetIronPickaxeOnly) return 1;
  return THRESHOLDS.stonePickaxesForIronArmorMission;
}

function hasLowStonePickaxeForIronPhase(s) {
  return s.ironPickaxes < 1
    && s.stonePickaxes >= 1
    && s.bestStonePickaxeRemaining >= 0
    && s.bestStonePickaxeRemaining < THRESHOLDS.minStonePickaxeRemainingForIronPhase;
}

function missingStonePickaxeCount(s) {
  const missingRequired = Math.max(0, requiredStonePickaxeCount(s) - s.stonePickaxes);
  return missingRequired + (hasLowStonePickaxeForIronPhase(s) ? 1 : 0);
}

function missingStoneToolCobble(s) {
  const missingSword = s.targetIronPickaxeOnly || s.stoneSwords >= 1 ? 0 : 1;
  return missingStonePickaxeCount(s) * 3 + missingSword;
}

function hasRequiredStonePickaxes(s) {
  return s.stonePickaxes >= requiredStonePickaxeCount(s) && !hasLowStonePickaxeForIronPhase(s);
}

function requiredSurfaceStoneReserve(s) {
  const furnaceReserve = hasFurnace(s) ? 0 : THRESHOLDS.cobbleForFurnace;
  return missingStoneToolCobble(s) + furnaceReserve;
}

function hasFurnace(s) {
  return s.furnaces >= 1 || s.furnacePlaced; // an item we can place, OR one already placed
}

function spareIronArmorPieces(s) {
  return num(s.ironHelmets) + num(s.ironChestplates) + num(s.ironLeggings) + num(s.ironBoots);
}

function nextArmorPiece(s) {
  for (const piece of IRON_ARMOR_PIECES) {
    if (s[piece.slot] !== piece.item) return piece;
  }
  return null;
}

function hasSpareForNextArmorPiece(s) {
  const piece = nextArmorPiece(s);
  return piece ? num(s[piece.count]) > 0 : false;
}

function nextArmorIngotTarget(s) {
  const piece = nextArmorPiece(s);
  if (!piece) return 0;
  return num(s[piece.count]) > 0 ? 0 : piece.cost;
}

function canSmelt(s) {
  return hasFurnace(s) && s.fuel > 0 && s.rawIron > 0;
}

function needsFuelForRawIron(s) {
  return s.rawIron > 0 && s.fuel <= 0;
}

// Fuel v2, selector layer (an observed regression root cause): fuel-out with raw iron banked must NOT flip the
// objective to GATHER_WOOD while the bot is AT DEPTH — coal is minable right there, and the
// underground wood search is unwinnable (runs 18/22 died exactly this way). At depth the objective
// stays SMELT_IRON; its action layer then issues mine_nearby_coal.
function fuelObjectiveFor(s) {
  return s.atIronDepth ? 'SMELT_IRON' : 'GATHER_WOOD';
}

function needsDiamondSparePickaxe(s) {
  return s.targetDiamondTier
    && !s.atDiamondDepth
    && s.ironPickaxes < THRESHOLDS.ironPickaxesForDiamondDescent;
}

function nextIronIngotTarget(s) {
  if (s.ironPickaxes < 1 || needsDiamondSparePickaxe(s)) {
    return THRESHOLDS.ingotsForIronPickaxe;
  }
  if (!s.targetIronPickaxeOnly && !s.targetDiamondTier && s.equippedArmorPieces < 4) {
    return nextArmorIngotTarget(s);
  }
  return 0;
}

export function missionComplete(rawOrSummary) {
  const s = rawOrSummary.__summarized ? rawOrSummary : summarizeState(rawOrSummary);
  if (s.targetDiamondTier) {
    return s.diamondPickaxes >= THRESHOLDS.diamondPickaxesForProgress && !isHungry(s);
  }
  if (s.targetIronPickaxeOnly) {
    return s.ironPickaxes >= 1 && !isHungry(s);
  }
  return s.ironPickaxes >= 1 && s.equippedArmorPieces >= 4 && !isHungry(s);
}

// The canonical next objective for a given state. Encodes the known-correct early-game
// progression with a survival interrupt. Used to GRADE the LLM's choice.
export function expectedObjective(raw) {
  const s = summarizeState(raw);

  if (missionComplete(s)) return 'DONE';
  if (isHungry(s) && s.hasFood) return 'EAT';

  if (!woodToolsDone(s)) {
    return hasWoodMaterial(s) ? 'MAKE_WOOD_TOOLS' : 'GATHER_WOOD';
  }
  if (!stoneToolsDone(s)) {
    if (s.cobblestone < requiredSurfaceStoneReserve(s)) return 'MINE_STONE';
    return hasCraftingTableAccessOrMaterials(s) ? 'MAKE_STONE_TOOLS' : 'GATHER_WOOD';
  }
  if (!hasFurnace(s)) {
    if (s.cobblestone < THRESHOLDS.cobbleForFurnace) return 'MINE_STONE';
    return hasCraftingTableAccessOrMaterials(s) ? 'MAKE_FURNACE' : 'GATHER_WOOD';
  }
  // From here we need iron ingots to craft gear. Mine -> smelt -> craft.
  if (s.ironPickaxes < 1) {
    if (s.ironIngots >= THRESHOLDS.ingotsForIronPickaxe) {
      return hasIronToolCraftAccess(s) ? 'MAKE_IRON_TOOLS' : 'GATHER_WOOD';
    }
    if (canSmelt(s)) return 'SMELT_IRON';
    if (needsFuelForRawIron(s)) return fuelObjectiveFor(s);
    if (!s.atIronDepth) return hasCraftingTableAccessOrMaterials(s) ? 'DESCEND' : 'GATHER_WOOD';
    return canSmelt(s) ? 'SMELT_IRON' : 'MINE_IRON';
  }
  if (needsDiamondSparePickaxe(s)) {
    if (s.ironIngots >= THRESHOLDS.ingotsForIronPickaxe) {
      return hasIronToolCraftAccess(s) ? 'MAKE_IRON_TOOLS' : 'GATHER_WOOD';
    }
    if (canSmelt(s)) return 'SMELT_IRON';
    if (needsFuelForRawIron(s)) return fuelObjectiveFor(s);
    if (!s.atIronDepth) return hasCraftingTableAccessOrMaterials(s) ? 'DESCEND' : 'GATHER_WOOD';
    return canSmelt(s) ? 'SMELT_IRON' : 'MINE_IRON';
  }
  if (s.targetDiamondTier && !s.atDiamondDepth) return 'DESCEND_DEEP';
  if (s.targetDiamondTier && s.diamonds < THRESHOLDS.diamondsForPickaxe) return 'MINE_DIAMOND';
  if (s.targetDiamondTier && s.diamondPickaxes < THRESHOLDS.diamondPickaxesForProgress) {
    return hasIronToolCraftAccess(s) ? 'MAKE_DIAMOND_TOOLS' : 'GATHER_WOOD';
  }
  if (s.equippedArmorPieces < 4) {
    const armorIngotTarget = nextArmorIngotTarget(s);
    if (hasSpareForNextArmorPiece(s)) return 'MAKE_ARMOR';
    if (armorIngotTarget > 0 && s.ironIngots >= armorIngotTarget) {
      return hasCraftingTableAccessOrMaterials(s) ? 'MAKE_ARMOR' : 'GATHER_WOOD';
    }
    if (canSmelt(s)) return 'SMELT_IRON';
    if (needsFuelForRawIron(s)) return fuelObjectiveFor(s);
    if (!s.atIronDepth) return hasCraftingTableAccessOrMaterials(s) ? 'DESCEND' : 'GATHER_WOOD';
    return canSmelt(s) ? 'SMELT_IRON' : 'MINE_IRON';
  }
  return 'DONE';
}

// Acceptable set for grading: the oracle's pick, plus tolerated reasonable alternatives.
export function acceptableObjectives(raw) {
  const s = summarizeState(raw);
  const set = new Set([expectedObjective(raw)]);
  // Survival is always a defensible choice when hungry with food on hand.
  if (isHungry(s) && s.hasFood) set.add('EAT');
  // When ingots are on hand and the pickaxe exists, crafting either remaining gear is fine.
  if (s.atIronDepth && s.ironPickaxes >= 1 && s.equippedArmorPieces < 4 && s.ironIngots >= nextArmorIngotTarget(s)) {
    set.add('MAKE_ARMOR');
  }
  return set;
}

export function objectivePreconditionStatus(objectiveId, raw) {
  const model = OBJECTIVE_MODEL[objectiveId];
  if (!model) return { ok: false, missing: ['unknown_objective'] };
  return model.precondition(summarizeState(raw));
}

export function objectivePreconditionsMet(objectiveId, raw) {
  return objectivePreconditionStatus(objectiveId, raw).ok;
}

export function objectiveEffects(objectiveId) {
  return OBJECTIVE_MODEL[objectiveId]?.effects || [];
}

export function gradeChoice(raw, objective) {
  const acceptable = acceptableObjectives(raw);
  return {
    correct: acceptable.has(objective),
    expected: expectedObjective(raw),
    acceptable: [...acceptable],
  };
}

// Postcondition per objective — "did this objective's intended effect register in state?"
// Used by the executor loop (Slice 2) for done/stall detection and by tests.
export function objectiveAchieved(objectiveId, raw) {
  const s = summarizeState(raw);
  switch (objectiveId) {
    case 'GATHER_WOOD': return hasWoodMaterial(s);
    case 'MAKE_WOOD_TOOLS': return woodToolsDone(s) && !placedTableNeedsRetrieval(s);
    case 'MINE_STONE': {
      const targetCobble = !stoneToolsDone(s)
        ? requiredSurfaceStoneReserve(s)
        : (hasFurnace(s) ? requiredStoneToolCobble(s) : THRESHOLDS.cobbleForFurnace);
      return s.cobblestone >= targetCobble;
    }
    case 'MAKE_STONE_TOOLS': return stoneToolsDone(s) && !placedTableNeedsRetrieval(s);
    case 'MAKE_FURNACE': return s.furnaces >= 1 || s.furnacePlaced;
    case 'DESCEND': return s.atIronDepth;
    case 'DESCEND_DEEP': return s.atDiamondDepth;
    case 'MINE_IRON': {
      const targetIngots = nextIronIngotTarget(s);
      return targetIngots > 0
        ? s.ironIngots + s.rawIron >= targetIngots
        : s.rawIron > 0;
    }
    case 'MINE_DIAMOND': return s.diamonds >= THRESHOLDS.diamondsForPickaxe;
    case 'MAKE_DIAMOND_TOOLS': return s.diamondPickaxes >= THRESHOLDS.diamondPickaxesForProgress;
    case 'SMELT_IRON': {
      const targetIngots = nextIronIngotTarget(s);
      return targetIngots > 0
        ? s.ironIngots >= targetIngots
        : s.ironIngots > 0 && s.rawIron <= 0;
    }
    case 'MAKE_IRON_TOOLS': return s.ironPickaxes >= (needsDiamondSparePickaxe(s) ? THRESHOLDS.ironPickaxesForDiamondDescent : 1);
    case 'MAKE_ARMOR': return s.equippedArmorPieces >= 4;
    case 'EAT': return !isHungry(s);
    case 'DONE': return missionComplete(s);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Prompt + parsing + the LLM-driven choice
// ---------------------------------------------------------------------------

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function catalogText() {
  return OBJECTIVES.map((o) => `- ${o.id}: ${o.summary} (needs: ${o.requires})`).join('\n');
}

export function buildPlannerPrompt(raw, opts = {}) {
  const currentObjective = nonEmpty(opts.currentObjective) || 'none';
  const lastOutcome = nonEmpty(opts.lastOutcome) || 'none';
  const system = [
    'You are the mission planner for an autonomous Minecraft survival bot.',
    `GOAL: ${MISSION_GOAL_SUMMARY}`,
    'You choose the SINGLE next high-level objective. A separate deterministic system executes it;',
    'you decide WHAT to do next, not HOW.',
    'Available objectives (choose exactly one id):',
    catalogText(),
    'Rules:',
    '- Pick the one objective that best advances the GOAL from the current state.',
    '- Respect MATERIAL preconditions: never pick an objective whose raw materials are missing',
    '  (e.g., do not MAKE_STONE_TOOLS without cobblestone, do not SMELT_IRON without fuel and raw iron).',
    '- BUT crafting tables and furnaces are placed/crafted AUTOMATICALLY by the executor when an objective',
    '  needs one. Do NOT pick MAKE_WOOD_TOOLS or MAKE_FURNACE merely to obtain a table — once you have the',
    '  materials for an objective (e.g. iron ingots + sticks -> MAKE_IRON_TOOLS), pick it directly even if no',
    '  table is placed yet.',
    '- Survival first: if hunger is low and you have food, choose EAT.',
    '- If the current objective failed or stalled, choose a sensible recovery — usually re-acquire the missing input.',
    '- Set "done" to true ONLY when the full GOAL is already met; then use objective "DONE".',
    '- Choose ONLY an id from the list above.',
    'Respond with a strict JSON object and nothing else:',
    '{"objective":"<ID>","done":<true|false>,"reason":"<max 8 words>"}',
  ].join('\n');
  const user = [
    `Current objective: ${currentObjective}`,
    `Last outcome: ${lastOutcome}`,
    `State: ${JSON.stringify(plannerStateView(raw))}`,
    'Choose the next objective as JSON.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function stripFences(text) {
  return String(text ?? '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

export function parsePlannerReply(content) {
  const text = stripFences(content);
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { obj = JSON.parse(match[0]); } catch { obj = null; }
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'unparseable' };
  }
  const objective = typeof obj.objective === 'string' ? obj.objective.trim().toUpperCase() : '';
  if (!isObjectiveId(objective)) {
    return { ok: false, error: 'objective_not_in_catalog', objective };
  }
  const done = obj.done === true || objective === 'DONE';
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 64) : '';
  return { ok: true, objective, done, reason };
}

export function plannerBranchOptions(_raw, _opts = {}) {
  // No unsolved branch point is delegated to the LLM in the current iron+armor milestone.
  // Future additions should return a non-empty set only when several objective choices are
  // genuinely substrate-safe and materially different.
  return [];
}

export function shouldConsultPlanner(raw, opts = {}) {
  if (opts.forceLlm === true) return true;
  if (opts.oraclePrimary === false) return true;
  return plannerBranchOptions(raw, opts).length > 0;
}

function oracleDecision(raw, reason = 'oracle') {
  const objective = expectedObjective(raw);
  return {
    objective,
    done: missionComplete(raw),
    reason,
    source: 'oracle',
    raw: '',
  };
}

// Drives one planning step. `opts.complete(messages, opts)` is the injected model call.
// On any parse/validation/model failure we fall back to the deterministic oracle so the
// loop never wedges and the planner can never emit an out-of-catalog (unbounded) action.
export async function chooseNextObjective(raw, opts = {}) {
  if (!shouldConsultPlanner(raw, opts)) {
    return oracleDecision(raw);
  }
  const complete = opts.complete;
  if (typeof complete !== 'function') {
    throw new Error('chooseNextObjective requires opts.complete(messages, opts) when LLM consultation is enabled');
  }
  const messages = buildPlannerPrompt(raw, opts);
  let content = '';
  let modelError = null;
  try {
    content = await complete(messages, {
      responseFormatJson: true,
      temperature: opts.temperature ?? 0,
      // DeepSeek reasoning models spend hidden tokens before emitting the answer; too low a
      // cap truncates the JSON (finish_reason=length, empty content). Give real headroom —
      // the call is infrequent (once per objective) so the token cost is negligible.
      maxTokens: opts.maxTokens ?? 2048,
      model: opts.model,
      costGuard: opts.costGuard,
      metricsSource: opts.metricsSource || 'fabric_mission_planner',
    });
  } catch (err) {
    modelError = err;
  }

  const parsed = modelError ? { ok: false, error: 'model_error' } : parsePlannerReply(content);
  if (parsed.ok) {
    const completeNow = missionComplete(raw);
    if ((parsed.done || parsed.objective === 'DONE') && !completeNow) {
      return {
        ...oracleDecision(raw, 'guard:model_done_before_goal'),
        source: 'oracle_guard',
        raw: content,
        error: 'model_done_before_goal',
      };
    }
    const preconditions = objectivePreconditionStatus(parsed.objective, raw);
    if (!preconditions.ok) {
      return {
        ...oracleDecision(raw, `guard:missing:${preconditions.missing.join(',')}`),
        source: 'oracle_guard',
        raw: content,
        error: `precondition_failed:${preconditions.missing.join(',')}`,
      };
    }
    return {
      objective: parsed.objective,
      done: completeNow,
      reason: parsed.reason,
      source: 'llm',
      raw: content,
    };
  }

  const fallback = expectedObjective(raw);
  return {
    objective: fallback,
    done: missionComplete(raw),
    reason: `fallback:${parsed.error || 'invalid'}`,
    source: 'fallback',
    raw: content,
    error: modelError ? String(modelError.message || modelError) : parsed.error,
  };
}

export default {
  MISSION_GOAL_SUMMARY,
  THRESHOLDS,
  OBJECTIVES,
  OBJECTIVE_MODEL,
  OBJECTIVE_IDS,
  isObjectiveId,
  summarizeState,
  plannerStateView,
  missionComplete,
  expectedObjective,
  acceptableObjectives,
  objectivePreconditionStatus,
  objectivePreconditionsMet,
  objectiveEffects,
  gradeChoice,
  objectiveAchieved,
  buildPlannerPrompt,
  parsePlannerReply,
  plannerBranchOptions,
  shouldConsultPlanner,
  chooseNextObjective,
};
