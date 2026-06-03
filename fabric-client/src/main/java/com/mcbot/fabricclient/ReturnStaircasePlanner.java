package com.mcbot.fabricclient;

final class ReturnStaircasePlanner {
    private ReturnStaircasePlanner() {
    }

    enum Action {
        CONTINUE,
        FAIL_MISSING_TARGET,
        FAIL_TIMEOUT,
        FAIL_HEALTH_LOST,
        COMPLETE_SURFACE_REACHED,
        FAIL_BREADCRUMB_PATH_TOO_SHORT,
        BREADCRUMB_REACHED,
        RECORD_BREADCRUMB_PROGRESS,
        FAIL_BREADCRUMB_STUCK,
        BREADCRUMB_MOVE
    }

    record Decision(Action action, String reason) {
    }

    static Decision decideTargetPresent(boolean hasTarget) {
        if (!hasTarget) {
            return new Decision(Action.FAIL_MISSING_TARGET, "return_staircase_failed:missing_target");
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decidePreflight(long elapsedMs, long timeoutMs, float healthBefore, float currentHealth) {
        if (elapsedMs > timeoutMs) {
            return new Decision(Action.FAIL_TIMEOUT, "return_staircase_timeout");
        }
        if (currentHealth + 0.1F < healthBefore) {
            return new Decision(Action.FAIL_HEALTH_LOST, "return_staircase_health_lost");
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decideSurfaceReached(double horizontalDistance, double floorY, int targetY) {
        if (horizontalDistance <= 0.75D && floorY >= targetY) {
            return new Decision(Action.COMPLETE_SURFACE_REACHED, "return_staircase_complete:surface_reached");
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decideBreadcrumbPathSize(int pathSize) {
        if (pathSize < 2) {
            return new Decision(Action.FAIL_BREADCRUMB_PATH_TOO_SHORT, "return_staircase_breadcrumb_path_too_short");
        }
        return new Decision(Action.CONTINUE, "");
    }

    static int initialWaypointIndex(int nearestIndex, boolean nearestReached, int pathSize) {
        int boundedNearest = Math.max(0, Math.min(nearestIndex, Math.max(0, pathSize - 1)));
        if (nearestReached && boundedNearest > 0) {
            return boundedNearest - 1;
        }
        return boundedNearest;
    }

    static Decision decideWaypointReached(boolean reached, int nextWaypointIndex) {
        if (reached) {
            return new Decision(Action.BREADCRUMB_REACHED, "return_staircase_breadcrumb_reached:" + Math.max(0, nextWaypointIndex));
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decideWaypointProgress(
        int progressWaypointIndex,
        int waypointIndex,
        double distanceSq,
        double bestWaypointDistanceSq,
        long elapsedSinceProgressMs,
        long stuckTimeoutMs
    ) {
        if (progressWaypointIndex != waypointIndex || distanceSq + 0.05D < bestWaypointDistanceSq) {
            return new Decision(Action.RECORD_BREADCRUMB_PROGRESS, "");
        }
        if (elapsedSinceProgressMs > stuckTimeoutMs) {
            return new Decision(Action.FAIL_BREADCRUMB_STUCK, "");
        }
        return new Decision(Action.BREADCRUMB_MOVE, "");
    }

    static boolean shouldJumpToWaypoint(boolean uphillStep, boolean onGround, double horizontalDistanceSq, double jumpDistanceBlocks) {
        return uphillStep
            && onGround
            && horizontalDistanceSq <= jumpDistanceBlocks * jumpDistanceBlocks;
    }
}
