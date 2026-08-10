package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FabricGazeAuthorityTest {
    private static final double EPSILON = 1.0E-6D;

    @Test
    void legacyNormalMatchesExistingEasingAndDeadband() {
        LookDemand demand = demand(LookDemand.Owner.NORMAL, LookDemand.Profile.TRAVEL, "travel", 90.0D, 30.0D);
        FabricGazeAuthority.LegacyOutput output = FabricGazeAuthority.legacyStep(
            FabricGazeAuthority.LegacyState.initial(),
            0.0D,
            0.0D,
            demand,
            1_000L
        );
        LookController.Look expected = LookController.nextLook(0.0D, 0.0D, 90.0D, 30.0D, 9.0D);
        assertEquals(expected.yaw(), output.yaw(), EPSILON);
        assertEquals(expected.pitch(), output.pitch(), EPSILON);
        assertTrue(output.write());

        FabricGazeAuthority.LegacyOutput settled = FabricGazeAuthority.legacyStep(
            output.state(),
            89.7D,
            29.8D,
            demand,
            1_050L
        );
        assertFalse(settled.write());
        assertEquals(89.7D, settled.yaw(), EPSILON);
    }

    @Test
    void legacyNormalPreservesScopedTargetSwapDamping() {
        LookDemand a = demand(LookDemand.Owner.NORMAL, LookDemand.Profile.PRECISION, "aim_block", 0.0D, 30.0D);
        LookDemand b = new LookDemand(
            LookDemand.Owner.NORMAL,
            "block:b",
            LookDemand.Profile.PRECISION,
            90.0D,
            -20.0D,
            LookDemand.RetargetPolicy.COMMITTED,
            "command",
            "aim_block"
        );
        FabricGazeAuthority.LegacyOutput first = FabricGazeAuthority.legacyStep(
            FabricGazeAuthority.LegacyState.initial(),
            -20.0D,
            0.0D,
            a,
            1_000L
        );
        FabricGazeAuthority.LegacyOutput suppressed = FabricGazeAuthority.legacyStep(
            first.state(),
            first.yaw(),
            first.pitch(),
            b,
            1_100L
        );
        assertTrue(suppressed.targetSuppressed());
        assertEquals(0.0D, suppressed.acceptedYaw(), EPSILON);

        FabricGazeAuthority.LegacyOutput accepted = FabricGazeAuthority.legacyStep(
            suppressed.state(),
            suppressed.yaw(),
            suppressed.pitch(),
            b,
            1_500L
        );
        assertFalse(accepted.targetSuppressed());
        assertEquals(90.0D, accepted.acceptedYaw(), EPSILON);
    }

    @Test
    void legacyCombatHuntAndCriticalProfilesMatchTheirOldPolicies() {
        LookDemand combat = demand(LookDemand.Owner.COMBAT, LookDemand.Profile.TRACKING, "combat_engage", 120.0D, 20.0D);
        FabricGazeAuthority.LegacyOutput combatOutput = FabricGazeAuthority.legacyStep(
            FabricGazeAuthority.LegacyState.initial(),
            0.0D,
            0.0D,
            combat,
            1_000L
        );
        LookController.Look expectedCombat = LookController.nextLook(0.0D, 0.0D, 120.0D, 20.0D, 12.0D);
        assertEquals(expectedCombat.yaw(), combatOutput.yaw(), EPSILON);
        assertEquals(expectedCombat.pitch(), combatOutput.pitch(), EPSILON);

        LookDemand hunt = demand(LookDemand.Owner.HUNT, LookDemand.Profile.TRACKING, "hunt_engage", -100.0D, 15.0D);
        FabricGazeAuthority.LegacyOutput huntOutput = FabricGazeAuthority.legacyStep(
            FabricGazeAuthority.LegacyState.initial(),
            0.0D,
            0.0D,
            hunt,
            1_000L
        );
        LookController.Look expectedHunt = LookController.nextLook(0.0D, 0.0D, -100.0D, 15.0D, 9.0D);
        assertEquals(expectedHunt.yaw(), huntOutput.yaw(), EPSILON);
        assertEquals(expectedHunt.pitch(), huntOutput.pitch(), EPSILON);

        LookDemand critical = new LookDemand(
            LookDemand.Owner.SURVIVAL,
            "survival:swim_up",
            LookDemand.Profile.CRITICAL,
            30.0D,
            -75.0D,
            LookDemand.RetargetPolicy.IMMEDIATE,
            "survival",
            "swim_up"
        );
        FabricGazeAuthority.LegacyOutput criticalOutput = FabricGazeAuthority.legacyStep(
            FabricGazeAuthority.LegacyState.initial(),
            -40.0D,
            20.0D,
            critical,
            1_000L
        );
        assertEquals(30.0D, criticalOutput.yaw(), EPSILON);
        assertEquals(-75.0D, criticalOutput.pitch(), EPSILON);
    }

    @Test
    void modeSelectionAppliesLegacyInLegacyAndShadowAndSmoothInSmooth() {
        FabricGazeAuthority.LegacyOutput legacy = new FabricGazeAuthority.LegacyOutput(
            FabricGazeAuthority.LegacyState.initial(),
            12.0D,
            34.0D,
            12.0D,
            34.0D,
            true,
            false
        );
        FabricGazeController.Output smooth = new FabricGazeController.Output(
            56.0D,
            7.0D,
            true,
            true,
            false,
            false,
            false,
            false,
            false,
            80.0D,
            400.0D,
            20.0D,
            0,
            0,
            LookDemand.Profile.TRAVEL,
            false,
            0.0D,
            false
        );

        FabricGazeAuthority.Applied legacyApplied = FabricGazeAuthority.selectApplied(
            FabricMotionMode.LEGACY,
            legacy,
            smooth
        );
        FabricGazeAuthority.Applied shadowApplied = FabricGazeAuthority.selectApplied(
            FabricMotionMode.SHADOW,
            legacy,
            smooth
        );
        FabricGazeAuthority.Applied smoothApplied = FabricGazeAuthority.selectApplied(
            FabricMotionMode.SMOOTH,
            legacy,
            smooth
        );

        assertEquals(12.0D, legacyApplied.yaw(), EPSILON);
        assertEquals(34.0D, legacyApplied.pitch(), EPSILON);
        assertEquals(12.0D, shadowApplied.yaw(), EPSILON);
        assertEquals(34.0D, shadowApplied.pitch(), EPSILON);
        assertEquals(56.0D, smoothApplied.yaw(), EPSILON);
        assertEquals(7.0D, smoothApplied.pitch(), EPSILON);
    }

    @Test
    void profileTransitionAttributesSpeedToTheEnvelopeAndAccelerationToTheDemand() {
        LookDemand precision = demand(
            LookDemand.Owner.NORMAL,
            LookDemand.Profile.PRECISION,
            "aim_block",
            170.0D,
            0.0D
        );
        FabricGazeController.Output transition = new FabricGazeController.Output(
            13.2D,
            0.0D,
            true,
            true,
            false,
            false,
            false,
            false,
            false,
            264.0D,
            720.0D,
            156.8D,
            0,
            0,
            LookDemand.Profile.TRACKING,
            true,
            84.0D,
            false
        );

        assertEquals(
            LookDemand.Profile.TRACKING,
            FabricGazeAuthority.speedAccountingProfile(precision, transition)
        );
        assertEquals(
            LookDemand.Profile.PRECISION,
            FabricGazeAuthority.accelerationAccountingProfile(precision)
        );
    }

    @Test
    void legacyAdapterReplaysASequentialTravelTraceWithoutResettingState() {
        FabricGazeAuthority.LegacyState state = FabricGazeAuthority.LegacyState.initial();
        double yaw = -30.0D;
        double pitch = 45.0D;
        double[][] targets = {
            {60.0D, 30.0D},
            {95.0D, 10.0D},
            {20.0D, -15.0D},
            {-70.0D, 5.0D}
        };

        for (int index = 0; index < targets.length; index++) {
            LookDemand demand = demand(
                LookDemand.Owner.NORMAL,
                LookDemand.Profile.TRAVEL,
                "travel",
                targets[index][0],
                targets[index][1]
            );
            LookController.Look expected = LookController.nextLook(
                yaw,
                pitch,
                targets[index][0],
                targets[index][1],
                9.0D
            );
            FabricGazeAuthority.LegacyOutput actual = FabricGazeAuthority.legacyStep(
                state,
                yaw,
                pitch,
                demand,
                1_000L + index * 50L
            );

            assertEquals(expected.yaw(), actual.yaw(), EPSILON);
            assertEquals(expected.pitch(), actual.pitch(), EPSILON);
            state = actual.state();
            yaw = actual.yaw();
            pitch = actual.pitch();
        }
    }

    private static LookDemand demand(
        LookDemand.Owner owner,
        LookDemand.Profile profile,
        String reason,
        double yaw,
        double pitch
    ) {
        return new LookDemand(
            owner,
            owner.name().toLowerCase() + ":target",
            profile,
            yaw,
            pitch,
            profile == LookDemand.Profile.PRECISION
                ? LookDemand.RetargetPolicy.COMMITTED
                : LookDemand.RetargetPolicy.CONTINUOUS,
            "command",
            reason
        );
    }
}
