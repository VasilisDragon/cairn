package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class MineNearbyStoneOwnedDropTraversalTest {
    @Test
    void acquiringAndAirborneDropsHoldThePlayerStationary() {
        assertTrue(OwnedDropTraversal.holdStationary(OwnedDropTracker.Phase.ACQUIRING));
        assertTrue(OwnedDropTraversal.holdStationary(OwnedDropTracker.Phase.AIRBORNE));
        assertFalse(OwnedDropTraversal.holdStationary(OwnedDropTracker.Phase.SETTLED));
    }

    @Test
    void closeLevelPickupStaysDirectAndInvalidOrStalledPickupUsesTraversal() {
        assertFalse(OwnedDropTraversal.shouldUse(64.0D, 64.0D, true, false));
        assertTrue(OwnedDropTraversal.shouldUse(64.0D, 64.0D, false, false));
        assertTrue(OwnedDropTraversal.shouldUse(64.0D, 64.0D, true, true));
        assertTrue(OwnedDropTraversal.shouldUse(70.0D, 65.0D, true, false));

        assertTrue(McbotFabricClient.mineNearbyStoneDirectCollectEligible(1.0D, 0.0D, false));
        assertFalse(McbotFabricClient.mineNearbyStoneDirectCollectEligible(4.0D, 0.0D, false));
        assertFalse(McbotFabricClient.mineNearbyStoneDirectCollectEligible(1.0D, 5.0D, true));
    }

    @Test
    void cachedRoutePreventsPerTickPlanningAndAllowsOnlyOneReplan() {
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position planned = new OwnedDropTracker.Position(2.0D, 60.0D, 2.0D);
        List<VoxelCell> route = List.of(new VoxelCell(0, 64, 0), new VoxelCell(1, 63, 0));

        assertFalse(OwnedDropTraversal.needsReplan(
            id, id, planned, new OwnedDropTracker.Position(2.2D, 60.0D, 2.0D),
            route, true, 1));
        assertTrue(OwnedDropTraversal.needsReplan(
            id, id, planned, new OwnedDropTracker.Position(3.0D, 60.0D, 2.0D),
            route, true, 1));
        assertFalse(OwnedDropTraversal.needsReplan(
            id, id, planned, new OwnedDropTracker.Position(3.0D, 60.0D, 2.0D),
            route, true, OwnedDropTracker.MAX_ROUTE_ATTEMPTS));
        assertTrue(OwnedDropTraversal.needsReplan(
            id, id, planned, planned, route, false, 1));
    }

    @Test
    void pickupAndInventoryDeltaRemainAuthoritative() {
        VoxelCell pickup = new VoxelCell(2, 60, 3);

        assertTrue(OwnedDropTraversal.reached(pickup, pickup));
        assertFalse(OwnedDropTraversal.reached(new VoxelCell(2, 61, 3), pickup));
        assertTrue(OwnedDropTraversal.inventoryGainCompletes(15, 14));
        assertFalse(OwnedDropTraversal.inventoryGainCompletes(14, 14));
        assertTrue(OwnedDropTraversal.inventoryGainProvesSelectedRouteReached(1, 0, 15, 14));
        assertFalse(OwnedDropTraversal.inventoryGainProvesSelectedRouteReached(0, 0, 15, 14));
    }

    @Test
    void pickupConfirmationWaitsThenFailsLiveAndOnlyPrunesDisappeared() {
        long reachedAtMs = 1_000L;

        assertEquals(
            OwnedDropTraversal.PickupConfirmation.WAIT,
            OwnedDropTraversal.pickupConfirmation(0L, reachedAtMs, true)
        );
        assertEquals(
            OwnedDropTraversal.PickupConfirmation.WAIT,
            OwnedDropTraversal.pickupConfirmation(
                reachedAtMs,
                reachedAtMs + OwnedDropTraversal.PICKUP_CONFIRMATION_GRACE_MS - 1L,
                true
            )
        );
        assertEquals(
            OwnedDropTraversal.PickupConfirmation.FAIL_COMMAND,
            OwnedDropTraversal.pickupConfirmation(
                reachedAtMs,
                reachedAtMs + OwnedDropTraversal.PICKUP_CONFIRMATION_GRACE_MS,
                true
            )
        );
        assertEquals(
            OwnedDropTraversal.PickupConfirmation.PRUNE_DISAPPEARED,
            OwnedDropTraversal.pickupConfirmation(reachedAtMs, reachedAtMs + 1L, false)
        );
    }

    @Test
    void descentExemptionRequiresALowerCachedWaypoint() {
        VoxelCell feet = new VoxelCell(0, 64, 0);
        VoxelCell level = new VoxelCell(1, 64, 0);
        VoxelCell lower = new VoxelCell(2, 63, 0);

        assertTrue(OwnedDropTraversal.validatedDescentStep(feet, List.of(feet, level, lower), level));
        assertFalse(OwnedDropTraversal.validatedDescentStep(
            feet, List.of(feet, level, new VoxelCell(2, 64, 0)), level));
        assertEquals("_nav3d_descend", OwnedDropTraversal.driveSuffix(true));
        assertEquals("_nav3d", OwnedDropTraversal.driveSuffix(false));
    }

    @Test
    void rejectedOrEmptyRoutesAreNeverTreatedAsSelectedTraversal() {
        List<VoxelCell> route = List.of(new VoxelCell(0, 64, 0));

        assertTrue(OwnedDropTraversal.hasSelectedRoute(route, false));
        assertFalse(OwnedDropTraversal.hasSelectedRoute(route, true));
        assertFalse(OwnedDropTraversal.hasSelectedRoute(List.of(), false));
    }

}
