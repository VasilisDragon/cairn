package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ProspectStrategyPlannerTest {
    @Test
    void baselinePatternMatchesStraightTwoHighTunnelCadence() {
        Map<ProspectStrategyPlanner.Pos, ProspectStrategyPlanner.BlockKind> visible = new HashMap<>();
        visible.put(new ProspectStrategyPlanner.Pos(0, 1, 1), ProspectStrategyPlanner.BlockKind.STONE);
        ProspectStrategyPlanner.Decision first = ProspectStrategyPlanner.decide(
            ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL,
            ProspectStrategyPlanner.State.initial(),
            new ProspectStrategyPlanner.Observation(64, visible)
        );

        assertEquals(ProspectStrategyPlanner.Action.BREAK_PATTERN_BLOCK, first.action());
        assertEquals(new ProspectStrategyPlanner.Pos(0, 1, 1), first.target().orElseThrow());
        assertEquals(new ProspectStrategyPlanner.State(1, 1), first.state());

        visible.clear();
        visible.put(new ProspectStrategyPlanner.Pos(0, 0, 1), ProspectStrategyPlanner.BlockKind.STONE);
        ProspectStrategyPlanner.Decision second = ProspectStrategyPlanner.decide(
            ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL,
            first.state(),
            new ProspectStrategyPlanner.Observation(63, visible)
        );

        assertEquals(new ProspectStrategyPlanner.Pos(0, 0, 1), second.target().orElseThrow());
        assertEquals(new ProspectStrategyPlanner.State(2, 0), second.state());
    }

    @Test
    void visibleIronPreemptsThePatternWithoutAdvancingPatternState() {
        Map<ProspectStrategyPlanner.Pos, ProspectStrategyPlanner.BlockKind> visible = new HashMap<>();
        visible.put(new ProspectStrategyPlanner.Pos(0, 1, 1), ProspectStrategyPlanner.BlockKind.STONE);
        visible.put(new ProspectStrategyPlanner.Pos(1, 1, 4), ProspectStrategyPlanner.BlockKind.IRON_ORE);

        ProspectStrategyPlanner.Decision decision = ProspectStrategyPlanner.decide(
            ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL,
            ProspectStrategyPlanner.State.initial(),
            new ProspectStrategyPlanner.Observation(64, visible)
        );

        assertEquals(ProspectStrategyPlanner.Action.SELECT_VISIBLE_IRON, decision.action());
        assertTrue(decision.targetIron());
        assertEquals(new ProspectStrategyPlanner.Pos(1, 1, 4), decision.target().orElseThrow());
        assertEquals(ProspectStrategyPlanner.State.initial(), decision.state());
    }

    @Test
    void patternDecisionMapsToProspectTargetForExecutorDelegation() {
        Map<ProspectStrategyPlanner.Pos, ProspectStrategyPlanner.BlockKind> visible = new HashMap<>();
        visible.put(new ProspectStrategyPlanner.Pos(0, 1, 1), ProspectStrategyPlanner.BlockKind.STONE);

        ProspectStrategyPlanner.Decision decision = ProspectStrategyPlanner.decide(
            ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL,
            ProspectStrategyPlanner.State.initial(),
            new ProspectStrategyPlanner.Observation(64, visible)
        );

        assertEquals(ProspectStrategyPlanner.Action.BREAK_PATTERN_BLOCK, decision.action());
        assertTrue(decision.targetProspect());
        assertEquals(new ProspectStrategyPlanner.Pos(0, 1, 1), decision.target().orElseThrow());
    }

    @Test
    void realExecutorBaselineCadenceIsPhysicallyExecutableInTheFaithfulSim() {
        ProspectingSimulation.Config config = new ProspectingSimulation.Config(-4, 4, -1, 2, 0, 16, 12, 0, 1, 3, 16);

        ProspectingSimulation.Result result = ProspectingSimulation.run(
            ProspectingSimulation.World.empty(config),
            ProspectStrategySimulationAdapter.strategy(ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL)
        );

        assertFalse(result.invalidAction(), result.failureReason());
        assertEquals(12, result.blocksBroken());
        assertEquals(5, result.movesMade());
        assertEquals(new ProspectingSimulation.Pos(0, 0, 5), result.finalAgentFeet());
    }

    @Test
    void faithfulBaselineMetricsAreDeterministicAtTargetDepth() {
        ProspectingSimulation.Config config = ProspectingSimulation.Config.targetDepthDefaults();

        ProspectingSimulation.Summary baseline = ProspectingSimulation.runAcrossSeeds(
            config,
            2_000L,
            160,
            ignored -> ProspectStrategySimulationAdapter.strategy(ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL)
        );

        assertEquals(160, baseline.worlds());
        assertEquals(37, baseline.worldsFound(), "baseline=" + baseline);
        assertEquals(8_963, baseline.totalBlocksBroken(), "baseline=" + baseline);
        assertEquals(37, baseline.totalIronFound(), "baseline=" + baseline);
        assertEquals(4_332, baseline.totalMovesMade(), "baseline=" + baseline);
        assertEquals(0, baseline.invalidWorlds(), "baseline=" + baseline);
        assertEquals(0.23125D, baseline.foundRate(), 0.00001D);
        assertEquals(242.24324D, baseline.blocksPerIron(), 0.00001D);
        assertEquals(117.08108D, baseline.movesPerIron(), 0.00001D);
    }

}
