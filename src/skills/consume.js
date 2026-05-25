import config from '../config.js';
import log from '../logger.js';
import { classifyConsumable } from '../reactive/consumable_policy.js';
import buildSnapshot from '../state/snapshot.js';
import { readBotInventoryItems } from '../state/materials.js';
import { runBoundedOperation } from './_operations.js';

export async function run(bot, params, ctx) {
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };

  if (hasLoadedItemRegistry(bot) && !hasRegistryItem(bot, params.item)) {
    return { ok: false, reason: `unknown item "${params.item}"`, state: buildSnapshot(bot, ctx) };
  }
  if (typeof bot.equip !== 'function') {
    return { ok: false, reason: 'consume failed: bot.equip unavailable', state: buildSnapshot(bot, ctx) };
  }
  if (typeof bot.consume !== 'function') {
    return { ok: false, reason: 'consume failed: bot.consume unavailable', state: buildSnapshot(bot, ctx) };
  }
  if (bot.autoEat?.isEating === true || bot.usingHeldItem === true) {
    return { ok: false, reason: 'consume blocked: item use already active', state: buildSnapshot(bot, ctx) };
  }

  const inventory = readBotInventoryItems(bot);
  if (!inventory.ok) {
    return { ok: false, reason: `inventory unavailable during consume: ${inventory.error}`, state: buildSnapshot(bot, ctx) };
  }

  const selection = selectConsumableItem(inventory.items, params);
  if (!selection.ok) return { ok: false, reason: selection.reason, state: buildSnapshot(bot, ctx) };

  const fields = logFields(selection);
  log.executor.info('consume.selected', fields);

  let phase = 'equip';
  try {
    const critical = isReactiveConsume(ctx);
    await equipForConsume(bot, selection.item, fields, {
      signal: ctx.signal,
      critical,
    });
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt after consume equip', state: buildSnapshot(bot, ctx) };

    phase = 'consume';
    await consumeHeldItem(bot, fields, {
      signal: ctx.signal,
      critical,
    });
  } catch (err) {
    if (ctx.signal?.aborted || err?.code === 'CONSUME_OPERATION_ABORTED' || err?.code === 'CONSUME_EQUIP_ABORTED') {
      return {
        preempted: true,
        reason: phase === 'equip' ? 'reactive preempt during consume equip' : 'reactive preempt during consume',
        state: buildSnapshot(bot, ctx),
      };
    }
    return { ok: false, reason: `consume failed: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
  }

  if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt after consume', state: buildSnapshot(bot, ctx) };
  log.executor.info('consume.done', fields);
  return { ok: true, reason: `consumed ${params.item}`, state: buildSnapshot(bot, ctx) };
}

function selectConsumableItem(items, params) {
  const candidates = (items || [])
    .map((item, index) => ({ item, index, consumable: classifyConsumable(item) }))
    .filter(({ item }) => item?.name === params.item);

  if (candidates.length === 0) return { ok: false, reason: `no ${params.item} in inventory` };

  const firstKind = candidates[0].consumable.kind;
  if (firstKind === 'potion' && params.allowPotions !== true) {
    return { ok: false, reason: 'potion consumption requires allowPotions=true' };
  }
  if (firstKind === 'enchanted_golden_apple' && params.allowEnchantedGoldenApples !== true) {
    return { ok: false, reason: 'enchanted golden apple consumption requires allowEnchantedGoldenApples=true' };
  }
  if (firstKind === 'splash_potion' || firstKind === 'lingering_potion') {
    return { ok: false, reason: `${params.item} is not a supported drinkable consumable` };
  }

  const allowed = candidates.filter((candidate) => isAllowedConsumable(candidate, params));
  if (allowed.length === 0) return { ok: false, reason: noMatchReason(params, candidates) };

  allowed.sort((a, b) => selectionScore(a, b));
  return { ok: true, ...allowed[0] };
}

function isAllowedConsumable({ consumable }, params) {
  if (consumable.kind === 'food' || consumable.kind === 'golden_apple') return true;
  if (consumable.kind === 'enchanted_golden_apple') return params.allowEnchantedGoldenApples === true;
  if (consumable.kind !== 'potion') return false;
  if (params.allowPotions !== true || !consumable.effect) return false;
  if (params.effect && consumable.effect !== params.effect) return false;
  if (Number.isFinite(params.minLevel) && consumable.level < params.minLevel) return false;
  return true;
}

function noMatchReason(params, candidates) {
  if (params.item === 'potion') {
    if (params.effect) {
      return `no potion matching effect ${params.effect}${Number.isFinite(params.minLevel) ? ` level >= ${params.minLevel}` : ''} in inventory`;
    }
    if (candidates.some(({ consumable }) => consumable.kind === 'potion' && !consumable.effect)) {
      return 'no classified drinkable potion in inventory';
    }
  }
  return `${params.item} is not a supported consumable`;
}

function selectionScore(a, b) {
  if (a.consumable.kind === 'potion' && b.consumable.kind === 'potion') {
    return b.consumable.level - a.consumable.level || itemSlot(a.item) - itemSlot(b.item) || a.index - b.index;
  }
  return itemSlot(a.item) - itemSlot(b.item) || a.index - b.index;
}

async function equipForConsume(bot, item, fields, opts = {}) {
  const timeoutMs = config.executor?.equipOperationTimeoutMs ?? 10000;
  try {
    await runBoundedOperation(
      () => bot.humanizer?.equipItem
        ? bot.humanizer.equipItem(bot, item, 'hand', {
          reason: 'consume.equip',
          critical: opts.critical === true,
          signal: opts.signal,
        })
        : bot.equip(item, 'hand'),
      {
        timeoutMs,
        timeoutCode: 'CONSUME_EQUIP_TIMEOUT',
        timeoutMessage: `consume equip operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'CONSUME_EQUIP_ABORTED',
        abortMessage: 'consume equip operation aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'CONSUME_EQUIP_TIMEOUT') {
      log.executor.warn('consume.equip-operation-timeout', { ...fields, timeoutMs, err: err.message });
    }
    throw err;
  }
}

async function consumeHeldItem(bot, fields, opts = {}) {
  const timeoutMs = config.executor?.consumeOperationTimeoutMs ?? 5000;
  try {
    await runBoundedOperation(
      () => bot.humanizer?.consumeHeldItem
        ? bot.humanizer.consumeHeldItem(bot, {
          reason: 'consume.use',
          critical: opts.critical === true,
          signal: opts.signal,
        })
        : bot.consume(),
      {
        timeoutMs,
        timeoutCode: 'CONSUME_OPERATION_TIMEOUT',
        timeoutMessage: `consume operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'CONSUME_OPERATION_ABORTED',
        abortMessage: 'consume operation aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'CONSUME_OPERATION_TIMEOUT') {
      log.executor.warn('consume.operation-timeout', { ...fields, timeoutMs, err: err.message });
    }
    if (err?.code === 'CONSUME_OPERATION_TIMEOUT' || err?.code === 'CONSUME_OPERATION_ABORTED' || opts.signal?.aborted) {
      cancelHeldItemUse(bot, fields);
    }
    throw err;
  }
}

function cancelHeldItemUse(bot, fields) {
  if (bot.usingHeldItem !== true || typeof bot.deactivateItem !== 'function') return;
  try {
    const deactivation = bot.humanizer?.deactivateItem
      ? bot.humanizer.deactivateItem(bot, {
        reason: 'consume.cancel-held-item-use',
        critical: true,
      })
      : bot.deactivateItem();
    if (deactivation && typeof deactivation.catch === 'function') {
      deactivation.catch((err) => {
        log.executor.warn('consume.cancel-held-item-use-error', { ...fields, err: errorMessage(err) });
      });
    }
    log.executor.warn('consume.cancel-held-item-use', fields);
  } catch (err) {
    log.executor.warn('consume.cancel-held-item-use-error', { ...fields, err: errorMessage(err) });
  }
}

function logFields(selection) {
  const fields = {
    item: selection.item.name,
    count: selection.item.count ?? 1,
    slot: Number.isFinite(selection.item.slot) ? selection.item.slot : null,
    kind: selection.consumable.kind,
  };
  if (selection.consumable.effect) fields.effect = selection.consumable.effect;
  if (Number.isFinite(selection.consumable.level)) fields.level = selection.consumable.level;
  return fields;
}

function isReactiveConsume(ctx = {}) {
  return typeof ctx.currentSubtask === 'string' && ctx.currentSubtask.startsWith('reactive.consume(');
}

function itemSlot(item) {
  const slot = Number(item?.slot);
  return Number.isFinite(slot) ? slot : Number.MAX_SAFE_INTEGER;
}

function hasLoadedItemRegistry(bot) {
  const itemsByName = bot?.registry?.itemsByName;
  if (itemsByName instanceof Map) return itemsByName.size > 0;
  return Boolean(itemsByName && typeof itemsByName === 'object' && Object.keys(itemsByName).length > 0);
}

function hasRegistryItem(bot, name) {
  const itemsByName = bot?.registry?.itemsByName;
  if (itemsByName instanceof Map) return itemsByName.has(name);
  return Boolean(itemsByName && typeof itemsByName === 'object' && Object.hasOwn(itemsByName, name));
}

function errorMessage(err) {
  return err?.message || String(err);
}
