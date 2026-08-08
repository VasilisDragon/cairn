package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class VillageFoodConsumptionTrackerTest {
    @Test
    void exactBreadDropWithHungerGainIsAttributed() {
        VillageFoodConsumptionTracker tracker =
            VillageFoodConsumptionTracker.create("minecraft:bread", 4, 10);
        tracker.observe(3, 15);
        assertEquals(1, tracker.verifiedConsumedForReceipt(4));
    }

    @Test
    void inventoryLossWithoutHungerGainIsNeverConsumption() {
        VillageFoodConsumptionTracker tracker =
            VillageFoodConsumptionTracker.create("minecraft:bread", 4, 10);
        tracker.observe(0, 10);
        assertEquals(0, tracker.verifiedConsumedForReceipt(4));
    }

    @Test
    void onePointOfCappedHungerCanProveOnlyOneFoodUse() {
        VillageFoodConsumptionTracker tracker =
            VillageFoodConsumptionTracker.create("minecraft:bread", 5, 19);
        tracker.observe(1, 20);
        assertEquals(1, tracker.verifiedConsumedForReceipt(5));
    }

    @Test
    void unrelatedOrUnsupportedFoodNeverReceivesAuthority() {
        VillageFoodConsumptionTracker tracker =
            VillageFoodConsumptionTracker.create("minecraft:carrot", 2, 10);
        tracker.observe(1, 13);
        assertEquals(0, tracker.verifiedConsumedForReceipt(2));
    }

    @Test
    void receiptCountBoundsAccumulatedConsumption() {
        VillageFoodConsumptionTracker tracker =
            VillageFoodConsumptionTracker.create("minecraft:apple", 3, 8);
        tracker.observe(2, 12);
        tracker.observe(1, 16);
        assertEquals(1, tracker.verifiedConsumedForReceipt(1));
        assertEquals(2, tracker.verifiedConsumedForReceipt(3));
    }
}
