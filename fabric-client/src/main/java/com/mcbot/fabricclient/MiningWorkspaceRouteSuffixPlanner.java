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

final class MiningWorkspaceRouteSuffixPlanner {
    static final int MAX_REJOIN_INDICES = 8;
    static final int MAX_HORIZONTAL_MANHATTAN = 4;
    static final int MAX_VERTICAL_DIFFERENCE = 2;
    static final int MAX_EXPANDED_CELLS = 128;
    static final int MAX_CONNECTOR_CELLS = 8;

    private static final VoxelCell[] CARDINALS = {
        new VoxelCell(0, 0, -1),
        new VoxelCell(1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(-1, 0, 0)
    };

    private MiningWorkspaceRouteSuffixPlanner() {
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> activeRoute,
        int invalidWaypointIndex
    ) {
        return plan(perception, activeRoute, invalidWaypointIndex, MAX_EXPANDED_CELLS);
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> activeRoute,
        int invalidWaypointIndex,
        int maxExpandedCells
    ) {
        if (perception == null
            || activeRoute == null
            || invalidWaypointIndex <= 0
            || invalidWaypointIndex >= activeRoute.size()) {
            return failure("no_forward_rejoin", 0);
        }
        List<VoxelCell> route = List.copyOf(activeRoute);
        VoxelCell source = route.get(invalidWaypointIndex - 1);
        if (source == null || !safeCell(perception, source)) {
            return failure("start_blocked", 0);
        }

        Map<VoxelCell, Candidate> candidates = candidates(
            perception,
            route,
            invalidWaypointIndex,
            source
        );
        if (candidates.isEmpty()) {
            return failure("no_forward_rejoin", 0);
        }

        Set<VoxelCell> frozenRoute = new HashSet<>();
        for (VoxelCell cell : route) {
            if (cell != null && !cell.equals(source)) {
                frozenRoute.add(cell);
            }
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
        List<Option> options = new ArrayList<>();
        boolean intersectedTrail = false;
        boolean exceededRouteCellLimit = false;
        int earliestRejoinIndex = candidates.values().stream()
            .mapToInt(Candidate::routeIndex)
            .min()
            .orElseThrow();

        bestCost.put(source, 0);
        open.add(new Node(source, 0, heuristic(source, candidates.keySet())));

        while (!open.isEmpty()) {
            Node node = open.poll();
            VoxelCell cell = node.cell();
            if (node.costFromStart() != bestCost.getOrDefault(cell, Integer.MAX_VALUE)
                || closed.contains(cell)) {
                continue;
            }
            if (closed.size() >= budget) {
                return failure("expanded_budget", closed.size());
            }
            closed.add(cell);

            Candidate candidate = candidates.get(cell);
            if (candidate != null) {
                List<VoxelCell> connector = reconstruct(cameFrom, source, cell);
                if (!connector.isEmpty() && connector.size() <= MAX_CONNECTOR_CELLS) {
                    Option option = new Option(candidate, connector);
                    if (candidate.routeIndex() == earliestRejoinIndex) {
                        return success(option.connector(), option.candidate(), closed.size());
                    }
                    options.add(option);
                }
                continue;
            }

            for (VoxelCell delta : CARDINALS) {
                VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(perception, cell, delta);
                VoxelCell next = move.destination();
                if (next == null || !safeCell(perception, next)) {
                    continue;
                }
                Candidate nextCandidate = candidates.get(next);
                if (frozenRoute.contains(next) && nextCandidate == null) {
                    if (!cell.equals(source)) {
                        intersectedTrail = true;
                    }
                    continue;
                }
                if (!reversibleStep(perception, cell, next) || closed.contains(next)) {
                    continue;
                }
                int nextCost = node.costFromStart() + 1;
                if (nextCost >= MAX_CONNECTOR_CELLS) {
                    exceededRouteCellLimit = true;
                    continue;
                }
                if (nextCost >= bestCost.getOrDefault(next, Integer.MAX_VALUE)) {
                    continue;
                }
                bestCost.put(next, nextCost);
                cameFrom.put(next, cell);
                open.add(new Node(
                    next,
                    nextCost,
                    nextCost + heuristic(next, candidates.keySet())
                ));
            }
        }

        if (!options.isEmpty()) {
            Option best = options.stream().min(OPTION_ORDER).orElseThrow();
            return success(best.connector(), best.candidate(), closed.size());
        }
        String failureReason = intersectedTrail
            ? "trail_intersection"
            : exceededRouteCellLimit ? "route_cell_limit" : "no_safe_connector";
        return failure(failureReason, closed.size());
    }

    private static Map<VoxelCell, Candidate> candidates(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> route,
        int invalidWaypointIndex,
        VoxelCell source
    ) {
        Map<VoxelCell, Candidate> candidates = new LinkedHashMap<>();
        int lastIndex = Math.min(
            route.size() - 1,
            invalidWaypointIndex + MAX_REJOIN_INDICES
        );
        for (int index = invalidWaypointIndex + 1; index <= lastIndex; index++) {
            VoxelCell rejoin = route.get(index);
            if (rejoin == null
                || rejoin.equals(source)
                || horizontalManhattan(source, rejoin) > MAX_HORIZONTAL_MANHATTAN
                || Math.abs(rejoin.y() - source.y()) > MAX_VERTICAL_DIFFERENCE
                || !safeCell(perception, rejoin)) {
                continue;
            }
            candidates.putIfAbsent(
                rejoin,
                new Candidate(rejoin, index, index - invalidWaypointIndex)
            );
        }
        return candidates;
    }

    private static boolean safeCell(
        GatherWoodLocalEgressPerception perception,
        VoxelCell cell
    ) {
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
                if (!perception.inBounds(x, y, z) || perception.isLava(x, y, z)) {
                    return false;
                }
            }
        }
        return true;
    }

    private static boolean queryable(
        GatherWoodLocalEgressPerception perception,
        VoxelCell cell
    ) {
        return perception.inBounds(cell.x(), cell.y() - 1, cell.z())
            && perception.inBounds(cell.x(), cell.y(), cell.z())
            && perception.inBounds(cell.x(), cell.y() + 1, cell.z());
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
            perception,
            from,
            new VoxelCell(dx, 0, dz)
        );
        if (!to.equals(forward.destination())) {
            return false;
        }
        VoxelAStar.Move reverse = VoxelAStar.resolveTraversalMove(
            perception,
            to,
            new VoxelCell(-dx, 0, -dz)
        );
        return from.equals(reverse.destination());
    }

    private static int heuristic(VoxelCell from, Set<VoxelCell> goals) {
        int best = Integer.MAX_VALUE;
        for (VoxelCell goal : goals) {
            int horizontal = horizontalManhattan(from, goal);
            best = Math.min(best, Math.max(horizontal, Math.abs(goal.y() - from.y())));
        }
        return best == Integer.MAX_VALUE ? 0 : best;
    }

    private static int horizontalManhattan(VoxelCell first, VoxelCell second) {
        return Math.abs(second.x() - first.x()) + Math.abs(second.z() - first.z());
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
        return List.copyOf(reversed);
    }

    private static Result success(
        List<VoxelCell> connector,
        Candidate candidate,
        int expandedCells
    ) {
        return new Result(
            connector,
            candidate.waypoint(),
            candidate.routeIndex(),
            candidate.skippedCells(),
            "",
            expandedCells
        );
    }

    private static Result failure(String reason, int expandedCells) {
        return new Result(List.of(), null, -1, 0, reason, expandedCells);
    }

    record Result(
        List<VoxelCell> connector,
        VoxelCell rejoinWaypoint,
        int rejoinIndex,
        int skippedCells,
        String failureReason,
        int expandedCells
    ) {
        Result {
            connector = connector == null ? List.of() : List.copyOf(connector);
            failureReason = failureReason == null ? "" : failureReason;
        }

        boolean found() {
            return !connector.isEmpty();
        }
    }

    private static final Comparator<Option> OPTION_ORDER =
        Comparator.comparingInt((Option option) -> option.candidate().skippedCells())
            .thenComparingInt(option -> option.connector().size())
            .thenComparingInt(option -> Math.abs(
                option.candidate().waypoint().y() - option.connector().getFirst().y()
            ))
            .thenComparingInt(option -> option.candidate().waypoint().y())
            .thenComparingInt(option -> option.candidate().waypoint().z())
            .thenComparingInt(option -> option.candidate().waypoint().x());

    private record Candidate(VoxelCell waypoint, int routeIndex, int skippedCells) {
    }

    private record Option(Candidate candidate, List<VoxelCell> connector) {
    }

    private record Node(VoxelCell cell, int costFromStart, int estimatedTotalCost) {
    }
}
