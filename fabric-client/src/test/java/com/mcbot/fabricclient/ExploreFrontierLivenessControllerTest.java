package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class ExploreFrontierLivenessControllerTest {
    @Test
    void edgeGuardStopsAtTheValidatedActiveLevelWaypointOnly() {
        VoxelCell stableFeet = new VoxelCell(0, 64, 0);
        VoxelCell waypoint = new VoxelCell(1, 64, 0);

        assertEquals(
            1.2D,
            ExploreFrontierLivenessController.edgeGuardLookahead(
                0.5D,
                0.5D,
                stableFeet,
                stableFeet,
                waypoint,
                true,
                true
            ),
            1.0E-9D
        );
        assertEquals(
            MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD,
            ExploreFrontierLivenessController.edgeGuardLookahead(
                0.5D,
                0.5D,
                stableFeet,
                stableFeet,
                new VoxelCell(1, 65, 0),
                true,
                true
            )
        );
        assertEquals(
            MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD,
            ExploreFrontierLivenessController.edgeGuardLookahead(
                0.5D,
                0.5D,
                stableFeet,
                stableFeet,
                waypoint,
                true,
                false
            )
        );
    }

    @Test
    void groundedWaypointProgressAdvancesMonotonicallyAndResetsOnlyItsInterval() {
        List<VoxelCell> route = line(4);
        ExploreFrontierLivenessController controller = controller(route, 1_000L);

        ExploreFrontierLivenessController.Step first = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(1), true),
            2_000L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.PROGRESSED, first.outcome());
        assertEquals("waypoint_advanced", first.reason());
        assertTrue(first.waypointAdvanced());
        assertFalse(first.forwardResynchronized());
        assertEquals(2, first.waypointIndex());
        assertEquals(1, first.maximumWaypointIndex());
        assertEquals(route.get(1), first.stableFeet());

        ExploreFrontierLivenessController.Step beforeDeadline = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(1), true),
            11_999L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.CONTINUE, beforeDeadline.outcome());
        assertEquals(9_999L, beforeDeadline.lastProgressAgeMs());

        ExploreFrontierLivenessController.Step deadline = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(1), true),
            12_000L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, deadline.outcome());
        assertEquals("no_progress_deadline", deadline.reason());
        assertEquals(
            new ExploreFrontierPlanner.DirectedTransition(route.get(1), route.get(2)),
            deadline.failedTransition()
        );
    }

    @Test
    void forwardResynchronizationIsBoundedToEightCellsAndNeverRegresses() {
        List<VoxelCell> route = line(12);
        ExploreFrontierLivenessController accepted = controller(route, 0L);

        ExploreFrontierLivenessController.Step resynchronized = accepted.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(9), true),
            100L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.PROGRESSED, resynchronized.outcome());
        assertEquals("forward_resynchronized", resynchronized.reason());
        assertTrue(resynchronized.forwardResynchronized());
        assertEquals(10, resynchronized.waypointIndex());
        assertEquals(9, resynchronized.maximumWaypointIndex());

        ExploreFrontierLivenessController.Step earlier = accepted.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(2), true),
            1_000L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.CONTINUE, earlier.outcome());
        assertEquals(10, earlier.waypointIndex());
        assertEquals(9, earlier.maximumWaypointIndex());
        assertEquals(route.get(9), earlier.stableFeet());
        assertEquals(900L, earlier.lastProgressAgeMs());

        ExploreFrontierLivenessController tooFar = controller(route, 0L);
        ExploreFrontierLivenessController.Step ignored = tooFar.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(10), true),
            100L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.CONTINUE, ignored.outcome());
        assertEquals(1, ignored.waypointIndex());
        assertEquals(0, ignored.maximumWaypointIndex());
    }

    @Test
    void airborneBobbingAndControlModeTogglesNeverRefreshProgress() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);

        for (long nowMs : List.of(1_000L, 3_000L, 6_000L, 9_999L)) {
            VoxelCell bobbingFeet = nowMs % 2_000L == 0L
                ? new VoxelCell(0, 65, 0)
                : route.get(1);
            ExploreFrontierLivenessController.Step step = controller.tick(
                ExploreFrontierLivenessController.Observation.pose(bobbingFeet, false),
                nowMs
            );
            assertEquals(ExploreFrontierLivenessController.Outcome.CONTINUE, step.outcome());
        }

        ExploreFrontierLivenessController.Step deadline = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
            10_000L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, deadline.outcome());
        assertEquals(10_000L, deadline.lastProgressAgeMs());
    }

    @Test
    void verifiedBlockBreakIsProgressButNonterminalActivityIsNot() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);

        assertEquals(
            ExploreFrontierLivenessController.Outcome.CONTINUE,
            controller.tick(
                ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
                9_999L
            ).outcome()
        );
        ExploreFrontierLivenessController.Step broken = controller.tick(
            ExploreFrontierLivenessController.Observation.verifiedBreak(route.get(0), false),
            10_000L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.PROGRESSED, broken.outcome());
        assertEquals("verified_block_broken", broken.reason());
        assertEquals(1, broken.verifiedBlocksBroken());
        assertEquals(0L, broken.lastProgressAgeMs());

        assertEquals(
            ExploreFrontierLivenessController.Outcome.CONTINUE,
            controller.tick(
                ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
                19_999L
            ).outcome()
        );
        ExploreFrontierLivenessController.Step deadline = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
            20_000L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, deadline.outcome());
        assertEquals(1, deadline.verifiedBlocksBroken());
    }

    @Test
    void blockerResultCanDeferTheDeadlineWithinATickButAirborneStateCannot() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);

        ExploreFrontierLivenessController.Step preBlocker = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
            10_000L,
            false
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.CONTINUE, preBlocker.outcome());
        assertEquals(route.getFirst(), controller.stableFeet());

        ExploreFrontierLivenessController.Step airborne = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(new VoxelCell(1, 65, 0), false),
            12_000L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, airborne.outcome());
        assertEquals("no_progress_deadline", airborne.reason());
        assertEquals(route.getFirst(), controller.stableFeet());

        ExploreFrontierLivenessController.Step grounded = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
            12_001L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, grounded.outcome());
        assertEquals("no_progress_deadline", grounded.reason());
    }

    @Test
    void blockerFailureAndRouteInvalidationRequestImmediateFirstReplan() {
        List<VoxelCell> route = line(3);
        for (ExploreFrontierLivenessController.Failure failure : List.of(
            ExploreFrontierLivenessController.Failure.BLOCKER_FAILED,
            ExploreFrontierLivenessController.Failure.ROUTE_INVALIDATED
        )) {
            ExploreFrontierLivenessController controller = controller(route, 0L);
            ExploreFrontierLivenessController.Step step = controller.tick(
                ExploreFrontierLivenessController.Observation.failure(route.get(0), true, failure),
                25L
            );

            assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, step.outcome());
            assertEquals(failure.reason(), step.reason());
            assertEquals(1, step.routeComputation());
            assertTrue(controller.awaitingReplan());
            assertEquals(
                new ExploreFrontierPlanner.DirectedTransition(route.get(0), route.get(1)),
                step.failedTransition()
            );
        }
    }

    @Test
    void oneReplacementIsAllowedAndSecondFailureRejects() {
        List<VoxelCell> direct = line(4);
        ExploreFrontierLivenessController controller = controller(direct, 0L);
        ExploreFrontierLivenessController.Step firstFailure = controller.tick(
            ExploreFrontierLivenessController.Observation.failure(
                direct.get(0),
                true,
                ExploreFrontierLivenessController.Failure.BLOCKER_FAILED
            ),
            100L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, firstFailure.outcome());

        List<VoxelCell> alternate = List.of(
            direct.get(0),
            new VoxelCell(0, 64, 1),
            new VoxelCell(1, 64, 1),
            new VoxelCell(2, 64, 1)
        );
        assertTrue(controller.replaceRoute("cmd", 2L, alternate, alternate.get(0), 200L));
        assertEquals(2, controller.routeComputation());
        assertTrue(controller.matches("cmd", 2L));
        assertEquals(alternate, controller.route());
        assertEquals(1, controller.waypointIndex());
        assertEquals(0L, controller.lastProgressAgeMs(200L));

        ExploreFrontierLivenessController.Step secondFailure = controller.tick(
            ExploreFrontierLivenessController.Observation.failure(
                alternate.get(0),
                true,
                ExploreFrontierLivenessController.Failure.ROUTE_INVALIDATED
            ),
            300L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REJECTED, secondFailure.outcome());
        assertEquals(2, secondFailure.routeComputation());
        assertEquals(
            new ExploreFrontierPlanner.DirectedTransition(alternate.get(0), alternate.get(1)),
            secondFailure.failedTransition()
        );
        assertFalse(controller.active());
        assertFalse(controller.replaceRoute("cmd", 3L, direct, direct.get(0), 400L));
    }

    @Test
    void replacementReceivesOneFreshExactIntervalThenRejectsAtTheCap() {
        List<VoxelCell> direct = line(3);
        ExploreFrontierLivenessController controller = controller(direct, 0L);
        assertEquals(
            ExploreFrontierLivenessController.Outcome.REPLAN,
            controller.tick(
                ExploreFrontierLivenessController.Observation.pose(direct.get(0), true),
                10_000L
            ).outcome()
        );

        List<VoxelCell> alternate = List.of(
            direct.get(0),
            new VoxelCell(0, 64, -1),
            new VoxelCell(1, 64, -1)
        );
        assertTrue(controller.replaceRoute("cmd", 2L, alternate, alternate.get(0), 10_100L));
        assertEquals(
            ExploreFrontierLivenessController.Outcome.CONTINUE,
            controller.tick(
                ExploreFrontierLivenessController.Observation.pose(alternate.get(0), true),
                20_099L
            ).outcome()
        );

        ExploreFrontierLivenessController.Step rejected = controller.tick(
            ExploreFrontierLivenessController.Observation.pose(alternate.get(0), true),
            20_100L
        );
        assertEquals(ExploreFrontierLivenessController.Outcome.REJECTED, rejected.outcome());
        assertEquals("no_progress_deadline", rejected.reason());
        assertEquals(2, rejected.routeComputation());
        assertEquals(20_100L, rejected.elapsedMs());
    }

    @Test
    void failedReplanRejectsWithoutMutatingTheFrozenRoute() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);
        controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
            10_000L
        );

        ExploreFrontierLivenessController.Step rejected =
            controller.failPendingReplan("no_safe_alternate", 10_100L);

        assertEquals(ExploreFrontierLivenessController.Outcome.REJECTED, rejected.outcome());
        assertEquals("no_safe_alternate", rejected.reason());
        assertEquals(route, controller.route());
        assertEquals(2, rejected.routeComputation());
        assertFalse(controller.active());
    }

    @Test
    void replacementRequiresMatchingCommandGroundedOriginAndValidTraversalShape() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);
        controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
            10_000L
        );

        assertFalse(controller.replaceRoute("other", 2L, route, route.get(0), 10_100L));
        assertFalse(controller.replaceRoute("cmd", 2L, route, route.get(1), 10_100L));
        assertFalse(controller.replaceRoute(
            "cmd",
            2L,
            List.of(route.get(0), new VoxelCell(2, 64, 0)),
            route.get(0),
            10_100L
        ));
        assertTrue(controller.awaitingReplan());
        assertEquals(route, controller.route());
        assertEquals(1, controller.routeComputation());
    }

    @Test
    void beginRejectsMalformedRoutesWithoutDisturbingAnActiveRoute() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);

        assertFalse(controller.begin("replacement", 2L, List.of(route.get(0)), route.get(0), 100L));
        assertFalse(controller.begin(
            "replacement",
            2L,
            List.of(route.get(0), route.get(0)),
            route.get(0),
            100L
        ));
        assertFalse(controller.begin(
            "replacement",
            2L,
            List.of(route.get(0), new VoxelCell(1, 66, 0)),
            route.get(0),
            100L
        ));
        assertTrue(controller.matches("cmd", 1L));
        assertEquals(route, controller.route());
    }

    @Test
    void failureOutranksCoincidentPoseOrBreakProgress() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);

        ExploreFrontierLivenessController.Step step = controller.tick(
            new ExploreFrontierLivenessController.Observation(
                route.get(1),
                true,
                true,
                ExploreFrontierLivenessController.Failure.ROUTE_INVALIDATED
            ),
            100L
        );

        assertEquals(ExploreFrontierLivenessController.Outcome.REPLAN, step.outcome());
        assertEquals(0, step.verifiedBlocksBroken());
        assertEquals(1, step.waypointIndex());
        assertEquals(0, step.maximumWaypointIndex());
    }

    @Test
    void clearDropsAllIdentityProgressAndPendingReplanState() {
        List<VoxelCell> route = line(3);
        ExploreFrontierLivenessController controller = controller(route, 0L);
        controller.tick(
            ExploreFrontierLivenessController.Observation.pose(route.get(0), true),
            10_000L
        );
        assertTrue(controller.awaitingReplan());

        controller.clear();

        assertFalse(controller.active());
        assertFalse(controller.awaitingReplan());
        assertFalse(controller.matches("cmd", 1L));
        assertTrue(controller.route().isEmpty());
        assertEquals(0, controller.routeComputation());
        assertEquals(-1, controller.waypointIndex());
        assertEquals(-1, controller.maximumWaypointIndex());
        assertNull(controller.activeWaypoint());
        assertNull(controller.activeTransition());
        assertNull(controller.failedTransition());
        assertEquals(
            ExploreFrontierLivenessController.Outcome.IDLE,
            controller.tick(null, 20_000L).outcome()
        );
    }

    private static ExploreFrontierLivenessController controller(
        List<VoxelCell> route,
        long nowMs
    ) {
        ExploreFrontierLivenessController controller = new ExploreFrontierLivenessController();
        assertTrue(controller.begin("cmd", 1L, route, route.get(0), nowMs));
        return controller;
    }

    private static List<VoxelCell> line(int length) {
        List<VoxelCell> route = new ArrayList<>();
        for (int x = 0; x < length; x++) {
            route.add(new VoxelCell(x, 64, 0));
        }
        return List.copyOf(route);
    }
}
