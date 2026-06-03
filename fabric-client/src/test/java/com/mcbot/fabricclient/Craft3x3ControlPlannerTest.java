package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class Craft3x3ControlPlannerTest {
    @Test
    void preflightPreservesExistingPriorityOrder() {
        Craft3x3ControlPlanner.State state = new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.START);

        Craft3x3ControlPlanner.Decision complete = Craft3x3ControlPlanner.decidePreflight(state, true, true, false);
        assertEquals(Craft3x3ControlPlanner.Action.COMPLETE_TYPED_DELTA, complete.action());
        assertEquals("typed_delta_verified", complete.reason());

        Craft3x3ControlPlanner.Decision timeout = Craft3x3ControlPlanner.decidePreflight(state, false, true, false);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_TOTAL_TIMEOUT, timeout.action());
        assertEquals("timeout", timeout.reason());

        Craft3x3ControlPlanner.Decision missingInteraction = Craft3x3ControlPlanner.decidePreflight(state, false, false, false);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_MISSING_INTERACTION_MANAGER, missingInteraction.action());
        assertEquals("missing_interaction_manager", missingInteraction.reason());
    }

    @Test
    void tableOpenedRejectsCursorBeforeOccupiedInputs() {
        Craft3x3ControlPlanner.State state = new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.START);

        Craft3x3ControlPlanner.Decision cursor = Craft3x3ControlPlanner.decideTableOpened(state, false, false);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_CURSOR_NOT_EMPTY, cursor.action());
        assertEquals(Craft3x3ControlPlanner.Stage.START, cursor.state().stage());
        assertEquals("cursor_not_empty", cursor.reason());

        Craft3x3ControlPlanner.Decision inputs = Craft3x3ControlPlanner.decideTableOpened(state, true, false);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_INPUT_NOT_EMPTY, inputs.action());
        assertEquals(Craft3x3ControlPlanner.Stage.START, inputs.state().stage());
        assertEquals("input_not_empty", inputs.reason());

        Craft3x3ControlPlanner.Decision ready = Craft3x3ControlPlanner.decideTableOpened(state, true, true);
        assertEquals(Craft3x3ControlPlanner.Action.START_READY, ready.action());
        assertEquals(Craft3x3ControlPlanner.Stage.SELECT_SOURCE, ready.state().stage());
    }

    @Test
    void sourceSelectionHandlesInputsPlacedMissingSourceAndSelectedSource() {
        Craft3x3ControlPlanner.State state = new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.SELECT_SOURCE);

        Craft3x3ControlPlanner.Decision done = Craft3x3ControlPlanner.decideSourceSelection(state, false, false, null);
        assertEquals(Craft3x3ControlPlanner.Action.INPUTS_PLACED, done.action());
        assertEquals(Craft3x3ControlPlanner.Stage.WAIT_RESULT, done.state().stage());
        assertEquals("inputs_placed", done.reason());

        Craft3x3ControlPlanner.Decision missing = Craft3x3ControlPlanner.decideSourceSelection(state, true, false, "IRON_INGOT");
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_SOURCE_SLOT_MISSING, missing.action());
        assertEquals(Craft3x3ControlPlanner.Stage.SELECT_SOURCE, missing.state().stage());
        assertEquals("source_slot_missing:IRON_INGOT", missing.reason());

        Craft3x3ControlPlanner.Decision selected = Craft3x3ControlPlanner.decideSourceSelection(state, true, true, "IRON_INGOT");
        assertEquals(Craft3x3ControlPlanner.Action.SOURCE_SELECTED, selected.action());
        assertEquals(Craft3x3ControlPlanner.Stage.PICK_SOURCE_STACK, selected.state().stage());
    }

    @Test
    void inputPlacementPreservesCursorAndGroupFailurePriorityThenAdvancesAtEndOfGroup() {
        Craft3x3ControlPlanner.State state = new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.PLACE_INPUTS);

        Craft3x3ControlPlanner.Decision cursor = Craft3x3ControlPlanner.decidePlaceInput(state, true, false, 0, 3);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_CURSOR_EMPTY_BEFORE_PLACE, cursor.action());
        assertEquals(Craft3x3ControlPlanner.Stage.PLACE_INPUTS, cursor.state().stage());
        assertEquals("cursor_empty_before_place", cursor.reason());

        Craft3x3ControlPlanner.Decision group = Craft3x3ControlPlanner.decidePlaceInput(state, false, false, 0, 3);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_MISSING_CURRENT_GROUP, group.action());
        assertEquals(Craft3x3ControlPlanner.Stage.PLACE_INPUTS, group.state().stage());
        assertEquals("missing_current_group", group.reason());

        Craft3x3ControlPlanner.Decision moreInputs = Craft3x3ControlPlanner.decidePlaceInput(state, false, true, 0, 3);
        assertEquals(Craft3x3ControlPlanner.Action.PLACE_INPUT, moreInputs.action());
        assertEquals(Craft3x3ControlPlanner.Stage.PLACE_INPUTS, moreInputs.state().stage());

        Craft3x3ControlPlanner.Decision endOfGroup = Craft3x3ControlPlanner.decidePlaceInput(state, false, true, 2, 3);
        assertEquals(Craft3x3ControlPlanner.Action.PLACE_INPUT, endOfGroup.action());
        assertEquals(Craft3x3ControlPlanner.Stage.RETURN_REMAINDER, endOfGroup.state().stage());
    }

    @Test
    void remainderPickResultAndVerifyStagesMatchExistingReasons() {
        Craft3x3ControlPlanner.Decision pick = Craft3x3ControlPlanner.decidePickSource(
            new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.PICK_SOURCE_STACK)
        );
        assertEquals(Craft3x3ControlPlanner.Action.PICK_SOURCE_STACK, pick.action());
        assertEquals(Craft3x3ControlPlanner.Stage.PLACE_INPUTS, pick.state().stage());
        assertEquals("pick_source", pick.reason());

        Craft3x3ControlPlanner.Decision remainder = Craft3x3ControlPlanner.decideReturnRemainder(
            new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.RETURN_REMAINDER)
        );
        assertEquals(Craft3x3ControlPlanner.Action.RETURN_REMAINDER, remainder.action());
        assertEquals(Craft3x3ControlPlanner.Stage.SELECT_SOURCE, remainder.state().stage());
        assertEquals("return_remainder", remainder.reason());

        Craft3x3ControlPlanner.Decision take = Craft3x3ControlPlanner.decideTakeResult(
            new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.TAKE_RESULT)
        );
        assertEquals(Craft3x3ControlPlanner.Action.TAKE_RESULT, take.action());
        assertEquals(Craft3x3ControlPlanner.Stage.VERIFY, take.state().stage());
        assertEquals("take_result", take.reason());

        Craft3x3ControlPlanner.Decision verify = Craft3x3ControlPlanner.decideVerify(
            new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.VERIFY),
            false
        );
        assertEquals(Craft3x3ControlPlanner.Action.VERIFY_TYPED_DELTA, verify.action());
        assertEquals(Craft3x3ControlPlanner.Stage.VERIFY, verify.state().stage());
        assertEquals("verify_typed_delta", verify.reason());

        Craft3x3ControlPlanner.Decision verifyTimeout = Craft3x3ControlPlanner.decideVerify(
            new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.VERIFY),
            true
        );
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_TYPED_DELTA_MISSING, verifyTimeout.action());
        assertEquals(Craft3x3ControlPlanner.Stage.VERIFY, verifyTimeout.state().stage());
        assertEquals("typed_delta_missing", verifyTimeout.reason());
    }

    @Test
    void waitResultPrioritizesExpectedResultBeforeTimeout() {
        Craft3x3ControlPlanner.State state = new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.WAIT_RESULT);

        Craft3x3ControlPlanner.Decision ready = Craft3x3ControlPlanner.decideWaitResult(state, true, true);
        assertEquals(Craft3x3ControlPlanner.Action.RESULT_READY, ready.action());
        assertEquals(Craft3x3ControlPlanner.Stage.TAKE_RESULT, ready.state().stage());
        assertEquals("result_ready", ready.reason());

        Craft3x3ControlPlanner.Decision timeout = Craft3x3ControlPlanner.decideWaitResult(state, false, true);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_RESULT_MISSING, timeout.action());
        assertEquals(Craft3x3ControlPlanner.Stage.WAIT_RESULT, timeout.state().stage());
        assertEquals("result_missing", timeout.reason());

        Craft3x3ControlPlanner.Decision wait = Craft3x3ControlPlanner.decideWaitResult(state, false, false);
        assertEquals(Craft3x3ControlPlanner.Action.WAIT_RESULT, wait.action());
        assertEquals(Craft3x3ControlPlanner.Stage.WAIT_RESULT, wait.state().stage());
        assertEquals("wait_result", wait.reason());
    }

    @Test
    void clickSettleCanBeAppliedAtAnyStage() {
        Craft3x3ControlPlanner.State state = new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.SELECT_SOURCE);

        Craft3x3ControlPlanner.Decision wait = Craft3x3ControlPlanner.decideClickSettle(state, true);
        assertEquals(Craft3x3ControlPlanner.Action.WAIT_CLICK_SETTLE, wait.action());
        assertEquals(Craft3x3ControlPlanner.Stage.SELECT_SOURCE, wait.state().stage());
        assertEquals("click_settle", wait.reason());

        Craft3x3ControlPlanner.Decision continueDecision = Craft3x3ControlPlanner.decideClickSettle(state, false);
        assertEquals(Craft3x3ControlPlanner.Action.CONTINUE, continueDecision.action());
        assertEquals(Craft3x3ControlPlanner.Stage.SELECT_SOURCE, continueDecision.state().stage());
    }
}
