#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import config from '../src/config.js';
import { buildLiveAdminPlan, runLiveAdminPlan } from './live-admin-commands.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_GOAL = 'gather 10 oak logs';
const DEFAULT_REPORT_PATH = path.join(ROOT, 'reports', 'advisor-live-plan.json');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INDUCE_AFTER_MS = 45 * 1000;
const DEFAULT_POSITION_WAIT_MS = 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5000;

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
    setupClearItems: [],
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
    } else if (arg === '--report') {
      opts.reportPath = path.resolve(requireValue(argv, ++i, '--report'));
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
    } else if (arg === '--setup-clear-item') {
      opts.setupClearItems.push(safeItemName(requireValue(argv, ++i, '--setup-clear-item')));
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

  const childEnv = { ...process.env };
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
    command: {
      executable: process.execPath,
      args: ['src/index.js', opts.goal],
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
    },
    finalOutcome: {
      reported: false,
      summary: '',
    },
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
      transitionObserved: false,
      transitionObservedAt: null,
      returnedNormal: false,
      cleanup: {
        requested: runConfig.options.hostileCleanupAfterFleeMs > 0,
        completed: false,
      },
    },
    diagnostics: {
      logEvents: {},
      latestPosition: null,
      rcon: null,
      setup: {
        requested: hasStartupSetup(runConfig.options),
        completed: false,
        actions: [],
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
  report.diagnostics.logEvents[evt] = (report.diagnostics.logEvents[evt] || 0) + 1;
  const position = positionFromRecord(record);
  if (position) report.diagnostics.latestPosition = position;

  if (evt === 'llm.request') {
    report.noApiCall = false;
    report.planner.callMade = true;
  } else if (evt === 'plan.accepted') {
    report.planner.schemaValid = true;
    const steps = Number(record.steps || 0);
    report.planner.acceptedSteps = Math.max(Number(report.planner.acceptedSteps || 0), steps);
    report.planner.maxAcceptedSteps = Math.max(Number(report.planner.maxAcceptedSteps || 0), steps);
    report.planner.lastAcceptedSteps = steps;
    report.planner.acceptedPlanCount = Number(report.planner.acceptedPlanCount || 0) + 1;
  } else if (evt === 'goal.plan-activation-ok') {
    report.activation.accepted = true;
    markHostileInductionEligible(report, record);
  } else if (evt === 'skill.invoke') {
    addExecutedSkill(report, record.skill);
    markHostileInductionEligible(report, record);
  } else if (evt === 'skill.result') {
    addExecutedSkill(report, record.skill);
    if (record.ok === false) recordSkillFailure(report, record.skill, record.reason || 'skill result failed');
  } else if (evt === 'llm.response') {
    report.noApiCall = false;
    report.cost.usd = numericCost(record.sessionCostUsd, report.cost.usd);
    report.cost.lastCallUsd = numericCost(record.callCostUsd, report.cost.lastCallUsd);
    report.cost.model = record.model || report.cost.model;
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

export function buildHostileInductionPlan(position, offset = { x: 4, y: 0, z: 0 }) {
  const spawn = {
    x: roundCoordinate(Number(position.x) + Number(offset.x || 0)),
    y: roundCoordinate(Number(position.y) + Number(offset.y || 0)),
    z: roundCoordinate(Number(position.z) + Number(offset.z || 0)),
  };
  const plan = buildLiveAdminPlan([
    'summon-zombie-fire-resistant',
    String(spawn.x),
    String(spawn.y),
    String(spawn.z),
  ]);
  return { ...plan, spawn };
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
  report.hostileFlee.adminAction = inductionResult.action || 'summon-zombie-fire-resistant';
  report.hostileFlee.spawn = inductionResult.spawn || null;
  report.diagnostics.rcon = summarizeAdminResult(inductionResult, {
    action: inductionResult.action || 'summon-zombie-fire-resistant',
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
  const plans = [];
  if (opts.setupTeleport) {
    plans.push(buildLiveAdminPlan([
      'teleport-player',
      'MCBot',
      String(opts.setupTeleport.x),
      String(opts.setupTeleport.y),
      String(opts.setupTeleport.z),
    ]));
  }
  for (const item of opts.setupClearItems || []) {
    plans.push(buildLiveAdminPlan(['raw', `clear MCBot ${item}`]));
  }
  const results = [];
  for (const plan of plans) {
    if (!plan.ok) throw new Error(plan.reason);
    const result = await runLiveAdminPlan(plan);
    results.push(summarizeAdminResult(result));
  }
  return results;
}

function markStartupSetupComplete(report, results) {
  report.diagnostics.setup.completed = true;
  report.diagnostics.setup.actions = results;
}

export function finalizeAdvisorLivePlanReport(report, extra = {}) {
  report.endedAt = extra.endedAt || new Date().toISOString();
  if (extra.childExit) report.diagnostics.childExit = extra.childExit;
  if (extra.timeout === true) {
    report.diagnostics.timeout = true;
    report.diagnostics.failures.push(`live plan timed out after ${extra.timeoutMs}ms`);
  }
  if (extra.error) report.diagnostics.failures.push(String(extra.error));

  const finalOk = report.finalOutcome.reported === true && report.finalOutcome.ok !== false;
  const acceptedSteps = Number(report.planner.acceptedSteps || report.planner.maxAcceptedSteps || 0);
  const criteriaOk = report.planner.callMade === true
    && report.planner.schemaValid === true
    && acceptedSteps >= 1
    && report.activation.accepted === true
    && report.executor.ranSkillCount >= 1
    && report.executor.failedSkillCount === 0
    && report.costCeilingGuard.verified === true
    && report.hostileFlee.transitionObserved === true
    && report.diagnostics.failures.length === 0;

  report.hostileFlee.survived = report.hostileFlee.inducedAt != null
    && report.hostileFlee.transitionObserved === true
    && !report.diagnostics.failures.some((failure) => /critical-health|emergency/i.test(failure));
  report.ok = finalOk && criteriaOk && report.hostileFlee.survived === true;
  report.status = report.ok ? 'live_plan_completed' : 'live_plan_failed';
  return report;
}

export async function runAdvisorLivePlan(runConfig) {
  const report = createAdvisorLivePlanReport(runConfig);
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

  const writeReport = () => writeJson(runConfig.options.reportPath, report);
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

  attachLogParser(child.stdout, process.stdout, report);
  attachLogParser(child.stderr, process.stderr, report);

  const timeoutTimer = setTimeout(() => {
    timeout = true;
    stopChild(child, 'advisor-live-plan-timeout');
  }, runConfig.options.timeoutMs);

  const inductionPoll = setInterval(async () => {
    if (inductionDone || settled) return;
    if (!setupDone) return;
    if (!report.hostileFlee.eligibleAt) return;
    if (!inductionEligibleAt) inductionEligibleAt = Date.parse(report.hostileFlee.eligibleAt);
    const elapsed = Date.now() - inductionEligibleAt;
    if (elapsed < runConfig.options.induceAfterMs) return;
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
      markHostileInduced(report, { ...result, spawn: plan.spawn }, new Date());
      emitReporterEvent('advisor-live-plan.hostile-induction.done', report.diagnostics.rcon);
      writeReport();
    } catch (err) {
      inductionError = err?.message || String(err);
      emitReporterEvent('advisor-live-plan.hostile-induction.failed', { reason: inductionError });
      stopChild(child, inductionError);
    }
  }, 500);

  const setupPoll = setInterval(async () => {
    if (setupDone || setupStarted || settled) return;
    if (!report.diagnostics.logEvents['main.spawned']) return;
    setupStarted = true;
    try {
      emitReporterEvent('advisor-live-plan.startup-setup.start', {});
      const result = await runStartupSetup(runConfig.options);
      markStartupSetupComplete(report, result);
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
    if (cleanupDone || cleanupStarted || settled) return;
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

  child.stdout.on('data', (chunk) => {
    if (String(chunk).includes('"evt":"main.goal-done"') || String(chunk).includes('"evt":"main.goal-failed"')) {
      finalLogSeen = true;
      setTimeout(() => stopChild(child, 'advisor-live-plan-final-outcome'), 1000);
    }
  });
  child.stderr.on('data', (chunk) => {
    if (String(chunk).includes('"evt":"main.exception"')) {
      finalLogSeen = true;
      setTimeout(() => stopChild(child, 'advisor-live-plan-final-outcome'), 1000);
    }
  });

  return new Promise((resolve) => {
    child.on('close', () => {
      if (!settled) finish({ code: child.exitCode, signal: child.signalCode });
      if (!finalLogSeen && !timeout && report.finalOutcome.reported !== true) {
        report.diagnostics.failures.push('child exited before final outcome log');
        finalizeAdvisorLivePlanReport(report, { childExit: report.diagnostics.childExit });
        writeReport();
      }
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

function attachLogParser(readable, passthrough, report) {
  let buffer = '';
  readable.on('data', (chunk) => {
    const text = String(chunk);
    passthrough.write(text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const record = parseJsonLogLine(line);
      if (record) updateAdvisorLivePlanReportFromRecord(report, record);
    }
  });
  readable.on('end', () => {
    const record = parseJsonLogLine(buffer);
    if (record) updateAdvisorLivePlanReportFromRecord(report, record);
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

function addExecutedSkill(report, skill) {
  if (!skill) return;
  if (!report.executor.skillsExecuted.includes(skill)) {
    report.executor.skillsExecuted.push(skill);
  }
  report.executor.ranSkillCount = report.executor.skillsExecuted.length;
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
    }
  }
  if (record.to === 'NORMAL' && report.hostileFlee.transitionObserved === true) {
    report.hostileFlee.returnedNormal = true;
  }
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

function emitReporterEvent(evt, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    t: new Date().toISOString(),
    lvl: 'info',
    loop: 'test',
    evt,
    ...fields,
  })}\n`);
}

function stopChild(child, reason) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  emitReporterEvent('advisor-live-plan.stop-child', { reason });
  child.kill('SIGINT');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }, 5000).unref?.();
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 10000).unref?.();
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

function safeItemName(value) {
  const item = String(value || '');
  if (!/^[a-z0-9_.:-]+$/.test(item)) throw new Error('--setup-clear-item requires an item id like minecraft:oak_log');
  return item;
}

function hasStartupSetup(opts = {}) {
  return Boolean(opts.setupTeleport || opts.setupClearItems?.length);
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
    '       [--setup-teleport X Y Z] [--setup-clear-item minecraft:oak_log] [--startup-delay-ms N]',
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
