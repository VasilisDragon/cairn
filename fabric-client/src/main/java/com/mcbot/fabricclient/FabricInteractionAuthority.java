package com.mcbot.fabricclient;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Objects;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;
import org.slf4j.Logger;

/**
 * Sole physical sink for attack/use keys and interaction-manager calls.
 *
 * <p>Call {@link #commit} only after movement guards and the final gaze commit. Block mining never
 * presses the physical attack key: exactly one interaction-manager progress update is admitted per
 * world tick.
 */
final class FabricInteractionAuthority {
    private static final long SUMMARY_INTERVAL_MS = 5_000L;
    private static final int COMPUTATION_SAMPLE_CAP = 256;
    private static final int VERIFIED_REQUEST_CAP = 64;

    enum EntityReachMetric {
        /** Historical entity-origin distance, retained for combat and sheep compatibility. */
        ENTITY_ORIGIN,
        /** Eye position to the closest point of the target hitbox. */
        EYE_TO_HITBOX
    }

    record Metrics(
        int logicalMiningGestures,
        int blockTargetTransitions,
        int breakUpdateCalls,
        int duplicateBreakUpdates,
        int blockAttackKeyPresses,
        int preAimTransitions,
        int avoidableNeutralGaps,
        int ghostBlockRestorations,
        int usePulses,
        int useVerifications,
        int entityAttackPulses,
        int attackCooldownViolations,
        int lifecycleKeyLeaks,
        int shadowMismatches,
        int directWriterViolations,
        int cursorRegressions,
        long maximumNeutralGapMs,
        long minimumAttackIntervalMs,
        double computationP95Ms
    ) {
    }

    /**
     * Metrics whose scope is the currently active command rather than the client lifecycle.
     *
     * <p>The public harness still consumes {@link Metrics} as lifecycle-wide diagnostics. Keeping
     * this accumulator separate prevents a clean mining command from inheriting an anomaly that
     * belonged to an earlier gather, combat, or placement command.
     */
    record CommandMetrics(
        String commandId,
        int duplicateBreakUpdates,
        int avoidableNeutralGaps,
        long maximumNeutralGapMs
    ) {
        CommandMetrics {
            commandId = commandId == null || commandId.isBlank() ? "uncommanded" : commandId;
            duplicateBreakUpdates = Math.max(0, duplicateBreakUpdates);
            avoidableNeutralGaps = Math.max(0, avoidableNeutralGaps);
            maximumNeutralGapMs = Math.max(0L, maximumNeutralGapMs);
        }

        static CommandMetrics empty() {
            return new CommandMetrics("uncommanded", 0, 0, 0L);
        }

        CommandMetrics forCommand(String nextCommandId) {
            String stable = nextCommandId == null || nextCommandId.isBlank()
                ? "uncommanded"
                : nextCommandId;
            return commandId.equals(stable)
                ? this
                : new CommandMetrics(stable, 0, 0, 0L);
        }

        CommandMetrics observe(boolean duplicateBreakUpdate, long neutralGapMs) {
            boolean observedGap = neutralGapMs >= 0L;
            return new CommandMetrics(
                commandId,
                duplicateBreakUpdates + (duplicateBreakUpdate ? 1 : 0),
                avoidableNeutralGaps + (observedGap && neutralGapMs > 250L ? 1 : 0),
                observedGap ? Math.max(maximumNeutralGapMs, neutralGapMs) : maximumNeutralGapMs
            );
        }
    }

    record EntityGate(
        double maximumReach,
        double desiredYaw,
        double desiredPitch,
        double maximumAlignmentError,
        long notBeforeMs,
        boolean requireLineOfSight,
        EntityReachMetric reachMetric
    ) {
        EntityGate {
            if (!Double.isFinite(maximumReach) || maximumReach <= 0.0D) {
                throw new IllegalArgumentException("maximumReach must be positive and finite");
            }
            if (!Double.isFinite(desiredYaw) || !Double.isFinite(desiredPitch)) {
                throw new IllegalArgumentException("desired angles must be finite");
            }
            if (!Double.isFinite(maximumAlignmentError) || maximumAlignmentError < 0.0D) {
                throw new IllegalArgumentException(
                    "maximumAlignmentError must be non-negative and finite"
                );
            }
            desiredYaw = LookController.normalizeYaw(desiredYaw);
            desiredPitch = Math.max(-90.0D, Math.min(90.0D, desiredPitch));
            reachMetric = reachMetric == null
                ? EntityReachMetric.ENTITY_ORIGIN : reachMetric;
        }

        EntityGate(
            double maximumReach,
            double desiredYaw,
            double desiredPitch,
            double maximumAlignmentError,
            long notBeforeMs,
            boolean requireLineOfSight
        ) {
            this(
                maximumReach,
                desiredYaw,
                desiredPitch,
                maximumAlignmentError,
                notBeforeMs,
                requireLineOfSight,
                EntityReachMetric.ENTITY_ORIGIN
            );
        }
    }

    record Payload(
        BlockPos blockPos,
        Direction face,
        Entity entity,
        BlockHitResult blockHit,
        Hand hand,
        EntityGate entityGate
    ) {
        static Payload none() {
            return new Payload(null, null, null, null, Hand.MAIN_HAND, null);
        }

        static Payload blockBreak(BlockPos blockPos, Direction face) {
            return new Payload(
                Objects.requireNonNull(blockPos, "blockPos").toImmutable(),
                Objects.requireNonNull(face, "face"),
                null,
                null,
                Hand.MAIN_HAND,
                null
            );
        }

        static Payload entity(Entity entity, Hand hand, EntityGate gate) {
            return new Payload(
                null,
                null,
                Objects.requireNonNull(entity, "entity"),
                null,
                hand == null ? Hand.MAIN_HAND : hand,
                Objects.requireNonNull(gate, "gate")
            );
        }

        static Payload blockUse(BlockHitResult hit, Hand hand) {
            return new Payload(
                null,
                null,
                null,
                Objects.requireNonNull(hit, "hit"),
                hand == null ? Hand.MAIN_HAND : hand,
                null
            );
        }

        static Payload item(Hand hand) {
            return new Payload(
                null,
                null,
                null,
                null,
                hand == null ? Hand.MAIN_HAND : hand,
                null
            );
        }
    }

    private record DispatchResult(
        InteractionAppliedReceipt.Disposition disposition,
        boolean applied,
        ActionResult actionResult,
        String reason
    ) {
        static DispatchResult applied(String reason) {
            return new DispatchResult(
                InteractionAppliedReceipt.Disposition.APPLIED,
                true,
                null,
                reason
            );
        }

        static DispatchResult applied(ActionResult result, String reason) {
            return new DispatchResult(
                InteractionAppliedReceipt.Disposition.APPLIED,
                true,
                result,
                reason
            );
        }

        static DispatchResult deferred(String reason) {
            return new DispatchResult(
                InteractionAppliedReceipt.Disposition.DEFERRED,
                false,
                null,
                reason
            );
        }

        static DispatchResult suppressed(String reason) {
            return new DispatchResult(
                InteractionAppliedReceipt.Disposition.SUPPRESSED,
                false,
                null,
                reason
            );
        }
    }

    private final String instanceId;
    private final Logger logger;
    private final FabricMotionMode mode;
    private FabricInteractionController.State legacyState =
        FabricInteractionController.initialState();
    private FabricInteractionController.State smoothState =
        FabricInteractionController.initialState();
    private Object lastWorld;
    private String lastDimension = "";
    private InteractionDemand lastDemand;
    private final long[] computationNanos = new long[COMPUTATION_SAMPLE_CAP];
    private final LinkedHashSet<String> verifiedUseRequests = new LinkedHashSet<>();
    private int computationIndex;
    private int computationCount;
    private int logicalMiningGestures;
    private int blockTargetTransitions;
    private int breakUpdateCalls;
    private int duplicateBreakUpdates;
    private int blockAttackKeyPresses;
    private int preAimTransitions;
    private int avoidableNeutralGaps;
    private int ghostBlockRestorations;
    private int usePulses;
    private int useVerifications;
    private int entityAttackPulses;
    private int attackCooldownViolations;
    private int lifecycleKeyLeaks;
    private int shadowMismatches;
    private int directWriterViolations;
    private int cursorRegressions;
    private long maximumNeutralGapMs;
    private long minimumAttackIntervalMs;
    private long lastAttackAppliedAtMs = -1L;
    private long activeStartedAtMs;
    private long lastSummaryAtMs;
    private CommandMetrics commandMetrics = CommandMetrics.empty();

    FabricInteractionAuthority(String instanceId, Logger logger, FabricMotionMode mode) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.logger = logger;
        this.mode = mode == null ? FabricMotionMode.LEGACY : mode;
    }

    FabricMotionMode mode() {
        return mode;
    }

    Metrics metrics() {
        return new Metrics(
            logicalMiningGestures,
            blockTargetTransitions,
            breakUpdateCalls,
            duplicateBreakUpdates,
            blockAttackKeyPresses,
            preAimTransitions,
            avoidableNeutralGaps,
            ghostBlockRestorations,
            usePulses,
            useVerifications,
            entityAttackPulses,
            attackCooldownViolations,
            lifecycleKeyLeaks,
            shadowMismatches,
            directWriterViolations,
            cursorRegressions,
            maximumNeutralGapMs,
            minimumAttackIntervalMs,
            computationP95Ms()
        );
    }

    CommandMetrics commandMetrics() {
        return commandMetrics;
    }

    InteractionAppliedReceipt commit(
        MinecraftClient client,
        ClientPlayerEntity player,
        InteractionDemand demand,
        Payload payload,
        long nowMs
    ) {
        InteractionDemand stableDemand = demand == null
            ? InteractionDemand.release(
                "release:missing_demand",
                LookDemand.Owner.NORMAL,
                "uncommanded",
                "missing_demand",
                "missing_interaction_demand"
            )
            : demand;
        Payload stablePayload = payload == null ? Payload.none() : payload;
        if (lastDemand != null
            && (!lastDemand.commandId().equals(stableDemand.commandId())
                || lastDemand.owner() != stableDemand.owner())) {
            emitSummary(lastDemand, nowMs, true);
            activeStartedAtMs = 0L;
        }
        if (lifecycleChanged(client)) {
            emitSummary(lastDemand, nowMs, true);
            releasePhysical(client, true);
            resetStates();
        }
        observeLifecycle(client);
        commandMetrics = commandMetrics.forCommand(metricsCommandScope(stableDemand.commandId()));

        long computationStartedNs = System.nanoTime();
        FabricInteractionController.Observation observation =
            new FabricInteractionController.Observation(nowMs, physicalTick(client, nowMs));
        FabricInteractionController.Transition legacy = FabricInteractionController.prepare(
            legacyState,
            stableDemand,
            observation,
            FabricInteractionController.Behavior.LEGACY
        );
        FabricInteractionController.Transition smooth = mode == FabricMotionMode.LEGACY
            ? null
            : FabricInteractionController.prepare(
                smoothState,
                stableDemand,
                observation,
                FabricInteractionController.Behavior.SMOOTH
            );
        FabricInteractionController.Output appliedOutput =
            FabricInteractionController.selectApplied(
                mode,
                legacy.output(),
                smooth == null ? null : smooth.output()
            );
        if (smooth != null && !physicallyEquivalent(legacy.output(), smooth.output())) {
            shadowMismatches++;
        }
        boolean legacyWouldApply = wouldApply(
            client,
            player,
            stablePayload,
            legacy.output(),
            nowMs
        );
        boolean smoothWouldApply = smooth != null && wouldApply(
            client,
            player,
            stablePayload,
            smooth.output(),
            nowMs
        );
        recordComputation(System.nanoTime() - computationStartedNs);

        // The key must remain false even for block breaking. updateBlockBreakingProgress is the
        // entire vanilla break cadence; holding attack would double-advance and create ghost blocks.
        setAttackPressed(client, false);
        if (!appliedOutput.useKeyPressed()) {
            setUsePressed(client, false);
        }
        boolean cleanupApplied = false;
        if (appliedOutput.cancelBreakBeforeDispatch()) {
            cleanupApplied = cancelBreaking(client);
        }

        DispatchResult result = dispatch(
            client,
            player,
            stablePayload,
            appliedOutput,
            nowMs
        );
        if (appliedOutput.useKeyPressed()) {
            setUsePressed(client, true);
        }

        legacyState = FabricInteractionController.acknowledge(
            legacy,
            mode == FabricMotionMode.SMOOTH ? legacyWouldApply : result.applied(),
            nowMs
        );
        if (smooth != null) {
            smoothState = FabricInteractionController.acknowledge(
                smooth,
                mode == FabricMotionMode.SMOOTH ? result.applied() : smoothWouldApply,
                nowMs
            );
        }

        InteractionAppliedReceipt receipt = new InteractionAppliedReceipt(
            stableDemand.requestId(),
            stableDemand.action(),
            result.disposition(),
            result.applied(),
            result.actionResult(),
            nowMs,
            result.reason(),
            mode,
            appliedOutput,
            smooth == null ? null : smooth.output(),
            cleanupApplied,
            attackPressed(client),
            usePressed(client)
        );
        observeMetrics(lastDemand, stableDemand, receipt, nowMs);
        emitTransition(lastDemand, stableDemand, receipt);
        lastDemand = stableDemand;
        if (stableDemand.action() == InteractionDemand.Action.RELEASE
            || stableDemand.action() == InteractionDemand.Action.NONE) {
            emitSummary(stableDemand, nowMs, true);
            activeStartedAtMs = 0L;
        } else {
            emitSummary(stableDemand, nowMs, false);
        }
        return receipt;
    }

    InteractionAppliedReceipt release(
        MinecraftClient client,
        ClientPlayerEntity player,
        LookDemand.Owner owner,
        String commandId,
        String requestId,
        String reason,
        long nowMs
    ) {
        return commit(
            client,
            player,
            InteractionDemand.release(
                requestId,
                owner,
                commandId,
                "release",
                reason
            ),
            Payload.none(),
            nowMs
        );
    }

    void lifecycleCleanup(MinecraftClient client) {
        long nowMs = System.currentTimeMillis();
        emitSummary(lastDemand, nowMs, true);
        releasePhysical(client, true);
        if (attackPressed(client) || usePressed(client)) {
            lifecycleKeyLeaks++;
        }
        resetStates();
        lastWorld = null;
        lastDimension = "";
    }

    void recordUseVerification(String requestId, boolean verified, long nowMs) {
        if (!verified || requestId == null || requestId.isBlank()
            || verifiedUseRequests.contains(requestId)) {
            return;
        }
        if (verifiedUseRequests.size() >= VERIFIED_REQUEST_CAP) {
            String oldest = verifiedUseRequests.iterator().next();
            verifiedUseRequests.remove(oldest);
        }
        verifiedUseRequests.add(requestId);
        useVerifications++;
        if (logger != null) {
            logger.info(
                "motion.interaction.pulse_completed instanceId={} mode={} requestId={} kind=BLOCK_USE elapsedMs={}",
                instanceId,
                mode.wireName(),
                requestId,
                activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs)
            );
        }
    }

    void recordGhostBlockRestoration(String targetIdentity, long nowMs) {
        ghostBlockRestorations++;
        emitAnomaly("ghost_block_restoration", targetIdentity, nowMs);
    }

    void recordCursorRegression(String identity, long nowMs) {
        cursorRegressions++;
        emitAnomaly("cursor_regression", identity, nowMs);
    }

    void recordDirectWriterViolation(String identity, long nowMs) {
        directWriterViolations++;
        emitAnomaly("direct_writer_violation", identity, nowMs);
    }

    private DispatchResult dispatch(
        MinecraftClient client,
        ClientPlayerEntity player,
        Payload payload,
        FabricInteractionController.Output output,
        long nowMs
    ) {
        if (output == null) {
            return DispatchResult.deferred("missing_controller_output");
        }
        return switch (output.dispatch()) {
            case NONE -> DispatchResult.suppressed(
                output.duplicatePulseSuppressed()
                    ? "duplicate_pulse_suppressed"
                    : output.duplicateBreakUpdateSuppressed()
                        ? "duplicate_break_update_suppressed"
                        : "no_dispatch"
            );
            case RELEASE_KEYS -> {
                boolean released = releasePhysical(client, false);
                yield released
                    ? DispatchResult.applied("released")
                    : DispatchResult.deferred("missing_key_state");
            }
            case CANCEL_BREAK -> cancelBreaking(client)
                ? DispatchResult.applied("break_cancelled")
                : DispatchResult.deferred("missing_interaction_manager");
            case BREAK_PROGRESS -> {
                if (client == null || client.interactionManager == null
                    || payload.blockPos() == null || payload.face() == null) {
                    yield DispatchResult.deferred("missing_break_payload");
                }
                client.interactionManager.updateBlockBreakingProgress(
                    payload.blockPos(),
                    payload.face()
                );
                yield DispatchResult.applied("break_progress");
            }
            case ATTACK_ENTITY -> {
                String rejection = entityGateRejection(
                    client,
                    player,
                    payload.entity(),
                    payload.entityGate(),
                    nowMs
                );
                if (!rejection.isEmpty()) {
                    yield DispatchResult.deferred(rejection);
                }
                client.interactionManager.attackEntity(player, payload.entity());
                player.swingHand(payload.hand());
                yield DispatchResult.applied("entity_attack");
            }
            case USE_BLOCK -> {
                if (client == null || client.interactionManager == null
                    || player == null || payload.blockHit() == null) {
                    yield DispatchResult.deferred("missing_block_use_payload");
                }
                ActionResult actionResult = client.interactionManager.interactBlock(
                    player,
                    payload.hand(),
                    payload.blockHit()
                );
                player.swingHand(payload.hand());
                yield DispatchResult.applied(actionResult, "block_use:" + actionResult);
            }
            case HOLD_ITEM -> {
                if (!hasUseKey(client)) {
                    yield DispatchResult.deferred("missing_use_key");
                }
                yield DispatchResult.applied("item_held:" + payload.hand());
            }
        };
    }

    private static boolean wouldApply(
        MinecraftClient client,
        ClientPlayerEntity player,
        Payload payload,
        FabricInteractionController.Output output,
        long nowMs
    ) {
        if (output == null) {
            return false;
        }
        return switch (output.dispatch()) {
            case NONE -> false;
            case RELEASE_KEYS -> hasAttackKey(client) || hasUseKey(client);
            case CANCEL_BREAK -> client != null && client.interactionManager != null;
            case BREAK_PROGRESS -> client != null
                && client.interactionManager != null
                && payload.blockPos() != null
                && payload.face() != null;
            case ATTACK_ENTITY -> entityGateRejection(
                client,
                player,
                payload.entity(),
                payload.entityGate(),
                nowMs
            ).isEmpty();
            case USE_BLOCK -> client != null
                && client.interactionManager != null
                && player != null
                && payload.blockHit() != null;
            case HOLD_ITEM -> hasUseKey(client);
        };
    }

    private static boolean physicallyEquivalent(
        FabricInteractionController.Output legacy,
        FabricInteractionController.Output smooth
    ) {
        return legacy != null
            && smooth != null
            && legacy.dispatch() == smooth.dispatch()
            && legacy.cancelBreakBeforeDispatch() == smooth.cancelBreakBeforeDispatch()
            && legacy.attackKeyPressed() == smooth.attackKeyPressed()
            && legacy.useKeyPressed() == smooth.useKeyPressed();
    }

    private static String entityGateRejection(
        MinecraftClient client,
        ClientPlayerEntity player,
        Entity target,
        EntityGate gate,
        long nowMs
    ) {
        if (client == null || client.world == null || client.interactionManager == null
            || player == null || target == null || gate == null) {
            return "missing_entity_gate_state";
        }
        if (!target.isAlive()) {
            return "entity_not_alive";
        }
        if (nowMs < gate.notBeforeMs()) {
            return "entity_cooldown_pending";
        }
        Vec3d lineTarget = entityTargetPoint(player, target, gate.reachMetric());
        if (entityReachSquared(player, target, gate.reachMetric(), lineTarget)
            > gate.maximumReach() * gate.maximumReach()) {
            return "entity_out_of_reach";
        }
        if (Math.abs(LookController.shortestYawDelta(player.getYaw(), gate.desiredYaw()))
                > gate.maximumAlignmentError()
            || Math.abs(player.getPitch() - gate.desiredPitch())
                > gate.maximumAlignmentError()) {
            return "entity_gaze_unaligned";
        }
        if (gate.requireLineOfSight()
            && !hasClearEntityLine(client, player, target, lineTarget)) {
            return "entity_line_of_sight_blocked";
        }
        return "";
    }

    private static boolean hasClearEntityLine(
        MinecraftClient client,
        ClientPlayerEntity player,
        Entity target,
        Vec3d targetPoint
    ) {
        Vec3d eye = player.getEyePos();
        Vec3d targetEye = targetPoint == null ? target.getEyePos() : targetPoint;
        HitResult hit = client.world.raycast(new RaycastContext(
            eye,
            targetEye,
            RaycastContext.ShapeType.COLLIDER,
            RaycastContext.FluidHandling.NONE,
            player
        ));
        if (hit == null || hit.getType() == HitResult.Type.MISS) {
            return true;
        }
        return hit.getPos().squaredDistanceTo(eye)
            >= targetEye.squaredDistanceTo(eye) - 0.25D;
    }

    private static Vec3d entityTargetPoint(
        ClientPlayerEntity player,
        Entity target,
        EntityReachMetric reachMetric
    ) {
        if (reachMetric != EntityReachMetric.EYE_TO_HITBOX) {
            return target.getEyePos();
        }
        return closestPoint(player.getEyePos(), target.getBoundingBox());
    }

    private static double entityReachSquared(
        ClientPlayerEntity player,
        Entity target,
        EntityReachMetric reachMetric,
        Vec3d targetPoint
    ) {
        if (reachMetric != EntityReachMetric.EYE_TO_HITBOX) {
            return target.squaredDistanceTo(player);
        }
        return player.getEyePos().squaredDistanceTo(targetPoint);
    }

    static Vec3d closestPoint(Vec3d point, Box box) {
        if (point == null || box == null) {
            throw new IllegalArgumentException("point and box are required");
        }
        return new Vec3d(
            Math.max(box.minX, Math.min(box.maxX, point.x)),
            Math.max(box.minY, Math.min(box.maxY, point.y)),
            Math.max(box.minZ, Math.min(box.maxZ, point.z))
        );
    }

    private void observeMetrics(
        InteractionDemand previous,
        InteractionDemand demand,
        InteractionAppliedReceipt receipt,
        long nowMs
    ) {
        FabricInteractionController.Output smoothOutput = mode == FabricMotionMode.SMOOTH
            ? receipt.appliedOutput()
            : receipt.shadowOutput();
        boolean breakOwnershipStarted = demand.isBreakOwnership()
            && (previous == null || !previous.sameLogicalGesture(demand));
        if (breakOwnershipStarted && smoothOutput != null) {
            logicalMiningGestures++;
            if (activeStartedAtMs == 0L) {
                activeStartedAtMs = nowMs;
            }
        }
        if (smoothOutput != null
            && smoothOutput.logicalGestureContinued()
            && smoothOutput.targetChanged()) {
            blockTargetTransitions++;
            maximumNeutralGapMs = Math.max(
                maximumNeutralGapMs,
                smoothOutput.appliedGapMs()
            );
            if (smoothOutput.appliedGapMs() > 250L) {
                avoidableNeutralGaps++;
            }
            commandMetrics = commandMetrics.observe(false, smoothOutput.appliedGapMs());
        }
        if (demand.action() == InteractionDemand.Action.BLOCK_BREAK_HOLD
            && (previous == null
                || previous.action() != InteractionDemand.Action.BLOCK_BREAK_HOLD
                || !previous.targetIdentity().equals(demand.targetIdentity()))) {
            preAimTransitions++;
        }
        if (receipt.applied()
            && receipt.action() == InteractionDemand.Action.BREAK_BLOCK) {
            breakUpdateCalls++;
        }
        // This metric counts duplicate physical updates, not harmless demand suppression
        // when the integrated server briefly repeats a world tick. Suppressed demands do
        // not call updateBlockBreakingProgress and therefore are not duplicate updates.
        if (receipt.applied()
            && receipt.action() == InteractionDemand.Action.BREAK_BLOCK
            && receipt.appliedOutput().duplicateBreakUpdateSuppressed()) {
            duplicateBreakUpdates++;
            commandMetrics = commandMetrics.observe(true, -1L);
        }
        if (receipt.attackKeyPressed()) {
            blockAttackKeyPresses++;
        }
        if (receipt.applied() && receipt.action() == InteractionDemand.Action.USE_BLOCK) {
            usePulses++;
        }
        if (receipt.applied() && receipt.action() == InteractionDemand.Action.ATTACK_ENTITY) {
            entityAttackPulses++;
            if (lastAttackAppliedAtMs >= 0L) {
                long interval = elapsed(nowMs, lastAttackAppliedAtMs);
                minimumAttackIntervalMs = minimumAttackIntervalMs == 0L
                    ? interval
                    : Math.min(minimumAttackIntervalMs, interval);
            }
            lastAttackAppliedAtMs = nowMs;
        }
        if ("entity_cooldown_pending".equals(receipt.reason())) {
            attackCooldownViolations++;
        }
        if (activeStartedAtMs == 0L
            && demand.action() != InteractionDemand.Action.NONE
            && demand.action() != InteractionDemand.Action.RELEASE) {
            activeStartedAtMs = nowMs;
        }
    }

    private void emitSummary(InteractionDemand demand, long nowMs, boolean terminal) {
        if (logger == null || demand == null || activeStartedAtMs == 0L) {
            return;
        }
        if (!terminal && lastSummaryAtMs != 0L
            && elapsed(nowMs, lastSummaryAtMs) < SUMMARY_INTERVAL_MS) {
            return;
        }
        lastSummaryAtMs = nowMs;
        Metrics values = metrics();
        CommandMetrics commandValues = commandMetrics.forCommand(metricsCommandScope(demand.commandId()));
        logger.info(
            "motion.interaction.summary instanceId={} mode={} owner={} command={} action={} terminal={} logicalMiningGestures={} blockTargetTransitions={} breakUpdateCalls={} duplicateBreakUpdates={} blockAttackKeyPresses={} preAimTransitions={} avoidableNeutralGaps={} ghostBlockRestorations={} usePulses={} useVerifications={} entityAttackPulses={} attackCooldownViolations={} lifecycleKeyLeaks={} shadowMismatches={} directWriterViolations={} cursorRegressions={} maximumNeutralGapMs={} minimumAttackIntervalMs={} computationP95Ms={} commandDuplicateBreakUpdates={} commandAvoidableNeutralGaps={} commandMaximumNeutralGapMs={} elapsedMs={}",
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.commandId(),
            demand.action(),
            terminal,
            values.logicalMiningGestures(),
            values.blockTargetTransitions(),
            values.breakUpdateCalls(),
            values.duplicateBreakUpdates(),
            values.blockAttackKeyPresses(),
            values.preAimTransitions(),
            values.avoidableNeutralGaps(),
            values.ghostBlockRestorations(),
            values.usePulses(),
            values.useVerifications(),
            values.entityAttackPulses(),
            values.attackCooldownViolations(),
            values.lifecycleKeyLeaks(),
            values.shadowMismatches(),
            values.directWriterViolations(),
            values.cursorRegressions(),
            values.maximumNeutralGapMs(),
            values.minimumAttackIntervalMs(),
            rounded(values.computationP95Ms()),
            commandValues.duplicateBreakUpdates(),
            commandValues.avoidableNeutralGaps(),
            commandValues.maximumNeutralGapMs(),
            elapsed(nowMs, activeStartedAtMs)
        );
    }

    private void emitAnomaly(String reason, String identity, long nowMs) {
        if (logger == null) {
            return;
        }
        logger.info(
            "motion.interaction.anomaly instanceId={} mode={} command={} reason={} identity={} elapsedMs={}",
            instanceId,
            mode.wireName(),
            lastDemand == null ? "uncommanded" : lastDemand.commandId(),
            reason,
            identity == null ? "" : identity,
            activeStartedAtMs == 0L ? 0L : elapsed(nowMs, activeStartedAtMs)
        );
    }

    private void recordComputation(long nanos) {
        long bounded = Math.max(0L, nanos);
        computationNanos[computationIndex] = bounded;
        computationIndex = (computationIndex + 1) % computationNanos.length;
        computationCount = Math.min(computationCount + 1, computationNanos.length);
    }

    private double computationP95Ms() {
        if (computationCount == 0) {
            return 0.0D;
        }
        long[] sorted = Arrays.copyOf(computationNanos, computationCount);
        Arrays.sort(sorted);
        int index = Math.max(0, (int) Math.ceil(sorted.length * 0.95D) - 1);
        return sorted[index] / 1_000_000.0D;
    }

    private void emitTransition(
        InteractionDemand previous,
        InteractionDemand demand,
        InteractionAppliedReceipt receipt
    ) {
        if (logger == null || receipt == null || receipt.appliedOutput() == null) {
            return;
        }
        if (receipt.applied()
            && demand.action() == InteractionDemand.Action.BREAK_BLOCK) {
            logger.info(
                "motion.interaction.break_update instanceId={} mode={} owner={} command={} requestId={} target={} face={} physicalTick={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.commandId(),
                demand.requestId(),
                demand.targetIdentity(),
                demand.faceIdentity(),
                receipt.appliedOutput().physicalTick(),
                activeStartedAtMs == 0L ? 0L : elapsed(receipt.timestampMs(), activeStartedAtMs)
            );
        }
        boolean changed = previous == null
            || previous.action() != demand.action()
            || !previous.commandId().equals(demand.commandId())
            || !previous.targetIdentity().equals(demand.targetIdentity())
            || receipt.duplicateSuppressed()
            || receipt.retryable();
        if (!changed) {
            return;
        }
        if (demand.action() == InteractionDemand.Action.RELEASE
            && previous != null
            && previous.action() != InteractionDemand.Action.RELEASE
            && previous.action() != InteractionDemand.Action.NONE) {
            logger.info(
                "motion.interaction.released instanceId={} mode={} owner={} command={} requestId={} previousAction={} reason={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.commandId(),
                demand.requestId(),
                previous.action(),
                receipt.reason(),
                activeStartedAtMs == 0L ? 0L : elapsed(receipt.timestampMs(), activeStartedAtMs)
            );
        }
        if (previous == null || previous.owner() != demand.owner()) {
            logger.info(
                "motion.interaction.owner_changed instanceId={} mode={} owner={} command={} kind={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.commandId(),
                demand.action(),
                activeStartedAtMs == 0L ? 0L : elapsed(receipt.timestampMs(), activeStartedAtMs)
            );
        }
        if (demand.isBreakOwnership()
            && (previous == null || !previous.sameLogicalGesture(demand))) {
            logger.info(
                "motion.interaction.gesture_started instanceId={} mode={} owner={} command={} requestId={} kind={} gesture={} target={} tool={} face={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.commandId(),
                demand.requestId(),
                demand.action(),
                demand.gestureIdentity(),
                demand.targetIdentity(),
                demand.toolIdentity(),
                demand.faceIdentity(),
                0L
            );
        }
        if (previous == null
            || !previous.targetIdentity().equals(demand.targetIdentity())
            || !previous.faceIdentity().equals(demand.faceIdentity())) {
            logger.info(
                "motion.interaction.target_changed instanceId={} mode={} owner={} command={} requestId={} kind={} target={} face={} stage={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.commandId(),
                demand.requestId(),
                demand.action(),
                demand.targetIdentity(),
                demand.faceIdentity(),
                demand.stageIdentity(),
                receipt.appliedOutput().targetElapsedMs()
            );
        }
        if (demand.action() == InteractionDemand.Action.BLOCK_BREAK_HOLD
            && (previous == null
                || previous.action() != InteractionDemand.Action.BLOCK_BREAK_HOLD
                || !previous.targetIdentity().equals(demand.targetIdentity()))) {
            logger.info(
                "motion.interaction.preaim_transition instanceId={} mode={} command={} requestId={} target={} face={} stage={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                demand.commandId(),
                demand.requestId(),
                demand.targetIdentity(),
                demand.faceIdentity(),
                demand.stageIdentity(),
                receipt.appliedOutput().gestureElapsedMs()
            );
        }
        if (receipt.applied()
            && (demand.action() == InteractionDemand.Action.USE_BLOCK
                || demand.action() == InteractionDemand.Action.ATTACK_ENTITY)) {
            logger.info(
                "motion.interaction.pulse_started instanceId={} mode={} owner={} command={} requestId={} kind={} target={} result={} elapsedMs={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.commandId(),
                demand.requestId(),
                demand.action(),
                demand.targetIdentity(),
                receipt.reason(),
                activeStartedAtMs == 0L ? 0L : elapsed(receipt.timestampMs(), activeStartedAtMs)
            );
            if (demand.action() == InteractionDemand.Action.ATTACK_ENTITY) {
                logger.info(
                    "motion.interaction.pulse_completed instanceId={} mode={} owner={} command={} requestId={} kind={} target={} elapsedMs={}",
                    instanceId,
                    mode.wireName(),
                    demand.owner(),
                    demand.commandId(),
                    demand.requestId(),
                    demand.action(),
                    demand.targetIdentity(),
                    activeStartedAtMs == 0L ? 0L : elapsed(receipt.timestampMs(), activeStartedAtMs)
                );
            }
        }
        logger.info(
            "motion.interaction.state_changed instanceId={} mode={} owner={} command={} requestId={} action={} stage={} target={} dispatch={} disposition={} continued={} duplicateSuppressed={} cleanupApplied={} gestureElapsedMs={} targetElapsedMs={} result={}",
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.commandId(),
            demand.requestId(),
            demand.action(),
            demand.stageIdentity(),
            demand.targetIdentity(),
            receipt.appliedOutput().dispatch(),
            receipt.disposition(),
            receipt.appliedOutput().logicalGestureContinued(),
            receipt.duplicateSuppressed(),
            receipt.cleanupApplied(),
            receipt.appliedOutput().gestureElapsedMs(),
            receipt.appliedOutput().targetElapsedMs(),
            receipt.reason()
        );
    }

    private boolean lifecycleChanged(MinecraftClient client) {
        Object world = client == null ? null : client.world;
        String dimension = client == null || client.world == null
            ? ""
            : client.world.getRegistryKey().getValue().toString();
        return lastWorld != null && (world != lastWorld || !lastDimension.equals(dimension));
    }

    private void observeLifecycle(MinecraftClient client) {
        lastWorld = client == null ? null : client.world;
        lastDimension = client == null || client.world == null
            ? ""
            : client.world.getRegistryKey().getValue().toString();
    }

    private void resetStates() {
        legacyState = FabricInteractionController.initialState();
        smoothState = FabricInteractionController.initialState();
        lastDemand = null;
        activeStartedAtMs = 0L;
        lastSummaryAtMs = 0L;
        lastAttackAppliedAtMs = -1L;
        verifiedUseRequests.clear();
        commandMetrics = CommandMetrics.empty();
    }

    /**
     * Block targets deliberately receive distinct breaker command IDs, but all targets in one
     * progressive mission-stone command form a single continuous mining task. Aggregate that
     * family under its stable outer prefix so block-to-block neutral gaps remain observable.
     */
    static String metricsCommandScope(String commandId) {
        String stable = commandId == null || commandId.isBlank()
            ? "uncommanded"
            : commandId;
        String marker = ":mission-stone:";
        int markerIndex = stable.indexOf(marker);
        return markerIndex < 0
            ? stable
            : stable.substring(0, markerIndex + marker.length() - 1);
    }

    private static long physicalTick(MinecraftClient client, long nowMs) {
        return client != null && client.world != null
            ? client.world.getTime()
            : Math.floorDiv(nowMs, 50L);
    }

    private static boolean releasePhysical(MinecraftClient client, boolean cancelBreak) {
        boolean released = false;
        if (hasAttackKey(client)) {
            setAttackPressed(client, false);
            released = true;
        }
        if (hasUseKey(client)) {
            setUsePressed(client, false);
            released = true;
        }
        if (cancelBreak) {
            released |= cancelBreaking(client);
        }
        return released;
    }

    private static boolean cancelBreaking(MinecraftClient client) {
        if (client == null || client.interactionManager == null) {
            return false;
        }
        client.interactionManager.cancelBlockBreaking();
        return true;
    }

    private static boolean hasAttackKey(MinecraftClient client) {
        return client != null && client.options != null && client.options.attackKey != null;
    }

    private static boolean hasUseKey(MinecraftClient client) {
        return client != null && client.options != null && client.options.useKey != null;
    }

    private static void setAttackPressed(MinecraftClient client, boolean pressed) {
        if (hasAttackKey(client)) {
            client.options.attackKey.setPressed(pressed);
        }
    }

    private static void setUsePressed(MinecraftClient client, boolean pressed) {
        if (hasUseKey(client)) {
            client.options.useKey.setPressed(pressed);
        }
    }

    private static boolean attackPressed(MinecraftClient client) {
        return hasAttackKey(client) && client.options.attackKey.isPressed();
    }

    private static boolean usePressed(MinecraftClient client) {
        return hasUseKey(client) && client.options.useKey.isPressed();
    }

    private static long elapsed(long nowMs, long thenMs) {
        return Math.max(0L, nowMs - thenMs);
    }

    private static double rounded(double value) {
        return Math.round(value * 1_000.0D) / 1_000.0D;
    }
}
