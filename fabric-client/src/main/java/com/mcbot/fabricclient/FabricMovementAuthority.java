package com.mcbot.fabricclient;

import java.util.Arrays;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.input.Input;
import net.minecraft.client.network.ClientPlayerEntity;
import org.slf4j.Logger;

final class FabricMovementAuthority {
    private static final long SUMMARY_INTERVAL_MS = 5_000L;
    private static final long SHORT_HOLD_MS = 150L;
    private static final int COMPUTATION_SAMPLE_CAP = 256;
    private static final float AXIS_EPSILON = 0.000_001F;

    enum GuardOverride {
        NONE,
        EDGE_GUARD,
        SCREEN_GUARD,
        PREEMPTION,
        LIFECYCLE,
        INPUT_OVERRIDE
    }

    record Selected(
        InputState input,
        boolean sprintRequested,
        FabricLocomotionController.Output smooth
    ) {
    }

    record Applied(
        InputState input,
        boolean sprintRequested,
        boolean actualSprinting,
        InputState legacyInput,
        boolean legacySprintRequested,
        FabricLocomotionController.Output smooth,
        GuardOverride guardOverride,
        boolean physicalShadowMismatch
    ) {
    }

    private final String instanceId;
    private final Logger logger;
    private final FabricMotionMode mode;
    private final long[] computationNanos = new long[COMPUTATION_SAMPLE_CAP];

    private FabricLocomotionController.State shadowState =
        FabricLocomotionController.initialState();
    private FabricLocomotionController.State smoothState =
        FabricLocomotionController.initialState();
    private LocomotionDemand lastDemand;
    private Object lastWorld;
    private String lastDimension = "";
    private InputState lastAppliedInput = InputState.stop();
    private boolean lastAppliedSprint;
    private boolean appliedInitialized;
    private boolean lastShadowForward;
    private boolean lastShadowSprint;
    private boolean shadowInitialized;
    private long activeStartedAtMs;
    private long lastSummaryAtMs;
    private long lastCommitAtMs;
    private long appliedForwardPhaseAtMs;
    private long appliedSprintPhaseAtMs;
    private long appliedJumpStartedAtMs;
    private long appliedForwardActiveMs;
    private long appliedSprintActiveMs;
    private long longestJumpMs;
    private int computationIndex;
    private int computationCount;
    private int appliedForwardTransitions;
    private int shadowForwardTransitions;
    private int appliedSprintTransitions;
    private int shadowSprintTransitions;
    private int shortForwardHolds;
    private int shortForwardGaps;
    private int shortSprintHolds;
    private int shortSprintGaps;
    private int fractionalAxisCount;
    private int opposingAxisConflictCount;
    private int jumpDemandCount;
    private int jumpRisingEdgeCount;
    private int jumpCompletionCount;
    private int jumpRejectionCount;
    private int duplicateJumpSuppressionCount;
    private int routeRegressionCount;
    private int guardOverrideCount;
    private int lifecycleKeyLeakCount;
    private int physicalShadowMismatchCount;
    private int lookaheadSelectionCount;
    private int lookaheadSuppressionCount;
    private int unsafeLookaheadCount;
    private int stagedTurnStopResumePairs;
    private double maximumCrossTrack;
    private String lastLookaheadSignature = "";
    private String stagedTurnSignature = "";
    private boolean stagedTurnStopped;
    private String activeAnomalySignature = "";

    FabricMovementAuthority(String instanceId, Logger logger, FabricMotionMode mode) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.logger = logger;
        this.mode = mode == null ? FabricMotionMode.LEGACY : mode;
    }

    FabricMotionMode mode() {
        return mode;
    }

    InputState previewInput(
        MinecraftClient client,
        ClientPlayerEntity player,
        InputState legacyInput,
        LocomotionDemand demand,
        double observationYaw,
        long nowMs
    ) {
        InputState stableLegacy = legacyInput == null ? InputState.stop() : legacyInput;
        LocomotionDemand stableDemand = demand == null
            ? LocomotionDemand.passthrough(
                LookDemand.Owner.NORMAL,
                stableLegacy,
                false,
                "uncommanded",
                "missing_locomotion_demand"
            )
            : demand;
        boolean scopeChanged = lastDemand != null
            && (lastDemand.owner() != stableDemand.owner()
                || !lastDemand.commandId().equals(stableDemand.commandId()));
        FabricLocomotionController.State previewState =
            lifecycleChanged(client) || scopeChanged
                ? FabricLocomotionController.initialState()
                : smoothState;
        return previewAppliedInput(
            mode,
            previewState,
            stableLegacy,
            stableDemand,
            observation(player, observationYaw, nowMs)
        );
    }

    Applied commit(
        MinecraftClient client,
        ClientPlayerEntity player,
        InputState guardedInput,
        LocomotionDemand demand,
        GuardOverride guardOverride,
        long nowMs
    ) {
        return commit(
            client,
            player,
            guardedInput,
            demand,
            guardOverride,
            player == null ? 0.0D : player.getYaw(),
            nowMs
        );
    }

    Applied commit(
        MinecraftClient client,
        ClientPlayerEntity player,
        InputState guardedInput,
        LocomotionDemand demand,
        GuardOverride guardOverride,
        double observationYaw,
        long nowMs
    ) {
        InputState legacyInput = guardedInput == null ? InputState.stop() : guardedInput;
        LocomotionDemand stableDemand = demand == null
            ? LocomotionDemand.passthrough(
                LookDemand.Owner.NORMAL,
                legacyInput,
                false,
                "uncommanded",
                "missing_locomotion_demand"
            )
            : demand;
        GuardOverride effectiveGuard = guardOverride == null
            ? GuardOverride.NONE
            : guardOverride;

        LocomotionDemand previousDemand = lastDemand;
        boolean lifecycleChanged = lifecycleChanged(client);
        boolean scopeChanged = previousDemand != null
            && (previousDemand.owner() != stableDemand.owner()
                || !previousDemand.commandId().equals(stableDemand.commandId()));
        if (lifecycleChanged || scopeChanged) {
            finishActive(nowMs, true);
            resetControllerStates();
            appliedInitialized = false;
        }
        observeLifecycle(client);

        boolean legacySprint = legacySprintRequested(
            legacyInput,
            stableDemand.legacySprintRequested()
        );
        LocomotionDemand evaluatedDemand = effectiveGuard == GuardOverride.NONE
            ? stableDemand
            : LocomotionDemand.passthrough(
                stableDemand.owner(),
                legacyInput,
                false,
                stableDemand.commandId(),
                stableDemand.reason() + ":guarded"
            );
        FabricLocomotionController.Observation observation =
            observation(player, observationYaw, nowMs);

        long startedNs = System.nanoTime();
        FabricLocomotionController.Output smooth = null;
        if (mode == FabricMotionMode.SHADOW) {
            FabricLocomotionController.Transition transition =
                FabricLocomotionController.step(shadowState, evaluatedDemand, observation);
            shadowState = transition.state();
            smooth = transition.output();
        } else if (mode == FabricMotionMode.SMOOTH) {
            FabricLocomotionController.Transition transition =
                FabricLocomotionController.step(smoothState, evaluatedDemand, observation);
            smoothState = transition.state();
            smooth = transition.output();
        }
        Selected selected = selectApplied(mode, legacyInput, legacySprint, smooth);
        boolean selectedSprint = legacySprintRequested(
            selected.input(),
            selected.sprintRequested()
        );
        if (stableDemand.policy() == LocomotionDemand.Policy.ROUTE_TRAVEL) {
            recordComputation(System.nanoTime() - startedNs);
        }

        if (player != null && player.input != null) {
            writeInput(player.input, selected.input());
        }
        writeSprint(client, selectedSprint);
        boolean actualSprinting = player != null && player.isSprinting();
        boolean physicalShadowMismatch = mode == FabricMotionMode.SHADOW
            && (!inputMatches(player == null ? null : player.input, legacyInput)
                || sprintPressed(client) != legacySprint);

        Applied applied = new Applied(
            selected.input(),
            selectedSprint,
            actualSprinting,
            legacyInput,
            legacySprint,
            smooth,
            effectiveGuard,
            physicalShadowMismatch
        );
        observe(
            previousDemand,
            stableDemand,
            applied,
            nowMs
        );
        lastDemand = stableDemand;
        lastAppliedInput = applied.input();
        lastAppliedSprint = applied.sprintRequested();
        appliedInitialized = true;
        emitSummaryIfDue(stableDemand, applied, nowMs, false);
        return applied;
    }

    void reapply(Input input, InputState state) {
        if (input != null) {
            writeInput(input, state == null ? InputState.stop() : state);
        }
    }

    void observeRouteHeading(
        String commandId,
        long routeGeneration,
        int waypointIndex,
        RouteHeadingPlanner.Plan plan,
        double crossTrack,
        long nowMs
    ) {
        if (plan == null) {
            return;
        }
        maximumCrossTrack = Math.max(
            maximumCrossTrack,
            Double.isFinite(crossTrack) ? Math.max(0.0D, crossTrack) : 0.0D
        );
        String command = textOr(commandId, "uncommanded");
        String reason = textOr(plan.suppressionReason(), "selected");
        String signature = command
            + ":"
            + routeGeneration
            + ":"
            + waypointIndex
            + ":"
            + plan.kind()
            + ":"
            + plan.aimIndex()
            + ":"
            + reason;
        boolean selected = plan.kind() != RouteHeadingPlanner.Kind.ACTIVE;
        if (selected && (!plan.suppressionReason().isBlank() || plan.aimCell() == null)) {
            unsafeLookaheadCount++;
            emitAnomaly(
                "unsafe_lookahead:" + signature,
                lastDemand,
                "unsafe_lookahead",
                nowMs
            );
        }
        if (signature.equals(lastLookaheadSignature)) {
            return;
        }
        lastLookaheadSignature = signature;
        if (selected) {
            lookaheadSelectionCount++;
            stagedTurnSignature = "";
            stagedTurnStopped = false;
            if (logger != null) {
                logger.info(
                    "motion.locomotion.lookahead_selected instanceId={} mode={} command={} routeGeneration={} waypointIndex={} kind={} aimIndex={} aimCell={} desiredYaw={} preserveForward={} sprintEligible={} maximumCrossTrack={} elapsedMs={}",
                    instanceId,
                    mode.wireName(),
                    command,
                    routeGeneration,
                    waypointIndex,
                    plan.kind(),
                    plan.aimIndex(),
                    plan.aimCell(),
                    rounded(plan.desiredYaw()),
                    plan.preserveForward(),
                    plan.sprintEligible(),
                    rounded(maximumCrossTrack),
                    activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs)
                );
            }
            return;
        }
        lookaheadSuppressionCount++;
        if ("corner_envelope_unsafe".equals(plan.suppressionReason())) {
            stagedTurnSignature = signature;
            stagedTurnStopped = false;
        } else {
            stagedTurnSignature = "";
            stagedTurnStopped = false;
        }
        if (logger != null) {
            logger.info(
                "motion.locomotion.lookahead_suppressed instanceId={} mode={} command={} routeGeneration={} waypointIndex={} aimIndex={} aimCell={} desiredYaw={} reason={} maximumCrossTrack={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                command,
                routeGeneration,
                waypointIndex,
                plan.aimIndex(),
                plan.aimCell(),
                rounded(plan.desiredYaw()),
                reason,
                rounded(maximumCrossTrack),
                activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs)
            );
        }
    }

    InputState release(
        MinecraftClient client,
        ClientPlayerEntity player,
        String reason,
        long nowMs
    ) {
        finishActive(nowMs, true);
        InputState stopped = InputState.stop();
        if (player != null && player.input != null) {
            writeInput(player.input, stopped);
            forceUnsneak(player);
        }
        writeSprint(client, false);
        if (physicalInputActive(player)
            || sprintPressed(client)) {
            lifecycleKeyLeakCount++;
            emitAnomaly(
                "lifecycle_key_leak:" + textOr(reason, "release"),
                null,
                "lifecycle_key_leak",
                nowMs
            );
        }
        resetControllerStates();
        resetMetrics();
        lastDemand = null;
        lastAppliedInput = stopped;
        lastAppliedSprint = false;
        appliedInitialized = true;
        lastWorld = null;
        lastDimension = "";
        return stopped;
    }

    void reset() {
        resetControllerStates();
        resetMetrics();
        lastDemand = null;
        lastWorld = null;
        lastDimension = "";
        lastAppliedInput = InputState.stop();
        lastAppliedSprint = false;
        appliedInitialized = false;
    }

    static boolean legacySprintRequested(InputState input, boolean reasonEligible) {
        return reasonEligible
            && input != null
            && input.pressingForward()
            && !input.pressingBack()
            && !input.sneaking()
            && input.movementForward() >= 0.99F;
    }

    static InputState previewAppliedInput(
        FabricMotionMode mode,
        FabricLocomotionController.State state,
        InputState legacyInput,
        LocomotionDemand demand,
        FabricLocomotionController.Observation observation
    ) {
        InputState stableLegacy = legacyInput == null ? InputState.stop() : legacyInput;
        if (mode != FabricMotionMode.SMOOTH || demand == null || observation == null) {
            return stableLegacy;
        }
        return FabricLocomotionController.step(state, demand, observation).output().input();
    }

    static Selected selectApplied(
        FabricMotionMode mode,
        InputState legacyInput,
        boolean legacySprintRequested,
        FabricLocomotionController.Output smooth
    ) {
        InputState stableLegacy = legacyInput == null ? InputState.stop() : legacyInput;
        if (mode == FabricMotionMode.SMOOTH && smooth != null) {
            return new Selected(smooth.input(), smooth.sprintRequested(), smooth);
        }
        return new Selected(stableLegacy, legacySprintRequested, smooth);
    }

    private FabricLocomotionController.Observation observation(
        ClientPlayerEntity player,
        double observationYaw,
        long nowMs
    ) {
        if (player == null) {
            return new FabricLocomotionController.Observation(
                nowMs,
                Double.isFinite(observationYaw) ? observationYaw : 0.0D,
                false,
                false,
                null,
                false
            );
        }
        boolean onGround = player.isOnGround();
        VoxelCell feet = onGround
            ? new VoxelCell(
                (int) Math.floor(player.getX()),
                (int) Math.floor(player.getY()),
                (int) Math.floor(player.getZ())
            )
            : null;
        return new FabricLocomotionController.Observation(
            nowMs,
            Double.isFinite(observationYaw) ? observationYaw : player.getYaw(),
            onGround,
            player.isTouchingWater(),
            feet,
            player.isSprinting()
        );
    }

    private void observe(
        LocomotionDemand previousDemand,
        LocomotionDemand demand,
        Applied applied,
        long nowMs
    ) {
        if (activeStartedAtMs == 0L) {
            activeStartedAtMs = nowMs;
            lastSummaryAtMs = nowMs;
            appliedForwardPhaseAtMs = nowMs;
            appliedSprintPhaseAtMs = nowMs;
        }
        accountActiveTime(nowMs);
        if (previousDemand == null || previousDemand.owner() != demand.owner()) {
            emitOwnerChanged(demand, previousDemand, nowMs);
        }
        if (previousDemand == null
            || !previousDemand.segmentIdentity().equals(demand.segmentIdentity())) {
            emitSegmentChanged(demand, previousDemand, nowMs);
        }
        if (previousDemand != null
            && previousDemand.commandId().equals(demand.commandId())
            && previousDemand.routeGeneration() == demand.routeGeneration()
            && demand.waypointIndex() < previousDemand.waypointIndex()) {
            routeRegressionCount++;
            emitAnomaly(
                "route_regression:"
                    + demand.commandId()
                    + ":"
                    + demand.routeGeneration(),
                demand,
                "route_regression",
                nowMs
            );
        }
        if (applied.guardOverride() != GuardOverride.NONE) {
            guardOverrideCount++;
        }
        if (fractionalAxes(applied.input())) {
            fractionalAxisCount++;
        }
        if (opposingAxes(applied.input())) {
            opposingAxisConflictCount++;
            emitAnomaly(
                "opposing_axes:" + demand.commandId(),
                demand,
                "opposing_axis_conflict",
                nowMs
            );
        }
        if (demand.rawInput().jumping()) {
            jumpDemandCount++;
        }
        if (applied.physicalShadowMismatch()) {
            physicalShadowMismatchCount++;
            emitAnomaly(
                "shadow_mismatch:" + demand.commandId(),
                demand,
                "physical_shadow_mismatch",
                nowMs
            );
        } else if (activeAnomalySignature.startsWith("shadow_mismatch:")) {
            activeAnomalySignature = "";
        }

        boolean appliedForward = applied.input().pressingForward();
        if (appliedInitialized && appliedForward != lastAppliedInput.pressingForward()) {
            appliedForwardTransitions++;
            long phaseMs = elapsed(nowMs, appliedForwardPhaseAtMs);
            if (lastAppliedInput.pressingForward() && phaseMs < SHORT_HOLD_MS) {
                shortForwardHolds++;
            } else if (!lastAppliedInput.pressingForward() && phaseMs < SHORT_HOLD_MS) {
                shortForwardGaps++;
            }
            appliedForwardPhaseAtMs = nowMs;
            emitForwardChanged(demand, applied, nowMs);
            if (!stagedTurnSignature.isBlank()) {
                if (lastAppliedInput.pressingForward() && !appliedForward) {
                    stagedTurnStopped = true;
                } else if (!lastAppliedInput.pressingForward()
                    && appliedForward
                    && stagedTurnStopped) {
                    stagedTurnStopResumePairs++;
                    stagedTurnSignature = "";
                    stagedTurnStopped = false;
                }
            }
        }
        if (appliedInitialized && applied.sprintRequested() != lastAppliedSprint) {
            appliedSprintTransitions++;
            long phaseMs = elapsed(nowMs, appliedSprintPhaseAtMs);
            if (lastAppliedSprint && phaseMs < SHORT_HOLD_MS) {
                shortSprintHolds++;
            } else if (!lastAppliedSprint && phaseMs < SHORT_HOLD_MS) {
                shortSprintGaps++;
            }
            appliedSprintPhaseAtMs = nowMs;
            emitSprintChanged(demand, applied, nowMs);
        }

        FabricLocomotionController.Output smooth = applied.smooth();
        if (smooth != null) {
            if (shadowInitialized && smooth.input().pressingForward() != lastShadowForward) {
                shadowForwardTransitions++;
            }
            if (shadowInitialized && smooth.sprintRequested() != lastShadowSprint) {
                shadowSprintTransitions++;
            }
            lastShadowForward = smooth.input().pressingForward();
            lastShadowSprint = smooth.sprintRequested();
            shadowInitialized = true;
            if (smooth.jumpCompleted()) {
                jumpCompletionCount++;
                emitJump(demand, "motion.locomotion.jump_completed", "takeoff", nowMs);
            }
            if (smooth.jumpRejected()) {
                jumpRejectionCount++;
                emitJump(demand, "motion.locomotion.jump_rejected", "pulse_timeout", nowMs);
            }
            if (smooth.duplicateJumpSuppressed()) {
                duplicateJumpSuppressionCount++;
            }
        }

        boolean appliedJump = applied.input().jumping();
        if (appliedJump && (!appliedInitialized || !lastAppliedInput.jumping())) {
            jumpRisingEdgeCount++;
            appliedJumpStartedAtMs = nowMs;
            emitJump(demand, "motion.locomotion.jump_started", "rising_edge", nowMs);
        } else if (!appliedJump
            && appliedInitialized
            && lastAppliedInput.jumping()
            && appliedJumpStartedAtMs > 0L) {
            longestJumpMs = Math.max(longestJumpMs, elapsed(nowMs, appliedJumpStartedAtMs));
            appliedJumpStartedAtMs = 0L;
        }
    }

    private void accountActiveTime(long nowMs) {
        if (lastCommitAtMs > 0L) {
            long delta = elapsed(nowMs, lastCommitAtMs);
            if (lastAppliedInput.pressingForward()) {
                appliedForwardActiveMs += delta;
            }
            if (lastAppliedSprint) {
                appliedSprintActiveMs += delta;
            }
        }
        lastCommitAtMs = nowMs;
    }

    private void emitOwnerChanged(
        LocomotionDemand demand,
        LocomotionDemand previous,
        long nowMs
    ) {
        if (logger == null) {
            return;
        }
        logger.info(
            "motion.locomotion.owner_changed instanceId={} mode={} owner={} previousOwner={} policy={} command={} reason={} targetYaw={} elapsedMs={}",
            instanceId,
            mode.wireName(),
            demand.owner(),
            previous == null ? "NONE" : previous.owner(),
            demand.policy(),
            demand.commandId(),
            demand.reason(),
            rounded(demand.desiredYaw()),
            activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs)
        );
    }

    private void emitSegmentChanged(
        LocomotionDemand demand,
        LocomotionDemand previous,
        long nowMs
    ) {
        if (logger == null) {
            return;
        }
        logger.info(
            "motion.locomotion.segment_changed instanceId={} mode={} owner={} policy={} command={} reason={} segmentIdentity={} previousSegment={} routeGeneration={} waypointIndex={} preserveFromPrevious={} routeEnd={} elapsedMs={}",
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.policy(),
            demand.commandId(),
            demand.reason(),
            demand.segmentIdentity(),
            previous == null ? "none" : previous.segmentIdentity(),
            demand.routeGeneration(),
            demand.waypointIndex(),
            demand.preserveFromPrevious(),
            demand.routeEnd(),
            activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs)
        );
    }

    private void emitForwardChanged(
        LocomotionDemand demand,
        Applied applied,
        long nowMs
    ) {
        if (logger == null) {
            return;
        }
        logger.info(
            "motion.locomotion.forward_changed instanceId={} mode={} owner={} policy={} command={} reason={} segmentIdentity={} appliedForward={} shadowForward={} yawError={} guardOverride={} elapsedMs={}",
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.policy(),
            demand.commandId(),
            demand.reason(),
            demand.segmentIdentity(),
            applied.input().pressingForward(),
            applied.smooth() == null ? "none" : applied.smooth().input().pressingForward(),
            applied.smooth() == null ? 0.0D : rounded(applied.smooth().yawError()),
            applied.guardOverride(),
            elapsed(nowMs, activeStartedAtMs)
        );
    }

    private void emitSprintChanged(
        LocomotionDemand demand,
        Applied applied,
        long nowMs
    ) {
        if (logger == null) {
            return;
        }
        logger.info(
            "motion.locomotion.sprint_changed instanceId={} mode={} owner={} policy={} command={} reason={} segmentIdentity={} requestedSprint={} actualSprinting={} shadowSprint={} guardOverride={} elapsedMs={}",
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.policy(),
            demand.commandId(),
            demand.reason(),
            demand.segmentIdentity(),
            applied.sprintRequested(),
            applied.actualSprinting(),
            applied.smooth() == null ? "none" : applied.smooth().sprintRequested(),
            applied.guardOverride(),
            elapsed(nowMs, activeStartedAtMs)
        );
    }

    private void emitJump(
        LocomotionDemand demand,
        String event,
        String reason,
        long nowMs
    ) {
        if (logger == null) {
            return;
        }
        logger.info(
            "{} instanceId={} mode={} owner={} policy={} command={} routeGeneration={} waypointIndex={} segmentIdentity={} jumpPolicy={} stepIdentity={} elapsedMs={} reason={}",
            event,
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.policy(),
            demand.commandId(),
            demand.routeGeneration(),
            demand.waypointIndex(),
            demand.segmentIdentity(),
            demand.jumpPolicy(),
            demand.stepIdentity(),
            elapsed(nowMs, activeStartedAtMs),
            reason
        );
    }

    private void emitAnomaly(
        String signature,
        LocomotionDemand demand,
        String anomaly,
        long nowMs
    ) {
        if (signature.equals(activeAnomalySignature)) {
            return;
        }
        activeAnomalySignature = signature;
        if (logger == null) {
            return;
        }
        logger.warn(
            "motion.locomotion.anomaly instanceId={} mode={} owner={} policy={} command={} reason={} segmentIdentity={} anomaly={} elapsedMs={}",
            instanceId,
            mode.wireName(),
            demand == null ? "NONE" : demand.owner(),
            demand == null ? "NONE" : demand.policy(),
            demand == null ? "none" : demand.commandId(),
            demand == null ? "none" : demand.reason(),
            demand == null ? "none" : demand.segmentIdentity(),
            anomaly,
            activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs)
        );
    }

    private void emitSummaryIfDue(
        LocomotionDemand demand,
        Applied applied,
        long nowMs,
        boolean terminal
    ) {
        if (!terminal && elapsed(nowMs, lastSummaryAtMs) < SUMMARY_INTERVAL_MS) {
            return;
        }
        if (logger == null || demand == null) {
            lastSummaryAtMs = nowMs;
            return;
        }
        long elapsedMs = activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs);
        long forwardActive = appliedForwardActiveMs;
        long sprintActive = appliedSprintActiveMs;
        if (lastCommitAtMs > 0L) {
            long pending = elapsed(nowMs, lastCommitAtMs);
            if (lastAppliedInput.pressingForward()) {
                forwardActive += pending;
            }
            if (lastAppliedSprint) {
                sprintActive += pending;
            }
        }
        logger.info(
            "motion.locomotion.summary instanceId={} mode={} owner={} policy={} command={} reason={} segmentIdentity={} routeGeneration={} waypointIndex={} desiredYaw={} rawForward={} appliedForward={} appliedSprint={} actualSprinting={} appliedForwardTransitions={} shadowForwardTransitions={} appliedSprintTransitions={} shadowSprintTransitions={} shortForwardHolds={} shortForwardGaps={} shortSprintHolds={} shortSprintGaps={} stableForwardRatio={} stableSprintRatio={} fractionalAxes={} opposingAxisConflicts={} lookaheadSelections={} lookaheadSuppressions={} unsafeLookahead={} maximumCrossTrack={} stagedTurnStopResumePairs={} jumpDemands={} jumpRisingEdges={} maximumJumpDurationMs={} jumpCompletions={} jumpRejections={} duplicateJumpSuppressions={} cursorRegressions={} guardOverrides={} lifecycleKeyLeaks={} shadowMismatches={} computationP95Ms={} directWriterViolations=0 elapsedMs={} terminal={}",
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.policy(),
            demand.commandId(),
            demand.reason(),
            demand.segmentIdentity(),
            demand.routeGeneration(),
            demand.waypointIndex(),
            rounded(demand.desiredYaw()),
            demand.rawInput().pressingForward(),
            applied == null ? lastAppliedInput.pressingForward() : applied.input().pressingForward(),
            applied == null ? lastAppliedSprint : applied.sprintRequested(),
            applied != null && applied.actualSprinting(),
            appliedForwardTransitions,
            shadowForwardTransitions,
            appliedSprintTransitions,
            shadowSprintTransitions,
            shortForwardHolds,
            shortForwardGaps,
            shortSprintHolds,
            shortSprintGaps,
            ratio(forwardActive, elapsedMs),
            ratio(sprintActive, elapsedMs),
            fractionalAxisCount,
            opposingAxisConflictCount,
            lookaheadSelectionCount,
            lookaheadSuppressionCount,
            unsafeLookaheadCount,
            rounded(maximumCrossTrack),
            stagedTurnStopResumePairs,
            jumpDemandCount,
            jumpRisingEdgeCount,
            longestJumpMs,
            jumpCompletionCount,
            jumpRejectionCount,
            duplicateJumpSuppressionCount,
            routeRegressionCount,
            guardOverrideCount,
            lifecycleKeyLeakCount,
            physicalShadowMismatchCount,
            rounded(computationP95Ms()),
            elapsedMs,
            terminal
        );
        lastSummaryAtMs = nowMs;
    }

    private void finishActive(long nowMs, boolean terminal) {
        if (lastDemand == null) {
            return;
        }
        accountActiveTime(nowMs);
        if (lastAppliedInput.jumping() && appliedJumpStartedAtMs > 0L) {
            longestJumpMs = Math.max(longestJumpMs, elapsed(nowMs, appliedJumpStartedAtMs));
        }
        emitSummaryIfDue(lastDemand, null, nowMs, terminal);
        lastDemand = null;
        resetMetrics();
    }

    private boolean lifecycleChanged(MinecraftClient client) {
        if (client == null || client.world == null) {
            return lastWorld != null;
        }
        String dimension = client.world.getRegistryKey().getValue().toString();
        return lastWorld != null
            && (lastWorld != client.world || !lastDimension.equals(dimension));
    }

    private void observeLifecycle(MinecraftClient client) {
        if (client == null || client.world == null) {
            lastWorld = null;
            lastDimension = "";
            return;
        }
        lastWorld = client.world;
        lastDimension = client.world.getRegistryKey().getValue().toString();
    }

    private void resetControllerStates() {
        shadowState = FabricLocomotionController.initialState();
        smoothState = FabricLocomotionController.initialState();
        lastShadowForward = false;
        lastShadowSprint = false;
        shadowInitialized = false;
    }

    private void resetMetrics() {
        activeStartedAtMs = 0L;
        lastSummaryAtMs = 0L;
        lastCommitAtMs = 0L;
        appliedForwardPhaseAtMs = 0L;
        appliedSprintPhaseAtMs = 0L;
        appliedJumpStartedAtMs = 0L;
        appliedForwardActiveMs = 0L;
        appliedSprintActiveMs = 0L;
        longestJumpMs = 0L;
        computationIndex = 0;
        computationCount = 0;
        appliedForwardTransitions = 0;
        shadowForwardTransitions = 0;
        appliedSprintTransitions = 0;
        shadowSprintTransitions = 0;
        shortForwardHolds = 0;
        shortForwardGaps = 0;
        shortSprintHolds = 0;
        shortSprintGaps = 0;
        fractionalAxisCount = 0;
        opposingAxisConflictCount = 0;
        jumpDemandCount = 0;
        jumpRisingEdgeCount = 0;
        jumpCompletionCount = 0;
        jumpRejectionCount = 0;
        duplicateJumpSuppressionCount = 0;
        routeRegressionCount = 0;
        guardOverrideCount = 0;
        lifecycleKeyLeakCount = 0;
        physicalShadowMismatchCount = 0;
        lookaheadSelectionCount = 0;
        lookaheadSuppressionCount = 0;
        unsafeLookaheadCount = 0;
        stagedTurnStopResumePairs = 0;
        maximumCrossTrack = 0.0D;
        lastLookaheadSignature = "";
        stagedTurnSignature = "";
        stagedTurnStopped = false;
        activeAnomalySignature = "";
    }

    private void recordComputation(long nanos) {
        computationNanos[computationIndex] = Math.max(0L, nanos);
        computationIndex = (computationIndex + 1) % computationNanos.length;
        computationCount = Math.min(COMPUTATION_SAMPLE_CAP, computationCount + 1);
    }

    private double computationP95Ms() {
        if (computationCount == 0) {
            return 0.0D;
        }
        long[] ordered = Arrays.copyOf(computationNanos, computationCount);
        Arrays.sort(ordered);
        int index = Math.min(
            ordered.length - 1,
            Math.max(0, (int) Math.ceil(ordered.length * 0.95D) - 1)
        );
        return ordered[index] / 1_000_000.0D;
    }

    private static boolean fractionalAxes(InputState input) {
        if (input == null) {
            return false;
        }
        return fractional(input.movementForward()) || fractional(input.movementSideways());
    }

    private static boolean fractional(float value) {
        float magnitude = Math.abs(value);
        return magnitude > AXIS_EPSILON && Math.abs(magnitude - 1.0F) > AXIS_EPSILON;
    }

    private static boolean opposingAxes(InputState input) {
        return input != null
            && ((input.pressingForward() && input.pressingBack())
                || (input.pressingLeft() && input.pressingRight()));
    }

    private static boolean physicalInputActive(ClientPlayerEntity player) {
        if (player == null || player.input == null) {
            return false;
        }
        Input input = player.input;
        return input.pressingForward
            || input.pressingBack
            || input.pressingLeft
            || input.pressingRight
            || input.jumping
            || input.sneaking
            || Math.abs(input.movementForward) > AXIS_EPSILON
            || Math.abs(input.movementSideways) > AXIS_EPSILON;
    }

    private static boolean inputMatches(Input input, InputState state) {
        if (input == null || state == null) {
            return input == null && state == null;
        }
        return input.pressingForward == state.pressingForward()
            && input.pressingBack == state.pressingBack()
            && input.pressingLeft == state.pressingLeft()
            && input.pressingRight == state.pressingRight()
            && input.jumping == state.jumping()
            && input.sneaking == state.sneaking()
            && Math.abs(input.movementForward - state.movementForward()) <= AXIS_EPSILON
            && Math.abs(input.movementSideways - state.movementSideways()) <= AXIS_EPSILON;
    }

    private static boolean sprintPressed(MinecraftClient client) {
        return client != null
            && client.options != null
            && client.options.sprintKey != null
            && client.options.sprintKey.isPressed();
    }

    private static void writeInput(Input input, InputState state) {
        input.pressingForward = state.pressingForward();
        input.pressingBack = state.pressingBack();
        input.pressingLeft = state.pressingLeft();
        input.pressingRight = state.pressingRight();
        input.jumping = state.jumping();
        input.sneaking = state.sneaking();
        input.movementForward = state.movementForward();
        input.movementSideways = state.movementSideways();
    }

    private static void writeSprint(MinecraftClient client, boolean requested) {
        if (client != null && client.options != null && client.options.sprintKey != null) {
            client.options.sprintKey.setPressed(requested);
        }
    }

    private static void forceUnsneak(ClientPlayerEntity player) {
        player.setSneaking(false);
    }

    private static long elapsed(long nowMs, long sinceMs) {
        return Math.max(0L, nowMs - sinceMs);
    }

    private static double ratio(long activeMs, long elapsedMs) {
        if (elapsedMs <= 0L) {
            return 0.0D;
        }
        return rounded(Math.min(1.0D, Math.max(0.0D, activeMs / (double) elapsedMs)));
    }

    private static double rounded(double value) {
        return Math.round(value * 1_000.0D) / 1_000.0D;
    }

    private static String textOr(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }
}
