package com.mcbot.fabricclient;

final class GatherTreeInventoryRequirementLatch {
    record Requirement(Integer requiredLogs, Integer requiredPlanks) {
        boolean enabled() {
            return requiredLogs != null || requiredPlanks != null;
        }
    }

    private Object worldIdentity;
    private String commandId = "";
    private Requirement requirement = new Requirement(null, null);

    Requirement freeze(
        Object worldIdentity,
        String commandId,
        Integer requiredLogs,
        Integer requiredPlanks
    ) {
        String normalizedCommandId = commandId == null ? "" : commandId;
        if (this.worldIdentity != worldIdentity || !this.commandId.equals(normalizedCommandId)) {
            this.worldIdentity = worldIdentity;
            this.commandId = normalizedCommandId;
            requirement = new Requirement(positiveOrNull(requiredLogs), positiveOrNull(requiredPlanks));
        }
        return requirement;
    }

    void clear() {
        worldIdentity = null;
        commandId = "";
        requirement = new Requirement(null, null);
    }

    private static Integer positiveOrNull(Integer value) {
        return value != null && value > 0 ? value : null;
    }
}
