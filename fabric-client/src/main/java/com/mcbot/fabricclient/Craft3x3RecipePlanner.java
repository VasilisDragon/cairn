package com.mcbot.fabricclient;

import java.util.List;

final class Craft3x3RecipePlanner {
    private Craft3x3RecipePlanner() {
    }

    enum Ingredient {
        COBBLESTONE,
        IRON_INGOT,
        PLANK,
        STICK
    }

    record IngredientGroup(Ingredient ingredient, List<Integer> inputSlots) {
        int inputCount() {
            return inputSlots.size();
        }
    }

    enum Recipe {
        WOODEN_PICKAXE(
            "craft_pickaxe",
            "wooden_pickaxe",
            List.of(
                new IngredientGroup(Ingredient.PLANK, List.of(1, 2, 3)),
                new IngredientGroup(Ingredient.STICK, List.of(5, 8))
            ),
            1
        ),
        STONE_PICKAXE(
            "craft_stone_pickaxe",
            "stone_pickaxe",
            List.of(
                new IngredientGroup(Ingredient.COBBLESTONE, List.of(1, 2, 3)),
                new IngredientGroup(Ingredient.STICK, List.of(5, 8))
            ),
            1
        ),
        IRON_PICKAXE(
            "craft_iron_pickaxe",
            "iron_pickaxe",
            List.of(
                new IngredientGroup(Ingredient.IRON_INGOT, List.of(1, 2, 3)),
                new IngredientGroup(Ingredient.STICK, List.of(5, 8))
            ),
            1
        ),
        STONE_AXE(
            "craft_stone_axe",
            "stone_axe",
            List.of(
                new IngredientGroup(Ingredient.COBBLESTONE, List.of(1, 2, 4)),
                new IngredientGroup(Ingredient.STICK, List.of(5, 8))
            ),
            1
        ),
        STONE_SWORD(
            "craft_stone_sword",
            "stone_sword",
            List.of(
                new IngredientGroup(Ingredient.COBBLESTONE, List.of(2, 5)),
                new IngredientGroup(Ingredient.STICK, List.of(8))
            ),
            1
        ),
        FURNACE(
            "craft_furnace",
            "furnace",
            List.of(
                new IngredientGroup(Ingredient.COBBLESTONE, List.of(1, 2, 3, 4, 6, 7, 8, 9))
            ),
            1
        ),
        IRON_HELMET(
            "craft_iron_helmet",
            "iron_helmet",
            List.of(
                new IngredientGroup(Ingredient.IRON_INGOT, List.of(1, 2, 3, 4, 6))
            ),
            1
        ),
        IRON_CHESTPLATE(
            "craft_iron_chestplate",
            "iron_chestplate",
            List.of(
                new IngredientGroup(Ingredient.IRON_INGOT, List.of(1, 3, 4, 5, 6, 7, 8, 9))
            ),
            1
        ),
        IRON_LEGGINGS(
            "craft_iron_leggings",
            "iron_leggings",
            List.of(
                new IngredientGroup(Ingredient.IRON_INGOT, List.of(1, 2, 3, 4, 6, 7, 9))
            ),
            1
        ),
        IRON_BOOTS(
            "craft_iron_boots",
            "iron_boots",
            List.of(
                new IngredientGroup(Ingredient.IRON_INGOT, List.of(4, 6, 7, 9))
            ),
            1
        );

        private final String action;
        private final String resultItemId;
        private final List<IngredientGroup> ingredientGroups;
        private final int resultCount;

        Recipe(String action, String resultItemId, List<IngredientGroup> ingredientGroups, int resultCount) {
            this.action = action;
            this.resultItemId = resultItemId;
            this.ingredientGroups = ingredientGroups;
            this.resultCount = resultCount;
        }

        String action() {
            return action;
        }

        String resultItemId() {
            return resultItemId;
        }

        List<IngredientGroup> ingredientGroups() {
            return ingredientGroups;
        }

        int resultCount() {
            return resultCount;
        }

        int requiredPlanks() {
            return requiredCount(Ingredient.PLANK);
        }

        int requiredCobblestone() {
            return requiredCount(Ingredient.COBBLESTONE);
        }

        int requiredIronIngots() {
            return requiredCount(Ingredient.IRON_INGOT);
        }

        int requiredSticks() {
            return requiredCount(Ingredient.STICK);
        }

        private int requiredCount(Ingredient ingredient) {
            int count = 0;
            for (IngredientGroup group : ingredientGroups) {
                if (group.ingredient() == ingredient) {
                    count += group.inputCount();
                }
            }
            return count;
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

    static boolean canStart(Recipe recipe, int plankCount, int cobblestoneCount, int stickCount) {
        return canStart(recipe, plankCount, cobblestoneCount, stickCount, 0);
    }

    static boolean canStart(Recipe recipe, int plankCount, int cobblestoneCount, int stickCount, int ironIngotCount) {
        return recipe != null
            && plankCount >= recipe.requiredPlanks()
            && cobblestoneCount >= recipe.requiredCobblestone()
            && stickCount >= recipe.requiredSticks()
            && ironIngotCount >= recipe.requiredIronIngots();
    }

    static boolean isComplete(
        Recipe recipe,
        int planksBefore,
        int planksAfter,
        int cobblestoneBefore,
        int cobblestoneAfter,
        int sticksBefore,
        int sticksAfter,
        int resultBefore,
        int resultAfter
    ) {
        return isComplete(
            recipe,
            planksBefore,
            planksAfter,
            cobblestoneBefore,
            cobblestoneAfter,
            sticksBefore,
            sticksAfter,
            0,
            0,
            resultBefore,
            resultAfter
        );
    }

    static boolean isComplete(
        Recipe recipe,
        int planksBefore,
        int planksAfter,
        int cobblestoneBefore,
        int cobblestoneAfter,
        int sticksBefore,
        int sticksAfter,
        int ironIngotsBefore,
        int ironIngotsAfter,
        int resultBefore,
        int resultAfter
    ) {
        return recipe != null
            && planksBefore - planksAfter >= recipe.requiredPlanks()
            && cobblestoneBefore - cobblestoneAfter >= recipe.requiredCobblestone()
            && sticksBefore - sticksAfter >= recipe.requiredSticks()
            && ironIngotsBefore - ironIngotsAfter >= recipe.requiredIronIngots()
            && resultAfter - resultBefore >= recipe.resultCount();
    }

    static boolean isExpectedResult(Recipe recipe, String itemId, int count) {
        return recipe != null
            && itemId != null
            && recipe.resultItemId().equals(itemId)
            && count >= recipe.resultCount();
    }
}
