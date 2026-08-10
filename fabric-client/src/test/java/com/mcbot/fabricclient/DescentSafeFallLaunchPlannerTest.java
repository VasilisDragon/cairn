package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class DescentSafeFallLaunchPlannerTest {
    private static final VoxelCell ORIGIN = new VoxelCell(0, 20, 0);
    private static final VoxelCell LAUNCH_FEET = new VoxelCell(1, 20, 0);
    private static final VoxelCell LAUNCH_HEAD = new VoxelCell(1, 21, 0);
    private static final VoxelCell COLUMN = new VoxelCell(1, 19, 0);
    private static final VoxelCell LANDING = new VoxelCell(1, 18, 0);

    @Test
    void clearEnvelopeFreezesCompleteSafeFallPackage() {
        DescentSafeFallLaunchPlanner.Decision decision =
            DescentSafeFallLaunchPlanner.plan(request(clear(LAUNCH_FEET), clear(LAUNCH_HEAD)));

        assertTrue(decision.accepted());
        assertEquals("launch_envelope_clear", decision.reason());
        assertEquals(ORIGIN, decision.plan().origin());
        assertEquals(LAUNCH_FEET, decision.plan().launchFeet());
        assertEquals(LAUNCH_HEAD, decision.plan().launchHead());
        assertEquals(COLUMN, decision.plan().dropColumn());
        assertEquals(LANDING, decision.plan().landing());
        assertEquals(2, decision.plan().fallDepth());
        assertEquals(0, decision.plan().expectedDamage());
        assertEquals(List.of(), decision.plan().clearanceCells());
    }

    @Test
    void leafClearanceIsLimitedAndOrderedHeadBeforeFeet() {
        DescentSafeFallLaunchPlanner.Decision both =
            DescentSafeFallLaunchPlanner.plan(request(leaves(LAUNCH_FEET), leaves(LAUNCH_HEAD)));
        assertTrue(both.accepted());
        assertEquals("launch_envelope_clearable", both.reason());
        assertEquals(List.of(LAUNCH_HEAD, LAUNCH_FEET), both.plan().clearanceCells());

        DescentSafeFallLaunchPlanner.Decision onlyFeet =
            DescentSafeFallLaunchPlanner.plan(request(leaves(LAUNCH_FEET), clear(LAUNCH_HEAD)));
        assertEquals(List.of(LAUNCH_FEET), onlyFeet.plan().clearanceCells());
    }

    @Test
    void nonLeafSolidsAndGravityBlocksCannotBorrowClearanceAuthority() {
        DescentSafeFallLaunchPlanner.LaunchCell solid =
            new DescentSafeFallLaunchPlanner.LaunchCell(
                LAUNCH_HEAD, false, false, false, false, false, false);
        DescentSafeFallLaunchPlanner.Decision solidResult =
            DescentSafeFallLaunchPlanner.plan(request(clear(LAUNCH_FEET), solid));
        assertFalse(solidResult.accepted());
        assertEquals("launch_head_blocked", solidResult.reason());

        DescentSafeFallLaunchPlanner.LaunchCell gravity =
            new DescentSafeFallLaunchPlanner.LaunchCell(
                LAUNCH_HEAD, false, true, false, false, false, true);
        DescentSafeFallLaunchPlanner.Decision gravityResult =
            DescentSafeFallLaunchPlanner.plan(request(clear(LAUNCH_FEET), gravity));
        assertFalse(gravityResult.accepted());
        assertEquals("launch_head_gravity_block", gravityResult.reason());
    }

    @Test
    void rejectedCandidateRetainsDiagnosticGeometryWithoutMovementAuthority() {
        DescentSafeFallLaunchPlanner.LaunchCell solid =
            new DescentSafeFallLaunchPlanner.LaunchCell(
                LAUNCH_HEAD, false, false, false, false, false, false);

        DescentSafeFallLaunchPlanner.Decision rejected =
            DescentSafeFallLaunchPlanner.plan(request(clear(LAUNCH_FEET), solid));

        assertFalse(rejected.accepted());
        assertNull(rejected.plan(), "rejected geometry must never become an executable plan");
        assertNotNull(rejected.evaluation());
        assertEquals(ORIGIN, rejected.evaluation().origin());
        assertEquals(LAUNCH_FEET, rejected.evaluation().launchFeet());
        assertEquals(LAUNCH_HEAD, rejected.evaluation().launchHead());
        assertEquals(COLUMN, rejected.evaluation().dropColumn());
        assertEquals(LANDING, rejected.evaluation().landing());
        assertEquals(2, rejected.evaluation().fallDepth());
        assertEquals(0, rejected.evaluation().expectedDamage());
        assertEquals("launch_head_blocked", rejected.reason());
    }

    @Test
    void launchLiquidsHazardsAndAdjacentLavaRejectBeforeClearance() {
        assertRejected(
            launch(LAUNCH_HEAD, true, true, false, false, false),
            "launch_head_liquid"
        );
        assertRejected(
            launch(LAUNCH_HEAD, true, false, true, false, false),
            "launch_head_hazard"
        );
        assertRejected(
            launch(LAUNCH_HEAD, true, false, false, true, false),
            "launch_head_adjacent_lava"
        );
    }

    @Test
    void originMustBeGroundedDryClearStableAndSafe() {
        List<DescentSafeFallLaunchPlanner.Origin> rejected = List.of(
            new DescentSafeFallLaunchPlanner.Origin(ORIGIN, false, true, true, true, true, false),
            new DescentSafeFallLaunchPlanner.Origin(ORIGIN, true, false, true, true, true, false),
            new DescentSafeFallLaunchPlanner.Origin(ORIGIN, true, true, false, true, true, false),
            new DescentSafeFallLaunchPlanner.Origin(ORIGIN, true, true, true, false, true, false),
            new DescentSafeFallLaunchPlanner.Origin(ORIGIN, true, true, true, true, false, false),
            new DescentSafeFallLaunchPlanner.Origin(ORIGIN, true, true, true, true, true, true)
        );
        List<String> reasons = List.of(
            "origin_not_grounded",
            "origin_not_dry",
            "origin_body_blocked",
            "origin_support_unstable",
            "origin_hazard",
            "origin_adjacent_lava"
        );
        for (int i = 0; i < rejected.size(); i++) {
            DescentSafeFallLaunchPlanner.Request base = request(clear(LAUNCH_FEET), clear(LAUNCH_HEAD));
            DescentSafeFallLaunchPlanner.Decision result = DescentSafeFallLaunchPlanner.plan(
                new DescentSafeFallLaunchPlanner.Request(
                    rejected.get(i),
                    base.launchFeet(),
                    base.launchHead(),
                    base.dropColumn(),
                    base.landing(),
                    base.fallDepth(),
                    base.maxSafeFall(),
                    base.maxHealthFall(),
                    base.currentHealth(),
                    base.healthMargin()
                )
            );
            assertEquals(reasons.get(i), result.reason());
        }
    }

    @Test
    void landingAndDropColumnMustRemainDryStableAndUnboxed() {
        DescentSafeFallLaunchPlanner.Request base = request(clear(LAUNCH_FEET), clear(LAUNCH_HEAD));
        List<DescentSafeFallLaunchPlanner.Landing> rejected = List.of(
            landing(false, true, true, true, true, true, true, true, false, false, true),
            landing(true, false, true, true, true, true, true, true, false, false, true),
            landing(true, true, false, true, true, true, true, true, false, false, true),
            landing(true, true, true, false, true, true, true, true, false, false, true),
            landing(true, true, true, true, false, true, true, true, false, false, true),
            landing(true, true, true, true, true, false, true, true, false, false, true),
            landing(true, true, true, true, true, true, false, true, false, false, true),
            landing(true, true, true, true, true, true, true, false, false, false, true),
            landing(true, true, true, true, true, true, true, true, true, false, true),
            landing(true, true, true, true, true, true, true, true, false, true, true),
            landing(true, true, true, true, true, true, true, true, false, false, false)
        );
        List<String> reasons = List.of(
            "drop_column_blocked",
            "drop_column_liquid",
            "drop_column_hazard",
            "landing_support_unstable",
            "landing_body_blocked",
            "landing_body_blocked",
            "landing_liquid",
            "landing_hazard",
            "landing_adjacent_lava",
            "landing_boxed",
            "landing_outside_depth_band"
        );
        for (int i = 0; i < rejected.size(); i++) {
            DescentSafeFallLaunchPlanner.Decision result = DescentSafeFallLaunchPlanner.plan(
                withLanding(base, rejected.get(i))
            );
            assertFalse(result.accepted(), reasons.get(i));
            assertEquals(reasons.get(i), result.reason());
        }
    }

    @Test
    void healthAwareFallFreezesExpectedDamageAndRejectsUnsafelyDeepFall() {
        DescentSafeFallLaunchPlanner.Request shallow = request(clear(LAUNCH_FEET), clear(LAUNCH_HEAD));
        DescentSafeFallLaunchPlanner.Landing deepLanding = new DescentSafeFallLaunchPlanner.Landing(
            new VoxelCell(1, 7, 0), true, true, true, true, true, true, true, true, false, false, true);
        DescentSafeFallLaunchPlanner.Request deep = new DescentSafeFallLaunchPlanner.Request(
            shallow.origin(), shallow.launchFeet(), shallow.launchHead(), shallow.dropColumn(),
            deepLanding, 13, 3, 13, 20.0F, 10.0F);
        DescentSafeFallLaunchPlanner.Decision accepted = DescentSafeFallLaunchPlanner.plan(deep);
        assertTrue(accepted.accepted());
        assertEquals(10, accepted.plan().expectedDamage());

        DescentSafeFallLaunchPlanner.Request unsafe = new DescentSafeFallLaunchPlanner.Request(
            deep.origin(), deep.launchFeet(), deep.launchHead(), deep.dropColumn(), deep.landing(),
            13, 3, 13, 19.0F, 10.0F);
        DescentSafeFallLaunchPlanner.Decision rejected = DescentSafeFallLaunchPlanner.plan(unsafe);
        assertFalse(rejected.accepted());
        assertEquals("fall_not_survivable", rejected.reason());
    }

    @Test
    void revalidationCannotChangeGeometryAndRejectsNewlyExposedWater() {
        DescentSafeFallLaunchPlanner.Request original = request(leaves(LAUNCH_FEET), leaves(LAUNCH_HEAD));
        DescentSafeFallLaunchPlanner.Plan frozen =
            DescentSafeFallLaunchPlanner.plan(original).plan();
        assertNotNull(frozen);

        DescentSafeFallLaunchPlanner.Request oneCleared = request(leaves(LAUNCH_FEET), clear(LAUNCH_HEAD));
        DescentSafeFallLaunchPlanner.Decision refreshed =
            DescentSafeFallLaunchPlanner.revalidate(frozen, oneCleared);
        assertTrue(refreshed.accepted());
        assertEquals(List.of(LAUNCH_FEET), refreshed.plan().clearanceCells());

        DescentSafeFallLaunchPlanner.LaunchCell flooded =
            launch(LAUNCH_HEAD, true, true, false, false, false);
        DescentSafeFallLaunchPlanner.Decision water = DescentSafeFallLaunchPlanner.revalidate(
            frozen, request(leaves(LAUNCH_FEET), flooded));
        assertFalse(water.accepted());
        assertEquals("launch_head_liquid", water.reason());

        DescentSafeFallLaunchPlanner.Request moved = request(
            clear(new VoxelCell(-1, 20, 0)),
            clear(new VoxelCell(-1, 21, 0)),
            new VoxelCell(-1, 19, 0),
            new VoxelCell(-1, 18, 0)
        );
        DescentSafeFallLaunchPlanner.Decision changed =
            DescentSafeFallLaunchPlanner.revalidate(frozen, moved);
        assertFalse(changed.accepted());
        assertEquals("geometry_changed", changed.reason());
    }

    private static void assertRejected(DescentSafeFallLaunchPlanner.LaunchCell head, String reason) {
        DescentSafeFallLaunchPlanner.Decision result =
            DescentSafeFallLaunchPlanner.plan(request(clear(LAUNCH_FEET), head));
        assertFalse(result.accepted());
        assertEquals(reason, result.reason());
    }

    private static DescentSafeFallLaunchPlanner.Request request(
        DescentSafeFallLaunchPlanner.LaunchCell feet,
        DescentSafeFallLaunchPlanner.LaunchCell head
    ) {
        return request(feet, head, COLUMN, LANDING);
    }

    private static DescentSafeFallLaunchPlanner.Request request(
        DescentSafeFallLaunchPlanner.LaunchCell feet,
        DescentSafeFallLaunchPlanner.LaunchCell head,
        VoxelCell column,
        VoxelCell landingFeet
    ) {
        int fall = ORIGIN.y() - landingFeet.y();
        return new DescentSafeFallLaunchPlanner.Request(
            new DescentSafeFallLaunchPlanner.Origin(ORIGIN, true, true, true, true, true, false),
            feet,
            head,
            column,
            new DescentSafeFallLaunchPlanner.Landing(
                landingFeet, true, true, true, true, true, true, true, true, false, false, true),
            fall,
            3,
            13,
            20.0F,
            10.0F
        );
    }

    private static DescentSafeFallLaunchPlanner.Request withLanding(
        DescentSafeFallLaunchPlanner.Request base,
        DescentSafeFallLaunchPlanner.Landing landing
    ) {
        return new DescentSafeFallLaunchPlanner.Request(
            base.origin(), base.launchFeet(), base.launchHead(), base.dropColumn(), landing,
            base.fallDepth(), base.maxSafeFall(), base.maxHealthFall(), base.currentHealth(), base.healthMargin());
    }

    private static DescentSafeFallLaunchPlanner.Landing landing(
        boolean columnClear,
        boolean columnDry,
        boolean columnHazardFree,
        boolean floorStable,
        boolean feetClear,
        boolean headClear,
        boolean dry,
        boolean hazardFree,
        boolean adjacentLava,
        boolean boxed,
        boolean depthAllowed
    ) {
        return new DescentSafeFallLaunchPlanner.Landing(
            LANDING, columnClear, columnDry, columnHazardFree, floorStable, feetClear, headClear,
            dry, hazardFree, adjacentLava, boxed, depthAllowed);
    }

    private static DescentSafeFallLaunchPlanner.LaunchCell clear(VoxelCell cell) {
        return launch(cell, true, false, false, false, false);
    }

    private static DescentSafeFallLaunchPlanner.LaunchCell leaves(VoxelCell cell) {
        return launch(cell, false, false, false, false, false, true);
    }

    private static DescentSafeFallLaunchPlanner.LaunchCell launch(
        VoxelCell cell,
        boolean collisionFree,
        boolean liquid,
        boolean hazard,
        boolean adjacentLava,
        boolean gravity
    ) {
        return launch(cell, collisionFree, liquid, hazard, adjacentLava, gravity, false);
    }

    private static DescentSafeFallLaunchPlanner.LaunchCell launch(
        VoxelCell cell,
        boolean collisionFree,
        boolean liquid,
        boolean hazard,
        boolean adjacentLava,
        boolean gravity,
        boolean leaf
    ) {
        return new DescentSafeFallLaunchPlanner.LaunchCell(
            cell, collisionFree, leaf, liquid, hazard, adjacentLava, gravity);
    }
}
