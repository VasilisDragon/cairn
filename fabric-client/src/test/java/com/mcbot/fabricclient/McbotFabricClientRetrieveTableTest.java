package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class McbotFabricClientRetrieveTableTest {
    @Test
    void tableReplacementRequiresOneLogOrFourPlanks() {
        assertTrue(McbotFabricClient.hasCraftingTableReplacementMaterial(1, 0));
        assertTrue(McbotFabricClient.hasCraftingTableReplacementMaterial(0, 4));
        assertTrue(McbotFabricClient.hasCraftingTableReplacementMaterial(2, 1));

        assertFalse(McbotFabricClient.hasCraftingTableReplacementMaterial(0, 3));
        assertFalse(McbotFabricClient.hasCraftingTableReplacementMaterial(-1, 3));
    }
}
