package com.mcbot.fabricclient;

import java.util.List;
import java.util.UUID;

final class OwnedDropTraversal {
    static final double REPLAN_ITEM_MOVEMENT = 0.75D;
    static final long PICKUP_CONFIRMATION_GRACE_MS = 300L;

    enum PickupConfirmation {
        WAIT,
        FAIL_COMMAND,
        PRUNE_DISAPPEARED
    }

    private OwnedDropTraversal() {
    }

    static boolean holdStationary(OwnedDropTracker.Phase phase) {
        return phase == OwnedDropTracker.Phase.ACQUIRING || phase == OwnedDropTracker.Phase.AIRBORNE;
    }

    static boolean shouldUse(double playerY, double dropY, boolean directPickupEligible, boolean directPickupStalled) {
        return directPickupStalled
            || Math.abs(dropY - playerY) > CollectTarget3DPlanner.PICKUP_VERTICAL_RANGE
            || !directPickupEligible;
    }

    static boolean hasSelectedRoute(List<VoxelCell> route, boolean rejected) {
        return !rejected && route != null && !route.isEmpty();
    }

    static boolean needsReplan(
        UUID plannedEntityId,
        UUID currentEntityId,
        OwnedDropTracker.Position plannedPosition,
        OwnedDropTracker.Position currentPosition,
        List<VoxelCell> route,
        boolean playerNearRoute,
        int routeAttempts
    ) {
        if (routeAttempts >= OwnedDropTracker.MAX_ROUTE_ATTEMPTS) {
            return false;
        }
        return route == null
            || route.isEmpty()
            || plannedEntityId == null
            || !plannedEntityId.equals(currentEntityId)
            || plannedPosition == null
            || currentPosition == null
            || plannedPosition.squaredDistanceTo(currentPosition)
                > REPLAN_ITEM_MOVEMENT * REPLAN_ITEM_MOVEMENT
            || !playerNearRoute;
    }

    static boolean reached(VoxelCell playerFeet, VoxelCell pickupCell) {
        return playerFeet != null && playerFeet.equals(pickupCell);
    }

    /**
     * Inventory remains the pickup authority. Reaching a candidate cell only starts a short bounded
     * confirmation window; a still-live target cannot be discarded to make room for more mining.
     */
    static PickupConfirmation pickupConfirmation(
        long reachedAtMs,
        long nowMs,
        boolean targetEntityLive
    ) {
        if (!targetEntityLive) {
            return PickupConfirmation.PRUNE_DISAPPEARED;
        }
        long elapsedMs = reachedAtMs <= 0L ? 0L : Math.max(0L, nowMs - reachedAtMs);
        return reachedAtMs <= 0L || elapsedMs < PICKUP_CONFIRMATION_GRACE_MS
            ? PickupConfirmation.WAIT
            : PickupConfirmation.FAIL_COMMAND;
    }

    static boolean validatedDescentStep(VoxelCell playerFeet, List<VoxelCell> route, VoxelCell waypoint) {
        if (playerFeet == null || route == null || waypoint == null) {
            return false;
        }
        int index = route.indexOf(waypoint);
        if (index < 0) {
            return false;
        }
        int last = Math.min(route.size() - 1, index + 2);
        for (int candidateIndex = index; candidateIndex <= last; candidateIndex++) {
            if (route.get(candidateIndex).y() < playerFeet.y()) {
                return true;
            }
        }
        return false;
    }

    static String driveSuffix(boolean validatedDescentStep) {
        return validatedDescentStep ? "_nav3d_descend" : "_nav3d";
    }

    static boolean inventoryGainCompletes(int currentCount, int previousCount) {
        return currentCount > previousCount;
    }

    static boolean inventoryGainProvesSelectedRouteReached(
        int selectedCount,
        int reachedCount,
        int currentCount,
        int previousCount
    ) {
        return selectedCount > 0 && reachedCount == 0 && inventoryGainCompletes(currentCount, previousCount);
    }
}
