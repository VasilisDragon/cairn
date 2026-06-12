package com.mcbot.fabricclient;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Search result plus bounded diagnostic counters for failed 3-D voxel routes. */
public record Nav3DRouteDiagnostic(
    List<VoxelCell> route,
    String failureReason,
    int expandedNodes,
    Map<String, Integer> rejectionCounts
) {
    public Nav3DRouteDiagnostic {
        route = route == null ? List.of() : List.copyOf(route);
        failureReason = failureReason == null ? "" : failureReason;
        rejectionCounts = rejectionCounts == null ? Map.of() : Map.copyOf(new LinkedHashMap<>(rejectionCounts));
    }

    public boolean routeFound() {
        return !route.isEmpty();
    }

    public int routeLength() {
        return route.size();
    }

    public int rejectionCount(String reason) {
        return rejectionCounts.getOrDefault(reason, 0);
    }
}
