package com.mcbot.fabricclient;

/**
 * Holds an authoritative mission-stone inventory completion while the player returns to the
 * verified shaft frontier. Inventory satisfaction is sticky for one command, but it is not a
 * command completion receipt until the existing shaft traversal verifies its destination.
 */
final class MissionStoneFrontierCompletionState {
    enum Decision {
        CONTINUE,
        COMPLETE_NOW,
        RETURN_TO_FRONTIER
    }

    record Evaluation(Decision decision, boolean newlyLatched) {
        Evaluation {
            decision = decision == null ? Decision.CONTINUE : decision;
        }
    }

    private Object world;
    private String commandId = "";
    private boolean pending;

    Evaluation observe(
        Object currentWorld,
        String currentCommandId,
        boolean inventorySatisfied,
        boolean shaftActive,
        boolean atVerifiedFrontier
    ) {
        synchronize(currentWorld, currentCommandId);
        if (!inventorySatisfied) {
            return new Evaluation(Decision.CONTINUE, false);
        }
        if (pending) {
            if (!shaftActive) {
                pending = false;
                return new Evaluation(Decision.COMPLETE_NOW, false);
            }
            // Physical arrival alone is insufficient. The traversal coordinator must validate the
            // landing and atomically restore the canonical prefix before releasing completion.
            return new Evaluation(Decision.RETURN_TO_FRONTIER, false);
        }
        if (shaftActive && !atVerifiedFrontier) {
            pending = true;
            return new Evaluation(Decision.RETURN_TO_FRONTIER, true);
        }
        return new Evaluation(Decision.COMPLETE_NOW, false);
    }

    boolean pendingFor(Object currentWorld, String currentCommandId) {
        return pending
            && world == currentWorld
            && commandId.equals(normalize(currentCommandId));
    }

    boolean releaseAtVerifiedFrontier(
        Object currentWorld,
        String currentCommandId,
        boolean verifiedFrontier
    ) {
        if (!verifiedFrontier || !pendingFor(currentWorld, currentCommandId)) {
            return false;
        }
        pending = false;
        return true;
    }

    void clear() {
        world = null;
        commandId = "";
        pending = false;
    }

    private void synchronize(Object currentWorld, String currentCommandId) {
        String normalizedCommandId = normalize(currentCommandId);
        if (world == currentWorld && commandId.equals(normalizedCommandId)) {
            return;
        }
        world = currentWorld;
        commandId = normalizedCommandId;
        pending = false;
    }

    private static String normalize(String value) {
        return value == null ? "" : value;
    }
}
