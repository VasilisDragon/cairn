import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseArgs,
  parseJsonl,
  parseStartResponse,
  parseStructuredChildLogs,
  runPluginBackedScenario,
  summarizeChildLogs,
  summarizeTelemetry,
  validateChildLogsForScenario,
  validateRunnerEnv,
  validateScenarioEvidence,
  validateTelemetryForScenario,
} from '../../scripts/run-live-scenario.js';

test('plugin-backed live scenario args and env fail closed before live work', () => {
  const opts = parseArgs(['--scenario', 'live_hostile_escalation_fixture', '--timeout-ms', '12345']);
  assert.equal(opts.scenario, 'live_hostile_escalation_fixture');
  assert.equal(opts.timeoutMs, 12345);

  assert.match(validateRunnerEnv({}, opts), /MCBOT_LIVE_TESTS=1/);
  assert.match(validateRunnerEnv({ MCBOT_LIVE_TESTS: '1' }, opts), /MCBOT_LIVE_ADMIN_OK=1/);
  assert.match(validateRunnerEnv({ MCBOT_LIVE_TESTS: '1', MCBOT_LIVE_ADMIN_OK: '1' }, opts), /MCBOT_RCON_PASSWORD/);
  assert.equal(validateRunnerEnv({
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_RCON_PASSWORD: 'secret',
  }, opts), null);
});

test('plugin-backed live scenario parses start response and telemetry summaries', () => {
  const start = parseStartResponse('MCBOTTEST started token=live_hostile_escalation_fixture-1 telemetry=D:\\Minecraft\\Server\\mcbottest\\x.jsonl');
  assert.equal(start.token, 'live_hostile_escalation_fixture-1');
  assert.equal(start.telemetryPath, 'D:\\Minecraft\\Server\\mcbottest\\x.jsonl');

  const startWithCrLf = parseStartResponse('MCBOTTEST started token=live_hostile_escalation_fixture-2 telemetry=D:\\Minecraft\\Server\\.\\mcbottest\\x.jsonl\r\n');
  assert.equal(startWithCrLf.token, 'live_hostile_escalation_fixture-2');
  assert.equal(startWithCrLf.telemetryPath, 'D:\\Minecraft\\Server\\.\\mcbottest\\x.jsonl');

  const events = parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"tagged_hostile_spawn","tag":"j1"}',
    '{"event":"bot_move","nearestTaggedHostileDistance":6}',
    '{"event":"tagged_hostile_despawn","tag":"j1"}',
  ].join('\n'));
  const summary = summarizeTelemetry(events);
  assert.equal(summary.taggedHostileSpawnCount, 1);
  assert.equal(summary.taggedHostileTerminalCount, 1);
  assert.equal(summary.botMoveCount, 1);
  assert.equal(summary.blockBreakCount, 0);
  assert.deepEqual(summary.itemPickupCounts, {});
  assert.deepEqual(validateTelemetryForScenario('live_hostile_escalation_fixture', summary), {
    ok: true,
    failures: [],
  });
});

test('plugin-backed hostile scenario validation requires server-side hostile evidence', () => {
  const summary = summarizeTelemetry(parseJsonl('{"event":"scenario_start"}\n'));
  const validation = validateTelemetryForScenario('live_hostile_escalation_fixture', summary);
  assert.equal(validation.ok, false);
  assert.ok(validation.failures.some((failure) => /tagged hostile spawn/.test(failure)));
});

test('plugin-backed mining validation requires server-side block breaking', () => {
  const empty = summarizeTelemetry(parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"bot_move"}',
  ].join('\n')));
  const failed = validateTelemetryForScenario('live_mining_soak_fixture', empty);
  assert.equal(failed.ok, false);
  assert.ok(failed.failures.some((failure) => /block_break/.test(failure)));

  const mined = summarizeTelemetry(parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"bot_move"}',
    '{"event":"block_break","block":"minecraft:coal_ore"}',
  ].join('\n')));
  assert.deepEqual(validateTelemetryForScenario('live_mining_soak_fixture', mined), {
    ok: true,
    failures: [],
  });
});

test('plugin-backed fishing validation requires movement and three pickup events', () => {
  const missing = summarizeTelemetry(parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"bot_move"}',
    '{"event":"item_pickup","item":"minecraft:cod","count":1}',
    '{"event":"item_pickup","item":"minecraft:salmon","count":1}',
  ].join('\n')));
  const failed = validateTelemetryForScenario('live_supply_chest_fishing_fixture', missing);
  assert.equal(failed.ok, false);
  assert.ok(failed.failures.some((failure) => /three server-side item_pickup/.test(failure)));
  assert.deepEqual(missing.itemPickupCounts, {
    'minecraft:cod': 1,
    'minecraft:salmon': 1,
  });

  const caught = summarizeTelemetry(parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"bot_move"}',
    '{"event":"item_pickup","item":"minecraft:cod","count":1}',
    '{"event":"item_pickup","item":"minecraft:salmon","count":1}',
    '{"event":"item_pickup","item":"minecraft:pufferfish","count":1}',
  ].join('\n')));
  assert.deepEqual(validateTelemetryForScenario('live_supply_chest_fishing_fixture', caught), {
    ok: true,
    failures: [],
  });
});

test('plugin-backed death recovery validation requires death respawn and pickup telemetry', () => {
  const missing = summarizeTelemetry(parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"bot_damage"}',
  ].join('\n')));
  const failed = validateTelemetryForScenario('live_death_recovery_fixture', missing);
  assert.equal(failed.ok, false);
  assert.ok(failed.failures.some((failure) => /bot_death/.test(failure)));
  assert.ok(failed.failures.some((failure) => /bot_respawn/.test(failure)));
  assert.ok(failed.failures.some((failure) => /item_pickup/.test(failure)));

  const recovered = summarizeTelemetry(parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"bot_death","damageCause":"FALL"}',
    '{"event":"bot_respawn"}',
    '{"event":"item_pickup","item":"minecraft:dirt","count":1}',
  ].join('\n')));
  assert.deepEqual(validateTelemetryForScenario('live_death_recovery_fixture', recovered), {
    ok: true,
    failures: [],
  });
});

test('plugin-backed runner extracts structured child mission logs for duration soaks', () => {
  const records = parseStructuredChildLogs([
    'plain status line',
    '{"t":"2026-05-24T00:00:00.000Z","lvl":"info","loop":"test","evt":"live_supply_chest_fishing_fixture.mission.result","loopResult":{"ok":true}}',
    '{"t":"2026-05-24T00:00:01.000Z","lvl":"info","loop":"test","evt":"live_supply_chest_fishing_fixture.done","durationOnly":true,"minCatches":2,"catches":3,"loopResult":{"ok":true,"reason":"return-reserve-reached"},"taskBudget":{"overdue":false}}',
    '{not-json',
  ].join('\n'));
  const childSummary = summarizeChildLogs(records);
  assert.equal(childSummary.eventCounts['live_supply_chest_fishing_fixture.done'], 1);
  assert.deepEqual(validateChildLogsForScenario('live_supply_chest_fishing_fixture', childSummary), {
    ok: true,
    failures: [],
  });

  const telemetrySummary = summarizeTelemetry(parseJsonl([
    '{"event":"scenario_start"}',
    '{"event":"bot_move"}',
    '{"event":"item_pickup","item":"minecraft:cod","count":1}',
    '{"event":"item_pickup","item":"minecraft:salmon","count":1}',
    '{"event":"item_pickup","item":"minecraft:pufferfish","count":1}',
  ].join('\n')));
  assert.deepEqual(validateScenarioEvidence('live_supply_chest_fishing_fixture', telemetrySummary, childSummary), {
    ok: true,
    failures: [],
    telemetry: { ok: true, failures: [] },
    childLogs: { ok: true, failures: [] },
  });
});

test('plugin-backed runner rejects weak long-horizon child evidence', () => {
  const missingReturnDue = summarizeChildLogs(parseStructuredChildLogs([
    '{"evt":"live_supply_chest_fishing_fixture.mission.result"}',
    '{"evt":"live_supply_chest_fishing_fixture.done","durationOnly":true,"minCatches":3,"catches":2,"loopResult":{"reason":"target catches reached"},"taskBudget":{"overdue":false}}',
  ].join('\n')));
  const fishing = validateChildLogsForScenario('live_supply_chest_fishing_fixture', missingReturnDue);
  assert.equal(fishing.ok, false);
  assert.ok(fishing.failures.some((failure) => /catches >= 3/.test(failure)));
  assert.ok(fishing.failures.some((failure) => /return-plan-due or return-reserve-reached/.test(failure)));

  const weakMining = summarizeChildLogs(parseStructuredChildLogs(
    '{"evt":"live_mining_soak_fixture.done","returnedBeforeDeadline":true,"taskBudget":{"overdue":false},"minedDelta":{},"depositTargets":{}}\n',
  ));
  const mining = validateChildLogsForScenario('live_mining_soak_fixture', weakMining);
  assert.equal(mining.ok, false);
  assert.ok(mining.failures.some((failure) => /mined target deltas/.test(failure)));
  assert.ok(mining.failures.some((failure) => /deposited target deltas/.test(failure)));

  const earlyMining = summarizeChildLogs(parseStructuredChildLogs(
    '{"evt":"live_mining_soak_fixture.done","returnedBeforeDeadline":true,"requireReturnReserve":true,"minWorkMs":120000,"durationMs":60000,"loopResult":{"reason":"no-visible-targets"},"taskBudget":{"overdue":false},"minedDelta":{"diamond":1},"depositTargets":{"diamond":1}}\n',
  ));
  const strictMining = validateChildLogsForScenario('live_mining_soak_fixture', earlyMining);
  assert.equal(strictMining.ok, false);
  assert.ok(strictMining.failures.some((failure) => /return-reserve-reached/.test(failure)));
  assert.ok(strictMining.failures.some((failure) => /duration >= 120000/.test(failure)));
});

test('plugin-backed runner passes scenario token and telemetry path to child fixture', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-plugin-runner-'));
  const telemetryPath = path.join(tmp, 'scenario.jsonl');
  const reportPath = path.join(tmp, 'report.json');
  const calls = [];
  const report = await runPluginBackedScenario({
    scenario: 'live_hostile_escalation_fixture',
    reportPath,
    timeoutMs: 1000,
    extraEnv: { EXTRA_GATE: '1' },
  }, {
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_RCON_PASSWORD: 'secret',
  }, async (config) => {
    calls.push(config.commands);
    const command = config.commands[0];
    if (command.startsWith('mcbottest start ')) {
      return [{
        command,
        response: `MCBOTTEST started token=j-token telemetry=${telemetryPath}`,
        type: 0,
      }];
    }
    return [{ command, response: 'MCBOTTEST ended token=j-token', type: 0 }];
  }, async ({ env }) => {
    assert.equal(env.MCBOT_PLUGIN_BACKED, '1');
    assert.equal(env.MCBOT_PLUGIN_SCENARIO_TOKEN, 'j-token');
    assert.equal(env.MCBOT_PLUGIN_SCENARIO_ID, 'live_hostile_escalation_fixture');
    assert.equal(env.MCBOT_PLUGIN_TELEMETRY_PATH, telemetryPath);
    assert.equal(env.EXTRA_GATE, '1');
    fs.writeFileSync(telemetryPath, [
      '{"event":"scenario_start"}',
      '{"event":"tagged_hostile_spawn","tag":"j_1_single-near-1"}',
      '{"event":"bot_move","nearestTaggedHostileDistance":4}',
      '{"event":"tagged_hostile_despawn","tag":"j_1_single-near-1"}',
    ].join('\n'));
    return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '' };
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [
    ['mcbottest start live_hostile_escalation_fixture'],
    ['mcbottest end j-token'],
  ]);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).ok, true);
});
