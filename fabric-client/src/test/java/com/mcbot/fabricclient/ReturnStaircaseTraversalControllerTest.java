package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class ReturnStaircaseTraversalControllerTest {
    @Test
    void advancesOnlyAfterTwoSafePollsAndCompletesExactlyOnce() {
        List<VoxelCell> route = line(3);
        ReturnStaircaseTraversalController controller = controller(route, 0L, 30_000L);

        ReturnStaircaseTraversalController.Step first = safeTick(controller, route.get(1), 100L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD, first.outcome());
        assertEquals("arrival_confirming", first.reason());
        assertEquals(1, first.safeArrivalPolls());
        assertEquals(1, first.waypointIndex());

        ReturnStaircaseTraversalController.Step advanced = safeTick(controller, route.get(1), 150L);
        assertTrue(advanced.waypointAdvanced());
        assertEquals(2, advanced.waypointIndex());
        assertEquals(route.get(2), advanced.waypoint());
        assertTrue(advanced.stopped());

        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD,
            safeTick(controller, route.get(2), 200L).outcome());
        ReturnStaircaseTraversalController.Step arrived = safeTick(controller, route.get(2), 250L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.ARRIVED, arrived.outcome());
        assertEquals("route_exhausted_at_destination", arrived.reason());
        assertEquals(2, arrived.maximumWaypointIndex());
        assertFalse(controller.active());
        assertEquals(ReturnStaircaseTraversalController.Outcome.IDLE,
            safeTick(controller, route.get(2), 300L).outcome());
    }

    @Test
    void singletonRouteExhaustionUsesTwoPollsAndSignalsOneArrival() {
        VoxelCell cell = new VoxelCell(4, 63, -2);
        ReturnStaircaseTraversalController controller = controller(List.of(cell), 10L, 10_000L);

        ReturnStaircaseTraversalController.Step first = safeTick(controller, cell, 20L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD, first.outcome());
        assertEquals("route_exhausted_confirming", first.reason());
        assertEquals(ReturnStaircaseTraversalController.Outcome.ARRIVED,
            safeTick(controller, cell, 30L).outcome());
        assertEquals(ReturnStaircaseTraversalController.Outcome.IDLE,
            safeTick(controller, cell, 40L).outcome());
    }

    @Test
    void forwardResynchronizationIsBoundedToEightCellsAndNeverRegresses() {
        List<VoxelCell> route = line(12);
        ReturnStaircaseTraversalController controller = controller(route, 0L, 30_000L);

        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD,
            safeTick(controller, route.get(8), 100L).outcome());
        ReturnStaircaseTraversalController.Step resynced = safeTick(controller, route.get(8), 150L);
        assertTrue(resynced.forwardResynchronized());
        assertEquals(9, resynced.waypointIndex());
        assertEquals(8, resynced.maximumWaypointIndex());

        ReturnStaircaseTraversalController.Step earlier = safeTick(controller, route.get(2), 500L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED, earlier.outcome());
        assertEquals("route_deviation", earlier.reason());
        assertTrue(earlier.stopped());
        assertEquals(9, earlier.waypointIndex());
        assertEquals(route.get(8), earlier.stableFeet());
        assertEquals(8, earlier.maximumWaypointIndex());
        assertFalse(earlier.waypointAdvanced());
        assertFalse(controller.active());

        ReturnStaircaseTraversalController tooFar = controller(route, 0L, 30_000L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            safeTick(tooFar, route.get(9), 100L).outcome());
        assertEquals("route_deviation", tooFarStepReason(route, 9));
    }

    @Test
    void immediatePredecessorRegressionFailsClosedWithoutDrivingNonadjacentEdge() {
        List<VoxelCell> route = line(4);
        ReturnStaircaseTraversalController controller = controller(route, 0L, 30_000L);

        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD,
            safeTick(controller, route.get(1), 100L).outcome());
        ReturnStaircaseTraversalController.Step advanced = safeTick(
            controller, route.get(1), 150L);
        assertEquals(2, advanced.waypointIndex());
        assertEquals(route.get(1), advanced.stableFeet());

        ReturnStaircaseTraversalController.Step regressed = safeTick(
            controller, route.get(0), 200L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            regressed.outcome());
        assertEquals("route_deviation", regressed.reason());
        assertTrue(regressed.stopped());
        assertEquals(route.get(2), regressed.waypoint());
        assertEquals(route.get(1), regressed.stableFeet());
        assertEquals(2, regressed.waypointIndex());
        assertEquals(1, regressed.maximumWaypointIndex());
        assertFalse(regressed.waypointAdvanced());
        assertFalse(regressed.forwardResynchronized());
        assertFalse(controller.active());
    }

    @Test
    void groundedAlongEdgeProgressRefreshesAtPointZeroFiveOnly() {
        List<VoxelCell> route = line(2);
        ReturnStaircaseTraversalController controller = controller(route, 0L, 20_000L);

        ReturnStaircaseTraversalController.Step subThreshold = tick(
            controller,
            observation(route.get(0), 0.54D, 16.0D, 0.5D, true, true, true, true),
            1_000L
        );
        assertFalse(subThreshold.preciseProgress());
        assertEquals(1_000L, subThreshold.lastProgressAgeMs());

        ReturnStaircaseTraversalController.Step earned = tick(
            controller,
            observation(route.get(0), 0.55D, 19.0D, 0.9D, true, true, true, true),
            1_100L
        );
        assertTrue(earned.preciseProgress());
        assertEquals(0L, earned.lastProgressAgeMs());

        ReturnStaircaseTraversalController.Step lateral = tick(
            controller,
            observation(route.get(0), 0.55D, 16.0D, 1.4D, true, true, true, true),
            2_000L
        );
        assertFalse(lateral.preciseProgress());

        ReturnStaircaseTraversalController.Step backward = tick(
            controller,
            observation(route.get(0), 0.1D, 16.0D, 0.5D, true, true, true, true),
            3_000L
        );
        assertFalse(backward.preciseProgress());

        ReturnStaircaseTraversalController.Step airborne = tick(
            controller,
            observation(route.get(0), 0.9D, 18.0D, 0.5D, false, true, true, true),
            4_000L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD, airborne.outcome());
        assertEquals(2_900L, airborne.lastProgressAgeMs());

        ReturnStaircaseTraversalController.Step stalled = tick(
            controller,
            observation(route.get(0), 0.55D, 16.0D, 0.5D, true, true, true, true),
            5_100L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED, stalled.outcome());
        assertEquals("waypoint_stalled", stalled.reason());
    }

    @Test
    void exactStallBoundaryRequestsOneHandoffAndDoesNotRestart() {
        List<VoxelCell> route = line(2);
        ReturnStaircaseTraversalController controller = controller(route, 0L, 20_000L);

        assertEquals(ReturnStaircaseTraversalController.Outcome.DRIVE,
            safeTick(controller, route.get(0), 3_999L).outcome());
        ReturnStaircaseTraversalController.Step handoff = safeTick(controller, route.get(0), 4_000L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED, handoff.outcome());
        assertTrue(controller.handoffIssued());
        assertFalse(controller.active());
        assertEquals(ReturnStaircaseTraversalController.Outcome.IDLE,
            safeTick(controller, route.get(0), 4_001L).outcome());
        assertFalse(controller.begin(route, route.get(0), 5_000L, 10_000L));

        controller.clear();
        assertTrue(controller.begin(route, route.get(0), 5_000L, 10_000L));
    }

    @Test
    void fixedHardDeadlineCannotBeExtendedByPhysicalProgress() {
        List<VoxelCell> route = line(3);
        ReturnStaircaseTraversalController controller = controller(route, 1_000L, 5_000L);
        tick(controller,
            observation(route.get(0), 0.8D, 16.0D, 0.5D, true, true, true, true),
            4_900L);
        ReturnStaircaseTraversalController.Step expired = safeTick(controller, route.get(0), 5_000L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.REJECTED, expired.outcome());
        assertEquals("hard_deadline", expired.reason());
        assertFalse(controller.active());
    }

    @Test
    void invalidWaypointAndOffRouteCellFailToOneBoundedHandoff() {
        List<VoxelCell> route = line(3);
        ReturnStaircaseTraversalController invalid = controller(route, 0L, 20_000L);
        ReturnStaircaseTraversalController.Step invalidated = invalid.tick(
            safeObservation(route.get(0), true),
            cell -> !cell.equals(route.get(1)),
            100L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            invalidated.outcome());
        assertEquals("route_invalidated", invalidated.reason());

        ReturnStaircaseTraversalController deviated = controller(route, 0L, 20_000L);
        ReturnStaircaseTraversalController.Step offRoute = safeTick(
            deviated,
            new VoxelCell(0, 16, 1),
            100L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            offRoute.outcome());
        assertEquals("route_deviation", offRoute.reason());
    }

    @Test
    void stepUpCommitsOneBoundedJumpAndRequiresStableLanding() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0),
            new VoxelCell(2, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 20_000L);

        ReturnStaircaseTraversalController.Step selected = tick(
            controller, safeObservation(route.get(0), false), 100L);
        assertEquals(ReturnStaircaseTraversalController.TransitionKind.STEP_UP,
            selected.transitionKind());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.SELECTED,
            selected.transitionPhase());
        assertTrue(selected.stopped());

        ReturnStaircaseTraversalController.Step aligning = tick(
            controller, safeObservation(route.get(0), false), 200L);
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.ALIGNING,
            aligning.transitionPhase());
        assertTrue(aligning.stopped());

        ReturnStaircaseTraversalController.Step launching = tick(
            controller, safeObservation(route.get(0), true), 300L);
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LAUNCHING,
            launching.transitionPhase());
        assertTrue(launching.forward());
        assertTrue(launching.jump());
        assertTrue(launching.transitionStarted());
        assertFalse(launching.descentExempt());

        assertTrue(tick(controller, safeObservation(route.get(0), true), 449L).jump());
        assertFalse(tick(controller, safeObservation(route.get(0), true), 450L).jump());

        ReturnStaircaseTraversalController.Step airborne = tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D, false, true, true, true),
            500L
        );
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.AIRBORNE,
            airborne.transitionPhase());
        assertTrue(airborne.forward());
        assertFalse(airborne.jump());
        assertFalse(airborne.descentExempt());

        ReturnStaircaseTraversalController.Step landed = tick(
            controller, safeObservation(route.get(1), true), 600L);
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LANDED,
            landed.transitionPhase());
        assertTrue(landed.transitionLanded());
        assertTrue(landed.stopped());
        assertFalse(landed.waypointAdvanced());

        ReturnStaircaseTraversalController.Step confirmed = tick(
            controller, safeObservation(route.get(1), true), 650L);
        assertTrue(confirmed.waypointAdvanced());
        assertEquals(2, confirmed.waypointIndex());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LANDED,
            confirmed.transitionPhase());
    }

    @Test
    void stepUpAllowsOneGroundedOriginPollBeforeMomentumReachesLanding() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        ReturnStaircaseTraversalController.Step airborne = tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D, false, true, true, true),
            300L
        );
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.AIRBORNE,
            airborne.transitionPhase());

        VoxelCell elevatedOriginColumn = new VoxelCell(0, 16, 0);
        ReturnStaircaseTraversalController.Step settling = tick(
            controller,
            observation(elevatedOriginColumn, 0.5D, 16.0D, 0.5D,
                true, true, false, true, true),
            350L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.DRIVE, settling.outcome());
        assertEquals("step_up_settling", settling.reason());
        assertTrue(settling.forward());
        assertFalse(settling.jump());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.AIRBORNE,
            settling.transitionPhase());

        ReturnStaircaseTraversalController.Step landed = tick(
            controller, safeObservation(route.get(1), true), 400L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD, landed.outcome());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LANDED,
            landed.transitionPhase());
        assertEquals(1, landed.safeArrivalPolls());

        ReturnStaircaseTraversalController.Step arrived = tick(
            controller, safeObservation(route.get(1), true), 450L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.ARRIVED, arrived.outcome());
        assertTrue(arrived.waypointAdvanced());
    }

    @Test
    void stepUpAllowsOneBoundedRelaunchAfterReturningToTheExactSafeOrigin() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        ReturnStaircaseTraversalController.Step firstLaunch = tick(
            controller, safeObservation(route.get(0), true), 200L);
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LAUNCHING,
            firstLaunch.transitionPhase());

        ReturnStaircaseTraversalController.Step firstAirborne = tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D,
                false, true, true, true, false),
            250L
        );
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.AIRBORNE,
            firstAirborne.transitionPhase());

        ReturnStaircaseTraversalController.Step relaunchSelected = tick(
            controller, safeObservation(route.get(0), true), 300L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD,
            relaunchSelected.outcome());
        assertEquals("step_up_relaunch_selected", relaunchSelected.reason());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.SELECTED,
            relaunchSelected.transitionPhase());
        assertFalse(relaunchSelected.waypointAdvanced());

        ReturnStaircaseTraversalController.Step secondLaunch = tick(
            controller, safeObservation(route.get(0), true), 350L);
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LAUNCHING,
            secondLaunch.transitionPhase());
        assertTrue(secondLaunch.forward());
        assertTrue(secondLaunch.jump());

        tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D,
                false, true, true, true, false),
            400L
        );

        ReturnStaircaseTraversalController.Step landed = tick(
            controller, safeObservation(route.get(1), true), 450L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD, landed.outcome());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LANDED,
            landed.transitionPhase());

        ReturnStaircaseTraversalController.Step arrived = tick(
            controller, safeObservation(route.get(1), true), 500L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.ARRIVED, arrived.outcome());
        assertTrue(arrived.waypointAdvanced());
    }

    @Test
    void stepUpRejectsASecondAbortiveHopAtTheOrigin() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        tick(controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D,
                false, true, true, true, false), 250L);
        tick(controller, safeObservation(route.get(0), true), 300L);
        tick(controller, safeObservation(route.get(0), true), 350L);
        tick(controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D,
                false, true, true, true, false), 400L);

        ReturnStaircaseTraversalController.Step missed = tick(
            controller, safeObservation(route.get(0), true), 450L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            missed.outcome());
        assertEquals("step_up_missed", missed.reason());
        assertTrue(missed.stopped());
    }

    @Test
    void stepUpRelaunchDoesNotResetTheOriginalTransitionDeadline() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        tick(controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D,
                false, true, true, true, false), 250L);
        tick(controller, safeObservation(route.get(0), true), 300L);

        ReturnStaircaseTraversalController.Step timedOut = tick(
            controller, safeObservation(route.get(0), true), 3_100L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            timedOut.outcome());
        assertEquals("step_up_timeout", timedOut.reason());
        assertTrue(timedOut.stopped());
    }

    @Test
    void stepUpKeepsSettlingAtTheElevatedOriginUntilTheFixedDeadline() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D, false, true, true, true),
            300L
        );

        VoxelCell elevatedOriginColumn = new VoxelCell(0, 16, 0);
        ReturnStaircaseTraversalController.Step firstPoll = tick(
            controller,
            observation(elevatedOriginColumn, 0.5D, 16.0D, 0.5D,
                true, true, false, true, true),
            350L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.DRIVE, firstPoll.outcome());
        assertEquals("step_up_settling", firstPoll.reason());
        assertTrue(firstPoll.forward());
        assertFalse(firstPoll.jump());

        ReturnStaircaseTraversalController.Step stillSettling = tick(
            controller,
            observation(elevatedOriginColumn, 0.6D, 16.0D, 0.5D,
                true, true, false, true, true),
            400L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.DRIVE,
            stillSettling.outcome());
        assertEquals("step_up_settling", stillSettling.reason());

        ReturnStaircaseTraversalController.Step missed = tick(
            controller,
            observation(elevatedOriginColumn, 0.6D, 16.0D, 0.5D,
                true, true, false, true, true),
            3_101L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            missed.outcome());
        assertEquals("step_up_timeout", missed.reason());
        assertTrue(missed.stopped());
        assertFalse(controller.active());
    }

    @Test
    void stepUpRejectsAStableElevatedOriginInsteadOfTreatingItAsALipTransient() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D, false, true, true, true),
            300L
        );

        ReturnStaircaseTraversalController.Step missed = tick(
            controller,
            safeObservation(new VoxelCell(0, 16, 0), true),
            350L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            missed.outcome());
        assertEquals("step_up_missed", missed.reason());
        assertTrue(missed.stopped());
    }

    @Test
    void stepUpRejectsAnUnsafeUnstableElevatedOrigin() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D, false, true, true, true),
            300L
        );

        ReturnStaircaseTraversalController.Step missed = tick(
            controller,
            observation(new VoxelCell(0, 16, 0), 0.5D, 16.0D, 0.5D,
                true, true, false, true, false),
            350L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            missed.outcome());
        assertEquals("step_up_missed", missed.reason());
        assertTrue(missed.stopped());
    }

    @Test
    void stepUpRejectsAFirstGroundedLateralOffTargetLanding() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        tick(
            controller,
            observation(route.get(0), 0.8D, 15.4D, 0.5D, false, true, true, true),
            300L
        );

        ReturnStaircaseTraversalController.Step missed = tick(
            controller, safeObservation(new VoxelCell(0, 16, 1), true), 350L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            missed.outcome());
        assertEquals("step_up_missed", missed.reason());
        assertTrue(missed.stopped());
    }

    @Test
    void oneBlockDescentExemptionExistsOnlyDuringLaunchAndAirborne() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0),
            new VoxelCell(2, 15, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 20_000L);

        ReturnStaircaseTraversalController.Step selected = tick(
            controller, safeObservation(route.get(0), false), 100L);
        assertEquals(ReturnStaircaseTraversalController.TransitionKind.DESCENT,
            selected.transitionKind());
        assertFalse(selected.descentExempt());

        ReturnStaircaseTraversalController.Step aligning = tick(
            controller, safeObservation(route.get(0), false), 200L);
        assertFalse(aligning.descentExempt());

        ReturnStaircaseTraversalController.Step launching = tick(
            controller, safeObservation(route.get(0), true), 300L);
        assertTrue(launching.forward());
        assertFalse(launching.jump());
        assertTrue(launching.descentExempt());

        ReturnStaircaseTraversalController.Step airborne = tick(
            controller,
            observation(route.get(0), 0.9D, 15.5D, 0.5D, false, true, true, true),
            400L
        );
        assertTrue(airborne.descentExempt());

        ReturnStaircaseTraversalController.Step landed = tick(
            controller, safeObservation(route.get(1), true), 500L);
        assertFalse(landed.descentExempt());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LANDED,
            landed.transitionPhase());
        ReturnStaircaseTraversalController.Step confirmed = tick(
            controller, safeObservation(route.get(1), true), 550L);
        assertTrue(confirmed.transitionLanded());
        assertFalse(confirmed.descentExempt());
    }

    @Test
    void descentStillRejectsFirstGroundedOffTargetPollAfterDeparture() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);

        tick(controller, safeObservation(route.get(0), true), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);
        ReturnStaircaseTraversalController.Step airborne = tick(
            controller,
            observation(route.get(0), 0.8D, 15.5D, 0.5D, false, true, true, true),
            300L
        );
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.AIRBORNE,
            airborne.transitionPhase());

        ReturnStaircaseTraversalController.Step missed = tick(
            controller, safeObservation(route.get(0), true), 350L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            missed.outcome());
        assertEquals("descent_missed", missed.reason());
        assertTrue(missed.stopped());
    }

    @Test
    void groundedStepDownCanLandWithoutAnObservedAirborneTick() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 0L, 10_000L);
        tick(controller, safeObservation(route.get(0), false), 100L);
        tick(controller, safeObservation(route.get(0), true), 200L);

        ReturnStaircaseTraversalController.Step firstLanding = tick(
            controller, safeObservation(route.get(1), true), 300L);
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.LANDED,
            firstLanding.transitionPhase());
        ReturnStaircaseTraversalController.Step arrived = tick(
            controller, safeObservation(route.get(1), true), 350L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.ARRIVED, arrived.outcome());
    }

    @Test
    void transitionMissTimeoutAndUnsafeLandingFailClosed() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController missed = controller(route, 0L, 20_000L);
        tick(missed, safeObservation(route.get(0), true), 100L);
        tick(missed, safeObservation(route.get(0), true), 200L);
        ReturnStaircaseTraversalController.Step offTarget = tick(
            missed, safeObservation(new VoxelCell(0, 15, 1), true), 300L);
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            offTarget.outcome());
        assertEquals("step_up_missed", offTarget.reason());

        ReturnStaircaseTraversalController timedOut = controller(route, 0L, 20_000L);
        tick(timedOut, safeObservation(route.get(0), false), 100L);
        ReturnStaircaseTraversalController.Step timeout = tick(
            timedOut, safeObservation(route.get(0), false), 3_100L);
        assertEquals("step_up_timeout", timeout.reason());

        ReturnStaircaseTraversalController unstable = controller(route, 0L, 20_000L);
        tick(unstable, safeObservation(route.get(0), true), 100L);
        tick(unstable, safeObservation(route.get(0), true), 200L);
        ReturnStaircaseTraversalController.Step unsafe = tick(
            unstable,
            ReturnStaircaseTraversalController.Observation.centered(
                route.get(1), true, true, false, true),
            300L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED,
            unsafe.outcome());
    }

    @Test
    void unsafeArrivalCannotEarnACursorAdvance() {
        List<VoxelCell> route = line(2);
        ReturnStaircaseTraversalController controller = controller(route, 0L, 20_000L);

        assertEquals(ReturnStaircaseTraversalController.Outcome.HOLD,
            safeTick(controller, route.get(1), 100L).outcome());
        ReturnStaircaseTraversalController.Step wet = tick(
            controller,
            ReturnStaircaseTraversalController.Observation.centered(
                route.get(1), true, false, true, true),
            150L
        );
        assertEquals(ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED, wet.outcome());
        assertEquals(1, wet.waypointIndex());
        assertFalse(wet.waypointAdvanced());
    }

    @Test
    void suffixReplacementPreservesMonotonicLivenessStateAndClearsTargetLatches() {
        List<VoxelCell> route = line(5);
        ReturnStaircaseTraversalController controller = controller(route, 1_000L, 10_000L);
        safeTick(controller, route.get(1), 1_100L);
        safeTick(controller, route.get(1), 1_150L);

        ReturnStaircaseTraversalController.Step precise = tick(
            controller,
            observation(route.get(1), 1.60D, 16.0D, 0.50D, true, true, true, true),
            1_180L
        );
        assertTrue(precise.preciseProgress());
        ReturnStaircaseTraversalController.Step oldArrival = safeTick(controller, route.get(2), 1_200L);
        assertEquals(1, oldArrival.safeArrivalPolls());

        ReturnStaircaseTraversalController.RouteSnapshot before = controller.routeSnapshot();
        List<VoxelCell> replacement = List.of(
            route.get(0),
            route.get(1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(2, 16, 1),
            new VoxelCell(3, 16, 1),
            route.get(3),
            route.get(4)
        );
        assertTrue(controller.routeSuffixRepairEligible(before, 1_200L));
        assertTrue(controller.canReplaceRoute(before, replacement));
        assertTrue(controller.replaceRoute(before, replacement));

        ReturnStaircaseTraversalController.RouteSnapshot after = controller.routeSnapshot();
        assertEquals(replacement, after.route());
        assertEquals(before.waypointIndex(), after.waypointIndex());
        assertEquals(before.maximumWaypointIndex(), after.maximumWaypointIndex());
        assertEquals(before.stableFeet(), after.stableFeet());
        assertEquals(before.startedAtMs(), after.startedAtMs());
        assertEquals(before.deadlineAtMs(), after.deadlineAtMs());
        assertEquals(before.lastProgressAtMs(), after.lastProgressAtMs());
        assertEquals(replacement.get(2), after.activeWaypoint());
        assertEquals(ReturnStaircaseTraversalController.TransitionKind.NONE,
            after.transitionKind());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.NONE,
            after.transitionPhase());

        ReturnStaircaseTraversalController.Step newArrival = safeTick(
            controller, replacement.get(2), 1_250L);
        assertEquals(1, newArrival.safeArrivalPolls());
        assertEquals(2, controller.waypointIndex());

        ReturnStaircaseTraversalController.Step resetBaseline = tick(
            controller,
            observation(route.get(1), 1.50D, 16.0D, 0.60D, true, true, true, true),
            1_300L
        );
        assertTrue(resetBaseline.preciseProgress());
        assertEquals(2, controller.waypointIndex());
    }

    @Test
    void suffixReplacementRequiresExactSnapshotConsumedPrefixAndDestination() {
        List<VoxelCell> route = line(5);
        ReturnStaircaseTraversalController controller = controller(route, 100L, 10_000L);
        ReturnStaircaseTraversalController.RouteSnapshot snapshot = controller.routeSnapshot();
        List<VoxelCell> validReplacement = List.of(
            route.get(0),
            new VoxelCell(0, 16, 1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(2, 16, 1),
            new VoxelCell(3, 16, 1),
            route.get(3),
            route.get(4)
        );
        assertTrue(controller.canReplaceRoute(snapshot, validReplacement));

        List<VoxelCell> changedPrefix = new ArrayList<>(validReplacement);
        changedPrefix.set(0, new VoxelCell(-1, 16, 0));
        assertFalse(controller.canReplaceRoute(snapshot, changedPrefix));

        List<VoxelCell> changedDestination = new ArrayList<>(validReplacement);
        changedDestination.set(changedDestination.size() - 1, new VoxelCell(4, 16, 1));
        assertFalse(controller.canReplaceRoute(snapshot, changedDestination));

        List<VoxelCell> irreversible = new ArrayList<>(validReplacement);
        irreversible.set(1, new VoxelCell(0, 18, 1));
        assertFalse(controller.canReplaceRoute(snapshot, irreversible));

        safeTick(controller, route.get(1), 200L);
        safeTick(controller, route.get(1), 250L);
        assertFalse(controller.canReplaceRoute(snapshot, validReplacement));
        assertEquals(route, controller.route());
    }

    @Test
    void suffixRepairEligibilityIsBoundedByTransitionDestinationAndLivenessClocks() {
        List<VoxelCell> route = line(4);
        ReturnStaircaseTraversalController eligible = controller(route, 0L, 10_000L);
        assertTrue(eligible.routeSuffixRepairEligible(eligible.routeSnapshot(), 3_999L));
        assertFalse(eligible.routeSuffixRepairEligible(eligible.routeSnapshot(), 4_000L));

        ReturnStaircaseTraversalController expired = controller(route, 0L, 3_000L);
        assertFalse(expired.routeSuffixRepairEligible(expired.routeSnapshot(), 3_000L));

        ReturnStaircaseTraversalController atDestination = controller(route, 0L, 10_000L);
        safeTick(atDestination, route.get(1), 100L);
        safeTick(atDestination, route.get(1), 150L);
        safeTick(atDestination, route.get(2), 200L);
        safeTick(atDestination, route.get(2), 250L);
        assertEquals(route.size() - 1, atDestination.waypointIndex());
        assertFalse(atDestination.routeSuffixRepairEligible(
            atDestination.routeSnapshot(), 300L));

        List<VoxelCell> stepRoute = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 17, 0),
            new VoxelCell(2, 17, 0)
        );
        ReturnStaircaseTraversalController transitioning = controller(stepRoute, 0L, 10_000L);
        tick(transitioning, safeObservation(stepRoute.get(0), true), 100L);
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.SELECTED,
            transitioning.transitionPhase());
        assertFalse(transitioning.routeSuffixRepairEligible(
            transitioning.routeSnapshot(), 100L));
    }

    @Test
    void beginValidatesFrozenRouteStartDeadlineAndReversibility() {
        ReturnStaircaseTraversalController controller = new ReturnStaircaseTraversalController();
        VoxelCell start = new VoxelCell(0, 16, 0);
        assertFalse(controller.begin(List.of(), start, 0L, 10L));
        assertFalse(controller.begin(line(2), new VoxelCell(1, 16, 0), 0L, 10L));
        assertFalse(controller.begin(line(2), start, 10L, 10L));
        assertFalse(controller.begin(
            List.of(start, new VoxelCell(2, 16, 0)), start, 0L, 10L));

        List<VoxelCell> mutable = new ArrayList<>(line(2));
        assertTrue(controller.begin(mutable, start, 0L, 10_000L));
        mutable.set(1, new VoxelCell(9, 16, 0));
        assertEquals(new VoxelCell(1, 16, 0), controller.activeWaypoint());
    }

    @Test
    void lifecycleClearReleasesAllRouteAndTransitionState() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        ReturnStaircaseTraversalController controller = controller(route, 1_000L, 10_000L);
        tick(controller, safeObservation(route.get(0), true), 1_100L);
        assertEquals(ReturnStaircaseTraversalController.TransitionKind.STEP_UP,
            controller.transitionKind());

        controller.clear();
        assertFalse(controller.active());
        assertFalse(controller.handoffIssued());
        assertEquals(List.of(), controller.route());
        assertEquals(-1, controller.waypointIndex());
        assertEquals(ReturnStaircaseTraversalController.TransitionKind.NONE,
            controller.transitionKind());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.NONE,
            controller.transitionPhase());
        assertEquals(0L, controller.remainingDeadlineMs(2_000L));
        assertEquals(ReturnStaircaseTraversalController.Outcome.IDLE,
            safeTick(controller, route.get(0), 2_000L).outcome());
    }

    private static String tooFarStepReason(List<VoxelCell> route, int index) {
        ReturnStaircaseTraversalController controller = controller(route, 0L, 30_000L);
        return safeTick(controller, route.get(index), 100L).reason();
    }

    private static ReturnStaircaseTraversalController controller(
        List<VoxelCell> route,
        long nowMs,
        long hardDeadlineAtMs
    ) {
        ReturnStaircaseTraversalController controller = new ReturnStaircaseTraversalController();
        assertTrue(controller.begin(route, route.get(0), nowMs, hardDeadlineAtMs));
        return controller;
    }

    private static ReturnStaircaseTraversalController.Step safeTick(
        ReturnStaircaseTraversalController controller,
        VoxelCell feet,
        long nowMs
    ) {
        return tick(controller, safeObservation(feet, true), nowMs);
    }

    private static ReturnStaircaseTraversalController.Step tick(
        ReturnStaircaseTraversalController controller,
        ReturnStaircaseTraversalController.Observation observation,
        long nowMs
    ) {
        return controller.tick(observation, cell -> true, nowMs);
    }

    private static ReturnStaircaseTraversalController.Observation safeObservation(
        VoxelCell feet,
        boolean aligned
    ) {
        return ReturnStaircaseTraversalController.Observation.centered(
            feet, true, true, true, aligned);
    }

    private static ReturnStaircaseTraversalController.Observation observation(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean onGround,
        boolean dry,
        boolean stable,
        boolean aligned
    ) {
        return new ReturnStaircaseTraversalController.Observation(
            feet, x, y, z, onGround, dry, stable, aligned);
    }

    private static ReturnStaircaseTraversalController.Observation observation(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean onGround,
        boolean dry,
        boolean stable,
        boolean aligned,
        boolean lipTransientSafe
    ) {
        return new ReturnStaircaseTraversalController.Observation(
            feet, x, y, z, onGround, dry, stable, aligned, lipTransientSafe);
    }

    private static List<VoxelCell> line(int length) {
        List<VoxelCell> route = new ArrayList<>();
        for (int index = 0; index < length; index++) {
            route.add(new VoxelCell(index, 16, 0));
        }
        return List.copyOf(route);
    }
}
