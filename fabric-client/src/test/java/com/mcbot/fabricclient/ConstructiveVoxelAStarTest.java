package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class ConstructiveVoxelAStarTest {
    @Test
    void gapRequiresBridgeAndBudgetZeroFails() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);
        world.support(0, 63, 0);
        world.support(2, 63, 0);
        VoxelCell start = new VoxelCell(0, 64, 0);
        VoxelCell goal = new VoxelCell(2, 64, 0);

        assertFalse(VoxelAStar.diagnose(world, start, goal).routeFound(), "traversal alone cannot cross the gap");
        assertFalse(ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(0)).routeFound());

        Nav3DBuildDiagnostic diagnostic =
            ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(1));

        assertTrue(diagnostic.routeFound(), diagnostic.failureReason());
        assertEquals(1, diagnostic.blocksUsed());
        assertEquals(List.of(
            ConstructiveVoxelAStar.StepKind.BRIDGE,
            ConstructiveVoxelAStar.StepKind.WALK
        ), stepKinds(diagnostic.plan()));
        assertEquals(List.of(new VoxelCell(1, 63, 0)), diagnostic.plan().placements());
        assertLegal(world, start, goal, diagnostic.plan(), 1);
    }

    @Test
    void highLedgeRequiresPillarBeforeStep() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 1, 63, 68, 0, 0);
        world.support(0, 63, 0); // start feet y64
        world.support(1, 65, 0); // ledge feet y66, too high until the bot pillars once
        VoxelCell start = new VoxelCell(0, 64, 0);
        VoxelCell goal = new VoxelCell(1, 66, 0);

        assertFalse(VoxelAStar.diagnose(world, start, goal).routeFound(), "traversal cannot step up two blocks");
        assertFalse(ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(0)).routeFound());

        Nav3DBuildDiagnostic diagnostic =
            ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(1));

        assertTrue(diagnostic.routeFound(), diagnostic.failureReason());
        assertEquals(1, diagnostic.blocksUsed());
        assertEquals(List.of(
            ConstructiveVoxelAStar.StepKind.PILLAR,
            ConstructiveVoxelAStar.StepKind.STEP
        ), stepKinds(diagnostic.plan()));
        assertEquals(List.of(new VoxelCell(0, 64, 0)), diagnostic.plan().placements());
        assertLegal(world, start, goal, diagnostic.plan(), 1);
    }

    @Test
    void bridgeAndPillarComboReachesHighLedgeAcrossGap() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 68, 0, 0);
        world.support(0, 63, 0); // start feet y64
        world.support(2, 65, 0); // goal feet y66 across a gap and two blocks up
        VoxelCell start = new VoxelCell(0, 64, 0);
        VoxelCell goal = new VoxelCell(2, 66, 0);

        assertFalse(ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(0)).routeFound());
        assertFalse(ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(1)).routeFound());

        Nav3DBuildDiagnostic diagnostic =
            ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(2));

        assertTrue(diagnostic.routeFound(), diagnostic.failureReason());
        assertEquals(2, diagnostic.blocksUsed());
        assertEquals(List.of(
            ConstructiveVoxelAStar.StepKind.BRIDGE,
            ConstructiveVoxelAStar.StepKind.PILLAR,
            ConstructiveVoxelAStar.StepKind.STEP
        ), stepKinds(diagnostic.plan()));
        assertEquals(List.of(new VoxelCell(1, 63, 0), new VoxelCell(1, 64, 0)), diagnostic.plan().placements());
        assertLegal(world, start, goal, diagnostic.plan(), 2);
    }

    @Test
    void refusesToPlaceIntoHazard() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);
        world.support(0, 63, 0);
        world.support(2, 63, 0);
        world.hazard(1, 63, 0);
        VoxelCell start = new VoxelCell(0, 64, 0);
        VoxelCell goal = new VoxelCell(2, 64, 0);

        Nav3DBuildDiagnostic diagnostic =
            ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(1));

        assertFalse(diagnostic.routeFound(), "bridge placement into a hazard cell must be rejected");
        assertEquals("open_exhausted", diagnostic.failureReason());
        assertTrue(diagnostic.rejectionCount("bridge_rejected") > 0);
    }

    @Test
    void traversalStillWorksWithZeroBuildBudget() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);
        world.floor(0, 2, 0, 0, 63);
        VoxelCell start = new VoxelCell(0, 64, 0);
        VoxelCell goal = new VoxelCell(2, 64, 0);

        Nav3DBuildDiagnostic diagnostic =
            ConstructiveVoxelAStar.diagnose(world, start, goal, new AgentBuildCapability(0));

        assertTrue(diagnostic.routeFound(), diagnostic.failureReason());
        assertEquals(0, diagnostic.blocksUsed());
        assertEquals(List.of(
            ConstructiveVoxelAStar.StepKind.WALK,
            ConstructiveVoxelAStar.StepKind.WALK
        ), stepKinds(diagnostic.plan()));
        assertLegal(world, start, goal, diagnostic.plan(), 0);
    }

    private static List<ConstructiveVoxelAStar.StepKind> stepKinds(ConstructiveVoxelAStar.BuildPlan plan) {
        return plan.steps().stream().map(ConstructiveVoxelAStar.PlanStep::kind).toList();
    }

    private static void assertLegal(
        VoxelPerception world,
        VoxelCell start,
        VoxelCell goal,
        ConstructiveVoxelAStar.BuildPlan plan,
        int budget
    ) {
        assertTrue(ConstructiveVoxelAStar.isLegalPlan(world, start, goal, plan, budget), plan.toString());
        assertTrue(plan.blocksUsed() <= budget, "blocks used must stay within budget");
        for (VoxelCell placement : plan.placements()) {
            assertFalse(world.isSolid(placement.x(), placement.y(), placement.z()), placement.toString());
            assertFalse(world.isHazard(placement.x(), placement.y(), placement.z()), placement.toString());
        }
    }
}
