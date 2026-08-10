package com.mcbot.fabricclient;

/**
 * Correlates an exact village-acquired food item with observed vanilla consumption.
 *
 * <p>A receipt may account for a produced item that Survival consumed before the brain's next
 * inventory snapshot, but only when that exact item count fell while hunger rose. Unrelated food
 * use and unexplained inventory loss never become transaction authority.</p>
 */
final class VillageFoodConsumptionTracker {
    private final String itemId;
    private final int nutritionPerItem;
    private int lastItemCount;
    private int lastFoodLevel;
    private int verifiedConsumed;

    private VillageFoodConsumptionTracker(
        String itemId,
        int nutritionPerItem,
        int initialItemCount,
        int initialFoodLevel
    ) {
        this.itemId = itemId == null ? "" : itemId;
        this.nutritionPerItem = Math.max(0, nutritionPerItem);
        this.lastItemCount = Math.max(0, initialItemCount);
        this.lastFoodLevel = clampFood(initialFoodLevel);
    }

    static VillageFoodConsumptionTracker create(
        String itemId,
        int initialItemCount,
        int initialFoodLevel
    ) {
        return new VillageFoodConsumptionTracker(
            itemId,
            nutrition(itemId),
            initialItemCount,
            initialFoodLevel
        );
    }

    void observe(int currentItemCount, int currentFoodLevel) {
        int boundedCount = Math.max(0, currentItemCount);
        int boundedFood = clampFood(currentFoodLevel);
        int itemDrop = Math.max(0, lastItemCount - boundedCount);
        int foodGain = Math.max(0, boundedFood - lastFoodLevel);
        if (nutritionPerItem > 0 && itemDrop > 0 && foodGain > 0) {
            int maximumFoodUses = Math.max(1,
                (foodGain + nutritionPerItem - 1) / nutritionPerItem);
            verifiedConsumed = saturatedAdd(
                verifiedConsumed,
                Math.min(itemDrop, maximumFoodUses)
            );
        }
        lastItemCount = boundedCount;
        lastFoodLevel = boundedFood;
    }

    int verifiedConsumedForReceipt(int producedCount) {
        return Math.min(Math.max(0, producedCount), verifiedConsumed);
    }

    String itemId() {
        return itemId;
    }

    private static int nutrition(String itemId) {
        return switch (itemId == null ? "" : itemId) {
            case "minecraft:bread" -> 5;
            case "minecraft:apple", "minecraft:golden_apple" -> 4;
            default -> 0;
        };
    }

    private static int clampFood(int value) {
        return Math.max(0, Math.min(20, value));
    }

    private static int saturatedAdd(int left, int right) {
        if (right <= 0) {
            return Math.max(0, left);
        }
        return left > Integer.MAX_VALUE - right ? Integer.MAX_VALUE : left + right;
    }
}
