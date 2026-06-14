package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

class NavHardeningBatchTest {
    @Test
    void deterministicRoundsMeetHardeningThresholdTwice() {
        NavHardeningBatch.RoundResult round1 = NavHardeningBatch.runRound(7002_101L, 1_000);
        NavHardeningBatch.RoundResult round2 = NavHardeningBatch.runRound(7002_102L, 1_000);
        System.out.println("NAV_HARDENING_ROUND_1 " + round1.summary());
        System.out.println("NAV_HARDENING_ROUND_2 " + round2.summary());

        assertTrue(round1.solvable() > 650, round1.summary());
        assertTrue(round2.solvable() > 650, round2.summary());
        assertTrue(round1.successRate() >= 0.98D, round1.summary());
        assertTrue(round2.successRate() >= 0.98D, round2.summary());
        assertTrue(round1.failures().size() <= 20, round1.summary());
        assertTrue(round2.failures().size() <= 20, round2.summary());
    }

    @Test
    void scenarioRunnerReportsUnsolvableSeparately() {
        Set<GridCell> blocked = Set.of(new GridCell(1, 0), new GridCell(0, 1));
        NavHardeningBatch.Scenario scenario =
            new NavHardeningBatch.Scenario("blocked_start_neighbors", 3, 3, blocked, new GridCell(0, 0), new GridCell(2, 2), 0.0D);

        NavHardeningBatch.ScenarioResult result = NavHardeningBatch.runScenario(scenario);

        assertFalse(result.solvable());
        assertFalse(result.arrived());
        assertEquals("open_exhausted", result.failure());
    }

    @Test
    void failureShapeBaselinesCoverRecordedRootCauses() {
        java.util.List<NavHardeningBatch.ScenarioResult> results = NavHardeningBatch.runFailureShapeBaselines();

        NavHardeningBatch.ScenarioResult unstandable = results.get(0);
        assertEquals("unstandable_target", unstandable.scenario().kind());
        assertFalse(unstandable.solvable());
        assertEquals("goal_blocked", unstandable.failure());

        NavHardeningBatch.ScenarioResult shallowScan = results.get(1);
        assertEquals("shallow_scan_dug_pit", shallowScan.scenario().kind());
        assertFalse(shallowScan.solvable());
        assertEquals("open_exhausted", shallowScan.failure());

        NavHardeningBatch.ScenarioResult stepUp = results.get(2);
        assertEquals("step_up_corridor", stepUp.scenario().kind());
        assertTrue(stepUp.solvable());
        assertTrue(stepUp.arrived(), stepUp.toString());
        assertEquals("", stepUp.failure());
    }

    @Test
    void generatedScenarioKindsIncludeWallsMazesDeadEndsAndScatter() {
        Set<String> kinds = new HashSet<>();
        java.util.Random random = new java.util.Random(1234L);
        for (int i = 0; i < 16; i++) {
            kinds.add(NavHardeningBatch.generateScenario(random, i).kind());
        }

        assertTrue(kinds.contains("walls"));
        assertTrue(kinds.contains("maze"));
        assertTrue(kinds.contains("dead_ends"));
        assertTrue(kinds.contains("scatter"));
    }
}
