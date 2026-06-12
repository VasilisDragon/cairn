package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class ConstructiveCollectPlannerTest {
    @Test
    void constructivelyReachesPickupCellAcrossGap() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);
        world.support(0, 63, 0);
        world.support(2, 63, 0);
        VoxelCell start = new VoxelCell(0, 64, 0);

        assertNull(CollectTarget3DPlanner.chooseTarget(world, start, 2.5D, 64.0D, 0.5D).cell());
        assertNull(ConstructiveCollectPlanner
            .chooseTarget(world, start, 2.5D, 64.0D, 0.5D, new AgentBuildCapability(0))
            .cell());

        ConstructiveCollectPlanner.TargetPlan plan =
            ConstructiveCollectPlanner.chooseTarget(world, start, 2.5D, 64.0D, 0.5D, new AgentBuildCapability(1));

        assertReachablePickup(plan, world, start, 2.5D, 64.0D, 0.5D, 1);
        assertEquals(1, plan.blocksUsed());
    }

    @Test
    void reachableRealFixtureStillSolves() throws Exception {
        Nav3DRecording rec = load("/nav-recordings/r5-nav3d-collect-reachable.json");
        assertTrue(rec.liveRouteFound, rec.summary());

        ConstructiveCollectPlanner.TargetPlan plan = ConstructiveCollectPlanner.chooseTarget(
            rec.toPerception(),
            rec.start(),
            rec.targetX,
            rec.targetY,
            rec.targetZ,
            new AgentBuildCapability(8)
        );

        assertReachablePickup(plan, rec.toPerception(), rec.start(), rec.targetX, rec.targetY, rec.targetZ, 8);
    }

    @Test
    void unreachableRealFixtureCharacterizesConstructiveVerdict() throws Exception {
        Nav3DRecording rec = load("/nav-recordings/r5-nav3d-collect-unreachable.json");
        assertFalse(rec.liveRouteFound, rec.summary());
        assertEquals("no_reachable_pickup_cell", rec.liveFailureReason);

        ConstructiveCollectPlanner.TargetPlan plan = ConstructiveCollectPlanner.chooseTarget(
            rec.toPerception(),
            rec.start(),
            rec.targetX,
            rec.targetY,
            rec.targetZ,
            new AgentBuildCapability(8)
        );

        if (plan.cell() == null) {
            assertEquals("no_constructive_path", plan.reason());
            System.out.println("PHASE_B_REAL_UNREACHABLE verdict=still_no_constructive_path budget=8");
        } else {
            assertReachablePickup(plan, rec.toPerception(), rec.start(), rec.targetX, rec.targetY, rec.targetZ, 8);
            System.out.println(
                "PHASE_B_REAL_UNREACHABLE verdict=flipped_to_reachable budget=8"
                    + " blocksUsed=" + plan.blocksUsed()
                    + " totalCost=" + plan.buildPlan().totalCost()
                    + " routeLength=" + plan.route().size()
                    + " cell=" + plan.cell()
            );
        }
    }

    private static Nav3DRecording load(String resource) throws Exception {
        try (InputStream in = ConstructiveCollectPlannerTest.class.getResourceAsStream(resource)) {
            assertNotNull(in, "missing fixture: " + resource);
            return Nav3DRecording.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static void assertReachablePickup(
        ConstructiveCollectPlanner.TargetPlan plan,
        VoxelPerception world,
        VoxelCell start,
        double targetX,
        double targetY,
        double targetZ,
        int budget
    ) {
        assertNotNull(plan.cell(), plan.reason());
        assertFalse(plan.route().isEmpty(), plan.reason());
        assertTrue(CollectTarget3DPlanner.withinPickupRange(plan.cell(), targetX, targetY, targetZ), plan.cell().toString());
        assertTrue(ConstructiveVoxelAStar.isLegalPlan(world, start, plan.cell(), plan.buildPlan(), budget), plan.toString());
    }
}
