package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/** Adapter checks keep the pure transaction behind the existing runtime authorities and clocks. */
final class FurnaceHandPreparationIntegrationTest {
    private static String source() throws Exception {
        return Files.readString(Path.of("src/main/java/com/mcbot/fabricclient/McbotFabricClient.java"));
    }

    private static String member(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, "Missing member: " + signature);
        var next = Pattern.compile("(?m)^    (?:(?:private|public|protected)\\s|@Override)").matcher(source);
        int end = next.find(start + signature.length()) ? next.start() : source.length();
        return source.substring(start, end);
    }

    private static void ordered(String source, String before, String after) {
        int first = source.indexOf(before);
        int second = source.indexOf(after);
        assertTrue(first >= 0, "Missing earlier marker: " + before);
        assertTrue(second > first, "Expected " + before + " before " + after);
    }

    private static long occurrences(String source, String text) {
        return Pattern.compile(Pattern.quote(text)).matcher(source).results().count();
    }

    @Test void furnacePreparationUsesOneAuthorizedPlayerSwapWithFreshRevalidation() throws Exception {
        String hand = member(source(), "private ControlDecision prepareFurnaceHand(");
        assertEquals(1, occurrences(hand, "interactionAuthority.clickPlayerInventorySlot("));
        assertTrue(hand.contains("player.playerScreenHandler"));
        assertTrue(hand.contains("playerInventoryScreenSlot(decision.inventorySlot())"));
        assertTrue(hand.contains("decision.hotbarSlot(), SlotActionType.SWAP"));
        assertTrue(hand.contains("dispatchStateMatches("));
        assertTrue(occurrences(hand, "observeCraftHand(") >= 2,
            "Selection and dispatch must use independent fresh inventory observations");
        assertTrue(hand.contains("furnaceHandPreparationContext("));
        ordered(hand, "dispatchStateMatches(", "interactionAuthority.clickPlayerInventorySlot(");
        ordered(hand, "interactionAuthority.clickPlayerInventorySlot(", "receipt.applied()");
        assertTrue(hand.contains("authorization_denied"));
        assertTrue(hand.contains("catch (RuntimeException"));
        assertTrue(hand.contains("dispatch_exception"));
    }

    @Test void preparationCannotWriteWorldInputsContainersOrSmeltingState() throws Exception {
        String hand = member(source(), "private ControlDecision prepareFurnaceHand(");
        for (String forbidden : List.of("interactionManager.clickSlot(", "clickContainerSlot(",
            "clickSmeltSlot(", "setStack(", "dropSelectedItem(", "setPressed(", "setVelocity(",
            "setBlockState(", "blockUseDecision(", "pendingFurnaceOpenRequestId =",
            "directFurnaceOpenAttempts++", "startedAtMs =", "stageStartedAtMs =",
            "outputWaitStartedAtMs =", "lastClickAtMs =", "inputSourceSlot =", "fuelSourceSlot =",
            "desiredInputCount =", "desiredFuelCount =", "baselineLogs =", "baselineRawIron =",
            "baselineIronIngots =", "transitionSmeltCharcoalStage(")) {
            assertFalse(hand.contains(forbidden), forbidden);
        }
        assertTrue(hand.contains("failSmeltCharcoal("));
        assertTrue(hand.contains("\"_hand_prep_\" + decision.reason()"));
    }

    @Test void pendingPreparationGatesTypedCompletionAndRunsBeforeEveryScreenWait() throws Exception {
        String smelt = member(source(), "private ControlDecision resolveSmeltCharcoalControl(");
        int start = smelt.indexOf("SmeltControlPlanner.Decision preflight =");
        int end = smelt.indexOf("if (preflight.action()", start);
        assertTrue(start >= 0 && end > start);
        String preflight = smelt.substring(start, end);
        assertTrue(preflight.contains("run.handPreparation.allowRecipeCompletion("));
        assertTrue(preflight.contains("FurnaceSmeltPlanner.completedByInventoryDelta("));
        assertTrue(preflight.contains("nowMs - run.startedAtMs > FURNACE_SMELT_TOTAL_TIMEOUT_MS"));
        ordered(smelt, "run.handPreparation.pending()", "FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(");
        ordered(smelt, "run.handPreparation.pending()", "return blockUseDecision(");
        int pending = smelt.indexOf("run.handPreparation.pending()");
        int wait = smelt.indexOf("FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(");
        assertTrue(smelt.substring(pending, wait).contains("prepareFurnaceHand("));
    }

    @Test void allExistingFurnaceOpeningRoutesRemainBehindHandPreparation() throws Exception {
        String smelt = member(source(), "private ControlDecision resolveSmeltCharcoalControl(");
        assertEquals(3, occurrences(smelt, "return blockUseDecision("),
            "Pending, direct, and raycast opening routes must remain explicit");
        int unopened = smelt.indexOf("if (!(currentHandler instanceof AbstractFurnaceScreenHandler furnaceHandler))");
        int ready = smelt.indexOf("if (run.stage == SmeltControlPlanner.Stage.START)", unopened);
        assertTrue(unopened >= 0 && ready > unopened);
        String opening = smelt.substring(unopened, ready);
        ordered(opening, "prepareFurnaceHand(", "return blockUseDecision(");
        assertEquals(3, occurrences(opening, "prepareFurnaceHand("));
        int previousUse = -1;
        for (int use = opening.indexOf("return blockUseDecision("); use >= 0;
             use = opening.indexOf("return blockUseDecision(", use + 1)) {
            int preparation = opening.lastIndexOf("prepareFurnaceHand(", use);
            assertTrue(preparation > previousUse, "Each opening route needs its own fresh preparation gate");
            assertTrue(opening.substring(preparation, use).contains("if (preparation != null) return preparation;"));
            previousUse = use;
        }
        assertTrue(opening.contains("run.furnaceOpenInteractedAtMs > 0L"));
        assertTrue(opening.contains("waitedMs < CRAFT_TABLE_OPEN_RETRY_MS"));
        assertTrue(opening.contains("run.directFurnaceOpenAttempts >= 3"));
        assertTrue(opening.contains("_waiting_for_furnace_open"));
        assertTrue(opening.contains("withinInteractionReach("));
        assertTrue(opening.contains("raycastForInteraction("));
    }

    @Test void contextAccountsForCookingWaitInFlightIngredientClicksAndAppliedOpening() throws Exception {
        String context = member(source(), "private FurnaceHandPreparation.Context furnaceHandPreparationContext(");
        for (String required : List.of("run.stage", "run.outputWaitStartedAtMs",
            "FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(", "run.desiredInputCount",
            "run.rawFuelClickPending", "run.lastClickAtMs", "CRAFT_CLICK_SETTLE_MS",
            "run.furnaceOpenInteractedAtMs", "AbstractFurnaceScreenHandler")) {
            assertTrue(context.contains(required), required);
        }
        assertFalse(Pattern.compile("run\\.(?:stage|outputWaitStartedAtMs|rawFuelClickPending)\\s*=(?!=)")
            .matcher(context).find());
    }

    @Test void requestedFurnaceOpeningIsNotCountedAsAppliedByPreparation() throws Exception {
        String source = source();
        String acknowledge = member(source, "private void acknowledgeContainerInteraction(");
        assertTrue(acknowledge.contains("!receipt.applied()"));
        assertTrue(acknowledge.contains("receipt.requestId().equals(activeSmeltCharcoal.pendingFurnaceOpenRequestId)"));
        ordered(acknowledge, "!receipt.applied()", "run.directFurnaceOpenAttempts++");
        assertTrue(acknowledge.contains("run.furnaceOpenInteractedAtMs = receipt.timestampMs()"));
        assertTrue(acknowledge.contains("run.appliedFurnaceOpenRequestId = receipt.requestId()"));
        String hand = member(source, "private ControlDecision prepareFurnaceHand(");
        assertFalse(hand.contains("furnaceOpenRequestId("));
        assertFalse(hand.contains("directFurnaceOpenAttempts"));
        assertFalse(hand.contains("appliedFurnaceOpenRequestId ="));
    }

    @Test void runRecreationIsRejectedBeforeRegistryAllocationAndPreservesTerminalReasons() throws Exception {
        String source = source();
        assertTrue(source.contains("private final FurnaceHandPreparation.Registry furnaceHandPreparations"));
        String smelt = member(source, "private ControlDecision resolveSmeltCharcoalControl(");
        assertTrue(smelt.contains("activeSmeltCharcoal.recipe != recipe"));
        ordered(smelt, "furnaceHandPreparations.contains(commandId)", "furnaceHandPreparations.get(commandId, client.world, player)");
        assertTrue(smelt.contains("_hand_prep_stale_state"));
        assertTrue(smelt.contains("_hand_prep_tracking_limit"));
        assertTrue(smelt.contains("finishedSmeltCommandReasons.get(commandId)"),
            "A failed command must not become a generic complete result on replay");
        ordered(smelt, "finishedSmeltCommandReasons.get(commandId)", "new SmeltCharcoalRun(");
        assertTrue(smelt.contains("completedSmeltCharcoalCommandIds.contains(commandId)"));
        assertTrue(source.contains("FurnaceHandPreparation handPreparation"));
    }

    @Test void terminalPathsRetirePreparationButReflexesCannotClearSpentTransactions() throws Exception {
        String source = source();
        String complete = member(source, "private ControlDecision completeSmeltCharcoal(");
        String fail = member(source, "private ControlDecision failSmeltCharcoal(");
        for (String terminal : List.of(complete, fail)) {
            assertTrue(terminal.contains("furnaceHandPreparations.completed(run.commandId)"));
            ordered(terminal, "completedSmeltCharcoalCommandIds.add(run.commandId)",
                "furnaceHandPreparations.completed(run.commandId)");
            assertTrue(terminal.contains("finishedSmeltCommandReasons.put(run.commandId, completionReason)"));
        }
        assertFalse(source.contains("furnaceHandPreparations.clear("));
        assertFalse(Pattern.compile("(?m)^\\s*furnaceHandPreparations\\s*=").matcher(source).find(),
            "Only the final declaration may construct the registry; no lifecycle reassignment");
    }

    @Test void originalDeadlinesBatchRequirementsAndCachedTransactionSlotsRemainIntact() throws Exception {
        String source = source();
        assertTrue(source.contains("FURNACE_SMELT_TOTAL_TIMEOUT_MS = 90_000L"));
        assertTrue(source.contains("CRAFT_CLICK_SETTLE_MS = 150L"));
        String observe = member(source, "private CraftHandPreparation.Observation observeCraftHand(");
        assertTrue(observe.contains("effective.expiresAtMs() > nowMs"));
        assertTrue(observe.contains("slot = 1; slot <= 4; slot++"));
        assertTrue(observe.contains("player.getInventory().getStack(slot).copy()"));
        String run = member(source, "private static final class SmeltCharcoalRun");
        for (String field : List.of("final String commandId", "final long startedAtMs", "final int baselineRawIron",
            "final int baselineIronIngots", "final int baselineCharcoal", "int inputSourceSlot = -1",
            "int fuelSourceSlot = -1", "long outputWaitStartedAtMs = 0L")) assertTrue(run.contains(field), field);
        String batch = member(source, "private int desiredSmeltInputCount(");
        assertTrue(batch.contains("FurnaceSmeltPlanner.desiredRawIronBatchSize(rawIron, ironIngots, ironPickaxes)"));
        assertTrue(batch.contains("return 1;"), "Charcoal still requests one output");
    }

    @Test void furnaceAdapterDoesNotRelaxHeldItemOrCraftingAuthorization() throws Exception {
        String source = source();
        String blockUse = member(source, "private ControlDecision blockUseDecision(");
        assertTrue(blockUse.contains("selectTableOpenHotbarSlot(player)"));
        assertTrue(blockUse.contains("_empty_main_hand_required"));
        assertFalse(blockUse.contains("prepareFurnaceHand("));
        assertFalse(blockUse.contains("prepareCraftTableHand("));
        String craft = member(source, "private ControlDecision prepareCraftTableHand(");
        assertTrue(craft.contains("run.stage != Craft3x3ControlPlanner.Stage.START"));
        assertTrue(craft.contains("interactionAuthority.clickPlayerInventorySlot("));
        assertFalse(craft.contains("FurnaceHandPreparation"));
        String furnace = member(source, "private ControlDecision prepareFurnaceHand(");
        assertFalse(furnace.contains("prepareCraftTableHand("));
        String log = member(source, "private void logFurnaceHandPreparation(");
        assertTrue(log.contains("event.equals(run.lastHandPreparationEvent)"));
        assertTrue(log.contains("nowMs - run.lastHandPreparationLogAt < 1_000L"));
        assertTrue(log.contains("commandId={} event={} action={}"));
        assertTrue(log.contains("attempts={} stage={} elapsedMs={}"));
    }
}
