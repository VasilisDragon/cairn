package com.mcbot.fabricclient;

import java.util.List;

final class MiningWorkspaceTraversal {
    static final long MIN_TIMEOUT_MS = 20_000L;
    static final long MAX_TIMEOUT_MS = 180_000L;
    static final double EDGE_GUARD_MAX_LOOKAHEAD = 1.7D;

    private MiningWorkspaceTraversal() {
    }

    static long timeoutMs(int routeLength) {
        return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.max(1, routeLength) * 2_500L));
    }

    static boolean reversibleRoute(List<VoxelCell> route) {
        if (route == null || route.isEmpty()) {
            return false;
        }
        for (int index = 1; index < route.size(); index++) {
            if (!MiningWorkspaceStore.reversible(route.get(index - 1), route.get(index))) {
                return false;
            }
        }
        return true;
    }

    static VoxelCell nextWaypoint(List<VoxelCell> route, VoxelCell feet) {
        if (route == null || route.isEmpty() || feet == null) {
            return null;
        }
        int exact = route.indexOf(feet);
        if (exact >= 0) {
            return exact + 1 < route.size() ? route.get(exact + 1) : route.get(exact);
        }
        int nearestIndex = -1;
        int best = Integer.MAX_VALUE;
        for (int index = 0; index < route.size(); index++) {
            VoxelCell cell = route.get(index);
            int distance = Math.abs(cell.x() - feet.x())
                + Math.abs(cell.y() - feet.y())
                + Math.abs(cell.z() - feet.z());
            if (distance < best) {
                best = distance;
                nearestIndex = index;
            }
        }
        if (nearestIndex < 0 || best > 2) {
            return null;
        }
        return nearestIndex + 1 < route.size() ? route.get(nearestIndex + 1) : route.get(nearestIndex);
    }

    static boolean descending(VoxelCell feet, VoxelCell waypoint) {
        return feet != null && waypoint != null && waypoint.y() < feet.y();
    }

    static boolean shouldJump(VoxelCell feet, VoxelCell waypoint, boolean facing, boolean onGround) {
        return facing && onGround && feet != null && waypoint != null && waypoint.y() > feet.y();
    }

    static String driveReason(String prefix, boolean descending) {
        return prefix + (descending ? "_nav3d_descend" : "_nav3d");
    }

    static double edgeGuardLookahead(
        double playerX,
        double playerZ,
        VoxelCell waypoint
    ) {
        if (waypoint == null) {
            return EDGE_GUARD_MAX_LOOKAHEAD;
        }
        double distance = Math.hypot(
            waypoint.x() + 0.5D - playerX,
            waypoint.z() + 0.5D - playerZ
        );
        return Math.max(0.8D, Math.min(EDGE_GUARD_MAX_LOOKAHEAD, distance + 0.2D));
    }
}
