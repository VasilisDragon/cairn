import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAdvisorLivePlanMarkdown } from '../../scripts/advisor-live-plan.js';
import {
  buildAdvisorArgs,
  buildSetupAdminPlan,
  evaluatePassCriteria,
  parseArgs,
  parseSetupInventory,
  starterWoodFixtureBlocks,
  usage,
} from '../../scripts/iron-tier-verify-live.js';

test('iron tier verifier parses fixture args and setup inventory', () => {
  const opts = parseArgs([
    '--fixture', 'constrained',
    '--setup-teleport', '201', '67', '476',
    '--setup-clear-all',
    '--setup-inventory', 'minecraft:stone_pickaxe:1,coal:8,oak_planks:4,stick:4',
    '--report-path', 'reports/overnight-phase1/iron.json',
    '--timeout-ms', '1800000',
    '--startup-delay-ms', '8000',
  ]);

  assert.equal(opts.fixture, 'constrained');
  assert.deepEqual(opts.setupTeleport, { x: 201, y: 67, z: 476 });
  assert.equal(opts.setupClearAll, true);
  assert.equal(opts.timeoutMs, 1800000);
  assert.equal(opts.startupDelayMs, 8000);
  assert.deepEqual(opts.setupInventory, [
    { item: 'minecraft:stone_pickaxe', count: 1 },
    { item: 'minecraft:coal', count: 8 },
    { item: 'minecraft:oak_planks', count: 4 },
    { item: 'minecraft:stick', count: 4 },
  ]);
});

test('iron tier verifier defaults constrained inventory and keeps from-empty empty', () => {
  assert.deepEqual(
    parseArgs(['--fixture', 'constrained']).setupInventory.map((entry) => `${entry.item}:${entry.count}`),
    [
      'minecraft:stone_pickaxe:1',
      'minecraft:crafting_table:1',
      'minecraft:furnace:1',
      'minecraft:coal:8',
      'minecraft:oak_planks:4',
      'minecraft:stick:4',
    ],
  );
  assert.deepEqual(parseArgs(['--fixture', 'from_empty']).setupInventory, []);
  assert.throws(
    () => parseArgs(['--fixture', 'from_empty', '--setup-inventory', 'coal:1']),
    /from_empty cannot be combined/,
  );
});

test('iron tier verifier supports a starter wood fixture without giving inventory', () => {
  const opts = parseArgs([
    '--fixture', 'from_empty',
    '--setup-teleport', '201', '67', '476',
    '--setup-clear-all',
    '--setup-starter-wood-fixture',
  ]);

  assert.equal(opts.setupStarterWoodFixture, true);
  assert.deepEqual(opts.setupInventory, []);
  const blocks = starterWoodFixtureBlocks(opts);
  assert.equal(blocks.length, 398);
  assert.equal(blocks.filter((block) => block.label.startsWith('starter-fixture-pad-')).length, 363);
  assert.ok(blocks.some((block) => block.x === 196 && block.y === 66 && block.z === 471 && block.block === 'minecraft:grass_block'));
  assert.ok(blocks.some((block) => block.x === 198 && block.y === 67 && block.z === 479 && block.block === 'minecraft:grass_block'));
  assert.ok(blocks.some((block) => block.x === 203 && block.y === 66 && block.z === 474 && block.block === 'minecraft:grass_block'));
  assert.ok(blocks.some((block) => block.x === 203 && block.y === 67 && block.z === 474 && block.block === 'minecraft:oak_log'));
  assert.throws(
    () => parseArgs(['--fixture', 'from_empty', '--setup-starter-wood-fixture']),
    /requires --setup-teleport/,
  );
});

test('setup inventory parser validates entries', () => {
  assert.deepEqual(parseSetupInventory('iron_pickaxe:1,minecraft:cooked_beef:16'), [
    { item: 'minecraft:iron_pickaxe', count: 1 },
    { item: 'minecraft:cooked_beef', count: 16 },
  ]);
  assert.throws(() => parseSetupInventory('bad item:1'), /invalid item/);
  assert.throws(() => parseSetupInventory('coal:0'), /positive integer/);
});

test('iron tier verifier builds deterministic setup admin plan', () => {
  const opts = parseArgs([
    '--setup-teleport', '201', '67', '476',
    '--setup-clear-all',
    '--setup-inventory', 'stone_pickaxe:1,coal:8',
  ]);
  const labels = buildSetupAdminPlan(opts).map((entry) => entry.label);

  assert.deepEqual(labels, [
    'forceload-teleport-chunk',
    'support-teleport-floor',
    'clear-teleport-column',
    'teleport-player',
    'release-teleport-chunk',
    'clear-all',
    'give-stone_pickaxe',
    'give-coal',
  ]);
});

test('iron tier verifier appends starter wood fixture setup after inventory setup', () => {
  const opts = parseArgs([
    '--fixture', 'from_empty',
    '--setup-teleport', '201', '67', '476',
    '--setup-clear-all',
    '--setup-starter-wood-fixture',
  ]);
  const labels = buildSetupAdminPlan(opts).map((entry) => entry.label);

  assert.deepEqual(labels.slice(0, 6), [
    'forceload-teleport-chunk',
    'support-teleport-floor',
    'clear-teleport-column',
    'teleport-player',
    'release-teleport-chunk',
    'clear-all',
  ]);
  assert.equal(labels.filter((label) => label.startsWith('starter-fixture-pad-')).length, 363);
  assert.equal(labels.filter((label) => label.startsWith('starter-fixture-shaft-')).length, 12);
  assert.equal(labels.filter((label) => label.startsWith('starter-fixture-table-pad-')).length, 3);
  assert.equal(labels.filter((label) => label.startsWith('starter-wood-log-')).length, 20);
});

test('iron tier verifier translates fixture setup to advisor live-plan args', () => {
  const opts = parseArgs([
    '--fixture', 'constrained',
    '--setup-teleport', '201', '67', '476',
    '--setup-clear-all',
    '--setup-inventory', 'stone_pickaxe:1,coal:8',
    '--report-path', 'reports/overnight-phase1/iron.json',
  ]);
  const args = buildAdvisorArgs(opts);

  assert.deepEqual(args.slice(0, 4), ['--goal', 'make an iron pickaxe', '--report-path', opts.reportPath]);
  assert.ok(args.includes('--setup-clear-all'));
  assert.ok(args.includes('--induce-after-ms'));
  assert.deepEqual(args.slice(args.indexOf('--setup-give')), [
    '--setup-give', 'minecraft:stone_pickaxe', '1',
    '--setup-give', 'minecraft:coal', '8',
  ]);
});

test('iron tier verifier translates starter wood fixture to advisor setup-block args', () => {
  const opts = parseArgs([
    '--fixture', 'from_empty',
    '--setup-teleport', '201', '67', '476',
    '--setup-clear-all',
    '--setup-starter-wood-fixture',
    '--report-path', 'reports/overnight-phase1/iron.json',
  ]);
  const args = buildAdvisorArgs(opts);
  const blockArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--setup-block') blockArgs.push(args.slice(i, i + 5));
  }

  assert.equal(blockArgs.length, 398);
  assert.ok(blockArgs.some((entry) => entry.join('|') === '--setup-block|196|66|471|minecraft:grass_block'));
  assert.ok(blockArgs.some((entry) => entry.join('|') === '--setup-block|198|67|479|minecraft:grass_block'));
  assert.ok(blockArgs.some((entry) => entry.join('|') === '--setup-block|203|66|474|minecraft:grass_block'));
  assert.ok(blockArgs.some((entry) => entry.join('|') === '--setup-block|203|67|474|minecraft:oak_log'));
});

test('iron tier verifier evaluates pass criteria from synthetic advisor report', () => {
  const report = {
    status: 'live_plan_completed',
    mission: {
      itemGoal: { item: 'iron_pickaxe', count: 1, have: 1, met: true },
    },
    plugin: {
      token: 'abc',
      telemetryPath: 'D:/Minecraft/Server/mcbottest/example.jsonl',
      started: true,
      ended: true,
      finalSnapshot: { ok: true },
      telemetrySummary: { botDeathCount: 0 },
    },
    assertions: {},
  };

  const result = evaluatePassCriteria(report, { fixture: 'constrained', goal: 'make an iron pickaxe' });

  assert.equal(result.ok, true);
  assert.equal(report.ironTierVerifier.ok, true);
  assert.equal(report.ok, true);
  assert.equal(report.outcome, 'success');
  assert.equal(report.status, 'iron_tier_verified');
  assert.equal(report.assertions.targetItemGoal, true);
  assert.equal(report.assertions.ironPickaxeGoal, true);
  assert.deepEqual(result.failures, []);
  const markdown = renderAdvisorLivePlanMarkdown(report);
  assert.match(markdown, /- status: iron_tier_verified/);
  assert.match(markdown, /- outcome: success/);
});

test('iron tier verifier reports failed assertions without false-green', () => {
  const report = {
    status: 'live_plan_completed',
    mission: {
      itemGoal: { item: 'iron_pickaxe', count: 1, have: 0, met: false },
    },
    plugin: {
      token: 'abc',
      telemetryPath: 'D:/Minecraft/Server/mcbottest/example.jsonl',
      started: true,
      ended: true,
      finalSnapshot: { ok: true },
      telemetrySummary: { botDeathCount: 1 },
    },
    assertions: {},
  };

  const result = evaluatePassCriteria(report, { fixture: 'from_empty' });

  assert.equal(result.ok, false);
  assert.equal(report.status, 'iron_tier_assertions_failed');
  assert.ok(result.failures.includes('targetItemGoal'));
  assert.ok(result.failures.includes('ironPickaxeGoal'));
  assert.ok(result.failures.includes('noBotDeath'));
});

test('iron tier verifier accepts non-iron item goals for diamond phase reuse', () => {
  const report = {
    status: 'live_plan_completed',
    mission: {
      itemGoal: { item: 'diamond_pickaxe', count: 1, have: 1, met: true },
    },
    plugin: {
      token: 'abc',
      telemetryPath: 'D:/Minecraft/Server/mcbottest/example.jsonl',
      started: true,
      ended: true,
      finalSnapshot: { ok: true },
      telemetrySummary: { botDeathCount: 0 },
    },
    assertions: {},
  };

  const result = evaluatePassCriteria(report, { fixture: 'from_empty', goal: 'make a diamond pickaxe' });

  assert.equal(result.ok, true);
  assert.equal(report.status, 'diamond_tier_verified');
  assert.equal(report.assertions.targetItemGoal, true);
  assert.equal(report.assertions.ironPickaxeGoal, undefined);
  assert.equal(report.itemGoalVerifier.targetItem, 'diamond_pickaxe');
});

test('iron tier verifier help text documents live gates', () => {
  const text = usage();

  assert.match(text, /MCBOT_LIVE_TESTS=1 required/);
  assert.match(text, /MCBOT_ALLOW_DEEPSEEK=1 required/);
  assert.match(text, /MCBOT_LIVE_ADMIN_OK=1 required/);
  assert.match(text, /setup-inventory format/i);
  assert.match(text, /starter-wood-fixture/i);
});
