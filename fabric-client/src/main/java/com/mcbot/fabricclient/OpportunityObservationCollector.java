package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;
import net.minecraft.block.BedBlock;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ChestBlock;
import net.minecraft.block.enums.BedPart;
import net.minecraft.block.enums.ChestType;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.passive.IronGolemEntity;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.world.Heightmap;
import net.minecraft.world.chunk.ChunkSection;
import net.minecraft.world.chunk.WorldChunk;

/**
 * Lifecycle-event bridge for {@link OpportunityScanner}.
 *
 * <p>Chunk load classifies each chunk once and chunk unload evicts it. Entity load/unload retains a
 * bounded set of interesting live references; an explicit snapshot refresh resamples only those
 * references and reduces the already-cached observations. There is intentionally no tick method,
 * whole-world entity scan, BrainLink dependency, or route serialization here.
 */
final class OpportunityObservationCollector {
    static final int MAX_TRACKED_ENTITIES = 512;
    static final int MAX_OBSERVATIONS_PER_BLOCK_KIND = 64;
    static final int MAX_WIRE_DISCOVERIES = 32;
    static final int MAX_CLASSIFIED_CHUNK_KEYS = 512;
    static final int MAX_EXACT_ENTITY_IDENTITIES = MAX_WIRE_DISCOVERIES;
    static final long CHUNK_REFRESH_INTERVAL_MS = 30_000L;
    private static final int SURFACE_STONE_COLUMN_DEPTH = 4;

    enum AccessProofKind {
        NONE,
        LOCAL,
        VILLAGE_FRONTIER
    }

    @FunctionalInterface
    interface IronGolemReadinessResolver {
        OpportunityExecutorCapabilityRegistry.TargetReadiness evaluate(
            String discoveryId,
            IronGolemEntity target
        );

        static IronGolemReadinessResolver unavailable() {
            return (ignoredId, ignoredTarget) ->
                OpportunityExecutorCapabilityRegistry.TargetReadiness.unavailable();
        }
    }

    private static final List<OpportunityScanner.BlockKind> BLOCK_KIND_WIRE_ORDER = List.of(
        OpportunityScanner.BlockKind.VILLAGE_BELL,
        OpportunityScanner.BlockKind.VILLAGE_JOB_SITE,
        OpportunityScanner.BlockKind.BED,
        OpportunityScanner.BlockKind.HAY_BALE,
        OpportunityScanner.BlockKind.CONTAINER,
        OpportunityScanner.BlockKind.IRON_ORE,
        OpportunityScanner.BlockKind.COAL_ORE,
        OpportunityScanner.BlockKind.PORTAL_OBSIDIAN,
        OpportunityScanner.BlockKind.PORTAL_CRYING_OBSIDIAN,
        OpportunityScanner.BlockKind.PORTAL_GOLD_BLOCK,
        OpportunityScanner.BlockKind.PORTAL_MAGMA,
        OpportunityScanner.BlockKind.PORTAL_NETHERRACK,
        OpportunityScanner.BlockKind.STONE
    );

    record CollectorStats(
        OpportunityObservationCache.CacheStats cache,
        int trackedEntities,
        int entityEvictions,
        int chunkClassifications,
        int chunkRefreshSkips,
        int accessibilityProofComputations
    ) {
    }

    record WireDiscovery(
        String id,
        String type,
        int x,
        int y,
        int z,
        int memberCount,
        double confidence,
        List<String> signals,
        long observedAtMs,
        String status,
        String capabilityId,
        String executorId,
        boolean executorReady,
        String readinessReason,
        String readinessSource
    ) {
        WireDiscovery {
            id = id == null ? "" : id;
            type = type == null ? "" : type;
            signals = signals == null ? List.of() : List.copyOf(signals);
            status = normalizeStatus(status);
            capabilityId = normalizeToken(capabilityId);
            executorId = normalizeToken(executorId);
            readinessReason = normalizeToken(readinessReason);
            readinessSource = normalizeToken(readinessSource);
        }

        WireDiscovery(
            String id,
            String type,
            int x,
            int y,
            int z,
            int memberCount,
            double confidence,
            List<String> signals,
            long observedAtMs,
            String status
        ) {
            this(
                id, type, x, y, z, memberCount, confidence, signals, observedAtMs, status,
                "", "", false, "not_evaluated", ""
            );
        }

        WireDiscovery(
            String id,
            String type,
            int x,
            int y,
            int z,
            int memberCount,
            double confidence,
            List<String> signals,
            long observedAtMs
        ) {
            this(id, type, x, y, z, memberCount, confidence, signals, observedAtMs, "observed");
        }

        Map<String, Object> toMap() {
            LinkedHashMap<String, Object> map = new LinkedHashMap<>();
            map.put("id", id);
            map.put("type", type);
            map.put("x", x);
            map.put("y", y);
            map.put("z", z);
            map.put("memberCount", memberCount);
            map.put("confidence", confidence);
            map.put("signals", signals);
            map.put("observedAtMs", observedAtMs);
            map.put("status", status);
            map.put("capabilityId", capabilityId);
            map.put("executorId", executorId);
            map.put("executorReady", executorReady);
            map.put("readinessReason", readinessReason);
            map.put("readinessSource", readinessSource);
            return Collections.unmodifiableMap(map);
        }

        private static String normalizeStatus(String value) {
            return switch (value == null ? "" : value.trim().toLowerCase(Locale.ROOT)) {
                case "verified" -> "verified";
                case "invalidated" -> "invalidated";
                case "disappeared" -> "disappeared";
                default -> "observed";
            };
        }

        private static String normalizeToken(String value) {
            return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        }
    }

    record Snapshot(
        List<WireDiscovery> discoveries,
        List<Map<String, Object>> wireMaps,
        OpportunityScanner.ScanResult scanResult,
        CollectorStats stats
    ) {
        Snapshot {
            discoveries = discoveries == null ? List.of() : List.copyOf(discoveries);
            wireMaps = wireMaps == null ? List.of() : List.copyOf(wireMaps);
        }
    }

    private final OpportunityObservationCache cache = new OpportunityObservationCache();
    private final VillageFrontierAccessProof villageFrontierAccessProof =
        new VillageFrontierAccessProof();
    private final LinkedHashMap<String, Entity> trackedEntities = new LinkedHashMap<>();
    /** Opaque scanner discovery id to raw entity identity; never copied into wire output. */
    private final LinkedHashMap<String, UUID> exactEntityIdentities = new LinkedHashMap<>();
    private final LinkedHashMap<String, WireDiscovery> previousDiscoveries = new LinkedHashMap<>();
    private final Map<OpportunityObservationCache.ChunkKey, Long> lastChunkClassificationAtMs =
        new LinkedHashMap<>();
    private ClientWorld activeWorld;
    private ClientWorld accessibilityWorld;
    private BlockPos accessibilityOrigin;
    private OpportunityAccessibilityProof accessibilityProof;
    private long accessibilityProofEpochMs = Long.MIN_VALUE;
    private int entityEvictions;
    private int chunkClassifications;
    private int chunkRefreshSkips;
    private int accessibilityProofComputations;

    /** Directly compatible with {@code ClientChunkEvents.CHUNK_LOAD}. */
    void onChunkLoaded(ClientWorld world, WorldChunk chunk) {
        onChunkScanned(world, chunk, null, 0L);
    }

    /** Called only from the existing throttled far-perception chunk probe. */
    OpportunityObservationCache.RefreshResult onChunkScanned(
        ClientWorld world,
        WorldChunk chunk,
        BlockPos observerFeet,
        long observedAtMs
    ) {
        return refreshChunkClassification(
            world, chunk, observerFeet, observedAtMs, false);
    }

    /**
     * Explicit arrival-boundary refresh for one already-loaded target chunk.
     *
     * <p>This deliberately bypasses the ordinary 30-second cadence, but remains bounded to the
     * single chunk containing the frozen opportunity anchor. It is never called from the tick loop
     * or snapshot polling.
     */
    OpportunityObservationCache.RefreshResult forceChunkRefresh(
        ClientWorld world,
        WorldChunk chunk,
        BlockPos observerFeet,
        long observedAtMs
    ) {
        return refreshChunkClassification(
            world, chunk, observerFeet, observedAtMs, true);
    }

    private OpportunityObservationCache.RefreshResult refreshChunkClassification(
        ClientWorld world,
        WorldChunk chunk,
        BlockPos observerFeet,
        long observedAtMs,
        boolean forced
    ) {
        if (world == null || chunk == null) {
            return new OpportunityObservationCache.RefreshResult(false, false, 0, 0, 0L);
        }
        ensureWorld(world);
        OpportunityObservationCache.ChunkKey key = new OpportunityObservationCache.ChunkKey(
            chunk.getPos().x, chunk.getPos().z);
        boolean cached = cache.containsChunk(world, key.x(), key.z());
        long lastClassified = lastChunkClassificationAtMs.getOrDefault(key, Long.MIN_VALUE);
        if (!forced && !shouldRefreshChunk(cached, lastClassified, observedAtMs)) {
            chunkRefreshSkips += 1;
            return new OpportunityObservationCache.RefreshResult(
                true, false, 0, 0, cache.stats().geometryRevision());
        }
        if (forced
            || lastClassified != Long.MIN_VALUE
                && accessibilityProofEpochMs != observedAtMs) {
            invalidateAccessibilityProof();
        }
        OpportunityAccessibilityProof access = observerFeet == null
            ? null
            : accessibilityProof(world, observerFeet, observedAtMs);
        OpportunityScanner.ChunkObservation observation = classifyChunk(world, chunk, access);
        OpportunityObservationCache.RefreshResult result = cache.refreshChunk(world, observation);
        lastChunkClassificationAtMs.put(key, Math.max(0L, observedAtMs));
        while (lastChunkClassificationAtMs.size() > MAX_CLASSIFIED_CHUNK_KEYS) {
            lastChunkClassificationAtMs.remove(
                lastChunkClassificationAtMs.keySet().iterator().next());
        }
        chunkClassifications += 1;
        return result;
    }

    OpportunityObservationCache.RefreshResult onChunkScanned(
        ClientWorld world,
        WorldChunk chunk,
        BlockPos observerFeet
    ) {
        return onChunkScanned(world, chunk, observerFeet, 0L);
    }

    void invalidateChunk(ClientWorld world, int chunkX, int chunkZ) {
        if (world == activeWorld) {
            lastChunkClassificationAtMs.remove(
                new OpportunityObservationCache.ChunkKey(chunkX, chunkZ));
        }
    }

    static boolean shouldRefreshChunk(boolean cached, long lastClassifiedAtMs, long nowMs) {
        if (lastClassifiedAtMs == Long.MIN_VALUE) {
            return true;
        }
        return Math.max(0L, nowMs) - Math.max(0L, lastClassifiedAtMs)
            >= CHUNK_REFRESH_INTERVAL_MS;
    }

    /** Directly compatible with {@code ClientChunkEvents.CHUNK_UNLOAD}. */
    void onChunkUnloaded(ClientWorld world, WorldChunk chunk) {
        if (world == null || chunk == null || world != activeWorld) {
            return;
        }
        cache.removeChunk(world, chunk.getPos().x, chunk.getPos().z);
        lastChunkClassificationAtMs.remove(new OpportunityObservationCache.ChunkKey(
            chunk.getPos().x, chunk.getPos().z));
    }

    /** Directly compatible with {@code ClientEntityEvents.ENTITY_LOAD}. */
    void onEntityLoaded(Entity entity, ClientWorld world) {
        if (entity == null || world == null || classifyEntityType(entity.getType()) == null) {
            return;
        }
        ensureWorld(world);
        String id = entity.getUuidAsString().toLowerCase(Locale.ROOT);
        trackedEntities.put(id, entity);
        while (trackedEntities.size() > MAX_TRACKED_ENTITIES) {
            trackedEntities.remove(trackedEntities.entrySet().iterator().next().getKey());
            entityEvictions += 1;
        }
    }

    /** Directly compatible with {@code ClientEntityEvents.ENTITY_UNLOAD}. */
    void onEntityUnloaded(Entity entity, ClientWorld world) {
        if (entity == null || world == null || world != activeWorld) {
            return;
        }
        trackedEntities.remove(entity.getUuidAsString().toLowerCase(Locale.ROOT));
        exactEntityIdentities.entrySet().removeIf(entry -> entity.getUuid().equals(entry.getValue()));
    }

    /**
     * Explicit snapshot boundary. This method only resamples event-cached entity references and
     * reduces cached observations; it never enumerates world entities or chunks.
     */
    Snapshot refreshSnapshot(
        ClientWorld world,
        String worldIdentity,
        String dimensionIdentity,
        BlockPos origin,
        long observedAtMs,
        OpportunityExecutorCapabilityRegistry.RuntimeState executorRuntime,
        IronGolemReadinessResolver ironGolemReadinessResolver
    ) {
        if (world == null) {
            return emptySnapshot();
        }
        ensureWorld(world);
        BlockPos canonicalOrigin = origin == null ? BlockPos.ORIGIN : origin.toImmutable();
        OpportunityAccessibilityProof access = accessibilityProof(
            world, canonicalOrigin, observedAtMs);
        cache.replaceEntities(world, sampleTrackedEntities(world, canonicalOrigin, access));
        OpportunityScanner.ScanResult scan = cache.scan(
            world,
            worldIdentity,
            dimensionIdentity,
            canonicalOrigin,
            observedAtMs
        );
        exactEntityIdentities.clear();
        List<WireDiscovery> validatedCurrent = scan.discoveries().stream()
            .limit(MAX_WIRE_DISCOVERIES)
            .map(discovery -> toWireDiscovery(
                world,
                discovery,
                canonicalOrigin,
                access,
                observedAtMs,
                executorRuntime,
                ironGolemReadinessResolver))
            .toList();
        List<WireDiscovery> current = validatedCurrent.stream()
            .filter(discovery -> !"disappeared".equals(discovery.status())
                || !"disappeared".equals(java.util.Optional
                    .ofNullable(previousDiscoveries.get(discovery.id()))
                    .map(WireDiscovery::status)
                    .orElse("")))
            .toList();
        LinkedHashMap<String, WireDiscovery> currentById = new LinkedHashMap<>();
        validatedCurrent.forEach(discovery -> currentById.put(discovery.id(), discovery));
        List<WireDiscovery> discoveries = reconcileDiscoveries(
            current,
            List.copyOf(previousDiscoveries.values()),
            previous -> cache.containsChunk(
                    world,
                    Math.floorDiv(previous.x(), 16),
                    Math.floorDiv(previous.z(), 16)
                ),
            scan.truncated() || scan.discoveries().size() > MAX_WIRE_DISCOVERIES,
            observedAtMs
        ).stream().limit(MAX_WIRE_DISCOVERIES).toList();
        previousDiscoveries.clear();
        previousDiscoveries.putAll(currentById);
        return new Snapshot(
            discoveries,
            discoveries.stream().map(WireDiscovery::toMap).toList(),
            scan,
            stats()
        );
    }

    Snapshot refreshSnapshot(
        ClientWorld world,
        String worldIdentity,
        String dimensionIdentity,
        BlockPos origin,
        long observedAtMs,
        OpportunityExecutorCapabilityRegistry.RuntimeState executorRuntime
    ) {
        return refreshSnapshot(
            world,
            worldIdentity,
            dimensionIdentity,
            origin,
            observedAtMs,
            executorRuntime,
            IronGolemReadinessResolver.unavailable()
        );
    }

    Snapshot refreshSnapshot(
        ClientWorld world,
        String worldIdentity,
        String dimensionIdentity,
        BlockPos origin,
        long observedAtMs
    ) {
        return refreshSnapshot(
            world,
            worldIdentity,
            dimensionIdentity,
            origin,
            observedAtMs,
            OpportunityExecutorCapabilityRegistry.RuntimeState.none()
        );
    }

    Snapshot refreshSnapshot(
        ClientWorld world,
        String worldIdentity,
        BlockPos origin,
        long observedAtMs
    ) {
        String dimension = world == null
            ? ""
            : world.getRegistryKey().getValue().toString();
        return refreshSnapshot(world, worldIdentity, dimension, origin, observedAtMs);
    }

    CollectorStats stats() {
        return new CollectorStats(
            cache.stats(),
            trackedEntities.size(),
            entityEvictions,
            chunkClassifications,
            chunkRefreshSkips,
            accessibilityProofComputations
        );
    }

    void clear() {
        cache.clear();
        trackedEntities.clear();
        exactEntityIdentities.clear();
        previousDiscoveries.clear();
        lastChunkClassificationAtMs.clear();
        invalidateAccessibilityProof();
        villageFrontierAccessProof.clear();
        activeWorld = null;
        entityEvictions = 0;
        chunkClassifications = 0;
        chunkRefreshSkips = 0;
        accessibilityProofComputations = 0;
    }

    static OpportunityScanner.ChunkObservation classifyChunk(ClientWorld world, WorldChunk chunk) {
        return classifyChunk(world, chunk, null);
    }

    static OpportunityScanner.ChunkObservation classifyChunk(
        ClientWorld world,
        WorldChunk chunk,
        OpportunityAccessibilityProof access
    ) {
        if (world == null || chunk == null) {
            return new OpportunityScanner.ChunkObservation(0, 0, List.of());
        }
        BlockBuckets buckets = new BlockBuckets();
        ChunkSection[] sections = chunk.getSectionArray();
        int bottomSection = world.getBottomSectionCoord();
        int startX = chunk.getPos().getStartX();
        int startZ = chunk.getPos().getStartZ();
        for (int sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
            ChunkSection section = sections[sectionIndex];
            if (section == null || section.isEmpty()
                || !section.hasAny(OpportunityObservationCollector::isSpecialInterestingState)) {
                continue;
            }
            int baseY = (bottomSection + sectionIndex) << 4;
            for (int localY = 0; localY < 16; localY++) {
                for (int localZ = 0; localZ < 16; localZ++) {
                    for (int localX = 0; localX < 16; localX++) {
                        BlockState state = section.getBlockState(localX, localY, localZ);
                        List<OpportunityScanner.BlockKind> kinds = classifyBlockKinds(state);
                        if (kinds.isEmpty() || buckets.fullForAll(kinds)) {
                            continue;
                        }
                        BlockPos pos = new BlockPos(
                            startX + localX,
                            baseY + localY,
                            startZ + localZ
                        );
                        boolean exposed = isExposed(world, pos);
                        boolean hazardFree = isHazardFree(world, pos);
                        String detail = Registries.BLOCK.getId(state.getBlock()).toString();
                        for (OpportunityScanner.BlockKind kind : kinds) {
                            if ((kind == OpportunityScanner.BlockKind.IRON_ORE
                                || kind == OpportunityScanner.BlockKind.COAL_ORE) && !exposed) {
                                continue;
                            }
                            buckets.add(new OpportunityScanner.BlockObservation(
                                pos,
                                kind,
                                exposed,
                                access != null && access.canAccessBlock(pos),
                                hazardFree,
                                detail
                            ));
                        }
                    }
                }
            }
        }
        sampleSurfaceStone(world, chunk, buckets, access);
        return new OpportunityScanner.ChunkObservation(
            chunk.getPos().x,
            chunk.getPos().z,
            buckets.flatten()
        );
    }

    static List<OpportunityScanner.BlockKind> classifyBlockKinds(BlockState state) {
        if (state == null || state.isAir()) {
            return List.of();
        }
        List<OpportunityScanner.BlockKind> kinds = new ArrayList<>(2);
        if (state.isOf(Blocks.BELL)) {
            kinds.add(OpportunityScanner.BlockKind.VILLAGE_BELL);
        }
        if (isVillageJobSite(state)) {
            kinds.add(OpportunityScanner.BlockKind.VILLAGE_JOB_SITE);
        }
        if (state.isOf(Blocks.HAY_BLOCK)) {
            kinds.add(OpportunityScanner.BlockKind.HAY_BALE);
        }
        if (isBedRepresentative(state)) {
            kinds.add(OpportunityScanner.BlockKind.BED);
        }
        if (isContainerRepresentative(state)) {
            kinds.add(OpportunityScanner.BlockKind.CONTAINER);
        }
        if (state.isIn(BlockTags.IRON_ORES)) {
            kinds.add(OpportunityScanner.BlockKind.IRON_ORE);
        } else if (state.isIn(BlockTags.COAL_ORES)) {
            kinds.add(OpportunityScanner.BlockKind.COAL_ORE);
        }
        if (state.isOf(Blocks.OBSIDIAN)) {
            kinds.add(OpportunityScanner.BlockKind.PORTAL_OBSIDIAN);
        } else if (state.isOf(Blocks.CRYING_OBSIDIAN)) {
            kinds.add(OpportunityScanner.BlockKind.PORTAL_CRYING_OBSIDIAN);
        } else if (state.isOf(Blocks.NETHERRACK)) {
            kinds.add(OpportunityScanner.BlockKind.PORTAL_NETHERRACK);
        } else if (state.isOf(Blocks.MAGMA_BLOCK)) {
            kinds.add(OpportunityScanner.BlockKind.PORTAL_MAGMA);
        } else if (state.isOf(Blocks.GOLD_BLOCK)) {
            kinds.add(OpportunityScanner.BlockKind.PORTAL_GOLD_BLOCK);
        }
        return List.copyOf(kinds);
    }

    static OpportunityScanner.EntityKind classifyEntityType(EntityType<?> type) {
        if (type == EntityType.VILLAGER) {
            return OpportunityScanner.EntityKind.VILLAGER;
        }
        if (type == EntityType.IRON_GOLEM) {
            return OpportunityScanner.EntityKind.IRON_GOLEM;
        }
        if (type == EntityType.COW
            || type == EntityType.MOOSHROOM
            || type == EntityType.PIG
            || type == EntityType.SHEEP
            || type == EntityType.CHICKEN
            || type == EntityType.RABBIT) {
            return OpportunityScanner.EntityKind.PASSIVE_FOOD;
        }
        return null;
    }

    static String wireType(OpportunityScanner.DiscoveryType type) {
        if (type == OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER) {
            return "village";
        }
        return type == null ? "" : type.name().toLowerCase(Locale.ROOT);
    }

    private void ensureWorld(ClientWorld world) {
        if (activeWorld == world) {
            return;
        }
        activeWorld = world;
        cache.ensureWorld(world);
        trackedEntities.clear();
        exactEntityIdentities.clear();
        previousDiscoveries.clear();
        lastChunkClassificationAtMs.clear();
        invalidateAccessibilityProof();
        villageFrontierAccessProof.clear();
        entityEvictions = 0;
        chunkClassifications = 0;
        chunkRefreshSkips = 0;
        accessibilityProofComputations = 0;
    }

    private OpportunityAccessibilityProof accessibilityProof(
        ClientWorld world,
        BlockPos origin,
        long observedAtMs
    ) {
        BlockPos canonicalOrigin = origin == null ? BlockPos.ORIGIN : origin.toImmutable();
        if (accessibilityProof != null
            && accessibilityWorld == world
            && canonicalOrigin.equals(accessibilityOrigin)
            && accessibilityProofEpochMs == observedAtMs) {
            return accessibilityProof;
        }
        accessibilityWorld = world;
        accessibilityOrigin = canonicalOrigin;
        accessibilityProofEpochMs = observedAtMs;
        accessibilityProof = OpportunityAccessibilityProof.capture(world, canonicalOrigin);
        accessibilityProofComputations += 1;
        return accessibilityProof;
    }

    private void invalidateAccessibilityProof() {
        accessibilityWorld = null;
        accessibilityOrigin = null;
        accessibilityProof = null;
        accessibilityProofEpochMs = Long.MIN_VALUE;
    }

    private List<OpportunityScanner.EntityObservation> sampleTrackedEntities(
        ClientWorld world,
        BlockPos origin,
        OpportunityAccessibilityProof access
    ) {
        trackedEntities.entrySet().removeIf(entry -> {
            Entity entity = entry.getValue();
            return entity == null || entity.isRemoved() || entity.getWorld() != world;
        });
        return trackedEntities.values().stream()
            .filter(Entity::isAlive)
            .filter(entity -> classifyEntityType(entity.getType()) != null)
            .sorted(Comparator
                .comparingLong((Entity entity) -> squaredDistance(origin, entity.getBlockPos()))
                .thenComparing(Entity::getUuidAsString))
            .limit(OpportunityScanner.MAX_ENTITY_OBSERVATIONS)
            .map(entity -> {
                BlockPos pos = entity.getBlockPos().toImmutable();
                boolean hazardFree = isHazardFree(world, pos);
                return new OpportunityScanner.EntityObservation(
                    entity.getUuidAsString(),
                    classifyEntityType(entity.getType()),
                    Registries.ENTITY_TYPE.getId(entity.getType()).toString(),
                    pos,
                    entity.isAlive(),
                    access != null
                        && world.getWorldBorder().contains(pos)
                        && access.canApproachEntity(pos),
                    hazardFree
                );
            })
            .toList();
    }

    private static void sampleSurfaceStone(
        ClientWorld world,
        WorldChunk chunk,
        BlockBuckets buckets,
        OpportunityAccessibilityProof access
    ) {
        if (buckets.isFull(OpportunityScanner.BlockKind.STONE)) {
            return;
        }
        int startX = chunk.getPos().getStartX();
        int startZ = chunk.getPos().getStartZ();
        for (int localZ = 0; localZ < 16 && !buckets.isFull(
            OpportunityScanner.BlockKind.STONE); localZ++) {
            for (int localX = 0; localX < 16 && !buckets.isFull(
                OpportunityScanner.BlockKind.STONE); localX++) {
                int x = startX + localX;
                int z = startZ + localZ;
                int top = world.getTopY(Heightmap.Type.WORLD_SURFACE, x, z) - 1;
                for (int depth = 0; depth < SURFACE_STONE_COLUMN_DEPTH; depth++) {
                    BlockPos pos = new BlockPos(x, top - depth, z);
                    BlockState state = world.getBlockState(pos);
                    if (state.isIn(BlockTags.BASE_STONE_OVERWORLD) && isExposed(world, pos)) {
                        buckets.add(new OpportunityScanner.BlockObservation(
                            pos,
                            OpportunityScanner.BlockKind.STONE,
                            true,
                            access != null && access.canAccessBlock(pos),
                            isHazardFree(world, pos),
                            Registries.BLOCK.getId(state.getBlock()).toString()
                        ));
                        break;
                    }
                    if (!state.isAir() && state.getFluidState().isEmpty()) {
                        break;
                    }
                }
            }
        }
    }

    private static boolean isSpecialInterestingState(BlockState state) {
        return state != null && !state.isAir() && (
            state.isOf(Blocks.BELL)
                || isVillageJobSite(state)
                || state.isOf(Blocks.HAY_BLOCK)
                || state.isIn(BlockTags.BEDS)
                || isContainer(state)
                || state.isIn(BlockTags.IRON_ORES)
                || state.isIn(BlockTags.COAL_ORES)
                || state.isOf(Blocks.OBSIDIAN)
                || state.isOf(Blocks.CRYING_OBSIDIAN)
                || state.isOf(Blocks.NETHERRACK)
                || state.isOf(Blocks.MAGMA_BLOCK)
                || state.isOf(Blocks.GOLD_BLOCK)
        );
    }

    private static boolean isVillageJobSite(BlockState state) {
        return state.isOf(Blocks.BLAST_FURNACE)
            || state.isOf(Blocks.SMOKER)
            || state.isOf(Blocks.CARTOGRAPHY_TABLE)
            || state.isOf(Blocks.BREWING_STAND)
            || state.isOf(Blocks.COMPOSTER)
            || state.isOf(Blocks.FLETCHING_TABLE)
            || state.isOf(Blocks.GRINDSTONE)
            || state.isOf(Blocks.LECTERN)
            || state.isOf(Blocks.LOOM)
            || state.isOf(Blocks.SMITHING_TABLE)
            || state.isOf(Blocks.STONECUTTER)
            || state.isOf(Blocks.CAULDRON)
            || state.isOf(Blocks.BARREL);
    }

    private static boolean isContainer(BlockState state) {
        return state.isOf(Blocks.CHEST)
            || state.isOf(Blocks.TRAPPED_CHEST)
            || state.isOf(Blocks.BARREL)
            || state.isIn(BlockTags.SHULKER_BOXES);
    }

    /** One logical bed/container opportunity, not one discovery per multi-block half. */
    private static boolean isBedRepresentative(BlockState state) {
        return state.isIn(BlockTags.BEDS)
            && (!state.contains(BedBlock.PART) || state.get(BedBlock.PART) == BedPart.HEAD);
    }

    private static boolean isContainerRepresentative(BlockState state) {
        if (!isContainer(state)) {
            return false;
        }
        if ((state.isOf(Blocks.CHEST) || state.isOf(Blocks.TRAPPED_CHEST))
            && state.contains(ChestBlock.CHEST_TYPE)) {
            return state.get(ChestBlock.CHEST_TYPE) != ChestType.RIGHT;
        }
        return true;
    }

    private static boolean isExposed(ClientWorld world, BlockPos pos) {
        for (Direction direction : Direction.values()) {
            BlockState neighbor = world.getBlockState(pos.offset(direction));
            if (neighbor.isAir() || !neighbor.getFluidState().isEmpty()) {
                return true;
            }
        }
        return false;
    }

    private static boolean isHazardFree(ClientWorld world, BlockPos pos) {
        if (isHazard(world.getBlockState(pos))) {
            return false;
        }
        for (Direction direction : Direction.values()) {
            if (isHazard(world.getBlockState(pos.offset(direction)))) {
                return false;
            }
        }
        return true;
    }

    private static boolean isHazard(BlockState state) {
        return state != null && (
            state.getFluidState().isIn(FluidTags.LAVA)
                || state.isOf(Blocks.FIRE)
                || state.isOf(Blocks.SOUL_FIRE)
                || state.isOf(Blocks.MAGMA_BLOCK)
                || state.isOf(Blocks.CACTUS)
                || state.isOf(Blocks.SWEET_BERRY_BUSH)
        );
    }

    private WireDiscovery toWireDiscovery(
        ClientWorld world,
        OpportunityScanner.Discovery discovery,
        BlockPos observerFeet,
        OpportunityAccessibilityProof access,
        long observedAtMs,
        OpportunityExecutorCapabilityRegistry.RuntimeState executorRuntime,
        IronGolemReadinessResolver ironGolemReadinessResolver
    ) {
        DiscoveryValidation validation = validateDiscovery(world, discovery);
        if (validation.targets().isEmpty()) {
            return new WireDiscovery(
                discovery.stableId(),
                wireType(discovery.type()),
                discovery.anchor().getX(),
                discovery.anchor().getY(),
                discovery.anchor().getZ(),
                discovery.memberCount(),
                0.0D,
                List.of("disappeared"),
                observedAtMs,
                "disappeared"
            );
        }
        List<LiveTarget> targets = validation.targets().stream()
            .sorted(Comparator.comparing(LiveTarget::position,
                OpportunityObservationCollector::comparePosition))
            .toList();
        LiveTarget exactExecutorTarget = firstExactExecutorTarget(
            world, discovery.type(), targets);
        BlockPos exactExecutorAnchor = exactExecutorTarget == null
            ? null : exactExecutorTarget.position();
        BlockPos anchor = discovery.type() == OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER
                && exactExecutorAnchor != null
            ? exactExecutorAnchor
            : targets.getFirst().position();
        boolean anySafe = targets.stream().anyMatch(target -> isHazardFree(world, target.position()));
        boolean hasExactExecutorTarget = exactExecutorTarget != null;
        boolean exactLocalAccess = hasAccessibleExactExecutorTarget(
            world, discovery.type(), targets, access);
        boolean anyLocalAccess = access != null && targets.stream().anyMatch(target ->
                isHazardFree(world, target.position()) && (target.entity()
                    ? access.canApproachEntity(target.position())
                    : access.canAccessBlock(target.position())));
        boolean routeReachable = false;
        if (!exactLocalAccess
            && discovery.type() == OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER
            && hasExactExecutorTarget
            && isHazardFree(world, exactExecutorAnchor)) {
            VillageFrontierAccessProof.Result frontier = villageFrontierAccessProof.evaluate(
                world,
                discovery.stableId(),
                observerFeet,
                exactExecutorAnchor,
                cache.stats().geometryRevision(),
                observedAtMs);
            routeReachable = frontier.routeReachable();
        }
        AccessProofKind accessProofKind = accessProofKind(
            discovery.type(), exactLocalAccess, anyLocalAccess, routeReachable);
        List<String> signals = new ArrayList<>(validation.signals());
        signals.add(anySafe ? "hazard_free" : "hazard_present");
        if (accessProofKind == AccessProofKind.LOCAL) {
            signals.add("access_proven");
        } else if (accessProofKind == AccessProofKind.VILLAGE_FRONTIER) {
            signals.add("route_reachable");
        }
        OpportunityExecutorCapabilityRegistry.TargetReadiness targetReadiness =
            golemTargetReadiness(
                world,
                discovery,
                exactExecutorTarget,
                ironGolemReadinessResolver
            );
        OpportunityExecutorCapabilityRegistry.Readiness readiness =
            OpportunityExecutorCapabilityRegistry.evaluate(
                discovery.type(),
                executorRuntime,
                hasExactExecutorTarget,
                targetReadiness
            );
        signals.addAll(readiness.wireSignals());
        signals = signals.stream().filter(signal -> signal != null && !signal.isBlank())
            .distinct().sorted().toList();
        String status = accessProofKind != AccessProofKind.NONE
            ? "verified" : anySafe ? "observed" : "invalidated";
        return new WireDiscovery(
            discovery.stableId(),
            wireType(discovery.type()),
            anchor.getX(),
            anchor.getY(),
            anchor.getZ(),
            targets.size(),
            discovery.confidence(),
            signals,
            observedAtMs,
            status,
            readiness.capabilityId(),
            readiness.executorId(),
            readiness.ready(),
            readiness.reason(),
            readiness.source()
        );
    }

    private boolean hasAccessibleExactExecutorTarget(
        ClientWorld world,
        OpportunityScanner.DiscoveryType type,
        List<LiveTarget> targets,
        OpportunityAccessibilityProof access
    ) {
        if (world == null || type == null || targets == null || targets.isEmpty() || access == null) {
            return false;
        }
        for (LiveTarget target : targets) {
            if (!isExactExecutorTarget(world, type, target)) {
                continue;
            }
            // Bind readiness to the same physical member that proves safe access. A mixed
            // exposed-stone cluster must not borrow reachability from diorite while an exact
            // stone target exists only behind blocked geometry.
            if (executorTargetAdmission(
                true,
                isHazardFree(world, target.position()),
                target.entity()
                    ? access.canApproachEntity(target.position())
                    : access.canAccessBlock(target.position())
            )) {
                return true;
            }
        }
        return false;
    }

    private LiveTarget firstExactExecutorTarget(
        ClientWorld world,
        OpportunityScanner.DiscoveryType type,
        List<LiveTarget> targets
    ) {
        if (world == null || type == null || targets == null) {
            return null;
        }
        return targets.stream()
            .filter(target -> isExactExecutorTarget(world, type, target))
            .sorted(Comparator.comparing(
                LiveTarget::position,
                OpportunityObservationCollector::comparePosition
            ))
            .findFirst()
            .orElse(null);
    }

    private boolean isExactExecutorTarget(
        ClientWorld world,
        OpportunityScanner.DiscoveryType type,
        LiveTarget target
    ) {
        if (world == null || type == null || target == null) {
            return false;
        }
        if (target.entity()) {
            Entity entity = liveTrackedEntity(world, target.identity());
            return type == OpportunityScanner.DiscoveryType.IRON_GOLEM
                && entity instanceof IronGolemEntity;
        }
        BlockState state = world.getBlockState(target.position());
        return switch (type) {
            case VILLAGE_MARKER_CLUSTER -> !villageMarker(state).isBlank();
            case CONTAINER -> isContainerRepresentative(state);
            case HAY -> state.isOf(Blocks.HAY_BLOCK);
            case BED -> isBedRepresentative(state);
            // mine_nearby_stone intentionally counts exact cobblestone and targets exact stone.
            case EXPOSED_STONE -> state.isOf(Blocks.STONE);
            case EXPOSED_IRON -> state.isOf(Blocks.IRON_ORE)
                || state.isOf(Blocks.DEEPSLATE_IRON_ORE);
            case EXPOSED_COAL -> state.isOf(Blocks.COAL_ORE)
                || state.isOf(Blocks.DEEPSLATE_COAL_ORE);
            default -> false;
        };
    }

    static boolean executorTargetAdmission(
        boolean exactExecutorTarget,
        boolean hazardFree,
        boolean accessProven
    ) {
        return exactExecutorTarget && hazardFree && accessProven;
    }

    static AccessProofKind accessProofKind(
        OpportunityScanner.DiscoveryType type,
        boolean exactLocalAccess,
        boolean anyLocalAccess,
        boolean villageFrontierReachable
    ) {
        if (type == OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER) {
            return exactLocalAccess
                ? AccessProofKind.LOCAL
                : villageFrontierReachable
                    ? AccessProofKind.VILLAGE_FRONTIER
                    : AccessProofKind.NONE;
        }
        if (OpportunityExecutorCapabilityRegistry.isRegistered(type)) {
            return exactLocalAccess ? AccessProofKind.LOCAL : AccessProofKind.NONE;
        }
        return anyLocalAccess ? AccessProofKind.LOCAL : AccessProofKind.NONE;
    }

    private DiscoveryValidation validateDiscovery(
        ClientWorld world,
        OpportunityScanner.Discovery discovery
    ) {
        LinkedHashMap<String, LiveTarget> targets = new LinkedHashMap<>();
        List<String> signals = new ArrayList<>();
        switch (discovery.type()) {
            case VILLAGER, IRON_GOLEM, PASSIVE_FOOD -> {
                for (String entityId : discovery.entityIds()) {
                    Entity entity = liveTrackedEntity(world, entityId);
                    OpportunityScanner.EntityKind kind = entity == null
                        ? null : classifyEntityType(entity.getType());
                    if (!matchesEntityDiscovery(discovery.type(), kind)) {
                        continue;
                    }
                    addLiveTarget(targets, entity.getBlockPos(), true, entityId);
                    signals.add("alive");
                    signals.add("subtype:" + Registries.ENTITY_TYPE.getId(entity.getType()));
                }
            }
            case VILLAGE_MARKER_CLUSTER -> {
                for (BlockPos position : discovery.samplePositions()) {
                    String marker = villageMarker(world.getBlockState(position));
                    if (!marker.isBlank()) {
                        addLiveTarget(targets, position, false, marker);
                        signals.add(marker);
                    }
                }
                int villagers = 0;
                for (String entityId : discovery.entityIds()) {
                    Entity entity = liveTrackedEntity(world, entityId);
                    OpportunityScanner.EntityKind kind = entity == null
                        ? null : classifyEntityType(entity.getType());
                    if (kind != OpportunityScanner.EntityKind.VILLAGER
                        && kind != OpportunityScanner.EntityKind.IRON_GOLEM) {
                        continue;
                    }
                    String marker = kind == OpportunityScanner.EntityKind.VILLAGER
                        ? "villager" : "iron_golem";
                    addLiveTarget(targets, entity.getBlockPos(), true, entityId);
                    signals.add(marker);
                    if (kind == OpportunityScanner.EntityKind.VILLAGER) {
                        villagers += 1;
                    }
                }
                long labelCount = signals.stream().distinct().count();
                if (targets.size() < 2 || labelCount < 2 && villagers < 2) {
                    targets.clear();
                    signals.clear();
                } else {
                    signals.add("marker_count:" + targets.size());
                }
            }
            case RUINED_PORTAL_EVIDENCE -> {
                boolean hasFrame = false;
                for (BlockPos position : discovery.samplePositions()) {
                    String evidence = portalEvidence(world.getBlockState(position));
                    if (evidence.isBlank()) {
                        continue;
                    }
                    hasFrame |= "obsidian".equals(evidence)
                        || "crying_obsidian".equals(evidence);
                    addLiveTarget(targets, position, false, evidence);
                    signals.add(evidence);
                }
                if (!hasFrame || targets.size() < 2) {
                    targets.clear();
                    signals.clear();
                }
            }
            default -> {
                for (BlockPos position : discovery.samplePositions()) {
                    String kind = matchingBlockSignal(world, discovery.type(), position);
                    if (!kind.isBlank()) {
                        addLiveTarget(targets, position, false, kind);
                        signals.add(kind);
                        if (isExposedDiscovery(discovery.type())) {
                            signals.add("exposed");
                        }
                    }
                }
            }
        }
        return new DiscoveryValidation(List.copyOf(targets.values()), List.copyOf(signals));
    }

    private Entity liveTrackedEntity(ClientWorld world, String entityId) {
        Entity entity = trackedEntities.get(entityId == null
            ? "" : entityId.toLowerCase(Locale.ROOT));
        return entity != null && entity.getWorld() == world && entity.isAlive() && !entity.isRemoved()
            ? entity : null;
    }

    /**
     * Resolve one opaque scanner discovery back to the exact cached live golem.
     *
     * <p>The raw UUID never appears in the wire discovery.  Resolution fails closed across world
     * changes, evictions, removal, death, type changes, and unmapped/truncated discoveries.
     */
    IronGolemEntity resolveExactIronGolem(ClientWorld world, String discoveryId) {
        if (world == null || world != activeWorld || discoveryId == null) {
            return null;
        }
        UUID entityId = exactEntityIdentities.get(discoveryId);
        if (entityId == null) {
            return null;
        }
        Entity entity = liveTrackedEntity(world, entityId.toString());
        return entity instanceof IronGolemEntity golem ? golem : null;
    }

    int liveTrackedIronGolemCount(ClientWorld world) {
        if (world == null || world != activeWorld) {
            return 0;
        }
        int count = 0;
        for (Entity entity : trackedEntities.values()) {
            if (entity instanceof IronGolemEntity
                && entity.getWorld() == world
                && entity.isAlive()
                && !entity.isRemoved()) {
                count += 1;
            }
        }
        return count;
    }

    private OpportunityExecutorCapabilityRegistry.TargetReadiness golemTargetReadiness(
        ClientWorld world,
        OpportunityScanner.Discovery discovery,
        LiveTarget exactTarget,
        IronGolemReadinessResolver resolver
    ) {
        if (discovery == null
            || discovery.type() != OpportunityScanner.DiscoveryType.IRON_GOLEM
            || exactTarget == null
            || !exactTarget.entity()) {
            return OpportunityExecutorCapabilityRegistry.TargetReadiness.unavailable();
        }
        Entity entity = liveTrackedEntity(world, exactTarget.identity());
        if (!(entity instanceof IronGolemEntity golem)) {
            return OpportunityExecutorCapabilityRegistry.TargetReadiness.unavailable();
        }
        UUID rawIdentity;
        try {
            rawIdentity = UUID.fromString(exactTarget.identity());
        } catch (IllegalArgumentException ignored) {
            return OpportunityExecutorCapabilityRegistry.TargetReadiness.unavailable();
        }
        exactEntityIdentities.put(discovery.stableId(), rawIdentity);
        while (exactEntityIdentities.size() > MAX_EXACT_ENTITY_IDENTITIES) {
            exactEntityIdentities.remove(exactEntityIdentities.entrySet().iterator().next().getKey());
        }
        IronGolemReadinessResolver safeResolver = resolver == null
            ? IronGolemReadinessResolver.unavailable() : resolver;
        OpportunityExecutorCapabilityRegistry.TargetReadiness result =
            safeResolver.evaluate(discovery.stableId(), golem);
        return result == null
            ? OpportunityExecutorCapabilityRegistry.TargetReadiness.unavailable()
            : result;
    }

    private static boolean matchesEntityDiscovery(
        OpportunityScanner.DiscoveryType type,
        OpportunityScanner.EntityKind kind
    ) {
        return switch (type) {
            case VILLAGER -> kind == OpportunityScanner.EntityKind.VILLAGER;
            case IRON_GOLEM -> kind == OpportunityScanner.EntityKind.IRON_GOLEM;
            case PASSIVE_FOOD -> kind == OpportunityScanner.EntityKind.PASSIVE_FOOD;
            default -> false;
        };
    }

    private static String matchingBlockSignal(
        ClientWorld world,
        OpportunityScanner.DiscoveryType type,
        BlockPos position
    ) {
        if (world == null || position == null || !world.getWorldBorder().contains(position)) {
            return "";
        }
        BlockState state = world.getBlockState(position);
        return switch (type) {
            case HAY -> state.isOf(Blocks.HAY_BLOCK) ? "kind:hay_bale" : "";
            case BED -> isBedRepresentative(state) ? "kind:bed" : "";
            case CONTAINER -> isContainerRepresentative(state) ? "kind:container" : "";
            case EXPOSED_STONE -> state.isIn(BlockTags.BASE_STONE_OVERWORLD)
                && isExposed(world, position) ? "kind:stone" : "";
            case EXPOSED_IRON -> state.isIn(BlockTags.IRON_ORES)
                && isExposed(world, position) ? "kind:iron_ore" : "";
            case EXPOSED_COAL -> state.isIn(BlockTags.COAL_ORES)
                && isExposed(world, position) ? "kind:coal_ore" : "";
            default -> "";
        };
    }

    private static boolean isExposedDiscovery(OpportunityScanner.DiscoveryType type) {
        return type == OpportunityScanner.DiscoveryType.EXPOSED_STONE
            || type == OpportunityScanner.DiscoveryType.EXPOSED_IRON
            || type == OpportunityScanner.DiscoveryType.EXPOSED_COAL;
    }

    private static String villageMarker(BlockState state) {
        if (state.isOf(Blocks.BELL)) {
            return "bell";
        }
        if (isVillageJobSite(state)) {
            return "job_site";
        }
        return isBedRepresentative(state) ? "bed" : "";
    }

    private static String portalEvidence(BlockState state) {
        if (state.isOf(Blocks.OBSIDIAN)) {
            return "obsidian";
        }
        if (state.isOf(Blocks.CRYING_OBSIDIAN)) {
            return "crying_obsidian";
        }
        if (state.isOf(Blocks.NETHERRACK)) {
            return "netherrack";
        }
        if (state.isOf(Blocks.MAGMA_BLOCK)) {
            return "magma";
        }
        return state.isOf(Blocks.GOLD_BLOCK) ? "gold_block" : "";
    }

    private static void addLiveTarget(
        Map<String, LiveTarget> targets,
        BlockPos position,
        boolean entity,
        String identity
    ) {
        if (position == null) {
            return;
        }
        BlockPos immutable = position.toImmutable();
        String key = (entity ? "entity:" + identity : "block:")
            + immutable.getX() + "," + immutable.getY() + "," + immutable.getZ();
        targets.putIfAbsent(key, new LiveTarget(immutable, entity, identity));
    }

    private record LiveTarget(BlockPos position, boolean entity, String identity) {
        LiveTarget {
            identity = identity == null ? "" : identity.trim().toLowerCase(Locale.ROOT);
        }
    }

    private record DiscoveryValidation(List<LiveTarget> targets, List<String> signals) {
    }

    private static WireDiscovery disappeared(WireDiscovery previous, long observedAtMs) {
        return new WireDiscovery(
            previous.id(),
            previous.type(),
            previous.x(),
            previous.y(),
            previous.z(),
            previous.memberCount(),
            0.0D,
            List.of("disappeared"),
            observedAtMs,
            "disappeared",
            previous.capabilityId(),
            previous.executorId(),
            false,
            "disappeared",
            previous.readinessSource()
        );
    }

    static List<WireDiscovery> reconcileDiscoveries(
        List<WireDiscovery> current,
        List<WireDiscovery> previous,
        Predicate<WireDiscovery> sourceStillObserved,
        boolean truncated,
        long observedAtMs
    ) {
        List<WireDiscovery> normalizedCurrent = current == null
            ? List.of()
            : current.stream().filter(java.util.Objects::nonNull).toList();
        if (truncated || previous == null || previous.isEmpty() || sourceStillObserved == null) {
            return normalizedCurrent;
        }
        java.util.Set<String> currentIds = normalizedCurrent.stream()
            .map(WireDiscovery::id)
            .collect(java.util.stream.Collectors.toSet());
        List<WireDiscovery> result = new ArrayList<>();
        normalizedCurrent.stream()
            .filter(discovery -> "disappeared".equals(discovery.status()))
            .forEach(result::add);
        previous.stream()
            .filter(java.util.Objects::nonNull)
            .filter(prior -> !"disappeared".equals(prior.status()))
            .filter(prior -> !currentIds.contains(prior.id()))
            .filter(sourceStillObserved)
            .sorted(Comparator.comparing(WireDiscovery::id))
            .map(prior -> disappeared(prior, observedAtMs))
            .forEach(result::add);
        normalizedCurrent.stream()
            .filter(discovery -> !"disappeared".equals(discovery.status()))
            .forEach(result::add);
        return List.copyOf(result);
    }

    private Snapshot emptySnapshot() {
        OpportunityScanner.ScanResult scan = OpportunityScanner.scan(null);
        return new Snapshot(List.of(), List.of(), scan, stats());
    }

    private static long squaredDistance(BlockPos left, BlockPos right) {
        long dx = (long) left.getX() - right.getX();
        long dy = (long) left.getY() - right.getY();
        long dz = (long) left.getZ() - right.getZ();
        return dx * dx + dy * dy + dz * dz;
    }

    private static int comparePosition(BlockPos left, BlockPos right) {
        int y = Integer.compare(left.getY(), right.getY());
        if (y != 0) {
            return y;
        }
        int z = Integer.compare(left.getZ(), right.getZ());
        return z != 0 ? z : Integer.compare(left.getX(), right.getX());
    }

    private static final class BlockBuckets {
        private final EnumMap<OpportunityScanner.BlockKind,
            List<OpportunityScanner.BlockObservation>> observations =
            new EnumMap<>(OpportunityScanner.BlockKind.class);

        private void add(OpportunityScanner.BlockObservation observation) {
            if (observation == null || observation.kind() == OpportunityScanner.BlockKind.OTHER) {
                return;
            }
            List<OpportunityScanner.BlockObservation> bucket = observations.computeIfAbsent(
                observation.kind(), ignored -> new ArrayList<>());
            if (bucket.size() < MAX_OBSERVATIONS_PER_BLOCK_KIND) {
                bucket.add(observation);
            }
        }

        private boolean isFull(OpportunityScanner.BlockKind kind) {
            return observations.getOrDefault(kind, List.of()).size()
                >= MAX_OBSERVATIONS_PER_BLOCK_KIND;
        }

        private boolean fullForAll(List<OpportunityScanner.BlockKind> kinds) {
            return !kinds.isEmpty() && kinds.stream().allMatch(this::isFull);
        }

        private List<OpportunityScanner.BlockObservation> flatten() {
            List<OpportunityScanner.BlockObservation> result = new ArrayList<>();
            for (int rank = 0; rank < MAX_OBSERVATIONS_PER_BLOCK_KIND
                && result.size() < OpportunityScanner.MAX_BLOCKS_PER_CHUNK; rank++) {
                for (OpportunityScanner.BlockKind kind : BLOCK_KIND_WIRE_ORDER) {
                    List<OpportunityScanner.BlockObservation> bucket = observations.getOrDefault(
                        kind, List.of());
                    if (rank < bucket.size()) {
                        result.add(bucket.get(rank));
                        if (result.size() >= OpportunityScanner.MAX_BLOCKS_PER_CHUNK) {
                            break;
                        }
                    }
                }
            }
            return List.copyOf(result);
        }
    }
}
