package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class DescentControlPlannerTest {
    @Test
    void timeoutIsTheFirstPreflightFailure() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decidePreflight(
            state(1, 0, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.PreflightObservation(101, 100, 20.0F, 5.0F, "descent_player_in_hazard:water:0,64,0", false, 1.0D, 6.0D)
        );

        assertEquals(DescentControlPlanner.Action.FAIL_TIMEOUT, decision.action());
        assertEquals("descent_timeout", decision.reason());
    }

    @Test
    void healthLossPrecedesCurrentHazardAndGroundWait() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decidePreflight(
            state(1, 0, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.PreflightObservation(10, 100, 20.0F, 19.0F, "descent_player_in_hazard:water:0,64,0", false, -1.0D, 6.0D)
        );

        assertEquals(DescentControlPlanner.Action.FAIL_HEALTH_LOST, decision.action());
        assertEquals("descent_health_lost", decision.reason());
    }

    @Test
    void playerHazardFailsBeforeWaitingForGround() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decidePreflight(
            state(1, 0, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.PreflightObservation(10, 100, 20.0F, 20.0F, "descent_player_in_hazard:water:0,64,0", false, -1.0D, 6.0D)
        );

        assertEquals(DescentControlPlanner.Action.FAIL_PLAYER_HAZARD, decision.action());
        assertEquals("descent_player_in_hazard:water:0,64,0", decision.reason());
    }

    @Test
    void airborneWaitPrecedesHostileAbort() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decidePreflight(
            state(1, 0, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.PreflightObservation(10, 100, 20.0F, 20.0F, null, false, 1.0D, 6.0D)
        );

        assertEquals(DescentControlPlanner.Action.WAIT_ON_GROUND, decision.action());
        assertEquals("descent_waiting_on_ground", decision.reason());
    }

    @Test
    void hostileAbortFormatsTheExistingReason() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decidePreflight(
            state(1, 0, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.PreflightObservation(10, 100, 20.0F, 20.0F, null, true, 3.456D, 6.0D)
        );

        assertEquals(DescentControlPlanner.Action.FAIL_HOSTILE_NEARBY, decision.action());
        assertEquals("descent_hostile_nearby:3.46", decision.reason());
    }

    @Test
    void ironCleanupPrecedesCompletion() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.StepObservation(true, true, true, true, true, "descent_next_support_missing:0,0,0", false, false, false, false, false)
        );

        assertEquals(DescentControlPlanner.Action.RUN_IRON_CLEANUP, decision.action());
    }

    @Test
    void completionPrecedesStepSafetyChecks() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.StepObservation(false, true, true, true, true, "descent_next_support_missing:0,0,0", false, false, false, false, false)
        );

        assertEquals(DescentControlPlanner.Action.COMPLETE, decision.action());
        assertEquals("target_depth_reached", decision.reason());
    }

    @Test
    void selfSupportRefusalPrecedesOvershotAndReachedStep() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.StepObservation(false, false, true, true, true, null, false, false, false, false, false)
        );

        assertEquals(DescentControlPlanner.Action.FAIL_SELF_SUPPORT, decision.action());
        assertEquals("descent_self_support_target_refused", decision.reason());
    }

    @Test
    void overshotFailurePrecedesReachedStep() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.StepObservation(false, false, false, true, true, null, false, false, false, false, false)
        );

        assertEquals(DescentControlPlanner.Action.FAIL_OVERSHOT_STEP, decision.action());
        assertEquals("descent_overshot_step", decision.reason());
    }

    @Test
    void reachedStepAdvancesIndexDepthAndStage() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.MOVE_TO_STEP),
            new DescentControlPlanner.StepObservation(false, false, false, false, true, null, false, false, false, false, false)
        );

        assertEquals(DescentControlPlanner.Action.STEP_REACHED, decision.action());
        assertEquals(4, decision.state().stepIndex());
        assertEquals(3, decision.state().depthReached());
        assertEquals(DescentControlPlanner.Stage.BREAK_SIGHT, decision.state().stage());
    }

    @Test
    void unsafeStepRequestsRerouteWhenNotBridgeable() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.StepObservation(false, false, false, false, false, "descent_next_support_missing:0,63,0", true, true, true, false, false)
        );

        assertEquals(DescentControlPlanner.Action.REROUTE_OR_FAIL, decision.action());
        assertEquals("descent_next_support_missing:0,63,0", decision.reason());
        assertEquals(DescentControlPlanner.Stage.BREAK_SIGHT, decision.state().stage());
    }

    @Test
    void bridgeableSupportGapPlacesSupportInsteadOfRerouting() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.StepObservation(false, false, false, false, false, "descent_next_support_missing:0,63,0", true, true, true, false, true)
        );

        assertEquals(DescentControlPlanner.Action.PLACE_SUPPORT, decision.action());
        assertEquals("descent_next_support_missing:0,63,0", decision.reason());
        assertEquals(DescentControlPlanner.Stage.BREAK_SIGHT, decision.state().stage());
    }

    @Test
    void bridgeableFlagIsIgnoredForNonSupportSafetyOutcomes() {
        // Higher-priority outcomes (reached/overshot/self-support/complete) must win even if the
        // executor speculatively marked the gap bridgeable.
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.MOVE_TO_STEP),
            new DescentControlPlanner.StepObservation(false, false, false, false, true, "descent_next_support_missing:0,63,0", true, true, true, true, true)
        );

        assertEquals(DescentControlPlanner.Action.STEP_REACHED, decision.action());
    }

    @Test
    void moveStallReroutesOnlyDuringMoveStage() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.MOVE_TO_STEP),
            new DescentControlPlanner.StepObservation(false, false, false, false, false, null, true, true, true, true, false)
        );

        assertEquals(DescentControlPlanner.Action.REROUTE_OR_FAIL, decision.action());
        assertEquals("descent_move_stalled", decision.reason());
    }

    @Test
    void moveStallDoesNotSkipRequiredBreaking() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(3, 2, DescentControlPlanner.Stage.BREAK_UPPER),
            new DescentControlPlanner.StepObservation(false, false, false, false, false, null, false, false, false, true, false)
        );

        assertEquals(DescentControlPlanner.Action.BREAK_UPPER, decision.action());
    }

    @Test
    void airClearedStagesAdvanceToNextRequiredWork() {
        assertEquals(
            DescentControlPlanner.Action.BREAK_UPPER,
            DescentControlPlanner.decideStep(
                state(2, 1, DescentControlPlanner.Stage.BREAK_SIGHT),
                new DescentControlPlanner.StepObservation(false, false, false, false, false, null, true, false, false, false, false)
            ).action()
        );
        assertEquals(
            DescentControlPlanner.Action.BREAK_LOWER,
            DescentControlPlanner.decideStep(
                state(2, 1, DescentControlPlanner.Stage.BREAK_UPPER),
                new DescentControlPlanner.StepObservation(false, false, false, false, false, null, false, true, false, false, false)
            ).action()
        );
        assertEquals(
            DescentControlPlanner.Action.MOVE_TO_STEP,
            DescentControlPlanner.decideStep(
                state(2, 1, DescentControlPlanner.Stage.BREAK_LOWER),
                new DescentControlPlanner.StepObservation(false, false, false, false, false, null, false, false, true, false, false)
            ).action()
        );
    }

    @Test
    void allClearedAirCanAdvanceFromSightDirectlyToMove() {
        DescentControlPlanner.Decision decision = DescentControlPlanner.decideStep(
            state(2, 1, DescentControlPlanner.Stage.BREAK_SIGHT),
            new DescentControlPlanner.StepObservation(false, false, false, false, false, null, true, true, true, false, false)
        );

        assertEquals(DescentControlPlanner.Action.MOVE_TO_STEP, decision.action());
        assertEquals(DescentControlPlanner.Stage.MOVE_TO_STEP, decision.state().stage());
    }

    @Test
    void settleIntoStepOnlyWhenHorizontallyArrivedButStillHigh() {
        assertEquals(true, DescentControlPlanner.shouldSettleIntoStep(0.10D, 0.42D, 60.0D, 59));
        assertEquals(false, DescentControlPlanner.shouldSettleIntoStep(0.50D, 0.42D, 60.0D, 59));
        assertEquals(false, DescentControlPlanner.shouldSettleIntoStep(0.10D, 0.42D, 59.0D, 59));
    }

    @Test
    void moveYawHoldUsesAbsoluteErrorThreshold() {
        assertEquals(false, DescentControlPlanner.shouldHoldMoveForYaw(24.0D, 24.0D));
        assertEquals(true, DescentControlPlanner.shouldHoldMoveForYaw(24.1D, 24.0D));
        assertEquals(true, DescentControlPlanner.shouldHoldMoveForYaw(-24.1D, 24.0D));
    }

    private static DescentControlPlanner.State state(int stepIndex, int depthReached, DescentControlPlanner.Stage stage) {
        return new DescentControlPlanner.State(stepIndex, depthReached, stage);
    }
}
