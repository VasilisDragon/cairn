package com.mcbot.fabricclient;

import java.util.List;

final class GatherTreeBreakStanceTraversal {
    static final int MAX_ROUTE_ATTEMPTS = 2;
    static final long ROUTE_STALL_MS = 4_000L;

    private GatherTreeBreakStanceTraversal() {
    }

    static boolean shouldAttempt(boolean noTwoDimensionalStance, int adjacentStalls, int outOfReachRepositions) {
        return noTwoDimensionalStance || adjacentStalls > 0 || outOfReachRepositions > 0;
    }

    static boolean canCompute(int routeAttempts) {
        return routeAttempts < MAX_ROUTE_ATTEMPTS;
    }

    static boolean active(List<VoxelCell> route, String trigger) {
        return (route != null && !route.isEmpty()) || (trigger != null && !trigger.isEmpty());
    }

    static boolean directBreakAllowed(
        boolean breakStarted,
        boolean traversalActive,
        boolean adjacentExclusionsEmpty,
        boolean targetInReach
    ) {
        return !traversalActive && (breakStarted || (adjacentExclusionsEmpty && targetInReach));
    }

    static boolean reached(VoxelCell playerFeet, VoxelCell stance) {
        return playerFeet != null && playerFeet.equals(stance);
    }

    static boolean routeDeviation(List<VoxelCell> route, boolean playerNearRoute) {
        return route == null || route.isEmpty() || !playerNearRoute;
    }

    static boolean routeStalled(long lastProgressAtMs, long nowMs) {
        return lastProgressAtMs > 0L && nowMs - lastProgressAtMs >= ROUTE_STALL_MS;
    }

    static boolean validatedDescentStep(VoxelCell playerFeet, List<VoxelCell> route, VoxelCell waypoint) {
        return playerFeet != null
            && route != null
            && waypoint != null
            && route.contains(waypoint)
            && waypoint.y() < playerFeet.y();
    }

    static VoxelCell descentLanding(VoxelCell playerFeet, List<VoxelCell> route, VoxelCell waypoint) {
        if (playerFeet == null || route == null || waypoint == null) {
            return null;
        }
        int index = route.indexOf(waypoint);
        if (index < 0) {
            return null;
        }
        return waypoint.y() < playerFeet.y() ? waypoint : null;
    }

    static boolean descentLanded(VoxelCell playerFeet, int launchFeetY) {
        return playerFeet != null && playerFeet.y() < launchFeetY;
    }

    static boolean descentMissed(VoxelCell playerFeet, VoxelCell landing) {
        return playerFeet != null && landing != null && playerFeet.y() < landing.y() - 1;
    }

    static boolean holdAirborne(VoxelCell landing, boolean onGround) {
        return landing != null && !onGround;
    }

    static boolean stageBeforeDescent(VoxelCell playerFeet, List<VoxelCell> route, VoxelCell waypoint) {
        if (playerFeet == null || route == null || waypoint == null || waypoint.y() != playerFeet.y()) {
            return false;
        }
        int index = route.indexOf(waypoint);
        return index >= 0 && index + 1 < route.size() && route.get(index + 1).y() < waypoint.y();
    }

    static boolean precisionSneak(VoxelCell playerFeet, VoxelCell routeStart, boolean descending) {
        return !descending && playerFeet != null && routeStart != null && playerFeet.y() < routeStart.y();
    }

    static String driveSuffix(boolean validatedDescentStep) {
        return validatedDescentStep ? "_nav3d_descend" : "_nav3d";
    }

    static double edgeGuardLookahead(
        double playerX,
        double playerZ,
        VoxelCell feet,
        VoxelCell stableFeet,
        VoxelCell waypoint,
        boolean active,
        boolean waypointSafe
    ) {
        if (!active
            || feet == null
            || stableFeet == null
            || waypoint == null
            || !feet.equals(stableFeet)
            || waypoint.y() != stableFeet.y()
            || !MiningWorkspaceStore.reversible(stableFeet, waypoint)
            || !waypointSafe) {
            return MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD;
        }
        return MiningWorkspaceTraversal.edgeGuardLookahead(playerX, playerZ, waypoint);
    }
}
