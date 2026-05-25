import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertHumanizationInvariants,
  buildAimPlan,
  createHumanizer,
  deterministicReactionDelayMs,
  isReactivePriorityActive,
  nextClickAt,
  validateReachFromBot,
} from '../../src/behavior_shaping/humanizer.js';
import pkgPathfinder from 'mineflayer-pathfinder';

const { goals: pfGoals } = pkgPathfinder;

function logger() {
  const records = [];
  return {
    records,
    debug: (evt, fields = {}) => records.push({ level: 'debug', evt, ...fields }),
    info: (evt, fields = {}) => records.push({ level: 'info', evt, ...fields }),
    warn: (evt, fields = {}) => records.push({ level: 'warn', evt, ...fields }),
    error: (evt, fields = {}) => records.push({ level: 'error', evt, ...fields }),
  };
}

test('humanized aim plans stay inside vanilla rotation invariants', () => {
  const plan = buildAimPlan({
    fromYaw: -170,
    fromPitch: 35,
    toYaw: 170,
    toPitch: -45,
  });

  assertHumanizationInvariants({ aimPlans: [plan] });
  assert.equal(plan.frames.length > 1, true);
  assert.equal(plan.extendedForInvariants, false);
  assert.equal(plan.curve, 'smoothstep-micro-correction');
  assert.ok(plan.durationMs >= 100);
  assert.ok(plan.durationMs <= 400);
});

test('humanized aim plans include bounded curved micro-correction', () => {
  const plan = buildAimPlan({
    fromYaw: 0,
    fromPitch: 0,
    toYaw: 90,
    toPitch: 0,
    options: {
      aimFrameMs: 25,
      aimJitterDegrees: 2,
    },
  });

  assertHumanizationInvariants({ aimPlans: [plan] });
  assert.equal(plan.curve, 'smoothstep-micro-correction');
  assert.equal(plan.frames.at(-1).yaw, 90);
  assert.equal(plan.frames.at(-1).pitch, 0);
  assert.ok(plan.frames.some((frame) => Math.abs(frame.pitch) > 0.01));
  assert.ok(plan.estimatedPathDegrees > plan.totalDegrees);
  assert.ok(plan.maxMicroCorrectionDegrees > 0);
});

test('humanized aim extends duration instead of violating rotation caps', () => {
  const plan = buildAimPlan({
    fromYaw: 0,
    fromPitch: 0,
    toYaw: 180,
    toPitch: 80,
    options: {
      aimMaxMs: 100,
      maxRotationDegreesPerSecond: 360,
      maxRotationDegreesPerTick: 12,
      aimFrameMs: 25,
    },
  });

  assertHumanizationInvariants({
    aimPlans: [plan],
  }, {
    maxRotationDegreesPerSecond: 360,
    maxRotationDegreesPerTick: 12,
    aimFrameMs: 25,
  });
  assert.equal(plan.extendedForInvariants, true);
  assert.ok(plan.durationMs > 100);
});

test('humanization invariant rejects impossible click cadence and reach', () => {
  assert.equal(nextClickAt(1000, 1010, 70), 1070);
  assert.equal(nextClickAt(1000, 1200, 70), 1200);

  assert.throws(
    () => assertHumanizationInvariants({ clickSequences: [[0, 69]] }),
    /click interval 69ms below 70ms/,
  );
  assert.throws(
    () => assertHumanizationInvariants({ reaches: [{ kind: 'attack', distance: 4.51 }] }),
    /attack reach 4\.51 exceeds 4\.5/,
  );
});

test('humanization invariant rejects impossible movement speed and jump physics', () => {
  assertHumanizationInvariants({
    movementSamples: [
      { horizontalDistance: 0.21, elapsedMs: 50, sprinting: false },
      { horizontalDistance: 0.28, elapsedMs: 50, sprinting: true },
    ],
    jumpSamples: [
      { velocityYByTick: [0.42, 0.34, 0.26, 0.18] },
    ],
  });

  assert.throws(
    () => assertHumanizationInvariants({
      movementSamples: [{ horizontalDistance: 0.35, elapsedMs: 50, sprinting: false }],
    }),
    /walk speed 7 blocks\/s exceeds 4\.4/,
  );
  assert.throws(
    () => assertHumanizationInvariants({
      movementSamples: [{ from: { x: 0, z: 0 }, to: { x: 0.4, z: 0 }, elapsedMs: 50, sprinting: true }],
    }),
    /sprint speed 8 blocks\/s exceeds 5\.7/,
  );
  assert.throws(
    () => assertHumanizationInvariants({
      jumpSamples: [{ velocityYByTick: [0.7, 0.62] }],
    }),
    /jump initial velocity 0\.7 differs from 0\.42/,
  );
  assert.throws(
    () => assertHumanizationInvariants({
      jumpSamples: [{ velocityYByTick: [0.42, 0.41] }],
    }),
    /jump gravity step 0\.01 differs from 0\.08/,
  );
  assert.throws(
    () => assertHumanizationInvariants({ forbiddenActions: ['NoFall'] }),
    /forbidden action requested: NoFall/,
  );
});

test('reaction delays are bounded and critical reactions are explicitly exempted', () => {
  assert.equal(deterministicReactionDelayMs({ sample: 0 }), 250);
  assert.equal(deterministicReactionDelayMs({ sample: 1 }), 500);

  const humanizer = createHumanizer({ enabled: true }, logger());
  assert.equal(humanizer.reactionDelayMs({ critical: true }), 0);
});

test('disabled humanizer passes through Mineflayer actions without delay logic', async () => {
  const calls = [];
  const humanizer = createHumanizer({ enabled: false }, logger());
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    lookAt: async (target, force) => calls.push(['lookAt', target, force]),
    placeBlock: async (block, face) => calls.push(['placeBlock', block.name, face.y]),
    dig: async (block, forceLook) => calls.push(['dig', block.name, forceLook]),
    activateBlock: async (block) => calls.push(['activateBlock', block.name]),
    equip: async (item, destination) => calls.push(['equip', item.name, destination]),
    activateItem: (offHand) => calls.push(['activateItem', offHand ?? null]),
    deactivateItem: () => calls.push(['deactivateItem']),
    consume: () => calls.push(['consume']),
    setControlState: (control, value) => calls.push(['control', control, value]),
    collectBlock: {
      collect: (target, opts) => calls.push(['collectBlock', target.name, opts.ignoreNoPath]),
    },
    pvp: { attack: (entity) => calls.push(['attack', entity.name]) },
  };

  await humanizer.lookAt(bot, { x: 1, y: 65, z: 1 });
  await humanizer.placeBlock(bot, { name: 'stone', position: { x: 1, y: 64, z: 0 } }, { y: 1 });
  await humanizer.digBlock(bot, { name: 'dirt', position: { x: 1, y: 64, z: 0 } });
  await humanizer.activateBlock(bot, { name: 'chest', position: { x: 1, y: 64, z: 0 } });
  await humanizer.equipItem(bot, { name: 'iron_sword' }, 'hand');
  await humanizer.activateItem(bot, { offHand: true });
  await humanizer.deactivateItem(bot);
  await humanizer.consumeHeldItem(bot);
  humanizer.setControlState(bot, 'jump', true);
  await humanizer.collectBlock(bot, { name: 'oak_log' }, { ignoreNoPath: true });
  humanizer.startPvpAttack(bot, { name: 'zombie', position: { x: 1, y: 64, z: 0 } });

  assert.deepEqual(calls, [
    ['lookAt', { x: 1, y: 65, z: 1 }, true],
    ['placeBlock', 'stone', 1],
    ['dig', 'dirt', true],
    ['activateBlock', 'chest'],
    ['equip', 'iron_sword', 'hand'],
    ['activateItem', true],
    ['deactivateItem'],
    ['consume'],
    ['control', 'jump', true],
    ['collectBlock', 'oak_log', true],
    ['attack', 'zombie'],
  ]);
});

test('enabled humanizer fail-closes when attack or interact reach is impossible', async () => {
  const humanizer = createHumanizer({ enabled: true }, logger());
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    placeBlock: async () => {},
    dig: async () => {},
    pvp: { attack: () => {} },
  };

  assert.throws(
    () => validateReachFromBot(bot, { x: 4.6, y: 64, z: 0 }, 4.5, 'attack'),
    /attack reach 4\.6 exceeds 4\.5/,
  );
  assert.throws(
    () => humanizer.startPvpAttack(bot, { name: 'zombie', position: { x: 4.6, y: 64, z: 0 } }),
    /attack reach 4\.6 exceeds 4\.5/,
  );
  await assert.rejects(
    () => humanizer.placeBlock(bot, { position: { x: 5.1, y: 64, z: 0 } }, { y: 1 }),
    /interact reach 5\.1 exceeds 5/,
  );
  await assert.rejects(
    () => humanizer.digBlock(bot, { position: { x: 5.1, y: 64, z: 0 } }),
    /interact reach 5\.1 exceeds 5/,
  );
});

test('pathfinder humanization boundary is a pass-through chokepoint when enabled', () => {
  const log = logger();
  const humanizer = createHumanizer({ enabled: true }, log);
  let applied = 0;

  humanizer.setPathfinderGoal({
    goal: { id: 'test-goal' },
    dynamic: true,
    reason: 'offline-test',
    apply: () => { applied += 1; },
  });

  assert.equal(applied, 1);
  assert.equal(log.records.some((record) => record.evt === 'humanize.pathfinder-goal'), true);
});

test('pathfinder humanization biases eligible static GoalNear routes without changing completion', () => {
  const log = logger();
  const humanizer = createHumanizer({ enabled: true }, log);
  const originalGoal = new pfGoals.GoalNear(10, 64, 0, 2);
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
  };
  let capturedGoal = null;
  let capturedDynamic = null;

  humanizer.setPathfinderGoal({
    bot,
    goal: originalGoal,
    dynamic: false,
    reason: 'goto',
    applyGoal: (goal, dynamic) => {
      capturedGoal = goal;
      capturedDynamic = dynamic;
    },
  });

  assert.notEqual(capturedGoal, originalGoal);
  assert.equal(capturedDynamic, false);
  assert.equal(capturedGoal.isEnd({ x: 10, y: 64, z: 0 }), true);
  assert.equal(capturedGoal.isEnd({ x: 13, y: 64, z: 0 }), false);
  assert.equal(capturedGoal.humanized.kind, 'near_goal_lane_bias');
  assert.equal(Math.abs(capturedGoal.humanized.offset.x) + Math.abs(capturedGoal.humanized.offset.z), 1);
  assert.equal(log.records.some((record) => (
    record.evt === 'humanize.pathfinder-goal'
      && record.movementEntropy?.kind === 'near_goal_lane_bias'
  )), true);
});

test('enabled item-use wrappers enforce click cadence and log critical exemptions', async () => {
  const log = logger();
  const calls = [];
  const humanizer = createHumanizer({
    enabled: true,
    reactionMedianMs: 1,
    reactionP95Ms: 1,
    clickMinIntervalMs: 1,
  }, log);
  const bot = {
    activateItem: (offHand) => calls.push(['activateItem', offHand ?? null]),
    deactivateItem: () => calls.push(['deactivateItem']),
  };

  await humanizer.activateItem(bot, { reason: 'test.activate', offHand: true });
  await humanizer.deactivateItem(bot, { reason: 'test.release' });
  await humanizer.activateItem(bot, { reason: 'test.critical', critical: true });

  assert.deepEqual(calls, [
    ['activateItem', true],
    ['deactivateItem'],
    ['activateItem', null],
  ]);
  assert.equal(log.records.some((record) => record.evt === 'humanize.activate-item'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.deactivate-item'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.critical-exempt'), true);
});

test('enabled equip consume and activate-block wrappers use the action boundary', async () => {
  const log = logger();
  const calls = [];
  const humanizer = createHumanizer({
    enabled: true,
    reactionMedianMs: 1,
    reactionP95Ms: 1,
    clickMinIntervalMs: 1,
  }, log);
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    activateBlock: (block) => calls.push(['activateBlock', block.name]),
    equip: (item, destination) => calls.push(['equip', item.name, destination]),
    consume: () => calls.push(['consume']),
  };

  await humanizer.activateBlock(bot, { name: 'chest', position: { x: 1, y: 64, z: 0 } }, { reason: 'test.activate-block' });
  await humanizer.equipItem(bot, { name: 'diamond_sword' }, 'hand', { reason: 'test.equip' });
  await humanizer.consumeHeldItem(bot, { reason: 'test.consume', critical: true });

  assert.deepEqual(calls, [
    ['activateBlock', 'chest'],
    ['equip', 'diamond_sword', 'hand'],
    ['consume'],
  ]);
  assert.equal(log.records.some((record) => record.evt === 'humanize.activate-block'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.equip'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.consume'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.critical-exempt' && record.action === 'consume'), true);

  await assert.rejects(
    () => humanizer.activateBlock(bot, { name: 'chest', position: { x: 5.1, y: 64, z: 0 } }),
    /interact reach 5\.1 exceeds 5/,
  );
});

test('enabled dig wrapper uses the action boundary', async () => {
  const log = logger();
  const calls = [];
  const humanizer = createHumanizer({
    enabled: true,
    reactionMedianMs: 1,
    reactionP95Ms: 1,
    clickMinIntervalMs: 1,
  }, log);
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    dig: (block, forceLook, digFace) => calls.push(['dig', block.name, forceLook, digFace ?? null]),
  };

  await humanizer.digBlock(bot, { name: 'oak_log', position: { x: 1, y: 64, z: 0 } }, {
    reason: 'test.dig',
    forceLook: 'raycast',
  });
  await humanizer.digBlock(bot, { name: 'stone', position: { x: 1, y: 64, z: 0 } }, {
    reason: 'test.dig-face',
    digFace: { x: 0, y: 1, z: 0 },
    critical: true,
  });

  assert.deepEqual(calls, [
    ['dig', 'oak_log', 'raycast', null],
    ['dig', 'stone', true, { x: 0, y: 1, z: 0 }],
  ]);
  assert.equal(log.records.some((record) => record.evt === 'humanize.dig'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.critical-exempt' && record.action === 'dig'), true);
});

test('enabled movement and collectBlock wrappers use audited chokepoints', async () => {
  const log = logger();
  const calls = [];
  const humanizer = createHumanizer({
    enabled: true,
    reactionMedianMs: 1,
    reactionP95Ms: 1,
    clickMinIntervalMs: 1,
  }, log);
  const target = { name: 'oak_log', position: { x: 2, y: 64, z: 0 } };
  const bot = {
    setControlState: (control, value) => calls.push(['control', control, value]),
    collectBlock: {
      collect: (block, opts) => calls.push(['collectBlock', block.name, opts.ignoreNoPath]),
    },
  };

  humanizer.setControlState(bot, 'forward', true, { reason: 'test.forward', critical: true });
  await humanizer.collectBlock(bot, target, { ignoreNoPath: true }, { reason: 'test.collect' });

  assert.deepEqual(calls, [
    ['control', 'forward', true],
    ['collectBlock', 'oak_log', true],
  ]);
  assert.equal(log.records.some((record) => record.evt === 'humanize.control-state'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.collect-block'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.critical-exempt' && record.action === 'control'), true);
  assert.throws(
    () => humanizer.setControlState(bot, 'fly', true),
    /unknown movement control "fly"/,
  );
  assert.throws(
    () => humanizer.setControlState(bot, 'jump', 1),
    /movement control jump value must be boolean/,
  );
});

test('enabled idle micro-behaviors use humanized action wrappers', async () => {
  const log = logger();
  const calls = [];
  const humanizer = createHumanizer({
    enabled: true,
    reactionMedianMs: 1,
    reactionP95Ms: 1,
    clickMinIntervalMs: 1,
    aimFrameMs: 25,
    idleHopMs: 1,
    idleInventoryFlipMs: 1,
  }, log);
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, height: 1.62 },
    quickBarSlot: 2,
    look: async (yaw, pitch, force) => calls.push(['look', Number(yaw.toFixed(4)), Number(pitch.toFixed(4)), force]),
    setControlState: (control, value) => calls.push(['control', control, value]),
    setQuickBarSlot(slot) {
      calls.push(['quickbar', slot]);
      this.quickBarSlot = slot;
    },
  };

  await humanizer.performIdleMicroBehavior(bot, { behavior: 'look_at_sky' });
  await humanizer.performIdleMicroBehavior(bot, { behavior: 'scenery_glance' });
  await humanizer.performIdleMicroBehavior(bot, { behavior: 'hop_in_place' });
  await humanizer.performIdleMicroBehavior(bot, { behavior: 'inventory_flip' });

  assert.equal(calls.some((call) => call[0] === 'look'), true);
  assert.deepEqual(calls.filter((call) => call[0] === 'control'), [
    ['control', 'jump', true],
    ['control', 'jump', false],
  ]);
  assert.equal(calls.filter((call) => call[0] === 'quickbar').at(-1)[1], 2);
  assert.equal(log.records.some((record) => record.evt === 'humanize.idle-start'), true);
  assert.equal(log.records.some((record) => record.evt === 'humanize.idle-done'), true);
  await assert.rejects(
    () => humanizer.performIdleMicroBehavior(bot, { behavior: 'spinbot' }),
    /unknown idle behavior "spinbot"/,
  );
});

test('mood drift and cadence jitter vary repeated shared action boundaries', async () => {
  const log = logger();
  const calls = [];
  const humanizer = createHumanizer({
    enabled: true,
    sessionSeed: 'cadence-test',
    reactionMedianMs: 1,
    reactionP95Ms: 2,
    clickMinIntervalMs: 1,
    cadenceJitterMs: 8,
    moodDriftStep: 0.05,
  }, log);
  const bot = {
    activateItem: () => calls.push(['activateItem']),
  };

  await humanizer.activateItem(bot, { reason: 'loop.action.1' });
  await humanizer.activateItem(bot, { reason: 'loop.action.2' });
  await humanizer.activateItem(bot, { reason: 'loop.action.3' });

  const cadence = log.records.filter((record) => record.evt === 'humanize.cadence');
  assert.equal(calls.length, 3);
  assert.ok(cadence.length >= 3);
  assert.ok(new Set(cadence.map((record) => record.intervalMs)).size > 1);
  assert.equal(log.records.some((record) => record.evt === 'humanize.mood-drift'), true);
});

test('inter-action variation is global, mood-driven, and skips reactive priority', async () => {
  const log = logger();
  const calls = [];
  const humanizer = createHumanizer({
    enabled: true,
    sessionSeed: 'between-actions-test',
    reactionMedianMs: 1,
    reactionP95Ms: 1,
    clickMinIntervalMs: 1,
    cadenceJitterMs: 1,
    interActionMinMs: 1,
    interActionMaxMs: 1,
    interActionLookChance: 1,
    interActionMicroRepositionChance: 1,
    interActionMicroRepositionMs: 1,
    mood: 'exploratory',
  }, log);
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, height: 1.62, onGround: true },
    reactiveController: { state: 'NORMAL' },
    pathfinderOwner: {
      isIdle: () => true,
      currentOwner: () => null,
    },
    look: async (yaw, pitch, force) => calls.push(['look', force, Number.isFinite(yaw), Number.isFinite(pitch)]),
    setControlState: (control, value) => calls.push(['control', control, value]),
  };

  const result = await humanizer.betweenActions(bot, {
    reason: 'offline.between-skills',
    previousSkill: 'collect',
    nextSkill: 'deposit',
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.mood, 'exploratory');
  assert.equal(log.records.some((record) => record.evt === 'humanize.inter-action' && record.microReposition === true), true);
  assert.equal(calls.some((call) => call[0] === 'look'), true);
  assert.equal(calls.some((call) => call[0] === 'control' && call[2] === true), true);
  assert.equal(calls.some((call) => call[0] === 'control' && call[2] === false), true);

  bot.reactiveController.state = 'FLEEING';
  assert.equal(isReactivePriorityActive(bot), true);
  const skipped = await humanizer.betweenActions(bot, {
    reason: 'offline.reactive-skip',
    previousSkill: 'collect',
    nextSkill: 'deposit',
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'reactive priority active');
});
