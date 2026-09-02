package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class LiveEvidenceShutdownSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void harnessStopRequestCapturesTerminalStateBeforeSchedulingShutdown() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String tick = section(source, "private void onClientTick(", "// The command the client has been executing");
        String request = section(
            source,
            "private boolean maybeHonorLiveEvidenceStopRequest(",
            "private double edgeGuardYaw("
        );
        String lifecycle = section(
            source,
            "ClientLifecycleEvents.CLIENT_STOPPING.register",
            "// Observability cockpit"
        );

        assertTrue(source.contains("MCBOT_FABRIC_STOP_REQUEST_PATH"));
        assertTrue(tick.indexOf("logLiveEvidenceWorldState(client, \"initial\")")
            < tick.indexOf("maybeHonorLiveEvidenceStopRequest(client)"));
        assertTrue(request.contains("Files.isRegularFile(LIVE_EVIDENCE_STOP_REQUEST_PATH)"));
        assertTrue(request.indexOf("logLiveEvidenceTerminalState(client)")
            < request.indexOf("client.scheduleStop()"));
        assertTrue(lifecycle.contains("logLiveEvidenceTerminalState(client)"));
        assertTrue(source.contains("if (liveEvidenceTerminalStateLogged)"));
    }

    private static String section(String source, String startToken, String endToken) {
        int start = source.indexOf(startToken);
        int end = source.indexOf(endToken, start);
        assertTrue(start >= 0, "missing start token: " + startToken);
        assertTrue(end > start, "missing end token: " + endToken);
        return source.substring(start, end);
    }
}
