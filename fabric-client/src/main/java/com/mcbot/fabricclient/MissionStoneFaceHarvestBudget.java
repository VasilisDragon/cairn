package com.mcbot.fabricclient;

/**
 * Command-scoped authority for the bounded reachable-face shortcut.
 *
 * <p>Only a world-verified stone production consumes the allowance. Replanning, target replacement,
 * and drop reconciliation deliberately have no reset operation; a new {@code mine_nearby_stone}
 * command receives a new instance with the normal eight-block allowance.
 */
final class MissionStoneFaceHarvestBudget {
    enum RecordResult {
        RECORDED,
        IGNORED_NON_FACE,
        EXHAUSTED
    }

    private int harvestedBlocks;

    int harvestedBlocks() {
        return harvestedBlocks;
    }

    int remainingBlocks() {
        return Math.max(0, MissionStoneMethodPlanner.FACE_BLOCK_LIMIT - harvestedBlocks);
    }

    RecordResult recordVerifiedProduction(MissionStoneMethodPlanner.Method method) {
        if (method != MissionStoneMethodPlanner.Method.REACHABLE_FACE) {
            return RecordResult.IGNORED_NON_FACE;
        }
        if (remainingBlocks() <= 0) {
            return RecordResult.EXHAUSTED;
        }
        harvestedBlocks++;
        return RecordResult.RECORDED;
    }
}
