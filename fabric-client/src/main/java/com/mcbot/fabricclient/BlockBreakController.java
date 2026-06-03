package com.mcbot.fabricclient;

import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

final class BlockBreakController {
    private static final double MAX_REACH_BLOCKS = 4.8D;
    private static final long DEFAULT_TIMEOUT_MS = 12_000L;
    private static final int MAX_OCCLUDERS_PER_TARGET = 8;
    private static final int MAX_OCCLUSION_REPOSITIONS_PER_TARGET = 2;

    private BlockPos activeTarget = null;
    private BlockPos activeBreakTarget = null;
    private String activeCommandId = "";
    private long startedAtMs = 0L;
    private boolean attackStarted = false;
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
        if (client == null || client.world == null || client.interactionManager == null || player == null || target == null) {
            reset();
            return new Result(Status.FAILED, "missing_client_state", 0L);
        }
        if (!target.equals(activeTarget) || !safeEquals(commandId, activeCommandId)) {
            activeTarget = target.toImmutable();
            activeBreakTarget = null;
            activeCommandId = commandId == null ? "" : commandId;
            startedAtMs = nowMs;
            attackStarted = false;
            occludersBroken = 0;
            repositionsRequested = 0;
        }

        long elapsedMs = Math.max(0L, nowMs - startedAtMs);
        if (activeBreakTarget != null && !activeBreakTarget.equals(activeTarget) && client.world.getBlockState(activeBreakTarget).isAir()) {
            BlockPos cleared = activeBreakTarget;
            activeBreakTarget = null;
            attackStarted = false;
            occludersBroken++;
            return new Result(Status.RUNNING, "occluder_cleared", elapsedMs, cleared, cleared, occludersBroken);
        }
        BlockState state = client.world.getBlockState(target);
        if (state.isAir()) {
            reset();
            return new Result(Status.BROKEN, "block_air", elapsedMs);
        }
        if (elapsedMs > DEFAULT_TIMEOUT_MS) {
            client.interactionManager.cancelBlockBreaking();
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
        boolean breakableOccluder = hitState != null && !hitState.isAir() && isCheapOccluder(hitState);
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
            attackStarted = false;
            return new Result(Status.REPOSITION, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }
        if (decision.action() == BreakOcclusionPlanner.Action.ABANDON) {
            client.interactionManager.cancelBlockBreaking();
            reset();
            return new Result(Status.FAILED, decision.reason(), elapsedMs, hitBlock, null, occludersBroken);
        }

        BlockPos breakTarget = decision.action() == BreakOcclusionPlanner.Action.BREAK_TARGET ? target : hitBlock;
        if (breakTarget == null || hit == null) {
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
            attackStarted = false;
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
            attackStarted = false;
        }
        Direction side = hit.getSide();
        if (!attackStarted) {
            client.interactionManager.attackBlock(breakTarget, side);
            attackStarted = true;
        } else {
            client.interactionManager.updateBlockBreakingProgress(breakTarget, side);
        }
        player.swingHand(Hand.MAIN_HAND);
        String reason = decision.action() == BreakOcclusionPlanner.Action.BREAK_TARGET
            ? (state.isIn(BlockTags.LOGS) ? "raycast_breaking_log" : "raycast_breaking_block")
            : "raycast_breaking_occluder:" + blockId(hitState);
        return new Result(Status.RUNNING, reason, elapsedMs, hitBlock, breakTarget, occludersBroken);
    }

    void reset() {
        activeTarget = null;
        activeBreakTarget = null;
        activeCommandId = "";
        startedAtMs = 0L;
        attackStarted = false;
        occludersBroken = 0;
        repositionsRequested = 0;
    }

    private static boolean withinReach(ClientPlayerEntity player, BlockPos target) {
        Vec3d eye = player.getEyePos();
        Vec3d center = Vec3d.ofCenter(target);
        return eye.squaredDistanceTo(center) <= MAX_REACH_BLOCKS * MAX_REACH_BLOCKS;
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

    private static boolean isCheapOccluder(BlockState state) {
        if (state == null || state.isAir()) {
            return false;
        }
        if (state.isIn(BlockTags.LEAVES)) {
            return true;
        }
        return isCheapOccluderBlockId(blockId(state));
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
            || id.equals("seagrass")
            || id.equals("tall_seagrass");
    }

    private static ToolSelection chooseBreakTool(ClientPlayerEntity player, BlockState targetState) {
        String targetBlockId = blockId(targetState);
        ToolSelectionPlanner.Decision decision = ToolSelectionPlanner.decideForBlockId(targetBlockId);
        int selected = player == null ? -1 : player.getInventory().selectedSlot;
        String selectedItem = selectedItemId(player);

        if (decision.requirement() == ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED) {
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
