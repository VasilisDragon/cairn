package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

final class MiningWorkspaceSiteTraversalControllerTest {
    @Test
    void acceptsPlannerRoutesIncludingOneUpAndThreeDownButRejectsInvalidStarts() {
        MiningWorkspaceSiteTraversalController controller =
            new MiningWorkspaceSiteTraversalController();
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 17, 0),
            new VoxelCell(1, 14, 1)
        );

        assertTrue(controller.begin(route, route.get(0), 0L, 30_000L));
        controller.clear();
        assertFalse(controller.begin(
            route,
            new VoxelCell(1, 17, 0),
            0L,
            30_000L
        ));
        assertFalse(controller.begin(
            List.of(new VoxelCell(0, 16, 0), new VoxelCell(1, 12, 0)),
            new VoxelCell(0, 16, 0),
            0L,
            30_000L
        ));
        assertFalse(controller.begin(
            List.of(new VoxelCell(0, 16, 0), new VoxelCell(0, 16, 0)),
            new VoxelCell(0, 16, 0),
            0L,
            30_000L
        ));
    }

    @Test
    void advancesOnlyForwardResynchronizesEightCellsAndStopsAtFinalStance() {
        List<VoxelCell> route = line(12);
        MiningWorkspaceSiteTraversalController controller = controller(route, 0L);

        MiningWorkspaceSiteTraversalController.Step resynchronized =
            tick(controller, route.get(9), true, true, 100L);
        assertTrue(resynchronized.waypointAdvanced());
        assertTrue(resynchronized.forwardResynchronized());
        assertEquals(10, resynchronized.waypointIndex());
        assertEquals(9, resynchronized.maximumWaypointIndex());
        assertFalse(resynchronized.forward());

        MiningWorkspaceSiteTraversalController.Step earlier =
            tick(controller, route.get(4), true, true, 200L);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REJECTED, earlier.outcome());
        assertEquals("route_deviation", earlier.reason());
        assertEquals(10, earlier.waypointIndex());
        assertEquals(9, earlier.maximumWaypointIndex());

        controller = controller(route, 0L);
        tick(controller, route.get(9), true, true, 100L);

        MiningWorkspaceSiteTraversalController.Step next =
            tick(controller, route.get(10), true, true, 300L);
        assertTrue(next.waypointAdvanced());
        assertEquals(11, next.waypointIndex());

        MiningWorkspaceSiteTraversalController.Step settling =
            tick(controller, route.get(11), true, true, 400L);
        assertEquals("final_stance_settling", settling.reason());
        assertFalse(settling.forward());
        assertFalse(settling.jump());

        MiningWorkspaceSiteTraversalController.Step reached =
            tick(controller, route.get(11), true, true, 450L);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REACHED, reached.outcome());
        assertTrue(reached.stanceReached());
        assertFalse(reached.forward());
        assertFalse(controller.active());
    }

    @Test
    void doesNotResynchronizePastTheEightCellWindow() {
        List<VoxelCell> route = line(12);
        MiningWorkspaceSiteTraversalController controller = controller(route, 0L);

        MiningWorkspaceSiteTraversalController.Step result =
            tick(controller, route.get(10), true, true, 100L);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REJECTED, result.outcome());
        assertEquals("route_deviation", result.reason());
        assertEquals(0, result.maximumWaypointIndex());
    }

    @Test
    void onlyGroundedPointZeroFiveProgressRefreshesTheFourSecondStallClock() {
        List<VoxelCell> route = line(2);
        MiningWorkspaceSiteTraversalController noProgress = controller(route, 0L);
        tick(noProgress, observation(route.get(0), 0.50D, 16.0D, 0.50D, true, true), 1L);
        tick(noProgress, observation(route.get(0), 0.54D, 16.0D, 0.50D, true, true), 2_000L);
        MiningWorkspaceSiteTraversalController.Step stalled =
            tick(noProgress, route.get(0), true, true, 4_000L);
        assertEquals("route_stalled", stalled.reason());

        MiningWorkspaceSiteTraversalController progress = controller(route, 0L);
        tick(progress, observation(route.get(0), 0.50D, 16.0D, 0.50D, true, true), 1L);
        tick(progress, observation(route.get(0), 0.56D, 16.0D, 0.50D, true, true), 3_999L);
        assertEquals(3_999L, progress.lastProgressAgeMs(7_998L));
        assertEquals(
            "route_stalled",
            tick(progress, route.get(0), true, true, 7_999L).reason()
        );
    }

    @Test
    void stepUpUsesOneBoundedPulseAndDisarmsUntilTheLanding() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 17, 0)
        );
        MiningWorkspaceSiteTraversalController controller = controller(route, 0L);

        MiningWorkspaceSiteTraversalController.Step selected =
            tick(controller, route.get(0), true, false, 100L);
        assertEquals("step_up_selected", selected.reason());
        assertFalse(selected.forward());
        assertFalse(selected.jump());

        MiningWorkspaceSiteTraversalController.Step aligning =
            tick(controller, route.get(0), true, false, 200L);
        assertEquals("step_up_aligning", aligning.reason());
        assertFalse(aligning.jump());

        MiningWorkspaceSiteTraversalController.Step pulse =
            tick(controller, route.get(0), true, true, 300L);
        assertEquals("step_up_pulse", pulse.reason());
        assertTrue(pulse.forward());
        assertTrue(pulse.jump());
        assertTrue(pulse.stepUpStarted());
        assertFalse(pulse.descentExempt());

        assertTrue(tick(controller, route.get(0), true, true, 449L).jump());
        MiningWorkspaceSiteTraversalController.Step released =
            tick(controller, route.get(0), true, true, 450L);
        assertEquals("step_up_pulse_completed", released.reason());
        assertFalse(released.jump());

        MiningWorkspaceSiteTraversalController.Step airborne = tick(
            controller,
            MiningWorkspaceSiteTraversalController.Observation.centered(
                new VoxelCell(0, 17, 0),
                false,
                true
            ),
            500L
        );
        assertEquals("step_up_airborne", airborne.reason());
        assertFalse(airborne.jump());

        MiningWorkspaceSiteTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 600L);
        assertEquals("step_up_landed", landed.reason());
        assertTrue(landed.stepUpCompleted());
        assertFalse(landed.forward());
        assertEquals(
            MiningWorkspaceSiteTraversalController.Outcome.REACHED,
            tick(controller, route.get(1), true, true, 650L).outcome()
        );
    }

    @Test
    void committedDescentDoesNotMissAtOriginAndExemptsOnlyLaunchAndAirborne() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 14, 0),
            new VoxelCell(2, 14, 0)
        );
        MiningWorkspaceSiteTraversalController controller = controller(route, 0L);

        MiningWorkspaceSiteTraversalController.Step selected =
            tick(controller, route.get(0), true, false, 100L);
        assertEquals(MiningWorkspaceSiteTraversalController.DescentPhase.SELECTED, selected.descentPhase());
        assertTrue(selected.descentSelected());
        assertFalse(selected.descentExempt());

        MiningWorkspaceSiteTraversalController.Step aligning =
            tick(controller, route.get(0), true, false, 200L);
        assertEquals(MiningWorkspaceSiteTraversalController.DescentPhase.ALIGNING, aligning.descentPhase());
        assertFalse(aligning.descentExempt());

        MiningWorkspaceSiteTraversalController.Step launching =
            tick(controller, route.get(0), true, true, 300L);
        assertEquals(MiningWorkspaceSiteTraversalController.DescentPhase.LAUNCHING, launching.descentPhase());
        assertTrue(launching.descentStarted());
        assertTrue(launching.forward());
        assertFalse(launching.jump());
        assertFalse(launching.sneak());
        assertTrue(launching.descentExempt());

        MiningWorkspaceSiteTraversalController.Step originHold =
            tick(controller, route.get(0), true, true, 400L);
        assertEquals("descent_launching", originHold.reason());
        assertFalse(originHold.descentDeparted());
        assertTrue(originHold.descentExempt());

        MiningWorkspaceSiteTraversalController.Step departed = tick(
            controller,
            new VoxelCell(1, 16, 0),
            false,
            true,
            500L
        );
        assertEquals(MiningWorkspaceSiteTraversalController.DescentPhase.AIRBORNE, departed.descentPhase());
        assertTrue(departed.descentDeparted());
        assertTrue(departed.forward());
        assertTrue(departed.descentExempt());

        MiningWorkspaceSiteTraversalController.Step firstPoll =
            tick(controller, route.get(1), true, true, 600L);
        assertEquals("descent_landing_settling", firstPoll.reason());
        assertFalse(firstPoll.forward());
        assertFalse(firstPoll.descentExempt());

        MiningWorkspaceSiteTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 650L);
        assertEquals(MiningWorkspaceSiteTraversalController.DescentPhase.LANDED, landed.descentPhase());
        assertTrue(landed.descentLanded());
        assertFalse(landed.forward());
        assertFalse(landed.descentExempt());

        MiningWorkspaceSiteTraversalController.Step committed =
            tick(controller, route.get(1), true, true, 700L);
        assertEquals("descent_landing_committed", committed.reason());
        assertEquals(route.get(2), committed.waypoint());
    }

    @Test
    void exactGroundedStepDownCanLandWithoutAnObservedAirborneTick() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 15, 0)
        );
        MiningWorkspaceSiteTraversalController controller = controller(route, 0L);
        tick(controller, route.get(0), true, false, 100L);
        tick(controller, route.get(0), true, true, 200L);
        MiningWorkspaceSiteTraversalController.Step launching =
            tick(controller, route.get(0), true, true, 300L);
        assertEquals("descent_launching", launching.reason());

        MiningWorkspaceSiteTraversalController.Step firstPoll =
            tick(controller, route.get(1), true, true, 400L);
        assertTrue(firstPoll.descentDeparted());
        assertEquals("descent_landing_settling", firstPoll.reason());
        MiningWorkspaceSiteTraversalController.Step landed =
            tick(controller, route.get(1), true, true, 450L);
        assertTrue(landed.descentLanded());
        MiningWorkspaceSiteTraversalController.Step reached =
            tick(controller, route.get(1), true, true, 500L);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REACHED, reached.outcome());
        assertTrue(reached.stanceReached());
        assertFalse(reached.forward());
        assertFalse(reached.jump());
        assertFalse(reached.sneak());
        assertFalse(reached.descentExempt());
    }

    @Test
    void offTargetGroundedLandingFailsOnlyAfterProvenDeparture() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 14, 0)
        );
        MiningWorkspaceSiteTraversalController atOrigin = controller(route, 0L);
        tick(atOrigin, route.get(0), true, false, 100L);
        tick(atOrigin, route.get(0), true, true, 200L);
        tick(atOrigin, route.get(0), true, true, 300L);
        assertEquals(
            "descent_launching",
            tick(atOrigin, route.get(0), true, true, 400L).reason()
        );

        MiningWorkspaceSiteTraversalController missed = controller(route, 0L);
        tick(missed, route.get(0), true, false, 100L);
        tick(missed, route.get(0), true, true, 200L);
        tick(missed, route.get(0), true, true, 300L);
        tick(missed, new VoxelCell(1, 16, 0), false, true, 400L);
        MiningWorkspaceSiteTraversalController.Step rejection =
            tick(missed, new VoxelCell(1, 14, 1), true, true, 500L);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REJECTED, rejection.outcome());
        assertEquals("descent_missed", rejection.reason());
    }

    @Test
    void landingInvalidationChangesFromStructuralRejectionToMissOnlyAfterDeparture() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 14, 0)
        );
        AtomicBoolean landingValid = new AtomicBoolean(true);

        MiningWorkspaceSiteTraversalController beforeDeparture = controller(route, 0L);
        tick(beforeDeparture, route.get(0), true, false, 100L);
        landingValid.set(false);
        MiningWorkspaceSiteTraversalController.Step structural = beforeDeparture.tick(
            MiningWorkspaceSiteTraversalController.Observation.centered(
                route.get(0),
                true,
                false
            ),
            cell -> !cell.equals(route.get(1)) || landingValid.get(),
            200L
        );
        assertEquals("route_invalidated", structural.reason());
        assertFalse(structural.descentDeparted());

        landingValid.set(true);
        MiningWorkspaceSiteTraversalController afterDeparture = controller(route, 0L);
        tick(afterDeparture, route.get(0), true, false, 100L);
        tick(afterDeparture, route.get(0), true, true, 200L);
        tick(afterDeparture, route.get(0), true, true, 300L);
        MiningWorkspaceSiteTraversalController.Step departed = tick(
            afterDeparture,
            new VoxelCell(1, 16, 0),
            false,
            true,
            400L
        );
        assertTrue(departed.descentDeparted());

        landingValid.set(false);
        MiningWorkspaceSiteTraversalController.Step committed = afterDeparture.tick(
            MiningWorkspaceSiteTraversalController.Observation.centered(
                new VoxelCell(1, 15, 0),
                false,
                true
            ),
            cell -> !cell.equals(route.get(1)) || landingValid.get(),
            450L
        );
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.HOLD_DESCENT, committed.outcome());
        assertEquals("descent_airborne_landing_invalidated", committed.reason());
        assertTrue(committed.forward());
        assertTrue(committed.descentExempt());

        MiningWorkspaceSiteTraversalController.Step missed = afterDeparture.tick(
            MiningWorkspaceSiteTraversalController.Observation.centered(
                new VoxelCell(1, 13, 0),
                true,
                true
            ),
            cell -> !cell.equals(route.get(1)) || landingValid.get(),
            500L
        );
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REJECTED, missed.outcome());
        assertEquals("descent_missed", missed.reason());
    }

    @Test
    void landingRequiresTwoDryBodyClearStablePolls() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 14, 0)
        );
        MiningWorkspaceSiteTraversalController controller = controller(route, 0L);
        tick(controller, route.get(0), true, false, 100L);
        tick(controller, route.get(0), true, true, 200L);
        tick(controller, route.get(0), true, true, 300L);
        tick(controller, new VoxelCell(1, 16, 0), false, true, 400L);
        tick(controller, route.get(1), true, true, 500L);

        MiningWorkspaceSiteTraversalController.Step unstable = tick(
            controller,
            MiningWorkspaceSiteTraversalController.Observation.centered(
                route.get(1),
                true,
                true,
                true,
                true,
                false
            ),
            550L
        );
        assertEquals("descent_landing_invalidated", unstable.reason());
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REJECTED, unstable.outcome());
    }

    @Test
    void descentAndRouteDeadlinesAreFixedAndLifecycleCleanupStopsEverything() {
        List<VoxelCell> descent = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 14, 0)
        );
        MiningWorkspaceSiteTraversalController descentTimeout = controller(descent, 0L);
        tick(descentTimeout, descent.get(0), true, false, 100L);
        assertEquals(
            "descent_timeout",
            tick(descentTimeout, descent.get(0), true, false, 3_100L).reason()
        );

        MiningWorkspaceSiteTraversalController hardDeadline = controller(line(2), 0L, 3_000L);
        assertEquals(
            "workspace_site_timeout",
            tick(hardDeadline, line(2).get(0), true, true, 3_000L).reason()
        );

        MiningWorkspaceSiteTraversalController cleared = controller(line(2), 0L);
        cleared.clear();
        MiningWorkspaceSiteTraversalController.Step idle =
            tick(cleared, line(2).get(0), true, true, 1L);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.IDLE, idle.outcome());
        assertFalse(idle.forward());
        assertFalse(idle.jump());
        assertFalse(idle.sneak());
        assertFalse(idle.descentExempt());
    }

    private static MiningWorkspaceSiteTraversalController controller(
        List<VoxelCell> route,
        long nowMs
    ) {
        return controller(route, nowMs, nowMs + 30_000L);
    }

    private static MiningWorkspaceSiteTraversalController controller(
        List<VoxelCell> route,
        long nowMs,
        long deadlineAtMs
    ) {
        MiningWorkspaceSiteTraversalController controller =
            new MiningWorkspaceSiteTraversalController();
        assertTrue(controller.begin(route, route.get(0), nowMs, deadlineAtMs));
        return controller;
    }

    private static MiningWorkspaceSiteTraversalController.Step tick(
        MiningWorkspaceSiteTraversalController controller,
        VoxelCell feet,
        boolean onGround,
        boolean aligned,
        long nowMs
    ) {
        return tick(
            controller,
            MiningWorkspaceSiteTraversalController.Observation.centered(
                feet,
                onGround,
                aligned
            ),
            nowMs
        );
    }

    private static MiningWorkspaceSiteTraversalController.Step tick(
        MiningWorkspaceSiteTraversalController controller,
        MiningWorkspaceSiteTraversalController.Observation observation,
        long nowMs
    ) {
        return controller.tick(observation, cell -> true, nowMs);
    }

    private static MiningWorkspaceSiteTraversalController.Observation observation(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean onGround,
        boolean aligned
    ) {
        return new MiningWorkspaceSiteTraversalController.Observation(
            feet,
            x,
            y,
            z,
            onGround,
            aligned,
            true,
            true,
            true
        );
    }

    private static List<VoxelCell> line(int length) {
        List<VoxelCell> route = new ArrayList<>();
        for (int index = 0; index < length; index++) {
            route.add(new VoxelCell(index, 16, 0));
        }
        return List.copyOf(route);
    }
}
