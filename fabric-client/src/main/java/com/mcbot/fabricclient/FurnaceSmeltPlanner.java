package com.mcbot.fabricclient;

final class FurnaceSmeltPlanner {
    static final int INPUT_SLOT = 0;
    static final int FUEL_SLOT = 1;
    static final int OUTPUT_SLOT = 2;
    static final int PLAYER_INVENTORY_START_SLOT = 3;
    static final int RAW_IRON_BATCH_MAX = 3;
    private static final long VANILLA_SMELT_MS_PER_ITEM = 10_000L;
    private static final long FURNACE_REOPEN_SAFETY_MARGIN_MS = 750L;

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

    static int desiredRawIronBatchSize(int rawIron, int ironIngots, int ironPickaxes) {
        int raw = Math.max(0, rawIron);
        if (raw <= 0) {
            return 0;
        }
        int currentIngots = Math.max(0, ironIngots);
        int batchLimit = Math.min(raw, RAW_IRON_BATCH_MAX);
        if (ironPickaxes < 1) {
            int pickaxeShortfall = Math.max(1, 3 - currentIngots);
            return Math.max(1, Math.min(batchLimit, pickaxeShortfall));
        }
        return Math.max(1, batchLimit);
    }

    static int desiredFuelItemCount(int inputCount, String fuelItemId) {
        int count = Math.max(1, inputCount);
        String id = fuelItemId == null ? "" : fuelItemId.trim().toLowerCase();
        if ("coal".equals(id) || "charcoal".equals(id)) {
            return Math.max(1, (count + 7) / 8);
        }
        if (id.endsWith("_planks") || id.endsWith("_log") || id.endsWith("_stem") || id.endsWith("_wood")) {
            return desiredWoodFuelItemCount(count);
        }
        return count;
    }

    static int desiredWoodFuelItemCount(int inputCount) {
        int count = Math.max(1, inputCount);
        return Math.max(1, (count * 2 + 2) / 3);
    }

    static long expectedSmeltReadyMs(int inputCount) {
        return VANILLA_SMELT_MS_PER_ITEM * Math.max(1, inputCount);
    }

    static boolean shouldWaitWithFurnaceScreenClosed(long waitedMs, int inputCount) {
        int count = Math.max(1, inputCount);
        if (count <= 1) {
            return false;
        }
        long reopenAtMs = Math.max(1_000L, expectedSmeltReadyMs(count) - FURNACE_REOPEN_SAFETY_MARGIN_MS);
        return Math.max(0L, waitedMs) < reopenAtMs;
    }
}
