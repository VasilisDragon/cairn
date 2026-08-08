package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class LocalWorldIdentityFingerprintTest {
    @TempDir
    Path temp;

    @Test
    void markerIsStableAcrossLevelDatReplacement() throws IOException {
        Path save = createSave("World 139", "first-level");
        LocalWorldIdentityFingerprint.Resolution first =
            LocalWorldIdentityFingerprint.resolve(save);

        Files.writeString(save.resolve("level.dat"), "ordinary-save-replacement");
        LocalWorldIdentityFingerprint.Resolution later =
            LocalWorldIdentityFingerprint.resolve(save);

        assertTrue(first.verified());
        assertEquals(first.canonicalSavePath(), later.canonicalSavePath());
        assertEquals(first.creationFingerprint(), later.creationFingerprint());
        assertTrue(Files.isRegularFile(save.resolve(LocalWorldIdentityFingerprint.MARKER_FILE)));
    }

    @Test
    void deletingAndRecreatingTheSameSaveFolderCannotReuseIdentity() throws IOException {
        Path save = createSave("replace-me", "old-world");
        LocalWorldIdentityFingerprint.Resolution oldWorld =
            LocalWorldIdentityFingerprint.resolve(save);

        try (var paths = Files.walk(save)) {
            for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.delete(path);
            }
        }
        save = createSave("replace-me", "new-world");
        LocalWorldIdentityFingerprint.Resolution newWorld =
            LocalWorldIdentityFingerprint.resolve(save);

        assertTrue(oldWorld.verified());
        assertTrue(newWorld.verified());
        assertEquals(oldWorld.canonicalSavePath(), newWorld.canonicalSavePath());
        assertNotEquals(oldWorld.creationFingerprint(), newWorld.creationFingerprint());
    }

    @Test
    void missingLevelDatOrInvalidMarkerFailsClosed() throws IOException {
        Path missing = Files.createDirectories(temp.resolve("missing"));
        assertFalse(LocalWorldIdentityFingerprint.resolve(missing).verified());

        Path invalid = createSave("invalid", "world");
        Files.writeString(
            invalid.resolve(LocalWorldIdentityFingerprint.MARKER_FILE),
            "not-a-valid-creation-marker"
        );
        LocalWorldIdentityFingerprint.Resolution result =
            LocalWorldIdentityFingerprint.resolve(invalid);
        assertFalse(result.verified());
        assertEquals("creation_marker_invalid", result.reason());
    }

    private Path createSave(String name, String levelContents) throws IOException {
        Path save = Files.createDirectories(temp.resolve(name));
        Files.writeString(save.resolve("level.dat"), levelContents);
        return save;
    }
}
