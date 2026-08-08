package com.mcbot.fabricclient;

/**
 * Freezes the absolute cobblestone postcondition for one mission-owned stone command.
 *
 * <p>The requirement is deliberately independent of command-local inventory deltas. A repeated
 * brain poll cannot move the target, and an invalid or absent target leaves historical non-mission
 * {@code mine_nearby_stone} behavior untouched.</p>
 */
final class MissionStoneInventoryCompletionPolicy {
    record Requirement(Integer requiredCobblestone) {
        boolean enabled() {
            return requiredCobblestone != null;
        }
    }

    private Object worldIdentity;
    private String commandId = "";
    private Requirement requirement = new Requirement(null);

    Requirement freeze(Object nextWorldIdentity, String nextCommandId, Integer requiredCobblestone) {
        String normalizedCommandId = nextCommandId == null ? "" : nextCommandId;
        if (worldIdentity != nextWorldIdentity || !commandId.equals(normalizedCommandId)) {
            worldIdentity = nextWorldIdentity;
            commandId = normalizedCommandId;
            requirement = new Requirement(positiveOrNull(requiredCobblestone));
        }
        return requirement;
    }

    void clear() {
        worldIdentity = null;
        commandId = "";
        requirement = new Requirement(null);
    }

    static boolean isSatisfied(Requirement requirement, int authoritativeCobblestone) {
        return requirement != null
            && requirement.enabled()
            && authoritativeCobblestone >= requirement.requiredCobblestone();
    }

    private static Integer positiveOrNull(Integer value) {
        return value != null && value > 0 ? value : null;
    }
}
