package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class DescentWaterContainmentGazeTest {
    @Test
    void retreatAlignmentUsesImmediateCriticalGazeAtTheFrozenDryAnchor() {
        BlockPos anchor = new BlockPos(12, 34, -56);
        LookDemand align = DescentExecutor.criticalWaterRetreatDemand(
            "command-7",
            anchor,
            new McbotFabricClient.LookAngles(-179.0D, 42.5D),
            "descent_water_retreat_align"
        );
        LookDemand move = DescentExecutor.criticalWaterRetreatDemand(
            "command-7",
            anchor,
            new McbotFabricClient.LookAngles(178.0D, 38.0D),
            "descent_water_retreat"
        );

        assertEquals(LookDemand.Owner.SURVIVAL, align.owner());
        assertEquals(LookDemand.Profile.CRITICAL, align.profile());
        assertEquals(LookDemand.RetargetPolicy.IMMEDIATE, align.retargetPolicy());
        assertEquals(-179.0D, align.desiredYaw());
        assertEquals(42.5D, align.desiredPitch());
        assertEquals(align.targetIdentity(), move.targetIdentity());
        assertEquals(
            "survival:command-7:descent_water_retreat:12:34:-56",
            align.targetIdentity()
        );
    }
}
