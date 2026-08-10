package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FabricGazeControllerTest {
    private static final double EPSILON = 1.0E-6D;

    @Test
    void followsShortestWrappedYawAndClampedPitch() {
        FabricGazeController.Transition transition = FabricGazeController.step(
            FabricGazeController.initialState(),
            179.0D,
            85.0D,
            travel("route:1", -179.0D, 120.0D),
            1_000L
        );

        assertTrue(LookController.shortestYawDelta(179.0D, transition.output().yaw()) > 0.0D);
        assertTrue(transition.output().pitch() <= 90.0D);
    }

    @Test
    void obeysAccelerationSpeedAndBrakingLimits() {
        FabricGazeController.State state = FabricGazeController.initialState();
        double yaw = 0.0D;
        double pitch = 0.0D;
        long now = 1_000L;
        LookDemand demand = travel("route:1", 170.0D, 30.0D);

        for (int i = 0; i < 80; i++) {
            FabricGazeController.Transition transition =
                FabricGazeController.step(state, yaw, pitch, demand, now);
            assertTrue(
                transition.output().angularSpeed()
                    <= LookDemand.Profile.TRAVEL.maxSpeedDegPerSecond() + EPSILON
            );
            assertTrue(
                transition.output().angularAcceleration()
                    <= LookDemand.Profile.TRAVEL.maxAccelerationDegPerSecondSquared() + EPSILON
            );
            state = transition.state();
            yaw = transition.output().yaw();
            pitch = transition.output().pitch();
            now += 50L;
        }

        assertEquals(170.0D, yaw, EPSILON);
        assertEquals(30.0D, pitch, EPSILON);
        assertTrue(state.settled());
    }

    @Test
    void brakingSpeedLimitUsesStoppingDistanceAndProfileCap() {
        assertEquals(
            Math.sqrt(2.0D * 960.0D * 10.0D),
            FabricGazeController.brakingSpeedLimit(LookDemand.Profile.TRAVEL, 10.0D),
            EPSILON
        );
        assertEquals(
            240.0D,
            FabricGazeController.brakingSpeedLimit(LookDemand.Profile.TRAVEL, 100.0D),
            EPSILON
        );
        assertEquals(
            0.0D,
            FabricGazeController.brakingSpeedLimit(LookDemand.Profile.TRAVEL, -1.0D),
            EPSILON
        );
    }

    @Test
    void neverOvershootsEitherAxis() {
        FabricGazeController.State state = FabricGazeController.initialState();
        double yaw = 0.0D;
        double pitch = 0.0D;
        double priorYawError = 13.0D;
        double priorPitchError = -7.0D;

        for (int i = 0; i < 30; i++) {
            FabricGazeController.Transition transition =
                FabricGazeController.step(state, yaw, pitch, travel("route:1", 13.0D, -7.0D), 1_000L + i * 50L);
            double yawError = LookController.shortestYawDelta(transition.output().yaw(), 13.0D);
            double pitchError = -7.0D - transition.output().pitch();
            assertTrue(yawError >= -EPSILON);
            assertTrue(pitchError <= EPSILON);
            assertTrue(Math.abs(yawError) <= Math.abs(priorYawError) + EPSILON);
            assertTrue(Math.abs(pitchError) <= Math.abs(priorPitchError) + EPSILON);
            state = transition.state();
            yaw = transition.output().yaw();
            pitch = transition.output().pitch();
            priorYawError = yawError;
            priorPitchError = pitchError;
        }
    }

    @Test
    void coupledAxisOvershootCannotHideAnAccelerationLimitViolation() {
        FabricGazeController.State state = FabricGazeController.initialState();
        double yaw = 0.0D;
        double pitch = 0.0D;
        long now = 1_000L;
        LookDemand initial = travel("route:initial", 170.0D, 0.0D);
        for (int i = 0; i < 5; i++) {
            FabricGazeController.Transition transition =
                FabricGazeController.step(state, yaw, pitch, initial, now);
            state = transition.state();
            yaw = transition.output().yaw();
            pitch = transition.output().pitch();
            now += 50L;
        }

        LookDemand coupled = travel("route:coupled", yaw + 0.01D, 80.0D);
        FabricGazeController.Transition transition =
            FabricGazeController.step(state, yaw, pitch, coupled, now);
        double velocityDelta = Math.hypot(
            transition.state().yawVelocity() - state.yawVelocity(),
            transition.state().pitchVelocity() - state.pitchVelocity()
        );
        double maximumDelta =
            LookDemand.Profile.TRAVEL.maxAccelerationDegPerSecondSquared() * 0.050D;

        assertTrue(velocityDelta <= maximumDelta + EPSILON);
        assertTrue(
            transition.output().angularAcceleration()
                <= LookDemand.Profile.TRAVEL.maxAccelerationDegPerSecondSquared() + EPSILON
        );
        assertTrue(
            Math.abs(LookController.shortestYawDelta(transition.output().yaw(), coupled.desiredYaw()))
                <= 0.01D + EPSILON
        );
    }

    @Test
    void preservesVelocityContinuityAcrossTargetChanges() {
        FabricGazeController.State state = FabricGazeController.initialState();
        double yaw = 0.0D;
        long now = 1_000L;
        for (int i = 0; i < 4; i++) {
            FabricGazeController.Transition transition =
                FabricGazeController.step(state, yaw, 0.0D, travel("route:a", 150.0D, 0.0D), now);
            state = transition.state();
            yaw = transition.output().yaw();
            now += 50L;
        }
        double forwardVelocity = state.yawVelocity();

        FabricGazeController.Transition reversed =
            FabricGazeController.step(state, yaw, 0.0D, travel("route:b", -150.0D, 0.0D), now);

        assertTrue(forwardVelocity > 0.0D);
        assertTrue(reversed.state().yawVelocity() > 0.0D);
        assertTrue(reversed.state().yawVelocity() < forwardVelocity);
        assertTrue(reversed.output().targetChanged());
    }

    @Test
    void doesNotReverseWithoutTargetChangeOrCrossing() {
        FabricGazeController.State state = FabricGazeController.initialState();
        double yaw = -80.0D;
        double pitch = 30.0D;
        for (int i = 0; i < 100; i++) {
            FabricGazeController.Transition transition = FabricGazeController.step(
                state,
                yaw,
                pitch,
                travel("route:stable", 75.0D, -20.0D),
                1_000L + i * 50L
            );
            assertEquals(0, transition.output().outputReversals());
            state = transition.state();
            yaw = transition.output().yaw();
            pitch = transition.output().pitch();
        }
    }

    @Test
    void errorCrossingReversalIsNotAnUncommandedAnomaly() {
        LookDemand previous = travel("route:stable", 90.0D, 0.0D);
        LookDemand moved = travel("route:stable", -90.0D, 0.0D);
        FabricGazeController.State state = new FabricGazeController.State(
            true,
            1_000L,
            120.0D,
            0.0D,
            previous,
            0L,
            0,
            false,
            LookDemand.Profile.TRAVEL
        );
        double yaw = 0.0D;
        FabricGazeController.Transition reversal = null;

        for (int i = 1; i <= 4; i++) {
            FabricGazeController.Transition transition = FabricGazeController.step(
                state,
                yaw,
                0.0D,
                moved,
                1_000L + i * 50L
            );
            state = transition.state();
            yaw = transition.output().yaw();
            if (transition.output().outputReversals() > 0) {
                reversal = transition;
                break;
            }
        }

        assertNotEquals(null, reversal);
        assertEquals(1, reversal.output().outputReversals());
        assertEquals(0, reversal.output().uncommandedReversals());
    }

    @Test
    void lowerSpeedProfileUsesTheInheritedEnvelopeUntilItDeceleratesInsideTheCap() {
        LookDemand tracking = tracking("entity:1", 170.0D);
        FabricGazeController.State state = new FabricGazeController.State(
            true,
            1_000L,
            300.0D,
            0.0D,
            tracking,
            0L,
            0,
            false,
            LookDemand.Profile.TRACKING
        );
        double yaw = 0.0D;
        double pitch = 0.0D;
        LookDemand precision = precision("command", "aim", "block:1", 170.0D);
        double[] expectedSpeeds = {264.0D, 228.0D, 192.0D, 180.0D};

        for (int i = 0; i < expectedSpeeds.length; i++) {
            FabricGazeController.Transition transition =
                FabricGazeController.step(state, yaw, pitch, precision, 1_050L + i * 50L);
            assertEquals(expectedSpeeds[i], transition.output().angularSpeed(), EPSILON);
            assertTrue(transition.output().angularAcceleration() <= 720.0D + EPSILON);
            assertEquals(precision.targetIdentity(), transition.state().effectiveDemand().targetIdentity());
            assertFalse(transition.output().profileAccountingViolation());
            if (i < 3) {
                assertEquals(
                    LookDemand.Profile.TRACKING,
                    transition.output().speedEnvelopeProfile()
                );
                assertTrue(transition.output().profileTransition());
                assertEquals(expectedSpeeds[i] - 180.0D, transition.output().requestedProfileSpeedExcess(), EPSILON);
            } else {
                assertEquals(
                    LookDemand.Profile.PRECISION,
                    transition.output().speedEnvelopeProfile()
                );
                assertFalse(transition.output().profileTransition());
                assertEquals(0.0D, transition.output().requestedProfileSpeedExcess(), EPSILON);
            }
            state = transition.state();
            yaw = transition.output().yaw();
            pitch = transition.output().pitch();
        }

        assertEquals(13.2D + 11.4D + 9.6D + 9.0D, yaw, EPSILON);
    }

    @Test
    void impossibleInheritedSpeedReportsAnAccountingViolationWithoutRelabelingIt() {
        LookDemand tracking = tracking("entity:1", 170.0D);
        FabricGazeController.State corrupt = new FabricGazeController.State(
            true,
            1_000L,
            340.0D,
            0.0D,
            tracking,
            0L,
            0,
            false,
            LookDemand.Profile.TRACKING
        );

        FabricGazeController.Transition transition = FabricGazeController.step(
            corrupt,
            0.0D,
            0.0D,
            precision("command", "aim", "block:1", 170.0D),
            1_050L
        );

        assertEquals(304.0D, transition.output().angularSpeed(), EPSILON);
        assertEquals(LookDemand.Profile.PRECISION, transition.output().speedEnvelopeProfile());
        assertFalse(transition.output().profileTransition());
        assertTrue(transition.output().profileAccountingViolation());
    }

    @Test
    void classifierRejectsOnlySameSideReversalsWithoutRetargeting() {
        assertFalse(FabricGazeController.isUncommandedReversal(24.0D, -24.0D, -90.0D, false));
        assertFalse(FabricGazeController.isUncommandedReversal(24.0D, -24.0D, 90.0D, true));
        assertTrue(FabricGazeController.isUncommandedReversal(24.0D, -24.0D, 90.0D, false));
    }

    @Test
    void clampsShortAndLongTickIntervals() {
        LookDemand demand = travel("route:1", 170.0D, 0.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            0.0D,
            0.0D,
            demand,
            1_000L
        );
        FabricGazeController.Transition shortTick =
            FabricGazeController.step(first.state(), first.output().yaw(), 0.0D, demand, 1_001L);
        assertEquals(
            LookDemand.Profile.TRAVEL.maxAccelerationDegPerSecondSquared() * 0.010D,
            shortTick.state().yawVelocity() - first.state().yawVelocity(),
            EPSILON
        );

        FabricGazeController.Transition longTick =
            FabricGazeController.step(shortTick.state(), shortTick.output().yaw(), 0.0D, demand, 1_201L);
        assertEquals(
            LookDemand.Profile.TRAVEL.maxAccelerationDegPerSecondSquared() * 0.100D,
            longTick.state().yawVelocity() - shortTick.state().yawVelocity(),
            EPSILON
        );
    }

    @Test
    void longGapClearsVelocityAndResumesWithFiftyMillisecondStep() {
        LookDemand demand = travel("route:1", 170.0D, 0.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            0.0D,
            0.0D,
            demand,
            1_000L
        );
        FabricGazeController.Transition resumed =
            FabricGazeController.step(first.state(), first.output().yaw(), 0.0D, demand, 1_300L);

        assertTrue(resumed.output().longGapReset());
        assertFalse(resumed.output().profileTransition());
        assertFalse(resumed.output().profileAccountingViolation());
        assertEquals(LookDemand.Profile.TRAVEL, resumed.output().speedEnvelopeProfile());
        assertEquals(
            LookDemand.Profile.TRAVEL.maxAccelerationDegPerSecondSquared() * 0.050D,
            resumed.state().yawVelocity(),
            EPSILON
        );
    }

    @Test
    void settlesAfterTwoPollsThenStopsWritingInsideDeadband() {
        LookDemand demand = travel("route:1", 0.1D, 0.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            0.0D,
            0.0D,
            demand,
            1_000L
        );
        assertFalse(first.output().settled());

        FabricGazeController.Transition second =
            FabricGazeController.step(first.state(), first.output().yaw(), first.output().pitch(), demand, 1_050L);
        assertFalse(second.output().settled());

        FabricGazeController.Transition settled =
            FabricGazeController.step(second.state(), second.output().yaw(), second.output().pitch(), demand, 1_100L);
        assertTrue(settled.output().settled());
        assertTrue(settled.output().settledNow());
        assertEquals(0.1D, settled.output().yaw(), EPSILON);

        LookDemand tinyMove = travel("route:1", 0.5D, 0.2D);
        FabricGazeController.Transition third =
            FabricGazeController.step(
                settled.state(),
                settled.output().yaw(),
                settled.output().pitch(),
                tinyMove,
                1_150L
            );
        assertFalse(third.output().write());
        assertTrue(third.output().settled());

        LookDemand outsideDeadband = travel("route:1", 2.0D, 0.0D);
        FabricGazeController.Transition fourth =
            FabricGazeController.step(third.state(), third.output().yaw(), third.output().pitch(), outsideDeadband, 1_200L);
        assertTrue(fourth.output().write());
        assertFalse(fourth.output().settled());
    }

    @Test
    void precisionCommitmentSuppressesRapidAToBToASwaps() {
        LookDemand a = precision("command", "aim", "block:a", 0.0D);
        LookDemand b = precision("command", "aim", "block:b", 90.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            -20.0D,
            0.0D,
            a,
            1_000L
        );
        FabricGazeController.Transition bSuppressed =
            FabricGazeController.step(first.state(), first.output().yaw(), 0.0D, b, 1_100L);
        FabricGazeController.Transition aRestored =
            FabricGazeController.step(bSuppressed.state(), bSuppressed.output().yaw(), 0.0D, a, 1_200L);

        assertTrue(bSuppressed.output().targetSuppressed());
        assertEquals("block:a", bSuppressed.state().effectiveDemand().targetIdentity());
        assertFalse(aRestored.output().targetSuppressed());
        assertEquals("block:a", aRestored.state().effectiveDemand().targetIdentity());

        FabricGazeController.Transition bAccepted =
            FabricGazeController.step(aRestored.state(), aRestored.output().yaw(), 0.0D, b, 1_500L);
        assertFalse(bAccepted.output().targetSuppressed());
        assertEquals("block:b", bAccepted.state().effectiveDemand().targetIdentity());
    }

    @Test
    void commandOrReasonChangeReleasesPrecisionCommitment() {
        LookDemand a = precision("command", "aim", "block:a", 0.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            -20.0D,
            0.0D,
            a,
            1_000L
        );

        LookDemand newReason = precision("command", "break", "block:b", 90.0D);
        FabricGazeController.Transition reasonReleased =
            FabricGazeController.step(first.state(), first.output().yaw(), 0.0D, newReason, 1_100L);
        assertFalse(reasonReleased.output().targetSuppressed());
        assertEquals("block:b", reasonReleased.state().effectiveDemand().targetIdentity());

        LookDemand newCommand = precision("next", "break", "block:c", -90.0D);
        FabricGazeController.Transition commandReleased = FabricGazeController.step(
            reasonReleased.state(),
            reasonReleased.output().yaw(),
            0.0D,
            newCommand,
            1_200L
        );
        assertFalse(commandReleased.output().targetSuppressed());
        assertEquals("block:c", commandReleased.state().effectiveDemand().targetIdentity());
    }

    @Test
    void enteringCommittedProfileLatchesEvenWhenIdentityIsUnchanged() {
        LookDemand travel = travel("block:a", 20.0D, 0.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            0.0D,
            0.0D,
            travel,
            1_000L
        );
        LookDemand precisionA = precision("command", "travel", "block:a", 20.0D);
        FabricGazeController.Transition committed = FabricGazeController.step(
            first.state(),
            first.output().yaw(),
            first.output().pitch(),
            precisionA,
            1_050L
        );
        LookDemand precisionB = precision("command", "travel", "block:b", 80.0D);
        FabricGazeController.Transition suppressed = FabricGazeController.step(
            committed.state(),
            committed.output().yaw(),
            committed.output().pitch(),
            precisionB,
            1_100L
        );

        assertEquals(1_550L, committed.state().commitmentUntilMs());
        assertTrue(suppressed.output().targetSuppressed());
        assertEquals("block:a", suppressed.state().effectiveDemand().targetIdentity());
    }

    @Test
    void acceptedTargetChangeRequiresItsOwnTwoSettlePolls() {
        LookDemand a = travel("route:a", 0.0D, 0.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            0.0D,
            0.0D,
            a,
            1_000L
        );
        FabricGazeController.Transition settled =
            FabricGazeController.step(first.state(), first.output().yaw(), first.output().pitch(), a, 1_050L);
        assertTrue(settled.output().settled());

        LookDemand b = travel("route:b", 0.1D, 0.0D);
        FabricGazeController.Transition changed =
            FabricGazeController.step(settled.state(), settled.output().yaw(), settled.output().pitch(), b, 1_100L);
        assertFalse(changed.output().settled());
        assertEquals(0, changed.state().settlePolls());

        FabricGazeController.Transition bSlowed = FabricGazeController.step(
            changed.state(),
            changed.output().yaw(),
            changed.output().pitch(),
            b,
            1_150L
        );
        assertFalse(bSlowed.output().settled());
        assertEquals(1, bSlowed.state().settlePolls());

        FabricGazeController.Transition bSettled = FabricGazeController.step(
            bSlowed.state(),
            bSlowed.output().yaw(),
            bSlowed.output().pitch(),
            b,
            1_200L
        );
        assertTrue(bSettled.output().settled());
    }

    @Test
    void sameTrackingIdentityUpdatesContinuously() {
        LookDemand initial = tracking("item:uuid", 30.0D);
        FabricGazeController.Transition first = FabricGazeController.step(
            FabricGazeController.initialState(),
            0.0D,
            0.0D,
            initial,
            1_000L
        );
        LookDemand moved = tracking("item:uuid", 80.0D);
        FabricGazeController.Transition second = FabricGazeController.step(
            first.state(),
            first.output().yaw(),
            first.output().pitch(),
            moved,
            1_050L
        );

        assertFalse(second.output().targetChanged());
        assertFalse(second.output().targetSuppressed());
        assertEquals(80.0D, second.state().effectiveDemand().desiredYaw(), EPSILON);
        assertNotEquals(first.output().yaw(), second.output().yaw());
    }

    @Test
    void criticalDemandWritesExactSafetyPoseImmediately() {
        LookDemand critical = new LookDemand(
            LookDemand.Owner.SURVIVAL,
            "survival:swim_up",
            LookDemand.Profile.CRITICAL,
            -170.0D,
            -75.0D,
            LookDemand.RetargetPolicy.IMMEDIATE,
            "command",
            "swim_up"
        );
        FabricGazeController.Transition transition = FabricGazeController.step(
            FabricGazeController.initialState(),
            80.0D,
            40.0D,
            critical,
            1_000L
        );

        assertEquals(-170.0D, transition.output().yaw(), EPSILON);
        assertEquals(-75.0D, transition.output().pitch(), EPSILON);
        assertTrue(transition.output().criticalImmediate());
        assertTrue(transition.output().settled());
        assertEquals(0.0D, transition.state().yawVelocity(), EPSILON);
    }

    @Test
    void resetStateDropsVelocityCommitmentAndSettlingHistory() {
        LookDemand demand = precision("command", "aim", "block:a", 120.0D);
        FabricGazeController.Transition active = FabricGazeController.step(
            FabricGazeController.initialState(),
            0.0D,
            0.0D,
            demand,
            1_000L
        );
        assertNotEquals(0.0D, active.state().yawVelocity());

        FabricGazeController.State reset = FabricGazeController.initialState();
        assertFalse(reset.initialized());
        assertEquals(0.0D, reset.yawVelocity(), EPSILON);
        assertEquals(0L, reset.commitmentUntilMs());
        assertEquals(null, reset.effectiveDemand());
    }

    private static LookDemand travel(String target, double yaw, double pitch) {
        return new LookDemand(
            LookDemand.Owner.NORMAL,
            target,
            LookDemand.Profile.TRAVEL,
            yaw,
            pitch,
            LookDemand.RetargetPolicy.CONTINUOUS,
            "command",
            "travel"
        );
    }

    private static LookDemand precision(String command, String reason, String target, double yaw) {
        return new LookDemand(
            LookDemand.Owner.NORMAL,
            target,
            LookDemand.Profile.PRECISION,
            yaw,
            0.0D,
            LookDemand.RetargetPolicy.COMMITTED,
            command,
            reason
        );
    }

    private static LookDemand tracking(String target, double yaw) {
        return new LookDemand(
            LookDemand.Owner.NORMAL,
            target,
            LookDemand.Profile.TRACKING,
            yaw,
            10.0D,
            LookDemand.RetargetPolicy.CONTINUOUS,
            "command",
            "track"
        );
    }
}
