package com.mcbot.fabricclient;

import net.minecraft.block.BedBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * {@code use_bed} objective, lifted verbatim out of {@code McbotFabricClient}.
 *
 * <p>Fourth concrete {@link ObjectiveExecutor} of the strangler decomposition (PR-3). UseBed places a
 * verified hotbar bed (if none is nearby) and right-clicks it to set the respawn point without sleeping. The
 * control logic, the completion path, the {@code USE_BED_*} constants, and the {@code findNearbyBedBlock}
 * helper (UseBed's only caller) are moved here unchanged; the edits are mechanical — source params
 * become the {@link TickContext} accessors, the {@code activeUseBed} field becomes {@link #activeRun},
 * the {@code finishedUseBedCommandReasons} map becomes {@link #ledger} (Map-only completion; no
 * completed-set existed), instance-helper calls go through {@link ShellServices}, and pure static
 * helpers ({@code wrapDegreesDelta}, {@code findHotbarSlotByItemId}) are referenced on
 * {@link McbotFabricClient} directly.
 *
 * <p>The only caller of {@code resolveUseBedControl} was the {@code resolveControl} dispatch chain, so
 * no public {@code resolve(...)} entry is needed; the logic lives in {@link #tick(TickContext)}.
 *
 * <p>The reason strings ({@code use_bed_complete:...}, {@code use_bed_failed:...}, etc.) are a wire
 * contract read by the brain and are preserved exactly.
 */
public final class UseBedExecutor implements ObjectiveExecutor {

    // CP2 slice 2 part 2: place a carried bed (if none is nearby) and right-click it. A daytime bed
    // click sets the respawn point ("Respawn point set") — CP2's death-insurance payoff — without
    // sleeping. Placement uses the standard verified place path (foot cell = support.up()); vanilla
    // itself rejects placement when the head cell is blocked, and the command timeout nets that.
    private static final long USE_BED_TIMEOUT_MS = 45_000L;
    private static final long USE_BED_INTERACT_INTERVAL_MS = 700L;
    private static final double USE_BED_AIM_ALIGN_DEG = 10.0D;

    private final ShellServices shell;
    private final CommandLedger ledger = new CommandLedger();
    private UseBedRun activeRun = null;

    public UseBedExecutor(ShellServices shell) {
        this.shell = shell;
    }

    @Override
    public boolean handles(String action) {
        return "use_bed".equals(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        MinecraftClient client = ctx.client();
        ClientPlayerEntity player = ctx.player();
        BrainLink.Intent effective = ctx.intent();
        long nowMs = ctx.nowMs();

        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finished = ledger.reason(commandId);
        if (finished != null) {
            return new ControlDecision(shell.stopFrom(effective, finished), InputState.stop());
        }
        if (activeRun == null || !commandId.equals(activeRun.commandId)) {
            activeRun = new UseBedRun(commandId, nowMs);
            shell.logger().info("use_bed.start instanceId={} commandId={}", shell.instanceId(), commandId);
        }
        UseBedRun run = activeRun;
        if (nowMs - run.startedAtMs > USE_BED_TIMEOUT_MS) {
            return completeUseBed(effective, run, nowMs, "use_bed_failed:timeout");
        }

        BlockPos bed = findNearbyBedBlock(client, player, 4);
        if (!run.pendingRequestId.isEmpty()
            && (bed == null || run.pendingBed == null || !run.pendingBed.equals(bed))) {
            clearPendingInteraction(run);
        }
        if (bed != null) {
            // Cycle-1 lesson: a grass plant between eye and bed-center intercepts the OUTLINE ray
            // (vanilla clicks cannot pass through a plant's outline either). Do what a human does —
            // aim at a VISIBLE part of the bed: try several points; the first whose eye-ray
            // genuinely hits the bed wins. If every point is obscured, step toward the bed.
            Vec3d eye = player.getEyePos();
            Vec3d towardPlayer = new Vec3d(
                eye.x - (bed.getX() + 0.5D), 0.0D, eye.z - (bed.getZ() + 0.5D)).normalize();
            Vec3d[] aimCandidates = {
                new Vec3d(bed.getX() + 0.5D, bed.getY() + 0.50D, bed.getZ() + 0.5D),
                new Vec3d(bed.getX() + 0.5D + towardPlayer.x * 0.35D, bed.getY() + 0.52D, bed.getZ() + 0.5D + towardPlayer.z * 0.35D),
                new Vec3d(bed.getX() + 0.5D, bed.getY() + 0.30D, bed.getZ() + 0.5D),
            };
            Vec3d aim = null;
            BlockHitResult bedHit = null;
            for (Vec3d candidate : aimCandidates) {
                BlockHitResult hit = client.world.raycast(new RaycastContext(
                    eye, candidate, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
                if (hit != null && hit.getType() == HitResult.Type.BLOCK
                    && client.world.getBlockState(hit.getBlockPos()).getBlock() instanceof BedBlock) {
                    aim = candidate;
                    bedHit = hit;
                    break;
                }
            }
            if (aim == null) {
                // Fully obscured from here: take an edge-guarded step toward the bed and retry.
                McbotFabricClient.LookAngles approach = shell.lookAnglesToPoint(player, Vec3d.ofCenter(bed));
                boolean blocked = shell.edgeGuardBlocksForward(client, player, approach.yaw());
                InputState step = blocked
                    ? InputState.stop()
                    : new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
                return new ControlDecision(
                    shell.lookIntentForAngles(effective, approach.yaw(), approach.pitch(), "use_bed_approach"),
                    step
                );
            }
            McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, aim);
            double yawError = Math.abs(McbotFabricClient.wrapDegreesDelta(look.yaw() - player.getYaw()));
            double pitchError = Math.abs(look.pitch() - player.getPitch());
            BrainLink.Intent aimIntent = shell.lookIntentForAngles(effective, look.yaw(), look.pitch(), "use_bed_aim");
            if (yawError <= USE_BED_AIM_ALIGN_DEG
                && pitchError <= USE_BED_AIM_ALIGN_DEG
                && nowMs - run.lastInteractMs >= USE_BED_INTERACT_INTERVAL_MS) {
                if (run.pendingRequestId.isEmpty()) {
                    run.interactionAttempt++;
                    run.pendingRequestId = "use_bed:" + commandId + ":" + run.interactionAttempt;
                    run.pendingBed = bedHit.getBlockPos().toImmutable();
                    run.pendingHit = bedHit;
                } else if (!bedHit.getBlockPos().equals(run.pendingBed)) {
                    clearPendingInteraction(run);
                    return new ControlDecision(aimIntent, InputState.stop());
                }
                InteractionDemand demand = InteractionDemand.useBlock(
                    run.pendingRequestId,
                    LookDemand.Owner.NORMAL,
                    commandId,
                    "use_bed_interact",
                    "bed:" + run.pendingBed.toShortString(),
                    run.pendingHit.getSide().asString(),
                    "use_bed_interact"
                );
                return new ControlDecision(
                    aimIntent,
                    InputState.stop(),
                    null,
                    null,
                    null,
                    demand,
                    FabricInteractionAuthority.Payload.blockUse(run.pendingHit, Hand.MAIN_HAND)
                );
            }
            return new ControlDecision(aimIntent, InputState.stop());
        }

        int bedSlot = shell.findHotbarSlot(
            player, itemId -> itemId != null && itemId.endsWith("_bed"));
        if (bedSlot < 0) {
            return completeUseBed(effective, run, nowMs, "use_bed_failed:no_bed_in_hotbar");
        }
        if (player.getInventory().selectedSlot != bedSlot) {
            player.getInventory().selectedSlot = bedSlot;
            return new ControlDecision(shell.stopFrom(effective, "use_bed_select_slot"), InputState.stop());
        }
        ItemStack bedStack = player.getInventory().getStack(bedSlot);
        if (bedStack == null || bedStack.isEmpty()
            || !(bedStack.getItem() instanceof BlockItem bedItem)
            || !(bedItem.getBlock() instanceof BedBlock)) {
            return completeUseBed(effective, run, nowMs, "use_bed_failed:invalid_bed_item");
        }
        String bedItemId = shell.itemId(bedStack);
        // Place on the ground two cells ahead (both bed cells clear on the fixture meadow; vanilla
        // rejects blocked placements and the timeout nets persistent failure).
        BlockPos ground = player.getBlockPos().offset(player.getHorizontalFacing(), 2).down();
        BlockPlaceController.PlaceSpec bedSpec =
            new BlockPlaceController.PlaceSpec(
                "use_bed_place", bedItemId, bedItem.getBlock(), false, true);
        BlockPlaceController.Result placeResult = shell.blockPlaceController().tick(
            client, player, commandId + ":place", nowMs, ground, bedSpec);
        if (placeResult.status() == BlockPlaceController.Status.FAILED) {
            return withInteraction(
                completeUseBed(effective, run, nowMs, "use_bed_failed:place:" + placeResult.reason()),
                placeResult
            );
        }
        Vec3d groundAim = new Vec3d(ground.getX() + 0.5D, ground.getY() + 1.0D, ground.getZ() + 0.5D);
        McbotFabricClient.LookAngles placeLook = shell.lookAnglesToPoint(player, groundAim);
        return withInteraction(
            new ControlDecision(
                shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "use_bed_placing"),
                InputState.stop()
            ),
            placeResult
        );
    }

    private static ControlDecision withInteraction(
        ControlDecision decision,
        BlockPlaceController.Result result
    ) {
        if (decision == null || result == null) {
            return decision;
        }
        InteractionDemand demand = result.interactionDemand() == null
            ? decision.interactionDemand()
            : result.interactionDemand();
        FabricInteractionAuthority.Payload payload = result.interactionDemand() == null
            ? decision.interactionPayload()
            : result.interactionPayload();
        return new ControlDecision(
            decision.intent(),
            decision.input(),
            decision.lookDemand(),
            decision.legacyLookDemand(),
            decision.locomotionDemand(),
            demand,
            payload
        );
    }

    private ControlDecision completeUseBed(BrainLink.Intent effective, UseBedRun run, long nowMs, String reason) {
        recordUseBedCompletion(run, nowMs, reason);
        return new ControlDecision(shell.stopFrom(effective, reason), InputState.stop());
    }

    /**
     * Consume the receipt from the final interaction authority. Demand creation alone never advances
     * the retry clock or completes the objective: only the matching physical block-use result may do
     * so. Deferred work retains its request id because it was not pulse-deduplicated by the authority.
     */
    void observeInteractionReceipt(InteractionAppliedReceipt receipt) {
        UseBedRun run = activeRun;
        if (run == null
            || receipt == null
            || receipt.action() != InteractionDemand.Action.USE_BLOCK
            || run.pendingRequestId.isEmpty()
            || !run.pendingRequestId.equals(receipt.requestId())) {
            return;
        }
        if (receipt.disposition() == InteractionAppliedReceipt.Disposition.DEFERRED) {
            return;
        }
        BlockPos interactedBed = run.pendingBed;
        clearPendingInteraction(run);
        if (!receipt.applied()) {
            return;
        }
        run.lastInteractMs = receipt.timestampMs();
        if (receipt.actionResult() == null || !receipt.actionResult().isAccepted()) {
            shell.logger().warn(
                "use_bed.interaction_rejected instanceId={} commandId={} bed={} result={} reason={}",
                shell.instanceId(),
                run.commandId,
                interactedBed == null ? "none" : interactedBed.toShortString(),
                receipt.actionResult(),
                receipt.reason()
            );
            return;
        }
        shell.logger().info(
            "use_bed.interacted instanceId={} commandId={} bed={} requestId={}",
            shell.instanceId(),
            run.commandId,
            interactedBed == null ? "none" : interactedBed.toShortString(),
            receipt.requestId()
        );
        recordUseBedCompletion(
            run,
            receipt.timestampMs(),
            "use_bed_complete:interacted:" + (interactedBed == null ? "none" : interactedBed.toShortString())
        );
    }

    private void recordUseBedCompletion(UseBedRun run, long nowMs, String reason) {
        if (run == null || activeRun != run || ledger.isFinished(run.commandId)) {
            return;
        }
        ledger.markFailed(run.commandId, reason);
        activeRun = null;
        shell.logger().info(
            "use_bed.done instanceId={} commandId={} reason={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            reason,
            Math.max(0L, nowMs - run.startedAtMs)
        );
        shell.completeCurrentCommand(run.commandId, reason, nowMs);
    }

    private static void clearPendingInteraction(UseBedRun run) {
        if (run == null) {
            return;
        }
        run.pendingRequestId = "";
        run.pendingBed = null;
        run.pendingHit = null;
    }

    private static BlockPos findNearbyBedBlock(MinecraftClient client, ClientPlayerEntity player, int radius) {
        BlockPos base = player.getBlockPos();
        BlockPos best = null;
        double bestSq = Double.MAX_VALUE;
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dy = -2; dy <= 2; dy++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    BlockPos candidate = base.add(dx, dy, dz);
                    if (!(client.world.getBlockState(candidate).getBlock() instanceof BedBlock)) {
                        continue;
                    }
                    double d = candidate.getSquaredDistance(player.getPos());
                    if (d < bestSq) {
                        bestSq = d;
                        best = candidate.toImmutable();
                    }
                }
            }
        }
        return best;
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    private static final class UseBedRun {
        final String commandId;
        final long startedAtMs;
        long lastInteractMs = 0L;
        int interactionAttempt = 0;
        String pendingRequestId = "";
        BlockPos pendingBed = null;
        BlockHitResult pendingHit = null;

        UseBedRun(String commandId, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.startedAtMs = startedAtMs;
        }
    }
}
