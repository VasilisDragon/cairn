package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class GazeOwnershipSourceTest {
    private static final Path SOURCE_ROOT = Path.of(
        "src",
        "main",
        "java",
        "com",
        "mcbot",
        "fabricclient"
    );

    @Test
    void controlLayersEmitDemandsAndCommitThroughOnePriorityOrderedAuthority() throws IOException {
        String client = source("McbotFabricClient.java");
        String combat = source("CombatController.java");
        String survival = source("SurvivalController.java");
        String hunt = source("HuntSheepExecutor.java");
        String descent = source("DescentExecutor.java");

        int combatTick = client.indexOf("CombatController.Result combat = combatController.tick");
        int combatCommit = client.indexOf("gazeAuthority.commit(player, combat.lookDemand()");
        int combatInteraction = client.indexOf("interactionAuthority.commit(", combatCommit);
        int combatReceipt = client.indexOf(
            "combatController.acknowledgeInteraction",
            combatInteraction
        );
        int survivalTick = client.indexOf("SurvivalController.Result survival = survivalController.tick");
        int survivalCommit = client.indexOf("gazeAuthority.commit(player, survival.lookDemand()");
        int normalCommit = client.indexOf("gazeAuthority.commit(player, lookDemand");
        int normalInteraction = client.indexOf("interactionAuthority.commit(", normalCommit);
        int huntReceipt = client.indexOf(
            "huntSheepExecutor.acknowledgeInteraction",
            normalInteraction
        );

        assertTrue(combatTick >= 0 && combatTick < combatCommit);
        assertTrue(
            combatCommit < combatInteraction
                && combatInteraction < combatReceipt
                && combatReceipt < survivalTick
        );
        assertTrue(survivalTick < survivalCommit && survivalCommit < normalCommit);
        assertTrue(normalCommit < normalInteraction && normalInteraction < huntReceipt);
        assertTrue(combat.contains("LookDemand.Owner.COMBAT"));
        assertTrue(combat.contains("LookDemand.Profile.TRACKING"));
        assertTrue(survival.contains("LookDemand.Owner.SURVIVAL"));
        assertTrue(survival.contains("LookDemand.Profile.CRITICAL"));
        assertTrue(hunt.contains("LookDemand.Owner.HUNT"));
        assertTrue(hunt.contains("LookDemand.Profile.TRACKING"));
        assertTrue(descent.contains("criticalWaterRetreatDemand"));
        assertTrue(descent.contains("LookDemand.Owner.SURVIVAL"));
        assertTrue(descent.contains("LookDemand.Profile.CRITICAL"));
        assertTrue(descent.contains("new ControlDecision(intent, input, criticalLook, legacyLook)"));
    }

    @Test
    void normalOwnershipResumeReleasesTheLegacyFixedTarget() throws IOException {
        String authority = source("FabricGazeAuthority.java");
        assertTrue(authority.contains("lastDemand.owner() != demand.owner()"));
        assertTrue(authority.contains("demand.owner() == LookDemand.Owner.NORMAL"));
        assertTrue(authority.contains("legacyState = LegacyState.initial();"));
    }

    private static String source(String name) throws IOException {
        return Files.readString(SOURCE_ROOT.resolve(name));
    }
}
