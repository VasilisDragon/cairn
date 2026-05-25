const WEAPON_MATERIAL_SCORE = Object.freeze({
  wooden: 10,
  golden: 12,
  stone: 20,
  iron: 30,
  diamond: 40,
  netherite: 50,
});

const WEAPON_KIND_SCORE = Object.freeze({
  axe: 1,
  sword: 2,
});

const MELEE_WEAPON_DAMAGE = Object.freeze({
  wooden: Object.freeze({ sword: 4, axe: 7 }),
  golden: Object.freeze({ sword: 4, axe: 7 }),
  stone: Object.freeze({ sword: 5, axe: 9 }),
  iron: Object.freeze({ sword: 6, axe: 9 }),
  diamond: Object.freeze({ sword: 7, axe: 9 }),
  netherite: Object.freeze({ sword: 8, axe: 10 }),
});

const MELEE_ATTACK_INTERVAL_SECONDS = Object.freeze({
  sword: 0.63,
  axe: 1.25,
});

const MINECRAFT_TICKS_PER_SECOND = 20;
const STRENGTH_DAMAGE_PER_LEVEL = 3;
const ABSORPTION_HEALTH_PER_LEVEL = 4;
const REGENERATION_BASE_TICKS_PER_HEAL = 50;

const RANGED_WEAPON_SCORE = Object.freeze({
  crossbow: 10,
  bow: 20,
});

const RANGED_AMMO_NAMES = new Set(['arrow', 'spectral_arrow', 'tipped_arrow']);
export const CLOSE_HOSTILE_PRESSURE_DISTANCE = 4;

const ARMOR_POINTS = Object.freeze({
  leather: Object.freeze({ helmet: 1, chestplate: 3, leggings: 2, boots: 1 }),
  golden: Object.freeze({ helmet: 2, chestplate: 5, leggings: 3, boots: 1 }),
  chainmail: Object.freeze({ helmet: 2, chestplate: 5, leggings: 4, boots: 1 }),
  iron: Object.freeze({ helmet: 2, chestplate: 6, leggings: 5, boots: 2 }),
  diamond: Object.freeze({ helmet: 3, chestplate: 8, leggings: 6, boots: 3 }),
  netherite: Object.freeze({ helmet: 3, chestplate: 8, leggings: 6, boots: 3 }),
  turtle: Object.freeze({ helmet: 2 }),
});

const NO_MELEE_ENGAGE_REASONS = Object.freeze({
  blaze: 'ranged-threat-no-melee-policy',
  bogged: 'ranged-threat-no-melee-policy',
  enderman: 'special-threat-no-melee-policy',
  phantom: 'ranged-threat-no-melee-policy',
  pillager: 'ranged-threat-no-melee-policy',
  skeleton: 'ranged-threat-no-melee-policy',
  stray: 'ranged-threat-no-melee-policy',
  witch: 'special-threat-no-melee-policy',
});

const RANGED_PREP_THREATS = new Set(['blaze', 'bogged', 'creeper', 'phantom', 'pillager', 'skeleton', 'stray']);
const SHIELD_BLOCK_HOSTILES = new Set(['bogged', 'creeper', 'pillager', 'skeleton', 'stray']);

const MELEE_THREAT_DAMAGE = Object.freeze({
  breeze: Object.freeze({ rawDamagePerHit: 3, attackIntervalSeconds: 1.2 }),
  cave_spider: Object.freeze({ rawDamagePerHit: 2, attackIntervalSeconds: 1.2 }),
  drowned: Object.freeze({ rawDamagePerHit: 4, attackIntervalSeconds: 1.2 }),
  endermite: Object.freeze({ rawDamagePerHit: 2, attackIntervalSeconds: 1.2 }),
  hoglin: Object.freeze({ rawDamagePerHit: 6, attackIntervalSeconds: 1.4 }),
  husk: Object.freeze({ rawDamagePerHit: 4, attackIntervalSeconds: 1.2 }),
  magma_cube: Object.freeze({ rawDamagePerHit: 4, attackIntervalSeconds: 1.2 }),
  piglin: Object.freeze({ rawDamagePerHit: 5, attackIntervalSeconds: 1.2 }),
  piglin_brute: Object.freeze({ rawDamagePerHit: 10, attackIntervalSeconds: 1.2 }),
  silverfish: Object.freeze({ rawDamagePerHit: 1, attackIntervalSeconds: 1.2 }),
  slime: Object.freeze({ rawDamagePerHit: 4, attackIntervalSeconds: 1.2 }),
  spider: Object.freeze({ rawDamagePerHit: 3, attackIntervalSeconds: 1.2 }),
  vex: Object.freeze({ rawDamagePerHit: 9, attackIntervalSeconds: 1.2 }),
  vindicator: Object.freeze({ rawDamagePerHit: 13, attackIntervalSeconds: 1.2 }),
  wither_skeleton: Object.freeze({ rawDamagePerHit: 8, attackIntervalSeconds: 1.2 }),
  zoglin: Object.freeze({ rawDamagePerHit: 6, attackIntervalSeconds: 1.4 }),
  zombie: Object.freeze({ rawDamagePerHit: 4, attackIntervalSeconds: 1.2 }),
  zombified_piglin: Object.freeze({ rawDamagePerHit: 4, attackIntervalSeconds: 1.2 }),
});

const DEFAULT_MELEE_THREAT_DAMAGE = Object.freeze({ rawDamagePerHit: 4, attackIntervalSeconds: 1.2 });

const MELEE_TARGET_HEALTH = Object.freeze({
  breeze: 30,
  cave_spider: 12,
  drowned: 20,
  endermite: 8,
  hoglin: 40,
  husk: 20,
  magma_cube: 16,
  piglin: 16,
  piglin_brute: 50,
  silverfish: 8,
  slime: 16,
  spider: 16,
  vex: 14,
  vindicator: 24,
  wither_skeleton: 20,
  zoglin: 40,
  zombie: 20,
  zombified_piglin: 20,
});

const DEFAULT_MELEE_TARGET_HEALTH = 20;

export function weaponScore(item) {
  const parsed = parseWeaponName(item?.name);
  if (!parsed) return 0;
  return WEAPON_MATERIAL_SCORE[parsed.material] + WEAPON_KIND_SCORE[parsed.kind];
}

export function isMeleeWeapon(item) {
  return weaponScore(item) > 0;
}

export function selectBestMeleeWeapon(items = []) {
  let best = null;
  for (const item of items) {
    if (!item) continue;
    const score = weaponScore(item);
    if (score <= 0) continue;
    if (!best || compareWeaponItems(item, best) < 0) best = item;
  }
  return best;
}

export function isRangedWeapon(item) {
  return Number.isFinite(rangedWeaponScore(item)) && rangedWeaponScore(item) > 0;
}

export function rangedWeaponScore(item) {
  const name = item?.name;
  if (typeof name !== 'string') return 0;
  return RANGED_WEAPON_SCORE[name] || 0;
}

export function isRangedAmmo(item) {
  return RANGED_AMMO_NAMES.has(item?.name) && (item.count == null || item.count > 0);
}

export function hasRangedAmmo(items = []) {
  return (items || []).some(isRangedAmmo);
}

export function selectBestRangedWeapon(items = []) {
  let best = null;
  for (const item of items) {
    if (!item) continue;
    const score = rangedWeaponScore(item);
    if (score <= 0) continue;
    if (!best || compareRangedWeaponItems(item, best) < 0) best = item;
  }
  return best;
}

export function isShield(item) {
  return item?.name === 'shield';
}

export function selectShield(items = []) {
  return (items || [])
    .filter(isShield)
    .sort((a, b) => itemSlot(a) - itemSlot(b))
    .at(0) || null;
}

export function armorScore(item) {
  const parsed = parseArmorName(item?.name);
  if (!parsed) return 0;
  return ARMOR_POINTS[parsed.material]?.[parsed.piece] || 0;
}

export function totalArmorScore(items = []) {
  return items.reduce((sum, item) => sum + armorScore(item), 0);
}

export function estimateMeleeOffense({ threat, weaponItem = null, activeEffects = [] } = {}) {
  if (!threat?.entity) return null;
  const parsed = parseWeaponName(weaponItem?.name);
  if (!parsed) return null;

  const targetHealth = targetHealthForEntity(threat.entity);
  const threats = threatSet(threat);
  const weaponDamage = MELEE_WEAPON_DAMAGE[parsed.material]?.[parsed.kind];
  const attackIntervalSeconds = MELEE_ATTACK_INTERVAL_SECONDS[parsed.kind];
  if (!Number.isFinite(targetHealth) || !Number.isFinite(weaponDamage) || !Number.isFinite(attackIntervalSeconds)) {
    return null;
  }

  const strengthLevel = effectLevel(activeEffects, 'strength');
  const strengthBonus = strengthLevel * STRENGTH_DAMAGE_PER_LEVEL;
  const effectiveDamage = weaponDamage + strengthBonus;
  const hitsToKill = Math.max(1, Math.ceil(targetHealth / effectiveDamage));
  const hitsToClearThreats = threats.reduce((sum, entry) => (
    sum + Math.max(1, Math.ceil(targetHealthForEntity(entry?.entity) / effectiveDamage))
  ), 0);
  return {
    weapon: weaponItem.name,
    target: String(threat.entity.name || 'unknown'),
    estimatedTargetHealth: roundMetric(targetHealth),
    estimatedWeaponDamage: roundMetric(effectiveDamage),
    ...(strengthLevel > 0 ? {
      estimatedBaseWeaponDamage: roundMetric(weaponDamage),
      strengthLevel,
      estimatedStrengthBonusDamage: roundMetric(strengthBonus),
    } : {}),
    estimatedAttackIntervalSeconds: roundMetric(attackIntervalSeconds),
    estimatedHitsToKill: hitsToKill,
    estimatedSecondsToKill: roundMetric(hitsToKill * attackIntervalSeconds),
    ...(threats.length > 1 ? {
      estimatedThreatsToClear: threats.length,
      estimatedHitsToClearThreats: hitsToClearThreats,
      estimatedSecondsToClearThreats: roundMetric(hitsToClearThreats * attackIntervalSeconds),
    } : {}),
  };
}

export function estimateMeleeSurvival({
  threat,
  health = 20,
  armorItems = [],
  activeEffects = [],
  recentDamage = null,
  weaponItem = null,
  lowHealthFleeThreshold = 8,
} = {}) {
  if (!threat?.entity) return null;

  const threats = threatSet(threat);
  const equippedArmorScore = totalArmorScore(armorItems);
  const armorReduction = Math.min(0.8, Math.max(0, equippedArmorScore) * 0.04);
  const resistanceLevel = effectLevel(activeEffects, 'resistance');
  const resistanceReduction = Math.min(0.8, Math.max(0, resistanceLevel) * 0.2);
  const regenerationLevel = effectLevel(activeEffects, 'regeneration');
  const estimatedRegenerationHps = regenerationHealingPerSecond(regenerationLevel);
  const absorptionLevel = effectLevel(activeEffects, 'absorption');
  const estimatedAbsorptionHealth = absorptionLevel * ABSORPTION_HEALTH_PER_LEVEL;
  const damageMultiplier = (1 - armorReduction) * (1 - resistanceReduction);

  let estimatedIncomingDps = 0;
  let estimatedMaxHitDamage = 0;
  for (const entry of threats) {
    const profile = meleeThreatDamageProfile(entry?.entity?.name);
    const hitDamage = profile.rawDamagePerHit * damageMultiplier;
    estimatedMaxHitDamage = Math.max(estimatedMaxHitDamage, hitDamage);
    estimatedIncomingDps += hitDamage / profile.attackIntervalSeconds;
  }

  const observedDamage = normalizeRecentDamage(recentDamage);
  const grossIncomingDps = Math.max(estimatedIncomingDps, observedDamage?.recentDamagePerSecond || 0);
  const effectiveIncomingDps = Math.max(0, grossIncomingDps - estimatedRegenerationHps);
  const currentHealth = Number.isFinite(health) ? Math.max(0, health) : 20;
  const lowHealth = Number.isFinite(lowHealthFleeThreshold) ? Math.max(0, lowHealthFleeThreshold) : 8;
  const effectiveHealth = currentHealth + estimatedAbsorptionHealth;
  const healthUntilLow = Math.max(0, effectiveHealth - lowHealth);
  const secondsToLow = effectiveIncomingDps > 0 ? healthUntilLow / effectiveIncomingDps : null;
  const secondsToDeath = effectiveIncomingDps > 0 ? effectiveHealth / effectiveIncomingDps : null;
  const hitsToLow = estimatedMaxHitDamage > 0 ? Math.floor(healthUntilLow / estimatedMaxHitDamage) : null;
  const meleeOffense = estimateMeleeOffense({ threat, weaponItem, activeEffects });
  const defensiveEffectsActive = regenerationLevel > 0 || absorptionLevel > 0;

  return {
    threatCount: threats.length,
    armorScore: equippedArmorScore,
    armorReduction: roundMetric(armorReduction),
    resistanceLevel,
    resistanceReduction: roundMetric(resistanceReduction),
    ...(regenerationLevel > 0 ? {
      regenerationLevel,
      estimatedRegenerationHps: roundMetric(estimatedRegenerationHps),
    } : {}),
    ...(absorptionLevel > 0 ? {
      absorptionLevel,
      estimatedAbsorptionHealth: roundMetric(estimatedAbsorptionHealth),
    } : {}),
    estimatedIncomingDps: roundMetric(estimatedIncomingDps),
    ...(observedDamage ? {
      observedRecentDamageDps: roundMetric(observedDamage.recentDamagePerSecond),
      recentDamageTotal: roundMetric(observedDamage.totalDamage),
      recentDamageWindowMs: observedDamage.windowMs,
      lastDamageMsAgo: observedDamage.lastDamageMsAgo,
    } : {}),
    ...(observedDamage || defensiveEffectsActive ? {
      effectiveIncomingDps: roundMetric(effectiveIncomingDps),
    } : {}),
    estimatedMaxHitDamage: roundMetric(estimatedMaxHitDamage),
    estimatedSecondsToLowHealth: roundMetric(secondsToLow),
    estimatedSecondsToDeath: roundMetric(secondsToDeath),
    estimatedHitsToLowHealth: hitsToLow,
    ...(meleeOffense ? { meleeOffense } : {}),
  };
}

export function chooseCombatResponse({
  threat,
  health = 20,
  heldItem = null,
  offHandItem = null,
  inventoryItems = [],
  armorItems = [],
  engageOverFlee = false,
  lowHealthFleeThreshold = 8,
  minArmorScoreToEngage = 0,
  maxMeleeEngageThreatCount = 1,
  minMeleeSurvivalSecondsToEngage = 3,
  minMeleeKillMarginSecondsToEngage = 1,
  activeEffects = [],
  recentDamage = null,
  requireShieldToEngage = false,
  rangedCombatPrepEnabled = false,
  rangedCombatFireEnabled = false,
  rangedCombatLineOfSight = null,
  rangedCombatFireMinDistance = 7,
  rangedCombatFireMaxDistance = 16,
} = {}) {
  if (!threat?.entity) return { action: 'none', reason: 'no-threat' };

  const entityName = String(threat.entity.name || '');
  if (entityName === 'creeper') {
    const rangedFire = chooseRangedFireResponse({
      threat,
      health,
      lowHealthFleeThreshold,
      heldItem,
      inventoryItems,
      enabled: rangedCombatFireEnabled,
      hasLineOfSight: rangedCombatLineOfSight,
      minDistance: rangedCombatFireMinDistance,
      maxDistance: rangedCombatFireMaxDistance,
    });
    if (rangedFire) return rangedFire;
    const rangedPrep = chooseRangedPrepResponse({
      threatName: entityName,
      heldItem,
      inventoryItems,
      enabled: rangedCombatPrepEnabled,
    });
    if (rangedPrep) return rangedPrep;
    return { action: 'flee', reason: 'creeper-anti-explosion' };
  }
  if (isPlayerEntity(threat.entity)) {
    return { action: 'flee', reason: 'player-threat-no-pvp-policy' };
  }
  if (health <= lowHealthFleeThreshold) {
    return { action: 'flee', reason: 'low-health' };
  }
  if (NO_MELEE_ENGAGE_REASONS[entityName]) {
    const rangedFire = chooseRangedFireResponse({
      threat,
      health,
      lowHealthFleeThreshold,
      heldItem,
      inventoryItems,
      enabled: rangedCombatFireEnabled,
      hasLineOfSight: rangedCombatLineOfSight,
      minDistance: rangedCombatFireMinDistance,
      maxDistance: rangedCombatFireMaxDistance,
    });
    if (rangedFire) return rangedFire;
    const rangedPrep = chooseRangedPrepResponse({
      threatName: entityName,
      heldItem,
      inventoryItems,
      enabled: rangedCombatPrepEnabled,
    });
    if (rangedPrep) return rangedPrep;
    return { action: 'flee', reason: NO_MELEE_ENGAGE_REASONS[entityName] };
  }

  const unsafeThreatSetResponse = chooseUnsafeThreatSetResponse({
    threat,
    health,
    lowHealthFleeThreshold,
    heldItem,
    inventoryItems,
    rangedCombatPrepEnabled,
    rangedCombatFireEnabled,
    rangedCombatLineOfSight,
    rangedCombatFireMinDistance,
    rangedCombatFireMaxDistance,
  });
  if (unsafeThreatSetResponse) return unsafeThreatSetResponse;

  if (!engageOverFlee) {
    return { action: 'flee', reason: 'engage-disabled' };
  }

  const heldScore = weaponScore(heldItem);
  const bestWeapon = selectBestMeleeWeapon(inventoryItems);
  const candidateWeapon = heldScore > 0 ? heldItem : bestWeapon;
  const threatCount = countThreats(threat);
  const meleeRisk = estimateMeleeSurvival({
    threat,
    health,
    armorItems,
    activeEffects,
    recentDamage,
    weaponItem: candidateWeapon,
    lowHealthFleeThreshold,
  });
  const maxThreats = Number.isFinite(maxMeleeEngageThreatCount)
    ? Math.max(1, maxMeleeEngageThreatCount)
    : 1;
  if (threatCount > maxThreats) {
    return {
      action: 'flee',
      reason: 'too-many-hostiles',
      threatCount,
      maxMeleeEngageThreatCount: maxThreats,
      meleeRisk,
    };
  }

  const equippedArmorScore = totalArmorScore(armorItems);
  if (equippedArmorScore < minArmorScoreToEngage) {
    return {
      action: 'flee',
      reason: 'insufficient-armor',
      armorScore: equippedArmorScore,
      requiredArmorScore: minArmorScoreToEngage,
      meleeRisk,
    };
  }

  const minSurvivalSeconds = Number.isFinite(minMeleeSurvivalSecondsToEngage)
    ? Math.max(0, minMeleeSurvivalSecondsToEngage)
    : 3;
  if (
    minSurvivalSeconds > 0
    && meleeRisk
    && Number.isFinite(meleeRisk.estimatedSecondsToLowHealth)
    && meleeRisk.estimatedSecondsToLowHealth < minSurvivalSeconds
  ) {
    return {
      action: 'flee',
      reason: 'melee-survival-margin-too-low',
      meleeRisk,
      minMeleeSurvivalSecondsToEngage: minSurvivalSeconds,
    };
  }

  const minKillMarginSeconds = Number.isFinite(minMeleeKillMarginSecondsToEngage)
    ? Math.max(0, minMeleeKillMarginSecondsToEngage)
    : 1;
  if (
    minKillMarginSeconds > 0
    && meleeRisk?.meleeOffense
    && Number.isFinite(meleeRisk.estimatedSecondsToLowHealth)
    && Number.isFinite(combatWinSeconds(meleeRisk))
    && combatWinSeconds(meleeRisk) + minKillMarginSeconds > meleeRisk.estimatedSecondsToLowHealth
  ) {
    return {
      action: 'flee',
      reason: 'melee-kill-window-too-risky',
      meleeRisk,
      minMeleeKillMarginSecondsToEngage: minKillMarginSeconds,
    };
  }

  if (requireShieldToEngage && !isShield(offHandItem)) {
    const shield = selectShield(inventoryItems);
    if (shield) {
      return {
        action: 'equip_shield',
        reason: 'shield-available',
        item: shield,
      };
    }
    return { action: 'flee', reason: 'shield-required' };
  }

  if (bestWeapon && weaponScore(bestWeapon) > heldScore) {
    return {
      action: 'equip_weapon',
      reason: heldScore > 0 ? 'better-weapon-available' : 'weapon-available',
      item: bestWeapon,
      meleeRisk,
    };
  }
  if (heldScore > 0) {
    return { action: 'engage', reason: 'armed', meleeRisk };
  }

  return { action: 'flee', reason: 'unarmed' };
}

export function chooseShieldBlockResponse({
  threat,
  combatAction = 'none',
  offHandItem = null,
  shieldActive = false,
  enabled = false,
  blockDistance = 4.5,
  releaseDistance = 7,
} = {}) {
  if (!enabled) {
    return shieldActive
      ? { action: 'release_shield', reason: 'shield-block-disabled' }
      : { action: 'none', reason: 'shield-block-disabled' };
  }

  if (!threat?.entity) {
    return shieldActive
      ? { action: 'release_shield', reason: 'no-threat' }
      : { action: 'none', reason: 'no-threat' };
  }

  if (!isShield(offHandItem)) {
    return shieldActive
      ? { action: 'release_shield', reason: 'shield-missing' }
      : { action: 'none', reason: 'shield-missing' };
  }

  if (isPlayerEntity(threat.entity)) {
    return shieldActive
      ? { action: 'release_shield', reason: 'player-threat-no-pvp-policy' }
      : { action: 'none', reason: 'player-threat-no-pvp-policy' };
  }

  const distance = Number.isFinite(threat.distance) ? threat.distance : Infinity;
  const entityName = String(threat.entity.name || '');
  const defensiveThreat = SHIELD_BLOCK_HOSTILES.has(entityName);
  const meleeEngage = combatAction === 'engage';
  const shouldBlock = (defensiveThreat || meleeEngage) && distance <= blockDistance;
  if (shouldBlock) {
    return shieldActive
      ? { action: 'hold_shield', reason: shieldBlockReason(entityName, combatAction) }
      : { action: 'activate_shield', reason: shieldBlockReason(entityName, combatAction) };
  }

  const shouldHold = shieldActive && (defensiveThreat || meleeEngage) && distance <= releaseDistance;
  if (shouldHold) return { action: 'hold_shield', reason: 'shield-block-hysteresis' };

  if (shieldActive) {
    return { action: 'release_shield', reason: 'threat-outside-shield-range' };
  }

  return { action: 'none', reason: 'not-shield-block-threat' };
}

function parseWeaponName(name) {
  if (typeof name !== 'string') return null;
  const match = /^(wooden|golden|stone|iron|diamond|netherite)_(sword|axe)$/.exec(name);
  if (!match) return null;
  return { material: match[1], kind: match[2] };
}

function parseArmorName(name) {
  if (typeof name !== 'string') return null;
  const match = /^(leather|golden|chainmail|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.exec(name);
  if (match) return { material: match[1], piece: match[2] };
  if (name === 'turtle_helmet') return { material: 'turtle', piece: 'helmet' };
  return null;
}

function compareWeaponItems(a, b) {
  const scoreDiff = weaponScore(b) - weaponScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  const slotA = itemSlot(a);
  const slotB = itemSlot(b);
  if (slotA !== slotB) return slotA - slotB;
  return String(a?.name || '').localeCompare(String(b?.name || ''));
}

function compareRangedWeaponItems(a, b) {
  const scoreDiff = rangedWeaponScore(b) - rangedWeaponScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  const slotA = itemSlot(a);
  const slotB = itemSlot(b);
  if (slotA !== slotB) return slotA - slotB;
  return String(a?.name || '').localeCompare(String(b?.name || ''));
}

function itemSlot(item) {
  return Number.isFinite(item?.slot) ? item.slot : Number.MAX_SAFE_INTEGER;
}

function chooseRangedPrepResponse({ threatName, heldItem, inventoryItems, enabled }) {
  if (!enabled || !RANGED_PREP_THREATS.has(threatName)) return null;
  if (!hasRangedAmmo(inventoryItems)) return null;
  if (isRangedWeapon(heldItem)) {
    return {
      action: 'flee',
      reason: threatName === 'creeper' ? 'creeper-ranged-ready-no-fire-policy' : 'ranged-weapon-ready-no-fire-policy',
    };
  }
  const rangedWeapon = selectBestRangedWeapon(inventoryItems);
  if (!rangedWeapon) return null;
  return {
    action: 'equip_ranged_weapon',
    reason: threatName === 'creeper' ? 'creeper-ranged-weapon-available' : 'ranged-weapon-available',
    item: rangedWeapon,
  };
}

function chooseUnsafeThreatSetResponse({
  threat,
  health,
  lowHealthFleeThreshold,
  heldItem,
  inventoryItems,
  rangedCombatPrepEnabled,
  rangedCombatFireEnabled,
  rangedCombatLineOfSight,
  rangedCombatFireMinDistance,
  rangedCombatFireMaxDistance,
}) {
  const threats = threatSet(threat);
  if (threats.length <= 1) return null;
  const threatCount = threats.length;

  for (const entry of threats) {
    if (isPlayerEntity(entry?.entity)) {
      return { action: 'flee', reason: 'player-threat-no-pvp-policy', threatCount, unsafeThreat: 'player' };
    }
  }

  for (const entry of threats) {
    const threatName = String(entry?.entity?.name || '');
    if (threatName !== 'creeper') continue;
    const rangedFire = chooseRangedFireResponse({
      threat: entry,
      health,
      lowHealthFleeThreshold,
      heldItem,
      inventoryItems,
      enabled: rangedCombatFireEnabled,
      hasLineOfSight: rangedCombatLineOfSight,
      minDistance: rangedCombatFireMinDistance,
      maxDistance: rangedCombatFireMaxDistance,
    });
    const closePressure = closeHostilePressure(threats, entry);
    if (rangedFire?.action === 'fire_ranged_weapon' && closePressure) {
      return closeHostilePressureResponse(closePressure, entry, threatCount);
    }
    if (rangedFire) return { ...rangedFire, threatCount, unsafeThreat: threatName, targetThreat: entry };
    const rangedPrep = chooseRangedPrepResponse({
      threatName,
      heldItem,
      inventoryItems,
      enabled: rangedCombatPrepEnabled,
    });
    if (rangedPrep?.action === 'equip_ranged_weapon' && closePressure) {
      return closeHostilePressureResponse(closePressure, entry, threatCount);
    }
    if (rangedPrep) return { ...rangedPrep, threatCount, unsafeThreat: threatName, targetThreat: entry };
    return { action: 'flee', reason: 'creeper-anti-explosion', threatCount, unsafeThreat: threatName };
  }

  for (const entry of threats) {
    const threatName = String(entry?.entity?.name || '');
    const reason = NO_MELEE_ENGAGE_REASONS[threatName];
    if (!reason) continue;
    const rangedFire = chooseRangedFireResponse({
      threat: entry,
      health,
      lowHealthFleeThreshold,
      heldItem,
      inventoryItems,
      enabled: rangedCombatFireEnabled,
      hasLineOfSight: rangedCombatLineOfSight,
      minDistance: rangedCombatFireMinDistance,
      maxDistance: rangedCombatFireMaxDistance,
    });
    const closePressure = closeHostilePressure(threats, entry);
    if (rangedFire?.action === 'fire_ranged_weapon' && closePressure) {
      return closeHostilePressureResponse(closePressure, entry, threatCount);
    }
    if (rangedFire) return { ...rangedFire, threatCount, unsafeThreat: threatName, targetThreat: entry };
    const rangedPrep = chooseRangedPrepResponse({
      threatName,
      heldItem,
      inventoryItems,
      enabled: rangedCombatPrepEnabled,
    });
    if (rangedPrep?.action === 'equip_ranged_weapon' && closePressure) {
      return closeHostilePressureResponse(closePressure, entry, threatCount);
    }
    if (rangedPrep) return { ...rangedPrep, threatCount, unsafeThreat: threatName, targetThreat: entry };
    return { action: 'flee', reason, threatCount, unsafeThreat: threatName };
  }

  return null;
}

function closeHostilePressure(threats, targetEntry) {
  const targetId = targetEntry?.entity?.id;
  const targetName = targetEntry?.entity?.name;
  for (const entry of threats) {
    if (!entry?.entity) continue;
    if (entry === targetEntry) continue;
    if (entry.entity.id === targetId && entry.entity.name === targetName) continue;
    const distance = Number(entry.distance);
    if (Number.isFinite(distance) && distance <= CLOSE_HOSTILE_PRESSURE_DISTANCE) {
      return entry;
    }
  }
  return null;
}

function closeHostilePressureResponse(pressure, targetThreat, threatCount) {
  return {
    action: 'flee',
    reason: 'close-hostile-pressure-before-ranged',
    threatCount,
    unsafeThreat: String(pressure?.entity?.name || 'unknown'),
    closeThreatDistance: roundMetric(Number(pressure?.distance)),
    targetThreat,
  };
}

function chooseRangedFireResponse({
  threat,
  health,
  lowHealthFleeThreshold,
  heldItem,
  inventoryItems,
  enabled,
  hasLineOfSight,
  minDistance,
  maxDistance,
}) {
  if (!enabled || !threat?.entity) return null;
  const threatName = String(threat.entity.name || '');
  if (!RANGED_PREP_THREATS.has(threatName)) return null;
  if (!isRangedWeapon(heldItem)) return null;
  if (health <= lowHealthFleeThreshold) return { action: 'flee', reason: 'low-health' };
  if (!hasRangedAmmo(inventoryItems)) return { action: 'flee', reason: 'ranged-fire-no-ammo' };

  const distance = Number.isFinite(threat.distance) ? threat.distance : Infinity;
  const safeMin = Number.isFinite(minDistance) ? minDistance : 7;
  const safeMax = Number.isFinite(maxDistance) ? maxDistance : 16;
  if (distance < safeMin) return { action: 'flee', reason: 'ranged-fire-too-close' };
  if (distance > safeMax) return { action: 'flee', reason: 'ranged-fire-too-far' };
  const lineOfSight = resolveRangedLineOfSight(hasLineOfSight, threat);
  if (lineOfSight !== true) {
    return { action: 'flee', reason: lineOfSight === false ? 'ranged-fire-line-of-sight-blocked' : 'ranged-fire-line-of-sight-unknown' };
  }

  return {
    action: 'fire_ranged_weapon',
    reason: threatName === 'creeper' ? 'creeper-ranged-fire-safe' : 'ranged-fire-safe',
    item: heldItem,
  };
}

function resolveRangedLineOfSight(hasLineOfSight, threat) {
  if (typeof hasLineOfSight !== 'function') return hasLineOfSight;
  try {
    return hasLineOfSight(threat);
  } catch {
    return null;
  }
}

function isPlayerEntity(entity) {
  return entity?.type === 'player' || entity?.name === 'player' || Boolean(entity?.username);
}

function countThreats(threat) {
  return Array.isArray(threat?.threats) && threat.threats.length > 0 ? threat.threats.length : 1;
}

function combatWinSeconds(meleeRisk) {
  const clearThreats = Number(meleeRisk?.meleeOffense?.estimatedSecondsToClearThreats);
  if (Number.isFinite(clearThreats)) return clearThreats;
  return Number(meleeRisk?.meleeOffense?.estimatedSecondsToKill);
}

function threatSet(threat) {
  return Array.isArray(threat?.threats) && threat.threats.length > 0 ? threat.threats : [threat];
}

function meleeThreatDamageProfile(name) {
  return MELEE_THREAT_DAMAGE[String(name || '')] || DEFAULT_MELEE_THREAT_DAMAGE;
}

function targetHealthForEntity(entity) {
  const explicit = Number(entity?.health);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return MELEE_TARGET_HEALTH[String(entity?.name || '')] || DEFAULT_MELEE_TARGET_HEALTH;
}

function effectLevel(effects, targetName) {
  let best = 0;
  for (const effect of effects || []) {
    const name = String(effect?.name || effect?.effectName || effect?.effect || '').replace(/^minecraft:/, '');
    if (name !== targetName) continue;
    const level = Number.isFinite(effect?.level)
      ? effect.level
      : Number.isFinite(effect?.amplifier)
        ? effect.amplifier + 1
        : 1;
    best = Math.max(best, level);
  }
  return best;
}

function regenerationHealingPerSecond(level) {
  if (!Number.isFinite(level) || level <= 0) return 0;
  const ticksPerHeal = Math.max(1, REGENERATION_BASE_TICKS_PER_HEAL >> Math.max(0, Math.floor(level) - 1));
  return MINECRAFT_TICKS_PER_SECOND / ticksPerHeal;
}

function normalizeRecentDamage(recentDamage) {
  if (!recentDamage || typeof recentDamage !== 'object') return null;
  const recentDamagePerSecond = Number(recentDamage.recentDamagePerSecond ?? recentDamage.damagePerSecond);
  if (!Number.isFinite(recentDamagePerSecond) || recentDamagePerSecond <= 0) return null;
  return {
    recentDamagePerSecond: Math.max(0, recentDamagePerSecond),
    totalDamage: Number.isFinite(Number(recentDamage.totalDamage)) ? Math.max(0, Number(recentDamage.totalDamage)) : null,
    windowMs: Number.isFinite(Number(recentDamage.windowMs)) ? Math.max(0, Math.round(Number(recentDamage.windowMs))) : null,
    lastDamageMsAgo: Number.isFinite(Number(recentDamage.lastDamageMsAgo)) ? Math.max(0, Math.round(Number(recentDamage.lastDamageMsAgo))) : null,
  };
}

function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function shieldBlockReason(entityName, combatAction) {
  if (entityName === 'creeper') return 'creeper-shield-block';
  if (SHIELD_BLOCK_HOSTILES.has(entityName)) return 'ranged-shield-block';
  if (combatAction === 'engage') return 'melee-shield-block';
  return 'shield-block';
}
