package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class RouteHeadingPlannerTest {
    @Test
    void selectsAtMostTwoCellsAheadOnASafeStraightRoute() {
        TestWorld world = flatWorld();
        List<VoxelCell> route = route(
            cell(0, 0), cell(0, 1), cell(0, 2), cell(0, 3), cell(0, 4));

        RouteHeadingPlanner.Plan plan = RouteHeadingPlanner.plan(
            world, route, 1, 0.5D, 0.5D, 1.0D);

        assertEquals(RouteHeadingPlanner.Kind.STRAIGHT_LOOKAHEAD, plan.kind());
        assertEquals(3, plan.aimIndex());
        assertEquals(cell(0, 3), plan.aimCell());
        assertEquals(0.0D, plan.desiredYaw(), 0.0001D);
        assertTrue(plan.preserveForward());
        assertTrue(plan.sprintEligible());
        assertEquals("", plan.suppressionReason());
    }

    @Test
    void validatesTheFourthCellBeforeRoundingAWideCorner() {
        TestWorld world = flatWorld();
        List<VoxelCell> route = route(
            cell(0, 0), cell(0, 1), cell(1, 1), cell(2, 1), cell(3, 1));

        RouteHeadingPlanner.Plan plan = RouteHeadingPlanner.plan(
            world, route, 1, 0.5D, 0.5D, 1.0D);

        assertEquals(RouteHeadingPlanner.Kind.WIDE_CORNER, plan.kind());
        assertEquals(2, plan.aimIndex());
        assertEquals(cell(1, 1), plan.aimCell());
        assertEquals(-41.9872D, plan.desiredYaw(), 0.001D);
        assertTrue(plan.preserveForward());
        assertTrue(plan.sprintEligible());
    }

    @Test
    void upcomingWideCornerAimsInsideTheCornerArrivalEnvelope() {
        TestWorld world = flatWorld();
        List<VoxelCell> route = route(
            cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 2), cell(2, 2));

        RouteHeadingPlanner.Plan plan = RouteHeadingPlanner.plan(
            world, route, 1, 0.5D, 0.5D, 1.0D);

        assertEquals(RouteHeadingPlanner.Kind.WIDE_CORNER, plan.kind());
        assertEquals(3, plan.aimIndex());
        assertEquals(cell(1, 2), plan.aimCell());
        assertEquals(-24.2277D, plan.desiredYaw(), 0.001D);
        assertTrue(plan.preserveForward());
        assertTrue(plan.sprintEligible());
    }

    @Test
    void tightArrivalRadiusKeepsTheCornerAimInsideItsArrivalEnvelope() {
        TestWorld world = flatWorld();
        List<VoxelCell> route = route(
            cell(0, 0), cell(0, 1), cell(1, 1), cell(2, 1));

        RouteHeadingPlanner.Plan plan = RouteHeadingPlanner.plan(
            world, route, 1, 0.5D, 0.5D, 0.4D);

        assertEquals(RouteHeadingPlanner.Kind.WIDE_CORNER, plan.kind());
        assertEquals(2, plan.aimIndex());
        assertEquals(-19.7989D, plan.desiredYaw(), 0.001D);
        assertTrue(plan.preserveForward());
        assertTrue(plan.sprintEligible());
    }

    @Test
    void suppliedWideCornerRouteAdvancesWithoutBypassingTheAuthoritativeCorner() {
        TestWorld world = flatWorld();
        List<GridCell> gridRoute = List.of(
            new GridCell(0, 1),
            new GridCell(0, 2),
            new GridCell(0, 3),
            new GridCell(0, 4),
            new GridCell(0, 5),
            new GridCell(0, 6),
            new GridCell(1, 6),
            new GridCell(2, 6),
            new GridCell(3, 6),
            new GridCell(4, 6)
        );
        List<VoxelCell> voxelRoute = gridRoute.stream()
            .map(cell -> new VoxelCell(cell.x(), 0, cell.z()))
            .toList();
        int waypointIndex = 0;
        int maximumIndex = 0;
        double x = 0.5D;
        double z = 0.5D;
        double yaw = 0.0D;
        PathFollower.Progress progress = PathFollower.Progress.initial();
        boolean finished = false;

        for (int tick = 0; tick < 160; tick++) {
            PathFollower.Command command = PathFollower.follow(
                gridRoute,
                waypointIndex,
                progress,
                x,
                z,
                yaw,
                1.0D,
                10.0D
            );
            assertTrue(command.waypointIndex() >= maximumIndex);
            waypointIndex = command.waypointIndex();
            maximumIndex = Math.max(maximumIndex, waypointIndex);
            progress = command.progress();
            if (command.finished()) {
                finished = true;
                break;
            }

            RouteHeadingPlanner.Plan plan = RouteHeadingPlanner.plan(
                world,
                voxelRoute,
                waypointIndex,
                x,
                z,
                1.0D
            );
            double yawDelta = LookController.shortestYawDelta(yaw, plan.desiredYaw());
            yaw += Math.max(-12.0D, Math.min(12.0D, yawDelta));
            double remainingYawError = Math.abs(
                LookController.shortestYawDelta(yaw, plan.desiredYaw())
            );
            if (remainingYawError <= 28.0D) {
                double radians = Math.toRadians(yaw);
                x -= Math.sin(radians) * 0.2D;
                z += Math.cos(radians) * 0.2D;
            }
        }

        assertTrue(
            finished,
            "route stalled at index " + maximumIndex + " position=" + x + "," + z
        );
        assertEquals(gridRoute.size(), maximumIndex);
    }

    @Test
    void rejectsANarrowCornerWithoutMutatingTheRoute() {
        TestWorld world = flatWorld();
        world.removeSupport(1, -1, 0);
        List<VoxelCell> route = new ArrayList<>(route(
            cell(0, 0), cell(0, 1), cell(1, 1), cell(2, 1)));
        List<VoxelCell> frozen = List.copyOf(route);

        RouteHeadingPlanner.Plan plan = RouteHeadingPlanner.plan(
            world, route, 1, 0.5D, 0.5D, 0.0D);

        assertEquals(RouteHeadingPlanner.Kind.ACTIVE, plan.kind());
        assertEquals(1, plan.aimIndex());
        assertEquals("corner_envelope_unsafe", plan.suppressionReason());
        assertFalse(plan.preserveForward());
        assertFalse(plan.sprintEligible());
        assertEquals(frozen, route);
    }

    @Test
    void suppressesVerticalGapReversalAndRouteEnd() {
        TestWorld world = flatWorld();
        world.support(0, 0, 2);

        assertEquals(
            "vertical_transition",
            RouteHeadingPlanner.plan(
                world,
                route(cell(0, 0), cell(0, 1), new VoxelCell(0, 2, 2)),
                1,
                0.5D,
                0.5D,
                0.0D
            ).suppressionReason()
        );
        assertEquals(
            "route_gap",
            RouteHeadingPlanner.plan(
                world,
                route(cell(0, 0), cell(0, 1), cell(0, 3)),
                1,
                0.5D,
                0.5D,
                0.0D
            ).suppressionReason()
        );
        assertEquals(
            "route_reversal",
            RouteHeadingPlanner.plan(
                world,
                route(cell(0, 0), cell(0, 1), cell(0, 0)),
                1,
                0.5D,
                0.5D,
                0.0D
            ).suppressionReason()
        );
        assertEquals(
            "route_end",
            RouteHeadingPlanner.plan(
                world,
                route(cell(0, 0), cell(0, 1)),
                1,
                0.5D,
                0.5D,
                0.0D
            ).suppressionReason()
        );
    }

    @Test
    void rejectsHazardLiquidAndAdjacentLavaLookahead() {
        List<VoxelCell> route = route(cell(0, 0), cell(0, 1), cell(0, 2));

        TestWorld hazard = flatWorld();
        hazard.hazard(0, 1, 2);
        assertEquals(
            "unsafe_lookahead",
            RouteHeadingPlanner.plan(hazard, route, 1, 0.5D, 0.5D, 0.0D).suppressionReason()
        );

        TestWorld water = flatWorld();
        water.water(0, 1, 2);
        assertEquals(
            "unsafe_lookahead",
            RouteHeadingPlanner.plan(water, route, 1, 0.5D, 0.5D, 0.0D).suppressionReason()
        );

        TestWorld lava = flatWorld();
        lava.lava(1, 1, 2);
        assertEquals(
            "unsafe_lookahead",
            RouteHeadingPlanner.plan(lava, route, 1, 0.5D, 0.5D, 0.0D).suppressionReason()
        );
    }

    @Test
    void finalLookaheadCellDisablesSprint() {
        TestWorld world = flatWorld();
        RouteHeadingPlanner.Plan plan = RouteHeadingPlanner.plan(
            world,
            route(cell(0, 0), cell(0, 1), cell(0, 2)),
            1,
            0.5D,
            0.5D,
            0.0D
        );

        assertEquals(2, plan.aimIndex());
        assertTrue(plan.preserveForward());
        assertFalse(plan.sprintEligible());
    }

    private static TestWorld flatWorld() {
        TestWorld world = new TestWorld(-4, 6, -2, 5, -4, 8);
        world.floor(-4, 6, -4, 8, -1);
        return world;
    }

    private static VoxelCell cell(int x, int z) {
        return new VoxelCell(x, 0, z);
    }

    private static List<VoxelCell> route(VoxelCell... cells) {
        return List.of(cells);
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
