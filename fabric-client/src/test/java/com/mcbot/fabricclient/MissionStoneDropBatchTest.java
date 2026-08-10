package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class MissionStoneDropBatchTest {
    @Test
    void verifiedProductionSuppressesOvershootBeforeEntityAttribution() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(5), 3);

        MissionStoneDropBatch.Decision decision = MissionStoneDropBatch.decide(5, 8, state);

        assertEquals(
            MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
            decision.action()
        );
        assertEquals(3, decision.pendingUnits());
        assertEquals(0, decision.state().attributedUnits());
        assertEquals("verified_production_covers_deficit", decision.reason());
    }

    @Test
    void inventoryAloneCompletesTheRequirement() {
        MissionStoneDropBatch.State pendingEight = produced(MissionStoneDropBatch.State.begin(0), 8);

        MissionStoneDropBatch.Decision unsatisfied = MissionStoneDropBatch.decide(0, 8, pendingEight);
        assertEquals(
            MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
            unsatisfied.action()
        );

        MissionStoneDropBatch.Decision satisfied = MissionStoneDropBatch.decide(8, 8, pendingEight);
        assertEquals(MissionStoneDropBatch.Action.COMPLETE, satisfied.action());
        assertEquals(0, satisfied.state().pendingUnits());
        assertEquals("inventory_requirement_satisfied", satisfied.reason());
    }

    @Test
    void mergedEntityStackDeltaAttributesUnitsRatherThanOneIdentity() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 3);
        MissionStoneDropBatch.Update merged = MissionStoneDropBatch.observeEntityStackDelta(
            state, "merged-uuid", 3, true, false);

        assertTrue(merged.accepted());
        assertEquals(3, merged.unitsChanged());
        assertEquals(3, merged.state().attributedUnits());
        MissionStoneDropBatch.Decision decision = MissionStoneDropBatch.decide(0, 3, merged.state());
        assertEquals(MissionStoneDropBatch.Action.RECOVER_SETTLED_DROP, decision.action());
        assertEquals("merged-uuid", decision.recoveryEntityId());
        assertEquals(3, decision.recoveryUnits());
    }

    @Test
    void entitySpawnedDuringAirConfirmationIsAttributedWhenVerifiedProductionArrives() {
        MissionStoneDropBatch.State beforeAirConfirmation = MissionStoneDropBatch.State.begin(0);

        MissionStoneDropBatch.Update prematureObservation =
            MissionStoneDropBatch.observeEntityStackDelta(
                beforeAirConfirmation, "spawned-during-confirmation", 1, false, true);
        assertFalse(prematureObservation.accepted(), "visibility alone cannot invent production");
        assertEquals("no_unattributed_production", prematureObservation.reason());

        MissionStoneDropBatch.State airConfirmed = MissionStoneDropBatch.recordProduced(
            prematureObservation.state(), "verified-stone-to-air").state();
        MissionStoneDropBatch.Update replayedObservation =
            MissionStoneDropBatch.observeEntityStackDelta(
                airConfirmed, "spawned-during-confirmation", 1, false, true);

        assertTrue(replayedObservation.accepted());
        assertEquals(1, replayedObservation.unitsChanged());
        assertEquals(1, replayedObservation.state().attributedUnits());
        assertEquals(
            MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
            MissionStoneDropBatch.decide(0, 1, replayedObservation.state()).action(),
            "an airborne drop in the future route envelope waits for authoritative pickup"
        );
    }

    @Test
    void preExistingEntityStackGrowthAttributesOnlyTheMergedDelta() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 2);

        MissionStoneDropBatch.Update firstGrowth = MissionStoneDropBatch.observeEntityStackDelta(
            state, "pre-existing-stack", 1, true, false);
        MissionStoneDropBatch.Update secondGrowth = MissionStoneDropBatch.observeEntityStackDelta(
            firstGrowth.state(), "pre-existing-stack", 1, true, false);

        assertEquals(1, firstGrowth.unitsChanged());
        assertEquals(1, secondGrowth.unitsChanged());
        assertEquals(2, secondGrowth.state().attributedUnits());
        assertEquals(
            MissionStoneDropBatch.Action.RECOVER_SETTLED_DROP,
            MissionStoneDropBatch.decide(0, 2, secondGrowth.state()).action()
        );
        assertEquals(
            2,
            MissionStoneDropBatch.decide(0, 2, secondGrowth.state()).recoveryUnits(),
            "two merge deltas sharing one UUID still represent two verified productions"
        );
    }

    @Test
    void inventoryGainPrunesOldestPendingUnitsAndOpensASecondBatch() {
        MissionStoneDropBatch.State firstBatch = produced(MissionStoneDropBatch.State.begin(3), 8);
        MissionStoneDropBatch.Update reconciled = MissionStoneDropBatch.reconcileInventory(firstBatch, 11);

        assertEquals(8, reconciled.unitsChanged());
        assertEquals(0, reconciled.state().pendingUnits());

        MissionStoneDropBatch.State secondBatch = produced(reconciled.state(), 3, 8);
        MissionStoneDropBatch.Decision pending = MissionStoneDropBatch.decide(11, 14, secondBatch);
        assertEquals(
            MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
            pending.action()
        );
        assertEquals(3, pending.pendingUnits());

        MissionStoneDropBatch.Decision complete = MissionStoneDropBatch.decide(14, 14, secondBatch);
        assertEquals(MissionStoneDropBatch.Action.COMPLETE, complete.action());
        assertEquals(0, complete.state().pendingUnits());
    }

    @Test
    void partialInventoryReconciliationRecyclesOnlyFreedOutstandingCapacity() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(3), 8);
        MissionStoneDropBatch.Update fourCollected = MissionStoneDropBatch.reconcileInventory(state, 7);

        assertEquals(4, fourCollected.unitsChanged());
        assertEquals(4, fourCollected.state().pendingUnits());

        MissionStoneDropBatch.State refilled = produced(fourCollected.state(), 4, 8);
        assertEquals(8, refilled.pendingUnits());
        assertFalse(MissionStoneDropBatch.recordProduced(refilled, "production-12").accepted());

        MissionStoneDropBatch.Update restCollected = MissionStoneDropBatch.reconcileInventory(refilled, 15);
        assertEquals(8, restCollected.unitsChanged());
        assertEquals(0, restCollected.state().pendingUnits());
        assertTrue(MissionStoneDropBatch.recordProduced(restCollected.state(), "production-12").accepted());
    }

    @Test
    void verifiedCraftConsumptionCanRebaseForTheNextExactRequirement() {
        MissionStoneDropBatch.State first = produced(MissionStoneDropBatch.State.begin(0), 8);
        MissionStoneDropBatch.State collected = MissionStoneDropBatch.decide(8, 8, first).state();
        assertEquals(0, collected.pendingUnits());

        MissionStoneDropBatch.Update rebased = MissionStoneDropBatch.rebaseAfterVerifiedConsumption(collected, 0);
        assertTrue(rebased.accepted());
        assertEquals(0, rebased.state().lastAuthoritativeInventory());

        MissionStoneDropBatch.State furnaceAndReserve = produced(rebased.state(), 8, 0);
        assertEquals(8, furnaceAndReserve.pendingUnits(), "only eight units may be outstanding at once");
        furnaceAndReserve = MissionStoneDropBatch.reconcileInventory(furnaceAndReserve, 8).state();
        furnaceAndReserve = produced(furnaceAndReserve, 3, 8);
        assertEquals(
            MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
            MissionStoneDropBatch.decide(8, 11, furnaceAndReserve).action()
        );
        assertEquals(
            MissionStoneDropBatch.Action.COMPLETE,
            MissionStoneDropBatch.decide(11, 11, furnaceAndReserve).action()
        );
    }

    @Test
    void rebaseCannotDiscardOutstandingVerifiedProduction() {
        MissionStoneDropBatch.State pending = produced(MissionStoneDropBatch.State.begin(8), 1);

        MissionStoneDropBatch.Update rejected = MissionStoneDropBatch.rebaseAfterVerifiedConsumption(pending, 0);

        assertFalse(rejected.accepted());
        assertEquals("pending_production_prevents_rebase", rejected.reason());
        assertEquals(pending, rejected.state());
    }

    @Test
    void splitEntityStackDeltasPreserveEveryProducedUnit() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 5);
        state = MissionStoneDropBatch.observeEntityStackDelta(state, "first", 2, true, false).state();
        state = MissionStoneDropBatch.observeEntityStackDelta(state, "second", 3, true, false).state();

        MissionStoneDropBatch.Decision first = MissionStoneDropBatch.decide(0, 5, state);
        assertEquals("first", first.recoveryEntityId());
        assertEquals(2, first.recoveryUnits());

        MissionStoneDropBatch.State afterFirst = MissionStoneDropBatch.reconcileInventory(state, 2).state();
        MissionStoneDropBatch.Decision second = MissionStoneDropBatch.decide(2, 5, afterFirst);
        assertEquals("second", second.recoveryEntityId());
        assertEquals(3, second.recoveryUnits());
    }

    @Test
    void outOfOrderAutoPickupRetainsTheOlderLiveOffRouteEntity() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 2);
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "older-off-route", 1, true, false).state();
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "later-auto-picked", 1, true, true).state();

        MissionStoneDropBatch.Update picked = MissionStoneDropBatch.reconcileInventory(
            state, 1, java.util.Set.of("older-off-route"));

        assertEquals(1, picked.unitsChanged());
        assertEquals(1, picked.state().pendingUnits());
        assertEquals("older-off-route", picked.state().pending().getFirst().entityId());
        MissionStoneDropBatch.Decision recovery = MissionStoneDropBatch.decide(1, 2, picked.state());
        assertEquals(MissionStoneDropBatch.Action.RECOVER_SETTLED_DROP, recovery.action());
        assertEquals("older-off-route", recovery.recoveryEntityId());
    }

    @Test
    void liveIdentityTruthWinsWhenBothDropsWereInsideThePickupEnvelope() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 2);
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "older-still-live", 1, true, true).state();
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "later-picked", 1, true, true).state();

        MissionStoneDropBatch.Update picked = MissionStoneDropBatch.reconcileInventory(
            state, 1, java.util.Set.of("older-still-live"));

        assertEquals(1, picked.state().pendingUnits());
        assertEquals("older-still-live", picked.state().pending().getFirst().entityId());
    }

    @Test
    void missingMergedIdentityConsumesOnlyItsAuthoritativeInventoryGain() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 4);
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "picked-merged-stack", 3, true, false).state();
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "still-live", 1, true, false).state();

        MissionStoneDropBatch.Update picked = MissionStoneDropBatch.reconcileInventory(
            state, 3, java.util.Set.of("still-live"));

        assertEquals(3, picked.unitsChanged());
        assertEquals(1, picked.state().pendingUnits());
        assertEquals("still-live", picked.state().pending().getFirst().entityId());
    }

    @Test
    void gainBeyondMissingIdentitiesFallsBackWithoutDiscardingAccounting() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 3);
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "missing", 1, true, false).state();
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "live", 2, true, false).state();

        MissionStoneDropBatch.Update picked = MissionStoneDropBatch.reconcileInventory(
            state, 2, java.util.Set.of("live"));

        assertEquals(2, picked.unitsChanged());
        assertEquals(1, picked.state().pendingUnits());
        assertEquals("live", picked.state().pending().getFirst().entityId());
    }

    @Test
    void exactEightPendingCapRejectsTheNinthWithoutMutation() {
        MissionStoneDropBatch.State full = produced(MissionStoneDropBatch.State.begin(0), 8);
        MissionStoneDropBatch.Update ninth = MissionStoneDropBatch.recordProduced(full, "production-8");

        assertFalse(ninth.accepted());
        assertEquals("batch_full", ninth.reason());
        assertEquals(full, ninth.state());
        assertEquals(8, ninth.state().pendingUnits());
        assertEquals(
            MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
            MissionStoneDropBatch.decide(0, 20, ninth.state()).action(),
            "the full outstanding batch must stop mining even when the absolute deficit is larger"
        );
    }

    @Test
    void duplicateProductionCannotConsumeCapacity() {
        MissionStoneDropBatch.State state = MissionStoneDropBatch.recordProduced(
            MissionStoneDropBatch.State.begin(0), "owned-block").state();
        MissionStoneDropBatch.Update duplicate = MissionStoneDropBatch.recordProduced(state, "owned-block");

        assertFalse(duplicate.accepted());
        assertEquals("duplicate_production", duplicate.reason());
        assertEquals(1, duplicate.state().pendingUnits());
    }

    @Test
    void entityStateUpdateDoesNotInventAStackDelta() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 2);
        state = MissionStoneDropBatch.observeEntityStackDelta(state, "entity", 2, false, true).state();
        MissionStoneDropBatch.Update settled = MissionStoneDropBatch.observeEntityState(
            state, "entity", true, false);

        assertTrue(settled.accepted());
        assertEquals(0, settled.unitsChanged());
        assertEquals(2, settled.state().pendingUnits());
        assertEquals(2, settled.state().attributedUnits());
        assertEquals(
            MissionStoneDropBatch.Action.RECOVER_SETTLED_DROP,
            MissionStoneDropBatch.decide(0, 2, settled.state()).action()
        );
    }

    @Test
    void settledDropInsideTheRouteWaitsUntilItActuallyLeavesThePickupEnvelope() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 1);
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "near-route", 1, true, true).state();

        assertEquals(
            MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
            MissionStoneDropBatch.decide(0, 1, state).action()
        );

        state = MissionStoneDropBatch.observeEntityState(
            state, "near-route", true, false).state();
        MissionStoneDropBatch.Decision recovery = MissionStoneDropBatch.decide(0, 1, state);
        assertEquals(MissionStoneDropBatch.Action.RECOVER_SETTLED_DROP, recovery.action());
        assertEquals("near-route", recovery.recoveryEntityId());
    }

    @Test
    void disappearedMergedEntityPrunesEveryAssociatedUnit() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(0), 3);
        state = MissionStoneDropBatch.observeEntityStackDelta(
            state, "gone", 3, true, false).state();

        MissionStoneDropBatch.Update pruned = MissionStoneDropBatch.pruneDisappearedEntity(state, "gone");

        assertTrue(pruned.accepted());
        assertEquals(3, pruned.unitsChanged());
        assertEquals(0, pruned.state().pendingUnits());
        assertEquals(
            MissionStoneDropBatch.Action.CONTINUE_MINING,
            MissionStoneDropBatch.decide(0, 3, pruned.state()).action()
        );
    }

    @Test
    void inventoryDecreaseCannotFabricateAGainWhenCursorContentsReturn() {
        MissionStoneDropBatch.State state = produced(MissionStoneDropBatch.State.begin(5), 2);
        state = MissionStoneDropBatch.reconcileInventory(state, 3).state();

        assertEquals(5, state.lastAuthoritativeInventory());
        MissionStoneDropBatch.Update restored = MissionStoneDropBatch.reconcileInventory(state, 5);
        assertEquals(0, restored.unitsChanged());
        assertEquals(2, restored.state().pendingUnits());
    }

    private MissionStoneDropBatch.State produced(MissionStoneDropBatch.State start, int count) {
        return produced(start, count, 0);
    }

    private MissionStoneDropBatch.State produced(
        MissionStoneDropBatch.State start,
        int count,
        int identityOffset
    ) {
        MissionStoneDropBatch.State state = start;
        for (int index = 0; index < count; index++) {
            MissionStoneDropBatch.Update update = MissionStoneDropBatch.recordProduced(
                state, "production-" + (identityOffset + index));
            assertTrue(update.accepted());
            state = update.state();
        }
        return state;
    }
}
