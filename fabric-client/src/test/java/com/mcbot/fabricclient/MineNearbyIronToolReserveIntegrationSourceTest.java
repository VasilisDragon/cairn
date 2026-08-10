package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Source-contract coverage for the mission iron reserve integration seams.
 *
 * <p>The pure accounting and selection rules live in {@link MissionIronToolReservePolicyTest}.
 * These checks pin the surrounding executor ordering and lifecycle guarantees without needing a
 * live {@code ClientPlayerEntity}.</p>
 */
final class MineNearbyIronToolReserveIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );
    private static final Path TRANSACTION_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "MiningWorkspaceTransaction.java"
    );
    private static final Path DESCENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "DescentExecutor.java"
    );

    @Test
    void ownedDropRecoveryFinishesBeforeReserveAdmissionAndEveryPhysicalBreak() throws IOException {
        String source = normalized(CLIENT_SOURCE);
        String method = between(
            source,
            "private ControlDecision resolveMineNearbyOreControl(",
            "private ControlDecision resolveOreCollectNavigation("
        );

        int ownedDrop = method.indexOf(
            "if (missionIronOwnedDropRequired(run, oreKind) && run.ownedDropBreakConfirmed)"
        );
        int reserveAdmission = method.indexOf("MissionIronToolReservePolicy.Request reserveRequest");
        int physicalBreak = method.indexOf(
            "BlockBreakController.Result result = blockBreakController.tick("
        );

        assertTrue(ownedDrop >= 0, "the attributed owned-drop branch must remain explicit");
        assertTrue(reserveAdmission > ownedDrop,
            "tool reserve admission must not interrupt an unresolved attributed raw-iron drop");
        assertTrue(physicalBreak > reserveAdmission,
            "the reserve policy must run before the executor can start a physical block break");
    }

    @Test
    void neutralReserveFeedbackPreservesTheFrozenLaneAndAcquisitionEpoch() throws IOException {
        String source = normalized(CLIENT_SOURCE);
        String completion = between(
            source,
            "private ControlDecision completeMineNearbyOre(",
            "private ControlDecision failMineNearbyIron("
        );

        assertTrue(count(source, "saveIronExposureLaneContinuation(run);") >= 2,
            "reserve feedback must save the active lane in addition to normal same-plane handoff");
        assertTrue(source.contains("tool_reserve_required"),
            "the client must expose the neutral reserve-feedback completion reason");
        assertTrue(count(completion, "\"tool_reserve_required\".equals(reason)") >= 2,
            "tool reserve feedback must preserve both the epoch and the saved lane continuation");
        assertTrue(completion.contains("ironProspectAtlas.completeEpoch();"),
            "unrelated terminal completions must retain the existing epoch-closing path");
    }

    @Test
    void legacyThirtyTwoDurabilityHeuristicCannotRunForMissionReserveCommands() throws IOException {
        String source = normalized(CLIENT_SOURCE);
        String proactive = between(
            source,
            "private ControlDecision maybeResolveProactiveMineNearbyIronToolRecovery(",
            "private static boolean missionIronExposurePlaneActive("
        );

        int reserveGuard = proactive.indexOf("MissionIronToolReservePolicy.applies(");
        int legacyThreshold = proactive.indexOf("bestStonePickaxeRemainingDurability(player)");

        assertTrue(reserveGuard >= 0,
            "the legacy proactive helper must explicitly recognize mission reserve ownership");
        assertTrue(legacyThreshold > reserveGuard,
            "mission reserve commands must return before the legacy 32-durability heuristic runs");
    }

    @Test
    void stonePickRestockUsesTheWorkspaceTransactionAndEmitsBoundedLifecycleEvents() throws IOException {
        String client = normalized(CLIENT_SOURCE);
        String transaction = normalized(TRANSACTION_SOURCE);

        assertTrue(transaction.contains("\"craft_stone_pickaxe\".equals(action)"));
        assertTrue(transaction.contains("\"mission:MINE_IRON\".equals(reason)"));
        assertTrue(transaction.contains("\"mission:MAKE_STONE_TOOLS\".equals(reason)"));
        assertTrue(client.contains("mining.workspace.transaction.reused"),
            "the existing transaction must report exact table reuse for the stone-pick craft");
        assertTrue(client.contains("mine_nearby_iron.tool_reserve.restock_started"));
        assertTrue(client.contains("mine_nearby_iron.tool_reserve.restock_completed"));
        assertTrue(client.contains("mine_nearby_iron.tool_reserve.rejected"));
        assertTrue(client.contains("mine_nearby_iron.fieldkit_sticks_crafted"));

        String travel = between(
            client,
            "private ControlDecision resolveMiningWorkspaceTransactionTravel(",
            "private ControlDecision resolveMiningWorkspaceRouteSuffixRepair("
        );
        int resume = travel.indexOf("mining.workspace.resume_reached");
        int resumeOwnership = travel.indexOf(
            "IronToolReserveRestockResumePolicy.classify(", resume
        );
        int restockComplete = travel.indexOf("completeIronToolReserveRestock(", resume);
        int transactionComplete = travel.indexOf("completeMiningWorkspaceTransaction(", resume);
        assertTrue(
            resume >= 0
                && resumeOwnership > resume
                && restockComplete > resumeOwnership
                && transactionComplete > restockComplete,
            "remote restock may complete only after resume and before transaction cleanup");
        assertTrue(travel.contains(
            "IronToolReserveRestockResumePolicy.Outcome.COMPLETE_RESTOCK"),
            "reserve-restock finalization must be guarded by explicit transaction ownership");

        String observer = between(
            client,
            "private void observeMiningWorkspaceTransactionCompletion(",
            "private ControlDecision resolveMiningWorkspaceTransaction("
        );
        int completionClassification = observer.indexOf(
            "IronToolReserveRestockCompletionPolicy.classify("
        );
        int successClassification = observer.indexOf(
            "boolean restockSucceeded = restockOutcome"
        );
        int completionLatch = observer.indexOf(
            "markIronToolReserveRestockCraftCompleted(priorIntent.commandId());"
        );
        assertTrue(
            completionClassification >= 0
                && successClassification > completionClassification
                && completionLatch > successClassification,
            "the stop-wrapped craft receipt must recover resident ownership before latching success"
        );
        assertTrue(!observer.contains("workspace_table_reused\");\n                completeIronToolReserveRestock"),
            "craft completion at the remote table must not claim frontier restoration");
    }

    @Test
    void exactIronRecoveryProtectsPlanksAndCannotBootstrapAWorkstation() throws IOException {
        String descent = normalized(DESCENT_SOURCE);
        String recovery = between(
            descent,
            "private ControlDecision resolveDescentToolRecovery(",
            "private ControlDecision maybeResolveProactiveDescentToolRecovery("
        );

        assertTrue(recovery.contains(
            "missionIronRecoveryReserveApplies(run) ? MISSION_IRON_PROTECTED_PLANK_RESERVE : 0"
        ));
        int exactGuard = recovery.indexOf("if (exactMissionIronRecoveryReserveApplies(run)");
        int tableCraft = recovery.indexOf("run.descentTableCraftLatch.shouldDrive(plankCount)");
        int tablePlacement = recovery.indexOf("FieldKitRecoveryPlanner.Action.PLACE_TABLE_REQUIRED");
        assertTrue(exactGuard >= 0 && tableCraft > exactGuard,
            "the exact recovery guard must reject before the table-craft latch");
        assertTrue(tablePlacement > exactGuard,
            "the exact recovery guard must own carried-table placement before it can dispatch");
        assertTrue(recovery.contains("missionIronRecoveryReserveCompletionReason(true)"));
        assertTrue(descent.contains("descent_complete:tool_reserve_required"));
        assertTrue(descent.contains("descent_complete:tool_reserve_unavailable"));
        assertFalse(recovery.contains("descent_tool_recovery:tool_reserve_unavailable"),
            "exact reserve loss must complete neutrally instead of entering generic descent failure");
    }

    private static String normalized(Path source) throws IOException {
        return Files.readString(source).replace("\r\n", "\n");
    }

    private static String between(String source, String start, String end) {
        int from = source.indexOf(start);
        int to = source.indexOf(end, Math.max(0, from + start.length()));
        assertTrue(from >= 0, "missing source marker: " + start);
        assertTrue(to > from, "missing source marker after " + start + ": " + end);
        return source.substring(from, to);
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
