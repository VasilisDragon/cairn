package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/** Pure bounded 4-neighbor A* routing over {@link GridPerception}. */
public final class GridAStar {
    private static final GridCell[] NEIGHBORS = {
        new GridCell(1, 0),
        new GridCell(-1, 0),
        new GridCell(0, 1),
        new GridCell(0, -1)
    };

    private GridAStar() {
    }

    public static List<GridCell> route(GridPerception perception, GridCell start, GridCell goal) {
        return diagnose(perception, start, goal).route();
    }

    public static GridRouteDiagnostic diagnose(GridPerception perception, GridCell start, GridCell goal) {
        if (perception == null || start == null || goal == null) {
            return new GridRouteDiagnostic(List.of(), "invalid_request", 0, Map.of());
        }
        if (perception.isBlocked(start.x(), start.z())) {
            return new GridRouteDiagnostic(List.of(), "start_blocked", 0, Map.of());
        }
        if (perception.isBlocked(goal.x(), goal.z())) {
            return new GridRouteDiagnostic(List.of(), "goal_blocked", 0, Map.of());
        }
        if (start.equals(goal)) {
            return new GridRouteDiagnostic(List.of(start), "", 1, Map.of());
        }

        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingInt(Node::estimatedTotalCost)
                .thenComparingInt(Node::costFromStart)
                .thenComparingInt((node) -> node.cell().z())
                .thenComparingInt((node) -> node.cell().x())
        );
        Map<GridCell, GridCell> cameFrom = new HashMap<>();
        Map<GridCell, Integer> bestCost = new HashMap<>();
        Set<GridCell> closed = new HashSet<>();
        EnumMap<TraversalIssue, Integer> rejectionCounts = new EnumMap<>(TraversalIssue.class);
        List<GridRejectionSample> rejectionSamples = new ArrayList<>();

        bestCost.put(start, 0);
        open.add(new Node(start, 0, heuristic(start, goal)));

        while (!open.isEmpty()) {
            Node node = open.poll();
            GridCell cell = node.cell();
            if (!closed.add(cell)) {
                continue;
            }
            if (cell.equals(goal)) {
                return new GridRouteDiagnostic(reconstruct(cameFrom, start, goal), "", closed.size(), rejectionCounts);
            }

            for (GridCell delta : NEIGHBORS) {
                GridCell next = new GridCell(cell.x() + delta.x(), cell.z() + delta.z());
                if (closed.contains(next)) {
                    continue;
                }
                TraversalIssue issue = perception.traversalIssue(cell, next);
                if (issue != TraversalIssue.NONE) {
                    rejectionCounts.merge(issue, 1, Integer::sum);
                    rememberRejectionSample(perception, rejectionSamples, issue, cell, next);
                    continue;
                }
                int nextCost = node.costFromStart() + 1;
                int knownCost = bestCost.getOrDefault(next, Integer.MAX_VALUE);
                if (nextCost >= knownCost) {
                    continue;
                }
                bestCost.put(next, nextCost);
                cameFrom.put(next, cell);
                open.add(new Node(next, nextCost, nextCost + heuristic(next, goal)));
            }
        }

        return new GridRouteDiagnostic(List.of(), "open_exhausted", closed.size(), rejectionCounts, rejectionSamples);
    }

    private static void rememberRejectionSample(
        GridPerception perception,
        List<GridRejectionSample> samples,
        TraversalIssue issue,
        GridCell from,
        GridCell to
    ) {
        if (samples.size() >= 32 || samples.stream().anyMatch((sample) -> sample.issue() == issue)) {
            return;
        }
        var fromSurface = perception.surfaceY(from.x(), from.z());
        var toSurface = perception.surfaceY(to.x(), to.z());
        samples.add(new GridRejectionSample(
            issue,
            from,
            to,
            fromSurface.isPresent() ? fromSurface.getAsInt() : null,
            toSurface.isPresent() ? toSurface.getAsInt() : null
        ));
    }

    private static int heuristic(GridCell from, GridCell to) {
        return Math.abs(to.x() - from.x()) + Math.abs(to.z() - from.z());
    }

    private static List<GridCell> reconstruct(Map<GridCell, GridCell> cameFrom, GridCell start, GridCell goal) {
        ArrayDeque<GridCell> reversed = new ArrayDeque<>();
        GridCell cursor = goal;
        reversed.addFirst(cursor);
        while (!cursor.equals(start)) {
            cursor = cameFrom.get(cursor);
            if (cursor == null) {
                return List.of();
            }
            reversed.addFirst(cursor);
        }
        return new ArrayList<>(reversed);
    }

    private record Node(GridCell cell, int costFromStart, int estimatedTotalCost) {
    }
}
