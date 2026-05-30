import config from '../config.js';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { countItems, readBotInventoryCounts, readBotInventoryItems } from '../state/materials.js';
import { runBoundedOperation } from './_operations.js';

const FISHING_ROD = 'fishing_rod';
const DEFAULT_ATTEMPT_TIMEOUT_MS = 45000;
const DEFAULT_PICKUP_TIMEOUT_MS = 8000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_WATER_SAFETY_POLL_MS = 250;
const DEFAULT_BOBBER_SPAWN_TIMEOUT_MS = 4000;
const DEFAULT_CAST_WATER_MAX_DISTANCE = 8;
const FISHING_PREFERRED_CAST_DISTANCE = 3;
const FISHING_CAST_BIAS = 0.32;
const FISHING_PARTICLE_SAMPLE_LOG_LIMIT = 12;
const WATER_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const DRY_AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

export async function run(bot, params = {}, ctx = {}) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');
  if (typeof bot.activateItem !== 'function') {
    return failed(bot, ctx, 'fish_until failed: bot.activateItem unavailable');
  }
  if (!bot._client?.on || !bot._client?.removeListener) {
    return failed(bot, ctx, 'fish_until failed: bot client packet listeners unavailable');
  }

  const target = missionTarget(params);
  if (!target.ok) return failed(bot, ctx, target.reason);

  const rod = await ensureFishingRodEquipped(bot, ctx);
  if (!rod.ok) {
    if (rod.preempted) return preempted(bot, ctx, rod.reason);
    return failed(bot, ctx, rod.reason);
  }

  const startedAtMs = Date.now();
  const deadlineAtMs = Number.isFinite(params.durationMs) ? startedAtMs + params.durationMs : Infinity;
  const maxAttempts = Number.isFinite(params.maxAttempts)
    ? params.maxAttempts
    : defaultMaxAttempts(target.catches, params.durationMs);
  const attemptTimeoutMs = params.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const bobberSpawnTimeoutMs = params.bobberSpawnTimeoutMs ?? DEFAULT_BOBBER_SPAWN_TIMEOUT_MS;
  const pickupTimeoutMs = params.pickupTimeoutMs ?? DEFAULT_PICKUP_TIMEOUT_MS;
  const caughtCounts = {};
  let catches = 0;
  let attempts = 0;
  let lastAttemptFailure = null;

  while (attempts < maxAttempts && catches < target.catches && Date.now() < deadlineAtMs) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during fish_until');
    attempts += 1;
    const before = readBotInventoryCounts(bot);
    if (!before.ok) return failed(bot, ctx, `inventory unavailable during fish_until: ${before.error}`);

    const castLook = await lookAtNearbyWater(bot, {
      signal: ctx.signal,
      maxDistance: DEFAULT_CAST_WATER_MAX_DISTANCE,
    });
    if (castLook?.preempted) return preempted(bot, ctx, castLook.reason);
    if (castLook?.ok === false) return failed(bot, ctx, castLook.reason);

    try {
      await fishOnce(bot, {
        signal: ctx.signal,
        attemptTimeoutMs,
        bobberSpawnTimeoutMs,
        waterSafetyPollMs: params.waterSafetyPollMs,
      });
      const catchDelta = await waitForCatchDelta(bot, before.inventory, {
        signal: ctx.signal,
        timeoutMs: pickupTimeoutMs,
      });
      catches += 1;
      mergeCounts(caughtCounts, catchDelta);
    } catch (err) {
      if (ctx.signal?.aborted || err?.code === 'FISHING_ABORTED') {
        cancelFishing(bot);
        return preempted(bot, ctx, `reactive preempt during fish_until attempt ${attempts}`);
      }
      cancelFishing(bot);
      lastAttemptFailure = errorMessage(err);
      if (!isTerminalFishingFailure(err) && attempts < maxAttempts && Date.now() < deadlineAtMs) {
        continue;
      }
      return failed(bot, ctx, `fish_until attempt ${attempts} failed: ${errorMessage(err)}`, {
        attempts,
        catches,
        caughtCounts: sortCounts(caughtCounts),
      });
    }
  }

  if (catches < target.requiredCatches) {
    const lastFailure = lastAttemptFailure ? `; lastAttemptFailure=${lastAttemptFailure}` : '';
    return failed(
      bot,
      ctx,
      `fish_until caught ${catches}/${target.requiredCatches} before ${stopReason({ attempts, maxAttempts, deadlineAtMs })}${lastFailure}`,
      { attempts, catches, caughtCounts },
    );
  }

  return {
    ok: true,
    reason: `fish_until caught ${catches} item${catches === 1 ? '' : 's'}`,
    attempts,
    catches,
    caughtCounts: sortCounts(caughtCounts),
    state: buildSnapshot(bot, ctx),
  };
}

function missionTarget(params) {
  const hasCatches = Number.isFinite(params.catches);
  const hasDuration = Number.isFinite(params.durationMs);
  if (!hasCatches && !hasDuration) {
    return { ok: false, reason: 'fish_until requires catches or durationMs' };
  }
  if (hasCatches && params.catches < 1) return { ok: false, reason: 'fish_until catches must be >= 1' };
  if (hasDuration && params.durationMs < 1) return { ok: false, reason: 'fish_until durationMs must be >= 1' };
  const requiredCatches = hasCatches ? params.catches : 0;
  return {
    ok: true,
    catches: hasCatches ? params.catches : Infinity,
    requiredCatches,
  };
}

async function ensureFishingRodEquipped(bot, ctx) {
  if (bot.heldItem?.name === FISHING_ROD) return { ok: true, source: 'held' };
  if (hasLoadedItemRegistry(bot) && !hasRegistryItem(bot, FISHING_ROD)) {
    return { ok: false, reason: 'unknown item "fishing_rod"' };
  }
  if (typeof bot.equip !== 'function') {
    return { ok: false, reason: 'fish_until failed: bot.equip unavailable' };
  }
  const inventory = readBotInventoryItems(bot);
  if (!inventory.ok) {
    return { ok: false, reason: `inventory unavailable during fish_until: ${inventory.error}` };
  }
  const rod = selectInventoryItem(inventory.items, FISHING_ROD);
  if (!rod) return { ok: false, reason: 'no fishing_rod in inventory or hand' };
  try {
    await runBoundedOperation(
      () => bot.humanizer?.equipItem
        ? bot.humanizer.equipItem(bot, rod, 'hand', {
          reason: 'fish_until.equip_rod',
          signal: ctx.signal,
        })
        : bot.equip(rod, 'hand'),
      {
        timeoutMs: config.executor?.equipOperationTimeoutMs ?? 10000,
        timeoutCode: 'FISHING_ROD_EQUIP_TIMEOUT',
        timeoutMessage: 'fishing rod equip operation timed out',
        signal: ctx.signal,
        abortCode: 'FISHING_ROD_EQUIP_ABORTED',
        abortMessage: 'fishing rod equip operation aborted',
      },
    );
  } catch (err) {
    if (ctx.signal?.aborted || err?.code === 'FISHING_ROD_EQUIP_ABORTED') {
      return { preempted: true, reason: 'reactive preempt during fishing rod equip' };
    }
    return { ok: false, reason: `fish_until failed to equip fishing_rod: ${errorMessage(err)}` };
  }
  return { ok: true, source: 'inventory' };
}

async function lookAtNearbyWater(bot, opts = {}) {
  if (typeof bot.humanizer?.lookAt !== 'function' && typeof bot.lookAt !== 'function') return null;
  if (typeof bot.findBlocks !== 'function' || typeof bot.blockAt !== 'function') return null;
  const waterType = bot.registry?.blocksByName?.water;
  if (!waterType?.id) return null;

  const blocks = nearbyWaterBlocks(bot, {
    waterId: waterType.id,
    maxDistance: opts.maxDistance ?? DEFAULT_CAST_WATER_MAX_DISTANCE,
  });
  if (blocks.length === 0) {
    log.executor.warn('fish_until.cast_look.no-water', {
      maxDistance: opts.maxDistance ?? DEFAULT_CAST_WATER_MAX_DISTANCE,
      position: positionForLog(bot.entity?.position),
    });
    return { ok: false, reason: `no visible water block within ${opts.maxDistance ?? DEFAULT_CAST_WATER_MAX_DISTANCE} blocks for fishing cast` };
  }

  const origin = bot.entity?.position || null;
  const ranked = blocks
    .map((block) => ({
      block,
      openWaterScore: openWaterScore(bot, block.position),
      sortKey: waterLookSortKey(block, origin),
    }))
    .sort((a, b) => b.openWaterScore - a.openWaterScore || a.sortKey - b.sortKey);
  const selected = ranked[0];
  const targetBlock = selected.block;
  const bias = castBiasForStand(targetBlock.position, origin);
  const lookTarget = offsetPosition(targetBlock.position, 0.5 + bias.x, 1.05, 0.5 + bias.z);
  const timeoutMs = config.executor?.lookOperationTimeoutMs ?? 5000;
  try {
    await runBoundedOperation(
      () => bot.humanizer?.lookAt
        ? bot.humanizer.lookAt(bot, lookTarget, {
          reason: 'fish_until.cast_look',
          signal: opts.signal,
        })
        : bot.lookAt(lookTarget, true),
      {
        timeoutMs,
        timeoutCode: 'FISHING_LOOK_OPERATION_TIMEOUT',
        timeoutMessage: `fishing water look operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'FISHING_LOOK_OPERATION_ABORTED',
        abortMessage: 'fishing water look operation aborted',
      },
    );
    log.executor.info('fish_until.cast_look', {
      water: positionForLog(targetBlock.position),
      lookAt: positionForLog(lookTarget),
      candidateCount: ranked.length,
      openWaterScore: selected.openWaterScore,
      castBias: bias,
    });
    return { ok: true, target: lookTarget };
  } catch (err) {
    if (opts.signal?.aborted || err?.code === 'FISHING_LOOK_OPERATION_ABORTED') {
      return { preempted: true, reason: 'reactive preempt during fishing water look' };
    }
    return { ok: false, reason: `fish_until failed to look at nearby water: ${errorMessage(err)}` };
  }
}

function nearbyWaterBlocks(bot, opts = {}) {
  const blocks = [];
  const seen = new Set();
  try {
    for (const position of bot.findBlocks({
      matching: opts.waterId,
      maxDistance: opts.maxDistance,
      count: 64,
    }) || []) {
      addWaterBlock(blocks, seen, bot.blockAt(position));
    }
  } catch {}

  if (blocks.length > 0) return blocks;
  const origin = bot.entity?.position;
  if (!origin) return blocks;
  const maxDistance = Math.max(1, Math.floor(opts.maxDistance ?? DEFAULT_CAST_WATER_MAX_DISTANCE));
  for (let dx = -maxDistance; dx <= maxDistance; dx += 1) {
    for (let dz = -maxDistance; dz <= maxDistance; dz += 1) {
      if (Math.hypot(dx, dz) > maxDistance) continue;
      for (let dy = -3; dy <= 2; dy += 1) {
        addWaterBlock(blocks, seen, readBlock(bot, offsetPosition(origin, dx, dy, dz)));
      }
    }
  }
  return blocks;
}

function addWaterBlock(blocks, seen, block) {
  if (!block?.position || !WATER_BLOCKS.has(String(block.name || ''))) return;
  const key = blockKey(block.position);
  if (seen.has(key)) return;
  seen.add(key);
  blocks.push(block);
}

function waterLookSortKey(block, origin) {
  if (!origin || !block?.position) return 0;
  const center = offsetPosition(block.position, 0.5, 0, 0.5);
  const dx = Number(center.x || 0) - Number(origin.x || 0);
  const dz = Number(center.z || 0) - Number(origin.z || 0);
  const horizontal = Math.hypot(dx, dz);
  const vertical = Math.abs((Number(block.position.y || 0) + 1) - Number(origin.y || 0));
  return Math.abs(horizontal - FISHING_PREFERRED_CAST_DISTANCE) + vertical * 0.5;
}

function openWaterScore(bot, position) {
  if (!position) return 0;
  let score = 0;
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (hasWaterName(readBlockName(bot, offsetPosition(position, dx, 0, dz)))) score += 1;
    }
  }
  return score;
}

function castBiasForStand(waterPosition, standPosition) {
  if (!waterPosition || !standPosition) return { x: 0, z: 0 };
  const dx = Number(standPosition.x || 0) - Number(waterPosition.x || 0);
  const dz = Number(standPosition.z || 0) - Number(waterPosition.z || 0);
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length <= 0) return { x: 0, z: 0 };
  return {
    x: round2((dx / length) * FISHING_CAST_BIAS),
    z: round2((dz / length) * FISHING_CAST_BIAS),
  };
}

function fishOnce(bot, opts) {
  const signal = opts.signal;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const bobberSpawnTimeoutMs = opts.bobberSpawnTimeoutMs ?? DEFAULT_BOBBER_SPAWN_TIMEOUT_MS;
  const waterSafetyPollMs = opts.waterSafetyPollMs ?? DEFAULT_WATER_SAFETY_POLL_MS;
  const client = bot._client;
  const bobberType = fishingBobberType(bot);
  let timeout = null;
  let spawnTimeout = null;
  let waterMonitor = null;
  let bobber = null;
  let particleSamples = 0;
  let lastParticleSample = null;
  let settled = false;
  let reelStarted = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (spawnTimeout) clearTimeout(spawnTimeout);
      if (waterMonitor) clearInterval(waterMonitor);
      client.removeListener('spawn_entity', onSpawnEntity);
      client.removeListener('world_particles', onWorldParticles);
      client.removeListener('entity_destroy', onEntityDestroy);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => fail(withCode(new Error('fishing aborted'), 'FISHING_ABORTED'));
    const onSpawnEntity = (packet) => {
      if (packet.type !== bobberType || bobber) return;
      bobber = {
        id: packet.entityId,
        entity: bot.entities?.[packet.entityId] || null,
        position: packetPosition(packet),
      };
      if (spawnTimeout) {
        clearTimeout(spawnTimeout);
        spawnTimeout = null;
      }
      log.executor.info('fish_until.bobber', {
        bobberType,
        entityId: packet.entityId,
        source: bobber.entity ? 'bot.entities' : 'spawn_packet',
        position: positionForLog(currentBobberPosition(bobber)),
      });
    };
    const onWorldParticles = (packet) => {
      const bobberPosition = currentBobberPosition(bobber);
      if (!bobberPosition) return;
      const sample = particleSummary(packet, bobberPosition);
      lastParticleSample = sample;
      if (isFishingParticleSample(sample) && particleSamples < FISHING_PARTICLE_SAMPLE_LOG_LIMIT) {
        particleSamples += 1;
        log.executor.info('fish_until.particle', sample);
      }
      if (!isLikelyBiteParticle(sample)) return;
      if (reelStarted) return;
      reelStarted = true;
      log.executor.info('fish_until.bite', sample);
      activateFishingItem(bot, {
        reason: 'fish_until.reel',
        signal,
      }).then(
        () => finish(),
        (err) => fail(new Error(`failed to reel fishing rod after bite: ${errorMessage(err)}`)),
      );
    };
    const onEntityDestroy = (packet) => {
      if (!bobber?.id || !packet.entityIds?.some((id) => id === bobber.id)) return;
      fail(withCode(new Error('fishing bobber disappeared before a bite was detected'), 'FISHING_BOBBER_DISAPPEARED'));
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    client.on('spawn_entity', onSpawnEntity);
    client.on('world_particles', onWorldParticles);
    client.on('entity_destroy', onEntityDestroy);
    timeout = setTimeout(() => {
      const bobberPosition = currentBobberPosition(bobber);
      const particleText = lastParticleSample ? `; lastParticle=${JSON.stringify(lastParticleSample)}` : '';
      fail(new Error(`fishing attempt timed out after ${attemptTimeoutMs}ms; bobber=${bobberPosition ? formatPosition(bobberPosition) : 'not-spawned'}; particleSamples=${particleSamples}${particleText}`));
    }, attemptTimeoutMs);
    spawnTimeout = setTimeout(() => {
      if (bobber) return;
      fail(withCode(
        new Error(`fishing attempt did not spawn a bobber within ${bobberSpawnTimeoutMs}ms`),
        'FISHING_BOBBER_NOT_SPAWNED',
      ));
    }, bobberSpawnTimeoutMs);
    waterMonitor = setInterval(() => {
      const water = fishingWaterUnsafeState(bot);
      if (!water.unsafe) return;
      triggerWaterRescue(bot);
      cancelFishing(bot);
      fail(withCode(new Error(`unsafe water state while fishing: ${water.reason}`), 'FISHING_WATER_UNSAFE'));
    }, waterSafetyPollMs);

    activateFishingItem(bot, {
      reason: 'fish_until.cast',
      signal,
    }).catch((err) => {
      fail(new Error(`failed to cast fishing rod: ${errorMessage(err)}`));
    });
    return undefined;
  });
}

function fishingWaterUnsafeState(bot) {
  const pos = bot.entity?.position;
  const feet = readBlockName(bot, pos);
  const head = readBlockName(bot, offsetPosition(pos, 0, 1, 0));
  const eyes = readBlockName(bot, offsetPosition(pos, 0, 1.62, 0));
  const inWater = bot.entity?.isInWater === true || hasWaterName(feet) || hasWaterName(head) || hasWaterName(eyes);
  const submerged = hasWaterName(head) || hasWaterName(eyes);
  const oxygenLevel = typeof bot.oxygenLevel === 'number'
    ? bot.oxygenLevel
    : typeof bot.entity?.oxygenLevel === 'number'
      ? bot.entity.oxygenLevel
      : null;
  const readableDryAir = [feet, head, eyes].every((name) => DRY_AIR_BLOCKS.has(String(name || '')));
  const oxygenLow = oxygenLevel != null && oxygenLevel <= 12 && (bot.entity?.isInWater === true || !readableDryAir);
  const sinking = inWater && (bot.entity?.velocity?.y ?? 0) < -0.05;
  if (!inWater && !submerged && !oxygenLow && !sinking) return { unsafe: false };
  const reasons = [];
  if (inWater) reasons.push('in-water');
  if (submerged) reasons.push('submerged');
  if (oxygenLow) reasons.push(`oxygen=${oxygenLevel}`);
  if (sinking) reasons.push(`sinking=${Math.round((bot.entity?.velocity?.y ?? 0) * 100) / 100}`);
  return {
    unsafe: true,
    reason: reasons.join(', '),
    inWater,
    submerged,
    oxygenLevel,
    oxygenLow,
    sinking,
  };
}

function hasWaterName(name) {
  return WATER_BLOCKS.has(String(name || ''));
}

function readBlockName(bot, position) {
  return readBlock(bot, position)?.name || null;
}

function readBlock(bot, position) {
  if (!position || typeof bot.blockAt !== 'function') return null;
  try {
    return bot.blockAt(position) || null;
  } catch {
    return null;
  }
}

function offsetPosition(position, x, y, z) {
  if (!position) return null;
  if (typeof position.offset === 'function') return position.offset(x, y, z);
  return {
    x: Number(position.x || 0) + x,
    y: Number(position.y || 0) + y,
    z: Number(position.z || 0) + z,
  };
}

async function waitForCatchDelta(bot, beforeCounts, opts = {}) {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PICKUP_TIMEOUT_MS;
  while (Date.now() - started <= timeoutMs) {
    if (opts.signal?.aborted) throw withCode(new Error('fishing pickup wait aborted'), 'FISHING_ABORTED');
    const after = readBotInventoryCounts(bot);
    if (!after.ok) throw new Error(`inventory unavailable during fish_until pickup wait: ${after.error}`);
    const delta = positiveCatchDelta(beforeCounts, after.inventory);
    if (Object.keys(delta).length > 0) return delta;
    await sleep(DEFAULT_POLL_MS, opts.signal);
  }
  throw new Error(`fishing completed but no caught item entered inventory within ${timeoutMs}ms`);
}

function positiveCatchDelta(before, after) {
  const delta = {};
  for (const [item, count] of Object.entries(after || {})) {
    if (item === FISHING_ROD) continue;
    const increase = count - (before?.[item] || 0);
    if (increase > 0) delta[item] = increase;
  }
  return sortCounts(delta);
}

function selectInventoryItem(items, name) {
  return (items || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.name === name)
    .sort((a, b) => itemSlot(a.item) - itemSlot(b.item) || a.index - b.index)
    .at(0)?.item || null;
}

function defaultMaxAttempts(catches, durationMs) {
  if (Number.isFinite(catches)) return Math.max(catches, catches * 3);
  return Math.max(1, Math.ceil((durationMs || DEFAULT_ATTEMPT_TIMEOUT_MS) / DEFAULT_ATTEMPT_TIMEOUT_MS) + 1);
}

function stopReason({ attempts, maxAttempts, deadlineAtMs }) {
  if (attempts >= maxAttempts) return `maxAttempts ${maxAttempts}`;
  if (Date.now() >= deadlineAtMs) return 'duration elapsed';
  return 'loop stopped';
}

function cancelFishing(bot) {
  try {
    activateFishingItem(bot, {
      reason: 'fish_until.cancel',
      critical: true,
    }).catch(() => {});
  } catch {}
}

function activateFishingItem(bot, opts = {}) {
  try {
    if (typeof bot.humanizer?.activateItem === 'function') {
      return Promise.resolve(bot.humanizer.activateItem(bot, opts));
    }
    return Promise.resolve(bot.activateItem());
  } catch (err) {
    return Promise.reject(err);
  }
}

function triggerWaterRescue(bot) {
  if (typeof bot.setControlState !== 'function') return;
  try {
    setFishingControlState(bot, 'jump', true, {
      reason: 'fish_until.water_rescue',
      critical: true,
    });
    const timer = setTimeout(() => {
      try {
        setFishingControlState(bot, 'jump', false, {
          reason: 'fish_until.water_rescue.clear',
          critical: true,
        });
      } catch {}
    }, 1200);
    timer.unref?.();
  } catch {}
}

function setFishingControlState(bot, control, value, opts = {}) {
  if (typeof bot.humanizer?.setControlState === 'function') {
    return bot.humanizer.setControlState(bot, control, value, opts);
  }
  return bot.setControlState(control, value);
}

function fishingBobberType(bot) {
  if (bot.supportFeature?.('fishingBobberCorrectlyNamed')) {
    const id = bot.registry?.entitiesByName?.fishing_bobber?.id;
    if (id !== undefined) return id;
  }
  return 90;
}

function packetPosition(packet) {
  if (packet.position) return { x: packet.position.x, y: packet.position.y, z: packet.position.z };
  return { x: packet.x || 0, y: packet.y || 0, z: packet.z || 0 };
}

function currentBobberPosition(bobber) {
  return bobber?.entity?.position || bobber?.position || null;
}

function particleSummary(packet, bobberPosition) {
  const x = packet.x || 0;
  const y = packet.y || 0;
  const z = packet.z || 0;
  const distanceToBobber = Math.round(Math.hypot(x - bobberPosition.x, z - bobberPosition.z) * 100) / 100;
  return {
    particle: packet.particle?.type || packet.particle?.name || String(packet.particleId ?? 'unknown'),
    amount: packet.amount ?? packet.particles ?? 0,
    position: { x, y, z },
    distanceToBobber,
    verticalDistanceToBobber: Math.round(Math.abs(y - bobberPosition.y) * 100) / 100,
    nearBobber: distanceToBobber <= 1.75,
  };
}

function isFishingParticleSample(sample) {
  const particle = String(sample?.particle || '');
  return sample?.nearBobber || particle.includes('splash') || particle.includes('fishing') || particle.includes('bubble');
}

function isLikelyBiteParticle(sample) {
  if (!sample.nearBobber) return false;
  const particle = String(sample.particle || '');
  if (particle.includes('splash')) return true;
  if (!particle.includes('fishing') && !particle.includes('bubble')) return false;
  if (sample.amount >= 6) return true;
  if (particle.includes('fishing') && sample.amount > 0 && sample.distanceToBobber <= 0.25) return true;
  return false;
}

function failed(bot, ctx, reason, extra = {}) {
  return { ok: false, reason, ...extra, state: buildSnapshot(bot, ctx) };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}

function mergeCounts(target, delta) {
  for (const [item, count] of Object.entries(delta || {})) {
    target[item] = (target[item] || 0) + count;
  }
  return target;
}

function sortCounts(counts) {
  return countItems(Object.entries(counts || {}).map(([name, count]) => ({ name, count })));
}

function itemSlot(item) {
  const slot = Number(item?.slot);
  return Number.isFinite(slot) ? slot : Number.MAX_SAFE_INTEGER;
}

function positionForLog(position) {
  if (!position) return null;
  return {
    x: round2(Number(position.x || 0)),
    y: round2(Number(position.y || 0)),
    z: round2(Number(position.z || 0)),
  };
}

function formatPosition(position) {
  const logged = positionForLog(position);
  return logged ? `${logged.x},${logged.y},${logged.z}` : 'unknown';
}

function blockKey(position) {
  if (!position) return 'unknown';
  return `${Math.floor(Number(position.x || 0))},${Math.floor(Number(position.y || 0))},${Math.floor(Number(position.z || 0))}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
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

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(withCode(new Error('sleep aborted'), 'FISHING_ABORTED'));
  return new Promise((resolve, reject) => {
    let timeout = null;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const done = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(withCode(new Error('sleep aborted'), 'FISHING_ABORTED'));
    };
    timeout = setTimeout(done, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function withCode(err, code) {
  err.code = code;
  return err;
}

function isTerminalFishingFailure(err) {
  return err?.code === 'FISHING_WATER_UNSAFE';
}

function errorMessage(err) {
  return err?.message || String(err);
}
