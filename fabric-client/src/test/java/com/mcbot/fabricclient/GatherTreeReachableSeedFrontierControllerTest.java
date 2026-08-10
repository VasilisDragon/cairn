package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

final class GatherTreeReachableSeedFrontierControllerTest {
    private static final long DEADLINE_MS = 45_000L;

    @Test
    void beginsOnlyOneBoundedStageAndPreservesTheFixedDeadline() {
        GatherTreeReachableSeedFrontierController controller =
            new GatherTreeReachableSeedFrontierController();
        List<VoxelCell> route = line(32);

        assertTrue(controller.begin(route, route.get(0), 10_000L, DEADLINE_MS));
        assertTrue(controller.active());
        assertEquals(GatherTreeReachableSeedFrontierController.Phase.TRAVERSING,
            controller.phase());
        assertEquals(route, controller.route());
        assertEquals(route.get(31), controller.frontier());
        assertEquals(route.get(1), controller.activeWaypoint());
        assertEquals(DEADLINE_MS, controller.deadlineAtMs());
        assertEquals(35_000L, controller.remainingDeadlineMs(10_000L));

        assertFalse(controller.begin(route, route.get(0), 10_001L, DEADLINE_MS));
        assertFalse(new GatherTreeReachableSeedFrontierController().begin(
            List.of(route.get(0)), route.get(0), 0L, DEADLINE_MS));
        assertFalse(new GatherTreeReachableSeedFrontierController().begin(
            line(33), route.get(0), 0L, DEADLINE_MS));

        controller.clear();
        assertFalse(controller.active());
        assertFalse(controller.readyToReplan());
        assertEquals(GatherTreeReachableSeedFrontierController.Phase.IDLE,
            controller.phase());
        assertEquals(List.of(), controller.route());
        assertNull(controller.frontier());
        assertEquals(0L, controller.deadlineAtMs());
    }

    @Test
    void delegatesForwardOnlyCursorAndBoundedForwardResynchronization() {
        List<VoxelCell> route = line(6);
        GatherTreeReachableSeedFrontierController controller = controller(route);

        GatherTreeReachableSeedFrontierController.Step resynchronized = tick(
            controller, route.get(4), true, true, 100L);
        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.DRIVE,
            resynchronized.outcome());
        assertTrue(resynchronized.waypointAdvanced());
        assertTrue(resynchronized.forwardResynchronized());
        assertEquals(5, resynchronized.waypointIndex());
        assertEquals(4, resynchronized.maximumWaypointIndex());
        assertEquals(route.get(5), resynchronized.waypoint());

        GatherTreeReachableSeedFrontierController.Step earlier = tick(
            controller, route.get(2), true, true, 200L);
        assertEquals("earlier_cell_hold", earlier.reason());
        assertEquals(5, earlier.waypointIndex());
        assertEquals(4, earlier.maximumWaypointIndex());
        assertFalse(earlier.waypointAdvanced());
        assertFalse(earlier.forwardResynchronized());
    }

    @Test
    void reachesThenHoldsOneStoppedTickBeforeReplanBecomesReady() {
        List<VoxelCell> route = line(2);
        GatherTreeReachableSeedFrontierController controller = controller(route);

        GatherTreeReachableSeedFrontierController.Step reached = tick(
            controller, route.get(1), true, true, 100L);
        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.REACHED,
            reached.outcome());
        assertEquals(GatherTreeReachableSeedFrontierController.Phase.REACHED,
            reached.phase());
        assertEquals("frontier_reached", reached.reason());
        assertEquals("reached", reached.motorReason());
        assertTrue(reached.stopped());
        assertTrue(controller.active());
        assertFalse(controller.readyToReplan());

        GatherTreeReachableSeedFrontierController.Step stopped = tick(
            controller, route.get(1), true, true, 150L);
        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.HOLD_AT_FRONTIER,
            stopped.outcome());
        assertEquals(GatherTreeReachableSeedFrontierController.Phase.STOPPED,
            stopped.phase());
        assertEquals("frontier_stop_tick", stopped.reason());
        assertTrue(stopped.stopped());
        assertEquals(1, stopped.stoppedTicksAfterReach());
        assertFalse(controller.readyToReplan());

        GatherTreeReachableSeedFrontierController.Step ready = tick(
            controller, route.get(1), true, true, 200L);
        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.READY_TO_REPLAN,
            ready.outcome());
        assertEquals(GatherTreeReachableSeedFrontierController.Phase.READY_TO_REPLAN,
            ready.phase());
        assertEquals("frontier_ready_to_replan", ready.reason());
        assertTrue(ready.stopped());
        assertTrue(controller.readyToReplan());
        assertFalse(controller.active());

        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.IDLE,
            tick(controller, route.get(1), true, true, 250L).outcome());
    }

    @Test
    void revalidatesTheExactGroundedFrontierDuringStoppedHandoff() {
        List<VoxelCell> route = line(2);

        GatherTreeReachableSeedFrontierController departed = controller(route);
        tick(departed, route.get(1), true, true, 100L);
        GatherTreeReachableSeedFrontierController.Step departure = tick(
            departed, route.get(0), true, true, 150L);
        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.REJECTED,
            departure.outcome());
        assertEquals("frontier_departed_after_reach", departure.reason());

        GatherTreeReachableSeedFrontierController airborne = controller(route);
        tick(airborne, route.get(1), true, true, 100L);
        assertEquals("frontier_departed_after_reach",
            tick(airborne, route.get(1), false, true, 150L).reason());

        GatherTreeReachableSeedFrontierController invalidated = controller(route);
        tick(invalidated, route.get(1), true, true, 100L);
        GatherTreeReachableSeedFrontierController.Step invalid = invalidated.tick(
            GatherTreeBreakStanceTraversalController.Observation.centered(
                route.get(1), true, true),
            cell -> !cell.equals(route.get(1)),
            150L
        );
        assertEquals("frontier_invalidated_after_reach", invalid.reason());
        assertEquals(GatherTreeReachableSeedFrontierController.Phase.REJECTED,
            invalid.phase());
    }

    @Test
    void fixedDeadlineDoesNotResetAcrossArrivalAndStoppedTick() {
        List<VoxelCell> route = line(2);
        GatherTreeReachableSeedFrontierController controller = controller(route);

        GatherTreeReachableSeedFrontierController.Step reached = tick(
            controller, route.get(1), true, true, DEADLINE_MS - 100L);
        assertEquals(100L, reached.remainingDeadlineMs());
        GatherTreeReachableSeedFrontierController.Step stopped = tick(
            controller, route.get(1), true, true, DEADLINE_MS - 50L);
        assertEquals(50L, stopped.remainingDeadlineMs());

        GatherTreeReachableSeedFrontierController.Step rejected = tick(
            controller, route.get(1), true, true, DEADLINE_MS);
        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.REJECTED,
            rejected.outcome());
        assertEquals("frontier_deadline", rejected.reason());
        assertEquals(0L, rejected.remainingDeadlineMs());
        assertEquals(DEADLINE_MS, controller.deadlineAtMs());
        assertFalse(controller.readyToReplan());
    }

    @Test
    void preservesCommittedDescentControlsAndNarrowExemption() {
        VoxelCell origin = new VoxelCell(0, 64, 0);
        VoxelCell landing = new VoxelCell(1, 62, 0);
        VoxelCell frontier = new VoxelCell(2, 62, 0);
        List<VoxelCell> route = List.of(origin, landing, frontier);
        GatherTreeReachableSeedFrontierController controller = controller(route);

        GatherTreeReachableSeedFrontierController.Step selected = controller.tick(
            descentLip(origin, landing, false), cell -> true, 100L);
        assertEquals("descent_selected", selected.reason());
        assertFalse(selected.descentExempt());

        GatherTreeReachableSeedFrontierController.Step settling = tick(
            controller, origin, true, false, 200L);
        assertEquals("descent_lip_settling", settling.reason());
        assertFalse(settling.descentExempt());

        GatherTreeReachableSeedFrontierController.Step launching = tick(
            controller, origin, true, true, 250L);
        assertTrue(launching.descentStarted());
        assertTrue(launching.forward());
        assertTrue(launching.descentExempt());

        GatherTreeReachableSeedFrontierController.Step landed = tick(
            controller, landing, true, true, 300L);
        assertTrue(landed.descentLanded());
        assertFalse(landed.descentExempt());

        GatherTreeReachableSeedFrontierController.Step committed = tick(
            controller, landing, true, true, 350L);
        assertEquals("descent_landing_committed", committed.reason());
        assertFalse(committed.descentExempt());

        GatherTreeReachableSeedFrontierController.Step reached = tick(
            controller, frontier, true, true, 400L);
        assertEquals(GatherTreeReachableSeedFrontierController.Outcome.REACHED,
            reached.outcome());
        assertEquals(2, reached.maximumWaypointIndex());
    }

    private static GatherTreeReachableSeedFrontierController controller(
        List<VoxelCell> route
    ) {
        GatherTreeReachableSeedFrontierController controller =
            new GatherTreeReachableSeedFrontierController();
        assertTrue(controller.begin(route, route.get(0), 0L, DEADLINE_MS));
        return controller;
    }

    private static GatherTreeReachableSeedFrontierController.Step tick(
        GatherTreeReachableSeedFrontierController controller,
        VoxelCell feet,
        boolean onGround,
        boolean aligned,
        long nowMs
    ) {
        return controller.tick(
            GatherTreeBreakStanceTraversalController.Observation.centered(
                feet, onGround, aligned),
            cell -> true,
            nowMs
        );
    }

    private static GatherTreeBreakStanceTraversalController.Observation descentLip(
        VoxelCell origin,
        VoxelCell landing,
        boolean aligned
    ) {
        return new GatherTreeBreakStanceTraversalController.Observation(
            origin,
            origin.x() + 0.5D + ((landing.x() - origin.x()) * 0.49D),
            origin.y(),
            origin.z() + 0.5D + ((landing.z() - origin.z()) * 0.49D),
            true,
            aligned
        );
    }

    private static List<VoxelCell> line(int length) {
        List<VoxelCell> result = new ArrayList<>();
        for (int index = 0; index < length; index++) {
            result.add(new VoxelCell(index, 64, 0));
        }
        return List.copyOf(result);
    }
}
