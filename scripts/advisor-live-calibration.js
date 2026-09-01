#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  beginLiveEvidence,
  markLiveEvidenceIncomplete,
  writeLiveEvidenceJson,
} from './live-evidence-v2.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_LIVE_PLAN_PATH = path.join(ROOT, 'reports', 'advisor-live-plan.json');
const DEFAULT_EVIDENCE_PATH = path.join(ROOT, 'reports', 'advisor-live-calibration-evidence.json');
const DEFAULT_JSON_REPORT = path.join(ROOT, 'reports', 'advisor-live-calibration.json');
const DEFAULT_MD_REPORT = path.join(ROOT, 'reports', 'advisor-live-calibration.md');

export const LIVE_CALIBRATION_CASES = Object.freeze([
  Object.freeze({
    id: 'accepted_private_plan',
    proposalClass: 'accepted',
    source: 'reports/advisor-live-plan.json',
    objective: 'A real DeepSeek Regime A plan is schema-valid, activation-accepted, runs at least one skill, survives induced hostile flee, and reports a final outcome.',
  }),
  Object.freeze({
    id: 'activation_rejected_policy',
    proposalClass: 'rejected',
    source: 'reports/advisor-live-calibration-evidence.json',
    objective: 'A real DeepSeek proposal is rejected by deterministic activation policy without running executor skills.',
  }),
  Object.freeze({
    id: 'stale_plan_rejected',
    proposalClass: 'stale',
    source: 'reports/advisor-live-calibration-evidence.json',
    objective: 'A real DeepSeek proposal is rejected because the live snapshot changed before activation.',
  }),
  Object.freeze({
    id: 'unsafe_normal_work_rejected',
    proposalClass: 'unsafe',
    source: 'reports/advisor-live-calibration-evidence.json',
    objective: 'A real DeepSeek normal-work proposal is rejected while reactive survival or another unsafe state owns authority.',
  }),
  Object.freeze({
    id: 'recovery_proposal_bounded',
    proposalClass: 'recovery',
    source: 'reports/advisor-live-calibration-evidence.json',
    objective: 'A real DeepSeek or recovery-adjacent proposal produces exactly one bounded recovery attempt without bypassing survival.',
  }),
]);

export function parseAdvisorLiveCalibrationArgs(argv = []) {
  const opts = {
    livePlanPath: DEFAULT_LIVE_PLAN_PATH,
    evidencePath: DEFAULT_EVIDENCE_PATH,
    jsonReportPath: DEFAULT_JSON_REPORT,
    markdownReportPath: DEFAULT_MD_REPORT,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--live-plan') {
      opts.livePlanPath = path.resolve(requireValue(argv, ++i, '--live-plan'));
    } else if (arg === '--evidence') {
      opts.evidencePath = path.resolve(requireValue(argv, ++i, '--evidence'));
    } else if (arg === '--json') {
      opts.jsonReportPath = path.resolve(requireValue(argv, ++i, '--json'));
    } else if (arg === '--markdown') {
      opts.markdownReportPath = path.resolve(requireValue(argv, ++i, '--markdown'));
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }

  return opts;
}

export function buildAdvisorLiveCalibrationReport({
  livePlanReport = null,
  evidenceReport = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const cases = LIVE_CALIBRATION_CASES.map((definition) => evaluateCalibrationCase(definition, {
    livePlanReport,
    evidenceReport,
  }));
  const liveProvenClasses = cases
    .filter((entry) => entry.status === 'live-proven')
    .map((entry) => entry.proposalClass);
  const pendingClasses = cases
    .filter((entry) => entry.status !== 'live-proven')
    .map((entry) => entry.proposalClass);
  const allProven = pendingClasses.length === 0;

  return {
    generatedAt,
    ok: allProven,
    noApiCall: true,
    status: allProven ? 'live_calibration_complete' : 'live_calibration_pending',
    requiredProposalClasses: LIVE_CALIBRATION_CASES.map((definition) => definition.proposalClass),
    summary: {
      requiredCount: LIVE_CALIBRATION_CASES.length,
      liveProvenCount: liveProvenClasses.length,
      pendingCount: pendingClasses.length,
      liveProvenClasses,
      pendingClasses,
    },
    safety: {
      deterministicActivationRequired: true,
      reactiveSurvivalRequired: true,
      skillBoundaryRequired: true,
      allLiveEvidenceNoBypass: allProven && cases.every((entry) => entry.authority.noBypass === true),
    },
    cases,
    nextAction: nextCalibrationAction(cases),
  };
}

export function renderAdvisorLiveCalibration(report) {
  const lines = [
    '# Advisor Live Calibration',
    '',
    `Generated: ${report.generatedAt}`,
    `No DeepSeek/API call made by this reporter: ${report.noApiCall === true ? 'yes' : 'no'}`,
    `Status: ${report.status}`,
    `Overall: ${report.ok ? 'PASS' : 'PENDING'}`,
    '',
    '## Summary',
    '',
    `- required proposal classes: ${report.requiredProposalClasses.join(', ')}`,
    `- live-proven: ${report.summary.liveProvenCount}/${report.summary.requiredCount}`,
    `- pending classes: ${report.summary.pendingClasses.length > 0 ? report.summary.pendingClasses.join(', ') : 'none'}`,
    `- next action: ${report.nextAction}`,
    '',
    '## Cases',
    '',
    '| Case | Class | Status | Evidence | Missing |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const entry of report.cases || []) {
    lines.push([
      entry.id,
      entry.proposalClass,
      entry.status,
      entry.evidence || entry.source,
      entry.missing.length > 0 ? entry.missing.join('; ') : 'none',
    ].map(escapeTable).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', '## Safety Contract', '');
  lines.push('- Deterministic activation remains authoritative.');
  lines.push('- Reactive survival remains authoritative.');
  lines.push('- Live evidence must prove no DeepSeek proposal bypassed the skill-boundary queue.');
  lines.push('');
  return `${lines.join('\n')}`;
}

function evaluateCalibrationCase(definition, { livePlanReport, evidenceReport }) {
  if (definition.id === 'accepted_private_plan') {
    return evaluateAcceptedPrivatePlan(definition, livePlanReport);
  }
  return evaluateEvidenceCase(definition, evidenceForCase(evidenceReport, definition));
}

function evaluateAcceptedPrivatePlan(definition, report) {
  const missing = [];
  if (!report || typeof report !== 'object') {
    missing.push('reports/advisor-live-plan.json missing or unreadable');
  } else {
    if (report.ok !== true) missing.push('advisor live plan report ok=true');
    if (report.noApiCall !== false) missing.push('advisor live plan must include a real provider call');
    if (report.accountRegime !== 'test') missing.push('Regime A accountRegime=test');
    if (report.account?.username !== 'MCBot') missing.push('offline MCBot account evidence');
    if (report.account?.auth !== 'offline') missing.push('offline auth evidence');
    if (report.planner?.callMade !== true) missing.push('planner.callMade=true');
    if (report.planner?.schemaValid !== true) missing.push('planner.schemaValid=true');
    if (report.activation?.accepted !== true) missing.push('activation.accepted=true');
    if (Number(report.executor?.ranSkillCount || 0) < 1) missing.push('executor ran at least one skill');
    if (Number(report.executor?.failedSkillCount || 0) !== 0) missing.push('executor failedSkillCount=0');
    if (report.finalOutcome?.reported !== true) missing.push('finalOutcome.reported=true');
    if (report.costCeilingGuard?.verified !== true) missing.push('costCeilingGuard.verified=true');
    if (report.hostileFlee?.survived !== true) missing.push('hostileFlee.survived=true');
    if ((report.diagnostics?.failures || []).length > 0) missing.push('diagnostics.failures empty');
  }

  const liveProven = missing.length === 0;
  return {
    id: definition.id,
    proposalClass: definition.proposalClass,
    objective: definition.objective,
    source: definition.source,
    status: liveProven ? 'live-proven' : 'pending',
    evidence: liveProven
      ? `reports/advisor-live-plan.json status=${report.status}; skills=${(report.executor.skillsExecuted || []).join(',')}; costUsd=${report.cost?.usd ?? 'unknown'}; hostileFleeSurvived=true`
      : null,
    authority: {
      schemaValid: report?.planner?.schemaValid === true,
      activationBoundary: report?.activation?.accepted === true,
      skillBoundary: Number(report?.executor?.ranSkillCount || 0) >= 1,
      reactiveSurvival: report?.hostileFlee?.survived === true,
      noBypass: liveProven,
    },
    missing,
  };
}

function evaluateEvidenceCase(definition, record) {
  const missing = [];
  if (!record || typeof record !== 'object') {
    missing.push(`sanitized live evidence for ${definition.id}`);
  } else {
    if (record.liveProven !== true && record.status !== 'live-proven') missing.push('status=live-proven');
    if (String(record.proposalClass || record.class || '') !== definition.proposalClass) {
      missing.push(`proposalClass=${definition.proposalClass}`);
    }
    if (record.planner?.callMade !== true) missing.push('planner.callMade=true');
    if (record.activationBoundary !== true && record.skillBoundary !== true && record.noBypass !== true) {
      missing.push('deterministic activation/skill boundary evidence');
    }
    if (record.reactiveAuthority !== true && record.reactiveSurvival !== true && record.noBypass !== true) {
      missing.push('reactive survival authority evidence');
    }
    missing.push(...proposalClassMissing(definition.proposalClass, record));
  }

  const liveProven = missing.length === 0;
  return {
    id: definition.id,
    proposalClass: definition.proposalClass,
    objective: definition.objective,
    source: definition.source,
    status: liveProven ? 'live-proven' : 'pending',
    evidence: liveProven ? sanitizedEvidence(record) : null,
    authority: {
      schemaValid: record?.planner?.schemaValid !== false,
      activationBoundary: record?.activationBoundary === true || record?.skillBoundary === true || record?.noBypass === true,
      skillBoundary: record?.skillBoundary === true || record?.noBypass === true,
      reactiveSurvival: record?.reactiveAuthority === true || record?.reactiveSurvival === true || record?.noBypass === true,
      noBypass: record?.noBypass === true,
    },
    missing,
  };
}

function proposalClassMissing(proposalClass, record) {
  if (!record || typeof record !== 'object') return [];
  const missing = [];
  const activation = record.activation || {};
  const executor = record.executor || {};
  const reasonText = [
    record.reason,
    record.evidence,
    activation.reason,
    ...(activation.safetyReasons || []),
    ...(activation.staleReasons || []),
  ].filter(Boolean).join(' ');

  if (proposalClass === 'rejected') {
    if (activation.accepted !== false) missing.push('activation.accepted=false');
    if (Number(record.planner?.acceptedSteps || record.acceptedSteps || 0) < 1) missing.push('planner.acceptedSteps>=1');
    if (Number(executor.ranSkillCount || 0) !== 0) missing.push('executor.ranSkillCount=0');
  } else if (proposalClass === 'stale') {
    if (activation.accepted !== false) missing.push('activation.accepted=false');
    if (!/stale/i.test(reasonText)) missing.push('stale activation reason');
  } else if (proposalClass === 'unsafe') {
    if (activation.accepted !== false) missing.push('activation.accepted=false');
    if (!/(unsafe|safety|reactive|hostile|oxygen|health|water|lava|fire)/i.test(reasonText)) {
      missing.push('unsafe/safety activation reason');
    }
  } else if (proposalClass === 'recovery') {
    const skills = executor.skillsExecuted || record.skillsExecuted || [];
    if (activation.accepted !== true) missing.push('activation.accepted=true');
    if (!skills.includes('recover_drops')) missing.push('recover_drops skill evidence');
    if (record.recovery?.singleAttemptBounded !== true) missing.push('single bounded recovery attempt evidence');
  }
  return missing;
}

function evidenceForCase(report, definition) {
  const cases = report?.cases || {};
  if (Array.isArray(cases)) {
    return cases.find((entry) => entry.id === definition.id || entry.proposalClass === definition.proposalClass) || null;
  }
  return cases[definition.id] || cases[definition.proposalClass] || null;
}

function nextCalibrationAction(cases) {
  const firstPending = cases.find((entry) => entry.status !== 'live-proven');
  if (!firstPending) return 'advance_to_benchmark_ladder';
  return `run_private_live_advisor_calibration_case:${firstPending.id}`;
}

function sanitizedEvidence(record) {
  return String(record.evidence || record.logPath || record.summary || 'sanitized live evidence recorded')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data, options = {}) {
  writeLiveEvidenceJson(filePath, data, {
    repositoryRoot: ROOT,
    entrypointPath: __filename,
    ...options,
  });
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function usageText() {
  return [
    'usage: node scripts/advisor-live-calibration.js [--live-plan reports/advisor-live-plan.json]',
    '       [--evidence reports/advisor-live-calibration-evidence.json]',
    '       [--json reports/advisor-live-calibration.json]',
    '       [--markdown reports/advisor-live-calibration.md] [--dry-run]',
    '',
    'This reporter is offline-only. It reads sanitized evidence files and never runs Minecraft, RCON, or DeepSeek.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseAdvisorLiveCalibrationArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.help) {
    console.log(usageText());
    return 0;
  }

  let livePlanReport = null;
  let evidenceReport = null;
  let report = null;
  try {
    livePlanReport = readJson(opts.livePlanPath);
    evidenceReport = readJson(opts.evidencePath);
    report = buildAdvisorLiveCalibrationReport({ livePlanReport, evidenceReport });
    beginLiveEvidence(report, {
      repositoryRoot: ROOT,
      entrypointPath: __filename,
      effectiveConfig: { options: opts },
      inputRecords: [livePlanReport, evidenceReport],
      world: livePlanReport?.world || evidenceReport?.world || null,
    });

    if (opts.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        report,
      }, null, 2));
      return 0;
    }

    const jsonPath = path.resolve(opts.jsonReportPath);
    const markdownPath = path.resolve(opts.markdownReportPath);
    const reportPathsCollide = process.platform === 'win32'
      ? jsonPath.toLowerCase() === markdownPath.toLowerCase()
      : jsonPath === markdownPath;
    if (reportPathsCollide) throw new Error('JSON and Markdown report paths must be distinct');

    writeJson(opts.jsonReportPath, report, {
      inputRecords: [livePlanReport, evidenceReport],
      world: livePlanReport?.world || evidenceReport?.world || null,
      final: true,
    });
    fs.mkdirSync(path.dirname(opts.markdownReportPath), { recursive: true });
    fs.writeFileSync(opts.markdownReportPath, renderAdvisorLiveCalibration(report));
    process.stdout.write(`advisor-live-calibration: wrote ${path.relative(ROOT, opts.jsonReportPath)} and ${path.relative(ROOT, opts.markdownReportPath)}\n`);
    return 0;
  } catch (err) {
    report ||= {
      ok: false,
      status: 'advisor_live_calibration_incomplete',
      generatedAt: new Date().toISOString(),
    };
    report.ok = false;
    report.status = 'advisor_live_calibration_incomplete';
    report.failure = err?.message || String(err);
    beginLiveEvidence(report, {
      repositoryRoot: ROOT,
      entrypointPath: __filename,
      effectiveConfig: { options: opts },
      inputRecords: [livePlanReport, evidenceReport],
      world: livePlanReport?.world || evidenceReport?.world || null,
    });
    markLiveEvidenceIncomplete(report, 'wrapper_fatal_error');
    if (!opts.dryRun) {
      writeJson(opts.jsonReportPath, report, {
        inputRecords: [livePlanReport, evidenceReport],
        world: livePlanReport?.world || evidenceReport?.world || null,
        final: true,
      });
    }
    console.error(report.failure);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const code = await main();
  process.exitCode = code;
}
