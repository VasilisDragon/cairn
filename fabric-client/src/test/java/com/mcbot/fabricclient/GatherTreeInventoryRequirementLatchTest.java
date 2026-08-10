package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class GatherTreeInventoryRequirementLatchTest {
    @Test
    void freezesTargetsForOneCommand() {
        GatherTreeInventoryRequirementLatch latch = new GatherTreeInventoryRequirementLatch();
        Object world = new Object();

        GatherTreeInventoryRequirementLatch.Requirement first =
            latch.freeze(world, "mission:GATHER_WOOD:1", 20, 48);
        GatherTreeInventoryRequirementLatch.Requirement repeated =
            latch.freeze(world, "mission:GATHER_WOOD:1", 5, 18);

        assertEquals(20, first.requiredLogs());
        assertEquals(48, first.requiredPlanks());
        assertEquals(first, repeated);
    }

    @Test
    void commandAndWorldChangesResetTheFrozenTargets() {
        GatherTreeInventoryRequirementLatch latch = new GatherTreeInventoryRequirementLatch();
        Object firstWorld = new Object();
        Object secondWorld = new Object();

        latch.freeze(firstWorld, "one", 20, 48);
        GatherTreeInventoryRequirementLatch.Requirement nextCommand =
            latch.freeze(firstWorld, "two", 5, 18);
        GatherTreeInventoryRequirementLatch.Requirement nextWorld =
            latch.freeze(secondWorld, "two", 20, 48);

        assertEquals(5, nextCommand.requiredLogs());
        assertEquals(18, nextCommand.requiredPlanks());
        assertEquals(20, nextWorld.requiredLogs());
        assertEquals(48, nextWorld.requiredPlanks());
    }

    @Test
    void invalidTargetsRemainDisabledAndClearResetsState() {
        GatherTreeInventoryRequirementLatch latch = new GatherTreeInventoryRequirementLatch();
        Object world = new Object();

        GatherTreeInventoryRequirementLatch.Requirement invalid =
            latch.freeze(world, "one", 0, -1);
        assertFalse(invalid.enabled());
        assertNull(invalid.requiredLogs());
        assertNull(invalid.requiredPlanks());

        latch.clear();
        GatherTreeInventoryRequirementLatch.Requirement enabled =
            latch.freeze(world, "one", 5, null);
        assertTrue(enabled.enabled());
        assertEquals(5, enabled.requiredLogs());
    }
}
