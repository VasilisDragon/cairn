package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.OptionalInt;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class McbotFabricClientGatherTreeTest {
    private static final class SingleCellSurfacePerception implements GridPerception {
        private final GridCell cell;
        private final int surfaceY;

        private SingleCellSurfacePerception(GridCell cell, int surfaceY) {
            this.cell = cell;
            this.surfaceY = surfaceY;
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return !cell.equals(new GridCell(x, z));
        }

        @Override
        public int minX() {
            return -16;
        }

        @Override
        public int maxX() {
            return 16;
        }

        @Override
        public int minZ() {
            return -16;
        }

        @Override
        public int maxZ() {
            return 16;
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            if (cell.equals(new GridCell(x, z))) {
                return OptionalInt.of(surfaceY);
            }
            return OptionalInt.empty();
        }
    }

    private static final class LineSurfacePerception implements GridPerception {
        private final int maxX;

        private LineSurfacePerception(int maxX) {
            this.maxX = maxX;
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return surfaceY(x, z).isEmpty();
        }

        @Override
        public int minX() {
            return 0;
        }

        @Override
        public int maxX() {
            return maxX;
        }

        @Override
        public int minZ() {
            return 0;
        }

        @Override
        public int maxZ() {
            return 0;
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            if (x >= 0 && x <= maxX && z == 0) {
                return OptionalInt.of(64);
            }
            return OptionalInt.empty();
        }
    }

    private static final class DescendingLineSurfacePerception implements GridPerception {
        private final int maxX;
        private final int startSurfaceY;

        private DescendingLineSurfacePerception(int maxX, int startSurfaceY) {
            this.maxX = maxX;
            this.startSurfaceY = startSurfaceY;
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return surfaceY(x, z).isEmpty();
        }

        @Override
        public int minX() {
            return 0;
        }

        @Override
        public int maxX() {
            return maxX;
        }

        @Override
        public int minZ() {
            return 0;
        }

        @Override
        public int maxZ() {
            return 0;
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            if (x >= 0 && x <= maxX && z == 0) {
                return OptionalInt.of(startSurfaceY - x);
            }
            return OptionalInt.empty();
        }
    }

    @Test
    void preservesActiveGatherTreeSeedForSameCommandWhenLiveScanIsEmpty() {
        BlockPos activeSeed = new BlockPos(190, 65, 295);

        BlockPos seed = McbotFabricClient.preserveActiveGatherTreeSeedForCommand(
            "mission-35",
            null,
            "mission-35",
            activeSeed
        );

        assertEquals(activeSeed, seed);
    }

    @Test
    void doesNotReuseActiveGatherTreeSeedForDifferentCommand() {
        BlockPos seed = McbotFabricClient.preserveActiveGatherTreeSeedForCommand(
            "mission-36",
            null,
            "mission-35",
            new BlockPos(190, 65, 295)
        );

        assertNull(seed);
    }

    @Test
    void keepsActiveGatherTreeSeedOverExplicitSeedForSameCommand() {
        BlockPos explicitSeed = new BlockPos(12, 64, -8);
        BlockPos activeSeed = new BlockPos(190, 65, 295);

        BlockPos seed = McbotFabricClient.preserveActiveGatherTreeSeedForCommand(
            "mission-35",
            explicitSeed,
            "mission-35",
            activeSeed
        );

        assertEquals(activeSeed, seed);
    }

    @Test
    void keepsExplicitGatherTreeSeedWhenActiveCommandDiffers() {
        BlockPos explicitSeed = new BlockPos(12, 64, -8);

        BlockPos seed = McbotFabricClient.preserveActiveGatherTreeSeedForCommand(
            "mission-36",
            explicitSeed,
            "mission-35",
            new BlockPos(190, 65, 295)
        );

        assertEquals(explicitSeed, seed);
    }

    @Test
    void rejectsContinuationDirectRouteWhenSideCellIsFarBelowTargetY() {
        GridCell start = new GridCell(-3, 12);
        GridCell sideCell = new GridCell(-6, 11);
        GridPerception perception = new SingleCellSurfacePerception(sideCell, 1);

        boolean allowed = McbotFabricClient.shouldUseGatherTreeContinuationDirectRoute(
            perception,
            start,
            sideCell,
            24
        );

        assertFalse(allowed);
    }

    @Test
    void allowsContinuationDirectRouteWhenSideCellIsAtTargetHeight() {
        GridCell start = new GridCell(-3, 12);
        GridCell sideCell = new GridCell(-6, 11);
        GridPerception perception = new SingleCellSurfacePerception(sideCell, 24);

        boolean allowed = McbotFabricClient.shouldUseGatherTreeContinuationDirectRoute(
            perception,
            start,
            sideCell,
            24
        );

        assertTrue(allowed);
    }

    @Test
    void allowsRowAxisContinuationWhenClearedCellIsStandableAtTargetHeight() {
        GridCell start = new GridCell(-3, 12);
        GridCell clearedRowCell = new GridCell(-6, 12);
        GridCell target = new GridCell(-7, 12);
        GridPerception perception = new SingleCellSurfacePerception(clearedRowCell, 24);

        boolean allowed = McbotFabricClient.shouldUseGatherTreeRowAxisContinuationCell(
            perception,
            start,
            clearedRowCell,
            target,
            24,
            true,
            true,
            Set.of()
        );

        assertTrue(allowed);
    }

    @Test
    void rejectsRowAxisContinuationWhenClearedCellDropsFarBelowTarget() {
        GridCell start = new GridCell(-3, 12);
        GridCell clearedRowCell = new GridCell(-6, 12);
        GridCell target = new GridCell(-7, 12);
        GridPerception perception = new SingleCellSurfacePerception(clearedRowCell, 1);

        boolean allowed = McbotFabricClient.shouldUseGatherTreeRowAxisContinuationCell(
            perception,
            start,
            clearedRowCell,
            target,
            24,
            true,
            true,
            Set.of()
        );

        assertFalse(allowed);
    }

    @Test
    void rejectsRowAxisContinuationWhenCellWasAlreadySkipped() {
        GridCell start = new GridCell(-3, 12);
        GridCell clearedRowCell = new GridCell(-6, 12);
        GridCell target = new GridCell(-7, 12);
        GridPerception perception = new SingleCellSurfacePerception(clearedRowCell, 24);

        boolean allowed = McbotFabricClient.shouldUseGatherTreeRowAxisContinuationCell(
            perception,
            start,
            clearedRowCell,
            target,
            24,
            true,
            true,
            Set.of(clearedRowCell)
        );

        assertFalse(allowed);
    }

    @Test
    void navigationJumpStillAppliesWhileFollowerIsTurning() {
        InputState turning = new InputState(false, false, false, false, false, false, 0.0F, 0.0F);

        InputState input = McbotFabricClient.navigationInputWithJump(turning, true, false);

        assertFalse(input.pressingForward());
        assertEquals(0.0F, input.movementForward());
        assertTrue(input.jumping());
    }

    @Test
    void navigationStepJumpAddsForwardInputWhileTurning() {
        InputState turning = new InputState(false, false, false, false, false, false, 0.0F, 0.0F);

        InputState input = McbotFabricClient.navigationInputWithJump(turning, true, true);

        assertTrue(input.pressingForward());
        assertEquals(1.0F, input.movementForward());
        assertTrue(input.jumping());
    }

    @Test
    void navigationStepJumpBoostsArcingForwardInput() {
        InputState arcing = new InputState(true, false, false, false, false, false, 0.18F, 0.0F);

        InputState input = McbotFabricClient.navigationInputWithJump(arcing, true, true);

        assertTrue(input.pressingForward());
        assertEquals(1.0F, input.movementForward());
        assertTrue(input.jumping());
    }

    @Test
    void arcingUnstickJumpCanHoldJumpBeforeStagnantThreshold() {
        boolean jump = McbotFabricClient.shouldForceGatherNavigationArcJump(
            "arcing_to_target",
            true,
            0.77D,
            0.80D,
            1
        );

        assertTrue(jump);
    }

    @Test
    void arcingUnstickJumpRejectsFarWaypoint() {
        boolean jump = McbotFabricClient.shouldForceGatherNavigationArcJump(
            "arcing_to_target",
            true,
            3.5D,
            3.5D,
            1
        );

        assertFalse(jump);
    }

    @Test
    void arcingUnstickJumpRejectsNonArcingReason() {
        boolean jump = McbotFabricClient.shouldForceGatherNavigationArcJump(
            "turning_to_target",
            true,
            0.77D,
            0.80D,
            1
        );

        assertFalse(jump);
    }

    @Test
    void targetOutOfReachRetryIsAllowedBeforeBreakStarts() {
        assertTrue(McbotFabricClient.shouldRetryGatherTreeTargetOutOfReach("target_out_of_reach", 0));
    }

    @Test
    void targetOutOfReachRetryStopsAtBound() {
        assertFalse(McbotFabricClient.shouldRetryGatherTreeTargetOutOfReach("target_out_of_reach", 2));
    }

    @Test
    void targetOutOfReachRetryRejectsOtherFailures() {
        assertFalse(McbotFabricClient.shouldRetryGatherTreeTargetOutOfReach("break_timeout", 0));
    }

    @Test
    void treeExhaustedClusterIsIgnoredForNextGatherCommand() {
        Set<BlockPos> cluster = Set.of(new BlockPos(1, 70, 9));

        assertTrue(McbotFabricClient.shouldIgnoreUnusableGatherTreeCluster(cluster, "tree_exhausted"));
    }

    @Test
    void executorDeadlineClusterIsIgnoredForNextGatherCommand() {
        Set<BlockPos> cluster = Set.of(new BlockPos(1, 70, 9));

        assertTrue(McbotFabricClient.shouldIgnoreUnusableGatherTreeCluster(cluster, "executor_deadline"));
    }

    @Test
    void ordinarySmallFailureDoesNotIgnoreTreeCluster() {
        Set<BlockPos> cluster = Set.of(new BlockPos(1, 70, 9));

        assertFalse(McbotFabricClient.shouldIgnoreUnusableGatherTreeCluster(cluster, "break_timeout"));
    }

    @Test
    void partialTreeExhaustionRetryIsAllowedWhenWoodProgressIsShortOfTarget() {
        assertTrue(McbotFabricClient.shouldRetryPartialGatherTreeExhaustion("tree_exhausted", 13, 0, 0));
    }

    @Test
    void partialTreeExhaustionRetryStopsAfterBound() {
        assertFalse(McbotFabricClient.shouldRetryPartialGatherTreeExhaustion("tree_exhausted", 13, 0, 1));
    }

    @Test
    void partialTreeExhaustionRetryRejectsNoProgress() {
        assertFalse(McbotFabricClient.shouldRetryPartialGatherTreeExhaustion("tree_exhausted", 13, 13, 0));
    }

    @Test
    void partialTreeExhaustionRetryRejectsEnoughLogs() {
        assertFalse(McbotFabricClient.shouldRetryPartialGatherTreeExhaustion("tree_exhausted", 14, 0, 0));
    }

    @Test
    void partialTreeExhaustionRetryRejectsOtherReasons() {
        assertFalse(McbotFabricClient.shouldRetryPartialGatherTreeExhaustion("no_reachable_tree_logs", 13, 0, 0));
    }

    @Test
    void gatherTreeSelectionCacheKeyIsStableForIdenticalInputsAndChangesPerInput() {
        long base = McbotFabricClient.gatherTreeSelectionCacheKey(10, 64, -3, 8, 2, 1, 0);
        assertTrue(base == McbotFabricClient.gatherTreeSelectionCacheKey(10, 64, -3, 8, 2, 1, 0));
        assertTrue(base != McbotFabricClient.gatherTreeSelectionCacheKey(11, 64, -3, 8, 2, 1, 0));
        assertTrue(base != McbotFabricClient.gatherTreeSelectionCacheKey(10, 65, -3, 8, 2, 1, 0));
        assertTrue(base != McbotFabricClient.gatherTreeSelectionCacheKey(10, 64, -4, 8, 2, 1, 0));
        assertTrue(base != McbotFabricClient.gatherTreeSelectionCacheKey(10, 64, -3, 7, 2, 1, 0));
        assertTrue(base != McbotFabricClient.gatherTreeSelectionCacheKey(10, 64, -3, 8, 3, 1, 0));
        assertTrue(base != McbotFabricClient.gatherTreeSelectionCacheKey(10, 64, -3, 8, 2, 2, 0));
        assertTrue(base != McbotFabricClient.gatherTreeSelectionCacheKey(10, 64, -3, 8, 2, 1, 1));
    }

    @Test
    void gatherTreeSearchSelectionCacheKeyIsStableForIdenticalInputsAndChangesPerInput() {
        long base = McbotFabricClient.gatherTreeSearchSelectionCacheKey(10, 64, -3, 5, 2);
        // Identical inputs -> identical key (cache hit, returns the memoized target).
        assertTrue(base == McbotFabricClient.gatherTreeSearchSelectionCacheKey(10, 64, -3, 5, 2));
        // A moved block-pos (any axis) -> different key, forcing a fresh scan.
        assertTrue(base != McbotFabricClient.gatherTreeSearchSelectionCacheKey(11, 64, -3, 5, 2));
        assertTrue(base != McbotFabricClient.gatherTreeSearchSelectionCacheKey(10, 65, -3, 5, 2));
        assertTrue(base != McbotFabricClient.gatherTreeSearchSelectionCacheKey(10, 64, -2, 5, 2));
        // A consumed goal (visitedGoals grew) -> different key.
        assertTrue(base != McbotFabricClient.gatherTreeSearchSelectionCacheKey(10, 64, -3, 6, 2));
        // A newly-ignored seed column (blacklist grew) -> different key.
        assertTrue(base != McbotFabricClient.gatherTreeSearchSelectionCacheKey(10, 64, -3, 5, 3));
    }

    @Test
    void reachableSeedCandidateFingerprintIsOrderIndependentAndContentSensitive() {
        BlockPos first = new BlockPos(4, 70, -2);
        BlockPos second = new BlockPos(-7, 65, 9);

        long forward = McbotFabricClient.gatherTreeCandidateFingerprint(List.of(first, second));
        long reverse = McbotFabricClient.gatherTreeCandidateFingerprint(List.of(second, first));
        long changed = McbotFabricClient.gatherTreeCandidateFingerprint(
            List.of(first, new BlockPos(-7, 66, 9))
        );

        assertEquals(forward, reverse);
        assertFalse(forward == changed);
    }

    @Test
    void reachableSeedCacheKeyTracksWorldCommandStartCandidatesAndExclusions() {
        VoxelCell start = new VoxelCell(10, 64, -3);
        long base = McbotFabricClient.gatherTreeReachableSeedCacheKey(
            17,
            "minecraft:overworld",
            "mission-1",
            start,
            41L,
            59L
        );

        assertEquals(base, McbotFabricClient.gatherTreeReachableSeedCacheKey(
            17, "minecraft:overworld", "mission-1", start, 41L, 59L));
        assertFalse(base == McbotFabricClient.gatherTreeReachableSeedCacheKey(
            18, "minecraft:overworld", "mission-1", start, 41L, 59L));
        assertFalse(base == McbotFabricClient.gatherTreeReachableSeedCacheKey(
            17, "minecraft:the_nether", "mission-1", start, 41L, 59L));
        assertFalse(base == McbotFabricClient.gatherTreeReachableSeedCacheKey(
            17, "minecraft:overworld", "mission-2", start, 41L, 59L));
        assertFalse(base == McbotFabricClient.gatherTreeReachableSeedCacheKey(
            17, "minecraft:overworld", "mission-1", new VoxelCell(11, 64, -3), 41L, 59L));
        assertFalse(base == McbotFabricClient.gatherTreeReachableSeedCacheKey(
            17, "minecraft:overworld", "mission-1", start, 42L, 59L));
        assertFalse(base == McbotFabricClient.gatherTreeReachableSeedCacheKey(
            17, "minecraft:overworld", "mission-1", start, 41L, 60L));
    }

    @Test
    void reachableSeedRejectionDeduplicatesOneFrozenFingerprintAcrossMovementAndCommands() {
        String signature = McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            7, "minecraft:overworld", "initial_seed", 123L, 456L, "no_reachable_break_stance");

        assertEquals(signature, McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            7, "minecraft:overworld", "initial_seed", 123L, 456L, "no_reachable_break_stance"));
        assertFalse(signature.equals(McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            8, "minecraft:overworld", "initial_seed", 123L, 456L, "no_reachable_break_stance")));
        assertFalse(signature.equals(McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            7, "minecraft:the_nether", "initial_seed", 123L, 456L, "no_reachable_break_stance")));
        assertFalse(signature.equals(McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            7, "minecraft:overworld", "cluster_target", 123L, 456L, "no_reachable_break_stance")));
        assertFalse(signature.equals(McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            7, "minecraft:overworld", "initial_seed", 124L, 456L, "no_reachable_break_stance")));
        assertFalse(signature.equals(McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            7, "minecraft:overworld", "initial_seed", 123L, 457L, "no_reachable_break_stance")));
        assertFalse(signature.equals(McbotFabricClient.gatherTreeReachableSeedRejectionSignature(
            7, "minecraft:overworld", "initial_seed", 123L, 456L, "start_unstandable")));
    }

    @Test
    void unreachableGatherTreeDropIsAbandonedWhenSideCollectIsUnavailable() {
        assertTrue(McbotFabricClient.shouldAbandonGatherTreeUnreachableDrop(86.0D, 101.0D, false));
    }

    @Test
    void reachableGatherTreeDropIsStillCollectedDirectly() {
        assertFalse(McbotFabricClient.shouldAbandonGatherTreeUnreachableDrop(100.0D, 101.0D, false));
    }

    @Test
    void availableSideCollectKeepsHighGatherTreeDropActive() {
        assertFalse(McbotFabricClient.shouldAbandonGatherTreeUnreachableDrop(86.0D, 101.0D, true));
    }

    @Test
    void rejectsUpwardDirectCollectFallbackWhenTargetIsTooFarToJumpPickup() {
        assertFalse(McbotFabricClient.shouldUseDirectCollectFallback(2.17D, 17.0D, 16.0D));
    }

    @Test
    void allowsCloseUpwardDirectCollectFallbackForNearbyDrop() {
        assertTrue(McbotFabricClient.shouldUseDirectCollectFallback(0.44D, 27.35D, 26.0D));
    }

    @Test
    void rejectedGatherTreeItemCollectRouteIsAbandonedLocally() {
        assertTrue(McbotFabricClient.shouldAbandonGatherTreeCollectRouteRejection(
            "gather_tree_collect_item",
            "mission-1:tree:collect:item",
            "target_rejected_no_path"
        ));
    }

    @Test
    void rejectedNonTreeCollectRouteIsNotAbandonedAsTreeDrop() {
        assertFalse(McbotFabricClient.shouldAbandonGatherTreeCollectRouteRejection(
            "gather_log_collect_drop",
            "mission-1:collect",
            "target_rejected_no_path"
        ));
    }

    @Test
    void gatherTreeCollectRouteOnlyAbandonsNoPathRejections() {
        assertFalse(McbotFabricClient.shouldAbandonGatherTreeCollectRouteRejection(
            "gather_tree_collect_item",
            "mission-1:tree:collect:item",
            "turning_to_target"
        ));
    }

    @Test
    void relaxedSearchFrontierEscapesSmallReachableSteepPatch() {
        GridPerception perception = new LineSurfacePerception(4);
        GridCell start = new GridCell(0, 0);
        Set<GridCell> visited = Set.of(start);

        List<GridCell> normal = McbotFabricClient.gatherTreeLocalFrontierRoute(
            perception,
            start,
            start,
            visited,
            Set.of(),
            4,
            4,
            12
        );
        List<GridCell> relaxed = McbotFabricClient.gatherTreeLocalFrontierRoute(
            perception,
            start,
            start,
            visited,
            Set.of(),
            2,
            1,
            12
        );

        assertEquals(List.of(), normal);
        assertEquals(List.of(
            new GridCell(0, 0),
            new GridCell(1, 0),
            new GridCell(2, 0),
            new GridCell(3, 0),
            new GridCell(4, 0)
        ), relaxed);
    }

    @Test
    void gatherTreeSearchSurfaceBoundRejectsRavineFloorRoutes() {
        GridPerception raw = new DescendingLineSurfacePerception(8, 64);
        GridPerception bounded = McbotFabricClient.gatherTreeSurfaceBoundedPerception(raw, 64);
        GridCell start = new GridCell(0, 0);

        assertTrue(bounded.surfaceY(6, 0).isPresent());
        assertTrue(bounded.surfaceY(7, 0).isEmpty());

        List<GridCell> route = McbotFabricClient.gatherTreeLocalFrontierRoute(
            bounded,
            start,
            start,
            Set.of(),
            Set.of(),
            7,
            1,
            12
        );

        assertEquals(List.of(), route);
    }

    @Test
    void gatherTreeSearchCompletesAfterBoundedRouteAttempts() {
        assertFalse(McbotFabricClient.shouldCompleteGatherTreeSearch(0L, 2, 0));
        assertTrue(McbotFabricClient.shouldCompleteGatherTreeSearch(0L, 3, 0));
        assertTrue(McbotFabricClient.shouldCompleteGatherTreeSearch(29_000L, 0, 0));
        // R0b·3: a barren spawn (routeAttempts stays low) relocates on the route-unavailable streak.
        assertFalse(McbotFabricClient.shouldCompleteGatherTreeSearch(0L, 0, 11));
        assertTrue(McbotFabricClient.shouldCompleteGatherTreeSearch(0L, 0, 12));
    }
}
