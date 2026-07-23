package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * {@code descend_staircase} objective ("Descent"), lifted verbatim out of {@code McbotFabricClient}.
 *
 * <p>Eighth concrete {@link ObjectiveExecutor} of the strangler decomposition. Descent drives the
 * battle-tested staircase machinery — step-by-step break/move, gap bridging (top/side/column-repair),
 * water sealing, hazard/lava reroutes, retry-heading rotation, overshot resync, and the per-leg iron
 * cleanup detour — down to a requested depth. The control logic, the bridge/seal placement flow, the
 * reroute machinery, and the {@code DescentRun} state are moved here unchanged; the edits are
 * mechanical — source params become the {@link #resolve} params, the {@code activeDescent} field
 * becomes {@link #activeRun}, the {@code finishedDescentCommandReasons} map becomes {@link #ledger},
 * the retry-rotate memory becomes the {@link #lastDescentFailurePos} / {@link #lastDescentFailureAtMs}
 * instance fields (they outlive a single run), instance-helper calls go through {@link ShellServices},
 * and pure static helpers / constants are referenced on {@link McbotFabricClient} directly.
 *
 * <p>{@code resolveDescendStaircaseControl} has four callers besides the dispatch chain (the
 * mine_nearby_stone descent-fallback, the R2/R5 mine-stone-return descend phases, and the gather_tree
 * cliff-locked search relocation), so the logic is exposed via the public {@link #resolve} entry and
 * {@link #tick(TickContext)} delegates to it; the shell rewires its internal callers to
 * {@code descentExecutor.resolve(client, player, subIntent, nowMs)}.
 *
 * <p>The completed-descent trail store ({@code completedDescentPaths} / {@code lastCompletedDescentPath})
 * stays shell-side (Return/R2/R5 read it); {@link #completeDescent} records into it through
 * {@link ShellServices#recordCompletedDescentPath}.
 *
 * <p>The reason strings ({@code descent_complete:...}, {@code descent_failed:...}, etc.) are a wire
 * contract read by the brain and are preserved exactly.
 */
public final class DescentExecutor implements ObjectiveExecutor {

    private final ShellServices shell;
    private final CommandLedger ledger = new CommandLedger();
    private DescentRun activeRun = null;

    // Descent retry-rotation: a follow-up descend near a recent failure takes a 90-degree
    // rotated heading instead of re-digging the same line into the same cavern. These outlive a single
    // run, so they are executor instance fields (not DescentRun fields).
    private BlockPos lastDescentFailurePos = null;
    private long lastDescentFailureAtMs = 0L;

    // Run-7 abort (descent_next_support_missing:no_safe_reroute at depth 20 with ZERO bridge
    // attempts) showed the bridge gate declining silently — every rejection now says which
    // predicate failed, throttled, only in the support-missing context that reaches these checks.
    private long nextBridgeGateLogMs = 0L;

    // Field-kit tool recovery tuning, mirroring the iron path's NEARBY_IRON_MAX_TOOL_RECOVERY_ATTEMPTS
    // and NEARBY_IRON_PICKAXE_RESTOCK_REMAINING (both private to McbotFabricClient, so re-declared here
    // with the SAME values). Bound the craft/place/retrieve loop and the proactive restock threshold.
    private static final int DESCENT_MAX_TOOL_RECOVERY_ATTEMPTS = 4;
    private static final int DESCENT_PICKAXE_RESTOCK_REMAINING = 32;

    // Controlled safe-fall: when the descent stalls over an open-air gap it can't bridge or reroute
    // around, drop straight down to a validated solid floor instead of refusing and thrashing. Two
    // tiers: a ZERO-damage drop (<= MAX_SAFE_DROP, the project-wide no-fall-damage cap), or, when no
    // zero-damage landing exists, a HEALTH-AWARE deeper drop that accepts survivable fall damage as long
    // as it leaves DESCENT_SAFE_FALL_HEALTH_MARGIN health after landing. The deeper drop's expected
    // damage is fed to the FAIL_HEALTH_LOST preflight as an allowed-drop tolerance so the deliberate
    // fall is not mistaken for a mob hit. DESCENT_MAX_HEALTH_FALL_BLOCKS bounds the scan and is the
    // deepest reachable drop at full health (3 free + (20 - margin) survivable-damage blocks).
    private static final int DESCENT_MAX_SAFE_FALL_BLOCKS = WalkabilityClassifier.MAX_SAFE_DROP;
    private static final float DESCENT_SAFE_FALL_HEALTH_MARGIN = 10.0F;
    private static final int DESCENT_MAX_HEALTH_FALL_BLOCKS = 13;
    // Time budget for a launched safe-fall to actually leave the ledge, fall, and re-anchor. While it is
    // in progress the descent holds (the stage machine is suppressed so it can't fail the run mid-fall);
    // if the bot is still wedged on the ledge past this, the hold releases and fails through to recovery.
    private static final long DESCENT_SAFE_FALL_TIMEOUT_MS = 3000L;

    // Mine-through-to-descend (a live run descent_recovery_exhausted family): when an open-air stall has
    // no bridge, no sideways reroute, and no validated safe-fall landing, carve LEVEL tunnel steps
    // into the most-solid heading until the normal down-step turns safe again, instead of failing
    // the run at the cavern rim. The block budget bounds total carved cells per run; each carved
    // cell also earns one step's worth of extra preflight timeout, since tunnel work is real
    // progress the depth-based budget can't see. The probe depth is how far ahead the heading
    // scorer samples floor continuity and wall solidity.
    private static final int DESCENT_TUNNEL_MAX_BLOCKS = 24;
    private static final int DESCENT_TUNNEL_PROBE_CELLS = 4;

    /** A validated controlled-safe-fall target: the landing feet cell and the true vertical drop. */
    private record SafeFall(BlockPos landingFeet, int fallBlocks) {
    }

    public DescentExecutor(ShellServices shell) {
        this.shell = shell;
    }

    @Override
    public boolean handles(String action) {
        return "descend_staircase".equals(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        return resolve(ctx.client(), ctx.player(), ctx.intent(), ctx.nowMs());
    }

    private DescentControlPlanner.State descentControlState(DescentRun run) {
        return new DescentControlPlanner.State(run.stepIndex, run.depthReached, run.stage);
    }

    private void applyDescentControlDecision(DescentRun run, DescentControlPlanner.Decision decision) {
        run.stepIndex = decision.state().stepIndex();
        run.depthReached = decision.state().depthReached();
        run.stage = decision.state().stage();
    }

    public ControlDecision resolve(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = ledger.reason(commandId);
        if (finishedReason != null) {
            return new ControlDecision(shell.stopFrom(effective, finishedReason), InputState.stop());
        }
        shell.clearNavigationState();

        if (activeRun == null || !commandId.equals(activeRun.commandId)) {
            BlockPos startFeet = player.getBlockPos().toImmutable();
            int requestedDepth = McbotFabricClient.resolveDescentDepth(effective, startFeet.getY());
            StaircaseDescentPlanner.Direction2d direction = McbotFabricClient.resolveDescentDirection(effective, startFeet, player.getYaw());
            // Repro (seen twice live): a retry descent started one block from the
            // previous no_safe_reroute failure and dug straight back into the same cavern. Near a
            // recent failure, rotate the heading 90 degrees so the new staircase takes a different
            // line; full multi-block cavern scaffolding remains the queued real fix.
            if (lastDescentFailurePos != null
                && nowMs - lastDescentFailureAtMs < McbotFabricClient.DESCENT_RETRY_ROTATE_WINDOW_MS
                && startFeet.getSquaredDistance(lastDescentFailurePos) <= McbotFabricClient.DESCENT_RETRY_ROTATE_RADIUS_SQ) {
                StaircaseDescentPlanner.Direction2d rotated = McbotFabricClient.rotateDescentDirection(direction);
                shell.logger().info(
                    "descent.retry_heading_rotated instanceId={} commandId={} from={} to={} failurePos={}",
                    shell.instanceId(),
                    commandId,
                    direction.name(),
                    rotated.name(),
                    lastDescentFailurePos.toShortString()
                );
                direction = rotated;
            }
            activeRun = new DescentRun(commandId, startFeet, direction, requestedDepth, nowMs, player.getHealth());
            shell.logger().info(
                "descent.start instanceId={} commandId={} start={} direction={} depth={} healthBefore={} targetY={}",
                shell.instanceId(),
                commandId,
                startFeet.toShortString(),
                direction.name(),
                requestedDepth,
                player.getHealth(),
                startFeet.getY() - requestedDepth
            );
        }

        DescentRun run = activeRun;
        long elapsedMs = Math.max(0L, nowMs - run.startedAtMs);
        String currentHazardReason = currentPlayerDescentHazardReason(client, player);
        boolean onGround = player.isOnGround();
        DescentControlPlanner.Decision preflightDecision = DescentControlPlanner.decidePreflight(
            descentControlState(run),
            new DescentControlPlanner.PreflightObservation(
                elapsedMs,
                McbotFabricClient.DESCENT_BASE_TIMEOUT_MS
                    + (long) (run.depth + run.tunnelBlocksUsed) * McbotFabricClient.DESCENT_STEP_TIMEOUT_MS,
                run.healthBefore,
                player.getHealth(),
                currentHazardReason,
                onGround,
                onGround ? nearestHostileDistance(client, player) : -1.0D,
                McbotFabricClient.DESCENT_HOSTILE_ABORT_RADIUS,
                // Tolerate the committed safe-fall's expected fall damage (0 until a health-aware fall is
                // launched) so the deliberate drop is not read as a mob hit / lava tick by FAIL_HEALTH_LOST.
                run.safeFallExpectedDamage
            )
        );
        if (preflightDecision.action() == DescentControlPlanner.Action.FAIL_TIMEOUT
            || preflightDecision.action() == DescentControlPlanner.Action.FAIL_HEALTH_LOST
            || preflightDecision.action() == DescentControlPlanner.Action.FAIL_PLAYER_HAZARD
            || preflightDecision.action() == DescentControlPlanner.Action.FAIL_HOSTILE_NEARBY) {
            return failDescent(effective, run, nowMs, preflightDecision.reason());
        }
        if (preflightDecision.action() == DescentControlPlanner.Action.WAIT_ON_GROUND) {
            return new ControlDecision(shell.stopFrom(effective, preflightDecision.reason()), InputState.stop());
        }
        // Controlled safe-fall in progress (safeFallLandingFeet latched). Own the full launch->land
        // lifecycle here, BEFORE the stage machine, so a step re-eval can never fail the run mid-fall: the
        // one-fall latch would refuse a re-attempt, and the old flow let the stage machine abort the
        // descent while the bot was still slewing toward the ledge (the descent_next_support_missing
        // race). The airborne phase is handled by WAIT_ON_GROUND above, so this runs only on the ground --
        // either landed (re-anchor + release) or still on the ledge (hold: aim, and nudge off only once
        // facing the drop column, bounded by DESCENT_SAFE_FALL_TIMEOUT_MS).
        if (run.safeFallLandingFeet != null && run.safeFallColumn != null && player.isOnGround()) {
            BlockPos feet = player.getBlockPos().toImmutable();
            boolean landed = feet.getY() <= run.safeFallLandingFeet.getY()
                && shell.isStableDescentSupport(client, feet.down());
            boolean timedOut = nowMs - run.safeFallLaunchedAtMs > DESCENT_SAFE_FALL_TIMEOUT_MS;
            McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, Vec3d.ofCenter(run.safeFallColumn));
            double yawError = LookController.normalizeYaw(look.yaw() - player.getYaw());
            boolean facingColumn = !DescentControlPlanner.shouldHoldMoveForYaw(
                yawError, McbotFabricClient.DESCENT_MOVE_YAW_TOLERANCE_DEG);
            SafeFallPlanner.SafeFallProgress progress =
                SafeFallPlanner.safeFallInProgressDecision(landed, timedOut, facingColumn);
            if (progress == SafeFallPlanner.SafeFallProgress.REANCHOR) {
                BlockPos previousFeet = run.currentFeet;
                BlockPos landedAt = run.safeFallLandingFeet;
                int depthDelta = reanchorDescentToFeet(run, feet, nowMs);
                run.safeFallColumn = null;
                run.safeFallLandingFeet = null;
                shell.logger().warn(
                    "descent.safe_fall_landed instanceId={} commandId={} previousFeet={} plannedLandingFeet={} actualFeet={} depthDelta={} depthReached={} step={} elapsedMs={}",
                    shell.instanceId(),
                    run.commandId,
                    previousFeet.toShortString(),
                    landedAt.toShortString(),
                    feet.toShortString(),
                    depthDelta,
                    run.depthReached,
                    run.stepIndex,
                    Math.max(0L, nowMs - run.startedAtMs)
                );
                return new ControlDecision(shell.stopFrom(effective, "descent_safe_fall_landed"), InputState.stop());
            }
            if (progress == SafeFallPlanner.SafeFallProgress.TIMEOUT_FAIL) {
                shell.logger().warn(
                    "descent.safe_fall_timeout instanceId={} commandId={} column={} landing={} feet={} elapsedMs={}",
                    shell.instanceId(),
                    run.commandId,
                    run.safeFallColumn.toShortString(),
                    run.safeFallLandingFeet.toShortString(),
                    feet.toShortString(),
                    nowMs - run.safeFallLaunchedAtMs
                );
                run.safeFallColumn = null;
                run.safeFallLandingFeet = null;
                return failDescent(effective, run, nowMs, "descent_safe_fall_timeout");
            }
            // NUDGE_OFF_LEDGE / HOLD_AIM: aim at the drop column; walk forward off the ledge only once
            // facing it. Always return here -- never fall through to the stage machine while mid-fall.
            BrainLink.Intent intent = shell.lookIntentForAngles(
                effective, look.yaw(), look.pitch(), "descent_safe_fall_hold");
            InputState input = progress == SafeFallPlanner.SafeFallProgress.NUDGE_OFF_LEDGE
                ? new InputState(true, false, false, false, false, false, 1.0F, 0.0F)
                : InputState.stop();
            return new ControlDecision(intent, input);
        }
        // Field-kit tool recovery: when a stone-pickaxe runs out mid-descent, break the staircase path
        // (breakDescentBlock) latches recovery instead of aborting; this drives place/craft of a fresh
        // pickaxe before the stage machinery runs again. The proactive trigger restocks a worn pickaxe
        // BEFORE it breaks. Mirrors the iron dispatch at the head of the ore-mining tick.
        if (run.descentFieldKitRecoveryActive || run.descentFieldKitRetrieveTablePending) {
            ControlDecision rec = resolveDescentToolRecovery(client, player, effective, run, nowMs, false);
            if (rec != null) {
                return rec;
            }
        }
        ControlDecision proactiveRec = maybeResolveProactiveDescentToolRecovery(client, player, effective, run, nowMs);
        if (proactiveRec != null) {
            return proactiveRec;
        }
        ControlDecision ironCleanupDecision = maybeResolveDescentIronCleanup(client, player, effective, run, nowMs);
        if (ironCleanupDecision != null) {
            DescentControlPlanner.Decision stepDecision = DescentControlPlanner.decideStep(
                descentControlState(run),
                new DescentControlPlanner.StepObservation(true, false, false, false, false, null, false, false, false, false, false)
            );
            if (stepDecision.action() == DescentControlPlanner.Action.RUN_IRON_CLEANUP) {
                return ironCleanupDecision;
            }
        }

        boolean complete = descentComplete(client, player, run);
        StaircaseDescentPlanner.Step step = complete ? null : StaircaseDescentPlanner.stepFrom(run.currentFeet, run.direction, run.stepIndex);
        boolean levelStep = false;
        // Mine-through tunnel mode: each step boundary first re-probes the normal down-step and
        // resumes descending the moment it is safe, so tunnel segments are self-terminating and
        // minimal. While blocked (and under budget) the active step is the LEVEL tunnel cell.
        if (step != null && run.tunnelMode) {
            boolean downStepSafe = !StaircaseDescentPlanner.targetsSelfSupport(step)
                && descentStepUnsafeReason(client, step) == null;
            if (downStepSafe || run.tunnelBlocksUsed >= DESCENT_TUNNEL_MAX_BLOCKS) {
                run.tunnelMode = false;
                run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
                clearDescentMoveProgress(run);
                shell.logger().info(
                    "descent.mine_through_exit instanceId={} commandId={} step={} feet={} direction={} tunnelBlocksUsed={} tunnelSegments={} resume={}",
                    shell.instanceId(),
                    run.commandId,
                    run.stepIndex,
                    run.currentFeet.toShortString(),
                    run.direction.name(),
                    run.tunnelBlocksUsed,
                    run.tunnelSegments,
                    downStepSafe ? "descend" : "budget_exhausted"
                );
            } else {
                step = StaircaseDescentPlanner.levelStepFrom(run.currentFeet, run.direction, run.stepIndex);
                levelStep = true;
            }
        }
        ControlDecision clearanceRecovery = maybeResolveDescentClearanceRecovery(
            client,
            player,
            effective,
            run,
            step,
            nowMs
        );
        if (clearanceRecovery != null) {
            return clearanceRecovery;
        }
        boolean reachedStep = step != null && reachedDescentStep(player, step.nextFeet());
        String unsafeReason = step == null || reachedStep ? null : descentStepUnsafeReason(client, step);
        boolean moveStalled = step != null
            && !reachedStep
            && run.stage == DescentControlPlanner.Stage.MOVE_TO_STEP
            && descentMoveStalled(player, run, step, nowMs);
        DescentControlPlanner.Decision stepDecision = DescentControlPlanner.decideStep(
            descentControlState(run),
            new DescentControlPlanner.StepObservation(
                false,
                complete,
                step != null && StaircaseDescentPlanner.targetsSelfSupport(step),
                step != null && player.getY() < step.nextFeet().getY() - 0.25D,
                reachedStep,
                unsafeReason,
                step != null && unsafeReason == null && client.world.getBlockState(step.sightClear()).isAir(),
                step != null && unsafeReason == null && client.world.getBlockState(step.upperClear()).isAir(),
                step != null && unsafeReason == null && client.world.getBlockState(step.lowerClear()).isAir(),
                moveStalled,
                canBridgeDescentSupport(client, player, run, step, unsafeReason),
                levelStep
            )
        );
        if (stepDecision.action() == DescentControlPlanner.Action.COMPLETE) {
            return completeDescent(effective, run, player, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.FAIL_SELF_SUPPORT) {
            return failDescent(effective, run, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.FAIL_OVERSHOT_STEP) {
            ControlDecision resync = maybeResyncDescentOvershot(client, player, effective, run, step, nowMs);
            if (resync != null) {
                return resync;
            }
            return failDescent(effective, run, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.STEP_REACHED) {
            if (levelStep) {
                run.tunnelBlocksUsed++;
            }
            shell.logger().info(
                "descent.step_reached instanceId={} commandId={} step={} position={} health={} level={} tunnelBlocksUsed={}",
                shell.instanceId(),
                run.commandId,
                run.stepIndex,
                player.getBlockPos().toShortString(),
                player.getHealth(),
                levelStep,
                run.tunnelBlocksUsed
            );
            BlockPos reached = step.nextFeet().toImmutable();
            run.currentFeet = reached;
            run.reachedFeet.add(reached);
            clearDescentMoveProgress(run);
            applyDescentControlDecision(run, stepDecision);
            return new ControlDecision(shell.stopFrom(effective, "descent_step_reached"), InputState.stop());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.PLACE_SUPPORT) {
            return placeDescentSupport(client, player, effective, run, step, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.REROUTE_OR_FAIL) {
            return rerouteOrFailDescent(effective, client, player, run, step, nowMs, stepDecision.reason());
        }

        applyDescentControlDecision(run, stepDecision);
        if (stepDecision.action() == DescentControlPlanner.Action.BREAK_SIGHT) {
            return breakDescentBlock(client, player, effective, run, step, step.sightClear(), "sight", nowMs);
        }
        if (stepDecision.action() == DescentControlPlanner.Action.BREAK_UPPER) {
            return breakDescentBlock(client, player, effective, run, step, step.upperClear(), "upper", nowMs);
        }
        if (stepDecision.action() == DescentControlPlanner.Action.BREAK_LOWER) {
            return breakDescentBlock(client, player, effective, run, step, step.lowerClear(), "lower", nowMs);
        }
        return moveToDescentStep(player, effective, run, step);
    }

    private ControlDecision maybeResolveDescentIronCleanup(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs
    ) {
        InventoryCounter.InventoryItemSnapshot rawIronInventory = InventoryCounter.countPlayerItem(player, "raw_iron");
        InventoryCounter.InventoryItemSnapshot ironIngotsInventory = InventoryCounter.countPlayerItem(player, "iron_ingot");
        InventoryCounter.InventoryItemSnapshot ironPickaxesInventory = InventoryCounter.countPlayerItem(player, "iron_pickaxe");
        int availableIronUnits = rawIronInventory.itemCount()
            + ironIngotsInventory.itemCount()
            + (ironPickaxesInventory.itemCount() * 3);
        if (availableIronUnits >= McbotFabricClient.descentIronCleanupTargetUnits(McbotFabricClient.isMissionCommandId(run.commandId))) {
            if (run.ironCleanupTarget != null || run.ironCleanupCollectStartedAtMs > 0L || run.ironCleanupBlocksBroken > 0) {
                shell.logger().info(
                    "descent.iron_cleanup_satisfied instanceId={} commandId={} availableIronUnits={} rawIron={} ironIngots={} ironPickaxes={} blocksBroken={}",
                    shell.instanceId(),
                    run.commandId,
                    availableIronUnits,
                    rawIronInventory.itemCount(),
                    ironIngotsInventory.itemCount(),
                    ironPickaxesInventory.itemCount(),
                    run.ironCleanupBlocksBroken
                );
            }
            run.ironCleanupTarget = null;
            run.lastIronCleanupTarget = null;
            run.ironCleanupCollectStartedAtMs = 0L;
            return null;
        }

        if (run.ironCleanupCollectStartedAtMs > 0L) {
            if (nowMs - run.ironCleanupCollectStartedAtMs < McbotFabricClient.GATHER_PICKUP_SETTLE_MS) {
                return new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_wait_pickup"), InputState.stop());
            }
            Vec3d droppedRawIron = shell.nearestDroppedItemPosition(
                client,
                player,
                run.lastIronCleanupTarget == null ? player.getBlockPos() : run.lastIronCleanupTarget,
                (stack, itemId) -> "raw_iron".equalsIgnoreCase(itemId) || "coal".equalsIgnoreCase(itemId)
            );
            if (droppedRawIron != null && nowMs - run.ironCleanupCollectStartedAtMs < McbotFabricClient.DESCENT_IRON_CLEANUP_COLLECT_TIMEOUT_MS) {
                shell.logger().info(
                    "descent.iron_cleanup_collect_target instanceId={} commandId={} itemX={} itemY={} itemZ={}",
                    shell.instanceId(),
                    run.commandId,
                    McbotFabricClient.roundForLog(droppedRawIron.x),
                    McbotFabricClient.roundForLog(droppedRawIron.y),
                    McbotFabricClient.roundForLog(droppedRawIron.z)
                );
                BrainLink.Intent collectIntent = shell.gatherCollectIntent(
                    effective,
                    droppedRawIron.x,
                    droppedRawIron.y,
                    droppedRawIron.z,
                    "descent_iron_cleanup_collect_item",
                    ":descent:iron:collect"
                );
                return shell.resolveNavigationControl(client, player, collectIntent);
            }
            run.ironCleanupCollectStartedAtMs = 0L;
            run.lastIronCleanupTarget = null;
            return new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_collect_done"), InputState.stop());
        }

        if (run.ironCleanupTarget == null && run.ironCleanupBlocksBroken < McbotFabricClient.DESCENT_MAX_IRON_CLEANUP_BLOCKS) {
            run.ironCleanupTarget = selectVisibleDescentIronCleanupTarget(client, player, run);
            if (run.ironCleanupTarget != null) {
                shell.logger().info(
                    "descent.iron_cleanup_target instanceId={} commandId={} target={} blocksBroken={} depthReached={} block={}",
                    shell.instanceId(),
                    run.commandId,
                    run.ironCleanupTarget.toShortString(),
                    run.ironCleanupBlocksBroken,
                    run.depthReached,
                    shell.blockId(client.world.getBlockState(run.ironCleanupTarget))
                );
            }
        }
        if (run.ironCleanupTarget == null) {
            return null;
        }

        BlockPos target = run.ironCleanupTarget;
        BlockState targetState = client.world.getBlockState(target);
        if (!shell.isIronOreBlock(targetState)) {
            run.ironCleanupTarget = null;
            return new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_target_cleared"), InputState.stop());
        }
        int pickaxeSlot = shell.findIronHarvestPickaxeHotbarSlot(player);
        if (pickaxeSlot < 0) {
            run.ironCleanupTarget = null;
            run.ironCleanupBlocksBroken = McbotFabricClient.DESCENT_MAX_IRON_CLEANUP_BLOCKS;
            shell.logger().warn(
                "descent.iron_cleanup_skip instanceId={} commandId={} reason=no_stone_or_better_pickaxe_hotbar target={} selectedItem={}",
                shell.instanceId(),
                run.commandId,
                target.toShortString(),
                shell.selectedItemId(player)
            );
            return new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_skip_no_stone_or_better_pickaxe"), InputState.stop());
        }
        if (player.getInventory().selectedSlot != pickaxeSlot) {
            player.getInventory().selectedSlot = pickaxeSlot;
            shell.logger().info(
                "descent.iron_cleanup_tool_selected instanceId={} commandId={} target={} hotbarSlot={} selectedItem={}",
                shell.instanceId(),
                run.commandId,
                target.toShortString(),
                pickaxeSlot,
                shell.selectedItemId(player)
            );
            return new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_select_tool"), InputState.stop());
        }
        if (!shell.isLookingAtBlock(player, target)) {
            return new ControlDecision(shell.lookIntentForBlock(effective, player, target, "descent_iron_cleanup_face"), InputState.stop());
        }
        // breakTerrainOccluders: ore embedded in a wall is mined THROUGH the plain stone/dirt in front
        // of it instead of reposition-cycling when the eye-ray clips the occluding edge.
        BlockBreakController.Result result = shell.blockBreakController().tick(
            client, player, target, run.commandId + ":descent:iron_cleanup", nowMs, false, 0L, true);
        shell.logBlockBreakResult(run.commandId + ":descent:iron_cleanup", target, result);
        shell.logger().info(
            "descent.iron_cleanup_progress instanceId={} commandId={} target={} status={} reason={} hitBlock={} actedBlock={} selectedItem={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            target.toShortString(),
            result.status(),
            result.reason(),
            McbotFabricClient.formatBlockPos(result.hitBlock()),
            McbotFabricClient.formatBlockPos(result.actedBlock()),
            shell.selectedItemId(player),
            result.elapsedMs()
        );
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.ironCleanupBlocksBroken++;
            run.lastIronCleanupTarget = target;
            run.ironCleanupTarget = null;
            run.ironCleanupCollectStartedAtMs = nowMs;
            return new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_break_done"), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION || result.status() == BlockBreakController.Status.FAILED) {
            run.abandonedIronCleanupTargets.add(target);
            run.ironCleanupTarget = null;
            return new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_reselect:" + result.reason()), InputState.stop());
        }
        return new ControlDecision(shell.lookIntentForBlock(effective, player, target, "descent_iron_cleanup_breaking:" + result.reason()), InputState.stop());
    }

    private BlockPos selectVisibleDescentIronCleanupTarget(MinecraftClient client, ClientPlayerEntity player, DescentRun run) {
        Set<BlockPos> excluded = new HashSet<>(run.abandonedIronCleanupTargets);
        while (excluded.size() < run.abandonedIronCleanupTargets.size() + 32) {
            BlockPos candidate = shell.selectVisibleIronTarget(client, player, excluded);
            if (candidate == null) {
                break;
            }
            if (isSafeDescentIronCleanupTarget(client, player, run, candidate)) {
                return candidate;
            }
            excluded.add(candidate);
        }
        // Coal rider REVERTED (observed pathology: 9198 target selections in 13 min —
        // cleanup satisfaction is IRON-unit keyed, so coal banking never satisfied it and the
        // descent starved until the mission aborted). The fuel fix needs its own completion
        // semantics (banked-coal target with a dedicated satisfied gate) — daytime redesign; the
        // coal-drop pickup in the collect predicate stays, and selectVisibleCoalTarget/
        // isCoalOreBlock remain for that redesign.
        return null;
    }

    private boolean isSafeDescentIronCleanupTarget(MinecraftClient client, ClientPlayerEntity player, DescentRun run, BlockPos candidate) {
        if (client == null || client.world == null || player == null || run == null || candidate == null) {
            return false;
        }
        BlockPos feet = player.getBlockPos();
        if (candidate.getY() < feet.getY()) {
            return false;
        }
        if (candidate.equals(feet) || candidate.equals(feet.up()) || candidate.equals(feet.down())) {
            return false;
        }
        if (candidate.equals(run.currentFeet.down())) {
            return false;
        }
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(run.currentFeet, run.direction, run.stepIndex);
        if (candidate.equals(step.support())) {
            return false;
        }
        return shell.firstAdjacentLavaBlock(client, candidate) == null;
    }

    private ControlDecision breakDescentBlock(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        BlockPos target,
        String phase,
        long nowMs
    ) {
        BlockState targetState = client.world.getBlockState(target);

        ToolSelectionPlanner.Decision targetToolDecision = ToolSelectionPlanner.decideForBlockId(shell.blockId(targetState));
        if (targetToolDecision.requirement() == ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED) {
            int pickaxeSlot = shell.findStoneMiningPickaxeHotbarSlot(player);
            if (pickaxeSlot < 0) {
                // GUI crafting can leave every pickaxe in MAIN inventory; the hotbar-only tool search
                // then aborted the whole descent with tool_unavailable (repro:
                // 2 stone pickaxes crafted, selectedItem=empty at step 1). Pull one into the hotbar
                // exactly like the bridge-filler flow does, then retry next tick; if the inventory
                // truly has no pickaxe, fall through to the existing tool_unavailable failure.
                int hotbarMove = shell.moveStoneMiningPickaxeToHotbar(client, player, run.commandId, "descent_break_tool");
                if (hotbarMove >= 0 || hotbarMove == -2) {
                    return new ControlDecision(shell.stopFrom(effective, "descent_break_tool_hotbar_move:" + phase), InputState.stop());
                }
                // No usable stone pickaxe anywhere in the inventory. Rather than aborting the mission with
                // tool_unavailable, latch the field-kit recovery (place a table / craft a stone pickaxe /
                // retrieve the table) the way the iron path does; the next tick drives it via the dispatch.
                // The backstop: if recovery has already run and STILL no pickaxe, let the original
                // tool_unavailable failure below stand.
                if (!run.descentFieldKitRecoveryActive) {
                    applyDescentFieldKitDecision(run, FieldKitRecoveryPlanner.activate(descentFieldKitState(run)));
                    shell.logger().info(
                        "descent.tool_recovery_activated instanceId={} commandId={} phase={} block={}",
                        shell.instanceId(),
                        run.commandId,
                        phase,
                        shell.blockId(targetState)
                    );
                    return new ControlDecision(shell.stopFrom(effective, "descent_tool_recovery_activated:" + phase), InputState.stop());
                }
            }
            if (pickaxeSlot >= 0 && player.getInventory().selectedSlot != pickaxeSlot) {
                player.getInventory().selectedSlot = pickaxeSlot;
                shell.logger().info(
                    "descent.tool_selected instanceId={} commandId={} step={} phase={} hotbarSlot={} selectedItem={}",
                    shell.instanceId(),
                    run.commandId,
                    step.index(),
                    phase,
                    pickaxeSlot,
                    shell.selectedItemId(player)
                );
                return new ControlDecision(shell.stopFrom(effective, "descent_select_tool:" + phase), InputState.stop());
            }
        }

        if (!shell.isLookingAtBlock(player, target)) {
            return new ControlDecision(shell.lookIntentForBlock(effective, player, target, "descent_face_" + phase), InputState.stop());
        }
        BlockBreakController.Result result = shell.blockBreakController().tick(client, player, target, run.commandId + ":step:" + step.index() + ":" + phase, nowMs);
        shell.logBlockBreakResult(run.commandId + ":descent:" + step.index() + ":" + phase, target, result);
        shell.logger().info(
            "descent.break_progress instanceId={} commandId={} step={} phase={} target={} targetBlock={} selectedItem={} status={} reason={} hitBlock={} hitBlockId={} actedBlock={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            step.index(),
            phase,
            target.toShortString(),
            shell.blockId(targetState),
            shell.selectedItemId(player),
            result.status(),
            result.reason(),
            McbotFabricClient.formatBlockPos(result.hitBlock()),
            result.hitBlock() == null ? "" : shell.blockId(client.world.getBlockState(result.hitBlock())),
            McbotFabricClient.formatBlockPos(result.actedBlock()),
            result.elapsedMs()
        );
        if (result.status() == BlockBreakController.Status.BROKEN) {
            clearMatchingDescentClearanceRecovery(run, target);
            run.stage = switch (phase) {
                case "sight" -> DescentControlPlanner.Stage.BREAK_UPPER;
                case "upper" -> DescentControlPlanner.Stage.BREAK_LOWER;
                default -> DescentControlPlanner.Stage.MOVE_TO_STEP;
            };
            return new ControlDecision(shell.stopFrom(effective, "descent_break_done:" + phase), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            String hazardReason = descentBreakHazardReason(client, player, target, result.reason());
            if (hazardReason == null && result.hitBlock() != null) {
                hazardReason = descentBreakHazardReason(client, player, result.hitBlock(), result.reason());
            }
            if (hazardReason != null) {
                return failDescent(effective, run, nowMs, hazardReason);
            }
            String recoveryPhase = McbotFabricClient.descentRecoveryPhaseForOccludingClearance(step, phase, result.hitBlock(), result.reason());
            if (recoveryPhase != null) {
                run.recoveryClearTarget = descentTargetForPhase(step, recoveryPhase);
                run.recoveryClearPhase = recoveryPhase;
                run.stage = descentStageForPhase(recoveryPhase);
                shell.logger().warn(
                    "descent.clearance_recovery instanceId={} commandId={} step={} phase={} target={} hitBlock={} recoveryPhase={} recoveryTarget={} reason={}",
                    shell.instanceId(),
                    run.commandId,
                    step.index(),
                    phase,
                    target.toShortString(),
                    McbotFabricClient.formatBlockPos(result.hitBlock()),
                    recoveryPhase,
                    McbotFabricClient.formatBlockPos(run.recoveryClearTarget),
                    result.reason()
                );
                return new ControlDecision(shell.stopFrom(effective, "descent_clearance_recovery:" + phase + ":" + recoveryPhase), InputState.stop());
            }
            if (McbotFabricClient.shouldRerouteDescentBreakReposition(result.reason(), recoveryPhase)) {
                return rerouteOrFailDescent(effective, client, player, run, step, nowMs, "descent_break_reposition:" + result.reason());
            }
            return failDescent(effective, run, nowMs, "descent_break_reposition:" + result.reason());
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            return failDescent(effective, run, nowMs, "descent_break_failed:" + result.reason());
        }
        return new ControlDecision(shell.lookIntentForBlock(effective, player, target, "descent_breaking_" + phase + ":" + result.reason()), InputState.stop());
    }

    // === Field-kit tool recovery (ported from McbotFabricClient.resolveMineNearbyIronToolRecovery /
    // maybeResolveProactiveMineNearbyIronToolRecovery). Descent needs a stone-tier pickaxe; when it has
    // none usable but carries cobblestone+sticks/planks, place/craft a replacement instead of aborting.
    // Simplifications vs. iron: (S1) no hotbar-move block — breakDescentBlock already pulls a freshly
    // crafted pickaxe into the hotbar on the next tick; (S2) no alcove — alcoveKnown/nearbyTableIsRecovery
    // Alcove are always false and explicitSupport is always null; (S3) no iron-vs-stone tier split. ===

    FieldKitRecoveryPlanner.State descentFieldKitState(DescentRun run) {
        return new FieldKitRecoveryPlanner.State(
            run.descentFieldKitRecoveryActive,
            run.descentFieldKitRetrieveTablePending,
            run.descentFieldKitTablePlacedByRecovery,
            false,
            run.descentProactiveToolRecoveryLogged,
            run.descentToolRecoveryAttempts
        );
    }

    FieldKitRecoveryPlanner.Decision applyDescentFieldKitDecision(DescentRun run, FieldKitRecoveryPlanner.Decision decision) {
        FieldKitRecoveryPlanner.State state = decision.state();
        run.descentFieldKitRecoveryActive = state.active();
        run.descentFieldKitRetrieveTablePending = state.retrieveTablePending();
        run.descentFieldKitTablePlacedByRecovery = state.tablePlacedByRecovery();
        run.descentProactiveToolRecoveryLogged = state.proactiveLogged();
        run.descentToolRecoveryAttempts = state.attempts();
        return decision;
    }

    private ControlDecision resolveDescentToolRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs,
        boolean proactive
    ) {
        FieldKitRecoveryPlanner.Decision tickDecision = applyDescentFieldKitDecision(run,
            FieldKitRecoveryPlanner.tick(descentFieldKitState(run), DESCENT_MAX_TOOL_RECOVERY_ATTEMPTS));
        if (tickDecision.action() == FieldKitRecoveryPlanner.Action.RECOVERY_LIMIT_REACHED) {
            return failDescent(effective, run, nowMs, "descent_tool_recovery_limit");
        }

        if (tickDecision.action() == FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE) {
            String retrieveCommandId = run.toolRetrieveTableCommandId();
            ControlDecision retrieveDecision = shell.resolveRecoveryRetrieveTable(
                client,
                player,
                shell.makeSubIntent(effective, "retrieve_table", retrieveCommandId, "descent_retrieve_table"),
                nowMs
            );
            String reason = retrieveDecision.intent() == null ? "" : retrieveDecision.intent().reason();
            FieldKitRecoveryPlanner.Decision retrieveTransition = applyDescentFieldKitDecision(run,
                FieldKitRecoveryPlanner.afterRetrieve(descentFieldKitState(run), reason));
            if (retrieveTransition.action() == FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE_FAILED) {
                return failDescent(effective, run, nowMs, "descent_retrieve_table_failed:" + reason);
            }
            if (retrieveTransition.action() == FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE_COMPLETE) {
                shell.logger().info(
                    "descent.fieldkit_table_retrieved instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                    shell.instanceId(),
                    run.commandId,
                    retrieveCommandId,
                    reason,
                    run.descentToolRecoveryAttempts
                );
                return new ControlDecision(shell.stopFrom(effective, "descent_fieldkit_table_retrieved"), InputState.stop());
            }
            return retrieveDecision;
        }

        boolean craftingScreenOpen = player.currentScreenHandler != null && player.currentScreenHandler instanceof CraftingScreenHandler;
        McbotFabricClient.CraftInventorySnapshot craftInventory = shell.captureCraftInventory(player);
        if (run.lastDescentFieldKitStateLogAtMs <= 0L || nowMs - run.lastDescentFieldKitStateLogAtMs >= 1000L) {
            run.lastDescentFieldKitStateLogAtMs = nowMs;
            shell.logger().info(
                "descent.fieldkit_state instanceId={} commandId={} recoveryActive={} retrievePending={} cobblestone={} sticks={} tables={} recoveryAttempts={} proactive={}",
                shell.instanceId(),
                run.commandId,
                run.descentFieldKitRecoveryActive,
                run.descentFieldKitRetrieveTablePending,
                craftInventory.cobblestone().cobblestoneCount(),
                craftInventory.sticks().stickCount(),
                craftInventory.tables().craftingTableCount(),
                run.descentToolRecoveryAttempts,
                proactive
            );
        }
        BlockPos table = shell.selectNearbyCraftingTable(client, player);
        FieldKitRecoveryPlanner.Decision inventoryDecision = applyDescentFieldKitDecision(run, FieldKitRecoveryPlanner.afterInventory(
            descentFieldKitState(run),
            new FieldKitRecoveryPlanner.InventoryObservation(
                craftingScreenOpen,
                craftInventory.cobblestone().cobblestoneCount(),
                craftInventory.sticks().stickCount(),
                craftInventory.tables().craftingTableCount(),
                table != null,
                false
            )
        ));
        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.MISSING_PICKAXE_INPUTS) {
            // Campaign B2: the recovery had cobblestone=247, sticks=1, tables=1 -- everything but ONE
            // stick, with the mission's plank fuel-reserve sitting unusable because the field-kit can
            // only consume sticks, not planks. Sticks are a 2x2 INVENTORY-GRID craft (2 planks -> 4
            // sticks); bootstrap them before surrendering, mirroring the table bootstrap below, so the
            // next pass re-attempts the pickaxe craft with a stick reserve. Cobblestone is effectively
            // never the shortfall at descent depth (MINE_STONE + furnace reserve), but only bootstrap
            // when the sticks-from-planks craft actually closes the gap.
            if (craftInventory.sticks().stickCount() < 2
                && craftInventory.cobblestone().cobblestoneCount() >= 3
                && (InventoryCounter.countPlayerPlanks(player).plankCount() >= 2
                    || run.descentFieldKitSticksCraftActive)) {
                run.descentFieldKitSticksCraftActive = true;
                String sticksCraftCommandId = run.toolCraftSticksCommandId();
                ControlDecision sticksCraftDecision = shell.resolveRecoveryCraftSticks(
                    client,
                    player,
                    shell.makeSubIntent(effective, "craft_sticks", sticksCraftCommandId, "descent_fieldkit_craft_sticks"),
                    nowMs
                );
                String sticksCraftReason = sticksCraftDecision.intent() == null ? "" : sticksCraftDecision.intent().reason();
                if (sticksCraftReason.startsWith("craft_sticks_complete:")) {
                    run.descentFieldKitSticksCraftActive = false;
                    shell.logger().info(
                        "descent.fieldkit_sticks_crafted instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                        shell.instanceId(),
                        run.commandId,
                        sticksCraftCommandId,
                        sticksCraftReason,
                        run.descentToolRecoveryAttempts
                    );
                    return new ControlDecision(shell.stopFrom(effective, "descent_fieldkit_sticks_crafted"), InputState.stop());
                }
                if (!sticksCraftReason.startsWith("craft_sticks_failed:")) {
                    return sticksCraftDecision;
                }
                run.descentFieldKitSticksCraftActive = false;
                // craft failed -> fall through to the terminal failure.
            }
            shell.logger().warn(
                "descent.fieldkit_failed instanceId={} commandId={} reason=missing_stone_pickaxe_inputs cobblestone={} sticks={} tables={} planks={} recoveryAttempts={}",
                shell.instanceId(),
                run.commandId,
                craftInventory.cobblestone().cobblestoneCount(),
                craftInventory.sticks().stickCount(),
                craftInventory.tables().craftingTableCount(),
                InventoryCounter.countPlayerPlanks(player).plankCount(),
                run.descentToolRecoveryAttempts
            );
            return failDescent(effective, run, nowMs, "descent_tool_recovery:missing_inputs");
        }

        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.NO_CRAFTING_TABLE) {
            // A table is a 2x2 INVENTORY-GRID craft from 4 planks; bootstrap one before surrendering so
            // the next pass takes the normal PLACE_TABLE_REQUIRED -> craft-pickaxe route (proven on the iron path).
            if (InventoryCounter.countPlayerPlanks(player).plankCount() >= 4) {
                String tableCraftCommandId = run.toolCraftTableCommandId();
                ControlDecision tableCraftDecision = shell.resolveRecoveryCraftTable(
                    client,
                    player,
                    shell.makeSubIntent(effective, "craft_table", tableCraftCommandId, "descent_fieldkit_craft_table"),
                    nowMs
                );
                String tableCraftReason = tableCraftDecision.intent() == null ? "" : tableCraftDecision.intent().reason();
                if (tableCraftReason.startsWith("craft_table_complete:")) {
                    shell.logger().info(
                        "descent.fieldkit_table_crafted instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                        shell.instanceId(),
                        run.commandId,
                        tableCraftCommandId,
                        tableCraftReason,
                        run.descentToolRecoveryAttempts
                    );
                    return new ControlDecision(shell.stopFrom(effective, "descent_fieldkit_table_crafted"), InputState.stop());
                }
                if (!tableCraftReason.startsWith("craft_table_failed:")) {
                    return tableCraftDecision;
                }
                // craft failed -> fall through to the terminal failure.
            }
            shell.logger().warn(
                "descent.fieldkit_failed instanceId={} commandId={} reason=no_table_available cobblestone={} sticks={} planks={} recoveryAttempts={}",
                shell.instanceId(),
                run.commandId,
                craftInventory.cobblestone().cobblestoneCount(),
                craftInventory.sticks().stickCount(),
                InventoryCounter.countPlayerPlanks(player).plankCount(),
                run.descentToolRecoveryAttempts
            );
            return failDescent(effective, run, nowMs, "descent_tool_recovery:no_table");
        }

        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.PLACE_TABLE_REQUIRED) {
            String placeCommandId = run.toolPlaceTableCommandId();
            ControlDecision placeDecision = shell.resolveRecoveryPlaceTable(
                client,
                player,
                shell.makeSubIntent(effective, "place_table", placeCommandId, "descent_place_table"),
                nowMs,
                null
            );
            String reason = placeDecision.intent() == null ? "" : placeDecision.intent().reason();
            FieldKitRecoveryPlanner.Decision placeTransition = applyDescentFieldKitDecision(run,
                FieldKitRecoveryPlanner.afterPlaceTable(descentFieldKitState(run), reason));
            if (placeTransition.action() == FieldKitRecoveryPlanner.Action.PLACE_TABLE_FAILED) {
                return failDescent(effective, run, nowMs, "descent_place_table_failed:" + reason);
            }
            if (placeTransition.action() == FieldKitRecoveryPlanner.Action.PLACE_TABLE_COMPLETE) {
                shell.logger().info(
                    "descent.fieldkit_table_placed instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                    shell.instanceId(),
                    run.commandId,
                    placeCommandId,
                    reason,
                    run.descentToolRecoveryAttempts
                );
                return new ControlDecision(shell.stopFrom(effective, "descent_fieldkit_table_placed"), InputState.stop());
            }
            return placeDecision;
        }

        String craftCommandId = run.toolCraftPickaxeCommandId();
        ControlDecision craftDecision = shell.resolveRecoveryCraftStonePickaxe(
            client,
            player,
            shell.makeSubIntent(effective, "craft_stone_pickaxe", craftCommandId, "descent_craft_stone_pickaxe"),
            nowMs
        );
        String reason = craftDecision.intent() == null ? "" : craftDecision.intent().reason();
        FieldKitRecoveryPlanner.Decision craftTransition = applyDescentFieldKitDecision(run,
            FieldKitRecoveryPlanner.afterCraftPickaxe(descentFieldKitState(run), reason));
        if (craftTransition.action() == FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE_FAILED) {
            return failDescent(effective, run, nowMs, "descent_craft_stone_pickaxe_failed:" + reason);
        }
        if (craftTransition.action() == FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE_COMPLETE) {
            if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
                player.closeHandledScreen();
            }
            shell.logger().info(
                "descent.fieldkit_pickaxe_crafted instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                shell.instanceId(),
                run.commandId,
                craftCommandId,
                reason,
                run.descentToolRecoveryAttempts
            );
            // The COMPLETE transition already cleared `active`; the next tick's normal break path moves
            // the freshly crafted pickaxe into the hotbar (S1) and resumes the descent.
            return new ControlDecision(shell.stopFrom(effective, "descent_fieldkit_pickaxe_crafted"), InputState.stop());
        }
        return craftDecision;
    }

    private ControlDecision maybeResolveProactiveDescentToolRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs
    ) {
        int bestRemaining = shell.bestStonePickaxeRemainingDurability(player);
        if (bestRemaining < 0 || bestRemaining > DESCENT_PICKAXE_RESTOCK_REMAINING) {
            return null;
        }
        McbotFabricClient.CraftInventorySnapshot craftInventory = shell.captureCraftInventory(player);
        if (craftInventory.cobblestone().cobblestoneCount() < 3
            || craftInventory.sticks().stickCount() < 2
            || (craftInventory.tables().craftingTableCount() < 1 && shell.selectNearbyCraftingTable(client, player) == null)) {
            return null;
        }
        if (!run.descentProactiveToolRecoveryLogged) {
            run.descentProactiveToolRecoveryLogged = true;
            shell.logger().info(
                "descent.proactive_tool_recovery instanceId={} commandId={} bestStonePickaxeRemaining={} threshold={} cobblestone={} sticks={} tables={} nearbyTable={}",
                shell.instanceId(),
                run.commandId,
                bestRemaining,
                DESCENT_PICKAXE_RESTOCK_REMAINING,
                craftInventory.cobblestone().cobblestoneCount(),
                craftInventory.sticks().stickCount(),
                craftInventory.tables().craftingTableCount(),
                McbotFabricClient.formatBlockPos(shell.selectNearbyCraftingTable(client, player))
            );
        }
        applyDescentFieldKitDecision(run, FieldKitRecoveryPlanner.activate(descentFieldKitState(run)));
        return resolveDescentToolRecovery(client, player, effective, run, nowMs, true);
    }

    private ControlDecision maybeResolveDescentClearanceRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs
    ) {
        if (client == null
            || client.world == null
            || run == null
            || run.recoveryClearTarget == null
            || run.recoveryClearPhase == null
            || run.recoveryClearPhase.isBlank()) {
            return null;
        }
        if (step == null) {
            clearDescentClearanceRecovery(run);
            return null;
        }
        BlockPos target = run.recoveryClearTarget;
        String phase = run.recoveryClearPhase;
        if (client.world.getBlockState(target).isAir()) {
            clearDescentClearanceRecovery(run);
            run.stage = descentStageAfterPhase(phase);
            shell.logger().info(
                "descent.clearance_recovery_cleared instanceId={} commandId={} step={} phase={} target={} reason=already_air",
                shell.instanceId(),
                run.commandId,
                step.index(),
                phase,
                target.toShortString()
            );
            return new ControlDecision(shell.stopFrom(effective, "descent_clearance_recovery_cleared:" + phase), InputState.stop());
        }
        run.stage = descentStageForPhase(phase);
        return breakDescentBlock(client, player, effective, run, step, target, phase, nowMs);
    }

    private static BlockPos descentTargetForPhase(StaircaseDescentPlanner.Step step, String phase) {
        if (step == null || phase == null) {
            return null;
        }
        return switch (phase) {
            case "sight" -> step.sightClear();
            case "upper" -> step.upperClear();
            case "lower" -> step.lowerClear();
            default -> null;
        };
    }

    private static DescentControlPlanner.Stage descentStageForPhase(String phase) {
        return switch (phase == null ? "" : phase) {
            case "sight" -> DescentControlPlanner.Stage.BREAK_SIGHT;
            case "upper" -> DescentControlPlanner.Stage.BREAK_UPPER;
            case "lower" -> DescentControlPlanner.Stage.BREAK_LOWER;
            default -> DescentControlPlanner.Stage.BREAK_SIGHT;
        };
    }

    private static DescentControlPlanner.Stage descentStageAfterPhase(String phase) {
        return switch (phase == null ? "" : phase) {
            case "sight" -> DescentControlPlanner.Stage.BREAK_UPPER;
            case "upper" -> DescentControlPlanner.Stage.BREAK_LOWER;
            case "lower" -> DescentControlPlanner.Stage.MOVE_TO_STEP;
            default -> DescentControlPlanner.Stage.BREAK_SIGHT;
        };
    }

    private static void clearMatchingDescentClearanceRecovery(DescentRun run, BlockPos target) {
        if (run != null && target != null && target.equals(run.recoveryClearTarget)) {
            clearDescentClearanceRecovery(run);
        }
    }

    private static void clearDescentClearanceRecovery(DescentRun run) {
        if (run == null) {
            return;
        }
        run.recoveryClearTarget = null;
        run.recoveryClearPhase = "";
    }

    private ControlDecision moveToDescentStep(ClientPlayerEntity player, BrainLink.Intent effective, DescentRun run, StaircaseDescentPlanner.Step step) {
        double targetX = step.nextFeet().getX() + 0.5D;
        double targetZ = step.nextFeet().getZ() + 0.5D;
        double dx = targetX - player.getX();
        double dz = targetZ - player.getZ();
        double distance = Math.hypot(dx, dz);
        if (distance <= McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON && Math.floor(player.getY()) <= step.nextFeet().getY()) {
            run.stepIndex++;
            run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
            return new ControlDecision(shell.stopFrom(effective, "descent_step_arrived"), InputState.stop());
        }
        if (DescentControlPlanner.shouldSettleIntoStep(
            distance,
            McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON,
            player.getY(),
            step.nextFeet().getY()
        )) {
            BrainLink.Intent intent = shell.lookIntentForAngles(
                effective,
                McbotFabricClient.yawForDescentDirection(run.direction),
                8.0D,
                "descent_step_drop_settle:" + step.index()
            );
            InputState input = new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
            return new ControlDecision(intent, input);
        }
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        double yawError = LookController.normalizeYaw(yaw - player.getYaw());
        if (DescentControlPlanner.shouldHoldMoveForYaw(yawError, McbotFabricClient.DESCENT_MOVE_YAW_TOLERANCE_DEG)) {
            BrainLink.Intent intent = shell.lookIntentForAngles(effective, yaw, 8.0D, "descent_face_step:" + step.index());
            return new ControlDecision(intent, InputState.stop());
        }
        BrainLink.Intent intent = shell.lookIntentForAngles(effective, yaw, 8.0D, "descent_move_step:" + step.index());
        InputState input = new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private boolean descentMoveStalled(ClientPlayerEntity player, DescentRun run, StaircaseDescentPlanner.Step step, long nowMs) {
        BlockPos target = step.nextFeet().toImmutable();
        double distance = descentStepHorizontalDistance(player, target);
        if (!target.equals(run.moveTargetFeet)) {
            run.moveTargetFeet = target;
            run.moveStartedAtMs = nowMs;
            run.moveLastProgressAtMs = nowMs;
            run.moveBestDistance = distance;
            shell.logger().info(
                "descent.move_start instanceId={} commandId={} step={} target={} position={} distance={}",
                shell.instanceId(),
                run.commandId,
                step.index(),
                target.toShortString(),
                player.getBlockPos().toShortString(),
                formatDistance(distance)
            );
            return false;
        }
        if (distance + McbotFabricClient.DESCENT_MOVE_PROGRESS_EPSILON < run.moveBestDistance) {
            run.moveBestDistance = distance;
            run.moveLastProgressAtMs = nowMs;
            return false;
        }
        long stagnantMs = Math.max(0L, nowMs - run.moveLastProgressAtMs);
        if (stagnantMs >= McbotFabricClient.DESCENT_MOVE_STALL_MS && distance > McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON) {
            shell.logger().warn(
                "descent.move_stall instanceId={} commandId={} step={} target={} position={} distance={} bestDistance={} stagnantMs={} moveStartedMs={} stage={}",
                shell.instanceId(),
                run.commandId,
                step.index(),
                target.toShortString(),
                player.getBlockPos().toShortString(),
                formatDistance(distance),
                formatDistance(run.moveBestDistance),
                stagnantMs,
                Math.max(0L, nowMs - run.moveStartedAtMs),
                run.stage
            );
            return true;
        }
        return false;
    }

    private double descentStepHorizontalDistance(ClientPlayerEntity player, BlockPos nextFeet) {
        return Math.hypot((nextFeet.getX() + 0.5D) - player.getX(), (nextFeet.getZ() + 0.5D) - player.getZ());
    }

    private void clearDescentMoveProgress(DescentRun run) {
        run.moveTargetFeet = null;
        run.moveStartedAtMs = 0L;
        run.moveLastProgressAtMs = 0L;
        run.moveBestDistance = Double.POSITIVE_INFINITY;
    }

    private static String formatDistance(double value) {
        return String.format(Locale.ROOT, "%.3f", value);
    }

    private boolean descentComplete(MinecraftClient client, ClientPlayerEntity player, DescentRun run) {
        return run.depthReached >= run.depth
            && player.isOnGround()
            && shell.isStableDescentSupport(client, player.getBlockPos().down());
    }

    private boolean reachedDescentStep(ClientPlayerEntity player, BlockPos nextFeet) {
        return Math.floor(player.getY()) <= nextFeet.getY()
            && Math.hypot((nextFeet.getX() + 0.5D) - player.getX(), (nextFeet.getZ() + 0.5D) - player.getZ()) <= McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON;
    }

    // Shared descent re-anchor: snap the run's tracked feet/depth/step/stage to where the player
    // actually ended up on solid ground, advancing depthReached by the vertical delta (clamped to the
    // requested depth) and resetting to BREAK_SIGHT so the next tick re-plans from there. Used by BOTH
    // the overshot resync (slid past the planned step) and the controlled safe-fall landing. Returns
    // the vertical depthDelta applied (>= 1) so callers can log it. Mirrors the original inline overshot
    // body exactly (incl. the Math.max(1, ...) floor — both callers always land strictly below, so it
    // is a no-op there and never yields a non-positive delta).
    private int reanchorDescentToFeet(DescentRun run, BlockPos actualFeet, long nowMs) {
        int depthDelta = Math.max(1, run.currentFeet.getY() - actualFeet.getY());
        run.currentFeet = actualFeet;
        run.depthReached = Math.min(run.depth, run.depthReached + depthDelta);
        run.stepIndex += depthDelta;
        run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        run.reachedFeet.add(actualFeet);
        clearDescentMoveProgress(run);
        return depthDelta;
    }

    private ControlDecision maybeResyncDescentOvershot(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs
    ) {
        if (client == null || player == null || run == null || step == null) {
            return null;
        }
        BlockPos actualFeet = player.getBlockPos().toImmutable();
        if (!McbotFabricClient.shouldResyncDescentOvershot(run.currentFeet, actualFeet, step.nextFeet(), run.depthReached, run.depth)) {
            return null;
        }
        if (!shell.isStableDescentSupport(client, actualFeet.down())) {
            return null;
        }
        BlockPos previousFeet = run.currentFeet;
        int depthDelta = reanchorDescentToFeet(run, actualFeet, nowMs);
        shell.logger().warn(
            "descent.overshot_resync instanceId={} commandId={} previousFeet={} plannedNextFeet={} actualFeet={} depthDelta={} depthReached={} step={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            previousFeet.toShortString(),
            step.nextFeet().toShortString(),
            actualFeet.toShortString(),
            depthDelta,
            run.depthReached,
            run.stepIndex,
            Math.max(0L, nowMs - run.startedAtMs)
        );
        return new ControlDecision(shell.stopFrom(effective, "descent_overshot_resynced"), InputState.stop());
    }

    private String descentStepUnsafeReason(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (client == null || client.world == null || step == null) {
            return "descent_missing_client_state";
        }
        if (!shell.isStableDescentSupport(client, step.support())) {
            return "descent_next_support_missing:" + step.support().toShortString();
        }
        McbotFabricClient.HazardBlock hazard = shell.firstHazardBlockDetail(client, step);
        if (hazard != null) {
            return "descent_hazard_in_step:" + hazard.kind() + ":" + hazard.pos().toShortString();
        }
        BlockPos waterAdjacent = firstAdjacentWaterBlock(client, step);
        if (waterAdjacent != null) {
            return "descent_water_adjacent:" + waterAdjacent.toShortString();
        }
        BlockPos lavaAdjacent = firstAdjacentLavaBlock(client, step);
        if (lavaAdjacent != null) {
            return "descent_lava_adjacent:" + lavaAdjacent.toShortString();
        }
        return null;
    }

    // Controlled safe-fall detection. The descent stalled trying to reach rejectedStep.nextFeet() (the
    // open-air diagonal cell one block down and one over from run.currentFeet) and can neither bridge nor
    // reroute. Instead of refusing, see if a straight drop down that column lands on a validated floor:
    // a ZERO-damage drop within MAX_SAFE_DROP, or, when none exists, a deeper HEALTH-AWARE drop that takes
    // survivable fall damage (leaves >= DESCENT_SAFE_FALL_HEALTH_MARGIN health). Returns the landing +
    // true vertical drop, or null (fall through to failDescent for anything too deep / unsafe / water /
    // unsurvivable at the current health).
    //
    // Geometry: rejectedStep.nextFeet() == run.currentFeet shifted (dx, -1, dz), so it is already one
    // block BELOW the bot's feet. The candidate landing at drop d (d = 1..DESCENT_MAX_HEALTH_FALL_BLOCKS,
    // the true vertical distance from run.currentFeet) is rejectedStep.nextFeet().down(d - 1). fallBlocks
    // is that d; the scan prefers the shallowest landing (and so any zero-damage drop over a deeper one).
    private SafeFall canSafeFallFromStall(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step rejectedStep
    ) {
        if (client == null || client.world == null || player == null || run == null || rejectedStep == null) {
            return null;
        }
        BlockPos dropColumnTop = rejectedStep.nextFeet();
        float health = player.getHealth();
        // Scan shallow -> deep and commit the FIRST survivable landing, so a zero-damage drop is always
        // preferred over a damage-taking one and, among damage-taking drops, the shallowest (least damage)
        // wins. The deeper tail past MAX_SAFE_DROP is only reached when no shallow landing exists.
        for (int fallBlocks = 1; fallBlocks <= DESCENT_MAX_HEALTH_FALL_BLOCKS; fallBlocks++) {
            BlockPos landFeet = dropColumnTop.down(fallBlocks - 1);
            // CLEAR-COLUMN: every cell from the open-air drop column top down to just above the landing
            // must be air / non-collidable AND non-hazard (no solid/partial block to catch on, no
            // mid-column lava/fire/cactus to clip through on the way down).
            boolean columnClear = true;
            for (BlockPos cell = dropColumnTop; cell.getY() > landFeet.getY(); cell = cell.down()) {
                BlockState cellState = client.world.getBlockState(cell);
                if (!cellState.getCollisionShape(client.world, cell).isEmpty()
                    || shell.isHazardBlockState(cellState)) {
                    columnClear = false;
                    break;
                }
            }
            // FLOOR / FEET / HEAD: solid non-hazard floor directly below, air feet + head room.
            boolean floorSolid = shell.isStableDescentSupport(client, landFeet.down());
            boolean feetAir = client.world.getBlockState(landFeet).getCollisionShape(client.world, landFeet).isEmpty();
            BlockPos headPos = landFeet.up();
            boolean headAir = client.world.getBlockState(headPos).getCollisionShape(client.world, headPos).isEmpty();
            // HAZARD: no hazard in the landing feet/head cells; no lava adjacent to the landing.
            boolean landingHazard = shell.firstHazardBlockDetail(client, java.util.List.of(landFeet, headPos)) != null;
            boolean adjacentLava = shell.firstAdjacentLavaBlock(client, landFeet) != null;
            // NO-WORSE-TRAP: reject a fully boxed pit (all 4 horizontal dirs walled at BOTH feet- and
            // head-level), where the bot could neither step nor climb out after landing.
            boolean[] feetLevelSolid = new boolean[4];
            boolean[] headLevelSolid = new boolean[4];
            Direction[] horizontals = {Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST};
            for (int i = 0; i < horizontals.length; i++) {
                BlockPos sideFeet = landFeet.offset(horizontals[i]);
                BlockPos sideHead = sideFeet.up();
                feetLevelSolid[i] = !client.world.getBlockState(sideFeet).getCollisionShape(client.world, sideFeet).isEmpty();
                headLevelSolid[i] = !client.world.getBlockState(sideHead).getCollisionShape(client.world, sideHead).isEmpty();
            }
            boolean boxedPit = SafeFallPlanner.isBoxedPit(feetLevelSolid, headLevelSolid);
            boolean physicallySafe = SafeFallPlanner.isPhysicallySafeLanding(
                columnClear,
                floorSolid,
                feetAir,
                headAir,
                landingHazard,
                adjacentLava,
                boxedPit
            );
            // Commit when the landing is physically safe AND either a zero-damage shallow drop or a
            // survivable health-aware deeper drop (leaves >= DESCENT_SAFE_FALL_HEALTH_MARGIN health).
            boolean withinFallBudget = fallBlocks <= DESCENT_MAX_SAFE_FALL_BLOCKS
                || SafeFallPlanner.isHealthSurvivableFall(
                    fallBlocks,
                    DESCENT_MAX_HEALTH_FALL_BLOCKS,
                    health,
                    DESCENT_SAFE_FALL_HEALTH_MARGIN
                );
            if (physicallySafe && withinFallBudget) {
                return new SafeFall(landFeet.toImmutable(), fallBlocks);
            }
        }
        return null;
    }

    // Latch + launch a controlled safe-fall: mark the run so it is attempted at most ONCE, record the
    // drop column + validated landing, aim at the column and give a brief forward nudge to walk off the
    // ledge. The airborne wait is handled by the existing preflight WAIT_ON_GROUND (a stop every
    // non-onGround tick); the landing is caught by the safe-fall re-anchor check at the head of resolve.
    private ControlDecision beginSafeFall(
        BrainLink.Intent effective,
        DescentRun run,
        ClientPlayerEntity player,
        StaircaseDescentPlanner.Step rejectedStep,
        SafeFall fall,
        long nowMs
    ) {
        run.safeFallAttempted = true;
        run.safeFallColumn = rejectedStep.nextFeet().toImmutable();
        run.safeFallLandingFeet = fall.landingFeet().toImmutable();
        run.safeFallExpectedDamage = SafeFallPlanner.fallDamage(fall.fallBlocks());
        run.safeFallLaunchedAtMs = nowMs;
        shell.logger().warn(
            "descent.safe_fall instanceId={} commandId={} from={} to={} column={} fallBlocks={} depthReached={} step={} elapsedMs={} expectedDamage={} healthBefore={} health={}",
            shell.instanceId(),
            run.commandId,
            run.currentFeet.toShortString(),
            run.safeFallLandingFeet.toShortString(),
            run.safeFallColumn.toShortString(),
            fall.fallBlocks(),
            run.depthReached,
            run.stepIndex,
            Math.max(0L, nowMs - run.startedAtMs),
            run.safeFallExpectedDamage,
            run.healthBefore,
            player.getHealth()
        );
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, Vec3d.ofCenter(run.safeFallColumn));
        BrainLink.Intent intent = shell.lookIntentForAngles(
            effective,
            look.yaw(),
            look.pitch(),
            "descent_safe_fall:" + fall.fallBlocks()
        );
        // Aim at the drop column only and start the head slew; the forward nudge off the ledge is issued
        // by the in-progress hold at the head of resolve once the head has converged, so the bot never
        // walks the wrong way while still slewing (and the hold also stops the stage machine from failing
        // the run mid-fall via the one-fall latch).
        return new ControlDecision(intent, InputState.stop());
    }

    private String currentPlayerDescentHazardReason(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        BlockPos feet = player.getBlockPos().toImmutable();
        McbotFabricClient.HazardBlock hazard = shell.firstHazardBlockDetail(client, List.of(feet, feet.up()));
        if (hazard != null) {
            return "descent_player_in_hazard:" + hazard.kind() + ":" + hazard.pos().toShortString();
        }
        if (player.isTouchingWater()) {
            return "descent_player_in_hazard:water:" + feet.toShortString();
        }
        BlockPos adjacentLava = firstAdjacentLavaBlock(client, List.of(feet, feet.up()));
        if (adjacentLava != null) {
            return "descent_player_lava_adjacent:" + adjacentLava.toShortString();
        }
        return null;
    }

    private String descentBreakHazardReason(MinecraftClient client, ClientPlayerEntity player, BlockPos target, String breakReason) {
        if (client == null || client.world == null || player == null || target == null) {
            return null;
        }
        String currentHazardReason = currentPlayerDescentHazardReason(client, player);
        if (currentHazardReason != null) {
            return currentHazardReason + ":during_break:" + breakReason;
        }
        McbotFabricClient.HazardBlock hazard = shell.firstHazardBlockDetail(client, List.of(target));
        if (hazard != null) {
            return "descent_break_reposition_hazard:" + hazard.kind() + ":" + hazard.pos().toShortString() + ":" + breakReason;
        }
        return null;
    }

    private BlockPos firstAdjacentLavaBlock(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (step == null) {
            return null;
        }
        return firstAdjacentLavaBlock(client, List.of(step.sightClear(), step.upperClear(), step.lowerClear(), step.support()));
    }

    private BlockPos firstAdjacentLavaBlock(MinecraftClient client, List<BlockPos> origins) {
        if (client == null || client.world == null || origins == null) {
            return null;
        }
        for (BlockPos origin : origins) {
            if (origin == null) {
                continue;
            }
            for (Direction direction : Direction.values()) {
                BlockPos adjacent = origin.offset(direction);
                if (shell.isLavaBlockState(client.world.getBlockState(adjacent))) {
                    return adjacent.toImmutable();
                }
            }
        }
        return null;
    }

    private BlockPos firstAdjacentWaterBlock(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (client == null || client.world == null || step == null) {
            return null;
        }
        for (BlockPos origin : List.of(step.sightClear(), step.upperClear(), step.lowerClear(), step.support())) {
            for (Direction direction : Direction.values()) {
                if (!McbotFabricClient.shouldCheckDescentAdjacentWater(step, origin, direction)) {
                    continue;
                }
                BlockPos adjacent = origin.offset(direction);
                if (isWaterBlockState(client.world.getBlockState(adjacent))) {
                    if (shouldIgnoreSealedDescentAdjacentWater(client, step, origin, direction, adjacent)) {
                        continue;
                    }
                    return adjacent.toImmutable();
                }
            }
        }
        return null;
    }

    private boolean isWaterBlockState(BlockState state) {
        return state != null && (state.isOf(Blocks.WATER) || state.getFluidState().isIn(FluidTags.WATER));
    }

    private boolean shouldIgnoreSealedDescentAdjacentWater(
        MinecraftClient client,
        StaircaseDescentPlanner.Step step,
        BlockPos origin,
        Direction direction,
        BlockPos waterPos
    ) {
        if (client == null || client.world == null || waterPos == null) {
            return false;
        }
        return McbotFabricClient.isSealedDescentAdjacentSupportWater(
            step,
            origin,
            direction,
            waterPos,
            shell.isStableDescentSupport(client, waterPos.up())
        );
    }

    // True when a missing-support step is an open-air gap the bot can bridge in place: it has a
    // solid filler block available, the floor cell is genuinely air (not fluid/occupied), a
    // reachable+raycast-clear adjacent face exists to build from, and we are under the per-run
    // bridge budget. Cheap checks first; the face raycast is the only costly part and runs last.
    private boolean canBridgeDescentSupport(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        String unsafeReason
    ) {
        if (client == null || client.world == null || player == null || run == null || step == null) {
            return false;
        }
        boolean supportMissing = unsafeReason != null && unsafeReason.startsWith("descent_next_support_missing");
        boolean waterAdjacent = unsafeReason != null && unsafeReason.startsWith("descent_water_adjacent:");
        if (!supportMissing && !waterAdjacent) {
            return false;
        }
        // WATER-SEAL (a recurring abort family): the offending
        // water cell is sealable by the SAME placement flow — water is replaceable, so a top-place
        // onto its (stable) floor fills the cell. Slice 1 is top-seal only; the shared bridge budget
        // bounds pool edges; lava near the seal cell disqualifies as usual.
        if (waterAdjacent) {
            BlockPos sealCell = firstAdjacentWaterBlock(client, step);
            return sealCell != null
                && run.supportBridges < Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth)
                && hasDescentSupportFillerItem(player)
                && shell.firstAdjacentLavaBlock(client, sealCell) == null
                && shell.isStableDescentSupport(client, sealCell.down());
        }
        if (run.supportBridges >= Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth)) {
            logBridgeGateReject(run, step, "bridge_budget_exhausted:" + run.supportBridges);
            return false;
        }
        // Bridge whenever the FLOOR cell is missing. The body cell may be air (open cave mouth) or
        // diggable solid (the L-NOTCH: a floor hole behind a wall — two live repros, granite and stone,
        // both aborted descent_recovery_exhausted because the old gate demanded an open gap): the
        // support fill is correct in both shapes, and the normal step machinery digs the wall once
        // the floor exists. Only a FLUID body cell disqualifies (never open a face into liquid).
        if (!client.world.getBlockState(step.support()).isAir()) {
            logBridgeGateReject(run, step, "support_not_air:"
                + shell.blockId(client.world.getBlockState(step.support())));
            return false;
        }
        if (!client.world.getBlockState(step.nextFeet()).getFluidState().isEmpty()) {
            logBridgeGateReject(run, step, "gap_fluid:nextFeet="
                + shell.blockId(client.world.getBlockState(step.nextFeet())));
            return false;
        }
        if (!hasDescentSupportFillerItem(player)) {
            logBridgeGateReject(run, step, "no_filler_item");
            return false;
        }
        // Never bridge into a cell touching lava (either mode).
        BlockPos gateLava = shell.firstAdjacentLavaBlock(client, step.support());
        if (gateLava != null) {
            logBridgeGateReject(run, step, "lava_adjacent:" + gateLava.toShortString());
            return false;
        }
        // TOP mode: a solid block directly beneath the gap to place the bridge block on top of.
        if (shell.isStableDescentSupport(client, step.support().down())) {
            return true;
        }
        // SIDE mode (deep gap / cave mouth, a recurring abort family): the classic player
        // bridge — place the filler against the direction-facing vertical face of the block beneath
        // the bot's OWN standing block (= the gap cell's rear neighbor). Requires that rear block to
        // be solid; placeDescentSupport sneaks to an overhang so the eye-ray clears the edge.
        if (shell.isStableDescentSupport(client, descentSideBridgeSource(step, run.direction))) {
            return true;
        }
        // Column repair (repro: side_source_unstable:air): the bot stands on an overhang lip —
        // the side-source cell is itself air with solid one deeper. Eligible: top-place INTO the
        // side-source cell first; the side bridge then proceeds off the repaired block.
        BlockPos gateSideSource = descentSideBridgeSource(step, run.direction);
        if (client.world.getBlockState(gateSideSource).isAir()
            && shell.isStableDescentSupport(client, gateSideSource.down())) {
            return true;
        }
        logBridgeGateReject(run, step, "side_source_unstable:"
            + shell.blockId(client.world.getBlockState(gateSideSource))
            + ":below=" + shell.blockId(client.world.getBlockState(gateSideSource.down())));
        return false;
    }

    private void logBridgeGateReject(DescentRun run, StaircaseDescentPlanner.Step step, String why) {
        long nowMs = System.currentTimeMillis();
        if (nowMs < nextBridgeGateLogMs) {
            return;
        }
        nextBridgeGateLogMs = nowMs + 1_000L;
        shell.logger().info(
            "descent.bridge_gate_reject instanceId={} commandId={} step={} support={} why={}",
            shell.instanceId(),
            run == null ? "" : run.commandId,
            step == null ? -1 : step.index(),
            step == null ? "none" : step.support().toShortString(),
            why
        );
    }

    // The block sharing the direction-facing vertical face with the missing support cell: one cell
    // back toward the bot, i.e. directly beneath the bot's standing block.
    private static BlockPos descentSideBridgeSource(StaircaseDescentPlanner.Step step, StaircaseDescentPlanner.Direction2d direction) {
        return step.support().add(-direction.dx(), 0, -direction.dz());
    }

    // Aim/raycast point for the side bridge: just INSIDE the gap-facing face (0.45 toward it from
    // center) and in the LOWER half of the face (-0.3). Inside matters because the eye is on the
    // SAME side as the face — a point 0.001 outside ends the ray in air and never registers a hit
    // (validation run 1: every attempt died bridge_no_line_of_sight on exactly this). The low bias
    // shrinks the sneak-overhang needed for the ray to clear the standing block's underside from
    // ~0.23 to ~0.14 of the ~0.29 sneak allows.
    private static Vec3d sideBridgeFacePoint(BlockPos sideSource, StaircaseDescentPlanner.Direction2d direction) {
        return Vec3d.ofCenter(sideSource).add(direction.dx() * 0.45D, -0.3D, direction.dz() * 0.45D);
    }

    // Aim/LOS point for the column repair: the gap-side edge region of the repair foundation's TOP
    // face. From the sneak-overhang the eye-ray passes under the standing block's underside and
    // re-enters the bot's own column below it — a centre aim would be occluded by the standing
    // block itself.
    private static Vec3d columnRepairAimPoint(BlockPos repairFoundation, StaircaseDescentPlanner.Direction2d direction) {
        return new Vec3d(
            repairFoundation.getX() + 0.5D + direction.dx() * 0.45D,
            repairFoundation.getY() + 1.0D,
            repairFoundation.getZ() + 0.5D + direction.dz() * 0.45D
        );
    }

    private boolean hasClearLineToDescentColumnRepair(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos repairFoundation,
        StaircaseDescentPlanner.Direction2d direction
    ) {
        if (client == null || client.world == null || player == null || repairFoundation == null || direction == null) {
            return false;
        }
        Vec3d eye = player.getEyePos();
        // End the ray just INSIDE the top face so it crosses the surface and registers the hit
        // (lesson: a point outside the face ends the ray in air).
        Vec3d point = columnRepairAimPoint(repairFoundation, direction).add(0.0D, -0.05D, 0.0D);
        double reach = Math.min(McbotFabricClient.TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        if (eye.squaredDistanceTo(point) > reach * reach) {
            return false;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye, point, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
        return hit != null && hit.getType() == HitResult.Type.BLOCK
            && repairFoundation.equals(hit.getBlockPos())
            && hit.getSide() == Direction.UP;
    }

    // Clear eye-line to the gap-facing vertical face of the side-bridge source block: the raycast
    // must enter exactly that block through exactly that face (sneak-overhang at the edge achieves
    // this — the eye clears the standing block's boundary while sneak prevents falling).
    // Side-bridge aim v2 (descent census 06-12: side-mode LOS timeouts were 8 of the last 10
    // bridge failures): one fixed face point often stays occluded within the sneak overhang the
    // stance allows. Candidates run deepest-low first (least overhang needed), then the original
    // height, then shallower and lateral points — the first whose ray verifiably hits the
    // gap-facing face becomes the aim.
    private Vec3d selectSideBridgeAim(MinecraftClient client, ClientPlayerEntity player, BlockPos sideSource, StaircaseDescentPlanner.Direction2d direction, Direction face) {
        if (client == null || client.world == null || player == null || sideSource == null || direction == null || face == null) {
            return null;
        }
        Vec3d eye = player.getEyePos();
        double reach = Math.min(McbotFabricClient.TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        double[][] offsets = {
            {0.0D, -0.45D, 0.0D},
            {0.0D, -0.3D, 0.0D},
            {0.0D, -0.15D, 0.0D},
            {-direction.dz() * 0.3D, -0.3D, direction.dx() * 0.3D},
            {direction.dz() * 0.3D, -0.3D, -direction.dx() * 0.3D},
        };
        for (double[] o : offsets) {
            Vec3d point = Vec3d.ofCenter(sideSource).add(direction.dx() * 0.45D + o[0], o[1], direction.dz() * 0.45D + o[2]);
            if (eye.squaredDistanceTo(point) > reach * reach) {
                continue;
            }
            BlockHitResult hit = client.world.raycast(new RaycastContext(
                eye, point, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
            if (hit != null && hit.getType() == HitResult.Type.BLOCK && sideSource.equals(hit.getBlockPos()) && hit.getSide() == face) {
                return point;
            }
        }
        return null;
    }

    private boolean hasClearLineToDescentSideFace(MinecraftClient client, ClientPlayerEntity player, BlockPos sideSource, StaircaseDescentPlanner.Direction2d direction, Direction face) {
        if (client == null || client.world == null || player == null || sideSource == null || direction == null || face == null) {
            return false;
        }
        Vec3d eye = player.getEyePos();
        Vec3d point = sideBridgeFacePoint(sideSource, direction);
        double reach = Math.min(McbotFabricClient.TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        if (eye.squaredDistanceTo(point) > reach * reach) {
            return false;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye, point, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
        return hit != null && hit.getType() == HitResult.Type.BLOCK && sideSource.equals(hit.getBlockPos()) && hit.getSide() == face;
    }

    private BlockPlaceController.PlaceSpec descentSupportPlaceSpec(ClientPlayerEntity player) {
        if (player == null) {
            return null;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String itemId = net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
            BlockPlaceController.PlaceSpec spec = McbotFabricClient.descentSupportPlaceSpecForItem(itemId);
            if (spec != null) {
                return spec;
            }
        }
        return null;
    }

    private boolean hasDescentSupportFillerItem(ClientPlayerEntity player) {
        if (player == null) {
            return false;
        }
        int end = Math.min(36, player.getInventory().size());
        for (int slot = 0; slot < end; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            if (McbotFabricClient.isDescentSupportFillerItem(shell.itemId(stack))) {
                return true;
            }
        }
        return false;
    }

    // Confirm the bot can see/reach the foundation block from its current eye position. Raycasts to
    // the block CENTRE (so the ray enters the block rather than stopping just above its top face, the
    // way an offset face-point would when looking steeply down from above) and requires the first hit
    // to be the foundation within interaction reach. Rejects gaps walled off by unbroken blocks and
    // avoids committing to a placement that would otherwise stall the run waiting for an unreachable face.
    private boolean hasClearLineToDescentFoundation(MinecraftClient client, ClientPlayerEntity player, BlockPos foundation) {
        if (client == null || client.world == null || player == null || foundation == null) {
            return false;
        }
        Vec3d eye = player.getEyePos();
        Vec3d center = Vec3d.ofCenter(foundation);
        double reach = Math.min(McbotFabricClient.TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        if (eye.squaredDistanceTo(center) > reach * reach) {
            return false;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye, center, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
        return hit != null && hit.getType() == HitResult.Type.BLOCK && foundation.equals(hit.getBlockPos());
    }

    // Bridge a missing descent support by placing a solid filler block in the open floor cell (step.support()),
    // reusing the proven BlockPlaceController. The bot's own step occludes a steep downward view of the
    // block below the gap, so we first sneak to the gap edge (sneak prevents stepping off) until the
    // line of sight clears, then place ON TOP of that block (supportOverride = step.support().down())
    // so the new block lands in the missing floor cell. On success the next tick re-evaluates the same
    // step with a solid floor; if we cannot get a clear line / a placement face, we reroute/fail.
    private ControlDecision placeDescentSupport(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs,
        String reason
    ) {
        BlockPos supportCell = step.support();
        BlockPos foundation = supportCell.down();
        BlockPlaceController.PlaceSpec supportSpec = descentSupportPlaceSpec(player);
        if (supportSpec == null) {
            int hotbarMove = shell.moveInventoryItemToHotbar(
                client,
                player,
                McbotFabricClient::isDescentSupportFillerItem,
                run.commandId,
                "descent_support"
            );
            if (hotbarMove >= 0 || hotbarMove == -2) {
                return new ControlDecision(shell.stopFrom(effective, "descent_support_hotbar_move:" + step.index()), InputState.stop());
            }
            return rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_no_support_block_hotbar");
        }
        String commandId = run.commandId + ":support:" + step.index();
        boolean awaitingVerification = shell.blockPlaceController().isAwaitingVerification(commandId);
        // Hold sneak while at the gap edge so aiming/placing never walks the bot off into the gap.
        InputState sneakStop = new InputState(false, false, false, false, false, true, 0.0F, 0.0F);

        // WATER-SEAL: for descent_water_adjacent the placement target IS the water cell — placing
        // against any solid neighbor face that points into it replaces the water. v2 (an observed regression,
        // the first live seal: the bot's eye sits nearly LEVEL with the underwater floor's top
        // face, so the top-only ray grazed the lip and never connected): try the floor face first,
        // then the four horizontal neighbor faces — first face with a verified raycast hit wins,
        // the use_bed candidate lesson applied to placement.
        boolean waterSeal = reason != null && reason.startsWith("descent_water_adjacent:");
        Vec3d sealAim = null;
        if (waterSeal) {
            BlockPos sealCell = firstAdjacentWaterBlock(client, step);
            if (sealCell == null) {
                // Water gone (current shifted / already sealed): let the step re-evaluate.
                return new ControlDecision(shell.stopFrom(effective, "descent_water_seal_clear"), InputState.stop());
            }
            supportCell = sealCell;
            foundation = null;
            BlockPos[] sealNeighbors = {
                sealCell.down(), sealCell.north(), sealCell.south(), sealCell.east(), sealCell.west()
            };
            for (BlockPos neighbor : sealNeighbors) {
                BlockState neighborState = client.world.getBlockState(neighbor);
                if (neighborState.getCollisionShape(client.world, neighbor).isEmpty()
                    || shell.isHazardBlockState(neighborState)) {
                    continue;
                }
                // Shared-face centre, endpoint 0.05 INSIDE the neighbor (the same lesson: a point
                // outside the block ends the ray in air/water and never registers).
                Vec3d toSeal = new Vec3d(
                    sealCell.getX() - neighbor.getX(),
                    sealCell.getY() - neighbor.getY(),
                    sealCell.getZ() - neighbor.getZ());
                Vec3d candidate = new Vec3d(
                    neighbor.getX() + 0.5D + toSeal.x * 0.45D,
                    neighbor.getY() + 0.5D + toSeal.y * 0.45D,
                    neighbor.getZ() + 0.5D + toSeal.z * 0.45D);
                BlockHitResult sealHit = client.world.raycast(new RaycastContext(
                    player.getEyePos(), candidate,
                    RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
                if (sealHit != null && sealHit.getType() == HitResult.Type.BLOCK
                    && neighbor.equals(sealHit.getBlockPos())) {
                    foundation = neighbor;
                    sealAim = candidate;
                    break;
                }
            }
            if (foundation == null) {
                // No clickable face from this stance: keep the old floor-top behavior and let the
                // sneak-nudge hunt for it (the pre-v2 path).
                foundation = sealCell.down();
            }
        }
        // SIDE mode engages when the gap has no foundation directly beneath it (deep cave mouth):
        // bridge off the vertical face of the block under the bot's own standing block instead.
        // COLUMN-REPAIR mode engages when even that block is air (overhang lip): top-place into the
        // side-source cell first; the side bridge proceeds off the repaired block on a later tick.
        boolean sideBridge = !waterSeal && !shell.isStableDescentSupport(client, foundation);
        BlockPos sideSource = sideBridge ? descentSideBridgeSource(step, run.direction) : null;
        Direction sideFace = sideBridge
            ? Direction.fromVector(run.direction.dx(), 0, run.direction.dz())
            : null;
        if (sideBridge && (sideSource == null || sideFace == null)) {
            return rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_side_invalid");
        }
        boolean columnRepair = sideBridge
            && !shell.isStableDescentSupport(client, sideSource)
            && client.world.getBlockState(sideSource).isAir()
            && shell.isStableDescentSupport(client, sideSource.down());

        // TOP mode tries the face centre first, then a near-edge point biased toward the player
        // (observed: both LOS timeouts were TOP mode on steep faces — the gap walls occlude the
        // centre from the sneak stance; the near edge stays visible). The passing candidate becomes
        // the aim, so the placer's look-ray crosses the same point.
        Vec3d topAim = null;
        if (!sideBridge && !columnRepair) {
            Vec3d center = new Vec3d(foundation.getX() + 0.5D, foundation.getY() + 1.0D, foundation.getZ() + 0.5D);
            if (waterSeal && sealAim != null) {
                // Seal v2: the verified neighbor-face candidate IS the aim (raycast-checked above).
                topAim = sealAim;
            } else if (hasClearLineToDescentFoundation(client, player, foundation)) {
                topAim = center;
            } else {
                Vec3d towardPlayer = new Vec3d(
                    player.getX() - (foundation.getX() + 0.5D), 0.0D, player.getZ() - (foundation.getZ() + 0.5D));
                if (towardPlayer.lengthSquared() > 1.0E-4D) {
                    towardPlayer = towardPlayer.normalize();
                    Vec3d nearEdge = new Vec3d(
                        foundation.getX() + 0.5D + towardPlayer.x * 0.45D,
                        foundation.getY() + 0.95D,
                        foundation.getZ() + 0.5D + towardPlayer.z * 0.45D
                    );
                    BlockHitResult edgeHit = client.world.raycast(new RaycastContext(
                        player.getEyePos(), nearEdge,
                        RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
                    if (edgeHit != null && edgeHit.getType() == HitResult.Type.BLOCK
                        && foundation.equals(edgeHit.getBlockPos())
                        && edgeHit.getSide() == Direction.UP) {
                        topAim = nearEdge;
                    }
                }
            }
        }
        Vec3d sideAim = (sideBridge && !columnRepair)
            ? selectSideBridgeAim(client, player, sideSource, run.direction, sideFace)
            : null;
        boolean lineClear = columnRepair
            ? hasClearLineToDescentColumnRepair(client, player, sideSource.down(), run.direction)
            : sideBridge
                ? sideAim != null
                : topAim != null;
        if (!awaitingVerification && !lineClear) {
            if (run.bridgeNudgeStartedAtMs == 0L) {
                run.bridgeNudgeStartedAtMs = nowMs;
            }
            if (nowMs - run.bridgeNudgeStartedAtMs > McbotFabricClient.DESCENT_BRIDGE_NUDGE_TIMEOUT_MS) {
                run.bridgeNudgeStartedAtMs = 0L;
                String losMode = waterSeal ? "seal" : columnRepair ? "repair" : sideBridge ? "side" : "top";
                return rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_no_line_of_sight:" + losMode);
            }
            // Sneak-shuffle toward the gap (look at the target, walk forward under sneak; sneak
            // lets the eye overhang the edge without falling — required for the side face).
            Vec3d nudgeTarget = columnRepair
                ? columnRepairAimPoint(sideSource.down(), run.direction)
                : sideBridge
                    ? sideBridgeFacePoint(sideSource, run.direction)
                    : Vec3d.ofCenter(foundation);
            McbotFabricClient.LookAngles edgeLook = shell.lookAnglesToPoint(player, nudgeTarget);
            InputState sneakForward = new InputState(true, false, false, false, false, true, 1.0F, 0.0F);
            return new ControlDecision(
                shell.lookIntentForAngles(effective, edgeLook.yaw(), edgeLook.pitch(), "descent_support_edge:" + step.index()),
                sneakForward
            );
        }
        run.bridgeNudgeStartedAtMs = 0L;

        // TOP mode: aim at the centre of the foundation's top face (placement resolves to the gap
        // cell above via supportOverride). SIDE mode: aim at the gap-facing vertical face of the
        // side source; the generic raycast place path resolves hitBlock.offset(face) = the gap cell.
        // REPAIR mode: aim at the gap-side edge of the repair foundation's top face (centre aim
        // would be occluded by the bot's own standing block).
        Vec3d aimPoint = columnRepair
            ? columnRepairAimPoint(sideSource.down(), run.direction)
            : sideBridge
                ? (sideAim != null ? sideAim : sideBridgeFacePoint(sideSource, run.direction))
                : (topAim != null
                    ? topAim
                    : new Vec3d(foundation.getX() + 0.5D, foundation.getY() + 1.0D, foundation.getZ() + 0.5D));
        McbotFabricClient.LookAngles placeLook = shell.lookAnglesToPoint(player, aimPoint);
        boolean lookAligned = Math.abs(LookController.normalizeYaw(placeLook.yaw() - player.getYaw())) <= McbotFabricClient.WORKSTATION_PLACE_LOOK_TOLERANCE_DEG
            && Math.abs(placeLook.pitch() - player.getPitch()) <= McbotFabricClient.WORKSTATION_PLACE_LOOK_TOLERANCE_DEG;
        if (!awaitingVerification && !lookAligned) {
            return new ControlDecision(
                shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "descent_support_face:" + step.index()),
                sneakStop
            );
        }

        BlockPlaceController.Result result = shell.blockPlaceController().tick(
            client, player, commandId, nowMs,
            columnRepair ? sideSource.down() : sideBridge ? null : foundation,
            supportSpec);
        shell.logger().info(
            "descent.place_support instanceId={} commandId={} step={} supportCell={} foundation={} status={} reason={} placedBlock={} selectedItem={} bridges={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            step.index(),
            supportCell.toShortString(),
            columnRepair ? "repair:" + sideSource.toShortString()
                : sideBridge ? "side:" + sideSource.toShortString()
                : (waterSeal ? "seal:" : "top:") + foundation.toShortString(),
            result.status(),
            result.reason(),
            McbotFabricClient.formatBlockPos(result.placedBlock()),
            shell.selectedItemId(player),
            run.supportBridges,
            result.elapsedMs()
        );
        if (result.status() == BlockPlaceController.Status.PLACED) {
            if (columnRepair) {
                // The repair block must land in the side-source cell; the step support is STILL
                // missing afterwards — the planner re-enters next tick and the side bridge proceeds
                // off the repaired block.
                if (!sideSource.equals(result.placedBlock())) {
                    return rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_repair_misplaced");
                }
                run.supportBridges++;
                return new ControlDecision(shell.stopFrom(effective, "descent_support_column_repaired:" + step.index()), sneakStop);
            }
            // SIDE mode places via the generic raycast path, so verify the block actually landed in
            // the gap cell; a drifted aim placing elsewhere must not count as a bridge.
            if (sideBridge && !supportCell.equals(result.placedBlock())) {
                return rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_side_misplaced");
            }
            run.supportBridges++;
            return new ControlDecision(shell.stopFrom(effective, "descent_support_placed:" + step.index()), sneakStop);
        }
        if (result.status() == BlockPlaceController.Status.FAILED) {
            return rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_failed:" + result.reason());
        }
        return new ControlDecision(
            shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "descent_support_placing:" + result.reason()),
            sneakStop
        );
    }

    private ControlDecision rerouteOrFailDescent(
        BrainLink.Intent effective,
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step rejectedStep,
        long nowMs,
        String reason
    ) {
        run.rejectedMoves.add(descentMoveKey(run.currentFeet, run.direction));
        DescentHazardMemory.HazardMarker rejectedHazard = DescentHazardMemory.parseRejectedStepHazard(reason);
        if (rejectedHazard != null) {
            run.rejectedHazards.add(rejectedHazard);
        }
        if (run.reroutes >= Math.max(McbotFabricClient.DESCENT_MAX_REROUTES, run.depth)) {
            ControlDecision safeFall = maybeBeginSafeFallForOpenAirGap(effective, client, player, run, rejectedStep, nowMs, reason);
            if (safeFall != null) {
                return safeFall;
            }
            ControlDecision mineThrough = maybeBeginMineThroughDescent(effective, client, run, nowMs, reason);
            if (mineThrough != null) {
                return mineThrough;
            }
            return failDescent(effective, run, nowMs, reason + ":reroute_limit");
        }
        StaircaseDescentPlanner.Direction2d reroute = StaircaseDescentPlanner.chooseReroute(
            run.direction,
            direction -> isDescentRerouteCandidateSafe(client, run, direction)
        );
        if (reroute == null) {
            ControlDecision safeFall = maybeBeginSafeFallForOpenAirGap(effective, client, player, run, rejectedStep, nowMs, reason);
            if (safeFall != null) {
                return safeFall;
            }
            ControlDecision mineThrough = maybeBeginMineThroughDescent(effective, client, run, nowMs, reason);
            if (mineThrough != null) {
                return mineThrough;
            }
            return failDescent(effective, run, nowMs, reason + ":no_safe_reroute");
        }
        StaircaseDescentPlanner.Direction2d previous = run.direction;
        run.direction = reroute;
        run.reroutes++;
        if (reason.startsWith("descent_next_support_missing")) {
            run.openAirReroutes++;
        } else if (reason.startsWith("descent_hazard") || reason.startsWith("descent_lava") || reason.startsWith("descent_water")) {
            run.hazardReroutes++;
        }
        run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        clearDescentMoveProgress(run);
        shell.logger().info(
            "descent.reroute instanceId={} commandId={} step={} depthReached={} currentFeet={} previousDirection={} newDirection={} rejectedNextFeet={} rejectedSupport={} reason={} reroutes={} openAirReroutes={} hazardReroutes={}",
            shell.instanceId(),
            run.commandId,
            run.stepIndex,
            run.depthReached,
            run.currentFeet.toShortString(),
            previous.name(),
            reroute.name(),
            rejectedStep.nextFeet().toShortString(),
            rejectedStep.support().toShortString(),
            reason,
            run.reroutes,
            run.openAirReroutes,
            run.hazardReroutes
        );
        return new ControlDecision(shell.stopFrom(effective, "descent_reroute:" + reason + ":" + reroute.name()), InputState.stop());
    }

    // Last-resort guard before the terminal failDescent refusals in rerouteOrFailDescent: only when the
    // stall is an OPEN-AIR gap (missing next support / move stalled / bridge had no line of sight) and a
    // safe-fall hasn't already been tried this run, attempt a controlled drop. Hazard/lava/water reroute
    // reasons are deliberately excluded — never fall toward a hazard. Returns the launch decision, or
    // null to let the caller fall through to its original failDescent.
    private ControlDecision maybeBeginSafeFallForOpenAirGap(
        BrainLink.Intent effective,
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step rejectedStep,
        long nowMs,
        String reason
    ) {
        boolean openAirGap = reason.startsWith("descent_next_support_missing")
                          || reason.startsWith("descent_move_stalled")
                          || reason.contains("bridge_no_line_of_sight");
        if (openAirGap && !run.safeFallAttempted) {
            SafeFall fall = canSafeFallFromStall(client, player, run, rejectedStep);
            if (fall != null) {
                return beginSafeFall(effective, run, player, rejectedStep, fall, nowMs);
            }
        }
        return null;
    }

    // Mine-through-to-descend: the last resort before the terminal failures (no_safe_reroute /
    // reroute_limit, the a live run descent_recovery_exhausted family). Pick the heading whose tunnel
    // floor stays solid the longest (ties prefer digging into rock over walking a rim ledge),
    // enter tunnel mode, and let the step loop carve level cells until the down-step is safe
    // again. Covers the open-air family plus the water-adjacent flavor (repro: aquifer bands at
    // y40-44 aborted the mission twice with descent_water_adjacent:...:no_safe_reroute): water is
    // safe to tunnel AWAY from because every candidate level step re-runs descentStepUnsafeReason,
    // which rejects water-adjacent tunnel cells — the chosen heading is always dry. Lava and other
    // hazards stay excluded: a hidden lava pocket behind a carved wall is lethal, water is not.
    // The per-run block budget keeps a pathological rim bounded.
    private ControlDecision maybeBeginMineThroughDescent(
        BrainLink.Intent effective,
        MinecraftClient client,
        DescentRun run,
        long nowMs,
        String reason
    ) {
        boolean recoverableStall = reason.startsWith("descent_next_support_missing")
                                || reason.startsWith("descent_move_stalled")
                                || reason.contains("bridge_no_line_of_sight")
                                || reason.startsWith("descent_water_adjacent");
        if (!recoverableStall || run.tunnelBlocksUsed >= DESCENT_TUNNEL_MAX_BLOCKS) {
            return null;
        }
        // WATER markers are excluded from the proximity veto here (only here — sideways down-step
        // reroutes keep the full set): the Chebyshev-2 box around a water cell touching the step
        // envelope always contains every 1-away level candidate, so keeping them would veto ALL
        // tunnel headings on exactly the water stalls this recovery exists for. Dryness is still
        // enforced per candidate — descentStepUnsafeReason rejects any genuinely water-adjacent
        // tunnel cell. Lethal markers (lava, in-step hazards) keep the wide berth.
        Set<DescentHazardMemory.HazardMarker> lethalHazards = new HashSet<>();
        for (DescentHazardMemory.HazardMarker marker : run.rejectedHazards) {
            if (!"water".equals(marker.kind())) {
                lethalHazards.add(marker);
            }
        }
        StaircaseDescentPlanner.Direction2d best = null;
        int bestScore = -1;
        for (StaircaseDescentPlanner.Direction2d candidate : descentTunnelCandidates(run.direction)) {
            StaircaseDescentPlanner.Step levelCandidate =
                StaircaseDescentPlanner.levelStepFrom(run.currentFeet, candidate, run.stepIndex);
            if (descentStepUnsafeReason(client, levelCandidate) != null
                || DescentHazardMemory.candidateTooCloseToKnownHazard(levelCandidate, lethalHazards)) {
                continue;
            }
            int score = descentTunnelHeadingScore(client, run.currentFeet, candidate);
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        if (best == null) {
            return null;
        }
        StaircaseDescentPlanner.Direction2d previous = run.direction;
        run.tunnelMode = true;
        run.tunnelSegments++;
        run.direction = best;
        run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        clearDescentMoveProgress(run);
        shell.logger().warn(
            "descent.mine_through_start instanceId={} commandId={} step={} feet={} previousDirection={} direction={} score={} tunnelBlocksUsed={} tunnelSegments={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.stepIndex,
            run.currentFeet.toShortString(),
            previous.name(),
            best.name(),
            bestScore,
            run.tunnelBlocksUsed,
            run.tunnelSegments,
            reason
        );
        return new ControlDecision(shell.stopFrom(effective, "descent_mine_through:" + best.name()), InputState.stop());
    }

    // Sideways/reverse first (the rim escape is almost never straight ahead), current heading last.
    private static List<StaircaseDescentPlanner.Direction2d> descentTunnelCandidates(StaircaseDescentPlanner.Direction2d current) {
        List<StaircaseDescentPlanner.Direction2d> candidates =
            new java.util.ArrayList<>(StaircaseDescentPlanner.rerouteCandidates(current));
        candidates.add(current);
        return candidates;
    }

    // Solid-floor run length ahead (dominant) plus solid body cells to carve into (tiebreak): a
    // heading through the massif beats one skirting the cavern on a thin ledge.
    private int descentTunnelHeadingScore(MinecraftClient client, BlockPos feet, StaircaseDescentPlanner.Direction2d direction) {
        int floorRun = 0;
        for (int k = 1; k <= DESCENT_TUNNEL_PROBE_CELLS; k++) {
            if (!shell.isStableDescentSupport(client, feet.add(direction.dx() * k, -1, direction.dz() * k))) {
                break;
            }
            floorRun++;
        }
        int wallDepth = 0;
        for (int k = 1; k <= DESCENT_TUNNEL_PROBE_CELLS; k++) {
            BlockPos bodyCell = feet.add(direction.dx() * k, 0, direction.dz() * k);
            if (client.world.getBlockState(bodyCell).getCollisionShape(client.world, bodyCell).isEmpty()) {
                break;
            }
            wallDepth++;
        }
        return floorRun * 2 + wallDepth;
    }

    private boolean isDescentRerouteCandidateSafe(MinecraftClient client, DescentRun run, StaircaseDescentPlanner.Direction2d direction) {
        if (run.rejectedMoves.contains(descentMoveKey(run.currentFeet, direction))) {
            return false;
        }
        StaircaseDescentPlanner.Step candidate = StaircaseDescentPlanner.stepFrom(run.currentFeet, direction, run.stepIndex);
        return !StaircaseDescentPlanner.targetsSelfSupport(candidate)
            && descentStepUnsafeReason(client, candidate) == null
            && !DescentHazardMemory.candidateTooCloseToKnownHazard(candidate, run.rejectedHazards);
    }

    private String descentMoveKey(BlockPos feet, StaircaseDescentPlanner.Direction2d direction) {
        return feet.toShortString() + ":" + direction.name();
    }

    private double nearestHostileDistance(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return -1.0D;
        }
        double nearestSquared = Double.POSITIVE_INFINITY;
        for (net.minecraft.entity.Entity entity : client.world.getEntities()) {
            if (entity instanceof net.minecraft.entity.mob.HostileEntity && entity.isAlive()) {
                nearestSquared = Math.min(nearestSquared, entity.squaredDistanceTo(player));
            }
        }
        return Double.isFinite(nearestSquared) ? Math.sqrt(nearestSquared) : -1.0D;
    }

    private ControlDecision completeDescent(BrainLink.Intent effective, DescentRun run, ClientPlayerEntity player, long nowMs, String reason) {
        ledger.markComplete(run.commandId, "descent_complete:" + reason);
        shell.logger().info(
            "descent.complete instanceId={} commandId={} reason={} start={} final={} depth={} depthReached={} reroutes={} openAirReroutes={} hazardReroutes={} healthBefore={} healthAfter={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            reason,
            run.startFeet.toShortString(),
            player.getBlockPos().toShortString(),
            run.depth,
            run.depthReached,
            run.reroutes,
            run.openAirReroutes,
            run.hazardReroutes,
            run.healthBefore,
            player.getHealth(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRun = null;
        shell.recordCompletedDescentPath(run.commandId, run.reachedFeet);
        shell.completeCurrentCommand(run.commandId, "descent_complete:" + reason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, "descent_complete:" + reason), InputState.stop());
    }

    private ControlDecision failDescent(BrainLink.Intent effective, DescentRun run, long nowMs, String reason) {
        ledger.markComplete(run.commandId, "descent_failed:" + reason);
        // Retry-rotation memory: a follow-up descend near this point takes a 90-degree
        // rotated heading instead of re-digging the same line into the same cavern.
        lastDescentFailurePos = run.startFeet;
        lastDescentFailureAtMs = nowMs;
        shell.logger().warn(
            "descent.failed instanceId={} commandId={} reason={} start={} step={} depth={} depthReached={} reroutes={} openAirReroutes={} hazardReroutes={} stage={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            reason,
            run.startFeet.toShortString(),
            run.stepIndex,
            run.depth,
            run.depthReached,
            run.reroutes,
            run.openAirReroutes,
            run.hazardReroutes,
            run.stage,
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRun = null;
        shell.completeCurrentCommand(run.commandId, "descent_failed:" + reason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, "descent_failed:" + reason), InputState.stop());
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    static final class DescentRun {
        final String commandId;
        final BlockPos startFeet;
        final int depth;
        final long startedAtMs;
        final float healthBefore;
        final Set<String> rejectedMoves = new HashSet<>();
        final Set<DescentHazardMemory.HazardMarker> rejectedHazards = new HashSet<>();
        final List<BlockPos> reachedFeet = new java.util.ArrayList<>();
        BlockPos currentFeet;
        StaircaseDescentPlanner.Direction2d direction;
        int stepIndex = 1;
        int depthReached = 0;
        int reroutes = 0;
        int openAirReroutes = 0;
        int hazardReroutes = 0;
        int supportBridges = 0;
        long bridgeNudgeStartedAtMs = 0L;
        DescentControlPlanner.Stage stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        BlockPos recoveryClearTarget = null;
        String recoveryClearPhase = "";
        // Controlled safe-fall latch: at most ONE drop per run (safeFallAttempted caps it; after landing
        // a re-stall falls through to the original failDescent, no re-fall/no thrash). While safeFall is
        // live, safeFallColumn is the open-air cell we walked off and safeFallLandingFeet is the
        // validated landing; both clear once the re-anchor confirms touchdown.
        boolean safeFallAttempted = false;
        BlockPos safeFallColumn = null;
        BlockPos safeFallLandingFeet = null;
        // Mine-through tunnel mode: carve LEVEL steps in `direction` while the down-step is blocked
        // over open air; exits the moment the down-step turns safe or the carve budget is spent.
        // tunnelBlocksUsed is the per-run budget consumed (also the preflight timeout credit);
        // tunnelSegments counts activations (logging only).
        boolean tunnelMode = false;
        int tunnelBlocksUsed = 0;
        int tunnelSegments = 0;
        // Fall damage the committed safe-fall is expected to deal (0 until a deeper health-aware fall is
        // launched). Latched once at launch and kept for the rest of the run as the FAIL_HEALTH_LOST
        // allowed-drop tolerance, so the deliberate damage never trips the health guard but any further
        // loss still does. The one-fall-per-run latch (safeFallAttempted) keeps it from accumulating.
        float safeFallExpectedDamage = 0.0F;
        // When the safe-fall was launched (ms). The in-progress hold uses it to bound the launch->land
        // window so a wedged launch can't hang the descent.
        long safeFallLaunchedAtMs = 0L;
        BlockPos moveTargetFeet = null;
        long moveStartedAtMs = 0L;
        long moveLastProgressAtMs = 0L;
        double moveBestDistance = Double.POSITIVE_INFINITY;
        final Set<BlockPos> abandonedIronCleanupTargets = new HashSet<>();
        BlockPos ironCleanupTarget = null;
        BlockPos lastIronCleanupTarget = null;
        long ironCleanupCollectStartedAtMs = 0L;
        int ironCleanupBlocksBroken = 0;
        // Field-kit tool recovery (ported from MineNearbyIronRun): when a stone-tier pickaxe runs out
        // mid-descent, place/craft a replacement instead of aborting the mission. Mirrors the iron
        // run's fieldKitRecoveryActive / fieldKitRetrieveTablePending / fieldKitTablePlacedByRecovery /
        // proactiveToolRecoveryLogged / toolRecoveryAttempts / lastFieldKitStateLogAtMs fields.
        boolean descentFieldKitRecoveryActive = false;
        boolean descentFieldKitRetrieveTablePending = false;
        boolean descentFieldKitTablePlacedByRecovery = false;
        // Latched once the sticks-from-planks bootstrap starts, so the multi-tick 2x2 craft keeps
        // driving even while the planks are transiently on the crafting cursor (else the per-tick
        // planks>=2 guard would abort the in-flight craft). Cleared on the craft's complete/failed.
        boolean descentFieldKitSticksCraftActive = false;
        boolean descentProactiveToolRecoveryLogged = false;
        int descentToolRecoveryAttempts = 0;
        long lastDescentFieldKitStateLogAtMs = 0L;

        DescentRun(
            String commandId,
            BlockPos startFeet,
            StaircaseDescentPlanner.Direction2d direction,
            int depth,
            long startedAtMs,
            float healthBefore
        ) {
            this.commandId = commandId == null ? "" : commandId;
            this.startFeet = startFeet.toImmutable();
            this.currentFeet = startFeet.toImmutable();
            this.direction = direction;
            this.depth = depth;
            this.startedAtMs = startedAtMs;
            this.healthBefore = healthBefore;
            this.reachedFeet.add(this.startFeet);
        }

        // Field-kit recovery sub-command ids, mirroring MineNearbyIronRun's scheme
        // (commandId + ":<context>:fieldkit:<action>:" + attempts) keyed off this run's commandId.
        String toolRetrieveTableCommandId() {
            return commandId + ":descent:fieldkit:retrieve_table:" + descentToolRecoveryAttempts;
        }

        String toolCraftTableCommandId() {
            return commandId + ":descent:fieldkit:craft_table:" + descentToolRecoveryAttempts;
        }

        String toolPlaceTableCommandId() {
            return commandId + ":descent:fieldkit:place_table:" + descentToolRecoveryAttempts;
        }

        String toolCraftPickaxeCommandId() {
            return commandId + ":descent:fieldkit:craft_stone_pickaxe:" + descentToolRecoveryAttempts;
        }

        String toolCraftSticksCommandId() {
            return commandId + ":descent:fieldkit:craft_sticks:" + descentToolRecoveryAttempts;
        }
    }
}
