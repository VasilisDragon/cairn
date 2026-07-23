package com.mcbot.fabricclient;

import java.util.List;

final class WorkstationPlacementSiteTraversal {
    static final int MAX_ROUTE_ATTEMPTS = 2;
    static final long ROUTE_STALL_MS = 4_000L;

    private WorkstationPlacementSiteTraversal() {
    }

    static boolean canCompute(int attempts) {
        return attempts < MAX_ROUTE_ATTEMPTS;
    }

    static boolean shouldDriveRoute(boolean awaitingPlacementVerification, boolean activeRoute) {
        return activeRoute && !awaitingPlacementVerification;
    }

    static boolean reached(VoxelCell feet, VoxelCell stance) {
        return feet != null && feet.equals(stance);
    }

    static boolean readyToPlace(VoxelCell feet, VoxelCell stance, boolean supportWithinReach) {
        return reached(feet, stance) && supportWithinReach;
    }

    static boolean routeDeviation(List<VoxelCell> route, boolean nearRoute) {
        return route == null || route.isEmpty() || !nearRoute;
    }

    static boolean routeStalled(long lastProgressAtMs, long nowMs) {
        return lastProgressAtMs > 0L && nowMs - lastProgressAtMs >= ROUTE_STALL_MS;
    }

    static VoxelCell descentLanding(VoxelCell feet, List<VoxelCell> route, VoxelCell waypoint) {
        return feet != null && route != null && waypoint != null && route.contains(waypoint)
            && waypoint.y() < feet.y() ? waypoint : null;
    }

    static boolean validatedDescentStep(VoxelCell feet, List<VoxelCell> route, VoxelCell waypoint) {
        return descentLanding(feet, route, waypoint) != null;
    }

    static boolean descentLanded(VoxelCell feet, int launchY) {
        return feet != null && feet.y() < launchY;
    }

    static boolean descentMissed(VoxelCell feet, VoxelCell landing) {
        return feet != null && landing != null && feet.y() < landing.y() - 1;
    }

    static boolean holdAirborne(VoxelCell landing, boolean onGround) {
        return landing != null && !onGround;
    }

    static boolean stageBeforeDescent(VoxelCell feet, List<VoxelCell> route, VoxelCell waypoint) {
        if (feet == null || route == null || waypoint == null || waypoint.y() != feet.y()) {
            return false;
        }
        int index = route.indexOf(waypoint);
        return index >= 0 && index + 1 < route.size() && route.get(index + 1).y() < waypoint.y();
    }

    static boolean precisionSneak(VoxelCell feet, VoxelCell start, boolean descending) {
        return !descending && feet != null && start != null && feet.y() < start.y();
    }

    static String driveSuffix(boolean descending) {
        return descending ? "_nav3d_descend" : "_nav3d";
    }
}
