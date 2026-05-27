#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import config from '../src/config.js';
import { parseItemChainGoal } from '../src/advisor/item_goal.js';
import {
  buildLiveAdminPlan,
  rconConfigFromEnv,
  runLiveAdminPlan,
  sendRconCommands,
} from './live-admin-commands.js';
import {
  parseStartResponse,
  readTelemetry,
  summarizeTelemetry,
} from './run-live-scenario.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_GOAL = 'gather 10 logs';
const DEFAULT_REPORT_PATH = path.join(ROOT, 'reports', 'advisor-live-plan.json');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INDUCE_AFTER_MS = 45 * 1000;
const DEFAULT_POSITION_WAIT_MS = 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5000;
const DEFAULT_FINAL_OUTCOME_STOP_GRACE_MS = 10 * 1000;
const DEFAULT_FINAL_SNAPSHOT_CLOSE_WAIT_MS = 1000;
const DEFAULT_FINAL_SNAPSHOT_SETTLE_MS = 1200;
const DEFAULT_PLUGIN_SCENARIO_ID = 'advisor_live_plan_f2';
const DEFAULT_HOSTILE_TAG = 'f2_live_plan_hostile_1';
const ADVISOR_LIVE_PLAN_MODEL = 'deepseek-v4-pro';
const BOT_CHILD_MAX_OLD_SPACE_MB = 4096;
const BOT_DISCONNECT_STOP_TERM_MS = 1000;
const BOT_DISCONNECT_STOP_KILL_MS = 2000;
const LOG_ITEM_NAMES = Object.freeze([
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
]);

export function parseAdvisorLivePlanArgs(argv = []) {
  const opts = {
    goal: DEFAULT_GOAL,
    reportPath: DEFAULT_REPORT_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    induceAfterMs: DEFAULT_INDUCE_AFTER_MS,
    positionWaitMs: DEFAULT_POSITION_WAIT_MS,
    hostileOffset: { x: 4, y: 0, z: 0 },
    hostileCleanupAfterFleeMs: 0,
    hostileCleanupRadius: 24,
    startupDelayMs: 0,
    setupTeleport: null,
    setupQuietBaseline: false,
    quietBaselineOriginalDifficulty: null,
    setupClearAll: false,
    setupClearItems: [],
    setupGives: [],
    setupBlocks: [],
    setupDamage: null,
    setupDamageType: null,
    setupDamageDelayMs: 0,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--goal') {
      opts.goal = requireValue(argv, ++i, '--goal');
    } else if (arg === '--report' || arg === '--report-path') {
      opts.reportPath = path.resolve(requireValue(argv, ++i, arg));
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = positiveInteger(requireValue(argv, ++i, '--timeout-ms'), '--timeout-ms');
    } else if (arg === '--induce-after-ms') {
      opts.induceAfterMs = positiveInteger(requireValue(argv, ++i, '--induce-after-ms'), '--induce-after-ms');
    } else if (arg === '--position-wait-ms') {
      opts.positionWaitMs = positiveInteger(requireValue(argv, ++i, '--position-wait-ms'), '--position-wait-ms');
    } else if (arg === '--startup-delay-ms') {
      opts.startupDelayMs = positiveInteger(requireValue(argv, ++i, '--startup-delay-ms'), '--startup-delay-ms');
    } else if (arg === '--setup-teleport') {
      opts.setupTeleport = {
        x: finiteNumber(requireValue(argv, ++i, '--setup-teleport x'), '--setup-teleport x'),
        y: finiteNumber(requireValue(argv, ++i, '--setup-teleport y'), '--setup-teleport y'),
        z: finiteNumber(requireValue(argv, ++i, '--setup-teleport z'), '--setup-teleport z'),
      };
    } else if (arg === '--setup-quiet-baseline') {
      opts.setupQuietBaseline = true;
    } else if (arg === '--setup-clear-all') {
      opts.setupClearAll = true;
    } else if (arg === '--setup-clear-item') {
      opts.setupClearItems.push(safeItemName(requireValue(argv, ++i, '--setup-clear-item')));
    } else if (arg === '--setup-give') {
      opts.setupGives.push({
        item: safeItemName(requireValue(argv, ++i, '--setup-give item')),
        count: positiveInteger(requireValue(argv, ++i, '--setup-give count'), '--setup-give count'),
      });
    } else if (arg === '--setup-block') {
      opts.setupBlocks.push({
        x: finiteNumber(requireValue(argv, ++i, '--setup-block x'), '--setup-block x'),
        y: finiteNumber(requireValue(argv, ++i, '--setup-block y'), '--setup-block y'),
        z: finiteNumber(requireValue(argv, ++i, '--setup-block z'), '--setup-block z'),
        block: safeBlockName(requireValue(argv, ++i, '--setup-block block')),
      });
    } else if (arg === '--setup-damage') {
      opts.setupDamage = positiveNumber(requireValue(argv, ++i, '--setup-damage amount'), '--setup-damage amount');
    } else if (arg === '--setup-damage-type') {
      opts.setupDamageType = safeDamageTypeName(requireValue(argv, ++i, '--setup-damage-type type'));
    } else if (arg === '--setup-damage-delay-ms') {
      opts.setupDamageDelayMs = positiveInteger(
        requireValue(argv, ++i, '--setup-damage-delay-ms'),
        '--setup-damage-delay-ms',
      );
    } else if (arg === '--hostile-dx') {
      opts.hostileOffset.x = finiteNumber(requireValue(argv, ++i, '--hostile-dx'), '--hostile-dx');
    } else if (arg === '--hostile-dy') {
      opts.hostileOffset.y = finiteNumber(requireValue(argv, ++i, '--hostile-dy'), '--hostile-dy');
    } else if (arg === '--hostile-dz') {
      opts.hostileOffset.z = finiteNumber(requireValue(argv, ++i, '--hostile-dz'), '--hostile-dz');
    } else if (arg === '--cleanup-induced-hostile-after-flee-ms') {
      opts.hostileCleanupAfterFleeMs = positiveInteger(
        requireValue(argv, ++i, '--cleanup-induced-hostile-after-flee-ms'),
        '--cleanup-induced-hostile-after-flee-ms',
      );
    } else if (arg === '--hostile-cleanup-radius') {
      opts.hostileCleanupRadius = positiveNumber(
        requireValue(argv, ++i, '--hostile-cleanup-radius'),
        '--hostile-cleanup-radius',
      );
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }

  return opts;
}

export function buildAdvisorLivePlanConfig({
  argv = [],
  env = process.env,
  account = config.account,
  minecraft = config.minecraft,
  deepseek = config.deepseek,
} = {}) {
  let opts;
  try {
    opts = parseAdvisorLivePlanArgs(argv);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (opts.help) return { ok: false, help: true, reason: usageText() };

  const reasons = [];
  if (opts.dryRun !== true) {
    if (env.MCBOT_LIVE_TESTS !== '1') reasons.push('MCBOT_LIVE_TESTS=1 required');
    if (env.MCBOT_ALLOW_DEEPSEEK !== '1') reasons.push('MCBOT_ALLOW_DEEPSEEK=1 required');
    if (!deepseek?.apiKey) reasons.push('DEEPSEEK_API_KEY required');
    if (env.MCBOT_LIVE_ADMIN_OK !== '1') reasons.push('MCBOT_LIVE_ADMIN_OK=1 required');
    if (startupSetupNeedsRawAdmin(opts) && env.MCBOT_LIVE_ADMIN_RAW_OK !== '1') {
      reasons.push('MCBOT_LIVE_ADMIN_RAW_OK=1 required for raw startup setup');
    }
    if (env.MCBOT_LIVE_ADMIN_DRY_RUN !== '1' && !env.MCBOT_RCON_PASSWORD) {
      reasons.push('MCBOT_RCON_PASSWORD required for RCON hostile induction');
    }
  }

  const regime = String(account?.regime || '').toLowerCase();
  const username = String(minecraft?.username || '').toLowerCase();
  const auth = String(minecraft?.auth || '').toLowerCase();
  if (regime !== 'test') reasons.push(`account.regime must be "test" for F2 Regime A, got "${account?.regime || 'unknown'}"`);
  if (username !== 'mcbot') reasons.push(`minecraft.username must be "MCBot" for F2 Regime A, got "${minecraft?.username || 'unknown'}"`);
  if (auth !== 'offline') reasons.push(`minecraft.auth must be "offline" for F2 Regime A, got "${minecraft?.auth || 'unknown'}"`);

  if (reasons.length > 0) {
    return {
      ok: false,
      reason: `refusing F2 advisor live plan: ${reasons.join('; ')}`,
      options: opts,
    };
  }

  const requestedModel = nonEmptyString(env.DEEPSEEK_MODEL) || nonEmptyString(deepseek?.model) || null;
  const childEnv = { ...process.env };
  childEnv.DEEPSEEK_MODEL = ADVISOR_LIVE_PLAN_MODEL;
  if (hasStartupSetup(opts)) {
    childEnv.MCBOT_STARTUP_DELAY_MS = String(opts.startupDelayMs || DEFAULT_STARTUP_DELAY_MS);
  } else if (opts.startupDelayMs > 0) {
    childEnv.MCBOT_STARTUP_DELAY_MS = String(opts.startupDelayMs);
  }

  return {
    ok: true,
    options: opts,
    account: {
      regime: 'test',
      username: minecraft.username,
      auth: minecraft.auth,
    },
    advisorModel: {
      required: ADVISOR_LIVE_PLAN_MODEL,
      requested: requestedModel,
      childEnv: ADVISOR_LIVE_PLAN_MODEL,
      overridden: Boolean(requestedModel && requestedModel !== ADVISOR_LIVE_PLAN_MODEL),
    },
    command: {
      executable: process.execPath,
      args: [`--max-old-space-size=${BOT_CHILD_MAX_OLD_SPACE_MB}`, 'src/index.js', opts.goal],
      cwd: ROOT,
      env: childEnv,
    },
  };
}

export function createAdvisorLivePlanReport(runConfig, now = new Date()) {
  return {
    ok: false,
    noApiCall: true,
    status: 'live_plan_running',
    startedAt: now.toISOString(),
    goal: runConfig.options.goal,
    accountRegime: 'test',
    account: {
      username: runConfig.account.username,
      auth: runConfig.account.auth,
    },
    planner: {
      callMade: false,
      schemaValid: false,
      acceptedSteps: 0,
      maxAcceptedSteps: 0,
      acceptedPlanCount: 0,
    },
    activation: {
      accepted: false,
    },
    executor: {
      ranSkillCount: 0,
      skillsExecuted: [],
      failedSkillCount: 0,
      lastSkillResult: null,
    },
    timing: {
      queueHandoff: [],
      skillRuntime: [],
      pathfinderSettle: [],
      pickupWait: [],
      summary: {},
      _state: {},
    },
    finalOutcome: {
      reported: false,
      summary: '',
    },
    outcome: 'running',
    attemptsMade: 1,
    mission: {
      targetLogCount: 10,
      woodTargets: [],
      retargets: [],
      progress: {
        latestLogsObserved: 0,
        maxLogsObserved: 0,
        goal: 10,
      },
      finalInventory: {
        captured: false,
        counts: {},
        logCounts: {},
        totalLogs: 0,
        meetsGoal: false,
        partialGoal: false,
      },
    },
    advisorCalls: [],
    cost: {
      usd: 0,
    },
    costCeilingGuard: {
      verified: false,
    },
    hostileFlee: {
      survived: false,
      inducedAt: null,
      eligibleAt: null,
      eventCount: 0,
      transitionObserved: false,
      transitionObservedAt: null,
      returnedNormal: false,
      cleanup: {
        requested: runConfig.options.hostileCleanupAfterFleeMs > 0,
        completed: false,
      },
    },
    plugin: {
      required: true,
      scenarioId: DEFAULT_PLUGIN_SCENARIO_ID,
      started: false,
      ended: false,
      token: null,
      telemetryPath: null,
      telemetrySummary: null,
      finalSnapshot: null,
      errors: [],
    },
    diagnostics: {
      advisorModel: runConfig.advisorModel || {
        required: ADVISOR_LIVE_PLAN_MODEL,
        requested: null,
        childEnv: ADVISOR_LIVE_PLAN_MODEL,
        overridden: false,
      },
      logEvents: {},
      latestPosition: null,
      rcon: null,
      setup: {
        requested: hasStartupSetup(runConfig.options),
        completed: false,
        actions: [],
      },
      quietBaseline: {
        requested: runConfig.options.setupQuietBaseline === true,
        originalDifficulty: null,
        restore: {
          requested: false,
          completed: false,
        },
      },
      childExit: null,
      timeout: false,
      failures: [],
    },
  };
}

export function updateAdvisorLivePlanReportFromRecord(report, record) {
  if (!record || typeof record !== 'object') return report;
  const evt = record.evt || 'unknown';
  if (isAdvisorLivePlanBotDisconnectRecord(record)) {
    report.diagnostics.logEvents[evt] = (report.diagnostics.logEvents[evt] || 0) + 1;
    markAdvisorLivePlanBotDisconnected(report, record);
    return report;
  }
  if (advisorLivePlanBotDisconnected(report)) return report;
  report.diagnostics.logEvents[evt] = (report.diagnostics.logEvents[evt] || 0) + 1;
  const position = positionFromRecord(record);
  if (position) report.diagnostics.latestPosition = position;
  updateTimingFromRecord(report, record);

  if (evt === 'llm.request') {
    report.noApiCall = false;
    report.planner.callMade = true;
    report.advisorCalls.push({
      index: report.advisorCalls.length + 1,
      requestedAt: record.t || new Date().toISOString(),
      model: record.model || null,
      schemaValidation: 'pending',
    });
  } else if (evt === 'plan.accepted') {
    report.planner.schemaValid = true;
    markLatestAdvisorCallAccepted(report, record);
    const steps = Number(record.steps || 0);
    report.planner.acceptedSteps = Math.max(Number(report.planner.acceptedSteps || 0), steps);
    report.planner.maxAcceptedSteps = Math.max(Number(report.planner.maxAcceptedSteps || 0), steps);
    report.planner.lastAcceptedSteps = steps;
    report.planner.acceptedPlanCount = Number(report.planner.acceptedPlanCount || 0) + 1;
    updateWoodTargetsFromPlan(report, record.plan || []);
  } else if (evt === 'plan.bad-json' || evt === 'plan.bad-shape' || evt === 'plan.invalid-skills') {
    markLatestAdvisorCallRejected(report, record);
  } else if (evt === 'goal.plan-activation-ok') {
    report.activation.accepted = true;
    markHostileInductionEligible(report, record);
  } else if (evt === 'goal.plan-activation-rejected') {
    report.activation.accepted = false;
    report.activation.rejected = true;
    report.activation.reason = record.reason || 'plan activation rejected';
    report.activation.badIndex = record.badIndex;
    report.activation.safetyReasons = Array.isArray(record.safetyReasons) ? record.safetyReasons : [];
    report.activation.staleReasons = Array.isArray(record.staleReasons) ? record.staleReasons : [];
    const classification = classifyPlanActivationRejection(record);
    report.activation.rejectionClass = classification.kind;
    report.activation.terminal = classification.terminal;
    if (classification.terminal === true) {
      markTerminalPlanActivationRejection(report, record, classification);
    }
  } else if (evt === 'skill.invoke') {
    addExecutedSkill(report, record.skill);
    markHostileInductionEligible(report, record);
  } else if (evt === 'skill.result') {
    addExecutedSkill(report, record.skill);
    report.executor.lastSkillResult = {
      skill: record.skill || null,
      ok: record.ok !== false,
      reason: record.reason || '',
      at: record.t || new Date().toISOString(),
    };
    if (record.ok === false) recordSkillFailure(report, record.skill, record.reason || 'skill result failed');
  } else if (evt === 'llm.response') {
    report.noApiCall = false;
    report.cost.usd = numericCost(record.sessionCostUsd, report.cost.usd);
    report.cost.lastCallUsd = numericCost(record.callCostUsd, report.cost.lastCallUsd);
    report.cost.model = record.model || report.cost.model;
    updateLatestAdvisorCallMetrics(report, record);
  } else if (evt === 'llm.cost') {
    report.cost.usd = numericCost(record.sessionCostUsd, report.cost.usd);
  } else if (evt === 'llm.costCeilingGuard' && record.costCeilingGuard?.verified === true) {
    report.costCeilingGuard = {
      verified: true,
      ceilingUsd: record.costCeilingGuard.ceilingUsd,
      currentUsd: record.costCeilingGuard.currentUsd,
    };
  } else if (evt === 'state.transition') {
    updateHostileFleeFromTransition(report, record);
  } else if (evt === 'collect.target') {
    updateMissionProgress(report, record.sofar, record.goal);
  } else if (evt === 'skill.result') {
    updateMissionProgressFromSkillResult(report, record);
  } else if (evt === 'emergency.logout') {
    report.diagnostics.failures.push('critical-health emergency logout during live plan');
  } else if (evt === 'queue.failure') {
    recordSkillFailure(report, record.skill, record.reason || 'queue failure');
  } else if (evt === 'main.goal-done') {
    report.finalOutcome = {
      reported: true,
      summary: record.reason || 'goal complete',
      ok: true,
      replans: record.replans,
    };
  } else if (evt === 'main.goal-failed') {
    report.finalOutcome = {
      reported: true,
      summary: record.reason || 'goal failed',
      ok: false,
      replans: record.replans,
    };
    report.diagnostics.failures.push(record.reason || 'goal failed');
  } else if (evt === 'main.exception') {
    report.finalOutcome = {
      reported: true,
      summary: record.err || 'main exception',
      ok: false,
    };
    report.diagnostics.failures.push(record.err || 'main exception');
  }

  return report;
}

export function buildHostileInductionPlan(position, offset = { x: 4, y: 0, z: 0 }, opts = {}) {
  const spawn = {
    x: roundCoordinate(Number(position.x) + Number(offset.x || 0)),
    y: roundCoordinate(Number(position.y) + Number(offset.y || 0)),
    z: roundCoordinate(Number(position.z) + Number(offset.z || 0)),
  };
  const tag = opts.tag || DEFAULT_HOSTILE_TAG;
  const plan = buildLiveAdminPlan([
    'mcbottest-spawn-zombie-fire-resistant',
    tag,
    String(spawn.x),
    String(spawn.y),
    String(spawn.z),
  ]);
  return { ...plan, spawn, tag };
}

export function buildHostileCleanupPlan(position, radius = 24) {
  const origin = {
    x: roundCoordinate(Number(position.x)),
    y: roundCoordinate(Number(position.y)),
    z: roundCoordinate(Number(position.z)),
  };
  const plan = buildLiveAdminPlan([
    'kill-zombies-near',
    String(origin.x),
    String(origin.y),
    String(origin.z),
    String(radius),
  ]);
  return { ...plan, origin, radius };
}

export function markHostileInduced(report, inductionResult, inducedAt = new Date()) {
  report.hostileFlee.inducedAt = inducedAt.toISOString();
  report.hostileFlee.adminAction = inductionResult.action || 'mcbottest-spawn-zombie-fire-resistant';
  report.hostileFlee.spawn = inductionResult.spawn || null;
  report.hostileFlee.tag = inductionResult.tag || report.hostileFlee.tag || DEFAULT_HOSTILE_TAG;
  report.hostileFlee.progressAtInduction = {
    logs: report.mission?.progress?.maxLogsObserved || 0,
    goal: report.mission?.progress?.goal || 10,
  };
  report.diagnostics.rcon = summarizeAdminResult(inductionResult, {
    action: inductionResult.action || 'mcbottest-spawn-zombie-fire-resistant',
  });
  return report;
}

export function markHostileCleanup(report, cleanupResult, cleanedAt = new Date()) {
  report.hostileFlee.cleanup = {
    requested: true,
    completed: cleanupResult.ok === true,
    at: cleanedAt.toISOString(),
    ...summarizeAdminResult(cleanupResult, {
      action: cleanupResult.action || 'kill-zombies-near',
    }),
  };
  return report;
}

async function runStartupSetup(opts) {
  const results = [];
  if (opts.setupQuietBaseline) {
    const queryResult = await runLiveAdminPlan(buildLiveAdminPlan(['raw', 'difficulty']));
    const originalDifficulty = parseDifficultyFromAdminResult(queryResult);
    if (!originalDifficulty) throw new Error('quiet baseline could not determine original difficulty');
    opts.quietBaselineOriginalDifficulty = originalDifficulty;
    results.push(summarizeAdminResult(queryResult, {
      action: 'query-difficulty',
      originalDifficulty,
    }));
  }
  const plans = buildStartupSetupPlans(opts);
  for (const plan of plans) {
    if (!plan.ok) throw new Error(plan.reason);
    if (plan.action === 'wait') {
      await sleep(plan.waitMs);
      results.push({
        ok: true,
        dryRun: false,
        action: 'wait',
        commandCount: 0,
        waitMs: plan.waitMs,
      });
      continue;
    }
    const result = await runLiveAdminPlan(plan);
    results.push(summarizeAdminResult(result));
  }
  return results;
}

export function buildStartupSetupPlans(opts) {
  const plans = [];
  if (opts.setupQuietBaseline) {
    plans.push(buildLiveAdminPlan(['raw', 'minecraft:difficulty peaceful']));
    plans.push(buildLiveAdminPlan(['raw', 'minecraft:time set day']));
    plans.push(buildLiveAdminPlan(['clear-non-players']));
  }
  if (opts.setupTeleport) {
    const safe = safeTeleportColumn(opts.setupTeleport);
    plans.push(buildLiveAdminPlan([
      'raw',
      `minecraft:forceload add ${safe.x} ${safe.z}`,
    ]));
    plans.push(buildLiveAdminPlan([
      'raw',
      `minecraft:setblock ${safe.x} ${safe.y - 1} ${safe.z} minecraft:grass_block replace`,
    ]));
    plans.push(buildLiveAdminPlan([
      'raw',
      `minecraft:fill ${safe.x} ${safe.y} ${safe.z} ${safe.x} ${safe.y + 1} ${safe.z} minecraft:air replace`,
    ]));
    plans.push(buildLiveAdminPlan([
      'teleport-player',
      'MCBot',
      String(opts.setupTeleport.x),
      String(opts.setupTeleport.y),
      String(opts.setupTeleport.z),
    ]));
    plans.push(buildLiveAdminPlan([
      'raw',
      `minecraft:forceload remove ${safe.x} ${safe.z}`,
    ]));
  }
  if (opts.setupClearAll) {
    plans.push(buildLiveAdminPlan(['raw', 'minecraft:clear MCBot']));
  }
  for (const item of opts.setupClearItems || []) {
    plans.push(buildLiveAdminPlan(['raw', `minecraft:clear MCBot ${item}`]));
  }
  for (const give of opts.setupGives || []) {
    plans.push(buildLiveAdminPlan(['give', 'MCBot', give.item, String(give.count)]));
  }
  for (const block of opts.setupBlocks || []) {
    plans.push(buildLiveAdminPlan([
      'raw',
      `minecraft:setblock ${Math.floor(block.x)} ${Math.floor(block.y)} ${Math.floor(block.z)} ${block.block} replace`,
    ]));
  }
  if (opts.setupQuietBaseline) {
    plans.push(buildLiveAdminPlan(['raw', 'minecraft:effect give MCBot minecraft:instant_health 1 10 true']));
    plans.push(buildLiveAdminPlan(['raw', 'minecraft:effect give MCBot minecraft:saturation 1 10 true']));
  }
  if (opts.setupDamage !== null) {
    if (opts.setupDamageDelayMs > 0) {
      plans.push({
        ok: true,
        action: 'wait',
        waitMs: opts.setupDamageDelayMs,
        commands: [],
      });
    }
    const damageType = opts.setupDamageType ? ` ${opts.setupDamageType}` : '';
    plans.push(buildLiveAdminPlan(['raw', `minecraft:damage MCBot ${opts.setupDamage}${damageType}`]));
  }
  return plans;
}

function safeTeleportColumn(position) {
  return {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z)),
  };
}

export function buildQuietBaselineRestorePlan(opts = {}) {
  const originalDifficulty = safeDifficultyName(opts.originalDifficulty);
  if (!originalDifficulty) return { ok: false, reason: 'original difficulty required for quiet-baseline restore' };
  return buildLiveAdminPlan(['raw', `minecraft:difficulty ${originalDifficulty}`]);
}

export function parseDifficultyFromAdminResult(result = {}) {
  const text = [
    ...(result.responses || []).map((entry) => entry.response),
    ...(result.commands || []),
  ].join('\n');
  const match = String(text).match(/\b(peaceful|easy|normal|hard)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function markStartupSetupComplete(report, results, opts = {}) {
  report.diagnostics.setup.completed = true;
  report.diagnostics.setup.actions = results;
  if (opts.setupQuietBaseline) {
    report.diagnostics.quietBaseline.originalDifficulty = opts.quietBaselineOriginalDifficulty || null;
  }
}

export function finalizeAdvisorLivePlanReport(report, extra = {}) {
  report.endedAt = extra.endedAt || new Date().toISOString();
  if (extra.childExit) report.diagnostics.childExit = extra.childExit;
  if (extra.disconnectReason !== undefined && report.disconnectReason === undefined) {
    report.disconnectReason = normalizeDisconnectReason(extra.disconnectReason);
  }
  if (extra.disconnectedAtMs !== undefined && report.disconnectedAtMs === undefined) {
    report.disconnectedAtMs = finiteNumberOrNull(extra.disconnectedAtMs);
  }
  if (extra.timeout === true) {
    report.diagnostics.timeout = true;
    report.diagnostics.failures.push(`live plan timed out after ${extra.timeoutMs}ms`);
  }
  if (extra.error) report.diagnostics.failures.push(String(extra.error));

  const finalOk = report.finalOutcome.reported === true && report.finalOutcome.ok !== false;
  const acceptedSteps = Number(report.planner.acceptedSteps || report.planner.maxAcceptedSteps || 0);
  const schemaOk = advisorCallsValidated(report);
  const pluginBaseOk = report.plugin?.required === true
    ? Boolean(report.plugin?.started === true
      && report.plugin?.ended === true
      && report.plugin?.finalSnapshot?.ok === true)
    : true;
  const pluginHostileOk = pluginBaseOk && (report.plugin?.required !== true
    || report.plugin?.telemetrySummary?.taggedHostileSpawnCount >= 1);
  const finalLogs = Number(report.mission?.finalInventory?.totalLogs || 0);
  const fullInventoryGoal = finalLogs >= Number(report.mission?.targetLogCount || 10);
  const partialInventoryGoal = finalLogs >= 5;
  const baseCriteriaOk = report.planner.callMade === true
    && report.planner.schemaValid === true
    && schemaOk
    && acceptedSteps >= 1
    && report.activation.accepted === true
    && report.executor.ranSkillCount >= 1
    && report.executor.failedSkillCount === 0
    && report.costCeilingGuard.verified === true
    && report.diagnostics.failures.length === 0;
  const itemGoal = livePlanItemGoal(report.goal);
  const itemGoalResult = evaluateItemGoal(report, itemGoal);
  if (itemGoalResult) report.mission.itemGoal = itemGoalResult;
  if (advisorLivePlanBotDisconnected(report)) {
    report.ok = false;
    report.outcome = 'partial';
    report.status = 'bot_disconnected_during_run';
    finalizeTimingReport(report);
    return report;
  }
  const f2CriteriaOk = baseCriteriaOk
    && report.hostileFlee.transitionObserved === true
    && pluginHostileOk;
  const itemCriteriaOk = baseCriteriaOk
    && itemGoalResult?.met === true
    && pluginBaseOk;
  const genericTerminalCriteriaOk = finalOk
    && !itemGoal
    && report.hostileFlee.inducedAt == null
    && report.planner.callMade === true
    && report.planner.schemaValid === true
    && acceptedSteps >= 1
    && Number(report.planner.lastAcceptedSteps || 0) >= 1
    && report.activation.accepted === true
    && report.executor.ranSkillCount >= 1
    && report.executor.lastSkillResult?.ok === true
    && report.costCeilingGuard.verified === true
    && pluginBaseOk
    && report.diagnostics.timeout !== true
    && report.activation.terminal !== true;

  report.hostileFlee.survived = report.hostileFlee.inducedAt != null
    && report.hostileFlee.transitionObserved === true
    && !report.diagnostics.failures.some((failure) => /critical-health|emergency/i.test(failure));
  const fullOk = genericTerminalCriteriaOk
    || (finalOk && (itemCriteriaOk || (f2CriteriaOk && report.hostileFlee.survived === true && fullInventoryGoal)));
  const partialOk = !fullOk && f2CriteriaOk && report.hostileFlee.survived === true && partialInventoryGoal;
  report.ok = fullOk || partialOk;
  report.outcome = fullOk ? 'success' : partialOk ? 'partial' : 'fail';
  report.status = fullOk ? 'live_plan_completed' : partialOk ? 'live_plan_partial' : 'live_plan_failed';
  finalizeTimingReport(report);
  return report;
}

function livePlanItemGoal(goal) {
  const parsed = parseItemChainGoal(goal);
  if (!parsed) return null;
  return {
    verb: parsed.verb,
    item: parsed.item,
    rawItem: parsed.rawItem,
    count: parsed.count,
  };
}

function evaluateItemGoal(report, itemGoal) {
  if (!itemGoal?.item) return null;
  const counts = report.mission?.finalInventory?.counts || {};
  const have = Number(counts[itemGoal.item] || 0);
  return {
    ...itemGoal,
    have,
    met: have >= Number(itemGoal.count || 1),
  };
}

export async function runAdvisorLivePlan(runConfig) {
  const report = createAdvisorLivePlanReport(runConfig);
  const writeReport = () => writeAdvisorLivePlanReports(runConfig.options.reportPath, report);

  try {
    await startPluginTelemetry(report);
    writeReport();
  } catch (err) {
    report.plugin.errors.push(err?.message || String(err));
    report.diagnostics.failures.push(`plugin telemetry start failed: ${err?.message || err}`);
    finalizeAdvisorLivePlanReport(report, { error: 'plugin telemetry start failed' });
    writeReport();
    return report;
  }

  const child = spawn(runConfig.command.executable, runConfig.command.args, {
    cwd: runConfig.command.cwd,
    env: runConfig.command.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let finalLogSeen = false;
  let timeout = false;
  let inductionDone = false;
  let inductionError = null;
  let positionWaitStarted = 0;
  let inductionEligibleAt = null;
  let setupStarted = false;
  let setupDone = !hasStartupSetup(runConfig.options);
  let setupError = null;
  let cleanupStarted = false;
  let cleanupDone = runConfig.options.hostileCleanupAfterFleeMs <= 0;
  let cleanupError = null;
  let finalStopStarted = false;
  let botDisconnectStopStarted = false;
  let finalSnapshotPromise = null;
  let finalStopWatchdog = null;

  const finish = (childExit = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    clearInterval(inductionPoll);
    clearInterval(setupPoll);
    clearInterval(cleanupPoll);
    finalizeAdvisorLivePlanReport(report, {
      childExit,
      timeout,
      timeoutMs: runConfig.options.timeoutMs,
      error: inductionError || setupError || cleanupError,
    });
    writeReport();
  };

  const scheduleFinalStop = (reason) => {
    if (finalStopStarted) return;
    finalStopStarted = true;
    finalStopWatchdog = armFinalOutcomeStopWatchdog({
      report,
      child,
      reason,
      writeReport,
      shouldSkip: () => settled,
    });
    finalSnapshotPromise = sleep(DEFAULT_FINAL_SNAPSHOT_SETTLE_MS)
      .then(() => snapshotPluginTelemetry(report, 'final'))
      .catch((err) => {
        const message = err?.message || String(err);
        report.plugin.errors.push(message);
        report.diagnostics.failures.push(`plugin final snapshot failed: ${message}`);
      })
      .finally(() => {
        finalStopWatchdog?.clear();
        writeReport();
        const stopTimer = setTimeout(() => stopChild(child, reason), 250);
        stopTimer.unref?.();
      });
  };

  const scheduleBotDisconnectStop = (record) => {
    if (botDisconnectStopStarted) return;
    botDisconnectStopStarted = true;
    emitReporterEvent('advisor-live-plan.bot-disconnected', {
      reason: report.disconnectReason || disconnectReasonFromRecord(record),
      disconnectedAtMs: report.disconnectedAtMs,
    });
    writeReport();
    stopChild(child, 'bot-disconnected-during-run', {
      termAfterMs: BOT_DISCONNECT_STOP_TERM_MS,
      killAfterMs: BOT_DISCONNECT_STOP_KILL_MS,
    });
  };

  const onReportRecord = (record) => {
    const evt = record?.evt;
    if (isAdvisorLivePlanBotDisconnectRecord(record)) {
      scheduleBotDisconnectStop(record);
      return;
    }
    if (advisorLivePlanBotDisconnected(report)) return;
    if (evt === 'goal.plan-activation-rejected') {
      maybeScheduleTerminalActivationRejectionStop(record, report, scheduleFinalStop);
      return;
    }
    if (evt === 'main.goal-done' || evt === 'main.goal-failed' || evt === 'main.exception') {
      finalLogSeen = true;
      scheduleFinalStop('advisor-live-plan-final-outcome');
    }
  };

  attachLogParser(child.stdout, process.stdout, report, onReportRecord);
  attachLogParser(child.stderr, process.stderr, report, onReportRecord);

  const timeoutTimer = setTimeout(() => {
    timeout = true;
    stopChild(child, 'advisor-live-plan-timeout');
  }, runConfig.options.timeoutMs);

  const inductionPoll = setInterval(async () => {
    if (inductionDone || settled || advisorLivePlanBotDisconnected(report)) return;
    if (!setupDone) return;
    if (!report.hostileFlee.eligibleAt) return;
    if (!inductionEligibleAt) inductionEligibleAt = Date.parse(report.hostileFlee.eligibleAt);
    const elapsed = Date.now() - inductionEligibleAt;
    if (elapsed < runConfig.options.induceAfterMs) return;
    const logsObserved = Number(report.mission?.progress?.maxLogsObserved || 0);
    if (logsObserved < 1) return;
    if (logsObserved >= 6) {
      inductionDone = true;
      inductionError = `missed hostile induction window; observed ${logsObserved} logs before tagged hostile spawn`;
      stopChild(child, inductionError);
      return;
    }
    if (!report.diagnostics.latestPosition) {
      if (!positionWaitStarted) positionWaitStarted = Date.now();
      if (Date.now() - positionWaitStarted <= runConfig.options.positionWaitMs) return;
      inductionDone = true;
      inductionError = 'no bot position observed before hostile induction';
      stopChild(child, inductionError);
      return;
    }
    inductionDone = true;
    const plan = buildHostileInductionPlan(report.diagnostics.latestPosition, runConfig.options.hostileOffset);
    if (!plan.ok) {
      inductionError = plan.reason;
      stopChild(child, inductionError);
      return;
    }
    try {
      emitReporterEvent('advisor-live-plan.hostile-induction.start', { action: plan.action, spawn: plan.spawn });
      const result = await runLiveAdminPlan(plan);
      markHostileInduced(report, { ...result, spawn: plan.spawn, tag: plan.tag }, new Date());
      emitReporterEvent('advisor-live-plan.hostile-induction.done', report.diagnostics.rcon);
      writeReport();
    } catch (err) {
      inductionError = err?.message || String(err);
      emitReporterEvent('advisor-live-plan.hostile-induction.failed', { reason: inductionError });
      stopChild(child, inductionError);
    }
  }, 500);

  const setupPoll = setInterval(async () => {
    if (setupDone || setupStarted || settled || advisorLivePlanBotDisconnected(report)) return;
    if (!report.diagnostics.logEvents['main.spawned']) return;
    setupStarted = true;
    try {
      emitReporterEvent('advisor-live-plan.startup-setup.start', {});
      const result = await runStartupSetup(runConfig.options);
      markStartupSetupComplete(report, result, runConfig.options);
      setupDone = true;
      emitReporterEvent('advisor-live-plan.startup-setup.done', report.diagnostics.setup);
      writeReport();
    } catch (err) {
      setupError = err?.message || String(err);
      report.diagnostics.setup.completed = false;
      report.diagnostics.setup.error = setupError;
      emitReporterEvent('advisor-live-plan.startup-setup.failed', { reason: setupError });
      stopChild(child, setupError);
    }
  }, 100);

  const cleanupPoll = setInterval(async () => {
    if (cleanupDone || cleanupStarted || settled || advisorLivePlanBotDisconnected(report)) return;
    if (!report.hostileFlee.transitionObserved || !report.hostileFlee.transitionObservedAt) return;
    const transitionAt = Date.parse(report.hostileFlee.transitionObservedAt);
    if (!Number.isFinite(transitionAt)) return;
    if (Date.now() - transitionAt < runConfig.options.hostileCleanupAfterFleeMs) return;
    const spawn = report.hostileFlee.spawn;
    if (!spawn) {
      cleanupStarted = true;
      cleanupError = 'no induced hostile spawn recorded before cleanup';
      stopChild(child, cleanupError);
      return;
    }
    cleanupStarted = true;
    const plan = buildHostileCleanupPlan(spawn, runConfig.options.hostileCleanupRadius);
    if (!plan.ok) {
      cleanupError = plan.reason;
      stopChild(child, cleanupError);
      return;
    }
    try {
      emitReporterEvent('advisor-live-plan.hostile-cleanup.start', {
        action: plan.action,
        origin: plan.origin,
        radius: plan.radius,
      });
      const result = await runLiveAdminPlan(plan);
      markHostileCleanup(report, result, new Date());
      cleanupDone = true;
      emitReporterEvent('advisor-live-plan.hostile-cleanup.done', report.hostileFlee.cleanup);
      writeReport();
    } catch (err) {
      cleanupError = err?.message || String(err);
      report.hostileFlee.cleanup.error = cleanupError;
      emitReporterEvent('advisor-live-plan.hostile-cleanup.failed', { reason: cleanupError });
      stopChild(child, cleanupError);
    }
  }, 250);

  child.on('exit', (code, signal) => finish({ code, signal }));
  child.on('error', (err) => {
    inductionError = err?.message || String(err);
    finish({ code: null, signal: null, error: inductionError });
  });

  return new Promise((resolve) => {
    child.on('close', async () => {
      if (finalSnapshotPromise) await waitForFinalSnapshotClose(finalSnapshotPromise, report);
      if (!settled) finish({ code: child.exitCode, signal: child.signalCode });
      if (!finalLogSeen && !timeout && !advisorLivePlanBotDisconnected(report) && report.finalOutcome.reported !== true) {
        report.diagnostics.failures.push('child exited before final outcome log');
        finalizeAdvisorLivePlanReport(report, { childExit: report.diagnostics.childExit });
        writeReport();
      }
      await finishPluginTelemetry(report);
      await restoreQuietBaseline(report, runConfig.options);
      finalizeAdvisorLivePlanReport(report, { childExit: report.diagnostics.childExit });
      writeReport();
      resolve(report);
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const runConfig = buildAdvisorLivePlanConfig({ argv });
  if (!runConfig.ok) {
    if (runConfig.help) {
      console.log(runConfig.reason);
      return 0;
    }
    console.error(runConfig.reason);
    return 1;
  }

  if (runConfig.options.dryRun) {
    const report = createAdvisorLivePlanReport(runConfig);
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      command: ['node', ...runConfig.command.args].join(' '),
      reportPath: runConfig.options.reportPath,
      report,
    }, null, 2));
    return 0;
  }

  const report = await runAdvisorLivePlan(runConfig);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    reportPath: runConfig.options.reportPath,
  }, null, 2));
  return report.ok ? 0 : 1;
}

function attachLogParser(readable, passthrough, report, onRecord = null) {
  let buffer = '';
  readable.on('data', (chunk) => {
    const text = String(chunk);
    passthrough.write(text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const record = parseJsonLogLine(line);
      if (record) {
        updateAdvisorLivePlanReportFromRecord(report, record);
        onRecord?.(record);
      }
    }
  });
  readable.on('end', () => {
    const record = parseJsonLogLine(buffer);
    if (record) {
      updateAdvisorLivePlanReportFromRecord(report, record);
      onRecord?.(record);
    }
  });
}

function parseJsonLogLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isAdvisorLivePlanBotDisconnectRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.loop !== 'bot') return false;
  return record.evt === 'end' || record.evt === 'kicked' || record.evt === 'error';
}

export function markAdvisorLivePlanBotDisconnected(report, record = {}, nowMs = Date.now()) {
  if (!report || typeof report !== 'object') return report;
  if (report.disconnectReason !== undefined && report.disconnectedAtMs !== undefined) return report;
  report.disconnectReason = disconnectReasonFromRecord(record);
  report.disconnectedAtMs = finiteNumberOrNull(nowMs) ?? Date.now();
  return report;
}

function advisorLivePlanBotDisconnected(report) {
  return report?.disconnectReason !== undefined || report?.disconnectedAtMs !== undefined;
}

function disconnectReasonFromRecord(record = {}) {
  if (record.evt === 'kicked') return normalizeDisconnectReason(record.reason || 'bot kicked');
  if (record.evt === 'error') return normalizeDisconnectReason(record.err || record.reason || 'bot error');
  return normalizeDisconnectReason(record.reason || 'unknown disconnect');
}

function normalizeDisconnectReason(value) {
  const text = String(value ?? '').trim();
  return text || 'unknown disconnect';
}

function addExecutedSkill(report, skill) {
  if (!skill) return;
  if (!report.executor.skillsExecuted.includes(skill)) {
    report.executor.skillsExecuted.push(skill);
  }
  report.executor.ranSkillCount = report.executor.skillsExecuted.length;
}

function updateTimingFromRecord(report, record) {
  const timing = ensureTimingReport(report);
  const state = timing._state;
  const atMs = recordTimeMs(record);
  const evt = record.evt || 'unknown';

  if (evt === 'goal.plan-activation-ok') {
    state.lastActivationAtMs = atMs;
  } else if (evt === 'enqueue') {
    state.lastEnqueueAtMs = atMs;
  } else if (evt === 'resume.wait') {
    state.resumeWaitStartedAtMs = atMs;
  } else if (evt === 'resume.ready') {
    const dtMs = finiteDuration(record.dtMs, diffMs(state.resumeWaitStartedAtMs, atMs));
    timing.pathfinderSettle.push({
      at: record.t || null,
      dtMs,
      blockedMs: finiteNumberOrNull(record.blockedMs),
      fastPath: record.fastPath === true,
    });
    state.resumeWaitStartedAtMs = null;
  } else if (evt === 'skill.invoke') {
    const source = state.lastSkillResultAtMs != null
      ? { kind: 'previous_skill_result', atMs: state.lastSkillResultAtMs }
      : state.lastActivationAtMs != null
        ? { kind: 'activation', atMs: state.lastActivationAtMs }
        : state.lastEnqueueAtMs != null
          ? { kind: 'enqueue', atMs: state.lastEnqueueAtMs }
          : null;
    if (source && atMs != null) {
      timing.queueHandoff.push({
        at: record.t || null,
        skill: record.skill || null,
        source: source.kind,
        dtMs: diffMs(source.atMs, atMs),
        queueLeft: finiteNumberOrNull(record.queueLeft),
        attempt: finiteNumberOrNull(record.attempt),
      });
    }
    state.lastSkillInvokeAtMs = atMs;
  } else if (evt === 'skill.result' || evt === 'skill.preempted') {
    const dtMs = finiteDuration(record.dtMs, diffMs(state.lastSkillInvokeAtMs, atMs));
    timing.skillRuntime.push({
      at: record.t || null,
      skill: record.skill || null,
      ok: typeof record.ok === 'boolean' ? record.ok : null,
      preempted: evt === 'skill.preempted',
      dtMs,
      reason: record.reason || null,
    });
    if (evt === 'skill.result') state.lastSkillResultAtMs = atMs;
  } else if (evt === 'collect.inventory-wait' || evt === 'collect.post-pickup-wait') {
    timing.pickupWait.push({
      at: record.t || null,
      phase: evt === 'collect.post-pickup-wait' ? 'post_pickup' : 'initial_inventory_delta',
      mode: record.mode || null,
      waitedMs: finiteNumberOrNull(record.waitedMs),
      maxMs: finiteNumberOrNull(record.maxMs),
      delta: finiteNumberOrNull(record.delta),
    });
  }
}

function ensureTimingReport(report) {
  if (!report.timing || typeof report.timing !== 'object') {
    report.timing = {};
  }
  for (const key of ['queueHandoff', 'skillRuntime', 'pathfinderSettle', 'pickupWait']) {
    if (!Array.isArray(report.timing[key])) report.timing[key] = [];
  }
  if (!report.timing.summary || typeof report.timing.summary !== 'object') report.timing.summary = {};
  if (!report.timing._state || typeof report.timing._state !== 'object') report.timing._state = {};
  return report.timing;
}

function finalizeTimingReport(report) {
  const timing = ensureTimingReport(report);
  timing.summary = {
    queueHandoffCount: timing.queueHandoff.length,
    maxQueueHandoffMs: maxDuration(timing.queueHandoff, 'dtMs'),
    totalSkillRuntimeMs: sumDuration(timing.skillRuntime, 'dtMs'),
    maxSkillRuntimeMs: maxDuration(timing.skillRuntime, 'dtMs'),
    pathfinderSettleCount: timing.pathfinderSettle.length,
    totalPathfinderSettleMs: sumDuration(timing.pathfinderSettle, 'dtMs'),
    maxPathfinderSettleMs: maxDuration(timing.pathfinderSettle, 'dtMs'),
    pickupWaitCount: timing.pickupWait.length,
    totalPickupWaitMs: sumDuration(timing.pickupWait, 'waitedMs'),
    maxPickupWaitMs: maxDuration(timing.pickupWait, 'waitedMs'),
  };
  delete timing._state;
}

function updateLatestAdvisorCallMetrics(report, record) {
  const call = latestAdvisorCall(report);
  if (!call) return;
  call.respondedAt = record.t || new Date().toISOString();
  call.provider = record.provider || call.provider || 'deepseek';
  call.model = record.model || call.model;
  call.latencyMs = finiteNumberOrNull(record.dtMs);
  call.inputTokens = finiteNumberOrNull(record.promptTokens ?? record.inputTokens);
  call.outputTokens = finiteNumberOrNull(record.completionTokens ?? record.outputTokens);
  call.totalTokens = finiteNumberOrNull(record.totalTokens);
  call.usd = finiteNumberOrNull(record.callCostUsd);
  call.sessionCostUsd = finiteNumberOrNull(record.sessionCostUsd);
  call.costCeilingUsd = finiteNumberOrNull(record.costCeilingUsd);
  call.costCeilingStatus = record.costCeilingStatus || call.costCeilingStatus || null;
  if ('finishReason' in record || 'finish_reason' in record) {
    call.finishReason = record.finishReason || record.finish_reason || null;
  }
  if ('chars' in record) {
    call.chars = finiteNumberOrNull(record.chars);
  }
  if ('maxTokens' in record || 'max_tokens' in record) {
    call.maxTokens = finiteNumberOrNull(record.maxTokens ?? record.max_tokens);
  }
  call.maxTokensHit = Boolean(
    call.finishReason === 'length'
    && call.outputTokens !== null
    && call.maxTokens !== null
    && call.maxTokens !== undefined
    && call.outputTokens >= call.maxTokens,
  );
}

function markLatestAdvisorCallAccepted(report, record) {
  const call = latestAdvisorCall(report);
  if (!call) return;
  call.schemaValidation = 'accepted';
  call.acceptedAt = record.t || new Date().toISOString();
  call.acceptedSteps = Number(record.steps || 0);
}

function markLatestAdvisorCallRejected(report, record) {
  const call = latestAdvisorCall(report);
  if (call) {
    call.schemaValidation = 'rejected';
    call.rejectedAt = record.t || new Date().toISOString();
    call.rejectionStage = record.evt;
    call.rejectionReason = record.reason || 'advisor response rejected';
  }
  report.diagnostics.failures.push(`advisor response failed validation: ${record.reason || record.evt}`);
}

export function classifyPlanActivationRejection(record = {}) {
  if (record?.evt && record.evt !== 'goal.plan-activation-rejected') {
    return { terminal: false, kind: 'not_activation_rejection', reason: '' };
  }
  const reason = String(record?.reason || '');
  const staleReasons = Array.isArray(record?.staleReasons) ? record.staleReasons : [];
  const safetyReasons = Array.isArray(record?.safetyReasons) ? record.safetyReasons : [];
  if (/stale plan activation/i.test(reason) || staleReasons.length > 0) {
    return { terminal: false, kind: 'transient_stale', reason };
  }
  if (/requires a progress-capable skill\b.*rejected no-op plan/i.test(reason)
    || /rejected no-op plan/i.test(reason)
    || /\bno-op plan\b/i.test(reason)) {
    return { terminal: true, kind: 'no_op_progress_plan', reason };
  }
  if (/(?:can't|cannot) be repaired|unrepairable|terminal activation/i.test(reason)) {
    return { terminal: true, kind: 'explicit_terminal', reason };
  }
  if (/unsafe snapshot permits only/i.test(reason) || safetyReasons.length > 0) {
    return { terminal: false, kind: 'transient_safety', reason };
  }
  return { terminal: false, kind: 'unknown_activation_rejection', reason };
}

function markTerminalPlanActivationRejection(report, record, classification = classifyPlanActivationRejection(record)) {
  const reason = classification.reason || record?.reason || 'plan activation rejected';
  const summary = `terminal plan activation rejection: ${reason}`;
  if (report?.finalOutcome?.reported !== true) {
    report.finalOutcome = {
      reported: true,
      summary,
      ok: false,
      terminalActivationRejection: true,
    };
  }
  if (report?.diagnostics) {
    report.diagnostics.terminalActivationRejection = {
      kind: classification.kind,
      reason,
      at: record?.t || new Date().toISOString(),
    };
    if (!report.diagnostics.failures.includes(summary)) {
      report.diagnostics.failures.push(summary);
    }
  }
  return report;
}

export function maybeScheduleTerminalActivationRejectionStop(record, report, scheduleFinalStop = null) {
  const classification = classifyPlanActivationRejection(record);
  if (classification.terminal !== true) return false;
  markTerminalPlanActivationRejection(report, record, classification);
  if (typeof scheduleFinalStop === 'function') {
    scheduleFinalStop('advisor-live-plan-terminal-activation-rejection');
  }
  return true;
}

function latestAdvisorCall(report) {
  const calls = report.advisorCalls || [];
  return calls[calls.length - 1] || null;
}

function advisorCallsValidated(report) {
  const calls = report.advisorCalls || [];
  return calls.length > 0 && calls.every((call) => call.schemaValidation === 'accepted');
}

function updateWoodTargetsFromPlan(report, plan = []) {
  const targets = [];
  for (const call of Array.isArray(plan) ? plan : []) {
    if (call?.skill !== 'collect') continue;
    const block = normalizeItemName(call.params?.block);
    if (isLogItem(block)) targets.push(block);
  }
  if (targets.length === 0) return;
  for (const target of targets) {
    if (!report.mission.woodTargets.includes(target)) report.mission.woodTargets.push(target);
  }
  if (report.planner.acceptedPlanCount > 1) {
    report.mission.retargets.push({
      atAcceptedPlan: report.planner.acceptedPlanCount,
      targets,
    });
  }
}

function updateMissionProgress(report, sofar, goal) {
  const count = Number(sofar);
  if (!Number.isFinite(count)) return;
  report.mission.progress.latestLogsObserved = count;
  report.mission.progress.maxLogsObserved = Math.max(report.mission.progress.maxLogsObserved || 0, count);
  if (Number.isFinite(Number(goal))) report.mission.progress.goal = Number(goal);
}

function updateMissionProgressFromSkillResult(report, record) {
  const match = /^collected\s+(\d+)\s+([a-z0-9_:.-]+)$/i.exec(String(record.reason || ''));
  if (!match) return;
  const item = normalizeItemName(match[2]);
  if (!isLogItem(item)) return;
  updateMissionProgress(report, Number(match[1]), report.mission.progress.goal || 10);
}

function recordSkillFailure(report, skill, reason) {
  report.executor.failedSkillCount = Number(report.executor.failedSkillCount || 0) + 1;
  const label = skill ? `${skill}: ${reason}` : reason;
  report.diagnostics.failures.push(`skill failure: ${label}`);
}

function updateHostileFleeFromTransition(report, record) {
  if (record.to === 'FLEEING' && record.reason === 'hostile-flee') {
    const inducedAt = Date.parse(report.hostileFlee.inducedAt || '');
    const recordAt = Date.parse(record.t || '');
    if (!Number.isFinite(inducedAt) || !Number.isFinite(recordAt) || recordAt >= inducedAt) {
      report.hostileFlee.transitionObserved = true;
      report.hostileFlee.transitionObservedAt = record.t || new Date().toISOString();
      report.hostileFlee.entity = record.entity || report.hostileFlee.entity;
      report.hostileFlee.distance = record.dist ?? report.hostileFlee.distance;
      report.hostileFlee.eventCount = Number(report.hostileFlee.eventCount || 0) + 1;
      report.hostileFlee.progressAtTransition = {
        logs: report.mission?.progress?.maxLogsObserved || 0,
        goal: report.mission?.progress?.goal || 10,
      };
    }
  }
  if (record.to === 'NORMAL' && report.hostileFlee.transitionObserved === true) {
    report.hostileFlee.returnedNormal = true;
  }
}

async function startPluginTelemetry(report) {
  const result = await runHarnessCommands([`mcbottest start ${DEFAULT_PLUGIN_SCENARIO_ID}`]);
  const response = result.responses?.[0]?.response || '';
  const parsed = parseStartResponse(response);
  if (!parsed.token || !parsed.telemetryPath) {
    throw new Error(`failed to parse /mcbottest start response: ${response}`);
  }
  report.plugin.started = true;
  report.plugin.token = parsed.token;
  report.plugin.telemetryPath = parsed.telemetryPath;
  report.plugin.startResponse = summarizeRconResponses(result.responses);
}

async function snapshotPluginTelemetry(report, label) {
  if (!report.plugin?.token) throw new Error('plugin scenario token missing');
  const result = await runHarnessCommands([`mcbottest snapshot ${report.plugin.token}`]);
  report.plugin.finalSnapshot = {
    ok: true,
    label,
    at: new Date().toISOString(),
    responses: summarizeRconResponses(result.responses),
  };
}

async function finishPluginTelemetry(report) {
  if (!report.plugin?.token) return;
  if (!report.plugin.ended) {
    try {
      const result = await runHarnessCommands([`mcbottest end ${report.plugin.token}`]);
      report.plugin.ended = true;
      report.plugin.endResponse = summarizeRconResponses(result.responses);
    } catch (err) {
      const message = err?.message || String(err);
      report.plugin.errors.push(message);
      report.diagnostics.failures.push(`plugin telemetry end failed: ${message}`);
    }
  }
  const events = report.plugin.telemetryPath ? readTelemetry(report.plugin.telemetryPath) : [];
  report.plugin.telemetrySummary = summarizeTelemetry(events);
  applyFinalInventoryFromTelemetry(report, events);
  report.hostileFlee.taggedSpawnTelemetryCount = report.plugin.telemetrySummary.taggedHostileSpawnCount || 0;
  report.hostileFlee.taggedHostileTags = report.plugin.telemetrySummary.taggedHostileTags || [];
}

async function runHarnessCommands(commands) {
  const rcon = rconConfigFromEnv(process.env);
  const responses = await sendRconCommands({ ...rcon, commands });
  return { ok: true, responses };
}

function applyFinalInventoryFromTelemetry(report, events = []) {
  const snapshots = events.filter((event) => event.event === 'snapshot' && event.inventory);
  const final = snapshots[snapshots.length - 1];
  if (!final) return;
  const counts = inventoryCountsFromSnapshot(final.inventory);
  const logCounts = {};
  for (const [name, count] of Object.entries(counts)) {
    const item = normalizeItemName(name);
    if (isLogItem(item)) logCounts[item] = (logCounts[item] || 0) + count;
  }
  const totalLogs = Object.values(logCounts).reduce((sum, count) => sum + count, 0);
  report.mission.finalInventory = {
    captured: true,
    counts,
    logCounts,
    totalLogs,
    meetsGoal: totalLogs >= Number(report.mission.targetLogCount || 10),
    partialGoal: totalLogs >= 5,
    snapshotAt: final.time || final.t || null,
    position: final.position || null,
  };
}

function inventoryCountsFromSnapshot(inventory = {}) {
  const counts = {};
  for (const value of Object.values(inventory || {})) {
    if (!value || typeof value !== 'object') continue;
    const item = normalizeItemName(value.item);
    const count = Number(value.count || 0);
    if (!item || !Number.isFinite(count) || count <= 0) continue;
    counts[item] = (counts[item] || 0) + count;
  }
  return counts;
}

function normalizeItemName(name) {
  return String(name || '').replace(/^minecraft:/, '');
}

function isLogItem(name) {
  return LOG_ITEM_NAMES.includes(normalizeItemName(name));
}

function markHostileInductionEligible(report, record) {
  if (report.hostileFlee.eligibleAt) return;
  report.hostileFlee.eligibleAt = record?.t || new Date().toISOString();
}

function positionFromRecord(record) {
  const candidates = [
    record.position,
    record.botPos,
    record.snapshot?.position,
  ];
  for (const candidate of candidates) {
    if (candidate && finitePosition(candidate)) {
      return {
        x: Number(candidate.x),
        y: Number(candidate.y),
        z: Number(candidate.z),
        ...(candidate.dimension ? { dimension: candidate.dimension } : {}),
      };
    }
  }
  return null;
}

function finitePosition(value) {
  return Number.isFinite(Number(value.x))
    && Number.isFinite(Number(value.y))
    && Number.isFinite(Number(value.z));
}

function numericCost(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function recordTimeMs(record) {
  if (!record?.t) return null;
  const ms = Date.parse(record.t);
  return Number.isFinite(ms) ? ms : null;
}

function diffMs(startMs, endMs) {
  if (!Number.isFinite(Number(startMs)) || !Number.isFinite(Number(endMs))) return null;
  return Math.max(0, Math.round(Number(endMs) - Number(startMs)));
}

function finiteDuration(value, fallback = null) {
  const number = Number(value);
  if (Number.isFinite(number)) return Math.max(0, Math.round(number));
  return Number.isFinite(Number(fallback)) ? Math.max(0, Math.round(Number(fallback))) : null;
}

function sumDuration(entries, field) {
  return (entries || []).reduce((sum, entry) => {
    const value = Number(entry?.[field]);
    return Number.isFinite(value) ? sum + Math.max(0, Math.round(value)) : sum;
  }, 0);
}

function maxDuration(entries, field) {
  let max = 0;
  for (const entry of entries || []) {
    const value = Number(entry?.[field]);
    if (Number.isFinite(value)) max = Math.max(max, Math.max(0, Math.round(value)));
  }
  return max;
}

function summarizeAdminResult(result, extra = {}) {
  return {
    ok: result.ok === true,
    dryRun: result.dryRun === true,
    action: result.action,
    commandCount: result.commandCount ?? result.commands?.length ?? null,
    ...extra,
    ...(result.responses ? { responses: summarizeRconResponses(result.responses) } : {}),
  };
}

function summarizeRconResponses(responses) {
  return (responses || []).map((entry) => ({
    command: entry.command,
    response: sanitizeRconResponse(entry.response),
    type: entry.type,
  }));
}

function sanitizeRconResponse(value) {
  return String(value || '')
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .slice(0, 500);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeAdvisorLivePlanReports(reportPath, report) {
  writeJson(reportPath, report);
  fs.writeFileSync(markdownPathFor(reportPath), renderAdvisorLivePlanMarkdown(report), 'utf8');
}

function markdownPathFor(reportPath) {
  return reportPath.replace(/\.json$/i, '.md');
}

export function renderAdvisorLivePlanMarkdown(report) {
  const calls = report.advisorCalls || [];
  const callRows = calls.length
    ? calls.map((call) => `| ${call.index} | ${call.model || ''} | ${call.latencyMs ?? ''} | ${call.inputTokens ?? ''} | ${call.outputTokens ?? ''} | ${call.usd ?? ''} | ${call.schemaValidation || ''} |`).join('\n')
    : '| none |  |  |  |  |  |  |';
  const finalInventory = report.mission?.finalInventory || {};
  const itemGoal = report.mission?.itemGoal || null;
  const logCounts = Object.entries(finalInventory.logCounts || {})
    .map(([name, count]) => `${name}:${count}`)
    .join(', ') || 'none';
  const telemetry = report.plugin?.telemetrySummary || {};
  const timing = report.timing?.summary || {};
  return `${[
    '# Advisor Live Plan',
    '',
    `- status: ${report.status}`,
    `- outcome: ${report.outcome}`,
    `- goal: ${report.goal}`,
    `- attempts made: ${report.attemptsMade}`,
    `- account: ${report.account?.username || ''} (${report.account?.auth || ''})`,
    `- wood targets: ${(report.mission?.woodTargets || []).join(', ') || 'none'}`,
    `- retargets: ${(report.mission?.retargets || []).length}`,
    `- final logs: ${finalInventory.totalLogs || 0}/${report.mission?.targetLogCount || 10}`,
    `- final log counts: ${logCounts}`,
    `- item goal: ${itemGoal ? `${itemGoal.item} ${itemGoal.have}/${itemGoal.count} met=${itemGoal.met === true}` : 'none'}`,
    `- advisor model lock: ${report.diagnostics?.advisorModel?.childEnv || report.diagnostics?.advisorModel?.required || 'unknown'}`,
    `- advisor model override: ${report.diagnostics?.advisorModel?.overridden === true}`,
    `- cost usd: ${report.cost?.usd ?? 0}`,
    `- cost ceiling verified: ${report.costCeilingGuard?.verified === true}`,
    ...(report.disconnectReason !== undefined ? [
      `- disconnect reason: ${report.disconnectReason}`,
      `- disconnected at ms: ${report.disconnectedAtMs}`,
    ] : []),
    `- timing: skillRuntime=${timing.totalSkillRuntimeMs ?? 0}ms, pathfinderSettle=${timing.totalPathfinderSettleMs ?? 0}ms, pickupWait=${timing.totalPickupWaitMs ?? 0}ms`,
    `- hostile flee survived: ${report.hostileFlee?.survived === true}`,
    `- hostile flee events: ${report.hostileFlee?.eventCount || 0}`,
    `- tagged hostile spawns: ${telemetry.taggedHostileSpawnCount || 0}`,
    `- plugin telemetry: ${report.plugin?.telemetryPath || 'none'}`,
    '',
    '## Advisor Calls',
    '',
    '| # | Model | Latency ms | Input tokens | Output tokens | USD | Schema |',
    '| ---: | --- | ---: | ---: | ---: | ---: | --- |',
    callRows,
    '',
    '## Hostile Flee',
    '',
    `- induced at: ${report.hostileFlee?.inducedAt || 'none'}`,
    `- transition at: ${report.hostileFlee?.transitionObservedAt || 'none'}`,
    `- progress at induction: ${report.hostileFlee?.progressAtInduction?.logs ?? 'unknown'}/${report.hostileFlee?.progressAtInduction?.goal ?? 'unknown'}`,
    `- progress at transition: ${report.hostileFlee?.progressAtTransition?.logs ?? 'unknown'}/${report.hostileFlee?.progressAtTransition?.goal ?? 'unknown'}`,
    `- returned normal: ${report.hostileFlee?.returnedNormal === true}`,
    '',
    '## Validation',
    '',
    `- planner call made: ${report.planner?.callMade === true}`,
    `- schema valid: ${report.planner?.schemaValid === true}`,
    `- activation accepted: ${report.activation?.accepted === true}`,
    `- executor failed skill count: ${report.executor?.failedSkillCount ?? 0}`,
    `- failures: ${(report.diagnostics?.failures || []).join('; ') || 'none'}`,
    '',
  ].join('\n')}\n`;
}

function emitReporterEvent(evt, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    t: new Date().toISOString(),
    lvl: 'info',
    loop: 'test',
    evt,
    ...fields,
  })}\n`);
}

export function armFinalOutcomeStopWatchdog({
  report,
  child,
  reason,
  writeReport = () => {},
  stopChildFn = stopChild,
  timeoutMs = DEFAULT_FINAL_OUTCOME_STOP_GRACE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => new Date(),
  shouldSkip = () => false,
} = {}) {
  let fired = false;
  let cleared = false;
  const timer = setTimeoutFn(() => {
    if (cleared || fired || shouldSkip()) return;
    fired = true;
    markFinalOutcomeStopWatchdog(report, reason, timeoutMs, now());
    writeReport();
    stopChildFn(child, `${reason}-watchdog`);
  }, timeoutMs);
  timer?.unref?.();
  return {
    get fired() {
      return fired;
    },
    clear() {
      if (cleared || fired) return;
      cleared = true;
      clearTimeoutFn(timer);
    },
  };
}

export function markFinalOutcomeStopWatchdog(report, reason, timeoutMs, now = new Date()) {
  const at = now?.toISOString ? now.toISOString() : new Date().toISOString();
  const diagnostic = {
    triggered: true,
    reason,
    timeoutMs,
    at,
  };
  const message = `final outcome stop watchdog fired after ${timeoutMs}ms for ${reason}`;
  if (report?.diagnostics) {
    report.diagnostics.finalOutcomeStopWatchdog = diagnostic;
    report.diagnostics.failures.push(message);
  }
  if (report?.plugin) report.plugin.errors.push(message);
  emitReporterEvent('advisor-live-plan.final-stop-watchdog', diagnostic);
  return diagnostic;
}

async function waitForFinalSnapshotClose(promise, report) {
  let timeoutId = null;
  const result = await Promise.race([
    promise.then(() => 'settled'),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), DEFAULT_FINAL_SNAPSHOT_CLOSE_WAIT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (result !== 'timeout') return;
  const diagnostic = {
    timedOut: true,
    timeoutMs: DEFAULT_FINAL_SNAPSHOT_CLOSE_WAIT_MS,
    at: new Date().toISOString(),
  };
  report.diagnostics.finalSnapshotCloseWait = diagnostic;
  report.diagnostics.failures.push(
    `final plugin snapshot still pending ${DEFAULT_FINAL_SNAPSHOT_CLOSE_WAIT_MS}ms after child close`,
  );
}

function stopChild(child, reason, opts = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const termAfterMs = finiteDuration(opts.termAfterMs, 5000);
  const killAfterMs = finiteDuration(opts.killAfterMs, 10000);
  emitReporterEvent('advisor-live-plan.stop-child', { reason });
  child.kill('SIGINT');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }, termAfterMs).unref?.();
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, killAfterMs).unref?.();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function finiteNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${flag} must be finite`);
  return number;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be positive`);
  return number;
}

function nonEmptyString(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeItemName(value) {
  const item = String(value || '');
  if (!/^[a-z0-9_.:-]+$/.test(item)) throw new Error('--setup-clear-item requires an item id like minecraft:oak_log');
  return item;
}

function safeBlockName(value) {
  const block = String(value || '');
  if (!/^[a-z0-9_.:-]+$/.test(block)) throw new Error('--setup-block requires a block id like minecraft:oak_log');
  return block;
}

function safeDamageTypeName(value) {
  const damageType = String(value || '');
  if (!/^[a-z0-9_.:-]+$/.test(damageType)) {
    throw new Error('--setup-damage-type requires a damage type id like minecraft:out_of_world');
  }
  return damageType;
}

function hasStartupSetup(opts = {}) {
  return Boolean(
    opts.setupQuietBaseline
    || opts.setupTeleport
    || opts.setupClearAll
    || opts.setupClearItems?.length
    || opts.setupGives?.length
    || opts.setupBlocks?.length
    || opts.setupDamage !== null
  );
}

function startupSetupNeedsRawAdmin(opts = {}) {
  return Boolean(
    opts.setupQuietBaseline
    || opts.setupClearAll
    || opts.setupClearItems?.length
    || opts.setupBlocks?.length
    || opts.setupDamage !== null
  );
}

function safeDifficultyName(value) {
  const name = String(value || '').trim().toLowerCase();
  return ['peaceful', 'easy', 'normal', 'hard'].includes(name) ? name : null;
}

async function restoreQuietBaseline(report, opts = {}) {
  if (!opts.setupQuietBaseline) return null;
  const restore = report.diagnostics.quietBaseline.restore;
  restore.requested = true;
  const originalDifficulty = opts.quietBaselineOriginalDifficulty || report.diagnostics.quietBaseline.originalDifficulty;
  const plan = buildQuietBaselineRestorePlan({ originalDifficulty });
  if (!plan.ok) {
    restore.completed = false;
    restore.error = plan.reason;
    report.diagnostics.failures.push(`quiet-baseline restore failed: ${plan.reason}`);
    return null;
  }

  try {
    emitReporterEvent('advisor-live-plan.quiet-baseline.restore.start', { originalDifficulty });
    const result = await runLiveAdminPlan(plan);
    restore.completed = result.ok === true;
    restore.action = result.action;
    restore.originalDifficulty = originalDifficulty;
    restore.result = summarizeAdminResult(result);
    emitReporterEvent('advisor-live-plan.quiet-baseline.restore.done', restore);
    return result;
  } catch (err) {
    const message = err?.message || String(err);
    restore.completed = false;
    restore.error = message;
    report.diagnostics.failures.push(`quiet-baseline restore failed: ${message}`);
    emitReporterEvent('advisor-live-plan.quiet-baseline.restore.failed', { reason: message });
    return null;
  }
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function usageText() {
  return [
    'usage: node scripts/advisor-live-plan.js [--goal "gather 10 oak logs"] [--report reports/advisor-live-plan.json]',
    '       [--timeout-ms N] [--induce-after-ms N] [--position-wait-ms N]',
    '       [--hostile-dx N] [--hostile-dy N] [--hostile-dz N]',
    '       [--cleanup-induced-hostile-after-flee-ms N] [--hostile-cleanup-radius N]',
    '       [--setup-quiet-baseline] [--setup-teleport X Y Z] [--setup-clear-all]',
    '       [--setup-clear-item minecraft:oak_log]',
    '       [--setup-give minecraft:stone_pickaxe 1]',
    '       [--setup-block X Y Z minecraft:oak_log] [--setup-damage N]',
    '       [--setup-damage-type minecraft:out_of_world]',
    '       [--setup-damage-delay-ms N]',
    '       [--startup-delay-ms N]',
    '       [--dry-run]',
    '',
    'Required for a real run: MCBOT_LIVE_TESTS=1, MCBOT_ALLOW_DEEPSEEK=1,',
    'DEEPSEEK_API_KEY, MCBOT_LIVE_ADMIN_OK=1, and MCBOT_RCON_PASSWORD.',
    'The account regime must remain Regime A: account.regime=test, username MCBot, auth=offline.',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const code = await main();
  process.exitCode = code;
}
