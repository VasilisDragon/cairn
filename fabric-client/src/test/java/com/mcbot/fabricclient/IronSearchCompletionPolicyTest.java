package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class IronSearchCompletionPolicyTest {
    @Test
    void onlyIncompleteSearchShapedGainsBecomePartialProgress() {
        assertEquals(
            IronSearchCompletionPolicy.Action.PARTIAL_PROGRESS,
            IronSearchCompletionPolicy.decide(true, 2, 3, false)
        );
        assertEquals(
            IronSearchCompletionPolicy.Action.FAIL,
            IronSearchCompletionPolicy.decide(true, 0, 3, false)
        );
        assertEquals(
            IronSearchCompletionPolicy.Action.FAIL,
            IronSearchCompletionPolicy.decide(true, 3, 3, false)
        );
    }

    @Test
    void toolPlacementCollectionHazardAndFluidFailuresCannotMasqueradeAsPartial() {
        assertEquals(
            IronSearchCompletionPolicy.Action.FAIL,
            IronSearchCompletionPolicy.decide(false, 2, 3, false)
        );
    }

    @Test
    void cumulativeBudgetExhaustionWinsOverIncidentalGain() {
        assertEquals(
            IronSearchCompletionPolicy.Action.EXHAUST_EPOCH,
            IronSearchCompletionPolicy.decide(true, 2, 3, true)
        );
    }
}
