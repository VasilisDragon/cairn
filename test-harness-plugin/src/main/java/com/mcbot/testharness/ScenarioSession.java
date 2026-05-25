package com.mcbot.testharness;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

final class ScenarioSession {
    private final String token;
    private final String scenarioId;
    private final File telemetryFile;
    private final TelemetryWriter writer;

    private ScenarioSession(String token, String scenarioId, File telemetryFile, TelemetryWriter writer) {
        this.token = token;
        this.scenarioId = scenarioId;
        this.telemetryFile = telemetryFile;
        this.writer = writer;
    }

    static ScenarioSession open(String token, String scenarioId, File telemetryFile) throws IOException {
        BufferedWriter bufferedWriter = new BufferedWriter(new FileWriter(telemetryFile, false));
        return new ScenarioSession(token, scenarioId, telemetryFile, new TelemetryWriter(bufferedWriter));
    }

    void writeEvent(String event, Map<String, Object> fields) throws IOException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("event", event);
        payload.put("token", token);
        payload.put("scenarioId", scenarioId);
        payload.put("timeIso", Instant.now().toString());
        payload.put("timeMs", System.currentTimeMillis());
        payload.putAll(fields);
        writer.write(payload);
    }

    void close(String reason) throws IOException {
        writer.close(reason);
    }

    String token() {
        return token;
    }

    String telemetryPath() {
        return telemetryFile.getAbsolutePath();
    }
}
