package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
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
    private final MiningWorkspaceController miningWorkspaceController;
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
    private static final int MISSION_IRON_PROTECTED_PLANK_RESERVE = 6;

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
    // Mine-through-to-descend (a live run descent_recovery_exhausted family): when an open-air stall has
    // no bridge, no sideways reroute, and no validated safe-fall landing, carve LEVEL tunnel steps
    // into the most-solid heading until the normal down-step turns safe again, instead of failing
    // the run at the cavern rim. The block budget bounds total carved cells per run; each carved
    // cell also earns one step's worth of extra preflight timeout, since tunnel work is real
    // progress the depth-based budget can't see. The probe depth is how far ahead the heading
    // scorer samples floor continuity and wall solidity.
    private static final int DESCENT_TUNNEL_MAX_BLOCKS = 24;
    private static final int DESCENT_TUNNEL_PROBE_CELLS = 4;

    /** One frozen launch-envelope evaluation for an open-air descent transition. */
    private record SafeFallLaunchEvaluation(
        DescentSafeFallLaunchPlanner.Decision decision,
        String signature
    ) {
    }

    private record WaterContainmentEventSnapshot(
        String commandId,
        String objectiveReason,
        String trigger,
        String waterKind,
        int step,
        String stage,
        String waterCell,
        String openedCell,
        String target,
        String support,
        String dryAnchor,
        int episode,
        int fillerUsed,
        int bridgeBudget,
        long startedAtMs
    ) {
    }

    public DescentExecutor(ShellServices shell) {
        this.shell = shell;
        this.miningWorkspaceController = new MiningWorkspaceController(shell);
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
            if (activeRun != null) {
                // A brain replan can replace an in-flight descent with a fresh command id before
                // the executor reaches one of its own terminal paths. Preserve the old run's
                // verified stance cells before discarding its controller state, just as an
                // explicit descent failure does.
                shell.recordPartialDescentPath(activeRun.commandId, activeRun.reachedFeet);
                clearPostBreakProbe(activeRun);
                clearWaterContainmentState(activeRun, true);
                clearSafeFallState(activeRun, true);
                shell.blockBreakController().reset();
            }
            miningWorkspaceController.clear();
            BlockPos startFeet = player.getBlockPos().toImmutable();
            int requestedDepth = McbotFabricClient.resolveDescentDepth(effective, startFeet.getY());
            StaircaseDescentPlanner.Direction2d direction = shell.preferredDescentDirection(
                effective,
                startFeet,
                McbotFabricClient.resolveDescentDirection(effective, startFeet, player.getYaw())
            );
            // Live repro: a retry descent started one block from the
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
            activeRun.worldIdentity = client == null ? null : client.world;
            activeRun.objectiveReason = effective.reason() == null ? "" : effective.reason();
            activeRun.remainingMissionIronCount = effective.remainingMissionIronCount();
            activeRun.reservedIronPickaxeCount = effective.reservedIronPickaxeCount();
            activeRun.reservedIronPickaxeDurabilityFloor = effective.reservedIronPickaxeDurabilityFloor();
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
        if (run.worldIdentity != (client == null ? null : client.world)) {
            return failDescent(effective, run, nowMs, "descent_world_changed");
        }
        long elapsedMs = Math.max(0L, nowMs - run.startedAtMs);
        String currentHazardReason = currentPlayerDescentHazardReason(client, player);
        boolean onGround = player.isOnGround();
        BlockPos actualFeet = player.getBlockPos().toImmutable();
        boolean actualDry = isDryDescentBody(client, player, actualFeet);
        boolean actualBodyClear = isClearDescentBody(client, actualFeet);
        boolean actualSupportStable = shell.isStableDescentSupport(client, actualFeet.down());
        armObservedPostBreakProbe(client, run, nowMs);
        if (run.lastVerifiedDryFeet == null
            && run.depthReached == 0
            && run.stepIndex == 1
            && actualFeet.equals(run.startFeet)
            && onGround
            && actualDry
            && actualBodyClear
            && actualSupportStable) {
            run.lastVerifiedDryFeet = actualFeet;
        }
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
            || preflightDecision.action() == DescentControlPlanner.Action.FAIL_HOSTILE_NEARBY) {
            return failDescent(effective, run, nowMs, preflightDecision.reason());
        }
        if (preflightDecision.action() == DescentControlPlanner.Action.FAIL_PLAYER_HAZARD
            || preflightDecision.action() == DescentControlPlanner.Action.WAIT_ON_GROUND) {
            observePreflightArrivalSuppression(client, player, run, null);
        }
        if (preflightDecision.action() == DescentControlPlanner.Action.FAIL_PLAYER_HAZARD
            && !isWaterPlayerHazard(currentHazardReason)) {
            return failDescent(effective, run, nowMs, preflightDecision.reason());
        }
        if (preflightDecision.action() == DescentControlPlanner.Action.FAIL_PLAYER_HAZARD
            && isWaterPlayerHazard(currentHazardReason)
            && run.safeFallController.active()
            && run.safeFallController.departed()) {
            return rejectSafeFallLanding(
                effective,
                player,
                run,
                nowMs,
                "water_after_departure"
            );
        }
        if (preflightDecision.action() == DescentControlPlanner.Action.FAIL_PLAYER_HAZARD
            && run.waterContainment.phase() == DescentWaterContainmentController.Phase.IDLE) {
            if (run.lastVerifiedDryFeet == null) {
                return failDescent(effective, run, nowMs, preflightDecision.reason());
            }
            StaircaseDescentPlanner.Step wetStep = run.postBreakStep != null
                ? run.postBreakStep
                : currentDescentStep(run);
            DescentWaterContainmentController.Trigger wetTrigger = run.postBreakProbePending
                ? DescentWaterContainmentController.Trigger.POST_BREAK_BREACH
                : DescentWaterContainmentController.Trigger.PLAYER_WET;
            BlockPos wetCell = run.postBreakProbePending && wetStep != null
                ? descentStepWaterCell(client, wetStep)
                : findPlayerWaterCell(client, player);
            if (wetCell == null) {
                wetCell = findPlayerWaterCell(client, player);
            }
            if (wetCell == null) {
                return failDescent(effective, run, nowMs, preflightDecision.reason());
            }
            startWaterContainment(
                client,
                player,
                run,
                wetStep,
                wetTrigger,
                wetCell,
                run.postBreakOpenedCell,
                nowMs,
                false
            );
        }
        if (run.waterContainment.phase() != DescentWaterContainmentController.Phase.IDLE) {
            return resolveWaterContainment(client, player, effective, run, nowMs);
        }
        if (run.postBreakProbePending && run.postBreakStep != null) {
            DescentStepSafetyPolicy.Result postBreakSafety =
                descentStepSafety(client, run.postBreakStep);
            if (isWaterSafety(postBreakSafety)) {
                BlockPos waterCell = descentStepWaterCell(client, run.postBreakStep);
                startWaterContainment(
                    client,
                    player,
                    run,
                    run.postBreakStep,
                    DescentWaterContainmentController.Trigger.POST_BREAK_BREACH,
                    waterCell,
                    run.postBreakOpenedCell,
                    nowMs,
                    canSealDescentWater(client, player, run, run.postBreakStep, waterCell)
                );
                return resolveWaterContainment(client, player, effective, run, nowMs);
            }
            run.postBreakDryPolls++;
            if (!DescentWaterContainmentController.postBreakProbeComplete(
                run.postBreakDryPolls,
                Math.max(0L, nowMs - run.postBreakProbeStartedAtMs)
            )) {
                return new ControlDecision(
                    shell.stopFrom(effective, "descent_post_break_dry_probe"),
                    InputState.stop()
                );
            }
            if (run.postBreakAdvanceStage) {
                run.stage = resolvedPostBreakStage(
                    run.stage,
                    run.postBreakPhase,
                    true
                );
            }
            clearPostBreakProbe(run);
        }
        // A committed safe fall owns every tick from clearance through the two-poll landing
        // commitment. This must precede terminal-depth admission as well as WAIT_ON_GROUND: a first
        // fall into the y13-y16 band is not a valid workspace stance until the frozen landing has
        // been proved dry, supported, and stable twice and committed to the descent trail.
        if (run.safeFallController.active()) {
            return resolveActiveSafeFallControl(client, player, effective, run, nowMs);
        }
        if (run.safeFallHandoffPending) {
            return resolvePendingSafeFallHandoff(effective, client, player, run, nowMs);
        }
        boolean workspacePolicyApplies = MiningWorkspaceDepthPolicy.applies(
            commandId,
            effective.reason(),
            effective.targetY()
        );
        boolean immediateTargetDepthAdmission = run.depthReached == 0
            && !run.targetDepthAdmissionActive
            && MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
                commandId,
                effective.reason(),
                effective.targetY(),
                actualFeet.getY(),
                onGround,
                actualDry,
                actualBodyClear,
                actualSupportStable
            );
        if (immediateTargetDepthAdmission) {
            run.terminalLandingReached = true;
            run.targetDepthAdmissionActive = true;
            if (!run.targetDepthAdmissionLogged) {
                run.targetDepthAdmissionLogged = true;
                shell.logger().info(
                    "descent.target_depth_admitted instanceId={} commandId={} objectiveReason={} targetY={} actualFeet={} grounded={} dry={} bodyClear={} supportStable={} elapsedMs={} reason=target_depth_already_reached",
                    shell.instanceId(),
                    run.commandId,
                    effective.reason(),
                    effective.targetY(),
                    actualFeet.toShortString(),
                    onGround,
                    actualDry,
                    actualBodyClear,
                    actualSupportStable,
                    elapsedMs
                );
            }
        }
        if (run.targetDepthAdmissionActive) {
            if (!shell.hasValidMiningWorkspaceAtDepth(client, commandId, effective.targetY())) {
                ControlDecision workspace = resolveMiningWorkspace(
                    client,
                    player,
                    effective,
                    run,
                    nowMs
                );
                if (workspace != null) {
                    return workspace;
                }
            }
            if (!shell.hasValidMiningWorkspaceAtDepth(client, commandId, effective.targetY())) {
                return failDescent(
                    effective,
                    run,
                    nowMs,
                    "workspace_unavailable:placement_verification"
                );
            }
            return completeDescent(
                effective,
                run,
                player,
                nowMs,
                "target_depth_already_reached",
                true,
                true
            );
        }
        if (workspacePolicyApplies) {
            run.terminalLandingReached = MiningWorkspaceDepthPolicy.latchTerminalLanding(
                run.terminalLandingReached,
                actualFeet.getY(),
                effective.targetY()
            );
        }
        if (run.terminalLandingReached
            && miningWorkspaceController.activeFor(commandId)
            && !shell.hasValidMiningWorkspaceAtDepth(client, commandId, effective.targetY())) {
            ControlDecision workspace = resolveMiningWorkspace(
                client,
                player,
                effective,
                run,
                nowMs
            );
            if (workspace != null) {
                return workspace;
            }
        }
        if (preflightDecision.action() == DescentControlPlanner.Action.WAIT_ON_GROUND) {
            return new ControlDecision(shell.stopFrom(effective, preflightDecision.reason()), InputState.stop());
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
        BlockPos canonicalSupportConflict = firstCanonicalSupportConflict(step);
        if (canonicalSupportConflict != null) {
            logCanonicalSupportVeto(
                run,
                step,
                canonicalSupportConflict,
                "planning",
                nowMs
            );
            return rerouteOrFailDescent(
                effective,
                client,
                player,
                run,
                step,
                nowMs,
                "descent_preserve_canonical_surface_trail_support"
            );
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
        DescentStepSafetyPolicy.Result stepSafety = step == null
            ? DescentStepSafetyPolicy.classify(null)
            : descentStepSafety(client, step);
        if (step != null
            && isWaterSafety(stepSafety)
            && run.waterContainment.phase() == DescentWaterContainmentController.Phase.IDLE) {
            BlockPos waterCell = descentStepWaterCell(client, step);
            boolean stepLaunchActive = run.stage == DescentControlPlanner.Stage.MOVE_TO_STEP
                || run.moveStartedAtMs > 0L;
            startWaterContainment(
                client,
                player,
                run,
                step,
                DescentWaterContainmentController.Trigger.SUPPORT_WATER,
                waterCell,
                null,
                nowMs,
                !stepLaunchActive
                    && canSealDescentWater(client, player, run, step, waterCell)
            );
            return resolveWaterContainment(client, player, effective, run, nowMs);
        }
        String unsafeReason = stepSafety.reason();
        DescentStepArrivalValidator.Decision arrival = step == null
            ? null
            : run.arrivalValidator.tick(
                run.commandId + ":" + step.index() + ":" + step.nextFeet().toShortString(),
                new DescentStepArrivalValidator.Observation(
                    voxelCell(step.nextFeet()),
                    voxelCell(player.getBlockPos()),
                    descentStepHorizontalDistance(player, step.nextFeet()),
                    McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON,
                    player.isOnGround(),
                    !player.isTouchingWater() && actualDry,
                    isClearDescentBody(client, player.getBlockPos()),
                    stepSafety.kind() != DescentStepSafetyPolicy.Kind.HAZARD
                        && stepSafety.kind() != DescentStepSafetyPolicy.Kind.ADJACENT_LAVA,
                    shell.isStableDescentSupport(client, step.support())
                )
            );
        boolean reachedStep = arrival != null
            && arrival.status() == DescentStepArrivalValidator.Status.REACHED;
        if (arrival != null
            && arrival.status() == DescentStepArrivalValidator.Status.SUPPRESSED
            && arrival.suppressionEvent()) {
            shell.logger().warn(
                "descent.step_arrival_suppressed instanceId={} commandId={} step={} target={} support={} actualFeet={} grounded={} wet={} bodyClear={} hazardFree={} supportStable={} arrivalPolls={} reason={}",
                shell.instanceId(),
                run.commandId,
                step.index(),
                step.nextFeet().toShortString(),
                step.support().toShortString(),
                player.getBlockPos().toShortString(),
                player.isOnGround(),
                player.isTouchingWater(),
                isClearDescentBody(client, player.getBlockPos()),
                stepSafety.kind() != DescentStepSafetyPolicy.Kind.HAZARD
                    && stepSafety.kind() != DescentStepSafetyPolicy.Kind.ADJACENT_LAVA,
                shell.isStableDescentSupport(client, step.support()),
                arrival.validPolls(),
                arrival.reason()
            );
        }
        if (arrival != null
            && arrival.status() == DescentStepArrivalValidator.Status.PENDING_VALID_POLL
            && unsafeReason == null) {
            return new ControlDecision(
                shell.stopFrom(effective, "descent_step_arrival_pending"),
                InputState.stop()
            );
        }
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
            if (workspacePolicyApplies) {
                run.terminalLandingReached = MiningWorkspaceDepthPolicy.latchTerminalLanding(
                    run.terminalLandingReached,
                    player.getBlockPos().getY(),
                    effective.targetY()
                );
            }
            if (run.terminalLandingReached
                && !shell.hasValidMiningWorkspaceAtDepth(client, commandId, effective.targetY())) {
                ControlDecision workspace = resolveMiningWorkspace(
                    client,
                    player,
                    effective,
                    run,
                    nowMs
                );
                if (workspace != null) {
                    return workspace;
                }
                if (!shell.hasValidMiningWorkspaceAtDepth(client, commandId, effective.targetY())) {
                    return failDescent(
                        effective,
                        run,
                        nowMs,
                        "workspace_unavailable:placement_verification"
                    );
                }
            }
            boolean workspaceReadyAtTarget = run.terminalLandingReached
                && shell.hasValidMiningWorkspaceAtDepth(client, commandId, effective.targetY());
            return completeDescent(
                effective,
                run,
                player,
                nowMs,
                stepDecision.reason(),
                run.terminalLandingReached,
                workspaceReadyAtTarget
            );
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
                "descent.step_reached instanceId={} commandId={} step={} position={} health={} level={} tunnelBlocksUsed={} arrivalPolls={} grounded={} dry={} bodyClear={} hazardFree={} supportStable={}",
                shell.instanceId(),
                run.commandId,
                run.stepIndex,
                player.getBlockPos().toShortString(),
                player.getHealth(),
                levelStep,
                run.tunnelBlocksUsed,
                arrival == null ? 0 : arrival.validPolls(),
                player.isOnGround(),
                !player.isTouchingWater() && actualDry,
                isClearDescentBody(client, player.getBlockPos()),
                stepSafety.kind() != DescentStepSafetyPolicy.Kind.HAZARD
                    && stepSafety.kind() != DescentStepSafetyPolicy.Kind.ADJACENT_LAVA,
                shell.isStableDescentSupport(client, step.support())
            );
            BlockPos reached = step.nextFeet().toImmutable();
            run.currentFeet = reached;
            run.reachedFeet.add(reached);
            run.lastVerifiedDryFeet = reached;
            clearPostBreakProbe(run);
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
        return moveToDescentStep(client, player, effective, run, step, nowMs);
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
        int pickaxeSlot = selectDescentPickaxeHotbarSlot(client, player, run, true, nowMs);
        if (pickaxeSlot == -2) {
            return new ControlDecision(
                shell.stopFrom(effective, "descent_iron_cleanup_reserve_tool_hotbar_move"),
                InputState.stop()
            );
        }
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
        BlockPos canonicalBreakConflict = firstCanonicalBreakInteractionConflict(
            result.hitBlock(),
            result.actedBlock(),
            shell::isCanonicalDescentTrailSupport,
            shell::isOnRecordedDescentTrail
        );
        if (canonicalBreakConflict != null) {
            // The interaction demand has not been applied yet. Drop it and reset the breaker so
            // an ore eye-ray may never mine through a support/occupancy cell leased to an earlier
            // surface-return segment.
            shell.blockBreakController().reset();
            run.abandonedIronCleanupTargets.add(target);
            run.ironCleanupTarget = null;
            shell.logger().warn(
                "descent.iron_cleanup_canonical_veto instanceId={} commandId={} target={} hitBlock={} actedBlock={} conflict={} elapsedMs={} reason=canonical_surface_trail_lease",
                shell.instanceId(),
                run.commandId,
                target.toShortString(),
                McbotFabricClient.formatBlockPos(result.hitBlock()),
                McbotFabricClient.formatBlockPos(result.actedBlock()),
                canonicalBreakConflict.toShortString(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
            return new ControlDecision(
                shell.stopFrom(effective, "descent_iron_cleanup_preserve_canonical_trail"),
                InputState.stop()
            );
        }
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.ironCleanupBlocksBroken++;
            run.lastIronCleanupTarget = target;
            run.ironCleanupTarget = null;
            run.ironCleanupCollectStartedAtMs = nowMs;
            return withInteraction(
                new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_break_done"), InputState.stop()),
                result
            );
        }
        if (result.status() == BlockBreakController.Status.REPOSITION || result.status() == BlockBreakController.Status.FAILED) {
            run.abandonedIronCleanupTargets.add(target);
            run.ironCleanupTarget = null;
            return withInteraction(
                new ControlDecision(shell.stopFrom(effective, "descent_iron_cleanup_reselect:" + result.reason()), InputState.stop()),
                result
            );
        }
        return withInteraction(
            new ControlDecision(shell.lookIntentForBlock(effective, player, target, "descent_iron_cleanup_breaking:" + result.reason()), InputState.stop()),
            result
        );
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
        if (shell.isCanonicalDescentTrailSupport(candidate)) {
            return false;
        }
        if (shell.isOnRecordedDescentTrail(candidate)) {
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
        // A late reroute can point one of its clearance cells through the floor beneath a stance
        // already accepted into this command's surface-return segment. Breaking that block makes
        // the completed segment non-replayable, so reject the move before the breaker can mutate
        // the world. The reroute admission check below normally catches this; this guard keeps the
        // invariant fail-closed if a step was installed through another path or the route changed.
        boolean currentRunSupport = targetsReachedStanceSupport(
            run == null ? null : run.reachedFeet,
            target
        );
        boolean canonicalSupport = shell.isCanonicalDescentTrailSupport(target);
        if (currentRunSupport || canonicalSupport) {
            shell.blockBreakController().reset();
            if (canonicalSupport) {
                logCanonicalSupportVeto(run, step, target, "pre_break:" + phase, nowMs);
            }
            return rerouteOrFailDescent(
                effective,
                client,
                player,
                run,
                step,
                nowMs,
                canonicalSupport
                    ? "descent_preserve_canonical_surface_trail_support"
                    : "descent_preserve_surface_trail_support"
            );
        }
        BlockState targetState = client.world.getBlockState(target);

        ToolSelectionPlanner.Decision targetToolDecision = ToolSelectionPlanner.decideForBlockId(shell.blockId(targetState));
        if (targetToolDecision.requirement() == ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED) {
            int pickaxeSlot = selectDescentPickaxeHotbarSlot(client, player, run, false, nowMs);
            if (pickaxeSlot == -2) {
                return new ControlDecision(
                    shell.stopFrom(effective, "descent_break_tool_hotbar_move:" + phase),
                    InputState.stop()
                );
            }
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
        if (result.status() == BlockBreakController.Status.RUNNING
            && result.actedBlock() != null) {
            run.pendingBreakStep = step;
            run.pendingBreakOpenedCell = result.actedBlock().toImmutable();
            run.pendingBreakPhase = phase;
            run.pendingBreakAdvanceStage = target.equals(result.actedBlock());
            if (armObservedPostBreakProbe(client, run, nowMs)) {
                return withInteraction(
                    new ControlDecision(
                        shell.stopFrom(effective, "descent_post_break_probe_armed:" + phase),
                        InputState.stop()
                    ),
                    result
                );
            }
        }
        if (result.status() == BlockBreakController.Status.BROKEN) {
            clearMatchingDescentClearanceRecovery(run, target);
            armPostBreakProbe(run, step, target, phase, true, nowMs);
            return withInteraction(
                new ControlDecision(shell.stopFrom(effective, "descent_break_done:" + phase), InputState.stop()),
                result
            );
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            clearPendingBreakConfirmation(run);
            String hazardReason = descentBreakHazardReason(client, player, target, result.reason());
            if (hazardReason == null && result.hitBlock() != null) {
                hazardReason = descentBreakHazardReason(client, player, result.hitBlock(), result.reason());
            }
            if (hazardReason != null) {
                return withInteraction(failDescent(effective, run, nowMs, hazardReason), result);
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
                return withInteraction(
                    new ControlDecision(shell.stopFrom(effective, "descent_clearance_recovery:" + phase + ":" + recoveryPhase), InputState.stop()),
                    result
                );
            }
            if (McbotFabricClient.shouldRerouteDescentBreakReposition(result.reason(), recoveryPhase)) {
                return withInteraction(
                    rerouteOrFailDescent(effective, client, player, run, step, nowMs, "descent_break_reposition:" + result.reason()),
                    result
                );
            }
            return withInteraction(
                failDescent(effective, run, nowMs, "descent_break_reposition:" + result.reason()),
                result
            );
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            clearPendingBreakConfirmation(run);
            return withInteraction(
                failDescent(effective, run, nowMs, "descent_break_failed:" + result.reason()),
                result
            );
        }
        return withInteraction(
            new ControlDecision(shell.lookIntentForBlock(effective, player, target, "descent_breaking_" + phase + ":" + result.reason()), InputState.stop()),
            result
        );
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
            run.descentFieldKitSticksCraftActive,
            run.descentToolRecoveryAttempts
        );
    }

    FieldKitRecoveryPlanner.Decision applyDescentFieldKitDecision(DescentRun run, FieldKitRecoveryPlanner.Decision decision) {
        FieldKitRecoveryPlanner.State state = decision.state();
        run.descentFieldKitRecoveryActive = state.active();
        run.descentFieldKitRetrieveTablePending = state.retrieveTablePending();
        run.descentFieldKitTablePlacedByRecovery = state.tablePlacedByRecovery();
        run.descentProactiveToolRecoveryLogged = state.proactiveLogged();
        run.descentFieldKitSticksCraftActive = state.sticksCraftPending();
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
            if (exactMissionIronRecoveryReserveApplies(run)) {
                return completeMissionIronRecoveryReserveFeedback(
                    effective,
                    run,
                    nowMs,
                    missionIronRecoveryReserveCompletionReason(true),
                    "recovery_limit"
                );
            }
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
                if (exactMissionIronRecoveryReserveApplies(run)) {
                    return completeMissionIronRecoveryReserveFeedback(
                        effective,
                        run,
                        nowMs,
                        missionIronRecoveryReserveCompletionReason(true),
                        "workspace_retrieve_failed:" + reason
                    );
                }
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
        long tableCraftInventoryElapsedMs = run.descentTableCraftLatch.elapsedMs(nowMs);
        if (run.descentTableCraftLatch.inFlight()
            && run.descentTableCraftLatch.observeInventory(craftInventory.tables().craftingTableCount())
                == FieldKitTableCraftLatch.Transition.COMPLETED) {
            String tableCraftCommandId = run.toolCraftTableCommandId();
            shell.logger().info(
                "fieldkit.table_craft.completed instanceId={} commandId={} subCommandId={} consumer=descent elapsedMs={} reason=inventory_delta",
                shell.instanceId(),
                run.commandId,
                tableCraftCommandId,
                tableCraftInventoryElapsedMs
            );
            shell.logger().info(
                "descent.fieldkit_table_crafted instanceId={} commandId={} subCommandId={} reason=inventory_delta recoveryAttempts={}",
                shell.instanceId(),
                run.commandId,
                tableCraftCommandId,
                run.descentToolRecoveryAttempts
            );
            return new ControlDecision(shell.stopFrom(effective, "descent_fieldkit_table_crafted"), InputState.stop());
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
                false,
                InventoryCounter.countPlayerPlanks(player).plankCount(),
                missionIronRecoveryReserveApplies(run) ? MISSION_IRON_PROTECTED_PLANK_RESERVE : 0
            )
        ));
        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.CRAFT_STICKS) {
            String sticksCraftCommandId = run.toolCraftSticksCommandId();
            FieldKitRecoveryPlanner.Decision observed = applyDescentFieldKitDecision(run,
                FieldKitRecoveryPlanner.afterCraftSticks(
                    descentFieldKitState(run),
                    "",
                    craftInventory.sticks().stickCount()
                ));
            if (observed.action() == FieldKitRecoveryPlanner.Action.CRAFT_STICKS_COMPLETE) {
                shell.logger().info(
                    "descent.fieldkit_sticks_crafted instanceId={} commandId={} subCommandId={} reason=inventory_delta recoveryAttempts={}",
                    shell.instanceId(), run.commandId, sticksCraftCommandId,
                    run.descentToolRecoveryAttempts
                );
                return new ControlDecision(
                    shell.stopFrom(effective, "descent_fieldkit_sticks_crafted"),
                    InputState.stop()
                );
            }
            ControlDecision sticksCraftDecision = shell.resolveRecoveryCraftSticks(
                client,
                player,
                shell.makeSubIntent(
                    effective,
                    "craft_sticks",
                    sticksCraftCommandId,
                    "descent_fieldkit_craft_sticks"
                ),
                nowMs
            );
            String sticksCraftReason = sticksCraftDecision.intent() == null
                ? ""
                : sticksCraftDecision.intent().reason();
            FieldKitRecoveryPlanner.Decision transition = applyDescentFieldKitDecision(run,
                FieldKitRecoveryPlanner.afterCraftSticks(
                    descentFieldKitState(run),
                    sticksCraftReason,
                    shell.captureCraftInventory(player).sticks().stickCount()
                ));
            if (transition.action() == FieldKitRecoveryPlanner.Action.CRAFT_STICKS_COMPLETE) {
                shell.logger().info(
                    "descent.fieldkit_sticks_crafted instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                    shell.instanceId(), run.commandId, sticksCraftCommandId,
                    sticksCraftReason, run.descentToolRecoveryAttempts
                );
                return new ControlDecision(
                    shell.stopFrom(effective, "descent_fieldkit_sticks_crafted"),
                    InputState.stop()
                );
            }
            if (transition.action() != FieldKitRecoveryPlanner.Action.CRAFT_STICKS_FAILED) {
                return sticksCraftDecision;
            }
            inventoryDecision = new FieldKitRecoveryPlanner.Decision(
                transition.state(),
                FieldKitRecoveryPlanner.Action.MISSING_PICKAXE_INPUTS,
                false
            );
        }
        if (exactMissionIronRecoveryReserveApplies(run)
            && (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.NO_CRAFTING_TABLE
                || inventoryDecision.action() == FieldKitRecoveryPlanner.Action.PLACE_TABLE_REQUIRED)) {
            shell.logger().warn(
                "mine_nearby_iron.tool_reserve.rejected instanceId={} commandId={} objectiveReason={} recoveryDepth={} remainingEpochBlocks={} reservedCount={} floor={} planks={} reason=recovery_workspace_preparation_required budgetReset=false floorViolation=false",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                Math.max(0, run.depth - run.depthReached),
                shell.remainingIronProspectEpochBlocks(),
                run.reservedIronPickaxeCount,
                run.reservedIronPickaxeDurabilityFloor,
                InventoryCounter.countPlayerPlanks(player).plankCount()
            );
            return completeMissionIronRecoveryReserveFeedback(
                effective,
                run,
                nowMs,
                missionIronRecoveryReserveCompletionReason(true),
                "recovery_workspace_preparation_required"
            );
        }
        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.MISSING_PICKAXE_INPUTS) {
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
            if (exactMissionIronRecoveryReserveApplies(run)) {
                return completeMissionIronRecoveryReserveFeedback(
                    effective,
                    run,
                    nowMs,
                    missionIronRecoveryReserveCompletionReason(true),
                    "missing_stone_pickaxe_inputs"
                );
            }
            return failDescent(effective, run, nowMs, "descent_tool_recovery:missing_inputs");
        }

        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.NO_CRAFTING_TABLE) {
            int plankCount = InventoryCounter.countPlayerPlanks(player).plankCount();
            if (run.descentTableCraftLatch.shouldDrive(plankCount)) {
                String tableCraftCommandId = run.toolCraftTableCommandId();
                FieldKitTableCraftLatch.Transition startTransition = run.descentTableCraftLatch.start(nowMs);
                if (startTransition == FieldKitTableCraftLatch.Transition.STARTED) {
                    shell.logger().info(
                        "fieldkit.table_craft.started instanceId={} commandId={} subCommandId={} consumer=descent planks={} recoveryAttempts={}",
                        shell.instanceId(),
                        run.commandId,
                        tableCraftCommandId,
                        plankCount,
                        run.descentToolRecoveryAttempts
                    );
                }
                ControlDecision tableCraftDecision = shell.resolveRecoveryCraftTable(
                    client,
                    player,
                    shell.makeSubIntent(effective, "craft_table", tableCraftCommandId, "descent_fieldkit_craft_table"),
                    nowMs
                );
                String tableCraftReason = tableCraftDecision.intent() == null ? "" : tableCraftDecision.intent().reason();
                long elapsedMs = run.descentTableCraftLatch.elapsedMs(nowMs);
                FieldKitTableCraftLatch.Transition craftTransition = run.descentTableCraftLatch.observe(tableCraftReason);
                if (craftTransition == FieldKitTableCraftLatch.Transition.COMPLETED) {
                    shell.logger().info(
                        "fieldkit.table_craft.completed instanceId={} commandId={} subCommandId={} consumer=descent elapsedMs={} reason={}",
                        shell.instanceId(),
                        run.commandId,
                        tableCraftCommandId,
                        elapsedMs,
                        tableCraftReason
                    );
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
                if (craftTransition == FieldKitTableCraftLatch.Transition.ACTIVE) {
                    return tableCraftDecision;
                }
                shell.logger().warn(
                    "fieldkit.table_craft.rejected instanceId={} commandId={} subCommandId={} consumer=descent elapsedMs={} reason={}",
                    shell.instanceId(),
                    run.commandId,
                    tableCraftCommandId,
                    elapsedMs,
                    tableCraftReason
                );
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
            if (exactMissionIronRecoveryReserveApplies(run)) {
                return completeMissionIronRecoveryReserveFeedback(
                    effective,
                    run,
                    nowMs,
                    missionIronRecoveryReserveCompletionReason(true),
                    "stone_pickaxe_craft_failed:" + reason
                );
            }
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
        if (missionIronRecoveryReserveApplies(run)) {
            MissionIronToolReservePolicy.Assessment assessment = assessMissionIronRecoveryReserve(
                run.commandId,
                run.objectiveReason,
                run.remainingMissionIronCount,
                run.reservedIronPickaxeCount,
                run.reservedIronPickaxeDurabilityFloor,
                missionIronRecoveryInventory(player),
                missionIronRecoveryTools(player, false),
                player.getInventory().selectedSlot,
                Math.max(0, run.depth - run.depthReached),
                shell.remainingIronProspectEpochBlocks()
            );
            logMissionIronRecoveryReserveAssessment(run, assessment, nowMs);
            if (assessment.status() == MissionIronToolReservePolicy.Status.INVALID_MISSION_INPUT) {
                return failDescent(
                    effective,
                    run,
                    nowMs,
                    "descent_tool_reserve_invalid_intent:" + assessment.reason()
                );
            }
            if (assessment.status() == MissionIronToolReservePolicy.Status.RESTOCK_REQUIRED) {
                if (exactMissionIronRecoveryReserveApplies(run)) {
                    return completeMissionIronRecoveryReserveFeedback(
                        effective,
                        run,
                        nowMs,
                        missionIronRecoveryReserveCompletionReason(false),
                        assessment.reason()
                    );
                }
                if (!run.descentFieldKitRecoveryActive) {
                    applyDescentFieldKitDecision(run, FieldKitRecoveryPlanner.activate(descentFieldKitState(run)));
                }
                return resolveDescentToolRecovery(client, player, effective, run, nowMs, true);
            }
            // The exact recovery contract replaces the legacy 32-durability heuristic. Its
            // aggregate horizon already covers the remaining descent plus the next bounded lane,
            // while per-block selection below prevents the final reserved picks crossing the floor.
            return null;
        }
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

    private boolean missionIronRecoveryReserveApplies(DescentRun run) {
        return run != null && MissionIronToolReservePolicy.applies(run.commandId, run.objectiveReason);
    }

    private boolean exactMissionIronRecoveryReserveApplies(DescentRun run) {
        return run != null
            && run.commandId != null
            && run.commandId.startsWith("mission-")
            && "mission:MINE_IRON_RECOVERY".equals(run.objectiveReason);
    }

    private int selectDescentPickaxeHotbarSlot(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        boolean ironHarvestRequired,
        long nowMs
    ) {
        if (!missionIronRecoveryReserveApplies(run)) {
            return ironHarvestRequired
                ? shell.findIronHarvestPickaxeHotbarSlot(player)
                : shell.findStoneMiningPickaxeHotbarSlot(player);
        }
        MissionIronToolReservePolicy.Assessment assessment = assessMissionIronRecoveryReserve(
            run.commandId,
            run.objectiveReason,
            run.remainingMissionIronCount,
            run.reservedIronPickaxeCount,
            run.reservedIronPickaxeDurabilityFloor,
            missionIronRecoveryInventory(player),
            missionIronRecoveryTools(player, false),
            player.getInventory().selectedSlot,
            Math.max(0, run.depth - run.depthReached),
            shell.remainingIronProspectEpochBlocks()
        );
        if (!assessment.admitted()) {
            return -1;
        }
        int selected = assessment.selectedHotbarSlot();
        if (selected > 8) {
            int moved = shell.moveExactInventorySlotToHotbar(
                client,
                player,
                selected,
                run.commandId,
                "descent_iron_reserve_tool"
            );
            return moved >= 0 || moved == -2 ? -2 : -1;
        }
        if (selected < 0 || !MissionIronToolReservePolicy.canStartBlock(
            missionIronRecoveryRequest(
                true,
                run.remainingMissionIronCount,
                run.reservedIronPickaxeCount,
                run.reservedIronPickaxeDurabilityFloor,
                missionIronRecoveryInventory(player),
                missionIronRecoveryTools(player, false),
                player.getInventory().selectedSlot
            ),
            assessment,
            selected,
            1
        )) {
            return -1;
        }
        if (player.getInventory().selectedSlot != selected) {
            shell.logger().info(
                "mine_nearby_iron.tool_reserve.tool_switched instanceId={} commandId={} objectiveReason={} toolSlot={} tool={} durability={} reserved={} reserveFloor={} requiredDurability={} spendableDurability={} elapsedMs={} reason={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                selected,
                assessment.selectedToolKind(),
                missionIronRecoveryToolDurability(player, selected),
                assessment.reserveAppliesTo(selected),
                assessment.reservedIronPickaxeDurabilityFloor(),
                assessment.requiredDurability(),
                assessment.spendableDurability(),
                Math.max(0L, nowMs - run.startedAtMs),
                assessment.selectionReason()
            );
        }
        return selected;
    }

    private List<MissionIronToolReservePolicy.ToolCandidate> missionIronRecoveryTools(
        ClientPlayerEntity player,
        boolean hotbarOnly
    ) {
        if (player == null || player.getInventory() == null) {
            return List.of();
        }
        List<MissionIronToolReservePolicy.ToolCandidate> tools = new java.util.ArrayList<>();
        int end = Math.min(hotbarOnly ? 9 : 36, player.getInventory().size());
        for (int slot = 0; slot < end; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            String itemId = shell.itemId(stack);
            MissionIronToolReservePolicy.ToolKind kind;
            if (InventoryCounter.isIronPickaxeItemId(itemId)) {
                kind = MissionIronToolReservePolicy.ToolKind.IRON;
            } else if (InventoryCounter.isStonePickaxeItemId(itemId)) {
                kind = MissionIronToolReservePolicy.ToolKind.STONE;
            } else {
                continue;
            }
            tools.add(new MissionIronToolReservePolicy.ToolCandidate(
                slot,
                kind,
                Math.max(0, stack.getMaxDamage() - stack.getDamage())
            ));
        }
        return List.copyOf(tools);
    }

    private int missionIronRecoveryToolDurability(ClientPlayerEntity player, int hotbarSlot) {
        if (player == null || hotbarSlot < 0 || hotbarSlot >= Math.min(9, player.getInventory().size())) {
            return 0;
        }
        ItemStack stack = player.getInventory().getStack(hotbarSlot);
        return Math.max(0, stack.getMaxDamage() - stack.getDamage());
    }

    private void logMissionIronRecoveryReserveAssessment(
        DescentRun run,
        MissionIronToolReservePolicy.Assessment assessment,
        long nowMs
    ) {
        String signature = assessment.status()
            + ":" + assessment.requiredDurability()
            + ":" + assessment.spendableDurability()
            + ":" + assessment.reservedIronSlots()
            + ":" + assessment.selectedHotbarSlot();
        if (signature.equals(run.lastToolReserveAssessmentSignature)) {
            return;
        }
        run.lastToolReserveAssessmentSignature = signature;
        shell.logger().info(
            "mine_nearby_iron.tool_reserve.assessed instanceId={} commandId={} objectiveReason={} recoveryDepth={} requiredDurability={} spendableDurability={} reservedCount={} reserveFloor={} reservedSlots={} selectedSlot={} status={} elapsedMs={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.objectiveReason,
            Math.max(0, run.depth - run.depthReached),
            assessment.requiredDurability(),
            assessment.spendableDurability(),
            assessment.reservedIronPickaxeCount(),
            assessment.reservedIronPickaxeDurabilityFloor(),
            assessment.reservedIronSlots(),
            assessment.selectedHotbarSlot(),
            assessment.status(),
            Math.max(0L, nowMs - run.startedAtMs),
            assessment.reason()
        );
    }

    static MissionIronToolReservePolicy.Assessment assessMissionIronRecoveryReserve(
        String commandId,
        String reason,
        Integer remainingMissionIronCount,
        Integer reservedIronPickaxeCount,
        Integer reservedIronPickaxeDurabilityFloor,
        MissionIronRecoveryInventory inventory,
        List<MissionIronToolReservePolicy.ToolCandidate> tools,
        int currentHotbarSlot,
        int remainingRecoveryDepth,
        int remainingEpochWork
    ) {
        MissionIronToolReservePolicy.Request request = missionIronRecoveryRequest(
            MissionIronToolReservePolicy.applies(commandId, reason),
            remainingMissionIronCount,
            reservedIronPickaxeCount,
            reservedIronPickaxeDurabilityFloor,
            inventory,
            tools,
            currentHotbarSlot
        );
        return request.missionOwned()
            ? MissionIronToolReservePolicy.assessRecovery(
                request,
                remainingRecoveryDepth,
                remainingEpochWork
            )
            : MissionIronToolReservePolicy.assess(request);
    }

    private static MissionIronToolReservePolicy.Request missionIronRecoveryRequest(
        boolean missionOwned,
        Integer remainingMissionIronCount,
        Integer reservedIronPickaxeCount,
        Integer reservedIronPickaxeDurabilityFloor,
        MissionIronRecoveryInventory inventory,
        List<MissionIronToolReservePolicy.ToolCandidate> tools,
        int currentHotbarSlot
    ) {
        int remainingRawTarget = missionIronRecoveryMilestoneTarget(
            remainingMissionIronCount,
            reservedIronPickaxeCount,
            inventory
        );
        return new MissionIronToolReservePolicy.Request(
            missionOwned,
            remainingMissionIronCount,
            reservedIronPickaxeCount,
            reservedIronPickaxeDurabilityFloor,
            new MissionIronToolReservePolicy.FrozenLaneHorizon(
                MissionIronToolReservePolicy.MAX_PROJECTED_LANE_BREAKS,
                remainingRawTarget,
                MissionIronToolReservePolicy.MAX_EXISTING_VEIN_EXTRA_ALLOWANCE
            ),
            tools,
            currentHotbarSlot
        );
    }

    static int missionIronRecoveryMilestoneTarget(
        Integer remainingMissionIronCount,
        Integer reservedIronPickaxeCount,
        MissionIronRecoveryInventory inventory
    ) {
        if (remainingMissionIronCount == null || inventory == null) {
            return 0;
        }
        int remaining = Math.max(0, remainingMissionIronCount);
        int requiredPickaxes = Math.max(1, reservedIronPickaxeCount == null ? 1 : reservedIronPickaxeCount);
        // IronMiningTargetDeltaPlanner models one recipe milestone at a time. Treat a missing
        // required spare (the diamond goal's second pickaxe) as the same pre-pick milestone rather
        // than allowing the armor branch to run merely because one pickaxe already exists.
        int milestonePickaxes = inventory.ironPickaxes() < requiredPickaxes
            ? 0
            : inventory.ironPickaxes();
        int plannerTarget = IronMiningTargetDeltaPlanner.targetDelta(
            inventory.rawIron(),
            inventory.ironIngots(),
            milestonePickaxes,
            inventory.armor(),
            3,
            MissionIronToolReservePolicy.MAX_CURRENT_COMMAND_RAW_TARGET
        );
        return Math.min(remaining, Math.max(0, plannerTarget));
    }

    private MissionIronRecoveryInventory missionIronRecoveryInventory(ClientPlayerEntity player) {
        McbotFabricClient.CraftInventorySnapshot inventory = shell.captureCraftInventory(player);
        return new MissionIronRecoveryInventory(
            inventory.rawIron().itemCount(),
            inventory.ironIngots().itemCount(),
            inventory.ironPickaxes().itemCount(),
            new IronMiningTargetDeltaPlanner.ArmorState(
                equippedIronArmor(player, ArmorPlanner.ArmorSlot.HELMET),
                equippedIronArmor(player, ArmorPlanner.ArmorSlot.CHESTPLATE),
                equippedIronArmor(player, ArmorPlanner.ArmorSlot.LEGGINGS),
                equippedIronArmor(player, ArmorPlanner.ArmorSlot.BOOTS),
                inventory.ironHelmets().itemCount(),
                inventory.ironChestplates().itemCount(),
                inventory.ironLeggings().itemCount(),
                inventory.ironBoots().itemCount()
            )
        );
    }

    private boolean equippedIronArmor(ClientPlayerEntity player, ArmorPlanner.ArmorSlot slot) {
        return slot.itemId().equals(ArmorController.itemId(ArmorController.currentArmorStack(player, slot)));
    }

    record MissionIronRecoveryInventory(
        int rawIron,
        int ironIngots,
        int ironPickaxes,
        IronMiningTargetDeltaPlanner.ArmorState armor
    ) {
        MissionIronRecoveryInventory {
            rawIron = Math.max(0, rawIron);
            ironIngots = Math.max(0, ironIngots);
            ironPickaxes = Math.max(0, ironPickaxes);
        }
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

    static DescentControlPlanner.Stage resolvedPostBreakStage(
        DescentControlPlanner.Stage current,
        String phase,
        boolean advance
    ) {
        return advance ? descentStageAfterPhase(phase) : current;
    }

    private static void clearMatchingDescentClearanceRecovery(DescentRun run, BlockPos target) {
        if (run != null && target != null && target.equals(run.recoveryClearTarget)) {
            clearDescentClearanceRecovery(run);
        }
    }

    private ControlDecision resolveMiningWorkspace(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs
    ) {
        MiningWorkspaceController.Outcome workspace = miningWorkspaceController.resolve(
            client,
            player,
            effective,
            run.direction,
            run.reachedFeet,
            nowMs
        );
        if (!workspace.failureReason().isBlank()) {
            return failDescent(
                effective,
                run,
                nowMs,
                "workspace_unavailable:" + workspace.failureReason()
            );
        }
        if (workspace.ready()) {
            List<BlockPos> merged = mergeVerifiedWorkspaceRoute(
                run.reachedFeet,
                miningWorkspaceController.readyRouteFor(run.commandId)
            );
            run.reachedFeet.clear();
            run.reachedFeet.addAll(merged);
        }
        return workspace.ready() ? null : workspace.decision();
    }

    static List<BlockPos> mergeVerifiedWorkspaceRoute(
        List<BlockPos> descentFeet,
        List<VoxelCell> workspaceRoute
    ) {
        if (descentFeet == null || descentFeet.isEmpty()) {
            return List.of();
        }
        List<BlockPos> merged = new java.util.ArrayList<>(descentFeet);
        if (workspaceRoute == null
            || workspaceRoute.isEmpty()
            || !MiningWorkspaceTraversal.reversibleRoute(workspaceRoute)) {
            return List.copyOf(merged);
        }
        VoxelCell routeStart = workspaceRoute.get(0);
        BlockPos currentFrontier = merged.get(merged.size() - 1);
        if (!sameCell(currentFrontier, routeStart)) {
            return List.copyOf(merged);
        }
        for (int index = 1; index < workspaceRoute.size(); index++) {
            VoxelCell cell = workspaceRoute.get(index);
            BlockPos next = new BlockPos(cell.x(), cell.y(), cell.z());
            int existing = merged.lastIndexOf(next);
            if (existing >= 0) {
                merged.subList(existing + 1, merged.size()).clear();
            } else {
                merged.add(next);
            }
        }
        return List.copyOf(merged);
    }

    private static boolean sameCell(BlockPos block, VoxelCell voxel) {
        return block != null
            && voxel != null
            && block.getX() == voxel.x()
            && block.getY() == voxel.y()
            && block.getZ() == voxel.z();
    }

    private static void clearDescentClearanceRecovery(DescentRun run) {
        if (run == null) {
            return;
        }
        run.recoveryClearTarget = null;
        run.recoveryClearPhase = "";
    }

    private ControlDecision moveToDescentStep(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs
    ) {
        double targetX = step.nextFeet().getX() + 0.5D;
        double targetZ = step.nextFeet().getZ() + 0.5D;
        double dx = targetX - player.getX();
        double dz = targetZ - player.getZ();
        double distance = Math.hypot(dx, dz);
        if (DescentControlPlanner.shouldSettleIntoStep(
            distance,
            McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON,
            player.getY(),
            step.nextFeet().getY()
        )) {
            DescentStepSafetyPolicy.Result lipSafety = descentStepSafety(client, step);
            DescentStepLipController.Key lipKey = new DescentStepLipController.Key(
                run.commandId,
                step.index(),
                lipCell(run.currentFeet),
                lipCell(step.nextFeet())
            );
            DescentStepLipController.Decision lipDecision = run.stepLipController.tick(
                new DescentStepLipController.Observation(
                    lipKey,
                    nowMs,
                    player.isOnGround(),
                    isDryDescentBody(client, player, player.getBlockPos()),
                    isClearDescentBody(client, player.getBlockPos()),
                    lipSafety.kind() != DescentStepSafetyPolicy.Kind.HAZARD
                        && lipSafety.kind() != DescentStepSafetyPolicy.Kind.ADJACENT_LAVA,
                    shell.isStableDescentSupport(client, run.currentFeet.down()),
                    shell.isStableDescentSupport(client, step.support())
                )
            );
            if (lipDecision.transitioned()) {
                shell.logger().info(
                    "descent.step_lip_commit instanceId={} commandId={} step={} phase={} origin={} landing={} stablePolls={} elapsedMs={} reason={}",
                    shell.instanceId(),
                    run.commandId,
                    step.index(),
                    lipDecision.phase(),
                    run.currentFeet.toShortString(),
                    step.nextFeet().toShortString(),
                    lipDecision.stablePolls(),
                    Math.max(0L, nowMs - run.startedAtMs),
                    lipDecision.reason()
                );
            }
            BrainLink.Intent intent = shell.lookIntentForAngles(
                effective,
                McbotFabricClient.yawForDescentDirection(run.direction),
                8.0D,
                "descent_step_lip_" + lipDecision.reason() + ":" + step.index()
            );
            InputState input = switch (lipDecision.action()) {
                case HOLD_SNEAK -> new InputState(
                    false,
                    false,
                    false,
                    false,
                    false,
                    true,
                    0.0F,
                    0.0F
                );
                case FORWARD_LAUNCH -> new InputState(
                    true,
                    false,
                    false,
                    false,
                    false,
                    false,
                    1.0F,
                    0.0F
                );
                case HOLD_RELEASED -> InputState.stop();
            };
            return new ControlDecision(intent, input);
        }
        run.stepLipController.pauseStaging();
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

    private static VoxelCell voxelCell(BlockPos pos) {
        return new VoxelCell(pos.getX(), pos.getY(), pos.getZ());
    }

    private static DescentStepLipController.Cell lipCell(BlockPos pos) {
        return new DescentStepLipController.Cell(pos.getX(), pos.getY(), pos.getZ());
    }

    private static StaircaseDescentPlanner.Step currentDescentStep(DescentRun run) {
        if (run == null) {
            return null;
        }
        return run.tunnelMode
            ? StaircaseDescentPlanner.levelStepFrom(run.currentFeet, run.direction, run.stepIndex)
            : StaircaseDescentPlanner.stepFrom(run.currentFeet, run.direction, run.stepIndex);
    }

    private void observePreflightArrivalSuppression(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step observedStep
    ) {
        StaircaseDescentPlanner.Step step = observedStep != null
            ? observedStep
            : run.postBreakStep != null
                ? run.postBreakStep
                : currentDescentStep(run);
        if (step == null) {
            return;
        }
        DescentStepSafetyPolicy.Result safety = descentStepSafety(client, step);
        DescentStepArrivalValidator.Decision arrival = run.arrivalValidator.tick(
            run.commandId + ":" + step.index() + ":" + step.nextFeet().toShortString(),
            new DescentStepArrivalValidator.Observation(
                voxelCell(step.nextFeet()),
                voxelCell(player.getBlockPos()),
                descentStepHorizontalDistance(player, step.nextFeet()),
                McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON,
                player.isOnGround(),
                isDryDescentBody(client, player, player.getBlockPos()),
                isClearDescentBody(client, player.getBlockPos()),
                safety.kind() != DescentStepSafetyPolicy.Kind.HAZARD
                    && safety.kind() != DescentStepSafetyPolicy.Kind.ADJACENT_LAVA,
                shell.isStableDescentSupport(client, step.support())
            )
        );
        if (arrival.status() != DescentStepArrivalValidator.Status.SUPPRESSED
            || !arrival.suppressionEvent()) {
            return;
        }
        shell.logger().warn(
            "descent.step_arrival_suppressed instanceId={} commandId={} step={} target={} support={} actualFeet={} grounded={} wet={} bodyClear={} hazardFree={} supportStable={} arrivalPolls={} reason={}",
            shell.instanceId(),
            run.commandId,
            step.index(),
            step.nextFeet().toShortString(),
            step.support().toShortString(),
            player.getBlockPos().toShortString(),
            player.isOnGround(),
            player.isTouchingWater(),
            isClearDescentBody(client, player.getBlockPos()),
            safety.kind() != DescentStepSafetyPolicy.Kind.HAZARD
                && safety.kind() != DescentStepSafetyPolicy.Kind.ADJACENT_LAVA,
            shell.isStableDescentSupport(client, step.support()),
            arrival.validPolls(),
            arrival.reason()
        );
    }

    private void logDescentArrivalSuppressed(
        ClientPlayerEntity player,
        DescentRun run,
        int stepIndex,
        BlockPos target,
        BlockPos support,
        boolean bodyClear,
        boolean hazardFree,
        boolean supportStable,
        DescentStepArrivalValidator.Decision arrival
    ) {
        shell.logger().warn(
            "descent.step_arrival_suppressed instanceId={} commandId={} step={} target={} support={} actualFeet={} grounded={} wet={} bodyClear={} hazardFree={} supportStable={} arrivalPolls={} reason={}",
            shell.instanceId(),
            run.commandId,
            stepIndex,
            target.toShortString(),
            support.toShortString(),
            player.getBlockPos().toShortString(),
            player.isOnGround(),
            player.isTouchingWater(),
            bodyClear,
            hazardFree,
            supportStable,
            arrival.validPolls(),
            arrival.reason()
        );
    }

    private void clearDescentMoveProgress(DescentRun run) {
        run.moveTargetFeet = null;
        run.moveStartedAtMs = 0L;
        run.moveLastProgressAtMs = 0L;
        run.moveBestDistance = Double.POSITIVE_INFINITY;
        run.stepLipController.clear();
    }

    private static String formatDistance(double value) {
        return String.format(Locale.ROOT, "%.3f", value);
    }

    private boolean descentComplete(MinecraftClient client, ClientPlayerEntity player, DescentRun run) {
        return run.depthReached >= run.depth
            && player.isOnGround()
            && shell.isStableDescentSupport(client, player.getBlockPos().down());
    }

    private boolean isDryDescentBody(MinecraftClient client, ClientPlayerEntity player, BlockPos feet) {
        if (client == null || client.world == null || player == null || feet == null) {
            return false;
        }
        return !player.isTouchingWater()
            && !isWaterBlockState(client.world.getBlockState(feet))
            && !isWaterBlockState(client.world.getBlockState(feet.up()));
    }

    private boolean isClearDescentBody(MinecraftClient client, BlockPos feet) {
        if (client == null || client.world == null || feet == null) {
            return false;
        }
        for (BlockPos body : List.of(feet, feet.up())) {
            BlockState state = client.world.getBlockState(body);
            if (!state.getCollisionShape(client.world, body).isEmpty()
                || shell.isHazardBlockState(state)) {
                return false;
            }
        }
        return true;
    }

    private int commitValidatedDescentReanchor(
        DescentRun run,
        BlockPos actualFeet
    ) {
        int depthDelta = Math.max(1, run.currentFeet.getY() - actualFeet.getY());
        run.currentFeet = actualFeet;
        DescentControlPlanner.Decision reached =
            DescentControlPlanner.validatedDropReached(
                descentControlState(run),
                Math.min(depthDelta, run.depth - run.depthReached)
            );
        applyDescentControlDecision(run, reached);
        run.reachedFeet.add(actualFeet);
        run.lastVerifiedDryFeet = actualFeet;
        run.arrivalValidator.reset();
        clearPostBreakProbe(run);
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
        shell.logger().warn(
            "descent.step_arrival_suppressed instanceId={} commandId={} step={} target={} support={} actualFeet={} grounded={} wet={} bodyClear={} hazardFree={} supportStable={} arrivalPolls=0 reason=arrival_below_planned",
            shell.instanceId(),
            run.commandId,
            run.stepIndex,
            step.nextFeet().toShortString(),
            step.support().toShortString(),
            actualFeet.toShortString(),
            player.isOnGround(),
            player.isTouchingWater(),
            isClearDescentBody(client, actualFeet),
            shell.firstAdjacentLavaBlock(client, actualFeet) == null,
            shell.isStableDescentSupport(client, actualFeet.down())
        );
        return failDescent(effective, run, nowMs, "descent_overshot_step");
    }

    private DescentStepSafetyPolicy.Result descentStepSafety(
        MinecraftClient client,
        StaircaseDescentPlanner.Step step
    ) {
        if (client == null || client.world == null || step == null) {
            return new DescentStepSafetyPolicy.Result(
                DescentStepSafetyPolicy.Kind.HAZARD,
                "missing_client_state",
                ""
            );
        }
        BlockPos bodyWater = firstWaterBlock(
            client,
            List.of(step.sightClear(), step.upperClear(), step.lowerClear())
        );
        McbotFabricClient.HazardBlock hazard = bodyWater == null
            ? shell.firstHazardBlockDetail(client, step)
            : null;
        DescentStepSafetyPolicy.Hazard bodyHazard = bodyWater != null
            ? new DescentStepSafetyPolicy.Hazard("water", bodyWater.toShortString())
            : hazard == null
                ? null
                : new DescentStepSafetyPolicy.Hazard(hazard.kind(), hazard.pos().toShortString());
        BlockPos adjacentWater = firstAdjacentWaterBlock(client, step);
        BlockPos adjacentLava = firstAdjacentLavaBlock(client, step);
        return DescentStepSafetyPolicy.classify(new DescentStepSafetyPolicy.Observation(
            step.support().toShortString(),
            shell.isStableDescentSupport(client, step.support()),
            isWaterBlockState(client.world.getBlockState(step.support())),
            bodyHazard,
            adjacentWater == null ? "" : adjacentWater.toShortString(),
            adjacentLava == null ? "" : adjacentLava.toShortString()
        ));
    }

    private String descentStepUnsafeReason(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (client == null || client.world == null || step == null) {
            return "descent_missing_client_state";
        }
        return descentStepSafety(client, step).reason();
    }

    private BlockPos firstWaterBlock(MinecraftClient client, List<BlockPos> cells) {
        if (client == null || client.world == null || cells == null) {
            return null;
        }
        for (BlockPos cell : cells) {
            if (cell != null && isWaterBlockState(client.world.getBlockState(cell))) {
                return cell.toImmutable();
            }
        }
        return null;
    }

    private BlockPos findPlayerWaterCell(
        MinecraftClient client,
        ClientPlayerEntity player
    ) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        Box contact = player.getBoundingBox().contract(1.0E-6D);
        int minX = (int) Math.floor(contact.minX);
        int maxX = (int) Math.floor(contact.maxX);
        int minY = (int) Math.floor(contact.minY);
        int maxY = (int) Math.floor(contact.maxY);
        int minZ = (int) Math.floor(contact.minZ);
        int maxZ = (int) Math.floor(contact.maxZ);
        for (int y = minY; y <= maxY; y++) {
            for (int z = minZ; z <= maxZ; z++) {
                for (int x = minX; x <= maxX; x++) {
                    BlockPos cell = new BlockPos(x, y, z);
                    if (contact.intersects(new Box(cell))
                        && isWaterBlockState(client.world.getBlockState(cell))) {
                        return cell.toImmutable();
                    }
                }
            }
        }
        return null;
    }

    private BlockPos descentStepWaterCell(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (client == null || client.world == null || step == null) {
            return null;
        }
        if (isWaterBlockState(client.world.getBlockState(step.support()))) {
            return step.support().toImmutable();
        }
        BlockPos bodyWater = firstWaterBlock(
            client,
            List.of(step.sightClear(), step.upperClear(), step.lowerClear())
        );
        if (bodyWater != null) {
            return bodyWater;
        }
        return firstAdjacentWaterBlock(client, step);
    }

    private static boolean isWaterSafety(DescentStepSafetyPolicy.Result safety) {
        return safety != null
            && (safety.kind() == DescentStepSafetyPolicy.Kind.SUPPORT_WATER
                || safety.kind() == DescentStepSafetyPolicy.Kind.BODY_WATER
                || safety.kind() == DescentStepSafetyPolicy.Kind.ADJACENT_WATER);
    }

    private static boolean isWaterPlayerHazard(String reason) {
        return reason != null && reason.startsWith("descent_player_in_hazard:water:");
    }

    private boolean canSealDescentWater(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        BlockPos waterCell
    ) {
        BlockPos feet = player == null ? null : player.getBlockPos().toImmutable();
        return waterCell != null
            && step != null
            && feet != null
            && feet.equals(run.lastVerifiedDryFeet)
            && player.isOnGround()
            && isDryDescentBody(client, player, feet)
            && isClearDescentBody(client, feet)
            && shell.isStableDescentSupport(client, feet.down())
            && canBridgeDescentSupport(
                client,
                player,
                run,
                step,
                "descent_water_adjacent:" + waterCell.toShortString()
            );
    }

    private DescentWaterContainmentController.Decision startWaterContainment(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        DescentWaterContainmentController.Trigger trigger,
        BlockPos waterCell,
        BlockPos openedCell,
        long nowMs,
        boolean sealEligible
    ) {
        BlockPos detectedFeet = player.getBlockPos().toImmutable();
        if (waterCell == null) {
            return run.waterContainment.start(null);
        }
        BlockPos frozenWater = waterCell.toImmutable();
        boolean safeFallWasActive = run.safeFallController.active();
        boolean safeFallHadDeparted = run.safeFallController.departed();
        finishActiveSafeFall(run, true, safeFallWasActive && !safeFallHadDeparted);
        run.safeFallHandoffPending = false;
        run.safeFallHandoffReason = null;
        run.safeFallRejectionReason = null;
        run.containmentStep = step;
        if (step != null) {
            observePreflightArrivalSuppression(client, player, run, step);
        }
        run.containmentRetreatUsed = false;
        run.containmentSealLogged = false;
        run.containmentRetreatLogged = false;
        run.containmentSealPlacementVerified = false;
        run.containmentSealPlaceSpec = null;
        run.containmentSealFaceConstraint = null;
        run.containmentBridgesAtStart = run.supportBridges;
        DescentStepSafetyPolicy.Result detectedSafety = step == null
            ? null
            : descentStepSafety(client, step);
        run.containmentWaterKind = detectedSafety != null && isWaterSafety(detectedSafety)
            ? detectedSafety.kind().name()
            : trigger == DescentWaterContainmentController.Trigger.PLAYER_WET
                ? DescentStepSafetyPolicy.Kind.BODY_WATER.name()
                : "UNKNOWN_WATER";
        DescentWaterContainmentController.Decision decision = run.waterContainment.start(
            new DescentWaterContainmentController.StartRequest(
                trigger,
                step == null ? run.stepIndex : step.index(),
                containmentCell(frozenWater),
                openedCell == null ? null : containmentCell(openedCell),
                containmentCell(detectedFeet),
                run.lastVerifiedDryFeet == null ? null : containmentCell(run.lastVerifiedDryFeet),
                player.isTouchingWater(),
                player.isOnGround()
                    && isDryDescentBody(client, player, detectedFeet)
                    && isClearDescentBody(client, detectedFeet)
                    && shell.isStableDescentSupport(client, detectedFeet.down()),
                sealEligible,
                nowMs
            )
        );
        DescentWaterContainmentController.Episode episode = decision.episode();
        shell.logger().warn(
            "descent.water_containment.detected instanceId={} commandId={} objectiveReason={} trigger={} waterKind={} step={} stage={} waterCell={} openedCell={} target={} support={} dryAnchor={} actualFeet={} grounded={} wet={} supportStable={} episode={} fillerUsed={} bridgeBudget={} elapsedMs={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.objectiveReason,
            trigger.name(),
            run.containmentWaterKind,
            step == null ? run.stepIndex : step.index(),
            run.stage,
            frozenWater.toShortString(),
            openedCell == null ? "none" : openedCell.toShortString(),
            containmentTarget(run),
            containmentSupport(run),
            run.lastVerifiedDryFeet == null ? "none" : run.lastVerifiedDryFeet.toShortString(),
            detectedFeet.toShortString(),
            player.isOnGround(),
            player.isTouchingWater(),
            shell.isStableDescentSupport(client, detectedFeet.down()),
            run.waterContainment.uniqueEpisodeCount(),
            run.supportBridges,
            Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth),
            episode == null ? 0L : Math.max(0L, nowMs - episode.startedAtMs()),
            decision.reason()
        );
        if (decision.action() == DescentWaterContainmentController.Action.ATTEMPT_SEAL) {
            shell.logger().info(
                "descent.water_containment.seal_started instanceId={} commandId={} objectiveReason={} trigger={} waterKind={} step={} stage={} waterCell={} openedCell={} target={} support={} dryAnchor={} actualFeet={} grounded={} wet={} supportStable={} episode={} fillerUsed={} bridgeBudget={} elapsedMs={} reason={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                trigger.name(),
                run.containmentWaterKind,
                step == null ? run.stepIndex : step.index(),
                run.stage,
                frozenWater.toShortString(),
                openedCell == null ? "none" : openedCell.toShortString(),
                containmentTarget(run),
                containmentSupport(run),
                run.lastVerifiedDryFeet == null ? "none" : run.lastVerifiedDryFeet.toShortString(),
                detectedFeet.toShortString(),
                player.isOnGround(),
                player.isTouchingWater(),
                shell.isStableDescentSupport(client, detectedFeet.down()),
                run.waterContainment.uniqueEpisodeCount(),
                run.supportBridges,
                Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth),
                0L,
                decision.reason()
            );
        }
        return decision;
    }

    private ControlDecision resolveWaterContainment(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs
    ) {
        DescentWaterContainmentController.Episode episode = run.waterContainment.episode();
        if (episode == null) {
            return rejectWaterContainment(
                effective,
                client,
                player,
                run,
                nowMs,
                "missing_episode"
            );
        }
        BlockPos actualFeet = player.getBlockPos().toImmutable();
        BlockPos waterCell = blockPos(episode.key().waterCell());
        BlockPos dryAnchor = blockPos(episode.dryAnchor());
        boolean waterPresent = isWaterBlockState(client.world.getBlockState(waterCell));
        boolean placementVerificationPending =
            shell.blockPlaceController().isAwaitingVerification(
                descentSupportCommandId(run, run.containmentStep, waterCell)
            );
        boolean anchorValid = isValidDescentDryAnchor(client, dryAnchor);
        McbotFabricClient.LookAngles anchorLook =
            shell.lookAnglesToPoint(player, Vec3d.ofCenter(dryAnchor));
        boolean aligned = !DescentControlPlanner.shouldHoldMoveForYaw(
            LookController.normalizeYaw(anchorLook.yaw() - player.getYaw()),
            McbotFabricClient.DESCENT_MOVE_YAW_TOLERANCE_DEG
        );
        boolean wasSealing =
            run.waterContainment.phase() == DescentWaterContainmentController.Phase.SEALING;
        DescentWaterContainmentController.Decision decision = run.waterContainment.tick(
            new DescentWaterContainmentController.Observation(
                nowMs,
                containmentCell(actualFeet),
                player.isTouchingWater(),
                player.isOnGround(),
                isClearDescentBody(client, actualFeet),
                shell.isStableDescentSupport(client, actualFeet.down()),
                anchorValid,
                aligned,
                waterPresent,
                run.containmentSealPlacementVerified && !waterPresent
                    ? DescentWaterContainmentController.SealStatus.SUCCEEDED
                    : !waterPresent && !placementVerificationPending
                        ? DescentWaterContainmentController.SealStatus.FAILED
                        : DescentWaterContainmentController.SealStatus.RUNNING
            )
        );
        if (wasSealing
            && !waterPresent
            && run.containmentSealPlacementVerified
            && !run.containmentSealLogged) {
            run.containmentSealLogged = true;
            shell.logger().info(
                "descent.water_containment.sealed instanceId={} commandId={} objectiveReason={} trigger={} waterKind={} step={} stage={} waterCell={} openedCell={} target={} support={} dryAnchor={} actualFeet={} grounded={} wet={} supportStable={} episode={} fillerConsumed={} fillerUsed={} bridgeBudget={} elapsedMs={} reason=seal_verified",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                episode.key().trigger().name(),
                run.containmentWaterKind,
                episode.key().stepIndex(),
                run.stage,
                waterCell.toShortString(),
                containmentOpenedCell(episode),
                containmentTarget(run),
                containmentSupport(run),
                dryAnchor.toShortString(),
                actualFeet.toShortString(),
                player.isOnGround(),
                player.isTouchingWater(),
                shell.isStableDescentSupport(client, actualFeet.down()),
                run.waterContainment.uniqueEpisodeCount(),
                Math.max(0, run.supportBridges - run.containmentBridgesAtStart),
                run.supportBridges,
                Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth),
                Math.max(0L, nowMs - episode.startedAtMs())
            );
        }
        if (decision.action() == DescentWaterContainmentController.Action.ATTEMPT_SEAL) {
            WaterContainmentEventSnapshot eventSnapshot =
                snapshotWaterContainmentEvent(run, episode);
            ControlDecision placement = placeDescentSupport(
                client,
                player,
                effective,
                run,
                run.containmentStep,
                nowMs,
                "descent_water_adjacent:" + waterCell.toShortString(),
                waterCell
            );
            String placementReason = placement.intent() == null ? "" : placement.intent().reason();
            if (placementReason != null && placementReason.startsWith("descent_reroute:")) {
                logWaterContainmentRerouted(
                    client,
                    player,
                    eventSnapshot,
                    actualFeet,
                    nowMs,
                    placementReason
                );
                clearPostBreakProbe(run);
                clearWaterContainmentState(run, true);
            } else if (placementReason != null && placementReason.startsWith("descent_failed:")) {
                logWaterContainmentRejected(
                    client,
                    player,
                    eventSnapshot,
                    actualFeet,
                    nowMs,
                    placementReason,
                    false
                );
                clearPostBreakProbe(run);
                clearWaterContainmentState(run, true);
            }
            return placement;
        }
        if (decision.action() == DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR
            || decision.action() == DescentWaterContainmentController.Action.MOVE_TO_ANCHOR) {
            run.containmentRetreatUsed = true;
            if (!run.containmentRetreatLogged) {
                run.containmentRetreatLogged = true;
                shell.logger().warn(
                    "descent.water_containment.retreat_started instanceId={} commandId={} objectiveReason={} trigger={} waterKind={} step={} stage={} waterCell={} openedCell={} target={} support={} dryAnchor={} actualFeet={} grounded={} wet={} supportStable={} episode={} fillerUsed={} bridgeBudget={} elapsedMs={} reason={}",
                    shell.instanceId(),
                    run.commandId,
                    run.objectiveReason,
                    episode.key().trigger().name(),
                    run.containmentWaterKind,
                    episode.key().stepIndex(),
                    run.stage,
                    waterCell.toShortString(),
                    containmentOpenedCell(episode),
                    containmentTarget(run),
                    containmentSupport(run),
                    dryAnchor.toShortString(),
                    actualFeet.toShortString(),
                    player.isOnGround(),
                    player.isTouchingWater(),
                    shell.isStableDescentSupport(client, actualFeet.down()),
                    run.waterContainment.uniqueEpisodeCount(),
                    run.supportBridges,
                    Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth),
                    Math.max(0L, nowMs - episode.startedAtMs()),
                    decision.reason()
                );
            }
            BrainLink.Intent intent = shell.lookIntentForAngles(
                effective,
                anchorLook.yaw(),
                anchorLook.pitch(),
                decision.action() == DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR
                    ? "descent_water_retreat_align"
                    : "descent_water_retreat"
            );
            InputState input = waterContainmentRetreatInput(decision.action());
            if (decision.action() != DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR) {
                return new ControlDecision(intent, input);
            }
            LookDemand criticalLook = criticalWaterRetreatDemand(
                run.commandId,
                dryAnchor,
                anchorLook,
                intent.reason()
            );
            LookDemand legacyLook = LookDemand.fromNormalDecision(
                intent,
                input,
                anchorLook.yaw(),
                anchorLook.pitch()
            );
            return new ControlDecision(intent, input, criticalLook, legacyLook);
        }
        if (decision.action() == DescentWaterContainmentController.Action.HOLD_DRY) {
            return new ControlDecision(
                shell.stopFrom(effective, "descent_water_dry_settle"),
                InputState.stop()
            );
        }
        if (decision.action() == DescentWaterContainmentController.Action.RECOVERED) {
            WaterContainmentEventSnapshot eventSnapshot =
                snapshotWaterContainmentEvent(run, episode);
            shell.logger().info(
                "descent.water_containment.dry_recovered instanceId={} commandId={} objectiveReason={} trigger={} waterKind={} step={} stage={} waterCell={} openedCell={} target={} support={} dryAnchor={} actualFeet={} grounded={} wet={} supportStable={} episode={} dryStablePolls={} fillerUsed={} bridgeBudget={} elapsedMs={} reason={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                episode.key().trigger().name(),
                run.containmentWaterKind,
                episode.key().stepIndex(),
                run.stage,
                waterCell.toShortString(),
                containmentOpenedCell(episode),
                containmentTarget(run),
                containmentSupport(run),
                dryAnchor.toShortString(),
                actualFeet.toShortString(),
                player.isOnGround(),
                player.isTouchingWater(),
                shell.isStableDescentSupport(client, actualFeet.down()),
                run.waterContainment.uniqueEpisodeCount(),
                decision.stableDryPolls(),
                run.supportBridges,
                Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth),
                Math.max(0L, nowMs - episode.startedAtMs()),
                decision.reason()
            );
            StaircaseDescentPlanner.Step rejectedStep = run.containmentStep;
            boolean mustReroute = DescentWaterContainmentController.mustRerouteAfterRecovery(
                episode.key().trigger(),
                run.containmentRetreatUsed,
                rejectedStep == null,
                rejectedStep != null && isWaterSafety(descentStepSafety(client, rejectedStep))
            );
            clearPostBreakProbe(run);
            clearWaterContainmentState(run, true);
            if (!mustReroute) {
                return new ControlDecision(
                    shell.stopFrom(effective, "descent_water_containment_recovered"),
                    InputState.stop()
                );
            }
            if (rejectedStep == null) {
                return failDescent(
                    effective,
                    run,
                    nowMs,
                    "descent_water_containment_no_step"
                );
            }
            ControlDecision reroute = rerouteOrFailDescent(
                effective,
                client,
                player,
                run,
                rejectedStep,
                nowMs,
                "descent_water_adjacent:" + waterCell.toShortString() + ":contained_retreat"
            );
            String rerouteReason = reroute.intent() == null ? "" : reroute.intent().reason();
            if (rerouteReason != null
                && (rerouteReason.startsWith("descent_reroute:")
                    || rerouteReason.startsWith("descent_mine_through:"))) {
                logWaterContainmentRerouted(
                    client,
                    player,
                    eventSnapshot,
                    actualFeet,
                    nowMs,
                    rerouteReason
                );
            } else {
                logWaterContainmentRejected(
                    client,
                    player,
                    eventSnapshot,
                    actualFeet,
                    nowMs,
                    rerouteReason,
                    false
                );
            }
            return reroute;
        }
        if (decision.action() == DescentWaterContainmentController.Action.REJECTED) {
            return rejectWaterContainment(
                effective,
                client,
                player,
                run,
                nowMs,
                decision.reason()
            );
        }
        return new ControlDecision(
            shell.stopFrom(effective, "descent_water_containment_hold"),
            InputState.stop()
        );
    }

    static LookDemand criticalWaterRetreatDemand(
        String commandId,
        BlockPos dryAnchor,
        McbotFabricClient.LookAngles anchorLook,
        String reason
    ) {
        return new LookDemand(
            LookDemand.Owner.SURVIVAL,
            "survival:"
                + commandId
                + ":descent_water_retreat:"
                + dryAnchor.getX()
                + ":"
                + dryAnchor.getY()
                + ":"
                + dryAnchor.getZ(),
            LookDemand.Profile.CRITICAL,
            anchorLook.yaw(),
            anchorLook.pitch(),
            LookDemand.RetargetPolicy.IMMEDIATE,
            commandId,
            reason
        );
    }

    static InputState waterContainmentRetreatInput(
        DescentWaterContainmentController.Action action
    ) {
        if (action == DescentWaterContainmentController.Action.MOVE_TO_ANCHOR) {
            return new InputState(true, false, false, false, true, false, 1.0F, 0.0F);
        }
        if (action == DescentWaterContainmentController.Action.ALIGN_TO_ANCHOR) {
            return new InputState(false, false, false, false, false, true, 0.0F, 0.0F);
        }
        return InputState.stop();
    }

    private ControlDecision rejectWaterContainment(
        BrainLink.Intent effective,
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        long nowMs,
        String reason
    ) {
        DescentWaterContainmentController.Episode episode = run.waterContainment.episode();
        BlockPos actualFeet = player.getBlockPos().toImmutable();
        boolean timeout = reason != null && reason.contains("timeout");
        logWaterContainmentRejected(client, player, run, episode, actualFeet, nowMs, reason, timeout);
        clearPostBreakProbe(run);
        clearWaterContainmentState(run, true);
        return failDescent(
            effective,
            run,
            nowMs,
            "descent_water_containment_" + reason
        );
    }

    private void logWaterContainmentRerouted(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        DescentWaterContainmentController.Episode episode,
        BlockPos actualFeet,
        long nowMs,
        String reason
    ) {
        logWaterContainmentRerouted(
            client,
            player,
            snapshotWaterContainmentEvent(run, episode),
            actualFeet,
            nowMs,
            reason
        );
    }

    private void logWaterContainmentRerouted(
        MinecraftClient client,
        ClientPlayerEntity player,
        WaterContainmentEventSnapshot snapshot,
        BlockPos actualFeet,
        long nowMs,
        String reason
    ) {
        shell.logger().info(
            "descent.water_containment.rerouted instanceId={} commandId={} objectiveReason={} trigger={} waterKind={} step={} stage={} waterCell={} openedCell={} target={} support={} dryAnchor={} actualFeet={} grounded={} wet={} supportStable={} episode={} fillerUsed={} bridgeBudget={} elapsedMs={} reason={}",
            shell.instanceId(),
            snapshot.commandId(),
            snapshot.objectiveReason(),
            snapshot.trigger(),
            snapshot.waterKind(),
            snapshot.step(),
            snapshot.stage(),
            snapshot.waterCell(),
            snapshot.openedCell(),
            snapshot.target(),
            snapshot.support(),
            snapshot.dryAnchor(),
            actualFeet.toShortString(),
            player != null && player.isOnGround(),
            player != null && player.isTouchingWater(),
            client != null && client.world != null
                && shell.isStableDescentSupport(client, actualFeet.down()),
            snapshot.episode(),
            snapshot.fillerUsed(),
            snapshot.bridgeBudget(),
            Math.max(0L, nowMs - snapshot.startedAtMs()),
            reason
        );
    }

    private void logWaterContainmentRejected(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        DescentWaterContainmentController.Episode episode,
        BlockPos actualFeet,
        long nowMs,
        String reason,
        boolean timeout
    ) {
        logWaterContainmentRejected(
            client,
            player,
            snapshotWaterContainmentEvent(run, episode),
            actualFeet,
            nowMs,
            reason,
            timeout
        );
    }

    private void logWaterContainmentRejected(
        MinecraftClient client,
        ClientPlayerEntity player,
        WaterContainmentEventSnapshot snapshot,
        BlockPos actualFeet,
        long nowMs,
        String reason,
        boolean timeout
    ) {
        String event = timeout
            ? "descent.water_containment.timeout"
            : "descent.water_containment.rejected";
        shell.logger().warn(
            "{} instanceId={} commandId={} objectiveReason={} trigger={} waterKind={} step={} stage={} waterCell={} openedCell={} target={} support={} dryAnchor={} actualFeet={} grounded={} wet={} supportStable={} episode={} fillerUsed={} bridgeBudget={} elapsedMs={} reason={}",
            event,
            shell.instanceId(),
            snapshot.commandId(),
            snapshot.objectiveReason(),
            snapshot.trigger(),
            snapshot.waterKind(),
            snapshot.step(),
            snapshot.stage(),
            snapshot.waterCell(),
            snapshot.openedCell(),
            snapshot.target(),
            snapshot.support(),
            snapshot.dryAnchor(),
            actualFeet.toShortString(),
            player != null && player.isOnGround(),
            player != null && player.isTouchingWater(),
            client != null && client.world != null
                && shell.isStableDescentSupport(client, actualFeet.down()),
            snapshot.episode(),
            snapshot.fillerUsed(),
            snapshot.bridgeBudget(),
            Math.max(0L, nowMs - snapshot.startedAtMs()),
            reason
        );
    }

    private static WaterContainmentEventSnapshot snapshotWaterContainmentEvent(
        DescentRun run,
        DescentWaterContainmentController.Episode episode
    ) {
        long startedAtMs = episode == null ? 0L : episode.startedAtMs();
        return new WaterContainmentEventSnapshot(
            run == null ? "" : run.commandId,
            run == null ? "" : run.objectiveReason,
            episode == null ? "unknown" : episode.key().trigger().name(),
            run == null ? "" : run.containmentWaterKind,
            episode == null ? run == null ? 0 : run.stepIndex : episode.key().stepIndex(),
            run == null ? "unknown" : run.stage.name(),
            episode == null ? "none" : blockPos(episode.key().waterCell()).toShortString(),
            containmentOpenedCell(episode),
            containmentTarget(run),
            containmentSupport(run),
            episode == null || episode.dryAnchor() == null
                ? run == null || run.lastVerifiedDryFeet == null
                    ? "none"
                    : run.lastVerifiedDryFeet.toShortString()
                : blockPos(episode.dryAnchor()).toShortString(),
            run == null ? 0 : run.waterContainment.uniqueEpisodeCount(),
            run == null ? 0 : run.supportBridges,
            run == null
                ? 0
                : Math.max(McbotFabricClient.DESCENT_MAX_SUPPORT_BRIDGES, run.depth),
            startedAtMs
        );
    }

    private static String containmentOpenedCell(
        DescentWaterContainmentController.Episode episode
    ) {
        return episode == null || episode.key().openedCell() == null
            ? "none"
            : blockPos(episode.key().openedCell()).toShortString();
    }

    private static String containmentTarget(DescentRun run) {
        return run == null || run.containmentStep == null
            ? "none"
            : run.containmentStep.nextFeet().toShortString();
    }

    private static String containmentSupport(DescentRun run) {
        return run == null || run.containmentStep == null
            ? "none"
            : run.containmentStep.support().toShortString();
    }

    private boolean isValidDescentDryAnchor(MinecraftClient client, BlockPos anchor) {
        return anchor != null
            && isClearDescentBody(client, anchor)
            && !isWaterBlockState(client.world.getBlockState(anchor))
            && !isWaterBlockState(client.world.getBlockState(anchor.up()))
            && shell.isStableDescentSupport(client, anchor.down())
            && shell.firstAdjacentLavaBlock(client, anchor) == null;
    }

    private void clearWaterContainmentState(DescentRun run, boolean resetPlacement) {
        if (run == null) {
            return;
        }
        run.waterContainment.resetEpisode();
        run.containmentStep = null;
        run.containmentRetreatUsed = false;
        run.containmentSealLogged = false;
        run.containmentRetreatLogged = false;
        run.containmentSealPlacementVerified = false;
        run.containmentSealPlaceSpec = null;
        run.containmentSealFaceConstraint = null;
        run.containmentBridgesAtStart = run.supportBridges;
        run.containmentWaterKind = "";
        if (resetPlacement) {
            shell.blockPlaceController().reset();
        }
    }

    private static void clearPostBreakProbe(DescentRun run) {
        if (run == null) {
            return;
        }
        clearPendingBreakConfirmation(run);
        run.postBreakProbePending = false;
        run.postBreakStep = null;
        run.postBreakOpenedCell = null;
        run.postBreakDryPolls = 0;
        run.postBreakProbeStartedAtMs = 0L;
        run.postBreakPhase = "";
        run.postBreakAdvanceStage = false;
    }

    private boolean armObservedPostBreakProbe(
        MinecraftClient client,
        DescentRun run,
        long nowMs
    ) {
        if (client == null || client.world == null || run == null) {
            return false;
        }
        BlockPos target = run.pendingBreakOpenedCell;
        boolean matchesActiveStep = run.pendingBreakStep != null
            && run.pendingBreakStep.index() == run.stepIndex
            && run.pendingBreakStep.currentFeet().equals(run.currentFeet)
            && descentStageForPhase(run.pendingBreakPhase) == run.stage;
        if (run.pendingBreakStep != null && !matchesActiveStep) {
            clearPendingBreakConfirmation(run);
            return false;
        }
        DescentWaterContainmentController.PendingBreakObservation observation =
            DescentWaterContainmentController.classifyPendingBreak(
                matchesActiveStep && target != null,
                target != null && client.world.getBlockState(target).isAir(),
                target != null && isWaterBlockState(client.world.getBlockState(target))
            );
        if (observation == DescentWaterContainmentController.PendingBreakObservation.INTACT) {
            return false;
        }
        clearMatchingDescentClearanceRecovery(run, target);
        shell.blockBreakController().reset();
        armPostBreakProbe(
            run,
            run.pendingBreakStep,
            target,
            run.pendingBreakPhase,
            run.pendingBreakAdvanceStage,
            nowMs
        );
        return true;
    }

    private static void armPostBreakProbe(
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        BlockPos openedCell,
        String phase,
        boolean advanceStage,
        long nowMs
    ) {
        if (run == null || step == null || openedCell == null) {
            return;
        }
        clearPendingBreakConfirmation(run);
        run.postBreakProbePending = true;
        run.postBreakStep = step;
        run.postBreakOpenedCell = openedCell.toImmutable();
        run.postBreakDryPolls = 0;
        run.postBreakProbeStartedAtMs = nowMs;
        run.postBreakPhase = phase == null ? "" : phase;
        run.postBreakAdvanceStage = advanceStage;
    }

    private static void clearPendingBreakConfirmation(DescentRun run) {
        if (run == null) {
            return;
        }
        run.pendingBreakStep = null;
        run.pendingBreakOpenedCell = null;
        run.pendingBreakPhase = "";
        run.pendingBreakAdvanceStage = false;
    }

    private static DescentWaterContainmentController.Cell containmentCell(BlockPos pos) {
        return new DescentWaterContainmentController.Cell(pos.getX(), pos.getY(), pos.getZ());
    }

    private static BlockPos blockPos(DescentWaterContainmentController.Cell cell) {
        return new BlockPos(cell.x(), cell.y(), cell.z());
    }

    // Controlled safe-fall admission samples the complete horizontal launch envelope in addition to the
    // lower drop column. The first physically valid shallow-to-deep landing wins, but a launch-envelope
    // rejection is terminal for this directed transition because its geometry is common to every depth.
    private SafeFallLaunchEvaluation evaluateSafeFallLaunch(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step rejectedStep,
        Double targetY
    ) {
        if (client == null || client.world == null || player == null || run == null || rejectedStep == null) {
            return new SafeFallLaunchEvaluation(
                new DescentSafeFallLaunchPlanner.Decision(null, "invalid_request"),
                "invalid"
            );
        }
        String signature = run.currentFeet.toShortString() + "->" + rejectedStep.nextFeet().toShortString();
        DescentSafeFallLaunchPlanner.Decision last =
            new DescentSafeFallLaunchPlanner.Decision(null, "no_safe_landing");
        for (int fallBlocks = 1; fallBlocks <= DESCENT_MAX_HEALTH_FALL_BLOCKS; fallBlocks++) {
            BlockPos landing = rejectedStep.nextFeet().down(fallBlocks - 1);
            DescentSafeFallLaunchPlanner.Request request = sampleSafeFallLaunchRequest(
                client,
                player,
                run,
                run.currentFeet,
                rejectedStep.upperClear(),
                rejectedStep.sightClear(),
                rejectedStep.nextFeet(),
                landing,
                fallBlocks,
                targetY,
                true
            );
            last = DescentSafeFallLaunchPlanner.plan(request);
            if (last.accepted()) {
                return new SafeFallLaunchEvaluation(last, signature);
            }
            if (isLaunchEnvelopeTerminalReason(last.reason())) {
                return new SafeFallLaunchEvaluation(last, signature);
            }
            if ("landing_outside_depth_band".equals(last.reason())) {
                break;
            }
        }
        return new SafeFallLaunchEvaluation(last, signature);
    }

    private DescentSafeFallLaunchPlanner.Request sampleSafeFallLaunchRequest(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        BlockPos origin,
        BlockPos launchFeet,
        BlockPos launchHead,
        BlockPos dropColumn,
        BlockPos landing,
        int fallDepth,
        Double targetY,
        boolean requirePlayerAtOrigin
    ) {
        boolean originDry = isDryDescentBody(client, player, origin);
        boolean originGrounded = !requirePlayerAtOrigin
            || (player.isOnGround() && origin.equals(player.getBlockPos()));
        DescentSafeFallLaunchPlanner.Origin sampledOrigin = new DescentSafeFallLaunchPlanner.Origin(
            voxelCell(origin),
            originGrounded,
            originDry,
            isClearDescentBody(client, origin),
            shell.isStableDescentSupport(client, origin.down()),
            shell.firstHazardBlockDetail(client, List.of(origin, origin.up())) == null,
            shell.firstAdjacentLavaBlock(client, origin) != null
                || shell.firstAdjacentLavaBlock(client, origin.up()) != null
        );
        DescentSafeFallLaunchPlanner.LaunchCell sampledFeet = sampleSafeFallLaunchCell(client, launchFeet);
        DescentSafeFallLaunchPlanner.LaunchCell sampledHead = sampleSafeFallLaunchCell(client, launchHead);

        boolean columnClear = true;
        boolean columnDry = true;
        boolean columnHazardFree = true;
        for (BlockPos cell = dropColumn; cell.getY() > landing.getY(); cell = cell.down()) {
            BlockState state = client.world.getBlockState(cell);
            columnClear &= state.getCollisionShape(client.world, cell).isEmpty();
            columnDry &= state.getFluidState().isEmpty();
            columnHazardFree &= !shell.isHazardBlockState(state);
        }
        BlockPos landingHead = landing.up();
        BlockState landingFeetState = client.world.getBlockState(landing);
        BlockState landingHeadState = client.world.getBlockState(landingHead);
        boolean[] feetLevelSolid = new boolean[4];
        boolean[] headLevelSolid = new boolean[4];
        Direction[] horizontal = {Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST};
        for (int i = 0; i < horizontal.length; i++) {
            BlockPos sideFeet = landing.offset(horizontal[i]);
            BlockPos sideHead = sideFeet.up();
            feetLevelSolid[i] = !client.world.getBlockState(sideFeet)
                .getCollisionShape(client.world, sideFeet).isEmpty();
            headLevelSolid[i] = !client.world.getBlockState(sideHead)
                .getCollisionShape(client.world, sideHead).isEmpty();
        }
        boolean landingDry = landingFeetState.getFluidState().isEmpty()
            && landingHeadState.getFluidState().isEmpty();
        DescentSafeFallLaunchPlanner.Landing sampledLanding = new DescentSafeFallLaunchPlanner.Landing(
            voxelCell(landing),
            columnClear,
            columnDry,
            columnHazardFree,
            shell.isStableDescentSupport(client, landing.down()),
            landingFeetState.getCollisionShape(client.world, landing).isEmpty(),
            landingHeadState.getCollisionShape(client.world, landingHead).isEmpty(),
            landingDry,
            shell.firstHazardBlockDetail(client, List.of(landing, landingHead)) == null,
            shell.firstAdjacentLavaBlock(client, landing) != null,
            SafeFallPlanner.isBoxedPit(feetLevelSolid, headLevelSolid),
            MiningWorkspaceDepthPolicy.safeFallLandingAllowed(
                run.commandId,
                run.objectiveReason,
                targetY,
                landing.getY()
            )
        );
        return new DescentSafeFallLaunchPlanner.Request(
            sampledOrigin,
            sampledFeet,
            sampledHead,
            voxelCell(dropColumn),
            sampledLanding,
            fallDepth,
            DESCENT_MAX_SAFE_FALL_BLOCKS,
            DESCENT_MAX_HEALTH_FALL_BLOCKS,
            run.safeFallSelectedHealth > 0.0F ? run.safeFallSelectedHealth : player.getHealth(),
            DESCENT_SAFE_FALL_HEALTH_MARGIN
        );
    }

    private DescentSafeFallLaunchPlanner.LaunchCell sampleSafeFallLaunchCell(
        MinecraftClient client,
        BlockPos cell
    ) {
        BlockState state = client.world.getBlockState(cell);
        return new DescentSafeFallLaunchPlanner.LaunchCell(
            voxelCell(cell),
            state.getCollisionShape(client.world, cell).isEmpty(),
            state.isIn(BlockTags.LEAVES),
            !state.getFluidState().isEmpty(),
            shell.isHazardBlockState(state),
            shell.firstAdjacentLavaBlock(client, cell) != null,
            state.getBlock() instanceof FallingBlock
        );
    }

    private static boolean isLaunchEnvelopeTerminalReason(String reason) {
        return reason != null && (
            reason.startsWith("origin_")
                || reason.startsWith("launch_")
                || reason.startsWith("clearance_")
                || reason.equals("invalid_request")
                || reason.equals("launch_not_cardinal")
                || reason.equals("launch_body_disconnected")
                || reason.equals("drop_column_disconnected")
                || reason.equals("landing_geometry_mismatch")
        );
    }

    private ControlDecision resolveActiveSafeFallControl(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs
    ) {
        DescentSafeFallLaunchPlanner.Plan plan = run.safeFallPlan;
        if (plan == null) {
            return rejectSafeFallBeforeDeparture(
                effective,
                run,
                nowMs,
                "missing_frozen_plan"
            );
        }
        boolean packageValid = safeFallPackageStillValid(client, player, effective, run);
        DescentSafeFallController.Decision decision = run.safeFallController.tick(
            safeFallObservation(
                client,
                player,
                run,
                nowMs,
                DescentSafeFallController.ClearanceStatus.NONE,
                null,
                packageValid
            )
        );
        return applySafeFallDecision(client, player, effective, run, nowMs, decision);
    }

    private ControlDecision applySafeFallDecision(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs,
        DescentSafeFallController.Decision decision
    ) {
        if (decision == null) {
            return rejectSafeFallBeforeDeparture(effective, run, nowMs, "missing_controller_decision");
        }
        if (decision.expectedDamageLatched() && run.safeFallExpectedDamage <= 0.0F) {
            run.safeFallExpectedDamage = decision.plan() == null
                ? 0.0F
                : decision.plan().expectedDamage();
        }
        if (decision.transitioned()
            && decision.phase() == DescentSafeFallController.Phase.LAUNCHING
            && !run.safeFallLaunchLogged) {
            run.safeFallLaunchLogged = true;
            shell.logger().info(
                "descent.safe_fall.launch_started instanceId={} commandId={} objectiveReason={} phase={} origin={} column={} landing={} fallDepth={} alignmentElapsedMs={} launchElapsedMs=0 actualFeet={} expectedDamage={} elapsedMs={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                decision.phase(),
                safeFallPos(decision.plan().origin()),
                safeFallPos(decision.plan().dropColumn()),
                safeFallPos(decision.plan().landing()),
                decision.plan().fallDepth(),
                Math.max(0L, nowMs - run.safeFallSelectedAtMs),
                player.getBlockPos().toShortString(),
                decision.plan().expectedDamage(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
        }
        if (decision.departed() && !run.safeFallDepartureLogged) {
            run.safeFallDepartureLogged = true;
            shell.logger().info(
                "descent.safe_fall.departed instanceId={} commandId={} objectiveReason={} phase={} origin={} column={} landing={} actualFeet={} grounded={} alignmentElapsedMs={} launchElapsedMs={} expectedDamage={} elapsedMs={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                decision.phase(),
                safeFallPos(decision.plan().origin()),
                safeFallPos(decision.plan().dropColumn()),
                safeFallPos(decision.plan().landing()),
                player.getBlockPos().toShortString(),
                player.isOnGround(),
                Math.max(0L, run.safeFallController.launchStartedAtMs() - run.safeFallSelectedAtMs),
                Math.max(0L, nowMs - run.safeFallController.launchStartedAtMs()),
                decision.plan().expectedDamage(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
        }
        if (decision.departed() && !player.isOnGround() && !run.safeFallAirborneLogged) {
            run.safeFallAirborneLogged = true;
            shell.logger().info(
                "descent.safe_fall.airborne instanceId={} commandId={} objectiveReason={} phase={} column={} landing={} actualFeet={} captured={} launchElapsedMs={} elapsedMs={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                decision.phase(),
                safeFallPos(decision.plan().dropColumn()),
                safeFallPos(decision.plan().landing()),
                player.getBlockPos().toShortString(),
                decision.columnCaptured(),
                Math.max(0L, nowMs - run.safeFallController.launchStartedAtMs()),
                Math.max(0L, nowMs - run.startedAtMs)
            );
        }
        if (decision.action() == DescentSafeFallController.Action.REJECTED) {
            String classifiedReason = classifiedSafeFallRejectionReason(run, decision.reason());
            if (decision.departed()) {
                return rejectSafeFallLanding(effective, player, run, nowMs, classifiedReason);
            }
            return rejectSafeFallBeforeDeparture(effective, run, nowMs, classifiedReason);
        }
        if (decision.action() == DescentSafeFallController.Action.LANDED) {
            return completeSafeFallLanding(effective, player, run, nowMs, decision);
        }
        if (decision.action() == DescentSafeFallController.Action.CLEAR_BLOCKER) {
            return resolveSafeFallClearance(client, player, effective, run, nowMs, decision);
        }
        DescentSafeFallLaunchPlanner.Plan plan = decision.plan();
        if (plan == null) {
            return rejectSafeFallBeforeDeparture(effective, run, nowMs, "missing_decision_plan");
        }
        BlockPos column = safeFallBlockPos(plan.dropColumn());
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, Vec3d.ofCenter(column));
        BrainLink.Intent lookIntent = shell.lookIntentForAngles(
            effective,
            look.yaw(),
            look.pitch(),
            "descent_safe_fall_" + decision.phase().name().toLowerCase(Locale.ROOT)
        );
        boolean holdForward = decision.action() == DescentSafeFallController.Action.HOLD_FORWARD
            || (decision.action() == DescentSafeFallController.Action.HOLD_AIRBORNE
                && !decision.columnCaptured());
        InputState input = holdForward
            ? new InputState(
                true,
                false,
                false,
                false,
                false,
                false,
                DescentSafeFallController.LAUNCH_FORWARD_SCALE,
                0.0F
            )
            : InputState.stop();
        return new ControlDecision(lookIntent, input);
    }

    private ControlDecision resolveSafeFallClearance(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs,
        DescentSafeFallController.Decision decision
    ) {
        VoxelCell clearanceCell = decision.clearanceCell();
        if (clearanceCell == null) {
            DescentSafeFallController.Decision rejected = run.safeFallController.tick(
                safeFallObservation(
                    client,
                    player,
                    run,
                    nowMs,
                    DescentSafeFallController.ClearanceStatus.FAILED,
                    null,
                    false
                )
            );
            return applySafeFallDecision(client, player, effective, run, nowMs, rejected);
        }
        BlockPos target = safeFallBlockPos(clearanceCell);
        if (!clearanceCell.equals(run.safeFallClearanceStartedCell)) {
            run.safeFallClearanceStartedCell = clearanceCell;
            run.safeFallClearanceBreakEngaged = false;
            BlockState blocker = client.world.getBlockState(target);
            run.safeFallClearanceBlockerId = shell.blockId(blocker);
            shell.logger().info(
                "descent.safe_fall.clearance_started instanceId={} commandId={} objectiveReason={} phase={} origin={} blocker={} target={} clearanceIndex={} clearanceCount={} elapsedMs={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                decision.phase(),
                safeFallPos(decision.plan().origin()),
                run.safeFallClearanceBlockerId,
                target.toShortString(),
                run.safeFallController.clearanceIndex(),
                decision.plan().clearanceCells().size(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
            return new ControlDecision(
                shell.lookIntentForBlock(effective, player, target, "descent_safe_fall_clearance_stage"),
                InputState.stop()
            );
        }

        BlockState state = client.world.getBlockState(target);
        boolean airConfirmationInProgress = state.isAir() && run.safeFallClearanceBreakEngaged;
        if (!state.isIn(BlockTags.LEAVES) && !airConfirmationInProgress) {
            shell.blockBreakController().reset();
            DescentSafeFallController.Decision rejected = run.safeFallController.tick(
                safeFallObservation(
                    client,
                    player,
                    run,
                    nowMs,
                    DescentSafeFallController.ClearanceStatus.FAILED,
                    clearanceCell,
                    false
                )
            );
            return applySafeFallDecision(client, player, effective, run, nowMs, rejected);
        }
        if (!airConfirmationInProgress && (
            !state.getFluidState().isEmpty()
                || shell.isHazardBlockState(state)
                || shell.firstAdjacentLavaBlock(client, target) != null
                || state.getBlock() instanceof FallingBlock
        )) {
            shell.blockBreakController().reset();
            DescentSafeFallController.Decision rejected = run.safeFallController.tick(
                safeFallObservation(
                    client,
                    player,
                    run,
                    nowMs,
                    DescentSafeFallController.ClearanceStatus.FAILED,
                    clearanceCell,
                    false
                )
            );
            return applySafeFallDecision(client, player, effective, run, nowMs, rejected);
        }
        if (!airConfirmationInProgress && !shell.isLookingAtBlock(player, target)) {
            return new ControlDecision(
                shell.lookIntentForBlock(effective, player, target, "descent_safe_fall_clearance_face"),
                InputState.stop()
            );
        }
        // BlockBreakController can normally redirect to a cheap occluder. Safe-fall clearance is a
        // much narrower authority: only the one frozen leaf (of at most two) may be mutated. Prove
        // that the crosshair ray actually terminates on that exact cell before giving the shared
        // breaker a tick; an angular match alone is insufficient when another leaf overlaps the ray.
        if (!airConfirmationInProgress && !safeFallRaycastHitsBlock(client, player, target)) {
            run.safeFallPackageRejectionReason = "clearance_raycast_blocked";
            shell.blockBreakController().reset();
            DescentSafeFallController.Decision rejected = run.safeFallController.tick(
                safeFallObservation(
                    client,
                    player,
                    run,
                    nowMs,
                    DescentSafeFallController.ClearanceStatus.FAILED,
                    clearanceCell,
                    false
                )
            );
            return applySafeFallDecision(client, player, effective, run, nowMs, rejected);
        }
        BlockBreakController.Result result = shell.blockBreakController().tick(
            client,
            player,
            target,
            run.commandId + ":safe_fall:clearance:" + run.safeFallController.clearanceIndex(),
            nowMs,
            false,
            4_000L,
            false
        );
        shell.logBlockBreakResult(run.commandId + ":descent:safe_fall:clearance", target, result);
        if (result.actedBlock() != null && !target.equals(result.actedBlock())) {
            shell.blockBreakController().reset();
            DescentSafeFallController.Decision rejected = run.safeFallController.tick(
                safeFallObservation(
                    client,
                    player,
                    run,
                    nowMs,
                    DescentSafeFallController.ClearanceStatus.FAILED,
                    clearanceCell,
                    false
                )
            );
            return withInteraction(
                applySafeFallDecision(client, player, effective, run, nowMs, rejected),
                result
            );
        }
        if (result.status() == BlockBreakController.Status.RUNNING) {
            run.safeFallClearanceBreakEngaged = true;
            return withInteraction(
                new ControlDecision(
                    shell.lookIntentForBlock(
                        effective,
                        player,
                        target,
                        "descent_safe_fall_clearance_breaking:" + result.reason()
                    ),
                    InputState.stop()
                ),
                result
            );
        }
        if (result.status() != BlockBreakController.Status.BROKEN
            || !client.world.getBlockState(target).isAir()) {
            shell.blockBreakController().reset();
            DescentSafeFallController.Decision rejected = run.safeFallController.tick(
                safeFallObservation(
                    client,
                    player,
                    run,
                    nowMs,
                    DescentSafeFallController.ClearanceStatus.FAILED,
                    clearanceCell,
                    false
                )
            );
            return withInteraction(
                applySafeFallDecision(client, player, effective, run, nowMs, rejected),
                result
            );
        }

        boolean packageValid = safeFallPackageStillValid(client, player, effective, run, 1);
        DescentSafeFallController.Decision advanced = run.safeFallController.tick(
            safeFallObservation(
                client,
                player,
                run,
                nowMs,
                DescentSafeFallController.ClearanceStatus.VERIFIED,
                clearanceCell,
                packageValid
            )
        );
        if (packageValid && advanced.action() != DescentSafeFallController.Action.REJECTED) {
            shell.logger().info(
                "descent.safe_fall.clearance_verified instanceId={} commandId={} objectiveReason={} phase={} origin={} blocker={} target={} clearanceIndex={} clearanceCount={} packageValid=true elapsedMs={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                advanced.phase(),
                safeFallPos(run.safeFallPlan.origin()),
                run.safeFallClearanceBlockerId,
                target.toShortString(),
                run.safeFallController.clearanceIndex(),
                run.safeFallPlan.clearanceCells().size(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
        }
        shell.blockBreakController().reset();
        run.safeFallClearanceStartedCell = null;
        run.safeFallClearanceBreakEngaged = false;
        run.safeFallClearanceBlockerId = "";
        if (advanced.action() == DescentSafeFallController.Action.CLEAR_BLOCKER) {
            // Stage the next frozen blocker on a fresh tick; never dispatch two break operations in one
            // client tick.
            return withInteraction(
                resolveSafeFallClearance(client, player, effective, run, nowMs, advanced),
                result
            );
        }
        return withInteraction(
            applySafeFallDecision(client, player, effective, run, nowMs, advanced),
            result
        );
    }

    private static boolean safeFallRaycastHitsBlock(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target
    ) {
        if (client == null || client.world == null || player == null || target == null) {
            return false;
        }
        double reach = Math.min(4.8D, Math.max(1.0D, player.getBlockInteractionRange()));
        Vec3d eye = player.getEyePos();
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye,
            eye.add(player.getRotationVec(1.0F).multiply(reach)),
            RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE,
            player
        ));
        return hit != null
            && hit.getType() == HitResult.Type.BLOCK
            && target.equals(hit.getBlockPos());
    }

    private DescentSafeFallController.Observation safeFallObservation(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        long nowMs,
        DescentSafeFallController.ClearanceStatus clearanceStatus,
        VoxelCell clearanceCell,
        boolean packageValid
    ) {
        BlockPos feet = player.getBlockPos().toImmutable();
        DescentSafeFallLaunchPlanner.Plan plan = run.safeFallPlan;
        BlockPos landing = plan == null ? feet : safeFallBlockPos(plan.landing());
        BlockPos column = plan == null ? feet : safeFallBlockPos(plan.dropColumn());
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, Vec3d.ofCenter(column));
        double yawError = LookController.normalizeYaw(look.yaw() - player.getYaw());
        boolean aligned = !DescentControlPlanner.shouldHoldMoveForYaw(
            yawError,
            McbotFabricClient.DESCENT_MOVE_YAW_TOLERANCE_DEG
        );
        boolean hazardFree = shell.firstHazardBlockDetail(client, List.of(feet, feet.up())) == null
            && shell.firstAdjacentLavaBlock(client, feet) == null;
        return new DescentSafeFallController.Observation(
            nowMs,
            client == null ? null : client.world,
            voxelCell(feet),
            player.getX(),
            player.getZ(),
            player.isOnGround(),
            isDryDescentBody(client, player, feet),
            isClearDescentBody(client, feet),
            hazardFree,
            shell.isStableDescentSupport(client, feet.down()),
            aligned,
            player.getHealth(),
            clearanceStatus,
            clearanceCell,
            packageValid,
            descentStepHorizontalDistance(player, landing),
            McbotFabricClient.DESCENT_STEP_ARRIVE_EPSILON
        );
    }

    private boolean safeFallPackageStillValid(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run
    ) {
        return safeFallPackageStillValid(client, player, effective, run, 0);
    }

    private boolean safeFallPackageStillValid(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        int verifiedClearanceAdvance
    ) {
        DescentSafeFallLaunchPlanner.Plan plan = run.safeFallPlan;
        if (plan == null || client == null || client.world == null || player == null) {
            return false;
        }
        DescentSafeFallController.Phase phase = run.safeFallController.phase();
        boolean requirePlayerAtOrigin = phase == DescentSafeFallController.Phase.SELECTED
            || phase == DescentSafeFallController.Phase.CLEARING
            || phase == DescentSafeFallController.Phase.ALIGNING;
        DescentSafeFallLaunchPlanner.Request current = sampleSafeFallLaunchRequest(
            client,
            player,
            run,
            safeFallBlockPos(plan.origin()),
            safeFallBlockPos(plan.launchFeet()),
            safeFallBlockPos(plan.launchHead()),
            safeFallBlockPos(plan.dropColumn()),
            safeFallBlockPos(plan.landing()),
            plan.fallDepth(),
            run.safeFallTargetY,
            requirePlayerAtOrigin
        );
        DescentSafeFallLaunchPlanner.Decision revalidated =
            DescentSafeFallLaunchPlanner.revalidate(plan, current);
        if (!revalidated.accepted()) {
            run.safeFallPackageRejectionReason = revalidated.reason();
            return false;
        }
        int expectedIndex = Math.min(
            plan.clearanceCells().size(),
            Math.max(0, run.safeFallController.clearanceIndex() + verifiedClearanceAdvance)
        );
        List<VoxelCell> expectedRemaining = plan.clearanceCells().subList(
            expectedIndex,
            plan.clearanceCells().size()
        );
        if (!expectedRemaining.equals(revalidated.plan().clearanceCells())) {
            run.safeFallPackageRejectionReason = "clearance_prefix_changed";
            return false;
        }
        run.safeFallPackageRejectionReason = "";
        return true;
    }

    private static String classifiedSafeFallRejectionReason(DescentRun run, String controllerReason) {
        String reason = controllerReason == null ? "rejected" : controllerReason;
        if (run == null
            || run.safeFallPackageRejectionReason == null
            || run.safeFallPackageRejectionReason.isBlank()
            || (!reason.startsWith("geometry_invalidated")
                && !"clearance_failed".equals(reason))) {
            return reason;
        }
        return reason + ":" + run.safeFallPackageRejectionReason;
    }

    private ControlDecision completeSafeFallLanding(
        BrainLink.Intent effective,
        ClientPlayerEntity player,
        DescentRun run,
        long nowMs,
        DescentSafeFallController.Decision decision
    ) {
        DescentSafeFallLaunchPlanner.Plan plan = decision.plan();
        BlockPos previousFeet = run.currentFeet;
        BlockPos landedAt = safeFallBlockPos(plan.landing());
        BlockPos actualFeet = player.getBlockPos().toImmutable();
        int previousStep = run.stepIndex;
        int depthDelta = commitValidatedDescentReanchor(run, actualFeet);
        shell.logger().info(
            "descent.step_reached instanceId={} commandId={} step={} position={} health={} level=false tunnelBlocksUsed={} arrivalPolls={} grounded=true dry=true bodyClear=true hazardFree=true supportStable=true recovery=safe_fall",
            shell.instanceId(),
            run.commandId,
            previousStep,
            actualFeet.toShortString(),
            player.getHealth(),
            run.tunnelBlocksUsed,
            decision.stableLandingPolls()
        );
        shell.logger().warn(
            "descent.safe_fall_landed instanceId={} commandId={} previousFeet={} plannedLandingFeet={} actualFeet={} depthDelta={} depthReached={} step={} fallDepth={} expectedDamage={} elapsedMs={}",
            shell.instanceId(),
            run.commandId,
            previousFeet.toShortString(),
            landedAt.toShortString(),
            actualFeet.toShortString(),
            depthDelta,
            run.depthReached,
            run.stepIndex,
            plan.fallDepth(),
            plan.expectedDamage(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        finishActiveSafeFall(run, true, false);
        return new ControlDecision(shell.stopFrom(effective, "descent_safe_fall_landed"), InputState.stop());
    }

    private ControlDecision rejectSafeFallBeforeDeparture(
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs,
        String reason
    ) {
        DescentSafeFallLaunchPlanner.Plan plan = run.safeFallPlan;
        DescentSafeFallLaunchPlanner.Evaluation evaluation = run.safeFallEvaluation;
        VoxelCell eventOrigin = plan != null
            ? plan.origin()
            : evaluation == null ? null : evaluation.origin();
        VoxelCell eventLaunchFeet = plan != null
            ? plan.launchFeet()
            : evaluation == null ? null : evaluation.launchFeet();
        VoxelCell eventLaunchHead = plan != null
            ? plan.launchHead()
            : evaluation == null ? null : evaluation.launchHead();
        VoxelCell eventColumn = plan != null
            ? plan.dropColumn()
            : evaluation == null ? null : evaluation.dropColumn();
        VoxelCell eventLanding = plan != null
            ? plan.landing()
            : evaluation == null ? null : evaluation.landing();
        int eventFallDepth = plan != null
            ? plan.fallDepth()
            : evaluation == null ? 0 : evaluation.fallDepth();
        int eventExpectedDamage = plan != null
            ? plan.expectedDamage()
            : evaluation == null ? 0 : evaluation.expectedDamage();
        shell.logger().warn(
            "descent.safe_fall.launch_envelope_rejected instanceId={} commandId={} objectiveReason={} phase={} origin={} launchFeet={} launchHead={} column={} landing={} fallDepth={} blocker={} handoffCount={} alignmentElapsedMs={} launchElapsedMs={} actualFeet={} expectedDamage={} elapsedMs={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.objectiveReason,
            run.safeFallController.phase(),
            safeFallPos(eventOrigin),
            safeFallPos(eventLaunchFeet),
            safeFallPos(eventLaunchHead),
            safeFallPos(eventColumn),
            safeFallPos(eventLanding),
            eventFallDepth,
            run.safeFallClearanceBlockerId,
            run.safeFallHandoffCount,
            Math.max(0L, nowMs - run.safeFallSelectedAtMs),
            run.safeFallController.launchStartedAtMs() <= 0L
                ? 0L
                : Math.max(0L, nowMs - run.safeFallController.launchStartedAtMs()),
            run.currentFeet.toShortString(),
            eventExpectedDamage,
            Math.max(0L, nowMs - run.startedAtMs),
            reason
        );
        if ("launch_timeout".equals(reason) || "alignment_timeout".equals(reason)) {
            shell.logger().warn(
                "descent.safe_fall_timeout instanceId={} commandId={} column={} landing={} feet={} elapsedMs={} reason={}",
                shell.instanceId(),
                run.commandId,
                safeFallPos(plan == null ? null : plan.dropColumn()),
                safeFallPos(plan == null ? null : plan.landing()),
                run.currentFeet.toShortString(),
                Math.max(0L, nowMs - run.safeFallController.launchStartedAtMs()),
                reason
            );
        }
        run.safeFallHandoffPending = true;
        run.safeFallHandoffReason = run.safeFallOriginalStallReason == null
            ? "descent_next_support_missing:safe_fall"
            : run.safeFallOriginalStallReason;
        run.safeFallRejectionReason = reason == null ? "rejected" : reason;
        finishActiveSafeFall(run, true, true);
        return new ControlDecision(
            shell.stopFrom(effective, "descent_safe_fall_handoff_pending:" + run.safeFallRejectionReason),
            InputState.stop()
        );
    }

    private ControlDecision rejectSafeFallLanding(
        BrainLink.Intent effective,
        ClientPlayerEntity player,
        DescentRun run,
        long nowMs,
        String reason
    ) {
        DescentSafeFallLaunchPlanner.Plan plan = run.safeFallPlan;
        shell.logger().warn(
            "descent.safe_fall.landing_rejected instanceId={} commandId={} objectiveReason={} phase={} origin={} column={} landing={} fallDepth={} actualFeet={} expectedDamage={} launchElapsedMs={} elapsedMs={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.objectiveReason,
            run.safeFallController.phase(),
            safeFallPos(plan == null ? null : plan.origin()),
            safeFallPos(plan == null ? null : plan.dropColumn()),
            safeFallPos(plan == null ? null : plan.landing()),
            plan == null ? 0 : plan.fallDepth(),
            player.getBlockPos().toShortString(),
            plan == null ? 0 : plan.expectedDamage(),
            Math.max(0L, nowMs - run.safeFallController.launchStartedAtMs()),
            Math.max(0L, nowMs - run.startedAtMs),
            reason
        );
        if ("landing_timeout".equals(reason)) {
            shell.logger().warn(
                "descent.safe_fall_timeout instanceId={} commandId={} column={} landing={} feet={} elapsedMs={} reason={}",
                shell.instanceId(),
                run.commandId,
                safeFallPos(plan == null ? null : plan.dropColumn()),
                safeFallPos(plan == null ? null : plan.landing()),
                player.getBlockPos().toShortString(),
                Math.max(0L, nowMs - run.safeFallController.launchStartedAtMs()),
                reason
            );
        }
        finishActiveSafeFall(run, true, false);
        return failDescent(effective, run, nowMs, "descent_safe_fall_landing_invalid:" + reason);
    }

    private ControlDecision resolvePendingSafeFallHandoff(
        BrainLink.Intent effective,
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        long nowMs
    ) {
        String stallReason = run.safeFallHandoffReason == null
            ? "descent_next_support_missing:safe_fall"
            : run.safeFallHandoffReason;
        String rejectionReason = run.safeFallRejectionReason == null
            ? "rejected"
            : run.safeFallRejectionReason;
        run.safeFallHandoffPending = false;
        BlockPos actualFeet = player == null ? null : player.getBlockPos().toImmutable();
        boolean validOrigin = player != null
            && actualFeet != null
            && actualFeet.equals(run.currentFeet)
            && player.isOnGround()
            && isDryDescentBody(client, player, actualFeet)
            && isClearDescentBody(client, actualFeet)
            && shell.isStableDescentSupport(client, actualFeet.down())
            && shell.firstHazardBlockDetail(client, List.of(actualFeet, actualFeet.up())) == null
            && shell.firstAdjacentLavaBlock(client, actualFeet) == null;
        if (!validOrigin) {
            shell.logger().warn(
                "descent.safe_fall.handoff instanceId={} commandId={} objectiveReason={} origin={} actualFeet={} grounded={} handoffCount={} elapsedMs={} reason=handoff_origin_invalid rejectionReason={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                run.currentFeet.toShortString(),
                actualFeet == null ? "none" : actualFeet.toShortString(),
                player != null && player.isOnGround(),
                run.safeFallHandoffCount,
                Math.max(0L, nowMs - run.startedAtMs),
                rejectionReason
            );
            return failDescent(
                effective,
                run,
                nowMs,
                stallReason + ":safe_fall_handoff_origin_invalid:" + rejectionReason
            );
        }
        if (run.safeFallHandoffCount >= 1) {
            shell.logger().warn(
                "descent.safe_fall.handoff instanceId={} commandId={} objectiveReason={} origin={} handoffCount={} elapsedMs={} reason=handoff_limit rejectionReason={}",
                shell.instanceId(),
                run.commandId,
                run.objectiveReason,
                run.currentFeet.toShortString(),
                run.safeFallHandoffCount,
                Math.max(0L, nowMs - run.startedAtMs),
                rejectionReason
            );
            return failDescent(effective, run, nowMs, stallReason + ":safe_fall_handoff_limit");
        }
        run.safeFallHandoffCount++;
        ControlDecision fallback = maybeBeginMineThroughDescent(
            effective,
            client,
            run,
            nowMs,
            stallReason
        );
        shell.logger().warn(
            "descent.safe_fall.handoff instanceId={} commandId={} objectiveReason={} origin={} handoffCount={} fallback={} elapsedMs={} reason={} rejectionReason={}",
            shell.instanceId(),
            run.commandId,
            run.objectiveReason,
            run.currentFeet.toShortString(),
            run.safeFallHandoffCount,
            fallback == null ? "unavailable" : "mine_through",
            Math.max(0L, nowMs - run.startedAtMs),
            stallReason,
            rejectionReason
        );
        run.safeFallHandoffReason = null;
        run.safeFallRejectionReason = null;
        if (fallback != null) {
            return fallback;
        }
        return failDescent(
            effective,
            run,
            nowMs,
            stallReason + ":safe_fall_handoff_unavailable:" + rejectionReason
        );
    }

    private void finishActiveSafeFall(
        DescentRun run,
        boolean resetBreaker,
        boolean clearExpectedDamage
    ) {
        if (run == null) {
            return;
        }
        run.safeFallController.clear();
        run.safeFallPlan = null;
        run.safeFallEvaluation = null;
        run.safeFallClearanceStartedCell = null;
        run.safeFallClearanceBreakEngaged = false;
        run.safeFallClearanceBlockerId = "";
        run.safeFallLaunchLogged = false;
        run.safeFallDepartureLogged = false;
        run.safeFallAirborneLogged = false;
        run.safeFallSelectedAtMs = 0L;
        run.safeFallSelectedHealth = 0.0F;
        run.safeFallTargetY = null;
        run.safeFallPackageRejectionReason = "";
        run.arrivalValidator.reset();
        if (clearExpectedDamage) {
            run.safeFallExpectedDamage = 0.0F;
        }
        if (resetBreaker) {
            shell.blockBreakController().reset();
        }
        shell.clearNavigationState();
    }

    private void clearSafeFallState(DescentRun run, boolean resetBreaker) {
        if (run == null) {
            return;
        }
        finishActiveSafeFall(run, resetBreaker, true);
        run.safeFallCandidateEvaluated = false;
        run.safeFallAttempted = false;
        run.safeFallCandidateSignature = null;
        run.safeFallOriginalStallReason = null;
        run.safeFallHandoffPending = false;
        run.safeFallHandoffReason = null;
        run.safeFallRejectionReason = null;
        run.safeFallHandoffCount = 0;
    }

    private static BlockPos safeFallBlockPos(VoxelCell cell) {
        return new BlockPos(cell.x(), cell.y(), cell.z());
    }

    private static String safeFallPos(VoxelCell cell) {
        return cell == null ? "none" : safeFallBlockPos(cell).toShortString();
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
        // WATER-SEAL (the repeated-abort family): the offending
        // water cell is sealable by the SAME placement flow — water is replaceable, so a top-place
        // onto its (stable) floor fills the cell. Slice 1 is top-seal only; the shared bridge budget
        // bounds pool edges; lava near the seal cell disqualifies as usual.
        if (waterAdjacent) {
            BlockPos sealCell = descentStepWaterCell(client, step);
            if (placementOccupiesCanonicalTrail(
                sealCell,
                shell::isOnRecordedDescentTrail
            )) {
                logCanonicalOccupancyVeto(run, step, sealCell, "planning_water_seal", 0L);
                return false;
            }
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
        if (placementOccupiesCanonicalTrail(
            step.support(),
            shell::isOnRecordedDescentTrail
        )) {
            logCanonicalOccupancyVeto(run, step, step.support(), "planning_bridge", 0L);
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
        // Column repair (run-8 reject side_source_unstable:air): the bot stands on an overhang lip —
        // the side-source cell is itself air with solid one deeper. Eligible: top-place INTO the
        // side-source cell first; the side bridge then proceeds off the repaired block.
        BlockPos gateSideSource = descentSideBridgeSource(step, run.direction);
        if (client.world.getBlockState(gateSideSource).isAir()
            && shell.isStableDescentSupport(client, gateSideSource.down())) {
            if (placementOccupiesCanonicalTrail(
                gateSideSource,
                shell::isOnRecordedDescentTrail
            )) {
                logCanonicalOccupancyVeto(run, step, gateSideSource, "planning_column_repair", 0L);
                return false;
            }
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
        // (run-1 lesson: a point outside the face ends the ray in air).
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
        return placeDescentSupport(
            client,
            player,
            effective,
            run,
            step,
            nowMs,
            reason,
            null
        );
    }

    private ControlDecision placeDescentSupport(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs,
        String reason,
        BlockPos explicitWaterCell
    ) {
        if (step == null) {
            return failDescent(effective, run, nowMs, "descent_water_containment_missing_step");
        }
        BlockPos supportCell = step.support();
        BlockPos foundation = supportCell.down();
        String commandId = descentSupportCommandId(run, step, explicitWaterCell);
        boolean awaitingVerification = shell.blockPlaceController().isAwaitingVerification(commandId);
        boolean waterSeal = reason != null && reason.startsWith("descent_water_adjacent:");
        BlockPlaceController.PlaceSpec supportSpec = selectDescentSupportPlaceSpec(
            waterSeal,
            run.containmentSealPlaceSpec,
            descentSupportPlaceSpec(player)
        );
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
        if (waterSeal && run.containmentSealPlaceSpec == null) {
            run.containmentSealPlaceSpec = supportSpec;
        }
        // Hold sneak while at the gap edge so aiming/placing never walks the bot off into the gap.
        InputState sneakStop = new InputState(false, false, false, false, false, true, 0.0F, 0.0F);

        // WATER-SEAL: for descent_water_adjacent the placement target IS the water cell — placing
        // against any solid neighbor face that points into it replaces the water. v2 (an observed regression,
        // the first live seal: the bot's eye sits nearly LEVEL with the underwater floor's top
        // face, so the top-only ray grazed the lip and never connected): try the floor face first,
        // then the four horizontal neighbor faces — first face with a verified raycast hit wins,
        // the use_bed candidate lesson applied to placement.
        Vec3d sealAim = null;
        BlockPos waterSealCell = null;
        boolean waterSealUsesSideFace = false;
        if (waterSeal) {
            BlockPos sealCell = explicitWaterCell == null
                ? descentStepWaterCell(client, step)
                : explicitWaterCell;
            if (sealCell == null) {
                // Water gone (current shifted / already sealed): let the step re-evaluate.
                return new ControlDecision(shell.stopFrom(effective, "descent_water_seal_clear"), InputState.stop());
            }
            waterSealCell = sealCell;
            supportCell = sealCell;
            foundation = null;
            if (run.containmentSealFaceConstraint != null) {
                foundation =
                    run.containmentSealFaceConstraint.expectedHitBlock();
                sealAim = waterSealSideAim(foundation, sealCell);
            } else {
                BlockPos[] sealNeighbors = {
                    sealCell.down(), sealCell.north(), sealCell.south(), sealCell.east(), sealCell.west()
                };
                for (BlockPos neighbor : sealNeighbors) {
                    BlockState neighborState = client.world.getBlockState(neighbor);
                    if (neighborState.getCollisionShape(client.world, neighbor).isEmpty()
                        || shell.isHazardBlockState(neighborState)) {
                        continue;
                    }
                    Vec3d candidate = waterSealSideAim(neighbor, sealCell);
                    BlockHitResult sealHit = client.world.raycast(new RaycastContext(
                        player.getEyePos(), candidate,
                        RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
                    if (sealHit != null && sealHit.getType() == HitResult.Type.BLOCK
                        && neighbor.equals(sealHit.getBlockPos())) {
                        foundation = neighbor;
                        sealAim = candidate;
                        run.containmentSealFaceConstraint =
                            waterSealFaceConstraint(true, neighbor, sealCell);
                        break;
                    }
                }
            }
            if (foundation == null) {
                // No clickable face from this stance: keep the old floor-top behavior and let the
                // sneak-nudge hunt for it (the pre-v2 path).
                foundation = sealCell.down();
            }
            waterSealUsesSideFace =
                run.containmentSealFaceConstraint != null;
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

        BlockPos intendedPlacementCell = waterSeal
            ? waterSealCell
            : columnRepair ? sideSource : supportCell;
        if (placementOccupiesCanonicalTrail(
            intendedPlacementCell,
            shell::isOnRecordedDescentTrail
        )) {
            shell.blockPlaceController().reset();
            logCanonicalOccupancyVeto(
                run,
                step,
                intendedPlacementCell,
                "pre_placement",
                nowMs
            );
            return rerouteOrFailDescent(
                effective,
                client,
                player,
                run,
                step,
                nowMs,
                reason + ":descent_preserve_canonical_surface_trail_occupancy"
            );
        }

        BlockPlaceController.Result result = shell.blockPlaceController().tick(
            client, player, commandId, nowMs,
            columnRepair
                ? sideSource.down()
                : sideBridge || (waterSeal && waterSealUsesSideFace)
                    ? null
                    : foundation,
            supportSpec,
            waterSeal && waterSealUsesSideFace
                ? run.containmentSealFaceConstraint
                : null);
        String placementDemandViolation = placementDemandViolationReason(
            result.interactionDemand() != null,
            intendedPlacementCell,
            result.placedBlock(),
            shell::isOnRecordedDescentTrail
        );
        if (!placementDemandViolation.isBlank()) {
            // This is still a pending USE_BLOCK description. The central interaction authority
            // has not applied it, so dropping the demand prevents a drifted side-face ray from
            // physically filling the canonical return corridor.
            shell.blockPlaceController().reset();
            if ("canonical_trail_occupancy".equals(placementDemandViolation)) {
                logCanonicalOccupancyVeto(
                    run,
                    step,
                    result.placedBlock(),
                    "predicted_placement",
                    nowMs
                );
            } else {
                shell.logger().warn(
                    "descent.place_support_prediction_rejected instanceId={} commandId={} step={} intended={} predicted={} elapsedMs={} reason={}",
                    shell.instanceId(),
                    run.commandId,
                    step.index(),
                    intendedPlacementCell == null
                        ? "unknown"
                        : intendedPlacementCell.toShortString(),
                    McbotFabricClient.formatBlockPos(result.placedBlock()),
                    Math.max(0L, nowMs - run.startedAtMs),
                    placementDemandViolation
                );
            }
            return rerouteOrFailDescent(
                effective,
                client,
                player,
                run,
                step,
                nowMs,
                reason + ":placement_demand_" + placementDemandViolation
            );
        }
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
            if (waterSeal && !waterSealCell.equals(result.placedBlock())) {
                return withInteraction(
                    rerouteOrFailDescent(
                        effective,
                        client,
                        player,
                        run,
                        step,
                        nowMs,
                        reason + ":water_seal_misplaced"
                    ),
                    result
                );
            }
            if (columnRepair) {
                // The repair block must land in the side-source cell; the step support is STILL
                // missing afterwards — the planner re-enters next tick and the side bridge proceeds
                // off the repaired block.
                if (!sideSource.equals(result.placedBlock())) {
                    return withInteraction(
                        rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_repair_misplaced"),
                        result
                    );
                }
                run.supportBridges++;
                return withInteraction(
                    new ControlDecision(shell.stopFrom(effective, "descent_support_column_repaired:" + step.index()), sneakStop),
                    result
                );
            }
            // SIDE mode places via the generic raycast path, so verify the block actually landed in
            // the gap cell; a drifted aim placing elsewhere must not count as a bridge.
            if (sideBridge && !supportCell.equals(result.placedBlock())) {
                return withInteraction(
                    rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_side_misplaced"),
                    result
                );
            }
            if (waterSeal && explicitWaterCell != null) {
                run.containmentSealPlacementVerified = true;
            }
            run.supportBridges++;
            return withInteraction(
                new ControlDecision(shell.stopFrom(effective, "descent_support_placed:" + step.index()), sneakStop),
                result
            );
        }
        if (result.status() == BlockPlaceController.Status.FAILED) {
            return withInteraction(
                rerouteOrFailDescent(effective, client, player, run, step, nowMs, reason + ":bridge_failed:" + result.reason()),
                result
            );
        }
        return withInteraction(
            new ControlDecision(
                shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "descent_support_placing:" + result.reason()),
                sneakStop
            ),
            result
        );
    }

    static BlockPlaceController.PlaceSpec selectDescentSupportPlaceSpec(
        boolean waterSeal,
        BlockPlaceController.PlaceSpec latched,
        BlockPlaceController.PlaceSpec available
    ) {
        return waterSeal && latched != null ? latched : available;
    }

    static boolean placementOccupiesCanonicalTrail(
        BlockPos placementCell,
        Predicate<BlockPos> isRecordedTrailCell
    ) {
        return placementCell != null
            && isRecordedTrailCell != null
            && isRecordedTrailCell.test(placementCell);
    }

    static String placementDemandViolationReason(
        boolean interactionRequested,
        BlockPos intendedPlacementCell,
        BlockPos predictedPlacementCell,
        Predicate<BlockPos> isRecordedTrailCell
    ) {
        if (!interactionRequested) {
            return "";
        }
        if (placementOccupiesCanonicalTrail(
            predictedPlacementCell,
            isRecordedTrailCell
        )) {
            return "canonical_trail_occupancy";
        }
        if (intendedPlacementCell == null
            || predictedPlacementCell == null
            || !intendedPlacementCell.equals(predictedPlacementCell)) {
            return "predicted_cell_mismatch";
        }
        return "";
    }

    private void logCanonicalOccupancyVeto(
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        BlockPos placementCell,
        String phase,
        long nowMs
    ) {
        shell.logger().warn(
            "descent.canonical_occupancy_veto instanceId={} commandId={} objectiveReason={} step={} phase={} placementCell={} elapsedMs={} reason=cross_command_surface_trail_feet_or_head",
            shell.instanceId(),
            run == null ? "" : run.commandId,
            run == null ? "" : run.objectiveReason,
            step == null ? -1 : step.index(),
            phase,
            placementCell == null ? "unknown" : placementCell.toShortString(),
            run == null || nowMs <= 0L ? 0L : Math.max(0L, nowMs - run.startedAtMs)
        );
    }

    static BlockPlaceController.FaceConstraint waterSealFaceConstraint(
        boolean sideFace,
        BlockPos hitBlock,
        BlockPos waterCell
    ) {
        if (!sideFace || hitBlock == null || waterCell == null) {
            return null;
        }
        for (Direction direction : Direction.Type.HORIZONTAL) {
            if (hitBlock.offset(direction).equals(waterCell)) {
                return new BlockPlaceController.FaceConstraint(
                    hitBlock,
                    direction,
                    waterCell
                );
            }
        }
        return null;
    }

    private static Vec3d waterSealSideAim(
        BlockPos hitBlock,
        BlockPos waterCell
    ) {
        Vec3d towardWater = new Vec3d(
            waterCell.getX() - hitBlock.getX(),
            waterCell.getY() - hitBlock.getY(),
            waterCell.getZ() - hitBlock.getZ()
        );
        return new Vec3d(
            hitBlock.getX() + 0.5D + towardWater.x * 0.45D,
            hitBlock.getY() + 0.5D + towardWater.y * 0.45D,
            hitBlock.getZ() + 0.5D + towardWater.z * 0.45D
        );
    }

    private static String descentSupportCommandId(
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        BlockPos explicitWaterCell
    ) {
        if (run == null || step == null) {
            return "";
        }
        return run.commandId + ":support:" + step.index()
            + (explicitWaterCell == null ? "" : ":water:" + explicitWaterCell.asLong());
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
        clearPendingBreakConfirmation(run);
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
        if (!openAirGap || run.safeFallCandidateEvaluated || run.safeFallAttempted || rejectedStep == null) {
            return null;
        }
        String signature = run.currentFeet.toShortString() + "->" + rejectedStep.nextFeet().toShortString();
        if (signature.equals(run.safeFallCandidateSignature)) {
            return null;
        }
        SafeFallLaunchEvaluation evaluation = evaluateSafeFallLaunch(
            client,
            player,
            run,
            rejectedStep,
            effective.targetY()
        );
        run.safeFallCandidateEvaluated = true;
        run.safeFallCandidateSignature = evaluation.signature();
        run.safeFallOriginalStallReason = reason;
        if (evaluation.decision() == null || !evaluation.decision().accepted()) {
            run.safeFallPlan = null;
            run.safeFallEvaluation = evaluation.decision() == null
                ? null
                : evaluation.decision().evaluation();
            run.safeFallSelectedAtMs = nowMs;
            run.safeFallClearanceBlockerId = safeFallRejectedBlockerId(
                client,
                rejectedStep,
                evaluation.decision() == null ? "invalid_request" : evaluation.decision().reason()
            );
            return rejectSafeFallBeforeDeparture(
                effective,
                run,
                nowMs,
                evaluation.decision() == null ? "invalid_request" : evaluation.decision().reason()
            );
        }

        DescentSafeFallLaunchPlanner.Plan plan = evaluation.decision().plan();
        run.safeFallAttempted = true;
        run.safeFallPlan = plan;
        run.safeFallEvaluation = evaluation.decision().evaluation();
        run.safeFallSelectedAtMs = nowMs;
        run.safeFallSelectedHealth = player.getHealth();
        run.safeFallTargetY = effective.targetY();
        run.safeFallExpectedDamage = 0.0F;
        run.arrivalValidator.reset();
        DescentSafeFallController.Decision started = run.safeFallController.start(
            new DescentSafeFallController.StartRequest(
                run.commandId,
                client.world,
                plan,
                player.getX(),
                player.getZ(),
                Math.max(DescentSafeFallController.MIN_PLAYER_HALF_WIDTH, player.getWidth() / 2.0D),
                player.getHealth(),
                nowMs
            )
        );
        if (started.action() == DescentSafeFallController.Action.REJECTED) {
            return rejectSafeFallBeforeDeparture(effective, run, nowMs, started.reason());
        }
        shell.logger().warn(
            "descent.safe_fall instanceId={} commandId={} from={} to={} column={} fallBlocks={} depthReached={} step={} elapsedMs={} expectedDamage={} healthBefore={} health={}",
            shell.instanceId(),
            run.commandId,
            safeFallPos(plan.origin()),
            safeFallPos(plan.landing()),
            safeFallPos(plan.dropColumn()),
            plan.fallDepth(),
            run.depthReached,
            run.stepIndex,
            Math.max(0L, nowMs - run.startedAtMs),
            plan.expectedDamage(),
            run.healthBefore,
            player.getHealth()
        );
        shell.logger().info(
            "descent.safe_fall.launch_envelope_selected instanceId={} commandId={} objectiveReason={} phase={} origin={} launchFeet={} launchHead={} column={} landing={} fallDepth={} clearanceCount={} expectedDamage={} elapsedMs={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.objectiveReason,
            started.phase(),
            safeFallPos(plan.origin()),
            safeFallPos(plan.launchFeet()),
            safeFallPos(plan.launchHead()),
            safeFallPos(plan.dropColumn()),
            safeFallPos(plan.landing()),
            plan.fallDepth(),
            plan.clearanceCells().size(),
            plan.expectedDamage(),
            Math.max(0L, nowMs - run.startedAtMs),
            evaluation.decision().reason()
        );
        return new ControlDecision(
            shell.stopFrom(effective, "descent_safe_fall_selected"),
            InputState.stop()
        );
    }

    private String safeFallRejectedBlockerId(
        MinecraftClient client,
        StaircaseDescentPlanner.Step step,
        String reason
    ) {
        if (client == null || client.world == null || step == null || reason == null) {
            return "none";
        }
        if (reason.startsWith("launch_head_")) {
            return shell.blockId(client.world.getBlockState(step.sightClear()));
        }
        if (reason.startsWith("launch_feet_")) {
            return shell.blockId(client.world.getBlockState(step.upperClear()));
        }
        return "none";
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
                || firstCanonicalSupportConflict(levelCandidate) != null
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
            && !stepTargetsReachedStanceSupport(run.reachedFeet, candidate)
            && firstCanonicalSupportConflict(candidate) == null
            && descentStepUnsafeReason(client, candidate) == null
            && !DescentHazardMemory.candidateTooCloseToKnownHazard(candidate, run.rejectedHazards);
    }

    private BlockPos firstCanonicalSupportConflict(StaircaseDescentPlanner.Step step) {
        return firstCanonicalSupportConflict(step, shell::isCanonicalDescentTrailSupport);
    }

    static BlockPos firstCanonicalSupportConflict(
        StaircaseDescentPlanner.Step step,
        Predicate<BlockPos> isCanonicalSupport
    ) {
        if (step == null || isCanonicalSupport == null) {
            return null;
        }
        if (isCanonicalSupport.test(step.sightClear())) {
            return step.sightClear();
        }
        if (isCanonicalSupport.test(step.upperClear())) {
            return step.upperClear();
        }
        return isCanonicalSupport.test(step.lowerClear()) ? step.lowerClear() : null;
    }

    static BlockPos firstCanonicalBreakInteractionConflict(
        BlockPos hitBlock,
        BlockPos actedBlock,
        Predicate<BlockPos> isCanonicalSupport,
        Predicate<BlockPos> isCanonicalOccupancy
    ) {
        BlockPos[] candidates = {actedBlock, hitBlock};
        for (BlockPos candidate : candidates) {
            if (candidate == null) {
                continue;
            }
            if ((isCanonicalSupport != null && isCanonicalSupport.test(candidate))
                || (isCanonicalOccupancy != null && isCanonicalOccupancy.test(candidate))) {
                return candidate;
            }
        }
        return null;
    }

    private void logCanonicalSupportVeto(
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        BlockPos target,
        String phase,
        long nowMs
    ) {
        shell.logger().warn(
            "descent.canonical_support_veto instanceId={} commandId={} objectiveReason={} step={} phase={} currentFeet={} target={} leasedFeet={} elapsedMs={} reason=cross_command_surface_trail_support",
            shell.instanceId(),
            run == null ? "" : run.commandId,
            run == null ? "" : run.objectiveReason,
            step == null ? -1 : step.index(),
            phase,
            run == null || run.currentFeet == null ? "unknown" : run.currentFeet.toShortString(),
            target == null ? "unknown" : target.toShortString(),
            target == null ? "unknown" : target.up().toShortString(),
            run == null ? 0L : Math.max(0L, nowMs - run.startedAtMs)
        );
    }

    static boolean stepTargetsReachedStanceSupport(
        List<BlockPos> reachedFeet,
        StaircaseDescentPlanner.Step step
    ) {
        return step != null
            && (
                targetsReachedStanceSupport(reachedFeet, step.sightClear())
                    || targetsReachedStanceSupport(reachedFeet, step.upperClear())
                    || targetsReachedStanceSupport(reachedFeet, step.lowerClear())
            );
    }

    static boolean targetsReachedStanceSupport(List<BlockPos> reachedFeet, BlockPos target) {
        if (reachedFeet == null || reachedFeet.isEmpty() || target == null) {
            return false;
        }
        for (BlockPos reached : reachedFeet) {
            if (reached != null && target.equals(reached.down())) {
                return true;
            }
        }
        return false;
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

    private ControlDecision completeDescent(
        BrainLink.Intent effective,
        DescentRun run,
        ClientPlayerEntity player,
        long nowMs,
        String reason,
        boolean terminalLandingReached,
        boolean workspaceReadyAtTarget
    ) {
        ledger.markComplete(run.commandId, "descent_complete:" + reason);
        shell.logger().info(
            "descent.complete instanceId={} commandId={} reason={} objectiveReason={} start={} final={} depth={} depthReached={} reroutes={} openAirReroutes={} hazardReroutes={} healthBefore={} healthAfter={} elapsedMs={} targetY={} terminalLandingReached={} workspaceReadyAtTarget={}",
            shell.instanceId(),
            run.commandId,
            reason,
            effective.reason(),
            run.startFeet.toShortString(),
            player.getBlockPos().toShortString(),
            run.depth,
            run.depthReached,
            run.reroutes,
            run.openAirReroutes,
            run.hazardReroutes,
            run.healthBefore,
            player.getHealth(),
            Math.max(0L, nowMs - run.startedAtMs),
            effective.targetY(),
            terminalLandingReached,
            workspaceReadyAtTarget
        );
        clearPostBreakProbe(run);
        clearWaterContainmentState(run, true);
        clearSafeFallState(run, true);
        run.waterContainment.clear();
        shell.blockBreakController().reset();
        miningWorkspaceController.clear();
        activeRun = null;
        shell.recordCompletedDescentPath(
            run.commandId,
            run.reachedFeet,
            run.direction,
            run.objectiveReason
        );
        shell.completeCurrentCommand(run.commandId, "descent_complete:" + reason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, "descent_complete:" + reason), InputState.stop());
    }

    /**
     * Returns exact mission iron recovery to the planner without crediting a descent landing or
     * charging a terrain failure. The safe prefix remains available to the canonical surface trail,
     * but it is deliberately not installed as a completed descent route.
     */
    private ControlDecision completeMissionIronRecoveryReserveFeedback(
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs,
        String completionReason,
        String detail
    ) {
        ledger.markComplete(run.commandId, completionReason);
        shell.logger().info(
            "descent.tool_reserve_feedback instanceId={} commandId={} objectiveReason={} reason={} detail={} step={} depth={} depthReached={} elapsedMs={} neutral=true budgetReset=false floorViolation=false",
            shell.instanceId(),
            run.commandId,
            run.objectiveReason,
            completionReason,
            detail,
            run.stepIndex,
            run.depth,
            run.depthReached,
            Math.max(0L, nowMs - run.startedAtMs)
        );
        shell.recordPartialDescentPath(run.commandId, run.reachedFeet);
        clearPostBreakProbe(run);
        clearWaterContainmentState(run, true);
        clearSafeFallState(run, true);
        run.waterContainment.clear();
        shell.blockBreakController().reset();
        miningWorkspaceController.clear();
        activeRun = null;
        shell.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
    }

    static String missionIronRecoveryReserveCompletionReason(boolean unavailable) {
        return unavailable
            ? "descent_complete:tool_reserve_unavailable"
            : "descent_complete:tool_reserve_required";
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
        // The descent may have reached several fully validated stance cells before the terminal
        // failure. Preserve that safe prefix for the mission's canonical surface-return trail;
        // otherwise a retry begins beyond an artificial sampling gap and the later return cannot
        // prove endpoint continuity. The shell deliberately keeps this out of the legacy
        // last-completed-descent maps.
        shell.recordPartialDescentPath(run.commandId, run.reachedFeet);
        clearPostBreakProbe(run);
        clearWaterContainmentState(run, true);
        clearSafeFallState(run, true);
        run.waterContainment.clear();
        shell.blockBreakController().reset();
        miningWorkspaceController.clear();
        activeRun = null;
        shell.completeCurrentCommand(run.commandId, "descent_failed:" + reason, nowMs);
        return new ControlDecision(shell.stopFrom(effective, "descent_failed:" + reason), InputState.stop());
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    /** Fail a primary descent before a DescentRun is created (e.g. when its saved shaft
     * cannot be replayed safely). This preserves ordinary mission retry/recovery semantics without
     * allowing the executor to silently start a different shaft. */
    ControlDecision rejectBeforeAdmission(
        BrainLink.Intent effective,
        BlockPos feet,
        long nowMs,
        String reason
    ) {
        String commandId = effective == null || effective.commandId() == null
            ? ""
            : effective.commandId();
        String classified = reason == null || reason.isBlank()
            ? "shaft_resume_rejected"
            : reason;
        ledger.markComplete(commandId, "descent_failed:" + classified);
        lastDescentFailurePos = feet;
        lastDescentFailureAtMs = nowMs;
        shell.blockBreakController().reset();
        miningWorkspaceController.clear();
        shell.logger().warn(
            "descent.failed instanceId={} commandId={} reason={} start={} step=0 depth=0 depthReached=0 reroutes=0 openAirReroutes=0 hazardReroutes=0 stage=pre_admission elapsedMs=0",
            shell.instanceId(),
            commandId,
            classified,
            feet == null ? "unknown" : feet.toShortString()
        );
        shell.completeCurrentCommand(commandId, "descent_failed:" + classified, nowMs);
        return new ControlDecision(
            shell.stopFrom(effective, "descent_failed:" + classified),
            InputState.stop()
        );
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    private static ControlDecision withInteraction(
        ControlDecision decision,
        BlockBreakController.Result result
    ) {
        return result == null
            ? decision
            : withInteraction(decision, result.interactionDemand(), result.interactionPayload());
    }

    private static ControlDecision withInteraction(
        ControlDecision decision,
        BlockPlaceController.Result result
    ) {
        return result == null
            ? decision
            : withInteraction(decision, result.interactionDemand(), result.interactionPayload());
    }

    private static ControlDecision withInteraction(
        ControlDecision decision,
        InteractionDemand demand,
        FabricInteractionAuthority.Payload payload
    ) {
        if (decision == null) {
            return null;
        }
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
        boolean terminalLandingReached = false;
        boolean targetDepthAdmissionLogged = false;
        boolean targetDepthAdmissionActive = false;
        final DescentStepArrivalValidator arrivalValidator = new DescentStepArrivalValidator();
        final DescentStepLipController stepLipController = new DescentStepLipController();
        final DescentWaterContainmentController waterContainment =
            new DescentWaterContainmentController();
        BlockPos lastVerifiedDryFeet = null;
        StaircaseDescentPlanner.Step containmentStep = null;
        boolean containmentRetreatUsed = false;
        boolean containmentSealLogged = false;
        boolean containmentRetreatLogged = false;
        boolean containmentSealPlacementVerified = false;
        BlockPlaceController.PlaceSpec containmentSealPlaceSpec = null;
        BlockPlaceController.FaceConstraint containmentSealFaceConstraint = null;
        int containmentBridgesAtStart = 0;
        String containmentWaterKind = "";
        boolean postBreakProbePending = false;
        StaircaseDescentPlanner.Step postBreakStep = null;
        BlockPos postBreakOpenedCell = null;
        int postBreakDryPolls = 0;
        long postBreakProbeStartedAtMs = 0L;
        String postBreakPhase = "";
        boolean postBreakAdvanceStage = false;
        StaircaseDescentPlanner.Step pendingBreakStep = null;
        BlockPos pendingBreakOpenedCell = null;
        String pendingBreakPhase = "";
        boolean pendingBreakAdvanceStage = false;
        Object worldIdentity = null;
        String objectiveReason = "";
        Integer remainingMissionIronCount = null;
        Integer reservedIronPickaxeCount = null;
        Integer reservedIronPickaxeDurabilityFloor = null;
        String lastToolReserveAssessmentSignature = "";
        long bridgeNudgeStartedAtMs = 0L;
        DescentControlPlanner.Stage stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        BlockPos recoveryClearTarget = null;
        String recoveryClearPhase = "";
        // Controlled safe-fall latches: one evaluated transition and one physical attempt per run,
        // with one frozen launch package and one bounded pre-departure handoff to mine-through.
        boolean safeFallCandidateEvaluated = false;
        boolean safeFallAttempted = false;
        String safeFallCandidateSignature = null;
        final DescentSafeFallController safeFallController = new DescentSafeFallController();
        DescentSafeFallLaunchPlanner.Plan safeFallPlan = null;
        DescentSafeFallLaunchPlanner.Evaluation safeFallEvaluation = null;
        VoxelCell safeFallClearanceStartedCell = null;
        boolean safeFallClearanceBreakEngaged = false;
        String safeFallClearanceBlockerId = "";
        boolean safeFallLaunchLogged = false;
        boolean safeFallDepartureLogged = false;
        boolean safeFallAirborneLogged = false;
        long safeFallSelectedAtMs = 0L;
        float safeFallSelectedHealth = 0.0F;
        Double safeFallTargetY = null;
        String safeFallPackageRejectionReason = "";
        String safeFallOriginalStallReason = null;
        boolean safeFallHandoffPending = false;
        String safeFallHandoffReason = null;
        String safeFallRejectionReason = null;
        int safeFallHandoffCount = 0;
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
        final FieldKitTableCraftLatch descentTableCraftLatch = new FieldKitTableCraftLatch();
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
