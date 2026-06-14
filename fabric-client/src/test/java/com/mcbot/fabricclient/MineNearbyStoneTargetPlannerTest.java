package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class MineNearbyStoneTargetPlannerTest {
    @Test
    void currentTargetClearsWhenObservedStoneDisappears() {
        MineNearbyStoneTargetPlanner.Decision noTarget = MineNearbyStoneTargetPlanner.decideCurrentTarget(false, false);
        assertEquals(MineNearbyStoneTargetPlanner.Action.CONTINUE, noTarget.action());

        MineNearbyStoneTargetPlanner.Decision stillStone = MineNearbyStoneTargetPlanner.decideCurrentTarget(true, true);
        assertEquals(MineNearbyStoneTargetPlanner.Action.CONTINUE, stillStone.action());

        MineNearbyStoneTargetPlanner.Decision cleared = MineNearbyStoneTargetPlanner.decideCurrentTarget(true, false);
        assertEquals(MineNearbyStoneTargetPlanner.Action.TARGET_CLEARED, cleared.action());
        assertEquals("mine_nearby_stone_target_cleared", cleared.reason());
    }
}
