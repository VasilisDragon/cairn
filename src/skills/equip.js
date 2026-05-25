import config from '../config.js';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { readBotInventoryItems } from '../state/materials.js';
import { runBoundedOperation } from './_operations.js';

const DEST_MAP = {
  'hand': 'hand',
  'off-hand': 'off-hand',
  'head': 'head',
  'torso': 'torso',
  'legs': 'legs',
  'feet': 'feet',
};

export async function run(bot, params, ctx) {
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };

  const dest = DEST_MAP[params.destination || 'hand'];
  if (!dest) return { ok: false, reason: `bad destination "${params.destination}"`, state: buildSnapshot(bot, ctx) };

  if (hasLoadedItemRegistry(bot) && !hasRegistryItem(bot, params.item)) {
    return { ok: false, reason: `unknown item "${params.item}"`, state: buildSnapshot(bot, ctx) };
  }

  const inventory = readBotInventoryItems(bot);
  if (!inventory.ok) {
    return { ok: false, reason: `inventory unavailable during equip: ${inventory.error}`, state: buildSnapshot(bot, ctx) };
  }

  const item = selectInventoryItem(inventory.items, params.item);
  if (!item) return { ok: false, reason: `no ${params.item} in inventory`, state: buildSnapshot(bot, ctx) };

  try {
    await equipItem(bot, item, dest, { item: params.item, destination: dest }, {
      signal: ctx.signal,
      reason: 'equip.skill',
    });
  } catch (err) {
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during equip', state: buildSnapshot(bot, ctx) };
    return { ok: false, reason: `equip failed: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
  }
  if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt after equip', state: buildSnapshot(bot, ctx) };
  return { ok: true, reason: `equipped ${params.item} to ${dest}`, state: buildSnapshot(bot, ctx) };
}

function selectInventoryItem(items, name) {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.name === name)
    .sort((a, b) => (
      itemSlot(a.item) - itemSlot(b.item) ||
      a.index - b.index
    ))
    .at(0)?.item || null;
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

async function equipItem(bot, item, destination, fields = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.executor?.equipOperationTimeoutMs ?? 10000;
  try {
    return await runBoundedOperation(
      () => bot.humanizer?.equipItem
        ? bot.humanizer.equipItem(bot, item, destination, {
          reason: opts.reason || 'equip.skill',
          critical: opts.critical === true,
          signal: opts.signal,
        })
        : bot.equip(item, destination),
      {
        timeoutMs,
        timeoutCode: 'EQUIP_OPERATION_TIMEOUT',
        timeoutMessage: `equip operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'EQUIP_OPERATION_ABORTED',
        abortMessage: 'equip operation aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'EQUIP_OPERATION_TIMEOUT') {
      log.executor.warn('equip.operation-timeout', {
        ...fields,
        timeoutMs,
        err: err.message,
      });
    }
    throw err;
  }
}

function errorMessage(err) {
  return err?.message || String(err);
}
