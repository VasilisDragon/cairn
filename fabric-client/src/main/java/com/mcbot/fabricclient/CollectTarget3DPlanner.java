package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Chooses a reachable standable 3-D cell within pickup range of a dropped item. */
final class CollectTarget3DPlanner {
    static final double PICKUP_HORIZONTAL_RANGE = 1.5D;
    static final double PICKUP_VERTICAL_RANGE = 1.5D;

    private CollectTarget3DPlanner() {
    }

    record TargetPlan(VoxelCell cell, List<VoxelCell> route, String reason) {
        TargetPlan {
            route = route == null ? List.of() : List.copyOf(route);
            reason = reason == null ? "" : reason;
        }
    }

    static TargetPlan chooseTarget(
        VoxelPerception perception,
        VoxelCell start,
        double targetX,
        double targetY,
        double targetZ
    ) {
        if (perception == null || start == null || !Double.isFinite(targetX) || !Double.isFinite(targetY) || !Double.isFinite(targetZ)) {
            return new TargetPlan(null, List.of(), "invalid_request");
        }
        List<Candidate> candidates = new ArrayList<>();
        for (int x = perception.minX(); x <= perception.maxX(); x++) {
            for (int y = perception.minY(); y <= perception.maxY(); y++) {
                for (int z = perception.minZ(); z <= perception.maxZ(); z++) {
                    VoxelCell cell = new VoxelCell(x, y, z);
                    if (!withinPickupRange(cell, targetX, targetY, targetZ) || !perception.isStandable(x, y, z)) {
                        continue;
                    }
                    Nav3DRouteDiagnostic diagnostic = VoxelAStar.diagnose(perception, start, cell);
                    if (diagnostic.routeFound()) {
                        candidates.add(new Candidate(cell, diagnostic.route(), pickupDistanceSquared(cell, targetX, targetY, targetZ)));
                    }
                }
            }
        }
        if (candidates.isEmpty()) {
            return new TargetPlan(null, List.of(), "no_reachable_pickup_cell");
        }
        candidates.sort(Comparator
            .comparingDouble(Candidate::pickupDistanceSquared)
            .thenComparingInt((Candidate candidate) -> candidate.route().size())
            .thenComparingInt((Candidate candidate) -> candidate.cell().y())
            .thenComparingInt((Candidate candidate) -> candidate.cell().z())
            .thenComparingInt((Candidate candidate) -> candidate.cell().x()));
        Candidate best = candidates.getFirst();
        return new TargetPlan(best.cell(), best.route(), "reachable_pickup_cell");
    }

    static boolean withinPickupRange(VoxelCell cell, double targetX, double targetY, double targetZ) {
        double dx = (cell.x() + 0.5D) - targetX;
        double dz = (cell.z() + 0.5D) - targetZ;
        double horizontal = Math.hypot(dx, dz);
        return horizontal <= PICKUP_HORIZONTAL_RANGE && Math.abs(cell.y() - targetY) <= PICKUP_VERTICAL_RANGE;
    }

    private static double pickupDistanceSquared(VoxelCell cell, double targetX, double targetY, double targetZ) {
        double dx = (cell.x() + 0.5D) - targetX;
        double dy = cell.y() - targetY;
        double dz = (cell.z() + 0.5D) - targetZ;
        return dx * dx + dy * dy + dz * dz;
    }

    private record Candidate(VoxelCell cell, List<VoxelCell> route, double pickupDistanceSquared) {
    }
}
