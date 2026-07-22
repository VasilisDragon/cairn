package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class VoxelAStarTest {
    @Test
    void routesAcrossSameLevelTraversal() {
        TestVoxelWorld world = new TestVoxelWorld(0, 4, 63, 66, 0, 0);
        world.floor(0, 4, 0, 0, 63);

        List<VoxelCell> route = VoxelAStar.route(world, new VoxelCell(0, 64, 0), new VoxelCell(4, 64, 0));

        assertEquals(List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(2, 64, 0),
            new VoxelCell(3, 64, 0),
            new VoxelCell(4, 64, 0)
        ), route);
    }

    @Test
    void routesStepUpAndSafeDrop() {
        TestVoxelWorld world = new TestVoxelWorld(0, 4, 61, 68, 0, 0);
        world.support(0, 63, 0);
        world.support(1, 64, 0); // step up to feet y65
        world.support(2, 64, 0);
        world.support(3, 61, 0); // safe drop to feet y62
        world.support(4, 61, 0);

        List<VoxelCell> route = VoxelAStar.route(world, new VoxelCell(0, 64, 0), new VoxelCell(4, 62, 0));

        assertEquals(List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 65, 0),
            new VoxelCell(2, 65, 0),
            new VoxelCell(3, 62, 0),
            new VoxelCell(4, 62, 0)
        ), route);
    }

    @Test
    void refusesUnsafeDropBeyondThreeBlocks() {
        TestVoxelWorld world = new TestVoxelWorld(0, 1, 58, 66, 0, 0);
        world.support(0, 63, 0);
        world.support(1, 58, 0);

        Nav3DRouteDiagnostic diagnostic =
            VoxelAStar.diagnose(world, new VoxelCell(0, 64, 0), new VoxelCell(1, 59, 0));

        assertFalse(diagnostic.routeFound());
        assertEquals("open_exhausted", diagnostic.failureReason());
        assertTrue(diagnostic.rejectionCount("no_traversable_destination") > 0);
    }

    @Test
    void routesAroundHazardWithoutEnteringIt() {
        TestVoxelWorld world = new TestVoxelWorld(0, 4, 63, 66, 0, 2);
        world.floor(0, 4, 0, 2, 63);
        world.hazard(2, 63, 1);

        List<VoxelCell> route = VoxelAStar.route(world, new VoxelCell(0, 64, 1), new VoxelCell(4, 64, 1));

        assertFalse(route.isEmpty());
        assertFalse(route.contains(new VoxelCell(2, 64, 1)), "route must avoid the lava/hazard column");
        for (VoxelCell cell : route) {
            assertTrue(world.isStandable(cell.x(), cell.y(), cell.z()), cell.toString());
        }
    }

    @Test
    void reportsBlockedStartAndGoal() {
        TestVoxelWorld world = new TestVoxelWorld(0, 2, 63, 66, 0, 0);
        world.support(0, 63, 0);

        assertEquals(
            "goal_blocked",
            VoxelAStar.diagnose(world, new VoxelCell(0, 64, 0), new VoxelCell(2, 64, 0)).failureReason()
        );
        assertEquals(
            "start_blocked",
            VoxelAStar.diagnose(world, new VoxelCell(2, 64, 0), new VoxelCell(0, 64, 0)).failureReason()
        );
    }

    static final class TestVoxelWorld implements VoxelPerception {
        private final int minX;
        private final int maxX;
        private final int minY;
        private final int maxY;
        private final int minZ;
        private final int maxZ;
        final Set<VoxelCell> solid = new HashSet<>();
        private final Set<VoxelCell> hazards = new HashSet<>();

        TestVoxelWorld(int minX, int maxX, int minY, int maxY, int minZ, int maxZ) {
            this.minX = minX;
            this.maxX = maxX;
            this.minY = minY;
            this.maxY = maxY;
            this.minZ = minZ;
            this.maxZ = maxZ;
        }

        void floor(int minX, int maxX, int minZ, int maxZ, int y) {
            for (int x = minX; x <= maxX; x++) {
                for (int z = minZ; z <= maxZ; z++) {
                    support(x, y, z);
                }
            }
        }

        void support(int x, int y, int z) {
            solid.add(new VoxelCell(x, y, z));
        }

        void hazard(int x, int y, int z) {
            hazards.add(new VoxelCell(x, y, z));
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
    }
}
