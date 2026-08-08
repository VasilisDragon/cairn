package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class VillageHarvestOwnedDropRecoveryTest {
    @Test
    void inventoryGainAlwaysWins() {
        VillageHarvestOwnedDropRecovery.Decision decision =
            VillageHarvestOwnedDropRecovery.decide(
                2, 1, OwnedDropTracker.Phase.REJECTED,
                false, 0L, false, 1_000L, 1_100L, 9_000L);

        assertEquals(VillageHarvestOwnedDropRecovery.Action.INVENTORY_GAIN,
            decision.action());
    }

    @Test
    void acquisitionAndAirbornePhasesHoldStill() {
        assertEquals(VillageHarvestOwnedDropRecovery.Action.HOLD_STATIONARY,
            decide(OwnedDropTracker.Phase.ACQUIRING, false, false, true, 1_100L).action());
        assertEquals(VillageHarvestOwnedDropRecovery.Action.HOLD_STATIONARY,
            decide(OwnedDropTracker.Phase.AIRBORNE, false, false, true, 1_100L).action());
    }

    @Test
    void settledDropSelectsThenDrivesOneRoute() {
        assertEquals(VillageHarvestOwnedDropRecovery.Action.SELECT_ROUTE,
            decide(OwnedDropTracker.Phase.SETTLED, false, false, true, 1_100L).action());
        assertEquals(VillageHarvestOwnedDropRecovery.Action.DRIVE_ROUTE,
            decide(OwnedDropTracker.Phase.SETTLED, true, false, true, 1_100L).action());
        assertEquals(VillageHarvestOwnedDropRecovery.Action.WAIT_AT_PICKUP,
            decide(OwnedDropTracker.Phase.SETTLED, true, true, true, 1_100L).action());
    }

    @Test
    void disappearanceGetsOnlyBoundedInventorySyncGrace() {
        assertEquals(VillageHarvestOwnedDropRecovery.Action.WAIT_DISAPPEARANCE,
            VillageHarvestOwnedDropRecovery.decide(
                1, 1, OwnedDropTracker.Phase.SETTLED, true, 0L, false,
                1_000L, 1_100L, 1_399L).action());
        assertEquals(VillageHarvestOwnedDropRecovery.Action.REJECT,
            VillageHarvestOwnedDropRecovery.decide(
                1, 1, OwnedDropTracker.Phase.SETTLED, true, 0L, false,
                1_000L, 1_100L, 1_400L).action());
    }

    @Test
    void aLiveEntityAtThePickupCellCannotHoldTheCommandPastConfirmationGrace() {
        assertEquals(VillageHarvestOwnedDropRecovery.Action.WAIT_AT_PICKUP,
            VillageHarvestOwnedDropRecovery.decide(
                1, 1, OwnedDropTracker.Phase.SETTLED, true, 1_000L, true,
                900L, 0L, 1_299L).action());
        VillageHarvestOwnedDropRecovery.Decision expired =
            VillageHarvestOwnedDropRecovery.decide(
                1, 1, OwnedDropTracker.Phase.SETTLED, true, 1_000L, true,
                900L, 0L, 1_300L);
        assertEquals(VillageHarvestOwnedDropRecovery.Action.REJECT, expired.action());
        assertEquals("pickup_confirmation_timeout", expired.reason());
    }

    @Test
    void collectionDeadlineIsNonResettingAndExact() {
        assertEquals(VillageHarvestOwnedDropRecovery.Action.DRIVE_ROUTE,
            VillageHarvestOwnedDropRecovery.decide(
                1, 1, OwnedDropTracker.Phase.SETTLED, true, 0L, true,
                1_000L, 0L, 8_999L).action());
        assertEquals(VillageHarvestOwnedDropRecovery.Action.REJECT,
            VillageHarvestOwnedDropRecovery.decide(
                1, 1, OwnedDropTracker.Phase.SETTLED, true, 0L, true,
                1_000L, 0L, 9_000L).action());
    }

    @Test
    void onlyTheExactHayOrBedItemCanBeAttributed() {
        assertTrue(VillageHarvestOwnedDropRecovery.exactItem(
            "minecraft:hay_block", "minecraft:hay_block"));
        assertTrue(VillageHarvestOwnedDropRecovery.exactItem(
            "minecraft:red_bed", "minecraft:red_bed"));
        assertFalse(VillageHarvestOwnedDropRecovery.exactItem(
            "minecraft:red_bed", "minecraft:white_bed"));
        assertFalse(VillageHarvestOwnedDropRecovery.exactItem("", "minecraft:hay_block"));
    }

    private static VillageHarvestOwnedDropRecovery.Decision decide(
        OwnedDropTracker.Phase phase,
        boolean routeSelected,
        boolean pickupReached,
        boolean entityLive,
        long nowMs
    ) {
        return VillageHarvestOwnedDropRecovery.decide(
            1, 1, phase, routeSelected, pickupReached ? 1_000L : 0L, entityLive,
            1_000L, 0L, nowMs);
    }
}
