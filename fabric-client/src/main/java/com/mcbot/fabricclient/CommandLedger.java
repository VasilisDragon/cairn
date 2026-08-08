package com.mcbot.fabricclient;

/**
 * Per-executor completion bookkeeping that faithfully replaces the shell's
 * {@code completed*CommandIds} {@link java.util.Set} + {@code finished*CommandReasons}
 * {@link java.util.Map} idiom.
 *
 * <p>{@link #isCompleted(String)} mirrors a {@code completed*CommandIds.contains(id)} read;
 * {@link #isFinished(String)} additionally treats a recorded reason as terminal (for objectives
 * whose completion was tracked purely via a reasons map). {@link #reason(String)} surfaces the
 * stored reason string verbatim — those strings are a wire contract read by the brain.
 */
public final class CommandLedger {
    private final java.util.Set<String> completed = new java.util.HashSet<>();
    private final java.util.Map<String, String> reasons = new java.util.HashMap<>();
    private final java.util.LinkedHashSet<String> insertionOrder = new java.util.LinkedHashSet<>();
    private final int maximumEntries;

    public CommandLedger() {
        this(0);
    }

    /** A non-positive bound preserves the historical unbounded behavior. */
    public CommandLedger(int maximumEntries) {
        this.maximumEntries = Math.max(0, maximumEntries);
    }

    public void markComplete(String id, String reason) {
        if (id != null) {
            retain(id);
            completed.add(id);
            if (reason != null) {
                reasons.put(id, reason);
            }
        }
    }

    public void markFailed(String id, String reason) {
        if (id != null && reason != null) {
            retain(id);
            reasons.put(id, reason);
        }
    }

    public boolean isCompleted(String id) {
        return completed.contains(id);
    }

    public boolean isFinished(String id) {
        return completed.contains(id) || reasons.containsKey(id);
    }

    public String reason(String id) {
        return reasons.get(id);
    }

    /**
     * Mirrors a {@code finished*CommandReasons.getOrDefault(id, fallback)} read: the stored reason if
     * one was recorded for {@code id}, otherwise {@code fallback}. Used where the shell formerly read the
     * reasons map with a default while the completed-set already held the id.
     */
    public String reasonOrDefault(String id, String fallback) {
        return reasons.getOrDefault(id, fallback);
    }

    /** Clears lifecycle-scoped command identities so a new world/session cannot inherit them. */
    public void clear() {
        completed.clear();
        reasons.clear();
        insertionOrder.clear();
    }

    int size() {
        return insertionOrder.size();
    }

    private void retain(String id) {
        if (id == null || insertionOrder.contains(id)) {
            return;
        }
        insertionOrder.add(id);
        if (maximumEntries <= 0) {
            return;
        }
        while (insertionOrder.size() > maximumEntries) {
            String oldest = insertionOrder.getFirst();
            insertionOrder.remove(oldest);
            completed.remove(oldest);
            reasons.remove(oldest);
        }
    }
}
