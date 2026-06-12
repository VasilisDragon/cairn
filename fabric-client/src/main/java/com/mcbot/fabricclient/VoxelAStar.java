package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/** Pure bounded 4-neighbor 3-D traversal A* over {@link VoxelPerception}. No constructive moves. */
public final class VoxelAStar {
    private static final VoxelCell[] HORIZONTAL_NEIGHBORS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    private VoxelAStar() {
    }

    public static List<VoxelCell> route(VoxelPerception perception, VoxelCell start, VoxelCell goal) {
        return diagnose(perception, start, goal).route();
    }

    public static Nav3DRouteDiagnostic diagnose(VoxelPerception perception, VoxelCell start, VoxelCell goal) {
        if (perception == null || start == null || goal == null) {
            return new Nav3DRouteDiagnostic(List.of(), "invalid_request", 0, Map.of());
        }
        if (!perception.isStandable(start.x(), start.y(), start.z())) {
            return new Nav3DRouteDiagnostic(List.of(), "start_blocked", 0, Map.of());
        }
        if (!perception.isStandable(goal.x(), goal.y(), goal.z())) {
            return new Nav3DRouteDiagnostic(List.of(), "goal_blocked", 0, Map.of());
        }
        if (start.equals(goal)) {
            return new Nav3DRouteDiagnostic(List.of(start), "", 1, Map.of());
        }

        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingInt(Node::estimatedTotalCost)
                .thenComparingInt(Node::costFromStart)
                .thenComparingInt((node) -> node.cell().y())
                .thenComparingInt((node) -> node.cell().z())
                .thenComparingInt((node) -> node.cell().x())
        );
        Map<VoxelCell, VoxelCell> cameFrom = new HashMap<>();
        Map<VoxelCell, Integer> bestCost = new HashMap<>();
        Set<VoxelCell> closed = new HashSet<>();
        Map<String, Integer> rejectionCounts = new LinkedHashMap<>();

        bestCost.put(start, 0);
        open.add(new Node(start, 0, heuristic(start, goal)));

        while (!open.isEmpty()) {
            Node node = open.poll();
            VoxelCell cell = node.cell();
            if (!closed.add(cell)) {
                continue;
            }
            if (cell.equals(goal)) {
                return new Nav3DRouteDiagnostic(reconstruct(cameFrom, start, goal), "", closed.size(), rejectionCounts);
            }

            for (VoxelCell delta : HORIZONTAL_NEIGHBORS) {
                Move move = resolveTraversalMove(perception, cell, delta);
                if (move.destination() == null) {
                    rejectionCounts.merge(move.reason(), 1, Integer::sum);
                    continue;
                }
                VoxelCell next = move.destination();
                if (closed.contains(next)) {
                    continue;
                }
                int nextCost = node.costFromStart() + move.cost();
                int knownCost = bestCost.getOrDefault(next, Integer.MAX_VALUE);
                if (nextCost >= knownCost) {
                    continue;
                }
                bestCost.put(next, nextCost);
                cameFrom.put(next, cell);
                open.add(new Node(next, nextCost, nextCost + heuristic(next, goal)));
            }
        }

        return new Nav3DRouteDiagnostic(List.of(), "open_exhausted", closed.size(), rejectionCounts);
    }

    static Move resolveTraversalMove(VoxelPerception perception, VoxelCell from, VoxelCell delta) {
        if (perception == null || from == null || delta == null) {
            return Move.rejected("invalid_request");
        }
        if (!perception.isStandable(from.x(), from.y(), from.z())) {
            return Move.rejected("from_blocked");
        }
        int x = from.x() + delta.x();
        int z = from.z() + delta.z();
        int y = from.y();
        if (!perception.inBounds(x, y, z)) {
            return Move.rejected("out_of_bounds");
        }
        VoxelCell sameLevel = new VoxelCell(x, y, z);
        if (perception.isStandable(sameLevel.x(), sameLevel.y(), sameLevel.z())) {
            return new Move(sameLevel, 1, "");
        }
        VoxelCell stepUp = new VoxelCell(x, y + 1, z);
        if (perception.inBounds(stepUp.x(), stepUp.y(), stepUp.z())
            && perception.isStandable(stepUp.x(), stepUp.y(), stepUp.z())) {
            return new Move(stepUp, 1, "");
        }
        for (int drop = 1; drop <= WalkabilityClassifier.MAX_SAFE_DROP; drop++) {
            VoxelCell down = new VoxelCell(x, y - drop, z);
            if (!perception.inBounds(down.x(), down.y(), down.z())) {
                continue;
            }
            if (perception.isStandable(down.x(), down.y(), down.z())) {
                return new Move(down, 1, "");
            }
        }
        return Move.rejected("no_traversable_destination");
    }

    private static int heuristic(VoxelCell from, VoxelCell to) {
        return Math.abs(to.x() - from.x()) + Math.abs(to.y() - from.y()) + Math.abs(to.z() - from.z());
    }

    private static List<VoxelCell> reconstruct(Map<VoxelCell, VoxelCell> cameFrom, VoxelCell start, VoxelCell goal) {
        ArrayDeque<VoxelCell> reversed = new ArrayDeque<>();
        VoxelCell cursor = goal;
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

    record Move(VoxelCell destination, int cost, String reason) {
        static Move rejected(String reason) {
            return new Move(null, 0, reason == null || reason.isBlank() ? "rejected" : reason);
        }
    }

    private record Node(VoxelCell cell, int costFromStart, int estimatedTotalCost) {
    }
}
