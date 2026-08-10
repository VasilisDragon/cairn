package com.mcbot.fabricclient;

final class MiningWorkspaceReturnFallbackPolicy {
    record FieldKitDecision(boolean handled, boolean emitEvent) {
        private static final FieldKitDecision UNHANDLED = new FieldKitDecision(false, false);
    }

    private MiningWorkspaceReturnFallbackPolicy() {
    }

    static boolean handoffPrelaunch(
        MiningWorkspaceTraversalController.Mode mode,
        MiningWorkspaceRouteSuffixState.Admission admission
    ) {
        return mode == MiningWorkspaceTraversalController.Mode.RETURN
            && (admission == MiningWorkspaceRouteSuffixState.Admission.KNOWN_BROKEN
                || admission == MiningWorkspaceRouteSuffixState.Admission.SATURATED);
    }

    static boolean handoffStructuralRejection(
        MiningWorkspaceTraversalController.Mode mode,
        String reason
    ) {
        return mode == MiningWorkspaceTraversalController.Mode.RETURN
            && "route_invalidated".equals(reason);
    }

    static FieldKitDecision fieldKitDecision(
        MiningWorkspaceTraversalController.Mode mode,
        String reason,
        MiningWorkspaceReturnAccessState.BlockResult blockResult,
        boolean alreadyLatched
    ) {
        if (!handoffStructuralRejection(mode, reason) || blockResult == null) {
            return FieldKitDecision.UNHANDLED;
        }
        if (blockResult == MiningWorkspaceReturnAccessState.BlockResult.BLOCKED) {
            return new FieldKitDecision(true, !alreadyLatched);
        }
        if (blockResult == MiningWorkspaceReturnAccessState.BlockResult.ALREADY_BLOCKED
            && alreadyLatched) {
            return new FieldKitDecision(true, false);
        }
        return FieldKitDecision.UNHANDLED;
    }
}
