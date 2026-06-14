package com.mcbot.fabricclient;

import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.slot.SlotActionType;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class ArmorController {
    private static final Logger LOGGER = LoggerFactory.getLogger("mcbot-fabric-armor");
    private static final long CLICK_SETTLE_MS = 120L;

    private final String instanceId;
    private String activeCommandId = "";
    private PendingSwap pendingSwap = null;
    private ArmorPlanner.ArmorSlot equippedSlotThisCommand = null;
    private long lastClickAtMs = 0L;

    ArmorController(String instanceId) {
        this.instanceId = instanceId == null ? "" : instanceId;
    }

    enum Status {
        ACTIVE,
        COMPLETE,
        FAILED
    }

    record Result(Status status, InputState input, String reason) {
        static Result active(String reason) {
            return new Result(Status.ACTIVE, InputState.stop(), reason);
        }

        static Result complete(String reason) {
            return new Result(Status.COMPLETE, InputState.stop(), reason);
        }

        static Result failed(String reason) {
            return new Result(Status.FAILED, InputState.stop(), reason);
        }
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, String commandId, long nowMs) {
        String id = commandId == null ? "" : commandId;
        if (!id.equals(activeCommandId)) {
            activeCommandId = id;
            pendingSwap = null;
            equippedSlotThisCommand = null;
            lastClickAtMs = 0L;
        }
        if (client == null || client.interactionManager == null || player == null) {
            return Result.failed("missing_client_context");
        }
        if (player.currentScreenHandler != player.playerScreenHandler) {
            String handler = player.currentScreenHandler == null ? "none" : player.currentScreenHandler.getClass().getSimpleName();
            player.closeHandledScreen();
            LOGGER.info(
                "r7_armor.close_screen instanceId={} commandId={} handler={}",
                instanceId,
                id,
                handler
            );
            return Result.active("close_screen_before_equip");
        }
        if (lastClickAtMs > 0L && nowMs - lastClickAtMs < CLICK_SETTLE_MS) {
            return Result.active("click_settle");
        }
        if (pendingSwap != null) {
            return continuePendingSwap(client, player, id, nowMs);
        }
        if (equippedSlotThisCommand != null) {
            ArmorPlanner.ArmorSlot slot = equippedSlotThisCommand;
            if (itemId(currentArmorStack(player, slot)).equals(slot.itemId())) {
                LOGGER.info(
                    "r7_armor.complete instanceId={} commandId={} reason=equipped_one_piece slot={}",
                    instanceId,
                    id,
                    slot
                );
                return Result.complete("equipped_one_piece:" + slot);
            }
            LOGGER.warn(
                "r7_armor.failed instanceId={} commandId={} reason=equipped_slot_not_verified slot={}",
                instanceId,
                id,
                slot
            );
            return Result.failed("equipped_slot_not_verified:" + slot);
        }

        ArmorPlanner.Decision decision = ArmorPlanner.decideFirst(observations(player));
        return switch (decision.action()) {
            case KEEP -> {
                LOGGER.info("r7_armor.complete instanceId={} commandId={} reason={}", instanceId, id, decision.reason());
                yield Result.complete(decision.reason());
            }
            case WAIT_FOR_MATERIALS -> {
                LOGGER.warn(
                    "r7_armor.failed instanceId={} commandId={} reason={} slot={}",
                    instanceId,
                    id,
                    decision.reason(),
                    decision.slot()
                );
                yield Result.failed(decision.reason());
            }
            case CRAFT_REPLACE -> {
                LOGGER.info(
                    "r7_armor.craft_required instanceId={} commandId={} slot={} action={} reason={}",
                    instanceId,
                    id,
                    decision.slot(),
                    decision.craftAction(),
                    decision.reason()
                );
                yield Result.failed(decision.reason());
            }
            case EQUIP_SPARE -> {
                int sourceInventorySlot = findBestSpareInventorySlot(player, decision.slot());
                if (sourceInventorySlot < 0) {
                    LOGGER.warn(
                        "r7_armor.failed instanceId={} commandId={} reason=spare_not_found slot={}",
                        instanceId,
                        id,
                        decision.slot()
                    );
                    yield Result.failed("spare_not_found:" + decision.slot());
                }
                pendingSwap = new PendingSwap(
                    decision.slot(),
                    sourceInventorySlot,
                    playerInventoryScreenSlot(sourceInventorySlot),
                    armorScreenSlot(decision.slot()),
                    isLowDurabilityExpectedArmor(currentArmorStack(player, decision.slot()), decision.slot()),
                    SwapStage.PICK_SOURCE
                );
                LOGGER.info(
                    "r7_armor.equip_start instanceId={} commandId={} slot={} sourceInventorySlot={} sourceScreenSlot={} armorScreenSlot={} replacement={} reason={}",
                    instanceId,
                    id,
                    decision.slot(),
                    sourceInventorySlot,
                    pendingSwap.sourceScreenSlot,
                    pendingSwap.armorScreenSlot,
                    pendingSwap.replacement,
                    decision.reason()
                );
                yield continuePendingSwap(client, player, id, nowMs);
            }
        };
    }

    private Result continuePendingSwap(MinecraftClient client, ClientPlayerEntity player, String commandId, long nowMs) {
        PendingSwap swap = pendingSwap;
        if (swap == null) {
            return Result.active("no_pending_swap");
        }
        if (swap.stage == SwapStage.PICK_SOURCE) {
            click(client, player, commandId, swap, swap.sourceScreenSlot, "pick_source", nowMs);
            pendingSwap = swap.withStage(SwapStage.CLICK_ARMOR);
            return Result.active("pick_source");
        }
        if (swap.stage == SwapStage.CLICK_ARMOR) {
            click(client, player, commandId, swap, swap.armorScreenSlot, "click_armor_slot", nowMs);
            if (player.playerScreenHandler.getCursorStack().isEmpty()) {
                logSwapComplete(commandId, swap);
                pendingSwap = null;
                equippedSlotThisCommand = swap.slot;
                return Result.active("equipped");
            }
            pendingSwap = swap.withStage(SwapStage.RETURN_OLD);
            return Result.active("return_old_pending");
        }
        click(client, player, commandId, swap, swap.sourceScreenSlot, "return_old", nowMs);
        logSwapComplete(commandId, swap);
        pendingSwap = null;
        equippedSlotThisCommand = swap.slot;
        return Result.active("equipped");
    }

    private void click(
        MinecraftClient client,
        ClientPlayerEntity player,
        String commandId,
        PendingSwap swap,
        int slot,
        String label,
        long nowMs
    ) {
        client.interactionManager.clickSlot(player.playerScreenHandler.syncId, slot, 0, SlotActionType.PICKUP, player);
        lastClickAtMs = nowMs;
        LOGGER.info(
            "r7_armor.click instanceId={} commandId={} label={} armorSlot={} screenSlot={} syncId={}",
            instanceId,
            commandId,
            label,
            swap.slot,
            slot,
            player.playerScreenHandler.syncId
        );
    }

    private void logSwapComplete(String commandId, PendingSwap swap) {
        LOGGER.info(
            "r7_armor.equip instanceId={} commandId={} slot={} sourceInventorySlot={} replacement={}",
            instanceId,
            commandId,
            swap.slot,
            swap.sourceInventorySlot,
            swap.replacement
        );
        if (swap.replacement) {
            LOGGER.info(
                "r7_armor.replace instanceId={} commandId={} slot={} reason=low_durability",
                instanceId,
                commandId,
                swap.slot
            );
        }
    }

    private Map<ArmorPlanner.ArmorSlot, ArmorPlanner.SlotObservation> observations(ClientPlayerEntity player) {
        EnumMap<ArmorPlanner.ArmorSlot, ArmorPlanner.SlotObservation> observations = new EnumMap<>(ArmorPlanner.ArmorSlot.class);
        int ironIngots = InventoryCounter.countPlayerItem(player, "iron_ingot").itemCount();
        for (ArmorPlanner.ArmorSlot slot : ArmorPlanner.ArmorSlot.values()) {
            ItemStack equipped = currentArmorStack(player, slot);
            boolean expected = itemId(equipped).equals(slot.itemId());
            observations.put(
                slot,
                new ArmorPlanner.SlotObservation(
                    expected,
                    remainingFraction(equipped),
                    countGoodSpare(player, slot),
                    ironIngots
                )
            );
        }
        return observations;
    }

    private int countGoodSpare(ClientPlayerEntity player, ArmorPlanner.ArmorSlot slot) {
        int count = 0;
        for (int inventorySlot = 0; inventorySlot < 36 && inventorySlot < player.getInventory().size(); inventorySlot++) {
            ItemStack stack = player.getInventory().getStack(inventorySlot);
            if (itemId(stack).equals(slot.itemId()) && remainingFraction(stack) >= ArmorPlanner.REPLACE_BELOW_REMAINING_FRACTION) {
                count += Math.max(1, stack.getCount());
            }
        }
        return count;
    }

    private int findBestSpareInventorySlot(ClientPlayerEntity player, ArmorPlanner.ArmorSlot slot) {
        int bestSlot = -1;
        double bestRemaining = -1.0D;
        for (int inventorySlot = 0; inventorySlot < 36 && inventorySlot < player.getInventory().size(); inventorySlot++) {
            ItemStack stack = player.getInventory().getStack(inventorySlot);
            if (!itemId(stack).equals(slot.itemId())) {
                continue;
            }
            double remaining = remainingFraction(stack);
            if (remaining >= ArmorPlanner.REPLACE_BELOW_REMAINING_FRACTION && remaining > bestRemaining) {
                bestSlot = inventorySlot;
                bestRemaining = remaining;
            }
        }
        return bestSlot;
    }

    static ItemStack currentArmorStack(ClientPlayerEntity player, ArmorPlanner.ArmorSlot slot) {
        if (player == null || slot == null) {
            return ItemStack.EMPTY;
        }
        return switch (slot) {
            case HELMET -> player.getInventory().getArmorStack(3);
            case CHESTPLATE -> player.getInventory().getArmorStack(2);
            case LEGGINGS -> player.getInventory().getArmorStack(1);
            case BOOTS -> player.getInventory().getArmorStack(0);
        };
    }

    static double remainingFraction(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return -1.0D;
        }
        if (!stack.isDamageable()) {
            return 1.0D;
        }
        int max = stack.getMaxDamage();
        if (max <= 0) {
            return 1.0D;
        }
        return Math.max(0.0D, (double) (max - stack.getDamage()) / (double) max);
    }

    static int remainingDurability(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return -1;
        }
        if (!stack.isDamageable()) {
            return Integer.MAX_VALUE;
        }
        return Math.max(0, stack.getMaxDamage() - stack.getDamage());
    }

    static int maxDurability(ItemStack stack) {
        if (stack == null || stack.isEmpty() || !stack.isDamageable()) {
            return -1;
        }
        return stack.getMaxDamage();
    }

    static String itemId(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return "";
        }
        return Registries.ITEM.getId(stack.getItem()).getPath().toLowerCase(Locale.ROOT);
    }

    private static boolean isLowDurabilityExpectedArmor(ItemStack stack, ArmorPlanner.ArmorSlot slot) {
        return itemId(stack).equals(slot.itemId())
            && remainingFraction(stack) >= 0.0D
            && remainingFraction(stack) < ArmorPlanner.REPLACE_BELOW_REMAINING_FRACTION;
    }

    private static int armorScreenSlot(ArmorPlanner.ArmorSlot slot) {
        return switch (slot) {
            case HELMET -> 5;
            case CHESTPLATE -> 6;
            case LEGGINGS -> 7;
            case BOOTS -> 8;
        };
    }

    private static int playerInventoryScreenSlot(int inventorySlot) {
        if (inventorySlot >= 0 && inventorySlot < 9) {
            return 36 + inventorySlot;
        }
        return inventorySlot;
    }

    private enum SwapStage {
        PICK_SOURCE,
        CLICK_ARMOR,
        RETURN_OLD
    }

    private record PendingSwap(
        ArmorPlanner.ArmorSlot slot,
        int sourceInventorySlot,
        int sourceScreenSlot,
        int armorScreenSlot,
        boolean replacement,
        SwapStage stage
    ) {
        PendingSwap withStage(SwapStage nextStage) {
            return new PendingSwap(slot, sourceInventorySlot, sourceScreenSlot, armorScreenSlot, replacement, nextStage);
        }
    }
}
