package com.mcbot.fabricclient;

import java.util.Locale;

final class ToolSelectionPlanner {
    private ToolSelectionPlanner() {
    }

    enum Requirement {
        PICKAXE_REQUIRED,
        SHOVEL_OR_HAND,
        AVOID_PICKAXE,
        KEEP_CURRENT
    }

    record Decision(Requirement requirement, boolean pickaxeRequired, boolean avoidPickaxe, String reason) {
    }

    static Decision decideForBlockId(String blockId) {
        String id = normalize(blockId);
        if (id.isEmpty()) {
            return new Decision(Requirement.KEEP_CURRENT, false, false, "unknown_block");
        }
        if (requiresPickaxe(id)) {
            return new Decision(Requirement.PICKAXE_REQUIRED, true, false, "pickaxe_required:" + id);
        }
        if (isShovelOrHandBlock(id)) {
            return new Decision(Requirement.SHOVEL_OR_HAND, false, true, "soft_block:" + id);
        }
        if (isKnownNonPickaxeBlock(id)) {
            return new Decision(Requirement.AVOID_PICKAXE, false, true, "non_pickaxe_block:" + id);
        }
        return new Decision(Requirement.KEEP_CURRENT, false, false, "default:" + id);
    }

    static boolean isPickaxeItemId(String itemId) {
        return normalize(itemId).endsWith("_pickaxe");
    }

    static boolean isShovelItemId(String itemId) {
        return normalize(itemId).endsWith("_shovel");
    }

    private static boolean requiresPickaxe(String id) {
        return id.equals("stone")
            || id.equals("cobblestone")
            || id.equals("mossy_cobblestone")
            || id.equals("deepslate")
            || id.equals("cobbled_deepslate")
            || id.equals("granite")
            || id.equals("diorite")
            || id.equals("andesite")
            || id.equals("tuff")
            || id.equals("calcite")
            || id.equals("dripstone_block")
            || id.equals("blackstone")
            || id.equals("basalt")
            || id.equals("smooth_basalt")
            || id.equals("netherrack")
            || id.equals("end_stone")
            || id.endsWith("_ore");
    }

    private static boolean isShovelOrHandBlock(String id) {
        return id.equals("dirt")
            || id.equals("coarse_dirt")
            || id.equals("rooted_dirt")
            || id.equals("grass_block")
            || id.equals("podzol")
            || id.equals("mycelium")
            || id.equals("sand")
            || id.equals("red_sand")
            || id.equals("gravel")
            || id.equals("clay")
            || id.equals("soul_sand")
            || id.equals("soul_soil")
            || id.equals("snow")
            || id.equals("snow_block");
    }

    private static boolean isKnownNonPickaxeBlock(String id) {
        return id.endsWith("_log")
            || id.endsWith("_wood")
            || id.endsWith("_stem")
            || id.endsWith("_hyphae")
            || id.endsWith("_leaves")
            || id.equals("grass")
            || id.equals("short_grass")
            || id.equals("fern")
            || id.equals("tall_grass")
            || id.equals("large_fern")
            || id.equals("vine")
            || id.endsWith("_vine")
            || id.endsWith("_vines");
    }

    private static String normalize(String value) {
        if (value == null) {
            return "";
        }
        String id = value.trim().toLowerCase(Locale.ROOT);
        int colon = id.indexOf(':');
        return colon >= 0 ? id.substring(colon + 1) : id;
    }
}
