package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.OptionalInt;

/** Chooses a standable, reachable navigation cell for dropped-item collection. */
final class CollectNavigationTargetPlanner {
    /** A candidate cell whose standable surface is more than this far from the drop's actual Y is rejected,
     * so the collect never routes to an overhang above (or a ledge below) the item it cannot pick up. */
    static final double MAX_COLLECT_SURFACE_GAP = 1.5;

    private CollectNavigationTargetPlanner() {
    }

    record TargetPlan(GridCell cell, List<GridCell> route, String reason) {
        TargetPlan {
            route = route == null ? List.of() : List.copyOf(route);
        }
    }

    static TargetPlan chooseTarget(GridPerception perception, GridCell start, GridCell itemCell) {
        return chooseTarget(perception, start, itemCell, null);
    }

    /** {@code dropY} (nullable): when set, only accept candidate cells whose standable surface is within
     * {@link #MAX_COLLECT_SURFACE_GAP} of the drop's actual Y. Without it, the 2-D heightmap can route to a
     * cell that is "standable" at an overhang far above the item, where the bot can never reach the drop. */
    static TargetPlan chooseTarget(GridPerception perception, GridCell start, GridCell itemCell, Double dropY) {
        if (perception == null || start == null || itemCell == null) {
            return new TargetPlan(null, List.of(), "invalid_request");
        }

        List<Candidate> candidates = new ArrayList<>();
        for (GridCell candidate : collectCandidates(itemCell)) {
            if (!perception.inBounds(candidate.x(), candidate.z())) {
                continue;
            }
            OptionalInt surface = perception.surfaceY(candidate.x(), candidate.z());
            if (surface.isEmpty()) {
                continue;
            }
            if (dropY != null && Math.abs(surface.getAsInt() - dropY) > MAX_COLLECT_SURFACE_GAP) {
                continue;
            }
            GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, start, candidate);
            if (diagnostic.routeFound()) {
                candidates.add(new Candidate(candidate, diagnostic.route()));
            }
        }
        if (candidates.isEmpty()) {
            return new TargetPlan(null, List.of(), "no_reachable_collect_cell");
        }
        candidates.sort(Comparator
            .comparingInt((Candidate candidate) -> collectDistanceSquared(candidate.cell(), itemCell))
            .thenComparingInt((Candidate candidate) -> candidate.route().size()));
        Candidate best = candidates.getFirst();
        String reason = best.cell().equals(itemCell) ? "reachable_item_cell" : "reachable_adjacent_collect_cell";
        return new TargetPlan(best.cell(), best.route(), reason);
    }

    private static List<GridCell> collectCandidates(GridCell itemCell) {
        return List.of(
            itemCell,
            new GridCell(itemCell.x() + 1, itemCell.z()),
            new GridCell(itemCell.x() - 1, itemCell.z()),
            new GridCell(itemCell.x(), itemCell.z() + 1),
            new GridCell(itemCell.x(), itemCell.z() - 1)
        );
    }

    private static int collectDistanceSquared(GridCell cell, GridCell itemCell) {
        int dx = cell.x() - itemCell.x();
        int dz = cell.z() - itemCell.z();
        return dx * dx + dz * dz;
    }

    private record Candidate(GridCell cell, List<GridCell> route) {
    }
}
