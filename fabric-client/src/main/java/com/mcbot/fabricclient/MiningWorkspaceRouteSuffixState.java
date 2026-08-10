package com.mcbot.fabricclient;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

final class MiningWorkspaceRouteSuffixState {
    static final int MAX_REJECTED_SIGNATURES = 64;

    enum Admission {
        AVAILABLE,
        KNOWN_BROKEN,
        SATURATED,
        INVALID
    }

    record Signature(
        long trailRevision,
        MiningWorkspaceTraversalController.Mode mode,
        VoxelCell source,
        VoxelCell invalidWaypoint
    ) {
    }

    private final Set<Signature> rejected = new LinkedHashSet<>();
    private long sessionRevision = Long.MIN_VALUE;
    private long trailRevision = Long.MIN_VALUE;
    private String workspaceId = "";
    private boolean saturated;

    Admission admission(
        long nextSessionRevision,
        long nextTrailRevision,
        String nextWorkspaceId,
        MiningWorkspaceTraversalController.Mode mode,
        List<VoxelCell> route
    ) {
        synchronize(nextSessionRevision, nextTrailRevision, nextWorkspaceId);
        if (mode == null || mode == MiningWorkspaceTraversalController.Mode.NONE
            || route == null || route.size() < 2 || workspaceId.isBlank()) {
            return Admission.INVALID;
        }
        if (saturated) {
            return Admission.SATURATED;
        }
        for (int index = 1; index < route.size(); index++) {
            if (rejected.contains(signature(mode, route, index))) {
                return Admission.KNOWN_BROKEN;
            }
        }
        return Admission.AVAILABLE;
    }

    Signature signature(
        MiningWorkspaceTraversalController.Mode mode,
        List<VoxelCell> route,
        int invalidWaypointIndex
    ) {
        if (mode == null || mode == MiningWorkspaceTraversalController.Mode.NONE
            || route == null || invalidWaypointIndex <= 0 || invalidWaypointIndex >= route.size()) {
            return null;
        }
        return new Signature(
            trailRevision,
            mode,
            route.get(invalidWaypointIndex - 1),
            route.get(invalidWaypointIndex)
        );
    }

    boolean reject(Signature signature) {
        if (signature == null || signature.trailRevision() != trailRevision) {
            return false;
        }
        if (rejected.contains(signature)) {
            return true;
        }
        if (rejected.size() >= MAX_REJECTED_SIGNATURES) {
            saturated = true;
            return false;
        }
        rejected.add(signature);
        return true;
    }

    boolean contains(Signature signature) {
        return signature != null && rejected.contains(signature);
    }

    int retainedSignatureCount() {
        return rejected.size();
    }

    boolean saturated() {
        return saturated;
    }

    long trailRevision() {
        return trailRevision;
    }

    private void synchronize(
        long nextSessionRevision,
        long nextTrailRevision,
        String nextWorkspaceId
    ) {
        String id = nextWorkspaceId == null ? "" : nextWorkspaceId;
        if (sessionRevision == nextSessionRevision
            && trailRevision == nextTrailRevision
            && workspaceId.equals(id)) {
            return;
        }
        sessionRevision = nextSessionRevision;
        trailRevision = nextTrailRevision;
        workspaceId = id;
        rejected.clear();
        saturated = false;
    }
}
