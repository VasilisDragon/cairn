package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

final class FarPerceptionScannerTest {
    @Test
    void tickRespectsBudgetAndRoundRobinsLoadedChunks() {
        List<FarPerceptionScanner.ChunkKey> calls = new ArrayList<>();
        FarPerceptionScanner scanner = new FarPerceptionScanner(2, key -> {
            calls.add(key);
            return Optional.of(new FarPerceptionScanner.ChunkObservation(key.x() + 1, FarPerceptionScanner.BiomeClass.UNKNOWN));
        });
        for (int x = 0; x < 5; x++) {
            scanner.onChunkLoaded(x, 0);
        }

        assertEquals(new FarPerceptionScanner.TickStats(2, 2), scanner.tick(10));
        assertEquals(List.of(key(0), key(1)), List.copyOf(calls));
        assertEquals(2, scanner.cachedChunkCount());

        calls.clear();
        assertEquals(new FarPerceptionScanner.TickStats(2, 2), scanner.tick(11));
        assertEquals(List.of(key(2), key(3)), List.copyOf(calls));
        assertEquals(4, scanner.cachedChunkCount());

        calls.clear();
        assertEquals(new FarPerceptionScanner.TickStats(2, 2), scanner.tick(12));
        assertEquals(List.of(key(4), key(0)), List.copyOf(calls));
        assertEquals(5, scanner.cachedChunkCount());
        assertEquals(12, scanner.cached(key(0)).orElseThrow().lastScanTick());
    }

    @Test
    void emptyProbeResultStillConsumesBudgetAndChunkIsNotRetriedInSameTick() {
        List<FarPerceptionScanner.ChunkKey> calls = new ArrayList<>();
        FarPerceptionScanner scanner = new FarPerceptionScanner(5, key -> {
            calls.add(key);
            return key.x() == 0
                ? Optional.empty()
                : Optional.of(new FarPerceptionScanner.ChunkObservation(0, FarPerceptionScanner.BiomeClass.BARREN));
        });
        scanner.onChunkLoaded(0, 0);
        scanner.onChunkLoaded(1, 0);

        assertEquals(new FarPerceptionScanner.TickStats(2, 1), scanner.tick(20));
        assertEquals(List.of(key(0), key(1)), calls);
        assertEquals(1, scanner.cachedChunkCount());
    }

    @Test
    void loadReplacementAndUnloadInvalidateCache() {
        Map<FarPerceptionScanner.ChunkKey, FarPerceptionScanner.ChunkObservation> observations = new HashMap<>();
        List<FarPerceptionScanner.ChunkKey> calls = new ArrayList<>();
        FarPerceptionScanner scanner = new FarPerceptionScanner(1, key -> {
            calls.add(key);
            return Optional.ofNullable(observations.get(key));
        });
        FarPerceptionScanner.ChunkKey target = key(3);
        observations.put(target, new FarPerceptionScanner.ChunkObservation(7, FarPerceptionScanner.BiomeClass.WOOD_BEARING));

        scanner.onChunkLoaded(3, 0);
        scanner.tick(1);
        assertEquals(7, scanner.cached(target).orElseThrow().logCount());

        observations.put(target, new FarPerceptionScanner.ChunkObservation(0, FarPerceptionScanner.BiomeClass.BARREN));
        scanner.onChunkLoaded(3, 0);
        assertEquals(1, scanner.loadedChunkCount(), "replacement load must not duplicate the queue entry");
        assertTrue(scanner.cached(target).isEmpty(), "replacement load must invalidate stale cache");
        scanner.tick(2);
        assertEquals(0, scanner.cached(target).orElseThrow().logCount());

        scanner.onChunkUnloaded(3, 0);
        assertEquals(0, scanner.loadedChunkCount());
        assertTrue(scanner.cached(target).isEmpty());
        calls.clear();
        assertEquals(new FarPerceptionScanner.TickStats(0, 0), scanner.tick(3));
        assertTrue(calls.isEmpty(), "unloaded chunks must never be probed");

        scanner.onChunkLoaded(3, 0);
        scanner.tick(4);
        assertEquals(4, scanner.cached(target).orElseThrow().lastScanTick());
    }

    @Test
    void clearDropsLoadedAndCachedWorldState() {
        FarPerceptionScanner scanner = new FarPerceptionScanner(1, key -> Optional.of(
            new FarPerceptionScanner.ChunkObservation(2, FarPerceptionScanner.BiomeClass.WOOD_BEARING)
        ));
        scanner.onChunkLoaded(1, 2);
        scanner.tick(8);

        scanner.clear();

        assertEquals(0, scanner.loadedChunkCount());
        assertEquals(0, scanner.cachedChunkCount());
        assertEquals(FarPerceptionScanner.Summary.empty(), scanner.summary(0, 0, 4));
    }

    @Test
    void biomeClassificationProtectsWoodBiomesBeforeBarrenRules() {
        assertBiome(FarPerceptionScanner.BiomeClass.WOOD_BEARING, signals("forest", true, false, false, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.WOOD_BEARING, signals("birch_forest", false, false, false, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.WOOD_BEARING, signals("snowy_taiga", false, true, false, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.WOOD_BEARING, signals("sparse_jungle", false, false, true, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.WOOD_BEARING, signals("sunflower_plains", false, false, false, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.WOOD_BEARING, signals("savanna_plateau", false, false, false, true, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.WOOD_BEARING, signals("wooded_badlands", false, false, false, false, false, true));

        assertBiome(FarPerceptionScanner.BiomeClass.BARREN, signals("desert", false, false, false, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.BARREN, signals("badlands", false, false, false, false, false, true));
        assertBiome(FarPerceptionScanner.BiomeClass.BARREN, signals("frozen_ocean", false, false, false, false, true, false));
        assertBiome(FarPerceptionScanner.BiomeClass.BARREN, signals("snowy_plains", false, false, false, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.BARREN, signals("ice_spikes", false, false, false, false, false, false));

        assertBiome(FarPerceptionScanner.BiomeClass.UNKNOWN, signals("river", false, false, false, false, false, false));
        assertBiome(FarPerceptionScanner.BiomeClass.UNKNOWN, signals("custom_biome", false, false, false, false, false, false));
    }

    @Test
    void summaryIsCompactAndKeepsRawCacheMetadataPrivate() {
        Map<FarPerceptionScanner.ChunkKey, FarPerceptionScanner.ChunkObservation> observations = new HashMap<>();
        FarPerceptionScanner scanner = new FarPerceptionScanner(8, key -> Optional.ofNullable(observations.get(key)));
        for (int x = 1; x <= 6; x++) {
            FarPerceptionScanner.ChunkKey key = new FarPerceptionScanner.ChunkKey(x, 0);
            scanner.onChunkLoaded(key.x(), key.z());
            observations.put(key, new FarPerceptionScanner.ChunkObservation(x, FarPerceptionScanner.BiomeClass.WOOD_BEARING));
        }
        scanner.tick(42);

        FarPerceptionScanner.Summary summary = scanner.summary(0, 0, 4);
        FarPerceptionScanner.ResourceSummary wood = summary.resources().getFirst();
        assertEquals(FarPerceptionScanner.WOOD_RESOURCE, wood.resource());
        assertEquals(4, wood.targets().size());
        assertEquals(8, wood.directions().size());
        assertEquals(6, summary.loadedChunkCount());
        assertEquals(6, summary.scannedChunkCount());
        assertFalse(wood.targets().stream().anyMatch(target -> target.count() <= 0));
    }

    @Test
    void directionSummaryAveragesMeasuredRoughnessAndIgnoresUnmeasured() {
        Map<FarPerceptionScanner.ChunkKey, FarPerceptionScanner.ChunkObservation> observations = new HashMap<>();
        FarPerceptionScanner scanner = new FarPerceptionScanner(8, key -> Optional.ofNullable(observations.get(key)));
        // +x direction: three chunks, roughness 10 / 20 / unmeasured(-1) -> avg of the two measured = 15.
        int[] roughness = {10, 20, FarPerceptionScanner.ROUGHNESS_UNKNOWN};
        for (int x = 1; x <= 3; x++) {
            FarPerceptionScanner.ChunkKey key = new FarPerceptionScanner.ChunkKey(x, 0);
            scanner.onChunkLoaded(key.x(), key.z());
            observations.put(key, new FarPerceptionScanner.ChunkObservation(
                1, FarPerceptionScanner.BiomeClass.WOOD_BEARING, roughness[x - 1]));
        }
        scanner.tick(1);

        FarPerceptionScanner.Summary summary = scanner.summary(0, 0, 4);
        FarPerceptionScanner.DirectionSummary east = summary.resources().getFirst().directions().stream()
            .filter(d -> d.dx() == 1 && d.dz() == 0)
            .findFirst()
            .orElseThrow();
        assertEquals(15, east.avgRoughness());

        // an unscanned direction reports the -1 sentinel, not 0 (0 would falsely read as "perfectly flat").
        FarPerceptionScanner.DirectionSummary west = summary.resources().getFirst().directions().stream()
            .filter(d -> d.dx() == -1 && d.dz() == 0)
            .findFirst()
            .orElseThrow();
        assertEquals(FarPerceptionScanner.ROUGHNESS_UNKNOWN, west.avgRoughness());
    }

    private static FarPerceptionScanner.ChunkKey key(int x) {
        return new FarPerceptionScanner.ChunkKey(x, 0);
    }

    private static FarPerceptionScanner.BiomeSignals signals(
        String path,
        boolean forest,
        boolean taiga,
        boolean jungle,
        boolean savanna,
        boolean ocean,
        boolean badlands
    ) {
        return new FarPerceptionScanner.BiomeSignals(path, forest, taiga, jungle, savanna, ocean, badlands);
    }

    private static void assertBiome(FarPerceptionScanner.BiomeClass expected, FarPerceptionScanner.BiomeSignals signals) {
        assertEquals(expected, FarPerceptionScanner.classifyBiome(signals));
    }
}
