package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

final class VillageLocalRouteControllerTest {
    private static final VoxelCell START = new VoxelCell(0, 1, 0);
    private static final VoxelCell MID = new VoxelCell(1, 1, 0);
    private static final VoxelCell END = new VoxelCell(2, 1, 0);

    @Test
    void advancesMonotonicallyAndReachesAfterStableArrival() {
        VillageLocalRouteController controller = new VillageLocalRouteController();
        assertTrue(controller.begin("cmd", List.of(START, MID, END), START, 0L));
        var drive = controller.tick("cmd", observation(START, true), cell -> true, 10L);
        assertNotNull(drive);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.DRIVE, drive.outcome());

        var advanced = controller.tick("cmd", observation(MID, true), cell -> true, 100L);
        assertTrue(advanced.waypointAdvanced());
        controller.tick("cmd", observation(END, true), cell -> true, 200L);
        assertEquals(null, controller.activeWaypoint());
        assertTrue(controller.finalArrivalPendingAt(END));
        assertFalse(controller.finalArrivalPendingAt(MID));
        var reached = controller.tick("cmd", observation(END, true), cell -> true, 250L);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REACHED, reached.outcome());
    }

    @Test
    void allowsOnlyOneReplanAndPreservesDeadline() {
        VillageLocalRouteController controller = new VillageLocalRouteController();
        long fixedDeadline = 10_000L;
        assertTrue(controller.begin(
            "cmd", List.of(START, MID), START, 0L, fixedDeadline));
        assertTrue(controller.replan(List.of(START, MID, END), START, 1_000L));
        assertEquals(2, controller.computations());
        assertFalse(controller.replan(List.of(START, MID), START, 2_000L));

        var timeout = controller.tick(
            "cmd", observation(START, true), cell -> true,
            fixedDeadline);
        assertEquals(MiningWorkspaceSiteTraversalController.Outcome.REJECTED, timeout.outcome());
    }

    @Test
    void commandMismatchAndOversizedRouteFailClosed() {
        VillageLocalRouteController controller = new VillageLocalRouteController();
        assertTrue(controller.begin("cmd", List.of(START, MID), START, 0L));
        assertEquals(null, controller.tick("other", observation(START, true), cell -> true, 1L));
        controller.clear();
        List<VoxelCell> oversized = java.util.stream.IntStream
            .range(0, VillageInteractionStancePlanner.MAX_ROUTE_CELLS + 1)
            .mapToObj(index -> new VoxelCell(index, 1, 0))
            .toList();
        assertFalse(controller.begin("cmd", oversized, START, 0L));
    }

    @Test
    void defersOneReplanUntilTwoSafeGroundedPolls() {
        VillageLocalRouteController controller = new VillageLocalRouteController();
        assertTrue(controller.begin("cmd", List.of(START, MID), START, 0L));
        controller.deferReplan("descent_missed", 100L);

        assertEquals(VillageLocalRouteController.ReplanReadiness.WAITING,
            controller.observeReplanReadiness(false, 150L));
        assertEquals(VillageLocalRouteController.ReplanReadiness.WAITING,
            controller.observeReplanReadiness(true, 200L));
        assertEquals(VillageLocalRouteController.ReplanReadiness.READY,
            controller.observeReplanReadiness(true, 250L));
        assertEquals("descent_missed", controller.rejectedReason());
        assertTrue(controller.replan(List.of(START, MID), START, 300L));
        assertFalse(controller.replanPending());
    }

    @Test
    void unsafeReplanOriginTimesOutWithoutSpendingComputation() {
        VillageLocalRouteController controller = new VillageLocalRouteController();
        assertTrue(controller.begin("cmd", List.of(START, MID), START, 0L));
        controller.deferReplan("route_deviation", 100L);

        assertEquals(VillageLocalRouteController.ReplanReadiness.TIMED_OUT,
            controller.observeReplanReadiness(
                false, 100L + VillageLocalRouteController.REPLAN_SETTLE_TIMEOUT_MS));
        assertEquals(1, controller.computations());
    }

    private static MiningWorkspaceSiteTraversalController.Observation observation(
        VoxelCell feet,
        boolean aligned
    ) {
        return MiningWorkspaceSiteTraversalController.Observation.centered(
            feet, true, aligned, true, true, true);
    }
}
