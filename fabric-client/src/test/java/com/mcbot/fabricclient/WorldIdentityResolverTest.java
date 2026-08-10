package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

final class WorldIdentityResolverTest {
    @Test
    void explicitRemoteIdentityIsOpaqueStableAndPersistenceEligible() {
        WorldIdentityResolver.Resolution first = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            "world-139-production",
            "",
            "play.example.test:25565",
            "session-a"
        ));
        WorldIdentityResolver.Resolution second = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            "world-139-production",
            "",
            "different.example.test:25565",
            "session-b"
        ));

        assertTrue(first.resolved());
        assertTrue(first.persistent());
        assertEquals(WorldIdentityResolver.Source.EXPLICIT_CONFIG, first.source());
        assertEquals(WorldIdentityResolver.PersistenceEligibility.PERSISTENT, first.persistenceEligibility());
        assertEquals(first.opaqueWorldId(), second.opaqueWorldId());
        assertFalse(first.opaqueWorldId().contains("world-139-production"));
        assertFalse(first.opaqueWorldId().contains("example"));
    }

    @Test
    void remoteEndpointIsNeverGuessedAsWorldIdentity() {
        WorldIdentityResolver.Resolution firstSession = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            "",
            "local-save-must-be-ignored",
            "same.example.test:25565",
            "session-a"
        ));
        WorldIdentityResolver.Resolution secondSession = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            null,
            "local-save-must-be-ignored",
            "same.example.test:25565",
            "session-b"
        ));

        assertTrue(firstSession.resolved());
        assertFalse(firstSession.persistent());
        assertEquals(WorldIdentityResolver.Source.SESSION, firstSession.source());
        assertEquals(
            WorldIdentityResolver.PersistenceEligibility.SESSION_ONLY,
            firstSession.persistenceEligibility()
        );
        assertEquals("remote_config_absent_session_only", firstSession.reason());
        assertNotEquals(firstSession.opaqueWorldId(), secondSession.opaqueWorldId());
    }

    @Test
    void changingOnlyTheRemoteEndpointCannotChangeASessionIdentity() {
        WorldIdentityResolver.Resolution first = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            "",
            "",
            "one.example.test",
            "one-process-session"
        ));
        WorldIdentityResolver.Resolution second = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            "",
            "",
            "two.example.test",
            "one-process-session"
        ));

        assertEquals(first.opaqueWorldId(), second.opaqueWorldId());
    }

    @Test
    void verifiedLocalSaveIdentityAllowsPersistenceWithoutConfiguration() {
        WorldIdentityResolver.Resolution resolution = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.LOCAL_SINGLEPLAYER,
            "",
            "saves/World 139/level.dat:fingerprint",
            "",
            "session"
        ));

        assertTrue(resolution.persistent());
        assertEquals(WorldIdentityResolver.Source.LOCAL_SAVE, resolution.source());
        assertEquals("verified_local_world_fingerprint", resolution.reason());
        assertFalse(resolution.opaqueWorldId().contains("World 139"));
    }

    @Test
    void explicitConfigurationWinsOverLocalSaveIdentity() {
        WorldIdentityResolver.Resolution resolution = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.LOCAL_SINGLEPLAYER,
            "explicit-world",
            "local-save",
            "",
            "session"
        ));

        assertEquals(WorldIdentityResolver.Source.EXPLICIT_CONFIG, resolution.source());
    }

    @Test
    void localFolderPathWithoutCreationFingerprintCannotAuthorizePersistence() {
        WorldIdentityResolver.Resolution resolution = WorldIdentityResolver.resolve(
            new WorldIdentityResolver.Request(
                WorldIdentityResolver.ConnectionKind.LOCAL_SINGLEPLAYER,
                "",
                "C:/saves/World 139",
                "",
                "",
                "session"
            ));

        assertFalse(resolution.persistent());
        assertEquals(WorldIdentityResolver.Source.SESSION, resolution.source());
    }

    @Test
    void recreatedWorldFingerprintChangesIdentityEvenAtTheSameCanonicalPath() {
        WorldIdentityResolver.Resolution first = WorldIdentityResolver.resolve(
            new WorldIdentityResolver.Request(
                WorldIdentityResolver.ConnectionKind.LOCAL_SINGLEPLAYER,
                "",
                "C:/saves/World 139",
                "creation-a",
                "",
                "session-a"
            ));
        WorldIdentityResolver.Resolution recreated = WorldIdentityResolver.resolve(
            new WorldIdentityResolver.Request(
                WorldIdentityResolver.ConnectionKind.LOCAL_SINGLEPLAYER,
                "",
                "C:/saves/World 139",
                "creation-b",
                "",
                "session-b"
            ));

        assertTrue(first.persistent());
        assertTrue(recreated.persistent());
        assertNotEquals(first.opaqueWorldId(), recreated.opaqueWorldId());
    }

    @Test
    void invalidRemoteConfigurationFallsBackOnlyToSessionScope() {
        WorldIdentityResolver.Resolution resolution = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            "bad\nidentity",
            "",
            "server.example.test",
            "session"
        ));

        assertTrue(resolution.resolved());
        assertFalse(resolution.persistent());
        assertEquals(WorldIdentityResolver.Source.SESSION, resolution.source());
        assertEquals("remote_config_invalid_session_only", resolution.reason());
    }

    @Test
    void environmentOverloadReadsOnlyTheExactConfigurationKey() {
        WorldIdentityResolver.Request base = request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            "ignored-request-value",
            "",
            "server.example.test",
            "session"
        );
        WorldIdentityResolver.Resolution configured = WorldIdentityResolver.resolve(
            base, Map.of(WorldIdentityResolver.CONFIG_ENV, "env-world"));
        WorldIdentityResolver.Resolution wrongKey = WorldIdentityResolver.resolve(
            base, Map.of("MCBOT_WORLD", "env-world"));

        assertTrue(configured.persistent());
        assertEquals(WorldIdentityResolver.Source.EXPLICIT_CONFIG, configured.source());
        assertFalse(wrongKey.persistent());
        assertEquals(WorldIdentityResolver.Source.SESSION, wrongKey.source());
    }

    @Test
    void missingPersistentAndSessionIdentityFailsClosedWithoutAGuess() {
        WorldIdentityResolver.Resolution resolution = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.UNKNOWN,
            "",
            "",
            "tempting.example.test",
            ""
        ));

        assertFalse(resolution.resolved());
        assertFalse(resolution.persistent());
        assertEquals("", resolution.opaqueWorldId());
        assertEquals(WorldIdentityResolver.Source.UNRESOLVED, resolution.source());
        assertEquals(WorldIdentityResolver.PersistenceEligibility.UNAVAILABLE, resolution.persistenceEligibility());
    }

    @Test
    void overlongConfigurationIsInvalidAndCannotAuthorizePersistence() {
        String overlong = "x".repeat(WorldIdentityResolver.MAX_SOURCE_ID_CHARS + 1);
        WorldIdentityResolver.Resolution resolution = WorldIdentityResolver.resolve(request(
            WorldIdentityResolver.ConnectionKind.REMOTE_SERVER,
            overlong,
            "",
            "server.example.test",
            "session"
        ));

        assertFalse(resolution.persistent());
        assertEquals(WorldIdentityResolver.Source.SESSION, resolution.source());
    }

    private WorldIdentityResolver.Request request(
        WorldIdentityResolver.ConnectionKind kind,
        String configured,
        String local,
        String endpoint,
        String session
    ) {
        return new WorldIdentityResolver.Request(
            kind,
            configured,
            local.isBlank() ? "" : "C:/verified/" + local,
            local.isBlank() ? "" : local,
            endpoint,
            session
        );
    }
}
