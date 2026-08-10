package com.mcbot.fabricclient;

/** Pure material and site admission for the existing one-time local tool-restock fallback. */
final class MiningIronLocalToolRestockPolicy {
    static final int PICKAXE_COBBLESTONE = 3;
    static final int PICKAXE_STICKS = 2;
    static final int STICK_CRAFT_PLANKS = 2;
    static final int TABLE_PLANKS = 4;
    static final int PROTECTED_PLANKS = 6;

    private MiningIronLocalToolRestockPolicy() {
    }

    record Request(
        int cobblestone,
        int sticks,
        int planks,
        int logs,
        int carriedTables,
        boolean usableNearbyTable,
        boolean legalPlacementAlcove
    ) {
        Request {
            cobblestone = Math.max(0, cobblestone);
            sticks = Math.max(0, sticks);
            planks = Math.max(0, planks);
            logs = Math.max(0, logs);
            carriedTables = Math.max(0, carriedTables);
        }

        Request(
            int cobblestone,
            int sticks,
            int planks,
            int carriedTables,
            boolean usableNearbyTable,
            boolean legalPlacementAlcove
        ) {
            this(cobblestone, sticks, planks, 0, carriedTables, usableNearbyTable, legalPlacementAlcove);
        }
    }

    record Decision(
        boolean admitted,
        boolean craftSticks,
        boolean placeOrCraftTable,
        int requiredPlanks,
        String reason
    ) {
    }

    static Decision assess(Request request) {
        if (request == null) {
            return rejected("missing_request");
        }
        if (request.cobblestone() < PICKAXE_COBBLESTONE) {
            return rejected("missing_cobblestone");
        }
        boolean craftSticks = request.sticks() < PICKAXE_STICKS;
        int stickPlanks = craftSticks ? STICK_CRAFT_PLANKS : 0;
        int convertiblePlanks = request.planks() + (request.logs() * 4);
        if (request.usableNearbyTable()) {
            int required = craftSticks ? stickPlanks + PROTECTED_PLANKS : 0;
            return convertiblePlanks >= required
                ? admitted(craftSticks, false, required, "nearby_table")
                : rejected("plank_reserve");
        }
        if (!request.legalPlacementAlcove()) {
            return rejected("no_legal_table_site");
        }
        int tablePlanks = request.carriedTables() > 0 ? 0 : TABLE_PLANKS;
        int consumedPlanks = stickPlanks + tablePlanks;
        int required = consumedPlanks > 0 ? consumedPlanks + PROTECTED_PLANKS : 0;
        if (convertiblePlanks < required) {
            return rejected(request.carriedTables() > 0 ? "plank_reserve" : "missing_table_materials");
        }
        return admitted(craftSticks, true, required,
            request.carriedTables() > 0 ? "carried_table" : "craft_local_table");
    }

    private static Decision admitted(boolean sticks, boolean table, int planks, String reason) {
        return new Decision(true, sticks, table, planks, reason);
    }

    private static Decision rejected(String reason) {
        return new Decision(false, false, false, 0, reason);
    }
}
