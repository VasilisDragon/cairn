package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class MineNearbyIronOwnedDropIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void ownedDropResolutionOwnsTheTickButEnforcesHardBudgetsBeforeTrackerAndLegacyCollection() throws IOException {
        String source = source();
        String oreExecutor = between(
            source,
            "private ControlDecision resolveMineNearbyOreControl(",
            "private static final long ORE_COLLECT_NAV_TERMINAL_GRACE_MS"
        );

        int ownedDrop = oreExecutor.indexOf("resolveMissionIronOwnedDrop(");
        assertTrue(ownedDrop >= 0);
        assertTrue(ownedDrop < oreExecutor.indexOf("int delta ="));
        assertTrue(ownedDrop < oreExecutor.indexOf("ironProspectAtlas.exhaustedWith("));
        assertTrue(ownedDrop < oreExecutor.indexOf("maybeResolveProactiveMineNearbyIronToolRecovery("));
        assertTrue(ownedDrop < oreExecutor.indexOf("if (run.collectStartedAtMs > 0L)"));

        String resolver = between(
            source,
            "private ControlDecision resolveMissionIronOwnedDrop(",
            "private ControlDecision driveMissionIronOwnedDropPlane("
        );
        int inventoryReconciliation = resolver.indexOf("boolean inventoryGain =");
        int exactResume = resolver.indexOf("if (inventoryGain) {");
        int deadline = resolver.indexOf("missionIronOwnedDropDeadlineReason(");
        int trackerUpdate = resolver.indexOf("run.ownedDropTracker.update(observations, nowMs)");
        int activeGainHandoff = resolver.indexOf(
            "if (inventoryGain && run.ownedDropPlaneController.active())");
        assertTrue(inventoryReconciliation >= 0 && inventoryReconciliation < exactResume);
        assertTrue(exactResume < deadline);
        assertTrue(deadline < activeGainHandoff);
        assertTrue(deadline < trackerUpdate);
    }

    @Test
    void ownedDropDeadlinePolicyPinsExactCommandAndEpochBoundaries() {
        assertTrue(McbotFabricClient.missionIronOwnedDropDeadlineReason(
            224_999L, 225_000L, 900_000L).isEmpty());
        assertTrue(McbotFabricClient.missionIronOwnedDropDeadlineReason(
            225_000L, 225_000L, 900_000L).equals("command_deadline"));
        assertTrue(McbotFabricClient.missionIronOwnedDropDeadlineReason(
            99_999L, 225_000L, 100_000L).isEmpty());
        assertTrue(McbotFabricClient.missionIronOwnedDropDeadlineReason(
            100_000L, 225_000L, 100_000L).equals("epoch_deadline"));
        assertTrue(McbotFabricClient.missionIronOwnedDropDeadlineReason(
            225_000L, 225_000L, 100_000L).equals("command_deadline"));
    }

    @Test
    void attributionArmsBeforeBreakingAndBothRemovalPathsConfirmIt() throws IOException {
        String source = source();
        String oreExecutor = between(
            source,
            "private ControlDecision resolveMineNearbyOreControl(",
            "private static final long ORE_COLLECT_NAV_TERMINAL_GRACE_MS"
        );

        int arm = oreExecutor.indexOf("armMissionIronOwnedDrop(");
        int breakTick = oreExecutor.indexOf("blockBreakController.tick(");
        int routeAdmission = oreExecutor.indexOf("missionIronTargetDropRecoverable(");
        assertTrue(routeAdmission >= 0 && routeAdmission < arm);
        assertTrue(arm >= 0 && arm < breakTick);
        assertTrue(count(oreExecutor, "confirmMissionIronOwnedDropBreak(") == 2);
        assertTrue(oreExecutor.contains("} else {\n                        run.collectStartedAtMs = nowMs;"));
    }

    @Test
    void verifiedRemovalMayFreezeOnlySameOrOneCardinalSafePlaneCell() {
        VoxelCell armed = new VoxelCell(10, 14, 20);

        assertTrue(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, armed, 14, true, true, true));
        assertTrue(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, new VoxelCell(10, 14, 21), 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, new VoxelCell(11, 14, 21), 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, new VoxelCell(10, 14, 22), 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, new VoxelCell(10, 15, 20), 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, armed, 14, false, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, armed, 14, true, false, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropResumeReanchorAllowed(
            armed, armed, 14, true, true, false));
    }

    @Test
    void verifiedRemovalRefreezesResumeBeforeAcquisitionBegins() throws IOException {
        String confirmation = between(
            source(),
            "private boolean confirmMissionIronOwnedDropBreak(",
            "static boolean missionIronOwnedDropResumeReanchorAllowed("
        );

        int actualFeet = confirmation.indexOf("VoxelCell actualResumeCell =");
        int boundedAdmission = confirmation.indexOf("missionIronOwnedDropResumeReanchorAllowed(");
        int refreeze = confirmation.indexOf("run.ownedDropResumeCell = actualResumeCell;");
        int acquisition = confirmation.indexOf("run.ownedDropTracker.beginAcquisition(nowMs);");
        assertTrue(actualFeet >= 0 && actualFeet < boundedAdmission);
        assertTrue(boundedAdmission < refreeze);
        assertTrue(refreeze < acquisition);
    }

    @Test
    void satisfiedPickupMayFinishOnlyFromAStillSafeProductivePlaneStance() {
        VoxelCell safePlane = new VoxelCell(10, 14, 20);

        assertTrue(McbotFabricClient.missionIronOwnedDropTerminalInventorySatisfied(
            true, 3, 0, 3, safePlane, 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropTerminalInventorySatisfied(
            true, 2, 0, 3, safePlane, 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropTerminalInventorySatisfied(
            false, 3, 0, 3, safePlane, 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropTerminalInventorySatisfied(
            true, 3, 0, 3, new VoxelCell(10, 13, 20), 14, true, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropTerminalInventorySatisfied(
            true, 3, 0, 3, safePlane, 14, false, true, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropTerminalInventorySatisfied(
            true, 3, 0, 3, safePlane, 14, true, false, true));
        assertFalse(McbotFabricClient.missionIronOwnedDropTerminalInventorySatisfied(
            true, 3, 0, 3, safePlane, 14, true, true, false));
    }

    @Test
    void satisfiedSafePickupCompletionPrecedesTraversalFailureCharging() throws IOException {
        String driver = between(
            source(),
            "private ControlDecision driveMissionIronOwnedDropPlane(",
            "static boolean missionIronOwnedDropTerminalInventorySatisfied("
        );

        int rejection = driver.indexOf(
            "if (step.outcome() == IronOwnedDropPlaneController.Outcome.REJECTED)");
        int satisfaction = driver.indexOf("missionIronOwnedDropTerminalInventorySatisfied(");
        int completion = driver.indexOf("completeMineNearbyOre(", satisfaction);
        int failure = driver.indexOf("return rejectMissionIronOwnedDrop(", satisfaction);
        assertTrue(rejection >= 0 && rejection < satisfaction);
        assertTrue(satisfaction < completion);
        assertTrue(completion < failure);
    }

    @Test
    void missionPlaneNeverFallsThroughToGenericCollectionOrCompletionSweep() throws IOException {
        String source = source();
        String resolver = between(
            source,
            "private ControlDecision resolveMissionIronOwnedDrop(",
            "private boolean isSafeIronExposureCurrentStance("
        );

        assertFalse(resolver.contains("tryNav3dDriveToward("));
        assertFalse(resolver.contains("resolveOreCollectNavigation("));
        assertFalse(resolver.contains("gatherCollectIntent("));
        assertFalse(resolver.contains("collectStartedAtMs"));
        assertTrue(source.contains("if (missionIronOwnedDropRequired(run, oreKind)) {\n"
            + "                    return completeMineNearbyOre("));
    }

    @Test
    void authoritativeInventoryGainPreemptsTrackerDisappearanceDuringTraversal() throws IOException {
        String resolver = between(
            source(),
            "private ControlDecision resolveMissionIronOwnedDrop(",
            "private ControlDecision driveMissionIronOwnedDropPlane("
        );

        int gainHandoff = resolver.indexOf(
            "if (inventoryGain && run.ownedDropPlaneController.active())");
        int trackerUpdate = resolver.indexOf("run.ownedDropTracker.update(observations, nowMs)");
        assertTrue(gainHandoff >= 0 && gainHandoff < trackerUpdate);
        assertTrue(resolver.substring(gainHandoff, trackerUpdate)
            .contains("driveMissionIronOwnedDropPlane("));
    }

    @Test
    void eventPayloadsAndLifecycleCleanupRetainPlaneIdentity() throws IOException {
        String source = source();

        assertTrue(source.contains("mine_nearby_iron.owned_drop_latched"));
        assertTrue(source.contains("brokenTarget={} entityId={}"));
        assertTrue(source.contains("mine_nearby_iron.owned_drop_settled"));
        assertTrue(source.contains("mine_nearby_iron.owned_drop_route_selected"));
        assertTrue(source.contains("mine_nearby_iron.owned_drop_recovered"));
        assertTrue(source.contains("mine_nearby_iron.owned_drop_plane_restored"));
        assertTrue(source.contains("resumeCell={} actualFeet={} routeLength={}"));
        assertTrue(source.contains("clearMissionIronRunLifecycleState(activeMineNearbyIron);"));
        assertTrue(source.contains("clearMissionIronRunLifecycleState(run);"));
        assertTrue(count(source, "clearMissionIronOwnedDropState(run);") >= 4);
    }

    @Test
    void dropPerceptionRequiresCollisionFreeBodyAndStableSupport() throws IOException {
        String source = source();
        String ownedDropIntegration = between(
            source,
            "private boolean armMissionIronOwnedDrop(",
            "private void clearMissionIronRunLifecycleState("
        );
        String perception = between(
            source,
            "private VoxelPerception ironOwnedDropPlanePerception(",
            "private Map<UUID, Integer> mineNearbyIronRawItemSnapshot("
        );
        String stance = between(
            source,
            "private boolean isSafeIronExposureCurrentStance(",
            "private boolean isSafeIronExposureProspectiveStance("
        );

        assertTrue(count(perception, "ironExposureBodyCellClearAssuming(") >= 2);
        assertTrue(perception.contains("isSafeIronExposureProspectiveStance("));
        assertTrue(stance.contains("isStableDescentSupport(client, pos.down())"));
        assertTrue(count(ownedDropIntegration, "voxelFeet(player)") >= 5);
        assertFalse(ownedDropIntegration.contains("playerFeetCell(player)"));
    }

    private static String source() throws IOException {
        return Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");
    }

    private static String between(String source, String start, String end) {
        int first = source.indexOf(start);
        int last = source.indexOf(end, Math.max(0, first + start.length()));
        assertTrue(first >= 0, "missing start marker: " + start);
        assertTrue(last > first, "missing end marker: " + end);
        return source.substring(first, last);
    }

    private static int count(String source, String token) {
        int total = 0;
        int cursor = 0;
        while ((cursor = source.indexOf(token, cursor)) >= 0) {
            total++;
            cursor += token.length();
        }
        return total;
    }
}
