import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAdvisorUsage,
  createAdvisorCostGuard,
  estimateAdvisorCallCostUsd,
  normalizeAdvisorCostOptions,
} from '../../src/advisor/cost_guard.js';

test('advisor cost options default to a two dollar session ceiling', () => {
  assert.deepEqual(normalizeAdvisorCostOptions({}), {
    maxUsd: 2,
    promptUsdPerMillionTokens: 2,
    completionUsdPerMillionTokens: 8,
  });
});

test('advisor cost accounting distinguishes exact, partial, and unknown usage', () => {
  const rates = {
    costUsdMax: 7,
    promptUsdPerMillionTokens: 1_000_000,
    completionUsdPerMillionTokens: 4_000_000,
  };

  assert.deepEqual(classifyAdvisorUsage({ promptTokens: 2, completionTokens: 3 }, rates), {
    usageStatus: 'exact',
    callCostUsd: 14,
  });
  assert.deepEqual(classifyAdvisorUsage({ promptTokens: 2, totalTokens: 5 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 20,
  });
  assert.deepEqual(classifyAdvisorUsage({ completionTokens: 3, totalTokens: 5 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 20,
  });
  assert.deepEqual(classifyAdvisorUsage({}, rates), {
    usageStatus: 'unknown',
    callCostUsd: 7,
  });
});

test('partial usage without a total charges known tokens at the higher rate', () => {
  const rates = {
    costUsdMax: 30,
    promptUsdPerMillionTokens: 1_000_000,
    completionUsdPerMillionTokens: 4_000_000,
  };
  assert.deepEqual(classifyAdvisorUsage({ promptTokens: 2 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 8,
  });
  assert.deepEqual(classifyAdvisorUsage({ completionTokens: 3 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 12,
  });
  assert.deepEqual(classifyAdvisorUsage({ promptTokens: '2', completionTokens: 3 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 12,
  });
});

test('inconsistent totals charge the largest observed count entirely at the higher rate', () => {
  const rates = {
    costUsdMax: 100,
    promptUsdPerMillionTokens: 1_000_000,
    completionUsdPerMillionTokens: 4_000_000,
  };
  assert.deepEqual(classifyAdvisorUsage({ promptTokens: 2, completionTokens: 3, totalTokens: 20 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 80,
  });
  assert.deepEqual(classifyAdvisorUsage({ promptTokens: 2, completionTokens: 3, totalTokens: 1 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 20,
  });
  assert.deepEqual(classifyAdvisorUsage({ promptTokens: 9, completionTokens: 1, totalTokens: 5 }, rates), {
    usageStatus: 'partial',
    callCostUsd: 40,
  });
});

test('a valid aggregate-only zero receipt is partial usage with zero cost', () => {
  assert.deepEqual(classifyAdvisorUsage({ totalTokens: 0 }, { costUsdMax: 3 }), {
    usageStatus: 'partial',
    callCostUsd: 0,
  });
});

test('wholly unknown or malformed usage consumes the full ceiling', () => {
  for (const metrics of [
    {},
    { promptTokens: '1' },
    { promptTokens: -1, completionTokens: Number.NaN },
    { totalTokens: Number.POSITIVE_INFINITY },
  ]) {
    const guard = createAdvisorCostGuard({ costUsdMax: 3 });
    const record = guard.recordCall(metrics);
    assert.equal(record.usageStatus, 'unknown');
    assert.equal(record.callCostUsd, 3);
    assert.equal(record.status, 'hard_logout');
    assert.equal(guard.beforeCall().ok, false);
  }
});

test('advisor call cost estimates prompt and completion tokens separately', () => {
  assert.equal(estimateAdvisorCallCostUsd({
    promptTokens: 1_000_000,
    completionTokens: 500_000,
  }, {
    promptUsdPerMillionTokens: 1,
    completionUsdPerMillionTokens: 4,
  }), 3);
});

test('advisor cost guard emits threshold policy states and refuses after 90 percent', () => {
  const guard = createAdvisorCostGuard({
    costUsdMax: 10,
    promptUsdPerMillionTokens: 1_000_000,
    completionUsdPerMillionTokens: 1_000_000,
  });

  assert.equal(guard.beforeCall().ok, true);

  let record = guard.recordCall({ promptTokens: 5, completionTokens: 0 });
  assert.equal(record.sessionCostUsd, 5);
  assert.equal(record.status, 'prefer_last_validated_plan');
  assert.equal(record.preferLastValidatedPlan, true);
  assert.equal(record.refuseNewCalls, false);

  record = guard.recordCall({ promptTokens: 4, completionTokens: 0 });
  assert.equal(record.sessionCostUsd, 9);
  assert.equal(record.status, 'refuse_new_calls');
  assert.equal(record.refuseNewCalls, true);
  assert.equal(guard.beforeCall().ok, false);
  assert.match(guard.beforeCall().reason, /90%/);
});

test('advisor cost guard marks hard logout once the ceiling is exhausted', () => {
  const guard = createAdvisorCostGuard({
    costUsdMax: 1,
    promptUsdPerMillionTokens: 1_000_000,
    completionUsdPerMillionTokens: 1_000_000,
  });

  const record = guard.recordCall({ totalTokens: 1 });
  assert.equal(record.sessionCostUsd, 1);
  assert.equal(record.status, 'hard_logout');
  assert.equal(record.shouldLogoutAfterCurrentSkill, true);

  const before = guard.beforeCall();
  assert.equal(before.ok, false);
  assert.match(before.reason, /exhausted/);
});

test('advisor cost guard reset clears an unknown-usage hard stop', () => {
  const guard = createAdvisorCostGuard({ costUsdMax: 2 });
  guard.recordCall({});
  assert.equal(guard.beforeCall().ok, false);

  guard.reset();
  assert.equal(guard.beforeCall().ok, true);
  assert.equal(guard.snapshot().callCount, 0);
  assert.equal(guard.snapshot().sessionCostUsd, 0);
});
