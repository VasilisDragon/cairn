import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_LIVE_SCENARIO_ID,
  LIVE_SCENARIOS,
  getLiveScenario,
  liveScenarioSummary,
  primaryLiveScenarioIds,
  runnableLiveScenarioIds,
} from '../../scripts/live-scenarios.js';
import {
  chestOpenAttemptPlan,
  chooseSafeChestQuickBarSlot,
  containerInventoryCounts,
  diffCounts,
  equipmentSummary,
  shouldDeferSupplyChestBlockCheck,
} from '../live_helpers.js';

test('live scenario manifest stays local deterministic and DeepSeek-free', () => {
  assert.equal(DEFAULT_LIVE_SCENARIO_ID, 'live_server_smoke');
  assert.ok(LIVE_SCENARIOS.length >= 8);
  const rconScenarioIds = new Set([
    'live_hostile_escalation_fixture',
    'live_pvm_escalation_decision_fixture',
  ]);

  for (const scenario of LIVE_SCENARIOS) {
    assert.match(scenario.id, /^[a-z0-9_]+$/);
    assert.match(scenario.entrypoint, /^\.\.\/test\/.+\.js$/);
    assert.deepEqual(scenario.account, {
      regime: 'test',
      label: 'Regime A private/LAN offline MCBot',
      username: 'MCBot',
      auth: 'offline',
    });
    assert.equal(scenario.requiresDeepSeek, false);
    assert.equal(scenario.requiresScriptedAdmin, rconScenarioIds.has(scenario.id));
    assert.equal(scenario.requiresRcon === true, rconScenarioIds.has(scenario.id));
    assert.ok(Array.isArray(scenario.expectedLogEvents));
    assert.ok(scenario.expectedLogEvents.length > 0);
    assert.ok(Array.isArray(scenario.successCriteria));
    assert.ok(scenario.successCriteria.length > 0);
  }

  assert.deepEqual(primaryLiveScenarioIds(), [
    'live_server_smoke',
    'live_supply_chest_inspect',
    'live_supply_chest_equip',
    'live_phase2_collect_deposit_fixture',
    'live_single_hostile_flee_fixture',
    'live_supply_chest_fishing_fixture',
    'live_mining_soak_fixture',
    'live_death_recovery_fixture',
    'live_single_hostile_engage_fixture',
    'live_hostile_escalation_fixture',
    'live_pvm_escalation_decision_fixture',
  ]);
  assert.deepEqual(runnableLiveScenarioIds(), LIVE_SCENARIOS.map((scenario) => scenario.id));
  assert.equal(getLiveScenario('live_supply_chest_inspect')?.fixture?.position?.x, 248);
  assert.equal(getLiveScenario('live_supply_chest_inspect')?.fixture?.protectedDoNotTouchOverride, true);
  assert.ok(getLiveScenario('live_supply_chest_equip')?.fixture?.forbiddenItemsUnlessExplicit?.includes('enchanted_golden_apple'));
  assert.equal(getLiveScenario('live_supply_chest_fishing_fixture')?.waterFixture?.position?.z, 413);
  assert.deepEqual(getLiveScenario('live_supply_chest_fishing_fixture')?.optionalEnv?.map((entry) => entry.name), [
    'MCBOT_LIVE_FISHING_DURATION_MS',
    'MCBOT_LIVE_FISHING_DURATION_ONLY',
    'MCBOT_LIVE_FISHING_MIN_CATCHES',
    'MCBOT_LIVE_FISHING_MAX_ITERATIONS',
    'MCBOT_LIVE_FISHING_ITEM_FLIGHT_WAIT_MS',
    'MCBOT_LIVE_FISHING_DRY_PICKUP_REACH',
    'MCBOT_LIVE_FISHING_DRY_INTERCEPT_REACH',
    'MCBOT_LIVE_FISHING_MAX_DRY_PICKUP_ATTEMPTS',
    'MCBOT_LIVE_FISHING_PREFERRED_STAND_DISTANCE',
    'MCBOT_LIVE_FISHING_LANDING_MOTION_MODE',
    'MCBOT_LIVE_FISHING_LANDING_SCORE_COMFORT',
    'MCBOT_LIVE_FISHING_LANDING_SCORE_MINIMUM',
    'MCBOT_LIVE_FISHING_REEL_INLAND_PULL_MS',
    'MCBOT_LIVE_FISHING_DRY_LANDING_NUDGE_MS',
    'MCBOT_LIVE_FISHING_WATER_PICKUP_FALLBACK',
    'MCBOT_LIVE_FISHING_RETURN_RESERVE_MS',
    'MCBOT_LIVE_FISHING_DEPOSIT_INTERVAL_MS',
    'MCBOT_LIVE_FISHING_RETURN_SAFETY_MULTIPLIER',
    'MCBOT_LIVE_FISHING_RETURN_OVERHEAD_MS',
  ]);
  assert.ok(getLiveScenario('live_supply_chest_fishing_fixture')?.expectedLogEvents?.includes('live_supply_chest_fishing_fixture.stand.navigate'));
  assert.ok(getLiveScenario('live_supply_chest_fishing_fixture')?.expectedLogEvents?.includes('live_supply_chest_fishing_fixture.return.plan'));
  assert.ok(getLiveScenario('live_supply_chest_fishing_fixture')?.expectedLogEvents?.includes('live_supply_chest_fishing_fixture.mission.result'));
  assert.ok(getLiveScenario('live_supply_chest_fishing_fixture')?.successCriteria?.some((item) => item.includes('three successful fishing')));
  assert.ok(getLiveScenario('live_supply_chest_fishing_fixture')?.successCriteria?.some((item) => item.includes('shared mission loop')));
  assert.deepEqual(getLiveScenario('live_mining_soak_fixture')?.requiredEnv?.map((gate) => gate.name), [
    'MCBOT_LIVE_MINING_FIXTURE_OK',
  ]);
  assert.deepEqual(getLiveScenario('live_mining_soak_fixture')?.optionalEnv?.map((entry) => entry.name), [
    'MCBOT_LIVE_MINING_DURATION_MS',
    'MCBOT_LIVE_MINING_RETURN_RESERVE_MS',
    'MCBOT_LIVE_MINING_DEPOSIT_INTERVAL_MS',
    'MCBOT_LIVE_MINING_REQUIRE_RETURN_RESERVE',
    'MCBOT_LIVE_MINING_MIN_WORK_MS',
    'MCBOT_LIVE_MINING_RETURN_SAFETY_MULTIPLIER',
    'MCBOT_LIVE_MINING_RETURN_OVERHEAD_MS',
  ]);
  assert.ok(getLiveScenario('live_mining_soak_fixture')?.expectedLogEvents?.includes('live_mining_soak_fixture.return.plan'));
  assert.deepEqual(getLiveScenario('live_phase2_collect_deposit_fixture')?.requiredEnv?.map((gate) => gate.name), [
    'MCBOT_LIVE_COLLECT_FIXTURE_OK',
  ]);
  assert.deepEqual(getLiveScenario('live_single_hostile_flee_fixture')?.requiredEnv?.map((gate) => gate.name), [
    'MCBOT_LIVE_HOSTILE_FIXTURE_OK',
  ]);
  assert.deepEqual(getLiveScenario('live_single_hostile_flee_fixture')?.optionalEnv?.map((entry) => entry.name), [
    'MCBOT_LIVE_HOSTILE_WAIT_MS',
    'MCBOT_LIVE_HOSTILE_WAIT_POLL_MS',
    'MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN',
    'MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN_ACTION',
    'MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_MODE',
    'MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DX',
    'MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DY',
    'MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DZ',
    'MCBOT_LIVE_HOSTILE_MONITOR_MS',
    'MCBOT_LIVE_HOSTILE_MAX_STATE_CHANGES',
    'MCBOT_LIVE_HOSTILE_MAX_WATER_ESCAPE_ENTRIES',
  ]);
  assert.equal(getLiveScenario('live_single_hostile_flee_fixture')?.adminSetup?.defaultAction, 'clear-non-players');
  assert.ok(getLiveScenario('live_single_hostile_flee_fixture')?.adminSetup?.allowedActions?.includes('fixture-single-zombie'));
  assert.deepEqual(getLiveScenario('live_single_hostile_flee_fixture')?.adminSetup?.args?.map((entry) => entry.env), [
    'MCBOT_LIVE_HOSTILE_SPAWN_X',
    'MCBOT_LIVE_HOSTILE_SPAWN_Y',
    'MCBOT_LIVE_HOSTILE_SPAWN_Z',
  ]);
  assert.ok(getLiveScenario('live_single_hostile_flee_fixture')?.expectedLogEvents?.includes('live_single_hostile_flee_fixture.fixture-ready'));
  assert.ok(getLiveScenario('live_single_hostile_flee_fixture')?.requiresPriorScenarios?.includes('live_phase2_collect_deposit_fixture'));
  assert.equal(getLiveScenario('live_supply_chest_fishing_fixture')?.adminSetup, undefined);
  assert.deepEqual(getLiveScenario('live_death_recovery_fixture')?.requiredEnv?.map((gate) => gate.name), [
    'MCBOT_LIVE_DEATH_RECOVERY_FIXTURE_OK',
  ]);
  assert.deepEqual(getLiveScenario('live_death_recovery_fixture')?.optionalEnv?.map((entry) => entry.name), [
    'MCBOT_LIVE_DEATH_RECOVERY_ADMIN',
    'MCBOT_LIVE_DEATH_RECOVERY_ADMIN_DAMAGE',
    'MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_ITEM',
    'MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_COUNT',
  ]);
  assert.equal(getLiveScenario('live_death_recovery_fixture')?.manualStateSetup, true);
  assert.ok(getLiveScenario('live_death_recovery_fixture')?.expectedLogEvents?.includes('live_death_recovery_fixture.admin-death.result'));
  assert.ok(getLiveScenario('live_death_recovery_fixture')?.successCriteria?.some((item) => item.includes('recover_drops')));
  assert.deepEqual(getLiveScenario('live_single_hostile_engage_fixture')?.requiredEnv?.map((gate) => gate.name), [
    'MCBOT_LIVE_PVM_ENGAGE_FIXTURE_OK',
  ]);
  assert.deepEqual(getLiveScenario('live_single_hostile_engage_fixture')?.optionalEnv?.map((entry) => entry.name), [
    'MCBOT_LIVE_PVM_ENGAGE_WAIT_MS',
    'MCBOT_LIVE_PVM_ENGAGE_WAIT_POLL_MS',
    'MCBOT_LIVE_PVM_ENGAGE_MONITOR_MS',
    'MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN',
    'MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN_ACTION',
    'MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_MODE',
    'MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DX',
    'MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DY',
    'MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DZ',
  ]);
  assert.equal(getLiveScenario('live_single_hostile_engage_fixture')?.adminSetup?.defaultAction, 'clear-non-players');
  assert.ok(getLiveScenario('live_single_hostile_engage_fixture')?.adminSetup?.allowedActions?.includes('fixture-single-zombie-fire-resistant'));
  assert.equal(getLiveScenario('live_single_hostile_engage_fixture')?.manualStateSetup, true);
  assert.ok(getLiveScenario('live_single_hostile_engage_fixture')?.successCriteria?.some((item) => item.includes('ENGAGING')));
  assert.equal(getLiveScenario('live_hostile_escalation_fixture')?.requiresScriptedAdmin, true);
  assert.equal(getLiveScenario('live_hostile_escalation_fixture')?.requiresRcon, true);
  assert.deepEqual(getLiveScenario('live_hostile_escalation_fixture')?.requiredEnv?.map((gate) => gate.name), [
    'MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK',
  ]);
  assert.deepEqual(getLiveScenario('live_hostile_escalation_fixture')?.optionalEnv?.map((entry) => entry.name), [
    'MCBOT_LIVE_HOSTILE_ESCALATION_BETWEEN_WAVE_TIMEOUT_MS',
    'MCBOT_LIVE_HOSTILE_ESCALATION_FINAL_ESCAPE_TIMEOUT_MS',
    'MCBOT_LIVE_HOSTILE_ESCALATION_POST_WAVE_SETTLE_MS',
    'MCBOT_LIVE_HOSTILE_ESCALATION_MAX_STATE_CHANGES',
    'MCBOT_LIVE_HOSTILE_ESCALATION_MAX_WATER_ESCAPE_ENTRIES',
  ]);
  assert.deepEqual(getLiveScenario('live_hostile_escalation_fixture')?.adminSetup?.allowedActions, ['clear-non-players']);
  assert.ok(getLiveScenario('live_hostile_escalation_fixture')?.expectedLogEvents?.includes('live_hostile_escalation_fixture.admin.wave'));
  assert.ok(getLiveScenario('live_hostile_escalation_fixture')?.successCriteria?.some((item) => item.includes('one, three, and four')));
  assert.equal(getLiveScenario('live_pvm_escalation_decision_fixture')?.requiresScriptedAdmin, true);
  assert.equal(getLiveScenario('live_pvm_escalation_decision_fixture')?.requiresRcon, true);
  assert.deepEqual(getLiveScenario('live_pvm_escalation_decision_fixture')?.requiredEnv?.map((gate) => gate.name), [
    'MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK',
  ]);
  assert.deepEqual(getLiveScenario('live_pvm_escalation_decision_fixture')?.optionalEnv?.map((entry) => entry.name), [
    'MCBOT_LIVE_PVM_ESCALATION_ENGAGE_TIMEOUT_MS',
    'MCBOT_LIVE_PVM_ESCALATION_FLEE_TIMEOUT_MS',
    'MCBOT_LIVE_PVM_ESCALATION_FINAL_ESCAPE_TIMEOUT_MS',
    'MCBOT_LIVE_PVM_ESCALATION_POST_ENGAGE_SETTLE_MS',
    'MCBOT_LIVE_PVM_ESCALATION_MAX_STATE_CHANGES',
    'MCBOT_LIVE_PVM_ESCALATION_MAX_WATER_ESCAPE_ENTRIES',
  ]);
  assert.equal(getLiveScenario('live_pvm_escalation_decision_fixture')?.adminSetup?.defaultAction, 'clear-non-players');
  assert.ok(getLiveScenario('live_pvm_escalation_decision_fixture')?.expectedLogEvents?.includes('live_pvm_escalation_decision_fixture.escalation-flee-check'));
  assert.ok(getLiveScenario('live_pvm_escalation_decision_fixture')?.successCriteria?.some((item) => item.includes('too-many-hostiles')));
  assert.equal(getLiveScenario('fall_eat_manual')?.entrypoint, '../test/live_fall_eat_diagnostic.js');
  assert.match(liveScenarioSummary(), /live_server_smoke/);
  assert.match(liveScenarioSummary(), /live_supply_chest_inspect/);
  assert.match(liveScenarioSummary(), /fall_eat_manual/);
});

test('live wrapper skips without explicit live-test opt in', () => {
  const env = { ...process.env };
  delete env.MCBOT_LIVE_TESTS;
  delete env.MCBOT_LIVE_SCENARIO;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /test:live skipped/);
  assert.match(result.stdout, /live_server_smoke/);
  assert.match(result.stdout, /live_supply_chest_inspect/);
  assert.match(result.stdout, /live_supply_chest_fishing_fixture/);
  assert.match(result.stdout, /live_mining_soak_fixture/);
  assert.match(result.stdout, /live_death_recovery_fixture/);
  assert.match(result.stdout, /live_single_hostile_engage_fixture/);
  assert.match(result.stdout, /live_hostile_escalation_fixture/);
  assert.match(result.stdout, /live_pvm_escalation_decision_fixture/);
  assert.match(result.stdout, /phase2_collect_deposit/);
  assert.match(result.stdout, /fall_eat_manual/);
  assert.equal(result.stderr, '');
});

test('live wrapper rejects unknown scenarios before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'missing_scenario',
  };

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown live scenario "missing_scenario"/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects Regime B config for Regime A private fixtures', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_server_smoke',
    MCBOT_ACCOUNT_REGIME: 'production',
    MC_USERNAME: 'user@example.com',
  };

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Regime A private\/LAN offline MCBot/);
  assert.match(result.stderr, /MCBOT_ACCOUNT_REGIME=production/);
  assert.equal(result.stdout, '');
});

test('supply chest block check defers only for far unknown blocks', () => {
  assert.equal(shouldDeferSupplyChestBlockCheck({ chest: null, above: null }, 40.52), true);
  assert.equal(shouldDeferSupplyChestBlockCheck({ chest: null, above: null }, 1.76), false);
  assert.equal(shouldDeferSupplyChestBlockCheck({ chest: 'oak_log', above: 'air' }, 40.52), false);
  assert.equal(shouldDeferSupplyChestBlockCheck({ chest: null, above: null, error: 'world query failed' }, 40.52), false);
});

test('live wrapper rejects gated collect fixture scenario before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_phase2_collect_deposit_fixture',
  };
  delete env.MCBOT_LIVE_COLLECT_FIXTURE_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_COLLECT_FIXTURE_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects gated mining fixture scenario before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_mining_soak_fixture',
  };
  delete env.MCBOT_LIVE_MINING_FIXTURE_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_MINING_FIXTURE_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects gated hostile fixture scenario before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_single_hostile_flee_fixture',
  };
  delete env.MCBOT_LIVE_HOSTILE_FIXTURE_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_HOSTILE_FIXTURE_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper can dry-run admin setup only for hostile fixture before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_single_hostile_flee_fixture',
    MCBOT_LIVE_HOSTILE_FIXTURE_OK: '1',
    MCBOT_LIVE_ADMIN_SETUP: '1',
    MCBOT_LIVE_ADMIN_SETUP_ONLY: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_DRY_RUN: '1',
    MCBOT_LIVE_HOSTILE_ADMIN_ACTION: 'fixture-single-zombie',
    MCBOT_LIVE_HOSTILE_SPAWN_X: '240',
    MCBOT_LIVE_HOSTILE_SPAWN_Y: '64',
    MCBOT_LIVE_HOSTILE_SPAWN_Z: '420',
  };

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /test:live running live_single_hostile_flee_fixture/);
  assert.match(result.stdout, /live admin setup:/);
  assert.match(result.stdout, /minecraft:kill @e\[type=!player\]/);
  assert.match(result.stdout, /summon minecraft:zombie 240 64 420/);
  assert.equal(result.stderr, '');
});

test('live wrapper defaults hostile flee admin setup to clear-only before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_single_hostile_flee_fixture',
    MCBOT_LIVE_HOSTILE_FIXTURE_OK: '1',
    MCBOT_LIVE_ADMIN_SETUP: '1',
    MCBOT_LIVE_ADMIN_SETUP_ONLY: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_DRY_RUN: '1',
  };

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /test:live running live_single_hostile_flee_fixture/);
  assert.match(result.stdout, /live admin setup:/);
  assert.match(result.stdout, /minecraft:kill @e\[type=!player\]/);
  assert.doesNotMatch(result.stdout, /summon minecraft:zombie/);
  assert.equal(result.stderr, '');
});

test('live wrapper rejects gated death recovery fixture scenario before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_death_recovery_fixture',
  };
  delete env.MCBOT_LIVE_DEATH_RECOVERY_FIXTURE_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_DEATH_RECOVERY_FIXTURE_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects gated PvM engage fixture scenario before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_single_hostile_engage_fixture',
  };
  delete env.MCBOT_LIVE_PVM_ENGAGE_FIXTURE_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_PVM_ENGAGE_FIXTURE_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper defaults PvM engage admin setup to clear-only before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_single_hostile_engage_fixture',
    MCBOT_LIVE_PVM_ENGAGE_FIXTURE_OK: '1',
    MCBOT_LIVE_ADMIN_SETUP: '1',
    MCBOT_LIVE_ADMIN_SETUP_ONLY: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_DRY_RUN: '1',
  };

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /test:live running live_single_hostile_engage_fixture/);
  assert.match(result.stdout, /live admin setup:/);
  assert.match(result.stdout, /minecraft:kill @e\[type=!player\]/);
  assert.doesNotMatch(result.stdout, /summon minecraft:zombie/);
  assert.equal(result.stderr, '');
});

test('live wrapper rejects hostile escalation without admin opt-in before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_hostile_escalation_fixture',
    MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK: '1',
  };
  delete env.MCBOT_LIVE_ADMIN_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_ADMIN_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects gated hostile escalation scenario before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_hostile_escalation_fixture',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_DRY_RUN: '1',
  };
  delete env.MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects hostile escalation without rcon password before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_hostile_escalation_fixture',
    MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
  };
  delete env.MCBOT_LIVE_ADMIN_DRY_RUN;
  delete env.MCBOT_RCON_PASSWORD;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_RCON_PASSWORD/);
  assert.equal(result.stdout, '');
});

test('live wrapper defaults hostile escalation admin setup to clear-only before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_hostile_escalation_fixture',
    MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK: '1',
    MCBOT_LIVE_ADMIN_SETUP: '1',
    MCBOT_LIVE_ADMIN_SETUP_ONLY: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_DRY_RUN: '1',
  };

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /test:live running live_hostile_escalation_fixture/);
  assert.match(result.stdout, /live admin setup:/);
  assert.match(result.stdout, /minecraft:kill @e\[type=!player\]/);
  assert.doesNotMatch(result.stdout, /summon minecraft:zombie/);
  assert.equal(result.stderr, '');
});

test('live wrapper rejects PvM escalation without admin opt-in before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_pvm_escalation_decision_fixture',
    MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK: '1',
  };
  delete env.MCBOT_LIVE_ADMIN_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_ADMIN_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects gated PvM escalation scenario before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_pvm_escalation_decision_fixture',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_DRY_RUN: '1',
  };
  delete env.MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK=1/);
  assert.equal(result.stdout, '');
});

test('live wrapper rejects PvM escalation without rcon password before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_pvm_escalation_decision_fixture',
    MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
  };
  delete env.MCBOT_LIVE_ADMIN_DRY_RUN;
  delete env.MCBOT_RCON_PASSWORD;

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_RCON_PASSWORD/);
  assert.equal(result.stdout, '');
});

test('live wrapper defaults PvM escalation admin setup to clear-only before importing live code', () => {
  const env = {
    ...process.env,
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_SCENARIO: 'live_pvm_escalation_decision_fixture',
    MCBOT_LIVE_PVM_ESCALATION_FIXTURE_OK: '1',
    MCBOT_LIVE_ADMIN_SETUP: '1',
    MCBOT_LIVE_ADMIN_SETUP_ONLY: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_DRY_RUN: '1',
  };

  const result = spawnSync(process.execPath, ['scripts/live-suite.js'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /test:live running live_pvm_escalation_decision_fixture/);
  assert.match(result.stdout, /live admin setup:/);
  assert.match(result.stdout, /minecraft:kill @e\[type=!player\]/);
  assert.doesNotMatch(result.stdout, /summon minecraft:zombie/);
  assert.equal(result.stderr, '');
});

test('authorized chest open plan tries the nearest visible side before fallbacks', () => {
  const plan = chestOpenAttemptPlan(
    { x: 248.5, y: 68, z: 429.7 },
    { x: 248, y: 68, z: 428 },
  );

  assert.equal(plan[0].name, 'south-side');
  assert.deepEqual(plan[0].direction, { x: 0, y: 0, z: 1 });
  assert.equal(plan[1].name, 'top');
  assert.equal(new Set(plan.map((attempt) => attempt.name)).size, plan.length);
  assert.ok(plan.some((attempt) => attempt.name === 'north-side'));
  assert.ok(plan.some((attempt) => attempt.name === 'west-side'));
  assert.ok(plan.some((attempt) => attempt.name === 'east-side'));
});

test('authorized chest hand selection falls back to non-placeable hotbar items', () => {
  const bot = {
    QUICK_BAR_START: 36,
    registry: { blocksByName: { dirt: {}, cobblestone: {} } },
    inventory: {
      slots: Array.from({ length: 45 }, () => ({ name: 'dirt', count: 1 })),
    },
  };
  bot.inventory.slots[40] = { name: 'netherite_axe', count: 1 };

  assert.deepEqual(chooseSafeChestQuickBarSlot(bot), { slot: 4, reason: 'non-placeable' });
  bot.inventory.slots[37] = null;
  assert.deepEqual(chooseSafeChestQuickBarSlot(bot), { slot: 1, reason: 'empty' });
});

test('live transfer deltas read the open container inventory window', () => {
  const before = {
    inventoryStart: 3,
    inventoryEnd: 6,
    slots: [
      { name: 'oak_log', count: 64 },
      null,
      null,
      { name: 'cooked_beef', count: 4 },
      null,
      { name: 'netherite_pickaxe', count: 1 },
      { name: 'stone', count: 64 },
    ],
  };
  const after = {
    ...before,
    slots: [
      { name: 'oak_log', count: 64 },
      null,
      null,
      { name: 'cooked_beef', count: 8 },
      null,
      { name: 'netherite_pickaxe', count: 1 },
      { name: 'stone', count: 64 },
    ],
  };

  assert.deepEqual(containerInventoryCounts(before), { cooked_beef: 4, netherite_pickaxe: 1 });
  assert.deepEqual(containerInventoryCounts(after), { cooked_beef: 8, netherite_pickaxe: 1 });
  assert.deepEqual(diffCounts(containerInventoryCounts(before), containerInventoryCounts(after)), { cooked_beef: 4 });
});

test('equipmentSummary maps Mineflayer armor slots to human-readable equipment', () => {
  const item = (name) => ({ name, count: 1 });
  const bot = {
    heldItem: item('netherite_pickaxe'),
    entity: {
      equipment: [
        item('air_hand'),
        item('shield'),
        item('netherite_boots'),
        item('netherite_leggings'),
        item('netherite_chestplate'),
        item('netherite_helmet'),
      ],
    },
  };

  assert.deepEqual(equipmentSummary(bot), {
    hand: { name: 'netherite_pickaxe', count: 1 },
    offHand: { name: 'shield', count: 1 },
    feet: { name: 'netherite_boots', count: 1 },
    legs: { name: 'netherite_leggings', count: 1 },
    torso: { name: 'netherite_chestplate', count: 1 },
    head: { name: 'netherite_helmet', count: 1 },
  });
});
