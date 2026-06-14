package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CraftCursorRecoveryTest {
    @Test
    void acceptsEmptyInventorySlotForCraftCursorRecovery() {
        assertTrue(McbotFabricClient.canRecoverCraftCursorIntoSlot("oak_log", 8, "", 0, 64));
    }

    @Test
    void acceptsMatchingPartialStackForCraftCursorRecovery() {
        assertTrue(McbotFabricClient.canRecoverCraftCursorIntoSlot("oak_planks", 12, "oak_planks", 40, 64));
    }

    @Test
    void rejectsFullOrUnrelatedStackForCraftCursorRecovery() {
        assertFalse(McbotFabricClient.canRecoverCraftCursorIntoSlot("oak_planks", 12, "oak_planks", 64, 64));
        assertFalse(McbotFabricClient.canRecoverCraftCursorIntoSlot("oak_planks", 12, "stick", 4, 64));
        assertFalse(McbotFabricClient.canRecoverCraftCursorIntoSlot("", 12, "", 0, 64));
        assertFalse(McbotFabricClient.canRecoverCraftCursorIntoSlot("oak_planks", 0, "", 0, 64));
    }
}
