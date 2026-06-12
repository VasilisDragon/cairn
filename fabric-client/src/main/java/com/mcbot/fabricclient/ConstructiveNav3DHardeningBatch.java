package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Random;
import java.util.Set;

/**
 * Deterministic synthetic hardening runner for constructive 3-D navigation.
 *
 * <p>Ground truth is an independent exhaustive weighted BFS/Dijkstra over the same extended move-set:
 * traversal, bridge, and pillar with a block budget. It does not call {@link ConstructiveVoxelAStar}'s
 * move resolvers, and route legality is re-derived hop-by-hop with placement and budget accounting.
 */
public final class ConstructiveNav3DHardeningBatch {
    private static final VoxelCell[] DIRECTIONS = {
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

    private ConstructiveNav3DHardeningBatch() {
    }

    public record Scenario(
        String kind,
        int width,
        int depth,
        int minY,
        int maxY,
        Set<VoxelCell> solid,
        Set<VoxelCell> hazards,
        VoxelCell start,
        VoxelCell goal,
        int blockBudget
    ) {
        public Scenario {
            solid = Set.copyOf(solid == null ? Set.of() : solid);
            hazards = Set.copyOf(hazards == null ? Set.of() : hazards);
        }
    }

    public record ScenarioResult(
        Scenario scenario,
        boolean solvable,
        boolean routed,
        boolean routeValid,
        int routeCost,
        int optimalCost,
        int expandedNodes,
        String failure
    ) {
        boolean solvedCorrectly() {
            return solvable && routed && routeValid;
        }

        boolean spurious() {
            return !solvable && routed && routeValid;
        }
    }

    public record RoundResult(
        long seed,
        int requested,
        int solvable,
        int solved,
        int invalid,
        int spurious,
        double averageOptimalGap,
        int maxOptimalGap,
        List<ScenarioResult> failures
    ) {
        public RoundResult {
            failures = List.copyOf(failures == null ? List.of() : failures);
        }

        public double successRate() {
            return solvable == 0 ? 1.0D : (double) solved / (double) solvable;
        }

        public String summary() {
            return "seed=" + seed
                + " requested=" + requested
                + " solvable=" + solvable
                + " solved=" + solved
                + " successRate=" + String.format(Locale.ROOT, "%.3f", successRate())
                + " invalidRoutes=" + invalid
                + " spuriousRoutes=" + spurious
                + " avgOptimalGap=" + String.format(Locale.ROOT, "%.2f", averageOptimalGap)
                + " maxOptimalGap=" + maxOptimalGap
                + " failures=" + failures.size();
        }
    }

    public static RoundResult runRound(long seed, int scenarioCount) {
        Random random = new Random(seed);
        int solvable = 0;
        int solved = 0;
        int invalid = 0;
        int spurious = 0;
        long gapTotal = 0L;
        int maxGap = 0;
        List<ScenarioResult> failures = new ArrayList<>();
        for (int i = 0; i < scenarioCount; i++) {
            ScenarioResult result = runScenario(generateScenario(random, i));
            if (result.spurious()) {
                spurious++;
                failures.add(result);
            }
            if (!result.solvable()) {
                continue;
            }
            solvable++;
            if (result.solvedCorrectly()) {
                solved++;
                int gap = Math.max(0, result.routeCost() - result.optimalCost());
                gapTotal += gap;
                maxGap = Math.max(maxGap, gap);
            } else {
                if (result.routed() && !result.routeValid()) {
                    invalid++;
                }
                failures.add(result);
            }
        }
        double averageGap = solved == 0 ? 0.0D : (double) gapTotal / (double) solved;
        return new RoundResult(seed, scenarioCount, solvable, solved, invalid, spurious, averageGap, maxGap, failures);
    }

    public static ScenarioResult runScenario(Scenario scenario) {
        StaticVoxelPerception perception = new StaticVoxelPerception(scenario);
        Reachability oracle = oracleReachability(perception, scenario.start(), scenario.goal(), scenario.blockBudget());
        Nav3DBuildDiagnostic diagnostic = ConstructiveVoxelAStar.diagnose(
            perception,
            scenario.start(),
            scenario.goal(),
            new AgentBuildCapability(scenario.blockBudget())
        );
        boolean routed = diagnostic.routeFound();
        boolean routeValid = routed && isLegalPlan(
            perception,
            scenario.start(),
            scenario.goal(),
            diagnostic.plan(),
            scenario.blockBudget()
        );
        return new ScenarioResult(
            scenario,
            oracle.reached(),
            routed,
            routeValid,
            routed ? diagnostic.plan().totalCost() : -1,
            oracle.cost(),
            diagnostic.expandedNodes(),
            diagnostic.failureReason()
        );
    }

    static Reachability oracleReachability(VoxelPerception perception, VoxelCell start, VoxelCell goal, int blockBudget) {
        if (perception == null || start == null || goal == null || blockBudget < 0
            || !perception.isStandable(start.x(), start.y(), start.z())
            || bodyBlockedOrHazard(perception, goal.x(), goal.y(), goal.z())) {
            return new Reachability(false, -1);
        }
        PriorityQueue<OracleNode> open = new PriorityQueue<>(
            Comparator.comparingInt(OracleNode::cost)
                .thenComparingInt((node) -> -node.blocksRemaining())
                .thenComparingInt((node) -> node.cell().y())
                .thenComparingInt((node) -> node.cell().z())
                .thenComparingInt((node) -> node.cell().x())
        );
        Map<StateKey, Integer> bestCost = new HashMap<>();
        StateKey startKey = new StateKey(start, blockBudget);
        bestCost.put(startKey, 0);
        open.add(new OracleNode(start, blockBudget, Set.of(), 0));
        while (!open.isEmpty()) {
            OracleNode node = open.poll();
            StateKey key = new StateKey(node.cell(), node.blocksRemaining());
            if (node.cost() != bestCost.getOrDefault(key, Integer.MAX_VALUE)) {
                continue;
            }
            if (node.cell().equals(goal)) {
                return new Reachability(true, node.cost());
            }
            VoxelPerception overlay = new PlacementOverlayPerception(perception, node.placements());
            for (OracleMove move : independentMoves(overlay, node.cell(), node.blocksRemaining())) {
                int nextBlocksRemaining = node.blocksRemaining() - (move.placement() == null ? 0 : 1);
                if (nextBlocksRemaining < 0) {
                    continue;
                }
                Set<VoxelCell> nextPlacements = node.placements();
                if (move.placement() != null) {
                    nextPlacements = new LinkedHashSet<>(node.placements());
                    nextPlacements.add(move.placement());
                    nextPlacements = Set.copyOf(nextPlacements);
                }
                int nextCost = node.cost() + move.cost();
                StateKey nextKey = new StateKey(move.to(), nextBlocksRemaining);
                if (nextCost >= bestCost.getOrDefault(nextKey, Integer.MAX_VALUE)) {
                    continue;
                }
                bestCost.put(nextKey, nextCost);
                open.add(new OracleNode(move.to(), nextBlocksRemaining, nextPlacements, nextCost));
            }
        }
        return new Reachability(false, -1);
    }

    static boolean isLegalPlan(
        VoxelPerception base,
        VoxelCell start,
        VoxelCell goal,
        ConstructiveVoxelAStar.BuildPlan plan,
        int blockBudget
    ) {
        if (base == null || start == null || goal == null || plan == null || plan.route().isEmpty()) {
            return false;
        }
        if (!plan.route().getFirst().equals(start) || !plan.route().getLast().equals(goal)) {
            return false;
        }
        if (plan.route().size() != plan.steps().size() + 1 || plan.blocksUsed() > blockBudget) {
            return false;
        }
        VoxelCell current = start;
        Set<VoxelCell> placements = new LinkedHashSet<>();
        int cost = 0;
        for (ConstructiveVoxelAStar.PlanStep step : plan.steps()) {
            if (!step.from().equals(current)) {
                return false;
            }
            VoxelPerception overlay = new PlacementOverlayPerception(base, placements);
            OracleMove expected = expectedMove(overlay, step);
            if (expected == null
                || expected.kind() != step.kind()
                || !expected.to().equals(step.to())
                || !samePlacement(expected.placement(), step.placement())
                || expected.cost() != step.cost()) {
                return false;
            }
            if (step.placement() != null) {
                if (!isLegalPlacementTarget(overlay, step.placement())) {
                    return false;
                }
                placements.add(step.placement());
            }
            VoxelPerception after = new PlacementOverlayPerception(base, placements);
            if (!after.isStandable(step.to().x(), step.to().y(), step.to().z())) {
                return false;
            }
            current = step.to();
            cost += step.cost();
        }
        return current.equals(goal)
            && placements.equals(new LinkedHashSet<>(plan.placements()))
            && cost == plan.totalCost();
    }

    static Scenario generateScenario(Random random, int index) {
        int kindIndex = index % 5;
        return switch (kindIndex) {
            case 0 -> bridgeGap(random, index);
            case 1 -> pillarLedge(random, index);
            case 2 -> bridgePillarCombo(random, index);
            case 3 -> hazardOverpass(random, index);
            default -> walkingBaseline(random, index);
        };
    }

    private static Scenario bridgeGap(Random random, int index) {
        int gapCount = 1 + random.nextInt(3);
        int width = gapCount + 2;
        int feetY = 64 + random.nextInt(2);
        Set<VoxelCell> solid = new HashSet<>();
        solid.add(new VoxelCell(0, feetY - 1, 0));
        solid.add(new VoxelCell(width - 1, feetY - 1, 0));
        int budget = index % 10 == 0 ? gapCount - 1 : gapCount;
        return scenario("bridge_gap", width, 1, feetY, solid, Set.of(), new VoxelCell(0, feetY, 0), new VoxelCell(width - 1, feetY, 0), budget);
    }

    private static Scenario pillarLedge(Random random, int index) {
        int feetY = 64 + random.nextInt(2);
        Set<VoxelCell> solid = new HashSet<>();
        solid.add(new VoxelCell(0, feetY - 1, 0));
        solid.add(new VoxelCell(1, feetY + 1, 0));
        int budget = index % 10 == 1 ? 0 : 1;
        return scenario("pillar_ledge", 2, 1, feetY, solid, Set.of(), new VoxelCell(0, feetY, 0), new VoxelCell(1, feetY + 2, 0), budget);
    }

    private static Scenario bridgePillarCombo(Random random, int index) {
        int feetY = 64 + random.nextInt(2);
        Set<VoxelCell> solid = new HashSet<>();
        solid.add(new VoxelCell(0, feetY - 1, 0));
        solid.add(new VoxelCell(2, feetY + 1, 0));
        int budget = index % 10 == 2 ? 1 : 2;
        return scenario("bridge_pillar_combo", 3, 1, feetY, solid, Set.of(), new VoxelCell(0, feetY, 0), new VoxelCell(2, feetY + 2, 0), budget);
    }

    private static Scenario hazardOverpass(Random random, int index) {
        int feetY = 64 + random.nextInt(2);
        Set<VoxelCell> solid = new HashSet<>();
        Set<VoxelCell> hazards = new HashSet<>();
        solid.add(new VoxelCell(0, feetY - 1, 0));
        solid.add(new VoxelCell(2, feetY - 1, 0));
        hazards.add(new VoxelCell(1, feetY - 1, 0));
        int budget = index % 10 == 3 ? 1 : 2;
        return scenario("hazard_overpass", 3, 1, feetY, solid, hazards, new VoxelCell(0, feetY, 0), new VoxelCell(2, feetY, 0), budget);
    }

    private static Scenario walkingBaseline(Random random, int index) {
        int width = 3 + random.nextInt(4);
        int feetY = 64 + random.nextInt(2);
        Set<VoxelCell> solid = new HashSet<>();
        for (int x = 0; x < width; x++) {
            solid.add(new VoxelCell(x, feetY - 1, 0));
        }
        return scenario("walking_baseline", width, 1, feetY, solid, Set.of(), new VoxelCell(0, feetY, 0), new VoxelCell(width - 1, feetY, 0), random.nextInt(3));
    }

    private static Scenario scenario(
        String kind,
        int width,
        int depth,
        int feetY,
        Set<VoxelCell> solid,
        Set<VoxelCell> hazards,
        VoxelCell start,
        VoxelCell goal,
        int budget
    ) {
        return new Scenario(kind, width, depth, feetY - 2, feetY + 5, solid, hazards, start, goal, budget);
    }

    private static List<OracleMove> independentMoves(VoxelPerception perception, VoxelCell from, int blocksRemaining) {
        List<OracleMove> moves = new ArrayList<>();
        for (VoxelCell delta : DIRECTIONS) {
            VoxelCell traversal = independentTraversalDestination(perception, from, delta);
            if (traversal != null) {
                moves.add(new OracleMove(
                    traversalKind(from, traversal),
                    traversal,
                    null,
                    ConstructiveVoxelAStar.TRAVERSAL_COST
                ));
            }
            OracleMove bridge = independentBridge(perception, from, delta, blocksRemaining);
            if (bridge != null) {
                moves.add(bridge);
            }
        }
        OracleMove pillar = independentPillar(perception, from, blocksRemaining);
        if (pillar != null) {
            moves.add(pillar);
        }
        return moves;
    }

    private static VoxelCell independentTraversalDestination(VoxelPerception perception, VoxelCell from, VoxelCell delta) {
        if (perception == null || from == null || delta == null || !perception.isStandable(from.x(), from.y(), from.z())) {
            return null;
        }
        int x = from.x() + delta.x();
        int y = from.y();
        int z = from.z() + delta.z();
        if (!perception.inBounds(x, y, z)) {
            return null;
        }
        if (perception.isStandable(x, y, z)) {
            return new VoxelCell(x, y, z);
        }
        if (perception.inBounds(x, y + 1, z) && perception.isStandable(x, y + 1, z)) {
            return new VoxelCell(x, y + 1, z);
        }
        for (int drop = 1; drop <= WalkabilityClassifier.MAX_SAFE_DROP; drop++) {
            if (perception.inBounds(x, y - drop, z) && perception.isStandable(x, y - drop, z)) {
                return new VoxelCell(x, y - drop, z);
            }
        }
        return null;
    }

    private static OracleMove independentPillar(VoxelPerception perception, VoxelCell from, int blocksRemaining) {
        if (blocksRemaining <= 0 || !perception.isStandable(from.x(), from.y(), from.z())) {
            return null;
        }
        VoxelCell placement = from;
        VoxelCell to = new VoxelCell(from.x(), from.y() + 1, from.z());
        if (!isLegalPlacementTarget(perception, placement) || !bodyClearAndSafe(perception, to.x(), to.y(), to.z())) {
            return null;
        }
        VoxelPerception after = new PlacementOverlayPerception(perception, Set.of(placement));
        if (!after.isStandable(to.x(), to.y(), to.z())) {
            return null;
        }
        return new OracleMove(ConstructiveVoxelAStar.StepKind.PILLAR, to, placement, ConstructiveVoxelAStar.PILLAR_COST);
    }

    private static OracleMove independentBridge(VoxelPerception perception, VoxelCell from, VoxelCell delta, int blocksRemaining) {
        if (blocksRemaining <= 0 || Math.abs(delta.x()) + Math.abs(delta.z()) != 1 || delta.y() != 0) {
            return null;
        }
        if (!perception.isStandable(from.x(), from.y(), from.z())) {
            return null;
        }
        VoxelCell to = new VoxelCell(from.x() + delta.x(), from.y(), from.z() + delta.z());
        VoxelCell placement = new VoxelCell(to.x(), to.y() - 1, to.z());
        if (!isLegalPlacementTarget(perception, placement)
            || !bodyClearAndSafe(perception, to.x(), to.y(), to.z())
            || !hasAdjacentSolidSupport(perception, placement)) {
            return null;
        }
        VoxelPerception after = new PlacementOverlayPerception(perception, Set.of(placement));
        if (!after.isStandable(to.x(), to.y(), to.z())) {
            return null;
        }
        return new OracleMove(ConstructiveVoxelAStar.StepKind.BRIDGE, to, placement, ConstructiveVoxelAStar.BRIDGE_COST);
    }

    private static OracleMove expectedMove(VoxelPerception overlay, ConstructiveVoxelAStar.PlanStep step) {
        if (step.kind() == ConstructiveVoxelAStar.StepKind.PILLAR) {
            return independentPillar(overlay, step.from(), 1);
        }
        if (step.kind() == ConstructiveVoxelAStar.StepKind.BRIDGE) {
            return independentBridge(
                overlay,
                step.from(),
                new VoxelCell(step.to().x() - step.from().x(), 0, step.to().z() - step.from().z()),
                1
            );
        }
        VoxelCell to = independentTraversalDestination(
            overlay,
            step.from(),
            new VoxelCell(step.to().x() - step.from().x(), 0, step.to().z() - step.from().z())
        );
        if (to == null) {
            return null;
        }
        return new OracleMove(traversalKind(step.from(), to), to, null, ConstructiveVoxelAStar.TRAVERSAL_COST);
    }

    private static boolean isLegalPlacementTarget(VoxelPerception perception, VoxelCell placement) {
        return perception != null
            && placement != null
            && perception.inBounds(placement.x(), placement.y(), placement.z())
            && !perception.isSolid(placement.x(), placement.y(), placement.z())
            && !perception.isHazard(placement.x(), placement.y(), placement.z());
    }

    private static boolean hasAdjacentSolidSupport(VoxelPerception perception, VoxelCell placement) {
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

    private static boolean bodyClearAndSafe(VoxelPerception perception, int x, int y, int z) {
        return perception.inBounds(x, y, z)
            && perception.inBounds(x, y + 1, z)
            && !perception.isSolid(x, y, z)
            && !perception.isSolid(x, y + 1, z)
            && !hazardBody(perception, x, y, z);
    }

    private static boolean bodyBlockedOrHazard(VoxelPerception perception, int x, int y, int z) {
        return !perception.inBounds(x, y, z)
            || !perception.inBounds(x, y + 1, z)
            || perception.isSolid(x, y, z)
            || perception.isSolid(x, y + 1, z)
            || hazardBody(perception, x, y, z);
    }

    private static boolean hazardBody(VoxelPerception perception, int x, int y, int z) {
        return perception.isHazard(x, y - 1, z) || perception.isHazard(x, y, z) || perception.isHazard(x, y + 1, z);
    }

    private static ConstructiveVoxelAStar.StepKind traversalKind(VoxelCell from, VoxelCell to) {
        if (to.y() > from.y()) {
            return ConstructiveVoxelAStar.StepKind.STEP;
        }
        if (to.y() < from.y()) {
            return ConstructiveVoxelAStar.StepKind.DROP;
        }
        return ConstructiveVoxelAStar.StepKind.WALK;
    }

    private static boolean samePlacement(VoxelCell a, VoxelCell b) {
        return (a == null && b == null) || (a != null && a.equals(b));
    }

    public record Reachability(boolean reached, int cost) {
    }

    private record StateKey(VoxelCell cell, int blocksRemaining) {
    }

    private record OracleNode(VoxelCell cell, int blocksRemaining, Set<VoxelCell> placements, int cost) {
        OracleNode {
            placements = Set.copyOf(placements == null ? Set.of() : placements);
        }
    }

    private record OracleMove(
        ConstructiveVoxelAStar.StepKind kind,
        VoxelCell to,
        VoxelCell placement,
        int cost
    ) {
    }

    record StaticVoxelPerception(Scenario scenario) implements VoxelPerception {
        @Override
        public int minX() {
            return 0;
        }

        @Override
        public int maxX() {
            return scenario.width() - 1;
        }

        @Override
        public int minY() {
            return scenario.minY();
        }

        @Override
        public int maxY() {
            return scenario.maxY();
        }

        @Override
        public int minZ() {
            return 0;
        }

        @Override
        public int maxZ() {
            return scenario.depth() - 1;
        }

        @Override
        public boolean isSolid(int x, int y, int z) {
            return scenario.solid().contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isHazard(int x, int y, int z) {
            return scenario.hazards().contains(new VoxelCell(x, y, z));
        }
    }
}
