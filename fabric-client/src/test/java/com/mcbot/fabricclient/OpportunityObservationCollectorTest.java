package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientChunkEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientEntityEvents;
import org.junit.jupiter.api.Test;

final class OpportunityObservationCollectorTest {
    @Test
    void eventHandlersAreDirectlyCompatibleWithFabricLifecycleEvents() {
        OpportunityObservationCollector collector = new OpportunityObservationCollector();

        ClientChunkEvents.Load chunkLoad = collector::onChunkLoaded;
        ClientChunkEvents.Unload chunkUnload = collector::onChunkUnloaded;
        ClientEntityEvents.Load entityLoad = collector::onEntityLoaded;
        ClientEntityEvents.Unload entityUnload = collector::onEntityUnloaded;

        assertTrue(chunkLoad != null && chunkUnload != null && entityLoad != null && entityUnload != null);
    }

    @Test
    void sourceUsesActualMinecraftBlocksOreTagsAndContainerTags() throws IOException {
        String source = collectorSource();

        for (String required : List.of(
            "Blocks.BELL",
            "Blocks.HAY_BLOCK",
            "BlockTags.BEDS",
            "Blocks.CHEST",
            "Blocks.BARREL",
            "Blocks.SMITHING_TABLE",
            "BlockTags.IRON_ORES",
            "BlockTags.COAL_ORES",
            "Blocks.OBSIDIAN",
            "Blocks.CRYING_OBSIDIAN",
            "Blocks.NETHERRACK",
            "Blocks.MAGMA_BLOCK",
            "Blocks.GOLD_BLOCK",
            "BlockTags.BASE_STONE_OVERWORLD",
            "BlockTags.SHULKER_BOXES"
        )) {
            assertTrue(source.contains(required), required);
        }
    }

    @Test
    void sourceUsesActualMinecraftEntityTypesForBoundedFoodAndVillageSignals() throws IOException {
        String source = collectorSource();

        for (String required : List.of(
            "EntityType.VILLAGER",
            "EntityType.IRON_GOLEM",
            "EntityType.COW",
            "EntityType.MOOSHROOM",
            "EntityType.PIG",
            "EntityType.SHEEP",
            "EntityType.CHICKEN",
            "EntityType.RABBIT"
        )) {
            assertTrue(source.contains(required), required);
        }
        assertFalse(source.contains("EntityType.ZOMBIE"));
        assertFalse(source.contains("EntityType.CAT"));
    }

    @Test
    void villageClusterUsesSemanticVillageWireTypeAndOthersUseSnakeCase() {
        assertEquals("village", OpportunityObservationCollector.wireType(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER));
        for (OpportunityScanner.DiscoveryType type : EnumSet.allOf(
            OpportunityScanner.DiscoveryType.class)) {
            String wire = OpportunityObservationCollector.wireType(type);
            assertFalse(wire.isBlank());
            assertEquals(wire.toLowerCase(Locale.ROOT), wire);
            assertFalse(wire.contains(" "));
            if (type != OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER) {
                assertEquals(type.name().toLowerCase(Locale.ROOT), wire);
            }
        }
    }

    @Test
    void wireRecordIsBoundedAndOmitsRoutesSamplesAndEntityDetails() {
        OpportunityObservationCollector.WireDiscovery wire =
            new OpportunityObservationCollector.WireDiscovery(
                "opaque-id",
                "village",
                10,
                64,
                20,
                4,
                0.85D,
                List.of("bed", "villager"),
                1_000L
            );

        Map<String, Object> map = wire.toMap();

        assertEquals(Set.of(
            "id", "type", "x", "y", "z", "memberCount", "confidence", "signals",
            "observedAtMs", "status", "capabilityId", "executorId", "executorReady",
            "readinessReason", "readinessSource"), map.keySet());
        assertEquals("village", map.get("type"));
        assertEquals("observed", map.get("status"));
        assertEquals(false, map.get("executorReady"));
        assertFalse(map.containsKey("route"));
        assertFalse(map.containsKey("samplePositions"));
        assertFalse(map.containsKey("entityIds"));
    }

    @Test
    void wireRecordCarriesStructuredCodeOwnedReadinessWithoutActionAuthority() {
        OpportunityObservationCollector.WireDiscovery wire =
            new OpportunityObservationCollector.WireDiscovery(
                "ore:one",
                "exposed_iron",
                2,
                16,
                3,
                1,
                0.99D,
                List.of(
                    "access_proven",
                    "hazard_free",
                    "executor_ready",
                    "readiness_source:code_owned_registry_v1"
                ),
                1_000L,
                "verified",
                "local_exposed_iron",
                "mine_nearby_iron",
                true,
                "code_owned_executor_ready",
                "code_owned_registry_v1"
            );

        Map<String, Object> map = wire.toMap();
        assertEquals("local_exposed_iron", map.get("capabilityId"));
        assertEquals("mine_nearby_iron", map.get("executorId"));
        assertEquals(true, map.get("executorReady"));
        assertEquals("code_owned_registry_v1", map.get("readinessSource"));
        assertFalse(map.containsKey("action"));
        assertFalse(map.containsKey("target"));
        assertFalse(map.containsKey("route"));
    }

    @Test
    void sourceHasNoTickBrainDispatchOrWholeWorldEntityScan() throws IOException {
        String source = collectorSource();

        assertFalse(source.contains("void tick("));
        assertFalse(source.contains("onClientTick"));
        assertFalse(source.contains("import com.mcbot.fabricclient.BrainLink"));
        assertFalse(source.contains("brainLink."));
        assertFalse(source.contains("world.getEntities("));
        assertFalse(source.contains("getEntitiesByClass("));
        assertTrue(source.contains("void onChunkLoaded(ClientWorld world, WorldChunk chunk)"));
        assertTrue(source.contains("void onChunkUnloaded(ClientWorld world, WorldChunk chunk)"));
        assertTrue(source.contains("void onEntityLoaded(Entity entity, ClientWorld world)"));
        assertTrue(source.contains("void onEntityUnloaded(Entity entity, ClientWorld world)"));
    }

    @Test
    void exactGolemIdentityRemainsBoundedInternalAndLifecycleScoped() throws IOException {
        String source = collectorSource();
        String resolver = method(source,
            "IronGolemEntity resolveExactIronGolem(");

        assertTrue(source.contains(
            "MAX_EXACT_ENTITY_IDENTITIES = MAX_WIRE_DISCOVERIES"));
        assertTrue(source.contains(
            "LinkedHashMap<String, UUID> exactEntityIdentities"));
        assertTrue(source.contains(
            "exactEntityIdentities.put(discovery.stableId(), rawIdentity)"));
        assertTrue(source.contains(
            "while (exactEntityIdentities.size() > MAX_EXACT_ENTITY_IDENTITIES)"));
        assertTrue(source.contains(
            "exactEntityIdentities.entrySet().removeIf"));
        assertTrue(resolver.contains("world != activeWorld"));
        assertTrue(resolver.contains("entity instanceof IronGolemEntity"));
        assertFalse(source.substring(
            source.indexOf("Map<String, Object> toMap()"),
            source.indexOf("private static String normalizeStatus"))
            .contains("entityId"));
    }

    @Test
    void entityExecutorAdmissionUsesApproachProofAndTargetSpecificDefenseVerdict()
        throws IOException {
        String source = collectorSource();
        String admission = method(source,
            "private boolean hasAccessibleExactExecutorTarget(");
        String readiness = method(source,
            "private OpportunityExecutorCapabilityRegistry.TargetReadiness golemTargetReadiness(");

        assertTrue(admission.contains("target.entity()"));
        assertTrue(admission.contains("access.canApproachEntity(target.position())"));
        assertTrue(readiness.contains("discovery.type() != OpportunityScanner.DiscoveryType.IRON_GOLEM"));
        assertTrue(readiness.contains("safeResolver.evaluate(discovery.stableId(), golem)"));
        assertTrue(source.contains("signals.addAll(readiness.wireSignals())"));
    }

    @Test
    void allCollectorAndCacheCapsAreHardAndFinite() {
        assertTrue(OpportunityObservationCollector.MAX_TRACKED_ENTITIES > 0);
        assertTrue(OpportunityObservationCollector.MAX_OBSERVATIONS_PER_BLOCK_KIND > 0);
        assertTrue(OpportunityObservationCache.MAX_CACHED_CHUNKS > 0);
        assertTrue(OpportunityObservationCache.MAX_CACHED_BLOCK_OBSERVATIONS > 0);
        assertTrue(OpportunityObservationCache.MAX_CACHED_ENTITY_OBSERVATIONS > 0);
        assertTrue(OpportunityObservationCollector.MAX_CLASSIFIED_CHUNK_KEYS
            >= OpportunityObservationCache.MAX_CACHED_CHUNKS);
        assertTrue(OpportunityScanner.MAX_BLOCKS_PER_CHUNK
            <= OpportunityObservationCache.MAX_CACHED_BLOCK_OBSERVATIONS);
    }

    @Test
    void refreshCadenceIsImmediateForNewOrInvalidatedChunksAndBoundedForCachedOnes() {
        long first = 1_000L;
        assertTrue(OpportunityObservationCollector.shouldRefreshChunk(
            false, Long.MIN_VALUE, first));
        assertFalse(OpportunityObservationCollector.shouldRefreshChunk(
            true, first, first + OpportunityObservationCollector.CHUNK_REFRESH_INTERVAL_MS - 1L));
        assertFalse(OpportunityObservationCollector.shouldRefreshChunk(
            false, first, first + OpportunityObservationCollector.CHUNK_REFRESH_INTERVAL_MS - 1L));
        assertTrue(OpportunityObservationCollector.shouldRefreshChunk(
            true, first, first + OpportunityObservationCollector.CHUNK_REFRESH_INTERVAL_MS));
        assertTrue(OpportunityObservationCollector.shouldRefreshChunk(
            true, Long.MIN_VALUE, first));
    }

    @Test
    void explicitTargetChunkRefreshBypassesCacheOnlyAtArrivalBoundary() throws IOException {
        String source = collectorSource();
        String forced = method(source,
            "OpportunityObservationCache.RefreshResult forceChunkRefresh(");
        String shared = method(source,
            "private OpportunityObservationCache.RefreshResult refreshChunkClassification(");

        assertTrue(forced.contains(
            "world, chunk, observerFeet, observedAtMs, true"));
        assertTrue(shared.contains(
            "if (!forced && !shouldRefreshChunk(cached, lastClassified, observedAtMs))"));
        assertTrue(shared.contains("classifyChunk(world, chunk, access)"));
        assertTrue(shared.contains("cache.refreshChunk(world, observation)"));
        assertFalse(forced.contains("onClientTick"));
        assertFalse(forced.contains("getEntities"));
    }

    @Test
    void disappearedResourcesProduceOneClassifiedTombstoneOnlyWhenSourceIsStillObserved() {
        OpportunityObservationCollector.WireDiscovery hay =
            new OpportunityObservationCollector.WireDiscovery(
                "hay-one", "hay", 4, 64, 4, 1, 0.9D,
                List.of("access_proven", "hazard_free"), 1_000L, "verified");

        List<OpportunityObservationCollector.WireDiscovery> reconciled =
            OpportunityObservationCollector.reconcileDiscoveries(
                List.of(), List.of(hay), ignored -> true, false, 2_000L);
        List<OpportunityObservationCollector.WireDiscovery> unloaded =
            OpportunityObservationCollector.reconcileDiscoveries(
                List.of(), List.of(hay), ignored -> false, false, 2_000L);
        List<OpportunityObservationCollector.WireDiscovery> truncated =
            OpportunityObservationCollector.reconcileDiscoveries(
                List.of(), List.of(hay), ignored -> true, true, 2_000L);
        OpportunityObservationCollector.WireDiscovery alreadyDisappeared =
            reconciled.getFirst();
        List<OpportunityObservationCollector.WireDiscovery> duplicate =
            OpportunityObservationCollector.reconcileDiscoveries(
                List.of(), List.of(alreadyDisappeared), ignored -> true, false, 3_000L);

        assertEquals(1, reconciled.size());
        assertEquals("disappeared", reconciled.getFirst().status());
        assertEquals(0.0D, reconciled.getFirst().confidence());
        assertTrue(unloaded.isEmpty());
        assertTrue(truncated.isEmpty());
        assertTrue(duplicate.isEmpty());
    }

    @Test
    void accessProofIsMemoizedAndFullChunkRefreshHasANonzeroCadence() throws IOException {
        String source = collectorSource();

        assertEquals(1, occurrences(source, "OpportunityAccessibilityProof.capture("));
        assertTrue(source.contains("canonicalOrigin.equals(accessibilityOrigin)"));
        assertTrue(source.contains("accessibilityProofEpochMs == observedAtMs"));
        assertTrue(source.contains("accessibilityProofComputations += 1"));
        assertTrue(source.contains("CHUNK_REFRESH_INTERVAL_MS = 30_000L"));
        assertTrue(source.contains("if (!forced && !shouldRefreshChunk("));
        assertTrue(source.contains(".limit(MAX_WIRE_DISCOVERIES)"));
        assertTrue(source.contains("validateDiscovery(world, discovery)"));
        assertTrue(source.contains("OpportunityExecutorCapabilityRegistry.evaluate("));
        assertTrue(source.contains("hasAccessibleExactExecutorTarget("));
        assertTrue(source.contains("firstExactExecutorTarget("));
        assertTrue(source.contains("VillageFrontierAccessProof.Result frontier"));
        assertTrue(source.contains("signals.add(\"route_reachable\")"));
        assertTrue(source.contains("villageFrontierAccessProof.clear()"));
        assertTrue(OpportunityAccessibilityProof.MAX_EXPANDED_CELLS <= 512);
        assertEquals(32, VillageInteractionStancePlanner.MAX_ROUTE_CELLS);
        assertEquals(512, VillageInteractionStancePlanner.MAX_EXPANDED_CELLS);
    }

    @Test
    void executorReadinessRequiresOneExactSafeAccessibleTarget() {
        assertTrue(OpportunityObservationCollector.executorTargetAdmission(true, true, true));
        assertFalse(OpportunityObservationCollector.executorTargetAdmission(false, true, true));
        assertFalse(OpportunityObservationCollector.executorTargetAdmission(true, false, true));
        assertFalse(OpportunityObservationCollector.executorTargetAdmission(true, true, false));
    }

    @Test
    void onlyVillageRootsMayUseRemoteFrontierAsAccessProof() {
        assertEquals(
            OpportunityObservationCollector.AccessProofKind.VILLAGE_FRONTIER,
            OpportunityObservationCollector.accessProofKind(
                OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER,
                false,
                false,
                true));
        assertEquals(
            OpportunityObservationCollector.AccessProofKind.LOCAL,
            OpportunityObservationCollector.accessProofKind(
                OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER,
                true,
                true,
                true));

        for (OpportunityScanner.DiscoveryType standalone : List.of(
            OpportunityScanner.DiscoveryType.CONTAINER,
            OpportunityScanner.DiscoveryType.HAY,
            OpportunityScanner.DiscoveryType.BED,
            OpportunityScanner.DiscoveryType.EXPOSED_STONE,
            OpportunityScanner.DiscoveryType.EXPOSED_IRON,
            OpportunityScanner.DiscoveryType.EXPOSED_COAL)) {
            assertEquals(
                OpportunityObservationCollector.AccessProofKind.NONE,
                OpportunityObservationCollector.accessProofKind(
                    standalone,
                    false,
                    true,
                    true),
                standalone.name());
            assertEquals(
                OpportunityObservationCollector.AccessProofKind.LOCAL,
                OpportunityObservationCollector.accessProofKind(
                    standalone,
                    true,
                    true,
                    false),
                standalone.name());
        }
    }

    @Test
    void exactExecutorCapabilityDoesNotBorrowOrRequireLocalAccess() {
        OpportunityExecutorCapabilityRegistry.Readiness remoteHay =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.HAY,
                OpportunityExecutorCapabilityRegistry.RuntimeState.none(),
                true);
        OpportunityExecutorCapabilityRegistry.Readiness unsupportedHay =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.HAY,
                OpportunityExecutorCapabilityRegistry.RuntimeState.none(),
                false);

        assertTrue(remoteHay.ready());
        assertEquals("code_owned_executor_ready", remoteHay.reason());
        assertFalse(unsupportedHay.ready());
        assertEquals("unsupported_live_target", unsupportedHay.reason());
    }

    private static String collectorSource() throws IOException {
        return Files.readString(Path.of(
            "src/main/java/com/mcbot/fabricclient/OpportunityObservationCollector.java"));
    }

    private static int occurrences(String source, String needle) {
        int count = 0;
        int offset = 0;
        while ((offset = source.indexOf(needle, offset)) >= 0) {
            count += 1;
            offset += needle.length();
        }
        return count;
    }

    private static String method(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, "missing source block " + signature);
        int open = source.indexOf('{', start);
        assertTrue(open >= 0, "missing source block body " + signature);
        int depth = 0;
        for (int index = open; index < source.length(); index++) {
            char value = source.charAt(index);
            if (value == '{') {
                depth += 1;
            } else if (value == '}') {
                depth -= 1;
                if (depth == 0) {
                    return source.substring(start, index + 1);
                }
            }
        }
        throw new AssertionError("unterminated source block " + signature);
    }
}
