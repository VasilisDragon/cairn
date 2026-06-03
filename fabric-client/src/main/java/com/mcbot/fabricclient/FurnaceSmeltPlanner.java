package com.mcbot.fabricclient;

final class FurnaceSmeltPlanner {
    static final int INPUT_SLOT = 0;
    static final int FUEL_SLOT = 1;
    static final int OUTPUT_SLOT = 2;
    static final int PLAYER_INVENTORY_START_SLOT = 3;

    private FurnaceSmeltPlanner() {
    }

    static boolean isExpectedOutput(String itemId, int count, String expectedItemId, int expectedCount) {
        return itemId != null
            && expectedItemId != null
            && itemId.equals(expectedItemId)
            && count >= expectedCount;
    }

    static boolean isWrongOutput(String itemId, String expectedItemId) {
        return itemId != null
            && !itemId.isBlank()
            && expectedItemId != null
            && !itemId.equals(expectedItemId);
    }

    static boolean completedByInventoryDelta(int outputBefore, int outputAfter, int expectedCount) {
        return outputAfter - outputBefore >= expectedCount;
    }

    static boolean canStartWithFurnaceSlots(boolean inputEmpty, boolean fuelEmpty, boolean outputEmpty, boolean loadedFuelCompatible) {
        return inputEmpty
            && outputEmpty
            && (fuelEmpty || loadedFuelCompatible);
    }
}
