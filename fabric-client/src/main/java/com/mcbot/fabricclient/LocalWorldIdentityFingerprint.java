package com.mcbot.fabricclient;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;

/**
 * Establishes a stable local-world creation marker inside a verified save directory.
 *
 * <p>The marker survives ordinary {@code level.dat} replacement but is removed when the save is
 * deleted. Recreating the same folder therefore produces a different fingerprint. Persistence is
 * refused unless a real {@code level.dat} and a regular, non-symlink marker can both be verified.
 */
final class LocalWorldIdentityFingerprint {
    static final String MARKER_FILE = ".mcbot-world-identity-v1";
    private static final String MARKER_PREFIX = "mcbot-local-world-v1:";
    private static final int MAX_MARKER_CHARS = 192;

    private LocalWorldIdentityFingerprint() {
    }

    record Resolution(
        String canonicalSavePath,
        String creationFingerprint,
        boolean verified,
        String reason
    ) {
        Resolution {
            canonicalSavePath = canonicalSavePath == null ? "" : canonicalSavePath;
            creationFingerprint = creationFingerprint == null ? "" : creationFingerprint;
            reason = reason == null ? "" : reason;
        }
    }

    static Resolution resolve(Path saveRoot) {
        if (saveRoot == null) {
            return rejected("save_path_missing");
        }
        try {
            Path canonicalRoot = saveRoot.toRealPath(LinkOption.NOFOLLOW_LINKS).normalize();
            Path levelDat = canonicalRoot.resolve("level.dat");
            if (!Files.isRegularFile(levelDat, LinkOption.NOFOLLOW_LINKS)) {
                return rejected("level_dat_missing");
            }
            Path marker = canonicalRoot.resolve(MARKER_FILE);
            String markerValue = readMarker(marker);
            if (markerValue.isBlank()) {
                markerValue = createMarker(marker, levelDat);
            }
            if (!validMarker(markerValue)) {
                return rejected("creation_marker_invalid");
            }
            return new Resolution(
                canonicalRoot.toString(),
                sha256(markerValue),
                true,
                "verified_save_creation_marker"
            );
        } catch (IOException | SecurityException exception) {
            return rejected("save_identity_io_unavailable");
        }
    }

    private static String createMarker(Path marker, Path levelDat) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(
            levelDat,
            BasicFileAttributes.class,
            LinkOption.NOFOLLOW_LINKS
        );
        String fileKey = attributes.fileKey() == null ? "" : attributes.fileKey().toString();
        String creationEvidence = attributes.creationTime().toMillis()
            + ":" + attributes.size() + ":" + fileKey;
        String value = MARKER_PREFIX + UUID.randomUUID() + ":" + sha256(creationEvidence);
        try {
            Files.writeString(
                marker,
                value,
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE
            );
            return value;
        } catch (FileAlreadyExistsException raced) {
            return readMarker(marker);
        }
    }

    private static String readMarker(Path marker) throws IOException {
        if (!Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
            return "";
        }
        if (!Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS)
            || Files.isSymbolicLink(marker)) {
            return "";
        }
        String value = Files.readString(marker, StandardCharsets.UTF_8).trim();
        return value.length() <= MAX_MARKER_CHARS ? value : "";
    }

    private static boolean validMarker(String value) {
        if (value == null || !value.startsWith(MARKER_PREFIX) || value.length() > MAX_MARKER_CHARS) {
            return false;
        }
        String[] parts = value.substring(MARKER_PREFIX.length()).split(":", -1);
        if (parts.length != 2 || parts[1].length() != 64) {
            return false;
        }
        try {
            UUID.fromString(parts[0]);
        } catch (IllegalArgumentException invalid) {
            return false;
        }
        return parts[1].chars().allMatch(character ->
            character >= '0' && character <= '9' || character >= 'a' && character <= 'f');
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static Resolution rejected(String reason) {
        return new Resolution("", "", false, reason);
    }
}
