#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIVE_SCENARIO_ID,
  getLiveScenario,
  liveScenarioSummary,
  runnableLiveScenarioIds,
} from './live-scenarios.js';
import { buildLiveAdminPlan, runLiveAdminPlan } from './live-admin-commands.js';
import { acquireOrJoinResourceLockSync, applyLowImpactNodeScheduling } from './resource-lock.js';
import { assertNoUncontrolledLocalMinecraftServerSync } from './local-minecraft-server-policy.js';
import config from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const selectedId = process.env.MCBOT_LIVE_SCENARIO || DEFAULT_LIVE_SCENARIO_ID;
const scenario = getLiveScenario(selectedId);

if (process.env.MCBOT_LIVE_TESTS !== '1') {
  console.log('test:live skipped (set MCBOT_LIVE_TESTS=1 only for a private/local configured server)');
  console.log(`available live scenarios: ${liveScenarioSummary()}`);
  console.log(`select with MCBOT_LIVE_SCENARIO=<${runnableLiveScenarioIds().join('|')}>`);
  process.exit(0);
}

if (!scenario) {
  console.error(`unknown live scenario "${selectedId}". Available: ${runnableLiveScenarioIds().join(', ')}`);
  process.exit(1);
}

if (scenario.requiresDeepSeek) {
  console.error(`refusing live scenario "${scenario.id}" because this goal must not call DeepSeek`);
  process.exit(1);
}

if (scenario.account?.regime && config.account?.regime !== scenario.account.regime) {
  console.error(
    `refusing live scenario "${scenario.id}" because it is ${scenario.account.label}; `
      + `current MCBOT_ACCOUNT_REGIME=${config.account?.regime || 'unknown'}`,
  );
  process.exit(1);
}

if (scenario.requiresScriptedAdmin && process.env.MCBOT_LIVE_ADMIN_OK !== '1') {
  console.error(`refusing live scenario "${scenario.id}" without MCBOT_LIVE_ADMIN_OK=1`);
  process.exit(1);
}

if (scenario.requiresRcon && process.env.MCBOT_LIVE_ADMIN_DRY_RUN !== '1' && !process.env.MCBOT_RCON_PASSWORD) {
  console.error(`refusing live scenario "${scenario.id}" without MCBOT_RCON_PASSWORD`);
  process.exit(1);
}

for (const gate of scenario.requiredEnv || []) {
  const actual = process.env[gate.name];
  if (actual !== gate.value) {
    console.error(`refusing live scenario "${scenario.id}" without ${gate.name}=${gate.value}: ${gate.reason}`);
    process.exit(1);
  }
}

const nodeScheduling = applyLowImpactNodeScheduling();
const localServerPolicy = assertNoUncontrolledLocalMinecraftServerSync();
const resourceLeaseSymbol = Symbol.for('mcbot.resourceLockBootstrapLease');
const inheritedResourceLease = globalThis[resourceLeaseSymbol];
const resourceLease = inheritedResourceLease || acquireOrJoinResourceLockSync({
  repositoryRoot: ROOT,
  purpose: `mineflayer-live-suite:${scenario.id}`,
  details: { ...nodeScheduling, localMinecraftServerPolicy: localServerPolicy.policy, serialized: true },
  });
if (!inheritedResourceLease) globalThis[resourceLeaseSymbol] = resourceLease;

let holdLeaseForProcessLifetime = false;
try {
  console.log(`test:live running ${scenario.id}: ${scenario.title}`);
  if (scenario.account) console.log(`account regime: ${scenario.account.label}`);
  console.log(`expected log events: ${scenario.expectedLogEvents.join(', ')}`);
  if (scenario.fixture) console.log(`fixture: ${JSON.stringify(scenario.fixture)}`);
  if (scenario.optionalEnv) console.log(`optional env: ${scenario.optionalEnv.map((entry) => `${entry.name}=${entry.defaultValue}`).join(', ')}`);
  if (scenario.adminSetup) console.log(`admin setup: ${adminSetupSummary(scenario.adminSetup)}`);

  let setupOnly = false;
  if (process.env.MCBOT_LIVE_ADMIN_SETUP === '1') {
    if (!scenario.adminSetup) {
      throw new Error(`refusing live admin setup for "${scenario.id}" because the scenario does not define adminSetup metadata`);
    }
    const setupArgv = adminSetupArgv(scenario.adminSetup, process.env);
    const plan = buildLiveAdminPlan(setupArgv);
    if (!plan.ok) {
      throw new Error(`refusing live admin setup for "${scenario.id}": ${plan.reason}`);
    }
    const result = await runLiveAdminPlan(plan);
    console.log(`live admin setup: ${JSON.stringify(result)}`);
    setupOnly = process.env.MCBOT_LIVE_ADMIN_SETUP_ONLY === '1';
  }

  if (!setupOnly) {
    assertNoUncontrolledLocalMinecraftServerSync({
      host: config.minecraft.host,
      ports: [config.minecraft.port],
      denyLocalEndpoint: true,
    });
    // The live entrypoint installs long-lived bot/socket handlers and resolves its
    // module import immediately. Retain ownership before import so a partially
    // started entrypoint that later rejects cannot release the live-process lease.
    holdLeaseForProcessLifetime = true;
    await import(scenario.entrypoint);
  }
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  if (!holdLeaseForProcessLifetime) resourceLease.releaseSync();
}

function adminSetupArgv(setup, env) {
  const action = env[setup.actionEnv] || setup.defaultAction || setup.action;
  if (Array.isArray(setup.allowedActions) && !setup.allowedActions.includes(action)) {
    return [`invalid-admin-action:${action}`];
  }
  return [
    action,
    ...(setup.args || []).map((arg) => String(env[arg.env] || arg.defaultValue)),
  ];
}

function adminSetupSummary(setup) {
  const action = setup.defaultAction || setup.action;
  const args = (setup.args || []).map((arg) => `${arg.env}=${arg.defaultValue}`).join(', ');
  return `${action}${args ? ` (${args})` : ''}`;
}
