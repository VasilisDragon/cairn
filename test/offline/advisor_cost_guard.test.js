import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

  let record = guard.recordCall({ promptTokens: 5 });
  assert.equal(record.sessionCostUsd, 5);
  assert.equal(record.status, 'prefer_last_validated_plan');
  assert.equal(record.preferLastValidatedPlan, true);
  assert.equal(record.refuseNewCalls, false);

  record = guard.recordCall({ promptTokens: 4 });
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
