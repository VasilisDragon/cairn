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

final class CraftHandPreparationTest {
    private final Object world = new Object(), player = new Object(), handler = new Object();
    @BeforeAll static void registries() { SharedConstants.createGameVersion(); Bootstrap.initialize(); }
    private CraftHandPreparation transaction() { return new CraftHandPreparation("craft-1", world, player); }
    private List<ItemStack> inventory() {
        List<ItemStack> slots = new ArrayList<>();
        for (int i = 0; i < 41; i++) slots.add(i < 9 ? new ItemStack(Items.COBBLESTONE, 5) : ItemStack.EMPTY);
        slots.set(2, new ItemStack(Items.STICK, 4));
        slots.set(3, new ItemStack(Items.IRON_INGOT, 3));
        return slots;
    }
    private CraftHandPreparation.Observation observe(List<ItemStack> slots) {
        return new CraftHandPreparation.Observation(world, player, handler, handler, 0, 0, "craft-1", true, true, true, 0, slots);
    }
    private CraftHandPreparation.Observation change(CraftHandPreparation.Observation o, String field) {
        return new CraftHandPreparation.Observation(field.equals("world") ? new Object() : o.world(),
            field.equals("player") ? new Object() : o.player(), field.equals("handler") ? new Object() : o.handler(),
            o.playerHandler(), field.equals("sync") ? 1 : o.syncId(), o.playerSyncId(),
            field.equals("command") ? "other" : o.commandId(), !field.equals("expired"),
            !field.equals("cursor"), !field.equals("grid"), o.selectedSlot(), o.inventory());
    }
    private List<ItemStack> swapped(List<ItemStack> before, int hotbar, int destination) {
        List<ItemStack> after = new ArrayList<>(before.stream().map(ItemStack::copy).toList());
        after.set(destination, after.get(hotbar)); after.set(hotbar, ItemStack.EMPTY);
        return after;
    }
    private CraftHandPreparation dispatched(List<ItemStack> slots, long at) {
        var tx = transaction();
        assertEquals(CraftHandPreparation.Action.SWAP, tx.step(observe(slots), at).action());
        assertTrue(tx.dispatchStateMatches(observe(slots)));
        assertEquals("dispatched", tx.dispatched(true, null, at).reason());
        return tx;
    }

    @Test void alreadyEmptyUsesLowestSlotWithoutMutation() {
        var slots = inventory(); slots.set(1, ItemStack.EMPTY); slots.set(5, ItemStack.EMPTY);
        var result = transaction().step(observe(slots), 100);
        assertEquals(CraftHandPreparation.Action.READY, result.action()); assertEquals(1, result.hotbarSlot()); assertEquals(0, result.attempts());
    }
    @Test void choosesLowestUnselectedEligibleAndMainInventoryDestination() {
        var slots = inventory(); slots.set(9, new ItemStack(Items.DIRT));
        var result = transaction().step(observe(slots), 100);
        assertEquals(CraftHandPreparation.Action.SWAP, result.action()); assertEquals(2, result.hotbarSlot()); assertEquals(10, result.inventorySlot());
    }
    @Test void selectedEligibleStackIsFallbackOnly() {
        var slots = inventory(); var o = observe(slots);
        var selected = new CraftHandPreparation.Observation(world, player, handler, handler, 0, 0, "craft-1", true, true, true, 2, slots);
        assertEquals(3, transaction().step(selected, 0).hotbarSlot());
        slots.set(3, new ItemStack(Items.COBBLESTONE));
        assertEquals(2, transaction().step(selected, 0).hotbarSlot());
    }
    @Test void fullStorageFailsWithoutAttempt() {
        var slots = inventory(); for (int i = 9; i < 36; i++) slots.set(i, new ItemStack(Items.DIRT));
        var result = transaction().step(observe(slots), 0);
        assertEquals("no_capacity", result.reason()); assertEquals(0, result.attempts());
    }
    @Test void allProtectedFailsWithoutAttempt() {
        var slots = inventory(); slots.set(2, new ItemStack(Items.IRON_PICKAXE)); slots.set(3, new ItemStack(Items.COOKED_BEEF));
        var result = transaction().step(observe(slots), 0);
        assertEquals("no_eligible_source", result.reason()); assertEquals(0, result.attempts());
    }
    @Test void offhandAndArmorCapacityAreNotUsed() {
        var slots = inventory(); for (int i = 9; i < 36; i++) slots.set(i, new ItemStack(Items.DIRT));
        assertEquals("no_capacity", transaction().step(observe(slots), 0).reason());
    }
    @Test void contextAndCursorGridFailuresNeverDispatch() {
        for (String field : List.of("world", "player", "handler", "sync", "command", "expired", "cursor", "grid")) {
            var result = transaction().step(change(observe(inventory()), field), 0);
            assertEquals(CraftHandPreparation.Action.FAIL, result.action(), field); assertEquals(0, result.attempts(), field);
        }
    }
    @Test void malformedAndMissingObservationsFailClosed() {
        assertEquals(CraftHandPreparation.Action.FAIL, transaction().step(null, 0).action());
        var shortSlots = inventory(); shortSlots.remove(40);
        assertEquals("invalid_inventory", transaction().step(observe(shortSlots), 0).reason());
        var nullSlot = inventory(); nullSlot.set(5, null);
        assertEquals("invalid_inventory", transaction().step(observe(nullSlot), 0).reason());
        assertEquals("stale_state", new CraftHandPreparation("", world, player).step(observe(inventory()), 0).reason());
    }
    @Test void secondObservationMustMatchBeforeClick() {
        var slots = inventory(); var tx = transaction(); tx.step(observe(slots), 0);
        var changed = swapped(slots, 2, 9);
        assertFalse(tx.dispatchStateMatches(observe(changed)));
        assertFalse(tx.dispatchStateMatches(change(observe(slots), "handler")));
        assertFalse(tx.dispatchStateMatches(change(observe(slots), "expired")));
    }
    @Test void appliedSwapWaitsUntilExactSettleBoundary() {
        var slots = inventory(); var tx = dispatched(slots, 100);
        var after = observe(swapped(slots, 2, 9));
        assertEquals(CraftHandPreparation.Action.WAIT, tx.step(after, 249).action());
        assertEquals("verified", tx.step(after, 250).reason());
    }
    @Test void delayedUnchangedObservationCanSettleBeforeDeadline() {
        var slots = inventory(); var tx = dispatched(slots, 100);
        assertEquals(CraftHandPreparation.Action.WAIT, tx.step(observe(slots), 1099).action());
        assertEquals("verified", tx.step(observe(swapped(slots, 2, 9)), 1100).reason());
    }
    @Test void verificationTimeoutIsExactAndNeverRefunded() {
        var slots = inventory(); var tx = dispatched(slots, 100);
        assertEquals("verification_timeout", tx.step(observe(slots), 1100).reason());
        assertEquals("verification_timeout", tx.step(observe(swapped(slots, 2, 9)), 1101).reason());
        assertEquals("verification_timeout", dispatched(slots, 100).step(observe(swapped(slots, 2, 9)), 1101).reason());
    }
    @Test void denialAndUnknownReceiptAreLatched() {
        var slots = inventory(); var tx = transaction(); tx.step(observe(slots), 0);
        assertEquals("authorization_denied", tx.dispatched(false, null, 0).reason());
        assertEquals(1, tx.step(observe(slots), 2000).attempts());
        assertEquals(CraftHandPreparation.Action.FAIL, tx.step(observe(swapped(slots, 2, 9)), 2100).action());
        tx = transaction(); tx.step(observe(slots), 0);
        assertEquals("dispatch_unreceipted", tx.step(observe(slots), 1).reason());
    }
    @Test void componentCountAndAllOtherSlotsMustBePreserved() {
        var slots = inventory(); slots.get(2).set(DataComponentTypes.CUSTOM_NAME, Text.literal("component-test"));
        for (String mutation : List.of("count", "component", "armor", "offhand", "other")) {
            var tx = dispatched(slots, 0); var after = swapped(slots, 2, 9);
            switch (mutation) {
                case "count" -> after.get(9).decrement(1);
                case "component" -> after.get(9).remove(DataComponentTypes.CUSTOM_NAME);
                case "armor" -> after.set(36, new ItemStack(Items.IRON_BOOTS));
                case "offhand" -> after.set(40, new ItemStack(Items.SHIELD));
                default -> after.set(10, new ItemStack(Items.DIRT));
            }
            assertEquals("inventory_mismatch", tx.step(observe(after), 150).reason(), mutation);
        }
        assertEquals("verified", dispatched(slots, 0).step(observe(swapped(slots, 2, 9)), 150).reason());
    }
    @Test void snapshotsAreCopiedRatherThanBorrowed() {
        var slots = inventory(); var tx = dispatched(slots, 0);
        slots.get(2).decrement(1);
        assertEquals("inventory_mismatch", tx.step(observe(swapped(slots, 2, 9)), 150).reason());
    }
    @Test void preemptionPreservesBudgetAndChecksFreshIdentity() {
        for (String field : List.of("world", "player", "handler", "sync", "command", "expired", "cursor", "grid")) {
            var slots = inventory(); var tx = dispatched(slots, 0);
            assertEquals(CraftHandPreparation.Action.FAIL, tx.step(change(observe(swapped(slots, 2, 9)), field), 500).action(), field);
        }
        var slots = inventory(); var tx = dispatched(slots, 0);
        assertEquals("verification_timeout", tx.step(observe(swapped(slots, 2, 9)), 8000).reason());
    }
    @Test void refilledSlotCannotBuySecondMutationButAnotherEmptySlotWorks() {
        var slots = inventory(); var tx = dispatched(slots, 0); var after = swapped(slots, 2, 9);
        assertEquals("verified", tx.step(observe(after), 150).reason());
        after.set(2, new ItemStack(Items.COAL)); after.set(5, ItemStack.EMPTY);
        assertEquals(CraftHandPreparation.Action.READY, tx.step(observe(after), 200).action());
        after.set(5, new ItemStack(Items.IRON_SWORD));
        assertEquals("attempt_exhausted", tx.step(observe(after), 250).reason());
    }
    @Test void backwardClockDoesNotRefreshVerificationBudget() {
        var slots = inventory(); var tx = dispatched(slots, 100);
        tx.step(observe(slots), 900); tx.step(observe(slots), 200);
        assertEquals("verification_timeout", tx.step(observe(slots), 1100).reason());
    }
    @Test void sharedProtectionMatchesExistingVillageCases() {
        for (var item : List.of(Items.IRON_PICKAXE, Items.IRON_SWORD, Items.IRON_AXE, Items.IRON_SHOVEL,
            Items.IRON_HOE, Items.RED_BED, Items.COOKED_BEEF, Items.CRAFTING_TABLE, Items.FURNACE,
            Items.WATER_BUCKET, Items.BUCKET, Items.SHIELD, Items.FLINT_AND_STEEL, Items.BOW,
            Items.COBBLESTONE, Items.DIRT, Items.OAK_PLANKS, Items.OAK_LOG)) {
            assertTrue(HotbarItemProtection.protects(new ItemStack(item), net.minecraft.registry.Registries.ITEM.getId(item).toString()));
        }
        assertFalse(HotbarItemProtection.protects(new ItemStack(Items.STICK), "minecraft:stick"));
        assertFalse(HotbarItemProtection.protects(new ItemStack(Items.IRON_INGOT), "minecraft:iron_ingot"));
    }
    @Test void suspendedCommandsKeepTheirSpentBudgetAcrossOtherCommandsAndWorldChanges() {
        var registry = new CraftHandPreparation.Registry();
        var tx = registry.get("craft-1", world, player); var slots = inventory();
        tx.step(observe(slots), 0); tx.dispatched(true, null, 0);
        registry.get("other-command", world, player);
        assertSame(tx, registry.get("craft-1", world, player));
        assertSame(tx, registry.get("craft-1", new Object(), player));
        assertEquals("verification_timeout", tx.step(observe(swapped(slots, 2, 9)), 2000).reason());
        for (int i = 0; i < 254; i++) assertNotNull(registry.get("other-" + i, world, player));
        assertNull(registry.get("overflow", world, player));
        assertSame(tx, registry.get("craft-1", world, player));
        registry.completed("other-command");
        assertNotNull(registry.get("new", world, player));
    }
    @Test void completionStaysBlockedFromSelectionUntilVerifiedSettlement() {
        var slots = inventory(); var tx = transaction();
        assertTrue(tx.allowRecipeCompletion(true));
        assertFalse(tx.allowRecipeCompletion(false));
        tx.step(observe(slots), 0);
        assertFalse(tx.allowRecipeCompletion(true));
        tx.dispatched(true, null, 0);
        assertFalse(tx.allowRecipeCompletion(true));
        tx.step(observe(swapped(slots, 2, 9)), 149);
        assertFalse(tx.allowRecipeCompletion(true));
        assertEquals("verified", tx.step(observe(swapped(slots, 2, 9)), 150).reason());
        assertTrue(tx.allowRecipeCompletion(true));
        assertFalse(tx.allowRecipeCompletion(false));
    }
    @Test void unexpectedOutputGainCannotConcealInconsistentPendingInventory() {
        var slots = inventory(); var tx = dispatched(slots, 0);
        var after = swapped(slots, 2, 9); after.set(10, new ItemStack(Items.STONE_PICKAXE));
        var preflight = Craft3x3ControlPlanner.decidePreflight(
            new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.START),
            tx.allowRecipeCompletion(true), false, true);
        assertEquals(Craft3x3ControlPlanner.Action.CONTINUE, preflight.action());
        assertEquals("inventory_mismatch", tx.step(observe(after), 150).reason());
        assertFalse(tx.allowRecipeCompletion(true));
    }
    @Test void pendingCompletionDoesNotExtendEitherDeadline() {
        var slots = inventory(); var tx = dispatched(slots, 0);
        assertEquals(Craft3x3ControlPlanner.Action.FAIL_TOTAL_TIMEOUT,
            Craft3x3ControlPlanner.decidePreflight(
                new Craft3x3ControlPlanner.State(Craft3x3ControlPlanner.Stage.START),
                tx.allowRecipeCompletion(true), true, true).action());
        assertEquals("verification_timeout", tx.step(observe(swapped(slots, 2, 9)), 1001).reason());
        assertFalse(tx.allowRecipeCompletion(true));
    }
}
