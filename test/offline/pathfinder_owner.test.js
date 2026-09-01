import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { PathfinderOwner } from '../../src/control/pathfinder.js';
import { createHumanizer } from '../../src/behavior_shaping/humanizer.js';
import interrupts from '../../src/reactive/interrupts.js';
import pkgPathfinder from 'mineflayer-pathfinder';

const { goals: pfGoals } = pkgPathfinder;

async function captureStdoutRecords(fn) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = function write(chunk, encoding, callback) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    const value = await fn();
    const records = chunks.join('')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { value, records };
  } finally {
    process.stdout.write = originalWrite;
  }
}

class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.stopCalls = 0;
    this.setGoalCalls = 0;
    this.setMovementsCalls = 0;
    this.lastGoal = null;
    this.lastDynamic = null;
    this.entity = { position: { x: 0, y: 64, z: 0 } };
    this.pathfinder = {
      stop: () => {
        this.stopCalls++;
        this.emit('path_stop');
      },
      setGoal: (goal, dynamic) => {
        this.lastGoal = goal;
        this.lastDynamic = dynamic;
        this.setGoalCalls++;
      },
      setMovements: () => {
        this.setMovementsCalls++;
      },
    };
  }
}

class ListenerFailureBot extends FakeBot {
  on(eventName, listener) {
    if (eventName === 'path_update') {
      throw new Error('path_update listener unavailable');
    }
    return super.on(eventName, listener);
  }
}

test('owner isolates bot event listener registration failures during construction', async () => {
  const bot = new ListenerFailureBot();
  const { value: owner, records } = await captureStdoutRecords(() => new PathfinderOwner(bot));

  assert.equal(owner instanceof PathfinderOwner, true);
  assert.equal(bot.listenerCount('path_update'), 0);
  assert.equal(bot.listenerCount('goal_reached'), 1);
  assert.equal(bot.listenerCount('path_stop'), 1);
  assert.equal(bot.listenerCount('goal_updated'), 1);
  assert.equal(records.some((record) => (
    record.evt === 'owner.listener-error'
      && record.event === 'path_update'
      && record.err === 'path_update listener unavailable'
  )), true);

  const skill = owner.acquire('skill', { reason: 'goto' });
  assert.equal(owner.setGoal(skill.token, { isEnd: () => false }), true);
  bot.emit('goal_reached');
  assert.equal(owner.isIdle(), true);
});

test('reactive acquire preempts a skill holder and aborts the bound signal', () => {
  const bot = new FakeBot();
  const owner = new PathfinderOwner(bot);
  const controller = new AbortController();
  const preemptions = [];
  const releases = [];
  interrupts.once('preempted', (reason) => preemptions.push(reason));
  interrupts.once('released', (reason) => releases.push(reason));

  owner.bindSkillSignal(controller);
  const skill = owner.acquire('skill', { reason: 'collect' });
  assert.equal(owner.currentOwner(), 'skill');

  const reactive = owner.acquire('reactive', { reason: 'hazard' });

  assert.equal(controller.signal.aborted, true);
  assert.equal(bot.stopCalls, 1);
  assert.equal(owner.currentOwner(), 'reactive');
  assert.deepEqual(preemptions, ['hazard']);

  skill.release();
  assert.equal(owner.currentOwner(), 'reactive', 'stale skill release must not clear reactive owner');

  reactive.release();
  assert.equal(owner.currentOwner(), null);
  assert.deepEqual(releases, ['hazard']);
});

test('skill acquire is denied while reactive owns the pathfinder', () => {
  const bot = new FakeBot();
  const owner = new PathfinderOwner(bot);

  const reactive = owner.acquire('reactive', { reason: 'water_escape' });
  const skill = owner.acquire('skill', { reason: 'goto' });

  assert.equal(skill, null);
  assert.equal(owner.currentOwner(), 'reactive');

  reactive.release();
});

test('stale tokens cannot set goals, stop pathing, or release the current owner', () => {
  const bot = new FakeBot();
  const owner = new PathfinderOwner(bot);
  const controller = new AbortController();
  owner.bindSkillSignal(controller);

  const skill = owner.acquire('skill', { reason: 'collect' });
  const reactive = owner.acquire('reactive', { reason: 'fall' });

  assert.equal(owner.setGoal(skill.token, { isEnd: () => false }), false);
  assert.equal(owner.stop(skill.token), false);
  skill.release();

  assert.equal(bot.setGoalCalls, 0);
  assert.equal(owner.currentOwner(), 'reactive');

  reactive.release();
  assert.equal(owner.currentOwner(), null);
});

test('valid owner token gates setGoal and stop through the chokepoint', () => {
  const bot = new FakeBot();
  const owner = new PathfinderOwner(bot);
  const skill = owner.acquire('skill', { reason: 'goto' });
  const movements = {};

  assert.equal(owner.setGoal(skill.token, { isEnd: () => false }, { movements }), true);
  assert.equal(bot.setMovementsCalls, 1);
  assert.equal(bot.setGoalCalls, 1);
  assert.equal(owner.isIdle(), false);

  assert.equal(owner.stop(skill.token), true);
  assert.equal(bot.stopCalls, 1);
  assert.equal(owner.isIdle(), true);
});

test('owner exposes a monotonic revision across owner and idle ABA transitions', () => {
  const bot = new FakeBot();
  const owner = new PathfinderOwner(bot);
  const initial = owner.stateRevision();

  const skill = owner.acquire('skill', { reason: 'goto' });
  assert.ok(owner.stateRevision() > initial);
  const acquired = owner.stateRevision();

  assert.equal(owner.setGoal(skill.token, { isEnd: () => false }), true);
  assert.ok(owner.stateRevision() > acquired);
  const busy = owner.stateRevision();

  assert.equal(owner.stop(skill.token), true);
  assert.ok(owner.stateRevision() > busy);
  const idle = owner.stateRevision();

  skill.release();
  assert.ok(owner.stateRevision() > idle);
  assert.equal(owner.currentOwner(), null);
  assert.equal(owner.isIdle(), true);
});

test('owner lets humanizer apply static near-goal entropy through the chokepoint', () => {
  const bot = new FakeBot();
  bot.humanizer = createHumanizer({
    enabled: true,
    pathEntropyEnabled: true,
  }, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
  const owner = new PathfinderOwner(bot);
  const skill = owner.acquire('skill', { reason: 'goto' });
  const originalGoal = new pfGoals.GoalNear(10, 64, 0, 2);

  assert.equal(owner.setGoal(skill.token, originalGoal), true);

  assert.equal(bot.setGoalCalls, 1);
  assert.notEqual(bot.lastGoal, originalGoal);
  assert.equal(bot.lastDynamic, false);
  assert.equal(bot.lastGoal.isEnd({ x: 10, y: 64, z: 0 }), true);
  assert.equal(bot.lastGoal.humanized.kind, 'near_goal_lane_bias');
});

test('owner stop failure leaves active goal non-idle', () => {
  const bot = new FakeBot();
  const owner = new PathfinderOwner(bot);
  const skill = owner.acquire('skill', { reason: 'goto' });
  owner.setGoal(skill.token, { isEnd: () => false });
  bot.pathfinder.stop = () => {
    bot.stopCalls++;
    throw new Error('pathfinder stop unavailable');
  };

  assert.equal(owner.stop(skill.token), false);
  assert.equal(bot.stopCalls, 1);
  assert.equal(owner.isIdle(), false);
  assert.equal(owner.currentOwner(), 'skill');
});

test('reactive preempt stop failure leaves active goal non-idle', () => {
  const bot = new FakeBot();
  const owner = new PathfinderOwner(bot);
  const controller = new AbortController();
  owner.bindSkillSignal(controller);
  const skill = owner.acquire('skill', { reason: 'collect' });
  owner.setGoal(skill.token, { isEnd: () => false });
  bot.pathfinder.stop = () => {
    bot.stopCalls++;
    throw new Error('pathfinder stop unavailable');
  };

  const reactive = owner.acquire('reactive', { reason: 'hazard' });

  assert.equal(controller.signal.aborted, true);
  assert.equal(bot.stopCalls, 1);
  assert.equal(owner.currentOwner(), 'reactive');
  assert.equal(owner.isIdle(), false);

  reactive.release();
});
