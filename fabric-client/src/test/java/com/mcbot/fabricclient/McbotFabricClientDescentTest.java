package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

class McbotFabricClientDescentTest {
    @Test
    void resyncsSmallOvershotNearPlannedStep() {
        assertTrue(McbotFabricClient.shouldResyncDescentOvershot(
            new BlockPos(0, 64, 0),
            new BlockPos(0, 62, 1),
            new BlockPos(0, 63, 1),
            0,
            6
        ));
    }

    @Test
    void refusesOvershotWithoutDropOrWithLargeFall() {
        assertFalse(McbotFabricClient.shouldResyncDescentOvershot(
            new BlockPos(0, 64, 0),
            new BlockPos(0, 64, 1),
            new BlockPos(0, 63, 1),
            0,
            6
        ));
        assertFalse(McbotFabricClient.shouldResyncDescentOvershot(
            new BlockPos(0, 64, 0),
            new BlockPos(0, 60, 1),
            new BlockPos(0, 63, 1),
            0,
            6
        ));
    }

    @Test
    void refusesOvershotBeyondRemainingDepthOrTooFarFromStep() {
        assertFalse(McbotFabricClient.shouldResyncDescentOvershot(
            new BlockPos(0, 64, 0),
            new BlockPos(0, 62, 1),
            new BlockPos(0, 63, 1),
            5,
            6
        ));
        assertFalse(McbotFabricClient.shouldResyncDescentOvershot(
            new BlockPos(0, 64, 0),
            new BlockPos(4, 62, 1),
            new BlockPos(0, 63, 1),
            0,
            6
        ));
    }

    @Test
    void recoversLowerBreakWhenUpperClearanceOccludesRaycast() {
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(
            new BlockPos(-11, 91, 2),
            StaircaseDescentPlanner.east(),
            1
        );

        String phase = McbotFabricClient.descentRecoveryPhaseForOccludingClearance(
            step,
            "lower",
            step.upperClear(),
            "raycast_occluded_reposition"
        );

        assertEquals("upper", phase);
    }

    @Test
    void recoversUpperOrLowerBreakWhenSightClearanceOccludesRaycast() {
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(
            new BlockPos(0, 64, 0),
            StaircaseDescentPlanner.south(),
            1
        );

        assertEquals("sight", McbotFabricClient.descentRecoveryPhaseForOccludingClearance(
            step,
            "upper",
            step.sightClear(),
            "raycast_occluded_reposition"
        ));
        assertEquals("sight", McbotFabricClient.descentRecoveryPhaseForOccludingClearance(
            step,
            "lower",
            step.sightClear(),
            "raycast_occluded_reposition"
        ));
    }

    @Test
    void ignoresUnrelatedDescentBreakRepositionOccluders() {
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(
            new BlockPos(0, 64, 0),
            StaircaseDescentPlanner.south(),
            1
        );

        assertNull(McbotFabricClient.descentRecoveryPhaseForOccludingClearance(
            step,
            "lower",
            new BlockPos(4, 63, 4),
            "raycast_occluded_reposition"
        ));
        assertNull(McbotFabricClient.descentRecoveryPhaseForOccludingClearance(
            step,
            "lower",
            step.upperClear(),
            "break_timeout"
        ));
    }

    @Test
    void reroutesUnrelatedDescentBreakRepositionOccluders() {
        assertTrue(McbotFabricClient.shouldRerouteDescentBreakReposition(
            "raycast_occluded_reposition",
            null
        ));
        assertTrue(McbotFabricClient.shouldRerouteDescentBreakReposition(
            "raycast_occluded_reposition",
            ""
        ));
        assertFalse(McbotFabricClient.shouldRerouteDescentBreakReposition(
            "raycast_occluded_reposition",
            "sight"
        ));
        assertFalse(McbotFabricClient.shouldRerouteDescentBreakReposition(
            "break_timeout",
            null
        ));
    }

    @Test
    void directReturnReusesCompletedDescentPathForSameCommand() {
        List<BlockPos> descentPath = List.of(
            new BlockPos(0, 64, 0),
            new BlockPos(0, 63, 1),
            new BlockPos(0, 62, 2)
        );

        assertEquals(descentPath, McbotFabricClient.directReturnPathForCommand(
            Map.of("r2-stone-1", descentPath),
            "r2-stone-1"
        ));
        assertTrue(McbotFabricClient.directReturnPathForCommand(
            Map.of("r2-stone-1", descentPath),
            "r2-stone-2"
        ).isEmpty());
        assertTrue(McbotFabricClient.directReturnPathForCommand(Map.of("r2-stone-1", descentPath), "").isEmpty());
    }

    @Test
    void retraceTrailSlicesOwnTrajectoryTargetEndFirst() {
        List<BlockPos> trajectory = List.of(
            new BlockPos(0, 64, 0),    // near target (surface)
            new BlockPos(10, 60, 0),
            new BlockPos(20, 40, 0),
            new BlockPos(30, 10, 0)    // near bot (deep excursion end)
        );
        BlockPos bot = new BlockPos(31, 10, 1);
        BlockPos target = new BlockPos(1, 64, 1);

        List<BlockPos> retrace = McbotFabricClient.retraceTrailBetween(trajectory, bot, target, 16.0D, 36.0D, 1024);
        assertEquals(4, retrace.size());
        assertEquals(new BlockPos(0, 64, 0), retrace.get(0), "target end must come first (descent-trail orientation)");
        assertEquals(new BlockPos(30, 10, 0), retrace.get(3), "bot end must come last");
    }

    @Test
    void retraceTrailPrefersTheLatestNearTargetCellAndBoundsItself() {
        List<BlockPos> loop = List.of(
            new BlockPos(0, 64, 0),    // near target, EARLY visit
            new BlockPos(50, 64, 0),
            new BlockPos(1, 64, 0),    // near target again, LATER visit -> shortest retrace starts here
            new BlockPos(25, 40, 0),
            new BlockPos(40, 12, 0)    // near bot
        );
        BlockPos bot = new BlockPos(40, 12, 1);
        BlockPos target = new BlockPos(0, 64, 1);

        List<BlockPos> retrace = McbotFabricClient.retraceTrailBetween(loop, bot, target, 16.0D, 36.0D, 1024);
        assertEquals(3, retrace.size(), "must start at the LATEST near-target visit, not the earliest");
        assertEquals(new BlockPos(1, 64, 0), retrace.get(0));

        assertTrue(McbotFabricClient.retraceTrailBetween(loop, new BlockPos(500, 0, 0), target, 16.0D, 36.0D, 1024).isEmpty(),
            "bot not on the trail yields empty");
        assertTrue(McbotFabricClient.retraceTrailBetween(loop, bot, new BlockPos(500, 0, 0), 16.0D, 36.0D, 1024).isEmpty(),
            "target not on the trail yields empty");
        assertTrue(McbotFabricClient.retraceTrailBetween(loop, bot, target, 16.0D, 36.0D, 2).isEmpty(),
            "over-cap slices are rejected, never truncated into half-journeys");
    }

    @Test
    void returnPathCoverageIsNearestCellDistance() {
        List<BlockPos> path = List.of(new BlockPos(0, 64, 0), new BlockPos(5, 60, 5));
        assertTrue(McbotFabricClient.returnPathCoversStart(path, new BlockPos(6, 60, 6), 16.0D));
        assertFalse(McbotFabricClient.returnPathCoversStart(path, new BlockPos(20, 60, 20), 16.0D));
        assertFalse(McbotFabricClient.returnPathCoversStart(List.of(), new BlockPos(0, 64, 0), 16.0D));
    }

    @Test
    void descentTrailMembershipCoversFeetAndHeadCellsAcrossStores() {
        List<BlockPos> lastPath = List.of(new BlockPos(0, 64, 0), new BlockPos(0, 63, 1));
        List<BlockPos> recorded = List.of(new BlockPos(5, 30, 5));

        assertTrue(McbotFabricClient.descentTrailContainsCell(List.of(recorded), lastPath, new BlockPos(0, 63, 1)));
        assertTrue(McbotFabricClient.descentTrailContainsCell(List.of(recorded), lastPath, new BlockPos(0, 64, 1)),
            "head cell above a trail feet cell must count as on-trail");
        assertTrue(McbotFabricClient.descentTrailContainsCell(List.of(recorded), lastPath, new BlockPos(5, 31, 5)),
            "recorded-store paths must be honored, not only the last path");
        assertFalse(McbotFabricClient.descentTrailContainsCell(List.of(recorded), lastPath, new BlockPos(0, 62, 1)),
            "the cell below a trail feet cell is the tread, not the corridor");
        assertFalse(McbotFabricClient.descentTrailContainsCell(List.of(recorded), lastPath, new BlockPos(1, 63, 1)));
        assertFalse(McbotFabricClient.descentTrailContainsCell(List.of(), List.of(), new BlockPos(0, 0, 0)));
        assertFalse(McbotFabricClient.descentTrailContainsCell(null, null, new BlockPos(0, 0, 0)));
        assertFalse(McbotFabricClient.descentTrailContainsCell(List.of(recorded), lastPath, null));
    }

    @Test
    void descentDirectionYawMatchesMinecraftForwardHeading() {
        assertEquals(0.0D, McbotFabricClient.yawForDescentDirection(StaircaseDescentPlanner.south()));
        assertEquals(180.0D, McbotFabricClient.yawForDescentDirection(StaircaseDescentPlanner.north()));
        assertEquals(-90.0D, McbotFabricClient.yawForDescentDirection(StaircaseDescentPlanner.east()));
        assertEquals(90.0D, McbotFabricClient.yawForDescentDirection(StaircaseDescentPlanner.west()));
    }

    @Test
    void descentSupportAcceptsCobblestoneAndDirtFillers() {
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("cobblestone"));
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("dirt"));
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("coarse_dirt"));
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("rooted_dirt"));

        assertFalse(McbotFabricClient.isDescentSupportFillerItem("oak_leaves"));
        assertFalse(McbotFabricClient.isDescentSupportFillerItem("sand"));
    }

    @Test
    void descentSupportAcceptsWoodPlanksAsEarlyGameFillers() {
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("oak_planks"));
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("jungle_planks"));
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("bamboo_planks"));
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("crimson_planks"));
        assertTrue(McbotFabricClient.isDescentSupportFillerItem("warped_planks"));

        assertFalse(McbotFabricClient.isDescentSupportFillerItem("fake_planks"));
    }

    @Test
    void sealedWaterBelowSolidDescentSupportDoesNotPoisonStep() {
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(
            new BlockPos(0, 54, 21),
            StaircaseDescentPlanner.south(),
            10
        );

        assertFalse(McbotFabricClient.shouldCheckDescentAdjacentWater(step, step.support(), Direction.DOWN));
        assertTrue(McbotFabricClient.shouldCheckDescentAdjacentWater(step, step.support(), Direction.NORTH));
        assertTrue(McbotFabricClient.shouldCheckDescentAdjacentWater(step, step.lowerClear(), Direction.DOWN));
        assertTrue(McbotFabricClient.shouldCheckDescentAdjacentWater(step, step.upperClear(), Direction.SOUTH));
    }

    @Test
    void supportLevelWaterUnderExistingFloorDoesNotPoisonDescentStep() {
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(
            new BlockPos(38, 50, 176),
            StaircaseDescentPlanner.south(),
            1
        );
        BlockPos sealedWater = step.support().north();

        assertTrue(McbotFabricClient.isSealedDescentAdjacentSupportWater(
            step,
            step.support(),
            Direction.NORTH,
            sealedWater,
            true
        ));
        assertFalse(McbotFabricClient.isSealedDescentAdjacentSupportWater(
            step,
            step.support(),
            Direction.NORTH,
            sealedWater,
            false
        ));
        assertFalse(McbotFabricClient.isSealedDescentAdjacentSupportWater(
            step,
            step.lowerClear(),
            Direction.NORTH,
            step.lowerClear().north(),
            true
        ));
    }
}
