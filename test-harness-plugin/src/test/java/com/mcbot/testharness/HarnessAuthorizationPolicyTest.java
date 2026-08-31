package com.mcbot.testharness;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class HarnessAuthorizationPolicyTest {
    private static final UUID ALLOWED = UUID.fromString("01234567-89ab-cdef-0123-456789abcdef");
    private static final UUID OTHER = UUID.fromString("fedcba98-7654-3210-fedc-ba9876543210");

    @Test
    void exactUuidPermissionAndOnlineModeAreAllRequired() {
        HarnessAuthorizationPolicy.UuidAllowlist allowlist = HarnessAuthorizationPolicy.parseAllowedUuids(
            List.of(ALLOWED.toString())
        );

        assertTrue(HarnessAuthorizationPolicy.authorizePlayer(true, true, ALLOWED, allowlist).isAllowed());
        assertEquals(
            "player commands require online-mode=true",
            HarnessAuthorizationPolicy.authorizePlayer(false, true, ALLOWED, allowlist).reason()
        );
        assertEquals(
            "sender lacks mcbottest.use",
            HarnessAuthorizationPolicy.authorizePlayer(true, false, ALLOWED, allowlist).reason()
        );
        assertEquals(
            "sender UUID is not allowlisted",
            HarnessAuthorizationPolicy.authorizePlayer(true, true, OTHER, allowlist).reason()
        );
    }

    @Test
    void emptyAllowlistFailsClosed() {
        HarnessAuthorizationPolicy.UuidAllowlist allowlist = HarnessAuthorizationPolicy.parseAllowedUuids(List.of());

        assertTrue(allowlist.valid());
        assertTrue(allowlist.uuids().isEmpty());
        assertEquals(
            "player UUID allowlist is empty",
            HarnessAuthorizationPolicy.authorizePlayer(true, true, ALLOWED, allowlist).reason()
        );
    }

    @Test
    void oneInvalidEntryInvalidatesTheWholeAllowlist() {
        HarnessAuthorizationPolicy.UuidAllowlist allowlist = HarnessAuthorizationPolicy.parseAllowedUuids(
            List.of(ALLOWED.toString(), "not-a-uuid")
        );

        assertFalse(allowlist.valid());
        assertTrue(allowlist.uuids().isEmpty());
        assertEquals(
            "player UUID allowlist is invalid",
            HarnessAuthorizationPolicy.authorizePlayer(true, true, ALLOWED, allowlist).reason()
        );
    }

    @Test
    void nonCanonicalAndBlankUuidEntriesFailClosed() {
        HarnessAuthorizationPolicy.UuidAllowlist shortened = HarnessAuthorizationPolicy.parseAllowedUuids(
            List.of("1-1-1-1-1")
        );
        HarnessAuthorizationPolicy.UuidAllowlist blank = HarnessAuthorizationPolicy.parseAllowedUuids(List.of(" "));

        assertFalse(shortened.valid());
        assertFalse(blank.valid());
        assertFalse(HarnessAuthorizationPolicy.parseAllowedUuids(List.of(123)).valid());
    }

    @Test
    void configuredUuidSetIsImmutableAndDeduplicated() {
        HarnessAuthorizationPolicy.UuidAllowlist allowlist = HarnessAuthorizationPolicy.parseAllowedUuids(
            List.of(ALLOWED.toString(), ALLOWED.toString().toUpperCase())
        );

        assertTrue(allowlist.valid());
        assertEquals(1, allowlist.uuids().size());
    }
}
