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
        if (liveCluster == null || liveCluster.isEmpty()) {
            return new Selection(null, 0, 0, "tree_exhausted");
        }
        Set<BlockPos> done = completed == null ? Set.of() : completed;
        Set<BlockPos> skip = abandoned == null ? Set.of() : abandoned;
        Set<BlockPos> remaining = new HashSet<>();
        for (BlockPos pos : liveCluster) {
            if (pos == null || done.contains(pos) || skip.contains(pos)) {
                continue;
            }
            remaining.add(pos.toImmutable());
        }
        if (remaining.isEmpty()) {
            return new Selection(null, 0, 0, "tree_exhausted");
        }
        int reachableCandidates = 0;
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
                return new Selection(candidate.toImmutable(), reachableCandidates, remaining.size() - 1, "reachable_tree_log");
            }
        }
        return new Selection(null, reachableCandidates, remaining.size(), "no_reachable_tree_logs");
    }
}
