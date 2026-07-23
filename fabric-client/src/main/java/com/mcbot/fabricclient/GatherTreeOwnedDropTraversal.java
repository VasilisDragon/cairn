package com.mcbot.fabricclient;

import java.util.List;
import java.util.UUID;

final class GatherTreeOwnedDropTraversal {
    static final double REPLAN_ITEM_MOVEMENT = 0.75D;

    private GatherTreeOwnedDropTraversal() {
    }

    static boolean holdStationary(GatherTreeDropTracker.Phase phase) {
        return phase == GatherTreeDropTracker.Phase.ACQUIRING || phase == GatherTreeDropTracker.Phase.AIRBORNE;
    }

    static boolean shouldUse(double playerY, double dropY, boolean sideStanceAvailable) {
        return Math.abs(dropY - playerY) > CollectTarget3DPlanner.PICKUP_VERTICAL_RANGE || !sideStanceAvailable;
    }

    static boolean hasSelectedRoute(List<VoxelCell> route, boolean rejected) {
        return !rejected && route != null && !route.isEmpty();
    }

    static boolean needsReplan(
        UUID plannedEntityId,
        UUID currentEntityId,
        GatherTreeDropTracker.Position plannedPosition,
        GatherTreeDropTracker.Position currentPosition,
        List<VoxelCell> route,
        boolean playerNearRoute,
        int routeAttempts
    ) {
        if (routeAttempts >= GatherTreeDropTracker.MAX_ROUTE_ATTEMPTS) {
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

    static boolean inventoryGainCompletes(int currentLogs, int previousLogs) {
        return currentLogs > previousLogs;
    }

    static boolean inventoryGainProvesSelectedRouteReached(
        int selectedCount,
        int reachedCount,
        int currentLogs,
        int previousLogs
    ) {
        return selectedCount > 0 && reachedCount == 0 && inventoryGainCompletes(currentLogs, previousLogs);
    }
}
