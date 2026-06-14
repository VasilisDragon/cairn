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
