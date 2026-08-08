package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class InteractionControlDecisionCompatibilityTest {
    @Test
    void legacyConstructorsDefaultInteractionFieldsToNull() {
        ControlDecision decision = new ControlDecision(null, InputState.stop());

        assertNull(decision.interactionDemand());
        assertNull(decision.interactionPayload());
    }

    @Test
    void canonicalCarrierPreservesDemandAndPayload() {
        InteractionDemand demand = InteractionDemand.release(
            "release:1",
            LookDemand.Owner.NORMAL,
            "command",
            "cleanup",
            "done"
        );
        FabricInteractionAuthority.Payload payload = FabricInteractionAuthority.Payload.none();
        ControlDecision decision = new ControlDecision(
            null,
            InputState.stop(),
            null,
            null,
            null,
            demand,
            payload
        );

        assertEquals(demand, decision.interactionDemand());
        assertEquals(payload, decision.interactionPayload());
    }
}
