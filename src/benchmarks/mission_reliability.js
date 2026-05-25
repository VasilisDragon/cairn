import { runMissionLoop, evaluateMissionCheckpoint } from '../runtime/mission_control.js';
import { createReturnPlan, createRouteEstimate } from '../runtime/mission_return.js';
import { createTaskBudget } from '../runtime/task_budget.js';

export const MISSION_RELIABILITY_BENCHMARK_ID = 'long_horizon_mission_reliability';

export async function buildMissionReliabilityBenchmarkReport({
  generatedAt = new Date().toISOString(),
} = {}) {
  const cases = [
    await timedFishingDepositReturnCase(),
    await timedMiningInventoryPressureReturnCase(),
    dynamicSlowRouteReserveCase(),
    await reactivePreemptCase(),
    await missingReturnHandlerCase(),
  ];
  const passCount = cases.filter((entry) => entry.status === 'pass').length;
  const failCount = cases.length - passCount;

  return {
    ok: failCount === 0,
    id: MISSION_RELIABILITY_BENCHMARK_ID,
    status: failCount === 0 ? 'offline-covered' : 'failing',
    noApiCall: true,
    generatedAt,
    scope: 'scaled-offline-benchmark',
    summary: {
      caseCount: cases.length,
      passCount,
      failCount,
      returnByDeadlineCases: cases.filter((entry) => entry.metrics?.returnedBeforeDeadline === true).length,
      depositCases: cases.filter((entry) => Number(entry.metrics?.depositCount || 0) > 0).length,
      preemptCases: cases.filter((entry) => entry.metrics?.preempted === true).length,
      failClosedCases: cases.filter((entry) => entry.metrics?.failedClosed === true).length,
    },
    evidence: {
      scaledOffline: true,
      privateLiveSoaksStillRequired: true,
      note: 'This benchmark proves deterministic mission-controller behavior with simulated time. It does not claim multi-hour live Minecraft endurance.',
    },
    cases,
    nextAction: failCount === 0
      ? 'Run bounded private live fishing/mining return-by-deadline soaks before claiming long-horizon live reliability.'
      : 'Fix failing mission benchmark cases before adding live soak claims.',
  };
}

export function renderMissionReliabilityBenchmarkReport(report = {}) {
  const lines = [
    '# Long-Horizon Mission Reliability Benchmark',
    '',
    `Generated: ${report.generatedAt || 'unknown'}`,
    `No DeepSeek/API call made: ${report.noApiCall === true ? 'yes' : 'no'}`,
    `Status: ${report.status || 'unknown'}`,
    `Overall: ${report.ok === true ? 'PASS' : 'FAIL'}`,
    '',
    '## Summary',
    '',
    `- cases: ${report.summary?.caseCount ?? 0}`,
    `- passed: ${report.summary?.passCount ?? 0}`,
    `- failed: ${report.summary?.failCount ?? 0}`,
    `- returned before deadline cases: ${report.summary?.returnByDeadlineCases ?? 0}`,
    `- deposit cases: ${report.summary?.depositCases ?? 0}`,
    `- preempt cases: ${report.summary?.preemptCases ?? 0}`,
    `- fail-closed cases: ${report.summary?.failClosedCases ?? 0}`,
    '',
    '## Scope',
    '',
    `- scaled offline benchmark: ${report.evidence?.scaledOffline === true ? 'yes' : 'no'}`,
    `- private live soaks still required: ${report.evidence?.privateLiveSoaksStillRequired === true ? 'yes' : 'no'}`,
    `- note: ${report.evidence?.note || 'none'}`,
    '',
    '## Cases',
    '',
    '| Case | Status | Objective | Evidence | Key metrics |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of report.cases || []) {
    lines.push([
      entry.id,
      entry.status,
      entry.objective,
      entry.evidence,
      metricSummary(entry.metrics),
    ].map(escapeTable).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', '## Next Action', '', `- ${report.nextAction || 'continue mission reliability work'}`, '');
  return lines.join('\n');
}

async function timedFishingDepositReturnCase() {
  let nowMs = 0;
  let cod = 0;
  let lastDepositAtMs = 0;
  const deposits = [];
  const taskBudget = createTaskBudget({
    label: 'scaled_2_5h_fishing',
    durationMs: 9_000_000,
    returnReserveMs: 600_000,
  }, nowMs);
  const returnPlan = createReturnPlan({
    taskBudget,
    routeEstimate: createRouteEstimate({
      fallbackTravelMs: 300_000,
      observedTravelMs: 180_000,
      safetyMultiplier: 1.5,
      overheadMs: 30_000,
    }),
  }, nowMs);

  const result = await runMissionLoop({
    now: () => nowMs,
    maxIterations: 20,
    getState: () => ({
      taskBudget,
      returnPlan,
      inventoryCounts: { cod },
      trackedItems: ['cod'],
      lastDepositAtMs,
      depositPolicy: {
        minTrackedItemCount: 3,
        depositEveryMs: 2_000_000,
      },
    }),
    work: async () => {
      cod += 1;
      nowMs += 1_200_000;
      return { ok: true, reason: `caught cod ${cod}` };
    },
    deposit: async ({ depositItems }) => {
      deposits.push({ atMs: nowMs, items: { ...depositItems } });
      cod = 0;
      lastDepositAtMs = nowMs;
      return { ok: true, reason: 'deposited catches' };
    },
    returnHome: async () => {
      nowMs += returnPlan.routeEstimate.estimatedTravelMs;
      return { ok: true, reason: 'returned to fishing chest', returnedAtMs: nowMs };
    },
  });

  const returnedBeforeDeadline = result.ok === true && nowMs <= taskBudget.deadlineAtMs;
  return benchmarkCase({
    id: 'scaled_fishing_deposit_return',
    objective: 'A scaled 2.5-hour fishing mission deposits catches and returns before the deadline.',
    passed: result.ok === true && result.reason === 'return-reserve-reached' && deposits.length >= 2 && returnedBeforeDeadline,
    evidence: result.reason || 'no result reason',
    metrics: {
      depositCount: deposits.length,
      returnedBeforeDeadline,
      returnedAtMs: nowMs,
      deadlineAtMs: taskBudget.deadlineAtMs,
      returnByMs: returnPlan.returnByMs,
      eventCount: result.events?.length || 0,
    },
  });
}

async function timedMiningInventoryPressureReturnCase() {
  let nowMs = 0;
  let diamonds = 0;
  let iron = 0;
  let usedSlots = 28;
  let lastDepositAtMs = 0;
  const deposits = [];
  const taskBudget = createTaskBudget({
    label: 'scaled_2h_mining',
    durationMs: 7_200_000,
    returnReserveMs: 900_000,
  }, nowMs);
  const returnPlan = createReturnPlan({
    taskBudget,
    routeEstimate: createRouteEstimate({
      fallbackTravelMs: 480_000,
      observations: [
        { label: 'base-to-mine', travelMs: 500_000 },
        { label: 'mine-to-base', travelMs: 620_000 },
      ],
      safetyMultiplier: 1.3,
      overheadMs: 30_000,
    }),
  }, nowMs);

  const result = await runMissionLoop({
    now: () => nowMs,
    maxIterations: 20,
    getState: () => ({
      taskBudget,
      returnPlan,
      inventoryCounts: { diamond: diamonds, raw_iron: iron },
      trackedItems: ['diamond', 'raw_iron'],
      usedSlots,
      lastDepositAtMs,
      depositPolicy: {
        maxUsedSlots: 35,
        minTrackedItemCount: 9,
      },
    }),
    work: async () => {
      diamonds += 1;
      iron += 2;
      usedSlots += 3;
      nowMs += 700_000;
      return { ok: true, reason: 'mined visible ore batch' };
    },
    deposit: async ({ depositItems }) => {
      deposits.push({ atMs: nowMs, items: { ...depositItems } });
      diamonds = 0;
      iron = 0;
      usedSlots = 24;
      lastDepositAtMs = nowMs;
      return { ok: true, reason: 'deposited mined items' };
    },
    returnHome: async () => {
      nowMs += returnPlan.routeEstimate.estimatedTravelMs;
      return { ok: true, reason: 'returned to mining chest', returnedAtMs: nowMs };
    },
  });

  const returnedBeforeDeadline = result.ok === true && nowMs <= taskBudget.deadlineAtMs;
  return benchmarkCase({
    id: 'scaled_mining_inventory_pressure_return',
    objective: 'A scaled two-hour mining mission deposits under inventory pressure and returns before the deadline.',
    passed: result.ok === true && deposits.length >= 1 && returnedBeforeDeadline,
    evidence: result.reason || 'no result reason',
    metrics: {
      depositCount: deposits.length,
      returnedBeforeDeadline,
      returnedAtMs: nowMs,
      deadlineAtMs: taskBudget.deadlineAtMs,
      returnByMs: returnPlan.returnByMs,
      reserveMs: returnPlan.reserveMs,
      eventCount: result.events?.length || 0,
    },
  });
}

function dynamicSlowRouteReserveCase() {
  const taskBudget = createTaskBudget({
    label: 'slow_route_return',
    durationMs: 600_000,
    returnReserveMs: 60_000,
  }, 0);
  const returnPlan = createReturnPlan({
    taskBudget,
    routeEstimate: createRouteEstimate({
      fallbackTravelMs: 60_000,
      observedTravelMs: 260_000,
      safetyMultiplier: 1.5,
      overheadMs: 20_000,
    }),
  }, 100_000);
  const decision = evaluateMissionCheckpoint({
    taskBudget,
    returnPlan,
    inventoryCounts: { cod: 64 },
    trackedItems: ['cod'],
    depositPolicy: { minTrackedItemCount: 1 },
  }, returnPlan.returnByMs);

  return benchmarkCase({
    id: 'dynamic_slow_route_return_outranks_deposit',
    objective: 'A slow observed route expands the return reserve and makes return outrank a deposit.',
    passed: decision.action === 'return'
      && decision.reason === 'return-reserve-reached'
      && returnPlan.reserveMs > taskBudget.returnReserveMs,
    evidence: `${decision.action}:${decision.reason}`,
    metrics: {
      reserveMs: returnPlan.reserveMs,
      originalReturnReserveMs: taskBudget.returnReserveMs,
      returnByMs: returnPlan.returnByMs,
      action: decision.action,
    },
  });
}

async function reactivePreemptCase() {
  const taskBudget = createTaskBudget({ durationMs: 600_000, returnReserveMs: 60_000 }, 0);
  const result = await runMissionLoop({
    now: () => 30_000,
    maxIterations: 2,
    getState: () => ({ taskBudget }),
    work: async () => ({ preempted: true, reason: 'reactive hostile flee preempted mission work' }),
  });

  return benchmarkCase({
    id: 'reactive_preempt_preserves_mission_state',
    objective: 'Reactive preemption exits as preempted instead of being converted into a mission failure.',
    passed: result.preempted === true && /reactive hostile flee/.test(result.reason || ''),
    evidence: result.reason || 'no preempt reason',
    metrics: {
      preempted: result.preempted === true,
      eventCount: result.events?.length || 0,
    },
  });
}

async function missingReturnHandlerCase() {
  const taskBudget = createTaskBudget({ durationMs: 600_000, returnReserveMs: 60_000 }, 0);
  const result = await runMissionLoop({
    now: () => 550_000,
    maxIterations: 2,
    getState: () => ({ taskBudget }),
    work: async () => ({ ok: true, reason: 'should not work after return reserve' }),
  });

  return benchmarkCase({
    id: 'missing_return_handler_fails_closed',
    objective: 'A mission that reaches return reserve without a return handler fails closed with an exact reason.',
    passed: result.ok === false && result.reason === 'mission return requested but no returnHome handler is configured',
    evidence: result.reason || 'no failure reason',
    metrics: {
      failedClosed: result.ok === false,
      eventCount: result.events?.length || 0,
    },
  });
}

function benchmarkCase({ id, objective, passed, evidence, metrics = {} }) {
  return {
    id,
    objective,
    status: passed ? 'pass' : 'fail',
    evidence,
    metrics,
  };
}

function metricSummary(metrics = {}) {
  return Object.entries(metrics)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ') || 'none';
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

export default {
  MISSION_RELIABILITY_BENCHMARK_ID,
  buildMissionReliabilityBenchmarkReport,
  renderMissionReliabilityBenchmarkReport,
};
