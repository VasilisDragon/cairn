package com.mcbot.fabricclient;

final class KitingPlanner {
    private KitingPlanner() {
    }

    record Decision(boolean strafing, int direction, boolean switched, String reason) {
        static Decision none(String reason) {
            return new Decision(false, 0, false, reason);
        }
    }

    static Decision decide(
        CombatPlanner.ThreatKind kind,
        double distance,
        double meleeReach,
        double maxKiteDistance,
        int currentDirection,
        long nowMs,
        long lastSwitchMs,
        long switchIntervalMs
    ) {
        if (kind != CombatPlanner.ThreatKind.RANGED) {
            return Decision.none("not_ranged");
        }
        if (distance <= meleeReach) {
            return Decision.none("in_reach");
        }
        if (distance > maxKiteDistance) {
            return Decision.none("too_far");
        }
        int direction = currentDirection == 0 ? 1 : currentDirection;
        boolean switched = lastSwitchMs <= 0L || nowMs - lastSwitchMs >= switchIntervalMs;
        if (switched) {
            direction = -direction;
        }
        return new Decision(true, direction, switched, "ranged_mid_distance");
    }
}
