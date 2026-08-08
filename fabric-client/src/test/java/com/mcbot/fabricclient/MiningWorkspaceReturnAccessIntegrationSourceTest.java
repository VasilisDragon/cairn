package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class MiningWorkspaceReturnAccessIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void everyRemoteReturnConsumerUsesTheCentralAccessPredicate() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("private boolean workspaceReturnUsableFrom(VoxelCell feet)"));
        assertEquals(1, occurrences(source, "miningWorkspaceStore.returnAvailableFrom(feet)"));
        assertTrue(source.contains("boolean returnAvailable = workspaceReturnUsableFrom(feet)"));
        assertTrue(source.contains("&& workspaceReturnUsableFrom(feet)"));
        assertEquals(2, occurrences(source, "if (!workspaceReturnUsableFrom(feet))"));
    }

    @Test
    void physicalAvailabilityAndExactStanceRestorationRemainIndependent() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("return new MiningWorkspaceSnapshot(\n            true,\n            atSite,"));
        assertTrue(source.contains("reanchorAtWorkspaceStance("));
        assertTrue(source.contains("feet.equals(workspace.stance())"));
        assertTrue(source.contains("miningWorkspaceStore.trail().equals(List.of(workspace.stance()))"));
        assertTrue(source.contains("mining.workspace.return_access.restored"));
    }

    @Test
    void neutralTransactionHandoffUsesItsOwnCompletionChannel() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("finishedWorkspaceFallbackCommandReasons"));
        assertTrue(source.contains(
            "action + \"_complete:mining_workspace_local_fallback_required\""
        ));
        assertTrue(source.contains("mining.workspace.fallback.handoff"));
        assertTrue(source.contains("consumer=transaction routeMode={}"));
        assertTrue(source.contains("failureReason=route_invalidated"));
        assertTrue(source.contains("MiningWorkspaceReturnFallbackPolicy.handoffPrelaunch("));
        assertTrue(source.contains("MiningWorkspaceReturnFallbackPolicy.handoffStructuralRejection("));
        assertEquals(6, occurrences(source, "finishedWorkspaceFallbackCommandReasons"));
    }

    @Test
    void fieldkitStructuralHandoffContinuesTheOuterCommandLocally() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int fallbackEvent = source.indexOf("mine_nearby_iron.fieldkit_workspace_fallback");
        int fallbackBranch = source.lastIndexOf(
            "if (MiningWorkspaceReturnFallbackPolicy.handoffStructuralRejection(",
            fallbackEvent
        );
        int existingFailure = source.indexOf("return failMineNearbyIron(", fallbackEvent);
        String handoff = source.substring(fallbackBranch, existingFailure);

        assertTrue(handoff.contains("run.workspaceTravel.clear()"));
        assertTrue(handoff.contains("run.workspaceRoundTripPending = false"));
        assertTrue(handoff.contains("run.workspaceLocalFallbackLatched = true"));
        assertTrue(handoff.contains("mine_nearby_iron_fieldkit_workspace_local_fallback"));
        assertEquals(0, occurrences(handoff, "failMineNearbyIron("));
        assertEquals(0, occurrences(handoff, "completeCurrentCommand("));
        assertEquals(0, occurrences(handoff, "accountCommand("));
    }

    @Test
    void activeFieldkitPickaxeCraftCompletesBeforeHotbarShortcut() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int recoveryMethod = source.indexOf("private ControlDecision resolveMineNearbyIronToolRecovery(");
        int activeCraftAdmission = source.indexOf(
            "FieldKitRecoveryPlanner.shouldContinueActivePickaxeCraft(",
            recoveryMethod
        );
        int hotbarShortcut = source.indexOf("int existingHotbarSlot", recoveryMethod);
        String activeCraftBranch = source.substring(activeCraftAdmission, hotbarShortcut);

        assertTrue(recoveryMethod >= 0);
        assertTrue(activeCraftAdmission > recoveryMethod);
        assertTrue(hotbarShortcut > activeCraftAdmission);
        assertTrue(activeCraftBranch.contains("resolveMineNearbyIronFieldKitPickaxeCraft("));
        assertEquals(3, occurrences(source, "resolveMineNearbyIronFieldKitPickaxeCraft("));
    }

    @Test
    void activeFieldkitTablePlacementVerifiesBeforeInventoryShortcut() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int recoveryMethod = source.indexOf("private ControlDecision resolveMineNearbyIronToolRecovery(");
        int activePlacementAdmission = source.indexOf(
            "blockPlaceController.isAwaitingVerification(run.toolPlaceTableCommandId())",
            recoveryMethod
        );
        int hotbarShortcut = source.indexOf("int existingHotbarSlot", recoveryMethod);
        int inventoryShortcut = source.indexOf("FieldKitRecoveryPlanner.afterInventory(", recoveryMethod);
        String activePlacementBranch = source.substring(activePlacementAdmission, hotbarShortcut);

        assertTrue(activePlacementAdmission > recoveryMethod);
        assertTrue(hotbarShortcut > activePlacementAdmission);
        assertTrue(inventoryShortcut > activePlacementAdmission);
        assertTrue(activePlacementBranch.contains("resolveMineNearbyIronFieldKitTablePlacement("));
        assertEquals(3, occurrences(source, "resolveMineNearbyIronFieldKitTablePlacement("));
    }

    private static int occurrences(String source, String token) {
        int count = 0;
        int offset = 0;
        while ((offset = source.indexOf(token, offset)) >= 0) {
            count++;
            offset += token.length();
        }
        return count;
    }
}
