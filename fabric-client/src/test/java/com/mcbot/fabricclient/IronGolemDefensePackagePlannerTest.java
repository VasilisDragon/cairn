package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

class IronGolemDefensePackagePlannerTest {
    private static final String UUID = "00000000-0000-0000-0000-000000000030";

    @Test
    void fixtureGeometrySelectsExactThreeBlockDefensePackage() {
        TestPerception world = new TestPerception(590, 620, 145, 156, 596, 604);
        for (int x = 600; x <= 613; x++) {
            world.support(new VoxelCell(x, 149, 600));
        }
        IronGolemDefensePackagePlanner.Target target = target(
            614.8D, 149.0D, 599.8D,
            616.2D, 151.7D, 601.2D
        );

        IronGolemDefensePackagePlanner.Plan plan = IronGolemDefensePackagePlanner.plan(
            world,
            new VoxelCell(600, 149, 600),
            target,
            ready(32, 6)
        );

        assertTrue(plan.accepted(), plan.reason());
        assertEquals(IronGolemDefensePackagePlanner.Mode.THREE_BLOCK_PILLAR, plan.mode());
        assertEquals(new VoxelCell(613, 149, 600), plan.base());
        assertEquals(
            java.util.List.of(
                new VoxelCell(613, 149, 600),
                new VoxelCell(613, 150, 600),
                new VoxelCell(613, 151, 600)
            ),
            plan.placementCells()
        );
        assertEquals(new VoxelCell(613, 152, 600), plan.attackStance());
        assertEquals(new VoxelCell(612, 149, 600), plan.escapeLanding());
        assertTrue(plan.escapeRoute().size() > 1);
        assertEquals(new VoxelCell(600, 149, 600), plan.escapeRoute().getLast());
        assertFalse(plan.escapeLanding().equals(plan.escapeRoute().getLast()));
        assertEquals(3, plan.fillerRequired());
        assertTrue(plan.attackDistance() <= IronGolemDefensePackagePlanner.ENTITY_REACH);
        assertTrue(plan.routeToBase().size() <= IronGolemDefensePackagePlanner.MAX_ROUTE_CELLS);
        assertTrue(plan.expandedCells() <= IronGolemDefensePackagePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void explicitProtectedStanceCanWinWithoutFiller() {
        TestPerception world = flatWorld(-4, 4, -4, 4);
        VoxelCell start = new VoxelCell(0, 1, 0);
        world.existingProtected.add(start);
        IronGolemDefensePackagePlanner.Target target = target(
            2.0D, 1.0D, -0.7D,
            3.4D, 3.7D, 0.7D
        );

        IronGolemDefensePackagePlanner.Plan plan = IronGolemDefensePackagePlanner.plan(
            world,
            start,
            target,
            ready(0, 0)
        );

        assertTrue(plan.accepted(), plan.reason());
        assertEquals(IronGolemDefensePackagePlanner.Mode.EXISTING_PROTECTED_STANCE, plan.mode());
        assertEquals(0, plan.fillerRequired());
        assertEquals(java.util.List.of(start), plan.routeToBase());
        assertEquals(java.util.List.of(start), plan.escapeRoute());
    }

    @Test
    void readinessRejectsHealthFoodWeaponThreatsAndSecondGolem() {
        TestPerception world = flatWorld(-4, 4, -4, 4);
        VoxelCell start = new VoxelCell(0, 1, 0);
        IronGolemDefensePackagePlanner.Target target = target(
            2.0D, 1.0D, -0.7D,
            3.4D, 3.7D, 0.7D
        );

        assertEquals("health_not_ready", plan(world, start, target,
            new IronGolemDefensePackagePlanner.Readiness(15.9D, 20, 40, 8, 0, 0, 1)).reason());
        assertEquals("food_not_ready", plan(world, start, target,
            new IronGolemDefensePackagePlanner.Readiness(20.0D, 13, 40, 8, 0, 0, 1)).reason());
        assertEquals("stone_sword_missing_or_worn", plan(world, start, target,
            new IronGolemDefensePackagePlanner.Readiness(20.0D, 20, 23, 8, 0, 0, 1)).reason());
        assertEquals("nearby_threats", plan(world, start, target,
            new IronGolemDefensePackagePlanner.Readiness(20.0D, 20, 40, 8, 0, 1, 1)).reason());
        assertEquals("multiple_golems", plan(world, start, target,
            new IronGolemDefensePackagePlanner.Readiness(20.0D, 20, 40, 8, 0, 0, 2)).reason());
        assertEquals("target_not_live", plan(world, start, target,
            new IronGolemDefensePackagePlanner.Readiness(20.0D, 20, 40, 8, 0, 0, 0)).reason());
    }

    @Test
    void fillerReserveUsesExactlyThreeExpendableBlocks() {
        TestPerception world = corridorWorld();
        VoxelCell start = new VoxelCell(0, 1, 0);
        IronGolemDefensePackagePlanner.Target target = target(
            3.0D, 1.0D, -0.7D,
            4.4D, 3.9D, 0.7D
        );

        IronGolemDefensePackagePlanner.Plan shortPlan = plan(
            world,
            start,
            target,
            ready(8, 6)
        );
        IronGolemDefensePackagePlanner.Plan exactPlan = plan(
            world,
            start,
            target,
            ready(9, 6)
        );

        assertFalse(shortPlan.accepted());
        assertEquals("filler_reserve_short", shortPlan.reason());
        assertTrue(exactPlan.accepted(), exactPlan.reason());
        assertEquals(3, exactPlan.fillerRequired());
    }

    @Test
    void rejectsBlockedHeadProtectedContainerGravityLiquidAndAdjacentLava() {
        IronGolemDefensePackagePlanner.Target target = target(
            3.0D, 1.0D, -0.7D,
            4.4D, 3.9D, 0.7D
        );
        VoxelCell start = new VoxelCell(0, 1, 0);

        TestPerception blockedHead = corridorWorld();
        blockedHead.solid.add(new VoxelCell(1, 5, 0));
        assertFalse(plan(blockedHead, start, target, ready(9, 6)).accepted());

        TestPerception protectedCell = corridorWorld();
        protectedCell.protectedBlocks.add(new VoxelCell(1, 2, 0));
        assertFalse(plan(protectedCell, start, target, ready(9, 6)).accepted());

        TestPerception containerCell = corridorWorld();
        containerCell.containers.add(new VoxelCell(1, 2, 0));
        assertFalse(plan(containerCell, start, target, ready(9, 6)).accepted());

        TestPerception gravityCell = corridorWorld();
        gravityCell.gravity.add(new VoxelCell(1, 2, 0));
        assertFalse(plan(gravityCell, start, target, ready(9, 6)).accepted());

        TestPerception wet = corridorWorld();
        wet.water.add(new VoxelCell(1, 2, 0));
        assertFalse(plan(wet, start, target, ready(9, 6)).accepted());

        TestPerception lava = corridorWorld();
        lava.lava.add(new VoxelCell(1, 2, 1));
        assertFalse(plan(lava, start, target, ready(9, 6)).accepted());
    }

    @Test
    void requiresHitboxReachClearSightAndFrozenSafeEscape() {
        VoxelCell start = new VoxelCell(0, 1, 0);
        TestPerception corridor = corridorWorld();
        IronGolemDefensePackagePlanner.Target far = target(
            5.0D, 1.0D, -0.7D,
            6.4D, 3.7D, 0.7D
        );
        assertFalse(plan(corridor, start, far, ready(9, 6)).accepted());

        TestPerception occluded = corridorWorld();
        occluded.solid.add(new VoxelCell(2, 4, 0));
        assertFalse(plan(occluded, start, target(
            3.0D, 1.0D, -0.7D,
            4.4D, 3.9D, 0.7D
        ), ready(9, 6)).accepted());

        TestPerception noEscape = corridorWorld();
        noEscape.supports.clear();
        noEscape.support(new VoxelCell(1, 1, 0));
        IronGolemDefensePackagePlanner.Plan noEscapePlan = plan(noEscape, new VoxelCell(1, 1, 0), target(
            3.0D, 1.0D, -0.7D,
            4.4D, 3.9D, 0.7D
        ), ready(9, 6));
        assertFalse(noEscapePlan.accepted());
        assertEquals("no_safe_escape", noEscapePlan.reason());
    }

    @Test
    void stepUpAndStepDownApproachesMustBeReversible() {
        TestPerception world = new TestPerception(-3, 8, -2, 8, -2, 2);
        world.support(new VoxelCell(0, 1, 0));
        world.support(new VoxelCell(1, 2, 0));
        world.support(new VoxelCell(2, 1, 0));
        world.support(new VoxelCell(2, 1, 1));
        IronGolemDefensePackagePlanner.Plan plan = plan(
            world,
            new VoxelCell(0, 1, 0),
            target(4.5D, 1.0D, 0.8D, 5.9D, 3.9D, 2.2D),
            ready(9, 6)
        );

        assertTrue(plan.accepted(), plan.reason());
        assertTrue(plan.routeToBase().contains(new VoxelCell(1, 2, 0)));

        TestPerception oneWay = new TestPerception(-3, 8, -3, 8, -2, 2);
        oneWay.support(new VoxelCell(0, 3, 0));
        oneWay.support(new VoxelCell(1, 1, 0));
        assertFalse(plan(
            oneWay,
            new VoxelCell(0, 3, 0),
            target(3.9D, 1.0D, -0.7D, 5.3D, 3.9D, 0.7D),
            ready(9, 6)
        ).accepted());
    }

    @Test
    void boundsAndImmutableResultFailClosed() {
        assertThrows(IllegalArgumentException.class, () ->
            new IronGolemDefensePackagePlanner.EntityBounds(0, 0, 0, 0, 1, 1));
        assertThrows(IllegalArgumentException.class, () ->
            new IronGolemDefensePackagePlanner.Target(" ",
                new IronGolemDefensePackagePlanner.EntityBounds(0, 0, 0, 1, 1, 1)));

        TestPerception broad = flatWorld(-30, 30, -30, 30);
        IronGolemDefensePackagePlanner.Plan result = plan(
            broad,
            new VoxelCell(-30, 1, -30),
            target(30.0D, 1.0D, 29.0D, 31.0D, 3.7D, 30.0D),
            ready(9, 6)
        );
        assertFalse(result.accepted());
        assertTrue(result.expandedCells() <= IronGolemDefensePackagePlanner.MAX_EXPANDED_CELLS);
        assertTrue(result.routeToBase().isEmpty());
        assertThrows(UnsupportedOperationException.class, () ->
            result.routeToBase().add(new VoxelCell(0, 0, 0)));
    }

    private static IronGolemDefensePackagePlanner.Plan plan(
        TestPerception perception,
        VoxelCell start,
        IronGolemDefensePackagePlanner.Target target,
        IronGolemDefensePackagePlanner.Readiness readiness
    ) {
        return IronGolemDefensePackagePlanner.plan(perception, start, target, readiness);
    }

    private static IronGolemDefensePackagePlanner.Target target(
        double minX,
        double minY,
        double minZ,
        double maxX,
        double maxY,
        double maxZ
    ) {
        return new IronGolemDefensePackagePlanner.Target(
            UUID,
            new IronGolemDefensePackagePlanner.EntityBounds(
                minX, minY, minZ, maxX, maxY, maxZ
            )
        );
    }

    private static IronGolemDefensePackagePlanner.Readiness ready(int filler, int reserve) {
        return new IronGolemDefensePackagePlanner.Readiness(
            20.0D,
            20,
            64,
            filler,
            reserve,
            0,
            1
        );
    }

    private static TestPerception corridorWorld() {
        TestPerception world = new TestPerception(-3, 8, -2, 8, -2, 2);
        world.support(new VoxelCell(0, 1, 0));
        world.support(new VoxelCell(1, 1, 0));
        return world;
    }

    private static TestPerception flatWorld(int minX, int maxX, int minZ, int maxZ) {
        TestPerception world = new TestPerception(minX, maxX, -2, 8, minZ, maxZ);
        for (int x = minX; x <= maxX; x++) {
            for (int z = minZ; z <= maxZ; z++) {
                world.support(new VoxelCell(x, 1, z));
            }
        }
        return world;
    }

    private static final class TestPerception implements IronGolemDefensePackagePlanner.Perception {
        private final int minX;
        private final int maxX;
        private final int minY;
        private final int maxY;
        private final int minZ;
        private final int maxZ;
        private final Set<VoxelCell> solid = new HashSet<>();
        private final Set<VoxelCell> supports = new HashSet<>();
        private final Set<VoxelCell> hazards = new HashSet<>();
        private final Set<VoxelCell> water = new HashSet<>();
        private final Set<VoxelCell> lava = new HashSet<>();
        private final Set<VoxelCell> protectedBlocks = new HashSet<>();
        private final Set<VoxelCell> containers = new HashSet<>();
        private final Set<VoxelCell> gravity = new HashSet<>();
        private final Set<VoxelCell> existingProtected = new HashSet<>();

        private TestPerception(int minX, int maxX, int minY, int maxY, int minZ, int maxZ) {
            this.minX = minX;
            this.maxX = maxX;
            this.minY = minY;
            this.maxY = maxY;
            this.minZ = minZ;
            this.maxZ = maxZ;
        }

        void support(VoxelCell feet) {
            VoxelCell support = new VoxelCell(feet.x(), feet.y() - 1, feet.z());
            supports.add(support);
            solid.add(support);
        }

        @Override public int minX() { return minX; }
        @Override public int maxX() { return maxX; }
        @Override public int minY() { return minY; }
        @Override public int maxY() { return maxY; }
        @Override public int minZ() { return minZ; }
        @Override public int maxZ() { return maxZ; }
        @Override public boolean isSolid(int x, int y, int z) {
            return solid.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isHazard(int x, int y, int z) {
            return hazards.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isWater(int x, int y, int z) {
            return water.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isLava(int x, int y, int z) {
            return !inBounds(x, y, z) || lava.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isFullHeightSupport(int x, int y, int z) {
            return supports.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isProtectedBlock(int x, int y, int z) {
            return protectedBlocks.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isContainerBlock(int x, int y, int z) {
            return containers.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isGravityUnstable(int x, int y, int z) {
            return gravity.contains(new VoxelCell(x, y, z));
        }
        @Override public boolean isExistingProtectedAttackStance(
            VoxelCell stance,
            IronGolemDefensePackagePlanner.EntityBounds targetBounds
        ) {
            return existingProtected.contains(stance);
        }
    }
}
