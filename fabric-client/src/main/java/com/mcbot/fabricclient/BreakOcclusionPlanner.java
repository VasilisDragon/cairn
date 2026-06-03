package com.mcbot.fabricclient;

final class BreakOcclusionPlanner {
    private BreakOcclusionPlanner() {
    }

    enum Action {
        BREAK_TARGET,
        BREAK_OCCLUDER,
        REPOSITION,
        ABANDON,
        WAIT
    }

    record Decision(Action action, String reason) {
    }

    static Decision decide(
        boolean blockHit,
        boolean hitTarget,
        boolean breakableOccluder,
        int occludersBroken,
        int maxOccluders,
        int repositions,
        int maxRepositions
    ) {
        if (!blockHit) {
            return new Decision(Action.WAIT, "raycast_no_block_hit");
        }
        if (hitTarget) {
            return new Decision(Action.BREAK_TARGET, "raycast_hit_target");
        }
        if (breakableOccluder && occludersBroken < maxOccluders) {
            return new Decision(Action.BREAK_OCCLUDER, "raycast_hit_breakable_occluder");
        }
        if (repositions < maxRepositions) {
            return new Decision(Action.REPOSITION, "raycast_occluded_reposition");
        }
        return new Decision(Action.ABANDON, breakableOccluder ? "raycast_occluder_limit" : "raycast_unbreakable_occluder");
    }
}
