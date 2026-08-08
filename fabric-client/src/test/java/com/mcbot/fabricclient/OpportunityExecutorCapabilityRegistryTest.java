package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

final class OpportunityExecutorCapabilityRegistryTest {
    @Test
    void everyRegisteredExecutorIsAnExistingProductionAction() throws IOException {
        String client = Files.readString(Path.of(
            "src/main/java/com/mcbot/fabricclient/McbotFabricClient.java"))
            + Files.readString(Path.of(
                "src/main/java/com/mcbot/fabricclient/VillageOpportunityExecutor.java"));

        for (String action : List.of(
            "village_revalidate",
            "village_inspect_container",
            "village_harvest_hay",
            "village_collect_bed",
            "village_defeat_iron_golem",
            "mine_nearby_stone",
            "mine_nearby_iron",
            "mine_nearby_coal"
        )) {
            assertTrue(client.contains("\"" + action + "\""), action);
        }
    }

    @Test
    void registryContainsOnlyExistingLocalResourceExecutors() {
        Set<OpportunityScanner.DiscoveryType> registered = EnumSet.noneOf(
            OpportunityScanner.DiscoveryType.class);
        for (OpportunityScanner.DiscoveryType type : OpportunityScanner.DiscoveryType.values()) {
            if (OpportunityExecutorCapabilityRegistry.isRegistered(type)) {
                registered.add(type);
            }
        }

        assertEquals(Set.of(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER,
            OpportunityScanner.DiscoveryType.CONTAINER,
            OpportunityScanner.DiscoveryType.HAY,
            OpportunityScanner.DiscoveryType.BED,
            OpportunityScanner.DiscoveryType.IRON_GOLEM,
            OpportunityScanner.DiscoveryType.EXPOSED_STONE,
            OpportunityScanner.DiscoveryType.EXPOSED_IRON,
            OpportunityScanner.DiscoveryType.EXPOSED_COAL
        ), registered);
    }

    @Test
    void runtimeToolStateMirrorsExistingExecutorAdmission() {
        OpportunityExecutorCapabilityRegistry.RuntimeState wooden =
            OpportunityExecutorCapabilityRegistry.RuntimeState.fromCanonicalItemIds(
                List.of("minecraft:wooden_pickaxe"));
        OpportunityExecutorCapabilityRegistry.RuntimeState stone =
            OpportunityExecutorCapabilityRegistry.RuntimeState.fromCanonicalItemIds(
                List.of("stone_pickaxe"));

        assertTrue(wooden.woodenOrBetterPickaxe());
        assertFalse(wooden.stoneOrBetterPickaxe());
        assertTrue(stone.woodenOrBetterPickaxe());
        assertTrue(stone.stoneOrBetterPickaxe());

        assertTrue(OpportunityExecutorCapabilityRegistry.evaluate(
            OpportunityScanner.DiscoveryType.EXPOSED_STONE, wooden, true).ready());
        assertFalse(OpportunityExecutorCapabilityRegistry.evaluate(
            OpportunityScanner.DiscoveryType.EXPOSED_IRON, wooden, true).ready());
        assertFalse(OpportunityExecutorCapabilityRegistry.evaluate(
            OpportunityScanner.DiscoveryType.EXPOSED_COAL, wooden, true).ready());
        assertTrue(OpportunityExecutorCapabilityRegistry.evaluate(
            OpportunityScanner.DiscoveryType.EXPOSED_IRON, stone, true).ready());
        assertTrue(OpportunityExecutorCapabilityRegistry.evaluate(
            OpportunityScanner.DiscoveryType.EXPOSED_COAL, stone, true).ready());
    }

    @Test
    void exactLiveTargetIsRequiredEvenWhenToolExists() {
        OpportunityExecutorCapabilityRegistry.RuntimeState state =
            OpportunityExecutorCapabilityRegistry.RuntimeState.fromCanonicalItemIds(
                List.of("minecraft:netherite_pickaxe"));
        OpportunityExecutorCapabilityRegistry.Readiness readiness =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.EXPOSED_STONE,
                state,
                false
            );

        assertFalse(readiness.ready());
        assertEquals("mine_nearby_stone", readiness.executorId());
        assertEquals("unsupported_live_target", readiness.reason());
    }

    @Test
    void futureOpportunityTypesRemainExplicitlyUnready() {
        for (OpportunityScanner.DiscoveryType type : List.of(
            OpportunityScanner.DiscoveryType.VILLAGER,
            OpportunityScanner.DiscoveryType.RUINED_PORTAL_EVIDENCE
        )) {
            OpportunityExecutorCapabilityRegistry.Readiness readiness =
                OpportunityExecutorCapabilityRegistry.evaluate(
                    type,
                    new OpportunityExecutorCapabilityRegistry.RuntimeState(true, true),
                    true
                );
            assertFalse(readiness.ready(), type.name());
            assertEquals("phase_executor_unavailable", readiness.reason(), type.name());
            assertTrue(readiness.executorId().isBlank(), type.name());
        }

        OpportunityExecutorCapabilityRegistry.Readiness passiveFood =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.PASSIVE_FOOD,
                new OpportunityExecutorCapabilityRegistry.RuntimeState(true, true),
                true
            );
        assertFalse(passiveFood.ready());
        assertEquals("no_general_passive_food_executor", passiveFood.reason());
    }

    @Test
    void golemReadinessRequiresTheTargetSpecificDefensePlannerVerdict() {
        OpportunityExecutorCapabilityRegistry.RuntimeState readyRuntime =
            new OpportunityExecutorCapabilityRegistry.RuntimeState(
                true, true, 20.0D, 20, 100, 32, 6, 0, 1);

        OpportunityExecutorCapabilityRegistry.Readiness unproven =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.IRON_GOLEM,
                readyRuntime,
                true);
        OpportunityExecutorCapabilityRegistry.Readiness rejected =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.IRON_GOLEM,
                readyRuntime,
                true,
                new OpportunityExecutorCapabilityRegistry.TargetReadiness(
                    false, "unsafe_pillar_geometry"));
        OpportunityExecutorCapabilityRegistry.Readiness accepted =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.IRON_GOLEM,
                readyRuntime,
                true,
                new OpportunityExecutorCapabilityRegistry.TargetReadiness(
                    true, "defense_ready"));

        assertFalse(unproven.ready());
        assertFalse(unproven.wireSignals().contains("defense_ready"));
        assertFalse(rejected.ready());
        assertEquals("unsafe_pillar_geometry", rejected.reason());
        assertTrue(rejected.wireSignals().contains("defense_unready"));
        assertTrue(accepted.ready());
        assertEquals("village_defeat_iron_golem", accepted.executorId());
        assertTrue(accepted.wireSignals().contains("defense_ready"));
    }

    @Test
    void combatRuntimeConservativelyReportsUsableFiller() {
        OpportunityExecutorCapabilityRegistry.RuntimeState runtime =
            new OpportunityExecutorCapabilityRegistry.RuntimeState(
                true, true, 18.0D, 17, 80, 8, 6, 1, 1);

        assertEquals(2, runtime.usableFiller());
        assertEquals(18.0D, runtime.health());
        assertEquals(17, runtime.foodLevel());
        assertEquals(80, runtime.stoneSwordRemainingDurability());
        assertEquals(1, runtime.nearbyHostileCount());
        assertEquals(1, runtime.liveIronGolemCount());
    }

    @Test
    void villageCapabilitiesRequireExactAccessibleTargetsButNoMiningTool() {
        var runtime = OpportunityExecutorCapabilityRegistry.RuntimeState.none();
        assertVillageReady(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER,
            "village_transaction", "village_revalidate", runtime);
        assertVillageReady(
            OpportunityScanner.DiscoveryType.CONTAINER,
            "village_container", "village_inspect_container", runtime);
        assertVillageReady(
            OpportunityScanner.DiscoveryType.HAY,
            "village_hay", "village_harvest_hay", runtime);
        assertVillageReady(
            OpportunityScanner.DiscoveryType.BED,
            "village_bed", "village_collect_bed", runtime);
    }

    private static void assertVillageReady(
        OpportunityScanner.DiscoveryType type,
        String capability,
        String executor,
        OpportunityExecutorCapabilityRegistry.RuntimeState runtime
    ) {
        OpportunityExecutorCapabilityRegistry.Readiness ready =
            OpportunityExecutorCapabilityRegistry.evaluate(type, runtime, true);
        assertTrue(ready.ready());
        assertEquals(capability, ready.capabilityId());
        assertEquals(executor, ready.executorId());
        assertEquals("code_owned_registry_v1", ready.source());
        assertFalse(OpportunityExecutorCapabilityRegistry.evaluate(
            type, runtime, false).ready());
    }

    @Test
    void wireProofIsTypedAndTransitionSafe() {
        OpportunityExecutorCapabilityRegistry.Readiness readiness =
            OpportunityExecutorCapabilityRegistry.evaluate(
                OpportunityScanner.DiscoveryType.EXPOSED_IRON,
                new OpportunityExecutorCapabilityRegistry.RuntimeState(true, true),
                true
            );

        assertEquals("code_owned_registry_v1", readiness.source());
        assertEquals("local_exposed_iron", readiness.capabilityId());
        assertEquals("mine_nearby_iron", readiness.executorId());
        assertTrue(readiness.wireSignals().contains("capability_ready"));
        assertTrue(readiness.wireSignals().contains("executor_ready"));
        assertTrue(readiness.wireSignals().contains(
            "readiness:code_owned_executor_ready"));
    }
}
