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

test('authorized user can trigger chat logout command', () => {
  const bot = new EventEmitter();
  const shutdownReasons = [];
  const { logger, records } = makeLogger();

  const installed = installUserControlCommands(bot, {
    authorizedUsers: ['Operator'],
    logoutCommand: '!logout',
    shutdown: (reason) => shutdownReasons.push(reason),
    logger,
  });

  assert.equal(installed.installed, true);
  bot.emit('chat', 'Operator', '!logout');

  assert.deepEqual(shutdownReasons, ['chat:!logout:Operator']);
  assert.deepEqual(records, [
    { level: 'info', evt: 'user-command.installed', logoutCommand: '!logout', authorizedUserCount: 1 },
    { level: 'warn', evt: 'user-command.logout-accepted', username: 'Operator', command: '!logout' },
  ]);
});

test('unauthorized logout command is rejected without shutdown', () => {
  const bot = new EventEmitter();
  const shutdownReasons = [];
  const { logger, records } = makeLogger();

  installUserControlCommands(bot, {
    authorizedUsers: ['Operator'],
    shutdown: (reason) => shutdownReasons.push(reason),
    logger,
  });

  bot.emit('chat', 'Steve', '!logout');

  assert.deepEqual(shutdownReasons, []);
  assert.deepEqual(records.slice(1), [
    {
      level: 'warn',
      evt: 'user-command.logout-rejected',
      username: 'Steve',
      reason: 'unauthorized-user',
    },
  ]);
});

test('logout command stays disabled when no authorized users are configured', () => {
  const bot = new EventEmitter();
  const shutdownReasons = [];
  const { logger, records } = makeLogger();

  installUserControlCommands(bot, {
    authorizedUsers: [],
    shutdown: (reason) => shutdownReasons.push(reason),
    logger,
  });

  bot.emit('chat', 'Operator', '!logout');

  assert.deepEqual(shutdownReasons, []);
  assert.equal(records[1].evt, 'user-command.logout-rejected');
  assert.equal(records[1].reason, 'no-authorized-users-configured');
});
