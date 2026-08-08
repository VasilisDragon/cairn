package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FabricInteractionControllerTest {
    @Test
    void smoothMiningGestureContinuesAcrossPreAimAndTargetSwap() {
        FabricInteractionController.State state = FabricInteractionController.initialState();
        FabricInteractionController.Transition first = prepare(
            state,
            block("break:1", "stage:1", "block:1", "north"),
            1_000L,
            20L,
            FabricInteractionController.Behavior.SMOOTH
        );
        state = FabricInteractionController.acknowledge(first, true, 1_000L);

        FabricInteractionController.Transition hold = prepare(
            state,
            hold("hold:2", "confirm:1", "block:2", "up"),
            1_050L,
            21L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(FabricInteractionController.Dispatch.NONE, hold.output().dispatch());
        assertTrue(hold.output().logicalGestureContinued());
        assertTrue(hold.output().targetChanged());
        assertFalse(hold.output().cancelBreakBeforeDispatch());
        assertEquals(50L, hold.output().gestureElapsedMs());
        state = FabricInteractionController.acknowledge(hold, false, 1_050L);

        FabricInteractionController.Transition second = prepare(
            state,
            block("break:2", "stage:2", "block:2", "up"),
            1_100L,
            22L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(
            FabricInteractionController.Dispatch.BREAK_PROGRESS,
            second.output().dispatch()
        );
        assertTrue(second.output().logicalGestureContinued());
        assertFalse(second.output().targetChanged());
        assertEquals(100L, second.output().gestureElapsedMs());
        assertEquals(50L, second.output().appliedGapMs());
    }

    @Test
    void legacyKeepsPhysicalDispatchButDoesNotClaimSmoothTargetContinuity() {
        FabricInteractionController.Transition first = prepare(
            FabricInteractionController.initialState(),
            block("break:1", "stage:1", "block:1", "north"),
            1_000L,
            20L,
            FabricInteractionController.Behavior.LEGACY
        );
        FabricInteractionController.State state =
            FabricInteractionController.acknowledge(first, true, 1_000L);
        FabricInteractionController.Transition second = prepare(
            state,
            block("break:2", "stage:2", "block:2", "up"),
            1_050L,
            21L,
            FabricInteractionController.Behavior.LEGACY
        );

        assertEquals(
            FabricInteractionController.Dispatch.BREAK_PROGRESS,
            second.output().dispatch()
        );
        assertFalse(second.output().logicalGestureContinued());
        assertTrue(second.output().targetChanged());
    }

    @Test
    void attackPulseIsConsumedOnlyAfterAppliedAcknowledgement() {
        InteractionDemand attack = attack("attack:zombie:1");
        FabricInteractionController.Transition deferred = prepare(
            FabricInteractionController.initialState(),
            attack,
            1_000L,
            20L,
            FabricInteractionController.Behavior.SMOOTH
        );
        FabricInteractionController.State state =
            FabricInteractionController.acknowledge(deferred, false, 1_000L);

        FabricInteractionController.Transition retry = prepare(
            state,
            attack,
            1_050L,
            21L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(FabricInteractionController.Dispatch.ATTACK_ENTITY, retry.output().dispatch());
        assertFalse(retry.output().duplicatePulseSuppressed());
        state = FabricInteractionController.acknowledge(retry, true, 1_050L);

        FabricInteractionController.Transition duplicate = prepare(
            state,
            attack,
            1_100L,
            22L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(FabricInteractionController.Dispatch.NONE, duplicate.output().dispatch());
        assertTrue(duplicate.output().duplicatePulseSuppressed());
    }

    @Test
    void blockProgressCanApplyAtMostOncePerPhysicalTick() {
        InteractionDemand demand = block("break:1", "stage:1", "block:1", "north");
        FabricInteractionController.Transition first = prepare(
            FabricInteractionController.initialState(),
            demand,
            1_000L,
            20L,
            FabricInteractionController.Behavior.SMOOTH
        );
        FabricInteractionController.State state =
            FabricInteractionController.acknowledge(first, true, 1_000L);

        FabricInteractionController.Transition sameTick = prepare(
            state,
            demand,
            1_001L,
            20L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(FabricInteractionController.Dispatch.NONE, sameTick.output().dispatch());
        assertTrue(sameTick.output().duplicateBreakUpdateSuppressed());
        state = FabricInteractionController.acknowledge(sameTick, false, 1_001L);

        FabricInteractionController.Transition nextTick = prepare(
            state,
            demand,
            1_050L,
            21L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(
            FabricInteractionController.Dispatch.BREAK_PROGRESS,
            nextTick.output().dispatch()
        );
        assertFalse(nextTick.output().duplicateBreakUpdateSuppressed());
    }

    @Test
    void losingBreakOwnershipRequestsOneCancellationAndNeverAttackKeyHold() {
        FabricInteractionController.Transition first = prepare(
            FabricInteractionController.initialState(),
            block("break:1", "stage:1", "block:1", "north"),
            1_000L,
            20L,
            FabricInteractionController.Behavior.SMOOTH
        );
        FabricInteractionController.State state =
            FabricInteractionController.acknowledge(first, true, 1_000L);
        FabricInteractionController.Transition idle = prepare(
            state,
            InteractionDemand.idle(
                LookDemand.Owner.NORMAL,
                "mission:stone",
                "complete",
                "complete"
            ),
            1_050L,
            21L,
            FabricInteractionController.Behavior.SMOOTH
        );

        assertEquals(FabricInteractionController.Dispatch.NONE, idle.output().dispatch());
        assertTrue(idle.output().cancelBreakBeforeDispatch());
        assertFalse(idle.output().attackKeyPressed());
    }

    @Test
    void holdItemOwnsUseUntilImmediateRelease() {
        InteractionDemand hold = InteractionDemand.holdItem(
            "eat:1",
            LookDemand.Owner.SURVIVAL,
            "survival:eat",
            "eating",
            "eat:episode:1",
            "minecraft:bread",
            "low_food"
        );
        FabricInteractionController.Transition active = prepare(
            FabricInteractionController.initialState(),
            hold,
            1_000L,
            20L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(FabricInteractionController.Dispatch.HOLD_ITEM, active.output().dispatch());
        assertTrue(active.output().useKeyPressed());
        FabricInteractionController.State state =
            FabricInteractionController.acknowledge(active, true, 1_000L);

        FabricInteractionController.Transition release = prepare(
            state,
            InteractionDemand.release(
                "release:combat",
                LookDemand.Owner.COMBAT,
                "combat:flee",
                "preempt",
                "combat_preemption"
            ),
            1_001L,
            21L,
            FabricInteractionController.Behavior.SMOOTH
        );
        assertEquals(FabricInteractionController.Dispatch.RELEASE_KEYS, release.output().dispatch());
        assertFalse(release.output().useKeyPressed());
        assertTrue(release.output().commandChanged());
    }

    @Test
    void shadowSelectsLegacyAndSmoothSelectsContinuousOutput() {
        FabricInteractionController.Output legacy = output(false);
        FabricInteractionController.Output smooth = output(true);

        assertEquals(
            legacy,
            FabricInteractionController.selectApplied(FabricMotionMode.LEGACY, legacy, smooth)
        );
        assertEquals(
            legacy,
            FabricInteractionController.selectApplied(FabricMotionMode.SHADOW, legacy, smooth)
        );
        assertEquals(
            smooth,
            FabricInteractionController.selectApplied(FabricMotionMode.SMOOTH, legacy, smooth)
        );
    }

    @Test
    void regressedClockResetsElapsedStateWithoutConsumingRequest() {
        FabricInteractionController.Transition first = prepare(
            FabricInteractionController.initialState(),
            block("break:1", "stage:1", "block:1", "north"),
            1_000L,
            20L,
            FabricInteractionController.Behavior.SMOOTH
        );
        FabricInteractionController.State state =
            FabricInteractionController.acknowledge(first, true, 1_000L);
        FabricInteractionController.Transition reset = prepare(
            state,
            block("break:2", "stage:2", "block:2", "up"),
            900L,
            18L,
            FabricInteractionController.Behavior.SMOOTH
        );

        assertFalse(reset.output().logicalGestureContinued());
        assertEquals(0L, reset.output().gestureElapsedMs());
        assertEquals(FabricInteractionController.Dispatch.BREAK_PROGRESS, reset.output().dispatch());
    }

    private static FabricInteractionController.Transition prepare(
        FabricInteractionController.State state,
        InteractionDemand demand,
        long nowMs,
        long tick,
        FabricInteractionController.Behavior behavior
    ) {
        return FabricInteractionController.prepare(
            state,
            demand,
            new FabricInteractionController.Observation(nowMs, tick),
            behavior
        );
    }

    private static InteractionDemand block(
        String request,
        String stage,
        String target,
        String face
    ) {
        return InteractionDemand.breakBlock(
            request,
            LookDemand.Owner.NORMAL,
            "mission:stone",
            stage,
            "stone-sequence:1",
            target,
            "minecraft:stone_pickaxe",
            face,
            "break"
        );
    }

    private static InteractionDemand hold(
        String request,
        String stage,
        String target,
        String face
    ) {
        return InteractionDemand.blockBreakHold(
            request,
            LookDemand.Owner.NORMAL,
            "mission:stone",
            stage,
            "stone-sequence:1",
            target,
            "minecraft:stone_pickaxe",
            face,
            "preaim"
        );
    }

    private static InteractionDemand attack(String request) {
        return InteractionDemand.attackEntity(
            request,
            LookDemand.Owner.COMBAT,
            "combat:engage",
            "attack_ready",
            "hostile:zombie",
            "aligned"
        );
    }

    private static FabricInteractionController.Output output(boolean continued) {
        return new FabricInteractionController.Output(
            "request",
            FabricInteractionController.Dispatch.BREAK_PROGRESS,
            false,
            false,
            false,
            false,
            false,
            continued,
            false,
            false,
            false,
            0L,
            0L,
            0L,
            1L
        );
    }
}
