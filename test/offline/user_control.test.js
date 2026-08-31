import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  installUserControlCommands,
  normalizeAuthorizedUsers,
} from '../../src/runtime/user_control.js';

function makeLogger() {
  const records = [];
  const logger = {};
  for (const level of ['info', 'warn', 'error']) {
    logger[level] = (evt, fields = {}) => records.push({ level, evt, ...fields });
  }
  return { logger, records };
}

test('normalizeAuthorizedUsers supports comma-separated config', () => {
  assert.deepEqual([...normalizeAuthorizedUsers('Operator, Alex, ')], ['operator', 'alex']);
});

test('chat logout stays disabled even when a matching username and shutdown callback are supplied', () => {
  const bot = new EventEmitter();
  const shutdownReasons = [];
  const { logger, records } = makeLogger();

  const installed = installUserControlCommands(bot, {
    authorizedUsers: ['Operator'],
    logoutCommand: '!logout',
    shutdown: (reason) => shutdownReasons.push(reason),
    logger,
  });

  assert.deepEqual(installed, {
    installed: false,
    listener: null,
    authorizedUserCount: 1,
    reason: 'chat identity is not an authenticated operator channel',
  });
  bot.emit('chat', 'Operator', '!logout');

  assert.deepEqual(shutdownReasons, []);
  assert.deepEqual(records, [
    {
      level: 'warn',
      evt: 'user-command.disabled',
      reason: 'chat identity is not an authenticated operator channel',
      authorizedUserCount: 1,
    },
  ]);
});

test('disabled chat control registers no listener for authorized or unauthorized names', () => {
  const bot = new EventEmitter();
  const shutdownReasons = [];
  const { logger, records } = makeLogger();

  installUserControlCommands(bot, {
    authorizedUsers: ['Operator'],
    shutdown: (reason) => shutdownReasons.push(reason),
    logger,
  });

  bot.emit('chat', 'Operator', '!logout');
  bot.emit('chat', 'Steve', '!logout');

  assert.deepEqual(shutdownReasons, []);
  assert.equal(bot.listenerCount('chat'), 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].evt, 'user-command.disabled');
});

test('logout command stays disabled when no authorized users are configured', () => {
  const bot = new EventEmitter();
  const shutdownReasons = [];
  const { logger, records } = makeLogger();

  const installed = installUserControlCommands(bot, {
    authorizedUsers: [],
    shutdown: (reason) => shutdownReasons.push(reason),
    logger,
  });
  bot.emit('chat', 'Operator', '!logout');
  assert.deepEqual(shutdownReasons, []);
  assert.equal(installed.installed, false);
  assert.equal(bot.listenerCount('chat'), 0);
  assert.equal(records.at(-1).evt, 'user-command.disabled');
});
