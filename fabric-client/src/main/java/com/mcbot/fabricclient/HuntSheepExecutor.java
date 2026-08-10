package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BiPredicate;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.passive.SheepEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * {@code hunt_sheep} objective, lifted verbatim out of {@code McbotFabricClient}.
 *
 * <p>Fifth concrete {@link ObjectiveExecutor} of the strangler decomposition (leaf tier 2). HuntSheep
 * chases a sheep, lands legitimate melee swings (the attack core replicates the live-proven
 * CombatController gates — turn-rate-limited aim; swing only when aligned, line-of-sight clear, and the
 * cadence has elapsed), collects the wool/mutton drops, and completes on a wool delta of
 * {@code HUNT_SHEEP_TARGET_WOOL}. The control logic, the completion path, the {@code HUNT_*} constants,
 * and the three private helpers ({@code huntCollectDecision}, {@code nearestLiveSheep},
 * {@code hasClearEntityLine} — each HuntSheep's only caller) are moved here unchanged; the edits are
 * mechanical — source params become {@link TickContext} accessors, {@code activeHuntSheep} becomes
 * {@link #activeRun}, the {@code finishedHuntSheepCommandReasons} map becomes {@link #ledger} (Map-only
 * completion; no completed-set existed), instance-helper calls go through {@link ShellServices}, and
 * pure static helpers ({@code McbotFabricClient.roundForLog}/{@code wrapDegreesDelta},
 * {@code InventoryCounter.countPlayerWool}, {@code LookController.*}) are referenced directly.
 *
 * <p>The only caller of {@code resolveHuntSheepControl} was the {@code resolveControl} dispatch chain,
 * so no public {@code resolve(...)} entry is needed; the logic lives in {@link #tick(TickContext)}.
 *
 * <p>The reason strings ({@code hunt_sheep_complete:...}, {@code hunt_sheep_failed:...}) are a wire
 * contract read by the brain and are preserved exactly.
 */
public final class HuntSheepExecutor implements ObjectiveExecutor {

    // CP2 beds, slice 1: mission-driven sheep hunt — chase, legitimate melee, collect wool/mutton
    // drops, complete on a wool delta of HUNT_SHEEP_TARGET_WOOL. The attack core replicates the
    // live-proven CombatController gates verbatim (turn-rate-limited aim; swing only when aligned,
    // line-of-sight clear, and the human-plausible cadence has elapsed; real attackEntity + swing).
    private static final double HUNT_SHEEP_SCAN_RADIUS = 24.0D;
    private static final int HUNT_SHEEP_TARGET_WOOL = 3;
    private static final long HUNT_SHEEP_TIMEOUT_MS = 120_000L;
    private static final long HUNT_COLLECT_SETTLE_MS = 1_500L;
    private static final double HUNT_MELEE_REACH = 3.0D;
    private static final double HUNT_ATTACK_ALIGN_DEG = 12.0D;
    private static final long HUNT_ATTACK_INTERVAL_MS = 600L;
    private static final double HUNT_LOOK_MAX_DEG_PER_TICK = 9.0D;
    // Collect navigation for a hunt drop. Within HUNT_COLLECT_DIRECT_RADIUS the DIRECT close-in is
    // primary — hunt-6 found the routed nav's turn stage ORBITING close drops (forward held while
    // turn-rate-limited at ~4.2 deg/tick => turning radius ~2.9 blocks => an item inside that radius
    // is geometrically impossible to turn into; the bot circled the wool for 80 s). Orbit-breaker:
    // walk only when actually FACING the drop (yaw error <= 25 deg), else turn in place. Farther
    // drops use the routed nav; its latched terminal states skip the drop (null) instead of freezing.
    private static final double HUNT_COLLECT_DIRECT_RADIUS = 6.0D;

    private final ShellServices shell;
    private final FabricMotionMode motionMode;
    private final CommandLedger ledger = new CommandLedger();
    private HuntSheepRun activeRun = null;
    private PendingAttack pendingAttack;

    public HuntSheepExecutor(ShellServices shell) {
        this(shell, FabricMotionMode.LEGACY);
    }

    HuntSheepExecutor(ShellServices shell, FabricMotionMode motionMode) {
        this.shell = shell;
        this.motionMode = motionMode == null ? FabricMotionMode.LEGACY : motionMode;
    }

    @Override
    public boolean handles(String action) {
        return "hunt_sheep".equals(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        pendingAttack = null;
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
            activeRun = new HuntSheepRun(commandId, InventoryCounter.countPlayerWool(player), nowMs);
            shell.logger().info(
                "hunt_sheep.start instanceId={} commandId={} baselineWool={} target={}",
                shell.instanceId(),
                commandId,
                activeRun.baselineWool,
                HUNT_SHEEP_TARGET_WOOL
            );
        }
        HuntSheepRun run = activeRun;
        int woolDelta = InventoryCounter.countPlayerWool(player) - run.baselineWool;
        if (woolDelta >= HUNT_SHEEP_TARGET_WOOL) {
            return completeHuntSheep(effective, run, nowMs, "hunt_sheep_complete:woolDelta=" + woolDelta);
        }
        if (nowMs - run.startedAtMs > HUNT_SHEEP_TIMEOUT_MS) {
            return completeHuntSheep(effective, run, nowMs, "hunt_sheep_failed:timeout:woolDelta=" + woolDelta);
        }

        // Track the engaged target; when it dies its last position becomes a drop ANCHOR so the
        // wool is scooped before the next chase. Hunt-4 repro: 4 kills along a 60 s chase path,
        // 3 wool stranded — the 6-block drop scan around the PLAYER never saw them.
        BiPredicate<ItemStack, String> huntDropPredicate =
            (stack, itemId) -> itemId != null && (itemId.endsWith("_wool") || "mutton".equals(itemId));
        if (run.currentTargetId >= 0) {
            Entity tracked = client.world.getEntityById(run.currentTargetId);
            if (tracked instanceof SheepEntity trackedSheep && trackedSheep.isAlive()) {
                run.currentTargetLastPos = trackedSheep.getBlockPos();
            } else {
                if (run.currentTargetLastPos != null) {
                    run.pendingDropAnchors.add(run.currentTargetLastPos.toImmutable());
                    shell.logger().info(
                        "hunt_sheep.kill_anchor instanceId={} commandId={} anchor={} anchors={}",
                        shell.instanceId(),
                        commandId,
                        run.currentTargetLastPos.toShortString(),
                        run.pendingDropAnchors.size()
                    );
                }
                run.currentTargetId = -1;
                run.currentTargetLastPos = null;
            }
        }

        // 1) Collect from kill anchors first, then anything near the bot. Terminal nav states never
        // freeze the run (hunt-5: the LOCAL branch latched path_complete with the wool 1.6 blocks
        // away — outside the pickup magnet — and stared at it for 80 s): a reachable-but-"arrived"
        // drop gets a direct close-in walk; an unroutable one is skipped.
        while (!run.pendingDropAnchors.isEmpty()) {
            Vec3d anchorDrop = shell.nearestDroppedItemPosition(
                client, player, run.pendingDropAnchors.get(0), huntDropPredicate);
            if (anchorDrop == null) {
                run.pendingDropAnchors.remove(0);
                continue;
            }
            ControlDecision anchorDecision = huntCollectDecision(
                client,
                player,
                effective,
                anchorDrop,
                huntDropIdentity(client, anchorDrop, huntDropPredicate, commandId)
            );
            if (anchorDecision != null) {
                return anchorDecision;
            }
            run.pendingDropAnchors.remove(0);
        }
        Vec3d drop = shell.nearestDroppedItemPosition(client, player, player.getBlockPos(), huntDropPredicate);
        if (drop != null) {
            ControlDecision dropDecision = huntCollectDecision(
                client,
                player,
                effective,
                drop,
                huntDropIdentity(client, drop, huntDropPredicate, commandId)
            );
            if (dropDecision != null) {
                return dropDecision;
            }
            // Unreachable stray: leave it and keep hunting.
        }

        // 2) Acquire: stick to the engaged sheep while it lives (no mid-fight target swaps wasting
        // partial damage); otherwise the nearest live adult.
        SheepEntity sheep = null;
        if (run.currentTargetId >= 0) {
            Entity tracked = client.world.getEntityById(run.currentTargetId);
            if (tracked instanceof SheepEntity trackedSheep
                && trackedSheep.isAlive()
                && trackedSheep.squaredDistanceTo(player) <= HUNT_SHEEP_SCAN_RADIUS * HUNT_SHEEP_SCAN_RADIUS * 2.25D) {
                sheep = trackedSheep;
            }
        }
        if (sheep == null) {
            sheep = nearestLiveSheep(client, player, HUNT_SHEEP_SCAN_RADIUS);
        }
        if (sheep == null) {
            return completeHuntSheep(effective, run, nowMs, "hunt_sheep_failed:no_targets:woolDelta=" + woolDelta);
        }
        run.currentTargetId = sheep.getId();
        run.currentTargetLastPos = sheep.getBlockPos();

        // 3) Engage.
        Vec3d eye = player.getEyePos();
        Vec3d targetEye = sheep.getEyePos();
        double dx = targetEye.x - eye.x;
        double dy = targetEye.y - eye.y;
        double dz = targetEye.z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        double targetYaw = Math.toDegrees(Math.atan2(-dx, dz));
        double targetPitch = Math.toDegrees(Math.atan2(-dy, horizontal));
        LookController.Look look = LookController.nextLook(
            player.getYaw(), player.getPitch(), targetYaw, targetPitch, HUNT_LOOK_MAX_DEG_PER_TICK);
        LookDemand lookDemand = trackingLookDemand(
            LookDemand.Owner.HUNT,
            "sheep:" + sheep.getUuidAsString(),
            effective,
            targetYaw,
            targetPitch,
            "hunt_sheep_engage"
        );

        double distance = Math.sqrt(sheep.squaredDistanceTo(player));
        BrainLink.Intent chaseIntent = shell.lookIntentForAngles(effective, look.yaw(), look.pitch(), "hunt_sheep_engage");
        if (distance <= HUNT_MELEE_REACH) {
            boolean previewAligned = Math.abs(LookController.shortestYawDelta(look.yaw(), targetYaw)) <= HUNT_ATTACK_ALIGN_DEG
                && Math.abs(look.pitch() - targetPitch) <= HUNT_ATTACK_ALIGN_DEG;
            boolean appliedAligned = motionMode == FabricMotionMode.SMOOTH
                ? Math.abs(LookController.shortestYawDelta(player.getYaw(), targetYaw)) <= HUNT_ATTACK_ALIGN_DEG
                    && Math.abs(player.getPitch() - targetPitch) <= HUNT_ATTACK_ALIGN_DEG
                : previewAligned;
            if (appliedAligned
                && hasClearEntityLine(client, player, sheep)
                && nowMs - run.lastAttackMs >= HUNT_ATTACK_INTERVAL_MS) {
                String requestId = commandId
                    + ":hunt_sheep_attack:"
                    + run.attackRequestSequence
                    + ":"
                    + sheep.getUuidAsString();
                pendingAttack = new PendingAttack(
                    requestId,
                    sheep,
                    targetYaw,
                    targetPitch,
                    distance,
                    commandId
                );
                InteractionDemand attackDemand = InteractionDemand.attackEntity(
                    requestId,
                    LookDemand.Owner.HUNT,
                    commandId,
                    "hunt_sheep_engage_attack",
                    "sheep:" + sheep.getUuidAsString(),
                    "hunt_sheep_attack"
                );
                FabricInteractionAuthority.Payload attackPayload =
                    FabricInteractionAuthority.Payload.entity(
                        sheep,
                        Hand.MAIN_HAND,
                        new FabricInteractionAuthority.EntityGate(
                            HUNT_MELEE_REACH,
                            targetYaw,
                            targetPitch,
                            HUNT_ATTACK_ALIGN_DEG,
                            run.lastAttackMs + HUNT_ATTACK_INTERVAL_MS,
                            true
                        )
                    );
                return new ControlDecision(
                    chaseIntent,
                    InputState.stop(),
                    lookDemand,
                    null,
                    null,
                    attackDemand,
                    attackPayload
                );
            }
            return new ControlDecision(chaseIntent, InputState.stop(), lookDemand);
        }
        // Chase: forward toward the sheep (sprint rides the hunt_ reason allowlist — panicked sheep
        // outrun a walking player), edge-guarded so the chase can never run off a cliff; hop on bumps.
        double guardedYaw = motionMode == FabricMotionMode.SMOOTH ? player.getYaw() : look.yaw();
        boolean blocked = shell.edgeGuardBlocksForward(client, player, guardedYaw);
        boolean jump = !blocked && player.horizontalCollision;
        InputState chase = blocked
            ? InputState.stop()
            : new InputState(true, false, false, false, jump, false, 1.0F, 0.0F);
        return new ControlDecision(chaseIntent, chase, lookDemand);
    }

    void acknowledgeInteraction(InteractionAppliedReceipt receipt) {
        PendingAttack pending = pendingAttack;
        HuntSheepRun run = activeRun;
        if (pending == null
            || run == null
            || !pending.commandId().equals(run.commandId)
            || receipt == null
            || !receipt.applied()
            || receipt.action() != InteractionDemand.Action.ATTACK_ENTITY
            || !pending.requestId().equals(receipt.requestId())) {
            return;
        }
        pendingAttack = null;
        run.lastAttackMs = receipt.timestampMs();
        run.attackRequestSequence++;
        run.attacks++;
        shell.logger().info(
            "hunt_sheep.attack instanceId={} commandId={} dist={} attacks={}",
            shell.instanceId(),
            pending.commandId(),
            McbotFabricClient.roundForLog(pending.distance()),
            run.attacks
        );
    }

    private record PendingAttack(
        String requestId,
        SheepEntity target,
        double targetYaw,
        double targetPitch,
        double distance,
        String commandId
    ) {
    }

    private ControlDecision huntCollectDecision(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        Vec3d drop,
        String targetIdentity
    ) {
        double horizontal = Math.hypot(drop.x - player.getX(), drop.z - player.getZ());
        if (horizontal <= HUNT_COLLECT_DIRECT_RADIUS) {
            McbotFabricClient.LookAngles dropLook = shell.lookAnglesToPoint(player, drop);
            double yawError = Math.abs(McbotFabricClient.wrapDegreesDelta(dropLook.yaw() - player.getYaw()));
            boolean facing = yawError <= 25.0D;
            boolean blocked = facing && shell.edgeGuardBlocksForward(client, player, dropLook.yaw());
            InputState closeIn = facing && !blocked
                ? new InputState(true, false, false, false, false, false, 1.0F, 0.0F)
                : InputState.stop();
            return new ControlDecision(
                shell.lookIntentForAngles(effective, dropLook.yaw(), dropLook.pitch(), "hunt_sheep_collect_close"),
                closeIn,
                trackingLookDemand(
                    LookDemand.Owner.NORMAL,
                    targetIdentity,
                    effective,
                    dropLook.yaw(),
                    dropLook.pitch(),
                    "hunt_sheep_collect_close"
                )
            );
        }
        BrainLink.Intent collectIntent = shell.gatherCollectIntent(
            effective, drop.x, drop.y, drop.z, "hunt_sheep_collect_item", ":hunt:collect");
        ControlDecision nav = shell.resolveNavigationControl(client, player, collectIntent);
        String navReason = nav.intent() == null ? "" : nav.intent().reason();
        if (!"target_rejected_no_path".equals(navReason) && !"path_complete".equals(navReason)) {
            return nav;
        }
        return null;
    }

    private static LookDemand trackingLookDemand(
        LookDemand.Owner owner,
        String targetIdentity,
        BrainLink.Intent intent,
        double yaw,
        double pitch,
        String reason
    ) {
        String commandId = intent == null || intent.commandId() == null || intent.commandId().isBlank()
            ? "uncommanded"
            : intent.commandId();
        return new LookDemand(
            owner,
            targetIdentity,
            LookDemand.Profile.TRACKING,
            yaw,
            pitch,
            LookDemand.RetargetPolicy.CONTINUOUS,
            commandId,
            reason
        );
    }

    private static String huntDropIdentity(
        MinecraftClient client,
        Vec3d drop,
        BiPredicate<ItemStack, String> itemPredicate,
        String commandId
    ) {
        if (client.world != null && drop != null) {
            Box box = new Box(
                drop.x - 0.25D,
                drop.y - 0.25D,
                drop.z - 0.25D,
                drop.x + 0.25D,
                drop.y + 0.25D,
                drop.z + 0.25D
            );
            ItemEntity matched = null;
            double bestDistanceSquared = Double.POSITIVE_INFINITY;
            for (ItemEntity item : client.world.getEntitiesByClass(ItemEntity.class, box, ItemEntity::isAlive)) {
                ItemStack stack = item.getStack();
                if (stack == null || stack.isEmpty()) {
                    continue;
                }
                String itemId = net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
                if (!itemPredicate.test(stack, itemId)) {
                    continue;
                }
                double distanceSquared = item.getPos().squaredDistanceTo(drop);
                if (distanceSquared < bestDistanceSquared) {
                    bestDistanceSquared = distanceSquared;
                    matched = item;
                }
            }
            if (matched != null) {
                return "hunt-drop:" + matched.getUuidAsString();
            }
        }
        String stableCommand = commandId == null || commandId.isBlank() ? "uncommanded" : commandId;
        return "hunt-drop-command:" + stableCommand;
    }

    private ControlDecision completeHuntSheep(BrainLink.Intent effective, HuntSheepRun run, long nowMs, String reason) {
        ledger.markFailed(run.commandId, reason);
        activeRun = null;
        shell.logger().info(
            "hunt_sheep.done instanceId={} commandId={} reason={} attacks={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            reason,
            run.attacks,
            Math.max(0L, nowMs - run.startedAtMs)
        );
        shell.completeCurrentCommand(run.commandId, reason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, reason), InputState.stop());
    }

    private static SheepEntity nearestLiveSheep(MinecraftClient client, ClientPlayerEntity player, double radius) {
        double bestSq = radius * radius;
        SheepEntity best = null;
        for (Entity entity : client.world.getEntities()) {
            if (entity instanceof SheepEntity sheep && sheep.isAlive() && !sheep.isBaby()) {
                double d = sheep.squaredDistanceTo(player);
                if (d <= bestSq) {
                    bestSq = d;
                    best = sheep;
                }
            }
        }
        return best;
    }

    // Block-occlusion check for the swing: the eye ray to the target's eye must not hit terrain
    // closer than the target itself.
    private static boolean hasClearEntityLine(MinecraftClient client, ClientPlayerEntity player, Entity target) {
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            player.getEyePos(),
            target.getEyePos(),
            RaycastContext.ShapeType.COLLIDER,
            RaycastContext.FluidHandling.NONE,
            player
        ));
        return hit == null
            || hit.getType() != HitResult.Type.BLOCK
            || player.getEyePos().squaredDistanceTo(hit.getPos()) >= target.squaredDistanceTo(player);
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    private static final class HuntSheepRun {
        final String commandId;
        final int baselineWool;
        final long startedAtMs;
        long lastAttackMs = 0L;
        long attackRequestSequence = 0L;
        int attacks = 0;
        int currentTargetId = -1;
        BlockPos currentTargetLastPos = null;
        final List<BlockPos> pendingDropAnchors = new ArrayList<>();

        HuntSheepRun(String commandId, int baselineWool, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineWool = baselineWool;
            this.startedAtMs = startedAtMs;
        }
    }
}
