package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class GatherWoodLocalEgressTraversalTest {
    @Test
    void limitsRecoveryToCp1ConsumersAndBoundedAttempts() {
        assertTrue(GatherWoodLocalEgressTraversal.cp1Consumer("exploration.hop"));
        assertTrue(GatherWoodLocalEgressTraversal.cp1Consumer("gather_tree.break_stance"));
        assertFalse(GatherWoodLocalEgressTraversal.cp1Consumer("mine_nearby_stone"));
        assertTrue(GatherWoodLocalEgressTraversal.canCompute(0));
        assertTrue(GatherWoodLocalEgressTraversal.canCompute(1));
        assertFalse(GatherWoodLocalEgressTraversal.canCompute(2));
        assertFalse(GatherWoodLocalEgressTraversal.movedHorizontally(
            4.0D, -2.0D, 4.0D, -2.0D, 0.04D));
        assertFalse(GatherWoodLocalEgressTraversal.movedHorizontally(
            4.1D, -2.0D, 4.0D, -2.0D, 0.04D));
        assertTrue(GatherWoodLocalEgressTraversal.movedHorizontally(
            4.3D, -2.0D, 4.0D, -2.0D, 0.04D));
        assertTrue(GatherWoodLocalEgressTraversal.canOpenTrigger("gather_tree.local", 3, false));
        assertFalse(GatherWoodLocalEgressTraversal.canOpenTrigger("gather_tree.local", 4, false));
        assertTrue(GatherWoodLocalEgressTraversal.canOpenTrigger("gather_tree.local", 4, true));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartForTreeSelection(
            "reachable_tree_log", false));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartForTreeSelection(
            "no_reachable_tree_logs", true));
        assertTrue(GatherWoodLocalEgressTraversal.shouldStartForTreeSelection(
            "no_reachable_tree_logs", false));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartAtCommandAnchor(
            true, true, false, false, false));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartAtCommandAnchor(
            true, true, true, false, true));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartAtCommandAnchor(
            false, true, true, false, false));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartAtCommandAnchor(
            true, false, true, false, false));
        assertTrue(GatherWoodLocalEgressTraversal.shouldStartAtCommandAnchor(
            true, true, true, false, false));
        assertTrue(GatherWoodLocalEgressTraversal.shouldStartAtCommandAnchor(
            true, true, false, true, false));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartForSearch(true, false));
        assertFalse(GatherWoodLocalEgressTraversal.shouldStartForSearch(false, true));
        assertTrue(GatherWoodLocalEgressTraversal.shouldStartForSearch(false, false));
    }

    @Test
    void modeTimeoutsStayBounded() {
        assertEquals(3_000L, GatherWoodLocalEgressTraversal.timeoutMs(GatherWoodLocalEgressPlanner.Mode.SETTLE));
        assertEquals(6_000L, GatherWoodLocalEgressTraversal.timeoutMs(GatherWoodLocalEgressPlanner.Mode.STEP));
        assertEquals(8_000L, GatherWoodLocalEgressTraversal.timeoutMs(GatherWoodLocalEgressPlanner.Mode.SWIM));
        assertFalse(GatherWoodLocalEgressTraversal.timedOut(
            GatherWoodLocalEgressPlanner.Mode.STEP, 1_000L, 6_999L));
        assertTrue(GatherWoodLocalEgressTraversal.timedOut(
            GatherWoodLocalEgressPlanner.Mode.STEP, 1_000L, 7_000L));
    }

    @Test
    void normalizationSettleDryAndSwimHaveStrictArrivalSemantics() {
        VoxelCell anchor = new VoxelCell(2, 65, 3);
        assertTrue(GatherWoodLocalEgressTraversal.reached(
            GatherWoodLocalEgressPlanner.Mode.NORMALIZED,
            new VoxelCell(2, 65, 3),
            65.0D,
            true,
            false,
            anchor
        ));
        assertTrue(GatherWoodLocalEgressTraversal.reached(
            GatherWoodLocalEgressPlanner.Mode.SETTLE,
            new VoxelCell(0, 64, 0),
            64.0D,
            true,
            false,
            new VoxelCell(0, 64, 0)
        ));
        assertFalse(GatherWoodLocalEgressTraversal.reached(
            GatherWoodLocalEgressPlanner.Mode.SWIM,
            anchor,
            65.0D,
            true,
            true,
            anchor
        ));
        assertTrue(GatherWoodLocalEgressTraversal.reached(
            GatherWoodLocalEgressPlanner.Mode.STEP,
            anchor,
            65.0D,
            true,
            false,
            anchor
        ));
    }

    @Test
    void waypointsRetainTrueYAndOnlyValidatedDropsReceiveSuffix() {
        List<VoxelCell> path = List.of(
            new VoxelCell(1, 65, 0),
            new VoxelCell(2, 62, 0)
        );
        assertEquals(new VoxelCell(1, 65, 0), GatherWoodLocalEgressTraversal.nextWaypoint(
            path, new VoxelCell(0, 64, 0)));
        assertEquals(new VoxelCell(2, 62, 0), GatherWoodLocalEgressTraversal.nextWaypoint(
            path, new VoxelCell(1, 65, 0)));
        List<VoxelCell> swimPath = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(2, 65, 0)
        );
        assertEquals(new VoxelCell(1, 64, 0), GatherWoodLocalEgressTraversal.nextWaypoint(
            swimPath, new VoxelCell(0, 64, 0)));
        assertEquals(new VoxelCell(2, 65, 0), GatherWoodLocalEgressTraversal.nextWaypoint(
            swimPath, new VoxelCell(1, 65, 0)));
        assertTrue(GatherWoodLocalEgressTraversal.validatedDescent(
            new VoxelCell(1, 65, 0), new VoxelCell(2, 62, 0)));
        assertEquals("_nav3d_descend", GatherWoodLocalEgressTraversal.driveSuffix(true));
        assertEquals("", GatherWoodLocalEgressTraversal.driveSuffix(false));
        assertFalse(GatherWoodLocalEgressTraversal.validatedDescent(
            new VoxelCell(1, 65, 0), new VoxelCell(2, 61, 0)));
    }

    @Test
    void rotatesBeforeMovingAndUsesBoundedStepAndSwimControls() {
        VoxelCell feet = new VoxelCell(0, 64, 0);
        VoxelCell level = new VoxelCell(1, 64, 0);
        VoxelCell up = new VoxelCell(1, 65, 0);
        assertEquals(
            new GatherWoodLocalEgressTraversal.Drive(false, false, false),
            GatherWoodLocalEgressTraversal.drive(
                GatherWoodLocalEgressPlanner.Mode.STEP, false, false, true, feet, level)
        );
        assertEquals(
            new GatherWoodLocalEgressTraversal.Drive(true, true, false),
            GatherWoodLocalEgressTraversal.drive(
                GatherWoodLocalEgressPlanner.Mode.STEP, true, false, true, feet, up)
        );
        assertEquals(
            new GatherWoodLocalEgressTraversal.Drive(true, true, false),
            GatherWoodLocalEgressTraversal.drive(
                GatherWoodLocalEgressPlanner.Mode.SWIM, true, true, false, feet, level)
        );
        assertEquals(
            new GatherWoodLocalEgressTraversal.Drive(true, false, true),
            GatherWoodLocalEgressTraversal.drive(
                GatherWoodLocalEgressPlanner.Mode.SAFE_DROP,
                true,
                false,
                true,
                feet,
                new VoxelCell(1, 61, 0)
            )
        );
    }
}
