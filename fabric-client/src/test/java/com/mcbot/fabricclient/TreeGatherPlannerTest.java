package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class TreeGatherPlannerTest {
    @Test
    void choosesLowestReachableLogBeforeCloserUpperLog() {
        Set<BlockPos> cluster = Set.of(new BlockPos(1, 64, 1), new BlockPos(1, 65, 1));
        List<LogTarget> reachable = List.of(
            new LogTarget("oak_log", 8, 64, 8, 1.0D),
            new LogTarget("oak_log", 1, 65, 1, 1.0D),
            new LogTarget("oak_log", 1, 64, 1, 5.0D)
        );

        TreeGatherPlanner.Selection selection = TreeGatherPlanner.chooseNext(cluster, reachable, Set.of(), Set.of());

        assertEquals(new BlockPos(1, 64, 1), selection.target());
        assertEquals(2, selection.reachableCandidates());
        assertEquals(1, selection.leftUnreachable());
        assertEquals("reachable_tree_log", selection.reason());
    }

    @Test
    void skipsCompletedAndAbandonedTreeLogs() {
        BlockPos low = new BlockPos(1, 64, 1);
        BlockPos mid = new BlockPos(1, 65, 1);
        BlockPos high = new BlockPos(1, 66, 1);
        Set<BlockPos> cluster = Set.of(low, mid, high);
        List<LogTarget> reachable = List.of(
            new LogTarget("oak_log", 1, 64, 1, 1.0D),
            new LogTarget("oak_log", 1, 65, 1, 2.0D),
            new LogTarget("oak_log", 1, 66, 1, 3.0D)
        );

        TreeGatherPlanner.Selection selection = TreeGatherPlanner.chooseNext(cluster, reachable, Set.of(low), Set.of(mid));

        assertEquals(high, selection.target());
        assertEquals(1, selection.reachableCandidates());
        assertEquals(0, selection.leftUnreachable());
    }

    @Test
    void reportsUnreachableLiveLogsWithoutChoosing() {
        Set<BlockPos> cluster = Set.of(new BlockPos(1, 64, 1), new BlockPos(1, 65, 1));
        List<LogTarget> reachable = List.of(new LogTarget("oak_log", 4, 64, 4, 1.0D));

        TreeGatherPlanner.Selection selection = TreeGatherPlanner.chooseNext(cluster, reachable, Set.of(), Set.of());

        assertNull(selection.target());
        assertEquals(0, selection.reachableCandidates());
        assertEquals(2, selection.leftUnreachable());
        assertEquals("no_reachable_tree_logs", selection.reason());
    }

    @Test
    void fallsBackToNearestSeededLiveLogWhenSnapshotReachabilityIsEmpty() {
        BlockPos nearSeed = new BlockPos(-8, 24, 12);
        BlockPos farSeed = new BlockPos(-15, 24, 12);
        Set<BlockPos> cluster = Set.of(nearSeed, farSeed);
        List<LogTarget> reachable = List.of();

        TreeGatherPlanner.Selection selection = TreeGatherPlanner.chooseNext(
            cluster,
            reachable,
            Set.of(),
            Set.of(),
            new BlockPos(-7, 24, 12)
        );

        assertEquals(nearSeed, selection.target());
        assertEquals(0, selection.reachableCandidates());
        assertEquals(1, selection.leftUnreachable());
        assertEquals("nearest_tree_log_fallback", selection.reason());
    }
}
