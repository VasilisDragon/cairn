package com.mcbot.fabricclient;

final class AdjacentMoveProgressTracker {
    private GridCell target = null;
    private double bestDistance = Double.POSITIVE_INFINITY;
    private double lastX = Double.NaN;
    private double lastZ = Double.NaN;
    private long startedAtMs = 0L;
    private long lastImprovedAtMs = 0L;

    record Result(boolean stalled, double bestDistance, long stalledMs) {
    }

    Result update(
        GridCell currentTarget,
        double distance,
        double x,
        double z,
        long nowMs,
        long stallMs,
        double improvementEpsilon,
        double movementEpsilon
    ) {
        if (currentTarget == null) {
            reset();
            return new Result(false, Double.POSITIVE_INFINITY, 0L);
        }
        if (!currentTarget.equals(target)) {
            target = currentTarget;
            bestDistance = distance;
            lastX = x;
            lastZ = z;
            startedAtMs = nowMs;
            lastImprovedAtMs = nowMs;
            return new Result(false, bestDistance, 0L);
        }
        double moved = positionDelta(x, z);
        if (distance < bestDistance - improvementEpsilon || moved > movementEpsilon) {
            bestDistance = distance;
            lastX = x;
            lastZ = z;
            lastImprovedAtMs = nowMs;
            return new Result(false, bestDistance, 0L);
        }
        long stalledForMs = Math.max(0L, nowMs - lastImprovedAtMs);
        return new Result(stalledForMs >= stallMs && nowMs > startedAtMs, bestDistance, stalledForMs);
    }

    Result updateDistanceOnly(
        GridCell currentTarget,
        double distance,
        long nowMs,
        long stallMs,
        double improvementEpsilon
    ) {
        if (currentTarget == null) {
            reset();
            return new Result(false, Double.POSITIVE_INFINITY, 0L);
        }
        if (!currentTarget.equals(target)) {
            target = currentTarget;
            bestDistance = distance;
            lastX = Double.NaN;
            lastZ = Double.NaN;
            startedAtMs = nowMs;
            lastImprovedAtMs = nowMs;
            return new Result(false, bestDistance, 0L);
        }
        if (distance < bestDistance - improvementEpsilon) {
            bestDistance = distance;
            lastImprovedAtMs = nowMs;
            return new Result(false, bestDistance, 0L);
        }
        long stalledForMs = Math.max(0L, nowMs - lastImprovedAtMs);
        return new Result(stalledForMs >= stallMs && nowMs > startedAtMs, bestDistance, stalledForMs);
    }

    void reset() {
        target = null;
        bestDistance = Double.POSITIVE_INFINITY;
        lastX = Double.NaN;
        lastZ = Double.NaN;
        startedAtMs = 0L;
        lastImprovedAtMs = 0L;
    }

    private double positionDelta(double x, double z) {
        if (Double.isNaN(lastX) || Double.isNaN(lastZ)) {
            return Double.POSITIVE_INFINITY;
        }
        return Math.hypot(x - lastX, z - lastZ);
    }
}
