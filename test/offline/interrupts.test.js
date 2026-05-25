import test from 'node:test';
import assert from 'node:assert/strict';

import interrupts from '../../src/reactive/interrupts.js';

test('interrupt bus isolates throwing preempt listeners', () => {
  const calls = [];
  const throwing = () => {
    calls.push('throwing');
    throw new Error('preempt listener failed');
  };
  const next = (reason) => {
    calls.push(`next:${reason}`);
  };
  interrupts.once('preempted', throwing);
  interrupts.once('preempted', next);

  assert.doesNotThrow(() => interrupts.notifyPreempt('hazard'));

  assert.deepEqual(calls, ['throwing', 'next:hazard']);
});

test('interrupt bus isolates throwing release listeners and records release time', () => {
  const calls = [];
  const throwing = () => {
    calls.push('throwing');
    throw new Error('release listener failed');
  };
  const next = (reason) => {
    calls.push(`next:${reason}`);
  };
  interrupts.lastReleasedAt = 0;
  interrupts.once('released', throwing);
  interrupts.once('released', next);

  assert.doesNotThrow(() => interrupts.notifyRelease('threat-cleared'));

  assert.deepEqual(calls, ['throwing', 'next:threat-cleared']);
  assert.ok(interrupts.lastReleasedAt > 0);
});
