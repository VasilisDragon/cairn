const QUANTITY_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
});

const ITEM_GOAL_PATTERN = /\b(make|craft|get|gather|collect|obtain)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:(?:a|an|some)\s+)?([a-z0-9_ -]+?)(?=$|[.,;:]|\s+(?:from|with|using|by|near|at|in|for|then|and|before|after|to)\b)/i;

const ITEM_CHAIN_PROGRESS_SKILLS = new Set([
  'goto',
  'collect',
  'deposit',
  'craft',
  'place',
  'equip',
  'smelt',
  'excavate_shaft',
  'fish_until',
  'fish_and_deposit',
  'mine_until',
  'mine_and_return',
  'mine_with_progression',
]);

const COMPOSER_ITEM_GOALS = Object.freeze({
  iron_pickaxe: Object.freeze({
    optionalCraft: 'iron_pickaxe',
    ores: Object.freeze(['iron_ore', 'deepslate_iron_ore']),
    craftIngredients: Object.freeze({ iron_ingot: 3, stick: 2 }),
  }),
  diamond_pickaxe: Object.freeze({
    optionalCraft: 'diamond_pickaxe',
    ores: Object.freeze(['diamond_ore', 'deepslate_diamond_ore']),
    craftIngredients: Object.freeze({ diamond: 3, stick: 2 }),
  }),
});

const PLURAL_ITEM_WORDS = new Set([
  'boots',
  'leggings',
  'planks',
  'shears',
]);

export function parseItemChainGoal(goal) {
  const text = String(goal || '').trim().toLowerCase();
  if (!text) return null;
  const match = text.match(ITEM_GOAL_PATTERN);
  if (!match) return null;
  const verb = match[1];
  const count = quantityFromToken(match[2]);
  const item = normalizeItemName(match[3]);
  if (!item) return null;
  return {
    verb,
    count,
    item,
    rawItem: match[3].trim(),
  };
}

export function validateItemChainGoalCompletion(goal, snapshot) {
  const itemGoal = parseItemChainGoal(goal);
  if (!itemGoal) return { ok: true, itemGoal: null };
  const inventoryCounts = countSnapshotInventory(snapshot?.inventory);
  const have = inventoryCounts[itemGoal.item] || 0;
  if (have >= itemGoal.count) return { ok: true, itemGoal, have, inventoryCounts };
  return {
    ok: false,
    itemGoal,
    have,
    inventoryCounts,
    reason: `item-chain goal "${goal}" target ${itemGoal.item} incomplete: ${have}/${itemGoal.count} in inventory`,
  };
}

export function isItemChainGoal(goal) {
  return parseItemChainGoal(goal) !== null;
}

export function validateItemChainPlanProgress(goal, plan, opts = {}) {
  const itemGoal = parseItemChainGoal(goal);
  if (!itemGoal) return { ok: true, itemGoal: null };
  const calls = Array.isArray(plan) ? plan : [];
  const composer = validateComposerItemGoalProgress(itemGoal, calls, opts);
  if (!composer.ok) return composer;
  const progressIndex = calls.findIndex((call) => ITEM_CHAIN_PROGRESS_SKILLS.has(call?.skill));
  if (progressIndex !== -1) {
    return { ok: true, itemGoal, progressIndex };
  }
  return {
    ok: false,
    itemGoal,
    reason: `item-chain goal "${goal}" requires a progress-capable skill for ${itemGoal.item}; rejected no-op plan`,
    badIndex: calls.length > 0 ? 0 : undefined,
  };
}

function validateComposerItemGoalProgress(itemGoal, calls, opts = {}) {
  const requirement = COMPOSER_ITEM_GOALS[itemGoal.item];
  if (!requirement) return { ok: true };
  const inventoryCounts = countSnapshotInventory(opts.snapshot?.inventory);
  if (hasKnownCraftIngredients(inventoryCounts, requirement.craftIngredients)) return { ok: true };

  const progressIndex = calls.findIndex((call) => isComposerCallForItemGoal(call, requirement));
  if (progressIndex !== -1) return { ok: true, itemGoal, progressIndex };

  return {
    ok: false,
    itemGoal,
    reason: `item-chain goal "${opts.goal || itemGoal.rawItem || itemGoal.item}" requires mine_with_progression with optionalCrafts including ${requirement.optionalCraft} unless ingredients are already in inventory`,
    badIndex: calls.length > 0 ? 0 : undefined,
  };
}

function isComposerCallForItemGoal(call, requirement) {
  if (call?.skill !== 'mine_with_progression') return false;
  const params = call.params || {};
  const optionalCrafts = Array.isArray(params.optionalCrafts) ? params.optionalCrafts : [];
  if (!optionalCrafts.includes(requirement.optionalCraft)) return false;
  const ores = Array.isArray(params.ores) ? params.ores : [];
  return ores.some((ore) => requirement.ores.includes(ore));
}

function hasKnownCraftIngredients(inventoryCounts, ingredients = {}) {
  for (const [item, count] of Object.entries(ingredients)) {
    if ((inventoryCounts[item] || 0) < count) return false;
  }
  return Object.keys(ingredients).length > 0;
}

function quantityFromToken(token) {
  if (!token) return 1;
  const lower = String(token).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(QUANTITY_WORDS, lower)) return QUANTITY_WORDS[lower];
  const n = Number.parseInt(lower, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function normalizeItemName(raw) {
  let text = String(raw || '')
    .trim()
    .replace(/^minecraft:/, '')
    .replace(/[^a-z0-9_ -]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  text = text.replace(/[-\s]+/g, '_');
  const parts = text.split('_').filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  if (last.endsWith('ies') && last.length > 3) {
    parts[parts.length - 1] = `${last.slice(0, -3)}y`;
  } else if (last.endsWith('s') && !last.endsWith('ss') && !PLURAL_ITEM_WORDS.has(last) && last.length > 1) {
    parts[parts.length - 1] = last.slice(0, -1);
  }
  return parts.join('_');
}

function countSnapshotInventory(inventory) {
  const counts = {};
  if (Array.isArray(inventory)) {
    for (const item of inventory) addInventoryCount(counts, item?.name, item?.count);
    return counts;
  }
  if (inventory && typeof inventory === 'object') {
    for (const [name, count] of Object.entries(inventory)) addInventoryCount(counts, name, count);
  }
  return counts;
}

function addInventoryCount(counts, name, rawCount) {
  const normalized = normalizeInventoryItemName(name);
  if (!normalized) return;
  const count = Number(rawCount ?? 1);
  if (!Number.isFinite(count) || count <= 0) return;
  counts[normalized] = (counts[normalized] || 0) + count;
}

function normalizeInventoryItemName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[-\s]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}
