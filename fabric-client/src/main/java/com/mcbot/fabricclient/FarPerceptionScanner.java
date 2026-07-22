package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.registry.entry.RegistryEntry;
import net.minecraft.registry.tag.BiomeTags;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.world.Heightmap;
import net.minecraft.world.biome.Biome;
import net.minecraft.world.chunk.ChunkSection;
import net.minecraft.world.chunk.WorldChunk;

/**
 * Incremental far-world resource perception over chunks the client already has loaded.
 *
 * <p>The scheduler is deliberately separate from snapshot serialization: every tick probes at most
 * {@code chunksPerTick} loaded chunks, while {@link #summary(double, double, int)} only reduces the
 * cache to a small wire payload. A probe miss still consumes budget, and no tick probes the same
 * coordinate twice.</p>
 */
final class FarPerceptionScanner {
    static final String WOOD_RESOURCE = "wood";
    // Per-chunk surface roughness (max-min heightmap spread over a 5-point sample): low = flat and
    // traversable, high = cliff/mountain. -1 = not measured (test observations, empty summaries).
    static final int ROUGHNESS_UNKNOWN = -1;
    static final int ROUGHNESS_MAX = 64;
    private static final int[][] DIRECTIONS = new int[][] {
        {1, 0}, {1, 1}, {0, 1}, {-1, 1},
        {-1, 0}, {-1, -1}, {0, -1}, {1, -1}
    };

    enum BiomeClass {
        WOOD_BEARING("wood_bearing"),
        BARREN("barren"),
        UNKNOWN("unknown");

        private final String wireName;

        BiomeClass(String wireName) {
            this.wireName = wireName;
        }

        String wireName() {
            return wireName;
        }
    }

    record ChunkKey(int x, int z) {
        int centerX() {
            return x * 16 + 8;
        }

        int centerZ() {
            return z * 16 + 8;
        }
    }

    record ChunkObservation(int logCount, BiomeClass biomeClass, int roughness) {
        ChunkObservation {
            logCount = Math.max(0, logCount);
            biomeClass = biomeClass == null ? BiomeClass.UNKNOWN : biomeClass;
            roughness = roughness < 0 ? ROUGHNESS_UNKNOWN : Math.min(roughness, ROUGHNESS_MAX);
        }

        ChunkObservation(int logCount, BiomeClass biomeClass) {
            this(logCount, biomeClass, ROUGHNESS_UNKNOWN);
        }
    }

    record CachedChunk(int logCount, BiomeClass biomeClass, int roughness, long lastScanTick) {}

    record ResourceTarget(int x, int z, int count, String biomeClass) {}

    record DirectionSummary(
        int dx,
        int dz,
        String biomeClass,
        int resourceCount,
        int woodBearingChunks,
        int barrenChunks,
        int scannedChunks,
        int avgRoughness
    ) {}

    record ResourceSummary(
        String resource,
        List<ResourceTarget> targets,
        List<DirectionSummary> directions
    ) {}

    record Summary(
        int loadedChunkCount,
        int scannedChunkCount,
        List<ResourceSummary> resources
    ) {
        static Summary empty() {
            return new Summary(0, 0, List.of(new ResourceSummary(WOOD_RESOURCE, List.of(), unknownDirections())));
        }
    }

    record TickStats(int attemptedChunks, int updatedChunks) {}

    record BiomeSignals(
        String path,
        boolean forest,
        boolean taiga,
        boolean jungle,
        boolean savanna,
        boolean ocean,
        boolean badlands
    ) {}

    @FunctionalInterface
    interface ChunkProbe {
        Optional<ChunkObservation> scan(ChunkKey key);
    }

    private final int chunksPerTick;
    private final ChunkProbe probe;
    private final List<ChunkKey> loadedOrder = new ArrayList<>();
    private final Set<ChunkKey> loaded = new HashSet<>();
    private final Map<ChunkKey, CachedChunk> cache = new HashMap<>();
    private int cursor = 0;

    FarPerceptionScanner(int chunksPerTick, ChunkProbe probe) {
        if (chunksPerTick < 1) {
            throw new IllegalArgumentException("chunksPerTick must be >= 1");
        }
        if (probe == null) {
            throw new IllegalArgumentException("probe is required");
        }
        this.chunksPerTick = chunksPerTick;
        this.probe = probe;
    }

    void onChunkLoaded(int chunkX, int chunkZ) {
        ChunkKey key = new ChunkKey(chunkX, chunkZ);
        cache.remove(key);
        if (loaded.add(key)) {
            loadedOrder.add(key);
        }
    }

    void onChunkUnloaded(int chunkX, int chunkZ) {
        ChunkKey key = new ChunkKey(chunkX, chunkZ);
        cache.remove(key);
        if (!loaded.remove(key)) {
            return;
        }
        int removedIndex = loadedOrder.indexOf(key);
        if (removedIndex >= 0) {
            loadedOrder.remove(removedIndex);
            if (removedIndex < cursor) {
                cursor -= 1;
            }
        }
        normalizeCursor();
    }

    void clear() {
        loadedOrder.clear();
        loaded.clear();
        cache.clear();
        cursor = 0;
    }

    TickStats tick(long tick) {
        int attempts = Math.min(chunksPerTick, loadedOrder.size());
        int updated = 0;
        for (int i = 0; i < attempts; i++) {
            normalizeCursor();
            ChunkKey key = loadedOrder.get(cursor);
            cursor = (cursor + 1) % loadedOrder.size();
            Optional<ChunkObservation> observation = probe.scan(key);
            if (observation.isPresent() && loaded.contains(key)) {
                ChunkObservation value = observation.get();
                cache.put(key, new CachedChunk(value.logCount(), value.biomeClass(), value.roughness(), tick));
                updated += 1;
            }
        }
        return new TickStats(attempts, updated);
    }

    Summary summary(double originX, double originZ, int maxTargets) {
        int targetLimit = Math.max(0, maxTargets);
        List<Map.Entry<ChunkKey, CachedChunk>> scanned = cache.entrySet().stream()
            .filter(entry -> loaded.contains(entry.getKey()))
            .toList();

        List<ResourceTarget> targets = scanned.stream()
            .filter(entry -> entry.getValue().logCount() > 0)
            .sorted(Comparator
                .comparingDouble((Map.Entry<ChunkKey, CachedChunk> entry) -> distanceSquared(entry.getKey(), originX, originZ))
                .thenComparing((left, right) -> Integer.compare(right.getValue().logCount(), left.getValue().logCount()))
                .thenComparingInt(entry -> entry.getKey().x())
                .thenComparingInt(entry -> entry.getKey().z()))
            .limit(targetLimit)
            .map(entry -> new ResourceTarget(
                entry.getKey().centerX(),
                entry.getKey().centerZ(),
                entry.getValue().logCount(),
                entry.getValue().biomeClass().wireName()
            ))
            .toList();

        DirectionAccumulator[] accumulators = new DirectionAccumulator[DIRECTIONS.length];
        for (int i = 0; i < accumulators.length; i++) {
            accumulators[i] = new DirectionAccumulator();
        }
        int originChunkX = Math.floorDiv((int) Math.floor(originX), 16);
        int originChunkZ = Math.floorDiv((int) Math.floor(originZ), 16);
        for (Map.Entry<ChunkKey, CachedChunk> entry : scanned) {
            ChunkKey key = entry.getKey();
            if (key.x() == originChunkX && key.z() == originChunkZ) {
                continue;
            }
            int directionIndex = directionIndex(key.centerX() - originX, key.centerZ() - originZ);
            accumulators[directionIndex].add(entry.getValue());
        }

        List<DirectionSummary> directions = new ArrayList<>(DIRECTIONS.length);
        for (int i = 0; i < DIRECTIONS.length; i++) {
            int[] direction = DIRECTIONS[i];
            directions.add(accumulators[i].summary(direction[0], direction[1]));
        }
        ResourceSummary wood = new ResourceSummary(WOOD_RESOURCE, targets, List.copyOf(directions));
        return new Summary(loadedOrder.size(), scanned.size(), List.of(wood));
    }

    int loadedChunkCount() {
        return loadedOrder.size();
    }

    int cachedChunkCount() {
        return cache.size();
    }

    Optional<CachedChunk> cached(ChunkKey key) {
        return Optional.ofNullable(cache.get(key));
    }

    static Optional<ChunkObservation> scanLoadedChunk(ClientWorld world, WorldChunk chunk) {
        if (world == null || chunk == null) {
            return Optional.empty();
        }
        int[] logCount = new int[] {0};
        for (ChunkSection section : chunk.getSectionArray()) {
            if (section == null || section.isEmpty() || !section.hasAny(FarPerceptionScanner::isLog)) {
                continue;
            }
            section.getBlockStateContainer().count((state, count) -> {
                if (isLog(state)) {
                    logCount[0] += count;
                }
            });
        }

        int centerX = chunk.getPos().getCenterX();
        int centerZ = chunk.getPos().getCenterZ();
        int surfaceY = world.getTopY(Heightmap.Type.WORLD_SURFACE, centerX, centerZ);
        int roughness = surfaceRoughness(world, chunk, surfaceY);
        RegistryEntry<Biome> biome = world.getBiome(chunk.getPos().getCenterAtY(surfaceY));
        String path = biome.getKey().map(key -> key.getValue().getPath()).orElse("");
        BiomeSignals signals = new BiomeSignals(
            path,
            biome.isIn(BiomeTags.IS_FOREST),
            biome.isIn(BiomeTags.IS_TAIGA),
            biome.isIn(BiomeTags.IS_JUNGLE),
            biome.isIn(BiomeTags.IS_SAVANNA),
            biome.isIn(BiomeTags.IS_OCEAN),
            biome.isIn(BiomeTags.IS_BADLANDS)
        );
        return Optional.of(new ChunkObservation(logCount[0], classifyBiome(signals), roughness));
    }

    // Surface roughness = the spread (max - min) of the WORLD_SURFACE heightmap over the chunk center
    // and its four corners. A flat plain reads ~0-2; a cliff/mountain face reads tens. Cheap: five
    // O(1) cached-heightmap lookups (the center one is already taken by the caller).
    private static int surfaceRoughness(ClientWorld world, WorldChunk chunk, int centerSurfaceY) {
        int baseX = chunk.getPos().getStartX();
        int baseZ = chunk.getPos().getStartZ();
        int min = centerSurfaceY;
        int max = centerSurfaceY;
        int[][] corners = {{baseX, baseZ}, {baseX + 15, baseZ}, {baseX, baseZ + 15}, {baseX + 15, baseZ + 15}};
        for (int[] corner : corners) {
            int y = world.getTopY(Heightmap.Type.WORLD_SURFACE, corner[0], corner[1]);
            min = Math.min(min, y);
            max = Math.max(max, y);
        }
        return Math.min(max - min, ROUGHNESS_MAX);
    }

    static BiomeClass classifyBiome(BiomeSignals signals) {
        if (signals == null) {
            return BiomeClass.UNKNOWN;
        }
        String path = signals.path() == null ? "" : signals.path().toLowerCase(Locale.ROOT);
        boolean pathSupportsWood = containsAny(path,
            "forest", "taiga", "jungle", "birch", "savanna", "swamp",
            "grove", "meadow", "wooded", "cherry")
            || (path.contains("plains") && !path.contains("snowy_plains"));
        if (signals.forest() || signals.taiga() || signals.jungle() || signals.savanna() || pathSupportsWood) {
            return BiomeClass.WOOD_BEARING;
        }
        boolean pathIsBarren = containsAny(path,
            "desert", "badlands", "ocean", "ice_spikes", "snowy_plains", "snowy_beach",
            "frozen_peaks", "jagged_peaks", "frozen_river");
        if (signals.ocean() || signals.badlands() || pathIsBarren) {
            return BiomeClass.BARREN;
        }
        return BiomeClass.UNKNOWN;
    }

    private static boolean isLog(BlockState state) {
        return state != null && state.isIn(BlockTags.LOGS);
    }

    private static boolean containsAny(String value, String... needles) {
        for (String needle : needles) {
            if (value.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    private static double distanceSquared(ChunkKey key, double originX, double originZ) {
        double dx = key.centerX() - originX;
        double dz = key.centerZ() - originZ;
        return dx * dx + dz * dz;
    }

    private static int directionIndex(double dx, double dz) {
        double octant = Math.atan2(dz, dx) / (Math.PI / 4.0D);
        return Math.floorMod((int) Math.round(octant), DIRECTIONS.length);
    }

    private static List<DirectionSummary> unknownDirections() {
        List<DirectionSummary> directions = new ArrayList<>(DIRECTIONS.length);
        for (int[] direction : DIRECTIONS) {
            directions.add(new DirectionSummary(direction[0], direction[1], "unknown", 0, 0, 0, 0, ROUGHNESS_UNKNOWN));
        }
        return List.copyOf(directions);
    }

    private void normalizeCursor() {
        if (loadedOrder.isEmpty()) {
            cursor = 0;
        } else if (cursor < 0 || cursor >= loadedOrder.size()) {
            cursor = 0;
        }
    }

    private static final class DirectionAccumulator {
        private int resourceCount;
        private int woodBearingChunks;
        private int barrenChunks;
        private int scannedChunks;
        private long roughnessSum;
        private int roughnessSamples;

        void add(CachedChunk chunk) {
            resourceCount += chunk.logCount();
            scannedChunks += 1;
            if (chunk.biomeClass() == BiomeClass.WOOD_BEARING) {
                woodBearingChunks += 1;
            } else if (chunk.biomeClass() == BiomeClass.BARREN) {
                barrenChunks += 1;
            }
            if (chunk.roughness() >= 0) {
                roughnessSum += chunk.roughness();
                roughnessSamples += 1;
            }
        }

        DirectionSummary summary(int dx, int dz) {
            String biomeClass;
            if (resourceCount > 0 || woodBearingChunks > 0) {
                biomeClass = BiomeClass.WOOD_BEARING.wireName();
            } else if (scannedChunks > 0 && barrenChunks == scannedChunks) {
                biomeClass = BiomeClass.BARREN.wireName();
            } else if (barrenChunks > 0) {
                biomeClass = "mixed";
            } else {
                biomeClass = BiomeClass.UNKNOWN.wireName();
            }
            int avgRoughness = roughnessSamples > 0
                ? (int) (roughnessSum / roughnessSamples)
                : ROUGHNESS_UNKNOWN;
            return new DirectionSummary(
                dx,
                dz,
                biomeClass,
                resourceCount,
                woodBearingChunks,
                barrenChunks,
                scannedChunks,
                avgRoughness
            );
        }
    }
}
