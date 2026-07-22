package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class ExploreFrontierPlannerTest {
    @Test
    void blockedEndpointSelectsLateralReachableFrontier() {
        var world = levelWorld(-1, 6, -1, 4, 64);
        removeSupport(world, 1, 4, 0, 0, 63);
        VoxelCell start = new VoxelCell(0, 64, 0);

        ExploreFrontierPlanner.Result result = ExploreFrontierPlanner.plan(world, start, 4.5D, 0.5D);

        assertTrue(result.found(), result.failureReason());
        assertEquals(new VoxelCell(4, 64, -1), result.plan().frontier());
        assertTrue(result.plan().route().stream().anyMatch(cell -> cell.z() == -1));
        assertTrue(result.plan().netProgress() >= 2.0D);
    }

    @Test
    void initiallyAwayRouteIsAcceptedWhenEndpointMakesNetProgress() {
        var world = new VoxelAStarTest.TestVoxelWorld(-2, 5, 63, 66, -2, 0);
        for (int x = -2; x <= 5; x++) {
            world.support(x, 63, -2);
        }
        for (int z = -2; z <= 0; z++) {
            world.support(-2, 63, z);
        }
        world.support(-1, 63, 0);
        VoxelCell start = new VoxelCell(0, 64, 0);
        world.support(0, 63, 0);

        ExploreFrontierPlanner.Plan plan = ExploreFrontierPlanner.plan(world, start, 5.5D, 0.5D).plan();

        assertEquals(new VoxelCell(5, 64, -2), plan.frontier());
        assertEquals(new VoxelCell(-1, 64, 0), plan.route().get(1));
    }

    @Test
    void ranksRemainingDistanceThenRouteLengthVerticalAndCoordinates() {
        var distanceWorld = levelWorld(0, 5, -1, 1, 64);
        ExploreFrontierPlanner.Plan closest = ExploreFrontierPlanner.plan(
            distanceWorld, new VoxelCell(0, 64, 0), 6.5D, 0.5D).plan();
        assertEquals(new VoxelCell(5, 64, 0), closest.frontier());

        var routeWorld = new VoxelAStarTest.TestVoxelWorld(0, 4, 63, 66, -1, 1);
        routeWorld.support(0, 63, 0);
        routeWorld.support(1, 63, 0);
        routeWorld.support(2, 63, 0);
        routeWorld.support(3, 63, 0);
        routeWorld.support(2, 63, -1);
        ExploreFrontierPlanner.Plan shortest = ExploreFrontierPlanner.plan(
            routeWorld, new VoxelCell(0, 64, 0), 4.5D, 0.5D).plan();
        assertEquals(new VoxelCell(3, 64, 0), shortest.frontier());

        var coordinateWorld = levelWorld(0, 2, -1, 1, 64);
        ExploreFrontierPlanner.Plan coordinate = ExploreFrontierPlanner.plan(
            coordinateWorld, new VoxelCell(0, 64, 0), 3.5D, 0.5D).plan();
        assertEquals(new VoxelCell(2, 64, 0), coordinate.frontier());
    }

    @Test
    void supportsStepUpAndThreeBlockDescent() {
        var world = new VoxelAStarTest.TestVoxelWorld(0, 4, 60, 68, 0, 0);
        world.support(0, 63, 0);
        world.support(1, 64, 0);
        world.support(2, 64, 0);
        world.support(3, 61, 0);
        world.support(4, 61, 0);

        ExploreFrontierPlanner.Plan plan = ExploreFrontierPlanner.plan(
            world, new VoxelCell(0, 64, 0), 5.5D, 0.5D).plan();

        assertEquals(List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 65, 0),
            new VoxelCell(2, 65, 0),
            new VoxelCell(3, 62, 0),
            new VoxelCell(4, 62, 0)
        ), plan.route());
    }

    @Test
    void rejectsExcessiveDropHazardUnstableSupportAndBlockedBody() {
        var deep = new VoxelAStarTest.TestVoxelWorld(0, 2, 57, 66, 0, 0);
        deep.support(0, 63, 0);
        deep.support(1, 58, 0);
        assertFalse(ExploreFrontierPlanner.plan(deep, new VoxelCell(0, 64, 0), 4.5D, 0.5D).found());

        var hazard = levelWorld(0, 3, 0, 0, 64);
        hazard.hazard(1, 63, 0);
        assertFalse(ExploreFrontierPlanner.plan(hazard, new VoxelCell(0, 64, 0), 4.5D, 0.5D).found());

        var unstable = new VoxelAStarTest.TestVoxelWorld(0, 3, 63, 66, 0, 0);
        unstable.support(0, 63, 0);
        unstable.support(2, 63, 0);
        unstable.support(3, 63, 0);
        assertFalse(ExploreFrontierPlanner.plan(unstable, new VoxelCell(0, 64, 0), 4.5D, 0.5D).found());

        var body = levelWorld(0, 3, 0, 0, 64);
        body.support(1, 64, 0);
        body.support(1, 65, 0);
        assertFalse(ExploreFrontierPlanner.plan(body, new VoxelCell(0, 64, 0), 4.5D, 0.5D).found());
    }

    @Test
    void rejectsBoxedAndNonProgressingReachableAreas() {
        var boxed = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);
        boxed.support(0, 63, 0);
        assertFalse(ExploreFrontierPlanner.plan(boxed, new VoxelCell(0, 64, 0), 4.5D, 0.5D).found());

        var away = levelWorld(-3, 0, 0, 0, 64);
        ExploreFrontierPlanner.Result result = ExploreFrontierPlanner.plan(
            away, new VoxelCell(0, 64, 0), 4.5D, 0.5D);
        assertFalse(result.found());
        assertEquals("no_progress_frontier", result.failureReason());
    }

    @Test
    void unstandableStartReturnsClassifiedFailure() {
        var world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);

        ExploreFrontierPlanner.Result result = ExploreFrontierPlanner.plan(
            world, new VoxelCell(0, 64, 0), 3.5D, 0.5D);

        assertNull(result.plan());
        assertEquals("start_unstandable", result.failureReason());
        assertEquals(0, result.expandedNodes());
    }

    @Test
    void expansionBudgetIsHardAndDeterministic() {
        var world = levelWorld(-30, 30, -30, 30, 64);
        VoxelCell start = new VoxelCell(0, 64, 0);

        ExploreFrontierPlanner.Result first = ExploreFrontierPlanner.plan(world, start, 100.5D, 0.5D, 37);
        ExploreFrontierPlanner.Result second = ExploreFrontierPlanner.plan(world, start, 100.5D, 0.5D, 37);

        assertEquals(37, first.expandedNodes());
        assertEquals(first, second);
        assertTrue(first.expandedNodes() <= ExploreFrontierPlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void authorityAndControllerPredicatesStayNarrow() {
        assertTrue(ExploreFrontierPlanner.reasonAllowed("exploration:wood:leg_1:hop_1"));
        assertFalse(ExploreFrontierPlanner.reasonAllowed("gather_tree_search"));
        assertFalse(ExploreFrontierPlanner.reasonAllowed(null));
        assertTrue(ExploreFrontierPlanner.reached(new VoxelCell(1, 64, 2), new VoxelCell(1, 64, 2)));
        assertFalse(ExploreFrontierPlanner.reached(new VoxelCell(1, 64, 1), new VoxelCell(1, 64, 2)));
        assertTrue(ExploreFrontierPlanner.descendingStep(new VoxelCell(1, 64, 1), new VoxelCell(2, 62, 1)));
        assertFalse(ExploreFrontierPlanner.descendingStep(new VoxelCell(1, 64, 1), new VoxelCell(2, 64, 1)));
    }

    @Test
    void controllerStagesBeforeAProgressingDescentSoSafeDropReplansAtTheLip() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(2, 64, 0),
            new VoxelCell(3, 61, 0),
            new VoxelCell(4, 61, 0)
        );
        ExploreFrontierPlanner.Plan plan = new ExploreFrontierPlanner.Plan(
            route.getLast(), route, "reachable_frontier", 17, 5.0D, 1.0D);

        ExploreFrontierPlanner.Plan staged = ExploreFrontierPlanner.stageBeforeProgressingDescent(
            plan, 5.5D, 0.5D);

        assertEquals(new VoxelCell(2, 64, 0), staged.frontier());
        assertEquals(route.subList(0, 3), staged.route());
        assertEquals("safe_drop_staging_frontier", staged.reason());
        assertEquals(3.0D, staged.remainingDistance());
    }

    @Test
    void controllerRetainsLateralDescentAndDefersImmediateProgressingDescent() {
        List<VoxelCell> lateralRoute = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(1, 61, 1),
            new VoxelCell(3, 61, 1)
        );
        ExploreFrontierPlanner.Plan lateral = new ExploreFrontierPlanner.Plan(
            lateralRoute.getLast(), lateralRoute, "reachable_frontier", 12, 5.0D, 2.0D);
        assertEquals(lateral, ExploreFrontierPlanner.stageBeforeProgressingDescent(lateral, 5.5D, 0.5D));

        List<VoxelCell> earlyRoute = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 61, 0),
            new VoxelCell(4, 61, 0)
        );
        ExploreFrontierPlanner.Plan early = new ExploreFrontierPlanner.Plan(
            earlyRoute.getLast(), earlyRoute, "reachable_frontier", 9, 5.0D, 1.0D);
        assertNull(ExploreFrontierPlanner.stageBeforeProgressingDescent(early, 5.5D, 0.5D));
    }

    @Test
    void controllerPreservesRecoveryOrderCachingAimResetAndEdgeAuthority() {
        String reason = "exploration:wood:leg_1:hop_1";
        VoxelCell start = new VoxelCell(0, 64, 0);
        assertFalse(ExploreFrontierPlanner.shouldAttempt(reason, true, false, false));
        assertFalse(ExploreFrontierPlanner.shouldAttempt(reason, false, true, false));
        assertFalse(ExploreFrontierPlanner.shouldAttempt("gather_tree_search", false, false, false));
        assertTrue(ExploreFrontierPlanner.shouldAttempt(reason, false, false, false));
        assertFalse(ExploreFrontierPlanner.shouldAttempt(reason, false, false, true));
        assertEquals(ExploreFrontierPlanner.attemptKey("one", start), ExploreFrontierPlanner.attemptKey("one", start));
        assertFalse(ExploreFrontierPlanner.attemptKey("one", start)
            .equals(ExploreFrontierPlanner.attemptKey("one", new VoxelCell(1, 64, 0))));
        assertFalse(ExploreFrontierPlanner.routeStale(1_000L, 2_499L));
        assertTrue(ExploreFrontierPlanner.routeStale(1_000L, 2_500L));
        assertTrue(ExploreFrontierPlanner.aimAtFrontier(true, true));
        assertFalse(ExploreFrontierPlanner.aimAtFrontier(false, true));
        assertTrue(ExploreFrontierPlanner.commandChanged("one", "two"));
        assertFalse(ExploreFrontierPlanner.commandChanged("one", "one"));
        assertEquals("_nav3d_descend", ExploreFrontierPlanner.driveSuffix(true, true, false));
        assertEquals("_nav3d", ExploreFrontierPlanner.driveSuffix(true, false, true));
        assertEquals("_nav3d_descend", ExploreFrontierPlanner.driveSuffix(false, false, true));
        assertEquals("_nav3d", ExploreFrontierPlanner.driveSuffix(false, false, false));
    }

    private static VoxelAStarTest.TestVoxelWorld levelWorld(
        int minX,
        int maxX,
        int minZ,
        int maxZ,
        int feetY
    ) {
        var world = new VoxelAStarTest.TestVoxelWorld(minX, maxX, feetY - 1, feetY + 2, minZ, maxZ);
        world.floor(minX, maxX, minZ, maxZ, feetY - 1);
        return world;
    }

    private static void removeSupport(
        VoxelAStarTest.TestVoxelWorld world,
        int minX,
        int maxX,
        int minZ,
        int maxZ,
        int y
    ) {
        for (int x = minX; x <= maxX; x++) {
            for (int z = minZ; z <= maxZ; z++) {
                world.solid.remove(new VoxelCell(x, y, z));
            }
        }
    }
}
