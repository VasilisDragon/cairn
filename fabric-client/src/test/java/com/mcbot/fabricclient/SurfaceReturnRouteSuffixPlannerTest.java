package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class SurfaceReturnRouteSuffixPlannerTest {
    private static final int FEET_Y = 64;

    @Test
    void selectsExactWorkstationShapedLBypass() {
        TestWorld world = new TestWorld(288, 292, 13, 21, 353, 356);
        List<VoxelCell> connector = List.of(
            new VoxelCell(289, 16, 355),
            new VoxelCell(289, 16, 354),
            new VoxelCell(290, 17, 354),
            new VoxelCell(291, 18, 354),
            new VoxelCell(291, 18, 355)
        );
        supportPath(world, connector);
        world.workstation(290, 17, 355);
        List<VoxelCell> route = List.of(
            new VoxelCell(289, 16, 355),
            new VoxelCell(290, 17, 355),
            new VoxelCell(291, 18, 355)
        );

        SurfaceReturnRouteSuffixPlanner.Result result =
            SurfaceReturnRouteSuffixPlanner.plan(world, route, 1, world::isProtected);

        assertTrue(result.found(), result.failureReason());
        assertEquals(connector, result.connector());
        assertEquals(new VoxelCell(291, 18, 355), result.rejoinWaypoint());
        assertEquals(2, result.rejoinIndex());
        assertEquals(1, result.skippedCells());
        assertTrue(result.expandedCells() <= SurfaceReturnRouteSuffixPlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void selectsImmediateAndMidRouteForwardRejoins() {
        TestWorld immediate = levelWorld(-1, 3, -2, 1);
        immediate.removeSupport(1, 63, 0);
        SurfaceReturnRouteSuffixPlanner.Result first = SurfaceReturnRouteSuffixPlanner.plan(
            immediate,
            List.of(cell(0, 0), cell(1, 0), cell(2, 0)),
            1
        );
        assertTrue(first.found(), first.failureReason());
        assertEquals(2, first.rejoinIndex());
        assertEquals(List.of(
            cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(2, 0)
        ), first.connector());

        TestWorld midRoute = levelWorld(-1, 6, -2, 1);
        midRoute.removeSupport(3, 63, 0);
        SurfaceReturnRouteSuffixPlanner.Result second = SurfaceReturnRouteSuffixPlanner.plan(
            midRoute,
            List.of(
                cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), cell(4, 0), cell(5, 0)
            ),
            3
        );
        assertTrue(second.found(), second.failureReason());
        assertEquals(4, second.rejoinIndex());
        assertEquals(List.of(
            cell(2, 0), cell(2, -1), cell(3, -1), cell(4, -1), cell(4, 0)
        ), second.connector());
    }

    @Test
    void acceptsInitiallyLateralLevelStepUpAndOneBlockStepDownConnectors() {
        TestWorld lateral = new TestWorld(-1, 4, 60, 68, -2, 1);
        supportPath(lateral, List.of(
            cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(3, -1), cell(3, 0)
        ));
        SurfaceReturnRouteSuffixPlanner.Result lateralResult =
            SurfaceReturnRouteSuffixPlanner.plan(
                lateral,
                List.of(cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0)),
                1
            );
        assertTrue(lateralResult.found(), lateralResult.failureReason());
        assertEquals(cell(0, -1), lateralResult.connector().get(1));

        TestWorld stepUp = new TestWorld(-1, 3, 60, 68, -2, 1);
        supportPath(stepUp, List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(0, 64, -1),
            new VoxelCell(1, 65, -1),
            new VoxelCell(2, 65, -1),
            new VoxelCell(2, 65, 0)
        ));
        SurfaceReturnRouteSuffixPlanner.Result up = SurfaceReturnRouteSuffixPlanner.plan(
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
        SurfaceReturnRouteSuffixPlanner.Result down = SurfaceReturnRouteSuffixPlanner.plan(
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
    void ranksFewestSkippedCellsBeforeACloserLaterRejoinDeterministically() {
        TestWorld world = levelWorld(-1, 5, -2, 2);
        world.removeSupport(1, 63, 0);
        List<VoxelCell> route = List.of(
            cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), cell(4, 0)
        );

        SurfaceReturnRouteSuffixPlanner.Result first =
            SurfaceReturnRouteSuffixPlanner.plan(world, route, 1);
        SurfaceReturnRouteSuffixPlanner.Result second =
            SurfaceReturnRouteSuffixPlanner.plan(world, route, 1);

        assertTrue(first.found(), first.failureReason());
        assertEquals(2, first.rejoinIndex());
        assertEquals(1, first.skippedCells());
        assertEquals(first, second);
    }

    @Test
    void rejectsBlockedStartAndMissingForwardRejoin() {
        TestWorld blockedStart = basicBypassWorld();
        blockedStart.removeSupport(0, 63, 0);
        assertFailure("start_blocked", basicBypassPlan(blockedStart));

        TestWorld blockedRejoin = basicBypassWorld();
        blockedRejoin.workstation(2, 64, 0);
        assertFailure("no_forward_rejoin", basicBypassPlan(blockedRejoin));

        TestWorld outsideIndexWindow = levelWorld(-1, 20, -2, 1);
        outsideIndexWindow.removeSupport(1, 63, 0);
        List<VoxelCell> route = List.of(
            cell(0, 0),
            cell(1, 0),
            cell(10, 0), cell(11, 0), cell(12, 0), cell(13, 0),
            cell(14, 0), cell(15, 0), cell(16, 0), cell(17, 0),
            cell(2, 0)
        );
        assertFailure(
            "no_forward_rejoin",
            SurfaceReturnRouteSuffixPlanner.plan(outsideIndexWindow, route, 1)
        );
    }

    @Test
    void sealedLiveFixtureSourceHasNoSafeConnector() {
        TestWorld world = new TestWorld(288, 293, 13, 23, 354, 356);
        VoxelCell prior = new VoxelCell(289, 16, 355);
        VoxelCell source = new VoxelCell(290, 17, 355);
        VoxelCell invalid = new VoxelCell(291, 18, 355);
        VoxelCell rejoin = new VoxelCell(292, 19, 355);
        supportPath(world, List.of(prior, source, rejoin));
        world.workstation(invalid.x(), invalid.y(), invalid.z());
        for (int x = 290; x <= 292; x++) {
            for (int y = 14; y <= 22; y++) {
                world.support(x, y, 354);
                world.support(x, y, 356);
            }
        }
        // This is the live fixture's sole non-trail escape: a reversible step-down under the
        // table into the y16 workspace corridor. It is sealed only after that round trip ends.
        world.support(291, 16, 355);

        assertFailure(
            "no_safe_connector",
            SurfaceReturnRouteSuffixPlanner.plan(
                world,
                List.of(prior, source, invalid, rejoin),
                2,
                world::isProtected
            )
        );
    }

    @Test
    void rejectsUnstableHazardousWetLavaAdjacentAndProtectedBypassCells() {
        assertFailure("no_safe_connector", planWithBypassMutation(
            world -> world.removeSupport(1, 63, -1)
        ));
        assertFailure("no_safe_connector", planWithBypassMutation(
            world -> world.hazard(1, 63, -1)
        ));
        assertFailure("no_safe_connector", planWithBypassMutation(
            world -> world.water(1, 64, -1)
        ));
        assertFailure("no_safe_connector", planWithBypassMutation(
            world -> world.lava(1, 64, -2)
        ));
        assertFailure("no_safe_connector", planWithBypassMutation(
            world -> {
                world.workstation(1, 64, -1);
            }
        ));

        TestWorld protectedSupport = basicBypassWorld();
        protectedSupport.workstation(1, 63, -1);
        assertFailure(
            "no_safe_connector",
            SurfaceReturnRouteSuffixPlanner.plan(
                protectedSupport,
                List.of(cell(0, 0), cell(1, 0), cell(2, 0)),
                1,
                protectedSupport::isProtected
            )
        );
    }

    @Test
    void rejectsOneWayTwoBlockDropsAndFrozenTrailIntersections() {
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
            SurfaceReturnRouteSuffixPlanner.plan(
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
        assertFailure(
            "trail_intersection",
            SurfaceReturnRouteSuffixPlanner.plan(
                intersection,
                List.of(
                    cell(1, -1), cell(0, -1), cell(0, 0),
                    cell(1, 0), cell(2, 0), cell(3, 0)
                ),
                3
            )
        );
    }

    @Test
    void acceptsExactlyEightConnectorCellsAndRejectsNine() {
        TestWorld exact = new TestWorld(-1, 4, 60, 68, -3, 1);
        List<VoxelCell> eightCells = List.of(
            cell(0, 0), cell(0, -1), cell(0, -2), cell(1, -2),
            cell(2, -2), cell(3, -2), cell(3, -1), cell(3, 0)
        );
        supportPath(exact, eightCells);
        SurfaceReturnRouteSuffixPlanner.Result accepted =
            SurfaceReturnRouteSuffixPlanner.plan(
                exact,
                List.of(cell(0, 0), cell(1, 0), cell(3, 0)),
                1
            );
        assertTrue(accepted.found(), accepted.failureReason());
        assertEquals(SurfaceReturnRouteSuffixPlanner.MAX_CONNECTOR_CELLS,
            accepted.connector().size());

        TestWorld nine = new TestWorld(-1, 5, 60, 68, -4, 1);
        supportPath(nine, List.of(
            cell(0, 0), cell(0, -1), cell(0, -2), cell(0, -3),
            cell(1, -3), cell(2, -3), cell(3, -3), cell(4, -3),
            cell(4, -2), cell(4, -1), cell(4, 0)
        ));
        assertFailure(
            "route_cell_limit",
            SurfaceReturnRouteSuffixPlanner.plan(
                nine,
                List.of(cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), cell(4, 0)),
                1
            )
        );
    }

    @Test
    void enforcesManhattanVerticalAndExpansionBounds() {
        TestWorld open = levelWorld(-8, 8, -8, 8);
        open.removeSupport(1, 63, 0);

        assertFailure(
            "no_forward_rejoin",
            SurfaceReturnRouteSuffixPlanner.plan(
                open,
                List.of(cell(0, 0), cell(1, 0), cell(5, 0)),
                1
            )
        );

        TestWorld vertical = new TestWorld(-1, 3, 58, 70, -2, 1);
        supportPath(vertical, List.of(new VoxelCell(0, 64, 0), new VoxelCell(2, 67, 0)));
        assertFailure(
            "no_forward_rejoin",
            SurfaceReturnRouteSuffixPlanner.plan(
                vertical,
                List.of(
                    new VoxelCell(0, 64, 0),
                    new VoxelCell(1, 64, 0),
                    new VoxelCell(2, 67, 0)
                ),
                1
            )
        );

        List<VoxelCell> route = List.of(cell(0, 0), cell(1, 0), cell(4, 0));
        SurfaceReturnRouteSuffixPlanner.Result first =
            SurfaceReturnRouteSuffixPlanner.plan(open, route, 1, 2);
        SurfaceReturnRouteSuffixPlanner.Result second =
            SurfaceReturnRouteSuffixPlanner.plan(open, route, 1, 2);
        assertFailure("expanded_budget", first);
        assertEquals(2, first.expandedCells());
        assertEquals(first, second);
        assertTrue(first.expandedCells() <= SurfaceReturnRouteSuffixPlanner.MAX_EXPANDED_CELLS);
    }

    private static SurfaceReturnRouteSuffixPlanner.Result planWithBypassMutation(
        WorldMutation mutation
    ) {
        TestWorld world = basicBypassWorld();
        mutation.apply(world);
        return basicBypassPlan(world);
    }

    private static SurfaceReturnRouteSuffixPlanner.Result basicBypassPlan(TestWorld world) {
        return SurfaceReturnRouteSuffixPlanner.plan(
            world,
            List.of(cell(0, 0), cell(1, 0), cell(2, 0)),
            1,
            world::isProtected
        );
    }

    private static TestWorld basicBypassWorld() {
        TestWorld world = new TestWorld(-1, 3, 60, 68, -2, 1);
        supportPath(world, List.of(
            cell(0, 0), cell(0, -1), cell(1, -1), cell(2, -1), cell(2, 0)
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
        SurfaceReturnRouteSuffixPlanner.Result result
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
        private final Set<VoxelCell> protectedBlocks = new HashSet<>();

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

        void workstation(int x, int y, int z) {
            VoxelCell cell = new VoxelCell(x, y, z);
            solid.add(cell);
            protectedBlocks.add(cell);
        }

        boolean isProtected(VoxelCell cell) {
            return protectedBlocks.contains(cell);
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
