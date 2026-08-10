package com.mcbot.fabricclient;

import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

/**
 * {@code mine_stone} objective, lifted verbatim out of {@code McbotFabricClient}.
 *
 * <p>First concrete {@link ObjectiveExecutor} of the strangler decomposition. MineStone is the
 * cleanest leaf: one contiguous handler band, no planner, zero cross-executor calls. The control
 * logic, the failure path, and the per-run state record are moved here unchanged; the only edits are
 * mechanical — source params become {@link TickContext} accessors, the {@code activeMineStone} field
 * becomes {@link #activeRun}, the {@code completedMineStoneCommandIds} set becomes {@link #ledger},
 * instance-helper calls go through {@link ShellServices}, and pure static helpers / constants are
 * referenced on {@link McbotFabricClient} directly.
 *
 * <p>The reason strings ({@code mine_stone_complete}, {@code mine_stone_failed:...}, etc.) are a wire
 * contract read by the brain and are preserved exactly.
 */
public final class MineStoneExecutor implements ObjectiveExecutor {

    private final ShellServices shell;
    private final CommandLedger ledger = new CommandLedger();
    private MineStoneRun activeRun = null;

    public MineStoneExecutor(ShellServices shell) {
        this.shell = shell;
    }

    @Override
    public boolean handles(String action) {
        return "mine_stone".equals(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        MinecraftClient client = ctx.client();
        ClientPlayerEntity player = ctx.player();
        BrainLink.Intent effective = ctx.intent();
        long nowMs = ctx.nowMs();

        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (ledger.isCompleted(commandId)) {
            return new ControlDecision(shell.stopFrom(effective, "mine_stone_complete"), InputState.stop());
        }
        BlockPos target = shell.targetBlockPos(effective);
        if (target == null) {
            ledger.markComplete(commandId, null);
            return new ControlDecision(shell.stopFrom(effective, "mine_stone_missing_target"), InputState.stop());
        }
        if (activeRun == null || !commandId.equals(activeRun.commandId)) {
            InventoryCounter.InventoryCobblestoneSnapshot inventory = InventoryCounter.countPlayerCobblestone(player);
            activeRun = new MineStoneRun(commandId, target, inventory.cobblestoneCount(), nowMs);
            shell.logger().info(
                "mine_stone.start instanceId={} commandId={} target={} inventoryCobblestoneBefore={} cobblestoneByItem={}",
                shell.instanceId(),
                commandId,
                target.toShortString(),
                inventory.cobblestoneCount(),
                inventory.cobblestoneByItem()
            );
        }

        MineStoneRun run = activeRun;
        ControlDecision breachReflex = shell.maybeContinueFluidBreachReflex(
            client, player, effective, null, "mine_stone", nowMs);
        if (breachReflex != null) {
            return breachReflex;
        }
        InventoryCounter.InventoryCobblestoneSnapshot inventory = InventoryCounter.countPlayerCobblestone(player);
        if (inventory.cobblestoneCount() > run.baselineCobblestone) {
            ledger.markComplete(commandId, null);
            shell.logger().info(
                "mine_stone.complete instanceId={} commandId={} target={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} elapsedMs={} cobblestoneByItem={}",
                shell.instanceId(),
                commandId,
                target.toShortString(),
                run.baselineCobblestone,
                inventory.cobblestoneCount(),
                Math.max(0L, nowMs - run.startedAtMs),
                inventory.cobblestoneByItem()
            );
            activeRun = null;
            return new ControlDecision(shell.stopFrom(effective, "mine_stone_complete"), InputState.stop());
        }

        if (nowMs - run.startedAtMs > McbotFabricClient.CRAFT_TOTAL_TIMEOUT_MS + McbotFabricClient.GATHER_COLLECT_TIMEOUT_MS) {
            return failMineStone(effective, run, inventory, nowMs, "mine_stone_timeout");
        }

        if (!run.breakDone) {
            BlockState targetState = client.world.getBlockState(target);
            if (targetState.isAir()) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
                // The server-confirmed break usually lands here (isAir re-check) rather than on a
                // BROKEN controller tick — the breach probe must run on BOTH completion paths.
                ControlDecision breachActivation = shell.maybeActivateFluidBreachReflex(
                    client, player, effective, target, null, "mine_stone", nowMs);
                if (breachActivation != null) {
                    return breachActivation;
                }
            } else if (!targetState.isOf(Blocks.STONE)) {
                return failMineStone(effective, run, inventory, nowMs, "mine_stone_target_not_stone");
            }
        }

        if (!run.breakDone) {
            int pickaxeSlot = shell.findStoneMiningPickaxeHotbarSlot(player);
            if (pickaxeSlot < 0) {
                int hotbarMove = shell.moveStoneMiningPickaxeToHotbar(client, player, commandId, "mine_stone");
                if (hotbarMove >= 0 || hotbarMove == -2) {
                    return new ControlDecision(shell.stopFrom(effective, "mine_stone_hotbar_move"), InputState.stop());
                }
                return failMineStone(effective, run, inventory, nowMs, "mine_stone_no_pickaxe_hotbar");
            }
            if (player.getInventory().selectedSlot != pickaxeSlot) {
                player.getInventory().selectedSlot = pickaxeSlot;
                shell.logger().info(
                    "mine_stone.tool_selected instanceId={} commandId={} hotbarSlot={}",
                    shell.instanceId(),
                    commandId,
                    pickaxeSlot
                );
                return new ControlDecision(shell.stopFrom(effective, "mine_stone_select_tool"), InputState.stop());
            }
            BrainLink.Intent lookIntent = shell.lookIntentForBlock(effective, player, target, "mine_stone_face");
            if (!shell.isLookingAtBlock(player, target)) {
                return new ControlDecision(lookIntent, InputState.stop());
            }
            BlockBreakController.Result result = shell.blockBreakController().tick(client, player, target, commandId, nowMs);
            shell.logBlockBreakResult(commandId, target, result);
            shell.logger().info(
                "mine_stone.break_progress instanceId={} commandId={} target={} status={} reason={} elapsedMs={}",
                shell.instanceId(),
                commandId,
                target.toShortString(),
                result.status(),
                result.reason(),
                result.elapsedMs()
            );
            if (result.status() == BlockBreakController.Status.BROKEN) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
                ControlDecision breachActivation = shell.maybeActivateFluidBreachReflex(
                    client, player, effective, target, null, "mine_stone", nowMs);
                if (breachActivation != null) {
                    return withInteraction(breachActivation, result);
                }
                return withInteraction(
                    new ControlDecision(shell.stopFrom(effective, "mine_stone_break_done"), InputState.stop()),
                    result
                );
            }
            if (result.status() == BlockBreakController.Status.REPOSITION) {
                return withInteraction(
                    failMineStone(effective, run, inventory, nowMs, "mine_stone_break_reposition:" + result.reason()),
                    result
                );
            }
            if (result.status() == BlockBreakController.Status.FAILED) {
                return withInteraction(
                    failMineStone(effective, run, inventory, nowMs, "mine_stone_break_failed:" + result.reason()),
                    result
                );
            }
            return withInteraction(
                new ControlDecision(shell.lookIntentForBlock(effective, player, target, "mine_stone_breaking:" + result.reason()), InputState.stop()),
                result
            );
        }

        if (run.collectStartedAtMs <= 0L) {
            run.collectStartedAtMs = nowMs;
        }
        if (nowMs - run.collectStartedAtMs < McbotFabricClient.GATHER_PICKUP_SETTLE_MS) {
            return new ControlDecision(shell.stopFrom(effective, "mine_stone_wait_pickup"), InputState.stop());
        }
        Vec3d droppedCobblestone = shell.nearestDroppedItemPosition(
            client,
            player,
            target,
            (stack, itemId) -> InventoryCounter.isCobblestoneItemId(itemId)
        );
        if (droppedCobblestone != null) {
            shell.logger().info(
                "mine_stone.collect_item_target instanceId={} commandId={} target={} itemX={} itemY={} itemZ={}",
                shell.instanceId(),
                commandId,
                target.toShortString(),
                McbotFabricClient.roundForLog(droppedCobblestone.x),
                McbotFabricClient.roundForLog(droppedCobblestone.y),
                McbotFabricClient.roundForLog(droppedCobblestone.z)
            );
            BrainLink.Intent collectIntent = shell.gatherCollectIntent(
                effective,
                droppedCobblestone.x,
                droppedCobblestone.y,
                droppedCobblestone.z,
                "mine_stone_collect_item",
                ":mine:collect"
            );
            return shell.resolveNavigationControl(client, player, collectIntent);
        }
        if (nowMs - run.collectStartedAtMs > McbotFabricClient.GATHER_COLLECT_TIMEOUT_MS) {
            return failMineStone(effective, run, inventory, nowMs, "mine_stone_collect_timeout");
        }
        BrainLink.Intent collectIntent = shell.gatherCollectIntent(effective, target.getX() + 0.5D, target.getZ() + 0.5D, "mine_stone_collect_drop", ":mine:collect");
        return shell.resolveNavigationControl(client, player, collectIntent);
    }

    private ControlDecision failMineStone(
        BrainLink.Intent effective,
        MineStoneRun run,
        InventoryCounter.InventoryCobblestoneSnapshot inventory,
        long nowMs,
        String reason
    ) {
        ledger.markComplete(run.commandId, null);
        shell.logger().warn(
            "mine_stone.failed instanceId={} commandId={} reason={} target={} breakDone={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} cobblestoneByItem={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            reason,
            McbotFabricClient.formatBlockPos(run.target),
            run.breakDone,
            run.baselineCobblestone,
            inventory.cobblestoneCount(),
            inventory.cobblestoneByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRun = null;
        return new ControlDecision(shell.stopFrom(effective, "mine_stone_failed:" + reason), InputState.stop());
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

    private static final class MineStoneRun {
        final String commandId;
        final BlockPos target;
        final int baselineCobblestone;
        final long startedAtMs;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;

        MineStoneRun(String commandId, BlockPos target, int baselineCobblestone, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.target = target == null ? null : target.toImmutable();
            this.baselineCobblestone = baselineCobblestone;
            this.startedAtMs = startedAtMs;
        }
    }
}
