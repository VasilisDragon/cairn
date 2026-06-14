package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class MineNearbyIronTargetPlannerTest {
    @Test
    void currentTargetClearsOnlyWhenTheObservedBlockNoLongerMatches() {
        MineNearbyIronTargetPlanner.Decision noTarget = MineNearbyIronTargetPlanner.decideCurrentTarget(false, true, false);
        assertEquals(MineNearbyIronTargetPlanner.Action.CONTINUE, noTarget.action());

        MineNearbyIronTargetPlanner.Decision stillIron = MineNearbyIronTargetPlanner.decideCurrentTarget(true, true, true);
        assertEquals(MineNearbyIronTargetPlanner.Action.CONTINUE, stillIron.action());

        MineNearbyIronTargetPlanner.Decision ironCleared = MineNearbyIronTargetPlanner.decideCurrentTarget(true, true, false);
        assertEquals(MineNearbyIronTargetPlanner.Action.TARGET_CLEARED_IRON, ironCleared.action());
        assertEquals("mine_nearby_iron_target_cleared", ironCleared.reason());

        MineNearbyIronTargetPlanner.Decision prospectCleared = MineNearbyIronTargetPlanner.decideCurrentTarget(true, false, false);
        assertEquals(MineNearbyIronTargetPlanner.Action.TARGET_CLEARED_PROSPECT, prospectCleared.action());
    }

    @Test
    void visibleIronSelectionPrecedesProspecting() {
        MineNearbyIronTargetPlanner.Decision visible = MineNearbyIronTargetPlanner.decideVisibleIronSelection(true);
        assertEquals(MineNearbyIronTargetPlanner.Action.SELECT_IRON_TARGET, visible.action());

        MineNearbyIronTargetPlanner.Decision missing = MineNearbyIronTargetPlanner.decideVisibleIronSelection(false);
        assertEquals(MineNearbyIronTargetPlanner.Action.PROSPECT_REQUIRED, missing.action());
    }

    @Test
    void prospectLimitFailsAtTheExistingInclusiveCap() {
        MineNearbyIronTargetPlanner.Decision below = MineNearbyIronTargetPlanner.decideProspectLimit(7, 8);
        assertEquals(MineNearbyIronTargetPlanner.Action.CONTINUE, below.action());

        MineNearbyIronTargetPlanner.Decision atCap = MineNearbyIronTargetPlanner.decideProspectLimit(8, 8);
        assertEquals(MineNearbyIronTargetPlanner.Action.FAIL_PROSPECT_LIMIT, atCap.action());
        assertEquals("mine_nearby_iron_no_iron_after_prospecting", atCap.reason());
    }

    @Test
    void localProspectFallbackEitherSelectsOrFailsNoVisibleTarget() {
        MineNearbyIronTargetPlanner.Decision selected = MineNearbyIronTargetPlanner.decideLocalProspectFallback(true);
        assertEquals(MineNearbyIronTargetPlanner.Action.SELECT_PROSPECT_TARGET, selected.action());

        MineNearbyIronTargetPlanner.Decision missing = MineNearbyIronTargetPlanner.decideLocalProspectFallback(false);
        assertEquals(MineNearbyIronTargetPlanner.Action.FAIL_NO_VISIBLE_TARGET, missing.action());
        assertEquals("mine_nearby_iron_no_visible_iron_or_prospect_target", missing.reason());
    }

    @Test
    void branchCandidatePriorityMatchesTheInlineProspectLoop() {
        MineNearbyIronTargetPlanner.Decision unsafe = MineNearbyIronTargetPlanner.decideBranchCandidate(
            "support_missing:0,63,0",
            true,
            true,
            true,
            "stone",
            "stone",
            false,
            false,
            false
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_SKIP_UNSAFE, unsafe.action());
        assertEquals("support_missing:0,63,0", unsafe.reason());

        MineNearbyIronTargetPlanner.Decision upper = MineNearbyIronTargetPlanner.decideBranchCandidate(
            null,
            true,
            true,
            true,
            "stone",
            "stone",
            false,
            false,
            false
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_SELECT_UPPER, upper.action());

        MineNearbyIronTargetPlanner.Decision lower = MineNearbyIronTargetPlanner.decideBranchCandidate(
            null,
            false,
            true,
            true,
            "stone",
            "air",
            false,
            false,
            false
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_SELECT_LOWER, lower.action());

        MineNearbyIronTargetPlanner.Decision move = MineNearbyIronTargetPlanner.decideBranchCandidate(
            null,
            false,
            false,
            true,
            "air",
            "air",
            false,
            false,
            false
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_MOVE_TO_CELL, move.action());

        MineNearbyIronTargetPlanner.Decision blocked = MineNearbyIronTargetPlanner.decideBranchCandidate(
            null,
            false,
            false,
            false,
            "dirt",
            "gravel",
            false,
            false,
            false
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_BLOCKED, blocked.action());
        assertEquals("branch_face_not_prospectable:dirt,gravel", blocked.reason());
    }

    @Test
    void branchCandidateSkipsExcludedTargetsAndHardOccludedLowerTarget() {
        MineNearbyIronTargetPlanner.Decision upperExcluded = MineNearbyIronTargetPlanner.decideBranchCandidate(
            null,
            true,
            false,
            false,
            "air",
            "stone",
            true,
            false,
            false
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_BLOCKED, upperExcluded.action());
        assertEquals("branch_targets_excluded:air,stone", upperExcluded.reason());

        MineNearbyIronTargetPlanner.Decision lowerExcluded = MineNearbyIronTargetPlanner.decideBranchCandidate(
            null,
            false,
            true,
            false,
            "stone",
            "air",
            false,
            true,
            false
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_BLOCKED, lowerExcluded.action());
        assertEquals("branch_targets_excluded:stone,air", lowerExcluded.reason());

        MineNearbyIronTargetPlanner.Decision hardOccludedLower = MineNearbyIronTargetPlanner.decideBranchCandidate(
            null,
            false,
            true,
            false,
            "stone",
            "crafting_table",
            false,
            false,
            true
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_BLOCKED, hardOccludedLower.action());
        assertEquals("branch_lower_occluded:crafting_table", hardOccludedLower.reason());
    }

    @Test
    void prospectCellMoveUsesExistingArrivalEpsilon() {
        MineNearbyIronTargetPlanner.Decision reached = MineNearbyIronTargetPlanner.decideProspectCellMove(0.24D, 0.25D);
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_CELL_REACHED, reached.action());
        assertEquals("mine_nearby_iron_branch_cell_reached", reached.reason());

        MineNearbyIronTargetPlanner.Decision move = MineNearbyIronTargetPlanner.decideProspectCellMove(0.26D, 0.25D);
        assertEquals(MineNearbyIronTargetPlanner.Action.BRANCH_CELL_MOVE, move.action());
    }

    @Test
    void breakResultClassifiesIronProspectReselectAndContinueBranches() {
        MineNearbyIronTargetPlanner.Decision iron = MineNearbyIronTargetPlanner.decideBreakResult(
            BlockBreakController.Status.BROKEN,
            true,
            "verified"
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BREAK_DONE_IRON, iron.action());
        assertEquals("mine_nearby_iron_break_done", iron.reason());

        MineNearbyIronTargetPlanner.Decision prospect = MineNearbyIronTargetPlanner.decideBreakResult(
            BlockBreakController.Status.BROKEN,
            false,
            "verified"
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BREAK_DONE_PROSPECT, prospect.action());

        MineNearbyIronTargetPlanner.Decision reposition = MineNearbyIronTargetPlanner.decideBreakResult(
            BlockBreakController.Status.REPOSITION,
            true,
            "not_visible"
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BREAK_RESELECT, reposition.action());
        assertEquals("mine_nearby_iron_reselect:not_visible", reposition.reason());

        MineNearbyIronTargetPlanner.Decision failed = MineNearbyIronTargetPlanner.decideBreakResult(
            BlockBreakController.Status.FAILED,
            true,
            "timeout"
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BREAK_RESELECT_FAILED, failed.action());
        assertEquals("mine_nearby_iron_reselect_failed:timeout", failed.reason());

        MineNearbyIronTargetPlanner.Decision running = MineNearbyIronTargetPlanner.decideBreakResult(
            BlockBreakController.Status.RUNNING,
            true,
            "progress"
        );
        assertEquals(MineNearbyIronTargetPlanner.Action.BREAK_CONTINUE, running.action());
        assertEquals("mine_nearby_iron_breaking:progress", running.reason());
    }
}
