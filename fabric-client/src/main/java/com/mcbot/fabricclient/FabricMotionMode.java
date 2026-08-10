package com.mcbot.fabricclient;

import java.util.Locale;

enum FabricMotionMode {
    LEGACY,
    SHADOW,
    SMOOTH;

    record Resolution(FabricMotionMode mode, boolean rejected, String configuredValue) {
    }

    static Resolution resolve(String configured) {
        String normalized = configured == null ? "" : configured.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "" -> new Resolution(SMOOTH, false, normalized);
            case "legacy" -> new Resolution(LEGACY, false, normalized);
            case "shadow" -> new Resolution(SHADOW, false, normalized);
            case "smooth" -> new Resolution(SMOOTH, false, normalized);
            default -> new Resolution(LEGACY, true, normalized);
        };
    }

    String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }
}
