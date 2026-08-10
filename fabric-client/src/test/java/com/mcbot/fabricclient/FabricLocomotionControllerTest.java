package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FabricLocomotionControllerTest {
    private static final VoxelCell FEET = new VoxelCell(2, 64, 3);

    @Test
    void engagesAtTwelveDegreesAndReleasesAboveTwentyEight() {
        var engaged = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, forward(0.18F, false)),
            observation(1_000L, 12.0D, true, FEET)
        );
        assertTrue(engaged.output().input().pressingForward());
        assertEquals(1.0F, engaged.output().input().movementForward());

        var held = step(
            engaged.state(),
            route(3, 0.0D, true, false, false, forward(0.18F, false)),
            observation(1_050L, 28.0D, true, FEET)
        );
        assertTrue(held.output().input().pressingForward());

        var released = step(
            held.state(),
            route(3, 0.0D, true, false, false, forward(0.18F, false)),
            observation(1_100L, 28.000_1D, true, FEET)
        );
        assertFalse(released.output().input().pressingForward());

        var freshOutsideEngage = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, forward(0.18F, false)),
            observation(1_000L, 12.000_1D, true, FEET)
        );
        assertFalse(freshOutsideEngage.output().input().pressingForward());
    }

    @Test
    void rawStopCannotBeTurnedIntoMovement() {
        InputState stopped = InputState.stop();
        var transition = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, stopped),
            observation(1_000L, 0.0D, true, FEET)
        );

        assertEquals(InputState.stop(), transition.output().input());
        assertFalse(transition.output().sprintRequested());
    }

    @Test
    void sidewaysOrBackwardInputPassesThroughByteForByte() {
        InputState sideways = new InputState(true, false, true, false, false, false, 0.5F, 0.35F);
        var transition = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, sideways),
            observation(1_000L, 0.0D, true, FEET)
        );

        assertTrue(transition.output().passthrough());
        assertEquals(sideways, transition.output().input());
    }

    @Test
    void validatedWaypointContinuationPreservesSprintClock() {
        var first = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_000L, 0.0D, true, FEET)
        );
        var continued = step(
            first.state(),
            route(4, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_150L, 0.0D, true, new VoxelCell(3, 64, 3))
        );

        assertTrue(continued.output().input().pressingForward());
        assertTrue(continued.output().sprintRequested());
        assertEquals(1_000L, continued.state().sprintEligibleSinceMs());
    }

    @Test
    void unsafeWaypointTransitionResetsSprintClockWithoutInventingAStop() {
        var first = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_000L, 0.0D, true, FEET)
        );
        var reset = step(
            first.state(),
            route(4, 0.0D, false, false, false, forward(1.0F, false)),
            observation(1_200L, 0.0D, true, new VoxelCell(3, 64, 3))
        );

        assertTrue(reset.output().input().pressingForward());
        assertFalse(reset.output().sprintRequested());
        assertEquals(1_200L, reset.state().sprintEligibleSinceMs());
    }

    @Test
    void sameWaypointSegmentChangeResetsForwardAndSprintHysteresis() {
        var sprinting = step(
            sprintingState(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_200L, 0.0D, true, FEET)
        );
        LocomotionDemand staged = new LocomotionDemand(
            LookDemand.Owner.NORMAL,
            LocomotionDemand.Policy.ROUTE_TRAVEL,
            forward(1.0F, false),
            false,
            "cmd",
            7L,
            3,
            "route:7:3:staged",
            20.0D,
            false,
            false,
            true,
            LocomotionDemand.JumpPolicy.NONE,
            null,
            "navigation_turn"
        );

        var reset = step(
            sprinting.state(),
            staged,
            observation(1_250L, 0.0D, true, FEET)
        );

        assertFalse(reset.output().input().pressingForward());
        assertFalse(reset.output().sprintRequested());
        assertEquals(-1L, reset.state().sprintEligibleSinceMs());
    }

    @Test
    void sprintStartsAtExactlyOneHundredFiftyMilliseconds() {
        var first = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_000L, 0.0D, true, FEET)
        );
        var early = step(
            first.state(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_149L, 0.0D, true, FEET)
        );
        var ready = step(
            early.state(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_150L, 0.0D, true, FEET)
        );

        assertFalse(first.output().sprintRequested());
        assertFalse(early.output().sprintRequested());
        assertTrue(ready.output().sprintRequested());
    }

    @Test
    void routeEndSneakWaterAndJumpReleaseSprintImmediately() {
        var sprinting = sprintingState();

        assertFalse(step(
            sprinting,
            route(3, 0.0D, true, true, false, forward(1.0F, false)),
            observation(1_200L, 0.0D, true, FEET)
        ).output().sprintRequested());

        InputState sneaking = new InputState(true, false, false, false, false, true, 1.0F, 0.0F);
        assertFalse(step(
            sprinting,
            route(3, 0.0D, true, false, false, sneaking),
            observation(1_200L, 0.0D, true, FEET)
        ).output().sprintRequested());

        assertFalse(step(
            sprinting,
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            new FabricLocomotionController.Observation(1_200L, 0.0D, true, true, FEET, true)
        ).output().sprintRequested());

        var jump = pulseDemand(3, LocomotionDemand.JumpPolicy.STEP_PULSE);
        assertFalse(step(
            sprinting,
            jump,
            observation(1_200L, 0.0D, true, FEET)
        ).output().sprintRequested());
    }

    @Test
    void pulseHasOneRisingEdgeAndReleasesOnTakeoff() {
        LocomotionDemand demand = pulseDemand(3, LocomotionDemand.JumpPolicy.STEP_PULSE);
        var started = step(
            FabricLocomotionController.initialState(),
            demand,
            observation(1_000L, 0.0D, true, FEET)
        );
        assertTrue(started.output().jumpStarted());
        assertTrue(started.output().input().jumping());

        var airborne = step(
            started.state(),
            demand,
            new FabricLocomotionController.Observation(1_050L, 0.0D, false, false, null, false)
        );
        assertTrue(airborne.output().jumpCompleted());
        assertFalse(airborne.output().duplicateJumpSuppressed());
        assertFalse(airborne.output().input().jumping());

        var landedSameCell = step(
            airborne.state(),
            demand,
            observation(1_100L, 0.0D, true, FEET)
        );
        assertTrue(landedSameCell.output().duplicateJumpSuppressed());
        assertFalse(landedSameCell.output().input().jumping());
    }

    @Test
    void pulseTimesOutAtExactlyOneHundredFiftyMillisecondsAndStaysDisarmed() {
        LocomotionDemand demand = pulseDemand(3, LocomotionDemand.JumpPolicy.UNSTICK_PULSE);
        var started = step(
            FabricLocomotionController.initialState(),
            demand,
            observation(1_000L, 0.0D, true, FEET)
        );
        var early = step(
            started.state(),
            demand,
            observation(1_149L, 0.0D, true, FEET)
        );
        var timedOut = step(
            early.state(),
            demand,
            observation(1_150L, 0.0D, true, FEET)
        );

        assertTrue(early.output().input().jumping());
        assertTrue(timedOut.output().jumpRejected());
        assertFalse(timedOut.output().duplicateJumpSuppressed());
        assertFalse(timedOut.output().input().jumping());

        var stillDisarmed = step(
            timedOut.state(),
            demand,
            observation(1_200L, 0.0D, true, FEET)
        );
        assertTrue(stillDisarmed.output().duplicateJumpSuppressed());
    }

    @Test
    void forwardRouteProgressCompletesAPulseWithoutAnAirborneSample() {
        LocomotionDemand demand = pulseDemand(3, LocomotionDemand.JumpPolicy.STEP_PULSE);
        var started = step(
            FabricLocomotionController.initialState(),
            demand,
            observation(1_000L, 0.0D, true, FEET)
        );
        LocomotionDemand advanced = route(
            4,
            0.0D,
            true,
            false,
            false,
            forward(1.0F, false)
        );

        var completed = step(
            started.state(),
            advanced,
            observation(1_050L, 0.0D, true, new VoxelCell(0, 65, 1))
        );

        assertTrue(completed.output().jumpCompleted());
        assertFalse(completed.output().jumpRejected());
        assertFalse(completed.output().duplicateJumpSuppressed());
        assertFalse(completed.output().input().jumping());
    }

    @Test
    void stepPulseRearmsOnlyAfterForwardRouteProgress() {
        LocomotionDemand demand = pulseDemand(3, LocomotionDemand.JumpPolicy.STEP_PULSE);
        var started = step(
            FabricLocomotionController.initialState(),
            demand,
            observation(1_000L, 0.0D, true, FEET)
        );
        var completed = step(
            started.state(),
            demand,
            new FabricLocomotionController.Observation(1_050L, 0.0D, false, false, null, false)
        );
        var stillDisarmedAtLanding = step(
            completed.state(),
            demand,
            observation(1_100L, 0.0D, true, new VoxelCell(3, 65, 3))
        );
        assertFalse(stillDisarmedAtLanding.output().jumpStarted());
        assertTrue(stillDisarmedAtLanding.output().duplicateJumpSuppressed());

        LocomotionDemand next = pulseDemand(4, LocomotionDemand.JumpPolicy.STEP_PULSE);
        var rearmedByRoute = step(
            completed.state(),
            next,
            observation(1_100L, 0.0D, true, FEET)
        );
        assertTrue(rearmedByRoute.output().jumpStarted());
    }

    @Test
    void unstickPulseRearmsAfterGenuineGroundedFeetProgress() {
        LocomotionDemand demand = pulseDemand(3, LocomotionDemand.JumpPolicy.UNSTICK_PULSE);
        var started = step(
            FabricLocomotionController.initialState(),
            demand,
            observation(1_000L, 0.0D, true, FEET)
        );
        var completed = step(
            started.state(),
            demand,
            new FabricLocomotionController.Observation(1_050L, 0.0D, false, false, null, false)
        );
        var rearmed = step(
            completed.state(),
            demand,
            observation(1_100L, 0.0D, true, new VoxelCell(3, 64, 3))
        );

        assertTrue(rearmed.output().jumpStarted());
    }

    @Test
    void routeSprintRemainsReleasedWhileAirborneAfterTakeoff() {
        LocomotionDemand demand = pulseDemand(3, LocomotionDemand.JumpPolicy.STEP_PULSE);
        var started = step(
            FabricLocomotionController.initialState(),
            demand,
            observation(1_000L, 0.0D, true, FEET)
        );
        var airborne = step(
            started.state(),
            demand,
            new FabricLocomotionController.Observation(1_050L, 0.0D, false, false, null, false)
        );
        var stillAirborne = step(
            airborne.state(),
            demand,
            new FabricLocomotionController.Observation(1_250L, 0.0D, false, false, null, false)
        );

        assertFalse(airborne.output().sprintRequested());
        assertFalse(stillAirborne.output().sprintRequested());
        assertEquals(-1L, stillAirborne.state().sprintEligibleSinceMs());
    }

    @Test
    void routeRegressionCannotRearmACompletedStepPulse() {
        LocomotionDemand demand = pulseDemand(3, LocomotionDemand.JumpPolicy.STEP_PULSE);
        var started = step(
            FabricLocomotionController.initialState(),
            demand,
            observation(1_000L, 0.0D, true, FEET)
        );
        var completed = step(
            started.state(),
            demand,
            new FabricLocomotionController.Observation(1_050L, 0.0D, false, false, null, false)
        );
        LocomotionDemand regressed = pulseDemand(2, LocomotionDemand.JumpPolicy.STEP_PULSE);

        var transition = step(
            completed.state(),
            regressed,
            observation(1_100L, 0.0D, true, FEET)
        );

        assertFalse(transition.output().jumpStarted());
        assertFalse(transition.output().input().jumping());
    }

    @Test
    void passthroughPreservesContinuousJumpAndLegacySprint() {
        InputState raw = new InputState(true, false, false, false, true, false, 0.37F, 0.0F);
        LocomotionDemand demand = LocomotionDemand.passthrough(
            LookDemand.Owner.SURVIVAL,
            raw,
            true,
            "survival",
            "swim_up"
        );
        var transition = step(
            sprintingState(),
            demand,
            new FabricLocomotionController.Observation(2_000L, 0.0D, false, true, null, true)
        );

        assertTrue(transition.output().passthrough());
        assertEquals(raw, transition.output().input());
        assertTrue(transition.output().sprintRequested());
        assertFalse(transition.state().forwardEngaged());
        assertEquals(null, transition.state().activePulse());
    }

    @Test
    void actualSprintIsTelemetryAndDoesNotAlterRequestedState() {
        var state = sprintingState();
        var transition = step(
            state,
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            new FabricLocomotionController.Observation(1_200L, 0.0D, true, false, FEET, false)
        );

        assertTrue(transition.output().sprintRequested());
        assertFalse(transition.output().actualSprinting());
    }

    private static FabricLocomotionController.State sprintingState() {
        var first = step(
            FabricLocomotionController.initialState(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_000L, 0.0D, true, FEET)
        );
        return step(
            first.state(),
            route(3, 0.0D, true, false, false, forward(1.0F, false)),
            observation(1_150L, 0.0D, true, FEET)
        ).state();
    }

    private static LocomotionDemand route(
        int waypoint,
        double yaw,
        boolean preserve,
        boolean routeEnd,
        boolean legacySprint,
        InputState raw
    ) {
        return new LocomotionDemand(
            LookDemand.Owner.NORMAL,
            LocomotionDemand.Policy.ROUTE_TRAVEL,
            raw,
            legacySprint,
            "cmd",
            7L,
            waypoint,
            "route:7:" + waypoint,
            yaw,
            preserve,
            routeEnd,
            true,
            LocomotionDemand.JumpPolicy.NONE,
            null,
            "navigation_travel"
        );
    }

    private static LocomotionDemand pulseDemand(
        int waypoint,
        LocomotionDemand.JumpPolicy jumpPolicy
    ) {
        VoxelCell origin = waypoint == 3 ? FEET : new VoxelCell(3, 65, 3);
        LocomotionDemand.StepIdentity identity = new LocomotionDemand.StepIdentity(
            "cmd",
            7L,
            waypoint,
            origin,
            new VoxelCell(origin.x() + 1, origin.y() + 1, origin.z())
        );
        return new LocomotionDemand(
            LookDemand.Owner.NORMAL,
            LocomotionDemand.Policy.ROUTE_TRAVEL,
            forward(1.0F, true),
            false,
            "cmd",
            7L,
            waypoint,
            "route:7:" + waypoint,
            0.0D,
            true,
            false,
            true,
            jumpPolicy,
            identity,
            "navigation_step"
        );
    }

    private static FabricLocomotionController.Observation observation(
        long nowMs,
        double yaw,
        boolean onGround,
        VoxelCell feet
    ) {
        return new FabricLocomotionController.Observation(
            nowMs,
            yaw,
            onGround,
            false,
            feet,
            false
        );
    }

    private static InputState forward(float amount, boolean jump) {
        return new InputState(true, false, false, false, jump, false, amount, 0.0F);
    }

    private static FabricLocomotionController.Transition step(
        FabricLocomotionController.State state,
        LocomotionDemand demand,
        FabricLocomotionController.Observation observation
    ) {
        return FabricLocomotionController.step(state, demand, observation);
    }
}
