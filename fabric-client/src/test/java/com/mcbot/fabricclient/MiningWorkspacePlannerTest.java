package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class MiningWorkspacePlannerTest {
    @Test
    void selectsPairedSitesThroughAnInitiallyLateralRoute() {
        var world = new VoxelAStarTest.TestVoxelWorld(0, 8, 63, 68, 0, 2);
        world.support(0, 63, 0);
        world.support(0, 63, 1);
        for (int x = 1; x <= 6; x++) {
            world.support(x, 63, 1);
        }
        world.support(6, 63, 0);
        world.support(6, 63, 2);

        MiningWorkspacePlanner.Result result = MiningWorkspacePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(site(6, 63, 0), site(6, 63, 2)),
            4.8D,
            Set.of()
        );

        assertTrue(result.found(), result.failureReason());
        assertEquals(new VoxelCell(0, 64, 1), result.plan().route().get(1));
        assertNotEquals(result.plan().tableSupport(), result.plan().furnaceSupport());
        assertTrue(result.plan().interactionDistance() <= 4.8D);
    }

    @Test
    void traversesStepUpAndThreeBlockDescentWithTrueY() {
        var world = new VoxelAStarTest.TestVoxelWorld(0, 9, 60, 70, 0, 2);
        world.support(0, 63, 1);
        world.support(1, 64, 1);
        world.support(2, 64, 1);
        world.support(3, 61, 1);
        for (int x = 4; x <= 8; x++) {
            world.support(x, 61, 1);
        }
        world.support(8, 61, 0);
        world.support(8, 61, 2);

        MiningWorkspacePlanner.Plan plan = MiningWorkspacePlanner.plan(
            world,
            new VoxelCell(0, 64, 1),
            List.of(site(8, 61, 0), site(8, 61, 2)),
            4.8D,
            Set.of()
        ).plan();

        assertTrue(plan.route().contains(new VoxelCell(1, 65, 1)));
        assertTrue(plan.route().contains(new VoxelCell(3, 62, 1)));
        assertEquals(-2, plan.verticalDelta());
    }

    @Test
    void ranksNonInteractiveFurnaceAndSupportsExclusion() {
        var world = levelWorld(0, 8, -2, 2, 64);
        MiningWorkspacePlanner.Site left = site(6, 63, -1);
        MiningWorkspacePlanner.Site interactive = site(6, 63, 0, false, false, false, false, false, true, false);
        MiningWorkspacePlanner.Site right = site(6, 63, 1);
        MiningWorkspacePlanner.Plan first = MiningWorkspacePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(left, interactive, right),
            4.8D,
            Set.of()
        ).plan();

        assertFalse(first.furnaceSneakRequired());
        MiningWorkspacePlanner.Plan second = MiningWorkspacePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(left, interactive, right),
            4.8D,
            Set.of(first.workspaceId())
        ).plan();
        assertNotEquals(first.workspaceId(), second.workspaceId());
    }

    @Test
    void rejectsStackedWorkstationsAboveTheSelectedStance() {
        var world = levelWorld(0, 8, -2, 2, 64);
        MiningWorkspacePlanner.Site floor = site(6, 63, -1);
        MiningWorkspacePlanner.Site stacked = site(6, 64, 0);
        MiningWorkspacePlanner.Site otherFloor = site(6, 63, 1);

        MiningWorkspacePlanner.Plan plan = MiningWorkspacePlanner.plan(
            world,
            new VoxelCell(0, 64, 0),
            List.of(floor, stacked, otherFloor),
            4.8D,
            Set.of()
        ).plan();

        assertNotEquals(stacked.support(), plan.tableSupport());
        assertNotEquals(stacked.support(), plan.furnaceSupport());
        assertEquals(plan.stance().y() - 1, plan.tableSupport().y());
        assertEquals(plan.stance().y() - 1, plan.furnaceSupport().y());
    }

    @Test
    void rejectsUnsafeSitesUnstandableStartAndExpandedBudget() {
        var world = levelWorld(0, 8, 0, 2, 64);
        List<MiningWorkspacePlanner.Site> unsafe = List.of(
            site(6, 63, 0, true, false, false, false, false, false, false),
            site(6, 63, 1, false, true, false, false, false, false, false),
            site(7, 63, 0, false, false, true, false, false, false, false),
            site(7, 63, 1, false, false, false, true, false, false, false),
            site(8, 63, 0, false, false, false, false, true, false, false)
        );
        assertFalse(MiningWorkspacePlanner.plan(
            world, new VoxelCell(0, 64, 0), unsafe, 4.8D, Set.of()).found());

        var unstandable = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 68, 0, 0);
        MiningWorkspacePlanner.Result blocked = MiningWorkspacePlanner.plan(
            unstandable, new VoxelCell(0, 64, 0), List.of(), 4.8D, Set.of());
        assertNull(blocked.plan());
        assertEquals("start_unstandable", blocked.failureReason());

        var large = levelWorld(-20, 20, -20, 20, 64);
        MiningWorkspacePlanner.Result first = MiningWorkspacePlanner.plan(
            large, new VoxelCell(0, 64, 0), List.of(), 4.8D, Set.of(), 37);
        MiningWorkspacePlanner.Result second = MiningWorkspacePlanner.plan(
            large, new VoxelCell(0, 64, 0), List.of(), 4.8D, Set.of(), 37);
        assertEquals(first, second);
        assertEquals(37, first.expandedCells());
        assertEquals("expanded_budget", first.failureReason());
    }

    @Test
    void validatesOnlyBoundedSafeCarves() {
        List<VoxelCell> blocks = List.of(
            new VoxelCell(1, 64, 0),
            new VoxelCell(1, 65, 0),
            new VoxelCell(2, 64, 0)
        );
        MiningWorkspacePlanner.CarveResult accepted = MiningWorkspacePlanner.validateCarve(
            new MiningWorkspacePlanner.CarveOption(blocks, true, true, true, true)
        );
        assertTrue(accepted.accepted());
        assertEquals(blocks, accepted.blocks());

        assertFalse(MiningWorkspacePlanner.validateCarve(
            new MiningWorkspacePlanner.CarveOption(blocks, false, true, true, true)
        ).accepted());
        assertFalse(MiningWorkspacePlanner.validateCarve(
            new MiningWorkspacePlanner.CarveOption(blocks, true, true, false, true)
        ).accepted());
        assertFalse(MiningWorkspacePlanner.validateCarve(
            new MiningWorkspacePlanner.CarveOption(java.util.Collections.nCopies(13, new VoxelCell(1, 64, 0)),
                true, true, true, true)
        ).accepted());
    }

    private static MiningWorkspacePlanner.Site site(int x, int y, int z) {
        return site(x, y, z, false, false, false, false, false, false, false);
    }

    private static MiningWorkspacePlanner.Site site(
        int x,
        int y,
        int z,
        boolean ore,
        boolean trail,
        boolean liquid,
        boolean lava,
        boolean gravity,
        boolean interactiveSupport,
        boolean interactiveAdjacent
    ) {
        return new MiningWorkspacePlanner.Site(
            new VoxelCell(x, y, z),
            new VoxelCell(x, y + 1, z),
            true,
            ore,
            trail,
            liquid,
            lava,
            gravity,
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
