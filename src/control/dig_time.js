import log from '../logger.js';

const TOOL_SPEEDS = Object.freeze({
  wooden: 2,
  stone: 4,
  iron: 6,
  diamond: 8,
  netherite: 9,
  golden: 12,
});
const FALLBACK_INSTALLED = Symbol('mcbot.digTimeFallbackInstalled');
const FALLBACK_PENDING = Symbol('mcbot.digTimeFallbackPending');

export function installDigTimeFallback(bot, logger = log.bot) {
  if (!bot) return false;
  let cleanup = () => {};
  const tryInstall = () => {
    if (bot[FALLBACK_INSTALLED]) return true;
    if (typeof bot.digTime !== 'function') return false;

    const originalDigTime = bot.digTime.bind(bot);
    bot.digTime = wrapDigTime(bot, originalDigTime, logger);
    bot[FALLBACK_INSTALLED] = true;
    cleanup();
    logger?.info?.('dig-time.fallback-installed', { deferred: bot[FALLBACK_PENDING] === true });
    return true;
  };

  if (tryInstall()) return true;
  if (bot[FALLBACK_PENDING]) return false;
  bot[FALLBACK_PENDING] = true;
  const events = ['inject_allowed', 'login', 'spawn'];
  const onReady = () => tryInstall();
  for (const event of events) bot.on?.(event, onReady);
  const interval = setInterval(() => tryInstall(), 100);
  const timeout = setTimeout(() => {
    if (bot[FALLBACK_INSTALLED]) return;
    cleanup();
    logger?.warn?.('dig-time.fallback-unavailable', { reason: 'bot.digTime was not installed within timeout' });
  }, 10000);

  cleanup = () => {
    for (const event of events) bot.removeListener?.(event, onReady);
    clearInterval(interval);
    clearTimeout(timeout);
    bot[FALLBACK_PENDING] = false;
  };
  return false;
}

function wrapDigTime(bot, originalDigTime, logger) {
  const seen = new Set();

  return (block) => {
    const originalMs = originalDigTime(block);
    const fallbackMs = estimateFallbackDigTime(bot, block);
    if (!Number.isFinite(fallbackMs) || fallbackMs >= originalMs) return originalMs;

    const key = `${block?.name || 'unknown'}:${bot.heldItem?.name || 'empty'}`;
    if (!seen.has(key)) {
      seen.add(key);
      logger?.info?.('dig-time.fallback', {
        block: block?.name ?? null,
        heldItem: bot.heldItem?.name ?? null,
        originalMs,
        fallbackMs,
        material: block?.material ?? null,
      });
    }
    return fallbackMs;
  };
}

export function estimateFallbackDigTime(bot, block) {
  const heldItem = bot?.heldItem;
  if (!heldItem || !block || block.hardness === undefined || typeof block.canHarvest !== 'function') {
    return null;
  }
  if (!block.canHarvest(heldItem.type)) return null;

  const toolSpeed = toolSpeedForItem(heldItem.name);
  if (!toolSpeed) return null;

  const creative = bot.game?.gameMode === 'creative';
  if (creative) return 0;

  let blockBreakingSpeed = toolSpeed;
  const efficiencyLevel = enchantmentLevel(bot, heldItem, 'efficiency');
  if (efficiencyLevel > 0 && blockBreakingSpeed > 1) {
    blockBreakingSpeed += efficiencyLevel * efficiencyLevel + 1;
  }

  const hasteLevel = Math.max(effectLevel(bot, 'Haste'), effectLevel(bot, 'ConduitPower'));
  if (hasteLevel > 0) blockBreakingSpeed *= 1 + (0.2 * hasteLevel);

  const miningFatigueLevel = effectLevel(bot, 'MiningFatigue');
  if (miningFatigueLevel > 0) blockBreakingSpeed *= miningFatigueMultiplier(miningFatigueLevel);

  const inWater = isEyeInWater(bot);
  const aquaAffinityLevel = enchantmentLevel(bot, equipmentItem(bot, 'head'), 'aqua_affinity');
  if (inWater && aquaAffinityLevel === 0) blockBreakingSpeed /= 5;

  if (bot.entity?.onGround === false) blockBreakingSpeed /= 5;

  const blockHardness = block.hardness;
  if (blockHardness === -1) return Infinity;

  const blockBreakingDelta = blockBreakingSpeed / blockHardness / 30;
  if (blockBreakingDelta <= 0) return Infinity;
  if (blockBreakingDelta >= 1) return 0;
  return Math.ceil(1 / blockBreakingDelta) * 50;
}

export function toolSpeedForItem(itemName) {
  if (!itemName) return null;
  const match = /^(wooden|stone|iron|diamond|netherite|golden)_(pickaxe|axe|shovel|hoe|sword)$/.exec(itemName);
  if (!match) return null;
  return TOOL_SPEEDS[match[1]] || null;
}

function enchantmentLevel(bot, item, enchantmentName) {
  if (!item) return 0;
  const enchantments = item.enchants || item.enchantments || [];
  const descriptor = bot?.registry?.enchantmentsByName?.[enchantmentName];
  for (const enchantment of enchantments) {
    if (typeof enchantment?.name === 'string' && enchantment.name.includes(enchantmentName)) {
      return enchantment.lvl || enchantment.level || 0;
    }
    if (descriptor && enchantment?.name === descriptor.name) {
      return enchantment.lvl || enchantment.level || 0;
    }
  }
  return 0;
}

function effectLevel(bot, effectName) {
  const descriptor = bot?.registry?.effectsByName?.[effectName];
  if (!descriptor) return 0;
  const effect = bot.entity?.effects?.[descriptor.id];
  return effect ? effect.amplifier + 1 : 0;
}

function miningFatigueMultiplier(effectLevelValue) {
  switch (effectLevelValue) {
    case 0: return 1;
    case 1: return 0.3;
    case 2: return 0.09;
    case 3: return 0.0027;
    default: return 8.1E-4;
  }
}

function isEyeInWater(bot) {
  try {
    const block = bot._getBlockAtEyeLevel?.();
    return block?.name === 'water' || block?.name === 'flowing_water';
  } catch {
    return false;
  }
}

function equipmentItem(bot, destination) {
  try {
    const slot = bot.getEquipmentDestSlot?.(destination);
    return Number.isInteger(slot) ? bot.inventory?.slots?.[slot] : null;
  } catch {
    return null;
  }
}
