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
}
