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
    private MinecraftClient activeClient = null;
    private String activeCommandId = "";
    private long startedAtMs = 0L;
    private long targetAirSinceMs = -1L;
    private int occludersBroken = 0;
    private int repositionsRequested = 0;

    enum Status {
        RUNNING,
        BROKEN,
        REPOSITION,
        FAILED
    }

    record Result(Status status, String reason, long elapsedMs, BlockPos hitBlock, BlockPos actedBlock, int occludersBroken) {
        Result(Status status, String reason, long elapsedMs) {
            this(status, reason, elapsedMs, null, null, 0);
        }
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, BlockPos target, String commandId, long nowMs) {
        return tick(client, player, target, commandId, nowMs, false);
    }

    Result tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        String commandId,
        long nowMs,
        boolean breakLogOccluders
    ) {
        return tick(client, player, target, commandId, nowMs, breakLogOccluders, DEFAULT_TIMEOUT_MS);
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
        return tick(client, player, target, commandId, nowMs, breakLogOccluders, timeoutMs, false);
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
        activeClient = client;
        if (!target.equals(activeTarget) || !safeEquals(commandId, activeCommandId)) {
            setAttackPressed(client, false);
            activeTarget = target.toImmutable();
            activeBreakTarget = null;
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
            setAttackPressed(client, false);
            occludersBroken++;
            return new Result(Status.RUNNING, "occluder_cleared", elapsedMs, cleared, cleared, occludersBroken);
        }
        BlockState state = client.world.getBlockState(target);
        if (state.isAir()) {
            setAttackPressed(client, false);
            if (targetAirSinceMs < 0L) {
                targetAirSinceMs = nowMs;
            }
            if (hasStableAirConfirmation(targetAirSinceMs, nowMs)) {
                reset();
                return new Result(Status.BROKEN, "block_air", elapsedMs);
            }
            return new Result(Status.RUNNING, "block_air_confirming", elapsedMs);
        }
        targetAirSinceMs = -1L;
        long effectiveTimeoutMs = timeoutMs <= 0L ? DEFAULT_TIMEOUT_MS : timeoutMs;
        if (elapsedMs > effectiveTimeoutMs) {
            client.interactionManager.cancelBlockBreaking();
            reset();
            return new Result(Status.FAILED, "break_timeout", elapsedMs);
        }
        if (!withinReach(player, target)) {
            setAttackPressed(client, false);
            return new Result(Status.FAILED, "target_out_of_reach", elapsedMs);
        }
        if (!player.isOnGround()) {
            setAttackPressed(client, false);
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
            setAttackPressed(client, false);
            return new Result(Status.RUNNING, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }
        if (decision.action() == BreakOcclusionPlanner.Action.REPOSITION) {
            repositionsRequested++;
            activeBreakTarget = null;
            setAttackPressed(client, false);
            return new Result(Status.REPOSITION, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }
        if (decision.action() == BreakOcclusionPlanner.Action.ABANDON) {
            client.interactionManager.cancelBlockBreaking();
            reset();
            return new Result(Status.FAILED, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }

        BlockPos breakTarget = decision.action() == BreakOcclusionPlanner.Action.BREAK_TARGET ? target : hitBlock;
        if (breakTarget == null || hit == null) {
            setAttackPressed(client, false);
            return new Result(Status.RUNNING, "raycast_no_break_target", elapsedMs, hitBlock, null, occludersBroken);
        }
        ToolSelection toolSelection = chooseBreakTool(player, client.world.getBlockState(breakTarget));
        if (!toolSelection.ok()) {
            client.interactionManager.cancelBlockBreaking();
            reset();
            return new Result(Status.FAILED, "tool_unavailable:" + toolSelection.reason(), elapsedMs, hitBlock, breakTarget, occludersBroken);
        }
        if (toolSelection.hotbarSlot() >= 0 && player.getInventory().selectedSlot != toolSelection.hotbarSlot()) {
            player.getInventory().selectedSlot = toolSelection.hotbarSlot();
            activeBreakTarget = null;
            setAttackPressed(client, false);
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
        // SINGLE progress authority: updateBlockBreakingProgress alone is the full vanilla cadence
        // (first call sends START_DESTROY, then one increment per tick, STOP on completion). Holding
        // the vanilla attack key here made MinecraftClient.handleBlockBreaking advance progress a
        // SECOND time each tick -> the client predicted the break at ~half the legit duration -> the
        // integrated server rejected the early break and restored the block (the visible "broken
        // block comes back" ghost) before the re-break landed. The key also targets the crosshair
        // block while this call targets the raycast block, splitting progress when the look settles.
        // The remaining setAttackPressed(false) calls are defensive releases only.
        client.interactionManager.updateBlockBreakingProgress(breakTarget, hit.getSide());
        String reason = decision.action() == BreakOcclusionPlanner.Action.BREAK_TARGET
            ? (state.isIn(BlockTags.LOGS) ? "raycast_breaking_log" : "raycast_breaking_block")
            : "raycast_breaking_occluder:" + blockId(hitState);
        return new Result(Status.RUNNING, reason, elapsedMs, hitBlock, breakTarget, occludersBroken);
    }

    void reset() {
        setAttackPressed(activeClient, false);
        activeTarget = null;
        activeBreakTarget = null;
        activeClient = null;
        activeCommandId = "";
        startedAtMs = 0L;
        targetAirSinceMs = -1L;
        occludersBroken = 0;
        repositionsRequested = 0;
    }

    private static void setAttackPressed(MinecraftClient client, boolean pressed) {
        if (client == null || client.options == null || client.options.attackKey == null) {
            return;
        }
        client.options.attackKey.setPressed(pressed);
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
