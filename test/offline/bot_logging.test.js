import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { installAccountSessionGuard, installBotLogging, loadCorePlugins } from '../../src/bot.js';

class ListenerFailureBot extends EventEmitter {
  constructor(failEvents = []) {
    super();
    this.failEvents = new Set(failEvents);
    this.username = 'mcbot-test';
    this.entity = { position: { x: 1, y: 2, z: 3 } };
  }

  on(eventName, listener) {
    if (this.failEvents.has(eventName)) {
      throw new Error(`${eventName} listener unavailable`);
    }
    return super.on(eventName, listener);
  }
}

function makeLogger() {
  const records = [];
  const logger = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (evt, fields = {}) => records.push({ level, evt, ...fields });
  }
  return { logger, records };
}

test('bot lifecycle logging isolates listener registration failures', () => {
  const bot = new ListenerFailureBot(['spawn']);
  const { logger, records } = makeLogger();

  assert.doesNotThrow(() => installBotLogging(bot, logger));

  assert.equal(bot.listenerCount('spawn'), 0);
  assert.equal(bot.listenerCount('login'), 1);
  assert.equal(bot.listenerCount('death'), 1);
  assert.equal(bot.listenerCount('messagestr'), 1);
  assert.deepEqual(records, [
    { level: 'info', evt: 'account.regime.test', username: 'MCBot', auth: 'offline' },
    { level: 'warn', evt: 'bot.listener-error', event: 'spawn', err: 'spawn listener unavailable' },
  ]);

  bot.emit('login');
  bot.emit('messagestr', 'hello world', 'chat');

  assert.deepEqual(
    records.filter((record) => record.evt === 'login' || record.evt === 'chat'),
    [
      { level: 'info', evt: 'login', username: 'mcbot-test' },
      { level: 'debug', evt: 'chat', type: 'chat', msg: 'hello world' },
    ],
  );
});

test('production account session guard records user-elsewhere cooldown without affecting test regime', () => {
  const bot = new ListenerFailureBot();
  const { logger, records } = makeLogger();
  const guard = installAccountSessionGuard(bot, {
    regime: 'production',
    userElsewhereKickCooldownMs: 60000,
  }, logger);

  const kick = guard.noteKick('You logged in from another location', 1000);
  assert.equal(kick.matched, true);
  assert.equal(kick.cooldownUntilMs, 61000);
  assert.equal(guard.reconnectStatus(1000).reconnectAllowed, false);
  assert.deepEqual(records, [
    {
      level: 'info',
      evt: 'account.regime.production',
      userElsewhereKickCooldownMs: 60000,
      auth: 'microsoft',
    },
  ]);
});

test('loadCorePlugins loads required plugins in order', () => {
  const loaded = [];
  const plugins = [
    { name: 'pathfinder', plugin: () => {} },
    { name: 'collectBlock', plugin: () => {} },
    { name: 'autoEat', plugin: () => {} },
  ];
  const bot = {
    loadPlugin(plugin) {
      loaded.push(plugin);
    },
  };

  assert.doesNotThrow(() => loadCorePlugins(bot, plugins));

  assert.deepEqual(loaded, plugins.map(({ plugin }) => plugin));
});

test('bot lifecycle logging records death recovery classification', () => {
  const bot = new ListenerFailureBot();
  bot.inventory = {
    items: () => [{ name: 'cooked_beef', count: 4, slot: 9 }],
  };
  bot.skillExecutor = {
    currentCall: { skill: 'goto', params: { x: 1, y: 2, z: 3 } },
    currentSubtask: 'goto({"x":1,"y":2,"z":3})',
    queue: [{ skill: 'goto', params: { x: 1, y: 2, z: 3 } }],
  };
  const { logger, records } = makeLogger();

  installBotLogging(bot, logger);
  bot.emit('entityHurt', bot.entity, { id: 9, type: 'player', username: 'Alex' });
  bot.emit('death');

  const death = records.find((record) => record.evt === 'death');
  assert.equal(death.level, 'error');
  assert.equal(death.cause.kind, 'player');
  assert.equal(death.damageSource.username, 'Alex');
  assert.equal(death.recovery.action, 'abandon_drops');
  assert.deepEqual(death.currentTask, {
    skill: 'goto',
    params: { x: 1, y: 2, z: 3 },
    subtask: 'goto({"x":1,"y":2,"z":3})',
    queueLength: 1,
  });
  assert.deepEqual(death.inventorySnapshot, {
    ok: true,
    items: [{ name: 'cooked_beef', count: 4, slot: 9 }],
    totalStacks: 1,
    totalItems: 4,
    truncated: false,
  });
});

test('bot respawn schedules one recover_drops prefix for recoverable deaths', () => {
  const bot = new ListenerFailureBot();
  bot.game = { dimension: 'overworld' };
  bot.entity.position = { x: 10, y: 64, z: 10 };
  bot.inventory = {
    items: () => [{ name: 'oak_log', count: 3, slot: 9 }],
  };
  const queued = [];
  const aborts = [];
  bot.skillExecutor = {
    currentCall: { skill: 'collect', params: { block: 'oak_log', count: 10 } },
    currentSubtask: 'collect({"block":"oak_log","count":10})',
    queue: [{ skill: 'collect', params: { block: 'oak_log', count: 10 } }],
    requestQueuePrefix(calls, meta) {
      queued.push({ calls, meta });
      return { ok: true, count: calls.length };
    },
    requestCurrentSkillAbort(reason) {
      aborts.push(reason);
      return { ok: true, reason };
    },
  };
  const { logger, records } = makeLogger();

  installBotLogging(bot, logger);
  bot.emit('messagestr', 'mcbot-test fell from a high place', 'system');
  bot.emit('death');
  bot.entity.position = { x: 12, y: 64, z: 10 };
  bot.emit('respawn');

  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].calls, [{
    skill: 'recover_drops',
    params: { x: 10, y: 64, z: 10, dimension: 'overworld' },
  }]);
  assert.equal(queued[0].meta.reason, 'death-drop-recovery');
  assert.deepEqual(aborts, ['drop recovery scheduled after respawn']);

  const respawn = records.find((record) => record.evt === 'respawn');
  assert.equal(respawn.level, 'warn');
  assert.equal(respawn.recovery.decision.action, 'recover_drops');
  assert.equal(respawn.dropRecoverySchedule.ok, true);
  assert.equal(respawn.dropRecoverySchedule.recovery.status, 'recovering');
  assert.equal(respawn.dropRecoverySchedule.recovery.attempts, 1);
});

test('loadCorePlugins logs and rethrows plugin load failures', () => {
  const loaded = [];
  const first = () => {};
  const failing = () => {};
  const skipped = () => {};
  const plugins = [
    { name: 'pathfinder', plugin: first },
    { name: 'collectBlock', plugin: failing },
    { name: 'autoEat', plugin: skipped },
  ];
  const { logger, records } = makeLogger();
  const bot = {
    loadPlugin(plugin) {
      if (plugin === failing) throw new Error('collectBlock plugin unavailable');
      loaded.push(plugin);
    },
  };

  assert.throws(
    () => loadCorePlugins(bot, plugins, logger),
    /collectBlock plugin unavailable/,
  );

  assert.deepEqual(loaded, [first]);
  assert.deepEqual(records, [
    { level: 'error', evt: 'bot.plugin-load-error', plugin: 'collectBlock', err: 'collectBlock plugin unavailable' },
  ]);
});
