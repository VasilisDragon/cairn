package com.mcbot.fabricclient;

/** Fail-closed admission for retiring a staircase package after a runtime interaction mismatch. */
final class MissionStoneEntryPlanRetirementPolicy {
    static final String RETIRABLE_REASON = "break_interaction_invalid";

    record Evidence(
        MissionStoneMethodPlanner.Method method,
        String planIdentity,
        String rejectionReason,
        int plannedBreakCursor,
        int staircaseStepIndex,
        int controllerVerifiedBreaks,
        int blocksCleared,
        int stepsLanded,
        int safeDropSelections,
        int safeDropDepartures,
        int safeDropLandings,
        int dropsProduced,
        int dropsReconciled,
        int pendingDrops,
        boolean committedMovement,
        MissionStoneExecutionController.MovementPhase movementPhase,
        int baselineCobblestone,
        int authoritativeCobblestone,
        boolean grounded,
        boolean atFrozenOrigin,
        boolean surfaceTrailLandingObserved,
        boolean breakTargetEngaged
    ) {
    }

    record Decision(boolean retire, String reason) {
    }

    private MissionStoneEntryPlanRetirementPolicy() {
    }

    static Decision evaluate(Evidence evidence) {
        if (evidence == null) {
            return denied("missing_evidence");
        }
        if (evidence.method() != MissionStoneMethodPlanner.Method.STAIRCASE) {
            return denied("method_not_staircase");
        }
        if (evidence.planIdentity() == null || evidence.planIdentity().isBlank()) {
            return denied("missing_plan_identity");
        }
        if (!RETIRABLE_REASON.equals(evidence.rejectionReason())) {
            return denied("rejection_not_retirable");
        }
        if (negativeCounter(evidence)) {
            return denied("invalid_negative_counter");
        }
        if (evidence.plannedBreakCursor() != 0
            || evidence.staircaseStepIndex() != 0
            || evidence.controllerVerifiedBreaks() != 0) {
            return denied("controller_progress_observed");
        }
        if (evidence.blocksCleared() != 0 || evidence.stepsLanded() != 0) {
            return denied("physical_progress_observed");
        }
        if (evidence.safeDropSelections() != 0
            || evidence.safeDropDepartures() != 0
            || evidence.safeDropLandings() != 0) {
            return denied("safe_drop_activity_observed");
        }
        if (evidence.dropsProduced() != 0
            || evidence.dropsReconciled() != 0
            || evidence.pendingDrops() != 0) {
            return denied("drop_activity_observed");
        }
        if (evidence.committedMovement()
            || evidence.movementPhase() != MissionStoneExecutionController.MovementPhase.NONE) {
            return denied("movement_activity_observed");
        }
        if (evidence.authoritativeCobblestone() != evidence.baselineCobblestone()) {
            return denied("inventory_changed");
        }
        if (!evidence.grounded() || !evidence.atFrozenOrigin()) {
            return denied("origin_not_stationary");
        }
        if (evidence.surfaceTrailLandingObserved() || evidence.breakTargetEngaged()) {
            return denied("runtime_activity_observed");
        }
        return new Decision(true, "zero_progress_entry_interaction_invalid");
    }

    private static boolean negativeCounter(Evidence evidence) {
        return evidence.plannedBreakCursor() < 0
            || evidence.staircaseStepIndex() < 0
            || evidence.controllerVerifiedBreaks() < 0
            || evidence.blocksCleared() < 0
            || evidence.stepsLanded() < 0
            || evidence.safeDropSelections() < 0
            || evidence.safeDropDepartures() < 0
            || evidence.safeDropLandings() < 0
            || evidence.dropsProduced() < 0
            || evidence.dropsReconciled() < 0
            || evidence.pendingDrops() < 0
            || evidence.baselineCobblestone() < 0
            || evidence.authoritativeCobblestone() < 0;
    }

    private static Decision denied(String reason) {
        return new Decision(false, reason);
    }
}
