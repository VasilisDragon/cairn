package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** Source-level lifecycle contracts around the stateful tool-restock interruption. */
final class MineNearbyIronToolReserveLifecycleSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void identityContinuationDoesNotDependOnHavingAnActiveLaneSuffix() throws IOException {
        String source = normalized();
        String handoff = between(
            source,
            "private ControlDecision handoffMissionIronToolReserve(",
            "private static MissionIronToolReservePolicy.ToolCandidate missionIronReserveTool("
        );
        String validation = between(
            source,
            "private String ironToolReserveRestockIdentityFailure(",
            "private void rejectIronToolReserveRestock("
        );

        assertTrue(handoff.contains("captureIronExposureIdentityContinuation("));
        assertTrue(handoff.indexOf("captureIronExposureIdentityContinuation(")
            < handoff.indexOf("saveIronExposureLaneContinuation(run);"),
            "the exact plane identity must be frozen even when lane suffix capture rejects");
        assertTrue(validation.contains("ironToolReserveIdentityContinuation"));
        assertTrue(validation.contains("continuation.headingName()"));
        assertTrue(validation.contains("feet.y() != continuation.planeFeetY()"));
        assertFalse(validation.contains("ironExposureLaneContinuation == null"),
            "remote restock identity may not collapse to heading=none at a visible ore or lane end");
    }

    @Test
    void oneShotResumeRestoresCommandBudgetWithoutDoubleAccountingEpoch() throws IOException {
        String source = normalized();
        String control = between(
            source,
            "private ControlDecision resolveMineNearbyOreControl(",
            "private ControlDecision resolveOreCollectNavigation("
        );
        String restore = between(
            source,
            "private void restoreIronToolReserveResumeContinuation(",
            "private boolean ironToolReserveResumeIdentityValid("
        );
        String accounting = between(
            source,
            "private void accountIronSearchCommand(",
            "private void logIronAtlasRegionExhausted("
        );

        assertTrue(control.contains("missionIronCommandElapsedMs(run, nowMs)"),
            "the 225-second command deadline must include the pre-restock consumption");
        assertTrue(control.contains("missionIronCommandProspectBlocks(run)"),
            "the 96-block command limit must include the pre-restock consumption");
        assertTrue(restore.indexOf("ironToolReserveResumeContinuation = null;")
            < restore.indexOf("run.restoredCommandProspectBlocks"),
            "the budget payload must be consumed exactly once before it can be applied");
        assertTrue(restore.contains("run.restoredCommandActiveMs"));
        assertTrue(accounting.contains("run.prospectBlocksBroken"));
        assertTrue(accounting.contains("nowMs - run.startedAtMs"));
        assertFalse(accounting.contains("missionIronCommandProspectBlocks"),
            "already-accounted pre-restock work must not be charged to the epoch twice");
        assertFalse(accounting.contains("missionIronCommandElapsedMs"),
            "already-accounted pre-restock time must not be charged to the epoch twice");
    }

    @Test
    void localCraftConsumesPendingPreparationButNeutralHandoffDoesNot() throws IOException {
        String observer = between(
            normalized(),
            "private void observeMiningWorkspaceTransactionCompletion(",
            "private ControlDecision resolveMiningWorkspaceTransaction("
        );

        int neutralHandoff = observer.indexOf("if (localFallbackHandoff)");
        int localConsume = observer.indexOf(
            "&& pendingIronToolReservePreparation != null",
            neutralHandoff
        );
        int localStart = observer.indexOf(
            "priorIntent.commandId(),",
            localConsume
        );
        assertTrue(neutralHandoff >= 0 && localConsume > neutralHandoff,
            "the infrastructure handoff must leave the preparation for the real local craft");
        assertTrue(localStart > localConsume,
            "the stop-wrapped local completion must bind the frozen preparation by command id");
        assertTrue(observer.contains("pendingIronToolReservePreparation = null;"));
        assertTrue(observer.contains("recordIronToolReserveUnavailable(priorIntent);"));
    }

    @Test
    void genericTransactionRejectionInstallsOneNeutralFeedback() throws IOException {
        String source = normalized();
        String rejection = between(
            source,
            "private ControlDecision rejectMiningWorkspaceTransaction(",
            "private void logMiningWorkspaceTransactionRejected("
        );
        String feedback = between(
            source,
            "private void recordIronToolReserveUnavailable(",
            "private void markIronToolReserveRestockCraftCompleted("
        );

        assertTrue(rejection.contains("recordIronToolReserveUnavailable(effective);"));
        assertTrue(rejection.contains("tool_reserve_unavailable"));
        assertTrue(feedback.contains("putIfAbsent("),
            "duplicate rejection ticks may not replace or multiply neutral feedback");
    }

    @Test
    void identityFailureIsLoggedAsNotPreserved() throws IOException {
        String source = normalized();
        String completion = between(
            source,
            "private String completeIronToolReserveRestock(",
            "private void recordIronToolReserveUnavailable("
        );
        String rejection = between(
            source,
            "private void rejectIronToolReserveRestock(",
            "private void observeMiningWorkspaceTransactionCompletion("
        );

        assertTrue(completion.contains(
            "rejectIronToolReserveRestock(null, nowMs, identityFailure, false);"));
        assertTrue(rejection.contains("ironToolReserveIdentityPreservedForRejection(reason)"));
        assertTrue(rejection.contains("workspace_session_changed"));
        assertTrue(rejection.contains("frontier_not_restored"));
        assertTrue(rejection.contains("identityPreserved={}"));
        assertTrue(rejection.contains("identityPreserved\n"));
    }

    @Test
    void hotbarRestagingDoesNotFabricateASecondToolSwitch() throws IOException {
        String logging = between(
            normalized(),
            "private void logMissionIronToolReserveAssessment(",
            "private ControlDecision handoffMissionIronToolReserve("
        );

        assertTrue(logging.contains("&& !run.lastReserveToolItem.equals(selectedItem)"));
        assertFalse(logging.contains("|| run.lastReserveToolInventorySlot != selected.hotbarSlot()"),
            "moving the same stack into a hotbar slot is not a tool-kind switch");
    }

    @Test
    void samePlaneBoundaryFreezesRestockBeforeCompletingTheSlice() throws IOException {
        String boundary = between(
            normalized(),
            "private ControlDecision continueMineNearbyIronOnSamePlane(",
            "private IronExposureLanePlanner.Perception ironExposureLanePerception("
        );

        int request = boundary.indexOf("missionIronToolReserveRequestForNextLane(");
        int assessment = boundary.indexOf("MissionIronToolReservePolicy.assess(reserveRequest)");
        int handoff = boundary.indexOf("handoffMissionIronToolReserve(");
        int continuation = boundary.indexOf("saveIronExposureLaneContinuation(run);");
        assertTrue(request >= 0 && assessment > request && handoff > assessment,
            "the next-lane horizon must be assessed before the neutral restock handoff");
        assertTrue(continuation > handoff,
            "a shortage must freeze pending restock identity instead of completing same-plane continuation");
        assertTrue(boundary.contains("if (!reserveAssessment.admitted())"));
    }

    private static String normalized() throws IOException {
        return Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");
    }

    private static String between(String source, String start, String end) {
        int from = source.indexOf(start);
        int to = source.indexOf(end, Math.max(0, from + start.length()));
        assertTrue(from >= 0, "missing source marker: " + start);
        assertTrue(to > from, "missing source marker after " + start + ": " + end);
        return source.substring(from, to);
    }
}
