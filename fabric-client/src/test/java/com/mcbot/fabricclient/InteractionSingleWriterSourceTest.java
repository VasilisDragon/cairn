package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class InteractionSingleWriterSourceTest {
    private static final Pattern INTERACTION_WRITE = Pattern.compile(
        "\\.interactionManager\\.(?:updateBlockBreakingProgress|cancelBlockBreaking|"
            + "attackBlock|attackEntity|interactBlock|interactItem|clickSlot)\\s*\\("
    );
    private static final Pattern SWING_WRITE = Pattern.compile(
        "\\bplayer\\.swingHand\\s*\\("
    );
    private static final Pattern ATTACK_KEY_WRITE = Pattern.compile(
        "\\.attackKey\\.setPressed\\s*\\("
    );
    private static final Pattern USE_KEY_WRITE = Pattern.compile(
        "\\.useKey\\.setPressed\\s*\\("
    );
    private static final Pattern BREAK_PROGRESS_WRITE = Pattern.compile(
        "\\.updateBlockBreakingProgress\\s*\\("
    );
    private static final Pattern FORBIDDEN_ATTACK_BLOCK = Pattern.compile(
        "\\.attackBlock\\s*\\("
    );
    private static final Pattern SLOT_WRITE = Pattern.compile(
        "\\.clickSlot\\s*\\("
    );

    @Test
    void onlyFabricInteractionAuthorityWritesPhysicalInteractionState() throws IOException {
        Path sourceRoot = Path.of("src", "main", "java", "com", "mcbot", "fabricclient");
        List<Path> writers;
        try (var paths = Files.walk(sourceRoot)) {
            writers = paths
                .filter(path -> path.toString().endsWith(".java"))
                .filter(path -> {
                    try {
                        String source = Files.readString(path);
                        return INTERACTION_WRITE.matcher(source).find()
                            || SWING_WRITE.matcher(source).find()
                            || ATTACK_KEY_WRITE.matcher(source).find()
                            || USE_KEY_WRITE.matcher(source).find();
                    } catch (IOException exception) {
                        throw new IllegalStateException(exception);
                    }
                })
                .sorted()
                .toList();
        }

        Path authority = sourceRoot.resolve("FabricInteractionAuthority.java");
        assertEquals(List.of(authority), writers);

        String source = Files.readString(authority);
        assertEquals(1, occurrences(source, BREAK_PROGRESS_WRITE));
        assertEquals(0, occurrences(source, FORBIDDEN_ATTACK_BLOCK));
        assertEquals(1, occurrences(source, ATTACK_KEY_WRITE));
        assertEquals(1, occurrences(source, USE_KEY_WRITE));
        assertEquals(2, occurrences(source, SLOT_WRITE));
        assertTrue(source.contains(".cancelBlockBreaking("));
        assertTrue(source.contains(".attackEntity("));
        assertTrue(source.contains(".interactBlock("));
        assertTrue(source.contains(".interactItem("));
        assertTrue(source.contains(".swingHand("));
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
