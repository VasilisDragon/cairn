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
import java.util.function.Predicate;

/**
 * Finds one bounded, reversible connector around an invalid waypoint in a frozen canonical
 * surface-return route. The planner never changes the route and never authorizes constructive
 * movement; callers own the atomic splice and trail persistence.
 */
final class SurfaceReturnRouteSuffixPlanner {
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

    private SurfaceReturnRouteSuffixPlanner() {
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> activeRoute,
        int invalidWaypointIndex
    ) {
        return plan(
            perception,
            activeRoute,
            invalidWaypointIndex,
            MAX_EXPANDED_CELLS,
            ignored -> false
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> activeRoute,
        int invalidWaypointIndex,
        Predicate<VoxelCell> protectedBlock
    ) {
        return plan(
            perception,
            activeRoute,
            invalidWaypointIndex,
            MAX_EXPANDED_CELLS,
            protectedBlock
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> activeRoute,
        int invalidWaypointIndex,
        int maxExpandedCells
    ) {
        return plan(
            perception,
            activeRoute,
            invalidWaypointIndex,
            maxExpandedCells,
            ignored -> false
        );
    }

    private static Result plan(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> activeRoute,
        int invalidWaypointIndex,
        int maxExpandedCells,
        Predicate<VoxelCell> protectedBlock
    ) {
        if (perception == null
            || activeRoute == null
            || invalidWaypointIndex <= 0
            || invalidWaypointIndex >= activeRoute.size()) {
            return failure("no_forward_rejoin", 0);
        }

        List<VoxelCell> route = List.copyOf(activeRoute);
        VoxelCell source = route.get(invalidWaypointIndex - 1);
        Predicate<VoxelCell> blocked = protectedBlock == null
            ? ignored -> false
            : protectedBlock;
        if (source == null || !safeCell(perception, source, blocked)) {
            return failure("start_blocked", 0);
        }

        Map<VoxelCell, Candidate> candidates = candidates(
            perception,
            route,
            invalidWaypointIndex,
            source,
            blocked
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
                    // Skipped suffix cells are the first ranking key. Once the earliest valid
                    // rejoin is popped by A*, its connector is already shortest for that cell.
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
                if (next == null || !safeCell(perception, next, blocked)) {
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
        String reason = intersectedTrail
            ? "trail_intersection"
            : exceededRouteCellLimit ? "route_cell_limit" : "no_safe_connector";
        return failure(reason, closed.size());
    }

    private static Map<VoxelCell, Candidate> candidates(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> route,
        int invalidWaypointIndex,
        VoxelCell source,
        Predicate<VoxelCell> protectedBlock
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
                || !safeCell(perception, rejoin, protectedBlock)) {
                continue;
            }
            candidates.putIfAbsent(
                rejoin,
                new Candidate(rejoin, index, index - invalidWaypointIndex)
            );
        }
        return candidates;
    }

    static boolean safeCell(
        GatherWoodLocalEgressPerception perception,
        VoxelCell cell
    ) {
        return SurfaceReturnTrailGapPlanner.safeCell(perception, cell);
    }

    static boolean safeCell(
        GatherWoodLocalEgressPerception perception,
        VoxelCell cell,
        Predicate<VoxelCell> protectedBlock
    ) {
        if (!safeCell(perception, cell)) {
            return false;
        }
        Predicate<VoxelCell> blocked = protectedBlock == null
            ? ignored -> false
            : protectedBlock;
        return !blocked.test(cell)
            && !blocked.test(new VoxelCell(cell.x(), cell.y() + 1, cell.z()))
            && !blocked.test(new VoxelCell(cell.x(), cell.y() - 1, cell.z()));
    }

    static boolean reversibleStep(
        VoxelPerception perception,
        VoxelCell from,
        VoxelCell to
    ) {
        return SurfaceReturnTrailGapPlanner.reversibleStep(perception, from, to);
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
