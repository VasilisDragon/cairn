package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class McbotFabricClientMineNearbyStoneTest {
    @Test
    void startsDescentFallbackAfterShallowProbeThresholdWithoutTarget() {
        assertFalse(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(7, 0, 0, false, false));
        assertTrue(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(8, 0, 0, false, false));
        assertTrue(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(7, 1, 0, false, false));
    }

    @Test
    void doesNotStartDescentFallbackWhenTargetExistsOrFallbackAlreadyUsed() {
        assertFalse(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(12, 0, 0, true, false));
        assertFalse(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(12, 0, 1, false, false));
    }

    @Test
    void startsDescentFallbackAfterRepeatedProbeBreakFailures() {
        assertEquals(7, McbotFabricClient.mineNearbyStoneProbeAttempts(5, 2));
        assertFalse(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(0, 1, 0, false, false));
        assertTrue(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(0, 2, 0, false, false));
        assertEquals("probe_break_failures", McbotFabricClient.mineNearbyStoneDescentFallbackReason(0, 2, false));
        assertEquals("probe_threshold", McbotFabricClient.mineNearbyStoneDescentFallbackReason(8, 0, false));
        assertEquals("probe_exhausted", McbotFabricClient.mineNearbyStoneDescentFallbackReason(24, 0, false));
    }

    @Test
    void missionCommandsStaircaseImmediatelyWithoutSurfaceProbe() {
        assertTrue(McbotFabricClient.isMissionCommandId("mission-fabric-gather-20260610-155227-42"));
        assertFalse(McbotFabricClient.isMissionCommandId("fabric-gather-r3-fixture"));
        // Mission: descent-first from probe zero; hazard-abandoned fallback budget still respected.
        assertTrue(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(0, 0, 0, false, true));
        assertFalse(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(0, 0, 1, false, true));
        assertFalse(McbotFabricClient.shouldStartMineNearbyStoneDescentFallback(0, 0, 0, true, true));
        assertEquals("mission_descent_first", McbotFabricClient.mineNearbyStoneDescentFallbackReason(0, 0, true));
        assertEquals("probe_break_failures", McbotFabricClient.mineNearbyStoneDescentFallbackReason(0, 2, true));
    }

    @Test
    void missionDescentKeepsGrabbingVisibleIronUntilArmorBankIsFull() {
        // Bootstrap (non-mission/harness): satisfied at 3 units — the pickaxe-era semantics.
        assertEquals(3, McbotFabricClient.descentIronCleanupTargetUnits(false));
        // Mission: 24 armor ingots + 3 pickaxe; an equipped pickaxe (3 units) no longer stops the grab.
        assertEquals(27, McbotFabricClient.descentIronCleanupTargetUnits(true));
    }

    @Test
    void wrapDegreesDeltaHandlesSeamCrossing() {
        assertEquals(0.0, McbotFabricClient.wrapDegreesDelta(0.0), 1e-9);
        assertEquals(-20.0, McbotFabricClient.wrapDegreesDelta(340.0), 1e-9);
        assertEquals(20.0, McbotFabricClient.wrapDegreesDelta(-340.0), 1e-9);
        assertEquals(-180.0, McbotFabricClient.wrapDegreesDelta(180.0), 1e-9);
        assertEquals(-90.0, McbotFabricClient.wrapDegreesDelta(270.0), 1e-9);
    }

    @Test
    void sprintOnlyDuringFullForwardTravelReasons() {
        assertTrue(McbotFabricClient.sprintEligibleReason("navigate_to_point"));
        assertTrue(McbotFabricClient.sprintEligibleReason("gather_tree_search_leg"));
        assertTrue(McbotFabricClient.sprintEligibleReason("mine_nearby_iron_collect_item"));
        assertTrue(McbotFabricClient.sprintEligibleReason("follow_route:3"));
        assertFalse(McbotFabricClient.sprintEligibleReason("mine_nearby_iron_face"));
        assertFalse(McbotFabricClient.sprintEligibleReason("descent_step:4"));
        assertFalse(McbotFabricClient.sprintEligibleReason("place_table_aim"));
        assertFalse(McbotFabricClient.sprintEligibleReason(null));
    }

    @Test
    void abandonsUnsafeDescentFallbackWithoutFailingStoneCommand() {
        assertTrue(McbotFabricClient.shouldAbandonMineNearbyStoneDescentFallback(
            "descent_failed:descent_hazard_in_step:water:16, 69, -5:no_safe_reroute"
        ));
        assertTrue(McbotFabricClient.shouldAbandonMineNearbyStoneDescentFallback(
            "descent_failed:descent_player_in_hazard:water:17, 67, -5"
        ));
        assertTrue(McbotFabricClient.shouldAbandonMineNearbyStoneDescentFallback(
            "descent_failed:descent_lava_adjacent:4, 62, 8"
        ));

        assertFalse(McbotFabricClient.shouldAbandonMineNearbyStoneDescentFallback(
            "descent_failed:descent_timeout"
        ));
        assertFalse(McbotFabricClient.shouldAbandonMineNearbyStoneDescentFallback(null));
    }

    @Test
    void boundsExposedStoneApproachesBeforeProbeDescentFallback() {
        assertTrue(McbotFabricClient.shouldTryMineNearbyStoneExposedApproach(0));
        assertTrue(McbotFabricClient.shouldTryMineNearbyStoneExposedApproach(1));
        assertFalse(McbotFabricClient.shouldTryMineNearbyStoneExposedApproach(2));

        assertFalse(McbotFabricClient.acceptsMineNearbyStoneExposedRouteLength(0));
        assertTrue(McbotFabricClient.acceptsMineNearbyStoneExposedRouteLength(8));
        assertFalse(McbotFabricClient.acceptsMineNearbyStoneExposedRouteLength(9));
    }

    @Test
    void boundsStoneSourceBreaksWithinOverallMineBudget() {
        assertEquals(8_000L, McbotFabricClient.mineNearbyStoneBreakTimeoutMs(true));
        assertEquals(6_000L, McbotFabricClient.mineNearbyStoneBreakTimeoutMs(false));
        assertEquals(60_000L, McbotFabricClient.mineNearbyStoneTimeoutMs());
        assertTrue(McbotFabricClient.mineNearbyStoneTimeoutMs() >= 7L * McbotFabricClient.mineNearbyStoneBreakTimeoutMs(true));
    }

    @Test
    void probesThroughSandstoneAndTerracottaOverburden() {
        assertTrue(McbotFabricClient.isMineNearbyStoneProbeBlockId("sandstone"));
        assertTrue(McbotFabricClient.isMineNearbyStoneProbeBlockId("minecraft:red_sandstone"));
        assertTrue(McbotFabricClient.isMineNearbyStoneProbeBlockId("smooth_sandstone"));
        assertTrue(McbotFabricClient.isMineNearbyStoneProbeBlockId("terracotta"));
        assertTrue(McbotFabricClient.isMineNearbyStoneProbeBlockId("minecraft:orange_terracotta"));

        assertFalse(McbotFabricClient.isMineNearbyStoneProbeBlockId("stone"));
        assertFalse(McbotFabricClient.isMineNearbyStoneProbeBlockId("white_glazed_terracotta"));
        assertFalse(McbotFabricClient.isMineNearbyStoneProbeBlockId(""));
    }

    @Test
    void uses3dCollectOnlyForDropsBelowDirectPickupHeight() {
        assertFalse(McbotFabricClient.shouldUseMineNearbyStoneNav3dCollect(64.0D, 63.0D));
        assertTrue(McbotFabricClient.shouldUseMineNearbyStoneNav3dCollect(64.0D, 62.5D));
        assertFalse(McbotFabricClient.shouldUseMineNearbyStoneNav3dCollect(Double.NaN, 62.5D));
        assertFalse(McbotFabricClient.shouldUseMineNearbyStoneNav3dCollect(64.0D, Double.POSITIVE_INFINITY));
    }
}
