package com.mcbot.fabricclient;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Bounded, command-correlated facts produced by deterministic village executors.
 *
 * <p>The receipt never grants inventory authority: item ownership remains the live inventory
 * snapshot. Container contents are observation facts only and are scoped to the exact opportunity
 * revision which produced them.
 */
final class VillageOpportunityReceiptStore {
    static final int MAX_RECEIPTS = 64;
    static final int MAX_CONTAINER_ITEMS = 64;

    enum Result {
        ARRIVED,
        VERIFIED,
        INSPECTED,
        WITHDRAWN,
        HARVESTED,
        CRAFTED,
        COLLECTED,
        UNAVAILABLE,
        INVALIDATED,
        UNSAFE
    }

    record Receipt(
        String receiptId,
        String worldId,
        String dimension,
        String mission,
        String detourId,
        int detourStageSeq,
        String commandId,
        String action,
        String opportunityId,
        long opportunityRevision,
        String stage,
        Result result,
        String reason,
        String targetIdentity,
        Map<String, Integer> knownContainerContents,
        Map<String, Integer> inventoryDelta,
        Map<String, Integer> consumedInventoryDelta,
        long containerRevision,
        int routeReplanCount,
        long observedAtMs
    ) {
        Receipt {
            receiptId = normalizeOpaque(receiptId, 256);
            worldId = normalizeOpaque(worldId, 256);
            dimension = normalizeToken(dimension, 128);
            mission = normalizeToken(mission, 128);
            detourId = normalizeOpaque(detourId, 128);
            commandId = normalizeOpaque(commandId, 128);
            action = normalizeToken(action, 64);
            opportunityId = normalizeOpaque(opportunityId, 128);
            stage = normalizeToken(stage, 64);
            result = result == null ? Result.INVALIDATED : result;
            reason = normalizeToken(reason, 128);
            targetIdentity = normalizeOpaque(targetIdentity, 192);
            knownContainerContents = normalizeContents(knownContainerContents);
            inventoryDelta = normalizeContents(inventoryDelta);
            consumedInventoryDelta = normalizeContents(consumedInventoryDelta);
            routeReplanCount = Math.max(0, Math.min(1, routeReplanCount));
        }

        static Receipt empty() {
            return new Receipt(
                "", "", "", "", "", 0, "", "", "", 0L, "",
                Result.UNAVAILABLE, "", "", Map.of(), Map.of(), Map.of(),
                0L, 0, 0L);
        }

        String wireResult() {
            return result.name().toLowerCase(Locale.ROOT);
        }
    }

    private final LinkedHashMap<String, Receipt> receipts = new LinkedHashMap<>();
    private Receipt latest = Receipt.empty();

    synchronized Receipt record(Receipt receipt) {
        if (receipt == null || receipt.receiptId().isBlank()
            || receipt.commandId().isBlank() || receipt.opportunityId().isBlank()) {
            return Receipt.empty();
        }
        if (receipt.opportunityRevision() < 0L
            || receipt.detourStageSeq() < 0
            || receipt.observedAtMs() < 0L
            || receipt.containerRevision() < 0L
            || receipt.worldId().isBlank()
            || receipt.dimension().isBlank()
            || receipt.mission().isBlank()
            || receipt.detourId().isBlank()
            || receipt.action().isBlank()
            || receipt.stage().isBlank()) {
            return Receipt.empty();
        }
        receipts.remove(receipt.commandId());
        receipts.put(receipt.commandId(), receipt);
        while (receipts.size() > MAX_RECEIPTS) {
            receipts.remove(receipts.keySet().iterator().next());
        }
        latest = receipt;
        return receipt;
    }

    synchronized Receipt forCommand(String commandId) {
        return receipts.getOrDefault(normalizeOpaque(commandId, 128), Receipt.empty());
    }

    synchronized Receipt latest() {
        return latest;
    }

    synchronized void clear() {
        receipts.clear();
        latest = Receipt.empty();
    }

    synchronized int size() {
        return receipts.size();
    }

    private static Map<String, Integer> normalizeContents(Map<String, Integer> raw) {
        if (raw == null || raw.isEmpty()) {
            return Map.of();
        }
        java.util.TreeMap<String, Integer> normalized = new java.util.TreeMap<>();
        raw.entrySet().stream()
            .filter(entry -> entry != null && entry.getKey() != null
                && entry.getValue() != null && entry.getValue() > 0)
            .sorted(Map.Entry.comparingByKey())
            .limit(MAX_CONTAINER_ITEMS)
            .forEach(entry -> {
                String id = canonicalItemId(entry.getKey());
                if (!id.isBlank()) {
                    normalized.merge(id, entry.getValue(), Integer::sum);
                }
            });
        return Map.copyOf(normalized);
    }

    private static String normalizeToken(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return normalized.length() <= maxLength ? normalized : "";
    }

    private static String normalizeOpaque(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        String normalized = value.trim();
        return normalized.length() <= maxLength ? normalized : "";
    }

    private static String canonicalItemId(String value) {
        String id = normalizeToken(value, 128);
        if (id.isBlank() || !id.matches("[a-z0-9_.-]+(?::[a-z0-9_./-]+)?")) {
            return "";
        }
        return id.indexOf(':') >= 0 ? id : "minecraft:" + id;
    }
}
