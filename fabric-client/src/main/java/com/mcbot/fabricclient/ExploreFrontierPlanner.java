package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.PriorityQueue;
import java.util.Set;

final class ExploreFrontierPlanner {
    static final int MAX_EXPANDED_CELLS = 2_048;
    static final double MIN_PROGRESS_BLOCKS = 2.0D;
    static final long ROUTE_CACHE_MS = 1_500L;
    private static final VoxelCell[] NEIGHBORS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    private ExploreFrontierPlanner() {
    }

    static Result plan(VoxelPerception perception, VoxelCell start, double targetX, double targetZ) {
        return plan(perception, start, targetX, targetZ, MAX_EXPANDED_CELLS, Set.of());
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        double targetX,
        double targetZ,
        Set<DirectedTransition> excludedTransitions
    ) {
        return plan(
            perception,
            start,
            targetX,
            targetZ,
            MAX_EXPANDED_CELLS,
            excludedTransitions
        );
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        double targetX,
        double targetZ,
        int maxExpandedCells
    ) {
        return plan(perception, start, targetX, targetZ, maxExpandedCells, Set.of());
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        double targetX,
        double targetZ,
        int maxExpandedCells,
        Set<DirectedTransition> excludedTransitions
    ) {
        double startDistance = horizontalDistance(start, targetX, targetZ);
        if (perception == null || start == null || !Double.isFinite(targetX) || !Double.isFinite(targetZ)) {
            return new Result(null, "invalid_request", 0, startDistance);
        }
        if (!perception.isStandable(start.x(), start.y(), start.z())) {
            return new Result(null, "start_unstandable", 0, startDistance);
        }

        Set<DirectedTransition> exclusions = excludedTransitions == null
            ? Set.of()
            : Set.copyOf(excludedTransitions);
        int budget = Math.max(1, Math.min(MAX_EXPANDED_CELLS, maxExpandedCells));
        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingDouble((Node node) -> horizontalDistance(node.cell(), targetX, targetZ))
                .thenComparingInt(Node::cost)
                .thenComparingInt(node -> Math.abs(node.cell().y() - start.y()))
                .thenComparingInt(node -> node.cell().y())
                .thenComparingInt(node -> node.cell().z())
                .thenComparingInt(node -> node.cell().x())
        );
        Map<VoxelCell, VoxelCell> cameFrom = new HashMap<>();
        Map<VoxelCell, Integer> bestCost = new HashMap<>();
        Set<VoxelCell> closed = new HashSet<>();
        List<Candidate> candidates = new ArrayList<>();
        bestCost.put(start, 0);
        open.add(new Node(start, 0));

        while (!open.isEmpty() && closed.size() < budget) {
            Node node = open.poll();
            VoxelCell cell = node.cell();
            if (!closed.add(cell)) {
                continue;
            }
            double remainingDistance = horizontalDistance(cell, targetX, targetZ);
            if (!cell.equals(start) && startDistance - remainingDistance >= MIN_PROGRESS_BLOCKS) {
                candidates.add(new Candidate(
                    cell,
                    node.cost(),
                    Math.abs(cell.y() - start.y()),
                    remainingDistance
                ));
            }
            for (VoxelCell delta : NEIGHBORS) {
                VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(perception, cell, delta);
                VoxelCell next = move.destination();
                if (next == null || closed.contains(next)) {
                    continue;
                }
                if (exclusions.contains(new DirectedTransition(cell, next))) {
                    continue;
                }
                int cost = node.cost() + move.cost();
                if (cost >= bestCost.getOrDefault(next, Integer.MAX_VALUE)) {
                    continue;
                }
                bestCost.put(next, cost);
                cameFrom.put(next, cell);
                open.add(new Node(next, cost));
            }
        }

        if (candidates.isEmpty()) {
            String reason = open.isEmpty() ? "no_progress_frontier" : "expanded_budget";
            return new Result(null, reason, closed.size(), startDistance);
        }
        Candidate chosen = candidates.stream().min(
            Comparator.comparingDouble(Candidate::remainingDistance)
                .thenComparingInt(Candidate::routeCost)
                .thenComparingInt(Candidate::verticalDisplacement)
                .thenComparingInt(candidate -> candidate.cell().y())
                .thenComparingInt(candidate -> candidate.cell().z())
                .thenComparingInt(candidate -> candidate.cell().x())
        ).orElseThrow();
        List<VoxelCell> route = reconstruct(cameFrom, start, chosen.cell());
        Plan plan = new Plan(
            chosen.cell(),
            route,
            "reachable_frontier",
            closed.size(),
            startDistance,
            chosen.remainingDistance()
        );
        return new Result(plan, "", closed.size(), startDistance);
    }

    static boolean reasonAllowed(String reason) {
        return reason != null && reason.startsWith("exploration:");
    }

    static boolean shouldAttempt(
        String reason,
        boolean normalRouteFound,
        boolean safeDropSelected,
        boolean alreadyAttempted
    ) {
        return reasonAllowed(reason) && !normalRouteFound && !safeDropSelected && !alreadyAttempted;
    }

    static String attemptKey(String commandId, VoxelCell start) {
        return String.valueOf(commandId) + ":" + String.valueOf(start);
    }

    static boolean routeStale(long computedAtMs, long nowMs) {
        return nowMs - computedAtMs >= ROUTE_CACHE_MS;
    }

    static boolean commandChanged(String activeCommandId, String commandId) {
        return activeCommandId != null && !activeCommandId.isEmpty() && !activeCommandId.equals(commandId);
    }

    static boolean aimAtFrontier(boolean frontierRoute, boolean finalWaypoint) {
        return frontierRoute && finalWaypoint;
    }

    static String driveSuffix(boolean frontierRoute, boolean nextWaypointBelow, boolean originalTargetBelow) {
        boolean descending = frontierRoute ? nextWaypointBelow : originalTargetBelow;
        return descending ? "_nav3d_descend" : "_nav3d";
    }

    static boolean reached(VoxelCell actualFeet, VoxelCell frontier) {
        return actualFeet != null && actualFeet.equals(frontier);
    }

    static boolean descendingStep(VoxelCell playerFeet, VoxelCell nextWaypoint) {
        return playerFeet != null && nextWaypoint != null && nextWaypoint.y() < playerFeet.y();
    }

    static Plan stageBeforeProgressingDescent(Plan plan, double targetX, double targetZ) {
        if (plan == null || plan.route().size() < 2) {
            return plan;
        }
        List<VoxelCell> route = plan.route();
        for (int index = 1; index < route.size(); index++) {
            VoxelCell before = route.get(index - 1);
            VoxelCell after = route.get(index);
            if (after.y() >= before.y()
                || horizontalDistance(after, targetX, targetZ) >= horizontalDistance(before, targetX, targetZ) - 0.01D) {
                continue;
            }
            double remainingDistance = horizontalDistance(before, targetX, targetZ);
            if (index < 2 || plan.startDistance() - remainingDistance < MIN_PROGRESS_BLOCKS) {
                return null;
            }
            return new Plan(
                before,
                List.copyOf(route.subList(0, index)),
                "safe_drop_staging_frontier",
                plan.expandedNodes(),
                plan.startDistance(),
                remainingDistance
            );
        }
        return plan;
    }

    private static double horizontalDistance(VoxelCell cell, double targetX, double targetZ) {
        if (cell == null || !Double.isFinite(targetX) || !Double.isFinite(targetZ)) {
            return Double.POSITIVE_INFINITY;
        }
        return Math.hypot((cell.x() + 0.5D) - targetX, (cell.z() + 0.5D) - targetZ);
    }

    private static List<VoxelCell> reconstruct(
        Map<VoxelCell, VoxelCell> cameFrom,
        VoxelCell start,
        VoxelCell frontier
    ) {
        ArrayDeque<VoxelCell> reversed = new ArrayDeque<>();
        VoxelCell cursor = frontier;
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

    record Plan(
        VoxelCell frontier,
        List<VoxelCell> route,
        String reason,
        int expandedNodes,
        double startDistance,
        double remainingDistance
    ) {
        double netProgress() {
            return startDistance - remainingDistance;
        }

        int verticalDelta() {
            return route.isEmpty() ? 0 : frontier.y() - route.getFirst().y();
        }
    }

    record Result(Plan plan, String failureReason, int expandedNodes, double startDistance) {
        boolean found() {
            return plan != null && !plan.route().isEmpty();
        }
    }

    record DirectedTransition(VoxelCell from, VoxelCell to) {
        DirectedTransition {
            Objects.requireNonNull(from, "from");
            Objects.requireNonNull(to, "to");
        }
    }

    private record Node(VoxelCell cell, int cost) {
    }

    private record Candidate(
        VoxelCell cell,
        int routeCost,
        int verticalDisplacement,
        double remainingDistance
    ) {
    }
}
