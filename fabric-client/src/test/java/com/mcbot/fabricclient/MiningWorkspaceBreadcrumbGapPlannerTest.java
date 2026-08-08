package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MiningWorkspaceBreadcrumbGapPlannerTest {
    private static final int FEET_Y = 64;

    @Test
    void safeDiagonalGapChoosesDeterministicNorthThenEastConnector() {
        TestWorld world = levelWorld(-1, 2, -2, 1);
        VoxelCell start = cell(0, 0);
        VoxelCell goal = cell(1, -1);

        MiningWorkspaceBreadcrumbGapPlanner.Result first =
            MiningWorkspaceBreadcrumbGapPlanner.plan(world, start, goal, List.of(start));
        MiningWorkspaceBreadcrumbGapPlanner.Result second =
            MiningWorkspaceBreadcrumbGapPlanner.plan(world, start, goal, List.of(start));

        assertTrue(first.found(), first.failureReason());
        assertEquals(List.of(start, cell(0, -1), goal), first.connector());
        assertEquals(first, second);
    }

    @Test
    void acceptsLevelStepUpAndStepDownOnlyWhenEachEdgeIsBidirectional() {
        TestWorld level = new TestWorld(-1, 2, 60, 68, -1, 1);
        level.support(0, 63, 0);
        level.support(1, 63, 0);
        assertEquals(
            List.of(new VoxelCell(0, 64, 0), new VoxelCell(1, 64, 0)),
            MiningWorkspaceBreadcrumbGapPlanner.plan(
                level,
                new VoxelCell(0, 64, 0),
                new VoxelCell(1, 64, 0),
                List.of(new VoxelCell(0, 64, 0))
            ).connector()
        );

        TestWorld stepUp = new TestWorld(-1, 2, 60, 68, -1, 1);
        stepUp.support(0, 63, 0);
        stepUp.support(1, 64, 0);
        assertEquals(
            List.of(new VoxelCell(0, 64, 0), new VoxelCell(1, 65, 0)),
            MiningWorkspaceBreadcrumbGapPlanner.plan(
                stepUp,
                new VoxelCell(0, 64, 0),
                new VoxelCell(1, 65, 0),
                List.of(new VoxelCell(0, 64, 0))
            ).connector()
        );

        TestWorld stepDown = new TestWorld(-1, 2, 60, 68, -1, 1);
        stepDown.support(0, 64, 0);
        stepDown.support(1, 63, 0);
        assertEquals(
            List.of(new VoxelCell(0, 65, 0), new VoxelCell(1, 64, 0)),
            MiningWorkspaceBreadcrumbGapPlanner.plan(
                stepDown,
                new VoxelCell(0, 65, 0),
                new VoxelCell(1, 64, 0),
                List.of(new VoxelCell(0, 65, 0))
            ).connector()
        );
    }

    @Test
    void acceptsInitiallyLateralDetourWithinEightCells() {
        TestWorld world = new TestWorld(-1, 3, 60, 68, -2, 1);
        world.support(0, 63, 0);
        world.support(0, 63, -1);
        world.support(1, 63, -1);
        world.support(2, 63, -1);
        world.support(2, 63, 0);

        MiningWorkspaceBreadcrumbGapPlanner.Result result = MiningWorkspaceBreadcrumbGapPlanner.plan(
            world, cell(0, 0), cell(2, 0), List.of(cell(0, 0)));

        assertTrue(result.found(), result.failureReason());
        assertEquals(
            List.of(cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(2, 0)),
            result.connector()
        );
    }

    @Test
    void rejectsTwoBlockOneWayDropAndUnsafeInteriorCells() {
        TestWorld drop = new TestWorld(-1, 2, 58, 68, -1, 1);
        drop.support(0, 63, 0);
        drop.support(1, 61, 0);
        assertFailure(
            "no_safe_connector",
            MiningWorkspaceBreadcrumbGapPlanner.plan(
                drop,
                new VoxelCell(0, 64, 0),
                new VoxelCell(1, 62, 0),
                List.of(new VoxelCell(0, 64, 0))
            )
        );

        TestWorld blockedBody = lineWorld();
        blockedBody.solid(1, 64, 0);
        blockedBody.solid(1, 65, 0);
        assertFailure("no_safe_connector", linePlan(blockedBody));

        TestWorld unstable = lineWorld();
        unstable.removeSupport(1, 63, 0);
        assertFailure("no_safe_connector", linePlan(unstable));

        TestWorld hazard = lineWorld();
        hazard.hazard(1, 63, 0);
        assertFailure("no_safe_connector", linePlan(hazard));

        TestWorld water = lineWorld();
        water.water(1, 64, 0);
        assertFailure("no_safe_connector", linePlan(water));

        TestWorld adjacentLava = new TestWorld(0, 2, 60, 68, -1, 1);
        adjacentLava.floor(0, 2, 0, 0, 63);
        adjacentLava.lava(1, 64, 1);
        assertFailure("no_safe_connector", linePlan(adjacentLava));
    }

    @Test
    void classifiesBlockedEndpointsAndBounds() {
        TestWorld world = levelWorld(-1, 8, -1, 1);
        world.removeSupport(0, 63, 0);
        assertFailure(
            "start_blocked",
            MiningWorkspaceBreadcrumbGapPlanner.plan(world, cell(0, 0), cell(1, 0), List.of())
        );

        TestWorld blockedGoal = levelWorld(-1, 3, -1, 1);
        blockedGoal.solid(2, 64, 0);
        blockedGoal.solid(2, 65, 0);
        assertFailure(
            "goal_blocked",
            MiningWorkspaceBreadcrumbGapPlanner.plan(
                blockedGoal, cell(0, 0), cell(2, 0), List.of(cell(0, 0)))
        );

        TestWorld far = levelWorld(-1, 8, -1, 1);
        assertFailure(
            "gap_out_of_bounds",
            MiningWorkspaceBreadcrumbGapPlanner.plan(far, cell(0, 0), cell(5, 0), List.of(cell(0, 0)))
        );
        assertFailure(
            "gap_out_of_bounds",
            MiningWorkspaceBreadcrumbGapPlanner.plan(
                far,
                new VoxelCell(0, 64, 0),
                new VoxelCell(1, 67, 0),
                List.of(new VoxelCell(0, 64, 0))
            )
        );
    }

    @Test
    void rejectsConnectorThatWouldIntersectExistingTrail() {
        TestWorld world = lineWorld();
        VoxelCell start = cell(0, 0);
        VoxelCell occupied = cell(1, 0);
        VoxelCell goal = cell(2, 0);

        MiningWorkspaceBreadcrumbGapPlanner.Result result = MiningWorkspaceBreadcrumbGapPlanner.plan(
            world, start, goal, List.of(occupied, start));

        assertFailure("existing_route_intersection", result);
        assertFailure(
            "existing_route_intersection",
            MiningWorkspaceBreadcrumbGapPlanner.plan(world, start, goal, List.of(goal, start))
        );
    }

    @Test
    void classifiesRouteCellLimitWithoutReturningPartialRoute() {
        TestWorld world = new TestWorld(-1, 5, 60, 68, -3, 1);
        List<VoxelCell> longPath = List.of(
            cell(0, 0),
            cell(0, -1),
            cell(0, -2),
            cell(1, -2),
            cell(2, -2),
            cell(3, -2),
            cell(4, -2),
            cell(4, -1),
            cell(4, 0)
        );
        for (VoxelCell cell : longPath) {
            world.support(cell.x(), cell.y() - 1, cell.z());
        }

        MiningWorkspaceBreadcrumbGapPlanner.Result result = MiningWorkspaceBreadcrumbGapPlanner.plan(
            world, longPath.getFirst(), longPath.getLast(), List.of(longPath.getFirst()));

        assertFailure("route_cell_limit", result);
        assertTrue(result.expandedCells() <= MiningWorkspaceBreadcrumbGapPlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void expansionBudgetIsHardAndDeterministic() {
        TestWorld world = levelWorld(-8, 8, -8, 8);
        VoxelCell start = cell(0, 0);
        VoxelCell goal = cell(4, 0);

        MiningWorkspaceBreadcrumbGapPlanner.Result first =
            MiningWorkspaceBreadcrumbGapPlanner.plan(world, start, goal, List.of(start), 2);
        MiningWorkspaceBreadcrumbGapPlanner.Result second =
            MiningWorkspaceBreadcrumbGapPlanner.plan(world, start, goal, List.of(start), 2);

        assertFailure("expanded_budget", first);
        assertEquals(2, first.expandedCells());
        assertEquals(first, second);
        assertTrue(first.expandedCells() <= MiningWorkspaceBreadcrumbGapPlanner.MAX_EXPANDED_CELLS);
    }

    private static MiningWorkspaceBreadcrumbGapPlanner.Result linePlan(TestWorld world) {
        return MiningWorkspaceBreadcrumbGapPlanner.plan(
            world, cell(0, 0), cell(2, 0), List.of(cell(0, 0)));
    }

    private static TestWorld lineWorld() {
        TestWorld world = new TestWorld(0, 2, 60, 68, 0, 0);
        world.floor(0, 2, 0, 0, 63);
        return world;
    }

    private static TestWorld levelWorld(int minX, int maxX, int minZ, int maxZ) {
        TestWorld world = new TestWorld(minX, maxX, 60, 68, minZ, maxZ);
        world.floor(minX, maxX, minZ, maxZ, 63);
        return world;
    }

    private static VoxelCell cell(int x, int z) {
        return new VoxelCell(x, FEET_Y, z);
    }

    private static void assertFailure(
        String reason,
        MiningWorkspaceBreadcrumbGapPlanner.Result result
    ) {
        assertFalse(result.found());
        assertTrue(result.connector().isEmpty());
        assertEquals(reason, result.failureReason());
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

        TestWorld(int minX, int maxX, int minY, int maxY, int minZ, int maxZ) {
            this.minX = minX;
            this.maxX = maxX;
            this.minY = minY;
            this.maxY = maxY;
            this.minZ = minZ;
            this.maxZ = maxZ;
        }

        void floor(int fromX, int toX, int fromZ, int toZ, int y) {
            for (int x = fromX; x <= toX; x++) {
                for (int z = fromZ; z <= toZ; z++) {
                    support(x, y, z);
                }
            }
        }

        void support(int x, int y, int z) {
            solid.add(new VoxelCell(x, y, z));
        }

        void removeSupport(int x, int y, int z) {
            solid.remove(new VoxelCell(x, y, z));
        }

        void solid(int x, int y, int z) {
            solid.add(new VoxelCell(x, y, z));
        }

        void hazard(int x, int y, int z) {
            hazards.add(new VoxelCell(x, y, z));
        }

        void water(int x, int y, int z) {
            water.add(new VoxelCell(x, y, z));
        }

        void lava(int x, int y, int z) {
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
            return !inBounds(x, y, z) || solid.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isHazard(int x, int y, int z) {
            return !inBounds(x, y, z) || hazards.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isWater(int x, int y, int z) {
            return water.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isLava(int x, int y, int z) {
            return !inBounds(x, y, z) || lava.contains(new VoxelCell(x, y, z));
        }
    }
}
