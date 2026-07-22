package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class GatherTreeBreakStancePlannerTest {
    @Test
    void reachesBreakStanceThroughLShapedInitiallyLateralRoute() {
        var world = new VoxelAStarTest.TestVoxelWorld(-1, 5, 63, 67, 0, 2);
        world.support(0, 63, 0);
        world.support(0, 63, 1);
        world.support(1, 63, 1);
        world.support(2, 63, 1);
        world.support(3, 63, 1);
        world.support(3, 63, 0);

        GatherTreeBreakStancePlanner.Result result = GatherTreeBreakStancePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            new BlockPos(4, 64, 0),
            4.8D,
            Set.of(new VoxelCell(0, 64, 0))
        );

        assertTrue(result.found(), result.failureReason());
        assertEquals(new VoxelCell(3, 64, 0), result.plan().stance());
        assertEquals(new VoxelCell(0, 64, 1), result.plan().route().get(1));
    }

    @Test
    void supportsStepUpAndThreeBlockDescent() {
        var world = new VoxelAStarTest.TestVoxelWorld(0, 4, 60, 69, 0, 0);
        world.support(0, 63, 0);
        world.support(1, 64, 0);
        world.support(2, 64, 0);
        world.support(3, 61, 0);
        world.support(4, 61, 0);

        GatherTreeBreakStancePlanner.Plan plan = GatherTreeBreakStancePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            new BlockPos(5, 62, 0),
            4.8D,
            Set.of(new VoxelCell(0, 64, 0), new VoxelCell(1, 65, 0), new VoxelCell(2, 65, 0))
        ).plan();

        assertEquals(new VoxelCell(3, 62, 0), plan.stance());
        assertEquals(List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 65, 0),
            new VoxelCell(2, 65, 0),
            new VoxelCell(3, 62, 0)
        ), plan.route());
    }

    @Test
    void honorsInteractionBoundaryAndRanksDistanceThenRouteVerticalAndCoordinates() {
        var boundaryWorld = levelWorld(-1, 6, 0, 0, 64);
        BlockPos target = new BlockPos(6, 64, 0);
        GatherTreeBreakStancePlanner.Result tooShort = GatherTreeBreakStancePlanner.plan(
            boundaryWorld, new VoxelCell(0, 64, 0), target, 1.49D,
            Set.of(new VoxelCell(5, 64, 0), new VoxelCell(6, 64, 0)));
        assertFalse(tooShort.found());
        GatherTreeBreakStancePlanner.Result insideBoundary = GatherTreeBreakStancePlanner.plan(
            boundaryWorld, new VoxelCell(0, 64, 0), target, 1.7D,
            Set.of(new VoxelCell(5, 64, 0), new VoxelCell(6, 64, 0)));
        assertEquals(new VoxelCell(4, 64, 0), insideBoundary.plan().stance());

        GatherTreeBreakStancePlanner.Plan ranked = GatherTreeBreakStancePlanner.plan(
            boundaryWorld, new VoxelCell(0, 64, 0), target, 4.8D, Set.of()).plan();
        assertEquals(new VoxelCell(5, 64, 0), ranked.stance());

        var coordinateWorld = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 67, -1, 1);
        coordinateWorld.support(0, 63, 0);
        coordinateWorld.support(0, 63, -1);
        coordinateWorld.support(0, 63, 1);
        coordinateWorld.support(1, 63, -1);
        coordinateWorld.support(1, 63, 1);
        GatherTreeBreakStancePlanner.Plan coordinate = GatherTreeBreakStancePlanner.plan(
            coordinateWorld,
            new VoxelCell(0, 64, 0),
            new BlockPos(2, 64, 0),
            4.8D,
            Set.of(new VoxelCell(0, 64, 0), new VoxelCell(0, 64, -1), new VoxelCell(0, 64, 1))
        ).plan();
        assertEquals(new VoxelCell(1, 64, -1), coordinate.stance());
    }

    @Test
    void excludedStanceSelectsAnotherReachableCell() {
        var world = levelWorld(0, 4, -1, 1, 64);
        BlockPos target = new BlockPos(4, 64, 0);

        GatherTreeBreakStancePlanner.Plan plan = GatherTreeBreakStancePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            target,
            4.8D,
            Set.of(new VoxelCell(3, 64, 0))
        ).plan();

        assertFalse(plan.stance().equals(new VoxelCell(3, 64, 0)));
        assertTrue(BlockBreakController.withinReach(
            new net.minecraft.util.math.Vec3d(plan.stance().x() + 0.5D, plan.stance().y() + 1.62D, plan.stance().z() + 0.5D),
            target,
            4.8D
        ));
    }

    @Test
    void rejectsGeometricallyReachableButOccludedStance() {
        var world = levelWorld(0, 4, 0, 0, 64);
        world.support(2, 65, 0);

        GatherTreeBreakStancePlanner.Result result = GatherTreeBreakStancePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            new BlockPos(4, 64, 0),
            4.8D,
            Set.of(new VoxelCell(1, 64, 0), new VoxelCell(2, 64, 0), new VoxelCell(3, 64, 0))
        );

        assertFalse(result.found());
    }

    @Test
    void rejectsUnsafeGeometryTargetCellAndOutOfReachArea() {
        var deep = new VoxelAStarTest.TestVoxelWorld(0, 2, 57, 67, 0, 0);
        deep.support(0, 63, 0);
        deep.support(1, 58, 0);
        assertFalse(plan(deep, new BlockPos(2, 59, 0)).found());

        var hazard = levelWorld(0, 3, 0, 0, 64);
        hazard.hazard(1, 63, 0);
        assertFalse(GatherTreeBreakStancePlanner.plan(
            hazard, new VoxelCell(0, 64, 0), new BlockPos(3, 64, 0), 4.8D,
            Set.of(new VoxelCell(0, 64, 0), new VoxelCell(2, 64, 0), new VoxelCell(3, 64, 0))).found());

        var unstable = new VoxelAStarTest.TestVoxelWorld(0, 3, 63, 67, 0, 0);
        unstable.support(0, 63, 0);
        unstable.support(2, 63, 0);
        assertFalse(plan(unstable, new BlockPos(3, 64, 0)).found());

        var blockedBody = levelWorld(0, 2, 0, 0, 64);
        blockedBody.support(1, 64, 0);
        blockedBody.support(1, 65, 0);
        assertFalse(GatherTreeBreakStancePlanner.plan(
            blockedBody, new VoxelCell(0, 64, 0), new BlockPos(2, 64, 0), 4.8D,
            Set.of(new VoxelCell(0, 64, 0), new VoxelCell(2, 64, 0))).found());

        var boxed = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 67, 0, 0);
        boxed.support(0, 63, 0);
        assertFalse(plan(boxed, new BlockPos(10, 64, 0)).found());

        var targetCell = levelWorld(0, 1, 0, 0, 64);
        assertFalse(GatherTreeBreakStancePlanner.plan(
            targetCell, new VoxelCell(0, 64, 0), new BlockPos(1, 64, 0), 4.8D,
            Set.of(new VoxelCell(0, 64, 0))).found());
    }

    @Test
    void unstandableStartAndExpansionBudgetAreClassifiedAndDeterministic() {
        var unstandable = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 67, 0, 0);
        GatherTreeBreakStancePlanner.Result blocked = GatherTreeBreakStancePlanner.plan(
            unstandable, new VoxelCell(0, 64, 0), new BlockPos(2, 64, 0), 4.8D, Set.of());
        assertNull(blocked.plan());
        assertEquals("start_unstandable", blocked.failureReason());
        assertEquals(0, blocked.expandedCells());

        var world = levelWorld(-30, 30, -30, 30, 64);
        Set<VoxelCell> excluded = world.solid.stream()
            .map(cell -> new VoxelCell(cell.x(), cell.y() + 1, cell.z()))
            .collect(java.util.stream.Collectors.toSet());
        GatherTreeBreakStancePlanner.Result first = GatherTreeBreakStancePlanner.plan(
            world, new VoxelCell(0, 64, 0), new BlockPos(100, 64, 0), 4.8D, excluded, 37);
        GatherTreeBreakStancePlanner.Result second = GatherTreeBreakStancePlanner.plan(
            world, new VoxelCell(0, 64, 0), new BlockPos(100, 64, 0), 4.8D, excluded, 37);
        assertEquals(37, first.expandedCells());
        assertEquals(first, second);
        assertTrue(first.expandedCells() <= GatherTreeBreakStancePlanner.MAX_EXPANDED_CELLS);
    }

    private static GatherTreeBreakStancePlanner.Result plan(
        VoxelAStarTest.TestVoxelWorld world,
        BlockPos target
    ) {
        return GatherTreeBreakStancePlanner.plan(
            world, new VoxelCell(0, 64, 0), target, 0.5D, Set.of(new VoxelCell(0, 64, 0)));
    }

    private static VoxelAStarTest.TestVoxelWorld levelWorld(
        int minX,
        int maxX,
        int minZ,
        int maxZ,
        int feetY
    ) {
        var world = new VoxelAStarTest.TestVoxelWorld(minX, maxX, feetY - 1, feetY + 3, minZ, maxZ);
        world.floor(minX, maxX, minZ, maxZ, feetY - 1);
        return world;
    }
}
