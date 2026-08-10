package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class SurfaceReturnRouteSuffixRepairTest {
    @Test
    void atomicallyPersistsReversedSpliceAndPreservesTraversalClocksAndCursor() {
        Fixture fixture = fixture();
        ReturnStaircaseTraversalController.RouteSnapshot before =
            fixture.traversal.routeSnapshot();

        SurfaceReturnRouteSuffixRepair.Result result = SurfaceReturnRouteSuffixRepair.apply(
            fixture.store,
            fixture.traversal,
            fixture.store.sessionRevision(),
            fixture.store.trailRevision(),
            fixture.anchor,
            fixture.canonical,
            before,
            fixture.plan
        );

        assertTrue(result.repaired(), result.reason());
        assertEquals(SurfaceReturnTrailStore.TrailReplaceResult.REPLACED.name(), result.storeResult());
        List<VoxelCell> repairedActive = List.of(
            cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(2, 0), cell(3, 0)
        );
        assertEquals(reversed(repairedActive), fixture.store.trail());
        assertEquals(result.trailRevisionBefore() + 1L, result.trailRevisionAfter());
        assertEquals(fixture.anchor, fixture.store.anchor());
        assertEquals(cell(0, 0), fixture.store.frontier());

        ReturnStaircaseTraversalController.RouteSnapshot after =
            fixture.traversal.routeSnapshot();
        assertEquals(repairedActive, after.route());
        assertEquals(before.waypointIndex(), after.waypointIndex());
        assertEquals(before.maximumWaypointIndex(), after.maximumWaypointIndex());
        assertEquals(before.stableFeet(), after.stableFeet());
        assertEquals(before.startedAtMs(), after.startedAtMs());
        assertEquals(before.deadlineAtMs(), after.deadlineAtMs());
        assertEquals(before.lastProgressAtMs(), after.lastProgressAtMs());
        assertEquals(ReturnStaircaseTraversalController.TransitionKind.NONE, after.transitionKind());
        assertEquals(ReturnStaircaseTraversalController.TransitionPhase.NONE, after.transitionPhase());
    }

    @Test
    void staleTrailRejectionLeavesStoreAndControllerByteEquivalent() {
        Fixture fixture = fixture();
        ReturnStaircaseTraversalController.RouteSnapshot before =
            fixture.traversal.routeSnapshot();
        List<VoxelCell> storeBefore = fixture.store.trail();
        long revisionBefore = fixture.store.trailRevision();

        SurfaceReturnRouteSuffixRepair.Result result = SurfaceReturnRouteSuffixRepair.apply(
            fixture.store,
            fixture.traversal,
            fixture.store.sessionRevision(),
            revisionBefore - 1L,
            fixture.anchor,
            fixture.canonical,
            before,
            fixture.plan
        );

        assertFalse(result.repaired());
        assertEquals("stale_trail", result.reason());
        assertEquals(SurfaceReturnTrailStore.TrailReplaceResult.STALE_TRAIL.name(), result.storeResult());
        assertEquals(storeBefore, fixture.store.trail());
        assertEquals(revisionBefore, fixture.store.trailRevision());
        assertEquals(before, fixture.traversal.routeSnapshot());
    }

    @Test
    void staleControllerSnapshotRejectsBeforeStoreMutation() {
        Fixture fixture = fixture();
        ReturnStaircaseTraversalController.RouteSnapshot before =
            fixture.traversal.routeSnapshot();
        assertEquals(
            ReturnStaircaseTraversalController.Outcome.HOLD,
            fixture.traversal.tick(
                ReturnStaircaseTraversalController.Observation.centered(
                    cell(1, 0), true, true, true, true
                ),
                ignored -> true,
                200L
            ).outcome()
        );
        fixture.traversal.tick(
            ReturnStaircaseTraversalController.Observation.centered(
                cell(1, 0), true, true, true, true
            ),
            ignored -> true,
            250L
        );
        List<VoxelCell> storeBefore = fixture.store.trail();
        long revisionBefore = fixture.store.trailRevision();

        SurfaceReturnRouteSuffixRepair.Result result = SurfaceReturnRouteSuffixRepair.apply(
            fixture.store,
            fixture.traversal,
            fixture.store.sessionRevision(),
            revisionBefore,
            fixture.anchor,
            fixture.canonical,
            before,
            fixture.plan
        );

        assertFalse(result.repaired());
        assertEquals("stale_traversal", result.reason());
        assertEquals("NOT_ATTEMPTED", result.storeResult());
        assertEquals(storeBefore, fixture.store.trail());
        assertEquals(revisionBefore, fixture.store.trailRevision());
    }

    private static Fixture fixture() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-1, 4, 60, 67, -2, 1);
        world.floor(-1, 4, -2, 1, 63);
        VoxelCell anchor = cell(3, 0);
        List<VoxelCell> canonical = List.of(anchor, cell(2, 0), cell(1, 0), cell(0, 0));
        SurfaceReturnTrailStore store = new SurfaceReturnTrailStore();
        store.observeContext("world", "overworld");
        assertEquals(
            SurfaceReturnTrailStore.StartResult.STARTED,
            store.startSession("descent", anchor, true, world)
        );
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.APPENDED,
            store.appendCompletedSegment(world, canonical)
        );

        List<VoxelCell> active = reversed(canonical);
        ReturnStaircaseTraversalController traversal = new ReturnStaircaseTraversalController();
        assertTrue(traversal.begin(active, active.getFirst(), 100L, 10_000L));
        List<VoxelCell> connector = List.of(
            cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(2, 0)
        );
        SurfaceReturnRouteSuffixPlanner.Result plan =
            new SurfaceReturnRouteSuffixPlanner.Result(
                connector, cell(2, 0), 2, 1, "", 8
            );
        return new Fixture(store, traversal, anchor, canonical, plan);
    }

    private static VoxelCell cell(int x, int z) {
        return new VoxelCell(x, 64, z);
    }

    private static List<VoxelCell> reversed(List<VoxelCell> route) {
        java.util.ArrayList<VoxelCell> result = new java.util.ArrayList<>(route);
        java.util.Collections.reverse(result);
        return List.copyOf(result);
    }

    private record Fixture(
        SurfaceReturnTrailStore store,
        ReturnStaircaseTraversalController traversal,
        VoxelCell anchor,
        List<VoxelCell> canonical,
        SurfaceReturnRouteSuffixPlanner.Result plan
    ) {
    }
}
