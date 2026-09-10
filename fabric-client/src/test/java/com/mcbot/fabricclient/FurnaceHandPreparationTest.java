package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.text.Text;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Furnace-stage composition tests; shared stack-selection details remain in CraftHandPreparationTest. */
final class FurnaceHandPreparationTest {
    private final Object world = new Object();
    private final Object player = new Object();
    private final Object handler = new Object();

    @BeforeAll static void registries() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    private FurnaceHandPreparation transaction() {
        return new FurnaceHandPreparation("smelt-1", world, player);
    }

    private static FurnaceHandPreparation.Context context(SmeltControlPlanner.Stage stage) {
        return new FurnaceHandPreparation.Context(stage, false, false, false);
    }

    private List<ItemStack> inventory() {
        var slots = new ArrayList<ItemStack>();
        for (int slot = 0; slot < 41; slot++) {
            slots.add(slot < 9 ? new ItemStack(Items.COBBLESTONE, 5) : ItemStack.EMPTY);
        }
        slots.set(2, new ItemStack(Items.STICK, 8));
        slots.set(3, new ItemStack(Items.RAW_IRON, 3));
        slots.set(10, new ItemStack(Items.COAL, 2));
        return slots;
    }

    private CraftHandPreparation.Observation observe(List<ItemStack> slots) {
        return new CraftHandPreparation.Observation(world, player, handler, handler,
            0, 0, "smelt-1", true, true, true, 0, slots);
    }

    private CraftHandPreparation.Observation changed(CraftHandPreparation.Observation o, String field) {
        return new CraftHandPreparation.Observation(
            field.equals("world") ? new Object() : o.world(),
            field.equals("player") ? new Object() : o.player(),
            field.equals("handler") ? new Object() : o.handler(), o.playerHandler(),
            field.equals("sync") ? 1 : o.syncId(), o.playerSyncId(),
            field.equals("command") ? "smelt-other" : o.commandId(), !field.equals("expired"),
            !field.equals("cursor"), !field.equals("grid"), o.selectedSlot(), o.inventory());
    }

    private List<ItemStack> swapped(List<ItemStack> slots) {
        var after = new ArrayList<>(slots.stream().map(ItemStack::copy).toList());
        after.set(9, after.get(2));
        after.set(2, ItemStack.EMPTY);
        return after;
    }

    private FurnaceHandPreparation dispatched(List<ItemStack> slots, SmeltControlPlanner.Stage stage, long nowMs) {
        var tx = transaction();
        var selection = tx.step(observe(slots), context(stage), nowMs);
        assertEquals(CraftHandPreparation.Action.SWAP, selection.action());
        assertEquals(2, selection.hotbarSlot());
        assertEquals(9, selection.inventorySlot());
        assertEquals(1, selection.attempts());
        assertTrue(tx.dispatchStateMatches(observe(slots), context(stage)));
        assertEquals("dispatched", tx.dispatched(true, null, nowMs).reason());
        return tx;
    }

    @Test void firstPreparationIsAllowedAtStartAndSafeOutputReopen() {
        for (var stage : List.of(SmeltControlPlanner.Stage.START, SmeltControlPlanner.Stage.WAIT_OUTPUT)) {
            var result = transaction().step(observe(inventory()), context(stage), 100);
            assertEquals(CraftHandPreparation.Action.SWAP, result.action(), stage.name());
            assertEquals(1, result.attempts());
        }
    }

    @Test void otherTransactionStagesRefuseNewMutationWithoutSpendingAnAttempt() {
        for (var stage : SmeltControlPlanner.Stage.values()) {
            if (stage == SmeltControlPlanner.Stage.START || stage == SmeltControlPlanner.Stage.WAIT_OUTPUT) continue;
            var tx = transaction();
            var result = tx.step(observe(inventory()), context(stage), 100);
            assertEquals(CraftHandPreparation.Action.FAIL, result.action(), stage.name());
            assertEquals("stage_not_safe", result.reason(), stage.name());
            assertEquals(0, result.attempts());
            assertFalse(tx.pending());
            assertFalse(tx.allowRecipeCompletion(true));
        }
    }

    @Test void existingEmptyHotbarRetainsSelectionAtEveryTransactionStage() {
        var slots = inventory();
        slots.set(1, ItemStack.EMPTY);
        slots.set(6, ItemStack.EMPTY);
        for (var stage : SmeltControlPlanner.Stage.values()) {
            var result = transaction().step(observe(slots), context(stage), 100);
            assertEquals(CraftHandPreparation.Action.READY, result.action(), stage.name());
            assertEquals("existing_empty", result.reason());
            assertEquals(1, result.hotbarSlot());
            assertEquals(0, result.attempts());
        }
    }

    @Test void normalClosedScreenCookingWaitDoesNotSpendPreparationBudget() {
        var tx = transaction();
        var waiting = new FurnaceHandPreparation.Context(SmeltControlPlanner.Stage.WAIT_OUTPUT, true, false, false);
        for (long at : List.of(1_000L, 20_000L, 29_249L)) {
            var result = tx.step(observe(inventory()), waiting, at);
            assertEquals(CraftHandPreparation.Action.WAIT, result.action());
            assertEquals("output_wait", result.reason());
            assertEquals(0, result.attempts());
            assertFalse(tx.pending());
        }
        assertEquals(CraftHandPreparation.Action.SWAP,
            tx.step(observe(inventory()), context(SmeltControlPlanner.Stage.WAIT_OUTPUT), 29_250).action());
    }

    @Test void unresolvedAppliedOpeningWaitsEvenWithAnEmptyHotbar() {
        for (boolean emptySlot : List.of(false, true)) {
            var slots = inventory();
            if (emptySlot) slots.set(1, ItemStack.EMPTY);
            var tx = transaction();
            var opening = new FurnaceHandPreparation.Context(SmeltControlPlanner.Stage.START, false, false, true);
            var waiting = tx.step(observe(slots), opening, 100);
            assertEquals(CraftHandPreparation.Action.WAIT, waiting.action());
            assertEquals("open_receipt_pending", waiting.reason());
            assertEquals(0, waiting.attempts());
            assertFalse(tx.pending());
            assertEquals(emptySlot ? CraftHandPreparation.Action.READY : CraftHandPreparation.Action.SWAP,
                tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 200).action());
        }
    }

    @Test void closedCookingWaitStillWinsWhenAnEmptySlotAlreadyExists() {
        var slots = inventory(); slots.set(1, ItemStack.EMPTY);
        var waiting = new FurnaceHandPreparation.Context(SmeltControlPlanner.Stage.WAIT_OUTPUT, true, false, false);
        var result = transaction().step(observe(slots), waiting, 0);
        assertEquals(CraftHandPreparation.Action.WAIT, result.action());
        assertEquals("output_wait", result.reason());
        assertEquals(0, result.attempts());
    }

    @Test void pendingIngredientOrFuelClickDeniesNewPreparation() {
        for (var stage : List.of(SmeltControlPlanner.Stage.START, SmeltControlPlanner.Stage.WAIT_OUTPUT)) {
            var unsafe = new FurnaceHandPreparation.Context(stage, false, true, false);
            var result = transaction().step(observe(inventory()), unsafe, 100);
            assertEquals(CraftHandPreparation.Action.FAIL, result.action());
            assertEquals("stale_state", result.reason());
            assertEquals(0, result.attempts());
        }
    }

    @Test void pendingIngredientFlagDoesNotDisableExistingEmptySelection() {
        var slots = inventory(); slots.set(1, ItemStack.EMPTY);
        for (var stage : SmeltControlPlanner.Stage.values()) {
            var result = transaction().step(observe(slots),
                new FurnaceHandPreparation.Context(stage, false, true, false), 100);
            assertEquals(CraftHandPreparation.Action.READY, result.action(), stage.name());
            assertEquals(0, result.attempts());
        }
    }

    @Test void capacityAndProtectedSourceFailuresPropagateAtBothAdmissionStages() {
        for (var stage : List.of(SmeltControlPlanner.Stage.START, SmeltControlPlanner.Stage.WAIT_OUTPUT)) {
            var full = inventory();
            for (int slot = 9; slot < 36; slot++) full.set(slot, new ItemStack(Items.DIRT));
            var capacity = transaction().step(observe(full), context(stage), 0);
            assertEquals("no_capacity", capacity.reason());
            assertEquals(0, capacity.attempts());
            var protectedOnly = inventory();
            protectedOnly.set(2, new ItemStack(Items.IRON_PICKAXE));
            protectedOnly.set(3, new ItemStack(Items.COOKED_BEEF));
            var protectedResult = transaction().step(observe(protectedOnly), context(stage), 0);
            assertEquals("no_eligible_source", protectedResult.reason());
            assertEquals(0, protectedResult.attempts());
        }
    }

    @Test void invalidIdentityCursorGridAndHandlerCannotReachSwapThroughWrapper() {
        for (String field : List.of("world", "player", "command", "expired", "handler", "sync", "cursor", "grid")) {
            var result = transaction().step(changed(observe(inventory()), field), context(SmeltControlPlanner.Stage.START), 0);
            assertEquals(CraftHandPreparation.Action.FAIL, result.action(), field);
            assertEquals(0, result.attempts(), field);
        }
    }

    @Test void missingContextAndMalformedInventoryFailClosed() {
        assertEquals(CraftHandPreparation.Action.FAIL, transaction().step(observe(inventory()), null, 0).action());
        var empty = inventory(); empty.set(1, ItemStack.EMPTY);
        assertEquals("stale_state", transaction().step(observe(empty),
            new FurnaceHandPreparation.Context(null, false, false, false), 0).reason());
        assertEquals(CraftHandPreparation.Action.FAIL, transaction().step(null, context(SmeltControlPlanner.Stage.START), 0).action());
        var shortSlots = inventory(); shortSlots.remove(40);
        assertEquals("invalid_inventory", transaction().step(observe(shortSlots), context(SmeltControlPlanner.Stage.START), 0).reason());
        var unknownSlot = inventory(); unknownSlot.set(5, null);
        assertEquals("invalid_inventory", transaction().step(observe(unknownSlot), context(SmeltControlPlanner.Stage.START), 0).reason());
    }

    @Test void dispatchRevalidatesBothExactInventoryAndCapturedFurnaceStage() {
        var tx = transaction(); var slots = inventory();
        tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 0);
        assertFalse(tx.dispatchStateMatches(observe(swapped(slots)), context(SmeltControlPlanner.Stage.START)));
        assertFalse(tx.dispatchStateMatches(observe(slots), context(SmeltControlPlanner.Stage.WAIT_OUTPUT)));
        assertFalse(tx.dispatchStateMatches(changed(observe(slots), "handler"), context(SmeltControlPlanner.Stage.START)));
        for (var changedContext : List.of(
            new FurnaceHandPreparation.Context(SmeltControlPlanner.Stage.START, true, false, false),
            new FurnaceHandPreparation.Context(SmeltControlPlanner.Stage.START, false, true, false),
            new FurnaceHandPreparation.Context(SmeltControlPlanner.Stage.START, false, false, true))) {
            assertFalse(tx.dispatchStateMatches(observe(slots), changedContext));
        }
        assertEquals("stale_state", tx.dispatched(false, "stale_state", 0).reason());
        assertEquals(1, tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 500).attempts());
    }

    @Test void receiptDenialAndUncertainExceptionAreLatchedAcrossReopening() {
        for (String reason : List.of("authorization_denied", "dispatch_exception")) {
            var tx = transaction(); var slots = inventory();
            tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 0);
            assertEquals(reason, tx.dispatched(false, reason, 0).reason());
            var retried = tx.step(observe(swapped(slots)), context(SmeltControlPlanner.Stage.WAIT_OUTPUT), 500);
            assertEquals(CraftHandPreparation.Action.FAIL, retried.action());
            assertEquals(reason, retried.reason());
            assertEquals(1, retried.attempts());
            assertFalse(tx.allowRecipeCompletion(true));
        }
    }

    @Test void missingReceiptNeverTurnsIntoAnotherDispatch() {
        var tx = transaction(); var slots = inventory();
        tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 0);
        var missing = tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 1);
        assertEquals("dispatch_unreceipted", missing.reason());
        assertEquals(1, missing.attempts());
        assertEquals(CraftHandPreparation.Action.FAIL,
            tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 2).action());
    }

    @Test void bothAdmissionStagesKeepExactClickSettlementBoundary() {
        for (var stage : List.of(SmeltControlPlanner.Stage.START, SmeltControlPlanner.Stage.WAIT_OUTPUT)) {
            var slots = inventory(); var tx = dispatched(slots, stage, 100);
            assertEquals(CraftHandPreparation.Action.WAIT, tx.step(observe(swapped(slots)), context(stage), 249).action());
            assertFalse(tx.allowRecipeCompletion(true));
            assertEquals("verified", tx.step(observe(swapped(slots)), context(stage), 250).reason());
            assertTrue(tx.allowRecipeCompletion(true));
        }
    }

    @Test void exactVerificationDeadlineAcceptsOnlyObservedCompleteSwap() {
        var stage = SmeltControlPlanner.Stage.WAIT_OUTPUT;
        var slots = inventory(); var tx = dispatched(slots, stage, 100);
        assertEquals(CraftHandPreparation.Action.WAIT, tx.step(observe(slots), context(stage), 1099).action());
        assertEquals("verified", tx.step(observe(swapped(slots)), context(stage), 1100).reason());
        assertEquals("verification_timeout", dispatched(slots, stage, 100).step(observe(slots), context(stage), 1100).reason());
        assertEquals("verification_timeout", dispatched(slots, stage, 100).step(observe(swapped(slots)), context(stage), 1101).reason());
    }

    @Test void verificationRejectsStageChangesEvenBetweenTheTwoAdmissionStages() {
        var slots = inventory(); var tx = dispatched(slots, SmeltControlPlanner.Stage.START, 0);
        var result = tx.step(observe(swapped(slots)), context(SmeltControlPlanner.Stage.WAIT_OUTPUT), 150);
        assertEquals("stale_state", result.reason());
        assertEquals(1, result.attempts());
        assertFalse(tx.allowRecipeCompletion(true));
    }

    @Test void pendingVerificationCannotHideBehindCookingOrOpeningWaits() {
        var stage = SmeltControlPlanner.Stage.WAIT_OUTPUT;
        for (var unsafe : List.of(
            new FurnaceHandPreparation.Context(stage, true, false, false),
            new FurnaceHandPreparation.Context(stage, false, true, false),
            new FurnaceHandPreparation.Context(stage, false, false, true))) {
            var slots = inventory(); var tx = dispatched(slots, stage, 0);
            var result = tx.step(observe(swapped(slots)), unsafe, 150);
            assertEquals(CraftHandPreparation.Action.FAIL, result.action());
            assertEquals("stale_state", result.reason());
            assertEquals(1, result.attempts());
            assertFalse(tx.allowRecipeCompletion(true));
        }
    }

    @Test void interruptionPreservesSpentAttemptAndVerificationTime() {
        var stage = SmeltControlPlanner.Stage.WAIT_OUTPUT;
        var slots = inventory(); var tx = dispatched(slots, stage, 0);
        assertEquals("verified", tx.step(observe(swapped(slots)), context(stage), 750).reason());
        var timedOut = dispatched(slots, stage, 0).step(observe(swapped(slots)), context(stage), 1_001);
        assertEquals("verification_timeout", timedOut.reason());
        assertEquals(1, timedOut.attempts());
        for (String field : List.of("world", "player", "command", "handler", "expired")) {
            var changedResult = dispatched(slots, stage, 0).step(changed(observe(swapped(slots)), field), context(stage), 500);
            assertEquals(CraftHandPreparation.Action.FAIL, changedResult.action(), field);
            assertEquals(1, changedResult.attempts(), field);
        }
    }

    @Test void fullStackComponentsAndSmeltResourcesRemainExact() {
        var slots = inventory();
        slots.get(2).set(DataComponentTypes.CUSTOM_NAME, Text.literal("furnace-preparation-stack"));
        var tx = dispatched(slots, SmeltControlPlanner.Stage.START, 0);
        var after = swapped(slots);
        assertEquals("verified", tx.step(observe(after), context(SmeltControlPlanner.Stage.START), 150).reason());
        assertTrue(ItemStack.areEqual(slots.get(2), after.get(9)));
        assertTrue(after.get(2).isEmpty());
        for (int slot = 0; slot < 41; slot++) {
            if (slot != 2 && slot != 9) assertTrue(ItemStack.areEqual(slots.get(slot), after.get(slot)), "slot " + slot);
        }
    }

    @Test void unrelatedOutputGainCannotCompletePendingOrInconsistentPreparation() {
        var stage = SmeltControlPlanner.Stage.WAIT_OUTPUT;
        var slots = inventory(); var tx = dispatched(slots, stage, 0);
        var after = swapped(slots); after.set(11, new ItemStack(Items.IRON_INGOT, 3));
        assertTrue(FurnaceSmeltPlanner.completedByInventoryDelta(0, 3, 3));
        assertEquals(SmeltControlPlanner.Action.CONTINUE, SmeltControlPlanner.decidePreflight(
            new SmeltControlPlanner.State(stage), tx.allowRecipeCompletion(true), false, true).action());
        assertEquals("inventory_mismatch", tx.step(observe(after), context(stage), 150).reason());
        assertFalse(tx.allowRecipeCompletion(true));
    }

    @Test void pendingVerificationDoesNotOverrideTotalTimeoutOrMissingInteractionManager() {
        var stage = SmeltControlPlanner.Stage.WAIT_OUTPUT;
        var tx = dispatched(inventory(), stage, 0);
        assertEquals(SmeltControlPlanner.Action.FAIL_TOTAL_TIMEOUT, SmeltControlPlanner.decidePreflight(
            new SmeltControlPlanner.State(stage), tx.allowRecipeCompletion(true), true, true).action());
        assertEquals(SmeltControlPlanner.Action.FAIL_MISSING_INTERACTION_MANAGER, SmeltControlPlanner.decidePreflight(
            new SmeltControlPlanner.State(stage), tx.allowRecipeCompletion(true), false, false).action());
    }

    @Test void verifiedPreparationCannotBeRefundedByScreenReopenOrAnotherStage() {
        var slots = inventory(); var tx = dispatched(slots, SmeltControlPlanner.Stage.START, 0);
        var after = swapped(slots);
        assertEquals("verified", tx.step(observe(after), context(SmeltControlPlanner.Stage.START), 150).reason());
        after.set(2, new ItemStack(Items.COAL));
        var exhausted = tx.step(observe(after), context(SmeltControlPlanner.Stage.PICK_INPUT_STACK), 200);
        assertEquals("attempt_exhausted", exhausted.reason());
        assertEquals(1, exhausted.attempts());
        assertEquals("attempt_exhausted", tx.step(observe(after), context(SmeltControlPlanner.Stage.WAIT_OUTPUT), 300).reason());
    }

    @Test void afterRefillAnotherExistingEmptySlotWorksWithoutAnotherMutation() {
        var slots = inventory(); var tx = dispatched(slots, SmeltControlPlanner.Stage.START, 0);
        var after = swapped(slots);
        tx.step(observe(after), context(SmeltControlPlanner.Stage.START), 150);
        after.set(2, new ItemStack(Items.COAL)); after.set(7, ItemStack.EMPTY);
        var selected = tx.step(observe(after), context(SmeltControlPlanner.Stage.WAIT_OUTPUT), 200);
        assertEquals(CraftHandPreparation.Action.READY, selected.action());
        assertEquals(7, selected.hotbarSlot());
        assertEquals(1, selected.attempts());
    }

    @Test void commandRegistryRetainsTheSameSpentTransactionAcrossInterleavingAndWorldChanges() {
        var registry = new FurnaceHandPreparation.Registry();
        var slots = inventory(); var tx = registry.get("smelt-1", world, player);
        tx.step(observe(slots), context(SmeltControlPlanner.Stage.START), 0);
        tx.dispatched(true, null, 0);
        registry.get("smelt-other", world, player);
        assertSame(tx, registry.get("smelt-1", world, player));
        assertSame(tx, registry.get("smelt-1", new Object(), new Object()));
        assertTrue(registry.contains("smelt-1"));
        assertEquals("verification_timeout", tx.step(observe(swapped(slots)), context(SmeltControlPlanner.Stage.START), 2_000).reason());
    }

    @Test void registryCapacityNeverEvictsOrRefundsACommand() {
        var registry = new FurnaceHandPreparation.Registry();
        var original = registry.get("smelt-1", world, player);
        for (int i = 0; i < 255; i++) assertNotNull(registry.get("other-" + i, world, player));
        assertNull(registry.get("overflow", world, player));
        assertSame(original, registry.get("smelt-1", world, player));
        registry.completed("other-0");
        assertNotNull(registry.get("new-command", world, player));
        assertSame(original, registry.get("smelt-1", world, player));
    }

    @Test void preparationDoesNotChangeThreeIngotOrSingleCharcoalOutputAccounting() {
        var slots = inventory(); var tx = dispatched(slots, SmeltControlPlanner.Stage.START, 0);
        tx.step(observe(swapped(slots)), context(SmeltControlPlanner.Stage.START), 150);
        assertEquals(3, FurnaceSmeltPlanner.desiredRawIronBatchSize(3, 0, 0));
        assertEquals(1, FurnaceSmeltPlanner.desiredFuelItemCount(3, "coal"));
        assertFalse(tx.allowRecipeCompletion(FurnaceSmeltPlanner.completedByInventoryDelta(2, 4, 3)));
        assertTrue(tx.allowRecipeCompletion(FurnaceSmeltPlanner.completedByInventoryDelta(2, 5, 3)));
        assertFalse(tx.allowRecipeCompletion(FurnaceSmeltPlanner.completedByInventoryDelta(4, 4, 1)));
        assertTrue(tx.allowRecipeCompletion(FurnaceSmeltPlanner.completedByInventoryDelta(4, 5, 1)));
        assertFalse(FurnaceSmeltPlanner.isExpectedOutput("charcoal", 3, "iron_ingot", 3));
        assertFalse(FurnaceSmeltPlanner.isExpectedOutput("iron_ingot", 1, "charcoal", 1));
    }

    @Test void normalCookingReopenBoundaryIsNotMovedByHandPreparation() {
        assertTrue(FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(29_249, 3));
        assertFalse(FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(29_250, 3));
        assertFalse(FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(0, 1));
        assertEquals(30_000, FurnaceSmeltPlanner.expectedSmeltReadyMs(3));
        assertEquals(10_000, FurnaceSmeltPlanner.expectedSmeltReadyMs(1));
        var slots = inventory(); var tx = dispatched(slots, SmeltControlPlanner.Stage.WAIT_OUTPUT, 29_250);
        assertEquals("verified", tx.step(observe(swapped(slots)), context(SmeltControlPlanner.Stage.WAIT_OUTPUT), 29_400).reason());
        assertEquals(30_000, FurnaceSmeltPlanner.expectedSmeltReadyMs(3));
    }
}
