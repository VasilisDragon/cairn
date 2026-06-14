package com.mcbot.fabricclient;

// R0b·2 (side-collect cycling livelock — live runs showed the bot keeps selecting
// adjacent approach cells for a dropped log without ever picking it up; 420-738 selections observed).
// CollectProgressTracker watches horizontal distance to ONE drop on a 2.5 s wall-clock; it misses this
// because the churn re-selects DIFFERENT cells, which can keep resetting the distance/settle windows.
// This tracker watches the orthogonal signal: consecutive side-collect SELECTIONS for the same drop
// that make no progress, and escalates to abandonment after `escalateStreak` of them.
//
// Conservative by construction (an over-abandonment regression — too-low a threshold
// killed legitimate slow tree approaches): ANY progress resets the streak — a pickup (inventory log
// count rises) OR getting meaningfully closer to the drop (distance improves by > epsilon). So a
// slow-but-advancing approach is NEVER abandoned by this mechanism; only a genuine no-progress churn
// reaches the streak limit. Selection-count based (not wall-clock) so it collapses the per-tick churn
// deterministically and is unit-testable in isolation (see SideCollectStallTrackerTest).
final class SideCollectStallTracker {
    private final int escalateStreak;
    private final double improvementEpsilon;
    private String key = "";
    private int streak = 0;
    private int bestInventory = Integer.MIN_VALUE;
    private double bestDistance = Double.MAX_VALUE;

    SideCollectStallTracker(int escalateStreak, double improvementEpsilon) {
        this.escalateStreak = escalateStreak;
        this.improvementEpsilon = improvementEpsilon;
    }

    // Record one side-collect selection for `dropKey` at the current inventory log count and current
    // horizontal distance to the drop. Returns true when `escalateStreak` consecutive selections for
    // the SAME drop have shown no inventory gain AND no net distance improvement -> abandon the drop.
    boolean shouldEscalate(String dropKey, int inventoryLogCount, double distance) {
        String stableKey = dropKey == null ? "" : dropKey;
        if (!stableKey.equals(key)) {
            // (1) New drop -> fresh streak; this selection is the first one.
            key = stableKey;
            streak = 1;
            bestInventory = inventoryLogCount;
            bestDistance = distance;
            return false;
        }
        if (inventoryLogCount > bestInventory) {
            // (2) Picked something up since the streak began -> real progress, reset.
            bestInventory = inventoryLogCount;
            bestDistance = Math.min(bestDistance, distance);
            streak = 0;
            return false;
        }
        if (distance + improvementEpsilon < bestDistance) {
            // (3) Got meaningfully closer to the drop -> still advancing, reset.
            bestDistance = distance;
            streak = 0;
            return false;
        }
        // (4) No progress on this selection.
        streak++;
        return streak >= escalateStreak;
    }

    int streak() {
        return streak;
    }

    void reset() {
        key = "";
        streak = 0;
        bestInventory = Integer.MIN_VALUE;
        bestDistance = Double.MAX_VALUE;
    }
}
