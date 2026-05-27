#!/usr/bin/env node
//
// iron-tier-verify-live -- live verifier for autonomous iron-pickaxe
// progression from an empty or constrained inventory.
//
// Wraps the advisor-live-plan harness with iron-tier success criteria
// (itemGoal.met, no bot death, plugin telemetry closed) and structured
// pass/fail evaluation. Part of the live-verifier family (vertical-
// movement, mining-reliability, fishing/auto-eat verifiers); iron-tier
// sits at the top of the deterministic substrate stack and is the
// load-bearing public proof today.
//
// Usage gated behind MCBOT_LIVE_TESTS=1 and the live admin opt-ins.
// See --help for the full setup-flag surface.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  buildAdvisorLivePlanConfig,
  createAdvisorLivePlanReport,
  renderAdvisorLivePlanMarkdown,
  runAdvisorLivePlan,
} from './advisor-live-plan.js';
import { buildLiveAdminPlan } from './live-admin-commands.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const BOT_NAME = 'MCBot';
const DEFAULT_GOAL = 'make an iron pickaxe';
const DEFAULT_REPORT_PATH = path.join(ROOT, 'reports', 'overnight-phase1', 'composite-iron-pickaxe.json');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5000;
const DEFAULT_POSITION_WAIT_MS = 60000;
const DEFAULT_INDUCE_AFTER_MS = 999999999;
const DEFAULT_CONSTRAINED_INVENTORY = 'stone_pickaxe:1,crafting_table:1,furnace:1,coal:8,oak_planks:4,stick:4';
const STARTER_FIXTURE_PAD_RADIUS = 5;

export function parseArgs(argv = []) {
  const opts = {
    goal: DEFAULT_GOAL,
    fixture: 'constrained',
    reportPath: DEFAULT_REPORT_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    startupDelayMs: DEFAULT_STARTUP_DELAY_MS,
    positionWaitMs: DEFAULT_POSITION_WAIT_MS,
    setupTeleport: null,
    setupQuietBaseline: false,
    setupClearAll: false,
    setupInventoryRaw: null,
    setupInventory: null,
    setupStarterWoodFixture: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--goal') {
      opts.goal = nonEmpty(argv[++index], '--goal');
    } else if (arg === '--fixture') {
      opts.fixture = fixtureName(argv[++index]);
    } else if (arg === '--report-path' || arg === '--report') {
      opts.reportPath = path.resolve(nonEmpty(argv[++index], arg));
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = positiveInteger(argv[++index], '--timeout-ms');
    } else if (arg === '--startup-delay-ms') {
      opts.startupDelayMs = positiveInteger(argv[++index], '--startup-delay-ms');
    } else if (arg === '--position-wait-ms') {
      opts.positionWaitMs = positiveInteger(argv[++index], '--position-wait-ms');
    } else if (arg === '--setup-teleport') {
      opts.setupTeleport = {
        x: finiteNumber(argv[++index], '--setup-teleport x'),
        y: finiteNumber(argv[++index], '--setup-teleport y'),
        z: finiteNumber(argv[++index], '--setup-teleport z'),
      };
    } else if (arg === '--setup-quiet-baseline') {
      opts.setupQuietBaseline = true;
    } else if (arg === '--setup-clear-all') {
      opts.setupClearAll = true;
    } else if (arg === '--no-setup-clear-all') {
      opts.setupClearAll = false;
    } else if (arg === '--setup-inventory') {
      opts.setupInventoryRaw = nonEmpty(argv[++index], '--setup-inventory');
    } else if (arg === '--setup-starter-wood-fixture') {
      opts.setupStarterWoodFixture = true;
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }

  const inventoryRaw = opts.setupInventoryRaw || (opts.fixture === 'constrained' ? DEFAULT_CONSTRAINED_INVENTORY : '');
  opts.setupInventory = parseSetupInventory(inventoryRaw);
  if (opts.fixture === 'from_empty' && opts.setupInventory.length > 0) {
    throw new Error('--fixture from_empty cannot be combined with --setup-inventory');
  }
  if (opts.setupStarterWoodFixture && !opts.setupTeleport) {
    throw new Error('--setup-starter-wood-fixture requires --setup-teleport');
  }
  return opts;
}

export function parseSetupInventory(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return [];
  return text.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const splitAt = entry.lastIndexOf(':');
      if (splitAt <= 0) throw new Error(`invalid setup inventory entry "${entry}"`);
      const itemRaw = entry.slice(0, splitAt);
      const countRaw = entry.slice(splitAt + 1);
      const item = safeItem(itemRaw);
      const count = positiveInteger(countRaw, `setup inventory count for ${item}`);
      return { item: minecraftItem(item), count };
    });
}

export function buildSetupAdminPlan(opts = {}) {
  const actions = [];
  if (opts.setupTeleport) {
    const safe = safeTeleportColumn(opts.setupTeleport);
    actions.push({
      label: 'forceload-teleport-chunk',
      plan: buildLiveAdminPlan([
        'raw',
        `minecraft:forceload add ${safe.x} ${safe.z}`,
      ]),
    });
    actions.push({
      label: 'support-teleport-floor',
      plan: buildLiveAdminPlan([
        'raw',
        `minecraft:setblock ${safe.x} ${safe.y - 1} ${safe.z} minecraft:grass_block replace`,
      ]),
    });
    actions.push({
      label: 'clear-teleport-column',
      plan: buildLiveAdminPlan([
        'raw',
        `minecraft:fill ${safe.x} ${safe.y} ${safe.z} ${safe.x} ${safe.y + 1} ${safe.z} minecraft:air replace`,
      ]),
    });
    actions.push({
      label: 'teleport-player',
      plan: buildLiveAdminPlan([
        'teleport-player',
        BOT_NAME,
        String(opts.setupTeleport.x),
        String(opts.setupTeleport.y),
        String(opts.setupTeleport.z),
      ]),
    });
    actions.push({
      label: 'release-teleport-chunk',
      plan: buildLiveAdminPlan([
        'raw',
        `minecraft:forceload remove ${safe.x} ${safe.z}`,
      ]),
    });
  }
  if (opts.setupClearAll) {
    actions.push({
      label: 'clear-all',
      plan: buildLiveAdminPlan(['raw', `minecraft:clear ${BOT_NAME}`]),
    });
  }
  for (const entry of opts.setupInventory || []) {
    actions.push({
      label: `give-${entry.item.replace(/^minecraft:/, '')}`,
      plan: buildLiveAdminPlan(['give', BOT_NAME, entry.item, String(entry.count)]),
    });
  }
  for (const block of starterWoodFixtureBlocks(opts)) {
    actions.push({
      label: block.label,
      plan: buildLiveAdminPlan([
        'raw',
        `minecraft:setblock ${block.x} ${block.y} ${block.z} ${block.block} replace`,
      ]),
    });
  }
  return actions;
}

function safeTeleportColumn(position) {
  return {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z)),
  };
}

export function starterWoodFixtureBlocks(opts = {}) {
  if (!opts.setupStarterWoodFixture || !opts.setupTeleport) return [];
  const origin = safeTeleportColumn(opts.setupTeleport);
  return [
    ...starterFixtureCleanupBlocks(origin),
    ...starterWoodLogBlocks(origin),
  ];
}

function starterFixtureCleanupBlocks(origin) {
  const out = [];
  for (let dx = -STARTER_FIXTURE_PAD_RADIUS; dx <= STARTER_FIXTURE_PAD_RADIUS; dx += 1) {
    for (let dz = -STARTER_FIXTURE_PAD_RADIUS; dz <= STARTER_FIXTURE_PAD_RADIUS; dz += 1) {
      const x = origin.x + dx;
      const z = origin.z + dz;
      out.push(
        {
          x,
          y: origin.y - 1,
          z,
          block: 'minecraft:grass_block',
          label: `starter-fixture-pad-${dx}-${dz}-support`,
        },
        {
          x,
          y: origin.y,
          z,
          block: 'minecraft:air',
          label: `starter-fixture-pad-${dx}-${dz}-clear-feet`,
        },
        {
          x,
          y: origin.y + 1,
          z,
          block: 'minecraft:air',
          label: `starter-fixture-pad-${dx}-${dz}-clear-head`,
        },
      );
    }
  }

  const tablePad = { x: origin.x - 3, y: origin.y, z: origin.z + 3 };
  out.push(
    {
      x: tablePad.x,
      y: tablePad.y,
      z: tablePad.z,
      block: 'minecraft:grass_block',
      label: 'starter-fixture-table-pad-support',
    },
    {
      x: tablePad.x,
      y: tablePad.y + 1,
      z: tablePad.z,
      block: 'minecraft:air',
      label: 'starter-fixture-table-pad-clear-feet',
    },
    {
      x: tablePad.x,
      y: tablePad.y + 2,
      z: tablePad.z,
      block: 'minecraft:air',
      label: 'starter-fixture-table-pad-clear-head',
    },
  );

  for (let depth = 1; depth <= 3; depth += 1) {
    const x = origin.x - depth;
    const z = origin.z;
    const stepDownY = origin.y - depth;
    const supportY = stepDownY - 1;
    const feetY = stepDownY + 1;
    const headY = stepDownY + 2;
    out.push(
      {
        x,
        y: supportY,
        z,
        block: 'minecraft:stone',
        label: `starter-fixture-shaft-${depth}-support`,
      },
      {
        x,
        y: stepDownY,
        z,
        block: 'minecraft:stone',
        label: `starter-fixture-shaft-${depth}-step-down`,
      },
      {
        x,
        y: feetY,
        z,
        block: 'minecraft:air',
        label: `starter-fixture-shaft-${depth}-clear-feet`,
      },
      {
        x,
        y: headY,
        z,
        block: 'minecraft:air',
        label: `starter-fixture-shaft-${depth}-clear-head`,
      },
    );
  }

  return out;
}

function starterWoodLogBlocks(origin) {
  const logs = [];
  const startX = origin.x + 2;
  const startZ = origin.z - 2;
  for (const dx of [0, 1]) {
    for (let dz = 0; dz < 5; dz += 1) {
      logs.push({
        x: startX + dx,
        y: origin.y,
        z: startZ + dz,
        block: 'minecraft:oak_log',
        label: `starter-wood-log-${logs.length + 1}`,
      });
    }
  }
  return logs.flatMap((log) => [
    {
      x: log.x,
      y: log.y - 1,
      z: log.z,
      block: 'minecraft:grass_block',
      label: `${log.label}-support`,
    },
    log,
  ]);
}

export function buildAdvisorArgs(opts = {}) {
  const args = [
    '--goal', opts.goal || DEFAULT_GOAL,
    '--report-path', opts.reportPath || DEFAULT_REPORT_PATH,
    '--timeout-ms', String(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    '--induce-after-ms', String(DEFAULT_INDUCE_AFTER_MS),
    '--position-wait-ms', String(opts.positionWaitMs || DEFAULT_POSITION_WAIT_MS),
    '--startup-delay-ms', String(opts.startupDelayMs || DEFAULT_STARTUP_DELAY_MS),
  ];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.setupQuietBaseline) args.push('--setup-quiet-baseline');
  if (opts.setupTeleport) {
    args.push('--setup-teleport', String(opts.setupTeleport.x), String(opts.setupTeleport.y), String(opts.setupTeleport.z));
  }
  if (opts.setupClearAll) args.push('--setup-clear-all');
  for (const entry of opts.setupInventory || []) {
    args.push('--setup-give', entry.item, String(entry.count));
  }
  for (const block of starterWoodFixtureBlocks(opts)) {
    args.push('--setup-block', String(block.x), String(block.y), String(block.z), block.block);
  }
  return args;
}

export function evaluatePassCriteria(report, opts = {}) {
  if (!report.assertions || typeof report.assertions !== 'object') report.assertions = {};
  const itemGoal = report.mission?.itemGoal || {};
  const telemetry = report.plugin?.telemetrySummary || {};
  const targetItemGoalMet = Boolean(itemGoal.item) &&
    itemGoal.met === true &&
    Number(itemGoal.have || 0) >= Number(itemGoal.count || 1);
  report.assertions.targetItemGoal = targetItemGoalMet;
  if (itemGoal.item === 'iron_pickaxe' || /\biron[_\s-]*pickaxe\b/i.test(String(opts.goal || report.goal || ''))) {
    report.assertions.ironPickaxeGoal = itemGoal.item === 'iron_pickaxe' && targetItemGoalMet;
  }
  report.assertions.noBotDeath = Number(telemetry.botDeathCount || 0) === 0;
  report.assertions.pluginTelemetryToken = Boolean(report.plugin?.token && report.plugin?.telemetryPath);
  report.assertions.pluginTelemetryClosed = report.plugin?.started === true &&
    report.plugin?.ended === true &&
    report.plugin?.finalSnapshot?.ok === true;
  report.assertions.reportItemGoalMet = report.mission?.itemGoal?.met === true;
  const ok = Object.values(report.assertions).every((value) => value === true);
  report.ironTierVerifier = {
    ok,
    fixture: opts.fixture || null,
    goal: opts.goal || report.goal || DEFAULT_GOAL,
    targetItem: itemGoal.item || null,
    failures: failedAssertions(report),
  };
  report.itemGoalVerifier = { ...report.ironTierVerifier };
  if (ok) {
    report.ok = true;
    report.outcome = 'success';
    report.status = verifiedStatusForItem(itemGoal.item);
  } else {
    report.status = report.status === 'live_plan_completed' ? 'iron_tier_assertions_failed' : report.status;
  }
  return { ok, assertions: { ...report.assertions }, failures: failedAssertions(report) };
}

function verifiedStatusForItem(item) {
  if (item === 'iron_pickaxe') return 'iron_tier_verified';
  if (item === 'diamond_pickaxe') return 'diamond_tier_verified';
  return 'item_goal_verified';
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const advisorArgs = buildAdvisorArgs(opts);
  const runConfig = buildAdvisorLivePlanConfig({ argv: advisorArgs, env });
  if (!runConfig.ok) {
    if (runConfig.help) console.log(runConfig.reason);
    else console.error(runConfig.reason);
    return runConfig.help ? 0 : 1;
  }

  if (opts.dryRun) {
    const report = createAdvisorLivePlanReport(runConfig);
    report.ironTierVerifier = {
      ok: null,
      fixture: opts.fixture,
      goal: opts.goal,
      setupAdminPlan: buildSetupAdminPlan(opts).map((entry) => entry.label),
    };
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      advisorArgs,
      reportPath: opts.reportPath,
      report,
    }, null, 2));
    return 0;
  }

  const report = await runAdvisorLivePlan(runConfig);
  const evaluated = evaluatePassCriteria(report, opts);
  writeReports(opts.reportPath, report);
  console.log(JSON.stringify({
    ok: evaluated.ok,
    status: report.status,
    fixture: opts.fixture,
    reportPath: opts.reportPath,
    failures: evaluated.failures,
  }, null, 2));
  return evaluated.ok ? 0 : 1;
}

function failedAssertions(report) {
  return Object.entries(report.assertions || {})
    .filter(([, value]) => value !== true)
    .map(([name]) => name);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeReports(filePath, report) {
  writeJson(filePath, report);
  fs.writeFileSync(markdownPathFor(filePath), renderAdvisorLivePlanMarkdown(report), 'utf8');
}

function markdownPathFor(filePath) {
  return filePath.replace(/\.json$/i, '.md');
}

function fixtureName(value) {
  const name = String(value || '').trim();
  if (name === 'constrained' || name === 'from_empty') return name;
  throw new Error('--fixture must be constrained or from_empty');
}

function safeItem(value) {
  const text = nonEmpty(value, 'item').replace(/^minecraft:/, '');
  if (!/^[a-z0-9_]+$/.test(text)) throw new Error(`invalid item "${value}"`);
  return text;
}

function minecraftItem(value) {
  return String(value || '').startsWith('minecraft:') ? value : `minecraft:${value}`;
}

function positiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`);
  return n;
}

function finiteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be finite number`);
  return n;
}

function nonEmpty(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function usage() {
  return [
    'usage: node scripts/iron-tier-verify-live.js --fixture constrained|from_empty --report-path reports/overnight-phase1/iron.json',
    '',
    'Live gates:',
    '- MCBOT_LIVE_TESTS=1 required',
    '- MCBOT_ALLOW_DEEPSEEK=1 required',
    '- MCBOT_LIVE_ADMIN_OK=1 required',
    '- MCBOT_LIVE_ADMIN_RAW_OK=1 required when using --setup-clear-all or --setup-quiet-baseline',
    '- DEEPSEEK_API_KEY and MCBOT_RCON_PASSWORD required for real live runs',
    '',
    'Fixture setup:',
    '- --fixture constrained uses --setup-inventory or the default stone_pickaxe/table/furnace/fuel kit',
    '- --fixture from_empty requires an empty inventory setup; pair it with --setup-clear-all',
    '- --setup-inventory format: "stone_pickaxe:1,coal:8,oak_planks:4,stick:4"',
    '- --setup-starter-wood-fixture places a small grounded oak_log fixture near --setup-teleport without giving inventory',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
