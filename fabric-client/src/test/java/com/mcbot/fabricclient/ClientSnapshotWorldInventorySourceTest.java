package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class ClientSnapshotWorldInventorySourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void wireRecordContainsTheAdditiveBoundedWorldAndInventoryFields() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String record = section(
            source,
            "private record ClientSnapshot(",
            "private static boolean hasNearbyBlock("
        );

        for (String field : new String[] {
            "String worldIdentity",
            "String worldIdentitySource",
            "boolean worldPersistenceEligible",
            "String dimension",
            "Map<String, Integer> inventoryItemCounts",
            "List<FabricInventorySnapshot.DurableItem> inventoryDurability",
            "Map<FabricInventorySnapshot.EquipmentSlot, FabricInventorySnapshot.EquipmentItem> inventoryEquipment",
            "int inventoryWoolCount",
            "int inventoryBedCount",
            "int inventoryHayBaleCount",
            "int inventoryWheatCount",
            "int inventoryBreadCount",
            "FabricInventorySnapshot.NutritionReserve inventoryNutritionReserve",
            "Boolean verifiedRespawnSet",
            "String verifiedRespawnState",
            "String verifiedRespawnEvidence"
        }) {
            assertTrue(record.contains(field), "missing additive snapshot field " + field);
        }
        assertTrue(record.contains("boolean inventoryItemCountsTruncated"));
        assertTrue(record.contains("boolean inventoryDurabilityTruncated"));
    }

    @Test
    void dispatchFreezesIdentityAndDimensionBeforeBuildingTheSnapshot() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String dispatch = section(
            source,
            "if (brainDispatchCandidate) {",
            "brainLink.poll(snapshotJson, nowMs);"
        );

        assertTrue(dispatch.contains("WorldIdentityResolver.Resolution worldIdentity = resolveSnapshotWorldIdentity(client);"));
        assertTrue(dispatch.contains("client.world.getRegistryKey().getValue().toString()"));
        assertTrue(dispatch.contains("workspaceSnapshot,\n                worldIdentity,\n                snapshotDimension"));
    }

    @Test
    void remoteIdentityNeverReadsOrHashesTheServerEndpoint() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resolver = section(
            source,
            "private WorldIdentityResolver.Resolution resolveSnapshotWorldIdentity(",
            "// ----- ShellServices accessors"
        );

        assertTrue(resolver.contains("System.getenv(WorldIdentityResolver.CONFIG_ENV)"));
        assertTrue(resolver.contains("WorldIdentityResolver.ConnectionKind.REMOTE_SERVER"));
        assertTrue(resolver.contains("instanceId + \":world-session:\" + snapshotIdentityWorldRevision"));
        assertTrue(resolver.contains("getSavePath(WorldSavePath.ROOT)"));
        assertTrue(resolver.contains("LocalWorldIdentityFingerprint.resolve(saveRoot)"));
        assertTrue(resolver.contains("verifiedLocalSavePath,\n            verifiedLocalWorldFingerprint,"));
        assertFalse(resolver.contains("getCurrentServerEntry"));
        assertFalse(resolver.contains("ServerInfo"));
        assertFalse(resolver.toLowerCase().contains("address"));
    }

    @Test
    void snapshotAssemblyUsesOnePlayerInventoryPassForOldAndNewFields() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String capture = section(
            source,
            "private static SnapshotInventoryCapture captureSnapshotInventory(",
            "private static boolean hasHotbarEdibleFood("
        );
        String fromBeforeConstructor = section(
            source,
            "static ClientSnapshot from(",
            "return new ClientSnapshot("
        );

        assertTrue(capture.contains("for (int slot = 0; slot < inventorySize; slot++)"));
        assertTrue(capture.contains("Registries.ITEM.getId(stack.getItem())"));
        assertTrue(capture.contains("itemIdentifier.toString()"));
        assertTrue(capture.contains("stack.get(DataComponentTypes.FOOD)"));
        assertTrue(capture.contains("food.nutrition()"));
        assertTrue(capture.contains("FabricInventorySnapshot.capture("));
        assertTrue(fromBeforeConstructor.contains("SnapshotInventoryCapture inventoryCapture = captureSnapshotInventory(player);"));
        assertFalse(fromBeforeConstructor.contains("InventoryCounter.countPlayer"));
        assertFalse(fromBeforeConstructor.contains("player.getInventory().getStack"));
    }

    @Test
    void constructorMapsBoundedFactsAndPreservesExplicitUnknownRespawnTruth() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String constructor = section(
            source,
            "return new ClientSnapshot(",
            "TerrainProbe.capture("
        );

        assertTrue(constructor.contains("worldIdentity.opaqueWorldId()"));
        assertTrue(constructor.contains("worldIdentity.source().name().toLowerCase(Locale.ROOT)"));
        assertTrue(constructor.contains("worldIdentity.persistent()"));
        assertTrue(constructor.contains("fullInventory.itemCounts()"));
        assertTrue(constructor.contains("fullInventory.durableInventory()"));
        assertTrue(constructor.contains("fullInventory.equipment()"));
        assertTrue(constructor.contains("fullInventory.woolCount()"));
        assertTrue(constructor.contains("fullInventory.nutritionReserve(),\n                respawnVerification.verifiedRespawnSet(),"));
        assertTrue(constructor.contains("respawnVerification.state(),"));
        assertTrue(constructor.contains("respawnVerification.evidence(),"));
        assertFalse(constructor.contains("fullInventory.nutritionReserve(),\n                false,"));
    }

    @Test
    void respawnTruthComesOnlyFromTheServerGameMessageConfirmation() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String registration = section(
            source,
            "ClientReceiveMessageEvents.ALLOW_GAME.register",
            "ClientTickEvents.END_CLIENT_TICK.register(this::onClientTick);"
        );
        String observer = section(
            source,
            "private void observeRespawnConfirmation(",
            "private Optional<FarPerceptionScanner.ChunkObservation>"
        );

        assertTrue(registration.contains("observeRespawnConfirmation(message)"));
        assertTrue(registration.contains("return true"));
        assertTrue(observer.contains("message.getContent() instanceof TranslatableTextContent"));
        assertTrue(observer.contains("translatable.getKey()"));
        assertTrue(observer.contains("respawnVerificationTracker.observeServerGameMessage("));
        assertFalse(observer.contains("message.getString()"));
    }

    private static String section(String source, String startToken, String endToken) {
        int start = source.indexOf(startToken);
        int end = source.indexOf(endToken, start + startToken.length());
        assertTrue(start >= 0, "missing start token " + startToken);
        assertTrue(end > start, "missing end token " + endToken);
        return source.substring(start, end);
    }
}
