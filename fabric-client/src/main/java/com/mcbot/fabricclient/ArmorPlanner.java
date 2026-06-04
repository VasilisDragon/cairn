package com.mcbot.fabricclient;

import java.util.EnumMap;
import java.util.Map;

final class ArmorPlanner {
    static final double REPLACE_BELOW_REMAINING_FRACTION = 0.05D;

    private ArmorPlanner() {
    }

    enum ArmorSlot {
        HELMET("iron_helmet", "craft_iron_helmet", 5),
        CHESTPLATE("iron_chestplate", "craft_iron_chestplate", 8),
        LEGGINGS("iron_leggings", "craft_iron_leggings", 7),
        BOOTS("iron_boots", "craft_iron_boots", 4);

        private final String itemId;
        private final String craftAction;
        private final int ironIngotsRequired;

        ArmorSlot(String itemId, String craftAction, int ironIngotsRequired) {
            this.itemId = itemId;
            this.craftAction = craftAction;
            this.ironIngotsRequired = ironIngotsRequired;
        }

        String itemId() {
            return itemId;
        }

        String craftAction() {
            return craftAction;
        }

        int ironIngotsRequired() {
            return ironIngotsRequired;
        }
    }

    enum Action {
        KEEP,
        EQUIP_SPARE,
        CRAFT_REPLACE,
        WAIT_FOR_MATERIALS
    }

    record SlotObservation(boolean equippedExpectedItem, double remainingFraction, int goodSpareCount, int ironIngots) {
    }

    record Decision(Action action, ArmorSlot slot, String reason, String craftAction) {
        static Decision keep() {
            return new Decision(Action.KEEP, null, "armor_ok", "");
        }
    }

    static Decision decide(ArmorSlot slot, SlotObservation observation) {
        if (slot == null || observation == null) {
            return Decision.keep();
        }
        boolean missingOrWrong = !observation.equippedExpectedItem();
        boolean nearBroken = observation.equippedExpectedItem()
            && observation.remainingFraction() >= 0.0D
            && observation.remainingFraction() < REPLACE_BELOW_REMAINING_FRACTION;
        if (!missingOrWrong && !nearBroken) {
            return Decision.keep();
        }
        String reason = missingOrWrong ? "missing_or_wrong" : "low_durability";
        if (observation.goodSpareCount() > 0) {
            return new Decision(Action.EQUIP_SPARE, slot, reason + ":spare_available", "");
        }
        if (observation.ironIngots() >= slot.ironIngotsRequired()) {
            return new Decision(Action.CRAFT_REPLACE, slot, reason + ":craft_available", slot.craftAction());
        }
        return new Decision(Action.WAIT_FOR_MATERIALS, slot, reason + ":no_replacement", "");
    }

    static Decision decideFirst(Map<ArmorSlot, SlotObservation> observations) {
        if (observations == null || observations.isEmpty()) {
            return Decision.keep();
        }
        EnumMap<ArmorSlot, SlotObservation> ordered = new EnumMap<>(ArmorSlot.class);
        ordered.putAll(observations);
        for (ArmorSlot slot : ArmorSlot.values()) {
            Decision decision = decide(slot, ordered.get(slot));
            if (decision.action() != Action.KEEP) {
                return decision;
            }
        }
        return Decision.keep();
    }
}
