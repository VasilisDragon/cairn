package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class InteractionAppliedReceiptTest {
    @Test
    void deferredReceiptRemainsRetryableAndCannotStartVerification() {
        InteractionAppliedReceipt receipt = new InteractionAppliedReceipt(
            "place:1",
            InteractionDemand.Action.USE_BLOCK,
            InteractionAppliedReceipt.Disposition.DEFERRED,
            false,
            null,
            1_000L,
            "missing_block_use_payload",
            FabricMotionMode.SMOOTH,
            null,
            null,
            false,
            false,
            false
        );

        assertFalse(receipt.applied());
        assertTrue(receipt.retryable());
    }

    @Test
    void appliedAndDispositionMustAgree() {
        assertThrows(IllegalArgumentException.class, () -> new InteractionAppliedReceipt(
            "place:1",
            InteractionDemand.Action.USE_BLOCK,
            InteractionAppliedReceipt.Disposition.DEFERRED,
            true,
            null,
            1_000L,
            "bad",
            FabricMotionMode.SMOOTH,
            null,
            null,
            false,
            false,
            false
        ));
    }
}
