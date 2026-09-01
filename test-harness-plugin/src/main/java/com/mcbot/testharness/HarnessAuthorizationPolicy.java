package com.mcbot.testharness;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

final class HarnessAuthorizationPolicy {
    static final String PLAYER_PERMISSION = "mcbottest.use";

    private HarnessAuthorizationPolicy() {
    }

    static UuidAllowlist parseAllowedUuids(List<?> configuredValues) {
        if (configuredValues == null || configuredValues.isEmpty()) {
            return new UuidAllowlist(Set.of(), true);
        }

        Set<UUID> parsed = new HashSet<>();
        for (Object configuredValue : configuredValues) {
            if (!(configuredValue instanceof String stringValue)) {
                return new UuidAllowlist(Set.of(), false);
            }
            String value = stringValue.trim();
            try {
                UUID uuid = UUID.fromString(value);
                if (!uuid.toString().equalsIgnoreCase(value)) {
                    return new UuidAllowlist(Set.of(), false);
                }
                parsed.add(uuid);
            } catch (IllegalArgumentException error) {
                return new UuidAllowlist(Set.of(), false);
            }
        }
        return new UuidAllowlist(parsed, true);
    }

    static SafetyCheck authorizePlayer(
        boolean onlineMode,
        boolean hasExplicitPermission,
        UUID playerUuid,
        UuidAllowlist allowlist
    ) {
        if (!onlineMode) {
            return SafetyCheck.refused("player commands require online-mode=true");
        }
        if (allowlist == null || !allowlist.valid()) {
            return SafetyCheck.refused("player UUID allowlist is invalid");
        }
        if (allowlist.uuids().isEmpty()) {
            return SafetyCheck.refused("player UUID allowlist is empty");
        }
        if (!hasExplicitPermission) {
            return SafetyCheck.refused("sender lacks " + PLAYER_PERMISSION);
        }
        if (playerUuid == null || !allowlist.uuids().contains(playerUuid)) {
            return SafetyCheck.refused("sender UUID is not allowlisted");
        }
        return SafetyCheck.ok();
    }

    record UuidAllowlist(Set<UUID> uuids, boolean valid) {
        UuidAllowlist {
            uuids = Set.copyOf(uuids == null ? Set.of() : uuids);
        }
    }
}
