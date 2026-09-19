import assert from 'node:assert/strict';
import test from 'node:test';

import { createMissionBrainHandler } from './mission-brain.js';
import { createInitialState } from './mission-sim.js';

function descentReady(overrides = {}) {
  return createInitialState({
    logs: 6, planks: 16, sticks: 12, woodenPickaxes: 1, cobblestone: 12,
    stonePickaxes: 2, stoneSwords: 1, furnaces: 1, craftingTables: 1,
    tablePlaced: false, atIronDepth: false, x: 10.5, y: 70, z: -3.5,
    ...overrides,
  });
}

function handler(overrides = {}) {
  return createMissionBrainHandler({
    complete: async () => { throw new Error('provider must not be called'); },
    phaseADescentLifetime: true,
    ttlMs: 30000,
    maxTtlMs: 255000,
    now: () => 100000,
    emit: () => {},
    ...overrides,
  });
}

// These two tests import only pre-existing modules. They can be applied to the
// frozen baseline on their own to reproduce the original 45 s / 30 s mismatch.
test('phase-a lifetime frozen reproduction: primary twenty-step descent declares its full bounded lifetime', async () => {
  const intent = await handler()('lifetime-primary', descentReady());
  assert.equal(intent.action, 'descend_staircase');
  assert.equal(intent.reason, 'mission:DESCEND');
  assert.equal(intent.targetY, 16);
  assert.equal(intent.ttlMs, 255000);
});

test('phase-a lifetime frozen reproduction: recovery twenty-step descent declares its full bounded lifetime', async () => {
  const handle = handler();
  const first = await handle('lifetime-recovery', descentReady());
  const retry = await handle('lifetime-recovery', {
    ...descentReady({ y: 42 }),
    currentCommandId: first.commandId,
    currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_failed:descent_water_adjacent:10, 42, -4',
  });
  assert.equal(retry.action, 'descend_staircase');
  assert.equal(retry.reason, 'mission:DESCEND_RECOVERY');
  assert.notEqual(retry.commandId, first.commandId);
  assert.equal(retry.ttlMs, 255000);
});

test('phase-a lifetime uses the remaining bounded depth without changing its endpoint or heading', async () => {
  const intent = await handler()('lifetime-shallow', descentReady({ y: 24.8 }));
  assert.equal(intent.action, 'descend_staircase');
  assert.equal(intent.ttlMs, 111000);
  assert.equal(intent.targetY, 16);
  assert.equal(intent.targetX, 10);
  assert.equal(intent.targetZ, 4);
});

test('phase-a lifetime repeated polls consume one frozen deadline instead of renewing it', async () => {
  let now = 100000;
  const events = [];
  const handle = handler({ now: () => now, emit: event => events.push(event) });
  const first = await handle('lifetime-held', descentReady());
  now += 1000;
  const repeated = await handle('lifetime-held', {
    ...descentReady({ y: 69 }),
    currentCommandId: first.commandId,
    currentCommandCompleted: false,
  });
  assert.equal(repeated.commandId, first.commandId);
  assert.equal(repeated.ttlMs, 254000);
  assert.equal(repeated.targetX, first.targetX);
  assert.equal(repeated.targetY, first.targetY);
  assert.equal(repeated.targetZ, first.targetZ);
  now += 1000;
  const interrupted = await handle('lifetime-held', {
    ...descentReady({ y: 69, onGround: false }),
    currentCommandId: first.commandId,
    currentCommandCompleted: false,
  });
  assert.equal(interrupted.commandId, first.commandId);
  assert.equal(interrupted.ttlMs, 253000);
  assert.equal(events.filter(event => event.evt === 'mission.descent_lifetime.frozen').length, 1);
});

test('phase-a lifetime does not mint a new command when an unacknowledged poll passes orchestrator stall time', async () => {
  let now = 100000;
  const events = [];
  const handle = handler({ now: () => now, emit: event => events.push(event) });
  const first = await handle('lifetime-no-replan', descentReady());
  now = 180000;
  const held = await handle('lifetime-no-replan', { ...descentReady(), currentCommandId: first.commandId });
  assert.equal(held.action, 'descend_staircase');
  assert.equal(held.commandId, first.commandId);
  assert.equal(held.ttlMs, 175000);
  assert.equal(events.some(event => event.evt === 'mission.objective.recovery_queued'), false);
  assert.equal(events.filter(event => event.evt === 'mission.descent_lifetime.frozen').length, 1);
});

test('phase-a lifetime rejects a cap that would silently clip the declared descent', async () => {
  const events = [];
  const handle = handler({ maxTtlMs: 45000, emit: event => events.push(event) });
  const stopped = await handle('lifetime-cap', descentReady());
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.missionDone, true);
  assert.equal(stopped.reason, 'mission:descent_lifetime_cap_insufficient');
  assert.equal(events.filter(event => event.evt === 'mission.descent_lifetime.frozen').length, 0);
  assert.ok(events.some(event => event.evt === 'mission.aborted'
    && event.reason === 'descent_lifetime_cap_insufficient'));
  assert.deepEqual(await handle('lifetime-cap', descentReady()), stopped);
});

test('phase-a lifetime honors a lower client-side cap as well as the brain-side cap', async () => {
  const stopped = await handler({ phaseADescentClientMaxTtlMs: 45000 })('lifetime-client-cap', descentReady());
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.reason, 'mission:descent_lifetime_cap_insufficient');
  assert.equal(stopped.missionDone, true);
});

test('phase-a lifetime malformed live position is an explicit terminal failure, not a clipped command', async () => {
  const stopped = await handler()('lifetime-position', { ...descentReady(), y: NaN });
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.reason, 'mission:descent_lifetime_position_invalid');
  assert.equal(stopped.missionDone, true);
});

test('phase-a lifetime expires at the original exact boundary even after progress', async () => {
  let now = 100000;
  const handle = handler({ now: () => now });
  const first = await handle('lifetime-expired', descentReady());
  now = 355000;
  const stopped = await handle('lifetime-expired', {
    ...descentReady({ y: 50 }), currentCommandId: first.commandId, currentCommandCompleted: false,
  });
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.commandId, first.commandId);
  assert.equal(stopped.reason, 'mission:descent_lifetime_expired');
  assert.equal(stopped.missionDone, true);
});

test('phase-a lifetime missing completion identity cannot retire or renew a held command', async () => {
  let now = 100000;
  const events = [];
  const handle = handler({ now: () => now, emit: event => events.push(event) });
  const first = await handle('lifetime-missing-receipt', descentReady());
  for (let poll = 1; poll <= 3; poll++) {
    now += 1000;
    const uncorrelated = await handle('lifetime-missing-receipt', {
      ...descentReady({ y: 70 - poll }), currentCommandCompleted: true,
      currentCommandCompletionReason: 'descent_failed:descent_rejoin_timeout',
    });
    assert.equal(uncorrelated.commandId, first.commandId);
    assert.equal(uncorrelated.action, 'descend_staircase');
    assert.equal(uncorrelated.ttlMs, 255000 - poll * 1000);
  }
  assert.equal(events.filter(event => event.evt === 'mission.descent_lifetime.frozen').length, 1);
  assert.equal(events.some(event => event.evt === 'mission.objective.recovery_queued'), false);
  now = 355000;
  const expired = await handle('lifetime-missing-receipt', {
    ...descentReady({ y: 66 }), currentCommandCompleted: true,
    currentCommandCompletionReason: 'descent_complete:depth_reached',
  });
  assert.equal(expired.commandId, first.commandId);
  assert.equal(expired.reason, 'mission:descent_lifetime_expired');
  assert.equal(expired.missionDone, true);
  assert.deepEqual(await handle('lifetime-missing-receipt', descentReady()), expired);
});

test('phase-a lifetime completion for another command cannot bypass expiry', async () => {
  let now = 100000;
  const handle = handler({ now: () => now });
  const first = await handle('lifetime-wrong-receipt', descentReady());
  now = 355000;
  const expired = await handle('lifetime-wrong-receipt', {
    ...descentReady({ y: 50 }), currentCommandId: 'mission-other-1',
    currentCommandCompleted: true, currentCommandCompletionReason: 'descent_complete:depth_reached',
  });
  assert.equal(expired.commandId, first.commandId);
  assert.equal(expired.reason, 'mission:descent_lifetime_expired');
  assert.equal(expired.missionDone, true);
});

test('phase-a lifetime accepts exact acknowledged completion through the existing navigation identity field', async () => {
  let now = 100000;
  const handle = handler({ now: () => now });
  const first = await handle('lifetime-navigation-receipt', descentReady());
  now = 355001;
  const next = await handle('lifetime-navigation-receipt', {
    ...descentReady({ y: 50 }), activeNavigationCommandId: first.commandId,
    currentCommandCompleted: true, currentCommandCompletionReason: 'descent_complete:depth_reached',
  });
  assert.equal(next.action, 'descend_staircase');
  assert.notEqual(next.commandId, first.commandId);
  assert.equal(next.ttlMs, 255000);
});

test('phase-a lifetime accepts an acknowledged completion after expiry without reclassifying it', async () => {
  let now = 100000;
  const handle = handler({ now: () => now });
  const first = await handle('lifetime-complete', descentReady());
  now = 355001;
  const next = await handle('lifetime-complete', {
    ...descentReady({ y: 50 }), currentCommandId: first.commandId,
    currentCommandCompleted: true, currentCommandCompletionReason: 'descent_complete:depth_reached',
  });
  assert.equal(next.action, 'descend_staircase');
  assert.notEqual(next.commandId, first.commandId);
  assert.equal(next.ttlMs, 255000);
  assert.equal(next.missionDone, false);
});

test('phase-a lifetime fails closed on a backwards clock without increasing the remaining budget', async () => {
  let now = 100000;
  const handle = handler({ now: () => now });
  const first = await handle('lifetime-clock', descentReady());
  now += 1000;
  await handle('lifetime-clock', { ...descentReady({ y: 69 }), currentCommandId: first.commandId });
  now -= 1;
  const stopped = await handle('lifetime-clock', { ...descentReady({ y: 69 }), currentCommandId: first.commandId });
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.reason, 'mission:descent_lifetime_clock_invalid');
});

test('phase-a lifetime leaves the legacy handler and ordinary mission action lifetimes unchanged', async () => {
  const legacy = await handler({ phaseADescentLifetime: false })('lifetime-legacy', descentReady());
  assert.equal(legacy.ttlMs, 45000);
  const wood = await handler()('lifetime-wood', createInitialState());
  assert.equal(wood.action, 'gather_tree');
  assert.equal(wood.ttlMs, 45000);
  const craft = await handler()('lifetime-craft', createInitialState({ logs: 20 }));
  assert.notEqual(craft.action, 'descend_staircase');
  assert.equal(craft.ttlMs, 30000);
});

test('phase-a lifetime does not align a diamond or iron-pickaxe-only mission', async () => {
  for (const missionGoal of ['diamond', 'iron_pickaxe', 'iron_pickaxe_only']) {
    const intent = await handler({ missionGoal })(`lifetime-other-${missionGoal}`, descentReady());
    assert.equal(intent.action, 'descend_staircase');
    assert.equal(intent.ttlMs, 45000);
  }
});

test('phase-a lifetime preserves legacy descent when either independent goal field selects another mission', async () => {
  for (const [missionGoal, goal] of [
    ['phase_a', 'diamond'], ['diamond', 'phase_a'],
    ['phase_a', 'iron_pickaxe'], ['iron_pickaxe', 'phase_a'],
  ]) {
    const intent = await handler({ missionGoal })(`lifetime-conflict-${missionGoal}-${goal}`, descentReady({ goal }));
    assert.equal(intent.action, 'descend_staircase');
    assert.equal(intent.ttlMs, 45000);
  }
});
