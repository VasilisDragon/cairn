package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;

final class TreeGatherPlanner {
    private TreeGatherPlanner() {
    }

    record Selection(BlockPos target, int reachableCandidates, int leftUnreachable, String reason) {
    }

    static Selection chooseNext(
        Set<BlockPos> liveCluster,
        List<LogTarget> reachableLogs,
        Set<BlockPos> completed,
        Set<BlockPos> abandoned
    ) {
        return chooseNext(liveCluster, reachableLogs, completed, abandoned, Set.of(), null, false);
    }

    static Selection chooseNext(
        Set<BlockPos> liveCluster,
        List<LogTarget> reachableLogs,
        Set<BlockPos> completed,
        Set<BlockPos> abandoned,
        BlockPos fallbackAnchor
    ) {
        return chooseNext(liveCluster, reachableLogs, completed, abandoned, Set.of(), fallbackAnchor, true);
    }

    static Selection chooseNext(
        Set<BlockPos> liveCluster,
        List<LogTarget> reachableLogs,
        Set<BlockPos> completed,
        Set<BlockPos> abandoned,
        Set<GridCell> abandonedColumns
    ) {
        return chooseNext(liveCluster, reachableLogs, completed, abandoned, abandonedColumns, null, false);
    }

    static Selection chooseNext(
        Set<BlockPos> liveCluster,
        List<LogTarget> reachableLogs,
        Set<BlockPos> completed,
        Set<BlockPos> abandoned,
        Set<GridCell> abandonedColumns,
        BlockPos fallbackAnchor
    ) {
        return chooseNext(liveCluster, reachableLogs, completed, abandoned, abandonedColumns, fallbackAnchor, true);
    }

    private static Selection chooseNext(
        Set<BlockPos> liveCluster,
        List<LogTarget> reachableLogs,
        Set<BlockPos> completed,
        Set<BlockPos> abandoned,
        Set<GridCell> abandonedColumns,
        BlockPos fallbackAnchor,
        boolean allowFallback
    ) {
        if (liveCluster == null || liveCluster.isEmpty()) {
            return new Selection(null, 0, 0, "tree_exhausted");
        }
        Set<BlockPos> done = completed == null ? Set.of() : completed;
        Set<BlockPos> skip = abandoned == null ? Set.of() : abandoned;
        // Drop-collect-abandon column exclusion (parallel to the per-log `skip` filter): a whole XZ
        // column is excluded once a drop from it was abandoned, so reselection cannot climb the same
        // trunk into an identical unreachable drop. Empty set = no column exclusion (legacy callers).
        Set<GridCell> skipColumns = abandonedColumns == null ? Set.of() : abandonedColumns;
        Set<BlockPos> remaining = new HashSet<>();
        for (BlockPos pos : liveCluster) {
            if (pos == null || done.contains(pos) || skip.contains(pos)) {
                continue;
            }
            if (!skipColumns.isEmpty() && skipColumns.contains(new GridCell(pos.getX(), pos.getZ()))) {
                continue;
            }
            remaining.add(pos.toImmutable());
        }
        if (remaining.isEmpty()) {
            return new Selection(null, 0, 0, "tree_exhausted");
        }
        int reachableCandidates = 0;
        LogTarget bestReachable = null;
        BlockPos bestCandidate = null;
        if (reachableLogs != null) {
            for (LogTarget log : reachableLogs) {
                if (log == null) {
                    continue;
                }
                BlockPos candidate = new BlockPos(log.x(), log.y(), log.z());
                if (!remaining.contains(candidate)) {
                    continue;
                }
                reachableCandidates++;
                if (bestReachable == null || compareReachableLog(log, bestReachable) < 0) {
                    bestReachable = log;
                    bestCandidate = candidate.toImmutable();
                }
            }
        }
        if (bestCandidate != null) {
            return new Selection(bestCandidate, reachableCandidates, remaining.size() - 1, "reachable_tree_log");
        }
        if (allowFallback) {
            BlockPos fallback = nearestRemaining(remaining, fallbackAnchor);
            if (fallback != null) {
                return new Selection(fallback.toImmutable(), reachableCandidates, remaining.size() - 1, "nearest_tree_log_fallback");
            }
        }
        return new Selection(null, reachableCandidates, remaining.size(), "no_reachable_tree_logs");
    }

    private static BlockPos nearestRemaining(Set<BlockPos> remaining, BlockPos anchor) {
        if (remaining == null || remaining.isEmpty()) {
            return null;
        }
        BlockPos origin = anchor == null ? BlockPos.ORIGIN : anchor;
        BlockPos best = null;
        long bestDistance = Long.MAX_VALUE;
        for (BlockPos candidate : remaining) {
            if (candidate == null) {
                continue;
            }
            long distance = squaredDistance(candidate, origin);
            if (best == null
                || distance < bestDistance
                || (distance == bestDistance && compareBlockPos(candidate, best) < 0)) {
                best = candidate;
                bestDistance = distance;
            }
        }
        return best;
    }

    private static long squaredDistance(BlockPos a, BlockPos b) {
        long dx = (long) a.getX() - b.getX();
        long dy = (long) a.getY() - b.getY();
        long dz = (long) a.getZ() - b.getZ();
        return dx * dx + dy * dy + dz * dz;
    }

    private static int compareBlockPos(BlockPos a, BlockPos b) {
        int byY = Integer.compare(a.getY(), b.getY());
        if (byY != 0) {
            return byY;
        }
        int byX = Integer.compare(a.getX(), b.getX());
        if (byX != 0) {
            return byX;
        }
        return Integer.compare(a.getZ(), b.getZ());
    }

    private static int compareReachableLog(LogTarget a, LogTarget b) {
        int byY = Integer.compare(a.y(), b.y());
        if (byY != 0) {
            return byY;
        }
        int byDistance = Double.compare(a.distance(), b.distance());
        if (byDistance != 0) {
            return byDistance;
        }
        int byX = Integer.compare(a.x(), b.x());
        if (byX != 0) {
            return byX;
        }
        return Integer.compare(a.z(), b.z());
    }
}
