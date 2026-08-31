import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVISOR_SKILL_NAMES,
  RUNTIME_ONLY_SKILL_NAMES,
  advisorSkillContract,
  skillSchemaForPrompt,
  validateAdvisorPlan,
  validatePlan,
  validateSkillCall,
} from '../../src/skills/schema.js';

test('skill schema rejects circular params before executor logging', () => {
  const params = {};
  params.self = params;

  const result = validateSkillCall({ skill: 'observe', params });

  assert.equal(result.ok, false);
  assert.match(result.reason, /observe: params must be JSON-compatible/);
  assert.match(result.reason, /circular reference at params\.self/);
});

test('skill schema rejects non-json primitive params', () => {
  const result = validateSkillCall({
    skill: 'logout',
    params: { reason: 1n },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /logout: params must be JSON-compatible/);
  assert.match(result.reason, /bigint at params\.reason/);
});

test('skill schema rejects unknown params', () => {
  const result = validateSkillCall({
    skill: 'goto',
    params: { x: 1, y: 64, z: 1, code: 'dig down' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'goto: unknown param "code"');
});

test('plan validation reports the index for unknown params', () => {
  const result = validatePlan([
    { skill: 'observe', params: {} },
    { skill: 'collect', params: { block: 'oak_log', count: 1, hack: true } },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 1);
  assert.equal(result.reason, 'collect: unknown param "hack"');
});

test('advisor plan validation rejects runtime-only skills while executor validation allows them', () => {
  const plan = [
    { skill: 'observe', params: {} },
    { skill: 'recover_drops', params: { x: 0, y: 64, z: 0 } },
  ];

  assert.deepEqual(validatePlan(plan), { ok: true });
  const result = validateAdvisorPlan(plan);

  assert.equal(result.ok, false);
  assert.equal(result.badIndex, 1);
  assert.match(result.reason, /recover_drops: not advisor-callable/);
  assert.ok(ADVISOR_SKILL_NAMES.includes('collect'));
  assert.equal(ADVISOR_SKILL_NAMES.includes('excavate_shaft'), true);
  assert.equal(ADVISOR_SKILL_NAMES.includes('recover_drops'), false);
  assert.equal(ADVISOR_SKILL_NAMES.includes('smelt'), true);
  assert.equal(ADVISOR_SKILL_NAMES.includes('mine_with_progression'), true);
  assert.equal(ADVISOR_SKILL_NAMES.includes('place_workstation'), false);
  assert.equal(ADVISOR_SKILL_NAMES.includes('logout'), false);
  assert.deepEqual(RUNTIME_ONLY_SKILL_NAMES, ['place_workstation', 'logout', 'recover_drops']);
  assert.deepEqual(validatePlan([{ skill: 'logout', params: { reason: 'critical-health' } }]), { ok: true });
  assert.match(
    validateAdvisorPlan([{ skill: 'logout', params: { reason: 'provider-request' } }]).reason,
    /logout: not advisor-callable/,
  );
});

test('advisor plan calls reject injected runtime state and every unknown top-level key', () => {
  for (const call of [
    { skill: 'observe', params: {}, _state: { postCalls: [{ skill: 'logout', params: {} }] } },
    { skill: 'observe', params: {}, postCalls: [{ skill: 'logout', params: {} }] },
    { skill: 'observe', params: {}, constructor: { prototype: { polluted: true } } },
  ]) {
    const result = validateAdvisorPlan([call]);
    assert.equal(result.ok, false);
    assert.equal(result.badIndex, 0);
    assert.match(result.reason, /advisor call: unknown field/);
  }

  assert.deepEqual(validatePlan([{
    skill: 'observe',
    params: {},
    _state: { trustedRuntimeResumeMarker: true },
  }]), { ok: true });
  assert.deepEqual(validateAdvisorPlan([{ skill: 'observe' }]), {
    ok: false,
    reason: 'advisor call: missing "params" object',
    badIndex: 0,
  });
  assert.deepEqual(validateAdvisorPlan([{ skill: 'observe', params: null }]), {
    ok: false,
    reason: 'advisor call: "params" must be an object',
    badIndex: 0,
  });
});

test('advisor plan validation rejects known wrong item ids with repair hints', () => {
  const cases = [
    {
      call: { skill: 'craft', params: { item: 'sticks', count: 1 } },
      reason: 'craft.params.item: use "stick" (singular)',
    },
    {
      call: { skill: 'collect', params: { block: 'cobblestones', count: 1 } },
      reason: 'collect.params.block: use "cobblestone" (singular)',
    },
    {
      call: { skill: 'collect', params: { block: 'logs', count: 1 } },
      reason: 'collect.params.block: use a concrete id such as "oak_log" or "jungle_log"',
    },
    {
      call: { skill: 'craft', params: { item: 'planks', count: 1 } },
      reason: 'craft.params.item: use a concrete id such as "oak_planks" or "jungle_planks"',
    },
  ];

  for (const entry of cases) {
    const result = validateAdvisorPlan([entry.call]);
    assert.equal(result.ok, false);
    assert.equal(result.badIndex, 0);
    assert.equal(result.reason, entry.reason);
  }
});

test('advisor skill contract and prompt exclude runtime-only skills', () => {
  const contract = advisorSkillContract();
  const promptSchema = skillSchemaForPrompt();
  const fullSchema = skillSchemaForPrompt({ includeRuntimeOnly: true });

  assert.equal(contract.version, 1);
  assert.ok(contract.plannerSkillNames.includes('collect'));
  assert.ok(contract.plannerSkillNames.includes('mine_until'));
  assert.ok(contract.plannerSkillNames.includes('mine_and_return'));
  assert.equal(contract.plannerSkillNames.includes('recover_drops'), false);
  assert.ok(contract.plannerSkillNames.includes('smelt'));
  assert.ok(contract.plannerSkillNames.includes('mine_with_progression'));
  assert.deepEqual(contract.runtimeOnlySkillNames, ['place_workstation', 'recover_drops']);
  assert.equal(contract.runtimeOnlyReasons.logout, undefined);
  assert.equal(contract.runtimeOnlyReasons.recover_drops, 'scheduled only by deterministic death recovery after a recoverable respawn');
  assert.equal(contract.runtimeOnlyReasons.smelt, undefined);
  assert.equal(contract.runtimeOnlyReasons.mine_with_progression, undefined);
  assert.match(contract.runtimeOnlyReasons.place_workstation, /deterministic progression missions/);
  assert.equal(contract.skillModes.build_from_schematic, 'dry-run-only');
  assert.doesNotMatch(promptSchema, /^- recover_drops:/m);
  assert.match(promptSchema, /^- smelt:/m);
  assert.match(promptSchema, /^- mine_with_progression:/m);
  assert.match(fullSchema, /^- recover_drops:/m);
  assert.match(promptSchema, /^- build_from_schematic:/m);
  assert.match(promptSchema, /^- mine_until:/m);
  assert.match(promptSchema, /^- mine_and_return:/m);
  assert.match(promptSchema, /advisorMode: dry-run-only/);
});

test('skill schema rejects wrong primitive param types', () => {
  const result = validateSkillCall({
    skill: 'craft',
    params: { item: 'stick', count: '2' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'craft: "count" must be number');
});

test('skill schema rejects wrong container param types', () => {
  const result = validateSkillCall({
    skill: 'deposit',
    params: { items: { name: 'oak_log', count: 1 } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'deposit: "items" must be array');
});

test('skill schema rejects null for object params', () => {
  const result = validateSkillCall({
    skill: 'build_from_schematic',
    params: { blocks: [], anchor: null, dryRun: true },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'build_from_schematic: "anchor" must be object');
});

test('skill schema rejects multiple oneOf target forms', () => {
  const result = validateSkillCall({
    skill: 'goto',
    params: { x: 1, y: 64, z: 1, block: 'oak_log' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'goto: must provide exactly one of {x,y,z} OR {block} OR {entity}');
});

test('skill schema rejects multiple build input forms', () => {
  const result = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      schematic: 'simple_dry_run.json',
      blocks: [],
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'build_from_schematic: must provide exactly one of {schematic} OR {blocks}');
});

test('skill schema validates bounded mine_until calls', () => {
  const valid = validateSkillCall({
    skill: 'mine_until',
    params: {
      ores: ['coal_ore', 'iron_ore', 'diamond_ore'],
      count: 3,
      maxAttempts: 12,
      maxDistance: 64,
    },
  });
  const missingTarget = validateSkillCall({
    skill: 'mine_until',
    params: { ores: ['coal_ore'] },
  });
  const bothTargets = validateSkillCall({
    skill: 'mine_until',
    params: { ores: ['coal_ore'], count: 1, durationMs: 1000 },
  });
  const emptyOres = validateSkillCall({
    skill: 'mine_until',
    params: { ores: [], count: 1 },
  });

  assert.equal(valid.ok, true);
  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.reason, 'mine_until: must provide one of {count} OR {durationMs}');
  assert.equal(bothTargets.ok, false);
  assert.equal(bothTargets.reason, 'mine_until: must provide exactly one of {count} OR {durationMs}');
  assert.equal(emptyOres.ok, false);
  assert.equal(emptyOres.reason, 'mine_until: "ores" must contain at least 1 item');
});

test('skill schema validates bounded mine_and_return calls', () => {
  const valid = validateSkillCall({
    skill: 'mine_and_return',
    params: {
      ores: ['coal_ore', 'iron_ore', 'diamond_ore'],
      durationMs: 7200000,
      returnReserveMs: 120000,
      maxAttempts: 128,
      returnChest: { x: 248, y: 68, z: 428 },
    },
  });
  const missingChest = validateSkillCall({
    skill: 'mine_and_return',
    params: { count: 1 },
  });
  const badChest = validateSkillCall({
    skill: 'mine_and_return',
    params: { count: 1, returnChest: { x: 1, y: 2 } },
  });
  const bothTargets = validateSkillCall({
    skill: 'mine_and_return',
    params: { count: 1, durationMs: 1000, returnChest: { x: 1, y: 2, z: 3 } },
  });

  assert.equal(valid.ok, true);
  assert.equal(missingChest.ok, false);
  assert.equal(missingChest.reason, 'mine_and_return: missing required param "returnChest"');
  assert.equal(badChest.ok, false);
  assert.equal(badChest.reason, 'mine_and_return: "returnChest.z" is required');
  assert.equal(bothTargets.ok, false);
  assert.equal(bothTargets.reason, 'mine_and_return: must provide exactly one of {count} OR {durationMs}');
});

test('skill schema validates smelt calls', () => {
  const valid = validateSkillCall({
    skill: 'smelt',
    params: {
      input: 'raw_iron',
      output: 'iron_ingot',
      count: 3,
      fuel: 'coal',
      furnace: { x: 1, y: 64, z: 1 },
      waitTimeoutMs: 60000,
    },
  });
  const missingOutput = validateSkillCall({
    skill: 'smelt',
    params: { input: 'raw_iron', count: 3 },
  });
  const badCount = validateSkillCall({
    skill: 'smelt',
    params: { input: 'raw_iron', output: 'iron_ingot', count: 0 },
  });
  const badFurnace = validateSkillCall({
    skill: 'smelt',
    params: { input: 'raw_iron', output: 'iron_ingot', count: 1, furnace: { x: 1, y: 64 } },
  });
  const advisor = validateAdvisorPlan([{ skill: 'smelt', params: { input: 'raw_iron', output: 'iron_ingot', count: 3 } }]);

  assert.equal(valid.ok, true);
  assert.equal(missingOutput.ok, false);
  assert.equal(missingOutput.reason, 'smelt: missing required param "output"');
  assert.equal(badCount.ok, false);
  assert.equal(badCount.reason, 'smelt: "count" must be >= 1');
  assert.equal(badFurnace.ok, false);
  assert.equal(badFurnace.reason, 'smelt: "furnace.z" is required');
  assert.equal(advisor.ok, true);
});

test('skill schema validates mine_with_progression calls', () => {
  const valid = validateSkillCall({
    skill: 'mine_with_progression',
    params: {
      ores: ['diamond_ore'],
      count: 1,
      furnace: { x: 1, y: 64, z: 1 },
      requireSelfContainedFieldKit: false,
    },
  });
  const duration = validateSkillCall({
    skill: 'mine_with_progression',
    params: {
      ores: ['diamond_ore'],
      durationMs: 60000,
      returnChest: { x: 3, y: 64, z: 0 },
    },
  });
  const missingTarget = validateSkillCall({
    skill: 'mine_with_progression',
    params: { ores: ['diamond_ore'] },
  });
  const bothTargets = validateSkillCall({
    skill: 'mine_with_progression',
    params: { ores: ['diamond_ore'], count: 1, durationMs: 60000 },
  });
  const badFurnace = validateSkillCall({
    skill: 'mine_with_progression',
    params: { ores: ['diamond_ore'], count: 1, furnace: { x: 1, y: 64 } },
  });
  const advisor = validateAdvisorPlan([
    { skill: 'mine_with_progression', params: { ores: ['diamond_ore'], count: 1 } },
  ]);

  assert.equal(valid.ok, true);
  assert.equal(duration.ok, true);
  assert.equal(missingTarget.reason, 'mine_with_progression: must provide one of {count} OR {durationMs}');
  assert.equal(bothTargets.reason, 'mine_with_progression: must provide exactly one of {count} OR {durationMs}');
  assert.equal(badFurnace.reason, 'mine_with_progression: "furnace.z" is required');
  assert.equal(advisor.ok, true);
});

test('skill schema requires build_from_schematic dryRun true', () => {
  const missing = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      blocks: [{ name: 'oak_planks', x: 0, y: 0, z: 0 }],
      anchor: { x: 0, y: 64, z: 0 },
    },
  });
  const falseDryRun = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      blocks: [{ name: 'oak_planks', x: 0, y: 0, z: 0 }],
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: false,
    },
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'build_from_schematic: missing required param "dryRun"');
  assert.equal(falseDryRun.ok, false);
  assert.equal(falseDryRun.reason, 'build_from_schematic: "dryRun" must be one of true');
});

test('skill schema rejects non-positive counts', () => {
  const result = validateSkillCall({
    skill: 'collect',
    params: { block: 'oak_log', count: 0 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'collect: "count" must be >= 1');
});

test('skill schema rejects fractional counts', () => {
  const result = validateSkillCall({
    skill: 'craft',
    params: { item: 'stick', count: 1.5 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'craft: "count" must be an integer');
});

test('skill schema rejects invalid distances and ranges', () => {
  const blockSearch = validateSkillCall({
    skill: 'goto',
    params: { block: 'oak_log', maxDistance: 0 },
  });
  const exactRange = validateSkillCall({
    skill: 'goto',
    params: { x: 0, y: 64, z: 0, range: 0 },
  });
  const negativeRange = validateSkillCall({
    skill: 'goto',
    params: { x: 0, y: 64, z: 0, range: -1 },
  });
  const flee = validateSkillCall({
    skill: 'flee',
    params: { from: 'nearest_hostile', distance: 0 },
  });
  const recoverRange = validateSkillCall({
    skill: 'recover_drops',
    params: { x: 0, y: 64, z: 0, range: -1 },
  });
  const recoverWait = validateSkillCall({
    skill: 'recover_drops',
    params: { x: 0, y: 64, z: 0, waitMs: 1.5 },
  });

  assert.equal(blockSearch.ok, false);
  assert.equal(blockSearch.reason, 'goto: "maxDistance" must be >= 1');
  assert.deepEqual(exactRange, { ok: true });
  assert.equal(negativeRange.ok, false);
  assert.equal(negativeRange.reason, 'goto: "range" must be >= 0');
  assert.equal(flee.ok, false);
  assert.equal(flee.reason, 'flee: "distance" must be >= 1');
  assert.equal(recoverRange.ok, false);
  assert.equal(recoverRange.reason, 'recover_drops: "range" must be >= 0');
  assert.equal(recoverWait.ok, false);
  assert.equal(recoverWait.reason, 'recover_drops: "waitMs" must be an integer');
});

test('skill schema validates deposit item entries', () => {
  const validAll = validateSkillCall({
    skill: 'deposit',
    params: { items: [{ name: 'oak_log' }, { name: 'stick', count: 2 }] },
  });
  const empty = validateSkillCall({
    skill: 'deposit',
    params: { items: [] },
  });
  const missingName = validateSkillCall({
    skill: 'deposit',
    params: { items: [{ count: 1 }] },
  });
  const badCount = validateSkillCall({
    skill: 'deposit',
    params: { items: [{ name: 'oak_log', count: 0 }] },
  });
  const unknown = validateSkillCall({
    skill: 'deposit',
    params: { items: [{ name: 'oak_log', slot: 1 }] },
  });

  assert.deepEqual(validAll, { ok: true });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'deposit: "items" must contain at least 1 item');
  assert.equal(missingName.ok, false);
  assert.equal(missingName.reason, 'deposit: "items[0].name" is required');
  assert.equal(badCount.ok, false);
  assert.equal(badCount.reason, 'deposit: "items[0].count" must be >= 1');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'deposit: "items[0]" unknown field "slot"');
});

test('skill schema validates consume item-use gates', () => {
  const food = validateSkillCall({
    skill: 'consume',
    params: { item: 'cooked_beef' },
  });
  const potion = validateSkillCall({
    skill: 'consume',
    params: { item: 'potion', effect: 'strength', minLevel: 2, allowPotions: true },
  });
  const badEffect = validateSkillCall({
    skill: 'consume',
    params: { item: 'potion', effect: 'haste', allowPotions: true },
  });
  const badLevel = validateSkillCall({
    skill: 'consume',
    params: { item: 'potion', minLevel: 0, allowPotions: true },
  });
  const badFlag = validateSkillCall({
    skill: 'consume',
    params: { item: 'potion', allowPotions: 'yes' },
  });

  assert.deepEqual(food, { ok: true });
  assert.deepEqual(potion, { ok: true });
  assert.equal(badEffect.ok, false);
  assert.equal(badEffect.reason, 'consume: "effect" must be one of fire_resistance|instant_health|regeneration|speed|strength');
  assert.equal(badLevel.ok, false);
  assert.equal(badLevel.reason, 'consume: "minLevel" must be >= 1');
  assert.equal(badFlag.ok, false);
  assert.equal(badFlag.reason, 'consume: "allowPotions" must be boolean');
});

test('skill schema validates bounded fish_until targets', () => {
  const catchTarget = validateSkillCall({
    skill: 'fish_until',
    params: { catches: 3, maxAttempts: 6 },
  });
  const durationTarget = validateSkillCall({
    skill: 'fish_until',
    params: { durationMs: 1000, attemptTimeoutMs: 100, pickupTimeoutMs: 50 },
  });
  const missingTarget = validateSkillCall({
    skill: 'fish_until',
    params: {},
  });
  const multipleTargets = validateSkillCall({
    skill: 'fish_until',
    params: { catches: 3, durationMs: 1000 },
  });
  const badCount = validateSkillCall({
    skill: 'fish_until',
    params: { catches: 0 },
  });
  const badTimeout = validateSkillCall({
    skill: 'fish_until',
    params: { catches: 1, attemptTimeoutMs: 1.5 },
  });

  assert.deepEqual(catchTarget, { ok: true });
  assert.deepEqual(durationTarget, { ok: true });
  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.reason, 'fish_until: must provide one of {catches} OR {durationMs}');
  assert.equal(multipleTargets.ok, false);
  assert.equal(multipleTargets.reason, 'fish_until: must provide exactly one of {catches} OR {durationMs}');
  assert.equal(badCount.ok, false);
  assert.equal(badCount.reason, 'fish_until: "catches" must be >= 1');
  assert.equal(badTimeout.ok, false);
  assert.equal(badTimeout.reason, 'fish_until: "attemptTimeoutMs" must be an integer');
  assert.ok(ADVISOR_SKILL_NAMES.includes('fish_until'));
});

test('skill schema validates fish_and_deposit mission wrapper targets', () => {
  const valid = validateSkillCall({
    skill: 'fish_and_deposit',
    params: {
      catches: 3,
      maxAttempts: 6,
      depositChest: { x: 248, y: 68, z: 428 },
      depositRod: true,
    },
  });
  const missingChest = validateSkillCall({
    skill: 'fish_and_deposit',
    params: { catches: 3 },
  });
  const missingTarget = validateSkillCall({
    skill: 'fish_and_deposit',
    params: { depositChest: { x: 248, y: 68, z: 428 } },
  });
  const bothTargets = validateSkillCall({
    skill: 'fish_and_deposit',
    params: { catches: 3, durationMs: 1000, depositChest: { x: 248, y: 68, z: 428 } },
  });
  const badChest = validateSkillCall({
    skill: 'fish_and_deposit',
    params: { catches: 3, depositChest: { x: 248, y: 68 } },
  });

  assert.deepEqual(valid, { ok: true });
  assert.equal(missingChest.ok, false);
  assert.equal(missingChest.reason, 'fish_and_deposit: missing required param "depositChest"');
  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.reason, 'fish_and_deposit: must provide one of {catches} OR {durationMs}');
  assert.equal(bothTargets.ok, false);
  assert.equal(bothTargets.reason, 'fish_and_deposit: must provide exactly one of {catches} OR {durationMs}');
  assert.equal(badChest.ok, false);
  assert.equal(badChest.reason, 'fish_and_deposit: "depositChest.z" is required');
  assert.ok(ADVISOR_SKILL_NAMES.includes('fish_and_deposit'));
});

test('skill schema validates coordinate object params', () => {
  const validFlee = validateSkillCall({
    skill: 'flee',
    params: { from: { x: 0, y: 64, z: 0 } },
  });
  const missingFleeAxis = validateSkillCall({
    skill: 'flee',
    params: { from: { x: 0, y: 64 } },
  });
  const badAnchorAxis = validateSkillCall({
    skill: 'build_from_schematic',
    params: { blocks: [], anchor: { x: 0, y: '64', z: 0 }, dryRun: true },
  });

  assert.deepEqual(validFlee, { ok: true });
  assert.equal(missingFleeAxis.ok, false);
  assert.equal(missingFleeAxis.reason, 'flee: "from.z" is required');
  assert.equal(badAnchorAxis.ok, false);
  assert.equal(badAnchorAxis.reason, 'build_from_schematic: "anchor.y" must be number');
});

test('skill schema validates recover_drops coordinates and wait controls', () => {
  const valid = validateSkillCall({
    skill: 'recover_drops',
    params: { x: 10, y: 64, z: -3, dimension: 'overworld', range: 0.4, waitMs: 6000, settleMs: 1500 },
  });
  const missing = validateSkillCall({
    skill: 'recover_drops',
    params: { x: 10, y: 64 },
  });
  const badAxis = validateSkillCall({
    skill: 'recover_drops',
    params: { x: 10, y: '64', z: -3 },
  });

  assert.deepEqual(valid, { ok: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'recover_drops: missing required param "z"');
  assert.equal(badAxis.ok, false);
  assert.equal(badAxis.reason, 'recover_drops: "y" must be number');
  const badSettle = validateSkillCall({
    skill: 'recover_drops',
    params: { x: 10, y: 64, z: -3, settleMs: -1 },
  });
  assert.equal(badSettle.ok, false);
  assert.equal(badSettle.reason, 'recover_drops: "settleMs" must be >= 0');
});

test('skill schema rejects non-object build block entries', () => {
  const result = validateSkillCall({
    skill: 'build_from_schematic',
    params: { blocks: ['oak_planks'], anchor: { x: 0, y: 64, z: 0 }, dryRun: true },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'build_from_schematic: "blocks[0]" must be object');
});

test('skill schema accepts supported schematic block coordinate forms', () => {
  const result = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      blocks: [
        { name: 'oak_planks', x: 0, y: 0, z: 0 },
        { block: 'glass', offset: { x: 1, y: 0, z: 0 } },
        { blockState: 'minecraft:torch[facing=north]', position: { x: 0, y: 1, z: 0 } },
        { block_state: 'minecraft:stone', x: 0, y: 0, z: 1 },
      ],
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: true,
    },
  });

  assert.deepEqual(result, { ok: true });
});

test('skill schema rejects malformed schematic block names and offsets', () => {
  const missingName = validateSkillCall({
    skill: 'build_from_schematic',
    params: { blocks: [{ x: 0, y: 0, z: 0 }], anchor: { x: 0, y: 64, z: 0 }, dryRun: true },
  });
  const badName = validateSkillCall({
    skill: 'build_from_schematic',
    params: { blocks: [{ name: 7, x: 0, y: 0, z: 0 }], anchor: { x: 0, y: 64, z: 0 }, dryRun: true },
  });
  const missingOffset = validateSkillCall({
    skill: 'build_from_schematic',
    params: { blocks: [{ name: 'oak_planks' }], anchor: { x: 0, y: 64, z: 0 }, dryRun: true },
  });
  const multipleOffsets = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      blocks: [{ name: 'oak_planks', offset: { x: 0, y: 0, z: 0 }, x: 0, y: 0, z: 0 }],
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: true,
    },
  });
  const badOffsetAxis = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      blocks: [{ name: 'oak_planks', offset: { x: 0, y: '0', z: 0 } }],
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: true,
    },
  });
  const unknown = validateSkillCall({
    skill: 'build_from_schematic',
    params: { blocks: [{ name: 'oak_planks', x: 0, y: 0, z: 0, meta: 1 }], anchor: { x: 0, y: 64, z: 0 }, dryRun: true },
  });

  assert.equal(missingName.reason, 'build_from_schematic: "blocks[0]" must include one of name|block|blockState|block_state');
  assert.equal(badName.reason, 'build_from_schematic: "blocks[0].name" must be string');
  assert.equal(missingOffset.reason, 'build_from_schematic: "blocks[0]" must include one of offset|position|{x,y,z}');
  assert.equal(multipleOffsets.reason, 'build_from_schematic: "blocks[0]" must include exactly one of offset|position|{x,y,z}');
  assert.equal(badOffsetAxis.reason, 'build_from_schematic: "blocks[0].offset.y" must be number');
  assert.equal(unknown.reason, 'build_from_schematic: "blocks[0]" unknown field "meta"');
});

test('skill schema validates inline schematic object blocks', () => {
  const valid = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      schematic: { blocks: [{ name: 'oak_planks', x: 0, y: 0, z: 0 }] },
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: true,
    },
  });
  const missingBlocks = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      schematic: { name: 'not-a-block-list' },
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: true,
    },
  });
  const badBlock = validateSkillCall({
    skill: 'build_from_schematic',
    params: {
      schematic: { blocks: [{ blockState: 'minecraft:glass', position: { x: 0, z: 0 } }] },
      anchor: { x: 0, y: 64, z: 0 },
      dryRun: true,
    },
  });

  assert.deepEqual(valid, { ok: true });
  assert.equal(missingBlocks.reason, 'build_from_schematic: "schematic.blocks" must be array');
  assert.equal(badBlock.reason, 'build_from_schematic: "schematic.blocks[0].position.y" is required');
});
