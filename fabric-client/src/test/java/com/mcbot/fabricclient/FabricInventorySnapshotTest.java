package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class FabricInventorySnapshotTest {
    @Test
    void canonicalCountsAndResourceSummariesAreExactAndImmutable() {
        FabricInventorySnapshot snapshot = FabricInventorySnapshot.capture(
            List.of(
                item("oak_log", 2, 0),
                item(" MINECRAFT:OAK_LOG ", 3, 0),
                item("white_wool", 2, 0),
                item("minecraft:black_wool", 1, 0),
                item("red_bed", 2, 0),
                item("hay_block", 4, 0),
                item("wheat", 7, 0),
                item("bread", 2, 5),
                item("apple", 4, 4)
            ),
            List.of(),
            11,
            3.5F
        );

        assertEquals(5, snapshot.count("minecraft:oak_log"));
        assertEquals(5, snapshot.count("OAK_LOG"));
        assertEquals(3, snapshot.woolCount());
        assertEquals(2, snapshot.bedCount());
        assertEquals(4, snapshot.hayBaleCount());
        assertEquals(7, snapshot.wheatCount());
        assertEquals(2, snapshot.breadCount());
        assertEquals(26, snapshot.nutritionReserve().carriedNutrition());
        assertEquals(10, snapshot.nutritionReserve().breadNutrition());
        assertEquals(11, snapshot.nutritionReserve().currentFoodLevel());
        assertEquals(3.5F, snapshot.nutritionReserve().currentSaturation());
        assertFalse(snapshot.itemCountsTruncated());
        assertThrows(
            UnsupportedOperationException.class,
            () -> snapshot.itemCounts().put("minecraft:stone", 1)
        );
    }

    @Test
    void hayAndWheatAreNotInventedAsEdibleNutrition() {
        FabricInventorySnapshot snapshot = FabricInventorySnapshot.capture(
            List.of(item("hay_block", 64, 0), item("wheat", 64, 0)),
            List.of(),
            20,
            5.0F
        );

        assertEquals(0, snapshot.nutritionReserve().carriedNutrition());
        assertEquals(0, snapshot.nutritionReserve().breadNutrition());
    }

    @Test
    void oversizedInputUsesAStableLexicalCapAndReportsEverythingOmitted() {
        List<FabricInventorySnapshot.ItemObservation> ascending = new ArrayList<>();
        for (int index = 0; index < FabricInventorySnapshot.MAX_DISTINCT_ITEM_IDS + 2; index++) {
            ascending.add(item("test:item" + String.format("%03d", index), index + 1, 0));
        }
        List<FabricInventorySnapshot.ItemObservation> descending = new ArrayList<>(ascending);
        Collections.reverse(descending);

        FabricInventorySnapshot first = FabricInventorySnapshot.capture(ascending, List.of(), 0, 0);
        FabricInventorySnapshot second = FabricInventorySnapshot.capture(descending, List.of(), 0, 0);

        assertEquals(first.itemCounts(), second.itemCounts());
        assertEquals(FabricInventorySnapshot.MAX_DISTINCT_ITEM_IDS, first.itemCounts().size());
        assertTrue(first.itemCountsTruncated());
        assertEquals(2, first.omittedDistinctItemIds());
        assertEquals(129 + 130, first.omittedItemCount());
        assertTrue(first.itemCounts().containsKey("test:item000"));
        assertTrue(first.itemCounts().containsKey("test:item127"));
        assertFalse(first.itemCounts().containsKey("test:item128"));
        assertEquals(
            first.itemCounts().keySet().stream().sorted().toList(),
            new ArrayList<>(first.itemCounts().keySet())
        );
    }

    @Test
    void duplicateCountsSaturateAndMalformedObservationsAreIgnored() {
        FabricInventorySnapshot snapshot = FabricInventorySnapshot.capture(
            List.of(
                item("stone", Integer.MAX_VALUE, 0),
                item("minecraft:stone", Integer.MAX_VALUE, 0),
                item("bad id", 12, 0),
                item("minecraft:", 12, 0),
                item("dirt", -1, 0)
            ),
            null,
            -5,
            Float.NaN
        );

        assertEquals(FabricInventorySnapshot.MAX_COUNT_PER_ITEM, snapshot.count("stone"));
        assertEquals(1, snapshot.itemCounts().size());
        assertTrue(snapshot.itemCountsTruncated());
        assertTrue(snapshot.omittedItemCount() > 0);
        assertEquals(0, snapshot.nutritionReserve().currentFoodLevel());
        assertEquals(0.0F, snapshot.nutritionReserve().currentSaturation());
    }

    @Test
    void equipmentDurabilityIsClampedAndDuplicateSlotsResolveIndependentOfOrder() {
        List<FabricInventorySnapshot.EquipmentObservation> observations = List.of(
            equipment(FabricInventorySnapshot.EquipmentSlot.MAIN_HAND, "iron_pickaxe", 1, 250, 245),
            equipment(FabricInventorySnapshot.EquipmentSlot.MAIN_HAND, "stone_pickaxe", 1, 131, 20),
            equipment(FabricInventorySnapshot.EquipmentSlot.HEAD, "iron_helmet", 1, 165, -5),
            equipment(FabricInventorySnapshot.EquipmentSlot.OFF_HAND, "torch", 12, 0, 99)
        );
        List<FabricInventorySnapshot.EquipmentObservation> reversed = new ArrayList<>(observations);
        Collections.reverse(reversed);

        List<FabricInventorySnapshot.DurabilityObservation> durable = List.of(
            durability(9, "stone_pickaxe", 1, 131, 30),
            durability(3, "stone_pickaxe", 1, 131, 100),
            durability(9, "iron_pickaxe", 1, 250, 249)
        );
        List<FabricInventorySnapshot.DurabilityObservation> durableReversed = new ArrayList<>(durable);
        Collections.reverse(durableReversed);
        FabricInventorySnapshot first = FabricInventorySnapshot.capture(
            List.of(), durable, observations, 0, 0);
        FabricInventorySnapshot second = FabricInventorySnapshot.capture(
            List.of(), durableReversed, reversed, 0, 0);

        assertEquals(first.equipment(), second.equipment());
        assertEquals("minecraft:stone_pickaxe", first.equipped(FabricInventorySnapshot.EquipmentSlot.MAIN_HAND).itemId());
        assertEquals(111, first.equipped(FabricInventorySnapshot.EquipmentSlot.MAIN_HAND).remainingDurability());
        assertEquals(165, first.equipped(FabricInventorySnapshot.EquipmentSlot.HEAD).remainingDurability());
        assertEquals(0, first.equipped(FabricInventorySnapshot.EquipmentSlot.OFF_HAND).remainingDurability());
        assertEquals(first.durableInventory(), second.durableInventory());
        assertEquals(List.of(3, 9), first.durableInventory().stream()
            .map(FabricInventorySnapshot.DurableItem::inventorySlot).toList());
        assertEquals("minecraft:stone_pickaxe", first.durableInventory().get(1).itemId());
        assertEquals(31 + 101, first.totalInventoryRemainingDurability("stone_pickaxe"));
        assertEquals(111, first.totalEquippedRemainingDurability("stone_pickaxe"));
        assertEquals(31 + 101, first.totalRemainingDurability("stone_pickaxe"));
        assertNull(first.equipped(null));
        assertThrows(
            UnsupportedOperationException.class,
            () -> first.equipment().put(
                FabricInventorySnapshot.EquipmentSlot.FEET,
                first.equipped(FabricInventorySnapshot.EquipmentSlot.HEAD)
            )
        );
        assertThrows(
            UnsupportedOperationException.class,
            () -> first.durableInventory().add(first.durableInventory().getFirst())
        );
    }

    @Test
    void conflictingFoodFactsFailClosedToZeroNutritionForThatItem() {
        FabricInventorySnapshot snapshot = FabricInventorySnapshot.capture(
            List.of(item("bread", 1, 5), item("bread", 1, 0)),
            List.of(),
            0,
            0
        );

        assertEquals(2, snapshot.breadCount());
        assertEquals(0, snapshot.nutritionReserve().carriedNutrition());
        assertEquals(10, snapshot.nutritionReserve().breadNutrition());
    }

    @Test
    void durableInventoryCapIsStableAndExplicit() {
        List<FabricInventorySnapshot.DurabilityObservation> ascending = new ArrayList<>();
        for (int slot = 0; slot < FabricInventorySnapshot.MAX_DURABLE_INVENTORY_STACKS + 2; slot++) {
            ascending.add(durability(slot, "tool_" + slot, 1, 100, slot));
        }
        List<FabricInventorySnapshot.DurabilityObservation> descending = new ArrayList<>(ascending);
        Collections.reverse(descending);

        FabricInventorySnapshot first = FabricInventorySnapshot.capture(
            List.of(), ascending, List.of(), 0, 0);
        FabricInventorySnapshot second = FabricInventorySnapshot.capture(
            List.of(), descending, List.of(), 0, 0);

        assertEquals(first.durableInventory(), second.durableInventory());
        assertEquals(FabricInventorySnapshot.MAX_DURABLE_INVENTORY_STACKS, first.durableInventory().size());
        assertTrue(first.durableInventoryTruncated());
        assertEquals(2, first.omittedDurableStacks());
        assertEquals(0, first.durableInventory().getFirst().inventorySlot());
        assertEquals(63, first.durableInventory().getLast().inventorySlot());
    }

    @Test
    void observedBrokenInventoryToolDoesNotFallBackToDuplicatedEquipmentDurability() {
        FabricInventorySnapshot snapshot = FabricInventorySnapshot.capture(
            List.of(),
            List.of(durability(0, "stone_pickaxe", 1, 131, 131)),
            List.of(equipment(
                FabricInventorySnapshot.EquipmentSlot.MAIN_HAND,
                "stone_pickaxe",
                1,
                131,
                10
            )),
            0,
            0
        );

        assertEquals(0, snapshot.totalInventoryRemainingDurability("stone_pickaxe"));
        assertEquals(121, snapshot.totalEquippedRemainingDurability("stone_pickaxe"));
        assertEquals(0, snapshot.totalRemainingDurability("stone_pickaxe"));
    }

    private FabricInventorySnapshot.ItemObservation item(String id, int count, int nutrition) {
        return new FabricInventorySnapshot.ItemObservation(id, count, nutrition);
    }

    private FabricInventorySnapshot.EquipmentObservation equipment(
        FabricInventorySnapshot.EquipmentSlot slot,
        String id,
        int count,
        int maxDurability,
        int damage
    ) {
        return new FabricInventorySnapshot.EquipmentObservation(slot, id, count, maxDurability, damage);
    }

    private FabricInventorySnapshot.DurabilityObservation durability(
        int slot,
        String id,
        int count,
        int maxDurability,
        int damage
    ) {
        return new FabricInventorySnapshot.DurabilityObservation(slot, id, count, maxDurability, damage);
    }
}
