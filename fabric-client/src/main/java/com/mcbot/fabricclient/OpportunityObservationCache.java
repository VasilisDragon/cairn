package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.util.math.BlockPos;

/**
 * Bounded, world-instance-scoped cache for observations produced by client lifecycle events.
 *
 * <p>The cache has no Minecraft world access. Chunk classification and live-entity sampling happen
 * in {@link OpportunityObservationCollector}; this class only enforces retention, isolation, and
 * deterministic snapshot bounds.
 */
final class OpportunityObservationCache {
    static final int MAX_CACHED_CHUNKS = 128;
    static final int MAX_CACHED_BLOCK_OBSERVATIONS = 8_192;
    static final int MAX_CACHED_ENTITY_OBSERVATIONS = OpportunityScanner.MAX_ENTITY_OBSERVATIONS;

    record ChunkKey(int x, int z) {
    }

    record CacheStats(
        long worldRevision,
        long geometryRevision,
        int loadedChunks,
        int cachedBlockObservations,
        int cachedEntityObservations,
        int chunkEvictions,
        int duplicateChunkLoads,
        int chunkRefreshes,
        int changedChunkRefreshes
    ) {
    }

    record PutResult(boolean stored, boolean duplicate, int evictedChunks, int retainedBlocks) {
    }

    record RefreshResult(
        boolean stored,
        boolean changed,
        int evictedChunks,
        int retainedBlocks,
        long geometryRevision
    ) {
    }

    private final LinkedHashMap<ChunkKey, OpportunityScanner.ChunkObservation> chunks =
        new LinkedHashMap<>();
    private List<OpportunityScanner.EntityObservation> entities = List.of();
    private Object worldToken;
    private long worldRevision;
    private long geometryRevision;
    private int cachedBlockCount;
    private int chunkEvictions;
    private int duplicateChunkLoads;
    private int chunkRefreshes;
    private int changedChunkRefreshes;

    boolean ensureWorld(Object candidateWorldToken) {
        if (candidateWorldToken == null) {
            return false;
        }
        if (worldToken == candidateWorldToken) {
            return true;
        }
        clearInternal();
        worldToken = candidateWorldToken;
        worldRevision += 1L;
        return true;
    }

    boolean containsChunk(Object candidateWorldToken, int chunkX, int chunkZ) {
        return worldToken == candidateWorldToken && chunks.containsKey(new ChunkKey(chunkX, chunkZ));
    }

    PutResult putChunk(
        Object candidateWorldToken,
        OpportunityScanner.ChunkObservation observation
    ) {
        if (observation == null || !ensureWorld(candidateWorldToken)) {
            return new PutResult(false, false, 0, 0);
        }
        ChunkKey key = new ChunkKey(observation.chunkX(), observation.chunkZ());
        OpportunityScanner.ChunkObservation present = chunks.get(key);
        if (present != null) {
            duplicateChunkLoads += 1;
            return new PutResult(false, true, 0, present.blocks().size());
        }

        OpportunityScanner.ChunkObservation normalized = normalizeChunk(observation);
        chunks.put(key, normalized);
        cachedBlockCount += normalized.blocks().size();
        int before = chunkEvictions;
        enforceChunkBounds();
        return new PutResult(
            chunks.containsKey(key),
            false,
            chunkEvictions - before,
            chunks.containsKey(key) ? normalized.blocks().size() : 0
        );
    }

    RefreshResult refreshChunk(
        Object candidateWorldToken,
        OpportunityScanner.ChunkObservation observation
    ) {
        if (observation == null || !ensureWorld(candidateWorldToken)) {
            return new RefreshResult(false, false, 0, 0, geometryRevision);
        }
        OpportunityScanner.ChunkObservation normalized = normalizeChunk(observation);
        ChunkKey key = new ChunkKey(normalized.chunkX(), normalized.chunkZ());
        OpportunityScanner.ChunkObservation previous = chunks.get(key);
        chunkRefreshes += 1;
        if (normalized.equals(previous)) {
            return new RefreshResult(true, false, 0, normalized.blocks().size(), geometryRevision);
        }
        if (previous != null) {
            cachedBlockCount -= previous.blocks().size();
        }
        chunks.put(key, normalized);
        cachedBlockCount += normalized.blocks().size();
        geometryRevision += 1L;
        changedChunkRefreshes += 1;
        int before = chunkEvictions;
        enforceChunkBounds();
        return new RefreshResult(
            chunks.containsKey(key),
            true,
            chunkEvictions - before,
            chunks.containsKey(key) ? normalized.blocks().size() : 0,
            geometryRevision
        );
    }

    boolean removeChunk(Object candidateWorldToken, int chunkX, int chunkZ) {
        if (worldToken != candidateWorldToken) {
            return false;
        }
        OpportunityScanner.ChunkObservation removed = chunks.remove(new ChunkKey(chunkX, chunkZ));
        if (removed == null) {
            return false;
        }
        cachedBlockCount -= removed.blocks().size();
        return true;
    }

    void replaceEntities(
        Object candidateWorldToken,
        List<OpportunityScanner.EntityObservation> observations
    ) {
        if (!ensureWorld(candidateWorldToken)) {
            return;
        }
        if (observations == null || observations.isEmpty()) {
            entities = List.of();
            return;
        }
        entities = observations.stream()
            .filter(observation -> observation != null
                && observation.position() != null
                && !observation.stableEntityId().isBlank())
            .sorted(Comparator
                .comparing(OpportunityScanner.EntityObservation::stableEntityId)
                .thenComparing(OpportunityScanner.EntityObservation::position,
                    OpportunityObservationCache::comparePosition))
            .limit(MAX_CACHED_ENTITY_OBSERVATIONS)
            .toList();
    }

    OpportunityScanner.ScanResult scan(
        Object candidateWorldToken,
        String worldIdentity,
        String dimensionIdentity,
        BlockPos origin,
        long observedAtMs
    ) {
        if (worldToken != candidateWorldToken) {
            return OpportunityScanner.scan(new OpportunityScanner.ScanRequest(
                worldIdentity,
                dimensionIdentity,
                origin,
                observedAtMs,
                List.of(),
                List.of()
            ));
        }
        return OpportunityScanner.scan(new OpportunityScanner.ScanRequest(
            worldIdentity,
            dimensionIdentity,
            origin,
            observedAtMs,
            List.copyOf(chunks.values()),
            entities
        ));
    }

    CacheStats stats() {
        return new CacheStats(
            worldRevision,
            geometryRevision,
            chunks.size(),
            cachedBlockCount,
            entities.size(),
            chunkEvictions,
            duplicateChunkLoads,
            chunkRefreshes,
            changedChunkRefreshes
        );
    }

    void clear() {
        clearInternal();
        worldToken = null;
        worldRevision += 1L;
    }

    private OpportunityScanner.ChunkObservation normalizeChunk(
        OpportunityScanner.ChunkObservation observation
    ) {
        List<OpportunityScanner.BlockObservation> blocks = observation.blocks().stream()
            .filter(block -> block != null && block.position() != null)
            .filter(block -> Math.floorDiv(block.position().getX(), 16) == observation.chunkX()
                && Math.floorDiv(block.position().getZ(), 16) == observation.chunkZ())
            .sorted(Comparator
                .comparingInt((OpportunityScanner.BlockObservation block) ->
                    block.kind().ordinal())
                .thenComparing(OpportunityScanner.BlockObservation::position,
                    OpportunityObservationCache::comparePosition)
                .thenComparing(OpportunityScanner.BlockObservation::detail))
            .limit(OpportunityScanner.MAX_BLOCKS_PER_CHUNK)
            .toList();
        return new OpportunityScanner.ChunkObservation(
            observation.chunkX(), observation.chunkZ(), blocks);
    }

    private void enforceChunkBounds() {
        while (chunks.size() > MAX_CACHED_CHUNKS
            || cachedBlockCount > MAX_CACHED_BLOCK_OBSERVATIONS) {
            Map.Entry<ChunkKey, OpportunityScanner.ChunkObservation> oldest =
                chunks.entrySet().iterator().next();
            chunks.remove(oldest.getKey());
            cachedBlockCount -= oldest.getValue().blocks().size();
            chunkEvictions += 1;
        }
    }

    private void clearInternal() {
        chunks.clear();
        entities = List.of();
        cachedBlockCount = 0;
        chunkEvictions = 0;
        duplicateChunkLoads = 0;
        geometryRevision = 0L;
        chunkRefreshes = 0;
        changedChunkRefreshes = 0;
    }

    private static int comparePosition(BlockPos left, BlockPos right) {
        int y = Integer.compare(left.getY(), right.getY());
        if (y != 0) {
            return y;
        }
        int z = Integer.compare(left.getZ(), right.getZ());
        return z != 0 ? z : Integer.compare(left.getX(), right.getX());
    }
}
