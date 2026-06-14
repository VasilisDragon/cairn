package com.mcbot.fabricclient;

final class IronMiningTargetDeltaPlanner {
    private IronMiningTargetDeltaPlanner() {
    }

    record ArmorState(
        boolean helmetEquipped,
        boolean chestplateEquipped,
        boolean leggingsEquipped,
        boolean bootsEquipped,
        int spareHelmets,
        int spareChestplates,
        int spareLeggings,
        int spareBoots
    ) {
        boolean isSatisfied(ArmorPlanner.ArmorSlot slot) {
            return switch (slot) {
                case HELMET -> helmetEquipped || spareHelmets > 0;
                case CHESTPLATE -> chestplateEquipped || spareChestplates > 0;
                case LEGGINGS -> leggingsEquipped || spareLeggings > 0;
                case BOOTS -> bootsEquipped || spareBoots > 0;
            };
        }
    }

    static int targetDelta(
        int rawIron,
        int ironIngots,
        int ironPickaxes,
        ArmorState armor,
        int defaultPickaxeDelta,
        int maxArmorDelta
    ) {
        int carriedIron = Math.max(0, rawIron) + Math.max(0, ironIngots);
        int safeDefault = Math.max(0, defaultPickaxeDelta);
        int safeMax = Math.max(safeDefault, maxArmorDelta);
        if (ironPickaxes <= 0) {
            return clamp(safeDefault - carriedIron, 0, safeMax);
        }
        ArmorState safeArmor = armor == null ? new ArmorState(false, false, false, false, 0, 0, 0, 0) : armor;
        for (ArmorPlanner.ArmorSlot slot : ArmorPlanner.ArmorSlot.values()) {
            if (!safeArmor.isSatisfied(slot)) {
                return clamp(slot.ironIngotsRequired() - carriedIron, 0, safeMax);
            }
        }
        return safeDefault;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
