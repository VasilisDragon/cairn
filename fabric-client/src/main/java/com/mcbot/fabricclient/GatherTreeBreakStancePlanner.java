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
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

final class GatherTreeBreakStancePlanner {
    static final int MAX_EXPANDED_CELLS = 2_048;
    private static final double EYE_HEIGHT = 1.62D;
    private static final VoxelCell[] NEIGHBORS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    private GatherTreeBreakStancePlanner() {
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        BlockPos target,
        double interactionReach,
        Set<VoxelCell> excludedStances
    ) {
        return plan(perception, start, target, interactionReach, excludedStances, MAX_EXPANDED_CELLS);
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        BlockPos target,
        double interactionReach,
        Set<VoxelCell> excludedStances,
        int maxExpandedCells
    ) {
        if (perception == null || start == null || target == null
            || !Double.isFinite(interactionReach) || interactionReach <= 0.0D) {
            return new Result(null, "invalid_request", 0);
        }
        if (!perception.isStandable(start.x(), start.y(), start.z())) {
            return new Result(null, "start_unstandable", 0);
        }

        Set<VoxelCell> excluded = excludedStances == null ? Set.of() : Set.copyOf(excludedStances);
        int budget = Math.max(1, Math.min(MAX_EXPANDED_CELLS, maxExpandedCells));
        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingDouble((Node node) -> centerDistance(node.cell(), target))
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
            if (!excluded.contains(cell)
                && !isTargetCell(cell, target)
                && BlockBreakController.withinReach(eyePosition(cell), target, interactionReach)
                && clearLineOfSight(perception, eyePosition(cell), target)) {
                List<VoxelCell> route = reconstruct(cameFrom, start, cell);
                candidates.add(new Candidate(
                    cell,
                    route,
                    reachDistance(eyePosition(cell), target),
                    Math.abs(cell.y() - start.y())
                ));
            }
            for (VoxelCell delta : NEIGHBORS) {
                VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(perception, cell, delta);
                VoxelCell next = move.destination();
                if (next == null || closed.contains(next)) {
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
            return new Result(null, open.isEmpty() ? "no_reachable_break_stance" : "expanded_budget", closed.size());
        }
        Candidate chosen = candidates.stream().min(
            Comparator.comparingDouble(Candidate::reachDistance)
                .thenComparingInt(candidate -> candidate.route().size())
                .thenComparingInt(Candidate::verticalDisplacement)
                .thenComparingInt(candidate -> candidate.cell().y())
                .thenComparingInt(candidate -> candidate.cell().z())
                .thenComparingInt(candidate -> candidate.cell().x())
        ).orElseThrow();
        return new Result(
            new Plan(
                chosen.cell(),
                chosen.route(),
                "reachable_break_stance",
                closed.size(),
                chosen.reachDistance(),
                chosen.cell().y() - start.y()
            ),
            "",
            closed.size()
        );
    }

    private static Vec3d eyePosition(VoxelCell cell) {
        return new Vec3d(cell.x() + 0.5D, cell.y() + EYE_HEIGHT, cell.z() + 0.5D);
    }

    private static double centerDistance(VoxelCell cell, BlockPos target) {
        return eyePosition(cell).distanceTo(Vec3d.ofCenter(target));
    }

    private static double reachDistance(Vec3d eye, BlockPos target) {
        double dx = Math.max(Math.max(target.getX() - eye.x, 0.0D), eye.x - (target.getX() + 1.0D));
        double dy = Math.max(Math.max(target.getY() - eye.y, 0.0D), eye.y - (target.getY() + 1.0D));
        double dz = Math.max(Math.max(target.getZ() - eye.z, 0.0D), eye.z - (target.getZ() + 1.0D));
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static boolean isTargetCell(VoxelCell cell, BlockPos target) {
        return cell.x() == target.getX() && cell.y() == target.getY() && cell.z() == target.getZ();
    }

    private static boolean clearLineOfSight(VoxelPerception perception, Vec3d eye, BlockPos target) {
        Vec3d targetCenter = Vec3d.ofCenter(target);
        double distance = eye.distanceTo(targetCenter);
        int steps = Math.max(1, (int) Math.ceil(distance * 10.0D));
        for (int step = 1; step < steps; step++) {
            double t = step / (double) steps;
            int x = (int) Math.floor(eye.x + (targetCenter.x - eye.x) * t);
            int y = (int) Math.floor(eye.y + (targetCenter.y - eye.y) * t);
            int z = (int) Math.floor(eye.z + (targetCenter.z - eye.z) * t);
            if (x == target.getX() && y == target.getY() && z == target.getZ()) {
                continue;
            }
            if (!perception.inBounds(x, y, z) || perception.isSolid(x, y, z)) {
                return false;
            }
        }
        return true;
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

    record Plan(
        VoxelCell stance,
        List<VoxelCell> route,
        String reason,
        int expandedCells,
        double reachDistance,
        int verticalDelta
    ) {
    }

    record Result(Plan plan, String failureReason, int expandedCells) {
        boolean found() {
            return plan != null && !plan.route().isEmpty();
        }
    }

    private record Node(VoxelCell cell, int cost) {
    }

    private record Candidate(
        VoxelCell cell,
        List<VoxelCell> route,
        double reachDistance,
        int verticalDisplacement
    ) {
    }
}
