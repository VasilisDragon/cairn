package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.List;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.Blocks;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class FabricInteractionAuthorityModelTest {
    @BeforeAll
    static void bootstrapMinecraftRegistries() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void entityGateNormalizesAnglesAndRejectsUnsafeBounds() {
        FabricInteractionAuthority.EntityGate gate =
            new FabricInteractionAuthority.EntityGate(
                3.0D,
                370.0D,
                120.0D,
                12.0D,
                1_500L,
                true
            );

        assertEquals(10.0D, gate.desiredYaw());
        assertEquals(90.0D, gate.desiredPitch());
        assertEquals(1_500L, gate.notBeforeMs());
        assertEquals(
            FabricInteractionAuthority.EntityReachMetric.ENTITY_ORIGIN,
            gate.reachMetric());
        assertThrows(IllegalArgumentException.class, () ->
            new FabricInteractionAuthority.EntityGate(
                0.0D,
                0.0D,
                0.0D,
                12.0D,
                0L,
                true
            ));
        assertThrows(IllegalArgumentException.class, () ->
            new FabricInteractionAuthority.EntityGate(
                3.0D,
                0.0D,
                0.0D,
                -1.0D,
                0L,
                true
            ));
    }

    @Test
    void golemGateCanUseClosestHitboxPointWithoutChangingLegacyDefault() {
        FabricInteractionAuthority.EntityGate golemGate =
            new FabricInteractionAuthority.EntityGate(
                3.0D,
                0.0D,
                0.0D,
                7.0D,
                0L,
                true,
                FabricInteractionAuthority.EntityReachMetric.EYE_TO_HITBOX
            );
        Vec3d closest = FabricInteractionAuthority.closestPoint(
            new Vec3d(0.0D, 2.0D, 0.0D),
            new Box(2.0D, 0.0D, -1.0D, 4.0D, 3.0D, 1.0D));

        assertEquals(FabricInteractionAuthority.EntityReachMetric.EYE_TO_HITBOX,
            golemGate.reachMetric());
        assertEquals(new Vec3d(2.0D, 2.0D, 0.0D), closest);
    }

    @Test
    void blockPayloadsFreezeCapabilitiesAndEveryAffectedPosition() {
        FabricInteractionAuthority.Payload payload =
            FabricInteractionAuthority.Payload.blockBreak(new BlockPos(1, 2, 3), Direction.UP);

        assertEquals(new BlockPos(1, 2, 3), payload.blockPos());
        assertEquals(Direction.UP, payload.face());
        assertEquals(List.of(new BlockPos(1, 2, 3)), payload.affectedBlockPositions());
        assertEquals(
            FabricWorldActionAuthorization.Capability.UNSPECIFIED,
            payload.blockAuthorization().capability()
        );

        FabricInteractionAuthority.Payload placement =
            FabricInteractionAuthority.Payload.blockPlacement(
                new BlockHitResult(
                    Vec3d.ofCenter(new BlockPos(4, 5, 6)),
                    Direction.EAST,
                    new BlockPos(4, 5, 6),
                    false
                ),
                Hand.MAIN_HAND,
                FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
                Blocks.COBBLESTONE,
                List.of(new BlockPos(5, 5, 6))
            );
        assertEquals(
            List.of(new BlockPos(4, 5, 6), new BlockPos(5, 5, 6)),
            placement.affectedBlockPositions()
        );
        assertEquals(
            FabricWorldActionAuthorization.Capability.NATURAL_ANCHOR,
            placement.blockAuthorization().capability()
        );
    }

    @Test
    void initialMetricsExposeEveryHarnessFieldAtZero() {
        FabricInteractionAuthority authority = new FabricInteractionAuthority(
            "test",
            null,
            FabricMotionMode.SMOOTH,
            FabricTargetProtection.fromConfiguredRegions("")
        );
        FabricInteractionAuthority.Metrics metrics = authority.metrics();

        assertEquals(0, metrics.logicalMiningGestures());
        assertEquals(0, metrics.blockTargetTransitions());
        assertEquals(0, metrics.breakUpdateCalls());
        assertEquals(0, metrics.duplicateBreakUpdates());
        assertEquals(0, metrics.blockAttackKeyPresses());
        assertEquals(0, metrics.preAimTransitions());
        assertEquals(0, metrics.avoidableNeutralGaps());
        assertEquals(0, metrics.ghostBlockRestorations());
        assertEquals(0, metrics.usePulses());
        assertEquals(0, metrics.useVerifications());
        assertEquals(0, metrics.entityAttackPulses());
        assertEquals(0, metrics.attackCooldownViolations());
        assertEquals(0, metrics.lifecycleKeyLeaks());
        assertEquals(0, metrics.shadowMismatches());
        assertEquals(0, metrics.directWriterViolations());
        assertEquals(0, metrics.cursorRegressions());
        assertEquals(0L, metrics.maximumNeutralGapMs());
        assertEquals(0L, metrics.minimumAttackIntervalMs());
        assertEquals(0.0D, metrics.computationP95Ms());
        assertEquals("uncommanded", authority.commandMetrics().commandId());
        assertEquals(0, authority.commandMetrics().duplicateBreakUpdates());
        assertEquals(0, authority.commandMetrics().avoidableNeutralGaps());
        assertEquals(0L, authority.commandMetrics().maximumNeutralGapMs());
        assertFalse(authority.mode() == FabricMotionMode.LEGACY);
    }

    @Test
    void commandMetricsResetWithoutChangingPriorLifecycleEvidence() {
        FabricInteractionAuthority.CommandMetrics first =
            FabricInteractionAuthority.CommandMetrics.empty()
                .forCommand("gather:1")
                .observe(true, 420L)
                .observe(false, 175L);

        assertEquals("gather:1", first.commandId());
        assertEquals(1, first.duplicateBreakUpdates());
        assertEquals(1, first.avoidableNeutralGaps());
        assertEquals(420L, first.maximumNeutralGapMs());

        FabricInteractionAuthority.CommandMetrics stone = first.forCommand("stone:1");
        assertEquals("stone:1", stone.commandId());
        assertEquals(0, stone.duplicateBreakUpdates());
        assertEquals(0, stone.avoidableNeutralGaps());
        assertEquals(0L, stone.maximumNeutralGapMs());

        FabricInteractionAuthority.CommandMetrics continued = stone
            .observe(false, -1L)
            .observe(false, 120L);
        assertEquals(0, continued.duplicateBreakUpdates());
        assertEquals(0, continued.avoidableNeutralGaps());
        assertEquals(120L, continued.maximumNeutralGapMs());
        assertEquals(continued, continued.forCommand("stone:1"));
    }

    @Test
    void progressiveStoneTargetsShareOneTaskMetricScope() {
        assertEquals(
            "brain-7:mission-stone",
            FabricInteractionAuthority.metricsCommandScope(
                "brain-7:mission-stone:stair:2:upper_clear"
            )
        );
        assertEquals(
            "brain-7:mission-stone",
            FabricInteractionAuthority.metricsCommandScope(
                "brain-7:mission-stone:face:5"
            )
        );
        assertEquals(
            "gather:target-2",
            FabricInteractionAuthority.metricsCommandScope("gather:target-2")
        );
    }
}
