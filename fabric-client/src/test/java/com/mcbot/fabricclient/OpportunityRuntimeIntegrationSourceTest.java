package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

final class OpportunityRuntimeIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void shadowKeepsTheFarScannerAliveWhenExploreIsDisabled() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String initialization = section(source, "public void onInitializeClient()", "private void onFarPerceptionChunkLoaded(");
        String tick = section(source, "private void onClientTick(", "// The command the client has been executing");

        assertTrue(initialization.contains("if (EXPLORE_ENABLED || opportunityMode.observes())"));
        assertTrue(initialization.contains("ClientChunkEvents.CHUNK_LOAD.register"));
        assertTrue(initialization.contains("ClientChunkEvents.CHUNK_UNLOAD.register"));
        assertTrue(initialization.contains("ClientEntityEvents.ENTITY_LOAD.register"));
        assertTrue(initialization.contains("ClientEntityEvents.ENTITY_UNLOAD.register"));
        assertTrue(tick.contains("if (EXPLORE_ENABLED || opportunityMode.observes())"));
        assertTrue(tick.contains("tickFarPerception(client.world, player, nowMs)"));
    }

    @Test
    void chunkEventsOnlyScheduleAndClassificationRunsInsideTheThrottledProbe() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String load = section(source, "private void onFarPerceptionChunkLoaded(", "private void onFarPerceptionChunkUnloaded(");
        String probe = section(source, "private Optional<FarPerceptionScanner.ChunkObservation> scanFarPerceptionChunk(", "private void tickFarPerception(");

        assertTrue(load.contains("farPerceptionScanner.onChunkLoaded"));
        assertFalse(load.contains("opportunityObservationCollector.onChunkLoaded"));
        assertFalse(load.contains("classifyChunk"));
        assertTrue(probe.contains("opportunityObservationCollector.onChunkScanned("));
        assertTrue(probe.contains("FarPerceptionScanner.scanLoadedChunk(world, chunk)"));
        assertTrue(source.contains("opportunityScanOrigin = opportunityMode.observes()"));
        assertTrue(source.contains("finally {\n            opportunityScanOrigin = null;"));
    }

    @Test
    void snapshotFactoryOnlySerializesTheBoundedCachedReduction() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String dispatch = section(source, "if (brainDispatchCandidate) {", "brainLink.poll(snapshotJson, nowMs);");
        String factory = section(source, "static ClientSnapshot from(", "return new ClientSnapshot(");
        String record = section(source, "private record ClientSnapshot(", "private static boolean hasNearbyBlock(");

        assertTrue(dispatch.contains("refreshOpportunitySnapshot("));
        assertTrue(dispatch.indexOf("WorldIdentityResolver.Resolution worldIdentity")
            < dispatch.indexOf("refreshOpportunitySnapshot("));
        assertTrue(dispatch.indexOf("String snapshotDimension")
            < dispatch.indexOf("refreshOpportunitySnapshot("));
        assertFalse(factory.contains("classifyChunk"));
        assertFalse(factory.contains("OpportunityScanner.scan"));
        assertFalse(factory.contains("refreshOpportunitySnapshot"));
        assertFalse(factory.contains("getWorldChunk"));
        assertTrue(record.contains("List<Map<String, Object>> opportunityDiscoveries"));
        assertTrue(record.contains("long opportunityScannerRevision"));
        assertTrue(record.contains("int opportunityDiscoveryCount"));
        assertTrue(record.contains("boolean opportunityDiscoveriesTruncated"));
        assertTrue(source.contains("private static final int OPPORTUNITY_WIRE_DISCOVERY_LIMIT = 32"));
        assertTrue(source.contains(".limit(OPPORTUNITY_WIRE_DISCOVERY_LIMIT)"));
    }

    @Test
    void lifecycleClearsCachedOpportunityState() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String worldChange = section(source, "private void ensureFarPerceptionWorld(", "private void clearPerceptionWorld(");
        String stop = section(source, "ClientLifecycleEvents.CLIENT_STOPPING.register", "// Observability cockpit");

        assertTrue(worldChange.contains("opportunityObservationCollector.clear()"));
        assertTrue(stop.contains("clearPerceptionWorld()"));
        assertTrue(source.contains("opportunity.mode_rejected"));
        assertTrue(source.contains("fallback=off"));
    }

    @Test
    void scannerRevisionFingerprintIgnoresObservationTimestampsButNotSemanticChanges() {
        OpportunityObservationCollector.WireDiscovery first = wire(4, 1_000L);
        OpportunityObservationCollector.WireDiscovery later = wire(4, 9_000L);
        OpportunityObservationCollector.WireDiscovery moved = wire(5, 9_000L);

        McbotFabricClient.OpportunitySnapshotFingerprint initial =
            McbotFabricClient.opportunityFingerprint(
                "world", "minecraft:overworld", List.of(first), 1, false);
        McbotFabricClient.OpportunitySnapshotFingerprint timestampOnly =
            McbotFabricClient.opportunityFingerprint(
                "world", "minecraft:overworld", List.of(later), 1, false);
        McbotFabricClient.OpportunitySnapshotFingerprint semanticChange =
            McbotFabricClient.opportunityFingerprint(
                "world", "minecraft:overworld", List.of(moved), 1, false);

        assertEquals(initial, timestampOnly);
        assertNotEquals(initial, semanticChange);
    }

    private static OpportunityObservationCollector.WireDiscovery wire(int x, long observedAtMs) {
        return new OpportunityObservationCollector.WireDiscovery(
            "hay:one",
            "hay",
            x,
            64,
            7,
            1,
            0.9D,
            List.of("minecraft:hay_block"),
            observedAtMs
        );
    }

    private static String section(String source, String startToken, String endToken) {
        int start = source.indexOf(startToken);
        int end = source.indexOf(endToken, start + startToken.length());
        assertTrue(start >= 0, "missing start token " + startToken);
        assertTrue(end > start, "missing end token " + endToken);
        return source.substring(start, end);
    }
}
