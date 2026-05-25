import test from 'node:test';
import assert from 'node:assert/strict';

import { createGracefulShutdown, shutdownRuntime } from '../../src/runtime/shutdown.js';

function makeLogger() {
  const records = [];
  const logger = {
    warn(evt, fields = {}) { records.push({ lvl: 'warn', evt, ...fields }); },
    error(evt, fields = {}) { records.push({ lvl: 'error', evt, ...fields }); },
  };
  return { logger, records };
}

test('shutdownRuntime disposes executor and quits bot before scheduled exit', () => {
  const calls = [];
  const { logger, records } = makeLogger();
  let scheduled = null;
  let exitCode = null;

  const timer = shutdownRuntime({
    reason: 'unit',
    executor: { dispose: () => calls.push('dispose') },
    bot: { quit: (reason) => calls.push(`quit:${reason}`) },
    logger,
    exit: (code) => { exitCode = code; },
    setTimeoutFn: (fn, ms) => {
      scheduled = { fn, ms };
      return 'timer';
    },
  });

  assert.equal(timer, 'timer');
  assert.deepEqual(calls, ['dispose', 'quit:unit']);
  assert.deepEqual(records, [{ lvl: 'warn', evt: 'shutdown', reason: 'unit' }]);
  assert.equal(scheduled.ms, 500);

  scheduled.fn();
  assert.equal(exitCode, 0);
});

test('shutdownRuntime logs cleanup failures without skipping later cleanup', () => {
  const calls = [];
  const { logger, records } = makeLogger();

  shutdownRuntime({
    reason: 'SIGTERM',
    executor: {
      dispose: () => {
        calls.push('dispose');
        throw new Error('dispose failed');
      },
    },
    bot: {
      quit: (reason) => {
        calls.push(`quit:${reason}`);
        throw new Error('quit failed');
      },
    },
    logger,
    exit: () => {},
    setTimeoutFn: () => 'timer',
  });

  assert.deepEqual(calls, ['dispose', 'quit:SIGTERM']);
  assert.deepEqual(records, [
    { lvl: 'warn', evt: 'shutdown', reason: 'SIGTERM' },
    { lvl: 'error', evt: 'shutdown.dispose-error', reason: 'SIGTERM', err: 'dispose failed' },
    { lvl: 'error', evt: 'shutdown.quit-error', reason: 'SIGTERM', err: 'quit failed' },
  ]);
});

test('createGracefulShutdown makes signal logout idempotent', () => {
  const calls = [];
  const { logger, records } = makeLogger();
  let exitCalls = 0;

  const shutdown = createGracefulShutdown({
    reason: 'unused',
    executor: { dispose: () => calls.push('dispose') },
    bot: { quit: (reason) => calls.push(`quit:${reason}`) },
    logger,
    exit: () => { exitCalls += 1; },
    setTimeoutFn: (fn) => {
      fn();
      return 'timer';
    },
  });

  assert.equal(shutdown('SIGINT'), 'timer');
  assert.equal(shutdown('SIGINT'), null);
  assert.deepEqual(calls, ['dispose', 'quit:SIGINT']);
  assert.equal(exitCalls, 1);
  assert.deepEqual(records, [
    { lvl: 'warn', evt: 'shutdown', reason: 'SIGINT' },
    { lvl: 'warn', evt: 'shutdown.duplicate', reason: 'SIGINT' },
  ]);
});
