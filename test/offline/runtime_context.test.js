import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { createRuntimeContext } from '../../src/runtime/context.js';
import { WorldModelStore } from '../../src/state/world_model.js';

test('runtime context creates a persistent world-model store', () => {
  const filePath = path.join(os.tmpdir(), `mcbot-runtime-context-${Date.now()}.json`);
  const context = createRuntimeContext({ worldModelPath: filePath });

  assert.equal(context.worldModelStore instanceof WorldModelStore, true);
  assert.equal(context.worldModelStore.filePath, filePath);
  assert.equal('worldModelSummaryOptions' in context, false);
});

test('runtime context preserves caller supplied store and summary options', () => {
  const store = new WorldModelStore(path.join(os.tmpdir(), `mcbot-runtime-context-store-${Date.now()}.json`));
  const context = createRuntimeContext({
    worldModelStore: store,
    worldModelSummaryOptions: { limit: 2 },
  });

  assert.equal(context.worldModelStore, store);
  assert.deepEqual(context.worldModelSummaryOptions, { limit: 2 });
});
