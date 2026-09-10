package com.mcbot.fabricclient;

import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.item.ItemStack;

/** Furnace-stage admission around the shared, command-local inventory transaction. */
final class FurnaceHandPreparation {
    record Context(SmeltControlPlanner.Stage stage, boolean closedScreenWaitActive,
        boolean ingredientOrFuelClickPending, boolean appliedOpeningUnresolved) { }

    /** A suspended command retains its transaction; capacity never evicts a spent budget. */
    static final class Registry {
        private final Map<String, FurnaceHandPreparation> commands = new LinkedHashMap<>();

        boolean contains(String id) { return commands.containsKey(id); }

        FurnaceHandPreparation get(String id, Object world, Object player) {
            if (commands.containsKey(id)) return commands.get(id);
            if (commands.size() >= 256) return null;
            var preparation = new FurnaceHandPreparation(id, world, player);
            commands.put(id, preparation);
            return preparation;
        }

        void completed(String id) { commands.remove(id); }
    }

    private final String commandId;
    private final Object world;
    private final Object player;
    private final CraftHandPreparation transaction;
    private SmeltControlPlanner.Stage mutationStage;
    private CraftHandPreparation.Decision last = new CraftHandPreparation.Decision(
        CraftHandPreparation.Action.WAIT, "not_started", -1, -1, 0);
    private CraftHandPreparation.Decision terminalFailure;

    FurnaceHandPreparation(String commandId, Object world, Object player) {
        this.commandId = commandId;
        this.world = world;
        this.player = player;
        transaction = new CraftHandPreparation(commandId, world, player);
    }

    boolean pending() { return terminalFailure == null && transaction.pending(); }

    boolean allowRecipeCompletion(boolean complete) {
        return terminalFailure == null && transaction.allowRecipeCompletion(complete);
    }

    CraftHandPreparation.Decision step(CraftHandPreparation.Observation observation, Context context, long nowMs) {
        if (terminalFailure != null) return terminalFailure;
        if (context == null || context.stage() == null) return fail("stale_state");
        if (transaction.pending()) {
            // A proposal or receipt cannot hide behind an unrelated cooking/opening wait.
            if (!capturedContextMatches(context)) return fail("stale_state");
            return remember(transaction.step(observation, nowMs));
        }
        if (!validIdentityAndInventory(observation)) {
            // The shared transaction owns the exact identity/malformed-observation classification.
            return remember(transaction.step(observation, nowMs));
        }
        if (context.appliedOpeningUnresolved()) return waitFor("open_receipt_pending");
        if (context.closedScreenWaitActive()) return waitFor("output_wait");

        if (last.attempts() == 0 && hotbarFull(observation) && playerInventoryContextValid(observation)) {
            // Other stages retain cached ingredient/fuel source indices. Do not move their stacks.
            if (!mutationStageAllowed(context.stage())) return fail("stage_not_safe");
            if (context.ingredientOrFuelClickPending()) return fail("stale_state");
        }
        CraftHandPreparation.Decision decision = transaction.step(observation, nowMs);
        if (decision.action() == CraftHandPreparation.Action.SWAP) mutationStage = context.stage();
        return remember(decision);
    }

    boolean dispatchStateMatches(CraftHandPreparation.Observation observation, Context context) {
        return terminalFailure == null && capturedContextMatches(context)
            && transaction.dispatchStateMatches(observation);
    }

    CraftHandPreparation.Decision dispatched(boolean applied, String denial, long nowMs) {
        if (terminalFailure != null) return terminalFailure;
        return remember(transaction.dispatched(applied, denial, nowMs));
    }

    private boolean capturedContextMatches(Context context) {
        return context != null && mutationStage != null && context.stage() == mutationStage
            && !context.closedScreenWaitActive() && !context.ingredientOrFuelClickPending()
            && !context.appliedOpeningUnresolved();
    }

    private boolean validIdentityAndInventory(CraftHandPreparation.Observation observation) {
        return observation != null && commandId != null && !commandId.isBlank()
            && world != null && player != null && world == observation.world() && player == observation.player()
            && commandId.equals(observation.commandId()) && observation.active()
            && observation.inventory() != null && observation.inventory().size() == 41
            && observation.inventory().stream().noneMatch(stack -> stack == null)
            && observation.selectedSlot() >= 0 && observation.selectedSlot() < 9;
    }

    private static boolean playerInventoryContextValid(CraftHandPreparation.Observation observation) {
        return observation.handler() != null && observation.handler() == observation.playerHandler()
            && observation.syncId() == observation.playerSyncId()
            && observation.cursorEmpty() && observation.inputEmpty();
    }

    private static boolean hotbarFull(CraftHandPreparation.Observation observation) {
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = observation.inventory().get(slot);
            if (stack.isEmpty()) return false;
        }
        return true;
    }

    private static boolean mutationStageAllowed(SmeltControlPlanner.Stage stage) {
        return stage == SmeltControlPlanner.Stage.START || stage == SmeltControlPlanner.Stage.WAIT_OUTPUT;
    }

    private CraftHandPreparation.Decision waitFor(String reason) {
        return remember(new CraftHandPreparation.Decision(CraftHandPreparation.Action.WAIT,
            reason, last.hotbarSlot(), last.inventorySlot(), last.attempts()));
    }

    private CraftHandPreparation.Decision fail(String reason) {
        return remember(new CraftHandPreparation.Decision(CraftHandPreparation.Action.FAIL,
            reason, last.hotbarSlot(), last.inventorySlot(), last.attempts()));
    }

    private CraftHandPreparation.Decision remember(CraftHandPreparation.Decision decision) {
        last = decision;
        if (decision.action() == CraftHandPreparation.Action.FAIL) terminalFailure = decision;
        return decision;
    }
}
