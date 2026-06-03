package com.mcbot.fabricclient;

final class Craft3x3ControlPlanner {
    private Craft3x3ControlPlanner() {
    }

    enum Stage {
        START,
        SELECT_SOURCE,
        PICK_SOURCE_STACK,
        PLACE_INPUTS,
        RETURN_REMAINDER,
        WAIT_RESULT,
        TAKE_RESULT,
        VERIFY
    }

    enum Action {
        CONTINUE,
        COMPLETE_TYPED_DELTA,
        FAIL_TOTAL_TIMEOUT,
        FAIL_MISSING_INTERACTION_MANAGER,
        FAIL_CURSOR_NOT_EMPTY,
        FAIL_INPUT_NOT_EMPTY,
        START_READY,
        WAIT_CLICK_SETTLE,
        INPUTS_PLACED,
        FAIL_SOURCE_SLOT_MISSING,
        SOURCE_SELECTED,
        PICK_SOURCE_STACK,
        FAIL_CURSOR_EMPTY_BEFORE_PLACE,
        FAIL_MISSING_CURRENT_GROUP,
        PLACE_INPUT,
        RETURN_REMAINDER,
        RESULT_READY,
        FAIL_RESULT_MISSING,
        WAIT_RESULT,
        TAKE_RESULT,
        VERIFY_TYPED_DELTA,
        FAIL_TYPED_DELTA_MISSING,
        FAIL_UNKNOWN_STAGE
    }

    record State(Stage stage) {
        State {
            stage = stage == null ? Stage.START : stage;
        }

        State withStage(Stage nextStage) {
            return new State(nextStage);
        }
    }

    record Decision(State state, Action action, String reason) {
    }

    static Decision decidePreflight(State state, boolean typedDeltaComplete, boolean totalTimedOut, boolean interactionManagerPresent) {
        if (typedDeltaComplete) {
            return new Decision(state, Action.COMPLETE_TYPED_DELTA, "typed_delta_verified");
        }
        if (totalTimedOut) {
            return new Decision(state, Action.FAIL_TOTAL_TIMEOUT, "timeout");
        }
        if (!interactionManagerPresent) {
            return new Decision(state, Action.FAIL_MISSING_INTERACTION_MANAGER, "missing_interaction_manager");
        }
        return new Decision(state, Action.CONTINUE, "");
    }

    static Decision decideTableOpened(State state, boolean cursorEmpty, boolean inputEmpty) {
        if (!cursorEmpty) {
            return new Decision(state, Action.FAIL_CURSOR_NOT_EMPTY, "cursor_not_empty");
        }
        if (!inputEmpty) {
            return new Decision(state, Action.FAIL_INPUT_NOT_EMPTY, "input_not_empty");
        }
        return new Decision(state.withStage(Stage.SELECT_SOURCE), Action.START_READY, "start_ready");
    }

    static Decision decideClickSettle(State state, boolean clickSettling) {
        return clickSettling
            ? new Decision(state, Action.WAIT_CLICK_SETTLE, "click_settle")
            : new Decision(state, Action.CONTINUE, "");
    }

    static Decision decideSourceSelection(State state, boolean groupPresent, boolean sourceFound, String ingredientName) {
        if (!groupPresent) {
            return new Decision(state.withStage(Stage.WAIT_RESULT), Action.INPUTS_PLACED, "inputs_placed");
        }
        if (!sourceFound) {
            return new Decision(state, Action.FAIL_SOURCE_SLOT_MISSING, "source_slot_missing:" + safe(ingredientName));
        }
        return new Decision(state.withStage(Stage.PICK_SOURCE_STACK), Action.SOURCE_SELECTED, "source_selected");
    }

    static Decision decidePickSource(State state) {
        return new Decision(state.withStage(Stage.PLACE_INPUTS), Action.PICK_SOURCE_STACK, "pick_source");
    }

    static Decision decidePlaceInput(State state, boolean cursorEmpty, boolean groupPresent, int inputIndexInGroup, int groupInputCount) {
        if (cursorEmpty) {
            return new Decision(state, Action.FAIL_CURSOR_EMPTY_BEFORE_PLACE, "cursor_empty_before_place");
        }
        if (!groupPresent) {
            return new Decision(state, Action.FAIL_MISSING_CURRENT_GROUP, "missing_current_group");
        }
        Stage nextStage = inputIndexInGroup + 1 >= groupInputCount ? Stage.RETURN_REMAINDER : Stage.PLACE_INPUTS;
        return new Decision(state.withStage(nextStage), Action.PLACE_INPUT, "place_input");
    }

    static Decision decideReturnRemainder(State state) {
        return new Decision(state.withStage(Stage.SELECT_SOURCE), Action.RETURN_REMAINDER, "return_remainder");
    }

    static Decision decideWaitResult(State state, boolean expectedResult, boolean resultTimedOut) {
        if (expectedResult) {
            return new Decision(state.withStage(Stage.TAKE_RESULT), Action.RESULT_READY, "result_ready");
        }
        if (resultTimedOut) {
            return new Decision(state, Action.FAIL_RESULT_MISSING, "result_missing");
        }
        return new Decision(state, Action.WAIT_RESULT, "wait_result");
    }

    static Decision decideTakeResult(State state) {
        return new Decision(state.withStage(Stage.VERIFY), Action.TAKE_RESULT, "take_result");
    }

    static Decision decideVerify(State state, boolean verifyTimedOut) {
        return verifyTimedOut
            ? new Decision(state, Action.FAIL_TYPED_DELTA_MISSING, "typed_delta_missing")
            : new Decision(state, Action.VERIFY_TYPED_DELTA, "verify_typed_delta");
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
