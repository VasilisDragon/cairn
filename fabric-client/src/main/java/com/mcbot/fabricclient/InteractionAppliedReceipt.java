package com.mcbot.fabricclient;

import net.minecraft.util.ActionResult;

/** Immutable acknowledgement returned by the sole physical interaction sink. */
record InteractionAppliedReceipt(
    String requestId,
    InteractionDemand.Action action,
    Disposition disposition,
    boolean applied,
    ActionResult actionResult,
    long timestampMs,
    String reason,
    FabricMotionMode mode,
    FabricInteractionController.Output appliedOutput,
    FabricInteractionController.Output shadowOutput,
    boolean cleanupApplied,
    boolean attackKeyPressed,
    boolean useKeyPressed
) {
    enum Disposition {
        APPLIED,
        DEFERRED,
        SUPPRESSED
    }

    InteractionAppliedReceipt {
        if (requestId == null || requestId.isBlank()) {
            throw new IllegalArgumentException("requestId must not be blank");
        }
        if (action == null) {
            throw new IllegalArgumentException("action must not be null");
        }
        if (disposition == null) {
            throw new IllegalArgumentException("disposition must not be null");
        }
        if (reason == null || reason.isBlank()) {
            reason = applied ? "applied" : "not_applied";
        }
        if (mode == null) {
            mode = FabricMotionMode.LEGACY;
        }
        if (applied != (disposition == Disposition.APPLIED)) {
            throw new IllegalArgumentException("applied must match APPLIED disposition");
        }
    }

    boolean retryable() {
        return disposition == Disposition.DEFERRED;
    }

    boolean duplicateSuppressed() {
        return appliedOutput != null
            && (appliedOutput.duplicatePulseSuppressed()
                || appliedOutput.duplicateBreakUpdateSuppressed());
    }
}
