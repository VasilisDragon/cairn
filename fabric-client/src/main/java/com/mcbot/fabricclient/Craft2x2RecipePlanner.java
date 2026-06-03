package com.mcbot.fabricclient;

import java.util.List;

final class Craft2x2RecipePlanner {
    private Craft2x2RecipePlanner() {
    }

    enum Ingredient {
        LOG,
        PLANK
    }

    enum ResultKind {
        PLANK,
        STICK,
        CRAFTING_TABLE
    }

    enum Recipe {
        PLANKS("craft_planks", Ingredient.LOG, ResultKind.PLANK, List.of(1), 1, 4),
        STICKS("craft_sticks", Ingredient.PLANK, ResultKind.STICK, List.of(1, 3), 2, 4),
        TABLE("craft_table", Ingredient.PLANK, ResultKind.CRAFTING_TABLE, List.of(1, 2, 3, 4), 4, 1);

        private final String action;
        private final Ingredient ingredient;
        private final ResultKind resultKind;
        private final List<Integer> inputSlots;
        private final int inputCount;
        private final int resultCount;

        Recipe(String action, Ingredient ingredient, ResultKind resultKind, List<Integer> inputSlots, int inputCount, int resultCount) {
            this.action = action;
            this.ingredient = ingredient;
            this.resultKind = resultKind;
            this.inputSlots = inputSlots;
            this.inputCount = inputCount;
            this.resultCount = resultCount;
        }

        String action() {
            return action;
        }

        Ingredient ingredient() {
            return ingredient;
        }

        ResultKind resultKind() {
            return resultKind;
        }

        List<Integer> inputSlots() {
            return inputSlots;
        }

        int inputCount() {
            return inputCount;
        }

        int resultCount() {
            return resultCount;
        }
    }

    static Recipe fromAction(String action) {
        if (action == null) {
            return null;
        }
        for (Recipe recipe : Recipe.values()) {
            if (recipe.action().equals(action)) {
                return recipe;
            }
        }
        return null;
    }

    static boolean isCraftAction(String action) {
        return fromAction(action) != null;
    }

    static boolean canStart(Recipe recipe, int logCount, int plankCount) {
        if (recipe == null) {
            return false;
        }
        return switch (recipe.ingredient()) {
            case LOG -> logCount >= recipe.inputCount();
            case PLANK -> plankCount >= recipe.inputCount();
        };
    }

    static boolean isComplete(
        Recipe recipe,
        int logsBefore,
        int logsAfter,
        int planksBefore,
        int planksAfter,
        int sticksBefore,
        int sticksAfter,
        int tablesBefore,
        int tablesAfter
    ) {
        if (recipe == null) {
            return false;
        }
        return switch (recipe) {
            case PLANKS -> logsBefore - logsAfter >= recipe.inputCount()
                && planksAfter - planksBefore >= recipe.resultCount();
            case STICKS -> planksBefore - planksAfter >= recipe.inputCount()
                && sticksAfter - sticksBefore >= recipe.resultCount();
            case TABLE -> planksBefore - planksAfter >= recipe.inputCount()
                && tablesAfter - tablesBefore >= recipe.resultCount();
        };
    }

    static boolean isExpectedResult(Recipe recipe, String itemId, int count) {
        if (recipe == null || itemId == null || count < recipe.resultCount()) {
            return false;
        }
        return switch (recipe.resultKind()) {
            case PLANK -> InventoryCounter.isPlankItemId(itemId);
            case STICK -> InventoryCounter.isStickItemId(itemId);
            case CRAFTING_TABLE -> InventoryCounter.isCraftingTableItemId(itemId);
        };
    }
}
