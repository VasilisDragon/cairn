package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FieldKitTableCraftLatchTest {
    @Test
    void startsOnceAndKeepsDrivingAcrossTransientPlankLoss() {
        FieldKitTableCraftLatch latch = new FieldKitTableCraftLatch();

        assertTrue(latch.shouldDrive(4));
        assertEquals(FieldKitTableCraftLatch.Transition.STARTED, latch.start(100L));
        assertTrue(latch.inFlight());
        assertTrue(latch.shouldDrive(0));
        assertEquals(25L, latch.elapsedMs(125L));
        assertEquals(FieldKitTableCraftLatch.Transition.ACTIVE, latch.start(125L));
        assertTrue(latch.inFlight());
    }

    @Test
    void onlyTerminalCompletionOrFailureClearsTheLatch() {
        FieldKitTableCraftLatch latch = new FieldKitTableCraftLatch();
        latch.start(100L);

        assertEquals(FieldKitTableCraftLatch.Transition.ACTIVE, latch.observe("craft_table_crafting:cursor"));
        assertTrue(latch.inFlight());
        assertEquals(FieldKitTableCraftLatch.Transition.COMPLETED, latch.observe("craft_table_complete:verified"));
        assertFalse(latch.inFlight());

        latch.start(200L);
        assertEquals(FieldKitTableCraftLatch.Transition.REJECTED, latch.observe("craft_table_failed:source_slot_missing"));
        assertFalse(latch.inFlight());
    }

    @Test
    void cleanupExplicitlyClearsAnInFlightCraft() {
        FieldKitTableCraftLatch latch = new FieldKitTableCraftLatch();
        latch.start(100L);

        latch.reset();

        assertFalse(latch.inFlight());
        assertFalse(latch.shouldDrive(0));
    }

    @Test
    void verifiedTableInventoryCompletesAfterTheResultLeavesTheCraftGrid() {
        FieldKitTableCraftLatch latch = new FieldKitTableCraftLatch();
        latch.start(100L);

        assertEquals(FieldKitTableCraftLatch.Transition.ACTIVE, latch.observeInventory(0));
        assertTrue(latch.inFlight());
        assertEquals(FieldKitTableCraftLatch.Transition.COMPLETED, latch.observeInventory(1));
        assertFalse(latch.inFlight());
    }
}
