import log from '../logger.js';
import {
  authorizeBlockBreak,
  authorizePlacement,
} from '../state/world_action_authorization.js';

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;
const CONTROL_STATES = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']);
const DEFAULTS = Object.freeze({
  enabled: false,
  seed: 'mcbot-humanize-v1',
  mood: 'efficient',
  aimMinMs: 100,
  aimMaxMs: 400,
  aimFrameMs: 50,
  aimJitterDegrees: 2,
  maxRotationDegreesPerSecond: 720,
  maxRotationDegreesPerTick: 35,
  reactionMedianMs: 250,
  reactionP95Ms: 500,
  criticalReactionMs: 0,
  clickMinIntervalMs: 70,
  cadenceJitterMs: 45,
  attackReach: 4.5,
  interactReach: 5.0,
  moodDriftStep: 0.025,
  interActionVariationEnabled: true,
  interActionMinMs: 60,
  interActionMaxMs: 260,
  interActionLookChance: 0.22,
  interActionMicroRepositionChance: 0.10,
  interActionMicroRepositionMs: 140,
  maxWalkBlocksPerSecond: 4.4,
  maxSprintBlocksPerSecond: 5.7,
  jumpInitialVelocity: 0.42,
  jumpGravityPerTick: 0.08,
  jumpVelocityTolerance: 0.025,
  idleMicroBehaviorEnabled: true,
  idleMinMs: 12000,
  idleMaxMs: 28000,
  idleHopMs: 180,
  idleInventoryFlipMs: 550,
  pathEntropyEnabled: true,
  pathEntropyMaxOffsetBlocks: 1,
  pathEntropyMinRange: 1,
});
const IDLE_BEHAVIORS = Object.freeze(['look_at_sky', 'scenery_glance', 'hop_in_place', 'inventory_flip']);
const MOOD_PROFILES = Object.freeze({
  cautious: Object.freeze({
    reactionScale: 1.18,
    cadenceScale: 1.20,
    idleDelayScale: 0.85,
    interActionScale: 1.20,
    lookChanceScale: 1.45,
    repositionChanceScale: 0.55,
    pathEntropyScale: 0.75,
    idleWeights: { look_at_sky: 3, scenery_glance: 4, hop_in_place: 1, inventory_flip: 1 },
  }),
  exploratory: Object.freeze({
    reactionScale: 1.05,
    cadenceScale: 1.10,
    idleDelayScale: 0.75,
    interActionScale: 1.10,
    lookChanceScale: 1.65,
    repositionChanceScale: 1.55,
    pathEntropyScale: 1.35,
    idleWeights: { look_at_sky: 1, scenery_glance: 5, hop_in_place: 2, inventory_flip: 1 },
  }),
  efficient: Object.freeze({
    reactionScale: 0.88,
    cadenceScale: 0.75,
    idleDelayScale: 1.30,
    interActionScale: 0.80,
    lookChanceScale: 0.65,
    repositionChanceScale: 0.45,
    pathEntropyScale: 0.70,
    idleWeights: { look_at_sky: 1, scenery_glance: 2, hop_in_place: 1, inventory_flip: 1 },
  }),
  social: Object.freeze({
    reactionScale: 1.10,
    cadenceScale: 1.05,
    idleDelayScale: 0.80,
    interActionScale: 1.05,
    lookChanceScale: 1.35,
    repositionChanceScale: 1.00,
    pathEntropyScale: 1.00,
    idleWeights: { look_at_sky: 1, scenery_glance: 4, hop_in_place: 1, inventory_flip: 3 },
  }),
});
const REACTIVE_NORMAL = 'NORMAL';

export function installHumanizer(bot, options = {}, logger = log.bot) {
  const humanizer = createHumanizer(options, logger);
  bot.humanizer = humanizer;
  logger?.info?.('humanize.installed', {
    enabled: humanizer.enabled,
    aimMinMs: humanizer.options.aimMinMs,
    aimMaxMs: humanizer.options.aimMaxMs,
    maxRotationDegreesPerSecond: humanizer.options.maxRotationDegreesPerSecond,
    maxRotationDegreesPerTick: humanizer.options.maxRotationDegreesPerTick,
    clickMinIntervalMs: humanizer.options.clickMinIntervalMs,
    cadenceJitterMs: humanizer.options.cadenceJitterMs,
    attackReach: humanizer.options.attackReach,
    interactReach: humanizer.options.interactReach,
    mood: humanizer.moodState().mood,
    moodScalar: humanizer.moodState().scalar,
    sessionSeedHash: humanizer.sessionSeedHash,
    interActionVariationEnabled: humanizer.options.interActionVariationEnabled,
    idleMicroBehaviorEnabled: humanizer.options.idleMicroBehaviorEnabled,
    pathEntropyEnabled: humanizer.options.pathEntropyEnabled,
  });
  return humanizer;
}

export function createHumanizer(options = {}, logger = log.bot) {
  return new Humanizer(options, logger);
}

export class Humanizer {
  constructor(options = {}, logger = log.bot) {
    this.options = normalizeOptions(options);
    this.enabled = this.options.enabled === true;
    this.logger = logger;
    this._lastClickAtMs = 0;
    this._lastControlCadenceAtMs = 0;
    this._sessionSeed = this.options.sessionSeed || `${this.options.seed}:${Date.now()}:${process.pid}`;
    this.sessionSeedHash = hashSeed(this._sessionSeed).toString(16).padStart(8, '0');
    this._rngState = hashSeed(this._sessionSeed);
    this._actionSeq = 0;
    this._moodScalar = roundTo(0.35 + this._nextRandom() * 0.30, 3);
    this._moodTarget = this._nextRandom();
    this._lastMoodLogAtSeq = 0;
  }

  moodState() {
    return {
      mood: this.options.mood,
      scalar: roundTo(this._moodScalar, 3),
      profile: moodProfile(this.options.mood),
    };
  }

  async lookAt(bot, target, {
    force = true,
    reason = 'lookAt',
    critical = false,
    signal = null,
  } = {}) {
    if (!this.enabled) return bot.lookAt(target, force);
    if (critical) {
      this._logCriticalExemption('lookAt', reason);
      return bot.lookAt(target, force);
    }
    await this._delayForReaction({ reason, signal, action: 'lookAt', bot });
    const plan = buildAimPlanForBot(bot, target, this.options);
    assertHumanizationInvariants({ aimPlans: [plan] }, this.options);
    this.logger?.debug?.('humanize.lookAt-plan', summarizeAimPlan(plan, reason));
    if (typeof bot.look === 'function' && plan.frames.length > 0) {
      let previousAt = 0;
      for (const frame of plan.frames) {
        throwIfAborted(signal);
        await sleep(Math.max(0, frame.atMs - previousAt), signal);
        previousAt = frame.atMs;
        await bot.look(frame.yaw * RAD_PER_DEG, frame.pitch * RAD_PER_DEG, force);
      }
      return null;
    }
    return bot.lookAt(target, force);
  }

  async placeBlock(bot, referenceBlock, faceVector, {
    reason = 'placeBlock',
    critical = false,
    signal = null,
    authorize = null,
  } = {}) {
    const finalAuthorize = typeof authorize === 'function'
      ? authorize
      : () => authorizePlacement(
        bot,
        bot?.runtimeContext || {},
        placementTargetPosition(referenceBlock?.position, faceVector),
        {
          referencePosition: referenceBlock?.position,
          referenceBlockName: referenceBlock?.name,
        },
      );
    if (!this.enabled) {
      assertWorldActionAuthorized(finalAuthorize, 'placeBlock');
      return bot.placeBlock(referenceBlock, faceVector);
    }
    validateReachFromBot(bot, referenceBlock?.position, this.options.interactReach, 'interact');
    if (critical) {
      this._logCriticalExemption('placeBlock', reason);
    } else {
      await this._delayForReaction({ reason, signal, action: 'placeBlock', bot });
      await this._waitForClickCadence(signal, { action: 'placeBlock', reason });
    }
    assertWorldActionAuthorized(finalAuthorize, 'placeBlock');
    return bot.placeBlock(referenceBlock, faceVector);
  }

  async digBlock(bot, block, {
    reason = 'dig',
    critical = false,
    signal = null,
    forceLook = true,
    digFace = undefined,
    authorize = null,
  } = {}) {
    const finalAuthorize = typeof authorize === 'function'
      ? authorize
      : () => authorizeBlockBreak(bot, bot?.runtimeContext || {}, block);
    if (!this.enabled) {
      assertWorldActionAuthorized(finalAuthorize, 'dig');
      return digBotBlock(bot, block, forceLook, digFace);
    }
    validateReachFromBot(bot, block?.position, this.options.interactReach, 'interact');
    if (critical) {
      this._logCriticalExemption('dig', reason);
    } else {
      await this._delayForReaction({ reason, signal, action: 'dig', bot });
      await this._waitForClickCadence(signal, { action: 'dig', reason });
    }
    this.logger?.debug?.('humanize.dig', {
      reason,
      critical,
      block: block?.name ?? null,
      position: positionRecord(block?.position),
    });
    assertWorldActionAuthorized(finalAuthorize, 'dig');
    return digBotBlock(bot, block, forceLook, digFace);
  }

  async activateBlock(bot, block, {
    reason = 'activateBlock',
    critical = false,
    signal = null,
    faceVector = undefined,
    cursorVector = undefined,
    authorize = null,
  } = {}) {
    const finalAuthorize = typeof authorize === 'function'
      ? authorize
      : () => authorizeBlockBreak(bot, bot?.runtimeContext || {}, block);
    if (!this.enabled) {
      assertWorldActionAuthorized(finalAuthorize, 'activateBlock');
      return activateBotBlock(bot, block, faceVector, cursorVector);
    }
    validateReachFromBot(bot, block?.position, this.options.interactReach, 'interact');
    if (critical) {
      this._logCriticalExemption('activateBlock', reason);
    } else {
      await this._delayForReaction({ reason, signal, action: 'activateBlock', bot });
      await this._waitForClickCadence(signal, { action: 'activateBlock', reason });
    }
    this.logger?.debug?.('humanize.activate-block', {
      reason,
      critical,
      block: block?.name ?? null,
    });
    assertWorldActionAuthorized(finalAuthorize, 'activateBlock');
    return activateBotBlock(bot, block, faceVector, cursorVector);
  }

  async equipItem(bot, item, destination, {
    reason = 'equip',
    critical = false,
    signal = null,
  } = {}) {
    if (!this.enabled) return bot.equip(item, destination);
    if (critical) {
      this._logCriticalExemption('equip', reason);
    } else {
      await this._delayForReaction({ reason, signal, action: 'equip', bot });
      await this._waitForClickCadence(signal, { action: 'equip', reason });
    }
    this.logger?.debug?.('humanize.equip', {
      reason,
      critical,
      item: item?.name ?? null,
      destination,
    });
    return bot.equip(item, destination);
  }

  async activateItem(bot, {
    reason = 'activateItem',
    critical = false,
    signal = null,
    offHand = undefined,
    authorize = null,
    worldAction = null,
  } = {}) {
    if (!this.enabled) {
      assertWorldActionAuthorized(authorize, 'activateItem');
      return activateBotItem(bot, offHand, worldAction);
    }
    if (critical) {
      this._logCriticalExemption('activateItem', reason);
    } else {
      await this._delayForReaction({ reason, signal, action: 'activateItem', bot });
      await this._waitForClickCadence(signal, { action: 'activateItem', reason });
    }
    this.logger?.debug?.('humanize.activate-item', { reason, critical, offHand: offHand ?? null });
    assertWorldActionAuthorized(authorize, 'activateItem');
    return activateBotItem(bot, offHand, worldAction);
  }

  async deactivateItem(bot, {
    reason = 'deactivateItem',
    critical = false,
    signal = null,
  } = {}) {
    if (!this.enabled) return bot.deactivateItem();
    if (critical) {
      this._logCriticalExemption('deactivateItem', reason);
    } else {
      await this._waitForClickCadence(signal, { action: 'deactivateItem', reason });
    }
    this.logger?.debug?.('humanize.deactivate-item', { reason, critical });
    return bot.deactivateItem();
  }

  async consumeHeldItem(bot, {
    reason = 'consume',
    critical = false,
    signal = null,
  } = {}) {
    if (!this.enabled) return bot.consume();
    if (critical) {
      this._logCriticalExemption('consume', reason);
    } else {
      await this._delayForReaction({ reason, signal, action: 'consume', bot });
      await this._waitForClickCadence(signal, { action: 'consume', reason });
    }
    this.logger?.debug?.('humanize.consume', { reason, critical });
    return bot.consume();
  }

  setControlState(bot, control, value, {
    reason = 'setControlState',
    critical = false,
  } = {}) {
    if (!this.enabled) return bot.setControlState(control, value);
    validateControlState(control, value);
    if (critical) this._logCriticalExemption('control', reason);
    else this._markControlCadence(control, value, reason);
    this.logger?.debug?.('humanize.control-state', {
      reason,
      critical,
      control,
      value: value === true,
    });
    return bot.setControlState(control, value);
  }

  async collectBlock(bot, target, collectOptions = {}, {
    reason = 'collectBlock.collect',
    critical = false,
    signal = null,
    apply = null,
  } = {}) {
    const collect = typeof apply === 'function'
      ? apply
      : () => bot.collectBlock.collect(target, collectOptions);
    if (!this.enabled) return collect();
    if (critical) {
      this._logCriticalExemption('collectBlock', reason);
    } else {
      await this._delayForReaction({ reason, signal, action: 'collectBlock', bot });
      await this._waitForClickCadence(signal, { action: 'collectBlock', reason });
    }
    this.logger?.debug?.('humanize.collect-block', {
      reason,
      critical,
      block: target?.name ?? null,
      position: positionRecord(target?.position),
    });
    return collect();
  }

  async betweenActions(bot, {
    reason = 'executor.between-actions',
    previousSkill = null,
    nextSkill = null,
    signal = null,
  } = {}) {
    if (!this.enabled || this.options.interActionVariationEnabled !== true) {
      return { ok: true, skipped: true, reason: 'inter-action variation disabled' };
    }
    if (isReactivePriorityActive(bot)) {
      return { ok: true, skipped: true, reason: 'reactive priority active' };
    }

    const plan = this._sampleInterActionPlan(bot, { reason, previousSkill, nextSkill });
    this.logger?.info?.('humanize.inter-action', planForLog(plan));

    if (plan.delayMs > 0) {
      await sleepUntilResponsive(plan.delayMs, signal, () => isReactivePriorityActive(bot));
    }
    if (signal?.aborted || isReactivePriorityActive(bot)) {
      return { ok: true, skipped: true, reason: 'reactive priority became active', plan };
    }
    if (plan.lookAround && canLookAround(bot)) {
      const target = idleSceneryTarget(bot, this._nextRandom());
      await this.lookAt(bot, target, {
        force: true,
        reason: `${reason}.look-around`,
        signal,
      });
    }
    if (signal?.aborted || isReactivePriorityActive(bot)) {
      return { ok: true, skipped: true, reason: 'reactive priority became active', plan };
    }
    if (plan.microReposition && canMicroReposition(bot)) {
      await this._performMicroReposition(bot, plan, { reason, signal });
    }
    return { ok: true, plan };
  }

  startPvpAttack(bot, entity, {
    reason = 'pvp.attack',
    critical = false,
  } = {}) {
    if (!this.enabled) return bot.pvp.attack(entity);
    validateReachFromBot(bot, entity?.position, this.options.attackReach, 'attack');
    if (critical) this._logCriticalExemption('attack', reason);
    else this._markClick('attack', reason);
    this.logger?.debug?.('humanize.attack-start', {
      reason,
      critical,
      entity: entity?.name ?? null,
      entityId: entity?.id ?? null,
    });
    return bot.pvp.attack(entity);
  }

  setPathfinderGoal({
    bot = null,
    goal,
    dynamic = false,
    apply,
    applyGoal,
    reason = 'pathfinder.setGoal',
  } = {}) {
    if (typeof apply !== 'function' && typeof applyGoal !== 'function') {
      throw new Error('humanizer setPathfinderGoal requires apply function');
    }
    if (!this.enabled) {
      if (typeof applyGoal === 'function') return applyGoal(goal, dynamic);
      return apply();
    }
    const plan = this.planPathfinderGoal(bot, { goal, dynamic, reason });
    this.logger?.debug?.('humanize.pathfinder-goal', {
      reason,
      dynamic: dynamic === true,
      goal: summarizePathGoal(goal),
      plannedGoal: summarizePathGoal(plan.goal),
      movementEntropy: plan.entropy,
      hasGoal: !!goal,
    });
    if (typeof applyGoal === 'function') return applyGoal(plan.goal, plan.dynamic);
    return apply();
  }

  planPathfinderGoal(bot, { goal, dynamic = false, reason = 'pathfinder.setGoal' } = {}) {
    if (!this.enabled || this.options.pathEntropyEnabled !== true) {
      return { goal, dynamic, entropy: false };
    }
    const mood = this._sampleMood('pathfinderGoal');
    return buildPathfinderEntropyPlan(bot, goal, {
      dynamic,
      reason,
      options: this.options,
      sample: this._nextRandom(),
      mood,
    });
  }

  nextIdleDelayMs() {
    if (!this.enabled || this.options.idleMicroBehaviorEnabled !== true) return null;
    const mood = this._sampleMood('idleDelay');
    const scale = moodMultiplier(mood.profile.idleDelayScale, mood.scalar);
    const min = Math.max(1, Math.round(this.options.idleMinMs * scale));
    const max = Math.max(Math.round(this.options.idleMaxMs * scale), min);
    return Math.round(min + (max - min) * this._nextRandom());
  }

  sampleIdleBehavior(bot = null) {
    const candidates = IDLE_BEHAVIORS.slice();
    const usable = candidates.filter((kind) => idleBehaviorAvailable(kind, bot));
    const pool = usable.length > 0 ? usable : ['scenery_glance'];
    const mood = this._sampleMood('idleBehavior');
    const index = weightedIdleIndex(pool, mood.profile.idleWeights, this._nextRandom());
    return {
      kind: pool[index],
      mood: mood.mood,
      moodScalar: mood.scalar,
    };
  }

  async performIdleMicroBehavior(bot, {
    reason = 'idle.micro',
    signal = null,
    behavior = null,
  } = {}) {
    if (!this.enabled || this.options.idleMicroBehaviorEnabled !== true) {
      return { ok: false, skipped: true, reason: 'humanization idle micro-behaviors disabled' };
    }
    let plan = behavior
      ? { kind: normalizeIdleBehavior(behavior), mood: this.options.mood, moodScalar: this.moodState().scalar }
      : this.sampleIdleBehavior(bot);
    if (!idleBehaviorAvailable(plan.kind, bot)) {
      plan = {
        kind: 'scenery_glance',
        mood: plan.mood || this.options.mood,
        moodScalar: plan.moodScalar ?? this.moodState().scalar,
        fallbackFrom: plan.kind,
      };
    }
    this.logger?.info?.('humanize.idle-start', {
      reason,
      behavior: plan.kind,
      mood: plan.mood,
      moodScalar: plan.moodScalar ?? this.moodState().scalar,
    });
    const result = await runIdleBehavior(this, bot, plan, { reason, signal });
    this.logger?.info?.('humanize.idle-done', {
      reason,
      behavior: plan.kind,
      mood: plan.mood,
      moodScalar: plan.moodScalar ?? this.moodState().scalar,
      ...result,
    });
    return { ok: true, behavior: plan.kind, mood: plan.mood, moodScalar: plan.moodScalar, ...result };
  }

  reactionDelayMs({ critical = false, action = 'reaction' } = {}) {
    if (critical) return this.options.criticalReactionMs;
    const baseMs = deterministicReactionDelayMs({
      sample: this._nextRandom(),
      medianMs: this.options.reactionMedianMs,
      p95Ms: this.options.reactionP95Ms,
    });
    const mood = this._sampleMood(action);
    const scale = moodMultiplier(mood.profile.reactionScale, mood.scalar);
    const jitterMs = this._cadenceJitterMs(mood);
    return Math.max(0, Math.round(baseMs * scale + jitterMs));
  }

  _markClick(action, reason) {
    const now = Date.now();
    const cadence = this._clickCadencePlan(action, reason, now);
    const nextAt = nextClickAt(this._lastClickAtMs, now, cadence.intervalMs);
    this._lastClickAtMs = nextAt;
    this.logger?.info?.('humanize.cadence', {
      action,
      reason,
      kind: 'click',
      requestedAtMs: now,
      scheduledAtMs: nextAt,
      intervalMs: cadence.intervalMs,
      jitterMs: cadence.jitterMs,
      mood: cadence.mood.mood,
      moodScalar: cadence.mood.scalar,
    });
    return nextAt;
  }

  async _waitForClickCadence(signal, { action = 'click', reason = 'click' } = {}) {
    const now = Date.now();
    const cadence = this._clickCadencePlan(action, reason, now);
    const nextAt = nextClickAt(this._lastClickAtMs, now, cadence.intervalMs);
    this._lastClickAtMs = nextAt;
    this.logger?.info?.('humanize.cadence', {
      action,
      reason,
      kind: 'click',
      requestedAtMs: now,
      scheduledAtMs: nextAt,
      intervalMs: cadence.intervalMs,
      jitterMs: cadence.jitterMs,
      mood: cadence.mood.mood,
      moodScalar: cadence.mood.scalar,
    });
    await sleep(Math.max(0, nextAt - now), signal);
  }

  async _delayForReaction({ reason, signal, action = 'reaction', bot = null }) {
    if (isReactivePriorityActive(bot)) {
      this.logger?.info?.('humanize.reaction-skip', { reason, action, skipped: 'reactive priority active' });
      return;
    }
    const delayMs = this.reactionDelayMs({ action });
    this.logger?.info?.('humanize.reaction-delay', {
      reason,
      action,
      delayMs,
      mood: this.options.mood,
      moodScalar: this.moodState().scalar,
    });
    await sleep(delayMs, signal);
  }

  _markControlCadence(control, value, reason) {
    const now = Date.now();
    const mood = this._sampleMood(`control.${control}`);
    const elapsedMs = this._lastControlCadenceAtMs > 0 ? now - this._lastControlCadenceAtMs : null;
    this._lastControlCadenceAtMs = now;
    this.logger?.info?.('humanize.cadence', {
      action: 'setControlState',
      reason,
      kind: 'control',
      control,
      value: value === true,
      elapsedMs,
      mood: mood.mood,
      moodScalar: mood.scalar,
    });
  }

  _clickCadencePlan(action, reason, now = Date.now()) {
    const mood = this._sampleMood(action);
    const jitterMs = Math.max(0, Math.round(this._nextRandom() * this.options.cadenceJitterMs
      * moodMultiplier(mood.profile.cadenceScale, mood.scalar)));
    return {
      action,
      reason,
      requestedAtMs: now,
      intervalMs: Math.max(this.options.clickMinIntervalMs, this.options.clickMinIntervalMs + jitterMs),
      jitterMs,
      mood,
    };
  }

  _cadenceJitterMs(mood) {
    const span = this.options.cadenceJitterMs * moodMultiplier(mood.profile.cadenceScale, mood.scalar);
    return Math.round((this._nextRandom() - 0.5) * span * 2);
  }

  _sampleInterActionPlan(bot, { reason, previousSkill, nextSkill }) {
    const mood = this._sampleMood('interAction');
    const scale = moodMultiplier(mood.profile.interActionScale, mood.scalar);
    const min = Math.max(0, Math.round(this.options.interActionMinMs * scale));
    const max = Math.max(min, Math.round(this.options.interActionMaxMs * scale));
    const lookChance = clamp(
      this.options.interActionLookChance * moodMultiplier(mood.profile.lookChanceScale, mood.scalar),
      0,
      1,
    );
    const repositionChance = clamp(
      this.options.interActionMicroRepositionChance * moodMultiplier(mood.profile.repositionChanceScale, mood.scalar),
      0,
      1,
    );
    const microReposition = this._nextRandom() < repositionChance && canMicroReposition(bot);
    const direction = chooseMicroRepositionDirection(this._nextRandom());
    return {
      reason,
      previousSkill,
      nextSkill,
      mood: mood.mood,
      moodScalar: mood.scalar,
      delayMs: Math.round(min + (max - min) * this._nextRandom()),
      lookAround: this._nextRandom() < lookChance && canLookAround(bot),
      microReposition,
      direction,
      durationMs: Math.max(1, Math.round(this.options.interActionMicroRepositionMs * scale)),
      lookChance: roundTo(lookChance, 3),
      repositionChance: roundTo(repositionChance, 3),
    };
  }

  async _performMicroReposition(bot, plan, { reason, signal }) {
    if (!canMicroReposition(bot)) return false;
    const direction = plan.direction || 'left';
    validateControlState(direction, true);
    this.logger?.info?.('humanize.micro-reposition', {
      reason,
      direction,
      durationMs: plan.durationMs,
      mood: plan.mood,
      moodScalar: plan.moodScalar,
    });
    bot.setControlState(direction, true);
    try {
      await sleepUntilResponsive(plan.durationMs, signal, () => isReactivePriorityActive(bot));
    } finally {
      try {
        bot.setControlState(direction, false);
      } catch (err) {
        this.logger?.warn?.('humanize.micro-reposition-clear-error', { err: err?.message || String(err) });
      }
    }
    return true;
  }

  _sampleMood(reason) {
    const before = this._moodScalar;
    this._actionSeq += 1;
    if (this._actionSeq % 12 === 0) this._moodTarget = this._nextRandom();
    const driftStep = this.options.moodDriftStep;
    const directional = clamp(this._moodTarget - this._moodScalar, -driftStep, driftStep);
    const wobble = (this._nextRandom() - 0.5) * driftStep * 0.4;
    this._moodScalar = clamp(this._moodScalar + directional + wobble, 0, 1);
    const mood = {
      mood: this.options.mood,
      scalar: roundTo(this._moodScalar, 3),
      profile: moodProfile(this.options.mood),
    };
    if (this._actionSeq - this._lastMoodLogAtSeq >= 4 || Math.abs(before - this._moodScalar) >= driftStep * 0.9) {
      this._lastMoodLogAtSeq = this._actionSeq;
      this.logger?.info?.('humanize.mood-drift', {
        reason,
        mood: mood.mood,
        scalar: mood.scalar,
        target: roundTo(this._moodTarget, 3),
        actionSeq: this._actionSeq,
      });
    }
    return mood;
  }

  _logCriticalExemption(action, reason) {
    this.logger?.info?.('humanize.critical-exempt', {
      action,
      reason,
      reactionDelayMs: this.options.criticalReactionMs,
    });
  }

  _nextRandom() {
    this._rngState = lcg(this._rngState);
    return this._rngState / 0x100000000;
  }
}

export function normalizeOptions(options = {}) {
  const merged = { ...DEFAULTS, ...(options || {}) };
  return {
    ...merged,
    enabled: merged.enabled === true,
    seed: String(merged.seed || DEFAULTS.seed),
    sessionSeed: merged.sessionSeed ? String(merged.sessionSeed) : null,
    mood: normalizeMood(merged.mood),
    aimMinMs: positiveNumber(merged.aimMinMs, DEFAULTS.aimMinMs),
    aimMaxMs: positiveNumber(merged.aimMaxMs, DEFAULTS.aimMaxMs),
    aimFrameMs: positiveNumber(merged.aimFrameMs, DEFAULTS.aimFrameMs),
    aimJitterDegrees: nonNegativeNumber(merged.aimJitterDegrees, DEFAULTS.aimJitterDegrees),
    maxRotationDegreesPerSecond: positiveNumber(
      merged.maxRotationDegreesPerSecond,
      DEFAULTS.maxRotationDegreesPerSecond,
    ),
    maxRotationDegreesPerTick: positiveNumber(
      merged.maxRotationDegreesPerTick,
      DEFAULTS.maxRotationDegreesPerTick,
    ),
    reactionMedianMs: positiveNumber(merged.reactionMedianMs, DEFAULTS.reactionMedianMs),
    reactionP95Ms: positiveNumber(merged.reactionP95Ms, DEFAULTS.reactionP95Ms),
    criticalReactionMs: nonNegativeNumber(merged.criticalReactionMs, DEFAULTS.criticalReactionMs),
    clickMinIntervalMs: positiveNumber(merged.clickMinIntervalMs, DEFAULTS.clickMinIntervalMs),
    cadenceJitterMs: nonNegativeNumber(merged.cadenceJitterMs, DEFAULTS.cadenceJitterMs),
    attackReach: positiveNumber(merged.attackReach, DEFAULTS.attackReach),
    interactReach: positiveNumber(merged.interactReach, DEFAULTS.interactReach),
    moodDriftStep: nonNegativeNumber(merged.moodDriftStep, DEFAULTS.moodDriftStep),
    interActionVariationEnabled: merged.interActionVariationEnabled !== false,
    interActionMinMs: nonNegativeNumber(merged.interActionMinMs, DEFAULTS.interActionMinMs),
    interActionMaxMs: nonNegativeNumber(merged.interActionMaxMs, DEFAULTS.interActionMaxMs),
    interActionLookChance: probabilityNumber(merged.interActionLookChance, DEFAULTS.interActionLookChance),
    interActionMicroRepositionChance: probabilityNumber(
      merged.interActionMicroRepositionChance,
      DEFAULTS.interActionMicroRepositionChance,
    ),
    interActionMicroRepositionMs: positiveNumber(
      merged.interActionMicroRepositionMs,
      DEFAULTS.interActionMicroRepositionMs,
    ),
    maxWalkBlocksPerSecond: positiveNumber(
      merged.maxWalkBlocksPerSecond,
      DEFAULTS.maxWalkBlocksPerSecond,
    ),
    maxSprintBlocksPerSecond: positiveNumber(
      merged.maxSprintBlocksPerSecond,
      DEFAULTS.maxSprintBlocksPerSecond,
    ),
    jumpInitialVelocity: positiveNumber(merged.jumpInitialVelocity, DEFAULTS.jumpInitialVelocity),
    jumpGravityPerTick: positiveNumber(merged.jumpGravityPerTick, DEFAULTS.jumpGravityPerTick),
    jumpVelocityTolerance: nonNegativeNumber(merged.jumpVelocityTolerance, DEFAULTS.jumpVelocityTolerance),
    idleMicroBehaviorEnabled: merged.idleMicroBehaviorEnabled !== false,
    idleMinMs: positiveNumber(merged.idleMinMs, DEFAULTS.idleMinMs),
    idleMaxMs: positiveNumber(merged.idleMaxMs, DEFAULTS.idleMaxMs),
    idleHopMs: positiveNumber(merged.idleHopMs, DEFAULTS.idleHopMs),
    idleInventoryFlipMs: positiveNumber(merged.idleInventoryFlipMs, DEFAULTS.idleInventoryFlipMs),
    pathEntropyEnabled: merged.pathEntropyEnabled !== false,
    pathEntropyMaxOffsetBlocks: positiveNumber(
      merged.pathEntropyMaxOffsetBlocks,
      DEFAULTS.pathEntropyMaxOffsetBlocks,
    ),
    pathEntropyMinRange: positiveNumber(merged.pathEntropyMinRange, DEFAULTS.pathEntropyMinRange),
  };
}

export function buildAimPlanForBot(bot, target, options = {}) {
  const normalized = normalizeOptions(options);
  const origin = bot?.entity?.position || { x: 0, y: 0, z: 0 };
  const fromYaw = radiansToDegrees(finiteNumber(bot?.entity?.yaw, 0));
  const fromPitch = radiansToDegrees(finiteNumber(bot?.entity?.pitch, 0));
  const targetAngles = targetYawPitch(origin, target, bot?.entity?.height ?? 1.62);
  return buildAimPlan({
    fromYaw,
    fromPitch,
    toYaw: targetAngles.yaw,
    toPitch: targetAngles.pitch,
    options: normalized,
  });
}

export function buildAimPlan({
  fromYaw,
  fromPitch,
  toYaw,
  toPitch,
  options = {},
} = {}) {
  const normalized = normalizeOptions(options);
  const yawDelta = shortestAngleDelta(degrees(fromYaw), degrees(toYaw));
  const pitchDelta = clamp(degrees(toPitch) - degrees(fromPitch), -180, 180);
  const totalDegrees = Math.hypot(yawDelta, pitchDelta);
  const maxPerFrame = Math.min(
    normalized.maxRotationDegreesPerTick,
    normalized.maxRotationDegreesPerSecond * (normalized.aimFrameMs / 1000),
  );
  const estimatedPathDegrees = estimateAimPathDegrees(totalDegrees, normalized.aimJitterDegrees);
  const durationForRate = totalDegrees === 0
    ? normalized.aimMinMs
    : Math.ceil((estimatedPathDegrees / normalized.maxRotationDegreesPerSecond) * 1000);
  const durationForFrames = totalDegrees === 0
    ? normalized.aimMinMs
    : Math.ceil(estimatedPathDegrees / maxPerFrame) * normalized.aimFrameMs;
  const requestedDurationMs = Math.max(normalized.aimMinMs, durationForRate, durationForFrames);
  const durationMs = Math.max(requestedDurationMs, 1);
  const frameCount = Math.max(1, Math.ceil(durationMs / normalized.aimFrameMs));
  const directionLength = Math.max(totalDegrees, 1);
  const dirYaw = yawDelta / directionLength;
  const dirPitch = pitchDelta / directionLength;
  const sideYaw = -dirPitch;
  const sidePitch = dirYaw;
  const frames = [];
  for (let i = 1; i <= frameCount; i += 1) {
    const progress = i / frameCount;
    const curved = aimProgressCurve(progress);
    const correction = aimMicroCorrection(progress, totalDegrees, normalized);
    const yaw = i === frameCount
      ? degrees(fromYaw) + yawDelta
      : degrees(fromYaw) + yawDelta * curved + dirYaw * correction.along + sideYaw * correction.side;
    const pitch = i === frameCount
      ? degrees(fromPitch) + pitchDelta
      : degrees(fromPitch) + pitchDelta * curved + dirPitch * correction.along + sidePitch * correction.side;
    frames.push({
      atMs: Math.round(durationMs * progress),
      yaw: wrapDegrees(yaw),
      pitch: clamp(pitch, -90, 90),
    });
  }
  return {
    kind: 'aim',
    curve: 'smoothstep-micro-correction',
    fromYaw: wrapDegrees(degrees(fromYaw)),
    fromPitch: clamp(degrees(fromPitch), -90, 90),
    toYaw: wrapDegrees(degrees(fromYaw) + yawDelta),
    toPitch: clamp(degrees(fromPitch) + pitchDelta, -90, 90),
    yawDelta,
    pitchDelta,
    totalDegrees,
    estimatedPathDegrees,
    maxMicroCorrectionDegrees: Math.min(normalized.aimJitterDegrees, Math.max(0, totalDegrees * 0.04)),
    durationMs,
    frameMs: normalized.aimFrameMs,
    extendedForInvariants: durationMs > normalized.aimMaxMs,
    frames,
  };
}

export function assertHumanizationInvariants(record = {}, limits = {}) {
  const options = normalizeOptions(limits);
  for (const plan of record.aimPlans || []) validateAimPlan(plan, options);
  for (const reach of record.reaches || []) {
    const limit = reach.kind === 'attack' ? options.attackReach : options.interactReach;
    if (Number(reach.distance) > limit) {
      throw new Error(`humanization ${reach.kind || 'interact'} reach ${reach.distance} exceeds ${limit}`);
    }
  }
  for (const clicks of record.clickSequences || []) validateClickSequence(clicks, options);
  for (const movement of record.movementSamples || []) validateMovementSample(movement, options);
  for (const jump of record.jumpSamples || []) validateJumpSample(jump, options);
  for (const action of record.forbiddenActions || []) {
    if (action) throw new Error(`humanization forbidden action requested: ${action}`);
  }
  return true;
}

export function validateReachFromBot(bot, target, limit, kind = 'interact') {
  const distance = distanceBetween(bot?.entity?.position, target);
  if (!Number.isFinite(distance)) throw new Error(`humanization ${kind} reach unavailable`);
  if (distance > limit) throw new Error(`humanization ${kind} reach ${round(distance)} exceeds ${limit}`);
  return { ok: true, kind, distance, limit };
}

export function nextClickAt(lastClickAtMs, requestedAtMs, minIntervalMs = DEFAULTS.clickMinIntervalMs) {
  const last = finiteNumber(lastClickAtMs, 0);
  const requested = finiteNumber(requestedAtMs, 0);
  const min = positiveNumber(minIntervalMs, DEFAULTS.clickMinIntervalMs);
  return Math.max(requested, last + min);
}

export function deterministicReactionDelayMs({
  sample = 0.5,
  medianMs = DEFAULTS.reactionMedianMs,
  p95Ms = DEFAULTS.reactionP95Ms,
} = {}) {
  const median = positiveNumber(medianMs, DEFAULTS.reactionMedianMs);
  const p95 = Math.max(positiveNumber(p95Ms, DEFAULTS.reactionP95Ms), median);
  const safeSample = clamp(Number.isFinite(Number(sample)) ? Number(sample) : 0.5, 0.001, 0.999);
  const curved = Math.pow(safeSample, 1.85);
  return Math.round(median + (p95 - median) * curved);
}

function validateAimPlan(plan, options) {
  let prev = { yaw: plan.fromYaw, pitch: plan.fromPitch, atMs: 0 };
  for (const frame of plan.frames || []) {
    const delta = Math.hypot(shortestAngleDelta(prev.yaw, frame.yaw), frame.pitch - prev.pitch);
    const elapsedMs = Math.max(1, frame.atMs - prev.atMs);
    const rate = delta / (elapsedMs / 1000);
    if (delta > options.maxRotationDegreesPerTick + 1e-6) {
      throw new Error(`humanization rotation ${round(delta)}deg exceeds ${options.maxRotationDegreesPerTick}deg/tick`);
    }
    if (rate > options.maxRotationDegreesPerSecond + 1e-6) {
      throw new Error(`humanization rotation ${round(rate)}deg/s exceeds ${options.maxRotationDegreesPerSecond}deg/s`);
    }
    if (Math.abs(frame.pitch) > 90) {
      throw new Error(`humanization pitch ${round(frame.pitch)} outside vanilla pitch range`);
    }
    prev = frame;
  }
}

function validateClickSequence(clicks, options) {
  let prev = null;
  for (const atMs of clicks) {
    if (prev !== null && atMs - prev < options.clickMinIntervalMs) {
      throw new Error(`humanization click interval ${atMs - prev}ms below ${options.clickMinIntervalMs}ms`);
    }
    prev = atMs;
  }
}

function validateControlState(control, value) {
  if (!CONTROL_STATES.has(control)) {
    throw new Error(`humanization unknown movement control "${control}"`);
  }
  if (typeof value !== 'boolean') {
    throw new Error(`humanization movement control ${control} value must be boolean`);
  }
}

function validateMovementSample(sample, options) {
  const elapsedMs = positiveNumber(sample?.elapsedMs, 0);
  const horizontal = Number.isFinite(Number(sample?.horizontalDistance))
    ? Number(sample.horizontalDistance)
    : horizontalDistance(sample?.from, sample?.to);
  if (!Number.isFinite(horizontal)) throw new Error('humanization movement distance unavailable');
  const blocksPerSecond = horizontal / (elapsedMs / 1000);
  const limit = sample?.sprinting === true
    ? options.maxSprintBlocksPerSecond
    : options.maxWalkBlocksPerSecond;
  if (blocksPerSecond > limit + 1e-6) {
    const mode = sample?.sprinting === true ? 'sprint' : 'walk';
    throw new Error(`humanization ${mode} speed ${round(blocksPerSecond)} blocks/s exceeds ${limit}`);
  }
}

function validateJumpSample(sample, options) {
  const velocities = Array.isArray(sample?.velocityYByTick) ? sample.velocityYByTick : [];
  if (velocities.length === 0) throw new Error('humanization jump sample has no vertical velocities');
  const initial = Number(velocities[0]);
  if (!Number.isFinite(initial)) throw new Error('humanization jump initial velocity unavailable');
  if (Math.abs(initial - options.jumpInitialVelocity) > options.jumpVelocityTolerance) {
    throw new Error(
      `humanization jump initial velocity ${round(initial)} differs from ${options.jumpInitialVelocity}`,
    );
  }
  for (let i = 1; i < velocities.length; i += 1) {
    const previous = Number(velocities[i - 1]);
    const current = Number(velocities[i]);
    if (![previous, current].every(Number.isFinite)) throw new Error('humanization jump velocity unavailable');
    const expected = previous - options.jumpGravityPerTick;
    if (Math.abs(current - expected) > options.jumpVelocityTolerance) {
      throw new Error(
        `humanization jump gravity step ${round(previous - current)} differs from ${options.jumpGravityPerTick}`,
      );
    }
  }
}

function buildPathfinderEntropyPlan(bot, goal, { dynamic = false, reason = '', options, sample = 0.5, mood = null } = {}) {
  const ineligible = (why) => ({ goal, dynamic, entropy: { kind: 'none', reason: why } });
  if (dynamic === true) return ineligible('dynamic goal');
  if (!isStaticGoalNear(goal)) return ineligible('not static GoalNear');
  if (isSurvivalPathReason(reason)) return ineligible('survival path');
  const range = Math.sqrt(Number(goal.rangeSq));
  if (!Number.isFinite(range) || range < options.pathEntropyMinRange) {
    return ineligible('range below path entropy minimum');
  }
  const offsetBlocks = Math.max(0, Math.floor(options.pathEntropyMaxOffsetBlocks));
  if (offsetBlocks <= 0) return ineligible('path entropy offset disabled');
  const offset = choosePathEntropyOffset(bot?.entity?.position, goal, offsetBlocks, sample);
  if (offset.x === 0 && offset.z === 0) return ineligible('zero path entropy offset');
  const bias = {
    x: goal.x + offset.x,
    y: goal.y,
    z: goal.z + offset.z,
  };
  const plannedGoal = new HumanizedHeuristicGoal(goal, bias, {
    kind: 'near_goal_lane_bias',
    offset,
    range,
  });
  return {
    goal: plannedGoal,
    dynamic,
    entropy: {
      ...plannedGoal.humanized,
      mood: mood?.mood || options.mood,
      moodScalar: mood?.scalar ?? null,
      pathEntropyScale: mood?.profile?.pathEntropyScale ?? 1,
    },
  };
}

class HumanizedHeuristicGoal {
  constructor(goal, bias, humanized) {
    this.goal = goal;
    this.x = goal.x;
    this.y = goal.y;
    this.z = goal.z;
    this.rangeSq = goal.rangeSq;
    this.bias = bias;
    this.humanized = {
      ...humanized,
      original: { x: goal.x, y: goal.y, z: goal.z },
      bias,
    };
  }

  heuristic(node) {
    const original = this.goal.heuristic(node);
    const biased = pathfinderDistanceXZ(this.bias.x - node.x, this.bias.z - node.z)
      + Math.abs(this.bias.y - node.y);
    return Math.min(original, biased);
  }

  isEnd(node) {
    return this.goal.isEnd(node);
  }

  hasChanged() {
    return typeof this.goal.hasChanged === 'function' ? this.goal.hasChanged() : false;
  }

  isValid() {
    return typeof this.goal.isValid === 'function' ? this.goal.isValid() : true;
  }
}

function isStaticGoalNear(goal) {
  return goal?.constructor?.name === 'GoalNear'
    && typeof goal.heuristic === 'function'
    && typeof goal.isEnd === 'function'
    && Number.isFinite(Number(goal.x))
    && Number.isFinite(Number(goal.y))
    && Number.isFinite(Number(goal.z))
    && Number.isFinite(Number(goal.rangeSq));
}

function isSurvivalPathReason(reason) {
  const value = String(reason || '').toLowerCase();
  return value.includes('reactive')
    || value.includes('flee')
    || value.includes('hazard')
    || value.includes('water_escape')
    || value.includes('death_recovery');
}

function choosePathEntropyOffset(position, goal, offsetBlocks, sample = 0.5) {
  const offset = Math.max(0, Math.floor(offsetBlocks));
  if (offset <= 0) return { x: 0, z: 0 };
  const sign = sample < 0.5 ? -1 : 1;
  const dx = Number(goal.x) - Number(position?.x);
  const dz = Number(goal.z) - Number(position?.z);
  if (Number.isFinite(dx) && Number.isFinite(dz) && Math.hypot(dx, dz) > 0.1) {
    if (Math.abs(dx) >= Math.abs(dz)) return { x: 0, z: sign * offset };
    return { x: sign * offset, z: 0 };
  }
  const choices = [
    { x: offset, z: 0 },
    { x: -offset, z: 0 },
    { x: 0, z: offset },
    { x: 0, z: -offset },
  ];
  const index = Math.min(choices.length - 1, Math.floor(clamp(sample, 0, 0.999) * choices.length));
  return choices[index];
}

function pathfinderDistanceXZ(dx, dz) {
  const x = Math.abs(Number(dx));
  const z = Math.abs(Number(dz));
  return Math.abs(x - z) + Math.min(x, z) * Math.SQRT2;
}

function estimateAimPathDegrees(totalDegrees, jitterDegrees) {
  if (totalDegrees <= 0) return 0;
  const correctionBudget = Math.min(nonNegativeNumber(jitterDegrees, 0), totalDegrees * 0.04);
  return totalDegrees * 1.85 + correctionBudget * 6;
}

function aimProgressCurve(progress) {
  const t = clamp(progress, 0, 1);
  return t * t * (3 - 2 * t);
}

function aimMicroCorrection(progress, totalDegrees, options) {
  if (progress <= 0 || progress >= 1 || totalDegrees <= 0) return { along: 0, side: 0 };
  const maxCorrection = Math.min(options.aimJitterDegrees, Math.max(0, totalDegrees * 0.04));
  if (maxCorrection <= 0) return { along: 0, side: 0 };

  const wave = Math.sin(Math.PI * progress);
  const side = maxCorrection * 0.45 * wave * Math.sin(2 * Math.PI * progress);
  const lateCorrection = aimProgressCurve(clamp((progress - 0.58) / 0.42, 0, 1));
  const along = maxCorrection * 0.7 * wave * lateCorrection;
  return { along, side };
}

async function runIdleBehavior(humanizer, bot, plan, { reason, signal }) {
  if (plan.kind === 'look_at_sky') {
    await humanizer.lookAt(bot, idleLookAtSkyTarget(bot), {
      force: true,
      reason: `${reason}.look_at_sky`,
      signal,
    });
    return { target: 'sky' };
  }
  if (plan.kind === 'hop_in_place') {
    humanizer.setControlState(bot, 'jump', true, { reason: `${reason}.hop`, critical: false });
    try {
      await sleep(humanizer.options.idleHopMs, signal);
    } finally {
      humanizer.setControlState(bot, 'jump', false, { reason: `${reason}.hop.clear`, critical: false });
    }
    return { durationMs: humanizer.options.idleHopMs };
  }
  if (plan.kind === 'inventory_flip') {
    return runInventoryFlip(humanizer, bot, { reason, signal });
  }
  const target = idleSceneryTarget(bot, humanizer._nextRandom());
  await humanizer.lookAt(bot, target, {
    force: true,
    reason: `${reason}.scenery_glance`,
    signal,
  });
  return { target: positionRecord(target) };
}

async function runInventoryFlip(humanizer, bot, { reason, signal }) {
  const currentSlot = Number.isInteger(bot?.quickBarSlot) ? bot.quickBarSlot : 0;
  const nextSlot = (currentSlot + 1 + Math.floor(humanizer._nextRandom() * 8)) % 9;
  bot.setQuickBarSlot(nextSlot);
  humanizer.logger?.debug?.('humanize.idle-inventory-flip', {
    reason,
    fromSlot: currentSlot,
    toSlot: nextSlot,
  });
  try {
    await sleep(humanizer.options.idleInventoryFlipMs, signal);
  } finally {
    bot.setQuickBarSlot(currentSlot);
  }
  return { fromSlot: currentSlot, toSlot: nextSlot, durationMs: humanizer.options.idleInventoryFlipMs };
}

function idleLookAtSkyTarget(bot) {
  const position = bot?.entity?.position || { x: 0, y: 64, z: 0 };
  return {
    x: Number(position.x) + 4,
    y: Number(position.y) + 12,
    z: Number(position.z) + 2,
  };
}

function idleSceneryTarget(bot, sample = 0.5) {
  const position = bot?.entity?.position || { x: 0, y: 64, z: 0 };
  const angle = sample * Math.PI * 2;
  const distance = 8;
  return {
    x: Number(position.x) + Math.cos(angle) * distance,
    y: Number(position.y) + 1.5,
    z: Number(position.z) + Math.sin(angle) * distance,
  };
}

function idleBehaviorAvailable(kind, bot) {
  if (kind === 'inventory_flip') return typeof bot?.setQuickBarSlot === 'function';
  if (kind === 'hop_in_place') return typeof bot?.setControlState === 'function';
  if (kind === 'look_at_sky' || kind === 'scenery_glance') {
    return typeof bot?.lookAt === 'function' || typeof bot?.look === 'function';
  }
  return false;
}

export function isReactivePriorityActive(bot) {
  const state = bot?.reactiveController?.state;
  if (state && state !== REACTIVE_NORMAL) return true;
  try {
    if (bot?.pathfinderOwner?.currentOwner?.() === 'reactive') return true;
  } catch {
    return true;
  }
  return false;
}

function canLookAround(bot) {
  return typeof bot?.lookAt === 'function' || typeof bot?.look === 'function';
}

function canMicroReposition(bot) {
  if (typeof bot?.setControlState !== 'function') return false;
  if (isReactivePriorityActive(bot)) return false;
  try {
    if (bot?.pathfinderOwner?.isIdle && !bot.pathfinderOwner.isIdle()) return false;
  } catch {
    return false;
  }
  if (bot?.entity?.onGround === false) return false;
  if (bot?.entity?.isInWater === true) return false;
  return true;
}

function chooseMicroRepositionDirection(sample = 0.5) {
  const choices = ['left', 'right', 'back'];
  const index = Math.min(choices.length - 1, Math.floor(clamp(sample, 0, 0.999) * choices.length));
  return choices[index];
}

function weightedIdleIndex(pool, weights, sample = 0.5) {
  const values = pool.map((kind) => Math.max(0, Number(weights?.[kind] ?? 1)));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return Math.min(pool.length - 1, Math.floor(clamp(sample, 0, 0.999) * pool.length));
  let cursor = clamp(sample, 0, 0.999) * total;
  for (let i = 0; i < values.length; i += 1) {
    cursor -= values[i];
    if (cursor <= 0) return i;
  }
  return pool.length - 1;
}

function moodProfile(mood) {
  return MOOD_PROFILES[normalizeMood(mood)] || MOOD_PROFILES.efficient;
}

function moodMultiplier(targetScale, scalar) {
  return 1 + (Number(targetScale) - 1) * clamp(Number(scalar), 0, 1);
}

function planForLog(plan) {
  return {
    reason: plan.reason,
    previousSkill: plan.previousSkill,
    nextSkill: plan.nextSkill,
    mood: plan.mood,
    moodScalar: plan.moodScalar,
    delayMs: plan.delayMs,
    lookAround: plan.lookAround,
    microReposition: plan.microReposition,
    direction: plan.microReposition ? plan.direction : null,
    durationMs: plan.microReposition ? plan.durationMs : 0,
    lookChance: plan.lookChance,
    repositionChance: plan.repositionChance,
  };
}

function normalizeIdleBehavior(value) {
  const behavior = String(value || '').trim();
  if (IDLE_BEHAVIORS.includes(behavior)) return behavior;
  throw new Error(`unknown idle behavior "${behavior}"`);
}

function normalizeMood(value) {
  const mood = String(value || DEFAULTS.mood).trim().toLowerCase();
  if (['cautious', 'exploratory', 'efficient', 'social'].includes(mood)) return mood;
  return DEFAULTS.mood;
}

function activateBotItem(bot, offHand, worldAction = null) {
  if (worldAction) return bot.activateItem(offHand, { worldAction });
  if (offHand === undefined) return bot.activateItem();
  return bot.activateItem(offHand);
}

function activateBotBlock(bot, block, faceVector, cursorVector) {
  if (faceVector === undefined) return bot.activateBlock(block);
  if (cursorVector === undefined) return bot.activateBlock(block, faceVector);
  return bot.activateBlock(block, faceVector, cursorVector);
}

function digBotBlock(bot, block, forceLook, digFace) {
  if (digFace === undefined) return bot.dig(block, forceLook);
  return bot.dig(block, forceLook, digFace);
}

function assertWorldActionAuthorized(authorize, action) {
  if (typeof authorize !== 'function') return;
  const decision = authorize();
  if (decision?.ok === true) return;
  const error = new Error(`${action} denied immediately before world action: ${decision.reason || 'world action denied'}`);
  error.code = 'WORLD_ACTION_DENIED';
  throw error;
}

function placementTargetPosition(referencePosition, faceVector) {
  if (!referencePosition || !faceVector) return null;
  if (typeof referencePosition.offset === 'function') {
    return referencePosition.offset(faceVector.x || 0, faceVector.y || 0, faceVector.z || 0);
  }
  return {
    x: Number(referencePosition.x) + Number(faceVector.x || 0),
    y: Number(referencePosition.y) + Number(faceVector.y || 0),
    z: Number(referencePosition.z) + Number(faceVector.z || 0),
  };
}

function positionRecord(position) {
  if (!position) return null;
  return {
    x: Number.isFinite(Number(position.x)) ? Number(position.x) : null,
    y: Number.isFinite(Number(position.y)) ? Number(position.y) : null,
    z: Number.isFinite(Number(position.z)) ? Number(position.z) : null,
  };
}

function targetYawPitch(origin, target, eyeHeight = 1.62) {
  const dx = Number(target?.x) - Number(origin?.x);
  const dy = Number(target?.y) - (Number(origin?.y) + finiteNumber(eyeHeight, 1.62));
  const dz = Number(target?.z) - Number(origin?.z);
  const horizontal = Math.hypot(dx, dz);
  if (![dx, dy, dz, horizontal].every(Number.isFinite)) return { yaw: 0, pitch: 0 };
  return {
    yaw: wrapDegrees(Math.atan2(-dx, -dz) * DEG_PER_RAD),
    pitch: clamp(-(Math.atan2(dy, horizontal) * DEG_PER_RAD), -90, 90),
  };
}

function distanceBetween(a, b) {
  if (!a || !b) return null;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  if (![dx, dy, dz].every(Number.isFinite)) return null;
  return Math.hypot(dx, dy, dz);
}

function horizontalDistance(a, b) {
  if (!a || !b) return null;
  const dx = Number(a.x) - Number(b.x);
  const dz = Number(a.z) - Number(b.z);
  if (![dx, dz].every(Number.isFinite)) return null;
  return Math.hypot(dx, dz);
}

function summarizeAimPlan(plan, reason) {
  return {
    reason,
    durationMs: plan.durationMs,
    frames: plan.frames.length,
    totalDegrees: round(plan.totalDegrees),
    extendedForInvariants: plan.extendedForInvariants,
  };
}

function summarizePathGoal(goal) {
  if (!goal) return null;
  return {
    kind: goal.constructor?.name || null,
    x: Number.isFinite(Number(goal.x)) ? Number(goal.x) : null,
    y: Number.isFinite(Number(goal.y)) ? Number(goal.y) : null,
    z: Number.isFinite(Number(goal.z)) ? Number(goal.z) : null,
    range: Number.isFinite(Number(goal.rangeSq)) ? round(Math.sqrt(Number(goal.rangeSq))) : null,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error(signal.reason || 'humanization aborted');
}

function sleep(ms, signal = null) {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(signal.reason || 'humanization aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function sleepUntilResponsive(ms, signal = null, shouldStop = null) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    throwIfAborted(signal);
    if (typeof shouldStop === 'function' && shouldStop()) return;
    await sleep(Math.min(25, end - Date.now()), signal);
  }
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (const ch of String(seed || DEFAULTS.seed)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function lcg(value) {
  return (Math.imul(1664525, value >>> 0) + 1013904223) >>> 0;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function probabilityNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 1) : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function degrees(value) {
  return finiteNumber(value, 0);
}

function radiansToDegrees(value) {
  return value * DEG_PER_RAD;
}

function wrapDegrees(value) {
  let result = degrees(value) % 360;
  if (result <= -180) result += 360;
  if (result > 180) result -= 360;
  return result;
}

function shortestAngleDelta(from, to) {
  return wrapDegrees(degrees(to) - degrees(from));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundTo(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(Number(value) * scale) / scale;
}
