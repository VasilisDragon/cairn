package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FieldKitRecoveryPlannerTest {
    @Test
    void activationLatchesRecoveryAndClearsMiningTargets() {
        FieldKitRecoveryPlanner.State state = FieldKitRecoveryPlanner.State.inactive();

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.activate(state);

        assertEquals(FieldKitRecoveryPlanner.Action.CONTINUE, decision.action());
        assertTrue(decision.state().active());
        assertTrue(decision.clearMiningTargets());
    }

    @Test
    void recoveryLimitFailsBeforeMoreWorkStarts() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, false, false, 2);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.tick(state, 2);

        assertEquals(FieldKitRecoveryPlanner.Action.RECOVERY_LIMIT_REACHED, decision.action());
    }

    @Test
    void retrievePendingOutranksHotbarAndCraftWork() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, true, true, true, true, 1);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.tick(state, 2);

        assertEquals(FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE, decision.action());
        assertTrue(decision.state().retrieveTablePending());
    }

    @Test
    void recoveryTableIsProtectedFromMiningTargetsUntilRetrieved() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, true, true, true, true, 1);

        FieldKitRecoveryPlanner.Decision protectedTarget = FieldKitRecoveryPlanner.protectMiningTarget(state, true);
        FieldKitRecoveryPlanner.Decision unrelatedTarget = FieldKitRecoveryPlanner.protectMiningTarget(state, false);

        assertEquals(FieldKitRecoveryPlanner.Action.PROTECT_RECOVERY_TABLE, protectedTarget.action());
        assertTrue(protectedTarget.clearMiningTargets());
        assertEquals(FieldKitRecoveryPlanner.Action.CONTINUE, unrelatedTarget.action());
        assertFalse(unrelatedTarget.clearMiningTargets());
    }

    @Test
    void retrieveCompleteReleasesLatchAndRecoveryTableState() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, true, true, true, true, 1);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterRetrieve(state, "retrieve_table_complete:verified");

        assertEquals(FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE_COMPLETE, decision.action());
        assertFalse(decision.state().active());
        assertFalse(decision.state().retrieveTablePending());
        assertFalse(decision.state().tablePlacedByRecovery());
        assertFalse(decision.state().alcoveKnown());
        assertFalse(decision.state().proactiveLogged());
        assertEquals(1, decision.state().attempts());
    }

    @Test
    void hotbarMoveSuccessReleasesLatchWithoutWaitingForCraft() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, false, true, 0);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterHotbarMove(state, false, 4);

        assertEquals(FieldKitRecoveryPlanner.Action.HOTBAR_PICKAXE_MOVED, decision.action());
        assertFalse(decision.state().active());
        assertFalse(decision.state().proactiveLogged());
    }

    @Test
    void matchingActivePickaxeCraftOutranksNewHotbarObservation() {
        assertTrue(FieldKitRecoveryPlanner.shouldContinueActivePickaxeCraft(
            "mission-1:neariron:fieldkit:craft_stone_pickaxe:0",
            "mission-1:neariron:fieldkit:craft_stone_pickaxe:0"
        ));
        assertFalse(FieldKitRecoveryPlanner.shouldContinueActivePickaxeCraft(
            "mission-1:neariron:fieldkit:craft_stone_pickaxe:0",
            "mission-2:neariron:fieldkit:craft_stone_pickaxe:0"
        ));
        assertFalse(FieldKitRecoveryPlanner.shouldContinueActivePickaxeCraft(
            "mission-1:neariron:fieldkit:craft_stone_pickaxe:0",
            null
        ));
    }

    @Test
    void craftingScreenOpenDoesNotFightHotbarMoveOrRejectTransientInputCounts() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, true, true, true, 0);

        FieldKitRecoveryPlanner.Decision hotbarDecision = FieldKitRecoveryPlanner.afterHotbarMove(state, true, -1);
        FieldKitRecoveryPlanner.Decision inventoryDecision = FieldKitRecoveryPlanner.afterInventory(
            hotbarDecision.state(),
            new FieldKitRecoveryPlanner.InventoryObservation(true, 0, 0, 0, false, false)
        );

        assertEquals(FieldKitRecoveryPlanner.Action.CONTINUE, hotbarDecision.action());
        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE, inventoryDecision.action());
        assertTrue(inventoryDecision.state().active());
    }

    @Test
    void missingInputsFailOnlyWhenCraftingScreenIsNotOpen() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, false, false, 0);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(false, 2, 1, 1, false, false)
        );

        assertEquals(FieldKitRecoveryPlanner.Action.MISSING_PICKAXE_INPUTS, decision.action());
    }

    @Test
    void ironFieldKitCraftsSticksOnlyWhenSixPlanksRemainProtected() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(
            true, false, false, false, false, false, 0
        );

        FieldKitRecoveryPlanner.Decision eightPlanks = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(
                false, 3, 0, 1, true, false, 8, 6
            )
        );
        FieldKitRecoveryPlanner.Decision sevenPlanks = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(
                false, 3, 0, 1, true, false, 7, 6
            )
        );

        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_STICKS, eightPlanks.action());
        assertTrue(eightPlanks.state().sticksCraftPending());
        assertEquals(FieldKitRecoveryPlanner.Action.MISSING_PICKAXE_INPUTS, sevenPlanks.action());
        assertFalse(sevenPlanks.state().sticksCraftPending());
    }

    @Test
    void protectedRecoveryCannotAdvertiseATableCraftThatConsumesTheReserve() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(
            true, false, false, false, false, false, 0
        );

        FieldKitRecoveryPlanner.Decision ninePlanks = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(
                false, 3, 2, 0, false, false, 9, 6
            )
        );
        FieldKitRecoveryPlanner.Decision tenPlanks = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(
                false, 3, 2, 0, false, false, 10, 6
            )
        );

        assertEquals(FieldKitRecoveryPlanner.Action.MISSING_PICKAXE_INPUTS, ninePlanks.action());
        assertEquals(FieldKitRecoveryPlanner.Action.NO_CRAFTING_TABLE, tenPlanks.action());
    }

    @Test
    void inFlightStickCraftSurvivesCursorMovementAndUsesStablePhase() {
        FieldKitRecoveryPlanner.State pending = new FieldKitRecoveryPlanner.State(
            true, false, false, false, false, true, 0
        );

        FieldKitRecoveryPlanner.Decision transientInventory = FieldKitRecoveryPlanner.afterInventory(
            pending,
            new FieldKitRecoveryPlanner.InventoryObservation(
                false, 3, 0, 1, true, false, 6, 6
            )
        );
        FieldKitRecoveryPlanner.Decision stillRunning = FieldKitRecoveryPlanner.afterCraftSticks(
            transientInventory.state(), "craft_sticks_grid_prepared", 0
        );
        FieldKitRecoveryPlanner.Decision complete = FieldKitRecoveryPlanner.afterCraftSticks(
            stillRunning.state(), "", 4
        );

        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_STICKS, transientInventory.action());
        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_STICKS, stillRunning.action());
        assertTrue(stillRunning.state().sticksCraftPending());
        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_STICKS_COMPLETE, complete.action());
        assertFalse(complete.state().sticksCraftPending());
    }

    @Test
    void failedStickCraftClearsItsPhaseForBoundedFailure() {
        FieldKitRecoveryPlanner.State pending = new FieldKitRecoveryPlanner.State(
            true, false, false, false, false, true, 0
        );

        FieldKitRecoveryPlanner.Decision failed = FieldKitRecoveryPlanner.afterCraftSticks(
            pending, "craft_sticks_failed:missing_inputs", 0
        );

        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_STICKS_FAILED, failed.action());
        assertFalse(failed.state().sticksCraftPending());
    }

    @Test
    void noNearbyOrCarriedCraftingTableFailsBeforeCraft() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, false, false, 0);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(false, 3, 2, 0, false, false)
        );

        assertEquals(FieldKitRecoveryPlanner.Action.NO_CRAFTING_TABLE, decision.action());
    }

    @Test
    void carriedTableRequiresPlacementBeforeCraft() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, false, false, 0);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(false, 3, 2, 1, false, false)
        );

        assertEquals(FieldKitRecoveryPlanner.Action.PLACE_TABLE_REQUIRED, decision.action());
    }

    @Test
    void seeingRecoveryAlcoveTableMarksItForRetrieval() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, true, false, 0);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterInventory(
            state,
            new FieldKitRecoveryPlanner.InventoryObservation(false, 3, 2, 0, true, true)
        );

        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE, decision.action());
        assertTrue(decision.state().tablePlacedByRecovery());
    }

    @Test
    void successfulPlaceMarksTablePlacedByRecovery() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, true, false, 0);

        FieldKitRecoveryPlanner.Decision placing = FieldKitRecoveryPlanner.afterPlaceTable(
            state,
            "place_table_placing:interact_block:SUCCESS"
        );
        FieldKitRecoveryPlanner.Decision complete = FieldKitRecoveryPlanner.afterPlaceTable(
            state,
            "place_table_complete:verified"
        );

        assertEquals(FieldKitRecoveryPlanner.Action.PLACE_TABLE_MARKED, placing.action());
        assertTrue(placing.state().tablePlacedByRecovery());
        assertEquals(FieldKitRecoveryPlanner.Action.PLACE_TABLE_COMPLETE, complete.action());
        assertTrue(complete.state().tablePlacedByRecovery());
    }

    @Test
    void craftWithRecoveryTableKeepsLatchUntilTableRetrieved() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, true, true, true, 0);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterCraftPickaxe(
            state,
            "craft_stone_pickaxe_complete:verified"
        );

        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE_COMPLETE, decision.action());
        assertEquals(1, decision.state().attempts());
        assertTrue(decision.state().active());
        assertTrue(decision.state().retrieveTablePending());
        assertTrue(decision.state().tablePlacedByRecovery());
    }

    @Test
    void craftWithExistingTableReleasesLatchAfterCraft() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, false, false, false, true, 0);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterCraftPickaxe(
            state,
            "craft_stone_pickaxe_complete:verified"
        );

        assertEquals(FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE_COMPLETE, decision.action());
        assertEquals(1, decision.state().attempts());
        assertFalse(decision.state().active());
        assertFalse(decision.state().retrieveTablePending());
        assertFalse(decision.state().proactiveLogged());
    }

    @Test
    void retrieveFailureLeavesRecoveryLatchedAtExplicitBoundary() {
        FieldKitRecoveryPlanner.State state = new FieldKitRecoveryPlanner.State(true, true, true, true, true, 1);

        FieldKitRecoveryPlanner.Decision decision = FieldKitRecoveryPlanner.afterRetrieve(
            state,
            "retrieve_table_failed:not_visible"
        );

        assertEquals(FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE_FAILED, decision.action());
        assertTrue(decision.state().active());
        assertTrue(decision.state().retrieveTablePending());
        assertTrue(decision.state().tablePlacedByRecovery());
    }

    @Test
    void multiCycleRecoveryPreservesAttemptsAcrossRetrieveAndSecondCraft() {
        FieldKitRecoveryPlanner.State first = new FieldKitRecoveryPlanner.State(true, false, true, true, true, 0);
        FieldKitRecoveryPlanner.Decision firstCraft = FieldKitRecoveryPlanner.afterCraftPickaxe(
            first,
            "craft_stone_pickaxe_complete:verified"
        );
        FieldKitRecoveryPlanner.Decision firstRetrieve = FieldKitRecoveryPlanner.afterRetrieve(
            firstCraft.state(),
            "retrieve_table_complete:verified"
        );
        FieldKitRecoveryPlanner.Decision secondActivation = FieldKitRecoveryPlanner.activate(firstRetrieve.state());
        FieldKitRecoveryPlanner.Decision secondCraft = FieldKitRecoveryPlanner.afterCraftPickaxe(
            secondActivation.state(),
            "craft_stone_pickaxe_complete:verified"
        );

        assertEquals(1, firstRetrieve.state().attempts());
        assertFalse(firstRetrieve.state().active());
        assertEquals(2, secondCraft.state().attempts());
        assertFalse(secondCraft.state().active());
        assertFalse(secondCraft.state().retrieveTablePending());
    }
}
