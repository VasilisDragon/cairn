package com.mcbot.fabricclient;

final class GatherTreeInventoryCompletionPolicy {
    enum Decision {
        CONTINUE,
        INVENTORY_SATISFIED,
        EXECUTOR_DEADLINE
    }

    private GatherTreeInventoryCompletionPolicy() {
    }

    static boolean isSatisfied(
        Integer requiredLogs,
        Integer requiredPlanks,
        int observedLogs,
        int observedPlanks
    ) {
        return (requiredLogs != null && requiredLogs > 0 && observedLogs >= requiredLogs)
            || (requiredPlanks != null && requiredPlanks > 0 && observedPlanks >= requiredPlanks);
    }

    static Decision decide(
        Integer requiredLogs,
        Integer requiredPlanks,
        int observedLogs,
        int observedPlanks,
        boolean executorDeadlineExpired
    ) {
        if (isSatisfied(requiredLogs, requiredPlanks, observedLogs, observedPlanks)) {
            return Decision.INVENTORY_SATISFIED;
        }
        return executorDeadlineExpired ? Decision.EXECUTOR_DEADLINE : Decision.CONTINUE;
    }
}
