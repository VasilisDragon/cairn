package com.mcbot.fabricclient;

final class MineNearbyStoneTargetPlanner {
    private MineNearbyStoneTargetPlanner() {
    }

    enum Action {
        CONTINUE,
        TARGET_CLEARED
    }

    record Decision(Action action, String reason) {
    }

    static Decision decideCurrentTarget(boolean hasTarget, boolean stillStone) {
        if (!hasTarget || stillStone) {
            return new Decision(Action.CONTINUE, "");
        }
        return new Decision(Action.TARGET_CLEARED, "mine_nearby_stone_target_cleared");
    }
}
