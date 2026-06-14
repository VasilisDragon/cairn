package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class IronHarvestPickaxePreferenceTest {
    @Test
    void ironHarvestPredicateAcceptsStoneOrBetterOnly() {
        assertTrue(McbotFabricClient.isIronHarvestPickaxeItemId("stone_pickaxe"));
        assertTrue(McbotFabricClient.isIronHarvestPickaxeItemId("iron_pickaxe"));
        assertTrue(McbotFabricClient.isIronHarvestPickaxeItemId("diamond_pickaxe"));
        assertTrue(McbotFabricClient.isIronHarvestPickaxeItemId("netherite_pickaxe"));

        assertFalse(McbotFabricClient.isIronHarvestPickaxeItemId("wooden_pickaxe"));
        assertFalse(McbotFabricClient.isIronHarvestPickaxeItemId("stone_axe"));
        assertFalse(McbotFabricClient.isIronHarvestPickaxeItemId(""));
    }

    @Test
    void proactiveRestockEscapeHatchRequiresBetterThanStone() {
        assertFalse(McbotFabricClient.isBetterThanStoneIronHarvestPickaxeItemId("stone_pickaxe"));
        assertFalse(McbotFabricClient.isBetterThanStoneIronHarvestPickaxeItemId("wooden_pickaxe"));

        assertTrue(McbotFabricClient.isBetterThanStoneIronHarvestPickaxeItemId("iron_pickaxe"));
        assertTrue(McbotFabricClient.isBetterThanStoneIronHarvestPickaxeItemId("diamond_pickaxe"));
        assertTrue(McbotFabricClient.isBetterThanStoneIronHarvestPickaxeItemId("netherite_pickaxe"));
    }
}
