package com.mcbot.fabricclient;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/** Search result plus bounded diagnostic counters for failed A* routes. */
public record GridRouteDiagnostic(
    List<GridCell> route,
    String failureReason,
    int visitedCells,
    Map<TraversalIssue, Integer> rejectionCounts,
    List<GridRejectionSample> rejectionSamples
) {
    public GridRouteDiagnostic(
        List<GridCell> route,
        String failureReason,
        int visitedCells,
        Map<TraversalIssue, Integer> rejectionCounts
    ) {
        this(route, failureReason, visitedCells, rejectionCounts, List.of());
    }

    public GridRouteDiagnostic {
        route = route == null ? List.of() : List.copyOf(route);
        failureReason = failureReason == null ? "" : failureReason;
        EnumMap<TraversalIssue, Integer> copy = new EnumMap<>(TraversalIssue.class);
        if (rejectionCounts != null) {
            copy.putAll(rejectionCounts);
        }
        rejectionCounts = Map.copyOf(copy);
        rejectionSamples = rejectionSamples == null ? List.of() : List.copyOf(rejectionSamples);
    }

    public boolean routeFound() {
        return !route.isEmpty();
    }

    public int routeLength() {
        return route.size();
    }

    public int rejectionCount(TraversalIssue issue) {
        return rejectionCounts.getOrDefault(issue, 0);
    }
}
