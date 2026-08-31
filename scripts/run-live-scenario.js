#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { rconConfigFromEnv, sendRconCommands } from './live-admin-commands.js';
import { acquireOrJoinResourceLockSync, applyLowImpactNodeScheduling } from './resource-lock.js';
import { assertNoUncontrolledLocalMinecraftServerSync } from './local-minecraft-server-policy.js';
import {
  beginLiveEvidence,
  markLiveEvidenceIncomplete,
  writeLiveEvidenceJson,
} from './live-evidence-v2.js';
import { assertLowImpactNodeRuntime } from '../src/runtime/live_client_admission.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'reports', 'plugin-live-scenario.json');

export function parseArgs(argv = []) {
  const opts = {
    scenario: process.env.MCBOT_LIVE_SCENARIO || '',
    reportPath: DEFAULT_REPORT_PATH,
    timeoutMs: envInteger(process.env.MCBOT_PLUGIN_SCENARIO_TIMEOUT_MS, 300000),
    extraEnv: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scenario') {
      opts.scenario = argv[++index] || '';
    } else if (arg === '--report') {
      opts.reportPath = path.resolve(argv[++index] || DEFAULT_REPORT_PATH);
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = positiveInteger(argv[++index], 'timeout-ms');
    } else if (arg === '--env') {
      const [key, ...rest] = String(argv[++index] || '').split('=');
      if (!key || rest.length === 0) throw new Error('--env requires KEY=VALUE');
      opts.extraEnv[key] = rest.join('=');
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function validateRunnerEnv(env = process.env, opts = {}) {
  if (!opts.scenario) return 'missing --scenario or MCBOT_LIVE_SCENARIO';
  if (env.MCBOT_LIVE_TESTS !== '1') return 'refusing plugin-backed live scenario without MCBOT_LIVE_TESTS=1';
  if (env.MCBOT_LIVE_ADMIN_OK !== '1') return 'refusing plugin-backed live scenario without MCBOT_LIVE_ADMIN_OK=1';
  if (!env.MCBOT_RCON_PASSWORD) return 'refusing plugin-backed live scenario without MCBOT_RCON_PASSWORD';
  return null;
}

export async function runPluginBackedScenario(opts, env = process.env, transport = sendRconCommands, childRunner = runChildProcess) {
  const startedAt = new Date().toISOString();
  const report = {
    ok: false,
    status: 'plugin_live_scenario_running',
    scenario: opts.scenario,
    startedAt,
    finishedAt: null,
  };
  beginLiveEvidence(report, {
    repositoryRoot: ROOT,
    entrypointPath: fileURLToPath(import.meta.url),
    effectiveConfig: { options: opts },
    env,
  });
  let rcon = null;
  let startResult = null;
  let startAttempted = false;
  let token = null;
  let telemetryPath = null;
  let child = null;
  let endResult = null;
  let endError = null;
  let endAttempted = false;
  let runError = null;

  try {
    const envReason = validateRunnerEnv(env, opts);
    if (envReason) throw new Error(envReason);
    rcon = rconConfigFromEnv(env);
    startAttempted = true;
    startResult = await runHarnessCommand(rcon, [`mcbottest start ${opts.scenario}`], transport);
    const parsedStart = parseStartResponse(startResult.responses?.[0]?.response || '');
    token = parsedStart.token;
    telemetryPath = parsedStart.telemetryPath;
    if (!token || !telemetryPath) {
      throw new Error(`failed to parse /mcbottest start response: ${startResult.responses?.[0]?.response || ''}`);
    }

    child = await childRunner({
      cwd: ROOT,
      timeoutMs: opts.timeoutMs,
      env: {
        ...env,
        ...opts.extraEnv,
        UV_THREADPOOL_SIZE: '2',
        MCBOT_PLUGIN_BACKED: '1',
        MCBOT_PLUGIN_SCENARIO_TOKEN: token,
        MCBOT_PLUGIN_SCENARIO_ID: opts.scenario,
        MCBOT_PLUGIN_TELEMETRY_PATH: telemetryPath,
        MCBOT_LIVE_SCENARIO: opts.scenario,
      },
    });
  } catch (err) {
    runError = err;
  } finally {
    if (token) {
      try {
        endAttempted = true;
        endResult = await runHarnessCommand(rcon, [`mcbottest end ${token}`], transport);
      } catch (err) {
        endError = err?.message || String(err);
      }
    }
  }

  const fixtureCommands = [
    ...(startAttempted ? [`mcbottest start ${opts.scenario}`] : []),
    ...(endAttempted ? [`mcbottest end ${token}`] : []),
  ];
  const fixtureReceipts = [
    ...(startResult ? [{ command: `mcbottest start ${opts.scenario}`, status: 'applied', result: 'completed', resultCode: 1 }] : []),
    ...(token && endResult && !endError
      ? [{ command: `mcbottest end ${token}`, status: 'applied', result: 'completed', resultCode: 1 }]
      : []),
  ];
  if (runError) {
    Object.assign(report, {
      status: 'plugin_live_scenario_incomplete',
      finishedAt: new Date().toISOString(),
      token,
      telemetryPath,
      child: child || null,
      endResult,
      endError,
      failure: runError?.message || String(runError),
    });
    markLiveEvidenceIncomplete(report, 'wrapper_fatal_error');
    writeLiveEvidenceJson(opts.reportPath, report, {
      entrypointPath: fileURLToPath(import.meta.url),
      fixtureCommands,
      fixtureReceipts,
    });
    throw runError;
  }

  let telemetry = [];
  let telemetryReadError = null;
  if (telemetryPath) {
    try {
      telemetry = readTelemetry(telemetryPath);
    } catch (err) {
      telemetryReadError = err?.message || String(err);
      markLiveEvidenceIncomplete(report, 'client_evidence_trace_read_error');
    }
  }
  const summary = summarizeTelemetry(telemetry);
  const childLogSummary = summarizeChildLogs(parseStructuredChildLogs(`${child?.stdout || ''}\n${child?.stderr || ''}`));
  const validation = validateScenarioEvidence(opts.scenario, summary, childLogSummary);
  const ok = child?.exitCode === 0 && !endError && !telemetryReadError && validation.ok;
  Object.assign(report, {
    ok,
    status: telemetryReadError
      ? 'plugin_live_scenario_incomplete'
      : (ok ? 'plugin_live_scenario_passed' : 'plugin_live_scenario_failed'),
    scenario: opts.scenario,
    startedAt,
    finishedAt: new Date().toISOString(),
    token,
    telemetryPath,
    child: child || null,
    endResult,
    endError,
    telemetryReadError,
    telemetrySummary: summary,
    childLogSummary,
    validation,
  });
  if (endError) markLiveEvidenceIncomplete(report, 'wrapper_fatal_error');
  writeLiveEvidenceJson(opts.reportPath, report, {
    entrypointPath: fileURLToPath(import.meta.url),
    fixtureCommands,
    fixtureReceipts,
  });
  return report;
}

export function parseStartResponse(response) {
  const text = String(response || '');
  const token = /\btoken=([^\s]+)/.exec(text)?.[1] || null;
  const telemetryPath = /\btelemetry=([^\r\n]+)/.exec(text)?.[1]?.trim() || null;
  return { token, telemetryPath };
}

export function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readTelemetry(telemetryPath) {
  if (!telemetryPath || !fs.existsSync(telemetryPath)) return [];
  return parseJsonl(fs.readFileSync(telemetryPath, 'utf8'));
}

export function summarizeTelemetry(events = []) {
  const eventCounts = {};
  const itemPickupCounts = {};
  for (const event of events) {
    const name = event.event || 'unknown';
    eventCounts[name] = (eventCounts[name] || 0) + 1;
    if (name === 'item_pickup' && event.item) {
      const item = String(event.item);
      itemPickupCounts[item] = (itemPickupCounts[item] || 0) + (Number.isFinite(event.count) ? event.count : 1);
    }
  }
  const taggedHostileTags = [...new Set(events
    .filter((event) => event.tag)
    .map((event) => event.tag))].sort();
  const nearestTaggedHostileDistanceMin = events
    .filter((event) => Number.isFinite(event.nearestTaggedHostileDistance))
    .reduce((best, event) => Math.min(best, event.nearestTaggedHostileDistance), Number.POSITIVE_INFINITY);
  return {
    eventCount: events.length,
    eventCounts,
    taggedHostileTags,
    taggedHostileSpawnCount: eventCounts.tagged_hostile_spawn || 0,
    taggedHostileTerminalCount: (eventCounts.tagged_hostile_death || 0) + (eventCounts.tagged_hostile_despawn || 0),
    botDamageCount: eventCounts.bot_damage || 0,
    botDeathCount: eventCounts.bot_death || 0,
    botRespawnCount: eventCounts.bot_respawn || 0,
    botMoveCount: eventCounts.bot_move || 0,
    blockBreakCount: eventCounts.block_break || 0,
    blockPlaceCount: eventCounts.block_place || 0,
    itemPickupCount: eventCounts.item_pickup || 0,
    itemPickupCounts,
    itemDropCount: eventCounts.item_drop || 0,
    nearestTaggedHostileDistanceMin: Number.isFinite(nearestTaggedHostileDistanceMin)
      ? nearestTaggedHostileDistanceMin
      : null,
  };
}

export function parseStructuredChildLogs(text = '') {
  const records = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.evt === 'string') {
        records.push(parsed);
      }
    } catch {}
  }
  return records;
}

export function summarizeChildLogs(records = []) {
  const eventCounts = {};
  const lastByEvent = {};
  for (const record of records) {
    const evt = record.evt || 'unknown';
    eventCounts[evt] = (eventCounts[evt] || 0) + 1;
    lastByEvent[evt] = record;
  }
  return {
    eventCount: records.length,
    eventCounts,
    lastByEvent,
  };
}

export function validateScenarioEvidence(scenario, telemetrySummary, childLogSummary = summarizeChildLogs([])) {
  const telemetry = validateTelemetryForScenario(scenario, telemetrySummary);
  const childLogs = validateChildLogsForScenario(scenario, childLogSummary);
  const failures = [
    ...telemetry.failures,
    ...childLogs.failures,
  ];
  return {
    ok: failures.length === 0,
    failures,
    telemetry,
    childLogs,
  };
}

export function validateTelemetryForScenario(scenario, summary) {
  const failures = [];
  if (summary.eventCount <= 0) failures.push('telemetry file contained no events');
  if (scenario === 'live_hostile_escalation_fixture' || scenario === 'live_pvm_escalation_decision_fixture') {
    if (summary.taggedHostileSpawnCount < 1) failures.push('expected at least one tagged hostile spawn event');
    if (summary.taggedHostileTerminalCount < 1) failures.push('expected at least one tagged hostile death/despawn event');
    if (summary.botDamageCount < 1 && summary.botMoveCount < 1) {
      failures.push('expected at least one bot damage event or bot move event');
    }
  }
  if (scenario === 'live_mining_soak_fixture') {
    if (summary.botMoveCount < 1) failures.push('expected at least one bot move event during mining fixture');
    if (summary.blockBreakCount < 1) failures.push('expected at least one server-side block_break event during mining fixture');
  }
  if (scenario === 'live_supply_chest_fishing_fixture') {
    if (summary.botMoveCount < 1) failures.push('expected at least one bot move event during fishing fixture');
    if (summary.itemPickupCount < 3) failures.push('expected at least three server-side item_pickup events during fishing fixture');
  }
  if (scenario === 'live_death_recovery_fixture') {
    if (summary.botDeathCount < 1) failures.push('expected at least one server-side bot_death event during death recovery fixture');
    if (summary.botRespawnCount < 1) failures.push('expected at least one server-side bot_respawn event during death recovery fixture');
    if (summary.itemPickupCount < 1) failures.push('expected at least one item_pickup event during death recovery fixture');
  }
  return {
    ok: failures.length === 0,
    failures,
  };
}

export function validateChildLogsForScenario(scenario, summary) {
  const failures = [];
  if (scenario === 'live_supply_chest_fishing_fixture') {
    const done = summary.lastByEvent?.['live_supply_chest_fishing_fixture.done'];
    const mission = summary.lastByEvent?.['live_supply_chest_fishing_fixture.mission.result'];
    if (!mission) failures.push('expected fishing mission.result child log');
    if (!done) {
      failures.push('expected fishing done child log');
    } else {
      const catches = finiteNumber(done.catches);
      const minCatches = finiteNumber(done.minCatches) ?? 3;
      if (catches === null || catches < minCatches) {
        failures.push(`expected fishing catches >= ${minCatches}`);
      }
      if (done.taskBudget?.overdue !== false) {
        failures.push('expected fishing final task budget to be not overdue');
      }
      if (
        done.durationOnly === true
        && !['return-plan-due', 'return-reserve-reached'].includes(done.loopResult?.reason)
      ) {
        failures.push('expected duration-only fishing soak to end from return-plan-due or return-reserve-reached');
      }
    }
  }
  if (scenario === 'live_mining_soak_fixture') {
    const done = summary.lastByEvent?.['live_mining_soak_fixture.done'];
    if (!done) {
      failures.push('expected mining done child log');
    } else {
      if (done.returnedBeforeDeadline !== true) {
        failures.push('expected mining fixture to return before deadline');
      }
      if (done.taskBudget?.overdue !== false) {
        failures.push('expected mining final task budget to be not overdue');
      }
      if (
        done.requireReturnReserve === true
        && done.loopResult?.reason !== 'return-reserve-reached'
      ) {
        failures.push('expected strict mining soak to end from return-reserve-reached');
      }
      const durationMs = finiteNumber(done.durationMs);
      const minWorkMs = finiteNumber(done.minWorkMs) ?? 0;
      if (minWorkMs > 0 && (durationMs === null || durationMs < minWorkMs)) {
        failures.push(`expected mining duration >= ${minWorkMs}`);
      }
      if (countObjectValues(done.minedDelta) <= 0) {
        failures.push('expected mining done log to include mined target deltas');
      }
      if (countObjectValues(done.depositTargets) <= 0) {
        failures.push('expected mining done log to include deposited target deltas');
      }
    }
  }
  return {
    ok: failures.length === 0,
    failures,
  };
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function countObjectValues(value) {
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value)
    .filter(Number.isFinite)
    .reduce((sum, count) => sum + count, 0);
}

async function runHarnessCommand(rcon, commands, transport) {
  const responses = await transport({ ...rcon, commands });
  return { ok: true, responses };
}

function runChildProcess({ cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--v8-pool-size=1', 'scripts/live-suite.js'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function envInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function usage() {
  return [
    'usage: node --env-file=./config/low-impact-node.env --v8-pool-size=1 --import ./scripts/resource-lock-bootstrap.js scripts/run-live-scenario.js --scenario <id> [--timeout-ms ms] [--report path]',
    '',
    'Requires MCBOT_LIVE_TESTS=1, MCBOT_LIVE_ADMIN_OK=1, and MCBOT_RCON_PASSWORD.',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let resourceLease = null;
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      process.exitCode = 0;
    } else {
      const nodeRuntime = assertLowImpactNodeRuntime();
      const nodeScheduling = applyLowImpactNodeScheduling();
      const localServerPolicy = assertNoUncontrolledLocalMinecraftServerSync();
      resourceLease = globalThis[Symbol.for('mcbot.resourceLockBootstrapLease')]
        || acquireOrJoinResourceLockSync({
        repositoryRoot: ROOT,
        purpose: `plugin-live-scenario:${opts.scenario || 'unspecified'}`,
        details: { ...nodeRuntime, ...nodeScheduling, localMinecraftServerPolicy: localServerPolicy.policy, serialized: true },
        });
      const report = await runPluginBackedScenario(opts);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (err) {
    console.error(err?.message || String(err));
    process.exitCode = 1;
  } finally {
    if (resourceLease) resourceLease.releaseSync();
  }
}
