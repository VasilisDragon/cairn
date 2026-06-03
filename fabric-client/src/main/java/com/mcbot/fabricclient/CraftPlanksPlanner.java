package com.mcbot.fabricclient;

final class CraftPlanksPlanner {
    private CraftPlanksPlanner() {
    }

    static boolean isComplete(int logsBefore, int logsAfter, int planksBefore, int planksAfter) {
        return logsBefore - logsAfter >= 1 && planksAfter - planksBefore >= 4;
    }

    static boolean canStart(int logsBefore) {
        return logsBefore >= 1;
    }
}
