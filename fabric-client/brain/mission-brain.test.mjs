import assert from 'node:assert/strict';
import test from 'node:test';

import { expectedObjective } from './mission-planner.js';
import { createMissionBrainHandler } from './mission-brain.js';
import { applyAction, createInitialState } from './mission-sim.js';

// Valid low-level action ids the Fabric client executes (per BrainLink.java), plus the idle marker.
const VALID_ACTIONS = new Set([
  'gather_log', 'gather_tree', 'mine_stone', 'mine_nearby_stone', 'mine_nearby_iron',
  'descend_staircase', 'return_staircase', 'r2_mine_stone_return', 'r5_iron_chain',
  'craft_planks', 'craft_sticks', 'craft_table', 'craft_pickaxe', 'craft_stone_pickaxe',
  'craft_stone_sword', 'craft_furnace', 'craft_iron_pickaxe', 'craft_iron_helmet',
  'craft_iron_chestplate', 'craft_iron_leggings', 'craft_iron_boots',
  'place_table', 'place_furnace', 'smelt_raw_iron', 'smelt_charcoal', 'make_charcoal', 'eat', 'stop',
]);

// Perfect-planner mock (reuses the real prompt/encode path; returns the oracle's pick).
function oracleBrain() {
  return async (messages) => {
    const view = JSON.parse(messages.find((m) => m.role === 'user').content.match(/State: (\{.*\})/)[1]);
    const raw = {
      logs: view.logs, planks: view.planks, sticks: view.sticks,
      woodenPickaxes: view.hasWoodenPickaxe ? 1 : 0, cobblestone: view.cobblestone,
      stonePickaxes: view.hasStonePickaxe ? 1 : 0, stoneSwords: view.hasStoneSword ? 1 : 0,
      furnaces: view.hasFurnace ? 1 : 0, fuel: view.fuel, rawIron: view.rawIron,
      ironIngots: view.ironIngots, ironPickaxes: view.hasIronPickaxe ? 1 : 0,
      equippedArmorPieces: view.equippedIronArmorPieces, foodLevel: view.foodLevel,
      hasFood: view.hasFood, atIronDepth: view.atIronDepth,
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
  assert.equal(bFirst.action, 'gather_log');
});

test('handler attaches a gather target when the snapshot has nearby logs', async () => {
  const handle = createMissionBrainHandler({ complete: oracleBrain(), emit: () => {} });
  const snap = createInitialState();
  snap.nearbyLogs = [{ x: 12, y: 70, z: -4 }];
  const intent = await handle('inst-1', snap);
  assert.equal(intent.action, 'gather_log');
  assert.equal(intent.targetX, 12);
  assert.equal(intent.targetZ, -4);
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

test('handler sends setup commands once, settles, then drives the mission', async () => {
  let t = 1000;
  const handle = createMissionBrainHandler({
    complete: oracleBrain(),
    emit: () => {},
    setupCommands: ['time set day', 'give @p minecraft:oak_log 16'],
    setupSettleMs: 500,
    now: () => t,
  });
  // 1st poll -> the setup_commands intent (run once)
  const first = await handle('inst-1', createInitialState());
  assert.equal(first.action, 'setup_commands');
  assert.deepEqual(first.serverCommands, ['time set day', 'give @p minecraft:oak_log 16']);
  // still settling -> idle (don't act until setup lands)
  const settling = await handle('inst-1', createInitialState());
  assert.equal(settling.action, 'stop');
  assert.equal(settling.missionObjective, 'SETUP');
  // after settle -> the mission begins from the (now staged) world
  t = 2000;
  const go = await handle('inst-1', createInitialState({ logs: 16 }));
  assert.equal(go.missionObjective, 'MAKE_WOOD_TOOLS');
});
