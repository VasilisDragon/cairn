package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class GazeSingleWriterSourceTest {
    private static final Pattern YAW_WRITE = Pattern.compile("\\.setYaw\\s*\\(");
    private static final Pattern PITCH_WRITE = Pattern.compile("\\.setPitch\\s*\\(");

    @Test
    void onlyFabricGazeAuthorityWritesPlayerCamera() throws IOException {
        Path sourceRoot = Path.of("src", "main", "java", "com", "mcbot", "fabricclient");
        List<Path> writers;
        try (var paths = Files.walk(sourceRoot)) {
            writers = paths
                .filter(path -> path.toString().endsWith(".java"))
                .filter(path -> {
                    try {
                        String source = Files.readString(path);
                        return YAW_WRITE.matcher(source).find()
                            || PITCH_WRITE.matcher(source).find();
                    } catch (IOException exception) {
                        throw new IllegalStateException(exception);
                    }
                })
                .sorted()
                .toList();
        }
        assertEquals(List.of(sourceRoot.resolve("FabricGazeAuthority.java")), writers);

        String authority = Files.readString(writers.get(0));
        assertEquals(1, occurrences(authority, YAW_WRITE));
        assertEquals(1, occurrences(authority, PITCH_WRITE));
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
