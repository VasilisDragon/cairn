package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class VillageRoutePlanSelectorTest {
    @Test
    void remoteHarvestMembersUseOneBoundedExactFrontierThenFinalStance() {
        for (int targetX : new int[] { 34, 40, 48 }) {
            SurfaceReturnTrailGapPlannerTest.TestWorld world =
                new SurfaceReturnTrailGapPlannerTest.TestWorld(
                    -2, targetX + 2, -2, 4, -2, 2);
            world.floor(-2, targetX + 2, -2, 2, 0);
            VoxelCell start = new VoxelCell(0, 1, 0);
            VoxelCell target = new VoxelCell(targetX, 1, 0);
            world.solid(target.x(), target.y(), target.z());

            VillageRoutePlanSelector.Selection stage = VillageRoutePlanSelector.select(
                world,
                start,
                target,
                VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
                true,
                true);

            assertTrue(stage.accepted(), targetX + ":" + stage.plan().reason());
            assertTrue(stage.frontierStage(), Integer.toString(targetX));
            assertFalse(stage.finalStanceReached());
            assertEquals(VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
                stage.goalMode());
            assertEquals(VillageInteractionStancePlanner.Mode.EXACT_TRAVEL,
                stage.installedMode());
            assertEquals(2, stage.computations());
            assertEquals(VillageInteractionStancePlanner.MAX_ROUTE_CELLS,
                stage.plan().route().size());
            assertTrue(stage.plan().frontier());
            assertFalse(stage.plan().stance().equals(target));

            VillageRoutePlanSelector.Selection finish = VillageRoutePlanSelector.select(
                world,
                stage.plan().stance(),
                target,
                stage.goalMode(),
                true,
                true);

            assertTrue(finish.accepted(), targetX + ":" + finish.plan().reason());
            assertFalse(finish.frontierStage());
            assertTrue(finish.finalStanceReached());
            assertEquals(VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
                finish.installedMode());
            assertTrue(finish.plan().targetReached());
            assertTrue(finish.plan().route().size()
                <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
            assertFalse(finish.plan().stance().equals(target));
            assertTrue(VillageInteractionStancePlanner.hasClearInteractionRay(
                world, finish.plan().stance(), target));
        }
    }

    @Test
    void remoteContainerNeverTreatsExactFrontierAsInteractionAuthority() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 52, -2, 4, -2, 2);
        world.floor(-2, 52, -2, 2, 0);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell container = new VoxelCell(44, 1, 0);
        world.solid(container.x(), container.y(), container.z());

        VillageRoutePlanSelector.Selection selection = VillageRoutePlanSelector.select(
            world,
            start,
            container,
            VillageInteractionStancePlanner.Mode.INTERACT_BLOCK,
            true,
            true);

        assertTrue(selection.accepted());
        assertTrue(selection.frontierStage());
        assertFalse(selection.finalStanceReached());
        assertEquals(VillageInteractionStancePlanner.Mode.INTERACT_BLOCK,
            selection.goalMode());
        assertEquals(VillageInteractionStancePlanner.Mode.EXACT_TRAVEL,
            selection.installedMode());
        assertFalse(selection.plan().targetReached());
    }

    @Test
    void nonTravelMembersCannotAcquireRemoteFrontierAuthority() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 52, -2, 4, -2, 2);
        world.floor(-2, 52, -2, 2, 0);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell hay = new VoxelCell(44, 1, 0);
        world.solid(hay.x(), hay.y(), hay.z());

        VillageRoutePlanSelector.Selection selection = VillageRoutePlanSelector.select(
            world,
            start,
            hay,
            VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
            false,
            true);

        assertFalse(selection.accepted());
        assertFalse(selection.frontierStage());
        assertEquals(1, selection.computations());
        assertTrue(VillageRoutePlanSelector.canStage(selection.plan().reason()));
    }

    @Test
    void onePhysicalReplanDoesNotChangeTheFrozenGoalMode() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 52, -2, 4, -2, 2);
        world.floor(-2, 52, -2, 2, 0);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell bed = new VoxelCell(40, 1, 0);
        world.solid(bed.x(), bed.y(), bed.z());

        VillageRoutePlanSelector.Selection original = VillageRoutePlanSelector.select(
            world,
            start,
            bed,
            VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
            true,
            true);
        VillageRoutePlanSelector.Selection replanned = VillageRoutePlanSelector.select(
            world,
            start,
            bed,
            original.goalMode(),
            true,
            false);

        assertTrue(original.frontierStage());
        assertTrue(replanned.frontierStage());
        assertEquals(original.goalMode(), replanned.goalMode());
        assertEquals(original.plan().route(), replanned.plan().route());
        assertTrue(original.plan().route().size()
            <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
    }

    @Test
    void occupiedExactTargetRetainsInteractionFallbackDuringPhysicalReplan() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 10, -2, 4, -2, 2);
        world.floor(-2, 10, -2, 2, 0);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell occupied = new VoxelCell(6, 1, 0);
        world.solid(occupied.x(), occupied.y(), occupied.z());

        VillageRoutePlanSelector.Selection original = VillageRoutePlanSelector.select(
            world,
            start,
            occupied,
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL,
            true,
            true);
        VillageRoutePlanSelector.Selection replanned = VillageRoutePlanSelector.select(
            world,
            start,
            occupied,
            original.goalMode(),
            true,
            true);

        assertTrue(original.accepted());
        assertTrue(replanned.accepted());
        assertEquals(VillageInteractionStancePlanner.Mode.EXACT_TRAVEL,
            replanned.goalMode());
        assertEquals(VillageInteractionStancePlanner.Mode.INTERACT_BLOCK,
            replanned.installedMode());
        assertFalse(replanned.plan().stance().equals(occupied));
    }
}
