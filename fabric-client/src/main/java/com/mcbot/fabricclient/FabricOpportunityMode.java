package com.mcbot.fabricclient;

import java.util.Locale;

/** Controls the provider-free, physically passive opportunity observation seam. */
enum FabricOpportunityMode {
    OFF,
    SHADOW,
    ACTIVE;

    record Resolution(FabricOpportunityMode mode, boolean rejected, String configuredValue) {
    }

    static Resolution resolve(String configured) {
        String normalized = configured == null ? "" : configured.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "", "off" -> new Resolution(OFF, false, normalized);
            case "shadow" -> new Resolution(SHADOW, false, normalized);
            case "active" -> new Resolution(ACTIVE, false, normalized);
            default -> new Resolution(OFF, true, normalized);
        };
    }

    boolean observes() {
        return this == SHADOW || this == ACTIVE;
    }

    boolean executes() {
        return this == ACTIVE;
    }

    String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }
}
