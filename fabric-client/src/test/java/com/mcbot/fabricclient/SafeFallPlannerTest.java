package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Offline coverage for the pure controlled-safe-fall survivability rules ({@link SafeFallPlanner}).
 *
 * <p>The world-coupled detection ({@code DescentExecutor.canSafeFallFromStall}) samples each cell of a
 * candidate drop into the booleans these methods take, so exercising the rules here pins down the
 * accept/reject decision without a live world. The drop cap is {@link WalkabilityClassifier#MAX_SAFE_DROP}
 * (= 3, the project-wide zero-fall-damage drop).
 */
class SafeFallPlannerTest {

    private static final int MAX = WalkabilityClassifier.MAX_SAFE_DROP;

    private static final boolean[] ALL_SOLID = {true, true, true, true};
    private static final boolean[] NONE_SOLID = {false, false, false, false};

    @Test
    void threeBlockClearDropToSolidFloorIsSafe() {
        // Clear column, solid non-hazard floor, air feet+head, no hazard/lava, an open side -> safe.
        assertTrue(SafeFallPlanner.isSurvivableLanding(
            3, MAX,
            true,   // columnClear
            true,   // floorSolid
            true,   // feetAir
            true,   // headAir
            false,  // landingHazard
            false,  // adjacentLava
            false   // boxedPit
        ));
        // A 1- and 2-block clear drop are likewise safe (within the cap).
        assertTrue(SafeFallPlanner.isSurvivableLanding(1, MAX, true, true, true, true, false, false, false));
        assertTrue(SafeFallPlanner.isSurvivableLanding(2, MAX, true, true, true, true, false, false, false));
    }

    @Test
    void fourBlockDropIsRejected() {
        // Beyond MAX_SAFE_DROP -> reject even with an otherwise perfect landing (would take fall damage).
        assertFalse(SafeFallPlanner.isSurvivableLanding(
            MAX + 1, MAX, true, true, true, true, false, false, false
        ));
    }

    @Test
    void zeroOrNegativeFallIsRejected() {
        assertFalse(SafeFallPlanner.isSurvivableLanding(0, MAX, true, true, true, true, false, false, false));
        assertFalse(SafeFallPlanner.isSurvivableLanding(-1, MAX, true, true, true, true, false, false, false));
    }

    @Test
    void lavaLandingIsRejected() {
        // Adjacent lava at the landing -> reject.
        assertFalse(SafeFallPlanner.isSurvivableLanding(
            2, MAX, true, true, true, true, false, /* adjacentLava */ true, false
        ));
        // Hazard occupying the landing feet/head -> reject.
        assertFalse(SafeFallPlanner.isSurvivableLanding(
            2, MAX, true, true, true, true, /* landingHazard */ true, false, false
        ));
    }

    @Test
    void boxedPitLandingIsRejected() {
        // Fully boxed pit (all 4 dirs walled at both levels) -> reject even though the floor is sound.
        assertFalse(SafeFallPlanner.isSurvivableLanding(
            2, MAX, true, true, true, true, false, false, /* boxedPit */ true
        ));
    }

    @Test
    void midColumnBlockIsRejected() {
        // A solid/partial block (or mid-column hazard) in the drop column clears the columnClear flag.
        assertFalse(SafeFallPlanner.isSurvivableLanding(
            3, MAX, /* columnClear */ false, true, true, true, false, false, false
        ));
    }

    @Test
    void noFloorOrBlockedFeetHeadIsRejected() {
        // No solid floor below -> reject (would keep falling).
        assertFalse(SafeFallPlanner.isSurvivableLanding(2, MAX, true, /* floorSolid */ false, true, true, false, false, false));
        // Solid block in the landing feet cell -> reject.
        assertFalse(SafeFallPlanner.isSurvivableLanding(2, MAX, true, true, /* feetAir */ false, true, false, false, false));
        // Solid block in the head cell -> reject (no head room).
        assertFalse(SafeFallPlanner.isSurvivableLanding(2, MAX, true, true, true, /* headAir */ false, false, false, false));
    }

    @Test
    void boxedPitRequiresAllFourDirectionsWalledAtBothLevels() {
        // All four directions solid at both feet and head levels -> boxed.
        assertTrue(SafeFallPlanner.isBoxedPit(ALL_SOLID, ALL_SOLID));
        // Any open side (feet OR head level) -> not boxed (steppable/climbable out).
        boolean[] oneFeetOpen = {true, true, true, false};
        assertFalse(SafeFallPlanner.isBoxedPit(oneFeetOpen, ALL_SOLID));
        boolean[] oneHeadOpen = {true, false, true, true};
        assertFalse(SafeFallPlanner.isBoxedPit(ALL_SOLID, oneHeadOpen));
        // No walls at all -> open.
        assertFalse(SafeFallPlanner.isBoxedPit(NONE_SOLID, NONE_SOLID));
    }

    @Test
    void boxedPitGuardsAgainstMalformedNeighbourArrays() {
        // Null / wrong-length neighbour data must NOT be treated as a boxed pit (do not invent a trap).
        assertFalse(SafeFallPlanner.isBoxedPit(null, ALL_SOLID));
        assertFalse(SafeFallPlanner.isBoxedPit(ALL_SOLID, null));
        assertFalse(SafeFallPlanner.isBoxedPit(new boolean[]{true, true}, new boolean[]{true, true}));
    }

    @Test
    void fallDamageIsZeroThroughThresholdThenOnePerBlock() {
        // The first VANILLA_SAFE_FALL_BLOCKS (=3) blocks are free; each beyond deals one point of damage.
        assertTrue(SafeFallPlanner.fallDamage(1) == 0);
        assertTrue(SafeFallPlanner.fallDamage(SafeFallPlanner.VANILLA_SAFE_FALL_BLOCKS) == 0);
        assertTrue(SafeFallPlanner.fallDamage(SafeFallPlanner.VANILLA_SAFE_FALL_BLOCKS + 1) == 1);
        assertTrue(SafeFallPlanner.fallDamage(13) == 10);
        // Never negative for zero / nonsense inputs.
        assertTrue(SafeFallPlanner.fallDamage(0) == 0);
        assertTrue(SafeFallPlanner.fallDamage(-5) == 0);
    }

    @Test
    void healthSurvivableFallGatesOnDepthCapAndHealthMargin() {
        // maxHealthFall=13, margin=10: at full health a 13-block fall (10 damage) lands at exactly the
        // margin -> committable; one block deeper exceeds the depth cap; the same fall at reduced health
        // would land below the margin -> rejected.
        assertTrue(SafeFallPlanner.isHealthSurvivableFall(13, 13, 20.0F, 10.0F));   // 10 damage, lands at 10
        assertTrue(SafeFallPlanner.isHealthSurvivableFall(4, 13, 20.0F, 10.0F));    // 1 damage, ample margin
        assertFalse(SafeFallPlanner.isHealthSurvivableFall(14, 13, 20.0F, 10.0F));  // beyond depth cap
        assertFalse(SafeFallPlanner.isHealthSurvivableFall(13, 13, 15.0F, 10.0F));  // 10 damage, would land at 5
        // A zero-damage drop passes iff current health is at/above the margin (the caller also accepts a
        // zero-damage drop unconditionally via the shallow tier, so this only governs the deep disjunct).
        assertTrue(SafeFallPlanner.isHealthSurvivableFall(2, 13, 10.0F, 10.0F));
        assertFalse(SafeFallPlanner.isHealthSurvivableFall(2, 13, 9.0F, 10.0F));
        // Zero / negative fall is never survivable.
        assertFalse(SafeFallPlanner.isHealthSurvivableFall(0, 13, 20.0F, 10.0F));
    }

    @Test
    void physicallySafeLandingIsDepthIndependentAndMatchesLegacyConjunction() {
        // The physical checks alone accept a perfect landing and reject each individual hazard, with no
        // fall-distance argument (depth is the caller's separate concern).
        assertTrue(SafeFallPlanner.isPhysicallySafeLanding(true, true, true, true, false, false, false));
        assertFalse(SafeFallPlanner.isPhysicallySafeLanding(false, true, true, true, false, false, false)); // column
        assertFalse(SafeFallPlanner.isPhysicallySafeLanding(true, false, true, true, false, false, false)); // floor
        assertFalse(SafeFallPlanner.isPhysicallySafeLanding(true, true, false, true, false, false, false)); // feet
        assertFalse(SafeFallPlanner.isPhysicallySafeLanding(true, true, true, false, false, false, false)); // head
        assertFalse(SafeFallPlanner.isPhysicallySafeLanding(true, true, true, true, true, false, false));   // hazard
        assertFalse(SafeFallPlanner.isPhysicallySafeLanding(true, true, true, true, false, true, false));   // lava
        assertFalse(SafeFallPlanner.isPhysicallySafeLanding(true, true, true, true, false, false, true));   // boxed
        // The refactored isSurvivableLanding is exactly (within-cap) AND isPhysicallySafeLanding.
        assertTrue(
            SafeFallPlanner.isSurvivableLanding(2, MAX, true, true, true, true, false, false, false)
                == SafeFallPlanner.isPhysicallySafeLanding(true, true, true, true, false, false, false));
        assertTrue(
            SafeFallPlanner.isSurvivableLanding(2, MAX, true, false, true, true, false, false, false)
                == SafeFallPlanner.isPhysicallySafeLanding(true, false, true, true, false, false, false));
    }

    @Test
    void safeFallInProgressDecisionFollowsLandedTimeoutFacingPriority() {
        // Landed wins over everything (even a coincident timeout).
        assertTrue(SafeFallPlanner.safeFallInProgressDecision(true, false, false)
            == SafeFallPlanner.SafeFallProgress.REANCHOR);
        assertTrue(SafeFallPlanner.safeFallInProgressDecision(true, true, true)
            == SafeFallPlanner.SafeFallProgress.REANCHOR);
        // Not landed but timed out -> fail out of the hold.
        assertTrue(SafeFallPlanner.safeFallInProgressDecision(false, true, true)
            == SafeFallPlanner.SafeFallProgress.TIMEOUT_FAIL);
        // In progress: nudge off the ledge once facing the column, otherwise hold the aim.
        assertTrue(SafeFallPlanner.safeFallInProgressDecision(false, false, true)
            == SafeFallPlanner.SafeFallProgress.NUDGE_OFF_LEDGE);
        assertTrue(SafeFallPlanner.safeFallInProgressDecision(false, false, false)
            == SafeFallPlanner.SafeFallProgress.HOLD_AIM);
    }
}
