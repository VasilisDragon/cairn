package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FurnaceSmeltPlannerTest {
    @Test
    void exposesVanillaFurnaceSlotLayout() {
        assertEquals(0, FurnaceSmeltPlanner.INPUT_SLOT);
        assertEquals(1, FurnaceSmeltPlanner.FUEL_SLOT);
        assertEquals(2, FurnaceSmeltPlanner.OUTPUT_SLOT);
        assertEquals(3, FurnaceSmeltPlanner.PLAYER_INVENTORY_START_SLOT);
    }

    @Test
    void recognizesExpectedOutputOnly() {
        assertTrue(FurnaceSmeltPlanner.isExpectedOutput("charcoal", 1, "charcoal", 1));
        assertTrue(FurnaceSmeltPlanner.isExpectedOutput("charcoal", 2, "charcoal", 1));
        assertTrue(FurnaceSmeltPlanner.isExpectedOutput("iron_ingot", 1, "iron_ingot", 1));
        assertFalse(FurnaceSmeltPlanner.isExpectedOutput("coal", 1, "charcoal", 1));
        assertFalse(FurnaceSmeltPlanner.isExpectedOutput("charcoal", 0, "charcoal", 1));
    }

    @Test
    void flagsWrongOutputAndInventoryDeltaCompletion() {
        assertTrue(FurnaceSmeltPlanner.isWrongOutput("coal", "charcoal"));
        assertTrue(FurnaceSmeltPlanner.isWrongOutput("charcoal", "iron_ingot"));
        assertFalse(FurnaceSmeltPlanner.isWrongOutput("charcoal", "charcoal"));
        assertFalse(FurnaceSmeltPlanner.isWrongOutput("iron_ingot", "iron_ingot"));
        assertTrue(FurnaceSmeltPlanner.completedByInventoryDelta(0, 1, 1));
        assertFalse(FurnaceSmeltPlanner.completedByInventoryDelta(0, 0, 1));
    }

    @Test
    void allowsRepeatedSmeltsToReuseCompatibleLoadedFuel() {
        assertTrue(FurnaceSmeltPlanner.canStartWithFurnaceSlots(true, true, true, false));
        assertTrue(FurnaceSmeltPlanner.canStartWithFurnaceSlots(true, false, true, true));
        assertFalse(FurnaceSmeltPlanner.canStartWithFurnaceSlots(false, true, true, false));
        assertFalse(FurnaceSmeltPlanner.canStartWithFurnaceSlots(true, false, true, false));
        assertFalse(FurnaceSmeltPlanner.canStartWithFurnaceSlots(true, true, false, false));
    }

    @Test
    void plansTtlSafeRawIronBatches() {
        assertEquals(0, FurnaceSmeltPlanner.desiredRawIronBatchSize(0, 0, 0));
        assertEquals(3, FurnaceSmeltPlanner.desiredRawIronBatchSize(8, 0, 0));
        assertEquals(1, FurnaceSmeltPlanner.desiredRawIronBatchSize(8, 2, 0));
        assertEquals(3, FurnaceSmeltPlanner.desiredRawIronBatchSize(8, 0, 1));
        assertEquals(2, FurnaceSmeltPlanner.desiredRawIronBatchSize(2, 0, 1));
    }

    @Test
    void computesFuelByBurnCapacity() {
        assertEquals(1, FurnaceSmeltPlanner.desiredFuelItemCount(1, "coal"));
        assertEquals(1, FurnaceSmeltPlanner.desiredFuelItemCount(8, "charcoal"));
        assertEquals(2, FurnaceSmeltPlanner.desiredFuelItemCount(9, "coal"));
        assertEquals(1, FurnaceSmeltPlanner.desiredFuelItemCount(1, "oak_planks"));
        assertEquals(2, FurnaceSmeltPlanner.desiredFuelItemCount(3, "oak_log"));
        assertEquals(2, FurnaceSmeltPlanner.desiredFuelItemCount(3, "crimson_stem"));
        assertEquals(3, FurnaceSmeltPlanner.desiredFuelItemCount(3, "unknown_fuel"));
    }

    @Test
    void waitsWithScreenClosedForMultiItemSmelts() {
        assertEquals(30_000L, FurnaceSmeltPlanner.expectedSmeltReadyMs(3));
        assertFalse(FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(0L, 1));
        assertTrue(FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(20_000L, 3));
        assertFalse(FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(30_000L, 3));
    }
}
