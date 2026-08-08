package com.mcbot.fabricclient;

/**
 * Classifies the terminal observation for one mission-owned stone-pick restock.
 *
 * <p>The client replaces a completed executor intent with a {@code stop} receipt before the
 * workspace transaction observes it.  The classifier therefore accepts either the original
 * craft intent or a stop-wrapped completion that is tied to the frozen restock/transaction.
 */
final class IronToolReserveRestockCompletionPolicy {
    enum Outcome {
        NONE,
        LOCAL_FALLBACK_HANDOFF,
        SUCCEEDED,
        FAILED
    }

    record Observation(
        String observedAction,
        String observedReason,
        String completionReason,
        String commandId,
        boolean pendingPreparation,
        String restockCommandId,
        String residentCommandId,
        String residentAction,
        String residentReason
    ) {
        Observation {
            observedAction = normalize(observedAction);
            observedReason = normalize(observedReason);
            completionReason = normalize(completionReason);
            commandId = normalize(commandId);
            restockCommandId = normalize(restockCommandId);
            residentCommandId = normalize(residentCommandId);
            residentAction = normalize(residentAction);
            residentReason = normalize(residentReason);
        }
    }

    private IronToolReserveRestockCompletionPolicy() {
    }

    static Outcome classify(Observation observation) {
        if (observation == null
            || observation.commandId().isBlank()
            || !observation.commandId().startsWith("mission-")) {
            return Outcome.NONE;
        }
        String completion = observation.completionReason().isBlank()
            ? observation.observedReason()
            : observation.completionReason();
        boolean craftTerminal = completion.startsWith("craft_stone_pickaxe_complete:")
            || completion.startsWith("craft_stone_pickaxe_failed:");
        if (!craftTerminal) {
            return Outcome.NONE;
        }
        boolean directCraft = "craft_stone_pickaxe".equals(observation.observedAction())
            && "mission:MINE_IRON".equals(observation.observedReason());
        boolean frozenRestock = observation.commandId().equals(observation.restockCommandId());
        boolean residentCraft = observation.commandId().equals(observation.residentCommandId())
            && "craft_stone_pickaxe".equals(observation.residentAction())
            && "mission:MINE_IRON".equals(observation.residentReason());
        if (!directCraft && !frozenRestock && !residentCraft && !observation.pendingPreparation()) {
            return Outcome.NONE;
        }
        if ("craft_stone_pickaxe_complete:mining_workspace_local_fallback_required".equals(completion)) {
            return Outcome.LOCAL_FALLBACK_HANDOFF;
        }
        return completion.startsWith("craft_stone_pickaxe_complete:")
            ? Outcome.SUCCEEDED
            : Outcome.FAILED;
    }

    private static String normalize(String value) {
        return value == null ? "" : value;
    }
}
