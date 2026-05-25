import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDeathCause,
  createDeathRecoveryTracker,
  decideDropRecovery,
  summarizeDamageSource,
} from '../../src/runtime/death_recovery.js';

function pos(x, y, z) {
  return { x, y, z };
}

test('death recovery abandons player-caused deaths', () => {
  const cause = classifyDeathCause({
    damageSource: summarizeDamageSource({ id: 2, type: 'player', username: 'Steve' }),
  });
  const decision = decideDropRecovery({
    cause,
    deathPosition: pos(10, 64, 10),
    respawnPosition: pos(12, 64, 10),
  });

  assert.equal(cause.kind, 'player');
  assert.equal(decision.action, 'abandon_drops');
  assert.match(decision.reason, /player/);
});

test('death recovery abandons lava, fire, and void deaths as destructive', () => {
  for (const message of [
    'MCBot tried to swim in lava',
    'MCBot went up in flames',
    'MCBot fell out of the world into the void',
  ]) {
    const cause = classifyDeathCause({ message });
    const decision = decideDropRecovery({
      cause,
      deathPosition: pos(10, 64, 10),
      respawnPosition: pos(12, 64, 10),
    });

    assert.equal(cause.kind, 'destructive_hazard');
    assert.equal(decision.action, 'abandon_drops');
    assert.match(decision.reason, /likely destroyed/);
  }
});

test('death recovery allows one close non-destructive recovery attempt', () => {
  const decision = decideDropRecovery({
    cause: { kind: 'unknown', destructive: false, detail: null },
    deathPosition: pos(10, 64, 10),
    respawnPosition: pos(12, 64, 10),
  }, { maxDistance: 32 });

  assert.equal(decision.action, 'recover_drops');
  assert.equal(decision.recoverable, true);
  assert.equal(decision.attemptsAllowed, 1);
  assert.equal(Math.round(decision.distance), 2);
});

test('death recovery tracker records current task and inventory snapshot', () => {
  const bot = {
    entity: { id: 7, position: pos(10, 64, 10) },
    game: { dimension: 'overworld' },
    heldItem: { name: 'netherite_pickaxe', count: 1, slot: 36 },
    inventory: {
      items: () => [
        { name: 'cooked_beef', count: 8, slot: 5 },
        { name: 'diamond', count: 3, slot: 12 },
      ],
    },
    skillExecutor: {
      currentCall: { skill: 'collect', params: { block: 'diamond_ore', count: 3 }, _state: { private: true } },
      currentSubtask: 'collect({"block":"diamond_ore","count":3})',
      queue: [
        { skill: 'collect', params: { block: 'diamond_ore', count: 3 } },
        { skill: 'deposit', params: { items: [{ name: 'diamond' }] } },
      ],
    },
    blockAt() {
      return { name: 'air' };
    },
  };
  const tracker = createDeathRecoveryTracker(bot, { maxDistance: 32 });

  const death = tracker.recordDeath();

  assert.deepEqual(death.currentTask, {
    skill: 'collect',
    params: { block: 'diamond_ore', count: 3 },
    subtask: 'collect({"block":"diamond_ore","count":3})',
    queueLength: 2,
  });
  assert.deepEqual(death.inventorySnapshot, {
    ok: true,
    items: [
      { name: 'cooked_beef', count: 8, slot: 5 },
      { name: 'diamond', count: 3, slot: 12 },
    ],
    totalStacks: 2,
    totalItems: 11,
    truncated: false,
    heldItem: { name: 'netherite_pickaxe', count: 1, slot: 36 },
  });
});

test('death recovery abandons far drops and repeated recovery deaths', () => {
  const far = decideDropRecovery({
    cause: { kind: 'unknown', destructive: false, detail: null },
    deathPosition: pos(200, 64, 0),
    respawnPosition: pos(0, 64, 0),
  }, { maxDistance: 64 });
  const repeated = decideDropRecovery({
    cause: { kind: 'unknown', destructive: false, detail: null },
    deathPosition: pos(10, 64, 10),
    respawnPosition: pos(12, 64, 10),
    previousRecoveryAttempts: 1,
  });

  assert.equal(far.action, 'abandon_drops');
  assert.match(far.reason, /exceeds max recovery distance/);
  assert.equal(repeated.action, 'abandon_drops');
  assert.match(repeated.reason, /already attempted/);
});

test('death recovery tracker records pending recovery and abandons death during recovery', () => {
  const bot = {
    entity: { id: 7, position: pos(10, 64, 10) },
    game: { dimension: 'overworld' },
    blockAt() {
      return { name: 'air' };
    },
  };
  const tracker = createDeathRecoveryTracker(bot, { maxDistance: 32 });

  const death = tracker.recordDeath();
  assert.equal(death.decision.action, 'recover_drops');

  bot.entity.position = pos(12, 64, 10);
  const respawn = tracker.recordRespawn();
  assert.equal(respawn.decision.action, 'recover_drops');

  const started = tracker.markRecoveryStarted();
  assert.equal(started.status, 'recovering');
  assert.equal(started.attempts, 1);

  bot.entity.position = pos(11, 64, 10);
  const diedAgain = tracker.recordDeath();
  assert.equal(diedAgain.decision.action, 'abandon_drops');
  assert.match(diedAgain.decision.reason, /already attempted/);
});

test('death recovery tracker uses recent player damage source', () => {
  const bot = {
    entity: { id: 7, position: pos(10, 64, 10) },
    game: { dimension: 'overworld' },
    blockAt() {
      return { name: 'air' };
    },
  };
  const tracker = createDeathRecoveryTracker(bot);

  tracker.observeEntityHurt(bot.entity, { id: 9, type: 'player', username: 'Alex' });
  const death = tracker.recordDeath();

  assert.equal(death.cause.kind, 'player');
  assert.equal(death.damageSource.username, 'Alex');
  assert.equal(death.decision.action, 'abandon_drops');
});
