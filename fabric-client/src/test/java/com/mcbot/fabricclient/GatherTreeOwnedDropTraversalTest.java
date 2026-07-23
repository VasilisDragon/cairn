package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class GatherTreeOwnedDropTraversalTest {
    @Test
    void airborneOwnedDropHoldsStationary() {
        assertTrue(GatherTreeOwnedDropTraversal.holdStationary(GatherTreeDropTracker.Phase.ACQUIRING));
        assertTrue(GatherTreeOwnedDropTraversal.holdStationary(GatherTreeDropTracker.Phase.AIRBORNE));
        assertFalse(GatherTreeOwnedDropTraversal.holdStationary(GatherTreeDropTracker.Phase.SETTLED));
    }

    @Test
    void closeLevelPickupStaysOnExistingPathAndVerticalDropUsesTraversal() {
        assertFalse(GatherTreeOwnedDropTraversal.shouldUse(64.0D, 64.5D, true));
        assertTrue(GatherTreeOwnedDropTraversal.shouldUse(70.0D, 65.0D, true));
        assertTrue(GatherTreeOwnedDropTraversal.shouldUse(64.0D, 64.5D, false));
    }

    @Test
    void selectedTraversalRemainsAuthoritativeAfterVerticalSeparationCloses() {
        List<VoxelCell> route = List.of(new VoxelCell(0, 64, 0), new VoxelCell(1, 63, 0));

        assertTrue(GatherTreeOwnedDropTraversal.hasSelectedRoute(route, false));
        assertFalse(GatherTreeOwnedDropTraversal.hasSelectedRoute(route, true));
        assertFalse(GatherTreeOwnedDropTraversal.hasSelectedRoute(List.of(), false));
    }

    @Test
    void cachedRouteAvoidsPerTickPlanningAndAllowsOneDisplacedReplan() {
        UUID id = UUID.randomUUID();
        GatherTreeDropTracker.Position planned = new GatherTreeDropTracker.Position(1.0D, 60.0D, 1.0D);
        List<VoxelCell> route = List.of(new VoxelCell(0, 64, 0), new VoxelCell(1, 63, 0));

        assertFalse(GatherTreeOwnedDropTraversal.needsReplan(
            id, id, planned, new GatherTreeDropTracker.Position(1.2D, 60.0D, 1.0D), route, true, 1));
        assertTrue(GatherTreeOwnedDropTraversal.needsReplan(
            id, id, planned, new GatherTreeDropTracker.Position(2.0D, 60.0D, 1.0D), route, true, 1));
        assertFalse(GatherTreeOwnedDropTraversal.needsReplan(
            id, id, planned, new GatherTreeDropTracker.Position(2.0D, 60.0D, 1.0D), route, true, 2));
    }

    @Test
    void commandEntityChangeAndLeavingRouteRequireBoundedReplan() {
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        GatherTreeDropTracker.Position position = new GatherTreeDropTracker.Position(1.0D, 60.0D, 1.0D);
        List<VoxelCell> route = List.of(new VoxelCell(0, 64, 0));

        assertTrue(GatherTreeOwnedDropTraversal.needsReplan(first, second, position, position, route, true, 1));
        assertTrue(GatherTreeOwnedDropTraversal.needsReplan(first, first, position, position, route, false, 1));
    }

    @Test
    void descendingExemptionOnlyMarksValidatedLowerWaypoint() {
        VoxelCell feet = new VoxelCell(0, 64, 0);
        VoxelCell level = new VoxelCell(1, 64, 0);
        VoxelCell lower = new VoxelCell(2, 63, 0);

        assertTrue(GatherTreeOwnedDropTraversal.validatedDescentStep(feet, List.of(feet, lower), lower));
        assertTrue(GatherTreeOwnedDropTraversal.validatedDescentStep(feet, List.of(feet, level, lower), level));
        assertTrue(GatherTreeOwnedDropTraversal.validatedDescentStep(
            feet, List.of(feet, level, new VoxelCell(2, 64, 0), lower), level));
        assertFalse(GatherTreeOwnedDropTraversal.validatedDescentStep(
            feet, List.of(feet, level, new VoxelCell(2, 64, 0)), level));
        assertFalse(GatherTreeOwnedDropTraversal.validatedDescentStep(
            feet, List.of(feet, level, new VoxelCell(2, 64, 0), new VoxelCell(3, 64, 0), lower), level));
        assertFalse(GatherTreeOwnedDropTraversal.validatedDescentStep(feet, List.of(feet, lower), level));
        assertEquals("_nav3d_descend", GatherTreeOwnedDropTraversal.driveSuffix(true));
        assertEquals("_nav3d", GatherTreeOwnedDropTraversal.driveSuffix(false));
    }

    @Test
    void pickupCellAndInventoryGainAreAuthoritative() {
        VoxelCell pickup = new VoxelCell(2, 60, 3);

        assertTrue(GatherTreeOwnedDropTraversal.reached(pickup, pickup));
        assertFalse(GatherTreeOwnedDropTraversal.reached(new VoxelCell(2, 61, 3), pickup));
        assertTrue(GatherTreeOwnedDropTraversal.inventoryGainCompletes(1, 0));
        assertFalse(GatherTreeOwnedDropTraversal.inventoryGainCompletes(0, 0));
        assertTrue(GatherTreeOwnedDropTraversal.inventoryGainProvesSelectedRouteReached(1, 0, 1, 0));
        assertFalse(GatherTreeOwnedDropTraversal.inventoryGainProvesSelectedRouteReached(0, 0, 1, 0));
        assertFalse(GatherTreeOwnedDropTraversal.inventoryGainProvesSelectedRouteReached(1, 1, 1, 0));
    }
}
