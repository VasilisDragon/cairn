// Compact world-state snapshot. This is what the advisor sees.
// Keep it small — every field has a reason to be here.

import config from '../config.js';
import { buildAdvisorWorldModelSummary } from './world_model.js';
import { planMiningToolProgression } from './materials.js';
import { chooseCombatResponse, chooseShieldBlockResponse, totalArmorScore } from '../reactive/combat_policy.js';
import { chooseConsumableAction } from '../reactive/consumable_policy.js';
import { compactTaskBudget } from '../runtime/task_budget.js';

function timeOfDayBucket(timeOfDay) {
  // Minecraft day: 0-23999 ticks. 0 dawn, 6000 noon, 12000 dusk, 18000 midnight.
  const t = timeOfDay % 24000;
  if (t < 1000) return 'dawn';
  if (t < 12000) return 'day';
  if (t < 13000) return 'dusk';
  return 'night';
}

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'husk', 'stray',
  'drowned', 'phantom', 'piglin', 'piglin_brute', 'zombified_piglin',
  'hoglin', 'zoglin', 'wither_skeleton', 'blaze', 'magma_cube', 'slime',
  'ghast', 'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite',
  'vex', 'warden', 'wither', 'ender_dragon', 'breeze', 'bogged',
]);

const RANGED_HOSTILE_NAMES = new Set([
  'blaze', 'bogged', 'ghast', 'guardian', 'elder_guardian', 'phantom',
  'pillager', 'shulker', 'skeleton', 'stray',
]);

const SPECIAL_HOSTILE_NAMES = new Set([
  'enderman', 'evoker', 'ravager', 'vex', 'warden', 'witch', 'wither',
  'ender_dragon',
]);

const EXPLOSIVE_HOSTILE_NAMES = new Set(['creeper']);
const BOSS_HOSTILE_NAMES = new Set(['elder_guardian', 'warden', 'wither', 'ender_dragon']);

function summarizeInventory(bot, cap) {
  try {
    const grouped = new Map();
    const rawItems = bot.inventory.items();
    for (const item of rawItems) {
      grouped.set(item.name, (grouped.get(item.name) || 0) + item.count);
    }
    // include held + armor explicitly so the advisor sees them
    const items = [];
    for (const [name, count] of grouped.entries()) items.push({ name, count });
    items.sort((a, b) => b.count - a.count);
    return { items: items.slice(0, cap), rawItems, error: null };
  } catch (err) {
    return { items: [], rawItems: [], error: errorMessage(err) };
  }
}

function nearbyHostiles(bot, radius, cap) {
  const me = bot.entity?.position;
  if (!me) return [];
  const out = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    if (!HOSTILE_NAMES.has(e.name)) continue;
    const d = me.distanceTo(e.position);
    if (d > radius) continue;
    out.push({ name: e.name, distance: Math.round(d * 10) / 10 });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, cap);
}

function worldModelSummary(ctx) {
  try {
    if (ctx.worldModelSummary) return { summary: ctx.worldModelSummary, error: null };
    const model = ctx.worldModelStore?.load ? ctx.worldModelStore.load() : ctx.worldModel;
    if (!model) return { summary: null, error: null };
    return { summary: buildAdvisorWorldModelSummary(model, ctx.worldModelSummaryOptions), error: null };
  } catch (err) {
    return { summary: null, error: errorMessage(err) };
  }
}

function miningProgression(bot, ctx, inventoryItems) {
  try {
    const targets = ctx.miningProgressionTargets;
    if (!Array.isArray(targets) || targets.length === 0) return { summary: null, error: null };
    const plan = planMiningToolProgression({
      oreTargets: targets,
      inventory: inventoryItems,
      registry: bot.registry,
      optionalCrafts: ctx.miningProgressionOptionalCrafts,
    });
    return {
      summary: compactMiningProgression(plan, ctx.miningProgressionStepCap),
      error: null,
    };
  } catch (err) {
    return { summary: null, error: errorMessage(err) };
  }
}

function compactMiningProgression(plan, stepCap = 12) {
  const limit = Number.isFinite(stepCap) ? Math.max(0, Math.floor(stepCap)) : 12;
  return {
    targets: {
      harvestable: (plan.targets?.harvestable || []).map((target) => target.block),
      blocked: (plan.targets?.blocked || []).map((target) => ({
        block: target.block,
        missingTools: target.missingTools,
      })),
    },
    requiredTools: plan.requiredTools || [],
    steps: (plan.steps || []).slice(0, limit).map(compactMiningProgressionStep),
    optional: (plan.optionalToolPlans || []).map((entry) => ({
      item: entry.item,
      ready: entry.resourceReady === true,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.missing && Object.keys(entry.missing).length > 0 ? { missing: entry.missing } : {}),
    })),
    ...(plan.fieldKit ? { fieldKit: compactMiningFieldKit(plan.fieldKit) } : {}),
  };
}

function compactMiningFieldKit(fieldKit) {
  return {
    required: fieldKit.required === true,
    needsCraftingTable: fieldKit.needsCraftingTable === true,
    needsFurnace: fieldKit.needsFurnace === true,
    recommendedCarry: fieldKit.recommendedCarry || {},
    missingPortableSupplies: fieldKit.missingPortableSupplies || {},
    selfContainedInFieldReady: fieldKit.execution?.selfContainedInFieldReady === true,
    blockers: (fieldKit.execution?.blockers || []).slice(0, 4),
    reasoning: (fieldKit.reasoning || []).slice(0, 6),
  };
}

function compactMiningProgressionStep(step) {
  const out = { action: step.action };
  for (const key of ['block', 'item', 'input', 'output']) {
    if (step[key]) out[key] = step[key];
  }
  if (Number.isFinite(step.count)) out.count = step.count;
  if (step.optional === true) out.optional = true;
  if (step.reason) out.reason = shortText(step.reason, 120);
  return out;
}

function compactCall(call) {
  if (!call?.skill) return null;
  return { skill: call.skill, params: call.params || {} };
}

function currentSkill(bot, ctx) {
  if (ctx.currentSkill) return ctx.currentSkill;
  const call = ctx.currentCall || bot.skillExecutor?.currentCall;
  if (call?.skill) return compactCall(call);
  if (ctx.currentSubtask) return { skill: String(ctx.currentSubtask).split('(')[0] };
  return null;
}

function queueLength(bot, ctx) {
  if (typeof ctx.queueLength === 'number') return ctx.queueLength;
  if (typeof bot.skillExecutor?.queue?.length === 'number') return bot.skillExecutor.queue.length;
  const remaining = Array.isArray(ctx.remainingQueue) ? ctx.remainingQueue.length : 0;
  return remaining + (ctx.currentSubtask ? 1 : 0);
}

function taskBudget(bot, ctx) {
  try {
    const source = ctx.taskBudget || ctx.taskTiming || ctx.currentCall?._state?._executor || bot.skillExecutor?.currentCall?._state?._executor || null;
    if (!source || typeof source !== 'object') return { budget: null, error: null };
    const nowMs = Number.isFinite(ctx.nowMs) ? Number(ctx.nowMs) : Date.now();
    return { budget: compactTaskBudget(source, nowMs), error: null };
  } catch (err) {
    return { budget: null, error: errorMessage(err) };
  }
}

function hazardFlags(bot) {
  const velocityY = typeof bot.entity?.velocity?.y === 'number' ? bot.entity.velocity.y : null;
  const oxygenLevel = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null;
  const inWater = bot.entity?.isInWater === true;
  return {
    inWater,
    oxygenLevel,
    oxygenLow: inWater && oxygenLevel != null ? oxygenLevel <= 16 : false,
    onGround: bot.entity?.onGround ?? null,
    falling: bot.entity?.onGround === false && velocityY != null && velocityY < 0,
    velocityY,
    usingHeldItem: bot.usingHeldItem === true,
    autoEatEating: bot.autoEat?.isEating === true,
  };
}

function nearestHostileThreat(bot, radius) {
  const threats = hostileThreats(bot, radius);
  return threats[0] ? { ...threats[0], threats } : null;
}

function hostileThreats(bot, radius) {
  const me = bot.entity?.position;
  if (!me) return [];
  const threats = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position || !HOSTILE_NAMES.has(e.name)) continue;
    const distance = me.distanceTo(e.position);
    if (distance > radius) continue;
    threats.push({ entity: e, distance });
  }
  threats.sort((a, b) => a.distance - b.distance || String(a.entity.id).localeCompare(String(b.entity.id), undefined, { numeric: true }));
  return threats;
}

function consumablePolicy(bot, ctx, inventoryItems, radius, activeEffectsList, combatRisk = null) {
  try {
    return compactConsumableDecision(chooseConsumableAction({
      health: bot.health ?? 20,
      food: bot.food ?? 20,
      inventoryItems,
      activeEffects: activeEffectsList,
      threat: nearestHostileThreat(bot, radius),
      combatRisk,
      ...(ctx.consumablePolicyOptions || {}),
    }));
  } catch (err) {
    return { action: 'none', reason: `consumable policy unavailable: ${errorMessage(err)}` };
  }
}

function compactConsumableDecision(decision) {
  return {
    action: decision.action,
    reason: decision.reason,
    ...(decision.effect ? { effect: decision.effect } : {}),
    ...(Number.isFinite(decision.level) ? { level: decision.level } : {}),
    ...(decision.item ? { item: compactItem(decision.item) } : {}),
  };
}

function recentDamagePressure(bot, ctx) {
  try {
    const pressure = ctx.recentDamage || bot.reactiveController?.recentDamagePressure?.() || null;
    if (!pressure || typeof pressure !== 'object') return { pressure: null, error: null };
    return { pressure, error: null };
  } catch (err) {
    return { pressure: null, error: errorMessage(err) };
  }
}

function recentEvents(bot, ctx, cap) {
  try {
    const source = Array.isArray(ctx.recentEvents)
      ? ctx.recentEvents
      : typeof bot.skillExecutor?.recentEvents === 'function'
        ? bot.skillExecutor.recentEvents(cap)
        : [];
    return {
      events: compactRecentEvents(source, ctx.recentEventsCap ?? cap),
      error: null,
    };
  } catch (err) {
    return { events: [], error: errorMessage(err) };
  }
}

function compactRecentEvents(events, cap) {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 12;
  return (Array.isArray(events) ? events : [])
    .slice(-limit)
    .map(compactRecentEvent)
    .filter(Boolean);
}

function compactRecentEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const name = event.event || event.type || event.evt;
  if (!name) return null;
  const out = { event: String(name) };
  if (Number.isFinite(event.seq)) out.seq = Math.round(event.seq);
  if (event.skill) out.skill = String(event.skill);
  if (typeof event.reason === 'string' && event.reason) out.reason = shortText(event.reason, 160);
  for (const key of ['count', 'dropped', 'queueLength', 'queueLeft', 'dtMs']) {
    if (Number.isFinite(event[key])) out[key] = Math.max(0, Math.round(event[key]));
  }
  for (const key of ['ok', 'preempted', 'resume', 'running']) {
    if (typeof event[key] === 'boolean') out[key] = event[key];
  }
  return out;
}

function shortText(value, max) {
  const text = String(value);
  return text.length > max ? text.slice(0, Math.max(0, max - 3)) + '...' : text;
}

function compactItem(item) {
  if (!item) return null;
  return {
    name: item.name,
    count: item.count ?? 1,
    ...(Number.isFinite(item.slot) ? { slot: item.slot } : {}),
  };
}

function equipmentSummary(bot) {
  try {
    const equipment = bot.entity?.equipment || [];
    const summary = {
      hand: compactItem(bot.heldItem || equipment[0]),
      offHand: compactItem(equipment[1]),
      feet: compactItem(equipment[2]),
      legs: compactItem(equipment[3]),
      torso: compactItem(equipment[4]),
      head: compactItem(equipment[5]),
    };
    const armorItems = [equipment[2], equipment[3], equipment[4], equipment[5]].filter(Boolean);
    return {
      summary,
      raw: {
        hand: bot.heldItem || equipment[0] || null,
        offHand: equipment[1] || null,
        armorItems,
      },
      armorScore: totalArmorScore(armorItems),
      error: null,
    };
  } catch (err) {
    return {
      summary: { hand: null, offHand: null, feet: null, legs: null, torso: null, head: null },
      raw: { hand: null, offHand: null, armorItems: [] },
      armorScore: 0,
      error: errorMessage(err),
    };
  }
}

function combatPolicy(bot, ctx, inventoryItems, radius, equipment, activeEffectsList, recentDamage) {
  try {
    const threat = nearestHostileThreat(bot, radius);
    const options = ctx.combatPolicyOptions || {};
    const rangedFireEnabled = options.rangedCombatFireEnabled ?? config.reactive.rangedCombatFireEnabled;
    const lineOfSight = options.rangedCombatLineOfSight ?? (
      rangedFireEnabled === true ? (entry) => rangedLineOfSight(bot, entry) : null
    );
    const nearestLineOfSight = resolveLineOfSight(lineOfSight, threat);
    const decision = chooseCombatResponse({
      threat,
      health: bot.health ?? 20,
      heldItem: equipment.raw.hand,
      offHandItem: equipment.raw.offHand,
      inventoryItems,
      armorItems: equipment.raw.armorItems,
      engageOverFlee: options.engageOverFlee ?? config.reactive.engageOverFlee,
      lowHealthFleeThreshold: options.lowHealthFleeThreshold ?? config.reactive.lowHealthFleeThreshold,
      minArmorScoreToEngage: options.minArmorScoreToEngage ?? config.reactive.minArmorScoreToEngage,
      maxMeleeEngageThreatCount: options.maxMeleeEngageThreatCount ?? config.reactive.maxMeleeEngageThreatCount,
      minMeleeSurvivalSecondsToEngage: options.minMeleeSurvivalSecondsToEngage ?? config.reactive.minMeleeSurvivalSecondsToEngage,
      minMeleeKillMarginSecondsToEngage: options.minMeleeKillMarginSecondsToEngage ?? config.reactive.minMeleeKillMarginSecondsToEngage,
      activeEffects: activeEffectsList,
      recentDamage,
      requireShieldToEngage: options.requireShieldToEngage ?? config.reactive.requireShieldToEngage,
      rangedCombatPrepEnabled: options.rangedCombatPrepEnabled ?? config.reactive.rangedCombatPrepEnabled,
      rangedCombatFireEnabled: rangedFireEnabled,
      rangedCombatLineOfSight: lineOfSight,
      rangedCombatFireMinDistance: options.rangedCombatFireMinDistance ?? config.reactive.rangedCombatFireMinDistance,
      rangedCombatFireMaxDistance: options.rangedCombatFireMaxDistance ?? config.reactive.rangedCombatFireMaxDistance,
    });
    const shield = chooseShieldBlockResponse({
      threat,
      combatAction: decision.action,
      offHandItem: equipment.raw.offHand,
      shieldActive: bot.reactiveController?._shieldBlockActive === true,
      enabled: options.shieldBlockingEnabled ?? config.reactive.shieldBlockingEnabled,
      blockDistance: options.shieldBlockDistance ?? config.reactive.shieldBlockDistance,
      releaseDistance: options.shieldReleaseDistance ?? config.reactive.shieldReleaseDistance,
    });
    const displayedLineOfSight = decision.targetThreat
      ? resolveLineOfSight(lineOfSight, decision.targetThreat)
      : nearestLineOfSight;
    return compactCombatDecision(decision, threat, {
      armorScore: equipment.armorScore,
      lineOfSight: displayedLineOfSight,
      shield,
    });
  } catch (err) {
    return { action: 'none', reason: `combat policy unavailable: ${errorMessage(err)}` };
  }
}

function combatOverview(bot, ctx, radius, equipment, recentDamage, decision) {
  try {
    const threats = hostileThreats(bot, radius);
    const options = ctx.combatPolicyOptions || {};
    const lastRangedFire = lastRangedFireVerification(bot, ctx);
    const maxMeleeThreats = Number.isFinite(options.maxMeleeEngageThreatCount)
      ? Math.max(1, options.maxMeleeEngageThreatCount)
      : Math.max(1, config.reactive.maxMeleeEngageThreatCount ?? 1);
    const lowHealth = Number.isFinite(options.lowHealthFleeThreshold)
      ? Math.max(0, options.lowHealthFleeThreshold)
      : Math.max(0, config.reactive.lowHealthFleeThreshold ?? 8);
    const closeDistance = Number.isFinite(options.closeThreatDistance)
      ? Math.max(0, options.closeThreatDistance)
      : 4.5;
    const threatCount = threats.length;
    const closeThreats = threats.filter((threat) => threat.distance <= closeDistance);
    const closeCount = closeThreats.length;
    const names = threats.map((threat) => String(threat.entity?.name || 'unknown'));
    const closeNames = closeThreats.map((threat) => String(threat.entity?.name || 'unknown'));
    const flags = {
      groupPressure: threatCount > maxMeleeThreats,
      closePressure: closeCount > 0,
      rangedThreat: names.some((name) => RANGED_HOSTILE_NAMES.has(name)),
      specialThreat: names.some((name) => SPECIAL_HOSTILE_NAMES.has(name)),
      explosiveThreat: names.some((name) => EXPLOSIVE_HOSTILE_NAMES.has(name)),
      closeExplosiveThreat: closeNames.some((name) => EXPLOSIVE_HOSTILE_NAMES.has(name)),
      bossThreat: names.some((name) => BOSS_HOSTILE_NAMES.has(name)),
      lowHealth: typeof bot.health === 'number' && bot.health <= lowHealth,
      recentDamage: Number(recentDamage?.totalDamage || 0) > 0,
    };
    const replanTriggers = combatReplanTriggers(flags);
    return {
      threatLevel: combatThreatLevel({ threatCount, closeCount, maxMeleeThreats, flags, recentDamage }),
      advisorPriority: combatAdvisorPriority(decision, flags),
      threatCount,
      ...(threats[0] ? { nearest: compactThreat(threats[0]) } : {}),
      closeCount,
      closeDistance,
      maxMeleeEngageThreatCount: maxMeleeThreats,
      armorScore: equipment.armorScore,
      composition: combatThreatComposition(threats),
      flags: compactFlags(flags),
      replanTriggers,
      ...(lastRangedFire.summary ? { lastRangedFire: lastRangedFire.summary } : {}),
      ...(lastRangedFire.error ? { lastRangedFireStatus: { ok: false, reason: `last ranged fire unavailable: ${lastRangedFire.error}` } } : {}),
      recommendedAction: decision?.action || 'none',
      recommendedReason: decision?.reason || 'no-threat',
      ...(combatRecommendedTarget(decision) ? { recommendedTarget: combatRecommendedTarget(decision) } : {}),
    };
  } catch (err) {
    return {
      threatLevel: 'unknown',
      advisorPriority: 'survival',
      threatCount: null,
      reason: `combat overview unavailable: ${errorMessage(err)}`,
    };
  }
}

function combatRecommendedTarget(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return decision.targetThreat || decision.threat || null;
}

function lastRangedFireVerification(bot, ctx) {
  try {
    if (ctx.lastRangedFireVerification) {
      return { summary: compactRangedFireVerification(ctx.lastRangedFireVerification, ctx.nowMs), error: null };
    }
    const reader = bot.reactiveController?.lastRangedFireVerification;
    if (typeof reader === 'function') {
      return { summary: compactRangedFireVerification(reader.call(bot.reactiveController, ctx.nowMs), ctx.nowMs), error: null };
    }
    return { summary: null, error: null };
  } catch (err) {
    return { summary: null, error: errorMessage(err) };
  }
}

function compactRangedFireVerification(record, nowMs) {
  if (!record || typeof record !== 'object') return null;
  const at = Number(record.at);
  const ageMs = Number.isFinite(record.ageMs)
    ? Math.max(0, Math.round(record.ageMs))
    : Number.isFinite(at) && Number.isFinite(nowMs)
      ? Math.max(0, Math.round(nowMs - at))
      : null;
  return {
    outcome: String(record.outcome || 'unknown'),
    ...(record.entity ? { entity: String(record.entity) } : {}),
    ...(record.entityId != null ? { entityId: record.entityId } : {}),
    ...(record.item ? { item: String(record.item) } : {}),
    ...(record.reason ? { reason: shortText(record.reason, 120) } : {}),
    ...(Number.isFinite(record.currentDistance) ? { currentDistance: Math.round(record.currentDistance * 10) / 10 } : {}),
    ...(record.currentDistance === null ? { currentDistance: null } : {}),
    ...(typeof record.lineOfSight === 'boolean' ? { lineOfSight: record.lineOfSight } : {}),
    ...(record.lineOfSight === null ? { lineOfSight: null } : {}),
    ...(Number.isFinite(record.initialHealth) ? { initialHealth: Math.round(record.initialHealth * 100) / 100 } : {}),
    ...(Number.isFinite(record.currentHealth) ? { currentHealth: Math.round(record.currentHealth * 100) / 100 } : {}),
    ...(Number.isFinite(record.followUpShots) ? { followUpShots: Math.max(0, Math.round(record.followUpShots)) } : {}),
    ...(Number.isFinite(record.maxFollowUpShots) ? { maxFollowUpShots: Math.max(1, Math.round(record.maxFollowUpShots)) } : {}),
    ...(Number.isFinite(record.followUpWindowMs) ? { followUpWindowMs: Math.max(0, Math.round(record.followUpWindowMs)) } : {}),
    ...(ageMs != null ? { ageMs } : {}),
  };
}

function compactCombatDecision(decision, threat, context = {}) {
  return {
    action: decision.action,
    reason: decision.reason,
    ...(threat ? { threat: compactThreat(threat) } : {}),
    armorScore: context.armorScore ?? 0,
    ...(Number.isFinite(decision.requiredArmorScore) ? { requiredArmorScore: decision.requiredArmorScore } : {}),
    ...(Number.isFinite(decision.threatCount) ? { threatCount: decision.threatCount } : {}),
    ...(Number.isFinite(decision.maxMeleeEngageThreatCount) ? { maxMeleeEngageThreatCount: decision.maxMeleeEngageThreatCount } : {}),
    ...(Number.isFinite(decision.minMeleeSurvivalSecondsToEngage) ? { minMeleeSurvivalSecondsToEngage: decision.minMeleeSurvivalSecondsToEngage } : {}),
    ...(Number.isFinite(decision.minMeleeKillMarginSecondsToEngage) ? { minMeleeKillMarginSecondsToEngage: decision.minMeleeKillMarginSecondsToEngage } : {}),
    ...(decision.meleeRisk ? { meleeRisk: decision.meleeRisk } : {}),
    ...(decision.item ? { item: compactItem(decision.item) } : {}),
    ...(decision.unsafeThreat ? { unsafeThreat: decision.unsafeThreat } : {}),
    ...(Number.isFinite(decision.closeThreatDistance) ? { closeThreatDistance: decision.closeThreatDistance } : {}),
    ...(decision.targetThreat ? { targetThreat: compactThreat(decision.targetThreat) } : {}),
    ...(context.lineOfSight !== null ? { lineOfSight: context.lineOfSight } : {}),
    shield: {
      action: context.shield?.action || 'none',
      reason: context.shield?.reason || 'not-evaluated',
    },
  };
}

function combatReplanTriggers(flags) {
  const triggers = [];
  if (flags.lowHealth) triggers.push('low-health');
  if (flags.recentDamage) triggers.push('recent-damage');
  if (flags.bossThreat) triggers.push('boss-threat');
  if (flags.closeExplosiveThreat) triggers.push('close-explosive-threat');
  if (flags.explosiveThreat) triggers.push('explosive-threat');
  if (flags.specialThreat) triggers.push('special-threat');
  if (flags.rangedThreat) triggers.push('ranged-threat');
  if (flags.groupPressure) triggers.push('group-pressure');
  if (flags.closePressure) triggers.push('close-pressure');
  return triggers;
}

function combatThreatLevel({ threatCount, closeCount, maxMeleeThreats, flags, recentDamage }) {
  if (threatCount <= 0) return 'clear';
  const recentDps = Number(recentDamage?.recentDamagePerSecond || 0);
  if (
    flags.lowHealth
    || flags.bossThreat
    || flags.closeExplosiveThreat
    || closeCount >= 3
    || threatCount > maxMeleeThreats + 2
    || recentDps >= 6
  ) {
    return 'critical';
  }
  if (
    flags.groupPressure
    || flags.explosiveThreat
    || flags.specialThreat
    || flags.rangedThreat
    || flags.closePressure
    || flags.recentDamage
  ) {
    return 'high';
  }
  return 'watch';
}

function combatAdvisorPriority(decision, flags) {
  if (flags.lowHealth || flags.bossThreat) return 'survival';
  if (decision?.action === 'flee') return 'retreat';
  if (['engage', 'equip_weapon', 'equip_shield', 'activate_shield', 'equip_ranged_weapon', 'fire_ranged_weapon'].includes(decision?.action)) {
    return 'combat';
  }
  if (flags.recentDamage || flags.groupPressure || flags.closePressure) return 'retreat';
  return 'normal';
}

function combatThreatComposition(threats) {
  const counts = new Map();
  for (const threat of threats || []) {
    const name = String(threat?.entity?.name || 'unknown');
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);
}

function compactFlags(flags) {
  return Object.fromEntries(Object.entries(flags).filter(([, value]) => value === true));
}

function compactThreat(threat) {
  return {
    name: threat.entity.name,
    distance: Math.round(threat.distance * 10) / 10,
    ...(threat.entity.type ? { type: threat.entity.type } : {}),
  };
}

function rangedLineOfSight(bot, threat) {
  if (typeof bot.canSeeEntity !== 'function') return null;
  try {
    return bot.canSeeEntity(threat.entity) === true;
  } catch {
    return null;
  }
}

function resolveLineOfSight(lineOfSight, threat) {
  if (typeof lineOfSight !== 'function') return lineOfSight;
  if (!threat) return null;
  try {
    return lineOfSight(threat);
  } catch {
    return null;
  }
}

export function activeEffects(bot) {
  try {
    const raw = bot.entity?.effects;
    if (!raw) return { effects: [], error: null };
    const entries = raw instanceof Map
      ? Array.from(raw.entries())
      : Array.isArray(raw)
        ? raw.map((effect, index) => [index, effect])
        : Object.entries(raw);
    const effects = entries
      .map(([key, effect]) => compactActiveEffect(bot, effect, key))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name) || b.level - a.level);
    return { effects, error: null };
  } catch (err) {
    return { effects: [], error: errorMessage(err) };
  }
}

function compactActiveEffect(bot, effect, key = null) {
  const name = activeEffectName(bot, effect, key);
  if (!name) return null;
  const level = activeEffectLevel(effect);
  const duration = typeof effect?.duration === 'number' && Number.isFinite(effect.duration)
    ? effect.duration
    : null;
  return {
    name,
    level,
    ...(duration !== null ? { duration } : {}),
  };
}

function activeEffectName(bot, effect, key = null) {
  if (typeof effect === 'string') return normalizeEffectName(effect);
  const explicit = effect?.effectName || effect?.name || effect?.effect;
  if (explicit) return normalizeEffectName(explicit);
  const id = Number.isFinite(effect?.id) ? effect.id : numericKey(key);
  if (id !== null) {
    const registryEffect = bot.registry?.effectsArray?.find((entry) => entry.id === id);
    return registryEffect ? normalizeEffectName(registryEffect.displayName || registryEffect.name) : `effect_${id}`;
  }
  return null;
}

function activeEffectLevel(effect) {
  if (typeof effect !== 'object' || effect === null) return 1;
  if (Number.isFinite(effect.level)) return effect.level;
  if (Number.isFinite(effect.amplifier)) return effect.amplifier + 1;
  return 1;
}

function normalizeEffectName(value) {
  return String(value || '')
    .replace(/^minecraft:/i, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function numericKey(key) {
  if (typeof key === 'number' && Number.isFinite(key)) return key;
  if (typeof key !== 'string' || key.trim() === '') return null;
  const value = Number(key);
  return Number.isFinite(value) ? value : null;
}

/**
 * Build a snapshot of the current world state.
 * @param {import('mineflayer').Bot} bot
 * @param {{ currentSubtask?: string|null, currentSkill?: any, currentCall?: any, queueLength?: number, remainingQueue?: any[], recentDamage?: any, recentEvents?: any[], recentEventsCap?: number, taskBudget?: any, taskTiming?: any, nowMs?: number, consumablePolicyOptions?: any, combatPolicyOptions?: any, miningProgressionTargets?: string[], miningProgressionOptionalCrafts?: string[], miningProgressionStepCap?: number, worldModel?: any, worldModelStore?: any, worldModelSummary?: any, worldModelSummaryOptions?: any }} ctx
 */
export function buildSnapshot(bot, ctx = {}) {
  const pos = bot.entity?.position;
  const radius = config.reactive.hostileScanRadius;
  const invCap = config.advisor.snapshotInventoryCap;
  const hostileCap = config.advisor.snapshotHostileCap;
  const recentEventsCap = config.advisor.snapshotRecentEventsCap ?? 12;

  const inventory = summarizeInventory(bot, invCap);
  const world = worldModelSummary(ctx);
  const progression = miningProgression(bot, ctx, inventory.rawItems);
  const effects = activeEffects(bot);
  const recentDamage = recentDamagePressure(bot, ctx);
  const events = recentEvents(bot, ctx, recentEventsCap);
  const budget = taskBudget(bot, ctx);
  const equipment = equipmentSummary(bot);
  const combat = combatPolicy(bot, ctx, inventory.rawItems, radius, equipment, effects.effects, recentDamage.pressure);
  return {
    position: pos
      ? {
          x: Math.round(pos.x * 100) / 100,
          y: Math.round(pos.y * 100) / 100,
          z: Math.round(pos.z * 100) / 100,
          dimension: bot.game?.dimension || 'unknown',
        }
      : null,
    health: bot.health ?? null,
    food: bot.food ?? null,
    saturation: bot.foodSaturation ?? null,
    timeOfDay: bot.time ? timeOfDayBucket(bot.time.timeOfDay) : 'unknown',
    inventory: inventory.items,
    ...(inventory.error ? { inventoryStatus: { ok: false, reason: `inventory unavailable: ${inventory.error}` } } : {}),
    equipment: {
      ...equipment.summary,
      armorScore: equipment.armorScore,
    },
    ...(equipment.error ? { equipmentStatus: { ok: false, reason: `equipment unavailable: ${equipment.error}` } } : {}),
    nearbyHostiles: nearbyHostiles(bot, radius, hostileCap),
    activeEffects: effects.effects,
    ...(effects.error ? { activeEffectsStatus: { ok: false, reason: `active effects unavailable: ${effects.error}` } } : {}),
    ...(recentDamage.pressure && Number(recentDamage.pressure.totalDamage) > 0 ? { recentDamage: recentDamage.pressure } : {}),
    ...(recentDamage.error ? { recentDamageStatus: { ok: false, reason: `recent damage unavailable: ${recentDamage.error}` } } : {}),
    ...(events.events.length > 0 ? { recentEvents: events.events } : {}),
    ...(events.error ? { recentEventsStatus: { ok: false, reason: `recent events unavailable: ${events.error}` } } : {}),
    ...(budget.budget ? { taskBudget: budget.budget } : {}),
    ...(budget.error ? { taskBudgetStatus: { ok: false, reason: `task budget unavailable: ${budget.error}` } } : {}),
    consumablePolicy: consumablePolicy(bot, ctx, inventory.rawItems, radius, effects.effects, combat?.meleeRisk),
    combatPolicy: combat,
    combatOverview: combatOverview(bot, ctx, radius, equipment, recentDamage.pressure, combat),
    reactiveState: ctx.reactiveState ?? bot.reactiveController?.state ?? null,
    currentSkill: currentSkill(bot, ctx),
    currentSubtask: ctx.currentSubtask ?? null,
    queueLength: queueLength(bot, ctx),
    remainingQueue: ctx.remainingQueue ?? [],
    pathfinder: pathfinderContext(bot),
    hazardFlags: hazardFlags(bot),
    ...(progression.summary ? { miningProgression: progression.summary } : {}),
    ...(progression.error ? { miningProgressionStatus: { ok: false, reason: `mining progression unavailable: ${progression.error}` } } : {}),
    ...(world.summary ? { worldModel: world.summary } : {}),
    ...(world.error ? { worldModelStatus: { ok: false, reason: `world-model summary unavailable: ${world.error}` } } : {}),
  };
}

export default buildSnapshot;

function errorMessage(err) {
  return err?.message || String(err);
}

function pathfinderContext(bot) {
  const context = {
    owner: null,
    idle: null,
  };
  try {
    context.owner = bot.pathfinderOwner?.currentOwner?.() ?? null;
  } catch (err) {
    context.ownerError = errorMessage(err);
  }
  try {
    context.idle = bot.pathfinderOwner?.isIdle?.() ?? null;
  } catch (err) {
    context.idleError = errorMessage(err);
  }
  return context;
}
