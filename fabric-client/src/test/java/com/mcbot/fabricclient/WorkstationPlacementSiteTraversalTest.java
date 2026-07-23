package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class WorkstationPlacementSiteTraversalTest {
    @Test
    void routeComputationsAndStallAreBounded() {
        assertTrue(WorkstationPlacementSiteTraversal.canCompute(0));
        assertTrue(WorkstationPlacementSiteTraversal.canCompute(1));
        assertFalse(WorkstationPlacementSiteTraversal.canCompute(2));
        assertFalse(WorkstationPlacementSiteTraversal.routeStalled(1_000L, 4_999L));
        assertTrue(WorkstationPlacementSiteTraversal.routeStalled(1_000L, 5_000L));
        assertFalse(WorkstationPlacementSiteTraversal.routeStalled(0L, 9_000L));
        assertTrue(WorkstationPlacementSiteTraversal.shouldDriveRoute(false, true));
        assertFalse(WorkstationPlacementSiteTraversal.shouldDriveRoute(true, true));
        assertFalse(WorkstationPlacementSiteTraversal.shouldDriveRoute(false, false));
    }

    @Test
    void cachedRouteClassifiesReachAndDeviation() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(2, 61, 0)
        );
        assertTrue(WorkstationPlacementSiteTraversal.reached(route.getLast(), route.getLast()));
        assertFalse(WorkstationPlacementSiteTraversal.reached(route.getFirst(), route.getLast()));
        assertTrue(WorkstationPlacementSiteTraversal.readyToPlace(route.getLast(), route.getLast(), true));
        assertFalse(WorkstationPlacementSiteTraversal.readyToPlace(route.getLast(), route.getLast(), false));
        assertFalse(WorkstationPlacementSiteTraversal.routeDeviation(route, true));
        assertTrue(WorkstationPlacementSiteTraversal.routeDeviation(route, false));
        assertTrue(WorkstationPlacementSiteTraversal.routeDeviation(List.of(), true));
    }

    @Test
    void descentAuthorityIsLimitedToValidatedLowerWaypoint() {
        VoxelCell feet = new VoxelCell(0, 64, 0);
        List<VoxelCell> descending = List.of(feet, new VoxelCell(1, 64, 0), new VoxelCell(2, 61, 0));
        List<VoxelCell> level = List.of(feet, new VoxelCell(1, 64, 0), new VoxelCell(2, 64, 0));

        assertNull(WorkstationPlacementSiteTraversal.descentLanding(feet, descending, descending.get(1)));
        assertFalse(WorkstationPlacementSiteTraversal.validatedDescentStep(feet, descending, descending.get(1)));
        assertEquals(descending.get(2), WorkstationPlacementSiteTraversal.descentLanding(feet, descending, descending.get(2)));
        assertTrue(WorkstationPlacementSiteTraversal.validatedDescentStep(feet, descending, descending.get(2)));
        assertFalse(WorkstationPlacementSiteTraversal.validatedDescentStep(feet, level, level.get(1)));
        assertEquals("_nav3d_descend", WorkstationPlacementSiteTraversal.driveSuffix(true));
        assertEquals("_nav3d", WorkstationPlacementSiteTraversal.driveSuffix(false));
    }

    @Test
    void descentStagesHoldsAndRejectsMissedLanding() {
        VoxelCell feet = new VoxelCell(0, 64, 0);
        VoxelCell lip = new VoxelCell(1, 64, 0);
        VoxelCell landing = new VoxelCell(2, 61, 0);
        List<VoxelCell> route = List.of(feet, lip, landing);

        assertTrue(WorkstationPlacementSiteTraversal.stageBeforeDescent(feet, route, lip));
        assertFalse(WorkstationPlacementSiteTraversal.stageBeforeDescent(feet, route, landing));
        assertTrue(WorkstationPlacementSiteTraversal.holdAirborne(landing, false));
        assertFalse(WorkstationPlacementSiteTraversal.holdAirborne(landing, true));
        assertTrue(WorkstationPlacementSiteTraversal.descentLanded(landing, 64));
        assertFalse(WorkstationPlacementSiteTraversal.descentMissed(landing, landing));
        assertTrue(WorkstationPlacementSiteTraversal.descentMissed(new VoxelCell(2, 59, 0), landing));
        assertTrue(WorkstationPlacementSiteTraversal.precisionSneak(landing, feet, false));
        assertFalse(WorkstationPlacementSiteTraversal.precisionSneak(landing, feet, true));
    }
}
