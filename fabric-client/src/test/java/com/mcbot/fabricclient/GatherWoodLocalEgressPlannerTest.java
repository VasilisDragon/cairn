package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class GatherWoodLocalEgressPlannerTest {
    @Test
    void preservesStandableStartAndNormalizesSameColumnSupport() {
        TestWorld standable = new TestWorld(-2, 2, 60, 68, -2, 2);
        standable.floor(-2, 2, -2, 2, 63);
        GatherWoodLocalEgressPlanner.Result unchanged = plan(
            standable, new VoxelCell(0, 64, 0), true, false, new VoxelCell(2, 64, 0), Set.of());
        assertFalse(unchanged.recoveryRequired());
        assertEquals("already_standable", unchanged.failureReason());

        TestWorld slabMismatch = new TestWorld(-2, 2, 60, 68, -2, 2);
        slabMismatch.solid(0, 64, 0);
        slabMismatch.floor(-2, 2, -2, 2, 64);
        GatherWoodLocalEgressPlanner.Result normalized = GatherWoodLocalEgressPlanner.plan(
            slabMismatch,
            new VoxelCell(0, 64, 0),
            65.0D,
            true,
            false,
            new VoxelCell(2, 65, 0),
            Set.of()
        );
        assertTrue(normalized.found());
        assertEquals(GatherWoodLocalEgressPlanner.Mode.NORMALIZED, normalized.plan().mode());
        assertEquals(new VoxelCell(0, 65, 0), normalized.plan().anchor());

        GatherWoodLocalEgressPlanner.Result partialHeight = GatherWoodLocalEgressPlanner.plan(
            slabMismatch,
            new VoxelCell(0, 64, 0),
            64.5D,
            true,
            false,
            new VoxelCell(2, 65, 0),
            Set.of()
        );
        assertEquals(GatherWoodLocalEgressPlanner.Mode.STEP, partialHeight.plan().mode());
        assertFalse(partialHeight.plan().anchor().equals(new VoxelCell(0, 65, 0)));
    }

    @Test
    void waitsForAirborneDryPlayerWithoutSpendingMovement() {
        TestWorld world = new TestWorld(-2, 2, 60, 68, -2, 2);

        GatherWoodLocalEgressPlanner.Result result = plan(
            world, new VoxelCell(0, 64, 0), false, false, new VoxelCell(2, 64, 0), Set.of());

        assertTrue(result.found());
        assertEquals(GatherWoodLocalEgressPlanner.Mode.SETTLE, result.plan().mode());
        assertTrue(result.plan().path().isEmpty());
    }

    @Test
    void selectsLevelStepStepUpAndThreeBlockDrop() {
        TestWorld level = new TestWorld(-1, 4, 58, 70, -1, 1);
        level.support(1, 63, 0);
        level.support(2, 63, 0);
        assertEquals(
            GatherWoodLocalEgressPlanner.Mode.STEP,
            plan(level, new VoxelCell(0, 64, 0), true, false, new VoxelCell(4, 64, 0), Set.of()).plan().mode()
        );

        TestWorld stepUp = new TestWorld(-1, 4, 58, 70, -1, 1);
        stepUp.support(1, 64, 0);
        stepUp.support(2, 64, 0);
        GatherWoodLocalEgressPlanner.Plan up = plan(
            stepUp, new VoxelCell(0, 64, 0), true, false, new VoxelCell(4, 65, 0), Set.of()).plan();
        assertEquals(GatherWoodLocalEgressPlanner.Mode.STEP, up.mode());
        assertEquals(new VoxelCell(1, 65, 0), up.anchor());

        TestWorld drop = new TestWorld(-1, 4, 56, 70, -1, 1);
        drop.support(1, 60, 0);
        drop.support(2, 60, 0);
        GatherWoodLocalEgressPlanner.Plan down = plan(
            drop, new VoxelCell(0, 64, 0), true, false, new VoxelCell(4, 61, 0), Set.of()).plan();
        assertEquals(GatherWoodLocalEgressPlanner.Mode.SAFE_DROP, down.mode());
        assertEquals(-3, down.verticalDelta());
    }

    @Test
    void findsNearestConnectedDryShoreAndHonorsExclusionAndTargetRanking() {
        TestWorld water = new TestWorld(-1, 7, 60, 68, -2, 2);
        water.floor(-1, 7, 0, 0, 63);
        for (int x = 0; x <= 3; x++) {
            water.water(x, 64, 0);
        }
        GatherWoodLocalEgressPlanner.Result shore = plan(
            water, new VoxelCell(0, 64, 0), false, true, new VoxelCell(7, 64, 0), Set.of());
        assertTrue(shore.found(), shore.failureReason());
        assertEquals(GatherWoodLocalEgressPlanner.Mode.SWIM, shore.plan().mode());
        assertEquals(new VoxelCell(4, 64, 0), shore.plan().anchor());

        GatherWoodLocalEgressPlanner.Result shallowGrounded = plan(
            water, new VoxelCell(0, 64, 0), true, true, new VoxelCell(7, 64, 0), Set.of());
        assertTrue(shallowGrounded.found(), shallowGrounded.failureReason());
        assertEquals(GatherWoodLocalEgressPlanner.Mode.SWIM, shallowGrounded.plan().mode());
        assertEquals(new VoxelCell(4, 64, 0), shallowGrounded.plan().anchor());

        TestWorld bentChannel = new TestWorld(-1, 3, 60, 68, -1, 4);
        bentChannel.water(0, 64, 0);
        bentChannel.water(1, 64, 0);
        bentChannel.water(1, 64, 1);
        bentChannel.water(1, 64, 2);
        bentChannel.support(1, 63, 3);
        bentChannel.support(1, 63, 4);
        GatherWoodLocalEgressPlanner.Result aroundCorner = plan(
            bentChannel,
            new VoxelCell(0, 64, 0),
            false,
            true,
            new VoxelCell(1, 64, 4),
            Set.of()
        );
        assertTrue(aroundCorner.found(), aroundCorner.failureReason());
        assertEquals(new VoxelCell(1, 64, 3), aroundCorner.plan().anchor());
        assertTrue(aroundCorner.plan().path().stream().anyMatch(cell -> cell.x() == 1 && cell.z() == 0));
        assertTrue(aroundCorner.plan().path().stream().anyMatch(cell -> cell.x() == 1 && cell.z() == 2));

        TestWorld fork = new TestWorld(-2, 2, 60, 68, -2, 2);
        fork.support(1, 63, 0);
        fork.support(2, 63, 0);
        fork.support(0, 63, 1);
        fork.support(0, 63, 2);
        GatherWoodLocalEgressPlanner.Plan towardZ = plan(
            fork,
            new VoxelCell(0, 64, 0),
            true,
            false,
            new VoxelCell(0, 64, 8),
            Set.of(new VoxelCell(0, 64, 1))
        ).plan();
        assertEquals(new VoxelCell(1, 64, 0), towardZ.anchor());
    }

    @Test
    void rejectsExcessiveDropHazardLavaBlockedBodyUnstableAndBoxedAnchors() {
        TestWorld deep = new TestWorld(-1, 3, 54, 70, -1, 1);
        deep.support(1, 59, 0);
        deep.support(2, 59, 0);
        assertFalse(plan(
            deep, new VoxelCell(0, 64, 0), true, false, new VoxelCell(3, 60, 0), Set.of()).found());

        TestWorld hazard = new TestWorld(-1, 3, 60, 68, -1, 1);
        hazard.support(1, 63, 0);
        hazard.support(2, 63, 0);
        hazard.hazard(1, 63, 0);
        assertFalse(plan(
            hazard, new VoxelCell(0, 64, 0), true, false, new VoxelCell(3, 64, 0), Set.of()).found());

        TestWorld lava = new TestWorld(-1, 3, 60, 68, -1, 1);
        lava.support(1, 63, 0);
        lava.support(2, 63, 0);
        lava.lava(1, 64, 1);
        assertFalse(plan(
            lava, new VoxelCell(0, 64, 0), true, false, new VoxelCell(3, 64, 0), Set.of()).found());

        TestWorld blocked = new TestWorld(-1, 3, 60, 68, -1, 1);
        blocked.support(1, 63, 0);
        blocked.solid(1, 64, 0);
        assertFalse(plan(
            blocked, new VoxelCell(0, 64, 0), true, false, new VoxelCell(3, 64, 0), Set.of()).found());

        TestWorld boxed = new TestWorld(-1, 2, 60, 68, -1, 1);
        boxed.support(1, 63, 0);
        assertFalse(plan(
            boxed, new VoxelCell(0, 64, 0), true, false, new VoxelCell(2, 64, 0), Set.of()).found());
    }

    @Test
    void rejectsWaterWithoutShoreAndEnforcesDeterministicBudget() {
        TestWorld noExitWorld = new TestWorld(-3, 3, 60, 68, -3, 3);
        noExitWorld.floor(-3, 3, -3, 3, 63);
        for (int x = -3; x <= 3; x++) {
            for (int z = -3; z <= 3; z++) {
                noExitWorld.water(x, 64, z);
            }
        }
        GatherWoodLocalEgressPlanner.Result noShore = plan(
            noExitWorld, new VoxelCell(0, 64, 0), false, true, new VoxelCell(3, 64, 0), Set.of());
        assertFalse(noShore.found());
        assertEquals("water_without_dry_exit", noShore.failureReason());

        TestWorld water = new TestWorld(-8, 8, 60, 68, -8, 8);
        water.floor(-8, 8, -8, 8, 63);
        for (int x = -8; x <= 8; x++) {
            for (int z = -8; z <= 8; z++) {
                water.water(x, 64, z);
            }
        }
        GatherWoodLocalEgressPlanner.Result first = GatherWoodLocalEgressPlanner.plan(
            water,
            new VoxelCell(0, 64, 0),
            64.2D,
            false,
            true,
            new VoxelCell(7, 64, 0),
            Set.of(),
            17
        );
        GatherWoodLocalEgressPlanner.Result second = GatherWoodLocalEgressPlanner.plan(
            water,
            new VoxelCell(0, 64, 0),
            64.2D,
            false,
            true,
            new VoxelCell(7, 64, 0),
            Set.of(),
            17
        );
        assertEquals(first, second);
        assertEquals(17, first.examinedCells());
        assertEquals("examined_budget", first.failureReason());
        assertTrue(first.examinedCells() <= GatherWoodLocalEgressPlanner.MAX_EXAMINED_CELLS);
    }

    @Test
    void retainsAnAdmittedAdjacentShoreWhenTheDefaultSearchBudgetIsExhausted() {
        TestWorld water = broadPondWithAdjacentDryShore();
        VoxelCell shore = new VoxelCell(1, 64, 0);
        assertTrue(water.isStandable(shore.x(), shore.y(), shore.z()));
        assertFalse(water.isWater(shore.x(), shore.y(), shore.z()));
        assertEquals(new VoxelCell(2, 64, 0),
            VoxelAStar.resolveTraversalMove(water, shore, new VoxelCell(1, 0, 0)).destination());

        GatherWoodLocalEgressPlanner.Result result = GatherWoodLocalEgressPlanner.plan(
            water, new VoxelCell(0, 64, 0), 64.2D, false, true,
            new VoxelCell(7, 64, 0), Set.of());

        assertTrue(result.found(), "An admitted connected shore was discarded: " + result.failureReason());
        assertEquals(shore, result.plan().anchor());
        assertEquals(GatherWoodLocalEgressPlanner.Mode.SWIM, result.plan().mode());
        assertEquals(java.util.List.of(new VoxelCell(0, 64, 0), shore), result.plan().path());
        assertTrue(result.examinedCells() <= GatherWoodLocalEgressPlanner.MAX_EXAMINED_CELLS);
    }

    @Test
    void retainsAnAdmittedShoreWithoutIncreasingASmallExplicitBudget() {
        TestWorld water = broadPondWithAdjacentDryShore();
        GatherWoodLocalEgressPlanner.Result first = GatherWoodLocalEgressPlanner.plan(
            water, new VoxelCell(0, 64, 0), 64.2D, false, true,
            new VoxelCell(7, 64, 0), Set.of(), 17);
        GatherWoodLocalEgressPlanner.Result second = GatherWoodLocalEgressPlanner.plan(
            water, new VoxelCell(0, 64, 0), 64.2D, false, true,
            new VoxelCell(7, 64, 0), Set.of(), 17);

        assertTrue(first.found(), "An admitted connected shore was discarded: " + first.failureReason());
        assertEquals(first, second);
        assertEquals(new VoxelCell(1, 64, 0), first.plan().anchor());
        assertTrue(first.examinedCells() <= 17);
    }

    @Test
    void retainsARaisedDryShoreInABroadPhysicallyStablePond() {
        TestWorld water = broadPondWithRaisedDryShore();
        VoxelCell shore = new VoxelCell(1, 65, 0);
        assertTrue(water.isStandable(shore.x(), shore.y(), shore.z()));
        assertEquals(new VoxelCell(2, 65, 0),
            VoxelAStar.resolveTraversalMove(water, shore, new VoxelCell(1, 0, 0)).destination());

        GatherWoodLocalEgressPlanner.Result result = GatherWoodLocalEgressPlanner.plan(
            water, new VoxelCell(0, 64, 0), 64.2D, false, true,
            new VoxelCell(7, 65, 0), Set.of());

        assertTrue(result.found(), "The raised shore was discarded: " + result.failureReason());
        assertEquals(shore, result.plan().anchor());
        assertEquals(java.util.List.of(new VoxelCell(0, 64, 0), shore), result.plan().path());
        assertTrue(result.examinedCells() <= GatherWoodLocalEgressPlanner.MAX_EXAMINED_CELLS);
    }

    @Test
    void neverSelectsTheShoreBeforeItsAdmissionCellFitsWithinTheBudget() {
        TestWorld water = broadPondWithRaisedDryShore();
        for (int budget = 1; budget <= 17; budget++) {
            GatherWoodLocalEgressPlanner.Result result = GatherWoodLocalEgressPlanner.plan(
                water, new VoxelCell(0, 64, 0), 64.2D, false, true, null, Set.of(), budget);
            assertEquals(budget, result.examinedCells());
            // Five initial/normalization cells, then +X at dy=-1, 0, +1.
            assertEquals(budget >= 8, result.found(), "budget=" + budget);
            if (result.found()) {
                assertEquals(new VoxelCell(1, 65, 0), result.plan().anchor());
                assertEquals("connected_dry_shore_bounded", result.plan().reason());
            } else {
                assertEquals("examined_budget", result.failureReason());
            }
        }
    }

    @Test
    void preservesDownstreamRankingAndDeterministicTieBreaksAmongAdmittedCandidates() {
        TestWorld water = broadPondWithRaisedDryShore();
        water.replaceWaterWithSupport(-1, 64, 0);
        water.replaceWaterWithSupport(-2, 64, 0);
        for (VoxelCell target : List.of(new VoxelCell(-7, 65, 0), new VoxelCell(7, 65, 0))) {
            GatherWoodLocalEgressPlanner.Result first = GatherWoodLocalEgressPlanner.plan(
                water, new VoxelCell(0, 64, 0), 64.2D, false, true, target, Set.of(), 17);
            GatherWoodLocalEgressPlanner.Result second = GatherWoodLocalEgressPlanner.plan(
                water, new VoxelCell(0, 64, 0), 64.2D, false, true, target, Set.of(), 17);
            assertTrue(first.found(), first.failureReason());
            assertEquals(first, second);
            assertEquals(new VoxelCell(Integer.signum(target.x()), 65, 0), first.plan().anchor());
        }
        GatherWoodLocalEgressPlanner.Result tied = GatherWoodLocalEgressPlanner.plan(
            water, new VoxelCell(0, 64, 0), 64.2D, false, true, null, Set.of(), 17);
        assertEquals(new VoxelCell(-1, 65, 0), tied.plan().anchor());
    }

    @Test
    void excludedShoresRemainIneligibleWhenTheSearchCapIsReached() {
        GatherWoodLocalEgressPlanner.Result result = GatherWoodLocalEgressPlanner.plan(
            broadPondWithRaisedDryShore(), new VoxelCell(0, 64, 0), 64.2D, false, true,
            new VoxelCell(7, 65, 0), Set.of(new VoxelCell(1, 65, 0), new VoxelCell(2, 65, 0)));
        assertFalse(result.found());
        assertEquals("examined_budget", result.failureReason());
        assertEquals(512, result.examinedCells());
    }

    @Test
    void exhaustedSearchStillRejectsHazardLavaBlockedHeadAndWetShore() {
        TestWorld hazardous = broadPondWithRaisedDryShore();
        hazardous.hazard(1, 64, 0);
        hazardous.hazard(2, 64, 0);
        TestWorld lava = broadPondWithRaisedDryShore();
        lava.lava(1, 65, 1);
        lava.lava(2, 65, 1);
        TestWorld blocked = broadPondWithRaisedDryShore();
        blocked.solid(1, 66, 0);
        blocked.solid(2, 66, 0);
        TestWorld wet = broadPondWithRaisedDryShore();
        wet.water(1, 65, 0);
        wet.water(2, 65, 0);
        for (TestWorld water : List.of(hazardous, lava, blocked, wet)) {
            GatherWoodLocalEgressPlanner.Result result = GatherWoodLocalEgressPlanner.plan(
                water, new VoxelCell(0, 64, 0), 64.2D, false, true, null, Set.of());
            assertFalse(result.found());
            assertEquals("examined_budget", result.failureReason());
            assertEquals(512, result.examinedCells());
        }
    }

    @Test
    void aDrySingleCellIslandWithoutSafeEgressIsNotRetained() {
        TestWorld water = broadPondWithAdjacentDryShore();
        water.support(1, 64, 0);
        water.water(2, 64, 0);
        assertTrue(water.isStandable(1, 65, 0));
        GatherWoodLocalEgressPlanner.Result result = GatherWoodLocalEgressPlanner.plan(
            water, new VoxelCell(0, 64, 0), 64.2D, false, true, null, Set.of());
        assertFalse(result.found());
        assertEquals("examined_budget", result.failureReason());
    }

    @Test
    void retainsTheHardSearchCapAndTheExistingCompleteSearchReason() {
        GatherWoodLocalEgressPlanner.Result capped = GatherWoodLocalEgressPlanner.plan(
            broadPondWithRaisedDryShore(), new VoxelCell(0, 64, 0), 64.2D, false, true,
            null, Set.of(), Integer.MAX_VALUE);
        assertTrue(capped.found());
        assertEquals(512, capped.examinedCells());
        assertEquals("connected_dry_shore_bounded", capped.plan().reason());

        TestWorld small = new TestWorld(-1, 4, 60, 68, -1, 1);
        small.water(0, 64, 0);
        small.support(1, 64, 0);
        small.support(2, 64, 0);
        GatherWoodLocalEgressPlanner.Result complete = GatherWoodLocalEgressPlanner.plan(
            small, new VoxelCell(0, 64, 0), 64.2D, false, true, null, Set.of());
        assertTrue(complete.found());
        assertTrue(complete.examinedCells() < 512);
        assertEquals("connected_dry_shore", complete.plan().reason());
    }

    @Test
    void boundedShorePlanUsesUnchangedTraversalArrivalAndTimeoutContracts() {
        VoxelCell start = new VoxelCell(0, 64, 0);
        GatherWoodLocalEgressPlanner.Plan plan = GatherWoodLocalEgressPlanner.plan(
            broadPondWithRaisedDryShore(), start, 64.2D, false, true, null, Set.of()).plan();
        VoxelCell waypoint = GatherWoodLocalEgressTraversal.nextWaypoint(plan.path(), start);
        assertEquals(plan.anchor(), waypoint);
        assertEquals(new GatherWoodLocalEgressTraversal.Drive(true, true, false),
            GatherWoodLocalEgressTraversal.drive(plan.mode(), true, true, false, start, waypoint));
        assertFalse(GatherWoodLocalEgressTraversal.reached(plan.mode(), waypoint, 65.0D, true, true, waypoint));
        assertFalse(GatherWoodLocalEgressTraversal.reached(plan.mode(), waypoint, 65.0D, false, false, waypoint));
        assertTrue(GatherWoodLocalEgressTraversal.reached(plan.mode(), waypoint, 65.0D, true, false, waypoint));
        assertFalse(GatherWoodLocalEgressTraversal.timedOut(plan.mode(), 1_000L, 8_999L));
        assertTrue(GatherWoodLocalEgressTraversal.timedOut(plan.mode(), 1_000L, 9_000L));
        assertFalse(GatherWoodLocalEgressTraversal.canCompute(2));
    }

    @Test
    void doesNotChangeDryOriginBudgetExhaustion() {
        TestWorld dry = new TestWorld(-1, 4, 60, 68, -1, 1);
        dry.support(1, 63, 0);
        dry.support(2, 63, 0);
        GatherWoodLocalEgressPlanner.Result result = GatherWoodLocalEgressPlanner.plan(
            dry, new VoxelCell(0, 64, 0), 64.2D, true, false, null, Set.of(), 7);
        assertFalse(result.found());
        assertEquals("examined_budget", result.failureReason());
        assertEquals(7, result.examinedCells());
    }

    private static TestWorld broadPondWithRaisedDryShore() {
        TestWorld water = broadPondWithAdjacentDryShore();
        water.support(1, 64, 0);
        water.support(2, 64, 0);
        return water;
    }

    private static TestWorld broadPondWithAdjacentDryShore() {
        TestWorld water = new TestWorld(-8, 8, 60, 68, -8, 8);
        water.floor(-8, 8, -8, 8, 63);
        for (int x = -8; x <= 8; x++) {
            for (int z = -8; z <= 8; z++) {
                if (z == 0 && (x == 1 || x == 2)) {
                    continue;
                }
                water.water(x, 64, z);
            }
        }
        return water;
    }

    private static GatherWoodLocalEgressPlanner.Result plan(
        TestWorld world,
        VoxelCell start,
        boolean grounded,
        boolean touchingWater,
        VoxelCell target,
        Set<VoxelCell> excluded
    ) {
        return GatherWoodLocalEgressPlanner.plan(
            world, start, start.y() + 0.2D, grounded, touchingWater, target, excluded);
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

        void replaceWaterWithSupport(int x, int y, int z) {
            VoxelCell cell = new VoxelCell(x, y, z);
            water.remove(cell);
            hazards.remove(cell);
            solid.add(cell);
        }

        void solid(int x, int y, int z) {
            solid.add(new VoxelCell(x, y, z));
        }

        void hazard(int x, int y, int z) {
            hazards.add(new VoxelCell(x, y, z));
        }

        void water(int x, int y, int z) {
            VoxelCell cell = new VoxelCell(x, y, z);
            water.add(cell);
            hazards.add(cell);
        }

        void lava(int x, int y, int z) {
            VoxelCell cell = new VoxelCell(x, y, z);
            lava.add(cell);
            hazards.add(cell);
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
