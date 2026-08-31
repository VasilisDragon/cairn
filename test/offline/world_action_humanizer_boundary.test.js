import test from 'node:test';
import assert from 'node:assert/strict';

import { createHumanizer } from '../../src/behavior_shaping/humanizer.js';

function makeBot() {
  const calls = [];
  return {
    calls,
    entity: { position: { x: 0, y: 64, z: 0 } },
    placeBlock: async () => { calls.push('placeBlock'); },
    dig: async () => { calls.push('dig'); },
    activateBlock: async () => { calls.push('activateBlock'); },
    activateItem: async () => { calls.push('activateItem'); },
  };
}

function denied(reason = 'policy changed') {
  return { ok: false, action: 'deny', reason };
}

test('humanized placement rechecks authorization after its delay and before the physical call', async () => {
  const bot = makeBot();
  const humanizer = createHumanizer({
    enabled: true,
    sessionSeed: 'world-action-boundary-test',
    reactionMedianMs: 10,
    reactionP95Ms: 10,
    clickMinIntervalMs: 1,
    cadenceJitterMs: 0,
  }, null);
  let policy = { ok: true };
  const pending = humanizer.placeBlock(
    bot,
    { name: 'dirt', position: { x: 0, y: 63, z: 0 } },
    { x: 0, y: 1, z: 0 },
    { authorize: () => policy },
  );
  policy = denied('became protected during humanization');

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'WORLD_ACTION_DENIED');
    assert.match(error.message, /became protected during humanization/);
    return true;
  });
  assert.deepEqual(bot.calls, []);
});

test('disabled humanizer still fails closed when live placement geometry is unavailable', async () => {
  const bot = makeBot();
  const humanizer = createHumanizer({ enabled: false }, null);

  await assert.rejects(
    humanizer.placeBlock(
      bot,
      { name: 'dirt', position: { x: 0, y: 63, z: 0 } },
      { x: 0, y: 1, z: 0 },
    ),
    (error) => {
      assert.equal(error.code, 'WORLD_ACTION_DENIED');
      assert.match(error.message, /live block query is unavailable/);
      return true;
    },
  );
  assert.deepEqual(bot.calls, []);
});

test('humanizer guards dig and activation sinks in enabled and disabled modes', async () => {
  const bot = makeBot();
  const block = { name: 'stone', position: { x: 0, y: 63, z: 0 } };
  const face = { x: 0, y: 1, z: 0 };
  const authorization = { authorize: () => denied(), critical: true };

  for (const humanizer of [
    createHumanizer({ enabled: true }, null),
    createHumanizer({ enabled: false }, null),
  ]) {
    await assert.rejects(humanizer.placeBlock(bot, block, face, authorization), { code: 'WORLD_ACTION_DENIED' });
    await assert.rejects(humanizer.digBlock(bot, block, authorization), { code: 'WORLD_ACTION_DENIED' });
    await assert.rejects(humanizer.activateBlock(bot, block, authorization), { code: 'WORLD_ACTION_DENIED' });
    await assert.rejects(humanizer.activateItem(bot, authorization), { code: 'WORLD_ACTION_DENIED' });
  }
  assert.deepEqual(bot.calls, []);
});
