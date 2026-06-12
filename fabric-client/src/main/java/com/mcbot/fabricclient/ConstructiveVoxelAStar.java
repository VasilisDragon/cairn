package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

/** Pure bounded 3-D A* over traversal plus place-only bridge/pillar moves. No digging. */
final class ConstructiveVoxelAStar {
    static final int TRAVERSAL_COST = 1;
    static final int BRIDGE_COST = 2;
    static final int PILLAR_COST = 2;

    private static final VoxelCell[] HORIZONTAL_NEIGHBORS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };
    private static final VoxelCell[] ADJACENT_BLOCKS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 1, 0),
        new VoxelCell(0, -1, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    private ConstructiveVoxelAStar() {
    }

    enum StepKind {
        WALK,
        STEP,
        DROP,
        PILLAR,
        BRIDGE
    }

    record PlanStep(StepKind kind, VoxelCell from, VoxelCell to, VoxelCell placement, int cost) {
        PlanStep {
            if (kind == null) {
                throw new IllegalArgumentException("kind is required");
            }
            if (from == null || to == null) {
                throw new IllegalArgumentException("from/to are required");
            }
            if ((kind == StepKind.PILLAR || kind == StepKind.BRIDGE) && placement == null) {
                throw new IllegalArgumentException("constructive step requires placement");
            }
            if (cost <= 0) {
                throw new IllegalArgumentException("cost must be positive");
            }
        }

        boolean placesBlock() {
            return placement != null;
        }
    }

    record BuildPlan(List<VoxelCell> route, List<PlanStep> steps, List<VoxelCell> placements, int totalCost) {
        BuildPlan {
            route = List.copyOf(route == null ? List.of() : route);
            steps = List.copyOf(steps == null ? List.of() : steps);
            placements = List.copyOf(placements == null ? List.of() : placements);
        }

        static BuildPlan empty() {
            return new BuildPlan(List.of(), List.of(), List.of(), 0);
        }

        int blocksUsed() {
            return placements.size();
        }
    }

    static BuildPlan route(VoxelPerception perception, VoxelCell start, VoxelCell goal, AgentBuildCapability capability) {
        return diagnose(perception, start, goal, capability).plan();
    }

    static Nav3DBuildDiagnostic diagnose(
        VoxelPerception perception,
        VoxelCell start,
        VoxelCell goal,
        AgentBuildCapability capability
    ) {
        if (perception == null || start == null || goal == null || capability == null) {
            return new Nav3DBuildDiagnostic(BuildPlan.empty(), "invalid_request", 0, Map.of());
        }
        if (!perception.isStandable(start.x(), start.y(), start.z())) {
            return new Nav3DBuildDiagnostic(BuildPlan.empty(), "start_blocked", 0, Map.of());
        }
        if (!perception.inBounds(goal.x(), goal.y(), goal.z())
            || !perception.inBounds(goal.x(), goal.y() + 1, goal.z())) {
            return new Nav3DBuildDiagnostic(BuildPlan.empty(), "goal_out_of_bounds", 0, Map.of());
        }
        if (isHazardBody(perception, goal.x(), goal.y(), goal.z())) {
            return new Nav3DBuildDiagnostic(BuildPlan.empty(), "goal_hazard", 0, Map.of());
        }
        if (isBodySolid(perception, goal.x(), goal.y(), goal.z())) {
            return new Nav3DBuildDiagnostic(BuildPlan.empty(), "goal_blocked", 0, Map.of());
        }
        if (start.equals(goal)) {
            return new Nav3DBuildDiagnostic(new BuildPlan(List.of(start), List.of(), List.of(), 0), "", 1, Map.of());
        }

        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingInt(Node::estimatedTotalCost)
                .thenComparingInt(Node::costFromStart)
                .thenComparingInt((node) -> -node.blocksRemaining())
                .thenComparingInt((node) -> node.cell().y())
                .thenComparingInt((node) -> node.cell().z())
                .thenComparingInt((node) -> node.cell().x())
        );
        Map<StateKey, Integer> bestCost = new HashMap<>();
        Set<StateKey> closed = new HashSet<>();
        Map<String, Integer> rejectionCounts = new LinkedHashMap<>();

        StateKey startKey = new StateKey(start, capability.blockBudget());
        bestCost.put(startKey, 0);
        open.add(new Node(start, capability.blockBudget(), Set.of(), List.of(), 0, heuristic(start, goal)));

        while (!open.isEmpty()) {
            Node node = open.poll();
            StateKey key = new StateKey(node.cell(), node.blocksRemaining());
            if (!closed.add(key)) {
                continue;
            }
            if (node.cell().equals(goal)) {
                return new Nav3DBuildDiagnostic(planFrom(start, node), "", closed.size(), rejectionCounts);
            }

            VoxelPerception overlay = new PlacementOverlayPerception(perception, node.placements());
            for (PlanStep step : neighbors(overlay, node, rejectionCounts)) {
                VoxelCell next = step.to();
                int nextBlocksRemaining = node.blocksRemaining() - (step.placesBlock() ? 1 : 0);
                if (nextBlocksRemaining < 0) {
                    rejectionCounts.merge("budget_exhausted", 1, Integer::sum);
                    continue;
                }
                StateKey nextKey = new StateKey(next, nextBlocksRemaining);
                if (closed.contains(nextKey)) {
                    continue;
                }
                int nextCost = node.costFromStart() + step.cost();
                int knownCost = bestCost.getOrDefault(nextKey, Integer.MAX_VALUE);
                if (nextCost >= knownCost) {
                    continue;
                }
                Set<VoxelCell> nextPlacements = node.placements();
                if (step.placesBlock()) {
                    nextPlacements = new LinkedHashSet<>(node.placements());
                    nextPlacements.add(step.placement());
                    nextPlacements = Set.copyOf(nextPlacements);
                }
                List<PlanStep> nextSteps = new ArrayList<>(node.steps());
                nextSteps.add(step);
                bestCost.put(nextKey, nextCost);
                open.add(new Node(
                    next,
                    nextBlocksRemaining,
                    nextPlacements,
                    List.copyOf(nextSteps),
                    nextCost,
                    nextCost + heuristic(next, goal)
                ));
            }
        }

        return new Nav3DBuildDiagnostic(BuildPlan.empty(), "open_exhausted", closed.size(), rejectionCounts);
    }

    static boolean isLegalPlan(VoxelPerception base, VoxelCell start, VoxelCell goal, BuildPlan plan, int blockBudget) {
        if (base == null || start == null || goal == null || plan == null || plan.route().isEmpty()) {
            return false;
        }
        if (!plan.route().getFirst().equals(start) || !plan.route().getLast().equals(goal)) {
            return false;
        }
        if (plan.blocksUsed() > blockBudget || plan.blocksUsed() != plan.placements().size()) {
            return false;
        }
        if (plan.route().size() != plan.steps().size() + 1) {
            return false;
        }
        Set<VoxelCell> placements = new LinkedHashSet<>();
        VoxelCell current = start;
        if (!base.isStandable(current.x(), current.y(), current.z())) {
            return false;
        }
        for (ConstructiveVoxelAStar.PlanStep step : plan.steps()) {
            if (!step.from().equals(current)) {
                return false;
            }
            VoxelPerception overlay = new PlacementOverlayPerception(base, placements);
            PlanStep resolved = resolveExpectedStep(overlay, step);
            if (resolved == null || !sameMove(resolved, step)) {
                return false;
            }
            if (step.placesBlock()) {
                if (!isLegalPlacementTarget(overlay, step.placement()) || placements.contains(step.placement())) {
                    return false;
                }
                placements.add(step.placement());
            }
            VoxelPerception after = new PlacementOverlayPerception(base, placements);
            if (!after.isStandable(step.to().x(), step.to().y(), step.to().z())) {
                return false;
            }
            current = step.to();
        }
        return current.equals(goal) && placements.equals(new LinkedHashSet<>(plan.placements()));
    }

    private static List<PlanStep> neighbors(VoxelPerception overlay, Node node, Map<String, Integer> rejectionCounts) {
        List<PlanStep> steps = new ArrayList<>();
        for (VoxelCell delta : HORIZONTAL_NEIGHBORS) {
            VoxelAStar.Move traversal = VoxelAStar.resolveTraversalMove(overlay, node.cell(), delta);
            if (traversal.destination() == null) {
                rejectionCounts.merge("traversal_" + traversal.reason(), 1, Integer::sum);
            } else {
                steps.add(new PlanStep(
                    traversalKind(node.cell(), traversal.destination()),
                    node.cell(),
                    traversal.destination(),
                    null,
                    TRAVERSAL_COST
                ));
            }
            PlanStep bridge = resolveBridgeMove(overlay, node.cell(), delta, node.blocksRemaining());
            if (bridge == null) {
                rejectionCounts.merge("bridge_rejected", 1, Integer::sum);
            } else {
                steps.add(bridge);
            }
        }
        PlanStep pillar = resolvePillarMove(overlay, node.cell(), node.blocksRemaining());
        if (pillar == null) {
            rejectionCounts.merge("pillar_rejected", 1, Integer::sum);
        } else {
            steps.add(pillar);
        }
        return steps;
    }

    static PlanStep resolvePillarMove(VoxelPerception perception, VoxelCell from, int blocksRemaining) {
        if (perception == null || from == null || blocksRemaining <= 0) {
            return null;
        }
        if (!perception.isStandable(from.x(), from.y(), from.z())) {
            return null;
        }
        VoxelCell placement = from;
        VoxelCell to = new VoxelCell(from.x(), from.y() + 1, from.z());
        if (!isLegalPlacementTarget(perception, placement)
            || !bodyClearAndSafe(perception, to.x(), to.y(), to.z())) {
            return null;
        }
        VoxelPerception after = new PlacementOverlayPerception(perception, Set.of(placement));
        if (!after.isStandable(to.x(), to.y(), to.z())) {
            return null;
        }
        return new PlanStep(StepKind.PILLAR, from, to, placement, PILLAR_COST);
    }

    static PlanStep resolveBridgeMove(VoxelPerception perception, VoxelCell from, VoxelCell delta, int blocksRemaining) {
        if (perception == null || from == null || delta == null || blocksRemaining <= 0) {
            return null;
        }
        if (Math.abs(delta.x()) + Math.abs(delta.z()) != 1 || delta.y() != 0) {
            return null;
        }
        if (!perception.isStandable(from.x(), from.y(), from.z())) {
            return null;
        }
        VoxelCell to = new VoxelCell(from.x() + delta.x(), from.y(), from.z() + delta.z());
        VoxelCell placement = new VoxelCell(to.x(), to.y() - 1, to.z());
        if (!perception.inBounds(placement.x(), placement.y(), placement.z())
            || !bodyClearAndSafe(perception, to.x(), to.y(), to.z())
            || !isLegalPlacementTarget(perception, placement)
            || !hasAdjacentSolidSupport(perception, placement)) {
            return null;
        }
        VoxelPerception after = new PlacementOverlayPerception(perception, Set.of(placement));
        if (!after.isStandable(to.x(), to.y(), to.z())) {
            return null;
        }
        return new PlanStep(StepKind.BRIDGE, from, to, placement, BRIDGE_COST);
    }

    static boolean isLegalPlacementTarget(VoxelPerception perception, VoxelCell placement) {
        return perception != null
            && placement != null
            && perception.inBounds(placement.x(), placement.y(), placement.z())
            && !perception.isSolid(placement.x(), placement.y(), placement.z())
            && !perception.isHazard(placement.x(), placement.y(), placement.z());
    }

    static boolean hasAdjacentSolidSupport(VoxelPerception perception, VoxelCell placement) {
        if (perception == null || placement == null) {
            return false;
        }
        for (VoxelCell delta : ADJACENT_BLOCKS) {
            int x = placement.x() + delta.x();
            int y = placement.y() + delta.y();
            int z = placement.z() + delta.z();
            if (perception.inBounds(x, y, z) && perception.isSolid(x, y, z) && !perception.isHazard(x, y, z)) {
                return true;
            }
        }
        return false;
    }

    private static PlanStep resolveExpectedStep(VoxelPerception overlay, PlanStep step) {
        if (step.kind() == StepKind.PILLAR) {
            return resolvePillarMove(overlay, step.from(), 1);
        }
        if (step.kind() == StepKind.BRIDGE) {
            return resolveBridgeMove(
                overlay,
                step.from(),
                new VoxelCell(step.to().x() - step.from().x(), 0, step.to().z() - step.from().z()),
                1
            );
        }
        int dx = step.to().x() - step.from().x();
        int dz = step.to().z() - step.from().z();
        if (Math.abs(dx) + Math.abs(dz) != 1) {
            return null;
        }
        VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(overlay, step.from(), new VoxelCell(dx, 0, dz));
        if (move.destination() == null) {
            return null;
        }
        return new PlanStep(traversalKind(step.from(), move.destination()), step.from(), move.destination(), null, TRAVERSAL_COST);
    }

    private static boolean sameMove(PlanStep a, PlanStep b) {
        return a.kind() == b.kind()
            && a.from().equals(b.from())
            && a.to().equals(b.to())
            && ((a.placement() == null && b.placement() == null)
                || (a.placement() != null && a.placement().equals(b.placement())))
            && a.cost() == b.cost();
    }

    private static BuildPlan planFrom(VoxelCell start, Node node) {
        List<VoxelCell> route = new ArrayList<>();
        route.add(start);
        List<VoxelCell> placements = new ArrayList<>();
        for (PlanStep step : node.steps()) {
            route.add(step.to());
            if (step.placesBlock()) {
                placements.add(step.placement());
            }
        }
        return new BuildPlan(route, node.steps(), placements, node.costFromStart());
    }

    private static StepKind traversalKind(VoxelCell from, VoxelCell to) {
        if (to.y() > from.y()) {
            return StepKind.STEP;
        }
        if (to.y() < from.y()) {
            return StepKind.DROP;
        }
        return StepKind.WALK;
    }

    private static boolean bodyClearAndSafe(VoxelPerception perception, int x, int y, int z) {
        return perception.inBounds(x, y, z)
            && perception.inBounds(x, y + 1, z)
            && !isBodySolid(perception, x, y, z)
            && !isHazardBody(perception, x, y, z);
    }

    private static boolean isBodySolid(VoxelPerception perception, int x, int y, int z) {
        return perception.isSolid(x, y, z) || perception.isSolid(x, y + 1, z);
    }

    private static boolean isHazardBody(VoxelPerception perception, int x, int y, int z) {
        return perception.isHazard(x, y - 1, z) || perception.isHazard(x, y, z) || perception.isHazard(x, y + 1, z);
    }

    private static int heuristic(VoxelCell from, VoxelCell to) {
        return Math.abs(to.x() - from.x()) + Math.abs(to.y() - from.y()) + Math.abs(to.z() - from.z());
    }

    private record StateKey(VoxelCell cell, int blocksRemaining) {
    }

    private record Node(
        VoxelCell cell,
        int blocksRemaining,
        Set<VoxelCell> placements,
        List<PlanStep> steps,
        int costFromStart,
        int estimatedTotalCost
    ) {
        Node {
            placements = Set.copyOf(placements == null ? Set.of() : placements);
            steps = List.copyOf(steps == null ? List.of() : steps);
        }
    }
}
