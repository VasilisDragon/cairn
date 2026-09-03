package com.mcbot.fabricclient;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Remembers staircase entry packages that failed before any physical work was admitted.
 *
 * <p>The scope is deliberately narrower than rejected transition memory: an entry package is
 * meaningful only for one world, dimension, and exact origin. Command replacement does not clear
 * the scope, so a watchdog reissue cannot revive the same rejected heading. Moving to another
 * origin, changing dimension, or loading another world clears it. The four-plan hard limit matches
 * the bounded cardinal candidate set and never evicts within a scope.</p>
 */
final class MissionStoneEntryPlanMemory {
    static final int MAX_RETIRED_PLANS = 4;

    enum RecordResult {
        RECORDED,
        ALREADY_RECORDED,
        LIMIT_REACHED,
        INVALID
    }

    record Context(String worldIdentity, String dimensionIdentity, VoxelCell origin) {
        Context {
            worldIdentity = normalize(worldIdentity);
            dimensionIdentity = normalize(dimensionIdentity);
        }

        boolean valid() {
            return !worldIdentity.isBlank() && !dimensionIdentity.isBlank() && origin != null;
        }
    }

    record Signature(
        String worldIdentity,
        String dimensionIdentity,
        VoxelCell origin,
        String planIdentity
    ) {
        Signature(Context context, String planIdentity) {
            this(
                context.worldIdentity(),
                context.dimensionIdentity(),
                context.origin(),
                planIdentity
            );
        }
    }

    private final Set<Signature> retired = new LinkedHashSet<>();
    private Context context = new Context("", "", null);

    /**
     * Observes the exact spatial scope that owns subsequent entry-package retirements.
     *
     * @return {@code true} when the scope changed and retained packages were cleared
     */
    boolean observeContext(String worldIdentity, String dimensionIdentity, VoxelCell origin) {
        Context next = new Context(worldIdentity, dimensionIdentity, origin);
        if (context.equals(next)) {
            return false;
        }
        context = next;
        retired.clear();
        return true;
    }

    RecordResult retire(String planIdentity) {
        Signature signature = signature(planIdentity);
        if (signature == null) {
            return RecordResult.INVALID;
        }
        if (retired.contains(signature)) {
            return RecordResult.ALREADY_RECORDED;
        }
        if (retired.size() >= MAX_RETIRED_PLANS) {
            return RecordResult.LIMIT_REACHED;
        }
        retired.add(signature);
        return RecordResult.RECORDED;
    }

    boolean contains(String planIdentity) {
        Signature signature = signature(planIdentity);
        return signature != null && retired.contains(signature);
    }

    int retainedPlanCount() {
        return retired.size();
    }

    Context context() {
        return context;
    }

    private Signature signature(String planIdentity) {
        String normalizedIdentity = normalize(planIdentity);
        if (!context.valid() || normalizedIdentity.isBlank()) {
            return null;
        }
        return new Signature(context, normalizedIdentity);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
