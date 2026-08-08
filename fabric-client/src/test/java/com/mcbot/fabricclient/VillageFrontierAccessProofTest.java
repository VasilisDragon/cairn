package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

final class VillageFrontierAccessProofTest {
    @Test
    void remoteVillageMarkerProvesOnlyOneBoundedForwardStage() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-4, 380, -4, 6, -4, 4);
        world.floor(-4, 380, -4, 4, 0);
        VoxelCell observer = new VoxelCell(0, 1, 0);
        VoxelCell marker = new VoxelCell(372, 1, 0);

        VillageFrontierAccessProof.Result result =
            VillageFrontierAccessProof.prove(world, observer, marker);

        assertTrue(result.routeReachable(), result.reason());
        assertTrue(result.frontier());
        assertEquals(VillageInteractionStancePlanner.MAX_ROUTE_CELLS, result.routeCells());
        assertTrue(result.expandedCells() <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void blockedOrUnstandableStartFailsClosed() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 80, -2, 5, -2, 2);
        VoxelCell observer = new VoxelCell(0, 1, 0);
        VoxelCell marker = new VoxelCell(72, 1, 0);

        VillageFrontierAccessProof.Result result =
            VillageFrontierAccessProof.prove(world, observer, marker);

        assertFalse(result.routeReachable());
        assertEquals("start_blocked", result.reason());
        assertTrue(result.expandedCells() <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void markerOutsideTransactionRadiusCannotBecomeReachable() {
        int boundary = (int) VillageOpportunityExecutor.MAX_SESSION_RADIUS;
        int beyond = boundary + 1;
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, beyond + 2, -2, 5, -2, 2);
        world.floor(-2, beyond + 2, -2, 2, 0);

        VillageFrontierAccessProof.Result atBoundary = VillageFrontierAccessProof.prove(
            world,
            new VoxelCell(0, 1, 0),
            new VoxelCell(boundary, 1, 0));
        VillageFrontierAccessProof.Result outside = VillageFrontierAccessProof.prove(
            world,
            new VoxelCell(0, 1, 0),
            new VoxelCell(beyond, 1, 0));

        assertTrue(atBoundary.routeReachable(), atBoundary.reason());
        assertFalse(outside.routeReachable());
        assertEquals("outside_session_radius", outside.reason());
        assertEquals(0, outside.expandedCells());
    }

    @Test
    void evaluateRejectsOutsideRadiusBeforeInvokingPlanner() {
        VillageFrontierAccessProof proof = new VillageFrontierAccessProof();
        AtomicInteger computations = new AtomicInteger();
        Object world = new Object();
        VoxelCell observer = new VoxelCell(0, 1, 0);
        VoxelCell boundary = new VoxelCell(
            (int) VillageOpportunityExecutor.MAX_SESSION_RADIUS, 1, 0);
        VoxelCell outside = new VoxelCell(boundary.x() + 1, 1, 0);
        java.util.function.Supplier<VillageFrontierAccessProof.Result> supplier = () -> {
            computations.incrementAndGet();
            return new VillageFrontierAccessProof.Result(true, 32, 128, true, "");
        };

        VillageFrontierAccessProof.Result accepted = proof.evaluate(
            world, "village-boundary", observer, boundary, 1L, 1_000L, supplier);
        VillageFrontierAccessProof.Result rejected = proof.evaluate(
            world, "village-outside", observer, outside, 1L, 1_000L, supplier);

        assertTrue(accepted.routeReachable());
        assertFalse(rejected.routeReachable());
        assertEquals("outside_session_radius", rejected.reason());
        assertEquals(1, computations.get());
    }

    @Test
    void proofIsMemoizedAndInputChangesFailClosedUntilThrottleExpires() {
        VillageFrontierAccessProof proof = new VillageFrontierAccessProof();
        AtomicInteger computations = new AtomicInteger();
        Object world = new Object();
        VoxelCell observer = new VoxelCell(0, 1, 0);
        VoxelCell moved = new VoxelCell(1, 1, 0);
        VoxelCell marker = new VoxelCell(72, 1, 0);
        java.util.function.Supplier<VillageFrontierAccessProof.Result> supplier = () -> {
            computations.incrementAndGet();
            return new VillageFrontierAccessProof.Result(true, 32, 128, true, "");
        };

        VillageFrontierAccessProof.Result first = proof.evaluate(
            world, "village-one", observer, marker, 1L, 1_000L, supplier);
        VillageFrontierAccessProof.Result cached = proof.evaluate(
            world, "village-one", observer, marker, 1L, 1_500L, supplier);
        VillageFrontierAccessProof.Result throttled = proof.evaluate(
            world, "village-one", moved, marker, 1L, 1_500L, supplier);
        VillageFrontierAccessProof.Result refreshed = proof.evaluate(
            world,
            "village-one",
            moved,
            marker,
            1L,
            1_000L + VillageFrontierAccessProof.REFRESH_INTERVAL_MS,
            supplier);

        assertTrue(first.routeReachable());
        assertEquals(first, cached);
        assertFalse(throttled.routeReachable());
        assertEquals("throttled_input_change", throttled.reason());
        assertTrue(refreshed.routeReachable());
        assertEquals(2, computations.get());
        assertEquals(1, proof.cachedDiscoveryCount());

        proof.clear();
        assertEquals(0, proof.cachedDiscoveryCount());
        assertTrue(proof.evaluate(
            world, "village-one", moved, marker, 1L, 2_100L, supplier).routeReachable());
        assertEquals(3, computations.get());
    }

    @Test
    void cacheHasAHardDiscoveryBound() {
        VillageFrontierAccessProof proof = new VillageFrontierAccessProof();
        Object world = new Object();
        VoxelCell observer = new VoxelCell(0, 1, 0);
        VoxelCell marker = new VoxelCell(72, 1, 0);
        for (int index = 0; index < VillageFrontierAccessProof.MAX_CACHED_DISCOVERIES + 5;
            index += 1) {
            proof.evaluate(
                world,
                "village-" + index,
                observer,
                marker,
                1L,
                1_000L,
                () -> new VillageFrontierAccessProof.Result(true, 32, 1, true, ""));
        }

        assertEquals(
            VillageFrontierAccessProof.MAX_CACHED_DISCOVERIES,
            proof.cachedDiscoveryCount());
    }
}
