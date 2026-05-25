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
const DEFAULT_CASE_ID = 'activation_rejected_policy';
const DEFAULT_GOAL = 'gather 10 oak logs';
const DEFAULT_REPORT_PATH = path.join(ROOT, 'reports', 'advisor-live-calibration-case.json');
const DEFAULT_EVIDENCE_PATH = path.join(ROOT, 'reports', 'advisor-live-calibration-evidence.json');
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_INJECT_AFTER_LLM_REQUEST_MS = 500;
const DEFAULT_POSITION_WAIT_MS = 30 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5000;
const DEFAULT_STALE_DRIFT_OFFSET = Object.freeze({ x: 8, y: 0, z: 0 });
const DEFAULT_RECOVERY_DAMAGE = 100;

const SUPPORTED_CASES = Object.freeze({
  activation_rejected_policy: Object.freeze({
    proposalClass: 'rejected',
    objective: 'Induce a live hostile state during the real model-call window and prove deterministic activation rejects the accepted proposal before executor skills run.',
    induction: 'hostile-flee',
    trigger: 'llm.request',
  }),
  stale_plan_rejected: Object.freeze({
    proposalClass: 'stale',
    objective: 'Induce a live position drift during the real model-call window and prove deterministic activation rejects the accepted proposal as stale before executor skills run.',
    induction: 'teleport-drift',
    trigger: 'llm.request',
  }),
  unsafe_normal_work_rejected: Object.freeze({
    proposalClass: 'unsafe',
    objective: 'Induce a live unsafe survival state during the real model-call window and prove deterministic activation rejects a normal-work proposal before executor skills run.',
    induction: 'hostile-flee',
    trigger: 'llm.request',
  }),
  recovery_proposal_bounded: Object.freeze({
    proposalClass: 'recovery',
    objective: 'Induce a recoverable death after activation and prove deterministic recovery schedules exactly one bounded recover_drops attempt before resuming cleanly.',
    induction: 'death-recovery-fall',
    trigger: 'skill.invoke',
  }),
});

export function parseAdvisorLiveCalibrationCaseArgs(argv = []) {
  const opts = {
    caseId: DEFAULT_CASE_ID,
    goal: DEFAULT_GOAL,
    reportPath: DEFAULT_REPORT_PATH,
    evidencePath: DEFAULT_EVIDENCE_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    injectAfterLlmRequestMs: DEFAULT_INJECT_AFTER_LLM_REQUEST_MS,
    positionWaitMs: DEFAULT_POSITION_WAIT_MS,
    hostileOffset: { x: 4, y: 0, z: 0 },
    staleDriftOffset: { ...DEFAULT_STALE_DRIFT_OFFSET },
    recoveryDamage: DEFAULT_RECOVERY_DAMAGE,
    startupDelayMs: 0,
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
    } else if (arg === '--case') {
      opts.caseId = requireValue(argv, ++i, '--case');
    } else if (arg === '--goal') {
      opts.goal = requireValue(argv, ++i, '--goal');
    } else if (arg === '--report') {
      opts.reportPath = path.resolve(requireValue(argv, ++i, '--report'));
    } else if (arg === '--evidence') {
      opts.evidencePath = path.resolve(requireValue(argv, ++i, '--evidence'));
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = positiveInteger(requireValue(argv, ++i, '--timeout-ms'), '--timeout-ms');
    } else if (arg === '--inject-after-llm-request-ms') {
      opts.injectAfterLlmRequestMs = positiveInteger(
        requireValue(argv, ++i, '--inject-after-llm-request-ms'),
        '--inject-after-llm-request-ms',
      );
    } else if (arg === '--position-wait-ms') {
      opts.positionWaitMs = positiveInteger(requireValue(argv, ++i, '--position-wait-ms'), '--position-wait-ms');
    } else if (arg === '--startup-delay-ms') {
      opts.startupDelayMs = positiveInteger(requireValue(argv, ++i, '--startup-delay-ms'), '--startup-delay-ms');
    } else if (arg === '--setup-clear-item') {
      opts.setupClearItems.push(safeItemName(requireValue(argv, ++i, '--setup-clear-item')));
    } else if (arg === '--hostile-dx') {
      opts.hostileOffset.x = finiteNumber(requireValue(argv, ++i, '--hostile-dx'), '--hostile-dx');
    } else if (arg === '--hostile-dy') {
      opts.hostileOffset.y = finiteNumber(requireValue(argv, ++i, '--hostile-dy'), '--hostile-dy');
    } else if (arg === '--hostile-dz') {
      opts.hostileOffset.z = finiteNumber(requireValue(argv, ++i, '--hostile-dz'), '--hostile-dz');
    } else if (arg === '--stale-dx') {
      opts.staleDriftOffset.x = finiteNumber(requireValue(argv, ++i, '--stale-dx'), '--stale-dx');
    } else if (arg === '--stale-dy') {
      opts.staleDriftOffset.y = finiteNumber(requireValue(argv, ++i, '--stale-dy'), '--stale-dy');
    } else if (arg === '--stale-dz') {
      opts.staleDriftOffset.z = finiteNumber(requireValue(argv, ++i, '--stale-dz'), '--stale-dz');
    } else if (arg === '--recovery-damage') {
      opts.recoveryDamage = finiteNumber(requireValue(argv, ++i, '--recovery-damage'), '--recovery-damage');
      if (opts.recoveryDamage <= 0 || opts.recoveryDamage > 10000) {
        throw new Error('--recovery-damage must be a positive number up to 10000');
      }
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }

  return opts;
}

export function buildAdvisorLiveCalibrationCaseConfig({
  argv = [],
  env = process.env,
  account = config.account,
  minecraft = config.minecraft,
  deepseek = config.deepseek,
} = {}) {
  let opts;
  try {
    opts = parseAdvisorLiveCalibrationCaseArgs(argv);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (opts.help) return { ok: false, help: true, reason: usageText() };

  const caseDef = SUPPORTED_CASES[opts.caseId];
  if (!caseDef) {
    return {
      ok: false,
      reason: `unsupported live calibration case "${opts.caseId}"; supported cases: ${Object.keys(SUPPORTED_CASES).join(', ')}`,
      options: opts,
    };
  }

  const reasons = [];
  if (opts.dryRun !== true) {
    if (env.MCBOT_LIVE_TESTS !== '1') reasons.push('MCBOT_LIVE_TESTS=1 required');
    if (env.MCBOT_ALLOW_DEEPSEEK !== '1') reasons.push('MCBOT_ALLOW_DEEPSEEK=1 required');
    if (!deepseek?.apiKey) reasons.push('DEEPSEEK_API_KEY required');
    if (env.MCBOT_LIVE_ADMIN_OK !== '1') reasons.push('MCBOT_LIVE_ADMIN_OK=1 required');
    if (env.MCBOT_LIVE_ADMIN_DRY_RUN !== '1' && !env.MCBOT_RCON_PASSWORD) {
      reasons.push('MCBOT_RCON_PASSWORD required for RCON calibration induction');
    }
    if ((opts.setupClearItems || []).length > 0 && env.MCBOT_LIVE_ADMIN_RAW_OK !== '1') {
      reasons.push('MCBOT_LIVE_ADMIN_RAW_OK=1 required for startup inventory clear setup');
    }
  }

  const regime = String(account?.regime || '').toLowerCase();
  const username = String(minecraft?.username || '').toLowerCase();
  const auth = String(minecraft?.auth || '').toLowerCase();
  if (regime !== 'test') reasons.push(`account.regime must be "test" for private Regime A calibration, got "${account?.regime || 'unknown'}"`);
  if (username !== 'mcbot') reasons.push(`minecraft.username must be "MCBot" for private Regime A calibration, got "${minecraft?.username || 'unknown'}"`);
  if (auth !== 'offline') reasons.push(`minecraft.auth must be "offline" for private Regime A calibration, got "${minecraft?.auth || 'unknown'}"`);

  if (reasons.length > 0) {
    return {
      ok: false,
      reason: `refusing advisor live calibration case: ${reasons.join('; ')}`,
      options: opts,
    };
  }

  const childEnv = { ...process.env, ...env };
  if ((opts.setupClearItems || []).length > 0) {
    childEnv.MCBOT_STARTUP_DELAY_MS = String(opts.startupDelayMs || DEFAULT_STARTUP_DELAY_MS);
  } else if (opts.startupDelayMs > 0) {
    childEnv.MCBOT_STARTUP_DELAY_MS = String(opts.startupDelayMs);
  }

  return {
    ok: true,
    caseDef,
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

export function createAdvisorLiveCalibrationCaseReport(runConfig, now = new Date()) {
  return {
    ok: false,
    noApiCall: true,
    status: 'calibration_case_running',
    startedAt: now.toISOString(),
    caseId: runConfig.options.caseId,
    proposalClass: runConfig.caseDef.proposalClass,
    objective: runConfig.caseDef.objective,
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
      acceptedPlanCount: 0,
    },
    activation: {
      accepted: null,
      reason: null,
      safetyReasons: [],
      staleReasons: [],
    },
    executor: {
      ranSkillCount: 0,
      skillsExecuted: [],
      failedSkillCount: 0,
    },
    induction: {
      requested: true,
      completed: false,
      trigger: runConfig.caseDef.trigger || 'llm.request',
      type: runConfig.caseDef.induction,
      injectAfterLlmRequestMs: runConfig.options.injectAfterLlmRequestMs,
      inducedAt: null,
      action: null,
      spawn: null,
      destination: null,
      rcon: null,
    },
    setup: {
      requested: (runConfig.options.setupClearItems || []).length > 0,
      completed: false,
      actions: [],
      error: null,
    },
    recovery: {
      deathObserved: false,
      respawnObserved: false,
      scheduled: false,
      scheduleOk: false,
      recoverDropsInvokeCount: 0,
      recoverDropsResultOk: null,
      singleAttemptBounded: false,
      attempts: 0,
      reason: null,
      deathPosition: null,
      deathDimension: null,
    },
    finalOutcome: {
      reported: false,
      ok: null,
      summary: '',
    },
    cost: {
      usd: 0,
    },
    costCeilingGuard: {
      verified: false,
    },
    diagnostics: {
      logEvents: {},
      latestPosition: null,
      childExit: null,
      timeout: false,
      failures: [],
    },
  };
}

export function updateAdvisorLiveCalibrationCaseReportFromRecord(report, record) {
  if (!record || typeof record !== 'object') return report;
  const evt = record.evt || 'unknown';
  report.diagnostics.logEvents[evt] = (report.diagnostics.logEvents[evt] || 0) + 1;
  const position = positionFromRecord(record);
  if (position) report.diagnostics.latestPosition = position;

  if (evt === 'llm.request') {
    report.noApiCall = false;
    report.planner.callMade = true;
    report.planner.requestAt = record.t || new Date().toISOString();
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
  } else if (evt === 'plan.accepted') {
    report.planner.schemaValid = true;
    const steps = Number(record.steps || 0);
    report.planner.acceptedSteps = Math.max(Number(report.planner.acceptedSteps || 0), steps);
    report.planner.lastAcceptedSteps = steps;
    report.planner.acceptedPlanCount = Number(report.planner.acceptedPlanCount || 0) + 1;
  } else if (evt === 'goal.plan-activation-ok') {
    report.activation.accepted = true;
    report.activation.acceptedAt = record.t || new Date().toISOString();
  } else if (evt === 'goal.plan-activation-rejected') {
    report.activation.accepted = false;
    report.activation.rejectedAt = record.t || new Date().toISOString();
    report.activation.reason = record.reason || report.activation.reason || 'activation rejected';
    report.activation.badIndex = record.badIndex;
    report.activation.safetyReasons = arrayOfStrings(record.safetyReasons);
    report.activation.staleReasons = arrayOfStrings(record.staleReasons);
  } else if (evt === 'skill.invoke') {
    addExecutedSkill(report, record.skill);
    if (record.skill === 'recover_drops') {
      report.recovery.recoverDropsInvokeCount = Number(report.recovery.recoverDropsInvokeCount || 0) + 1;
      report.recovery.singleAttemptBounded = report.recovery.recoverDropsInvokeCount === 1;
    }
  } else if (evt === 'skill.result') {
    addExecutedSkill(report, record.skill);
    if (record.skill === 'recover_drops') {
      report.recovery.recoverDropsResultOk = record.ok === true;
      report.recovery.reason = record.reason || report.recovery.reason;
      report.recovery.singleAttemptBounded = Number(report.recovery.recoverDropsInvokeCount || 0) === 1;
    }
    if (record.ok === false) recordSkillFailure(report, record.skill, record.reason || 'skill result failed');
  } else if (evt === 'queue.failure') {
    recordSkillFailure(report, record.skill, record.reason || 'queue failure');
  } else if (evt === 'emergency.logout') {
    report.diagnostics.failures.push('critical-health emergency logout during calibration case');
  } else if (evt === 'death') {
    report.recovery.deathObserved = true;
    report.recovery.deathPosition = record.position || null;
    report.recovery.deathDimension = record.dimension || null;
    report.recovery.decision = record.recovery || null;
    report.recovery.reason = record.recovery?.reason || record.recovery?.decision?.reason || report.recovery.reason;
  } else if (evt === 'respawn') {
    report.recovery.respawnObserved = true;
    const decision = record.recovery?.decision || {};
    const schedule = record.dropRecoverySchedule || {};
    if (decision.action === 'recover_drops' || schedule.call?.skill === 'recover_drops') {
      report.recovery.scheduled = true;
      report.recovery.scheduleOk = schedule.ok === true;
      report.recovery.attempts = Number(schedule.recovery?.attempts || decision.attemptsAllowed || report.recovery.attempts || 0);
      report.recovery.reason = decision.reason || report.recovery.reason;
      report.recovery.deathPosition = record.recovery?.deathPosition || report.recovery.deathPosition;
      report.recovery.deathDimension = record.recovery?.deathDimension || report.recovery.deathDimension;
    }
  } else if (evt === 'state.transition') {
    if (record.to === 'FLEEING') {
      report.diagnostics.lastFleeTransition = {
        at: record.t || new Date().toISOString(),
        reason: record.reason,
        entity: record.entity,
        distance: record.dist,
      };
    }
  } else if (evt === 'main.goal-done') {
    report.finalOutcome = {
      reported: true,
      ok: true,
      summary: record.reason || 'goal complete',
      replans: record.replans,
    };
  } else if (evt === 'main.goal-failed') {
    report.finalOutcome = {
      reported: true,
      ok: false,
      summary: record.reason || 'goal failed',
      replans: record.replans,
    };
  } else if (evt === 'main.exception') {
    report.finalOutcome = {
      reported: true,
      ok: false,
      summary: record.err || 'main exception',
    };
    report.diagnostics.failures.push(record.err || 'main exception');
  }

  return report;
}

export function buildActivationRejectedInductionPlan(position, offset = { x: 4, y: 0, z: 0 }) {
  const spawnPosition = {
    x: roundCoordinate(Number(position.x) + Number(offset.x || 0)),
    y: roundCoordinate(Number(position.y) + Number(offset.y || 0)),
    z: roundCoordinate(Number(position.z) + Number(offset.z || 0)),
  };
  const plan = buildLiveAdminPlan([
    'summon-zombie-fire-resistant',
    String(spawnPosition.x),
    String(spawnPosition.y),
    String(spawnPosition.z),
  ]);
  return { ...plan, spawn: spawnPosition };
}

export function buildStalePlanInductionPlan(position, offset = DEFAULT_STALE_DRIFT_OFFSET) {
  const destination = {
    x: roundCoordinate(Number(position.x) + Number(offset.x || 0)),
    y: roundCoordinate(Number(position.y) + Number(offset.y || 0)),
    z: roundCoordinate(Number(position.z) + Number(offset.z || 0)),
  };
  const plan = buildLiveAdminPlan([
    'teleport-player',
    'MCBot',
    String(destination.x),
    String(destination.y),
    String(destination.z),
  ]);
  return { ...plan, destination };
}

export function buildRecoveryProposalInductionPlan(damage = DEFAULT_RECOVERY_DAMAGE) {
  return buildLiveAdminPlan([
    'death-recovery-fall',
    'MCBot',
    String(roundCoordinate(damage)),
  ]);
}

export function buildCalibrationInductionPlan(runConfig, position) {
  if (runConfig.caseDef.induction === 'teleport-drift') {
    return buildStalePlanInductionPlan(position, runConfig.options.staleDriftOffset);
  }
  if (runConfig.caseDef.induction === 'death-recovery-fall') {
    return buildRecoveryProposalInductionPlan(runConfig.options.recoveryDamage);
  }
  return buildActivationRejectedInductionPlan(position, runConfig.options.hostileOffset);
}

export function markCalibrationInduction(report, inductionResult, inducedAt = new Date()) {
  report.induction.completed = inductionResult.ok === true;
  report.induction.inducedAt = inducedAt.toISOString();
  report.induction.action = inductionResult.action || defaultInductionAction(report.induction.type);
  report.induction.spawn = inductionResult.spawn || null;
  report.induction.destination = inductionResult.destination || null;
  report.induction.rcon = summarizeAdminResult(inductionResult, {
    action: report.induction.action,
  });
  return report;
}

function defaultInductionAction(type) {
  if (type === 'teleport-drift') return 'teleport-player';
  if (type === 'death-recovery-fall') return 'death-recovery-fall';
  return 'summon-zombie-fire-resistant';
}

export function markCalibrationStartupSetup(report, setupResults) {
  report.setup.completed = true;
  report.setup.actions = setupResults.map((result) => summarizeAdminResult(result));
  return report;
}

export async function runStartupSetup(opts) {
  const plans = [];
  for (const item of opts.setupClearItems || []) {
    plans.push(buildLiveAdminPlan(['raw', `minecraft:clear MCBot ${item}`]));
  }

  const results = [];
  for (const plan of plans) {
    if (!plan.ok) throw new Error(plan.reason);
    results.push(await runLiveAdminPlan(plan));
  }
  return results;
}

export function finalizeAdvisorLiveCalibrationCaseReport(report, extra = {}) {
  report.endedAt = extra.endedAt || new Date().toISOString();
  if (extra.childExit) report.diagnostics.childExit = extra.childExit;
  if (extra.timeout === true) {
    report.diagnostics.timeout = true;
    report.diagnostics.failures.push(`calibration case timed out after ${extra.timeoutMs}ms`);
  }
  if (extra.error) report.diagnostics.failures.push(String(extra.error));

  const rejectedBeforeSkills = report.activation.accepted === false
    && Number(report.executor.ranSkillCount || 0) === 0;
  const acceptedRecoveryAttempt = report.proposalClass === 'recovery'
    && report.activation.accepted === true
    && report.recovery.scheduled === true
    && report.recovery.scheduleOk === true
    && report.recovery.singleAttemptBounded === true
    && Number(report.recovery.recoverDropsInvokeCount || 0) === 1
    && (report.executor.skillsExecuted || []).includes('recover_drops');
  const acceptedSteps = Number(report.planner.acceptedSteps || 0);
  const finalOutcomeMatchesRejectedRun = report.finalOutcome.reported === true
    && report.finalOutcome.ok === false;
  const finalOutcomeMatchesRecoveryRun = report.finalOutcome.reported === true;
  const caseCriteriaOk = calibrationCaseCriteriaOk(report);
  const criteriaOk = report.planner.callMade === true
    && report.planner.schemaValid === true
    && acceptedSteps >= 1
    && report.costCeilingGuard.verified === true
    && (report.setup.requested !== true || report.setup.completed === true)
    && report.induction.completed === true
    && (
      report.proposalClass === 'recovery'
        ? acceptedRecoveryAttempt && finalOutcomeMatchesRecoveryRun
        : rejectedBeforeSkills && finalOutcomeMatchesRejectedRun
    )
    && caseCriteriaOk
    && report.diagnostics.failures.length === 0;

  report.ok = criteriaOk;
  report.status = report.ok ? 'live_calibration_case_completed' : 'live_calibration_case_failed';
  report.evidenceCase = createCalibrationEvidenceCase(report);
  return report;
}

export function createCalibrationEvidenceCase(report) {
  const activationReasons = [
    report.activation.reason,
    ...(report.activation.safetyReasons || []),
    ...(report.activation.staleReasons || []),
  ].filter(Boolean).join('; ');
  const recoveryCase = report.proposalClass === 'recovery';
  const recoverDropsRan = (report.executor.skillsExecuted || []).includes('recover_drops');
  return {
    liveProven: report.ok === true,
    status: report.ok === true ? 'live-proven' : 'pending',
    proposalClass: report.proposalClass,
    evidence: `case=${report.caseId}; activation.accepted=${report.activation.accepted}; acceptedSteps=${Number(report.planner.acceptedSteps || 0)}; skills=${Number(report.executor.ranSkillCount || 0)}; induction=${report.induction.completed ? report.induction.action : 'not-complete'}; reason=${activationReasons || report.recovery?.reason || 'none'}; recoveryAttempts=${Number(report.recovery?.recoverDropsInvokeCount || 0)}; costUsd=${report.cost.usd ?? 0}`,
    planner: {
      callMade: report.planner.callMade === true,
      schemaValid: report.planner.schemaValid === true,
      acceptedSteps: Number(report.planner.acceptedSteps || 0),
    },
    activationBoundary: recoveryCase ? report.activation.accepted === true : report.activation.accepted === false,
    skillBoundary: recoveryCase ? recoverDropsRan : Number(report.executor.ranSkillCount || 0) === 0,
    reactiveAuthority: recoveryCase ? report.recovery.scheduled === true : report.induction.completed === true,
    noBypass: report.ok === true,
    activation: {
      accepted: report.activation.accepted,
      reason: report.activation.reason,
      safetyReasons: report.activation.safetyReasons || [],
      staleReasons: report.activation.staleReasons || [],
    },
    executor: {
      ranSkillCount: Number(report.executor.ranSkillCount || 0),
      skillsExecuted: [...(report.executor.skillsExecuted || [])],
    },
    induction: {
      completed: report.induction.completed === true,
      action: report.induction.action,
      spawn: report.induction.spawn,
      destination: report.induction.destination,
    },
    ...(recoveryCase
      ? {
          recovery: {
            deathObserved: report.recovery.deathObserved === true,
            respawnObserved: report.recovery.respawnObserved === true,
            scheduled: report.recovery.scheduled === true,
            scheduleOk: report.recovery.scheduleOk === true,
            singleAttemptBounded: report.recovery.singleAttemptBounded === true,
            recoverDropsInvokeCount: Number(report.recovery.recoverDropsInvokeCount || 0),
            recoverDropsResultOk: report.recovery.recoverDropsResultOk,
          },
        }
      : {}),
  };
}

export function mergeCalibrationEvidenceCase(existingReport = {}, caseId, caseEvidence, updatedAt = new Date().toISOString()) {
  const base = existingReport && typeof existingReport === 'object' ? existingReport : {};
  const existingCases = normalizeEvidenceCases(base.cases);
  return {
    ...base,
    updatedAt,
    cases: {
      ...existingCases,
      [caseId]: caseEvidence,
    },
  };
}

export async function runAdvisorLiveCalibrationCase(runConfig) {
  const report = createAdvisorLiveCalibrationCaseReport(runConfig);
  const child = spawn(runConfig.command.executable, runConfig.command.args, {
    cwd: runConfig.command.cwd,
    env: runConfig.command.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let timeout = false;
  let inductionDone = false;
  let inductionError = null;
  let setupStarted = false;
  let setupDone = (runConfig.options.setupClearItems || []).length === 0;
  let setupError = null;
  let llmRequestWallTime = null;
  let positionWaitStarted = 0;

  const writeReport = () => writeJson(runConfig.options.reportPath, report);
  const writeEvidence = () => {
    const existing = readJson(runConfig.options.evidencePath) || {};
    writeJson(
      runConfig.options.evidencePath,
      mergeCalibrationEvidenceCase(existing, runConfig.options.caseId, report.evidenceCase),
    );
  };
  const finish = (childExit = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    clearInterval(inductionPoll);
    clearInterval(setupPoll);
    finalizeAdvisorLiveCalibrationCaseReport(report, {
      childExit,
      timeout,
      timeoutMs: runConfig.options.timeoutMs,
      error: inductionError || setupError,
    });
    writeReport();
    writeEvidence();
  };

  attachLogParser(child.stdout, process.stdout, report);
  attachLogParser(child.stderr, process.stderr, report);

  const timeoutTimer = setTimeout(() => {
    timeout = true;
    stopChild(child, 'advisor-live-calibration-case-timeout');
  }, runConfig.options.timeoutMs);

  const inductionPoll = setInterval(async () => {
    if (inductionDone || settled) return;
    if (!setupDone) return;
    if (!calibrationInductionTriggerReached(runConfig, report)) return;
    if (!llmRequestWallTime) llmRequestWallTime = Date.now();
    const elapsed = Date.now() - llmRequestWallTime;
    if (elapsed < runConfig.options.injectAfterLlmRequestMs) return;
    if (!report.diagnostics.latestPosition && runConfig.caseDef.induction !== 'death-recovery-fall') {
      if (!positionWaitStarted) positionWaitStarted = Date.now();
      if (Date.now() - positionWaitStarted <= runConfig.options.positionWaitMs) return;
      inductionDone = true;
      inductionError = 'no bot position observed before calibration induction';
      stopChild(child, inductionError);
      return;
    }
    inductionDone = true;
    const plan = buildCalibrationInductionPlan(runConfig, report.diagnostics.latestPosition);
    if (!plan.ok) {
      inductionError = plan.reason;
      stopChild(child, inductionError);
      return;
    }
    try {
      emitReporterEvent('advisor-live-calibration-case.induction.start', {
        caseId: runConfig.options.caseId,
        action: plan.action,
        spawn: plan.spawn,
        destination: plan.destination,
      });
      const result = await runLiveAdminPlan(plan);
      markCalibrationInduction(report, { ...result, spawn: plan.spawn, destination: plan.destination }, new Date());
      emitReporterEvent('advisor-live-calibration-case.induction.done', report.induction.rcon);
      writeReport();
    } catch (err) {
      inductionError = err?.message || String(err);
      emitReporterEvent('advisor-live-calibration-case.induction.failed', { reason: inductionError });
      stopChild(child, inductionError);
    }
  }, 100);

  const setupPoll = setInterval(async () => {
    if (setupDone || setupStarted || settled) return;
    if (!report.diagnostics.logEvents['main.spawned']) return;
    setupStarted = true;
    try {
      emitReporterEvent('advisor-live-calibration-case.startup-setup.start', {
        caseId: runConfig.options.caseId,
        clearItems: runConfig.options.setupClearItems,
      });
      const results = await runStartupSetup(runConfig.options);
      markCalibrationStartupSetup(report, results);
      setupDone = true;
      emitReporterEvent('advisor-live-calibration-case.startup-setup.done', report.setup);
      writeReport();
    } catch (err) {
      setupError = err?.message || String(err);
      report.setup.error = setupError;
      emitReporterEvent('advisor-live-calibration-case.startup-setup.failed', { reason: setupError });
      stopChild(child, setupError);
    }
  }, 100);

  child.on('exit', (code, signal) => finish({ code, signal }));
  child.on('error', (err) => {
    inductionError = err?.message || String(err);
    finish({ code: null, signal: null, error: inductionError });
  });

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    if (text.includes('"evt":"goal.plan-activation-rejected"')) {
      setTimeout(() => stopChild(child, 'advisor-live-calibration-case-activation-rejected'), 1500);
    } else if (text.includes('"evt":"main.goal-done"') || text.includes('"evt":"main.goal-failed"')) {
      setTimeout(() => stopChild(child, 'advisor-live-calibration-case-final-outcome'), 1000);
    }
  });
  child.stderr.on('data', (chunk) => {
    if (String(chunk).includes('"evt":"main.exception"')) {
      setTimeout(() => stopChild(child, 'advisor-live-calibration-case-exception'), 1000);
    }
  });

  return new Promise((resolve) => {
    child.on('close', () => {
      if (!settled) finish({ code: child.exitCode, signal: child.signalCode });
      resolve(report);
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const runConfig = buildAdvisorLiveCalibrationCaseConfig({ argv });
  if (!runConfig.ok) {
    if (runConfig.help) {
      console.log(runConfig.reason);
      return 0;
    }
    console.error(runConfig.reason);
    return 1;
  }

  if (runConfig.options.dryRun) {
    const report = createAdvisorLiveCalibrationCaseReport(runConfig);
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      caseId: runConfig.options.caseId,
      command: ['node', ...runConfig.command.args].join(' '),
      reportPath: runConfig.options.reportPath,
      evidencePath: runConfig.options.evidencePath,
      report,
    }, null, 2));
    return 0;
  }

  const report = await runAdvisorLiveCalibrationCase(runConfig);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status,
    caseId: report.caseId,
    reportPath: runConfig.options.reportPath,
    evidencePath: runConfig.options.evidencePath,
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
      if (record) updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
    }
  });
  readable.on('end', () => {
    const record = parseJsonLogLine(buffer);
    if (record) updateAdvisorLiveCalibrationCaseReportFromRecord(report, record);
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

function calibrationInductionTriggerReached(runConfig, report) {
  if (runConfig.caseDef.trigger === 'skill.invoke') {
    return report.activation.accepted === true
      && (report.executor.skillsExecuted || []).some((skill) => skill && skill !== 'recover_drops');
  }
  return report.planner.callMade === true;
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

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
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

function calibrationCaseCriteriaOk(report) {
  const reasonText = [
    report.activation?.reason,
    ...(report.activation?.safetyReasons || []),
    ...(report.activation?.staleReasons || []),
    report.evidence,
  ].filter(Boolean).join(' ');

  if (report.proposalClass === 'stale') {
    return (report.activation?.staleReasons || []).length > 0 || /stale/i.test(reasonText);
  }
  if (report.proposalClass === 'unsafe') {
    return /(unsafe|safety|reactive|hostile|oxygen|health|water|lava|fire)/i.test(reasonText);
  }
  if (report.proposalClass === 'recovery') {
    return report.activation?.accepted === true
      && report.recovery?.scheduled === true
      && report.recovery?.scheduleOk === true
      && report.recovery?.singleAttemptBounded === true
      && Number(report.recovery?.recoverDropsInvokeCount || 0) === 1;
  }
  if (report.proposalClass === 'rejected') return true;
  return false;
}

function sanitizeRconResponse(value) {
  return String(value || '')
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .slice(0, 500);
}

function normalizeEvidenceCases(cases) {
  if (Array.isArray(cases)) {
    return Object.fromEntries(
      cases
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => [entry.id || entry.caseId || entry.proposalClass, entry])
        .filter(([key]) => key),
    );
  }
  return cases && typeof cases === 'object' ? { ...cases } : {};
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
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
  emitReporterEvent('advisor-live-calibration-case.stop-child', { reason });
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

function safeItemName(value) {
  const item = String(value || '');
  if (!/^[a-z0-9_.:-]+$/.test(item)) throw new Error('--setup-clear-item requires an item id like minecraft:oak_log');
  return item;
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function usageText() {
  return [
    `usage: node scripts/advisor-live-calibration-case.js [--case ${Object.keys(SUPPORTED_CASES).join('|')}]`,
    '       [--goal "gather 10 oak logs"] [--report reports/advisor-live-calibration-case.json]',
    '       [--evidence reports/advisor-live-calibration-evidence.json]',
    '       [--timeout-ms N] [--inject-after-llm-request-ms N] [--position-wait-ms N]',
    '       [--hostile-dx N] [--hostile-dy N] [--hostile-dz N] [--startup-delay-ms N]',
    '       [--stale-dx N] [--stale-dy N] [--stale-dz N] [--recovery-damage N]',
    '       [--setup-clear-item minecraft:oak_log]',
    '       [--dry-run]',
    '',
    'Required for a real run: MCBOT_LIVE_TESTS=1, MCBOT_ALLOW_DEEPSEEK=1,',
    'DEEPSEEK_API_KEY, MCBOT_LIVE_ADMIN_OK=1, and MCBOT_RCON_PASSWORD.',
    'Startup inventory clear setup also requires MCBOT_LIVE_ADMIN_RAW_OK=1.',
    'The account regime must remain private Regime A: account.regime=test, username MCBot, auth=offline.',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const code = await main();
  process.exitCode = code;
}
