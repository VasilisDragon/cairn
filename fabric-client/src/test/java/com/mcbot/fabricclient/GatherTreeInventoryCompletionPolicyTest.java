package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class GatherTreeInventoryCompletionPolicyTest {
    @Test
    void configuredTargetsAreAlternativeAbsoluteRequirements() {
        assertFalse(GatherTreeInventoryCompletionPolicy.isSatisfied(20, 48, 19, 47));
        assertTrue(GatherTreeInventoryCompletionPolicy.isSatisfied(20, 48, 20, 0));
        assertTrue(GatherTreeInventoryCompletionPolicy.isSatisfied(20, 48, 0, 48));
        assertTrue(GatherTreeInventoryCompletionPolicy.isSatisfied(5, 18, 5, 0));
        assertTrue(GatherTreeInventoryCompletionPolicy.isSatisfied(5, 18, 0, 18));
    }

    @Test
    void noConfiguredTargetCannotSatisfy() {
        assertFalse(GatherTreeInventoryCompletionPolicy.isSatisfied(null, null, 100, 100));
    }

    @Test
    void inventorySatisfactionWinsOnTheExactDeadlineBoundary() {
        assertEquals(
            GatherTreeInventoryCompletionPolicy.Decision.INVENTORY_SATISFIED,
            GatherTreeInventoryCompletionPolicy.decide(20, 48, 20, 0, true)
        );
        assertEquals(
            GatherTreeInventoryCompletionPolicy.Decision.EXECUTOR_DEADLINE,
            GatherTreeInventoryCompletionPolicy.decide(20, 48, 19, 47, true)
        );
    }
}
