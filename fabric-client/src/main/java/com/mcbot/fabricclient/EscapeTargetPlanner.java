package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;

/**
 * Pure escape-target selection for nav-aware fleeing. Flood-fills the cells reachable from the bot
 * (respecting the same traversal rules as {@link GridAStar}) and returns the reachable cell that
 * maximizes distance from the threat — i.e. the safest spot the bot can actually walk to, routing
 * around walls when the straight-away direction is blocked. The caller routes to it with
 * {@link GridAStar} and follows the path.
 *
 * <p>No Minecraft types — fully unit-testable. Returns empty when the bot is boxed in (no reachable
 * cell is farther from the threat than where it already stands), so the caller can fall back to the
 * fast sprint-jump flee.
 */
public final class EscapeTargetPlanner {
    private static final GridCell[] NEIGHBORS = {
        new GridCell(1, 0),
        new GridCell(-1, 0),
        new GridCell(0, 1),
        new GridCell(0, -1)
    };

    private EscapeTargetPlanner() {
    }

    public static Optional<GridCell> pickEscapeCell(
        GridPerception perception, GridCell from, GridCell threat, int maxCells) {
        if (perception == null || from == null || threat == null) {
            return Optional.empty();
        }
        if (perception.isBlocked(from.x(), from.z())) {
            return Optional.empty();
        }
        int budget = Math.max(1, maxCells);
        Set<GridCell> visited = new HashSet<>();
        ArrayDeque<GridCell> queue = new ArrayDeque<>();
        visited.add(from);
        queue.add(from);

        GridCell best = from;
        long fromScore = distanceSquared(from, threat);
        long bestScore = fromScore;

        while (!queue.isEmpty() && visited.size() <= budget) {
            GridCell cell = queue.poll();
            long score = distanceSquared(cell, threat);
            if (score > bestScore) {
                bestScore = score;
                best = cell;
            }
            for (GridCell delta : NEIGHBORS) {
                GridCell next = new GridCell(cell.x() + delta.x(), cell.z() + delta.z());
                if (visited.contains(next)) {
                    continue;
                }
                if (perception.canTraverse(cell, next)) {
                    visited.add(next);
                    queue.add(next);
                }
            }
        }

        if (best.equals(from) || bestScore <= fromScore) {
            return Optional.empty();
        }
        return Optional.of(best);
    }

    private static long distanceSquared(GridCell a, GridCell b) {
        long dx = (long) a.x() - b.x();
        long dz = (long) a.z() - b.z();
        return dx * dx + dz * dz;
    }
}
