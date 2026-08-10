package com.mcbot.fabricclient;

final class FieldKitTableCraftLatch {
    enum Transition {
        STARTED,
        ACTIVE,
        COMPLETED,
        REJECTED
    }

    private boolean inFlight;
    private long startedAtMs;

    boolean inFlight() {
        return inFlight;
    }

    boolean shouldDrive(int plankCount) {
        return inFlight || plankCount >= 4;
    }

    Transition start(long nowMs) {
        if (inFlight) {
            return Transition.ACTIVE;
        }
        inFlight = true;
        startedAtMs = Math.max(0L, nowMs);
        return Transition.STARTED;
    }

    Transition observe(String reason) {
        String normalized = reason == null ? "" : reason;
        if (normalized.startsWith("craft_table_complete:")) {
            reset();
            return Transition.COMPLETED;
        }
        if (normalized.startsWith("craft_table_failed:")) {
            reset();
            return Transition.REJECTED;
        }
        return Transition.ACTIVE;
    }

    Transition observeInventory(int tableCount) {
        if (inFlight && tableCount > 0) {
            reset();
            return Transition.COMPLETED;
        }
        return Transition.ACTIVE;
    }

    long elapsedMs(long nowMs) {
        return inFlight ? Math.max(0L, nowMs - startedAtMs) : 0L;
    }

    void reset() {
        inFlight = false;
        startedAtMs = 0L;
    }
}
