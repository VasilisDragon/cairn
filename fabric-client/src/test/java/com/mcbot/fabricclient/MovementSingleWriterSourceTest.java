package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class MovementSingleWriterSourceTest {
    private static final Pattern INPUT_WRITE = Pattern.compile(
        "\\.(?:pressingForward|pressingBack|pressingLeft|pressingRight|jumping|sneaking|"
            + "movementForward|movementSideways)\\s*=(?!=)"
    );
    private static final Pattern SPRINT_WRITE =
        Pattern.compile("\\.sprintKey\\.setPressed\\s*\\(");
    private static final Pattern ENTITY_SNEAK_WRITE =
        Pattern.compile("\\.setSneaking\\s*\\(");

    @Test
    void onlyFabricMovementAuthorityWritesPlayerMovementAndSprint() throws IOException {
        Path sourceRoot = Path.of("src", "main", "java", "com", "mcbot", "fabricclient");
        List<Path> writers;
        try (var paths = Files.walk(sourceRoot)) {
            writers = paths
                .filter(path -> path.toString().endsWith(".java"))
                .filter(path -> {
                    try {
                        String source = Files.readString(path);
                        return INPUT_WRITE.matcher(source).find()
                            || SPRINT_WRITE.matcher(source).find()
                            || ENTITY_SNEAK_WRITE.matcher(source).find();
                    } catch (IOException exception) {
                        throw new IllegalStateException(exception);
                    }
                })
                .sorted()
                .toList();
        }

        Path authority = sourceRoot.resolve("FabricMovementAuthority.java");
        assertEquals(List.of(authority), writers);

        String source = Files.readString(authority);
        assertEquals(8, occurrences(source, INPUT_WRITE));
        assertEquals(1, occurrences(source, SPRINT_WRITE));
        assertEquals(1, occurrences(source, ENTITY_SNEAK_WRITE));
    }

    @Test
    void globalGuardsInspectTheSideEffectFreeAuthorityPreview() throws IOException {
        String source = Files.readString(
            Path.of(
                "src",
                "main",
                "java",
                "com",
                "mcbot",
                "fabricclient",
                "McbotFabricClient.java"
            )
        );
        int preview = source.indexOf("movementAuthority.previewInput(");
        int edgeGuard = source.indexOf("edgeGuardBlocksForward(", preview);
        int commit = source.indexOf("movementAuthority.commit(", preview);

        assertTrue(preview >= 0);
        assertTrue(edgeGuard > preview);
        assertTrue(commit > edgeGuard);
        assertTrue(source.contains("String routeTravelReason = effective.reason()"));
    }

    private static int occurrences(String value, Pattern pattern) {
        int count = 0;
        var matcher = pattern.matcher(value);
        while (matcher.find()) {
            count++;
        }
        return count;
    }
}
