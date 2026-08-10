package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MiningWorkspaceReturnFallbackPolicyTest {
    @Test
    void onlyKnownBrokenOrSaturatedReturnAdmissionHandsOff() {
        assertTrue(MiningWorkspaceReturnFallbackPolicy.handoffPrelaunch(
            MiningWorkspaceTraversalController.Mode.RETURN,
            MiningWorkspaceRouteSuffixState.Admission.KNOWN_BROKEN
        ));
        assertTrue(MiningWorkspaceReturnFallbackPolicy.handoffPrelaunch(
            MiningWorkspaceTraversalController.Mode.RETURN,
            MiningWorkspaceRouteSuffixState.Admission.SATURATED
        ));
        assertFalse(MiningWorkspaceReturnFallbackPolicy.handoffPrelaunch(
            MiningWorkspaceTraversalController.Mode.RETURN,
            MiningWorkspaceRouteSuffixState.Admission.AVAILABLE
        ));
        assertFalse(MiningWorkspaceReturnFallbackPolicy.handoffPrelaunch(
            MiningWorkspaceTraversalController.Mode.RESUME,
            MiningWorkspaceRouteSuffixState.Admission.KNOWN_BROKEN
        ));
    }

    @Test
    void onlyStructuralReturnInvalidationHandsOff() {
        assertTrue(MiningWorkspaceReturnFallbackPolicy.handoffStructuralRejection(
            MiningWorkspaceTraversalController.Mode.RETURN,
            "route_invalidated"
        ));
        for (String reason : new String[] {
            "timeout", "route_deviation", "no_progress", "descent_missed", "unexpected_airborne"
        }) {
            assertFalse(MiningWorkspaceReturnFallbackPolicy.handoffStructuralRejection(
                MiningWorkspaceTraversalController.Mode.RETURN,
                reason
            ));
        }
        assertFalse(MiningWorkspaceReturnFallbackPolicy.handoffStructuralRejection(
            MiningWorkspaceTraversalController.Mode.RESUME,
            "route_invalidated"
        ));
    }

    @Test
    void fieldkitHandoffEmitsOnceAndFailsClosedOnStaleIdentity() {
        MiningWorkspaceReturnFallbackPolicy.FieldKitDecision first =
            MiningWorkspaceReturnFallbackPolicy.fieldKitDecision(
                MiningWorkspaceTraversalController.Mode.RETURN,
                "route_invalidated",
                MiningWorkspaceReturnAccessState.BlockResult.BLOCKED,
                false
            );
        assertTrue(first.handled());
        assertTrue(first.emitEvent());

        MiningWorkspaceReturnFallbackPolicy.FieldKitDecision duplicate =
            MiningWorkspaceReturnFallbackPolicy.fieldKitDecision(
                MiningWorkspaceTraversalController.Mode.RETURN,
                "route_invalidated",
                MiningWorkspaceReturnAccessState.BlockResult.ALREADY_BLOCKED,
                true
            );
        assertTrue(duplicate.handled());
        assertFalse(duplicate.emitEvent());

        assertFalse(MiningWorkspaceReturnFallbackPolicy.fieldKitDecision(
            MiningWorkspaceTraversalController.Mode.RETURN,
            "route_invalidated",
            MiningWorkspaceReturnAccessState.BlockResult.STALE_TRAIL,
            false
        ).handled());
        assertFalse(MiningWorkspaceReturnFallbackPolicy.fieldKitDecision(
            MiningWorkspaceTraversalController.Mode.RESUME,
            "route_invalidated",
            MiningWorkspaceReturnAccessState.BlockResult.BLOCKED,
            false
        ).handled());
        assertFalse(MiningWorkspaceReturnFallbackPolicy.fieldKitDecision(
            MiningWorkspaceTraversalController.Mode.RETURN,
            "timeout",
            MiningWorkspaceReturnAccessState.BlockResult.BLOCKED,
            false
        ).handled());
    }
}
