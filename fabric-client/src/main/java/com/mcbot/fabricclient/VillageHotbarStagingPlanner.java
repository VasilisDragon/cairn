package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Pure, deterministic destination policy for one village-acquired action item. */
final class VillageHotbarStagingPlanner {
    enum Outcome {
        ALREADY_USABLE,
        EMPTY_SLOT,
        SAFE_SWAP,
        NO_SAFE_SLOT
    }

    record SlotState(
        int index,
        boolean containsTarget,
        boolean empty,
        boolean selected,
        boolean protectedItem
    ) {
        SlotState {
            if (index < 0 || index > 8) {
                throw new IllegalArgumentException("hotbar index must be 0..8");
            }
            if (containsTarget && empty) {
                throw new IllegalArgumentException("target slot cannot be empty");
            }
        }
    }

    record Plan(Outcome outcome, int slot) {
        Plan {
            outcome = outcome == null ? Outcome.NO_SAFE_SLOT : outcome;
            if (outcome == Outcome.NO_SAFE_SLOT) {
                slot = -1;
            } else if (slot < 0 || slot > 8) {
                throw new IllegalArgumentException("selected hotbar slot must be 0..8");
            }
        }
    }

    private VillageHotbarStagingPlanner() {
    }

    static Plan plan(List<SlotState> rawSlots) {
        if (rawSlots == null || rawSlots.isEmpty()) {
            return new Plan(Outcome.NO_SAFE_SLOT, -1);
        }
        List<SlotState> slots = new ArrayList<>(rawSlots);
        slots.sort(Comparator.comparingInt(SlotState::index));
        Set<Integer> indexes = new HashSet<>();
        for (SlotState slot : slots) {
            if (slot == null || !indexes.add(slot.index())) {
                return new Plan(Outcome.NO_SAFE_SLOT, -1);
            }
        }
        for (SlotState slot : slots) {
            if (slot.containsTarget()) {
                return new Plan(Outcome.ALREADY_USABLE, slot.index());
            }
        }
        for (SlotState slot : slots) {
            if (slot.empty()) {
                return new Plan(Outcome.EMPTY_SLOT, slot.index());
            }
        }
        for (SlotState slot : slots) {
            if (!slot.selected() && !slot.protectedItem()) {
                return new Plan(Outcome.SAFE_SWAP, slot.index());
            }
        }
        return new Plan(Outcome.NO_SAFE_SLOT, -1);
    }
}
