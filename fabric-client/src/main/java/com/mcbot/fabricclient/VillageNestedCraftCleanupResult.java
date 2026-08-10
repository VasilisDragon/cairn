package com.mcbot.fabricclient;

/** Bounded status from returning village-owned nested-craft state to player inventory. */
record VillageNestedCraftCleanupResult(
    Status status,
    boolean cursorEmpty,
    int occupiedInputSlots,
    boolean clickIssued,
    String reason
) {
    enum Status {
        CLEAN,
        PENDING,
        REJECTED
    }

    VillageNestedCraftCleanupResult {
        status = status == null ? Status.REJECTED : status;
        occupiedInputSlots = Math.max(0, occupiedInputSlots);
        reason = reason == null ? "" : reason;
    }

    static VillageNestedCraftCleanupResult clean() {
        return new VillageNestedCraftCleanupResult(Status.CLEAN, true, 0, false, "clean");
    }
}
