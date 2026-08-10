package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class SurvivalUseInteractionSourceTest {
    private static final Path SOURCE_ROOT = Path.of(
        "src",
        "main",
        "java",
        "com",
        "mcbot",
        "fabricclient"
    );

    @Test
    void survivalDescribesOneStableFoodHoldWithoutWritingTheUseKey() throws IOException {
        String source = source("SurvivalController.java");

        assertTrue(source.contains("InteractionDemand.holdItem("));
        assertTrue(source.contains("FabricInteractionAuthority.Payload.item(Hand.MAIN_HAND)"));
        assertTrue(source.contains("player.getInventory().selectedSlot = foodSlot;"));
        assertTrue(source.contains("return null; // let the hotbar swap settle one tick before using the item"));
        assertTrue(source.contains("eatGestureIdentity = \"survival:eat:\" + eatEpisode"));
        assertFalse(source.contains("useKey.setPressed"));
        assertFalse(source.contains("interactItem("));
    }

    @Test
    void bedUseCompletesOnlyFromItsMatchingAppliedAcceptedReceipt() throws IOException {
        String source = source("UseBedExecutor.java");
        int demand = source.indexOf("InteractionDemand.useBlock(");
        int receipt = source.indexOf("void observeInteractionReceipt(");
        int applied = source.indexOf("if (!receipt.applied())", receipt);
        int accepted = source.indexOf("!receipt.actionResult().isAccepted()", receipt);
        int completion = source.indexOf("recordUseBedCompletion(", accepted);

        assertTrue(demand >= 0);
        assertTrue(receipt > demand);
        assertTrue(applied > receipt && accepted > applied && completion > accepted);
        assertTrue(source.contains("run.pendingRequestId.equals(receipt.requestId())"));
        assertTrue(source.contains("receipt.disposition() == InteractionAppliedReceipt.Disposition.DEFERRED"));
        assertTrue(source.contains("FabricInteractionAuthority.Payload.blockUse(run.pendingHit, Hand.MAIN_HAND)"));
        assertFalse(source.contains("client.interactionManager.interactBlock"));
        assertFalse(source.contains("player.swingHand"));
    }

    private static String source(String name) throws IOException {
        return Files.readString(SOURCE_ROOT.resolve(name));
    }
}
