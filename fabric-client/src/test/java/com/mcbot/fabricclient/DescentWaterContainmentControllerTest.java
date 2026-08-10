package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class DescentWaterContainmentControllerTest {
    private static final DescentWaterContainmentController.Cell FEET =
        new DescentWaterContainmentController.Cell(0, 20, 0);
    private static final DescentWaterContainmentController.Cell ANCHOR =
        new DescentWaterContainmentController.Cell(0, 21, -1);
    private static final DescentWaterContainmentController.Cell WATER =
        new DescentWaterContainmentController.Cell(0, 19, 1);

    @Test
    void drySupportWaterStartsOneFrozenSealEpisode() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        DescentWaterContainmentController.Decision started = controller.start(
            start(DescentWaterContainmentController.Trigger.SUPPORT_WATER, 3, FEET, ANCHOR, false, true, 100L)
        );

        assertEquals(DescentWaterContainmentController.Phase.SEALING, started.phase());
        assertEquals(DescentWaterContainmentController.Action.ATTEMPT_SEAL, started.action());
        assertEquals(1, controller.uniqueEpisodeCount());
        assertEquals(1, controller.sealAttemptCount());
        assertEquals(WATER, started.episode().key().waterCell());
        assertEquals(ANCHOR, started.episode().dryAnchor());
        assertEquals(100L, started.episode().startedAtMs());

        DescentWaterContainmentController.Decision active = controller.start(
            start(DescentWaterContainmentController.Trigger.POST_BREAK_BREACH, 4, FEET, ANCHOR, false, true, 200L)
        );
        assertEquals(DescentWaterContainmentController.Phase.SEALING, active.phase());
        assertEquals("episode_active", active.reason());
        assertEquals(1, controller.uniqueEpisodeCount());
    }

    @Test
    void failedSealRetreatsAndRequiresTwoStableDryPolls() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        controller.start(start(
            DescentWaterContainmentController.Trigger.POST_BREAK_BREACH,
            4,
            FEET,
            ANCHOR,
            false,
            true,
            0L
        ));

        DescentWaterContainmentController.Decision failedSeal = controller.tick(observation(
            500L, FEET, false, true, true, true, true, false, true,
            DescentWaterContainmentController.SealStatus.FAILED
        ));
        assertEquals(DescentWaterContainmentController.Phase.RETREAT_ALIGN, failedSeal.phase());
        assertEquals(DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR, failedSeal.action());

        DescentWaterContainmentController.Decision aligned = controller.tick(observation(
            600L, FEET, true, false, true, false, true, true, true,
            DescentWaterContainmentController.SealStatus.FAILED
        ));
        assertEquals(DescentWaterContainmentController.Phase.RETREATING, aligned.phase());
        assertEquals(DescentWaterContainmentController.Action.MOVE_TO_ANCHOR, aligned.action());

        DescentWaterContainmentController.Decision firstDry = controller.tick(observation(
            700L, ANCHOR, false, true, true, true, true, true, true,
            DescentWaterContainmentController.SealStatus.FAILED
        ));
        assertEquals(DescentWaterContainmentController.Phase.DRY_SETTLE, firstDry.phase());
        assertEquals(1, firstDry.stableDryPolls());
        assertEquals(DescentWaterContainmentController.Action.HOLD_DRY, firstDry.action());

        DescentWaterContainmentController.Decision recovered = controller.tick(observation(
            750L, ANCHOR, false, true, true, true, true, true, true,
            DescentWaterContainmentController.SealStatus.FAILED
        ));
        assertEquals(DescentWaterContainmentController.Phase.RECOVERED, recovered.phase());
        assertEquals(DescentWaterContainmentController.Action.RECOVERED, recovered.action());
        assertEquals(2, recovered.stableDryPolls());
    }

    @Test
    void waterDisappearanceWaitsForExactPlacementVerification() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        controller.start(start(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            3,
            FEET,
            ANCHOR,
            false,
            true,
            0L
        ));

        DescentWaterContainmentController.Decision pendingVerification =
            controller.tick(observation(
                100L,
                FEET,
                false,
                true,
                true,
                true,
                true,
                false,
                false,
                DescentWaterContainmentController.SealStatus.RUNNING
            ));
        assertEquals(
            DescentWaterContainmentController.Phase.SEALING,
            pendingVerification.phase()
        );
        assertEquals(
            DescentWaterContainmentController.Action.ATTEMPT_SEAL,
            pendingVerification.action()
        );

        DescentWaterContainmentController.Decision verified = controller.tick(observation(
            150L,
            ANCHOR,
            false,
            true,
            true,
            true,
            true,
            true,
            false,
            DescentWaterContainmentController.SealStatus.SUCCEEDED
        ));
        assertEquals(DescentWaterContainmentController.Phase.DRY_SETTLE, verified.phase());
        assertEquals(DescentWaterContainmentController.Action.HOLD_DRY, verified.action());
    }

    @Test
    void dryPostBreakProbeRequiresPollCountAndMinimumElapsedTime() {
        assertFalse(DescentWaterContainmentController.postBreakProbeComplete(1, 500L));
        assertFalse(DescentWaterContainmentController.postBreakProbeComplete(2, 299L));
        assertTrue(DescentWaterContainmentController.postBreakProbeComplete(2, 300L));
    }

    @Test
    void retreatAlignmentSneaksAtTheLipBeforeForwardJumpingToTheAnchor() {
        InputState aligning = DescentExecutor.waterContainmentRetreatInput(
            DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR
        );
        assertFalse(aligning.pressingForward());
        assertFalse(aligning.pressingBack());
        assertFalse(aligning.jumping());
        assertTrue(aligning.sneaking());

        InputState retreating = DescentExecutor.waterContainmentRetreatInput(
            DescentWaterContainmentController.Action.MOVE_TO_ANCHOR
        );
        assertTrue(retreating.pressingForward());
        assertTrue(retreating.jumping());
        assertFalse(retreating.sneaking());
    }

    @Test
    void inFlightBreakOpeningArmsDryProbeAndWaterPreemptsMovement() {
        assertEquals(
            DescentWaterContainmentController.PendingBreakObservation.INTACT,
            DescentWaterContainmentController.classifyPendingBreak(false, true, true)
        );
        assertEquals(
            DescentWaterContainmentController.PendingBreakObservation.INTACT,
            DescentWaterContainmentController.classifyPendingBreak(true, false, false)
        );
        assertEquals(
            DescentWaterContainmentController.PendingBreakObservation.OPEN_DRY,
            DescentWaterContainmentController.classifyPendingBreak(true, true, false)
        );
        assertEquals(
            DescentWaterContainmentController.PendingBreakObservation.OPEN_WATER,
            DescentWaterContainmentController.classifyPendingBreak(true, true, true)
        );
        assertEquals(
            DescentControlPlanner.Stage.BREAK_UPPER,
            DescentExecutor.resolvedPostBreakStage(
                DescentControlPlanner.Stage.BREAK_SIGHT,
                "sight",
                true
            )
        );
        assertEquals(
            DescentControlPlanner.Stage.BREAK_LOWER,
            DescentExecutor.resolvedPostBreakStage(
                DescentControlPlanner.Stage.BREAK_UPPER,
                "upper",
                true
            )
        );
        assertEquals(
            DescentControlPlanner.Stage.MOVE_TO_STEP,
            DescentExecutor.resolvedPostBreakStage(
                DescentControlPlanner.Stage.BREAK_LOWER,
                "lower",
                true
            )
        );
        assertEquals(
            DescentControlPlanner.Stage.BREAK_LOWER,
            DescentExecutor.resolvedPostBreakStage(
                DescentControlPlanner.Stage.BREAK_LOWER,
                "lower",
                false
            )
        );
        assertTrue(DescentWaterContainmentController.mustRerouteAfterRecovery(
            DescentWaterContainmentController.Trigger.POST_BREAK_BREACH,
            false,
            false,
            false
        ));
        assertFalse(DescentWaterContainmentController.mustRerouteAfterRecovery(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            false,
            false,
            false
        ));
    }

    @Test
    void alreadyWetPlayerSkipsSealAndNeverRecoversWhileSubmerged() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        DescentWaterContainmentController.Decision started = controller.start(start(
            DescentWaterContainmentController.Trigger.PLAYER_WET,
            5,
            FEET,
            ANCHOR,
            true,
            true,
            1_000L
        ));

        assertEquals(DescentWaterContainmentController.Phase.RETREAT_ALIGN, started.phase());
        assertEquals(0, controller.sealAttemptCount());

        DescentWaterContainmentController.Decision stillWet = controller.tick(observation(
            1_100L, ANCHOR, true, true, true, true, true, false, true,
            DescentWaterContainmentController.SealStatus.NOT_STARTED
        ));
        assertEquals(DescentWaterContainmentController.Phase.RETREAT_ALIGN, stillWet.phase());
        assertEquals(DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR, stillWet.action());
    }

    @Test
    void dryVerifiedAnchorWithoutASealTransitionsDirectlyToReroute() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();

        DescentWaterContainmentController.Decision started = controller.start(start(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            1,
            ANCHOR,
            ANCHOR,
            false,
            false,
            0L
        ));

        assertEquals(DescentWaterContainmentController.Phase.RECOVERED, started.phase());
        assertEquals(DescentWaterContainmentController.Action.RECOVERED, started.action());
        assertEquals("dry_anchor_reroute", started.reason());

        DescentWaterContainmentController controllerWithUnstableDetection =
            new DescentWaterContainmentController();
        DescentWaterContainmentController.Decision unstable =
            controllerWithUnstableDetection.start(
                new DescentWaterContainmentController.StartRequest(
                    DescentWaterContainmentController.Trigger.SUPPORT_WATER,
                    1,
                    WATER,
                    null,
                    ANCHOR,
                    ANCHOR,
                    false,
                    false,
                    false,
                    0L
                )
            );
        assertEquals(DescentWaterContainmentController.Phase.RETREAT_ALIGN, unstable.phase());
        assertEquals(DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR, unstable.action());
    }

    @Test
    void sealingHasFixedFourSecondLimitAndEpisodeHasFixedEightSecondLimit() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        controller.start(start(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            2,
            FEET,
            ANCHOR,
            false,
            true,
            10_000L
        ));

        DescentWaterContainmentController.Decision sealTimedOut = controller.tick(observation(
            14_000L, FEET, false, true, true, true, true, false, true,
            DescentWaterContainmentController.SealStatus.RUNNING
        ));
        assertEquals(DescentWaterContainmentController.Phase.RETREAT_ALIGN, sealTimedOut.phase());
        assertEquals("seal_unavailable", sealTimedOut.reason());

        DescentWaterContainmentController.Decision episodeTimedOut = controller.tick(observation(
            18_000L, FEET, true, false, true, false, true, true, true,
            DescentWaterContainmentController.SealStatus.RUNNING
        ));
        assertEquals(DescentWaterContainmentController.Phase.REJECTED, episodeTimedOut.phase());
        assertEquals("episode_timeout", episodeTimedOut.reason());
        assertEquals(0L, episodeTimedOut.remainingMs());
    }

    @Test
    void anchorDistanceUsesTwoHorizontalAndThreeVerticalBlockBounds() {
        assertTrue(DescentWaterContainmentController.anchorWithinBounds(
            new DescentWaterContainmentController.Cell(0, 10, 0),
            new DescentWaterContainmentController.Cell(2, 13, 0)
        ));
        assertFalse(DescentWaterContainmentController.anchorWithinBounds(
            new DescentWaterContainmentController.Cell(0, 10, 0),
            new DescentWaterContainmentController.Cell(2, 13, 1)
        ));
        assertFalse(DescentWaterContainmentController.anchorWithinBounds(
            new DescentWaterContainmentController.Cell(0, 10, 0),
            new DescentWaterContainmentController.Cell(0, 14, 0)
        ));

        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        DescentWaterContainmentController.Decision rejected = controller.start(start(
            DescentWaterContainmentController.Trigger.PLAYER_WET,
            1,
            new DescentWaterContainmentController.Cell(0, 10, 0),
            new DescentWaterContainmentController.Cell(3, 10, 0),
            true,
            false,
            0L
        ));
        assertEquals(DescentWaterContainmentController.Phase.REJECTED, rejected.phase());
        assertEquals("anchor_out_of_bounds", rejected.reason());
    }

    @Test
    void duplicateAndFifthUniqueEpisodesRejectWithoutAnotherSeal() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        DescentWaterContainmentController.StartRequest firstRequest = start(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            0,
            FEET,
            ANCHOR,
            false,
            true,
            0L
        );
        assertEquals(
            DescentWaterContainmentController.Phase.SEALING,
            controller.start(firstRequest).phase()
        );
        controller.resetEpisode();
        DescentWaterContainmentController.Decision duplicate = controller.start(firstRequest);
        assertEquals("episode_duplicate", duplicate.reason());
        assertEquals(1, controller.uniqueEpisodeCount());
        assertEquals(1, controller.sealAttemptCount());
        controller.resetEpisode();

        for (int i = 1; i < DescentWaterContainmentController.MAX_UNIQUE_EPISODES; i++) {
            DescentWaterContainmentController.Cell water =
                new DescentWaterContainmentController.Cell(i, 19, 1);
            DescentWaterContainmentController.Decision started = controller.start(new DescentWaterContainmentController.StartRequest(
                DescentWaterContainmentController.Trigger.SUPPORT_WATER,
                i,
                water,
                null,
                FEET,
                ANCHOR,
                false,
                true,
                true,
                i * 100L
            ));
            assertEquals(DescentWaterContainmentController.Phase.SEALING, started.phase());
            controller.resetEpisode();
        }
        assertEquals(4, controller.uniqueEpisodeCount());
        assertEquals(4, controller.sealAttemptCount());

        DescentWaterContainmentController.Decision fifth = controller.start(new DescentWaterContainmentController.StartRequest(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            99,
            new DescentWaterContainmentController.Cell(9, 19, 1),
            null,
            FEET,
            ANCHOR,
            false,
            true,
            true,
            1_000L
        ));
        assertEquals("episode_limit", fifth.reason());
        assertEquals(4, controller.uniqueEpisodeCount());
        assertEquals(4, controller.sealAttemptCount());

        controller.clear();
        DescentWaterContainmentController.Decision fresh = controller.start(start(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            0,
            FEET,
            ANCHOR,
            false,
            true,
            2_000L
        ));
        assertEquals(DescentWaterContainmentController.Phase.SEALING, fresh.phase());
        assertEquals(1, controller.uniqueEpisodeCount());
    }

    @Test
    void onePhysicalStepWaterSignatureCannotSealAgainUnderAnotherTrigger() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        controller.start(start(
            DescentWaterContainmentController.Trigger.POST_BREAK_BREACH,
            3,
            FEET,
            ANCHOR,
            false,
            true,
            0L
        ));
        controller.resetEpisode();

        DescentWaterContainmentController.Decision second = controller.start(start(
            DescentWaterContainmentController.Trigger.SUPPORT_WATER,
            3,
            FEET,
            ANCHOR,
            false,
            true,
            100L
        ));

        assertEquals(DescentWaterContainmentController.Phase.RETREAT_ALIGN, second.phase());
        assertEquals(DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR, second.action());
        assertEquals(1, controller.sealAttemptCount());
    }

    @Test
    void invalidAnchorDuringRecoveryFailsClosed() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        controller.start(start(
            DescentWaterContainmentController.Trigger.PLAYER_WET,
            1,
            FEET,
            ANCHOR,
            true,
            false,
            0L
        ));

        DescentWaterContainmentController.Decision rejected = controller.tick(observation(
            100L, FEET, true, false, true, false, false, true, true,
            DescentWaterContainmentController.SealStatus.NOT_STARTED
        ));
        assertEquals(DescentWaterContainmentController.Phase.REJECTED, rejected.phase());
        assertEquals("anchor_invalid", rejected.reason());
    }

    @Test
    void excessiveDriftDuringRecoveryFailsClosed() {
        DescentWaterContainmentController controller = new DescentWaterContainmentController();
        controller.start(start(
            DescentWaterContainmentController.Trigger.PLAYER_WET,
            1,
            FEET,
            ANCHOR,
            true,
            false,
            0L
        ));

        DescentWaterContainmentController.Decision rejected = controller.tick(observation(
            100L,
            new DescentWaterContainmentController.Cell(3, 21, -1),
            true,
            false,
            true,
            false,
            true,
            true,
            true,
            DescentWaterContainmentController.SealStatus.NOT_STARTED
        ));
        assertEquals(DescentWaterContainmentController.Phase.REJECTED, rejected.phase());
        assertEquals("anchor_out_of_bounds", rejected.reason());
    }

    private static DescentWaterContainmentController.StartRequest start(
        DescentWaterContainmentController.Trigger trigger,
        int stepIndex,
        DescentWaterContainmentController.Cell detectedFeet,
        DescentWaterContainmentController.Cell anchor,
        boolean playerWet,
        boolean sealEligible,
        long nowMs
    ) {
        return new DescentWaterContainmentController.StartRequest(
            trigger,
            stepIndex,
            WATER,
            trigger == DescentWaterContainmentController.Trigger.POST_BREAK_BREACH
                ? new DescentWaterContainmentController.Cell(0, 20, 1)
                : null,
            detectedFeet,
            anchor,
            playerWet,
            !playerWet,
            sealEligible,
            nowMs
        );
    }

    private static DescentWaterContainmentController.Observation observation(
        long nowMs,
        DescentWaterContainmentController.Cell playerFeet,
        boolean touchingWater,
        boolean grounded,
        boolean bodyClear,
        boolean supportStable,
        boolean anchorValid,
        boolean aligned,
        boolean waterPresent,
        DescentWaterContainmentController.SealStatus sealStatus
    ) {
        return new DescentWaterContainmentController.Observation(
            nowMs,
            playerFeet,
            touchingWater,
            grounded,
            bodyClear,
            supportStable,
            anchorValid,
            aligned,
            waterPresent,
            sealStatus
        );
    }
}
