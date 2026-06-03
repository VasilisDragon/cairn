package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CraftPlanksPlannerTest {
    @Test
    void acceptsOneLogIntoFourPlanksDelta() {
        assertTrue(CraftPlanksPlanner.isComplete(1, 0, 0, 4));
        assertTrue(CraftPlanksPlanner.isComplete(3, 2, 8, 12));
    }

    @Test
    void rejectsPartialOrUnrelatedInventoryChanges() {
        assertFalse(CraftPlanksPlanner.isComplete(1, 1, 0, 4));
        assertFalse(CraftPlanksPlanner.isComplete(1, 0, 0, 3));
        assertFalse(CraftPlanksPlanner.isComplete(0, 0, 0, 4));
    }

    @Test
    void requiresAtLeastOneLogBeforeStarting() {
        assertTrue(CraftPlanksPlanner.canStart(1));
        assertFalse(CraftPlanksPlanner.canStart(0));
    }
}
