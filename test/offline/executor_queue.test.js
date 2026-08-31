import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillExecutor } from '../../src/executor/queue.js';
import config from '../../src/config.js';
import interrupts from '../../src/reactive/interrupts.js';
import { SKILL_REGISTRY } from '../../src/skills/index.js';

function makeBot({ idle = true, owner = null } = {}) {
  return {
    pathfinderOwner: {
      bindCalls: 0,
      unbindCalls: 0,
      bindSkillSignal(controller) {
        this.bindCalls++;
        this.controller = controller;
      },
      unbindSkillSignal() {
        this.unbindCalls++;
        this.controller = null;
      },
      isIdle() {
        return typeof idle === 'function' ? idle() : idle;
      },
      currentOwner() {
        return typeof owner === 'function' ? owner() : owner;
      },
    },
  };
}

function makeLogger() {
  const records = [];
  const logger = {};
  for (const level of ['warn', 'error']) {
    logger[level] = (evt, fields = {}) => records.push({ level, evt, ...fields });
  }
  return { logger, records };
}

test('preempted skill result is retried without shifting the queue or emitting failure', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  const preempted = [];
  let calls = 0;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => {
    calls++;
    if (calls === 1) return { preempted: true, reason: 'test reactive preempt' };
    return { ok: true, reason: 'resumed ok', state: { resumed: true } };
  };

  executor.on('queue:failure', (event) => failures.push(event));
  executor.on('skill:preempted', (event) => preempted.push(event));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(calls, 2);
  assert.equal(executor.queue.length, 0);
  assert.equal(failures.length, 0);
  assert.equal(preempted.length, 1);
  assert.equal(bot.pathfinderOwner.bindCalls, 2);
  assert.equal(bot.pathfinderOwner.unbindCalls, 2);
});

test('executor exposes compact recent lifecycle events for advisor snapshots', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalReleasedAt = interrupts.lastReleasedAt;
  const longReason = 'x'.repeat(200);
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => ({ ok: false, reason: longReason, state: { raw: 'not for advisor' } });

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    interrupts.lastReleasedAt = originalReleasedAt;
  }

  const events = executor.recentEvents();
  assert.deepEqual(events.map((event) => event.event), [
    'queue.enqueue',
    'skill.start',
    'skill.result',
    'queue.failure',
  ]);
  assert.deepEqual(events[1], {
    seq: 2,
    event: 'skill.start',
    skill: 'observe',
    resume: false,
    attempt: 1,
    queueLeft: 0,
  });
  assert.equal(events[2].ok, false);
  assert.equal(events[2].reason, `${'x'.repeat(157)}...`);
  assert.equal(Number.isInteger(events[2].dtMs), true);
  assert.equal('params' in events[2], false);
  assert.equal('state' in events[2], false);
  assert.deepEqual(executor.recentEvents(2).map((event) => event.event), ['skill.result', 'queue.failure']);
});

test('executor invokes shared humanizer between consecutive skill calls', async (t) => {
  const calls = [];
  const bot = makeBot();
  bot.humanizer = {
    betweenActions: async (_bot, opts) => {
      calls.push(opts);
      return { ok: true, plan: { delayMs: 17 } };
    },
  };
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalReleasedAt = interrupts.lastReleasedAt;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => ({ ok: true, reason: 'ok' });

  try {
    executor.enqueue([{ skill: 'observe', params: {} }, { skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    interrupts.lastReleasedAt = originalReleasedAt;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'executor.between-skills');
  assert.equal(calls[0].previousSkill, 'observe');
  assert.equal(calls[0].nextSkill, 'observe');
  assert.deepEqual(
    executor.recentEvents().filter((event) => event.event === 'humanize.inter-action'),
    [{ seq: 4, event: 'humanize.inter-action', skill: 'observe', reason: 'observe->observe', dtMs: 17 }],
  );
});

test('executor stamps active call state with deterministic timing attempts', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalDebounceMs = config.reactive.resumeDebounceMs;
  const originalReleasedAt = interrupts.lastReleasedAt;
  const seen = [];
  let calls = 0;
  interrupts.lastReleasedAt = Date.now() - 5000;
  config.reactive.resumeDebounceMs = 5;

  SKILL_REGISTRY.observe = async (_bot, _params, ctx) => {
    calls++;
    seen.push({ ...ctx.callState._executor });
    if (calls === 1) {
      interrupts.notifyPreempt('timing test preempt');
      setTimeout(() => interrupts.notifyRelease('timing test release'), 10);
      return { preempted: true, reason: 'timing test preempt' };
    }
    return { ok: true, reason: 'timing test done' };
  };

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    config.reactive.resumeDebounceMs = originalDebounceMs;
    interrupts.lastReleasedAt = originalReleasedAt;
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0].attempts, 1);
  assert.equal(seen[1].attempts, 2);
  assert.equal(seen[1].startedAtMs, seen[0].startedAtMs);
  assert.ok(seen[1].lastInvokeAtMs >= seen[0].lastInvokeAtMs);
});

test('same queued call survives repeated reactive preempts before succeeding', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalDebounceMs = config.reactive.resumeDebounceMs;
  const failures = [];
  const preempted = [];
  const results = [];
  let calls = 0;
  interrupts.lastReleasedAt = Date.now() - 5000;
  config.reactive.resumeDebounceMs = 5;

  SKILL_REGISTRY.observe = async (_bot, _params, ctx) => {
    calls++;
    ctx.callState.attempts = (ctx.callState.attempts || 0) + 1;
    if (calls <= 2) {
      const reason = `test reactive preempt ${calls}`;
      interrupts.notifyPreempt(reason);
      setTimeout(() => interrupts.notifyRelease(`${reason} cleared`), 10);
      return { preempted: true, reason, state: { attempts: ctx.callState.attempts } };
    }
    return {
      ok: true,
      reason: 'resumed after repeated preempts',
      state: { attempts: ctx.callState.attempts },
    };
  };

  executor.on('queue:failure', (event) => failures.push(event));
  executor.on('skill:preempted', (event) => preempted.push(event));
  executor.on('skill:result', (event) => results.push(event));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    config.reactive.resumeDebounceMs = originalDebounceMs;
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(calls, 3);
  assert.equal(executor.queue.length, 0);
  assert.equal(failures.length, 0);
  assert.equal(preempted.length, 2);
  assert.deepEqual(preempted.map((event) => event.result.state.attempts), [1, 2]);
  assert.equal(results.length, 1);
  assert.equal(results[0].result.ok, true);
  assert.deepEqual(results[0].result.state, { attempts: 3 });
  assert.equal(bot.pathfinderOwner.bindCalls, 3);
  assert.equal(bot.pathfinderOwner.unbindCalls, 3);
});

test('waitForResume waits until pathfinder owner is idle', async (t) => {
  let idle = false;
  const bot = makeBot({ idle: () => idle });
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  interrupts.lastReleasedAt = Date.now() - 5000;

  const started = Date.now();
  const wait = executor._waitForResume();
  setTimeout(() => { idle = true; }, 75);

  await wait;

  assert.ok(Date.now() - started >= 50);
});

test('resume gate timeout fails queue without shifting call when pathfinder stays busy after release', async (t) => {
  const bot = makeBot({ idle: false });
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalTimeout = config.executor.resumeGateTimeoutMs;
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  let invoked = 0;
  interrupts.lastReleasedAt = Date.now() - 5000;
  config.executor.resumeGateTimeoutMs = 60;

  SKILL_REGISTRY.observe = async () => {
    invoked++;
    return { ok: true, reason: 'should not run' };
  };
  executor.on('queue:failure', (event) => failures.push(event));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    config.executor.resumeGateTimeoutMs = originalTimeout;
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(invoked, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].result.reason, /resume gate timed out waiting for pathfinder idle/);
  assert.equal(executor.queue.length, 1);
  assert.equal(executor.queue[0].skill, 'observe');
});

test('resume gate timeout reports owner read failures without crashing', async (t) => {
  const bot = makeBot({
    idle: false,
    owner: () => {
      throw new Error('owner read failed');
    },
  });
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalTimeout = config.executor.resumeGateTimeoutMs;
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  let invoked = 0;
  interrupts.lastReleasedAt = Date.now() - 5000;
  config.executor.resumeGateTimeoutMs = 60;

  SKILL_REGISTRY.observe = async () => {
    invoked++;
    return { ok: true, reason: 'should not run' };
  };
  executor.on('queue:failure', (event) => failures.push(event));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    config.executor.resumeGateTimeoutMs = originalTimeout;
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(invoked, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].result.reason, /resume gate timed out waiting for pathfinder idle/);
  assert.equal(failures[0].result.state.owner, null);
  assert.equal(failures[0].result.state.ownerError, 'owner read failed');
  assert.equal(executor.queue.length, 1);
  assert.equal(executor.queue[0].skill, 'observe');
});

test('resume gate reports pathfinder idle read failures as queue failures', async (t) => {
  const bot = makeBot({
    idle: () => {
      throw new Error('idle read failed');
    },
  });
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  let invoked = 0;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => {
    invoked++;
    return { ok: true, reason: 'should not run' };
  };
  executor.on('queue:failure', (event) => failures.push(event));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(invoked, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].result.reason, 'resume gate failed reading pathfinder idle: idle read failed');
  assert.equal(failures[0].result.state.err, 'idle read failed');
  assert.equal(executor.queue.length, 1);
  assert.equal(executor.queue[0].skill, 'observe');
});

test('resume gate timeout does not count time while reactive is still paused', async (t) => {
  let idle = false;
  const bot = makeBot({ idle: () => idle });
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalTimeout = config.executor.resumeGateTimeoutMs;
  interrupts.lastReleasedAt = Date.now() - 5000;
  config.executor.resumeGateTimeoutMs = 50;
  executor.paused = true;

  try {
    const wait = executor._waitForResume();
    await sleep(90);
    executor.paused = false;
    idle = true;
    const result = await wait;
    assert.deepEqual(result, { ok: true });
  } finally {
    config.executor.resumeGateTimeoutMs = originalTimeout;
  }
});

test('executor context provider cannot override executor-owned invocation fields', async (t) => {
  const bot = makeBot();
  const originalObserve = SKILL_REGISTRY.observe;
  const externalSignal = new AbortController().signal;
  const externalCallState = { injected: true };
  let seen = null;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async (_bot, _params, ctx) => {
    seen = ctx;
    return { ok: true, reason: 'context ok' };
  };

  try {
    const executor = new SkillExecutor(bot, {
      contextProvider: () => ({
        signal: externalSignal,
        callState: externalCallState,
        currentSubtask: 'injected-subtask',
        remainingQueue: [{ skill: 'logout', params: {} }],
        worldModelStore: { load: () => null },
      }),
    });
    t.after(() => executor.dispose());
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.notEqual(seen.signal, externalSignal);
  assert.notEqual(seen.callState, externalCallState);
  assert.deepEqual(Object.keys(seen.callState), ['_executor']);
  assert.equal(seen.callState._executor.attempts, 1);
  assert.equal(Number.isFinite(seen.callState._executor.startedAtMs), true);
  assert.equal(Number.isFinite(seen.callState._executor.lastInvokeAtMs), true);
  assert.equal(seen.currentSubtask, 'observe({})');
  assert.deepEqual(seen.remainingQueue, []);
  assert.equal(typeof seen.worldModelStore.load, 'function');
});

test('queue replacement request swaps only at a skill boundary', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalLogout = SKILL_REGISTRY.logout;
  const starts = [];
  const logoutReasons = [];
  let releaseObserve;
  let requested;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => {
    const replacement = executor.requestQueueReplacement([
      { skill: 'logout', params: { reason: 'new-plan' } },
    ], { reason: 'advisor proposal' });
    requested = replacement;
    await new Promise((resolve) => { releaseObserve = resolve; });
    return { ok: true, reason: 'observe done' };
  };
  SKILL_REGISTRY.logout = async (_bot, params) => {
    logoutReasons.push(params.reason);
    return { ok: true, reason: 'logout stub' };
  };
  executor.on('skill:start', (call) => starts.push(`${call.skill}:${call.params?.reason || ''}`));

  try {
    executor.enqueue([
      { skill: 'observe', params: {} },
      { skill: 'logout', params: { reason: 'old-plan' } },
    ]);
    const running = executor.runUntilDone();
    while (!requested) await sleep(5);

    assert.deepEqual(requested, { ok: true, count: 1 });
    assert.equal(executor.queue.length, 2);
    assert.equal(executor.queue[0].skill, 'observe');
    assert.equal(executor.queue[1].params.reason, 'old-plan');

    releaseObserve();
    await running;
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    SKILL_REGISTRY.logout = originalLogout;
  }

  assert.deepEqual(starts, ['observe:', 'logout:new-plan']);
  assert.deepEqual(logoutReasons, ['new-plan']);
  assert.equal(executor.queue.length, 0);
});

test('queue prefix request prepends work at the next skill boundary', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalLogout = SKILL_REGISTRY.logout;
  const starts = [];
  const logoutReasons = [];
  let releaseObserve;
  let requested;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => {
    requested = executor.requestQueuePrefix([
      { skill: 'logout', params: { reason: 'recovery-prefix' } },
    ], { reason: 'death-drop-recovery' });
    await new Promise((resolve) => { releaseObserve = resolve; });
    return { ok: true, reason: 'observe done' };
  };
  SKILL_REGISTRY.logout = async (_bot, params) => {
    logoutReasons.push(params.reason);
    return { ok: true, reason: 'logout stub' };
  };
  executor.on('skill:start', (call) => starts.push(`${call.skill}:${call.params?.reason || ''}`));

  try {
    executor.enqueue([
      { skill: 'observe', params: {} },
      { skill: 'logout', params: { reason: 'original-remaining' } },
    ]);
    const running = executor.runUntilDone();
    while (!requested) await sleep(5);

    assert.deepEqual(requested, { ok: true, count: 1 });
    assert.equal(executor.queue.length, 2);
    assert.equal(executor.queue[0].skill, 'observe');
    assert.equal(executor.queue[1].params.reason, 'original-remaining');

    releaseObserve();
    await running;
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    SKILL_REGISTRY.logout = originalLogout;
  }

  assert.deepEqual(starts, ['observe:', 'logout:recovery-prefix', 'logout:original-remaining']);
  assert.deepEqual(logoutReasons, ['recovery-prefix', 'original-remaining']);
  assert.equal(executor.queue.length, 0);
});

test('queue prefix survives a pending queue replacement at the same boundary', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalLogout = SKILL_REGISTRY.logout;
  const starts = [];
  let releaseObserve;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => {
    executor.requestQueueReplacement([
      { skill: 'logout', params: { reason: 'replacement-plan' } },
    ], { reason: 'advisor proposal' });
    executor.requestQueuePrefix([
      { skill: 'logout', params: { reason: 'recovery-prefix' } },
    ], { reason: 'death-drop-recovery' });
    await new Promise((resolve) => { releaseObserve = resolve; });
    return { ok: true, reason: 'observe done' };
  };
  SKILL_REGISTRY.logout = async () => ({ ok: true, reason: 'logout stub' });
  executor.on('skill:start', (call) => starts.push(`${call.skill}:${call.params?.reason || ''}`));

  try {
    executor.enqueue([
      { skill: 'observe', params: {} },
      { skill: 'logout', params: { reason: 'original-remaining' } },
    ]);
    const running = executor.runUntilDone();
    while (!releaseObserve) await sleep(5);
    releaseObserve();
    await running;
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    SKILL_REGISTRY.logout = originalLogout;
  }

  assert.deepEqual(starts, ['observe:', 'logout:recovery-prefix', 'logout:replacement-plan']);
  assert.equal(executor.queue.length, 0);
});

test('queue prefix can run before retrying a preempted call', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const originalLogout = SKILL_REGISTRY.logout;
  const starts = [];
  let observeCalls = 0;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => {
    observeCalls += 1;
    if (observeCalls === 1) {
      executor.requestQueuePrefix([
        { skill: 'logout', params: { reason: 'recover-before-retry' } },
      ], { reason: 'death-drop-recovery' });
      return { preempted: true, reason: 'death recovery requested' };
    }
    return { ok: true, reason: 'observe retried' };
  };
  SKILL_REGISTRY.logout = async () => ({ ok: true, reason: 'logout stub' });
  executor.on('skill:start', (call) => starts.push(`${call.skill}:${call.params?.reason || ''}`));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
    SKILL_REGISTRY.logout = originalLogout;
  }

  assert.deepEqual(starts, ['observe:', 'logout:recover-before-retry', 'observe:']);
  assert.equal(observeCalls, 2);
  assert.equal(executor.queue.length, 0);
});

test('requestCurrentSkillAbort aborts the active skill signal', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const seenReasons = [];
  let calls = 0;
  let waitingForAbort = false;
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async (_bot, _params, ctx) => {
    calls += 1;
    if (calls > 1) return { ok: true, reason: 'retry succeeded' };
    return new Promise((resolve) => {
      waitingForAbort = true;
      ctx.signal.addEventListener('abort', () => {
        seenReasons.push(ctx.signal.reason);
        resolve({ preempted: true, reason: 'aborted by test' });
      }, { once: true });
    });
  };

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    const running = executor.runUntilDone();
    while (!waitingForAbort) await sleep(5);
    const abort = executor.requestCurrentSkillAbort('unit-test abort');
    await running;

    assert.deepEqual(abort, { ok: true, reason: 'unit-test abort' });
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.deepEqual(seenReasons, ['unit-test abort']);
  assert.equal(calls, 2);
});

test('invalid queue replacement proposal does not alter active queue', async (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  executor.enqueue([{ skill: 'observe', params: {} }]);
  const result = executor.requestQueueReplacement([{ skill: 'not_a_skill', params: {} }]);

  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown skill "not_a_skill"/);
  assert.equal(executor.pendingQueueReplacement, null);
  assert.deepEqual(executor.queue.map((call) => call.skill), ['observe']);
});

test('enqueue rejects non-json params without crashing invalid-call logging', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());
  const params = {};
  params.self = params;

  assert.throws(
    () => executor.enqueue([{ skill: 'observe', params }]),
    /Invalid skill call: observe: params must be JSON-compatible/,
  );
  assert.equal(executor.queue.length, 0);
});

test('enqueue rejects unknown params without altering the queue', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  assert.throws(
    () => executor.enqueue([{ skill: 'logout', params: { reason: 'done', extra: true } }]),
    /Invalid skill call: logout: unknown param "extra"/,
  );
  assert.equal(executor.queue.length, 0);
});

test('enqueue clones admitted params and always discards caller-supplied runtime state', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());
  const call = {
    skill: 'mine_with_progression',
    params: { ores: ['iron_ore'], count: 1 },
    _state: {
      prepCalls: [{ skill: 'place_workstation', params: { workstation: 'furnace', action: 'place' } }],
    },
  };

  executor.enqueue([call]);
  call.params.ores[0] = 'diamond_ore';
  call._state.prepCalls[0].skill = 'logout';

  assert.notEqual(executor.queue[0], call);
  assert.deepEqual(executor.queue[0].params, { ores: ['iron_ore'], count: 1 });
  assert.deepEqual(executor.queue[0]._state, {});
});

test('executor inherits the bot world-action runtime context when none is supplied', (t) => {
  const bot = makeBot();
  const runtimeContext = { worldActionAuthorization: { version: 1 } };
  bot.runtimeContext = runtimeContext;
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());

  assert.equal(executor.context, runtimeContext);
});

test('enqueue rejects invalid param types without altering the queue', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  assert.throws(
    () => executor.enqueue([{ skill: 'craft', params: { item: 'stick', count: '1' } }]),
    /Invalid skill call: craft: "count" must be number/,
  );
  assert.equal(executor.queue.length, 0);
});

test('enqueue rejects invalid numeric ranges without altering the queue', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  assert.throws(
    () => executor.enqueue([{ skill: 'collect', params: { block: 'oak_log', count: 0 } }]),
    /Invalid skill call: collect: "count" must be >= 1/,
  );
  assert.equal(executor.queue.length, 0);
});

test('enqueue rejects invalid nested params without altering the queue', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  assert.throws(
    () => executor.enqueue([{ skill: 'deposit', params: { items: [{ count: 1 }] } }]),
    /Invalid skill call: deposit: "items\[0\]\.name" is required/,
  );
  assert.equal(executor.queue.length, 0);
});

test('enqueue rejects malformed schematic block params without altering the queue', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  assert.throws(
    () => executor.enqueue([{
      skill: 'build_from_schematic',
      params: {
        blocks: [{ name: 'oak_planks' }],
        anchor: { x: 0, y: 64, z: 0 },
        dryRun: true,
      },
    }]),
    /Invalid skill call: build_from_schematic: "blocks\[0\]" must include one of offset\|position\|\{x,y,z\}/,
  );
  assert.equal(executor.queue.length, 0);
});

test('enqueue rejects build schematic calls without dryRun true', (t) => {
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  assert.throws(
    () => executor.enqueue([{
      skill: 'build_from_schematic',
      params: {
        blocks: [{ name: 'oak_planks', x: 0, y: 0, z: 0 }],
        anchor: { x: 0, y: 64, z: 0 },
      },
    }]),
    /Invalid skill call: build_from_schematic: missing required param "dryRun"/,
  );
  assert.equal(executor.queue.length, 0);
});

test('terminal failure discards pending queue replacement proposals', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => {
    executor.requestQueueReplacement([
      { skill: 'logout', params: { reason: 'stale-proposal' } },
    ], { reason: 'stale after failure' });
    return { ok: false, reason: 'observe failed' };
  };
  executor.on('queue:failure', (event) => failures.push(event));

  try {
    executor.enqueue([
      { skill: 'observe', params: {} },
      { skill: 'logout', params: { reason: 'original-remaining' } },
    ]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(failures.length, 1);
  assert.equal(executor.pendingQueueReplacement, null);
  assert.equal(executor.queue.length, 1);
  assert.equal(executor.queue[0].params.reason, 'original-remaining');
});

test('terminal failure does not emit queue empty', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  const empties = [];
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => ({ ok: false, reason: 'planned failure' });
  executor.on('queue:failure', (event) => failures.push(event));
  executor.on('queue:empty', () => empties.push(true));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(failures.length, 1);
  assert.equal(failures[0].call.skill, 'observe');
  assert.equal(failures[0].result.reason, 'planned failure');
  assert.equal(empties.length, 0);
  assert.equal(executor.queue.length, 0);
});

test('terminal failure clears current call while preserving remaining queue', async (t) => {
  const bot = makeBot();
  const executor = new SkillExecutor(bot);
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  const starts = [];
  interrupts.lastReleasedAt = Date.now() - 5000;

  SKILL_REGISTRY.observe = async () => ({ ok: false, reason: 'first failed' });
  executor.on('skill:start', (call) => starts.push(call.skill));
  executor.on('queue:failure', (event) => failures.push(event));

  try {
    executor.enqueue([
      { skill: 'observe', params: {} },
      { skill: 'logout', params: {} },
    ]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.deepEqual(starts, ['observe']);
  assert.equal(failures.length, 1);
  assert.equal(executor.queue.length, 1);
  assert.equal(executor.queue[0].skill, 'logout');
  assert.equal(executor.currentCall, null);
  assert.equal(executor.currentSubtask, null);
});

test('interrupt listener registration failures fail closed before skill execution', async (t) => {
  const { logger, records } = makeLogger();
  const interruptBus = {
    lastReleasedAt: Date.now() - 5000,
    on(eventName) {
      if (eventName === 'preempted') throw new Error('preempt listener unavailable');
    },
    off() {},
  };
  const bot = makeBot();
  const executor = new SkillExecutor(bot, { interruptBus, logger });
  t.after(() => executor.dispose());
  const originalObserve = SKILL_REGISTRY.observe;
  const failures = [];
  let calls = 0;

  SKILL_REGISTRY.observe = async () => {
    calls += 1;
    return { ok: true, reason: 'should not run' };
  };
  executor.on('queue:failure', (event) => failures.push(event));

  try {
    executor.enqueue([{ skill: 'observe', params: {} }]);
    await executor.runUntilDone();
  } finally {
    SKILL_REGISTRY.observe = originalObserve;
  }

  assert.equal(executor.interruptListenersReady, false);
  assert.equal(calls, 0);
  assert.equal(bot.pathfinderOwner.bindCalls, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].call.skill, 'observe');
  assert.equal(failures[0].result.reason, 'executor interrupt listeners unavailable');
  assert.equal(executor.queue.length, 1);
  assert.deepEqual(records, [
    { level: 'error', evt: 'interrupt.listener-add-error', event: 'preempted', err: 'preempt listener unavailable' },
  ]);
});

test('dispose reports interrupt listener removal failures', () => {
  const { logger, records } = makeLogger();
  const interruptBus = {
    lastReleasedAt: Date.now() - 5000,
    on() {},
    off(eventName) {
      throw new Error(`${eventName} cleanup unavailable`);
    },
  };
  const executor = new SkillExecutor(makeBot(), { interruptBus, logger });

  assert.doesNotThrow(() => executor.dispose());
  assert.deepEqual(records, [
    { level: 'warn', evt: 'interrupt.listener-remove-error', event: 'preempted', err: 'preempted cleanup unavailable' },
    { level: 'warn', evt: 'interrupt.listener-remove-error', event: 'released', err: 'released cleanup unavailable' },
  ]);

  assert.doesNotThrow(() => executor.dispose());
  assert.equal(records.length, 2);
});

test('dispose detaches executor from global interrupt bus', (t) => {
  const baselinePreempted = interrupts.listenerCount('preempted');
  const baselineReleased = interrupts.listenerCount('released');
  const executor = new SkillExecutor(makeBot());
  t.after(() => executor.dispose());

  assert.equal(interrupts.listenerCount('preempted'), baselinePreempted + 1);
  assert.equal(interrupts.listenerCount('released'), baselineReleased + 1);

  executor.dispose();

  assert.equal(interrupts.listenerCount('preempted'), baselinePreempted);
  assert.equal(interrupts.listenerCount('released'), baselineReleased);

  interrupts.notifyPreempt('after-dispose');
  assert.equal(executor.paused, false);

  executor.dispose();
  assert.equal(interrupts.listenerCount('preempted'), baselinePreempted);
  assert.equal(interrupts.listenerCount('released'), baselineReleased);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
