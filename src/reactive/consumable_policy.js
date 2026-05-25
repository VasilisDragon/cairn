const DEFAULT_THRESHOLDS = Object.freeze({
  criticalHealth: 6,
  regenerationHealth: 12,
  goldenAppleHealth: 10,
  food: 14,
  combatBuffDistance: 12,
  defensiveBuffSecondsToLowHealth: 3,
  defensiveBuffKillMarginSeconds: 1,
});

const FOOD_POINTS = Object.freeze({
  apple: 4,
  baked_potato: 5,
  bread: 5,
  cooked_beef: 8,
  cooked_chicken: 6,
  cooked_cod: 5,
  cooked_mutton: 6,
  cooked_porkchop: 8,
  cooked_rabbit: 5,
  cooked_salmon: 6,
  carrot: 3,
  potato: 1,
  beetroot: 1,
  melon_slice: 2,
});

const POTION_EFFECTS = Object.freeze({
  fire_resistance: Object.freeze({ effect: 'fire_resistance', level: 1 }),
  long_fire_resistance: Object.freeze({ effect: 'fire_resistance', level: 1 }),
  healing: Object.freeze({ effect: 'instant_health', level: 1 }),
  strong_healing: Object.freeze({ effect: 'instant_health', level: 2 }),
  regeneration: Object.freeze({ effect: 'regeneration', level: 1 }),
  long_regeneration: Object.freeze({ effect: 'regeneration', level: 1 }),
  strong_regeneration: Object.freeze({ effect: 'regeneration', level: 2 }),
  strength: Object.freeze({ effect: 'strength', level: 1 }),
  long_strength: Object.freeze({ effect: 'strength', level: 1 }),
  strong_strength: Object.freeze({ effect: 'strength', level: 2 }),
  swiftness: Object.freeze({ effect: 'speed', level: 1 }),
  long_swiftness: Object.freeze({ effect: 'speed', level: 1 }),
  strong_swiftness: Object.freeze({ effect: 'speed', level: 2 }),
});

const PLAYER_COMBAT_INTENTS = new Set(['player_combat', 'pvp']);

export function classifyConsumable(item) {
  const name = item?.name;
  if (!name) return { kind: 'unknown' };
  if (name === 'enchanted_golden_apple') return { kind: 'enchanted_golden_apple' };
  if (name === 'golden_apple') return { kind: 'golden_apple' };
  if (name === 'potion') {
    const potion = potionEffectFromItem(item);
    return potion ? { kind: 'potion', ...potion } : { kind: 'potion', effect: null, level: 0 };
  }
  if (name === 'splash_potion' || name === 'lingering_potion') {
    const potion = potionEffectFromItem(item);
    return potion ? { kind: name, ...potion } : { kind: name, effect: null, level: 0 };
  }
  if (FOOD_POINTS[name] > 0) return { kind: 'food', foodPoints: FOOD_POINTS[name] };
  return { kind: 'unknown' };
}

export function chooseConsumableAction({
  health = 20,
  food = 20,
  inventoryItems = [],
  activeEffects = [],
  threat = null,
  combatRisk = null,
  intent = 'survival',
  allowPotions = false,
  allowGoldenApples = true,
  allowEnchantedGoldenApples = false,
  authorizedPlayerCombat = false,
  environment = {},
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const opts = { inventoryItems, activeEffects, allowPotions };

  if (health <= limits.criticalHealth) {
    const instantHealth = selectPotionWithEffect(opts, 'instant_health');
    if (instantHealth) return potionDecision('drink_potion', 'critical-instant-health', instantHealth);
    const enchanted = allowEnchantedGoldenApples ? selectFirstByName(inventoryItems, 'enchanted_golden_apple') : null;
    if (enchanted) return itemDecision('eat', 'critical-enchanted-golden-apple', enchanted);
    const golden = allowGoldenApples ? selectFirstByName(inventoryItems, 'golden_apple') : null;
    if (golden) return itemDecision('eat', 'critical-golden-apple', golden);
  }

  if (health <= limits.regenerationHealth) {
    const regeneration = selectPotionWithEffect(opts, 'regeneration');
    if (regeneration && activeEffectLevel(activeEffects, 'regeneration') < regeneration.potion.level) {
      return potionDecision('drink_potion', 'low-health-regeneration', regeneration);
    }
  }

  if (health <= limits.goldenAppleHealth && allowGoldenApples) {
    const golden = selectFirstByName(inventoryItems, 'golden_apple');
    if (golden) return itemDecision('eat', 'low-health-golden-apple', golden);
  }

  const combat = chooseCombatBuff({
    threat,
    intent,
    activeEffects,
    inventoryItems,
    combatRisk,
    allowPotions,
    allowGoldenApples,
    authorizedPlayerCombat,
    environment,
    thresholds: limits,
  });
  if (combat.action !== 'none') return combat;
  if (combat.reason === 'player-combat-not-authorized') return combat;

  if (food <= limits.food) {
    const foodItem = selectBestFood(inventoryItems);
    if (foodItem) return itemDecision('eat', 'low-food', foodItem);
  }

  return { action: 'none', reason: 'no-consumable-needed' };
}

function chooseCombatBuff({
  threat,
  intent,
  activeEffects,
  inventoryItems,
  combatRisk,
  allowPotions,
  allowGoldenApples,
  authorizedPlayerCombat,
  environment,
  thresholds,
}) {
  if (!threat?.entity || !isCombatIntent(intent)) return { action: 'none', reason: 'not-combat-prep' };
  if (isPlayerThreat(threat.entity) && !authorizedPlayerCombat) {
    return { action: 'none', reason: 'player-combat-not-authorized' };
  }
  if (Number.isFinite(threat.distance) && threat.distance > thresholds.combatBuffDistance) {
    return { action: 'none', reason: 'threat-too-far-for-buff' };
  }

  if (allowPotions && environment.fireOrLava === true) {
    const fireResistance = selectPotionWithEffect({ inventoryItems, activeEffects, allowPotions }, 'fire_resistance');
    if (fireResistance && activeEffectLevel(activeEffects, 'fire_resistance') < fireResistance.potion.level) {
      return potionDecision('drink_potion', 'combat-fire-resistance', fireResistance);
    }
  }

  const immediateDefensiveRisk = isImmediateDefensiveCombatRisk(combatRisk, thresholds);
  if (immediateDefensiveRisk) {
    const defensive = chooseDefensiveCombatConsumable({
      inventoryItems,
      activeEffects,
      allowPotions,
      allowGoldenApples,
    });
    if (defensive) return defensive;
  }

  if (allowPotions) {
    const strength = selectPotionWithEffect({ inventoryItems, activeEffects, allowPotions }, 'strength');
    if (strength && activeEffectLevel(activeEffects, 'strength') < strength.potion.level) {
      return potionDecision('drink_potion', 'combat-strength', strength);
    }
  }

  if (!immediateDefensiveRisk && shouldUseDefensiveCombatConsumable(combatRisk, thresholds)) {
    const defensive = chooseDefensiveCombatConsumable({
      inventoryItems,
      activeEffects,
      allowPotions,
      allowGoldenApples,
    });
    if (defensive) return defensive;
  }

  if (allowPotions) {
    const speed = selectPotionWithEffect({ inventoryItems, activeEffects, allowPotions }, 'speed');
    if (speed && activeEffectLevel(activeEffects, 'speed') < speed.potion.level) {
      return potionDecision('drink_potion', 'combat-speed', speed);
    }
  }

  return { action: 'none', reason: 'combat-buffs-already-satisfied' };
}

function chooseDefensiveCombatConsumable({
  inventoryItems,
  activeEffects,
  allowPotions,
  allowGoldenApples,
}) {
  const regeneration = selectPotionWithEffect({ inventoryItems, activeEffects, allowPotions }, 'regeneration');
  if (regeneration && activeEffectLevel(activeEffects, 'regeneration') < regeneration.potion.level) {
    return potionDecision('drink_potion', 'combat-risk-regeneration', regeneration);
  }
  const golden = allowGoldenApples && activeEffectLevel(activeEffects, 'absorption') <= 0
    ? selectFirstByName(inventoryItems, 'golden_apple')
    : null;
  if (golden) return itemDecision('eat', 'combat-risk-golden-apple', golden);
  return null;
}

function isImmediateDefensiveCombatRisk(combatRisk, thresholds) {
  const secondsToLow = Number(combatRisk?.estimatedSecondsToLowHealth);
  if (!Number.isFinite(secondsToLow)) return false;
  const survivalFloor = defensiveSurvivalFloor(thresholds);
  return secondsToLow <= survivalFloor;
}

function shouldUseDefensiveCombatConsumable(combatRisk, thresholds) {
  const secondsToLow = Number(combatRisk?.estimatedSecondsToLowHealth);
  if (!Number.isFinite(secondsToLow)) return false;

  const secondsToKill = Number(combatRisk?.meleeOffense?.estimatedSecondsToKill);
  const killMargin = Number.isFinite(thresholds.defensiveBuffKillMarginSeconds)
    ? Math.max(0, thresholds.defensiveBuffKillMarginSeconds)
    : DEFAULT_THRESHOLDS.defensiveBuffKillMarginSeconds;
  if (Number.isFinite(secondsToKill) && secondsToKill + killMargin > secondsToLow) {
    return true;
  }

  return isImmediateDefensiveCombatRisk(combatRisk, thresholds);
}

function defensiveSurvivalFloor(thresholds) {
  return Number.isFinite(thresholds.defensiveBuffSecondsToLowHealth)
    ? Math.max(0, thresholds.defensiveBuffSecondsToLowHealth)
    : DEFAULT_THRESHOLDS.defensiveBuffSecondsToLowHealth;
}

function selectPotionWithEffect({ inventoryItems, allowPotions }, effect) {
  if (!allowPotions) return null;
  return inventoryItems
    .map((item) => ({ item, potion: classifyConsumable(item) }))
    .filter(({ potion }) => potion.kind === 'potion' && potion.effect === effect)
    .sort((a, b) => b.potion.level - a.potion.level || itemSlot(a.item) - itemSlot(b.item))
    .at(0) || null;
}

function selectBestFood(items) {
  return items
    .map((item) => ({ item, food: classifyConsumable(item) }))
    .filter(({ food }) => food.kind === 'food')
    .sort((a, b) => b.food.foodPoints - a.food.foodPoints || itemSlot(a.item) - itemSlot(b.item))
    .at(0)?.item || null;
}

function selectFirstByName(items, name) {
  return items
    .filter((item) => item?.name === name)
    .sort((a, b) => itemSlot(a) - itemSlot(b))
    .at(0) || null;
}

function potionDecision(action, reason, selection) {
  return {
    action,
    reason,
    item: selection.item,
    effect: selection.potion.effect,
    level: selection.potion.level,
  };
}

function itemDecision(action, reason, item) {
  return { action, reason, item };
}

function potionEffectFromItem(item) {
  const key = normalizePotionKey(findPotionString(item));
  return POTION_EFFECTS[key] || null;
}

function findPotionString(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const normalized = normalizePotionKey(value);
    return POTION_EFFECTS[normalized] ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findPotionString(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of ['potionType', 'potion', 'Potion', 'id', 'name', 'displayName']) {
    const found = findPotionString(value[key], depth + 1);
    if (found) return found;
  }
  if (Object.hasOwn(value, 'value')) {
    const found = findPotionString(value.value, depth + 1);
    if (found) return found;
  }
  for (const entry of Object.values(value)) {
    const found = findPotionString(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizePotionKey(value) {
  const key = String(value || '')
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/^potion of /, '')
    .replace(/\s+ii$/, '_ii')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key.endsWith('_ii')) return key;
  const base = key.slice(0, -3);
  if (base === 'strength') return 'strong_strength';
  if (base === 'swiftness' || base === 'speed') return 'strong_swiftness';
  if (base === 'regeneration') return 'strong_regeneration';
  if (base === 'healing' || base === 'instant_health') return 'strong_healing';
  return key;
}

function activeEffectLevel(activeEffects, effect) {
  let best = 0;
  for (const active of activeEffects || []) {
    const name = activeEffectName(active);
    if (name !== effect) continue;
    const level = activeEffectExplicitLevel(active);
    best = Math.max(best, level);
  }
  return best;
}

function activeEffectName(active) {
  if (typeof active === 'string') return normalizeEffectName(active);
  return normalizeEffectName(active?.effect || active?.name || active?.effectName || active?.id);
}

function activeEffectExplicitLevel(active) {
  if (typeof active === 'string') return 1;
  if (Number.isFinite(active?.level)) return active.level;
  if (Number.isFinite(active?.amplifier)) return active.amplifier + 1;
  return 1;
}

function normalizeEffectName(value) {
  const key = normalizePotionKey(value);
  if (key === 'swiftness') return 'speed';
  if (key === 'healing') return 'instant_health';
  return key;
}

function isCombatIntent(intent) {
  return intent === 'hostile_combat' || PLAYER_COMBAT_INTENTS.has(intent);
}

function isPlayerThreat(entity) {
  return entity?.type === 'player' || entity?.name === 'player' || Boolean(entity?.username);
}

function itemSlot(item) {
  const slot = Number(item?.slot);
  return Number.isFinite(slot) ? slot : Number.MAX_SAFE_INTEGER;
}
