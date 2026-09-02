package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class MissionStoneEntryPlanRetirementPolicyTest {
    @Test
    void admitsOnlyTheExactZeroProgressEntryMismatch() {
        MissionStoneEntryPlanRetirementPolicy.Decision decision =
            MissionStoneEntryPlanRetirementPolicy.evaluate(evidence(builder -> { }));

        assertTrue(decision.retire());
        assertEquals("zero_progress_entry_interaction_invalid", decision.reason());
    }

    @Test
    void rejectsMissingWrongMethodIdentityAndReasonEvidence() {
        assertDenied(null, "missing_evidence");
        assertDenied(evidence(builder -> builder.method =
            MissionStoneMethodPlanner.Method.REACHABLE_FACE), "method_not_staircase");
        assertDenied(evidence(builder -> builder.planIdentity = " "), "missing_plan_identity");
        assertDenied(evidence(builder -> builder.rejectionReason = "break_failed:timeout"),
            "rejection_not_retirable");
    }

    @Test
    void rejectsAnyControllerOrPhysicalProgress() {
        assertDenied(evidence(builder -> builder.plannedBreakCursor = -1),
            "invalid_negative_counter");
        assertDenied(evidence(builder -> builder.plannedBreakCursor = 1),
            "controller_progress_observed");
        assertDenied(evidence(builder -> builder.staircaseStepIndex = 1),
            "controller_progress_observed");
        assertDenied(evidence(builder -> builder.controllerVerifiedBreaks = 1),
            "controller_progress_observed");
        assertDenied(evidence(builder -> builder.blocksCleared = 1),
            "physical_progress_observed");
        assertDenied(evidence(builder -> builder.stepsLanded = 1),
            "physical_progress_observed");
    }

    @Test
    void rejectsSafeDropDropMovementAndInventoryActivity() {
        assertDenied(evidence(builder -> builder.safeDropSelections = 1),
            "safe_drop_activity_observed");
        assertDenied(evidence(builder -> builder.safeDropDepartures = 1),
            "safe_drop_activity_observed");
        assertDenied(evidence(builder -> builder.safeDropLandings = 1),
            "safe_drop_activity_observed");
        assertDenied(evidence(builder -> builder.dropsProduced = 1), "drop_activity_observed");
        assertDenied(evidence(builder -> builder.dropsReconciled = 1), "drop_activity_observed");
        assertDenied(evidence(builder -> builder.pendingDrops = 1), "drop_activity_observed");
        assertDenied(evidence(builder -> builder.committedMovement = true),
            "movement_activity_observed");
        assertDenied(evidence(builder -> builder.movementPhase =
            MissionStoneExecutionController.MovementPhase.ALIGNING),
            "movement_activity_observed");
        assertDenied(evidence(builder -> builder.authoritativeCobblestone = 1),
            "inventory_changed");
    }

    @Test
    void rejectsAnyProofThatThePlayerLeftOrEngagedTheRuntime() {
        assertDenied(evidence(builder -> builder.grounded = false), "origin_not_stationary");
        assertDenied(evidence(builder -> builder.atFrozenOrigin = false), "origin_not_stationary");
        assertDenied(evidence(builder -> builder.surfaceTrailLandingObserved = true),
            "runtime_activity_observed");
        assertDenied(evidence(builder -> builder.breakTargetEngaged = true),
            "runtime_activity_observed");
    }

    private static void assertDenied(
        MissionStoneEntryPlanRetirementPolicy.Evidence evidence,
        String reason
    ) {
        MissionStoneEntryPlanRetirementPolicy.Decision decision =
            MissionStoneEntryPlanRetirementPolicy.evaluate(evidence);
        assertFalse(decision.retire());
        assertEquals(reason, decision.reason());
    }

    private static MissionStoneEntryPlanRetirementPolicy.Evidence evidence(
        Consumer<EvidenceBuilder> customization
    ) {
        EvidenceBuilder builder = new EvidenceBuilder();
        customization.accept(builder);
        return builder.build();
    }

    private static final class EvidenceBuilder {
        MissionStoneMethodPlanner.Method method = MissionStoneMethodPlanner.Method.STAIRCASE;
        String planIdentity = "staircase:west:8,68,42";
        String rejectionReason = MissionStoneEntryPlanRetirementPolicy.RETIRABLE_REASON;
        int plannedBreakCursor;
        int staircaseStepIndex;
        int controllerVerifiedBreaks;
        int blocksCleared;
        int stepsLanded;
        int safeDropSelections;
        int safeDropDepartures;
        int safeDropLandings;
        int dropsProduced;
        int dropsReconciled;
        int pendingDrops;
        boolean committedMovement;
        MissionStoneExecutionController.MovementPhase movementPhase =
            MissionStoneExecutionController.MovementPhase.NONE;
        int baselineCobblestone;
        int authoritativeCobblestone;
        boolean grounded = true;
        boolean atFrozenOrigin = true;
        boolean surfaceTrailLandingObserved;
        boolean breakTargetEngaged;

        MissionStoneEntryPlanRetirementPolicy.Evidence build() {
            return new MissionStoneEntryPlanRetirementPolicy.Evidence(
                method,
                planIdentity,
                rejectionReason,
                plannedBreakCursor,
                staircaseStepIndex,
                controllerVerifiedBreaks,
                blocksCleared,
                stepsLanded,
                safeDropSelections,
                safeDropDepartures,
                safeDropLandings,
                dropsProduced,
                dropsReconciled,
                pendingDrops,
                committedMovement,
                movementPhase,
                baselineCobblestone,
                authoritativeCobblestone,
                grounded,
                atFrozenOrigin,
                surfaceTrailLandingObserved,
                breakTargetEngaged
            );
        }
    }
}
