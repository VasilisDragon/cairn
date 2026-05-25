package com.mcbot.testharness;

record SafetyCheck(boolean isAllowed, String reason) {
    static SafetyCheck ok() {
        return new SafetyCheck(true, "");
    }

    static SafetyCheck refused(String reason) {
        return new SafetyCheck(false, reason);
    }
}
