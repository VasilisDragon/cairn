package com.mcbot.fabricclient;

final class CollectProgressTracker {
    private final long stallMs;
    private final double improvementEpsilon;
    private String key = "";
    private double bestHorizontalDistance = Double.MAX_VALUE;
    private long noProgressSinceMs = 0L;

    CollectProgressTracker(long stallMs, double improvementEpsilon) {
        this.stallMs = Math.max(0L, stallMs);
        this.improvementEpsilon = Math.max(0.0D, improvementEpsilon);
    }

    boolean stalled(String newKey, double horizontalDistance, long nowMs) {
        String stableKey = newKey == null ? "" : newKey;
        if (!stableKey.equals(key)) {
            reset(stableKey, horizontalDistance, nowMs);
            return false;
        }
        if (horizontalDistance + improvementEpsilon < bestHorizontalDistance) {
            reset(stableKey, horizontalDistance, nowMs);
            return false;
        }
        if (noProgressSinceMs <= 0L) {
            noProgressSinceMs = nowMs;
            return false;
        }
        return nowMs - noProgressSinceMs >= stallMs;
    }

    double bestHorizontalDistance() {
        return bestHorizontalDistance;
    }

    long noProgressElapsedMs(long nowMs) {
        return noProgressSinceMs <= 0L ? 0L : Math.max(0L, nowMs - noProgressSinceMs);
    }

    void reset() {
        key = "";
        bestHorizontalDistance = Double.MAX_VALUE;
        noProgressSinceMs = 0L;
    }

    private void reset(String stableKey, double horizontalDistance, long nowMs) {
        key = stableKey;
        bestHorizontalDistance = horizontalDistance;
        noProgressSinceMs = nowMs;
    }
}
