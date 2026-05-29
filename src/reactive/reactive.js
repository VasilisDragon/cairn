// Reactive loop — "DO NOT DIE" layer. No LLM. Hardcoded priority controller.
// Runs each physics tick. Evaluates from highest priority to lowest and acts on
// the first matching condition.
//
// ALL pathfinder writes go through bot.pathfinderOwner (decision 3). Reactive
// holds a token while it's not in NORMAL state; releasing the token unblocks
// the executor's resume gate (after the quiescence debounce).
//
// Priorities (top wins):
//   1. EMERGENCY_LOGOUT  — health <= critical and no safe escape => bot.quit()
//   2. WATER_ESCAPE      — submersion / oxygen loss / sinking => surface
//   3. FLEE_OR_ENGAGE    — hostile within scan radius => flee (or engage)
//   4. ON_FIRE           — DEFERRED. Mineflayer 4.37 does not cleanly expose
//                          the on-fire metadata bit; per design decision (D)
//                          we don't ship a guessy fallback. Tracked as a
//                          follow-up.
//   5. HAZARD_ABORT      — danger blocks / cliff underfoot or in front.
//                          Optional private/local water-bucket placement can
//                          react to detected lava/fire/magma blocks.
//   6. NORMAL            — release token; executor / advisor run freely

import pkgPathfinder from 'mineflayer-pathfinder';
const { Movements } = pkgPathfinder;
import config from '../config.js';
import log from '../logger.js';
import { applyHazardMovementPolicy } from '../control/movement_safety.js';
import { runBoundedOperation } from '../skills/_operations.js';
import { run as runConsumeSkill } from '../skills/consume.js';
import { activeEffects as readActiveEffects } from '../state/snapshot.js';
import { CLOSE_HOSTILE_PRESSURE_DISTANCE, chooseCombatResponse, chooseShieldBlockResponse } from './combat_policy.js';
import { chooseConsumableAction } from './consumable_policy.js';
import { FleeGoal } from './flee_goal.js';

const STATE = Object.freeze({
  NORMAL: 'NORMAL',
  FLEEING: 'FLEEING',
  ENGAGING: 'ENGAGING',
  WATER_ESCAPE: 'WATER_ESCAPE',
  HAZARD: 'HAZARD',
  EMERGENCY: 'EMERGENCY',
});

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'husk', 'stray',
  'drowned', 'phantom', 'piglin', 'piglin_brute', 'zombified_piglin',
  'hoglin', 'zoglin', 'wither_skeleton', 'blaze', 'magma_cube', 'slime',
  'ghast', 'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite',
  'vex', 'warden', 'breeze', 'bogged',
]);

const DANGER_BLOCKS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose']);
const WATER_BUCKET_HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block']);
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const WATER_BLOCKS = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const DRY_PASSABLE_EXCLUSIONS = new Set(['cobweb', 'powder_snow']);
const WATER_BUCKET_REPLACEABLE_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'fire', 'soul_fire', 'lava']);
const WATER_BUCKET_PICKUP_BLOCKS = new Set(['water', 'bubble_column']);
const WATER_BUCKET_FACE_UP = Object.freeze({ x: 0, y: 1, z: 0 });
const WATER_BUCKET_PLACE_VERIFY_TIMEOUT_MS = 1200;
const WATER_BUCKET_PICKUP_VERIFY_TIMEOUT_MS = 1200;
const WATER_BUCKET_PLACE_VERIFY_POLL_MS = 50;
const WATER_OXYGEN_ESCAPE_THRESHOLD = 16;
const WATER_LAND_SEARCH_RADIUS = 6;
const WATER_LAND_ADJACENCY_PENALTY = 16;
const WATER_EXIT_MAX_RISE_FROM_CURRENT_Y = 1;
const WATER_ESCAPE_CLEAR_DEBOUNCE_MS = 800;
const WATER_ESCAPE_TARGET_RELOCK_MS = 3000;
const WATER_ESCAPE_STALL_RELOCK_MS = 2500;
const WATER_ESCAPE_STALLED_TARGET_TTL_MS = 10000;
const WATER_ESCAPE_PROGRESS_DELTA_SQ = 0.04;
const WATER_ESCAPE_MOVE_DELTA_SQ = 0.04;
const WATER_ESCAPE_FALLBACK_SWIM_DISTANCE = 2.5;
const WATER_ESCAPE_EDGE_TRAP_DISTANCE_SQ = 2.25;
const SHALLOW_WATER_STALL_ESCAPE_MS = 2500;
const SHALLOW_WATER_STALL_MOVE_DELTA_SQ = 0.04;
const FLEE_WATER_LIQUID_COST = 80;
const RANGED_DRAW_SAFETY_POLL_MS = 50;
const RANGED_FIRE_VERIFY_POLL_MS = 50;
const ADJACENT_HAZARD_OFFSETS = Object.freeze([
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
]);

// ---- Reactive flee-dig allowlist (property-based) ----------------------------
//
// PHILOSOPHY: the survival reflex may break blocks to escape a threat, but
// only blocks that are (a) cheap to break bare-handed, (b) natural soft
// surface stuff — vegetation cover and soft earth, (c) not load-bearing,
// player-placed, valuable, or destructive of player work.
//
// Property gates do most of the filtering:
//   - diggable=true
//   - harvestTools===undefined (bare hand viable; excludes stone, ores,
//     anvils, cobweb — anything requiring a real tool or grindingly slow)
//   - material tag contains 'leaves' or 'mineable/shovel' (semicolon-delimited)
//   - hardness <= 0.7
//
// The NEVER list is a documented backstop for blocks that pass the gates but
// shouldn't be broken. It catches four categories:
//   PLAYER PLACEMENT  — farmland, cocoa, dirt_path, suspicious_*, etc.
//   PLAYER INTERACTION — containers, workstations, beds, anvils, doors
//   IRREVERSIBLE      — spawners, portal frames, dragon_egg, lodestones
//   HIDDEN VALUE      — suspicious_sand / suspicious_gravel (archaeology)
// Most NEVER entries are already excluded by the property gates today (tags
// or hardness); they're listed for explicit guarantee against future MC
// re-tagging.
const FLEE_ALLOWED_TAGS = new Set(['leaves', 'mineable/shovel']);
const FLEE_HARDNESS_CAP = 0.7;
const FLEE_NEVER_NAMES = new Set([
  // PLAYER PLACEMENT
  'farmland', 'dirt_path', 'cocoa',
  'suspicious_sand', 'suspicious_gravel',
  // PLAYER INTERACTION (containers + workstations + fixtures)
  'chest', 'trapped_chest', 'ender_chest', 'barrel',
  'hopper', 'dropper', 'dispenser',
  'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'smithing_table', 'cartography_table', 'fletching_table',
  'stonecutter', 'grindstone', 'loom',
  'brewing_stand', 'cauldron', 'composter',
  'lectern', 'jukebox', 'bell',
  'anvil', 'chipped_anvil', 'damaged_anvil',
  // IRREVERSIBLE / UNIQUE
  'beacon', 'conduit',
  'spawner', 'trial_spawner', 'vault',
  'end_portal_frame', 'jigsaw_block', 'structure_block', 'command_block',
  'lodestone', 'dragon_egg', 'respawn_anchor',
]);
const FLEE_NEVER_SUFFIXES = ['_concrete_powder', '_shulker_box', '_bed'];

function installFleeWaterAvoidance(movements, registry) {
  if (!movements || !registry?.blocksByName) return { ok: false, reason: 'registry unavailable' };
  movements.liquidCost = Math.max(movements.liquidCost ?? 1, FLEE_WATER_LIQUID_COST);
  movements.infiniteLiquidDropdownDistance = false;
  const avoidedNames = [];
  for (const name of WATER_BLOCKS) {
    const id = registry.blocksByName[name]?.id;
    if (id == null) continue;
    movements.blocksToAvoid.add(id);
    avoidedNames.push(name);
  }
  return {
    ok: true,
    liquidCost: movements.liquidCost,
    infiniteLiquidDropdownDistance: movements.infiniteLiquidDropdownDistance,
    avoidedNames,
  };
}

function isFleeBreakable(b) {
  if (!b || !b.diggable) return false;
  if (b.harvestTools !== undefined) return false;
  if (b.hardness == null || b.hardness > FLEE_HARDNESS_CAP) return false;
  if (FLEE_NEVER_NAMES.has(b.name)) return false;
  for (const sfx of FLEE_NEVER_SUFFIXES) if (b.name.endsWith(sfx)) return false;
  const tags = (b.material || '').split(';');
  for (const t of tags) if (FLEE_ALLOWED_TAGS.has(t)) return true;
  return false;
}

function isPlayerThreatEntity(entity) {
  return entity?.type === 'player' || entity?.name === 'player' || Boolean(entity?.username);
}

function isReactiveThreatEntity(entity, { includePlayers = false } = {}) {
  if (!entity) return false;
  return HOSTILE_NAMES.has(entity.name) || (includePlayers === true && isPlayerThreatEntity(entity));
}

function nearestHostileFiltered(bot, radius, filterId, opts = {}) {
  const me = bot.entity?.position;
  if (!me) return null;
  const e = bot.entities[filterId];
  if (!e || !e.position || !isReactiveThreatEntity(e, opts)) return null;
  const d = me.distanceTo(e.position);
  if (d > radius) return null;
  return { entity: e, distance: d, threats: hostileThreatSet(bot, radius, opts) };
}

function hostileThreatSet(bot, radius, opts = {}) {
  const me = bot.entity?.position;
  if (!me) return [];
  const threats = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position || !isReactiveThreatEntity(e, opts)) continue;
    const d = me.distanceTo(e.position);
    if (d <= radius) threats.push({ entity: e, distance: d });
  }
  threats.sort((a, b) => a.distance - b.distance || String(a.entity.id).localeCompare(String(b.entity.id), undefined, { numeric: true }));
  return threats;
}

function nearestHostile(bot, radius, opts = {}) {
  const threats = hostileThreatSet(bot, radius, opts);
  return threats[0] ? { ...threats[0], threats } : null;
}

export function evaluateFleeThreat({
  bot,
  state,
  fleeingFrom,
  enterRadius,
  exitRadius,
  exitDebounceMs,
  exitClearSince,
  now,
  includePlayers = false,
}) {
  let threat = null;
  let nextExitClearSince = exitClearSince || 0;
  let clearFleeing = false;
  const scanOpts = { includePlayers };

  if (state === STATE.FLEEING && fleeingFrom) {
    // While fleeing, lock onto the same entity and use the wider exit radius
    // to decide whether it's still a threat. Falling back to a fresh scan only
    // if the locked entity is gone or outside the exit radius. The fallback
    // still uses exitRadius so stacked waves cannot clear FLEEING while any
    // other hostile remains inside the configured de-aggro buffer.
    threat = nearestHostileFiltered(bot, exitRadius, fleeingFrom.id, scanOpts);
    if (!threat) {
      const newThreat = nearestHostile(bot, exitRadius, scanOpts);
      if (newThreat) {
        nextExitClearSince = 0;
        threat = newThreat;
      } else if (nextExitClearSince === 0) {
        nextExitClearSince = now;
      } else if (now - nextExitClearSince >= exitDebounceMs) {
        clearFleeing = true;
        nextExitClearSince = 0;
      }
    } else {
      nextExitClearSince = 0;
    }
  } else {
    threat = nearestHostile(bot, enterRadius, scanOpts);
    nextExitClearSince = 0;
  }

  return { threat, exitClearSince: nextExitClearSince, clearFleeing };
}

export function buildFleeTrackingRecord(bot, threat) {
  const me = bot.entity.position;
  const ep = threat.entity.position;
  const threats = threat.threats || [threat];
  return {
    entity: threat.entity.name,
    entityId: threat.entity.id,
    distance: threat.distance,
    threatCount: threats.length,
    threats: threats.map((entry) => ({
      entity: entry.entity.name,
      entityId: entry.entity.id,
      distance: entry.distance,
      position: { x: entry.entity.position.x, y: entry.entity.position.y, z: entry.entity.position.z },
    })),
    botPos: { x: me.x, y: me.y, z: me.z },
    entityPos: { x: ep.x, y: ep.y, z: ep.z },
    ...readPathfinderContext(bot),
    sprint: bot.controlState?.sprint === true,
    health: bot.health,
    food: bot.food,
  };
}

function isOpenAir(b) {
  return b != null && AIR_BLOCKS.has(b.name);
}

function hasWater(b) {
  return b != null && (WATER_BLOCKS.has(b.name) || b.isWaterlogged === true);
}

function isDryPassable(b) {
  return b != null
    && !hasWater(b)
    && b.name !== 'lava'
    && !DANGER_BLOCKS.has(b.name)
    && !DRY_PASSABLE_EXCLUSIONS.has(b.name)
    && (isOpenAir(b) || b.boundingBox === 'empty');
}

function isSolidDryGround(b) {
  return b != null && !isOpenAir(b) && !hasWater(b) && b.name !== 'lava' && b.boundingBox !== 'empty';
}

function isActuallyFalling(entity) {
  return entity?.onGround === false && (entity.velocity?.y ?? 0) < -0.01;
}

function isAirborne(entity) {
  return entity?.onGround === false;
}

function isUsingHeldItem(bot) {
  return bot.autoEat?.isEating === true || bot.usingHeldItem === true;
}

function errorMessage(err) {
  return err?.message || String(err);
}

function readPathfinderContext(bot) {
  const context = {
    owner: null,
    pathfinderIdle: null,
  };
  try {
    context.owner = bot.pathfinderOwner?.currentOwner?.() ?? null;
  } catch (err) {
    context.ownerError = errorMessage(err);
  }
  try {
    context.pathfinderIdle = bot.pathfinderOwner?.isIdle?.() ?? null;
  } catch (err) {
    context.pathfinderIdleError = errorMessage(err);
  }
  return context;
}

function readCombatInventoryItems(bot, logSink) {
  try {
    const items = bot.inventory?.items?.();
    return Array.isArray(items) ? items : [];
  } catch (err) {
    logSink?.warn?.('combat.inventory-error', { err: errorMessage(err) });
    return [];
  }
}

function readEquippedArmorItems(bot, logSink) {
  try {
    const equipment = bot.entity?.equipment;
    return Array.isArray(equipment) ? equipment.slice(2, 6).filter(Boolean) : [];
  } catch (err) {
    logSink?.warn?.('combat.armor-read-error', { err: errorMessage(err) });
    return [];
  }
}

function readOffHandItem(bot, logSink) {
  try {
    const equipment = bot.entity?.equipment;
    return Array.isArray(equipment) ? equipment[1] || null : null;
  } catch (err) {
    logSink?.warn?.('combat.offhand-read-error', { err: errorMessage(err) });
    return null;
  }
}

function readRangedLineOfSight(bot, threat, logSink) {
  if (typeof bot.canSeeEntity !== 'function') return null;
  try {
    return bot.canSeeEntity(threat.entity) === true;
  } catch (err) {
    logSink?.warn?.('combat.ranged-line-of-sight-error', {
      entity: threat?.entity?.name,
      entityId: threat?.entity?.id,
      err: errorMessage(err),
    });
    return null;
  }
}

function readActiveEffectList(bot, logSink) {
  const result = readActiveEffects(bot);
  if (result.error) logSink?.warn?.('reactive.consume.active-effects-error', { err: result.error });
  return result.effects;
}

function combatPolicyLogFields(combat) {
  return {
    policy: combat.reason,
    ...(Number.isFinite(combat.armorScore) && { armorScore: combat.armorScore }),
    ...(Number.isFinite(combat.requiredArmorScore) && { requiredArmorScore: combat.requiredArmorScore }),
    ...(Number.isFinite(combat.threatCount) && { threatCount: combat.threatCount }),
    ...(Number.isFinite(combat.maxMeleeEngageThreatCount) && { maxMeleeEngageThreatCount: combat.maxMeleeEngageThreatCount }),
    ...(Number.isFinite(combat.minMeleeSurvivalSecondsToEngage) && { minMeleeSurvivalSecondsToEngage: combat.minMeleeSurvivalSecondsToEngage }),
    ...(Number.isFinite(combat.minMeleeKillMarginSecondsToEngage) && { minMeleeKillMarginSecondsToEngage: combat.minMeleeKillMarginSecondsToEngage }),
    ...(combat.unsafeThreat && { unsafeThreat: combat.unsafeThreat }),
    ...(Number.isFinite(combat.closeThreatDistance) && { closeThreatDistance: roundDistance(combat.closeThreatDistance) }),
    ...(combat.targetThreat?.entity && {
      targetEntity: combat.targetThreat.entity.name,
      targetEntityId: combat.targetThreat.entity.id,
      targetDistance: roundDistance(combat.targetThreat.distance),
    }),
    ...(combat.meleeRisk && { meleeRisk: combat.meleeRisk }),
  };
}

function reactiveConsumeParams(decision, cfg) {
  const params = {
    item: decision.item?.name || (decision.action === 'drink_potion' ? 'potion' : ''),
  };
  if (decision.action === 'drink_potion') {
    params.allowPotions = cfg.reactiveConsumablePotions === true;
    if (decision.effect) params.effect = decision.effect;
    if (Number.isFinite(decision.level)) params.minLevel = decision.level;
  }
  if (params.item === 'enchanted_golden_apple') {
    params.allowEnchantedGoldenApples = cfg.reactiveConsumableEnchantedGoldenApples === true;
  }
  return params;
}

function positionRecord(pos) {
  if (!pos) return null;
  return { x: pos.x, y: pos.y, z: pos.z };
}

function distanceBetweenPositions(a, b) {
  if (!a || !b) return NaN;
  if (typeof a.distanceTo === 'function') return a.distanceTo(b);
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  return Math.hypot(dx, dy, dz);
}

function roundDistance(distance) {
  return Number.isFinite(distance) ? Math.round(distance * 10) / 10 : null;
}

function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function validateRangedFireStart(bot, threat, cfg, logSink) {
  const distance = distanceBetweenPositions(bot.entity?.position, threat?.entity?.position);
  const currentDistance = roundDistance(distance);
  if (!Number.isFinite(distance)) {
    return { ok: false, reason: 'ranged-fire-position-missing-before-activate', currentDistance, lineOfSight: null };
  }

  const minDistance = Number.isFinite(cfg.rangedCombatFireMinDistance) ? cfg.rangedCombatFireMinDistance : 7;
  const maxDistance = Number.isFinite(cfg.rangedCombatFireMaxDistance) ? cfg.rangedCombatFireMaxDistance : 16;
  if (distance < minDistance) {
    return { ok: false, reason: 'ranged-fire-too-close-before-activate', currentDistance, lineOfSight: null };
  }
  if (distance > maxDistance) {
    return { ok: false, reason: 'ranged-fire-too-far-before-activate', currentDistance, lineOfSight: null };
  }

  const closePressure = rangedFireClosePressure(bot, threat, CLOSE_HOSTILE_PRESSURE_DISTANCE);
  if (closePressure) {
    return {
      ok: false,
      reason: 'close-hostile-pressure-before-ranged-activate',
      currentDistance,
      lineOfSight: null,
      closeThreat: closePressure.entity.name,
      closeThreatId: closePressure.entity.id,
      closeThreatDistance: roundDistance(closePressure.distance),
    };
  }

  const lineOfSight = readRangedLineOfSight(bot, threat, logSink);
  if (lineOfSight !== true) {
    return {
      ok: false,
      reason: lineOfSight === false
        ? 'ranged-fire-line-of-sight-blocked-before-activate'
        : 'ranged-fire-line-of-sight-unknown-before-activate',
      currentDistance,
      lineOfSight,
    };
  }

  return { ok: true, currentDistance, lineOfSight };
}

function waitForRangedDrawSafety(bot, threat, drawMs) {
  const waitMs = Number.isFinite(drawMs) ? Math.max(0, drawMs) : 0;
  if (waitMs <= 0) return Promise.resolve({ ok: true });

  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const closePressure = rangedFireClosePressure(bot, threat, CLOSE_HOSTILE_PRESSURE_DISTANCE);
      if (closePressure) {
        resolve({
          ok: false,
          reason: 'close-hostile-pressure-during-ranged-draw',
          currentDistance: roundDistance(distanceBetweenPositions(bot.entity?.position, threat?.entity?.position)),
          lineOfSight: null,
          closeThreat: closePressure.entity.name,
          closeThreatId: closePressure.entity.id,
          closeThreatDistance: roundDistance(closePressure.distance),
        });
        return;
      }

      const remaining = waitMs - (Date.now() - started);
      if (remaining <= 0) {
        resolve({ ok: true });
        return;
      }
      setTimeout(tick, Math.min(RANGED_DRAW_SAFETY_POLL_MS, remaining));
    };
    tick();
  });
}

function readEntityHealth(entity) {
  const health = Number(entity?.health);
  return Number.isFinite(health) ? health : null;
}

function currentRangedTargetEntity(bot, threat) {
  const id = threat?.entity?.id;
  if (id != null && bot.entities && typeof bot.entities === 'object') {
    return bot.entities[id] || null;
  }
  return threat?.entity || null;
}

function rangedFireVerificationSnapshot(bot, threat, initialHealth, logSink) {
  const current = currentRangedTargetEntity(bot, threat);
  if (!current) {
    return { outcome: 'target-gone', currentDistance: null, lineOfSight: null };
  }

  const currentDistance = roundDistance(distanceBetweenPositions(bot.entity?.position, current.position));
  const lineOfSight = readRangedLineOfSight(bot, { entity: current }, logSink);
  const currentHealth = readEntityHealth(current);
  if (initialHealth != null && currentHealth != null && currentHealth < initialHealth) {
    return {
      outcome: 'target-damaged',
      currentDistance,
      lineOfSight,
      initialHealth: roundMetric(initialHealth),
      currentHealth: roundMetric(currentHealth),
    };
  }

  return { outcome: 'target-still-present', currentDistance, lineOfSight };
}

function waitForRangedFireVerification(bot, threat, verifyMs, logSink, initialTargetHealth = undefined) {
  const waitMs = Number.isFinite(verifyMs) ? Math.max(0, verifyMs) : 0;
  const initialHealth = initialTargetHealth === undefined
    ? readEntityHealth(currentRangedTargetEntity(bot, threat))
    : initialTargetHealth;
  const initial = rangedFireVerificationSnapshot(bot, threat, initialHealth, logSink);
  if (waitMs <= 0 || initial.outcome !== 'target-still-present') return Promise.resolve(initial);

  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const snapshot = rangedFireVerificationSnapshot(bot, threat, initialHealth, logSink);
      const remaining = waitMs - (Date.now() - started);
      if (snapshot.outcome !== 'target-still-present' || remaining <= 0) {
        resolve(snapshot);
        return;
      }
      setTimeout(tick, Math.min(RANGED_FIRE_VERIFY_POLL_MS, remaining));
    };
    setTimeout(tick, Math.min(RANGED_FIRE_VERIFY_POLL_MS, waitMs));
  });
}

function rangedFollowUpKey(record) {
  if (!record || typeof record !== 'object') return null;
  return record.entityId != null ? `id:${record.entityId}` : `name:${record.entity || 'unknown'}`;
}

function rangedOutcomeNeedsFollowUp(outcome) {
  return outcome === 'target-still-present' || outcome === 'target-damaged';
}

function rangedFireClosePressure(bot, targetThreat, maxDistance) {
  const me = bot.entity?.position;
  if (!me || !targetThreat?.entity || !Number.isFinite(maxDistance)) return null;
  const targetId = targetThreat.entity.id;
  const targetName = targetThreat.entity.name;
  let closest = null;
  for (const id in bot.entities || {}) {
    const entity = bot.entities[id];
    if (!entity || entity === bot.entity || !entity.position || !HOSTILE_NAMES.has(entity.name)) continue;
    if (entity.id === targetId && entity.name === targetName) continue;
    const pressureDistance = distanceBetweenPositions(me, entity.position);
    if (!Number.isFinite(pressureDistance) || pressureDistance > maxDistance) continue;
    if (!closest || pressureDistance < closest.distance) {
      closest = { entity, distance: pressureDistance };
    }
  }
  return closest;
}

function aimPointForEntity(entity) {
  const pos = entity?.position;
  if (!pos) return null;
  const height = Number.isFinite(entity.height) ? Math.min(Math.max(entity.height * 0.7, 0.5), 1.6) : 1;
  return typeof pos.offset === 'function'
    ? pos.offset(0, height, 0)
    : { x: pos.x, y: pos.y + height, z: pos.z };
}

function itemSlot(item) {
  return Number.isFinite(item?.slot) ? item.slot : null;
}

function currentDimension(bot) {
  const dim = bot.game?.dimension ?? bot.game?.dimensionType ?? bot.dimension ?? null;
  return typeof dim === 'string' ? dim : null;
}

function isNetherDimension(bot) {
  const dim = currentDimension(bot);
  return typeof dim === 'string' && dim.toLowerCase().includes('nether');
}

function readInventoryItemsForDecision(bot) {
  try {
    const items = bot.inventory?.items?.();
    return { items: Array.isArray(items) ? items : [], error: null };
  } catch (err) {
    return { items: [], error: errorMessage(err) };
  }
}

function chooseLowestSlotItem(items, name) {
  return items
    .filter((item) => item?.name === name)
    .sort((a, b) => (itemSlot(a) ?? Number.MAX_SAFE_INTEGER) - (itemSlot(b) ?? Number.MAX_SAFE_INTEGER))[0] || null;
}

function chooseEmptyBucketItem(bot) {
  if (bot.heldItem?.name === 'bucket') return { item: bot.heldItem, error: null };
  const inventory = readInventoryItemsForDecision(bot);
  if (inventory.error) return { item: null, error: inventory.error };
  return { item: chooseLowestSlotItem(inventory.items, 'bucket'), error: null };
}

function isWaterBucketReplaceable(b) {
  return b != null && WATER_BUCKET_REPLACEABLE_BLOCKS.has(b.name);
}

function isWaterBucketPickupBlock(b) {
  return b != null && WATER_BUCKET_PICKUP_BLOCKS.has(b.name);
}

function findWaterBucketPlacementTarget(bot, hz = null) {
  const pos = bot.entity?.position;
  if (!pos) return { ok: false, reason: 'missing-position' };
  const base = pos.floored?.() || pos.offset(-fraction(pos.x), -fraction(pos.y), -fraction(pos.z));
  const candidates = waterBucketPlacementCandidates(base, hz);
  const failures = [];
  for (const candidate of candidates) {
    const result = validateWaterBucketPlacementTarget(bot, candidate.target);
    if (result.ok) return { ...result, placementReason: candidate.reason };
    failures.push({
      reason: result.reason,
      block: result.block ?? null,
      at: result.at,
      placementReason: candidate.reason,
    });
  }
  const first = failures[0] || { reason: 'no-placement-candidates' };
  return {
    ok: false,
    ...first,
    placementFailures: failures,
  };
}

function validateWaterBucketPlacementTarget(bot, target) {
  const belowRead = readBlockAt(bot, target.offset(0, -1, 0));
  const feetRead = readBlockAt(bot, target);
  const headRead = readBlockAt(bot, target.offset(0, 1, 0));
  if (belowRead.error) return { ok: false, reason: 'world-read-failed', error: errorMessage(belowRead.error), at: target.offset(0, -1, 0) };
  if (feetRead.error) return { ok: false, reason: 'world-read-failed', error: errorMessage(feetRead.error), at: target };
  if (headRead.error) return { ok: false, reason: 'world-read-failed', error: errorMessage(headRead.error), at: target.offset(0, 1, 0) };

  const below = belowRead.block;
  const feet = feetRead.block;
  const head = headRead.block;
  if (!isSolidDryGround(below)) {
    return { ok: false, reason: 'no-solid-support', block: below?.name ?? null, at: target.offset(0, -1, 0) };
  }
  if (hasWater(feet)) {
    return { ok: false, reason: 'feet-already-water', block: feet?.name ?? null, at: target };
  }
  if (!isWaterBucketReplaceable(feet)) {
    return { ok: false, reason: 'feet-blocked', block: feet?.name ?? null, at: target };
  }
  if (!isDryPassable(head)) {
    return { ok: false, reason: 'head-blocked', block: head?.name ?? null, at: target.offset(0, 1, 0) };
  }

  return {
    ok: true,
    referenceBlock: below,
    faceVector: WATER_BUCKET_FACE_UP,
    target,
  };
}

function waterBucketPlacementCandidates(base, hz) {
  const candidates = [];
  const seen = new Set();
  const add = (target, reason) => {
    if (!target) return;
    const key = `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ target, reason });
  };

  const delta = hazardDeltaFromBase(base, hz?.at);
  const adjacentHorizontal = delta && Math.abs(delta.dy) <= 1 && (delta.dx !== 0 || delta.dz !== 0);
  if (adjacentHorizontal) {
    add(base.offset(-delta.dx, 0, -delta.dz), 'opposite-adjacent-hazard');
    if (delta.dx !== 0) {
      add(base.offset(0, 0, 1), 'perpendicular-adjacent-hazard');
      add(base.offset(0, 0, -1), 'perpendicular-adjacent-hazard');
    }
    if (delta.dz !== 0) {
      add(base.offset(1, 0, 0), 'perpendicular-adjacent-hazard');
      add(base.offset(-1, 0, 0), 'perpendicular-adjacent-hazard');
    }
    add(base, 'feet-fallback');
    return candidates;
  }

  add(base, 'feet');
  return candidates;
}

function hazardDeltaFromBase(base, hazardAt) {
  if (!base || !hazardAt) return null;
  return {
    dx: Math.max(-1, Math.min(1, Math.floor(hazardAt.x) - Math.floor(base.x))),
    dy: Math.max(-1, Math.min(1, Math.floor(hazardAt.y) - Math.floor(base.y))),
    dz: Math.max(-1, Math.min(1, Math.floor(hazardAt.z) - Math.floor(base.z))),
  };
}

export function chooseWaterBucketHazardResponse(bot, hz, {
  enabled = false,
  cooldownMs = 0,
  now = Date.now(),
  lastAttemptAt = 0,
} = {}) {
  if (!enabled) return { action: 'none', reason: 'disabled' };
  if (!hz || !WATER_BUCKET_HAZARDS.has(hz.kind)) {
    return { action: 'none', reason: 'unsupported-hazard', hazard: hz?.kind ?? null };
  }
  if (cooldownMs > 0 && now - lastAttemptAt < cooldownMs) {
    return { action: 'none', reason: 'cooldown', remainingMs: cooldownMs - (now - lastAttemptAt) };
  }
  if (isNetherDimension(bot)) {
    return { action: 'none', reason: 'nether-water-disabled', dimension: currentDimension(bot) };
  }
  if (typeof bot.equip !== 'function') return { action: 'none', reason: 'equip-unavailable' };
  const canUseOnBlock = typeof bot._genericPlace === 'function' || typeof bot.placeBlock === 'function';
  const canActivateFallback = typeof bot.activateItem === 'function' && typeof bot.lookAt === 'function';
  if (!canUseOnBlock && !canActivateFallback) {
    return { action: 'none', reason: 'water-bucket-place-unavailable' };
  }
  if (bot.autoEat?.isEating === true || bot.usingHeldItem === true) {
    return { action: 'none', reason: 'item-use-busy' };
  }

  const inventory = readInventoryItemsForDecision(bot);
  if (inventory.error) return { action: 'none', reason: 'inventory-read-failed', error: inventory.error };
  const item = chooseLowestSlotItem(inventory.items, 'water_bucket');
  if (!item) return { action: 'none', reason: 'no-water-bucket' };

  const placement = findWaterBucketPlacementTarget(bot, hz);
  if (!placement.ok) return { action: 'none', ...placement };

  return {
    action: 'place_water',
    reason: 'place-water-at-feet',
    hazard: hz.kind,
    hazardAt: hz.at,
    item,
    referenceBlock: placement.referenceBlock,
    faceVector: placement.faceVector,
    target: placement.target,
    placementReason: placement.placementReason,
  };
}

export function chooseWaterBucketPickupResponse(bot, placement, {
  enabled = true,
  maxDistance = 4.5,
} = {}) {
  if (!enabled) return { action: 'none', reason: 'disabled' };
  if (!placement?.target) return { action: 'none', reason: 'missing-placement' };
  if (isNetherDimension(bot)) {
    return { action: 'none', reason: 'nether-water-disabled', dimension: currentDimension(bot) };
  }
  if (typeof bot.equip !== 'function') return { action: 'none', reason: 'equip-unavailable' };
  const canActivateBlock = typeof bot.activateBlock === 'function';
  const canActivateFallback = typeof bot.activateItem === 'function' && typeof bot.lookAt === 'function';
  if (!canActivateBlock && !canActivateFallback) {
    return { action: 'none', reason: 'water-bucket-pickup-unavailable' };
  }
  if (bot.autoEat?.isEating === true || bot.usingHeldItem === true) {
    return { action: 'none', reason: 'item-use-busy' };
  }

  const distance = distanceBetweenPositions(bot.entity?.position, placement.target);
  const currentDistance = roundDistance(distance);
  const safeMax = Number.isFinite(maxDistance) ? maxDistance : 4.5;
  if (!Number.isFinite(distance)) return { action: 'none', reason: 'missing-position', currentDistance };
  if (distance > safeMax) return { action: 'none', reason: 'placed-water-too-far', currentDistance, maxDistance: safeMax };

  const targetRead = readBlockAt(bot, placement.target);
  if (targetRead.error) {
    return { action: 'none', reason: 'world-read-failed', error: errorMessage(targetRead.error), target: placement.target };
  }
  if (!isWaterBucketPickupBlock(targetRead.block)) {
    return {
      action: 'none',
      reason: 'placed-water-missing',
      block: targetRead.block?.name ?? null,
      target: placement.target,
    };
  }

  const bucket = chooseEmptyBucketItem(bot);
  if (bucket.error) return { action: 'none', reason: 'inventory-read-failed', error: bucket.error };
  if (!bucket.item) return { action: 'none', reason: 'no-empty-bucket' };

  return {
    action: 'pickup_water',
    reason: 'recover-placed-water',
    item: bucket.item,
    target: placement.target,
    targetBlock: targetRead.block,
    hazard: placement.hazard,
    hazardAt: placement.hazardAt,
  };
}

async function placeWaterBucketWithVerification(bot, decision, {
  signal = null,
} = {}) {
  const attempts = [];

  if (typeof bot._genericPlace === 'function') {
    try {
      await bot._genericPlace(decision.referenceBlock, decision.faceVector, {
        swingArm: 'right',
        forceLook: true,
      });
      await waitForBucketPlacedWater(bot, decision.target, { signal });
      return { method: 'generic-place' };
    } catch (err) {
      attempts.push({ method: 'generic-place', err: errorMessage(err) });
    }
  } else if (typeof bot.placeBlock === 'function') {
    try {
      await Promise.resolve(bot.humanizer?.placeBlock
        ? bot.humanizer.placeBlock(bot, decision.referenceBlock, decision.faceVector, {
          reason: 'hazard.water-bucket.place-block',
          critical: true,
          signal,
        })
        : bot.placeBlock(decision.referenceBlock, decision.faceVector));
      await waitForBucketPlacedWater(bot, decision.target, { signal });
      return { method: 'place-block' };
    } catch (err) {
      attempts.push({ method: 'place-block', err: errorMessage(err) });
    }
  }

  if (typeof bot.activateItem === 'function' && typeof bot.lookAt === 'function') {
    try {
      const lookTarget = bucketPlacementLookTarget(decision.referenceBlock, decision.faceVector);
      await bot.lookAt(lookTarget, true);
      await Promise.resolve(bot.humanizer?.activateItem
        ? bot.humanizer.activateItem(bot, {
          reason: 'hazard.water-bucket.activate-item',
          critical: true,
          signal,
        })
        : bot.activateItem());
      await waitForBucketPlacedWater(bot, decision.target, { signal });
      await stopTransientItemUse(bot, { signal, reason: 'hazard.water-bucket.stop-item-use' });
      return {
        method: 'activate-item',
        fallbackFrom: attempts.map((attempt) => `${attempt.method}: ${attempt.err}`).join('; ') || null,
      };
    } catch (err) {
      attempts.push({ method: 'activate-item', err: errorMessage(err) });
      await stopTransientItemUse(bot, { signal, reason: 'hazard.water-bucket.stop-item-use' });
    }
  }

  const detail = attempts.map((attempt) => `${attempt.method}: ${attempt.err}`).join('; ') || 'no placement method available';
  throw new Error(`water bucket placement failed; ${detail}`);
}

function bucketPlacementLookTarget(referenceBlock, faceVector) {
  const pos = referenceBlock?.position;
  if (!pos?.offset) return pos;
  return pos.offset(
    0.5 + (faceVector?.x || 0) * 0.5,
    0.5 + (faceVector?.y || 0) * 0.5,
    0.5 + (faceVector?.z || 0) * 0.5,
  );
}

async function waitForBucketPlacedWater(bot, target, {
  timeoutMs = WATER_BUCKET_PLACE_VERIFY_TIMEOUT_MS,
  pollMs = WATER_BUCKET_PLACE_VERIFY_POLL_MS,
  signal = null,
} = {}) {
  const started = Date.now();
  let lastBlock = null;
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    throwIfAborted(signal, 'HAZARD_WATER_BUCKET_ABORTED', 'hazard water bucket aborted');
    const read = readBlockAt(bot, target);
    if (read.error) {
      lastError = errorMessage(read.error);
    } else {
      lastBlock = read.block?.name ?? null;
      if (isWaterBucketPickupBlock(read.block)) return read.block;
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) break;
    await abortableSleep(Math.min(pollMs, timeoutMs - elapsed), signal, 'HAZARD_WATER_BUCKET_ABORTED', 'hazard water bucket aborted');
  }
  const suffix = lastError ? `; last read error=${lastError}` : `; targetBlock=${lastBlock ?? 'unknown'}`;
  throw new Error(`water bucket target did not become water within ${timeoutMs}ms${suffix}`);
}

async function stopTransientItemUse(bot, {
  signal = null,
  reason = 'hazard.stop-item-use',
} = {}) {
  if (bot?.usingHeldItem !== true || typeof bot.deactivateItem !== 'function') return;
  try {
    await Promise.resolve(bot.humanizer?.deactivateItem
      ? bot.humanizer.deactivateItem(bot, {
        reason,
        critical: true,
        signal,
      })
      : bot.deactivateItem());
  } catch {}
}

function abortableSleep(ms, signal, code, message) {
  if (!(ms > 0)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(operationError(code, message));
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {}
    };
    const onAbort = () => {
      cleanup();
      reject(operationError(code, message));
    };
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch (err) {
      reject(err);
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

function throwIfAborted(signal, code, message) {
  if (!signal?.aborted) return;
  throw operationError(code, message);
}

function operationError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function pickupWaterBucketWithVerification(bot, decision, {
  signal = null,
} = {}) {
  const attempts = [];

  if (typeof bot.activateBlock === 'function') {
    try {
      await Promise.resolve(bot.humanizer?.activateBlock
        ? bot.humanizer.activateBlock(bot, decision.targetBlock, {
          reason: 'hazard.water-bucket-pickup.activate-block',
          critical: true,
          signal,
        })
        : bot.activateBlock(decision.targetBlock));
      await waitForBucketPickedUpWater(bot, decision.target, { signal });
      return { method: 'activate-block' };
    } catch (err) {
      attempts.push({ method: 'activate-block', err: errorMessage(err) });
    }
  }

  if (typeof bot.activateItem === 'function' && typeof bot.lookAt === 'function') {
    try {
      const lookTarget = decision.target?.offset
        ? decision.target.offset(0.5, 0.5, 0.5)
        : decision.targetBlock?.position?.offset?.(0.5, 0.5, 0.5);
      if (lookTarget) await bot.lookAt(lookTarget, true);
      await Promise.resolve(bot.humanizer?.activateItem
        ? bot.humanizer.activateItem(bot, {
          reason: 'hazard.water-bucket-pickup.activate-item',
          critical: true,
          signal,
        })
        : bot.activateItem());
      await waitForBucketPickedUpWater(bot, decision.target, { signal });
      await stopTransientItemUse(bot, { signal, reason: 'hazard.water-bucket-pickup.stop-item-use' });
      return {
        method: 'activate-item',
        fallbackFrom: attempts.map((attempt) => `${attempt.method}: ${attempt.err}`).join('; ') || null,
      };
    } catch (err) {
      attempts.push({ method: 'activate-item', err: errorMessage(err) });
      await stopTransientItemUse(bot, { signal, reason: 'hazard.water-bucket-pickup.stop-item-use' });
    }
  }

  const detail = attempts.map((attempt) => `${attempt.method}: ${attempt.err}`).join('; ') || 'no pickup method available';
  throw new Error(`water bucket pickup failed; ${detail}`);
}

async function waitForBucketPickedUpWater(bot, target, {
  timeoutMs = WATER_BUCKET_PICKUP_VERIFY_TIMEOUT_MS,
  pollMs = WATER_BUCKET_PLACE_VERIFY_POLL_MS,
  signal = null,
} = {}) {
  const started = Date.now();
  let lastBlock = null;
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    throwIfAborted(signal, 'HAZARD_WATER_BUCKET_PICKUP_ABORTED', 'hazard water bucket pickup aborted');
    const read = readBlockAt(bot, target);
    if (read.error) {
      lastError = errorMessage(read.error);
    } else {
      lastBlock = read.block?.name ?? null;
      if (!isWaterBucketPickupBlock(read.block)) return read.block;
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) break;
    await abortableSleep(Math.min(pollMs, timeoutMs - elapsed), signal, 'HAZARD_WATER_BUCKET_PICKUP_ABORTED', 'hazard water bucket pickup aborted');
  }
  const suffix = lastError ? `; last read error=${lastError}` : `; targetBlock=${lastBlock ?? 'unknown'}`;
  throw new Error(`water bucket target did not clear within ${timeoutMs}ms${suffix}`);
}

function readBlockAt(bot, position) {
  if (typeof bot.blockAt !== 'function') return { block: null, error: null };
  try {
    return { block: bot.blockAt(position), error: null };
  } catch (err) {
    return { block: null, error: err };
  }
}

function worldReadFailureHazard(position, err) {
  return { kind: 'world_read_failed', at: position, error: errorMessage(err) };
}

export function shouldSuppressItemUseInState(state) {
  return state === STATE.HAZARD || state === STATE.WATER_ESCAPE || state === STATE.EMERGENCY;
}

export function scanImmediateHazard(bot, { holdFalling = false } = {}) {
  if (!isActuallyFalling(bot.entity) && !(holdFalling && isAirborne(bot.entity))) return null;
  if (!holdFalling && !isUsingHeldItem(bot)) return null;
  const pos = bot.entity?.position;
  if (!pos) return null;
  return {
    kind: 'fall',
    trigger: isUsingHeldItem(bot) ? 'falling-item-use' : 'falling-hold',
    at: pos.offset(0, -1, 0),
  };
}

export function cancelUnsafeItemUse(bot, logSink = null, eventPrefix = 'reactive') {
  const result = {
    autoEatCanceled: false,
    itemDeactivated: false,
  };

  if (bot.autoEat?.isEating === true && typeof bot.autoEat.cancelEat === 'function') {
    try {
      bot.autoEat.cancelEat();
      result.autoEatCanceled = true;
    } catch (err) {
      logSink?.warn?.(`${eventPrefix}.cancel-eat-error`, { err: err?.message || String(err) });
    }
  }

  if (bot.usingHeldItem === true && typeof bot.deactivateItem === 'function') {
    try {
      const deactivation = bot.humanizer?.deactivateItem
        ? bot.humanizer.deactivateItem(bot, {
          reason: `${eventPrefix}.cancel-held-item`,
          critical: true,
        })
        : bot.deactivateItem();
      if (deactivation && typeof deactivation.catch === 'function') {
        deactivation.catch((err) => {
          logSink?.warn?.(`${eventPrefix}.deactivate-item-error`, { err: err?.message || String(err) });
        });
      }
      result.itemDeactivated = true;
    } catch (err) {
      logSink?.warn?.(`${eventPrefix}.deactivate-item-error`, { err: err?.message || String(err) });
    }
  }

  return result;
}

export function cancelAutoEatStartIfUnsafe(bot, state, logSink = null, opts = {}) {
  if (!shouldSuppressItemUseInState(state)) return false;
  logSink?.warn?.('autoeat.start-while-suppressed', {
    state,
    food: opts?.food?.name,
  });

  cancelUnsafeItemUse(bot, logSink, 'autoeat-start-while-suppressed');

  // mineflayer-auto-eat emits eatStart before installing its cancellation
  // binding. A microtask catches that binding once eatStart returns.
  queueMicrotask(() => {
    cancelUnsafeItemUse(bot, logSink, 'autoeat-start-while-suppressed.deferred');
  });
  return true;
}

function fraction(n) {
  return n - Math.floor(n);
}

function positionDistanceSq(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dy = (a.y ?? 0) - (b.y ?? 0);
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return dx * dx + dy * dy + dz * dz;
}

function horizontalDistanceSq(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return dx * dx + dz * dz;
}

function clonePosition(pos) {
  if (!pos) return null;
  return { x: pos.x, y: pos.y, z: pos.z };
}

function offsetPosition(pos, dx, dy, dz) {
  if (!pos) return null;
  if (typeof pos.offset === 'function') return pos.offset(dx, dy, dz);
  return { x: (pos.x ?? 0) + dx, y: (pos.y ?? 0) + dy, z: (pos.z ?? 0) + dz };
}

function blockPositionKey(pos) {
  if (!pos) return null;
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function avoidedDryLandTarget(candidate, avoidTargets) {
  if (!candidate || !Array.isArray(avoidTargets) || avoidTargets.length === 0) return false;
  const key = blockPositionKey(candidate);
  return avoidTargets.some((target) => blockPositionKey(target?.position || target) === key);
}

export function scanWaterHazard(bot, opts = {}) {
  const pos = bot.entity?.position;
  if (!pos) return null;

  const feetRead = readBlockAt(bot, pos.offset(0, 0, 0));
  const headRead = readBlockAt(bot, pos.offset(0, 1, 0));
  const eyesRead = readBlockAt(bot, pos.offset(0, 1.62, 0));
  const feet = feetRead.block;
  const head = headRead.block;
  const eyes = eyesRead.block;
  const readFailed = !!(feetRead.error || headRead.error || eyesRead.error);
  const blockInWater = hasWater(feet) || hasWater(head) || hasWater(eyes);
  const entityOnlyWater = bot.entity?.isInWater === true && !blockInWater && !readFailed;
  const surfaceContact = entityOnlyWater ? scanSurfaceWaterContact(bot, pos) : { contact: false, readFailed: false };
  const surfaceWaterContact = surfaceContact.contact === true;
  const inWater = bot.entity?.isInWater === true || blockInWater || surfaceWaterContact;
  const submerged = hasWater(head) || hasWater(eyes);
  const oxygenLevel = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null;
  const oxygenLow = oxygenLevel != null && oxygenLevel <= WATER_OXYGEN_ESCAPE_THRESHOLD;
  const sinking = inWater && (bot.entity?.velocity?.y ?? 0) < -0.05;
  const oxygenThreat = oxygenLow && (inWater || submerged || readFailed);
  const holdingInWater = opts.holdInWater === true && inWater;

  if (!submerged && !oxygenThreat && !sinking && !holdingInWater) return null;

  return {
    kind: 'water_escape',
    inWater,
    submerged,
    oxygenLevel,
    oxygenLow,
    sinking,
    holdingInWater,
    ...(surfaceWaterContact ? { holdReason: 'surface-water-stall', surfaceWaterContact: true } : {}),
    velocityY: bot.entity?.velocity?.y,
    at: pos,
  };
}

function scanSurfaceWaterContact(bot, pos) {
  if (!pos || bot.entity?.onGround === true) return { contact: false, readFailed: false };
  const probes = [
    pos.offset(0, -0.2, 0),
    pos.offset(0, -0.6, 0),
  ];
  let readFailed = false;
  for (const probe of probes) {
    const { block: below, error } = readBlockAt(bot, probe);
    if (error) {
      readFailed = true;
      continue;
    }
    if (hasWater(below)) return { contact: true, readFailed };
  }
  return { contact: false, readFailed };
}

export function findNearestDryLand(bot, radius = WATER_LAND_SEARCH_RADIUS, opts = {}) {
  const pos = bot.entity?.position;
  if (!pos) return null;
  const base = pos.floored?.() || pos.offset(-fraction(pos.x), -fraction(pos.y), -fraction(pos.z));
  const avoidThreats = Array.isArray(opts.avoidThreats) ? opts.avoidThreats.filter((entity) => entity?.position) : [];
  const avoidTargets = Array.isArray(opts.avoidTargets) ? opts.avoidTargets.filter(Boolean) : [];
  const maxRiseFromCurrentY = Number.isFinite(opts.maxRiseFromCurrentY) ? opts.maxRiseFromCurrentY : null;
  const currentFloorY = Math.floor(pos.y);
  let best = null;
  let bestScore = Infinity;
  let bestDistSq = Infinity;

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 3; dy++) {
        const feetPos = base.offset(dx, dy, dz);
        if (avoidedDryLandTarget(feetPos, avoidTargets)) continue;
        if (maxRiseFromCurrentY != null && feetPos.y - currentFloorY > maxRiseFromCurrentY) continue;
        const groundRead = readBlockAt(bot, feetPos.offset(0, -1, 0));
        const feetRead = readBlockAt(bot, feetPos);
        const headRead = readBlockAt(bot, feetPos.offset(0, 1, 0));
        if (groundRead.error || feetRead.error || headRead.error) continue;
        const ground = groundRead.block;
        const feet = feetRead.block;
        const head = headRead.block;
        if (!isSolidDryGround(ground) || !isDryPassable(feet) || !isDryPassable(head)) continue;

        const distSq = dx * dx + dy * dy + dz * dz;
        const threatScore = dryLandThreatScore(feetPos, avoidThreats);
        const waterPenalty = dryLandWaterAdjacencyPenalty(bot, feetPos);
        const score = distSq - threatScore + waterPenalty;
        if (score < bestScore || (score === bestScore && distSq < bestDistSq)) {
          bestScore = score;
          bestDistSq = distSq;
          best = feetPos;
        }
      }
    }
  }

  return best;
}

export function waterEscapeClearStatus(bot, clearSince = 0, now = Date.now(), stableMs = WATER_ESCAPE_CLEAR_DEBOUNCE_MS) {
  const pos = bot.entity?.position;
  if (!pos) return { ready: false, clearSince: 0, reason: 'missing-position' };
  if (bot.entity?.isInWater === true) return { ready: false, clearSince: 0, reason: 'still-in-water' };
  if (bot.entity?.onGround === false) return { ready: false, clearSince: 0, reason: 'not-on-ground' };

  const feetRead = readBlockAt(bot, pos.offset(0, 0, 0));
  const headRead = readBlockAt(bot, pos.offset(0, 1, 0));
  const eyesRead = readBlockAt(bot, pos.offset(0, 1.62, 0));
  const groundRead = readBlockAt(bot, pos.offset(0, -1, 0));
  if (feetRead.error || headRead.error || eyesRead.error || groundRead.error) {
    return { ready: false, clearSince: 0, reason: 'world-read-failed' };
  }

  if (hasWater(feetRead.block) || hasWater(headRead.block) || hasWater(eyesRead.block)) {
    return { ready: false, clearSince: 0, reason: 'water-block-present' };
  }
  if (!isDryPassable(feetRead.block) || !isDryPassable(headRead.block)) {
    return { ready: false, clearSince: 0, reason: 'body-space-blocked' };
  }
  if (!isSolidDryGround(groundRead.block)) {
    return { ready: false, clearSince: 0, reason: 'no-solid-dry-ground' };
  }

  const startedAt = clearSince || now;
  const stableForMs = now - startedAt;
  return {
    ready: stableForMs >= stableMs,
    clearSince: startedAt,
    reason: stableForMs >= stableMs ? 'stable-dry-ground' : 'waiting-for-stable-dry-ground',
    stableForMs,
  };
}

function waterEscapeTargetStillUsable(bot, target) {
  if (!target || !bot.entity?.position) return false;
  if (target.y - Math.floor(bot.entity.position.y) > WATER_EXIT_MAX_RISE_FROM_CURRENT_Y) return false;
  const groundRead = readBlockAt(bot, target.offset(0, -1, 0));
  const feetRead = readBlockAt(bot, target);
  const headRead = readBlockAt(bot, target.offset(0, 1, 0));
  if (groundRead.error || feetRead.error || headRead.error) return false;
  return isSolidDryGround(groundRead.block) && isDryPassable(feetRead.block) && isDryPassable(headRead.block);
}

function dryLandThreatScore(candidate, threats) {
  if (threats.length === 0) return 0;
  let minDistSq = Infinity;
  for (const threat of threats) {
    const dx = candidate.x - threat.position.x;
    const dy = candidate.y - threat.position.y;
    const dz = candidate.z - threat.position.z;
    minDistSq = Math.min(minDistSq, dx * dx + dy * dy + dz * dz);
  }
  return Number.isFinite(minDistSq) ? Math.min(minDistSq, 64) : 0;
}

function dryLandWaterAdjacencyPenalty(bot, candidate) {
  const offsets = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  let penalty = 0;
  for (const [dx, dz] of offsets) {
    try {
      const feet = bot.blockAt(candidate.offset(dx, 0, dz));
      const ground = bot.blockAt(candidate.offset(dx, -1, dz));
      if (hasWater(feet) || hasWater(ground)) penalty += WATER_LAND_ADJACENCY_PENALTY;
    } catch {
      // Candidate itself was readable; ignore unreadable neighbors instead of
      // making emergency water escape impossible on partial chunk data.
    }
  }
  return penalty;
}

export function buildWaterEscapeRecord(bot, water, target) {
  return {
    kind: water.kind,
    inWater: water.inWater,
    submerged: water.submerged,
    oxygenLevel: water.oxygenLevel,
    oxygenLow: water.oxygenLow,
    sinking: water.sinking,
    ...(water.holdingInWater ? { holdingInWater: true } : {}),
    ...(water.holdReason ? { holdReason: water.holdReason } : {}),
    velocityY: water.velocityY,
    botPos: bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
    target: target ? { x: target.x, y: target.y, z: target.z } : null,
    ...readPathfinderContext(bot),
    health: bot.health,
    food: bot.food,
  };
}

export function scanHazard(bot) {
  const pos = bot.entity?.position;
  if (!pos) return null;
  const yaw = bot.entity.yaw || 0;
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const probes = [
    pos.offset(0, -1, 0),
    pos.offset(0, 0, 0),
    pos.offset(0, 1, 0),
    pos.offset(dx, -1, dz),
    pos.offset(dx, 0, dz),
  ];
  for (const [ox, oy, oz] of ADJACENT_HAZARD_OFFSETS) {
    probes.push(pos.offset(ox, oy, oz));
  }
  for (const p of probes) {
    const { block: b, error } = readBlockAt(bot, p);
    if (error) return worldReadFailureHazard(p, error);
    if (!b) continue;
    if (DANGER_BLOCKS.has(b.name)) return { kind: b.name, at: p };
  }
  if (isActuallyFalling(bot.entity)) {
    let air = 0;
    for (let dy = 1; dy <= 6; dy++) {
      const p = pos.offset(0, -dy, 0);
      const { block: b, error } = readBlockAt(bot, p);
      if (error) return worldReadFailureHazard(p, error);
      if (isOpenAir(b)) air++;
      else break;
    }
    if (air >= 4) return { kind: 'fall', depth: air, at: pos.offset(0, -1, 0) };
  }
  return null;
}

export function buildHazardLogRecord(bot, hz) {
  const record = {
    kind: hz.kind,
    at: hz.at,
    onGround: bot.entity?.onGround,
    velocityY: bot.entity?.velocity?.y,
    autoEatEating: bot.autoEat?.isEating === true,
    autoEatEnabled: bot.autoEat?.enabled ?? null,
    usingHeldItem: bot.usingHeldItem === true,
    ...readPathfinderContext(bot),
    health: bot.health,
    food: bot.food,
  };
  if (hz.trigger) record.trigger = hz.trigger;
  if (hz.error) record.error = hz.error;
  return record;
}

export class ReactiveController {
  constructor(bot) {
    this.bot = bot;
    this.bot.reactiveController = this;
    this.cfg = config.reactive;
    this.log = log.reactive;
    this.state = STATE.NORMAL;
    this.lastTick = 0;
    this.lastHazardLogAt = 0;
    this.lastWaterLogAt = 0;
    this._waterEscapeClearSince = 0;
    this._waterEscapeTarget = null;
    this._waterEscapeTargetAt = 0;
    this._waterEscapeProgress = null;
    this._waterEscapeAvoidTargets = [];
    this._shallowWaterStall = null;
    this.transitionCount = 0;
    this.transitionHistory = [];
    this.lastTransition = null;
    this.fleeingFrom = null;
    this.engaging = null;
    this._combatEquipPromise = null;
    this._combatRangedEquipPromise = null;
    this._combatRangedFirePromise = null;
    this._combatRangedFireAbortController = null;
    this._lastCombatRangedFireAt = 0;
    this._lastCombatRangedFireVerification = null;
    this._combatRangedFireFollowUp = null;
    this._combatShieldEquipPromise = null;
    this._shieldBlockActive = false;
    this._shieldBlockThreatId = null;
    this._reactiveConsumePromise = null;
    this._reactiveConsumeAbortController = null;
    this._lastReactiveConsumeAt = 0;
    this._hazardWaterBucketPromise = null;
    this._hazardWaterBucketAbortController = null;
    this._hazardWaterPickupPromise = null;
    this._hazardWaterPickupAbortController = null;
    this._lastHazardWaterPlacement = null;
    this._lastHazardWaterBucketAt = 0;
    this._lastHazardWaterBucketLogAt = 0;
    this.hostileScanCounter = 0;
    this._lastCloseFleeRepathAt = 0;
    this.shuttingDown = false;
    // Exit-hysteresis: when FLEEING, we require the threat to be outside
    // hostileExitRadius for hostileExitDebounceMs continuously before
    // transitioning back to NORMAL. Prevents FLEEING/NORMAL churn for a
    // mob hovering near hostileScanRadius (the enter threshold).
    this._exitClearSince = 0;

    // The pathfinder-owner token held while in a reactive state. Released when
    // we transition back to NORMAL.
    this._tokenHandle = null;
    this._autoEatSuppressed = false;
    this._lastObservedHealth = Number.isFinite(bot.health) ? bot.health : null;
    this._recentDamageEvents = [];

    // Register before auto-eat so survival preemption observes hazards before
    // auto-eat can start a fresh consume cycle in the same physics tick.
    this._bindEvent(bot, 'physicsTick', () => this._tick(), 'bot');

    // Auto-eat config — mineflayer-auto-eat v5 API.
    if (bot.autoEat?.setOpts) {
      try {
        bot.autoEat.setOpts({
          priority: this.cfg.autoEatPriority,
          minHunger: this.cfg.autoEatStartAt,
          minHealth: 14,
          bannedFood: ['rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye'],
        });
      } catch (err) {
        this.log.warn('autoeat.setopts-error', { err: errorMessage(err) });
      }
      this._bindEvent(bot.autoEat, 'eatStart', (opts) => {
        this.log.info('autoeat.start', { food: opts?.food?.name });
        cancelAutoEatStartIfUnsafe(bot, this.state, this.log, opts);
      }, 'autoEat');
      this._bindEvent(bot.autoEat, 'eatFinish', (opts) => this.log.info('autoeat.finish', { food: opts?.food?.name }), 'autoEat');
      this._bindEvent(bot.autoEat, 'eatFail', (err) => this.log.warn('autoeat.error', { err: err?.message || String(err) }), 'autoEat');
      try { bot.autoEat.enableAuto(); this.log.info('autoeat.enabled'); } catch (err) { this.log.warn('autoeat.enable-error', { err: err.message }); }
    } else {
      this.log.warn('autoeat.not-ready', { msg: 'bot.autoEat unavailable at reactive init' });
    }

    this._movements = this._createMovements('reactive.movements', { canDig: false });

    // Dedicated Movements for the reactive flee branch. canDig=true is the
    // only relaxation; everything else stays restrictive. dontMineUnderFalling
    // Block and dontCreateFlow stay at their defaults (true) — verified to
    // fire inside Movements.safeToBreak.
    this._fleeMovements = this._createMovements('flee.movements', { canDig: true });

    // Compute the property-based allowlist (see top-of-file comment block).
    this._installFleeBreakAllowlist();
    this._installFleeWaterAvoidance();

    this._bindEvent(bot, 'death', () => this._transition(STATE.NORMAL, 'death-reset'), 'bot');
    this._bindEvent(bot, 'end', () => { this.shuttingDown = true; this._releaseToken(); }, 'bot');

    this.log.info('reactive.init', {
      lowHealthFlee: this.cfg.lowHealthFleeThreshold,
      critLogout: this.cfg.criticalHealthLogoutThreshold,
      hostileScan: this.cfg.hostileScanRadius,
      engageOverFlee: this.cfg.engageOverFlee,
    });
  }

  _createMovements(eventName, { canDig }) {
    let movements;
    try {
      movements = new Movements(this.bot);
    } catch (err) {
      this.log.error(`${eventName}.error`, { err: errorMessage(err) });
      return null;
    }
    try {
      movements.canDig = canDig;
      movements.allow1by1towers = false;
      movements.allowParkour = false;
      movements.allowSprinting = true;
      applyHazardMovementPolicy(movements, this.bot, { logger: this.log });
      return movements;
    } catch (err) {
      this.log.error(`${eventName}.policy-error`, { err: errorMessage(err) });
      return null;
    }
  }

  _installFleeBreakAllowlist() {
    if (!this._fleeMovements) return;
    const blocksArray = this.bot.registry?.blocksArray;
    if (!Array.isArray(blocksArray)) {
      this.log.error('flee.movements.registry-error', { err: 'bot.registry.blocksArray unavailable' });
      this._fleeMovements = null;
      return;
    }
    const admittedNames = [];
    const admittedIds = new Set();
    for (const b of blocksArray) {
      if (isFleeBreakable(b)) {
        admittedNames.push(b.name);
        admittedIds.add(b.id);
      }
    }
    // Default constructor put non-diggable blocks in blocksCantBreak.
    // Add every diggable block too, then subtract the admitted ones.
    for (const b of blocksArray) {
      if (!b.diggable) continue;
      if (admittedIds.has(b.id)) continue;
      this._fleeMovements.blocksCantBreak.add(b.id);
    }
    // Loud floor. Expected ~25 on 1.21 (11 leaves + ~14 surviving
    // mineable/shovel earth blocks). Below 15 means either the leaf side or
    // the shovel side broke entirely — fail loud so the regression can't hide.
    const FLEE_ADMITTED_FLOOR = 15;
    if (admittedNames.length < FLEE_ADMITTED_FLOOR) {
      this.log.error('flee.movements.ALLOWLIST_LOW', {
        count: admittedNames.length,
        floor: FLEE_ADMITTED_FLOOR,
        names: admittedNames,
        msg: 'flee allowlist count below expected floor — flee dig-out likely inert',
      });
    } else {
      this.log.info('flee.movements', {
        canDig: true,
        admittedCount: admittedNames.length,
        admittedNames,
      });
    }
  }

  _installFleeWaterAvoidance() {
    if (!this._fleeMovements) return;
    const result = installFleeWaterAvoidance(this._fleeMovements, this.bot.registry);
    if (!result.ok) {
      this.log.warn('flee.water-avoidance-unavailable', { reason: result.reason });
      return;
    }
    this.log.info('flee.water-avoidance', result);
  }

  _bindEvent(target, eventName, listener, source) {
    try {
      target.on(eventName, listener);
      return true;
    } catch (err) {
      this.log.warn('reactive.listener-error', {
        source,
        event: eventName,
        err: errorMessage(err),
      });
      return false;
    }
  }

  /** Acquire the reactive token if we don't hold it yet. */
  _ensureToken(reason) {
    if (this._tokenHandle) return this._tokenHandle;
    try {
      this._tokenHandle = this.bot.pathfinderOwner.acquire('reactive', { reason });
    } catch (err) {
      this.log.error('owner.acquire-error', {
        reason,
        err: errorMessage(err),
        ...readPathfinderContext(this.bot),
      });
      this._tokenHandle = null;
    }
    return this._tokenHandle;
  }

  _releaseToken() {
    if (this._tokenHandle) {
      // Stop the pathfinder before releasing. Flee uses a dynamic goal
      // (GoalInvert(GoalFollow) with dynamic=true) which does NOT auto-clear
      // on completion — without this stop, the bot would keep fleeing the
      // entity after we've transitioned out of FLEEING. Harmless for HAZARD
      // (already stopped on entry) and ENGAGING.
      this._stopOwnedPath(this._tokenHandle, 'owner.release');
      try { this._tokenHandle.release(); } catch (err) { this.log.warn('release-error', { err: err.message }); }
      this._tokenHandle = null;
    }
  }

  _transition(next, reason, extra = {}) {
    if (this.state === next) return;
    const prev = this.state;
    const shouldResumeAutoEat = (
      (prev === STATE.WATER_ESCAPE || prev === STATE.HAZARD) &&
      next !== STATE.WATER_ESCAPE &&
      next !== STATE.HAZARD
    );
    const shouldStartWaterPickup = prev === STATE.HAZARD && next === STATE.NORMAL;
    if (prev === STATE.WATER_ESCAPE && next !== STATE.WATER_ESCAPE) {
      this._clearWaterEscapeControls();
      this._waterEscapeTarget = null;
      this._waterEscapeTargetAt = 0;
      this._waterEscapeProgress = null;
      this._waterEscapeAvoidTargets = [];
      this._shallowWaterStall = null;
    }
    if (prev === STATE.HAZARD && next !== STATE.HAZARD) this._abortHazardWaterBucket(reason);
    if (next !== STATE.NORMAL) this._abortHazardWaterPickup(reason);
    if (
      next === STATE.NORMAL ||
      next === STATE.WATER_ESCAPE ||
      next === STATE.HAZARD ||
      next === STATE.EMERGENCY ||
      next === STATE.ENGAGING
    ) {
      this._abortCombatRangedFire(reason);
    }
    if (
      next === STATE.NORMAL ||
      next === STATE.WATER_ESCAPE ||
      next === STATE.HAZARD ||
      next === STATE.EMERGENCY
    ) {
      this._releaseShieldBlock(reason);
    }
    if (
      next === STATE.NORMAL ||
      next === STATE.WATER_ESCAPE ||
      next === STATE.HAZARD ||
      next === STATE.EMERGENCY
    ) {
      this._abortReactiveConsume(reason);
    }
    this.state = next;
    const transition = { from: prev, to: next, reason, ...extra, at: Date.now() };
    this.transitionCount += 1;
    this.lastTransition = transition;
    this.transitionHistory.push(transition);
    if (this.transitionHistory.length > 100) this.transitionHistory.shift();
    this.log.info('state.transition', transition);
    if (next !== STATE.FLEEING) this._lastCloseFleeRepathAt = 0;
    if (next === STATE.NORMAL) {
      this._releaseToken();
    }
    if (shouldResumeAutoEat) {
      this._resumeAutoEat(reason);
    }
    if (shouldStartWaterPickup) {
      this._startHazardWaterBucketPickup(reason);
    }
    // Token acquisition for non-NORMAL states happens at the action site
    // (_setFleeGoal, hazard branch, etc.) so the reason carries through.
  }

  _recentDamageWindowMs() {
    return Number.isFinite(this.cfg.recentDamageWindowMs)
      ? Math.max(1000, this.cfg.recentDamageWindowMs)
      : 10000;
  }

  _pruneRecentDamage(now = Date.now()) {
    const cutoff = now - this._recentDamageWindowMs();
    this._recentDamageEvents = this._recentDamageEvents.filter((event) => event.at >= cutoff);
  }

  _recordRecentDamage(now = Date.now()) {
    const health = Number(this.bot.health);
    if (!Number.isFinite(health)) return;
    if (!Number.isFinite(this._lastObservedHealth)) {
      this._lastObservedHealth = health;
      this._pruneRecentDamage(now);
      return;
    }

    const lost = this._lastObservedHealth - health;
    if (lost > 0) {
      const amount = roundMetric(lost);
      this._recentDamageEvents.push({ amount, at: now });
      this.log.info('damage.observed', {
        amount,
        health,
        previousHealth: roundMetric(this._lastObservedHealth),
        recentDamage: this.recentDamagePressure(now),
      });
    }
    this._lastObservedHealth = health;
    this._pruneRecentDamage(now);
  }

  recentDamagePressure(now = Date.now()) {
    this._pruneRecentDamage(now);
    const windowMs = this._recentDamageWindowMs();
    const totalDamage = this._recentDamageEvents.reduce((sum, event) => sum + (Number(event.amount) || 0), 0);
    const lastDamageAt = this._recentDamageEvents.reduce((latest, event) => Math.max(latest, event.at), -Infinity);
    return {
      windowMs,
      totalDamage: roundMetric(totalDamage),
      recentDamagePerSecond: roundMetric(totalDamage / (windowMs / 1000)),
      lastDamageMsAgo: Number.isFinite(lastDamageAt) ? Math.max(0, Math.round(now - lastDamageAt)) : null,
    };
  }

  lastRangedFireVerification(now = Date.now(), maxAgeMs = 10000) {
    const record = this._lastCombatRangedFireVerification;
    if (!record || typeof record !== 'object') return null;
    const readAt = Number(record.at);
    const ageMs = Number.isFinite(readAt) ? Math.max(0, Math.round(now - readAt)) : null;
    if (ageMs != null && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs > maxAgeMs) return null;
    const { at, ...compact } = record;
    return { ...compact, ageMs };
  }

  _rangedFollowUpWindowMs() {
    return Number.isFinite(this.cfg.rangedCombatFireFollowUpWindowMs)
      ? Math.max(0, this.cfg.rangedCombatFireFollowUpWindowMs)
      : 10000;
  }

  _rangedMaxFollowUpShots() {
    return Number.isFinite(this.cfg.rangedCombatFireMaxFollowUpShots)
      ? Math.max(1, Math.floor(this.cfg.rangedCombatFireMaxFollowUpShots))
      : 3;
  }

  _rangedFollowUpDecision(threat, now = Date.now()) {
    const state = this._combatRangedFireFollowUp;
    if (!state || typeof state !== 'object') return { ok: true };
    const key = rangedFollowUpKey({ entityId: threat?.entity?.id, entity: threat?.entity?.name });
    if (!key || state.targetKey !== key) return { ok: true };
    const windowMs = this._rangedFollowUpWindowMs();
    const ageMs = Number.isFinite(state.startedAt) ? Math.max(0, now - state.startedAt) : null;
    if (ageMs != null && ageMs > windowMs) {
      this._combatRangedFireFollowUp = null;
      return { ok: true };
    }
    const maxFollowUpShots = this._rangedMaxFollowUpShots();
    if (Number(state.shots || 0) < maxFollowUpShots) return { ok: true };
    return {
      ok: false,
      reason: 'ranged-fire-followup-limit',
      followUpShots: state.shots,
      maxFollowUpShots,
      followUpWindowMs: windowMs,
      followUpAgeMs: ageMs == null ? null : Math.round(ageMs),
      lastOutcome: state.lastOutcome,
      lastDistance: state.lastDistance,
    };
  }

  _recordRangedFollowUp(verification, now = Date.now()) {
    if (!verification || typeof verification !== 'object') return null;
    if (!rangedOutcomeNeedsFollowUp(verification.outcome)) {
      this._combatRangedFireFollowUp = null;
      return null;
    }
    const targetKey = rangedFollowUpKey(verification);
    if (!targetKey) return null;
    const windowMs = this._rangedFollowUpWindowMs();
    let state = this._combatRangedFireFollowUp;
    const stale = state?.targetKey === targetKey
      && Number.isFinite(state.startedAt)
      && now - state.startedAt > windowMs;
    if (!state || state.targetKey !== targetKey || stale) {
      state = {
        targetKey,
        entity: verification.entity,
        entityId: verification.entityId,
        startedAt: now,
        shots: 0,
      };
    }
    state.shots += 1;
    state.lastOutcome = verification.outcome;
    state.lastDistance = verification.currentDistance;
    state.lastAt = now;
    this._combatRangedFireFollowUp = state;
    return {
      entity: state.entity,
      ...(state.entityId != null ? { entityId: state.entityId } : {}),
      outcome: state.lastOutcome,
      followUpShots: state.shots,
      maxFollowUpShots: this._rangedMaxFollowUpShots(),
      followUpWindowMs: windowMs,
      lastDistance: state.lastDistance,
    };
  }

  _tick() {
    if (this.shuttingDown) return;
    const bot = this.bot;
    const now = Date.now();
    const cheapDue = now - this.lastTick >= 50;
    if (!cheapDue) return;
    this.lastTick = now;
    this._recordRecentDamage(now);

    // 1) Critical-health emergency logout
    if (bot.health > 0 && bot.health <= this.cfg.criticalHealthLogoutThreshold) {
      this._transition(STATE.EMERGENCY, 'critical-health-logout', { health: bot.health });
      this.log.fatal('emergency.logout', { health: bot.health });
      // Take the token so any in-flight skill is preempted cleanly before quit.
      this._ensureToken('EMERGENCY');
      this._suppressAutoEat('emergency');
      try {
        if (typeof bot.quit !== 'function') throw new Error('bot.quit unavailable');
        bot.quit('emergency:critical-health');
      } catch (err) {
        this.log.error('emergency.logout-error', { health: bot.health, err: errorMessage(err) });
      }
      this.shuttingDown = true;
      return;
    }

    // 2) Water / drowning escape. Mineflayer exposes oxygenLevel via entity
    // metadata and entity.isInWater through physics; use those direct signals
    // instead of health-delta guessing.
    const water = scanWaterHazard(bot, { holdInWater: this.state === STATE.WATER_ESCAPE })
      || this._scanShallowWaterStall(now);
    if (water) {
      this._waterEscapeClearSince = 0;
      if (this.state !== STATE.WATER_ESCAPE) {
        this._transition(STATE.WATER_ESCAPE, 'water-escape', {
          submerged: water.submerged,
          oxygenLevel: water.oxygenLevel,
          sinking: water.sinking,
          ...(water.holdReason ? { holdReason: water.holdReason } : {}),
        });
      }
      this._applyWaterEscape(water, now);
      return;
    } else if (this.state === STATE.WATER_ESCAPE) {
      const clear = waterEscapeClearStatus(bot, this._waterEscapeClearSince, now);
      this._waterEscapeClearSince = clear.clearSince;
      if (!clear.ready) {
        if (clear.reason === 'waiting-for-stable-dry-ground') {
          this._clearWaterEscapeControls();
          if (now - this.lastWaterLogAt > 1000) {
            this.log.info('water_escape.clear-hold', {
              reason: clear.reason,
              stableForMs: clear.stableForMs,
              ...readPathfinderContext(bot),
            });
            this.lastWaterLogAt = now;
          }
        } else {
          this._applyWaterEscape({
            kind: 'water_escape',
            inWater: bot.entity?.isInWater === true,
            submerged: false,
            oxygenLevel: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null,
            oxygenLow: false,
            sinking: false,
            holdingInWater: true,
            holdReason: clear.reason,
            velocityY: bot.entity?.velocity?.y,
            at: bot.entity?.position,
          }, now);
        }
        return;
      }
      this._waterEscapeClearSince = 0;
      this._transition(STATE.NORMAL, 'water-cleared');
      return;
    }

    const immediateHazard = scanImmediateHazard(bot, { holdFalling: this.state === STATE.HAZARD });
    if (immediateHazard) {
      this._handleHazardAbort(immediateHazard, now);
      return;
    }

    // 3) Hostile in range — flee or engage. Enter/exit hysteresis: enter at
    // hostileScanRadius; while FLEEING, exit only after the locked-on threat
    // is OUTSIDE hostileExitRadius continuously for hostileExitDebounceMs.
    this.hostileScanCounter = (this.hostileScanCounter + 1) % 5;
    if (this.hostileScanCounter === 0) {
      const enterRadius = this.cfg.hostileScanRadius;
      const exitRadius = this.cfg.hostileExitRadius ?? (enterRadius + 6);
      const exitDebounceMs = this.cfg.hostileExitDebounceMs ?? 500;

      const fleeDecision = evaluateFleeThreat({
        bot,
        state: this.state,
        fleeingFrom: this.fleeingFrom,
        enterRadius,
        exitRadius,
        exitDebounceMs,
        exitClearSince: this._exitClearSince,
        now,
        includePlayers: this.cfg.playerThreatScanEnabled === true,
      });
      this._exitClearSince = fleeDecision.exitClearSince;
      if (fleeDecision.clearFleeing) {
        this.fleeingFrom = null;
        this._stopPvp('threat-cleared');
        this._transition(STATE.NORMAL, 'threat-cleared');
        return;
      }
      const threat = fleeDecision.threat;

      if (threat) {
        const offHandItem = readOffHandItem(bot, this.log);
        const inventoryItems = readCombatInventoryItems(bot, this.log);
        const activeEffects = readActiveEffectList(bot, this.log);
        const combat = chooseCombatResponse({
          threat,
          health: bot.health,
          heldItem: bot.heldItem,
          offHandItem,
          inventoryItems,
          armorItems: readEquippedArmorItems(bot, this.log),
          engageOverFlee: this.cfg.engageOverFlee,
          lowHealthFleeThreshold: this.cfg.lowHealthFleeThreshold,
          minArmorScoreToEngage: this.cfg.minArmorScoreToEngage,
          maxMeleeEngageThreatCount: this.cfg.maxMeleeEngageThreatCount,
          minMeleeSurvivalSecondsToEngage: this.cfg.minMeleeSurvivalSecondsToEngage,
          minMeleeKillMarginSecondsToEngage: this.cfg.minMeleeKillMarginSecondsToEngage,
          activeEffects,
          recentDamage: this.recentDamagePressure(now),
          requireShieldToEngage: this.cfg.requireShieldToEngage,
          rangedCombatPrepEnabled: this.cfg.rangedCombatPrepEnabled,
          rangedCombatFireEnabled: this.cfg.rangedCombatFireEnabled,
          rangedCombatLineOfSight: this.cfg.rangedCombatFireEnabled === true
            ? (entry) => readRangedLineOfSight(bot, entry, this.log)
            : null,
          rangedCombatFireMinDistance: this.cfg.rangedCombatFireMinDistance,
          rangedCombatFireMaxDistance: this.cfg.rangedCombatFireMaxDistance,
        });
        if (this._reactiveConsumePromise) {
          this._holdFleeDuringReactiveConsume(threat);
          return;
        }
        const consumable = this._chooseReactiveConsumable(threat, inventoryItems, activeEffects, combat.meleeRisk);
        if (consumable.action !== 'none' && this._startReactiveConsume(consumable, threat)) {
          this._holdFleeDuringReactiveConsume(threat);
          return;
        }
        this._applyShieldBlockDecision(chooseShieldBlockResponse({
          threat,
          combatAction: combat.action,
          offHandItem,
          shieldActive: this._shieldBlockActive,
          enabled: this.cfg.shieldBlockingEnabled,
          blockDistance: this.cfg.shieldBlockDistance,
          releaseDistance: this.cfg.shieldReleaseDistance,
        }), threat);
        const holdingFleeBuffer = this.state === STATE.FLEEING && threat.distance > enterRadius;
        if (combat.action === 'engage' && !holdingFleeBuffer) {
          if (this.state !== STATE.ENGAGING || this.engaging?.id !== threat.entity.id) {
            const wasFleeing = this.state === STATE.FLEEING;
            this._transition(STATE.ENGAGING, 'hostile-engage', {
              entity: threat.entity.name,
              dist: Math.round(threat.distance * 10) / 10,
              ...combatPolicyLogFields(combat),
            });
            this.engaging = threat.entity;
            this.fleeingFrom = null;
            const token = this._ensureToken('ENGAGING');
            if (wasFleeing) this._stopOwnedPath(token, 'engage');
            try {
              if (bot.humanizer?.startPvpAttack) {
                bot.humanizer.startPvpAttack(bot, threat.entity, {
                  reason: 'hostile-engage',
                  critical: true,
                });
              } else {
                bot.pvp.attack(threat.entity);
              }
            } catch (err) { this.log.warn('engage.error', { err: err.message }); }
          }
          return;
        }
        if (combat.action === 'equip_weapon') {
          this._equipCombatWeapon(combat.item, threat, combat.reason);
        }
        if (combat.action === 'equip_ranged_weapon') {
          this._equipCombatRangedWeapon(combat.item, combat.targetThreat || threat, combat.reason);
        }
        if (combat.action === 'fire_ranged_weapon') {
          this._fireCombatRangedWeapon(combat.targetThreat || threat, combat.reason);
        }
        if (combat.action === 'equip_shield') {
          this._equipCombatShield(combat.item, threat, combat.reason);
        }
        if (this.state !== STATE.FLEEING || !this.fleeingFrom || this.fleeingFrom.id !== threat.entity.id) {
          if (this.state === STATE.ENGAGING) {
            this.engaging = null;
            this._stopPvp('engage-flee');
          }
          this._transition(STATE.FLEEING, 'hostile-flee', {
            entity: threat.entity.name,
            dist: Math.round(threat.distance * 10) / 10,
            ...combatPolicyLogFields(combat),
          });
          this.fleeingFrom = threat.entity;
          this._exitClearSince = 0;
          this._setFleeGoal(threat);
        } else if (this._shouldRepathCloseFlee(threat, now)) {
          this._lastCloseFleeRepathAt = now;
          this.log.warn('flee.close-repath', {
            entity: threat.entity.name,
            entityId: threat.entity.id,
            distance: threat.distance,
            threshold: this.cfg.fleeCloseRepathDistance ?? 3,
            replanMs: this.cfg.fleeCloseRepathMs ?? 500,
            ...readPathfinderContext(this.bot),
          });
          this._setFleeGoal(threat);
        } else {
          // Same entity, still fleeing. The FleeGoal handles its own re-plans
          // via hasChanged; we emit a rich tracking record so a stuck flee
          // is visible from the log alone (the boundary-yo-yo bug we just
          // fixed showed up here as distance plateauing at ~exit radius).
          this.log.info('flee.tracking', buildFleeTrackingRecord(this.bot, threat));
        }
        return;
      } else if (this.state === STATE.ENGAGING) {
        // Engagement target cleared (no hysteresis on engage for now).
        const remainingThreat = nearestHostile(bot, exitRadius);
        this.engaging = null;
        const stopReason = remainingThreat ? 'engage-cleared-threats-remain' : 'engage-cleared';
        this._stopPvp(stopReason);
        if (remainingThreat) {
          this._transition(STATE.FLEEING, stopReason, {
            entity: remainingThreat.entity.name,
            dist: Math.round(remainingThreat.distance * 10) / 10,
            exitRadius,
            threatCount: remainingThreat.threats?.length ?? 1,
          });
          this.fleeingFrom = remainingThreat.entity;
          this._exitClearSince = 0;
          this._setFleeGoal(remainingThreat);
          return;
        }
        this._transition(STATE.NORMAL, 'engage-cleared');
      }
    }

    // 4) Hazard abort
    const hz = scanHazard(bot);
    if (hz) {
      this._handleHazardAbort(hz, now);
      return;
    } else if (this.state === STATE.HAZARD) {
      this._transition(STATE.NORMAL, 'hazard-cleared');
    }
  }

  _handleHazardAbort(hz, now) {
    if (now - this.lastHazardLogAt > 1000) {
      this.log.warn('hazard.detected', buildHazardLogRecord(this.bot, hz));
      this.lastHazardLogAt = now;
    }
    const enteredHazard = this.state !== STATE.HAZARD;
    if (enteredHazard) {
      this._transition(STATE.HAZARD, 'hazard-detected', { kind: hz.kind, trigger: hz.trigger });
    }
    this._applyHazardAbort({ stopPathing: enteredHazard });
    this._startHazardWaterBucket(hz, now, {
      logSkip: enteredHazard || now - this._lastHazardWaterBucketLogAt > 1000,
    });
  }

  _setFleeGoal(threat) {
    // Custom FleeGoal: isEnd() === false unconditionally, so the pathfinder
    // never thinks the bot is "done fleeing" while the goal is set. A*
    // returns partial paths, the bot walks them, and pathfinder re-plans
    // whenever the path runs out OR FleeGoal.hasChanged() fires (entity
    // moved more than ~4 blocks from cached pos). The reactive controller
    // is solely responsible for taking the goal down (on threat-cleared
    // after exit hysteresis).
    const hasChangedThresholdBlocks = this.cfg.fleeReplanThresholdBlocks ?? 4;
    const threatEntities = (threat.threats || [threat]).map((entry) => entry.entity);
    const initialDistance = this.bot.entity.position.distanceTo(threat.entity.position);
    this.log.info('flee.goal', {
      entity: threat.entity.name,
      entityId: threat.entity.id,
      threatCount: threatEntities.length,
      hasChangedThresholdBlocks,
      initialDistance,
    });
    if (!this._fleeMovements) {
      this.log.error('flee.movements-unavailable', {
        entity: threat.entity.name,
        entityId: threat.entity.id,
        ...readPathfinderContext(this.bot),
      });
      return;
    }
    const t_ = this._ensureToken('FLEEING');
    if (!t_) {
      this.log.error('flee.no-token', { msg: 'reactive could not acquire pathfinder token' });
      return;
    }
    const goal = new FleeGoal(threatEntities, { hasChangedThresholdBlocks });
    let installed = false;
    try {
      installed = this.bot.pathfinderOwner.setGoal(t_.token, goal, { movements: this._fleeMovements, dynamic: true });
    } catch (err) {
      this.log.error('flee.goal-failed', {
        entity: threat.entity.name,
        entityId: threat.entity.id,
        err: errorMessage(err),
        ...readPathfinderContext(this.bot),
      });
      return;
    }
    if (!installed) {
      this.log.error('flee.goal-failed', {
        entity: threat.entity.name,
        entityId: threat.entity.id,
        ...readPathfinderContext(this.bot),
      });
    }
  }

  _shouldRepathCloseFlee(threat, now) {
    const distance = Number(threat?.distance);
    const threshold = Number.isFinite(this.cfg.fleeCloseRepathDistance)
      ? Math.max(0, this.cfg.fleeCloseRepathDistance)
      : 3;
    if (!Number.isFinite(distance) || distance > threshold) return false;

    let pathfinderIdle = false;
    try {
      pathfinderIdle = this.bot.pathfinderOwner?.isIdle?.() === true;
    } catch {}
    if (pathfinderIdle) return true;

    const replanMs = Number.isFinite(this.cfg.fleeCloseRepathMs)
      ? Math.max(100, this.cfg.fleeCloseRepathMs)
      : 500;
    return now - this._lastCloseFleeRepathAt >= replanMs;
  }

  _startHazardWaterBucket(hz, now, { logSkip = false } = {}) {
    if (this._hazardWaterBucketPromise) return false;
    const enabled = this.cfg.waterBucketHazardResponseEnabled === true;
    if (!enabled) return false;
    const cooldownMs = this.cfg.waterBucketHazardCooldownMs ?? 3000;
    const decision = chooseWaterBucketHazardResponse(this.bot, hz, {
      enabled,
      cooldownMs,
      now,
      lastAttemptAt: this._lastHazardWaterBucketAt,
    });

    if (decision.action !== 'place_water') {
      if (logSkip && WATER_BUCKET_HAZARDS.has(hz?.kind)) {
        this._lastHazardWaterBucketLogAt = now;
        this.log.warn('hazard.water-bucket-skip', {
          kind: hz.kind,
          at: positionRecord(hz.at),
          reason: decision.reason,
          ...(decision.dimension ? { dimension: decision.dimension } : {}),
          ...(decision.error ? { err: decision.error } : {}),
          ...(decision.block ? { block: decision.block } : {}),
          ...(decision.remainingMs != null ? { remainingMs: decision.remainingMs } : {}),
        });
      }
      return false;
    }

    const controller = new AbortController();
    const fields = {
      kind: decision.hazard,
      hazardAt: positionRecord(decision.hazardAt),
      target: positionRecord(decision.target),
      item: decision.item?.name,
      slot: itemSlot(decision.item),
      referenceBlock: decision.referenceBlock?.name,
      referenceAt: positionRecord(decision.referenceBlock?.position),
      faceVector: decision.faceVector,
      placementReason: decision.placementReason,
    };
    const equipTimeoutMs = config.executor?.equipOperationTimeoutMs ?? 10000;
    const placeTimeoutMs = config.executor?.placeBlockOperationTimeoutMs ?? 10000;
    let promise;
    try {
      this._lastHazardWaterBucketAt = now;
      this._hazardWaterBucketAbortController = controller;
      this.log.info('hazard.water-bucket-start', fields);
      promise = (async () => {
        await runBoundedOperation(
          () => this._equipWithHumanizer(decision.item, 'hand', {
            reason: 'hazard.water-bucket.equip',
            critical: true,
            signal: controller.signal,
          }),
          {
            timeoutMs: equipTimeoutMs,
            timeoutCode: 'HAZARD_WATER_BUCKET_EQUIP_TIMEOUT',
            timeoutMessage: `hazard water bucket equip timed out after ${equipTimeoutMs}ms`,
            signal: controller.signal,
            abortCode: 'HAZARD_WATER_BUCKET_ABORTED',
            abortMessage: 'hazard water bucket aborted',
          },
        );
        const placementResult = await runBoundedOperation(
          () => placeWaterBucketWithVerification(this.bot, decision, {
            signal: controller.signal,
          }),
          {
            timeoutMs: placeTimeoutMs,
            timeoutCode: 'HAZARD_WATER_BUCKET_PLACE_TIMEOUT',
            timeoutMessage: `hazard water bucket place timed out after ${placeTimeoutMs}ms`,
            signal: controller.signal,
            abortCode: 'HAZARD_WATER_BUCKET_ABORTED',
            abortMessage: 'hazard water bucket aborted',
          },
        );
        fields.method = placementResult?.method || null;
        if (placementResult?.fallbackFrom) fields.fallbackFrom = placementResult.fallbackFrom;
        this._lastHazardWaterPlacement = {
          target: decision.target,
          hazard: decision.hazard,
          hazardAt: decision.hazardAt,
          placedAt: Date.now(),
        };
      })();
      this._hazardWaterBucketPromise = promise;
    } catch (err) {
      this._hazardWaterBucketAbortController = null;
      this.log.warn('hazard.water-bucket-error', { ...fields, err: errorMessage(err) });
      return false;
    }

    promise.then(
      () => this.log.info('hazard.water-bucket-done', fields),
      (err) => {
        const event = err?.code === 'HAZARD_WATER_BUCKET_ABORTED'
          ? 'hazard.water-bucket-preempted'
          : 'hazard.water-bucket-error';
        this.log.warn(event, { ...fields, err: errorMessage(err) });
      },
    ).finally(() => {
      if (this._hazardWaterBucketPromise === promise) this._hazardWaterBucketPromise = null;
      if (this._hazardWaterBucketAbortController === controller) this._hazardWaterBucketAbortController = null;
    });
    return true;
  }

  _startHazardWaterBucketPickup(reason) {
    if (this._hazardWaterPickupPromise) return false;
    const placement = this._lastHazardWaterPlacement;
    if (!placement) return false;
    this._lastHazardWaterPlacement = null;

    const decision = chooseWaterBucketPickupResponse(this.bot, placement, {
      enabled: this.cfg.waterBucketPickupEnabled !== false,
      maxDistance: this.cfg.waterBucketPickupMaxDistance,
    });

    if (decision.action !== 'pickup_water') {
      this.log.warn('hazard.water-bucket-pickup-skip', {
        reason: decision.reason,
        trigger: reason,
        target: positionRecord(placement.target),
        hazard: placement.hazard,
        hazardAt: positionRecord(placement.hazardAt),
        ...(decision.currentDistance != null ? { currentDistance: decision.currentDistance } : {}),
        ...(decision.maxDistance != null ? { maxDistance: decision.maxDistance } : {}),
        ...(decision.dimension ? { dimension: decision.dimension } : {}),
        ...(decision.error ? { err: decision.error } : {}),
        ...(decision.block ? { block: decision.block } : {}),
      });
      return false;
    }

    const controller = new AbortController();
    const equipTimeoutMs = config.executor?.equipOperationTimeoutMs ?? 10000;
    const pickupTimeoutMs = config.executor?.placeBlockOperationTimeoutMs ?? 10000;
    const fields = {
      trigger: reason,
      target: positionRecord(decision.target),
      block: decision.targetBlock?.name ?? null,
      item: decision.item?.name,
      slot: itemSlot(decision.item),
      hazard: decision.hazard,
      hazardAt: positionRecord(decision.hazardAt),
    };
    let promise;
    try {
      this._hazardWaterPickupAbortController = controller;
      this.log.info('hazard.water-bucket-pickup-start', fields);
      promise = (async () => {
        await runBoundedOperation(
          () => this._equipWithHumanizer(decision.item, 'hand', {
            reason: 'hazard.water-bucket-pickup.equip',
            critical: true,
            signal: controller.signal,
          }),
          {
            timeoutMs: equipTimeoutMs,
            timeoutCode: 'HAZARD_WATER_BUCKET_PICKUP_EQUIP_TIMEOUT',
            timeoutMessage: `hazard water bucket pickup equip timed out after ${equipTimeoutMs}ms`,
            signal: controller.signal,
            abortCode: 'HAZARD_WATER_BUCKET_PICKUP_ABORTED',
            abortMessage: 'hazard water bucket pickup aborted',
          },
        );
        const pickupResult = await runBoundedOperation(
          () => pickupWaterBucketWithVerification(this.bot, decision, {
            signal: controller.signal,
          }),
          {
            timeoutMs: pickupTimeoutMs,
            timeoutCode: 'HAZARD_WATER_BUCKET_PICKUP_TIMEOUT',
            timeoutMessage: `hazard water bucket pickup timed out after ${pickupTimeoutMs}ms`,
            signal: controller.signal,
            abortCode: 'HAZARD_WATER_BUCKET_PICKUP_ABORTED',
            abortMessage: 'hazard water bucket pickup aborted',
          },
        );
        fields.method = pickupResult?.method || null;
        if (pickupResult?.fallbackFrom) fields.fallbackFrom = pickupResult.fallbackFrom;
      })();
      this._hazardWaterPickupPromise = promise;
    } catch (err) {
      this._hazardWaterPickupAbortController = null;
      this.log.warn('hazard.water-bucket-pickup-error', { ...fields, err: errorMessage(err) });
      return false;
    }

    promise.then(
      () => this.log.info('hazard.water-bucket-pickup-done', fields),
      (err) => {
        const event = err?.code === 'HAZARD_WATER_BUCKET_PICKUP_ABORTED'
          ? 'hazard.water-bucket-pickup-preempted'
          : 'hazard.water-bucket-pickup-error';
        this.log.warn(event, { ...fields, err: errorMessage(err) });
      },
    ).finally(() => {
      if (this._hazardWaterPickupPromise === promise) this._hazardWaterPickupPromise = null;
      if (this._hazardWaterPickupAbortController === controller) this._hazardWaterPickupAbortController = null;
    });
    return true;
  }

  _abortHazardWaterPickup(reason) {
    const controller = this._hazardWaterPickupAbortController;
    if (!controller || controller.signal?.aborted) return false;
    try {
      controller.abort(reason);
      this.log.warn('hazard.water-bucket-pickup-abort', { reason });
      return true;
    } catch (err) {
      this.log.warn('hazard.water-bucket-pickup-abort-error', { reason, err: errorMessage(err) });
      return false;
    }
  }

  _abortHazardWaterBucket(reason) {
    const controller = this._hazardWaterBucketAbortController;
    if (!controller || controller.signal?.aborted) return false;
    try {
      controller.abort(reason);
      this.log.warn('hazard.water-bucket-abort', { reason });
      return true;
    } catch (err) {
      this.log.warn('hazard.water-bucket-abort-error', { reason, err: errorMessage(err) });
      return false;
    }
  }

  _applyHazardAbort({ stopPathing = false } = {}) {
    const t = this._ensureToken('HAZARD');
    if (stopPathing) this._stopOwnedPath(t, 'hazard');
    this._suppressAutoEat('hazard', { cancelHeldItem: !this._hazardWaterBucketPromise });
  }

  _activeWaterEscapeAvoidTargets(now) {
    if (!Array.isArray(this._waterEscapeAvoidTargets) || this._waterEscapeAvoidTargets.length === 0) return [];
    this._waterEscapeAvoidTargets = this._waterEscapeAvoidTargets.filter((entry) => entry.expiresAt > now);
    return this._waterEscapeAvoidTargets.map((entry) => entry.position);
  }

  _rememberStalledWaterEscapeTarget(target, now, reason) {
    if (!target) return;
    const key = blockPositionKey(target);
    this._waterEscapeAvoidTargets = this._waterEscapeAvoidTargets.filter((entry) => blockPositionKey(entry.position) !== key);
    this._lastWaterEscapeStalledTarget = clonePosition(target);
    this._waterEscapeAvoidTargets.push({
      position: clonePosition(target),
      reason,
      expiresAt: now + WATER_ESCAPE_STALLED_TARGET_TTL_MS,
    });
  }

  _waterEscapeFallbackSwimTarget() {
    const pos = this.bot.entity?.position;
    const stalled = this._lastWaterEscapeStalledTarget;
    if (!pos) return null;
    let dx = stalled ? (pos.x ?? 0) - ((stalled.x ?? 0) + 0.5) : 0;
    let dz = stalled ? (pos.z ?? 0) - ((stalled.z ?? 0) + 0.5) : 0;
    const len = Math.hypot(dx, dz);
    if (!stalled || !Number.isFinite(len) || len < 0.05) {
      const yaw = this.bot.entity?.yaw;
      if (!Number.isFinite(yaw)) return null;
      dx = -Math.sin(yaw);
      dz = -Math.cos(yaw);
    } else {
      dx /= len;
      dz /= len;
    }
    return offsetPosition(pos, dx * WATER_ESCAPE_FALLBACK_SWIM_DISTANCE, 0, dz * WATER_ESCAPE_FALLBACK_SWIM_DISTANCE);
  }

  _waterEscapeTargetStalled(target, now, water = null) {
    const pos = this.bot.entity?.position;
    if (!target || !pos) {
      this._waterEscapeProgress = null;
      return { stalled: false };
    }

    const key = blockPositionKey(target);
    const distSq = positionDistanceSq(pos, target);
    const horizontalDistSq = horizontalDistanceSq(pos, target);
    const closeInWater = water?.inWater === true && horizontalDistSq <= WATER_ESCAPE_EDGE_TRAP_DISTANCE_SQ;
    if (!this._waterEscapeProgress || this._waterEscapeProgress.key !== key) {
      this._waterEscapeProgress = {
        key,
        startedAt: now,
        bestDistSq: distSq,
        bestHorizontalDistSq: horizontalDistSq,
        lastDistSq: distSq,
        lastHorizontalDistSq: horizontalDistSq,
        lastPos: clonePosition(pos),
        lastHorizontalPos: clonePosition(pos),
        lastImprovedAt: now,
        lastHorizontalImprovedAt: now,
        lastMovedAt: now,
        lastHorizontalMovedAt: now,
        closeInWaterSince: closeInWater ? now : 0,
      };
      return { stalled: false };
    }

    const progress = this._waterEscapeProgress;
    if (distSq < progress.bestDistSq - WATER_ESCAPE_PROGRESS_DELTA_SQ) {
      progress.bestDistSq = distSq;
      progress.lastImprovedAt = now;
    }
    if (positionDistanceSq(pos, progress.lastPos) > WATER_ESCAPE_MOVE_DELTA_SQ) {
      progress.lastMovedAt = now;
    }
    if (horizontalDistSq < progress.bestHorizontalDistSq - WATER_ESCAPE_PROGRESS_DELTA_SQ) {
      progress.bestHorizontalDistSq = horizontalDistSq;
      progress.lastHorizontalImprovedAt = now;
    }
    if (horizontalDistanceSq(pos, progress.lastHorizontalPos) > WATER_ESCAPE_MOVE_DELTA_SQ) {
      progress.lastHorizontalMovedAt = now;
    }
    if (closeInWater) {
      progress.closeInWaterSince = progress.closeInWaterSince || now;
    } else {
      progress.closeInWaterSince = 0;
    }
    progress.lastDistSq = distSq;
    progress.lastHorizontalDistSq = horizontalDistSq;
    progress.lastPos = clonePosition(pos);
    progress.lastHorizontalPos = clonePosition(pos);

    const noProgressForMs = now - progress.lastImprovedAt;
    const unmovedForMs = now - progress.lastMovedAt;
    const noHorizontalProgressForMs = now - progress.lastHorizontalImprovedAt;
    const horizontalUnmovedForMs = now - progress.lastHorizontalMovedAt;
    const stalled3d = noProgressForMs >= WATER_ESCAPE_STALL_RELOCK_MS && unmovedForMs >= WATER_ESCAPE_STALL_RELOCK_MS;
    const horizontalRelevant = progress.bestHorizontalDistSq > WATER_ESCAPE_PROGRESS_DELTA_SQ
      || horizontalDistSq > WATER_ESCAPE_PROGRESS_DELTA_SQ;
    const stalledHorizontal = horizontalRelevant
      && noHorizontalProgressForMs >= WATER_ESCAPE_STALL_RELOCK_MS
      && horizontalUnmovedForMs >= WATER_ESCAPE_STALL_RELOCK_MS;
    const closeInWaterForMs = closeInWater && progress.closeInWaterSince
      ? now - progress.closeInWaterSince
      : 0;
    const edgeTrap = closeInWaterForMs >= WATER_ESCAPE_STALL_RELOCK_MS;
    const stalled = stalled3d || stalledHorizontal || edgeTrap;
    return {
      stalled,
      edgeTrap,
      closeInWater,
      closeInWaterForMs,
      noProgressForMs,
      unmovedForMs,
      distSq,
      bestDistSq: progress.bestDistSq,
      noHorizontalProgressForMs,
      horizontalUnmovedForMs,
      horizontalDistSq,
      bestHorizontalDistSq: progress.bestHorizontalDistSq,
    };
  }

  _scanShallowWaterStall(now) {
    const pos = this.bot.entity?.position;
    if (!pos) {
      this._shallowWaterStall = null;
      return null;
    }

    const feetRead = readBlockAt(this.bot, pos.offset(0, 0, 0));
    const headRead = readBlockAt(this.bot, pos.offset(0, 1, 0));
    const eyesRead = readBlockAt(this.bot, pos.offset(0, 1.62, 0));
    if (feetRead.error || headRead.error || eyesRead.error) {
      this._shallowWaterStall = null;
      return null;
    }

    const directInWater = this.bot.entity?.isInWater === true
      || hasWater(feetRead.block)
      || hasWater(headRead.block)
      || hasWater(eyesRead.block);
    const surfaceContact = directInWater ? { contact: false, readFailed: false } : scanSurfaceWaterContact(this.bot, pos);
    if (surfaceContact.readFailed) {
      this._shallowWaterStall = null;
      return null;
    }
    const inWater = directInWater || surfaceContact.contact;
    if (!inWater) {
      this._shallowWaterStall = null;
      return null;
    }

    const nowPos = clonePosition(pos);
    if (!this._shallowWaterStall) {
      this._shallowWaterStall = {
        startedAt: now,
        lastMovedAt: now,
        lastHorizontalMovedAt: now,
        lastPos: nowPos,
        lastHorizontalPos: nowPos,
      };
      return null;
    }

    if (horizontalDistanceSq(nowPos, this._shallowWaterStall.lastHorizontalPos || this._shallowWaterStall.lastPos) > SHALLOW_WATER_STALL_MOVE_DELTA_SQ) {
      this._shallowWaterStall.lastHorizontalMovedAt = now;
      this._shallowWaterStall.lastHorizontalPos = nowPos;
      this._shallowWaterStall.lastMovedAt = now;
      this._shallowWaterStall.lastPos = nowPos;
      return null;
    }

    this._shallowWaterStall.lastPos = nowPos;

    const stillForMs = now - (this._shallowWaterStall.lastHorizontalMovedAt || this._shallowWaterStall.lastMovedAt);
    if (stillForMs < SHALLOW_WATER_STALL_ESCAPE_MS) return null;

    return {
      kind: 'water_escape',
      inWater: true,
      submerged: hasWater(headRead.block) || hasWater(eyesRead.block),
      oxygenLevel: typeof this.bot.oxygenLevel === 'number' ? this.bot.oxygenLevel : null,
      oxygenLow: false,
      sinking: false,
      holdingInWater: true,
      holdReason: surfaceContact.contact ? 'surface-water-stall' : 'shallow-water-stall',
      ...(surfaceContact.contact ? { surfaceWaterContact: true } : {}),
      velocityY: this.bot.entity?.velocity?.y,
      at: pos,
      stillForMs,
      horizontalStillForMs: stillForMs,
    };
  }

  _applyWaterEscape(water, now) {
    const t = this._ensureToken('WATER_ESCAPE');
    this._stopOwnedPath(t, 'water_escape');

    this._suppressAutoEat('water_escape');

    const threats = hostileThreatSet(this.bot, this.cfg.hostileExitRadius ?? this.cfg.hostileScanRadius ?? 16)
      .map((entry) => entry.entity);
    let target = this._waterEscapeTarget;
    if (now - this._waterEscapeTargetAt > WATER_ESCAPE_TARGET_RELOCK_MS || !waterEscapeTargetStillUsable(this.bot, target)) {
      target = findNearestDryLand(this.bot, WATER_LAND_SEARCH_RADIUS, {
        avoidThreats: threats,
        avoidTargets: this._activeWaterEscapeAvoidTargets(now),
        maxRiseFromCurrentY: WATER_EXIT_MAX_RISE_FROM_CURRENT_Y,
      });
      this._waterEscapeTarget = target;
      this._waterEscapeTargetAt = now;
    }
    const stall = this._waterEscapeTargetStalled(target, now, water);
    if (stall.stalled) {
      this.log.warn('water_escape.target-stalled', {
        target: target ? { x: target.x, y: target.y, z: target.z } : null,
        edgeTrap: stall.edgeTrap,
        closeInWater: stall.closeInWater,
        closeInWaterForMs: stall.closeInWaterForMs,
        noProgressForMs: stall.noProgressForMs,
        unmovedForMs: stall.unmovedForMs,
        distSq: stall.distSq,
        bestDistSq: stall.bestDistSq,
        noHorizontalProgressForMs: stall.noHorizontalProgressForMs,
        horizontalUnmovedForMs: stall.horizontalUnmovedForMs,
        horizontalDistSq: stall.horizontalDistSq,
        bestHorizontalDistSq: stall.bestHorizontalDistSq,
        ...readPathfinderContext(this.bot),
      });
      this._rememberStalledWaterEscapeTarget(target, now, 'stalled');
      this._waterEscapeProgress = null;
      target = findNearestDryLand(this.bot, WATER_LAND_SEARCH_RADIUS, {
        avoidThreats: threats,
        avoidTargets: this._activeWaterEscapeAvoidTargets(now),
        maxRiseFromCurrentY: WATER_EXIT_MAX_RISE_FROM_CURRENT_Y,
      });
      this._waterEscapeTarget = target;
      this._waterEscapeTargetAt = now;
      this._waterEscapeTargetStalled(target, now, water);
    }
    let controlTarget = target;
    if (!controlTarget && water?.inWater === true) {
      controlTarget = this._waterEscapeFallbackSwimTarget();
      if (controlTarget && now - (this.lastWaterFallbackLogAt || 0) > 1000) {
        this.log.warn('water_escape.fallback-swim', {
          target: { x: controlTarget.x, y: controlTarget.y, z: controlTarget.z },
          stalledTarget: this._lastWaterEscapeStalledTarget || null,
          ...readPathfinderContext(this.bot),
        });
        this.lastWaterFallbackLogAt = now;
      }
    }
    if (controlTarget) {
      this._lookAt(offsetPosition(controlTarget, 0.5, 1, 0.5), 'water_escape');
      this._setControlState('forward', true, 'water_escape');
    } else {
      this._setControlState('forward', false, 'water_escape');
    }
    this._setControlState('jump', true, 'water_escape');
    this._setControlState('sprint', false, 'water_escape');
    this._setControlState('sneak', false, 'water_escape');

    if (now - this.lastWaterLogAt > 1000) {
      this.log.warn('water_escape.tracking', buildWaterEscapeRecord(this.bot, water, target));
      this.lastWaterLogAt = now;
    }
  }

  _stopOwnedPath(tokenHandle, reason) {
    if (!tokenHandle) return false;
    try {
      return this.bot.pathfinderOwner.stop(tokenHandle.token);
    } catch (err) {
      this.log.error(`${reason}.stop-error`, {
        err: errorMessage(err),
        ...readPathfinderContext(this.bot),
      });
      return false;
    }
  }

  _stopPvp(reason) {
    const stop = this.bot.pvp?.stop;
    if (typeof stop !== 'function') return false;
    try {
      stop.call(this.bot.pvp);
      return true;
    } catch (err) {
      this.log.warn('pvp.stop-error', {
        reason,
        state: this.state,
        err: errorMessage(err),
      });
      return false;
    }
  }

  _equipWithHumanizer(item, destination, {
    reason = 'reactive.equip',
    critical = true,
    signal = null,
  } = {}) {
    if (this.bot.humanizer?.equipItem) {
      return this.bot.humanizer.equipItem(this.bot, item, destination, {
        reason,
        critical,
        signal,
      });
    }
    return this.bot.equip(item, destination);
  }

  _equipCombatWeapon(item, threat, reason) {
    if (!item || this._combatEquipPromise) return false;
    if (typeof this.bot.equip !== 'function') {
      this.log.warn('combat.weapon-equip-unavailable', {
        item: item.name,
        entity: threat?.entity?.name,
        entityId: threat?.entity?.id,
        reason,
      });
      return false;
    }

    let promise;
    const fields = {
      item: item.name,
      slot: Number.isFinite(item.slot) ? item.slot : null,
      entity: threat?.entity?.name,
      entityId: threat?.entity?.id,
      reason,
    };
    try {
      this.log.info('combat.weapon-equip-start', fields);
      promise = runBoundedOperation(
        () => this._equipWithHumanizer(item, 'hand', {
          reason: 'combat.weapon-equip',
          critical: true,
        }),
        {
          timeoutMs: config.executor?.equipOperationTimeoutMs ?? 10000,
          timeoutCode: 'COMBAT_WEAPON_EQUIP_TIMEOUT',
          timeoutMessage: `combat weapon equip timed out after ${config.executor?.equipOperationTimeoutMs ?? 10000}ms`,
        },
      );
      this._combatEquipPromise = promise;
    } catch (err) {
      this.log.warn('combat.weapon-equip-error', { ...fields, err: errorMessage(err) });
      return false;
    }

    promise.then(
      () => this.log.info('combat.weapon-equip-done', fields),
      (err) => this.log.warn('combat.weapon-equip-error', { ...fields, err: errorMessage(err) }),
    ).finally(() => {
      if (this._combatEquipPromise === promise) this._combatEquipPromise = null;
    });
    return true;
  }

  _equipCombatRangedWeapon(item, threat, reason) {
    if (!item || this._combatRangedEquipPromise) return false;
    if (typeof this.bot.equip !== 'function') {
      this.log.warn('combat.ranged-equip-unavailable', {
        item: item.name,
        entity: threat?.entity?.name,
        entityId: threat?.entity?.id,
        reason,
      });
      return false;
    }

    let promise;
    const fields = {
      item: item.name,
      slot: Number.isFinite(item.slot) ? item.slot : null,
      entity: threat?.entity?.name,
      entityId: threat?.entity?.id,
      reason,
    };
    try {
      this.log.info('combat.ranged-equip-start', fields);
      promise = runBoundedOperation(
        () => this._equipWithHumanizer(item, 'hand', {
          reason: 'combat.ranged-equip',
          critical: true,
        }),
        {
          timeoutMs: config.executor?.equipOperationTimeoutMs ?? 10000,
          timeoutCode: 'COMBAT_RANGED_EQUIP_TIMEOUT',
          timeoutMessage: `combat ranged equip timed out after ${config.executor?.equipOperationTimeoutMs ?? 10000}ms`,
        },
      );
      this._combatRangedEquipPromise = promise;
    } catch (err) {
      this.log.warn('combat.ranged-equip-error', { ...fields, err: errorMessage(err) });
      return false;
    }

    promise.then(
      () => this.log.info('combat.ranged-equip-done', fields),
      (err) => this.log.warn('combat.ranged-equip-error', { ...fields, err: errorMessage(err) }),
    ).finally(() => {
      if (this._combatRangedEquipPromise === promise) this._combatRangedEquipPromise = null;
    });
    return true;
  }

  _fireCombatRangedWeapon(threat, reason) {
    if (!threat?.entity || this._combatRangedFirePromise) return false;
    const now = Date.now();
    const cooldownMs = this.cfg.rangedCombatFireCooldownMs ?? 1500;
    if (cooldownMs > 0 && now - this._lastCombatRangedFireAt < cooldownMs) return false;
    if (this.bot.usingHeldItem === true) {
      this.log.warn('combat.ranged-fire-busy', {
        entity: threat.entity.name,
        entityId: threat.entity.id,
        reason,
      });
      return false;
    }
    if (
      typeof this.bot.lookAt !== 'function' ||
      typeof this.bot.activateItem !== 'function' ||
      typeof this.bot.deactivateItem !== 'function'
    ) {
      this.log.warn('combat.ranged-fire-unavailable', {
        entity: threat.entity.name,
        entityId: threat.entity.id,
        reason,
        lookAt: typeof this.bot.lookAt === 'function',
        activateItem: typeof this.bot.activateItem === 'function',
        deactivateItem: typeof this.bot.deactivateItem === 'function',
      });
      return false;
    }

    const target = aimPointForEntity(threat.entity);
    if (!target) {
      this.log.warn('combat.ranged-fire-unavailable', {
        entity: threat.entity.name,
        entityId: threat.entity.id,
        reason,
        missingTarget: true,
      });
      return false;
    }

    const controller = new AbortController();
    const drawMs = Math.max(0, this.cfg.rangedCombatFireShotDrawMs ?? 900);
    const verifyMs = Math.max(0, this.cfg.rangedCombatFireVerifyMs ?? 250);
    const timeoutMs = config.executor?.rangedShotOperationTimeoutMs ?? 5000;
    const fields = {
      item: this.bot.heldItem?.name ?? null,
      entity: threat.entity.name,
      entityId: threat.entity.id,
      distance: Number.isFinite(threat.distance) ? Math.round(threat.distance * 10) / 10 : null,
      target: positionRecord(target),
      drawMs,
      reason,
    };
    const followUp = this._rangedFollowUpDecision(threat, now);
    if (!followUp.ok) {
      this.log.warn('combat.ranged-fire-followup-limit', {
        ...fields,
        cancelReason: followUp.reason,
        followUpShots: followUp.followUpShots,
        maxFollowUpShots: followUp.maxFollowUpShots,
        followUpWindowMs: followUp.followUpWindowMs,
        followUpAgeMs: followUp.followUpAgeMs,
        lastOutcome: followUp.lastOutcome,
        lastDistance: followUp.lastDistance,
      });
      return false;
    }
    let promise;
    try {
      this._lastCombatRangedFireAt = now;
      this._combatRangedFireAbortController = controller;
      this.log.info('combat.ranged-fire-start', fields);
      promise = (async () => {
        let activated = false;
        let verificationInitialHealth;
        await runBoundedOperation(
          () => this.bot.humanizer?.lookAt
            ? this.bot.humanizer.lookAt(this.bot, target, {
              force: true,
              reason: 'combat.ranged-fire',
              signal: controller.signal,
            })
            : this.bot.lookAt(target, true),
          {
            timeoutMs,
            timeoutCode: 'COMBAT_RANGED_LOOK_TIMEOUT',
            timeoutMessage: `combat ranged look timed out after ${timeoutMs}ms`,
            signal: controller.signal,
            abortCode: 'COMBAT_RANGED_FIRE_ABORTED',
            abortMessage: 'combat ranged fire aborted',
          },
        );
        const startSafety = validateRangedFireStart(this.bot, threat, this.cfg, this.log);
        if (!startSafety.ok) {
          return { fired: false, ...startSafety };
        }
        await runBoundedOperation(
          () => this.bot.humanizer?.activateItem
            ? this.bot.humanizer.activateItem(this.bot, {
              reason: 'combat.ranged-fire.activate',
              signal: controller.signal,
            })
            : this.bot.activateItem(),
          {
            timeoutMs,
            timeoutCode: 'COMBAT_RANGED_ACTIVATE_TIMEOUT',
            timeoutMessage: `combat ranged activate timed out after ${timeoutMs}ms`,
            signal: controller.signal,
            abortCode: 'COMBAT_RANGED_FIRE_ABORTED',
            abortMessage: 'combat ranged fire aborted',
          },
        );
        activated = true;
        try {
          const drawSafety = await runBoundedOperation(
            () => waitForRangedDrawSafety(this.bot, threat, drawMs),
            {
              timeoutMs: timeoutMs + drawMs,
              timeoutCode: 'COMBAT_RANGED_DRAW_TIMEOUT',
              timeoutMessage: `combat ranged draw timed out after ${timeoutMs + drawMs}ms`,
              signal: controller.signal,
              abortCode: 'COMBAT_RANGED_FIRE_ABORTED',
              abortMessage: 'combat ranged fire aborted',
            },
          );
          if (drawSafety?.ok === false) return { fired: false, ...drawSafety };
          verificationInitialHealth = readEntityHealth(currentRangedTargetEntity(this.bot, threat));
        } finally {
          if (activated) {
            await runBoundedOperation(
              () => this.bot.humanizer?.deactivateItem
                ? this.bot.humanizer.deactivateItem(this.bot, {
                  reason: 'combat.ranged-fire.release',
                })
                : this.bot.deactivateItem(),
              {
                timeoutMs,
                timeoutCode: 'COMBAT_RANGED_RELEASE_TIMEOUT',
                timeoutMessage: `combat ranged release timed out after ${timeoutMs}ms`,
                signal: null,
              },
            );
          }
        }
        const verification = await runBoundedOperation(
          () => waitForRangedFireVerification(this.bot, threat, verifyMs, this.log, verificationInitialHealth),
          {
            timeoutMs: timeoutMs + verifyMs + RANGED_FIRE_VERIFY_POLL_MS,
            timeoutCode: 'COMBAT_RANGED_VERIFY_TIMEOUT',
            timeoutMessage: `combat ranged verify timed out after ${timeoutMs + verifyMs + RANGED_FIRE_VERIFY_POLL_MS}ms`,
            signal: controller.signal,
            abortCode: 'COMBAT_RANGED_FIRE_ABORTED',
            abortMessage: 'combat ranged fire aborted',
          },
        );
        return { fired: true, verification };
      })();
      this._combatRangedFirePromise = promise;
    } catch (err) {
      this._combatRangedFireAbortController = null;
      this.log.warn('combat.ranged-fire-error', { ...fields, err: errorMessage(err) });
      return false;
    }

    promise.then(
      (result) => {
        if (result?.fired === false) {
          this.log.warn('combat.ranged-fire-cancel', {
            ...fields,
            cancelReason: result.reason,
            currentDistance: result.currentDistance,
            lineOfSight: result.lineOfSight,
            ...(result.closeThreat && { closeThreat: result.closeThreat }),
            ...(result.closeThreatId != null && { closeThreatId: result.closeThreatId }),
            ...(Number.isFinite(result.closeThreatDistance) && { closeThreatDistance: result.closeThreatDistance }),
          });
          return;
        }
        if (result?.verification) {
          const verification = {
            ...fields,
            verifyMs,
            ...result.verification,
          };
          const verificationAt = Date.now();
          this.log.info('combat.ranged-fire-verify', verification);
          const followUpRecord = this._recordRangedFollowUp(verification, verificationAt);
          this._lastCombatRangedFireVerification = {
            ...verification,
            ...(followUpRecord && {
              followUpShots: followUpRecord.followUpShots,
              maxFollowUpShots: followUpRecord.maxFollowUpShots,
              followUpWindowMs: followUpRecord.followUpWindowMs,
            }),
            at: verificationAt,
          };
          if (followUpRecord) this.log.info('combat.ranged-fire-followup', followUpRecord);
        }
        this.log.info('combat.ranged-fire-done', fields);
      },
      (err) => {
        const event = err?.code === 'COMBAT_RANGED_FIRE_ABORTED'
          ? 'combat.ranged-fire-preempted'
          : 'combat.ranged-fire-error';
        this.log.warn(event, { ...fields, err: errorMessage(err) });
      },
    ).finally(() => {
      if (this._combatRangedFirePromise === promise) this._combatRangedFirePromise = null;
      if (this._combatRangedFireAbortController === controller) this._combatRangedFireAbortController = null;
    });
    return true;
  }

  _abortCombatRangedFire(reason) {
    const controller = this._combatRangedFireAbortController;
    if (!controller || controller.signal?.aborted) return false;
    try {
      controller.abort(reason);
      this.log.warn('combat.ranged-fire-abort', { reason });
      return true;
    } catch (err) {
      this.log.warn('combat.ranged-fire-abort-error', { reason, err: errorMessage(err) });
      return false;
    }
  }

  _equipCombatShield(item, threat, reason) {
    if (!item || this._combatShieldEquipPromise) return false;
    if (typeof this.bot.equip !== 'function') {
      this.log.warn('combat.shield-equip-unavailable', {
        item: item.name,
        entity: threat?.entity?.name,
        entityId: threat?.entity?.id,
        reason,
      });
      return false;
    }

    let promise;
    const fields = {
      item: item.name,
      slot: Number.isFinite(item.slot) ? item.slot : null,
      entity: threat?.entity?.name,
      entityId: threat?.entity?.id,
      reason,
    };
    try {
      this.log.info('combat.shield-equip-start', fields);
      promise = runBoundedOperation(
        () => this._equipWithHumanizer(item, 'off-hand', {
          reason: 'combat.shield-equip',
          critical: true,
        }),
        {
          timeoutMs: config.executor?.equipOperationTimeoutMs ?? 10000,
          timeoutCode: 'COMBAT_SHIELD_EQUIP_TIMEOUT',
          timeoutMessage: `combat shield equip timed out after ${config.executor?.equipOperationTimeoutMs ?? 10000}ms`,
        },
      );
      this._combatShieldEquipPromise = promise;
    } catch (err) {
      this.log.warn('combat.shield-equip-error', { ...fields, err: errorMessage(err) });
      return false;
    }

    promise.then(
      () => this.log.info('combat.shield-equip-done', fields),
      (err) => this.log.warn('combat.shield-equip-error', { ...fields, err: errorMessage(err) }),
    ).finally(() => {
      if (this._combatShieldEquipPromise === promise) this._combatShieldEquipPromise = null;
    });
    return true;
  }

  _applyShieldBlockDecision(decision, threat) {
    if (!decision) return false;
    if (decision.action === 'release_shield') {
      return this._releaseShieldBlock(decision.reason);
    }
    if (decision.action !== 'activate_shield' && decision.action !== 'hold_shield') return false;

    const fields = {
      entity: threat?.entity?.name,
      entityId: threat?.entity?.id,
      distance: Number.isFinite(threat?.distance) ? Math.round(threat.distance * 10) / 10 : null,
      reason: decision.reason,
    };

    if (this._shieldBlockActive && this.bot.usingHeldItem === true) {
      this._shieldBlockThreatId = threat?.entity?.id ?? null;
      return true;
    }

    if (this.bot.usingHeldItem === true && !this._shieldBlockActive) {
      this.log.warn('combat.shield-block-busy', fields);
      return false;
    }
    if (typeof this.bot.activateItem !== 'function') {
      this.log.warn('combat.shield-block-unavailable', fields);
      return false;
    }

    try {
      let activation;
      if (this.bot.humanizer?.activateItem) {
        activation = this.bot.humanizer.activateItem(this.bot, {
          reason: 'combat.shield-block',
          critical: true,
          offHand: true,
        });
      } else {
        activation = this.bot.activateItem(true);
      }
      if (activation && typeof activation.catch === 'function') {
        activation.catch((err) => {
          this._shieldBlockActive = false;
          this._shieldBlockThreatId = null;
          this.log.warn('combat.shield-block-error', { ...fields, err: errorMessage(err) });
        });
      }
      this._shieldBlockActive = true;
      this._shieldBlockThreatId = threat?.entity?.id ?? null;
      this.log.info('combat.shield-block-start', fields);
      return true;
    } catch (err) {
      this._shieldBlockActive = false;
      this._shieldBlockThreatId = null;
      this.log.warn('combat.shield-block-error', { ...fields, err: errorMessage(err) });
      return false;
    }
  }

  _releaseShieldBlock(reason) {
    if (!this._shieldBlockActive) return false;
    const fields = {
      reason,
      entityId: this._shieldBlockThreatId,
    };
    try {
      if (typeof this.bot.deactivateItem !== 'function') throw new Error('bot.deactivateItem unavailable');
      let release;
      if (this.bot.humanizer?.deactivateItem) {
        release = this.bot.humanizer.deactivateItem(this.bot, {
          reason: 'combat.shield-block-release',
          critical: true,
        });
      } else {
        release = this.bot.deactivateItem();
      }
      if (release && typeof release.catch === 'function') {
        release.catch((err) => {
          this.log.warn('combat.shield-block-release-error', { ...fields, err: errorMessage(err) });
        });
      }
      this.log.info('combat.shield-block-release', fields);
      this._shieldBlockActive = false;
      this._shieldBlockThreatId = null;
      return true;
    } catch (err) {
      this.log.warn('combat.shield-block-release-error', { ...fields, err: errorMessage(err) });
      this._shieldBlockActive = false;
      this._shieldBlockThreatId = null;
      return false;
    }
  }

  _chooseReactiveConsumable(threat, inventoryItems, activeEffects = readActiveEffectList(this.bot, this.log), combatRisk = null) {
    if (!this.cfg.reactiveConsumablesEnabled) return { action: 'none', reason: 'reactive-consumables-disabled' };
    const cooldownMs = this.cfg.reactiveConsumableCooldownMs ?? 5000;
    if (cooldownMs > 0 && Date.now() - this._lastReactiveConsumeAt < cooldownMs) {
      return { action: 'none', reason: 'reactive-consumable-cooldown' };
    }
    try {
      return chooseConsumableAction({
        health: this.bot.health ?? 20,
        food: this.bot.food ?? 20,
        inventoryItems,
        activeEffects,
        threat,
        combatRisk,
        intent: this.cfg.engageOverFlee === true ? 'hostile_combat' : 'survival',
        allowPotions: this.cfg.reactiveConsumablePotions === true,
        allowGoldenApples: this.cfg.reactiveConsumableGoldenApples !== false,
        allowEnchantedGoldenApples: this.cfg.reactiveConsumableEnchantedGoldenApples === true,
        authorizedPlayerCombat: false,
      });
    } catch (err) {
      this.log.warn('reactive.consume.policy-error', {
        entity: threat?.entity?.name,
        entityId: threat?.entity?.id,
        err: errorMessage(err),
      });
      return { action: 'none', reason: 'reactive-consumable-policy-error' };
    }
  }

  _startReactiveConsume(decision, threat) {
    if (this._reactiveConsumePromise) return false;
    if (decision.action !== 'eat' && decision.action !== 'drink_potion') return false;
    this._releaseShieldBlock('reactive-consume');
    if (this.bot.autoEat?.isEating === true || this.bot.usingHeldItem === true) {
      this.log.warn('reactive.consume-busy', {
        item: decision.item?.name,
        action: decision.action,
        reason: decision.reason,
        entity: threat?.entity?.name,
        entityId: threat?.entity?.id,
      });
      return false;
    }

    const params = reactiveConsumeParams(decision, this.cfg);
    const fields = {
      item: params.item,
      action: decision.action,
      reason: decision.reason,
      entity: threat?.entity?.name,
      entityId: threat?.entity?.id,
      ...(decision.effect ? { effect: decision.effect } : {}),
      ...(Number.isFinite(decision.level) ? { level: decision.level } : {}),
    };
    const controller = new AbortController();
    this._reactiveConsumeAbortController = controller;
    this._lastReactiveConsumeAt = Date.now();
    this.log.info('reactive.consume-start', fields);
    const promise = runConsumeSkill(this.bot, params, {
      signal: controller.signal,
      currentSubtask: `reactive.consume(${params.item})`,
      remainingQueue: [],
      reactiveState: this.state,
    });
    this._reactiveConsumePromise = promise;
    promise.then(
      (result) => {
        if (result?.ok) this.log.info('reactive.consume-done', { ...fields, result: result.reason });
        else if (result?.preempted) this.log.warn('reactive.consume-preempted', { ...fields, result: result.reason });
        else this.log.warn('reactive.consume-failed', { ...fields, result: result?.reason || 'unknown failure' });
      },
      (err) => this.log.warn('reactive.consume-error', { ...fields, err: errorMessage(err) }),
    ).finally(() => {
      if (this._reactiveConsumePromise === promise) this._reactiveConsumePromise = null;
      if (this._reactiveConsumeAbortController === controller) this._reactiveConsumeAbortController = null;
    });
    return true;
  }

  _holdFleeDuringReactiveConsume(threat) {
    if (this.state !== STATE.FLEEING || !this.fleeingFrom || this.fleeingFrom.id !== threat.entity.id) {
      if (this.state === STATE.ENGAGING) {
        this.engaging = null;
        this._stopPvp('reactive-consume');
      }
      this._transition(STATE.FLEEING, 'reactive-consume', {
        entity: threat.entity.name,
        dist: Math.round(threat.distance * 10) / 10,
      });
      this.fleeingFrom = threat.entity;
      this._exitClearSince = 0;
      this._setFleeGoal(threat);
    } else {
      this.log.info('flee.tracking', buildFleeTrackingRecord(this.bot, threat));
    }
  }

  _abortReactiveConsume(reason) {
    if (!this._reactiveConsumeAbortController || this._reactiveConsumeAbortController.signal.aborted) return false;
    try {
      this._reactiveConsumeAbortController.abort(reason);
      this.log.warn('reactive.consume-abort', { reason });
      return true;
    } catch (err) {
      this.log.warn('reactive.consume-abort-error', { reason, err: errorMessage(err) });
      return false;
    }
  }

  _lookAt(target, reason) {
    if (typeof this.bot.lookAt !== 'function') return false;
    try {
      const result = this.bot.humanizer?.lookAt
        ? this.bot.humanizer.lookAt(this.bot, target, {
          force: true,
          reason,
          critical: reason?.startsWith?.('water_escape') === true,
        })
        : this.bot.lookAt(target, true);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          this.log.warn(`${reason}.look-error`, { err: errorMessage(err) });
        });
      }
      return true;
    } catch (err) {
      this.log.warn(`${reason}.look-error`, { err: errorMessage(err) });
      return false;
    }
  }

  _setControlState(control, value, reason) {
    try {
      if (this.bot.humanizer?.setControlState) {
        this.bot.humanizer.setControlState(this.bot, control, value, {
          reason,
          critical: true,
        });
      } else {
        this.bot.setControlState?.(control, value);
      }
      return true;
    } catch (err) {
      this.log.warn(`${reason}.control-error`, { control, value, err: errorMessage(err) });
      return false;
    }
  }

  _clearWaterEscapeControls() {
    this._setControlState('forward', false, 'water_escape.clear');
    this._setControlState('jump', false, 'water_escape.clear');
    this._setControlState('sprint', false, 'water_escape.clear');
  }

  _suppressAutoEat(reason, { cancelHeldItem = true } = {}) {
    if (
      !this._autoEatSuppressed &&
      this.bot.autoEat?.enabled === true &&
      typeof this.bot.autoEat.disableAuto === 'function'
    ) {
      try {
        this.bot.autoEat.disableAuto();
        this._autoEatSuppressed = true;
        this.log.info('autoeat.suppressed', { reason });
      } catch (err) {
        this.log.warn('autoeat.suppress-error', { reason, err: err?.message || String(err) });
      }
    }
    if (cancelHeldItem) cancelUnsafeItemUse(this.bot, this.log, reason);
  }

  _resumeAutoEat(reason) {
    if (!this._autoEatSuppressed) return;
    try {
      this.bot.autoEat?.enableAuto?.();
      this._autoEatSuppressed = false;
      this.log.info('autoeat.resumed', { reason });
    } catch (err) {
      this.log.warn('autoeat.resume-error', { reason, err: err?.message || String(err) });
    }
  }
}

export const REACTIVE_STATE = STATE;
export default ReactiveController;
