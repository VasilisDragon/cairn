package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class GatherTreeBreakStanceTraversalTest {
    @Test
    void recoveryTriggersOnlyForBoundedFailureSignals() {
        assertFalse(GatherTreeBreakStanceTraversal.shouldAttempt(false, 0, 0));
        assertTrue(GatherTreeBreakStanceTraversal.shouldAttempt(true, 0, 0));
        assertTrue(GatherTreeBreakStanceTraversal.shouldAttempt(false, 1, 0));
        assertTrue(GatherTreeBreakStanceTraversal.shouldAttempt(false, 0, 1));
        assertTrue(GatherTreeBreakStanceTraversal.canCompute(0));
        assertTrue(GatherTreeBreakStanceTraversal.canCompute(1));
        assertFalse(GatherTreeBreakStanceTraversal.canCompute(2));
    }

    @Test
    void cachedRouteReachDeviationAndStallStayBounded() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(2, 61, 0)
        );
        assertFalse(GatherTreeBreakStanceTraversal.routeDeviation(route, true));
        assertTrue(GatherTreeBreakStanceTraversal.routeDeviation(route, false));
        assertTrue(GatherTreeBreakStanceTraversal.routeDeviation(List.of(), true));
        assertTrue(GatherTreeBreakStanceTraversal.reached(route.getLast(), route.getLast()));
        assertFalse(GatherTreeBreakStanceTraversal.reached(route.getFirst(), route.getLast()));
        assertFalse(GatherTreeBreakStanceTraversal.routeStalled(1_000L, 4_999L));
        assertTrue(GatherTreeBreakStanceTraversal.routeStalled(1_000L, 5_000L));
    }

    @Test
    void descentAuthorityRequiresAValidatedLowerWaypoint() {
        VoxelCell feet = new VoxelCell(0, 64, 0);
        List<VoxelCell> descending = List.of(feet, new VoxelCell(1, 64, 0), new VoxelCell(2, 61, 0));
        List<VoxelCell> level = List.of(feet, new VoxelCell(1, 64, 0), new VoxelCell(2, 64, 0));

        assertFalse(GatherTreeBreakStanceTraversal.validatedDescentStep(feet, descending, descending.get(1)));
        assertEquals(null, GatherTreeBreakStanceTraversal.descentLanding(feet, descending, descending.get(1)));
        assertTrue(GatherTreeBreakStanceTraversal.validatedDescentStep(feet, descending, descending.get(2)));
        assertEquals(descending.get(2), GatherTreeBreakStanceTraversal.descentLanding(feet, descending, descending.get(2)));
        assertEquals("_nav3d_descend", GatherTreeBreakStanceTraversal.driveSuffix(true));
        assertFalse(GatherTreeBreakStanceTraversal.validatedDescentStep(feet, level, level.get(1)));
        assertEquals(null, GatherTreeBreakStanceTraversal.descentLanding(feet, level, level.get(1)));
        assertEquals("_nav3d", GatherTreeBreakStanceTraversal.driveSuffix(false));
        assertFalse(GatherTreeBreakStanceTraversal.descentLanded(feet, 64));
        assertTrue(GatherTreeBreakStanceTraversal.descentLanded(new VoxelCell(1, 61, 0), 64));
        assertFalse(GatherTreeBreakStanceTraversal.descentMissed(new VoxelCell(1, 61, 0), new VoxelCell(1, 61, 0)));
        assertTrue(GatherTreeBreakStanceTraversal.descentMissed(new VoxelCell(1, 59, 0), new VoxelCell(1, 61, 0)));
        assertTrue(GatherTreeBreakStanceTraversal.holdAirborne(new VoxelCell(1, 61, 0), false));
        assertFalse(GatherTreeBreakStanceTraversal.holdAirborne(new VoxelCell(1, 61, 0), true));
        assertFalse(GatherTreeBreakStanceTraversal.holdAirborne(null, false));
        assertTrue(GatherTreeBreakStanceTraversal.stageBeforeDescent(feet, descending, descending.get(1)));
        assertFalse(GatherTreeBreakStanceTraversal.stageBeforeDescent(feet, descending, descending.get(2)));
        assertFalse(GatherTreeBreakStanceTraversal.stageBeforeDescent(feet, level, level.get(1)));
        assertTrue(GatherTreeBreakStanceTraversal.precisionSneak(
            new VoxelCell(1, 61, 0), new VoxelCell(0, 64, 0), false));
        assertFalse(GatherTreeBreakStanceTraversal.precisionSneak(
            new VoxelCell(1, 61, 0), new VoxelCell(0, 64, 0), true));
        assertFalse(GatherTreeBreakStanceTraversal.precisionSneak(
            new VoxelCell(1, 64, 0), new VoxelCell(0, 64, 0), false));
    }
}
