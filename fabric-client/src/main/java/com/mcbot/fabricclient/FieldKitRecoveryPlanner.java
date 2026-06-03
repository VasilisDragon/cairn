package com.mcbot.fabricclient;

final class FieldKitRecoveryPlanner {
    private FieldKitRecoveryPlanner() {
    }

    enum Action {
        CONTINUE,
        RETRIEVE_TABLE,
        RETRIEVE_TABLE_FAILED,
        RETRIEVE_TABLE_COMPLETE,
        HOTBAR_PICKAXE_MOVED,
        CLOSE_SCREEN_BEFORE_HOTBAR_MOVE,
        MISSING_PICKAXE_INPUTS,
        NO_CRAFTING_TABLE,
        PLACE_TABLE_REQUIRED,
        PLACE_TABLE_FAILED,
        PLACE_TABLE_MARKED,
        PLACE_TABLE_COMPLETE,
        CRAFT_PICKAXE,
        CRAFT_PICKAXE_FAILED,
        CRAFT_PICKAXE_COMPLETE,
        RECOVERY_LIMIT_REACHED
    }

    record State(
        boolean active,
        boolean retrieveTablePending,
        boolean tablePlacedByRecovery,
        boolean alcoveKnown,
        boolean proactiveLogged,
        int attempts
    ) {
        State {
            if (attempts < 0) {
                attempts = 0;
            }
        }

        static State inactive() {
            return new State(false, false, false, false, false, 0);
        }

        State activate() {
            return new State(true, retrieveTablePending, tablePlacedByRecovery, alcoveKnown, proactiveLogged, attempts);
        }

        State clearRecovery() {
            return new State(false, false, false, false, false, attempts);
        }

        State withTablePlacedByRecovery(boolean placed) {
            return new State(active, retrieveTablePending, placed, alcoveKnown, proactiveLogged, attempts);
        }

        State withRetrieveTablePending(boolean pending) {
            return new State(active, pending, tablePlacedByRecovery, alcoveKnown, proactiveLogged, attempts);
        }

        State withAttemptIncremented() {
            return new State(active, retrieveTablePending, tablePlacedByRecovery, alcoveKnown, proactiveLogged, attempts + 1);
        }
    }

    record InventoryObservation(
        boolean craftingScreenOpen,
        int cobblestoneCount,
        int stickCount,
        int craftingTableCount,
        boolean nearbyCraftingTablePresent,
        boolean nearbyTableIsRecoveryAlcove
    ) {
    }

    record Decision(State state, Action action, boolean clearMiningTargets) {
    }

    static Decision activate(State state) {
        return new Decision(state.activate(), Action.CONTINUE, true);
    }

    static Decision tick(State state, int maxAttempts) {
        if (state.attempts() >= maxAttempts) {
            return new Decision(state, Action.RECOVERY_LIMIT_REACHED, false);
        }
        if (state.retrieveTablePending()) {
            return new Decision(state, Action.RETRIEVE_TABLE, false);
        }
        return new Decision(state, Action.CONTINUE, false);
    }

    static Decision afterRetrieve(State state, String reason) {
        if (startsWith(reason, "retrieve_table_failed")) {
            return new Decision(state, Action.RETRIEVE_TABLE_FAILED, false);
        }
        if (startsWith(reason, "retrieve_table_complete")) {
            return new Decision(state.clearRecovery(), Action.RETRIEVE_TABLE_COMPLETE, false);
        }
        return new Decision(state, Action.CONTINUE, false);
    }

    static Decision afterHotbarMove(State state, boolean craftingScreenOpen, int movedHotbarSlot) {
        if (craftingScreenOpen) {
            return new Decision(state, Action.CONTINUE, false);
        }
        if (movedHotbarSlot >= 0) {
            return new Decision(state.clearRecovery(), Action.HOTBAR_PICKAXE_MOVED, false);
        }
        if (movedHotbarSlot == -2) {
            return new Decision(state, Action.CLOSE_SCREEN_BEFORE_HOTBAR_MOVE, false);
        }
        return new Decision(state, Action.CONTINUE, false);
    }

    static Decision afterInventory(State state, InventoryObservation observation) {
        State next = state;
        if (observation.nearbyTableIsRecoveryAlcove()) {
            next = next.withTablePlacedByRecovery(true);
        }
        if (!observation.craftingScreenOpen()
            && (observation.cobblestoneCount() < 3 || observation.stickCount() < 2)) {
            return new Decision(next, Action.MISSING_PICKAXE_INPUTS, false);
        }
        if (!observation.craftingScreenOpen() && !observation.nearbyCraftingTablePresent()) {
            if (observation.craftingTableCount() < 1) {
                return new Decision(next, Action.NO_CRAFTING_TABLE, false);
            }
            return new Decision(next, Action.PLACE_TABLE_REQUIRED, false);
        }
        return new Decision(next, Action.CRAFT_PICKAXE, false);
    }

    static Decision afterPlaceTable(State state, String reason) {
        if (startsWith(reason, "place_table_failed")) {
            return new Decision(state, Action.PLACE_TABLE_FAILED, false);
        }
        if (startsWith(reason, "place_table_placing") && contains(reason, "interact_block:SUCCESS")) {
            return new Decision(state.withTablePlacedByRecovery(true), Action.PLACE_TABLE_MARKED, false);
        }
        if (startsWith(reason, "place_table_complete")) {
            return new Decision(state.withTablePlacedByRecovery(true), Action.PLACE_TABLE_COMPLETE, false);
        }
        return new Decision(state, Action.CONTINUE, false);
    }

    static Decision afterCraftPickaxe(State state, String reason) {
        if (startsWith(reason, "craft_stone_pickaxe_failed")) {
            return new Decision(state, Action.CRAFT_PICKAXE_FAILED, false);
        }
        if (startsWith(reason, "craft_stone_pickaxe_complete")) {
            State next = state.withAttemptIncremented();
            if (next.tablePlacedByRecovery()) {
                next = new State(true, true, true, next.alcoveKnown(), next.proactiveLogged(), next.attempts());
            } else {
                next = next.clearRecovery();
            }
            return new Decision(next, Action.CRAFT_PICKAXE_COMPLETE, false);
        }
        return new Decision(state, Action.CONTINUE, false);
    }

    private static boolean startsWith(String value, String prefix) {
        return value != null && value.startsWith(prefix);
    }

    private static boolean contains(String value, String needle) {
        return value != null && value.contains(needle);
    }
}
