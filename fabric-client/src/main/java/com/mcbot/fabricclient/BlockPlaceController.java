package com.mcbot.fabricclient;

import java.util.Objects;
import net.minecraft.block.BlockState;
import net.minecraft.block.Block;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

final class BlockPlaceController {
    private static final double MAX_REACH_BLOCKS = 4.8D;
    private static final long DEFAULT_TIMEOUT_MS = 8_000L;
    // If a placement interact does not verify within this window, re-attempt it (re-raycast + re-interact) rather
    // than waiting out DEFAULT_TIMEOUT_MS on a single missed shot. The one-shot interact occasionally misses when
    // the look has not fully settled on the support face, or on a client/server sync hiccup -- which otherwise
    // timed out the whole placement (the observed R5 place_table flake from an off-center return stance).
    private static final long PLACE_VERIFY_RETRY_MS = 600L;

    private String activeCommandId = "";
    private long startedAtMs = 0L;
    private boolean interacted = false;
    private long interactedAtMs = 0L;
    private BlockPos expectedPlacedPos = null;
    private int interactionAttempt = 0;
    private String pendingRequestId = "";
    private InteractionDemand pendingDemand = null;
    private FabricInteractionAuthority.Payload pendingPayload = null;
    private BlockPos pendingExpectedPlacedPos = null;
    private String appliedRequestId = "";
    private String verifiedRequestId = "";
    private PlaceSpec activeSpec = PlaceSpec.craftingTable();
    private FaceConstraint activeFaceConstraint = null;

    enum Status {
        RUNNING,
        PLACED,
        FAILED
    }

    record Result(
        Status status,
        String reason,
        long elapsedMs,
        BlockPos hitBlock,
        Direction hitSide,
        BlockPos placedBlock,
        int selectedHotbarSlot,
        boolean sneakRequired,
        InteractionDemand interactionDemand,
        FabricInteractionAuthority.Payload interactionPayload
    ) {
        Result(Status status, String reason, long elapsedMs) {
            this(status, reason, elapsedMs, null, null, null, -1, false, null, null);
        }

        Result(
            Status status,
            String reason,
            long elapsedMs,
            BlockPos hitBlock,
            Direction hitSide,
            BlockPos placedBlock,
            int selectedHotbarSlot,
            boolean sneakRequired
        ) {
            this(
                status,
                reason,
                elapsedMs,
                hitBlock,
                hitSide,
                placedBlock,
                selectedHotbarSlot,
                sneakRequired,
                null,
                null
            );
        }
    }

    record PlaceSpec(
        String action,
        String itemId,
        Block block,
        boolean sneakWhenAdjacentInteractive,
        boolean waitWhenPlacementCellOccupiedByPlayer
    ) {
        static PlaceSpec craftingTable() {
            return new PlaceSpec("place_table", "crafting_table", Blocks.CRAFTING_TABLE, false, false);
        }

        static PlaceSpec furnace() {
            return new PlaceSpec("place_furnace", "furnace", Blocks.FURNACE, true, false);
        }

        // Plain filler block for bridging a missing descent support (a cave/gap floor). Not an
        // interactive block, so no sneak is required when placing adjacent to one.
        static PlaceSpec cobblestone() {
            return new PlaceSpec("place_support", "cobblestone", Blocks.COBBLESTONE, false, true);
        }

        static PlaceSpec supportBlock(String itemId, Block block) {
            return new PlaceSpec("place_support", itemId, block, false, true);
        }

        String timeoutReason() {
            return action + "_timeout";
        }
    }

    record FaceConstraint(
        BlockPos expectedHitBlock,
        Direction expectedHitSide,
        BlockPos expectedPlacePos
    ) {
        FaceConstraint {
            if (expectedHitBlock == null
                || expectedHitSide == null
                || expectedPlacePos == null
                || !expectedHitSide.getAxis().isHorizontal()
                || !expectedHitBlock.offset(expectedHitSide).equals(expectedPlacePos)) {
                throw new IllegalArgumentException("face constraint must describe one horizontal placement");
            }
            expectedHitBlock = expectedHitBlock.toImmutable();
            expectedPlacePos = expectedPlacePos.toImmutable();
        }

        boolean matches(BlockPos hitBlock, Direction hitSide, BlockPos placePos) {
            return expectedHitBlock.equals(hitBlock)
                && expectedHitSide == hitSide
                && expectedPlacePos.equals(placePos);
        }
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, String commandId, long nowMs) {
        return tick(client, player, commandId, nowMs, null);
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, String commandId, long nowMs, BlockPos supportOverride) {
        return tick(client, player, commandId, nowMs, supportOverride, PlaceSpec.craftingTable());
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, String commandId, long nowMs, BlockPos supportOverride, PlaceSpec spec) {
        return tick(client, player, commandId, nowMs, supportOverride, spec, null);
    }

    Result tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        String commandId,
        long nowMs,
        BlockPos supportOverride,
        PlaceSpec spec,
        FaceConstraint faceConstraint
    ) {
        if (client == null || player == null || client.world == null || client.interactionManager == null) {
            return new Result(Status.FAILED, "missing_client_state", 0L);
        }
        PlaceSpec effectiveSpec = spec == null ? PlaceSpec.craftingTable() : spec;
        if (!safeEquals(commandId, activeCommandId)
            || !effectiveSpec.equals(activeSpec)
            || !Objects.equals(faceConstraint, activeFaceConstraint)) {
            activeCommandId = commandId == null ? "" : commandId;
            activeSpec = effectiveSpec;
            activeFaceConstraint = faceConstraint;
            startedAtMs = nowMs;
            interacted = false;
            interactedAtMs = 0L;
            expectedPlacedPos = null;
            interactionAttempt = 0;
            clearPendingRequest();
            appliedRequestId = "";
        }

        long elapsedMs = Math.max(0L, nowMs - startedAtMs);
        if (expectedPlacedPos != null && client.world.getBlockState(expectedPlacedPos).isOf(activeSpec.block())) {
            BlockPos placed = expectedPlacedPos;
            verifiedRequestId = appliedRequestId;
            reset();
            return new Result(Status.PLACED, "placement_verified", elapsedMs, null, null, placed, selectedHotbarSlot(player), false);
        }
        if (elapsedMs > DEFAULT_TIMEOUT_MS) {
            BlockPos placed = expectedPlacedPos;
            String timeoutReason = activeSpec.timeoutReason();
            reset();
            return new Result(Status.FAILED, timeoutReason, elapsedMs, null, null, placed, selectedHotbarSlot(player), false);
        }

        if (pendingDemand != null) {
            return new Result(
                Status.RUNNING,
                "waiting_for_place_receipt",
                elapsedMs,
                pendingPayload == null || pendingPayload.blockHit() == null
                    ? null
                    : pendingPayload.blockHit().getBlockPos().toImmutable(),
                pendingPayload == null || pendingPayload.blockHit() == null
                    ? null
                    : pendingPayload.blockHit().getSide(),
                pendingExpectedPlacedPos,
                selectedHotbarSlot(player),
                false,
                pendingDemand,
                pendingPayload
            );
        }

        if (interacted) {
            if (nowMs - interactedAtMs < PLACE_VERIFY_RETRY_MS) {
                return new Result(Status.RUNNING, "waiting_for_place_verify", elapsedMs, null, null, expectedPlacedPos, selectedHotbarSlot(player), false);
            }
            // Verify did not land within the retry window -> the single interact missed (look not fully settled on
            // the support face, or a client/server sync hiccup). Clear the interacted state so the placement is
            // re-raycast + re-issued below instead of burning the whole timeout on one missed shot. If the block
            // HAD appeared, the verify check above returns PLACED first, so this never double-places.
            interacted = false;
            expectedPlacedPos = null;
            appliedRequestId = "";
        }

        int blockSlot = findHotbarSlot(player, activeSpec.itemId());
        if (blockSlot < 0) {
            String missingItemId = activeSpec.itemId();
            reset();
            return new Result(Status.FAILED, missingItemId + "_not_in_hotbar", elapsedMs);
        }
        player.getInventory().selectedSlot = blockSlot;

        BlockHitResult hit = raycast(player, client);
        boolean blockHit = hit != null && hit.getType() == HitResult.Type.BLOCK;
        BlockPos hitBlock = blockHit ? hit.getBlockPos().toImmutable() : null;
        Direction hitSide = blockHit ? hit.getSide() : null;
        BlockState hitState = hitBlock == null ? null : client.world.getBlockState(hitBlock);
        boolean replaceableHit = isReplaceablePlacementOccluder(hitState);
        BlockPos placePos = blockHit ? (replaceableHit ? hitBlock : hitBlock.offset(hitSide)).toImmutable() : null;
        if (supportOverride != null && !supportOverride.up().equals(placePos)) {
            Vec3d supportTop = new Vec3d(
                supportOverride.getX() + 0.5D,
                supportOverride.getY() + 1.0D,
                supportOverride.getZ() + 0.5D
            );
            BlockState supportState = client.world.getBlockState(supportOverride);
            BlockPos forcedPlacePos = supportOverride.up().toImmutable();
            BlockState forcedPlaceState = client.world.getBlockState(forcedPlacePos);
            boolean forcedPlaceOpen = forcedPlaceState != null
                && (forcedPlaceState.isAir() || isReplaceablePlacementOccluder(forcedPlaceState));
            boolean forcedPlaceClearOfPlayer = !new Box(forcedPlacePos).intersects(player.getBoundingBox());
            boolean canUseForcedSupportHit = withinReach(player, supportTop)
                && supportState != null
                && !supportState.getCollisionShape(client.world, supportOverride).isEmpty()
                && forcedPlaceOpen
                && (forcedPlaceClearOfPlayer || activeSpec.waitWhenPlacementCellOccupiedByPlayer());
            if (canUseForcedSupportHit) {
                hit = new BlockHitResult(supportTop, Direction.UP, supportOverride.toImmutable(), false);
                blockHit = true;
                hitBlock = supportOverride.toImmutable();
                hitSide = Direction.UP;
                hitState = supportState;
                replaceableHit = false;
                placePos = forcedPlacePos;
            }
        }
        if (supportOverride != null && blockHit && !supportOverride.up().equals(placePos)) {
            return new Result(Status.RUNNING, "raycast_waiting_for_expected_support", elapsedMs, hitBlock, hitSide, supportOverride.up(), blockSlot, false);
        }
        if (activeFaceConstraint != null
            && !activeFaceConstraint.matches(hitBlock, hitSide, placePos)) {
            return new Result(
                Status.RUNNING,
                "raycast_waiting_for_expected_face",
                elapsedMs,
                hitBlock,
                hitSide,
                activeFaceConstraint.expectedPlacePos(),
                blockSlot,
                false
            );
        }
        boolean withinReach = blockHit && withinReach(player, hit.getPos());
        BlockState placeState = placePos == null ? null : client.world.getBlockState(placePos);
        boolean placementCellReplaceable = placeState != null && isReplaceablePlacementOccluder(placeState);
        // A FLUID cell is directly placeable-into (vanilla replace-on-place) — it counts as OPEN
        // like air, NOT as a replaceable occluder, which the planner would route to the
        // clear-the-occluder-first flow (right for grass, impossible for water). The
        // isReplaceable() guard keeps waterlogged solids excluded. Latent since the June descent
        // waterSeal — its live path never met a real water cell; found by the fluid-breach seal.
        boolean placementCellFluid = placeState != null
            && !placeState.getFluidState().isEmpty()
            && placeState.isReplaceable();
        boolean placementCellOpen = placeState != null
            && (placeState.isAir() || placementCellReplaceable || placementCellFluid);
        boolean placementCellClearOfPlayer = placePos != null && !new Box(placePos).intersects(player.getBoundingBox());
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(
            blockHit,
            withinReach,
            hitSide,
            replaceableHit,
            placementCellOpen,
            placementCellReplaceable,
            placementCellClearOfPlayer,
            activeFaceConstraint == null
                ? null
                : activeFaceConstraint.expectedHitSide()
        );
        if (decision.action() == BlockPlacementPlanner.Action.WAIT) {
            return new Result(Status.RUNNING, decision.reason(), elapsedMs, hitBlock, hitSide, placePos, blockSlot, false);
        }
        if (
            decision.action() != BlockPlacementPlanner.Action.PLACE_AGAINST_FACE
                && activeSpec.waitWhenPlacementCellOccupiedByPlayer()
                && "placement_cell_occupied_by_player".equals(decision.reason())
        ) {
            return new Result(Status.RUNNING, decision.reason(), elapsedMs, hitBlock, hitSide, placePos, blockSlot, false);
        }
        if (decision.action() != BlockPlacementPlanner.Action.PLACE_AGAINST_FACE) {
            reset();
            return new Result(Status.FAILED, decision.reason(), elapsedMs, hitBlock, hitSide, placePos, blockSlot, false);
        }

        boolean sneakRequired = activeSpec.sneakWhenAdjacentInteractive()
            && BlockPlacementPlanner.requiresSneakForInteractiveAdjacency(
                isInteractiveBlock(hitState),
                isAdjacentToInteractiveBlock(client, placePos)
            );
        if (sneakRequired && !player.input.sneaking) {
            return new Result(Status.RUNNING, "prepare_sneak_interactive_adjacent", elapsedMs, hitBlock, hitSide, placePos, blockSlot, true);
        }

        interactionAttempt++;
        pendingRequestId = placementRequestId(
            activeCommandId,
            activeSpec,
            interactionAttempt,
            hitBlock,
            hitSide,
            placePos
        );
        pendingDemand = InteractionDemand.useBlock(
            pendingRequestId,
            LookDemand.Owner.NORMAL,
            activeCommandId,
            activeSpec.action(),
            blockIdentity(placePos),
            faceIdentity(hitBlock, hitSide),
            activeSpec.action() + "_interact_requested"
        );
        pendingPayload = FabricInteractionAuthority.Payload.blockUse(hit, Hand.MAIN_HAND);
        pendingExpectedPlacedPos = placePos.toImmutable();
        return new Result(
            Status.RUNNING,
            "interact_block_requested",
            elapsedMs,
            hitBlock,
            hitSide,
            placePos,
            blockSlot,
            sneakRequired,
            pendingDemand,
            pendingPayload
        );
    }

    /**
     * Acknowledge the final post-gaze authority receipt. Placement verification time starts only
     * after the matching physical USE_BLOCK dispatch was applied.
     */
    boolean acceptReceipt(InteractionAppliedReceipt receipt) {
        if (pendingDemand == null || !matchesAppliedReceipt(pendingRequestId, receipt)) {
            return false;
        }
        interacted = true;
        interactedAtMs = receipt.timestampMs();
        expectedPlacedPos = pendingExpectedPlacedPos;
        appliedRequestId = pendingRequestId;
        clearPendingRequest();
        return true;
    }

    /** Returns one authority request whose placement was verified from world state. */
    String consumeVerifiedRequestId() {
        String requestId = verifiedRequestId;
        verifiedRequestId = "";
        return requestId;
    }

    static boolean matchesAppliedReceipt(String pendingRequestId, InteractionAppliedReceipt receipt) {
        return pendingRequestId != null
            && !pendingRequestId.isBlank()
            && receipt != null
            && pendingRequestId.equals(receipt.requestId())
            && receipt.action() == InteractionDemand.Action.USE_BLOCK
            && receipt.applied();
    }

    void reset() {
        activeCommandId = "";
        startedAtMs = 0L;
        interacted = false;
        interactedAtMs = 0L;
        expectedPlacedPos = null;
        interactionAttempt = 0;
        clearPendingRequest();
        appliedRequestId = "";
        activeSpec = PlaceSpec.craftingTable();
        activeFaceConstraint = null;
    }

    boolean isAwaitingVerification(String commandId) {
        return safeEquals(commandId, activeCommandId)
            && ((interacted && expectedPlacedPos != null) || pendingDemand != null);
    }

    private void clearPendingRequest() {
        pendingRequestId = "";
        pendingDemand = null;
        pendingPayload = null;
        pendingExpectedPlacedPos = null;
    }

    private static String placementRequestId(
        String commandId,
        PlaceSpec spec,
        int attempt,
        BlockPos hitBlock,
        Direction hitSide,
        BlockPos placePos
    ) {
        return "place:"
            + stableId(commandId) + ":"
            + spec.action() + ":"
            + attempt + ":"
            + blockIdentity(placePos) + ":"
            + faceIdentity(hitBlock, hitSide);
    }

    private static String faceIdentity(BlockPos hitBlock, Direction hitSide) {
        return blockIdentity(hitBlock) + ":" + (hitSide == null ? "unknown" : hitSide.asString());
    }

    private static String blockIdentity(BlockPos pos) {
        return pos == null ? "unknown" : pos.getX() + "," + pos.getY() + "," + pos.getZ();
    }

    private static String stableId(String value) {
        return value == null || value.isBlank() ? "uncommanded" : value;
    }

    private static BlockHitResult raycast(ClientPlayerEntity player, MinecraftClient client) {
        double reach = Math.min(MAX_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        Vec3d eye = player.getEyePos();
        Vec3d end = eye.add(player.getRotationVec(1.0F).multiply(reach));
        return client.world.raycast(new RaycastContext(
            eye,
            end,
            RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE,
            player
        ));
    }

    private static boolean withinReach(ClientPlayerEntity player, Vec3d hitPos) {
        return hitPos != null && player.getEyePos().squaredDistanceTo(hitPos) <= MAX_REACH_BLOCKS * MAX_REACH_BLOCKS;
    }

    private static int findHotbarSlot(ClientPlayerEntity player, String itemId) {
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
            if (itemId.equals(id)) {
                return slot;
            }
        }
        return -1;
    }

    private static boolean isAdjacentToInteractiveBlock(MinecraftClient client, BlockPos pos) {
        if (client == null || client.world == null || pos == null) {
            return false;
        }
        for (Direction direction : Direction.values()) {
            if (isInteractiveBlock(client.world.getBlockState(pos.offset(direction)))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isInteractiveBlock(BlockState state) {
        return state != null && (
            state.isOf(Blocks.CRAFTING_TABLE)
                || state.isOf(Blocks.FURNACE)
                || state.isOf(Blocks.BLAST_FURNACE)
                || state.isOf(Blocks.SMOKER)
                || state.isOf(Blocks.CHEST)
                || state.isOf(Blocks.TRAPPED_CHEST)
                || state.isOf(Blocks.BARREL)
        );
    }

    private static boolean isReplaceablePlacementOccluder(BlockState state) {
        if (state == null || state.isAir()) {
            return false;
        }
        String id = Registries.BLOCK.getId(state.getBlock()).getPath();
        return id.equals("short_grass")
            || id.equals("tall_grass")
            || id.equals("fern")
            || id.equals("large_fern")
            || id.equals("dead_bush")
            || id.equals("vine")
            || id.endsWith("_vine")
            || id.endsWith("_vines");
    }

    private static int selectedHotbarSlot(ClientPlayerEntity player) {
        return player == null ? -1 : player.getInventory().selectedSlot;
    }

    private static boolean safeEquals(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }
}
