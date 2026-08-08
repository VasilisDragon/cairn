package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

final class MiningWorkspaceBreadcrumbGapPlanner {
    static final int MAX_HORIZONTAL_MANHATTAN = 4;
    static final int MAX_VERTICAL_DIFFERENCE = 2;
    static final int MAX_EXPANDED_CELLS = 128;
    static final int MAX_ROUTE_CELLS = 8;

    private static final VoxelCell[] CARDINALS = {
        new VoxelCell(0, 0, -1),
        new VoxelCell(1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(-1, 0, 0)
    };

    private MiningWorkspaceBreadcrumbGapPlanner() {
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell frontier,
        VoxelCell current,
        List<VoxelCell> existingTrail
    ) {
        return plan(perception, frontier, current, existingTrail, MAX_EXPANDED_CELLS);
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell frontier,
        VoxelCell current,
        List<VoxelCell> existingTrail,
        int maxExpandedCells
    ) {
        if (perception == null || frontier == null || current == null) {
            return failure("gap_out_of_bounds", 0);
        }
        int horizontalGap = Math.abs(current.x() - frontier.x()) + Math.abs(current.z() - frontier.z());
        if (horizontalGap > MAX_HORIZONTAL_MANHATTAN
            || Math.abs(current.y() - frontier.y()) > MAX_VERTICAL_DIFFERENCE
            || !queryable(perception, frontier)
            || !queryable(perception, current)) {
            return failure("gap_out_of_bounds", 0);
        }
        if (!safeCell(perception, frontier)) {
            return failure("start_blocked", 0);
        }
        if (!safeCell(perception, current)) {
            return failure("goal_blocked", 0);
        }

        Set<VoxelCell> excludedTrail = new HashSet<>();
        if (existingTrail != null) {
            for (VoxelCell cell : existingTrail) {
                if (cell != null && !cell.equals(frontier)) {
                    excludedTrail.add(cell);
                }
            }
        }
        if (excludedTrail.contains(current)) {
            return failure("existing_route_intersection", 0);
        }
        if (frontier.equals(current)) {
            return success(List.of(frontier), 1);
        }

        int budget = Math.max(1, Math.min(MAX_EXPANDED_CELLS, maxExpandedCells));
        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingInt(Node::estimatedTotalCost)
                .thenComparingInt(Node::costFromStart)
                .thenComparingInt(node -> node.cell().y())
                .thenComparingInt(node -> node.cell().z())
                .thenComparingInt(node -> node.cell().x())
        );
        Map<VoxelCell, VoxelCell> cameFrom = new HashMap<>();
        Map<VoxelCell, Integer> bestCost = new HashMap<>();
        Set<VoxelCell> closed = new HashSet<>();
        boolean intersectedTrail = false;
        boolean exceededRouteCellLimit = false;
        bestCost.put(frontier, 0);
        open.add(new Node(frontier, 0, heuristic(frontier, current)));

        while (!open.isEmpty()) {
            if (closed.size() >= budget) {
                return failure("expanded_budget", closed.size());
            }
            Node node = open.poll();
            VoxelCell cell = node.cell();
            if (node.costFromStart() != bestCost.getOrDefault(cell, Integer.MAX_VALUE) || !closed.add(cell)) {
                continue;
            }
            if (cell.equals(current)) {
                List<VoxelCell> connector = reconstruct(cameFrom, frontier, current);
                return connector.size() > MAX_ROUTE_CELLS
                    ? failure("route_cell_limit", closed.size())
                    : success(connector, closed.size());
            }

            for (VoxelCell delta : CARDINALS) {
                VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(perception, cell, delta);
                VoxelCell next = move.destination();
                if (next == null || !safeCell(perception, next)) {
                    continue;
                }
                if (excludedTrail.contains(next)) {
                    intersectedTrail = true;
                    continue;
                }
                if (!reversibleStep(perception, cell, next) || closed.contains(next)) {
                    continue;
                }
                int nextCost = node.costFromStart() + 1;
                if (nextCost >= MAX_ROUTE_CELLS) {
                    exceededRouteCellLimit = true;
                    continue;
                }
                if (nextCost >= bestCost.getOrDefault(next, Integer.MAX_VALUE)) {
                    continue;
                }
                bestCost.put(next, nextCost);
                cameFrom.put(next, cell);
                open.add(new Node(next, nextCost, nextCost + heuristic(next, current)));
            }
        }

        String failureReason = intersectedTrail
            ? "existing_route_intersection"
            : exceededRouteCellLimit ? "route_cell_limit" : "no_safe_connector";
        return failure(failureReason, closed.size());
    }

    private static boolean queryable(GatherWoodLocalEgressPerception perception, VoxelCell cell) {
        return perception.inBounds(cell.x(), cell.y() - 1, cell.z())
            && perception.inBounds(cell.x(), cell.y(), cell.z())
            && perception.inBounds(cell.x(), cell.y() + 1, cell.z());
    }

    private static boolean safeCell(GatherWoodLocalEgressPerception perception, VoxelCell cell) {
        if (!queryable(perception, cell)
            || !perception.isStandable(cell.x(), cell.y(), cell.z())
            || perception.isWater(cell.x(), cell.y() - 1, cell.z())
            || perception.isWater(cell.x(), cell.y(), cell.z())
            || perception.isWater(cell.x(), cell.y() + 1, cell.z())
            || perception.isLava(cell.x(), cell.y() - 1, cell.z())
            || perception.isLava(cell.x(), cell.y(), cell.z())
            || perception.isLava(cell.x(), cell.y() + 1, cell.z())) {
            return false;
        }
        for (VoxelCell delta : CARDINALS) {
            int x = cell.x() + delta.x();
            int z = cell.z() + delta.z();
            for (int y = cell.y() - 1; y <= cell.y() + 1; y++) {
                if (perception.inBounds(x, y, z) && perception.isLava(x, y, z)) {
                    return false;
                }
            }
        }
        return true;
    }

    static boolean reversibleStep(
        VoxelPerception perception,
        VoxelCell from,
        VoxelCell to
    ) {
        if (perception == null || from == null || to == null) {
            return false;
        }
        int dx = to.x() - from.x();
        int dz = to.z() - from.z();
        if (Math.abs(dx) + Math.abs(dz) != 1 || Math.abs(to.y() - from.y()) > 1) {
            return false;
        }
        VoxelAStar.Move forward = VoxelAStar.resolveTraversalMove(
            perception, from, new VoxelCell(dx, 0, dz));
        if (!to.equals(forward.destination())) {
            return false;
        }
        VoxelAStar.Move reverse = VoxelAStar.resolveTraversalMove(
            perception, to, new VoxelCell(-dx, 0, -dz));
        return from.equals(reverse.destination());
    }

    private static int heuristic(VoxelCell from, VoxelCell to) {
        int horizontal = Math.abs(to.x() - from.x()) + Math.abs(to.z() - from.z());
        return Math.max(horizontal, Math.abs(to.y() - from.y()));
    }

    private static List<VoxelCell> reconstruct(
        Map<VoxelCell, VoxelCell> cameFrom,
        VoxelCell start,
        VoxelCell goal
    ) {
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
        return List.copyOf(new ArrayList<>(reversed));
    }

    private static Result success(List<VoxelCell> connector, int expandedCells) {
        return new Result(connector, "", expandedCells);
    }

    private static Result failure(String reason, int expandedCells) {
        return new Result(List.of(), reason, expandedCells);
    }

    record Result(List<VoxelCell> connector, String failureReason, int expandedCells) {
        Result {
            connector = connector == null ? List.of() : List.copyOf(connector);
            failureReason = failureReason == null ? "" : failureReason;
        }

        boolean found() {
            return !connector.isEmpty();
        }
    }

    private record Node(VoxelCell cell, int costFromStart, int estimatedTotalCost) {
    }
}
