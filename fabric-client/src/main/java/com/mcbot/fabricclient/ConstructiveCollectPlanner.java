package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Chooses a constructively reachable 3-D pickup cell for a dropped item. */
final class ConstructiveCollectPlanner {
    private ConstructiveCollectPlanner() {
    }

    record TargetPlan(VoxelCell cell, ConstructiveVoxelAStar.BuildPlan buildPlan, String reason) {
        TargetPlan {
            buildPlan = buildPlan == null ? ConstructiveVoxelAStar.BuildPlan.empty() : buildPlan;
            reason = reason == null ? "" : reason;
        }

        List<VoxelCell> route() {
            return buildPlan.route();
        }

        int blocksUsed() {
            return buildPlan.blocksUsed();
        }
    }

    static TargetPlan chooseTarget(
        VoxelPerception perception,
        VoxelCell start,
        double targetX,
        double targetY,
        double targetZ,
        AgentBuildCapability capability
    ) {
        if (perception == null || start == null || capability == null
            || !Double.isFinite(targetX) || !Double.isFinite(targetY) || !Double.isFinite(targetZ)) {
            return new TargetPlan(null, ConstructiveVoxelAStar.BuildPlan.empty(), "invalid_request");
        }
        List<Candidate> candidates = new ArrayList<>();
        for (int x = perception.minX(); x <= perception.maxX(); x++) {
            for (int y = perception.minY(); y <= perception.maxY(); y++) {
                for (int z = perception.minZ(); z <= perception.maxZ(); z++) {
                    VoxelCell cell = new VoxelCell(x, y, z);
                    if (!CollectTarget3DPlanner.withinPickupRange(cell, targetX, targetY, targetZ)) {
                        continue;
                    }
                    Nav3DBuildDiagnostic diagnostic = ConstructiveVoxelAStar.diagnose(perception, start, cell, capability);
                    if (diagnostic.routeFound()) {
                        candidates.add(new Candidate(
                            cell,
                            diagnostic.plan(),
                            pickupDistanceSquared(cell, targetX, targetY, targetZ)
                        ));
                    }
                }
            }
        }
        if (candidates.isEmpty()) {
            return new TargetPlan(null, ConstructiveVoxelAStar.BuildPlan.empty(), "no_constructive_path");
        }
        candidates.sort(Comparator
            .comparingInt((Candidate candidate) -> candidate.plan().totalCost())
            .thenComparingInt((Candidate candidate) -> candidate.plan().blocksUsed())
            .thenComparingDouble(Candidate::pickupDistanceSquared)
            .thenComparingInt((Candidate candidate) -> candidate.cell().y())
            .thenComparingInt((Candidate candidate) -> candidate.cell().z())
            .thenComparingInt((Candidate candidate) -> candidate.cell().x()));
        Candidate best = candidates.getFirst();
        return new TargetPlan(best.cell(), best.plan(), "reachable_pickup_cell");
    }

    private static double pickupDistanceSquared(VoxelCell cell, double targetX, double targetY, double targetZ) {
        double dx = (cell.x() + 0.5D) - targetX;
        double dy = cell.y() - targetY;
        double dz = (cell.z() + 0.5D) - targetZ;
        return dx * dx + dy * dy + dz * dz;
    }

    private record Candidate(VoxelCell cell, ConstructiveVoxelAStar.BuildPlan plan, double pickupDistanceSquared) {
    }
}
