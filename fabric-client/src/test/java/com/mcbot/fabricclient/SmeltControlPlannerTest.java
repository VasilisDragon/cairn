package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class SmeltControlPlannerTest {
    @Test
    void preflightPreservesExistingPriorityOrder() {
        SmeltControlPlanner.State state = new SmeltControlPlanner.State(SmeltControlPlanner.Stage.START);

        SmeltControlPlanner.Decision completed = SmeltControlPlanner.decidePreflight(state, true, true, false);
        assertEquals(SmeltControlPlanner.Action.COMPLETE_TYPED_DELTA, completed.action());
        assertEquals(SmeltControlPlanner.Stage.START, completed.state().stage());
        assertEquals("typed_delta_verified", completed.reason());

        SmeltControlPlanner.Decision timedOut = SmeltControlPlanner.decidePreflight(state, false, true, false);
        assertEquals(SmeltControlPlanner.Action.FAIL_TOTAL_TIMEOUT, timedOut.action());
        assertEquals("timeout", timedOut.reason());

        SmeltControlPlanner.Decision missingInteraction = SmeltControlPlanner.decidePreflight(state, false, false, false);
        assertEquals(SmeltControlPlanner.Action.FAIL_MISSING_INTERACTION_MANAGER, missingInteraction.action());
        assertEquals("missing_interaction_manager", missingInteraction.reason());
    }

    @Test
    void furnaceOpenStartRejectsUnsafeSlotsAndAdvancesWhenReusableFuelIsAllowed() {
        SmeltControlPlanner.State state = new SmeltControlPlanner.State(SmeltControlPlanner.Stage.START);

        assertEquals(
            SmeltControlPlanner.Action.FAIL_CURSOR_NOT_EMPTY,
            SmeltControlPlanner.decideFurnaceOpened(state, false, true, true, true, false, false, false).action()
        );
        assertEquals(
            SmeltControlPlanner.Action.FAIL_FURNACE_NOT_EMPTY,
            SmeltControlPlanner.decideFurnaceOpened(state, true, false, true, true, false, false, false).action()
        );
        assertEquals(
            SmeltControlPlanner.Action.FAIL_FURNACE_NOT_EMPTY,
            SmeltControlPlanner.decideFurnaceOpened(state, true, true, false, true, false, false, false).action()
        );
        assertEquals(
            SmeltControlPlanner.Action.FAIL_FURNACE_NOT_EMPTY,
            SmeltControlPlanner.decideFurnaceOpened(state, true, true, true, false, false, false, false).action()
        );

        SmeltControlPlanner.Decision emptyFurnace = SmeltControlPlanner.decideFurnaceOpened(state, true, true, true, true, false, false, false);
        assertEquals(SmeltControlPlanner.Action.START_READY, emptyFurnace.action());
        assertEquals(SmeltControlPlanner.Stage.SELECT_INPUT, emptyFurnace.state().stage());

        SmeltControlPlanner.Decision reusableFuel = SmeltControlPlanner.decideFurnaceOpened(state, true, true, false, true, false, true, false);
        assertEquals(SmeltControlPlanner.Action.START_READY, reusableFuel.action());
        assertEquals(SmeltControlPlanner.Stage.SELECT_INPUT, reusableFuel.state().stage());

        SmeltControlPlanner.Decision resumableOutput = SmeltControlPlanner.decideFurnaceOpened(state, true, true, true, false, false, false, true);
        assertEquals(SmeltControlPlanner.Action.OUTPUT_READY, resumableOutput.action());
        assertEquals(SmeltControlPlanner.Stage.TAKE_OUTPUT, resumableOutput.state().stage());

        SmeltControlPlanner.Decision batchedOutput = SmeltControlPlanner.decideFurnaceOpened(state, true, false, false, false, true, true, true);
        assertEquals(SmeltControlPlanner.Action.OUTPUT_READY, batchedOutput.action());
        assertEquals(SmeltControlPlanner.Stage.TAKE_OUTPUT, batchedOutput.state().stage());
    }

    @Test
    void furnaceOpenStartResumesCompatibleLoadedInputInsteadOfRejecting() {
        SmeltControlPlanner.State state = new SmeltControlPlanner.State(SmeltControlPlanner.Stage.START);

        SmeltControlPlanner.Decision loadedInputAndFuel = SmeltControlPlanner.decideFurnaceOpened(
            state,
            true,
            false,
            false,
            true,
            true,
            true,
            false
        );
        assertEquals(SmeltControlPlanner.Action.RESUME_LOADED_INPUT, loadedInputAndFuel.action());
        assertEquals(SmeltControlPlanner.Stage.WAIT_OUTPUT, loadedInputAndFuel.state().stage());
        assertEquals("resume_loaded_input", loadedInputAndFuel.reason());

        SmeltControlPlanner.Decision loadedInputNeedsFuel = SmeltControlPlanner.decideFurnaceOpened(
            state,
            true,
            false,
            true,
            true,
            true,
            false,
            false
        );
        assertEquals(SmeltControlPlanner.Action.RESUME_LOADED_INPUT_NEEDS_FUEL, loadedInputNeedsFuel.action());
        assertEquals(SmeltControlPlanner.Stage.SELECT_FUEL, loadedInputNeedsFuel.state().stage());
        assertEquals("resume_loaded_input_needs_fuel", loadedInputNeedsFuel.reason());

        SmeltControlPlanner.Decision wrongLoadedInput = SmeltControlPlanner.decideFurnaceOpened(
            state,
            true,
            false,
            true,
            true,
            false,
            false,
            false
        );
        assertEquals(SmeltControlPlanner.Action.FAIL_FURNACE_NOT_EMPTY, wrongLoadedInput.action());
    }

    @Test
    void sourceSelectionTransitionsOrFailsWithoutSideEffects() {
        SmeltControlPlanner.State input = new SmeltControlPlanner.State(SmeltControlPlanner.Stage.SELECT_INPUT);
        SmeltControlPlanner.Decision missingInput = SmeltControlPlanner.decideInputSource(input, false);
        assertEquals(SmeltControlPlanner.Action.FAIL_INPUT_SOURCE_MISSING, missingInput.action());
        assertEquals(SmeltControlPlanner.Stage.SELECT_INPUT, missingInput.state().stage());

        SmeltControlPlanner.Decision selectedInput = SmeltControlPlanner.decideInputSource(input, true);
        assertEquals(SmeltControlPlanner.Action.INPUT_SOURCE_SELECTED, selectedInput.action());
        assertEquals(SmeltControlPlanner.Stage.PICK_INPUT_STACK, selectedInput.state().stage());

        SmeltControlPlanner.State fuel = new SmeltControlPlanner.State(SmeltControlPlanner.Stage.SELECT_FUEL);
        SmeltControlPlanner.Decision missingFuel = SmeltControlPlanner.decideFuelSource(fuel, false);
        assertEquals(SmeltControlPlanner.Action.FAIL_FUEL_SOURCE_MISSING, missingFuel.action());
        assertEquals(SmeltControlPlanner.Stage.SELECT_FUEL, missingFuel.state().stage());

        SmeltControlPlanner.Decision selectedFuel = SmeltControlPlanner.decideFuelSource(fuel, true);
        assertEquals(SmeltControlPlanner.Action.FUEL_SOURCE_SELECTED, selectedFuel.action());
        assertEquals(SmeltControlPlanner.Stage.PICK_FUEL_STACK, selectedFuel.state().stage());
    }

    @Test
    void inputStackPlacementPreservesCursorSafetyChecksAndLoadedFuelBranching() {
        SmeltControlPlanner.StageObservation empty = observation(true, false, "", 0, "iron_ingot", false, false);
        SmeltControlPlanner.StageObservation occupied = observation(false, false, "", 0, "iron_ingot", false, false);
        SmeltControlPlanner.StageObservation loadedFuel = observation(true, true, "", 0, "iron_ingot", false, false);

        SmeltControlPlanner.Decision pick = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.PICK_INPUT_STACK),
            empty
        );
        assertEquals(SmeltControlPlanner.Action.PICK_INPUT_STACK, pick.action());
        assertEquals(SmeltControlPlanner.Stage.PLACE_INPUT, pick.state().stage());

        SmeltControlPlanner.Decision emptyCursor = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.PLACE_INPUT),
            empty
        );
        assertEquals(SmeltControlPlanner.Action.FAIL_CURSOR_EMPTY_BEFORE_INPUT, emptyCursor.action());
        assertEquals(SmeltControlPlanner.Stage.PLACE_INPUT, emptyCursor.state().stage());

        SmeltControlPlanner.Decision place = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.PLACE_INPUT),
            occupied
        );
        assertEquals(SmeltControlPlanner.Action.PLACE_INPUT, place.action());
        assertEquals(SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER, place.state().stage());

        SmeltControlPlanner.Decision returnRemainder = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER),
            occupied
        );
        assertEquals(SmeltControlPlanner.Action.RETURN_INPUT_REMAINDER, returnRemainder.action());
        assertEquals(SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER, returnRemainder.state().stage());

        SmeltControlPlanner.Decision selectFuel = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER),
            empty
        );
        assertEquals(SmeltControlPlanner.Action.SELECT_FUEL, selectFuel.action());
        assertEquals(SmeltControlPlanner.Stage.SELECT_FUEL, selectFuel.state().stage());

        SmeltControlPlanner.Decision reuseFuel = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER),
            loadedFuel
        );
        assertEquals(SmeltControlPlanner.Action.REUSE_LOADED_FUEL, reuseFuel.action());
        assertEquals(SmeltControlPlanner.Stage.WAIT_OUTPUT, reuseFuel.state().stage());
    }

    @Test
    void fuelStackPlacementPreservesCursorSafetyChecks() {
        SmeltControlPlanner.StageObservation empty = observation(true, false, "", 0, "iron_ingot", false, false);
        SmeltControlPlanner.StageObservation occupied = observation(false, false, "", 0, "iron_ingot", false, false);

        SmeltControlPlanner.Decision pick = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.PICK_FUEL_STACK),
            empty
        );
        assertEquals(SmeltControlPlanner.Action.PICK_FUEL_STACK, pick.action());
        assertEquals(SmeltControlPlanner.Stage.PLACE_FUEL, pick.state().stage());

        SmeltControlPlanner.Decision emptyCursor = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.PLACE_FUEL),
            empty
        );
        assertEquals(SmeltControlPlanner.Action.FAIL_CURSOR_EMPTY_BEFORE_FUEL, emptyCursor.action());
        assertEquals(SmeltControlPlanner.Stage.PLACE_FUEL, emptyCursor.state().stage());

        SmeltControlPlanner.Decision place = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.PLACE_FUEL),
            occupied
        );
        assertEquals(SmeltControlPlanner.Action.PLACE_FUEL, place.action());
        assertEquals(SmeltControlPlanner.Stage.RETURN_FUEL_REMAINDER, place.state().stage());

        SmeltControlPlanner.Decision returnRemainder = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.RETURN_FUEL_REMAINDER),
            occupied
        );
        assertEquals(SmeltControlPlanner.Action.RETURN_FUEL_REMAINDER, returnRemainder.action());
        assertEquals(SmeltControlPlanner.Stage.RETURN_FUEL_REMAINDER, returnRemainder.state().stage());

        SmeltControlPlanner.Decision waitOutput = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.RETURN_FUEL_REMAINDER),
            empty
        );
        assertEquals(SmeltControlPlanner.Action.WAIT_OUTPUT, waitOutput.action());
        assertEquals(SmeltControlPlanner.Stage.WAIT_OUTPUT, waitOutput.state().stage());
    }

    @Test
    void waitOutputPrioritizesWrongOutputThenReadyThenTimeout() {
        SmeltControlPlanner.State state = new SmeltControlPlanner.State(SmeltControlPlanner.Stage.WAIT_OUTPUT);

        SmeltControlPlanner.Decision wrong = SmeltControlPlanner.decideStage(
            state,
            observation(true, false, "charcoal", 1, "iron_ingot", true, false)
        );
        assertEquals(SmeltControlPlanner.Action.FAIL_WRONG_OUTPUT, wrong.action());
        assertEquals(SmeltControlPlanner.Stage.WAIT_OUTPUT, wrong.state().stage());
        assertEquals("wrong_output:charcoal", wrong.reason());

        SmeltControlPlanner.Decision ready = SmeltControlPlanner.decideStage(
            state,
            observation(true, false, "iron_ingot", 1, "iron_ingot", true, false)
        );
        assertEquals(SmeltControlPlanner.Action.OUTPUT_READY, ready.action());
        assertEquals(SmeltControlPlanner.Stage.TAKE_OUTPUT, ready.state().stage());

        SmeltControlPlanner.Decision waitingForBatch = SmeltControlPlanner.decideStage(
            state,
            observation(true, false, "iron_ingot", 1, "iron_ingot", 2, false, false)
        );
        assertEquals(SmeltControlPlanner.Action.WAIT_OUTPUT, waitingForBatch.action());
        assertEquals(SmeltControlPlanner.Stage.WAIT_OUTPUT, waitingForBatch.state().stage());

        SmeltControlPlanner.Decision timeout = SmeltControlPlanner.decideStage(
            state,
            observation(true, false, "", 0, "iron_ingot", true, false)
        );
        assertEquals(SmeltControlPlanner.Action.FAIL_OUTPUT_TIMEOUT, timeout.action());
        assertEquals(SmeltControlPlanner.Stage.WAIT_OUTPUT, timeout.state().stage());
    }

    @Test
    void takeOutputAndVerifyMatchExistingTerminalStages() {
        SmeltControlPlanner.Decision take = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.TAKE_OUTPUT),
            observation(true, false, "iron_ingot", 1, "iron_ingot", false, false)
        );
        assertEquals(SmeltControlPlanner.Action.TAKE_OUTPUT, take.action());
        assertEquals(SmeltControlPlanner.Stage.VERIFY, take.state().stage());

        SmeltControlPlanner.Decision verifyWait = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.VERIFY),
            observation(true, false, "iron_ingot", 1, "iron_ingot", false, false)
        );
        assertEquals(SmeltControlPlanner.Action.VERIFY_TYPED_DELTA, verifyWait.action());
        assertEquals(SmeltControlPlanner.Stage.VERIFY, verifyWait.state().stage());

        SmeltControlPlanner.Decision verifyTimeout = SmeltControlPlanner.decideStage(
            new SmeltControlPlanner.State(SmeltControlPlanner.Stage.VERIFY),
            observation(true, false, "iron_ingot", 1, "iron_ingot", false, true)
        );
        assertEquals(SmeltControlPlanner.Action.FAIL_TYPED_DELTA_MISSING, verifyTimeout.action());
        assertEquals(SmeltControlPlanner.Stage.VERIFY, verifyTimeout.state().stage());
    }

    @Test
    void clickSettleCanBeAppliedAtAnyCurrentStage() {
        SmeltControlPlanner.State state = new SmeltControlPlanner.State(SmeltControlPlanner.Stage.PLACE_FUEL);

        SmeltControlPlanner.Decision wait = SmeltControlPlanner.decideClickSettle(state, true);
        assertEquals(SmeltControlPlanner.Action.WAIT_CLICK_SETTLE, wait.action());
        assertEquals(SmeltControlPlanner.Stage.PLACE_FUEL, wait.state().stage());

        SmeltControlPlanner.Decision continueDecision = SmeltControlPlanner.decideClickSettle(state, false);
        assertEquals(SmeltControlPlanner.Action.CONTINUE, continueDecision.action());
        assertEquals(SmeltControlPlanner.Stage.PLACE_FUEL, continueDecision.state().stage());
    }

    private SmeltControlPlanner.StageObservation observation(
        boolean cursorEmpty,
        boolean loadedFuelCompatible,
        String outputItemId,
        int outputCount,
        String expectedOutputItemId,
        boolean outputTimedOut,
        boolean verifyTimedOut
    ) {
        return observation(cursorEmpty, loadedFuelCompatible, outputItemId, outputCount, expectedOutputItemId, 1, outputTimedOut, verifyTimedOut);
    }

    private SmeltControlPlanner.StageObservation observation(
        boolean cursorEmpty,
        boolean loadedFuelCompatible,
        String outputItemId,
        int outputCount,
        String expectedOutputItemId,
        int expectedOutputCount,
        boolean outputTimedOut,
        boolean verifyTimedOut
    ) {
        return new SmeltControlPlanner.StageObservation(
            cursorEmpty,
            loadedFuelCompatible,
            outputItemId,
            outputCount,
            expectedOutputItemId,
            expectedOutputCount,
            outputTimedOut,
            verifyTimedOut
        );
    }
}
