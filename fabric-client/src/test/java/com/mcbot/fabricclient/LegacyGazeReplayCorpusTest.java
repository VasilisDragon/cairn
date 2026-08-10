package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class LegacyGazeReplayCorpusTest {
    private static final double EPSILON = 1.0E-5D;
    private static final double LEGACY_NORMAL_MAX_STEP = 9.0D;

    @Test
    void recordedLegacyOutputsReplayThroughTheCentralAdapter() throws IOException {
        JsonObject corpus = JsonParser.parseString(
            Files.readString(
                Path.of("src", "test", "resources", "motion", "gaze-legacy-replay.json")
            )
        ).getAsJsonObject();
        assertEquals(1, corpus.get("schemaVersion").getAsInt());

        int samples = 0;
        for (JsonElement traceElement : corpus.getAsJsonArray("traces")) {
            JsonObject trace = traceElement.getAsJsonObject();
            String traceName = trace.get("name").getAsString();
            for (JsonElement sampleElement : trace.getAsJsonArray("samples")) {
                JsonObject sample = sampleElement.getAsJsonObject();
                JsonObject desired = sample.getAsJsonObject("desired");
                JsonObject recorded = sample.getAsJsonObject("legacyOutput");
                double desiredYaw = desired.get("yaw").getAsDouble();
                double desiredPitch = desired.get("pitch").getAsDouble();
                double outputYaw = recorded.get("yaw").getAsDouble();
                double outputPitch = recorded.get("pitch").getAsDouble();
                InferredStart start = inferStart(
                    desiredYaw,
                    desiredPitch,
                    outputYaw,
                    outputPitch
                );
                LookDemand.Profile profile = LookDemand.Profile.valueOf(
                    sample.get("profile").getAsString()
                );
                LookDemand demand = new LookDemand(
                    LookDemand.Owner.valueOf(sample.get("owner").getAsString()),
                    sample.get("targetIdentity").getAsString(),
                    profile,
                    desiredYaw,
                    desiredPitch,
                    profile == LookDemand.Profile.PRECISION
                        ? LookDemand.RetargetPolicy.COMMITTED
                        : LookDemand.RetargetPolicy.CONTINUOUS,
                    sample.get("command").getAsString(),
                    reasonFor(traceName)
                );

                FabricGazeAuthority.LegacyOutput replay = FabricGazeAuthority.legacyStep(
                    FabricGazeAuthority.LegacyState.initial(),
                    start.yaw(),
                    start.pitch(),
                    demand,
                    1_000L
                );

                assertEquals(
                    0.0D,
                    LookController.shortestYawDelta(outputYaw, replay.yaw()),
                    EPSILON,
                    traceName
                );
                assertEquals(outputPitch, replay.pitch(), EPSILON, traceName);
                samples++;
            }
        }
        assertTrue(samples >= 16);
    }

    private static InferredStart inferStart(
        double desiredYaw,
        double desiredPitch,
        double outputYaw,
        double outputPitch
    ) {
        double remainingYaw = LookController.shortestYawDelta(outputYaw, desiredYaw);
        double remainingPitch = desiredPitch - outputPitch;
        double remaining = Math.hypot(remainingYaw, remainingPitch);
        if (remaining == 0.0D) {
            return new InferredStart(outputYaw, outputPitch);
        }
        double low = remaining;
        double high = remaining + 720.0D;
        for (int iteration = 0; iteration < 100; iteration++) {
            double middle = (low + high) / 2.0D;
            double remainder = middle - legacyStepMagnitude(middle);
            if (remainder < remaining) {
                low = middle;
            } else {
                high = middle;
            }
        }
        double initialMagnitude = (low + high) / 2.0D;
        double yawUnit = remainingYaw / remaining;
        double pitchUnit = remainingPitch / remaining;
        return new InferredStart(
            LookController.normalizeYaw(desiredYaw - yawUnit * initialMagnitude),
            desiredPitch - pitchUnit * initialMagnitude
        );
    }

    private static double legacyStepMagnitude(double magnitude) {
        double cap = Math.min(
            LEGACY_NORMAL_MAX_STEP * 1.8D,
            Math.max(LEGACY_NORMAL_MAX_STEP, magnitude * 0.18D)
        );
        double proportional = magnitude * LookController.DEFAULT_EASE_GAIN;
        double bounded = Math.max(
            LookController.DEFAULT_MIN_DEG_PER_TICK,
            Math.min(cap, proportional)
        );
        return Math.min(magnitude, bounded);
    }

    private static String reasonFor(String traceName) {
        return switch (traceName) {
            case "fixed_block" -> "aim_block";
            case "moving_drop" -> "track_drop";
            default -> "travel";
        };
    }

    private record InferredStart(double yaw, double pitch) {
    }
}
