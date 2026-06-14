package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

final class GatherLogPlanner {
    private static final double HAND_REACH_BLOCKS = 4.8D;
    private static final double EYE_HEIGHT_ESTIMATE = 1.62D;
    private static final int BREAK_CELL_RADIUS = (int) Math.ceil(HAND_REACH_BLOCKS);
    private static final int UNROUTED_ADJACENT_DISTANCE_SQUARED = 16;
    private static final int UNROUTED_BREAK_CELL_DISTANCE_SQUARED = 4;

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
        return chooseCandidate(perception, start, targetX, 0, targetZ, excluded, false);
    }

    static AdjacentPlan chooseBreakCell(
        GridPerception perception,
        GridCell start,
        int targetX,
        int targetY,
        int targetZ,
        Set<GridCell> excluded
    ) {
        return chooseCandidate(perception, start, targetX, targetY, targetZ, excluded, true);
    }

    private static AdjacentPlan chooseCandidate(
        GridPerception perception,
        GridCell start,
        int targetX,
        int targetY,
        int targetZ,
        Set<GridCell> excluded,
        boolean allowInReachCells
    ) {
        if (perception == null || start == null) {
            return new AdjacentPlan(null, List.of(), "invalid_request");
        }
        Set<GridCell> skipped = excluded == null ? Set.of() : excluded;
        List<RouteCandidate> candidates = new ArrayList<>();
        List<RouteCandidate> unroutedCandidates = new ArrayList<>();
        for (BreakCandidate candidate : breakCandidates(targetX, targetY, targetZ, perception, allowInReachCells)) {
            GridCell cell = candidate.cell();
            if (skipped.contains(cell)) {
                continue;
            }
            if (!perception.inBounds(cell.x(), cell.z()) || perception.isBlocked(cell.x(), cell.z())) {
                continue;
            }
            int surfacePenalty = breakSurfacePenalty(perception, cell, targetY, allowInReachCells);
            List<GridCell> route = GridAStar.route(perception, start, cell);
            if (!route.isEmpty() && breakRouteUsesLocalSteps(perception, route, allowInReachCells)) {
                candidates.add(new RouteCandidate(cell, route, candidate.reason(), surfacePenalty));
            } else if (distanceSquared(start, cell) <= unroutedFallbackDistanceSquared(allowInReachCells)
                && unroutedFallbackUsesLocalStep(perception, start, cell, allowInReachCells)) {
                unroutedCandidates.add(new RouteCandidate(cell, fallbackRoute(start, cell), candidate.unroutedReason(), surfacePenalty));
            }
        }
        if (candidates.isEmpty()) {
            if (!unroutedCandidates.isEmpty()) {
                unroutedCandidates.sort(Comparator
                    .comparingDouble((RouteCandidate candidate) -> distanceSquared(start, candidate.cell()))
                    .thenComparingInt((candidate) -> candidate.cell().z())
                    .thenComparingInt((candidate) -> candidate.cell().x()));
                RouteCandidate best = unroutedCandidates.getFirst();
                return new AdjacentPlan(best.cell(), best.route(), best.reason());
            }
            return new AdjacentPlan(
                null,
                List.of(),
                noCandidateReason(skipped.isEmpty(), allowInReachCells)
            );
        }
        candidates.sort(Comparator
            .comparingInt((RouteCandidate candidate) -> candidate.reason().contains("adjacent") ? 0 : 1)
            .thenComparingInt(RouteCandidate::surfacePenalty)
            .thenComparingInt((RouteCandidate candidate) -> candidate.route().size())
            .thenComparingDouble((RouteCandidate candidate) -> distanceSquared(start, candidate.cell())));
        RouteCandidate best = candidates.getFirst();
        return new AdjacentPlan(best.cell(), List.copyOf(best.route()), best.reason());
    }

    private record BreakCandidate(GridCell cell, String reason, String unroutedReason) {
    }

    private record RouteCandidate(GridCell cell, List<GridCell> route, String reason, int surfacePenalty) {
    }

    private static List<BreakCandidate> breakCandidates(
        int targetX,
        int targetY,
        int targetZ,
        GridPerception perception,
        boolean allowInReachCells
    ) {
        List<BreakCandidate> candidates = new ArrayList<>();
        for (GridCell adjacent : adjacentCandidates(targetX, targetZ)) {
            if (!allowInReachCells || handReachable(perception, adjacent, targetX, targetY, targetZ)) {
                candidates.add(new BreakCandidate(adjacent, "reachable_adjacent_cell", "unrouted_unblocked_adjacent_cell"));
            }
        }
        if (!allowInReachCells) {
            return candidates;
        }
        for (int x = targetX - BREAK_CELL_RADIUS; x <= targetX + BREAK_CELL_RADIUS; x++) {
            for (int z = targetZ - BREAK_CELL_RADIUS; z <= targetZ + BREAK_CELL_RADIUS; z++) {
                GridCell cell = new GridCell(x, z);
                if ((x == targetX && z == targetZ)
                    || containsCell(candidates, cell)
                    || !handReachable(perception, cell, targetX, targetY, targetZ)) {
                    continue;
                }
                candidates.add(new BreakCandidate(cell, "reachable_in_reach_cell", "unrouted_unblocked_in_reach_cell"));
            }
        }
        return candidates;
    }

    private static int breakSurfacePenalty(GridPerception perception, GridCell cell, int targetY, boolean allowInReachCells) {
        if (!allowInReachCells) {
            return 0;
        }
        var surface = perception.surfaceY(cell.x(), cell.z());
        return surface.isPresent() && surface.getAsInt() > targetY ? 1 : 0;
    }

    private static int unroutedFallbackDistanceSquared(boolean allowInReachCells) {
        return allowInReachCells ? UNROUTED_BREAK_CELL_DISTANCE_SQUARED : UNROUTED_ADJACENT_DISTANCE_SQUARED;
    }

    private static boolean breakRouteUsesLocalSteps(GridPerception perception, List<GridCell> route, boolean allowInReachCells) {
        if (!allowInReachCells || route == null || route.size() < 2) {
            return true;
        }
        for (int i = 1; i < route.size(); i++) {
            if (!usesLocalStep(perception, route.get(i - 1), route.get(i))) {
                return false;
            }
        }
        return true;
    }

    private static boolean unroutedFallbackUsesLocalStep(
        GridPerception perception,
        GridCell start,
        GridCell cell,
        boolean allowInReachCells
    ) {
        return !allowInReachCells || usesLocalStep(perception, start, cell);
    }

    private static boolean usesLocalStep(GridPerception perception, GridCell from, GridCell to) {
        if (perception == null || from == null || to == null) {
            return false;
        }
        var fromSurface = perception.surfaceY(from.x(), from.z());
        var toSurface = perception.surfaceY(to.x(), to.z());
        if (fromSurface.isEmpty() || toSurface.isEmpty()) {
            return false;
        }
        int delta = toSurface.getAsInt() - fromSurface.getAsInt();
        return delta <= WalkabilityClassifier.MAX_AUTO_STEP_UP && delta >= -WalkabilityClassifier.MAX_AUTO_STEP_DOWN;
    }

    private static boolean containsCell(List<BreakCandidate> candidates, GridCell cell) {
        for (BreakCandidate candidate : candidates) {
            if (candidate.cell().equals(cell)) {
                return true;
            }
        }
        return false;
    }

    private static String noCandidateReason(boolean noExcludedCells, boolean allowInReachCells) {
        if (allowInReachCells) {
            return noExcludedCells ? "no_reachable_break_cell" : "no_reachable_unexcluded_break_cell";
        }
        return noExcludedCells ? "no_reachable_adjacent_cell" : "no_reachable_unexcluded_adjacent_cell";
    }

    private static boolean handReachable(GridPerception perception, GridCell cell, int targetX, int targetY, int targetZ) {
        if (perception == null || cell == null) {
            return false;
        }
        var surface = perception.surfaceY(cell.x(), cell.z());
        if (surface.isEmpty()) {
            return false;
        }
        double eyeX = cell.x() + 0.5D;
        double eyeY = surface.getAsInt() + EYE_HEIGHT_ESTIMATE;
        double eyeZ = cell.z() + 0.5D;
        double targetCenterX = targetX + 0.5D;
        double targetCenterY = targetY + 0.5D;
        double targetCenterZ = targetZ + 0.5D;
        double distanceSquared = square(targetCenterX - eyeX)
            + square(targetCenterY - eyeY)
            + square(targetCenterZ - eyeZ);
        return distanceSquared <= HAND_REACH_BLOCKS * HAND_REACH_BLOCKS;
    }

    private static List<GridCell> fallbackRoute(GridCell start, GridCell candidate) {
        if (start == null || candidate == null) {
            return List.of();
        }
        if (start.equals(candidate)) {
            return List.of(start);
        }
        return List.of(candidate);
    }

    private static double distanceSquared(GridCell a, GridCell b) {
        int dx = a.x() - b.x();
        int dz = a.z() - b.z();
        return dx * dx + dz * dz;
    }

    private static double square(double value) {
        return value * value;
    }
}
