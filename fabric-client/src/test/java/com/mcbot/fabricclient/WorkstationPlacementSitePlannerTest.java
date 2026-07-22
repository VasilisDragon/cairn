package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class WorkstationPlacementSitePlannerTest {
    @Test
    void selectsInitiallyLateralLShapedRouteToReachableSite() {
        var world = new VoxelAStarTest.TestVoxelWorld(0, 7, 63, 68, 0, 1);
        world.support(0, 63, 0);
        world.support(0, 63, 1);
        world.support(1, 63, 1);
        world.support(2, 63, 1);
        world.support(3, 63, 1);
        world.support(4, 63, 1);
        world.support(4, 63, 0);
        world.support(6, 63, 0);

        WorkstationPlacementSitePlanner.Result result = WorkstationPlacementSitePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(site(6, 63, 0)),
            WorkstationPlacementSitePlanner.Mode.TABLE,
            4.8D,
            Set.of()
        );

        assertTrue(result.found(), result.failureReason());
        assertEquals(new VoxelCell(0, 64, 1), result.plan().route().get(1));
        assertEquals(new VoxelCell(6, 63, 0), result.plan().support());
        assertTrue(result.plan().interactionDistance() <= 4.8D);
    }

    @Test
    void traversesStepUpAndThreeBlockDescent() {
        var world = new VoxelAStarTest.TestVoxelWorld(0, 8, 60, 70, 0, 0);
        world.support(0, 63, 0);
        world.support(1, 64, 0);
        world.support(2, 64, 0);
        world.support(3, 61, 0);
        world.support(4, 61, 0);
        world.support(8, 61, 0);

        WorkstationPlacementSitePlanner.Plan plan = WorkstationPlacementSitePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(site(8, 61, 0)),
            WorkstationPlacementSitePlanner.Mode.TABLE,
            4.8D,
            Set.of()
        ).plan();

        assertTrue(plan.route().contains(new VoxelCell(1, 65, 0)));
        assertTrue(plan.route().contains(new VoxelCell(3, 62, 0)));
        assertEquals(-2, plan.verticalDelta());
    }

    @Test
    void ranksFurnaceNonInteractiveThenRouteDistanceVerticalAndCoordinates() {
        var world = levelWorld(-1, 8, -1, 1, 64);
        var interactiveNear = site(5, 63, 0, false, false, false, false, true, false);
        var nonInteractiveFar = site(7, 63, 0);
        WorkstationPlacementSitePlanner.Plan nonInteractive = WorkstationPlacementSitePlanner.plan(
            world, new VoxelCell(0, 64, 0), List.of(interactiveNear, nonInteractiveFar),
            WorkstationPlacementSitePlanner.Mode.FURNACE, 4.8D, Set.of()).plan();
        assertEquals(new VoxelCell(7, 63, 0), nonInteractive.support());
        assertFalse(nonInteractive.sneakRequired());

        WorkstationPlacementSitePlanner.Plan fallback = WorkstationPlacementSitePlanner.plan(
            world, new VoxelCell(0, 64, 0), List.of(interactiveNear),
            WorkstationPlacementSitePlanner.Mode.FURNACE, 4.8D, Set.of()).plan();
        assertEquals(new VoxelCell(5, 63, 0), fallback.support());
        assertTrue(fallback.sneakRequired());

        var coordinateWorld = levelWorld(0, 6, -1, 1, 64);
        WorkstationPlacementSitePlanner.Plan coordinates = WorkstationPlacementSitePlanner.plan(
            coordinateWorld,
            new VoxelCell(0, 64, 0),
            List.of(site(6, 63, 1), site(6, 63, -1)),
            WorkstationPlacementSitePlanner.Mode.TABLE,
            4.8D,
            Set.of()
        ).plan();
        assertEquals(new VoxelCell(6, 63, -1), coordinates.support());
    }

    @Test
    void enforcesInteractionBoundaryLineOfSightAndExcludedSiteReselection() {
        var world = levelWorld(0, 8, 0, 1, 64);
        var first = site(6, 63, 0);
        var second = site(7, 63, 1);
        WorkstationPlacementSitePlanner.Result tooShort = WorkstationPlacementSitePlanner.plan(
            world, new VoxelCell(0, 64, 0), List.of(first),
            WorkstationPlacementSitePlanner.Mode.TABLE, 0.5D, Set.of());
        assertFalse(tooShort.found());

        WorkstationPlacementSitePlanner.Plan reselection = WorkstationPlacementSitePlanner.plan(
            world, new VoxelCell(0, 64, 0), List.of(first, second),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of(first.support())).plan();
        assertEquals(second.support(), reselection.support());

        var occluded = levelWorld(0, 8, 0, 0, 64);
        occluded.support(5, 64, 0);
        occluded.support(5, 65, 0);
        assertFalse(WorkstationPlacementSitePlanner.plan(
            occluded, new VoxelCell(0, 64, 0), List.of(first),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of()).found());
    }

    @Test
    void rejectsUnsafeOrSemanticallyInvalidSites() {
        var world = levelWorld(0, 5, 0, 0, 64);
        List<WorkstationPlacementSitePlanner.Site> rejected = List.of(
            site(4, 63, 0, true, false, false, false, false, false),
            site(4, 63, 0, false, true, false, false, false, false),
            site(4, 63, 0, false, false, true, false, false, false),
            site(4, 63, 0, false, false, false, true, false, false),
            site(4, 63, 0, false, false, false, false, true, false)
        );
        for (WorkstationPlacementSitePlanner.Site site : rejected) {
            assertFalse(WorkstationPlacementSitePlanner.plan(
                world, new VoxelCell(0, 64, 0), List.of(site),
                WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of()).found());
        }

        var hazard = levelWorld(0, 5, 0, 0, 64);
        hazard.hazard(4, 63, 0);
        assertFalse(WorkstationPlacementSitePlanner.plan(
            hazard, new VoxelCell(0, 64, 0), List.of(site(4, 63, 0)),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of()).found());

        var blockedBody = levelWorld(0, 1, 0, 0, 64);
        assertFalse(WorkstationPlacementSitePlanner.plan(
            blockedBody, new VoxelCell(0, 64, 0), List.of(site(0, 63, 0)),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of()).found());
    }

    @Test
    void rejectsExcessiveDropUnstableSupportAndBoxedEgress() {
        var deep = new VoxelAStarTest.TestVoxelWorld(0, 7, 57, 68, 0, 0);
        deep.support(0, 63, 0);
        deep.support(3, 58, 0);
        deep.support(7, 58, 0);
        assertFalse(WorkstationPlacementSitePlanner.plan(
            deep, new VoxelCell(0, 64, 0), List.of(site(7, 58, 0)),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of()).found());

        var unstable = new VoxelAStarTest.TestVoxelWorld(0, 7, 63, 68, 0, 0);
        unstable.support(0, 63, 0);
        unstable.support(7, 63, 0);
        assertFalse(WorkstationPlacementSitePlanner.plan(
            unstable, new VoxelCell(0, 64, 0), List.of(site(7, 63, 0)),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of()).found());
    }

    @Test
    void classifiesUnstandableStartAndDeterministicExpansionBudget() {
        var unstandable = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 68, 0, 0);
        WorkstationPlacementSitePlanner.Result blocked = WorkstationPlacementSitePlanner.plan(
            unstandable, new VoxelCell(0, 64, 0), List.of(),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of());
        assertNull(blocked.plan());
        assertEquals("start_unstandable", blocked.failureReason());

        var world = levelWorld(-20, 20, -20, 20, 64);
        WorkstationPlacementSitePlanner.Result first = WorkstationPlacementSitePlanner.plan(
            world, new VoxelCell(0, 64, 0), List.of(),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of(), 37);
        WorkstationPlacementSitePlanner.Result second = WorkstationPlacementSitePlanner.plan(
            world, new VoxelCell(0, 64, 0), List.of(),
            WorkstationPlacementSitePlanner.Mode.TABLE, 4.8D, Set.of(), 37);
        assertEquals(first, second);
        assertEquals(37, first.expandedCells());
        assertEquals("expanded_budget", first.failureReason());
        assertTrue(first.expandedCells() <= WorkstationPlacementSitePlanner.MAX_EXPANDED_CELLS);
    }

    private static WorkstationPlacementSitePlanner.Site site(int x, int y, int z) {
        return site(x, y, z, false, false, false, false, false, false);
    }

    private static WorkstationPlacementSitePlanner.Site site(
        int x,
        int y,
        int z,
        boolean ore,
        boolean trail,
        boolean liquid,
        boolean lava,
        boolean interactiveSupport,
        boolean interactiveAdjacent
    ) {
        return new WorkstationPlacementSitePlanner.Site(
            new VoxelCell(x, y, z),
            new VoxelCell(x, y + 1, z),
            true,
            ore,
            trail,
            liquid,
            lava,
            interactiveSupport,
            interactiveAdjacent
        );
    }

    private static VoxelAStarTest.TestVoxelWorld levelWorld(
        int minX,
        int maxX,
        int minZ,
        int maxZ,
        int feetY
    ) {
        var world = new VoxelAStarTest.TestVoxelWorld(minX, maxX, feetY - 1, feetY + 4, minZ, maxZ);
        world.floor(minX, maxX, minZ, maxZ, feetY - 1);
        return world;
    }
}
