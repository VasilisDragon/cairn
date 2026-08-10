package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * Pure, immutable, bounded representation of the Fabric player's verified inventory and equipment.
 *
 * <p>The live adapter supplies registry IDs and registry-derived food values. This class performs no
 * recipe conversion and never treats hay or wheat as edible inventory. Its 128-ID cap is larger than a
 * vanilla player's distinct carried-stack capacity; malformed oversized inputs are deterministically
 * truncated and explicitly marked incomplete.
 */
final class FabricInventorySnapshot {
    static final int MAX_DISTINCT_ITEM_IDS = 128;
    static final int MAX_COUNT_PER_ITEM = 65_535;
    static final int MAX_NUTRITION_POINTS = 1_000_000;
    static final int MAX_DURABLE_INVENTORY_STACKS = 64;

    enum EquipmentSlot {
        MAIN_HAND,
        OFF_HAND,
        HEAD,
        CHEST,
        LEGS,
        FEET
    }

    /** One observed carried stack. Nutrition is the verified food-component value for one item. */
    record ItemObservation(String itemId, int count, int nutritionPerItem) {
    }

    record EquipmentObservation(
        EquipmentSlot slot,
        String itemId,
        int count,
        int maxDurability,
        int damage
    ) {
    }

    record DurabilityObservation(
        int inventorySlot,
        String itemId,
        int count,
        int maxDurability,
        int damage
    ) {
    }

    record DurableItem(
        int inventorySlot,
        String itemId,
        int count,
        int maxDurability,
        int damage,
        int remainingDurability
    ) {
    }

    record EquipmentItem(
        EquipmentSlot slot,
        String itemId,
        int count,
        int maxDurability,
        int damage,
        int remainingDurability
    ) {
    }

    record NutritionReserve(
        int currentFoodLevel,
        float currentSaturation,
        int carriedNutrition,
        int breadNutrition
    ) {
        NutritionReserve {
            currentFoodLevel = clamp(currentFoodLevel, 0, 20);
            currentSaturation = Float.isFinite(currentSaturation)
                ? Math.max(0.0F, Math.min(20.0F, currentSaturation))
                : 0.0F;
            carriedNutrition = clamp(carriedNutrition, 0, MAX_NUTRITION_POINTS);
            breadNutrition = clamp(breadNutrition, 0, MAX_NUTRITION_POINTS);
        }
    }

    private final Map<String, Integer> itemCounts;
    private final List<DurableItem> durableInventory;
    private final Map<EquipmentSlot, EquipmentItem> equipment;
    private final int woolCount;
    private final int bedCount;
    private final int hayBaleCount;
    private final int wheatCount;
    private final int breadCount;
    private final NutritionReserve nutritionReserve;
    private final boolean itemCountsTruncated;
    private final int omittedDistinctItemIds;
    private final int omittedItemCount;
    private final boolean durableInventoryTruncated;
    private final int omittedDurableStacks;

    private FabricInventorySnapshot(
        Map<String, Integer> itemCounts,
        List<DurableItem> durableInventory,
        Map<EquipmentSlot, EquipmentItem> equipment,
        int woolCount,
        int bedCount,
        int hayBaleCount,
        int wheatCount,
        int breadCount,
        NutritionReserve nutritionReserve,
        boolean itemCountsTruncated,
        int omittedDistinctItemIds,
        int omittedItemCount,
        boolean durableInventoryTruncated,
        int omittedDurableStacks
    ) {
        this.itemCounts = immutableOrderedItemMap(itemCounts);
        this.durableInventory = durableInventory == null ? List.of() : List.copyOf(durableInventory);
        this.equipment = immutableEquipmentMap(equipment);
        this.woolCount = Math.max(0, woolCount);
        this.bedCount = Math.max(0, bedCount);
        this.hayBaleCount = Math.max(0, hayBaleCount);
        this.wheatCount = Math.max(0, wheatCount);
        this.breadCount = Math.max(0, breadCount);
        this.nutritionReserve = nutritionReserve == null
            ? new NutritionReserve(0, 0.0F, 0, 0)
            : nutritionReserve;
        this.itemCountsTruncated = itemCountsTruncated;
        this.omittedDistinctItemIds = Math.max(0, omittedDistinctItemIds);
        this.omittedItemCount = Math.max(0, omittedItemCount);
        this.durableInventoryTruncated = durableInventoryTruncated;
        this.omittedDurableStacks = Math.max(0, omittedDurableStacks);
    }

    static FabricInventorySnapshot capture(
        List<ItemObservation> carriedStacks,
        List<EquipmentObservation> equipment,
        int currentFoodLevel,
        float currentSaturation
    ) {
        return capture(carriedStacks, List.of(), equipment, currentFoodLevel, currentSaturation);
    }

    static FabricInventorySnapshot capture(
        List<ItemObservation> carriedStacks,
        List<DurabilityObservation> durability,
        List<EquipmentObservation> equipment,
        int currentFoodLevel,
        float currentSaturation
    ) {
        TreeMap<String, CountAndNutrition> aggregated = new TreeMap<>();
        if (carriedStacks != null) {
            for (ItemObservation observation : carriedStacks) {
                if (observation == null || observation.count() <= 0) {
                    continue;
                }
                String itemId = canonicalItemId(observation.itemId());
                if (itemId.isBlank()) {
                    continue;
                }
                long count = observation.count();
                int nutrition = Math.max(0, observation.nutritionPerItem());
                CountAndNutrition current = aggregated.get(itemId);
                if (current == null) {
                    aggregated.put(itemId, new CountAndNutrition(count, nutrition));
                } else {
                    aggregated.put(itemId, new CountAndNutrition(
                        saturatedAdd(current.count(), count),
                        conservativeNutrition(current.nutritionPerItem(), nutrition)
                    ));
                }
            }
        }

        Map<String, Integer> boundedCounts = new LinkedHashMap<>();
        long omittedCount = 0L;
        int kept = 0;
        for (Map.Entry<String, CountAndNutrition> entry : aggregated.entrySet()) {
            if (kept++ < MAX_DISTINCT_ITEM_IDS) {
                int boundedCount = (int) Math.min(MAX_COUNT_PER_ITEM, entry.getValue().count());
                boundedCounts.put(entry.getKey(), boundedCount);
                omittedCount = saturatedAdd(omittedCount, entry.getValue().count() - boundedCount);
            } else {
                omittedCount = saturatedAdd(omittedCount, entry.getValue().count());
            }
        }
        int omittedIds = Math.max(0, aggregated.size() - MAX_DISTINCT_ITEM_IDS);

        int wool = categoryCount(boundedCounts, id -> id.endsWith("_wool"));
        int beds = categoryCount(boundedCounts, id -> id.endsWith("_bed"));
        int hay = boundedCounts.getOrDefault("minecraft:hay_block", 0);
        int wheat = boundedCounts.getOrDefault("minecraft:wheat", 0);
        int bread = boundedCounts.getOrDefault("minecraft:bread", 0);
        int carriedNutrition = 0;
        for (Map.Entry<String, Integer> entry : boundedCounts.entrySet()) {
            CountAndNutrition facts = aggregated.get(entry.getKey());
            carriedNutrition = saturatedNutrition(
                carriedNutrition,
                saturatedMultiply(entry.getValue(), facts == null ? 0 : facts.nutritionPerItem())
            );
        }
        int breadNutrition = saturatedNutrition(0, saturatedMultiply(bread, 5));

        DurabilitySelection durableSelection = canonicalDurability(durability);
        return new FabricInventorySnapshot(
            boundedCounts,
            durableSelection.items(),
            canonicalEquipment(equipment),
            wool,
            beds,
            hay,
            wheat,
            bread,
            new NutritionReserve(currentFoodLevel, currentSaturation, carriedNutrition, breadNutrition),
            omittedIds > 0 || omittedCount > 0,
            omittedIds,
            (int) Math.min(Integer.MAX_VALUE, omittedCount),
            durableSelection.omittedStacks() > 0,
            durableSelection.omittedStacks()
        );
    }

    Map<String, Integer> itemCounts() {
        return itemCounts;
    }

    List<DurableItem> durableInventory() {
        return durableInventory;
    }

    int count(String itemId) {
        String canonical = canonicalItemId(itemId);
        return canonical.isBlank() ? 0 : itemCounts.getOrDefault(canonical, 0);
    }

    Map<EquipmentSlot, EquipmentItem> equipment() {
        return equipment;
    }

    EquipmentItem equipped(EquipmentSlot slot) {
        return slot == null ? null : equipment.get(slot);
    }

    int totalEquippedRemainingDurability(String itemId) {
        String canonical = canonicalItemId(itemId);
        if (canonical.isBlank()) {
            return 0;
        }
        long total = 0L;
        for (EquipmentItem item : equipment.values()) {
            if (canonical.equals(item.itemId())) {
                total = saturatedAdd(total, item.remainingDurability());
            }
        }
        return (int) Math.min(Integer.MAX_VALUE, total);
    }

    int totalInventoryRemainingDurability(String itemId) {
        String canonical = canonicalItemId(itemId);
        if (canonical.isBlank()) {
            return 0;
        }
        long total = 0L;
        for (DurableItem item : durableInventory) {
            if (canonical.equals(item.itemId())) {
                total = saturatedAdd(
                    total,
                    (long) item.remainingDurability() * Math.max(1, item.count())
                );
            }
        }
        return (int) Math.min(Integer.MAX_VALUE, total);
    }

    /** Full inventory durability wins; equipped fallback supports adapters that have not supplied slots. */
    int totalRemainingDurability(String itemId) {
        String canonical = canonicalItemId(itemId);
        if (canonical.isBlank()) {
            return 0;
        }
        boolean inventoryObserved = durableInventory.stream()
            .anyMatch(item -> canonical.equals(item.itemId()));
        return inventoryObserved
            ? totalInventoryRemainingDurability(canonical)
            : totalEquippedRemainingDurability(canonical);
    }

    int woolCount() {
        return woolCount;
    }

    int bedCount() {
        return bedCount;
    }

    int hayBaleCount() {
        return hayBaleCount;
    }

    int wheatCount() {
        return wheatCount;
    }

    int breadCount() {
        return breadCount;
    }

    NutritionReserve nutritionReserve() {
        return nutritionReserve;
    }

    boolean itemCountsTruncated() {
        return itemCountsTruncated;
    }

    int omittedDistinctItemIds() {
        return omittedDistinctItemIds;
    }

    int omittedItemCount() {
        return omittedItemCount;
    }

    boolean durableInventoryTruncated() {
        return durableInventoryTruncated;
    }

    int omittedDurableStacks() {
        return omittedDurableStacks;
    }

    private static Map<EquipmentSlot, EquipmentItem> canonicalEquipment(
        List<EquipmentObservation> observations
    ) {
        EnumMap<EquipmentSlot, EquipmentItem> selected = new EnumMap<>(EquipmentSlot.class);
        if (observations == null) {
            return selected;
        }
        for (EquipmentObservation observation : observations) {
            if (observation == null || observation.slot() == null || observation.count() <= 0) {
                continue;
            }
            String itemId = canonicalItemId(observation.itemId());
            if (itemId.isBlank()) {
                continue;
            }
            int maxDurability = Math.max(0, observation.maxDurability());
            int damage = maxDurability <= 0 ? 0 : clamp(observation.damage(), 0, maxDurability);
            EquipmentItem candidate = new EquipmentItem(
                observation.slot(),
                itemId,
                Math.min(MAX_COUNT_PER_ITEM, observation.count()),
                maxDurability,
                damage,
                Math.max(0, maxDurability - damage)
            );
            EquipmentItem current = selected.get(observation.slot());
            if (current == null || equipmentPreference().compare(candidate, current) < 0) {
                selected.put(observation.slot(), candidate);
            }
        }
        return selected;
    }

    private static DurabilitySelection canonicalDurability(List<DurabilityObservation> observations) {
        if (observations == null || observations.isEmpty()) {
            return new DurabilitySelection(List.of(), 0);
        }
        Map<Integer, DurableItem> selected = new TreeMap<>();
        for (DurabilityObservation observation : observations) {
            if (observation == null
                || observation.inventorySlot() < 0
                || observation.count() <= 0
                || observation.maxDurability() <= 0) {
                continue;
            }
            String itemId = canonicalItemId(observation.itemId());
            if (itemId.isBlank()) {
                continue;
            }
            int maxDurability = observation.maxDurability();
            int damage = clamp(observation.damage(), 0, maxDurability);
            DurableItem candidate = new DurableItem(
                observation.inventorySlot(),
                itemId,
                Math.min(MAX_COUNT_PER_ITEM, observation.count()),
                maxDurability,
                damage,
                maxDurability - damage
            );
            DurableItem current = selected.get(observation.inventorySlot());
            if (current == null || durablePreference().compare(candidate, current) < 0) {
                selected.put(observation.inventorySlot(), candidate);
            }
        }
        List<DurableItem> items = selected.values().stream()
            .limit(MAX_DURABLE_INVENTORY_STACKS)
            .toList();
        return new DurabilitySelection(
            items,
            Math.max(0, selected.size() - MAX_DURABLE_INVENTORY_STACKS)
        );
    }

    private static Comparator<EquipmentItem> equipmentPreference() {
        return Comparator.comparingInt(EquipmentItem::remainingDurability).reversed()
            .thenComparing(Comparator.comparingInt(EquipmentItem::maxDurability).reversed())
            .thenComparing(EquipmentItem::itemId)
            .thenComparing(Comparator.comparingInt(EquipmentItem::count).reversed());
    }

    private static Comparator<DurableItem> durablePreference() {
        return Comparator.comparingInt(DurableItem::remainingDurability).reversed()
            .thenComparing(Comparator.comparingInt(DurableItem::maxDurability).reversed())
            .thenComparing(DurableItem::itemId)
            .thenComparing(Comparator.comparingInt(DurableItem::count).reversed());
    }

    private static Map<String, Integer> immutableOrderedItemMap(Map<String, Integer> source) {
        LinkedHashMap<String, Integer> copy = new LinkedHashMap<>();
        if (source != null) {
            source.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(entry -> copy.put(entry.getKey(), entry.getValue()));
        }
        return Collections.unmodifiableMap(copy);
    }

    private static Map<EquipmentSlot, EquipmentItem> immutableEquipmentMap(
        Map<EquipmentSlot, EquipmentItem> source
    ) {
        EnumMap<EquipmentSlot, EquipmentItem> copy = new EnumMap<>(EquipmentSlot.class);
        if (source != null) {
            copy.putAll(source);
        }
        return Collections.unmodifiableMap(copy);
    }

    private static int categoryCount(Map<String, Integer> counts, java.util.function.Predicate<String> predicate) {
        int total = 0;
        for (Map.Entry<String, Integer> entry : counts.entrySet()) {
            if (predicate.test(entry.getKey())) {
                total = saturatedItemCount(total, entry.getValue());
            }
        }
        return total;
    }

    static String canonicalItemId(String itemId) {
        if (itemId == null || itemId.isBlank()) {
            return "";
        }
        String normalized = itemId.trim().toLowerCase(Locale.ROOT);
        if (!normalized.contains(":")) {
            normalized = "minecraft:" + normalized;
        }
        int separator = normalized.indexOf(':');
        if (separator <= 0 || separator != normalized.lastIndexOf(':') || separator == normalized.length() - 1) {
            return "";
        }
        String namespace = normalized.substring(0, separator);
        String path = normalized.substring(separator + 1);
        return namespace.matches("[a-z0-9_.-]+") && path.matches("[a-z0-9_./-]+")
            ? normalized
            : "";
    }

    private static int conservativeNutrition(int left, int right) {
        if (left <= 0 || right <= 0) {
            return 0;
        }
        return Math.min(left, right);
    }

    private static int saturatedItemCount(int left, int right) {
        return (int) Math.min(MAX_COUNT_PER_ITEM, saturatedAdd(Math.max(0, left), Math.max(0, right)));
    }

    private static int saturatedMultiply(int left, int right) {
        return (int) Math.min(
            MAX_NUTRITION_POINTS,
            (long) Math.max(0, left) * (long) Math.max(0, right)
        );
    }

    private static int saturatedNutrition(int left, int right) {
        return (int) Math.min(MAX_NUTRITION_POINTS, saturatedAdd(Math.max(0, left), Math.max(0, right)));
    }

    private static long saturatedAdd(long left, long right) {
        if (left > Long.MAX_VALUE - right) {
            return Long.MAX_VALUE;
        }
        return left + right;
    }

    private static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    private record CountAndNutrition(long count, int nutritionPerItem) {
    }

    private record DurabilitySelection(List<DurableItem> items, int omittedStacks) {
    }
}
