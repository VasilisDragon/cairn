package com.mcbot.fabricclient;

import java.util.List;

final class GatherTreeSearchRouteRejection {
    private GatherTreeSearchRouteRejection() {
    }

    static Signature signature(GridCell goal, List<GridCell> route) {
        return goal == null || route == null || route.isEmpty()
            ? null
            : new Signature(goal, route);
    }

    static boolean arrivalSuppressedByEdgeVeto(
        String commandId,
        String vetoCommandId,
        int vetoCount
    ) {
        return vetoCount > 0
            && commandId != null
            && (commandId + ":tree:search").equals(vetoCommandId);
    }

    static double navigationArriveEpsilon(double configuredEpsilon, boolean arrivalSuppressed) {
        return arrivalSuppressed ? 0.0D : Math.max(0.0D, configuredEpsilon);
    }

    record Signature(GridCell goal, List<GridCell> route) {
        Signature {
            route = route == null ? List.of() : List.copyOf(route);
        }

        String eventId() {
            long fingerprint = 0xcbf29ce484222325L;
            fingerprint = mix(fingerprint, goal == null ? 0 : goal.x());
            fingerprint = mix(fingerprint, goal == null ? 0 : goal.z());
            for (GridCell cell : route) {
                fingerprint = mix(fingerprint, cell == null ? 0 : cell.x());
                fingerprint = mix(fingerprint, cell == null ? 0 : cell.z());
            }
            fingerprint = mix(fingerprint, route.size());
            return (goal == null ? "none" : goal.x() + "," + goal.z())
                + ":" + route.size()
                + ":" + Long.toUnsignedString(fingerprint, 16);
        }

        private static long mix(long fingerprint, long value) {
            fingerprint ^= value;
            return fingerprint * 0x100000001b3L;
        }
    }

    record Rejected(
        GridCell goal,
        List<GridCell> route,
        String routeReason,
        Signature signature,
        boolean repeatedSignature
    ) {
        Rejected {
            route = route == null ? List.of() : List.copyOf(route);
            routeReason = routeReason == null ? "" : routeReason;
        }
    }
}
