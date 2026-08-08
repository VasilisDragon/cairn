package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class VillageHotbarStagingPlannerTest {
    @Test
    void existingTargetWinsWithoutMovingAnything() {
        List<VillageHotbarStagingPlanner.SlotState> slots = full(false);
        slots.set(6, slot(6, true, false, false, true));

        assertEquals(
            new VillageHotbarStagingPlanner.Plan(
                VillageHotbarStagingPlanner.Outcome.ALREADY_USABLE, 6),
            VillageHotbarStagingPlanner.plan(slots));
    }

    @Test
    void emptySlotWinsBeforeAnyFullHotbarSwap() {
        List<VillageHotbarStagingPlanner.SlotState> slots = full(false);
        slots.set(4, slot(4, false, true, false, false));
        slots.set(2, slot(2, false, false, false, false));

        assertEquals(
            new VillageHotbarStagingPlanner.Plan(
                VillageHotbarStagingPlanner.Outcome.EMPTY_SLOT, 4),
            VillageHotbarStagingPlanner.plan(slots));
    }

    @Test
    void fullHotbarUsesFirstUnselectedUnprotectedSlot() {
        List<VillageHotbarStagingPlanner.SlotState> slots = full(true);
        slots.set(1, slot(1, false, false, true, false));
        slots.set(3, slot(3, false, false, false, false));
        slots.set(7, slot(7, false, false, false, false));

        assertEquals(
            new VillageHotbarStagingPlanner.Plan(
                VillageHotbarStagingPlanner.Outcome.SAFE_SWAP, 3),
            VillageHotbarStagingPlanner.plan(slots));
    }

    @Test
    void selectedSlotIsNeverEvictedEvenWhenItIsOtherwiseUnprotected() {
        List<VillageHotbarStagingPlanner.SlotState> slots = full(true);
        slots.set(2, slot(2, false, false, true, false));

        assertEquals(
            new VillageHotbarStagingPlanner.Plan(
                VillageHotbarStagingPlanner.Outcome.NO_SAFE_SLOT, -1),
            VillageHotbarStagingPlanner.plan(slots));
    }

    @Test
    void allProtectedFullHotbarRejectsCleanly() {
        assertEquals(
            new VillageHotbarStagingPlanner.Plan(
                VillageHotbarStagingPlanner.Outcome.NO_SAFE_SLOT, -1),
            VillageHotbarStagingPlanner.plan(full(true)));
    }

    @Test
    void candidateOrderDoesNotChangeSlotRanking() {
        List<VillageHotbarStagingPlanner.SlotState> slots = full(true);
        slots.set(5, slot(5, false, false, false, false));
        java.util.Collections.reverse(slots);

        assertEquals(5, VillageHotbarStagingPlanner.plan(slots).slot());
    }

    @Test
    void actionCriticalClassificationCoversCurrentAndFutureExecutorItems() {
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("bread"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("minecraft:apple"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("golden_apple"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("iron_pickaxe"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("white_bed"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("water_bucket"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("flint_and_steel"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("shield"));
        assertEquals(true, VillageOpportunityExecutor.requiresActionHotbar("bow"));
        assertEquals(false, VillageOpportunityExecutor.requiresActionHotbar("iron_ingot"));
        assertEquals(false, VillageOpportunityExecutor.requiresActionHotbar("raw_iron"));
        assertEquals(false, VillageOpportunityExecutor.requiresActionHotbar("coal"));
        assertEquals(false, VillageOpportunityExecutor.requiresActionHotbar("arrow"));
    }

    @Test
    void fullInventorySwapMustConserveTargetAndDisplacedStacks() {
        Map<String, Integer> before = Map.of(
            "minecraft:bread", 1,
            "minecraft:wheat", 12,
            "minecraft:stone_sword", 1);

        assertEquals(true, VillageOpportunityExecutor.inventoryContainsAtLeast(
            before, Map.of(
                "minecraft:bread", 1,
                "minecraft:wheat", 12,
                "minecraft:stone_sword", 1)));
        assertEquals(true, VillageOpportunityExecutor.inventoryContainsAtLeast(
            before, Map.of(
                "minecraft:bread", 2,
                "minecraft:wheat", 12,
                "minecraft:stone_sword", 1)));
        assertEquals(false, VillageOpportunityExecutor.inventoryContainsAtLeast(
            before, Map.of(
                "minecraft:bread", 1,
                "minecraft:wheat", 11,
                "minecraft:stone_sword", 1)));
    }

    private static List<VillageHotbarStagingPlanner.SlotState> full(boolean protectedItem) {
        List<VillageHotbarStagingPlanner.SlotState> slots = new ArrayList<>();
        for (int index = 0; index < 9; index++) {
            slots.add(slot(index, false, false, false, protectedItem));
        }
        return slots;
    }

    private static VillageHotbarStagingPlanner.SlotState slot(
        int index,
        boolean target,
        boolean empty,
        boolean selected,
        boolean protectedItem
    ) {
        return new VillageHotbarStagingPlanner.SlotState(
            index, target, empty, selected, protectedItem);
    }
}
