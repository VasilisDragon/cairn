package com.mcbot.fabricclient;

import java.util.Set;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.item.ItemStack;

/** The existing village hotbar protection classification, shared without changing its policy. */
final class HotbarItemProtection {
    private static final Set<String> ITEMS = Set.of(
        "minecraft:crafting_table", "minecraft:furnace", "minecraft:water_bucket",
        "minecraft:bucket", "minecraft:shield", "minecraft:flint_and_steel",
        "minecraft:bow", "minecraft:cobblestone", "minecraft:dirt");

    private HotbarItemProtection() { }

    static boolean protects(ItemStack stack, String itemId) {
        if (stack == null || stack.isEmpty()) return false;
        return stack.contains(DataComponentTypes.FOOD)
            || itemId.endsWith("_pickaxe") || itemId.endsWith("_sword")
            || itemId.endsWith("_axe") || itemId.endsWith("_shovel")
            || itemId.endsWith("_hoe") || itemId.endsWith("_bed")
            || ITEMS.contains(itemId) || itemId.endsWith("_planks") || itemId.endsWith("_log");
    }
}
