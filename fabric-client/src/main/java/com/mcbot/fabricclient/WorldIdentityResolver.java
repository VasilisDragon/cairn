package com.mcbot.fabricclient;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;

/**
 * Pure fail-closed world identity policy for persistent opportunity memory.
 *
 * <p>A remote endpoint is deliberately never an identity source: servers can reset worlds without
 * changing address. Remote persistence therefore requires an explicit {@value #CONFIG_ENV} value.
 * Otherwise a caller-supplied process/session identity creates an isolated session-only key.
 */
final class WorldIdentityResolver {
    static final String CONFIG_ENV = "MCBOT_WORLD_ID";
    static final int MAX_SOURCE_ID_CHARS = 256;
    static final int MAX_LOCAL_PATH_CHARS = 4_096;

    private WorldIdentityResolver() {
    }

    enum ConnectionKind {
        LOCAL_SINGLEPLAYER,
        REMOTE_SERVER,
        UNKNOWN
    }

    enum Source {
        EXPLICIT_CONFIG,
        LOCAL_SAVE,
        SESSION,
        UNRESOLVED
    }

    enum PersistenceEligibility {
        PERSISTENT,
        SESSION_ONLY,
        UNAVAILABLE
    }

    record Request(
        ConnectionKind connectionKind,
        String configuredWorldId,
        String verifiedLocalSavePath,
        String verifiedLocalWorldFingerprint,
        String remoteEndpoint,
        String sessionIdentity
    ) {
        Request {
            connectionKind = connectionKind == null ? ConnectionKind.UNKNOWN : connectionKind;
        }
    }

    record Resolution(
        String opaqueWorldId,
        Source source,
        PersistenceEligibility persistenceEligibility,
        boolean resolved,
        String reason
    ) {
        Resolution {
            opaqueWorldId = opaqueWorldId == null ? "" : opaqueWorldId;
            source = source == null ? Source.UNRESOLVED : source;
            persistenceEligibility = persistenceEligibility == null
                ? PersistenceEligibility.UNAVAILABLE
                : persistenceEligibility;
            reason = reason == null ? "" : reason;
        }

        boolean persistent() {
            return resolved && persistenceEligibility == PersistenceEligibility.PERSISTENT;
        }
    }

    static Resolution resolve(Request request) {
        if (request == null) {
            return unresolved("missing_request");
        }

        String configured = validatedSourceId(request.configuredWorldId());
        boolean configuredSupplied = request.configuredWorldId() != null
            && !request.configuredWorldId().isBlank();
        if (!configured.isBlank()) {
            return persistent(Source.EXPLICIT_CONFIG, "explicit", configured, "configured_world_id");
        }

        if (request.connectionKind() == ConnectionKind.LOCAL_SINGLEPLAYER) {
            String localPath = validatedLocalPath(request.verifiedLocalSavePath());
            String localFingerprint = validatedSourceId(request.verifiedLocalWorldFingerprint());
            if (!localPath.isBlank() && !localFingerprint.isBlank()) {
                return persistent(
                    Source.LOCAL_SAVE,
                    "local-save",
                    localPath + '\0' + localFingerprint,
                    configuredSupplied
                        ? "invalid_config_local_world_fingerprint"
                        : "verified_local_world_fingerprint"
                );
            }
        }

        String session = validatedSourceId(request.sessionIdentity());
        if (!session.isBlank()) {
            String reason;
            if (request.connectionKind() == ConnectionKind.REMOTE_SERVER) {
                reason = configuredSupplied
                    ? "remote_config_invalid_session_only"
                    : "remote_config_absent_session_only";
            } else if (configuredSupplied) {
                reason = "configured_id_invalid_session_only";
            } else {
                reason = "persistent_identity_unavailable_session_only";
            }
            return new Resolution(
                opaque("session", session),
                Source.SESSION,
                PersistenceEligibility.SESSION_ONLY,
                true,
                reason
            );
        }
        return unresolved(configuredSupplied
            ? "configured_id_invalid_and_session_missing"
            : "session_identity_missing");
    }

    static Resolution resolve(Request request, Map<String, String> environment) {
        if (request == null) {
            return unresolved("missing_request");
        }
        String configured = environment == null ? null : environment.get(CONFIG_ENV);
        return resolve(new Request(
            request.connectionKind(),
            configured,
            request.verifiedLocalSavePath(),
            request.verifiedLocalWorldFingerprint(),
            request.remoteEndpoint(),
            request.sessionIdentity()
        ));
    }

    private static Resolution persistent(Source source, String domain, String sourceId, String reason) {
        return new Resolution(
            opaque(domain, sourceId),
            source,
            PersistenceEligibility.PERSISTENT,
            true,
            reason
        );
    }

    private static Resolution unresolved(String reason) {
        return new Resolution(
            "",
            Source.UNRESOLVED,
            PersistenceEligibility.UNAVAILABLE,
            false,
            reason
        );
    }

    private static String validatedSourceId(String value) {
        return validatedText(value, MAX_SOURCE_ID_CHARS);
    }

    private static String validatedLocalPath(String value) {
        return validatedText(value, MAX_LOCAL_PATH_CHARS);
    }

    private static String validatedText(String value, int maxChars) {
        if (value == null) {
            return "";
        }
        String normalized = value.trim();
        if (normalized.isEmpty() || normalized.length() > maxChars) {
            return "";
        }
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (Character.isISOControl(character)) {
                return "";
            }
        }
        return normalized;
    }

    private static String opaque(String domain, String sourceId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(
                ("mcbot-world-v1\u0000" + domain + "\u0000" + sourceId).getBytes(StandardCharsets.UTF_8));
            return "world-v1-" + HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
