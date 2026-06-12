package com.mcbot.fabricclient;

import java.util.LinkedHashMap;
import java.util.Map;

/** Search result plus bounded diagnostic counters for constructive 3-D voxel routes. */
record Nav3DBuildDiagnostic(
    ConstructiveVoxelAStar.BuildPlan plan,
    String failureReason,
    int expandedNodes,
    Map<String, Integer> rejectionCounts
) {
    Nav3DBuildDiagnostic {
        plan = plan == null ? ConstructiveVoxelAStar.BuildPlan.empty() : plan;
        failureReason = failureReason == null ? "" : failureReason;
        rejectionCounts = rejectionCounts == null ? Map.of() : Map.copyOf(new LinkedHashMap<>(rejectionCounts));
    }

    boolean routeFound() {
        return !plan.route().isEmpty();
    }

    int routeLength() {
        return plan.route().size();
    }

    int blocksUsed() {
        return plan.blocksUsed();
    }

    int rejectionCount(String reason) {
        return rejectionCounts.getOrDefault(reason, 0);
    }
}
