package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class DescentHazardMemoryTest {
    @Test
    void parsesAdjacentWaterAndLavaReasons() {
        DescentHazardMemory.HazardMarker water = DescentHazardMemory.parseRejectedStepHazard(
            "descent_water_adjacent:-1, 24, 11"
        );
        DescentHazardMemory.HazardMarker lava = DescentHazardMemory.parseRejectedStepHazard(
            "descent_lava_adjacent:8, -54, -12:bridge_failed:failed"
        );

        assertEquals(new BlockPos(-1, 24, 11), water.pos());
        assertEquals("water", water.kind());
        assertEquals(new BlockPos(8, -54, -12), lava.pos());
        assertEquals("lava", lava.kind());
    }

    @Test
    void parsesHazardInStepReasonsAndIgnoresSupportGaps() {
        DescentHazardMemory.HazardMarker hazard = DescentHazardMemory.parseRejectedStepHazard(
            "descent_hazard_in_step:magma:4, 63, 7"
        );

        assertEquals(new BlockPos(4, 63, 7), hazard.pos());
        assertEquals("magma", hazard.kind());
        assertNull(DescentHazardMemory.parseRejectedStepHazard("descent_next_support_missing:4, 62, 7"));
        assertNull(DescentHazardMemory.parseRejectedStepHazard(null));
    }

    @Test
    void rejectsRerouteBesideRememberedWaterPocketFromSavedFailure() {
        BlockPos currentFeet = new BlockPos(-1, 25, 9);
        StaircaseDescentPlanner.Step east = StaircaseDescentPlanner.stepFrom(
            currentFeet,
            StaircaseDescentPlanner.east(),
            1
        );
        DescentHazardMemory.HazardMarker water = new DescentHazardMemory.HazardMarker(
            new BlockPos(-1, 24, 11),
            "water"
        );

        assertTrue(DescentHazardMemory.candidateTooCloseToKnownHazard(east, Set.of(water)));
    }

    @Test
    void allowsRerouteAwayFromRememberedWaterPocket() {
        BlockPos currentFeet = new BlockPos(-1, 25, 9);
        StaircaseDescentPlanner.Step north = StaircaseDescentPlanner.stepFrom(
            currentFeet,
            StaircaseDescentPlanner.north(),
            1
        );
        DescentHazardMemory.HazardMarker water = new DescentHazardMemory.HazardMarker(
            new BlockPos(-1, 24, 11),
            "water"
        );

        assertFalse(DescentHazardMemory.candidateTooCloseToKnownHazard(north, Set.of(water)));
    }

    @Test
    void allowsCandidatesWhenHazardIsFarAway() {
        StaircaseDescentPlanner.Step east = StaircaseDescentPlanner.stepFrom(
            new BlockPos(0, 70, 0),
            StaircaseDescentPlanner.east(),
            1
        );
        DescentHazardMemory.HazardMarker water = new DescentHazardMemory.HazardMarker(
            new BlockPos(8, 69, 8),
            "water"
        );

        assertFalse(DescentHazardMemory.candidateTooCloseToKnownHazard(east, Set.of(water)));
        assertFalse(DescentHazardMemory.candidateTooCloseToKnownHazard(east, Set.of()));
    }
}
