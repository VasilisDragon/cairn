package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class MissionStoneFrontierCompletionStateTest {
    @Test
    void exactTargetOffFrontierStaysPendingUntilVerifiedArrival() {
        MissionStoneFrontierCompletionState state =
            new MissionStoneFrontierCompletionState();
        Object world = new Object();

        MissionStoneFrontierCompletionState.Evaluation belowTarget = state.observe(
            world, "stone-1", false, true, false);
        assertEquals(
            MissionStoneFrontierCompletionState.Decision.CONTINUE,
            belowTarget.decision()
        );

        MissionStoneFrontierCompletionState.Evaluation exactTarget = state.observe(
            world, "stone-1", true, true, false);
        assertEquals(
            MissionStoneFrontierCompletionState.Decision.RETURN_TO_FRONTIER,
            exactTarget.decision()
        );
        assertTrue(exactTarget.newlyLatched());
        assertTrue(state.pendingFor(world, "stone-1"));

        MissionStoneFrontierCompletionState.Evaluation physicalArrival = state.observe(
            world, "stone-1", true, true, true);
        assertEquals(
            MissionStoneFrontierCompletionState.Decision.RETURN_TO_FRONTIER,
            physicalArrival.decision(),
            "physical position must not publish completion before traversal verification"
        );
        assertFalse(state.releaseAtVerifiedFrontier(world, "stone-1", false));
        assertTrue(state.pendingFor(world, "stone-1"));

        assertTrue(state.releaseAtVerifiedFrontier(world, "stone-1", true));
        assertFalse(state.pendingFor(world, "stone-1"));
    }

    @Test
    void commandWorldAndExplicitLifecycleChangesClearPendingState() {
        MissionStoneFrontierCompletionState state =
            new MissionStoneFrontierCompletionState();
        Object firstWorld = new Object();
        Object secondWorld = new Object();

        state.observe(firstWorld, "stone-1", true, true, false);
        assertTrue(state.pendingFor(firstWorld, "stone-1"));

        state.observe(firstWorld, "stone-2", false, true, false);
        assertFalse(state.pendingFor(firstWorld, "stone-1"));
        assertFalse(state.pendingFor(firstWorld, "stone-2"));

        state.observe(firstWorld, "stone-2", true, true, false);
        assertTrue(state.pendingFor(firstWorld, "stone-2"));
        state.observe(secondWorld, "stone-2", false, true, false);
        assertFalse(state.pendingFor(firstWorld, "stone-2"));
        assertFalse(state.pendingFor(secondWorld, "stone-2"));

        state.observe(secondWorld, "stone-2", true, true, false);
        state.clear();
        assertFalse(state.pendingFor(secondWorld, "stone-2"));
    }
}
