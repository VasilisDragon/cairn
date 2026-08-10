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
        assertTrue(GatherTreeBreakStanceTraversal.active(List.of(new VoxelCell(0, 64, 0)), ""));
        assertTrue(GatherTreeBreakStanceTraversal.active(List.of(), "adjacent_move_stall"));
        assertFalse(GatherTreeBreakStanceTraversal.active(List.of(), ""));
    }

    @Test
    void activeTraversalReachesItsFrozenStanceBeforeStartingABreak() {
        assertFalse(GatherTreeBreakStanceTraversal.directBreakAllowed(false, true, true, true));
        assertTrue(GatherTreeBreakStanceTraversal.directBreakAllowed(false, false, true, true));
        assertFalse(GatherTreeBreakStanceTraversal.directBreakAllowed(false, false, false, true));
        assertFalse(GatherTreeBreakStanceTraversal.directBreakAllowed(true, true, false, false));
        assertTrue(GatherTreeBreakStanceTraversal.directBreakAllowed(true, false, false, false));
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

    @Test
    void sameLevelGuardLookaheadStopsAtTheValidatedActiveWaypoint() {
        VoxelCell feet = new VoxelCell(0, 64, 0);
        VoxelCell waypoint = new VoxelCell(1, 64, 0);
        double bounded = GatherTreeBreakStanceTraversal.edgeGuardLookahead(
            0.75D, 0.5D, feet, feet, waypoint, true, true);

        assertTrue(bounded < MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD);
        assertEquals(0.95D, bounded, 0.0001D);
        assertEquals(
            MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD,
            GatherTreeBreakStanceTraversal.edgeGuardLookahead(
                0.75D, 0.5D, feet, feet, waypoint, false, true),
            0.0001D
        );
        assertEquals(
            MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD,
            GatherTreeBreakStanceTraversal.edgeGuardLookahead(
                0.75D, 0.5D, feet, feet, new VoxelCell(1, 65, 0), true, true),
            0.0001D
        );
        assertEquals(
            MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD,
            GatherTreeBreakStanceTraversal.edgeGuardLookahead(
                0.75D, 0.5D, feet, feet, waypoint, true, false),
            0.0001D
        );
    }
}
