import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../../src/config.js';
import {
  closeContainer,
  depositContainer,
  openContainer,
  withdrawContainer,
} from '../../src/skills/_containers.js';

async function captureStdoutRecords(fn) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function write(chunk, ...args) {
    const text = String(chunk);
    if (text.trim().startsWith('{')) {
      writes.push(text);
      if (typeof args.at(-1) === 'function') args.at(-1)();
      return true;
    }
    return originalWrite.call(this, chunk, ...args);
  };
  try {
    const value = await fn();
    return {
      value,
      records: writes
        .flatMap((text) => text.trim().split(/\r?\n/).filter(Boolean))
        .map((line) => JSON.parse(line)),
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('closeContainer times out hung container cleanup', async (t) => {
  const originalTimeout = config.executor.containerCloseTimeoutMs;
  config.executor.containerCloseTimeoutMs = 20;
  t.after(() => {
    config.executor.containerCloseTimeoutMs = originalTimeout;
  });

  const { value, records } = await captureStdoutRecords(() => closeContainer(
    { close: () => new Promise(() => {}) },
    { skill: 'test-close', position: { x: 1, y: 2, z: 3 } },
  ));

  assert.equal(value, false);
  const timeoutRecord = records.find((record) => record.evt === 'container.close-timeout');
  assert.ok(timeoutRecord);
  assert.deepEqual(
    timeoutRecord,
    {
      t: timeoutRecord.t,
      lvl: 'warn',
      loop: 'executor',
      evt: 'container.close-timeout',
      skill: 'test-close',
      position: { x: 1, y: 2, z: 3 },
      timeoutMs: 20,
      err: 'container close timed out after 20ms',
    },
  );
});

test('openContainer times out hung container opens', async (t) => {
  const originalTimeout = config.executor.containerOpenTimeoutMs;
  config.executor.containerOpenTimeoutMs = 20;
  t.after(() => {
    config.executor.containerOpenTimeoutMs = originalTimeout;
  });

  const { value, records } = await captureStdoutRecords(async () => {
    try {
      await openContainer(
        { openContainer: () => new Promise(() => {}) },
        { name: 'chest' },
        { skill: 'test-open', position: { x: 4, y: 5, z: 6 } },
        { authorize: () => ({ ok: true }) },
      );
    } catch (err) {
      return err;
    }
    return null;
  });

  assert.equal(value?.code, 'CONTAINER_OPEN_TIMEOUT');
  assert.equal(value?.message, 'container open timed out after 20ms');
  const timeoutRecord = records.find((record) => record.evt === 'container.open-timeout');
  assert.ok(timeoutRecord);
  assert.deepEqual(
    timeoutRecord,
    {
      t: timeoutRecord.t,
      lvl: 'warn',
      loop: 'executor',
      evt: 'container.open-timeout',
      skill: 'test-open',
      position: { x: 4, y: 5, z: 6 },
      timeoutMs: 20,
      err: 'container open timed out after 20ms',
    },
  );
});

test('openContainer aborts hung container opens before timeout', async (t) => {
  const originalTimeout = config.executor.containerOpenTimeoutMs;
  config.executor.containerOpenTimeoutMs = 1000;
  t.after(() => {
    config.executor.containerOpenTimeoutMs = originalTimeout;
  });

  const controller = new AbortController();
  const started = Date.now();
  const resultPromise = openContainer(
    { openContainer: () => new Promise(() => {}) },
    { name: 'chest' },
    { skill: 'test-open-abort' },
    { signal: controller.signal, authorize: () => ({ ok: true }) },
  ).catch((err) => err);
  setTimeout(() => controller.abort('reactive-preempt'), 10);

  const err = await resultPromise;

  assert.equal(err?.code, 'CONTAINER_OPEN_ABORTED');
  assert.equal(err?.message, 'container open aborted');
  assert.ok(Date.now() - started < 250);
});

test('container open and transfer helpers fail closed without authorization', async () => {
  let openCalls = 0;
  let depositCalls = 0;
  const openError = await openContainer(
    { openContainer: async () => { openCalls += 1; } },
    { name: 'chest', position: { x: 1, y: 64, z: 1 } },
  ).catch((error) => error);
  const transferError = await depositContainer(
    { deposit: async () => { depositCalls += 1; } },
    1,
    null,
    1,
  ).catch((error) => error);

  assert.equal(openError?.code, 'WORLD_ACTION_DENIED');
  assert.equal(transferError?.code, 'WORLD_ACTION_DENIED');
  assert.equal(openCalls, 0);
  assert.equal(depositCalls, 0);
});

test('depositContainer times out hung container deposits', async (t) => {
  const originalTimeout = config.executor.containerTransferTimeoutMs;
  config.executor.containerTransferTimeoutMs = 20;
  t.after(() => {
    config.executor.containerTransferTimeoutMs = originalTimeout;
  });

  const { value, records } = await captureStdoutRecords(async () => {
    try {
      await depositContainer(
        { deposit: () => new Promise(() => {}) },
        1,
        null,
        2,
        { skill: 'test-transfer', item: 'oak_log', count: 2 },
        { authorize: () => ({ ok: true }) },
      );
    } catch (err) {
      return err;
    }
    return null;
  });

  assert.equal(value?.code, 'CONTAINER_DEPOSIT_TIMEOUT');
  assert.equal(value?.message, 'container deposit timed out after 20ms');
  const timeoutRecord = records.find((record) => record.evt === 'container.deposit-timeout');
  assert.ok(timeoutRecord);
  assert.deepEqual(
    timeoutRecord,
    {
      t: timeoutRecord.t,
      lvl: 'warn',
      loop: 'executor',
      evt: 'container.deposit-timeout',
      skill: 'test-transfer',
      item: 'oak_log',
      count: 2,
      timeoutMs: 20,
      err: 'container deposit timed out after 20ms',
    },
  );
});

test('depositContainer aborts hung transfers before timeout', async (t) => {
  const originalTimeout = config.executor.containerTransferTimeoutMs;
  config.executor.containerTransferTimeoutMs = 1000;
  t.after(() => {
    config.executor.containerTransferTimeoutMs = originalTimeout;
  });

  const controller = new AbortController();
  const started = Date.now();
  const resultPromise = depositContainer(
    { deposit: () => new Promise(() => {}) },
    1,
    null,
    2,
    { skill: 'test-transfer-abort', item: 'oak_log', count: 2 },
    { signal: controller.signal, authorize: () => ({ ok: true }) },
  ).catch((err) => err);
  setTimeout(() => controller.abort('reactive-preempt'), 10);

  const err = await resultPromise;

  assert.equal(err?.code, 'CONTAINER_DEPOSIT_ABORTED');
  assert.equal(err?.message, 'container deposit aborted');
  assert.ok(Date.now() - started < 250);
});

test('withdrawContainer times out hung container withdrawals', async (t) => {
  const originalTimeout = config.executor.containerTransferTimeoutMs;
  config.executor.containerTransferTimeoutMs = 20;
  t.after(() => {
    config.executor.containerTransferTimeoutMs = originalTimeout;
  });

  const { value, records } = await captureStdoutRecords(async () => {
    try {
      await withdrawContainer(
        { withdraw: () => new Promise(() => {}) },
        1,
        null,
        3,
        { skill: 'test-transfer', item: 'oak_log', count: 3 },
        { authorize: () => ({ ok: true }) },
      );
    } catch (err) {
      return err;
    }
    return null;
  });

  assert.equal(value?.code, 'CONTAINER_WITHDRAW_TIMEOUT');
  assert.equal(value?.message, 'container withdraw timed out after 20ms');
  const timeoutRecord = records.find((record) => record.evt === 'container.withdraw-timeout');
  assert.ok(timeoutRecord);
  assert.deepEqual(
    timeoutRecord,
    {
      t: timeoutRecord.t,
      lvl: 'warn',
      loop: 'executor',
      evt: 'container.withdraw-timeout',
      skill: 'test-transfer',
      item: 'oak_log',
      count: 3,
      timeoutMs: 20,
      err: 'container withdraw timed out after 20ms',
    },
  );
});
