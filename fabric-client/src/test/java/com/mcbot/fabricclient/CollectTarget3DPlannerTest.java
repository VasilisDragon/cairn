package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CollectTarget3DPlannerTest {
    @Test
    void overhangDropRoutesToDropLevelInsteadOfUpperSurface() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 4, 94, 103, 0, 0);
        world.floor(0, 4, 0, 0, 95); // feet y96 drop level
        world.support(2, 100, 0); // same x/z also has an upper overhang surface at feet y101

        CollectTarget3DPlanner.TargetPlan plan =
            CollectTarget3DPlanner.chooseTarget(world, new VoxelCell(0, 96, 0), 2.5D, 96.0D, 0.5D);

        assertReachablePickup(plan, world, 2.5D, 96.0D, 0.5D);
        assertEquals(96, plan.cell().y(), "3-D planner must choose the drop level, not the overhang");
    }

    @Test
    void ledgeDropRoutesToTheLedgeAbovePitFloor() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 4, 90, 98, 0, 0);
        world.floor(0, 4, 0, 0, 94); // ledge feet y95
        world.support(2, 91, 0); // same x/z also has pit floor feet y92

        CollectTarget3DPlanner.TargetPlan plan =
            CollectTarget3DPlanner.chooseTarget(world, new VoxelCell(0, 95, 0), 2.5D, 95.0D, 0.5D);

        assertReachablePickup(plan, world, 2.5D, 95.0D, 0.5D);
        assertEquals(95, plan.cell().y(), "drop on ledge must not collapse to the pit floor");
    }

    @Test
    void pitDropDescendsWithinSafeDropLimit() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 3, 59, 66, 0, 0);
        world.support(0, 63, 0); // feet y64
        world.support(1, 62, 0); // feet y63
        world.support(2, 60, 0); // feet y61
        world.support(3, 60, 0); // feet y61

        CollectTarget3DPlanner.TargetPlan plan =
            CollectTarget3DPlanner.chooseTarget(world, new VoxelCell(0, 64, 0), 2.5D, 61.0D, 0.5D);

        assertReachablePickup(plan, world, 2.5D, 61.0D, 0.5D);
        assertEquals(61, plan.cell().y());
    }

    @Test
    void prefersCloserPickupCellOverBarelyInRangeStartCell() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 94, 98, 0, 0);
        world.floor(0, 2, 0, 0, 95); // feet y96

        CollectTarget3DPlanner.TargetPlan plan =
            CollectTarget3DPlanner.chooseTarget(world, new VoxelCell(0, 96, 0), 1.45D, 96.0D, 0.5D);

        assertReachablePickup(plan, world, 1.45D, 96.0D, 0.5D);
        assertEquals(new VoxelCell(1, 96, 0), plan.cell());
    }

    @Test
    void staircaseMultiLevelRoutesUpAndDown() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 5, 62, 70, 0, 0);
        world.support(0, 63, 0); // feet y64
        world.support(1, 64, 0); // feet y65
        world.support(2, 65, 0); // feet y66
        world.support(3, 64, 0); // feet y65
        world.support(4, 63, 0); // feet y64
        world.support(5, 63, 0); // feet y64

        CollectTarget3DPlanner.TargetPlan plan =
            CollectTarget3DPlanner.chooseTarget(world, new VoxelCell(0, 64, 0), 5.5D, 64.0D, 0.5D);

        assertReachablePickup(plan, world, 5.5D, 64.0D, 0.5D);
        assertTrue(plan.route().contains(new VoxelCell(2, 66, 0)), "route should traverse the upper stair");
    }

    @Test
    void hazardAvoidNeverRoutesThroughHazard() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 4, 63, 67, 0, 2);
        world.floor(0, 4, 0, 2, 63);
        world.hazard(2, 63, 1);

        CollectTarget3DPlanner.TargetPlan plan =
            CollectTarget3DPlanner.chooseTarget(world, new VoxelCell(0, 64, 1), 4.5D, 64.0D, 1.5D);

        assertReachablePickup(plan, world, 4.5D, 64.0D, 1.5D);
        assertFalse(plan.route().contains(new VoxelCell(2, 64, 1)), "route must not stand on the hazard column");
    }

    @Test
    void collectRecordingRoundTripReplaysPlannerOutcome() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 4, 94, 103, 0, 0);
        world.floor(0, 4, 0, 0, 95);
        world.support(2, 100, 0);
        VoxelCell start = new VoxelCell(0, 96, 0);
        CollectTarget3DPlanner.TargetPlan live =
            CollectTarget3DPlanner.chooseTarget(world, start, 2.5D, 96.0D, 0.5D);

        Nav3DRecording recording = Nav3DRecording.captureCollect(world, start, 2.5D, 96.0D, 0.5D, live);
        Nav3DRecording roundTripped = Nav3DRecording.fromJson(recording.toJson());
        CollectTarget3DPlanner.TargetPlan replayed = roundTripped.reproduceCollectTarget();

        assertTrue(roundTripped.reproducesLiveCollectOutcome(), roundTripped.summary());
        assertEquals(live.cell(), replayed.cell());
        assertEquals(live.route(), replayed.route());
    }

    private static void assertReachablePickup(
        CollectTarget3DPlanner.TargetPlan plan,
        VoxelPerception world,
        double targetX,
        double targetY,
        double targetZ
    ) {
        assertNotNull(plan.cell(), plan.reason());
        assertFalse(plan.route().isEmpty(), plan.reason());
        assertTrue(CollectTarget3DPlanner.withinPickupRange(plan.cell(), targetX, targetY, targetZ), plan.cell().toString());
        for (VoxelCell cell : plan.route()) {
            assertTrue(world.isStandable(cell.x(), cell.y(), cell.z()), cell.toString());
        }
    }
}
