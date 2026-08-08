package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class MissionStoneBreakAdmissionTest {

    @Test
    void targetlessWaitPreservesNullableIntentCoordinatesWithoutUnboxing() {
        assertNull(McbotFabricClient.missionStoneLookCoordinate(null, false, 0.0D));
        assertEquals(
            Double.valueOf(12.5D),
            McbotFabricClient.missionStoneLookCoordinate(null, true, 12.5D)
        );
        assertEquals(
            Double.valueOf(-4.0D),
            McbotFabricClient.missionStoneLookCoordinate(-4.0D, false, 99.0D)
        );
    }

    @Test
    void newTargetStillRequiresLiveRaycastAdmission() {
        BlockPos target = new BlockPos(10, 63, 11);

        assertTrue(McbotFabricClient.missionStoneBreakRequiresInitialRaycast(null, target));
        assertTrue(McbotFabricClient.missionStoneBreakRequiresInitialRaycast(
            new BlockPos(9, 63, 11),
            target
        ));
        assertTrue(McbotFabricClient.missionStoneBreakRequiresInitialRaycast(target, null));
    }

    @Test
    void engagedTargetBypassesRaycastSoAirConfirmationCanFinish() {
        BlockPos target = new BlockPos(10, 63, 11);

        assertFalse(McbotFabricClient.missionStoneBreakRequiresInitialRaycast(target, target));
    }
}
