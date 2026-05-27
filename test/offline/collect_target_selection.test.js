import test from 'node:test';
import assert from 'node:assert/strict';

import minecraftData from 'minecraft-data';
import config from '../../src/config.js';
import {
  chooseCollectCandidate,
  effectiveCollectPickupWaitMs,
  resolveCollectTarget,
  run as runCollect,
} from '../../src/skills/collect.js';
import { posKey } from '../../src/skills/_pathing.js';
import { createEmptyWorldModel } from '../../src/state/world_model.js';

const mcData = minecraftData('1.21.1');

function pos(x, y, z) {
  return { x, y, z, clone() { return pos(x, y, z); } };
}

function terrainBlock(name, x, y, z, opts = {}) {
  return {
    name,
    type: opts.type ?? 0,
    boundingBox: opts.boundingBox ?? (name === 'air' ? 'empty' : 'block'),
    position: pos(x, y, z),
  };
}

function modelWithProtectedBox(min, max) {
  const model = createEmptyWorldModel({ now: '2026-05-22T00:00:00.000Z' });
  model.doNotTouchRegions.push({
    id: 'region_protected',
    bbox: { min, max },
    reason: 'likely_player_made',
    confidence: 0.91,
  });
  return model;
}

function makePathStopped() {
  const err = new Error('stopped');
  err.name = 'PathStopped';
  return err;
}

function collectCtx(signal, callState) {
  return {
    signal,
    callState,
    remainingQueue: [],
    currentSubtask: null,
  };
}

function makeMovements() {
  return {
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
}

function makeCollectHarness(blockPositions, collectImpl, opts = {}) {
  const blockName = opts.blockName || 'oak_log';
  const blockId = opts.blockId || 17;
  const inventory = { [opts.inventoryItem || blockName]: 0 };
  const blocks = new Map(blockPositions.map((p) => [posKey(p), p]));
  const collectedTargets = [];
  let releaseCalls = 0;
  let stopDiggingCalls = 0;
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: { blocksByName: { [blockName]: { id: blockId } } },
    inventory: {
      items: () => Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count })),
    },
    findBlocks: () => [...blocks.values()],
    blockAt(p) {
      const found = blocks.get(posKey(p));
      return found ? { name: blockName, position: found } : null;
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async (target) => {
        collectedTargets.push(posKey(target.position));
        return collectImpl({ target, blocks, inventory });
      },
    },
    stopDigging() {
      stopDiggingCalls++;
    },
    pathfinderOwner: {
      acquire: () => ({
        token: { id: 'collect-preempt-test' },
        release() {
          releaseCalls++;
        },
      }),
      stop() {},
    },
  };

  return {
    bot,
    inventory,
    blocks,
    collectedTargets,
    get releaseCalls() { return releaseCalls; },
    get stopDiggingCalls() { return stopDiggingCalls; },
  };
}

function makeDropSourceHarness({ requested, sourceBlock, dropItem, positions = [pos(4, 64, 0)], terrain = [] }) {
  const sourceType = mcData.blocksByName[sourceBlock];
  assert.ok(sourceType, `missing test source block ${sourceBlock}`);
  const inventory = { [dropItem]: 0, [sourceBlock]: 0 };
  const blocks = new Map(positions.map((p) => [posKey(p), p]));
  const terrainBlocks = new Map(terrain.map((b) => [posKey(b.position), b]));
  const collectedTargets = [];
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: mcData,
    inventory: {
      items: () => Object.entries(inventory)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count })),
    },
    findBlocks({ matching }) {
      assert.equal(matching, sourceType.id);
      return [...blocks.values()];
    },
    blockAt(p) {
      const found = blocks.get(posKey(p));
      if (found) return { ...sourceType, name: sourceBlock, position: found };
      return terrainBlocks.get(posKey(p)) || null;
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async (target) => {
        collectedTargets.push(posKey(target.position));
        blocks.delete(posKey(target.position));
        inventory[dropItem] = (inventory[dropItem] || 0) + 1;
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({ token: { id: `collect-${requested}-drop-source-test` }, release() {} }),
    },
  };

  return { bot, inventory, blocks, collectedTargets };
}

test('collect target selection prefers the previous block cluster over global nearest', () => {
  const candidate = chooseCollectCandidate([
    pos(20, 64, 0),
    pos(0, 65, 0),
    pos(0, 66, 0),
  ], {
    origin: pos(19, 64, 0),
    clusterOrigin: pos(0, 64, 0),
    clusterRadius: 2.5,
  });

  assert.equal(posKey(candidate), '0,65,0');
});

test('collect target selection skips same-column downward repeats for surface collection', () => {
  const candidate = chooseCollectCandidate([
    pos(0, 63, 0),
    pos(2, 64, 0),
  ], {
    origin: pos(0, 64, 0),
    previousTarget: pos(0, 64, 0),
    preventSameColumnDescent: true,
  });

  assert.equal(posKey(candidate), '2,64,0');
});

test('collect target selection permits same-column descent after explicit buried opt-in', () => {
  const candidate = chooseCollectCandidate([
    pos(0, 63, 0),
    pos(2, 64, 0),
  ], {
    origin: pos(0, 64, 2),
    previousTarget: pos(0, 64, 0),
    preventSameColumnDescent: true,
    allowBuriedTargets: true,
  });

  assert.equal(posKey(candidate), '0,63,0');
});

test('collect drop-source resolver maps common item targets to mineable source blocks', () => {
  const cobblestone = resolveCollectTarget(mcData, 'cobblestone');
  assert.equal(cobblestone.ok, true);
  assert.equal(cobblestone.sourceBlock.name, 'stone');
  assert.deepEqual(cobblestone.progressItems, ['cobblestone']);

  const rawIron = resolveCollectTarget(mcData, 'raw_iron');
  assert.equal(rawIron.ok, true);
  assert.equal(rawIron.sourceBlock.name, 'iron_ore');
  assert.deepEqual(rawIron.progressItems, ['raw_iron']);

  const diamond = resolveCollectTarget(mcData, 'diamond');
  assert.equal(diamond.ok, true);
  assert.equal(diamond.sourceBlock.name, 'diamond_ore');
  assert.deepEqual(diamond.progressItems, ['diamond']);
});

test('collect drop-source resolver preserves same-name block behavior for direct drops', () => {
  const oakLog = resolveCollectTarget(mcData, 'oak_log');

  assert.equal(oakLog.ok, true);
  assert.equal(oakLog.sourceBlock.name, 'oak_log');
  assert.deepEqual(oakLog.progressItems, ['oak_log']);
});

test('collect drop-source resolver chooses a deterministic natural source among multiple drops', () => {
  const redstone = resolveCollectTarget(mcData, 'redstone');

  assert.equal(redstone.ok, true);
  assert.equal(redstone.sourceBlock.name, 'redstone_ore');
  assert.ok(redstone.candidates.includes('redstone_wire'));
  assert.ok(redstone.candidates.includes('deepslate_redstone_ore'));
});

test('collect log movement policy discourages breaking or walking through leaves as a route', async () => {
  const callState = {};
  const harness = makeCollectHarness([pos(4, 64, 0)], async ({ target, blocks, inventory }) => {
    blocks.delete(posKey(target.position));
    inventory.oak_log += 1;
  });

  const result = await runCollect(harness.bot, { block: 'oak_log', count: 1 }, collectCtx(null, callState));

  assert.equal(result.ok, true);
  const leaf = { name: 'oak_leaves', boundingBox: 'block', position: pos(2, 64, 0) };
  assert.ok(harness.bot.collectBlock.movements.exclusionAreasBreak.some((fn) => fn(leaf) >= 100));
  assert.ok(harness.bot.collectBlock.movements.exclusionAreasStep.some((fn) => fn(leaf) >= 100));
});

test('collect cobblestone mines stone and counts the target item inventory', async () => {
  const callState = {};
  const harness = makeDropSourceHarness({
    requested: 'cobblestone',
    sourceBlock: 'stone',
    dropItem: 'cobblestone',
    positions: [pos(5, 63, 0)],
  });

  const result = await runCollect(
    harness.bot,
    { block: 'cobblestone', count: 1, maxDistance: 16 },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 cobblestone');
  assert.deepEqual(harness.collectedTargets, ['5,63,0']);
  assert.equal(harness.inventory.cobblestone, 1);
  assert.equal(harness.inventory.stone, 0);
  assert.equal(callState.collectedSoFar, 1);
});

test('collect cobblestone prefers surface-exposed stone over buried nearest stone', async () => {
  const buried = pos(3, 60, 0);
  const surface = pos(8, 63, 0);
  const harness = makeDropSourceHarness({
    requested: 'cobblestone',
    sourceBlock: 'stone',
    dropItem: 'cobblestone',
    positions: [buried, surface],
    terrain: [
      terrainBlock('dirt', 3, 61, 0),
      terrainBlock('dirt', 3, 62, 0),
      terrainBlock('grass_block', 3, 63, 0),
    ],
  });

  const result = await runCollect(
    harness.bot,
    { block: 'cobblestone', count: 1, maxDistance: 16 },
    collectCtx(new AbortController().signal, {}),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.collectedTargets, [posKey(surface)]);
  assert.equal(harness.inventory.cobblestone, 1);
});

test('collect cobblestone reports shaft-mining diagnostic when only buried stone exists', async () => {
  const buriedA = pos(3, 60, 0);
  const buriedB = pos(5, 59, 0);
  const harness = makeDropSourceHarness({
    requested: 'cobblestone',
    sourceBlock: 'stone',
    dropItem: 'cobblestone',
    positions: [buriedA, buriedB],
    terrain: [
      terrainBlock('dirt', 3, 61, 0),
      terrainBlock('dirt', 3, 62, 0),
      terrainBlock('grass_block', 3, 63, 0),
      terrainBlock('dirt', 5, 60, 0),
      terrainBlock('dirt', 5, 61, 0),
      terrainBlock('grass_block', 5, 62, 0),
    ],
  });

  const result = await runCollect(
    harness.bot,
    { block: 'cobblestone', count: 1, maxDistance: 16 },
    collectCtx(new AbortController().signal, {}),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /no surface-exposed cobblestone within 16 blocks/);
  assert.match(result.reason, /Shaft mining capability required/);
  assert.equal(result.diagnostic.suggestion, 'shaft_mining');
  assert.equal(result.diagnostic.candidatesFound, 2);
  assert.equal(result.diagnostic.deepestStoneY, 59);
  assert.deepEqual(harness.collectedTargets, []);
});

test('collect cobblestone can opt into buried stone after shaft positioning', async () => {
  const buriedA = pos(3, 60, 0);
  const buriedB = pos(5, 59, 0);
  const harness = makeDropSourceHarness({
    requested: 'cobblestone',
    sourceBlock: 'stone',
    dropItem: 'cobblestone',
    positions: [buriedA, buriedB],
    terrain: [
      terrainBlock('dirt', 3, 61, 0),
      terrainBlock('dirt', 3, 62, 0),
      terrainBlock('grass_block', 3, 63, 0),
      terrainBlock('dirt', 5, 60, 0),
      terrainBlock('dirt', 5, 61, 0),
      terrainBlock('grass_block', 5, 62, 0),
    ],
  });

  const result = await runCollect(
    harness.bot,
    { block: 'cobblestone', count: 1, maxDistance: 16, allowBuriedTargets: true },
    collectCtx(new AbortController().signal, {}),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 cobblestone');
  assert.deepEqual(harness.collectedTargets, [posKey(buriedA)]);
  assert.equal(harness.inventory.cobblestone, 1);
});

test('collect target selection falls back to nearest origin when cluster is exhausted', () => {
  const excluded = new Set([posKey(pos(0, 65, 0))]);
  const candidate = chooseCollectCandidate([
    pos(0, 65, 0),
    pos(20, 64, 0),
    pos(22, 64, 0),
  ], {
    excluded,
    origin: pos(19, 64, 0),
    clusterOrigin: pos(0, 64, 0),
    clusterRadius: 2.5,
  });

  assert.equal(posKey(candidate), '20,64,0');
});

test('collect target selection is deterministic when distances tie', () => {
  const candidate = chooseCollectCandidate([
    pos(1, 64, 1),
    pos(1, 64, -1),
  ], {
    origin: pos(0, 64, 0),
  });

  assert.equal(posKey(candidate), '1,64,-1');
});

test('collect target selection skips world-model protected candidates', () => {
  const candidate = chooseCollectCandidate([
    pos(0, 64, 0),
    pos(10, 64, 0),
  ], {
    origin: pos(0, 64, 0),
    worldModel: modelWithProtectedBox([0, 63, 0], [2, 66, 2]),
  });

  assert.equal(posKey(candidate), '10,64,0');
});

test('collect target selection skips the block supporting the bot', () => {
  const candidate = chooseCollectCandidate([
    pos(0, 64, 0),
    pos(4, 64, 0),
  ], {
    origin: pos(0.5, 65, 0.5),
  });

  assert.equal(posKey(candidate), '4,64,0');
});

test('collect target selection skips task-context protected shaft blocks', () => {
  const candidate = chooseCollectCandidate([
    pos(0, 63, 0),
    pos(1, 63, 0),
  ], {
    origin: pos(0.5, 64, 0.5),
    protectedPositions: new Set(['0,63,0']),
  });

  assert.equal(posKey(candidate), '1,63,0');
});

test('collect run keeps collecting from the same nearby cluster after a success', async () => {
  const inventory = { oak_log: 0 };
  const blocks = new Map([
    [posKey(pos(20, 64, 0)), pos(20, 64, 0)],
    [posKey(pos(0, 64, 0)), pos(0, 64, 0)],
    [posKey(pos(0, 65, 0)), pos(0, 65, 0)],
  ]);
  const collected = [];
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: {
      items: () => (inventory.oak_log > 0 ? [{ name: 'oak_log', count: inventory.oak_log }] : []),
    },
    findBlocks: () => [...blocks.values()],
    blockAt(p) {
      const found = blocks.get(posKey(p));
      return found ? { name: 'oak_log', position: found } : null;
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async (target) => {
        collected.push(posKey(target.position));
        blocks.delete(posKey(target.position));
        inventory.oak_log += 1;
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'collect-test' }, release() {} }),
    },
  };

  const result = await runCollect(bot, { block: 'oak_log', count: 2 }, {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(collected, ['0,64,0', '0,65,0']);
});

test('collect resumes the same target after one reactive preempt', async () => {
  const target = pos(4, 64, 0);
  const callState = {};
  let activeController = null;
  let collectCalls = 0;
  const harness = makeCollectHarness([target], ({ target: collectedTarget, blocks, inventory }) => {
    collectCalls++;
    if (collectCalls === 1) {
      activeController.abort('reactive-preempt');
      throw makePathStopped();
    }
    blocks.delete(posKey(collectedTarget.position));
    inventory.oak_log += 1;
  });

  activeController = new AbortController();
  const first = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    collectCtx(activeController.signal, callState),
  );

  assert.equal(first.preempted, true);
  assert.equal(first.reason, 'reactive preempt during collect');
  assert.equal(posKey(callState.currentTarget), posKey(target));
  assert.equal(callState.interruptsOnCurrent, 1);
  assert.equal(callState.excluded.size, 0);

  activeController = new AbortController();
  const second = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    collectCtx(activeController.signal, callState),
  );

  assert.equal(second.ok, true);
  assert.deepEqual(harness.collectedTargets, [posKey(target), posKey(target)]);
  assert.equal(callState.currentTarget, null);
  assert.equal(callState.interruptsOnCurrent, 0);
  assert.equal(callState.collectedSoFar, 1);
  assert.equal(harness.releaseCalls, 2);
  assert.ok(harness.stopDiggingCalls >= 1);
});

test('collect excludes a target after repeated reactive preempts and tries another', async (t) => {
  const originalThreshold = config.reactive.maxInterruptionsPerTarget;
  config.reactive.maxInterruptionsPerTarget = 3;
  t.after(() => {
    config.reactive.maxInterruptionsPerTarget = originalThreshold;
  });

  const badTarget = pos(4, 64, 0);
  const goodTarget = pos(8, 64, 0);
  const callState = {};
  let activeController = null;
  const harness = makeCollectHarness([badTarget, goodTarget], ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    if (key === posKey(badTarget)) {
      activeController.abort('reactive-preempt');
      throw makePathStopped();
    }
    blocks.delete(key);
    inventory.oak_log += 1;
  });

  for (let i = 0; i < 3; i++) {
    activeController = new AbortController();
    const result = await runCollect(
      harness.bot,
      { block: 'oak_log', count: 1, maxDistance: 16 },
      collectCtx(activeController.signal, callState),
    );

    assert.equal(result.preempted, true);
    assert.equal(result.reason, 'reactive preempt during collect');
  }

  assert.equal(callState.excluded.has(posKey(badTarget)), true);
  assert.equal(callState.currentTarget, null);
  assert.equal(callState.interruptsOnCurrent, 0);

  activeController = new AbortController();
  const recovered = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    collectCtx(activeController.signal, callState),
  );

  assert.equal(recovered.ok, true);
  assert.deepEqual(harness.collectedTargets, [
    posKey(badTarget),
    posKey(badTarget),
    posKey(badTarget),
    posKey(goodTarget),
  ]);
  assert.equal(callState.collectedSoFar, 1);
  assert.equal(callState.excluded.has(posKey(badTarget)), true);
});

test('collect excludes a dry-land stuck target and tries another', async () => {
  const badTarget = pos(4, 64, 0);
  const goodTarget = pos(8, 64, 0);
  const callState = {};
  const harness = makeCollectHarness([badTarget, goodTarget], ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    if (key === posKey(badTarget)) return new Promise(() => {});
    blocks.delete(key);
    inventory.oak_log += 1;
    return undefined;
  });

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    {
      ...collectCtx(new AbortController().signal, callState),
      collectWatchdog: { pathStallMs: 20, watchdogIntervalMs: 5 },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.collectedTargets, [posKey(badTarget), posKey(goodTarget)]);
  assert.equal(callState.excluded.has(posKey(badTarget)), true);
  assert.equal(callState.collectedSoFar, 1);
});

test('collect runs internal surface recovery after a stuck target', async () => {
  const badTarget = pos(4, 64, 0);
  const goodTarget = pos(8, 64, 0);
  const callState = {};
  const recoveryCalls = [];
  const harness = makeCollectHarness([badTarget, goodTarget], ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    if (key === posKey(badTarget)) return new Promise(() => {});
    blocks.delete(key);
    inventory.oak_log += 1;
    return undefined;
  });

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    {
      ...collectCtx(new AbortController().signal, callState),
      collectWatchdog: { pathStallMs: 20, watchdogIntervalMs: 5 },
      recoverToSurface: async (_bot, _ctx, opts) => {
        recoveryCalls.push(opts);
        harness.bot.entity.position.y += 4;
        return { ok: true, action: 'pillar_up', steps: 4, block: 'dirt', startY: 64, targetY: 68, finalY: 68 };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].trigger, 'stuck');
  assert.deepEqual(harness.collectedTargets, [posKey(badTarget), posKey(goodTarget)]);
  assert.equal(callState.excluded.has(posKey(badTarget)), true);
  assert.equal(callState.collectedSoFar, 1);
  assert.equal(harness.bot.entity.position.y, 68);
});

test('collect excludes collectBlock path-planning timeouts and tries another target', async () => {
  const badTarget = pos(4, 64, 0);
  const goodTarget = pos(8, 64, 0);
  const callState = {};
  const harness = makeCollectHarness([badTarget, goodTarget], ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    if (key === posKey(badTarget)) throw new Error('Took to long to decide path to goal!');
    blocks.delete(key);
    inventory.oak_log += 1;
  });

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16, finishTree: false },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.collectedTargets, [posKey(badTarget), posKey(goodTarget)]);
  assert.equal(callState.excluded.has(posKey(badTarget)), true);
  assert.equal(callState.collectedSoFar, 1);
});

test('collect excludes collectBlock digging aborts and tries another target', async () => {
  const badTarget = pos(4, 64, 0);
  const goodTarget = pos(8, 64, 0);
  const callState = {};
  const harness = makeCollectHarness([badTarget, goodTarget], ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    if (key === posKey(badTarget)) throw new Error('Digging aborted');
    blocks.delete(key);
    inventory.oak_log += 1;
  });

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16, finishTree: false },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.collectedTargets, [posKey(badTarget), posKey(goodTarget)]);
  assert.equal(callState.excluded.has(posKey(badTarget)), true);
  assert.equal(callState.collectedSoFar, 1);
});

test('collect finishes the active log cluster before moving to another tree', async () => {
  const treeA = [pos(4, 64, 0), pos(4, 65, 0), pos(4, 66, 0)];
  const treeB = pos(8, 64, 0);
  const callState = {};
  const harness = makeCollectHarness([...treeA, treeB], ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    blocks.delete(key);
    inventory.oak_log += 1;
  });

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 2, maxDistance: 16 },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.collectedTargets, treeA.map(posKey));
  assert.equal(callState.collectedSoFar, 3);
  assert.equal(harness.inventory.oak_log, 3);
  assert.equal(harness.blocks.has(posKey(treeB)), true);
});

test('collect caps satisfied tree cleanup at a goal-aware multiplier', async () => {
  const tree = Array.from({ length: 25 }, (_value, index) => pos(4, 64 + index, 0));
  const callState = {};
  const harness = makeCollectHarness(tree, ({ target, blocks, inventory }) => {
    blocks.delete(posKey(target.position));
    inventory.oak_log += 1;
  });

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 4, maxDistance: 32 },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(callState.collectedSoFar, 6);
  assert.equal(harness.inventory.oak_log, 6);
  assert.equal(harness.collectedTargets.length, 6);
  assert.equal(callState.activeLogCluster, null);
  assert.ok(harness.blocks.size > 0);
});

test('collect tree cleanup cap scales with goal and supports internal param override', async () => {
  const tree = Array.from({ length: 25 }, (_value, index) => pos(4, 64 + index, 0));
  const callState = {};
  const harness = makeCollectHarness(tree, ({ target, blocks, inventory }) => {
    blocks.delete(posKey(target.position));
    inventory.oak_log += 1;
  });

  const result = await runCollect(
    harness.bot,
    {
      block: 'oak_log',
      count: 4,
      maxDistance: 32,
      treeClusterCleanupMultiplier: 2.0,
    },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(callState.collectedSoFar, 8);
  assert.equal(harness.inventory.oak_log, 8);
  assert.equal(harness.collectedTargets.length, 8);
});

test('collect target selection can reject high-canopy targets with maxTargetY', () => {
  const highCanopy = pos(2, 78, 0);
  const lowTrunk = pos(5, 66, 0);

  const selected = chooseCollectCandidate([highCanopy, lowTrunk], {
    origin: pos(0, 64, 0),
    maxTargetY: 67,
  });

  assert.equal(selected, lowTrunk);
  assert.equal(chooseCollectCandidate([highCanopy], {
    origin: pos(0, 64, 0),
    maxTargetY: 67,
  }), null);
});

test('collect tree cleanup cap is inert before goal is met and for non-tree targets', async () => {
  const tree = Array.from({ length: 4 }, (_value, index) => pos(4, 64 + index, 0));
  const treeState = {};
  const treeHarness = makeCollectHarness(tree, ({ target, blocks, inventory }) => {
    blocks.delete(posKey(target.position));
    inventory.oak_log += 1;
  });
  const treeResult = await runCollect(
    treeHarness.bot,
    { block: 'oak_log', count: 4, maxDistance: 16 },
    collectCtx(new AbortController().signal, treeState),
  );

  const stonePositions = Array.from({ length: 10 }, (_value, index) => pos(4 + index, 64, 0));
  const stoneState = {};
  const stoneHarness = makeCollectHarness(stonePositions, ({ target, blocks, inventory }) => {
    blocks.delete(posKey(target.position));
    inventory.stone += 1;
  }, { blockName: 'stone', blockId: 1, inventoryItem: 'stone' });
  const stoneResult = await runCollect(
    stoneHarness.bot,
    { block: 'stone', count: 4, maxDistance: 16 },
    collectCtx(new AbortController().signal, stoneState),
  );

  assert.equal(treeResult.ok, true);
  assert.equal(treeState.collectedSoFar, 4);
  assert.equal(treeHarness.collectedTargets.length, 4);
  assert.equal(stoneResult.ok, true);
  assert.equal(stoneState.collectedSoFar, 4);
  assert.equal(stoneHarness.collectedTargets.length, 4);
});

test('collect pickup wait helper only caps satisfied tree cleanup targets', () => {
  assert.equal(effectiveCollectPickupWaitMs(1500, { activeLogCluster: null, collectedSoFar: 1 }, 1), 1500);
  assert.equal(effectiveCollectPickupWaitMs(1500, { activeLogCluster: { block: 'oak_log' }, collectedSoFar: 0 }, 1), 1500);
  assert.equal(effectiveCollectPickupWaitMs(1500, { activeLogCluster: { block: 'oak_log' }, collectedSoFar: 1 }, 1), 500);
  assert.equal(effectiveCollectPickupWaitMs(2500, { activeLogCluster: { block: 'oak_log' }, collectedSoFar: 2 }, 1), 500);
});

test('collect caps pickup wait while cleaning a tree after the requested count is met', async () => {
  const tree = [pos(4, 64, 0), pos(4, 65, 0)];
  const callState = {};
  const harness = makeCollectHarness(tree, ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    blocks.delete(key);
    if (key === posKey(tree[0])) inventory.oak_log += 1;
  });

  const startedAt = Date.now();
  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    collectCtx(new AbortController().signal, callState),
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 oak_log');
  assert.deepEqual(harness.collectedTargets, tree.map(posKey));
  assert.ok(elapsedMs < 1500, `expected capped cleanup to finish quickly, took ${elapsedMs}ms`);
});

test('collect stops satisfied tree cleanup after repeated unreachable leftovers', async () => {
  const tree = [pos(4, 64, 0), pos(4, 65, 0), pos(4, 66, 0)];
  const treeB = pos(8, 64, 0);
  const callState = {};
  const harness = makeCollectHarness([...tree, treeB], ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    if (key !== posKey(tree[0])) throw new Error('Took to long to decide path to goal!');
    blocks.delete(key);
    inventory.oak_log += 1;
  });

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16, treeCleanupFailureLimit: 2 },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 oak_log');
  assert.deepEqual(harness.collectedTargets, tree.map(posKey));
  assert.equal(callState.activeLogCluster, null);
  assert.equal(harness.blocks.has(posKey(treeB)), true);
});

test('collect bounds satisfied tree cleanup target hangs after goal is reached', async () => {
  const tree = [pos(4, 64, 0), pos(4, 65, 0)];
  const callState = {};
  const harness = makeCollectHarness(tree, ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    if (key === posKey(tree[1])) return new Promise(() => {});
    blocks.delete(key);
    inventory.oak_log += 1;
    return undefined;
  });

  const result = await runCollect(
    harness.bot,
    {
      block: 'oak_log',
      count: 1,
      maxDistance: 16,
      treeCleanupFailureLimit: 1,
      treeCleanupTargetTimeoutMs: 20,
    },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 oak_log');
  assert.deepEqual(harness.collectedTargets, tree.map(posKey));
  assert.equal(callState.activeLogCluster, null);
});

test('collect abandons satisfied tree cleanup before the executor skill timeout', async (t) => {
  const originalSkillTimeout = config.executor.skillTimeoutMs;
  config.executor.skillTimeoutMs = 100;
  t.after(() => {
    config.executor.skillTimeoutMs = originalSkillTimeout;
  });

  const tree = [pos(4, 64, 0), pos(4, 65, 0), pos(4, 66, 0)];
  const callState = {
    _executor: {
      startedAtMs: Date.now() - 1000,
      attempts: 1,
      lastInvokeAtMs: Date.now() - 1000,
    },
  };
  const harness = makeCollectHarness(tree, ({ target, blocks, inventory }) => {
    const key = posKey(target.position);
    blocks.delete(key);
    inventory.oak_log += 1;
  });

  const result = await runCollect(
    harness.bot,
    {
      block: 'oak_log',
      count: 1,
      maxDistance: 16,
      treeCleanupMinRemainingMs: 20,
    },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 oak_log');
  assert.deepEqual(harness.collectedTargets, [posKey(tree[0])]);
  assert.equal(callState.activeLogCluster, null);
  assert.equal(harness.blocks.has(posKey(tree[1])), true);
  assert.equal(harness.blocks.has(posKey(tree[2])), true);
});

test('collect active log cluster remembers the support log under the bot', async () => {
  const tree = [pos(4, 64, 0), pos(4, 65, 0), pos(4, 66, 0)];
  const callState = {};
  const harness = makeCollectHarness(tree, ({ target, blocks, inventory }) => {
    blocks.delete(posKey(target.position));
    inventory.oak_log += 1;
  });
  harness.bot.entity.position = pos(4.5, 66.5, 0.5);

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.collectedTargets, [posKey(tree[0]), posKey(tree[1])]);
});

test('collect disables scaffold tower movement while gathering', async () => {
  const target = pos(4, 64, 0);
  const callState = {};
  const harness = makeCollectHarness([target], ({ target: minedTarget, blocks, inventory }) => {
    blocks.delete(posKey(minedTarget.position));
    inventory.oak_log += 1;
  });
  const movements = harness.bot.collectBlock.movements;
  movements.allow1by1towers = true;
  movements.allowParkour = true;
  movements.scafoldingBlocks = [1, 2];

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 1, maxDistance: 16 },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.allowParkour, false);
  assert.deepEqual(movements.scafoldingBlocks, []);
});

test('collect active log cluster scans with Mineflayer-compatible Vec3 positions', async () => {
  const treeA = [pos(4, 64, 0), pos(4, 65, 0), pos(4, 66, 0)];
  const callState = {};
  const harness = makeCollectHarness(treeA, ({ target, blocks, inventory }) => {
    blocks.delete(posKey(target.position));
    inventory.oak_log += 1;
  });
  const originalBlockAt = harness.bot.blockAt;
  harness.bot.blockAt = (p) => {
    if (typeof p?.floored !== 'function') throw new Error('pos.floored is not a function');
    return originalBlockAt(p);
  };

  const result = await runCollect(
    harness.bot,
    { block: 'oak_log', count: 2, maxDistance: 16 },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(harness.collectedTargets, treeA.map(posKey));
});

test('collect can track progress by explicit drop item instead of block item', async () => {
  const target = pos(5, 32, 0);
  const callState = {};
  const harness = makeCollectHarness([target], ({ target: minedTarget, blocks, inventory }) => {
    blocks.delete(posKey(minedTarget.position));
    inventory.coal += 1;
  }, { blockName: 'coal_ore', blockId: 16, inventoryItem: 'coal' });

  const result = await runCollect(
    harness.bot,
    { block: 'coal_ore', count: 1, maxDistance: 16, progressItems: ['coal', 'coal_ore'] },
    collectCtx(new AbortController().signal, callState),
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'collected 1 coal_ore');
  assert.deepEqual(harness.collectedTargets, [posKey(target)]);
  assert.equal(harness.inventory.coal, 1);
  assert.equal(callState.collectedSoFar, 1);
});

test('collect run skips protected visible targets from world model', async () => {
  const inventory = { oak_log: 0 };
  const blocks = new Map([
    [posKey(pos(0, 64, 0)), pos(0, 64, 0)],
    [posKey(pos(8, 64, 0)), pos(8, 64, 0)],
  ]);
  const collected = [];
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: {
      items: () => (inventory.oak_log > 0 ? [{ name: 'oak_log', count: inventory.oak_log }] : []),
    },
    findBlocks: () => [...blocks.values()],
    blockAt(p) {
      const found = blocks.get(posKey(p));
      return found ? { name: 'oak_log', position: found } : null;
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async (target) => {
        collected.push(posKey(target.position));
        blocks.delete(posKey(target.position));
        inventory.oak_log += 1;
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'collect-protected-test' }, release() {} }),
    },
  };

  const result = await runCollect(bot, { block: 'oak_log', count: 1 }, {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldModel: modelWithProtectedBox([0, 63, 0], [2, 66, 2]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(collected, ['8,64,0']);
});

test('collect run reports when only protected targets remain', async () => {
  const protectedTarget = pos(0, 64, 0);
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0, 64, 0) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { items: () => [] },
    findBlocks: () => [protectedTarget],
    blockAt() {
      return { name: 'oak_log', position: protectedTarget };
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async () => {
        throw new Error('should not collect protected target');
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => ({ token: { id: 'collect-all-protected-test' }, release() {} }),
    },
  };

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
    worldModel: modelWithProtectedBox([0, 63, 0], [2, 66, 2]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no more oak_log within 16 blocks (have 0/1, excluded 0, protected 1)');
});

test('collect run refuses to mine the only block supporting the bot', async () => {
  const supportTarget = pos(0, 64, 0);
  let acquireCalls = 0;
  const bot = {
    chunksReady: Promise.resolve(),
    entity: { position: pos(0.5, 65, 0.5) },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    entities: {},
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { items: () => [] },
    findBlocks: () => [supportTarget],
    blockAt() {
      return { name: 'oak_log', position: supportTarget };
    },
    collectBlock: {
      movements: makeMovements(),
      collect: async () => {
        throw new Error('should not collect supporting target');
      },
    },
    stopDigging() {},
    pathfinderOwner: {
      acquire: () => {
        acquireCalls++;
        return { token: { id: 'collect-support-test' }, release() {} };
      },
    },
  };

  const result = await runCollect(bot, { block: 'oak_log', count: 1, maxDistance: 16 }, {
    signal: new AbortController().signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no more oak_log within 16 blocks (have 0/1, excluded 0, supporting-bot 1)');
  assert.equal(acquireCalls, 0);
});
