package com.mcbot.fabricclient;

final class IronSearchCompletionPolicy {
    enum Action {
        PARTIAL_PROGRESS,
        FAIL,
        EXHAUST_EPOCH
    }

    private IronSearchCompletionPolicy() {
    }

    static Action decide(boolean searchShaped, int inventoryDelta, int targetDelta, boolean epochExhausted) {
        if (epochExhausted) {
            return Action.EXHAUST_EPOCH;
        }
        if (searchShaped && inventoryDelta > 0 && inventoryDelta < Math.max(1, targetDelta)) {
            return Action.PARTIAL_PROGRESS;
        }
        return Action.FAIL;
    }
}
