package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class Craft2x2RecipePlannerTest {
    @Test
    void exposesPlayerGridSlotLayoutsForAllRecipes() {
        assertEquals(List.of(1), Craft2x2RecipePlanner.Recipe.PLANKS.inputSlots());
        assertEquals(List.of(1, 3), Craft2x2RecipePlanner.Recipe.STICKS.inputSlots());
        assertEquals(List.of(1, 2, 3, 4), Craft2x2RecipePlanner.Recipe.TABLE.inputSlots());
    }

    @Test
    void resolvesSupportedBrainActionsOnly() {
        assertEquals(Craft2x2RecipePlanner.Recipe.PLANKS, Craft2x2RecipePlanner.fromAction("craft_planks"));
        assertEquals(Craft2x2RecipePlanner.Recipe.STICKS, Craft2x2RecipePlanner.fromAction("craft_sticks"));
        assertEquals(Craft2x2RecipePlanner.Recipe.TABLE, Craft2x2RecipePlanner.fromAction("craft_table"));
        assertFalse(Craft2x2RecipePlanner.isCraftAction("craft_pickaxe"));
    }

    @Test
    void validatesRecipeInputsByIngredientCount() {
        assertTrue(Craft2x2RecipePlanner.canStart(Craft2x2RecipePlanner.Recipe.PLANKS, 1, 0));
        assertFalse(Craft2x2RecipePlanner.canStart(Craft2x2RecipePlanner.Recipe.PLANKS, 0, 64));

        assertTrue(Craft2x2RecipePlanner.canStart(Craft2x2RecipePlanner.Recipe.STICKS, 0, 2));
        assertFalse(Craft2x2RecipePlanner.canStart(Craft2x2RecipePlanner.Recipe.STICKS, 64, 1));

        assertTrue(Craft2x2RecipePlanner.canStart(Craft2x2RecipePlanner.Recipe.TABLE, 0, 4));
        assertFalse(Craft2x2RecipePlanner.canStart(Craft2x2RecipePlanner.Recipe.TABLE, 0, 3));
    }

    @Test
    void verifiesExpectedDeltasForEachRecipe() {
        assertTrue(Craft2x2RecipePlanner.isComplete(
            Craft2x2RecipePlanner.Recipe.PLANKS,
            1, 0,
            0, 4,
            0, 0,
            0, 0
        ));
        assertTrue(Craft2x2RecipePlanner.isComplete(
            Craft2x2RecipePlanner.Recipe.STICKS,
            0, 0,
            4, 2,
            0, 4,
            0, 0
        ));
        assertTrue(Craft2x2RecipePlanner.isComplete(
            Craft2x2RecipePlanner.Recipe.TABLE,
            0, 0,
            4, 0,
            0, 0,
            0, 1
        ));
    }

    @Test
    void acceptsPlanksOutputDeltaWhenLogCountHasNotSettled() {
        assertTrue(Craft2x2RecipePlanner.isComplete(
            Craft2x2RecipePlanner.Recipe.PLANKS,
            14, 14,
            8, 12,
            0, 0,
            0, 0
        ));
    }

    @Test
    void rejectsPartialOrUnrelatedDeltas() {
        assertFalse(Craft2x2RecipePlanner.isComplete(
            Craft2x2RecipePlanner.Recipe.PLANKS,
            14, 14,
            8, 11,
            0, 0,
            0, 0
        ));
        assertFalse(Craft2x2RecipePlanner.isComplete(
            Craft2x2RecipePlanner.Recipe.STICKS,
            0, 0,
            4, 3,
            0, 4,
            0, 0
        ));
        assertFalse(Craft2x2RecipePlanner.isComplete(
            Craft2x2RecipePlanner.Recipe.TABLE,
            0, 0,
            4, 0,
            0, 4,
            0, 0
        ));
    }

    @Test
    void validatesRecipeResultItems() {
        assertTrue(Craft2x2RecipePlanner.isExpectedResult(Craft2x2RecipePlanner.Recipe.PLANKS, "oak_planks", 4));
        assertTrue(Craft2x2RecipePlanner.isExpectedResult(Craft2x2RecipePlanner.Recipe.STICKS, "stick", 4));
        assertTrue(Craft2x2RecipePlanner.isExpectedResult(Craft2x2RecipePlanner.Recipe.TABLE, "crafting_table", 1));
        assertFalse(Craft2x2RecipePlanner.isExpectedResult(Craft2x2RecipePlanner.Recipe.TABLE, "stick", 4));
        assertFalse(Craft2x2RecipePlanner.isExpectedResult(Craft2x2RecipePlanner.Recipe.STICKS, "stick", 3));
    }
}
