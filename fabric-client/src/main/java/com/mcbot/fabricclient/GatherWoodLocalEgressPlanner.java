package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class GatherWoodLocalEgressPlanner {
    static final int MAX_EXAMINED_CELLS = 512;
    static final int DRY_HORIZONTAL_RADIUS = 3;
    static final int WATER_HORIZONTAL_RADIUS = 6;
    static final int WATER_VERTICAL_RADIUS = 2;

    enum Mode {
        NORMALIZED("normalized"),
        SETTLE("settle"),
        STEP("step"),
        SAFE_DROP("safe_drop"),
        SWIM("swim");

        private final String eventName;

        Mode(String eventName) {
            this.eventName = eventName;
        }

        String eventName() {
            return eventName;
        }
    }

    record Plan(
        VoxelCell canonicalStart,
        VoxelCell anchor,
        Mode mode,
        List<VoxelCell> path,
        double distance,
        int verticalDelta,
        int examinedCells,
        String reason
    ) {
        Plan {
            path = path == null ? List.of() : List.copyOf(path);
            reason = reason == null ? "" : reason;
        }
    }

    record Result(Plan plan, VoxelCell canonicalStart, int examinedCells, String failureReason) {
        boolean found() {
            return plan != null;
        }

        boolean recoveryRequired() {
            return plan != null;
        }
    }

    private record SearchNode(VoxelCell cell, List<VoxelCell> path) {
    }

    private record Candidate(VoxelCell anchor, List<VoxelCell> path, Mode mode) {
    }

    private static final VoxelCell[] CARDINALS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    private GatherWoodLocalEgressPlanner() {
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell rawStart,
        double precisePlayerY,
        boolean grounded,
        boolean touchingWater,
        VoxelCell downstreamTarget,
        Set<VoxelCell> excludedAnchors
    ) {
        return plan(
            perception,
            rawStart,
            precisePlayerY,
            grounded,
            touchingWater,
            downstreamTarget,
            excludedAnchors,
            MAX_EXAMINED_CELLS
        );
    }

    static Result plan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell rawStart,
        double precisePlayerY,
        boolean grounded,
        boolean touchingWater,
        VoxelCell downstreamTarget,
        Set<VoxelCell> excludedAnchors,
        int maxExaminedCells
    ) {
        if (perception == null || rawStart == null) {
            return new Result(null, rawStart, 0, "invalid_request");
        }
        int budget = Math.max(1, Math.min(MAX_EXAMINED_CELLS, maxExaminedCells));
        Set<VoxelCell> excluded = excludedAnchors == null ? Set.of() : excludedAnchors;
        if (perception.isStandable(rawStart.x(), rawStart.y(), rawStart.z())) {
            return new Result(null, rawStart, 1, "already_standable");
        }

        int examined = 1;
        List<Candidate> normalized = new ArrayList<>();
        for (int y = rawStart.y() + 1; y >= rawStart.y() - 3 && examined < budget; y--) {
            if (y == rawStart.y()) {
                continue;
            }
            examined++;
            VoxelCell candidate = new VoxelCell(rawStart.x(), y, rawStart.z());
            if (Math.abs(precisePlayerY - candidate.y()) <= 0.25D
                && safeDryAnchor(perception, candidate, excluded)) {
                normalized.add(new Candidate(candidate, List.of(candidate), Mode.NORMALIZED));
            }
        }
        Candidate bestNormalized = best(normalized, rawStart, downstreamTarget);
        if (bestNormalized != null) {
            return success(rawStart, bestNormalized, examined, "same_column_support");
        }

        if (!grounded && !touchingWater) {
            Plan settle = new Plan(
                rawStart,
                rawStart,
                Mode.SETTLE,
                List.of(),
                0.0D,
                0,
                examined,
                "airborne_wait"
            );
            return new Result(settle, rawStart, examined, "");
        }

        return touchingWater
            ? waterPlan(perception, rawStart, downstreamTarget, excluded, budget, examined)
            : dryPlan(perception, rawStart, downstreamTarget, excluded, budget, examined);
    }

    private static Result dryPlan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell rawStart,
        VoxelCell downstreamTarget,
        Set<VoxelCell> excluded,
        int budget,
        int examined
    ) {
        ArrayDeque<SearchNode> queue = new ArrayDeque<>();
        Set<VoxelCell> visited = new HashSet<>();
        List<Candidate> candidates = new ArrayList<>();
        for (VoxelCell delta : CARDINALS) {
            for (int y = rawStart.y() + 1; y >= rawStart.y() - 3; y--) {
                VoxelCell root = new VoxelCell(rawStart.x() + delta.x(), y, rawStart.z() + delta.z());
                if (!withinHorizontal(rawStart, root, DRY_HORIZONTAL_RADIUS) || !visited.add(root)) {
                    continue;
                }
                if (++examined > budget) {
                    return exhausted(rawStart, budget);
                }
                if (!safeDryAnchor(perception, root, excluded)) {
                    continue;
                }
                List<VoxelCell> path = List.of(root);
                queue.addLast(new SearchNode(root, path));
                candidates.add(new Candidate(
                    root,
                    path,
                    root.y() < rawStart.y() ? Mode.SAFE_DROP : Mode.STEP
                ));
            }
        }
        while (!queue.isEmpty() && examined < budget) {
            SearchNode node = queue.removeFirst();
            for (VoxelCell delta : CARDINALS) {
                VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(perception, node.cell(), delta);
                examined++;
                if (examined > budget) {
                    return exhausted(rawStart, budget);
                }
                VoxelCell next = move.destination();
                if (next == null || !withinHorizontal(rawStart, next, DRY_HORIZONTAL_RADIUS) || !visited.add(next)) {
                    continue;
                }
                List<VoxelCell> path = append(node.path(), next);
                queue.addLast(new SearchNode(next, path));
                if (safeDryAnchor(perception, next, excluded)) {
                    candidates.add(new Candidate(
                        next,
                        path,
                        next.y() < rawStart.y() ? Mode.SAFE_DROP : Mode.STEP
                    ));
                }
            }
        }
        if (!queue.isEmpty() && examined >= budget) {
            return exhausted(rawStart, budget);
        }
        Candidate selected = best(candidates, rawStart, downstreamTarget);
        return selected == null
            ? new Result(null, rawStart, examined, "no_safe_anchor")
            : success(rawStart, selected, examined, "dry_anchor");
    }

    private static Result waterPlan(
        GatherWoodLocalEgressPerception perception,
        VoxelCell rawStart,
        VoxelCell downstreamTarget,
        Set<VoxelCell> excluded,
        int budget,
        int examined
    ) {
        ArrayDeque<SearchNode> queue = new ArrayDeque<>();
        Set<VoxelCell> visited = new HashSet<>();
        List<Candidate> candidates = new ArrayList<>();
        queue.add(new SearchNode(rawStart, List.of(rawStart)));
        visited.add(rawStart);
        while (!queue.isEmpty() && examined < budget) {
            SearchNode node = queue.removeFirst();
            for (VoxelCell delta : CARDINALS) {
                for (int dy = -1; dy <= 1; dy++) {
                    VoxelCell next = new VoxelCell(
                        node.cell().x() + delta.x(),
                        node.cell().y() + dy,
                        node.cell().z() + delta.z()
                    );
                    if (!withinHorizontal(rawStart, next, WATER_HORIZONTAL_RADIUS)
                        || Math.abs(next.y() - rawStart.y()) > WATER_VERTICAL_RADIUS
                        || !visited.add(next)) {
                        continue;
                    }
                    examined++;
                    if (examined > budget) {
                        return exhausted(rawStart, budget);
                    }
                    if (safeDryAnchor(perception, next, excluded)) {
                        candidates.add(new Candidate(next, append(node.path(), next), Mode.SWIM));
                        continue;
                    }
                    if (!waterBodyCell(perception, next) || adjacentLava(perception, next)) {
                        continue;
                    }
                    queue.addLast(new SearchNode(next, append(node.path(), next)));
                }
            }
        }
        if (!queue.isEmpty() && examined >= budget) {
            return exhausted(rawStart, budget);
        }
        Candidate selected = best(candidates, rawStart, downstreamTarget);
        return selected == null
            ? new Result(null, rawStart, examined, "water_without_dry_exit")
            : success(rawStart, selected, examined, "connected_dry_shore");
    }

    private static boolean waterBodyCell(GatherWoodLocalEgressPerception perception, VoxelCell cell) {
        if (!perception.inBounds(cell.x(), cell.y(), cell.z())
            || !perception.inBounds(cell.x(), cell.y() + 1, cell.z())
            || perception.isSolid(cell.x(), cell.y(), cell.z())
            || perception.isSolid(cell.x(), cell.y() + 1, cell.z())
            || perception.isLava(cell.x(), cell.y(), cell.z())
            || perception.isLava(cell.x(), cell.y() + 1, cell.z())) {
            return false;
        }
        return perception.isWater(cell.x(), cell.y(), cell.z())
            || perception.isWater(cell.x(), cell.y() - 1, cell.z())
            || perception.isWater(cell.x(), cell.y() + 1, cell.z());
    }

    private static boolean safeDryAnchor(
        GatherWoodLocalEgressPerception perception,
        VoxelCell anchor,
        Set<VoxelCell> excluded
    ) {
        return anchor != null
            && !excluded.contains(anchor)
            && perception.isStandable(anchor.x(), anchor.y(), anchor.z())
            && !perception.isWater(anchor.x(), anchor.y(), anchor.z())
            && !perception.isWater(anchor.x(), anchor.y() + 1, anchor.z())
            && !perception.isLava(anchor.x(), anchor.y() - 1, anchor.z())
            && !perception.isLava(anchor.x(), anchor.y(), anchor.z())
            && !perception.isLava(anchor.x(), anchor.y() + 1, anchor.z())
            && !adjacentLava(perception, anchor)
            && hasSafeEgress(perception, anchor);
    }

    private static boolean hasSafeEgress(GatherWoodLocalEgressPerception perception, VoxelCell anchor) {
        for (VoxelCell delta : CARDINALS) {
            if (VoxelAStar.resolveTraversalMove(perception, anchor, delta).destination() != null) {
                return true;
            }
        }
        return false;
    }

    private static boolean adjacentLava(GatherWoodLocalEgressPerception perception, VoxelCell cell) {
        for (VoxelCell delta : CARDINALS) {
            int x = cell.x() + delta.x();
            int z = cell.z() + delta.z();
            for (int y = cell.y() - 1; y <= cell.y() + 1; y++) {
                if (perception.inBounds(x, y, z) && perception.isLava(x, y, z)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static Candidate best(List<Candidate> candidates, VoxelCell rawStart, VoxelCell downstreamTarget) {
        return candidates.stream().min(
            Comparator.comparingInt((Candidate candidate) -> candidate.mode() == Mode.NORMALIZED ? 0 : 1)
                .thenComparingInt(candidate -> candidate.path().size())
                .thenComparingDouble(candidate -> downstreamDistanceSquared(candidate.anchor(), downstreamTarget))
                .thenComparingInt(candidate -> Math.abs(candidate.anchor().y() - rawStart.y()))
                .thenComparingInt(candidate -> candidate.anchor().y())
                .thenComparingInt(candidate -> candidate.anchor().z())
                .thenComparingInt(candidate -> candidate.anchor().x())
        ).orElse(null);
    }

    private static Result success(VoxelCell rawStart, Candidate candidate, int examined, String reason) {
        VoxelCell anchor = candidate.anchor();
        double distance = Math.hypot(anchor.x() - rawStart.x(), anchor.z() - rawStart.z());
        Plan plan = new Plan(
            anchor,
            anchor,
            candidate.mode(),
            candidate.path(),
            distance,
            anchor.y() - rawStart.y(),
            examined,
            reason
        );
        return new Result(plan, anchor, examined, "");
    }

    private static Result exhausted(VoxelCell rawStart, int budget) {
        return new Result(null, rawStart, budget, "examined_budget");
    }

    private static boolean withinHorizontal(VoxelCell origin, VoxelCell cell, int radius) {
        return Math.abs(cell.x() - origin.x()) <= radius && Math.abs(cell.z() - origin.z()) <= radius;
    }

    private static double downstreamDistanceSquared(VoxelCell cell, VoxelCell downstreamTarget) {
        if (downstreamTarget == null) {
            return 0.0D;
        }
        double dx = cell.x() - downstreamTarget.x();
        double dz = cell.z() - downstreamTarget.z();
        return dx * dx + dz * dz;
    }

    private static List<VoxelCell> append(List<VoxelCell> path, VoxelCell next) {
        List<VoxelCell> copy = new ArrayList<>(path.size() + 1);
        copy.addAll(path);
        copy.add(next);
        return List.copyOf(copy);
    }
}
