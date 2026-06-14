package com.mcbot.fabricclient;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.ItemTags;

final class InventoryCounter {
    private InventoryCounter() {
    }

    record ItemCount(String item, int count) {
    }

    record InventoryLogSnapshot(int logCount, Map<String, Integer> logsByItem) {
    }

    record InventoryPlankSnapshot(int plankCount, Map<String, Integer> planksByItem) {
    }

    record InventoryStickSnapshot(int stickCount, Map<String, Integer> sticksByItem) {
    }

    record InventoryCraftingTableSnapshot(int craftingTableCount, Map<String, Integer> craftingTablesByItem) {
    }

    record InventoryWoodenPickaxeSnapshot(int woodenPickaxeCount, Map<String, Integer> woodenPickaxesByItem) {
    }

    record InventoryCobblestoneSnapshot(int cobblestoneCount, Map<String, Integer> cobblestoneByItem) {
    }

    record InventoryItemSnapshot(int itemCount, Map<String, Integer> itemsByItem) {
    }

    /** Total wool items across all colors (sheep drop the color they wear; beds need any 3 same-color —
     * the hunt command counts total and the bed craft picks the dominant color). */
    static int countPlayerWool(ClientPlayerEntity player) {
        if (player == null) {
            return 0;
        }
        int total = 0;
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (id.endsWith("_wool")) {
                total += stack.getCount();
            }
        }
        return total;
    }

    static InventoryLogSnapshot countPlayerLogs(ClientPlayerEntity player) {
        Map<String, Integer> logs = new LinkedHashMap<>();
        if (player == null) {
            return new InventoryLogSnapshot(0, logs);
        }
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (stack.isIn(ItemTags.LOGS) || isLogItemId(id)) {
                logs.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return new InventoryLogSnapshot(sum(logs), Map.copyOf(logs));
    }

    static InventoryPlankSnapshot countPlayerPlanks(ClientPlayerEntity player) {
        Map<String, Integer> planks = new LinkedHashMap<>();
        if (player == null) {
            return new InventoryPlankSnapshot(0, planks);
        }
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (isPlankItemId(id)) {
                planks.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return new InventoryPlankSnapshot(sum(planks), Map.copyOf(planks));
    }

    static InventoryStickSnapshot countPlayerSticks(ClientPlayerEntity player) {
        Map<String, Integer> sticks = new LinkedHashMap<>();
        if (player == null) {
            return new InventoryStickSnapshot(0, sticks);
        }
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (isStickItemId(id)) {
                sticks.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return new InventoryStickSnapshot(sum(sticks), Map.copyOf(sticks));
    }

    static InventoryCraftingTableSnapshot countPlayerCraftingTables(ClientPlayerEntity player) {
        Map<String, Integer> tables = new LinkedHashMap<>();
        if (player == null) {
            return new InventoryCraftingTableSnapshot(0, tables);
        }
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (isCraftingTableItemId(id)) {
                tables.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return new InventoryCraftingTableSnapshot(sum(tables), Map.copyOf(tables));
    }

    static InventoryWoodenPickaxeSnapshot countPlayerWoodenPickaxes(ClientPlayerEntity player) {
        Map<String, Integer> pickaxes = new LinkedHashMap<>();
        if (player == null) {
            return new InventoryWoodenPickaxeSnapshot(0, pickaxes);
        }
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (isWoodenPickaxeItemId(id)) {
                pickaxes.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return new InventoryWoodenPickaxeSnapshot(sum(pickaxes), Map.copyOf(pickaxes));
    }

    static InventoryCobblestoneSnapshot countPlayerCobblestone(ClientPlayerEntity player) {
        Map<String, Integer> cobblestone = new LinkedHashMap<>();
        if (player == null) {
            return new InventoryCobblestoneSnapshot(0, cobblestone);
        }
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (isCobblestoneItemId(id)) {
                cobblestone.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return new InventoryCobblestoneSnapshot(sum(cobblestone), Map.copyOf(cobblestone));
    }

    static InventoryItemSnapshot countPlayerItem(ClientPlayerEntity player, String targetItemId) {
        Map<String, Integer> items = new LinkedHashMap<>();
        if (player == null || targetItemId == null || targetItemId.isBlank()) {
            return new InventoryItemSnapshot(0, items);
        }
        String normalizedTarget = targetItemId.trim().toLowerCase(Locale.ROOT);
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).getPath();
            if (normalizedTarget.equals(id.toLowerCase(Locale.ROOT))) {
                items.merge(id, stack.getCount(), Integer::sum);
            }
        }
        return new InventoryItemSnapshot(sum(items), Map.copyOf(items));
    }

    static int countLogItems(List<ItemCount> items) {
        if (items == null || items.isEmpty()) {
            return 0;
        }
        int total = 0;
        for (ItemCount item : items) {
            if (item == null || !isLogItemId(item.item())) {
                continue;
            }
            total += Math.max(0, item.count());
        }
        return total;
    }

    static boolean isLogItemId(String itemId) {
        if (itemId == null || itemId.isBlank()) {
            return false;
        }
        String normalized = itemId.toLowerCase(Locale.ROOT);
        return normalized.endsWith("_log")
            || normalized.endsWith("_stem")
            || normalized.endsWith("_wood")
            || normalized.endsWith("_hyphae");
    }

    static boolean isPlankItemId(String itemId) {
        if (itemId == null || itemId.isBlank()) {
            return false;
        }
        String normalized = itemId.toLowerCase(Locale.ROOT);
        return normalized.endsWith("_planks");
    }

    static boolean isStickItemId(String itemId) {
        return "stick".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    static boolean isCraftingTableItemId(String itemId) {
        return "crafting_table".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    static boolean isWoodenPickaxeItemId(String itemId) {
        return "wooden_pickaxe".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    static boolean isCobblestoneItemId(String itemId) {
        return "cobblestone".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    static boolean isStonePickaxeItemId(String itemId) {
        return "stone_pickaxe".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    static boolean isIronPickaxeItemId(String itemId) {
        return "iron_pickaxe".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    static boolean isStoneAxeItemId(String itemId) {
        return "stone_axe".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    static boolean isStoneSwordItemId(String itemId) {
        return "stone_sword".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
    }

    private static int sum(Map<String, Integer> counts) {
        int total = 0;
        for (Integer count : counts.values()) {
            total += Math.max(0, count == null ? 0 : count);
        }
        return total;
    }
}
