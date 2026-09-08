package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** Behavioral descent checks plus wiring guards for the existing authoritative handoff. */
class CombatMissionHandoffTest {
    private static final DescentControlPlanner.State SAVED = new DescentControlPlanner.State(
        4, 3, DescentControlPlanner.Stage.BREAK_LOWER);

    private static DescentControlPlanner.Decision resume(long elapsed, String hazard, boolean grounded) {
        return DescentControlPlanner.decidePreflight(SAVED,
            new DescentControlPlanner.PreflightObservation(elapsed, 30_000, 20, 20, hazard, grounded, -1, 6));
    }

    @Test void safeHandoffRetainsTheAcceptedStepAndStage() {
        var result = resume(12_000, null, true);
        assertEquals(DescentControlPlanner.Action.CONTINUE, result.action());
        assertSame(SAVED, result.state());
    }

    @Test void combatTimeDoesNotExtendTheExistingDeadline() {
        assertEquals(DescentControlPlanner.Action.CONTINUE, resume(30_000, null, true).action());
        var expired = resume(30_001, null, true);
        assertEquals(DescentControlPlanner.Action.FAIL_TIMEOUT, expired.action());
        assertSame(SAVED, expired.state());
    }

    @Test void changedHazardOrStanceStillBlocksMissionWork() {
        assertEquals(DescentControlPlanner.Action.FAIL_PLAYER_HAZARD,
            resume(12_000, "descent_player_in_hazard:lava", true).action());
        assertEquals(DescentControlPlanner.Action.WAIT_ON_GROUND, resume(12_000, null, false).action());
    }

    @Test void changedTerrainMustUseExistingRerouteOrFailure() {
        var result = DescentControlPlanner.decideStep(SAVED,
            new DescentControlPlanner.StepObservation(false, false, false, false, false,
                "descent_next_support_missing", false, false, false, false, false));
        assertEquals(DescentControlPlanner.Action.REROUTE_OR_FAIL, result.action());
        assertSame(SAVED, result.state());
    }

    @Test void combatCommitsThroughAllAuthoritiesAndReturnsWithoutReplacingTheIntent() throws Exception {
        String source = source("McbotFabricClient.java");
        int start = source.indexOf("CombatController.Result combat = combatController.tick(");
        int survival = source.indexOf("SurvivalController.Result survival =", start);
        String combat = source.substring(start, survival);
        assertTrue(combat.contains("effective.commandId()"));
        assertTrue(combat.contains("movementAuthority.commit("));
        assertTrue(combat.contains("gazeAuthority.commit("));
        assertTrue(combat.contains("interactionAuthority.commit("));
        assertTrue(combat.contains("combatController.acknowledgeInteraction(interactionReceipt)"));
        assertTrue(combat.contains("return;"));
        assertFalse(combat.contains("clearNavigationState("));
        assertFalse(combat.contains("effective = "));
        assertTrue(source.indexOf("enforceGatherTreeCommandDeadlineBeforeReflex(client, player, effective, nowMs)") < start);
        assertTrue(source.indexOf("resolveControl(client, player, effective, nowMs)", survival) > survival);
    }

    @Test void executorRevalidatesTheOriginalRunFromCurrentWorldAndPosition() throws Exception {
        String source = source("DescentExecutor.java");
        assertTrue(source.contains("activeRun == null || !commandId.equals(activeRun.commandId)"));
        assertTrue(source.contains("run.worldIdentity != (client == null ? null : client.world)"));
        assertTrue(source.contains("nowMs - run.startedAtMs"));
        assertTrue(source.contains("currentPlayerDescentHazardReason(client, player)"));
        assertTrue(source.contains("isDryDescentBody(client, player, actualFeet)"));
        assertTrue(source.contains("isStableDescentSupport(client, actualFeet.down())"));
        assertFalse(source.contains("combat_preemption"), "resumption must not create a special validation exemption");
    }

    @Test void budgetDisconnectCapturesExistingTerminalEvidenceBeforeLosingTheWorld() throws Exception {
        String combat = source("CombatController.java");
        int capture = combat.indexOf("McbotFabricClient.captureCombatPreemptionTerminalEvidence(client)");
        int disconnect = combat.indexOf("handler.getConnection().disconnect(", capture);
        assertTrue(capture > 0 && disconnect > capture);
        assertTrue(combat.substring(combat.indexOf("private void requestLogout("), capture)
            .contains("\"combat_preemption_exhausted\".equals(reason)"));
        assertTrue(combat.substring(capture, disconnect).contains("catch (RuntimeException error)"));
        String client = source("McbotFabricClient.java");
        assertTrue(client.contains("activeClient.logLiveEvidenceTerminalState(client)"));
        int noWorld = client.indexOf("if (player == null || client.world == null)");
        int stop = client.indexOf("maybeHonorLiveEvidenceStopRequest(client)", noWorld);
        assertTrue(stop > noWorld && stop < client.indexOf("maybeDriveAutoSingleplayerMenu(client, nowMs)", noWorld));
    }

    private static String source(String name) throws Exception {
        return Files.readString(Path.of("src/main/java/com/mcbot/fabricclient", name));
    }
}
