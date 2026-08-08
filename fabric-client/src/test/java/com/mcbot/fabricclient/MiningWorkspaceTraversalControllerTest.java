package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class MiningWorkspaceTraversalControllerTest {
    @Test
    void advancesMonotonicallyAndCompletesOneReturn() {
        List<VoxelCell> route = line(3);
        MiningWorkspaceTraversalController controller = controller(route, 1_000L);

        MiningWorkspaceTraversalController.Step first =
            tick(controller, route.get(0), true, true, 1_100L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.DRIVE, first.outcome());
        assertEquals(route.get(1), first.waypoint());
        assertEquals(1, first.waypointIndex());
        assertFalse(first.waypointAdvanced());

        MiningWorkspaceTraversalController.Step advanced =
            tick(controller, route.get(1), true, true, 1_200L);
        assertTrue(advanced.waypointAdvanced());
        assertEquals(2, advanced.waypointIndex());
        assertEquals(route.get(2), advanced.waypoint());

        MiningWorkspaceTraversalController.Step arrived =
            tick(controller, route.get(2), true, true, 1_300L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.RETURNED, arrived.outcome());
        assertEquals(0, arrived.remainingCells());
        assertEquals(MiningWorkspaceTraversalController.Mode.NONE, controller.mode());
    }

    @Test
    void preciseHorizontalProgressExtendsTheStallClock() {
        List<VoxelCell> route = line(2);
        MiningWorkspaceTraversalController controller = controller(route, 0L);

        controller.tick(
            observation(route.get(0), 0.5D, 16.0D, 0.5D, true, true),
            cell -> true,
            100L
        );
        controller.tick(
            observation(route.get(0), 0.8D, 17.0D, 0.5D, true, true),
            cell -> true,
            3_000L
        );
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.DRIVE,
            controller.tick(
                observation(route.get(0), 0.8D, 16.0D, 0.5D, true, true),
                cell -> true,
                6_999L
            ).outcome()
        );
        assertEquals(
            "return_stalled",
            controller.tick(
                observation(route.get(0), 0.8D, 18.0D, 0.5D, true, true),
                cell -> true,
                7_000L
            ).reason()
        );
    }

    @Test
    void lateralBobbingDoesNotExtendTheProgressClock() {
        List<VoxelCell> route = line(2);
        MiningWorkspaceTraversalController controller = controller(route, 0L);
        controller.tick(
            observation(route.get(0), 0.5D, 16.0D, 0.9D, true, true),
            cell -> true,
            100L
        );
        controller.tick(
            observation(route.get(0), 0.5D, 16.0D, 0.5D, true, true),
            cell -> true,
            3_000L
        );
        assertEquals(
            "return_stalled",
            tick(controller, route.get(0), true, true, 4_000L).reason()
        );
    }

    @Test
    void backwardOscillationNeverRegressesOrEarnsProgress() {
        List<VoxelCell> route = line(3);
        MiningWorkspaceTraversalController controller = controller(route, 0L);

        MiningWorkspaceTraversalController.Step forward =
            tick(controller, route.get(1), true, true, 100L);
        assertEquals(2, forward.waypointIndex());

        MiningWorkspaceTraversalController.Step backward =
            tick(controller, route.get(0), true, true, 1_000L);
        assertEquals(2, backward.waypointIndex());
        assertEquals(route.get(1), backward.stableFeet());
        assertFalse(backward.waypointAdvanced());

        MiningWorkspaceTraversalController.Step oscillated =
            tick(controller, route.get(1), true, true, 2_000L);
        assertEquals(2, oscillated.waypointIndex());
        assertFalse(oscillated.waypointAdvanced());
        assertEquals(
            "return_stalled",
            tick(controller, route.get(0), true, true, 4_100L).reason()
        );
    }

    @Test
    void forwardResyncIsBoundedAndNeverUsesNearestCellLookup() {
        List<VoxelCell> route = line(12);
        MiningWorkspaceTraversalController resynced = controller(route, 0L);
        MiningWorkspaceTraversalController.Step step =
            tick(resynced, route.get(8), true, true, 100L);
        assertTrue(step.waypointAdvanced());
        assertEquals(9, step.waypointIndex());
        assertEquals(route.get(9), step.waypoint());

        MiningWorkspaceTraversalController tooFar = controller(route, 0L);
        assertEquals(
            "route_deviation",
            tick(tooFar, route.get(9), true, true, 100L).reason()
        );

        MiningWorkspaceTraversalController offRoute = controller(route, 0L);
        assertEquals(
            "route_deviation",
            tick(offRoute, new VoxelCell(0, 16, 1), true, true, 100L).reason()
        );
    }

    @Test
    void revalidatesWaypointsAndPreservesTheFixedHardDeadline() {
        List<VoxelCell> route = line(10);
        MiningWorkspaceTraversalController invalid = controller(route, 0L);
        assertEquals(
            "route_invalidated",
            invalid.tick(
                MiningWorkspaceTraversalController.Observation.centered(route.get(0), true, true),
                cell -> false,
                100L
            ).reason()
        );

        MiningWorkspaceTraversalController invalidAfterAdvance = controller(line(3), 0L);
        assertEquals(
            "route_invalidated",
            invalidAfterAdvance.tick(
                MiningWorkspaceTraversalController.Observation.centered(
                    new VoxelCell(1, 16, 0),
                    true,
                    true
                ),
                cell -> !cell.equals(new VoxelCell(1, 16, 0)),
                100L
            ).reason()
        );

        MiningWorkspaceTraversalController invalidNextAfterAdvance = controller(line(3), 0L);
        MiningWorkspaceTraversalController.Step pending = invalidNextAfterAdvance.tick(
            MiningWorkspaceTraversalController.Observation.centered(
                new VoxelCell(1, 16, 0),
                true,
                true
            ),
            cell -> !cell.equals(new VoxelCell(2, 16, 0)),
            100L
        );
        assertEquals(MiningWorkspaceTraversalController.Outcome.DRIVE, pending.outcome());
        assertEquals("route_invalidated_pending", pending.reason());
        assertTrue(pending.waypointAdvanced());
        assertFalse(pending.forward());
        assertEquals(new VoxelCell(2, 16, 0), invalidNextAfterAdvance.activeWaypoint());
        assertEquals(
            "route_invalidated",
            invalidNextAfterAdvance.tick(
                MiningWorkspaceTraversalController.Observation.centered(
                    new VoxelCell(1, 16, 0),
                    true,
                    true
                ),
                cell -> !cell.equals(new VoxelCell(2, 16, 0)),
                150L
            ).reason()
        );

        MiningWorkspaceTraversalController timeout = controller(route, 0L);
        assertEquals(
            "return_timeout",
            tick(
                timeout,
                route.get(0),
                true,
                true,
                MiningWorkspaceTraversal.timeoutMs(route.size())
            ).reason()
        );
    }

    @Test
    void unavailableWaypointStopsWithoutStructuralRejectionAndKeepsLivenessBounds() {
        List<VoxelCell> route = line(3);
        MiningWorkspaceTraversalController availableLater = controller(route, 0L);

        MiningWorkspaceTraversalController.Step waiting =
            availableLater.waitForWaypointAvailability(100L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.DRIVE, waiting.outcome());
        assertEquals("route_unavailable_pending", waiting.reason());
        assertFalse(waiting.forward());
        assertTrue(availableLater.active());
        assertEquals(1, availableLater.waypointIndex());

        MiningWorkspaceTraversalController.Step resumed =
            tick(availableLater, route.get(0), true, true, 200L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.DRIVE, resumed.outcome());
        assertEquals("driving", resumed.reason());
        assertTrue(resumed.forward());

        MiningWorkspaceTraversalController unavailable = controller(route, 0L);
        MiningWorkspaceTraversalController.Step stalled =
            unavailable.waitForWaypointAvailability(4_000L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.REJECTED, stalled.outcome());
        assertEquals("return_stalled", stalled.reason());
        assertFalse(unavailable.active());
    }

    @Test
    void unexpectedAirborneTravelFailsClosedExceptForAValidatedStepUp() {
        MiningWorkspaceTraversalController level = controller(line(2), 0L);
        assertEquals(
            "route_unexpected_airborne",
            tick(level, line(2).get(0), false, true, 100L).reason()
        );

        List<VoxelCell> stepUp = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 17, 0)
        );
        MiningWorkspaceTraversalController upward = controller(stepUp, 0L);
        MiningWorkspaceTraversalController.Step airborne =
            tick(upward, stepUp.get(0), false, true, 100L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.DRIVE, airborne.outcome());
        assertTrue(airborne.forward());
        assertFalse(airborne.descentExempt());
    }

    @Test
    void stepUpToleratesOnlyTheElevatedOriginColumnTransition() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0)
        );
        MiningWorkspaceTraversalController controller = controller(route, 0L);
        tick(controller, route.get(0), true, true, 100L);

        MiningWorkspaceTraversalController.Step elevated = tick(
            controller,
            new VoxelCell(0, 16, 0),
            true,
            true,
            200L
        );
        assertEquals(MiningWorkspaceTraversalController.Outcome.DRIVE, elevated.outcome());
        assertEquals(route.get(0), elevated.stableFeet());
        assertEquals(1, elevated.waypointIndex());
        assertFalse(elevated.descentExempt());
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.RETURNED,
            tick(controller, route.get(1), true, true, 300L).outcome()
        );

        MiningWorkspaceTraversalController lateral = controller(route, 0L);
        tick(lateral, route.get(0), true, true, 100L);
        assertEquals(
            "route_deviation",
            tick(lateral, new VoxelCell(0, 16, 1), true, true, 200L).reason()
        );

        MiningWorkspaceTraversalController stalled = controller(route, 0L);
        tick(stalled, route.get(0), true, true, 100L);
        assertEquals(
            "return_stalled",
            tick(stalled, new VoxelCell(0, 16, 0), true, true, 4_000L).reason()
        );
    }

    @Test
    void descentAlignsLaunchesAirborneAndLandsWithoutSneakAuthority() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0),
            new VoxelCell(2, 15, 0)
        );
        MiningWorkspaceTraversalController controller = controller(route, 0L);

        MiningWorkspaceTraversalController.Step selected =
            tick(controller, route.get(0), true, false, 100L);
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.SELECTED, selected.descentPhase());
        assertFalse(selected.forward());
        assertFalse(selected.descentExempt());

        MiningWorkspaceTraversalController.Step aligning =
            tick(controller, route.get(0), true, false, 200L);
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.ALIGNING, aligning.descentPhase());
        assertFalse(aligning.forward());
        assertFalse(aligning.descentExempt());

        MiningWorkspaceTraversalController.Step launching =
            tick(controller, route.get(0), true, true, 300L);
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.LAUNCHING, launching.descentPhase());
        assertTrue(launching.forward());
        assertTrue(launching.descentExempt());
        assertTrue(launching.descentStarted());

        MiningWorkspaceTraversalController.Step stillLaunching =
            tick(controller, route.get(0), true, true, 400L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.DRIVE, stillLaunching.outcome());
        assertEquals("descent_launching", stillLaunching.reason());

        MiningWorkspaceTraversalController.Step airborne =
            tick(controller, route.get(0), false, true, 500L);
        assertEquals(MiningWorkspaceTraversalController.Outcome.HOLD_DESCENT, airborne.outcome());
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.AIRBORNE, airborne.descentPhase());
        assertTrue(airborne.forward());
        assertTrue(airborne.descentExempt());

        MiningWorkspaceTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 600L);
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.LANDED, landed.descentPhase());
        assertTrue(landed.descentLanded());
        assertTrue(landed.waypointAdvanced());
        assertFalse(landed.forward());
        assertFalse(landed.descentExempt());

        MiningWorkspaceTraversalController.Step resumed =
            tick(controller, route.get(1), true, true, 700L);
        assertEquals(route.get(2), resumed.waypoint());
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.NONE, resumed.descentPhase());
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.RETURNED,
            tick(controller, route.get(2), true, true, 800L).outcome()
        );
    }

    @Test
    void groundedStepDownLandsAndOffTargetDepartureFailsOnlyAfterLaunch() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0)
        );
        MiningWorkspaceTraversalController direct = controller(route, 0L);
        tick(direct, route.get(0), true, false, 100L);
        assertEquals(
            "descent_launching",
            tick(direct, route.get(0), true, true, 200L).reason()
        );
        MiningWorkspaceTraversalController.Step landed =
            tick(direct, route.get(1), true, true, 300L);
        assertTrue(landed.descentLanded());

        MiningWorkspaceTraversalController missed = controller(route, 0L);
        tick(missed, route.get(0), true, false, 100L);
        assertEquals(
            MiningWorkspaceTraversalController.DescentPhase.ALIGNING,
            tick(missed, route.get(0), true, false, 200L).descentPhase()
        );
        assertEquals(
            MiningWorkspaceTraversalController.DescentPhase.LAUNCHING,
            tick(missed, route.get(0), true, true, 300L).descentPhase()
        );
        assertEquals(
            "descent_missed",
            tick(missed, new VoxelCell(0, 15, 1), true, true, 400L).reason()
        );
    }

    @Test
    void descentToleratesOnlyTheElevatedLandingColumnBeforeExactLanding() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0),
            new VoxelCell(2, 15, 0)
        );
        MiningWorkspaceTraversalController controller = controller(route, 0L);
        tick(controller, route.get(0), true, false, 100L);
        tick(controller, route.get(0), true, true, 200L);

        MiningWorkspaceTraversalController.Step elevated = tick(
            controller,
            new VoxelCell(1, 16, 0),
            true,
            true,
            300L
        );
        assertEquals("descent_launching", elevated.reason());
        assertTrue(elevated.forward());
        assertTrue(elevated.descentExempt());

        assertEquals(
            MiningWorkspaceTraversalController.DescentPhase.AIRBORNE,
            tick(controller, new VoxelCell(1, 16, 0), false, true, 400L).descentPhase()
        );
        MiningWorkspaceTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 500L);
        assertTrue(landed.descentLanded());
        assertEquals(route.get(1), landed.stableFeet());
        assertEquals(2, landed.waypointIndex());
        assertEquals(1, landed.remainingCells());

        MiningWorkspaceTraversalController overshot = controller(route, 0L);
        tick(overshot, route.get(0), true, false, 100L);
        tick(overshot, route.get(0), true, true, 200L);
        assertEquals(
            "descent_missed",
            tick(overshot, route.get(2), true, true, 300L).reason()
        );

        MiningWorkspaceTraversalController timedOut = controller(route, 0L);
        tick(timedOut, route.get(0), true, false, 100L);
        tick(timedOut, route.get(0), true, true, 200L);
        assertEquals(
            "descent_timeout",
            tick(timedOut, new VoxelCell(1, 16, 0), true, true, 3_100L).reason()
        );
    }

    @Test
    void consecutiveDescentsRetainExactLandingAuthority() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0),
            new VoxelCell(2, 14, 0)
        );
        MiningWorkspaceTraversalController controller = controller(route, 0L);

        tick(controller, route.get(0), true, false, 100L);
        assertTrue(tick(controller, route.get(0), true, true, 200L).descentStarted());
        tick(controller, new VoxelCell(1, 16, 0), true, true, 300L);
        tick(controller, new VoxelCell(1, 16, 0), false, true, 400L);
        assertTrue(tick(controller, route.get(1), true, true, 500L).descentLanded());

        MiningWorkspaceTraversalController.Step secondSelected =
            tick(controller, route.get(1), true, false, 600L);
        assertEquals(
            MiningWorkspaceTraversalController.DescentPhase.SELECTED,
            secondSelected.descentPhase()
        );
        assertTrue(tick(controller, route.get(1), true, true, 700L).descentStarted());
        tick(controller, new VoxelCell(2, 15, 0), true, true, 800L);
        tick(controller, new VoxelCell(2, 15, 0), false, true, 900L);
        assertTrue(tick(controller, route.get(2), true, true, 1_000L).descentLanded());
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.RETURNED,
            tick(controller, route.get(2), true, true, 1_100L).outcome()
        );
    }

    @Test
    void descentAndOrdinaryStallsRemainBounded() {
        List<VoxelCell> descent = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0)
        );
        MiningWorkspaceTraversalController descentTimeout = controller(descent, 0L);
        tick(descentTimeout, descent.get(0), true, false, 100L);
        assertEquals(
            "descent_timeout",
            tick(descentTimeout, descent.get(0), true, false, 3_100L).reason()
        );

        MiningWorkspaceTraversalController stalled = controller(line(2), 0L);
        tick(stalled, line(2).get(0), true, true, 1L);
        assertEquals(
            "return_stalled",
            tick(stalled, line(2).get(0), true, true, 4_000L).reason()
        );
    }

    @Test
    void replacesOnlyTheUnconsumedSuffixWithoutResettingTraversalClocks() {
        List<VoxelCell> original = line(5);
        MiningWorkspaceTraversalController controller = controller(original, 1_000L);
        tick(controller, original.get(1), true, true, 1_100L);
        MiningWorkspaceTraversalController.RouteSnapshot frozen = controller.routeSnapshot();
        List<VoxelCell> replacement = List.of(
            original.get(0),
            original.get(1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(2, 16, 1),
            new VoxelCell(3, 16, 1),
            new VoxelCell(4, 16, 1),
            original.get(4)
        );

        assertTrue(controller.canReplaceRoute(frozen, replacement));
        assertTrue(controller.replaceRoute(frozen, replacement));
        MiningWorkspaceTraversalController.RouteSnapshot repaired = controller.routeSnapshot();
        assertEquals(replacement, repaired.route());
        assertEquals(frozen.mode(), repaired.mode());
        assertEquals(frozen.waypointIndex(), repaired.waypointIndex());
        assertEquals(frozen.stableFeet(), repaired.stableFeet());
        assertEquals(frozen.startedAtMs(), repaired.startedAtMs());
        assertEquals(frozen.deadlineAtMs(), repaired.deadlineAtMs());
        assertEquals(frozen.lastProgressAtMs(), repaired.lastProgressAtMs());
        assertEquals(new VoxelCell(1, 16, 1), repaired.activeWaypoint());
        assertEquals(19_500L, controller.remainingDeadlineMs(1_500L));

        assertEquals(
            "return_timeout",
            tick(controller, original.get(1), true, true, frozen.deadlineAtMs()).reason()
        );
    }

    @Test
    void routeReplacementRejectsStaleSnapshotsConsumedPrefixChangesAndCommittedDescents() {
        List<VoxelCell> route = line(4);
        MiningWorkspaceTraversalController stale = controller(route, 0L);
        MiningWorkspaceTraversalController.RouteSnapshot beforeAdvance = stale.routeSnapshot();
        tick(stale, route.get(1), true, true, 100L);
        assertFalse(stale.replaceRoute(beforeAdvance, route));

        MiningWorkspaceTraversalController.RouteSnapshot current = stale.routeSnapshot();
        List<VoxelCell> changedPrefix = List.of(
            route.get(0),
            new VoxelCell(0, 16, 1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(2, 16, 1),
            new VoxelCell(3, 16, 1),
            route.get(3)
        );
        assertFalse(stale.canReplaceRoute(current, changedPrefix));
        assertEquals(route, stale.route());

        List<VoxelCell> descentRoute = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0),
            new VoxelCell(2, 15, 0)
        );
        MiningWorkspaceTraversalController descending = controller(descentRoute, 0L);
        tick(descending, descentRoute.get(0), true, false, 100L);
        MiningWorkspaceTraversalController.RouteSnapshot selected = descending.routeSnapshot();
        assertEquals(
            MiningWorkspaceTraversalController.DescentPhase.SELECTED,
            selected.descentPhase()
        );
        assertFalse(descending.replaceRoute(selected, descentRoute));
    }

    @Test
    void suffixRepairNeverPreemptsAnEarnedStallOrHardDeadline() {
        List<VoxelCell> route = line(10);
        MiningWorkspaceTraversalController stalled = controller(route, 0L);
        MiningWorkspaceTraversalController.RouteSnapshot stalledSnapshot = stalled.routeSnapshot();
        assertTrue(stalled.routeSuffixRepairEligible(stalledSnapshot, 3_999L));
        assertFalse(stalled.routeSuffixRepairEligible(stalledSnapshot, 4_000L));
        assertEquals(
            "return_stalled",
            tick(stalled, route.get(0), true, true, 4_000L).reason()
        );

        MiningWorkspaceTraversalController expired = controller(route, 0L);
        MiningWorkspaceTraversalController.RouteSnapshot expiredSnapshot = expired.routeSnapshot();
        assertFalse(expired.routeSuffixRepairEligible(
            expiredSnapshot,
            expiredSnapshot.deadlineAtMs()
        ));
        assertEquals(
            "return_timeout",
            tick(
                expired,
                route.get(0),
                true,
                true,
                expiredSnapshot.deadlineAtMs()
            ).reason()
        );
    }

    @Test
    void rejectsInvalidStartsDisconnectedRoutesAndClearsOnDemand() {
        MiningWorkspaceTraversalController controller = new MiningWorkspaceTraversalController();
        assertFalse(controller.begin(
            MiningWorkspaceTraversalController.Mode.NONE,
            List.of(new VoxelCell(0, 16, 0)),
            new VoxelCell(0, 16, 0),
            0L
        ));
        assertFalse(controller.begin(
            MiningWorkspaceTraversalController.Mode.RETURN,
            List.of(new VoxelCell(0, 16, 0), new VoxelCell(2, 16, 0)),
            new VoxelCell(0, 16, 0),
            0L
        ));
        assertFalse(controller.begin(
            MiningWorkspaceTraversalController.Mode.RETURN,
            line(2),
            new VoxelCell(1, 16, 0),
            0L
        ));

        assertTrue(controller.begin(
            MiningWorkspaceTraversalController.Mode.RESUME,
            line(2),
            new VoxelCell(0, 16, 0),
            0L
        ));
        controller.clear();
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.IDLE,
            tick(controller, new VoxelCell(0, 16, 0), true, true, 1L).outcome()
        );
    }

    private static MiningWorkspaceTraversalController controller(List<VoxelCell> route, long nowMs) {
        MiningWorkspaceTraversalController controller = new MiningWorkspaceTraversalController();
        assertTrue(controller.begin(
            MiningWorkspaceTraversalController.Mode.RETURN,
            route,
            route.get(0),
            nowMs
        ));
        return controller;
    }

    private static MiningWorkspaceTraversalController.Step tick(
        MiningWorkspaceTraversalController controller,
        VoxelCell feet,
        boolean onGround,
        boolean aligned,
        long nowMs
    ) {
        return controller.tick(
            MiningWorkspaceTraversalController.Observation.centered(feet, onGround, aligned),
            cell -> true,
            nowMs
        );
    }

    private static MiningWorkspaceTraversalController.Observation observation(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean onGround,
        boolean aligned
    ) {
        return new MiningWorkspaceTraversalController.Observation(feet, x, y, z, onGround, aligned);
    }

    private static List<VoxelCell> line(int length) {
        List<VoxelCell> route = new ArrayList<>();
        for (int index = 0; index < length; index++) {
            route.add(new VoxelCell(index, 16, 0));
        }
        return List.copyOf(route);
    }
}
