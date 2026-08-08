package com.mcbot.fabricclient;

import java.util.List;
import java.util.UUID;

final class GatherTreeOwnedDropTraversal {
    static final double REPLAN_ITEM_MOVEMENT = OwnedDropTraversal.REPLAN_ITEM_MOVEMENT;

    private GatherTreeOwnedDropTraversal() {
    }

    static boolean holdStationary(GatherTreeDropTracker.Phase phase) {
        return OwnedDropTraversal.holdStationary(phase);
    }

    static boolean shouldUse(double playerY, double dropY, boolean sideStanceAvailable) {
        return OwnedDropTraversal.shouldUse(playerY, dropY, sideStanceAvailable, false);
    }

    static boolean hasSelectedRoute(List<VoxelCell> route, boolean rejected) {
        return OwnedDropTraversal.hasSelectedRoute(route, rejected);
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
        return OwnedDropTraversal.needsReplan(
            plannedEntityId,
            currentEntityId,
            plannedPosition,
            currentPosition,
            route,
            playerNearRoute,
            routeAttempts
        );
    }

    static boolean reached(VoxelCell playerFeet, VoxelCell pickupCell) {
        return OwnedDropTraversal.reached(playerFeet, pickupCell);
    }

    static boolean validatedDescentStep(VoxelCell playerFeet, List<VoxelCell> route, VoxelCell waypoint) {
        return OwnedDropTraversal.validatedDescentStep(playerFeet, route, waypoint);
    }

    static String driveSuffix(boolean validatedDescentStep) {
        return OwnedDropTraversal.driveSuffix(validatedDescentStep);
    }

    static boolean inventoryGainCompletes(int currentLogs, int previousLogs) {
        return OwnedDropTraversal.inventoryGainCompletes(currentLogs, previousLogs);
    }

    static boolean inventoryGainProvesSelectedRouteReached(
        int selectedCount,
        int reachedCount,
        int currentLogs,
        int previousLogs
    ) {
        return OwnedDropTraversal.inventoryGainProvesSelectedRouteReached(
            selectedCount,
            reachedCount,
            currentLogs,
            previousLogs
        );
    }
}
