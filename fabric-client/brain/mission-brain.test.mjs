import assert from 'node:assert/strict';
import test from 'node:test';

import { THRESHOLDS, expectedObjective } from './mission-planner.js';
import { createMissionBrainHandler } from './mission-brain.js';
import { applyAction, createInitialState } from './mission-sim.js';

// Valid low-level action ids the Fabric client executes (per BrainLink.java), plus the idle marker.
const VALID_ACTIONS = new Set([
  'gather_log', 'gather_tree', 'mine_stone', 'mine_nearby_stone', 'mine_nearby_iron', 'mine_nearby_diamond',
  'navigate_to_point',
  'descend_staircase', 'return_staircase', 'r2_mine_stone_return', 'r5_iron_chain',
  'craft_planks', 'craft_sticks', 'craft_table', 'craft_pickaxe', 'craft_stone_pickaxe',
  'craft_stone_sword', 'craft_furnace', 'craft_iron_pickaxe', 'craft_diamond_pickaxe', 'craft_iron_helmet',
  'craft_iron_chestplate', 'craft_iron_leggings', 'craft_iron_boots',
  'place_table', 'retrieve_table', 'place_furnace', 'smelt_raw_iron', 'smelt_charcoal', 'make_charcoal', 'equip_armor', 'eat', 'stop',
]);

// Perfect-planner mock (reuses the real prompt/encode path; returns the oracle's pick).
function oracleBrain() {
  return async (messages) => {
    const view = JSON.parse(messages.find((m) => m.role === 'user').content.match(/State: (\{.*\})/)[1]);
    const raw = {
      logs: view.logs, planks: view.planks, sticks: view.sticks,
      woodenPickaxes: view.hasWoodenPickaxe ? 1 : 0, cobblestone: view.cobblestone,
      stonePickaxes: view.stonePickaxes ?? (view.hasStonePickaxe ? 1 : 0),
      bestStonePickaxeRemaining: view.bestStonePickaxeRemaining,
      stoneSwords: view.hasStoneSword ? 1 : 0,
      furnaces: view.hasFurnace ? 1 : 0, fuel: view.fuel, rawIron: view.rawIron,
      ironIngots: view.ironIngots, ironPickaxes: view.ironPickaxes ?? (view.hasIronPickaxe ? 1 : 0),
      diamonds: view.diamonds, diamondPickaxes: view.diamondPickaxes, targetDiamondTier: view.targetDiamondTier,
      targetIronPickaxeOnly: view.targetIronPickaxeOnly,
      equippedArmorPieces: view.equippedIronArmorPieces, foodLevel: view.foodLevel,
      hasFood: view.hasFood, atIronDepth: view.atIronDepth, atDiamondDepth: view.atDiamondDepth,
    };
    const objective = expectedObjective(raw);
    return JSON.stringify({ objective, done: objective === 'DONE', reason: 'oracle' });
  };
}

// Drive the mission through the brain CONTRACT: handle(instanceId, snapshot) -> intent, apply, repeat.
async function runThroughHandler(handle, instanceId, overrides = {}, maxSteps = 400) {
  let state = createInitialState(overrides);
  const intents = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const intent = await handle(instanceId, state);
    intents.push(intent);
    if (intent.missionDone) return { done: true, steps: i + 1, state, intents };
    state = applyAction(state, intent.action).state;
  }
  return { done: false, steps: maxSteps, state, intents };
}

function liveWoodSearchSnapshot(overrides = {}) {
  return {
    ...createInitialState({ x: 0, y: 70, z: 0 }),
    nearbyLogs: [],
    farPerception: {
      loadedChunkCount: 9,
      scannedChunkCount: 9,
      resources: [{
        resource: 'wood',
        targets: [],
        directions: [{ dx: 1, dz: 0, biomeClass: 'wood_bearing', woodBearingChunks: 2, scannedChunks: 2 }],
      }],
    },
    currentCommandCompleted: false,
    currentCommandCompletionReason: '',
    ...overrides,
  };
}

test('handler returns well-formed intents (valid action id + required fields)', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: (s) => signals.push(s) });
  const intent = await handle('inst-1', createInitialState());
  assert.ok(VALID_ACTIONS.has(intent.action), `bad action id: ${intent.action}`);
  assert.equal(typeof intent.ttlMs, 'number');
  assert.equal(typeof intent.maxTtlMs, 'number');
  assert.match(intent.commandId, /^mission-inst-1-\d+$/);
  assert.equal(typeof intent.missionDone, 'boolean');
});

test('handler passes DESCEND_DEEP targetY through to the Fabric client', async () => {
  const handle = createMissionBrainHandler({
    complete: async () => JSON.stringify({ objective: 'DESCEND_DEEP', done: false, reason: 'diamond depth' }),
    emit: () => {},
    forceLlm: true,
  });
  const intent = await handle('inst-1', createInitialState({ ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent, targetDiamondTier: true }));
  assert.equal(intent.action, 'descend_staircase');
  assert.equal(intent.targetY, THRESHOLDS.diamondTargetY);
});

test('opts.missionGoal is merged into the snapshot so the planner targets diamond', async () => {
  // The goal is NOT in the snapshot; it is injected via opts (the adapter reads MCBOT_FABRIC_MISSION_GOAL).
  // With it, a diamond-depth state with iron pickaxes must drive the diamond-mining action.
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {}, missionGoal: 'diamond' });
  // Iron-tier prerequisites satisfied (furnace + iron pickaxe + at depth) so the planner reaches the
  // diamond branch; the goal is what flips it from MAKE_ARMOR to the diamond track.
  const intent = await handle('inst-diamond', createInitialState({
    atIronDepth: true, atDiamondDepth: true, furnaces: 1,
    ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent, ironIngots: 24,
  }));
  assert.equal(intent.missionObjective, 'MINE_DIAMOND');
  assert.equal(intent.action, 'mine_nearby_diamond');
});

test('without a mission goal the same diamond-depth state stays off the diamond track', async () => {
  // Negative control: no goal injected -> targetDiamondTier stays false -> the bot does NOT mine diamond.
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const intent = await handle('inst-default', createInitialState({
    atIronDepth: true, atDiamondDepth: true, furnaces: 1,
    ironPickaxes: THRESHOLDS.ironPickaxesForDiamondDescent, ironIngots: 24,
  }));
  assert.notEqual(intent.action, 'mine_nearby_diamond');
});

test('handler drives a full mission to DONE through the brain contract', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: (s) => signals.push(s) });
  const res = await runThroughHandler(handle, 'inst-1');
  assert.equal(res.done, true, `did not finish in ${res.steps} steps`);
  assert.ok(res.state.ironPickaxes >= 1 && res.state.equippedArmorPieces >= 4);
  // every emitted action is a valid client action id
  for (const it of res.intents) assert.ok(VALID_ACTIONS.has(it.action), `bad action: ${it.action}`);
  // mission.* signals were emitted, including the terminal one
  assert.ok(signals.some((s) => s.evt === 'mission.objective.chosen'));
  assert.ok(signals.some((s) => s.evt === 'mission.done'));
  // signals carry the instanceId
  assert.ok(signals.every((s) => s.instanceId === 'inst-1'));
});

test('handler surfaces the planner decision (planSource + planReason) for the cockpit', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const intent = await handle('inst-1', createInitialState());
  // First poll re-plans (no active objective) -> mission.objective.chosen captured into the intent.
  assert.equal(intent.planSource, 'oracle');
  assert.equal(typeof intent.planReason, 'string');
  assert.ok(intent.planReason.length > 0, 'planReason should be populated from the decision');
});

test('handler keeps mission state isolated per instanceId', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  // Advance instance A a few steps along its own world; B starts fresh and independently.
  let aState = createInitialState();
  for (let i = 0; i < 5; i += 1) {
    const it = await handle('A', aState);
    aState = applyAction(aState, it.action).state;
  }
  const bFirst = await handle('B', createInitialState());
  // B, brand new, must start at the very first objective (GATHER_WOOD), unaffected by A's progress.
  assert.equal(bFirst.missionObjective, 'GATHER_WOOD');
  assert.equal(bFirst.action, 'gather_tree');
});

test('handler attaches a gather target when the snapshot has nearby logs', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const snap = createInitialState();
  snap.nearbyLogs = [{ x: 12, y: 70, z: -4 }];
  const intent = await handle('inst-1', snap);
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.targetX, 12);
  assert.equal(intent.targetZ, -4);
});

test('handler uses a gather target hint when live perception has no nearby logs yet', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [];
  const intent = await handle('inst-1', snap);
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.targetX, -2);
  assert.equal(intent.targetY, 25);
  assert.equal(intent.targetZ, 0);
  assert.ok(signals.some((s) => (
    s.evt === 'mission.target.used'
      && s.source === 'hint'
      && s.targetX === -2
  )));
  assert.ok(signals.some((s) => s.evt === 'mission.target_hint.used' && s.targetX === -2));
});

test('handler prefers fixture target hints over sensed nearby logs', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [{ x: 12, y: 70, z: -4 }];
  const intent = await handle('inst-1', snap);
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.targetX, -2);
  assert.equal(intent.targetY, 25);
  assert.equal(intent.targetZ, 0);
  assert.ok(signals.some((s) => s.evt === 'mission.target.used' && s.source === 'hint'));
});

test('handler consumes fixture hints that were completed through live perception', async () => {
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
      { action: 'gather_log', x: -3, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [{ x: -2, y: 25, z: 0 }];
  const first = await handle('inst-1', snap);
  assert.equal(first.targetX, -2);
  assert.equal(first.targetY, 25);

  const second = await handle('inst-1', {
    ...snap,
    nearbyLogs: [],
    currentCommandCompleted: true,
  });
  assert.equal(second.targetX, -3);
  assert.equal(second.targetY, 25);
});

test('handler consumes completed gather target hints in fixture order', async () => {
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
      { action: 'gather_log', x: -3, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [];
  const first = await handle('inst-1', snap);
  assert.equal(first.targetX, -2);
  assert.equal(first.targetY, 25);

  const second = await handle('inst-1', { ...snap, currentCommandCompleted: true });
  assert.equal(second.targetX, -3);
  assert.equal(second.targetY, 25);
});

test('handler consumes rejected gather target hints without replaying the same fixture target', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    targetHints: [
      { action: 'gather_log', x: -2, y: 25, z: 0 },
      { action: 'gather_log', x: -3, y: 25, z: 0 },
    ],
  });
  const snap = createInitialState({ x: 0.5, y: 24, z: 0.5 });
  snap.nearbyLogs = [];
  const first = await handle('inst-1', snap);
  assert.equal(first.targetX, -2);

  const second = await handle('inst-1', {
    ...snap,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_log_failed:adjacent_no_path',
  });
  assert.equal(second.action, 'gather_tree');
  assert.equal(second.targetX, -3);
  assert.ok(signals.some((s) => (
    s.evt === 'mission.target_hint.consumed'
      && s.targetX === -2
      && s.reason === 'gather_log_failed:adjacent_no_path'
  )));
});

test('handler attaches mining target hints without rewriting them to gather hints', async () => {
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: async () => JSON.stringify({ objective: 'MINE_IRON', done: false, reason: 'fixture iron' }),
    emit: (s) => signals.push(s),
    forceLlm: true,
    targetHints: [
      { action: 'mine_nearby_iron', x: 16, y: 16, z: -3 },
    ],
  });

  const intent = await handle('inst-iron', createInitialState({ atIronDepth: true, stonePickaxes: 1 }));

  assert.equal(intent.action, 'mine_nearby_iron');
  assert.equal(intent.targetX, 16);
  assert.equal(intent.targetY, 16);
  assert.equal(intent.targetZ, -3);
  assert.ok(signals.some((s) => s.evt === 'mission.target_hint.used' && s.action === 'mine_nearby_iron'));
});

test('handler requires an injected complete function', () => {
  assert.throws(() => createMissionBrainHandler({}), /requires opts\.complete/);
});

test('handler reuses the commandId while the command runs, mints a new one when it completes', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const base = createInitialState({ logs: 5 }); // MAKE_WOOD_TOOLS -> craft_planks (stable action)
  const i1 = await handle('inst-1', { ...base, currentCommandCompleted: false }); // first -> mint X
  const i2 = await handle('inst-1', { ...base, currentCommandCompleted: false }); // X still running -> reuse
  const i3 = await handle('inst-1', { ...base, currentCommandCompleted: false }); // still running -> reuse
  assert.equal(i2.commandId, i1.commandId);
  assert.equal(i3.commandId, i1.commandId);
  const i4 = await handle('inst-1', { ...base, currentCommandCompleted: true }); // finished -> new id
  assert.notEqual(i4.commandId, i1.commandId);
});

test('handler aborts when a stalled objective replans to the same action', async () => {
  let now = 1000;
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (s) => signals.push(s),
    now: () => now,
    stallTimeoutMs: 10,
    abortTimeoutMs: 1000,
    // Pin the 1-strike abort plumbing this test exercises; the budgeted GATHER_WOOD retry
    // (default gatherRecoveryLimit 3, run-14 fix) has its own orchestrator-level test.
    gatherRecoveryLimit: 0,
  });
  const base = createInitialState();
  const first = await handle('inst-1', { ...base, currentCommandCompleted: false });
  assert.equal(first.action, 'gather_tree');

  now += 20;
  const replanned = await handle('inst-1', { ...base, currentCommandCompleted: false });
  assert.equal(replanned.action, 'stop');
  assert.equal(replanned.reason, 'mission:aborted');
  assert.equal(replanned.missionObjective, 'ABORTED');
  assert.equal(replanned.missionDone, true);
  assert.notEqual(replanned.commandId, first.commandId);
  assert.ok(signals.some((s) => s.evt === 'mission.objective.exhausted' && s.reason === 'same_objective_reselected'), 'missing same-objective exhaustion telemetry');
  assert.ok(signals.some((s) => s.evt === 'mission.aborted' && s.reason === 'objective_exhausted'), 'missing objective_exhausted abort telemetry');
});

test('handler sends setup commands once, settles, then drives the mission', async () => {
  let t = 1000;
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    setupCommands: ['time set day', 'give @p minecraft:oak_log 20'],
    setupSettleMs: 500,
    now: () => t,
  });
  // 1st poll -> the setup_commands intent (run once)
  const first = await handle('inst-1', createInitialState());
  assert.equal(first.action, 'setup_commands');
  assert.deepEqual(first.serverCommands, ['time set day', 'give @p minecraft:oak_log 20']);
  // still settling -> idle (don't act until setup lands)
  const settling = await handle('inst-1', createInitialState());
  assert.equal(settling.action, 'stop');
  assert.equal(settling.missionObjective, 'SETUP');
  // after settle -> the mission begins from the (now staged) world
  t = 2000;
  const go = await handle('inst-1', createInitialState({ logs: 20 }));
  assert.equal(go.missionObjective, 'MAKE_WOOD_TOOLS');
});

test('handler exposes deterministic EXPLORE navigation with the injected flag and knobs', async () => {
  let deepseekCallCount = 0;
  const signals = [];
  const handle = createMissionBrainHandler({
    complete: async () => { deepseekCallCount += 1; throw new Error('paid planner must not run'); },
    emit: (signal) => signals.push(signal),
    exploreEnabled: true,
    exploreLegBlocks: 130,
    exploreLegLimit: 4,
    exploreArriveDist: 5,
    exploreHopBlocks: 11,
  });
  const base = liveWoodSearchSnapshot();
  const gather = await handle('inst-explore', base);
  assert.equal(gather.action, 'gather_tree');

  const explore = await handle('inst-explore', {
    ...base,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'gather_tree_complete:bounded_search_exhausted:route_attempt_limit',
  });

  assert.equal(explore.action, 'navigate_to_point');
  assert.equal(explore.missionObjective, 'EXPLORE');
  assert.equal(explore.targetX, 11);
  assert.equal(explore.targetZ, 0);
  assert.match(explore.commandId, /^mission-inst-explore-\d+$/);
  assert.equal(typeof explore.ttlMs, 'number');
  assert.equal(typeof explore.maxTtlMs, 'number');
  assert.equal(deepseekCallCount, 0);
  assert.ok(signals.some((signal) => signal.evt === 'exploration.leg.queued'));
  assert.ok(signals.some((signal) => signal.evt === 'exploration.hop.queued'));

  const nextHop = await handle('inst-explore', { ...base, x: 11, z: 0 });
  assert.equal(nextHop.action, 'navigate_to_point');
  assert.equal(nextHop.targetX, 22);
  assert.notEqual(nextHop.commandId, explore.commandId);
});

test('handler keeps EXPLORE default-off and never bypasses reachable local wood', async () => {
  const exhaustedReason = 'gather_tree_complete:bounded_search_exhausted:route_attempt_limit';
  const base = liveWoodSearchSnapshot();
  const offSignals = [];
  const off = createMissionBrainHandler({ complete: oracleBrain(), emit: (signal) => offSignals.push(signal) });
  await off('inst-off', base);
  const unchanged = await off('inst-off', {
    ...base,
    currentCommandCompleted: true,
    currentCommandCompletionReason: exhaustedReason,
  });
  assert.equal(unchanged.action, 'gather_tree');
  assert.equal(unchanged.missionObjective, 'GATHER_WOOD');
  assert.ok(!offSignals.some((signal) => signal.evt?.startsWith('exploration.')));

  const onSignals = [];
  const on = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: (signal) => onSignals.push(signal),
    exploreEnabled: true,
  });
  await on('inst-local', base);
  const local = await on('inst-local', {
    ...base,
    nearbyLogs: [{ x: 12, y: 70, z: -4 }],
    currentCommandCompleted: true,
    currentCommandCompletionReason: exhaustedReason,
  });
  assert.equal(local.action, 'gather_tree');
  assert.equal(local.missionObjective, 'GATHER_WOOD');
  assert.equal(local.targetX, 12);
  assert.equal(local.targetZ, -4);
  assert.ok(!onSignals.some((signal) => signal.evt === 'exploration.leg.queued'));
});
