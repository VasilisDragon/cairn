package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class InventoryCounterTest {
    @Test
    void countsKnownLogItemFamilies() {
        int count = InventoryCounter.countLogItems(List.of(
            new InventoryCounter.ItemCount("oak_log", 2),
            new InventoryCounter.ItemCount("crimson_stem", 3),
            new InventoryCounter.ItemCount("warped_hyphae", 4),
            new InventoryCounter.ItemCount("stone", 64),
            new InventoryCounter.ItemCount("stick", 12)
        ));

        assertEquals(9, count);
    }

    @Test
    void logItemIdClassifierRejectsPlanksAndTools() {
        assertTrue(InventoryCounter.isLogItemId("jungle_log"));
        assertTrue(InventoryCounter.isLogItemId("stripped_oak_wood"));
        assertFalse(InventoryCounter.isLogItemId("oak_planks"));
        assertFalse(InventoryCounter.isLogItemId("wooden_axe"));
    }

    @Test
    void plankItemIdClassifierAcceptsPlanksOnly() {
        assertTrue(InventoryCounter.isPlankItemId("oak_planks"));
        assertTrue(InventoryCounter.isPlankItemId("bamboo_planks"));
        assertFalse(InventoryCounter.isPlankItemId("oak_log"));
        assertFalse(InventoryCounter.isPlankItemId("stick"));
    }

    @Test
    void stickAndCraftingTableClassifiersAcceptExactItemsOnly() {
        assertTrue(InventoryCounter.isStickItemId("stick"));
        assertFalse(InventoryCounter.isStickItemId("sticks"));
        assertFalse(InventoryCounter.isStickItemId("bamboo"));

        assertTrue(InventoryCounter.isCraftingTableItemId("crafting_table"));
        assertFalse(InventoryCounter.isCraftingTableItemId("oak_planks"));
        assertFalse(InventoryCounter.isCraftingTableItemId("table"));
    }

    @Test
    void cobblestoneClassifierAcceptsExactCobblestoneOnly() {
        assertTrue(InventoryCounter.isCobblestoneItemId("cobblestone"));
        assertFalse(InventoryCounter.isCobblestoneItemId("stone"));
        assertFalse(InventoryCounter.isCobblestoneItemId("cobbled_deepslate"));
    }
}
