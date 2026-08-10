package com.mcbot.fabricclient;

import java.util.List;

final class GatherWoodLocalEgressTraversal {
    static final int MAX_COMPUTATIONS_PER_TRIGGER = 2;
    static final int MAX_GATHER_TREE_TRIGGER_KEYS = 4;
    static final long SETTLE_TIMEOUT_MS = 3_000L;
    static final long DRY_TIMEOUT_MS = 6_000L;
    static final long SWIM_TIMEOUT_MS = 8_000L;

    private GatherWoodLocalEgressTraversal() {
    }

    record Drive(boolean forward, boolean jump, boolean validatedDescent) {
    }

    static boolean cp1Consumer(String consumer) {
        return consumer != null
            && (consumer.startsWith("exploration") || consumer.startsWith("gather_tree"));
    }

    static boolean canCompute(int computations) {
        return computations >= 0 && computations < MAX_COMPUTATIONS_PER_TRIGGER;
    }

    static boolean canOpenTrigger(String consumer, int existingGatherTreeTriggerKeys, boolean knownKey) {
        if (!cp1Consumer(consumer)) {
            return false;
        }
        return consumer.startsWith("exploration")
            || knownKey
            || existingGatherTreeTriggerKeys < MAX_GATHER_TREE_TRIGGER_KEYS;
    }

    static boolean shouldStartForTreeSelection(String selectionReason, boolean startStandable) {
        return !startStandable && "no_reachable_tree_logs".equals(selectionReason);
    }

    static boolean shouldStartAtCommandAnchor(
        boolean targetUnselected,
        boolean noCompletedTargets,
        boolean grounded,
        boolean touchingWater,
        boolean startStandable
    ) {
        return targetUnselected
            && noCompletedTargets
            && (grounded || touchingWater)
            && !startStandable;
    }

    static boolean shouldStartForSearch(boolean targetAvailable, boolean startStandable) {
        return !targetAvailable && !startStandable;
    }

    static long timeoutMs(GatherWoodLocalEgressPlanner.Mode mode) {
        if (mode == GatherWoodLocalEgressPlanner.Mode.SETTLE) {
            return SETTLE_TIMEOUT_MS;
        }
        return mode == GatherWoodLocalEgressPlanner.Mode.SWIM ? SWIM_TIMEOUT_MS : DRY_TIMEOUT_MS;
    }

    static boolean timedOut(GatherWoodLocalEgressPlanner.Mode mode, long selectedAtMs, long nowMs) {
        return mode != null
            && selectedAtMs >= 0L
            && nowMs - selectedAtMs >= timeoutMs(mode);
    }

    static boolean reached(
        GatherWoodLocalEgressPlanner.Mode mode,
        VoxelCell feet,
        double playerY,
        boolean grounded,
        boolean touchingWater,
        VoxelCell anchor
    ) {
        if (mode == null || feet == null || anchor == null) {
            return false;
        }
        if (mode == GatherWoodLocalEgressPlanner.Mode.SETTLE) {
            return grounded && !touchingWater;
        }
        boolean horizontal = feet.x() == anchor.x() && feet.z() == anchor.z();
        if (mode == GatherWoodLocalEgressPlanner.Mode.NORMALIZED) {
            return grounded && horizontal && Math.abs(playerY - anchor.y()) <= 0.25D;
        }
        return grounded && !touchingWater && horizontal && Math.abs(feet.y() - anchor.y()) <= 1;
    }

    static VoxelCell nextWaypoint(List<VoxelCell> path, VoxelCell feet) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        if (feet == null) {
            return path.getFirst();
        }
        for (int index = 0; index < path.size(); index++) {
            VoxelCell cell = path.get(index);
            if (cell.x() == feet.x()
                && cell.z() == feet.z()
                && Math.abs(cell.y() - feet.y()) <= 1) {
                return path.get(Math.min(index + 1, path.size() - 1));
            }
        }
        return path.getFirst();
    }

    static boolean validatedDescent(VoxelCell feet, VoxelCell waypoint) {
        if (feet == null || waypoint == null) {
            return false;
        }
        int drop = feet.y() - waypoint.y();
        return drop >= 1 && drop <= WalkabilityClassifier.MAX_SAFE_DROP;
    }

    static String driveSuffix(boolean validatedDescent) {
        return validatedDescent ? "_nav3d_descend" : "";
    }

    static Drive drive(
        GatherWoodLocalEgressPlanner.Mode mode,
        boolean facing,
        boolean touchingWater,
        boolean grounded,
        VoxelCell feet,
        VoxelCell waypoint
    ) {
        boolean descent = validatedDescent(feet, waypoint);
        if (!facing || feet == null || waypoint == null) {
            return new Drive(false, false, descent);
        }
        boolean swim = mode == GatherWoodLocalEgressPlanner.Mode.SWIM;
        boolean jump = swim ? touchingWater : grounded && waypoint.y() > feet.y();
        return new Drive(true, jump, descent);
    }
}
