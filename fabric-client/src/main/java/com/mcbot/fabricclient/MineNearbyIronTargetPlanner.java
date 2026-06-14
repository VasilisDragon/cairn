package com.mcbot.fabricclient;

final class MineNearbyIronTargetPlanner {
    private MineNearbyIronTargetPlanner() {
    }

    enum Action {
        CONTINUE,
        TARGET_CLEARED_IRON,
        TARGET_CLEARED_PROSPECT,
        SELECT_IRON_TARGET,
        PROSPECT_REQUIRED,
        FAIL_PROSPECT_LIMIT,
        SELECT_PROSPECT_TARGET,
        FAIL_NO_VISIBLE_TARGET,
        BRANCH_SKIP_UNSAFE,
        BRANCH_SELECT_UPPER,
        BRANCH_SELECT_LOWER,
        BRANCH_MOVE_TO_CELL,
        BRANCH_BLOCKED,
        BRANCH_CELL_REACHED,
        BRANCH_CELL_MOVE,
        BREAK_DONE_IRON,
        BREAK_DONE_PROSPECT,
        BREAK_RESELECT,
        BREAK_RESELECT_FAILED,
        BREAK_CONTINUE
    }

    record Decision(Action action, String reason) {
    }

    static Decision decideCurrentTarget(boolean hasTarget, boolean targetIron, boolean stillTargetable) {
        if (!hasTarget || stillTargetable) {
            return new Decision(Action.CONTINUE, "");
        }
        return new Decision(targetIron ? Action.TARGET_CLEARED_IRON : Action.TARGET_CLEARED_PROSPECT, "mine_nearby_iron_target_cleared");
    }

    static Decision decideVisibleIronSelection(boolean hasVisibleIronTarget) {
        return new Decision(hasVisibleIronTarget ? Action.SELECT_IRON_TARGET : Action.PROSPECT_REQUIRED, "");
    }

    static Decision decideProspectLimit(int prospectBlocksBroken, int maxProspectBlocks) {
        if (prospectBlocksBroken >= maxProspectBlocks) {
            return new Decision(Action.FAIL_PROSPECT_LIMIT, "mine_nearby_iron_no_iron_after_prospecting");
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decideLocalProspectFallback(boolean hasProspectTarget) {
        return new Decision(hasProspectTarget ? Action.SELECT_PROSPECT_TARGET : Action.FAIL_NO_VISIBLE_TARGET, "mine_nearby_iron_no_visible_iron_or_prospect_target");
    }

    static Decision decideBranchCandidate(
        String unsafeReason,
        boolean upperProspectable,
        boolean lowerProspectable,
        boolean openCell,
        String lowerBlockId,
        String upperBlockId,
        boolean upperExcluded,
        boolean lowerExcluded,
        boolean lowerHardOccluded
    ) {
        if (unsafeReason != null) {
            return new Decision(Action.BRANCH_SKIP_UNSAFE, unsafeReason);
        }
        if (upperProspectable && !upperExcluded) {
            return new Decision(Action.BRANCH_SELECT_UPPER, "upper");
        }
        if (lowerProspectable && !lowerExcluded && !lowerHardOccluded) {
            return new Decision(Action.BRANCH_SELECT_LOWER, "lower");
        }
        if (openCell) {
            return new Decision(Action.BRANCH_MOVE_TO_CELL, "open_cell");
        }
        if (lowerHardOccluded) {
            return new Decision(Action.BRANCH_BLOCKED, "branch_lower_occluded:" + safe(upperBlockId));
        }
        if ((upperProspectable && upperExcluded) || (lowerProspectable && lowerExcluded)) {
            return new Decision(Action.BRANCH_BLOCKED, "branch_targets_excluded:" + safe(lowerBlockId) + "," + safe(upperBlockId));
        }
        return new Decision(Action.BRANCH_BLOCKED, "branch_face_not_prospectable:" + safe(lowerBlockId) + "," + safe(upperBlockId));
    }

    static Decision decideProspectCellMove(double distance, double arrivalEpsilon) {
        if (distance <= arrivalEpsilon) {
            return new Decision(Action.BRANCH_CELL_REACHED, "mine_nearby_iron_branch_cell_reached");
        }
        return new Decision(Action.BRANCH_CELL_MOVE, "mine_nearby_iron_branch_move");
    }

    static Decision decideBreakResult(BlockBreakController.Status status, boolean targetIron, String reason) {
        if (status == BlockBreakController.Status.BROKEN) {
            return new Decision(targetIron ? Action.BREAK_DONE_IRON : Action.BREAK_DONE_PROSPECT, "mine_nearby_iron_break_done");
        }
        if (status == BlockBreakController.Status.REPOSITION) {
            return new Decision(Action.BREAK_RESELECT, "mine_nearby_iron_reselect:" + safe(reason));
        }
        if (status == BlockBreakController.Status.FAILED) {
            return new Decision(Action.BREAK_RESELECT_FAILED, "mine_nearby_iron_reselect_failed:" + safe(reason));
        }
        return new Decision(Action.BREAK_CONTINUE, "mine_nearby_iron_breaking:" + safe(reason));
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
