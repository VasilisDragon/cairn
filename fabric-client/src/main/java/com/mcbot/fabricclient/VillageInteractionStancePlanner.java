package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/** Pure, bounded routing to a safe village travel or block-interaction stance. */
final class VillageInteractionStancePlanner {
    static final int MAX_ROUTE_CELLS = 32;
    static final int MAX_EXPANDED_CELLS = 512;
    static final int MAX_AGGREGATE_TARGETS = 64;
    static final double INTERACTION_REACH = 4.5D;

    private static final List<VoxelCell> CARDINAL = List.of(
        new VoxelCell(0, 0, -1),
        new VoxelCell(1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(-1, 0, 0)
    );
    private static final Comparator<OpenNode> OPEN_ORDER = Comparator
        .comparingInt(OpenNode::score)
        .thenComparingInt(OpenNode::verticalTransitions)
        .thenComparingInt(OpenNode::heuristic)
        .thenComparingInt(OpenNode::edges)
        .thenComparingInt(node -> node.cell().y())
        .thenComparingInt(node -> node.cell().z())
        .thenComparingInt(node -> node.cell().x());

    enum Mode {
        EXACT_TRAVEL,
        INTERACT_BLOCK,
        HARVEST_BLOCK
    }

    record Plan(
        VoxelCell stance,
        List<VoxelCell> route,
        int expandedCells,
        boolean targetReached,
        String reason
    ) {
        Plan {
            route = route == null ? List.of() : List.copyOf(route);
            reason = reason == null ? "" : reason;
        }

        boolean accepted() {
            return stance != null && !route.isEmpty() && reason.isBlank();
        }

        boolean frontier() {
            return accepted() && !targetReached;
        }
    }

    record TargetPlan(VoxelCell target, Plan plan) {
        TargetPlan {
            plan = plan == null
                ? new Plan(null, List.of(), 0, false, "invalid_request") : plan;
        }

        boolean accepted() {
            return target != null && plan.accepted();
        }
    }

    private VillageInteractionStancePlanner() {
    }

    static Plan plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        VoxelCell target,
        Mode mode
    ) {
        if (perception == null || start == null || target == null || mode == null) {
            return new Plan(null, List.of(), 0, false, "invalid_request");
        }
        if (!safeStance(perception, start)) {
            return new Plan(null, List.of(), 0, false, "start_blocked");
        }

        PriorityQueue<OpenNode> open = new PriorityQueue<>(OPEN_ORDER);
        Map<VoxelCell, VoxelCell> parent = new HashMap<>();
        Map<VoxelCell, Integer> bestEdges = new HashMap<>();
        Map<VoxelCell, Integer> bestVerticalTransitions = new HashMap<>();
        List<Candidate> candidates = new ArrayList<>();
        boolean routeCellLimit = false;
        List<Candidate> frontiers = new ArrayList<>();
        open.add(new OpenNode(start, 0, heuristic(start, target, mode), 0));
        bestEdges.put(start, 0);
        bestVerticalTransitions.put(start, 0);
        int expanded = 0;
        int bestGoalEdges = Integer.MAX_VALUE;
        int bestFrontierScore = Integer.MAX_VALUE;
        int bestFrontierHeuristic = Integer.MAX_VALUE;

        while (!open.isEmpty() && expanded < MAX_EXPANDED_CELLS) {
            OpenNode node = open.remove();
            if (node.edges() != bestEdges.getOrDefault(node.cell(), Integer.MAX_VALUE)
                || node.verticalTransitions()
                    != bestVerticalTransitions.getOrDefault(
                        node.cell(), Integer.MAX_VALUE)) {
                continue;
            }
            if (node.score() > bestGoalEdges
                || (bestGoalEdges == Integer.MAX_VALUE
                    && !frontiers.isEmpty()
                    && (node.score() > bestFrontierScore
                        || (node.score() == bestFrontierScore
                            && node.heuristic() > bestFrontierHeuristic)))) {
                break;
            }
            VoxelCell cell = node.cell();
            expanded += 1;
            int routeCells = node.edges() + 1;
            if (isGoal(perception, cell, target, mode)) {
                candidates.add(new Candidate(cell, reconstruct(parent, start, cell)));
                bestGoalEdges = Math.min(bestGoalEdges, node.edges());
                continue;
            }
            if (routeCells >= MAX_ROUTE_CELLS) {
                routeCellLimit = true;
                if (mode == Mode.EXACT_TRAVEL
                    && horizontalDistance(cell, target) + 2.0D
                        <= horizontalDistance(start, target)) {
                    frontiers.add(new Candidate(cell, reconstruct(parent, start, cell)));
                    bestFrontierScore = Math.min(bestFrontierScore, node.score());
                    bestFrontierHeuristic = Math.min(
                        bestFrontierHeuristic, node.heuristic());
                }
                continue;
            }
            for (VoxelCell delta : CARDINAL) {
                VoxelAStar.Move forward = VoxelAStar.resolveTraversalMove(perception, cell, delta);
                VoxelCell next = forward.destination();
                if (next == null || !safeStance(perception, next)) {
                    continue;
                }
                VoxelCell reverseDelta = new VoxelCell(
                    cell.x() - next.x(), 0, cell.z() - next.z());
                VoxelAStar.Move reverse = VoxelAStar.resolveTraversalMove(perception, next, reverseDelta);
                if (!cell.equals(reverse.destination())) {
                    continue;
                }
                int nextEdges = node.edges() + 1;
                int nextVerticalTransitions = node.verticalTransitions()
                    + (cell.y() == next.y() ? 0 : 1);
                int knownEdges = bestEdges.getOrDefault(next, Integer.MAX_VALUE);
                int knownVerticalTransitions = bestVerticalTransitions.getOrDefault(
                    next, Integer.MAX_VALUE);
                if (nextEdges > knownEdges
                    || (nextEdges == knownEdges
                        && nextVerticalTransitions >= knownVerticalTransitions)) {
                    continue;
                }
                parent.put(next, cell);
                bestEdges.put(next, nextEdges);
                bestVerticalTransitions.put(next, nextVerticalTransitions);
                open.add(new OpenNode(
                    next,
                    nextEdges,
                    heuristic(next, target, mode),
                    nextVerticalTransitions));
            }
        }

        if (!candidates.isEmpty()) {
            candidates.sort(Comparator
                .comparingInt((Candidate candidate) -> candidate.route().size())
                .thenComparingInt(candidate -> verticalTransitions(candidate.route()))
                .thenComparingDouble(candidate -> interactionDistanceSquared(candidate.stance(), target))
                .thenComparingInt(candidate -> Math.abs(candidate.stance().y() - start.y()))
                .thenComparingInt(candidate -> candidate.stance().y())
                .thenComparingInt(candidate -> candidate.stance().z())
                .thenComparingInt(candidate -> candidate.stance().x()));
            Candidate selected = candidates.getFirst();
            return new Plan(selected.stance(), selected.route(), expanded, true, "");
        }
        if (mode == Mode.EXACT_TRAVEL && routeCellLimit && !frontiers.isEmpty()) {
            frontiers.sort(Comparator
                // Keep selection identical to the bounded A* frontier order used above.  The
                // search may stop once every remaining node has a worse score/heuristic pair;
                // ranking the retained candidates by Euclidean distance instead could prefer a
                // node the termination rule was never required to visit.
                .comparingInt((Candidate candidate) -> frontierScore(candidate, target))
                .thenComparingInt(candidate ->
                    heuristic(candidate.stance(), target, Mode.EXACT_TRAVEL))
                .thenComparingInt(candidate -> candidate.route().size())
                .thenComparingInt(candidate -> verticalTransitions(candidate.route()))
                .thenComparingInt(candidate -> Math.abs(candidate.stance().y() - start.y()))
                .thenComparingInt(candidate -> candidate.stance().y())
                .thenComparingInt(candidate -> candidate.stance().z())
                .thenComparingInt(candidate -> candidate.stance().x()));
            Candidate selected = frontiers.getFirst();
            return new Plan(selected.stance(), selected.route(), expanded, false, "");
        }
        if (expanded >= MAX_EXPANDED_CELLS && !open.isEmpty()) {
            return new Plan(null, List.of(), expanded, false, "expanded_budget");
        }
        return new Plan(
            null,
            List.of(),
            expanded,
            false,
            routeCellLimit ? "route_cell_limit" : "no_safe_stance"
        );
    }

    /** One shared bounded traversal for a deterministic set of harvest targets. */
    static TargetPlan planAnyHarvest(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        List<VoxelCell> rawTargets
    ) {
        if (perception == null || start == null || rawTargets == null || rawTargets.isEmpty()) {
            return new TargetPlan(null,
                new Plan(null, List.of(), 0, false, "no_targets"));
        }
        if (!safeStance(perception, start)) {
            return new TargetPlan(null,
                new Plan(null, List.of(), 0, false, "start_blocked"));
        }
        List<VoxelCell> targets = rawTargets.stream()
            .filter(java.util.Objects::nonNull)
            .distinct()
            .sorted(Comparator.comparingInt(VoxelCell::y)
                .thenComparingInt(VoxelCell::z)
                .thenComparingInt(VoxelCell::x))
            .limit(MAX_AGGREGATE_TARGETS)
            .toList();
        if (targets.isEmpty()) {
            return new TargetPlan(null,
                new Plan(null, List.of(), 0, false, "no_targets"));
        }

        PriorityQueue<OpenNode> open = new PriorityQueue<>(OPEN_ORDER);
        Map<VoxelCell, VoxelCell> parent = new HashMap<>();
        Map<VoxelCell, Integer> bestEdges = new HashMap<>();
        Map<VoxelCell, Integer> bestVerticalTransitions = new HashMap<>();
        List<AggregateCandidate> matches = new ArrayList<>();
        open.add(new OpenNode(start, 0, aggregateHeuristic(start, targets), 0));
        bestEdges.put(start, 0);
        bestVerticalTransitions.put(start, 0);
        int expanded = 0;
        boolean routeCellLimit = false;
        int bestGoalEdges = Integer.MAX_VALUE;
        while (!open.isEmpty() && expanded < MAX_EXPANDED_CELLS) {
            OpenNode node = open.remove();
            if (node.edges() != bestEdges.getOrDefault(node.cell(), Integer.MAX_VALUE)
                || node.verticalTransitions()
                    != bestVerticalTransitions.getOrDefault(
                        node.cell(), Integer.MAX_VALUE)) {
                continue;
            }
            if (node.score() > bestGoalEdges) {
                break;
            }
            VoxelCell cell = node.cell();
            expanded += 1;
            int routeCells = node.edges() + 1;
            boolean matched = false;
            for (VoxelCell target : targets) {
                if (isGoal(perception, cell, target, Mode.HARVEST_BLOCK)) {
                    matches.add(new AggregateCandidate(
                        target, cell, reconstruct(parent, start, cell)));
                    bestGoalEdges = Math.min(bestGoalEdges, node.edges());
                    matched = true;
                }
            }
            if (matched) {
                continue;
            }
            if (routeCells >= MAX_ROUTE_CELLS) {
                routeCellLimit = true;
                continue;
            }
            for (VoxelCell delta : CARDINAL) {
                VoxelAStar.Move forward = VoxelAStar.resolveTraversalMove(perception, cell, delta);
                VoxelCell next = forward.destination();
                if (next == null || !safeStance(perception, next)) {
                    continue;
                }
                VoxelCell reverseDelta = new VoxelCell(
                    cell.x() - next.x(), 0, cell.z() - next.z());
                VoxelAStar.Move reverse = VoxelAStar.resolveTraversalMove(
                    perception, next, reverseDelta);
                if (!cell.equals(reverse.destination())) {
                    continue;
                }
                int nextEdges = node.edges() + 1;
                int nextVerticalTransitions = node.verticalTransitions()
                    + (cell.y() == next.y() ? 0 : 1);
                int knownEdges = bestEdges.getOrDefault(next, Integer.MAX_VALUE);
                int knownVerticalTransitions = bestVerticalTransitions.getOrDefault(
                    next, Integer.MAX_VALUE);
                if (nextEdges > knownEdges
                    || (nextEdges == knownEdges
                        && nextVerticalTransitions >= knownVerticalTransitions)) {
                    continue;
                }
                parent.put(next, cell);
                bestEdges.put(next, nextEdges);
                bestVerticalTransitions.put(next, nextVerticalTransitions);
                open.add(new OpenNode(
                    next,
                    nextEdges,
                    aggregateHeuristic(next, targets),
                    nextVerticalTransitions));
            }
        }
        if (matches.isEmpty()) {
            String reason = expanded >= MAX_EXPANDED_CELLS && !open.isEmpty()
                ? "expanded_budget" : routeCellLimit ? "route_cell_limit" : "no_safe_stance";
            return new TargetPlan(null,
                new Plan(null, List.of(), expanded, false, reason));
        }
        matches.sort(Comparator
            .comparingInt((AggregateCandidate candidate) -> candidate.route().size())
            .thenComparingInt(candidate -> verticalTransitions(candidate.route()))
            .thenComparingInt(candidate -> candidate.target().y())
            .thenComparingInt(candidate -> candidate.target().z())
            .thenComparingInt(candidate -> candidate.target().x())
            .thenComparingInt(candidate -> candidate.stance().y())
            .thenComparingInt(candidate -> candidate.stance().z())
            .thenComparingInt(candidate -> candidate.stance().x()));
        AggregateCandidate selected = matches.getFirst();
        return new TargetPlan(selected.target(), new Plan(
            selected.stance(), selected.route(), expanded, true, ""));
    }

    static boolean safeStance(GatherWoodLocalEgressPerception perception, VoxelCell cell) {
        if (perception == null || cell == null
            || !perception.isStandable(cell.x(), cell.y(), cell.z())
            || !perception.isFullHeightSupport(cell.x(), cell.y() - 1, cell.z())) {
            return false;
        }
        for (int dy = -1; dy <= 1; dy++) {
            if (perception.isWater(cell.x(), cell.y() + dy, cell.z())
                || perception.isLava(cell.x(), cell.y() + dy, cell.z())
                || perception.isHazard(cell.x(), cell.y() + dy, cell.z())) {
                return false;
            }
        }
        for (VoxelCell delta : CARDINAL) {
            if (perception.isLava(cell.x() + delta.x(), cell.y(), cell.z() + delta.z())
                || perception.isLava(cell.x() + delta.x(), cell.y() - 1, cell.z() + delta.z())) {
                return false;
            }
        }
        return true;
    }

    private static boolean isGoal(
        GatherWoodLocalEgressPerception perception,
        VoxelCell cell,
        VoxelCell target,
        Mode mode
    ) {
        if (mode == Mode.EXACT_TRAVEL) {
            return cell.equals(target);
        }
        if (cell.x() == target.x() && cell.y() == target.y() && cell.z() == target.z()) {
            return false;
        }
        double reach = mode == Mode.HARVEST_BLOCK ? 1.75D : INTERACTION_REACH;
        return interactionDistanceSquared(cell, target) <= reach * reach
            && hasClearInteractionRay(perception, cell, target);
    }

    /**
     * Conservative voxel ray from the player's eye to the target center. The target itself is the
     * permitted terminal collision; every earlier solid cell makes the stance unusable. This keeps
     * route admission aligned with the executor's later raycast without importing client/world
     * state into the pure planner.
     */
    static boolean hasClearInteractionRay(
        GatherWoodLocalEgressPerception perception,
        VoxelCell stance,
        VoxelCell target
    ) {
        if (perception == null || stance == null || target == null
            || !perception.inBounds(target.x(), target.y(), target.z())) {
            return false;
        }
        double startX = stance.x() + 0.5D;
        double startY = stance.y() + 1.62D;
        double startZ = stance.z() + 0.5D;
        double endX = target.x() + 0.5D;
        double endY = target.y() + 0.5D;
        double endZ = target.z() + 0.5D;
        double dx = endX - startX;
        double dy = endY - startY;
        double dz = endZ - startZ;

        int x = floor(startX);
        int y = floor(startY);
        int z = floor(startZ);
        int targetX = target.x();
        int targetY = target.y();
        int targetZ = target.z();
        int stepX = Integer.compare(targetX, x);
        int stepY = Integer.compare(targetY, y);
        int stepZ = Integer.compare(targetZ, z);
        double tDeltaX = stepX == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0D / dx);
        double tDeltaY = stepY == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0D / dy);
        double tDeltaZ = stepZ == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0D / dz);
        double tMaxX = initialBoundaryTime(startX, dx, stepX);
        double tMaxY = initialBoundaryTime(startY, dy, stepY);
        double tMaxZ = initialBoundaryTime(startZ, dz, stepZ);

        // Interaction reach bounds this to only a handful of cells; 64 is a defensive hard cap.
        for (int visited = 0; visited < 64; visited++) {
            if (x == targetX && y == targetY && z == targetZ) {
                return true;
            }
            if (!perception.inBounds(x, y, z) || perception.isSolid(x, y, z)) {
                return false;
            }
            double next = Math.min(tMaxX, Math.min(tMaxY, tMaxZ));
            if (!Double.isFinite(next) || next > 1.0D) {
                return false;
            }
            double epsilon = 1.0e-10D;
            if (tMaxX <= next + epsilon) {
                x += stepX;
                tMaxX += tDeltaX;
            }
            if (tMaxY <= next + epsilon) {
                y += stepY;
                tMaxY += tDeltaY;
            }
            if (tMaxZ <= next + epsilon) {
                z += stepZ;
                tMaxZ += tDeltaZ;
            }
        }
        return false;
    }

    private static double initialBoundaryTime(double start, double delta, int step) {
        if (step == 0) {
            return Double.POSITIVE_INFINITY;
        }
        double boundary = step > 0 ? Math.floor(start) + 1.0D : Math.floor(start);
        return (boundary - start) / delta;
    }

    private static int floor(double value) {
        return (int) Math.floor(value);
    }

    private static double interactionDistanceSquared(VoxelCell stance, VoxelCell target) {
        double dx = (stance.x() + 0.5D) - (target.x() + 0.5D);
        double dy = (stance.y() + 1.62D) - (target.y() + 0.5D);
        double dz = (stance.z() + 0.5D) - (target.z() + 0.5D);
        return dx * dx + dy * dy + dz * dz;
    }

    private static double horizontalDistance(VoxelCell left, VoxelCell right) {
        return Math.hypot(left.x() - right.x(), left.z() - right.z());
    }

    private static int frontierScore(Candidate candidate, VoxelCell target) {
        return Math.max(0, candidate.route().size() - 1)
            + heuristic(candidate.stance(), target, Mode.EXACT_TRAVEL);
    }

    private static int verticalTransitions(List<VoxelCell> route) {
        if (route == null || route.size() < 2) {
            return 0;
        }
        int transitions = 0;
        for (int index = 1; index < route.size(); index++) {
            if (route.get(index - 1).y() != route.get(index).y()) {
                transitions += 1;
            }
        }
        return transitions;
    }

    /**
     * An admissible lower bound used only to order already-safe traversal cells.
     * It never creates, skips, or relaxes a traversal edge.
     */
    private static int heuristic(VoxelCell cell, VoxelCell target, Mode mode) {
        int horizontalManhattan = Math.abs(cell.x() - target.x())
            + Math.abs(cell.z() - target.z());
        if (mode == Mode.EXACT_TRAVEL) {
            return Math.max(horizontalManhattan, Math.abs(cell.y() - target.y()));
        }
        double reach = mode == Mode.HARVEST_BLOCK ? 1.75D : INTERACTION_REACH;
        double horizontal = horizontalDistance(cell, target);
        return (int) Math.ceil(Math.max(0.0D, horizontal - reach));
    }

    private static int aggregateHeuristic(VoxelCell cell, List<VoxelCell> targets) {
        int best = Integer.MAX_VALUE;
        for (VoxelCell target : targets) {
            best = Math.min(best, heuristic(cell, target, Mode.HARVEST_BLOCK));
        }
        return best == Integer.MAX_VALUE ? 0 : best;
    }

    private static List<VoxelCell> reconstruct(
        Map<VoxelCell, VoxelCell> parent,
        VoxelCell start,
        VoxelCell goal
    ) {
        ArrayDeque<VoxelCell> reversed = new ArrayDeque<>();
        VoxelCell cursor = goal;
        reversed.addFirst(cursor);
        while (!cursor.equals(start)) {
            cursor = parent.get(cursor);
            if (cursor == null) {
                return List.of();
            }
            reversed.addFirst(cursor);
        }
        return List.copyOf(reversed);
    }

    private record Candidate(VoxelCell stance, List<VoxelCell> route) {
    }

    private record AggregateCandidate(
        VoxelCell target,
        VoxelCell stance,
        List<VoxelCell> route
    ) {
    }

    private record OpenNode(
        VoxelCell cell,
        int edges,
        int heuristic,
        int verticalTransitions
    ) {
        int score() {
            return edges + heuristic;
        }
    }
}
