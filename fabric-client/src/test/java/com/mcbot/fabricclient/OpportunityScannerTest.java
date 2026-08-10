package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.IntStream;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class OpportunityScannerTest {
    @Test
    void emitsEveryTypedDiscoveryAndIgnoresCandidateOrder() {
        List<OpportunityScanner.BlockObservation> blocks = representativeBlocks();
        List<OpportunityScanner.EntityObservation> entities = representativeEntities();
        OpportunityScanner.ScanResult forward = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, blocks, entities));

        List<OpportunityScanner.BlockObservation> reversedBlocks = new ArrayList<>(blocks);
        List<OpportunityScanner.EntityObservation> reversedEntities = new ArrayList<>(entities);
        Collections.reverse(reversedBlocks);
        Collections.reverse(reversedEntities);
        OpportunityScanner.ScanResult reversed = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, reversedBlocks, reversedEntities));

        assertEquals(EnumSet.allOf(OpportunityScanner.DiscoveryType.class), discoveryTypes(forward));
        assertEquals(forward, reversed);
        assertFalse(forward.truncated());
        assertEquals(1, forward.chunksExamined());
        assertEquals(blocks.size(), forward.blocksExamined());
        assertEquals(entities.size(), forward.entitiesExamined());
    }

    @Test
    void stableIdsIgnoreObservationTimeButIsolateWorldAndDimension() {
        OpportunityScanner.ScanResult first = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, representativeBlocks(), representativeEntities()));
        OpportunityScanner.ScanResult later = OpportunityScanner.scan(request(
            "world-a", "overworld", 9_000L, representativeBlocks(), representativeEntities()));
        OpportunityScanner.ScanResult otherWorld = OpportunityScanner.scan(request(
            "world-b", "overworld", 1_000L, representativeBlocks(), representativeEntities()));
        OpportunityScanner.ScanResult otherDimension = OpportunityScanner.scan(request(
            "world-a", "the_nether", 1_000L, representativeBlocks(), representativeEntities()));

        assertEquals(idsByType(first), idsByType(later));
        assertNotEquals(allIds(first), allIds(otherWorld));
        assertNotEquals(allIds(first), allIds(otherDimension));
        assertTrue(first.discoveries().stream().noneMatch(discovery ->
            discovery.stableId().contains("world-a") || discovery.stableId().contains("overworld")));
    }

    @Test
    void villageClusterRequiresCorroborationAndCarriesBoundedEvidence() {
        List<OpportunityScanner.BlockObservation> loneBed = List.of(block(
            1, 64, 1, OpportunityScanner.BlockKind.BED, false));
        OpportunityScanner.ScanResult uncorroborated = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, loneBed, List.of()));
        assertTrue(uncorroborated.discoveriesOfType(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER).isEmpty());

        OpportunityScanner.EntityObservation villager = entity(
            "villager-1", OpportunityScanner.EntityKind.VILLAGER, "farmer", 2, 64, 1, true);
        OpportunityScanner.ScanResult corroborated = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, loneBed, List.of(villager)));
        OpportunityScanner.Discovery cluster = corroborated.discoveriesOfType(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER).getFirst();

        assertEquals(2, cluster.memberCount());
        assertTrue(cluster.confidence() >= 0.70D);
        assertTrue(cluster.signals().contains("bed"));
        assertTrue(cluster.signals().contains("villager"));
        assertEquals(List.of("villager-1"), cluster.entityIds());
        assertTrue(cluster.samplePositions().size() <= OpportunityScanner.MAX_SAMPLES_PER_DISCOVERY);
    }

    @Test
    void resourceAndEntityEvidenceFailsClosed() {
        List<OpportunityScanner.BlockObservation> blocks = List.of(
            block(1, 63, 1, OpportunityScanner.BlockKind.STONE, false),
            block(2, 63, 1, OpportunityScanner.BlockKind.IRON_ORE, false),
            block(3, 63, 1, OpportunityScanner.BlockKind.COAL_ORE, false),
            block(4, 64, 1, OpportunityScanner.BlockKind.OTHER, true)
        );
        List<OpportunityScanner.EntityObservation> entities = List.of(
            entity("dead-cow", OpportunityScanner.EntityKind.PASSIVE_FOOD, "cow", 5, 64, 1, false),
            entity("zombie", OpportunityScanner.EntityKind.HOSTILE, "zombie", 6, 64, 1, true),
            entity("unknown", OpportunityScanner.EntityKind.OTHER, "", 7, 64, 1, true)
        );

        OpportunityScanner.ScanResult result = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, blocks, entities));

        assertTrue(result.discoveries().isEmpty());
    }

    @Test
    void onlyExplicitAccessibilityProofProducesTheAuthoritativeSignal() {
        OpportunityScanner.BlockObservation merelyExposed = new OpportunityScanner.BlockObservation(
            new BlockPos(1, 64, 1),
            OpportunityScanner.BlockKind.HAY_BALE,
            true,
            false,
            true,
            "hay"
        );
        OpportunityScanner.BlockObservation proven = new OpportunityScanner.BlockObservation(
            new BlockPos(2, 64, 1),
            OpportunityScanner.BlockKind.BED,
            true,
            true,
            true,
            "bed"
        );
        OpportunityScanner.EntityObservation safeButUnreachable =
            new OpportunityScanner.EntityObservation(
                "cow", OpportunityScanner.EntityKind.PASSIVE_FOOD, "cow",
                new BlockPos(3, 64, 1), true, false, true);

        OpportunityScanner.ScanResult result = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L,
            List.of(merelyExposed, proven), List.of(safeButUnreachable)));

        OpportunityScanner.Discovery hay = result.discoveriesOfType(
            OpportunityScanner.DiscoveryType.HAY).getFirst();
        OpportunityScanner.Discovery bed = result.discoveriesOfType(
            OpportunityScanner.DiscoveryType.BED).getFirst();
        OpportunityScanner.Discovery cow = result.discoveriesOfType(
            OpportunityScanner.DiscoveryType.PASSIVE_FOOD).getFirst();
        assertFalse(hay.signals().contains("access_proven"));
        assertTrue(bed.signals().contains("access_proven"));
        assertFalse(cow.signals().contains("access_proven"));
        assertTrue(cow.signals().contains("hazard_free"));
        assertTrue(result.discoveries().stream().noneMatch(discovery ->
            discovery.signals().contains("accessible")));
    }

    @Test
    void ruinedPortalNeedsFrameAndCorroboratingEvidence() {
        OpportunityScanner.ScanResult terrainOnly = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L,
            List.of(block(1, 64, 1, OpportunityScanner.BlockKind.PORTAL_NETHERRACK, true)),
            List.of()));
        OpportunityScanner.ScanResult frameOnly = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L,
            List.of(block(1, 64, 1, OpportunityScanner.BlockKind.PORTAL_OBSIDIAN, true)),
            List.of()));
        OpportunityScanner.ScanResult corroborated = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L,
            List.of(
                block(1, 64, 1, OpportunityScanner.BlockKind.PORTAL_OBSIDIAN, true),
                block(2, 64, 1, OpportunityScanner.BlockKind.PORTAL_NETHERRACK, true)
            ),
            List.of()));

        assertTrue(terrainOnly.discoveriesOfType(
            OpportunityScanner.DiscoveryType.RUINED_PORTAL_EVIDENCE).isEmpty());
        assertTrue(frameOnly.discoveriesOfType(
            OpportunityScanner.DiscoveryType.RUINED_PORTAL_EVIDENCE).isEmpty());
        assertEquals(1, corroborated.discoveriesOfType(
            OpportunityScanner.DiscoveryType.RUINED_PORTAL_EVIDENCE).size());
    }

    @Test
    void entityInputAndDiscoveryCapsAreDeterministic() {
        List<OpportunityScanner.EntityObservation> entities = IntStream.range(0, 300)
            .mapToObj(index -> entity(
                "villager-" + index,
                OpportunityScanner.EntityKind.VILLAGER,
                "farmer",
                index % 16,
                64,
                index / 16,
                true
            ))
            .toList();
        OpportunityScanner.ScanResult forward = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, List.of(), entities));
        List<OpportunityScanner.EntityObservation> reversed = new ArrayList<>(entities);
        Collections.reverse(reversed);
        OpportunityScanner.ScanResult backward = OpportunityScanner.scan(request(
            "world-a", "overworld", 1_000L, List.of(), reversed));

        assertEquals(OpportunityScanner.MAX_ENTITY_OBSERVATIONS, forward.entitiesExamined());
        assertEquals(OpportunityScanner.MAX_DISCOVERIES_PER_TYPE, forward.discoveriesOfType(
            OpportunityScanner.DiscoveryType.VILLAGER).size());
        assertTrue(forward.discoveries().size() <= OpportunityScanner.MAX_DISCOVERIES);
        assertTrue(forward.truncated());
        assertEquals(44, forward.rejectionCounts().get("entity_cap"));
        assertTrue(forward.rejectionCounts().get("discovery_cap") > 0);
        assertEquals(forward, backward);
    }

    @Test
    void mismatchedChunkObservationIsRejectedWithoutFabricatingDiscovery() {
        OpportunityScanner.ScanRequest request = new OpportunityScanner.ScanRequest(
            "world-a",
            "overworld",
            BlockPos.ORIGIN,
            1_000L,
            List.of(new OpportunityScanner.ChunkObservation(
                0,
                0,
                List.of(block(32, 64, 32, OpportunityScanner.BlockKind.HAY_BALE, true))
            )),
            List.of()
        );

        OpportunityScanner.ScanResult result = OpportunityScanner.scan(request);

        assertTrue(result.discoveries().isEmpty());
        assertEquals(0, result.blocksExamined());
        assertEquals(1, result.rejectionCounts().get("invalid_or_mismatched_block"));
    }

    @Test
    void invalidWorldIdentityFailsClosed() {
        OpportunityScanner.ScanResult result = OpportunityScanner.scan(new OpportunityScanner.ScanRequest(
            "",
            "overworld",
            BlockPos.ORIGIN,
            1_000L,
            List.of(new OpportunityScanner.ChunkObservation(
                0, 0, List.of(block(1, 64, 1, OpportunityScanner.BlockKind.HAY_BALE, true)))),
            List.of()
        ));

        assertTrue(result.discoveries().isEmpty());
        assertEquals(Map.of("invalid_world_identity", 1), result.rejectionCounts());
    }

    @Test
    void scannerSourceCannotReadWorldOrAttachToTickLoop() throws IOException {
        String source = Files.readString(Path.of(
            "src/main/java/com/mcbot/fabricclient/OpportunityScanner.java"));

        assertFalse(source.contains("MinecraftClient"));
        assertFalse(source.contains("ClientWorld"));
        assertFalse(source.contains("getBlockState("));
        assertFalse(source.contains("getEntities("));
        assertFalse(source.contains("void tick("));
        assertFalse(source.contains("currentTimeMillis("));
    }

    private static OpportunityScanner.ScanRequest request(
        String world,
        String dimension,
        long observedAtMs,
        List<OpportunityScanner.BlockObservation> blocks,
        List<OpportunityScanner.EntityObservation> entities
    ) {
        return new OpportunityScanner.ScanRequest(
            world,
            dimension,
            BlockPos.ORIGIN,
            observedAtMs,
            List.of(new OpportunityScanner.ChunkObservation(0, 0, blocks)),
            entities
        );
    }

    private static List<OpportunityScanner.BlockObservation> representativeBlocks() {
        return List.of(
            block(1, 64, 1, OpportunityScanner.BlockKind.VILLAGE_BELL, true),
            block(2, 64, 1, OpportunityScanner.BlockKind.VILLAGE_JOB_SITE, true),
            block(3, 64, 1, OpportunityScanner.BlockKind.BED, true),
            block(4, 64, 1, OpportunityScanner.BlockKind.HAY_BALE, true),
            block(5, 64, 1, OpportunityScanner.BlockKind.CONTAINER, true),
            block(6, 63, 1, OpportunityScanner.BlockKind.STONE, true),
            block(7, 63, 1, OpportunityScanner.BlockKind.IRON_ORE, true),
            block(8, 63, 1, OpportunityScanner.BlockKind.COAL_ORE, true),
            block(10, 64, 10, OpportunityScanner.BlockKind.PORTAL_OBSIDIAN, true),
            block(11, 64, 10, OpportunityScanner.BlockKind.PORTAL_CRYING_OBSIDIAN, true),
            block(10, 64, 11, OpportunityScanner.BlockKind.PORTAL_NETHERRACK, true)
        );
    }

    private static List<OpportunityScanner.EntityObservation> representativeEntities() {
        return List.of(
            entity("villager-a", OpportunityScanner.EntityKind.VILLAGER, "farmer", 1, 64, 2, true),
            entity("golem-a", OpportunityScanner.EntityKind.IRON_GOLEM, "iron_golem", 2, 64, 2, true),
            entity("cow-a", OpportunityScanner.EntityKind.PASSIVE_FOOD, "cow", 12, 64, 2, true)
        );
    }

    private static OpportunityScanner.BlockObservation block(
        int x,
        int y,
        int z,
        OpportunityScanner.BlockKind kind,
        boolean exposed
    ) {
        return new OpportunityScanner.BlockObservation(
            new BlockPos(x, y, z), kind, exposed, true, true, kind.name().toLowerCase());
    }

    private static OpportunityScanner.EntityObservation entity(
        String id,
        OpportunityScanner.EntityKind kind,
        String subtype,
        int x,
        int y,
        int z,
        boolean alive
    ) {
        return new OpportunityScanner.EntityObservation(
            id, kind, subtype, new BlockPos(x, y, z), alive, true, true);
    }

    private static Set<OpportunityScanner.DiscoveryType> discoveryTypes(
        OpportunityScanner.ScanResult result
    ) {
        EnumSet<OpportunityScanner.DiscoveryType> types = EnumSet.noneOf(
            OpportunityScanner.DiscoveryType.class);
        result.discoveries().forEach(discovery -> types.add(discovery.type()));
        return types;
    }

    private static Map<OpportunityScanner.DiscoveryType, List<String>> idsByType(
        OpportunityScanner.ScanResult result
    ) {
        Map<OpportunityScanner.DiscoveryType, List<String>> ids = new EnumMap<>(
            OpportunityScanner.DiscoveryType.class);
        for (OpportunityScanner.DiscoveryType type : OpportunityScanner.DiscoveryType.values()) {
            ids.put(type, result.discoveriesOfType(type).stream()
                .map(OpportunityScanner.Discovery::stableId)
                .sorted()
                .toList());
        }
        return ids;
    }

    private static Set<String> allIds(OpportunityScanner.ScanResult result) {
        return result.discoveries().stream()
            .map(OpportunityScanner.Discovery::stableId)
            .collect(java.util.stream.Collectors.toSet());
    }
}
