package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;

/**
 * Deterministic synthetic hardening runner for offline 3-D traversal navigation.
 *
 * <p>Ground truth is an INDEPENDENT exhaustive BFS over the same traversal move-set, not A*'s own
 * answer. A scenario is "solvable" iff BFS reaches the goal; A* is then required to (1) route every
 * BFS-solvable scenario and (2) return a path whose every hop is a legal, standable traversal move
 * (re-derived from {@link VoxelAStar#resolveTraversalMove}). This makes the success metric falsifiable:
 * a search bug that drops a reachable goal, or emits an illegal route, is counted as a failure -- where
 * the previous self-referential metric (solvable := A*'s own routeFound) could never fail. BFS shortest
 * distance also yields an optimality gap, surfacing non-optimal A* routes as a metric (not a failure).
 */
public final class Nav3DHardeningBatch {
    private static final VoxelCell[] DIRECTIONS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    private Nav3DHardeningBatch() {
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
        VoxelCell goal
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
        int routeMoves,
        int optimalMoves,
        int expandedNodes,
        String failure
    ) {
        boolean solvedCorrectly() {
            return solvable && routed && routeValid;
        }

        /** A* claims a path that the exhaustive oracle proved impossible -> the route is illegal. */
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

        /** Fraction of BFS-reachable scenarios A* actually solved with a legal route. Now able to be < 1. */
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
        long gapTotal = 0;
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
                int gap = Math.max(0, result.routeMoves() - result.optimalMoves());
                gapTotal += gap;
                maxGap = Math.max(maxGap, gap);
            } else {
                if (result.routed() && !result.routeValid()) {
                    invalid++;
                }
                failures.add(result);
            }
        }
        double averageOptimalGap = solved == 0 ? 0.0D : (double) gapTotal / (double) solved;
        return new RoundResult(seed, scenarioCount, solvable, solved, invalid, spurious, averageOptimalGap, maxGap, failures);
    }

    public static ScenarioResult runScenario(Scenario scenario) {
        StaticVoxelPerception perception = new StaticVoxelPerception(scenario);
        Reachability oracle = bfsReachability(perception, scenario.start(), scenario.goal());
        Nav3DRouteDiagnostic diagnostic = VoxelAStar.diagnose(perception, scenario.start(), scenario.goal());
        boolean routed = diagnostic.routeFound();
        boolean routeValid = routed && isLegalRoute(perception, scenario.start(), scenario.goal(), diagnostic.route());
        int routeMoves = routed ? Math.max(0, diagnostic.route().size() - 1) : -1;
        return new ScenarioResult(
            scenario,
            oracle.reached(),
            routed,
            routeValid,
            routeMoves,
            oracle.distance(),
            diagnostic.expandedNodes(),
            diagnostic.failureReason()
        );
    }

    /** Exhaustive BFS over the SAME traversal move-set A* uses -> independent shortest-move ground truth. */
    static Reachability bfsReachability(VoxelPerception perception, VoxelCell start, VoxelCell goal) {
        if (perception == null || start == null || goal == null
            || !perception.isStandable(start.x(), start.y(), start.z())
            || !perception.isStandable(goal.x(), goal.y(), goal.z())) {
            return new Reachability(false, -1);
        }
        if (start.equals(goal)) {
            return new Reachability(true, 0);
        }
        Deque<VoxelCell> queue = new ArrayDeque<>();
        Map<VoxelCell, Integer> distance = new HashMap<>();
        distance.put(start, 0);
        queue.add(start);
        while (!queue.isEmpty()) {
            VoxelCell cell = queue.poll();
            int d = distance.get(cell);
            for (VoxelCell delta : DIRECTIONS) {
                VoxelCell next = VoxelAStar.resolveTraversalMove(perception, cell, delta).destination();
                if (next == null || distance.containsKey(next)) {
                    continue;
                }
                if (next.equals(goal)) {
                    return new Reachability(true, d + 1);
                }
                distance.put(next, d + 1);
                queue.add(next);
            }
        }
        return new Reachability(false, -1);
    }

    /** Independently confirm A*'s route runs start..goal with every hop a legal, standable traversal move. */
    static boolean isLegalRoute(VoxelPerception perception, VoxelCell start, VoxelCell goal, List<VoxelCell> route) {
        if (route == null || route.isEmpty()) {
            return false;
        }
        if (!route.get(0).equals(start) || !route.get(route.size() - 1).equals(goal)) {
            return false;
        }
        for (VoxelCell cell : route) {
            if (!perception.isStandable(cell.x(), cell.y(), cell.z())) {
                return false;
            }
        }
        for (int i = 0; i + 1 < route.size(); i++) {
            VoxelCell a = route.get(i);
            VoxelCell b = route.get(i + 1);
            int dx = b.x() - a.x();
            int dz = b.z() - a.z();
            if (Math.abs(dx) + Math.abs(dz) != 1) {
                return false; // every traversal hop advances exactly one horizontal step
            }
            VoxelCell destination =
                VoxelAStar.resolveTraversalMove(perception, a, new VoxelCell(dx, 0, dz)).destination();
            if (!b.equals(destination)) {
                return false;
            }
        }
        return true;
    }

    static Scenario generateScenario(Random random, int index) {
        int kindIndex = index % 4;
        int width = 8 + random.nextInt(6);
        int depth = 8 + random.nextInt(6);
        int baseY = 64;
        int minY = 56;
        int maxY = 74;
        // Distinct terrain per kind so the batch actually exercises every move type, not just gentle steps.
        int amplitude = switch (kindIndex) {
            case 0 -> 2;   // rolling_steps: gentle 0..1 steps
            case 1 -> 2;   // hazard_scatter: gentle terrain, hazards dominate
            case 2 -> 4;   // safe_drop_mix: terraces with up-to-3-block drops/rises
            default -> 3;  // multi_level: 0..2 steps
        };
        double pillarRate = kindIndex == 3 ? 0.12D : 0.08D;
        double hazardRate = kindIndex == 1 ? 0.16D : 0.05D;
        Set<VoxelCell> solid = new HashSet<>();
        Set<VoxelCell> hazards = new HashSet<>();
        for (int x = 0; x < width; x++) {
            for (int z = 0; z < depth; z++) {
                int feetY = heightFor(baseY, x, z, index, amplitude);
                solid.add(new VoxelCell(x, feetY - 1, z));
                boolean interior = x > 0 && z > 0 && x < width - 1 && z < depth - 1;
                if (!interior) {
                    continue;
                }
                double roll = random.nextDouble();
                if (roll < pillarRate) {
                    // obstacle pillar: fill feet+head so the column is non-standable -> A* must route around it
                    solid.add(new VoxelCell(x, feetY, z));
                    solid.add(new VoxelCell(x, feetY + 1, z));
                } else if (roll < pillarRate + hazardRate) {
                    hazards.add(new VoxelCell(x, feetY - 1, z));
                }
            }
        }
        VoxelCell start = randomStandable(random, width, depth, baseY, index, amplitude, solid, hazards, null);
        VoxelCell goal = randomStandable(random, width, depth, baseY, index, amplitude, solid, hazards, start);
        return new Scenario(kind(kindIndex), width, depth, minY, maxY, solid, hazards, start, goal);
    }

    private static String kind(int kindIndex) {
        return switch (kindIndex) {
            case 0 -> "rolling_steps";
            case 1 -> "hazard_scatter";
            case 2 -> "safe_drop_mix";
            default -> "multi_level";
        };
    }

    private static VoxelCell randomStandable(
        Random random,
        int width,
        int depth,
        int baseY,
        int index,
        int amplitude,
        Set<VoxelCell> solid,
        Set<VoxelCell> hazards,
        VoxelCell notEqual
    ) {
        for (int attempt = 0; attempt < 20_000; attempt++) {
            int x = random.nextInt(width);
            int z = random.nextInt(depth);
            int feetY = heightFor(baseY, x, z, index, amplitude);
            VoxelCell cell = new VoxelCell(x, feetY, z);
            boolean floorSolid = solid.contains(new VoxelCell(x, feetY - 1, z));
            boolean feetClear = !solid.contains(cell);
            boolean headClear = !solid.contains(new VoxelCell(x, feetY + 1, z));
            boolean hazard = hazards.contains(new VoxelCell(x, feetY - 1, z))
                || hazards.contains(cell)
                || hazards.contains(new VoxelCell(x, feetY + 1, z));
            if (!cell.equals(notEqual) && floorSolid && feetClear && headClear && !hazard) {
                return cell;
            }
        }
        throw new IllegalStateException("could not find standable 3-D cell");
    }

    private static int heightFor(int baseY, int x, int z, int index, int amplitude) {
        return baseY + Math.floorMod(x + z + index, amplitude);
    }

    record Reachability(boolean reached, int distance) {
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
