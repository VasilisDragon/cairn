package com.mcbot.fabricclient;

final class SmeltControlPlanner {
    private SmeltControlPlanner() {
    }

    enum Stage {
        START,
        SELECT_INPUT,
        PICK_INPUT_STACK,
        PLACE_INPUT,
        RETURN_INPUT_REMAINDER,
        SELECT_FUEL,
        PICK_FUEL_STACK,
        PLACE_FUEL,
        RETURN_FUEL_REMAINDER,
        WAIT_OUTPUT,
        TAKE_OUTPUT,
        VERIFY
    }

    enum Action {
        CONTINUE,
        COMPLETE_TYPED_DELTA,
        FAIL_TOTAL_TIMEOUT,
        FAIL_MISSING_INTERACTION_MANAGER,
        FAIL_CURSOR_NOT_EMPTY,
        FAIL_FURNACE_NOT_EMPTY,
        START_READY,
        RESUME_LOADED_INPUT,
        RESUME_LOADED_INPUT_NEEDS_FUEL,
        WAIT_CLICK_SETTLE,
        FAIL_INPUT_SOURCE_MISSING,
        INPUT_SOURCE_SELECTED,
        PICK_INPUT_STACK,
        FAIL_CURSOR_EMPTY_BEFORE_INPUT,
        PLACE_INPUT,
        RETURN_INPUT_REMAINDER,
        REUSE_LOADED_FUEL,
        SELECT_FUEL,
        FAIL_FUEL_SOURCE_MISSING,
        FUEL_SOURCE_SELECTED,
        PICK_FUEL_STACK,
        FAIL_CURSOR_EMPTY_BEFORE_FUEL,
        PLACE_FUEL,
        RETURN_FUEL_REMAINDER,
        WAIT_OUTPUT,
        OUTPUT_READY,
        FAIL_WRONG_OUTPUT,
        FAIL_OUTPUT_TIMEOUT,
        TAKE_OUTPUT,
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

    static Decision decideFurnaceOpened(
        State state,
        boolean cursorEmpty,
        boolean inputSlotEmpty,
        boolean fuelSlotEmpty,
        boolean outputSlotEmpty,
        boolean loadedInputCompatible,
        boolean loadedFuelCompatible,
        boolean expectedOutputPresent
    ) {
        if (!cursorEmpty) {
            return new Decision(state, Action.FAIL_CURSOR_NOT_EMPTY, "cursor_not_empty");
        }
        if (!outputSlotEmpty && expectedOutputPresent) {
            return new Decision(state.withStage(Stage.TAKE_OUTPUT), Action.OUTPUT_READY, "resume_output_ready");
        }
        if (!inputSlotEmpty && loadedInputCompatible) {
            if (!outputSlotEmpty) {
                return new Decision(state, Action.FAIL_FURNACE_NOT_EMPTY, "furnace_not_empty");
            }
            if (fuelSlotEmpty) {
                return new Decision(state.withStage(Stage.SELECT_FUEL), Action.RESUME_LOADED_INPUT_NEEDS_FUEL, "resume_loaded_input_needs_fuel");
            }
            if (loadedFuelCompatible) {
                return new Decision(state.withStage(Stage.WAIT_OUTPUT), Action.RESUME_LOADED_INPUT, "resume_loaded_input");
            }
            return new Decision(state, Action.FAIL_FURNACE_NOT_EMPTY, "furnace_not_empty");
        }
        if (!FurnaceSmeltPlanner.canStartWithFurnaceSlots(inputSlotEmpty, fuelSlotEmpty, outputSlotEmpty, loadedFuelCompatible)) {
            return new Decision(state, Action.FAIL_FURNACE_NOT_EMPTY, "furnace_not_empty");
        }
        return new Decision(state.withStage(Stage.SELECT_INPUT), Action.START_READY, "start_ready");
    }

    static Decision decideClickSettle(State state, boolean clickSettling) {
        return clickSettling
            ? new Decision(state, Action.WAIT_CLICK_SETTLE, "click_settle")
            : new Decision(state, Action.CONTINUE, "");
    }

    static Decision decideInputSource(State state, boolean sourceFound) {
        if (!sourceFound) {
            return new Decision(state, Action.FAIL_INPUT_SOURCE_MISSING, "input_source_missing");
        }
        return new Decision(state.withStage(Stage.PICK_INPUT_STACK), Action.INPUT_SOURCE_SELECTED, "input_source_selected");
    }

    static Decision decideFuelSource(State state, boolean sourceFound) {
        if (!sourceFound) {
            return new Decision(state, Action.FAIL_FUEL_SOURCE_MISSING, "fuel_source_missing");
        }
        return new Decision(state.withStage(Stage.PICK_FUEL_STACK), Action.FUEL_SOURCE_SELECTED, "fuel_source_selected");
    }

    static Decision decideStage(State state, StageObservation observation) {
        return switch (state.stage()) {
            case PICK_INPUT_STACK -> new Decision(state.withStage(Stage.PLACE_INPUT), Action.PICK_INPUT_STACK, "pick_input");
            case PLACE_INPUT -> observation.cursorEmpty()
                ? new Decision(state, Action.FAIL_CURSOR_EMPTY_BEFORE_INPUT, "cursor_empty_before_input")
                : new Decision(state.withStage(Stage.RETURN_INPUT_REMAINDER), Action.PLACE_INPUT, "place_input");
            case RETURN_INPUT_REMAINDER -> {
                if (!observation.cursorEmpty()) {
                    yield new Decision(state, Action.RETURN_INPUT_REMAINDER, "return_input_remainder");
                }
                if (observation.loadedFuelCompatible()) {
                    yield new Decision(state.withStage(Stage.WAIT_OUTPUT), Action.REUSE_LOADED_FUEL, "reuse_loaded_fuel");
                }
                yield new Decision(state.withStage(Stage.SELECT_FUEL), Action.SELECT_FUEL, "select_fuel");
            }
            case PICK_FUEL_STACK -> new Decision(state.withStage(Stage.PLACE_FUEL), Action.PICK_FUEL_STACK, "pick_fuel");
            case PLACE_FUEL -> observation.cursorEmpty()
                ? new Decision(state, Action.FAIL_CURSOR_EMPTY_BEFORE_FUEL, "cursor_empty_before_fuel")
                : new Decision(state.withStage(Stage.RETURN_FUEL_REMAINDER), Action.PLACE_FUEL, "place_fuel");
            case RETURN_FUEL_REMAINDER -> !observation.cursorEmpty()
                ? new Decision(state, Action.RETURN_FUEL_REMAINDER, "return_fuel_remainder")
                : new Decision(state.withStage(Stage.WAIT_OUTPUT), Action.WAIT_OUTPUT, "wait_output");
            case WAIT_OUTPUT -> decideWaitOutput(state, observation);
            case TAKE_OUTPUT -> new Decision(state.withStage(Stage.VERIFY), Action.TAKE_OUTPUT, "take_output");
            case VERIFY -> observation.verifyTimedOut()
                ? new Decision(state, Action.FAIL_TYPED_DELTA_MISSING, "typed_delta_missing")
                : new Decision(state, Action.VERIFY_TYPED_DELTA, "verify_typed_delta");
            case START, SELECT_INPUT, SELECT_FUEL -> new Decision(state, Action.CONTINUE, "");
        };
    }

    private static Decision decideWaitOutput(State state, StageObservation observation) {
        if (FurnaceSmeltPlanner.isWrongOutput(observation.outputItemId(), observation.expectedOutputItemId())) {
            return new Decision(state, Action.FAIL_WRONG_OUTPUT, "wrong_output:" + observation.outputItemId());
        }
        if (FurnaceSmeltPlanner.isExpectedOutput(
            observation.outputItemId(),
            observation.outputCount(),
            observation.expectedOutputItemId(),
            Math.max(1, observation.expectedOutputCount())
        )) {
            return new Decision(state.withStage(Stage.TAKE_OUTPUT), Action.OUTPUT_READY, "output_ready");
        }
        if (observation.outputTimedOut()) {
            return new Decision(state, Action.FAIL_OUTPUT_TIMEOUT, "output_timeout");
        }
        return new Decision(state, Action.WAIT_OUTPUT, "waiting_for_output");
    }

    record StageObservation(
        boolean cursorEmpty,
        boolean loadedFuelCompatible,
        String outputItemId,
        int outputCount,
        String expectedOutputItemId,
        int expectedOutputCount,
        boolean outputTimedOut,
        boolean verifyTimedOut
    ) {
    }
}
