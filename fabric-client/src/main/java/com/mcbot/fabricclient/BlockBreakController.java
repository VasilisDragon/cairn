package com.mcbot.fabricclient;

import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

final class BlockBreakController {
    private static final double MAX_REACH_BLOCKS = 4.8D;
    private static final long DEFAULT_TIMEOUT_MS = 12_000L;
    private static final long AIR_CONFIRM_MS = 150L;
    private static final int MAX_OCCLUDERS_PER_TARGET = 8;
    private static final int MAX_OCCLUSION_REPOSITIONS_PER_TARGET = 2;

    private BlockPos activeTarget = null;
    private BlockPos activeBreakTarget = null;
    private String activeCommandId = "";
    private long startedAtMs = 0L;
    private long targetAirSinceMs = -1L;
    private int occludersBroken = 0;
    private int repositionsRequested = 0;
    private Direction activeBreakFace = null;
    private String activeToolIdentity = "";

    enum Status {
        RUNNING,
        BROKEN,
        REPOSITION,
        FAILED
    }

    record Result(
        Status status,
        String reason,
        long elapsedMs,
        BlockPos hitBlock,
        BlockPos actedBlock,
        int occludersBroken,
        InteractionDemand interactionDemand,
        FabricInteractionAuthority.Payload interactionPayload,
        ValidatedNextBlockHint preAimHint
    ) {
        Result(Status status, String reason, long elapsedMs) {
            this(status, reason, elapsedMs, null, null, 0, null, null, null);
        }

        Result(
            Status status,
            String reason,
            long elapsedMs,
            BlockPos hitBlock,
            BlockPos actedBlock,
            int occludersBroken
        ) {
            this(status, reason, elapsedMs, hitBlock, actedBlock, occludersBroken, null, null, null);
        }
    }

    /**
     * Explicit caller-owned continuation hint for a frozen, already validated block sequence.
     * The breaker never searches for or infers a neighboring target.
     */
    record ValidatedNextBlockHint(BlockPos target, Direction face, String targetIdentity) {
        ValidatedNextBlockHint {
            if (target == null || face == null || targetIdentity == null || targetIdentity.isBlank()) {
                throw new IllegalArgumentException("validated next-block hint requires target, face, and identity");
            }
            target = target.toImmutable();
        }
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, BlockPos target, String commandId, long nowMs) {
        return tick(client, player, target, commandId, nowMs, false, DEFAULT_TIMEOUT_MS, false, null);
    }

    Result tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        String commandId,
        long nowMs,
        ValidatedNextBlockHint nextBlockHint
    ) {
        return tick(
            client,
            player,
            target,
            commandId,
            nowMs,
            false,
            DEFAULT_TIMEOUT_MS,
            false,
            nextBlockHint
        );
    }

    Result tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        String commandId,
        long nowMs,
        boolean breakLogOccluders
    ) {
        return tick(client, player, target, commandId, nowMs, breakLogOccluders, DEFAULT_TIMEOUT_MS, false, null);
    }

    Result tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        String commandId,
        long nowMs,
        boolean breakLogOccluders,
        long timeoutMs
    ) {
        return tick(client, player, target, commandId, nowMs, breakLogOccluders, timeoutMs, false, null);
    }

    Result tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        String commandId,
        long nowMs,
        boolean breakLogOccluders,
        long timeoutMs,
        boolean breakTerrainOccluders
    ) {
        return tick(
            client,
            player,
            target,
            commandId,
            nowMs,
            breakLogOccluders,
            timeoutMs,
            breakTerrainOccluders,
            null
        );
    }

    Result tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        String commandId,
        long nowMs,
        boolean breakLogOccluders,
        long timeoutMs,
        boolean breakTerrainOccluders,
        ValidatedNextBlockHint nextBlockHint
    ) {
        if (client == null || client.world == null || client.interactionManager == null || player == null || target == null) {
            reset();
            return new Result(Status.FAILED, "missing_client_state", 0L);
        }
        // Never dig the bot's own support column (feel pass 2: "mining blocks directly
        // underneath itself" — the classic don't-dig-straight-down): a straight-down break drops
        // the bot into whatever it opens. Every legitimate dig flow (staircase steps, prospect
        // branches, alcoves) targets horizontally-offset cells, so callers that land here simply
        // fail fast and reselect.
        if (target.getX() == (int) Math.floor(player.getX())
            && target.getZ() == (int) Math.floor(player.getZ())
            && target.getY() < (int) Math.floor(player.getY())) {
            return new Result(Status.FAILED, "own_support_column", 0L);
        }
        if (!target.equals(activeTarget) || !safeEquals(commandId, activeCommandId)) {
            activeTarget = target.toImmutable();
            activeBreakTarget = null;
            activeBreakFace = null;
            activeToolIdentity = "";
            activeCommandId = commandId == null ? "" : commandId;
            startedAtMs = nowMs;
            targetAirSinceMs = -1L;
            occludersBroken = 0;
            repositionsRequested = 0;
        }

        long elapsedMs = Math.max(0L, nowMs - startedAtMs);
        if (activeBreakTarget != null && !activeBreakTarget.equals(activeTarget) && client.world.getBlockState(activeBreakTarget).isAir()) {
            BlockPos cleared = activeBreakTarget;
            activeBreakTarget = null;
            activeBreakFace = null;
            activeToolIdentity = "";
            occludersBroken++;
            return new Result(Status.RUNNING, "occluder_cleared", elapsedMs, cleared, cleared, occludersBroken);
        }
        BlockState state = client.world.getBlockState(target);
        if (state.isAir()) {
            if (targetAirSinceMs < 0L) {
                targetAirSinceMs = nowMs;
            }
            Result hold = airConfirmationResult(
                commandId,
                target,
                elapsedMs,
                nextBlockHint,
                hasStableAirConfirmation(targetAirSinceMs, nowMs)
            );
            if (hasStableAirConfirmation(targetAirSinceMs, nowMs)) {
                reset();
                return hold;
            }
            return hold;
        }
        targetAirSinceMs = -1L;
        long effectiveTimeoutMs = timeoutMs <= 0L ? DEFAULT_TIMEOUT_MS : timeoutMs;
        if (elapsedMs > effectiveTimeoutMs) {
            reset();
            return new Result(Status.FAILED, "break_timeout", elapsedMs);
        }
        if (!withinReach(player, target)) {
            return new Result(Status.FAILED, "target_out_of_reach", elapsedMs);
        }
        if (!player.isOnGround()) {
            return new Result(Status.RUNNING, "waiting_on_ground", elapsedMs);
        }

        BlockHitResult hit = raycast(player, client);
        boolean blockHit = hit != null && hit.getType() == HitResult.Type.BLOCK;
        BlockPos hitBlock = blockHit ? hit.getBlockPos().toImmutable() : null;
        boolean hitTarget = target.equals(hitBlock);
        BlockState hitState = hitBlock == null ? null : client.world.getBlockState(hitBlock);
        boolean breakableOccluder = hitState != null
            && !hitState.isAir()
            && isCheapOccluder(hitState, breakLogOccluders, breakTerrainOccluders);
        BreakOcclusionPlanner.Decision decision = BreakOcclusionPlanner.decide(
            blockHit,
            hitTarget,
            breakableOccluder,
            occludersBroken,
            MAX_OCCLUDERS_PER_TARGET,
            repositionsRequested,
            MAX_OCCLUSION_REPOSITIONS_PER_TARGET
        );
        if (decision.action() == BreakOcclusionPlanner.Action.WAIT) {
            return new Result(Status.RUNNING, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }
        if (decision.action() == BreakOcclusionPlanner.Action.REPOSITION) {
            repositionsRequested++;
            activeBreakTarget = null;
            activeBreakFace = null;
            activeToolIdentity = "";
            return new Result(Status.REPOSITION, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }
        if (decision.action() == BreakOcclusionPlanner.Action.ABANDON) {
            reset();
            return new Result(Status.FAILED, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }

        BlockPos breakTarget = decision.action() == BreakOcclusionPlanner.Action.BREAK_TARGET ? target : hitBlock;
        if (breakTarget == null || hit == null) {
            return new Result(Status.RUNNING, "raycast_no_break_target", elapsedMs, hitBlock, null, occludersBroken);
        }
        ToolSelection toolSelection = chooseBreakTool(player, client.world.getBlockState(breakTarget));
        if (!toolSelection.ok()) {
            reset();
            return new Result(Status.FAILED, "tool_unavailable:" + toolSelection.reason(), elapsedMs, hitBlock, breakTarget, occludersBroken);
        }
        if (toolSelection.hotbarSlot() >= 0 && player.getInventory().selectedSlot != toolSelection.hotbarSlot()) {
            player.getInventory().selectedSlot = toolSelection.hotbarSlot();
            activeBreakTarget = null;
            activeBreakFace = null;
            activeToolIdentity = "";
            return new Result(
                Status.RUNNING,
                "tool_selected:" + toolSelection.itemId() + ":" + toolSelection.reason(),
                elapsedMs,
                hitBlock,
                breakTarget,
                occludersBroken
            );
        }
        if (!breakTarget.equals(activeBreakTarget)) {
            activeBreakTarget = breakTarget.toImmutable();
        }
        activeBreakFace = hit.getSide();
        activeToolIdentity = toolSelection.itemId();
        String reason = decision.action() == BreakOcclusionPlanner.Action.BREAK_TARGET
            ? (state.isIn(BlockTags.LOGS) ? "raycast_breaking_log" : "raycast_breaking_block")
            : "raycast_breaking_occluder:" + blockId(hitState);
        InteractionDemand demand = InteractionDemand.breakBlock(
            breakRequestId(commandId, breakTarget, activeBreakFace),
            LookDemand.Owner.NORMAL,
            commandId,
            "block_break",
            breakGestureIdentity(commandId),
            blockIdentity(breakTarget),
            activeToolIdentity,
            activeBreakFace.asString(),
            reason
        );
        return new Result(
            Status.RUNNING,
            reason,
            elapsedMs,
            hitBlock,
            breakTarget,
            occludersBroken,
            demand,
            FabricInteractionAuthority.Payload.blockBreak(
                breakTarget,
                activeBreakFace,
                FabricWorldActionAuthorization.BlockAuthorization.naturalResource()
            ),
            null
        );
    }

    void reset() {
        activeTarget = null;
        activeBreakTarget = null;
        activeBreakFace = null;
        activeToolIdentity = "";
        activeCommandId = "";
        startedAtMs = 0L;
        targetAirSinceMs = -1L;
        occludersBroken = 0;
        repositionsRequested = 0;
    }

    private Result airConfirmationResult(
        String commandId,
        BlockPos target,
        long elapsedMs,
        ValidatedNextBlockHint nextBlockHint,
        boolean confirmed
    ) {
        ValidatedNextBlockHint acceptedHint = nextBlockHint != null
            && !nextBlockHint.target().equals(target)
                ? nextBlockHint
                : null;
        BlockPos holdTarget = acceptedHint == null ? target : acceptedHint.target();
        Direction holdFace = acceptedHint == null ? activeBreakFace : acceptedHint.face();
        InteractionDemand holdDemand = null;
        FabricInteractionAuthority.Payload holdPayload = null;
        if (activeBreakTarget != null && activeBreakFace != null && !activeToolIdentity.isBlank()) {
            String targetIdentity = acceptedHint == null
                ? blockIdentity(holdTarget)
                : acceptedHint.targetIdentity();
            holdDemand = InteractionDemand.blockBreakHold(
                "break-hold:" + stableId(commandId) + ":" + targetIdentity,
                LookDemand.Owner.NORMAL,
                commandId,
                "block_break",
                breakGestureIdentity(commandId),
                targetIdentity,
                activeToolIdentity,
                holdFace.asString(),
                confirmed ? "block_air_confirmed" : "block_air_confirming"
            );
            holdPayload = FabricInteractionAuthority.Payload.none();
        }
        return new Result(
            confirmed ? Status.BROKEN : Status.RUNNING,
            confirmed ? "block_air" : "block_air_confirming",
            elapsedMs,
            null,
            target,
            occludersBroken,
            holdDemand,
            holdPayload,
            acceptedHint
        );
    }

    private static String breakRequestId(String commandId, BlockPos target, Direction face) {
        return "break:" + stableId(commandId) + ":" + blockIdentity(target) + ":" + face.asString();
    }

    private static String breakGestureIdentity(String commandId) {
        return "break-gesture:" + stableId(commandId);
    }

    private static String blockIdentity(BlockPos pos) {
        return pos.getX() + "," + pos.getY() + "," + pos.getZ();
    }

    private static String stableId(String value) {
        return value == null || value.isBlank() ? "uncommanded" : value;
    }

    static boolean hasStableAirConfirmation(long airSinceMs, long nowMs) {
        return hasStableAirConfirmation(airSinceMs, nowMs, AIR_CONFIRM_MS);
    }

    static boolean hasStableAirConfirmation(long airSinceMs, long nowMs, long confirmMs) {
        return airSinceMs >= 0L && nowMs >= airSinceMs && nowMs - airSinceMs >= Math.max(0L, confirmMs);
    }

    private static boolean withinReach(ClientPlayerEntity player, BlockPos target) {
        double reach = Math.min(MAX_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        return withinReach(player.getEyePos(), target, reach);
    }

    static boolean withinReach(Vec3d eye, BlockPos target, double reach) {
        if (eye == null || target == null || reach <= 0.0D) {
            return false;
        }
        double dx = distanceOutsideRange(eye.x, target.getX(), target.getX() + 1.0D);
        double dy = distanceOutsideRange(eye.y, target.getY(), target.getY() + 1.0D);
        double dz = distanceOutsideRange(eye.z, target.getZ(), target.getZ() + 1.0D);
        return dx * dx + dy * dy + dz * dz <= reach * reach + 1.0E-6D;
    }

    private static double distanceOutsideRange(double value, double min, double max) {
        if (value < min) {
            return min - value;
        }
        if (value > max) {
            return value - max;
        }
        return 0.0D;
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

    private static boolean isCheapOccluder(BlockState state, boolean breakLogOccluders, boolean breakTerrainOccluders) {
        if (state == null || state.isAir()) {
            return false;
        }
        if (breakLogOccluders && state.isIn(BlockTags.LOGS)) {
            return true;
        }
        if (breakTerrainOccluders && isTerrainOccluderBlockId(blockId(state))) {
            return true;
        }
        if (state.isIn(BlockTags.LEAVES)) {
            return true;
        }
        return isCheapOccluderBlockId(blockId(state));
    }

    // Ore-mining context only (descent iron-cleanup / mine_nearby_<ore>): plain terrain in front of a
    // targeted ore is MINED THROUGH (bounded by MAX_OCCLUDERS_PER_TARGET) instead of reposition-cycling.
    // The 2026-06-09 random-world run found+targeted iron with the right pickaxe, but its eye-ray kept
    // clipping the stone edge in front of the ore -> raycast_occluded REPOSITION churn -> break restarted
    // forever -> gave up with the ore one block away. Deliberately excludes ores (they are targets, not
    // occluders) and gravity blocks (sand/gravel collapse onto the bot's dig line).
    static boolean isTerrainOccluderBlockId(String id) {
        if (id == null || id.isBlank()) {
            return false;
        }
        return id.equals("stone")
            || id.equals("deepslate")
            || id.equals("cobblestone")
            || id.equals("cobbled_deepslate")
            || id.equals("andesite")
            || id.equals("diorite")
            || id.equals("granite")
            || id.equals("tuff")
            || id.equals("calcite")
            || id.equals("dirt")
            || id.equals("grass_block")
            || id.equals("netherrack");
    }

    static boolean isCheapOccluderBlockId(String id) {
        if (id == null || id.isBlank()) {
            return false;
        }
        return id.equals("vine")
            || id.endsWith("_vine")
            || id.endsWith("_vines")
            || id.equals("cave_vines")
            || id.equals("cave_vines_plant")
            || id.equals("grass")
            || id.equals("short_grass")
            || id.equals("fern")
            || id.equals("tall_grass")
            || id.equals("large_fern")
            || id.equals("dead_bush")
            || id.equals("snow")
            || id.equals("seagrass")
            || id.equals("tall_seagrass");
    }

    private static ToolSelection chooseBreakTool(ClientPlayerEntity player, BlockState targetState) {
        String targetBlockId = blockId(targetState);
        ToolSelectionPlanner.Decision decision = ToolSelectionPlanner.decideForBlockId(targetBlockId);
        int selected = player == null ? -1 : player.getInventory().selectedSlot;
        String selectedItem = selectedItemId(player);

        if (decision.requirement() == ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED) {
            // If the held item is ALREADY a pickaxe, keep it. Switching to "the first pickaxe slot" every
            // tick fights any caller that pre-selected a different pickaxe (e.g. the highest-durability one
            // for diamond mining), and because changing the selected slot resets break progress, the two
            // selections oscillate and the block never breaks. Only hunt for a pickaxe when not holding one
            // — which also gives a clean fallback to the next available pickaxe when the held one breaks.
            if (ToolSelectionPlanner.isPickaxeItemId(selectedItem)) {
                return new ToolSelection(true, selected, selectedItem, targetBlockId, decision.reason());
            }
            int pickaxeSlot = findHotbarSlot(player, ToolSelectionPlanner::isPickaxeItemId);
            if (pickaxeSlot < 0) {
                return new ToolSelection(false, -1, selectedItem, targetBlockId, decision.reason());
            }
            return new ToolSelection(true, pickaxeSlot, itemId(player.getInventory().getStack(pickaxeSlot)), targetBlockId, decision.reason());
        }

        if (decision.requirement() == ToolSelectionPlanner.Requirement.SHOVEL_OR_HAND) {
            int shovelSlot = findHotbarSlot(player, ToolSelectionPlanner::isShovelItemId);
            if (shovelSlot >= 0) {
                return new ToolSelection(true, shovelSlot, itemId(player.getInventory().getStack(shovelSlot)), targetBlockId, decision.reason());
            }
            int emptySlot = findEmptyHotbarSlot(player);
            if (emptySlot >= 0) {
                return new ToolSelection(true, emptySlot, "empty", targetBlockId, decision.reason());
            }
            if (!ToolSelectionPlanner.isPickaxeItemId(selectedItem)) {
                return new ToolSelection(true, selected, selectedItem.isEmpty() ? "empty" : selectedItem, targetBlockId, decision.reason());
            }
            int nonPickaxeSlot = findHotbarSlot(player, (id) -> !ToolSelectionPlanner.isPickaxeItemId(id));
            if (nonPickaxeSlot >= 0) {
                return new ToolSelection(true, nonPickaxeSlot, itemId(player.getInventory().getStack(nonPickaxeSlot)), targetBlockId, decision.reason());
            }
            return new ToolSelection(false, -1, selectedItem, targetBlockId, "no_non_pickaxe_slot:" + targetBlockId);
        }

        if (decision.requirement() == ToolSelectionPlanner.Requirement.AVOID_PICKAXE
            && ToolSelectionPlanner.isPickaxeItemId(selectedItem)) {
            int emptySlot = findEmptyHotbarSlot(player);
            if (emptySlot >= 0) {
                return new ToolSelection(true, emptySlot, "empty", targetBlockId, decision.reason());
            }
            int nonPickaxeSlot = findHotbarSlot(player, (id) -> !ToolSelectionPlanner.isPickaxeItemId(id));
            if (nonPickaxeSlot >= 0) {
                return new ToolSelection(true, nonPickaxeSlot, itemId(player.getInventory().getStack(nonPickaxeSlot)), targetBlockId, decision.reason());
            }
            return new ToolSelection(false, -1, selectedItem, targetBlockId, "no_non_pickaxe_slot:" + targetBlockId);
        }

        return new ToolSelection(true, selected, selectedItem.isEmpty() ? "empty" : selectedItem, targetBlockId, decision.reason());
    }

    private static int findHotbarSlot(ClientPlayerEntity player, java.util.function.Predicate<String> itemPredicate) {
        if (player == null || itemPredicate == null) {
            return -1;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            if (itemPredicate.test(itemId(stack))) {
                return slot;
            }
        }
        return -1;
    }

    private static int findEmptyHotbarSlot(ClientPlayerEntity player) {
        if (player == null) {
            return -1;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                return slot;
            }
        }
        return -1;
    }

    private static String selectedItemId(ClientPlayerEntity player) {
        if (player == null) {
            return "empty";
        }
        String id = itemId(player.getMainHandStack());
        return id.isEmpty() ? "empty" : id;
    }

    private static String itemId(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return "";
        }
        return Registries.ITEM.getId(stack.getItem()).getPath();
    }

    private static String blockId(BlockState state) {
        if (state == null) {
            return "";
        }
        return Registries.BLOCK.getId(state.getBlock()).getPath();
    }

    private record ToolSelection(boolean ok, int hotbarSlot, String itemId, String blockId, String reason) {
    }

    private static boolean safeEquals(String a, String b) {
        return a == null ? b == null || b.isEmpty() : a.equals(b);
    }
}
