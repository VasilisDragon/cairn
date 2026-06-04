// Mission planner (Slice 1 brain-as-planner de-risk): can DeepSeek choose the NEXT
// high-level objective for a multi-step survival mission, and recover when one fails?
//
// Architecture this proves out:
//   LLM  = PLANNER  -> picks the single next objective id from a vetted catalog.
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
  'Reach an iron pickaxe AND a full set of equipped iron armor (helmet, chestplate, leggings, boots), and stay fed.';

// Coarse thresholds for the early-game spine. The exact Minecraft economy is a Slice-2
// (in-world) concern; these only need to be self-consistent for grading objective choice.
export const THRESHOLDS = Object.freeze({
  woodForTools: 3, // logs (or planks) needed before crafting wooden tools is sensible
  cobbleForStoneTools: 4, // stone pickaxe (3) + stone sword (1)
  cobbleForFurnace: 8,
  ingotsForIronPickaxe: 3,
  ingotsForOneArmorPiece: 5, // a helmet's worth; coarse gate for "can craft some armor"
  eatFoodLevel: 6, // <= this is "hungry" (also MC's sprint-jump gate); fed = above this
  ironDepthY: 16, // y at/below this counts as iron depth when a flag isn't supplied
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
  { id: 'MINE_IRON', summary: 'Mine raw iron ore (and coal for fuel).', requires: 'a stone pickaxe at iron depth' },
  { id: 'SMELT_IRON', summary: 'Smelt raw iron into iron ingots.', requires: 'a furnace, fuel, and raw iron' },
  { id: 'MAKE_IRON_TOOLS', summary: 'Craft an iron pickaxe.', requires: 'iron ingots and sticks' },
  { id: 'MAKE_ARMOR', summary: 'Craft and equip a full set of iron armor.', requires: 'iron ingots' },
  { id: 'EAT', summary: 'Eat food to restore hunger.', requires: 'food in inventory and low hunger' },
  { id: 'DONE', summary: 'Mission complete: all goals met.', requires: 'the full goal achieved' },
]);

export const OBJECTIVE_IDS = Object.freeze(OBJECTIVES.map((o) => o.id));
const OBJECTIVE_ID_SET = new Set(OBJECTIVE_IDS);

export function isObjectiveId(id) {
  return typeof id === 'string' && OBJECTIVE_ID_SET.has(id);
}

// ---------------------------------------------------------------------------
// State normalization
// ---------------------------------------------------------------------------

function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function boolish(value) {
  return value === true;
}

function countEquippedIron(raw) {
  const ironPieces = new Set(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
  let n = 0;
  for (const key of ['equippedHelmetItem', 'equippedChestplateItem', 'equippedLeggingsItem', 'equippedBootsItem']) {
    if (ironPieces.has(raw[key])) n += 1;
  }
  return n;
}

// Accepts either a normalized state object (the fields below) OR a raw ClientSnapshot-shaped
// object (inventoryLogCount, equippedHelmetItem, ...). Normalized keys win when present.
export function summarizeState(raw = {}) {
  const r = raw || {};
  const fuel = r.fuel !== undefined
    ? num(r.fuel)
    : num(r.inventoryCoalCount) + num(r.inventoryCharcoalCount);
  const foodLevel = num(r.foodLevel, 20);
  const y = Number.isFinite(r.y) ? r.y : null;
  const atIronDepth = r.atIronDepth !== undefined
    ? boolish(r.atIronDepth)
    : (y !== null ? y <= THRESHOLDS.ironDepthY : false);
  return {
    logs: num(r.logs ?? r.inventoryLogCount),
    planks: num(r.planks ?? r.inventoryPlankCount),
    sticks: num(r.sticks ?? r.inventoryStickCount),
    craftingTables: num(r.craftingTables ?? r.inventoryCraftingTableCount),
    woodenPickaxes: num(r.woodenPickaxes ?? r.inventoryWoodenPickaxeCount),
    cobblestone: num(r.cobblestone ?? r.inventoryCobblestoneCount),
    stonePickaxes: num(r.stonePickaxes ?? r.inventoryStonePickaxeCount),
    stoneSwords: num(r.stoneSwords ?? r.inventoryStoneSwordCount),
    furnaces: num(r.furnaces ?? r.inventoryFurnaceCount),
    fuel,
    rawIron: num(r.rawIron ?? r.inventoryRawIronCount),
    ironIngots: num(r.ironIngots ?? r.inventoryIronIngotCount),
    ironPickaxes: num(r.ironPickaxes ?? r.inventoryIronPickaxeCount),
    equippedArmorPieces: num(r.equippedArmorPieces ?? countEquippedIron(r)),
    foodLevel,
    hasFood: boolish(r.hasFood),
    atIronDepth,
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
    hasStoneSword: s.stoneSwords >= 1,
    hasFurnace: s.furnaces >= 1 || s.furnacePlaced,
    hasTable: s.tablePlaced || s.craftingTables >= 1,
    fuel: s.fuel,
    rawIron: s.rawIron,
    ironIngots: s.ironIngots,
    hasIronPickaxe: s.ironPickaxes >= 1,
    equippedIronArmorPieces: s.equippedArmorPieces,
    foodLevel: s.foodLevel,
    hasFood: s.hasFood,
    atIronDepth: s.atIronDepth,
    threatNearby: s.threatPresent,
  };
}

// ---------------------------------------------------------------------------
// Milestones, goal, and the deterministic oracle (grading reference)
// ---------------------------------------------------------------------------

function isHungry(s) {
  return s.foodLevel <= THRESHOLDS.eatFoodLevel;
}

function hasWoodMaterial(s) {
  return s.logs >= THRESHOLDS.woodForTools || s.planks >= THRESHOLDS.woodForTools;
}

function woodToolsDone(s) {
  // Having any pickaxe means the wooden-tool stage was cleared (the wooden pickaxe may have
  // been upgraded/discarded since).
  return s.woodenPickaxes >= 1 || s.stonePickaxes >= 1 || s.ironPickaxes >= 1;
}

function stoneToolsDone(s) {
  // An iron pickaxe implies the stone stage was cleared.
  return (s.stonePickaxes >= 1 && s.stoneSwords >= 1) || s.ironPickaxes >= 1;
}

function hasFurnace(s) {
  return s.furnaces >= 1 || s.furnacePlaced; // an item we can place, OR one already placed
}

function canSmelt(s) {
  return hasFurnace(s) && s.fuel > 0 && s.rawIron > 0;
}

export function missionComplete(rawOrSummary) {
  const s = rawOrSummary.__summarized ? rawOrSummary : summarizeState(rawOrSummary);
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
    return s.cobblestone < THRESHOLDS.cobbleForStoneTools ? 'MINE_STONE' : 'MAKE_STONE_TOOLS';
  }
  if (!hasFurnace(s)) {
    return s.cobblestone < THRESHOLDS.cobbleForFurnace ? 'MINE_STONE' : 'MAKE_FURNACE';
  }
  if (!s.atIronDepth) return 'DESCEND';

  // From here we need iron ingots to craft gear. Mine -> smelt -> craft.
  if (s.ironPickaxes < 1) {
    if (s.ironIngots >= THRESHOLDS.ingotsForIronPickaxe) return 'MAKE_IRON_TOOLS';
    return canSmelt(s) ? 'SMELT_IRON' : 'MINE_IRON';
  }
  if (s.equippedArmorPieces < 4) {
    if (s.ironIngots >= THRESHOLDS.ingotsForOneArmorPiece) return 'MAKE_ARMOR';
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
  if (s.atIronDepth && s.ironPickaxes >= 1 && s.equippedArmorPieces < 4 && s.ironIngots >= THRESHOLDS.ingotsForOneArmorPiece) {
    set.add('MAKE_ARMOR');
  }
  return set;
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
    case 'MAKE_WOOD_TOOLS': return woodToolsDone(s);
    case 'MINE_STONE': return s.cobblestone >= THRESHOLDS.cobbleForStoneTools;
    case 'MAKE_STONE_TOOLS': return stoneToolsDone(s);
    case 'MAKE_FURNACE': return s.furnaces >= 1 || s.furnacePlaced;
    case 'DESCEND': return s.atIronDepth;
    case 'MINE_IRON': return s.rawIron > 0 || s.ironIngots > 0;
    case 'SMELT_IRON': return s.ironIngots > 0;
    case 'MAKE_IRON_TOOLS': return s.ironPickaxes >= 1;
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

// Drives one planning step. `opts.complete(messages, opts)` is the injected model call.
// On any parse/validation/model failure we fall back to the deterministic oracle so the
// loop never wedges and the planner can never emit an out-of-catalog (unbounded) action.
export async function chooseNextObjective(raw, opts = {}) {
  const complete = opts.complete;
  if (typeof complete !== 'function') {
    throw new Error('chooseNextObjective requires opts.complete(messages, opts) function');
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
    return {
      objective: parsed.objective,
      done: parsed.done,
      reason: parsed.reason,
      source: 'llm',
      raw: content,
    };
  }

  const fallback = expectedObjective(raw);
  return {
    objective: fallback,
    done: fallback === 'DONE',
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
  OBJECTIVE_IDS,
  isObjectiveId,
  summarizeState,
  plannerStateView,
  missionComplete,
  expectedObjective,
  acceptableObjectives,
  gradeChoice,
  objectiveAchieved,
  buildPlannerPrompt,
  parsePlannerReply,
  chooseNextObjective,
};
