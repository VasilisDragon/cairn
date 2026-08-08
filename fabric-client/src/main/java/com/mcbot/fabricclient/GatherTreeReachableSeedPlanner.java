package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

final class GatherTreeReachableSeedPlanner {
    static final int MAX_EXPANDED_CELLS = 2_048;
    static final int MAX_ROUTE_CELLS = 32;
    static final double MIN_FRONTIER_HORIZONTAL_PROGRESS = 2.0D;

    private static final VoxelCell[] CARDINALS = {
        new VoxelCell(0, 0, -1),
        new VoxelCell(1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(-1, 0, 0)
    };

    private GatherTreeReachableSeedPlanner() {
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach
    ) {
        return plan(
            perception,
            start,
            candidateLogs,
            interactionReach,
            Set.of(),
            MAX_EXPANDED_CELLS,
            true
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach,
        boolean allowFrontier
    ) {
        return plan(
            perception,
            start,
            candidateLogs,
            interactionReach,
            Set.of(),
            MAX_EXPANDED_CELLS,
            allowFrontier
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach,
        Set<VoxelCell> excludedStances
    ) {
        return plan(
            perception,
            start,
            candidateLogs,
            interactionReach,
            excludedStances,
            MAX_EXPANDED_CELLS,
            true
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach,
        Set<VoxelCell> excludedStances,
        boolean allowFrontier
    ) {
        return plan(
            perception,
            start,
            candidateLogs,
            interactionReach,
            excludedStances,
            MAX_EXPANDED_CELLS,
            allowFrontier
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach,
        int maxExpandedCells
    ) {
        return plan(
            perception,
            start,
            candidateLogs,
            interactionReach,
            Set.of(),
            maxExpandedCells,
            true
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach,
        int maxExpandedCells,
        boolean allowFrontier
    ) {
        return plan(
            perception,
            start,
            candidateLogs,
            interactionReach,
            Set.of(),
            maxExpandedCells,
            allowFrontier
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach,
        Set<VoxelCell> excludedStances,
        int maxExpandedCells
    ) {
        return plan(
            perception,
            start,
            candidateLogs,
            interactionReach,
            excludedStances,
            maxExpandedCells,
            true
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        Collection<BlockPos> candidateLogs,
        double interactionReach,
        Set<VoxelCell> excludedStances,
        int maxExpandedCells,
        boolean allowFrontier
    ) {
        List<BlockPos> targets = canonicalTargets(candidateLogs);
        if (targets.isEmpty()) {
            return failure("no_candidate_logs", 0, 0);
        }
        if (perception == null || start == null || !safeCell(perception, start)) {
            return failure("start_unstandable", 0, targets.size());
        }
        if (!Double.isFinite(interactionReach) || interactionReach <= 0.0D) {
            return failure("no_reachable_break_stance", 0, targets.size());
        }

        int budget = Math.max(1, Math.min(MAX_EXPANDED_CELLS, maxExpandedCells));
        Set<VoxelCell> excluded = excludedStances == null ? Set.of() : Set.copyOf(excludedStances);
        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingInt(Node::cost)
                .thenComparingDouble(Node::nearestTargetDistance)
                .thenComparingInt(node -> node.cell().y())
                .thenComparingInt(node -> node.cell().z())
                .thenComparingInt(node -> node.cell().x())
        );
        Map<VoxelCell, VoxelCell> cameFrom = new HashMap<>();
        Map<VoxelCell, Integer> bestCost = new HashMap<>();
        Set<VoxelCell> closed = new HashSet<>();
        List<Candidate> reachable = new ArrayList<>();
        FrontierCandidate bestFrontier = null;
        boolean routeCellLimitReached = false;

        bestCost.put(start, 0);
        open.add(new Node(start, 0, nearestTargetDistance(start, targets)));

        while (!open.isEmpty() && closed.size() < budget) {
            Node node = open.poll();
            VoxelCell cell = node.cell();
            if (node.cost() != bestCost.getOrDefault(cell, Integer.MAX_VALUE) || !closed.add(cell)) {
                continue;
            }

            var eye = GatherTreeBreakStancePlanner.eyePosition(cell);
            for (BlockPos target : targets) {
                if (allowFrontier
                    && node.cost() > 0
                    && !GatherTreeBreakStancePlanner.isTargetCell(cell, target)) {
                    double startDistance = horizontalTargetDistance(start, target);
                    double remainingDistance = horizontalTargetDistance(cell, target);
                    if (startDistance - remainingDistance >= MIN_FRONTIER_HORIZONTAL_PROGRESS) {
                        FrontierCandidate frontier = new FrontierCandidate(
                            target,
                            cell,
                            node.cost() + 1,
                            startDistance,
                            remainingDistance,
                            Math.abs(cell.y() - start.y())
                        );
                        if (bestFrontier == null
                            || FRONTIER_ORDER.compare(frontier, bestFrontier) < 0) {
                            bestFrontier = frontier;
                        }
                    }
                }
                if (excluded.contains(cell)
                    || GatherTreeBreakStancePlanner.isTargetCell(cell, target)
                    || !BlockBreakController.withinReach(eye, target, interactionReach)
                    || !GatherTreeBreakStancePlanner.clearLineOfSight(perception, eye, target)) {
                    continue;
                }
                List<VoxelCell> route = reconstruct(cameFrom, start, cell);
                reachable.add(new Candidate(
                    target,
                    cell,
                    route,
                    GatherTreeBreakStancePlanner.reachDistance(eye, target),
                    Math.abs(cell.y() - start.y())
                ));
            }

            for (VoxelCell delta : CARDINALS) {
                VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(perception, cell, delta);
                VoxelCell next = move.destination();
                if (next == null
                    || closed.contains(next)
                    || !safeCell(perception, next)
                    || !clearTraversalBodyColumn(perception, cell, next)) {
                    continue;
                }
                int nextCost = node.cost() + move.cost();
                if (nextCost + 1 > MAX_ROUTE_CELLS) {
                    routeCellLimitReached = true;
                    continue;
                }
                if (nextCost >= bestCost.getOrDefault(next, Integer.MAX_VALUE)) {
                    continue;
                }
                bestCost.put(next, nextCost);
                cameFrom.put(next, cell);
                open.add(new Node(next, nextCost, nearestTargetDistance(next, targets)));
            }
        }

        if (reachable.isEmpty()) {
            if (!open.isEmpty() && closed.size() >= budget) {
                return failure("expanded_budget", closed.size(), targets.size());
            }
            if (routeCellLimitReached && allowFrontier && bestFrontier != null) {
                List<VoxelCell> route = reconstruct(cameFrom, start, bestFrontier.frontier());
                if (route.size() >= 2 && route.size() <= MAX_ROUTE_CELLS) {
                    return new Result(
                        null,
                        new FrontierPlan(
                            bestFrontier.target(),
                            start,
                            bestFrontier.frontier(),
                            route,
                            "reachable_seed_frontier_3d",
                            closed.size(),
                            bestFrontier.startDistance(),
                            bestFrontier.remainingDistance(),
                            bestFrontier.frontier().y() - start.y()
                        ),
                        "",
                        closed.size(),
                        targets.size()
                    );
                }
            }
            return failure(
                routeCellLimitReached ? "route_cell_limit" : "no_reachable_break_stance",
                closed.size(),
                targets.size()
            );
        }

        Candidate chosen = reachable.stream().min(
            Comparator.comparingInt((Candidate candidate) -> candidate.target().getY())
                .thenComparingInt(candidate -> candidate.route().size())
                .thenComparingDouble(Candidate::reachDistance)
                .thenComparingInt(Candidate::verticalDisplacement)
                .thenComparingInt(candidate -> candidate.target().getX())
                .thenComparingInt(candidate -> candidate.target().getZ())
                .thenComparingInt(candidate -> candidate.stance().y())
                .thenComparingInt(candidate -> candidate.stance().z())
                .thenComparingInt(candidate -> candidate.stance().x())
        ).orElseThrow();
        return new Result(
            new Plan(
                chosen.target(),
                chosen.stance(),
                chosen.route(),
                "reachable_seed_3d",
                closed.size(),
                chosen.reachDistance(),
                chosen.stance().y() - start.y()
            ),
            null,
            "",
            closed.size(),
            targets.size()
        );
    }

    private static List<BlockPos> canonicalTargets(Collection<BlockPos> candidateLogs) {
        if (candidateLogs == null || candidateLogs.isEmpty()) {
            return List.of();
        }
        return candidateLogs.stream()
            .filter(java.util.Objects::nonNull)
            .map(BlockPos::toImmutable)
            .distinct()
            .sorted(
                Comparator.comparingInt(BlockPos::getY)
                    .thenComparingInt(BlockPos::getX)
                    .thenComparingInt(BlockPos::getZ)
            )
            .toList();
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

    private static boolean clearTraversalBodyColumn(
        GatherWoodLocalEgressPerception perception,
        VoxelCell from,
        VoxelCell destination
    ) {
        if (destination.y() >= from.y()) {
            return true;
        }
        for (int y = destination.y(); y <= from.y() + 1; y++) {
            if (!perception.inBounds(destination.x(), y, destination.z())
                || perception.isSolid(destination.x(), y, destination.z())
                || perception.isHazard(destination.x(), y, destination.z())
                || perception.isWater(destination.x(), y, destination.z())
                || perception.isLava(destination.x(), y, destination.z())) {
                return false;
            }
        }
        return true;
    }

    private static boolean queryable(GatherWoodLocalEgressPerception perception, VoxelCell cell) {
        return perception.inBounds(cell.x(), cell.y() - 1, cell.z())
            && perception.inBounds(cell.x(), cell.y(), cell.z())
            && perception.inBounds(cell.x(), cell.y() + 1, cell.z());
    }

    private static double nearestTargetDistance(VoxelCell cell, List<BlockPos> targets) {
        var eye = GatherTreeBreakStancePlanner.eyePosition(cell);
        return targets.stream()
            .mapToDouble(target -> eye.distanceTo(Vec3d.ofCenter(target)))
            .min()
            .orElse(Double.POSITIVE_INFINITY);
    }

    private static double horizontalTargetDistance(VoxelCell cell, BlockPos target) {
        return Math.hypot(cell.x() - target.getX(), cell.z() - target.getZ());
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

    private static Result failure(String reason, int expandedCells, int candidateCount) {
        return new Result(null, null, reason, expandedCells, candidateCount);
    }

    record Plan(
        BlockPos target,
        VoxelCell stance,
        List<VoxelCell> route,
        String reason,
        int expandedCells,
        double reachDistance,
        int verticalDelta
    ) {
        Plan {
            target = target == null ? null : target.toImmutable();
            route = route == null ? List.of() : List.copyOf(route);
            reason = reason == null ? "" : reason;
        }
    }

    record FrontierPlan(
        BlockPos target,
        VoxelCell origin,
        VoxelCell frontier,
        List<VoxelCell> route,
        String reason,
        int expandedCells,
        double startDistance,
        double remainingDistance,
        int verticalDelta
    ) {
        FrontierPlan {
            target = target == null ? null : target.toImmutable();
            route = route == null ? List.of() : List.copyOf(route);
            reason = reason == null ? "" : reason;
        }

        double netProgress() {
            return startDistance - remainingDistance;
        }
    }

    record Result(
        Plan plan,
        FrontierPlan frontierPlan,
        String failureReason,
        int expandedCells,
        int candidateCount
    ) {
        Result(Plan plan, String failureReason, int expandedCells, int candidateCount) {
            this(plan, null, failureReason, expandedCells, candidateCount);
        }

        Result {
            failureReason = failureReason == null ? "" : failureReason;
            if (plan != null && !plan.route().isEmpty()) {
                frontierPlan = null;
                failureReason = "";
            } else if (frontierPlan != null && !frontierPlan.route().isEmpty()) {
                failureReason = "";
            }
        }

        boolean found() {
            return plan != null && !plan.route().isEmpty();
        }

        boolean frontierFound() {
            return frontierPlan != null && !frontierPlan.route().isEmpty();
        }
    }

    private record Node(VoxelCell cell, int cost, double nearestTargetDistance) {
    }

    private record Candidate(
        BlockPos target,
        VoxelCell stance,
        List<VoxelCell> route,
        double reachDistance,
        int verticalDisplacement
    ) {
    }

    private static final Comparator<FrontierCandidate> FRONTIER_ORDER =
        Comparator.comparingInt((FrontierCandidate candidate) -> candidate.target().getY())
            .thenComparingDouble(FrontierCandidate::remainingDistance)
            .thenComparingInt(FrontierCandidate::routeLength)
            .thenComparingInt(FrontierCandidate::verticalDisplacement)
            .thenComparingInt(candidate -> candidate.target().getX())
            .thenComparingInt(candidate -> candidate.target().getZ())
            .thenComparingInt(candidate -> candidate.frontier().y())
            .thenComparingInt(candidate -> candidate.frontier().z())
            .thenComparingInt(candidate -> candidate.frontier().x());

    private record FrontierCandidate(
        BlockPos target,
        VoxelCell frontier,
        int routeLength,
        double startDistance,
        double remainingDistance,
        int verticalDisplacement
    ) {
    }
}
