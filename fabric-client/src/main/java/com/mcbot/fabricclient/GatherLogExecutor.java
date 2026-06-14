package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

/**
 * {@code gather_log} objective, lifted verbatim out of {@code McbotFabricClient}.
 *
 * <p>Concrete {@link ObjectiveExecutor} of the strangler decomposition (leaf tier 2). GatherLog
 * navigates to a cell adjacent to a single target log block, breaks it (clearing occluders and
 * repositioning around break failures), and collects the dropped log; it completes on an inventory
 * log delta. The control logic, the adjacent-cell navigation helper, the no-path predicate, the
 * completion writer, and the {@code GatherLogRun} state are moved here unchanged; the edits are
 * mechanical — source params become {@link TickContext} accessors, {@code activeGatherLog} becomes
 * {@link #activeRun}, the {@code completedGatherLogCommandIds} set + {@code finishedGatherLogCommandReasons}
 * map become {@link #ledger}, instance-helper calls go through {@link ShellServices}, the shared
 * {@code lastGatherCollectItemLogKey} field is read/written through the shell, and pure static helpers /
 * constants are referenced on {@link McbotFabricClient} directly.
 *
 * <p>The only caller of {@code resolveGatherLogControl} was the {@code resolveControl} dispatch chain,
 * so no public {@code resolve(...)} entry is needed; the logic lives in {@link #tick(TickContext)}.
 *
 * <p>The reason strings ({@code gather_log_complete:...}, {@code gather_log_failed:...}, etc.) are a wire
 * contract read by the brain and are preserved exactly.
 */
public final class GatherLogExecutor implements ObjectiveExecutor {

    private final ShellServices shell;
    private final CommandLedger ledger = new CommandLedger();
    private GatherLogRun activeRun = null;

    public GatherLogExecutor(ShellServices shell) {
        this.shell = shell;
    }

    @Override
    public boolean handles(String action) {
        return "gather_log".equals(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        MinecraftClient client = ctx.client();
        ClientPlayerEntity player = ctx.player();
        BrainLink.Intent effective = ctx.intent();
        long nowMs = ctx.nowMs();

        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (ledger.isFinished(commandId)) {
            return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_complete"), InputState.stop());
        }
        BlockPos target = ctx.shell().targetBlockPos(effective);
        if (target == null) {
            finishGatherLogCommand(commandId, "gather_log_failed:missing_target");
            return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_missing_target"), InputState.stop());
        }
        if (activeRun == null || !commandId.equals(activeRun.commandId)) {
            InventoryCounter.InventoryLogSnapshot inventory = InventoryCounter.countPlayerLogs(player);
            activeRun = new GatherLogRun(commandId, target, inventory.logCount(), nowMs);
            ctx.shell().logger().info(
                "gather_log.start instanceId={} commandId={} target={} inventoryLogsBefore={} logsByItem={}",
                ctx.shell().instanceId(),
                commandId,
                target.toShortString(),
                inventory.logCount(),
                inventory.logsByItem()
            );
        }

        InventoryCounter.InventoryLogSnapshot inventory = InventoryCounter.countPlayerLogs(player);
        if (inventory.logCount() > activeRun.baselineLogCount) {
            finishGatherLogCommand(commandId, "gather_log_complete:inventory_delta");
            ctx.shell().logger().info(
                "gather_log.complete instanceId={} commandId={} target={} inventoryLogsBefore={} inventoryLogsAfter={} elapsedMs={} logsByItem={}",
                ctx.shell().instanceId(),
                commandId,
                target.toShortString(),
                activeRun.baselineLogCount,
                inventory.logCount(),
                Math.max(0L, nowMs - activeRun.startedAtMs),
                inventory.logsByItem()
            );
            activeRun = null;
            return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_complete"), InputState.stop());
        }

        if (!activeRun.breakDone) {
            BlockState targetState = client.world.getBlockState(target);
            if (targetState.isAir()) {
                activeRun.breakDone = true;
                activeRun.collectStartedAtMs = nowMs;
            } else if (!targetState.isIn(BlockTags.LOGS)) {
                finishGatherLogCommand(commandId, "gather_log_failed:target_not_log");
                activeRun = null;
                return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_target_not_log"), InputState.stop());
            }
        }

        if (!activeRun.breakDone) {
            ControlDecision nav = navigateToGatherAdjacentCell(client, player, effective, activeRun, nowMs);
            if (nav != null) {
                return nav;
            }
            BrainLink.Intent lookIntent = ctx.shell().lookIntentForBlock(effective, player, target, "gather_log_face");
            if (!ctx.shell().isLookingAtBlock(player, target)) {
                return new ControlDecision(lookIntent, InputState.stop());
            }
            BlockBreakController.Result result = ctx.shell().blockBreakController().tick(client, player, target, commandId, nowMs);
            ctx.shell().logBlockBreakResult(commandId, target, result);
            if ("occluder_cleared".equals(result.reason())) {
                activeRun.occludersBroken++;
                ctx.shell().logger().info(
                    "gather_log.occluder_broken instanceId={} commandId={} target={} occluder={} occludersBroken={}",
                    ctx.shell().instanceId(),
                    commandId,
                    target.toShortString(),
                    McbotFabricClient.formatBlockPos(result.actedBlock()),
                    activeRun.occludersBroken
                );
            }
            if (result.status() == BlockBreakController.Status.BROKEN) {
                activeRun.breakDone = true;
                activeRun.collectStartedAtMs = nowMs;
                ctx.shell().logger().info(
                    "gather_log.break_done instanceId={} commandId={} target={} elapsedMs={}",
                    ctx.shell().instanceId(),
                    commandId,
                    target.toShortString(),
                    Math.max(0L, nowMs - activeRun.startedAtMs)
                );
        } else if (result.status() == BlockBreakController.Status.REPOSITION) {
            if (activeRun.adjacentCell != null) {
                activeRun.excludedAdjacentCells.add(activeRun.adjacentCell);
            }
            activeRun.occlusionRepositions++;
            ctx.shell().clearNavigationState();
            activeRun.adjacentCell = null;
            activeRun.adjacentRoute = List.of();
            activeRun.adjacentReached = false;
            activeRun.adjacentLatchLogged = false;
            activeRun.adjacentLatchHoldLogged = false;
            activeRun.adjacentProgress.reset();
            ctx.shell().logger().warn(
                "gather_log.occlusion_reposition instanceId={} commandId={} target={} hitBlock={} repositions={} reason={}",
                ctx.shell().instanceId(),
                commandId,
                target.toShortString(),
                    McbotFabricClient.formatBlockPos(result.hitBlock()),
                    activeRun.occlusionRepositions,
                    result.reason()
                );
                return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_occlusion_reposition"), InputState.stop());
            } else if (result.status() == BlockBreakController.Status.FAILED) {
                if (result.reason().startsWith("raycast_")) {
                    activeRun.occlusionAbandons++;
                }
                if ("break_timeout".equals(result.reason()) && activeRun.occlusionRepositions < 2) {
                    if (activeRun.adjacentCell != null) {
                        activeRun.excludedAdjacentCells.add(activeRun.adjacentCell);
                    }
                    activeRun.occlusionRepositions++;
                    ctx.shell().clearNavigationState();
                    activeRun.adjacentCell = null;
                    activeRun.adjacentRoute = List.of();
                    activeRun.adjacentReached = false;
                    activeRun.adjacentLatchLogged = false;
                    activeRun.adjacentLatchHoldLogged = false;
                    activeRun.adjacentProgress.reset();
                    ctx.shell().logger().warn(
                        "gather_log.break_timeout_reposition instanceId={} commandId={} target={} repositions={} reason={}",
                        ctx.shell().instanceId(),
                        commandId,
                        target.toShortString(),
                        activeRun.occlusionRepositions,
                        result.reason()
                    );
                    return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_break_timeout_reposition"), InputState.stop());
                }
                finishGatherLogCommand(commandId, "gather_log_failed:break_" + result.reason());
                activeRun = null;
                return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_break_failed:" + result.reason()), InputState.stop());
            } else {
                return new ControlDecision(ctx.shell().lookIntentForBlock(effective, player, target, "gather_log_breaking:" + result.reason()), InputState.stop());
            }
        }

        if (activeRun.collectStartedAtMs > 0L && nowMs - activeRun.collectStartedAtMs > McbotFabricClient.GATHER_COLLECT_TIMEOUT_MS) {
            finishGatherLogCommand(commandId, "gather_log_failed:collect_timeout");
            ctx.shell().logger().warn(
                "gather_log.collect_timeout instanceId={} commandId={} target={} inventoryLogsBefore={} inventoryLogsAfter={}",
                ctx.shell().instanceId(),
                commandId,
                target.toShortString(),
                activeRun.baselineLogCount,
                inventory.logCount()
            );
            activeRun = null;
            return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_collect_timeout"), InputState.stop());
        }

        if (activeRun.collectStartedAtMs > 0L && nowMs - activeRun.collectStartedAtMs < McbotFabricClient.GATHER_PICKUP_SETTLE_MS) {
            return new ControlDecision(ctx.shell().stopFrom(effective, "gather_log_wait_pickup"), InputState.stop());
        }

        Vec3d droppedLogPosition = ctx.shell().nearestDroppedLogItemPosition(client, player, target);
        BrainLink.Intent collectIntent;
        if (droppedLogPosition != null) {
            String logKey = commandId + ":" + McbotFabricClient.roundForLog(droppedLogPosition.x) + ":" + McbotFabricClient.roundForLog(droppedLogPosition.y)
                + ":" + McbotFabricClient.roundForLog(droppedLogPosition.z);
            if (!logKey.equals(ctx.shell().lastGatherCollectItemLogKey())) {
                ctx.shell().setLastGatherCollectItemLogKey(logKey);
                ctx.shell().logger().info(
                    "gather_log.collect_item_target instanceId={} commandId={} target={} itemX={} itemY={} itemZ={}",
                    ctx.shell().instanceId(),
                    commandId,
                    target.toShortString(),
                    McbotFabricClient.roundForLog(droppedLogPosition.x),
                    McbotFabricClient.roundForLog(droppedLogPosition.y),
                    McbotFabricClient.roundForLog(droppedLogPosition.z)
                );
            }
            ControlDecision directCollect = ctx.shell().maybeResolveDroppedLogDirectCollect(
                effective,
                player,
                droppedLogPosition,
                "gather_log_collect_direct"
            );
            if (directCollect != null) {
                return directCollect;
            }
            collectIntent = ctx.shell().gatherCollectIntent(
                effective,
                droppedLogPosition.x,
                droppedLogPosition.y,
                droppedLogPosition.z,
                "gather_log_collect_item",
                ":collect:item"
            );
        } else {
            collectIntent = ctx.shell().gatherCollectIntent(effective, target, activeRun.adjacentCell);
        }
        return ctx.shell().resolveNavigationControl(client, player, collectIntent);
    }

    private ControlDecision navigateToGatherAdjacentCell(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherLogRun run,
        long nowMs
    ) {
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        if (run.adjacentCell == null) {
            int referenceFeetY = (int) Math.floor(player.getY());
            int targetX = run.target.getX();
            int targetZ = run.target.getZ();
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                Math.min(start.x(), targetX) - McbotFabricClient.NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.x(), targetX) + McbotFabricClient.NAVIGATION_PERCEPTION_MARGIN,
                Math.min(start.z(), targetZ) - McbotFabricClient.NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.z(), targetZ) + McbotFabricClient.NAVIGATION_PERCEPTION_MARGIN
            );
            GridPerception routePerception = McbotFabricClient.maybeAnchorCurrentStart(client.world, perception, start, referenceFeetY, true);
            if (routePerception != perception) {
                shell.logger().info(
                    "navigation.start_anchored instanceId={} commandId={} reason=gather_log_adjacent start={} referenceFeetY={} perceivedSurface={} anchoredSurface={}",
                    shell.instanceId(),
                    run.commandId,
                    start,
                    referenceFeetY,
                    McbotFabricClient.formatSurface(perception, start),
                    referenceFeetY
                );
            }
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
                routePerception,
                start,
                targetX,
                run.target.getY(),
                targetZ,
                run.excludedAdjacentCells
            );
            if (plan.cell() == null) {
                finishGatherLogCommand(run.commandId, "gather_log_failed:no_adjacent_path");
                activeRun = null;
                return new ControlDecision(shell.stopFrom(effective, "gather_log_no_adjacent_path"), InputState.stop());
            }
            run.adjacentCell = plan.cell();
            run.adjacentRoute = plan.route();
            run.adjacentReached = false;
            run.adjacentLatchLogged = false;
            run.adjacentLatchHoldLogged = false;
            run.adjacentProgress.reset();
            shell.logger().info(
                "gather_log.adjacent_selected instanceId={} commandId={} target={} adjacent={} routeLength={} reason={}",
                shell.instanceId(),
                run.commandId,
                run.target.toShortString(),
                run.adjacentCell,
                plan.route().size(),
                plan.reason()
            );
        }
        double distance = Math.hypot(PathFollower.center(run.adjacentCell.x()) - player.getX(), PathFollower.center(run.adjacentCell.z()) - player.getZ());
        double targetDistance = Math.hypot(PathFollower.center(run.target.getX()) - player.getX(), PathFollower.center(run.target.getZ()) - player.getZ());
        if (run.adjacentReached) {
            if (!run.adjacentLatchHoldLogged && !start.equals(run.adjacentCell)) {
                run.adjacentLatchHoldLogged = true;
                shell.logger().info(
                    "gather_log.adjacent_latch_hold instanceId={} commandId={} target={} adjacent={} centerDistance={} targetDistance={}",
                    shell.instanceId(),
                    run.commandId,
                    run.target.toShortString(),
                    run.adjacentCell,
                    McbotFabricClient.roundForLog(distance),
                    McbotFabricClient.roundForLog(targetDistance)
                );
            }
            return null;
        }
        if (start.equals(run.adjacentCell) || distance <= McbotFabricClient.GATHER_ARRIVE_EPSILON) {
            run.adjacentReached = true;
            run.adjacentProgress.reset();
            if (!run.adjacentLatchLogged) {
                run.adjacentLatchLogged = true;
                shell.logger().info(
                    "gather_log.adjacent_latched instanceId={} commandId={} target={} adjacent={} centerDistance={} targetDistance={}",
                    shell.instanceId(),
                    run.commandId,
                    run.target.toShortString(),
                    run.adjacentCell,
                    McbotFabricClient.roundForLog(distance),
                    McbotFabricClient.roundForLog(targetDistance)
                );
            }
            if (start.equals(run.adjacentCell) && distance > McbotFabricClient.GATHER_ARRIVE_EPSILON) {
                shell.logger().info(
                    "gather_log.adjacent_arrived_by_cell instanceId={} commandId={} target={} adjacent={} centerDistance={}",
                    shell.instanceId(),
                    run.commandId,
                    run.target.toShortString(),
                    run.adjacentCell,
                    McbotFabricClient.roundForLog(distance)
                );
            }
            return null;
        }
        AdjacentMoveProgressTracker.Result progress = run.adjacentProgress.update(
            run.adjacentCell,
            distance,
            player.getX(),
            player.getZ(),
            nowMs,
            McbotFabricClient.gatherAdjacentMoveStallMs(run.adjacentRoute, distance),
            McbotFabricClient.GATHER_ADJACENT_MOVE_IMPROVEMENT,
            McbotFabricClient.GATHER_ADJACENT_MOVE_MOVEMENT
        );
        if (progress.stalled()) {
            run.excludedAdjacentCells.add(run.adjacentCell);
            run.adjacentMoveStalls++;
            shell.logger().warn(
                "gather_log.adjacent_move_stall instanceId={} commandId={} target={} adjacent={} distance={} bestDistance={} stalledMs={} stalls={}",
                shell.instanceId(),
                run.commandId,
                run.target.toShortString(),
                run.adjacentCell,
                McbotFabricClient.roundForLog(distance),
                McbotFabricClient.roundForLog(progress.bestDistance()),
                progress.stalledMs(),
                run.adjacentMoveStalls
            );
            run.adjacentCell = null;
            run.adjacentRoute = List.of();
            run.adjacentReached = false;
            run.adjacentLatchLogged = false;
            run.adjacentLatchHoldLogged = false;
            run.adjacentProgress.reset();
            shell.clearNavigationState();
            return new ControlDecision(shell.stopFrom(effective, "gather_log_adjacent_move_stall_reposition"), InputState.stop());
        }
        BrainLink.Intent navIntent = new BrainLink.Intent(
            "navigate_to_point",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            PathFollower.center(run.adjacentCell.x()),
            PathFollower.center(run.adjacentCell.z()),
            run.adjacentRoute,
            List.of(),
            McbotFabricClient.GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            "gather_log_nav_adjacent",
            run.commandId + ":adjacent"
        );
        ControlDecision nav = shell.resolveNavigationControl(client, player, navIntent);
        if (isTargetRejectedNoPath(nav)) {
            finishGatherLogCommand(run.commandId, "gather_log_failed:adjacent_no_path");
            shell.logger().warn(
                "gather_log.adjacent_rejected instanceId={} commandId={} target={} adjacent={} reason=target_rejected_no_path",
                shell.instanceId(),
                run.commandId,
                run.target.toShortString(),
                run.adjacentCell
            );
            activeRun = null;
            shell.clearNavigationState();
            return new ControlDecision(shell.stopFrom(effective, "gather_log_failed:adjacent_no_path"), InputState.stop());
        }
        return nav;
    }

    private static boolean isTargetRejectedNoPath(ControlDecision decision) {
        return decision != null
            && decision.intent() != null
            && "target_rejected_no_path".equals(decision.intent().reason());
    }

    private void finishGatherLogCommand(String commandId, String reason) {
        String id = commandId == null ? "" : commandId;
        if (id.isBlank()) {
            return;
        }
        ledger.markComplete(id, reason == null || reason.isBlank() ? "gather_log_complete" : reason);
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    private static final class GatherLogRun {
        final String commandId;
        final BlockPos target;
        final int baselineLogCount;
        final long startedAtMs;
        final Set<GridCell> excludedAdjacentCells = new HashSet<>();
        GridCell adjacentCell = null;
        List<GridCell> adjacentRoute = List.of();
        final AdjacentMoveProgressTracker adjacentProgress = new AdjacentMoveProgressTracker();
        boolean adjacentReached = false;
        boolean adjacentLatchLogged = false;
        boolean adjacentLatchHoldLogged = false;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;
        int occludersBroken = 0;
        int occlusionRepositions = 0;
        int occlusionAbandons = 0;
        int adjacentMoveStalls = 0;

        GatherLogRun(String commandId, BlockPos target, int baselineLogCount, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.target = target.toImmutable();
            this.baselineLogCount = baselineLogCount;
            this.startedAtMs = startedAtMs;
        }
    }
}
