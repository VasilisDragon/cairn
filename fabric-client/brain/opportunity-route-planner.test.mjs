import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPPORTUNITY_ROUTE_LIMITS,
  OpportunityRoutePlanner,
  planOpportunityRoutes,
} from './opportunity-route-planner.js';

function ledger(deficit = {}) {
  return {
    owned: {},
    reserved: { planks: 6 },
    deficit,
  };
}

function baseline(overrides = {}) {
  return {
    choiceId: 'proven_baseline',
    p75Seconds: 600,
    reliability: 0.9,
    failureUpperBound: 0.1,
    components: [],
    ...overrides,
  };
}

function opportunity(id, overrides = {}) {
  return {
    id,
    kind: 'village',
    safe: true,
    ready: true,
    feasible: true,
    reliability: 0.95,
    failureUpperBound: 0.02,
    travelP75Seconds: 20,
    executionP75Seconds: 20,
    uncertaintyPenaltySeconds: 5,
    estimatedGain: {},
    ...overrides,
  };
}

function resourceBaseline(deficit, components, overrides = {}) {
  return {
    ledger: ledger(deficit),
    baseline: baseline({ components, ...overrides }),
  };
}

test('no discoveries returns the exact deterministic baseline recommendation', () => {
  const result = planOpportunityRoutes({
    ledger: ledger({ logs: 20 }),
    baseline: baseline(),
    opportunities: [],
  });

  assert.equal(result.shouldSwitch, false);
  assert.equal(result.reason, 'no_feasible_opportunities');
  assert.equal(result.recommendation, result.baseline);
  assert.equal(result.recommendation.choiceId, 'proven_baseline');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.expandedStates, 1);
});

test('adjacent valuable village beats baseline while the same distant village does not', () => {
  const model = resourceBaseline({ nutrition: 18 }, [
    { id: 'food', resource: 'nutrition', mode: 'proportional', p75Seconds: 480 },
  ]);
  const near = opportunity('village:near', {
    travelP75Seconds: 15,
    executionP75Seconds: 35,
    estimatedGain: { nutrition: 18 },
  });
  const far = opportunity('village:far', {
    travelP75Seconds: 500,
    executionP75Seconds: 35,
    estimatedGain: { nutrition: 18 },
  });
  const result = planOpportunityRoutes({ ...model, opportunities: [far, near] });

  assert.equal(result.shouldSwitch, true);
  assert.deepEqual(result.recommendation.opportunityIds, ['village:near']);
  assert.ok(result.recommendation.conservativeBenefitSeconds >= 45);
  const farPlan = result.candidates.find((entry) => entry.opportunityIds.join() === 'village:far');
  assert.equal(farPlan.thresholdEligible, false);
});

test('village hay retains value when its inspected chest is empty', () => {
  const model = resourceBaseline({ nutrition: 18 }, [
    { id: 'food', resource: 'nutrition', mode: 'proportional', p75Seconds: 420 },
  ]);
  const hay = opportunity('village:hay', {
    estimatedGain: { nutrition: 18 },
    travelP75Seconds: 25,
    executionP75Seconds: 45,
  });
  const emptyChest = opportunity('village:empty_chest', {
    kind: 'container',
    estimatedGain: {},
    travelP75Seconds: 5,
    executionP75Seconds: 10,
  });
  const result = planOpportunityRoutes({ ...model, opportunities: [emptyChest, hay] });

  assert.equal(result.shouldSwitch, true);
  assert.deepEqual(result.recommendation.opportunityIds, ['village:hay']);
  const emptyOnly = result.candidates.find((entry) => entry.opportunityIds.join() === 'village:empty_chest');
  assert.equal(emptyOnly.conservativeBenefitSeconds < 0, true);
});

test('verified iron-pickaxe chest eliminates its modeled baseline step but remains unowned', () => {
  const model = resourceBaseline({ ironPickaxe: 1 }, [
    { id: 'iron_tool', resource: 'ironPickaxe', mode: 'all_or_nothing', p75Seconds: 500 },
  ]);
  const result = planOpportunityRoutes({
    ...model,
    opportunities: [opportunity('chest:smith', {
      kind: 'verified_container',
      estimatedGain: { ironPickaxe: 1 },
      travelP75Seconds: 25,
      executionP75Seconds: 20,
    })],
  });

  assert.equal(result.shouldSwitch, true);
  assert.equal(result.recommendation.baselineRemainingTimeSeconds, 100);
  assert.equal(result.recommendation.estimatedDeficitClearedForRanking, true);
  assert.equal(result.recommendation.authoritativeGoalSatisfied, false);
  assert.deepEqual(result.recommendation.authoritativeDeficit, { ironPickaxe: 1 });
  assert.equal(result.recommendation.requiresAuthoritativeVerification, true);
  assert.equal(Object.hasOwn(result.recommendation, 'estimatedGoalSatisfied'), false);
});

test('partial ingots reduce baseline continuation without falsely completing it', () => {
  const model = resourceBaseline({ ironIngots: 24 }, [
    { id: 'armor_iron', resource: 'ironIngots', mode: 'proportional', p75Seconds: 480 },
  ]);
  const result = planOpportunityRoutes({
    ...model,
    opportunities: [opportunity('chest:partial_iron', {
      estimatedGain: { ironIngots: 6 },
      travelP75Seconds: 10,
      executionP75Seconds: 10,
    })],
  });
  const plan = result.candidates[0];

  assert.equal(plan.estimatedResidualDeficit.ironIngots, 18);
  assert.equal(plan.baselineRemainingTimeSeconds, 480);
  assert.equal(plan.estimatedDeficitClearedForRanking, false);
  assert.equal(plan.authoritativeGoalSatisfied, false);
});

test('three guaranteed golem iron is modeled as partial yield, never owned completion', () => {
  const model = resourceBaseline({ ironIngots: 24 }, [
    { id: 'armor_iron', resource: 'ironIngots', mode: 'proportional', p75Seconds: 540 },
  ]);
  const result = planOpportunityRoutes({
    ...model,
    opportunities: [opportunity('golem:uuid', {
      kind: 'golem',
      conservativeEstimatedGain: { ironIngots: 3 },
      travelP75Seconds: 10,
      executionP75Seconds: 30,
    })],
  });
  const plan = result.candidates[0];

  assert.equal(plan.estimatedGain.ironIngots, 3);
  assert.equal(plan.estimatedResidualDeficit.ironIngots, 21);
  assert.deepEqual(plan.authoritativeDeficit, { ironIngots: 24 });
  assert.equal(plan.estimatedDeficitClearedForRanking, false);
});

test('exposed iron can remove an all-or-nothing descent step only in the cost model', () => {
  const model = resourceBaseline({ rawIron: 3 }, [
    { id: 'descend_for_iron', resource: 'rawIron', mode: 'all_or_nothing', p75Seconds: 500 },
  ]);
  const result = planOpportunityRoutes({
    ...model,
    opportunities: [opportunity('ore:exposed_iron', {
      kind: 'exposed_iron',
      estimatedGain: { rawIron: 3 },
      travelP75Seconds: 12,
      executionP75Seconds: 20,
    })],
  });

  assert.equal(result.shouldSwitch, true);
  assert.equal(result.recommendation.baselineRemainingTimeSeconds, 100);
  assert.equal(result.recommendation.estimatedDeficitClearedForRanking, true);
  assert.equal(result.recommendation.authoritativeGoalSatisfied, false);
});

test('unsafe night village and less-reliable shortcut are hard-vetoed', () => {
  const result = planOpportunityRoutes({
    ledger: ledger({ nutrition: 18 }),
    baseline: baseline(),
    opportunities: [
      opportunity('village:night', {
        safe: false,
        safety: { safe: false, reason: 'night hostiles' },
        estimatedGain: { nutrition: 18 },
      }),
      opportunity('village:risky', {
        reliability: 0.89,
        estimatedGain: { nutrition: 18 },
      }),
    ],
  });

  assert.equal(result.shouldSwitch, false);
  assert.deepEqual(result.rejectedOpportunities, [
    { id: 'village:night', reason: 'unsafe:night_hostiles' },
    { id: 'village:risky', reason: 'reliability_below_baseline' },
  ]);
});

test('opportunity invalidated during travel is rejected by revision before scoring', () => {
  const result = planOpportunityRoutes({
    ledger: ledger({ logs: 20 }),
    baseline: baseline(),
    opportunities: [opportunity('village:changed', {
      expectedRevision: 4,
      observedRevision: 5,
      estimatedGain: { logs: 20 },
    })],
  });

  assert.equal(result.shouldSwitch, false);
  assert.deepEqual(result.rejectedOpportunities, [{ id: 'village:changed', reason: 'stale_revision' }]);
});

test('planning context rejects a discovery from a stale world or ledger revision', () => {
  const result = planOpportunityRoutes({
    context: { worldId: 'world:a', dimension: 'overworld', memoryRevision: 8, ledgerRevision: 3 },
    ledger: ledger({ logs: 20 }),
    baseline: baseline(),
    opportunities: [opportunity('village:old_world', {
      worldId: 'world:b',
      dimension: 'overworld',
      memoryRevision: 8,
      ledgerRevision: 3,
      estimatedGain: { logs: 20 },
    })],
  });

  assert.equal(result.recommendationEligible, false);
  assert.equal(result.selected, result.baseline);
  assert.equal(result.evaluated, result.candidates);
  assert.deepEqual(result.rejectedOpportunities, [{ id: 'village:old_world', reason: 'stale_context' }]);
  assert.deepEqual(result.reasons, { decision: 'no_feasible_opportunities', rejected: { stale_context: 1 } });
  assert.equal(result.baseline.costBreakdown.totalSeconds, 600);
});

test('partial gains from multiple detours feed one hybrid baseline continuation', () => {
  const model = resourceBaseline({ ironIngots: 12, nutrition: 18 }, [
    { id: 'armor', resource: 'ironIngots', mode: 'proportional', p75Seconds: 300 },
    { id: 'food', resource: 'nutrition', mode: 'proportional', p75Seconds: 200 },
  ]);
  const result = planOpportunityRoutes({
    ...model,
    opportunities: [
      opportunity('hay', { estimatedGain: { nutrition: 18 }, travelP75Seconds: 5, executionP75Seconds: 10 }),
      opportunity('iron', { estimatedGain: { ironIngots: 6 }, travelP75Seconds: 5, executionP75Seconds: 10 }),
    ],
  });
  const hybrid = result.candidates.find((entry) => entry.opportunityIds.length === 2);

  assert.ok(hybrid);
  assert.deepEqual(hybrid.estimatedResidualDeficit, { ironIngots: 6, nutrition: 0 });
  assert.equal(hybrid.baselineRemainingTimeSeconds, 250);
  assert.equal(hybrid.authoritativeGoalSatisfied, false);
});

test('failure penalty uses baseline remaining time before each partial gain', () => {
  const model = resourceBaseline({ ironIngots: 10 }, [
    { id: 'iron', resource: 'ironIngots', mode: 'proportional', p75Seconds: 500 },
  ]);
  const result = planOpportunityRoutes({
    ...model,
    opportunities: [opportunity('iron:half', {
      failureUpperBound: 0.1,
      estimatedGain: { ironIngots: 5 },
      travelP75Seconds: 0,
      executionP75Seconds: 0,
      uncertaintyPenaltySeconds: 0,
    })],
  });
  const plan = result.candidates[0];

  assert.equal(plan.failurePenaltySeconds, 60);
  assert.equal(plan.baselineRemainingTimeSeconds, 350);
  assert.equal(plan.scoreSeconds, 410);
});

test('both fifteen-percent and forty-five-second conservative thresholds are mandatory', () => {
  const percentageMiss = planOpportunityRoutes({
    ledger: ledger({ logs: 1 }),
    baseline: baseline({ p75Seconds: 400, components: [
      { id: 'wood', resource: 'logs', mode: 'all_or_nothing', p75Seconds: 50 },
    ] }),
    opportunities: [opportunity('small_percent', {
      failureUpperBound: 0,
      uncertaintyPenaltySeconds: 0,
      travelP75Seconds: 0,
      executionP75Seconds: 0,
      estimatedGain: { logs: 1 },
    })],
  });
  assert.equal(percentageMiss.candidates[0].conservativeBenefitSeconds, 50);
  assert.equal(percentageMiss.candidates[0].thresholdEligible, false);

  const secondsMiss = planOpportunityRoutes({
    ledger: ledger({ logs: 1 }),
    baseline: baseline({ p75Seconds: 200, components: [
      { id: 'wood', resource: 'logs', mode: 'all_or_nothing', p75Seconds: 40 },
    ] }),
    opportunities: [opportunity('small_seconds', {
      failureUpperBound: 0,
      uncertaintyPenaltySeconds: 0,
      travelP75Seconds: 0,
      executionP75Seconds: 0,
      estimatedGain: { logs: 1 },
    })],
  });
  assert.equal(secondsMiss.candidates[0].conservativeBenefitFraction, 0.2);
  assert.equal(secondsMiss.candidates[0].thresholdEligible, false);
});

test('candidate order does not affect admissions, costs, paths, or recommendation', () => {
  const model = resourceBaseline({ logs: 8, nutrition: 18 }, [
    { id: 'food', resource: 'nutrition', mode: 'proportional', p75Seconds: 240 },
    { id: 'wood', resource: 'logs', mode: 'proportional', p75Seconds: 240 },
  ]);
  const candidates = [
    opportunity('c', { estimatedGain: { logs: 4 }, travelFrom: { a: 1, b: 2 } }),
    opportunity('a', { estimatedGain: { nutrition: 18 }, travelFrom: { b: 3, c: 4 } }),
    opportunity('b', { estimatedGain: { logs: 4 }, travelFrom: { a: 5, c: 6 } }),
  ];
  const forward = planOpportunityRoutes({ ...model, opportunities: candidates });
  const reversed = planOpportunityRoutes({ ...model, opportunities: [...candidates].reverse() });

  assert.deepEqual(reversed, forward);
});

test('dynamic-programming bound covers all eight opportunities through three edges', () => {
  const opportunities = Array.from({ length: 8 }, (_, index) => opportunity(`option:${index}`, {
    estimatedGain: { logs: 1 },
  }));
  const result = new OpportunityRoutePlanner().plan({
    ledger: ledger({ logs: 20 }),
    baseline: baseline({ components: [
      { id: 'wood', resource: 'logs', mode: 'proportional', p75Seconds: 500 },
    ] }),
    opportunities,
  });

  assert.equal(result.consideredOpportunityIds.length, 8);
  assert.equal(result.expandedStates, 233);
  assert.ok(result.expandedStates <= OPPORTUNITY_ROUTE_LIMITS.maxExpandedStates);
  assert.equal(Math.max(...result.candidates.map((entry) => entry.detourEdges)), 3);
  assert.equal(result.candidates.length, 232);
});

test('compound detour reliability must remain no worse than the baseline', () => {
  const result = planOpportunityRoutes({
    ledger: ledger({ logs: 3 }),
    baseline: baseline({ components: [
      { id: 'wood', resource: 'logs', mode: 'proportional', p75Seconds: 540 },
    ] }),
    opportunities: ['a', 'b', 'c'].map((id) => opportunity(id, {
      reliability: 0.95,
      failureUpperBound: 0,
      uncertaintyPenaltySeconds: 0,
      travelP75Seconds: 0,
      executionP75Seconds: 0,
      estimatedGain: { logs: 1 },
    })),
  });
  const twoEdge = result.candidates.find((entry) => entry.detourEdges === 2);
  const threeEdge = result.candidates.find((entry) => entry.detourEdges === 3);

  assert.equal(twoEdge.reliability, 0.95 * 0.95);
  assert.equal(twoEdge.thresholdEligible, true);
  assert.ok(threeEdge.reliability < result.baseline.reliability);
  assert.equal(threeEdge.thresholdEligible, false);
});

test('more than eight opportunities are admitted by deterministic standalone value', () => {
  const opportunities = Array.from({ length: 10 }, (_, index) => opportunity(`option:${index}`, {
    travelP75Seconds: index * 10,
    estimatedGain: { logs: 2 },
  })).reverse();
  const result = planOpportunityRoutes({
    ledger: ledger({ logs: 20 }),
    baseline: baseline({ components: [
      { id: 'wood', resource: 'logs', mode: 'proportional', p75Seconds: 500 },
    ] }),
    opportunities,
  });

  assert.deepEqual(result.consideredOpportunityIds, Array.from({ length: 8 }, (_, index) => `option:${index}`));
  assert.deepEqual(result.rejectedOpportunities, [
    { id: 'option:8', reason: 'opportunity_limit' },
    { id: 'option:9', reason: 'opportunity_limit' },
  ]);
});

test('duplicate identities and unready or infeasible executors fail closed', () => {
  const duplicate = opportunity('same');
  const result = planOpportunityRoutes({
    ledger: ledger({ logs: 20 }),
    baseline: baseline(),
    opportunities: [
      duplicate,
      { ...duplicate },
      opportunity('unready', { ready: false, readiness: { ready: false, reason: 'missing executor' } }),
      opportunity('infeasible', { feasible: false, feasibility: { feasible: false, reason: 'budget' } }),
    ],
  });

  assert.deepEqual(result.rejectedOpportunities, [
    { id: 'infeasible', reason: 'infeasible:budget' },
    { id: 'same', reason: 'duplicate_id' },
    { id: 'unready', reason: 'unready:missing_executor' },
  ]);
});

test('malformed reliability, cost, failure, and estimated counts cannot become free shortcuts', () => {
  const result = planOpportunityRoutes({
    ledger: ledger({ logs: 20 }),
    baseline: baseline(),
    opportunities: [
      opportunity('bad_reliability', { reliability: 'certain' }),
      opportunity('bad_cost', { travelP75Seconds: -1 }),
      opportunity('bad_failure', { failureUpperBound: 1.1 }),
      opportunity('bad_gain', { estimatedGain: { logs: 0.5 } }),
    ],
  });

  assert.deepEqual(result.rejectedOpportunities, [
    { id: 'bad_cost', reason: 'invalid_cost' },
    { id: 'bad_failure', reason: 'invalid_failure_upper_bound' },
    { id: 'bad_gain', reason: 'invalid_estimated_gain' },
    { id: 'bad_reliability', reason: 'invalid_reliability' },
  ]);
});

test('a zero-deficit cost component stays fixed instead of creating free time on first detour', () => {
  const result = planOpportunityRoutes({
    ledger: ledger({ logs: 20 }),
    baseline: baseline({ components: [
      { id: 'already_done', resource: 'ironPickaxe', mode: 'all_or_nothing', p75Seconds: 100 },
      { id: 'wood', resource: 'logs', mode: 'proportional', p75Seconds: 400 },
    ] }),
    opportunities: [opportunity('irrelevant', { estimatedGain: {} })],
  });

  assert.equal(result.candidates[0].baselineRemainingTimeSeconds, 600);
  assert.equal(result.candidates[0].scoreSeconds > result.baseline.scoreSeconds, true);
});

test('malformed authoritative ledger counts fail closed instead of disappearing', () => {
  assert.throws(() => planOpportunityRoutes({
    ledger: ledger({ 'minecraft:iron_ingot': -1 }),
    baseline: baseline(),
  }), /ledger\.deficit contains an invalid resource count/);
});
