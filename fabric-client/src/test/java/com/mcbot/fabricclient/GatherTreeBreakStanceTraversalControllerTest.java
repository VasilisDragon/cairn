package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class GatherTreeBreakStanceTraversalControllerTest {
    private static final long DEADLINE_MS = 45_000L;

    @Test
    void advancesSequentiallyAndStopsAtTheFinalStance() {
        List<VoxelCell> route = line(4);
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);

        GatherTreeBreakStanceTraversalController.Step driving =
            tick(controller, route.get(0), true, true, 100L);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.DRIVE, driving.outcome());
        assertEquals(route.get(1), driving.waypoint());
        assertTrue(driving.forward());

        GatherTreeBreakStanceTraversalController.Step first =
            tick(controller, route.get(1), true, true, 200L);
        assertTrue(first.waypointAdvanced());
        assertFalse(first.forwardResynchronized());
        assertEquals(2, first.waypointIndex());
        assertEquals(1, first.maximumWaypointIndex());

        tick(controller, route.get(2), true, true, 300L);
        GatherTreeBreakStanceTraversalController.Step reached =
            tick(controller, route.get(3), true, true, 400L);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.REACHED, reached.outcome());
        assertEquals("reached", reached.reason());
        assertFalse(reached.forward());
        assertEquals(3, reached.maximumWaypointIndex());
        assertFalse(controller.active());
    }

    @Test
    void forwardResynchronizationIsStrictlyBoundedToEightCells() {
        List<VoxelCell> route = line(12);
        GatherTreeBreakStanceTraversalController accepted = controller(route, 0L);
        GatherTreeBreakStanceTraversalController.Step resynchronized =
            tick(accepted, route.get(9), true, true, 100L);
        assertTrue(resynchronized.waypointAdvanced());
        assertTrue(resynchronized.forwardResynchronized());
        assertEquals(10, resynchronized.waypointIndex());
        assertEquals(9, resynchronized.maximumWaypointIndex());
        assertFalse(resynchronized.forward());

        GatherTreeBreakStanceTraversalController rejected = controller(route, 0L);
        GatherTreeBreakStanceTraversalController.Step tooFar =
            tick(rejected, route.get(10), true, true, 100L);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.REJECTED, tooFar.outcome());
        assertEquals("route_deviation", tooFar.reason());

        GatherTreeBreakStanceTraversalController invalidated = controller(route, 0L);
        GatherTreeBreakStanceTraversalController.Step unsafe = invalidated.tick(
            GatherTreeBreakStanceTraversalController.Observation.centered(
                route.get(5),
                true,
                true
            ),
            cell -> !cell.equals(route.get(5)),
            100L
        );
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REJECTED,
            unsafe.outcome()
        );
        assertEquals("route_invalidated", unsafe.reason());
        assertEquals(route.get(5), unsafe.waypoint());
    }

    @Test
    void earlierCellOscillationNeverRegressesOrRefreshesProgress() {
        List<VoxelCell> route = line(4);
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, route.get(1), true, true, 100L);
        assertEquals(2, controller.waypointIndex());

        GatherTreeBreakStanceTraversalController.Step backward =
            tick(controller, route.get(0), true, true, 1_000L);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.DRIVE, backward.outcome());
        assertEquals(2, backward.waypointIndex());
        assertEquals(route.get(1), backward.stableFeet());
        assertFalse(backward.waypointAdvanced());
        assertFalse(backward.forward());
        assertFalse(backward.jump());
        assertFalse(backward.sneak());
        assertEquals(900L, backward.lastProgressAgeMs());

        tick(controller, route.get(1), true, true, 2_000L);
        tick(controller, route.get(0), true, true, 3_000L);
        GatherTreeBreakStanceTraversalController.Step stalled =
            tick(controller, route.get(1), true, true, 4_100L);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.REJECTED, stalled.outcome());
        assertEquals("route_stalled", stalled.reason());
        assertEquals(1, stalled.maximumWaypointIndex());
    }

    @Test
    void onlyGroundedAlongEdgeBestDistanceRefreshesTheProgressClock() {
        List<VoxelCell> route = line(2);
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, observation(route.get(0), 0.50D, 64.0D, 0.50D, true, true), 100L);

        GatherTreeBreakStanceTraversalController.Step subThreshold =
            tick(controller, observation(route.get(0), 0.54D, 64.0D, 0.50D, true, true), 1_000L);
        assertEquals(1_000L, subThreshold.lastProgressAgeMs());

        GatherTreeBreakStanceTraversalController.Step earned =
            tick(controller, observation(route.get(0), 0.56D, 64.0D, 0.50D, true, true), 1_100L);
        assertEquals(0L, earned.lastProgressAgeMs());

        GatherTreeBreakStanceTraversalController.Step lateral =
            tick(controller, observation(route.get(0), 0.56D, 64.0D, 0.85D, true, true), 2_000L);
        assertEquals(900L, lateral.lastProgressAgeMs());

        GatherTreeBreakStanceTraversalController.Step airborne =
            tick(controller, observation(route.get(0), 0.90D, 64.6D, 0.50D, false, true), 3_000L);
        assertEquals(1_900L, airborne.lastProgressAgeMs());
        assertEquals(1, airborne.waypointIndex());
    }

    @Test
    void routeStallOccursAtExactlyFourSeconds() {
        GatherTreeBreakStanceTraversalController controller = controller(line(2), 1_000L);
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.DRIVE,
            tick(controller, line(2).get(0), true, true, 4_999L).outcome()
        );
        GatherTreeBreakStanceTraversalController.Step stalled =
            tick(controller, line(2).get(0), true, true, 5_000L);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.REJECTED, stalled.outcome());
        assertEquals("route_stalled", stalled.reason());
    }

    @Test
    void consecutiveStageAndFinalRoutesShareOneFixedDeadline() {
        List<VoxelCell> stage = line(2);
        GatherTreeBreakStanceTraversalController controller =
            new GatherTreeBreakStanceTraversalController();
        assertTrue(controller.begin(stage, stage.getFirst(), 0L, DEADLINE_MS));
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REACHED,
            tick(controller, stage.getLast(), true, true, 20_000L).outcome()
        );

        List<VoxelCell> finalRoute = List.of(
            stage.getLast(),
            new VoxelCell(2, 64, 0)
        );
        assertTrue(controller.begin(
            finalRoute,
            finalRoute.getFirst(),
            DEADLINE_MS - 1L,
            DEADLINE_MS
        ));
        assertEquals(DEADLINE_MS, controller.deadlineAtMs());
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.DRIVE,
            tick(controller, finalRoute.getFirst(), true, true, DEADLINE_MS - 1L).outcome()
        );

        GatherTreeBreakStanceTraversalController.Step expired =
            tick(controller, finalRoute.getFirst(), true, true, DEADLINE_MS);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.REJECTED, expired.outcome());
        assertEquals("break_stance_deadline", expired.reason());
    }

    @Test
    void validatesActiveWaypointsAndRejectsGroundedRouteDeviation() {
        List<VoxelCell> route = line(3);
        GatherTreeBreakStanceTraversalController invalidated = controller(route, 0L);
        GatherTreeBreakStanceTraversalController.Step invalid =
            invalidated.tick(
                GatherTreeBreakStanceTraversalController.Observation.centered(route.get(0), true, true),
                cell -> !cell.equals(route.get(1)),
                100L
            );
        assertEquals("route_invalidated", invalid.reason());

        GatherTreeBreakStanceTraversalController deviated = controller(route, 0L);
        assertEquals(
            "route_deviation",
            tick(deviated, new VoxelCell(0, 64, 1), true, true, 100L).reason()
        );
    }

    @Test
    void levelAndStepUpMovesRotateBeforeDriving() {
        List<VoxelCell> level = line(2);
        GatherTreeBreakStanceTraversalController levelController = controller(level, 0L);
        GatherTreeBreakStanceTraversalController.Step levelAlign =
            tick(levelController, level.get(0), true, false, 100L);
        assertEquals("aligning", levelAlign.reason());
        assertFalse(levelAlign.forward());
        assertFalse(levelAlign.jump());
        GatherTreeBreakStanceTraversalController.Step levelDrive =
            tick(levelController, level.get(0), true, true, 200L);
        assertTrue(levelDrive.forward());
        assertFalse(levelDrive.jump());

        List<VoxelCell> stepUp = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 65, 0)
        );
        GatherTreeBreakStanceTraversalController stepController = controller(stepUp, 0L);
        GatherTreeBreakStanceTraversalController.Step stepAlign =
            tick(stepController, stepUp.get(0), true, false, 100L);
        assertEquals("step_up_aligning", stepAlign.reason());
        assertFalse(stepAlign.forward());
        assertFalse(stepAlign.jump());
        GatherTreeBreakStanceTraversalController.Step stepLaunch =
            tick(stepController, stepUp.get(0), true, true, 200L);
        assertEquals("step_up_launching", stepLaunch.reason());
        assertTrue(stepLaunch.forward());
        assertTrue(stepLaunch.jump());
        assertFalse(stepLaunch.descentExempt());
    }

    @Test
    void stepUpOriginColumnTransientDoesNotAdvanceOrRefreshProgress() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 65, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, route.get(0), true, true, 100L);

        VoxelCell elevatedOrigin = new VoxelCell(0, 65, 0);
        GatherTreeBreakStanceTraversalController.Step transientStep =
            tick(controller, elevatedOrigin, true, true, 1_000L);
        assertEquals("step_up_launching", transientStep.reason());
        assertFalse(transientStep.waypointAdvanced());
        assertEquals(1, transientStep.waypointIndex());
        assertEquals(1_000L, transientStep.lastProgressAgeMs());

        GatherTreeBreakStanceTraversalController.Step airborne =
            tick(controller, elevatedOrigin, false, false, 1_500L);
        assertEquals("step_up_airborne", airborne.reason());
        assertTrue(airborne.forward());
        assertTrue(airborne.jump());
        assertEquals(1_500L, airborne.lastProgressAgeMs());

        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REACHED,
            tick(controller, route.get(1), true, true, 1_600L).outcome()
        );
    }

    @Test
    void stagesAtALipWithoutGrantingTheDescentExemption() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(2, 63, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);

        GatherTreeBreakStanceTraversalController.Step stage =
            tick(controller, route.get(0), true, true, 100L);
        assertTrue(stage.forward());
        assertTrue(stage.sneak());
        assertFalse(stage.descending());
        assertFalse(stage.descentExempt());
    }

    @Test
    void lowerWaypointStagesAtTheLipBeforeSelectingDescent() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 61, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);

        GatherTreeBreakStanceTraversalController.Step aligning =
            tick(controller, route.get(0), true, false, 100L);
        assertEquals("descent_lip_aligning", aligning.reason());
        assertFalse(aligning.forward());

        GatherTreeBreakStanceTraversalController.Step staging =
            tick(controller, route.get(0), true, true, 200L);
        assertEquals("descent_lip_staging", staging.reason());
        assertTrue(staging.forward());
        assertTrue(staging.sneak());
        assertFalse(staging.descentExempt());

        GatherTreeBreakStanceTraversalController.Step selected =
            tick(controller, descentLip(route.get(0), route.get(1), true), 300L);
        assertEquals("descent_selected", selected.reason());
        assertEquals(
            GatherTreeBreakStanceTraversalController.DescentPhase.SELECTED,
            selected.descentPhase()
        );
        assertFalse(selected.forward());
        assertFalse(selected.descentExempt());
    }

    @Test
    void oneTwoAndThreeBlockDescentsCommitAndLandExactly() {
        for (int depth = 1; depth <= 3; depth++) {
            List<VoxelCell> route = List.of(
                new VoxelCell(0, 64, depth),
                new VoxelCell(1, 64 - depth, depth)
            );
            GatherTreeBreakStanceTraversalController controller = controller(route, 0L);

            GatherTreeBreakStanceTraversalController.Step selected =
                tick(controller, descentLip(route.get(0), route.get(1), false), 100L);
            assertEquals(
                GatherTreeBreakStanceTraversalController.DescentPhase.SELECTED,
                selected.descentPhase()
            );
            assertFalse(selected.forward());
            assertFalse(selected.descentExempt());

            GatherTreeBreakStanceTraversalController.Step aligning =
                tick(controller, route.get(0), true, false, 200L);
            assertEquals(
                GatherTreeBreakStanceTraversalController.DescentPhase.ALIGNING,
                aligning.descentPhase()
            );
            assertFalse(aligning.forward());
            assertFalse(aligning.descentExempt());

            GatherTreeBreakStanceTraversalController.Step launching =
                tick(controller, route.get(0), true, true, 300L);
            assertTrue(launching.descentStarted());
            assertTrue(launching.forward());
            assertFalse(launching.jump());
            assertTrue(launching.descentExempt());

            GatherTreeBreakStanceTraversalController.Step airborne =
                tick(controller, new VoxelCell(1, 64, depth), false, true, 400L);
            assertEquals(
                GatherTreeBreakStanceTraversalController.Outcome.HOLD_DESCENT,
                airborne.outcome()
            );
            assertFalse(airborne.forward());
            assertTrue(airborne.descentExempt());

            GatherTreeBreakStanceTraversalController.Step landed =
                tick(controller, route.get(1), true, true, 500L);
            assertTrue(landed.descentLanded());
            assertFalse(landed.forward());
            assertFalse(landed.descentExempt());
            assertEquals(route.get(1), landed.stableFeet());

            GatherTreeBreakStanceTraversalController.Step reached =
                tick(controller, route.get(1), true, true, 600L);
            assertEquals(
                GatherTreeBreakStanceTraversalController.Outcome.REACHED,
                reached.outcome()
            );
        }
    }

    @Test
    void descentLaunchHoldsForwardUntilTheLandingColumnIsCaptured() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 61, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, descentLip(route.get(0), route.get(1), false), 100L);

        GatherTreeBreakStanceTraversalController.Step settling =
            tick(controller, route.get(0), true, true, 200L);
        assertEquals("descent_lip_settling", settling.reason());
        assertFalse(settling.forward());
        assertTrue(settling.sneak());

        GatherTreeBreakStanceTraversalController.Step launching =
            tick(controller, route.get(0), true, true, 250L);
        assertTrue(launching.forward());
        assertTrue(launching.descentExempt());

        GatherTreeBreakStanceTraversalController.Step launchWait =
            tick(controller, route.get(0), true, true, 275L);
        assertEquals("descent_launch_wait", launchWait.reason());
        assertFalse(launchWait.forward());
        assertTrue(launchWait.descentExempt());

        GatherTreeBreakStanceTraversalController.Step originAirborne =
            tick(controller, new VoxelCell(0, 63, 0), false, true, 300L);
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.HOLD_DESCENT,
            originAirborne.outcome()
        );
        assertTrue(originAirborne.forward());
        assertTrue(originAirborne.descentExempt());

        GatherTreeBreakStanceTraversalController.Step captured =
            tick(controller, new VoxelCell(1, 62, 0), false, true, 400L);
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.HOLD_DESCENT,
            captured.outcome()
        );
        assertEquals("descent_airborne_column_captured", captured.reason());
        assertFalse(captured.forward());
        assertTrue(captured.descentExempt());

        GatherTreeBreakStanceTraversalController.Step landed = tick(
            controller,
            observation(route.get(1), 1.999D, 61.0D, 0.001D, true, true),
            500L
        );
        assertTrue(landed.descentLanded());
        assertEquals(route.get(1), landed.stableFeet());
    }

    @Test
    void descentForwardResynchronizationIsStrictlyBoundedToEightCells() {
        List<VoxelCell> route = new ArrayList<>();
        route.add(new VoxelCell(0, 64, 0));
        for (int x = 1; x <= 10; x++) {
            route.add(new VoxelCell(x, 61, 0));
        }
        GatherTreeBreakStanceTraversalController accepted = controller(route, 0L);
        tick(accepted, descentLip(route.get(0), route.get(1), false), 100L);
        tick(accepted, route.get(0), true, true, 200L);
        tick(accepted, route.get(0), true, true, 250L);
        tick(accepted, new VoxelCell(1, 63, 0), false, true, 300L);

        GatherTreeBreakStanceTraversalController.Step landed =
            tick(accepted, route.get(9), true, true, 400L);
        assertTrue(landed.descentLanded());
        assertTrue(landed.waypointAdvanced());
        assertTrue(landed.forwardResynchronized());
        assertEquals("descent_landed_forward_resynchronized", landed.reason());
        assertEquals(route.get(9), landed.stableFeet());
        assertEquals(10, landed.waypointIndex());
        assertEquals(9, landed.maximumWaypointIndex());

        GatherTreeBreakStanceTraversalController tooFar = controller(route, 0L);
        tick(tooFar, descentLip(route.get(0), route.get(1), false), 100L);
        tick(tooFar, route.get(0), true, true, 200L);
        tick(tooFar, route.get(0), true, true, 250L);
        tick(tooFar, new VoxelCell(1, 63, 0), false, true, 300L);
        assertEquals(
            "descent_missed",
            tick(tooFar, route.get(10), true, true, 400L).reason()
        );
    }

    @Test
    void exactThreeSecondLandingWinsOverTheDescentTimeout() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 62, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, descentLip(route.get(0), route.get(1), false), 100L);
        tick(controller, route.get(0), true, true, 200L);
        tick(controller, route.get(0), true, true, 250L);

        GatherTreeBreakStanceTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 3_100L);
        assertTrue(landed.descentLanded());
        assertEquals("descent_landed", landed.reason());
    }

    @Test
    void stoppedLandingTickRevalidatesTheLandingSupport() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 63, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, descentLip(route.get(0), route.get(1), false), 100L);
        tick(controller, route.get(0), true, true, 200L);
        tick(controller, route.get(0), true, true, 250L);
        tick(controller, route.get(1), true, true, 300L);

        GatherTreeBreakStanceTraversalController.Step invalidated = controller.tick(
            GatherTreeBreakStanceTraversalController.Observation.centered(
                route.get(1),
                true,
                true
            ),
            cell -> !cell.equals(route.get(1)),
            400L
        );
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REJECTED,
            invalidated.outcome()
        );
        assertEquals("descent_landing_invalidated", invalidated.reason());
        assertEquals(route.get(1), invalidated.waypoint());
    }

    @Test
    void finalDescentLandedBeforeTheDeadlineReachesOnTheStoppedBoundaryTick() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 63, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, descentLip(route.get(0), route.get(1), false), 100L);
        tick(controller, route.get(0), true, true, 200L);
        tick(controller, route.get(0), true, true, 250L);
        GatherTreeBreakStanceTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 44_999L);
        assertTrue(landed.descentLanded());

        GatherTreeBreakStanceTraversalController.Step reached =
            tick(controller, route.get(1), true, true, DEADLINE_MS);
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REACHED,
            reached.outcome()
        );
    }

    @Test
    void nonFinalLandingCannotExtendTheTargetDeadline() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 63, 0),
            new VoxelCell(2, 63, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, descentLip(route.get(0), route.get(1), false), 100L);
        tick(controller, route.get(0), true, true, 200L);
        tick(controller, route.get(0), true, true, 250L);
        assertTrue(tick(controller, route.get(1), true, true, 44_999L).descentLanded());

        GatherTreeBreakStanceTraversalController.Step deadline =
            tick(controller, route.get(1), true, true, DEADLINE_MS);
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REJECTED,
            deadline.outcome()
        );
        assertEquals("break_stance_deadline", deadline.reason());
    }

    @Test
    void delayedPollCannotUseTheFinalLandingBoundaryGrace() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 63, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, descentLip(route.get(0), route.get(1), false), 100L);
        tick(controller, route.get(0), true, true, 200L);
        tick(controller, route.get(0), true, true, 250L);
        assertTrue(tick(controller, route.get(1), true, true, 44_999L).descentLanded());

        GatherTreeBreakStanceTraversalController.Step deadline =
            tick(controller, route.get(1), true, true, DEADLINE_MS + 1L);
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REJECTED,
            deadline.outcome()
        );
        assertEquals("break_stance_deadline", deadline.reason());
    }

    @Test
    void groundedStepDownCanLandWithoutAnObservedAirborneTick() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 63, 0)
        );
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        tick(controller, descentLip(route.get(0), route.get(1), false), 100L);
        tick(controller, route.get(0), true, true, 200L);
        tick(controller, route.get(0), true, true, 250L);

        GatherTreeBreakStanceTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 300L);
        assertTrue(landed.descentLanded());
        assertEquals(
            GatherTreeBreakStanceTraversalController.DescentPhase.LANDED,
            landed.descentPhase()
        );
    }

    @Test
    void descentOriginIsNotAMissButOffTargetLandingAndTimeoutAreBounded() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 62, 0)
        );
        GatherTreeBreakStanceTraversalController missed = controller(route, 0L);
        tick(missed, descentLip(route.get(0), route.get(1), false), 100L);
        tick(missed, route.get(0), true, true, 200L);
        tick(missed, route.get(0), true, true, 250L);
        GatherTreeBreakStanceTraversalController.Step origin =
            tick(missed, route.get(0), true, true, 300L);
        assertEquals("descent_launch_wait", origin.reason());
        assertTrue(origin.descentExempt());
        assertFalse(origin.forward());
        assertEquals(
            "descent_missed",
            tick(missed, new VoxelCell(1, 62, 1), true, true, 400L).reason()
        );

        GatherTreeBreakStanceTraversalController timedOut = controller(route, 0L);
        tick(timedOut, descentLip(route.get(0), route.get(1), false), 100L);
        assertEquals(
            "descent_timeout",
            tick(timedOut, route.get(0), true, false, 3_100L).reason()
        );
    }

    @Test
    void airborneEdgeToleranceRejectsImpossibleVerticalBobbing() {
        List<VoxelCell> level = line(2);
        GatherTreeBreakStanceTraversalController below = controller(level, 0L);
        GatherTreeBreakStanceTraversalController.Step fallen = tick(
            below,
            new VoxelCell(0, 62, 0),
            false,
            false,
            100L
        );
        assertEquals("route_unexpected_airborne", fallen.reason());

        List<VoxelCell> stepUp = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 65, 0)
        );
        GatherTreeBreakStanceTraversalController above = controller(stepUp, 0L);
        tick(above, stepUp.get(0), true, true, 100L);
        GatherTreeBreakStanceTraversalController.Step overshot = tick(
            above,
            new VoxelCell(1, 66, 0),
            false,
            false,
            200L
        );
        assertEquals("route_deviation", overshot.reason());
    }

    @Test
    void targetDeadlineIsFixedAcrossAReplan() {
        List<VoxelCell> route = line(2);
        GatherTreeBreakStanceTraversalController controller = controller(route, 0L);
        controller.clear();

        assertTrue(controller.begin(route, route.get(0), 10_000L, DEADLINE_MS));
        assertEquals(35_000L, controller.remainingDeadlineMs(10_000L));
        GatherTreeBreakStanceTraversalController.Step deadline =
            tick(controller, route.get(0), true, true, DEADLINE_MS);
        assertEquals(GatherTreeBreakStanceTraversalController.Outcome.REJECTED, deadline.outcome());
        assertEquals("break_stance_deadline", deadline.reason());
        assertEquals(35_000L, deadline.elapsedMs());
        assertEquals(0L, deadline.remainingDeadlineMs());
    }

    @Test
    void rejectsMalformedRoutesAndClearsAllState() {
        GatherTreeBreakStanceTraversalController controller =
            new GatherTreeBreakStanceTraversalController();
        VoxelCell start = new VoxelCell(0, 64, 0);
        assertTrue(controller.begin(List.of(start), start, 0L, DEADLINE_MS));
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.REACHED,
            tick(controller, start, true, true, 1L).outcome()
        );
        assertFalse(controller.begin(
            List.of(start, new VoxelCell(2, 64, 0)),
            start,
            0L,
            DEADLINE_MS
        ));
        assertFalse(controller.begin(
            List.of(start, new VoxelCell(1, 60, 0)),
            start,
            0L,
            DEADLINE_MS
        ));
        assertFalse(controller.begin(
            List.of(start, new VoxelCell(1, 64, 0), start),
            start,
            0L,
            DEADLINE_MS
        ));
        assertFalse(controller.begin(
            line(2),
            new VoxelCell(1, 64, 0),
            0L,
            DEADLINE_MS
        ));

        assertTrue(controller.begin(line(2), start, 0L, DEADLINE_MS));
        controller.clear();
        assertFalse(controller.active());
        assertEquals(-1, controller.waypointIndex());
        assertEquals(-1, controller.maximumWaypointIndex());
        assertEquals(GatherTreeBreakStanceTraversalController.DescentPhase.NONE, controller.descentPhase());
        assertEquals(
            GatherTreeBreakStanceTraversalController.Outcome.IDLE,
            tick(controller, start, true, true, 100L).outcome()
        );
    }

    private static GatherTreeBreakStanceTraversalController controller(
        List<VoxelCell> route,
        long nowMs
    ) {
        GatherTreeBreakStanceTraversalController controller =
            new GatherTreeBreakStanceTraversalController();
        assertTrue(controller.begin(route, route.get(0), nowMs, nowMs + DEADLINE_MS));
        return controller;
    }

    private static GatherTreeBreakStanceTraversalController.Step tick(
        GatherTreeBreakStanceTraversalController controller,
        VoxelCell feet,
        boolean onGround,
        boolean aligned,
        long nowMs
    ) {
        return tick(
            controller,
            GatherTreeBreakStanceTraversalController.Observation.centered(
                feet,
                onGround,
                aligned
            ),
            nowMs
        );
    }

    private static GatherTreeBreakStanceTraversalController.Step tick(
        GatherTreeBreakStanceTraversalController controller,
        GatherTreeBreakStanceTraversalController.Observation observation,
        long nowMs
    ) {
        return controller.tick(observation, cell -> true, nowMs);
    }

    private static GatherTreeBreakStanceTraversalController.Observation observation(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean onGround,
        boolean aligned
    ) {
        return new GatherTreeBreakStanceTraversalController.Observation(
            feet,
            x,
            y,
            z,
            onGround,
            aligned
        );
    }

    private static GatherTreeBreakStanceTraversalController.Observation descentLip(
        VoxelCell origin,
        VoxelCell landing,
        boolean aligned
    ) {
        return observation(
            origin,
            origin.x() + 0.5D + ((landing.x() - origin.x()) * 0.49D),
            origin.y(),
            origin.z() + 0.5D + ((landing.z() - origin.z()) * 0.49D),
            true,
            aligned
        );
    }

    private static List<VoxelCell> line(int length) {
        List<VoxelCell> route = new ArrayList<>();
        for (int index = 0; index < length; index++) {
            route.add(new VoxelCell(index, 64, 0));
        }
        return List.copyOf(route);
    }
}
