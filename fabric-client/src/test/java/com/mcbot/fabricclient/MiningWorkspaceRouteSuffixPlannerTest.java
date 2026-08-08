package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MiningWorkspaceRouteSuffixPlannerTest {
    private static final int FEET_Y = 64;

    @Test
    void selectsImmediateForwardRejoinAroundInvalidWaypoint() {
        TestWorld world = levelWorld(-1, 3, -2, 1);
        world.removeSupport(1, 63, 0);
        List<VoxelCell> route = List.of(cell(0, 0), cell(1, 0), cell(2, 0));

        MiningWorkspaceRouteSuffixPlanner.Result result =
            MiningWorkspaceRouteSuffixPlanner.plan(world, route, 1);

        assertTrue(result.found(), result.failureReason());
        assertEquals(List.of(cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(2, 0)),
            result.connector());
        assertEquals(cell(2, 0), result.rejoinWaypoint());
        assertEquals(2, result.rejoinIndex());
        assertEquals(1, result.skippedCells());
    }

    @Test
    void selectsMidRouteForwardRejoinWithoutUsingFrozenPrefix() {
        TestWorld world = levelWorld(-1, 6, -2, 1);
        world.removeSupport(3, 63, 0);
        List<VoxelCell> route = List.of(
            cell(0, 0),
            cell(1, 0),
            cell(2, 0),
            cell(3, 0),
            cell(4, 0),
            cell(5, 0)
        );

        MiningWorkspaceRouteSuffixPlanner.Result result =
            MiningWorkspaceRouteSuffixPlanner.plan(world, route, 3);

        assertTrue(result.found(), result.failureReason());
        assertEquals(cell(4, 0), result.rejoinWaypoint());
        assertEquals(4, result.rejoinIndex());
        assertEquals(List.of(cell(2, 0), cell(2, -1), cell(3, -1), cell(4, -1), cell(4, 0)),
            result.connector());
    }

    @Test
    void acceptsInitiallyLateralBypass() {
        TestWorld world = new TestWorld(-1, 4, 60, 68, -2, 1);
        supportPath(world, List.of(
            cell(0, 0),
            cell(0, -1),
            cell(1, -1),
            cell(2, -1),
            cell(3, -1),
            cell(3, 0)
        ));
        List<VoxelCell> route = List.of(cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0));

        MiningWorkspaceRouteSuffixPlanner.Result result =
            MiningWorkspaceRouteSuffixPlanner.plan(world, route, 1);

        assertTrue(result.found(), result.failureReason());
        assertEquals(cell(3, 0), result.rejoinWaypoint());
        assertEquals(
            List.of(cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(3, -1), cell(3, 0)),
            result.connector()
        );
    }

    @Test
    void acceptsReversibleLevelStepUpAndOneBlockStepDownConnectors() {
        TestWorld level = new TestWorld(-1, 3, 60, 68, -2, 1);
        supportPath(level, List.of(cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(2, 0)));
        assertTrue(MiningWorkspaceRouteSuffixPlanner.plan(
            level,
            List.of(cell(0, 0), cell(1, 0), cell(2, 0)),
            1
        ).found());

        TestWorld stepUp = new TestWorld(-1, 3, 60, 68, -2, 1);
        supportPath(stepUp, List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(0, 64, -1),
            new VoxelCell(1, 65, -1),
            new VoxelCell(2, 65, -1),
            new VoxelCell(2, 65, 0)
        ));
        MiningWorkspaceRouteSuffixPlanner.Result up = MiningWorkspaceRouteSuffixPlanner.plan(
            stepUp,
            List.of(
                new VoxelCell(0, 64, 0),
                new VoxelCell(1, 64, 0),
                new VoxelCell(2, 65, 0)
            ),
            1
        );
        assertTrue(up.found(), up.failureReason());
        assertEquals(new VoxelCell(2, 65, 0), up.rejoinWaypoint());

        TestWorld stepDown = new TestWorld(-1, 3, 60, 68, -2, 1);
        supportPath(stepDown, List.of(
            new VoxelCell(0, 65, 0),
            new VoxelCell(0, 65, -1),
            new VoxelCell(1, 64, -1),
            new VoxelCell(2, 64, -1),
            new VoxelCell(2, 64, 0)
        ));
        MiningWorkspaceRouteSuffixPlanner.Result down = MiningWorkspaceRouteSuffixPlanner.plan(
            stepDown,
            List.of(
                new VoxelCell(0, 65, 0),
                new VoxelCell(1, 65, 0),
                new VoxelCell(2, 64, 0)
            ),
            1
        );
        assertTrue(down.found(), down.failureReason());
        assertEquals(new VoxelCell(2, 64, 0), down.rejoinWaypoint());
    }

    @Test
    void ranksFewerSkippedSuffixCellsBeforeShorterLaterConnector() {
        TestWorld world = levelWorld(-1, 5, -2, 2);
        world.removeSupport(1, 63, 0);
        List<VoxelCell> route = List.of(
            cell(0, 0),
            cell(1, 0),
            cell(2, 0),
            cell(3, 0),
            cell(4, 0)
        );

        MiningWorkspaceRouteSuffixPlanner.Result first =
            MiningWorkspaceRouteSuffixPlanner.plan(world, route, 1);
        MiningWorkspaceRouteSuffixPlanner.Result second =
            MiningWorkspaceRouteSuffixPlanner.plan(world, route, 1);

        assertTrue(first.found(), first.failureReason());
        assertEquals(2, first.rejoinIndex());
        assertEquals(1, first.skippedCells());
        assertEquals(first, second);
    }

    @Test
    void rejectsBlockedUnstableHazardousLiquidAndLavaAdjacentCells() {
        assertFailure("start_blocked", planWithStartMutation(world -> world.removeSupport(0, 63, 0)));
        assertFailure("no_forward_rejoin", planWithRejoinMutation(world -> {
            world.solid(2, 64, 0);
            world.solid(2, 65, 0);
        }));
        assertFailure("no_safe_connector", planWithBypassMutation(world -> world.removeSupport(1, 63, -1)));
        assertFailure("no_safe_connector", planWithBypassMutation(world -> world.hazard(1, 63, -1)));
        assertFailure("no_safe_connector", planWithBypassMutation(world -> world.water(1, 64, -1)));
        assertFailure("no_safe_connector", planWithBypassMutation(world -> world.lava(1, 64, -2)));
    }

    @Test
    void rejectsTwoBlockDropsAndFrozenRouteIntersections() {
        TestWorld drop = new TestWorld(-1, 3, 58, 68, -2, 1);
        supportPath(drop, List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(0, 64, -1),
            new VoxelCell(1, 62, -1),
            new VoxelCell(2, 62, -1),
            new VoxelCell(2, 62, 0)
        ));
        assertFailure(
            "no_safe_connector",
            MiningWorkspaceRouteSuffixPlanner.plan(
                drop,
                List.of(
                    new VoxelCell(0, 64, 0),
                    new VoxelCell(1, 64, 0),
                    new VoxelCell(2, 62, 0)
                ),
                1
            )
        );

        TestWorld intersection = new TestWorld(-2, 4, 60, 68, -2, 1);
        supportPath(intersection, List.of(
            cell(0, 0),
            cell(-1, 0),
            cell(-1, -1),
            cell(0, -1),
            cell(1, -1),
            cell(2, -1),
            cell(3, -1),
            cell(3, 0)
        ));
        List<VoxelCell> route = List.of(
            cell(1, -1),
            cell(0, -1),
            cell(0, 0),
            cell(1, 0),
            cell(2, 0),
            cell(3, 0)
        );
        assertFailure(
            "trail_intersection",
            MiningWorkspaceRouteSuffixPlanner.plan(intersection, route, 3)
        );
    }

    @Test
    void enforcesConnectorLengthAndExpansionBudgetsDeterministically() {
        TestWorld longRoute = new TestWorld(-1, 5, 60, 68, -4, 1);
        supportPath(longRoute, List.of(
            cell(0, 0),
            cell(0, -1),
            cell(0, -2),
            cell(0, -3),
            cell(1, -3),
            cell(2, -3),
            cell(3, -3),
            cell(4, -3),
            cell(4, -2),
            cell(4, -1),
            cell(4, 0)
        ));
        assertFailure(
            "route_cell_limit",
            MiningWorkspaceRouteSuffixPlanner.plan(
                longRoute,
                List.of(cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), cell(4, 0)),
                1
            )
        );

        TestWorld open = levelWorld(-8, 8, -8, 8);
        open.removeSupport(1, 63, 0);
        List<VoxelCell> activeRoute = List.of(cell(0, 0), cell(1, 0), cell(4, 0));
        MiningWorkspaceRouteSuffixPlanner.Result first =
            MiningWorkspaceRouteSuffixPlanner.plan(open, activeRoute, 1, 2);
        MiningWorkspaceRouteSuffixPlanner.Result second =
            MiningWorkspaceRouteSuffixPlanner.plan(open, activeRoute, 1, 2);

        assertFailure("expanded_budget", first);
        assertEquals(2, first.expandedCells());
        assertEquals(first, second);
        assertTrue(first.expandedCells() <= MiningWorkspaceRouteSuffixPlanner.MAX_EXPANDED_CELLS);
    }

    private static MiningWorkspaceRouteSuffixPlanner.Result planWithStartMutation(
        WorldMutation mutation
    ) {
        TestWorld world = basicBypassWorld();
        mutation.apply(world);
        return basicBypassPlan(world);
    }

    private static MiningWorkspaceRouteSuffixPlanner.Result planWithRejoinMutation(
        WorldMutation mutation
    ) {
        TestWorld world = basicBypassWorld();
        mutation.apply(world);
        return basicBypassPlan(world);
    }

    private static MiningWorkspaceRouteSuffixPlanner.Result planWithBypassMutation(
        WorldMutation mutation
    ) {
        TestWorld world = basicBypassWorld();
        mutation.apply(world);
        return basicBypassPlan(world);
    }

    private static MiningWorkspaceRouteSuffixPlanner.Result basicBypassPlan(TestWorld world) {
        return MiningWorkspaceRouteSuffixPlanner.plan(
            world,
            List.of(cell(0, 0), cell(1, 0), cell(2, 0)),
            1
        );
    }

    private static TestWorld basicBypassWorld() {
        TestWorld world = new TestWorld(-1, 3, 60, 68, -2, 1);
        supportPath(world, List.of(
            cell(0, 0),
            cell(0, -1),
            cell(1, -1),
            cell(2, -1),
            cell(2, 0)
        ));
        return world;
    }

    private static void supportPath(TestWorld world, List<VoxelCell> path) {
        for (VoxelCell stance : path) {
            world.support(stance.x(), stance.y() - 1, stance.z());
        }
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
        MiningWorkspaceRouteSuffixPlanner.Result result
    ) {
        assertFalse(result.found());
        assertTrue(result.connector().isEmpty());
        assertEquals(reason, result.failureReason());
    }

    @FunctionalInterface
    private interface WorldMutation {
        void apply(TestWorld world);
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
