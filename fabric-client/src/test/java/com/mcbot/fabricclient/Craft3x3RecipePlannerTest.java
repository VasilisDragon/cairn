package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class Craft3x3RecipePlannerTest {
    @Test
    void exposesWoodenPickaxeTableSlotLayout() {
        Craft3x3RecipePlanner.Recipe recipe = Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE;

        assertEquals("craft_pickaxe", recipe.action());
        assertEquals("wooden_pickaxe", recipe.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.PLANK, recipe.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(1, 2, 3), recipe.ingredientGroups().get(0).inputSlots());
        assertEquals(Craft3x3RecipePlanner.Ingredient.STICK, recipe.ingredientGroups().get(1).ingredient());
        assertEquals(List.of(5, 8), recipe.ingredientGroups().get(1).inputSlots());
    }

    @Test
    void exposesBedTableSlotLayoutAndWoolGating() {
        Craft3x3RecipePlanner.Recipe bed = Craft3x3RecipePlanner.Recipe.BED;
        assertEquals("craft_bed", bed.action());
        assertEquals("white_bed", bed.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.WOOL, bed.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(4, 5, 6), bed.ingredientGroups().get(0).inputSlots());
        assertEquals(Craft3x3RecipePlanner.Ingredient.PLANK, bed.ingredientGroups().get(1).ingredient());
        assertEquals(List.of(7, 8, 9), bed.ingredientGroups().get(1).inputSlots());
        assertEquals(3, bed.requiredWool());
        assertEquals(bed, Craft3x3RecipePlanner.fromAction("craft_bed"));
        // Wool gates the start: 3 planks alone are not enough.
        assertFalse(Craft3x3RecipePlanner.canStart(bed, 3, 0, 0, 0, 0, 2));
        assertTrue(Craft3x3RecipePlanner.canStart(bed, 3, 0, 0, 0, 0, 3));
        // Old overloads (no wool count) keep failing closed for bed — callers must pass wool.
        assertFalse(Craft3x3RecipePlanner.canStart(bed, 3, 0, 0, 0, 0));
        // Completion: planks delta + result delta suffice (wool delta is untracked by design).
        assertTrue(Craft3x3RecipePlanner.isComplete(bed, 6, 3, 0, 0, 0, 0, 0, 1));
        assertFalse(Craft3x3RecipePlanner.isComplete(bed, 6, 3, 0, 0, 0, 0, 0, 0));
    }

    @Test
    void exposesStoneToolTableSlotLayouts() {
        Craft3x3RecipePlanner.Recipe pickaxe = Craft3x3RecipePlanner.Recipe.STONE_PICKAXE;
        assertEquals("craft_stone_pickaxe", pickaxe.action());
        assertEquals("stone_pickaxe", pickaxe.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.COBBLESTONE, pickaxe.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(1, 2, 3), pickaxe.ingredientGroups().get(0).inputSlots());
        assertEquals(Craft3x3RecipePlanner.Ingredient.STICK, pickaxe.ingredientGroups().get(1).ingredient());
        assertEquals(List.of(5, 8), pickaxe.ingredientGroups().get(1).inputSlots());

        Craft3x3RecipePlanner.Recipe axe = Craft3x3RecipePlanner.Recipe.STONE_AXE;
        assertEquals("craft_stone_axe", axe.action());
        assertEquals("stone_axe", axe.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.COBBLESTONE, axe.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(1, 2, 4), axe.ingredientGroups().get(0).inputSlots());
        assertEquals(Craft3x3RecipePlanner.Ingredient.STICK, axe.ingredientGroups().get(1).ingredient());
        assertEquals(List.of(5, 8), axe.ingredientGroups().get(1).inputSlots());

        Craft3x3RecipePlanner.Recipe sword = Craft3x3RecipePlanner.Recipe.STONE_SWORD;
        assertEquals("craft_stone_sword", sword.action());
        assertEquals("stone_sword", sword.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.COBBLESTONE, sword.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(2, 5), sword.ingredientGroups().get(0).inputSlots());
        assertEquals(Craft3x3RecipePlanner.Ingredient.STICK, sword.ingredientGroups().get(1).ingredient());
        assertEquals(List.of(8), sword.ingredientGroups().get(1).inputSlots());

        Craft3x3RecipePlanner.Recipe ironPickaxe = Craft3x3RecipePlanner.Recipe.IRON_PICKAXE;
        assertEquals("craft_iron_pickaxe", ironPickaxe.action());
        assertEquals("iron_pickaxe", ironPickaxe.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.IRON_INGOT, ironPickaxe.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(1, 2, 3), ironPickaxe.ingredientGroups().get(0).inputSlots());
        assertEquals(Craft3x3RecipePlanner.Ingredient.STICK, ironPickaxe.ingredientGroups().get(1).ingredient());
        assertEquals(List.of(5, 8), ironPickaxe.ingredientGroups().get(1).inputSlots());

        Craft3x3RecipePlanner.Recipe diamondPickaxe = Craft3x3RecipePlanner.Recipe.DIAMOND_PICKAXE;
        assertEquals("craft_diamond_pickaxe", diamondPickaxe.action());
        assertEquals("diamond_pickaxe", diamondPickaxe.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.DIAMOND, diamondPickaxe.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(1, 2, 3), diamondPickaxe.ingredientGroups().get(0).inputSlots());
        assertEquals(Craft3x3RecipePlanner.Ingredient.STICK, diamondPickaxe.ingredientGroups().get(1).ingredient());
        assertEquals(List.of(5, 8), diamondPickaxe.ingredientGroups().get(1).inputSlots());
        assertEquals(3, diamondPickaxe.requiredDiamonds());
    }

    @Test
    void exposesFurnaceTableSlotLayout() {
        Craft3x3RecipePlanner.Recipe furnace = Craft3x3RecipePlanner.Recipe.FURNACE;

        assertEquals("craft_furnace", furnace.action());
        assertEquals("furnace", furnace.resultItemId());
        assertEquals(Craft3x3RecipePlanner.Ingredient.COBBLESTONE, furnace.ingredientGroups().get(0).ingredient());
        assertEquals(List.of(1, 2, 3, 4, 6, 7, 8, 9), furnace.ingredientGroups().get(0).inputSlots());
        assertEquals(8, furnace.requiredCobblestone());
        assertEquals(0, furnace.requiredSticks());
        assertEquals(0, furnace.requiredPlanks());
    }

    @Test
    void exposesIronArmorTableSlotLayouts() {
        Craft3x3RecipePlanner.Recipe helmet = Craft3x3RecipePlanner.Recipe.IRON_HELMET;
        assertEquals("craft_iron_helmet", helmet.action());
        assertEquals("iron_helmet", helmet.resultItemId());
        assertEquals(List.of(1, 2, 3, 4, 6), helmet.ingredientGroups().get(0).inputSlots());
        assertEquals(5, helmet.requiredIronIngots());

        Craft3x3RecipePlanner.Recipe chestplate = Craft3x3RecipePlanner.Recipe.IRON_CHESTPLATE;
        assertEquals("craft_iron_chestplate", chestplate.action());
        assertEquals("iron_chestplate", chestplate.resultItemId());
        assertEquals(List.of(1, 3, 4, 5, 6, 7, 8, 9), chestplate.ingredientGroups().get(0).inputSlots());
        assertEquals(8, chestplate.requiredIronIngots());

        Craft3x3RecipePlanner.Recipe leggings = Craft3x3RecipePlanner.Recipe.IRON_LEGGINGS;
        assertEquals("craft_iron_leggings", leggings.action());
        assertEquals("iron_leggings", leggings.resultItemId());
        assertEquals(List.of(1, 2, 3, 4, 6, 7, 9), leggings.ingredientGroups().get(0).inputSlots());
        assertEquals(7, leggings.requiredIronIngots());

        Craft3x3RecipePlanner.Recipe boots = Craft3x3RecipePlanner.Recipe.IRON_BOOTS;
        assertEquals("craft_iron_boots", boots.action());
        assertEquals("iron_boots", boots.resultItemId());
        assertEquals(List.of(4, 6, 7, 9), boots.ingredientGroups().get(0).inputSlots());
        assertEquals(4, boots.requiredIronIngots());
    }

    @Test
    void resolvesSupportedBrainActionOnly() {
        assertEquals(Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE, Craft3x3RecipePlanner.fromAction("craft_pickaxe"));
        assertEquals(Craft3x3RecipePlanner.Recipe.STONE_PICKAXE, Craft3x3RecipePlanner.fromAction("craft_stone_pickaxe"));
        assertEquals(Craft3x3RecipePlanner.Recipe.STONE_AXE, Craft3x3RecipePlanner.fromAction("craft_stone_axe"));
        assertEquals(Craft3x3RecipePlanner.Recipe.STONE_SWORD, Craft3x3RecipePlanner.fromAction("craft_stone_sword"));
        assertEquals(Craft3x3RecipePlanner.Recipe.FURNACE, Craft3x3RecipePlanner.fromAction("craft_furnace"));
        assertEquals(Craft3x3RecipePlanner.Recipe.IRON_PICKAXE, Craft3x3RecipePlanner.fromAction("craft_iron_pickaxe"));
        assertEquals(Craft3x3RecipePlanner.Recipe.DIAMOND_PICKAXE, Craft3x3RecipePlanner.fromAction("craft_diamond_pickaxe"));
        assertEquals(Craft3x3RecipePlanner.Recipe.IRON_HELMET, Craft3x3RecipePlanner.fromAction("craft_iron_helmet"));
        assertEquals(Craft3x3RecipePlanner.Recipe.IRON_CHESTPLATE, Craft3x3RecipePlanner.fromAction("craft_iron_chestplate"));
        assertEquals(Craft3x3RecipePlanner.Recipe.IRON_LEGGINGS, Craft3x3RecipePlanner.fromAction("craft_iron_leggings"));
        assertEquals(Craft3x3RecipePlanner.Recipe.IRON_BOOTS, Craft3x3RecipePlanner.fromAction("craft_iron_boots"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_pickaxe"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_stone_pickaxe"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_stone_axe"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_stone_sword"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_furnace"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_iron_pickaxe"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_diamond_pickaxe"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_iron_helmet"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_iron_chestplate"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_iron_leggings"));
        assertTrue(Craft3x3RecipePlanner.isCraftAction("craft_iron_boots"));
        assertFalse(Craft3x3RecipePlanner.isCraftAction("craft_table"));
    }

    @Test
    void validatesRecipeInputsByTypedCounts() {
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE, 3, 0, 2));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE, 2, 3, 2));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE, 3, 3, 1));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.STONE_PICKAXE, 0, 3, 2));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.STONE_PICKAXE, 64, 2, 2));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.STONE_PICKAXE, 64, 3, 1));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.STONE_AXE, 0, 3, 2));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.STONE_SWORD, 0, 2, 1));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.FURNACE, 0, 8, 0));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.FURNACE, 64, 7, 64));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.IRON_PICKAXE, 0, 0, 2, 3));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.IRON_PICKAXE, 64, 64, 2, 2));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.DIAMOND_PICKAXE, 0, 0, 2, 0, 3));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.DIAMOND_PICKAXE, 64, 64, 2, 64, 2));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.IRON_HELMET, 0, 0, 0, 5));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.IRON_CHESTPLATE, 0, 0, 0, 8));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.IRON_LEGGINGS, 0, 0, 0, 7));
        assertTrue(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.IRON_BOOTS, 0, 0, 0, 4));
        assertFalse(Craft3x3RecipePlanner.canStart(Craft3x3RecipePlanner.Recipe.IRON_HELMET, 0, 0, 0, 4));
    }

    @Test
    void verifiesTypedOutputAndConsumedInputs() {
        assertTrue(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE,
            3,
            0,
            0,
            0,
            2,
            0,
            0,
            1
        ));
        assertFalse(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE,
            3,
            0,
            0,
            0,
            2,
            0,
            0,
            0
        ));
        assertFalse(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE,
            3,
            1,
            0,
            0,
            2,
            0,
            0,
            1
        ));
        assertTrue(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.STONE_PICKAXE,
            0,
            0,
            3,
            0,
            2,
            0,
            0,
            1
        ));
        assertFalse(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.STONE_PICKAXE,
            0,
            0,
            3,
            1,
            2,
            0,
            0,
            1
        ));
        assertTrue(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.IRON_PICKAXE,
            0,
            0,
            0,
            0,
            2,
            0,
            3,
            0,
            0,
            0,
            0,
            1
        ));
        assertFalse(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.IRON_PICKAXE,
            0,
            0,
            0,
            0,
            2,
            0,
            3,
            1,
            0,
            0,
            0,
            1
        ));
        assertTrue(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.DIAMOND_PICKAXE,
            0,
            0,
            0,
            0,
            2,
            0,
            0,
            0,
            3,
            0,
            0,
            1
        ));
        assertFalse(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.DIAMOND_PICKAXE,
            0,
            0,
            0,
            0,
            2,
            0,
            0,
            0,
            3,
            1,
            0,
            1
        ));
        assertTrue(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.IRON_HELMET,
            0,
            0,
            0,
            0,
            0,
            0,
            5,
            0,
            0,
            0,
            0,
            1
        ));
    }

    @Test
    void acceptsExpectedOutputDeltaWhenIngredientSnapshotIsNoisy() {
        assertFalse(Craft3x3RecipePlanner.isComplete(
            Craft3x3RecipePlanner.Recipe.STONE_PICKAXE,
            0,
            0,
            78,
            76,
            3,
            1,
            1,
            2
        ));
        assertTrue(Craft3x3RecipePlanner.hasExpectedOutputDelta(Craft3x3RecipePlanner.Recipe.STONE_PICKAXE, 1, 2));
        assertFalse(Craft3x3RecipePlanner.hasExpectedOutputDelta(Craft3x3RecipePlanner.Recipe.STONE_PICKAXE, 1, 1));
    }

    @Test
    void validatesExactRecipeResultItem() {
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE, "wooden_pickaxe", 1));
        assertFalse(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE, "stone_pickaxe", 1));
        assertFalse(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.WOODEN_PICKAXE, "wooden_pickaxe", 0));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.STONE_PICKAXE, "stone_pickaxe", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.STONE_AXE, "stone_axe", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.STONE_SWORD, "stone_sword", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.FURNACE, "furnace", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.IRON_PICKAXE, "iron_pickaxe", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.DIAMOND_PICKAXE, "diamond_pickaxe", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.IRON_HELMET, "iron_helmet", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.IRON_CHESTPLATE, "iron_chestplate", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.IRON_LEGGINGS, "iron_leggings", 1));
        assertTrue(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.IRON_BOOTS, "iron_boots", 1));
        assertFalse(Craft3x3RecipePlanner.isExpectedResult(Craft3x3RecipePlanner.Recipe.STONE_SWORD, "stone_axe", 1));
    }
}
