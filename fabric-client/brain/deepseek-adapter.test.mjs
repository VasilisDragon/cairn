import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPromptMessages,
  compactSnapshot,
  createDeepseekBrainHandler,
  createMetrics,
  exhaustionBackoffDecision,
  parseBrainRequest,
  parseDeepseekIntentReply,
  parseJsonObjectWithRepair,
  stalenessDecision,
  stopIntent,
  withAdapterExpiry,
} from './deepseek-adapter.js';

const snapshot = {
  x: 10.25,
  y: 72,
  z: -3.75,
  yaw: 90,
  pitch: 0,
  onGround: true,
  touchingWater: false,
  health: 20,
  inventoryLogCount: 0,
  inventoryLogsByItem: {},
  inventoryPlankCount: 0,
  inventoryPlanksByItem: {},
  inventoryStickCount: 0,
  inventorySticksByItem: {},
  inventoryCraftingTableCount: 0,
  inventoryCraftingTablesByItem: {},
  inventoryWoodenPickaxeCount: 0,
  inventoryWoodenPickaxesByItem: {},
  inventoryCobblestoneCount: 0,
  inventoryCobblestoneByItem: {},
  inventoryStonePickaxeCount: 0,
  inventoryStonePickaxesByItem: {},
  inventoryStoneAxeCount: 0,
  inventoryStoneAxesByItem: {},
  inventoryStoneSwordCount: 0,
  inventoryStoneSwordsByItem: {},
  inventoryFurnaceCount: 0,
  inventoryFurnacesByItem: {},
  inventoryCharcoalCount: 0,
  inventoryCharcoalByItem: {},
  inventoryCoalCount: 0,
  inventoryCoalByItem: {},
  inventoryRawIronCount: 0,
  inventoryRawIronByItem: {},
  inventoryIronIngotCount: 0,
  inventoryIronIngotsByItem: {},
  inventoryIronPickaxeCount: 0,
  inventoryIronPickaxesByItem: {},
  nearbyLogs: [
    { block: 'oak_log', x: 12, y: 64, z: -4, distance: 2.1 },
    { block: 'birch_log', x: 14, y: 65, z: -2, distance: 4.9 },
  ],
  inputForward: true,
  activeNavigationCommandId: 'old-nav',
  navigationRouteComputed: true,
  navigationRouteLength: 4,
  navigationWaypointIndex: 2,
  navigationWaypointX: 12,
  navigationWaypointZ: -4,
  navigationWaypointDistance: 1.2,
  terrainProbe: {
    currentCellX: 10,
    currentCellZ: -4,
    currentSurfaceY: 72,
    currentFeetSolid: false,
    currentHeadSolid: false,
    currentHazard: false,
    aheadDirection: 'east',
    aheadStepDelta: 0,
    perceptionAheadWalkable: true,
    perceptionAheadIssue: 'NONE',
  },
};

test('parseBrainRequest honors the Fabric IPC first-line contract', () => {
  const parsed = parseBrainRequest(`instanceId:abc-123\n${JSON.stringify(snapshot)}\n`);
  assert.equal(parsed.instanceId, 'abc-123');
  assert.equal(parsed.snapshot.x, snapshot.x);
});

test('compactSnapshot keeps only prompt-sized navigation context', () => {
  const compact = compactSnapshot(snapshot);
  assert.deepEqual(Object.keys(compact).sort(), [
    'activeNavigationCommandId',
    'health',
    'input',
    'inventory',
    'navigation',
    'nearbyLogs',
    'onGround',
    'pitch',
    'terrain',
    'touchingWater',
    'x',
    'y',
    'yaw',
    'z',
  ]);
  assert.equal(compact.terrain.currentHazard, false);
  assert.equal(compact.navigation.routeLength, 4);
  assert.equal(compact.inventory.logCount, 0);
  assert.equal(compact.inventory.plankCount, 0);
  assert.equal(compact.inventory.stickCount, 0);
  assert.equal(compact.inventory.craftingTableCount, 0);
  assert.equal(compact.inventory.woodenPickaxeCount, 0);
  assert.equal(compact.inventory.charcoalCount, 0);
  assert.equal(compact.inventory.coalCount, 0);
  assert.equal(compact.inventory.rawIronCount, 0);
  assert.equal(compact.inventory.ironIngotCount, 0);
  assert.equal(compact.inventory.ironPickaxeCount, 0);
  assert.equal(compact.nearbyLogs[0].block, 'oak_log');
});

test('buildPromptMessages emits a small JSON-only target-selection prompt', () => {
  const messages = buildPromptMessages(snapshot, {
    requestIndex: 2,
    ttlMs: 1200,
    maxTtlMs: 1500,
    directionSequence: 'north,west',
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /No prose/);
  assert.match(messages[0].content, /under 180 characters/);
  assert.match(messages[0].content, /"ttlMs":1200/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.directionHint, 'west');
  assert.equal(payload.ttlMs, 1200);
  assert.equal(payload.responseRules.jsonObjectOnly, true);
  assert.equal(payload.snapshot.x, 10.25);
  assert.equal(payload.task, 'navigate');
});

test('buildPromptMessages can ask DeepSeek to choose one visible log target only', () => {
  const messages = buildPromptMessages(snapshot, {
    requestIndex: 1,
    task: 'gather_log',
    ttlMs: 5000,
    maxTtlMs: 6000,
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /only pick one log target/);
  assert.match(messages[0].content, /"action":"gather_log"/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'gather_log');
  assert.equal(payload.snapshot.nearbyLogs[0].x, 12);
  assert.equal(payload.snapshot.inventory.logCount, 0);
});

test('buildPromptMessages can ask DeepSeek to choose one tree seed target only', () => {
  const messages = buildPromptMessages(snapshot, {
    requestIndex: 1,
    task: 'gather_tree',
    ttlMs: 7000,
    maxTtlMs: 8000,
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /one seed log for a tree/);
  assert.match(messages[0].content, /"action":"gather_tree"/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'gather_tree');
  assert.equal(payload.snapshot.nearbyLogs[0].x, 12);
  assert.equal(payload.snapshot.inventory.logCount, 0);
});

test('buildPromptMessages can ask DeepSeek to craft planks only', () => {
  const messages = buildPromptMessages({ ...snapshot, inventoryLogCount: 1 }, {
    requestIndex: 1,
    task: 'craft_planks',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /inventory slot clicks/);
  assert.match(messages[0].content, /"action":"craft_planks"/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'craft_planks');
  assert.equal(payload.snapshot.inventory.logCount, 1);
});

test('buildPromptMessages can ask DeepSeek to craft sticks or table only', () => {
  const sticks = buildPromptMessages({ ...snapshot, inventoryPlankCount: 2 }, {
    requestIndex: 1,
    task: 'craft_sticks',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(sticks[0].content, /"action":"craft_sticks"/);
  assert.match(sticks[0].content, /at least 2 planks/);
  assert.equal(JSON.parse(sticks[1].content).task, 'craft_sticks');

  const table = buildPromptMessages({ ...snapshot, inventoryPlankCount: 4 }, {
    requestIndex: 1,
    task: 'craft_table',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(table[0].content, /"action":"craft_table"/);
  assert.match(table[0].content, /at least 4 planks/);
  assert.equal(JSON.parse(table[1].content).task, 'craft_table');
});

test('buildPromptMessages can ask DeepSeek to craft a wooden pickaxe only', () => {
  const messages = buildPromptMessages({ ...snapshot, inventoryPlankCount: 3, inventoryStickCount: 2 }, {
    requestIndex: 1,
    task: 'craft_pickaxe',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(messages[0].content, /opening the placed crafting table/);
  assert.match(messages[0].content, /"action":"craft_pickaxe"/);
  assert.match(messages[0].content, /at least 3 planks and 2 sticks/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'craft_pickaxe');
  assert.equal(payload.snapshot.inventory.plankCount, 3);
  assert.equal(payload.snapshot.inventory.stickCount, 2);
});

test('buildPromptMessages can ask DeepSeek to craft stone tools through the 3x3 path', () => {
  const pickaxe = buildPromptMessages({ ...snapshot, inventoryCobblestoneCount: 3, inventoryStickCount: 2 }, {
    requestIndex: 1,
    task: 'craft_stone_tools',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(pickaxe[0].content, /"action":"craft_stone_pickaxe"/);
  assert.match(pickaxe[0].content, /typed stone_pickaxe verification/);
  assert.match(pickaxe[0].content, /at least 3 cobblestone and 2 sticks/);
  assert.equal(JSON.parse(pickaxe[1].content).task, 'craft_stone_tools');

  const axe = buildPromptMessages({ ...snapshot, inventoryCobblestoneCount: 3, inventoryStickCount: 2 }, {
    requestIndex: 1,
    task: 'craft_stone_axe',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(axe[0].content, /"action":"craft_stone_axe"/);
  assert.match(axe[0].content, /typed stone_axe verification/);

  const sword = buildPromptMessages({ ...snapshot, inventoryCobblestoneCount: 2, inventoryStickCount: 1 }, {
    requestIndex: 1,
    task: 'craft_stone_sword',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(sword[0].content, /"action":"craft_stone_sword"/);
  assert.match(sword[0].content, /typed stone_sword verification/);

  const furnace = buildPromptMessages({ ...snapshot, inventoryCobblestoneCount: 8 }, {
    requestIndex: 1,
    task: 'craft_furnace',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(furnace[0].content, /"action":"craft_furnace"/);
  assert.match(furnace[0].content, /typed furnace verification/);
  assert.match(furnace[0].content, /at least 8 cobblestone/);
});

test('buildPromptMessages can ask DeepSeek to place a table or furnace only', () => {
  const table = buildPromptMessages({ ...snapshot, inventoryCraftingTableCount: 1 }, {
    requestIndex: 1,
    task: 'place_table',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(table[0].content, /raycast-gated interactBlock/);
  assert.match(table[0].content, /"action":"place_table"/);
  const payload = JSON.parse(table[1].content);
  assert.equal(payload.task, 'place_table');
  assert.equal(payload.snapshot.inventory.craftingTableCount, 1);

  const furnace = buildPromptMessages({ ...snapshot, inventoryFurnaceCount: 1 }, {
    requestIndex: 1,
    task: 'place_furnace',
    ttlMs: 4000,
    maxTtlMs: 5000,
  });
  assert.match(furnace[0].content, /sneak-if-adjacent handling/);
  assert.match(furnace[0].content, /"action":"place_furnace"/);
  const furnacePayload = JSON.parse(furnace[1].content);
  assert.equal(furnacePayload.task, 'place_furnace');
  assert.equal(furnacePayload.snapshot.inventory.furnaceCount, 1);
});

test('buildPromptMessages can ask DeepSeek to smelt charcoal only', () => {
  const messages = buildPromptMessages({ ...snapshot, inventoryLogCount: 1, inventoryPlankCount: 1 }, {
    requestIndex: 1,
    task: 'smelt_charcoal',
    ttlMs: 90000,
    maxTtlMs: 90000,
  });
  assert.match(messages[0].content, /opening the furnace GUI/);
  assert.match(messages[0].content, /"action":"smelt_charcoal"/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'smelt_charcoal');
  assert.equal(payload.snapshot.inventory.logCount, 1);
  assert.equal(payload.snapshot.inventory.plankCount, 1);
});

test('buildPromptMessages can ask DeepSeek to make charcoal as a composite only', () => {
  const messages = buildPromptMessages({ ...snapshot, inventoryCobblestoneCount: 8, inventoryLogCount: 1, inventoryPlankCount: 1 }, {
    requestIndex: 1,
    task: 'make_charcoal',
    ttlMs: 140000,
    maxTtlMs: 140000,
  });
  assert.match(messages[0].content, /full make-charcoal composite/);
  assert.match(messages[0].content, /adapter already verified/);
  assert.match(messages[0].content, /"action":"make_charcoal"/);
  assert.doesNotMatch(messages[0].content, /no_materials/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'make_charcoal');
  assert.equal(payload.preconditionsVerified, true);
  assert.equal(payload.expectedAction, 'make_charcoal');
  assert.equal(payload.snapshot.inventory.cobblestoneCount, 8);
  assert.equal(payload.snapshot.inventory.logCount, 1);
  assert.equal(payload.snapshot.inventory.plankCount, 1);
});

test('buildPromptMessages can ask DeepSeek to start the R2 composite only', () => {
  const messages = buildPromptMessages({ ...snapshot, inventoryWoodenPickaxeCount: 1, inventoryCobblestoneCount: 0 }, {
    requestIndex: 1,
    task: 'r2_mine_stone_return',
    ttlMs: 60000,
    maxTtlMs: 90000,
  });
  assert.match(messages[0].content, /Java fast loop owns safe staircase descent/);
  assert.match(messages[0].content, /"action":"r2_mine_stone_return"/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'r2_mine_stone_return');
  assert.equal(payload.snapshot.inventory.woodenPickaxeCount, 1);
  assert.equal(payload.snapshot.inventory.cobblestoneCount, 0);
});

test('buildPromptMessages exposes the configured R2 depth for deep descent runs', () => {
  const messages = buildPromptMessages({ ...snapshot, inventoryWoodenPickaxeCount: 1 }, {
    requestIndex: 1,
    task: 'r2_mine_stone_return',
    ttlMs: 60000,
    maxTtlMs: 90000,
    r2Depth: 18,
    maxR2Depth: 20,
  });
  assert.match(messages[0].content, /"depth":18/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.r2Depth, 18);
  assert.equal(payload.maxR2Depth, 20);
});

test('buildPromptMessages can ask DeepSeek to rubber-stamp the R5 iron chain only', () => {
  const messages = buildPromptMessages({
    ...snapshot,
    inventoryStonePickaxeCount: 4,
    inventoryStickCount: 8,
    inventoryCraftingTableCount: 1,
    inventoryFurnaceCount: 1,
    inventoryCharcoalCount: 8,
  }, {
    requestIndex: 1,
    task: 'r5_iron_chain',
    ttlMs: 660000,
    maxTtlMs: 660000,
    r2Depth: 64,
    maxR2Depth: 96,
    directionSequence: 'west',
  });
  assert.match(messages[0].content, /full R5 iron-chain verifier/);
  assert.match(messages[0].content, /"action":"r5_iron_chain"/);
  assert.match(messages[0].content, /adapter already verified/);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.task, 'r5_iron_chain');
  assert.equal(payload.expectedAction, 'r5_iron_chain');
  assert.equal(payload.directionHint, 'west');
  assert.equal(payload.snapshot.inventory.stonePickaxeCount, 4);
  assert.equal(payload.snapshot.inventory.ironPickaxeCount, 0);
});

test('parseDeepseekIntentReply maps direction replies to navigate_to_point intents', () => {
  const intent = parseDeepseekIntentReply(
    '{"direction":"east","blocks":4,"ttlMs":250,"reason":"go east"}',
    snapshot,
    { requestIndex: 7 },
  );
  assert.equal(intent.action, 'navigate_to_point');
  assert.equal(intent.targetX, 14.25);
  assert.equal(intent.targetZ, -3.75);
  assert.equal(intent.ttlMs, 250);
  assert.equal(intent.commandId, 'deepseek-nav-7');
});

test('parseDeepseekIntentReply clamps direction distance to adapter bounds', () => {
  const intent = parseDeepseekIntentReply(
    '{"direction":"north","blocks":99,"ttlMs":250,"reason":"long target"}',
    snapshot,
    { targetDistanceBlocks: 10, maxTargetDistanceBlocks: 12 },
  );
  assert.equal(intent.targetX, 10.25);
  assert.equal(intent.targetZ, -15.75);
});

test('parseDeepseekIntentReply accepts explicit target replies and clamps ttl', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"navigate_to_point","targetX":12.5,"targetZ":-8.5,"ttlMs":5000,"arriveEpsilon":0.5}',
    snapshot,
    { maxTtlMs: 500, commandPrefix: 't', requestIndex: 1 },
  );
  assert.equal(intent.targetX, 12.5);
  assert.equal(intent.targetZ, -8.5);
  assert.equal(intent.ttlMs, 500);
  assert.equal(intent.arriveEpsilon, 0.5);
});

test('parseDeepseekIntentReply accepts visible gather_log targets with targetY', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"gather_log","targetX":12,"targetY":64,"targetZ":-4,"ttlMs":5000,"reason":"log"}',
    snapshot,
    { maxTtlMs: 6000, requestIndex: 3 },
  );
  assert.equal(intent.action, 'gather_log');
  assert.equal(intent.targetX, 12);
  assert.equal(intent.targetY, 64);
  assert.equal(intent.targetZ, -4);
  assert.equal(intent.commandId, 'deepseek-gather-3');
});

test('parseDeepseekIntentReply accepts visible gather_tree targets with targetY', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"gather_tree","targetX":12,"targetY":64,"targetZ":-4,"ttlMs":5000,"reason":"tree"}',
    snapshot,
    { maxTtlMs: 6000, requestIndex: 4 },
  );
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.targetX, 12);
  assert.equal(intent.targetY, 64);
  assert.equal(intent.targetZ, -4);
  assert.equal(intent.commandId, 'deepseek-tree-4');
});

test('parseDeepseekIntentReply accepts craft_planks only when logs are present', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"craft_planks","ttlMs":5000,"reason":"planks"}',
    { ...snapshot, inventoryLogCount: 1 },
    { maxTtlMs: 6000, requestIndex: 5 },
  );
  assert.equal(intent.action, 'craft_planks');
  assert.equal(intent.commandId, 'deepseek-craft-5');

  const noLogs = parseDeepseekIntentReply(
    '{"action":"craft_planks","ttlMs":5000,"reason":"planks"}',
    snapshot,
    { maxTtlMs: 6000, requestIndex: 6 },
  );
  assert.equal(noLogs.action, 'stop');
  assert.equal(noLogs.reason, 'craft_planks_no_logs');
});

test('parseDeepseekIntentReply accepts shaped 2x2 crafts only when planks are present', () => {
  const sticks = parseDeepseekIntentReply(
    '{"action":"craft_sticks","ttlMs":5000,"reason":"sticks"}',
    { ...snapshot, inventoryPlankCount: 2 },
    { maxTtlMs: 6000, requestIndex: 7 },
  );
  assert.equal(sticks.action, 'craft_sticks');
  assert.equal(sticks.commandId, 'deepseek-craft-7');

  const noStickPlanks = parseDeepseekIntentReply(
    '{"action":"craft_sticks","ttlMs":5000,"reason":"sticks"}',
    { ...snapshot, inventoryPlankCount: 1 },
    { maxTtlMs: 6000, requestIndex: 8 },
  );
  assert.equal(noStickPlanks.action, 'stop');
  assert.equal(noStickPlanks.reason, 'craft_sticks_no_planks');

  const table = parseDeepseekIntentReply(
    '{"action":"craft_table","ttlMs":5000,"reason":"table"}',
    { ...snapshot, inventoryPlankCount: 4 },
    { maxTtlMs: 6000, requestIndex: 9 },
  );
  assert.equal(table.action, 'craft_table');
  assert.equal(table.commandId, 'deepseek-craft-9');

  const noTablePlanks = parseDeepseekIntentReply(
    '{"action":"craft_table","ttlMs":5000,"reason":"table"}',
    { ...snapshot, inventoryPlankCount: 3 },
    { maxTtlMs: 6000, requestIndex: 10 },
  );
  assert.equal(noTablePlanks.action, 'stop');
  assert.equal(noTablePlanks.reason, 'craft_table_no_planks');
});

test('parseDeepseekIntentReply accepts 3x3 wooden pickaxe only when materials are present', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"craft_pickaxe","ttlMs":5000,"reason":"pickaxe"}',
    { ...snapshot, inventoryPlankCount: 3, inventoryStickCount: 2 },
    { maxTtlMs: 6000, requestIndex: 11 },
  );
  assert.equal(intent.action, 'craft_pickaxe');
  assert.equal(intent.commandId, 'deepseek-craft-11');

  const noPlanks = parseDeepseekIntentReply(
    '{"action":"craft_pickaxe","ttlMs":5000,"reason":"pickaxe"}',
    { ...snapshot, inventoryPlankCount: 2, inventoryStickCount: 2 },
    { maxTtlMs: 6000, requestIndex: 12 },
  );
  assert.equal(noPlanks.action, 'stop');
  assert.equal(noPlanks.reason, 'craft_pickaxe_no_planks');

  const noSticks = parseDeepseekIntentReply(
    '{"action":"craft_pickaxe","ttlMs":5000,"reason":"pickaxe"}',
    { ...snapshot, inventoryPlankCount: 3, inventoryStickCount: 1 },
    { maxTtlMs: 6000, requestIndex: 13 },
  );
  assert.equal(noSticks.action, 'stop');
  assert.equal(noSticks.reason, 'craft_pickaxe_no_sticks');
});

test('parseDeepseekIntentReply accepts stone tools only when materials are present', () => {
  const pickaxe = parseDeepseekIntentReply(
    '{"action":"craft_stone_pickaxe","ttlMs":5000,"reason":"stone_pickaxe"}',
    { ...snapshot, inventoryCobblestoneCount: 3, inventoryStickCount: 2 },
    { maxTtlMs: 6000, requestIndex: 14 },
  );
  assert.equal(pickaxe.action, 'craft_stone_pickaxe');
  assert.equal(pickaxe.commandId, 'deepseek-craft-14');

  const noPickaxeCobble = parseDeepseekIntentReply(
    '{"action":"craft_stone_pickaxe","ttlMs":5000,"reason":"stone_pickaxe"}',
    { ...snapshot, inventoryCobblestoneCount: 2, inventoryStickCount: 2 },
    { maxTtlMs: 6000, requestIndex: 15 },
  );
  assert.equal(noPickaxeCobble.action, 'stop');
  assert.equal(noPickaxeCobble.reason, 'craft_stone_pickaxe_no_cobblestone');

  const axe = parseDeepseekIntentReply(
    '{"action":"craft_stone_axe","ttlMs":5000,"reason":"stone_axe"}',
    { ...snapshot, inventoryCobblestoneCount: 3, inventoryStickCount: 2 },
    { maxTtlMs: 6000, requestIndex: 16 },
  );
  assert.equal(axe.action, 'craft_stone_axe');

  const sword = parseDeepseekIntentReply(
    '{"action":"craft_stone_sword","ttlMs":5000,"reason":"stone_sword"}',
    { ...snapshot, inventoryCobblestoneCount: 2, inventoryStickCount: 1 },
    { maxTtlMs: 6000, requestIndex: 17 },
  );
  assert.equal(sword.action, 'craft_stone_sword');

  const noSwordSticks = parseDeepseekIntentReply(
    '{"action":"craft_stone_sword","ttlMs":5000,"reason":"stone_sword"}',
    { ...snapshot, inventoryCobblestoneCount: 2, inventoryStickCount: 0 },
    { maxTtlMs: 6000, requestIndex: 18 },
  );
  assert.equal(noSwordSticks.action, 'stop');
  assert.equal(noSwordSticks.reason, 'craft_stone_sword_no_sticks');

  const furnace = parseDeepseekIntentReply(
    '{"action":"craft_furnace","ttlMs":5000,"reason":"furnace"}',
    { ...snapshot, inventoryCobblestoneCount: 8 },
    { maxTtlMs: 6000, requestIndex: 19 },
  );
  assert.equal(furnace.action, 'craft_furnace');

  const noFurnaceCobble = parseDeepseekIntentReply(
    '{"action":"craft_furnace","ttlMs":5000,"reason":"furnace"}',
    { ...snapshot, inventoryCobblestoneCount: 7 },
    { maxTtlMs: 6000, requestIndex: 20 },
  );
  assert.equal(noFurnaceCobble.action, 'stop');
  assert.equal(noFurnaceCobble.reason, 'craft_furnace_no_cobblestone');
});

test('parseDeepseekIntentReply accepts place workstation actions only when item is present', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"place_table","ttlMs":5000,"reason":"place"}',
    { ...snapshot, inventoryCraftingTableCount: 1 },
    { maxTtlMs: 6000, requestIndex: 11 },
  );
  assert.equal(intent.action, 'place_table');
  assert.equal(intent.commandId, 'deepseek-place-11');

  const noTable = parseDeepseekIntentReply(
    '{"action":"place_table","ttlMs":5000,"reason":"place"}',
    snapshot,
    { maxTtlMs: 6000, requestIndex: 12 },
  );
  assert.equal(noTable.action, 'stop');
  assert.equal(noTable.reason, 'place_table_no_table');

  const furnace = parseDeepseekIntentReply(
    '{"action":"place_furnace","ttlMs":5000,"reason":"place"}',
    { ...snapshot, inventoryFurnaceCount: 1 },
    { maxTtlMs: 6000, requestIndex: 13 },
  );
  assert.equal(furnace.action, 'place_furnace');
  assert.equal(furnace.commandId, 'deepseek-place-13');

  const noFurnace = parseDeepseekIntentReply(
    '{"action":"place_furnace","ttlMs":5000,"reason":"place"}',
    snapshot,
    { maxTtlMs: 6000, requestIndex: 14 },
  );
  assert.equal(noFurnace.action, 'stop');
  assert.equal(noFurnace.reason, 'place_furnace_no_furnace');
});

test('parseDeepseekIntentReply accepts smelt_charcoal only when input and fuel are present', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"smelt_charcoal","ttlMs":90000,"reason":"charcoal"}',
    { ...snapshot, inventoryLogCount: 1, inventoryPlankCount: 1 },
    { maxTtlMs: 90000, requestIndex: 21 },
  );
  assert.equal(intent.action, 'smelt_charcoal');
  assert.equal(intent.commandId, 'deepseek-smelt-21');

  const noInput = parseDeepseekIntentReply(
    '{"action":"smelt_charcoal","ttlMs":90000,"reason":"charcoal"}',
    { ...snapshot, inventoryLogCount: 0, inventoryPlankCount: 1 },
    { maxTtlMs: 90000, requestIndex: 22 },
  );
  assert.equal(noInput.action, 'stop');
  assert.equal(noInput.reason, 'smelt_charcoal_no_log_input');

  const noFuel = parseDeepseekIntentReply(
    '{"action":"smelt_charcoal","ttlMs":90000,"reason":"charcoal"}',
    { ...snapshot, inventoryLogCount: 1, inventoryPlankCount: 0 },
    { maxTtlMs: 90000, requestIndex: 23 },
  );
  assert.equal(noFuel.action, 'stop');
  assert.equal(noFuel.reason, 'smelt_charcoal_no_fuel');
});

test('parseDeepseekIntentReply accepts make_charcoal only when composite materials are present', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"make_charcoal","ttlMs":140000,"reason":"make_charcoal"}',
    { ...snapshot, inventoryCobblestoneCount: 8, inventoryLogCount: 1, inventoryPlankCount: 1 },
    { maxTtlMs: 140000, requestIndex: 24 },
  );
  assert.equal(intent.action, 'make_charcoal');
  assert.equal(intent.commandId, 'deepseek-make-24');

  const noCobble = parseDeepseekIntentReply(
    '{"action":"make_charcoal","ttlMs":140000,"reason":"make_charcoal"}',
    { ...snapshot, inventoryCobblestoneCount: 7, inventoryLogCount: 1, inventoryPlankCount: 1 },
    { maxTtlMs: 140000, requestIndex: 25 },
  );
  assert.equal(noCobble.action, 'stop');
  assert.equal(noCobble.reason, 'make_charcoal_no_cobblestone');

  const noFuel = parseDeepseekIntentReply(
    '{"action":"make_charcoal","ttlMs":140000,"reason":"make_charcoal"}',
    { ...snapshot, inventoryCobblestoneCount: 8, inventoryLogCount: 1, inventoryPlankCount: 0 },
    { maxTtlMs: 140000, requestIndex: 26 },
  );
  assert.equal(noFuel.action, 'stop');
  assert.equal(noFuel.reason, 'make_charcoal_no_fuel');
});

test('parseDeepseekIntentReply accepts r2 composite direction replies with targetY', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"r2_mine_stone_return","direction":"east","depth":6,"ttlMs":60000,"reason":"cobble"}',
    { ...snapshot, x: -314.85, y: 101, z: -134.68 },
    { maxTtlMs: 90000, requestIndex: 14 },
  );
  assert.equal(intent.action, 'r2_mine_stone_return');
  assert.equal(intent.targetX, -309);
  assert.equal(intent.targetY, 95);
  assert.equal(intent.targetZ, -135);
  assert.equal(intent.ttlMs, 60000);
  assert.equal(intent.commandId, 'deepseek-r2-14');
});

test('parseDeepseekIntentReply uses harness R2 depth over model depth for forced deep tests', () => {
  const intent = parseDeepseekIntentReply(
    '{"action":"r2_mine_stone_return","direction":"south","depth":6,"ttlMs":60000,"reason":"cobble"}',
    { ...snapshot, x: 20.2, y: 80, z: 30.7 },
    { maxTtlMs: 90000, requestIndex: 16, r2Depth: 18, maxR2Depth: 20 },
  );
  assert.equal(intent.action, 'r2_mine_stone_return');
  assert.equal(intent.targetX, 20);
  assert.equal(intent.targetY, 62);
  assert.equal(intent.targetZ, 48);
});

test('parseDeepseekIntentReply rejects r2 composite targets that do not descend', () => {
  const events = [];
  const intent = parseDeepseekIntentReply(
    '{"action":"r2_mine_stone_return","targetX":1,"targetY":101,"targetZ":1,"ttlMs":60000,"reason":"bad"}',
    { ...snapshot, y: 101 },
    { maxTtlMs: 90000, requestIndex: 15, onParseEvent: (event) => events.push(event) },
  );
  assert.equal(intent.action, 'stop');
  assert.equal(intent.reason, 'adapter_r2_target_not_below_start');
  assert.equal(events.some((event) => event.reason === 'adapter_r2_target_not_below_start'), true);
});

test('parseDeepseekIntentReply accepts R5 chain only with verified fixture kit', () => {
  const readySnapshot = {
    ...snapshot,
    x: 20.2,
    y: 80,
    z: 30.7,
    inventoryStonePickaxeCount: 4,
    inventoryStickCount: 8,
    inventoryCraftingTableCount: 1,
    inventoryFurnaceCount: 1,
    inventoryCharcoalCount: 8,
  };
  const intent = parseDeepseekIntentReply(
    '{"action":"r5_iron_chain","direction":"east","depth":12,"ttlMs":660000,"reason":"iron_chain"}',
    readySnapshot,
    { maxTtlMs: 660000, requestIndex: 17, r2Depth: 64, maxR2Depth: 96, r5Direction: 'west' },
  );
  assert.equal(intent.action, 'r5_iron_chain');
  assert.equal(intent.targetX, -44);
  assert.equal(intent.targetY, 16);
  assert.equal(intent.targetZ, 30);
  assert.equal(intent.commandId, 'deepseek-r5-chain-17');

  const withInjectedIron = parseDeepseekIntentReply(
    '{"action":"r5_iron_chain","direction":"west","ttlMs":660000,"reason":"iron_chain"}',
    { ...readySnapshot, inventoryIronIngotCount: 1 },
    { maxTtlMs: 660000, requestIndex: 18, r2Depth: 64, maxR2Depth: 96 },
  );
  assert.equal(withInjectedIron.action, 'stop');
  assert.equal(withInjectedIron.reason, 'r5_iron_chain_iron_inventory_not_empty');
});

test('parseDeepseekIntentReply rejects gather_log targets not present in nearbyLogs', () => {
  const events = [];
  const intent = parseDeepseekIntentReply(
    '{"action":"gather_log","targetX":99,"targetY":64,"targetZ":99,"ttlMs":5000,"reason":"bad"}',
    snapshot,
    { onParseEvent: (event) => events.push(event) },
  );
  assert.equal(intent.action, 'stop');
  assert.equal(intent.reason, 'adapter_log_target_not_visible');
  assert.equal(events.some((event) => event.stage === 'target_rejected'), true);
});

test('parseDeepseekIntentReply fails closed on malformed or targetless replies', () => {
  assert.equal(parseDeepseekIntentReply('', snapshot).action, 'stop');
  const targetless = parseDeepseekIntentReply('{"direction":"up","ttlMs":250}', snapshot);
  assert.equal(targetless.action, 'stop');
  assert.equal(targetless.reason, 'adapter_no_valid_target');
});

test('parseJsonObjectWithRepair repairs fenced JSON, prose wrappers, trailing commas, and truncation', () => {
  assert.deepEqual(
    parseJsonObjectWithRepair('```json\n{"direction":"east","blocks":4}\n```').repairMethod,
    'strip_code_fence',
  );
  assert.deepEqual(
    parseJsonObjectWithRepair('Sure: {"direction":"south","blocks":2} done.').repairMethod,
    'extract_balanced_object',
  );
  assert.deepEqual(
    parseJsonObjectWithRepair('{"direction":"west","blocks":3,}').repairMethod,
    'drop_trailing_commas',
  );
  const truncated = parseJsonObjectWithRepair('{"direction":"north","blocks":5,"ttlMs":250');
  assert.equal(truncated.ok, true);
  assert.equal(truncated.repairMethod, 'truncation_close');
  assert.equal(truncated.value.direction, 'north');
});

test('parseDeepseekIntentReply emits repair and target rejection events without weakening fail-closed', () => {
  const repairedEvents = [];
  const repaired = parseDeepseekIntentReply(
    '```json\n{"direction":"east","blocks":4,"ttlMs":250}\n```',
    snapshot,
    { onParseEvent: (event) => repairedEvents.push(event) },
  );
  assert.equal(repaired.action, 'navigate_to_point');
  assert.deepEqual(repairedEvents[0], { stage: 'repair', repairMethod: 'strip_code_fence' });

  const rejectedEvents = [];
  const rejected = parseDeepseekIntentReply(
    '{"direction":"up","ttlMs":250}',
    snapshot,
    { onParseEvent: (event) => rejectedEvents.push(event) },
  );
  assert.equal(rejected.action, 'stop');
  assert.equal(rejected.reason, 'adapter_no_valid_target');
  assert.equal(rejectedEvents.some((event) => event.stage === 'target_rejected'), true);
});

test('stalenessDecision applies fresh intents and converts stale ones to safe stop', () => {
  const intent = withAdapterExpiry(
    parseDeepseekIntentReply('{"direction":"south","blocks":3,"ttlMs":100}', snapshot),
    1000,
  );
  assert.equal(stalenessDecision(intent, 1099).state, 'apply');
  const stale = stalenessDecision(intent, 1100);
  assert.equal(stale.state, 'safe_stop');
  assert.equal(stale.intent.action, 'stop');
  assert.equal(stale.intent.reason, 'intent_expired');
});

test('stopIntent is bounded and control-free', () => {
  const stop = stopIntent('manual', { ttlMs: 10000, maxTtlMs: 500, commandId: 'c-stop' });
  assert.equal(stop.action, 'stop');
  assert.equal(stop.forward, false);
  assert.equal(stop.ttlMs, 500);
  assert.equal(stop.commandId, 'c-stop');
});

test('exhaustionBackoffDecision emits once, then delays quiet exhausted polls', () => {
  const state = {};
  const first = exhaustionBackoffDecision(state, 1000, { backoffMs: 5000 });
  assert.deepEqual(first, { quiet: false, delayMs: 0, nextAllowedAtMs: 6000 });
  const second = exhaustionBackoffDecision(state, 1500, { backoffMs: 5000 });
  assert.deepEqual(second, { quiet: true, delayMs: 4500, nextAllowedAtMs: 6000 });
  const third = exhaustionBackoffDecision(state, 6000, { backoffMs: 5000 });
  assert.deepEqual(third, { quiet: false, delayMs: 0, nextAllowedAtMs: 11000 });
});

test('createDeepseekBrainHandler waits for reachable log context before spending gather call', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'gather_log',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '5000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '6000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"gather_log","targetX":12,"targetY":64,"targetZ":-4,"ttlMs":5000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waiting = await handler('instance-a', { ...snapshot, nearbyLogs: [] });
  assert.equal(waiting.action, 'stop');
  assert.equal(waiting.reason, 'waiting_for_nearby_logs');
  assert.equal(callCount, 0);
  assert.equal(metrics.deepseekCallCount, 0);
  assert.equal(metrics.gather.contextWaits, 1);

  const gathered = await handler('instance-a', snapshot);
  assert.equal(gathered.action, 'gather_log');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler quiets completed gather polls without spending calls', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'gather_log',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '5000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '6000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"gather_log","targetX":12,"targetY":64,"targetZ":-4,"ttlMs":5000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const completed = await handler('instance-a', { ...snapshot, inventoryLogCount: 1 });
  assert.equal(completed.action, 'stop');
  assert.equal(completed.reason, 'gather_start_logs_not_zero');
  assert.equal(Object.getOwnPropertyDescriptor(completed, '__quiet')?.value, true);
  assert.equal(callCount, 0);
  assert.equal(metrics.deepseekCallCount, 0);
  assert.equal(metrics.gather.startRejected, 1);
});

test('createDeepseekBrainHandler supports gather_tree without brain substeps', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'gather_tree',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"gather_tree","targetX":12,"targetY":64,"targetZ":-4,"ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const intent = await handler('instance-a', snapshot);
  assert.equal(intent.action, 'gather_tree');
  assert.equal(intent.commandId, 'deepseek-tree-1');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports craft_planks and waits for logs locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'craft_planks',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"craft_planks","ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waiting = await handler('instance-a', snapshot);
  assert.equal(waiting.action, 'stop');
  assert.equal(waiting.reason, 'craft_planks_waiting_for_logs');
  assert.equal(Object.getOwnPropertyDescriptor(waiting, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryLogCount: 1 });
  assert.equal(intent.action, 'craft_planks');
  assert.equal(intent.commandId, 'deepseek-craft-2');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports shaped 2x2 craft tasks and waits for planks locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'craft_table',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"craft_table","ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waiting = await handler('instance-a', { ...snapshot, inventoryPlankCount: 3 });
  assert.equal(waiting.action, 'stop');
  assert.equal(waiting.reason, 'craft_table_waiting_for_planks');
  assert.equal(Object.getOwnPropertyDescriptor(waiting, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryPlankCount: 4 });
  assert.equal(intent.action, 'craft_table');
  assert.equal(intent.commandId, 'deepseek-craft-2');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports 3x3 wooden pickaxe and waits for materials locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'craft_pickaxe',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"craft_pickaxe","ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waitingPlanks = await handler('instance-a', { ...snapshot, inventoryPlankCount: 2, inventoryStickCount: 2 });
  assert.equal(waitingPlanks.action, 'stop');
  assert.equal(waitingPlanks.reason, 'craft_pickaxe_waiting_for_planks');
  assert.equal(Object.getOwnPropertyDescriptor(waitingPlanks, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const waitingSticks = await handler('instance-a', { ...snapshot, inventoryPlankCount: 3, inventoryStickCount: 1 });
  assert.equal(waitingSticks.action, 'stop');
  assert.equal(waitingSticks.reason, 'craft_pickaxe_waiting_for_sticks');
  assert.equal(Object.getOwnPropertyDescriptor(waitingSticks, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryPlankCount: 3, inventoryStickCount: 2 });
  assert.equal(intent.action, 'craft_pickaxe');
  assert.equal(intent.commandId, 'deepseek-craft-3');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports craft_stone_tools and waits for cobblestone and sticks locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'craft_stone_tools',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"craft_stone_pickaxe","ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waitingCobble = await handler('instance-a', { ...snapshot, inventoryCobblestoneCount: 2, inventoryStickCount: 2 });
  assert.equal(waitingCobble.action, 'stop');
  assert.equal(waitingCobble.reason, 'craft_stone_pickaxe_waiting_for_cobblestone');
  assert.equal(Object.getOwnPropertyDescriptor(waitingCobble, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const waitingSticks = await handler('instance-a', { ...snapshot, inventoryCobblestoneCount: 3, inventoryStickCount: 1 });
  assert.equal(waitingSticks.action, 'stop');
  assert.equal(waitingSticks.reason, 'craft_stone_pickaxe_waiting_for_sticks');
  assert.equal(Object.getOwnPropertyDescriptor(waitingSticks, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryCobblestoneCount: 3, inventoryStickCount: 2 });
  assert.equal(intent.action, 'craft_stone_pickaxe');
  assert.equal(intent.commandId, 'deepseek-craft-3');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler can run deterministic setup before a craft DeepSeek call', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'craft_sticks',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
      MCBOT_FABRIC_DEEPSEEK_SETUP_COMMANDS_JSON: '["clear @p minecraft:stick","give @p minecraft:oak_planks 2"]',
      MCBOT_FABRIC_DEEPSEEK_SETUP_SETTLE_MS: '0',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"craft_sticks","ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const setup = await handler('instance-a', snapshot);
  assert.equal(setup.action, 'setup_commands');
  assert.deepEqual(setup.serverCommands, ['clear @p minecraft:stick', 'give @p minecraft:oak_planks 2']);
  assert.equal(Object.getOwnPropertyDescriptor(setup, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryPlankCount: 2 });
  assert.equal(intent.action, 'craft_sticks');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports place_table and waits for a table item locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'place_table',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"place_table","ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waiting = await handler('instance-a', snapshot);
  assert.equal(waiting.action, 'stop');
  assert.equal(waiting.reason, 'place_table_waiting_for_table');
  assert.equal(Object.getOwnPropertyDescriptor(waiting, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryCraftingTableCount: 1 });
  assert.equal(intent.action, 'place_table');
  assert.equal(intent.commandId, 'deepseek-place-2');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports place_furnace and waits for a furnace item locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'place_furnace',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '7000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '8000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"place_furnace","ttlMs":7000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waiting = await handler('instance-a', snapshot);
  assert.equal(waiting.action, 'stop');
  assert.equal(waiting.reason, 'place_furnace_waiting_for_furnace');
  assert.equal(Object.getOwnPropertyDescriptor(waiting, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryFurnaceCount: 1 });
  assert.equal(intent.action, 'place_furnace');
  assert.equal(intent.commandId, 'deepseek-place-2');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports smelt_charcoal and waits for input/fuel locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'smelt_charcoal',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '90000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '90000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"smelt_charcoal","ttlMs":90000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waiting = await handler('instance-a', { ...snapshot, inventoryLogCount: 1, inventoryPlankCount: 0 });
  assert.equal(waiting.action, 'stop');
  assert.equal(waiting.reason, 'smelt_charcoal_waiting_for_fuel');
  assert.equal(Object.getOwnPropertyDescriptor(waiting, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryLogCount: 1, inventoryPlankCount: 1 });
  assert.equal(intent.action, 'smelt_charcoal');
  assert.equal(intent.commandId, 'deepseek-smelt-2');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports make_charcoal and waits for composite materials locally', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'make_charcoal',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '140000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '140000',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"make_charcoal","ttlMs":140000}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const waiting = await handler('instance-a', { ...snapshot, inventoryCobblestoneCount: 8, inventoryLogCount: 1, inventoryPlankCount: 0 });
  assert.equal(waiting.action, 'stop');
  assert.equal(waiting.reason, 'make_charcoal_waiting_for_fuel');
  assert.equal(Object.getOwnPropertyDescriptor(waiting, '__quiet')?.value, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', { ...snapshot, inventoryCobblestoneCount: 8, inventoryLogCount: 1, inventoryPlankCount: 1 });
  assert.equal(intent.action, 'make_charcoal');
  assert.equal(intent.commandId, 'deepseek-make-2');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler supports dynamic R5 iron-chain setup before one DeepSeek call', async () => {
  const metrics = createMetrics();
  let callCount = 0;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_TASK: 'r5_iron_chain',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '660000',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '660000',
      MCBOT_FABRIC_DEEPSEEK_SETUP_KIND: 'r5_iron_chain',
      MCBOT_FABRIC_DEEPSEEK_SETUP_SETTLE_MS: '0',
      MCBOT_FABRIC_R2_DEPTH: '64',
      MCBOT_FABRIC_R2_MAX_DEPTH: '96',
      MCBOT_FABRIC_R5_DIRECTION: 'west',
      MCBOT_FABRIC_DEEPSEEK_DIRECTION_SEQUENCE: 'west',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 2, status: 'normal' }),
    },
    complete: async () => {
      callCount += 1;
      return {
        content: '{"action":"r5_iron_chain","direction":"west","ttlMs":660000,"reason":"iron_chain"}',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const setup = await handler('instance-a', { ...snapshot, x: 20.2, y: 80, z: 30.7 });
  assert.equal(setup.action, 'setup_commands');
  assert.equal(setup.serverCommands.some((command) => command.includes('minecraft:iron_ore replace')), true);
  assert.equal(setup.serverCommands.some((command) => command.includes('difficulty peaceful')), true);
  assert.equal(setup.serverCommands.some((command) => /give @p minecraft:(raw_iron|iron_ingot|iron_pickaxe)/.test(command)), false);
  assert.equal(setup.serverCommands.length <= 32, true);
  assert.equal(callCount, 0);

  const intent = await handler('instance-a', {
    ...snapshot,
    x: 20.2,
    y: 80,
    z: 30.7,
    inventoryStonePickaxeCount: 4,
    inventoryStickCount: 8,
    inventoryCraftingTableCount: 1,
    inventoryFurnaceCount: 1,
    inventoryCharcoalCount: 8,
  });
  assert.equal(intent.action, 'r5_iron_chain');
  assert.equal(intent.targetX, -44);
  assert.equal(intent.targetY, 16);
  assert.equal(intent.targetZ, 30);
  assert.equal(intent.commandId, 'deepseek-r5-chain-2');
  assert.equal(callCount, 1);
  assert.equal(metrics.deepseekCallCount, 1);
});

test('createDeepseekBrainHandler explicitly requests json_object mode and records parse metrics', async () => {
  const metrics = createMetrics();
  let seenOptions = null;
  const handler = createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_MAX_CALLS: '2',
      MCBOT_FABRIC_DEEPSEEK_TTL_MS: '250',
      MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS: '500',
      MCBOT_FABRIC_DEEPSEEK_TASK: 'navigate',
    },
    metrics,
    costGuard: {
      beforeCall: () => ({ ok: true }),
      snapshot: () => ({ sessionCostUsd: 0, maxUsd: 1, status: 'normal' }),
    },
    complete: async (_messages, opts) => {
      seenOptions = opts;
      return {
        content: '```json\n{"direction":"east","blocks":4,"ttlMs":250}\n```',
        responseMetrics: { provider: 'deepseek', model: 'fake', totalTokens: 20 },
      };
    },
  });
  const intent = await handler('instance-a', snapshot);
  assert.equal(intent.action, 'navigate_to_point');
  assert.equal(seenOptions.responseFormatJson, true);
  assert.equal(metrics.parse.repaired, 1);
  assert.equal(metrics.parse.repairMethods.strip_code_fence, 1);
  assert.equal(metrics.responses[0].parse.stage, 'repair');
});

test('createDeepseekBrainHandler honors explicit Fabric cost ceiling above one dollar', () => {
  const metrics = createMetrics();
  createDeepseekBrainHandler({
    env: {
      MCBOT_FABRIC_DEEPSEEK_COST_USD_MAX: '2.25',
      MCBOT_FABRIC_DEEPSEEK_MODEL: 'deepseek-v4-flash',
      MCBOT_FABRIC_R2_DEPTH: '18',
      MCBOT_FABRIC_R2_MAX_DEPTH: '20',
    },
    metrics,
    complete: async () => {
      throw new Error('not called');
    },
  });
  assert.equal(metrics.config.costCeilingUsd, 2.25);
  assert.equal(metrics.config.costCeilingSource, 'MCBOT_FABRIC_DEEPSEEK_COST_USD_MAX');
  assert.equal(metrics.config.model, 'deepseek-v4-flash');
  assert.equal(metrics.config.modelSource, 'MCBOT_FABRIC_DEEPSEEK_MODEL');
  assert.equal(metrics.config.r2Depth, 18);
  assert.equal(metrics.config.maxR2Depth, 20);
});

test('createDeepseekBrainHandler defaults Fabric model to shared DeepSeek config when unset', () => {
  const metrics = createMetrics();
  createDeepseekBrainHandler({
    env: {},
    metrics,
    complete: async () => {
      throw new Error('not called');
    },
  });
  assert.equal(metrics.config.modelSource, 'config.deepseek.model');
  assert.match(metrics.config.model, /^deepseek-/);
  assert.equal(metrics.config.costCeilingUsd, 1);
  assert.equal(metrics.config.costCeilingSource, 'default');
});
