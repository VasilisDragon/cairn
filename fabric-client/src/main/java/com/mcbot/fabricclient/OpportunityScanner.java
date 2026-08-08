package com.mcbot.fabricclient;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import net.minecraft.util.math.BlockPos;

/**
 * Pure, event-driven opportunity discovery over observations supplied by a throttled caller.
 *
 * <p>This class deliberately has no client, world, chunk-manager, or tick-loop access. It normalizes,
 * ranks, clusters, and caps an immutable observation batch. A discovery proves only that the supplied
 * observation was classified; it never grants inventory, reachability, route, or action authority.
 */
final class OpportunityScanner {
    static final int MAX_CHUNKS = 32;
    static final int MAX_BLOCKS_PER_CHUNK = 256;
    static final int MAX_BLOCK_OBSERVATIONS = 4_096;
    static final int MAX_ENTITY_OBSERVATIONS = 256;
    static final int MAX_DISCOVERIES = 256;
    static final int MAX_DISCOVERIES_PER_TYPE = 64;
    static final int MAX_SAMPLES_PER_DISCOVERY = 8;
    static final int MAX_CLUSTER_SIGNALS = 128;
    static final int VILLAGE_CLUSTER_RADIUS = 48;
    static final int VILLAGE_CLUSTER_VERTICAL = 16;
    static final int PORTAL_CLUSTER_RADIUS = 16;
    static final int PORTAL_CLUSTER_VERTICAL = 8;

    private OpportunityScanner() {
    }

    enum DiscoveryType {
        VILLAGE_MARKER_CLUSTER,
        VILLAGER,
        IRON_GOLEM,
        HAY,
        BED,
        CONTAINER,
        EXPOSED_STONE,
        EXPOSED_IRON,
        EXPOSED_COAL,
        PASSIVE_FOOD,
        RUINED_PORTAL_EVIDENCE
    }

    /** Semantic classification performed by the caller while it already owns world access. */
    enum BlockKind {
        VILLAGE_BELL,
        VILLAGE_JOB_SITE,
        HAY_BALE,
        BED,
        CONTAINER,
        STONE,
        IRON_ORE,
        COAL_ORE,
        PORTAL_OBSIDIAN,
        PORTAL_CRYING_OBSIDIAN,
        PORTAL_NETHERRACK,
        PORTAL_MAGMA,
        PORTAL_GOLD_BLOCK,
        OTHER
    }

    enum EntityKind {
        VILLAGER,
        IRON_GOLEM,
        PASSIVE_FOOD,
        HOSTILE,
        OTHER
    }

    record BlockObservation(
        BlockPos position,
        BlockKind kind,
        boolean exposed,
        boolean accessible,
        boolean hazardFree,
        String detail
    ) {
        BlockObservation {
            position = position == null ? null : position.toImmutable();
            kind = kind == null ? BlockKind.OTHER : kind;
            detail = normalizedText(detail);
        }

        BlockObservation(
            BlockPos position,
            BlockKind kind,
            boolean exposed,
            boolean accessible,
            boolean hazardFree
        ) {
            this(position, kind, exposed, accessible, hazardFree, "");
        }
    }

    record ChunkObservation(int chunkX, int chunkZ, List<BlockObservation> blocks) {
        ChunkObservation {
            blocks = blocks == null ? List.of() : List.copyOf(blocks);
        }
    }

    record EntityObservation(
        String stableEntityId,
        EntityKind kind,
        String subtype,
        BlockPos position,
        boolean alive,
        boolean accessible,
        boolean hazardFree
    ) {
        EntityObservation {
            stableEntityId = normalizedText(stableEntityId);
            kind = kind == null ? EntityKind.OTHER : kind;
            subtype = normalizedText(subtype);
            position = position == null ? null : position.toImmutable();
        }
    }

    record ScanRequest(
        String worldIdentity,
        String dimensionIdentity,
        BlockPos origin,
        long observedAtMs,
        List<ChunkObservation> chunks,
        List<EntityObservation> entities
    ) {
        ScanRequest {
            worldIdentity = normalizedText(worldIdentity);
            dimensionIdentity = normalizedText(dimensionIdentity);
            origin = origin == null ? BlockPos.ORIGIN : origin.toImmutable();
            observedAtMs = Math.max(0L, observedAtMs);
            chunks = chunks == null ? List.of() : List.copyOf(chunks);
            entities = entities == null ? List.of() : List.copyOf(entities);
        }
    }

    record Discovery(
        String stableId,
        DiscoveryType type,
        BlockPos anchor,
        int memberCount,
        double confidence,
        List<String> signals,
        List<BlockPos> samplePositions,
        List<String> entityIds,
        long observedAtMs
    ) {
        Discovery {
            stableId = normalizedText(stableId);
            if (type == null || stableId.isBlank() || anchor == null) {
                throw new IllegalArgumentException("discovery requires stable identity, type, and anchor");
            }
            anchor = anchor.toImmutable();
            memberCount = Math.max(1, memberCount);
            confidence = clampConfidence(confidence);
            signals = sortedDistinctStrings(signals);
            samplePositions = sortedDistinctPositions(samplePositions, MAX_SAMPLES_PER_DISCOVERY);
            entityIds = sortedDistinctStrings(entityIds).stream()
                .limit(MAX_SAMPLES_PER_DISCOVERY)
                .toList();
            observedAtMs = Math.max(0L, observedAtMs);
        }
    }

    record ScanResult(
        List<Discovery> discoveries,
        int chunksExamined,
        int blocksExamined,
        int entitiesExamined,
        boolean truncated,
        Map<String, Integer> rejectionCounts
    ) {
        ScanResult {
            discoveries = discoveries == null ? List.of() : List.copyOf(discoveries);
            chunksExamined = Math.max(0, chunksExamined);
            blocksExamined = Math.max(0, blocksExamined);
            entitiesExamined = Math.max(0, entitiesExamined);
            TreeMap<String, Integer> normalized = new TreeMap<>();
            if (rejectionCounts != null) {
                rejectionCounts.forEach((reason, count) -> {
                    String key = normalizedText(reason);
                    if (!key.isBlank() && count != null && count > 0) {
                        normalized.merge(key, count, Integer::sum);
                    }
                });
            }
            rejectionCounts = Collections.unmodifiableMap(normalized);
        }

        List<Discovery> discoveriesOfType(DiscoveryType type) {
            return discoveries.stream().filter(discovery -> discovery.type() == type).toList();
        }
    }

    static ScanResult scan(ScanRequest request) {
        if (request == null
            || request.worldIdentity().isBlank()
            || request.dimensionIdentity().isBlank()) {
            return new ScanResult(
                List.of(), 0, 0, 0, false, Map.of("invalid_world_identity", 1));
        }

        MutableCounts counts = new MutableCounts();
        List<ChunkObservation> chunks = boundedChunks(request, counts);
        List<BlockObservation> blocks = boundedBlocks(request, chunks, counts);
        List<EntityObservation> entities = boundedEntities(request, counts);

        List<Discovery> candidates = new ArrayList<>();
        addVillageClusters(request, blocks, entities, candidates);
        addEntityDiscoveries(request, entities, candidates);
        addBlockDiscoveries(request, blocks, candidates);
        addPortalDiscoveries(request, blocks, candidates);

        List<Discovery> bounded = roundRobinBound(request.origin(), candidates);
        if (candidates.size() > bounded.size()) {
            counts.truncated = true;
            counts.reject("discovery_cap", candidates.size() - bounded.size());
        }
        return new ScanResult(
            bounded,
            chunks.size(),
            blocks.size(),
            entities.size(),
            counts.truncated,
            counts.rejections
        );
    }

    private static List<ChunkObservation> boundedChunks(ScanRequest request, MutableCounts counts) {
        List<ChunkObservation> valid = request.chunks().stream()
            .filter(chunk -> chunk != null)
            .sorted(Comparator
                .comparingLong((ChunkObservation chunk) -> chunkDistanceSquared(request.origin(), chunk))
                .thenComparingInt(ChunkObservation::chunkZ)
                .thenComparingInt(ChunkObservation::chunkX))
            .toList();
        if (valid.size() < request.chunks().size()) {
            counts.reject("null_chunk", request.chunks().size() - valid.size());
        }
        if (valid.size() > MAX_CHUNKS) {
            counts.truncated = true;
            counts.reject("chunk_cap", valid.size() - MAX_CHUNKS);
        }
        return List.copyOf(valid.subList(0, Math.min(MAX_CHUNKS, valid.size())));
    }

    private static List<BlockObservation> boundedBlocks(
        ScanRequest request,
        List<ChunkObservation> chunks,
        MutableCounts counts
    ) {
        List<BlockObservation> accepted = new ArrayList<>();
        for (ChunkObservation chunk : chunks) {
            List<BlockObservation> valid = chunk.blocks().stream()
                .filter(block -> block != null
                    && block.position() != null
                    && blockChunk(block.position().getX()) == chunk.chunkX()
                    && blockChunk(block.position().getZ()) == chunk.chunkZ())
                .sorted(blockComparator(request.origin()))
                .toList();
            if (valid.size() < chunk.blocks().size()) {
                counts.reject("invalid_or_mismatched_block", chunk.blocks().size() - valid.size());
            }
            if (valid.size() > MAX_BLOCKS_PER_CHUNK) {
                counts.truncated = true;
                counts.reject("per_chunk_block_cap", valid.size() - MAX_BLOCKS_PER_CHUNK);
            }
            accepted.addAll(valid.subList(0, Math.min(MAX_BLOCKS_PER_CHUNK, valid.size())));
        }
        accepted.sort(blockComparator(request.origin()));
        if (accepted.size() > MAX_BLOCK_OBSERVATIONS) {
            counts.truncated = true;
            counts.reject("block_cap", accepted.size() - MAX_BLOCK_OBSERVATIONS);
        }
        return List.copyOf(accepted.subList(0, Math.min(MAX_BLOCK_OBSERVATIONS, accepted.size())));
    }

    private static List<EntityObservation> boundedEntities(ScanRequest request, MutableCounts counts) {
        List<EntityObservation> valid = request.entities().stream()
            .filter(entity -> entity != null
                && entity.position() != null
                && !entity.stableEntityId().isBlank())
            .sorted(entityComparator(request.origin()))
            .toList();
        if (valid.size() < request.entities().size()) {
            counts.reject("invalid_entity", request.entities().size() - valid.size());
        }
        if (valid.size() > MAX_ENTITY_OBSERVATIONS) {
            counts.truncated = true;
            counts.reject("entity_cap", valid.size() - MAX_ENTITY_OBSERVATIONS);
        }
        return List.copyOf(valid.subList(0, Math.min(MAX_ENTITY_OBSERVATIONS, valid.size())));
    }

    private static void addVillageClusters(
        ScanRequest request,
        List<BlockObservation> blocks,
        List<EntityObservation> entities,
        List<Discovery> output
    ) {
        List<Signal> markers = new ArrayList<>();
        Set<BlockPos> safeAccessPositions = new HashSet<>();
        for (BlockObservation block : blocks) {
            String label = switch (block.kind()) {
                case VILLAGE_BELL -> "bell";
                case VILLAGE_JOB_SITE -> "job_site";
                case BED -> "bed";
                default -> "";
            };
            if (!label.isBlank()) {
                markers.add(new Signal(block.position(), label, ""));
                if (block.accessible() && block.hazardFree()) {
                    safeAccessPositions.add(block.position());
                }
            }
        }
        for (EntityObservation entity : entities) {
            if (!entity.alive()) {
                continue;
            }
            if (entity.kind() == EntityKind.VILLAGER) {
                markers.add(new Signal(entity.position(), "villager", entity.stableEntityId()));
            } else if (entity.kind() == EntityKind.IRON_GOLEM) {
                markers.add(new Signal(entity.position(), "iron_golem", entity.stableEntityId()));
            }
            if (entity.accessible() && entity.hazardFree()) {
                safeAccessPositions.add(entity.position());
            }
        }
        markers = boundedSignals(request.origin(), markers);
        for (List<Signal> cluster : clusters(
            markers, VILLAGE_CLUSTER_RADIUS, VILLAGE_CLUSTER_VERTICAL)) {
            Set<String> labels = cluster.stream().map(Signal::label)
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
            long villagers = cluster.stream().filter(signal -> signal.label().equals("villager")).count();
            if (cluster.size() < 2 || labels.size() < 2 && villagers < 2) {
                continue;
            }
            BlockPos anchor = minimumPosition(cluster.stream().map(Signal::position).toList());
            List<String> signals = new ArrayList<>(labels);
            signals.add("marker_count:" + cluster.size());
            if (cluster.stream().anyMatch(signal -> safeAccessPositions.contains(signal.position()))) {
                signals.add("access_proven");
                signals.add("hazard_free");
            }
            double confidence = Math.min(0.99D, 0.55D + labels.size() * 0.08D
                + Math.min(5, cluster.size()) * 0.04D);
            output.add(discovery(
                request,
                DiscoveryType.VILLAGE_MARKER_CLUSTER,
                "cluster:" + positionKey(anchor),
                anchor,
                cluster.size(),
                confidence,
                signals,
                cluster.stream().map(Signal::position).toList(),
                cluster.stream().map(Signal::entityId).filter(id -> !id.isBlank()).toList()
            ));
        }
    }

    private static void addEntityDiscoveries(
        ScanRequest request,
        List<EntityObservation> entities,
        List<Discovery> output
    ) {
        for (EntityObservation entity : entities) {
            if (!entity.alive()) {
                continue;
            }
            DiscoveryType type = switch (entity.kind()) {
                case VILLAGER -> DiscoveryType.VILLAGER;
                case IRON_GOLEM -> DiscoveryType.IRON_GOLEM;
                case PASSIVE_FOOD -> DiscoveryType.PASSIVE_FOOD;
                default -> null;
            };
            if (type == null) {
                continue;
            }
            List<String> signals = new ArrayList<>();
            signals.add("alive");
            if (entity.accessible()) {
                signals.add("access_proven");
            }
            if (entity.hazardFree()) {
                signals.add("hazard_free");
            } else {
                signals.add("hazard_present");
            }
            if (!entity.subtype().isBlank()) {
                signals.add("subtype:" + entity.subtype());
            }
            output.add(discovery(
                request,
                type,
                "entity:" + entity.stableEntityId(),
                entity.position(),
                1,
                0.99D,
                signals,
                List.of(entity.position()),
                List.of(entity.stableEntityId())
            ));
        }
    }

    private static void addBlockDiscoveries(
        ScanRequest request,
        List<BlockObservation> blocks,
        List<Discovery> output
    ) {
        Map<PatchKey, List<BlockObservation>> patches = new TreeMap<>(Comparator
            .comparingInt((PatchKey key) -> key.type().ordinal())
            .thenComparingInt(PatchKey::chunkZ)
            .thenComparingInt(PatchKey::chunkX));
        List<BlockObservation> containers = new ArrayList<>();
        for (BlockObservation block : blocks) {
            DiscoveryType type = switch (block.kind()) {
                case HAY_BALE -> DiscoveryType.HAY;
                case BED -> DiscoveryType.BED;
                case CONTAINER -> DiscoveryType.CONTAINER;
                case STONE -> block.exposed() ? DiscoveryType.EXPOSED_STONE : null;
                case IRON_ORE -> block.exposed() ? DiscoveryType.EXPOSED_IRON : null;
                case COAL_ORE -> block.exposed() ? DiscoveryType.EXPOSED_COAL : null;
                default -> null;
            };
            if (type == null) {
                continue;
            }
            if (type == DiscoveryType.CONTAINER) {
                containers.add(block);
                continue;
            }
            PatchKey key = new PatchKey(
                type, blockChunk(block.position().getX()), blockChunk(block.position().getZ()));
            patches.computeIfAbsent(key, ignored -> new ArrayList<>()).add(block);
        }

        for (Map.Entry<PatchKey, List<BlockObservation>> entry : patches.entrySet()) {
            List<BlockObservation> members = entry.getValue().stream()
                .sorted(Comparator.comparing(BlockObservation::position, OpportunityScanner::comparePosition))
                .toList();
            BlockPos anchor = members.getFirst().position();
            List<String> signals = blockSignals(members);
            output.add(discovery(
                request,
                entry.getKey().type(),
                "patch:" + entry.getKey().chunkX() + "," + entry.getKey().chunkZ(),
                anchor,
                members.size(),
                0.98D,
                signals,
                members.stream().map(BlockObservation::position).toList(),
                List.of()
            ));
        }

        containers.stream()
            .sorted(Comparator.comparing(BlockObservation::position, OpportunityScanner::comparePosition))
            .limit(MAX_DISCOVERIES_PER_TYPE)
            .forEach(container -> output.add(discovery(
                request,
                DiscoveryType.CONTAINER,
                "block:" + positionKey(container.position()),
                container.position(),
                1,
                0.99D,
                blockSignals(List.of(container)),
                List.of(container.position()),
                List.of()
            )));
    }

    private static void addPortalDiscoveries(
        ScanRequest request,
        List<BlockObservation> blocks,
        List<Discovery> output
    ) {
        List<Signal> evidence = new ArrayList<>();
        for (BlockObservation block : blocks) {
            String signal = switch (block.kind()) {
                case PORTAL_OBSIDIAN -> "obsidian";
                case PORTAL_CRYING_OBSIDIAN -> "crying_obsidian";
                case PORTAL_NETHERRACK -> "netherrack";
                case PORTAL_MAGMA -> "magma";
                case PORTAL_GOLD_BLOCK -> "gold_block";
                default -> "";
            };
            if (!signal.isBlank()) {
                evidence.add(new Signal(block.position(), signal, ""));
            }
        }
        evidence = boundedSignals(request.origin(), evidence);
        for (List<Signal> cluster : clusters(
            evidence, PORTAL_CLUSTER_RADIUS, PORTAL_CLUSTER_VERTICAL)) {
            Set<String> labels = cluster.stream().map(Signal::label).collect(
                java.util.stream.Collectors.toCollection(LinkedHashSet::new));
            boolean hasFrame = labels.contains("obsidian") || labels.contains("crying_obsidian");
            if (!hasFrame || cluster.size() < 2) {
                continue;
            }
            BlockPos anchor = minimumPosition(cluster.stream().map(Signal::position).toList());
            double confidence = Math.min(0.98D, 0.45D
                + (labels.contains("crying_obsidian") ? 0.15D : 0.0D)
                + (labels.contains("netherrack") ? 0.15D : 0.0D)
                + (labels.contains("gold_block") ? 0.10D : 0.0D)
                + Math.min(5, cluster.size()) * 0.025D);
            output.add(discovery(
                request,
                DiscoveryType.RUINED_PORTAL_EVIDENCE,
                "cluster:" + positionKey(anchor),
                anchor,
                cluster.size(),
                confidence,
                new ArrayList<>(labels),
                cluster.stream().map(Signal::position).toList(),
                List.of()
            ));
        }
    }

    private static Discovery discovery(
        ScanRequest request,
        DiscoveryType type,
        String localKey,
        BlockPos anchor,
        int memberCount,
        double confidence,
        List<String> signals,
        List<BlockPos> samples,
        List<String> entityIds
    ) {
        return new Discovery(
            stableId(request, type, localKey),
            type,
            anchor,
            memberCount,
            confidence,
            signals,
            samples,
            entityIds,
            request.observedAtMs()
        );
    }

    private static String stableId(ScanRequest request, DiscoveryType type, String localKey) {
        String material = request.worldIdentity() + '\0'
            + request.dimensionIdentity() + '\0' + type.name() + '\0' + localKey;
        return type.name().toLowerCase() + ":"
            + UUID.nameUUIDFromBytes(material.getBytes(StandardCharsets.UTF_8));
    }

    private static List<String> blockSignals(List<BlockObservation> blocks) {
        Set<String> signals = new LinkedHashSet<>();
        for (BlockObservation block : blocks) {
            signals.add("kind:" + block.kind().name().toLowerCase());
            if (block.exposed()) {
                signals.add("exposed");
            }
            if (block.accessible()) {
                signals.add("access_proven");
            }
            if (block.hazardFree()) {
                signals.add("hazard_free");
            } else {
                signals.add("hazard_present");
            }
            if (!block.detail().isBlank()) {
                signals.add("detail:" + block.detail());
            }
        }
        return sortedDistinctStrings(new ArrayList<>(signals));
    }

    private static List<Signal> boundedSignals(BlockPos origin, List<Signal> signals) {
        return signals.stream()
            .sorted(Comparator
                .comparingLong((Signal signal) -> squaredDistance(origin, signal.position()))
                .thenComparing(Signal::position, OpportunityScanner::comparePosition)
                .thenComparing(Signal::label)
                .thenComparing(Signal::entityId))
            .limit(MAX_CLUSTER_SIGNALS)
            .toList();
    }

    private static List<List<Signal>> clusters(List<Signal> signals, int radius, int vertical) {
        List<Signal> remaining = new ArrayList<>(signals);
        remaining.sort(Comparator
            .comparing(Signal::position, OpportunityScanner::comparePosition)
            .thenComparing(Signal::label)
            .thenComparing(Signal::entityId));
        List<List<Signal>> result = new ArrayList<>();
        while (!remaining.isEmpty()) {
            Signal seed = remaining.removeFirst();
            List<Signal> cluster = new ArrayList<>();
            ArrayDeque<Signal> frontier = new ArrayDeque<>();
            frontier.add(seed);
            while (!frontier.isEmpty()) {
                Signal current = frontier.removeFirst();
                cluster.add(current);
                List<Signal> neighbors = remaining.stream()
                    .filter(candidate -> horizontallyClose(
                        current.position(), candidate.position(), radius, vertical))
                    .toList();
                frontier.addAll(neighbors);
                remaining.removeAll(neighbors);
            }
            cluster.sort(Comparator
                .comparing(Signal::position, OpportunityScanner::comparePosition)
                .thenComparing(Signal::label)
                .thenComparing(Signal::entityId));
            result.add(List.copyOf(cluster));
        }
        result.sort(Comparator.comparing(
            cluster -> cluster.getFirst().position(), OpportunityScanner::comparePosition));
        return List.copyOf(result);
    }

    private static List<Discovery> roundRobinBound(BlockPos origin, List<Discovery> candidates) {
        EnumMap<DiscoveryType, List<Discovery>> byType = new EnumMap<>(DiscoveryType.class);
        Comparator<Discovery> order = Comparator
            .comparingLong((Discovery discovery) -> squaredDistance(origin, discovery.anchor()))
            .thenComparing(Discovery::stableId);
        for (DiscoveryType type : DiscoveryType.values()) {
            List<Discovery> typed = candidates.stream()
                .filter(discovery -> discovery.type() == type)
                .sorted(order)
                .limit(MAX_DISCOVERIES_PER_TYPE)
                .toList();
            byType.put(type, typed);
        }
        List<Discovery> result = new ArrayList<>();
        for (int rank = 0; rank < MAX_DISCOVERIES_PER_TYPE && result.size() < MAX_DISCOVERIES; rank++) {
            for (DiscoveryType type : DiscoveryType.values()) {
                List<Discovery> typed = byType.get(type);
                if (rank < typed.size()) {
                    result.add(typed.get(rank));
                    if (result.size() >= MAX_DISCOVERIES) {
                        break;
                    }
                }
            }
        }
        return List.copyOf(result);
    }

    private static Comparator<BlockObservation> blockComparator(BlockPos origin) {
        return Comparator
            .comparingLong((BlockObservation block) -> squaredDistance(origin, block.position()))
            .thenComparing(BlockObservation::position, OpportunityScanner::comparePosition)
            .thenComparingInt(block -> block.kind().ordinal())
            .thenComparing(BlockObservation::detail);
    }

    private static Comparator<EntityObservation> entityComparator(BlockPos origin) {
        return Comparator
            .comparingLong((EntityObservation entity) -> squaredDistance(origin, entity.position()))
            .thenComparing(EntityObservation::stableEntityId)
            .thenComparingInt(entity -> entity.kind().ordinal());
    }

    private static int comparePosition(BlockPos left, BlockPos right) {
        int y = Integer.compare(left.getY(), right.getY());
        if (y != 0) {
            return y;
        }
        int z = Integer.compare(left.getZ(), right.getZ());
        return z != 0 ? z : Integer.compare(left.getX(), right.getX());
    }

    private static List<BlockPos> sortedDistinctPositions(List<BlockPos> positions, int limit) {
        if (positions == null || positions.isEmpty() || limit <= 0) {
            return List.of();
        }
        return positions.stream()
            .filter(position -> position != null)
            .map(BlockPos::toImmutable)
            .distinct()
            .sorted(OpportunityScanner::comparePosition)
            .limit(limit)
            .toList();
    }

    private static List<String> sortedDistinctStrings(List<String> values) {
        if (values == null || values.isEmpty()) {
            return List.of();
        }
        return values.stream()
            .map(OpportunityScanner::normalizedText)
            .filter(value -> !value.isBlank())
            .distinct()
            .sorted()
            .toList();
    }

    private static BlockPos minimumPosition(List<BlockPos> positions) {
        return positions.stream().min(OpportunityScanner::comparePosition).orElse(BlockPos.ORIGIN);
    }

    private static boolean horizontallyClose(
        BlockPos left,
        BlockPos right,
        int radius,
        int vertical
    ) {
        long dx = (long) left.getX() - right.getX();
        long dz = (long) left.getZ() - right.getZ();
        return Math.abs(left.getY() - right.getY()) <= vertical
            && dx * dx + dz * dz <= (long) radius * radius;
    }

    private static long squaredDistance(BlockPos left, BlockPos right) {
        long dx = (long) left.getX() - right.getX();
        long dy = (long) left.getY() - right.getY();
        long dz = (long) left.getZ() - right.getZ();
        return saturatedAdd(saturatedSquare(dx), saturatedAdd(saturatedSquare(dy), saturatedSquare(dz)));
    }

    private static long chunkDistanceSquared(BlockPos origin, ChunkObservation chunk) {
        long centerX = (long) chunk.chunkX() * 16L + 8L;
        long centerZ = (long) chunk.chunkZ() * 16L + 8L;
        long dx = origin.getX() - centerX;
        long dz = origin.getZ() - centerZ;
        return saturatedAdd(saturatedSquare(dx), saturatedSquare(dz));
    }

    private static long saturatedSquare(long value) {
        long absolute = value == Long.MIN_VALUE ? Long.MAX_VALUE : Math.abs(value);
        return absolute > 3_037_000_499L ? Long.MAX_VALUE : absolute * absolute;
    }

    private static long saturatedAdd(long left, long right) {
        return left > Long.MAX_VALUE - right ? Long.MAX_VALUE : left + right;
    }

    private static int blockChunk(int coordinate) {
        return Math.floorDiv(coordinate, 16);
    }

    private static String positionKey(BlockPos position) {
        return position.getX() + "," + position.getY() + "," + position.getZ();
    }

    private static String normalizedText(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    private static double clampConfidence(double value) {
        if (!Double.isFinite(value)) {
            return 0.0D;
        }
        return Math.max(0.0D, Math.min(1.0D, value));
    }

    private record Signal(BlockPos position, String label, String entityId) {
        private Signal {
            position = position.toImmutable();
            label = normalizedText(label);
            entityId = normalizedText(entityId);
        }
    }

    private record PatchKey(DiscoveryType type, int chunkX, int chunkZ) {
    }

    private static final class MutableCounts {
        private boolean truncated;
        private final Map<String, Integer> rejections = new LinkedHashMap<>();

        private void reject(String reason, int count) {
            if (count > 0) {
                rejections.merge(reason, count, Integer::sum);
            }
        }
    }
}
