package com.mcbot.fabricclient;

import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

/**
 * {@code retrieve_table} objective, lifted verbatim out of {@code McbotFabricClient}.
 *
 * <p>Third concrete {@link ObjectiveExecutor} of the strangler decomposition (PR-2). RetrieveTable
 * walks to a placed crafting table, breaks it, and collects the dropped item; it also short-circuits
 * to "complete" when replacement material (a log, or 4 planks) is already on hand. The control logic,
 * the replacement-skip path, and the failure path are moved here unchanged; the edits are mechanical —
 * source params become the {@link #resolve} / {@link TickContext} params, the {@code activeRetrieveTable}
 * field becomes {@link #activeRun}, the {@code completedRetrieveTableCommandIds} set +
 * {@code finishedRetrieveTableCommandReasons} map become {@link #ledger}, instance-helper calls go
 * through {@link ShellServices}, and pure static helpers / constants are referenced on
 * {@link McbotFabricClient} directly.
 *
 * <p>{@code hasCraftingTableReplacementMaterial} stays a static on {@link McbotFabricClient} (a unit
 * test asserts it via {@code McbotFabricClient.hasCraftingTableReplacementMaterial(...)}); it is called
 * here as {@code McbotFabricClient.hasCraftingTableReplacementMaterial(...)}.
 *
 * <p>{@code resolveRetrieveTableControl} has a second caller besides the dispatch chain (the
 * mine_nearby_iron field-kit tool-recovery path), so the logic is exposed via the public
 * {@link #resolve} entry and {@link #tick(TickContext)} delegates to it; the shell rewires its internal
 * caller to {@code retrieveTableExecutor.resolve(client, player, makeSubIntent(...), nowMs)}.
 *
 * <p>The reason strings ({@code retrieve_table_complete:...}, {@code retrieve_table_failed:...}, etc.)
 * are a wire contract read by the brain and are preserved exactly.
 */
public final class RetrieveTableExecutor implements ObjectiveExecutor {

    private final ShellServices shell;
    private final CommandLedger ledger = new CommandLedger();
    private RetrieveTableRun activeRun = null;

    public RetrieveTableExecutor(ShellServices shell) {
        this.shell = shell;
    }

    @Override
    public boolean handles(String action) {
        return "retrieve_table".equals(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        return resolve(ctx.client(), ctx.player(), ctx.intent(), ctx.nowMs());
    }

    public ControlDecision resolve(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        return resolveInternal(client, player, effective, nowMs, null, false);
    }

    /**
     * Retrieves one exact, transaction-owned crafting table.
     *
     * <p>Unlike the ordinary objective, this path may not declare success merely because replacement
     * wood is available and it may not select a different nearby table.  Village bread transactions
     * use it to restore the carried field-kit table they temporarily placed.  The target is deliberately
     * local: repositioning or chasing a distant drop fails closed instead of opening generic navigation
     * authority inside the village transaction.
     */
    public ControlDecision resolveExact(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        long nowMs,
        BlockPos exactTable
    ) {
        return resolveInternal(client, player, effective, nowMs, exactTable, true);
    }

    private ControlDecision resolveInternal(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        long nowMs,
        BlockPos exactTable,
        boolean exactRequired
    ) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (ledger.isCompleted(commandId)) {
            return new ControlDecision(shell.stopFrom(effective, ledger.reasonOrDefault(commandId, "retrieve_table_complete")), InputState.stop());
        }
        InventoryCounter.InventoryCraftingTableSnapshot tables = InventoryCounter.countPlayerCraftingTables(player);
        if (activeRun == null || !commandId.equals(activeRun.commandId)) {
            activeRun = new RetrieveTableRun(
                commandId,
                tables.craftingTableCount(),
                nowMs,
                exactRequired ? exactTable : null,
                exactRequired
            );
            shell.logger().info(
                "retrieve_table.start instanceId={} commandId={} inventoryTablesBefore={} tablesByItem={} exactRequired={} exactTarget={}",
                shell.instanceId(),
                commandId,
                activeRun.baselineTables,
                tables.craftingTablesByItem(),
                activeRun.exactRequired,
                McbotFabricClient.formatBlockPos(activeRun.target)
            );
        }

        RetrieveTableRun run = activeRun;
        if (run.exactRequired
            && (exactTable == null || !exactTable.equals(run.target))) {
            return failRetrieveTable(
                effective, run, tables, nowMs, "retrieve_table_exact_target_changed");
        }
        if (tables.craftingTableCount() - run.baselineTables >= 1) {
            String completionReason = finishRetrieveTableCommand(commandId, "retrieve_table_complete:table_item_delta_verified");
            shell.logger().info(
                "retrieve_table.complete instanceId={} commandId={} reason=table_item_delta_verified inventoryTablesBefore={} inventoryTablesAfter={} tablesByItem={} elapsedMs={}",
                shell.instanceId(),
                commandId,
                run.baselineTables,
                tables.craftingTableCount(),
                tables.craftingTablesByItem(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
            activeRun = null;
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        if (nowMs - run.startedAtMs > McbotFabricClient.CRAFT_TOTAL_TIMEOUT_MS + McbotFabricClient.GATHER_COLLECT_TIMEOUT_MS) {
            if (!run.exactRequired) {
                ControlDecision skipped = maybeSkipRetrieveTableWithReplacement(
                    effective,
                    player,
                    run,
                    tables,
                    nowMs,
                    "retrieve_table_timeout"
                );
                if (skipped != null) {
                    return skipped;
                }
            }
            return failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_timeout");
        }

        if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
            String previousHandler = player.currentScreenHandler.getClass().getSimpleName();
            player.closeHandledScreen();
            shell.logger().info(
                "retrieve_table.close_screen instanceId={} commandId={} handler={}",
                shell.instanceId(),
                commandId,
                previousHandler
            );
            return new ControlDecision(shell.stopFrom(effective, "retrieve_table_close_screen"), InputState.stop());
        }

        if (run.target == null) {
            BlockPos target = shell.selectNearbyCraftingTable(client, player);
            if (target == null) {
                return failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_no_nearby_table");
            }
            run.target = target;
            shell.logger().info(
                "retrieve_table.target_selected instanceId={} commandId={} target={}",
                shell.instanceId(),
                commandId,
                target.toShortString()
            );
        }

        if (!run.breakDone && client.world.getBlockState(run.target).isOf(Blocks.CRAFTING_TABLE)) {
            if (!shell.isLookingAtBlock(player, run.target)) {
                return new ControlDecision(shell.lookIntentForBlock(effective, player, run.target, "retrieve_table_face"), InputState.stop());
            }
            BlockBreakController.Result result = shell.blockBreakController().tick(client, player, run.target, commandId + ":break", nowMs);
            shell.logBlockBreakResult(commandId, run.target, result);
            shell.logger().info(
                "retrieve_table.break_progress instanceId={} commandId={} target={} status={} reason={} elapsedMs={}",
                shell.instanceId(),
                commandId,
                run.target.toShortString(),
                result.status(),
                result.reason(),
                result.elapsedMs()
            );
            if (result.status() == BlockBreakController.Status.BROKEN) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
                return withInteraction(
                    new ControlDecision(shell.stopFrom(effective, "retrieve_table_break_done"), InputState.stop()),
                    result
                );
            }
            if (result.status() == BlockBreakController.Status.REPOSITION) {
                if (run.exactRequired) {
                    return withInteraction(
                        failRetrieveTable(
                            effective,
                            run,
                            tables,
                            nowMs,
                            "retrieve_table_exact_reposition_required"
                        ),
                        result
                    );
                }
                BrainLink.Intent navIntent = shell.gatherCollectIntent(effective, run.target.getX() + 0.5D, run.target.getZ() + 0.5D, "retrieve_table_reposition", ":retrieve:reposition");
                return withInteraction(shell.resolveNavigationControl(client, player, navIntent), result);
            }
            if (result.status() == BlockBreakController.Status.FAILED) {
                if (!run.exactRequired) {
                    ControlDecision skipped = maybeSkipRetrieveTableWithReplacement(
                        effective,
                        player,
                        run,
                        tables,
                        nowMs,
                        "retrieve_table_break_failed:" + result.reason()
                    );
                    if (skipped != null) {
                        return withInteraction(skipped, result);
                    }
                }
                return withInteraction(
                    failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_break_failed:" + result.reason()),
                    result
                );
            }
            return withInteraction(
                new ControlDecision(shell.stopFrom(effective, "retrieve_table_breaking:" + result.reason()), InputState.stop()),
                result
            );
        }

        run.breakDone = true;
        if (run.collectStartedAtMs <= 0L) {
            run.collectStartedAtMs = nowMs;
        }
        if (nowMs - run.collectStartedAtMs < McbotFabricClient.GATHER_PICKUP_SETTLE_MS) {
            return new ControlDecision(shell.stopFrom(effective, "retrieve_table_wait_pickup"), InputState.stop());
        }
        Vec3d droppedTable = shell.nearestDroppedItemPosition(
            client,
            player,
            run.target,
            (stack, itemId) -> InventoryCounter.isCraftingTableItemId(itemId)
        );
        if (droppedTable != null) {
            shell.logger().info(
                "retrieve_table.collect_item_target instanceId={} commandId={} target={} itemX={} itemY={} itemZ={}",
                shell.instanceId(),
                commandId,
                run.target.toShortString(),
                McbotFabricClient.roundForLog(droppedTable.x),
                McbotFabricClient.roundForLog(droppedTable.y),
                McbotFabricClient.roundForLog(droppedTable.z)
            );
            if (run.exactRequired) {
                double horizontal = Math.hypot(
                    droppedTable.x - player.getX(), droppedTable.z - player.getZ());
                if (horizontal > 1.75D || Math.abs(droppedTable.y - player.getY()) > 2.0D) {
                    return failRetrieveTable(
                        effective,
                        run,
                        tables,
                        nowMs,
                        "retrieve_table_exact_drop_outside_pickup"
                    );
                }
                return new ControlDecision(
                    shell.stopFrom(effective, "retrieve_table_exact_wait_pickup"),
                    InputState.stop()
                );
            }
            BrainLink.Intent collectIntent = shell.gatherCollectIntent(
                effective,
                droppedTable.x,
                droppedTable.y,
                droppedTable.z,
                "retrieve_table_collect_item",
                ":retrieve:collect"
            );
            return shell.resolveNavigationControl(client, player, collectIntent);
        }
        if (nowMs - run.collectStartedAtMs > McbotFabricClient.GATHER_COLLECT_TIMEOUT_MS) {
            return failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_collect_timeout");
        }
        if (run.exactRequired) {
            return new ControlDecision(
                shell.stopFrom(effective, "retrieve_table_exact_wait_drop"),
                InputState.stop()
            );
        }
        BrainLink.Intent collectIntent = shell.gatherCollectIntent(effective, run.target.getX() + 0.5D, run.target.getZ() + 0.5D, "retrieve_table_collect_drop", ":retrieve:collect");
        return shell.resolveNavigationControl(client, player, collectIntent);
    }

    private ControlDecision maybeSkipRetrieveTableWithReplacement(
        BrainLink.Intent effective,
        ClientPlayerEntity player,
        RetrieveTableRun run,
        InventoryCounter.InventoryCraftingTableSnapshot tables,
        long nowMs,
        String sourceReason
    ) {
        InventoryCounter.InventoryLogSnapshot logs = InventoryCounter.countPlayerLogs(player);
        InventoryCounter.InventoryPlankSnapshot planks = InventoryCounter.countPlayerPlanks(player);
        if (!McbotFabricClient.hasCraftingTableReplacementMaterial(logs.logCount(), planks.plankCount())) {
            return null;
        }
        String completionReason = finishRetrieveTableCommand(
            run.commandId,
            "retrieve_table_complete:skipped_replacement_material_available:" + sourceReason
        );
        shell.logger().warn(
            "retrieve_table.skipped instanceId={} commandId={} reason={} target={} inventoryTablesBefore={} inventoryTablesAfter={} logs={} planks={} logsByItem={} planksByItem={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            sourceReason,
            McbotFabricClient.formatBlockPos(run.target),
            run.baselineTables,
            tables.craftingTableCount(),
            logs.logCount(),
            planks.plankCount(),
            logs.logsByItem(),
            planks.planksByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRun = null;
        shell.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
    }

    private ControlDecision failRetrieveTable(
        BrainLink.Intent effective,
        RetrieveTableRun run,
        InventoryCounter.InventoryCraftingTableSnapshot tables,
        long nowMs,
        String reason
    ) {
        String completionReason = finishRetrieveTableCommand(run.commandId, "retrieve_table_failed:" + reason);
        shell.logger().warn(
            "retrieve_table.failed instanceId={} commandId={} reason={} target={} breakDone={} inventoryTablesBefore={} inventoryTablesAfter={} tablesByItem={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            reason,
            McbotFabricClient.formatBlockPos(run.target),
            run.breakDone,
            run.baselineTables,
            tables.craftingTableCount(),
            tables.craftingTablesByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRun = null;
        shell.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
    }

    /**
     * Mirrors the shell's {@code finishRetrieveTableCommand} → {@code recordFinishedCommand} idiom:
     * records the commandId as completed (Set) and stores the reason (Map). The brain reads the reason
     * back through the completion aggregator, so the string is returned verbatim for the caller to relay.
     */
    private String finishRetrieveTableCommand(String commandId, String completionReason) {
        ledger.markComplete(commandId, completionReason);
        return completionReason;
    }

    private static ControlDecision withInteraction(
        ControlDecision decision,
        BlockBreakController.Result result
    ) {
        if (decision == null || result == null) {
            return decision;
        }
        return new ControlDecision(
            decision.intent(),
            decision.input(),
            decision.lookDemand(),
            decision.legacyLookDemand(),
            decision.locomotionDemand(),
            result.interactionDemand(),
            result.interactionPayload()
        );
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    /** Clears only the in-flight physical run; completed command receipts remain deduplicated. */
    public void clearActiveRun() {
        activeRun = null;
    }

    private static final class RetrieveTableRun {
        final String commandId;
        final int baselineTables;
        final long startedAtMs;
        BlockPos target = null;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;
        final boolean exactRequired;

        RetrieveTableRun(
            String commandId,
            int baselineTables,
            long startedAtMs,
            BlockPos exactTarget,
            boolean exactRequired
        ) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineTables = baselineTables;
            this.startedAtMs = startedAtMs;
            this.target = exactTarget == null ? null : exactTarget.toImmutable();
            this.exactRequired = exactRequired;
        }
    }
}
