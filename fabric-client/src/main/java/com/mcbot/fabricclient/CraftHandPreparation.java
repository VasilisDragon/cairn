package com.mcbot.fabricclient;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;

/** Pure command-local transaction: it proposes one swap, but never performs a click. */
final class CraftHandPreparation {
    static final long SETTLE_MS = 150L;
    static final long VERIFY_MS = 1_000L;
    enum Action { READY, SWAP, WAIT, FAIL }
    private enum Phase { NEW, DISPATCH_PENDING, VERIFYING, VERIFIED, FAILED }
    record Observation(Object world, Object player, Object handler, Object playerHandler,
        int syncId, int playerSyncId, String commandId, boolean active,
        boolean cursorEmpty, boolean inputEmpty, int selectedSlot, List<ItemStack> inventory) { }
    record Decision(Action action, String reason, int hotbarSlot, int inventorySlot, int attempts) { }
    /** Suspended commands keep their spent transaction; overflow never evicts one to refund it. */
    static final class Registry {
        private final Map<String, CraftHandPreparation> commands = new LinkedHashMap<>();
        boolean contains(String id) { return commands.containsKey(id); }
        CraftHandPreparation get(String id, Object world, Object player) {
            if (commands.containsKey(id)) return commands.get(id);
            if (commands.size() >= 256) return null;
            var transaction = new CraftHandPreparation(id, world, player);
            commands.put(id, transaction);
            return transaction;
        }
        void completed(String id) { commands.remove(id); }
    }

    private final Object world;
    private final Object player;
    private final String commandId;
    private Phase phase = Phase.NEW;
    private String failure;
    private int source = -1;
    private int destination = -1;
    private int attempts;
    private List<ItemStack> before;
    private Object handler;
    private int syncId;
    private long dispatchedAt;
    private long clock;

    CraftHandPreparation(String commandId, Object world, Object player) {
        this.commandId = commandId;
        this.world = world;
        this.player = player;
    }

    boolean pending() { return phase == Phase.DISPATCH_PENDING || phase == Phase.VERIFYING; }

    boolean allowRecipeCompletion(boolean recipeComplete) {
        // Even an unrelated output pickup cannot retire an unverified or failed swap.
        return recipeComplete && !pending() && phase != Phase.FAILED;
    }

    Decision step(Observation observation, long nowMs) {
        clock = Math.max(clock, nowMs);
        if (phase == Phase.FAILED) return decision(Action.FAIL, failure);
        if (!identityValid(observation)) return fail("stale_state");
        if (!observation.active()) return fail("command_expired");
        List<ItemStack> inventory = observation.inventory();
        if (inventory == null || inventory.size() != 41 || inventory.stream().anyMatch(s -> s == null)
            || observation.selectedSlot() < 0 || observation.selectedSlot() > 8) return fail("invalid_inventory");
        if (phase == Phase.DISPATCH_PENDING) return fail("dispatch_unreceipted");
        if (phase == Phase.VERIFYING) {
            if (!transactionContextValid(observation) || handler != observation.handler()
                || syncId != observation.syncId()) return fail("stale_state");
            long elapsed = clock - dispatchedAt;
            if (elapsed > VERIFY_MS) return fail("verification_timeout");
            boolean unchanged = matches(inventory, false);
            boolean swapped = matches(inventory, true);
            if (!unchanged && !swapped) return fail("inventory_mismatch");
            if (elapsed >= SETTLE_MS && swapped) {
                phase = Phase.VERIFIED;
                return decision(Action.READY, "verified");
            }
            if (elapsed >= VERIFY_MS) return fail("verification_timeout");
            return decision(Action.WAIT, "verify_wait");
        }
        for (int slot = 0; slot < 9; slot++) {
            if (inventory.get(slot).isEmpty()) return new Decision(Action.READY, "existing_empty", slot, -1, attempts);
        }
        if (attempts != 0) return fail("attempt_exhausted");
        if (!transactionContextValid(observation)) return fail("stale_state");
        for (int slot = 9; slot < 36; slot++) {
            if (inventory.get(slot).isEmpty()) { destination = slot; break; }
        }
        if (destination < 0) return fail("no_capacity");
        for (int slot = 0; slot < 9; slot++) {
            if (slot != observation.selectedSlot() && eligible(inventory.get(slot))) { source = slot; break; }
        }
        if (source < 0 && eligible(inventory.get(observation.selectedSlot()))) source = observation.selectedSlot();
        if (source < 0) return fail("no_eligible_source");
        before = inventory.stream().map(ItemStack::copy).toList();
        handler = observation.handler();
        syncId = observation.syncId();
        attempts = 1; // Budget is spent before dispatch, including denials/unknown outcomes.
        phase = Phase.DISPATCH_PENDING;
        return decision(Action.SWAP, "selected");
    }

    boolean dispatchStateMatches(Observation observation) {
        return phase == Phase.DISPATCH_PENDING && identityValid(observation) && observation.active()
            && transactionContextValid(observation) && handler == observation.handler()
            && syncId == observation.syncId() && observation.inventory() != null
            && observation.inventory().size() == 41
            && observation.inventory().stream().noneMatch(s -> s == null)
            && matches(observation.inventory(), false);
    }

    Decision dispatched(boolean applied, String denial, long nowMs) {
        clock = Math.max(clock, nowMs);
        if (phase != Phase.DISPATCH_PENDING) return fail("dispatch_unexpected");
        if (!applied) return fail(denial == null ? "authorization_denied" : denial);
        dispatchedAt = clock;
        phase = Phase.VERIFYING;
        return decision(Action.WAIT, "dispatched");
    }

    private boolean identityValid(Observation observation) {
        return observation != null && world != null && player != null && commandId != null && !commandId.isBlank()
            && world == observation.world() && player == observation.player() && commandId.equals(observation.commandId());
    }

    private static boolean transactionContextValid(Observation observation) {
        return observation.handler() != null && observation.handler() == observation.playerHandler()
            && observation.syncId() == observation.playerSyncId()
            && observation.cursorEmpty() && observation.inputEmpty();
    }

    private static boolean eligible(ItemStack stack) {
        String id = Registries.ITEM.getId(stack.getItem()).toString();
        return !stack.isEmpty() && !HotbarItemProtection.protects(stack, id);
    }

    private boolean matches(List<ItemStack> inventory, boolean swapped) {
        for (int slot = 0; slot < before.size(); slot++) {
            int expectedSlot = swapped && slot == source ? destination : swapped && slot == destination ? source : slot;
            if (!ItemStack.areEqual(before.get(expectedSlot), inventory.get(slot))) return false;
        }
        return true;
    }

    private Decision fail(String reason) {
        phase = Phase.FAILED;
        failure = reason;
        return decision(Action.FAIL, reason);
    }

    private Decision decision(Action action, String reason) { return new Decision(action, reason, source, destination, attempts); }
}
