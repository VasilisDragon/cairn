package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class RawIronFuelAdmissionPlanner {
    private RawIronFuelAdmissionPlanner() {
    }

    enum Outcome {
        REUSE_LOADED,
        INSERT_SOURCE,
        TOP_UP_SAME_ITEM,
        UNAVAILABLE,
        BLOCKED_SLOT
    }

    enum SourceClass {
        EFFICIENT,
        LOG,
        PLANK,
        INVALID
    }

    enum RuntimeSourceDecision {
        READY,
        NEUTRAL_UNAVAILABLE,
        NORMAL_FAILURE
    }

    record InventoryFuelStack(int slot, String itemId, int count, SourceClass sourceClass) {
        InventoryFuelStack {
            itemId = normalizeItemId(itemId);
            count = Math.max(0, count);
            sourceClass = sourceClass == null ? SourceClass.INVALID : sourceClass;
        }
    }

    record Request(
        int desiredBatch,
        String loadedItemId,
        int loadedCount,
        SourceClass loadedClass,
        List<InventoryFuelStack> inventoryFuelStacks,
        int totalInventoryPlanks,
        int protectedPlanks
    ) {
        Request {
            desiredBatch = Math.max(1, desiredBatch);
            loadedItemId = normalizeItemId(loadedItemId);
            loadedCount = Math.max(0, loadedCount);
            loadedClass = loadedClass == null ? SourceClass.INVALID : loadedClass;
            inventoryFuelStacks = inventoryFuelStacks == null
                ? List.of()
                : List.copyOf(inventoryFuelStacks);
            totalInventoryPlanks = Math.max(0, totalInventoryPlanks);
            protectedPlanks = Math.max(0, protectedPlanks);
        }
    }

    record Plan(
        Outcome outcome,
        SourceClass sourceClass,
        String sourceItemId,
        int sourceSlot,
        int requiredFuelCount,
        int loadedFuelCount,
        int insertCount,
        String reason
    ) {
        Plan {
            outcome = outcome == null ? Outcome.UNAVAILABLE : outcome;
            sourceClass = sourceClass == null ? SourceClass.INVALID : sourceClass;
            sourceItemId = normalizeItemId(sourceItemId);
            requiredFuelCount = Math.max(0, requiredFuelCount);
            loadedFuelCount = Math.max(0, loadedFuelCount);
            insertCount = Math.max(0, insertCount);
            reason = reason == null ? "" : reason;
        }
    }

    static Plan plan(Request request) {
        if (request == null) {
            return unavailable("missing_request");
        }
        List<InventoryFuelStack> stacks = normalizedStacks(request.inventoryFuelStacks());
        if (request.loadedCount() > 0) {
            if (request.loadedClass() == SourceClass.INVALID || request.loadedItemId().isBlank()) {
                return new Plan(
                    Outcome.BLOCKED_SLOT,
                    SourceClass.INVALID,
                    request.loadedItemId(),
                    -1,
                    0,
                    request.loadedCount(),
                    0,
                    "blocked_fuel_slot"
                );
            }
            int required = requiredFuelCount(request.desiredBatch(), request.loadedClass());
            if (request.loadedCount() >= required) {
                return new Plan(
                    Outcome.REUSE_LOADED,
                    request.loadedClass(),
                    request.loadedItemId(),
                    -1,
                    required,
                    request.loadedCount(),
                    0,
                    "loaded_fuel_sufficient"
                );
            }
            int missing = required - request.loadedCount();
            if (request.loadedClass() == SourceClass.PLANK
                && request.totalInventoryPlanks() - missing < request.protectedPlanks()) {
                return blockedShortLoaded(request, required, "plank_reserve");
            }
            FuelGroup matching = groupForItem(stacks, request.loadedItemId(), request.loadedClass());
            if (matching == null || matching.count() < missing) {
                return blockedShortLoaded(request, required, "compatible_top_up_missing");
            }
            return new Plan(
                Outcome.TOP_UP_SAME_ITEM,
                request.loadedClass(),
                request.loadedItemId(),
                matching.firstSlot(),
                required,
                request.loadedCount(),
                missing,
                "top_up_same_item"
            );
        }

        for (SourceClass sourceClass : List.of(SourceClass.EFFICIENT, SourceClass.LOG, SourceClass.PLANK)) {
            int required = requiredFuelCount(request.desiredBatch(), sourceClass);
            if (sourceClass == SourceClass.PLANK
                && request.totalInventoryPlanks() - required < request.protectedPlanks()) {
                continue;
            }
            FuelGroup source = firstSufficientGroup(stacks, sourceClass, required);
            if (source != null) {
                return new Plan(
                    Outcome.INSERT_SOURCE,
                    sourceClass,
                    source.itemId(),
                    source.firstSlot(),
                    required,
                    0,
                    required,
                    "inventory_fuel_available"
                );
            }
        }
        return unavailable("inventory_fuel_unavailable");
    }

    static int requiredFuelCount(int desiredBatch, SourceClass sourceClass) {
        int batch = Math.max(1, desiredBatch);
        return sourceClass == SourceClass.EFFICIENT
            ? Math.max(1, (batch + 7) / 8)
            : Math.max(1, (batch * 2 + 2) / 3);
    }

    static boolean insertionVerified(
        Plan plan,
        String expectedItemId,
        String observedItemId,
        int observedCount,
        int insertedCount,
        boolean inputAlreadyLoaded
    ) {
        if (plan == null
            || (plan.outcome() != Outcome.INSERT_SOURCE && plan.outcome() != Outcome.TOP_UP_SAME_ITEM)) {
            return false;
        }
        String expected = normalizeItemId(expectedItemId);
        String observed = normalizeItemId(observedItemId);
        if (!expected.isBlank()
            && expected.equals(observed)
            && Math.max(0, observedCount) >= plan.requiredFuelCount()) {
            return true;
        }
        return inputAlreadyLoaded && Math.max(0, insertedCount) >= plan.insertCount();
    }

    static RuntimeSourceDecision decideFuelSource(boolean fuelAdmissionVerified, boolean matchingSourcePresent) {
        if (fuelAdmissionVerified || matchingSourcePresent) {
            return RuntimeSourceDecision.READY;
        }
        return RuntimeSourceDecision.NEUTRAL_UNAVAILABLE;
    }

    static RuntimeSourceDecision decideInputSource(boolean fuelAdmissionVerified, boolean matchingSourcePresent) {
        if (matchingSourcePresent) {
            return fuelAdmissionVerified
                ? RuntimeSourceDecision.READY
                : RuntimeSourceDecision.NORMAL_FAILURE;
        }
        return RuntimeSourceDecision.NORMAL_FAILURE;
    }

    private static Plan blockedShortLoaded(Request request, int required, String reason) {
        return new Plan(
            Outcome.BLOCKED_SLOT,
            request.loadedClass(),
            request.loadedItemId(),
            -1,
            required,
            request.loadedCount(),
            0,
            reason
        );
    }

    private static Plan unavailable(String reason) {
        return new Plan(Outcome.UNAVAILABLE, SourceClass.INVALID, "", -1, 0, 0, 0, reason);
    }

    private static List<InventoryFuelStack> normalizedStacks(List<InventoryFuelStack> stacks) {
        List<InventoryFuelStack> normalized = new ArrayList<>();
        for (InventoryFuelStack stack : stacks) {
            if (stack == null || stack.count() <= 0 || stack.itemId().isBlank() || stack.sourceClass() == SourceClass.INVALID) {
                continue;
            }
            normalized.add(stack);
        }
        normalized.sort(Comparator.comparingInt(InventoryFuelStack::slot));
        return normalized;
    }

    private static FuelGroup firstSufficientGroup(
        List<InventoryFuelStack> stacks,
        SourceClass sourceClass,
        int required
    ) {
        Map<String, FuelGroup> groups = new LinkedHashMap<>();
        for (InventoryFuelStack stack : stacks) {
            if (stack.sourceClass() != sourceClass) {
                continue;
            }
            FuelGroup existing = groups.get(stack.itemId());
            groups.put(
                stack.itemId(),
                existing == null
                    ? new FuelGroup(stack.itemId(), stack.slot(), stack.count())
                    : new FuelGroup(existing.itemId(), existing.firstSlot(), existing.count() + stack.count())
            );
        }
        for (FuelGroup group : groups.values()) {
            if (group.count() >= required) {
                return group;
            }
        }
        return null;
    }

    private static FuelGroup groupForItem(
        List<InventoryFuelStack> stacks,
        String itemId,
        SourceClass sourceClass
    ) {
        String normalizedItemId = normalizeItemId(itemId);
        int firstSlot = -1;
        int count = 0;
        for (InventoryFuelStack stack : stacks) {
            if (stack.sourceClass() != sourceClass || !stack.itemId().equals(normalizedItemId)) {
                continue;
            }
            if (firstSlot < 0) {
                firstSlot = stack.slot();
            }
            count += stack.count();
        }
        return firstSlot < 0 ? null : new FuelGroup(normalizedItemId, firstSlot, count);
    }

    private static String normalizeItemId(String itemId) {
        return itemId == null ? "" : itemId.trim().toLowerCase();
    }

    private record FuelGroup(String itemId, int firstSlot, int count) {
    }
}
