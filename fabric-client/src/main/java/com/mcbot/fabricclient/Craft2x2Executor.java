package com.mcbot.fabricclient;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;

/**
 * {@code craft_2x2} objective family, lifted verbatim out of {@code McbotFabricClient}.
 *
 * <p>Fifth concrete {@link ObjectiveExecutor} of the strangler decomposition (PR-4). The 2x2 craft is
 * the most involved leaf so far: a multi-stage screen-handler state machine (pick the source stack,
 * place inputs into the inventory grid, return the remainder, wait for and take the result, verify the
 * inventory delta) driven entirely off the always-present player screen handler (syncId 0). The control
 * logic, the completion/failure paths, the stage machine, and the slot/cursor helpers
 * ({@code clickCraftSlot}, {@code findCraftSourceScreenSlot}, {@code findCraftCursorReturnScreenSlot},
 * {@code craftingInputEmpty}, {@code transitionCraftStage}) are moved here unchanged; the edits are
 * mechanical — source params become the {@link #resolve} / {@link TickContext} params, the
 * {@code activeCraft2x2} field becomes {@link #activeRun}, the {@code completedCraft2x2CommandIds} set +
 * {@code finishedCraft2x2CommandReasons} map become {@link #ledger}, instance-helper calls go through
 * {@link ShellServices}, and shared statics / constants / nested types are referenced on
 * {@link McbotFabricClient} directly.
 *
 * <p>Two collaborators stay on the shell because they are shared with other objectives:
 * {@code captureCraftInventory} (R5 / MakeCharcoal also call it) is exposed via {@link ShellServices};
 * {@code canRecoverCraftCursorIntoSlot} is a tested static asserted by {@code CraftCursorRecoveryTest}
 * via {@code McbotFabricClient.canRecoverCraftCursorIntoSlot(...)}, so it is kept static on
 * {@link McbotFabricClient} and called as {@code McbotFabricClient.canRecoverCraftCursorIntoSlot(...)}.
 * {@code Craft2x2RecipePlanner} is an external class and is called directly.
 *
 * <p>{@code resolveCraft2x2Control} has a second caller besides the dispatch chain (the
 * mine_nearby_iron field-kit table-craft fallback), so the logic is exposed via the public
 * {@link #resolve} entry and {@link #tick(TickContext)} delegates to it; the shell rewires its internal
 * caller to {@code craft2x2Executor.resolve(client, player, makeSubIntent(...), nowMs)}.
 *
 * <p>The reason strings ({@code <action>_complete:...}, {@code <action>_failed:...}, etc.) are a wire
 * contract read by the brain and are preserved exactly.
 */
public final class Craft2x2Executor implements ObjectiveExecutor {

    private final ShellServices shell;
    private final CommandLedger ledger = new CommandLedger();
    private Craft2x2Run activeRun = null;

    public Craft2x2Executor(ShellServices shell) {
        this.shell = shell;
    }

    @Override
    public boolean handles(String action) {
        return Craft2x2RecipePlanner.isCraftAction(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        return resolve(ctx.client(), ctx.player(), ctx.intent(), ctx.nowMs());
    }

    public ControlDecision resolve(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        Craft2x2RecipePlanner.Recipe recipe = Craft2x2RecipePlanner.fromAction(effective.action());
        if (recipe == null) {
            return new ControlDecision(shell.stopFrom(effective, "craft_2x2_unknown_recipe"), InputState.stop());
        }
        String action = recipe.action();
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (ledger.isCompleted(commandId)) {
            return new ControlDecision(shell.stopFrom(effective, action + "_complete"), InputState.stop());
        }
        if (activeRun == null || !commandId.equals(activeRun.commandId) || activeRun.recipe != recipe) {
            McbotFabricClient.CraftInventorySnapshot inventory = shell.captureCraftInventory(player);
            activeRun = new Craft2x2Run(commandId, recipe, inventory, nowMs);
            shell.logger().info(
                "{}.start instanceId={} commandId={} inventoryLogsBefore={} inventoryPlanksBefore={} inventorySticksBefore={} inventoryTablesBefore={} logsByItem={} planksByItem={} sticksByItem={} tablesByItem={}",
                action,
                shell.instanceId(),
                commandId,
                inventory.logs().logCount(),
                inventory.planks().plankCount(),
                inventory.sticks().stickCount(),
                inventory.tables().craftingTableCount(),
                inventory.logs().logsByItem(),
                inventory.planks().planksByItem(),
                inventory.sticks().sticksByItem(),
                inventory.tables().craftingTablesByItem()
            );
            if (!Craft2x2RecipePlanner.canStart(
                recipe,
                inventory.logs().logCount(),
                inventory.planks().plankCount(),
                inventory.hayBales().itemCount()
            )) {
                return failCraft2x2(effective, activeRun, inventory, nowMs, action + "_missing_inputs");
            }
        }

        Craft2x2Run run = activeRun;
        McbotFabricClient.CraftInventorySnapshot inventory = shell.captureCraftInventory(player);
        if (Craft2x2RecipePlanner.isComplete(
            run.recipe,
            run.baselineLogs,
            inventory.logs().logCount(),
            run.baselinePlanks,
            inventory.planks().plankCount(),
            run.baselineSticks,
            inventory.sticks().stickCount(),
            run.baselineTables,
            inventory.tables().craftingTableCount(),
            run.baselineHayBales,
            inventory.hayBales().itemCount(),
            run.baselineWheat,
            inventory.wheat().itemCount()
        )) {
            return completeCraft2x2(effective, run, inventory, nowMs, action + "_delta_verified");
        }
        if (nowMs - run.startedAtMs > McbotFabricClient.CRAFT_TOTAL_TIMEOUT_MS) {
            return failCraft2x2(effective, run, inventory, nowMs, action + "_timeout");
        }

        PlayerScreenHandler handler = player.playerScreenHandler;
        if (handler == null || client.interactionManager == null) {
            return failCraft2x2(effective, run, inventory, nowMs, action + "_no_screen_handler");
        }

        // 2x2 crafting uses the player-inventory grid (syncId 0). If a foreign screen is open — e.g. a
        // crafting-table screen left open by a prior 3x3 craft — clicks to syncId 0 are rejected as a
        // "mismatching container". Close it first, then craft on the next tick.
        if (player.currentScreenHandler != null && player.currentScreenHandler != handler) {
            String previousHandler = player.currentScreenHandler.getClass().getSimpleName();
            player.closeHandledScreen();
            run.lastClickAtMs = nowMs;
            shell.logger().info(
                "{}.closed_foreign_screen instanceId={} commandId={} previousHandler={}",
                action,
                shell.instanceId(),
                commandId,
                previousHandler
            );
            return new ControlDecision(shell.stopFrom(effective, action + "_closing_foreign_screen"), InputState.stop());
        }

        if (run.lastClickAtMs > 0L && nowMs - run.lastClickAtMs < McbotFabricClient.CRAFT_CLICK_SETTLE_MS) {
            return new ControlDecision(shell.stopFrom(effective, action + "_click_settle"), InputState.stop());
        }

        if (run.stage == Craft2x2Stage.START) {
            if (!handler.getCursorStack().isEmpty()) {
                int returnSlot = findCraftCursorReturnScreenSlot(handler);
                if (returnSlot >= 0) {
                    if (!clickCraftSlot(client, player, handler, run, returnSlot, 0,
                        SlotActionType.PICKUP, "recover_cursor", nowMs)) {
                        return failCraft2x2(effective, run, inventory, nowMs,
                            action + "_slot_authorization_denied");
                    }
                    return new ControlDecision(shell.stopFrom(effective, action + "_recover_cursor"), InputState.stop());
                }
                return failCraft2x2(effective, run, inventory, nowMs, action + "_cursor_not_empty");
            }
            if (!craftingInputEmpty(handler)) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_input_not_empty");
            }
            int sourceSlot = findCraftSourceScreenSlot(handler, recipe);
            if (sourceSlot < 0) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_source_slot_missing");
            }
            run.sourceScreenSlot = sourceSlot;
            transitionCraftStage(run, Craft2x2Stage.PICK_SOURCE_STACK, nowMs);
            shell.logger().info(
                "{}.source_slot_selected instanceId={} commandId={} slot={} ingredient={} inputCount={}",
                action,
                shell.instanceId(),
                commandId,
                sourceSlot,
                recipe.ingredient(),
                recipe.inputCount()
            );
        }

        if (run.stage == Craft2x2Stage.PICK_SOURCE_STACK) {
            if (!clickCraftSlot(client, player, handler, run, run.sourceScreenSlot, 0,
                SlotActionType.PICKUP, "pick_source_stack", nowMs)) {
                return failCraft2x2(effective, run, inventory, nowMs,
                    action + "_slot_authorization_denied");
            }
            transitionCraftStage(run, Craft2x2Stage.PLACE_INPUTS, nowMs);
            return new ControlDecision(shell.stopFrom(effective, action + "_pick_source"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.PLACE_INPUTS) {
            if (handler.getCursorStack().isEmpty()) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_cursor_empty_before_place");
            }
            int inputSlot = recipe.inputSlots().get(run.nextInputIndex);
            if (!clickCraftSlot(client, player, handler, run, inputSlot, 1,
                SlotActionType.PICKUP, "place_input_" + run.nextInputIndex, nowMs)) {
                return failCraft2x2(effective, run, inventory, nowMs,
                    action + "_slot_authorization_denied");
            }
            run.nextInputIndex++;
            if (run.nextInputIndex >= recipe.inputSlots().size()) {
                transitionCraftStage(run, Craft2x2Stage.RETURN_REMAINDER, nowMs);
            }
            return new ControlDecision(shell.stopFrom(effective, action + "_place_input"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.RETURN_REMAINDER) {
            if (!handler.getCursorStack().isEmpty()) {
                if (!clickCraftSlot(client, player, handler, run, run.sourceScreenSlot, 0,
                    SlotActionType.PICKUP, "return_remainder", nowMs)) {
                    return failCraft2x2(effective, run, inventory, nowMs,
                        action + "_slot_authorization_denied");
                }
            }
            transitionCraftStage(run, Craft2x2Stage.WAIT_RESULT, nowMs);
            return new ControlDecision(shell.stopFrom(effective, action + "_return_remainder"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.WAIT_RESULT) {
            ItemStack result = handler.getSlot(McbotFabricClient.PLAYER_CRAFTING_RESULT_SLOT).getStack();
            String resultId = shell.itemId(result);
            if (Craft2x2RecipePlanner.isExpectedResult(recipe, resultId, result.getCount())) {
                shell.logger().info(
                    "{}.result_ready instanceId={} commandId={} result={} count={}",
                    action,
                    shell.instanceId(),
                    commandId,
                    resultId,
                    result.getCount()
                );
                transitionCraftStage(run, Craft2x2Stage.TAKE_RESULT, nowMs);
            } else if (nowMs - run.stageStartedAtMs > McbotFabricClient.CRAFT_RESULT_WAIT_MS) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_result_missing");
            } else {
                return new ControlDecision(shell.stopFrom(effective, action + "_wait_result"), InputState.stop());
            }
        }
        if (run.stage == Craft2x2Stage.TAKE_RESULT) {
            if (!clickCraftSlot(client, player, handler, run,
                McbotFabricClient.PLAYER_CRAFTING_RESULT_SLOT, 0,
                SlotActionType.QUICK_MOVE, "take_result", nowMs)) {
                return failCraft2x2(effective, run, inventory, nowMs,
                    action + "_slot_authorization_denied");
            }
            transitionCraftStage(run, Craft2x2Stage.VERIFY, nowMs);
            return new ControlDecision(shell.stopFrom(effective, action + "_take_result"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.VERIFY) {
            if (nowMs - run.stageStartedAtMs > McbotFabricClient.CRAFT_VERIFY_WAIT_MS) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_delta_missing");
            }
            return new ControlDecision(shell.stopFrom(effective, action + "_verify_delta"), InputState.stop());
        }

        return failCraft2x2(effective, run, inventory, nowMs, action + "_unknown_stage");
    }

    private ControlDecision completeCraft2x2(
        BrainLink.Intent effective,
        Craft2x2Run run,
        McbotFabricClient.CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        String completionReason = run.recipe.action() + "_complete:" + reason;
        ledger.markComplete(run.commandId, completionReason);
        shell.logger().info(
            "{}.complete instanceId={} commandId={} reason={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventorySticksBefore={} inventorySticksAfter={} inventoryTablesBefore={} inventoryTablesAfter={} logsByItem={} planksByItem={} sticksByItem={} tablesByItem={} elapsedMs={}",
            run.recipe.action(),
            shell.instanceId(),
            run.commandId,
            reason,
            run.baselineLogs,
            inventory.logs().logCount(),
            run.baselinePlanks,
            inventory.planks().plankCount(),
            run.baselineSticks,
            inventory.sticks().stickCount(),
            run.baselineTables,
            inventory.tables().craftingTableCount(),
            inventory.logs().logsByItem(),
            inventory.planks().planksByItem(),
            inventory.sticks().sticksByItem(),
            inventory.tables().craftingTablesByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRun = null;
        shell.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
    }

    private ControlDecision failCraft2x2(
        BrainLink.Intent effective,
        Craft2x2Run run,
        McbotFabricClient.CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        String completionReason = run.recipe.action() + "_failed:" + reason;
        ledger.markComplete(run.commandId, completionReason);
        shell.logger().warn(
            "{}.failed instanceId={} commandId={} reason={} stage={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventorySticksBefore={} inventorySticksAfter={} inventoryTablesBefore={} inventoryTablesAfter={} logsByItem={} planksByItem={} sticksByItem={} tablesByItem={} elapsedMs={}",
            run.recipe.action(),
            shell.instanceId(),
            run.commandId,
            reason,
            run.stage,
            run.baselineLogs,
            inventory.logs().logCount(),
            run.baselinePlanks,
            inventory.planks().plankCount(),
            run.baselineSticks,
            inventory.sticks().stickCount(),
            run.baselineTables,
            inventory.tables().craftingTableCount(),
            inventory.logs().logsByItem(),
            inventory.planks().planksByItem(),
            inventory.sticks().sticksByItem(),
            inventory.tables().craftingTablesByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRun = null;
        shell.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
    }

    private void transitionCraftStage(Craft2x2Run run, Craft2x2Stage stage, long nowMs) {
        run.stage = stage;
        run.stageStartedAtMs = nowMs;
    }

    private boolean clickCraftSlot(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        Craft2x2Run run,
        int slot,
        int button,
        SlotActionType action,
        String label,
        long nowMs
    ) {
        if (!shell.clickAuthorizedPlayerInventorySlot(
            client,
            player,
            handler,
            slot,
            button,
            action
        )) {
            return false;
        }
        run.lastClickAtMs = nowMs;
        shell.logger().info(
            "{}.click instanceId={} commandId={} label={} slot={} button={} action={}",
            run.recipe.action(),
            shell.instanceId(),
            run.commandId,
            label,
            slot,
            button,
            action
        );
        return true;
    }

    private int findCraftSourceScreenSlot(PlayerScreenHandler handler, Craft2x2RecipePlanner.Recipe recipe) {
        int end = Math.min(McbotFabricClient.PLAYER_HOTBAR_SCREEN_END, handler.slots.size());
        for (int slot = McbotFabricClient.PLAYER_INVENTORY_SCREEN_START; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            if (stack.getCount() < recipe.inputCount()) {
                continue;
            }
            String id = shell.itemId(stack);
            if (recipe.ingredient() == Craft2x2RecipePlanner.Ingredient.LOG
                && (stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(id))) {
                return slot;
            }
            if (recipe.ingredient() == Craft2x2RecipePlanner.Ingredient.PLANK
                && InventoryCounter.isPlankItemId(id)) {
                return slot;
            }
            if (recipe.ingredient() == Craft2x2RecipePlanner.Ingredient.HAY_BALE
                && "hay_block".equalsIgnoreCase(id)) {
                return slot;
            }
        }
        return -1;
    }

    private int findCraftCursorReturnScreenSlot(PlayerScreenHandler handler) {
        if (handler == null) {
            return -1;
        }
        ItemStack cursor = handler.getCursorStack();
        if (cursor == null || cursor.isEmpty()) {
            return -1;
        }
        String cursorItemId = shell.itemId(cursor);
        int firstEmptySlot = -1;
        int end = Math.min(McbotFabricClient.PLAYER_HOTBAR_SCREEN_END, handler.slots.size());
        for (int slot = McbotFabricClient.PLAYER_INVENTORY_SCREEN_START; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            String slotItemId = shell.itemId(stack);
            int slotCount = stack == null || stack.isEmpty() ? 0 : stack.getCount();
            int slotMaxCount = stack == null || stack.isEmpty() ? cursor.getMaxCount() : stack.getMaxCount();
            if (!McbotFabricClient.canRecoverCraftCursorIntoSlot(cursorItemId, cursor.getCount(), slotItemId, slotCount, slotMaxCount)) {
                continue;
            }
            if (slotCount <= 0) {
                if (firstEmptySlot < 0) {
                    firstEmptySlot = slot;
                }
                continue;
            }
            return slot;
        }
        return firstEmptySlot;
    }

    private boolean craftingInputEmpty(PlayerScreenHandler handler) {
        int end = Math.min(McbotFabricClient.PLAYER_CRAFTING_INPUT_END, handler.slots.size());
        for (int slot = McbotFabricClient.PLAYER_CRAFTING_INPUT_START; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack != null && !stack.isEmpty()) {
                return false;
            }
        }
        return true;
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    void clearActiveRun() {
        activeRun = null;
    }

    /**
     * Returns an interrupted player-grid craft to inventory without completing or failing its
     * command. One invocation emits at most one slot click so normal acknowledgement timing stays
     * authoritative.
     */
    VillageNestedCraftCleanupResult prepareAbortCleanup(
        MinecraftClient client,
        ClientPlayerEntity player,
        long nowMs
    ) {
        if (activeRun == null) {
            return VillageNestedCraftCleanupResult.clean();
        }
        PlayerScreenHandler handler = player == null ? null : player.playerScreenHandler;
        if (client == null || player == null || handler == null
            || client.interactionManager == null) {
            return new VillageNestedCraftCleanupResult(
                VillageNestedCraftCleanupResult.Status.REJECTED,
                handler == null || handler.getCursorStack().isEmpty(),
                occupiedCraftingInputs(handler),
                false,
                "screen_unavailable");
        }
        if (player.currentScreenHandler != handler) {
            return new VillageNestedCraftCleanupResult(
                VillageNestedCraftCleanupResult.Status.PENDING,
                handler.getCursorStack().isEmpty(),
                occupiedCraftingInputs(handler),
                false,
                "foreign_screen_open");
        }
        if (activeRun.lastClickAtMs > 0L
            && nowMs - activeRun.lastClickAtMs < McbotFabricClient.CRAFT_CLICK_SETTLE_MS) {
            return new VillageNestedCraftCleanupResult(
                VillageNestedCraftCleanupResult.Status.PENDING,
                handler.getCursorStack().isEmpty(),
                occupiedCraftingInputs(handler),
                false,
                "click_settle");
        }
        ItemStack cursor = handler.getCursorStack();
        if (cursor != null && !cursor.isEmpty()) {
            int returnSlot = findCraftCursorReturnScreenSlot(handler);
            if (returnSlot < 0) {
                return new VillageNestedCraftCleanupResult(
                    VillageNestedCraftCleanupResult.Status.REJECTED,
                    false,
                    occupiedCraftingInputs(handler),
                    false,
                    "cursor_return_unavailable");
            }
            if (!clickCraftSlot(
                client, player, handler, activeRun, returnSlot, 0,
                SlotActionType.PICKUP, "handoff_return_cursor", nowMs)) {
                return new VillageNestedCraftCleanupResult(
                    VillageNestedCraftCleanupResult.Status.REJECTED,
                    false,
                    occupiedCraftingInputs(handler),
                    false,
                    "slot_authorization_denied");
            }
            return new VillageNestedCraftCleanupResult(
                VillageNestedCraftCleanupResult.Status.PENDING,
                false,
                occupiedCraftingInputs(handler),
                true,
                "cursor_returned");
        }
        int end = Math.min(
            McbotFabricClient.PLAYER_CRAFTING_INPUT_END, handler.slots.size());
        for (int slot = McbotFabricClient.PLAYER_CRAFTING_INPUT_START; slot < end; slot++) {
            ItemStack input = handler.getSlot(slot).getStack();
            if (input == null || input.isEmpty()) {
                continue;
            }
            if (!clickCraftSlot(
                client, player, handler, activeRun, slot, 0,
                SlotActionType.QUICK_MOVE, "handoff_return_input", nowMs)) {
                return new VillageNestedCraftCleanupResult(
                    VillageNestedCraftCleanupResult.Status.REJECTED,
                    true,
                    occupiedCraftingInputs(handler),
                    false,
                    "slot_authorization_denied");
            }
            return new VillageNestedCraftCleanupResult(
                VillageNestedCraftCleanupResult.Status.PENDING,
                true,
                occupiedCraftingInputs(handler),
                true,
                "input_returned");
        }
        shell.logger().info(
            "village.opportunity.nested_craft.cleanup_complete instanceId={} commandId={} action={} cursorEmpty=true occupiedInputSlots=0",
            shell.instanceId(), activeRun.commandId, activeRun.recipe.action());
        activeRun = null;
        return VillageNestedCraftCleanupResult.clean();
    }

    private static int occupiedCraftingInputs(PlayerScreenHandler handler) {
        if (handler == null) {
            return 0;
        }
        int count = 0;
        int end = Math.min(
            McbotFabricClient.PLAYER_CRAFTING_INPUT_END, handler.slots.size());
        for (int slot = McbotFabricClient.PLAYER_CRAFTING_INPUT_START; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack != null && !stack.isEmpty()) {
                count += 1;
            }
        }
        return count;
    }

    private enum Craft2x2Stage {
        START,
        PICK_SOURCE_STACK,
        PLACE_INPUTS,
        RETURN_REMAINDER,
        WAIT_RESULT,
        TAKE_RESULT,
        VERIFY
    }

    private static final class Craft2x2Run {
        final String commandId;
        final Craft2x2RecipePlanner.Recipe recipe;
        final int baselineLogs;
        final int baselinePlanks;
        final int baselineSticks;
        final int baselineTables;
        final int baselineHayBales;
        final int baselineWheat;
        final long startedAtMs;
        Craft2x2Stage stage = Craft2x2Stage.START;
        long stageStartedAtMs;
        long lastClickAtMs = 0L;
        int sourceScreenSlot = -1;
        int nextInputIndex = 0;

        Craft2x2Run(String commandId, Craft2x2RecipePlanner.Recipe recipe, McbotFabricClient.CraftInventorySnapshot inventory, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.recipe = recipe;
            this.baselineLogs = inventory.logs().logCount();
            this.baselinePlanks = inventory.planks().plankCount();
            this.baselineSticks = inventory.sticks().stickCount();
            this.baselineTables = inventory.tables().craftingTableCount();
            this.baselineHayBales = inventory.hayBales().itemCount();
            this.baselineWheat = inventory.wheat().itemCount();
            this.startedAtMs = startedAtMs;
            this.stageStartedAtMs = startedAtMs;
        }
    }
}
