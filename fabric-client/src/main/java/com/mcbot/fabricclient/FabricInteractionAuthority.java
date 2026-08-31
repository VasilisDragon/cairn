package com.mcbot.fabricclient;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.function.Function;
import net.minecraft.block.BedBlock;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ChestBlock;
import net.minecraft.block.enums.BedPart;
import net.minecraft.block.enums.ChestType;
import net.minecraft.block.enums.DoubleBlockHalf;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.AbstractFurnaceScreenHandler;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.GenericContainerScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.server.MinecraftServer;
import net.minecraft.state.property.Properties;
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
    private static final long CONTAINER_OPEN_BIND_TIMEOUT_MS = 2_000L;
    private static final long SUMMARY_INTERVAL_MS = 5_000L;
    private static final int COMPUTATION_SAMPLE_CAP = 256;
    private static final int VERIFIED_REQUEST_CAP = 64;

    enum EntityReachMetric {
        /** Historical entity-origin distance, retained for combat and sheep compatibility. */
        ENTITY_ORIGIN,
        /** Eye position to the closest point of the target hitbox. */
        EYE_TO_HITBOX
    }

    /**
     * Code-owned instructions for rebuilding the complete affected footprint at the physical sink.
     * A controller may describe intent, but it never supplies a precomputed protection verdict.
     */
    enum BlockTargetSemantics {
        NONE,
        BREAK_LIVE,
        USE_LIVE,
        BED_USE_LIVE,
        PLACEMENT,
        BED_PLACEMENT
    }

    enum HeldItemMode {
        NONE,
        EMPTY_MAIN_HAND,
        EXACT_BLOCK_ITEM
    }

    /** A block interaction is authorized only for the exact live hand state modeled by its caller. */
    record HeldItemRequirement(HeldItemMode mode, Block expectedBlock) {
        HeldItemRequirement {
            mode = mode == null ? HeldItemMode.NONE : mode;
            if (mode == HeldItemMode.EXACT_BLOCK_ITEM && expectedBlock == null) {
                throw new IllegalArgumentException("exact block-item requirement needs a block");
            }
            if (mode != HeldItemMode.EXACT_BLOCK_ITEM && expectedBlock != null) {
                throw new IllegalArgumentException("only exact block-item requirements carry a block");
            }
        }

        static HeldItemRequirement none() {
            return new HeldItemRequirement(HeldItemMode.NONE, null);
        }

        static HeldItemRequirement emptyMainHand() {
            return new HeldItemRequirement(HeldItemMode.EMPTY_MAIN_HAND, null);
        }

        static HeldItemRequirement exactBlockItem(Block expectedBlock) {
            return new HeldItemRequirement(
                HeldItemMode.EXACT_BLOCK_ITEM,
                Objects.requireNonNull(expectedBlock, "expectedBlock")
            );
        }

        boolean matches(Hand hand, ItemStack stack) {
            return switch (mode) {
                case NONE -> true;
                case EMPTY_MAIN_HAND -> hand == Hand.MAIN_HAND
                    && stack != null
                    && stack.isEmpty();
                case EXACT_BLOCK_ITEM -> hand == Hand.MAIN_HAND
                    && stack != null
                    && !stack.isEmpty()
                    && stack.getItem() instanceof BlockItem blockItem
                    && blockItem.getBlock() == expectedBlock;
            };
        }
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
        HeldItemRequirement heldItemRequirement,
        EntityGate entityGate,
        FabricWorldActionAuthorization.BlockAuthorization blockAuthorization,
        List<BlockPos> affectedBlockPositions,
        BlockTargetSemantics blockTargetSemantics
    ) {
        Payload {
            blockAuthorization = blockAuthorization == null
                ? FabricWorldActionAuthorization.BlockAuthorization.unspecified()
                : blockAuthorization;
            heldItemRequirement = heldItemRequirement == null
                ? HeldItemRequirement.none()
                : heldItemRequirement;
            affectedBlockPositions = immutableBlockPositions(affectedBlockPositions);
            blockTargetSemantics = blockTargetSemantics == null
                ? BlockTargetSemantics.NONE
                : blockTargetSemantics;
            HeldItemMode requiredMode = switch (blockTargetSemantics) {
                case USE_LIVE, BED_USE_LIVE -> HeldItemMode.EMPTY_MAIN_HAND;
                case PLACEMENT, BED_PLACEMENT -> HeldItemMode.EXACT_BLOCK_ITEM;
                case NONE, BREAK_LIVE -> HeldItemMode.NONE;
            };
            if (heldItemRequirement.mode() != requiredMode) {
                throw new IllegalArgumentException(
                    "block target semantics require held-item mode " + requiredMode
                );
            }
            if (blockTargetSemantics == BlockTargetSemantics.BED_PLACEMENT
                && !(heldItemRequirement.expectedBlock() instanceof BedBlock)) {
                throw new IllegalArgumentException("bed placement requires a bed block item");
            }
            if (blockTargetSemantics == BlockTargetSemantics.PLACEMENT
                && heldItemRequirement.expectedBlock() instanceof BedBlock) {
                throw new IllegalArgumentException("bed block items require bed placement semantics");
            }
        }

        static Payload none() {
            return new Payload(
                null, null, null, null, Hand.MAIN_HAND, HeldItemRequirement.none(),
                null, null, List.of(),
                BlockTargetSemantics.NONE);
        }

        static Payload blockBreak(BlockPos blockPos, Direction face) {
            return blockBreak(
                blockPos,
                face,
                FabricWorldActionAuthorization.BlockAuthorization.unspecified()
            );
        }

        static Payload blockBreak(
            BlockPos blockPos,
            Direction face,
            FabricWorldActionAuthorization.BlockAuthorization authorization
        ) {
            BlockPos stableBlockPos = Objects.requireNonNull(
                blockPos,
                "blockPos"
            ).toImmutable();
            return new Payload(
                stableBlockPos,
                Objects.requireNonNull(face, "face"),
                null,
                null,
                Hand.MAIN_HAND,
                HeldItemRequirement.none(),
                null,
                authorization,
                List.of(stableBlockPos),
                BlockTargetSemantics.BREAK_LIVE
            );
        }

        static Payload entity(Entity entity, Hand hand, EntityGate gate) {
            return new Payload(
                null,
                null,
                Objects.requireNonNull(entity, "entity"),
                null,
                hand == null ? Hand.MAIN_HAND : hand,
                HeldItemRequirement.none(),
                Objects.requireNonNull(gate, "gate"),
                null,
                List.of(),
                BlockTargetSemantics.NONE
            );
        }

        static Payload blockUse(BlockHitResult hit, Hand hand) {
            return blockUse(
                hit,
                hand,
                FabricWorldActionAuthorization.BlockAuthorization.unspecified()
            );
        }

        static Payload blockUse(
            BlockHitResult hit,
            Hand hand,
            FabricWorldActionAuthorization.BlockAuthorization authorization
        ) {
            BlockHitResult stableHit = Objects.requireNonNull(hit, "hit");
            return new Payload(
                null,
                null,
                null,
                stableHit,
                hand == null ? Hand.MAIN_HAND : hand,
                HeldItemRequirement.emptyMainHand(),
                null,
                authorization,
                List.of(stableHit.getBlockPos().toImmutable()),
                BlockTargetSemantics.USE_LIVE
            );
        }

        static Payload bedUse(
            BlockHitResult hit,
            Hand hand,
            FabricWorldActionAuthorization.BlockAuthorization authorization
        ) {
            BlockHitResult stableHit = Objects.requireNonNull(hit, "hit");
            return new Payload(
                null,
                null,
                null,
                stableHit,
                hand == null ? Hand.MAIN_HAND : hand,
                HeldItemRequirement.emptyMainHand(),
                null,
                authorization,
                List.of(stableHit.getBlockPos().toImmutable()),
                BlockTargetSemantics.BED_USE_LIVE
            );
        }

        static Payload blockPlacement(
            BlockHitResult hit,
            Hand hand,
            FabricWorldActionAuthorization.BlockAuthorization authorization,
            Block expectedBlock,
            List<BlockPos> placedBlockPositions
        ) {
            BlockHitResult stableHit = Objects.requireNonNull(hit, "hit");
            HeldItemRequirement itemRequirement =
                HeldItemRequirement.exactBlockItem(expectedBlock);
            if (placedBlockPositions == null
                || placedBlockPositions.isEmpty()
                || placedBlockPositions.stream().anyMatch(Objects::isNull)) {
                // Empty geometry deliberately reaches the final policy as UNKNOWN and is denied.
                return new Payload(
                    null, null, null, stableHit,
                    hand == null ? Hand.MAIN_HAND : hand,
                    itemRequirement, null, authorization, List.of(),
                    BlockTargetSemantics.PLACEMENT);
            }
            LinkedHashSet<BlockPos> affected = new LinkedHashSet<>();
            affected.add(stableHit.getBlockPos().toImmutable());
            for (BlockPos placedBlockPosition : placedBlockPositions) {
                affected.add(placedBlockPosition.toImmutable());
            }
            return new Payload(
                null,
                null,
                null,
                stableHit,
                hand == null ? Hand.MAIN_HAND : hand,
                itemRequirement,
                null,
                authorization,
                List.copyOf(affected),
                BlockTargetSemantics.PLACEMENT
            );
        }

        static Payload bedPlacement(
            BlockHitResult hit,
            Hand hand,
            FabricWorldActionAuthorization.BlockAuthorization authorization,
            Block expectedBedBlock,
            BlockPos footPosition
        ) {
            BlockHitResult stableHit = Objects.requireNonNull(hit, "hit");
            HeldItemRequirement itemRequirement =
                HeldItemRequirement.exactBlockItem(expectedBedBlock);
            if (footPosition == null) {
                return new Payload(
                    null, null, null, stableHit,
                    hand == null ? Hand.MAIN_HAND : hand,
                    itemRequirement, null, authorization, List.of(),
                    BlockTargetSemantics.BED_PLACEMENT);
            }
            BlockPos stableFoot = footPosition.toImmutable();
            return new Payload(
                stableFoot,
                null,
                null,
                stableHit,
                hand == null ? Hand.MAIN_HAND : hand,
                itemRequirement,
                null,
                authorization,
                List.of(stableHit.getBlockPos().toImmutable(), stableFoot),
                BlockTargetSemantics.BED_PLACEMENT
            );
        }

        static Payload item(Hand hand) {
            return new Payload(
                null,
                null,
                null,
                null,
                hand == null ? Hand.MAIN_HAND : hand,
                HeldItemRequirement.none(),
                null,
                null,
                List.of(),
                BlockTargetSemantics.NONE
            );
        }

        private static List<BlockPos> immutableBlockPositions(List<BlockPos> positions) {
            if (positions == null || positions.isEmpty()) {
                return List.of();
            }
            LinkedHashSet<BlockPos> stable = new LinkedHashSet<>();
            for (BlockPos position : positions) {
                if (position != null) {
                    stable.add(position.toImmutable());
                }
            }
            return List.copyOf(stable);
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

    private enum ContainerAccessKind {
        STORAGE,
        CRAFTING_TABLE,
        FURNACE
    }

    /**
     * Immutable authorization carried from an accepted block-open pulse to every later GUI write.
     * The handler is bound once, after the server opens it, then compared by object identity and
     * sync id on every click. The block footprint is never trusted as a verdict: it is rebuilt from
     * the live world immediately before the physical slot mutation.
     */
    private record ContainerAccessLease(
        String requestId,
        Object worldIdentity,
        Object playerIdentity,
        BlockPos target,
        Block expectedBlock,
        Payload payload,
        List<BlockPos> openedFootprint,
        ContainerAccessKind kind,
        long authorizationEpoch,
        ScreenHandler openingHandlerIdentity,
        int openingSyncId,
        long acceptedAtMs,
        ScreenHandler handlerIdentity,
        int syncId
    ) {
        ContainerAccessLease bind(ScreenHandler handler) {
            return new ContainerAccessLease(
                requestId,
                worldIdentity,
                playerIdentity,
                target,
                expectedBlock,
                payload,
                openedFootprint,
                kind,
                authorizationEpoch,
                openingHandlerIdentity,
                openingSyncId,
                acceptedAtMs,
                handler,
                handler.syncId
            );
        }
    }

    record SlotMutationResult(boolean applied, String reason) {
        SlotMutationResult {
            reason = reason == null || reason.isBlank() ? "slot_mutation_denied" : reason;
        }

        static SlotMutationResult success() {
            return new SlotMutationResult(true, "slot_mutation_applied");
        }

        static SlotMutationResult denial(String reason) {
            return new SlotMutationResult(false, reason);
        }
    }

    private final String instanceId;
    private final Logger logger;
    private final FabricMotionMode mode;
    private final FabricTargetProtection targetProtection;
    private final FabricWorldActionAuthorization worldActionAuthorization =
        new FabricWorldActionAuthorization();
    private ContainerAccessLease containerAccessLease;
    private FabricInteractionController.State legacyState =
        FabricInteractionController.initialState();
    private FabricInteractionController.State smoothState =
        FabricInteractionController.initialState();
    private Object lastWorld;
    private Object authorizationWorld;
    private String lastDimension = "";
    private InteractionDemand lastDemand;
    private boolean itemHoldArmed;
    private Hand itemHoldHand = Hand.MAIN_HAND;
    private boolean syntheticUseKeyPressed;
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

    FabricInteractionAuthority(
        String instanceId,
        Logger logger,
        FabricMotionMode mode,
        FabricTargetProtection targetProtection
    ) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.logger = logger;
        this.mode = mode == null ? FabricMotionMode.LEGACY : mode;
        this.targetProtection = Objects.requireNonNull(
            targetProtection,
            "targetProtection"
        );
    }

    FabricMotionMode mode() {
        return mode;
    }

    /**
     * Bind an explicit world observation to the live client-world object.
     *
     * <p>The object binding prevents an authorization observation from one loaded world being
     * reused after a lifecycle transition. Call this once per client tick before testing fixture
     * command eligibility or committing an interaction.
     */
    FabricWorldActionAuthorization.ObservationResult observeWorldAuthorization(
        MinecraftClient client,
        FabricWorldActionAuthorization.WorldObservation observation
    ) {
        synchronizeAuthorizationWorld(client);
        if (client == null || client.world == null) {
            targetProtection.clearWorldContext();
            return worldActionAuthorization.observeUnavailableWorld();
        }
        FabricWorldActionAuthorization.ObservationResult result =
            worldActionAuthorization.observe(observation);
        targetProtection.observeWorld(client, observation);
        return result;
    }

    boolean fixtureCommandsAllowed() {
        return worldActionAuthorization.fixtureCommandsAllowed()
            && targetProtection.fixtureCommandsAllowedForObservedWorld();
    }

    boolean fixtureCommandsAllowed(MinecraftClient client, MinecraftServer server) {
        if (server == null || server.getPlayerManager() == null) {
            return false;
        }
        return targetProtection.fixtureCommandsAllowed(client)
            && worldActionAuthorization.fixtureCommandsAllowedForPlayerCount(
                server.getPlayerManager().getCurrentPlayerCount()
            );
    }

    boolean disposableWorldTrustRevoked() {
        return worldActionAuthorization.disposableTrustRevoked();
    }

    void observeIntegratedServerLanOpening() {
        worldActionAuthorization.observeIntegratedServerLanOpening();
    }

    /**
     * START-tick bridge for an already-active item use. Vanilla sees a pressed key only while the
     * player is demonstrably using the same hand, so this bridge can continue eating/shield use but
     * can never initiate a crosshair-routed block use. The matching END commit removes the press.
     */
    void prepareItemContinuation(MinecraftClient client) {
        if (!itemHoldArmed) {
            return;
        }
        ClientPlayerEntity player = client == null ? null : client.player;
        if (player == null
            || !player.isUsingItem()
            || player.getActiveHand() != itemHoldHand
            || !hasUseKey(client)) {
            disarmItemHold(client);
            return;
        }
        if (!usePressed(client)) {
            setUsePressed(client, true);
            syntheticUseKeyPressed = true;
        }
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
        clearSyntheticUseKey(client);
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
        synchronizeAuthorizationWorld(client);
        synchronizeAuthoritativePlayerCount(client);
        long commitAuthorizationEpoch = worldActionAuthorization.authorizationEpoch();
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
        boolean cleanupApplied = false;
        if (worldActionAuthorization.consumePhysicalCancellation()) {
            cleanupApplied = releasePhysical(client, true);
        }
        if (appliedOutput.cancelBreakBeforeDispatch()) {
            cleanupApplied |= cancelBreaking(client);
        }

        DispatchResult result = dispatch(
            client,
            player,
            stablePayload,
            appliedOutput,
            nowMs,
            commitAuthorizationEpoch
        );
        rememberAuthorizedContainerOpen(
            client,
            player,
            stableDemand,
            stablePayload,
            result,
            nowMs,
            commitAuthorizationEpoch
        );
        boolean itemHoldEstablished = stableDemand.action() == InteractionDemand.Action.HOLD_ITEM
            && result.applied()
            && player != null
            && player.isUsingItem()
            && player.getActiveHand() == stablePayload.hand();
        if (itemHoldEstablished) {
            itemHoldArmed = true;
            itemHoldHand = stablePayload.hand();
        } else {
            disarmItemHold(client);
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
        authorizationWorld = null;
        containerAccessLease = null;
        targetProtection.clearWorldContext();
        worldActionAuthorization.clear();
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

    /**
     * Bind the server-opened handler at the observed player-handler transition, before any
     * controller is allowed to propose a click. The click sink never gets to nominate its own
     * handler identity. A missing, late, revoked, or wrong-kind transition invalidates the lease.
     */
    void observeContainerScreenTransition(
        MinecraftClient client,
        ClientPlayerEntity player,
        long nowMs
    ) {
        ContainerAccessLease lease = containerAccessLease;
        if (lease == null || lease.handlerIdentity() != null) {
            return;
        }
        synchronizeAuthorizationWorld(client);
        boolean authoritativeDisposableTrust = synchronizeAuthoritativePlayerCount(client);
        if (client == null || client.world == null || player == null || client.player != player
            || !worldAndPlayerIdentityMatches(
                lease.worldIdentity(), client.world, lease.playerIdentity(), player)) {
            denyContainerSlot(player, null, "container_open_world_or_player_changed");
            return;
        }
        if (lease.authorizationEpoch() != worldActionAuthorization.authorizationEpoch()) {
            denyContainerSlot(player, null, "container_open_authorization_epoch_changed");
            return;
        }
        if (nowMs < lease.acceptedAtMs()
            || nowMs - lease.acceptedAtMs() > CONTAINER_OPEN_BIND_TIMEOUT_MS) {
            denyContainerSlot(player, null, "container_open_transition_timeout");
            return;
        }
        ScreenHandler current = player.currentScreenHandler;
        if (!targetProtection.unboundedBlockEffectsAllowed(client)) {
            denyContainerSlot(player, current, "container_open_unbounded_effect_policy_denied");
            return;
        }
        if (current == lease.openingHandlerIdentity()
            && current != null
            && current.syncId == lease.openingSyncId()) {
            return;
        }
        if (!isNewExternalContainerHandler(
            lease.openingHandlerIdentity(),
            lease.openingSyncId(),
            player.playerScreenHandler,
            current,
            current == null ? -1 : current.syncId
        ) || !handlerMatchesContainerKind(current, lease.kind())) {
            denyContainerSlot(player, current, "container_open_handler_transition_mismatch");
            return;
        }
        BlockState currentTarget = client.world.getBlockState(lease.target());
        if (currentTarget == null || currentTarget.getBlock() != lease.expectedBlock()
            || containerAccessKind(currentTarget) != lease.kind()) {
            denyContainerSlot(player, current, "container_open_target_changed");
            return;
        }
        List<BlockPos> currentFootprint = resolveAffectedBlockPositions(client, lease.payload());
        if (currentFootprint.isEmpty()
            || !sameBlockFootprint(currentFootprint, lease.openedFootprint())) {
            denyContainerSlot(player, current, "container_open_footprint_changed");
            return;
        }
        if (lease.payload().blockAuthorization().capability()
                != FabricWorldActionAuthorization.Capability.OWNED
            && !authoritativeDisposableTrust) {
            denyContainerSlot(player, current, "container_open_disposable_trust_unavailable");
            return;
        }
        FabricTargetProtection.ProtectionState protectionState =
            targetProtection.evaluate(client, currentFootprint);
        FabricWorldActionAuthorization.Decision authorization =
            worldActionAuthorization.preview(
                lease.payload().blockAuthorization(),
                protectionState
            );
        if (!authorization.allowed()) {
            denyContainerSlot(player, current, authorization.reason());
            return;
        }
        if (containerAccessLease != lease || player.currentScreenHandler != current) {
            denyContainerSlot(player, current, "container_open_handler_became_stale");
            return;
        }
        synchronized (worldActionAuthorization) {
            synchronizeAuthoritativePlayerCount(client);
            if (lease.authorizationEpoch() != worldActionAuthorization.authorizationEpoch()) {
                denyContainerSlot(
                    player,
                    current,
                    "container_open_authorization_changed_before_bind"
                );
                return;
            }
            if (containerAccessLease != lease || player.currentScreenHandler != current) {
                denyContainerSlot(player, current, "container_open_changed_at_bind_boundary");
                return;
            }
            containerAccessLease = lease.bind(current);
        }
    }

    /**
     * Sole physical sink for a non-player container or workstation slot mutation.
     *
     * <p>The access request must be the exact accepted block-use request which opened this GUI.
     * Before every click, this method refreshes the authoritative integrated-server player count,
     * verifies the current world/player/handler identities, rebuilds the current block footprint,
     * re-evaluates do-not-touch policy, and re-runs world-action authorization. Any stale or revoked
     * state closes the external screen and fails without sending a slot packet.
     */
    SlotMutationResult clickContainerSlot(
        MinecraftClient client,
        ClientPlayerEntity player,
        String accessRequestId,
        ScreenHandler handler,
        int slot,
        int button,
        SlotActionType action
    ) {
        synchronizeAuthorizationWorld(client);
        boolean authoritativeDisposableTrust = synchronizeAuthoritativePlayerCount(client);
        ContainerAccessLease lease = containerAccessLease;
        if (client == null || client.world == null || client.interactionManager == null
            || player == null || client.player != player
            || handler == null || action == null) {
            return denyContainerSlot(player, handler, "container_slot_context_unavailable");
        }
        if (lease == null || !accessRequestMatches(lease.requestId(), accessRequestId)) {
            return denyContainerSlot(player, handler, "container_slot_open_provenance_missing");
        }
        if (lease.authorizationEpoch() != worldActionAuthorization.authorizationEpoch()) {
            return denyContainerSlot(player, handler, "container_slot_authorization_epoch_changed");
        }
        if (authorizationWorld != client.world || !worldAndPlayerIdentityMatches(
            lease.worldIdentity(), client.world, lease.playerIdentity(), player)) {
            return denyContainerSlot(player, handler, "container_slot_world_or_player_changed");
        }
        if (player.currentScreenHandler != handler || handler == player.playerScreenHandler) {
            return denyContainerSlot(player, handler, "container_slot_handler_not_current");
        }
        if (lease.handlerIdentity() == null) {
            return denyContainerSlot(player, handler, "container_slot_open_handler_unbound");
        }
        if (!handlerMatchesContainerKind(handler, lease.kind())
            || !boundContainerIdentityMatches(
            lease.handlerIdentity(), handler, lease.syncId(), handler.syncId)) {
            return denyContainerSlot(player, handler, "container_slot_handler_identity_changed");
        }
        if (slot < 0 || slot >= handler.slots.size()) {
            return denyContainerSlot(player, handler, "container_slot_index_out_of_range");
        }
        if (!targetProtection.unboundedBlockEffectsAllowed(client)) {
            return denyContainerSlot(
                player,
                handler,
                "container_slot_unbounded_effect_policy_denied"
            );
        }
        BlockState currentTarget = client.world.getBlockState(lease.target());
        if (currentTarget == null || currentTarget.getBlock() != lease.expectedBlock()
            || containerAccessKind(currentTarget) != lease.kind()) {
            return denyContainerSlot(player, handler, "container_slot_target_changed");
        }
        List<BlockPos> currentFootprint = resolveAffectedBlockPositions(client, lease.payload());
        if (currentFootprint.isEmpty() || !sameBlockFootprint(
            currentFootprint,
            lease.openedFootprint()
        )) {
            return denyContainerSlot(player, handler, "container_slot_footprint_changed");
        }
        if (lease.payload().blockAuthorization().capability()
                != FabricWorldActionAuthorization.Capability.OWNED
            && !authoritativeDisposableTrust) {
            return denyContainerSlot(player, handler, "container_slot_disposable_trust_unavailable");
        }
        FabricTargetProtection.ProtectionState protectionState =
            targetProtection.evaluate(client, currentFootprint);
        FabricWorldActionAuthorization.Decision authorization =
            worldActionAuthorization.preview(
                lease.payload().blockAuthorization(),
                protectionState
            );
        if (!authorization.allowed()) {
            return denyContainerSlot(player, handler, authorization.reason());
        }
        // Recheck the mutable handler identity at the last instruction before the packet sink.
        if (player.currentScreenHandler != handler
            || containerAccessLease != lease
            || !boundContainerIdentityMatches(
                lease.handlerIdentity(), handler, lease.syncId(), handler.syncId)) {
            return denyContainerSlot(player, handler, "container_slot_handler_became_stale");
        }
        synchronized (worldActionAuthorization) {
            FabricWorldActionAuthorization.Decision finalAuthorization =
                authorizeContainerSlotAtPhysicalBoundary(client, lease);
            if (!finalAuthorization.allowed()) {
                return denyContainerSlot(player, handler, finalAuthorization.reason());
            }
            if (player.currentScreenHandler != handler
                || containerAccessLease != lease
                || !boundContainerIdentityMatches(
                    lease.handlerIdentity(), handler, lease.syncId(), handler.syncId)) {
                return denyContainerSlot(
                    player,
                    handler,
                    "container_slot_handler_changed_at_physical_boundary"
                );
            }
            client.interactionManager.clickSlot(
                handler.syncId,
                slot,
                button,
                action,
                player
            );
        }
        return SlotMutationResult.success();
    }

    private FabricWorldActionAuthorization.Decision authorizeContainerSlotAtPhysicalBoundary(
        MinecraftClient client,
        ContainerAccessLease lease
    ) {
        if (!Thread.holdsLock(worldActionAuthorization)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "container_slot_final_authorization_lock_unavailable"
            );
        }
        if (client == null || client.world == null || lease == null
            || lease.worldIdentity() != client.world) {
            return FabricWorldActionAuthorization.Decision.deny(
                "container_slot_world_changed_at_physical_boundary"
            );
        }
        if (!targetProtection.unboundedBlockEffectsAllowed(client)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "container_slot_unbounded_effect_policy_denied_at_physical_boundary"
            );
        }
        BlockState currentTarget = client.world.getBlockState(lease.target());
        if (currentTarget == null || currentTarget.getBlock() != lease.expectedBlock()
            || containerAccessKind(currentTarget) != lease.kind()) {
            return FabricWorldActionAuthorization.Decision.deny(
                "container_slot_target_changed_at_physical_boundary"
            );
        }
        List<BlockPos> currentFootprint = resolveAffectedBlockPositions(client, lease.payload());
        if (currentFootprint.isEmpty()
            || !sameBlockFootprint(currentFootprint, lease.openedFootprint())) {
            return FabricWorldActionAuthorization.Decision.deny(
                "container_slot_footprint_changed_at_physical_boundary"
            );
        }
        FabricTargetProtection.ProtectionState protectionState =
            targetProtection.evaluate(client, currentFootprint);
        synchronizeAuthorizationWorld(client);
        boolean authoritativeDisposableTrust = synchronizeAuthoritativePlayerCount(client);
        if (authorizationWorld != client.world) {
            return FabricWorldActionAuthorization.Decision.deny(
                "container_slot_world_changed_at_final_authorization"
            );
        }
        FabricWorldActionAuthorization.Decision decision =
            worldActionAuthorization.authorizeAtEpoch(
                lease.payload().blockAuthorization(),
                protectionState,
                lease.authorizationEpoch()
            );
        if (decision.allowed()
            && requiresDisposableTrust(lease.payload().blockAuthorization())
            && !authoritativeDisposableTrust) {
            return FabricWorldActionAuthorization.Decision.deny(
                "container_slot_authoritative_single_player_unavailable"
            );
        }
        return decision;
    }

    /** Sole sink for sync-id-zero/player-inventory clicks, which never mutate a world anchor. */
    SlotMutationResult clickPlayerInventorySlot(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        int slot,
        int button,
        SlotActionType action
    ) {
        if (client == null || client.world == null || client.interactionManager == null
            || player == null || client.player != player
            || handler == null || action == null
            || handler != player.playerScreenHandler
            || player.currentScreenHandler != handler
            || handler.syncId != player.playerScreenHandler.syncId
            || slot < 0 || slot >= handler.slots.size()) {
            return SlotMutationResult.denial("player_inventory_slot_identity_mismatch");
        }
        client.interactionManager.clickSlot(
            handler.syncId,
            slot,
            button,
            action,
            player
        );
        return SlotMutationResult.success();
    }

    private void rememberAuthorizedContainerOpen(
        MinecraftClient client,
        ClientPlayerEntity player,
        InteractionDemand demand,
        Payload payload,
        DispatchResult result,
        long nowMs,
        long authorizedEpoch
    ) {
        if (demand == null || demand.action() != InteractionDemand.Action.USE_BLOCK) {
            return;
        }
        // Any newer block-use attempt invalidates the preceding open, even when the newer attempt
        // is rejected. Only the most recently accepted block use can own a subsequent GUI.
        containerAccessLease = null;
        if (result == null || !result.applied() || result.actionResult() == null
            || !result.actionResult().isAccepted()) {
            return;
        }
        if (client == null || client.world == null || player == null || payload == null
            || payload.blockHit() == null || demand.requestId() == null
            || demand.requestId().isBlank()
            || client.player != player
            || player.currentScreenHandler != player.playerScreenHandler) {
            return;
        }
        BlockPos target = payload.blockHit().getBlockPos().toImmutable();
        BlockState currentTarget = client.world.getBlockState(target);
        ContainerAccessKind kind = containerAccessKind(currentTarget);
        List<BlockPos> openedFootprint = resolveAffectedBlockPositions(client, payload);
        if (kind == null || currentTarget == null || openedFootprint.isEmpty()) {
            return;
        }
        containerAccessLease = new ContainerAccessLease(
            demand.requestId(),
            client.world,
            player,
            target,
            currentTarget.getBlock(),
            payload,
            List.copyOf(openedFootprint),
            kind,
            authorizedEpoch,
            player.currentScreenHandler,
            player.currentScreenHandler.syncId,
            nowMs,
            null,
            -1
        );
    }

    private SlotMutationResult denyContainerSlot(
        ClientPlayerEntity player,
        ScreenHandler requestedHandler,
        String reason
    ) {
        containerAccessLease = null;
        if (player != null && player.currentScreenHandler != null
            && player.currentScreenHandler != player.playerScreenHandler) {
            player.closeHandledScreen();
        }
        if (logger != null) {
            logger.warn(
                "motion.interaction.container_slot_denied instanceId={} mode={} reason={} handler={} syncId={}",
                instanceId,
                mode.wireName(),
                reason,
                requestedHandler == null
                    ? "none" : requestedHandler.getClass().getSimpleName(),
                requestedHandler == null ? -1 : requestedHandler.syncId
            );
        }
        return SlotMutationResult.denial(reason);
    }

    private static ContainerAccessKind containerAccessKind(BlockState state) {
        if (state == null) {
            return null;
        }
        if (state.isOf(Blocks.CHEST) || state.isOf(Blocks.TRAPPED_CHEST)
            || state.isOf(Blocks.BARREL)) {
            return ContainerAccessKind.STORAGE;
        }
        if (state.isOf(Blocks.CRAFTING_TABLE)) {
            return ContainerAccessKind.CRAFTING_TABLE;
        }
        if (state.isOf(Blocks.FURNACE) || state.isOf(Blocks.BLAST_FURNACE)
            || state.isOf(Blocks.SMOKER)) {
            return ContainerAccessKind.FURNACE;
        }
        return null;
    }

    private static boolean handlerMatchesContainerKind(
        ScreenHandler handler,
        ContainerAccessKind kind
    ) {
        if (handler == null || kind == null) {
            return false;
        }
        return switch (kind) {
            case STORAGE -> handler instanceof GenericContainerScreenHandler;
            case CRAFTING_TABLE -> handler instanceof CraftingScreenHandler;
            case FURNACE -> handler instanceof AbstractFurnaceScreenHandler;
        };
    }

    static boolean accessRequestMatches(String expected, String supplied) {
        return expected != null && supplied != null && !supplied.isBlank()
            && expected.equals(supplied);
    }

    static boolean worldAndPlayerIdentityMatches(
        Object expectedWorld,
        Object currentWorld,
        Object expectedPlayer,
        Object currentPlayer
    ) {
        return expectedWorld != null && expectedWorld == currentWorld
            && expectedPlayer != null && expectedPlayer == currentPlayer;
    }

    static boolean boundContainerIdentityMatches(
        Object expectedHandler,
        Object currentHandler,
        int expectedSyncId,
        int currentSyncId
    ) {
        return expectedHandler != null && expectedHandler == currentHandler
            && expectedSyncId >= 0 && expectedSyncId == currentSyncId;
    }

    static boolean isNewExternalContainerHandler(
        Object openingHandler,
        int openingSyncId,
        Object playerHandler,
        Object currentHandler,
        int currentSyncId
    ) {
        return openingHandler != null
            && openingHandler == playerHandler
            && currentHandler != null
            && currentHandler != openingHandler
            && currentHandler != playerHandler
            && openingSyncId >= 0
            && currentSyncId > 0
            && currentSyncId != openingSyncId;
    }

    static boolean sameBlockFootprint(List<BlockPos> left, List<BlockPos> right) {
        return left != null && right != null
            && left.size() == right.size()
            && new LinkedHashSet<>(left).equals(new LinkedHashSet<>(right));
    }

    private DispatchResult dispatch(
        MinecraftClient client,
        ClientPlayerEntity player,
        Payload payload,
        FabricInteractionController.Output output,
        long nowMs,
        long expectedAuthorizationEpoch
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
                FabricWorldActionAuthorization.Decision authorization;
                synchronized (worldActionAuthorization) {
                    authorization = authorizeBlockPayloadAtPhysicalBoundary(
                        client,
                        player,
                        payload,
                        expectedAuthorizationEpoch
                    );
                    if (authorization.allowed()) {
                        client.interactionManager.updateBlockBreakingProgress(
                            payload.blockPos(),
                            payload.face()
                        );
                    }
                }
                if (!authorization.allowed()) {
                    yield DispatchResult.suppressed(authorization.reason());
                }
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
                FabricWorldActionAuthorization.Decision authorization;
                ActionResult actionResult = null;
                synchronized (worldActionAuthorization) {
                    authorization = authorizeBlockPayloadAtPhysicalBoundary(
                        client,
                        player,
                        payload,
                        expectedAuthorizationEpoch
                    );
                    if (authorization.allowed()) {
                        actionResult = client.interactionManager.interactBlock(
                            player,
                            payload.hand(),
                            payload.blockHit()
                        );
                    }
                }
                if (!authorization.allowed()) {
                    yield DispatchResult.suppressed(authorization.reason());
                }
                player.swingHand(payload.hand());
                yield DispatchResult.applied(actionResult, "block_use:" + actionResult);
            }
            case HOLD_ITEM -> {
                if (client == null || client.interactionManager == null || player == null) {
                    yield DispatchResult.deferred("missing_item_use_context");
                }
                if (player.isUsingItem()) {
                    yield DispatchResult.applied("item_use_held:" + payload.hand());
                }
                // Start the item action through the item-only packet path. Pressing the vanilla
                // use key first would route through the current crosshair and could open/use an
                // unauthorized block before the block authorization sink sees it.
                ActionResult actionResult = client.interactionManager.interactItem(
                    player,
                    payload.hand()
                );
                if (!actionResult.isAccepted()) {
                    yield DispatchResult.deferred("item_use_rejected:" + actionResult);
                }
                yield DispatchResult.applied(actionResult, "item_use:" + actionResult);
            }
        };
    }

    private boolean wouldApply(
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
                && payload.face() != null
                && authorizeBlockPayload(client, player, payload, false).allowed();
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
                && payload.blockHit() != null
                && authorizeBlockPayload(client, player, payload, false).allowed();
            case HOLD_ITEM -> client != null
                && client.interactionManager != null
                && player != null;
        };
    }

    /**
     * Re-resolve do-not-touch state from current live geometry every time the physical sink asks.
     * Payloads carry only immutable positions and a code-owned capability; they never carry a
     * protection verdict that could become stale while a demand is queued.
     */
    private FabricWorldActionAuthorization.Decision authorizeBlockPayload(
        MinecraftClient client,
        ClientPlayerEntity player,
        Payload payload,
        boolean consume
    ) {
        if (!unboundedBlockEffectsAllowed(client, payload)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "world_action_denied:unbounded_block_effect_with_protected_regions"
            );
        }
        if (!bedUseDimensionSafe(client, payload)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "world_action_denied:bed_use_outside_overworld"
            );
        }
        if (!heldItemRequirementMatches(player, payload)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "block_hand_requirement_mismatch"
            );
        }
        List<BlockPos> affectedPositions = resolveAffectedBlockPositions(client, payload);
        FabricTargetProtection.ProtectionState protectionState =
            targetProtection.evaluate(client, affectedPositions);
        return consume
            ? worldActionAuthorization.authorize(
                payload.blockAuthorization(),
                protectionState
            )
            : worldActionAuthorization.preview(
                payload.blockAuthorization(),
                protectionState
            );
    }

    /**
     * Last authorization gate for client packet-emission sinks.
     *
     * <p>The commit-level observation is deliberately not trusted here: an integrated-server
     * player may have joined while the controller computed its output. Rebuild live geometry and
     * protection, refresh the authoritative player count, and consume the capability only if the
     * trust epoch still matches the commit snapshot. Callers invoke the raw interaction-manager
     * sink immediately after this method returns an allow decision.
     */
    private FabricWorldActionAuthorization.Decision authorizeBlockPayloadAtPhysicalBoundary(
        MinecraftClient client,
        ClientPlayerEntity player,
        Payload payload,
        long expectedAuthorizationEpoch
    ) {
        if (!Thread.holdsLock(worldActionAuthorization)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "world_action_denied:final_authorization_lock_unavailable"
            );
        }
        if (!unboundedBlockEffectsAllowed(client, payload)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "world_action_denied:unbounded_block_effect_with_protected_regions"
            );
        }
        if (!bedUseDimensionSafe(client, payload)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "world_action_denied:bed_use_outside_overworld"
            );
        }
        if (!heldItemRequirementMatches(player, payload)) {
            return FabricWorldActionAuthorization.Decision.deny(
                "block_hand_requirement_mismatch"
            );
        }
        List<BlockPos> affectedPositions = resolveAffectedBlockPositions(client, payload);
        FabricTargetProtection.ProtectionState protectionState =
            targetProtection.evaluate(client, affectedPositions);
        synchronizeAuthorizationWorld(client);
        boolean authoritativeDisposableTrust = synchronizeAuthoritativePlayerCount(client);
        FabricWorldActionAuthorization.Decision decision =
            worldActionAuthorization.authorizeAtEpoch(
                payload.blockAuthorization(),
                protectionState,
                expectedAuthorizationEpoch
            );
        if (decision.allowed()
            && requiresDisposableTrust(payload.blockAuthorization())
            && !authoritativeDisposableTrust) {
            return FabricWorldActionAuthorization.Decision.deny(
                "world_action_denied:authoritative_single_player_unavailable"
            );
        }
        return decision;
    }

    private boolean unboundedBlockEffectsAllowed(
        MinecraftClient client,
        Payload payload
    ) {
        return payload != null
            && payload.blockTargetSemantics() != BlockTargetSemantics.NONE
            && targetProtection.unboundedBlockEffectsAllowed(client);
    }

    private static boolean bedUseDimensionSafe(
        MinecraftClient client,
        Payload payload
    ) {
        if (payload == null
            || payload.blockTargetSemantics() != BlockTargetSemantics.BED_USE_LIVE) {
            return true;
        }
        if (client == null || client.world == null) {
            return false;
        }
        try {
            return "minecraft:overworld".equals(
                client.world.getRegistryKey().getValue().toString()
            );
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private static boolean requiresDisposableTrust(
        FabricWorldActionAuthorization.BlockAuthorization authorization
    ) {
        if (authorization == null) {
            return false;
        }
        return authorization.capability()
            == FabricWorldActionAuthorization.Capability.NATURAL_RESOURCE
            || authorization.capability()
            == FabricWorldActionAuthorization.Capability.NATURAL_ANCHOR;
    }

    private static boolean heldItemRequirementMatches(
        ClientPlayerEntity player,
        Payload payload
    ) {
        if (payload == null || payload.heldItemRequirement() == null) {
            return false;
        }
        HeldItemRequirement requirement = payload.heldItemRequirement();
        if (requirement.mode() == HeldItemMode.NONE) {
            return true;
        }
        if (player == null || payload.hand() == null) {
            return false;
        }
        return requirement.matches(payload.hand(), player.getStackInHand(payload.hand()));
    }

    private static List<BlockPos> resolveAffectedBlockPositions(
        MinecraftClient client,
        Payload payload
    ) {
        if (client == null || client.world == null || payload == null) {
            return List.of();
        }
        return switch (payload.blockTargetSemantics()) {
            case BREAK_LIVE -> resolveBreakFootprint(
                payload.blockPos(),
                client.world::getBlockState
            );
            case USE_LIVE, BED_USE_LIVE -> resolveUseFootprint(
                payload.blockHit() == null ? null : payload.blockHit().getBlockPos(),
                payload.blockTargetSemantics(),
                client.world::getBlockState
            );
            case BED_PLACEMENT -> resolvePlacementFootprint(
                conservativeLiveBedPlacementFootprint(
                    payload.blockHit(),
                    payload.blockPos()
                ),
                client.world::getBlockState
            );
            case PLACEMENT -> resolvePlacementFootprint(
                conservativeLivePlacementFootprint(
                    payload.blockHit(),
                    payload.affectedBlockPositions()
                ),
                client.world::getBlockState
            );
            case NONE -> List.of();
        };
    }

    /**
     * A placement can displace a replaceable half while vanilla removes its paired cell. Rebuild
     * every declared support/destination cell from live state and include any strict bed,
     * double-block, or double-chest counterpart before protection is evaluated. The use footprint
     * matters because a non-sneaking placement gesture can open an interactive support instead.
     * One malformed cell invalidates the whole footprint.
     */
    static List<BlockPos> resolvePlacementFootprint(
        List<BlockPos> declaredPositions,
        Function<BlockPos, BlockState> stateLookup
    ) {
        if (declaredPositions == null || declaredPositions.isEmpty() || stateLookup == null) {
            return List.of();
        }
        LinkedHashSet<BlockPos> affected = new LinkedHashSet<>();
        for (BlockPos declaredPosition : declaredPositions) {
            List<BlockPos> breakFootprint = resolveBreakFootprint(declaredPosition, stateLookup);
            List<BlockPos> useFootprint = resolveUseFootprint(
                declaredPosition,
                BlockTargetSemantics.USE_LIVE,
                stateLookup
            );
            if (breakFootprint.isEmpty() || useFootprint.isEmpty()) {
                return List.of();
            }
            affected.addAll(breakFootprint);
            affected.addAll(useFootprint);
        }
        return List.copyOf(affected);
    }

    /**
     * Build a current-world break footprint, including both halves of beds, double chests, and
     * every dry vanilla block whose current state exposes the shared double-block-half property
     * (plants, doors, and future blocks using the same state contract). Fluid-bearing states fail
     * closed before pair expansion because breaking them can release flow outside this footprint.
     */
    static List<BlockPos> resolveBreakFootprint(
        BlockPos target,
        Function<BlockPos, BlockState> stateLookup
    ) {
        if (target == null || stateLookup == null) {
            return List.of();
        }
        BlockPos stableTarget = target.toImmutable();
        try {
            BlockState state = stateLookup.apply(stableTarget);
            if (state == null) {
                return List.of();
            }
            if (state.isOf(Blocks.ICE)
                || state.isOf(Blocks.FROSTED_ICE)
                || !state.getFluidState().isEmpty()
                || (state.contains(Properties.WATERLOGGED)
                    && Boolean.TRUE.equals(state.get(Properties.WATERLOGGED)))) {
                // Breaking these states can create or release a fluid source
                // whose flow footprint extends beyond the authorized cell.
                return List.of();
            }
            if (state.getBlock() instanceof BedBlock) {
                return resolveBedUseFootprint(stableTarget, state, stateLookup);
            }
            if (state.getBlock() instanceof ChestBlock) {
                return resolveChestUseFootprint(stableTarget, state, stateLookup);
            }
            if (!state.contains(Properties.DOUBLE_BLOCK_HALF)) {
                return List.of(stableTarget);
            }
            DoubleBlockHalf half = state.get(Properties.DOUBLE_BLOCK_HALF);
            if (half == null) {
                return List.of();
            }
            BlockPos counterpart = (half == DoubleBlockHalf.LOWER
                ? stableTarget.up()
                : stableTarget.down()).toImmutable();
            BlockState counterpartState = stateLookup.apply(counterpart);
            DoubleBlockHalf expected = half == DoubleBlockHalf.LOWER
                ? DoubleBlockHalf.UPPER
                : DoubleBlockHalf.LOWER;
            if (counterpartState == null
                || counterpartState.getBlock() != state.getBlock()
                || !counterpartState.contains(Properties.DOUBLE_BLOCK_HALF)
                || counterpartState.get(Properties.DOUBLE_BLOCK_HALF) != expected) {
                return List.of();
            }
            return List.of(stableTarget, counterpart);
        } catch (RuntimeException unreadable) {
            return List.of();
        }
    }

    /**
     * Rebuild a block-use footprint from the current state. Beds and double chests are one logical
     * action over two physical cells; malformed or unreadable pair state is deliberately unknown.
     */
    static List<BlockPos> resolveUseFootprint(
        BlockPos target,
        BlockTargetSemantics semantics,
        Function<BlockPos, BlockState> stateLookup
    ) {
        if (target == null || stateLookup == null
            || (semantics != BlockTargetSemantics.USE_LIVE
                && semantics != BlockTargetSemantics.BED_USE_LIVE)) {
            return List.of();
        }
        BlockPos stableTarget = target.toImmutable();
        try {
            BlockState state = stateLookup.apply(stableTarget);
            if (state == null) {
                return List.of();
            }
            if (state.getBlock() instanceof BedBlock) {
                return resolveBedUseFootprint(stableTarget, state, stateLookup);
            }
            if (semantics == BlockTargetSemantics.BED_USE_LIVE) {
                return List.of();
            }
            if (state.getBlock() instanceof ChestBlock) {
                return resolveChestUseFootprint(stableTarget, state, stateLookup);
            }
            if (state.contains(Properties.DOUBLE_BLOCK_HALF)) {
                return resolveBreakFootprint(stableTarget, stateLookup);
            }
            return List.of(stableTarget);
        } catch (RuntimeException unreadable) {
            return List.of();
        }
    }

    private static List<BlockPos> resolveBedUseFootprint(
        BlockPos target,
        BlockState state,
        Function<BlockPos, BlockState> stateLookup
    ) {
        if (!state.contains(BedBlock.PART) || !state.contains(BedBlock.FACING)) {
            return List.of();
        }
        BedPart part = state.get(BedBlock.PART);
        Direction facing = state.get(BedBlock.FACING);
        if (part == null || facing == null || facing.getAxis() == Direction.Axis.Y) {
            return List.of();
        }
        BlockPos counterpart = target.offset(
            part == BedPart.FOOT ? facing : facing.getOpposite()
        ).toImmutable();
        BlockState counterpartState = stateLookup.apply(counterpart);
        BedPart expectedPart = part == BedPart.FOOT ? BedPart.HEAD : BedPart.FOOT;
        if (counterpartState == null
            || counterpartState.getBlock() != state.getBlock()
            || !counterpartState.contains(BedBlock.PART)
            || !counterpartState.contains(BedBlock.FACING)
            || counterpartState.get(BedBlock.PART) != expectedPart
            || counterpartState.get(BedBlock.FACING) != facing) {
            return List.of();
        }
        return List.of(target, counterpart);
    }

    private static List<BlockPos> resolveChestUseFootprint(
        BlockPos target,
        BlockState state,
        Function<BlockPos, BlockState> stateLookup
    ) {
        if (!state.contains(ChestBlock.CHEST_TYPE) || !state.contains(ChestBlock.FACING)) {
            return List.of();
        }
        ChestType type = state.get(ChestBlock.CHEST_TYPE);
        Direction facing = state.get(ChestBlock.FACING);
        if (type == null || facing == null || facing.getAxis() == Direction.Axis.Y) {
            return List.of();
        }
        if (type == ChestType.SINGLE) {
            return List.of(target);
        }
        Direction attachment = type == ChestType.LEFT
            ? facing.rotateYClockwise()
            : facing.rotateYCounterclockwise();
        BlockPos counterpart = target.offset(attachment).toImmutable();
        BlockState counterpartState = stateLookup.apply(counterpart);
        ChestType expectedType = type == ChestType.LEFT ? ChestType.RIGHT : ChestType.LEFT;
        if (counterpartState == null
            || counterpartState.getBlock() != state.getBlock()
            || !counterpartState.contains(ChestBlock.CHEST_TYPE)
            || !counterpartState.contains(ChestBlock.FACING)
            || counterpartState.get(ChestBlock.CHEST_TYPE) != expectedType
            || counterpartState.get(ChestBlock.FACING) != facing) {
            return List.of();
        }
        Direction reciprocal = expectedType == ChestType.LEFT
            ? facing.rotateYClockwise()
            : facing.rotateYCounterclockwise();
        if (!counterpart.offset(reciprocal).equals(target)) {
            return List.of();
        }
        return List.of(target, counterpart);
    }

    /**
     * The immutable hit can target either its own cell or its hit-side neighbor depending on the
     * live replaceability state when vanilla consumes the interaction. Always authorize both, plus
     * the controller's planned cells, so queued state changes cannot redirect placement into an
     * undeclared cell.
     */
    static List<BlockPos> conservativeLivePlacementFootprint(
        BlockHitResult clickedHit,
        List<BlockPos> plannedPositions
    ) {
        if (clickedHit == null || clickedHit.getSide() == null
            || plannedPositions == null || plannedPositions.isEmpty()
            || plannedPositions.stream().anyMatch(Objects::isNull)) {
            return List.of();
        }
        BlockPos clicked = clickedHit.getBlockPos().toImmutable();
        LinkedHashSet<BlockPos> affected = new LinkedHashSet<>();
        for (BlockPos plannedPosition : plannedPositions) {
            affected.add(plannedPosition.toImmutable());
        }
        affected.add(clicked);
        affected.add(clicked.offset(clickedHit.getSide()).toImmutable());
        return List.copyOf(affected);
    }

    /** Expand every possible live bed foot into all four vanilla head orientations. */
    static List<BlockPos> conservativeLiveBedPlacementFootprint(
        BlockHitResult clickedHit,
        BlockPos plannedFoot
    ) {
        if (clickedHit == null || clickedHit.getSide() == null || plannedFoot == null) {
            return List.of();
        }
        BlockPos clicked = clickedHit.getBlockPos().toImmutable();
        BlockPos hitSideNeighbor = clicked.offset(clickedHit.getSide()).toImmutable();
        BlockPos stablePlannedFoot = plannedFoot.toImmutable();
        if (!stablePlannedFoot.equals(clicked) && !stablePlannedFoot.equals(hitSideNeighbor)) {
            return List.of();
        }
        LinkedHashSet<BlockPos> footCandidates = new LinkedHashSet<>();
        footCandidates.add(stablePlannedFoot);
        footCandidates.add(clicked);
        footCandidates.add(hitSideNeighbor);

        LinkedHashSet<BlockPos> affected = new LinkedHashSet<>();
        for (BlockPos footCandidate : footCandidates) {
            affected.addAll(conservativeBedPlacementFootprint(clicked, footCandidate));
        }
        return List.copyOf(affected);
    }

    /**
     * Bed placement direction is chosen by vanilla at interaction time. Check the support, foot,
     * and every cardinal head candidate so a queued planner orientation cannot narrow the policy.
     */
    static List<BlockPos> conservativeBedPlacementFootprint(
        BlockPos clickedSupport,
        BlockPos footPosition
    ) {
        if (clickedSupport == null || footPosition == null) {
            return List.of();
        }
        BlockPos support = clickedSupport.toImmutable();
        BlockPos foot = footPosition.toImmutable();
        LinkedHashSet<BlockPos> affected = new LinkedHashSet<>();
        affected.add(support);
        affected.add(foot);
        affected.add(foot.north().toImmutable());
        affected.add(foot.south().toImmutable());
        affected.add(foot.east().toImmutable());
        affected.add(foot.west().toImmutable());
        return List.copyOf(affected);
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

    private void synchronizeAuthorizationWorld(MinecraftClient client) {
        Object currentWorld = client == null ? null : client.world;
        if (authorizationWorld != currentWorld) {
            authorizationWorld = currentWorld;
        }
    }

    private boolean synchronizeAuthoritativePlayerCount(MinecraftClient client) {
        MinecraftServer server = client == null ? null : client.getServer();
        if (client != null
            && client.isIntegratedServerRunning()
            && server != null
            && server.getPlayerManager() != null) {
            return worldActionAuthorization.observeAuthoritativePlayerCount(
                server.getPlayerManager().getCurrentPlayerCount()
            );
        }
        return false;
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

    private boolean releasePhysical(MinecraftClient client, boolean cancelBreak) {
        boolean released = false;
        if (syntheticUseKeyPressed || itemHoldArmed) {
            released |= syntheticUseKeyPressed;
            disarmItemHold(client);
        }
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

    private void clearSyntheticUseKey(MinecraftClient client) {
        if (!syntheticUseKeyPressed) {
            return;
        }
        setUsePressed(client, false);
        syntheticUseKeyPressed = false;
    }

    private void disarmItemHold(MinecraftClient client) {
        clearSyntheticUseKey(client);
        itemHoldArmed = false;
        itemHoldHand = Hand.MAIN_HAND;
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
