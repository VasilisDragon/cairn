package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

final class GatherLogPlanner {
    private GatherLogPlanner() {
    }

    record AdjacentPlan(GridCell cell, List<GridCell> route, String reason) {
    }

    static List<GridCell> adjacentCandidates(int targetX, int targetZ) {
        return List.of(
            new GridCell(targetX + 1, targetZ),
            new GridCell(targetX - 1, targetZ),
            new GridCell(targetX, targetZ + 1),
            new GridCell(targetX, targetZ - 1)
        );
    }

    static AdjacentPlan chooseAdjacent(GridPerception perception, GridCell start, int targetX, int targetZ) {
        return chooseAdjacent(perception, start, targetX, targetZ, Set.of());
    }

    static AdjacentPlan chooseAdjacent(GridPerception perception, GridCell start, int targetX, int targetZ, Set<GridCell> excluded) {
        if (perception == null || start == null) {
            return new AdjacentPlan(null, List.of(), "invalid_request");
        }
        Set<GridCell> skipped = excluded == null ? Set.of() : excluded;
        List<RouteCandidate> candidates = new ArrayList<>();
        for (GridCell candidate : adjacentCandidates(targetX, targetZ)) {
            if (skipped.contains(candidate)) {
                continue;
            }
            if (!perception.inBounds(candidate.x(), candidate.z()) || perception.isBlocked(candidate.x(), candidate.z())) {
                continue;
            }
            List<GridCell> route = GridAStar.route(perception, start, candidate);
            if (!route.isEmpty()) {
                candidates.add(new RouteCandidate(candidate, route));
            }
        }
        if (candidates.isEmpty()) {
            return new AdjacentPlan(null, List.of(), skipped.isEmpty() ? "no_reachable_adjacent_cell" : "no_reachable_unexcluded_adjacent_cell");
        }
        candidates.sort(Comparator
            .comparingInt((RouteCandidate candidate) -> candidate.route().size())
            .thenComparingDouble((RouteCandidate candidate) -> distanceSquared(start, candidate.cell())));
        RouteCandidate best = candidates.getFirst();
        return new AdjacentPlan(best.cell(), List.copyOf(best.route()), "reachable_adjacent_cell");
    }

    private record RouteCandidate(GridCell cell, List<GridCell> route) {
    }

    private static double distanceSquared(GridCell a, GridCell b) {
        int dx = a.x() - b.x();
        int dz = a.z() - b.z();
        return dx * dx + dz * dz;
    }
}
