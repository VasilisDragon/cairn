package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class FabricWorldActionMainWiringTest {
    @Test
    void successfulZeroResultCommandReceiptIsApplied() {
        assertTrue(McbotFabricClient.serverCommandReceiptApplied(1, true, 0, false));
        assertTrue(McbotFabricClient.serverCommandReceiptApplied(1, true, 1, false));
        assertTrue(McbotFabricClient.serverCommandReceiptApplied(1, false, 0, true));
        assertFalse(McbotFabricClient.serverCommandReceiptApplied(0, true, 0, false));
        assertFalse(McbotFabricClient.serverCommandReceiptApplied(1, false, 0, false));
        assertFalse(McbotFabricClient.serverCommandReceiptApplied(1, true, null, false));
        assertFalse(McbotFabricClient.serverCommandReceiptApplied(1, true, -1, false));
    }

    @Test
    void idempotentReceiptPostconditionIsLimitedToAnEmptySinglePlayerInventory() throws IOException {
        String source = mainSource();
        String postcondition = between(
            source,
            "private static boolean liveEvidenceCommandPostconditionVerified(",
            "private void recordSuppressedLiveEvidenceCommandBatch("
        );

        assertTrue(postcondition.contains("\"clear @p\".equals("));
        assertTrue(postcondition.contains("players.size() == 1"));
        assertTrue(postcondition.contains("getInventory().isEmpty()"));
        assertTrue(postcondition.contains(
            "\"fill 588 140 588 616 160 612 minecraft:air replace\".equals("
        ));
        assertTrue(postcondition.contains("x = 588; x <= 616"));
        assertTrue(postcondition.contains("y = 140; y <= 160"));
        assertTrue(postcondition.contains("z = 588; z <= 612"));
        assertTrue(postcondition.contains("getBlockState(cursor.set(x, y, z)).isAir()"));
        assertTrue(postcondition.contains(
            "\"fillbiome 588 140 588 616 160 612 minecraft:plains\".equals("
        ));
        assertTrue(postcondition.contains("quartX = Math.floorDiv(588, 4)"));
        assertTrue(postcondition.contains("quartY = Math.floorDiv(140, 4)"));
        assertTrue(postcondition.contains("quartZ = Math.floorDiv(588, 4)"));
        assertTrue(postcondition.contains("\"minecraft:plains\".equals(key.getValue().toString())"));
        assertFalse(postcondition.contains("startsWith("));
        assertFalse(postcondition.contains("contains(\"clear\""));
        assertFalse(postcondition.contains("contains(\"fill\""));
        assertFalse(postcondition.contains("contains(\"fillbiome\""));
    }

    @Test
    void developmentFixtureRequiresExactProfileWorldAndPersistentLocalIdentity() {
        WorldIdentityResolver.Resolution local = new WorldIdentityResolver.Resolution(
            "world-v1-local",
            WorldIdentityResolver.Source.LOCAL_SAVE,
            WorldIdentityResolver.PersistenceEligibility.PERSISTENT,
            true,
            "verified_local_world_fingerprint"
        );
        WorldIdentityResolver.Resolution configured = new WorldIdentityResolver.Resolution(
            "world-v1-configured",
            WorldIdentityResolver.Source.EXPLICIT_CONFIG,
            WorldIdentityResolver.PersistenceEligibility.PERSISTENT,
            true,
            "configured_world_id"
        );

        assertTrue(McbotFabricClient.developmentFixtureAuthorizedFor(
            "development_fixture.v1", true, "New World (139)", "New World (139)",
            "New World (139)", local, false));
        assertFalse(McbotFabricClient.developmentFixtureAuthorizedFor(
            "qualification_unseen.v1", true, "New World (139)", "New World (139)",
            "New World (139)", local, false));
        assertFalse(McbotFabricClient.developmentFixtureAuthorizedFor(
            "north_star_record.v1", true, "New World (139)", "New World (139)",
            "New World (139)", local, false));
        assertFalse(McbotFabricClient.developmentFixtureAuthorizedFor(
            "development_fixture.v1", false, "New World (139)", "New World (139)",
            "New World (139)", local, false));
        assertFalse(McbotFabricClient.developmentFixtureAuthorizedFor(
            "development_fixture.v1", true, "New World (139)", "another-world",
            "New World (139)", local, false));
        assertFalse(McbotFabricClient.developmentFixtureAuthorizedFor(
            "development_fixture.v1", true, "New World (139)", "New World (139)",
            "another-world", local, false));
        assertFalse(McbotFabricClient.developmentFixtureAuthorizedFor(
            "development_fixture.v1", true, "New World (139)", "New World (139)",
            "New World (139)", configured, false));
        assertFalse(McbotFabricClient.developmentFixtureAuthorizedFor(
            "development_fixture.v1", true, "New World (139)", "New World (139)",
            "New World (139)", local, true));
    }

    @Test
    void worldObservationPrecedesEveryTickCommandAndInteractionPath() throws IOException {
        String source = mainSource();
        String tick = between(source, "private void onClientTick(", "private void renderCockpitHud(");
        int observation = tick.indexOf("observeWorldActionAuthorization(client);");
        int singlePlayerGate = tick.indexOf("if (!client.isInSingleplayer())");
        int serverCommands = tick.indexOf("applyServerCommands(client, effective);");
        int interaction = tick.indexOf("interactionAuthority.commit(");

        assertTrue(observation >= 0);
        assertTrue(observation < singlePlayerGate);
        assertTrue(observation < serverCommands);
        assertTrue(observation < interaction);
        assertTrue(source.contains("server.getPlayerManager().getCurrentPlayerCount()"));
        assertTrue(source.contains("observation.disposableTrustRevokedNow()"));
        assertTrue(source.contains("revokedDisposableWorldIdentities.add(opaqueWorldIdentity)"));
        assertTrue(source.contains("revokedDisposableWorldIdentities.contains(opaqueWorldIdentity)"));
        assertTrue(source.contains("WorldIdentityResolver.Resolution identity = snapshotWorldActionIdentity;"));
        assertTrue(source.contains("instanceId + \":world-action-identity:\""));
    }

    @Test
    void eachServerCommandIsReauthorizedAtExecutionTime() throws IOException {
        String source = mainSource();
        String schedule = between(
            source,
            "private void applyServerCommands(",
            "private void executeLiveEvidenceCommandBatch("
        );
        String execution = between(
            source,
            "private void executeLiveEvidenceCommandBatch(",
            "private void recordSuppressedLiveEvidenceCommandBatch("
        );

        int scheduleGate = schedule.indexOf(
            "if (!interactionAuthority.fixtureCommandsAllowed(client, server))"
        );
        int scheduleSink = schedule.indexOf("server.execute(");
        assertTrue(scheduleGate >= 0 && scheduleGate < scheduleSink);
        int currentServerGate = execution.indexOf("client.getServer() == server");
        int authorizationGate = execution.indexOf(
            "interactionAuthority.fixtureCommandsAllowed(client, server)"
        );
        int commandSink = execution.indexOf("executeWithPrefix(");
        assertTrue(currentServerGate >= 0 && currentServerGate < commandSink);
        assertTrue(authorizationGate >= 0 && authorizationGate < commandSink);
        assertTrue(execution.contains("\"suppressed\""));
        assertTrue(execution.contains("world_action_authorization_denied"));
    }

    @Test
    void fixtureCommandsRequireEmptyTargetPolicyBeforeQueueAndAtServerSink() throws IOException {
        String main = mainSource();
        String authority = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String protection = Files.readString(sourcePath("FabricTargetProtection.java"));
        String schedule = between(
            main,
            "private void applyServerCommands(",
            "private void executeLiveEvidenceCommandBatch("
        );
        String execution = between(
            main,
            "private void executeLiveEvidenceCommandBatch(",
            "private void recordSuppressedLiveEvidenceCommandBatch("
        );
        String endpointFixture = between(
            main,
            "private ControlDecision maybePlaceR5EndpointIronFixture(",
            "private List<BlockPos> selectR5EndpointIronFixturePositions("
        );

        assertTrue(authority.contains("targetProtection.fixtureCommandsAllowed(client)"));
        assertTrue(protection.contains("configurationReadable"));
        assertTrue(protection.contains("regions.isEmpty()"));
        assertTrue(protection.contains("world == observedWorld"));
        assertTrue(protection.contains(
            "Objects.equals(normalized(dimension), observedDimension)"));
        int targetPolicyScheduleGate = schedule.indexOf(
            "fixtureCommandsAllowed(client, server)");
        int scheduleSink = schedule.indexOf("server.execute(");
        int targetPolicyExecutionGate = execution.indexOf(
            "fixtureCommandsAllowed(client, server)");
        int commandSink = execution.indexOf("executeWithPrefix(");
        int endpointPolicyGate = endpointFixture.indexOf(
            "fixtureCommandsAllowed(client, server)");
        int endpointScheduleSink = endpointFixture.indexOf("server.execute(");
        assertTrue(targetPolicyScheduleGate >= 0 && targetPolicyScheduleGate < scheduleSink);
        assertTrue(targetPolicyExecutionGate >= 0 && targetPolicyExecutionGate < commandSink);
        assertTrue(endpointPolicyGate >= 0 && endpointPolicyGate < endpointScheduleSink);
    }

    @Test
    void freshCreationAndDirectAnchorsUseExplicitCodeOwnedSignals() throws IOException {
        String source = mainSource();
        String pressButton = between(
            source,
            "private boolean pressButton(",
            "private static Set<String> captureLocalSaveDirectoryNames("
        );

        assertTrue(source.contains("screen instanceof CreateWorldScreen"));
        assertTrue(source.contains("freshWorldCreationSubmitted = true;"));
        assertTrue(source.contains("captureLocalSaveDirectoryNames()"));
        assertTrue(source.contains("freshWorldPreexistingSaveInventoryCaptured"));
        assertTrue(source.contains("!freshWorldPreexistingSaveNames.contains(snapshotIdentityLocalSaveName)"));
        assertTrue(source.contains("createdFreshWorldIdentity.equals(opaqueWorldIdentity)"));
        assertTrue(source.contains("BlockAuthorization.naturalAnchor()"));
        int saveInventory = pressButton.indexOf("captureLocalSaveDirectoryNames()");
        int createSubmission = pressButton.indexOf("button.onPress()");
        assertTrue(saveInventory >= 0 && saveInventory < createSubmission);
    }

    private static String mainSource() throws IOException {
        return Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"));
    }

    private static Path sourcePath(String fileName) {
        return Path.of("src", "main", "java", "com", "mcbot", "fabricclient", fileName);
    }

    private static String between(String source, String startMarker, String endMarker) {
        int start = source.indexOf(startMarker);
        int end = source.indexOf(endMarker, start + startMarker.length());
        if (start < 0 || end < 0 || end <= start) {
            throw new IllegalArgumentException("source markers not found");
        }
        return source.substring(start, end);
    }
}
