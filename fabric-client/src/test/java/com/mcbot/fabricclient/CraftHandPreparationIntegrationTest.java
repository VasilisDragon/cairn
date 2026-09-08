package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class CraftHandPreparationIntegrationTest {
    private String source() throws Exception { return Files.readString(Path.of("src/main/java/com/mcbot/fabricclient/McbotFabricClient.java")); }
    @Test void preparationHasOneAuthorizedPlayerSwapAndNeverWritesWorldOrInputs() throws Exception {
        String source = source();
        String hand = source.substring(source.indexOf("private ControlDecision prepareCraftTableHand("), source.indexOf("private void logCraftHandPreparation("));
        assertTrue(hand.contains("dispatchStateMatches(observeCraftHand("));
        assertTrue(hand.contains("run.stage != Craft3x3ControlPlanner.Stage.START"));
        assertTrue(hand.contains("interactionAuthority.clickPlayerInventorySlot("));
        assertTrue(hand.contains("SlotActionType.SWAP"));
        assertFalse(hand.contains("interactionManager.clickSlot("));
        assertFalse(hand.contains("clickContainerSlot("));
        assertFalse(hand.contains("setStack("));
        assertFalse(hand.contains("dropSelectedItem("));
        assertFalse(hand.contains("keyBinding"));
    }
    @Test void furnaceOpeningAndHeldItemRequirementRemainIndependent() throws Exception {
        String source = source();
        String blockUse = source.substring(source.indexOf("private ControlDecision blockUseDecision("), source.indexOf("private static String tableOpenRequestId("));
        assertTrue(blockUse.contains("selectTableOpenHotbarSlot(player)"));
        assertTrue(blockUse.contains("_empty_main_hand_required"));
        assertFalse(blockUse.contains("prepareCraftTableHand"));
        String furnace = source.substring(source.indexOf("private ControlDecision resolveSmeltCharcoalControl("));
        assertFalse(furnace.substring(0, furnace.indexOf("private static final class") > 0 ? furnace.indexOf("private static final class") : furnace.length()).contains("prepareCraftTableHand("));
    }
    @Test void handPreparationDoesNotExtendCraftDeadlineOrResetRecipeBaselines() throws Exception {
        String source = source();
        assertTrue(source.contains("CRAFT_TOTAL_TIMEOUT_MS = 8_000L"));
        assertTrue(source.contains("CRAFT_CLICK_SETTLE_MS = 150L"));
        String hand = source.substring(source.indexOf("private ControlDecision prepareCraftTableHand("), source.indexOf("private void logCraftHandPreparation("));
        assertFalse(hand.contains("startedAtMs ="));
        assertFalse(hand.contains("baselineResult ="));
        assertTrue(source.contains("craftHandPreparations.get(commandId, client.world, player)"));
        assertTrue(source.contains("craftHandPreparations.contains(commandId)"));
        assertTrue(source.contains("action + \"_hand_prep_stale_state\""));
        assertTrue(source.contains("completedCraft3x3CommandIds.contains(commandId)"));
    }
    @Test void recipeCompletionCannotBypassPendingInventoryVerification() throws Exception {
        String source = source();
        int start = source.indexOf("Craft3x3ControlPlanner.Decision preflight =");
        String preflight = source.substring(start, source.indexOf("if (preflight.action()", start));
        assertTrue(preflight.contains("run.handPreparation.allowRecipeCompletion("),
            "A recipe/output gain must not retire an unverified inventory transaction");
        assertTrue(preflight.contains("Craft3x3RecipePlanner.hasExpectedOutputDelta(run.recipe, run.baselineResult, currentResultCount)),"));
        assertTrue(preflight.contains("nowMs - run.startedAtMs > CRAFT_TOTAL_TIMEOUT_MS"));
    }
}
