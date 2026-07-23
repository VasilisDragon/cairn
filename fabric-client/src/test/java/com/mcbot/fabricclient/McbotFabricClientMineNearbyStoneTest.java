package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class McbotFabricClientMineNearbyStoneTest {
    @Test
    void digOrderIsTopDownRasterAmongAimableCandidates() {
        BlockPos anchor = new BlockPos(0, 64, 0);
        // Deliberately scrambled input. Expected dig order:
        //   (1) higher Y first; (2) within a layer, smaller taxicab from the anchor;
        //   (3) ties broken by signed dx-from-anchor then dz-from-anchor ascending.
        List<BlockPos> candidates = new ArrayList<>(List.of(
            new BlockPos(2, 64, 0),   // y=64, taxi=2
            new BlockPos(0, 65, 1),   // y=65, taxi=1
            new BlockPos(-1, 64, 0),  // y=64, taxi=1, dx=-1
            new BlockPos(1, 64, 0),   // y=64, taxi=1, dx=+1
            new BlockPos(0, 65, -2),  // y=65, taxi=2
            new BlockPos(0, 63, 0),   // y=63, taxi=0 (deepest layer, still last by Y)
            new BlockPos(0, 64, -1)   // y=64, taxi=1, dx=0,dz=-1
        ));
        candidates.sort((a, b) -> McbotFabricClient.gatherStoneDigOrder(a, b, anchor));

        // Layer y=65 first (higher Y wins regardless of taxicab), then y=64, then y=63.
        // Within y=64 the taxi==1 ring is ordered by signed dx then dz:
        //   dx=-1 (-1,0), dx=0 (0,-1), dx=+1 (+1,0); then taxi==2 (2,0).
        assertEquals(List.of(
            new BlockPos(0, 65, 1),
            new BlockPos(0, 65, -2),
            new BlockPos(-1, 64, 0),
            new BlockPos(0, 64, -1),
            new BlockPos(1, 64, 0),
            new BlockPos(2, 64, 0),
            new BlockPos(0, 63, 0)
        ), candidates);
    }

    @Test
    void collectApproachImprovementNeedsToBeatBestByEpsilon() {
        double eps = McbotFabricClient.GATHER_ADJACENT_MOVE_IMPROVEMENT; // 0.05
        // Closer than best by more than epsilon -> genuine improvement (re-stamp + reset the stall clock).
        assertTrue(McbotFabricClient.isMineNearbyStoneCollectApproachImproved(1.00D, 1.20D, eps));
        // Within epsilon (jitter, not real progress) -> NOT an improvement.
        assertFalse(McbotFabricClient.isMineNearbyStoneCollectApproachImproved(1.18D, 1.20D, eps));
        // Exactly epsilon closer -> NOT an improvement (strict < best-eps), matching the tracker's gate.
        assertFalse(McbotFabricClient.isMineNearbyStoneCollectApproachImproved(1.15D, 1.20D, eps));
        // Farther than best -> never an improvement.
        assertFalse(McbotFabricClient.isMineNearbyStoneCollectApproachImproved(1.30D, 1.20D, eps));
    }

    @Test
    void collectApproachStallsOnlyAfterStartedAndBudgetElapsed() {
        long budget = McbotFabricClient.NEARBY_STONE_COLLECT_APPROACH_STALL_MS; // 1500
        // Not started yet (best never stamped) -> never stalled, even at a huge "now".
        assertFalse(McbotFabricClient.isMineNearbyStoneCollectApproachStalled(0L, 1_000_000L, budget));
        // Started at t=1000; only 1000ms elapsed (< budget) -> not yet stalled.
        assertFalse(McbotFabricClient.isMineNearbyStoneCollectApproachStalled(1_000L, 2_000L, budget));
        // Exactly the budget elapsed -> stalled (inclusive >=), so it fires before the 8s collect timeout.
        assertTrue(McbotFabricClient.isMineNearbyStoneCollectApproachStalled(1_000L, 1_000L + budget, budget));
        // Well past the budget -> stalled.
        assertTrue(McbotFabricClient.isMineNearbyStoneCollectApproachStalled(1_000L, 5_000L, budget));
        // The abandon fires strictly before GATHER_COLLECT_TIMEOUT_MS (the 8s wall-press it replaces).
        assertTrue(budget < McbotFabricClient.GATHER_COLLECT_TIMEOUT_MS);
    }

    @Test
    void digOrderTaxicabIsMeasuredFromTheAnchorNotTheOrigin() {
        // Anchor offset from origin: the nearer-taxicab tie-break follows the anchor, so a block hugging
        // the anchor beats one that is closer to (0,0,0) but farther from the anchor (this is what stops
        // the post-descent sweep from ping-ponging back toward where the streak started).
        BlockPos anchor = new BlockPos(10, 64, 10);
        BlockPos nearAnchor = new BlockPos(11, 64, 10);  // taxi-from-anchor = 1
        BlockPos farFromAnchor = new BlockPos(2, 64, 2);  // taxi-from-anchor = 16
        assertTrue(McbotFabricClient.gatherStoneDigOrder(nearAnchor, farFromAnchor, anchor) < 0);
        assertTrue(McbotFabricClient.gatherStoneDigOrder(farFromAnchor, nearAnchor, anchor) > 0);
        // Same block compares equal (antisymmetric / reflexive sanity for a total order).
        assertEquals(0, McbotFabricClient.gatherStoneDigOrder(nearAnchor, nearAnchor, anchor));
    }

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

    @Test
    void faceGateConvergesOnlyWhenBothAxesWithinTolerance() {
        double tol = 7.0D;
        // Dead-on: both axes zero error -> converged.
        assertTrue(McbotFabricClient.lookConvergedOnAngles(30.0D, -45.0D, 30.0D, -45.0D, tol));
        // Just inside on both axes (6.9deg each) -> converged.
        assertTrue(McbotFabricClient.lookConvergedOnAngles(30.0D, -45.0D, 36.9D, -51.9D, tol));
        // Exactly at the boundary (7.0deg) on both axes -> still converged (inclusive <=).
        assertTrue(McbotFabricClient.lookConvergedOnAngles(0.0D, 0.0D, 7.0D, -7.0D, tol));
        // Yaw just outside (7.1deg) -> NOT converged even with pitch dead-on.
        assertFalse(McbotFabricClient.lookConvergedOnAngles(30.0D, -45.0D, 37.1D, -45.0D, tol));
        // Pitch just outside (7.1deg) -> NOT converged even with yaw dead-on.
        assertFalse(McbotFabricClient.lookConvergedOnAngles(30.0D, -45.0D, 30.0D, -52.1D, tol));
        // Far off (still slewing) -> NOT converged; this is the branch that resets the stall counter.
        assertFalse(McbotFabricClient.lookConvergedOnAngles(0.0D, 0.0D, 90.0D, 30.0D, tol));
    }

    @Test
    void faceGateConvergenceWrapsYawAcrossThe180Seam() {
        double tol = 7.0D;
        // Player at +178, aim at -179: true separation is 3deg across the seam, NOT 357deg -> converged.
        assertTrue(McbotFabricClient.lookConvergedOnAngles(178.0D, 0.0D, -179.0D, 0.0D, tol));
        // Symmetric: player at -179, aim at +178 -> still 3deg -> converged.
        assertTrue(McbotFabricClient.lookConvergedOnAngles(-179.0D, 0.0D, 178.0D, 0.0D, tol));
        // Aim wrapped by a full turn (360deg) is the same heading -> converged.
        assertTrue(McbotFabricClient.lookConvergedOnAngles(10.0D, 0.0D, 370.0D, 0.0D, tol));
        // Across the seam but genuinely far (178 vs -170 = 12deg) -> NOT converged.
        assertFalse(McbotFabricClient.lookConvergedOnAngles(178.0D, 0.0D, -170.0D, 0.0D, tol));
    }
}
