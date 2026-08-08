package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

final class VillageInteractionStancePlannerTest {
    @Test
    void selectsDeterministicReachableInteractionStance() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-8, 8, -8, 8);
        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world,
            new VoxelCell(0, 1, 0),
            new VoxelCell(6, 1, 0),
            VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);

        assertTrue(plan.accepted());
        assertEquals(new VoxelCell(2, 1, 0), plan.stance());
        assertTrue(plan.route().size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
        assertTrue(plan.expandedCells() <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void exactTravelDoesNotTreatInteractionEnvelopeAsArrival() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-2, 8, -2, 2);
        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world,
            new VoxelCell(0, 1, 0),
            new VoxelCell(5, 1, 0),
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);

        assertTrue(plan.accepted());
        assertEquals(new VoxelCell(5, 1, 0), plan.stance());
        assertEquals(6, plan.route().size());
    }

    @Test
    void occupiedBellAnchorFallsBackToSafeArrivalApproach() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-2, 12, -3, 3);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell bellAnchor = new VoxelCell(7, 1, 0);
        world.solid(bellAnchor.x(), bellAnchor.y(), bellAnchor.z());

        VillageInteractionStancePlanner.Plan exact = VillageInteractionStancePlanner.plan(
            world, start, bellAnchor, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
        VillageInteractionStancePlanner.Plan approach = VillageInteractionStancePlanner.plan(
            world, start, bellAnchor, VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);

        assertFalse(exact.accepted());
        assertEquals("no_safe_stance", exact.reason());
        assertTrue(approach.accepted());
        assertFalse(approach.stance().equals(bellAnchor));
        assertTrue(horizontalDistance(approach.stance(), bellAnchor) <= 8.0D);
        assertTrue(approach.route().size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
        assertTrue(exact.expandedCells()
            <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
        assertTrue(approach.expandedCells()
            <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void occupiedLecternAnchorUsesDeterministicSafeApproach() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-3, 12, -5, 5);
        VoxelCell start = new VoxelCell(0, 1, 2);
        VoxelCell lecternAnchor = new VoxelCell(6, 1, -1);
        world.solid(lecternAnchor.x(), lecternAnchor.y(), lecternAnchor.z());

        VillageInteractionStancePlanner.Plan first = VillageInteractionStancePlanner.plan(
            world, start, lecternAnchor, VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);
        VillageInteractionStancePlanner.Plan second = VillageInteractionStancePlanner.plan(
            world, start, lecternAnchor, VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);

        assertTrue(first.accepted());
        assertEquals(first.stance(), second.stance());
        assertEquals(first.route(), second.route());
        assertFalse(first.stance().equals(lecternAnchor));
        assertTrue(horizontalDistance(first.stance(), lecternAnchor) <= 8.0D);
    }

    @Test
    void occludedContainerStanceIsSkippedForReachableLineOfSight() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-3, 10, -4, 4);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell container = new VoxelCell(6, 1, 0);
        world.solid(container.x(), container.y(), container.z());
        world.solid(3, 1, 0);
        world.solid(3, 2, 0);

        assertFalse(VillageInteractionStancePlanner.hasClearInteractionRay(
            world, new VoxelCell(2, 1, 0), container));
        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world, start, container, VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);

        assertTrue(plan.accepted());
        assertTrue(VillageInteractionStancePlanner.hasClearInteractionRay(
            world, plan.stance(), container));
        assertFalse(plan.stance().equals(new VoxelCell(2, 1, 0)));
    }

    @Test
    void aggregateHarvestSkipsHayOccludedByAnotherBlock() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-3, 10, -4, 4);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell hay = new VoxelCell(5, 2, 0);
        world.solid(hay.x(), hay.y(), hay.z());
        world.solid(4, 2, 0);

        assertFalse(VillageInteractionStancePlanner.hasClearInteractionRay(
            world, new VoxelCell(3, 1, 0), hay));
        VillageInteractionStancePlanner.TargetPlan selected =
            VillageInteractionStancePlanner.planAnyHarvest(world, start, List.of(hay));

        assertTrue(selected.accepted());
        assertEquals(hay, selected.target());
        assertTrue(VillageInteractionStancePlanner.hasClearInteractionRay(
            world, selected.plan().stance(), hay));
        assertFalse(selected.plan().stance().equals(new VoxelCell(3, 1, 0)));
    }

    @Test
    void standableVillagerMarkerAnchorRemainsExactAndInsideReceiptEnvelope() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-2, 12, -3, 3);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell entityMarker = new VoxelCell(7, 1, 1);

        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world, start, entityMarker, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);

        assertTrue(plan.accepted());
        assertEquals(entityMarker, plan.stance());
        assertTrue(horizontalDistance(plan.stance(), entityMarker) <= 8.0D);
        assertTrue(plan.route().size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
        assertTrue(plan.expandedCells()
            <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void rejectsLiquidHazardAndAdjacentLavaStances() {
        SurfaceReturnTrailGapPlannerTest.TestWorld waterWorld = world(-1, 1, -1, 1);
        waterWorld.water(0, 1, 0);
        assertEquals(
            "start_blocked",
            VillageInteractionStancePlanner.plan(
                waterWorld, new VoxelCell(0, 1, 0), new VoxelCell(1, 1, 0),
                VillageInteractionStancePlanner.Mode.EXACT_TRAVEL).reason());

        SurfaceReturnTrailGapPlannerTest.TestWorld lavaWorld = world(-1, 3, -1, 1);
        lavaWorld.lava(1, 1, 1);
        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            lavaWorld, new VoxelCell(0, 1, 0), new VoxelCell(1, 1, 0),
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
        assertFalse(plan.accepted());
    }

    @Test
    void preservesOneBlockStepReversibility() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-1, 4, -1, 4, -1, 1);
        world.floor(-1, 1, -1, 1, 0);
        world.support(1, 1, 0);
        world.support(2, 1, 0);
        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world, new VoxelCell(0, 1, 0), new VoxelCell(2, 2, 0),
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
        assertTrue(plan.accepted());
        assertEquals(new VoxelCell(2, 2, 0), plan.stance());
    }

    @Test
    void rejectsPartialHeightTransitAndPrefersEqualLengthFlatRoute() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 8, -1, 5, -2, 8);
        world.floor(-2, 8, -2, 8, 0);
        VoxelCell start = new VoxelCell(2, 1, 0);
        VoxelCell target = new VoxelCell(2, 1, 5);

        // The tempting central shortcut climbs one full block and would later stand on a
        // partial-height bed support. The east lane is equally short and fully canonical.
        world.support(2, 1, 2);
        world.partialHeightSupport(2, 0, 4);

        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world, start, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);

        assertTrue(plan.accepted());
        assertTrue(plan.route().stream().noneMatch(cell ->
            cell.equals(new VoxelCell(2, 1, 4))));
        assertTrue(plan.route().stream().allMatch(cell -> cell.y() == 1));
    }

    @Test
    void routeAndExpansionBoundsFailClosed() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-1, 80, -1, 1);
        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world, new VoxelCell(0, 1, 0), new VoxelCell(70, 1, 0),
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
        assertTrue(plan.accepted());
        assertTrue(plan.frontier());
        assertFalse(plan.targetReached());
        assertTrue(plan.route().size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
        assertTrue(plan.expandedCells() <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void openDiagonalTwentyByTwentyProducesProductiveFrontierBeforeBudget() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-4, 28, -4, 28);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell target = new VoxelCell(20, 1, 20);

        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world, start, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);

        assertTrue(plan.accepted());
        assertTrue(plan.frontier());
        assertEquals(VillageInteractionStancePlanner.MAX_ROUTE_CELLS, plan.route().size());
        assertTrue(horizontalDistance(plan.stance(), target) + 2.0D
            <= horizontalDistance(start, target));
        assertTrue(plan.expandedCells()
            < VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void exactFrontierSelectionUsesTheSameScoreOrderAsEarlyTermination() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-4, 28, -4, 28);
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell target = new VoxelCell(20, 1, 20);

        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world, start, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);

        assertTrue(plan.accepted());
        assertTrue(plan.frontier());
        assertEquals(VillageInteractionStancePlanner.MAX_ROUTE_CELLS, plan.route().size());
        assertEquals(9,
            Math.abs(plan.stance().x() - target.x())
                + Math.abs(plan.stance().z() - target.z()));
        assertEquals(new VoxelCell(20, 1, 11), plan.stance());
    }

    @Test
    void longDiagonalTravelChainsBoundedProductiveFrontiers() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-4, 100, -4, 100);
        VoxelCell current = new VoxelCell(0, 1, 0);
        VoxelCell target = new VoxelCell(80, 1, 80);
        int stages = 0;

        while (!current.equals(target) && stages < 8) {
            double before = horizontalDistance(current, target);
            VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
                world, current, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
            assertTrue(plan.accepted());
            assertTrue(plan.route().size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
            assertTrue(plan.expandedCells()
                < VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
            assertEquals(current, plan.route().getFirst());
            assertTrue(horizontalDistance(plan.stance(), target) < before);
            current = plan.stance();
            stages += 1;
        }

        assertEquals(target, current);
        assertTrue(stages > 1);
        assertTrue(stages <= 8);
    }

    @Test
    void goalDirectedSearchFindsDeterministicObstacleDetour() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-4, 20, -4, 20);
        for (int z = -2; z <= 8; z++) {
            world.solid(6, 1, z);
            world.solid(6, 2, z);
        }
        VoxelCell start = new VoxelCell(0, 1, 0);
        VoxelCell target = new VoxelCell(12, 1, 12);

        VillageInteractionStancePlanner.Plan first = VillageInteractionStancePlanner.plan(
            world, start, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
        VillageInteractionStancePlanner.Plan second = VillageInteractionStancePlanner.plan(
            world, start, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);

        assertTrue(first.accepted());
        assertTrue(first.targetReached());
        assertEquals(target, first.stance());
        assertEquals(first.route(), second.route());
        assertTrue(first.route().stream().noneMatch(cell ->
            cell.x() == 6 && cell.z() <= 8));
        assertTrue(first.route().size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
        assertTrue(first.expandedCells()
            < VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void exactExpansionBudgetRemainsHardForUnreachableInteractionTarget() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-8, 120, -8, 120);
        VillageInteractionStancePlanner.Plan plan = VillageInteractionStancePlanner.plan(
            world,
            new VoxelCell(0, 1, 0),
            new VoxelCell(100, 1, 100),
            VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);

        assertFalse(plan.accepted());
        assertEquals("expanded_budget", plan.reason());
        assertEquals(VillageInteractionStancePlanner.MAX_EXPANDED_CELLS,
            plan.expandedCells());
    }

    @Test
    void occupiedAnchorFallsBackAfterLongDiagonalFrontierChain() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-4, 100, -4, 100);
        VoxelCell current = new VoxelCell(0, 1, 0);
        VoxelCell target = new VoxelCell(80, 1, 80);
        world.solid(target.x(), target.y(), target.z());
        int stages = 0;

        while (horizontalDistance(current, target) > 20.0D && stages < 8) {
            VillageInteractionStancePlanner.Plan stage = VillageInteractionStancePlanner.plan(
                world, current, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
            assertTrue(stage.accepted());
            assertTrue(stage.frontier());
            current = stage.stance();
            stages += 1;
        }
        VillageInteractionStancePlanner.Plan exact = VillageInteractionStancePlanner.plan(
            world, current, target, VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
        VillageInteractionStancePlanner.Plan approach = VillageInteractionStancePlanner.plan(
            world, current, target, VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);

        assertTrue(stages > 1);
        assertFalse(exact.accepted());
        assertTrue(approach.accepted());
        assertFalse(approach.stance().equals(target));
        assertTrue(approach.route().size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
        assertTrue(approach.expandedCells()
            <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void aggregateHarvestUsesOneBoundedCandidateOrderIndependentSearch() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-2, 12, -4, 4);
        VoxelCell start = new VoxelCell(0, 1, 0);
        List<VoxelCell> targets = List.of(
            new VoxelCell(8, 1, 0),
            new VoxelCell(5, 1, 2),
            new VoxelCell(6, 1, -2));
        VillageInteractionStancePlanner.TargetPlan forward =
            VillageInteractionStancePlanner.planAnyHarvest(world, start, targets);
        VillageInteractionStancePlanner.TargetPlan reversed =
            VillageInteractionStancePlanner.planAnyHarvest(
                world, start, targets.reversed());

        assertTrue(forward.accepted());
        assertEquals(forward.target(), reversed.target());
        assertEquals(forward.plan().route(), reversed.plan().route());
        assertTrue(forward.plan().expandedCells()
            <= VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
        assertTrue(forward.plan().route().size()
            <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
    }

    @Test
    void aggregateDiagonalHarvestIsCandidateOrderIndependent() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = world(-4, 32, -4, 32);
        VoxelCell start = new VoxelCell(0, 1, 0);
        List<VoxelCell> targets = List.of(
            new VoxelCell(14, 1, 14),
            new VoxelCell(13, 1, 15),
            new VoxelCell(15, 1, 13));

        VillageInteractionStancePlanner.TargetPlan forward =
            VillageInteractionStancePlanner.planAnyHarvest(world, start, targets);
        VillageInteractionStancePlanner.TargetPlan reversed =
            VillageInteractionStancePlanner.planAnyHarvest(world, start, targets.reversed());

        assertTrue(forward.accepted());
        assertEquals(forward.target(), reversed.target());
        assertEquals(forward.plan().stance(), reversed.plan().stance());
        assertEquals(forward.plan().route(), reversed.plan().route());
        assertTrue(forward.plan().expandedCells()
            < VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    private static SurfaceReturnTrailGapPlannerTest.TestWorld world(
        int minX, int maxX, int minZ, int maxZ
    ) {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(minX, maxX, -2, 4, minZ, maxZ);
        world.floor(minX, maxX, minZ, maxZ, 0);
        return world;
    }

    private static double horizontalDistance(VoxelCell left, VoxelCell right) {
        return Math.hypot(left.x() - right.x(), left.z() - right.z());
    }
}
