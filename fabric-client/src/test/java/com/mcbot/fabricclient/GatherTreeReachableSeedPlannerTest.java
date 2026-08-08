package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class GatherTreeReachableSeedPlannerTest {
    @Test
    void aggregateSearchSelectsLowestTargetIndependentOfCandidateOrder() {
        TestWorld world = new TestWorld(0, 8, 59, 68, 0, 1);
        world.support(0, 64, 0);
        world.support(1, 64, 0);
        for (int x = 2; x <= 8; x++) {
            world.support(x, 61, 0);
        }
        BlockPos nearbyHighLog = new BlockPos(0, 65, 1);
        BlockPos fartherLowLog = new BlockPos(8, 62, 0);

        GatherTreeReachableSeedPlanner.Result forward = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 65, 0),
            List.of(nearbyHighLog, fartherLowLog),
            1.0D
        );
        GatherTreeReachableSeedPlanner.Result reversed = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 65, 0),
            List.of(fartherLowLog, nearbyHighLog),
            1.0D
        );

        assertTrue(forward.found(), forward.failureReason());
        assertEquals(fartherLowLog, forward.plan().target());
        assertEquals(forward, reversed);
        assertEquals(2, forward.candidateCount());
    }

    @Test
    void ranksRouteThenReachThenTargetAndStanceCoordinatesDeterministically() {
        TestWorld routeWorld = levelWorld(0, 9, -2, 2, 64);
        GatherTreeReachableSeedPlanner.Plan shortestRoute = GatherTreeReachableSeedPlanner.plan(
            routeWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(8, 64, 0), new BlockPos(4, 64, 1)),
            2.0D
        ).plan();
        assertEquals(new BlockPos(4, 64, 1), shortestRoute.target());

        TestWorld reachWorld = levelWorld(-1, 4, -1, 4, 64);
        GatherTreeReachableSeedPlanner.Plan closestReach = GatherTreeReachableSeedPlanner.plan(
            reachWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(2, 64, 3), new BlockPos(3, 64, 0)),
            4.8D
        ).plan();
        assertEquals(new BlockPos(3, 64, 0), closestReach.target());
        assertEquals(List.of(new VoxelCell(0, 64, 0)), closestReach.route());

        TestWorld coordinateWorld = levelWorld(0, 6, -2, 2, 64);
        GatherTreeReachableSeedPlanner.Plan coordinate = GatherTreeReachableSeedPlanner.plan(
            coordinateWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(5, 64, 1), new BlockPos(5, 64, -1)),
            1.0D
        ).plan();
        assertEquals(new BlockPos(5, 64, -1), coordinate.target());
        assertEquals(new VoxelCell(4, 64, 0), coordinate.stance());

        TestWorld stanceWorld = new TestWorld(0, 4, 62, 67, -1, 1);
        stanceWorld.support(0, 63, 0);
        for (int x = 0; x <= 3; x++) {
            stanceWorld.support(x, 63, -1);
            stanceWorld.support(x, 63, 1);
        }
        GatherTreeReachableSeedPlanner.Plan stanceCoordinate = GatherTreeReachableSeedPlanner.plan(
            stanceWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(4, 64, 0)),
            1.0D
        ).plan();
        assertEquals(new VoxelCell(3, 64, -1), stanceCoordinate.stance());
    }

    @Test
    void traversesInitiallyLateralLShapedRoute() {
        TestWorld world = new TestWorld(0, 5, 62, 67, 0, 1);
        world.support(0, 63, 0);
        world.support(0, 63, 1);
        world.support(1, 63, 1);
        world.support(2, 63, 1);
        world.support(3, 63, 1);
        world.support(3, 63, 0);

        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(4, 64, 0)),
            1.0D
        );

        assertTrue(result.found(), result.failureReason());
        assertEquals(new VoxelCell(3, 64, 1), result.plan().stance());
        assertEquals(new VoxelCell(0, 64, 1), result.plan().route().get(1));
        assertTrue(result.plan().route().size() <= GatherTreeReachableSeedPlanner.MAX_ROUTE_CELLS);
    }

    @Test
    void supportsStepUpAndEachSafeDescentDepth() {
        TestWorld stepWorld = new TestWorld(0, 3, 62, 68, 0, 0);
        stepWorld.support(0, 63, 0);
        stepWorld.support(1, 64, 0);
        stepWorld.support(2, 64, 0);
        GatherTreeReachableSeedPlanner.Plan stepPlan = GatherTreeReachableSeedPlanner.plan(
            stepWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(3, 65, 0)),
            1.0D
        ).plan();
        assertEquals(new VoxelCell(1, 65, 0), stepPlan.route().get(1));

        for (int drop = 1; drop <= 3; drop++) {
            TestWorld world = new TestWorld(0, 3, 57, 67, 0, 0);
            world.support(0, 63, 0);
            world.support(1, 63, 0);
            world.support(2, 63 - drop, 0);
            int targetY = 64 - drop;

            GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
                world,
                new VoxelCell(0, 64, 0),
                List.of(new BlockPos(3, targetY, 0)),
                1.0D
            );

            assertTrue(result.found(), "drop=" + drop + " reason=" + result.failureReason());
            assertEquals(new VoxelCell(2, targetY, 0), result.plan().stance());
            assertEquals(new VoxelCell(2, targetY, 0), result.plan().route().get(2));
        }
    }

    @Test
    void routesAroundAnOverhangInsteadOfSelectingAnObstructedDescentColumn() {
        TestWorld world = new TestWorld(0, 5, 58, 67, 0, 1);
        world.floor(0, 3, 0, 0, 63);
        world.floor(0, 4, 1, 1, 60);
        for (int x = 1; x <= 3; x++) {
            world.solid(x, 63, 1);
            world.solid(x, 64, 1);
            world.solid(x, 65, 1);
        }

        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(5, 61, 1)),
            1.0D
        );

        assertTrue(result.found(), result.failureReason());
        assertEquals(new VoxelCell(0, 61, 1), result.plan().route().get(1));
        assertEquals(new VoxelCell(4, 61, 1), result.plan().stance());
    }

    @Test
    void enforcesActualInteractionRangeAndLineOfSight() {
        TestWorld boundary = levelWorld(0, 3, 0, 0, 64);
        BlockPos target = new BlockPos(3, 64, 0);

        GatherTreeReachableSeedPlanner.Result outside = GatherTreeReachableSeedPlanner.plan(
            boundary, new VoxelCell(0, 64, 0), List.of(target), 0.79D);
        GatherTreeReachableSeedPlanner.Result inside = GatherTreeReachableSeedPlanner.plan(
            boundary, new VoxelCell(0, 64, 0), List.of(target), 0.81D);

        assertFalse(outside.found());
        assertTrue(inside.found(), inside.failureReason());
        assertEquals(new VoxelCell(2, 64, 0), inside.plan().stance());

        TestWorld occluded = levelWorld(0, 4, 0, 0, 64);
        occluded.solid(2, 64, 0);
        occluded.solid(2, 65, 0);
        GatherTreeReachableSeedPlanner.Result blockedSight = GatherTreeReachableSeedPlanner.plan(
            occluded,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(4, 64, 0)),
            4.8D
        );
        assertFalse(blockedSight.found());
        assertEquals("no_reachable_break_stance", blockedSight.failureReason());
    }

    @Test
    void rejectsExcessiveDropBlockedBodyUnstableSupportAndHazard() {
        TestWorld excessiveDrop = new TestWorld(0, 3, 56, 67, 0, 0);
        excessiveDrop.support(0, 63, 0);
        excessiveDrop.support(1, 59, 0);
        assertNoReach(excessiveDrop, new BlockPos(3, 60, 0));

        TestWorld blockedBody = levelWorld(0, 3, 0, 0, 64);
        blockedBody.solid(1, 64, 0);
        blockedBody.solid(1, 65, 0);
        assertNoReach(blockedBody, new BlockPos(3, 64, 0));

        TestWorld unstable = new TestWorld(0, 3, 62, 67, 0, 0);
        unstable.support(0, 63, 0);
        unstable.support(2, 63, 0);
        assertNoReach(unstable, new BlockPos(3, 64, 0));

        TestWorld hazard = levelWorld(0, 3, 0, 0, 64);
        hazard.hazard(1, 63, 0);
        assertNoReach(hazard, new BlockPos(3, 64, 0));
    }

    @Test
    void rejectsWaterLavaAndAdjacentLavaRouteCells() {
        TestWorld water = levelWorld(0, 3, 0, 0, 64);
        water.water(1, 64, 0);
        assertNoReach(water, new BlockPos(3, 64, 0));

        TestWorld lava = levelWorld(0, 3, 0, 0, 64);
        lava.lava(1, 64, 0);
        assertNoReach(lava, new BlockPos(3, 64, 0));

        TestWorld adjacentLava = new TestWorld(0, 3, 62, 67, 0, 1);
        adjacentLava.floor(0, 3, 0, 0, 63);
        adjacentLava.lava(1, 64, 1);
        assertNoReach(adjacentLava, new BlockPos(3, 64, 0));
    }

    @Test
    void rejectsTargetCellAsTheOnlyGeometricStance() {
        TestWorld world = levelWorld(0, 1, 0, 0, 64);

        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(1, 64, 0)),
            0.1D
        );

        assertFalse(result.found());
        assertEquals("no_reachable_break_stance", result.failureReason());
    }

    @Test
    void excludesFailedStanceAndSelectsAnotherReachableCell() {
        TestWorld world = levelWorld(0, 5, -1, 1, 64);
        BlockPos target = new BlockPos(5, 64, 0);
        VoxelCell firstStance = new VoxelCell(4, 64, 0);

        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(target),
            4.8D,
            Set.of(firstStance)
        );

        assertTrue(result.found(), result.failureReason());
        assertFalse(firstStance.equals(result.plan().stance()));
    }

    @Test
    void classifiesNoCandidatesUnstandableStartAndRouteCellLimit() {
        TestWorld world = levelWorld(0, 40, 0, 0, 64);
        GatherTreeReachableSeedPlanner.Result noCandidates = GatherTreeReachableSeedPlanner.plan(
            world, new VoxelCell(0, 64, 0), List.of(), 4.8D);
        assertEquals("no_candidate_logs", noCandidates.failureReason());

        TestWorld blockedStart = new TestWorld(0, 2, 62, 67, 0, 0);
        GatherTreeReachableSeedPlanner.Result blocked = GatherTreeReachableSeedPlanner.plan(
            blockedStart,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(2, 64, 0)),
            4.8D
        );
        assertNull(blocked.plan());
        assertEquals("start_unstandable", blocked.failureReason());
        assertEquals(0, blocked.expandedCells());

        GatherTreeReachableSeedPlanner.Result routeLimited = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(40, 64, 0)),
            0.1D
        );
        assertFalse(routeLimited.found());
        assertTrue(routeLimited.frontierFound());
        assertEquals("", routeLimited.failureReason());

        GatherTreeReachableSeedPlanner.Result chainingDisabled = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(40, 64, 0)),
            0.1D,
            false
        );
        assertFalse(chainingDisabled.frontierFound());
        assertEquals("route_cell_limit", chainingDisabled.failureReason());
    }

    @Test
    void selectsOneBoundedProgressMakingFrontierDeterministically() {
        TestWorld world = levelWorld(0, 40, 0, 0, 64);
        BlockPos target = new BlockPos(40, 64, 0);

        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(target),
            0.1D
        );

        assertFalse(result.found());
        assertTrue(result.frontierFound(), result.failureReason());
        assertEquals(target, result.frontierPlan().target());
        assertEquals(new VoxelCell(0, 64, 0), result.frontierPlan().origin());
        assertEquals(new VoxelCell(31, 64, 0), result.frontierPlan().frontier());
        assertEquals(GatherTreeReachableSeedPlanner.MAX_ROUTE_CELLS, result.frontierPlan().route().size());
        assertEquals(31.0D, result.frontierPlan().netProgress(), 0.000_001D);
        assertTrue(
            result.frontierPlan().netProgress()
                >= GatherTreeReachableSeedPlanner.MIN_FRONTIER_HORIZONTAL_PROGRESS
        );
    }

    @Test
    void completeBreakStanceAlwaysWinsOverAFrontierOpportunity() {
        TestWorld world = levelWorld(0, 40, 0, 0, 64);
        BlockPos target = new BlockPos(3, 64, 0);

        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(target),
            0.81D
        );

        assertTrue(result.found(), result.failureReason());
        assertFalse(result.frontierFound());
        assertNull(result.frontierPlan());
        assertEquals(target, result.plan().target());
        assertEquals(new VoxelCell(2, 64, 0), result.plan().stance());

        GatherTreeReachableSeedPlanner.Result frontier = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(40, 64, 0)),
            0.1D
        );
        GatherTreeReachableSeedPlanner.Result malformedCoexistence =
            new GatherTreeReachableSeedPlanner.Result(
                result.plan(),
                frontier.frontierPlan(),
                "spurious_failure",
                result.expandedCells(),
                result.candidateCount()
            );
        assertTrue(malformedCoexistence.found());
        assertFalse(malformedCoexistence.frontierFound());
        assertNull(malformedCoexistence.frontierPlan());
        assertEquals("", malformedCoexistence.failureReason());
    }

    @Test
    void failedBreakStanceExclusionDoesNotRemoveASafeTraversalFrontier() {
        TestWorld world = levelWorld(0, 40, 0, 0, 64);
        VoxelCell bestFrontier = new VoxelCell(31, 64, 0);

        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(40, 64, 0)),
            0.1D,
            Set.of(bestFrontier)
        );

        assertTrue(result.frontierFound(), result.failureReason());
        assertEquals(bestFrontier, result.frontierPlan().frontier());
    }

    @Test
    void frontierRankingIsCandidateOrderIndependentAndHonorsTargetThenRouteOrdering() {
        TestWorld world = new TestWorld(0, 32, 62, 67, -32, 0);
        for (int x = 0; x <= 10; x++) {
            world.support(x, 63, 0);
        }
        for (int z = -32; z <= 0; z++) {
            world.support(0, 63, z);
        }
        BlockPos shorterRemainingLongRoute = new BlockPos(0, 64, -40);
        BlockPos longerRemainingShortRoute = new BlockPos(20, 64, 0);

        GatherTreeReachableSeedPlanner.Result forward = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(longerRemainingShortRoute, shorterRemainingLongRoute),
            0.1D
        );
        GatherTreeReachableSeedPlanner.Result reversed = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(shorterRemainingLongRoute, longerRemainingShortRoute),
            0.1D
        );

        assertEquals(forward, reversed);
        assertTrue(forward.frontierFound(), forward.failureReason());
        assertEquals(shorterRemainingLongRoute, forward.frontierPlan().target());
        assertEquals(9.0D, forward.frontierPlan().remainingDistance(), 0.000_001D);
        assertEquals(32, forward.frontierPlan().route().size());

        BlockPos equalRemainingLongRoute = new BlockPos(0, 64, -41);
        GatherTreeReachableSeedPlanner.Result routeTieBreak = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(longerRemainingShortRoute, equalRemainingLongRoute),
            0.1D
        );
        assertEquals(longerRemainingShortRoute, routeTieBreak.frontierPlan().target());
        assertEquals(11, routeTieBreak.frontierPlan().route().size());

        BlockPos lowerTarget = new BlockPos(50, 63, 0);
        GatherTreeReachableSeedPlanner.Result targetYFirst = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(shorterRemainingLongRoute, lowerTarget),
            0.1D
        );
        assertEquals(lowerTarget, targetYFirst.frontierPlan().target());
    }

    @Test
    void frontierCoordinateTieBreakAndVerticalTraversalStayDeterministic() {
        TestWorld coordinateWorld = new TestWorld(0, 32, 62, 67, 0, 32);
        for (int offset = 0; offset <= 32; offset++) {
            coordinateWorld.support(offset, 63, 0);
            coordinateWorld.support(0, 63, offset);
        }
        GatherTreeReachableSeedPlanner.Result coordinate = GatherTreeReachableSeedPlanner.plan(
            coordinateWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(40, 64, 40)),
            0.1D
        );
        assertTrue(coordinate.frontierFound(), coordinate.failureReason());
        assertEquals(new VoxelCell(31, 64, 0), coordinate.frontierPlan().frontier());

        TestWorld verticalWorld = new TestWorld(0, 32, 62, 68, 0, 0);
        verticalWorld.support(0, 63, 0);
        verticalWorld.support(1, 64, 0);
        for (int x = 2; x <= 32; x++) {
            verticalWorld.support(x, 63, 0);
        }
        GatherTreeReachableSeedPlanner.Result vertical = GatherTreeReachableSeedPlanner.plan(
            verticalWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(40, 64, 0)),
            0.1D
        );
        assertTrue(vertical.frontierFound(), vertical.failureReason());
        assertEquals(new VoxelCell(1, 65, 0), vertical.frontierPlan().route().get(1));
        assertEquals(new VoxelCell(2, 64, 0), vertical.frontierPlan().route().get(2));
        assertEquals(32, vertical.frontierPlan().route().size());
    }

    @Test
    void refusesNonproductiveFrontierAndSuppressesFrontierOnExpansionBudget() {
        TestWorld nonproductive = levelWorld(-40, 40, 0, 0, 64);
        GatherTreeReachableSeedPlanner.Result noProgress = GatherTreeReachableSeedPlanner.plan(
            nonproductive,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(0, 64, 0)),
            0.1D
        );
        assertFalse(noProgress.found());
        assertFalse(noProgress.frontierFound());
        assertEquals("route_cell_limit", noProgress.failureReason());

        TestWorld budgetWorld = levelWorld(-40, 40, -40, 40, 64);
        GatherTreeReachableSeedPlanner.Result budget = GatherTreeReachableSeedPlanner.plan(
            budgetWorld,
            new VoxelCell(0, 64, 0),
            List.of(new BlockPos(100, 64, 0)),
            0.1D,
            100
        );
        assertFalse(budget.found());
        assertFalse(budget.frontierFound());
        assertEquals("expanded_budget", budget.failureReason());
        assertEquals(100, budget.expandedCells());
    }

    @Test
    void sharesOneExpansionBudgetAcrossEveryCandidate() {
        TestWorld world = levelWorld(-30, 30, -30, 30, 64);
        List<BlockPos> candidates = new ArrayList<>();
        for (int index = 0; index < 50; index++) {
            candidates.add(new BlockPos(100 + index, 64, index - 25));
        }

        GatherTreeReachableSeedPlanner.Result first = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            candidates,
            0.1D,
            37
        );
        GatherTreeReachableSeedPlanner.Result reversed = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            candidates.reversed(),
            0.1D,
            37
        );

        assertEquals(2_048, GatherTreeReachableSeedPlanner.MAX_EXPANDED_CELLS);
        assertEquals("expanded_budget", first.failureReason());
        assertFalse(first.frontierFound());
        assertEquals(37, first.expandedCells());
        assertEquals(50, first.candidateCount());
        assertEquals(first, reversed);
    }

    private static void assertNoReach(TestWorld world, BlockPos target) {
        GatherTreeReachableSeedPlanner.Result result = GatherTreeReachableSeedPlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(target),
            1.0D
        );
        assertFalse(result.found(), result.toString());
    }

    private static TestWorld levelWorld(
        int minX,
        int maxX,
        int minZ,
        int maxZ,
        int feetY
    ) {
        TestWorld world = new TestWorld(minX, maxX, feetY - 2, feetY + 3, minZ, maxZ);
        world.floor(minX, maxX, minZ, maxZ, feetY - 1);
        return world;
    }

    private static final class TestWorld implements GatherWoodLocalEgressPerception {
        private final int minX;
        private final int maxX;
        private final int minY;
        private final int maxY;
        private final int minZ;
        private final int maxZ;
        private final Set<VoxelCell> solid = new HashSet<>();
        private final Set<VoxelCell> hazards = new HashSet<>();
        private final Set<VoxelCell> water = new HashSet<>();
        private final Set<VoxelCell> lava = new HashSet<>();

        private TestWorld(int minX, int maxX, int minY, int maxY, int minZ, int maxZ) {
            this.minX = minX;
            this.maxX = maxX;
            this.minY = minY;
            this.maxY = maxY;
            this.minZ = minZ;
            this.maxZ = maxZ;
        }

        private void floor(int fromX, int toX, int fromZ, int toZ, int y) {
            for (int x = fromX; x <= toX; x++) {
                for (int z = fromZ; z <= toZ; z++) {
                    support(x, y, z);
                }
            }
        }

        private void support(int x, int y, int z) {
            solid(x, y, z);
        }

        private void solid(int x, int y, int z) {
            solid.add(new VoxelCell(x, y, z));
        }

        private void hazard(int x, int y, int z) {
            hazards.add(new VoxelCell(x, y, z));
        }

        private void water(int x, int y, int z) {
            water.add(new VoxelCell(x, y, z));
        }

        private void lava(int x, int y, int z) {
            lava.add(new VoxelCell(x, y, z));
        }

        @Override
        public int minX() {
            return minX;
        }

        @Override
        public int maxX() {
            return maxX;
        }

        @Override
        public int minY() {
            return minY;
        }

        @Override
        public int maxY() {
            return maxY;
        }

        @Override
        public int minZ() {
            return minZ;
        }

        @Override
        public int maxZ() {
            return maxZ;
        }

        @Override
        public boolean isSolid(int x, int y, int z) {
            return solid.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isHazard(int x, int y, int z) {
            return hazards.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isWater(int x, int y, int z) {
            return water.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isLava(int x, int y, int z) {
            return lava.contains(new VoxelCell(x, y, z));
        }
    }
}
