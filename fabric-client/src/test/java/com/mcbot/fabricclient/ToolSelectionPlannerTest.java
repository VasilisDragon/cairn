package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ToolSelectionPlannerTest {
    @Test
    void requiresPickaxeForStoneCobbleAndOre() {
        assertEquals(ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED, ToolSelectionPlanner.decideForBlockId("stone").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED, ToolSelectionPlanner.decideForBlockId("minecraft:cobblestone").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED, ToolSelectionPlanner.decideForBlockId("iron_ore").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED, ToolSelectionPlanner.decideForBlockId("deepslate_diamond_ore").requirement());
    }

    @Test
    void usesShovelOrHandForSoftBlocks() {
        assertEquals(ToolSelectionPlanner.Requirement.SHOVEL_OR_HAND, ToolSelectionPlanner.decideForBlockId("dirt").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.SHOVEL_OR_HAND, ToolSelectionPlanner.decideForBlockId("grass_block").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.SHOVEL_OR_HAND, ToolSelectionPlanner.decideForBlockId("sand").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.SHOVEL_OR_HAND, ToolSelectionPlanner.decideForBlockId("gravel").requirement());
    }

    @Test
    void avoidsPickaxeForKnownNonPickaxeBlocks() {
        assertEquals(ToolSelectionPlanner.Requirement.AVOID_PICKAXE, ToolSelectionPlanner.decideForBlockId("oak_log").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.AVOID_PICKAXE, ToolSelectionPlanner.decideForBlockId("oak_leaves").requirement());
        assertEquals(ToolSelectionPlanner.Requirement.AVOID_PICKAXE, ToolSelectionPlanner.decideForBlockId("short_grass").requirement());
    }

    @Test
    void classifiesToolsByItemId() {
        assertTrue(ToolSelectionPlanner.isPickaxeItemId("wooden_pickaxe"));
        assertTrue(ToolSelectionPlanner.isPickaxeItemId("minecraft:netherite_pickaxe"));
        assertTrue(ToolSelectionPlanner.isShovelItemId("iron_shovel"));

        assertFalse(ToolSelectionPlanner.isPickaxeItemId("wooden_shovel"));
        assertFalse(ToolSelectionPlanner.isShovelItemId("stone_pickaxe"));
    }
}
