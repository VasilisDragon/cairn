package com.mcbot.fabricclient;

/** Pure compare-and-validate policy for a remote tool-restock round trip. */
final class IronToolReserveRestockIdentityPolicy {
    private IronToolReserveRestockIdentityPolicy() {
    }

    record Identity(
        Object worldIdentity,
        String dimensionId,
        long workspaceSessionRevision,
        int epoch,
        String planeId,
        String heading,
        int cumulativeBlocks,
        VoxelCell frontier
    ) {
        Identity {
            dimensionId = dimensionId == null ? "" : dimensionId;
            planeId = planeId == null ? "none" : planeId;
            heading = heading == null ? "none" : heading;
        }
    }

    static String validate(Identity frozen, Identity live, boolean requireFrontierResume) {
        if (frozen == null || live == null || frozen.worldIdentity() != live.worldIdentity()) {
            return "world_changed";
        }
        if (!frozen.dimensionId().equals(live.dimensionId())) {
            return "dimension_changed";
        }
        if (frozen.workspaceSessionRevision() != live.workspaceSessionRevision()) {
            return "workspace_session_changed";
        }
        if (frozen.epoch() != live.epoch()) {
            return "epoch_changed";
        }
        if (!frozen.planeId().equals(live.planeId())) {
            return "plane_changed";
        }
        if (!frozen.heading().equals(live.heading())) {
            return "heading_changed";
        }
        if (frozen.cumulativeBlocks() != live.cumulativeBlocks()) {
            return "block_budget_changed";
        }
        if (requireFrontierResume
            && (frozen.frontier() == null || !frozen.frontier().equals(live.frontier()))) {
            return "frontier_not_restored";
        }
        return null;
    }
}
