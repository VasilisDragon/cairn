import test from 'node:test';
import assert from 'node:assert/strict';

import { advisorAgentOptions } from '../../src/advisor/runtime_options.js';

test('advisor runtime options pass runtime context as snapshot context', () => {
  const runtimeContext = { worldModelStore: { load: () => ({}) } };

  const options = advisorAgentOptions(runtimeContext, { maxReplans: 4 });

  assert.equal(options.maxReplans, 4);
  assert.equal(options.snapshotContext, runtimeContext);
});

test('advisor runtime options preserve explicit snapshot context', () => {
  const runtimeContext = { worldModelStore: { load: () => ({}) } };
  const explicitContext = { worldModelSummary: { visitedAreaCount: 1 } };

  const options = advisorAgentOptions(runtimeContext, {
    snapshotContext: explicitContext,
    maxReplans: 2,
  });

  assert.equal(options.maxReplans, 2);
  assert.equal(options.snapshotContext, explicitContext);
});

test('advisor runtime options do not override snapshot context provider', () => {
  const runtimeContext = { worldModelStore: { load: () => ({}) } };
  const snapshotContextProvider = () => ({ dynamic: true });

  const options = advisorAgentOptions(runtimeContext, { snapshotContextProvider });

  assert.equal(options.snapshotContext, undefined);
  assert.equal(options.snapshotContextProvider, snapshotContextProvider);
});
