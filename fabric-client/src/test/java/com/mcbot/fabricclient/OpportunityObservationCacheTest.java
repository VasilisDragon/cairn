package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class OpportunityObservationCacheTest {
    @Test
    void duplicateLoadDoesNotReplaceOrReclassifyCachedChunk() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object world = new Object();
        OpportunityScanner.ChunkObservation original = chunk(0, 0, 2);
        OpportunityScanner.ChunkObservation replacement = chunk(0, 0, 5);

        OpportunityObservationCache.PutResult first = cache.putChunk(world, original);
        OpportunityObservationCache.PutResult duplicate = cache.putChunk(world, replacement);

        assertTrue(first.stored());
        assertFalse(first.duplicate());
        assertFalse(duplicate.stored());
        assertTrue(duplicate.duplicate());
        assertEquals(2, duplicate.retainedBlocks());
        assertEquals(1, cache.stats().loadedChunks());
        assertEquals(2, cache.stats().cachedBlockObservations());
        assertEquals(1, cache.stats().duplicateChunkLoads());
    }

    @Test
    void throttledRefreshAtomicallyReplacesChangedGeometryAndVersionsOnlyChanges() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object world = new Object();
        OpportunityScanner.ChunkObservation original = chunk(0, 0, 3);
        OpportunityScanner.ChunkObservation harvested = chunk(0, 0, 0);

        OpportunityObservationCache.RefreshResult first = cache.refreshChunk(world, original);
        OpportunityObservationCache.RefreshResult unchanged = cache.refreshChunk(world, original);
        OpportunityObservationCache.RefreshResult changed = cache.refreshChunk(world, harvested);

        assertTrue(first.stored());
        assertTrue(first.changed());
        assertFalse(unchanged.changed());
        assertTrue(changed.changed());
        assertEquals(first.geometryRevision(), unchanged.geometryRevision());
        assertEquals(first.geometryRevision() + 1L, changed.geometryRevision());
        assertEquals(0, cache.stats().cachedBlockObservations());
        assertEquals(3, cache.stats().chunkRefreshes());
        assertEquals(2, cache.stats().changedChunkRefreshes());
    }

    @Test
    void unloadRemovesOnlyTheMatchingWorldChunk() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object world = new Object();
        Object staleWorld = new Object();
        cache.putChunk(world, chunk(0, 0, 3));

        assertFalse(cache.removeChunk(staleWorld, 0, 0));
        assertEquals(1, cache.stats().loadedChunks());
        assertTrue(cache.removeChunk(world, 0, 0));
        assertEquals(0, cache.stats().loadedChunks());
        assertEquals(0, cache.stats().cachedBlockObservations());
    }

    @Test
    void worldIdentityUsesReferenceIsolationAndClearsAllObservations() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object worldA = new String("same-value");
        Object worldB = new String("same-value");
        cache.putChunk(worldA, chunk(0, 0, 1));
        cache.replaceEntities(worldA, List.of(entity("cow-a", 1, 64, 1)));
        long firstRevision = cache.stats().worldRevision();

        assertTrue(cache.ensureWorld(worldB));

        assertTrue(cache.stats().worldRevision() > firstRevision);
        assertEquals(0, cache.stats().loadedChunks());
        assertEquals(0, cache.stats().cachedBlockObservations());
        assertEquals(0, cache.stats().cachedEntityObservations());
    }

    @Test
    void globalBlockCapEvictsWholeOldestChunksDeterministically() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object world = new Object();
        for (int chunkX = 0; chunkX < 33; chunkX++) {
            cache.putChunk(world, chunk(chunkX, 0, OpportunityScanner.MAX_BLOCKS_PER_CHUNK));
        }

        assertEquals(32, cache.stats().loadedChunks());
        assertEquals(OpportunityObservationCache.MAX_CACHED_BLOCK_OBSERVATIONS,
            cache.stats().cachedBlockObservations());
        assertEquals(1, cache.stats().chunkEvictions());
        assertFalse(cache.containsChunk(world, 0, 0));
        assertTrue(cache.containsChunk(world, 32, 0));
    }

    @Test
    void entityCacheIsCappedAndMalformedEntriesFailClosed() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object world = new Object();
        List<OpportunityScanner.EntityObservation> entities = new ArrayList<>();
        entities.add(null);
        entities.add(new OpportunityScanner.EntityObservation(
            "", OpportunityScanner.EntityKind.PASSIVE_FOOD, "cow", BlockPos.ORIGIN,
            true, true, true));
        for (int index = 0; index < 300; index++) {
            entities.add(entity("cow-" + index, index, 64, 0));
        }

        cache.replaceEntities(world, entities);

        assertEquals(OpportunityObservationCache.MAX_CACHED_ENTITY_OBSERVATIONS,
            cache.stats().cachedEntityObservations());
    }

    @Test
    void scanReducesOnlyTheMatchingWorldCache() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object world = new Object();
        Object otherWorld = new Object();
        cache.putChunk(world, new OpportunityScanner.ChunkObservation(
            0,
            0,
            List.of(new OpportunityScanner.BlockObservation(
                new BlockPos(1, 64, 1),
                OpportunityScanner.BlockKind.HAY_BALE,
                true,
                true,
                true,
                "minecraft:hay_block"
            ))
        ));

        OpportunityScanner.ScanResult matching = cache.scan(
            world, "world-id", "overworld", BlockPos.ORIGIN, 1_000L);
        OpportunityScanner.ScanResult stale = cache.scan(
            otherWorld, "world-id", "overworld", BlockPos.ORIGIN, 1_000L);

        assertEquals(1, matching.discoveriesOfType(OpportunityScanner.DiscoveryType.HAY).size());
        assertTrue(stale.discoveries().isEmpty());
    }

    @Test
    void liveTargetChunkReplacementRemovesCachedVillageEvidence() {
        OpportunityObservationCache cache = new OpportunityObservationCache();
        Object world = new Object();
        OpportunityScanner.ChunkObservation cachedVillage =
            new OpportunityScanner.ChunkObservation(
                0,
                0,
                List.of(
                    new OpportunityScanner.BlockObservation(
                        new BlockPos(1, 64, 1),
                        OpportunityScanner.BlockKind.VILLAGE_BELL,
                        true, true, true, "minecraft:bell"),
                    new OpportunityScanner.BlockObservation(
                        new BlockPos(2, 64, 1),
                        OpportunityScanner.BlockKind.BED,
                        true, true, true, "minecraft:red_bed")
                )
            );

        cache.refreshChunk(world, cachedVillage);
        OpportunityScanner.ScanResult cached = cache.scan(
            world, "world-id", "overworld", BlockPos.ORIGIN, 1_000L);
        OpportunityObservationCache.RefreshResult liveRefresh = cache.refreshChunk(
            world, new OpportunityScanner.ChunkObservation(0, 0, List.of()));
        OpportunityScanner.ScanResult live = cache.scan(
            world, "world-id", "overworld", BlockPos.ORIGIN, 1_001L);

        assertFalse(cached.discoveriesOfType(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER).isEmpty());
        assertTrue(liveRefresh.changed());
        assertTrue(live.discoveriesOfType(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER).isEmpty());
        assertEquals(0, cache.stats().cachedBlockObservations());
    }

    private static OpportunityScanner.ChunkObservation chunk(
        int chunkX,
        int chunkZ,
        int blockCount
    ) {
        List<OpportunityScanner.BlockObservation> blocks = new ArrayList<>();
        for (int index = 0; index < blockCount; index++) {
            int localX = index & 15;
            int localZ = index >> 4 & 15;
            int y = 64 + (index >> 8);
            blocks.add(new OpportunityScanner.BlockObservation(
                new BlockPos(chunkX * 16 + localX, y, chunkZ * 16 + localZ),
                OpportunityScanner.BlockKind.HAY_BALE,
                true,
                true,
                true,
                "minecraft:hay_block"
            ));
        }
        return new OpportunityScanner.ChunkObservation(chunkX, chunkZ, blocks);
    }

    private static OpportunityScanner.EntityObservation entity(String id, int x, int y, int z) {
        return new OpportunityScanner.EntityObservation(
            id,
            OpportunityScanner.EntityKind.PASSIVE_FOOD,
            "minecraft:cow",
            new BlockPos(x, y, z),
            true,
            true,
            true
        );
    }
}
