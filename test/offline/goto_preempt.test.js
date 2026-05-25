import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import mcDataLoader from 'minecraft-data';

import config from '../../src/config.js';
import { run as runGoto } from '../../src/skills/goto.js';
import { posKey } from '../../src/skills/_pathing.js';

const TEST_REGISTRY = mcDataLoader('1.21.4');

function pos(x, y, z) {
  return { x, y, z, clone() { return pos(x, y, z); } };
}

function gotoCtx(signal, callState) {
  return {
    signal,
    callState,
    remainingQueue: [],
    currentSubtask: null,
  };
}

function makeGotoHarness(blockPositions, onSetGoal) {
  const bot = new EventEmitter();
  const blocks = new Map(blockPositions.map((p) => [posKey(p), p]));
  const selectedGoals = [];
  let releaseCalls = 0;

  Object.assign(bot, {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    inventory: { items: () => [] },
    registry: TEST_REGISTRY,
    findBlocks: () => [...blocks.values()],
    blockAt(p) {
      const found = blocks.get(posKey(p));
      return found ? { name: 'oak_log', position: found } : { name: 'stone', position: p };
    },
    pathfinderOwner: {
      acquire: () => ({
        token: { id: 'goto-preempt-test' },
        release() {
          releaseCalls++;
        },
      }),
      setGoal(token, goal, opts = {}) {
        selectedGoals.push({ token, goal, opts });
        return onSetGoal({ bot, goal, blocks });
      },
      stop() {},
    },
  });

  return {
    bot,
    blocks,
    selectedGoals,
    get releaseCalls() { return releaseCalls; },
  };
}

test('goto block resumes the same target after one reactive preempt', async () => {
  const target = pos(4, 64, 0);
  const callState = {};
  let activeController = null;
  let setGoalCalls = 0;
  const harness = makeGotoHarness([target], ({ bot }) => {
    setGoalCalls++;
    if (setGoalCalls === 1) {
      activeController.abort('reactive-preempt');
    } else {
      setImmediate(() => bot.emit('goal_reached'));
    }
    return true;
  });

  activeController = new AbortController();
  const first = await runGoto(
    harness.bot,
    { block: 'oak_log', maxDistance: 16 },
    gotoCtx(activeController.signal, callState),
  );

  assert.equal(first.preempted, true);
  assert.equal(first.reason, 'reactive preempt during goto');
  assert.equal(posKey(callState.currentTarget), posKey(target));
  assert.equal(callState.interruptsOnCurrent, 1);
  assert.equal(callState.excluded.size, 0);

  activeController = new AbortController();
  const second = await runGoto(
    harness.bot,
    { block: 'oak_log', maxDistance: 16 },
    gotoCtx(activeController.signal, callState),
  );

  assert.equal(second.ok, true);
  assert.equal(second.reason, 'reached');
  assert.deepEqual(harness.selectedGoals.map(({ goal }) => posKey(goal)), [posKey(target), posKey(target)]);
  assert.equal(callState.currentTarget, null);
  assert.equal(callState.interruptsOnCurrent, 0);
  assert.equal(callState.excluded.size, 0);
  assert.equal(harness.releaseCalls, 2);
});

test('goto block excludes a target after repeated reactive preempts and tries another', async (t) => {
  const originalThreshold = config.reactive.maxInterruptionsPerTarget;
  config.reactive.maxInterruptionsPerTarget = 3;
  t.after(() => {
    config.reactive.maxInterruptionsPerTarget = originalThreshold;
  });

  const badTarget = pos(4, 64, 0);
  const goodTarget = pos(8, 64, 0);
  const callState = {};
  let activeController = null;
  const harness = makeGotoHarness([badTarget, goodTarget], ({ bot, goal }) => {
    if (posKey(goal) === posKey(badTarget)) {
      activeController.abort('reactive-preempt');
    } else {
      setImmediate(() => bot.emit('goal_reached'));
    }
    return true;
  });

  for (let i = 0; i < 3; i++) {
    activeController = new AbortController();
    const result = await runGoto(
      harness.bot,
      { block: 'oak_log', maxDistance: 16 },
      gotoCtx(activeController.signal, callState),
    );

    assert.equal(result.preempted, true);
    assert.equal(result.reason, 'reactive preempt during goto');
  }

  assert.equal(callState.excluded.has(posKey(badTarget)), true);
  assert.equal(callState.currentTarget, null);
  assert.equal(callState.interruptsOnCurrent, 0);

  activeController = new AbortController();
  const recovered = await runGoto(
    harness.bot,
    { block: 'oak_log', maxDistance: 16 },
    gotoCtx(activeController.signal, callState),
  );

  assert.equal(recovered.ok, true);
  assert.deepEqual(harness.selectedGoals.map(({ goal }) => posKey(goal)), [
    posKey(badTarget),
    posKey(badTarget),
    posKey(badTarget),
    posKey(goodTarget),
  ]);
  assert.equal(callState.currentTarget, null);
  assert.equal(callState.interruptsOnCurrent, 0);
  assert.equal(callState.excluded.has(posKey(badTarget)), true);
});
