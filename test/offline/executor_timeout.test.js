import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../../src/config.js';
import { SkillExecutor } from '../../src/executor/queue.js';
import interrupts from '../../src/reactive/interrupts.js';
import { SKILL_REGISTRY } from '../../src/skills/index.js';

function makeBot() {
  return {
    pathfinderOwner: {
      bindSkillSignal(controller) {
        this.controller = controller;
      },
      unbindSkillSignal() {
        this.controller = null;
      },
      isIdle() {
        return true;
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
    return originalWrite.call(process.stdout, chunk, ...args);
  };

  let value;
  try {
    value = await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  const records = writes
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
  return { value, records };
}

test('executor converts a hung skill into a terminal timeout failure', async (t) => {
  const originalObserve = SKILL_REGISTRY.observe;
  const originalTimeout = config.executor.skillTimeoutMs;
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const failures = [];
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => new Promise(() => {});
  config.executor.skillTimeoutMs = 25;
  executor.on('queue:failure', (event) => failures.push(event));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    config.executor.skillTimeoutMs = originalTimeout;
  }

  assert.equal(failures.length, 1);
  assert.equal(failures[0].call.skill, 'observe');
  assert.equal(failures[0].result.ok, false);
  assert.equal(failures[0].result.reason, 'skill threw: skill timed out');
  assert.equal(executor.queue.length, 0);
  assert.equal(bot.pathfinderOwner.controller, null);
});

test('executor aborts the in-flight skill signal when a skill times out', async (t) => {
  const originalObserve = SKILL_REGISTRY.observe;
  const originalTimeout = config.executor.skillTimeoutMs;
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  interrupts.lastReleasedAt = Date.now() - 5000;

  let signalAborted = false;
  let abortReason = null;
  SKILL_REGISTRY.observe = async (_bot, _params, ctx) => new Promise(() => {
    ctx.signal.addEventListener('abort', () => {
      signalAborted = true;
      abortReason = ctx.signal.reason;
    });
  });
  config.executor.skillTimeoutMs = 25;

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    config.executor.skillTimeoutMs = originalTimeout;
  }

  assert.equal(signalAborted, true);
  assert.equal(abortReason, 'skill timed out');
  assert.equal(bot.pathfinderOwner.controller, null);
});

test('executor ignores and logs a skill result that arrives after timeout', async (t) => {
  const originalObserve = SKILL_REGISTRY.observe;
  const originalTimeout = config.executor.skillTimeoutMs;
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  const late = deferred();
  t.after(() => executor.dispose());
  interrupts.lastReleasedAt = Date.now() - 5000;

  const results = [];
  const failures = [];
  let emptyCount = 0;
  SKILL_REGISTRY.observe = async () => late.promise;
  config.executor.skillTimeoutMs = 25;
  executor.on('skill:result', (event) => results.push(event));
  executor.on('queue:failure', (event) => failures.push(event));
  executor.on('queue:empty', () => { emptyCount += 1; });

  let records;
  try {
    ({ records } = await captureStdoutRecords(async () => {
      executor.enqueue([{ skill: 'observe', params: {} }]);
      await executor.runUntilDone();

      assert.equal(results.length, 1);
      assert.equal(results[0].result.ok, false);
      assert.equal(results[0].result.reason, 'skill threw: skill timed out');
      assert.equal(failures.length, 1);
      assert.equal(emptyCount, 0);
      assert.equal(executor.queue.length, 0);

      late.resolve({ ok: true, reason: 'late success ignored' });
      await waitImmediate();
    }));
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    config.executor.skillTimeoutMs = originalTimeout;
  }

  assert.equal(results.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(emptyCount, 0);
  const lateLog = records.find((record) => record.evt === 'skill.timeout-late-result');
  assert.ok(lateLog);
  assert.equal(lateLog.skill, 'observe');
  assert.equal(lateLog.ok, true);
  assert.equal(lateLog.reason, 'late success ignored');
});

test('executor logs a skill rejection that arrives after timeout', async (t) => {
  const originalObserve = SKILL_REGISTRY.observe;
  const originalTimeout = config.executor.skillTimeoutMs;
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  const late = deferred();
  t.after(() => executor.dispose());
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => late.promise;
  config.executor.skillTimeoutMs = 25;

  let records;
  try {
    ({ records } = await captureStdoutRecords(async () => {
      executor.enqueue([{ skill: 'observe', params: {} }]);
      await executor.runUntilDone();

      late.reject(new Error('late boom ignored'));
      await waitImmediate();
    }));
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    config.executor.skillTimeoutMs = originalTimeout;
  }

  const lateLog = records.find((record) => record.evt === 'skill.timeout-late-error');
  assert.ok(lateLog);
  assert.equal(lateLog.skill, 'observe');
  assert.equal(lateLog.err, 'late boom ignored');
});
